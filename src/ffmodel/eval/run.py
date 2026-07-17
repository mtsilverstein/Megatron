"""Run the full walk-forward backtest and write the committed JSON report."""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from ffmodel.baseline.naive import NaiveLast4
from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.data.features import build_features
from ffmodel.data.pull import pull_schedules, pull_weekly
from ffmodel.eval.harness import run_backtest
from ffmodel.model.train import _run_is_complete
from ffmodel.scoring import BAND_CONSTRUCTION


def discover_ensemble_roots(base_root: Path) -> list[Path]:
    """Discover complete seed-ensemble siblings of `base_root` (e.g.
    `models/transformer/v1_s43`, `v1_s44` next to `models/transformer/v1`)
    so the bake-off always scores exactly what could deploy.

    Always returns `base_root` first -- it's assumed to exist and be
    usable; a missing base means there's nothing to evaluate at all, which
    is a config error, not a normal "no ensemble" case, so that raises
    rather than returning an empty/partial list.

    A sibling `{base_root.name}_s*` joins the list only if it has EXACTLY
    the same set of `through*` subdirs as the base AND every one of those
    has a `metrics.json` with `complete: true` (via `_run_is_complete`,
    reused from `ffmodel.model.train` rather than duplicated). A seed that's
    still training mid-Studio-Lab-session, or only covers some folds, must
    never silently join an eval and skew the ensemble average -- such
    siblings are excluded with a printed warning naming the root and the
    reason, not raised, since a partial seed is an expected, non-fatal
    state and Run All should keep working around it.
    """
    if not base_root.exists():
        raise ValueError(
            f"discover_ensemble_roots: base root does not exist: {base_root}"
        )

    def _through_dirs(root: Path) -> set[str]:
        return {p.name for p in root.iterdir() if p.is_dir() and p.name.startswith("through")}

    base_through = _through_dirs(base_root)
    roots = [base_root]

    siblings = sorted(
        (p for p in base_root.parent.glob(f"{base_root.name}_s*") if p.is_dir()),
        key=lambda p: p.name,
    )
    for sibling in siblings:
        sibling_through = _through_dirs(sibling)
        if sibling_through != base_through:
            missing = sorted(base_through - sibling_through)
            extra = sorted(sibling_through - base_through)
            print(
                f"discover_ensemble_roots: excluding {sibling} -- through-dirs "
                f"don't match {base_root.name} (missing={missing}, extra={extra})"
            )
            continue
        incomplete = sorted(
            d for d in sibling_through
            if not _run_is_complete(sibling / d / "metrics.json")
        )
        if incomplete:
            print(
                f"discover_ensemble_roots: excluding {sibling} -- incomplete "
                f"runs: {incomplete}"
            )
            continue
        roots.append(sibling)
    return roots


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Walk-forward backtest.")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--last-season", type=int, default=2025)
    parser.add_argument("--test-seasons", nargs="+", type=int,
                        default=[2023, 2024, 2025])
    parser.add_argument("--out", type=Path,
                        default=Path("models/backtests/baselines.json"))
    parser.add_argument("--transformer-root", type=Path, action="append", default=None,
                        help="e.g. models/transformer/v1 — adds the transformer entrant. "
                             "Repeatable: pass it more than once (e.g. "
                             "--transformer-root models/transformer/v1_s43 "
                             "--transformer-root models/transformer/v1_s44) to average "
                             "multiple seed artifacts as one ensembled entrant. A single "
                             "occurrence behaves exactly as before.")
    return parser


def main() -> None:
    args = build_parser().parse_args()

    seasons = list(range(args.first_season, args.last_season + 1))
    weekly = pull_weekly(seasons, cache_dir=args.data_dir)
    schedules = pull_schedules(seasons, cache_dir=args.data_dir)
    features = build_features(weekly, schedules)

    predictors = [NaiveLast4(), XGBBaseline()]
    if args.transformer_root is not None:
        from ffmodel.model.predictor import TransformerPredictor
        predictors.append(TransformerPredictor(args.transformer_root, features))
    results = run_backtest(features, predictors, test_seasons=args.test_seasons)

    records = results.astype(object).where(pd.notna(results), None).to_dict(orient="records")
    report = {
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seasons": [args.first_season, args.last_season],
        "test_seasons": sorted(args.test_seasons),
        "scoring": "ppr",
        "band_construction": BAND_CONSTRUCTION,
        # provenance: which artifact roots the "transformer" rows scored —
        # a single root vs a seed ensemble is invisible from the metrics alone
        "transformer_roots": ([str(r) for r in args.transformer_root]
                              if args.transformer_root is not None else None),
        "results": records,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))

    overall = results[results["position"] == "OVERALL"]
    print(overall.groupby("model")[["mae", "rmse"]].mean().round(3))
    print(f"\nfull report -> {args.out}")


if __name__ == "__main__":
    main()
