import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ffmodel.model.calibrate import build_parser, fit_calibration, write_calibration
from ffmodel.scoring import BAND_CONSTRUCTION, PPR, PREDICTED_STATS, fantasy_points_band

ZERO_STATS = [s for s in PREDICTED_STATS]


def _frame(index, **overrides) -> pd.DataFrame:
    """A PREDICTED_STATS-columned frame, all zero except `overrides`
    (each value either a scalar or an array-like of len(index))."""
    data = {col: np.zeros(len(index)) for col in PREDICTED_STATS}
    for col, val in overrides.items():
        data[col] = np.broadcast_to(val, len(index)).astype(float)
    return pd.DataFrame(data, index=index)


def _single_position_case(n=400, seed=0):
    """One position ('WR'), fixed p50, known p10/p90 offsets on
    receiving_yards (weight .1) and receptions (weight 1.0). actual is drawn
    from a wider spread than the raw band so calibration must shrink it."""
    idx = pd.RangeIndex(n)
    p50 = _frame(idx, receiving_yards=50.0, receptions=5.0)
    p10 = _frame(idx, receiving_yards=30.0, receptions=3.0)
    p90 = _frame(idx, receiving_yards=70.0, receptions=7.0)
    rng = np.random.default_rng(seed)
    actual = pd.Series(rng.normal(loc=10.0, scale=5.0, size=n), index=idx)
    positions = pd.Series(["WR"] * n, index=idx)
    quantiles = {"p10": p10, "p50": p50, "p90": p90}
    return quantiles, actual, positions


def test_fit_calibration_single_position_hits_tail_targets():
    quantiles, actual, positions = _single_position_case()
    fitted = fit_calibration(quantiles, actual, positions)

    assert set(fitted["per_position"]) == {"WR"}
    s_lo = fitted["per_position"]["WR"]["s_lo"]
    s_hi = fitted["per_position"]["WR"]["s_hi"]
    assert 0.0 <= s_lo <= 4.0
    assert 0.0 <= s_hi <= 4.0

    below, above = fitted["achieved_val_tails"]["WR"]
    assert below == pytest.approx(0.10, abs=0.02)
    assert above == pytest.approx(0.10, abs=0.02)

    # Manually reproduce the achieved tails from the returned (s_lo, s_hi):
    # applying the same scaling formula and the same band construction must
    # give back exactly the achieved rates the fit reported.
    p10, p50, p90 = quantiles["p10"], quantiles["p50"], quantiles["p90"]
    low = p50 - s_lo * (p50 - p10)
    high = p50 + s_hi * (p90 - p50)
    floor, ceil = fantasy_points_band(low, high, PPR)
    manual_below = float((actual < floor).mean())
    manual_above = float((actual > ceil).mean())
    assert manual_below == pytest.approx(below, abs=1e-9)
    assert manual_above == pytest.approx(above, abs=1e-9)


def test_fit_calibration_two_positions_differ():
    n = 400
    idx = pd.RangeIndex(n)
    p50 = _frame(idx, receiving_yards=50.0, receptions=5.0)
    p10 = _frame(idx, receiving_yards=30.0, receptions=3.0)
    p90 = _frame(idx, receiving_yards=70.0, receptions=7.0)
    rng = np.random.default_rng(1)
    # RB: actual much more spread out than the raw band -> needs a bigger s
    # (less shrinkage) to hit 10%/10%.
    actual_rb = pd.Series(rng.normal(10.0, 12.0, size=n), index=idx[:n])
    # TE: actual tightly clustered near p50 -> needs a smaller s (more
    # shrinkage) to hit 10%/10%.
    actual_te = pd.Series(rng.normal(10.0, 1.5, size=n), index=idx[:n])

    idx_all = pd.RangeIndex(2 * n)
    quantiles = {
        "p10": pd.concat([p10, p10], ignore_index=True),
        "p50": pd.concat([p50, p50], ignore_index=True),
        "p90": pd.concat([p90, p90], ignore_index=True),
    }
    for k in quantiles:
        quantiles[k].index = idx_all
    actual = pd.concat([actual_rb, actual_te], ignore_index=True)
    actual.index = idx_all
    positions = pd.Series(["RB"] * n + ["TE"] * n, index=idx_all)

    fitted = fit_calibration(quantiles, actual, positions)
    assert set(fitted["per_position"]) == {"RB", "TE"}
    rb = fitted["per_position"]["RB"]
    te = fitted["per_position"]["TE"]
    assert (rb["s_lo"], rb["s_hi"]) != (te["s_lo"], te["s_hi"])
    for pos in ("RB", "TE"):
        below, above = fitted["achieved_val_tails"][pos]
        assert below == pytest.approx(0.10, abs=0.03)
        assert above == pytest.approx(0.10, abs=0.03)


def test_fit_calibration_negative_weight_coupling_converges():
    """passing_interceptions (weight -2) given a LARGE offset -- its combined
    floor/ceiling swing (6 + 4 = 10 points) dominates passing_yards' (2 + 2
    = 4 points) -- so the joint alternating-bisection fit must actually
    resolve the cross-side coupling (per-side algebra would get this wrong,
    per scoring.fantasy_points_band's docstring). Coefficients are chosen
    (by solving the underlying 2x2 linear system for floor/ceil in terms of
    s_lo/s_hi) so the true joint solution sits well inside (0,4)x(0,4)
    -- s_lo*=2.0, s_hi*=1.0 -- rather than at a boundary corner, which would
    trap coordinate-wise bisection regardless of implementation."""
    n = 500
    idx = pd.RangeIndex(n)
    p50 = _frame(idx, passing_yards=250.0, passing_interceptions=2.0)
    p10 = _frame(idx, passing_yards=200.0, passing_interceptions=0.0)
    p90 = _frame(idx, passing_yards=300.0, passing_interceptions=5.0)
    rng = np.random.default_rng(2)
    # p50 points = 250*.04 + 2*(-2) = 6.0
    actual = pd.Series(rng.normal(loc=6.0, scale=7.803, size=n), index=idx)
    positions = pd.Series(["QB"] * n, index=idx)
    quantiles = {"p10": p10, "p50": p50, "p90": p90}

    fitted = fit_calibration(quantiles, actual, positions)
    below, above = fitted["achieved_val_tails"]["QB"]
    assert below == pytest.approx(0.10, abs=0.02)
    assert above == pytest.approx(0.10, abs=0.02)


def test_fit_calibration_index_mismatch_raises():
    quantiles, actual, positions = _single_position_case()
    bad_actual = actual.copy()
    bad_actual.index = bad_actual.index + 1000  # disjoint index
    with pytest.raises(ValueError):
        fit_calibration(quantiles, bad_actual, positions)


def test_fit_calibration_positions_index_mismatch_raises():
    quantiles, actual, positions = _single_position_case()
    bad_positions = positions.copy()
    bad_positions.index = bad_positions.index + 1000
    with pytest.raises(ValueError):
        fit_calibration(quantiles, actual, bad_positions)


def test_fit_calibration_too_few_rows_raises():
    quantiles, actual, positions = _single_position_case(n=30)
    with pytest.raises(ValueError, match="WR"):
        fit_calibration(quantiles, actual, positions)


def test_write_calibration_round_trip(tmp_path):
    fitted = {
        "per_position": {"WR": {"s_lo": 0.5, "s_hi": 0.6}, "QB": {"s_lo": 0.4, "s_hi": 0.7}},
        "achieved_val_tails": {"WR": [0.098, 0.101], "QB": [0.11, 0.09]},
    }
    member_roots = [tmp_path / "b_root", tmp_path / "a_root"]
    path = write_calibration(tmp_path, 2022, member_roots, fitted)

    assert path == tmp_path / "through2022" / "calibration.json"
    payload = json.loads(path.read_text())

    assert payload["band_construction"] == BAND_CONSTRUCTION
    assert payload["fit_season"] == 2022
    assert payload["member_roots"] == sorted(
        p.as_posix() for p in member_roots
    )
    assert payload["per_position"] == fitted["per_position"]
    assert payload["achieved_val_tails"] == fitted["achieved_val_tails"]
    assert "created" in payload and isinstance(payload["created"], str)
    assert set(payload) == {
        "band_construction", "fit_season", "member_roots",
        "per_position", "achieved_val_tails", "created",
    }


def test_build_parser_defaults_and_repeatable_root():
    parser = build_parser()
    args = parser.parse_args([
        "--transformer-root", "models/transformer/v1",
        "--transformer-root", "models/transformer/v1_s43",
    ])
    assert args.transformer_root == [
        Path("models/transformer/v1"),
        Path("models/transformer/v1_s43"),
    ]
    assert args.data_dir == Path("data/raw")
    assert args.first_season == 2012
    assert args.last_season == 2025
