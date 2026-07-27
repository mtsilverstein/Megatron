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

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.data.features import build_features
from ffmodel.data.pull import pull_schedules, pull_weekly
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
    guard 4), point_in_band_a, point_in_band_b (bool, diagnostic, one per arm).

    mono_ok holds BY CONSTRUCTION and is not evidence about the mean head:
    TransformerPredictor.predict_quantiles unconditionally np.sorts the
    quantile triple before returning it, and the mh artifact roots ship no
    calibration.json, so mono_ok can never be False for these artifacts. The
    spec's guard 4 requires this literal check, so it is kept exactly as
    specified -- it just cannot fail against the mean head as currently
    shipped, so a True here says nothing about the mean head's quality.

    point_in_band_a / point_in_band_b are NON-GATING diagnostics -- nothing
    may block on either. point_in_band_a is True where arm A's point line's
    PPR value (mh_a, scored) falls inside the sign-coherent (floor, ceiling)
    band built from fantasy_points_band(mh_q["p10"], mh_q["p90"], rules);
    point_in_band_b is the same check against arm B's point line (mh_b).
    Arm B splices every count component (not just touchdowns), so its
    band-escape rate is at least arm A's and must be tracked separately --
    reusing arm A's column for arm B would understate arm B's true
    band-escape rate in the permanent record. This is the risk the mean
    head actually introduces -- a spliced conditional-mean point estimate
    escaping the band it should sit inside -- and nothing else here checks
    it.
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
        mh_b_points = fantasy_points(mh_b, rules)
        # Diagnostic only (see docstring): does each arm's spliced point line
        # stay inside the band it should sit inside? Not a gate criterion.
        # Both arms are checked against the SAME sign-coherent band -- the
        # band itself doesn't depend on which arm's point line is being
        # tested against it.
        floor, ceil = fantasy_points_band(mh_q["p10"], mh_q["p90"], rules)
        point_in_band_a = (mh_a_points >= floor) & (mh_a_points <= ceil)
        point_in_band_b = (mh_b_points >= floor) & (mh_b_points <= ceil)
        frames.append(pd.DataFrame({
            "season": season,
            "week": test["week"].to_numpy(),
            "position": test["position"].to_numpy(),
            "actual": fantasy_points(test[PREDICTED_STATS], rules).to_numpy(),
            "v1": fantasy_points(v1_q["p50"], rules).to_numpy(),
            "mh_a": mh_a_points.to_numpy(),
            "mh_b": mh_b_points.to_numpy(),
            "mono_ok": mono.to_numpy(),
            "point_in_band_a": point_in_band_a.to_numpy(),
            "point_in_band_b": point_in_band_b.to_numpy(),
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


COVERAGE_BAND = (0.75, 0.85)


def refit_coverage(features: pd.DataFrame, mh_roots: list[Path],
                   test_seasons: list[int] = TEST_SEASONS,
                   rules: ScoringRules = PPR) -> pd.DataFrame:
    """Guard 2: fresh per-position conformal refit, then held-out coverage.

    The factors are fit on the fold's VALIDATION season (the last training
    season, which is what the artifact was early-stopped on) and applied to the
    held-out test season. Fitting them on the test season would be circular --
    coverage would land in band by construction and the guard would be vacuous.

    `calibration=False` on the fitting predictor is required: fit_calibration
    must see the RAW band, not one an existing calibration.json already scaled.
    """
    from ffmodel.model.calibrate import fit_calibration
    from ffmodel.model.predictor import TransformerPredictor

    out = []
    for season, train_idx, test_idx in walk_forward_splits(features, test_seasons):
        train, test = features.loc[train_idx], features.loc[test_idx]
        val_season = int(train["season"].max())
        val = train[train["season"] == val_season]

        raw = TransformerPredictor(mh_roots, features, calibration=False)
        raw.fit(train)

        val_q = raw.predict_quantiles(val)
        factors = fit_calibration(
            val_q, fantasy_points(val[PREDICTED_STATS], rules),
            val["position"], rules,
        )["per_position"]

        test_q = raw.predict_quantiles(test)
        s_lo = test["position"].map(lambda p: factors[p]["s_lo"])
        s_hi = test["position"].map(lambda p: factors[p]["s_hi"])
        p10, p50, p90 = test_q["p10"], test_q["p50"], test_q["p90"]
        lo = p50 - (p50 - p10).mul(s_lo, axis=0)
        hi = p50 + (p90 - p50).mul(s_hi, axis=0)
        floor, ceil = fantasy_points_band(lo, hi, rules)
        actual = fantasy_points(test[PREDICTED_STATS], rules)

        covered = ((actual >= floor) & (actual <= ceil)).groupby(
            test["position"]).mean()
        for position, value in covered.items():
            out.append({
                "season": int(season), "position": position,
                "coverage": float(value),
                "in_band": bool(COVERAGE_BAND[0] <= value <= COVERAGE_BAND[1]),
            })
    return pd.DataFrame(out)


def _spearman_delta(rows: pd.DataFrame, arm_col: str,
                    positions: list[str]) -> dict:
    """Paired per-cell Spearman delta (arm - v1), bootstrapped by fold.

    Both arms are scored on the SAME cells: a cell dropped as degenerate for
    one arm is dropped for both, via an inner join on (season, week, position).
    An outer join would compare different populations and quietly bias the
    delta toward whichever arm survived the marginal weeks.
    """
    key = ["season", "week", "position"]
    base = weekly_spearman(rows, "v1", positions)
    arm = weekly_spearman(rows, arm_col, positions)
    merged = base.merge(arm, on=key, suffixes=("_v1", "_arm"))
    delta = merged["spearman_arm"] - merged["spearman_v1"]
    stats = paired_bootstrap(delta.to_numpy(), merged["season"].to_numpy())
    stats["v1_mean"] = float(merged["spearman_v1"].mean())
    stats["arm_mean"] = float(merged["spearman_arm"].mean())
    stats["cells"] = int(len(merged))
    return stats


def _mae_delta(rows: pd.DataFrame, arm_col: str) -> dict:
    """Guard 3, pooled over all positions. Negative delta = the arm is better."""
    delta = (rows[arm_col] - rows["actual"]).abs() - (rows["v1"] - rows["actual"]).abs()
    stats = paired_bootstrap(delta.to_numpy(), rows["season"].to_numpy())
    stats["v1_mae"] = float((rows["v1"] - rows["actual"]).abs().mean())
    stats["arm_mae"] = float((rows[arm_col] - rows["actual"]).abs().mean())
    return stats


def _primary_passed(stats: dict) -> bool:
    """PRIMARY: pooled delta > 0 AND the 95% CI excludes zero. Both conjuncts
    matter: dropping `mean > 0` would let a CI that lies entirely BELOW zero
    (the arm significantly worse) pass just because it "excludes zero"."""
    return bool(stats["mean"] > 0 and stats["ci95"][0] > 0)


def _qb_ok(stats: dict) -> bool:
    """Guard 1 (no_qb_harm) FAILS only if the QB Spearman-delta CI lies
    ENTIRELY below zero. A CI straddling zero, or lying entirely above zero,
    passes -- this guard exists to catch QB harm, not to require QB
    improvement."""
    return not (stats["ci95"][1] < 0)


def _mae_ok(stats: dict) -> bool:
    """Guard 3 (points_not_worse) FAILS only if the pooled MAE-delta CI lies
    ENTIRELY above zero (the arm significantly worse on points). A CI
    straddling zero, or lying entirely below zero (the arm significantly
    BETTER on points), passes -- this is deliberately asymmetric, the mirror
    image of `_qb_ok`, not a symmetric "CI excludes zero" check."""
    return not (stats["ci95"][0] > 0)


def _arm_result(rows: pd.DataFrame, coverage: pd.DataFrame, arm_col: str) -> dict:
    primary = _spearman_delta(rows, arm_col, PRIMARY_POSITIONS)
    primary["passed"] = _primary_passed(primary)

    qb = _spearman_delta(rows, arm_col, ["QB"])
    qb_ok = _qb_ok(qb)

    bad_cov = coverage[~coverage["in_band"]]
    mae = _mae_delta(rows, arm_col)
    mae_ok = _mae_ok(mae)
    mono_violations = int((~rows["mono_ok"]).sum())

    guards = {
        "no_qb_harm": {"passed": bool(qb_ok), **qb},
        "bands_intact": {
            "passed": bool(bad_cov.empty),
            "band": list(COVERAGE_BAND),
            "position_seasons_checked": int(len(coverage)),
            "out_of_band": bad_cov.to_dict(orient="records"),
        },
        "points_not_worse": {"passed": bool(mae_ok), **mae},
        "monotonicity": {"passed": mono_violations == 0,
                         "violations": mono_violations},
    }
    # NON-GATING diagnostics. These are reported for honesty and are never
    # allowed to influence `passed` -- the gate criteria are pre-registered and
    # adding one here after the fact would be exactly the p-hacking the spec
    # forbids.
    band_col = "point_in_band_" + arm_col.rsplit("_", 1)[-1]  # mh_a -> _a, mh_b -> _b
    diagnostics = {
        "point_line_outside_band": int((~rows[band_col]).sum()),
        "note": "guard 4 (monotonicity) holds by construction upstream -- "
                "predict_quantiles sorts the triple and the mh roots carry no "
                "calibration.json -- so it is not evidence about the mean head. "
                "point_line_outside_band is the risk the mean head actually "
                "introduces (a spliced conditional mean escaping the band, "
                "checked against THIS arm's own point line) and is reported "
                "here as a DIAGNOSTIC ONLY, not a criterion.",
    }
    return {"primary": primary, "guards": guards, "diagnostics": diagnostics,
            "passed": bool(primary["passed"] and all(g["passed"] for g in guards.values()))}


def evaluate_gate(rows: pd.DataFrame, coverage: pd.DataFrame) -> dict:
    """Apply the binding gate. Arm A is the candidate; Arm B is reported and is
    promotable only if it passes the identical gate AND strictly beats Arm A on
    the primary. Ties go to Arm A (spec section 8: fewer components changed)."""
    a = _arm_result(rows, coverage, "mh_a")
    b = _arm_result(rows, coverage, "mh_b")

    if b["passed"] and b["primary"]["mean"] > a["primary"]["mean"]:
        verdict = "PROMOTE ARM B"
    elif a["passed"]:
        verdict = "PROMOTE ARM A"
    else:
        verdict = "NOT PROMOTED"

    return {"verdict": verdict, "primary": a["primary"], "guards": a["guards"],
            "arm_a": a, "arm_b": b}


def _validate_test_seasons(features: pd.DataFrame, test_seasons: list[int]) -> None:
    """Fails fast and legibly if a caller's --first-season/--last-season
    narrows the built features below what TEST_SEASONS requires, instead of
    dying deep inside refit_coverage with an opaque TypeError after a full
    (expensive) inference pass has already run."""
    missing = sorted(set(test_seasons) - set(features["season"].unique()))
    if missing:
        raise ValueError(
            f"mean_head_gate: TEST_SEASONS requires season(s) {missing} that "
            f"are not present in the built features -- widen "
            f"--first-season/--last-season to cover them"
        )


def _git_short_sha() -> str | None:
    """Best-effort short commit SHA for the permanent record. Never raises:
    degrades to None if git is missing or this isn't a checkout, since the
    report must still be written either way."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Evaluate the PRE-REGISTERED mean-head gate (spec 2026-07-26 section 8).")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--last-season", type=int, default=2025)
    parser.add_argument("--out", type=Path,
                        default=Path("models/diagnostics/mean_head_gate.json"))
    return parser


def main() -> None:
    args = build_parser().parse_args()
    seasons = list(range(args.first_season, args.last_season + 1))
    features = build_features(pull_weekly(seasons, cache_dir=args.data_dir),
                              pull_schedules(seasons, cache_dir=args.data_dir))
    _validate_test_seasons(features, TEST_SEASONS)

    rows = collect_fold_predictions(features, V1_ROOTS, MH_ROOTS, TEST_SEASONS)
    coverage = refit_coverage(features, MH_ROOTS, TEST_SEASONS)
    result = evaluate_gate(rows, coverage)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "experiment": "mean-head",
        "spec": "docs/superpowers/specs/2026-07-26-mean-head-design.md",
        "verdict": result["verdict"],
        "pre_registered_rule": {
            "recorded_before_results": True,
            "primary": "weekly within-position Spearman, RB/WR/TE pooled, Arm A "
                       "vs v1: pooled delta > 0 with a paired-bootstrap 95% CI "
                       "excluding zero",
            "guards": ["no QB harm", "p10-p90 coverage in [0.75, 0.85] for every "
                       "position-season after a fresh conformal refit",
                       "pooled PPR MAE not significantly worse",
                       "p10 <= p50 <= p90 everywhere"],
            "mde": "SE ~0.007-0.010 over 9 paired folds resolves ~+0.02 Spearman "
                   "at 95%; a failure means 'no effect of ~0.02 or larger', not "
                   "'no effect'",
            "bootstrap_seed": BOOTSTRAP_SEED,
            "bootstrap_unit": "fold (season) resampled with replacement, not row",
            "pooled_mean_weighting": "player-week-weighted (concatenate-then-mean "
                                     "weights folds by row count), matching the "
                                     "spec's 'paired bootstrap over player-weeks' "
                                     "and the reported point estimate",
        },
        "artifacts_evaluated": {
            "mh_roots": [p.as_posix() for p in MH_ROOTS],
            "v1_roots": [p.as_posix() for p in V1_ROOTS],
            "test_seasons": TEST_SEASONS,
        },
        "run_parameters": {
            "first_season": args.first_season,
            "last_season": args.last_season,
            "git_commit": _git_short_sha(),
            "primary_positions": PRIMARY_POSITIONS,
            "min_week_rows": MIN_WEEK_ROWS,
            "mae_guard_note": "guard 3's pooled PPR MAE (points_not_worse) pools "
                              "across ALL positions, INCLUDING QB -- a defensible "
                              "reading of the spec's bare 'pooled', locked in by "
                              "design before this run, not a post-hoc choice.",
        },
        "arm_a": result["arm_a"],
        "arm_b": result["arm_b"],
        "coverage_refit": coverage.to_dict(orient="records"),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))

    print(f"VERDICT: {result['verdict']}")
    # Print the WINNING arm's numbers -- under "PROMOTE ARM B" that is arm_b,
    # never arm_a, so the console output can't mislead about which arm the
    # verdict actually describes.
    winner_key = "arm_b" if result["verdict"] == "PROMOTE ARM B" else "arm_a"
    winner = result[winner_key]
    p = winner["primary"]
    print(f"primary [{winner_key}]  delta={p['mean']:+.4f}  ci95=[{p['ci95'][0]:+.4f}, "
          f"{p['ci95'][1]:+.4f}]  cells={p['cells']}")
    for name, g in winner["guards"].items():
        print(f"guard {name:<18} {'PASS' if g['passed'] else 'FAIL'}")
    print(f"\nreport -> {args.out}")


if __name__ == "__main__":
    main()
