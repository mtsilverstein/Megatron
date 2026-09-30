"""Frozen per-week origin forecasts for the roster-simulation trade backtest.

For one (season, origin) cell, forecast every week from origin through
last_week using only information available before the origin week: the
cohort, their teams, the fitted model and the naive baseline are all frozen
at the origin (``remaining._origin_context``). No target-week actual is read.
Scoring scope is predicted stat components only (no pick-six cost), matching
``worlds_tf`` ``actual_weeks``.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from ffmodel.eval import remaining as R
from ffmodel.site.live_experts import atomic_write
from ffmodel.site.weekly import RULESETS


def origin_forecasts(weekly, schedules, *, season, origin, last_week, league, predictor_factory):
    previous = RULESETS["league"]
    try:
        return _origin_forecasts(weekly, schedules, season=season, origin=origin, last_week=last_week,
                                 league=league, predictor_factory=predictor_factory)
    finally:
        R.set_league_rules(previous)


def _origin_forecasts(weekly, schedules, *, season, origin, last_week, league, predictor_factory):
    if type(origin) is not int or type(last_week) is not int or not 1 <= origin <= last_week <= 18:
        raise ValueError("invalid origin/last_week")
    # target_weeks=None: the context never reads a row at or after the origin.
    ctx = R._origin_context(weekly, schedules, season=season, origin=origin, league=league,
                            predictor_factory=predictor_factory)
    history, teams, model, baseline = ctx["history"], ctx["teams"], ctx["model"], ctx["baseline"]
    positions = ctx["latest"].set_index("player_id").position.to_dict()
    players = {}
    for pid in sorted(teams):
        base = baseline.get(pid)
        if base is None or not np.isfinite(base):
            raise ValueError(f"no finite baseline for cohort player {pid}")
        players[pid] = {"position": positions[pid], "team": teams[pid],
                        "baseline": round(float(base), 4), "weeks": {}}
    weeks = list(range(origin, last_week+1))
    for week in weeks:
        games = schedules[(schedules.season == season) & (schedules.week == week)]
        if "game_type" in games:
            games = games[games.game_type == "REG"]
        playing = list(games.home_team)+list(games.away_team)
        # Schedule shape only; game results are target-week outcomes and unused.
        if not playing or len(set(playing)) != len(playing):
            raise ValueError(f"week {week} schedule missing or duplicated")
        combined, future = R.combined_future_features(history, schedules, season, week, teams)
        if future.empty or future.player_id.duplicated().any() or not future[R.PREDICTED_STATS].isna().all().all():
            raise ValueError("invalid future rows")
        if not ((future.season == season) & (future.week == week)).all():
            raise ValueError("wrong future horizon")
        if hasattr(model, "attach_features"):
            model.attach_features(combined)
        payload = R.build_weekly_projections(future, model, season, week, "historical pre-origin observations",
                                             pick_six_prior=ctx["prior"])
        scheduled = {pid for pid, t in teams.items() if t in playing}
        projected = {}
        for p in payload["players"]:
            pid = p["player_id"]
            if pid not in scheduled:
                raise ValueError("forecast cohort escaped frozen origin")
            if pid in projected:
                raise ValueError(f"duplicate projection for {pid} week {week}")
            band = p["points"]["league"]
            q = [band.get(k) for k in ("p10", "p50", "p90")]
            if any(x is None or not np.isfinite(x) for x in q) or not q[0] <= q[1] <= q[2]:
                raise ValueError(f"nonfinite or unordered league quantiles for {pid} week {week}")
            projected[pid] = {"status": "play", "p10": float(q[0]), "p50": float(q[1]), "p90": float(q[2])}
        for pid in players:
            if pid not in scheduled:
                players[pid]["weeks"][str(week)] = {"status": "bye"}
            elif pid in projected:
                players[pid]["weeks"][str(week)] = projected[pid]
            # else: scheduled but unprojected -> omitted, a coverage gap (never zero).
    return {"schema_version": 1, "season": season, "origin": origin, "weeks": weeks,
            "model": model.name, "training_through": season-1, "scoring": league.rules.name,
            "scoring_scope": "Predicted stat components only; pick-six cost excluded (matches worlds_tf actual_weeks).",
            "players": players}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--origin", type=int, required=True)
    parser.add_argument("--last-week", type=int, default=17)
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--league", default="gabagool")
    parser.add_argument("--root", type=Path, action="append")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    from ffmodel.league import load_league
    from ffmodel.model.predictor import TransformerPredictor
    from ffmodel.data.pull import pull_weekly, pull_schedules
    span = list(range(args.first_season, args.season+1))
    roots = args.root or [Path("models/transformer/v1"), Path("models/transformer/v1_s43"), Path("models/transformer/v1_s44")]
    out = origin_forecasts(pull_weekly(span, cache_dir=args.data_dir), pull_schedules(span, cache_dir=args.data_dir),
                           season=args.season, origin=args.origin, last_week=args.last_week,
                           league=load_league(args.league), predictor_factory=lambda f: TransformerPredictor(roots, f))
    out["artifact_roots"] = [str(root) for root in roots]
    out["history_first_season"] = args.first_season
    args.out.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(args.out, json.dumps(out, indent=1, allow_nan=False))
    print(f"{args.out}: {len(out['players'])} players, weeks {out['weeks'][0]}-{out['weeks'][-1]}")


if __name__ == "__main__":
    main()
