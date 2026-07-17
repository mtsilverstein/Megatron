import pandas as pd
import pytest

from ffmodel.scoring import (
    HALF_PPR,
    PPR,
    PREDICTED_STATS,
    STANDARD,
    fantasy_points,
    fantasy_points_band,
    fantasy_points_quantiles,
    stat_weights,
)


def test_predicted_stats_contract():
    assert PREDICTED_STATS == [
        "passing_yards", "passing_tds", "passing_interceptions",
        "carries", "rushing_yards", "rushing_tds",
        "targets", "receptions", "receiving_yards", "receiving_tds",
        "fumbles_lost",
    ]


def test_ppr_receiver_line():
    # 6 rec, 84 yds, 1 TD, 1 fumble lost: 6*1 + 8.4 + 6 - 2 = 18.4
    df = pd.DataFrame([{"receptions": 6, "receiving_yards": 84, "receiving_tds": 1, "fumbles_lost": 1}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(18.4)


def test_reception_value_across_rulesets():
    df = pd.DataFrame([{"receptions": 10}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(10.0)
    assert fantasy_points(df, HALF_PPR).iloc[0] == pytest.approx(5.0)
    assert fantasy_points(df, STANDARD).iloc[0] == pytest.approx(0.0)


def test_qb_line_with_two_point_and_int():
    # 300 pass yds, 2 TD, 1 INT, 1 two-point: 12 + 8 - 2 + 2 = 20
    df = pd.DataFrame([{
        "passing_yards": 300, "passing_tds": 2, "passing_interceptions": 1,
        "two_point_conversions": 1,
    }])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(20.0)


def test_missing_columns_count_as_zero():
    df = pd.DataFrame([{"rushing_yards": 50}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(5.0)


def test_carries_and_targets_do_not_score():
    df = pd.DataFrame([{"carries": 20, "targets": 12}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(0.0)


def test_rush_td_and_special_teams_td_weights():
    df = pd.DataFrame([{"rushing_tds": 2, "special_teams_tds": 1}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(18.0)  # 12 + 6


def test_in_column_nan_counts_as_zero():
    df = pd.DataFrame([{"rushing_yards": float("nan"), "receptions": 3}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(3.0)


# --- Sign-coherent quantile bands ---------------------------------------------
# The point ceiling/floor of a quantile band cannot be built by scoring the p90
# (or p10) stat frame directly, because negatively-scored components (INTs,
# fumbles) invert: a passer's ceiling game has his FEWEST interceptions, not his
# p90 (worst) count. fantasy_points_band pairs each component with its own
# points-favourable end.

def test_fantasy_points_band_positive_only_matches_direct_scoring():
    # With only positively-scored components, the band is just (score(low), score(high)).
    low = pd.DataFrame([{"rushing_yards": 40, "receptions": 3, "receiving_yards": 25}])
    high = pd.DataFrame([{"rushing_yards": 90, "receptions": 7, "receiving_yards": 70}])
    floor, ceil = fantasy_points_band(low, high, PPR)
    assert floor.iloc[0] == pytest.approx(fantasy_points(low, PPR).iloc[0])
    assert ceil.iloc[0] == pytest.approx(fantasy_points(high, PPR).iloc[0])


def test_fantasy_points_band_puts_fewest_interceptions_in_ceiling():
    # p10 game: 200 yds, 1 TD, 0 INT.  p90 game: 320 yds, 3 TD, 2 INT.
    low = pd.DataFrame([{"passing_yards": 200, "passing_tds": 1, "passing_interceptions": 0}])
    high = pd.DataFrame([{"passing_yards": 320, "passing_tds": 3, "passing_interceptions": 2}])
    floor, ceil = fantasy_points_band(low, high, PPR)
    # ceiling = best realistic game: high yards+TDs, but the FEW-INT (p10=0) end.
    assert ceil.iloc[0] == pytest.approx(320 * 0.04 + 3 * 4 - 2 * 0)  # 24.8, not 20.8
    # floor = worst game: low yards+TDs, and the MANY-INT (p90=2) end.
    assert floor.iloc[0] == pytest.approx(200 * 0.04 + 1 * 4 - 2 * 2)  # 8.0, not 12.0
    # The old fantasy_points(high) would have understated the ceiling.
    assert ceil.iloc[0] > fantasy_points(high, PPR).iloc[0]


def test_fantasy_points_band_floor_never_exceeds_ceiling():
    low = pd.DataFrame([
        {"passing_yards": 180, "passing_interceptions": 0, "fumbles_lost": 0, "rushing_yards": 5},
        {"receptions": 2, "receiving_yards": 10, "fumbles_lost": 0},
    ])
    high = pd.DataFrame([
        {"passing_yards": 340, "passing_interceptions": 3, "fumbles_lost": 1, "rushing_yards": 40},
        {"receptions": 9, "receiving_yards": 120, "fumbles_lost": 1},
    ])
    floor, ceil = fantasy_points_band(low, high, PPR)
    assert (floor <= ceil).all()


def test_fantasy_points_quantiles_dict_uses_band_for_p10_p90():
    frames = {
        "p10": pd.DataFrame([{"passing_yards": 200, "passing_interceptions": 0}]),
        "p50": pd.DataFrame([{"passing_yards": 260, "passing_interceptions": 1}]),
        "p90": pd.DataFrame([{"passing_yards": 320, "passing_interceptions": 2}]),
    }
    out = fantasy_points_quantiles(frames, PPR)
    assert out["p50"].iloc[0] == pytest.approx(fantasy_points(frames["p50"], PPR).iloc[0])
    # p90 point ceiling uses the FEW-INT end (p10 interceptions = 0).
    assert out["p90"].iloc[0] == pytest.approx(320 * 0.04 - 2 * 0)  # 12.8
    assert out["p10"].iloc[0] == pytest.approx(200 * 0.04 - 2 * 2)  # 4.0


def test_fantasy_points_quantiles_none_frames_give_none_bands():
    frames = {"p10": None, "p50": pd.DataFrame([{"rushing_yards": 50}]), "p90": None}
    out = fantasy_points_quantiles(frames, PPR)
    assert out["p10"] is None and out["p90"] is None
    assert out["p50"].iloc[0] == pytest.approx(5.0)


def test_fantasy_points_band_rejects_mismatched_indexes():
    # pd.concat aligns on index, so a low/high pair with different row sets
    # would silently produce degenerate bands (missing side skipped by
    # max/min) — fail loud instead.
    low = pd.DataFrame({"rushing_yards": [40.0, 50.0]}, index=[0, 1])
    high = pd.DataFrame({"rushing_yards": [90.0, 95.0]}, index=[1, 2])
    with pytest.raises(ValueError, match="index"):
        fantasy_points_band(low, high, PPR)


def test_stat_weights_is_the_source_of_truth_for_scoring():
    # Every nonzero weight in the map reproduces fantasy_points for a unit stat line.
    w = stat_weights(PPR)
    assert w["passing_interceptions"] == -2.0 and w["fumbles_lost"] == -2.0
    assert "carries" not in w and "targets" not in w  # unscored
    for col, weight in w.items():
        got = fantasy_points(pd.DataFrame([{col: 1.0}]), PPR).iloc[0]
        assert got == pytest.approx(weight), col
