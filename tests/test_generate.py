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


def test_parser_artifact_root_accepts_comma_separated_string():
    args = build_parser().parse_args(["--out", "site/data", "--model", "transformer",
                                      "--season", "2023", "--week", "7",
                                      "--artifact-root", "root_a,root_b"])
    assert args.artifact_root == "root_a,root_b"


def test_make_predictor_transformer_single_root_matches_single_member():
    """A bare (no-comma) --artifact-root must still produce a predictor
    equivalent to the pre-ensemble single-root call (site currently deploys
    a single artifact root in production -- see the notebook's promotion
    notes -- so this is the path GitHub Actions actually exercises)."""
    from argparse import Namespace

    from ffmodel.site.generate import _make_predictor

    args = Namespace(model="transformer", artifact_root="models/transformer/v1")
    predictor = _make_predictor(args, pd.DataFrame())
    assert [str(r) for r in predictor.artifact_roots] == [str(Path("models/transformer/v1"))]


def test_make_predictor_transformer_comma_separated_builds_ensemble():
    from argparse import Namespace

    from ffmodel.site.generate import _make_predictor

    args = Namespace(model="transformer",
                     artifact_root="models/transformer/v1_s43, models/transformer/v1_s44")
    predictor = _make_predictor(args, pd.DataFrame())
    assert [str(r) for r in predictor.artifact_roots] == [
        str(Path("models/transformer/v1_s43")), str(Path("models/transformer/v1_s44")),
    ]


def test_make_predictor_transformer_requires_artifact_root():
    from argparse import Namespace

    from ffmodel.site.generate import _make_predictor

    args = Namespace(model="transformer", artifact_root=None)
    with pytest.raises(SystemExit):
        _make_predictor(args, pd.DataFrame())


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


def _run_generate_with_stubs(monkeypatch, tmp_path, argv, capture: dict):
    """Run generate.main() end-to-end with data pulls, predictor, and payload
    builders stubbed. Records the sleeper_players kwarg build_draft_board saw."""
    import sys

    import ffmodel.data.features as features_mod
    import ffmodel.data.pull as pull_mod
    import ffmodel.site.about as about_mod
    import ffmodel.site.draft as draft_mod
    import ffmodel.site.generate as gen_mod

    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in range(1, 7) for i in range(40)])
    sched = make_schedules(6)
    # make_schedules() (tests/test_features.py) doesn't carry home_score/
    # away_score -- _season_has_completed_game requires them. Extend the
    # local frame here rather than the shared fixture (per task brief note).
    sched = sched.assign(home_score=float("nan"), away_score=float("nan"))
    monkeypatch.setattr(pull_mod, "pull_weekly", lambda *a, **k: weekly)
    monkeypatch.setattr(pull_mod, "pull_schedules", lambda *a, **k: sched)
    monkeypatch.setattr(features_mod, "build_features", lambda *a, **k: weekly)

    class _Stub:
        name = "stub"
        def fit(self, train): pass
    monkeypatch.setattr(gen_mod, "_make_predictor", lambda args, feats: _Stub())

    def fake_board(*a, **k):
        capture["sleeper_players"] = k.get("sleeper_players")
        return {"players": []}
    monkeypatch.setattr(draft_mod, "build_draft_board", fake_board)
    monkeypatch.setattr(about_mod, "build_about",
                        lambda *a, **k: {"site_model": "stub"})
    monkeypatch.setattr(gen_mod, "require_backtests", lambda paths: paths)

    monkeypatch.setattr(sys, "argv", ["gen", "--out", str(tmp_path / "out"),
                                      "--model", "xgboost", "--season", "2023",
                                      *argv])
    gen_mod.main()


def test_draft_run_threads_sleeper_dump_into_board(monkeypatch, tmp_path):
    import ffmodel.site.sleeper as sleeper_mod

    dump = {"1": {"gsis_id": "00-0000001", "full_name": "A B", "position": "QB"}}
    monkeypatch.setattr(sleeper_mod, "pull_sleeper_players", lambda **k: dump)
    capture = {}
    _run_generate_with_stubs(monkeypatch, tmp_path, ["--draft"], capture)
    assert capture["sleeper_players"] is dump
    assert (tmp_path / "out" / "draft.json").exists()


def test_weekly_only_run_never_touches_sleeper(monkeypatch, tmp_path):
    import ffmodel.site.sleeper as sleeper_mod

    def boom(**k):
        raise AssertionError("weekly-only run must not fetch Sleeper")
    monkeypatch.setattr(sleeper_mod, "pull_sleeper_players", boom)
    import ffmodel.data.future as future_mod
    import ffmodel.site.weekly as weekly_mod
    monkeypatch.setattr(future_mod, "combined_future_features",
                        lambda *a, **k: (None, None))
    monkeypatch.setattr(weekly_mod, "build_weekly_projections",
                        lambda *a, **k: {"players": []})
    capture = {}
    _run_generate_with_stubs(monkeypatch, tmp_path, ["--week", "6"], capture)
    assert (tmp_path / "out" / "weekly.json").exists()


def test_draft_run_aborts_before_writing_when_sleeper_pull_fails(monkeypatch, tmp_path):
    import ffmodel.site.sleeper as sleeper_mod

    def fail(**k):
        raise RuntimeError("sleeper is down")
    monkeypatch.setattr(sleeper_mod, "pull_sleeper_players", fail)
    capture = {}
    with pytest.raises(RuntimeError, match="sleeper is down"):
        _run_generate_with_stubs(monkeypatch, tmp_path, ["--draft"], capture)
    out = tmp_path / "out"
    assert not (out / "draft.json").exists()
    assert not (out / "about.json").exists()   # fail-safe: NOTHING was written
