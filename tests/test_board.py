"""Board-backtest core (Plan 4 Phase A1): season actuals, the leak
boundary, and board metrics -- all on hand-computable toy fixtures.
Phase A2 (CLI/loop) tests live at the bottom."""
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.board import (
    _board_report, board_metrics, board_world, build_parser,
    run_board_backtest, season_actuals,
)
from ffmodel.scoring import STANDARD

from tests.test_features import make_schedules, make_weekly
from tests.test_site_weekly import _QuantileStub


def _bp(pid: str, pos: str, p50: float, p10=None, p90=None) -> dict:
    """Board-payload player dict as build_draft_board emits (PPR lens).
    p10/p90 default to None -- exactly what point-only entrants produce."""
    return {
        "player_id": pid, "name": pid, "team": "AAA", "position": pos,
        "season_points": {"ppr": {"p50": p50, "p10": p10, "p90": p90}},
    }


def _actuals(rows: list[tuple]) -> pd.DataFrame:
    """[(player_id, position, actual_points), ...] -> season_actuals shape."""
    return pd.DataFrame([
        {"player_id": pid, "name": pid, "position": pos,
         "actual_points": pts, "games": 17}
        for pid, pos, pts in rows
    ])


# ---------------------------------------------------------------- board_world

def test_board_world_contains_nothing_from_board_season_or_later():
    # THE leak boundary: for board season S the August world is
    # weekly[season <= S-1] -- no season-S rows, and no later seasons either
    # (the full weekly pull contains 2012-2025 regardless of board season).
    weekly = make_weekly([
        {"season": 2021, "week": 1},
        {"season": 2022, "week": 1},
        {"season": 2022, "week": 2},
        {"season": 2023, "week": 1},   # board season -- must vanish
        {"season": 2024, "week": 1},   # future season -- must vanish too
    ])
    world = board_world(weekly, 2023)
    assert set(world["season"]) == {2021, 2022}
    assert (world["season"] < 2023).all()
    assert len(world) == 3                                # kept rows intact
    assert list(world.columns) == list(weekly.columns)    # schema untouched


def test_board_world_returns_copy_not_view():
    weekly = make_weekly([{"season": 2022, "week": 1}, {"season": 2023, "week": 1}])
    world = board_world(weekly, 2023)
    world.loc[:, "receiving_yards"] = 999.0    # would warn/leak on a view
    assert (weekly["receiving_yards"] == 0.0).all()


# ------------------------------------------------------------- season_actuals

def test_season_actuals_hand_computed_totals():
    weekly = make_weekly([
        # p1 2023 wk1: 100*0.1 + 5*1 + 1*6 = 21 PPR
        {"player_id": "p1", "season": 2023, "week": 1,
         "receiving_yards": 100.0, "receptions": 5.0, "receiving_tds": 1.0},
        # p1 2023 wk2: 50*0.1 + 3*1 = 8 PPR; the 2pt conversion must NOT
        # count -- actuals score PREDICTED_STATS only, same convention as the
        # weekly harness (models compared on predictable components).
        {"player_id": "p1", "season": 2023, "week": 2,
         "receiving_yards": 50.0, "receptions": 3.0, "two_point_conversions": 1},
        # prior-season row must not leak into 2023 totals
        {"player_id": "p1", "season": 2022, "week": 18, "receiving_yards": 200.0},
        # p2 2023 wk1: 250*0.04 + 2*4 - 1*2 = 16 PPR
        {"player_id": "p2", "player_display_name": "P Two", "position": "QB",
         "season": 2023, "week": 1, "passing_yards": 250.0,
         "passing_tds": 2.0, "passing_interceptions": 1.0},
    ])
    out = season_actuals(weekly, 2023)
    assert list(out.columns) == ["player_id", "name", "position",
                                 "actual_points", "games"]
    p1 = out[out["player_id"] == "p1"].iloc[0]
    assert p1["actual_points"] == pytest.approx(29.0)     # 21 + 8, no 2022, no 2pt
    assert p1["games"] == 2
    assert p1["name"] == "P One" and p1["position"] == "WR"
    p2 = out[out["player_id"] == "p2"].iloc[0]
    assert p2["actual_points"] == pytest.approx(16.0)
    assert p2["games"] == 1


def test_season_actuals_respects_scoring_rules():
    weekly = make_weekly([
        {"player_id": "p1", "season": 2023, "week": 1,
         "receiving_yards": 100.0, "receptions": 5.0},
    ])
    assert season_actuals(weekly, 2023)["actual_points"].iloc[0] == \
        pytest.approx(15.0)                                # PPR: 10 + 5
    assert season_actuals(weekly, 2023, rules=STANDARD)["actual_points"].iloc[0] == \
        pytest.approx(10.0)                                # standard: receptions free


def test_season_actuals_missing_season_raises():
    weekly = make_weekly([{"season": 2022, "week": 1}])
    with pytest.raises(ValueError, match="2023"):
        season_actuals(weekly, 2023)


def test_projected_player_with_no_season_rows_scores_zero():
    # qb_ghost is on the board but recorded no season-2023 stat line
    # (bust/retirement/injury). The board is charged the full miss
    # (actual_points = 0) -- no survivorship filtering.
    weekly = make_weekly([
        {"player_id": "qb1", "position": "QB", "season": 2023, "week": 1,
         "passing_yards": 250.0},                          # 10 PPR
    ])
    actuals = season_actuals(weekly, 2023)
    assert "qb_ghost" not in set(actuals["player_id"])
    board = [_bp("qb1", "QB", 10.0), _bp("qb_ghost", "QB", 100.0)]
    table = board_metrics(board, actuals).set_index("position")
    # errors: qb1 |10-10| = 0, ghost |100-0| = 100 -> MAE 50
    assert table.loc["QB", "season_mae_topN"] == pytest.approx(50.0)
    # ghost never finished as a starter: actual top-R is {qb1} alone
    assert table.loc["QB", "hit_rate_starters"] == pytest.approx(1 / 13)


# -------------------------------------------------------------- board_metrics

def _toy_board() -> list[dict]:
    return [
        _bp("qb1", "QB", 300.0, 250.0, 350.0),
        _bp("qb2", "QB", 280.0, 230.0, 330.0),
        _bp("qb3", "QB", 260.0, 210.0, 310.0),
        _bp("qb4", "QB", 240.0, 190.0, 290.0),   # no season rows -> actual 0
        _bp("rb1", "RB", 200.0, 150.0, 250.0),
        _bp("rb2", "RB", 180.0, 130.0, 230.0),
        _bp("rb3", "RB", 160.0, 110.0, 210.0),
        _bp("rb4", "RB", 140.0, 90.0, 190.0),
    ]


def _toy_actuals() -> pd.DataFrame:
    return _actuals([
        ("qb1", "QB", 290.0), ("qb2", "QB", 310.0), ("qb3", "QB", 200.0),
        ("qb5", "QB", 275.0),      # actual starter the board missed entirely
        ("rb1", "RB", 240.0), ("rb2", "RB", 170.0),
        ("rb3", "RB", 150.0), ("rb4", "RB", 100.0),
    ])


def test_board_metrics_hand_computed():
    table = board_metrics(_toy_board(), _toy_actuals()).set_index("position")
    assert set(table.index) == {"QB", "RB", "OVERALL"}

    # QB -- pool is all 4 board QBs (N = 26 > 4), qb4 joins with actual 0:
    #   MAE: (|300-290| + |280-310| + |260-200| + |240-0|) / 4 = 340/4 = 85
    #   spearman: proj ranks 1,2,3,4 vs actual ranks 2,1,3,4
    #             -> rho = 1 - 6*2/(4*15) = 0.8
    #   hit rate: proj top-13 = {qb1..qb4}, actual top-13 = {qb1,qb2,qb3,qb5}
    #             -> 3/13 (qb5's breakout costs the board a slot)
    #   coverage: 290 in [250,350] ok; 310 in [230,330] ok; 200 < 210 out;
    #             0 not in [190,290] out -> 2/4
    #   miss decomposition (of the 2 out-of-band misses): qb3 has actual
    #   games=17 (present in _toy_actuals -> games>0, a played-but-mis-
    #   projected miss); qb4 has no row in _toy_actuals -> actual_games_by_id
    #   defaults to 0 (bust/retirement, no survivorship) -> zero-games miss.
    #   So band_miss_zero_games=1 (qb4), band_miss_played=1 (qb3).
    qb = table.loc["QB"]
    assert qb["season_mae_topN"] == pytest.approx(85.0)
    assert qb["spearman_topN"] == pytest.approx(0.8)
    assert qb["hit_rate_starters"] == pytest.approx(3 / 13)
    assert qb["season_band_coverage"] == pytest.approx(0.5)
    assert qb["band_miss_zero_games"] == 1
    assert qb["band_miss_played"] == 1
    assert qb["n"] == 4

    # RB -- errors 40,10,10,40 -> MAE 25; order preserved -> spearman 1;
    # all 4 of top-25 finished top-25 -> 4/25; all actuals in-band -> 1.0,
    # so no misses of either kind.
    rb = table.loc["RB"]
    assert rb["season_mae_topN"] == pytest.approx(25.0)
    assert rb["spearman_topN"] == pytest.approx(1.0)
    assert rb["hit_rate_starters"] == pytest.approx(4 / 25)
    assert rb["season_band_coverage"] == pytest.approx(1.0)
    assert rb["band_miss_zero_games"] == 0
    assert rb["band_miss_played"] == 0
    assert rb["n"] == 4

    # OVERALL -- union of the two pools:
    #   MAE: (340 + 100) / 8 = 55
    #   spearman: proj ranks 1..8 vs actual ranks 2,1,4,8,3,5,6,7
    #             -> sum d^2 = 26 -> rho = 1 - 6*26/(8*63) = 29/42
    #   hit rate: (3 + 4) / (13 + 25) = 7/38
    #   coverage: (2 + 4) / 8 = 0.75
    #   miss decomposition: OVERALL is the disjoint union of the position
    #   pools, so it sums the position rows: zero_games = 1+0 = 1,
    #   played = 1+0 = 1.
    ov = table.loc["OVERALL"]
    assert ov["season_mae_topN"] == pytest.approx(55.0)
    assert ov["spearman_topN"] == pytest.approx(29 / 42)
    assert ov["hit_rate_starters"] == pytest.approx(7 / 38)
    assert ov["season_band_coverage"] == pytest.approx(0.75)
    assert ov["band_miss_zero_games"] == 1
    assert ov["band_miss_played"] == 1
    assert ov["n"] == 8


def test_pool_caps_at_two_x_replacement_rank():
    # 30 board QBs; N = 2*13 = 26. Ranks 1-26 miss by exactly 1 point,
    # ranks 27-30 miss by 100 -- if the tail leaked into the pool, MAE
    # would jump from 1.0 to ~14.2.
    board, actual_rows = [], []
    for i in range(1, 31):
        p50 = 300.0 - i
        board.append(_bp(f"qb{i:02d}", "QB", p50, p50 - 10.0, p50 + 10.0))
        miss = 1.0 if i <= 26 else 100.0
        actual_rows.append((f"qb{i:02d}", "QB", p50 - miss))
    table = board_metrics(board, _actuals(actual_rows)).set_index("position")
    assert table.loc["QB", "n"] == 26
    assert table.loc["QB", "season_mae_topN"] == pytest.approx(1.0)
    assert table.loc["QB", "spearman_topN"] == pytest.approx(1.0)   # order kept
    assert table.loc["QB", "hit_rate_starters"] == pytest.approx(1.0)
    assert table.loc["QB", "season_band_coverage"] == pytest.approx(1.0)


def test_no_band_board_gets_nan_coverage_not_crash():
    # Point-only entrants (naive last-4) produce boards with p10/p90 = None:
    # coverage must be NaN (later serialized to null), not an exception,
    # and the rank metrics must still be scored.
    board = [_bp("qb1", "QB", 300.0), _bp("qb2", "QB", 280.0)]
    actuals = _actuals([("qb1", "QB", 290.0), ("qb2", "QB", 270.0)])
    table = board_metrics(board, actuals).set_index("position")
    assert np.isnan(table.loc["QB", "season_band_coverage"])
    # No band-carrying players in the pool -> the miss decomposition is
    # equally undefined, NaN not 0 (same condition as season_band_coverage).
    assert np.isnan(table.loc["QB", "band_miss_zero_games"])
    assert np.isnan(table.loc["QB", "band_miss_played"])
    assert table.loc["QB", "season_mae_topN"] == pytest.approx(10.0)
    assert table.loc["QB", "spearman_topN"] == pytest.approx(1.0)


def test_single_player_pool_spearman_is_nan():
    board = [_bp("te1", "TE", 120.0, 100.0, 140.0)]
    actuals = _actuals([("te1", "TE", 110.0)])
    table = board_metrics(board, actuals).set_index("position")
    assert np.isnan(table.loc["TE", "spearman_topN"])      # undefined, not 1.0
    assert table.loc["TE", "season_mae_topN"] == pytest.approx(10.0)


def test_unknown_position_fails_loud():
    # v1 scope guard: QB/RB/WR/TE only -- a kicker on the board is a
    # pipeline bug upstream, not something to silently rank with a
    # default replacement rank.
    with pytest.raises(ValueError, match="K"):
        board_metrics([_bp("k1", "K", 150.0)], _actuals([("k1", "K", 140.0)]))


def test_empty_board_raises():
    with pytest.raises(ValueError, match="empty"):
        board_metrics([], _actuals([("qb1", "QB", 1.0)]))


# --------------------------------------------------- Phase A2: CLI / loop

def test_board_parser_defaults():
    args = build_parser().parse_args([])
    assert args.seasons == [2023, 2024, 2025]
    assert args.transformer_root is None
    assert str(args.out).endswith("board_backtest.json")


def test_board_parser_repeated_transformer_root():
    args = build_parser().parse_args([
        "--transformer-root", "models/transformer/v1",
        "--transformer-root", "models/transformer/v1_s43",
    ])
    assert [str(r) for r in args.transformer_root] == [
        str(Path("models/transformer/v1")), str(Path("models/transformer/v1_s43"))]


def test_board_report_provenance_and_nan_to_none():
    results = pd.DataFrame([{
        "model": "naive_last4", "board_season": 2023, "position": "OVERALL",
        "n": 50, "season_mae_topN": 40.0, "spearman_topN": 0.5,
        "hit_rate_starters": 0.6, "season_band_coverage": float("nan"),
    }])
    rep = _board_report(results, [2023], transformer_roots=None)
    assert rep["board_seasons"] == [2023]
    assert rep["scoring"] == "ppr"
    assert rep["band_construction"] == "sign_coherent_v1"
    assert rep["transformer_roots"] is None
    # NaN coverage (band-less entrant) must serialize to null, not a NaN literal
    assert rep["results"][0]["season_band_coverage"] is None
    assert json.loads(json.dumps(rep))["results"][0]["season_band_coverage"] is None


def test_board_report_records_transformer_roots():
    results = pd.DataFrame([{
        "model": "transformer", "board_season": 2023, "position": "OVERALL",
        "n": 50, "season_mae_topN": 1.0, "spearman_topN": 1.0,
        "hit_rate_starters": 1.0, "season_band_coverage": 0.8,
    }])
    rep = _board_report(results, [2023], transformer_roots=[
        Path("models/transformer/v1"), Path("models/transformer/v1_s43")])
    # forward-slash on every platform (as_posix), so a Windows-local run and a
    # Linux Actions run record identical provenance
    assert rep["transformer_roots"] == [
        "models/transformer/v1", "models/transformer/v1_s43"]


def _two_season_world():
    """A 2022 history season (the world for board 2023) plus 2023 actuals."""
    rows = []
    for wk in range(1, 7):
        rows += [
            {"player_id": "p1", "season": 2022, "week": wk, "receiving_yards": 60.0},
            {"player_id": "p2", "season": 2022, "week": wk, "position": "RB",
             "team": "BBB", "opponent_team": "AAA", "rushing_yards": 45.0},
            {"player_id": "p1", "season": 2023, "week": wk, "receiving_yards": 70.0},
            {"player_id": "p2", "season": 2023, "week": wk, "position": "RB",
             "team": "BBB", "opponent_team": "AAA", "rushing_yards": 50.0},
        ]
    return make_weekly(rows)


def _two_season_sched():
    return pd.concat([make_schedules(8, 2022), make_schedules(8, 2023)],
                     ignore_index=True)


def test_run_board_backtest_smoke_stub():
    # end-to-end loop on a tiny synthetic world with a stub entrant: proves the
    # season loop -> board -> metrics assembly runs and is shaped right (metric
    # correctness is pinned by the board_metrics tests above).
    results = run_board_backtest(
        _two_season_world(), _two_season_sched(), [2023],
        make_entrants=lambda features: [_QuantileStub()],
    )
    assert set(results["model"]) == {"stub"}
    assert set(results["board_season"]) == {2023}
    assert {"WR", "RB", "OVERALL"} <= set(results["position"])
    for col in ("season_mae_topN", "spearman_topN", "hit_rate_starters",
                "season_band_coverage"):
        assert col in results.columns


def test_run_board_backtest_rejects_seasonless_world():
    # board season with no prior data to seed from must fail loud, not silently
    # produce an empty/garbage board
    weekly = make_weekly([{"player_id": "p1", "season": 2023, "week": 1}])
    with pytest.raises(ValueError, match="prior-season"):
        run_board_backtest(weekly, _two_season_sched(), [2023],
                           make_entrants=lambda f: [_QuantileStub()])


def test_run_board_backtest_rejects_non_ppr_rules():
    # board metrics hardcode the "ppr" season_points lens; a non-PPR rules
    # arg would silently rescore actuals in a lens the board never reads --
    # must fail loud before any heavy work, not produce a mismatched report
    with pytest.raises(ValueError, match="ppr"):
        run_board_backtest(pd.DataFrame(), pd.DataFrame(), [2023],
                           make_entrants=lambda f: [], rules=STANDARD)
