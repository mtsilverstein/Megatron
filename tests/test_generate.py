import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ffmodel.site.generate import _atomic_write, build_parser, validate_inputs

from tests.test_features import make_schedules, make_weekly


def test_parser_defaults_and_flags():
    args = build_parser().parse_args(["--out", "site/data", "--model", "xgboost",
                                      "--season", "2023", "--week", "7"])
    assert args.model == "xgboost" and args.week == "7" and not args.draft


def test_validate_rejects_empty_and_sparse():
    sched = make_schedules(6)
    with pytest.raises(RuntimeError, match="empty"):
        validate_inputs(make_weekly([]).iloc[0:0], sched, season=2023)
    sparse = make_weekly([{"week": 1}])
    with pytest.raises(RuntimeError, match="rows"):
        validate_inputs(sparse, sched, season=2023)


def test_validate_requires_schedule_coverage():
    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in range(1, 7) for i in range(40)])
    with pytest.raises(RuntimeError, match="schedule"):
        validate_inputs(weekly, make_schedules(6, season=2022), season=2023)


def test_atomic_write_never_leaves_partial(tmp_path):
    target = tmp_path / "weekly.json"
    target.write_text('{"old": true}')

    class Boom:
        def __iter__(self):  # break json serialization mid-flight
            raise RuntimeError("boom")

    with pytest.raises(TypeError):
        _atomic_write(target, {"players": Boom()})
    assert json.loads(target.read_text()) == {"old": True}   # untouched
    assert not list(tmp_path.glob("*.tmp"))                  # tmp cleaned up


def test_atomic_write_happy_path(tmp_path):
    target = tmp_path / "draft.json"
    _atomic_write(target, {"ok": 1})
    assert json.loads(target.read_text()) == {"ok": 1}


def test_require_backtests_rejects_empty():
    from ffmodel.site.generate import require_backtests

    with pytest.raises(RuntimeError, match="empty about page"):
        require_backtests([])
    assert require_backtests([Path("x.json")]) == [Path("x.json")]


def test_parser_requires_week_or_draft():
    from ffmodel.site.generate import parse_and_validate

    with pytest.raises(SystemExit):
        parse_and_validate(["--out", "x", "--model", "xgboost",
                            "--season", "2026"])


def test_week_auto_resolves_first_unplayed():
    from ffmodel.site.generate import resolve_week

    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in (1, 2) for i in range(3)])
    sched = make_schedules(4)
    assert resolve_week("auto", weekly, sched, season=2023) == 3
    assert resolve_week(4, weekly, sched, season=2023) == 4


def test_week_auto_errors_when_season_complete():
    from ffmodel.site.generate import resolve_week

    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in (1, 2, 3, 4) for i in range(3)])
    sched = make_schedules(4)
    with pytest.raises(RuntimeError, match="2023"):
        resolve_week("auto", weekly, sched, season=2023)


def _sched_with_scores(weeks=4, season=2026, completed_rows=None):
    """make_schedules() plus home_score/away_score columns (all-NaN unless
    `completed_rows` gives {row_index: (home_score, away_score)})."""
    sched = make_schedules(weeks, season=season)
    sched["home_score"] = np.nan
    sched["away_score"] = np.nan
    for idx, (home, away) in (completed_rows or {}).items():
        sched.loc[idx, "home_score"] = home
        sched.loc[idx, "away_score"] = away
    return sched


def test_season_has_completed_game_false_when_all_scores_missing():
    from ffmodel.site.generate import _season_has_completed_game

    sched = _sched_with_scores()
    assert _season_has_completed_game(sched, 2026) is False


def test_season_has_completed_game_true_when_any_score_present():
    from ffmodel.site.generate import _season_has_completed_game

    sched = _sched_with_scores(completed_rows={0: (24.0, 17.0)})
    assert _season_has_completed_game(sched, 2026) is True


def test_season_has_completed_game_ignores_other_seasons():
    from ffmodel.site.generate import _season_has_completed_game

    sched = _sched_with_scores(season=2025, completed_rows={0: (24.0, 17.0)})
    assert _season_has_completed_game(sched, 2026) is False


def test_season_has_completed_game_missing_columns_raises():
    """Belt-and-suspenders guard: a schedules frame that somehow lacks the
    score columns (e.g. an old cache slipping through) must not be silently
    treated as 'zero completed games' -- that would be an unsafe guess."""
    from ffmodel.site.generate import _season_has_completed_game

    sched = make_schedules(4, season=2026)  # no score columns
    with pytest.raises(RuntimeError, match="home_score"):
        _season_has_completed_game(sched, 2026)


def test_extend_with_target_season_tolerates_pre_week1_404(monkeypatch):
    """(a) target-season pull raises + zero completed games -> proceed with
    prior-season data only; resolve_week('auto', ...) then lands on the
    first scheduled week."""
    from ffmodel.site.generate import _extend_with_target_season, resolve_week

    def boom(seasons, cache_dir=None):
        raise RuntimeError("404: player_stats file not found for 2026")

    monkeypatch.setattr("ffmodel.data.pull.pull_weekly", boom)

    prior = make_weekly([{"season": 2025, "week": w, "player_id": f"p{i}"}
                         for w in range(1, 5) for i in range(3)])
    sched = _sched_with_scores()  # 2026, zero completed games

    out = _extend_with_target_season(prior, sched, season=2026, data_dir=None)

    pd.testing.assert_frame_equal(out, prior)
    assert resolve_week("auto", out, sched, season=2026) == 1


def test_extend_with_target_season_reraises_when_games_completed(monkeypatch):
    """(b) target-season pull raises + at least one completed game -> the
    original failure propagates (fail-safe, mid-season breakage must abort)."""
    from ffmodel.site.generate import _extend_with_target_season

    def boom(seasons, cache_dir=None):
        raise RuntimeError("upstream broke mid-season")

    monkeypatch.setattr("ffmodel.data.pull.pull_weekly", boom)

    prior = make_weekly([{"season": 2025, "week": 1, "player_id": "p1"}])
    sched = _sched_with_scores(completed_rows={0: (24.0, 17.0)})

    with pytest.raises(RuntimeError, match="2026") as excinfo:
        _extend_with_target_season(prior, sched, season=2026, data_dir=None)
    assert "upstream broke mid-season" in str(excinfo.value.__cause__)


def test_extend_with_target_season_concats_on_success(monkeypatch):
    """When the pull succeeds, behavior is unchanged: current season rows
    are appended to `weekly`."""
    from ffmodel.site.generate import _extend_with_target_season

    current = make_weekly([{"season": 2026, "week": 1, "player_id": "p9"}])

    def fake(seasons, cache_dir=None):
        assert seasons == [2026]
        return current

    monkeypatch.setattr("ffmodel.data.pull.pull_weekly", fake)

    prior = make_weekly([{"season": 2025, "week": 1, "player_id": "p1"}])
    sched = _sched_with_scores()

    out = _extend_with_target_season(prior, sched, season=2026, data_dir=None)
    assert len(out) == 2
    assert set(out["season"]) == {2025, 2026}
