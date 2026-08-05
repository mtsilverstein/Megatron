"""Diagnostics module: leak-free availability cohorts, rate decomposition,
and weekly ICC -- all on hand-computable toy fixtures (Plan 4 Phase B,
Task 3). CLI tests live at the bottom."""
import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.diagnose import (
    availability_summary, availability_table, build_parser, parse_and_validate,
    rate_decomposition, weekly_residual_icc,
)
from ffmodel.site.draft import REPLACEMENT_RANK

from tests.test_features import make_weekly


def _weekly(rows: list[dict]) -> pd.DataFrame:
    """One make_weekly call per row so each dict can set its own season/week/
    player_id/position -- make_weekly itself only accepts one shared default
    row shape per call."""
    return pd.concat([make_weekly([r]) for r in rows], ignore_index=True)


# ----------------------------------------------------------- availability_table

def test_availability_table_hand_computed_and_complete_distribution():
    weekly = _weekly([
        # Season 2020 (S'-1): establishes the cohort. Points via rushing_yards
        # (PPR rush_yd = 0.1/yd): rA=100yd->10pts, rB=50yd->5pts, rC=50yd->5pts.
        {"player_id": "rA", "position": "RB", "season": 2020, "week": 1,
         "rushing_yards": 100.0},
        {"player_id": "rB", "position": "RB", "season": 2020, "week": 1,
         "rushing_yards": 50.0},
        {"player_id": "rC", "position": "RB", "season": 2020, "week": 1,
         "rushing_yards": 50.0},
        # Season 2021 (S'): rA never appears again (bust) -> 0 games.
        # rB plays 2 games. rC's 2021 activity is irrelevant -- excluded from
        # the cohort by the tie-break below.
        {"player_id": "rB", "position": "RB", "season": 2021, "week": 1,
         "rushing_yards": 10.0},
        {"player_id": "rB", "position": "RB", "season": 2021, "week": 2,
         "rushing_yards": 10.0},
    ])
    out = availability_table(weekly, through_season=2021, pairs=6,
                             replacement_rank={"RB": 1})
    assert list(out.columns) == ["position", "games", "count"]
    assert set(out["position"]) == {"RB"}
    # games axis is complete 0..18 (zero counts included)
    assert sorted(out["games"]) == list(range(19))

    counts_by_games = dict(zip(out["games"], out["count"]))
    # cohort = top 2*1=2 RB from 2020 by actual_points, tie-break player_id asc:
    # rA=10.0 (clear top) ; rB=rC=5.0 tied -> "rB" < "rC" so rB wins the tie.
    # cohort = {rA, rB}. rA -> 0 games in 2021 (disappeared, no survivorship).
    # rB -> 2 games in 2021. rC (excluded) must NOT be counted anywhere.
    assert counts_by_games[0] == 1
    assert counts_by_games[2] == 1
    assert sum(counts_by_games.values()) == 2   # only 2 cohort members total


def test_availability_table_default_replacement_rank_covers_all_positions():
    weekly = _weekly([
        {"player_id": "rB", "position": "RB", "season": 2020, "week": 1},
        {"player_id": "rB", "position": "RB", "season": 2021, "week": 1},
    ])
    out = availability_table(weekly, through_season=2021)   # default replacement_rank
    # QB/WR/TE have zero cohort members here but still get complete 0..18 rows
    assert set(out["position"]) == set(REPLACEMENT_RANK)
    for pos in REPLACEMENT_RANK:
        sub = out[out["position"] == pos]
        assert sorted(sub["games"]) == list(range(19))


def test_availability_table_raises_without_valid_pair():
    weekly = make_weekly([{"season": 2020, "week": 1}])   # no season 2019 -> no pair
    with pytest.raises(ValueError):
        availability_table(weekly, through_season=2020)


# --------------------------------------------------------- availability_summary

def test_availability_summary_hand_computed():
    counts = pd.DataFrame({
        "position": ["RB", "RB", "RB"],
        "games": [0, 1, 2],
        "count": [1, 0, 3],
    })
    out = availability_summary(counts)
    assert list(out.columns) == ["position", "mean_games", "std_games", "n_player_seasons"]
    row = out[out["position"] == "RB"].iloc[0]
    # mean = (0*1 + 1*0 + 2*3) / 4 = 6/4 = 1.5
    # population var = (1*(0-1.5)**2 + 0*(1-1.5)**2 + 3*(2-1.5)**2) / 4
    #                = (1*2.25 + 0 + 3*0.25) / 4 = (2.25 + 0.75) / 4 = 0.75
    # std = sqrt(0.75) ~= 0.8660254037844386
    assert row["mean_games"] == pytest.approx(1.5)
    assert row["std_games"] == pytest.approx(0.8660254037844386, rel=1e-9)
    assert row["n_player_seasons"] == 4


# ------------------------------------------------------------ rate_decomposition

def test_rate_decomposition_hand_computed_with_missing_player():
    board_players = [
        {"player_id": "q1", "position": "QB", "games": 16,
         "season_points": {"ppr": {"p50": 300.0}}},
        {"player_id": "q2", "position": "QB", "games": 15,
         "season_points": {"ppr": {"p50": 200.0}}},
        {"player_id": "r1", "position": "RB", "games": 14,
         "season_points": {"ppr": {"p50": 150.0}}},
        {"player_id": "r2", "position": "RB", "games": 10,
         "season_points": {"ppr": {"p50": 50.0}}},
    ]
    actuals = pd.DataFrame([
        {"player_id": "q1", "name": "q1", "position": "QB",
         "actual_points": 280.0, "games": 16},
        {"player_id": "q2", "name": "q2", "position": "QB",
         "actual_points": 190.0, "games": 15},
        {"player_id": "r1", "name": "r1", "position": "RB",
         "actual_points": 140.0, "games": 14},
        # r2 intentionally absent -- bust/retirement, must count as 0/0.
    ])
    summary = pd.DataFrame([
        {"position": "QB", "mean_games": 15.5, "std_games": 1.0, "n_player_seasons": 100},
        {"position": "RB", "mean_games": 13.0, "std_games": 2.0, "n_player_seasons": 100},
    ])
    out = rate_decomposition(board_players, actuals, summary)
    assert list(out.columns) == ["position", "scheduled_games", "expected_games",
                                 "actual_mean_games", "proj_median_total",
                                 "actual_mean_total", "actual_median_total",
                                 "proj_ppg", "actual_ppg", "rate_bias",
                                 "rate_bias_vs_median"]

    qb = out[out["position"] == "QB"].iloc[0]
    # pool = both QBs (only 2 -- cap 2*13=26 doesn't bind).
    # scheduled_games = mean(16, 15) = 15.5 (board's "games" field, context only)
    # proj_median_total = mean(300, 200) = 250
    # proj_ppg = proj_median_total / expected_games = 250 / 15.5   (NOT / scheduled_games)
    # actual_mean_total = mean(280, 190) = 235
    # actual_median_total = median(280, 190) = 235   (only 2 values -> same as mean)
    # actual_ppg = (280 + 190) / (16 + 15) = 470 / 31   (aggregate ratio)
    # rate_bias_vs_median = proj_ppg - actual_median_total / actual_mean_games
    #                     = 250/15.5 - 235/15.5
    assert qb["scheduled_games"] == pytest.approx(15.5)
    assert qb["expected_games"] == pytest.approx(15.5)
    assert qb["actual_mean_games"] == pytest.approx(15.5)
    assert qb["proj_median_total"] == pytest.approx(250.0)
    assert qb["actual_mean_total"] == pytest.approx(235.0)
    assert qb["actual_median_total"] == pytest.approx(235.0)
    assert qb["proj_ppg"] == pytest.approx(250 / 15.5)
    assert qb["actual_ppg"] == pytest.approx(470 / 31)
    assert qb["rate_bias"] == pytest.approx(250 / 15.5 - 470 / 31)
    assert qb["rate_bias_vs_median"] == pytest.approx(250 / 15.5 - 235 / 15.5)

    rb = out[out["position"] == "RB"].iloc[0]
    # scheduled_games = mean(14, 10) = 12.0 (board's "games" field, context only)
    # actual_mean_games = mean(14, 0) = 7.0   (r2 missing -> 0, no survivorship)
    # proj_median_total = mean(150, 50) = 100
    # proj_ppg = proj_median_total / expected_games = 100 / 13.0   (NOT / scheduled_games)
    # actual_mean_total = mean(140, 0) = 70   (r2 missing -> 0, no survivorship)
    # actual_median_total = median(140, 0) = 70   (only 2 values -> same as mean)
    # actual_ppg = (140 + 0) / (14 + 0) = 10.0   (r2 contributes 0/0, not NaN)
    # rate_bias_vs_median = proj_ppg - actual_median_total / actual_mean_games
    #                     = 100/13.0 - 70/7.0
    assert rb["scheduled_games"] == pytest.approx(12.0)
    assert rb["expected_games"] == pytest.approx(13.0)
    assert rb["actual_mean_games"] == pytest.approx(7.0)
    assert rb["proj_median_total"] == pytest.approx(100.0)
    assert rb["actual_mean_total"] == pytest.approx(70.0)
    assert rb["actual_median_total"] == pytest.approx(70.0)
    assert rb["proj_ppg"] == pytest.approx(100 / 13.0)
    assert rb["actual_ppg"] == pytest.approx(10.0)
    assert rb["rate_bias"] == pytest.approx(100 / 13.0 - 10.0)
    assert rb["rate_bias_vs_median"] == pytest.approx(100 / 13.0 - 70 / 7.0)


def test_rate_decomposition_ppg_uses_expected_not_scheduled_games():
    # scheduled_games (board "games") = 17, expected_games (summary mean_games)
    # = 12.0 -- deliberately different so a denominator regression is caught.
    board_players = [
        {"player_id": "r1", "position": "RB", "games": 17,
         "season_points": {"ppr": {"p50": 200.0}}},
        {"player_id": "r2", "position": "RB", "games": 17,
         "season_points": {"ppr": {"p50": 100.0}}},
    ]
    actuals = pd.DataFrame([
        {"player_id": "r1", "name": "r1", "position": "RB",
         "actual_points": 180.0, "games": 15},
        {"player_id": "r2", "name": "r2", "position": "RB",
         "actual_points": 90.0, "games": 14},
    ])
    summary = pd.DataFrame([
        {"position": "RB", "mean_games": 12.0, "std_games": 2.0, "n_player_seasons": 100},
    ])
    out = rate_decomposition(board_players, actuals, summary)
    rb = out[out["position"] == "RB"].iloc[0]

    proj_total = (200.0 + 100.0) / 2   # 150.0
    assert rb["scheduled_games"] == pytest.approx(17.0)
    assert rb["expected_games"] == pytest.approx(12.0)
    assert rb["proj_ppg"] == pytest.approx(proj_total / 12.0)
    assert rb["proj_ppg"] != pytest.approx(proj_total / 17.0)


def test_rate_decomposition_missing_expected_games_yields_nan_ppg():
    board_players = [
        {"player_id": "w1", "position": "WR", "games": 17,
         "season_points": {"ppr": {"p50": 150.0}}},
    ]
    actuals = pd.DataFrame([
        {"player_id": "w1", "name": "w1", "position": "WR",
         "actual_points": 140.0, "games": 16},
    ])
    # summary has no WR row at all -- expected_games missing for the position.
    summary = pd.DataFrame([
        {"position": "RB", "mean_games": 13.0, "std_games": 2.0, "n_player_seasons": 100},
    ])
    out = rate_decomposition(board_players, actuals, summary)
    wr = out[out["position"] == "WR"].iloc[0]
    assert np.isnan(wr["expected_games"])
    assert np.isnan(wr["proj_ppg"])


def test_rate_decomposition_zero_expected_games_yields_nan_ppg():
    board_players = [
        {"player_id": "w1", "position": "WR", "games": 17,
         "season_points": {"ppr": {"p50": 150.0}}},
    ]
    actuals = pd.DataFrame([
        {"player_id": "w1", "name": "w1", "position": "WR",
         "actual_points": 140.0, "games": 16},
    ])
    summary = pd.DataFrame([
        {"position": "WR", "mean_games": 0.0, "std_games": 0.0, "n_player_seasons": 0},
    ])
    out = rate_decomposition(board_players, actuals, summary)
    wr = out[out["position"] == "WR"].iloc[0]
    assert wr["expected_games"] == pytest.approx(0.0)
    assert np.isnan(wr["proj_ppg"])


def test_rate_decomposition_proj_median_total_and_actual_mean_total_are_pool_means():
    board_players = [
        {"player_id": "t1", "position": "TE", "games": 17,
         "season_points": {"ppr": {"p50": 120.0}}},
        {"player_id": "t2", "position": "TE", "games": 17,
         "season_points": {"ppr": {"p50": 80.0}}},
    ]
    actuals = pd.DataFrame([
        {"player_id": "t1", "name": "t1", "position": "TE",
         "actual_points": 100.0, "games": 15},
        # t2 intentionally absent -- bust, must count as 0 in actual_mean_total.
    ])
    summary = pd.DataFrame([
        {"position": "TE", "mean_games": 14.0, "std_games": 1.0, "n_player_seasons": 100},
    ])
    out = rate_decomposition(board_players, actuals, summary)
    te = out[out["position"] == "TE"].iloc[0]
    # proj_median_total still reports the mean of the pool's season p50 --
    # the rename must not change what it holds.
    assert te["proj_median_total"] == pytest.approx((120.0 + 80.0) / 2)
    assert te["actual_mean_total"] == pytest.approx((100.0 + 0.0) / 2)


def test_rate_decomposition_actual_median_total_includes_busts_as_zero():
    # Pool of 3 RBs: r1=100pts/10g, r2=20pts/10g, r3 is a bust (absent from
    # actuals -> 0pts/0g, no survivorship). Chosen so dropping the bust would
    # change the median: with the bust, sorted actuals = [0, 20, 100] ->
    # median 20; WITHOUT it, sorted = [20, 100] -> median 60. If the bust were
    # excluded from the median this test would see 60.0, not 20.0.
    board_players = [
        {"player_id": "r1", "position": "RB", "games": 17,
         "season_points": {"ppr": {"p50": 150.0}}},
        {"player_id": "r2", "position": "RB", "games": 17,
         "season_points": {"ppr": {"p50": 90.0}}},
        {"player_id": "r3", "position": "RB", "games": 17,
         "season_points": {"ppr": {"p50": 60.0}}},
    ]
    actuals = pd.DataFrame([
        {"player_id": "r1", "name": "r1", "position": "RB",
         "actual_points": 100.0, "games": 10},
        {"player_id": "r2", "name": "r2", "position": "RB",
         "actual_points": 20.0, "games": 10},
        # r3 intentionally absent -- bust, must count as 0/0.
    ])
    summary = pd.DataFrame([
        {"position": "RB", "mean_games": 10.0, "std_games": 1.0, "n_player_seasons": 100},
    ])
    out = rate_decomposition(board_players, actuals, summary)
    rb = out[out["position"] == "RB"].iloc[0]
    assert rb["actual_median_total"] == pytest.approx(20.0)
    assert rb["actual_mean_total"] == pytest.approx((100.0 + 20.0 + 0.0) / 3)


def test_rate_decomposition_rate_bias_vs_median_hand_computed_and_differs():
    # Same fixture as the median test above: proj_median_total = mean(150,90,60)
    # = 100, expected_games = 10 -> proj_ppg = 10.0.
    # actual_ppg (mean-based, aggregate ratio) = (100+20+0)/(10+10+0) = 120/20 = 6.0
    #   -> rate_bias = 10.0 - 6.0 = 4.0
    # actual_mean_games = mean(10, 10, 0) = 20/3
    # actual_median_total = 20.0 (per above)
    #   -> median-based actual rate = 20.0 / (20/3) = 3.0
    #   -> rate_bias_vs_median = 10.0 - 3.0 = 7.0
    # rate_bias (4.0) != rate_bias_vs_median (7.0): the two must not be conflated.
    board_players = [
        {"player_id": "r1", "position": "RB", "games": 17,
         "season_points": {"ppr": {"p50": 150.0}}},
        {"player_id": "r2", "position": "RB", "games": 17,
         "season_points": {"ppr": {"p50": 90.0}}},
        {"player_id": "r3", "position": "RB", "games": 17,
         "season_points": {"ppr": {"p50": 60.0}}},
    ]
    actuals = pd.DataFrame([
        {"player_id": "r1", "name": "r1", "position": "RB",
         "actual_points": 100.0, "games": 10},
        {"player_id": "r2", "name": "r2", "position": "RB",
         "actual_points": 20.0, "games": 10},
        # r3 intentionally absent -- bust, must count as 0/0.
    ])
    summary = pd.DataFrame([
        {"position": "RB", "mean_games": 10.0, "std_games": 1.0, "n_player_seasons": 100},
    ])
    out = rate_decomposition(board_players, actuals, summary)
    rb = out[out["position"] == "RB"].iloc[0]
    assert rb["proj_ppg"] == pytest.approx(10.0)
    assert rb["actual_ppg"] == pytest.approx(6.0)
    assert rb["rate_bias"] == pytest.approx(4.0)
    assert rb["rate_bias_vs_median"] == pytest.approx(10.0 - 20.0 / (20.0 / 3.0))
    assert rb["rate_bias_vs_median"] == pytest.approx(7.0)
    assert rb["rate_bias_vs_median"] != pytest.approx(rb["rate_bias"])


def test_rate_decomposition_rate_bias_vs_median_nan_when_all_busts():
    # Single WR pool member, entirely absent from actuals -- actual_mean_games
    # is 0, so rate_bias_vs_median must be NaN (division by a zero actual
    # games denominator) without raising.
    board_players = [
        {"player_id": "w1", "position": "WR", "games": 17,
         "season_points": {"ppr": {"p50": 150.0}}},
    ]
    actuals = pd.DataFrame(columns=["player_id", "name", "position",
                                    "actual_points", "games"])
    summary = pd.DataFrame([
        {"position": "WR", "mean_games": 14.0, "std_games": 1.0, "n_player_seasons": 100},
    ])
    out = rate_decomposition(board_players, actuals, summary)
    wr = out[out["position"] == "WR"].iloc[0]
    assert wr["actual_mean_games"] == pytest.approx(0.0)
    assert np.isnan(wr["rate_bias_vs_median"])


# --------------------------------------------------------------- weekly_residual_icc

def test_icc_zero_between_group_variance_clips_to_floor():
    # Both RB cohort members have S' weekly-points MEAN 15 -- zero between-group
    # variance -- but nonzero within-group variance, so the raw ICC formula goes
    # negative and must clip to the floor 0.0.
    weekly = _weekly([
        # 2020 establishes the cohort (magnitude irrelevant, just nonzero).
        {"player_id": "rX", "position": "RB", "season": 2020, "week": 1,
         "rushing_yards": 10.0},
        {"player_id": "rY", "position": "RB", "season": 2020, "week": 1,
         "rushing_yards": 10.0},
        # 2021: rX points = [10, 20] (mean 15), rY points = [5, 25] (mean 15).
        {"player_id": "rX", "position": "RB", "season": 2021, "week": 1,
         "rushing_yards": 100.0},
        {"player_id": "rX", "position": "RB", "season": 2021, "week": 2,
         "rushing_yards": 200.0},
        {"player_id": "rY", "position": "RB", "season": 2021, "week": 1,
         "rushing_yards": 50.0},
        {"player_id": "rY", "position": "RB", "season": 2021, "week": 2,
         "rushing_yards": 250.0},
    ])
    out = weekly_residual_icc(weekly, through_season=2021, pairs=6)
    assert list(out.columns) == ["position", "icc", "n_player_seasons", "n_weeks"]
    rb = out[out["position"] == "RB"].iloc[0]
    # By hand: groups g1=[10,20], g2=[5,25]; I=2, N=4, means both 15, grand=15.
    # MSB = (2*0 + 2*0)/1 = 0
    # MSW = ((10-15)^2+(20-15)^2 + (5-15)^2+(25-15)^2)/(4-2) = (50+200)/2 = 125
    # k0 = (4 - (4+4)/4)/1 = 2
    # icc = (0-125)/(0+(2-1)*125) = -1.0 -> clipped to 0.0
    assert rb["icc"] == pytest.approx(0.0, abs=1e-12)
    assert rb["n_player_seasons"] == 2
    assert rb["n_weeks"] == 4
    # (d) I < 2 -> NaN: no QB data at all in this fixture.
    qb = out[out["position"] == "QB"].iloc[0]
    assert pd.isna(qb["icc"])
    assert qb["n_player_seasons"] == 0


def test_icc_constant_within_group_clips_below_one():
    # Zero WITHIN-group variance, distinct group means -> raw ICC is exactly
    # 1.0, must clip strictly below 1.0.
    weekly = _weekly([
        {"player_id": "rX", "position": "RB", "season": 2020, "week": 1,
         "rushing_yards": 10.0},
        {"player_id": "rY", "position": "RB", "season": 2020, "week": 1,
         "rushing_yards": 10.0},
        # 2021: rX points = [10, 10] (mean 10), rY points = [30, 30] (mean 30).
        {"player_id": "rX", "position": "RB", "season": 2021, "week": 1,
         "rushing_yards": 100.0},
        {"player_id": "rX", "position": "RB", "season": 2021, "week": 2,
         "rushing_yards": 100.0},
        {"player_id": "rY", "position": "RB", "season": 2021, "week": 1,
         "rushing_yards": 300.0},
        {"player_id": "rY", "position": "RB", "season": 2021, "week": 2,
         "rushing_yards": 300.0},
    ])
    out = weekly_residual_icc(weekly, through_season=2021, pairs=6)
    rb = out[out["position"] == "RB"].iloc[0]
    # By hand: MSB=(2*100+2*100)/1=400, MSW=0, k0=2, icc=(400-0)/400=1.0 -> clip
    assert rb["icc"] < 1.0
    assert rb["icc"] == pytest.approx(1.0, abs=1e-9)


def test_icc_hand_computed_two_unequal_groups():
    # Group sizes 2 and 3, chosen so the pre-clip formula lands inside (0, 1)
    # -- verifies the formula itself, not just the clip boundaries.
    weekly = _weekly([
        {"player_id": "tA", "position": "TE", "season": 2020, "week": 1,
         "receiving_yards": 10.0},
        {"player_id": "tB", "position": "TE", "season": 2020, "week": 1,
         "receiving_yards": 10.0},
        # 2021: tA points = [5, 15] (2 weeks). tB points = [20, 25, 30] (3 weeks).
        {"player_id": "tA", "position": "TE", "season": 2021, "week": 1,
         "receiving_yards": 50.0},
        {"player_id": "tA", "position": "TE", "season": 2021, "week": 2,
         "receiving_yards": 150.0},
        {"player_id": "tB", "position": "TE", "season": 2021, "week": 1,
         "receiving_yards": 200.0},
        {"player_id": "tB", "position": "TE", "season": 2021, "week": 2,
         "receiving_yards": 250.0},
        {"player_id": "tB", "position": "TE", "season": 2021, "week": 3,
         "receiving_yards": 300.0},
    ])
    out = weekly_residual_icc(weekly, through_season=2021, pairs=6)
    te = out[out["position"] == "TE"].iloc[0]
    # By hand: g1=[5,15] (n=2,mean=10), g2=[20,25,30] (n=3,mean=25).
    # N=5, I=2, grand = (5+15+20+25+30)/5 = 95/5 = 19
    # MSB = (2*(10-19)^2 + 3*(25-19)^2)/1 = (2*81 + 3*36) = 162+108 = 270
    # MSW = ((5-10)^2+(15-10)^2 + (20-25)^2+(25-25)^2+(30-25)^2)/(5-2)
    #     = (25+25 + 25+0+25)/3 = 100/3
    # k0 = (5 - (4+9)/5)/1 = (5-2.6) = 2.4
    # denom = 270 + (2.4-1)*(100/3) = 270 + 1.4*33.3333... = 270 + 46.6666... = 950/3
    # icc = (270 - 100/3) / (950/3) = (710/3)/(950/3) = 710/950 = 71/95
    assert te["n_player_seasons"] == 2
    assert te["n_weeks"] == 5
    assert te["icc"] == pytest.approx(71 / 95, rel=1e-9)


def test_icc_raises_without_valid_pair():
    weekly = make_weekly([{"season": 2020, "week": 1}])
    with pytest.raises(ValueError):
        weekly_residual_icc(weekly, through_season=2020)


# ------------------------------------------------------------------------- CLI

def test_diagnose_parser_defaults():
    from pathlib import Path

    args = build_parser().parse_args([])
    assert args.data_dir == Path("data/raw")
    assert args.first_season == 2012
    assert args.last_season == 2025
    assert args.pairs == 6
    assert args.out_dir == Path("models/diagnostics")
    assert args.board_season is None
    assert args.transformer_root is None


def test_diagnose_board_season_without_transformer_root_raises():
    with pytest.raises(SystemExit):
        parse_and_validate(["--board-season", "2025"])


def test_diagnose_board_season_with_transformer_root_does_not_raise():
    args = parse_and_validate([
        "--board-season", "2025", "--transformer-root", "models/transformer/v1",
    ])
    assert args.board_season == 2025
    assert len(args.transformer_root) == 1


# --- returning_table: injury vs attrition ----------------------------------
def _returning_weekly():
    """Two established players, both losing season 2 to a short year, one still
    productive per game and one not. Season 3 is the outcome."""
    import pandas as pd
    rows = []

    from ffmodel.scoring import PREDICTED_STATS

    def add(pid, name, pos, season, weeks, rec_yds, rec=5.0, td=1.0):
        for w in weeks:
            row = {s: 0.0 for s in PREDICTED_STATS}
            row.update({"player_id": pid, "player_display_name": name,
                        "position": pos, "season": season, "week": w,
                        "receiving_yards": rec_yds, "receptions": rec,
                        "receiving_tds": td})
            rows.append(row)
    # established in S-1
    add("hurt", "Hurt Guy", "WR", 1, range(1, 16), 90)
    add("done", "Done Guy", "WR", 1, range(1, 16), 90)
    add("well", "Well Guy", "WR", 1, range(1, 16), 90)
    # S: both lose the season; "hurt" still productive per game, "done" is not
    add("hurt", "Hurt Guy", "WR", 2, range(1, 5), 90)                 # 20 ppg -> productive
    add("done", "Done Guy", "WR", 2, range(1, 5), 5, rec=1.0, td=0.0)  # 1.5 ppg -> not
    add("well", "Well Guy", "WR", 2, range(1, 17), 90)
    # S+1: the outcome
    add("hurt", "Hurt Guy", "WR", 3, range(1, 10), 90)    # 9 games
    add("well", "Well Guy", "WR", 3, range(1, 17), 90)
    # "done" records nothing in S+1 -> 0 games, and must NOT be counted
    return pd.DataFrame(rows)


def test_returning_table_counts_only_the_productive_returner():
    from ffmodel.eval.diagnose import returning_table
    t = returning_table(_returning_weekly(), through_season=2)
    counted = t[t["count"] > 0]
    assert list(counted["games"]) == [9], t[t["count"] > 0].to_dict("records")
    assert int(t["count"].sum()) == 1, "the attrition case must be excluded"


def test_returning_table_is_pooled_across_positions():
    from ffmodel.eval.diagnose import RETURNING_POS, returning_table
    t = returning_table(_returning_weekly(), through_season=2)
    assert set(t["position"]) == {RETURNING_POS}
    assert list(t["games"]) == list(range(19)), "complete 0..18 axis"


def test_returning_table_counts_a_vanished_player_as_zero_games():
    """No survivorship: a productive returner who never plays again is the
    worst outcome the distribution has to represent, not a dropped row."""
    import pandas as pd
    from ffmodel.eval.diagnose import returning_table
    w = _returning_weekly()
    w = w[~((w.player_id == "hurt") & (w.season == 3))]     # he never returns
    # keep season 3 alive via the healthy player
    t = returning_table(w, through_season=2)
    assert int(t.loc[t["games"] == 0, "count"].iloc[0]) == 1


def test_returning_table_raises_without_a_usable_season_pair():
    import pandas as pd
    import pytest
    from ffmodel.eval.diagnose import returning_table
    single = _returning_weekly()
    single = single[single.season == 1]
    with pytest.raises(ValueError):
        returning_table(single, through_season=1)
