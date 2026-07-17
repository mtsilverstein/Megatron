"""Draft-board backtest core (Plan 4 Phase A).

The walk-forward harness (`ffmodel.eval.harness`) scores *weekly* predictions;
the draft board — end-of-prior-season form rolled over a full schedule — has no
evaluation of its own. This module supplies the pieces to score a board against
what actually happened, honestly and leak-free:

- `board_world(weekly, S)`   — the "August world": everything strictly before
  season S. THE leak boundary.
- `season_actuals(weekly, S)`— each player's real REG-season fantasy total for S,
  scored over `PREDICTED_STATS` only (excluding 2-pt / ST-TD extras the model has
  no head for), exactly as `harness.run_backtest` scores weekly actuals, so board
  and weekly numbers are comparable.
- `board_metrics(board_players, actuals)` — per-position and OVERALL draft metrics
  over the draftable pool (top 2x replacement rank): season-points MAE, rank
  correlation, starter hit-rate, and season-band coverage.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.scoring import BAND_CONSTRUCTION, PPR, PREDICTED_STATS, ScoringRules, fantasy_points
from ffmodel.site.draft import REPLACEMENT_RANK

_VALID_POSITIONS = tuple(REPLACEMENT_RANK)          # QB, RB, WR, TE — v1 scope
_METRIC_COLUMNS = ["position", "n", "season_mae_topN", "spearman_topN",
                   "hit_rate_starters", "season_band_coverage"]


def board_world(weekly: pd.DataFrame, season: int) -> pd.DataFrame:
    """The August world for board season `season`: every weekly row strictly
    before it. The full nflverse pull spans 2012-2025, so this drops both the
    target season AND any later season. Returns a copy — callers mutate freely
    and the source frame is never a view."""
    return weekly[weekly["season"] < season].copy()


def season_actuals(weekly: pd.DataFrame, season: int,
                   rules: ScoringRules = PPR) -> pd.DataFrame:
    """Actual REG-season fantasy totals for `season`, one row per player who
    recorded a stat line. Scored over `PREDICTED_STATS` only — the same
    convention as the weekly harness, so a board player's projected total (also
    built from predicted stats) is compared like-for-like. Returns the FULL
    season-S leaderboard (not just board players); `board_metrics` needs it to
    know who the real top-R starters were."""
    rows = weekly[weekly["season"] == season]
    if rows.empty:
        raise ValueError(f"no weekly rows for season {season} — cannot score actuals")
    points = fantasy_points(rows[PREDICTED_STATS], rules)   # excludes SCORING_EXTRAS
    scored = rows[["player_id", "player_display_name", "position"]].copy()
    scored["points"] = points.to_numpy()
    agg = scored.groupby("player_id", sort=True).agg(
        name=("player_display_name", "last"),
        position=("position", "last"),
        actual_points=("points", "sum"),
        games=("points", "size"),
    ).reset_index()
    return agg[["player_id", "name", "position", "actual_points", "games"]]


def _safe_spearman(proj: np.ndarray, actual: np.ndarray) -> float:
    """Spearman rank correlation, guarded. Returns NaN for a pool too small to
    rank (< 2) or a constant vector — calling scipy on those emits a
    ConstantInputWarning, which is fatal under the suite's `-W error`."""
    if len(proj) < 2:
        return float("nan")
    if np.all(proj == proj[0]) or np.all(actual == actual[0]):
        return float("nan")
    from scipy.stats import spearmanr
    return float(spearmanr(proj, actual).correlation)


def _band_coverage(pool: list[dict], actual: np.ndarray) -> float:
    """Fraction of the pool whose actual total fell inside the projected p10-p90
    band. NaN for point-only entrants (naive/XGBoost) whose players carry no
    bands — computed only over players with both p10 and p90."""
    covered = total = 0
    for player, a in zip(pool, actual):
        band = player["season_points"]["ppr"]
        lo, hi = band["p10"], band["p90"]
        if lo is None or hi is None:
            continue
        total += 1
        if lo <= a <= hi:
            covered += 1
    return covered / total if total else float("nan")


def _base_row(position: str, pool: list[dict], actual_by_id: dict) -> dict:
    """Everything but hit-rate (which the caller fills, since OVERALL sums
    integer hit counts rather than averaging per-position rates)."""
    proj = np.array([p["season_points"]["ppr"]["p50"] for p in pool], dtype=float)
    actual = np.array([float(actual_by_id.get(p["player_id"], 0.0)) for p in pool],
                      dtype=float)
    mae = float(np.mean(np.abs(proj - actual))) if len(proj) else float("nan")
    return {"position": position, "n": len(pool),
            "season_mae_topN": mae, "spearman_topN": _safe_spearman(proj, actual),
            "hit_rate_starters": float("nan"),
            "season_band_coverage": _band_coverage(pool, actual)}


def _starter_hits(pool: list[dict], leaderboard: pd.DataFrame, rank: int) -> int:
    """How many of the board's projected top-R at a position finished in the
    season's actual top-R (from the full position leaderboard, so a breakout the
    board never listed correctly costs it a slot)."""
    board_top_r = {p["player_id"] for p in pool[:rank]}      # pool is proj-desc
    actual_top_r = set(
        leaderboard.sort_values(["actual_points", "player_id"],
                                ascending=[False, True])["player_id"].head(rank)
    )
    return len(board_top_r & actual_top_r)


def board_metrics(board_players: list[dict], actuals: pd.DataFrame,
                  replacement_rank: dict[str, int] = REPLACEMENT_RANK) -> pd.DataFrame:
    """Score a board (a list of player dicts as `build_draft_board` emits) against
    `season_actuals`. One row per position present, plus OVERALL. All metrics are
    over the draftable pool = the board's projected top-N at each position, N =
    2x replacement rank. Hit-rate compares the board's projected top-R starters
    against the season's *actual* top-R at the position (from the full
    leaderboard, so missing a breakout rookie is charged as a miss)."""
    if not board_players:
        raise ValueError("cannot score an empty board")
    bad = sorted({p["position"] for p in board_players} - set(_VALID_POSITIONS))
    if bad:
        raise ValueError(f"board has out-of-scope positions {bad} "
                         f"(v1 supports {list(_VALID_POSITIONS)})")

    actual_by_id = dict(zip(actuals["player_id"], actuals["actual_points"]))
    present = [pos for pos in _VALID_POSITIONS
               if any(p["position"] == pos for p in board_players)]

    rows, union_pool = [], []
    total_hits = total_slots = 0
    for pos in present:
        rank = replacement_rank[pos]
        ranked = sorted(
            (p for p in board_players if p["position"] == pos),
            key=lambda p: (-p["season_points"]["ppr"]["p50"], p["player_id"]),
        )
        pool = ranked[:2 * rank]
        hits = _starter_hits(pool, actuals[actuals["position"] == pos], rank)
        row = _base_row(pos, pool, actual_by_id)
        row["hit_rate_starters"] = hits / rank
        rows.append(row)
        union_pool.extend(pool)
        total_hits += hits
        total_slots += rank

    overall = _base_row("OVERALL", union_pool, actual_by_id)
    overall["hit_rate_starters"] = total_hits / total_slots if total_slots else float("nan")
    rows.append(overall)
    return pd.DataFrame(rows, columns=_METRIC_COLUMNS)


# --- the CLI: run the backtest across board seasons (Plan 4 Phase A2) ------

def _data_through(world: pd.DataFrame) -> str:
    season = int(world["season"].max())
    week = int(world[world["season"] == season]["week"].max())
    return f"{season}-wk{week}"


def run_board_backtest(weekly: pd.DataFrame, schedules: pd.DataFrame,
                       seasons: list[int], make_entrants, rules: ScoringRules = PPR
                       ) -> pd.DataFrame:
    """For each board season S: reconstruct the leak-free "August world"
    (`weekly` strictly before S), fit each entrant on it, generate a board
    through the PRODUCTION `build_draft_board` path, and score it against S's
    actual season totals. `make_entrants(features)` is a callable returning a
    fresh list of predictors for that season (the transformer needs the
    season's world features at construction); mirrors `generate.py`'s fit flow
    exactly, so nothing from season S can reach a predictor or the board.
    Returns one metrics DataFrame concatenated over (model, board_season)."""
    if rules.name != "ppr":
        raise ValueError(
            "run_board_backtest only supports PPR: board metrics read the "
            f"'ppr' season_points lens; got rules.name={rules.name!r}"
        )

    from ffmodel.data.features import build_features
    from ffmodel.site.draft import build_draft_board

    tables = []
    for season in sorted(seasons):
        world = board_world(weekly, season)             # weekly[season < S]
        if world.empty:
            raise ValueError(f"board season {season}: no prior-season data to seed from")
        sched_s = schedules[schedules["season"] <= season]   # generate.py uses <= S
        features = build_features(world, sched_s)
        train = features[features["season"] < season]   # == features (world is all < S)
        actuals = season_actuals(weekly, season, rules)
        data_through = _data_through(world)
        for entrant in make_entrants(features):
            entrant.fit(train)
            board = build_draft_board(world, sched_s, entrant, season,
                                      data_through, prefit=True)
            metrics = board_metrics(board["players"], actuals)
            metrics.insert(0, "board_season", season)
            metrics.insert(0, "model", entrant.name)
            tables.append(metrics)
    return pd.concat(tables, ignore_index=True)


def _board_report(results: pd.DataFrame, seasons: list[int],
                  transformer_roots) -> dict:
    records = results.astype(object).where(pd.notna(results), None).to_dict("records")
    return {
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "board_seasons": sorted(int(s) for s in seasons),
        "scoring": "ppr",
        "band_construction": BAND_CONSTRUCTION,
        # provenance: which artifact roots the transformer rows used (single
        # seed vs ensemble is invisible from the metrics alone). as_posix() so
        # the recorded paths are forward-slash on every platform (this backtest
        # may run on Windows locally or Linux in Actions).
        "transformer_roots": ([Path(r).as_posix() for r in transformer_roots]
                              if transformer_roots else None),
        "results": records,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Draft-board walk-forward backtest.")
    parser.add_argument("--seasons", nargs="+", type=int, default=[2023, 2024, 2025])
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--out", type=Path,
                        default=Path("models/backtests/board_backtest.json"))
    parser.add_argument("--transformer-root", type=Path, action="append", default=None,
                        help="e.g. models/transformer/v1 — adds the transformer "
                             "entrant. Repeatable to average a seed ensemble.")
    return parser


def _make_entrants(transformer_roots, features):
    from ffmodel.baseline.naive import NaiveLast4
    from ffmodel.baseline.xgb import XGBBaseline

    entrants = [NaiveLast4(), XGBBaseline()]
    if transformer_roots:
        from ffmodel.model.predictor import TransformerPredictor
        entrants.append(TransformerPredictor(list(transformer_roots), features))
    return entrants


def main() -> None:
    args = build_parser().parse_args()
    from ffmodel.data.pull import pull_schedules, pull_weekly

    seasons = sorted(args.seasons)
    spans = list(range(args.first_season, max(seasons) + 1))
    weekly = pull_weekly(spans, cache_dir=args.data_dir)
    schedules = pull_schedules(spans, cache_dir=args.data_dir)

    results = run_board_backtest(
        weekly, schedules, seasons,
        lambda features: _make_entrants(args.transformer_root, features),
    )
    report = _board_report(results, seasons, args.transformer_root)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))

    overall = results[results["position"] == "OVERALL"]
    print(overall[["model", "board_season", "season_mae_topN", "spearman_topN",
                   "hit_rate_starters", "season_band_coverage"]].to_string(index=False))
    print(f"\nfull report -> {args.out}")


if __name__ == "__main__":
    main()
