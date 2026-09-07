import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.scoring import LEAGUE, PPR, PREDICTED_STATS, fantasy_points_quantiles
from ffmodel.site.pick_sixes import add_pick_six_expectation, load_pick_six_prior


def frames(low=0.0, mid=1.0, high=3.0):
    return {q: pd.DataFrame({"passing_yards": [250., 0.],
                             "passing_interceptions": [n, n]}, index=[7, 9])
            for q, n in zip(("p10", "p50", "p90"), (low, mid, high))}


def test_expected_cost_sign_no_double_int_penalty_and_no_mutation():
    raw = frames(1, 1, 1)
    enriched = add_pick_six_expectation(raw, pd.Series(["QB", "WR"], index=[7, 9]), .1)
    before = fantasy_points_quantiles(raw, LEAGUE)
    after = fantasy_points_quantiles(enriched, LEAGUE)
    for q in raw:
        assert "passing_pick_sixes" not in raw[q]
        assert after[q].loc[7] == pytest.approx(before[q].loc[7] - .3)
        assert after[q].loc[9] == before[q].loc[9]
        pd.testing.assert_series_equal(fantasy_points_quantiles(raw, PPR)[q],
                                       fantasy_points_quantiles(enriched, PPR)[q])
    assert len(PREDICTED_STATS) == 11


def test_zero_median_still_has_positive_volume_and_exact_zero_crossing():
    raw = frames(0, 0, 2)
    got = add_pick_six_expectation(raw, pd.Series("QB", index=[7, 9]), .1)
    # Integral: .4*(0+2)/2 + .1*(2+4)/2 = .7 INTs.
    assert got["p50"].loc[7, "passing_pick_sixes"] == pytest.approx(.07)
    raw = frames(-1, 1, 1)
    got = add_pick_six_expectation(raw, pd.Series("QB", index=[7, 9]), .1)
    # Crossing segment is a triangle of width .2, height 1; upper area .5.
    assert got["p50"].loc[7, "passing_pick_sixes"] == pytest.approx(.06)


def test_point_only_and_zero_rate():
    raw = {"p10": None, "p50": frames()["p50"], "p90": None}
    positions = pd.Series("QB", index=[7, 9])
    got = add_pick_six_expectation(raw, positions, .1)
    assert got["p10"] is None
    assert got["p50"].loc[7, "passing_pick_sixes"] == pytest.approx(.1)
    assert add_pick_six_expectation(raw, positions, None) is raw
    assert (add_pick_six_expectation(raw, positions, 0)["p50"].passing_pick_sixes == 0).all()


@pytest.mark.parametrize("rate", [-1, 1.1, float("nan"), float("inf")])
def test_invalid_rate_fails(rate):
    with pytest.raises(ValueError):
        add_pick_six_expectation(frames(), pd.Series("QB", index=[7, 9]), rate)


def test_bad_frames_fail_closed():
    positions = pd.Series("QB", index=[7, 9])
    with pytest.raises(ValueError, match="index mismatch"):
        add_pick_six_expectation(frames(), positions.reset_index(drop=True), .1)
    with pytest.raises(ValueError, match="unordered"):
        add_pick_six_expectation(frames(2, 1, 3), positions, .1)
    raw = frames()
    raw["p50"]["passing_interceptions"] = np.nan
    with pytest.raises(ValueError, match="nonfinite"):
        add_pick_six_expectation(raw, positions, .1)
    raw = frames()
    raw["p50"]["passing_pick_sixes"] = 1
    with pytest.raises(ValueError, match="overwrite"):
        add_pick_six_expectation(raw, positions, .1)


def test_prior_cutoff_and_invalid_counts(tmp_path):
    path = tmp_path / "prior.json"
    snapshot = {"source": "fixture", "seasons": [
        {"season": 2023, "interceptions": 100, "pick_sixes": 10},
        {"season": 2024, "interceptions": 200, "pick_sixes": 40}]}
    path.write_text(json.dumps(snapshot))
    assert load_pick_six_prior(2024, path)["rate"] == .1
    assert load_pick_six_prior(2025, path)["rate"] == pytest.approx(50 / 300)
    with pytest.raises(ValueError, match="no completed"):
        load_pick_six_prior(2023, path)
    snapshot["seasons"][0]["pick_sixes"] = 101
    path.write_text(json.dumps(snapshot))
    with pytest.raises(ValueError, match="invalid observed"):
        load_pick_six_prior(2024, path)


class IntStub:
    name = "pick-six-test"

    def fit(self, train):
        pass

    def predict_quantiles(self, future):
        base = pd.DataFrame(0., index=future.index, columns=PREDICTED_STATS)
        base["passing_yards"] = 250.
        base["passing_interceptions"] = 1.
        return {q: base.copy() for q in ("p10", "p50", "p90")}


def test_weekly_and_season_generation_apply_same_expected_cost():
    from tests.test_future import _history, _sched_with_future
    from ffmodel.data.future import build_future_features
    from ffmodel.site.weekly import build_weekly_projections
    from ffmodel.site.draft import build_draft_board
    weekly = _history().assign(position="QB")
    sched = _sched_with_future()
    future = build_future_features(weekly, sched, 2023, 7)
    prior = {"rate": .1}
    old = build_weekly_projections(future, IntStub(), 2023, 7, "test")
    new = build_weekly_projections(future, IntStub(), 2023, 7, "test", pick_six_prior=prior)
    for a, b in zip(old["players"], new["players"]):
        assert b["points"]["league"]["p50"] == pytest.approx(a["points"]["league"]["p50"] - .3)
        assert b["points"]["ppr"] == a["points"]["ppr"]
    league = {"unprojected_scoring": {"pass_int_td": -3, "pass_2pt": 2}}
    old = build_draft_board(weekly, sched, IntStub(), 2023, "test", weeks=[7, 8])
    new = build_draft_board(weekly, sched, IntStub(), 2023, "test", weeks=[7, 8],
                            pick_six_prior=prior, league=league)
    assert new["pick_six_forecast"] == prior
    assert "pass_int_td" not in new["league"]["unprojected_scoring"]
    assert "pass_int_td" in league["unprojected_scoring"]
    for a, b in zip(old["players"], new["players"]):
        for q in ("p10", "p50", "p90"):
            assert b["season_points"]["league"][q] == pytest.approx(a["season_points"]["league"][q] - .6)
        assert b["season_points"]["ppr"] == a["season_points"]["ppr"]
