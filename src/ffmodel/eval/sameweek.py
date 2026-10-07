"""Same-week expert-benchmark primitives (spec docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md).

Pure functions shared by the live weekly scorecard (live_accuracy), the private Sleeper comparator
(sleeper_compare) and the historical re-measurement (weekly_consensus_sameweek). Nothing here touches the
network or git.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

POSITIONS = ("QB", "RB", "WR", "TE")
# Ranking (FantasyPros/nflverse) team code -> schedule code (normalize_schedule_teams uses LA for the Rams).
TEAM_TO_SCHEDULE = {"LAR": "LA", "STL": "LA", "JAC": "JAX", "SD": "LAC", "OAK": "LV", "LVR": "LV", "WSH": "WAS",
                    "ARZ": "ARI", "BLT": "BAL", "CLV": "CLE", "HST": "HOU", "KCC": "KC", "GBP": "GB", "NOS": "NO",
                    "NEP": "NE", "SFO": "SF", "TBB": "TB"}
IGNORED_TEAM_CODES = {"", "FA"}
UNKNOWN_CODE_LIMIT = 0.02


def map_team(code) -> str | None:
    if code is None or (isinstance(code, float) and pd.isna(code)):
        return None
    c = str(code).strip().upper()
    if c in IGNORED_TEAM_CODES:
        return None
    return TEAM_TO_SCHEDULE.get(c, c)


def _season_games(schedules: pd.DataFrame, season: int) -> pd.DataFrame:
    g = schedules[schedules["season"] == season]
    if "game_type" in g.columns:
        g = g[g["game_type"] == "REG"]
    return g.assign(_day=pd.to_datetime(g["gameday"]).dt.normalize())


def week_dates(schedules: pd.DataFrame, season: int) -> dict[int, tuple[pd.Timestamp, pd.Timestamp]]:
    """week -> (K_N, Z_N): earliest and latest gameday (spec §3.1). Pass the VALIDATED games (§3.7)."""
    g = _season_games(schedules, season)
    if g.empty:
        raise ValueError(f"no REG games for season {season}")
    agg = g.groupby("week")["_day"].agg(["min", "max"])
    return {int(w): (r["min"], r["max"]) for w, r in agg.iterrows()}


def season_teams(schedules: pd.DataFrame, season: int) -> set[str]:
    g = _season_games(schedules, season)
    return set(g["home_team"]) | set(g["away_team"])


def week_teams(schedules: pd.DataFrame, season: int, week: int) -> set[str]:
    g = _season_games(schedules, season)
    wk = g[g["week"] == week]
    return set(wk["home_team"]) | set(wk["away_team"])


def bye_teams(schedules: pd.DataFrame, season: int, week: int) -> set[str]:
    if week < 1:
        return set()
    playing = week_teams(schedules, season, week)
    if not playing:
        return set()
    return season_teams(schedules, season) - playing


def page_state(R: set, A: set, B: set) -> str:
    a = len(A & R) / len(A) if A else None
    b = len(B & R) / len(B) if B else None
    if (a is not None and a > 0.5) or (b is not None and b < 0.5):
        return "contradicted"
    defined = [x for x in (a, b) if x is not None]
    if defined and (a is None or a < 0.5) and (b is None or b > 0.5):
        return "bye_consistent"
    return "unverified"


@dataclass
class GateResult:
    state: str
    pages: dict = field(default_factory=dict)
    unknown_team_codes: int = 0
    rows: int = 0


def gate(snapshot: pd.DataFrame, schedules: pd.DataFrame, season: int, week: int) -> GateResult:
    """Spec §3.5 tri-state week-identity gate over pages (pos) of one scrape assigned to `week`."""
    teams = season_teams(schedules, season)
    A = bye_teams(schedules, season, week)
    B = bye_teams(schedules, season, week - 1) if week > 1 else set()
    scope = snapshot[snapshot["pos"].isin(POSITIONS)] if len(snapshot) else snapshot
    mapped = scope["team"].map(map_team) if len(scope) else pd.Series(dtype=object)
    unknown = int((mapped.notna() & ~mapped.isin(teams)).sum()) if len(scope) else 0
    pages = {}
    for pos in POSITIONS:
        rows = scope[scope["pos"] == pos] if len(scope) else scope
        if len(rows) == 0:
            pages[pos] = "absent"
            continue
        R = set(mapped.loc[rows.index].dropna()) & teams
        pages[pos] = page_state(R, A, B)
    present = [s for s in pages.values() if s != "absent"]
    if not present:
        state = "unverified"
    elif "contradicted" in present:
        state = "contradicted"
    elif all(s == "bye_consistent" for s in present):
        state = "bye_consistent"
    else:
        state = "unverified"
    if state == "bye_consistent" and (unknown > UNKNOWN_CODE_LIMIT * len(scope) or "absent" in pages.values()):
        state = "unverified"
    return GateResult(state=state, pages=pages, unknown_team_codes=unknown, rows=int(len(scope)))
