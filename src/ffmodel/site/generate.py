"""Site-JSON generator. Fail-safe: validate first, write atomically, never
leave a broken or partial file for the site to serve (spec §9)."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import pandas as pd

MIN_ROWS_PER_SEASON = 200


def validate_inputs(weekly: pd.DataFrame, schedules: pd.DataFrame, season: int) -> None:
    if weekly.empty:
        raise RuntimeError("weekly frame is empty — refusing to generate")
    counts = weekly.groupby("season").size()
    thin = counts[counts < MIN_ROWS_PER_SEASON]
    if not thin.empty:
        raise RuntimeError(f"suspiciously few rows in season(s) {list(thin.index)} "
                           f"— data pull looks incomplete")
    if schedules[schedules["season"] == season].empty:
        raise RuntimeError(f"no schedule rows for season {season}")


def _atomic_write(path: Path, payload: dict) -> None:
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(json.dumps(payload, indent=2, allow_nan=False))
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate the site's JSON payloads.")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", choices=["xgboost", "transformer"], required=True)
    parser.add_argument("--artifact-root", type=Path, default=None)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, default=None)
    parser.add_argument("--draft", action="store_true")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    return parser


def _make_predictor(args, features: pd.DataFrame):
    if args.model == "transformer":
        if args.artifact_root is None:
            raise SystemExit("--model transformer requires --artifact-root")
        from ffmodel.model.predictor import TransformerPredictor

        return TransformerPredictor(args.artifact_root, features)
    from ffmodel.baseline.xgb import XGBBaseline

    return XGBBaseline()


def main() -> None:
    args = build_parser().parse_args()
    from ffmodel.data.features import build_features
    from ffmodel.data.future import combined_future_features
    from ffmodel.data.pull import pull_schedules, pull_weekly
    from ffmodel.site.about import build_about
    from ffmodel.site.draft import build_draft_board
    from ffmodel.site.weekly import build_weekly_projections

    seasons = list(range(args.first_season, args.season + 1))
    weekly = pull_weekly(seasons, cache_dir=args.data_dir)
    schedules = pull_schedules(seasons, cache_dir=args.data_dir)
    validate_inputs(weekly, schedules, args.season)
    latest_season = int(weekly["season"].max())
    latest_week = int(weekly[weekly["season"] == latest_season]["week"].max())
    data_through = f"{latest_season}-wk{latest_week}"

    features = build_features(weekly, schedules)
    predictor = _make_predictor(args, features)
    predictor.fit(features)

    args.out.mkdir(parents=True, exist_ok=True)
    if args.week is not None:
        combined, future = combined_future_features(weekly, schedules,
                                                    args.season, args.week)
        if hasattr(predictor, "attach_features"):
            predictor.attach_features(combined)
        payload = build_weekly_projections(future, predictor, args.season,
                                           args.week, data_through)
        _atomic_write(args.out / "weekly.json", payload)
        print(f"weekly.json: {len(payload['players'])} players")
    if args.draft:
        board = build_draft_board(weekly, schedules, predictor,
                                  args.season, data_through)
        _atomic_write(args.out / "draft.json", board)
        print(f"draft.json: {len(board['players'])} players")
    backtests = sorted(Path("models/backtests").glob("*.json"))
    _atomic_write(args.out / "about.json", build_about(backtests, data_through))
    print("about.json written")


if __name__ == "__main__":
    main()
