"""Fixed-origin horizon diagnostic. No live roster lookup or advice promotion."""
from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.data.features import build_features
from ffmodel.data.future import combined_future_features
from ffmodel.scoring import PREDICTED_STATS, fantasy_points
from ffmodel.site.live_experts import atomic_write
from ffmodel.site.pick_sixes import load_pick_six_prior
from ffmodel.site.weekly import build_weekly_projections, set_league_rules, RULESETS
from ffmodel.eval.starter_decisions import starter_pool, decision_pairs, POOL_SIZE


def recent_game_baseline(history, rules, *, include_pick_six=False):
    """Predeclared baseline: mean points in last four recorded games, no zeros."""
    if history.duplicated(["player_id","season","week"]).any():
        raise ValueError("duplicate baseline player-week history")
    columns = PREDICTED_STATS + (["passing_pick_sixes"] if include_pick_six else [])
    recent = history.sort_values(["season", "week"]).groupby("player_id").tail(4).copy()
    if recent[columns].isna().any().any():
        raise ValueError("baseline history has missing stat components")
    recent["baseline"] = fantasy_points(recent[columns], rules)
    return recent.groupby("player_id").baseline.mean()


def score_horizon(predictions, actuals, *, season, origin, week):
    """Score observed same-team rows only; missing rows stay explicitly unknown."""
    needed = {"player_id", "position", "team", "predicted"}
    if not needed <= set(predictions) or not {"player_id", "position", "team", "actual"} <= set(actuals):
        raise ValueError("missing forecast/actual columns")
    if predictions.player_id.duplicated().any() or actuals.player_id.duplicated().any():
        raise ValueError("duplicate evaluation identity")
    if not np.isfinite(predictions.predicted).all() or not np.isfinite(actuals.actual).all():
        raise ValueError("nonfinite evaluation points")
    if "baseline" in predictions and not np.isfinite(predictions.baseline).all():
        raise ValueError("nonfinite baseline points")
    joined = predictions.merge(actuals, on="player_id", how="left", suffixes=("", "_actual"), indicator=True)
    def summarize(g):
        observed = g._merge.eq("both")
        same = observed & g.team.eq(g.team_actual) & g.position.eq(g.position_actual)
        evaluated = g[same]
        error = evaluated.predicted-evaluated.actual
        result = {"forecast_players": len(g), "observed_actuals": int(observed.sum()),
                "missing_actuals": int((~observed).sum()),
                "team_or_position_changed": int((observed & ~same).sum()),
                "evaluated": len(evaluated),
                "mae": float(error.abs().mean()) if len(error) else None,
                "bias": float(error.mean()) if len(error) else None}
        if "baseline" in evaluated:
            baseline_error = evaluated.baseline-evaluated.actual
            result.update({"baseline_mae": float(baseline_error.abs().mean()) if len(error) else None,
                           "paired_mae_delta": float((error.abs()-baseline_error.abs()).mean()) if len(error) else None,
                           "paired_players": len(error)})
        return result
    return {"season": season, "origin_week": origin, "target_week": week,
            "horizon": week-origin+1, "overall": summarize(joined),
            "by_position": {pos:summarize(g) for pos,g in joined.groupby("position")}}


def evaluate_origin(*args, **kwargs):
    previous = RULESETS["league"]
    try:
        return _evaluate_origin(*args, **kwargs)
    finally:
        set_league_rules(previous)


def _evaluate_origin(weekly, schedules, *, season, origin, horizons, league, predictor_factory):
    if not 1 <= origin <= 17 or not horizons or any(type(h) is not int or h < 1 or origin+h-1 > 17 for h in horizons):
        raise ValueError("invalid origin/horizons")
    if len(set(horizons)) != len(horizons):
        raise ValueError("duplicate horizons")
    history = weekly[(weekly.season < season) | ((weekly.season == season) & (weekly.week < origin))].copy()
    if history.empty or not (history.season == season-1).any():
        raise ValueError("previous-season training history required")
    # Never discover the cohort/team map from target-week participation.
    latest = history.sort_values(["season", "week"]).groupby("player_id").tail(1)
    latest = latest[latest.season >= season-1]
    teams = latest.set_index("player_id").team.to_dict()
    features = build_features(history, schedules)
    model = predictor_factory(features)
    model.fit(features[features.season < season])
    target_actuals = weekly[(weekly.season == season) & weekly.week.isin([origin+h-1 for h in horizons])]
    pick_six_observed = "passing_pick_sixes" in target_actuals and target_actuals.passing_pick_sixes.notna().all()
    rules = league.rules if pick_six_observed else replace(league.rules, pass_int_td=0)
    set_league_rules(rules)
    prior = load_pick_six_prior(season) if rules.pass_int_td else None
    baseline = recent_game_baseline(history, rules, include_pick_six=bool(pick_six_observed))
    pool = starter_pool(latest, baseline)
    reports = []
    for horizon in sorted(horizons):
        week = origin+horizon-1
        games = schedules[(schedules.season == season) & (schedules.week == week)]
        if "game_type" in games:
            games = games[games.game_type == "REG"]
        playing = list(games.home_team)+list(games.away_team)
        if len(playing)<20 or len(set(playing))!=len(playing) or games[["home_score","away_score"]].isna().any().any():
            raise ValueError("target schedule incomplete or not completed")
        combined, future = combined_future_features(history, schedules, season, week, teams)
        if future.empty or future.player_id.duplicated().any() or not future[PREDICTED_STATS].isna().all().all():
            raise ValueError("invalid future rows")
        if not ((future.season == season) & (future.week == week)).all():
            raise ValueError("wrong future horizon")
        if hasattr(model, "attach_features"):
            model.attach_features(combined)
        payload = build_weekly_projections(future, model, season, week, "historical pre-origin observations",
                                           pick_six_prior=prior)
        predictions = pd.DataFrame([{k:p[k] for k in ("player_id","position","team")} |
                                   {"predicted":p["points"]["league"]["p50"]} for p in payload["players"]])
        predictions["baseline"] = predictions.player_id.map(baseline)
        scheduled = {pid for pid,t in teams.items() if t in playing}
        if not set(predictions.player_id) <= scheduled:
            raise ValueError("forecast cohort escaped frozen origin")
        actual = weekly[(weekly.season == season) & (weekly.week == week)].copy()
        if not set(playing) <= set(actual.team):
            raise ValueError("completed target teams missing actual stat coverage")
        # Match the deployed predicted component scope, plus observed pick-six
        # cost where available. Do not credit unmodeled two-point/ST events.
        columns = PREDICTED_STATS + (["passing_pick_sixes"] if pick_six_observed else [])
        if actual[columns].isna().any().any():
            raise ValueError("actual stat components missing")
        actual["actual"] = fantasy_points(actual[columns], rules)
        report = score_horizon(predictions, actual, season=season, origin=origin, week=week)
        report["starter_decisions"] = decision_pairs(predictions, actual, pool)
        report["pick_six_evaluated"] = bool(pick_six_observed)
        report["origin_cohort"] = len(teams)
        report["scheduled_origin_players"] = len(scheduled)
        report["unprojected_scheduled_players"] = len(scheduled)-len(predictions)
        reports.append(report)
    return {"schema_version":1, "diagnostic":"frozen_history_horizons", "advice_eligible":False,
            "league":league.payload(), "season":season, "origin_week":origin,
            "training_through":season-1, "model":model.name, "reports":reports,
            "baseline":"Mean of last four recorded pre-origin games (or all if fewer); frozen across horizons; no absence imputation.",
            "starter_pool":{"selection":"Top pre-origin four-game averages per position; deterministic player-ID tiebreak. Frozen across horizons.","position_limits":POOL_SIZE,
                            "comparison":"All within-position pairs with actual same-team rows; pairs tied by either forecast excluded for both methods. Not actual fantasy rosters or independent trials."},
            "comparison":"Model minus baseline absolute error on identical observed same-team rows; negative favors model. No significance claim.",
            "scoring_scope":"Predicted stat components only; pick-six costs excluded from BOTH sides when actual counts are unavailable. Not complete platform scoring.",
            "limitations":["Retrospective diagnostic, not a captured point-in-time roster backtest.",
                           "Cohort and teams are last observed before origin; no future roster information used.",
                           "Metrics condition on observed same-team stat rows; absent actuals are not zero.",
                           "Target schedules are retrospectively known; schedule revisions are not reconstructed.",
                           "Availability, traded players and cold-start omissions need separate evaluation.",
                           "No retraining, hyperparameter selection, statistical superiority or trade-readiness claim."]}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season",type=int,required=True)
    parser.add_argument("--origin",type=int,required=True)
    parser.add_argument("--horizons",type=int,nargs="+",default=[1,2,4,8])
    parser.add_argument("--data-dir",type=Path,default=Path("data/raw"))
    parser.add_argument("--first-season",type=int,default=2012)
    parser.add_argument("--league",default="gabagool")
    parser.add_argument("--root",type=Path,action="append")
    parser.add_argument("--out",type=Path,required=True)
    args=parser.parse_args()
    from ffmodel.league import load_league
    from ffmodel.model.predictor import TransformerPredictor
    from ffmodel.data.pull import pull_weekly, pull_schedules
    span=list(range(args.first_season,args.season+1))
    roots=args.root or [Path("models/transformer/v1"),Path("models/transformer/v1_s43"),Path("models/transformer/v1_s44")]
    report=evaluate_origin(pull_weekly(span,cache_dir=args.data_dir),pull_schedules(span,cache_dir=args.data_dir),
                           season=args.season,origin=args.origin,horizons=args.horizons,
                           league=load_league(args.league),predictor_factory=lambda f:TransformerPredictor(roots,f))
    report["artifact_roots"]=[str(root) for root in roots]
    report["history_first_season"]=args.first_season
    args.out.parent.mkdir(parents=True,exist_ok=True)
    atomic_write(args.out,json.dumps(report,indent=2,allow_nan=False))
    print(json.dumps(report["reports"],indent=2))


if __name__=="__main__":
    main()
