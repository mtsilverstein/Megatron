"""Same-week expert-benchmark primitives (spec docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md).

Pure functions shared by the live weekly scorecard (live_accuracy), the private Sleeper comparator
(sleeper_compare) and the historical re-measurement (weekly_consensus_sameweek). Nothing here touches the
network or git.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ffmodel.data.features import build_features
from ffmodel.data.rankings import attach_gsis
from ffmodel.scoring import PREDICTED_STATS

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


VALIDATION_LIMIT = 0.01
ACTUALS_KEY = ["season", "week", "player_id"]
ACTUALS_ELIGIBILITY = ["team", "position"]
SIDE_KEY = ["season", "week", "team"]
GAME_SIGNATURE = ["season", "week", "gameday", "home_team", "away_team", "game_id"]


@dataclass
class TableValidation:
    valid: pd.DataFrame
    invalid: dict = field(default_factory=dict)          # reason -> set of key tuples
    n_keys: int = 0
    exact_duplicates: int = 0
    key_position: dict = field(default_factory=dict)     # key tuple -> position, for per-position counts

    def invalid_keys(self) -> set:
        out: set = set()
        for keys in self.invalid.values():
            out |= keys
        return out

    def excluded_fraction(self) -> float:
        return 0.0 if self.n_keys == 0 else len(self.invalid_keys()) / self.n_keys

    def fails(self) -> bool:
        return self.excluded_fraction() > VALIDATION_LIMIT

    def report(self) -> dict:
        by_pos: dict[str, dict[str, int]] = {}
        for reason, keys in sorted(self.invalid.items()):
            for k in keys:
                pos = self.key_position.get(k)
                if pos is not None:
                    by_pos.setdefault(reason, {})
                    by_pos[reason][str(pos)] = by_pos[reason].get(str(pos), 0) + 1
        return {"n_keys": int(self.n_keys), "exact_duplicates": int(self.exact_duplicates),
                "invalid_by_reason": {r: len(k) for r, k in sorted(self.invalid.items())},
                "invalid_by_reason_position": {r: dict(sorted(p.items())) for r, p in sorted(by_pos.items())},
                "invalid_keys": len(self.invalid_keys()),
                "excluded_fraction": round(self.excluded_fraction(), 6), "failed": self.fails()}


def _keys(df: pd.DataFrame, key: list[str]) -> pd.Series:
    return pd.Series(list(zip(*[df[k] for k in key])), index=df.index)


def _nonfinite(df: pd.DataFrame, cols: list[str]) -> pd.Series:
    vals = df[cols].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
    return pd.Series(~np.isfinite(vals).all(axis=1), index=df.index)


def validate_table(df: pd.DataFrame, key: list[str], evaluated: list[str], eligibility: list[str],
                   extra_invalid: dict | None = None, position_col: str | None = None,
                   preinvalid: dict | None = None) -> TableValidation:
    """Spec §3.7 for one table. Conflicting keys (a key with more than one distinct row over the key, evaluated
    and eligibility fields) are identified FIRST, over the raw multiset, and invalid as a whole. Exact duplicate
    rows collapse and are counted only within keys that are not conflicting (astra S7-I2). Non-finite evaluated
    fields invalidate the key. `extra_invalid`: reason -> boolean Series aligned to df.index. `preinvalid`:
    reason -> key tuples invalidated upstream (the stage-1 mask); only keys present in df are carried."""
    if len(df) == 0:
        return TableValidation(valid=df.copy())
    keys = _keys(df, key)
    n_keys = int(keys.nunique())
    sig = key + evaluated + eligibility
    repeat = df.duplicated(subset=sig, keep="first")
    distinct = keys[~repeat].value_counts()
    conflict = set(distinct[distinct > 1].index)
    collapse = repeat & ~keys.isin(conflict)
    collapsed = df[~collapse]
    exact_dups = int(collapse.sum())
    ckeys = keys.loc[collapsed.index]
    invalid: dict[str, set] = {}
    if conflict:
        invalid["conflicting_duplicates"] = conflict
    if evaluated:
        bad = _nonfinite(collapsed, evaluated)
        if bad.any():
            invalid["nonfinite"] = set(ckeys[bad])
    for reason, mask in (extra_invalid or {}).items():
        m = mask.reindex(collapsed.index, fill_value=False).astype(bool)
        if m.any():
            invalid.setdefault(reason, set()).update(set(ckeys[m]))
    present = set(ckeys)
    for reason, ks in (preinvalid or {}).items():
        carried = set(ks) & present
        if carried:
            invalid.setdefault(reason, set()).update(carried)
    bad_keys = set().union(*invalid.values()) if invalid else set()
    valid = collapsed[~ckeys.isin(bad_keys)]
    key_position: dict = {}
    if position_col is not None:
        for k, p in zip(ckeys, collapsed[position_col]):
            if isinstance(p, str):
                key_position.setdefault(k, p)          # a group's first row names its position
    return TableValidation(valid=valid, invalid=invalid, n_keys=n_keys, exact_duplicates=exact_dups,
                           key_position=key_position)


def explode_sides(games: pd.DataFrame) -> pd.DataFrame:
    """One row per (season, week, team) side; `opponent` stands in for game_id when the schedule has none."""
    extra = ["game_id"] if "game_id" in games.columns else []
    base = games[["season", "week", "gameday", "home_team", "away_team", *extra]]
    home = base.rename(columns={"home_team": "team", "away_team": "opponent"})
    away = base.rename(columns={"away_team": "team", "home_team": "opponent"})
    sides = pd.concat([home, away], ignore_index=True)
    sides["gameday"] = pd.to_datetime(sides["gameday"]).dt.normalize()
    return sides[["season", "week", "team", "gameday", "opponent", *extra]]


def _validate_sides(sides: pd.DataFrame) -> TableValidation:
    # gameday is a date, so "non-finite" means missing; opponent/game_id identify the game.
    elig = ["gameday"] + [c for c in ("opponent", "game_id") if c in sides.columns]
    return validate_table(sides, SIDE_KEY, [], elig, extra_invalid={"missing_gameday": sides["gameday"].isna()})


@dataclass
class ScheduleCheck:
    """Stage-1 schedule (spec §3.7). `games`: the raw schedule with exact duplicate games collapsed -- the
    build_features input and the source of bye/presence sets. `sides`: the exploded (season, week, team) table,
    validated. `valid_games`: games whose two sides are both valid. `duplicates_by_week`: (season, week) -> exact
    duplicate games collapsed, carried into each week's schedule report."""
    games: pd.DataFrame
    sides: TableValidation
    valid_games: pd.DataFrame
    duplicate_games: int = 0
    duplicates_by_week: dict = field(default_factory=dict)

    def game_date(self, season: int, week: int) -> dict[str, pd.Timestamp]:
        v = self.sides.valid
        wk = v[(v["season"] == season) & (v["week"] == week)]
        return {t: d for t, d in zip(wk["team"], wk["gameday"])}

    def week_validation(self, season: int, week: int) -> TableValidation:
        g = self.games[(self.games["season"] == season) & (self.games["week"] == week)]
        v = _validate_sides(explode_sides(g))
        v.exact_duplicates += self.duplicates_by_week.get((int(season), int(week)), 0)
        return v

    def dates(self, season: int) -> dict[int, tuple[pd.Timestamp, pd.Timestamp]]:
        """K_N/Z_N (spec §3.1) only for the weeks whose schedule slice passes the 1% rule. A failed week has no
        dates, so nothing is ever computed from its surviving games (spec §3.7 schedule dependencies)."""
        g = self.valid_games
        if g[g["season"] == season].empty:
            return {}
        return {w: kz for w, kz in week_dates(g, season).items() if not self.week_validation(season, w).fails()}


def _side_keys(games: pd.DataFrame, col: str) -> pd.Series:
    return pd.Series(list(zip(games["season"], games["week"], games[col])), index=games.index)


def validate_schedule(schedules: pd.DataFrame) -> ScheduleCheck:
    """Conflicting sides are identified first, over the raw rows; exact duplicate games collapse (and are counted
    per week) only when neither of their sides is conflicting (spec §3.7 stage 1 order)."""
    sig = [c for c in GAME_SIGNATURE if c in schedules.columns]
    conflict = _validate_sides(explode_sides(schedules)).invalid.get("conflicting_duplicates", set())
    in_conflict = _side_keys(schedules, "home_team").isin(conflict) | _side_keys(schedules, "away_team").isin(conflict)
    dup = schedules.duplicated(subset=sig, keep="first") & ~in_conflict
    games = schedules[~dup]
    by_week = {(int(s), int(w)): int(n) for (s, w), n in schedules[dup].groupby(["season", "week"]).size().items()}
    sides = _validate_sides(explode_sides(games))
    bad = sides.invalid_keys()
    home_bad, away_bad = _side_keys(games, "home_team").isin(bad), _side_keys(games, "away_team").isin(bad)
    return ScheduleCheck(games=games, sides=sides, valid_games=games[~(home_bad | away_bad)],
                         duplicate_games=int(dup.sum()), duplicates_by_week=by_week)


@dataclass
class Prepared:
    """Stage 1 done, features built. `actuals.invalid` is the invalid-key mask carried to stage 2."""
    features: pd.DataFrame
    schedule: ScheduleCheck
    actuals: TableValidation
    exact_by_week: dict = field(default_factory=dict)


def prepare(weekly_raw: pd.DataFrame, schedules_raw: pd.DataFrame, build=build_features) -> Prepared:
    """Spec §3.7 stage 1, then build_features. Conflicting keys are identified first; exact duplicate actuals rows
    of NON-conflicting keys and exact duplicate games collapse BEFORE features are built (a duplicated row would
    otherwise enter every lag/rolling feature). A conflicting group keeps its whole original multiset, repeats
    included (astra S7-I2), and it and non-finite rows stay in the feature input unchanged, masked from scoring."""
    sc = validate_schedule(schedules_raw)
    sig = ACTUALS_KEY + list(PREDICTED_STATS) + ACTUALS_ELIGIBILITY
    stage1 = validate_table(weekly_raw, ACTUALS_KEY, list(PREDICTED_STATS), ACTUALS_ELIGIBILITY,
                            position_col="position")
    conflicting = stage1.invalid.get("conflicting_duplicates", set())
    dup = weekly_raw.duplicated(subset=sig, keep="first") & ~_keys(weekly_raw, ACTUALS_KEY).isin(conflicting)
    exact_by_week = {(int(s), int(w)): int(n) for (s, w), n in
                     weekly_raw[dup].groupby(["season", "week"]).size().items()}
    features = build(weekly_raw[~dup], sc.games)
    return Prepared(features=features, schedule=sc, actuals=stage1, exact_by_week=exact_by_week)


def week_actuals(prep: Prepared, season: int, week: int) -> TableValidation:
    """Stage 2 for one (season, week): the stage-1 mask plus the schedule join. `valid` keeps the features index."""
    f = prep.features
    rows = f[(f["season"] == season) & (f["week"] == week)]
    dates = prep.schedule.game_date(season, week)
    pre = {r: {k for k in ks if int(k[0]) == season and int(k[1]) == week} for r, ks in prep.actuals.invalid.items()}
    v = validate_table(rows, ACTUALS_KEY, list(PREDICTED_STATS), ACTUALS_ELIGIBILITY,
                       extra_invalid={"schedule_join": ~rows["team"].isin(list(dates))},
                       position_col="position", preinvalid=pre)
    v.exact_duplicates += prep.exact_by_week.get((int(season), int(week)), 0)
    return v


def week_inputs(prep: Prepared, season: int, week: int) -> dict:
    """Both stage-2 tables a weekly computation uses; `failed` applies the 1% rule to each (spec §3.7)."""
    actuals = week_actuals(prep, season, week)
    schedule = prep.schedule.week_validation(season, week)
    return {"actuals": actuals, "schedule": schedule, "failed": actuals.fails() or schedule.fails(),
            "report": {"actuals": actuals.report(), "schedule": schedule.report()}}


def validate_projections(df: pd.DataFrame) -> TableValidation:
    q = df[["p10", "p50", "p90"]].apply(pd.to_numeric, errors="coerce")
    disordered = ~((q["p10"] <= q["p50"]) & (q["p50"] <= q["p90"]))
    finite = np.isfinite(q.to_numpy(dtype=float)).all(axis=1)
    return validate_table(df, ["player_id"], ["p10", "p50", "p90"], ["team", "position"],
                          extra_invalid={"quantile_order": disordered & pd.Series(finite, index=df.index)},
                          position_col="position")


def validate_consensus(snap: pd.DataFrame) -> TableValidation:
    """nflverse consensus rows (spec §3.7 table 4)."""
    return validate_table(snap, ["fp_id"], ["ecr"], ["pos", "team", "mergename"], position_col="pos")


@dataclass
class ConsensusMatch:
    matched: pd.DataFrame | None
    stats: dict
    reason: str | None = None


def match_consensus(snapshot_valid: pd.DataFrame, crosswalk: pd.DataFrame) -> ConsensusMatch:
    """attach_gsis unchanged; any remaining gsis collision invalidates the week's consensus (spec §3.7)."""
    try:
        matched, stats = attach_gsis(snapshot_valid, crosswalk)
    except ValueError as exc:
        return ConsensusMatch(matched=None, stats={"error": str(exc)}, reason="validation_failed")
    stats = {k: v for k, v in stats.items() if k != "unmatched_players"}
    if stats.get("gsis_collisions", 0) > 0:
        return ConsensusMatch(matched=None, stats=stats, reason="identity_collision")
    return ConsensusMatch(matched=matched, stats=stats, reason=None)
