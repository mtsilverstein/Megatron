import numpy as np
import pandas as pd
import pytest

from ffmodel.baseline.naive import NaiveLast4
from ffmodel.eval.harness import run_backtest
from ffmodel.scoring import PREDICTED_STATS

from tests.test_features import make_schedules, make_weekly
from ffmodel.data.features import build_features


def _toy_features() -> pd.DataFrame:
    rows = []
    for season in (2022, 2023):
        for week in range(1, 5):
            rows.append({"player_id": "p1", "season": season, "week": week,
                         "receiving_yards": 100.0, "receptions": 5.0})
            rows.append({"player_id": "p2", "season": season, "week": week,
                         "position": "RB", "rushing_yards": 80.0})
    sched = pd.concat([make_schedules(4, 2022), make_schedules(4, 2023)])
    return build_features(make_weekly(rows), sched)


def test_naive_predicts_lag4_values():
    features = _toy_features()
    model = NaiveLast4()
    train = features[features["season"] == 2022]
    test = features[features["season"] == 2023]
    model.fit(train)
    pred = model.predict(test)
    assert list(pred.columns) == PREDICTED_STATS
    # p1 has constant 100 receiving yards -> lag4 is exactly 100 mid-season
    p1_wk3 = pred[(test["player_id"] == "p1").to_numpy() & (test["week"] == 3).to_numpy()]
    assert p1_wk3["receiving_yards"].iloc[0] == pytest.approx(100.0)


def test_naive_fallback_for_no_history():
    features = _toy_features()
    model = NaiveLast4()
    model.fit(features[features["season"] == 2022])
    rookie = features[(features["season"] == 2023) & (features["week"] == 1)].copy()
    lag_cols = [c for c in rookie.columns if c.startswith("lag")]
    rookie[lag_cols] = np.nan  # simulate a debut player
    pred = model.predict(rookie)
    assert pred.notna().all().all()


def test_run_backtest_shape_and_perfect_model():
    features = _toy_features()

    class Oracle:  # cheats: returns the actual stats; proves harness wiring
        name = "oracle"
        def fit(self, train): pass
        def predict(self, test): return test[PREDICTED_STATS].copy()

    results = run_backtest(features, [Oracle(), NaiveLast4()], test_seasons=[2023])
    assert set(results["model"]) == {"oracle", "naive_last4"}
    oracle_overall = results[(results["model"] == "oracle") & (results["position"] == "OVERALL")]
    assert oracle_overall["mae"].iloc[0] == pytest.approx(0.0)
