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


def test_run_backtest_rejects_misaligned_predictions():
    features = _toy_features()

    class Reorderer:
        name = "reorderer"

        def fit(self, train):
            pass

        def predict(self, test):
            return test[PREDICTED_STATS].iloc[::-1].reset_index(drop=True)

    with pytest.raises(ValueError, match="misaligned"):
        run_backtest(features, [Reorderer()], test_seasons=[2023])


def test_run_backtest_quantile_predictor_adds_columns():
    features = _toy_features()

    class QuantileOracle:
        name = "q_oracle"

        def fit(self, train):
            pass

        def predict(self, test):
            return test[PREDICTED_STATS].copy()

        def predict_quantiles(self, test):
            actual = test[PREDICTED_STATS]
            return {"p10": actual * 0.5, "p50": actual.copy(), "p90": actual * 1.5}

    results = run_backtest(features, [QuantileOracle()], test_seasons=[2023])
    row = results[results["position"] == "OVERALL"].iloc[0]
    assert row["mae"] == pytest.approx(0.0)          # p50 == truth
    assert row["pinball_p50"] == pytest.approx(0.0)
    assert row["coverage_p10_p90"] == pytest.approx(1.0)


def test_coverage_uses_sign_coherent_band_for_interceptions():
    # A predictor whose only band width is on interceptions (negative weight):
    # p10 INT=0, p90 INT=5, positives fixed at truth. The actual (0 INT) sits at
    # the top of the coherent band, so it must be covered. The old
    # fantasy_points(p90) ceiling subtracted 5 interceptions and pushed the
    # ceiling BELOW the actual -> not covered. Coverage must be 1.0, not 0.
    features = _toy_features()

    class IntBandPredictor:
        name = "int_band"

        def fit(self, train):
            pass

        def predict(self, test):
            return test[PREDICTED_STATS].copy()

        def predict_quantiles(self, test):
            actual = test[PREDICTED_STATS]
            p10 = actual.copy(); p10["passing_interceptions"] = 0.0
            p90 = actual.copy(); p90["passing_interceptions"] = 5.0
            return {"p10": p10, "p50": actual.copy(), "p90": p90}

    results = run_backtest(features, [IntBandPredictor()], test_seasons=[2023])
    row = results[results["position"] == "OVERALL"].iloc[0]
    assert row["mae"] == pytest.approx(0.0)               # p50 == truth
    assert row["coverage_p10_p90"] == pytest.approx(1.0)  # actual is inside the coherent band


def test_point_only_predictors_unchanged():
    features = _toy_features()
    results = run_backtest(features, [NaiveLast4()], test_seasons=[2023])
    assert "pinball_p50" not in results.columns or results["pinball_p50"].isna().all()


def test_run_backtest_rejects_misaligned_quantiles():
    features = _toy_features()

    class MisalignedQuantiles:
        name = "bad_quantiles"

        def fit(self, train):
            pass

        def predict(self, test):
            return test[PREDICTED_STATS].copy()

        def predict_quantiles(self, test):
            good = test[PREDICTED_STATS].copy()
            bad = good.iloc[::-1].reset_index(drop=True)
            return {"p10": bad, "p50": good, "p90": good.copy()}

    with pytest.raises(ValueError, match="p10 index misaligned"):
        run_backtest(features, [MisalignedQuantiles()], test_seasons=[2023])


class _PointArmPredictor:
    """Quantile predictor that also exposes predict_point, so the harness's
    point_arm path can be exercised without a trained artifact."""
    name = "pointarm"

    def __init__(self, features):
        self.features = features
        self.point_calls = []

    def fit(self, train):
        pass

    def predict(self, test):
        return self.predict_quantiles(test)["p50"]

    def predict_quantiles(self, test):
        base = test[PREDICTED_STATS].astype(float)
        return {"p10": base * 0.5, "p50": base, "p90": base * 1.5}

    def predict_point(self, test, arm="A", quantiles=None):
        self.point_calls.append((arm, quantiles is not None))
        return self.predict_quantiles(test)["p50"] * 2.0


def test_run_backtest_default_is_unchanged_when_point_arm_is_none():
    """The existing p50 path must be byte-identical when point_arm is not passed."""
    features_fixture = _toy_features()
    p = _PointArmPredictor(features_fixture)
    results = run_backtest(features_fixture, [p], test_seasons=[2023])
    assert p.point_calls == [], "predict_point was used without point_arm being set"


def test_run_backtest_point_arm_uses_predict_point_and_reuses_quantiles():
    features_fixture = _toy_features()
    p = _PointArmPredictor(features_fixture)
    results = run_backtest(features_fixture, [p], test_seasons=[2023], point_arm="A")
    assert p.point_calls == [("A", True)], (
        "point_arm must call predict_point once with the already-computed quantiles"
    )
    # bands still come from predict_quantiles, unaffected by the arm
    # (run_backtest returns the aggregated score_table, whose quantile-derived
    # columns are pinball_p10/pinball_p90/coverage_p10_p90, not raw p10/p90)
    assert {"pinball_p10", "pinball_p90", "coverage_p10_p90"} <= set(results.columns)

    # Prove the arm moved the point estimate but left the band alone: compare
    # against a fresh predictor run with point_arm=None (p50 path).
    baseline_results = run_backtest(features_fixture, [_PointArmPredictor(features_fixture)],
                                    test_seasons=[2023], point_arm=None)
    arm_row = results[results["position"] == "OVERALL"].iloc[0]
    base_row = baseline_results[baseline_results["position"] == "OVERALL"].iloc[0]
    for col in ("pinball_p10", "pinball_p90", "coverage_p10_p90"):
        assert arm_row[col] == pytest.approx(base_row[col]), (
            f"{col} should be unaffected by point_arm (bands are arm-independent)"
        )
    for col in ("mae", "rmse"):
        assert arm_row[col] != pytest.approx(base_row[col]), (
            f"{col} should differ under point_arm (predict_point returns p50 * 2.0)"
        )


def test_run_backtest_point_arm_ignored_for_predictors_without_predict_point():
    """Baselines have no mean head; they must still score through the normal
    path rather than erroring when point_arm is set."""
    features_fixture = _toy_features()
    results = run_backtest(features_fixture, [NaiveLast4()], test_seasons=[2023],
                           point_arm="A")
    assert not results.empty


class _QuantileOnlyPredictor:
    """Has predict_quantiles but deliberately NO predict_point, unlike
    _PointArmPredictor. Exercises the hasattr(predictor, "predict_point")
    guard itself (not just the point_arm is not None check), which
    NaiveLast4-based tests can never reach since NaiveLast4 has neither
    method."""
    name = "quantile_only"

    def fit(self, train):
        pass

    def predict(self, test):
        return self.predict_quantiles(test)["p50"]

    def predict_quantiles(self, test):
        base = test[PREDICTED_STATS].astype(float)
        return {"p10": base * 0.5, "p50": base, "p90": base * 1.5}


def test_run_backtest_point_arm_falls_back_to_p50_without_predict_point():
    """A predictor with predict_quantiles but no predict_point must still
    score successfully when point_arm is set, falling back to the p50 path
    exactly as when point_arm is None. This is the scenario the
    NaiveLast4-based test above cannot reach, since NaiveLast4 has neither
    predict_quantiles nor predict_point and never touches the
    hasattr(predictor, "predict_point") guard."""
    features_fixture = _toy_features()
    with_arm = run_backtest(features_fixture, [_QuantileOnlyPredictor()],
                            test_seasons=[2023], point_arm="A")
    without_arm = run_backtest(features_fixture, [_QuantileOnlyPredictor()],
                               test_seasons=[2023], point_arm=None)
    pd.testing.assert_frame_equal(with_arm, without_arm)


def test_run_backtest_rejects_unknown_point_arm():
    features_fixture = _toy_features()
    with pytest.raises(ValueError, match="point_arm"):
        run_backtest(features_fixture, [NaiveLast4()], test_seasons=[2023],
                     point_arm="Z")
