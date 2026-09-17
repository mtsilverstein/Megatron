"""Experimental frozen-history future-week scenarios, not calibrated ROS advice."""
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from ffmodel.data.future import combined_future_features
from ffmodel.site.weekly import build_weekly_projections, RULESETS
from ffmodel.league import SLEEPER_RULE_FIELDS
from ffmodel.scoring import PREDICTED_STATS

DIAGNOSTICS_DIR = Path(__file__).resolve().parents[3] / "models" / "diagnostics"
BASELINE_DESCRIPTION = "mean league-scored production in the last four recorded pre-origin games"


def load_evaluation(slug, league_scoring, diagnostics_dir=DIAGNOSTICS_DIR,
                    reference_slug="gabagool", reference_scoring=None):
    """The measured remaining-season evaluation for this league, or None.

    Read from the committed `remaining_matrix_<slug>.json`, never typed in.
    Another league's diagnostic is borrowed only when the two leagues agree on
    every MODELED scoring key (`ffmodel.league.SLEEPER_RULE_FIELDS`), and then
    says so in `scoring_scope`. The diagnostic scores predicted stat components
    only, so kicker distance bands, `fgm_yds`, and 50-yard-TD bonuses cannot
    move it and must not block the borrow."""
    diagnostics_dir = Path(diagnostics_dir)
    path = diagnostics_dir / f"remaining_matrix_{slug}.json"
    scope = None
    if not path.exists():
        if reference_scoring is None or slug == reference_slug:
            return None
        if not _scoring_equal(league_scoring, reference_scoring):
            return None
        path = diagnostics_dir / f"remaining_matrix_{reference_slug}.json"
        if not path.exists():
            return None
        scope = f"evaluated under {reference_slug} scoring, which matches this league"
    data = json.loads(path.read_text(encoding="utf-8"))
    horizons = [{"horizon": int(r["horizon"]), "model_mae": round(float(r["model_mae"]), 3),
                 "baseline_mae": round(float(r["baseline_mae"]), 3),
                 "paired_forecasts": int(r["paired_player_forecasts"]),
                 "forecast_players": int(r["forecast_players"]),
                 "missing_actuals": int(r["missing_actuals"])}
                for r in data.get("summary", []) if r.get("position") == "ALL"]
    horizons.sort(key=lambda r: r["horizon"])
    out = {"source": f"models/diagnostics/{path.name}", "baseline": BASELINE_DESCRIPTION,
           "seasons": list(data.get("seasons", [])), "origins": list(data.get("origins", [])),
           "horizons": horizons, "limitation": data.get("limitation")}
    if scope:
        out["scoring_scope"] = scope
    return out


def _scoring_equal(a, b):
    """Compare only the scoring keys the diagnostic's model actually predicts.

    `SLEEPER_RULE_FIELDS` are the stat components the transformer forecasts;
    anything else (kicker distance bands, `fgm_yds`, 50-yard-TD bonuses) is
    unmodeled and cannot change whether a borrowed diagnostic still applies."""
    keys = set(SLEEPER_RULE_FIELDS)
    return all(float((a or {}).get(k, 0)) == float((b or {}).get(k, 0)) for k in keys)


def build_remaining(weekly, schedules, predictor, season, start_week, *,
                    current_teams, league, end_week=17, pick_six_prior=None, evaluation=None):
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
    through = f"{int(last.season)}-wk{int(last.week)}"
    schedule = schedules[schedules.season == season].copy()
    if "game_type" in schedule:
        schedule = schedule[schedule.game_type == "REG"]
    teams = set(schedule.home_team) | set(schedule.away_team)
    if not teams or any(t not in teams for t in current_teams.values()):
        raise ValueError("current team outside schedule coverage")
    records = {str(pid): {"player_id": str(pid), "team": t, "weeks": []}
               for pid, t in current_teams.items()}
    latest_seasons = history.groupby("player_id").season.max().to_dict()
    for pid, record in records.items():
        last_season = latest_seasons.get(pid)
        record["history_status"] = (
            "no_observed_history" if last_season is None else
            "outside_recent_history_window" if last_season < season - 1 else
            "recent_observed_history")
        record["last_observed_season"] = None if last_season is None else int(last_season)
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
                reason = record["history_status"]
                if reason == "recent_observed_history":
                    reason = "missing_model_output"
                row = {"week": week, "status": "unmodeled", "points": None,
                       "reason": reason}
            else:
                if p["team"] != record["team"]:
                    raise ValueError("projection team does not match current team")
                record.update({"name": p["name"], "position": p["position"]})
                points = p.get("points") or {}
                if not isinstance(points.get("league"), dict):
                    raise ValueError("league lens missing from weekly projection")
                row = {"week": week, "status": "conditional_projection",
                       "opponent": p["opponent"],
                       "points": {"league": dict(points["league"])}}
            record["weeks"].append(row)
    return {"schema_version": 1, "horizon": "remaining_season", "status": "experimental",
            "evaluation": evaluation, "season": season, "start_week": start_week,
            "end_week": end_week,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
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
