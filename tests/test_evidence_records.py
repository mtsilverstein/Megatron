import pytest

from ffmodel.site.evidence_records import build_evaluation
from ffmodel.site.neutral import BatchContext
CTX = BatchContext(2026, 5, "2026-wk4", "2026-10-06T00:00:00+00:00", "x")

def recs():
    return {r["id"]: r for r in build_evaluation(CTX)["records"]}

def test_ros_record_excludes_pick_six():
    ros = recs()["ros_mae_gabagool"]
    assert {"key": "pass_int_td", "reason": "pick-six actuals unavailable"} in ros["omitted"]
    assert '"passing_pick_sixes"' not in ros["effective_scoring"]
    assert ros["source"]["path"].startswith("models/diagnostics/") and len(ros["source"]["sha256"]) == 64

def test_close_call_scoring_translated_and_historical():
    cc = recs()["start_sit_close_calls"]
    assert '"passing_interceptions"' in cc["prediction_scoring"] and '"receptions"' in cc["prediction_scoring"]
    assert cc["method"] is None

def test_header_and_no_borrowing():
    out = build_evaluation(CTX)
    assert out["batch_id"] == "x" and out["kind"] == "neutral_evaluation"
    assert not any(r["id"].endswith("_fam") for r in out["records"])


# --- beyond the brief's minimum -------------------------------------------

from ffmodel.site import evidence_records as er
from ffmodel.site.leaguelens import effective_weights, evidence_identity
from ffmodel.site.method import current_method

PRIOR = {"method": "pooled_return_rate_expected_cost_v1", "rate": 0.09, "interceptions": 1, "pick_sixes": 0,
         "first_season": 2021, "through_season": 2025, "source": "s"}


def test_current_method_shape_and_normalisation():
    m = current_method(["models/transformer/v1_s44", "models\\transformer\\v1"], PRIOR)
    assert m == {"v": 1, "model": "transformer",
                 "artifacts": ["models/transformer/v1", "models/transformer/v1_s44"],
                 "ensemble": "mean_of_seed_quantiles", "band_construction": "component_sign_coherent_v1",
                 "prior": {"method": "pooled_return_rate_expected_cost_v1", "rate": 0.09,
                           "first_season": 2021, "through_season": 2025}}


@pytest.mark.parametrize("bad", [None, {"method": "m", "rate": 0.1, "first_season": 2021}])
def test_current_method_requires_full_prior(bad):
    with pytest.raises(ValueError):
        current_method(["models/transformer/v1"], bad)


def test_current_method_rejects_empty_or_duplicate_roots():
    with pytest.raises(ValueError):
        current_method([], PRIOR)
    with pytest.raises(ValueError):
        current_method(["models/transformer/v1", "models\\transformer\\v1"], PRIOR)


def test_unmapped_internal_scoring_key_raises():
    with pytest.raises(ValueError, match="bonus_rec_te"):
        er.translate_internal_scoring({"pass_yd": 0.04, "bonus_rec_te": 0.5})


def test_records_carry_full_shape_and_never_claim_current_method():
    out = build_evaluation(CTX)
    assert {k: out[k] for k in ("season", "week", "data_through", "generated_at")} == {
        "season": 2026, "week": 5, "data_through": "2026-wk4", "generated_at": "2026-10-06T00:00:00+00:00"}
    assert out["schema_version"] == 1
    keys = {"id", "metric", "source", "source_settings", "effective_scoring", "prediction_scoring", "omitted",
            "method", "population", "horizon", "values"}
    for r in out["records"]:
        assert set(r) == keys
        assert set(r["source_settings"]) == {"league", "scoring"}
        assert r["method"] is None  # no committed source records a complete current-shape method
    # No band-calibration record: its scoring is recorded only as a ruleset name.
    assert {r["id"] for r in out["records"]} == {"ros_mae_gabagool", "start_sit_close_calls"}


def test_ros_scoring_is_gabagool_without_pick_six_on_both_sides():
    ros = recs()["ros_mae_gabagool"]
    gabagool = {"pass_yd": 0.04, "pass_td": 6, "pass_int": -2, "rush_yd": 0.1, "rush_td": 6, "rec": 1,
                "rec_yd": 0.1, "rec_td": 6, "fum_lost": -2}
    assert ros["effective_scoring"] == evidence_identity(effective_weights(gabagool))
    assert ros["prediction_scoring"] == ros["effective_scoring"]
    assert ros["horizon"]["weeks_ahead"] == [1, 2, 4, 8]
    assert len(ros["values"]) == 20


def test_close_call_prediction_keeps_prior_pick_six_but_outcomes_do_not():
    cc = recs()["start_sit_close_calls"]
    assert '"passing_pick_sixes":"-3"' in cc["prediction_scoring"]
    assert '"passing_pick_sixes"' not in cc["effective_scoring"]
    assert {"key": "pass_int_td", "reason": "actual pick-six penalties unavailable"} in cc["omitted"]
    assert cc["prediction_scoring"].replace(',"passing_pick_sixes":"-3"', "") == cc["effective_scoring"]
    assert cc["values"]["overall"]["choice_accuracy"] == 0.5627


def test_source_hash_is_line_ending_independent(tmp_path):
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    a.write_bytes(b'{\n "x": 1\n}\n')
    b.write_bytes(b'{\r\n "x": 1\r\n}\r\n')
    assert er._committed_sha256(a) == er._committed_sha256(b)
