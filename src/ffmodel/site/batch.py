"""One process, one input snapshot, one fit: the in-season legacy + neutral batch.

Spec 2026-10-01 §3.5 and §10. The weekly Actions job used to run
`generate.py --week auto --remaining` once per league; every run pulled its
own inputs and fit its own predictor, so the two leagues' files could describe
different snapshots, and a remaining-season failure was skipped. This module
replaces that loop. It:

1. refuses a non-empty `--out` (the stage must hold this run's files only);
2. pulls every input once -- weekly stats, schedules, current teams, the
   Sleeper catalog (refetched when older than 24 hours), the optional
   preseason ECR snapshot, the week's kickoffs -- resolves the week once and
   fits the predictor once;
3. builds, in memory, each league's legacy `weekly*.json` and
   `remaining-<slug>.json` exactly as `generate.py` does today (same helpers,
   same serializers), except that a remaining-season failure is FATAL: during
   coexistence the legacy files share the neutral batch's transaction;
4. builds the shared legacy `kickoffs.json`, `roles.json` and `about.json`
   once, and the neutral `neutral/{weekly,remaining,players,evaluation,formats}.json`
   under one `BatchContext`;
5. writes everything, then `manifest.json` (every written file + sha256) LAST.
   A run that fails anywhere leaves no manifest, and `ffmodel.site.publish`
   refuses a stage without one.

PREDICTOR STATE. `remaining.build_remaining` re-attaches the shared predictor
to each horizon's feature frame and leaves it on the last one, and the
transformer reads test rows BY INDEX from the attached frame. So every
current-week build (each league's weekly payload and the neutral weekly) runs
before any remaining-season build, and each one re-attaches the current-week
frame first, as `generate.py` does before its own weekly build.

`generate.py` stays the entry point for `--draft` and manual runs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

SUPPORTED_LEAGUES = ("gabagool", "fam")
REFERENCE_LEAGUE = "gabagool"   # whose diagnostic another league may borrow (remaining.load_evaluation)
NEUTRAL_DIR = "neutral"
MANIFEST = "manifest.json"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Write one in-season batch (legacy per-league files + the neutral batch) "
                    "into an empty stage directory.")
    parser.add_argument("--out", type=Path, required=True, help="EMPTY stage directory")
    # The neutral `method` descriptor describes the transformer seed ensemble;
    # publishing it for another model would be a false claim.
    parser.add_argument("--model", choices=["transformer"], required=True)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=str, required=True, help="'auto' or a week number")
    parser.add_argument("--leagues", type=str, required=True,
                        help="comma-separated league slugs, e.g. gabagool,fam")
    parser.add_argument("--artifact-root", type=str, required=True,
                        help="comma-separated artifact roots, in the predictor's order")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--debug-full-precision", type=Path, default=None,
                        help="also write the unrounded neutral remaining blocks here "
                             "(parity reference; never published)")
    return parser


def parse_args(argv=None) -> argparse.Namespace:
    parser = build_parser()
    args = parser.parse_args(argv)
    slugs = [s.strip() for s in args.leagues.split(",") if s.strip()]
    if not slugs or len(set(slugs)) != len(slugs):
        parser.error(f"--leagues must name distinct leagues, got {args.leagues!r}")
    unsupported = [s for s in slugs if s not in SUPPORTED_LEAGUES]
    if unsupported:
        parser.error(f"--leagues supports Sleeper leagues {list(SUPPORTED_LEAGUES)} only, "
                     f"got {unsupported}")
    args.slugs = slugs
    args.roots = [p.strip() for p in args.artifact_root.split(",") if p.strip()]
    if not args.roots:
        parser.error(f"--artifact-root is empty: {args.artifact_root!r}")
    return args


def _stage_is_empty(out: Path) -> bool:
    if not out.exists():
        return True
    return out.is_dir() and not any(out.iterdir())


def _load_ecr_rows(season, schedules, data_dir):
    """The preseason ECR snapshot, on GSIS ids, or None. Optional: never fails the batch.

    Same path as the draft board's ECR spine (`generate._draft_consensus`):
    draft picks pulled and canonicalized, then `generate._load_consensus`.
    Its `player_id` is the nflverse identity feed's `gsis_id`, the id the
    weekly projections carry (`normalize_ecr_snapshot` / `attach_gsis`).
    The rows are pre-checked with the exact rule `build_players` applies, so a
    malformed feed degrades to `ecr: null` instead of failing the batch."""
    try:
        from ffmodel.data.pull import pull_draft_picks
        from ffmodel.site import generate as gen
        from ffmodel.site.neutral import _ecr

        draft_picks = pull_draft_picks(list(range(2012, season + 1)), cache_dir=data_dir)
        draft_picks, _ = gen._canonicalize_draft_picks(draft_picks, data_dir, target_season=season)
        matched, _stats = gen._load_consensus(season, schedules, data_dir, draft_picks)
        rows = matched[["player_id", "ecr", "scrape_date", "fp_page"]].copy()
        _ecr(rows)
        return rows
    except Exception as exc:  # noqa: BLE001 - optional reference feed
        print(f"ECR unavailable ({exc}); neutral/players.json publishes ecr and ecr_source as null")
        return None


def build_batch(args) -> tuple[dict, object, dict | None]:
    """Every payload of the batch, keyed by its stage-relative path; nothing written.

    Returns (payloads, ctx, full_precision) where `full_precision` is the
    unrounded neutral remaining blocks when `--debug-full-precision` is set."""
    from ffmodel.data.features import build_features
    from ffmodel.data.future import combined_future_features
    from ffmodel.data.pull import pull_schedules, pull_weekly
    from ffmodel.data.rosters import assert_roster_coverage, pull_current_teams
    from ffmodel.league import load_league
    from ffmodel.site import generate as gen
    from ffmodel.site import remaining as remaining_mod
    from ffmodel.site.about import build_about
    from ffmodel.site.evidence_records import build_evaluation
    from ffmodel.site.kickoffs import pull_kickoffs
    from ffmodel.site.method import current_method
    from ffmodel.site.neutral import (LAST_PROJECTED_WEEK, build_players, empty_remaining,
                                      format_table, make_batch_context, neutral_weekly)
    from ffmodel.site.pick_sixes import load_pick_six_prior
    from ffmodel.site.roles import build_roles
    from ffmodel.site.sleeper import pull_sleeper_players
    from ffmodel.site.weekly import build_weekly_projections, set_league_rules

    season = args.season
    leagues = [load_league(slug) for slug in args.slugs]
    reference = load_league(REFERENCE_LEAGUE)

    # ---- inputs, each pulled once (as generate.main does for one league) ----
    weekly = pull_weekly(list(range(args.first_season, season)), cache_dir=args.data_dir)
    schedules = pull_schedules(list(range(args.first_season, season + 1)), cache_dir=args.data_dir)
    weekly = gen._extend_with_target_season(weekly, schedules, season, args.data_dir)
    gen.validate_inputs(weekly, schedules, season)
    season_games = schedules[schedules["season"] == season]
    scheduled_teams = set(season_games["home_team"]) | set(season_games["away_team"])
    current_teams = pull_current_teams(season, cache_dir=args.data_dir,
                                       scheduled_teams=scheduled_teams)
    assert_roster_coverage(current_teams, scheduled_teams)
    sleeper_players = pull_sleeper_players(cache_dir=args.data_dir, max_age_hours=24)
    ecr_rows = _load_ecr_rows(season, schedules, args.data_dir)

    latest_season = int(weekly["season"].max())
    latest_week = int(weekly[weekly["season"] == latest_season]["week"].max())
    data_through = f"{latest_season}-wk{latest_week}"     # about.json: full observed data
    week = gen.resolve_week(args.week, weekly, schedules, season)
    projection_history, projection_through = gen.history_before_week(weekly, season, week)
    kickoffs = pull_kickoffs(season, week)
    roles = build_roles(weekly, schedules, season, week)

    # ---- one fit ----
    features = build_features(weekly, schedules)
    predictor = gen._make_predictor(args, features)
    train = features[features["season"] < season]
    predictor.fit(train)
    fit_through = int(train["season"].max())

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    ctx = make_batch_context(season, week, projection_through, generated_at)
    neutral_prior = load_pick_six_prior(season)
    method = current_method(args.roots, neutral_prior, through=fit_through)
    priors = {}
    for cfg in leagues:
        # As generate.main: the expected pick-six cost only where it costs points.
        priors[cfg.slug] = load_pick_six_prior(season) if cfg.rules.pass_int_td else None
        print(f"{cfg.slug}: pick-six expected cost "
              + ("not applied (pass_int_td 0)" if priors[cfg.slug] is None
                 else f"rate {priors[cfg.slug]['rate']:.4%}"))

    # ---- every current-week build, before any remaining-season build ----
    combined, future = combined_future_features(projection_history, schedules, season, week,
                                                current_teams)

    def current_week(prior):
        if hasattr(predictor, "attach_features"):
            predictor.attach_features(combined)
        return build_weekly_projections(future, predictor, season, week, projection_through,
                                        pick_six_prior=prior, generated_at=generated_at)

    payloads: dict[str, dict] = {}
    for cfg in leagues:
        set_league_rules(cfg.rules)
        payload = current_week(priors[cfg.slug])
        payload["league"] = cfg.payload()
        payloads[cfg.weekly_file] = payload
    # The neutral weekly drops the `league` lens, so the active rules do not reach it.
    weekly_n = neutral_weekly(current_week(neutral_prior), ctx, neutral_prior, method)

    # ---- remaining season: FATAL on failure (spec §3.5 coexistence transaction) ----
    for cfg in leagues:
        set_league_rules(cfg.rules)
        try:
            evaluation = remaining_mod.load_evaluation(
                cfg.slug, cfg.sleeper_scoring, reference_scoring=reference.sleeper_scoring)
            payloads[f"remaining-{cfg.slug}.json"] = remaining_mod.build_remaining(
                weekly, schedules, predictor, season, week,
                current_teams=current_teams, league=cfg.payload(),
                end_week=max(week, 17), pick_six_prior=priors[cfg.slug],
                evaluation=evaluation, generated_at=generated_at)
        except Exception as exc:
            raise RuntimeError(f"remaining-season payload for {cfg.slug} failed; the batch "
                               f"publishes all files or none: {exc}") from exc
    full_precision = {} if args.debug_full_precision is not None else None
    if week > LAST_PROJECTED_WEEK:
        remaining_n = empty_remaining(ctx, predictor.name)
    else:
        remaining_n = remaining_mod.build_remaining(
            weekly, schedules, predictor, season, week, current_teams=current_teams,
            end_week=LAST_PROJECTED_WEEK, pick_six_prior=neutral_prior,
            generated_at=generated_at, emit="neutral", full_precision_out=full_precision,
            ctx=ctx, method=method)

    payloads["kickoffs.json"] = kickoffs
    payloads["roles.json"] = roles
    backtests = gen.require_backtests(sorted(Path("models/backtests").glob("*.json")))
    payloads["about.json"] = build_about(backtests, data_through, site_model=predictor.name)

    payloads[f"{NEUTRAL_DIR}/weekly.json"] = weekly_n
    payloads[f"{NEUTRAL_DIR}/remaining.json"] = remaining_n
    payloads[f"{NEUTRAL_DIR}/players.json"] = build_players(
        ctx, weekly_n, remaining_n, sleeper_players, ecr_rows, schedules)
    payloads[f"{NEUTRAL_DIR}/evaluation.json"] = build_evaluation(ctx)
    payloads[f"{NEUTRAL_DIR}/formats.json"] = {
        **ctx.header(), "schema_version": 1, "kind": "neutral_formats", "formats": format_table()}
    return payloads, ctx, full_precision


def _compact(rel: str) -> bool:
    # Today's serializer choice (generate.py): remaining-season files compact.
    return Path(rel).name.startswith("remaining")


def write_stage(out: Path, payloads: dict, ctx) -> dict:
    """Write every payload with the production serializer, then the manifest last."""
    from ffmodel.site import publish
    from ffmodel.site.generate import _atomic_write

    remaining_text = json.dumps(payloads[f"{NEUTRAL_DIR}/remaining.json"],
                                separators=(",", ":"), allow_nan=False)
    size = len(remaining_text.encode("utf-8"))
    if size > publish.SIZE_CAP_BYTES:
        raise RuntimeError(f"neutral/remaining.json is oversize ({size} bytes > cap "
                           f"{publish.SIZE_CAP_BYTES}); players or weeks are never dropped to fit")
    out.mkdir(parents=True, exist_ok=True)
    files = []
    for rel, payload in payloads.items():
        path = out / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(path, payload, compact=_compact(rel))
        data = path.read_bytes()
        files.append({"path": rel, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
        print(f"{rel}: written" + (f" ({len(payload['players'])} players)"
                                   if isinstance(payload.get("players"), list) else ""))
    manifest = {**ctx.header(), "schema_version": 1, "kind": "batch_manifest", "files": files}
    _atomic_write(out / MANIFEST, manifest)
    print(f"{MANIFEST}: written ({len(files)} files, batch {ctx.batch_id})")
    return manifest


def _write_full_precision(path: Path, full: dict) -> None:
    doc = {pid: {str(w): blocks for w, blocks in weeks.items()} for pid, weeks in full.items()}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, allow_nan=False), encoding="utf-8")
    print(f"full-precision neutral remaining written to {path} (not published)")


def main(argv=None) -> int:
    args = parse_args(argv)
    if not _stage_is_empty(args.out):
        print(f"batch refused: --out {args.out} is not empty; the stage must hold this run's "
              f"files only", file=sys.stderr)
        return 2
    from ffmodel.site import weekly as weekly_mod

    # set_league_rules mutates a process-global; restore it whatever happens.
    saved_rules = weekly_mod.RULESETS["league"]
    try:
        payloads, ctx, full_precision = build_batch(args)
        write_stage(args.out, payloads, ctx)
    except Exception:  # noqa: BLE001 - any failure: nonzero exit, no manifest
        traceback.print_exc()
        print("batch FAILED: no manifest written; publish will refuse this stage", file=sys.stderr)
        return 1
    finally:
        weekly_mod.set_league_rules(saved_rules)
    if full_precision is not None:
        _write_full_precision(args.debug_full_precision, full_precision)
    return 0


if __name__ == "__main__":
    sys.exit(main())
