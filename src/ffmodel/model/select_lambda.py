"""Lambda-selection for the mean-head experiment (spec 2026-07-26 section 3).

Before the nine-fold mean-head main arm launches, `mean_lambda` must be
chosen from the pre-registered candidates {0.1, 0.3, 1.0, 3.0} by training
the through2016 fold at each value and picking the best by
**validation-season PPR MAE computed from the Arm-A point estimate**. The
winner is then frozen across all nine folds (every
configs/transformer_mh_through*.yaml).

Final review found two defects blocking that selection:

1. All nine mean-head configs shared `run_name: mh`, so every candidate's
   through2016 run resolved to the same artifact directory
   (models/transformer/mh/through2016) and silently deleted the previous
   candidate's artifact on retrain -- only the last lambda trained would
   ever survive. Fixed by
   configs/transformer_mh_lambda{01,03,10,30}_through2016.yaml, which give
   each candidate its own run_name (mh_l01/mh_l03/mh_l10/mh_l30) and
   therefore its own artifact directory, so all four coexist.
2. Nothing in the repo computed the pre-registered selection criterion.
   This module does, split into a pure metric and an I/O shell:

   - `ppr_mae` is the pure function: two stat-line frames in (predicted,
     actual), a float out. Unit-tested with small synthetic frames --
     no trained artifact required.
   - `_load_val_lambda`/`select_lambda`/`main` are the I/O shell: given
     trained artifact roots, they load each one's through{val_season}
     fold, predict the Arm-A point estimate on the held-out validation
     season via `TransformerPredictor.predict_point(..., arm="A")`, score
     it with `ppr_mae`, and report a table ranked best (lowest MAE) first.

CLI usage (after training each of the four lambda-selection configs):
    PYTHONPATH=src python -m ffmodel.model.select_lambda \\
        --root models/transformer/mh_l01 \\
        --root models/transformer/mh_l03 \\
        --root models/transformer/mh_l10 \\
        --root models/transformer/mh_l30
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from ffmodel.eval.metrics import mae
from ffmodel.scoring import PPR, PREDICTED_STATS, ScoringRules, fantasy_points

# The lambda-selection fold is always through2016 (spec 2026-07-26 section 3).
VAL_SEASON = 2016


def ppr_mae(predicted_stats: pd.DataFrame, actual_stats: pd.DataFrame,
            rules: ScoringRules = PPR) -> float:
    """The pre-registered selection criterion: mean absolute error between
    PPR points scored from a predicted stat-line frame (e.g.
    `TransformerPredictor.predict_point(val, arm="A")`) and PPR points
    scored from the matching actual stat-line frame (e.g. that same val
    frame's own PREDICTED_STATS columns). Both sides are scored through the
    same pure `ffmodel.scoring.fantasy_points` -- never hand-rolled PPR
    weights -- so this is exactly "validation-season PPR MAE from the Arm-A
    point estimate", regardless of which columns beyond PREDICTED_STATS
    either frame happens to carry (fantasy_points reads only the named
    scored columns and treats anything else, and anything missing, as
    absent).

    `predicted_stats` and `actual_stats` must share an index (same rows) --
    checked explicitly rather than silently letting pandas align/broadcast
    a mismatch, mirroring `fantasy_points_band`'s index-mismatch guard.
    """
    if not predicted_stats.index.equals(actual_stats.index):
        raise ValueError(
            "ppr_mae: predicted_stats/actual_stats index mismatch -- both "
            "must describe the same rows"
        )
    predicted_points = fantasy_points(predicted_stats, rules)
    actual_points = fantasy_points(actual_stats, rules)
    return mae(actual_points, predicted_points)


def _load_val_lambda(root: Path, val_season: int) -> tuple[float, dict]:
    """Read `mean_lambda` (and the full metrics dict) from a trained
    artifact's metrics.json, rather than trusting a CLI-supplied label --
    the artifact itself is the source of truth for which lambda it was
    actually trained with (same principle as train.py's config-vs-artifact
    staleness check)."""
    metrics_path = Path(root) / f"through{val_season}" / "metrics.json"
    if not metrics_path.exists():
        raise FileNotFoundError(
            f"no artifact at {metrics_path} -- train it first with "
            f"`PYTHONPATH=src python -m ffmodel.model.train --config "
            f"configs/transformer_mh_lambda<NN>_through{val_season}.yaml`"
        )
    metrics = json.loads(metrics_path.read_text())
    if metrics.get("val_season") != val_season:
        raise ValueError(
            f"{metrics_path}: artifact val_season "
            f"{metrics.get('val_season')!r} != requested {val_season}"
        )
    if not metrics.get("predict_mean", False):
        raise ValueError(
            f"{metrics_path}: predict_mean is false -- this is not a "
            f"mean-head artifact, so it has no Arm-A point estimate to select on"
        )
    return float(metrics["mean_lambda"]), metrics


def select_lambda(
    roots: list[Path],
    val_season: int = VAL_SEASON,
    data_dir: Path = Path("data"),
    first_season: int = 2012,
    rules: ScoringRules = PPR,
) -> pd.DataFrame:
    """I/O shell: for each trained lambda-selection artifact root, load its
    through{val_season} fold, predict the Arm-A point estimate on the held-
    out validation season, and score it against that season's actual stat
    lines with `ppr_mae`. Returns a table with one row per root, columns
    (mean_lambda, root, ppr_mae, n), sorted best (lowest ppr_mae) first."""
    from ffmodel.data.features import build_features
    from ffmodel.data.pull import pull_schedules, pull_weekly
    from ffmodel.model.predictor import TransformerPredictor

    if not roots:
        raise ValueError("select_lambda: at least one artifact root is required")

    seasons = list(range(first_season, val_season + 1))
    weekly = pull_weekly(seasons, cache_dir=data_dir)
    schedules = pull_schedules(seasons, cache_dir=data_dir)
    features = build_features(weekly, schedules)

    train = features[features["season"] <= val_season]
    val = features[features["season"] == val_season]
    if val.empty:
        raise ValueError(f"no feature rows for validation season {val_season}")

    rows = []
    for root in roots:
        root = Path(root)
        lam, _metrics = _load_val_lambda(root, val_season)
        predictor = TransformerPredictor(root, features, calibration=False)
        predictor.fit(train)
        pred_stats = predictor.predict_point(val, arm="A")
        rows.append({
            "root": str(root),
            "mean_lambda": lam,
            "ppr_mae": ppr_mae(pred_stats, val[PREDICTED_STATS], rules),
            "n": len(val),
        })

    return pd.DataFrame(rows).sort_values("ppr_mae", ignore_index=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Select mean_lambda from the pre-registered candidates "
                     "{0.1, 0.3, 1.0, 3.0} by through2016 validation-season "
                     "PPR MAE from the Arm-A point estimate (spec "
                     "2026-07-26 section 3). The winner must then be hand-"
                     "frozen into every configs/transformer_mh_through*.yaml "
                     "before the nine-fold main arm launches."
    )
    parser.add_argument(
        "--root", type=Path, action="append", required=True, dest="root",
        help="Repeatable. A trained lambda-selection artifact root (e.g. "
             "models/transformer/mh_l01) -- the PARENT of "
             "through{val-season}, matching TransformerPredictor's "
             "artifact_root convention. Pass all four candidates' roots "
             "to compare them; mean_lambda is read from each root's own "
             "metrics.json, not from this flag."
    )
    parser.add_argument(
        "--val-season", type=int, default=VAL_SEASON,
        help=f"Validation season to score (default {VAL_SEASON}, the "
             "pre-registered lambda-selection fold)."
    )
    parser.add_argument(
        "--data-dir", type=Path, default=Path("data"),
        help="nflverse pull cache dir (default 'data')."
    )
    parser.add_argument("--first-season", type=int, default=2012)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    table = select_lambda(
        args.root, val_season=args.val_season,
        data_dir=args.data_dir, first_season=args.first_season,
    )
    print(table.to_string(index=False))
    winner = table.iloc[0]
    print(
        f"\nselected mean_lambda = {winner['mean_lambda']:g} "
        f"(root {winner['root']}, ppr_mae {winner['ppr_mae']:.4f})"
    )


if __name__ == "__main__":
    main()
