"""Consensus benchmark: our preseason board vs FantasyPros expert consensus.

The question every internal baseline leaves unanswered — is this board
better than what a drafter gets for free? Both entrants are scored by the
SAME `board_metrics` function against realized end-of-season finish, so no
bespoke metric path can quietly favor either side.

This is a MEASUREMENT, not a gate. Nothing is promoted or demoted by the
result, and no feature or hyperparameter may be changed in response to it —
that would be tuning against held-out data (spec 2026-07-21).

Consensus publishes ranks, not points, so its board carries
`season_points.ppr.p50 = -ecr` (strictly decreasing in rank, making every
rank-based metric exact) with p10/p90 absent. Points-SCALED metrics are
meaningless on that synthetic scale: bands fall out as NaN via the existing
point-only-entrant path, and `season_mae_topN` is explicitly nulled.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.eval.board import (
    _safe_spearman, board_metrics, board_world, season_actuals,
)
from ffmodel.scoring import PPR, ScoringRules

CONSENSUS_MODEL = "consensus"
# Metrics that only mean something on a real points scale. Consensus ranks
# are mapped to a synthetic one, so publishing these for it would be noise
# dressed as a number.
POINTWISE_METRICS = ["season_mae_topN"]
SENSITIVITY_MIN_GAMES = 8


def consensus_board(matched: pd.DataFrame) -> list[dict]:
    """Shape consensus rows into the player-dict contract `board_metrics`
    consumes (as `build_draft_board` emits).

    `p50 = -ecr` is a strictly decreasing transform of rank, so pool
    selection, hit-rate and Spearman are exact under it. p10/p90 stay None:
    consensus has no bands, and `_band_coverage` already skips point-only
    entrants rather than inventing coverage for them.
    """
    board = []
    for row in matched.itertuples(index=False):
        board.append({
            "player_id": row.player_id,
            "name": row.player,
            "position": row.pos,
            "team": row.team,
            "ecr": float(row.ecr),
            "season_points": {"ppr": {"p10": None, "p50": -float(row.ecr),
                                      "p90": None}},
        })
    return board


def null_pointwise_metrics(frame: pd.DataFrame) -> pd.DataFrame:
    """Blank the points-scaled metrics on consensus rows (see module docstring)."""
    out = frame.copy()
    mask = out["model"] == CONSENSUS_MODEL
    for col in POINTWISE_METRICS:
        if col in out.columns:
            out[col] = out[col].astype(object)
            out.loc[mask, col] = None
    return out


def common_universe_spearman(ours: list[dict], theirs: list[dict],
                             actual_by_id: dict, games_by_id: dict,
                             min_games: int | None = None,
                             position: str | None = None) -> dict:
    """Rank correlation for both entrants over the players BOTH ranked.

    Scoring each entrant on its own pool answers "how well did you order
    your own recommendations"; this answers the cleaner question of pure
    ranking skill, with universe coverage held constant.

    `min_games` is an OUTCOME-SELECTED sensitivity cut (a player's game
    count is only knowable after the season). It is a labeled diagnostic
    and must never be reported as the headline.
    """
    ours_by_id = {p["player_id"]: p for p in ours}
    theirs_by_id = {p["player_id"]: p for p in theirs}
    common = set(ours_by_id) & set(theirs_by_id)
    if position is not None:
        common = {pid for pid in common if ours_by_id[pid]["position"] == position}
    if min_games is not None:
        common = {pid for pid in common
                  if float(games_by_id.get(pid, 0.0)) >= min_games}
    ordered = sorted(common)          # deterministic

    actual = np.array([float(actual_by_id.get(pid, 0.0)) for pid in ordered],
                      dtype=float)
    proj_ours = np.array(
        [float(ours_by_id[pid]["season_points"]["ppr"]["p50"]) for pid in ordered],
        dtype=float)
    proj_theirs = np.array(
        [float(theirs_by_id[pid]["season_points"]["ppr"]["p50"]) for pid in ordered],
        dtype=float)
    return {
        "position": position or "OVERALL",
        "n_common": len(ordered),
        "n_ours_only": len(set(ours_by_id) - set(theirs_by_id)),
        "n_theirs_only": len(set(theirs_by_id) - set(ours_by_id)),
        "min_games": min_games,
        "spearman_ours": _safe_spearman(proj_ours, actual),
        "spearman_consensus": _safe_spearman(proj_theirs, actual),
    }


def run_consensus_benchmark(weekly: pd.DataFrame, schedules: pd.DataFrame,
                            seasons: list[int], make_entrants,
                            cache_dir: Path | None = None,
                            draft_picks: pd.DataFrame | None = None,
                            rules: ScoringRules = PPR) -> dict:
    """Score every entrant plus the consensus for each board season.

    The leak-free preamble mirrors `run_board_backtest` (same world, same
    schedule slice, same fit flow) but ADDS `draft_picks`, which
    `run_board_backtest` omits.

    That addition is load-bearing for fairness: without it
    `build_draft_board` skips the rookie frame entirely, so our entrant
    cannot rank any rookie while consensus ranks the whole class. Rookies
    filled 25 of 228 starter slots across 2023-25 and consensus hit 10 of
    them, so omitting them charged us ~4.4 points of an ~8.7-point gap for
    a limitation the SHIPPED board does not have (generate.py passes
    draft_picks). Leak-free: the class comes from `season == S` (an April
    draft precedes a September kickoff) and its cohort prior is fit on
    `season < S`.
    """
    if rules.name != "ppr":
        raise ValueError("consensus benchmark only supports PPR")

    from ffmodel.data.features import build_features
    from ffmodel.data.rankings import consensus_for_season
    from ffmodel.eval.board import _data_through
    from ffmodel.site.draft import build_draft_board

    tables, universe, provenance = [], [], {}
    for season in sorted(seasons):
        world = board_world(weekly, season)                 # weekly[season < S]
        if world.empty:
            raise ValueError(f"board season {season}: no prior-season data")
        sched_s = schedules[schedules["season"] <= season]
        features = build_features(world, sched_s)
        train = features[features["season"] < season]
        actuals = season_actuals(weekly, season, rules)
        data_through = _data_through(world)
        actual_by_id = dict(zip(actuals["player_id"], actuals["actual_points"]))
        games_by_id = dict(zip(actuals["player_id"], actuals["games"]))
        picks_s = (draft_picks[draft_picks["season"] <= season]
                   if draft_picks is not None else None)

        matched, stats = consensus_for_season(season, schedules, cache_dir)
        provenance[str(season)] = stats
        con_board = consensus_board(matched)
        con_metrics = board_metrics(con_board, actuals)
        con_metrics.insert(0, "board_season", season)
        con_metrics.insert(0, "model", CONSENSUS_MODEL)
        tables.append(con_metrics)

        for entrant in make_entrants(features):
            entrant.fit(train)
            board = build_draft_board(world, sched_s, entrant, season,
                                      data_through, prefit=True,
                                      draft_picks=picks_s)
            metrics = board_metrics(board["players"], actuals)
            metrics.insert(0, "board_season", season)
            metrics.insert(0, "model", entrant.name)
            tables.append(metrics)
            # OVERALL + per position; the positional rows hold player sets
            # genuinely identical on both sides, so they are the defensible
            # form of the comparison (the OVERALL row scores a draft-value
            # ranking against realized raw points, which handicaps consensus).
            for pos in (None, "QB", "RB", "WR", "TE"):
                for mg in (None, SENSITIVITY_MIN_GAMES):
                    row = {"board_season": season, "model": entrant.name}
                    row.update(common_universe_spearman(
                        board["players"], con_board, actual_by_id, games_by_id,
                        min_games=mg, position=pos))
                    universe.append(row)

    results = null_pointwise_metrics(pd.concat(tables, ignore_index=True))
    records = results.astype(object).where(pd.notna(results), None).to_dict("records")
    return {
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "board_seasons": sorted(int(s) for s in seasons),
        "scoring": "ppr",
        "measurement_not_a_gate": (
            "Nothing is promoted or demoted by this result, and no feature or "
            "hyperparameter may be changed in response to it — that would be "
            "tuning against held-out data."
        ),
        "pre_registered_expectation": (
            "We expect to LOSE to consensus on hit-rate and Spearman: ECR "
            "aggregates hundreds of analysts pricing in injuries, depth charts "
            "and scheme changes that this model never sees. A win should "
            "trigger a bug hunt before a celebration. n=3 seasons carries the "
            "same small-sample caution that sank feature-pack v2."
        ),
        "dnp_policy": (
            "Ranked players who never played score 0 and remain in the pool. "
            "Excluding them would be selection on the outcome and would erase a "
            "genuine consensus strength (fading injury/camp-battle risk)."
        ),
        "spearman_topN_note": (
            "spearman_topN is computed over EACH ENTRANT'S OWN draftable pool "
            "(different player sets), so it is NOT a like-for-like comparison "
            "and must not be read as evidence either side ranks better. Our "
            "pool contains players consensus correctly excluded, whose "
            "near-zero finishes are trivially easy to order -- a range-"
            "restriction effect that inflates our correlation. Use "
            "`common_universe` (identical player sets) for ranking skill; on "
            "the per-position rows there, consensus wins every cell."
        ),
        "rookie_note": (
            "Our entrants are built WITH draft_picks, so they rank rookies "
            "exactly as the shipped board does. Omitting them would charge us "
            "for slots we structurally could not fill while consensus ranks "
            "the whole class."
        ),
        "consensus_provenance": provenance,
        "common_universe": universe,
        "sensitivity_cut_note": (
            f"Rows with min_games={SENSITIVITY_MIN_GAMES} are an "
            "OUTCOME-SELECTED diagnostic, never the headline."
        ),
        "results": records,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark the draft board against expert consensus (ECR).")
    parser.add_argument("--seasons", nargs="+", type=int, default=[2023, 2024, 2025])
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--out", type=Path,
                        default=Path("models/diagnostics/consensus_benchmark.json"))
    parser.add_argument("--transformer-root", type=Path, action="append", default=None)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    from ffmodel.data.pull import pull_draft_picks, pull_schedules, pull_weekly
    from ffmodel.eval.board import _make_entrants

    seasons = sorted(args.seasons)
    spans = list(range(args.first_season, max(seasons) + 1))
    weekly = pull_weekly(spans, cache_dir=args.data_dir)
    schedules = pull_schedules(spans, cache_dir=args.data_dir)
    # rookies: the shipped board ranks them, so the benchmark must too
    draft_picks = pull_draft_picks(spans, cache_dir=args.data_dir)

    report = run_consensus_benchmark(
        weekly, schedules, seasons,
        lambda features: _make_entrants(args.transformer_root, features),
        cache_dir=args.data_dir, draft_picks=draft_picks,
    )
    report["transformer_roots"] = ([Path(r).as_posix() for r in args.transformer_root]
                                   if args.transformer_root else None)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))

    res = pd.DataFrame(report["results"])
    overall = res[res["position"] == "OVERALL"]
    print(overall[["model", "board_season", "hit_rate_starters",
                   "spearman_topN"]].to_string(index=False))
    print(f"\nreport -> {args.out}")


if __name__ == "__main__":
    main()
