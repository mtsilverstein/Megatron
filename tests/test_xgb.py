import pandas as pd
import pytest

from ffmodel.baseline.xgb import XGBBaseline
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
