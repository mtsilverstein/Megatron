import numpy as np
import pandas as pd
import pytest

from ffmodel.model.rookie import (
    assign_bucket, fit_rookie_cohorts, merge_buckets, rookie_projection,
)
from ffmodel.scoring import PREDICTED_STATS


def test_assign_bucket_boundaries():
    assert assign_bucket(1, 1) == "top12"
    assert assign_bucket(1, 12) == "top12"
    assert assign_bucket(1, 13) == "r1"
    assert assign_bucket(2, 40) == "r2"
    assert assign_bucket(3, 70) == "r3"
    assert assign_bucket(4, 110) == "day3"
    assert assign_bucket(7, 250) == "day3"


def test_merge_buckets_identity_when_all_thick():
    counts = {"top12": 30, "r1": 30, "r2": 30, "r3": 30, "day3": 100}
    m = merge_buckets(counts)
    assert m == {b: b for b in ["top12", "r1", "r2", "r3", "day3"]}


def test_merge_buckets_thin_buckets_absorb_toward_day3():
    # QB-like counts: walk accumulates top12(8)+r1(6)+r2(10)=24 < 25, +r3(9)=33
    counts = {"top12": 8, "r1": 6, "r2": 10, "r3": 9, "day3": 40}
    m = merge_buckets(counts)
    assert m["top12"] == m["r1"] == m["r2"] == m["r3"] == "top12+r1+r2+r3"
    assert m["day3"] == "day3"


def test_merge_buckets_everything_thin_collapses_to_one():
    m = merge_buckets({"top12": 2, "r1": 1, "r2": 3, "r3": 2, "day3": 5})
    assert len(set(m.values())) == 1


def test_merge_buckets_min_n_override_forces_position_only():
    counts = {"top12": 30, "r1": 30, "r2": 30, "r3": 30, "day3": 100}
    m = merge_buckets(counts, min_n=10**9)
    assert len(set(m.values())) == 1   # the STOP-rule fallback shape


def _weekly(rows):
    base = {s: 0.0 for s in PREDICTED_STATS}
    return pd.DataFrame([{**base, "player_id": "x", "season": 2020, "week": 1,
                          **r} for r in rows])


def _picks(rows):
    base = {"season": 2020, "round": 1, "pick": 1, "team": "KC",
            "gsis_id": "00-0", "player_name": "P", "position": "RB",
            "age": 22.0, "college": "State"}
    return pd.DataFrame([{**base, **r} for r in rows])


def test_fit_walk_forward_excludes_future_classes():
    # A monster 2024 rookie must NOT influence cohorts fit through 2023.
    picks = _picks([
        {"season": 2023, "gsis_id": "00-A", "pick": 5},
        {"season": 2024, "gsis_id": "00-B", "pick": 6},
    ])
    weekly = _weekly([
        {"player_id": "00-A", "season": 2023, "week": 1, "rushing_yards": 50.0},
        {"player_id": "00-B", "season": 2024, "week": 1, "rushing_yards": 500.0},
    ])
    cohorts = fit_rookie_cohorts(weekly, picks, through_season=2023)
    label = cohorts["positions"]["RB"]["merge_map"]["top12"]
    c = cohorts["positions"]["RB"]["cohorts"][label]
    assert c["n_players"] == 1
    assert c["stats"]["p50"]["rushing_yards"] == pytest.approx(50.0)


def test_fit_zero_inflated_games_distribution():
    # Two drafted RBs: one plays 2 rookie-year weeks, one never plays.
    picks = _picks([
        {"season": 2020, "gsis_id": "00-A", "pick": 5},
        {"season": 2020, "gsis_id": "00-B", "pick": 6},
    ])
    weekly = _weekly([
        {"player_id": "00-A", "season": 2020, "week": 1, "rushing_yards": 60.0},
        {"player_id": "00-A", "season": 2020, "week": 2, "rushing_yards": 80.0},
        # 00-B has NO rows: the zero-games outcome.
        # a 2021 week for 00-A must not count toward his ROOKIE season:
        {"player_id": "00-A", "season": 2021, "week": 1, "rushing_yards": 999.0},
    ])
    cohorts = fit_rookie_cohorts(weekly, picks, through_season=2020)
    label = cohorts["positions"]["RB"]["merge_map"]["top12"]
    c = cohorts["positions"]["RB"]["cohorts"][label]
    assert c["games_probs"][0] == pytest.approx(0.5)   # the never-played rookie
    assert c["games_probs"][2] == pytest.approx(0.5)
    assert c["n_weeks"] == 2                            # 2021 week excluded
    assert c["stats"]["p50"]["rushing_yards"] == pytest.approx(70.0)


def test_fit_quantiles_across_playing_weeks():
    picks = _picks([{"season": 2020, "gsis_id": "00-A", "pick": 3}])
    weekly = _weekly([
        {"player_id": "00-A", "season": 2020, "week": w,
         "receiving_yards": float(v)}
        for w, v in enumerate([0, 25, 50, 75, 100], start=1)
    ])
    cohorts = fit_rookie_cohorts(weekly, picks, through_season=2020)
    label = cohorts["positions"]["RB"]["merge_map"]["top12"]
    stats = cohorts["positions"]["RB"]["cohorts"][label]["stats"]
    assert stats["p50"]["receiving_yards"] == pytest.approx(50.0)
    assert stats["p10"]["receiving_yards"] == pytest.approx(10.0)
    assert stats["p90"]["receiving_yards"] == pytest.approx(90.0)


def test_projection_returns_scorable_frames_and_games():
    picks = _picks([{"season": 2020, "gsis_id": "00-A", "pick": 3}])
    weekly = _weekly([{"player_id": "00-A", "season": 2020, "week": 1,
                       "rushing_yards": 50.0}])
    cohorts = fit_rookie_cohorts(weekly, picks, through_season=2020)
    frames, games_probs = rookie_projection(cohorts, "RB", 1, 5)
    assert list(frames["p50"].columns) == PREDICTED_STATS
    assert frames["p50"]["rushing_yards"].iloc[0] == pytest.approx(50.0)
    assert games_probs.shape == (19,)
    assert games_probs.sum() == pytest.approx(1.0)


def test_projection_unknown_position_fails_loud():
    picks = _picks([{"season": 2020, "gsis_id": "00-A"}])
    weekly = _weekly([{"player_id": "00-A", "season": 2020, "week": 1}])
    cohorts = fit_rookie_cohorts(weekly, picks, through_season=2020)
    with pytest.raises(ValueError, match="position"):
        rookie_projection(cohorts, "K", 1, 5)


def test_fit_empty_history_fails_loud():
    with pytest.raises(ValueError, match="no draft classes"):
        fit_rookie_cohorts(_weekly([]), _picks([{"season": 2024}]),
                           through_season=2020)
