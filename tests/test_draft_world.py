"""Tests for the draft-strategy backtest's world builder.

The interesting surface is small but load-bearing: the answer key must be
scored the same way the board's projections are (or the comparison is not
like-for-like), it must contain only the target season (or the backtest leaks),
and it must keep weeks apart (or bye/injury holes vanish and every roster looks
better than it was).
"""
import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.draft_world import _weeks_by_player, market_positions, weekly_actuals
from ffmodel.scoring import PPR, STANDARD


def _weekly():
    """Two players over three weeks, spanning two seasons."""
    return pd.DataFrame({
        "player_id": ["a", "a", "a", "b", "b", "a"],
        "player_display_name": ["A", "A", "A", "B", "B", "A"],
        "position": ["WR", "WR", "WR", "RB", "RB", "WR"],
        "season": [2023, 2023, 2023, 2023, 2023, 2022],
        "week": [1, 2, 3, 1, 2, 1],
        "receptions": [5, 0, 3, 0, 0, 99],
        "receiving_yards": [50, 0, 30, 0, 0, 999],
        "receiving_tds": [1, 0, 0, 0, 0, 9],
        "rushing_yards": [0, 0, 0, 100, 20, 0],
        "rushing_tds": [0, 0, 0, 1, 0, 0],
        "carries": [0, 0, 0, 20, 5, 0],
        "targets": [7, 0, 4, 0, 0, 0],
        "passing_yards": 0.0, "passing_tds": 0.0, "passing_interceptions": 0.0,
        "fumbles_lost": [0, 0, 0, 0, 1, 0],
    })


def test_weekly_actuals_scores_ppr_per_week():
    out = weekly_actuals(_weekly(), 2023)
    a1 = out[(out["player_id"] == "a") & (out["week"] == 1)]["points"].iloc[0]
    # 5 rec + 50 yds/10 + 1 TD*6 = 5 + 5 + 6
    assert a1 == pytest.approx(16.0)
    b1 = out[(out["player_id"] == "b") & (out["week"] == 1)]["points"].iloc[0]
    # 100 rush yds/10 + 1 TD*6
    assert b1 == pytest.approx(16.0)
    b2 = out[(out["player_id"] == "b") & (out["week"] == 2)]["points"].iloc[0]
    # 20 rush yds/10 - 2 for the lost fumble
    assert b2 == pytest.approx(0.0)


def test_weekly_actuals_honours_the_scoring_rules():
    ppr = weekly_actuals(_weekly(), 2023, PPR)
    std = weekly_actuals(_weekly(), 2023, STANDARD)
    a1_ppr = ppr[(ppr["player_id"] == "a") & (ppr["week"] == 1)]["points"].iloc[0]
    a1_std = std[(std["player_id"] == "a") & (std["week"] == 1)]["points"].iloc[0]
    assert a1_ppr - a1_std == pytest.approx(5.0)      # five receptions


def test_weekly_actuals_is_confined_to_the_target_season():
    """The 2022 row is a 999-yard monster. If it leaks into the 2023 answer key
    the backtest silently rewards a player for the wrong season."""
    out = weekly_actuals(_weekly(), 2023)
    assert len(out) == 5
    assert out["points"].max() < 100


def test_weekly_actuals_keeps_weeks_separate():
    """Collapsing to a season total would erase bye and injury holes, and every
    roster in the simulator would look better than it really was."""
    out = weekly_actuals(_weekly(), 2023)
    a_weeks = set(out[out["player_id"] == "a"]["week"])
    assert a_weeks == {1, 2, 3}
    assert set(out[out["player_id"] == "b"]["week"]) == {1, 2}


def test_weekly_actuals_rejects_a_season_with_no_rows():
    with pytest.raises(ValueError, match="no weekly rows"):
        weekly_actuals(_weekly(), 2030)


def test_weeks_by_player_shape_is_id_to_week_to_points():
    out = _weeks_by_player(weekly_actuals(_weekly(), 2023))
    assert set(out) == {"a", "b"}
    assert out["a"]["1"] == pytest.approx(16.0)
    assert set(out["b"]) == {"1", "2"}
    # keys are strings on both levels — the node simulator indexes with String(w)
    assert all(isinstance(k, str) for k in out["a"])


def test_weeks_by_player_omits_weeks_the_player_did_not_record():
    """An absent week must stay absent. The simulator reads a missing week as
    'not startable'; writing a 0 instead would let a bye week fill a roster
    slot with nothing and hide the cost of a stacked bye."""
    out = _weeks_by_player(weekly_actuals(_weekly(), 2023))
    assert "3" not in out["b"]


def test_market_positions_are_dense_pick_numbers_in_consensus_order():
    ecr = pd.DataFrame({"player_id": ["c", "a", "b"], "ecr": [30.5, 1.2, 12.0]})
    assert market_positions(ecr) == {"a": 1.0, "b": 2.0, "c": 3.0}


def test_market_positions_cover_every_ranked_player():
    """A player left without a pick number is invisible to the simulated field,
    which is the failure that made the first backtest run meaningless."""
    ecr = pd.DataFrame({"player_id": [f"p{i}" for i in range(50)],
                        "ecr": np.linspace(1, 200, 50)})
    out = market_positions(ecr)
    assert len(out) == 50
    assert sorted(out.values()) == [float(i) for i in range(1, 51)]


def test_market_positions_break_ties_stably():
    ecr = pd.DataFrame({"player_id": ["a", "b", "c"], "ecr": [5.0, 5.0, 1.0]})
    first = market_positions(ecr)
    assert first == market_positions(ecr.copy())
    assert first["c"] == 1.0                       # the clear leader still leads
    assert {first["a"], first["b"]} == {2.0, 3.0}
