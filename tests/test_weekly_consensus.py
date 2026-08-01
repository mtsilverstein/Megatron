"""Offline unit tests for the weekly expert-consensus driver.

NO NETWORK. Every frame here is synthetic and every collaborator that could
reach nflverse/FantasyPros (`pull_weekly`, `pull_rankings`,
`pull_player_ids`, `TransformerPredictor`) is deliberately absent from these
paths -- `collect_cells` takes the model as a callable and the rankings and
crosswalk as frames precisely so the leak-prone orchestration can be tested
without a socket. The artifact-generating run is the CLI, invoked by hand.
"""
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ffmodel.scoring import PREDICTED_STATS

# --- synthetic fixtures -----------------------------------------------------


def _schedules(season=2024, weeks=(1, 2), first_days=("2024-09-05", "2024-09-12")):
    """Two games a week; the FIRST is the leak boundary, the second is later."""
    rows = []
    for week, day in zip(weeks, first_days):
        first = pd.Timestamp(day)
        rows.append({"season": season, "week": week, "gameday": str(first.date()),
                     "home_team": "AAA", "away_team": "BBB"})
        rows.append({"season": season, "week": week,
                     "gameday": str((first + pd.Timedelta(days=3)).date()),
                     "home_team": "CCC", "away_team": "DDD"})
    return pd.DataFrame(rows)


def _features(season=2024, weeks=(1, 2), n=8, prior_seasons=(2023,)):
    """Feature-shaped frame: one row per player-week that was PLAYED.

    `receptions` carries the whole signal (1 PPR point each) so expected
    points are trivially readable in the tests.
    """
    rows = []
    for s in list(prior_seasons) + [season]:
        for week in weeks:
            for i in range(n):
                row = {c: 0.0 for c in PREDICTED_STATS}
                row["receptions"] = float(n - i)          # p1 best ... pN worst
                rows.append({"player_id": f"p{i}", "position": "RB",
                             "season": s, "week": week, **row})
    return pd.DataFrame(rows)


def _rankings(dates_ecr):
    """Weekly consensus frame in the shape `normalize_weekly_rankings` emits.

    `dates_ecr`: {scrape_date: {fp_id: ecr}}.
    """
    rows = []
    for date, by_id in dates_ecr.items():
        for fp_id, ecr in by_id.items():
            rows.append({"fp_id": fp_id, "player": f"Player {fp_id}", "pos": "RB",
                         "team": "AAA", "ecr": float(ecr), "sd": 1.0,
                         "mergename": f"player {fp_id}",
                         "scrape_date": pd.Timestamp(date)})
    return pd.DataFrame(rows)


def _crosswalk(n=8):
    return pd.DataFrame({"fantasypros_id": [f"p{i}" for i in range(n)],
                         "gsis_id": [f"p{i}" for i in range(n)],
                         "merge_name": [f"player p{i}" for i in range(n)],
                         "position": ["RB"] * n})


def _perfect_predictor(features):
    """Ranks exactly as reality does (points == actual)."""
    from ffmodel.scoring import PPR, fantasy_points

    def predict(season, train, test):
        return fantasy_points(test[PREDICTED_STATS], PPR)

    return predict


def _inverted_predictor(features):
    from ffmodel.scoring import PPR, fantasy_points

    def predict(season, train, test):
        return -fantasy_points(test[PREDICTED_STATS], PPR)

    return predict


# --- weekly_kickoffs: the per-week leak boundary ----------------------------


def test_weekly_kickoff_is_the_first_game_of_the_week():
    """Not each player's own game: a ranking published after Thursday night
    would otherwise be allowed to inform Sunday's players."""
    from ffmodel.eval.weekly_consensus import weekly_kickoffs

    kicks = weekly_kickoffs(_schedules(), 2024)
    assert kicks == {1: pd.Timestamp("2024-09-05"), 2: pd.Timestamp("2024-09-12")}


def test_weekly_kickoffs_honors_game_type_when_present():
    sched = _schedules()
    sched["game_type"] = "REG"
    pre = sched.iloc[[0]].copy()
    pre["gameday"] = "2024-08-10"
    pre["game_type"] = "PRE"
    from ffmodel.eval.weekly_consensus import weekly_kickoffs

    kicks = weekly_kickoffs(pd.concat([pre, sched], ignore_index=True), 2024)
    assert kicks[1] == pd.Timestamp("2024-09-05")


def test_weekly_kickoffs_raises_for_a_season_with_no_games():
    from ffmodel.eval.weekly_consensus import weekly_kickoffs

    with pytest.raises(ValueError, match="no REG games"):
        weekly_kickoffs(_schedules(), 1999)


# --- week_cell: the like-for-like, conditional-on-played pool ----------------


def test_week_cell_is_the_intersection_of_ranked_and_played():
    """Both entrants must rank an IDENTICAL set. A ranked player who did not
    play has no row in the weekly frame (that IS the played condition), and a
    player who played but was unranked cannot be scored against consensus."""
    from ffmodel.eval.weekly_consensus import week_cell

    played = pd.DataFrame({"player_id": ["a", "b", "unranked"],
                           "position": "RB", "our_pts": [3.0, 2.0, 1.0],
                           "actual": [30.0, 20.0, 10.0]})
    consensus = pd.DataFrame({"player_id": ["a", "b", "did_not_play"],
                              "ecr": [1.0, 2.0, 3.0]})
    cell = week_cell(played, consensus)
    assert sorted(cell["player_id"]) == ["a", "b"]
    assert list(cell.columns) == ["player_id", "position", "our_pts", "ecr", "actual"]


def test_week_cell_never_double_counts_a_player():
    from ffmodel.eval.weekly_consensus import week_cell

    played = pd.DataFrame({"player_id": ["a"], "position": ["RB"],
                           "our_pts": [3.0], "actual": [30.0]})
    consensus = pd.DataFrame({"player_id": ["a", "a"], "ecr": [1.0, 9.0]})
    assert len(week_cell(played, consensus)) == 1


# --- collect_cells: leak safety end to end ----------------------------------


def test_collect_cells_uses_the_latest_pre_kickoff_scrape_not_a_later_one():
    """The post-kickoff scrape ranks players PERFECTLY (it has seen the
    results). If it were ever used, consensus would score 1.0; the pre-kickoff
    scrape is deliberately inverted, so the measured value proves which one
    the driver actually consumed."""
    from ffmodel.eval.weekly_consensus import collect_cells

    features = _features()
    good_order = {f"p{i}": i + 1 for i in range(8)}          # matches reality
    bad_order = {f"p{i}": 8 - i for i in range(8)}           # reversed
    rankings = _rankings({
        "2024-09-02": bad_order,                             # legal (pre-kickoff)
        "2024-09-06": good_order,                            # AFTER week-1 kickoff
        "2024-09-09": bad_order,                             # legal for week 2
    })
    scored, prov = collect_cells(features, _schedules(), rankings, _crosswalk(),
                                 [2024], _perfect_predictor(features))
    week1 = scored[scored["week"] == 1].iloc[0]
    assert week1["sp_ours"] == pytest.approx(1.0)
    assert week1["sp_con"] == pytest.approx(-1.0)            # the reversed, legal scrape
    assert prov["2024"]["weeks"]["1"]["snapshot"] == "2024-09-02"


def test_collect_cells_skips_a_week_whose_only_scrape_is_post_kickoff():
    from ffmodel.eval.weekly_consensus import collect_cells

    features = _features()
    rankings = _rankings({"2024-09-06": {f"p{i}": i + 1 for i in range(8)},
                          "2024-09-10": {f"p{i}": i + 1 for i in range(8)}})
    scored, prov = collect_cells(features, _schedules(), rankings, _crosswalk(),
                                 [2024], _perfect_predictor(features))
    assert list(scored["week"]) == [2]
    skipped = prov["2024"]["weeks_skipped"]
    assert [s["week"] for s in skipped] == [1]
    assert "no consensus scrape" in skipped[0]["reason"]


def test_collect_cells_skips_a_week_whose_only_scrape_is_stale():
    from ffmodel.eval.weekly_consensus import collect_cells

    features = _features()
    rankings = _rankings({"2024-08-01": {f"p{i}": i + 1 for i in range(8)},
                          "2024-09-09": {f"p{i}": i + 1 for i in range(8)}})
    scored, prov = collect_cells(features, _schedules(), rankings, _crosswalk(),
                                 [2024], _perfect_predictor(features))
    assert list(scored["week"]) == [2]
    assert prov["2024"]["weeks_skipped"][0]["week"] == 1


def test_collect_cells_trains_only_on_prior_seasons():
    """walk_forward: the `train` frame handed to the model must never contain
    the test season."""
    from ffmodel.eval.weekly_consensus import collect_cells

    features = _features()
    seen = {}

    def spy(season, train, test):
        seen[season] = (sorted(train["season"].unique()),
                        sorted(test["season"].unique()))
        from ffmodel.scoring import PPR, fantasy_points
        return fantasy_points(test[PREDICTED_STATS], PPR)

    rankings = _rankings({"2024-09-02": {f"p{i}": i + 1 for i in range(8)},
                          "2024-09-09": {f"p{i}": i + 1 for i in range(8)}})
    collect_cells(features, _schedules(), rankings, _crosswalk(), [2024], spy)
    assert seen[2024] == ([2023], [2024])


def test_collect_cells_raises_when_nothing_is_scorable():
    from ffmodel.eval.weekly_consensus import collect_cells

    features = _features()
    rankings = _rankings({"2024-09-20": {f"p{i}": i + 1 for i in range(8)}})
    with pytest.raises(ValueError, match="no scorable"):
        collect_cells(features, _schedules(), rankings, _crosswalk(), [2024],
                      _perfect_predictor(features))


def test_collect_cells_skips_thin_cells_via_min_cell():
    from ffmodel.eval.weekly_consensus import collect_cells

    features = _features(n=3)
    rankings = _rankings({"2024-09-02": {f"p{i}": i + 1 for i in range(3)},
                          "2024-09-09": {f"p{i}": i + 1 for i in range(3)}})
    with pytest.raises(ValueError, match="no scorable"):
        collect_cells(features, _schedules(), rankings, _crosswalk(3), [2024],
                      _perfect_predictor(features))


# --- pooling and the paired interval ----------------------------------------


def _cells(deltas, seasons=None, n=10, position="RB"):
    deltas = list(deltas)
    seasons = seasons or [2023] * len(deltas)
    return pd.DataFrame({
        "season": seasons, "week": list(range(1, len(deltas) + 1)),
        "position": position, "n": n,
        "sp_ours": [0.6 + d for d in deltas], "sp_con": 0.6,
        "hit_ours": 2, "hit_con": 1, "slots": 4,
    })


def test_pooled_stats_orientation_and_weighting():
    """Positive delta == WE rank better. Cells are equally weighted whatever
    their player count -- a 40-player cell must not outweigh a 6-player one."""
    from ffmodel.eval.weekly_consensus import pooled_stats

    small = _cells([0.10] * 5, n=6)
    big = _cells([-0.10] * 5, n=60)
    stats = pooled_stats(pd.concat([small, big], ignore_index=True))
    assert stats["delta"] == pytest.approx(0.0, abs=1e-9)
    assert stats["cells"] == 10
    assert stats["cells_won_pct"] == pytest.approx(50.0)


def test_pooled_stats_interval_is_deterministic_and_brackets_a_real_effect():
    from ffmodel.eval.weekly_consensus import pooled_stats

    rng = np.random.default_rng(0)
    cells = _cells(0.05 + rng.normal(0, 0.01, 60))
    a = pooled_stats(cells)
    b = pooled_stats(cells)
    assert a["paired_bootstrap_ci95"] == b["paired_bootstrap_ci95"]
    lo, hi = a["paired_bootstrap_ci95"]
    assert lo > 0 and a["ci_excludes_zero"] is True
    assert lo <= a["delta"] <= hi


def test_season_cluster_interval_is_null_on_a_single_season_slice():
    """A one-cluster bootstrap can only resample that cluster, so the interval
    collapses to a point and would read as 'excludes zero' for any nonzero
    delta. Per-season rows must report None, not a fake significant gap."""
    from ffmodel.eval.weekly_consensus import pooled_stats

    one = pooled_stats(_cells([0.05] * 8, seasons=[2023] * 8))
    assert one["season_cluster_ci95"] is None
    assert one["season_cluster_excludes_zero"] is None

    two = pooled_stats(_cells([0.05] * 8, seasons=[2023] * 4 + [2024] * 4))
    assert two["season_cluster_ci95"] is not None


def test_pooled_stats_reports_a_tie_as_a_tie():
    from ffmodel.eval.weekly_consensus import pooled_stats

    rng = np.random.default_rng(1)
    cells = _cells(rng.normal(0, 0.05, 60))
    stats = pooled_stats(cells)
    assert stats["ci_excludes_zero"] is False


def test_per_position_rows_are_in_fixed_order():
    from ffmodel.eval.weekly_consensus import per_position

    cells = pd.concat([_cells([0.1] * 5, position=p) for p in ("WR", "QB", "RB")],
                      ignore_index=True)
    assert [r["position"] for r in per_position(cells)] == ["QB", "RB", "WR"]


# --- the honesty machinery --------------------------------------------------


def test_compare_to_documented_accepts_a_faithful_reproduction():
    from ffmodel.eval.weekly_consensus import compare_to_documented

    overall = {"sp_ours": 0.5942, "sp_consensus": 0.5951, "delta": -0.0009,
               "ci_excludes_zero": False}
    out = compare_to_documented(overall, [])
    assert out["reproduces"] is True
    assert out["point_estimates_within_tolerance"] is True


def test_compare_to_documented_rejects_drifted_point_estimates():
    """A materially different number is a FINDING, and the verdict must say
    so rather than quietly rounding toward the published prose."""
    from ffmodel.eval.weekly_consensus import compare_to_documented

    overall = {"sp_ours": 0.52, "sp_consensus": 0.61, "delta": -0.09,
               "ci_excludes_zero": True}
    out = compare_to_documented(overall, [])
    assert out["reproduces"] is False
    assert out["point_estimates_within_tolerance"] is False
    assert out["measured_minus_documented"]["sp_ours"] == pytest.approx(-0.074)


def test_compare_to_documented_rejects_matching_points_with_a_significant_gap():
    """'Statistical tie' is the claim. Matching the point estimates while the
    interval now excludes zero does NOT reproduce it."""
    from ffmodel.eval.weekly_consensus import compare_to_documented

    overall = {"sp_ours": 0.5940, "sp_consensus": 0.5958, "delta": -0.0018,
               "ci_excludes_zero": True}
    out = compare_to_documented(overall, [])
    assert out["point_estimates_within_tolerance"] is True
    assert out["tie_claim_holds"] is False
    assert out["reproduces"] is False


def test_documented_per_position_reference_is_labelled_with_its_own_seasons():
    """The site quotes QB/TE/WR deltas next to the 2023-25 tie, but they come
    from the 2020-22 out-of-sample run. The artifact must say so, or a reader
    will compare two different samples believing they are one."""
    from ffmodel.eval.weekly_consensus import compare_to_documented

    out = compare_to_documented(
        {"sp_ours": 0.59, "sp_consensus": 0.59, "delta": 0.0,
         "ci_excludes_zero": False},
        [{"position": "QB", "delta": -0.02}])
    ref = out["per_position_reference"]
    assert ref["seasons"] == [2020, 2021, 2022]
    assert ref["measured_deltas_this_run"] == {"QB": -0.02}
    assert "not 2023-25" in ref["note"].lower() or "NOT 2023-25" in ref["note"]


def test_summary_narrates_the_actual_numbers():
    from ffmodel.eval.weekly_consensus import build_summary, compare_to_documented

    overall = {"sp_ours": 0.5942, "sp_consensus": 0.5951, "delta": -0.0009,
               "cells": 150, "ci_excludes_zero": False,
               "paired_bootstrap_ci95": [-0.012, 0.010]}
    positions = [{"position": "RB", "delta": 0.0257},
                 {"position": "QB", "delta": -0.0631}]
    text = build_summary(overall, positions, compare_to_documented(overall, positions))
    assert text.startswith("REPRODUCES")
    assert "0.5942" in text and "0.5951" in text and "includes zero" in text
    assert "RB +0.0257" in text and "QB -0.0631" in text


def test_summary_states_the_discrepancy_when_it_does_not_reproduce():
    from ffmodel.eval.weekly_consensus import build_summary, compare_to_documented

    overall = {"sp_ours": 0.40, "sp_consensus": 0.62, "delta": -0.22,
               "cells": 150, "ci_excludes_zero": True,
               "paired_bootstrap_ci95": [-0.25, -0.19]}
    comparison = compare_to_documented(overall, [])
    text = build_summary(overall, [], comparison)
    assert text.startswith("DOES NOT REPRODUCE")
    assert "EXCLUDES zero" in text
    assert "-0.1940" in text          # measured minus documented, ours


# --- the sign-safety contract this module inherits --------------------------


def test_build_report_refuses_an_inverted_model():
    """assert_model_sane must fire BEFORE any number reaches the artifact --
    the scratchpad version of this analysis shipped a sign bug."""
    from ffmodel.eval.weekly_consensus import build_report

    cells = _cells([0.0] * 5)
    cells["sp_ours"] = -0.5
    with pytest.raises(AssertionError, match="negatively correlated"):
        build_report(cells, {}, [2024], [Path("models/transformer/v1")], {})


def test_build_report_shape_and_provenance():
    from ffmodel.eval.weekly_consensus import build_report

    report = build_report(_cells([0.0] * 6), {"2024": {"weeks_used": [1]}},
                          [2024], [Path("models/transformer/v1")],
                          {"first_season": 2012})
    for key in ("verdict", "summary", "overall", "per_position", "per_season",
                "leak_safety", "conditioning", "documented_comparison",
                "measurement_not_a_gate", "provenance", "cells"):
        assert key in report, key
    assert report["design"]["test_seasons"] == [2024]
    assert report["artifacts_evaluated"]["folds_used"] == ["through2023"]
    assert report["verdict"] in ("REPRODUCES", "DOES NOT REPRODUCE")


def test_module_never_calls_spearmanr_directly():
    """weekly_rankings.py owns the single sign-safe conversion point. A direct
    scipy call here would reopen the exact hole that module was written to
    close, so the contract is enforced mechanically, not by convention.

    Parsed rather than grepped so the module docstring can keep explaining the
    contract in prose without tripping its own test."""
    import ast

    import ffmodel.eval.weekly_consensus as mod

    tree = ast.parse(Path(mod.__file__).read_text(encoding="utf-8"))
    imported, called = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
        elif isinstance(node, ast.Import):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.Call):
            name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            if name:
                called.add(name)
    assert not any(m.startswith("scipy") for m in imported), sorted(imported)
    assert "spearmanr" not in called
