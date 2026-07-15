import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.baseline.naive import NaiveLast4
from ffmodel.data.future import build_future_features
from ffmodel.site.weekly import build_weekly_projections
from ffmodel.scoring import PREDICTED_STATS

from tests.test_future import _history, _sched_with_future


class _QuantileStub:
    name = "stub"

    def fit(self, train):
        pass

    def predict(self, test):
        return self.predict_quantiles(test)["p50"]

    def predict_quantiles(self, test):
        base = pd.DataFrame(0.0, index=test.index, columns=PREDICTED_STATS)
        base["receiving_yards"] = 80.0
        base["receptions"] = 5.0
        return {"p10": base * 0.5, "p50": base.copy(), "p90": base * 1.5}


def _future():
    weekly = _history()
    future = build_future_features(weekly, _sched_with_future(), 2023, 7)
    return weekly, future


def test_payload_schema_and_scoring():
    weekly, future = _future()
    stub = _QuantileStub()
    payload = build_weekly_projections(future, stub, 2023, 7, data_through="2023-10-15")
    assert payload["has_bands"] is True and payload["model"] == "stub"
    top = payload["players"][0]
    # 80*0.1 + 5 = 13.0 PPR; half = 10.5; standard = 8.0
    assert top["points"]["ppr"]["p50"] == pytest.approx(13.0)
    assert top["points"]["half_ppr"]["p50"] == pytest.approx(10.5)
    assert top["points"]["standard"]["p50"] == pytest.approx(8.0)
    assert top["points"]["ppr"]["p10"] == pytest.approx(6.5)
    assert set(top["stats_p50"]) == set(PREDICTED_STATS)
    json.dumps(payload)  # strictly serializable


def test_sorted_by_ppr_p50_desc():
    weekly, future = _future()
    payload = build_weekly_projections(future, _QuantileStub(), 2023, 7, "2023-10-15")
    p50s = [p["points"]["ppr"]["p50"] for p in payload["players"]]
    assert p50s == sorted(p50s, reverse=True)


def test_weekly_band_ceiling_is_sign_coherent_for_interceptions():
    # A passer's ceiling is his best game (fewest INTs), not his p90 INTs.
    weekly, future = _future()

    class _IntStub:
        name = "intstub"

        def fit(self, train):
            pass

        def predict(self, test):
            return self.predict_quantiles(test)["p50"]

        def predict_quantiles(self, test):
            z = pd.DataFrame(0.0, index=test.index, columns=PREDICTED_STATS)
            p10 = z.copy(); p10["passing_yards"] = 250.0; p10["passing_interceptions"] = 0.0
            p50 = z.copy(); p50["passing_yards"] = 250.0; p50["passing_interceptions"] = 1.0
            p90 = z.copy(); p90["passing_yards"] = 250.0; p90["passing_interceptions"] = 3.0
            return {"p10": p10, "p50": p50, "p90": p90}

    payload = build_weekly_projections(future, _IntStub(), 2023, 7, "2023-10-15")
    pts = payload["players"][0]["points"]["ppr"]
    assert pts["p50"] == pytest.approx(8.0)    # 250*0.04 - 1*2
    assert pts["p90"] == pytest.approx(10.0)   # ceiling: 0 INTs, not the p90 (3) INTs
    assert pts["p10"] == pytest.approx(4.0)    # floor: 3 INTs
    assert pts["p10"] <= pts["p50"] <= pts["p90"]


def test_point_only_predictor_has_null_bands():
    weekly, future = _future()
    from ffmodel.data.features import build_features

    model = NaiveLast4()
    model.fit(build_features(weekly, _sched_with_future()))
    payload = build_weekly_projections(future, model, 2023, 7, "2023-10-15")
    assert payload["has_bands"] is False
    top = payload["players"][0]
    assert top["points"]["ppr"]["p10"] is None and top["points"]["ppr"]["p90"] is None
    json.dumps(payload)


def test_empty_future_fails_loud():
    _, future = _future()
    with pytest.raises(RuntimeError, match="empty weekly page"):
        build_weekly_projections(future.iloc[0:0], _QuantileStub(), 2023, 7, "x")
