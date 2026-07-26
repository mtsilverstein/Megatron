import numpy as np
import pandas as pd
import pytest

from ffmodel.site.board_rank import adp_round, order_and_value, rank_board


def test_adp_round_ceils_by_team_count():
    assert adp_round(1.0) == 1
    assert adp_round(12.0) == 1
    assert adp_round(13.0) == 2
    assert adp_round(30.4) == 3
    assert adp_round(None) is None
    assert adp_round(float("nan")) is None


def test_order_and_value_ecr_orders_and_value_is_monotone():
    # model likes A least (p50 10) but experts rank A #1; C has no ECR.
    group = pd.DataFrame({
        "player_id": ["A", "B", "C"],
        "position": "RB",
        "ppr_p50": [10.0, 30.0, 20.0],
        "ecr": [1.0, 2.0, np.nan],
    })
    out = order_and_value(group)
    # ECR order: A, B, then the ECR-less tail C
    assert list(out["player_id"]) == ["A", "B", "C"]
    # value_points = sorted(ppr_p50) desc laid onto that order -> monotone
    assert list(out["value_points"]) == [30.0, 20.0, 10.0]
    assert list(out["value_points"]) == sorted(out["value_points"], reverse=True)


def test_order_and_value_no_ecr_reduces_to_p50_order():
    group = pd.DataFrame({
        "player_id": ["A", "B", "C"], "position": "WR",
        "ppr_p50": [10.0, 30.0, 20.0], "ecr": [np.nan, np.nan, np.nan],
    })
    out = order_and_value(group)
    assert list(out["player_id"]) == ["B", "C", "A"]           # p50 desc
    assert list(out["value_points"]) == [30.0, 20.0, 10.0]     # == own p50 in order


def test_rank_board_tiers_do_not_extend_into_no_ecr_tail():
    # spec §6.7: tiers mark cliffs within the ECR'd pool only; the no-ECR depth
    # tail is one trailing tier, never a shelf per depth player.
    players = pd.DataFrame({
        "player_id": ["a", "b", "c", "d", "t1", "t2"],
        "position": "RB",
        "ppr_p50": [100.0, 98.0, 60.0, 58.0, 30.0, 20.0],
        "ecr": [1.0, 2.0, 3.0, 4.0, np.nan, np.nan],   # t1/t2 unranked tail
        "adp": [np.nan] * 6,
    })
    board = rank_board(players, {"RB": 3})
    tier = {r.player_id: r.tier for r in board.itertuples()}
    # ranked pool: 98->60 cliff splits a,b (tier 1) from c,d (tier 2)
    assert tier["a"] == 1 and tier["b"] == 1
    assert tier["c"] == 2 and tier["d"] == 2
    # the tail shares ONE trailing tier (no per-depth-player shelves)
    assert tier["t1"] == tier["t2"] == 3


def test_rank_board_vorp_monotone_and_flex_replacement():
    players = pd.DataFrame({
        "player_id": [f"rb{i}" for i in range(5)],
        "position": "RB",
        "ppr_p50": [200.0, 180.0, 160.0, 140.0, 120.0],
        "ecr": [1.0, 2.0, 3.0, 4.0, 5.0],
        "adp": [6.0, 18.0, 30.0, np.nan, 42.0],
    })
    board = rank_board(players, replacement_rank={"RB": 3})
    assert list(board["vorp"]) == sorted(board["vorp"], reverse=True)
    # replacement = value_points at rank 3 = 160 -> top vorp = 200 - 160 = 40
    assert board.iloc[0]["vorp"] == pytest.approx(40.0)
    assert list(board["position_rank"]) == [1, 2, 3, 4, 5]
    # adp_round attached: adp 6 -> R1, 18 -> R2, 30 -> R3, NaN -> None, 42 -> R4
    rounds = list(board["adp_round"])
    assert rounds[:3] == [1, 2, 3] and rounds[3] is None and rounds[4] == 4


def test_flex_replacement_derives_split_from_ecr():
    from ffmodel.site.board_rank import flex_replacement_ranks
    # dedicated 2 QB / 4 RB / 4 WR / 2 TE, 3 flex slots (toy). Beyond the
    # dedicated slots, the leftovers by ECR are WR12, WR13, RB20, RB21, TE32;
    # the top 3 (the flex) are WR, WR, RB -> RB +1, WR +2, TE +0.
    players = pd.DataFrame({
        "position": (["QB"] * 3 + ["RB"] * 6 + ["WR"] * 6 + ["TE"] * 3),
        "ecr": [1, 2, 3,                      # QB
                5, 6, 7, 8, 20, 21,           # RB (dedicated top 4: 5-8)
                4, 9, 10, 11, 12, 13,         # WR (dedicated top 4: 4,9,10,11)
                30, 31, 32],                  # TE (dedicated top 2: 30,31)
    }).astype({"ecr": float})
    repl = flex_replacement_ranks(
        players, dedicated={"QB": 2, "RB": 4, "WR": 4, "TE": 2}, flex_slots=3)
    assert repl == {"QB": 3, "RB": 6, "WR": 7, "TE": 3}


def test_flex_replacement_small_pool_falls_back_to_dedicated_plus_one():
    from ffmodel.site.board_rank import flex_replacement_ranks
    players = pd.DataFrame({"position": ["RB", "WR"], "ecr": [1.0, 2.0]})
    repl = flex_replacement_ranks(
        players, dedicated={"QB": 12, "RB": 24, "WR": 24, "TE": 12}, flex_slots=24)
    # pool smaller than dedicated -> no flex filled -> base replacement, no crash
    assert repl == {"QB": 13, "RB": 25, "WR": 25, "TE": 13}
