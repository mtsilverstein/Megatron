"""Site-JSON generator. Fail-safe: validate first, write atomically, never
leave a broken or partial file for the site to serve (spec §9)."""
from __future__ import annotations

import argparse
import json
import os
import sys
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
    parser.add_argument("--artifact-root", type=str, default=None,
                         help="single artifact root (e.g. models/transformer/v1), or "
                              "comma-separated roots (e.g. models/transformer/v1_s43,"
                              "models/transformer/v1_s44) to average as a seed ensemble")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=str, default=None)
    parser.add_argument("--draft", action="store_true")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    return parser


def parse_and_validate(argv=None) -> argparse.Namespace:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.week is None and not args.draft:
        parser.error("provide --week and/or --draft")
    return args


def resolve_week(week, weekly: pd.DataFrame, schedules: pd.DataFrame, season: int) -> int:
    if week != "auto":
        return int(week)
    played = set(weekly[weekly["season"] == season]["week"])
    scheduled = sorted(set(schedules[schedules["season"] == season]["week"]))
    remaining = [w for w in scheduled if w not in played]
    if not remaining:
        raise RuntimeError(f"season {season} has no unplayed scheduled weeks left")
    return int(remaining[0])


def _season_has_completed_game(schedules: pd.DataFrame, season: int) -> bool:
    """True if any `season` game in `schedules` has a final score.

    Distinguishes the legitimate pre-week-1 state (nflverse's player-stats
    file for a season 404s until week 1 is actually played, even though the
    schedule is already published) from a genuine mid-season upstream data
    outage, where a failing stats pull must not be papered over.
    """
    if "home_score" not in schedules.columns or "away_score" not in schedules.columns:
        # Should not happen -- pull_schedules always includes these columns
        # (see the schedules_v2 cache bump in ffmodel.data.pull) -- but if a
        # hand-built or stale frame slips through, don't guess: fail safe.
        raise RuntimeError(
            "schedules frame is missing home_score/away_score columns needed "
            "to detect completed games -- if this is a local run, clear the "
            "data/raw schedules cache and re-pull"
        )
    season_games = schedules[schedules["season"] == season]
    return bool(season_games["home_score"].notna().any()
                or season_games["away_score"].notna().any())


def _extend_with_target_season(weekly: pd.DataFrame, schedules: pd.DataFrame,
                                season: int, data_dir: Path | None) -> pd.DataFrame:
    """Append the target season's weekly stats onto `weekly`, tolerating the
    pre-week-1 state where nflverse's player-stats file for `season` doesn't
    exist yet.

    If the pull fails: zero completed `season` games in `schedules` means
    the season genuinely hasn't started (proceed with prior-season data
    only, unchanged); any completed game means the pull *should* have
    returned data, so the failure is a real upstream outage and must abort
    (fail-safe, mid-season breakage must not be skipped).
    """
    from ffmodel.data.pull import pull_weekly

    try:
        current = pull_weekly([season], cache_dir=data_dir)
    except Exception as exc:
        if _season_has_completed_game(schedules, season):
            raise RuntimeError(
                f"target-season {season} weekly stats pull failed and "
                "schedules show completed game(s) this season -- aborting "
                f"(fail-safe, mid-season data must not be skipped): {exc}"
            ) from exc
        print(f"NOTICE: {season} weekly stats pull failed ({exc}); schedules "
              f"show zero completed {season} games -- treating this as the "
              "pre-week-1 state and proceeding with prior-season data only.",
              file=sys.stderr)
        return weekly
    return pd.concat([weekly, current], ignore_index=True)


def require_backtests(paths: list[Path]) -> list[Path]:
    if not paths:
        raise RuntimeError("models/backtests contains no reports — refusing to "
                           "publish an empty about page")
    return paths


def _make_predictor(args, features: pd.DataFrame):
    if args.model == "transformer":
        if args.artifact_root is None:
            raise SystemExit("--model transformer requires --artifact-root")
        from ffmodel.model.predictor import TransformerPredictor

        # Comma-separated roots average as a seed ensemble (predictor.py's
        # multi-root support does the averaging); a single root is just a
        # one-element list, so this is exactly the pre-ensemble behavior.
        roots = [Path(p.strip()) for p in args.artifact_root.split(",") if p.strip()]
        if not roots:
            raise SystemExit(f"--artifact-root is empty: {args.artifact_root!r}")
        return TransformerPredictor(roots, features)
    from ffmodel.baseline.xgb import XGBBaseline

    return XGBBaseline()


def main() -> None:
    args = parse_and_validate()
    from ffmodel.data.features import build_features
    from ffmodel.data.future import combined_future_features
    from ffmodel.data.pull import pull_schedules, pull_weekly
    from ffmodel.site.about import build_about
    from ffmodel.site.draft import build_draft_board
    from ffmodel.site.weekly import build_weekly_projections

    weekly = pull_weekly(list(range(args.first_season, args.season)),
                         cache_dir=args.data_dir)
    schedules = pull_schedules(list(range(args.first_season, args.season + 1)),
                               cache_dir=args.data_dir)
    if args.week is not None:
        # in-season weekly needs the target season's played games; preseason
        # draft-only runs never request the (gameless, possibly-404ing)
        # target season. Before week 1 actually kicks off, nflverse's
        # player-stats file for the target season may not exist yet even
        # though the schedule is already published -- _extend_with_target_season
        # tolerates that specific case and re-raises anything else.
        weekly = _extend_with_target_season(weekly, schedules, args.season, args.data_dir)
    validate_inputs(weekly, schedules, args.season)

    sleeper_players = None
    if args.draft:
        # Fetched BEFORE any model work or file writes: a Sleeper outage
        # aborts the whole run fail-safe (site keeps last-good data,
        # including the last-good crosswalk). Weekly-only runs never
        # reach this import.
        from ffmodel.site.sleeper import pull_sleeper_players

        sleeper_players = pull_sleeper_players(cache_dir=args.data_dir)

    latest_season = int(weekly["season"].max())
    latest_week = int(weekly[weekly["season"] == latest_season]["week"].max())
    data_through = f"{latest_season}-wk{latest_week}"

    week = (resolve_week(args.week, weekly, schedules, args.season)
            if args.week is not None else None)

    features = build_features(weekly, schedules)
    predictor = _make_predictor(args, features)
    predictor.fit(features[features["season"] < args.season])

    # Build every payload first: a failure here must leave ALL existing
    # site files untouched (spec §9 fail-safe).
    payloads: dict[str, dict] = {}
    if week is not None:
        combined, future = combined_future_features(weekly, schedules,
                                                    args.season, week)
        if hasattr(predictor, "attach_features"):
            predictor.attach_features(combined)
        payloads["weekly.json"] = build_weekly_projections(
            future, predictor, args.season, week, data_through)
    if args.draft:
        payloads["draft.json"] = build_draft_board(
            weekly, schedules, predictor, args.season, data_through, prefit=True,
            sleeper_players=sleeper_players)
    backtests = require_backtests(sorted(Path("models/backtests").glob("*.json")))
    payloads["about.json"] = build_about(backtests, data_through, site_model=predictor.name)

    args.out.mkdir(parents=True, exist_ok=True)
    for name, payload in payloads.items():
        _atomic_write(args.out / name, payload)
        print(f"{name}: written"
              + (f" ({len(payload['players'])} players)" if "players" in payload else ""))


if __name__ == "__main__":
    main()
