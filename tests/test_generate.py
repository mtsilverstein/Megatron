import json
from pathlib import Path

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
