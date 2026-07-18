"""Per-position, per-tail conformal calibration of the point band.

`fantasy_points_band` (see scoring.py) is sign-coherent: it pairs each stat
component with its own points-FAVOURABLE quantile end, so a negative-weight
component (passing_interceptions, fumbles_lost) contributes its p10 stat
value to the point-band CEILING and its p90 stat value to the point-band
FLOOR. Consequence: scaling the p10/p90 stat offsets by two different
factors (s_lo for the low side, s_hi for the high side) does NOT scale each
point-band side by exactly its own factor once negative-weight components
are involved -- s_hi leaks into the floor and s_lo leaks into the ceiling
for those components. That is why `fit_calibration` searches (s_lo, s_hi)
JOINTLY against the resulting point band via alternating bisection, rather
than solving each side independently with per-side algebra.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from ffmodel.scoring import PPR, BAND_CONSTRUCTION, ScoringRules, fantasy_points_band

_S_LO, _S_HI = 0.0, 4.0  # search bounds for both factors
_BISECT_STEPS = 40
MIN_ROWS = 50


def _bisect_to_target(rate_fn: Callable[[float], float], target: float,
                       lo: float = _S_LO, hi: float = _S_HI,
                       steps: int = _BISECT_STEPS) -> tuple[float, float]:
    """`rate_fn` is a (weakly) non-increasing function of s on [lo, hi].
    Returns (s, rate_fn(s)) converging toward the largest s for which
    rate_fn(s) >= target -- the boundary approached from the "still >=
    target" side, since the achieved rate is a step function of s (finite
    samples) and won't hit `target` exactly in general. Edge cases: if even
    the maximum achievable rate (at s=lo) is already <= target, s=lo is the
    closest we can get (increasing s only lowers the rate further); if even
    the minimum achievable rate (at s=hi) is still >= target, s=hi is
    closest (we've run out of range to shrink further)."""
    lo_rate = rate_fn(lo)
    if lo_rate <= target:
        return lo, lo_rate
    hi_rate = rate_fn(hi)
    if hi_rate >= target:
        return hi, hi_rate
    best_s, best_rate = lo, lo_rate
    for _ in range(steps):
        mid = (lo + hi) / 2.0
        mid_rate = rate_fn(mid)
        if mid_rate >= target:
            lo = mid
            best_s, best_rate = mid, mid_rate
        else:
            hi = mid
    return best_s, best_rate


def fit_calibration(
    quantiles: dict[str, pd.DataFrame],
    actual: pd.Series,
    positions: pd.Series,
    rules: ScoringRules = PPR,
    lo_target: float = 0.10,
    hi_target: float = 0.10,
    tol: float = 0.002,
    max_sweeps: int = 5,
) -> dict:
    """Fit per-position (s_lo, s_hi) point-band scale factors so that the
    point band from `fantasy_points_band` after scaling:
        p10_scaled = p50 - s_lo*(p50 - p10)   [componentwise]
        p90_scaled = p50 + s_hi*(p90 - p50)   [componentwise]
    achieves mean(actual < floor) ~ lo_target and mean(actual > ceil) ~
    hi_target, independently per position. See module docstring for why the
    two factors must be fit jointly rather than per-side."""
    if max_sweeps < 1:
        raise ValueError("fit_calibration: max_sweeps must be >= 1")

    p10, p50, p90 = quantiles["p10"], quantiles["p50"], quantiles["p90"]
    ref_index = actual.index
    for name, obj in (("quantiles['p10']", p10), ("quantiles['p50']", p50),
                       ("quantiles['p90']", p90), ("positions", positions)):
        if not obj.index.equals(ref_index):
            raise ValueError(
                f"fit_calibration: {name} index does not match `actual`'s index"
            )

    per_position: dict[str, dict[str, float]] = {}
    achieved: dict[str, list[float]] = {}

    for pos in sorted(positions.unique()):
        mask = (positions == pos).to_numpy()
        n = int(mask.sum())
        if n < MIN_ROWS:
            raise ValueError(
                f"fit_calibration: position {pos!r} has only {n} rows "
                f"(< {MIN_ROWS}) -- too few to calibrate a 10% tail"
            )
        pos_p10 = p10.loc[mask]
        pos_p50 = p50.loc[mask]
        pos_p90 = p90.loc[mask]
        pos_actual = actual.loc[mask]
        lo_offset = pos_p50 - pos_p10
        hi_offset = pos_p90 - pos_p50

        s_lo, s_hi = 1.0, 1.0
        for _sweep in range(max_sweeps):
            def below_at(s, _s_hi=s_hi):
                low = pos_p50 - s * lo_offset
                high = pos_p50 + _s_hi * hi_offset
                floor, _ceil = fantasy_points_band(low, high, rules)
                return float((pos_actual < floor).mean())

            # Bisection result is deliberately discarded here: it is the
            # below-rate under the OLD s_hi, and gets stale the instant step
            # (b) below moves s_hi (negative-weight components make the
            # floor depend on s_hi too -- see module docstring). We
            # re-evaluate both tails jointly at the final (s_lo, s_hi) pair
            # after step (b) instead.
            s_lo, _ = _bisect_to_target(below_at, lo_target)

            def above_at(s, _s_lo=s_lo):
                low = pos_p50 - _s_lo * lo_offset
                high = pos_p50 + s * hi_offset
                _floor, ceil = fantasy_points_band(low, high, rules)
                return float((pos_actual > ceil).mean())

            s_hi, _ = _bisect_to_target(above_at, hi_target)

            # Honest re-evaluation: recompute BOTH tail rates at the current
            # (s_lo, s_hi) pair (one extra fantasy_points_band call). Both
            # the convergence check and the returned achieved_val_tails use
            # these recomputed rates, never the stale per-step ones above.
            low = pos_p50 - s_lo * lo_offset
            high = pos_p50 + s_hi * hi_offset
            floor, ceil = fantasy_points_band(low, high, rules)
            below_rate = float((pos_actual < floor).mean())
            above_rate = float((pos_actual > ceil).mean())

            if (abs(below_rate - lo_target) <= tol
                    and abs(above_rate - hi_target) <= tol):
                break

        per_position[pos] = {"s_lo": float(s_lo), "s_hi": float(s_hi)}
        achieved[pos] = [float(below_rate), float(above_rate)]

    return {"per_position": per_position, "achieved_val_tails": achieved}


def write_calibration(base_root: Path, through: int, member_roots: list,
                       fitted: dict) -> Path:
    """Write `<base_root>/through{through}/calibration.json`. Overwrites any
    existing file (idempotent re-fit). Returns the written path."""
    base_root = Path(base_root)
    out_dir = base_root / f"through{through}"
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "band_construction": BAND_CONSTRUCTION,
        "fit_season": through,
        "member_roots": sorted(Path(r).as_posix() for r in member_roots),
        "per_position": fitted["per_position"],
        "achieved_val_tails": fitted["achieved_val_tails"],
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    path = out_dir / "calibration.json"
    path.write_text(json.dumps(payload, indent=2))
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fit per-position, per-tail conformal calibration for "
                     "every walk-forward fold of a transformer artifact."
    )
    parser.add_argument(
        "--transformer-root", type=Path, action="append", required=True,
        help="Repeatable. First occurrence is the BASE root where "
             "calibration.json files are written (e.g. models/transformer/v1); "
             "further occurrences are seed-ensemble sibling roots averaged "
             "together before fitting."
    )
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--last-season", type=int, default=2025)
    return parser


def main() -> None:
    args = build_parser().parse_args()

    from ffmodel.data.features import build_features
    from ffmodel.data.pull import pull_schedules, pull_weekly
    from ffmodel.model.predictor import TransformerPredictor
    from ffmodel.scoring import PREDICTED_STATS, fantasy_points

    roots = args.transformer_root
    base_root = roots[0]

    seasons = list(range(args.first_season, args.last_season + 1))
    weekly = pull_weekly(seasons, cache_dir=args.data_dir)
    schedules = pull_schedules(seasons, cache_dir=args.data_dir)
    features = build_features(weekly, schedules)

    fold_dirs = sorted(
        (p for p in base_root.iterdir() if p.is_dir() and p.name.startswith("through")),
        key=lambda p: p.name,
    )
    for fold_dir in fold_dirs:
        through = int(fold_dir.name.removeprefix("through"))
        # calibration=False: predict RAW (uncalibrated) bands even if this
        # fold already has a calibration.json from a previous run -- fitting
        # against an already-calibrated band would compound the shrink.
        predictor = TransformerPredictor(roots, features, calibration=False)
        train = features[features["season"] <= through]
        predictor.fit(train)
        val = features[features["season"] == through]
        pred_quantiles = predictor.predict_quantiles(val)
        actual = fantasy_points(val[PREDICTED_STATS], PPR)
        positions = val["position"]

        fitted = fit_calibration(pred_quantiles, actual, positions)
        path = write_calibration(base_root, through, roots, fitted)
        tails = ", ".join(
            f"{pos}=({b:.3f},{a:.3f})"
            for pos, (b, a) in sorted(fitted["achieved_val_tails"].items())
        )
        print(f"through{through}: {tails} -> {path}")


if __name__ == "__main__":
    main()
