"""Same-week expert-benchmark primitives (spec docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md).

Pure functions shared by the live weekly scorecard (live_accuracy), the private Sleeper comparator
(sleeper_compare) and the historical re-measurement (weekly_consensus_sameweek). Nothing here touches the
network or git.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.stats import ConstantInputWarning

from ffmodel.data.features import build_features
from ffmodel.data.rankings import attach_gsis
from ffmodel.eval.weekly_rankings import score_week, weekly_snapshot
from ffmodel.scoring import PREDICTED_STATS
from ffmodel.site.draft import REPLACEMENT_RANK

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


def _collapse_masks(df: pd.DataFrame, key: list[str], sig: list[str]) -> tuple[pd.Series, set, pd.Series]:
    """The one place the collapse/conflict masks are computed: (key tuples, conflicting keys, collapsible repeats).
    A key is conflicting when it has more than one distinct row over `sig`; repeats collapse only elsewhere."""
    keys = _keys(df, key)
    repeat = df.duplicated(subset=sig, keep="first")
    distinct = keys[~repeat].value_counts()
    conflict = set(distinct[distinct > 1].index)
    return keys, conflict, repeat & ~keys.isin(conflict)


def validate_table(df: pd.DataFrame, key: list[str], evaluated: list[str], eligibility: list[str],
                   extra_invalid: dict | None = None, position_col: str | None = None,
                   preinvalid: dict | None = None, signature: list[str] | None = None) -> TableValidation:
    """Spec §3.7 for one table. Conflicting keys (a key with more than one distinct row over the key, evaluated
    and eligibility fields) are identified FIRST, over the raw multiset, and invalid as a whole. Exact duplicate
    rows collapse and are counted only within keys that are not conflicting (astra S7-I2). Non-finite evaluated
    fields invalidate the key. `extra_invalid`: reason -> boolean Series aligned to df.index. `preinvalid`:
    reason -> key tuples invalidated upstream (the stage-1 mask); only keys present in df are carried.
    `signature`: columns that define an exact duplicate (stage 1 passes every raw column; default key + evaluated +
    eligibility)."""
    if len(df) == 0:
        return TableValidation(valid=df.copy())
    keys, conflict, collapse = _collapse_masks(df, key, signature or key + evaluated + eligibility)
    n_keys = int(keys.nunique())
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


def explode_sides(games: pd.DataFrame, carry: list[str] | None = None) -> pd.DataFrame:
    """One row per (season, week, team) side; `opponent` stands in for game_id when the schedule has none and
    `role` (home/away) distinguishes a home/away-swapped listing. `carry`: extra game columns kept on each side."""
    extra = ["game_id"] if "game_id" in games.columns else []
    carry = list(carry or [])
    base = games[["season", "week", "gameday", "home_team", "away_team", *extra, *carry]]
    home = base.rename(columns={"home_team": "team", "away_team": "opponent"}).assign(role="home")
    away = base.rename(columns={"away_team": "team", "home_team": "opponent"}).assign(role="away")
    sides = pd.concat([home, away], ignore_index=True)
    sides["gameday"] = pd.to_datetime(sides["gameday"]).dt.normalize()
    return sides[["season", "week", "team", "gameday", "opponent", "role", *extra, *carry]]


def _game_sides(games: pd.DataFrame) -> pd.DataFrame:
    """Sides of `games`, each carrying `_row_sig`: an id of the game's WHOLE raw row, so two listings of one side
    that differ in any column (roof, ...) conflict (spec §3.7 stage 1)."""
    if games.empty:
        return explode_sides(games)
    sig = games.groupby(list(games.columns), dropna=False, sort=False).ngroup()
    return explode_sides(games.assign(_row_sig=sig), carry=["_row_sig"])


def _validate_sides(sides: pd.DataFrame) -> TableValidation:
    # gameday is a date, so "non-finite" means missing; opponent/role/game_id identify the game.
    elig = ["gameday", "role"] + [c for c in ("opponent", "game_id", "_row_sig") if c in sides.columns]
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
        v = _validate_sides(_game_sides(g))
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
    sig = list(schedules.columns)                       # stage 1: an exact duplicate is identical in EVERY column
    conflict = _validate_sides(_game_sides(schedules)).invalid.get("conflicting_duplicates", set())
    in_conflict = _side_keys(schedules, "home_team").isin(conflict) | _side_keys(schedules, "away_team").isin(conflict)
    dup = schedules.duplicated(subset=sig, keep="first") & ~in_conflict
    games = schedules[~dup]
    by_week = {(int(s), int(w)): int(n) for (s, w), n in schedules[dup].groupby(["season", "week"]).size().items()}
    sides = _validate_sides(_game_sides(games))
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
    sig = list(weekly_raw.columns)                      # stage 1: an exact duplicate is identical in EVERY column
    stage1 = validate_table(weekly_raw, ACTUALS_KEY, list(PREDICTED_STATS), ACTUALS_ELIGIBILITY,
                            position_col="position", signature=sig)
    dup = _collapse_masks(weekly_raw, ACTUALS_KEY, sig)[2] if len(weekly_raw) else pd.Series(False, index=weekly_raw.index)
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


ONE_DAY = pd.Timedelta(days=1)


def window_dates_ok(dates: dict, week: int) -> bool:
    """The §5.2 window and overlap guard for week N need the dates of weeks N-1 and N (week 1 needs only its own).
    `dates` comes from ScheduleCheck.dates, so a missing week is one whose schedule slice failed (spec §3.7)."""
    return week in dates and (week == 1 or (week - 1) in dates)


def _require_window_dates(dates: dict, week: int) -> None:
    if not window_dates_ok(dates, week):
        raise ValueError(f"schedule_dependency_failed: week {week} needs the validated dates of weeks "
                         f"{[w for w in (week - 1, week) if w >= 1]}")


def overlapping(dates: dict, week: int) -> bool:
    _require_window_dates(dates, week)
    return week > 1 and dates[week - 1][1] >= dates[week][0]


def sameweek_window(dates: dict, week: int) -> tuple[pd.Timestamp, pd.Timestamp]:
    """[L_N, Z_N). L_1 = K_1 - 7 days for week 1 only; never a fallback for N > 1 (astra S7-I3)."""
    _require_window_dates(dates, week)
    K, Z = dates[week]
    L = K - pd.Timedelta(days=7) if week == 1 else dates[week - 1][1] + ONE_DAY
    return L, Z


def select_sameweek_scrape(rankings: pd.DataFrame, sc: ScheduleCheck, season: int, week: int,
                           dates: dict) -> dict:
    """Latest scrape in [L_N, Z_N) that the gate does not contradict and that precedes a week-N game.
    Metadata only: actual appearances are never consulted, and there is no fallback after selection."""
    L, U = sameweek_window(dates, week)
    day = rankings["scrape_date"].dt.normalize()
    in_window = rankings[(day >= L) & (day < U)]
    game_days = sorted(set(sc.game_date(season, week).values()))
    candidates, chosen = [], None
    for date in sorted(in_window["scrape_date"].dt.normalize().unique()):
        date = pd.Timestamp(date)
        g = gate(in_window[in_window["scrape_date"].dt.normalize() == date], sc.games, season, week)
        later = any(gd > date for gd in game_days)
        candidates.append({"date": date, "state": g.state, "has_later_game": later,
                           "pages": g.pages, "unknown_team_codes": g.unknown_team_codes})
        if g.state != "contradicted" and later:
            chosen = (date, g)
    return {"scrape_date": chosen[0] if chosen else None, "gate": chosen[1] if chosen else None,
            "candidates": candidates}


def build_cells(pool: pd.DataFrame, season: int, week: int, gate_state: str) -> tuple[list[dict], int]:
    # A constant column gives an undefined Spearman: scipy warns, and pytest -W error would turn that into an
    # exception. The cell is dropped and counted as degenerate instead.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", ConstantInputWarning)
        rows = score_week(pool[["player_id", "position", "our_pts", "ecr", "actual"]], season, week,
                          REPLACEMENT_RANK, min_cell=5)
    cells, degenerate = [], 0
    for r in rows:
        if not (np.isfinite(r["sp_ours"]) and np.isfinite(r["sp_con"])):
            degenerate += 1
            continue
        cells.append(dict(r, gate_state=gate_state, n_le_slots=bool(r["n"] <= REPLACEMENT_RANK[r["position"]])))
    return cells, degenerate


def cell_summary(cells: list[dict]) -> list[dict]:
    """Per-week values retained in artifacts (spec §4.3): n, both Spearmans and their delta per position."""
    return [{"position": c["position"], "n": int(c["n"]), "sp_ours": float(c["sp_ours"]),
             "sp_con": float(c["sp_con"]), "delta": float(c["sp_ours"] - c["sp_con"])} for c in cells]


def _skip(reason: str, **extra) -> dict:
    return {"status": "skipped", "reason": reason, "cells": [], "degenerate": 0, **extra}


def sameweek_week(played: pd.DataFrame, sc: ScheduleCheck, rankings: pd.DataFrame, crosswalk: pd.DataFrame,
                  season: int, week: int, dates: dict) -> dict:
    """`played`: validated played rows (player_id, position, team, our_pts, actual). `dates`: sc.dates(season).
    A failed week N-1 or N schedule slice skips the comparison before the overlap guard (spec §3.7)."""
    if not window_dates_ok(dates, week):
        return _skip("validation_failed", detail="schedule_dependency_failed")
    if overlapping(dates, week):
        return _skip("overlapping_weeks")
    sel = select_sameweek_scrape(rankings, sc, season, week, dates)
    state = sel["gate"].state if sel["gate"] else None
    selection = {"scrape_date": str(sel["scrape_date"].date()) if sel["scrape_date"] is not None else None,
                 "state": state, "pages": sel["gate"].pages if sel["gate"] else None,
                 "label": "inferred_by_window" if state == "unverified" else None,
                 "candidates": [{"date": str(c["date"].date()), "state": c["state"],
                                 "has_later_game": c["has_later_game"], "pages": c["pages"],
                                 "unknown_team_codes": c["unknown_team_codes"]} for c in sel["candidates"]]}
    if sel["scrape_date"] is None:
        return _skip("no_candidate_scrape", selection=selection)
    date = sel["scrape_date"]
    snap = rankings[(rankings["scrape_date"].dt.normalize() == date) & rankings["pos"].isin(POSITIONS)]
    v = validate_consensus(snap)
    if v.fails():
        return _skip("validation_failed", selection=selection, validation=v.report())
    m = match_consensus(v.valid, crosswalk)
    if m.reason:
        return _skip(m.reason, selection=selection, validation=v.report(), match=m.stats)
    gdates = sc.game_date(season, week)
    gday = played["team"].map(gdates)
    eligible = played[gday > date]
    early = played[~(gday > date)]
    con = m.matched[["player_id", "ecr"]].drop_duplicates(subset="player_id", keep="first")
    pool = eligible.merge(con, on="player_id", how="inner")
    cells, degenerate = build_cells(pool, season, week, state)
    retention = {"played": int(len(played)), "excluded_early_game": int(len(early)),
                 "excluded_early_by_position": early["position"].value_counts().sort_index().astype(int).to_dict(),
                 "pool": int(len(pool)), "match_rate": m.stats.get("match_rate"),
                 "pool_by_position": pool["position"].value_counts().sort_index().astype(int).to_dict()}
    if not cells:
        return _skip("no_scorable_cell", selection=selection, validation=v.report(), match=m.stats,
                     retention=retention, degenerate=degenerate)
    return {"status": "scored", "reason": None, "selection": selection, "cells": cells, "degenerate": degenerate,
            "validation": v.report(), "match": m.stats, "retention": retention}


def staleness_audit_week(rankings: pd.DataFrame, sc: ScheduleCheck, season: int, week: int, dates: dict) -> dict:
    """The old protocol's scrape for week N and its §3.5 state. Its table read obeys the 1% rule (spec §3.7)."""
    K = dates[week][0]
    snap = weekly_snapshot(rankings, pd.Timestamp(K))
    A = bye_teams(sc.games, season, week)
    B = bye_teams(sc.games, season, week - 1) if week > 1 else set()
    out = {"week": int(week), "kickoff": str(K.date()), "scrape_date": None, "state": None, "reason": None,
           "discriminating": bool(A and B and A != B)}
    if snap is None:
        out["reason"] = "no_old_protocol_scrape"
        return out
    out["scrape_date"] = str(snap["scrape_date"].iloc[0].date())
    if validate_consensus(snap[snap["pos"].isin(POSITIONS)]).fails():
        out["reason"] = "validation_failed"
        return out
    out["state"] = gate(snap, sc.games, season, week).state
    return out


def ranking_coverage(raw: pd.DataFrame, rankings: pd.DataFrame, seasons: list[int]) -> dict:
    """Spec §3.6: per season, raw vs accepted rows, legacy-schema exclusions, scrape dates with weekdays."""
    def season_of(d: pd.Series) -> pd.Series:
        return d.dt.year.where(d.dt.month >= 3, d.dt.year - 1)

    raw_wp = raw[(raw["ecr_type"] == "wp") & raw["pos"].isin(POSITIONS)]
    raw_dates = pd.to_datetime(raw_wp["scrape_date"])
    out = {}
    for s in seasons:
        in_raw = season_of(raw_dates) == s
        acc = rankings[season_of(rankings["scrape_date"]) == s]
        days = sorted(pd.Timestamp(d) for d in acc["scrape_date"].dt.normalize().unique())
        out[str(s)] = {"raw_rows": int(in_raw.sum()), "accepted_rows": int(len(acc)),
                       "excluded_legacy_schema": int((in_raw & (raw_wp["page_type"] == "weekly-offense")).sum()),
                       "scrape_dates": [{"date": str(d.date()), "weekday": d.day_name()} for d in days]}
    return out
