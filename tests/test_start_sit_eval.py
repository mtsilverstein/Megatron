import pandas as pd
import pytest

from ffmodel.eval.start_sit import (close_pairs, deployed_projected_points,
                                    rules_from_league_config, summarize,
                                    compare_baselines)


def test_close_pairs_are_within_week_and_position_and_score_regret():
    frame = pd.DataFrame([
        [2025, 1, "RB", "a", 12.0, 8.0],
        [2025, 1, "RB", "b", 10.0, 14.0],
        [2025, 1, "RB", "c", 7.0, 7.0],
        [2025, 1, "WR", "d", 11.0, 30.0],
        [2025, 2, "RB", "e", 11.0, 30.0],
    ], columns=["season", "week", "position", "player_id", "predicted", "actual"])
    pairs = close_pairs(frame, 3.0, min_projection=0)
    assert list(zip(pairs.chosen_player_id, pairs.other_player_id)) == [("a", "b"), ("b", "c")]
    assert pairs.regret.tolist() == [6.0, 0.0]
    assert pairs.correct.tolist() == [False, True]


def test_ties_and_summary_accuracy_contract():
    frame = pd.DataFrame([
        [2025, 1, "QB", "a", 12.0, 8.0],
        [2025, 1, "QB", "b", 12.0, 2.0],  # projection tie: no decision
        [2025, 1, "QB", "c", 11.0, 8.0],  # actual tie with a
    ], columns=["season", "week", "position", "player_id", "predicted", "actual"])
    pairs = close_pairs(frame, 2.0, min_projection=0)
    result = summarize(pairs, 2.0, min_projection=0)["overall"]
    assert result == {"pairs": 2, "decided_pairs": 1, "actual_ties": 1,
                      "choice_accuracy": 0.0, "mean_regret_points": 3.0,
                      "total_regret_points": 6.0, "p90_regret_points": 5.4,
                      "max_regret_points": 6.0}


def test_gabagool_config_drives_scoring_rules():
    rules = rules_from_league_config("configs/leagues/gabagool.yaml")
    assert rules.pass_td == 6.0
    assert rules.pass_int_td == -3.0
    assert rules.reception == 1.0
    assert rules.interception == -2.0


def test_rejects_nonpositive_gap():
    with pytest.raises(ValueError, match="positive"):
        close_pairs(pd.DataFrame(), 0)


def test_min_projection_removes_broad_tail_pairs():
    frame = pd.DataFrame([
        [2025, 1, "TE", "a", 6.0, 9.0],
        [2025, 1, "TE", "b", 4.5, 10.0],
    ], columns=["season", "week", "position", "player_id", "predicted", "actual"])
    assert close_pairs(frame, 3.0, min_projection=5.0).empty


def test_projected_points_include_deployed_pick_six_expected_cost():
    index = pd.Index([7])
    stats = pd.DataFrame({"passing_interceptions": [1.0]}, index=index)
    frames = {"p10": stats.copy(), "p50": stats.copy(), "p90": stats.copy()}
    rules = rules_from_league_config("configs/leagues/gabagool.yaml")
    points = deployed_projected_points(
        frames, pd.Series(["QB"], index=index), rules, pick_six_rate=.1)
    # -2 for the interception and -0.3 for its expected pick-six cost.
    assert points.iloc[0] == pytest.approx(-2.3)


def _comparison_inputs():
    scored = pd.DataFrame([
        [2025, 1, "RB", "a", 12., 8.],
        [2025, 1, "RB", "b", 10., 14.],
    ], columns=["season", "week", "position", "player_id", "predicted", "actual"])
    source = pd.DataFrame([
        [2025, 1, "RB", "a", "2025-09-04T10:00:00Z", "2025-09-05T00:00:00Z", 2., 11.],
        [2025, 1, "RB", "b", "2025-09-04T10:00:00Z", "2025-09-05T00:00:00Z", 1., 9.],
    ], columns=["season", "week", "position", "player_id", "snapshot_at", "kickoff_at", "ecr", "projected_fpts"])
    return close_pairs(scored), source


def test_baseline_directions_and_identical_pair_cohort():
    pairs, source = _comparison_inputs()
    result = compare_baselines(pairs, source)["baselines"]
    assert result["ecr"]["model_accuracy_same_pairs"] == 0
    assert result["ecr"]["baseline_accuracy"] == 1
    assert result["ecr"]["baseline_mean_regret"] == 0
    assert result["ecr"]["model_mean_regret_same_pairs"] == 6
    assert "projected_fpts" not in result
    assert compare_baselines(pairs, source.drop(columns="projected_fpts"))["baselines"] == result


@pytest.mark.parametrize("timestamp", ["bad", "2025-09-04", "2025-09-04T10:00:00", "2025-09-05T00:00:00Z", "2025-09-06T00:00:00Z", "2025-08-01T00:00:00Z"])
def test_baseline_rejects_late_stale_or_missing_provenance(timestamp):
    pairs, source = _comparison_inputs()
    source.loc[0, "snapshot_at"] = timestamp
    result = compare_baselines(pairs, source)
    assert result["rejected_snapshot_rows"] == 1
    assert result["baselines"]["ecr"]["missing_pairs"] == 1
    assert result["baselines"]["ecr"]["model_accuracy_same_pairs"] is None


def test_baseline_ties_missing_metrics_and_duplicate_identity():
    pairs, source = _comparison_inputs()
    source["ecr"] = 1.
    source.loc[0, "projected_fpts"] = float("nan")
    result = compare_baselines(pairs, source)["baselines"]
    assert result["ecr"]["baseline_ties"] == 1
    assert result["ecr"]["comparable_pairs"] == 0
    assert "projected_fpts" not in result
    with pytest.raises(ValueError, match="duplicate"):
        compare_baselines(pairs, pd.concat([source, source]))


def test_empty_baseline_comparison_serializes_without_nan():
    import json
    pairs, source = _comparison_inputs()
    result = compare_baselines(pairs.iloc[:0], source.iloc[:0])
    json.dumps(result, allow_nan=False)
    assert result["pair_universe"] == 0


def test_individual_game_cutoffs_cannot_replace_first_week_kickoff():
    pairs, source = _comparison_inputs()
    source.loc[0, "kickoff_at"] = "2025-09-07T17:00:00Z"
    with pytest.raises(ValueError, match="first-week kickoff"):
        compare_baselines(pairs, source)
