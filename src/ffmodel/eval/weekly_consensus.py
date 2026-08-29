"""Weekly expert-consensus benchmark driver: assembles the full measurement.

`eval/weekly_rankings.py` holds the tested primitives (leak-safe snapshot,
sign-safe goodness scores, per-week scoring, sanity tripwire). What did not
exist until this module was the DRIVER that runs them across every test
season and writes a committed artifact -- so the site's headline weekly claim
("Spearman 0.5940 vs 0.5958; the paired 95% interval on the gap includes
zero", docs/methodology.md section 3) rested on prose alone while every other
headline in this project is backed by a JSON in `models/diagnostics/`. This
module closes that gap. `eval/consensus.py` is the structural precedent
(driver + report writer + CLI); `models/diagnostics/consensus_benchmark.json`
is the precedent for report shape.

This is a MEASUREMENT, not a gate. Nothing is promoted or demoted by the
result, and no feature, hyperparameter, filter or window may be changed in
response to it -- re-specifying the measurement until it lands on the
documented figures would be precisely the p-hacking the project's methodology
forbids, and it would corrupt a public claim rather than correct it. If the
numbers disagree with the prose, the numbers are reported and the prose is
what has to move.

Three invariants, all inherited rather than reimplemented:

1. **Sign safety.** Every correlation goes through
   `weekly_rankings.score_week`, which is the only caller of
   `goodness_spearman`/`ecr_goodness`. `spearmanr` is never called here.
   `assert_model_sane` runs over the assembled cell frame before any number
   is reported.
2. **Leak safety.** The consensus snapshot for a week is
   `weekly_rankings.weekly_snapshot(rankings, kickoff)`: the latest scrape
   STRICTLY before that week's first kickoff and within `MAX_STALE_DAYS`.
   Weeks with no qualifying scrape are SKIPPED, never back-filled. On the
   model side the artifact for test season S is the `through{S-1}` fold
   (trained and early-stopped on seasons <= S-1) and the split is
   `walk_forward_splits`, so nothing from season S reaches the predictor.
3. **Conditioning.** The comparison is restricted to players who PLAYED --
   the inner join of a week's consensus snapshot with that week's realized
   stat lines. This is deliberate and is the whole point of the weekly
   result: season-long consensus wins largely on AVAILABILITY forecasting
   (methodology section 3), and at a one-week horizon, with the injury report
   already public, that edge is expected to evaporate. Conditioning on
   appearance is outcome-selected and would be indefensible as a SEASON-long
   headline; here it is the question being asked, and it is applied
   identically to both entrants, so neither side is advantaged by it.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.data.rankings import attach_gsis
from ffmodel.eval.splits import walk_forward_splits
# Reused rather than reimplemented so this report and mean_head_gate.json can
# never disagree about HOW a paired interval was computed. `_git_short_sha`
# is private-by-convention but lives in the same package; a second copy would
# be a second thing to keep correct.
from ffmodel.eval.mean_head_gate import _git_short_sha, paired_bootstrap
from ffmodel.eval.weekly_rankings import (
    MAX_STALE_DAYS, assert_model_sane, normalize_weekly_rankings, score_week,
    weekly_snapshot,
)
from ffmodel.scoring import PPR, PREDICTED_STATS, ScoringRules, fantasy_points
from ffmodel.site.draft import REPLACEMENT_RANK

V1_ROOTS = [Path("models/transformer/v1"), Path("models/transformer/v1_s43"),
            Path("models/transformer/v1_s44")]
TEST_SEASONS = [2023, 2024, 2025]
POSITION_ORDER = ["QB", "RB", "WR", "TE"]
# Fixed before this run produced a number, so the interval is reproducible.
# Not a tunable: no other value was tried.
BOOTSTRAP_SEED = 20260728
N_BOOT = 10000
MIN_CELL = 5

# The prose claim this module exists to back with an artifact, copied verbatim
# from docs/methodology.md section 3 ("Where it holds its own: weekly").
DOCUMENTED = {
    "source": "docs/methodology.md section 3 ('Where it holds its own: weekly')",
    "seasons": [2023, 2024, 2025],
    "sp_ours": 0.5940,
    "sp_consensus": 0.5958,
    "claim": "statistical tie: within-position rank correlation 0.594 vs "
             "0.596, a paired 95% interval that includes zero",
}
# Per-position figures the site quotes alongside the RB claim. PROVENANCE
# WARNING, verified against models/diagnostics/rb_oos_weekly.json: these are
# the 2020-22 OUT-OF-SAMPLE numbers (`context_all_positions`), NOT 2023-25.
# The site's paragraph runs them together with the 2023-25 tie, so a reader
# would reasonably expect them on this run's seasons; they are recorded here
# for that comparison, explicitly labelled with the seasons they came from.
DOCUMENTED_PER_POSITION = {
    "seasons": [2020, 2021, 2022],
    "source": "models/diagnostics/rb_oos_weekly.json -> context_all_positions",
    "deltas": {"QB": -0.0631, "RB": 0.0243, "TE": -0.0144, "WR": 0.0027},
}
# Absolute tolerance on each pooled Spearman for calling the prose reproduced.
# Fixed before results were seen. 0.01 is ~5x the documented gap itself, so it
# is a loose "same measurement" check, not a strict equality test; the verdict
# also requires the QUALITATIVE claim (interval includes zero) to hold.
REPRODUCTION_TOLERANCE = 0.01


def weekly_kickoffs(schedules: pd.DataFrame, season: int) -> dict[int, pd.Timestamp]:
    """First kickoff of each REG week -- the per-week leak boundary.

    The FIRST game of the week, not the player's own game: a Wednesday scrape
    is legal for a Thursday-night slate, but a Friday scrape is not, even for
    players who do not take the field until Sunday. Using each player's own
    kickoff would let a ranking published after Thursday night's results
    inform Sunday's players, which is exactly the leak
    `rankings.preseason_snapshot` was written to prevent at season scale.

    `game_type` is optional (pull_schedules already filters to REG and drops
    it); it is honored when present so a preseason game can never pull a
    week's boundary earlier than its real kickoff.
    """
    games = schedules[schedules["season"] == season]
    if "game_type" in games.columns:
        games = games[games["game_type"] == "REG"]
    if games.empty:
        raise ValueError(f"no REG games for season {season} -- cannot place "
                         f"the weekly consensus leak boundary")
    first = games.assign(gameday=pd.to_datetime(games["gameday"])).groupby(
        "week")["gameday"].min()
    return {int(week): ts for week, ts in first.items()}


def week_cell(played: pd.DataFrame, consensus: pd.DataFrame) -> pd.DataFrame:
    """One week's like-for-like comparison pool.

    `played`: player_id, position, our_pts, actual -- one row per player who
    recorded a REG stat line that week (that IS the "played" condition; the
    nflverse weekly frame has no row for a player who did not appear).
    `consensus`: player_id, ecr from that week's leak-safe snapshot.

    Inner join, so both entrants rank an IDENTICAL player set. An outer join
    would score each side on its own pool and measure universe coverage
    instead of ranking skill -- the failure mode `consensus.py`'s
    `spearman_topN_note` warns about at season scale.

    Consensus rows that resolve to the same player_id are already deduped
    upstream by `attach_gsis` (best rank kept); a defensive drop_duplicates
    here keeps a malformed snapshot from silently double-counting a player.
    """
    con = consensus[["player_id", "ecr"]].drop_duplicates(
        subset="player_id", keep="first")
    cell = played.merge(con, on="player_id", how="inner")
    return cell[["player_id", "position", "our_pts", "ecr", "actual"]].reset_index(
        drop=True)


def collect_cells(features: pd.DataFrame, schedules: pd.DataFrame,
                  rankings: pd.DataFrame, crosswalk: pd.DataFrame,
                  seasons: list[int], predict_season,
                  rules: ScoringRules = PPR,
                  max_stale_days: int = MAX_STALE_DAYS,
                  min_cell: int = MIN_CELL) -> tuple[pd.DataFrame, dict]:
    """Score every (season, week, position) cell across the test seasons.

    `predict_season(season, train, test) -> Series` returns our POINT
    projection (higher = better) for `test`, indexed like `test`. Taking the
    model as a callable keeps this orchestration -- the leak boundary, the
    join, the skip accounting -- unit-testable without torch or artifacts on
    disk, which is the only part of the pipeline that has ever carried a bug.

    Returns the per-cell frame `weekly_rankings.score_week` emits, plus
    provenance recording every week that was USED and every week that was
    SKIPPED with the reason. Skips are reported, never silent: a week dropped
    for want of a legal snapshot changes what the pooled number means.
    """
    rows: list[dict] = []
    provenance: dict[str, dict] = {}
    for season, train_idx, test_idx in walk_forward_splits(features, seasons):
        train, test = features.loc[train_idx], features.loc[test_idx]
        if test.empty:
            raise ValueError(f"no feature rows for test season {season}")
        our_pts = predict_season(season, train, test)
        actual = fantasy_points(test[PREDICTED_STATS], rules)
        scored_rows = pd.DataFrame({
            "player_id": test["player_id"].to_numpy(),
            "position": test["position"].to_numpy(),
            "week": test["week"].to_numpy().astype(int),
            "our_pts": np.asarray(our_pts, dtype=float),
            "actual": actual.to_numpy(),
        })

        used, skipped, pos_mismatch, snap_dates = [], [], 0, {}
        for week, kickoff in sorted(weekly_kickoffs(schedules, season).items()):
            snap = weekly_snapshot(rankings, kickoff, max_stale_days)
            if snap is None:
                skipped.append({"week": week, "reason": "no consensus scrape "
                                f"in [kickoff-{max_stale_days}d, kickoff)",
                                "kickoff": str(kickoff.date())})
                continue
            matched, match_stats = attach_gsis(snap, crosswalk)
            played = scored_rows[scored_rows["week"] == week]
            if played.empty:
                skipped.append({"week": week, "reason": "no realized stat "
                                "lines for this week", "kickoff": str(kickoff.date())})
                continue
            cell = week_cell(played, matched)
            if cell.empty:
                skipped.append({"week": week, "reason": "no ranked player "
                                "played", "kickoff": str(kickoff.date())})
                continue
            # Positions are taken from OUR frame (the same source as `actual`);
            # count disagreements with the FantasyPros page rather than
            # silently preferring one.
            con_pos = matched.set_index("player_id")["pos"]
            pos_mismatch += int((cell["position"].to_numpy()
                                 != con_pos.reindex(cell["player_id"]).to_numpy()).sum())
            rows.extend(score_week(cell, season, week, REPLACEMENT_RANK,
                                   min_cell=min_cell))
            used.append(week)
            snap_dates[str(week)] = {
                "kickoff": str(kickoff.date()),
                "snapshot": str(snap["scrape_date"].iloc[0].date()),
                "lead_days": int((kickoff - snap["scrape_date"].iloc[0]).days),
                "ranked": match_stats["ranked"],
                "match_rate": round(match_stats["match_rate"], 4),
                "compared": int(len(cell)),
            }
        provenance[str(season)] = {
            "weeks_used": used,
            "weeks_skipped": skipped,
            "position_disagreements_vs_fantasypros": pos_mismatch,
            "weeks": snap_dates,
        }

    scored = pd.DataFrame(rows, columns=["season", "week", "position", "n",
                                         "sp_ours", "sp_con", "hit_ours",
                                         "hit_con", "slots"])
    if scored.empty:
        raise ValueError("no scorable (season, week, position) cells -- refusing "
                         "to report a benchmark with no data")
    # Degenerate cells (no variance in one side, or a ranking tie everywhere)
    # have no defined rank correlation. They are DROPPED, never recorded as
    # 0.0: an invented zero would drag both entrants toward the middle and
    # shrink whatever real gap exists.
    finite = scored["sp_ours"].notna() & scored["sp_con"].notna()
    provenance["degenerate_cells_dropped"] = int((~finite).sum())
    return scored[finite].reset_index(drop=True), provenance


def _bootstrap(delta: np.ndarray, clusters: np.ndarray, seed: int) -> dict:
    return paired_bootstrap(delta, clusters, n_boot=N_BOOT, seed=seed)


def pooled_stats(scored: pd.DataFrame, seed: int = BOOTSTRAP_SEED) -> dict:
    """Pooled ours-vs-consensus over a set of cells, with both intervals.

    CELL-WEIGHTED: each (season, week, position) cell contributes one delta,
    unweighted by how many players are in it, so a 40-player WR cell and a
    6-player TE cell count equally. `n` is carried for transparency and is
    never used as a weight. This matches
    `models/diagnostics/rb_oos_weekly.json`, whose interval half-width
    (+-0.019 on 42 cells) is only consistent with a cell-level bootstrap --
    so `paired_bootstrap_ci95` here is the same quantity the site's "paired
    95% interval" refers to.

    `season_cluster_ci95` is a deliberately conservative sensitivity: weeks
    inside a season share a model fit, a data vintage and a league
    environment, so their deltas are correlated and the cell-level interval
    is optimistic. With only 3 seasons it is a 3-cluster bootstrap and is
    wide by construction -- reported so a reader can see how much of the
    precision comes from treating weeks as independent, never used as the
    headline. On a SINGLE-season slice it is null: resampling one cluster
    with replacement can only ever return that cluster, so the interval
    collapses to a point and would falsely read as "excludes zero".
    """
    delta = (scored["sp_ours"] - scored["sp_con"]).to_numpy()
    cell_boot = _bootstrap(delta, np.arange(len(delta)), seed)
    seasons = scored["season"].to_numpy()
    season_boot = (_bootstrap(delta, seasons, seed)
                   if len(np.unique(seasons)) > 1 else None)
    slots = int(scored["slots"].sum())
    return {
        "cells": int(len(scored)),
        "player_weeks": int(scored["n"].sum()),
        "sp_ours": round(float(scored["sp_ours"].mean()), 4),
        "sp_consensus": round(float(scored["sp_con"].mean()), 4),
        "delta": round(float(delta.mean()), 4),
        "paired_bootstrap_ci95": [round(v, 4) for v in cell_boot["ci95"]],
        "ci_excludes_zero": bool(cell_boot["excludes_zero"]),
        "season_cluster_ci95": ([round(v, 4) for v in season_boot["ci95"]]
                                if season_boot else None),
        "season_cluster_excludes_zero": (bool(season_boot["excludes_zero"])
                                         if season_boot else None),
        "cells_won_pct": round(float((delta > 0).mean() * 100), 1),
        "startsit_hit_rate_ours": (round(float(scored["hit_ours"].sum() / slots), 4)
                                   if slots else None),
        "startsit_hit_rate_consensus": (round(float(scored["hit_con"].sum() / slots), 4)
                                        if slots else None),
    }


def per_position(scored: pd.DataFrame, seed: int = BOOTSTRAP_SEED) -> list[dict]:
    """One pooled row per position, in a fixed order so the artifact diffs
    cleanly run over run."""
    out = []
    for pos in POSITION_ORDER:
        cells = scored[scored["position"] == pos]
        if cells.empty:
            continue
        row = {"position": pos}
        row.update(pooled_stats(cells, seed))
        out.append(row)
    return out


def per_season(scored: pd.DataFrame, seed: int = BOOTSTRAP_SEED) -> list[dict]:
    out = []
    for season in sorted(scored["season"].unique()):
        cells = scored[scored["season"] == season]
        row = {"season": int(season)}
        row.update(pooled_stats(cells, seed))
        out.append(row)
    return out


def compare_to_documented(overall: dict,
                          positions: list[dict],
                          documented: dict = DOCUMENTED,
                          tolerance: float = REPRODUCTION_TOLERANCE) -> dict:
    """Does this run back the prose the site publishes?

    Two conditions, both fixed before the run: the two pooled Spearmans each
    land within `tolerance` of the documented figures (a "same measurement"
    check), AND the qualitative claim -- the paired interval includes zero --
    still holds. A run that reproduces the point estimates but whose interval
    now excludes zero has NOT reproduced the claim, because "statistical tie"
    is the claim.

    Pure function of the numbers passed in, so the verdict beside them can
    never be a stale hand-typed string.
    """
    d_ours = overall["sp_ours"] - documented["sp_ours"]
    d_con = overall["sp_consensus"] - documented["sp_consensus"]
    within = abs(d_ours) <= tolerance and abs(d_con) <= tolerance
    tie_holds = not overall["ci_excludes_zero"]
    return {
        "documented": documented,
        "tolerance": tolerance,
        "measured_minus_documented": {"sp_ours": round(float(d_ours), 4),
                                      "sp_consensus": round(float(d_con), 4)},
        "point_estimates_within_tolerance": bool(within),
        "tie_claim_holds": bool(tie_holds),
        "reproduces": bool(within and tie_holds),
        "per_position_reference": {
            **DOCUMENTED_PER_POSITION,
            "measured_deltas_this_run": {p["position"]: p["delta"] for p in positions},
            "note": "The reference deltas are the 2020-22 OUT-OF-SAMPLE run "
                    "(rb_oos_weekly.json), not 2023-25. They are NOT expected "
                    "to match this run's seasons exactly, and a difference is "
                    "not evidence against either measurement -- it is a "
                    "different sample. Reported because the site's prose "
                    "presents them next to the 2023-25 tie without stating "
                    "which seasons they came from.",
        },
    }


def build_summary(overall: dict, positions: list[dict], comparison: dict) -> str:
    """Honest one-paragraph narrative derived purely from the computed
    numbers, so it cannot drift from the fields printed beside it."""
    lo, hi = overall["paired_bootstrap_ci95"]
    verdict = ("REPRODUCES" if comparison["reproduces"]
               else "DOES NOT REPRODUCE")
    tie = ("includes zero" if not overall["ci_excludes_zero"]
           else "EXCLUDES zero")
    head = (f"{verdict} the documented weekly claim. Pooled within-position "
            f"weekly Spearman over {overall['cells']} (season, week, position) "
            f"cells, conditional on players who played: ours "
            f"{overall['sp_ours']:.4f} vs weekly consensus "
            f"{overall['sp_consensus']:.4f}, delta {overall['delta']:+.4f} with "
            f"a paired 95% interval [{lo:+.4f}, {hi:+.4f}] that {tie}.")
    if not comparison["reproduces"]:
        diff = comparison["measured_minus_documented"]
        head += (f" Documented figures were {comparison['documented']['sp_ours']:.4f} "
                 f"vs {comparison['documented']['sp_consensus']:.4f} "
                 f"(measured minus documented: {diff['sp_ours']:+.4f} ours, "
                 f"{diff['sp_consensus']:+.4f} consensus; tolerance "
                 f"{comparison['tolerance']}).")
    wins = [p["position"] for p in positions if p["delta"] > 0]
    losses = [p["position"] for p in positions if p["delta"] <= 0]
    head += (f" By position, we out-rank consensus at {', '.join(wins) or 'no position'}"
             f" and lose at {', '.join(losses) or 'no position'}: "
             + "; ".join(f"{p['position']} {p['delta']:+.4f}" for p in positions) + ".")
    return head


def build_report(scored: pd.DataFrame, provenance: dict, seasons: list[int],
                 roots: list[Path], run_parameters: dict,
                 seed: int = BOOTSTRAP_SEED) -> dict:
    assert_model_sane(scored)               # sign tripwire, before any number ships
    overall = pooled_stats(scored, seed)
    positions = per_position(scored, seed)
    seasons_rows = per_season(scored, seed)
    comparison = compare_to_documented(overall, positions)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "experiment": "weekly-expert-consensus",
        "verdict": "REPRODUCES" if comparison["reproduces"] else "DOES NOT REPRODUCE",
        "claim_under_test": DOCUMENTED,
        "summary": build_summary(overall, positions, comparison),
        "measurement_not_a_gate": (
            "Nothing is promoted or demoted by this result. No feature, "
            "hyperparameter, staleness window, position filter or scoring "
            "choice was changed in response to it; the specification was "
            "fixed from docs/methodology.md and rb_oos_weekly.json before the "
            "run. Tuning any of them to land on the documented figures would "
            "be p-hacking a public claim."
        ),
        "design": {
            "question": "Conditional on a player suiting up, do we rank a "
                        "week's players within position as well as the weekly "
                        "expert consensus?",
            "test_seasons": sorted(int(s) for s in seasons),
            "consensus": f"FantasyPros weekly ECR (ecr_type='wp', weekly "
                         f"positional pages), staleness-guarded to scrapes "
                         f"within {MAX_STALE_DAYS} days of kickoff",
            "metric": "within-position Spearman per (season, week, position) "
                      "cell, pooled cell-weighted; scored through the "
                      "sign-safe primitives in eval/weekly_rankings.py "
                      "(goodness scores, one conversion point, "
                      "assert_model_sane tripwire). scipy.stats.spearmanr is "
                      "never called from this module.",
            "scoring": "ppr",
            "min_cell": MIN_CELL,
            "pooled_mean_weighting": "cell-weighted, NOT player-week-weighted: "
                                     "each (season, week, position) cell "
                                     "contributes one Spearman regardless of "
                                     "how many players it holds.",
        },
        "leak_safety": {
            "consensus_snapshot": "weekly_snapshot: the latest scrape STRICTLY "
                                  "before the week's FIRST kickoff and within "
                                  f"{MAX_STALE_DAYS} days. A week with no "
                                  "qualifying scrape is skipped, never "
                                  "back-filled with a post-kickoff or stale "
                                  "ranking. This repo has a documented "
                                  "incident (rankings.py, 2023 preseason) "
                                  "where a naive 'latest scrape' was one day "
                                  "AFTER week-1 kickoff.",
            "kickoff_definition": "first REG game of the week, not each "
                                  "player's own game -- a ranking published "
                                  "after Thursday night could otherwise "
                                  "inform Sunday's players.",
            "model": "artifact fold through{S-1} for test season S (trained "
                     "and early-stopped on seasons <= S-1); split is "
                     "eval.splits.walk_forward_splits (train season < S); lag "
                     "features are strictly prior games. No random splits.",
        },
        "conditioning": {
            "population": "players who PLAYED and were ranked -- the inner "
                          "join of the week's consensus snapshot with that "
                          "week's realized stat lines.",
            "why": "The season-long consensus edge is largely AVAILABILITY "
                   "forecasting (methodology section 3: the >=8-game cut "
                   "shrinks the season gap 0.123 -> 0.049). At a one-week "
                   "horizon the injury report is public, so this asks the "
                   "residual question: pure per-game ranking skill.",
            "fairness": "The filter is applied identically to both entrants "
                        "and both rank an IDENTICAL player set (inner join), "
                        "so it cannot advantage either side. It IS "
                        "outcome-selected and would be indefensible as a "
                        "season-long headline -- see consensus.py's "
                        "dnp_policy, which deliberately keeps zero-game "
                        "players in the season pool for that reason.",
        },
        "artifacts_evaluated": {
            "ensemble_roots": [p.as_posix() for p in roots],
            "folds_used": [f"through{s - 1}" for s in sorted(seasons)],
        },
        "run_parameters": {
            **run_parameters,
            "bootstrap_seed": seed,
            "n_boot": N_BOOT,
            "replacement_rank": dict(REPLACEMENT_RANK),
            "git_commit": _git_short_sha(),
        },
        "documented_comparison": comparison,
        "overall": overall,
        "per_position": positions,
        "per_season": seasons_rows,
        "provenance": provenance,
        "startsit_note": (
            "startsit_hit_rate_* is a SECONDARY diagnostic: the share of a "
            "week's realized top-`slots` (REPLACEMENT_RANK per position, "
            "capped at cell size) that each entrant's own top-`slots` "
            "captured. The headline is Spearman."
        ),
        "cells": scored.round(4).to_dict(orient="records"),
    }


def transformer_predictor(roots: list[Path], features: pd.DataFrame,
                          rules: ScoringRules = PPR):
    """`predict_season` callable backed by the committed v1 seed ensemble.

    Constructed once and refit per fold, mirroring mean_head_gate. Band
    calibration (p10/p90 scaling) is left at its shipped default because it
    provably cannot move this measurement: `_apply_calibration` leaves p50
    untouched, and only p50 is ranked here.
    """
    from ffmodel.model.predictor import TransformerPredictor

    predictor = TransformerPredictor(roots, features)

    def predict(season: int, train: pd.DataFrame, test: pd.DataFrame) -> pd.Series:
        predictor.fit(train)
        return fantasy_points(predictor.predict_quantiles(test)["p50"], rules)

    return predict


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark weekly within-position ranking against weekly "
                    "expert consensus (measurement, not a gate).")
    parser.add_argument("--seasons", nargs="+", type=int, default=TEST_SEASONS)
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--root", type=Path, action="append", default=None,
                        help="artifact root (repeatable); defaults to the v1 "
                             "seed ensemble")
    parser.add_argument("--out", type=Path,
                        default=Path("models/diagnostics/weekly_consensus.json"))
    return parser


def main() -> None:
    args = build_parser().parse_args()
    from ffmodel.data.features import build_features
    from ffmodel.data.pull import (LIVE_MAX_AGE_HOURS, _cached,
                                   pull_schedules, pull_weekly)
    from ffmodel.data.rankings import pull_player_ids

    seasons = sorted(args.seasons)
    roots = [Path(r) for r in (args.root or V1_ROOTS)]
    spans = list(range(args.first_season, max(seasons) + 1))
    weekly = pull_weekly(spans, cache_dir=args.data_dir)
    schedules = pull_schedules(spans, cache_dir=args.data_dir)
    features = build_features(weekly, schedules)

    def load_raw_rankings() -> pd.DataFrame:
        import nflreadpy

        return nflreadpy.load_ff_rankings("all").to_pandas()

    rankings = normalize_weekly_rankings(
        _cached(args.data_dir, "ff_rankings_all_raw", load_raw_rankings,
                LIVE_MAX_AGE_HOURS))
    crosswalk = pull_player_ids(args.data_dir)

    scored, provenance = collect_cells(
        features, schedules, rankings, crosswalk, seasons,
        transformer_predictor(roots, features),
    )
    report = build_report(
        scored, provenance, seasons, roots,
        run_parameters={
            "first_season": args.first_season,
            "feature_rows": int(len(features)),
            "max_stale_days": MAX_STALE_DAYS,
        },
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))

    print(f"VERDICT: {report['verdict']}")
    o = report["overall"]
    print(f"overall  ours={o['sp_ours']:.4f}  consensus={o['sp_consensus']:.4f}  "
          f"delta={o['delta']:+.4f}  ci95={o['paired_bootstrap_ci95']}  "
          f"cells={o['cells']}")
    for row in report["per_position"]:
        print(f"  {row['position']:<3} ours={row['sp_ours']:.4f} "
              f"con={row['sp_consensus']:.4f} delta={row['delta']:+.4f} "
              f"ci95={row['paired_bootstrap_ci95']} cells={row['cells']}")
    print(f"\nreport -> {args.out}")


if __name__ == "__main__":
    main()
