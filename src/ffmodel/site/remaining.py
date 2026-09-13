"""Experimental frozen-history future-week scenarios, not calibrated ROS advice."""
from datetime import datetime, timezone

import pandas as pd

from ffmodel.data.future import combined_future_features
from ffmodel.site.weekly import build_weekly_projections, RULESETS
from ffmodel.league import SLEEPER_RULE_FIELDS
from ffmodel.scoring import PREDICTED_STATS


def build_remaining(weekly, schedules, predictor, season, start_week, *,
                    current_teams, league, end_week=17, pick_six_prior=None):
    if not 1 <= start_week <= end_week <= 18:
        raise ValueError("invalid remaining-week horizon")
    if not current_teams or not league.get("league_id") or not league.get("sleeper_scoring"):
        raise ValueError("current teams and explicit league scoring required")
    for key, value in league["sleeper_scoring"].items():
        field = SLEEPER_RULE_FIELDS.get(key)
        if field and float(value) != float(getattr(RULESETS["league"], field)):
            raise ValueError("active projection rules disagree with league scoring")
    # Even an accidentally supplied full season cannot enter the forecast.
    history = weekly[(weekly.season < season) |
                     ((weekly.season == season) & (weekly.week < start_week))].copy()
    if history.empty:
        raise ValueError("no observed pre-slate history")
    last = history.sort_values(["season", "week"]).iloc[-1]
    through = f"{int(last.season)}-wk{int(last.week):02d}"
    schedule = schedules[schedules.season == season].copy()
    if "game_type" in schedule:
        schedule = schedule[schedule.game_type == "REG"]
    teams = set(schedule.home_team) | set(schedule.away_team)
    if not teams or any(t not in teams for t in current_teams.values()):
        raise ValueError("current team outside schedule coverage")
    records = {str(pid): {"player_id": str(pid), "team": t, "weeks": []}
               for pid, t in current_teams.items()}
    for week in range(start_week, end_week + 1):
        games = schedule[schedule.week == week]
        playing = list(games.home_team) + list(games.away_team)
        if len(playing) < 20 or len(set(playing)) != len(playing):
            raise ValueError(f"missing or duplicate team schedule in week {week}")
        # Build each horizon independently. Never feed predicted stats back as
        # observations or append earlier unplayed skeletons to model history.
        combined, future = combined_future_features(history, schedule, season, week, current_teams)
        future = future[future.player_id.isin(current_teams)].copy()
        if future.player_id.duplicated().any():
            raise ValueError("duplicate future player identity")
        if not future.empty and (not ((future.season == season) & (future.week == week)).all()
                                 or not future[PREDICTED_STATS].isna().all().all()):
            raise ValueError("future rows contain observations or the wrong horizon")
        if hasattr(predictor, "attach_features"):
            predictor.attach_features(combined)
        by_id = {}
        if not future.empty:
            payload = build_weekly_projections(future, predictor, season, week, through,
                                               pick_six_prior=pick_six_prior)
            by_id = {str(p["player_id"]): p for p in payload["players"]}
        for pid, record in records.items():
            p = by_id.get(pid)
            if record["team"] not in playing:
                row = {"week": week, "status": "bye", "points": None}
            elif p is None:
                row = {"week": week, "status": "unmodeled", "points": None}
            else:
                if p["team"] != record["team"]:
                    raise ValueError("projection team does not match current team")
                record.update({"name": p["name"], "position": p["position"]})
                row = {"week": week, "status": "conditional_projection",
                       "opponent": p["opponent"], "points": p["points"],
                       "stat_quantiles": p["stat_quantiles"]}
            record["weeks"].append(row)
    return {"schema_version": 1, "horizon": "remaining_season", "status": "experimental",
            "advice_eligible": False, "season": season, "start_week": start_week,
            "end_week": end_week, "generated_at": datetime.now(timezone.utc).isoformat(),
            "data_through": through, "league": league, "model": predictor.name,
            "forecast_cutoff": f"before {season} week {start_week}",
            "observed_target_rows_ignored": int(((weekly.season == season) & (weekly.week >= start_week)).sum()),
            "input_timing": "Observed history frozen; roster and schedule reflect retrieval time, not a historical point-in-time snapshot.",
            "historical_evaluation_eligible": False,
            "coverage_by_week": [{"week": w, **{status: sum(
                row["status"] == status for p in records.values() for row in p["weeks"] if row["week"] == w)
                for status in ("conditional_projection", "bye", "unmodeled")}}
                for w in range(start_week, end_week+1)],
            "availability_model": "none; conditional on participation, not injury-adjusted",
            "scoring_scope": "Existing weekly-model stat subset with league weights; not every platform scoring event is forecast.",
            "uncertainty": "Weekly component-stat bands only; no calibrated season interval or additive trade value.",
            "limitations": ["Frozen observed pre-slate history at every horizon; not recursively updated.",
                            "Future role changes and player availability are not forecast.",
                            "50+ yard TD bonuses, two-point conversions and special-teams scores are not forecast; pick-six cost is an approximation when enabled.",
                            "Lag features and games-prior stay frozen; long-horizon accuracy is unvalidated.",
                            "Zero-history model fallbacks, where used, are positional baselines rather than matchup-specific forecasts.",
                            "Current-week rows can include started games; not executable advice.",
                            "Byes and missing projections are distinct; no season totals fabricated."],
            "players": list(records.values())}
