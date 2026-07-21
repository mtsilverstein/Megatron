import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.scoring import PREDICTED_STATS


def _weekly(rows):
    base = {s: 0.0 for s in PREDICTED_STATS}
    base["fantasy_points_ppr"] = 0.0
    return pd.DataFrame([{**base, "player_id": "x", "season": 2020, "week": 1,
                          **r} for r in rows])


def _picks(rows):
    base = {"season": 2020, "round": 1, "pick": 1, "team": "KC",
            "gsis_id": "00-0", "player_name": "P", "position": "RB",
            "age": 22.0, "college": "State"}
    return pd.DataFrame([{**base, **r} for r in rows])


def _toy_world():
    """Two history classes (2020, 2021) where early picks produce and late
    picks don't, plus a 2022 class to project."""
    picks, weekly = [], []
    pid = 0
    for season in (2020, 2021, 2022):
        for i in range(30):          # early picks: productive rookies
            pid += 1
            picks.append({"season": season, "round": 1, "pick": (i % 12) + 1,
                          "gsis_id": f"00-{pid:04d}", "player_name": f"E{pid}"})
            if season < 2022:
                for w in range(1, 15):
                    weekly.append({"player_id": f"00-{pid:04d}", "season": season,
                                   "week": w, "rushing_yards": 80.0,
                                   "fantasy_points_ppr": 8.0})
        for i in range(30):          # day-3 picks: mostly nothing
            pid += 1
            picks.append({"season": season, "round": 6, "pick": 180 + i,
                          "gsis_id": f"00-{pid:04d}", "player_name": f"L{pid}"})
    return _weekly(weekly), _picks(picks)


def test_project_class_walk_forward_and_ordering():
    from ffmodel.eval.rookies import project_class

    weekly, picks = _toy_world()
    rows = project_class(weekly, picks, 2022, n_draws=500, seed=0)
    assert len(rows) == 60
    early = [r for r in rows if r["round"] == 1]
    late = [r for r in rows if r["round"] == 6]
    # capital signal must separate the cohorts in the projection
    assert min(r["p50"] for r in early) > max(r["p50"] for r in late)
    for r in rows:
        assert r["p10"] <= r["p50"] <= r["p90"]


def test_report_schema_and_gate(tmp_path, monkeypatch):
    import sys

    import ffmodel.eval.rookies as rk_mod

    weekly, picks = _toy_world()
    monkeypatch.setattr(rk_mod, "pull_weekly", lambda *a, **k: weekly)
    monkeypatch.setattr(rk_mod, "pull_draft_picks", lambda *a, **k: picks)
    out = tmp_path / "rookie_backtest.json"
    monkeypatch.setattr(sys, "argv", ["rookies", "--classes", "2022",
                                      "--out", str(out)])
    rk_mod.main()
    report = json.loads(out.read_text())
    assert report["classes"] == [2022]
    g = report["gate1"]
    assert set(g) >= {"bucketed_spearman", "position_only_spearman", "passed"}
    # toy world has genuine capital signal -> bucketed must win
    assert g["passed"] is True
    assert "coverage_p10_p90" in report and "per_class" in report
    json.dumps(report)


def test_actuals_include_zero_for_never_played(tmp_path):
    from ffmodel.eval.rookies import actual_rookie_points

    weekly, picks = _toy_world()
    cls = picks[picks["season"] == 2022]
    actuals = actual_rookie_points(weekly, cls, 2022)
    assert len(actuals) == 60
    assert (actuals == 0.0).all()   # toy 2022 class has no weekly rows
