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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Walk-forward backtest.")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--last-season", type=int, default=2025)
    parser.add_argument("--test-seasons", nargs="+", type=int,
                        default=[2023, 2024, 2025])
    parser.add_argument("--out", type=Path,
                        default=Path("models/backtests/baselines.json"))
    parser.add_argument("--transformer-root", type=Path, default=None,
                        help="e.g. models/transformer/v1 — adds the transformer entrant")
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
        "results": records,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))

    overall = results[results["position"] == "OVERALL"]
    print(overall.groupby("model")[["mae", "rmse"]].mean().round(3))
    print(f"\nfull report -> {args.out}")


if __name__ == "__main__":
    main()
