import pandas as pd
import pytest

from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.data.features import feature_columns
from ffmodel.scoring import PREDICTED_STATS

from tests.test_harness import _toy_features


def test_xgb_fit_predict_shapes_and_determinism():
    features = _toy_features()
    train = features[features["season"] == 2022]
    test = features[features["season"] == 2023]

    preds = []
    for _ in range(2):
        model = XGBBaseline(n_estimators=5, seed=0)
        model.fit(train)
        preds.append(model.predict(test))

    assert list(preds[0].columns) == PREDICTED_STATS
    assert len(preds[0]) == len(test)
    pd.testing.assert_frame_equal(preds[0], preds[1])  # seeded -> identical


def test_default_feature_set_is_frozen_v1_and_named_xgboost():
    """The committed reports' `xgboost` rows are v1 rows; the default must
    keep meaning that. See models/diagnostics/xgb_feature_set_audit.json."""
    model = XGBBaseline()
    assert model.feature_set == "v1"
    assert model.name == "xgboost"


def test_matrix_respects_the_selected_feature_set():
    features = _toy_features()
    v2_pack = {"lag4_air_share", "lag8_air_share", "is_indoor",
               "team_pass_att_last4"}
    assert v2_pack <= set(features.columns)   # present in the frame either way

    default_cols = list(XGBBaseline()._matrix(features).columns)
    v2_cols = list(XGBBaseline(feature_set="v2")._matrix(features).columns)
    assert default_cols == feature_columns(features, "v1")
    assert not v2_pack & set(default_cols)    # present but NOT consumed
    assert v2_pack <= set(v2_cols)


def test_non_default_feature_set_renames_the_entrant():
    """A v2 run must never land in a report under the baseline's own name."""
    assert XGBBaseline(feature_set="v2").name == "xgboost_v2"


def test_unknown_feature_set_raises_at_construction():
    with pytest.raises(ValueError, match="unknown feature_set"):
        XGBBaseline(feature_set="v3")
