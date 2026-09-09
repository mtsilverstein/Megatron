"""A small, explicit kickoff contract; the model's schedule drops gametime."""
from datetime import datetime, timezone
import pandas as pd


def build_kickoffs(raw, season, week):
    season_rows = raw[(raw.season == season) & (raw.game_type == "REG")]
    rows = season_rows[season_rows.week == week]
    if rows.empty:
        raise ValueError("No scheduled games for kickoff contract")
    games = []
    seen = set()
    for r in rows.itertuples():
        if pd.isna(r.gameday) or pd.isna(r.gametime):
            raise ValueError("Kickoff time is unknown; refusing to guess")
        kickoff = pd.Timestamp(f"{r.gameday} {r.gametime}").tz_localize("America/New_York").tz_convert("UTC")
        for team in [r.home_team, r.away_team]:
            if team in seen:
                raise ValueError("Duplicate scheduled team")
            seen.add(team)
        games.append({"home":r.home_team,"away":r.away_team,"kickoff":kickoff.isoformat()})
    return {"season":season,"week":week,"generated_at":datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "teams":sorted(set(season_rows.home_team) | set(season_rows.away_team)),"games":games,
            "source":"https://nflreadr.nflverse.com/articles/dictionary_schedules.html"}


def pull_kickoffs(season, week):
    import nflreadpy
    return build_kickoffs(nflreadpy.load_schedules([season]).to_pandas(), season, week)
