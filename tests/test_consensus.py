import numpy as np
import pandas as pd
import pytest


def _matched(rows):
    """Consensus rows as `attach_gsis` emits them."""
    base = {"player_id": "00-0001", "player": "A Guy", "pos": "WR", "team": "KC",
            "ecr": 10.0, "sd": 2.0, "best": 5.0, "worst": 20.0,
            "mergename": "a guy", "fp_id": "1"}
    return pd.DataFrame([{**base, **r} for r in rows])


def _actuals(rows):
    base = {"player_id": "00-0001", "name": "A Guy", "position": "WR",
            "actual_points": 100.0, "games": 17}
    return pd.DataFrame([{**base, **r} for r in rows])


def test_consensus_board_matches_board_player_contract():
    from ffmodel.eval.consensus import consensus_board

    board = consensus_board(_matched([{"player_id": "00-0001", "ecr": 3.0}]))
    p = board[0]
    assert p["player_id"] == "00-0001"
    assert p["position"] == "WR"
    # bands are absent on purpose: consensus publishes ranks, not points
    assert p["season_points"]["ppr"]["p10"] is None
    assert p["season_points"]["ppr"]["p90"] is None
    assert p["season_points"]["ppr"]["p50"] == pytest.approx(-3.0)


def test_consensus_board_preserves_ecr_ordering():
    """p50 = -ecr must be strictly decreasing in rank, so every rank-based
    metric (pool selection, hit-rate, Spearman) is exact under it."""
    from ffmodel.eval.consensus import consensus_board

    board = consensus_board(_matched([
        {"player_id": "c", "ecr": 30.0},
        {"player_id": "a", "ecr": 1.5},
        {"player_id": "b", "ecr": 12.0},
    ]))
    order = [p["player_id"] for p in
             sorted(board, key=lambda p: -p["season_points"]["ppr"]["p50"])]
    assert order == ["a", "b", "c"]


def test_consensus_board_runs_through_the_real_board_metrics_harness():
    """The fairness control: consensus is scored by the SAME function as our
    model, not a bespoke metric path."""
    from ffmodel.eval.board import board_metrics
    from ffmodel.eval.consensus import consensus_board

    matched = _matched([{"player_id": f"00-{i:04d}", "ecr": float(i), "pos": "WR"}
                        for i in range(1, 6)])
    actuals = _actuals([{"player_id": f"00-{i:04d}", "position": "WR",
                         "actual_points": float(100 - i)} for i in range(1, 6)])
    out = board_metrics(consensus_board(matched), actuals)
    assert "OVERALL" in set(out["position"])
    # perfect ordering agreement -> spearman 1.0
    wr = out[out["position"] == "WR"].iloc[0]
    assert wr["spearman_topN"] == pytest.approx(1.0)
    # no bands -> band metrics are NaN, never fabricated numbers
    assert np.isnan(wr["season_band_coverage"])


def test_missing_players_score_as_zero_not_dropped():
    """DNP handling: a ranked player with no stat line counts as 0 points.
    Excluding them would be selection on the outcome."""
    from ffmodel.eval.board import board_metrics
    from ffmodel.eval.consensus import consensus_board

    matched = _matched([
        {"player_id": "played", "ecr": 1.0},
        {"player_id": "never_played", "ecr": 2.0},
    ])
    actuals = _actuals([{"player_id": "played", "actual_points": 200.0}])
    out = board_metrics(consensus_board(matched), actuals)
    wr = out[out["position"] == "WR"].iloc[0]
    assert wr["n"] == 2          # the DNP player is still in the pool


def test_common_universe_spearman_uses_intersection_only():
    from ffmodel.eval.consensus import common_universe_spearman

    ours = [{"player_id": "a", "position": "WR",
             "season_points": {"ppr": {"p50": 300.0}}},
            {"player_id": "b", "position": "WR",
             "season_points": {"ppr": {"p50": 200.0}}},
            {"player_id": "ours_only", "position": "WR",
             "season_points": {"ppr": {"p50": 50.0}}}]
    theirs = [{"player_id": "a", "position": "WR",
               "season_points": {"ppr": {"p50": -1.0}}},
              {"player_id": "b", "position": "WR",
               "season_points": {"ppr": {"p50": -2.0}}},
              {"player_id": "theirs_only", "position": "WR",
               "season_points": {"ppr": {"p50": -3.0}}}]
    actual_by_id = {"a": 300.0, "b": 100.0, "ours_only": 10.0, "theirs_only": 10.0}
    out = common_universe_spearman(ours, theirs, actual_by_id, {})
    assert out["n_common"] == 2
    assert out["n_ours_only"] == 1
    assert out["n_theirs_only"] == 1
    # both order a > b, and actuals agree -> both perfectly correlated
    assert out["spearman_ours"] == pytest.approx(1.0)
    assert out["spearman_consensus"] == pytest.approx(1.0)


def test_common_universe_detects_disagreement():
    from ffmodel.eval.consensus import common_universe_spearman

    ours = [{"player_id": "a", "position": "WR",
             "season_points": {"ppr": {"p50": 300.0}}},
            {"player_id": "b", "position": "WR",
             "season_points": {"ppr": {"p50": 100.0}}}]
    theirs = [{"player_id": "a", "position": "WR",
               "season_points": {"ppr": {"p50": -2.0}}},   # ranks b ahead of a
              {"player_id": "b", "position": "WR",
               "season_points": {"ppr": {"p50": -1.0}}}]
    actual_by_id = {"a": 300.0, "b": 10.0}                  # ours was right
    out = common_universe_spearman(ours, theirs, actual_by_id, {})
    assert out["spearman_ours"] > out["spearman_consensus"]


def test_common_universe_sensitivity_cut_filters_by_games():
    """The >=min_games cut is outcome-selected, so it is a labeled diagnostic
    only -- but it must actually filter."""
    from ffmodel.eval.consensus import common_universe_spearman

    ours = [{"player_id": p, "position": "WR",
             "season_points": {"ppr": {"p50": v}}}
            for p, v in (("a", 300.0), ("b", 200.0), ("hurt", 100.0))]
    theirs = [{"player_id": p, "position": "WR",
               "season_points": {"ppr": {"p50": v}}}
              for p, v in (("a", -1.0), ("b", -2.0), ("hurt", -3.0))]
    actual_by_id = {"a": 300.0, "b": 200.0, "hurt": 0.0}
    games_by_id = {"a": 17, "b": 16, "hurt": 1}
    full = common_universe_spearman(ours, theirs, actual_by_id, games_by_id)
    cut = common_universe_spearman(ours, theirs, actual_by_id, games_by_id,
                                   min_games=8)
    assert full["n_common"] == 3
    assert cut["n_common"] == 2      # the 1-game player is excluded


def test_points_metrics_are_nulled_for_consensus_rows():
    """season_mae_topN on the synthetic -ecr scale is meaningless and must
    never be published as a number."""
    from ffmodel.eval.consensus import null_pointwise_metrics

    frame = pd.DataFrame([
        {"model": "consensus", "position": "WR", "season_mae_topN": 123.4,
         "spearman_topN": 0.5, "hit_rate_starters": 0.4},
        {"model": "transformer", "position": "WR", "season_mae_topN": 60.0,
         "spearman_topN": 0.5, "hit_rate_starters": 0.4},
    ])
    out = null_pointwise_metrics(frame)
    con = out[out["model"] == "consensus"].iloc[0]
    ours = out[out["model"] == "transformer"].iloc[0]
    assert con["season_mae_topN"] is None or pd.isna(con["season_mae_topN"])
    assert ours["season_mae_topN"] == pytest.approx(60.0)   # ours untouched
    assert con["spearman_topN"] == pytest.approx(0.5)       # rank metrics kept
