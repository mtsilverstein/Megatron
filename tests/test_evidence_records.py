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

import hashlib

from ffmodel.scoring import BAND_CONSTRUCTION
from ffmodel.site import evidence_records as er
from ffmodel.site.leaguelens import effective_weights, evidence_identity
from ffmodel.site.method import current_method

PRIOR = {"method": "pooled_return_rate_expected_cost_v1", "rate": 0.09, "interceptions": 1, "pick_sixes": 0,
         "first_season": 2021, "through_season": 2025, "source": "s"}


def _calibrated_root(tmp_path, first="models/transformer/v1", through=2025, body=b'{"a": 1}\r\n'):
    path = tmp_path / first / f"through{through}" / "calibration.json"
    path.parent.mkdir(parents=True)
    path.write_bytes(body)
    return path


def test_current_method_shape_and_normalisation(tmp_path):
    _calibrated_root(tmp_path, "models/transformer/v1_s44")
    m = current_method(["models/transformer/v1_s44", "models\\transformer\\v1"], PRIOR, through=2025,
                       root=tmp_path)
    assert m == {"v": 1, "model": "transformer",
                 "artifacts": ["models/transformer/v1", "models/transformer/v1_s44"],
                 "ensemble": "mean_of_seed_quantiles", "band_construction": BAND_CONSTRUCTION,
                 "calibration": [{"path": "models/transformer/v1_s44/through2025/calibration.json",
                                  "sha256": hashlib.sha256(b'{"a": 1}\n').hexdigest()}],
                 "prior": {"method": "pooled_return_rate_expected_cost_v1", "rate": 0.09,
                           "first_season": 2021, "through_season": 2025}}
    assert m["band_construction"] == "sign_coherent_v1"


def test_calibration_follows_the_predictors_first_root_and_fit_season(tmp_path):
    _calibrated_root(tmp_path, "models/transformer/v1", 2025)
    roots = ["models/transformer/v1", "models/transformer/v1_s43"]
    assert current_method(roots, PRIOR, through=2025, root=tmp_path)["calibration"][0]["path"] == \
        "models/transformer/v1/through2025/calibration.json"
    # absent for that fit season -> null
    assert current_method(roots, PRIOR, through=2026, root=tmp_path)["calibration"] is None
    # the predictor reads only artifact_roots[0]; a later root's file is never applied
    assert current_method(list(reversed(roots)), PRIOR, through=2025, root=tmp_path)["calibration"] is None


def test_calibration_hash_matches_the_real_committed_file():
    roots = ["models/transformer/v1", "models/transformer/v1_s43", "models/transformer/v1_s44"]
    cal = current_method(roots, PRIOR, through=2024)["calibration"]
    assert cal == [{"path": "models/transformer/v1/through2024/calibration.json",
                    "sha256": er.committed_sha256("models/transformer/v1/through2024/calibration.json")}]


@pytest.mark.parametrize("bad", [
    None, {"method": "m", "rate": 0.1, "first_season": 2021},
    {**PRIOR, "method": 3}, {**PRIOR, "method": ""},
    {**PRIOR, "rate": "0.1"}, {**PRIOR, "rate": True}, {**PRIOR, "rate": float("nan")},
    {**PRIOR, "rate": float("inf")}, {**PRIOR, "rate": -0.01}, {**PRIOR, "rate": 1.01},
    {**PRIOR, "first_season": 2021.0}, {**PRIOR, "through_season": "2025"},
    {**PRIOR, "first_season": True}, {**PRIOR, "first_season": 2026},
])
def test_current_method_validates_the_prior(bad):
    with pytest.raises(ValueError):
        current_method(["models/transformer/v1"], bad, through=2025)


def test_current_method_rejects_empty_or_duplicate_roots_and_bad_through():
    with pytest.raises(ValueError):
        current_method([], PRIOR, through=2025)
    with pytest.raises(ValueError):
        current_method(["models/transformer/v1", "models\\transformer\\v1"], PRIOR, through=2025)
    with pytest.raises(ValueError):
        current_method(["models/transformer/v1"], PRIOR, through="2025")
    with pytest.raises(TypeError):
        current_method(["models/transformer/v1"], PRIOR)  # the fit season is never guessed


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
