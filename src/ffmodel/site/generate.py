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
    parser.add_argument("--returning", default=str(RETURNING_CONFIG),
                        help="YAML list of players returning from a "
                             "season-ending injury (--draft only)")
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


# The live board's league: 12-team, dedicated 1 QB / 2 RB / 2 WR / 1 TE per
# team (x12), plus 2 FLEX per team (24 league-wide). Replacement is DERIVED
# from these + the ECR pool (flex split falls out of the rankings), not guessed.
LEAGUE_DEDICATED = {"QB": 12, "RB": 24, "WR": 24, "TE": 12}
LEAGUE_FLEX_SLOTS = 24


def _load_consensus(season, schedules, data_dir, draft_picks=None):
    from ffmodel.data.rankings import consensus_for_season
    return consensus_for_season(season, schedules, data_dir, draft_picks=draft_picks)


# A silent data repair is a bug in this project (see attach_gsis's docstring
# on Justin Jefferson/Lamar Jackson): crosswalk match stats must reach the
# published payload, not be computed and thrown away. `unmatched_players` is
# a name list, though, and an unbounded one from a future badly-broken feed
# could be huge -- cap it and say so explicitly rather than silently cutting
# it off. `unmatched` (the count) is never truncated; it is the real signal.
UNMATCHED_PLAYERS_LIMIT = 50


def _bounded_stats(stats: dict) -> dict:
    """Copy of `stats` safe to publish: `unmatched_players`, if present and
    longer than `UNMATCHED_PLAYERS_LIMIT`, is truncated to a prefix and
    `unmatched_players_truncated` is set True so the cut is visible rather
    than silent. All other keys pass through unchanged."""
    out = dict(stats)
    names = out.get("unmatched_players")
    if isinstance(names, list) and len(names) > UNMATCHED_PLAYERS_LIMIT:
        out["unmatched_players"] = names[:UNMATCHED_PLAYERS_LIMIT]
        out["unmatched_players_truncated"] = True
    else:
        out["unmatched_players_truncated"] = False
    return out


def _canonicalize_draft_picks(draft_picks, data_dir):
    """Rewrite draft-picks placeholder gsis ids to the identity feed's
    canonical id (`canonicalize_draft_gsis`), joined on PFR's stable id.

    Called once, immediately after `pull_draft_picks`, before either the ECR
    spine or the rookie board rows see the frame -- so both key off the same
    id space instead of disagreeing on rookies whose draft-picks id is still
    a name-derived placeholder while the identity feed has since been
    repaired to the canonical id. Returns (draft_picks, n_rewritten).
    """
    from ffmodel.data.rankings import canonicalize_draft_gsis, pull_player_ids

    crosswalk = pull_player_ids(data_dir)
    return canonicalize_draft_gsis(draft_picks, crosswalk)


def _load_adp(season, data_dir, draft_picks=None):
    """Sleeper-population ADP for the draft board (preferred): this
    project's actual league is a Sleeper keeper league, so the committed
    FantasyPros/Sleeper snapshot (data_snapshots/) matches that population
    far better than FFCalculator's self-selected mock-draft crowd. Falls
    back to the live FFCalculator pull only if the snapshot file is
    missing (e.g. before a season's snapshot has been captured yet).

    Returns (adp_df, source) so the draft-board payload can record which
    path actually ran -- honestly, even on the fallback.

    K/DST: the snapshot never carries a Sleeper ADP for them (see adp.py's
    `parse_snapshot_csv`), so this function's output is always QB/RB/WR/TE
    regardless of which source ran. `_late_slots()` below stays pinned to
    FFCalculator's raw payload for K/DST specifically -- do not repoint it
    at this snapshot, it would silently go empty.

    `draft_picks`: when supplied, blank `gsis_id` rows in the identity feed
    are restored from the draft-picks source before matching, exactly as the
    ECR spine does. This is load-bearing, not defensive. nflverse's
    player-id feed temporarily omits `gsis_id` for the current rookie class;
    on 2026-07-28 that dropped this crosswalk to 89.8% and the >=95% guard
    correctly refused to publish a partial ADP overlay, so the live board
    shipped with no ADP at all and the keeper gauge lost its market anchor.
    The ECR path was repaired for the same drift in `4ad0871`; ADP reads the
    same feed and needs the same repair, or the two disagree about who
    exists.
    """
    from ffmodel.data.adp import SNAPSHOT_PATH, load_snapshot_adp, pull_adp, snapshot_date
    from ffmodel.data.rankings import _backfill_draft_gsis, pull_player_ids

    if SNAPSHOT_PATH.exists():
        crosswalk = pull_player_ids(data_dir)
        backfilled = 0
        if draft_picks is not None:
            crosswalk, backfilled = _backfill_draft_gsis(crosswalk, draft_picks)
        adp_df, stats = load_snapshot_adp(SNAPSHOT_PATH, crosswalk)
        source = {"source": "sleeper_snapshot",
                 "path": SNAPSHOT_PATH.as_posix(),
                 "snapshot_date": snapshot_date(SNAPSHOT_PATH),
                 "gsis_backfilled_from_draft_picks": backfilled}
        # Match provenance (matched_by_position/matched_by_name/unmatched/
        # unmatched_players/match_rate): computed by normalize_snapshot_adp
        # and previously discarded here -- fold it into the same provenance
        # block so it actually reaches the published draft.json.
        source.update(_bounded_stats(stats))
        return adp_df, source
    return pull_adp(season, cache_dir=data_dir), {"source": "ffcalculator"}


def _late_slots(season, data_dir):
    """Raw K/DST ADP for the late-round slot reminder (display-only)."""
    import json
    import urllib.request

    from ffmodel.data.adp import late_slot_adp

    url = ("https://fantasyfootballcalculator.com/api/v1/adp/ppr"
           f"?teams=12&year={season}&position=all")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    return late_slot_adp(raw)


def _roster_override_stats(payload, current_teams: dict[str, str]) -> dict:
    """How far the current-team override actually reached, for the artifact.

    `covered` is the number of board players the roster feed could speak for;
    `unmapped` kept their last-played team. A sudden collapse in `covered`
    means the feed changed shape, and that is the failure this records --
    the board would still render, just quietly back on stale teams.

    ON `unmapped_above_replacement`, which reads worse than it is: on the 2026
    board it is 4, and all four are ROOKIES. A rookie carries a placeholder
    player_id (`LOV121782`), not a gsis id, so he cannot join the roster feed
    at all -- but he also has no last-played team to be stale about. His team
    comes from his draft team via the draft-capital path, which is already
    current. The number to watch is a VETERAN appearing here; that would be a
    real player projected in last season's offense.
    """
    players = payload.get("players") or []
    covered = [p for p in players if p.get("player_id") in current_teams]
    unmapped = [p for p in players if p.get("player_id") not in current_teams]
    return {
        "source": "nflreadpy.load_rosters",
        "roster_rows": len(current_teams),
        "board_players": len(players),
        "covered": len(covered),
        "unmapped": len(unmapped),
        # The tail we knowingly leave on last-known teams. If this ever climbs
        # above replacement it stops being a tail and needs a decision.
        "unmapped_above_replacement": sum(
            1 for p in unmapped if (p.get("vorp") or 0) > 0),
    }


def _attach_late_slots(payload, season, data_dir):
    """Best-effort: the board never depends on K/DST ADP, so a failure just
    yields empty lists and the UI degrades to a generic reminder."""
    try:
        payload["late_slots"] = _late_slots(season, data_dir)
    except Exception as exc:                     # noqa: BLE001 - overlay is optional
        print(f"K/DST ADP unavailable ({exc}); late-slot lists will be empty")
        payload["late_slots"] = {"K": [], "DST": []}
    return payload


RETURNING_CONFIG = Path("configs/returning_players.yaml")


def _load_returning(path: Path, weekly: pd.DataFrame, season: int) -> set[str]:
    """Resolve the hand-maintained returning-from-injury list to player_ids.

    A name that matches nobody RAISES rather than being skipped -- a typo'd
    star would otherwise leave his floor quietly wrong, which is the exact bug
    the list exists to fix.

    The season stamp is checked ASYMMETRICALLY, because the two mismatches mean
    opposite things. A list OLDER than the board is stale -- someone forgot to
    update it, and last year's injuries silently discounting this year's board
    is worse than no list at all -- so that raises. A list NEWER than the board
    just means the board predates it, which is the normal state of a historical
    or backtest run (`--season 2023` against a 2026 list); that skips with a
    notice, because crashing an unrelated backtest on this file would be a
    footgun with no safety value.

    A missing file is NOT an error: a season with nobody returning is a real
    state, and requiring an empty file to express it invites a stale one."""
    if not path.exists():
        return set()
    import yaml
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    stamped = doc.get("season")
    if stamped is not None and int(stamped) != int(season):
        if int(stamped) < int(season):
            raise ValueError(
                f"{path} is stamped season {stamped} but the board is {season} — "
                f"refusing to apply a stale returning-player list. Update the file."
            )
        print(f"{path} is stamped season {stamped}; board is {season} — "
              f"returning-player list NOT applied (board predates the list)")
        return set()
    names = [str(n).strip() for n in (doc.get("players") or []) if str(n).strip()]
    if not names:
        return set()
    # Most recent appearance wins: a player who missed ALL of last season is
    # absent from it entirely, so his id has to come from an earlier one.
    hist = weekly.sort_values("season")
    by_name = dict(zip(hist["player_display_name"], hist["player_id"]))
    resolved, missing = set(), []
    for n in names:
        pid = by_name.get(n)
        if pid is None:
            missing.append(n)
        else:
            resolved.add(pid)
    if missing:
        raise ValueError(
            f"{path}: no player history matches {missing} — names must match the "
            f"board exactly. Fix the spelling or remove the entry."
        )
    return resolved


def _draft_consensus(season, schedules, data_dir, *, draft_picks=None):
    """ECR is the required spine (raise -> abort the run, fail-safe); ADP is a
    best-effort overlay (failure -> None/None, board still builds). Replacement
    is derived from the ECR pool so the flex split is not a guess.

    Returns (ecr, adp, replacement, adp_source, consensus_stats); adp_source
    records which ADP path actually produced `adp` (see `_load_adp`) so the
    published board can say honestly which one it used -- None whenever
    `adp` itself is None. consensus_stats is attach_gsis's match-provenance
    dict (matched_by_id, matched_by_name_position, unmatched, ...), bounded
    for publication -- ECR is required, so this is never None."""
    from ffmodel.site.board_rank import flex_replacement_ranks

    if draft_picks is None:
        ecr_df, consensus_stats = _load_consensus(season, schedules, data_dir)
    else:
        ecr_df, consensus_stats = _load_consensus(season, schedules, data_dir, draft_picks)
    ecr = dict(zip(ecr_df["player_id"], ecr_df["ecr"]))
    pool = ecr_df.rename(columns={"pos": "position"})[["position", "ecr"]]
    replacement = flex_replacement_ranks(pool, LEAGUE_DEDICATED, LEAGUE_FLEX_SLOTS)
    try:
        adp_df, adp_source = _load_adp(season, data_dir, draft_picks=draft_picks)
        adp = dict(zip(adp_df["player_id"], adp_df["adp"]))
    except Exception as exc:                     # noqa: BLE001 - overlay is optional
        print(f"ADP unavailable ({exc}); board builds without the market overlay")
        adp, adp_source = None, None
    return ecr, adp, replacement, adp_source, _bounded_stats(consensus_stats)


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
    draft_picks = None
    if args.draft:
        # Fetched BEFORE any model work or file writes: a Sleeper outage
        # aborts the whole run fail-safe (site keeps last-good data,
        # including the last-good crosswalk). Weekly-only runs never
        # reach this import.
        from ffmodel.site.sleeper import pull_sleeper_players

        sleeper_players = pull_sleeper_players(cache_dir=args.data_dir)

        # WHERE EACH PLAYER PLAYS NOW. Without this the board projects every
        # player on the team of his last PLAYED game -- last December in the
        # preseason -- so offseason moves are stale and, because team selects
        # the opponent through the schedule join, the model is handed the wrong
        # offense and the wrong matchup. Measured at 16.2% of the 2026 board
        # wrong before, 0.2% after (see ffmodel.data.rosters).
        #
        # Deliberately NOT wrapped in a try/except: a failed roster pull aborts
        # the run like any other, and the site keeps its last-good board. A
        # board published with one player in six on the wrong team is precisely
        # the bad data the fail-safe rule exists to withhold.
        from ffmodel.data.rosters import pull_current_teams

        current_teams = pull_current_teams(args.season, cache_dir=args.data_dir)

        from ffmodel.data.pull import pull_draft_picks

        draft_picks = pull_draft_picks(list(range(2012, args.season + 1)),
                                       cache_dir=args.data_dir)
        # Canonicalize BEFORE either consumer below sees the frame (see
        # `_canonicalize_draft_picks`'s docstring) -- then let the existing
        # `_backfill_draft_gsis` (inside `_load_consensus`/`_load_adp`) run as
        # it does today; the two are then consistent, since anything still on
        # a placeholder id is on that same placeholder id on both sides.
        draft_picks, n_gsis_canonicalized = _canonicalize_draft_picks(
            draft_picks, args.data_dir)

        ecr, adp, replacement, adp_source, consensus_stats = _draft_consensus(
            args.season, schedules, args.data_dir, draft_picks=draft_picks)

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
        returning = _load_returning(Path(args.returning), weekly, args.season)
        if returning:
            print(f"returning-from-injury: {len(returning)} player(s) "
                  f"({args.returning}) — bands use the measured post-injury "
                  f"availability, not their healthy cohort")
        board_payload = build_draft_board(
            weekly, schedules, predictor, args.season, data_through, prefit=True,
            sleeper_players=sleeper_players, draft_picks=draft_picks,
            ecr=ecr, adp=adp, replacement_rank=replacement, returning=returning,
            current_teams=current_teams)
        # Provenance, same rule as adp_source and draft_gsis_canonicalized
        # below: this override silently rewrites an input the model is
        # sensitive to, so how far it reached must be inspectable on the
        # published artifact rather than inferred.
        board_payload["roster_override"] = _roster_override_stats(
            board_payload, current_teams)
        # Provenance: which ADP source actually fed the board (sleeper_snapshot
        # + its capture date, or the ffcalculator fallback) -- so the site can
        # say honestly where its market overlay came from.
        board_payload["adp_source"] = adp_source
        # Provenance next to adp_source's own gsis-repair count: a silent
        # data repair is a bug in this project, so the rewrite count from
        # the OTHER direction (draft-picks -> canonical, not the identity
        # feed's blank-backfill) must be visible on the published artifact
        # too, and unconditionally (adp_source itself can be None -- see
        # `_draft_consensus` -- so this cannot live nested inside it).
        board_payload["draft_gsis_canonicalized"] = n_gsis_canonicalized
        # Provenance: attach_gsis's ENTIRE match-stats dict (matched_by_id,
        # matched_by_name_position, unmatched, unmatched_players, ...) was
        # computed by consensus_for_season and discarded here for a long
        # time -- long enough that matched_by_id silently sat at 0 (the
        # primary id join matching nothing, every row falling through to the
        # name-only path) with nobody noticing, because the counters were
        # never on the published artifact to look at. Same rule as
        # adp_source above: a silent data repair is a bug, so it must be
        # inspectable.
        board_payload["consensus"] = consensus_stats
        payloads["draft.json"] = _attach_late_slots(board_payload, args.season, args.data_dir)
    backtests = require_backtests(sorted(Path("models/backtests").glob("*.json")))
    payloads["about.json"] = build_about(backtests, data_through, site_model=predictor.name)

    args.out.mkdir(parents=True, exist_ok=True)
    for name, payload in payloads.items():
        _atomic_write(args.out / name, payload)
        print(f"{name}: written"
              + (f" ({len(payload['players'])} players)" if "players" in payload else ""))


if __name__ == "__main__":
    main()
