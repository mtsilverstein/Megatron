import numpy as np
import pandas as pd
import pytest

from ffmodel.data.features import (
    BASELINE_FEATURE_SETS,
    DEFAULT_BASELINE_FEATURE_SET,
    V2_FEATURE_COLUMNS,
    build_features,
    feature_columns,
)
from ffmodel.scoring import PREDICTED_STATS

# The frozen v1 tabular feature set, in order. Every committed baseline
# report (models/backtests/*.json) was generated from exactly this list, so
# it is pinned literally rather than derived: a new column added to
# build_features must NOT silently join the baseline's inputs and move the
# published comparison. If this test fails, either put the new column in a
# new feature set or change the record deliberately -- see
# models/diagnostics/xgb_feature_set_audit.json.
V1_FEATURE_COLUMNS = [
    "lag4_passing_yards", "lag8_passing_yards",
    "lag4_passing_tds", "lag8_passing_tds",
    "lag4_passing_interceptions", "lag8_passing_interceptions",
    "lag4_carries", "lag8_carries",
    "lag4_rushing_yards", "lag8_rushing_yards",
    "lag4_rushing_tds", "lag8_rushing_tds",
    "lag4_targets", "lag8_targets",
    "lag4_receptions", "lag8_receptions",
    "lag4_receiving_yards", "lag8_receiving_yards",
    "lag4_receiving_tds", "lag8_receiving_tds",
    "lag4_fumbles_lost", "lag8_fumbles_lost",
    "lag4_target_share", "lag8_target_share",
    "lag4_carry_share", "lag8_carry_share",
    "lag4_ppr_points", "lag8_ppr_points",
    "lag4_snap_pct", "lag8_snap_pct",
    "games_prior", "is_home", "rest_days", "week",
    "opp_allowed_last4", "opp_allowed_season",
    "pos_QB", "pos_RB", "pos_WR", "pos_TE",
]


def make_weekly(rows: list[dict]) -> pd.DataFrame:
    """Synthetic canonical weekly frame; unspecified stats are zero."""
    base = {
        "player_id": "p1", "player_display_name": "P One", "position": "WR",
        "team": "AAA", "opponent_team": "BBB", "season": 2023, "week": 1,
        "target_share": np.nan, "snap_pct": np.nan, "fantasy_points_ppr": 0.0,
        "two_point_conversions": 0, "special_teams_tds": 0,
        "attempts": 0.0, "receiving_air_yards": 0.0, "passing_air_yards": 0.0,
        **{s: 0.0 for s in PREDICTED_STATS},
    }
    return pd.DataFrame([{**base, **r} for r in rows])


def make_schedules(weeks: int = 6, season: int = 2023,
                   roof: str | None = None) -> pd.DataFrame:
    days = pd.date_range(f"{season}-09-10", periods=weeks, freq="7D")
    sched = pd.DataFrame({
        "season": season, "week": range(1, weeks + 1),
        "gameday": days.strftime("%Y-%m-%d"),
        "home_team": "AAA", "away_team": "BBB",
    })
    if roof is not None:
        sched["roof"] = roof
    return sched


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
    for feature_set in sorted(BASELINE_FEATURE_SETS):
        cols = feature_columns(out, feature_set)
        assert not set(cols) & set(PREDICTED_STATS), feature_set
        assert "ppr_points" not in cols, feature_set
        assert "fantasy_points_ppr" not in cols, feature_set
        assert not {"air_share", "attempts", "receiving_air_yards",
                    "passing_air_yards"} & set(cols), feature_set
    assert {"team_pass_att_last4", "is_indoor"} <= set(feature_columns(out, "v2"))


def test_feature_columns_default_is_frozen_v1():
    """The default is the set every committed baseline report used. Pinned
    literally so a new build_features column cannot silently join it."""
    assert DEFAULT_BASELINE_FEATURE_SET == "v1"
    out = build_features(make_weekly([{"week": 1}, {"week": 2}]), make_schedules())
    assert feature_columns(out) == V1_FEATURE_COLUMNS
    assert feature_columns(out, "v1") == V1_FEATURE_COLUMNS


def test_feature_columns_v2_adds_exactly_the_v2_pack_and_nothing_else():
    weekly = make_weekly([{"week": 1, "receiving_air_yards": 10.0, "attempts": 20.0},
                          {"week": 2, "receiving_air_yards": 5.0, "attempts": 30.0}])
    out = build_features(weekly, make_schedules(roof="dome"))
    v1, v2 = feature_columns(out, "v1"), feature_columns(out, "v2")
    assert set(v2) - set(v1) == set(V2_FEATURE_COLUMNS)
    assert set(v1) - set(v2) == set()
    assert len(set(v2)) == len(v2)  # no duplicates


def test_v1_columns_identical_with_and_without_v2_source_columns():
    """The regression this pins: adding the v2 source columns to the weekly
    frame must not change the v1 baseline's inputs -- same names AND same
    order (XGBoost's colsample_bytree makes column order part of the fit)."""
    rows = [{"week": 1, "receiving_air_yards": 10.0, "attempts": 20.0},
            {"week": 2, "receiving_air_yards": 5.0, "attempts": 30.0}]
    with_v2 = build_features(make_weekly(rows), make_schedules(roof="dome"))
    without_v2 = build_features(
        make_weekly(rows).drop(columns=["attempts", "receiving_air_yards",
                                        "passing_air_yards"]),
        make_schedules(roof="dome"),
    )
    assert feature_columns(with_v2) == feature_columns(without_v2)
    assert "lag4_air_share" in with_v2.columns      # the column exists...
    assert "lag4_air_share" not in feature_columns(with_v2)   # ...but is not fed


def test_feature_columns_rejects_unknown_feature_set():
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    with pytest.raises(ValueError, match="unknown feature_set"):
        feature_columns(out, "v3")


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


def test_air_share_is_share_of_team_air_yards():
    weekly = make_weekly([
        {"player_id": "p1", "receiving_air_yards": 75.0},
        {"player_id": "p2", "receiving_air_yards": 25.0},
    ])
    out = build_features(weekly, make_schedules())
    assert out[out["player_id"] == "p1"]["air_share"].iloc[0] == pytest.approx(0.75)
    assert out[out["player_id"] == "p2"]["air_share"].iloc[0] == pytest.approx(0.25)


def test_air_share_zero_team_air_yards_is_nan():
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    assert np.isnan(out["air_share"].iloc[0])


def test_air_share_lagged_not_same_week_in_feature_columns():
    weekly = make_weekly([
        {"week": 1, "receiving_air_yards": 80.0},
        {"week": 2, "receiving_air_yards": 20.0},
    ])
    out = build_features(weekly, make_schedules())
    cols = feature_columns(out, "v2")
    assert "lag4_air_share" in cols and "lag8_air_share" in cols
    assert "air_share" not in cols
    wk2 = out[out["week"] == 2].iloc[0]
    assert wk2["lag4_air_share"] == pytest.approx(1.0)  # sole receiver week 1


def test_team_pass_volume_uses_only_prior_weeks():
    weekly = make_weekly([
        {"player_id": "qb", "position": "QB", "week": 1, "attempts": 30.0},
        {"player_id": "qb", "position": "QB", "week": 2, "attempts": 40.0},
        {"player_id": "qb", "position": "QB", "week": 3, "attempts": 99.0},
    ])
    out = build_features(weekly, make_schedules())
    assert np.isnan(out[out["week"] == 1]["team_pass_att_last4"].iloc[0])
    assert out[out["week"] == 2]["team_pass_att_last4"].iloc[0] == pytest.approx(30.0)
    # the current week's 99 must not leak into week 3's own feature value
    assert out[out["week"] == 3]["team_pass_att_last4"].iloc[0] == pytest.approx(35.0)


def test_team_pass_volume_sums_across_team_players():
    weekly = make_weekly([
        {"player_id": "qb1", "position": "QB", "week": 1, "attempts": 20.0},
        {"player_id": "qb2", "position": "QB", "week": 1, "attempts": 10.0},
        {"player_id": "qb1", "position": "QB", "week": 2},
    ])
    out = build_features(weekly, make_schedules())
    assert out[out["week"] == 2]["team_pass_att_last4"].iloc[0] == pytest.approx(30.0)


def test_is_indoor_roof_values():
    weekly = make_weekly([{"week": 1}])
    for roof, expected in (("dome", 1), ("closed", 1), ("outdoors", 0),
                           ("open", 0)):
        out = build_features(weekly, make_schedules(roof=roof))
        assert out["is_indoor"].iloc[0] == expected, roof


def test_is_indoor_defaults_to_zero_without_roof_column():
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    assert out["is_indoor"].iloc[0] == 0
    assert "is_indoor" in feature_columns(out, "v2")


def test_build_features_without_v2_source_columns_still_builds():
    """Pre-v2 frames (fixtures, old exports) must still build v1 features:
    v2 stat features are conditional on their source columns, never a hard
    requirement. is_indoor is schedule-derived and always present."""
    weekly = make_weekly([{"week": 1}, {"week": 2}]).drop(
        columns=["attempts", "receiving_air_yards", "passing_air_yards"])
    out = build_features(weekly, make_schedules())
    cols = feature_columns(out, "v2")
    assert "lag4_air_share" not in cols
    assert "team_pass_att_last4" not in cols
    assert "is_indoor" in cols
    assert "lag4_receiving_yards" in out.columns
