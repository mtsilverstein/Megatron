import json

import pandas as pd
import pytest

from ffmodel.site.roles import build_roles


def inputs():
    rows = []
    for week in range(1, 5):
        for pid, team, carries in [("a", "X", 4 if week < 4 else 12), ("b", "X", 16 if week < 4 else 8)]:
            rows.append(dict(player_id=pid, player_display_name=pid, position="RB", team=team,
                             season=2026, week=week, targets=2 if week < 4 else 7,
                             carries=carries, target_share=.1 if week < 4 else .3,
                             snap_pct=.3 if week < 4 else .7))
    games = pd.DataFrame([dict(season=2026, week=w, game_type="REG", home_team="X", away_team="Y", home_score=20, away_score=10) for w in range(1, 5)])
    return pd.DataFrame(rows), games


def test_growth_uses_observed_same_team_games():
    w, s = inputs()
    out = build_roles(w, s, 2026, 5)
    a = out["players"][0]
    assert a["baseline_weeks"] == [1, 2, 3]
    assert a["delta"]["snap_pct"] == .4
    assert a["latest"]["carry_share"] == .6
    assert len(a["flags"]) == 3
    json.dumps(out, allow_nan=False)


def test_no_preseason_or_future_leakage():
    w, s = inputs()
    assert build_roles(w, s, 2026, 1)["status"] == "awaiting_observations"
    out = build_roles(w, s, 2026, 2)
    assert out["through_week"] == 1
    assert out["players"][0]["comparison_ready"] is False
    assert all(v is None for v in out["players"][0]["delta"].values())
    assert build_roles(w, s, 2027, 5)["players"] == []


def test_missing_game_trade_or_stale_player_suppresses_growth():
    w, s = inputs()
    missing = w[~((w.player_id == "a") & (w.week == 2))]
    assert not build_roles(missing, s, 2026, 5)["players"][0]["comparison_ready"]
    traded = w.copy()
    traded.loc[(traded.player_id == "a") & (traded.week < 4), "team"] = "Y"
    assert not build_roles(traded, s, 2026, 5)["players"][0]["comparison_ready"]
    stale = w[~((w.player_id == "a") & (w.week == 4))]
    a = build_roles(stale, s, 2026, 5)["players"][0]
    assert not a["current_for_team"] and not a["flags"]


def test_missing_snaps_not_zero_and_incomplete_games_excluded():
    w, s = inputs()
    w.loc[w.week == 4, "snap_pct"] = float("nan")
    a = build_roles(w, s, 2026, 5)["players"][0]
    assert a["latest"]["snap_pct"] is None and a["delta"]["snap_pct"] is None
    s.loc[s.week == 4, "home_score"] = float("nan")
    assert build_roles(w, s, 2026, 5)["through_week"] == 3
    with pytest.raises(ValueError, match="duplicate"):
        build_roles(pd.concat([w, w.iloc[:1]]), s, 2026, 5)


def test_source_gap_and_nonfinite_counts_are_not_observed_zero():
    w, s = inputs()
    assert build_roles(w.iloc[:0], s, 2026, 5)["status"] == "source_gap"
    w["targets"] = w.targets.astype(float)
    w.loc[(w.player_id == "a") & (w.week == 4), "targets"] = float("inf")
    out = build_roles(w, s, 2026, 5)
    assert out["players"][0]["latest"]["targets"] is None
    assert "6+ targets in latest observed game" not in out["players"][0]["flags"]
    json.dumps(out, allow_nan=False)
