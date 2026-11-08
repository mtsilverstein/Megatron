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


# --- training objective (audit A2-1) -------------------------------------------

def _pre_objective_regressor_params(seed=0):
    """The regressor XGBBaseline.fit built before `objective` existed, verbatim."""
    from xgboost import XGBRegressor

    return XGBRegressor(
        n_estimators=300, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, tree_method="hist",
        random_state=seed, n_jobs=-1,
    ).get_params()


def _comparable(params):
    # `missing` is NaN, which never compares equal to itself element-wise
    return {k: v for k, v in params.items() if k != "missing"}


def test_default_objective_builds_the_committed_regressor():
    """The committed reports' `xgboost` rows must stay reproducible: the
    default regressor is exactly the pre-change one (squared error)."""
    model = XGBBaseline()
    params = model._regressor().get_params()
    assert model.objective == "squared_error"
    assert model.name == "xgboost"
    assert params["objective"] == "reg:squarederror"
    assert "quantile_alpha" not in params
    assert _comparable(params) == _comparable(_pre_objective_regressor_params())


def test_median_objective_passes_objective_and_alpha_through():
    params = XGBBaseline(objective="median", seed=2)._regressor().get_params()
    assert params["objective"] == "reg:quantileerror"
    assert params["quantile_alpha"] == 0.5
    # everything else -- hyperparameters and seed handling -- is identical
    rest = {k: v for k, v in _comparable(params).items()
            if k not in ("objective", "quantile_alpha")}
    expected = {k: v for k, v in _comparable(_pre_objective_regressor_params(seed=2)).items()
                if k != "objective"}
    assert rest == expected


def test_median_objective_renames_the_entrant():
    """A median row must never land in a report under the mean baseline's name."""
    assert XGBBaseline(objective="median").name == "xgboost_median"
    assert XGBBaseline(objective="median", feature_set="v2").name == "xgboost_v2_median"
    assert XGBBaseline(feature_set="v2").name == "xgboost_v2"


def test_unknown_objective_raises_at_construction():
    with pytest.raises(ValueError, match="unknown objective"):
        XGBBaseline(objective="reg:quantileerror")


def test_seed_average_of_one_seed_is_that_baseline():
    from ffmodel.baseline.xgb import XGBSeedAverage

    features = _toy_features()
    train = features[features["season"] == 2022]
    test = features[features["season"] == 2023]
    single = XGBBaseline(n_estimators=5, seed=3, objective="median")
    single.fit(train)
    avg = XGBSeedAverage([3], n_estimators=5, objective="median")
    avg.fit(train)
    assert avg.name == "xgboost_median" and avg.seeds == [3]
    pd.testing.assert_frame_equal(avg.predict(test), single.predict(test))


def test_seed_average_is_the_mean_of_its_members():
    from ffmodel.baseline.xgb import XGBSeedAverage

    features = _toy_features()
    train = features[features["season"] == 2022]
    test = features[features["season"] == 2023]
    avg = XGBSeedAverage([0, 1], n_estimators=5)
    avg.fit(train)
    members = []
    for seed in (0, 1):
        m = XGBBaseline(n_estimators=5, seed=seed)
        m.fit(train)
        members.append(m.predict(test))
    pd.testing.assert_frame_equal(avg.predict(test), (members[0] + members[1]) / 2)
    assert list(avg.predict(test).columns) == PREDICTED_STATS


def test_seed_average_rejects_empty_or_duplicate_seeds():
    from ffmodel.baseline.xgb import XGBSeedAverage

    with pytest.raises(ValueError, match="at least one seed"):
        XGBSeedAverage([])
    with pytest.raises(ValueError, match="duplicate seeds"):
        XGBSeedAverage([0, 0])
    with pytest.raises(ValueError, match="not `seed`"):
        XGBSeedAverage([0], seed=1)
