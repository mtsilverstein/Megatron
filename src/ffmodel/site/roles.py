"""Observed usage evidence for waiver research; never a points/bid forecast."""
from datetime import datetime, timezone

import pandas as pd


METRICS = ("targets", "carries", "target_share", "snap_pct", "carry_share")


def build_roles(weekly: pd.DataFrame, schedules: pd.DataFrame, season: int,
                before_week: int) -> dict:
    """Latest completed prior-week observation vs up to three same-team games.

    No cross-season baselines, invented zero games, partial-week observations,
    or inferred injury beneficiaries. Missing rows suppress growth comparisons.
    """
    if not 1 <= before_week <= 19:
        raise ValueError("before_week must be 1..19")
    required = {"player_id", "player_display_name", "position", "team", "season", "week"}
    if not required <= set(weekly):
        raise ValueError("usage input is missing identity columns")
    games = schedules[(schedules.season == season) & (schedules.week < before_week)]
    if "game_type" in games:
        games = games[games.game_type == "REG"]
    games = games.dropna(subset=["home_score", "away_score"])
    played = set()
    for row in games.itertuples():
        played.update(((str(row.home_team), int(row.week)), (str(row.away_team), int(row.week))))
    df = weekly[(weekly.season == season) & (weekly.week < before_week)].copy()
    df = df[df.apply(lambda r: (str(r.team), int(r.week)) in played, axis=1)] if not df.empty else df
    if df.duplicated(["player_id", "season", "week"]).any():
        raise ValueError("duplicate player-week usage rows")
    for col in METRICS:
        if col not in df:
            df[col] = float("nan")
        df[col] = pd.to_numeric(df[col], errors="coerce")
        df.loc[(df[col] < 0) | df[col].isin([float("inf"), float("-inf")]), col] = float("nan")
        if col.endswith("share") or col == "snap_pct":
            df.loc[df[col] > 1, col] = float("nan")
    # Denominator is explicitly tracked skill-player carries, not all NFL plays.
    df = df[df.position.isin(["QB", "RB", "WR", "TE"])]
    totals = df.groupby(["team", "week"])["carries"].transform(lambda s: s.sum(min_count=len(s)))
    df["carry_share"] = df.carries / totals.where(totals > 0)

    def value(x):
        return None if pd.isna(x) else round(float(x), 4)

    players = []
    for pid, history in df.groupby("player_id"):
        history = history.sort_values("week")
        last = history.iloc[-1]
        team_weeks = sorted(w for t, w in played if t == last.team)
        current = int(last.week) == max(team_weeks)
        previous_weeks = [w for w in team_weeks if w < last.week][-3:]
        # A trade or an absent game must not bridge incompatible contexts.
        previous = history[(history.team == last.team) & history.week.isin(previous_weeks)]
        comparable = current and len(previous_weeks) >= 2 and len(previous) == len(previous_weeks)
        latest = {m: value(last[m]) for m in METRICS}
        baseline = {m: value(previous[m].mean()) if len(previous) and previous[m].notna().all() else None for m in METRICS}
        delta = {m: round(latest[m] - baseline[m], 4) if comparable and latest[m] is not None and baseline[m] is not None else None for m in METRICS}
        flags = []
        if current:
            if latest["targets"] is not None and latest["targets"] >= 6:
                flags.append("6+ targets in latest observed game")
            if latest["carry_share"] is not None and latest["carry_share"] >= .4 and (latest["carries"] or 0) >= 8:
                flags.append("8+ carries and 40%+ of tracked team carries")
            if (delta["snap_pct"] or 0) >= .10 and ((delta["target_share"] or 0) >= .05 or (delta["carry_share"] or 0) >= .10):
                flags.append("snap share and opportunity share both increased")
        players.append({"player_id":str(pid), "name":last.player_display_name,
                        "position":last.position, "team":last.team, "week":int(last.week),
                        "current_for_team":current, "baseline_weeks":[int(w) for w in previous.week],
                        "comparison_ready":comparable, "latest":latest, "baseline":baseline,
                        "delta":delta, "flags":flags})
    return {"schema_version":1, "season":season, "before_week":before_week,
            "generated_at":datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "through_week":int(df.week.max()) if len(df) else None,
            "status":"observed" if players else "source_gap" if played else "awaiting_observations",
            "completed_team_games":len(played),
            "covered_team_games":len(df[["team", "week"]].drop_duplicates()),
            "sources":["https://nflreadr.nflverse.com/reference/load_player_stats.html",
                       "https://nflreadr.nflverse.com/reference/load_snap_counts.html"],
            "limitations":["Observed game rows only; absent rows are not zero usage.",
                           "Routes and red-zone usage unavailable in this layer.",
                           "Carry share uses tracked QB/RB/WR/TE carries.",
                           "Flags are uncalibrated research thresholds, not breakout probabilities or FAAB prices."],
            "players":players}
