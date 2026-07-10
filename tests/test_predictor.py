import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.harness import run_backtest
from ffmodel.model.predictor import TransformerPredictor
from ffmodel.model.train import train_from_config
from ffmodel.scoring import PREDICTED_STATS

from tests.test_train import _cfg, _synthetic_features


@pytest.fixture(scope="module")
def trained(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("artifact")
    features = _synthetic_features(seasons=(2020, 2021, 2022))
    cfg = _cfg(tmp)          # val_season 2022 -> artifact through2022
    art = train_from_config(cfg, features)
    # test frame: add a 2023 season the artifact has never seen
    test_features = _synthetic_features(seasons=(2020, 2021, 2022, 2023))
    return art.parent, test_features  # art = <out_root>/testrun/through2022 -> root is its parent


def test_predict_quantiles_aligned_and_monotone(trained):
    root, features = trained
    p = TransformerPredictor(root, features)
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]
    p.fit(train)
    qs = p.predict_quantiles(test)
    for key in ("p10", "p50", "p90"):
        assert list(qs[key].columns) == PREDICTED_STATS
        assert qs[key].index.equals(test.index)
    assert (qs["p10"].to_numpy() <= qs["p50"].to_numpy() + 1e-6).all()
    assert (qs["p50"].to_numpy() <= qs["p90"].to_numpy() + 1e-6).all()


def test_fit_rejects_missing_artifact(trained):
    root, features = trained
    p = TransformerPredictor(root, features)
    with pytest.raises(FileNotFoundError, match="through2023"):
        p.fit(features[features["season"] <= 2023])


def test_runs_through_backtest(trained):
    root, features = trained
    results = run_backtest(features, [TransformerPredictor(root, features)],
                           test_seasons=[2023])
    overall = results[results["position"] == "OVERALL"].iloc[0]
    assert np.isfinite(overall["mae"])
    assert np.isfinite(overall["coverage_p10_p90"])
