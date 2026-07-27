"""Evaluates the PRE-REGISTERED mean-head gate.

Spec: docs/superpowers/specs/2026-07-26-mean-head-design.md section 8. The
criteria there are BINDING and were committed before any training run. This
module implements them literally; it does not choose thresholds, and nothing
here may be adjusted in response to the result it produces.

Why a separate module rather than run_backtest: the primary criterion is
weekly WITHIN-POSITION Spearman, which needs row-level predictions joined to
their week. run_backtest deliberately returns per-season aggregates, so it
cannot express the primary at all.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.eval.splits import walk_forward_splits
from ffmodel.eval.weekly_rankings import goodness_spearman
from ffmodel.scoring import (
    PPR, PREDICTED_STATS, ScoringRules, fantasy_points, fantasy_points_band,
)

V1_ROOTS = [Path("models/transformer/v1"), Path("models/transformer/v1_s43"),
            Path("models/transformer/v1_s44")]
MH_ROOTS = [Path("models/transformer/mh"), Path("models/transformer/mh_s43"),
            Path("models/transformer/mh_s44")]
TEST_SEASONS = list(range(2017, 2026))
PRIMARY_POSITIONS = ["RB", "WR", "TE"]
# Fixed so the verdict is reproducible. Chosen as the plan's date before any
# result was seen; it is not a tunable.
BOOTSTRAP_SEED = 20260727
MIN_WEEK_ROWS = 3


def collect_fold_predictions(
    features: pd.DataFrame,
    v1_roots: list[Path],
    mh_roots: list[Path],
    test_seasons: list[int] = TEST_SEASONS,
    rules: ScoringRules = PPR,
) -> pd.DataFrame:
    """One row per test player-week, carrying every arm's PPR point estimate.

    Both ensembles are fitted and scored on the SAME test index inside the same
    walk-forward loop, so the paired comparison the gate depends on cannot drift
    apart through differing row filters.

    Columns: season, week, position, actual, v1, mh_a, mh_b, mono_ok (bool,
    guard 4), point_in_band (bool, diagnostic).

    mono_ok holds BY CONSTRUCTION and is not evidence about the mean head:
    TransformerPredictor.predict_quantiles unconditionally np.sorts the
    quantile triple before returning it, and the mh artifact roots ship no
    calibration.json, so mono_ok can never be False for these artifacts. The
    spec's guard 4 requires this literal check, so it is kept exactly as
    specified -- it just cannot fail against the mean head as currently
    shipped, so a True here says nothing about the mean head's quality.

    point_in_band is a NON-GATING diagnostic -- nothing may block on it. It
    is True where the arm-A point line's PPR value (mh_a, scored) falls
    inside the sign-coherent (floor, ceiling) band built from
    fantasy_points_band(mh_q["p10"], mh_q["p90"], rules). This is the risk
    the mean head actually introduces -- a spliced conditional-mean point
    estimate escaping the band it should sit inside -- and nothing else here
    checks it.
    """
    from ffmodel.model.predictor import TransformerPredictor

    v1 = TransformerPredictor(v1_roots, features)
    mh = TransformerPredictor(mh_roots, features)
    frames = []
    for season, train_idx, test_idx in walk_forward_splits(features, test_seasons):
        train, test = features.loc[train_idx], features.loc[test_idx]
        v1.fit(train)
        mh.fit(train)
        if not mh.has_mean:
            raise ValueError(
                f"season {season}: the mh ensemble reports no mean head -- "
                f"these are not mean-head artifacts, so the gate is not "
                f"evaluable against them"
            )
        v1_q = v1.predict_quantiles(test)
        mh_q = mh.predict_quantiles(test)
        mh_a = mh.predict_point(test, arm="A", quantiles=mh_q)
        mh_b = mh.predict_point(test, arm="B", quantiles=mh_q)

        # Guard 4: the invariant must hold on the arm that could deploy.
        mono = (
            (mh_q["p10"] <= mh_q["p50"] + 1e-6).all(axis=1)
            & (mh_q["p50"] <= mh_q["p90"] + 1e-6).all(axis=1)
        )
        mh_a_points = fantasy_points(mh_a, rules)
        # Diagnostic only (see docstring): does arm A's spliced point line
        # stay inside the band it should sit inside? Not a gate criterion.
        floor, ceil = fantasy_points_band(mh_q["p10"], mh_q["p90"], rules)
        point_in_band = (mh_a_points >= floor) & (mh_a_points <= ceil)
        frames.append(pd.DataFrame({
            "season": season,
            "week": test["week"].to_numpy(),
            "position": test["position"].to_numpy(),
            "actual": fantasy_points(test[PREDICTED_STATS], rules).to_numpy(),
            "v1": fantasy_points(v1_q["p50"], rules).to_numpy(),
            "mh_a": mh_a_points.to_numpy(),
            "mh_b": fantasy_points(mh_b, rules).to_numpy(),
            "mono_ok": mono.to_numpy(),
            "point_in_band": point_in_band.to_numpy(),
        }, index=test.index))
    return pd.concat(frames)


def weekly_spearman(rows: pd.DataFrame, pred_col: str,
                    positions: list[str]) -> pd.DataFrame:
    """Within-position Spearman for each (season, week, position) cell.

    Ranking is computed WITHIN a position, never across positions: a pooled
    cross-position ranking would mostly measure that RBs outscore TEs, which is
    not what the model is being judged on.

    Cells with fewer than MIN_WEEK_ROWS rows, or with no variance in `actual`
    or in the prediction, have no defined rank correlation and are DROPPED. They
    are not recorded as 0.0 -- that would be an invented result, and it would
    drag both arms toward zero equally while shrinking the measured effect.
    """
    out = []
    subset = rows[rows["position"].isin(positions)]
    for (season, week, position), cell in subset.groupby(
            ["season", "week", "position"], sort=True):
        if len(cell) < MIN_WEEK_ROWS:
            continue
        actual = cell["actual"].to_numpy()
        pred = cell[pred_col].to_numpy()
        if np.ptp(actual) == 0 or np.ptp(pred) == 0:
            continue
        # goodness_spearman (weekly_rankings.py) is the one place a sign bug
        # shipped before; both pred_col and actual here are already
        # higher-is-better PPR points, so it is a direct drop-in for the
        # spearmanr call it wraps -- use it instead of calling scipy directly.
        r = goodness_spearman(pred, actual)
        if not np.isfinite(r):
            continue
        out.append({"season": int(season), "week": int(week),
                    "position": position, "spearman": float(r), "n": len(cell)})
    return pd.DataFrame(out, columns=["season", "week", "position", "spearman", "n"])


def paired_bootstrap(deltas, clusters, n_boot: int = 10000,
                     seed: int = BOOTSTRAP_SEED) -> dict:
    """Cluster (fold) bootstrap of the mean paired delta.

    Weeks inside a season share a model fit, a data vintage, and a league
    environment, so their deltas are correlated. Resampling rows independently
    would understate the standard error and could turn one lucky fold into a
    significant result -- so whole FOLDS are resampled with replacement, which
    is the resampling unit the spec's "9 paired folds" power statement assumes.

    The reported point estimate (`mean`) is PLAYER-WEEK-WEIGHTED, not
    equal-fold-weighted: `deltas` is the concatenation of every fold's rows,
    so a season with more player-weeks contributes proportionally more to
    the mean than a smaller season, matching the spec's "paired bootstrap
    over player-weeks" -- it is not a straight average of 9 per-fold means.
    """
    deltas = np.asarray(deltas, dtype=float)
    clusters = np.asarray(clusters)
    if len(deltas) != len(clusters):
        raise ValueError(
            f"paired_bootstrap: deltas/clusters length mismatch "
            f"({len(deltas)} vs {len(clusters)})"
        )
    if len(deltas) == 0:
        raise ValueError("paired_bootstrap: no rows to bootstrap")
    uniq = np.unique(clusters)
    by_cluster = [deltas[clusters == c] for c in uniq]
    rng = np.random.default_rng(seed)
    means = np.empty(n_boot, dtype=float)
    for b in range(n_boot):
        pick = rng.integers(0, len(by_cluster), len(by_cluster))
        means[b] = np.concatenate([by_cluster[i] for i in pick]).mean()
    lo, hi = np.percentile(means, [2.5, 97.5])
    return {
        "mean": float(deltas.mean()),
        "ci95": [float(lo), float(hi)],
        "n": int(len(deltas)),
        "n_clusters": int(len(uniq)),
        "excludes_zero": bool(lo > 0 or hi < 0),
        "seed": int(seed),
        "n_boot": int(n_boot),
    }
