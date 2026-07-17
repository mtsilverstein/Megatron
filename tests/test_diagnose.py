"""Diagnostics module: leak-free availability cohorts, rate decomposition,
and weekly ICC -- all on hand-computable toy fixtures (Plan 4 Phase B,
Task 3). CLI tests live at the bottom."""
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
    assert list(out.columns) == ["position", "proj_games", "expected_games",
                                 "actual_mean_games", "proj_ppg", "actual_ppg",
                                 "rate_bias"]

    qb = out[out["position"] == "QB"].iloc[0]
    # pool = both QBs (only 2 -- cap 2*13=26 doesn't bind).
    # proj_games = mean(16, 15) = 15.5
    # proj_ppg = mean(300, 200) / 15.5 = 250 / 15.5
    # actual_ppg = (280 + 190) / (16 + 15) = 470 / 31   (aggregate ratio)
    assert qb["proj_games"] == pytest.approx(15.5)
    assert qb["expected_games"] == pytest.approx(15.5)
    assert qb["actual_mean_games"] == pytest.approx(15.5)
    assert qb["proj_ppg"] == pytest.approx(250 / 15.5)
    assert qb["actual_ppg"] == pytest.approx(470 / 31)
    assert qb["rate_bias"] == pytest.approx(250 / 15.5 - 470 / 31)

    rb = out[out["position"] == "RB"].iloc[0]
    # proj_games = mean(14, 10) = 12.0
    # actual_mean_games = mean(14, 0) = 7.0   (r2 missing -> 0, no survivorship)
    # proj_ppg = mean(150, 50) / 12.0 = 100 / 12
    # actual_ppg = (140 + 0) / (14 + 0) = 10.0   (r2 contributes 0/0, not NaN)
    assert rb["proj_games"] == pytest.approx(12.0)
    assert rb["expected_games"] == pytest.approx(13.0)
    assert rb["actual_mean_games"] == pytest.approx(7.0)
    assert rb["proj_ppg"] == pytest.approx(100 / 12)
    assert rb["actual_ppg"] == pytest.approx(10.0)
    assert rb["rate_bias"] == pytest.approx(100 / 12 - 10.0)


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
