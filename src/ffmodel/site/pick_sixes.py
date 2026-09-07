"""Forecast-only pick-six expected-cost approximation; never used on actuals.

The trained model has no pick-six head. A pooled observed return-TD rate is
applied to estimated interception volume. The same expected cost shifts every
weekly point-band endpoint; discrete pick-six uncertainty is NOT simulated.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

PRIOR_PATH = Path("data_snapshots/pick_six_rates.json")


def load_pick_six_prior(season: int, path: Path = PRIOR_PATH) -> dict:
    """Pool only completed seasons before the forecast year, without lookahead."""
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    rows = [r for r in snapshot["seasons"] if r["season"] < season]
    if not rows:
        raise ValueError(f"no completed pick-six history before {season}")
    years = [r["season"] for r in rows]
    if len(set(years)) != len(years):
        raise ValueError("duplicate pick-six history seasons")
    for row in rows:
        ints, sixes = row["interceptions"], row["pick_sixes"]
        if (not isinstance(ints, int) or not isinstance(sixes, int)
                or not 0 <= sixes <= ints or ints <= 0):
            raise ValueError("invalid observed pick-six counts")
    interceptions = sum(r["interceptions"] for r in rows)
    pick_sixes = sum(r["pick_sixes"] for r in rows)
    return {
        "method": "pooled_return_rate_expected_cost_v1",
        "rate": pick_sixes / interceptions,
        "interceptions": interceptions, "pick_sixes": pick_sixes,
        "first_season": min(years), "through_season": max(years),
        "source": snapshot["source"],
        "volume_method": "nonnegative_piecewise_linear_int_quantile_mean",
        "uncertainty": "expected cost only; discrete pick-six variance not simulated",
    }


def _interception_volume(frames: dict) -> pd.Series:
    mid = frames["p50"]["passing_interceptions"]
    if frames.get("p10") is None or frames.get("p90") is None:
        return mid.clip(lower=0)
    low = frames["p10"]["passing_interceptions"]
    high = frames["p90"]["passing_interceptions"]
    if (low > mid).any() or (mid > high).any():
        raise ValueError("unordered interception quantiles")
    # Integrate max(linear inverse-CDF, 0) exactly, including zero crossings.
    # Clipping just the knots would overestimate a segment crossing zero.
    knots = [2 * low - mid, low, mid, high, 2 * high - mid]
    mean = pd.Series(0.0, index=mid.index)
    for left, right, width in zip(knots, knots[1:], (.1, .4, .4, .1)):
        area = (left.clip(lower=0) + right.clip(lower=0)) * width / 2
        crossing = (left < 0) & (right > 0)
        area.loc[crossing] = (
            width * right.loc[crossing] ** 2
            / (2 * (right.loc[crossing] - left.loc[crossing])))
        mean += area
    return mean


def add_pick_six_expectation(frames: dict, positions: pd.Series,
                             rate: float | None) -> dict:
    """Copy prediction frames and add a common QB expected-count adjustment.

    An absent rate is a strict no-op for older evaluation callers. Do not
    supply observed stat frames: an existing pick-six column is rejected.
    """
    if rate is None:
        return frames
    if not np.isfinite(rate) or not 0 <= rate <= 1:
        raise ValueError("pick-six rate must be finite and between zero and one")
    for frame in frames.values():
        if frame is None:
            continue
        if not frame.index.equals(positions.index):
            raise ValueError("pick-six forecast index mismatch")
        if "passing_pick_sixes" in frame:
            raise ValueError("pick-six forecast must not overwrite supplied counts")
        if not np.isfinite(frame["passing_interceptions"]).all():
            raise ValueError("nonfinite interception forecast")
    expected = _interception_volume(frames).where(positions.eq("QB"), 0) * rate
    return {q: None if frame is None else frame.assign(passing_pick_sixes=expected)
            for q, frame in frames.items()}
