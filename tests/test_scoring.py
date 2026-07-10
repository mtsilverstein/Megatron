import pandas as pd
import pytest

from ffmodel.scoring import HALF_PPR, PPR, PREDICTED_STATS, STANDARD, fantasy_points


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
