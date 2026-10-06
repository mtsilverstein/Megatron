# Weekly Accuracy and Same-Week Benchmark: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two things.

- (A) An automated weekly scorecard of the projections the bot pipeline published before each kickoff.
- (B) A pre-registered re-measurement of the weekly model-vs-expert benchmark against same-week rankings, with
  verdicts computed in code.

**Architecture:**

- `src/ffmodel/eval/sameweek.py` holds the shared pure primitives:
  - team mapping
  - schedule dates
  - the bye-week identity gate
  - validation
  - same-week scrape selection
  - per-week cells
  - statistics and decision rules
- `src/ffmodel/eval/live_accuracy.py` is (A). It reads publications and archives from git and proves them with a
  committed push ledger built from GitHub's activity API, then scores them against nflverse actuals. A Tuesday
  workflow runs it.
- `src/ffmodel/eval/weekly_consensus_sameweek.py` is (B). It runs once, by hand.

**Tech stack:** Python 3.12 (CI) / 3.14 (local), pandas, numpy, scipy (via existing modules), pytest, git CLI,
`gh` CLI, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md`, draft 6 (commit 5e651df). Read it
first: it is the source of truth, and this plan implements it.

## Global Constraints

**Repo and environment:**
- Branch `feat/weekly-accuracy`, in the main checkout. Never commit to `main`; never push.
- Run pytest as `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider`. Use `.venv/Scripts/python.exe`
  for all Python.
- Repo is PUBLIC. All test fixtures are synthetic: no real league or manager data, no other managers' names.

**What must not change:**
- Do NOT edit `src/ffmodel/eval/weekly_rankings.py`, `src/ffmodel/eval/weekly_consensus.py` or
  `src/ffmodel/data/rankings.py`. Import them unchanged.
- Do NOT touch `site/`, `models/prospective/**`, `.github/workflows/prospective-*.yml` or
  `.github/workflows/weekly-update.yml`.
- Tests make no network calls. Git and the GitHub API are injected; tests pass fakes.

**Fixed values (copy exactly):**
- Bootstrap: seed `20260728`, `10000` resamples, via `ffmodel.eval.mean_head_gate.paired_bootstrap`.
- Cluster keys are 1-D scalars: `season*100 + week` for ranking cells, `f"{week}|{team}"` and `player_id` for point
  deltas.
- `min_cell=5`; `REPLACEMENT_RANK` comes from `ffmodel.site.draft`.
- Unknown team-code downgrade threshold: `0.02`. Validation threshold: `0.01` (exactly 1% passes).
- Cutoff for week N is `K_N` 00:00 UTC, where `K_N` = the earliest `gameday` of REG week N.
- Bot identities: publications by `weekly-update-bot`; the accuracy job commits as `weekly-accuracy-bot`.
- PPR weights for neutral re-scoring: `ffmodel.site.leaguelens.effective_weights` of `sleeper_scoring` in
  `configs/formats/f12-1qb-ppr-4.yaml`. Equivalence tolerance: `0.01`.
- Team mapping (ranking code → schedule code):
  `{"LAR":"LA","STL":"LA","JAC":"JAX","SD":"LAC","OAK":"LV","LVR":"LV","WSH":"WAS","ARZ":"ARI","BLT":"BAL","CLV":"CLE","HST":"HOU","KCC":"KC","GBP":"GB","NOS":"NO","NEP":"NE","SFO":"SF","TBB":"TB"}`.
  Ignored codes: blank, `FA`.

**Exact strings:**
- Gate states: `contradicted`, `bye_consistent`, `unverified`, `absent`.
- Skip reasons: `overlapping_weeks`, `no_candidate_scrape`, `no_scorable_cell`, `validation_failed`,
  `identity_collision`, `equivalence_failed`, `archive_hash_mismatch`, `publication_evidence_unavailable`,
  `weeks_unpublished`, `no_archive`, `incomplete_week`.
- Verdict values: `insufficient`, `behind`, `ahead`, `not_established`, `established`.
- Reason codes: `interval_includes_zero`, `interval_opposite_side`, `season_inconsistent`,
  `leave_one_season_out_reversal`, `leave_one_season_out_zero`, `sensitivity_absent`, `sensitivity_disagrees`,
  `sensitivity_zero`, `zero_estimate`.

**Precision:** verdict inputs are full precision. Round only when writing display fields.

## Review Focus

These inputs are the most likely to break the code, and the spec implies them without any task's happy-path tests
covering them. Each item has a pinned test in its owning task.

1. **Real-cache team codes** (`LAR`, `JAC`, `FA`). Expect `unknown_team_codes == 0` on every 2020–25 scrape, with
   no Rams row unknown. Pinned in Task 1 (unit) and Task 9 (real cache).
2. **Dual-page same-key duplicates in a real scrape** (one `fp_id` on two pages with different ECR). Expect the
   whole group invalid. The week runs unless it exceeds 1%, and there is no crash or reconciliation failure. Pinned
   in Task 2.
3. **A week whose selected archive was pushed after the cutoff** (the 2026 week-3 shape). Expect the primary ranking
   skipped as `no_archive` while the point metrics are still scored. Pinned in Task 5.
4. **A Tuesday run before Monday-night stats land.** Expect that week to be `incomplete_week`, never scored with
   partial stats, and earlier weeks unaffected. Pinned in Task 6.
5. **A commit with only the neutral file (legacy retired).** Expect it to remain a publication candidate, scored by
   re-scoring stat quantiles. Pinned in Task 5 (candidate) and Task 6 (values).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/ffmodel/eval/sameweek.py` (create) | Pure primitives: team mapping, dates, gate, validation, consensus matching, same-week selection, per-week cells, stats, rules |
| `src/ffmodel/eval/live_accuracy.py` (create) | (A): ledger, git adapter, publication/archive evidence, published values, point and ranking metrics, artifact, markdown, CLI |
| `src/ffmodel/eval/weekly_consensus_sameweek.py` (create) | (B): sample runner, old-protocol diagnostic, staleness audit, coverage, verdicts, CLI |
| `.github/workflows/weekly-accuracy.yml` (create) | Tuesday/Wednesday job |
| `models/diagnostics/main_push_ledger.json` (create) | Ledger seeded from the 2026-10-06 activity capture |
| `tools/build_push_ledger_seed.py` (create) | One-shot converter from the raw seed to the ledger |
| `tools/weekly_accuracy_acceptance.py` (create) | Real-cache acceptance checks |
| `tests/test_sameweek_gate.py`, `tests/test_sameweek_validation.py`, `tests/test_sameweek_selection.py`, `tests/test_sameweek_rules.py`, `tests/test_live_accuracy_evidence.py`, `tests/test_live_accuracy_metrics.py`, `tests/test_weekly_accuracy_workflow.py`, `tests/test_weekly_consensus_sameweek.py` (create) | Tests |

---

### Task 1: sameweek — team mapping, schedule dates, bye-week gate

**Files:**
- Create: `src/ffmodel/eval/sameweek.py`
- Test: `tests/test_sameweek_gate.py`

**Interfaces:**
- Produces:
  - `POSITIONS: tuple[str, ...]`, `TEAM_TO_SCHEDULE: dict[str, str]`, `UNKNOWN_CODE_LIMIT = 0.02`
  - `map_team(code) -> str | None`
  - `week_dates(schedules, season) -> dict[int, tuple[pd.Timestamp, pd.Timestamp]]` (week → (K, Z), normalised
    dates)
  - `season_teams(schedules, season) -> set[str]`
  - `bye_teams(schedules, season, week) -> set[str]` (empty for week < 1)
  - `team_game_dates(schedules, season, week) -> dict[str, list[pd.Timestamp]]`
  - `page_state(R, A, B) -> str`
  - `GateResult` (dataclass: `state`, `pages`, `unknown_team_codes`, `rows`)
  - `gate(snapshot, schedules, season, week) -> GateResult`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_sameweek_gate.py
"""Offline tests for the same-week primitives: team mapping, dates, bye gate (spec §3.1, §3.4, §3.5)."""
import pandas as pd
import pytest

from ffmodel.data.pull import normalize_schedule_teams
from ffmodel.eval import sameweek as sw

TEAMS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]


def _sched(rows):
    return pd.DataFrame(rows, columns=["season", "week", "gameday", "home_team", "away_team"])


def _season():
    # wk1: all play. wk2: EEE/FFF bye. wk3: CCC/DDD bye. wk4: none bye.
    return _sched([
        (2024, 1, "2024-09-05", "AAA", "BBB"), (2024, 1, "2024-09-08", "CCC", "DDD"), (2024, 1, "2024-09-09", "EEE", "FFF"),
        (2024, 2, "2024-09-12", "AAA", "BBB"), (2024, 2, "2024-09-15", "CCC", "DDD"),
        (2024, 3, "2024-09-19", "AAA", "BBB"), (2024, 3, "2024-09-22", "EEE", "FFF"),
        (2024, 4, "2024-09-26", "AAA", "CCC"), (2024, 4, "2024-09-29", "BBB", "DDD"), (2024, 4, "2024-09-30", "EEE", "FFF"),
    ])


def _snap(teams_by_pos):
    rows = []
    for pos, teams in teams_by_pos.items():
        for i, t in enumerate(teams):
            rows.append({"fp_id": f"{pos}{i}{t}", "player": f"p{pos}{i}{t}", "pos": pos, "team": t,
                         "ecr": float(i + 1), "sd": 1.0, "mergename": f"p{pos}{i}{t}",
                         "scrape_date": pd.Timestamp("2024-09-20")})
    return pd.DataFrame(rows)


def test_team_mapping_targets_are_schedule_codes():
    real = normalize_schedule_teams(pd.DataFrame({"home_team": ["STL", "SD", "OAK", "LA", "JAX"],
                                                  "away_team": ["LA", "LAC", "LV", "WAS", "ARI"]}))
    schedule_codes = set(real["home_team"]) | set(real["away_team"]) | {
        "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
        "LAC", "LA", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS", "ARI"}
    assert set(sw.TEAM_TO_SCHEDULE.values()) <= schedule_codes
    assert sw.map_team("LAR") == "LA"
    assert sw.map_team("JAC") == "JAX"
    assert sw.map_team("FA") is None and sw.map_team("") is None and sw.map_team(None) is None
    assert sw.map_team("buf") == "BUF"


def test_week_dates_and_byes():
    s = _season()
    d = sw.week_dates(s, 2024)
    assert d[1] == (pd.Timestamp("2024-09-05"), pd.Timestamp("2024-09-09"))
    assert sw.bye_teams(s, 2024, 2) == {"EEE", "FFF"}
    assert sw.bye_teams(s, 2024, 0) == set()
    assert sw.team_game_dates(s, 2024, 2)["CCC"] == [pd.Timestamp("2024-09-15")]


@pytest.mark.parametrize("R,A,B,expected", [
    ({"AAA", "BBB", "EEE", "FFF"}, {"CCC", "DDD"}, {"EEE", "FFF"}, "bye_consistent"),   # current on both counts
    ({"AAA", "BBB", "CCC", "DDD"}, {"CCC", "DDD"}, {"EEE", "FFF"}, "contradicted"),     # stale on both counts
    ({"CCC", "DDD"}, {"CCC", "DDD"}, set(), "contradicted"),                            # stale a, B empty
    ({"AAA"}, set(), set(), "unverified"),                                              # no byes
    ({"CCC", "EEE"}, {"CCC", "DDD"}, set(), "unverified"),                              # exact half
    ({"CCC"}, {"CCC"}, set(), "contradicted"),                                          # single mis-teamed row, one bye team
    ({"AAA", "BBB", "EEE"}, set(), {"EEE", "FFF", "GGG", "HHH"}, "contradicted"),       # b = 1/4 < 0.5
])
def test_page_state(R, A, B, expected):
    assert sw.page_state(R, A, B) == expected


def test_one_of_four_previous_bye_teams_missing_still_consistent():
    assert sw.page_state({"EEE", "FFF", "GGG"}, set(), {"EEE", "FFF", "GGG", "HHH"}) == "bye_consistent"


def test_gate_week_states():
    s = _season()
    fresh = {p: ["AAA", "BBB", "EEE", "FFF"] for p in sw.POSITIONS}            # week 3: CCC/DDD bye, EEE/FFF back
    assert sw.gate(_snap(fresh), s, 2024, 3).state == "bye_consistent"
    mixed = dict(fresh, RB=["AAA", "BBB", "CCC", "DDD"])                       # RB page stale
    g = sw.gate(_snap(mixed), s, 2024, 3)
    assert g.state == "contradicted" and g.pages["RB"] == "contradicted"
    absent = {p: t for p, t in fresh.items() if p != "TE"}
    assert sw.gate(_snap(absent), s, 2024, 3).state == "unverified"           # absent page downgrades
    assert sw.gate(_snap({}), s, 2024, 3).state == "unverified"               # all absent


def test_gate_unknown_codes_downgrade_but_never_erase_contradiction():
    s = _season()
    fresh = {p: ["AAA", "BBB", "EEE", "FFF"] for p in sw.POSITIONS}
    snap = _snap(fresh)
    junk = snap.head(1).assign(team="ZZZ", fp_id="junk")                       # 1 of 17 rows unknown (> 2%)
    g = sw.gate(pd.concat([snap, junk], ignore_index=True), s, 2024, 3)
    assert g.unknown_team_codes == 1 and g.state == "unverified"
    stale = _snap({p: ["AAA", "BBB", "CCC", "DDD"] for p in sw.POSITIONS})
    g2 = sw.gate(pd.concat([stale, junk], ignore_index=True), s, 2024, 3)
    assert g2.state == "contradicted"


def test_gate_documents_non_proof_when_no_current_byes():
    # week 4 has no byes (A empty); a week-3-era page listing the week-3 returners (EEE/FFF) still passes
    s = _season()
    other_week = _snap({p: ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"] for p in sw.POSITIONS})
    assert sw.gate(other_week, s, 2024, 4).state == "bye_consistent"
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_gate.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'ffmodel.eval.sameweek'`.

- [ ] **Step 3: Implement**

```python
# src/ffmodel/eval/sameweek.py
"""Same-week expert-benchmark primitives (spec docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md).

Pure functions shared by the live weekly scorecard (live_accuracy) and the historical re-measurement
(weekly_consensus_sameweek). Nothing here touches the network or git.
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
    g = _season_games(schedules, season)
    if g.empty:
        raise ValueError(f"no REG games for season {season}")
    agg = g.groupby("week")["_day"].agg(["min", "max"])
    return {int(w): (r["min"], r["max"]) for w, r in agg.iterrows()}


def season_teams(schedules: pd.DataFrame, season: int) -> set[str]:
    g = _season_games(schedules, season)
    return set(g["home_team"]) | set(g["away_team"])


def bye_teams(schedules: pd.DataFrame, season: int, week: int) -> set[str]:
    if week < 1:
        return set()
    g = _season_games(schedules, season)
    wk = g[g["week"] == week]
    if wk.empty:
        return set()
    return season_teams(schedules, season) - (set(wk["home_team"]) | set(wk["away_team"]))


def team_game_dates(schedules: pd.DataFrame, season: int, week: int) -> dict[str, list[pd.Timestamp]]:
    g = _season_games(schedules, season)
    wk = g[g["week"] == week]
    out: dict[str, list[pd.Timestamp]] = {}
    for _, r in wk.iterrows():
        for t in (r["home_team"], r["away_team"]):
            out.setdefault(t, []).append(r["_day"])
    return out


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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_gate.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/sameweek.py tests/test_sameweek_gate.py
git commit -m "feat(sameweek): team mapping to schedule codes, schedule dates, tri-state bye-week gate (spec §3.1/3.4/3.5)"
```

---

### Task 2: sameweek — validation and consensus matching

**Files:**
- Modify: `src/ffmodel/eval/sameweek.py` (append)
- Test: `tests/test_sameweek_validation.py`

**Interfaces:**
- Consumes: `team_game_dates` (Task 1).
- Produces:
  - `VALIDATION_LIMIT = 0.01`
  - `TableValidation` (dataclass)
    - fields: `valid: pd.DataFrame`, `invalid: dict[str, set]`, `n_keys: int`, `exact_duplicates: int`
    - methods: `invalid_keys() -> set`, `excluded_fraction() -> float`, `fails() -> bool`, `report() -> dict`
  - `validate_table(df, key, evaluated, eligibility, extra_invalid=None) -> TableValidation`
    - `extra_invalid` is a `dict[str, pd.Series[bool]]` aligned to `df.index`
  - `validate_actuals(rows, schedules, season, week) -> TableValidation`
    - `valid` keeps the original index of the surviving rows
  - `validate_projections(df) -> TableValidation` (columns `player_id, team, position, p10, p50, p90`)
  - `ConsensusMatch` (dataclass: `matched: pd.DataFrame | None`, `stats: dict`, `reason: str | None`)
  - `match_consensus(snapshot_valid, crosswalk) -> ConsensusMatch`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_sameweek_validation.py
"""Spec §3.7 validation, masking and identity-collision handling. Synthetic data only."""
import numpy as np
import pandas as pd

from ffmodel.eval import sameweek as sw
from ffmodel.scoring import PREDICTED_STATS


def _cons(rows):
    return pd.DataFrame(rows, columns=["fp_id", "player", "pos", "team", "ecr", "sd", "mergename", "scrape_date"])


def test_exact_duplicates_collapse_and_conflicts_invalidate_group():
    d = pd.Timestamp("2022-12-30")
    snap = _cons([
        ("1", "A", "RB", "AAA", 1.0, 1.0, "a", d), ("1", "A", "RB", "AAA", 1.0, 1.0, "a", d),       # exact dup
        ("2", "Felton", "RB", "BBB", 113.2, 1.0, "felton", d), ("2", "Felton", "RB", "BBB", 163.6, 1.0, "felton", d),
        ("3", "C", "WR", "CCC", 5.0, 1.0, "c", d),
    ])
    v = sw.validate_table(snap, key=["fp_id"], evaluated=["ecr"], eligibility=["pos", "team", "mergename"])
    assert v.exact_duplicates == 1
    assert v.invalid["conflicting_duplicates"] == {("2",)}
    assert sorted(v.valid["fp_id"]) == ["1", "3"]
    assert v.n_keys == 3 and abs(v.excluded_fraction() - 1 / 3) < 1e-12


def test_threshold_exactly_one_percent_passes_just_above_fails():
    d = pd.Timestamp("2024-09-20")
    rows = [(str(i), f"p{i}", "WR", "AAA", float(i), 1.0, f"p{i}", d) for i in range(100)]
    rows[0] = ("0", "p0", "WR", "AAA", float("nan"), 1.0, "p0", d)                      # 1 of 100 invalid
    v = sw.validate_table(_cons(rows), ["fp_id"], ["ecr"], ["pos", "team", "mergename"])
    assert v.excluded_fraction() == 0.01 and not v.fails()
    rows[1] = ("1", "p1", "WR", "AAA", float("inf"), 1.0, "p1", d)
    v2 = sw.validate_table(_cons(rows), ["fp_id"], ["ecr"], ["pos", "team", "mergename"])
    assert v2.fails()


def test_key_failing_several_rules_counted_once():
    d = pd.Timestamp("2024-09-20")
    snap = _cons([("1", "A", "RB", "AAA", np.nan, 1.0, "a", d), ("1", "A", "RB", "AAA", 2.0, 1.0, "a", d),
                  ("2", "B", "RB", "AAA", 3.0, 1.0, "b", d)])
    v = sw.validate_table(snap, ["fp_id"], ["ecr"], ["pos", "team", "mergename"])
    assert v.invalid_keys() == {("1",)} and abs(v.excluded_fraction() - 0.5) < 1e-12


def test_projection_quantile_order():
    df = pd.DataFrame({"player_id": ["a", "b"], "team": ["AAA", "AAA"], "position": ["WR", "WR"],
                       "p10": [1.0, 5.0], "p50": [2.0, 4.0], "p90": [3.0, 6.0]})
    v = sw.validate_projections(df)
    assert v.invalid["quantile_order"] == {("b",)}


def _actual_rows(team="AAA", pid="x"):
    row = {"player_id": pid, "position": "WR", "team": team, "season": 2024, "week": 2}
    row.update({s: 1.0 for s in PREDICTED_STATS})
    return row


def test_actuals_schedule_join_and_mask_keeps_index():
    sched = pd.DataFrame([(2024, 2, "2024-09-12", "AAA", "BBB")],
                         columns=["season", "week", "gameday", "home_team", "away_team"])
    rows = pd.DataFrame([_actual_rows("AAA", "x"), _actual_rows("ZZZ", "y")], index=[10, 11])
    v = sw.validate_actuals(rows, sched, 2024, 2)
    assert v.invalid["schedule_join"] == {(2024, 2, "y")}
    assert list(v.valid.index) == [10]


def test_match_consensus_flags_identity_collision():
    d = pd.Timestamp("2024-09-20")
    snap = _cons([("10", "Same Guy", "RB", "AAA", 5.0, 1.0, "same guy", d),
                  ("11", "Same Guy", "RB", "AAA", 5.0, 1.0, "same guy", d)])          # two keys, tied ECR, one player
    cw = pd.DataFrame({"gsis_id": ["00-1", "00-1"], "fantasypros_id": ["10", "11"],
                       "merge_name": ["same guy", "same guy"], "position": ["RB", "RB"]})
    m = sw.match_consensus(snap, cw)
    assert m.matched is None and m.reason == "identity_collision" and m.stats["gsis_collisions"] == 1


def test_match_consensus_ok():
    d = pd.Timestamp("2024-09-20")
    snap = _cons([("10", "A", "RB", "AAA", 1.0, 1.0, "a", d), ("11", "B", "RB", "AAA", 2.0, 1.0, "b", d)])
    cw = pd.DataFrame({"gsis_id": ["00-1", "00-2"], "fantasypros_id": ["10", "11"],
                       "merge_name": ["a", "b"], "position": ["RB", "RB"]})
    m = sw.match_consensus(snap, cw)
    assert m.reason is None and sorted(m.matched["player_id"]) == ["00-1", "00-2"]
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_validation.py -q`
Expected: FAIL with `AttributeError: module 'ffmodel.eval.sameweek' has no attribute 'validate_table'`.

- [ ] **Step 3: Implement (append to `sameweek.py`)**

```python
# --- §3.7 validation -------------------------------------------------------------------------------------------
import numpy as np  # noqa: E402  (keep imports grouped at top of file when editing: move this line up)

from ffmodel.data.rankings import attach_gsis  # noqa: E402
from ffmodel.scoring import PREDICTED_STATS  # noqa: E402

VALIDATION_LIMIT = 0.01


@dataclass
class TableValidation:
    valid: pd.DataFrame
    invalid: dict = field(default_factory=dict)
    n_keys: int = 0
    exact_duplicates: int = 0

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
        return {"n_keys": self.n_keys, "exact_duplicates": self.exact_duplicates,
                "invalid_by_reason": {r: len(k) for r, k in sorted(self.invalid.items())},
                "excluded_fraction": round(self.excluded_fraction(), 6)}


def _keys(df: pd.DataFrame, key: list[str]) -> pd.Series:
    return pd.Series(list(zip(*[df[k] for k in key])), index=df.index)


def _nonfinite(df: pd.DataFrame, cols: list[str]) -> pd.Series:
    vals = df[cols].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
    return pd.Series(~np.isfinite(vals).all(axis=1), index=df.index)


def validate_table(df: pd.DataFrame, key: list[str], evaluated: list[str], eligibility: list[str],
                   extra_invalid: dict | None = None) -> TableValidation:
    if len(df) == 0:
        return TableValidation(valid=df.copy(), invalid={}, n_keys=0, exact_duplicates=0)
    keys = _keys(df, key)
    n_keys = int(keys.nunique())
    sig = key + evaluated + eligibility
    collapsed = df[~df.duplicated(subset=sig, keep="first")]
    exact_dups = int(len(df) - len(collapsed))
    ckeys = keys.loc[collapsed.index]
    invalid: dict[str, set] = {}
    counts = ckeys.value_counts()
    conflict = set(counts[counts > 1].index)
    if conflict:
        invalid["conflicting_duplicates"] = conflict
    bad = _nonfinite(collapsed, evaluated)
    if bad.any():
        invalid["nonfinite"] = set(ckeys[bad])
    for reason, mask in (extra_invalid or {}).items():
        m = mask.reindex(collapsed.index, fill_value=False).astype(bool)
        if m.any():
            invalid.setdefault(reason, set()).update(set(ckeys[m]))
    bad_keys = set().union(*invalid.values()) if invalid else set()
    valid = collapsed[~ckeys.isin(bad_keys)]
    return TableValidation(valid=valid, invalid=invalid, n_keys=n_keys, exact_duplicates=exact_dups)


def validate_actuals(rows: pd.DataFrame, schedules: pd.DataFrame, season: int, week: int) -> TableValidation:
    games = team_game_dates(schedules, season, week)
    bad_join = rows["team"].map(lambda t: len(games.get(t, [])) != 1)
    return validate_table(rows, ["season", "week", "player_id"], list(PREDICTED_STATS), ["team", "position"],
                          extra_invalid={"schedule_join": bad_join})


def validate_projections(df: pd.DataFrame) -> TableValidation:
    q = df[["p10", "p50", "p90"]].apply(pd.to_numeric, errors="coerce")
    disordered = ~((q["p10"] <= q["p50"]) & (q["p50"] <= q["p90"]))
    finite = np.isfinite(q.to_numpy(dtype=float)).all(axis=1)
    return validate_table(df, ["player_id"], ["p10", "p50", "p90"], ["team", "position"],
                          extra_invalid={"quantile_order": disordered & pd.Series(finite, index=df.index)})


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
```

Move the three appended `import` lines to the top-of-file import block, so the module has a single import section.
Then remove the `# noqa` comments.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_validation.py tests/test_sameweek_gate.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/sameweek.py tests/test_sameweek_validation.py
git commit -m "feat(sameweek): per-table validation with group invalidation, 1% threshold, masking, collision skip (spec §3.7)"
```

---

### Task 3: sameweek — same-week selection, population, per-week cells, staleness audit

**Files:**
- Modify: `src/ffmodel/eval/sameweek.py` (append)
- Test: `tests/test_sameweek_selection.py`

**Interfaces:**
- Consumes: Tasks 1–2; `ffmodel.eval.weekly_rankings.score_week`, `weekly_snapshot`; `ffmodel.site.draft.REPLACEMENT_RANK`.
- Produces:
  - `overlapping(dates, week) -> bool`
  - `sameweek_window(dates, week) -> tuple[pd.Timestamp, pd.Timestamp]`, the half-open `[L, U)`
  - `select_sameweek_scrape(rankings, schedules, season, week, dates) -> dict`
    - keys: `scrape_date` (Timestamp | None), `candidates` (list of dicts with `date`, `state`, `has_later_game`),
      `gate` (GateResult | None)
  - `build_cells(pool, season, week, gate_state) -> tuple[list[dict], int]`
    - `pool` columns: `player_id, position, our_pts, ecr, actual`
    - returns the finite cells and the count of dropped degenerate cells
  - `sameweek_week(played, schedules, rankings, crosswalk, season, week, dates) -> dict`
    - `played` columns: `player_id, position, team, our_pts, actual`, where only validated rows are passed in
    - keys: `status` (`"scored"` | `"skipped"`), `reason`, `selection`, `cells`, `degenerate`, `validation`,
      `match`, `retention`
  - `staleness_audit_week(rankings, schedules, season, week, dates) -> dict`
    - keys: `week`, `kickoff`, `scrape_date` | None, `state` | None, `discriminating` (bool)

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_sameweek_selection.py
"""Spec §5.2 same-week selection (metadata only), population filter, cells, and the old-protocol regression record."""
import numpy as np
import pandas as pd

from ffmodel.eval import sameweek as sw
from ffmodel.eval.weekly_rankings import weekly_snapshot

POS = sw.POSITIONS


def _sched():
    # 2024. wk1 Thu 09-05 .. Mon 09-09; wk2 Thu 09-12 .. Sun 09-15 (EEE/FFF bye); wk3 Sat 09-21 .. Sun 09-22 (CCC/DDD bye)
    rows = [(2024, 1, "2024-09-05", "AAA", "BBB"), (2024, 1, "2024-09-08", "CCC", "DDD"), (2024, 1, "2024-09-09", "EEE", "FFF"),
            (2024, 2, "2024-09-12", "AAA", "BBB"), (2024, 2, "2024-09-15", "CCC", "DDD"),
            (2024, 3, "2024-09-21", "AAA", "BBB"), (2024, 3, "2024-09-22", "EEE", "FFF")]
    return pd.DataFrame(rows, columns=["season", "week", "gameday", "home_team", "away_team"])


def _rank_rows(date, teams, n_per_team=3):
    rows = []
    for pos in POS:
        for t in teams:
            for i in range(n_per_team):
                pid = f"{t}{pos}{i}"
                rows.append({"fp_id": pid, "player": pid, "pos": pos, "team": t, "ecr": float(i + 1), "sd": 1.0,
                             "mergename": pid.lower(), "scrape_date": pd.Timestamp(date)})
    return rows


def _rankings():
    wk1_list = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]
    wk2_list = ["AAA", "BBB", "CCC", "DDD"]                 # EEE/FFF on bye in week 2
    wk3_list = ["AAA", "BBB", "EEE", "FFF"]                 # CCC/DDD on bye in week 3
    rows = (_rank_rows("2024-09-06", wk1_list) + _rank_rows("2024-09-13", wk2_list)
            + _rank_rows("2024-09-20", wk3_list))
    return pd.DataFrame(rows)


def _crosswalk(rankings):
    first = rankings.drop_duplicates("fp_id")
    return pd.DataFrame({"gsis_id": "g-" + first["fp_id"], "fantasypros_id": first["fp_id"],
                         "merge_name": first["fp_id"].str.lower(), "position": first["pos"]})


def test_window_and_overlap():
    d = sw.week_dates(_sched(), 2024)
    assert sw.sameweek_window(d, 1) == (pd.Timestamp("2024-08-29"), pd.Timestamp("2024-09-09"))
    assert sw.sameweek_window(d, 2) == (pd.Timestamp("2024-09-10"), pd.Timestamp("2024-09-15"))
    assert sw.sameweek_window(d, 3) == (pd.Timestamp("2024-09-16"), pd.Timestamp("2024-09-22"))  # Sat-first week admits Fri
    assert not sw.overlapping(d, 2)
    late = dict(d)
    late[1] = (d[1][0], pd.Timestamp("2024-09-12"))
    assert sw.overlapping(late, 2)


def test_selection_is_latest_noncontradicted_and_old_protocol_is_stale():
    s, r = _sched(), _rankings()
    d = sw.week_dates(s, 2024)
    sel = sw.select_sameweek_scrape(r, s, 2024, 3, d)
    assert sel["scrape_date"] == pd.Timestamp("2024-09-20") and sel["gate"].state == "bye_consistent"
    # the old protocol picks the previous week's list and the gate calls it contradicted
    old = weekly_snapshot(r, pd.Timestamp(d[3][0]))
    assert old["scrape_date"].iloc[0] == pd.Timestamp("2024-09-20")  # Fri before Sat-first wk3 is still inside 7d
    old2 = weekly_snapshot(r, pd.Timestamp(d[2][0]))
    assert old2["scrape_date"].iloc[0] == pd.Timestamp("2024-09-06")
    assert sw.gate(old2, s, 2024, 2).state == "contradicted"
    audit = sw.staleness_audit_week(r, s, 2024, 2, d)
    assert audit["state"] == "contradicted" and audit["discriminating"] is False  # week-1 byes empty -> not discriminating


def test_contradicted_latest_is_passed_over_by_metadata():
    s, r = _sched(), _rankings()
    d = sw.week_dates(s, 2024)
    stale_late = pd.DataFrame(_rank_rows("2024-09-14", ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]))  # lists wk2 byes
    sel = sw.select_sameweek_scrape(pd.concat([r, stale_late], ignore_index=True), s, 2024, 2, d)
    states = {c["date"]: c["state"] for c in sel["candidates"]}
    assert states[pd.Timestamp("2024-09-14")] == "contradicted"
    assert sel["scrape_date"] == pd.Timestamp("2024-09-13")


def test_population_filter_and_no_fallback():
    s, r = _sched(), _rankings()
    d = sw.week_dates(s, 2024)
    cw = _crosswalk(r)
    rng = np.random.default_rng(0)
    played = []
    for t in ["AAA", "BBB", "CCC", "DDD"]:
        for pos in POS:
            for i in range(3):
                played.append({"player_id": f"g-{t}{pos}{i}", "position": pos, "team": t,
                               "our_pts": float(rng.normal()), "actual": float(rng.normal())})
    played = pd.DataFrame(played)
    res = sw.sameweek_week(played, s, r, cw, 2024, 2, d)
    # scrape 09-13 (Fri): AAA/BBB played Thu 09-12 -> excluded; CCC/DDD Sun 09-15 kept
    assert res["status"] == "scored" and res["retention"]["excluded_early_game"] == 24
    assert res["retention"]["pool"] == 24
    # only Thursday players have stat lines -> empty pool -> skipped, no fallback to an earlier scrape
    thu_only = played[played["team"].isin(["AAA", "BBB"])]
    res2 = sw.sameweek_week(thu_only, s, r, cw, 2024, 2, d)
    assert res2["status"] == "skipped" and res2["reason"] == "no_scorable_cell"
    assert res2["selection"]["scrape_date"] == "2024-09-13"


def test_build_cells_flags_and_degenerate():
    pool = pd.DataFrame({"player_id": [f"p{i}" for i in range(6)], "position": ["TE"] * 6,
                         "our_pts": [1, 2, 3, 4, 5, 6], "ecr": [1, 2, 3, 4, 5, 6], "actual": [6, 5, 4, 3, 2, 1]})
    cells, degenerate = sw.build_cells(pool, 2024, 2, "bye_consistent")
    assert len(cells) == 1 and cells[0]["n_le_slots"] is True and cells[0]["gate_state"] == "bye_consistent"
    flat = pool.assign(actual=1.0)
    cells2, degenerate2 = sw.build_cells(flat, 2024, 2, "unverified")
    assert cells2 == [] and degenerate2 == 1
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_selection.py -q`
Expected: FAIL with `AttributeError: ... 'sameweek_window'`.

- [ ] **Step 3: Implement (append; move the new imports into the top import block)**

```python
import warnings

from scipy.stats import ConstantInputWarning

from ffmodel.eval.weekly_rankings import score_week, weekly_snapshot
from ffmodel.site.draft import REPLACEMENT_RANK

ONE_DAY = pd.Timedelta(days=1)


def overlapping(dates: dict, week: int) -> bool:
    return week > 1 and (week - 1) in dates and dates[week - 1][1] >= dates[week][0]


def sameweek_window(dates: dict, week: int) -> tuple[pd.Timestamp, pd.Timestamp]:
    K, Z = dates[week]
    L = dates[week - 1][1] + ONE_DAY if (week - 1) in dates else K - pd.Timedelta(days=7)
    return L, Z


def select_sameweek_scrape(rankings: pd.DataFrame, schedules: pd.DataFrame, season: int, week: int,
                           dates: dict) -> dict:
    """Latest scrape in [L_N, Z_N) that the gate does not contradict and that precedes a week-N game.
    Metadata only: actual appearances are never consulted, and there is no fallback after selection."""
    L, U = sameweek_window(dates, week)
    day = rankings["scrape_date"].dt.normalize()
    in_window = rankings[(day >= L) & (day < U)]
    game_days = sorted({d for ds in team_game_dates(schedules, season, week).values() for d in ds})
    candidates, chosen = [], None
    for date in sorted(in_window["scrape_date"].dt.normalize().unique()):
        date = pd.Timestamp(date)
        g = gate(in_window[in_window["scrape_date"].dt.normalize() == date], schedules, season, week)
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
        r = dict(r, gate_state=gate_state, n_le_slots=bool(r["n"] <= REPLACEMENT_RANK[r["position"]]))
        cells.append(r)
    return cells, degenerate


def _skip(reason: str, **extra) -> dict:
    return {"status": "skipped", "reason": reason, "cells": [], "degenerate": 0, **extra}


def sameweek_week(played: pd.DataFrame, schedules: pd.DataFrame, rankings: pd.DataFrame,
                  crosswalk: pd.DataFrame, season: int, week: int, dates: dict) -> dict:
    if overlapping(dates, week):
        return _skip("overlapping_weeks")
    sel = select_sameweek_scrape(rankings, schedules, season, week, dates)
    selection = {"scrape_date": str(sel["scrape_date"].date()) if sel["scrape_date"] is not None else None,
                 "state": sel["gate"].state if sel["gate"] else None,
                 "pages": sel["gate"].pages if sel["gate"] else None,
                 "candidates": [{"date": str(c["date"].date()), "state": c["state"],
                                 "has_later_game": c["has_later_game"]} for c in sel["candidates"]]}
    if sel["scrape_date"] is None:
        return _skip("no_candidate_scrape", selection=selection)
    date = sel["scrape_date"]
    snap = rankings[(rankings["scrape_date"].dt.normalize() == date) & rankings["pos"].isin(POSITIONS)]
    v = validate_table(snap, ["fp_id"], ["ecr"], ["pos", "team", "mergename"])
    if v.fails():
        return _skip("validation_failed", selection=selection, validation=v.report())
    m = match_consensus(v.valid, crosswalk)
    if m.reason:
        return _skip(m.reason, selection=selection, validation=v.report(), match=m.stats)
    games = team_game_dates(schedules, season, week)
    gday = played["team"].map(lambda t: games[t][0] if len(games.get(t, [])) == 1 else pd.NaT)
    eligible = played[gday > date]
    con = m.matched[["player_id", "ecr"]].drop_duplicates(subset="player_id", keep="first")
    pool = eligible.merge(con, on="player_id", how="inner")
    cells, degenerate = build_cells(pool, season, week, sel["gate"].state)
    retention = {"played": int(len(played)), "excluded_early_game": int(len(played) - len(eligible)),
                 "pool": int(len(pool)), "match_rate": m.stats.get("match_rate"),
                 "pool_by_position": pool["position"].value_counts().sort_index().astype(int).to_dict()}
    if not cells:
        return _skip("no_scorable_cell", selection=selection, validation=v.report(), match=m.stats,
                     retention=retention, degenerate=degenerate)
    return {"status": "scored", "reason": None, "selection": selection, "cells": cells, "degenerate": degenerate,
            "validation": v.report(), "match": m.stats, "retention": retention}


def staleness_audit_week(rankings: pd.DataFrame, schedules: pd.DataFrame, season: int, week: int,
                         dates: dict) -> dict:
    K = dates[week][0]
    snap = weekly_snapshot(rankings, pd.Timestamp(K))
    A = bye_teams(schedules, season, week)
    B = bye_teams(schedules, season, week - 1) if week > 1 else set()
    out = {"week": int(week), "kickoff": str(K.date()), "scrape_date": None, "state": None,
           "discriminating": bool(A and B and A != B)}
    if snap is not None:
        out["scrape_date"] = str(snap["scrape_date"].iloc[0].date())
        out["state"] = gate(snap, schedules, season, week).state
    return out
```

Also add `import numpy as np` to the top block if Task 2 has not already done so.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_selection.py tests/test_sameweek_validation.py tests/test_sameweek_gate.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/sameweek.py tests/test_sameweek_selection.py
git commit -m "feat(sameweek): metadata-only same-week scrape selection, date-filtered population, cells, staleness audit (spec §5.2)"
```

---

### Task 4: sameweek — statistics, sufficiency, directional check, Rules 1 and 2

**Files:**
- Modify: `src/ffmodel/eval/sameweek.py` (append)
- Test: `tests/test_sameweek_rules.py`

**Interfaces:**
- Consumes: `paired_bootstrap` from `ffmodel.eval.mean_head_gate`.
- Produces:
  - `BOOT_SEED = 20260728`, `N_BOOT = 10000`
  - `delta_stats(cells: pd.DataFrame) -> dict`
    - keys: `D`, `ci_week` (`[lo, hi]`), `D_season` (`{season: float}`), `loso` (`{season: float}`), `n_cells`,
      `n_clusters`
  - `sensitivity_stats(cells: pd.DataFrame) -> dict`
    - computed on the `gate_state == "bye_consistent"` subset
    - keys: `D` | None, `n_cells`, `seasons`
  - `directional_check(stats, sens, sign: int) -> tuple[bool, list[str]]`
  - `sufficient(cells, target_weeks: dict[int, list[int]], position: str | None = None) -> bool`
  - `rule_1(cells, target_weeks) -> dict`, with keys `value` and `reasons`
  - `rule_2(disc_cells, disc_weeks, rep_cells, rep_weeks) -> dict`, with keys `value` and `reasons_by_sample`

`cells` frames have the columns `season, week, position, sp_ours, sp_con, gate_state` (and others).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_sameweek_rules.py
"""Spec §6 directional checks and decision rules. Pure arithmetic on synthetic cells."""
import pandas as pd

from ffmodel.eval import sameweek as sw


def _cells(season_deltas, weeks=17, positions=("QB", "RB", "WR", "TE"), state="bye_consistent"):
    rows = []
    for season, d in season_deltas.items():
        for w in range(1, weeks + 1):
            for p in positions:
                dd = d(w, p) if callable(d) else d
                rows.append({"season": season, "week": w, "position": p, "sp_ours": 0.5 + dd, "sp_con": 0.5,
                             "gate_state": state})
    return pd.DataFrame(rows)


def _weeks(seasons, n=17):
    return {s: list(range(1, n + 1)) for s in seasons}


def test_ahead_and_behind_are_symmetric():
    up = _cells({2023: lambda w, p: 0.02 + 0.04 * (w % 2), 2024: 0.03, 2025: 0.05})
    assert sw.rule_1(up, _weeks([2023, 2024, 2025]))["value"] == "ahead"
    down = up.assign(sp_ours=1.0 - up["sp_ours"])
    assert sw.rule_1(down, _weeks([2023, 2024, 2025]))["value"] == "behind"


def test_interval_including_zero_is_not_a_tie():
    noisy = _cells({2023: lambda w, p: 0.08 if w % 2 else -0.12, 2024: lambda w, p: 0.05 if w % 2 else -0.09,
                    2025: lambda w, p: 0.04 if w % 2 else -0.10})
    r = sw.rule_1(noisy, _weeks([2023, 2024, 2025]))
    assert r["value"] == "not_established" and "interval_includes_zero" in r["reasons"]


def test_dominant_season_blocked_by_leave_one_season_out():
    c = _cells({2023: 0.120, 2024: -0.010, 2025: 0.001})
    ok, codes = sw.directional_check(sw.delta_stats(c), sw.sensitivity_stats(c), +1)
    assert not ok and "leave_one_season_out_reversal" in codes


def test_season_inconsistent_and_sensitivity_codes():
    c = _cells({2023: 0.2, 2024: -0.01, 2025: -0.01})
    ok, codes = sw.directional_check(sw.delta_stats(c), sw.sensitivity_stats(c), +1)
    assert "season_inconsistent" in codes
    absent = _cells({2023: 0.03, 2024: 0.04, 2025: 0.05}, state="unverified")
    ok2, codes2 = sw.directional_check(sw.delta_stats(absent), sw.sensitivity_stats(absent), +1)
    assert not ok2 and codes2 == ["sensitivity_absent"]


def test_touching_zero_and_opposite_side_codes():
    ok, codes = sw.directional_check({"ci_week": [0.0, 0.1], "D_season": {1: 1, 2: 1, 3: 1},
                                      "loso": {1: 1, 2: 1, 3: 1}, "D": 0.05}, {"D": 0.05, "n_cells": 3}, +1)
    assert codes == ["interval_includes_zero"]
    ok, codes = sw.directional_check({"ci_week": [-0.2, -0.1], "D_season": {1: -1, 2: -1, 3: -1},
                                      "loso": {1: -1, 2: -1, 3: -1}, "D": -0.15}, {"D": -0.1, "n_cells": 3}, +1)
    assert "interval_opposite_side" in codes


def test_full_precision_boundary():
    ok, codes = sw.directional_check({"ci_week": [0.00003, 0.1], "D_season": {1: 1, 2: 1, 3: 1},
                                      "loso": {1: 1, 2: 1, 3: 1}, "D": 0.05}, {"D": 0.05, "n_cells": 3}, +1)
    assert ok and codes == []


def test_zero_estimate_and_loso_zero():
    flat = _cells({2023: 0.0, 2024: 0.0, 2025: 0.0})
    r = sw.rule_1(flat, _weeks([2023, 2024, 2025]))
    assert r["value"] == "not_established" and "zero_estimate" in r["reasons"]


def test_sufficiency_per_season_and_rb():
    c = _cells({2023: 0.03, 2024: 0.04, 2025: 0.05}, weeks=8, positions=("QB", "WR", "TE"))
    assert sw.sufficient(c, _weeks([2023, 2024, 2025], 16))            # 8/16 weeks with a cell
    assert not sw.sufficient(c, _weeks([2023, 2024, 2025], 16), "RB")   # no RB cells
    assert sw.rule_1(c, _weeks([2023, 2024, 2025], 18))["value"] == "insufficient"


def test_rule_2_needs_both_samples():
    good = _cells({2023: 0.03, 2024: 0.04, 2025: 0.05})
    rep_good = _cells({2020: 0.03, 2021: 0.04, 2022: 0.05})
    rep_bad = _cells({2020: 0.03, 2021: -0.04, 2022: -0.05})
    assert sw.rule_2(good, _weeks([2023, 2024, 2025]), rep_good, _weeks([2020, 2021, 2022]))["value"] == "established"
    r = sw.rule_2(good, _weeks([2023, 2024, 2025]), rep_bad, _weeks([2020, 2021, 2022]))
    assert r["value"] == "not_established" and r["reasons_by_sample"]["replication"]
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_rules.py -q`
Expected: FAIL with `AttributeError: ... 'rule_1'`.

- [ ] **Step 3: Implement (append; move the import to the top)**

```python
from ffmodel.eval.mean_head_gate import paired_bootstrap

BOOT_SEED = 20260728
N_BOOT = 10000


def _deltas(cells: pd.DataFrame) -> pd.Series:
    return (cells["sp_ours"] - cells["sp_con"]).astype(float)


def delta_stats(cells: pd.DataFrame) -> dict:
    d = _deltas(cells)
    clusters = (cells["season"].astype(int) * 100 + cells["week"].astype(int)).to_numpy()
    boot = paired_bootstrap(d.to_numpy(), clusters, n_boot=N_BOOT, seed=BOOT_SEED)
    by_season = d.groupby(cells["season"]).mean()
    loso = {int(s): float(d[cells["season"] != s].mean()) for s in by_season.index} if len(by_season) > 1 else {}
    return {"D": float(d.mean()), "ci_week": [float(boot["ci95"][0]), float(boot["ci95"][1])],
            "D_season": {int(s): float(v) for s, v in by_season.items()}, "loso": loso,
            "n_cells": int(len(d)), "n_clusters": int(boot["n_clusters"])}


def sensitivity_stats(cells: pd.DataFrame) -> dict:
    sub = cells[cells["gate_state"] == "bye_consistent"]
    if sub.empty:
        return {"D": None, "n_cells": 0, "seasons": []}
    return {"D": float(_deltas(sub).mean()), "n_cells": int(len(sub)),
            "seasons": sorted(int(s) for s in sub["season"].unique())}


def directional_check(stats: dict, sens: dict, sign: int) -> tuple[bool, list[str]]:
    codes: list[str] = []
    lo, hi = stats["ci_week"]
    if not ((lo > 0) if sign > 0 else (hi < 0)):
        codes.append("interval_includes_zero" if lo <= 0 <= hi else "interval_opposite_side")
    if sum(1 for v in stats["D_season"].values() if v * sign > 0) < 2:
        codes.append("season_inconsistent")
    loso = list(stats["loso"].values())
    if any(v == 0 for v in loso):
        codes.append("leave_one_season_out_zero")
    if any(v * sign < 0 for v in loso):
        codes.append("leave_one_season_out_reversal")
    if not sens or not sens.get("n_cells"):
        codes.append("sensitivity_absent")
    elif sens["D"] == 0:
        codes.append("sensitivity_zero")
    elif sens["D"] * sign < 0:
        codes.append("sensitivity_disagrees")
    return (not codes), codes


def sufficient(cells: pd.DataFrame, target_weeks: dict, position: str | None = None) -> bool:
    sub = cells if position is None else cells[cells["position"] == position]
    for season, weeks in target_weeks.items():
        have = set(sub.loc[sub["season"] == season, "week"].astype(int))
        if len(have & set(weeks)) * 2 < len(weeks):
            return False
    return True


def rule_1(cells: pd.DataFrame, target_weeks: dict) -> dict:
    if cells.empty or not sufficient(cells, target_weeks):
        return {"value": "insufficient", "reasons": []}
    stats, sens = delta_stats(cells), sensitivity_stats(cells)
    ok_down, codes_down = directional_check(stats, sens, -1)
    if ok_down:
        return {"value": "behind", "reasons": [], "stats": stats, "sensitivity": sens}
    ok_up, codes_up = directional_check(stats, sens, +1)
    if ok_up:
        return {"value": "ahead", "reasons": [], "stats": stats, "sensitivity": sens}
    if stats["D"] == 0:
        reasons = ["zero_estimate"] + sorted(set(codes_up) | set(codes_down))
    else:
        reasons = codes_up if stats["D"] > 0 else codes_down
    return {"value": "not_established", "reasons": reasons, "stats": stats, "sensitivity": sens}


def rule_2(disc_cells: pd.DataFrame, disc_weeks: dict, rep_cells: pd.DataFrame, rep_weeks: dict) -> dict:
    out = {"reasons_by_sample": {}}
    samples = {"discovery": (disc_cells, disc_weeks), "replication": (rep_cells, rep_weeks)}
    for name, (cells, weeks) in samples.items():
        if cells.empty or not sufficient(cells, weeks, "RB"):
            return {"value": "insufficient", "reasons_by_sample": {name: ["insufficient"]}}
    passed = True
    for name, (cells, _) in samples.items():
        rb = cells[cells["position"] == "RB"]
        ok, codes = directional_check(delta_stats(rb), sensitivity_stats(rb), +1)
        out["reasons_by_sample"][name] = codes
        passed = passed and ok
    out["value"] = "established" if passed else "not_established"
    return out
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_rules.py -q`
Expected: all pass. If `test_interval_including_zero_is_not_a_tie` yields an interval excluding zero, widen the
fixture's alternation, never the rule. The test asserts the rule's behaviour on an interval that contains zero.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/sameweek.py tests/test_sameweek_rules.py
git commit -m "feat(sameweek): week-clustered stats, leave-one-season-out, sensitivity, directional check, Rules 1-2 (spec §6)"
```

---

### Task 5: live_accuracy — push ledger, git adapter, publication and archive evidence

**Files:**
- Create: `src/ffmodel/eval/live_accuracy.py`
- Test: `tests/test_live_accuracy_evidence.py`

**Interfaces:**
- Produces:
  - Constants: `BOT = "weekly-update-bot"`, `WEEKLY_FILES = ("site/data/weekly.json", "site/data/neutral/weekly.json")`,
    `ARCHIVE_DIR = "data_snapshots/weekly_ecr"`
  - `Git` class (real subprocess implementation). Methods:
    - `exists(sha) -> bool`
    - `ident(sha) -> tuple[str, str]` (author name, committer name)
    - `changed(sha) -> set[str]`
    - `show(sha, path) -> bytes | None`
    - `is_ancestor(a, b) -> bool`
    - `rev_parse(ref) -> str`
    - `first_adding_commit(main_sha, path) -> str | None`
    - `ls_dir(sha, dirpath) -> list[str]`
    - `weekly_commits(main_sha) -> list[str]`
  - Ledger functions:
    - `load_ledger(path) -> dict`, with keys `events` and `coverage`
    - `normalize_event(raw) -> dict`
    - `merge_collection(ledger, raw_events, t_end: str) -> dict`
    - `covered(ledger, t0: str, t1: str) -> bool`
    - `save_ledger(ledger, path)`
  - `read_payloads(git, sha) -> tuple[dict | None, dict | None]` (legacy, neutral)
  - `is_candidate(git, sha, season, week) -> bool`
  - `select_publication(ledger, git, season, week, cutoff: pd.Timestamp, main_sha) -> dict`
    - keys: `status` (`"selected"` | `"publication_evidence_unavailable"` | `"weeks_unpublished"`), `commit`,
      `event_id`, `available_by`, `detail`
  - `select_archive(ledger, git, season, week, cutoff, main_sha) -> dict`
    - keys: `status` (`"selected"` | `"no_archive"` | `"archive_hash_mismatch"`), `path`, `commit`,
      `available_by`, `tie_break`, `alternatives` (list), `content` (dict | None)

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_live_accuracy_evidence.py
"""Spec §4.1/§4.3 publication and archive evidence against a synthetic git history and push ledger."""
import hashlib
import json

import pandas as pd

from ffmodel.eval import live_accuracy as la


class FakeGit:
    """commits: sha -> {parent, author, committer, files: {path: bytes}, changed: set}"""

    def __init__(self, commits, order):
        self.c, self.order = commits, order          # order: oldest -> newest along main

    def exists(self, sha): return sha in self.c
    def ident(self, sha): return self.c[sha]["author"], self.c[sha]["committer"]
    def changed(self, sha): return set(self.c[sha]["changed"])
    def show(self, sha, path): return self.c[sha]["files"].get(path)
    def rev_parse(self, ref): return self.order[-1]

    def is_ancestor(self, a, b):
        return a in self.order and b in self.order and self.order.index(a) <= self.order.index(b)

    def first_adding_commit(self, main_sha, path):
        for sha in self.order:
            if path in self.c[sha]["changed"] and path in self.c[sha]["files"]:
                return sha
        return None

    def ls_dir(self, sha, dirpath):
        return sorted(p.split("/")[-1] for p in self.c[sha]["files"] if p.startswith(dirpath + "/"))

    def weekly_commits(self, main_sha):
        return [s for s in reversed(self.order) if self.c[s]["changed"] & set(la.WEEKLY_FILES)]


def _legacy(week, gen="2026-09-30T21:29:16+00:00"):
    return json.dumps({"season": 2026, "week": week, "generated_at": gen,
                       "players": [{"player_id": "p1", "position": "WR", "team": "AAA",
                                    "points": {"ppr": {"p10": 1.0, "p50": 5.0, "p90": 9.0}}}]}).encode()


def _neutral(week, gen="2026-09-30T21:29:16+00:00"):
    sq = {q: {"receptions": v, "receiving_yards": 10 * v} for q, v in (("p10", 0.5), ("p50", 2.5), ("p90", 4.5))}
    return json.dumps({"season": 2026, "week": week, "generated_at": gen,
                       "players": [{"player_id": "p1", "position": "WR", "team": "AAA", "stat_quantiles": sq}]}).encode()


def _history():
    files_old = {"site/data/weekly.json": _legacy(4)}
    commits = {
        "h0": {"author": "me", "committer": "me", "changed": {"README.md"}, "files": {}},
        "b1": {"author": la.BOT, "committer": la.BOT, "changed": {"site/data/weekly.json"}, "files": files_old},
        "b2": {"author": la.BOT, "committer": la.BOT, "changed": {"site/data/neutral/weekly.json"},
               "files": {"site/data/neutral/weekly.json": _neutral(4)}},
        "m1": {"author": "me", "committer": "me", "changed": {"site/data/weekly.json"}, "files": {"site/data/weekly.json": _legacy(4)}},
    }
    return FakeGit(commits, ["h0", "b1", "b2", "m1"])


def _ev(i, after, ts, kind="push", before="x"):
    return {"id": i, "ref": "refs/heads/main", "timestamp": ts, "before": before, "after": after,
            "activity_type": kind, "actor": {"login": "github-actions[bot]"}}


CUT = pd.Timestamp("2026-10-01T00:00:00Z")


def _ledger(events, cov=("2026-07-01T00:00:00Z", "2026-10-06T00:00:00Z")):
    return la.merge_collection({"events": [], "coverage": []}, events, t_end=cov[1], t_start=cov[0])


def test_selects_latest_covered_push_and_neutral_only_commit_is_candidate():
    g = _history()
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-09-30T21:00:00Z")])
    r = la.select_publication(led, g, 2026, 4, CUT, "m1")
    assert r["status"] == "selected" and r["commit"] == "b2" and r["available_by"] == "2026-09-30T21:00:00Z"


def test_push_after_cutoff_not_selected_and_hand_commit_never_candidate():
    g = _history()
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-10-01T00:00:02Z"),
                   _ev(3, "m1", "2026-09-30T22:00:00Z")])
    r = la.select_publication(led, g, 2026, 4, CUT, "m1")
    assert r["commit"] == "b1"


def test_earliest_event_per_sha_and_id_tiebreak():
    g = _history()
    led = _ledger([_ev(5, "b1", "2026-09-30T12:00:00Z"), _ev(4, "b1", "2026-09-30T11:00:00Z")])
    r = la.select_publication(led, g, 2026, 4, CUT, "m1")
    assert r["event_id"] == 4


def test_gap_and_force_push_make_unavailable():
    g = _history()
    gap = la.merge_collection({"events": [], "coverage": []}, [_ev(1, "b1", "2026-09-30T10:00:00Z")],
                              t_start="2026-07-01T00:00:00Z", t_end="2026-09-30T12:00:00Z")
    assert la.select_publication(gap, g, 2026, 4, CUT, "m1")["status"] == "publication_evidence_unavailable"
    fp = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "zz", "2026-09-30T15:00:00Z", kind="force_push")])
    assert la.select_publication(fp, g, 2026, 4, CUT, "m1")["status"] == "publication_evidence_unavailable"


def test_unfetchable_newer_sha_makes_unavailable_and_no_payload_is_unpublished():
    g = _history()
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "ghost", "2026-09-30T20:00:00Z")])
    assert la.select_publication(led, g, 2026, 4, CUT, "m1")["status"] == "publication_evidence_unavailable"
    assert la.select_publication(_ledger([]), g, 2026, 9, CUT, "m1")["status"] == "weeks_unpublished"


def test_commit_before_push_after_cutoff_selects_older():
    g = _history()
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-10-01T00:00:02Z")])
    assert la.select_publication(led, g, 2026, 4, CUT, "m1")["commit"] == "b1"


def test_merge_collection_dedupes_and_keeps_login_only():
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z")])
    led = la.merge_collection(led, [_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-09-30T11:00:00Z")],
                              t_start="2026-09-01T00:00:00Z", t_end="2026-10-07T00:00:00Z")
    assert [e["id"] for e in led["events"]] == [1, 2] and led["events"][0]["actor"] == "github-actions[bot]"
    assert la.covered(led, "2026-07-02T00:00:00Z", "2026-10-06T23:00:00Z")


def _archive(week, date, players):
    payload = {"season": 2026, "week": week, "snapshot_at": date, "players": players}
    enc = json.dumps(payload, sort_keys=True, indent=2, allow_nan=False)
    name = f"2026-w{week:02d}-{date}-{hashlib.sha256(enc.encode()).hexdigest()[:16]}.json"
    return f"{la.ARCHIVE_DIR}/{name}", enc.encode()


def test_archive_selection_cutoff_tie_and_hash():
    p_early, b_early = _archive(4, "2026-09-30", [{"player_id": "p1", "ecr": 1.0, "position": "WR", "team": "AAA"}])
    p_late, b_late = _archive(4, "2026-09-30", [{"player_id": "p1", "ecr": 2.0, "position": "WR", "team": "AAA"}])
    p_after, b_after = _archive(4, "2026-09-29", [{"player_id": "p1", "ecr": 3.0, "position": "WR", "team": "AAA"}])
    commits = {
        "a1": {"author": la.BOT, "committer": la.BOT, "changed": {p_early}, "files": {p_early: b_early}},
        "a2": {"author": la.BOT, "committer": la.BOT, "changed": {p_late}, "files": {p_early: b_early, p_late: b_late}},
        "a3": {"author": la.BOT, "committer": la.BOT, "changed": {p_after},
               "files": {p_early: b_early, p_late: b_late, p_after: b_after}},
    }
    g = FakeGit(commits, ["a1", "a2", "a3"])
    led = _ledger([_ev(1, "a1", "2026-09-30T11:00:00Z"), _ev(2, "a2", "2026-09-30T21:00:00Z"),
                   _ev(3, "a3", "2026-10-01T03:58:50Z")])
    r = la.select_archive(led, g, 2026, 4, CUT, "a3")
    assert r["status"] == "selected" and r["path"] == p_late and len(r["alternatives"]) == 1
    # week whose only archive was pushed after the cutoff -> no_archive
    only_late = _ledger([_ev(3, "a3", "2026-10-01T03:58:50Z")])
    g2 = FakeGit({"a3": commits["a3"]}, ["a3"])
    assert la.select_archive(only_late, g2, 2026, 4, CUT, "a3")["status"] == "no_archive"
    # tampered blob -> hash mismatch
    commits["a2"]["files"][p_late] = b_late + b" "
    assert la.select_archive(led, g, 2026, 4, CUT, "a3")["status"] == "archive_hash_mismatch"
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_live_accuracy_evidence.py -q`
Expected: FAIL with `ModuleNotFoundError ... live_accuracy`.

- [ ] **Step 3: Implement**

```python
# src/ffmodel/eval/live_accuracy.py
"""Live weekly accuracy scorecard (spec docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md §4).

Scores the projections the bot pipeline published before each week's cutoff, proven by GitHub push records
kept in a committed, append-only ledger. Git and the GitHub API are injected so tests run offline.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pandas as pd

BOT = "weekly-update-bot"
WEEKLY_FILES = ("site/data/weekly.json", "site/data/neutral/weekly.json")
ARCHIVE_DIR = "data_snapshots/weekly_ecr"
MAIN_REF = "refs/heads/main"


class Git:
    def __init__(self, cwd: Path | str = "."):
        self.cwd = str(cwd)

    def _run(self, *args, check=True) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=self.cwd, capture_output=True, check=check)

    def exists(self, sha: str) -> bool:
        return self._run("cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode == 0

    def ident(self, sha: str) -> tuple[str, str]:
        out = self._run("log", "-1", "--format=%an%x00%cn", sha).stdout.decode().strip()
        a, c = out.split("\x00")
        return a, c

    def changed(self, sha: str) -> set[str]:
        r = self._run("diff", "--name-only", f"{sha}^1", sha, check=False)
        if r.returncode != 0:  # root commit
            r = self._run("show", "--name-only", "--format=", sha)
        return {line for line in r.stdout.decode().splitlines() if line}

    def show(self, sha: str, path: str) -> bytes | None:
        r = self._run("show", f"{sha}:{path}", check=False)
        return r.stdout if r.returncode == 0 else None

    def is_ancestor(self, a: str, b: str) -> bool:
        return self._run("merge-base", "--is-ancestor", a, b, check=False).returncode == 0

    def rev_parse(self, ref: str) -> str:
        return self._run("rev-parse", ref).stdout.decode().strip()

    def first_adding_commit(self, main_sha: str, path: str) -> str | None:
        out = self._run("log", main_sha, "--full-history", "--diff-filter=A", "--format=%H", "--", path).stdout
        shas = out.decode().split()
        return shas[-1] if shas else None

    def ls_dir(self, sha: str, dirpath: str) -> list[str]:
        out = self._run("ls-tree", "--name-only", f"{sha}:{dirpath}", check=False)
        return sorted(out.stdout.decode().split()) if out.returncode == 0 else []

    def weekly_commits(self, main_sha: str) -> list[str]:
        out = self._run("log", main_sha, "--full-history", "--format=%H", "--", *WEEKLY_FILES).stdout
        return out.decode().split()


# --- ledger -----------------------------------------------------------------------------------------------------
def normalize_event(raw: dict) -> dict:
    actor = raw.get("actor")
    return {"id": raw["id"], "ref": raw.get("ref"), "timestamp": raw["timestamp"], "before": raw.get("before"),
            "after": raw.get("after"), "activity_type": raw.get("activity_type"),
            "actor": actor.get("login") if isinstance(actor, dict) else actor}


def load_ledger(path: Path) -> dict:
    p = Path(path)
    if not p.exists():
        return {"events": [], "coverage": []}
    return json.loads(p.read_text(encoding="utf-8"))


def merge_collection(ledger: dict, raw_events: list[dict], t_end: str, t_start: str | None = None) -> dict:
    """Append-only merge by id; record [t_start, t_end] coverage (t_start defaults to the oldest event seen)."""
    by_id = {e["id"]: e for e in ledger["events"]}
    for raw in raw_events:
        e = normalize_event(raw)
        by_id.setdefault(e["id"], e)
    events = sorted(by_id.values(), key=lambda e: (e["timestamp"], e["id"]))
    start = t_start or (min(normalize_event(r)["timestamp"] for r in raw_events) if raw_events else t_end)
    coverage = sorted(ledger["coverage"] + [[start, t_end]])
    return {"events": events, "coverage": coverage}


def save_ledger(ledger: dict, path: Path) -> None:
    Path(path).write_text(json.dumps(ledger, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def _ts(x) -> pd.Timestamp:
    t = pd.Timestamp(x)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


def covered(ledger: dict, t0, t1) -> bool:
    a, b = _ts(t0), _ts(t1)
    merged: list[list[pd.Timestamp]] = []
    for s, e in sorted((_ts(s), _ts(e)) for s, e in ledger["coverage"]):
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return any(s <= a and b <= e for s, e in merged)


# --- publications ------------------------------------------------------------------------------------------------
def read_payloads(git, sha: str) -> tuple[dict | None, dict | None]:
    out = []
    for path in WEEKLY_FILES:
        raw = git.show(sha, path)
        out.append(json.loads(raw) if raw else None)
    return out[0], out[1]


def _payload_week(git, sha: str):
    legacy, neutral = read_payloads(git, sha)
    p = legacy or neutral
    return (p.get("season"), p.get("week")) if p else (None, None)


def is_candidate(git, sha: str, season: int, week: int) -> bool:
    if not git.exists(sha):
        return False
    a, c = git.ident(sha)
    if a != BOT or c != BOT or not (git.changed(sha) & set(WEEKLY_FILES)):
        return False
    return _payload_week(git, sha) == (season, week)


def _main_events(ledger: dict, kinds: set[str], before: pd.Timestamp) -> list[dict]:
    return [e for e in ledger["events"] if e.get("ref") == MAIN_REF and e.get("activity_type") in kinds
            and _ts(e["timestamp"]) < before]


def select_publication(ledger: dict, git, season: int, week: int, cutoff: pd.Timestamp, main_sha: str) -> dict:
    cutoff = _ts(cutoff)
    pushes = sorted(_main_events(ledger, {"push"}, cutoff), key=lambda e: (_ts(e["timestamp"]), e["id"]),
                    reverse=True)
    chosen = None
    for e in pushes:
        if not git.exists(e["after"]):
            return {"status": "publication_evidence_unavailable", "commit": None, "event_id": e["id"],
                    "available_by": None, "detail": "unfetchable ledger sha newer than any selectable publication"}
        if is_candidate(git, e["after"], season, week):
            chosen = e
            break
    if chosen is None:
        exists = any(is_candidate(git, s, season, week) for s in git.weekly_commits(main_sha))
        status = "publication_evidence_unavailable" if exists else "weeks_unpublished"
        return {"status": status, "commit": None, "event_id": None, "available_by": None,
                "detail": "candidate payload without pre-cutoff push evidence" if exists else "no candidate payload"}
    first = min((e for e in pushes if e["after"] == chosen["after"]), key=lambda e: (_ts(e["timestamp"]), e["id"]))
    available_by = first["timestamp"]
    if not covered(ledger, available_by, cutoff):
        return {"status": "publication_evidence_unavailable", "commit": None, "event_id": first["id"],
                "available_by": None, "detail": "ledger coverage gap between publication and cutoff"}
    forced = [e for e in _main_events(ledger, {"force_push"}, cutoff) if _ts(e["timestamp"]) >= _ts(available_by)]
    if forced:
        return {"status": "publication_evidence_unavailable", "commit": None, "event_id": forced[0]["id"],
                "available_by": None, "detail": "force_push between publication and cutoff"}
    return {"status": "selected", "commit": chosen["after"], "event_id": first["id"], "available_by": available_by,
            "detail": None}


# --- archives ----------------------------------------------------------------------------------------------------
def _archive_ok(name: str, blob: bytes) -> bool:
    digest = name.rsplit("-", 1)[-1].removesuffix(".json")
    return hashlib.sha256(blob).hexdigest()[:16] == digest


def select_archive(ledger: dict, git, season: int, week: int, cutoff: pd.Timestamp, main_sha: str) -> dict:
    cutoff = _ts(cutoff)
    prefix = f"{season}-w{week:02d}-"
    events = sorted(_main_events(ledger, {"push", "pr_merge"}, cutoff), key=lambda e: (_ts(e["timestamp"]), e["id"]))
    qualifying = []
    for name in git.ls_dir(main_sha, ARCHIVE_DIR):
        if not name.startswith(prefix):
            continue
        path = f"{ARCHIVE_DIR}/{name}"
        c = git.first_adding_commit(main_sha, path)
        if c is None or git.ident(c) != (BOT, BOT):
            continue
        ev = next((e for e in events if git.exists(e["after"]) and git.is_ancestor(c, e["after"])), None)
        if ev is None or not covered(ledger, ev["timestamp"], cutoff):
            continue
        qualifying.append({"path": path, "name": name, "commit": c, "available_by": ev["timestamp"], "event_id": ev["id"]})
    if not qualifying:
        return {"status": "no_archive", "path": None, "commit": None, "available_by": None, "tie_break": None,
                "alternatives": [], "content": None}
    latest = max(_ts(q["available_by"]) for q in qualifying)
    top = sorted((q for q in qualifying if _ts(q["available_by"]) == latest), key=lambda q: q["name"])
    pick = top[0]
    blob = git.show(pick["commit"], pick["path"])
    base = {"path": pick["path"], "commit": pick["commit"], "available_by": pick["available_by"],
            "tie_break": "arbitrary_lexicographic" if len(top) > 1 else None,
            "alternatives": [q for q in qualifying if q is not pick]}
    if blob is None or not _archive_ok(pick["name"], blob):
        return {**base, "status": "archive_hash_mismatch", "content": None}
    return {**base, "status": "selected", "content": json.loads(blob)}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_live_accuracy_evidence.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/live_accuracy.py tests/test_live_accuracy_evidence.py
git commit -m "feat(live_accuracy): append-only push ledger, git adapter, exact-push publication and archive evidence (spec §4.1/§4.3)"
```

---

### Task 6: live_accuracy — published values, metrics, rankings, artifact, CLI

**Files:**
- Modify: `src/ffmodel/eval/live_accuracy.py` (append)
- Test: `tests/test_live_accuracy_metrics.py`

**Interfaces:**
- Consumes:
  - Task 5;
  - `sameweek.validate_projections`, `validate_actuals`, `validate_table`, `build_cells`, `sameweek_week`,
    `delta_stats`, `week_dates`, `POSITIONS`;
  - `ffmodel.site.leaguelens.effective_weights`, `reference_score`;
  - `ffmodel.baseline.naive.NaiveLast4`;
  - `ffmodel.eval.metrics.pinball_loss`;
  - `ffmodel.scoring.PPR`, `PREDICTED_STATS`, `fantasy_points`;
  - `ffmodel.eval.mean_head_gate.paired_bootstrap`;
  - `ffmodel.prospective.freeze.check_fresh`.
- Produces:
  - `ppr_weights() -> dict`
  - `published_values(legacy, neutral, weights) -> tuple[pd.DataFrame | None, str | None, dict]`
    - frame columns: `player_id, position, team, p10, p50, p90`
    - second value: a reason (`"equivalence_failed"`) or None
    - third value: a detail dict
  - `naive_points(features, rows, season) -> pd.Series`
  - `point_metrics(df) -> dict`
    - `df` columns: `actual, p10, p50, p90, naive, player_id, week, team`
  - `paired_intervals(df) -> dict`
  - `week_complete(schedules, played_all, season, week) -> bool`
  - `evaluate(context) -> dict`
    - the full artifact, without its `run` block
    - `context` is a `LiveContext` dataclass
  - `render_markdown(artifact) -> str`
  - `main(argv=None) -> int`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_live_accuracy_metrics.py
"""Spec §4.2-4.6: published values, point metrics, completeness, artifact and markdown. Synthetic only."""
import numpy as np
import pandas as pd
import pytest

from ffmodel.eval import live_accuracy as la


def _legacy(gen="g1"):
    return {"season": 2026, "week": 4, "generated_at": gen,
            "players": [{"player_id": "p1", "position": "WR", "team": "AAA",
                         "points": {"ppr": {"p10": 2.0, "p50": 5.0, "p90": 9.0}}}]}


def _neutral(gen="g1", rec=(1.0, 2.5, 4.0)):
    from ffmodel.site.leaguelens import STATS
    sq = {q: {**{s: 0.0 for s in STATS}, "receptions": r, "receiving_yards": 10 * r}
          for q, r in zip(("p10", "p50", "p90"), rec)}
    return {"season": 2026, "week": 4, "generated_at": gen,
            "players": [{"player_id": "p1", "position": "WR", "team": "AAA", "stat_quantiles": sq}]}


def test_values_prefer_legacy_and_check_equivalence():
    w = la.ppr_weights()
    # neutral PPR for rec r: r*1 + 10r*0.1 = 2r -> (2, 5, 8); legacy p90 9.0 differs by 1.0 -> equivalence_failed
    df, reason, detail = la.published_values(_legacy(), _neutral(), w)
    assert reason == "equivalence_failed" and detail["players"] == ["p1"]
    df, reason, _ = la.published_values(_legacy(), _neutral(gen="other"), w)       # different batch: no check
    assert reason is None and df.loc[0, "p50"] == 5.0
    df, reason, _ = la.published_values(None, _neutral(), w)                         # legacy retired
    assert reason is None and list(df[["p10", "p50", "p90"]].iloc[0]) == pytest.approx([2.0, 5.0, 8.0])


def test_point_metrics_hand_computed():
    df = pd.DataFrame({"actual": [10.0, 2.0, 7.0, 4.0], "p10": [1.0, 3.0, 2.0, 1.0], "p50": [6.0, 5.0, 7.0, 4.0],
                       "p90": [9.0, 9.0, 12.0, 8.0], "naive": [8.0, 4.0, 6.0, 4.0],
                       "player_id": ["a", "b", "c", "d"], "week": [1, 1, 2, 2], "team": ["X", "X", "Y", "Y"]})
    m = la.point_metrics(df)
    assert m["n"] == 4 and m["mae"] == pytest.approx((4 + 3 + 0 + 0) / 4)
    assert m["naive_mae"] == pytest.approx((2 + 2 + 1 + 0) / 4)
    assert m["coverage_p10_p90"] == pytest.approx(2 / 4)            # 10>9 above, 2<3 below
    assert m["below_p10"] == pytest.approx(0.25) and m["above_p90"] == pytest.approx(0.25)
    assert m["share_above_p50"] == pytest.approx(0.25)


def test_paired_intervals_accept_scalar_string_clusters():
    df = pd.DataFrame({"actual": [10.0, 2.0, 7.0, 4.0, 6.0, 3.0], "p50": [6.0, 5.0, 7.0, 4.0, 5.0, 3.5],
                       "naive": [8.0, 4.0, 6.0, 4.0, 6.0, 2.0], "player_id": list("abcdef"),
                       "week": [1, 1, 2, 2, 3, 3], "team": ["X", "Y", "X", "Y", "X", "Y"]})
    r = la.paired_intervals(df)
    assert len(r["ci95_player"]) == 2 and len(r["ci95_week_team"]) == 2
    assert r["delta_mae_model_minus_naive"] == pytest.approx(np.mean(np.abs(df.actual - df.p50) - np.abs(df.actual - df.naive)))


def test_week_complete_requires_every_team():
    sched = pd.DataFrame([(2026, 5, "2026-10-08", "AAA", "BBB"), (2026, 5, "2026-10-12", "CCC", "DDD")],
                         columns=["season", "week", "gameday", "home_team", "away_team"])
    played = pd.DataFrame({"season": [2026] * 3, "week": [5] * 3, "team": ["AAA", "BBB", "CCC"]})
    assert not la.week_complete(sched, played, 2026, 5)          # Monday-night DDD missing -> incomplete_week
    played.loc[3] = [2026, 5, "DDD"]
    assert la.week_complete(sched, played, 2026, 5)


def test_render_markdown_has_provisional_and_rows():
    art = {"season": 2026, "weeks_scored": [1], "weeks_skipped": [{"week": 2, "reason": "incomplete_week"}],
           "points": {"overall": {"n": 3, "mae": 4.1, "naive_mae": 4.5, "coverage_p10_p90": 0.8,
                                  "below_p10": 0.1, "above_p90": 0.1},
                      "by_week": {"1": {"n": 3, "mae": 4.1, "naive_mae": 4.5, "coverage_p10_p90": 0.8,
                                        "below_p10": 0.1, "above_p90": 0.1, "last_game": "2026-09-14"}}},
           "ranking": {"primary": {"by_week": {}}}, "caveats": ["c1"],
           "run": {"provisional_weeks": [1]}}
    md = la.render_markdown(art)
    assert "Provisional: weeks 1" in md and "| 1 |" in md and "incomplete_week" in md
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_live_accuracy_metrics.py -q`
Expected: FAIL with `AttributeError: ... 'ppr_weights'`.

- [ ] **Step 3: Implement (append to `live_accuracy.py`; consolidate imports at the top)**

```python
import argparse
import datetime as dt
import os
import tempfile
from dataclasses import dataclass

import numpy as np
import yaml

from ffmodel.baseline.naive import NaiveLast4
from ffmodel.eval import sameweek as sw
from ffmodel.eval.mean_head_gate import paired_bootstrap
from ffmodel.eval.metrics import pinball_loss
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points
from ffmodel.site import leaguelens

PROTOCOL_VERSION = "live-accuracy-v1"
EQUIV_TOL = 0.01
FORMAT_YAML = Path("configs/formats/f12-1qb-ppr-4.yaml")
LEDGER_PATH = Path("models/diagnostics/main_push_ledger.json")


def ppr_weights() -> dict:
    return leaguelens.effective_weights(yaml.safe_load(FORMAT_YAML.read_text(encoding="utf-8"))["sleeper_scoring"])


def _legacy_frame(legacy: dict) -> pd.DataFrame:
    rows = [{"player_id": p["player_id"], "position": p.get("position"), "team": p.get("team"),
             **{q: p["points"]["ppr"].get(q) for q in ("p10", "p50", "p90")}} for p in legacy["players"]]
    return pd.DataFrame(rows, columns=["player_id", "position", "team", "p10", "p50", "p90"])


def _neutral_frame(neutral: dict, weights: dict) -> pd.DataFrame:
    rows = []
    for p in neutral["players"]:
        try:
            s = leaguelens.reference_score(p["stat_quantiles"], p["position"], weights)
        except ValueError:
            s = {"p10": np.nan, "p50": np.nan, "p90": np.nan}   # surfaces as nonfinite in validation
        rows.append({"player_id": p["player_id"], "position": p.get("position"), "team": p.get("team"), **s})
    return pd.DataFrame(rows, columns=["player_id", "position", "team", "p10", "p50", "p90"])


def published_values(legacy, neutral, weights):
    if legacy is None and neutral is None:
        return None, "weeks_unpublished", {}
    if legacy is None:
        return _neutral_frame(neutral, weights), None, {"source": "neutral"}
    leg = _legacy_frame(legacy)
    same = (neutral is not None and neutral.get("generated_at") == legacy.get("generated_at")
            and neutral.get("season") == legacy.get("season") and neutral.get("week") == legacy.get("week"))
    if same:
        neu = _neutral_frame(neutral, weights).set_index("player_id")
        both = leg.set_index("player_id").join(neu, rsuffix="_n", how="inner")
        diff = pd.concat([(both[q] - both[f"{q}_n"]).abs() for q in ("p10", "p50", "p90")], axis=1).max(axis=1)
        bad = sorted(diff[diff > EQUIV_TOL].index)
        if bad:
            return None, "equivalence_failed", {"players": bad, "max_diff": float(diff.max())}
    return leg, None, {"source": "legacy", "equivalence_checked": bool(same)}


def naive_points(features: pd.DataFrame, rows: pd.DataFrame, season: int) -> pd.Series:
    model = NaiveLast4()
    model.fit(features[features["season"] < season])
    missing = set(rows["position"]) - set(model._pos_means.index)
    if missing:
        raise ValueError(f"naive fallback has no position mean for {sorted(missing)}")
    return fantasy_points(model.predict(rows), PPR)


def point_metrics(df: pd.DataFrame) -> dict:
    y, p50 = df["actual"].to_numpy(float), df["p50"].to_numpy(float)
    lo, hi, nv = df["p10"].to_numpy(float), df["p90"].to_numpy(float), df["naive"].to_numpy(float)
    resid = y - p50
    return {"n": int(len(df)), "mae": float(np.abs(resid).mean()), "naive_mae": float(np.abs(y - nv).mean()),
            "mean_resid": float(resid.mean()), "median_resid": float(np.median(resid)),
            "share_above_p50": float((y > p50).mean()),
            "coverage_p10_p90": float(((y >= lo) & (y <= hi)).mean()),
            "below_p10": float((y < lo).mean()), "above_p90": float((y > hi).mean()),
            "pinball_p10": float(pinball_loss(y, lo, 0.1)), "pinball_p50": float(pinball_loss(y, p50, 0.5)),
            "pinball_p90": float(pinball_loss(y, hi, 0.9))}


def paired_intervals(df: pd.DataFrame) -> dict:
    delta = (np.abs(df["actual"] - df["p50"]) - np.abs(df["actual"] - df["naive"])).to_numpy(float)
    by_player = paired_bootstrap(delta, df["player_id"].astype(str).to_numpy(), n_boot=sw.N_BOOT, seed=sw.BOOT_SEED)
    games = (df["week"].astype(str) + "|" + df["team"].astype(str)).to_numpy()
    by_game = paired_bootstrap(delta, games, n_boot=sw.N_BOOT, seed=sw.BOOT_SEED)
    return {"delta_mae_model_minus_naive": float(delta.mean()), "ci95_player": by_player["ci95"],
            "ci95_week_team": by_game["ci95"], "note": "conditional on the observed weeks"}


def week_complete(schedules: pd.DataFrame, played_all: pd.DataFrame, season: int, week: int) -> bool:
    teams = set()
    for ds_team in sw.team_game_dates(schedules, season, week).keys():
        teams.add(ds_team)
    have = set(played_all.loc[(played_all["season"] == season) & (played_all["week"] == week), "team"])
    return bool(teams) and teams <= have
```

Then add the orchestration:

```python
@dataclass
class LiveContext:
    season: int
    weeks: list[int] | None          # None = every complete REG week
    features: pd.DataFrame           # build_features over S-3..S
    schedules: pd.DataFrame
    rankings: pd.DataFrame | None    # normalize_weekly_rankings(load_ff_rankings("all")) for the secondary
    crosswalk: pd.DataFrame | None
    ledger: dict
    git: object
    main_sha: str
    bakeoff: dict


def _ranking_block(cells: list[dict]) -> dict:
    if not cells:
        return {"cells": 0}
    df = pd.DataFrame(cells)
    st = sw.delta_stats(df)
    per_pos = {p: float((g["sp_ours"] - g["sp_con"]).mean()) for p, g in df.groupby("position")}
    return {"cells": int(len(df)), "sp_ours": float(df["sp_ours"].mean()), "sp_con": float(df["sp_con"].mean()),
            "D": st["D"], "ci_week": st["ci_week"], "per_position_D": per_pos}


def _reference(bakeoff: dict) -> dict:
    rows = [r for r in bakeoff["results"] if r["position"] == "OVERALL"]
    def nw(model, key):
        rs = [r for r in rows if r["model"] == model and r.get(key) is not None]
        return sum(r[key] * r["n"] for r in rs) / sum(r["n"] for r in rs)
    cov = {str(r["test_season"]): r["coverage_p10_p90"] for r in rows if r["model"] == "transformer"}
    return {"label": "context: different population and fallback history",
            "transformer_mae_2023_25": nw("transformer", "mae"), "naive_mae_2023_25": nw("naive_last4", "mae"),
            "coverage_by_season": cov, "source": "models/backtests/bakeoff.json"}


def evaluate(ctx: LiveContext) -> dict:
    S, git = ctx.season, ctx.git
    dates = sw.week_dates(ctx.schedules, S)
    feats_s = ctx.features[ctx.features["season"] == S]
    weeks = ctx.weeks or sorted(dates)
    weights = ppr_weights()
    scored_frames, skipped, per_week = [], [], {}
    primary_cells, secondary_cells = [], []
    for N in weeks:
        if N not in dates:
            continue
        K, Z = dates[N]
        if not week_complete(ctx.schedules, feats_s, S, N):
            skipped.append({"week": N, "reason": "incomplete_week"})
            continue
        cutoff = pd.Timestamp(K).tz_localize("UTC")
        pub = select_publication(ctx.ledger, git, S, N, cutoff, ctx.main_sha)
        rec = {"publication": pub, "last_game": str(Z.date())}
        if pub["status"] != "selected":
            skipped.append({"week": N, "reason": pub["status"], "detail": pub["detail"]})
            per_week[str(N)] = rec
            continue
        legacy, neutral = read_payloads(git, pub["commit"])
        vals, reason, detail = published_values(legacy, neutral, weights)
        rec["values"] = detail
        if reason:
            skipped.append({"week": N, "reason": reason, "detail": detail})
            per_week[str(N)] = rec
            continue
        vp = sw.validate_projections(vals)
        rows = feats_s[feats_s["week"] == N]
        va = sw.validate_actuals(rows, ctx.schedules, S, N)
        rec["validation"] = {"projections": vp.report(), "actuals": va.report()}
        if vp.fails() or va.fails():
            skipped.append({"week": N, "reason": "validation_failed"})
            per_week[str(N)] = rec
            continue
        act = va.valid.copy()
        act["actual"] = fantasy_points(act[PREDICTED_STATS], PPR).to_numpy()
        act["naive"] = naive_points(ctx.features, act, S).to_numpy()
        joined = act[["player_id", "position", "team", "week", "actual", "naive"]].merge(
            vp.valid[["player_id", "p10", "p50", "p90"]], on="player_id", how="left")
        unproj = joined[joined["p50"].isna()]
        joined = joined.dropna(subset=["p50"])
        rec["unprojected"] = {"count": int(len(unproj)),
                              "mean_actual": float(unproj["actual"].mean()) if len(unproj) else None,
                              "by_position": unproj["position"].value_counts().sort_index().astype(int).to_dict()}
        rec["points"] = point_metrics(joined)
        scored_frames.append(joined)
        # primary ranking: our archives
        arc = select_archive(ctx.ledger, git, S, N, cutoff, ctx.main_sha)
        rec["expert_snapshot"] = {k: v for k, v in arc.items() if k != "content"}
        if arc["status"] == "selected":
            con = pd.DataFrame(arc["content"]["players"])
            vc = sw.validate_table(con, ["player_id"], ["ecr"], ["position", "team"])
            if vc.fails():
                rec["primary"] = {"status": "skipped", "reason": "validation_failed"}
            else:
                ours = joined.rename(columns={"p50": "our_pts"})
                pool = ours.merge(vc.valid[["player_id", "ecr"]], on="player_id")
                cells, deg = sw.build_cells(pool, S, N, "archive")
                primary_cells += cells
                sens = []
                for alt in arc["alternatives"]:          # §4.3 sensitivity: each other qualifying archive
                    blob = git.show(alt["commit"], alt["path"])
                    if blob is None or not _archive_ok(alt["name"], blob):
                        sens.append({"path": alt["path"], "status": "archive_hash_mismatch"})
                        continue
                    alt_con = sw.validate_table(pd.DataFrame(json.loads(blob)["players"]), ["player_id"], ["ecr"],
                                                ["position", "team"]).valid
                    alt_cells, _ = sw.build_cells(ours.merge(alt_con[["player_id", "ecr"]], on="player_id"), S, N, "archive")
                    sens.append({"path": alt["path"], "sp_con": float(np.mean([c["sp_con"] for c in alt_cells]))
                                 if alt_cells else None, "cells": len(alt_cells)})
                rec["primary"] = {"status": "scored" if cells else "skipped",
                                  "reason": None if cells else "no_scorable_cell", "cells": len(cells),
                                  "degenerate": deg, "pool": int(len(pool)), "sensitivity": sens}
        else:
            rec["primary"] = {"status": "skipped", "reason": arc["status"]}
        # secondary ranking: nflverse same-week rule
        if ctx.rankings is not None and ctx.crosswalk is not None:
            played = joined.rename(columns={"p50": "our_pts"})[["player_id", "position", "team", "our_pts", "actual"]]
            res = sw.sameweek_week(played, ctx.schedules, ctx.rankings, ctx.crosswalk, S, N, dates)
            secondary_cells += res["cells"]
            rec["secondary"] = {k: v for k, v in res.items() if k != "cells"}
        per_week[str(N)] = rec
    allrows = pd.concat(scored_frames, ignore_index=True) if scored_frames else None
    points = {}
    if allrows is not None and len(allrows):
        points = {"overall": {**point_metrics(allrows), **paired_intervals(allrows)},
                  "by_position": {p: point_metrics(g) for p, g in allrows.groupby("position")},
                  "by_week": {str(w): {**point_metrics(g), "last_game": per_week[str(w)]["last_game"]}
                              for w, g in allrows.groupby("week")}}
    def _h(df):
        return None if df is None else hashlib.sha256(pd.util.hash_pandas_object(df, index=False).values.tobytes()).hexdigest()
    inputs = {"features_season_rows": _h(feats_s), "schedules": _h(ctx.schedules), "rankings": _h(ctx.rankings),
              "crosswalk": _h(ctx.crosswalk), "ledger_events": len(ctx.ledger["events"]),
              "ledger_hash": hashlib.sha256(json.dumps(ctx.ledger, sort_keys=True).encode()).hexdigest()}
    coverage = {}
    if ctx.rankings is not None:
        rs = ctx.rankings[ctx.rankings["scrape_date"] >= pd.Timestamp(f"{S}-03-01")]
        coverage = {"scrape_dates": sorted(str(d.date()) for d in rs["scrape_date"].unique()),
                    "weekdays": rs["scrape_date"].dt.day_name().value_counts().to_dict(),
                    "rows": int(len(rs))}
    return {"protocol_version": PROTOCOL_VERSION, "season": S, "inputs": inputs, "ranking_coverage": coverage,
            "evaluator_version": f"{PROTOCOL_VERSION}+{git.rev_parse(f'{ctx.main_sha}:src/ffmodel')}",
            "weeks_scored": sorted(int(w) for w in (allrows["week"].unique() if allrows is not None else [])),
            "weeks_skipped": skipped, "weeks": per_week, "points": points,
            "ranking": {"primary": _ranking_block(primary_cells), "secondary": _ranking_block(secondary_cells)},
            "reference_context": _reference(ctx.bakeoff),
            "caveats": ["Projections = the bot pipeline's latest publication on main before K_N 00:00 UTC, proven "
                        "by GitHub push records; Vercel deployment is not verified.",
                        "Players who played only; DNPs are outside the estimand.",
                        "Expert rankings are FantasyPros mirrors; small samples are descriptive, not tests."]}


def render_markdown(art: dict) -> str:
    o = art.get("points", {}).get("overall")
    lines = [f"# Live weekly accuracy — {art['season']}", ""]
    if o:
        lines.append(f"Through weeks {art['weeks_scored']}: MAE {o['mae']:.2f} vs naive {o['naive_mae']:.2f}; "
                     f"p10–p90 coverage {o['coverage_p10_p90']:.1%} (below {o['below_p10']:.1%}, above {o['above_p90']:.1%}).")
    else:
        lines.append("No complete weeks scored yet.")
    prov = art.get("run", {}).get("provisional_weeks", [])
    lines += ["", f"Provisional: weeks {', '.join(map(str, prov)) if prov else 'none'}", "",
              "| week | last game | n | MAE | naive MAE | coverage | below | above | ours vs consensus |",
              "|---|---|---|---|---|---|---|---|---|"]
    prim = art.get("ranking", {}).get("primary", {})
    for w, m in sorted(art.get("points", {}).get("by_week", {}).items(), key=lambda kv: int(kv[0])):
        lines.append(f"| {w} | {m.get('last_game', '')} | {m['n']} | {m['mae']:.2f} | {m['naive_mae']:.2f} | "
                     f"{m['coverage_p10_p90']:.1%} | {m['below_p10']:.1%} | {m['above_p90']:.1%} | — |")
    if prim.get("cells"):
        lines += ["", f"Expert comparison (our archived same-week snapshots, {prim['cells']} cells): "
                      f"ours {prim['sp_ours']:.3f} vs consensus {prim['sp_con']:.3f}."]
    for s in art.get("weeks_skipped", []):
        lines.append(f"- week {s['week']} skipped: {s['reason']}")
    lines += ["", *[f"- {c}" for c in art.get("caveats", [])], ""]
    return "\n".join(lines)


def fetch_activity(repo: str) -> list[dict]:
    out = subprocess.run(["gh", "api", "--paginate", f"repos/{repo}/activity?ref={MAIN_REF}&per_page=100"],
                         capture_output=True, check=True, text=True).stdout
    return json.loads(out)


def main(argv=None) -> int:
    from ffmodel.data.features import build_features
    from ffmodel.data.pull import _cached, current_nfl_season, pull_schedules, pull_weekly, LIVE_MAX_AGE_HOURS
    from ffmodel.data.rankings import pull_player_ids
    from ffmodel.eval.weekly_rankings import normalize_weekly_rankings

    ap = argparse.ArgumentParser(description="Live weekly accuracy scorecard (spec §4).")
    ap.add_argument("--season", type=int, default=None)
    ap.add_argument("--weeks", default=None, help="e.g. 1-4")
    ap.add_argument("--data-dir", type=Path, default=None)
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", "mtsilverstein/Megatron"))
    ap.add_argument("--main-ref", default="origin/main")
    ap.add_argument("--no-fetch", action="store_true", help="use the committed ledger without a new collection")
    ap.add_argument("--frozen-record", type=Path, default=None)
    args = ap.parse_args(argv)
    S = args.season or current_nfl_season()
    weeks = None
    if args.weeks:
        a, b = (int(x) for x in args.weeks.split("-"))
        weeks = list(range(a, b + 1))
    data_dir = args.data_dir or Path(tempfile.mkdtemp(prefix="live-acc-"))
    ledger = load_ledger(LEDGER_PATH)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not args.no_fetch:
        ledger = merge_collection(ledger, fetch_activity(args.repo), t_end=now)
    git = Git(".")
    main_sha = git.rev_parse(args.main_ref)
    spans = list(range(S - 3, S + 1))
    weekly, schedules = pull_weekly(spans, cache_dir=data_dir), pull_schedules(spans, cache_dir=data_dir)
    import nflreadpy
    raw = _cached(data_dir, "ff_rankings_all_raw", lambda: nflreadpy.load_ff_rankings("all").to_pandas(),
                  LIVE_MAX_AGE_HOURS)
    ctx = LiveContext(season=S, weeks=weeks, features=build_features(weekly, schedules), schedules=schedules,
                      rankings=normalize_weekly_rankings(raw), crosswalk=pull_player_ids(data_dir), ledger=ledger,
                      git=git, main_sha=main_sha,
                      bakeoff=json.loads(Path("models/backtests/bakeoff.json").read_text(encoding="utf-8")))
    art = evaluate(ctx)
    today = dt.date.today()
    dates = sw.week_dates(schedules, S)
    art["run"] = {"run_at": now, "as_of_date": str(today), "main_sha": main_sha,
                  "provisional_weeks": [w for w in art["weeks_scored"] if (pd.Timestamp(today) - dates[w][1]).days < 8]}
    text = json.dumps(art, indent=1, sort_keys=True, default=str) + "\n"
    if args.frozen_record:
        args.frozen_record.write_text(text, encoding="utf-8")
        return 0
    out = Path(f"models/diagnostics/live_{S}_weekly.json")
    out.write_text(text, encoding="utf-8")
    out.with_suffix(".md").write_text(render_markdown(art), encoding="utf-8")
    if not args.no_fetch:
        save_ledger(ledger, LEDGER_PATH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Notes for the implementer:

- `week_complete` intentionally reads `team` from the features frame for the season. Validation runs per week
  later.
- The CLI's network and git calls are not unit-tested; Task 9's acceptance run covers them.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_live_accuracy_metrics.py tests/test_live_accuracy_evidence.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/live_accuracy.py tests/test_live_accuracy_metrics.py
git commit -m "feat(live_accuracy): published values with equivalence, point metrics, naive baseline, rankings, artifact, markdown, CLI (spec §4.2-4.6)"
```

---

### Task 7: Ledger seed and workflow

**Files:**
- Create: `tools/build_push_ledger_seed.py`
- Create: `models/diagnostics/main_push_ledger.json`, generated by the tool
- Create: `.github/workflows/weekly-accuracy.yml`
- Test: `tests/test_weekly_accuracy_workflow.py`

**Interfaces:**
- Consumes: `live_accuracy.merge_collection`, `save_ledger`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_weekly_accuracy_workflow.py
"""Static checks on the weekly-accuracy workflow and the committed ledger seed (spec §4.1, §4.7)."""
import json
from pathlib import Path

import yaml

WF = Path(".github/workflows/weekly-accuracy.yml")
LEDGER = Path("models/diagnostics/main_push_ledger.json")


def test_workflow_contract():
    wf = yaml.safe_load(WF.read_text(encoding="utf-8"))
    on = wf.get("on", wf.get(True))
    crons = sorted(s["cron"] for s in on["schedule"])
    assert crons == ["47 13 * 9-12,1 3", "47 16 * 9-12,1 2"] and "workflow_dispatch" in on
    assert wf["concurrency"] == {"group": "weekly-site-refresh", "cancel-in-progress": False}
    job = wf["jobs"]["accuracy"]
    assert job["permissions"] == {"contents": "write"}
    text = WF.read_text(encoding="utf-8")
    assert "fetch-depth: 0" in text and 'git config user.name "weekly-accuracy-bot"' in text
    assert "python -m ffmodel.eval.live_accuracy" in text
    assert "git add models/diagnostics/live_*_weekly.json models/diagnostics/live_*_weekly.md models/diagnostics/main_push_ledger.json" in text
    assert "site/" not in text.replace("site/data", "")  # never writes site/


def test_ledger_seed_shape():
    led = json.loads(LEDGER.read_text(encoding="utf-8"))
    assert led["coverage"] and len(led["events"]) >= 239
    ids = [e["id"] for e in led["events"]]
    assert len(ids) == len(set(ids))
    assert all(isinstance(e["actor"], (str, type(None))) for e in led["events"])
    assert not any(e["activity_type"] == "force_push" for e in led["events"])
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_weekly_accuracy_workflow.py -q`
Expected: FAIL with `FileNotFoundError`.

- [ ] **Step 3: Implement the seed tool and generate the ledger**

```python
# tools/build_push_ledger_seed.py
"""Build models/diagnostics/main_push_ledger.json from the 2026-10-06 raw activity capture (spec §4.1 seed).

Usage: .venv/Scripts/python.exe tools/build_push_ledger_seed.py .review/evidence-seed/activity-main-2026-10-06T190201Z.json
The capture paginated to the end of history, so its coverage starts at its oldest event; it ends at capture time.
"""
import json
import sys
from pathlib import Path

from ffmodel.eval.live_accuracy import LEDGER_PATH, merge_collection, save_ledger

CAPTURED_AT = "2026-10-06T19:02:01Z"


def main(path: str) -> None:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    ledger = merge_collection({"events": [], "coverage": []}, raw, t_end=CAPTURED_AT)
    save_ledger(ledger, LEDGER_PATH)
    print(f"{len(ledger['events'])} events; coverage {ledger['coverage']}")


if __name__ == "__main__":
    main(sys.argv[1])
```

Run: `.venv/Scripts/python.exe tools/build_push_ledger_seed.py .review/evidence-seed/activity-main-2026-10-06T190201Z.json`
Expected: `239 events; coverage [['2026-07-11T22:02:06Z', '2026-10-06T19:02:01Z']]`.

- [ ] **Step 4: Write the workflow**

```yaml
# .github/workflows/weekly-accuracy.yml
name: weekly accuracy
# Live weekly accuracy scorecard (spec docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md §4.7).
# Tuesday after Monday-night stats, Wednesday as a second run. Never writes the website directory.
on:
  schedule:
    - cron: "47 16 * 9-12,1 2"
    - cron: "47 13 * 9-12,1 3"
  workflow_dispatch:
concurrency:
  group: weekly-site-refresh
  cancel-in-progress: false
jobs:
  accuracy:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    env:
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-python@v6
        with: { python-version: "3.12" }
      - run: pip install -e .
      - name: Score published projections (infrastructure errors fail before any commit)
        run: python -m ffmodel.eval.live_accuracy --main-ref origin/main
      - name: Commit accuracy artifacts
        run: |
          git config user.name "weekly-accuracy-bot"
          git config user.email "actions@users.noreply.github.com"
          git add models/diagnostics/live_*_weekly.json models/diagnostics/live_*_weekly.md models/diagnostics/main_push_ledger.json
          git diff --cached --quiet && echo "no changes" && exit 0
          git commit -m "data: weekly accuracy refresh"
          for i in 1 2 3; do
            git push && exit 0
            git pull --rebase
          done
          exit 1
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_weekly_accuracy_workflow.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/build_push_ledger_seed.py models/diagnostics/main_push_ledger.json .github/workflows/weekly-accuracy.yml tests/test_weekly_accuracy_workflow.py
git commit -m "feat: weekly-accuracy workflow and push ledger seeded from the 2026-10-06 activity capture (spec §4.1/§4.7)"
```

---

### Task 8: (B) driver — `weekly_consensus_sameweek.py`

**Files:**
- Create: `src/ffmodel/eval/weekly_consensus_sameweek.py`
- Test: `tests/test_weekly_consensus_sameweek.py`

**Interfaces:**
- Consumes:
  - `sameweek.*` (Tasks 1–4);
  - `ffmodel.eval.splits.walk_forward_splits`;
  - `ffmodel.eval.weekly_rankings.weekly_snapshot`;
  - `ffmodel.eval.weekly_consensus.transformer_predictor`, `V1_ROOTS`;
  - `ffmodel.scoring`.
- Produces:
  - `run_sample(features, schedules, rankings, crosswalk, seasons, predict_season) -> dict`
    - keys: `cells` (DataFrame), `weeks` (provenance list), `target_weeks`, `audit` (list), `diagnostic` (list),
      `alarm` (bool)
  - `build_report(disc, rep, provenance) -> dict`
  - `main(argv=None) -> int`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_weekly_consensus_sameweek.py
"""(B) driver orchestration on synthetic data with a fake model (spec §5, §6.6)."""
import numpy as np
import pandas as pd

from ffmodel.eval import sameweek as sw
from ffmodel.eval import weekly_consensus_sameweek as drv
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

TEAMS = ["AAA", "BBB", "CCC", "DDD"]


def _world(season=2024, weeks=4):
    sched, ranks, feats = [], [], []
    rng = np.random.default_rng(1)
    for w in range(1, weeks + 1):
        thu = pd.Timestamp("2024-09-05") + pd.Timedelta(days=7 * (w - 1))
        sched += [(season, w, str(thu.date()), "AAA", "BBB"), (season, w, str((thu + pd.Timedelta(days=3)).date()), "CCC", "DDD")]
        fri = thu + pd.Timedelta(days=1)
        for t in TEAMS:
            for pos in sw.POSITIONS:
                for i in range(4):
                    pid = f"{t}{pos}{i}"
                    ranks.append({"fp_id": pid, "player": pid, "pos": pos, "team": t, "ecr": float(i + 1), "sd": 1.0,
                                  "mergename": pid.lower(), "scrape_date": fri})
                    row = {"player_id": f"g-{pid}", "position": pos, "team": t, "season": season, "week": w}
                    row.update({s: float(rng.poisson(3)) for s in PREDICTED_STATS})
                    feats.append(row)
    sched = pd.DataFrame(sched, columns=["season", "week", "gameday", "home_team", "away_team"])
    ranks = pd.DataFrame(ranks)
    ids = ranks["fp_id"].unique()
    cw = pd.DataFrame({"gsis_id": [f"g-{i}" for i in ids], "fantasypros_id": ids, "merge_name": [i.lower() for i in ids],
                       "position": [r for r in ranks.drop_duplicates("fp_id")["pos"]]})
    return sched, ranks, cw, pd.DataFrame(feats)


def test_run_sample_scores_sunday_players_only_and_records_audit():
    sched, ranks, cw, feats = _world()
    predict = lambda season, train, test: fantasy_points(test[PREDICTED_STATS], PPR)  # positively correlated
    res = drv.run_sample(feats, sched, ranks, cw, [2024], predict)
    scored = [w for w in res["weeks"] if w["status"] == "scored"]
    assert scored and all(w["retention"]["excluded_early_game"] == 32 for w in scored)   # AAA/BBB Thursday
    assert set(res["cells"]["gate_state"]) <= {"bye_consistent", "unverified"}
    assert len(res["audit"]) == 4 and res["target_weeks"] == {2024: [1, 2, 3, 4]}


def test_alarm_on_negative_model_correlation_blocks_verdicts():
    sched, ranks, cw, feats = _world()
    anti = lambda season, train, test: -fantasy_points(test[PREDICTED_STATS], PPR)
    disc = drv.run_sample(feats, sched, ranks, cw, [2024], anti)
    report = drv.build_report(disc, disc, {"inputs": {}})
    assert disc["alarm"] is True and report["verdicts"] == {"status": "alarm_negative_correlation"}


def test_build_report_verdicts_present():
    sched, ranks, cw, feats = _world()
    predict = lambda season, train, test: fantasy_points(test[PREDICTED_STATS], PPR)  # positively correlated
    disc = drv.run_sample(feats, sched, ranks, cw, [2024], predict)
    rep = drv.run_sample(feats, sched, ranks, cw, [2024], predict)
    report = drv.build_report(disc, rep, {"inputs": {}})
    assert report["verdicts"]["rule_1"]["value"] in {"insufficient", "behind", "ahead", "not_established"}
    assert report["verdicts"]["rule_2"]["value"] in {"insufficient", "established", "not_established"}
    assert "old_protocol_staleness_audit" in report and "protocol" in report
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_weekly_consensus_sameweek.py -q`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# src/ffmodel/eval/weekly_consensus_sameweek.py
"""Pre-registered same-week re-measurement of the weekly expert benchmark (spec §5-§6).

Run once by hand: .venv/Scripts/python.exe -m ffmodel.eval.weekly_consensus_sameweek
Verdicts are computed here from the numbers; nothing in §3/§5/§6 may change in response to a result (Rule 4).
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.eval import sameweek as sw
from ffmodel.eval.splits import walk_forward_splits
from ffmodel.eval.weekly_rankings import weekly_snapshot
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

PROTOCOL_VERSION = "sameweek-v1"
DISCOVERY = [2023, 2024, 2025]
REPLICATION = [2020, 2021, 2022]
SPEC = "docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md"


def _old_cells(played, schedules, rankings, crosswalk, season, week, dates, new_res):
    """§5.3: old-protocol and same-week lists scored on identical IDs."""
    if new_res["status"] != "scored":
        return None
    old = weekly_snapshot(rankings, pd.Timestamp(dates[week][0]))
    if old is None:
        return None
    vo = sw.validate_table(old[old["pos"].isin(sw.POSITIONS)], ["fp_id"], ["ecr"], ["pos", "team", "mergename"])
    mo = sw.match_consensus(vo.valid, crosswalk)
    date = pd.Timestamp(new_res["selection"]["scrape_date"])
    new = rankings[(rankings["scrape_date"].dt.normalize() == date) & rankings["pos"].isin(sw.POSITIONS)]
    vn = sw.validate_table(new, ["fp_id"], ["ecr"], ["pos", "team", "mergename"])
    mn = sw.match_consensus(vn.valid, crosswalk)
    if mo.reason or mn.reason:
        return {"week": week, "status": "skipped", "reason": mo.reason or mn.reason}
    games = sw.team_game_dates(schedules, season, week)
    gday = played["team"].map(lambda t: games[t][0] if len(games.get(t, [])) == 1 else pd.NaT)
    elig = played[gday > date]
    common = elig.merge(mo.matched[["player_id", "ecr"]].rename(columns={"ecr": "ecr_old"}), on="player_id")
    common = common.merge(mn.matched[["player_id", "ecr"]], on="player_id")
    new_cells, _ = sw.build_cells(common, season, week, "diag")
    old_cells, _ = sw.build_cells(common.drop(columns="ecr").rename(columns={"ecr_old": "ecr"}), season, week, "diag")
    keys = {c["position"] for c in new_cells} & {c["position"] for c in old_cells}
    pick = lambda cs: {c["position"]: c for c in cs if c["position"] in keys}
    return {"week": week, "status": "scored", "common_ids": int(len(common)), "lost_to_overlap": int(len(elig) - len(common)),
            "cells": [{"position": p, "sp_ours": pick(new_cells)[p]["sp_ours"], "sp_con_new": pick(new_cells)[p]["sp_con"],
                       "sp_con_old": pick(old_cells)[p]["sp_con"]} for p in sorted(keys)]}


def run_sample(features, schedules, rankings, crosswalk, seasons, predict_season) -> dict:
    cells, weeks_prov, audit, diag = [], [], [], []
    target_weeks, alarm = {}, False
    for season, train_idx, test_idx in walk_forward_splits(features, seasons):
        train, test = features.loc[train_idx], features.loc[test_idx]
        our = predict_season(season, train, test)
        dates = sw.week_dates(schedules, season)
        target_weeks[int(season)] = sorted(dates)
        for week in sorted(dates):
            audit.append({"season": int(season), **sw.staleness_audit_week(rankings, schedules, season, week, dates)})
            rows = test[test["week"] == week]
            va = sw.validate_actuals(rows, schedules, season, week)
            if va.fails():
                weeks_prov.append({"season": int(season), "week": week, "status": "skipped", "reason": "validation_failed",
                                   "validation": va.report()})
                continue
            ok = va.valid
            played = pd.DataFrame({"player_id": ok["player_id"].to_numpy(), "position": ok["position"].to_numpy(),
                                   "team": ok["team"].to_numpy(), "our_pts": np.asarray(our.loc[ok.index], dtype=float),
                                   "actual": fantasy_points(ok[PREDICTED_STATS], PPR).to_numpy()})
            res = sw.sameweek_week(played, schedules, rankings, crosswalk, season, week, dates)
            cells += res["cells"]
            weeks_prov.append({"season": int(season), "week": week, **{k: v for k, v in res.items() if k != "cells"},
                               "actuals_validation": va.report()})
            d = _old_cells(played, schedules, rankings, crosswalk, season, week, dates, res)
            if d:
                diag.append({"season": int(season), **d})
    frame = pd.DataFrame(cells)
    if len(frame) and frame["sp_ours"].mean() < 0:
        alarm = True
    return {"cells": frame, "weeks": weeks_prov, "target_weeks": target_weeks, "audit": audit, "diagnostic": diag,
            "alarm": alarm}


def _sample_block(s: dict) -> dict:
    c = s["cells"]
    if c.empty:
        return {"cells": 0, "weeks": s["weeks"]}
    out = {"cells": int(len(c)), "overall": sw.delta_stats(c), "sensitivity": sw.sensitivity_stats(c),
           "per_position": {p: {"stats": sw.delta_stats(g), "sensitivity": sw.sensitivity_stats(g)}
                            for p, g in c.groupby("position")},
           "sp_ours": float(c["sp_ours"].mean()), "sp_con": float(c["sp_con"].mean()),
           "hit_rate_ours": float(c["hit_ours"].sum() / c["slots"].sum()),
           "hit_rate_con": float(c["hit_con"].sum() / c["slots"].sum()),
           "n_le_slots_cells": int(c["n_le_slots"].sum()), "weeks": s["weeks"], "diagnostic": s["diagnostic"]}
    return out


def build_report(disc: dict, rep: dict, provenance: dict) -> dict:
    audit = disc["audit"] + rep["audit"]
    disc_list = [a for a in audit if a["discriminating"] and a["state"]]
    audit_counts = {k: sum(1 for a in disc_list if a["state"] == k) for k in ("contradicted", "bye_consistent", "unverified")}
    if disc["alarm"] or rep["alarm"]:
        verdicts = {"status": "alarm_negative_correlation"}
    else:
        verdicts = {"rule_1": sw.rule_1(disc["cells"], disc["target_weeks"]),
                    "rule_1_replication_descriptive": sw.rule_1(rep["cells"], rep["target_weeks"]),
                    "rule_2": sw.rule_2(disc["cells"], disc["target_weeks"], rep["cells"], rep["target_weeks"])}
    return {"protocol_version": PROTOCOL_VERSION, "protocol": f"{SPEC} §3, §5, §6 (draft 6)",
            "multiplicity": "Rules 1 and 2 are separate pre-specified claims at 95%; no family-wise correction.",
            "estimand": "within-position ranking of players who recorded a stat line, were matched, and had not yet "
                        "played at the scrape date; cutoffs asymmetric; selection effect undetermined",
            "limitations": "three seasons = three clusters; within-season serial dependence not modelled",
            **provenance, "discovery": _sample_block(disc), "replication": _sample_block(rep),
            "old_protocol_staleness_audit": {"weeks": audit, "discriminating_counts": audit_counts,
                                             "discriminating_weeks": [(a["season"], a["week"]) for a in disc_list]},
            "verdicts": verdicts}


def _sha256(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def main(argv=None) -> int:
    from ffmodel.data.features import build_features
    from ffmodel.data.pull import LIVE_MAX_AGE_HOURS, _cached, pull_schedules, pull_weekly
    from ffmodel.data.rankings import pull_player_ids
    from ffmodel.eval.weekly_consensus import V1_ROOTS, transformer_predictor
    from ffmodel.eval.weekly_rankings import normalize_weekly_rankings

    ap = argparse.ArgumentParser(description="Same-week re-measurement (spec §5-§6).")
    ap.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    ap.add_argument("--first-season", type=int, default=2012)
    ap.add_argument("--out", type=Path, default=Path("models/diagnostics/weekly_consensus_sameweek.json"))
    args = ap.parse_args(argv)
    spans = list(range(args.first_season, max(DISCOVERY) + 1))
    weekly, schedules = pull_weekly(spans, cache_dir=args.data_dir), pull_schedules(spans, cache_dir=args.data_dir)
    features = build_features(weekly, schedules)
    import nflreadpy
    raw = _cached(args.data_dir, "ff_rankings_all_raw", lambda: nflreadpy.load_ff_rankings("all").to_pandas(),
                  LIVE_MAX_AGE_HOURS)
    rankings, crosswalk = normalize_weekly_rankings(raw), pull_player_ids(args.data_dir)
    predict = transformer_predictor([Path(r) for r in V1_ROOTS], features)
    disc = run_sample(features, schedules, rankings, crosswalk, DISCOVERY, predict)
    rep = run_sample(features, schedules, rankings, crosswalk, REPLICATION, predict)
    raw_wp = raw[(raw["ecr_type"] == "wp") & raw["pos"].isin(sw.POSITIONS)]
    coverage = {str(y): {"raw_rows": int((pd.to_datetime(raw_wp["scrape_date"]).dt.year == y).sum()),
                         "accepted_rows": int((rankings["scrape_date"].dt.year == y).sum()),
                         "excluded_legacy_schema": int(((pd.to_datetime(raw_wp["scrape_date"]).dt.year == y)
                                                        & (raw_wp["page_type"] == "weekly-offense")).sum()),
                         "scrape_weekdays": rankings.loc[rankings["scrape_date"].dt.year == y, "scrape_date"]
                         .dt.day_name().value_counts().to_dict()} for y in range(2020, 2026)}
    old = {"weekly_consensus.json": json.loads(Path("models/diagnostics/weekly_consensus.json").read_text())["overall"],
           "rb_oos_weekly.json": json.loads(Path("models/diagnostics/rb_oos_weekly.json").read_text())["result"],
           "label": "different_estimand"}
    frame_hash = lambda df: hashlib.sha256(pd.util.hash_pandas_object(df, index=False).values.tobytes()).hexdigest()
    prov = {"inputs": {"ff_rankings_all_raw": _sha256(args.data_dir / "ff_rankings_all_raw.parquet"),
                       "schedules": frame_hash(schedules), "weekly_actuals": frame_hash(weekly),
                       "crosswalk": frame_hash(crosswalk), "roots": [str(r) for r in V1_ROOTS],
                       "folds": sorted({f"through{s - 1}" for s in DISCOVERY + REPLICATION}),
                       "first_season": args.first_season},
            "coverage": coverage, "old_protocol_numbers": old}
    report = build_report(disc, rep, prov)
    args.out.write_text(json.dumps(report, indent=1, sort_keys=True, default=lambda o: o.tolist()
                                   if hasattr(o, "tolist") else str(o)) + "\n", encoding="utf-8")
    print(json.dumps(report["verdicts"], indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_weekly_consensus_sameweek.py -q`
Expected: all pass. If `_world`'s week-1 scrape falls outside `[K_1−7, Z_1)`, fix the fixture's dates, not the rule.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/weekly_consensus_sameweek.py tests/test_weekly_consensus_sameweek.py
git commit -m "feat: same-week re-measurement driver with staleness audit, snapshot-change diagnostic and coded verdicts (spec §5-§6)"
```

---

### Task 9: Acceptance tool (real caches, run by the controller)

**Files:**
- Create: `tools/weekly_accuracy_acceptance.py`

The controller runs this tool by hand before the merge. The tool is network-free: it uses the local caches
`data/raw/ff_rankings_all_raw.parquet` and the schedules cache, plus local git and the committed ledger.

- [ ] **Step 1: Write the tool**

```python
# tools/weekly_accuracy_acceptance.py
"""Spec §7.4 real-data acceptance checks. Prints PASS/FAIL lines; exit code 1 on any FAIL.

1. unknown_team_codes == 0 for every 2020-25 nflverse weekly scrape (team mapping, spec §3.4).
2. §4.1 2026 weeks 1-4 select b451562 / fa9c095 / fbd66fd / d43adc4 with the documented push times.
"""
import sys
from pathlib import Path

import pandas as pd

from ffmodel.data.pull import pull_schedules
from ffmodel.eval import live_accuracy as la
from ffmodel.eval import sameweek as sw
from ffmodel.eval.weekly_rankings import normalize_weekly_rankings

EXPECTED = {1: ("b451562", "2026-09-02T09:45:11Z"), 2: ("fa9c095", "2026-09-16T20:15:31Z"),
            3: ("fbd66fd", "2026-09-23T20:33:45Z"), 4: ("d43adc4", "2026-09-30T21:32:42Z")}


def main() -> int:
    fails = 0
    raw = pd.read_parquet("data/raw/ff_rankings_all_raw.parquet")
    r = normalize_weekly_rankings(raw)
    sched = pull_schedules(list(range(2020, 2027)), cache_dir=Path("data/raw"))
    bad = []
    for date, snap in r[r["scrape_date"].dt.year.between(2020, 2025)].groupby("scrape_date"):
        season = date.year if date.month >= 3 else date.year - 1
        teams = sw.season_teams(sched, season)
        mapped = snap.loc[snap["pos"].isin(sw.POSITIONS), "team"].map(sw.map_team)
        n = int((mapped.notna() & ~mapped.isin(teams)).sum())
        if n:
            bad.append((str(date.date()), n))
    print(("PASS" if not bad else "FAIL") + f" unknown_team_codes 2020-25: {bad[:10]}")
    fails += bool(bad)
    git, ledger = la.Git("."), la.load_ledger(la.LEDGER_PATH)
    main_sha = git.rev_parse("origin/main")
    dates = sw.week_dates(sched, 2026)
    for week, (sha, ts) in EXPECTED.items():
        res = la.select_publication(ledger, git, 2026, week, pd.Timestamp(dates[week][0]).tz_localize("UTC"), main_sha)
        ok = res["status"] == "selected" and res["commit"].startswith(sha) and res["available_by"] == ts
        print(("PASS" if ok else "FAIL") + f" week {week}: {res['status']} {str(res['commit'])[:7]} {res['available_by']}")
        fails += not ok
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Run it**

Run: `.venv/Scripts/python.exe tools/weekly_accuracy_acceptance.py`
Expected: every line starts with `PASS` and the exit code is 0. A `FAIL` on the team codes means the mapping or the
cache is wrong. Report it and do not adjust the threshold.

- [ ] **Step 3: Run the full suites**

Run:
- `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q`
- `for f in tests/*_fixture.cjs; do node "$f" >/dev/null || echo FAIL $f; done`

Expected: everything passes, and the fixture loop prints no `FAIL` line.

- [ ] **Step 4: Commit**

```bash
git add tools/weekly_accuracy_acceptance.py
git commit -m "chore: real-cache acceptance checks for team mapping and 2026 publication selection (spec §7.4)"
```

---

## After the build (controller, owner-gated; not implementer tasks)

1. **Review:** astra reviews spec draft 6 together with this plan (2026-10-09, after 15:33). Fold in its findings.
2. **Merge and first run:**
   - The owner OKs the merge and the push.
   - Dispatch `weekly-accuracy.yml` by hand.
   - Locally, run `--weeks 1-4 --frozen-record models/diagnostics/live_2026_w1-4_reproduction.json --no-fetch`.
   - Account for every divergence from the scratch numbers, as expected by spec §4.5.
   - Commit the record.
3. **Re-measurement and copy:**
   - Run `python -m ffmodel.eval.weekly_consensus_sameweek` once and commit its artifact.
   - Report the verdicts.
   - Apply the §6.7 copy; the owner OKs the push.
