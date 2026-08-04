"""Tests for the walk-forward value-curve calibration.

The two ways this could silently be wrong are leakage (fitting a season against
its own actuals) and selection (matching an ex-post sorted curve). The first is
structural and is tested here; the second is avoided by regressing at the
player's own board rank, which the pairing test pins.
"""
import numpy as np
import pytest

from ffmodel.eval.value_calibration import (
    MIN_PAIRS,
    MIN_PRIOR_SEASONS,
    apply_calibration,
    calibrate_worlds,
    draftable_pairs,
    fit_calibration,
)


def _world(season, *, slope=1.0, intercept=0.0, n=60, noise=0.0):
    """A world whose actuals are a known affine function of the projection, so
    the recovered fit has a right answer."""
    rng = np.random.default_rng(season)
    players, actual_weeks = [], {}
    for i in range(n):
        v = 200.0 - i * 2.0
        pid = f"{season}-rb{i}"
        players.append({"player_id": pid, "name": pid, "position": "RB",
                        "position_rank": i + 1, "value_points": v, "vorp": v - 100.0})
        pts = intercept + slope * v + (rng.normal(0, noise) if noise else 0.0)
        actual_weeks[pid] = {"1": pts}
    return {"season": season, "players": players, "actual_weeks": actual_weeks,
            "replacement_rank": {"QB": 13, "RB": 25, "WR": 25, "TE": 13}}


def test_pairs_are_per_player_at_his_own_board_rank():
    """Not an ex-post sorted curve. Sorting noisy outcomes descending inflates
    the spread even when the true means are flat, which would over-steepen the
    board; pairing each player's projection with his own result cannot."""
    w = _world(2021, slope=1.0)
    x, y = draftable_pairs(w)["RB"]
    assert len(x) == len(y) == 50           # 2 x replacement rank 25
    assert x[0] == pytest.approx(200.0)
    assert y[0] == pytest.approx(200.0)


def test_pool_is_capped_at_twice_replacement_rank():
    w = _world(2021, n=200)
    x, _ = draftable_pairs(w)["RB"]
    assert len(x) == 50


def test_a_board_player_who_never_played_scores_zero_not_dropped():
    """Dropping him would be survivorship bias in exactly the direction that
    flatters the board."""
    w = _world(2021)
    del w["actual_weeks"][w["players"][0]["player_id"]]
    x, y = draftable_pairs(w)["RB"]
    assert len(x) == 50
    assert y[0] == pytest.approx(0.0)


def test_fit_recovers_a_known_compression():
    """The transformer's symptom: actuals span twice the projected range."""
    fit = fit_calibration([_world(2021, slope=2.0, intercept=-50.0)])
    assert fit["RB"]["b"] == pytest.approx(2.0, abs=1e-6)
    assert fit["RB"]["a"] == pytest.approx(-50.0, abs=1e-6)
    assert fit["RB"]["n"] == 50


def test_fit_pools_every_prior_season():
    fit = fit_calibration([_world(2021, slope=2.0), _world(2022, slope=2.0)])
    assert fit["RB"]["n"] == 100
    assert fit["RB"]["b"] == pytest.approx(2.0, abs=1e-6)


def test_a_position_with_too_little_data_is_left_at_identity():
    """Better an unchanged curve than a slope invented from five points."""
    small = _world(2021, n=int(MIN_PAIRS / 2))
    fit = fit_calibration([small])
    assert fit["QB"] == {"a": 0.0, "b": 1.0, "n": 0, "r": None,
                         "identity_reason": "too few pairs"}
    assert fit["RB"]["b"] == 1.0
    assert fit["RB"]["identity_reason"] == "too few pairs"


def test_apply_stretches_gaps_by_the_slope():
    players = [{"player_id": "a", "position": "RB", "value_points": 150.0, "vorp": 50.0},
               {"player_id": "b", "position": "RB", "value_points": 130.0, "vorp": 30.0}]
    out = apply_calibration(players, {"RB": {"a": 0.0, "b": 2.0}})
    assert out[0]["value_points"] - out[1]["value_points"] == pytest.approx(40.0)
    assert out[0]["vorp"] == pytest.approx(100.0)


def test_apply_keeps_vorp_consistent_with_value_points():
    """The optimizer ranks on value_points and breaks ties on vorp. A board
    whose two value columns disagreed would rank one way and explain another."""
    players = [{"player_id": "a", "position": "RB", "value_points": 150.0, "vorp": 50.0}]
    out = apply_calibration(players, {"RB": {"a": 10.0, "b": 3.0}})
    assert out[0]["value_points"] == pytest.approx(460.0)
    assert out[0]["vorp"] == pytest.approx(150.0)


def test_apply_floors_at_zero():
    """A stretched curve can push the deep tail negative, and a negative season
    projection would subtract from a lineup total that only sums what you start."""
    players = [{"player_id": "a", "position": "RB", "value_points": 5.0, "vorp": -80.0}]
    out = apply_calibration(players, {"RB": {"a": -400.0, "b": 2.0}})
    assert out[0]["value_points"] == 0.0


def test_apply_preserves_order_within_a_position():
    players = [{"player_id": f"p{i}", "position": "RB",
                "value_points": 200.0 - 3 * i, "vorp": 100.0 - 3 * i} for i in range(20)]
    out = apply_calibration(players, {"RB": {"a": -20.0, "b": 1.7}})
    vals = [p["value_points"] for p in out]
    assert vals == sorted(vals, reverse=True)


def test_apply_leaves_players_it_cannot_value_alone():
    players = [{"player_id": "k", "position": "K", "value_points": 10.0},
               {"player_id": "x", "position": "RB", "value_points": None}]
    out = apply_calibration(players, {"RB": {"a": 0.0, "b": 2.0}})
    assert out[0]["value_points"] == 10.0
    assert out[1]["value_points"] is None


def test_calibration_never_sees_its_own_season():
    """THE leak test. 2023 is given a wildly different relationship from the
    prior seasons; if it leaked in, the recovered slope would move toward 9."""
    worlds = [_world(2021, slope=2.0), _world(2022, slope=2.0), _world(2023, slope=9.0)]
    calibrated, fits = calibrate_worlds(worlds)
    assert [w["season"] for w in calibrated] == [2023]
    assert fits[2023]["RB"]["b"] == pytest.approx(2.0, abs=1e-6)
    assert calibrated[0]["value_calibration"]["fit_on_seasons"] == [2021, 2022]


def test_seasons_without_enough_history_are_dropped_not_shipped_raw():
    """Keeping them would silently mix calibrated and uncalibrated boards into
    one reported average."""
    worlds = [_world(y, slope=2.0) for y in (2021, 2022, 2023, 2024)]
    calibrated, _ = calibrate_worlds(worlds)
    assert [w["season"] for w in calibrated] == [2023, 2024]
    assert MIN_PRIOR_SEASONS == 2


def test_each_season_is_fit_on_a_growing_window():
    worlds = [_world(y, slope=2.0) for y in (2021, 2022, 2023, 2024, 2025)]
    calibrated, _ = calibrate_worlds(worlds)
    windows = {w["season"]: w["value_calibration"]["fit_on_seasons"] for w in calibrated}
    assert windows == {2023: [2021, 2022],
                       2024: [2021, 2022, 2023],
                       2025: [2021, 2022, 2023, 2024]}


def test_calibrate_worlds_does_not_mutate_its_input():
    worlds = [_world(y, slope=2.0) for y in (2021, 2022, 2023)]
    before = worlds[-1]["players"][0]["value_points"]
    calibrate_worlds(worlds)
    assert worlds[-1]["players"][0]["value_points"] == before
