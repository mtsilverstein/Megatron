"""Monte-Carlo season simulation: sample a player's season point total from
per-week CALIBRATED quantile bands and a leak-free games-played distribution.

Why simulate instead of summing weekly quantiles: summing weekly p10/p50/p90
into a season band assumes perfect cross-week correlation (the comonotonic
coupling -- every week lands at the same percentile), which makes bands far
too wide, AND assumes every scheduled week is played, which inflates totals
25-35% relative to how many games a player at that position typically
actually plays. `simulate_season` instead draws each week's outcome
independently (narrower, honest bands) and samples games-played from the
empirical distribution (`games_probs_from_counts`, fed by
`ffmodel.eval.diagnose.availability_table`), so both a comonotonic-width bias
and a full-availability bias are fixed in the same pass.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

_MAX_GAMES = 18          # inclusive upper bound on the games axis (0..18 -> 19 values)
_GAMES_AXIS_LEN = _MAX_GAMES + 1


def _inverse_cdf(u, p10, p50, p90, clip: float = -5.0):
    """Piecewise-linear inverse-CDF for a single week's calibrated (p10, p50,
    p90) point, evaluated at quantile level(s) `u` (broadcastable array).

    Knots: (0.10, p10), (0.50, p50), (0.90, p90). The two tails extrapolate
    the adjacent knot-to-knot slope outward to u=0 / u=1 (mirroring the
    p10-p50 gap below p10, and the p50-p90 gap above p90) rather than
    flat-lining at the p10/p90 knots -- a flat tail would silently discard
    the represented uncertainty beyond the 10th/90th percentile. Values are
    floored at `clip` (a stat line worth deeply negative fantasy points below
    the clip is not a materially different outcome from the clip itself, but
    an unbounded lower tail would drag the simulated distribution's mean and
    low quantiles further than the calibrated band supports).
    """
    u = np.asarray(u, dtype=float)
    p10 = np.asarray(p10, dtype=float)
    p50 = np.asarray(p50, dtype=float)
    p90 = np.asarray(p90, dtype=float)
    lo0 = p10 - (p50 - p10)     # value at u=0.00
    hi1 = p90 + (p90 - p50)     # value at u=1.00
    value = np.where(
        u < 0.10,
        lo0 + u / 0.10 * (p10 - lo0),
        np.where(
            u < 0.50,
            p10 + (u - 0.10) / 0.40 * (p50 - p10),
            np.where(
                u < 0.90,
                p50 + (u - 0.50) / 0.40 * (p90 - p50),
                p90 + (u - 0.90) / 0.10 * (hi1 - p90),
            ),
        ),
    )
    return np.maximum(value, clip)


def simulate_season(week_bands: np.ndarray, games_probs: np.ndarray,
                    n_draws: int = 2000, rng: np.random.Generator = None,
                    clip: float = -5.0) -> dict:
    """Simulate `n_draws` season totals for one player+ruleset.

    `week_bands`: shape (n_weeks, 3) -- per scheduled week, the CALIBRATED
    (p10, p50, p90) point. `games_probs`: shape (19,) probabilities for
    G = 0..18 games played (caller guarantees it sums to 1). Per draw: a
    games-played count G_d is sampled from `games_probs` (capped at
    n_weeks -- a player can't play more games than he has scheduled weeks in
    this projection), then a uniformly-random subset of G_d of the n_weeks
    weeks is retained and summed, each week's value drawn independently from
    its own inverse-CDF at a fresh U(0,1). Independent per-week draws (rather
    than the comonotonic sum-of-quantiles) is the point: it is a narrower,
    honest distribution for the season total.

    Fully vectorized -- no Python loop over draws. `rng=None` defaults to
    `np.random.default_rng(0)` (deterministic default). Returns
    {"p10", "p50", "p90", "mean", "clip_frac"} -- quantiles/mean of the
    n_draws sums, and clip_frac = the fraction of RETAINED weekly draws that
    landed exactly at `clip` (a floored-value diagnostic).
    """
    if rng is None:
        rng = np.random.default_rng(0)
    week_bands = np.asarray(week_bands, dtype=float)
    n_weeks = week_bands.shape[0]
    p10, p50, p90 = week_bands[:, 0], week_bands[:, 1], week_bands[:, 2]

    # Per-draw, per-week outcome: independent U(0,1) -> inverse-CDF.
    u_values = rng.random((n_draws, n_weeks))
    values = _inverse_cdf(u_values, p10, p50, p90, clip)   # (n_draws, n_weeks)

    # Per-draw games-played count, capped at the number of scheduled weeks.
    games_axis = np.arange(len(games_probs))
    g_draws = rng.choice(games_axis, size=n_draws, p=games_probs)
    g_draws = np.minimum(g_draws, n_weeks)

    # Uniformly-random subset of size G_d per draw: rank each week within its
    # draw by a fresh uniform, then retain the G_d smallest ranks (a rank
    # from iid continuous draws is a uniformly random permutation, so "the
    # G_d smallest ranks" is a uniformly random size-G_d subset). Double
    # argsort is the standard vectorized rank trick -- no Python loop.
    subset_u = rng.random((n_draws, n_weeks))
    order = np.argsort(subset_u, axis=1)
    ranks = np.argsort(order, axis=1)
    retain_mask = ranks < g_draws[:, None]

    sums = np.where(retain_mask, values, 0.0).sum(axis=1)

    n_retained = int(retain_mask.sum())
    clip_frac = float(np.mean(values[retain_mask] == clip)) if n_retained else 0.0

    p10_out, p50_out, p90_out = np.quantile(sums, [0.10, 0.50, 0.90])
    return {
        "p10": float(p10_out), "p50": float(p50_out), "p90": float(p90_out),
        "mean": float(np.mean(sums)), "clip_frac": clip_frac,
    }


def games_probs_from_counts(counts: pd.DataFrame) -> dict[str, np.ndarray]:
    """`ffmodel.eval.diagnose.availability_table` output (columns position,
    games, count) -> position -> shape-(19,) probability vector over
    G = 0..18, normalized to sum to 1. A position with zero total count
    (shouldn't happen from a real availability_table, whose rows always sum
    to at least one cohort) returns an all-zero vector rather than raising,
    so a degenerate caller-supplied frame fails downstream at `rng.choice`
    (which rejects a non-normalized `p`) rather than here."""
    out: dict[str, np.ndarray] = {}
    for pos, group in counts.groupby("position", sort=False):
        vec = np.zeros(_GAMES_AXIS_LEN, dtype=float)
        games = group["games"].to_numpy(dtype=int)
        vec[games] = group["count"].to_numpy(dtype=float)
        total = vec.sum()
        out[pos] = vec / total if total > 0 else vec
    return out
