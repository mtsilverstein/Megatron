"""Diagnostics: leak-free games-played cohorts, a projection-vs-actual rate
decomposition, and week-to-week persistence (ICC). This is the measurement
layer a later Monte-Carlo simulation validates against — every number here
must be reproducible from the frames handed in, nothing cached at import
time. Same leak-freedom rule as the rest of `ffmodel.eval`: no module-level
data constants, only pure config (REPLACEMENT_RANK, PREDICTED_STATS, ...).

- `availability_table` / `availability_summary` — for each season pair
  (S'-1 -> S'), take the top-2xreplacement cohort by S'-1 production and
  measure how many games THEY actually played in S' (busts and retirements
  count as 0 -- no survivorship bias). Pooled across the most recent `pairs`
  such pairs, per position.
- `rate_decomposition` — splits a board's season-total miss into a games
  piece (proj_games vs. actual_mean_games, benchmarked against
  `availability_summary`'s expected_games) and a per-game rate piece
  (proj_ppg vs. actual_ppg).
- `weekly_residual_icc` — one-way random-effects ICC(1) of weekly PPR points
  within the same cohorts, i.e. how much of a player's week-to-week scoring
  is signal (persistent skill) vs. noise.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.eval.board import season_actuals
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points
from ffmodel.site.draft import REPLACEMENT_RANK

_MAX_GAMES = 18   # inclusive upper bound on the games axis (brief: 0..18)


def _select_pairs(weekly: pd.DataFrame, through_season: int, pairs: int) -> list[int]:
    """Season endpoints S' with S' <= through_season, S' present in `weekly`,
    and S'-1 also present -- the most recent `pairs` of them, ascending.
    Shared by `availability_table` and `weekly_residual_icc` so the two
    diagnostics are measured over identical cohorts (DRY, and required for
    the ICC docstring's "SAME cohorts as availability_table" guarantee)."""
    seasons = set(int(s) for s in weekly["season"].unique())
    candidates = sorted(s for s in seasons if s <= through_season and (s - 1) in seasons)
    chosen = candidates[-pairs:] if pairs > 0 else []
    if not chosen:
        raise ValueError(
            f"no valid season pair <= {through_season} in the supplied weekly frame "
            f"(need consecutive seasons S'-1, S' both present)"
        )
    return chosen


def _cohort_ids(prior: pd.DataFrame, position: str, rank: int) -> pd.Series:
    """Top 2*rank player_ids at `position` from a `season_actuals` frame,
    ranked by actual_points desc, tie-break player_id asc -- identical
    convention to `board_metrics`'s pool selection."""
    pool = prior[prior["position"] == position].sort_values(
        ["actual_points", "player_id"], ascending=[False, True]
    )
    return pool["player_id"].head(2 * rank)


def availability_table(weekly: pd.DataFrame, through_season: int, pairs: int = 6,
                       replacement_rank: dict[str, int] | None = None) -> pd.DataFrame:
    """Leak-free empirical distribution of games played, pooled over the most
    recent `pairs` season pairs <= through_season. For each pair (S'-1 -> S'):
    the cohort is the top 2xreplacement_rank[pos] players BY S'-1 production
    (`season_actuals(weekly, S'-1)`); games measured is each cohort member's
    S' games from `season_actuals(weekly, S')`, defaulting to 0 for a cohort
    member who recorded nothing in S' (bust/retirement -- no survivorship).
    Long format: one row per (position, games in 0..18), `count` pooled
    across every pair, zero counts included so the distribution is complete.
    Raises ValueError if no valid season pair exists <= through_season."""
    if replacement_rank is None:
        replacement_rank = REPLACEMENT_RANK
    chosen = _select_pairs(weekly, through_season, pairs)

    counts: dict[tuple[str, int], int] = {
        (pos, g): 0 for pos in replacement_rank for g in range(_MAX_GAMES + 1)
    }
    for s_prime in chosen:
        prior = season_actuals(weekly, s_prime - 1)
        current = season_actuals(weekly, s_prime)
        games_by_id = dict(zip(current["player_id"], current["games"]))
        for pos, rank in replacement_rank.items():
            for pid in _cohort_ids(prior, pos, rank):
                games = min(int(games_by_id.get(pid, 0)), _MAX_GAMES)
                counts[(pos, games)] += 1

    rows = [{"position": pos, "games": g, "count": counts[(pos, g)]}
            for pos in replacement_rank for g in range(_MAX_GAMES + 1)]
    return pd.DataFrame(rows, columns=["position", "games", "count"])


def availability_summary(counts: pd.DataFrame) -> pd.DataFrame:
    """Count-weighted mean/population-std games played per position, from an
    `availability_table` output."""
    rows = []
    for pos, group in counts.groupby("position", sort=False):
        n = int(group["count"].sum())
        if n == 0:
            mean = float("nan")
            std = float("nan")
        else:
            mean = float((group["games"] * group["count"]).sum() / n)
            var = float((group["count"] * (group["games"] - mean) ** 2).sum() / n)
            std = float(np.sqrt(var))
        rows.append({"position": pos, "mean_games": mean, "std_games": std,
                     "n_player_seasons": n})
    return pd.DataFrame(rows, columns=["position", "mean_games", "std_games",
                                        "n_player_seasons"])


def rate_decomposition(board_players: list[dict], actuals: pd.DataFrame,
                       summary: pd.DataFrame) -> pd.DataFrame:
    """Split a board's season-total miss into a games piece and a per-game
    rate piece. `board_players` is a board's "players" list (as
    `build_draft_board` emits); `actuals` is `season_actuals(weekly, S)` for
    the board's season; `summary` is `availability_summary` computed from the
    world strictly BEFORE season S (so `expected_games` carries no leak).
    Pool = board's projected top 2xREPLACEMENT_RANK[pos] by season p50 PPR,
    tie-break player_id asc -- identical rule to `board_metrics`. A pool
    member missing from `actuals` (bust/retirement) counts 0 points and 0
    games -- `actual_ppg` is an aggregate ratio (sum points / sum games) so
    those zero-game players don't produce a division by zero and played
    games carry the rate."""
    actual_points_by_id = dict(zip(actuals["player_id"], actuals["actual_points"]))
    actual_games_by_id = dict(zip(actuals["player_id"], actuals["games"]))
    expected_games_by_pos = dict(zip(summary["position"], summary["mean_games"]))

    valid_positions = tuple(REPLACEMENT_RANK)
    present = [pos for pos in valid_positions
               if any(p["position"] == pos for p in board_players)]

    rows = []
    for pos in present:
        rank = REPLACEMENT_RANK[pos]
        ranked = sorted(
            (p for p in board_players if p["position"] == pos),
            key=lambda p: (-p["season_points"]["ppr"]["p50"], p["player_id"]),
        )
        pool = ranked[:2 * rank]

        proj_games = float(np.mean([p["games"] for p in pool]))
        proj_p50 = float(np.mean([p["season_points"]["ppr"]["p50"] for p in pool]))
        actual_games = np.array(
            [float(actual_games_by_id.get(p["player_id"], 0.0)) for p in pool])
        actual_points = np.array(
            [float(actual_points_by_id.get(p["player_id"], 0.0)) for p in pool])

        sum_games = float(actual_games.sum())
        proj_ppg = proj_p50 / proj_games if proj_games else float("nan")
        actual_ppg = float(actual_points.sum()) / sum_games if sum_games else float("nan")

        rows.append({
            "position": pos,
            "proj_games": proj_games,
            "expected_games": float(expected_games_by_pos.get(pos, float("nan"))),
            "actual_mean_games": float(actual_games.mean()),
            "proj_ppg": proj_ppg,
            "actual_ppg": actual_ppg,
            "rate_bias": proj_ppg - actual_ppg,
        })
    return pd.DataFrame(rows, columns=["position", "proj_games", "expected_games",
                                        "actual_mean_games", "proj_ppg", "actual_ppg",
                                        "rate_bias"])


def _icc1(groups: list[np.ndarray]) -> tuple[float, int, int]:
    """One-way random-effects ICC(1) with the unbalanced-group correction
    (brief formula, verbatim). `groups` are already filtered to >=2
    observations each. Returns (icc, I, N); icc is NaN when I < 2, else
    clipped into [0.0, 1.0) -- floor at 0 (negative icc means between-group
    variance is fully explained by noise), and strictly below 1 so a
    zero-within-group-variance case never reports an exact 1.0."""
    n_groups = len(groups)
    n_total = int(sum(len(g) for g in groups))
    if n_groups < 2:
        return float("nan"), n_groups, n_total

    sizes = np.array([len(g) for g in groups], dtype=float)
    means = np.array([g.mean() for g in groups], dtype=float)
    grand_mean = float(np.concatenate(groups).mean())

    msb = float(np.sum(sizes * (means - grand_mean) ** 2) / (n_groups - 1))
    msw = float(sum(np.sum((g - m) ** 2) for g, m in zip(groups, means))
               / (n_total - n_groups))
    k0 = float((n_total - np.sum(sizes ** 2) / n_total) / (n_groups - 1))
    denom = msb + (k0 - 1) * msw
    icc = (msb - msw) / denom if denom != 0 else float("nan")
    if not np.isnan(icc):
        upper = np.nextafter(1.0, 0.0)   # largest float strictly < 1.0
        icc = float(np.clip(icc, 0.0, upper))
    return icc, n_groups, n_total


def weekly_residual_icc(weekly: pd.DataFrame, through_season: int,
                        pairs: int = 6) -> pd.DataFrame:
    """Week-to-week persistence per position: one-way random-effects ICC(1)
    of weekly PPR points, over the SAME cohorts `availability_table` uses
    (same pairs, same top-2xreplacement selection from S'-1). Each cohort
    member's group is their weekly PPR points scored in S'
    (`fantasy_points(rows[PREDICTED_STATS], PPR)`); groups with < 2 weeks
    played are dropped (no within-group variance to measure). Positions with
    fewer than 2 qualifying groups get icc = NaN."""
    chosen = _select_pairs(weekly, through_season, pairs)

    rows = []
    for pos, rank in REPLACEMENT_RANK.items():
        groups: list[np.ndarray] = []
        for s_prime in chosen:
            prior = season_actuals(weekly, s_prime - 1)
            season_rows = weekly[weekly["season"] == s_prime]
            for pid in _cohort_ids(prior, pos, rank):
                player_rows = season_rows[season_rows["player_id"] == pid]
                if len(player_rows) < 2:
                    continue
                pts = fantasy_points(player_rows[PREDICTED_STATS], PPR).to_numpy()
                groups.append(pts)
        icc, n_groups, n_total = _icc1(groups)
        rows.append({"position": pos, "icc": icc,
                     "n_player_seasons": n_groups, "n_weeks": n_total})
    return pd.DataFrame(rows, columns=["position", "icc", "n_player_seasons", "n_weeks"])


# --- the CLI -----------------------------------------------------------

def _records(df: pd.DataFrame) -> list[dict]:
    """NaN -> None for strict `json.dumps` (matches run.py's pattern)."""
    return df.astype(object).where(pd.notna(df), None).to_dict("records")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Diagnostics: availability cohorts, rate decomposition, weekly ICC.")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--last-season", type=int, default=2025)
    parser.add_argument("--pairs", type=int, default=6)
    parser.add_argument("--out-dir", type=Path, default=Path("models/diagnostics"))
    parser.add_argument("--board-season", type=int, default=None,
                        help="also regenerate this season's board through the "
                             "production path and write the rate decomposition")
    parser.add_argument("--transformer-root", type=Path, action="append", default=None,
                        help="required together with --board-season; repeatable to "
                             "average a seed ensemble (same convention as "
                             "ffmodel.eval.board)")
    return parser


def parse_and_validate(argv=None) -> argparse.Namespace:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.board_season is not None and not args.transformer_root:
        parser.error("--board-season requires at least one --transformer-root")
    return args


def main() -> None:
    args = parse_and_validate()
    from ffmodel.data.pull import pull_schedules, pull_weekly

    spans = list(range(args.first_season, args.last_season + 1))
    weekly = pull_weekly(spans, cache_dir=args.data_dir)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    through_seasons = [s for s in range(args.last_season - 3, args.last_season + 1)
                       if s >= args.first_season]

    avail_per_through: dict[str, dict] = {}
    icc_per_through: dict[str, list] = {}
    for through in through_seasons:
        sub = weekly[weekly["season"] <= through]
        counts = availability_table(sub, through, pairs=args.pairs)
        summary = availability_summary(counts)
        avail_per_through[str(through)] = {
            "counts": _records(counts), "summary": _records(summary),
        }
        icc = weekly_residual_icc(sub, through, pairs=args.pairs)
        icc_per_through[str(through)] = _records(icc)

    created = datetime.now(timezone.utc).isoformat(timespec="seconds")
    availability_report = {"created": created, "pairs": args.pairs,
                           "per_through": avail_per_through}
    icc_report = {"created": created, "pairs": args.pairs,
                 "per_through": icc_per_through}
    (args.out_dir / "availability.json").write_text(json.dumps(availability_report, indent=2))
    (args.out_dir / "weekly_icc.json").write_text(json.dumps(icc_report, indent=2))
    print(f"availability -> {args.out_dir / 'availability.json'}")
    print(f"weekly_icc -> {args.out_dir / 'weekly_icc.json'}")

    if args.board_season is not None:
        from ffmodel.data.features import build_features
        from ffmodel.model.predictor import TransformerPredictor
        from ffmodel.site.draft import build_draft_board

        season = args.board_season
        world = weekly[weekly["season"] < season].copy()   # THE leak boundary
        if world.empty:
            raise ValueError(
                f"board season {season}: no prior-season data to seed from")
        sched_spans = list(range(args.first_season, max(args.last_season, season) + 1))
        schedules = pull_schedules(sched_spans, cache_dir=args.data_dir)
        sched_s = schedules[schedules["season"] <= season]

        # Mirror run_board_backtest's exact fit sequence (ffmodel.eval.board):
        # build_features on the leak-free world, fit on rows strictly < S,
        # then the production build_draft_board path with prefit=True.
        features = build_features(world, sched_s)
        train = features[features["season"] < season]
        predictor = TransformerPredictor(list(args.transformer_root), features)
        predictor.fit(train)
        board = build_draft_board(world, sched_s, predictor, season,
                                  f"{season - 1}-diagnostic", prefit=True)

        actuals = season_actuals(weekly, season)
        world_counts = availability_table(world, season - 1, pairs=args.pairs)
        world_summary = availability_summary(world_counts)
        table = rate_decomposition(board["players"], actuals, world_summary)

        rate_report = {"created": created, "board_season": season,
                       "table": _records(table)}
        out_path = args.out_dir / "rate_decomposition.json"
        out_path.write_text(json.dumps(rate_report, indent=2))
        print(f"rate_decomposition -> {out_path}")


if __name__ == "__main__":
    main()
