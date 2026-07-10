import numpy as np
import pandas as pd
import pytest

from ffmodel.data.features import build_features, feature_columns
from ffmodel.scoring import PREDICTED_STATS


def make_weekly(rows: list[dict]) -> pd.DataFrame:
    """Synthetic canonical weekly frame; unspecified stats are zero."""
    base = {
        "player_id": "p1", "player_display_name": "P One", "position": "WR",
        "team": "AAA", "opponent_team": "BBB", "season": 2023, "week": 1,
        "target_share": np.nan, "fantasy_points_ppr": 0.0,
        "two_point_conversions": 0, "special_teams_tds": 0,
        **{s: 0.0 for s in PREDICTED_STATS},
    }
    return pd.DataFrame([{**base, **r} for r in rows])


def make_schedules(weeks: int = 6, season: int = 2023) -> pd.DataFrame:
    days = pd.date_range(f"{season}-09-10", periods=weeks, freq="7D")
    return pd.DataFrame({
        "season": season, "week": range(1, weeks + 1),
        "gameday": days.strftime("%Y-%m-%d"),
        "home_team": "AAA", "away_team": "BBB",
    })


def test_lag_features_use_only_prior_weeks():
    weekly = make_weekly([
        {"week": 1, "receiving_yards": 100.0},
        {"week": 2, "receiving_yards": 50.0},
        {"week": 3, "receiving_yards": 80.0},
    ])
    out = build_features(weekly, make_schedules())
    wk3 = out[out["week"] == 3].iloc[0]
    assert wk3["lag4_receiving_yards"] == pytest.approx(75.0)  # mean(100, 50)
    assert wk3["receiving_yards"] == pytest.approx(80.0)       # label untouched


def test_first_game_has_nan_lags_and_zero_games_prior():
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    row = out.iloc[0]
    assert np.isnan(row["lag4_receiving_yards"])
    assert row["games_prior"] == 0


def test_lags_span_season_boundaries():
    weekly = make_weekly([
        {"season": 2022, "week": 18, "receiving_yards": 60.0},
        {"season": 2023, "week": 1, "receiving_yards": 0.0},
    ])
    sched = pd.concat([make_schedules(18, 2022), make_schedules(6, 2023)])
    out = build_features(weekly, sched)
    wk1_2023 = out[(out["season"] == 2023) & (out["week"] == 1)].iloc[0]
    assert wk1_2023["lag4_receiving_yards"] == pytest.approx(60.0)


def test_carry_share():
    weekly = make_weekly([
        {"player_id": "p1", "carries": 15.0},
        {"player_id": "p2", "carries": 5.0},
    ])
    out = build_features(weekly, make_schedules())
    assert out[out["player_id"] == "p1"]["carry_share"].iloc[0] == pytest.approx(0.75)


def test_home_and_rest_days():
    weekly = make_weekly([{"week": 1}, {"week": 2}])
    out = build_features(weekly, make_schedules())
    assert out[out["week"] == 1]["is_home"].iloc[0] == 1     # AAA hosts every game
    assert out[out["week"] == 1]["rest_days"].iloc[0] == 7   # unknown -> default 7
    assert out[out["week"] == 2]["rest_days"].iloc[0] == 7   # 7-day gap


def test_feature_columns_never_include_same_week_stats():
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    cols = feature_columns(out)
    assert not set(cols) & set(PREDICTED_STATS)
    assert "ppr_points" not in cols
    assert "fantasy_points_ppr" not in cols


def test_opponent_allowed_uses_only_prior_weeks():
    # Two WRs face defense BBB in weeks 1-3; BBB allowed 10 then 30 PPR pts.
    weekly = make_weekly([
        {"player_id": "p1", "week": 1, "receiving_yards": 100.0},  # 10 pts
        {"player_id": "p1", "week": 2, "receiving_yards": 300.0},  # 30 pts
        {"player_id": "p1", "week": 3, "receiving_yards": 0.0},
    ])
    out = build_features(weekly, make_schedules())
    wk2 = out[out["week"] == 2].iloc[0]
    wk3 = out[out["week"] == 3].iloc[0]
    assert wk2["opp_allowed_last4"] == pytest.approx(10.0)
    assert wk3["opp_allowed_last4"] == pytest.approx(20.0)   # mean(10, 30)
    assert wk3["opp_allowed_season"] == pytest.approx(20.0)


def test_opponent_allowed_is_position_specific():
    weekly = make_weekly([
        {"player_id": "wr", "position": "WR", "week": 1, "receiving_yards": 100.0},
        {"player_id": "rb", "position": "RB", "week": 1, "rushing_yards": 200.0},
        {"player_id": "wr", "position": "WR", "week": 2},
    ])
    out = build_features(weekly, make_schedules())
    wk2 = out[(out["week"] == 2) & (out["player_id"] == "wr")].iloc[0]
    assert wk2["opp_allowed_last4"] == pytest.approx(10.0)   # WR pts only, not RB's 20


def test_opponent_allowed_nan_when_no_history():
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    assert np.isnan(out["opp_allowed_last4"].iloc[0])


def test_lag_target_share_nan_stays_nan():
    weekly = make_weekly([{"week": 1}, {"week": 2}])  # target_share NaN in base fixture
    out = build_features(weekly, make_schedules())
    assert np.isnan(out[out["week"] == 2]["lag4_target_share"].iloc[0])


def test_rest_days_clip_bounds():
    weekly = make_weekly([{"week": 1}, {"week": 2}, {"week": 3}])
    sched = make_schedules(3)
    sched.loc[sched["week"] == 2, "gameday"] = "2023-09-14"  # 4-day gap wk1->wk2
    sched.loc[sched["week"] == 3, "gameday"] = "2023-11-01"  # 48-day gap wk2->wk3
    out = build_features(weekly, sched)
    assert out[out["week"] == 2]["rest_days"].iloc[0] == 4    # floor
    assert out[out["week"] == 3]["rest_days"].iloc[0] == 14   # ceiling


def test_position_dummies_all_positions():
    rows = [{"player_id": p, "position": pos}
            for p, pos in [("a", "QB"), ("b", "RB"), ("c", "WR"), ("d", "TE")]]
    out = build_features(make_weekly(rows), make_schedules())
    for pos in ("QB", "RB", "WR", "TE"):
        sub = out[out["position"] == pos]
        assert sub[f"pos_{pos}"].iloc[0] == 1
        assert sub[[c for c in ("pos_QB", "pos_RB", "pos_WR", "pos_TE")
                    if c != f"pos_{pos}"]].iloc[0].sum() == 0


def test_opp_allowed_spans_season_boundary():
    weekly = make_weekly([
        {"season": 2022, "week": 18, "receiving_yards": 100.0},
        {"season": 2023, "week": 1},
    ])
    sched = pd.concat([make_schedules(18, 2022), make_schedules(6, 2023)])
    out = build_features(weekly, sched)
    wk1 = out[(out["season"] == 2023) & (out["week"] == 1)].iloc[0]
    assert wk1["opp_allowed_last4"] == pytest.approx(10.0)   # crosses the boundary
    assert np.isnan(wk1["opp_allowed_season"])               # season-to-date resets
