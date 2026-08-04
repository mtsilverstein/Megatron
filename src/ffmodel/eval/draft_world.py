"""Leak-free per-season worlds for the DRAFT-STRATEGY backtest.

`eval/board.py` scores the board's *projections* (is the number right?). This
module supplies what is needed to score the *draft tool* (does acting on those
numbers beat drafting off the market?), by exporting, for one season S:

- the consensus-anchored board a drafter could have had in August of S, built
  through the production `build_draft_board` path from a model that has seen
  nothing at or after S, and
- what every player actually scored, WEEK BY WEEK, in season S.

Weekly rather than season totals is load-bearing. A fantasy team only ever
banks its best startable lineup each week, so a roster's real worth depends on
when its points arrived and who was available to start -- byes, missed games
and boom weeks on your bench all change the answer. Scoring a draft on season
totals would credit points that never entered a lineup.

Leak discipline is inherited, not reimplemented:
  * `board.board_world` cuts weekly history strictly before S.
  * `rankings.consensus_for_season` refuses any ECR snapshot at or after
    week-1 kickoff (its module docstring documents all three layers).
  * the predictor is fit on the cut world only, exactly as `generate.py` does.
Nothing here reads season S except `weekly_actuals`, which is the answer key
and is never handed to a model or a board.

THE MARKET PROXY. The live tool models the field with FantasyPros/Sleeper ADP,
which this project only holds for the current season. For historical seasons
the field is modelled with preseason ECR instead. The two are close but not
identical, and the substitution is recorded in the exported payload as
`market_source` so no downstream report can quietly present one as the other.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from ffmodel.eval.board import board_world
from ffmodel.scoring import LEAGUE, PREDICTED_STATS, ScoringRules, fantasy_points

# The fantasy regular season (weeks 1-14) decides who makes the playoffs; the
# full 1-17 window is also reported so a reader can see the choice did not
# manufacture the result.
FANTASY_REGULAR_WEEKS = 14


def market_positions(ecr_df: pd.DataFrame) -> dict[str, float]:
    """Consensus draft position per player: 1-based rank by ECR ascending.

    Both the simulated field and the optimizer's own field model read `adp` as
    "the overall pick this player goes at", so a season with no ADP snapshot
    still needs that column populated. Leaving it null does not fail loudly --
    it makes the field draft nobody and the optimizer believe every player
    survives to its next pick, which produced a fake +2470-point "edge" the
    first time this harness ran.

    ECR is an average expert RANK, so it already IS the consensus ordering;
    converting to a dense 1..N rank just states it as a pick number. `mergesort`
    keeps the order stable so equal ECRs resolve the same way on every run.
    This is a PROXY for ADP and is labelled `preseason_ecr` wherever it travels.
    """
    ordered = ecr_df.sort_values("ecr", kind="mergesort")["player_id"]
    return {pid: float(i + 1) for i, pid in enumerate(ordered)}


def weekly_actuals(weekly: pd.DataFrame, season: int,
                   rules: ScoringRules = LEAGUE) -> pd.DataFrame:
    """Per-player, per-week actual fantasy points for `season`.

    Scored over `PREDICTED_STATS` only -- the same convention as
    `board.season_actuals` and the weekly harness -- so a drafted player's
    projected total and his realised total are on one scale. Players with no
    row in a week simply do not appear: that is a real zero for lineup
    purposes (bye, injury, inactive) and the simulator treats a missing week
    as unstartable rather than as a scored zero.
    """
    rows = weekly[weekly["season"] == season]
    if rows.empty:
        raise ValueError(f"no weekly rows for season {season} — cannot score actuals")
    out = rows[["player_id", "player_display_name", "position", "week"]].copy()
    out["points"] = fantasy_points(rows[PREDICTED_STATS], rules).to_numpy()
    return out.reset_index(drop=True)


def _weeks_by_player(actuals: pd.DataFrame) -> dict[str, dict[str, float]]:
    """{player_id: {week: points}} — compact enough to ship whole seasons of
    the league's scoring to the node simulator as one JSON blob."""
    out: dict[str, dict[str, float]] = {}
    for pid, week, pts in zip(actuals["player_id"], actuals["week"], actuals["points"]):
        out.setdefault(str(pid), {})[str(int(week))] = round(float(pts), 2)
    return out


def build_season_world(weekly: pd.DataFrame, schedules: pd.DataFrame, season: int,
                       make_entrant, data_dir: Path, *, n_draws: int = 2000,
                       seed: int = 0, rules: ScoringRules = LEAGUE) -> dict:
    """One season's simulation world: the August board plus the answer key.

    `make_entrant(features)` returns a fresh, unfitted predictor, mirroring
    `board.run_board_backtest` so the transformer can be constructed against
    the season's own world features.
    """
    from ffmodel.data.features import build_features
    from ffmodel.data.rankings import consensus_for_season
    from ffmodel.site.board_rank import flex_replacement_ranks
    from ffmodel.site.draft import build_draft_board
    from ffmodel.site.generate import LEAGUE_DEDICATED, LEAGUE_FLEX_SLOTS

    world = board_world(weekly, season)
    if world.empty:
        raise ValueError(f"season {season}: no prior-season data to seed from")
    sched_s = schedules[schedules["season"] <= season]
    features = build_features(world, sched_s)

    ecr_df, consensus_stats = consensus_for_season(season, schedules, data_dir)
    ecr = dict(zip(ecr_df["player_id"], ecr_df["ecr"]))
    pool = ecr_df.rename(columns={"pos": "position"})[["position", "ecr"]]
    replacement = flex_replacement_ranks(pool, LEAGUE_DEDICATED, LEAGUE_FLEX_SLOTS)

    # The market, for a season with no ADP snapshot (see `market_positions`).
    adp = market_positions(ecr_df)

    entrant = make_entrant(features)
    entrant.fit(features[features["season"] < season])
    data_through = f"{int(world['season'].max())}-wk{int(world[world['season'] == world['season'].max()]['week'].max())}"
    board = build_draft_board(world, sched_s, entrant, season, data_through,
                              prefit=True, n_draws=n_draws, seed=seed,
                              ecr=ecr, adp=adp, replacement_rank=replacement)

    actuals = weekly_actuals(weekly, season, rules)
    return {
        "season": season,
        "model": entrant.name,
        "data_through": data_through,
        # No historical ADP exists in this project; the field is modelled on
        # the same preseason consensus a drafter could have had. Recorded so a
        # report can never present this as an ADP result.
        "market_source": "preseason_ecr",
        "scoring": rules.name,
        "consensus": {k: consensus_stats.get(k) for k in
                      ("matched_by_id", "matched_by_name_position", "unmatched")},
        "replacement_rank": replacement,
        "players": board["players"],
        "actual_weeks": _weeks_by_player(actuals),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Export leak-free per-season worlds for the draft-strategy backtest.")
    p.add_argument("--seasons", nargs="+", type=int, default=[2023, 2024, 2025])
    p.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    p.add_argument("--out-dir", type=Path, default=Path("models/backtests/worlds"))
    p.add_argument("--first-season", type=int, default=2012)
    p.add_argument("--n-draws", type=int, default=2000)
    p.add_argument("--scoring", choices=["league", "ppr"], default="league",
                   help="answer-key scoring; defaults to this league's own "
                        "rules (points.md), not generic PPR")
    p.add_argument("--model", choices=["xgboost", "transformer"], default="xgboost")
    p.add_argument("--artifact-root", type=str, default=None,
                   help="comma-separated transformer roots (required for --model transformer)")
    return p


def main() -> None:
    args = build_parser().parse_args()
    from ffmodel.data.pull import pull_schedules, pull_weekly

    weekly = pull_weekly(list(range(args.first_season, max(args.seasons) + 1)), args.data_dir)
    schedules = pull_schedules(list(range(args.first_season, max(args.seasons) + 1)), args.data_dir)

    def make_entrant(features):
        if args.model == "transformer":
            if not args.artifact_root:
                raise SystemExit("--model transformer requires --artifact-root")
            from ffmodel.model.predictor import TransformerPredictor
            roots = [Path(r.strip()) for r in args.artifact_root.split(",") if r.strip()]
            return TransformerPredictor(roots, features)
        from ffmodel.baseline.xgb import XGBBaseline
        return XGBBaseline()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for season in sorted(args.seasons):
        from ffmodel.scoring import PPR
        rules = LEAGUE if args.scoring == "league" else PPR
        world = build_season_world(weekly, schedules, season, make_entrant,
                                   args.data_dir, n_draws=args.n_draws, rules=rules)
        path = args.out_dir / f"world_{season}.json"
        path.write_text(json.dumps(world), encoding="utf-8")
        print(f"{path}: {len(world['players'])} board players, "
              f"{len(world['actual_weeks'])} players with {season} actuals")


if __name__ == "__main__":
    main()
