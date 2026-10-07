# Weekly Accuracy and Same-Week Benchmark: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build three things.

- (A) An automated weekly scorecard of the projections the bot pipeline published before each kickoff.
- (A, private) A Sleeper comparator whose report lives only in the private data repository.
- (B) A pre-registered re-measurement of the weekly model-vs-expert benchmark against same-week rankings, with
  verdicts computed in code.

**Architecture:**

- `src/ffmodel/eval/sameweek.py` holds the shared pure primitives:
  - team mapping, schedule dates and the bye-week identity gate;
  - two-stage validation (`prepare` runs stage 1 on the raw tables, then `build_features`; `week_inputs` runs
    stage 2 per week and carries the stage-1 invalid-key mask to scoring);
  - same-week scrape selection, per-week cells, ranking coverage;
  - statistics and decision rules.
- `src/ffmodel/eval/live_accuracy.py` is (A). It enumerates candidate publications from reachable history and every
  ledger target, proves them with a committed push ledger built from GitHub's activity API, and scores them against
  nflverse actuals. A Tuesday workflow runs it.
- `src/ffmodel/eval/sleeper_compare.py` is the §4.8 comparator. A fail-soft job in the same workflow runs it against
  the private repository `mtsilverstein/megatron-private-data`.
- `src/ffmodel/eval/weekly_consensus_sameweek.py` is (B). It runs once, by hand.

**Tech stack:** Python 3.12 (CI) / 3.14 (local), pandas, numpy, scipy (via existing modules), pytest, git CLI,
`gh` CLI, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md`, draft 7.1 (commit 764e6a4). Read
it first: it is the source of truth, and this plan implements it. Its §10 traces every change since draft 6. This
plan's revisions resolve astra's plan findings P1–P7 and the Minors in
`.review/astra-weeklyacc-spec6-plan-response.md`, then S7-I1..I5 and the two Minor leftovers in
`.review/astra-weeklyacc-spec7-plan-response.md` (traced below).

**Verified when this plan was revised (2026-10-07, spec draft 7.1):** every task's code and tests in this plan were
materialised from this file into the real repo paths and run together (`pytest -W error`, `FFMODEL_CACHE_FROZEN=1`,
123 tests passing), and the full suite passed with them in place (1,270 tests: 1,255 with the flag forced on, plus
the 15 cache-mechanism tests in `test_pull.py`/`test_rosters.py`, which set the flag themselves and pass when it is
not forced); the Task 10 acceptance tool
passed offline on the local caches (nine PASS lines: team codes 0 unknown; the four §4.1 publications and the §4.3
archive outcomes, now through the full-ancestry candidate walk); the live `evaluate` path ran end to end on the
frozen local caches for 2026 weeks 1–3 (the local weekly cache ends at week 3) and serialised with
`allow_nan=False`; the current main's neutral payload (2026 week 5, 658 players) passes the full-vector neutral
validation with equivalence max difference 0.005. The (B) driver path was exercised on the 2012–25 caches with a
stand-in predictor only, to prove the code path (no schedule-dependency skips on real 2023–25 data); no (B) result
was computed or recorded.

## Global Constraints

**Repo and environment:**
- Branch `feat/weekly-accuracy`, in the main checkout. Never commit to `main`; never push.
- Run pytest as `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider`. Use `.venv/Scripts/python.exe`
  for all Python.
- Repo is PUBLIC. All test fixtures are synthetic: no real league or manager data, no other managers' names, and
  no third-party projection or odds values.
- Stage files by explicit path only. Never `git add -A`, `git add .` or `git add -f`. In particular, never stage
  anything under `data_snapshots/sleeper_projections/` (an untracked real Sleeper capture lives there; it belongs
  to the private repository).

**What must not change:**
- Do NOT edit `src/ffmodel/eval/weekly_rankings.py`, `src/ffmodel/eval/weekly_consensus.py`,
  `src/ffmodel/data/rankings.py` or `src/ffmodel/data/pull.py`. Import them unchanged.
- Do NOT touch `site/`, `models/prospective/**`, `.github/workflows/prospective-*.yml` or
  `.github/workflows/weekly-update.yml`.
- Tests make no network calls. Git, `gh` and data loading are injected; tests pass fakes.

**Fixed values (copy exactly):**
- Bootstrap: seed `20260728`, `10000` resamples, via `ffmodel.eval.mean_head_gate.paired_bootstrap` (the Sleeper
  comparator re-implements the same resample only to obtain replicate means for p-values).
- Cluster keys are 1-D scalars: `season*100 + week` for ranking cells, `f"{week}|{team}"` and `player_id` for point
  deltas.
- `min_cell=5`; `REPLACEMENT_RANK` comes from `ffmodel.site.draft`.
- Unknown team-code downgrade threshold: `0.02`. Validation threshold: `0.01` on every path (exactly 1% passes).
- Cutoff for week N is `K_N` 00:00 UTC, where `K_N` = the earliest `gameday` of REG week N in the validated games.
  `K_N`/`Z_N` exist only for a week whose schedule slice passes the 1% rule (`ScheduleCheck.dates`).
- Season lower bound `T_S` = `S-06-01T00:00:00Z`. Coverage interval start `"-inf"` only when a complete collection's
  oldest event is the `branch_creation` of `refs/heads/main`.
- Bot identities: publications by `weekly-update-bot`; the accuracy job commits as `weekly-accuracy-bot`.
- PPR weights for neutral re-scoring: `ffmodel.site.leaguelens.effective_weights` of `sleeper_scoring` in
  `configs/formats/f12-1qb-ppr-4.yaml`. Equivalence tolerance: `0.01`.
- Sleeper: relevant-union threshold `8.0` PPR, paired window 24 h, 2026 comparisons start at week 5.
- Team mapping (ranking code → schedule code):
  `{"LAR":"LA","STL":"LA","JAC":"JAX","SD":"LAC","OAK":"LV","LVR":"LV","WSH":"WAS","ARZ":"ARI","BLT":"BAL","CLV":"CLE","HST":"HOU","KCC":"KC","GBP":"GB","NOS":"NO","NEP":"NE","SFO":"SF","TBB":"TB"}`.
  Ignored codes: blank, `FA`.

**Exact strings:**
- Gate states: `contradicted`, `bye_consistent`, `unverified`, `absent`.
- Skip reasons: `overlapping_weeks`, `no_candidate_scrape`, `no_scorable_cell`, `validation_failed`,
  `identity_collision`, `equivalence_failed`, `archive_hash_mismatch`, `archive_identity_mismatch`,
  `publication_evidence_unavailable`, `weeks_unpublished`, `no_archive`, `incomplete_week`, `no_scorable_points`,
  `no_old_protocol_scrape`, `no_sleeper_snapshot`, `snapshot_integrity_failed`, `exploratory_weeks_excluded`,
  `private_inputs_incomplete`.
- Skip detail: `schedule_dependency_failed` (with `validation_failed`, when a schedule slice a computation needs —
  week N, and N−1 for the §5.2 window and overlap guard — fails the 1% rule).
- Protocol versions: `live-accuracy-v1` (Task 6), `sleeper-compare-v1` (Task 7), `sameweek-v1` (Task 9); each
  artifact's `evaluator_version` is built with its own.
- Validation reasons: `conflicting_duplicates`, `nonfinite`, `schedule_join`, `quantile_order`, `missing_gameday`,
  `crosswalk_collision`.
- Labels: `inferred_by_window`, `arbitrary_lexicographic`, `sleeper_timing_advantage`, `different_estimand`.
- Status values: `ok`, `alarm_negative_correlation`; audit conclusions `no_defect`, `defect_found`.
- Verdict values: `insufficient`, `behind`, `ahead`, `not_established`, `established`; Sleeper season-end outcomes
  `ours_lower_error`, `sleeper_lower_error`, `blend_lower_error`, `inconclusive`.
- Reason codes: `interval_includes_zero`, `interval_opposite_side`, `season_inconsistent`,
  `leave_one_season_out_reversal`, `leave_one_season_out_zero`, `sensitivity_absent`, `sensitivity_disagrees`,
  `sensitivity_zero`, `zero_estimate`.

**Precision and serialisation:** verdict inputs are full precision; round only when writing display fields. Every
artifact is written with `json.dumps(..., allow_nan=False)`; undefined metrics are `null`, never NaN.

**Model assignment (CLAUDE.md).** Every task below carries its complete code, tested together when the plan was
written, so every implementer is **sonnet** (transcription: apply, run, commit). Task reviewers are **sonnet** except
where a task line says **opus** (numerics and leak surfaces). No task here is prose-specified; if an implementer
finds a test that does not pass as written, stop and report rather than redesign — that is an opus-level call for the
controller. Tasks 7, 8, 9 and 10 touch disjoint files and may be dispatched in parallel once Task 6 is committed;
Tasks 1–6 are sequential (shared files).

## Review Focus

These inputs are the most likely to break the code. Each has a pinned test in its owning task. Items 1–8 are
astra's findings on the draft-6 plan; items 12–17 are astra's findings on plan b880f9e (S7-I1..I5 and the two
Minor leftovers).

1. **Paginated activity output (P1).** `gh api --paginate --slurp` returns one outer array of pages; a three-page
   response must flatten, a non-array page or a failed fetch must raise. Task 5.
2. **Ledger targets outside main (P2).** An unfetchable `pr_merge` target inside `[available_by, cutoff)` makes the
   week unavailable; a week-N bot payload present only at a `force_push` target is a candidate, so the week is
   `publication_evidence_unavailable`, never `weeks_unpublished`. Task 5.
3. **Absence across missing history (S6-I1).** `weeks_unpublished` only when `[T_S, cutoff)` is fully covered and
   every target in it is fetchable; a complete collection ending at `branch_creation` covers back to `-inf`. Task 5.
4. **Raw duplicates before features (P3).** History `10, 20, 20, 30` with an exact duplicate week-2 row gives
   week-3 `lag4_carries == 15.0`, not `16.67`; a duplicated schedule game neither doubles feature rows nor fails the
   join; a conflicting actuals group stays in the features and is masked from scoring. Task 2, and through the full
   drivers in Tasks 6 and 9. (Item 13 covers a group that is both.)
5. **Archive identity and no promotion (P4).** A correctly hashed file named for week 4 whose payload says week 9 is
   `archive_identity_mismatch`; an archive above 1% invalid is `validation_failed`; neither lets an older archive be
   promoted. The 1% rule also governs the nflverse secondary and the staleness audit's reads. Tasks 3 and 5.
6. **Incomplete equivalence (P5).** An empty neutral list, a missing player or a NaN neutral quantile is
   `equivalence_failed`, never "checked". Task 6.
7. **Empty point pool (P6).** A complete week with zero projection matches is `no_scorable_points` with nulls, no
   warning under `-W error`. Task 6.
8. **Offline acceptance (P7).** Explicit existing cache files, `FFMODEL_CACHE_FROZEN=1`, no sockets. Task 10.
9. **Sleeper identity types.** The crosswalk stores `sleeper_id` as float (`13269.0`), Sleeper sends strings; the
   record `season` is the string `"2026"`; position is under `player.position`; Sleeper omits zero-valued stat keys.
   Task 7.
10. **A Tuesday run before Monday-night stats land.** That week is `incomplete_week`, never scored with partial
    stats. Task 6.
11. **Subprocess cost on Windows.** Git access is batched (`cat-file --batch-check`, `rev-list --ancestry-path
    --stdin`, one `git log` over every off-main ledger target), so the real-repo acceptance completes in about 10 s;
    a per-pair `merge-base` loop took minutes. Task 5.
12. **Commit clocks are not publication times (S7-I1).** An off-main bot commit dated 2026-05-31 and pushed
    2026-09-30 (removed by an Oct 2 force-push) is a candidate and is **selected**; an ancestry with a backdated
    weekly-changing commit between a target and an in-season week-4 commit still finds that commit, so the week is
    `publication_evidence_unavailable`, never `weeks_unpublished`. Candidate enumeration walks full ancestry and
    stops only at visited commits. Task 5.
13. **Mixed exact/conflicting actuals groups (S7-I2).** Carries `10 | 20, 20, 25 | 30`: week 2 is one conflicting
    key, so all three rows stay and week-3 `lag4_carries == 18.75` (not `18.33`), in `prepare` and in the model input
    seen by the (B) driver; nothing is counted as an exact duplicate. Tasks 2 and 9.
14. **A failed prior-week schedule (S7-I3).** Week 1 = a valid Thursday 09-10 game plus a conflicting Monday/Tuesday
    listing; week 2 valid. Week 1 has no dates at all (`ScheduleCheck.dates`), so a 09-11 scrape is never compared
    against week 2: `validation_failed` / `schedule_dependency_failed`, and `L_1 = K_1 − 7` is never used for
    N > 1. Pinned in Task 3 (`sameweek_week`, window and overlap guard), Task 6 (the live secondary) and Task 9 (the
    (B) path).
15. **Neutral validity is never inferred from points (S7-I4).** A NaN in zero-weight `p50.carries` is invalid; two
    records for one player whose vectors differ but score identically are `conflicting_duplicates` (100% of that
    table). Both make equivalence fail; the neutral-only path fails the 1% rule. Task 6.
16. **The private comparator's own vintage (S7-I5).** The public artifact scored a week, but the private pull lacks
    one team's rows: `private_inputs_incomplete`, with the private actuals/schedule/crosswalk/artifact/manifest
    hashes, the selected capture hashes, `sleeper-compare-v1` and `run_at` in `provenance`. Task 7, through `main`.
17. **Reporting leftovers (Minors).** The (B) artifact's `evaluator_version` says `sameweek-v1`; a duplicated
    schedule game's count reaches each week's schedule report and the (B) artifact's validation totals. Tasks 2, 6
    and 9.

### Trace of astra's review of draft 6 and its plan (`.review/astra-weeklyacc-spec6-plan-response.md`)

| Finding | Where it is fixed |
|---|---|
| S6-I1 absence across missing history | Task 5: `season_lower_bound`, `collection_start` (`-inf`), `select_publication` step 5; tests `test_absence_needs_complete_coverage_from_season_lower_bound`, `test_collection_ending_at_branch_creation_covers_back_to_minus_infinity` |
| P1 paginated activity output | Task 5: `fetch_activity` (`--paginate --slurp`, flattened, fail on non-array page); Task 8 workflow; test `test_fetch_activity_flattens_slurped_pages_and_fails_safe` |
| P2 checks inspect only `push` targets | Task 5: `candidate_index` (reachable history + the full ancestry of every ledger target; see S7-I1 below), steps 3–4 over every activity type; tests for the `pr_merge` and `force_push`-target counterexamples |
| P3 validation after transformation | Task 2: `validate_schedule`, `prepare` (collapse before `build_features`, conflicting groups kept and masked), `week_actuals`/`week_inputs`; used by Task 6 `evaluate` and Task 9 `run_sample`; tests incl. `lag4_carries` 15.0 vs 16.67 |
| P4 archive identity and secondary thresholds | Task 5: `_check_archive` (hash, payload season/week, 1% validation) before qualification, no promotion; Task 3: 1% rule on the nflverse secondary and the audit reads; Task 7: on the Sleeper table |
| P5 equivalence can pass incomplete | Task 6: `equivalence` (validated, equal player sets, all three quantiles finite and within 0.01) |
| P6 empty point pool writes NaN | Task 6: `no_scorable_points`, `point_metrics` nulls, `serialise(allow_nan=False)` |
| P7 acceptance tool downloads | Task 10: explicit existing files, `FFMODEL_CACHE_FROZEN=1`, socket-blocked test |
| Minor: `ci_cell` | Cut (spec §3.8); no `pooled_stats` use anywhere |
| Minor: precision fixture bypasses the verdict path | Task 4: `test_full_precision_lower_bound_passes_through_the_verdict_path` |
| Minor: provenance | Task 6: `input_hashes` (every pulled season, bakeoff sha256), archive blob hashes, ledger hash, `evaluator_version` from the executing checkout with `dirty`; Task 9: model fold artifact hashes and `evaluator_version` |
| Minor: retention/coverage detail | Task 3: candidates keep page states, `inferred_by_window`, early-game exclusions by position, `ranking_coverage`; per-game-day and per-page tables cut |
| Minor: per-week ranking values, Markdown "—" | Task 3 `cell_summary`; Task 6 week records and `render_markdown` |
| Minor: alarm procedure | Task 9: `audit_cells`, `check_alarm_audit`, `--alarm-audited` |
| Minor: rebase-then-push | Task 8: `git pull --rebase origin main && git push origin HEAD:main`, three attempts |

**Cut in draft 7 and absent from this plan:** `ci_cell` / `pooled_stats`, the alternative-archive sensitivity, the
`_old_cells` snapshot-change diagnostic (old §5.3), per-game-day retention and per-page coverage tables.

### Trace of astra's review of draft 7 and plan b880f9e (`.review/astra-weeklyacc-spec7-plan-response.md`)

| Finding | Spec 7.1 | Where it is fixed |
|---|---|---|
| S7-I1 ancestry pruned by committer time | §4.1 | Task 5: `candidate_index` walks the full ancestry of every off-main ledger target in one `Git.weekly_commits(tips, exclude=[main])` call (no timestamp pruning; `T_S` only in step 5); `FakeGit._walk` stops only at visited commits; tests `test_pre_june_commit_pushed_in_season_is_selected`, `test_ancestry_with_non_monotone_commit_times_is_walked_completely` |
| S7-I2 mixed exact/conflicting actuals | §3.7 stage 1 | Task 2: `validate_table` finds conflicting keys first and collapses/counts only non-conflicting repeats; `prepare` keeps a conflicting group's whole multiset; tests `test_stage1_mixed_exact_and_conflicting_group_keeps_whole_multiset` (18.75, existing harmless-duplicate test kept) and Task 9 `test_driver_path_keeps_mixed_conflicting_group_in_model_inputs` |
| S7-I3 failed prior-week schedule | §3.7 schedule dependencies, §5.2 | Task 2: `ScheduleCheck.dates`; Task 3: `window_dates_ok`, `overlapping`/`sameweek_window` raise without N−1 (no `L_1` fallback for N > 1), `sameweek_week` skips `validation_failed`/`schedule_dependency_failed`; Tasks 6, 9, 10 take dates from `ScheduleCheck.dates`; tests `test_failed_prior_week_schedule_blocks_window_and_overlap_guard` (Task 3), `test_live_secondary_needs_the_prior_week_schedule` (Task 6), `test_driver_path_failed_prior_week_schedule_is_a_dependency_failure` (Task 9) |
| S7-I4 neutral validated after scoring | §4.1 scored values | Task 6: `_neutral_stats_frame`, `validate_neutral` (full vectors, canonical `vector` in the duplicate signature), `_neutral_projections` (score only valid rows; counts over every key); `published_values` returns the validated table and `equivalence` compares two validations; tests `test_zero_weight_nan_component_invalidates_neutral_row_before_scoring`, `test_same_player_neutral_vectors_that_score_identically_are_conflicting` |
| S7-I5 private run borrows completeness | §4.8.5 | Task 7: `run` re-checks `week_complete` (`private_inputs_incomplete`) and §3.7 on the private pull, applies the projections' 1% rule, and writes `provenance` (`private_input_hashes`, manifest hash, `selected_captures`, `evaluator_version` with `sleeper-compare-v1`, `run_at`); `_load_inputs` returns the raw private pull; test `test_private_vintage_missing_team_is_private_inputs_incomplete_with_provenance` (through `main`) |
| Minor: evaluator label | §6.6 | Task 6: `evaluator_version(git, protocol)`; Task 9: `evaluator` (`sameweek-v1`), test `test_evaluator_version_uses_the_sameweek_protocol`; Task 7 uses `sleeper-compare-v1` |
| Minor: schedule duplicate count lost | §3.7 schedule | Task 2: `ScheduleCheck.duplicates_by_week`, added in `week_validation`; tests in `test_exact_duplicate_schedule_game_collapses_without_error` and Task 9 `test_schedule_duplicate_count_reaches_the_artifact` |

---

## File Structure

| File | Responsibility |
|---|---|
| `src/ffmodel/eval/sameweek.py` (create) | Pure primitives: team mapping, dates, gate, two-stage validation, consensus matching, same-week selection, cells, coverage, stats, rules |
| `src/ffmodel/eval/live_accuracy.py` (create) | (A): activity fetch, ledger, git adapter, candidate enumeration, publication/archive evidence, published values, point and ranking metrics, artifact, markdown, CLI |
| `src/ffmodel/eval/sleeper_compare.py` (create) | §4.8 private comparator: snapshot choice, Sleeper validation and re-score, metrics, season-end read, CLI |
| `src/ffmodel/eval/weekly_consensus_sameweek.py` (create) | (B): sample runner, staleness audit, verdicts, alarm audit, provenance, CLI |
| `.github/workflows/weekly-accuracy.yml` (create) | Tuesday/Wednesday public job and the fail-soft private job |
| `models/diagnostics/main_push_ledger.json` (create) | Ledger seeded from the 2026-10-06 activity capture |
| `tools/build_push_ledger_seed.py` (create) | One-shot converter from the raw seed to the ledger |
| `tools/weekly_accuracy_acceptance.py` (create) | Offline real-cache acceptance checks |
| `tests/test_sameweek_gate.py`, `tests/test_sameweek_validation.py`, `tests/test_sameweek_selection.py`, `tests/test_sameweek_rules.py`, `tests/test_live_accuracy_evidence.py`, `tests/test_live_accuracy_metrics.py`, `tests/test_sleeper_compare.py`, `tests/test_weekly_accuracy_workflow.py`, `tests/test_weekly_consensus_sameweek.py`, `tests/test_weekly_accuracy_acceptance.py` (create) | Tests |

---

### Task 1: sameweek — team mapping, schedule dates, bye-week gate

**Model:** implementer sonnet (transcription); reviewer sonnet.

**Files:**
- Create: `src/ffmodel/eval/sameweek.py`
- Test: `tests/test_sameweek_gate.py`

**Interfaces:**
- Produces:
  - `POSITIONS: tuple[str, ...]`, `TEAM_TO_SCHEDULE: dict[str, str]`, `IGNORED_TEAM_CODES`, `UNKNOWN_CODE_LIMIT = 0.02`
  - `map_team(code) -> str | None`
  - `week_dates(schedules, season) -> dict[int, tuple[pd.Timestamp, pd.Timestamp]]` (week → (K, Z), normalised
    dates; callers pass the validated games from Task 2)
  - `season_teams(schedules, season) -> set[str]`, `week_teams(schedules, season, week) -> set[str]`
  - `bye_teams(schedules, season, week) -> set[str]` (empty for week < 1)
  - `page_state(R, A, B) -> str`
  - `GateResult` (dataclass: `state`, `pages`, `unknown_team_codes`, `rows`)
  - `gate(snapshot, schedules, season, week) -> GateResult`

- [ ] **Step 1: Write the failing tests**

```python
"""Offline tests for the same-week primitives: team mapping, dates, bye gate (spec §3.1, §3.4, §3.5)."""
import pandas as pd
import pytest

from ffmodel.data.pull import normalize_schedule_teams
from ffmodel.eval import sameweek as sw


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
    legacy = pd.DataFrame({"home_team": ["STL", "SD", "OAK"], "away_team": ["LA", "LAC", "LV"]})
    normalized = normalize_schedule_teams(legacy)
    assert set(normalized["home_team"]) == {"LA", "LAC", "LV"}          # the schedule side of the mapping
    schedule_codes = {
        "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
        "LA", "LAC", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS"}
    assert set(sw.TEAM_TO_SCHEDULE.values()) <= schedule_codes
    assert sw.map_team("LAR") == "LA" and sw.map_team("JAC") == "JAX"
    assert sw.map_team("FA") is None and sw.map_team("") is None and sw.map_team(None) is None
    assert sw.map_team("buf") == "BUF"


def test_unknown_code_counted_and_contributes_no_presence():
    s = _season()
    snap = _snap({p: ["AAA", "BBB", "EEE", "FFF"] for p in sw.POSITIONS})
    junk = snap.head(1).assign(team="ZZZ", fp_id="junk")
    g = sw.gate(pd.concat([snap, junk], ignore_index=True), s, 2024, 3)
    assert g.unknown_team_codes == 1


def test_week_dates_and_byes():
    s = _season()
    d = sw.week_dates(s, 2024)
    assert d[1] == (pd.Timestamp("2024-09-05"), pd.Timestamp("2024-09-09"))
    assert sw.bye_teams(s, 2024, 2) == {"EEE", "FFF"}
    assert sw.bye_teams(s, 2024, 0) == set()
    assert sw.week_teams(s, 2024, 2) == {"AAA", "BBB", "CCC", "DDD"}


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


def test_week_identity_gate_states():
    s = _season()
    fresh = {p: ["AAA", "BBB", "EEE", "FFF"] for p in sw.POSITIONS}            # week 3: CCC/DDD bye, EEE/FFF back
    assert sw.gate(_snap(fresh), s, 2024, 3).state == "bye_consistent"
    mixed = dict(fresh, RB=["AAA", "BBB", "CCC", "DDD"])                       # RB page stale, WR page fresh
    g = sw.gate(_snap(mixed), s, 2024, 3)
    assert g.state == "contradicted" and g.pages["RB"] == "contradicted" and g.pages["WR"] == "bye_consistent"
    absent = {p: t for p, t in fresh.items() if p != "TE"}
    assert sw.gate(_snap(absent), s, 2024, 3).state == "unverified"           # absent page with B != empty
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
    # week 4 has no byes (A empty); a page listing the week-3 returners (EEE/FFF) still passes
    s = _season()
    other_week = _snap({p: ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"] for p in sw.POSITIONS})
    assert sw.gate(other_week, s, 2024, 4).state == "bye_consistent"
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_gate.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'ffmodel.eval.sameweek'`.

- [ ] **Step 3: Implement**

```python
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

### Task 2: sameweek — two-stage validation and consensus matching

**Model:** implementer sonnet (transcription); reviewer **opus** (leak surface: what reaches `build_features`).

**Files:**
- Modify: `src/ffmodel/eval/sameweek.py` (replace the import block, append)
- Test: `tests/test_sameweek_validation.py`

**Interfaces:**
- Consumes: Task 1; `ffmodel.data.features.build_features`; `ffmodel.data.rankings.attach_gsis` (unchanged).
- Produces:
  - `VALIDATION_LIMIT = 0.01`, `ACTUALS_KEY`, `ACTUALS_ELIGIBILITY`, `SIDE_KEY`, `GAME_SIGNATURE`
  - `TableValidation` (dataclass)
    - fields: `valid: pd.DataFrame`, `invalid: dict[str, set[tuple]]`, `n_keys: int`, `exact_duplicates: int`,
      `key_position: dict`
    - methods: `invalid_keys() -> set`, `excluded_fraction() -> float`, `fails() -> bool`, `report() -> dict`
      (counts per reason, per reason and position, `excluded_fraction`, `failed`)
  - `validate_table(df, key, evaluated, eligibility, extra_invalid=None, position_col=None, preinvalid=None) -> TableValidation`
  - `explode_sides(games) -> pd.DataFrame` (one row per `(season, week, team)`; `opponent` identifies the game,
    plus `game_id` when the schedule carries one)
  - `ScheduleCheck` (dataclass: `games`, `sides`, `valid_games`, `duplicate_games`, `duplicates_by_week`;
    methods `game_date(season, week) -> dict[str, pd.Timestamp]`, `week_validation(season, week) -> TableValidation`
    (its `exact_duplicates` carries that week's collapsed duplicate games),
    `dates(season) -> dict[int, tuple[pd.Timestamp, pd.Timestamp]]` (K_N/Z_N only for weeks whose slice passes;
    every caller that needs schedule dates uses this, never `week_dates(valid_games, ...)` directly))
  - `validate_schedule(schedules) -> ScheduleCheck`
  - `Prepared` (dataclass: `features`, `schedule: ScheduleCheck`, `actuals: TableValidation` (stage-1 mask in
    `.invalid`), `exact_by_week`)
  - `prepare(weekly_raw, schedules_raw, build=build_features) -> Prepared` — stage 1, then `build_features`
  - `week_actuals(prep, season, week) -> TableValidation` — stage 2; `valid` keeps the features index
  - `week_inputs(prep, season, week) -> dict` with keys `actuals`, `schedule`, `failed`, `report`
  - `validate_projections(df) -> TableValidation` (columns `player_id, team, position, p10, p50, p90`)
  - `validate_consensus(snap) -> TableValidation` (nflverse rows; key `fp_id`)
  - `ConsensusMatch` (dataclass: `matched`, `stats`, `reason`), `match_consensus(snapshot_valid, crosswalk)`

Design notes (spec §3.7, astra P3, S7-I2, S7-I3):
- Conflicting keys are identified **first**, over the raw multiset (`validate_table`). Exact duplicate rows are
  collapsed, and counted, only within keys that are not conflicting; `prepare` and `validate_schedule` do this
  **before** `build_features`. A conflicting actuals group keeps its whole multiset, repeats included (rows
  20, 20, 25 stay three rows), and it and a non-finite row stay in the `build_features` input exactly as pulled, so
  model inputs match the original measurements; their keys go into the mask that stage 2 applies to scoring.
- A conflicting schedule side is kept in `games` (the feature input and the bye sets) on the same principle, but it
  is invalid: its teams have no `game_date`, their actuals rows fail `schedule_join`, the week's schedule table fails
  the 1% rule, and `valid_games` excludes the game.
- `ScheduleCheck.dates(season)` is the only source of `K_N`/`Z_N`: a week whose schedule slice fails the 1% rule
  has no dates at all, never dates taken from its surviving games. Task 3 builds the N−1 dependency on it.
- The per-week count of collapsed duplicate games is carried into `week_validation(...).exact_duplicates`, so it
  reaches every artifact's schedule report.
- `pull_schedules` carries no `game_id`, so a side's game is identified by `gameday` and `opponent` (plus
  `game_id` when present).

- [ ] **Step 1: Write the failing tests**

```python
"""Spec §3.7 two-stage validation, masking and identity-collision handling. Synthetic data only."""
import numpy as np
import pandas as pd
import pytest

from ffmodel.data.features import build_features
from ffmodel.eval import sameweek as sw
from ffmodel.scoring import PREDICTED_STATS


def _cons(rows):
    return pd.DataFrame(rows, columns=["fp_id", "player", "pos", "team", "ecr", "sd", "mergename", "scrape_date"])


def _weekly(rows):
    """Canonical weekly rows as pull_weekly returns them; unspecified stats are zero."""
    base = {"player_id": "p1", "player_display_name": "P One", "position": "RB", "team": "AAA",
            "opponent_team": "BBB", "season": 2023, "week": 1, "target_share": np.nan, "snap_pct": np.nan,
            "fantasy_points_ppr": 0.0, "two_point_conversions": 0, "special_teams_tds": 0, "attempts": 0.0,
            "receiving_air_yards": 0.0, "passing_air_yards": 0.0, **{s: 0.0 for s in PREDICTED_STATS}}
    return pd.DataFrame([{**base, **r} for r in rows])


def _games(weeks=4, season=2023):
    days = pd.date_range(f"{season}-09-10", periods=weeks, freq="7D")
    return pd.DataFrame({"season": season, "week": range(1, weeks + 1), "gameday": days.strftime("%Y-%m-%d"),
                         "home_team": "AAA", "away_team": "BBB"})


def test_exact_duplicates_collapse_and_conflicts_invalidate_group():
    d = pd.Timestamp("2022-12-30")
    snap = _cons([
        ("1", "A", "RB", "AAA", 1.0, 1.0, "a", d), ("1", "A", "RB", "AAA", 1.0, 1.0, "a", d),       # exact dup
        ("2", "Felton", "RB", "BBB", 113.2, 1.0, "felton", d), ("2", "Felton", "WR", "BBB", 163.6, 1.0, "felton", d),
        ("3", "C", "WR", "CCC", 5.0, 1.0, "c", d),
    ])
    v = sw.validate_consensus(snap)
    assert v.exact_duplicates == 1
    assert v.invalid["conflicting_duplicates"] == {("2",)}
    assert sorted(v.valid["fp_id"]) == ["1", "3"]
    assert v.n_keys == 3 and v.excluded_fraction() == pytest.approx(1 / 3)
    assert v.report()["invalid_by_reason_position"] == {"conflicting_duplicates": {"RB": 1}}


def test_threshold_exactly_one_percent_passes_just_above_fails():
    d = pd.Timestamp("2024-09-20")
    rows = [(str(i), f"p{i}", "WR", "AAA", float(i), 1.0, f"p{i}", d) for i in range(100)]
    rows[0] = ("0", "p0", "WR", "AAA", float("nan"), 1.0, "p0", d)                      # 1 of 100 invalid
    v = sw.validate_consensus(_cons(rows))
    assert v.excluded_fraction() == 0.01 and not v.fails()
    rows[1] = ("1", "p1", "WR", "AAA", float("inf"), 1.0, "p1", d)
    assert sw.validate_consensus(_cons(rows)).fails()
    assert sw.validate_consensus(_cons([])).excluded_fraction() == 0.0                # empty table: fraction 0


def test_key_failing_several_rules_counted_once():
    d = pd.Timestamp("2024-09-20")
    snap = _cons([("1", "A", "RB", "AAA", np.nan, 1.0, "a", d), ("1", "A", "RB", "AAA", 2.0, 1.0, "a", d),
                  ("2", "B", "RB", "AAA", 3.0, 1.0, "b", d)])
    v = sw.validate_consensus(snap)
    assert v.invalid_keys() == {("1",)} and v.excluded_fraction() == pytest.approx(0.5)


def test_nonfinite_only_in_evaluated_fields():
    d = pd.Timestamp("2024-09-20")
    snap = _cons([("1", "A", "RB", "AAA", 1.0, np.nan, "a", d)])                       # sd is not evaluated
    assert sw.validate_consensus(snap).invalid == {}


def test_projection_quantile_order():
    df = pd.DataFrame({"player_id": ["a", "b"], "team": ["AAA", "AAA"], "position": ["WR", "WR"],
                       "p10": [1.0, 5.0], "p50": [2.0, 4.0], "p90": [3.0, 6.0]})
    assert sw.validate_projections(df).invalid["quantile_order"] == {("b",)}


def test_stage1_exact_duplicate_collapses_before_features():
    # astra P3: carries 10, 20, 20(duplicate of week 2), 30 -> week-3 lag4_carries must be 15.0, not 16.67
    rows = [{"week": 1, "carries": 10.0}, {"week": 2, "carries": 20.0}, {"week": 2, "carries": 20.0},
            {"week": 3, "carries": 30.0}]
    weekly = _weekly(rows)
    assert build_features(weekly, _games())[lambda f: f["week"] == 3]["lag4_carries"].iloc[0] == pytest.approx(50 / 3)
    prep = sw.prepare(weekly, _games())
    wk3 = prep.features[prep.features["week"] == 3]
    assert len(wk3) == 1 and wk3["lag4_carries"].iloc[0] == pytest.approx(15.0)
    v2 = sw.week_actuals(prep, 2023, 2)
    assert v2.exact_duplicates == 1 and v2.invalid == {} and len(v2.valid) == 1


def test_stage1_mixed_exact_and_conflicting_group_keeps_whole_multiset():
    # astra S7-I2: week 2 carries 20, 20, 25 is ONE conflicting key; conflicts are found first, so its repeated 20
    # is not collapsed. Week-3 lag4_carries over 10, 20, 20, 25 = 18.75 (collapsing first would give 18.33).
    rows = [{"week": 1, "carries": 10.0}, {"week": 2, "carries": 20.0}, {"week": 2, "carries": 20.0},
            {"week": 2, "carries": 25.0}, {"week": 3, "carries": 30.0}]
    weekly = _weekly(rows)
    assert build_features(weekly, _games())[lambda f: f["week"] == 3]["lag4_carries"].iloc[0] == pytest.approx(18.75)
    prep = sw.prepare(weekly, _games())
    assert len(prep.features[prep.features["week"] == 2]) == 3                         # whole multiset kept
    assert prep.features[prep.features["week"] == 3]["lag4_carries"].iloc[0] == pytest.approx(18.75)
    assert prep.exact_by_week == {} and prep.actuals.exact_duplicates == 0             # nothing was collapsed
    v2 = sw.week_actuals(prep, 2023, 2)
    assert v2.invalid == {"conflicting_duplicates": {(2023, 2, "p1")}} and v2.exact_duplicates == 0
    v3 = sw.week_actuals(prep, 2023, 3)
    assert v3.invalid == {} and len(v3.valid) == 1                                     # week 3 is scorable


def test_stage1_conflicting_actuals_stay_in_features_and_are_masked():
    rows = [{"week": 1, "carries": 10.0}, {"week": 2, "carries": 20.0}, {"week": 2, "carries": 25.0},
            {"week": 3, "carries": 30.0}]
    prep = sw.prepare(_weekly(rows), _games())
    assert len(prep.features[prep.features["week"] == 2]) == 2                         # both rows kept as inputs
    wk3 = prep.features[prep.features["week"] == 3]
    assert wk3["lag4_carries"].iloc[0] == pytest.approx(55 / 3)                       # model inputs unchanged
    assert prep.actuals.invalid["conflicting_duplicates"] == {(2023, 2, "p1")}
    v2 = sw.week_actuals(prep, 2023, 2)
    assert v2.invalid_keys() == {(2023, 2, "p1")} and v2.valid.empty and v2.fails()
    assert not sw.week_actuals(prep, 2023, 3).invalid                                  # mask is per week only


def test_stage1_nonfinite_actual_masked_but_kept():
    rows = [{"week": 1, "carries": 10.0}, {"week": 2, "carries": np.nan}, {"week": 3, "carries": 30.0}]
    prep = sw.prepare(_weekly(rows), _games())
    assert len(prep.features) == 3
    assert sw.week_actuals(prep, 2023, 2).invalid == {"nonfinite": {(2023, 2, "p1")}}


def test_exact_duplicate_schedule_game_collapses_without_error():
    games = pd.concat([_games(), _games().iloc[[1]]], ignore_index=True)              # week 2 listed twice
    rows = [{"week": w, "carries": 5.0} for w in (1, 2, 3)]
    prep = sw.prepare(_weekly(rows), games)
    assert prep.schedule.duplicate_games == 1 and len(prep.features) == 3             # no row doubled
    assert prep.schedule.duplicates_by_week == {(2023, 2): 1}
    assert prep.schedule.game_date(2023, 2)["AAA"] == pd.Timestamp("2023-09-17")
    wi = sw.week_inputs(prep, 2023, 2)
    assert not wi["failed"] and wi["actuals"].invalid == {}
    assert wi["report"]["schedule"]["exact_duplicates"] == 1                           # the count reaches the report
    assert sw.week_inputs(prep, 2023, 1)["report"]["schedule"]["exact_duplicates"] == 0


def test_conflicting_schedule_side_keeps_its_repeated_rows_uncounted():
    g = _games()
    games = pd.concat([g, g.iloc[[1]], g.iloc[[1]].assign(gameday="2023-09-18")], ignore_index=True)
    sc = sw.validate_schedule(games)                                                  # conflicts found first
    assert len(sc.games) == 6 and sc.duplicate_games == 0 and sc.duplicates_by_week == {}
    assert sc.week_validation(2023, 2).invalid_keys() == {(2023, 2, "AAA"), (2023, 2, "BBB")}


def test_conflicting_schedule_side_invalidates_side_and_masks_players():
    games = pd.concat([_games(), _games().iloc[[1]].assign(gameday="2023-09-18")], ignore_index=True)
    rows = [{"week": w, "carries": 5.0} for w in (1, 2, 3)]
    prep = sw.prepare(_weekly(rows), games)
    assert "AAA" not in prep.schedule.game_date(2023, 2)
    wi = sw.week_inputs(prep, 2023, 2)
    assert wi["schedule"].invalid["conflicting_duplicates"] == {(2023, 2, "AAA"), (2023, 2, "BBB")}
    assert wi["actuals"].invalid["schedule_join"] == {(2023, 2, "p1")} and wi["failed"]
    assert 2 not in sw.week_dates(prep.schedule.valid_games, 2023)
    assert sorted(prep.schedule.dates(2023)) == [1, 3, 4]                              # K_2/Z_2 undefined


def test_match_consensus_flags_identity_collision():
    d = pd.Timestamp("2024-09-20")
    snap = _cons([("10", "Same Guy", "RB", "AAA", 5.0, 1.0, "same guy", d),
                  ("11", "Same Guy", "RB", "AAA", 5.0, 1.0, "same guy", d)])          # two keys, one player
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
Expected: FAIL with `AttributeError: module 'ffmodel.eval.sameweek' has no attribute 'validate_consensus'`.

- [ ] **Step 3: Implement**

Replace the import block at the top of `sameweek.py` (everything from `from __future__ import annotations` to
`import pandas as pd`) with:

```python
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ffmodel.data.features import build_features
from ffmodel.data.rankings import attach_gsis
from ffmodel.scoring import PREDICTED_STATS
```

Then append:

```python
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_validation.py tests/test_sameweek_gate.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/sameweek.py tests/test_sameweek_validation.py
git commit -m "feat(sameweek): two-stage validation (raw collapse before features, carried mask), 1% threshold, collision skip (spec §3.7)"
```

---

### Task 3: sameweek — same-week selection, population, cells, staleness audit, coverage

**Model:** implementer sonnet (transcription); reviewer sonnet.

**Files:**
- Modify: `src/ffmodel/eval/sameweek.py` (replace the import block, append)
- Test: `tests/test_sameweek_selection.py`

**Interfaces:**
- Consumes: Tasks 1–2; `ffmodel.eval.weekly_rankings.score_week`, `weekly_snapshot`; `ffmodel.site.draft.REPLACEMENT_RANK`.
- Produces (every `dates` argument is `ScheduleCheck.dates(season)`):
  - `window_dates_ok(dates, week) -> bool` (weeks N−1 and N both have validated dates; week 1 needs only itself)
  - `overlapping(dates, week) -> bool` (raises `ValueError("schedule_dependency_failed: ...")` without them)
  - `sameweek_window(dates, week) -> tuple[pd.Timestamp, pd.Timestamp]`, the half-open `[L, U)`; `L_1 = K_1 − 7 days`
    for week 1 only, and the same `ValueError` for N > 1 without week N−1's dates (astra S7-I3)
  - `select_sameweek_scrape(rankings, sc: ScheduleCheck, season, week, dates) -> dict`
    - keys: `scrape_date` (Timestamp | None), `gate` (GateResult | None), `candidates` (list of dicts with `date`,
      `state`, `has_later_game`, `pages`, `unknown_team_codes`)
  - `build_cells(pool, season, week, gate_state) -> tuple[list[dict], int]`
    - `pool` columns: `player_id, position, our_pts, ecr, actual`; returns finite cells and the degenerate count
  - `cell_summary(cells) -> list[dict]` (`position, n, sp_ours, sp_con, delta` — the per-week values artifacts keep)
  - `sameweek_week(played, sc, rankings, crosswalk, season, week, dates) -> dict`
    - `played` columns: `player_id, position, team, our_pts, actual` (validated rows only)
    - keys: `status` (`"scored"` | `"skipped"`), `reason`, `selection` (with `label` = `inferred_by_window` for an
      unverified week, and every candidate's page states), `cells`, `degenerate`, `validation`, `match`, `retention`
    - checks `window_dates_ok` first: without it, `reason` is `validation_failed` and `detail` is
      `schedule_dependency_failed`, before the overlap guard and before any scrape is considered
  - `staleness_audit_week(rankings, sc, season, week, dates) -> dict`
    - keys: `week`, `kickoff`, `scrape_date`, `state`, `reason` (`no_old_protocol_scrape` | `validation_failed` |
      None), `discriminating`
  - `ranking_coverage(raw, rankings, seasons) -> dict` (spec §3.6: raw vs accepted rows, `excluded_legacy_schema`,
    scrape dates with weekdays, per season)

- [ ] **Step 1: Write the failing tests**

```python
"""Spec §5.2 same-week selection (metadata only), population filter, cells, audit and coverage."""
import numpy as np
import pandas as pd
import pytest

from ffmodel.eval import sameweek as sw
from ffmodel.eval.weekly_rankings import weekly_snapshot

POS = sw.POSITIONS


def _sched(extra=()):
    # 2024. wk1 Thu 09-05 .. Mon 09-09; wk2 Thu 09-12 .. Sun 09-15 (EEE/FFF bye); wk3 Sat 09-21 .. Sun 09-22 (CCC/DDD bye)
    rows = [(2024, 1, "2024-09-05", "AAA", "BBB"), (2024, 1, "2024-09-08", "CCC", "DDD"), (2024, 1, "2024-09-09", "EEE", "FFF"),
            (2024, 2, "2024-09-12", "AAA", "BBB"), (2024, 2, "2024-09-15", "CCC", "DDD"),
            (2024, 3, "2024-09-21", "AAA", "BBB"), (2024, 3, "2024-09-22", "EEE", "FFF"), *extra]
    return pd.DataFrame(rows, columns=["season", "week", "gameday", "home_team", "away_team"])


def _sc(extra=()):
    return sw.validate_schedule(_sched(extra))


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


def _played(teams, seed=0):
    rng = np.random.default_rng(seed)
    rows = [{"player_id": f"g-{t}{pos}{i}", "position": pos, "team": t, "our_pts": float(rng.normal()),
             "actual": float(rng.normal())} for t in teams for pos in POS for i in range(3)]
    return pd.DataFrame(rows)


def test_window_and_overlap():
    d = sw.week_dates(_sched(), 2024)
    assert sw.sameweek_window(d, 1) == (pd.Timestamp("2024-08-29"), pd.Timestamp("2024-09-09"))   # L_1 = K_1 - 7
    assert sw.sameweek_window(d, 2) == (pd.Timestamp("2024-09-10"), pd.Timestamp("2024-09-15"))
    assert sw.sameweek_window(d, 3) == (pd.Timestamp("2024-09-16"), pd.Timestamp("2024-09-22"))  # Sat-first week admits Fri
    assert not sw.overlapping(d, 2)
    late = dict(d)
    late[1] = (d[1][0], pd.Timestamp("2024-09-12"))
    assert sw.overlapping(late, 2)


def _prior_week_conflict():
    # astra S7-I3: week 1 = a valid Thursday 09-10 game plus CCC-DDD listed on Monday 09-14 AND Tuesday 09-15
    # (conflicting); week 2 = Thursday 09-17 and Sunday 09-20, valid. One Friday 09-11 scrape.
    rows = [(2026, 1, "2026-09-10", "AAA", "BBB"), (2026, 1, "2026-09-14", "CCC", "DDD"),
            (2026, 1, "2026-09-15", "CCC", "DDD"), (2026, 2, "2026-09-17", "AAA", "BBB"),
            (2026, 2, "2026-09-20", "CCC", "DDD")]
    sc = sw.validate_schedule(pd.DataFrame(rows, columns=["season", "week", "gameday", "home_team", "away_team"]))
    return sc, pd.DataFrame(_rank_rows("2026-09-11", ["AAA", "BBB", "CCC", "DDD"]))


def test_failed_prior_week_schedule_blocks_window_and_overlap_guard():
    sc, r = _prior_week_conflict()
    assert sc.week_validation(2026, 1).fails() and not sc.week_validation(2026, 2).fails()
    surviving = sw.week_dates(sc.valid_games, 2026)
    assert surviving[1] == (pd.Timestamp("2026-09-10"), pd.Timestamp("2026-09-10"))   # what the defect used as Z_1
    d = sc.dates(2026)
    assert sorted(d) == [2]                                                    # K_1/Z_1 undefined, not "Thursday"
    with pytest.raises(ValueError, match="schedule_dependency_failed"):
        sw.sameweek_window(d, 2)                                               # never the K_2 - 7 days fallback
    with pytest.raises(ValueError, match="schedule_dependency_failed"):
        sw.overlapping(d, 2)
    assert not sw.window_dates_ok(d, 2) and not sw.window_dates_ok(d, 1)
    played = _played(["AAA", "BBB", "CCC", "DDD"])
    defect = sw.sameweek_week(played, sc, r, _crosswalk(r), 2026, 2, surviving)  # the reproduction's input
    assert defect["status"] == "scored" and len(defect["cells"]) == 4           # 09-11 admitted: why dates() gates
    res = sw.sameweek_week(played, sc, r, _crosswalk(r), 2026, 2, d)
    assert res["status"] == "skipped" and res["reason"] == "validation_failed"
    assert res["detail"] == "schedule_dependency_failed" and res["cells"] == []


def test_final_week_window_is_bounded():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    after = pd.DataFrame(_rank_rows("2024-09-27", ["AAA", "BBB", "EEE", "FFF"]))      # a later (next-season-like) scrape
    sel = sw.select_sameweek_scrape(pd.concat([r, after], ignore_index=True), s, 2024, 3, d)
    assert pd.Timestamp("2024-09-27") not in {c["date"] for c in sel["candidates"]}


def test_selection_is_latest_noncontradicted_and_old_protocol_is_stale():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    sel = sw.select_sameweek_scrape(r, s, 2024, 3, d)
    assert sel["scrape_date"] == pd.Timestamp("2024-09-20") and sel["gate"].state == "bye_consistent"
    old2 = weekly_snapshot(r, pd.Timestamp(d[2][0]))          # regression record: old protocol picks week 1's list
    assert old2["scrape_date"].iloc[0] == pd.Timestamp("2024-09-06")
    audit = sw.staleness_audit_week(r, s, 2024, 2, d)
    assert audit["state"] == "contradicted" and audit["discriminating"] is False  # week-1 byes empty


def test_contradicted_latest_is_passed_over_by_metadata():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    stale_late = pd.DataFrame(_rank_rows("2024-09-14", ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]))  # lists wk2 byes
    sel = sw.select_sameweek_scrape(pd.concat([r, stale_late], ignore_index=True), s, 2024, 2, d)
    states = {c["date"]: c["state"] for c in sel["candidates"]}
    assert states[pd.Timestamp("2024-09-14")] == "contradicted"
    assert sel["scrape_date"] == pd.Timestamp("2024-09-13")
    assert all("pages" in c and "unknown_team_codes" in c for c in sel["candidates"])   # every candidate recorded


def test_population_filter_and_no_fallback():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    cw = _crosswalk(r)
    played = _played(["AAA", "BBB", "CCC", "DDD"])
    res = sw.sameweek_week(played, s, r, cw, 2024, 2, d)
    # scrape 09-13 (Fri): AAA/BBB played Thu 09-12 -> excluded; CCC/DDD Sun 09-15 kept
    assert res["status"] == "scored" and res["retention"]["excluded_early_game"] == 24
    assert res["retention"]["pool"] == 24 and res["selection"]["label"] is None
    thu_only = played[played["team"].isin(["AAA", "BBB"])]
    res2 = sw.sameweek_week(thu_only, s, r, cw, 2024, 2, d)
    assert res2["status"] == "skipped" and res2["reason"] == "no_scorable_cell"
    assert res2["selection"]["scrape_date"] == "2024-09-13"                    # no fallback to an earlier scrape


def test_saturday_game_excluded_with_saturday_scrape_kept_with_friday():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    cw = _crosswalk(r)
    played = _played(["AAA", "BBB", "EEE", "FFF"])
    fri = sw.sameweek_week(played, s, r, cw, 2024, 3, d)                       # Friday 09-20 scrape
    assert fri["retention"]["excluded_early_game"] == 0
    sat = pd.DataFrame(_rank_rows("2024-09-21", ["AAA", "BBB", "EEE", "FFF"]))
    res = sw.sameweek_week(played, s, pd.concat([r, sat], ignore_index=True), _crosswalk(pd.concat([r, sat])),
                           2024, 3, d)
    assert res["selection"]["scrape_date"] == "2024-09-21" and res["retention"]["excluded_early_game"] == 24


def test_postponed_game_date_is_honoured():
    moved = _sched()
    moved.loc[moved["gameday"] == "2024-09-12", "gameday"] = "2024-09-16"     # AAA-BBB postponed to Monday
    s = sw.validate_schedule(moved)
    d = s.dates(2024)
    r = _rankings()
    res = sw.sameweek_week(_played(["AAA", "BBB", "CCC", "DDD"]), s, r, _crosswalk(r), 2024, 2, d)
    assert res["retention"]["excluded_early_game"] == 0


def test_sign_of_both_spearmans_is_higher_is_better():
    # our_pts is higher-is-better and ecr lower-is-better: perfect forecasts on both sides score +1, never -1
    pool = pd.DataFrame({"player_id": [f"p{i}" for i in range(6)], "position": ["WR"] * 6,
                         "our_pts": [6, 5, 4, 3, 2, 1], "ecr": [1, 2, 3, 4, 5, 6], "actual": [60, 50, 40, 30, 20, 10]})
    cells, _ = sw.build_cells(pool, 2024, 2, "unverified")
    assert cells[0]["sp_ours"] == 1.0 and cells[0]["sp_con"] == 1.0


def test_build_cells_flags_and_degenerate():
    pool = pd.DataFrame({"player_id": [f"p{i}" for i in range(6)], "position": ["TE"] * 6,
                         "our_pts": [1, 2, 3, 4, 5, 6], "ecr": [1, 2, 3, 4, 5, 6], "actual": [6, 5, 4, 3, 2, 1]})
    cells, degenerate = sw.build_cells(pool, 2024, 2, "bye_consistent")
    assert len(cells) == 1 and cells[0]["n_le_slots"] is True and cells[0]["gate_state"] == "bye_consistent"
    assert sw.cell_summary(cells)[0]["delta"] == cells[0]["sp_ours"] - cells[0]["sp_con"]
    cells2, degenerate2 = sw.build_cells(pool.assign(actual=1.0), 2024, 2, "unverified")
    assert cells2 == [] and degenerate2 == 1
    assert sw.build_cells(pool.head(0), 2024, 2, "unverified") == ([], 0)


def test_secondary_path_above_threshold_skips_never_runs_on_subset():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    bad = r.copy()
    hit = bad.index[bad["scrape_date"] == pd.Timestamp("2024-09-13")][:2]
    bad.loc[hit, "ecr"] = np.nan                                              # 2 of 48 keys invalid > 1%
    res = sw.sameweek_week(_played(["AAA", "BBB", "CCC", "DDD"]), s, bad, _crosswalk(r), 2024, 2, d)
    assert res["status"] == "skipped" and res["reason"] == "validation_failed" and res["cells"] == []


def test_audit_read_obeys_threshold():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    bad = r.copy()
    hit = bad.index[bad["scrape_date"] == pd.Timestamp("2024-09-06")][:2]
    bad.loc[hit, "ecr"] = np.nan
    audit = sw.staleness_audit_week(bad, s, 2024, 2, d)
    assert audit["state"] is None and audit["reason"] == "validation_failed"


def test_ranking_coverage_counts_legacy_and_weekdays():
    raw = pd.DataFrame({"ecr_type": ["wp"] * 3, "pos": ["RB"] * 3, "page_type": ["weekly-offense", "weekly-rb", "weekly-rb"],
                        "scrape_date": ["2020-09-10", "2020-10-16", "2020-10-16"]})
    acc = pd.DataFrame({"scrape_date": pd.to_datetime(["2020-10-16", "2020-10-16"])})
    cov = sw.ranking_coverage(raw, acc, [2020])["2020"]
    assert cov["raw_rows"] == 3 and cov["accepted_rows"] == 2 and cov["excluded_legacy_schema"] == 1
    assert cov["scrape_dates"] == [{"date": "2020-10-16", "weekday": "Friday"}]
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_selection.py -q`
Expected: FAIL with `AttributeError: module 'ffmodel.eval.sameweek' has no attribute 'sameweek_window'`.

- [ ] **Step 3: Implement**

Replace the import block at the top of `sameweek.py` with:

```python
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
```

Then append:

```python
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_selection.py tests/test_sameweek_validation.py tests/test_sameweek_gate.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/sameweek.py tests/test_sameweek_selection.py
git commit -m "feat(sameweek): metadata-only same-week selection, date-filtered population, cells, audit, coverage (spec §3.6/§5.2)"
```

---

### Task 4: sameweek — statistics, sufficiency, directional check, Rules 1 and 2

**Model:** implementer sonnet (transcription); reviewer **opus** (numerics: full precision, week clustering).

**Files:**
- Modify: `src/ffmodel/eval/sameweek.py` (replace the import block, append)
- Test: `tests/test_sameweek_rules.py`

**Interfaces:**
- Consumes: `paired_bootstrap` from `ffmodel.eval.mean_head_gate`.
- Produces:
  - `BOOT_SEED = 20260728`, `N_BOOT = 10000`
  - `delta_stats(cells) -> dict` with keys `D`, `ci_week` (`[lo, hi]`), `D_season` (`{season: float}`), `loso`
    (`{season: float}`), `n_cells`, `n_clusters`
  - `sensitivity_stats(cells) -> dict` on the `gate_state == "bye_consistent"` subset: `D` | None, `n_cells`, `seasons`
  - `directional_check(stats, sens, sign: int) -> tuple[bool, list[str]]`
  - `sufficient(cells, target_weeks: dict[int, list[int]], position: str | None = None) -> bool`
  - `rule_1(cells, target_weeks) -> dict` (`value`, `reasons`, plus `stats` and `sensitivity` when sufficient)
  - `rule_2(disc_cells, disc_weeks, rep_cells, rep_weeks) -> dict` (`value`, `reasons_by_sample`; every
    insufficient sample is named)

`cells` frames have the columns `season, week, position, sp_ours, sp_con, gate_state` (and others). The diagnostic
`ci_cell` and every use of `weekly_consensus.pooled_stats` are cut in draft 7 (spec §3.8) and do not appear.

- [ ] **Step 1: Write the failing tests**

```python
"""Spec §6 statistics, directional checks and decision rules, driven from cell rows. Synthetic cells only."""
import pandas as pd

from ffmodel.eval import sameweek as sw

SEASONS = [2023, 2024, 2025]


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


def test_ci_week_moves_whole_weeks():
    # two positions per week with opposite deltas: a week-clustered resample keeps each week's mean at 0
    c = _cells({2023: lambda w, p: 0.1 if p == "QB" else -0.1}, positions=("QB", "RB"))
    st = sw.delta_stats(c)
    assert st["n_clusters"] == 17 and abs(st["ci_week"][0]) < 1e-12 and abs(st["ci_week"][1]) < 1e-12


def test_leave_one_season_out_values():
    st = sw.delta_stats(_cells({2023: 0.03, 2024: 0.06, 2025: 0.09}))
    assert abs(st["loso"][2023] - 0.075) < 1e-12 and abs(st["loso"][2025] - 0.045) < 1e-12


def test_reachability_example_ahead_and_its_reflection_behind():
    up = _cells({2023: lambda w, p: 0.02 + 0.04 * (w % 2), 2024: 0.03, 2025: 0.05})
    assert sw.rule_1(up, _weeks(SEASONS))["value"] == "ahead"
    down = up.assign(sp_ours=1.0 - up["sp_ours"])
    assert sw.rule_1(down, _weeks(SEASONS))["value"] == "behind"


def test_interval_including_zero_is_not_a_tie():
    noisy = _cells({2023: lambda w, p: 0.08 if w % 2 else -0.12, 2024: lambda w, p: 0.05 if w % 2 else -0.09,
                    2025: lambda w, p: 0.04 if w % 2 else -0.10})
    r = sw.rule_1(noisy, _weeks(SEASONS))
    assert r["value"] == "not_established" and "interval_includes_zero" in r["reasons"]
    assert r["stats"]["ci_week"][0] < 0 < r["stats"]["ci_week"][1]


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
    mixed = pd.concat([_cells({2023: 0.03, 2024: 0.04, 2025: 0.05}, state="unverified"),
                       _cells({2023: -0.02}, weeks=2, state="bye_consistent").assign(week=lambda f: f["week"] + 20)])
    assert "sensitivity_disagrees" in sw.directional_check(sw.delta_stats(mixed), sw.sensitivity_stats(mixed), +1)[1]
    zero = pd.concat([_cells({2023: 0.03, 2024: 0.04, 2025: 0.05}, state="unverified"),
                      _cells({2023: 0.0}, weeks=2, state="bye_consistent").assign(week=lambda f: f["week"] + 20)])
    assert "sensitivity_zero" in sw.directional_check(sw.delta_stats(zero), sw.sensitivity_stats(zero), +1)[1]


def test_touching_zero_and_opposite_side_codes():
    touching = _cells({2023: lambda w, p: 0.0 if w == 1 else 0.05, 2024: 0.05, 2025: 0.05}, weeks=1)
    st = sw.delta_stats(touching)                       # one zero week among three single-week seasons
    assert st["ci_week"][0] == 0.0
    ok, codes = sw.directional_check(st, sw.sensitivity_stats(touching), +1)
    assert codes[0] == "interval_includes_zero"
    below = _cells({2023: -0.05, 2024: -0.04, 2025: -0.06})
    ok, codes = sw.directional_check(sw.delta_stats(below), sw.sensitivity_stats(below), +1)
    assert "interval_opposite_side" in codes


def test_full_precision_lower_bound_passes_through_the_verdict_path():
    # every cell delta is +0.00003: rounded to 4 dp it would be 0.0000 and fail (a); in full precision it passes
    c = _cells({2023: 0.00003, 2024: 0.00003, 2025: 0.00003})
    r = sw.rule_1(c, _weeks(SEASONS))
    assert 0 < r["stats"]["ci_week"][0] < 0.0001
    assert r["value"] == "ahead" and r["reasons"] == []


def test_zero_estimate_and_loso_zero():
    flat = _cells({2023: 0.0, 2024: 0.0, 2025: 0.0})
    r = sw.rule_1(flat, _weeks(SEASONS))
    assert r["value"] == "not_established" and r["reasons"][0] == "zero_estimate"
    assert "leave_one_season_out_zero" in r["reasons"]


def test_sufficiency_per_season_and_rb():
    c = _cells({2023: 0.03, 2024: 0.04, 2025: 0.05}, weeks=8, positions=("QB", "WR", "TE"))
    assert sw.sufficient(c, _weeks(SEASONS, 16))                      # 8/16 weeks with a cell
    assert not sw.sufficient(c, _weeks(SEASONS, 16), "RB")            # RB-poor: Rule 1 yes, Rule 2 no
    assert sw.rule_1(c, _weeks(SEASONS, 18))["value"] == "insufficient"
    with_week1 = _cells({2023: 0.03}, weeks=1)
    assert sw.sufficient(with_week1, {2023: [1, 2]})                  # week 1 in the denominator and scored


def test_rule_2_needs_both_samples():
    good = _cells({2023: 0.03, 2024: 0.04, 2025: 0.05})
    rep_good = _cells({2020: 0.03, 2021: 0.04, 2022: 0.05})
    rep_bad = _cells({2020: 0.03, 2021: -0.04, 2022: -0.05})
    disc_w, rep_w = _weeks(SEASONS), _weeks([2020, 2021, 2022])
    assert sw.rule_2(good, disc_w, rep_good, rep_w)["value"] == "established"
    r = sw.rule_2(good, disc_w, rep_bad, rep_w)
    assert r["value"] == "not_established" and "season_inconsistent" in r["reasons_by_sample"]["replication"]
    r2 = sw.rule_2(rep_bad.assign(season=rep_bad["season"] + 3), disc_w, rep_good, rep_w)
    assert r2["value"] == "not_established" and r2["reasons_by_sample"]["replication"] == []


def test_rule_2_rb_below_zero_and_insufficient_samples():
    below = _cells({2023: -0.03, 2024: -0.04, 2025: -0.05})
    rep = _cells({2020: 0.03, 2021: 0.04, 2022: 0.05})
    r = sw.rule_2(below, _weeks(SEASONS), rep, _weeks([2020, 2021, 2022]))
    assert "interval_opposite_side" in r["reasons_by_sample"]["discovery"]
    no_rb = _cells({2020: 0.03, 2021: 0.04, 2022: 0.05}, positions=("QB",))
    r2 = sw.rule_2(below, _weeks(SEASONS), no_rb, _weeks([2020, 2021, 2022]))
    assert r2 == {"value": "insufficient", "reasons_by_sample": {"replication": ["insufficient"]}}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_rules.py -q`
Expected: FAIL with `AttributeError: module 'ffmodel.eval.sameweek' has no attribute 'delta_stats'`.

- [ ] **Step 3: Implement**

Replace the import block at the top of `sameweek.py` with the final one:

```python
from __future__ import annotations

import warnings
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.stats import ConstantInputWarning

from ffmodel.data.features import build_features
from ffmodel.data.rankings import attach_gsis
from ffmodel.eval.mean_head_gate import paired_bootstrap
from ffmodel.eval.weekly_rankings import score_week, weekly_snapshot
from ffmodel.scoring import PREDICTED_STATS
from ffmodel.site.draft import REPLACEMENT_RANK
```

Then append:

```python
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
    sub = cells if position is None or cells.empty else cells[cells["position"] == position]
    for season, weeks in target_weeks.items():
        have = set(sub.loc[sub["season"] == season, "week"].astype(int)) if len(sub) else set()
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
    samples = {"discovery": (disc_cells, disc_weeks), "replication": (rep_cells, rep_weeks)}
    short = {name: ["insufficient"] for name, (cells, weeks) in samples.items()
             if cells.empty or not sufficient(cells, weeks, "RB")}
    if short:
        return {"value": "insufficient", "reasons_by_sample": short}
    out: dict = {"reasons_by_sample": {}}
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

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_rules.py tests/test_sameweek_selection.py tests/test_sameweek_validation.py tests/test_sameweek_gate.py -q`
Expected: all pass. If `test_interval_including_zero_is_not_a_tie` yields an interval excluding zero, report it; do
not change the rule or widen the fixture without the controller.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/sameweek.py tests/test_sameweek_rules.py
git commit -m "feat(sameweek): week-clustered stats, leave-one-season-out, sensitivity, directional check, Rules 1-2 (spec §6)"
```

---

### Task 5: live_accuracy — activity fetch, ledger, git adapter, candidates, publication and archive evidence

**Model:** implementer sonnet (transcription); reviewer **opus** (evidence logic: P1, P2, P4, S6-I1).

**Files:**
- Create: `src/ffmodel/eval/live_accuracy.py`
- Test: `tests/test_live_accuracy_evidence.py`

**Interfaces:**
- Consumes: `sameweek.validate_table` (archive validation).
- Produces:
  - Constants: `BOT = "weekly-update-bot"`, `WEEKLY_FILES = ("site/data/weekly.json", "site/data/neutral/weekly.json")`,
    `ARCHIVE_DIR = "data_snapshots/weekly_ecr"`, `ARCHIVE_COLUMNS`, `MAIN_REF`, `NEG_INF = "-inf"`, `ZERO_SHA`
  - `Git` (real subprocess implementation; the only git access). Methods:
    - `exists(sha) -> bool`, `existing(shas) -> set[str]` (one `cat-file --batch-check` call)
    - `ident(sha) -> tuple[str, str]` (author name, committer name)
    - `changed(sha) -> set[str]` (`git diff --name-only C^1 C`)
    - `show(sha, path) -> bytes | None`
    - `reachable(tip) -> set[str]`, `descendants_among(c, shas) -> set[str]` (ancestor-or-self, one
      `rev-list --ancestry-path --stdin` call)
    - `rev_parse(ref) -> str`, `first_adding_commit(main_sha, path) -> str | None`, `ls_dir(sha, dirpath) -> list[str]`
    - `weekly_commits(tips, exclude=()) -> list[tuple[sha, committer_iso, author, committer]]`: commits touching
      a weekly file over the full ancestry of `tips` minus that of `exclude` (one `git log` call); the time is
      informational and never used to prune
    - `tree_id(path="src/ffmodel") -> str` (`git rev-parse HEAD:<path>` in the executing checkout), `dirty(path) -> bool`
  - `fetch_activity(repo, run=subprocess.run) -> list[dict]` (`gh api --paginate --slurp`, pages flattened)
  - Ledger: `normalize_event(raw)`, `collection_start(raw_events) -> str | None`, `load_ledger(path)`,
    `merge_collection(ledger, raw_events, t_end, t_start=None)`, `save_ledger(ledger, path)`, `ledger_sha256(ledger)`,
    `covered(ledger, t0, t1) -> bool` (half-open `[t0, t1)` inside the union; `"-inf"` accepted)
  - `season_lower_bound(season) -> pd.Timestamp`
  - `read_payloads(git, sha) -> tuple[dict | None, dict | None]` (legacy, neutral; malformed JSON reads as None)
  - `is_candidate(git, sha, season, week) -> bool`
  - `CandidateIndex` (dataclass: `by_week: dict[int, set[str]]`, `unfetchable: set`)
  - `candidate_index(ledger, git, season, main_sha) -> CandidateIndex`
  - `select_publication(ledger, git, season, week, cutoff, main_sha, index=None) -> dict`
    - keys: `status` (`"selected"` | `"publication_evidence_unavailable"` | `"weeks_unpublished"`), `commit`,
      `event_id`, `available_by`, `detail`
  - `select_archive(ledger, git, season, week, cutoff, main_sha) -> dict`
    - keys: `status` (`"selected"` | `"no_archive"` | `"archive_hash_mismatch"` | `"archive_identity_mismatch"` |
      `"validation_failed"`), `path`, `name`, `commit`, `available_by`, `event_id`, `blob_sha256`, `tie_break`,
      `alternatives` (each: `name`, `blob_sha256`, `available_by`, `status`), `validation`, `consensus`
      (valid rows, only when selected; never serialised)

How the selection maps to spec §4.1 (astra P2, S6-I1, S7-I1): `candidate_index` enumerates candidates from
reachable history **and** from the full ancestry of every ledger target of any type (one walk over the targets not
reachable from main, excluding main's ancestry, which the first source already covers) and records unfetchable
targets. The walk is never pruned by commit or author timestamps; `T_S` bounds publication time and is used only in
step 5's coverage check. `select_publication` step 1 uses only `push` events; steps 2–4 check
coverage, `force_push` and unfetchable targets of **any** type in `[available_by, cutoff)`; step 5 returns
`weeks_unpublished` only when no candidate exists, `[T_S, cutoff)` is covered and no event in it has an unfetchable
target. `select_archive` orders evidenced archives by `available_by` (then filename), checks the would-be selection's
hash, payload `season`/`week` and 1% validation, and skips with that reason rather than promoting another.

- [ ] **Step 1: Write the failing tests**

```python
"""Spec §4.1/§4.3 publication and archive evidence against a synthetic git history and push ledger."""
import hashlib
import json

import pandas as pd
import pytest

from ffmodel.eval import live_accuracy as la


class FakeGit:
    """commits: sha -> {parents, author, committer, changed, files: {path: bytes}, time}"""

    def __init__(self, commits):
        self.c = commits

    def exists(self, sha): return bool(sha) and sha in self.c
    def ident(self, sha): return self.c[sha]["author"], self.c[sha]["committer"]
    def changed(self, sha): return set(self.c[sha]["changed"])
    def show(self, sha, path): return self.c[sha]["files"].get(path)
    def rev_parse(self, ref): return ref
    def tree_id(self, path="src/ffmodel"): return "tree0"
    def dirty(self, path="src/ffmodel"): return False

    def _walk(self, sha):
        """Full ancestry; the only stopping point is a commit already visited (never a timestamp)."""
        out, stack = [], [sha]
        while stack:
            s = stack.pop()
            if s in out or s not in self.c:
                continue
            out.append(s)
            stack.extend(reversed(self.c[s].get("parents", [])))
        return out

    def is_ancestor(self, a, b): return a in self._walk(b)
    def existing(self, shas): return {s for s in shas if self.exists(s)}
    def reachable(self, tip): return set(self._walk(tip))
    def descendants_among(self, c, shas): return {s for s in shas if self.exists(s) and self.is_ancestor(c, s)}

    def first_adding_commit(self, main_sha, path):
        adds = [s for s in self._walk(main_sha) if path in self.c[s]["changed"] and path in self.c[s]["files"]]
        return min(adds, key=lambda s: self.c[s]["time"]) if adds else None

    def ls_dir(self, sha, dirpath):
        return sorted(p.split("/")[-1] for p in self.c[sha]["files"] if p.startswith(dirpath + "/"))

    def weekly_commits(self, tips, exclude=()):
        skip = {s for e in exclude for s in self._walk(e)}
        out = []
        for t in tips:
            out += [s for s in self._walk(t) if s not in skip and s not in out]
        return [(s, self.c[s]["time"], self.c[s]["author"], self.c[s]["committer"])
                for s in out if self.c[s]["changed"] & set(la.WEEKLY_FILES)]


def _legacy(week, gen="2026-09-30T21:29:16+00:00"):
    return json.dumps({"season": 2026, "week": week, "generated_at": gen,
                       "players": [{"player_id": "p1", "position": "WR", "team": "AAA",
                                    "points": {"ppr": {"p10": 1.0, "p50": 5.0, "p90": 9.0}}}]}).encode()


def _neutral(week, gen="2026-09-30T21:29:16+00:00"):
    sq = {q: {"receptions": v, "receiving_yards": 10 * v} for q, v in (("p10", 0.5), ("p50", 2.5), ("p90", 4.5))}
    return json.dumps({"season": 2026, "week": week, "generated_at": gen,
                       "players": [{"player_id": "p1", "position": "WR", "team": "AAA", "stat_quantiles": sq}]}).encode()


def _c(parents, author="me", changed=(), files=None, time="2026-09-30T00:00:00Z"):
    return {"parents": list(parents), "author": author, "committer": author, "changed": set(changed),
            "files": files or {}, "time": time}


LEG, NEU = la.WEEKLY_FILES


def _history():
    return FakeGit({
        "h0": _c([], changed={"README.md"}, time="2026-07-12T00:00:00Z"),
        "b1": _c(["h0"], la.BOT, {LEG}, {LEG: _legacy(4)}, "2026-09-30T09:59:00Z"),
        "b2": _c(["b1"], la.BOT, {NEU}, {LEG: _legacy(4), NEU: _neutral(4)}, "2026-09-30T20:59:00Z"),
        "m1": _c(["b2"], "me", {LEG}, {LEG: _legacy(4), NEU: _neutral(4)}, "2026-09-30T21:30:00Z"),
        "a1": _c(["m1"], "weekly-accuracy-bot", {LEG}, {LEG: _legacy(4)}, "2026-09-30T21:40:00Z"),
    })


def _ev(i, after, ts, kind="push", before="x"):
    return {"id": i, "ref": "refs/heads/main", "timestamp": ts, "before": before, "after": after,
            "activity_type": kind, "actor": {"login": "github-actions[bot]", "id": 1}}


CUT = pd.Timestamp("2026-10-01T00:00:00Z")


def _ledger(events, cov=("-inf", "2026-10-06T00:00:00Z")):
    return la.merge_collection({"events": [], "coverage": []}, events, t_end=cov[1], t_start=cov[0])


class _Run:
    def __init__(self, stdout, code=0):
        self.stdout, self.returncode, self.stderr = stdout, code, "boom"

    def __call__(self, cmd, **kw):
        assert cmd[:4] == ["gh", "api", "--paginate", "--slurp"]
        return self


def test_fetch_activity_flattens_slurped_pages_and_fails_safe():
    pages = [[_ev(i, f"s{i}", "2026-09-01T00:00:00Z") for i in range(p * 3, p * 3 + 3)] for p in range(3)]
    events = la.fetch_activity("o/r", run=_Run(json.dumps(pages)))
    assert [e["id"] for e in events] == list(range(9))
    with pytest.raises(RuntimeError):
        la.fetch_activity("o/r", run=_Run(json.dumps([pages[0], {"message": "x"}])))     # a non-array page
    with pytest.raises(RuntimeError):
        la.fetch_activity("o/r", run=_Run("", code=1))                                    # failed fetch
    with pytest.raises(RuntimeError):
        la.fetch_activity("o/r", run=_Run("\n".join(json.dumps(p) for p in pages)))      # un-slurped output


def test_selects_latest_covered_push_and_neutral_only_commit_is_candidate():
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-09-30T21:00:00Z")])
    r = la.select_publication(led, _history(), 2026, 4, CUT, "m1")
    assert r["status"] == "selected" and r["commit"] == "b2" and r["available_by"] == "2026-09-30T21:00:00Z"


def test_push_after_cutoff_not_selected_and_non_bot_commits_never_candidates():
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-10-01T00:00:02Z"),
                   _ev(3, "m1", "2026-09-30T22:00:00Z"), _ev(4, "a1", "2026-09-30T23:00:00Z")])
    r = la.select_publication(led, _history(), 2026, 4, CUT, "a1")
    assert r["commit"] == "b1"                      # m1 (hand-made) and a1 (weekly-accuracy-bot) are rejected
    assert not la.is_candidate(_history(), "a1", 2026, 4) and not la.is_candidate(_history(), "m1", 2026, 4)


def test_commit_changing_neither_weekly_file_is_not_a_candidate():
    g = _history()
    g.c["x1"] = _c(["b2"], la.BOT, {"README.md"}, {LEG: _legacy(4)})
    assert not la.is_candidate(g, "x1", 2026, 4) and la.is_candidate(g, "b2", 2026, 4)


def test_earliest_event_per_sha_and_id_tiebreak():
    led = _ledger([_ev(5, "b1", "2026-09-30T12:00:00Z"), _ev(4, "b1", "2026-09-30T12:00:00Z"),
                   _ev(3, "b1", "2026-09-30T13:00:00Z")])
    r = la.select_publication(led, _history(), 2026, 4, CUT, "m1")
    assert r["event_id"] == 4 and r["available_by"] == "2026-09-30T12:00:00Z"


def test_gap_after_publication_makes_unavailable_and_older_push_not_promoted():
    led = la.merge_collection({"events": [], "coverage": []},
                              [_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-09-30T21:00:00Z")],
                              t_start="-inf", t_end="2026-09-30T22:00:00Z")
    r = la.select_publication(led, _history(), 2026, 4, CUT, "m1")
    assert r["status"] == "publication_evidence_unavailable" and r["commit"] is None


def test_force_push_in_window_makes_unavailable():
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "m1", "2026-09-30T15:00:00Z", kind="force_push")])
    assert la.select_publication(led, _history(), 2026, 4, CUT, "m1")["status"] == "publication_evidence_unavailable"


def test_unfetchable_pr_merge_target_in_window_makes_unavailable():
    # astra P2: the step-4 check covers every activity type, not only push
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "ghost", "2026-09-30T20:00:00Z", kind="pr_merge")])
    r = la.select_publication(led, _history(), 2026, 4, CUT, "m1")
    assert r["status"] == "publication_evidence_unavailable" and r["event_id"] == 2


def test_payload_only_at_force_push_target_is_candidate_not_unpublished():
    # astra P2: a week-9 bot payload exists only at a retained force_push target, unreachable from main
    g = _history()
    g.c["fx"] = _c(["m1"], la.BOT, {LEG}, {LEG: _legacy(9)}, "2026-10-29T10:00:00Z")
    led = _ledger([_ev(1, "fx", "2026-10-29T10:05:00Z", kind="force_push"),
                   _ev(2, "m1", "2026-10-29T10:10:00Z", kind="force_push")],
                  cov=("-inf", "2026-11-06T00:00:00Z"))
    r = la.select_publication(led, g, 2026, 9, pd.Timestamp("2026-10-29T00:00:00Z") + pd.Timedelta(days=1), "m1")
    assert r["status"] == "publication_evidence_unavailable"


def test_pre_june_commit_pushed_in_season_is_selected():
    # astra S7-I1: committer time 2026-05-31 (before T_S), pushed 2026-09-30, removed from main by an Oct 2
    # force-push. Commit clocks are creation times, not publication times: it is a candidate and is selected.
    g = FakeGit({
        "h0": _c([], changed={"README.md"}, time="2026-07-12T00:00:00Z"),
        "lost": _c(["h0"], la.BOT, {LEG}, {LEG: _legacy(4)}, "2026-05-31T23:00:00Z"),
        "m2": _c(["h0"], "me", {"README.md"}, time="2026-10-02T08:00:00Z"),
    })
    led = _ledger([_ev(1, "lost", "2026-09-30T10:00:00Z"), _ev(2, "m2", "2026-10-02T09:00:00Z", kind="force_push")])
    assert la.is_candidate(g, "lost", 2026, 4)
    assert la.candidate_index(led, g, 2026, "m2").by_week == {4: {"lost"}}
    r = la.select_publication(led, g, 2026, 4, CUT, "m2")
    assert r["status"] == "selected" and r["commit"] == "lost" and r["available_by"] == "2026-09-30T10:00:00Z"


def test_ancestry_with_non_monotone_commit_times_is_walked_completely():
    # A backdated weekly-changing commit (May) sits between an off-main target and an in-season week-4 bot
    # commit. A walk that stopped at the first pre-T_S timestamp would miss c1 and claim weeks_unpublished.
    g = FakeGit({
        "h0": _c([], changed={"README.md"}, time="2026-07-12T00:00:00Z"),
        "c1": _c(["h0"], la.BOT, {LEG}, {LEG: _legacy(4)}, "2026-09-29T08:00:00Z"),
        "mid": _c(["c1"], "me", {LEG}, {LEG: _legacy(4)}, "2026-05-15T00:00:00Z"),
        "tip": _c(["mid"], "me", {"README.md"}, {LEG: _legacy(4)}, "2026-09-30T09:00:00Z"),
        "m2": _c(["h0"], "me", {"README.md"}, time="2026-10-02T08:00:00Z"),
    })
    led = _ledger([_ev(1, "tip", "2026-09-30T10:00:00Z"), _ev(2, "m2", "2026-10-02T09:00:00Z", kind="force_push")])
    assert la.candidate_index(led, g, 2026, "m2").by_week == {4: {"c1"}}
    r = la.select_publication(led, g, 2026, 4, CUT, "m2")
    assert r["status"] == "publication_evidence_unavailable"                     # a payload existed; never absent


def test_absence_needs_complete_coverage_from_season_lower_bound():
    g = _history()
    full = _ledger([])
    assert la.select_publication(full, g, 2026, 9, CUT, "m1")["status"] == "weeks_unpublished"
    gappy = {"events": [], "coverage": [["-inf", "2026-09-15T00:00:00Z"], ["2026-09-20T00:00:00Z", "2026-10-06T00:00:00Z"]]}
    assert la.select_publication(gappy, g, 2026, 9, CUT, "m1")["status"] == "publication_evidence_unavailable"
    late_start = {"events": [], "coverage": [["2026-07-01T00:00:00Z", "2026-10-06T00:00:00Z"]]}
    assert la.select_publication(late_start, g, 2026, 9, CUT, "m1")["status"] == "publication_evidence_unavailable"


def test_collection_ending_at_branch_creation_covers_back_to_minus_infinity():
    raw = [_ev(1, "h0", "2026-07-11T22:02:06Z", kind="branch_creation", before=la.ZERO_SHA),
           _ev(2, "b1", "2026-09-30T10:00:00Z")]
    led = la.merge_collection({"events": [], "coverage": []}, raw, t_end="2026-10-06T19:02:01Z")
    assert led["coverage"] == [["-inf", "2026-10-06T19:02:01Z"]]
    assert la.covered(led, "2026-06-01T00:00:00Z", "2026-10-01T00:00:00Z")
    partial = la.merge_collection({"events": [], "coverage": []}, raw[1:], t_end="2026-10-06T19:02:01Z")
    assert partial["coverage"] == [["2026-09-30T10:00:00Z", "2026-10-06T19:02:01Z"]]


def test_commit_before_push_after_cutoff_selects_older():
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-10-01T00:00:02Z")])
    assert la.select_publication(led, _history(), 2026, 4, CUT, "m1")["commit"] == "b1"


def test_sibling_merged_after_cutoff_is_never_selected():
    # astra r3: P and F share a parent; F joins main through a merge pushed after the cutoff
    g = FakeGit({
        "r0": _c([], changed={"README.md"}, time="2026-09-29T00:00:00Z"),
        "P": _c(["r0"], la.BOT, {LEG}, {LEG: _legacy(4)}, "2026-09-30T19:00:00Z"),
        "F": _c(["r0"], la.BOT, {LEG}, {LEG: _legacy(4, gen="later")}, "2026-09-30T19:30:00Z"),
        "M": _c(["P", "F"], "me", {LEG}, {LEG: _legacy(4, gen="later")}, "2026-10-02T09:00:00Z"),
    })
    led = _ledger([_ev(1, "P", "2026-09-30T20:00:00Z"), _ev(2, "M", "2026-10-02T10:00:00Z", kind="pr_merge")])
    r = la.select_publication(led, g, 2026, 4, CUT, "M")
    assert r["status"] == "selected" and r["commit"] == "P"
    assert "F" in la.candidate_index(led, g, 2026, "M").by_week[4]


def test_merge_collection_dedupes_and_keeps_login_only():
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z")], cov=("2026-07-01T00:00:00Z", "2026-10-06T00:00:00Z"))
    led = la.merge_collection(led, [_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-09-30T11:00:00Z")],
                              t_start="2026-09-01T00:00:00Z", t_end="2026-10-07T00:00:00Z")
    assert [e["id"] for e in led["events"]] == [1, 2] and led["events"][0]["actor"] == "github-actions[bot]"
    assert len(led["coverage"]) == 2 and la.covered(led, "2026-07-02T00:00:00Z", "2026-10-06T23:00:00Z")


def _archive(week, date, players, season=2026, payload_week=None):
    payload = {"season": season, "week": week if payload_week is None else payload_week, "snapshot_at": date,
               "players": players}
    enc = json.dumps(payload, sort_keys=True, indent=2, allow_nan=False)
    name = f"{season}-w{week:02d}-{date}-{hashlib.sha256(enc.encode()).hexdigest()[:16]}.json"
    return f"{la.ARCHIVE_DIR}/{name}", enc.encode()


def _players(ecr, n=1):
    return [{"player_id": f"p{i}", "ecr": ecr + i, "position": "WR", "team": "AAA"} for i in range(n)]


def _archive_world(early, late, after):
    (p_e, b_e), (p_l, b_l), (p_a, b_a) = early, late, after
    commits = {
        "a1": _c([], la.BOT, {p_e}, {p_e: b_e}, "2026-09-30T10:59:00Z"),
        "a2": _c(["a1"], la.BOT, {p_l}, {p_e: b_e, p_l: b_l}, "2026-09-30T20:59:00Z"),
        "a3": _c(["a2"], la.BOT, {p_a}, {p_e: b_e, p_l: b_l, p_a: b_a}, "2026-10-01T03:58:00Z"),
    }
    led = _ledger([_ev(1, "a1", "2026-09-30T11:00:00Z"), _ev(2, "a2", "2026-09-30T21:00:00Z", kind="pr_merge"),
                   _ev(3, "a3", "2026-10-01T03:58:50Z")])
    return FakeGit(commits), led


def test_archive_selection_evidence_cutoff_and_alternatives():
    early, late = _archive(4, "2026-09-30", _players(1.0)), _archive(4, "2026-09-30", _players(2.0))
    after = _archive(4, "2026-09-29", _players(3.0))
    g, led = _archive_world(early, late, after)
    r = la.select_archive(led, g, 2026, 4, CUT, "a3")
    assert r["status"] == "selected" and r["path"] == late[0] and r["available_by"] == "2026-09-30T21:00:00Z"
    assert [a["name"] for a in r["alternatives"]] == [early[0].split("/")[-1]]
    assert r["alternatives"][0]["blob_sha256"] == hashlib.sha256(early[1]).hexdigest()
    assert list(r["consensus"]["player_id"]) == ["p0"]
    only_late = _ledger([_ev(3, "a3", "2026-10-01T03:58:50Z")])                    # the week-3 shape
    assert la.select_archive(only_late, g, 2026, 4, CUT, "a3")["status"] == "no_archive"


def test_archive_tie_is_flagged():
    early, late = _archive(4, "2026-09-30", _players(1.0)), _archive(4, "2026-09-30", _players(2.0))
    g, _ = _archive_world(early, late, _archive(4, "2026-09-29", _players(3.0)))
    led = _ledger([_ev(2, "a2", "2026-09-30T21:00:00Z")])                          # both first appear via a2
    r = la.select_archive(led, g, 2026, 4, CUT, "a2")
    assert r["tie_break"] == "arbitrary_lexicographic" and r["name"] == min(early[0], late[0]).split("/")[-1]


def test_archive_hash_mismatch_is_not_promoted_past():
    early, late = _archive(4, "2026-09-30", _players(1.0)), _archive(4, "2026-09-30", _players(2.0))
    g, led = _archive_world(early, late, _archive(4, "2026-09-29", _players(3.0)))
    g.c["a2"]["files"][late[0]] = late[1] + b" "
    r = la.select_archive(led, g, 2026, 4, CUT, "a3")
    assert r["status"] == "archive_hash_mismatch" and r["consensus"] is None


def test_archive_identity_mismatch():
    # astra P4: correctly hashed, named for week 4, payload says week 9
    wrong = _archive(4, "2026-09-30", _players(1.0), payload_week=9)
    g, led = _archive_world(_archive(4, "2026-09-30", _players(5.0)), wrong, _archive(4, "2026-09-29", _players(3.0)))
    assert la.select_archive(led, g, 2026, 4, CUT, "a3")["status"] == "archive_identity_mismatch"


def test_archive_above_threshold_is_validation_failed_and_not_promoted():
    bad = _players(1.0, n=50)
    bad[0]["ecr"] = None                                                             # 1 of 50 keys = 2% > 1%
    g, led = _archive_world(_archive(4, "2026-09-30", _players(5.0)), _archive(4, "2026-09-30", bad),
                            _archive(4, "2026-09-29", _players(3.0)))
    r = la.select_archive(led, g, 2026, 4, CUT, "a3")
    assert r["status"] == "validation_failed" and r["consensus"] is None
    assert r["alternatives"][0]["status"] == "qualifies"                             # listed, never promoted


def test_archive_content_read_from_first_adding_commit_not_later_tree():
    early, late = _archive(4, "2026-09-30", _players(1.0)), _archive(4, "2026-09-30", _players(2.0))
    g, led = _archive_world(early, late, _archive(4, "2026-09-29", _players(3.0)))
    g.c["a3"]["files"][late[0]] = b"tampered later"                                  # later tree differs
    assert la.select_archive(led, g, 2026, 4, CUT, "a3")["status"] == "selected"
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_live_accuracy_evidence.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'ffmodel.eval.live_accuracy'`.

- [ ] **Step 3: Implement**

```python
"""Live weekly accuracy scorecard (spec docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md §4).

Scores the projections the bot pipeline published before each week's cutoff, proven by GitHub push records
kept in a committed, append-only ledger. Git and the GitHub API are injected so tests run offline.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from ffmodel.eval import sameweek as sw

BOT = "weekly-update-bot"
WEEKLY_FILES = ("site/data/weekly.json", "site/data/neutral/weekly.json")
ARCHIVE_DIR = "data_snapshots/weekly_ecr"
ARCHIVE_COLUMNS = ["player_id", "position", "team", "ecr"]
MAIN_REF = "refs/heads/main"
NEG_INF = "-inf"
ZERO_SHA = "0" * 40
NEG_INF_TS = pd.Timestamp.min.tz_localize("UTC")


class Git:
    """The only git access (spec §4.1). Tests pass a fake with the same methods."""

    def __init__(self, cwd: Path | str = "."):
        self.cwd = str(cwd)

    def _run(self, *args, check=True) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=self.cwd, capture_output=True, check=check)

    def exists(self, sha: str) -> bool:
        return bool(sha) and self._run("cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode == 0

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

    def existing(self, shas) -> set[str]:
        """The subset of `shas` that are commits in the local object store (one batched call)."""
        shas = sorted({s for s in shas if s})
        if not shas:
            return set()
        r = subprocess.run(["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"], cwd=self.cwd,
                           input="\n".join(shas) + "\n", capture_output=True, text=True, check=True)
        found = {line.split()[0] for line in r.stdout.splitlines() if line.endswith(" commit")}
        return {s for s in shas if s in found}

    def reachable(self, tip: str) -> set[str]:
        return set(self._run("rev-list", tip).stdout.decode().split())

    def descendants_among(self, c: str, shas) -> set[str]:
        """The members of `shas` that have `c` as ancestor-or-self (one batched call)."""
        shas = sorted({s for s in shas if s})
        if not shas:
            return set()
        r = subprocess.run(["git", "rev-list", "--ancestry-path", "--stdin"], cwd=self.cwd,
                           input="\n".join([f"^{c}", *shas]) + "\n", capture_output=True, text=True, check=True)
        found = set(r.stdout.split())
        return {s for s in shas if s in found or s == c}

    def rev_parse(self, ref: str) -> str:
        return self._run("rev-parse", ref).stdout.decode().strip()

    def first_adding_commit(self, main_sha: str, path: str) -> str | None:
        out = self._run("log", main_sha, "--full-history", "--diff-filter=A", "--format=%H", "--", path).stdout
        shas = out.decode().split()
        return shas[-1] if shas else None

    def ls_dir(self, sha: str, dirpath: str) -> list[str]:
        out = self._run("ls-tree", "--name-only", f"{sha}:{dirpath}", check=False)
        return sorted(out.stdout.decode().split()) if out.returncode == 0 else []

    def weekly_commits(self, tips, exclude=()) -> list[tuple[str, str, str, str]]:
        """(sha, committer ISO time, author name, committer name) of commits touching a weekly file, over the FULL
        ancestry of `tips` minus the ancestry of `exclude` (one `git log` call; git visits each commit once).
        The time is informational: no caller may prune by it (spec §4.1, astra S7-I1)."""
        tips = sorted({t for t in tips if t})
        if not tips:
            return []
        out = self._run("log", *tips, *[f"^{e}" for e in exclude if e], "--full-history",
                        "--format=%H%x09%cI%x09%an%x09%cn", "--", *WEEKLY_FILES).stdout
        return [tuple(line.split("\t")) for line in out.decode().splitlines() if line]

    def tree_id(self, path: str = "src/ffmodel") -> str:
        """Tree id of `path` in the EXECUTING checkout (spec §4.6 evaluator_version)."""
        return self._run("rev-parse", f"HEAD:{path}").stdout.decode().strip()

    def dirty(self, path: str = "src/ffmodel") -> bool:
        return bool(self._run("status", "--porcelain", "--", path).stdout.strip())


# --- activity API and ledger --------------------------------------------------------------------------------------
def fetch_activity(repo: str, run=subprocess.run) -> list[dict]:
    """All main-ref activity events. `--paginate --slurp` emits ONE outer JSON array whose items are the pages
    (spec §4.1, astra P1); the events are the pages concatenated. Any failure is an infrastructure error."""
    cmd = ["gh", "api", "--paginate", "--slurp", f"repos/{repo}/activity?ref={MAIN_REF}&per_page=100"]
    r = run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"activity fetch failed (exit {r.returncode}): {(r.stderr or '')[-500:]}")
    try:
        pages = json.loads(r.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"activity response is not one JSON document: {exc}") from exc
    if not isinstance(pages, list) or not all(isinstance(p, list) for p in pages):
        raise RuntimeError("activity response is not an array of array pages")
    events = [e for page in pages for e in page]
    if not all(isinstance(e, dict) and "id" in e and "timestamp" in e for e in events):
        raise RuntimeError("activity event without id/timestamp")
    return events


def normalize_event(raw: dict) -> dict:
    actor = raw.get("actor")
    return {"id": raw["id"], "ref": raw.get("ref"), "timestamp": raw["timestamp"], "before": raw.get("before"),
            "after": raw.get("after"), "activity_type": raw.get("activity_type"),
            "actor": actor.get("login") if isinstance(actor, dict) else actor}


def _ts(x) -> pd.Timestamp:
    if isinstance(x, str) and x == NEG_INF:
        return NEG_INF_TS
    t = pd.Timestamp(x)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


def collection_start(raw_events: list[dict]) -> str | None:
    """t_start of a complete collection: "-inf" when the oldest event is main's branch_creation (nothing can
    precede the branch), else the oldest event's timestamp (spec §4.1 coverage intervals)."""
    if not raw_events:
        return None
    oldest = min((normalize_event(r) for r in raw_events), key=lambda e: (_ts(e["timestamp"]), e["id"]))
    if oldest["activity_type"] == "branch_creation" and oldest["ref"] == MAIN_REF:
        return NEG_INF
    return oldest["timestamp"]


def load_ledger(path: Path) -> dict:
    p = Path(path)
    if not p.exists():
        return {"events": [], "coverage": []}
    return json.loads(p.read_text(encoding="utf-8"))


def merge_collection(ledger: dict, raw_events: list[dict], t_end: str, t_start: str | None = None) -> dict:
    """Append-only merge by id (events are never deleted or edited); record [t_start, t_end] coverage."""
    by_id = {e["id"]: e for e in ledger["events"]}
    for raw in raw_events:
        e = normalize_event(raw)
        by_id.setdefault(e["id"], e)
    events = sorted(by_id.values(), key=lambda e: (_ts(e["timestamp"]), e["id"]))
    start = t_start if t_start is not None else (collection_start(raw_events) or t_end)
    coverage = sorted(ledger["coverage"] + [[start, t_end]], key=lambda iv: (_ts(iv[0]), _ts(iv[1])))
    return {"events": events, "coverage": coverage}


def save_ledger(ledger: dict, path: Path) -> None:
    Path(path).write_text(json.dumps(ledger, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def ledger_sha256(ledger: dict) -> str:
    return hashlib.sha256(json.dumps(ledger, sort_keys=True).encode()).hexdigest()


def covered(ledger: dict, t0, t1) -> bool:
    """[t0, t1) lies inside the union of the coverage intervals."""
    a, b = _ts(t0), _ts(t1)
    merged: list[list[pd.Timestamp]] = []
    for s, e in sorted((_ts(s), _ts(e)) for s, e in ledger["coverage"]):
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return any(s <= a and b <= e for s, e in merged)


def _main_events(ledger: dict) -> list[dict]:
    return [e for e in ledger["events"] if e.get("ref") == MAIN_REF]


def season_lower_bound(season: int) -> pd.Timestamp:
    """T_S (spec §4.1): no season-S week-N publication can precede it."""
    return pd.Timestamp(f"{season}-06-01T00:00:00Z")


# --- publications -------------------------------------------------------------------------------------------------
def read_payloads(git, sha: str) -> tuple[dict | None, dict | None]:
    out = []
    for path in WEEKLY_FILES:
        raw = git.show(sha, path)
        try:
            out.append(json.loads(raw) if raw else None)
        except json.JSONDecodeError:
            out.append(None)
    return out[0], out[1]


def _identities(git, sha: str) -> set[tuple]:
    return {(p.get("season"), p.get("week")) for p in read_payloads(git, sha) if isinstance(p, dict)}


def _bot_weekly_commit(git, sha: str) -> bool:
    return git.ident(sha) == (BOT, BOT) and bool(git.changed(sha) & set(WEEKLY_FILES))


def is_candidate(git, sha: str, season: int, week: int) -> bool:
    return git.exists(sha) and _bot_weekly_commit(git, sha) and (season, week) in _identities(git, sha)


@dataclass
class CandidateIndex:
    by_week: dict           # week -> set of candidate shas
    unfetchable: set        # ledger targets that cannot be fetched locally


def candidate_index(ledger: dict, git, season: int, main_sha: str) -> CandidateIndex:
    """Spec §4.1 candidate enumeration: every commit reachable from the pinned main sha, plus every commit
    reachable from any ledger target (any activity type) -- full ancestry, never pruned by commit or author
    timestamps, which are creation times that can be set arbitrarily and need not decrease along ancestry
    (astra S7-I1). Ancestry already reachable from main is enumerated once, by the first source; a target that
    cannot be fetched is recorded as unfetchable."""
    afters = {e.get("after") for e in _main_events(ledger)}
    present = git.existing(a for a in afters if a and a != ZERO_SHA)
    unfetchable = {a for a in afters if a not in present}
    rows = list(git.weekly_commits([main_sha]))
    off_main = sorted(present - git.reachable(main_sha))
    if off_main:
        rows += git.weekly_commits(off_main, exclude=[main_sha])
    by_week: dict[int, set] = {}
    seen: set = set()
    for sha, _, author, committer in rows:
        if sha in seen:
            continue
        seen.add(sha)
        if (author, committer) != (BOT, BOT) or not (git.changed(sha) & set(WEEKLY_FILES)):
            continue
        for s, w in _identities(git, sha):
            if s == season and isinstance(w, int):
                by_week.setdefault(w, set()).add(sha)
    return CandidateIndex(by_week=by_week, unfetchable=unfetchable)


def _unavailable(detail: str, event_id=None) -> dict:
    return {"status": "publication_evidence_unavailable", "commit": None, "event_id": event_id,
            "available_by": None, "detail": detail}


def select_publication(ledger: dict, git, season: int, week: int, cutoff, main_sha: str,
                       index: CandidateIndex | None = None) -> dict:
    """Spec §4.1 selection steps 1-5. Only a `push` establishes publication; other types feed the checks."""
    cutoff = _ts(cutoff)
    idx = index or candidate_index(ledger, git, season, main_sha)
    cands = idx.by_week.get(week, set())
    main = _main_events(ledger)
    pushes = sorted((e for e in main if e.get("activity_type") == "push" and e.get("after") in cands
                     and _ts(e["timestamp"]) < cutoff), key=lambda e: (_ts(e["timestamp"]), e["id"]))
    earliest: dict[str, dict] = {}
    for e in pushes:                                     # step 1: reduce each sha to its earliest push
        earliest.setdefault(e["after"], e)
    if earliest:
        ev = max(earliest.values(), key=lambda e: (_ts(e["timestamp"]), e["id"]))
        avail = _ts(ev["timestamp"])
        window = [e for e in main if avail <= _ts(e["timestamp"]) < cutoff]
        if not covered(ledger, avail, cutoff):                                       # step 2
            return _unavailable("ledger coverage gap between publication and cutoff", ev["id"])
        forced = [e for e in window if e.get("activity_type") == "force_push"]
        if forced:                                                                   # step 3
            return _unavailable("force_push between publication and cutoff", forced[0]["id"])
        lost = [e for e in window if e.get("after") in idx.unfetchable]
        if lost:                                                                     # step 4
            return _unavailable("unfetchable ledger target between publication and cutoff", lost[0]["id"])
        return {"status": "selected", "commit": ev["after"], "event_id": ev["id"],
                "available_by": ev["timestamp"], "detail": None}
    if cands:                                                                        # step 5
        return _unavailable("candidate payload without a pre-cutoff push naming it")
    t_s = season_lower_bound(season)
    span_lost = [e for e in main if t_s <= _ts(e["timestamp"]) < cutoff and e.get("after") in idx.unfetchable]
    if covered(ledger, t_s, cutoff) and not span_lost:
        return {"status": "weeks_unpublished", "commit": None, "event_id": None, "available_by": None,
                "detail": "no candidate; [T_S, cutoff) fully covered and every target fetchable"}
    return _unavailable("absence not provable: coverage gap or unfetchable target in [T_S, cutoff)")


# --- archives -----------------------------------------------------------------------------------------------------
def _archive_digest_ok(name: str, blob: bytes) -> bool:
    digest = name.rsplit("-", 1)[-1].removesuffix(".json")
    return hashlib.sha256(blob).hexdigest()[:16] == digest


def _check_archive(git, q: dict, season: int, week: int) -> dict:
    """Content and identity checks (spec §4.3, astra P4), all before an archive can qualify."""
    blob = git.show(q["commit"], q["path"])
    out = {"blob_sha256": hashlib.sha256(blob).hexdigest() if blob is not None else None,
           "status": None, "consensus": None, "validation": None}
    if blob is None or not _archive_digest_ok(q["name"], blob):
        return {**out, "status": "archive_hash_mismatch"}
    try:
        content = json.loads(blob)
    except json.JSONDecodeError:
        return {**out, "status": "archive_identity_mismatch"}
    if not isinstance(content, dict) or content.get("season") != season or content.get("week") != week:
        return {**out, "status": "archive_identity_mismatch"}
    players = pd.DataFrame(content.get("players") or [], columns=ARCHIVE_COLUMNS)
    v = sw.validate_table(players, ["player_id"], ["ecr"], ["position", "team"], position_col="position")
    if v.fails():
        return {**out, "status": "validation_failed", "validation": v.report()}
    return {**out, "status": "qualifies", "consensus": v.valid, "validation": v.report()}


def select_archive(ledger: dict, git, season: int, week: int, cutoff, main_sha: str) -> dict:
    """Spec §4.3. Evidence orders the archives; the archive that would be selected must pass every content and
    identity check, otherwise the week's primary ranking is skipped with that reason (never promoted past)."""
    cutoff = _ts(cutoff)
    prefix = f"{season}-w{week:02d}-"
    events = sorted((e for e in _main_events(ledger) if e.get("activity_type") in {"push", "pr_merge"}
                     and _ts(e["timestamp"]) < cutoff), key=lambda e: (_ts(e["timestamp"]), e["id"]))
    present = git.existing(e.get("after") for e in events)
    evidenced = []
    for name in git.ls_dir(main_sha, ARCHIVE_DIR):
        if not name.startswith(prefix):
            continue
        path = f"{ARCHIVE_DIR}/{name}"
        c = git.first_adding_commit(main_sha, path)
        if c is None or git.ident(c) != (BOT, BOT):
            continue
        desc = git.descendants_among(c, present)
        ev = next((e for e in events if e.get("after") in desc), None)
        if ev is None or not covered(ledger, ev["timestamp"], cutoff):
            continue
        evidenced.append({"path": path, "name": name, "commit": c, "available_by": ev["timestamp"],
                          "event_id": ev["id"]})
    empty = {"path": None, "name": None, "commit": None, "available_by": None, "event_id": None,
             "blob_sha256": None, "tie_break": None, "alternatives": [], "validation": None, "consensus": None}
    if not evidenced:
        return {**empty, "status": "no_archive"}
    evidenced.sort(key=lambda q: (-_ts(q["available_by"]).value, q["name"]))
    checked = [{**q, **_check_archive(git, q, season, week)} for q in evidenced]
    pick, rest = checked[0], checked[1:]
    tie = sum(1 for q in checked if q["available_by"] == pick["available_by"]) > 1
    alternatives = [{"name": q["name"], "blob_sha256": q["blob_sha256"], "available_by": q["available_by"],
                     "status": q["status"]} for q in rest]
    status = "selected" if pick["status"] == "qualifies" else pick["status"]
    return {"status": status, "path": pick["path"], "name": pick["name"], "commit": pick["commit"],
            "available_by": pick["available_by"], "event_id": pick["event_id"], "blob_sha256": pick["blob_sha256"],
            "tie_break": "arbitrary_lexicographic" if tie else None, "alternatives": alternatives,
            "validation": pick["validation"], "consensus": pick["consensus"] if status == "selected" else None}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_live_accuracy_evidence.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/live_accuracy.py tests/test_live_accuracy_evidence.py
git commit -m "feat(live_accuracy): slurped activity fetch, append-only ledger with -inf coverage, candidate enumeration, publication and archive evidence (spec §4.1/§4.3)"
```

---

### Task 6: live_accuracy — published values, equivalence, metrics, evaluate, artifact, CLI

**Model:** implementer sonnet (transcription); reviewer **opus** (numerics and the P3/P5/P6 paths).

**Files:**
- Modify: `src/ffmodel/eval/live_accuracy.py` (replace the import block, append)
- Test: `tests/test_live_accuracy_metrics.py`

**Interfaces:**
- Consumes:
  - Task 5;
  - `sameweek.prepare` output (`Prepared`, whose `schedule.dates(S)` gives every cutoff), `week_inputs`,
    `week_dates` (listing due weeks only), `week_teams`, `validate_projections`, `validate_table`, `TableValidation`,
    `build_cells`, `cell_summary`, `sameweek_week`, `delta_stats`, `ranking_coverage`, `N_BOOT`, `BOOT_SEED`;
  - `ffmodel.site.leaguelens.effective_weights`, `reference_score`;
  - `ffmodel.baseline.naive.NaiveLast4`; `ffmodel.eval.metrics.pinball_loss`;
  - `ffmodel.scoring.PPR`, `PREDICTED_STATS`, `fantasy_points`; `ffmodel.eval.mean_head_gate.paired_bootstrap`;
  - in `main` only: `ffmodel.data.pull` (`_cached`, `pull_weekly`, `pull_schedules`, `current_nfl_season`,
    `LIVE_MAX_AGE_HOURS`), `ffmodel.data.rankings.pull_player_ids`, `weekly_rankings.normalize_weekly_rankings`.
- Produces:
  - `PROTOCOL_VERSION = "live-accuracy-v1"`, `EQUIV_TOL`, `LEDGER_PATH`, `BAKEOFF_PATH`, `PROVISIONAL_DAYS = 8`
  - `ppr_weights() -> dict`
  - `NEUTRAL_COMPONENTS`, `validate_neutral(stats_frame) -> sw.TableValidation` (full stat vectors: identity and
    duplicates with the canonical `vector` in the signature, every `PREDICTED_STATS` component finite in p10/p50/p90,
    per-component order), `_neutral_stats_frame(neutral) -> pd.DataFrame`
  - `equivalence(legacy_validation, neutral_validation) -> dict` (`ok` plus the invalid, missing and divergent
    player lists), over two `sw.TableValidation`s
  - `published_values(legacy, neutral, weights, season, week) -> tuple[sw.TableValidation | None, str | None, dict]`
    (the validated projection table; callers score `.valid` and apply the 1% rule with `.fails()`)
  - `naive_points(features, rows, season) -> pd.Series`
  - `point_metrics(df) -> dict` (None for undefined values)
  - `paired_intervals(df) -> dict`
  - `week_complete(prep, season, week) -> bool`
  - `unprojected_summary(unproj, played) -> dict`
  - `frame_sha256(df)`, `file_sha256(path)`, `input_hashes(weekly_raw, schedules_raw, crosswalk, rankings_raw, bakeoff_path=BAKEOFF_PATH) -> dict`
  - `evaluator_version(git, protocol) -> dict` (`protocol_version`, `src_ffmodel_tree`, `dirty`, `id`); each caller
    passes its own artifact's protocol: `live-accuracy-v1` here, `sleeper-compare-v1` in Task 7, `sameweek-v1` in
    Task 9
  - `LiveContext` (dataclass: `season, weeks, as_of, prepared, rankings, rankings_raw, crosswalk, ledger, git,
    main_sha, bakeoff, inputs`)
  - `evaluate(ctx) -> dict` (the artifact without its `run` block; each week record carries `cutoff`,
    `last_game`, `publication`, `values`, `validation`, `unprojected`, `points`, `expert_snapshot`, `primary` and
    `secondary`, the last two with retained per-position `cells`)
  - `render_markdown(artifact) -> str`, `serialise(artifact) -> str` (`allow_nan=False`)
  - `output_path(season=None) -> Path` (`models/diagnostics/live_<S>_weekly.json`, S from `current_nfl_season()`)
  - `main(argv=None) -> int`

The workflow (Task 8) and the Sleeper comparator (Task 7) read the artifact keys `season`, `weeks_scored`,
`weeks[<N>].cutoff` and `weeks[<N>].publication.{commit, available_by}`; keep those names.

- [ ] **Step 1: Write the failing tests**

```python
"""Spec §4.1-4.6: published values, equivalence, point metrics, the full evaluate path, artifact and markdown."""
import hashlib
import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.eval import live_accuracy as la
from ffmodel.eval import sameweek as sw
from ffmodel.scoring import PREDICTED_STATS
from tests.test_live_accuracy_evidence import FakeGit, _c, _ev, _ledger

LEG, NEU = la.WEEKLY_FILES


def _legacy(gen="g1", players=None, week=4):
    players = players if players is not None else [("p1", "WR", "AAA", 2.0, 5.0, 8.0)]
    return {"season": 2026, "week": week, "generated_at": gen,
            "players": [{"player_id": i, "position": pos, "team": t, "points": {"ppr": {"p10": a, "p50": b, "p90": c}}}
                        for i, pos, t, a, b, c in players]}


def _neutral(gen="g1", rec=(1.0, 2.5, 4.0), players=("p1",)):
    from ffmodel.site.leaguelens import STATS
    sq = {q: {**{s: 0.0 for s in STATS}, "receptions": r, "receiving_yards": 10 * r}
          for q, r in zip(("p10", "p50", "p90"), rec)}
    return {"season": 2026, "week": 4, "generated_at": gen,
            "players": [{"player_id": p, "position": "WR", "team": "AAA", "stat_quantiles": sq} for p in players]}


def test_values_prefer_legacy_and_rescore_neutral():
    w = la.ppr_weights()
    vp, reason, d = la.published_values(_legacy(), _neutral(gen="other"), w, 2026, 4)   # different batch: no check
    assert reason is None and vp.valid["p50"].iloc[0] == 5.0 and d["equivalence_checked"] is False
    vp, reason, _ = la.published_values(None, _neutral(), w, 2026, 4)                     # legacy retired
    assert reason is None and list(vp.valid[["p10", "p50", "p90"]].iloc[0]) == pytest.approx([2.0, 5.0, 8.0])
    assert vp.n_keys == 1 and vp.invalid == {}
    vp, reason, d = la.published_values(_legacy(), _neutral(), w, 2026, 4)               # same batch, within 0.01
    assert reason is None and d["equivalence_checked"] is True


@pytest.mark.parametrize("neutral,field", [
    (_neutral(rec=(1.0, 2.5, 4.6)), "divergent"),                   # p90 off by 1.2
    (_neutral(players=()), "missing_in_neutral"),                   # empty neutral player list
    (_neutral(players=("p2",)), "missing_in_neutral"),              # player missing from the neutral file
])
def test_equivalence_failures(neutral, field):
    vp, reason, d = la.published_values(_legacy(), neutral, la.ppr_weights(), 2026, 4)
    assert vp is None and reason == "equivalence_failed" and d[field]


def test_nan_neutral_quantile_fails_the_neutral_table_before_equivalence():
    bad = _neutral()
    bad["players"][0]["stat_quantiles"]["p50"]["receptions"] = float("nan")
    vp, reason, d = la.published_values(_legacy(), bad, la.ppr_weights(), 2026, 4)
    assert reason is None and vp.fails() and d == {"source": "neutral", "equivalence_checked": False,
                                                   "failed_table": "neutral"}
    assert vp.invalid == {"nonfinite": {("p1",)}}


def test_zero_weight_nan_component_invalidates_neutral_row_before_scoring():
    # astra S7-I4: carries has zero PPR weight, so the points are unchanged; the full-vector check still fails it
    bad = _neutral()
    bad["players"][0]["stat_quantiles"]["p50"]["carries"] = float("nan")
    vp, reason, d = la.published_values(_legacy(), bad, la.ppr_weights(), 2026, 4)
    assert reason is None and vp.fails() and d["failed_table"] == "neutral"
    only, reason, _ = la.published_values(None, bad, la.ppr_weights(), 2026, 4)         # legacy retired
    assert reason is None and only.invalid == {"nonfinite": {("p1",)}} and only.valid.empty and only.fails()


def _many(n, extra=()):
    ids = [f"p{i:03d}" for i in range(n)]
    leg = {"season": 2026, "week": 4, "generated_at": "g1",
           "players": [{"player_id": i, "position": "WR", "team": "AAA",
                        "points": {"ppr": {"p10": 2.0, "p50": 5.0, "p90": 8.0}}} for i in ids]}
    neu = _neutral(players=tuple(ids) + tuple(extra))
    return leg, neu


def test_neutral_only_invalid_player_over_threshold_skips_the_week():
    # astra S71-I1: 20 matching players plus one neutral-only player whose zero-weight p50.carries is NaN.
    # The surviving IDs equal the legacy IDs, but 1/21 of the neutral table is invalid (> 1%): never equivalence.
    leg, neu = _many(20, extra=("extra_bad",))
    neu["players"][-1]["stat_quantiles"] = json.loads(json.dumps(neu["players"][-1]["stat_quantiles"]))
    neu["players"][-1]["stat_quantiles"]["p50"]["carries"] = float("nan")
    vp, reason, d = la.published_values(leg, neu, la.ppr_weights(), 2026, 4)
    assert reason is None and vp.fails() and d["failed_table"] == "neutral"
    assert vp.n_keys == 21 and vp.invalid_keys() == {("extra_bad",)}


def test_neutral_only_invalid_player_at_exactly_one_percent_passes():
    # boundary: 99 matching players plus one invalid neutral-only player = exactly 1% -> passes, equivalence runs
    leg, neu = _many(99, extra=("extra_bad",))
    neu["players"][-1]["stat_quantiles"] = json.loads(json.dumps(neu["players"][-1]["stat_quantiles"]))
    neu["players"][-1]["stat_quantiles"]["p50"]["carries"] = float("nan")
    vp, reason, d = la.published_values(leg, neu, la.ppr_weights(), 2026, 4)
    assert reason is None and not vp.fails() and d["equivalence_checked"] is True and len(vp.valid) == 99


def test_same_player_neutral_vectors_that_score_identically_are_conflicting():
    # astra S7-I4: the second record has one more reception and ten fewer receiving yards in every quantile --
    # valid ordering, identical PPR points, different stat vector. The key is conflicting: 100% of the table.
    neu = _neutral()
    twin = json.loads(json.dumps(neu["players"][0]))
    for q in ("p10", "p50", "p90"):
        twin["stat_quantiles"][q]["receptions"] += 1.0
        twin["stat_quantiles"][q]["receiving_yards"] -= 10.0
    neu["players"].append(twin)
    stats = la._neutral_stats_frame(neu)
    w = la.ppr_weights()
    pts = [la.leaguelens.reference_score(p["stat_quantiles"], "WR", w) for p in neu["players"]]
    assert pts[0] == pytest.approx(pts[1])                                             # same points either way
    vp, reason, d = la.published_values(_legacy(), neu, w, 2026, 4)
    assert reason is None and vp.fails() and d["failed_table"] == "neutral"            # 100% invalid: never equivalence
    only, reason, _ = la.published_values(None, neu, w, 2026, 4)
    assert only.invalid == {"conflicting_duplicates": {("p1",)}} and only.excluded_fraction() == 1.0
    assert la.validate_neutral(stats).n_keys == 1 and only.fails()


def test_point_metrics_hand_computed_and_empty_is_null():
    df = pd.DataFrame({"actual": [10.0, 2.0, 7.0, 4.0], "p10": [1.0, 3.0, 2.0, 1.0], "p50": [6.0, 5.0, 7.0, 4.0],
                       "p90": [9.0, 9.0, 12.0, 8.0], "naive": [8.0, 4.0, 6.0, 4.0]})
    m = la.point_metrics(df)
    assert m["n"] == 4 and m["mae"] == pytest.approx((4 + 3 + 0 + 0) / 4)
    assert m["naive_mae"] == pytest.approx((2 + 2 + 1 + 0) / 4)
    assert m["coverage_p10_p90"] == pytest.approx(2 / 4)            # 10>9 above, 2<3 below
    assert m["below_p10"] == pytest.approx(0.25) and m["above_p90"] == pytest.approx(0.25)
    assert m["share_above_p50"] == pytest.approx(0.25)
    assert m["pinball_p50"] == pytest.approx(0.5 * (4 + 3) / 4)
    empty = la.point_metrics(df.head(0))
    assert empty["n"] == 0 and empty["mae"] is None and empty["pinball_p90"] is None


def test_paired_intervals_accept_scalar_string_clusters():
    df = pd.DataFrame({"actual": [10.0, 2.0, 7.0, 4.0, 6.0, 3.0], "p50": [6.0, 5.0, 7.0, 4.0, 5.0, 3.5],
                       "naive": [8.0, 4.0, 6.0, 4.0, 6.0, 2.0], "player_id": list("abcdef"),
                       "week": [1, 1, 2, 2, 3, 3], "team": ["X", "Y", "X", "Y", "X", "Y"]})
    r = la.paired_intervals(df)
    assert len(r["ci95_player"]) == 2 and len(r["ci95_week_team"]) == 2
    assert r["delta_mae_model_minus_naive"] == pytest.approx(
        np.mean(np.abs(df.actual - df.p50) - np.abs(df.actual - df.naive)))


# --- the full driver path: raw tables -> stage 1 -> build_features -> stage 2 -> scoring --------------------------
TEAMS = ("AAA", "BBB")
POS = ("RB", "WR")


def _raw_world(missing_team_week=None):
    sched, rows = [], []
    for season, start in ((2025, "2025-09-04"), (2026, "2026-09-10")):
        for w in (1, 2):
            day = (pd.Timestamp(start) + pd.Timedelta(days=7 * (w - 1))).strftime("%Y-%m-%d")
            sched.append((season, w, day, "AAA", "BBB"))
            for t in TEAMS:
                if (season, w, t) == missing_team_week:
                    continue
                for pos in POS:
                    for i in range(5):
                        r = {"player_id": f"{t}{pos}{i}", "player_display_name": "x", "position": pos, "team": t,
                             "opponent_team": "BBB" if t == "AAA" else "AAA", "season": season, "week": w,
                             "target_share": np.nan, "snap_pct": np.nan, "two_point_conversions": 0,
                             "special_teams_tds": 0, **{s: 0.0 for s in PREDICTED_STATS}}
                        r["receptions"] = float(i + w)
                        r["receiving_yards"] = float(10 * (i + 1))
                        rows.append(r)
    return (pd.DataFrame(rows),
            pd.DataFrame(sched, columns=["season", "week", "gameday", "home_team", "away_team"]))


def _publication_git(players, dirty=False):
    payload = _legacy(gen="g1", players=players, week=1)
    g = FakeGit({"h0": _c([], changed={"README.md"}, time="2026-07-12T00:00:00Z"),
                 "pub": _c(["h0"], la.BOT, {LEG}, {LEG: json.dumps(payload).encode()}, "2026-09-09T09:00:00Z")})
    g.dirty = lambda path="src/ffmodel": dirty
    return g


BAKEOFF = {"results": [{"position": "OVERALL", "model": m, "test_season": s, "n": 100, "mae": 4.0 + k,
                        "coverage_p10_p90": 0.8} for k, m in enumerate(("transformer", "naive_last4"))
                       for s in (2023, 2024, 2025)]}


def _ctx(git, raw=None, weeks=(1,), as_of="2026-09-20"):
    weekly, sched = raw or _raw_world()
    return la.LiveContext(season=2026, weeks=list(weeks), as_of=pd.Timestamp(as_of),
                          prepared=sw.prepare(weekly, sched), rankings=None, rankings_raw=None, crosswalk=None,
                          ledger=_ledger([_ev(1, "pub", "2026-09-09T10:00:00Z")]), git=git, main_sha="pub",
                          bakeoff=BAKEOFF, inputs=la.input_hashes(weekly, sched, None, None, bakeoff_path=la.BAKEOFF_PATH))


def _ours(ids, p50=5.0):
    return [(i, i[3:5], i[:3], p50 - 3, p50, p50 + 3) for i in ids]


def test_complete_week_with_zero_projection_matches_is_no_scorable_points():
    art = la.evaluate(_ctx(_publication_git(_ours(["ZZZWR9"]))))
    assert art["weeks_scored"] == [] and art["points"] == {}
    assert art["weeks_skipped"] == [{"week": 1, "reason": "no_scorable_points"}]
    assert art["weeks"]["1"]["unprojected"]["count"] == 20 and art["weeks"]["1"]["unprojected"]["share"] == 1.0
    json.dumps(art, allow_nan=False)


def test_scored_week_through_full_path_and_provenance():
    ids = [f"{t}{p}{i}" for t in TEAMS for p in POS for i in range(5)]
    art = la.evaluate(_ctx(_publication_git(_ours(ids[:-1]), dirty=True)))
    assert art["weeks_scored"] == [1] and art["points"]["overall"]["n"] == 19
    assert art["weeks"]["1"]["unprojected"]["count"] == 1
    assert art["weeks"]["1"]["publication"]["commit"] == "pub" and art["weeks"]["1"]["cutoff"] == "2026-09-10T00:00:00Z"
    assert set(art["inputs"]["actuals_by_season"]) == {"2025", "2026"}
    assert art["inputs"]["bakeoff"]["sha256"] == hashlib.sha256(la.BAKEOFF_PATH.read_bytes()).hexdigest()
    assert art["evaluator_version"]["id"] == "live-accuracy-v1+tree0+dirty"
    assert art["reference_context"]["transformer_mae_2023_25"] == pytest.approx(4.0)
    assert art["ranking"]["primary"] == {"cells": 0} and art["weeks"]["1"]["primary"]["reason"] == "no_archive"
    json.dumps(art, allow_nan=False)


def test_naive_uses_strictly_prior_games_and_prior_season_fallback():
    weekly, sched = _raw_world()
    prep = sw.prepare(weekly, sched)
    wk1 = sw.week_actuals(prep, 2026, 1).valid
    nv = la.naive_points(prep.features, wk1, 2026)
    row = wk1["player_id"] == "AAAWR0"
    # lag4 of AAAWR0 before 2026 week 1 = its 2025 weeks 1-2: receptions 1, 2 -> 1.5; yards 10, 10 -> 10
    assert float(nv[row].iloc[0]) == pytest.approx(1.5 + 0.1 * 10)
    with pytest.raises(ValueError, match="no position mean"):
        la.naive_points(prep.features[prep.features["position"] == "RB"], wk1, 2026)


def test_missing_team_rows_make_week_incomplete():
    art = la.evaluate(_ctx(_publication_git(_ours(["AAAWR0"])), raw=_raw_world(missing_team_week=(2026, 1, "BBB"))))
    assert art["weeks_skipped"] == [{"week": 1, "reason": "incomplete_week"}]


def test_neutral_only_invalid_player_skips_week_through_evaluate():
    # astra S71-I1 through the evaluator: a same-batch legacy + neutral commit. The neutral file carries the 19
    # legacy players plus one neutral-only player whose zero-weight p50.carries is NaN: 1/20 = 5% > 1%, so the
    # week is validation_failed with the neutral table's counts -- never scored on the surviving legacy table.
    ids = [f"{t}{p}{i}" for t in TEAMS for p in POS for i in range(5)][:19]
    g = _publication_git(_ours(ids))
    neu = _neutral(players=tuple(ids) + ("extra_bad",))
    neu["week"] = 1
    bad = json.loads(json.dumps(neu["players"][-1]["stat_quantiles"]))
    bad["p50"]["carries"] = float("nan")
    neu["players"][-1]["stat_quantiles"] = bad
    g.c["pub"]["files"][NEU] = json.dumps(neu).encode()
    g.c["pub"]["changed"].add(NEU)
    art = la.evaluate(_ctx(g))
    assert art["weeks_scored"] == [] and art["weeks_skipped"] == [{"week": 1, "reason": "validation_failed"}]
    assert art["weeks"]["1"]["values"]["failed_table"] == "neutral"
    proj = art["weeks"]["1"]["validation"]["projections"]
    assert proj["failed"] is True and proj["n_keys"] == 20
    json.dumps(art, allow_nan=False)


IDS = [f"{t}{p}{i}" for t in TEAMS for p in POS for i in range(5)]


def test_live_secondary_needs_the_prior_week_schedule():
    # astra S7-I3 on the live secondary path: 2026 week 1's only game is listed on 09-10 and on 09-11 (conflicting),
    # so week 1 fails; week 2 (09-17) passes and its points are scored. A 09-11 scrape is not compared against
    # week 2 through a manufactured K_2 - 7 days window: the secondary is skipped with schedule_dependency_failed.
    weekly, sched = _raw_world()
    wk1 = sched[(sched["season"] == 2026) & (sched["week"] == 1)]
    sched = pd.concat([sched, wk1.assign(gameday="2026-09-11")], ignore_index=True)
    payload = _legacy(gen="g2", players=_ours(IDS), week=2)
    g = FakeGit({"h0": _c([], changed={"README.md"}, time="2026-07-12T00:00:00Z"),
                 "pub2": _c(["h0"], la.BOT, {LEG}, {LEG: json.dumps(payload).encode()}, "2026-09-15T09:00:00Z")})
    ranks = pd.DataFrame([{"fp_id": f"fp{i}", "player": i, "pos": i[3:5], "team": i[:3], "ecr": float(k + 1),
                           "sd": 1.0, "mergename": i.lower(), "scrape_date": pd.Timestamp("2026-09-11")}
                          for k, i in enumerate(IDS)])
    cw = pd.DataFrame({"gsis_id": IDS, "fantasypros_id": [f"fp{i}" for i in IDS],
                       "merge_name": [i.lower() for i in IDS], "position": [i[3:5] for i in IDS]})
    prep = sw.prepare(weekly, sched)
    assert sorted(prep.schedule.dates(2026)) == [2]
    ctx = la.LiveContext(season=2026, weeks=[1, 2], as_of=pd.Timestamp("2026-09-25"), prepared=prep,
                         rankings=ranks, rankings_raw=None, crosswalk=cw,
                         ledger=_ledger([_ev(1, "pub2", "2026-09-15T10:00:00Z")]), git=g, main_sha="pub2",
                         bakeoff=BAKEOFF, inputs=la.input_hashes(weekly, sched, cw, None, bakeoff_path=la.BAKEOFF_PATH))
    art = la.evaluate(ctx)
    assert art["weeks_skipped"] == [{"week": 1, "reason": "validation_failed", "detail": "schedule_dependency_failed"}]
    assert art["weeks"]["1"]["validation"]["schedule"]["failed"] is True
    assert art["weeks_scored"] == [2]
    sec = art["weeks"]["2"]["secondary"]
    assert sec["status"] == "skipped" and sec["reason"] == "validation_failed"
    assert sec["detail"] == "schedule_dependency_failed" and sec["cells"] == []
    assert art["ranking"]["secondary"] == {"cells": 0}
    json.dumps(art, allow_nan=False)


def _archive_git(archived_ids):
    g = _publication_git(_ours(IDS))
    pts = {i: float(k) for k, i in enumerate(IDS)}
    g.c["pub"]["files"][LEG] = json.dumps(_legacy(gen="g1", week=1, players=[
        (i, i[3:5], i[:3], pts[i] - 3, pts[i], pts[i] + 3) for i in IDS])).encode()
    players = [{"player_id": i, "ecr": float(k + 1), "position": i[3:5], "team": i[:3]}
               for k, i in enumerate(archived_ids)]
    enc = json.dumps({"season": 2026, "week": 1, "snapshot_at": "2026-09-08", "players": players},
                     sort_keys=True, indent=2, allow_nan=False)
    name = f"2026-w01-2026-09-08-{hashlib.sha256(enc.encode()).hexdigest()[:16]}.json"
    g.c["pub"]["files"][f"{la.ARCHIVE_DIR}/{name}"] = enc.encode()
    g.c["pub"]["changed"].add(f"{la.ARCHIVE_DIR}/{name}")
    return g, name, enc


def test_ranking_pool_is_three_way_intersection_and_week_without_rb_coverage():
    wr_only = [i for i in IDS if i[3:5] == "WR"] + ["ZZZWR7"]           # archive lists no RB, plus a non-player
    g, _, _ = _archive_git(wr_only)
    g.c["pub"]["files"][LEG] = json.dumps(_legacy(gen="g1", week=1, players=[
        (i, i[3:5], i[:3], k - 3.0, float(k), k + 3.0) for k, i in enumerate(IDS[:-1])])).encode()
    art = la.evaluate(_ctx(g))
    prim = art["weeks"]["1"]["primary"]
    assert prim["pool"] == 9 and prim["pool_by_position"] == {"WR": 9}   # played ∩ projected ∩ archived
    assert [c["position"] for c in prim["cells"]] == ["WR"]


def test_archive_ranking_values_retained_and_rendered():
    g, name, enc = _archive_git(IDS)
    art = la.evaluate(_ctx(g))
    cells = art["weeks"]["1"]["primary"]["cells"]
    assert {c["position"] for c in cells} == {"RB", "WR"} and all(set(c) == {"position", "n", "sp_ours", "sp_con",
                                                                             "delta"} for c in cells)
    assert art["inputs"]["archive_blobs"] == {name: hashlib.sha256(enc.encode()).hexdigest()}
    art["run"] = {"provisional_weeks": [1]}
    md = la.render_markdown(art)
    row = next(line for line in md.splitlines() if line.startswith("| 1 |"))
    assert row.count("—") == 1 and " / " in row                    # archive column filled, nflverse column "—"


def test_render_markdown_has_provisional_line_and_skips():
    art = {"season": 2026, "weeks_scored": [1], "weeks_skipped": [{"week": 2, "reason": "incomplete_week"}],
           "points": {"overall": {"n": 3, "mae": 4.1, "naive_mae": 4.5, "coverage_p10_p90": 0.8,
                                  "below_p10": 0.1, "above_p90": 0.1},
                      "by_week": {"1": {"n": 3, "mae": 4.1, "naive_mae": 4.5, "coverage_p10_p90": 0.8,
                                        "below_p10": 0.1, "above_p90": 0.1, "last_game": "2026-09-14"}}},
           "weeks": {"1": {}}, "caveats": ["c1"], "run": {"provisional_weeks": [1]}}
    md = la.render_markdown(art)
    assert "Provisional: weeks 1" in md and "| 1 |" in md and "incomplete_week" in md


def test_output_path_follows_current_season():
    from ffmodel.data.pull import current_nfl_season

    assert la.output_path() == la.Path(f"models/diagnostics/live_{current_nfl_season()}_weekly.json")
    assert la.output_path(2027).name == "live_2027_weekly.json"


def test_serialisation_is_deterministic_and_rejects_nan():
    art = la.evaluate(_ctx(_publication_git(_ours(["ZZZWR9"]))))
    art["run"] = {"run_at": "2026-09-20T00:00:00Z", "as_of_date": "2026-09-20", "main_sha": "pub",
                  "provisional_weeks": []}
    again = la.evaluate(_ctx(_publication_git(_ours(["ZZZWR9"]))))
    again["run"] = dict(art["run"])
    assert la.serialise(art) == la.serialise(again)
    with pytest.raises(ValueError):
        la.serialise({"x": float("nan")})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_live_accuracy_metrics.py -q`
Expected: FAIL with `AttributeError: module 'ffmodel.eval.live_accuracy' has no attribute 'ppr_weights'`.

- [ ] **Step 3: Implement**

Replace the import block at the top of `live_accuracy.py` with:

```python
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from ffmodel.baseline.naive import NaiveLast4
from ffmodel.eval import sameweek as sw
from ffmodel.eval.mean_head_gate import paired_bootstrap
from ffmodel.eval.metrics import pinball_loss
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points
from ffmodel.site import leaguelens
```

Then append:

```python
PROTOCOL_VERSION = "live-accuracy-v1"
EQUIV_TOL = 0.01
QUANTILES = ("p10", "p50", "p90")
VALUE_COLUMNS = ["player_id", "position", "team", "p10", "p50", "p90"]
FORMAT_YAML = Path("configs/formats/f12-1qb-ppr-4.yaml")
LEDGER_PATH = Path("models/diagnostics/main_push_ledger.json")
BAKEOFF_PATH = Path("models/backtests/bakeoff.json")
PROVISIONAL_DAYS = 8


def ppr_weights() -> dict:
    return leaguelens.effective_weights(yaml.safe_load(FORMAT_YAML.read_text(encoding="utf-8"))["sleeper_scoring"])


def _legacy_frame(legacy: dict) -> pd.DataFrame:
    rows = []
    for p in legacy.get("players") or []:
        ppr = (p.get("points") or {}).get("ppr") or {}
        rows.append({"player_id": p.get("player_id"), "position": p.get("position"), "team": p.get("team"),
                     **{q: ppr.get(q) for q in QUANTILES}})
    return pd.DataFrame(rows, columns=VALUE_COLUMNS).astype({q: float for q in QUANTILES})


NEUTRAL_COMPONENTS = [f"{q}:{s}" for q in QUANTILES for s in PREDICTED_STATS]


def _number(v) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else np.nan


def _neutral_stats_frame(neutral: dict) -> pd.DataFrame:
    """One row per neutral record: identity, every PREDICTED_STATS component in all three quantiles (missing or
    non-numeric -> NaN), and `vector`, the canonical full stat_quantiles, so records whose vectors differ in ANY
    component are a conflicting key even when they score to the same points (spec §4.1, astra S7-I4)."""
    rows = []
    for p in neutral.get("players") or []:
        sq = p.get("stat_quantiles")
        row = {"player_id": p.get("player_id"), "position": p.get("position"), "team": p.get("team"),
               "vector": json.dumps(sq, sort_keys=True, default=str)}
        for q in QUANTILES:
            block = sq.get(q) if isinstance(sq, dict) else None
            for s in PREDICTED_STATS:
                row[f"{q}:{s}"] = _number(block.get(s)) if isinstance(block, dict) else np.nan
        rows.append(row)
    return pd.DataFrame(rows, columns=["player_id", "position", "team", "vector", *NEUTRAL_COMPONENTS])


def validate_neutral(stats: pd.DataFrame) -> sw.TableValidation:
    """§3.7 on the full neutral stat vectors, before any scoring: identity and duplicates, every component finite
    in all three quantiles (zero-weight components included) and p10 <= p50 <= p90 per component."""
    disorder = pd.Series(False, index=stats.index)
    for s in PREDICTED_STATS:
        lo, mid, hi = (stats[f"{q}:{s}"].astype(float) for q in QUANTILES)
        finite = np.isfinite(lo) & np.isfinite(mid) & np.isfinite(hi)
        disorder |= finite & ~((lo <= mid) & (mid <= hi))
    return sw.validate_table(stats, ["player_id"], NEUTRAL_COMPONENTS, ["team", "position", "vector"],
                             extra_invalid={"quantile_order": disorder}, position_col="position")


def _neutral_projections(neutral: dict, weights: dict) -> sw.TableValidation:
    """The neutral projection table: validated on full stat vectors first, then only valid rows are re-scored in
    PPR. A row the scorer still rejects (e.g. a weighted stat outside PREDICTED_STATS) is invalid as non-finite.
    Counts and the 1% rule cover every neutral key, never only the survivors."""
    players = neutral.get("players") or []
    nv = validate_neutral(_neutral_stats_frame(neutral))
    rows = []
    for i in nv.valid.index:
        p = players[i]
        try:
            s = leaguelens.reference_score(p.get("stat_quantiles"), p.get("position"), weights)
        except ValueError:
            s = {q: None for q in QUANTILES}
        rows.append({"player_id": p.get("player_id"), "position": p.get("position"), "team": p.get("team"), **s})
    scored = pd.DataFrame(rows, columns=VALUE_COLUMNS).astype({q: float for q in QUANTILES})
    sv = sw.validate_projections(scored)
    invalid = {r: set(k) for r, k in nv.invalid.items()}
    for r, k in sv.invalid.items():
        invalid.setdefault(r, set()).update(k)
    return sw.TableValidation(valid=sv.valid, invalid=invalid, n_keys=nv.n_keys, exact_duplicates=nv.exact_duplicates,
                              key_position=nv.key_position)


def _carries(payload, season: int, week: int) -> bool:
    return isinstance(payload, dict) and payload.get("season") == season and payload.get("week") == week


def equivalence(lv: sw.TableValidation, nv: sw.TableValidation) -> dict:
    """Spec §4.1 equivalence over the two VALIDATED tables (the neutral one on full stat vectors): equal valid
    player sets, every quantile finite and within 0.01."""
    lids, nids = set(lv.valid["player_id"]), set(nv.valid["player_id"])
    detail = {"invalid_legacy": sorted(k[0] for k in lv.invalid_keys()),
              "invalid_neutral": sorted(k[0] for k in nv.invalid_keys()),
              "missing_in_neutral": sorted(lids - nids), "missing_in_legacy": sorted(nids - lids),
              "divergent": [], "max_abs_diff": None}
    if lids != nids or not lids:
        return {"ok": False, **detail}
    both = lv.valid.set_index("player_id")[list(QUANTILES)].join(
        nv.valid.set_index("player_id")[list(QUANTILES)], rsuffix="_n", how="inner")
    diffs = np.column_stack([(both[q] - both[f"{q}_n"]).abs().to_numpy(float) for q in QUANTILES])
    bad = ~np.isfinite(diffs) | (diffs > EQUIV_TOL)
    detail["divergent"] = sorted(both.index[bad.any(axis=1)])
    detail["max_abs_diff"] = float(np.max(diffs)) if np.isfinite(diffs).all() else None
    return {"ok": not bad.any(), **detail}


def published_values(legacy, neutral, weights: dict, season: int, week: int):
    """(projections, reason, detail). `projections` is the validated projection table (sw.TableValidation): its
    `valid` rows (VALUE_COLUMNS) are scored and its counts drive the 1% rule. Legacy points.ppr when the commit
    carries a week-N legacy file, else the neutral stat quantiles, validated on full vectors and then re-scored in
    PPR. A same-batch pair must pass `equivalence` or the week is skipped. Before equivalence, BOTH validated tables
    must pass the 1% rule (spec §3.7, astra S71-I1): a failed table is returned as `projections` with no reason, so
    the caller's `.fails()` check skips the week as `validation_failed` and reports that table's counts."""
    leg = legacy if _carries(legacy, season, week) else None
    neu = neutral if _carries(neutral, season, week) else None
    if leg is None and neu is None:
        raise ValueError(f"selected commit carries no season {season} week {week} payload")
    if leg is None:
        return _neutral_projections(neu, weights), None, {"source": "neutral", "equivalence_checked": False}
    lv = sw.validate_projections(_legacy_frame(leg))
    if neu is None or neu.get("generated_at") != leg.get("generated_at"):
        return lv, None, {"source": "legacy", "equivalence_checked": False}
    nv = _neutral_projections(neu, weights)
    for name, table in (("legacy", lv), ("neutral", nv)):
        if table.fails():
            return table, None, {"source": name, "equivalence_checked": False, "failed_table": name}
    eq = equivalence(lv, nv)
    if not eq["ok"]:
        return None, "equivalence_failed", {"source": "legacy", "equivalence_checked": True, **eq}
    return lv, None, {"source": "legacy", "equivalence_checked": True, "max_abs_diff": eq["max_abs_diff"]}


def naive_points(features: pd.DataFrame, rows: pd.DataFrame, season: int) -> pd.Series:
    """NaiveLast4 scored in PPR; NaN lags fall back to the position mean over feature rows with season < S."""
    model = NaiveLast4()
    model.fit(features[features["season"] < season])
    missing = set(rows["position"]) - set(model._pos_means.dropna().index)
    if missing:
        raise ValueError(f"naive fallback has no position mean for {sorted(missing)}")
    return fantasy_points(model.predict(rows), PPR)


def _mean(x) -> float | None:
    return float(np.mean(x)) if len(x) else None


def point_metrics(df: pd.DataFrame) -> dict:
    """Undefined metrics are None, never NaN, so artifacts serialise with allow_nan=False (astra P6)."""
    y, p50 = df["actual"].to_numpy(float), df["p50"].to_numpy(float)
    lo, hi, nv = df["p10"].to_numpy(float), df["p90"].to_numpy(float), df["naive"].to_numpy(float)
    resid = y - p50
    n = len(df)
    return {"n": int(n), "mae": _mean(np.abs(resid)), "naive_mae": _mean(np.abs(y - nv)),
            "mean_resid": _mean(resid), "median_resid": float(np.median(resid)) if n else None,
            "share_above_p50": _mean(y > p50), "coverage_p10_p90": _mean((y >= lo) & (y <= hi)),
            "below_p10": _mean(y < lo), "above_p90": _mean(y > hi),
            "pinball_p10": float(pinball_loss(y, lo, 0.1)) if n else None,
            "pinball_p50": float(pinball_loss(y, p50, 0.5)) if n else None,
            "pinball_p90": float(pinball_loss(y, hi, 0.9)) if n else None}


def paired_intervals(df: pd.DataFrame) -> dict:
    delta = (np.abs(df["actual"] - df["p50"]) - np.abs(df["actual"] - df["naive"])).to_numpy(float)
    by_player = paired_bootstrap(delta, df["player_id"].astype(str).to_numpy(), n_boot=sw.N_BOOT, seed=sw.BOOT_SEED)
    games = (df["week"].astype(str) + "|" + df["team"].astype(str)).to_numpy()
    by_game = paired_bootstrap(delta, games, n_boot=sw.N_BOOT, seed=sw.BOOT_SEED)
    return {"delta_mae_model_minus_naive": float(delta.mean()), "ci95_player": by_player["ci95"],
            "ci95_week_team": by_game["ci95"], "note": "conditional on the observed weeks"}


def week_complete(prep: sw.Prepared, season: int, week: int) -> bool:
    """team_presence_complete (spec §3.3): every scheduled team of the week has at least one played row."""
    teams = sw.week_teams(prep.schedule.games, season, week)
    f = prep.features
    have = set(f.loc[(f["season"] == season) & (f["week"] == week), "team"])
    return bool(teams) and teams <= have


def unprojected_summary(unproj: pd.DataFrame, played: pd.DataFrame) -> dict:
    def block(g: pd.DataFrame, n: int) -> dict:
        return {"count": int(len(g)), "share": (len(g) / n) if n else None, "mean_actual": _mean(g["actual"])}

    return {**block(unproj, len(played)),
            "by_position": {p: block(unproj[unproj["position"] == p], int((played["position"] == p).sum()))
                            for p in sorted(set(played["position"]))}}


def frame_sha256(df) -> str | None:
    if df is None:
        return None
    return hashlib.sha256(pd.util.hash_pandas_object(df, index=False).values.tobytes()).hexdigest()


def file_sha256(path: Path) -> str | None:
    p = Path(path)
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None


def input_hashes(weekly_raw: pd.DataFrame, schedules_raw: pd.DataFrame, crosswalk, rankings_raw,
                 bakeoff_path: Path = BAKEOFF_PATH) -> dict:
    """Spec §4.6 inputs: actuals for EVERY pulled season (the naive fallback means read prior seasons)."""
    return {"actuals_by_season": {str(int(s)): frame_sha256(g) for s, g in weekly_raw.groupby("season")},
            "schedules": frame_sha256(schedules_raw), "crosswalk": frame_sha256(crosswalk),
            "rankings_raw": frame_sha256(rankings_raw),
            "bakeoff": {"path": str(bakeoff_path), "sha256": file_sha256(bakeoff_path)}}


def evaluator_version(git, protocol: str) -> dict:
    """Spec §4.6: the CALLING artifact's own protocol version (live-accuracy-v1, sameweek-v1 or
    sleeper-compare-v1) + the tree id of src/ffmodel in the EXECUTING checkout + a dirty flag."""
    tree, dirty = git.tree_id("src/ffmodel"), bool(git.dirty("src/ffmodel"))
    return {"protocol_version": protocol, "src_ffmodel_tree": tree, "dirty": dirty,
            "id": f"{protocol}+{tree}" + ("+dirty" if dirty else "")}


@dataclass
class LiveContext:
    season: int
    weeks: list[int] | None          # None = every REG week whose K_N is before as_of
    as_of: pd.Timestamp              # run date (UTC, normalised, tz-naive)
    prepared: sw.Prepared            # sw.prepare over seasons S-3..S
    rankings: pd.DataFrame | None    # normalize_weekly_rankings(raw) for the secondary
    rankings_raw: pd.DataFrame | None
    crosswalk: pd.DataFrame | None
    ledger: dict
    git: object
    main_sha: str
    bakeoff: dict
    inputs: dict                     # input_hashes(...)


def _ranking_block(cells: list[dict]) -> dict:
    if not cells:
        return {"cells": 0}
    df = pd.DataFrame(cells)
    st = sw.delta_stats(df)
    return {"cells": int(len(df)), "sp_ours": float(df["sp_ours"].mean()), "sp_con": float(df["sp_con"].mean()),
            "D": st["D"], "ci_week": st["ci_week"],
            "per_position_D": {p: float((g["sp_ours"] - g["sp_con"]).mean()) for p, g in df.groupby("position")}}


def _reference(bakeoff: dict) -> dict:
    rows = [r for r in bakeoff["results"] if r["position"] == "OVERALL"]

    def nw(model, key):
        rs = [r for r in rows if r["model"] == model and r.get(key) is not None]
        return sum(r[key] * r["n"] for r in rs) / sum(r["n"] for r in rs)

    cov = {str(r["test_season"]): r["coverage_p10_p90"] for r in rows if r["model"] == "transformer"}
    return {"label": "context: different population and fallback history",
            "transformer_mae_2023_25": nw("transformer", "mae"), "naive_mae_2023_25": nw("naive_last4", "mae"),
            "coverage_by_season": cov}


def _primary(ctx: LiveContext, joined: pd.DataFrame, N: int, cutoff, rec: dict, blobs: dict) -> list[dict]:
    arc = select_archive(ctx.ledger, ctx.git, ctx.season, N, cutoff, ctx.main_sha)
    rec["expert_snapshot"] = {k: v for k, v in arc.items() if k != "consensus"}
    for item in [arc, *arc["alternatives"]]:
        if item.get("name") and item.get("blob_sha256"):
            blobs[item["name"]] = item["blob_sha256"]
    if arc["status"] != "selected":
        rec["primary"] = {"status": "skipped", "reason": arc["status"], "cells": []}
        return []
    pool = joined.rename(columns={"p50": "our_pts"}).merge(arc["consensus"][["player_id", "ecr"]], on="player_id")
    cells, deg = sw.build_cells(pool, ctx.season, N, "archive")
    rec["primary"] = {"status": "scored" if cells else "skipped", "reason": None if cells else "no_scorable_cell",
                      "cells": sw.cell_summary(cells), "degenerate": deg, "pool": int(len(pool)),
                      "pool_by_position": pool["position"].value_counts().sort_index().astype(int).to_dict()}
    return cells


def evaluate(ctx: LiveContext) -> dict:
    S, git, prep = ctx.season, ctx.git, ctx.prepared
    dates = prep.schedule.dates(S)                       # K_N/Z_N only for weeks whose schedule slice passes
    due = sw.week_dates(prep.schedule.games, S)          # which weeks have started: listing only, never a cutoff
    weeks = ctx.weeks or [w for w in sorted(due) if due[w][0] < ctx.as_of]
    weights = ppr_weights()
    index = candidate_index(ctx.ledger, git, S, ctx.main_sha)
    scored_frames, skipped, per_week, blobs = [], [], {}, {}
    primary_cells, secondary_cells = [], []
    for N in weeks:
        if N not in dates:
            per_week[str(N)] = {"validation": {"schedule": prep.schedule.week_validation(S, N).report()}}
            skipped.append({"week": N, "reason": "validation_failed", "detail": "schedule_dependency_failed"})
            continue
        K, Z = dates[N]
        cutoff = pd.Timestamp(K).tz_localize("UTC")
        rec = {"cutoff": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"), "last_game": str(Z.date())}
        per_week[str(N)] = rec
        if not week_complete(prep, S, N):
            skipped.append({"week": N, "reason": "incomplete_week"})
            continue
        pub = select_publication(ctx.ledger, git, S, N, cutoff, ctx.main_sha, index=index)
        rec["publication"] = pub
        if pub["status"] != "selected":
            skipped.append({"week": N, "reason": pub["status"], "detail": pub["detail"]})
            continue
        legacy, neutral = read_payloads(git, pub["commit"])
        vp, reason, detail = published_values(legacy, neutral, weights, S, N)
        rec["values"] = detail
        if reason:
            skipped.append({"week": N, "reason": reason})
            continue
        wi = sw.week_inputs(prep, S, N)
        rec["validation"] = {"projections": vp.report(), **wi["report"]}
        if vp.fails() or wi["failed"]:
            skipped.append({"week": N, "reason": "validation_failed"})
            continue
        act = wi["actuals"].valid.copy()
        act["actual"] = fantasy_points(act[PREDICTED_STATS], PPR).to_numpy()
        act["naive"] = naive_points(prep.features, act, S).to_numpy()
        joined = act[["player_id", "position", "team", "week", "actual", "naive"]].merge(
            vp.valid[["player_id", "p10", "p50", "p90"]], on="player_id", how="left")
        unproj = joined[joined["p50"].isna()]
        joined = joined.dropna(subset=["p50"]).reset_index(drop=True)
        rec["unprojected"] = unprojected_summary(unproj, act)
        if joined.empty:
            rec["status"] = "no_scorable_points"
            skipped.append({"week": N, "reason": "no_scorable_points"})
            continue
        rec["status"] = "scored"
        rec["points"] = point_metrics(joined)
        scored_frames.append(joined)
        primary_cells += _primary(ctx, joined, N, cutoff, rec, blobs)
        if ctx.rankings is not None and ctx.crosswalk is not None:
            played = joined.rename(columns={"p50": "our_pts"})[["player_id", "position", "team", "our_pts", "actual"]]
            res = sw.sameweek_week(played, prep.schedule, ctx.rankings, ctx.crosswalk, S, N, dates)
            secondary_cells += res["cells"]
            rec["secondary"] = {**{k: v for k, v in res.items() if k != "cells"},
                                "cells": sw.cell_summary(res["cells"])}
    allrows = pd.concat(scored_frames, ignore_index=True) if scored_frames else None
    points = {}
    if allrows is not None:
        points = {"overall": {**point_metrics(allrows), **paired_intervals(allrows)},
                  "by_position": {p: point_metrics(g) for p, g in allrows.groupby("position")},
                  "by_week": {str(w): {**point_metrics(g), "last_game": per_week[str(w)]["last_game"]}
                              for w, g in allrows.groupby("week")}}
    inputs = {**ctx.inputs, "archive_blobs": dict(sorted(blobs.items())),
              "ledger": {"sha256": ledger_sha256(ctx.ledger), "events": len(ctx.ledger["events"]),
                         "coverage": ctx.ledger["coverage"]}}
    coverage = (sw.ranking_coverage(ctx.rankings_raw, ctx.rankings, [S])
                if ctx.rankings is not None and ctx.rankings_raw is not None else {})
    return {"protocol_version": PROTOCOL_VERSION, "evaluator_version": evaluator_version(git, PROTOCOL_VERSION),
            "season": S,
            "inputs": inputs, "ranking_coverage": coverage,
            "weeks_scored": sorted(int(w) for w in (allrows["week"].unique() if allrows is not None else [])),
            "weeks_skipped": skipped, "weeks": per_week, "points": points,
            "ranking": {"primary": _ranking_block(primary_cells), "secondary": _ranking_block(secondary_cells)},
            "reference_context": {**_reference(ctx.bakeoff), "source": ctx.inputs.get("bakeoff")},
            "caveats": ["Projections = the bot pipeline's latest publication on main before K_N 00:00 UTC, proven "
                        "by GitHub push records; Vercel deployment is not verified.",
                        "Players who recorded a stat line only; DNPs are outside the estimand.",
                        "Both expert sources are FantasyPros mirrors; small samples are descriptive, not tests.",
                        "Reference values are context: the historical population and fallback history differ."]}


def _week_rank_cell(rec: dict, source: str) -> str:
    cells = (rec.get(source) or {}).get("cells") or []
    if not cells:
        return "—"
    return f"{np.mean([c['sp_ours'] for c in cells]):.3f} / {np.mean([c['sp_con'] for c in cells]):.3f}"


def _pct(x) -> str:
    return "—" if x is None else f"{x:.1%}"


def _num(x) -> str:
    return "—" if x is None else f"{x:.2f}"


def render_markdown(art: dict) -> str:
    o = art.get("points", {}).get("overall")
    lines = [f"# Live weekly accuracy — {art['season']}", ""]
    if o:
        lines.append(f"Through weeks {', '.join(map(str, art['weeks_scored']))}: MAE {_num(o['mae'])} vs naive "
                     f"{_num(o['naive_mae'])}; p10–p90 coverage {_pct(o['coverage_p10_p90'])} (below "
                     f"{_pct(o['below_p10'])}, above {_pct(o['above_p90'])}).")
    else:
        lines.append("No complete weeks scored yet.")
    prov = art.get("run", {}).get("provisional_weeks", [])
    lines += ["", f"Provisional: weeks {', '.join(map(str, prov)) if prov else 'none'}", "",
              "| week | last game | n | MAE | naive MAE | coverage | below | above | ours / consensus (archive) "
              "| ours / consensus (nflverse) |", "|---|---|---|---|---|---|---|---|---|---|"]
    weeks = art.get("weeks", {})
    for w, m in sorted(art.get("points", {}).get("by_week", {}).items(), key=lambda kv: int(kv[0])):
        rec = weeks.get(w, {})
        lines.append(f"| {w} | {m.get('last_game', '')} | {m['n']} | {_num(m['mae'])} | {_num(m['naive_mae'])} | "
                     f"{_pct(m['coverage_p10_p90'])} | {_pct(m['below_p10'])} | {_pct(m['above_p90'])} | "
                     f"{_week_rank_cell(rec, 'primary')} | {_week_rank_cell(rec, 'secondary')} |")
    for s in art.get("weeks_skipped", []):
        lines.append(f"- week {s['week']} skipped: {s['reason']}")
    lines += ["", *[f"- {c}" for c in art.get("caveats", [])], ""]
    return "\n".join(lines)


def serialise(art: dict) -> str:
    return json.dumps(art, indent=1, sort_keys=True, allow_nan=False) + "\n"


def output_path(season: int | None = None) -> Path:
    """models/diagnostics/live_<S>_weekly.json with S = current_nfl_season() unless given (spec §4.6)."""
    from ffmodel.data.pull import current_nfl_season

    return Path(f"models/diagnostics/live_{season or current_nfl_season()}_weekly.json")


def main(argv=None) -> int:
    from ffmodel.data.pull import LIVE_MAX_AGE_HOURS, _cached, current_nfl_season, pull_schedules, pull_weekly
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
    now = dt.datetime.now(dt.timezone.utc)
    ledger = load_ledger(LEDGER_PATH)
    if not args.no_fetch:
        ledger = merge_collection(ledger, fetch_activity(args.repo), t_end=now.strftime("%Y-%m-%dT%H:%M:%SZ"))
    git = Git(".")
    main_sha = git.rev_parse(args.main_ref)
    spans = list(range(S - 3, S + 1))
    weekly, schedules = pull_weekly(spans, cache_dir=data_dir), pull_schedules(spans, cache_dir=data_dir)

    def load_rankings() -> pd.DataFrame:
        import nflreadpy

        return nflreadpy.load_ff_rankings("all").to_pandas()

    raw = _cached(data_dir, "ff_rankings_all_raw", load_rankings, LIVE_MAX_AGE_HOURS)
    crosswalk = pull_player_ids(data_dir)
    as_of = pd.Timestamp(now.date())
    ctx = LiveContext(season=S, weeks=weeks, as_of=as_of, prepared=sw.prepare(weekly, schedules),
                      rankings=normalize_weekly_rankings(raw), rankings_raw=raw, crosswalk=crosswalk, ledger=ledger,
                      git=git, main_sha=main_sha, bakeoff=json.loads(BAKEOFF_PATH.read_text(encoding="utf-8")),
                      inputs=input_hashes(weekly, schedules, crosswalk, raw))
    art = evaluate(ctx)
    dates = ctx.prepared.schedule.dates(S)
    art["run"] = {"run_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "as_of_date": str(as_of.date()), "main_sha": main_sha,
                  "provisional_weeks": [w for w in art["weeks_scored"]
                                        if (as_of - dates[w][1]).days < PROVISIONAL_DAYS]}
    text = serialise(art)
    if args.frozen_record:
        args.frozen_record.write_text(text, encoding="utf-8")
        return 0
    out = output_path(S)
    out.write_text(text, encoding="utf-8")
    out.with_suffix(".md").write_text(render_markdown(art), encoding="utf-8")
    if not args.no_fetch:
        save_ledger(ledger, LEDGER_PATH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Notes for the implementer:
- `evaluate` never calls `point_metrics` on an empty intersection: an empty pool is recorded as
  `no_scorable_points` with its unprojected counts and contributes nothing to pooled metrics.
- A neutral payload is validated on its full stat vectors before anything is scored (astra S7-I4); validity is
  never inferred from the scored points, and the neutral table's counts (every key, not the survivors) drive both
  the 1% rule and equivalence.
- Cutoffs come only from `prep.schedule.dates(S)`. A week whose own schedule slice fails is skipped with
  `validation_failed` / `schedule_dependency_failed`; a week whose N−1 slice fails still has its points scored,
  but its nflverse secondary is skipped with the same reason by `sameweek_week` (astra S7-I3).
- The CLI's network and git calls are not unit-tested; Task 10's acceptance run and the first live run cover them.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_live_accuracy_metrics.py tests/test_live_accuracy_evidence.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/live_accuracy.py tests/test_live_accuracy_metrics.py
git commit -m "feat(live_accuracy): validated published values with full equivalence, point metrics, no_scorable_points, retained rankings, provenance, CLI (spec §4.1-4.6)"
```

---

### Task 7: sleeper_compare — the private Sleeper comparator

**Model:** implementer sonnet (transcription); reviewer **opus** (numerics, identity, privacy).

**Files:**
- Create: `src/ffmodel/eval/sleeper_compare.py`
- Test: `tests/test_sleeper_compare.py`

**Interfaces:**
- Consumes:
  - the snapshot store contract of spec §4.8.1, written by the separate collector (`ffmodel.collect.market_snapshots`,
    another branch): files `sleeper/<S>/w<NN>/<YYYY-MM-DDTHH-MM-SSZ>.json.gz` (gzipped raw response) and
    `sleeper/manifest.jsonl` lines with keys `retrieved_at, sha256, season, week, path, request_url, http_status,
    records, source_updated_at_min, source_updated_at_max, source_updated_at_count, published_commit,
    published_batch_id, capture_kind` (`http_status` and `published_*` may be null when `capture_kind` is
    `"manual"`). `path` is relative to the private checkout root; `sha256` is of the decompressed response bytes.
  - the public artifact from Task 6 (`season`, `weeks_scored`, `weeks[<N>].cutoff`,
    `weeks[<N>].publication.{commit, available_by}`); it reads these instead of repeating §4.1;
  - `live_accuracy.read_payloads`, `published_values`, `ppr_weights`, `week_complete`, `evaluator_version`,
    `frame_sha256`, `file_sha256`, `Git`, `_ts`; `sameweek.prepare`, `week_inputs`, `validate_table`;
    `weekly_rankings.goodness_spearman`.
- Produces:
  - `SLEEPER_TO_STAT`, `RELEVANT_POINTS = 8.0`, `PAIR_WINDOW`, `FIRST_COMPARABLE_WEEK = {2026: 5}`, `CLAIMS`
  - `load_manifest(root) -> list[dict]`
  - `choose_snapshots(manifest, season, week, available_by, cutoff) -> dict` (`paired`, `latest`, `latest_gap_hours`)
  - `read_capture(root, cap) -> list[dict]` (raises `SnapshotIntegrityError` on a missing file or sha mismatch)
  - `crosswalk_map(crosswalk) -> tuple[dict, set]`
  - `sleeper_frame(records, season, week) -> pd.DataFrame`
  - `validate_sleeper(frame, crosswalk) -> dict` (`validation`, `rows` with `sleeper_pts`, `unmapped`, reconciliation)
  - `compare_rows(played, ours, sleeper) -> pd.DataFrame`, `relevant(rows)`, `missingness(played, ours_ids, sleeper_ids)`
  - `view_metrics(rows) -> dict`, `season_end(rows) -> dict`
  - `private_input_hashes(weekly, schedules, crosswalk, artifact_bytes) -> dict`
  - `run(snapshots, artifact, prepared, crosswalk, git, season_end_read=False, inputs=None, run_at=None) -> dict`
    (the report carries `provenance`: `evaluator_version` with protocol `sleeper-compare-v1`, `run_at`, `inputs`
    plus the manifest hash, and `selected_captures` (path, sha256))
  - `render_markdown(report)`, `write_report(report, out_dir) -> list[Path]`, `main(argv=None, load_inputs=..., git=None) -> int`
    (`load_inputs(season, data_dir) -> (weekly, schedules, crosswalk)`, the raw private pull)

Decisions this module encodes (spec §4.8). The second bullet (how the season-end p-values are formed) is not
fixed by the spec; it is flagged for a spec decision, to be made before that read:
- Weekly runs compute per-week and cumulative numbers only. The Holm decision is computed only with
  `--season-end` (the one read after the last REG week, spec §8 step 8).
- A claim's p-value is the two-sided percentile-bootstrap p of the mean paired delta, taken as the **larger** of the
  player-clustered and `week|team`-clustered values; Holm then runs across the two primary claims at 0.05.
- Only weeks in the public artifact's `weeks_scored` are compared. Scheduled captures need `http_status == 200`;
  manual captures are eligible. A selected capture that fails its integrity check skips that variant with
  `snapshot_integrity_failed`; another capture is never promoted.
- The private actuals, schedule and crosswalk are a separate data vintage (spec §4.8.5, astra S7-I5). Each week the
  public artifact scored is re-checked on them: `week_complete` (else `private_inputs_incomplete`), then §3.7 (else
  `validation_failed`, with the report). The public run's decision is never borrowed, and the report's
  `provenance` hashes exactly the inputs this run read.

- [ ] **Step 1: Write the failing tests**

```python
"""Spec §4.8 private Sleeper comparator on synthetic snapshots (no real Sleeper data in this public repo)."""
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ffmodel.eval import live_accuracy as la
from ffmodel.eval import sameweek as sw
from ffmodel.eval import sleeper_compare as sc
from tests.test_live_accuracy_evidence import FakeGit, _c
from tests.test_live_accuracy_metrics import POS, TEAMS, _legacy, _raw_world

AVAIL, CUT = "2026-09-09T10:00:00Z", "2026-09-10T00:00:00Z"


def _cap(t, kind="scheduled", status=200, season=2026, week=1):
    return {"retrieved_at": t, "season": season, "week": week, "capture_kind": kind, "http_status": status,
            "path": f"sleeper/{season}/w{week:02d}/{t.replace(':', '-')}.json.gz", "sha256": "x"}


def test_snapshot_choice_paired_latest_and_none():
    m = [_cap("2026-09-09T08:00:00Z"), _cap("2026-09-09T12:00:00Z"), _cap("2026-09-09T22:00:00Z"),
         _cap("2026-09-10T00:00:01Z"), _cap("2026-09-09T10:30:00Z", status=500)]
    ch = sc.choose_snapshots(m, 2026, 1, AVAIL, CUT)
    assert ch["paired"]["retrieved_at"] == "2026-09-09T08:00:00Z"          # 2 h each side: ties to the earlier
    assert ch["latest"]["retrieved_at"] == "2026-09-09T22:00:00Z" and ch["latest_gap_hours"] == pytest.approx(12.0)
    far = sc.choose_snapshots([_cap("2026-09-07T09:00:00Z")], 2026, 1, AVAIL, CUT)
    assert far["paired"] is None and far["latest"] is not None                # outside 24 h: latest only
    none = sc.choose_snapshots([_cap("2026-09-10T01:00:00Z")], 2026, 1, AVAIL, CUT)
    assert none == {"paired": None, "latest": None, "latest_gap_hours": None}
    manual = sc.choose_snapshots([_cap("2026-09-09T11:00:00Z", kind="manual", status=None)], 2026, 1, AVAIL, CUT)
    assert manual["paired"] is not None


def _rec(pid, pos="WR", stats=None, season="2026", week=1, category="proj"):
    return {"player_id": pid, "category": category, "season": season, "week": week,
            "player": {"position": pos}, "stats": stats if stats is not None else {"rec": 3.0, "rec_yd": 40.0,
                                                                                   "pts_ppr": 7.0}}


def test_scoring_absent_key_zero_present_null_invalid_missing_pts_invalid():
    recs = [_rec("1"), _rec("2", stats={"rec": None, "pts_ppr": 1.0}), _rec("3", stats={"rec": 2.0}),
            _rec("4", pos="K"), _rec("5", season="2025"), _rec("6", category="stat")]
    frame = sc.sleeper_frame(recs, 2026, 1)
    assert list(frame["sleeper_id"]) == ["1", "2", "3"]
    assert frame.loc[0, "rushing_yards"] == 0.0                               # absent mapped key = 0
    cw = pd.DataFrame({"sleeper_id": [1.0, 2.0, 3.0], "gsis_id": ["g1", "g2", "g3"]})
    vs = sc.validate_sleeper(frame, cw)
    assert vs["validation"].invalid_keys() == {("2",), ("3",)}                 # present null; missing pts_ppr
    assert vs["rows"]["sleeper_pts"].tolist() == pytest.approx([3.0 + 4.0])  # hand re-score: 3 rec + 40 yd PPR


@pytest.mark.parametrize("pos,stats,expected", [
    ("QB", {"pass_yd": 250.0, "pass_td": 2.0, "pass_int": 1.0, "rush_yd": 20.0, "pts_ppr": 1.0}, 10 + 8 - 2 + 2),
    ("RB", {"rush_att": 15.0, "rush_yd": 70.0, "rush_td": 1.0, "rec": 2.0, "rec_yd": 15.0, "fum_lost": 1.0,
            "pts_ppr": 1.0}, 7 + 6 + 2 + 1.5 - 2),
    ("TE", {"rec_tgt": 6.0, "rec": 4.0, "rec_yd": 45.0, "rec_td": 1.0, "rec_2pt": 1.0, "pts_ppr": 1.0}, 4 + 4.5 + 6),
])
def test_hand_computed_rescore_per_position(pos, stats, expected):
    vs = sc.validate_sleeper(sc.sleeper_frame([_rec("1", pos=pos, stats=stats)], 2026, 1),
                             pd.DataFrame({"sleeper_id": ["1"], "gsis_id": ["g1"]}))
    assert vs["rows"]["sleeper_pts"].iloc[0] == pytest.approx(expected)       # rec_2pt is not a common component


def test_crosswalk_collisions_invalidate_every_row_involved():
    frame = sc.sleeper_frame([_rec(str(i)) for i in range(1, 6)], 2026, 1)
    cw = pd.DataFrame({"sleeper_id": [1.0, 1.0, 2.0, 3.0, 4.0], "gsis_id": ["g1", "gX", "g2", "g2", "g4"]})
    vs = sc.validate_sleeper(frame, cw)
    assert vs["validation"].invalid["crosswalk_collision"] == {("1",), ("2",), ("3",)}   # one-to-many, many-to-one
    assert vs["unmapped"] == 1 and vs["rows"]["player_id"].tolist() == ["g4"]


def _rows(n=12):
    rng = np.random.default_rng(3)
    df = pd.DataFrame({"player_id": [f"p{i}" for i in range(n)], "position": ["WR"] * n, "team": ["AAA"] * n,
                       "week": [5] * n, "actual": rng.uniform(0, 20, n), "ours": rng.uniform(0, 20, n),
                       "sleeper": rng.uniform(0, 20, n)})
    return df.assign(blend=0.5 * df["ours"] + 0.5 * df["sleeper"])


def test_relevant_union_uses_projections_only_and_blend_is_half_half():
    played = pd.DataFrame({"player_id": ["a", "b", "c"], "position": "WR", "team": "AAA", "week": 5,
                           "actual": [30.0, 0.0, 0.0]})
    ours = pd.DataFrame({"player_id": ["a", "b", "c"], "p50": [2.0, 9.0, 3.0]})
    slp = pd.DataFrame({"player_id": ["a", "b", "c"], "sleeper_pts": [3.0, 1.0, 8.0]})
    rows = sc.compare_rows(played, ours, slp)
    assert rows["blend"].tolist() == [2.5, 5.0, 5.5]
    assert sc.relevant(rows)["player_id"].tolist() == ["b", "c"]               # a scored 30 but projected < 8


def test_view_metrics_three_paired_deltas():
    rows = _rows()
    m = sc.view_metrics(rows)
    assert set(m["deltas"]) == {"ours_minus_sleeper", "blend_minus_sleeper", "blend_minus_ours"}
    expected = np.mean(np.abs(rows.actual - rows.ours) - np.abs(rows.actual - rows.sleeper))
    assert m["deltas"]["ours_minus_sleeper"]["mean"] == pytest.approx(expected)
    assert len(m["deltas"]["ours_minus_sleeper"]["ci95_player"]) == 2 and m["spearman_cells"]
    assert sc.view_metrics(rows.head(0))["n"] == 0


def test_missingness_per_side():
    played = pd.DataFrame({"player_id": ["a", "b", "c"], "position": ["WR", "WR", "RB"]})
    assert sc.missingness(played, {"a"}, {"a", "c"}) == {
        "RB": {"played": 1, "ours_missing": 1, "sleeper_missing": 0, "both_missing": 0},
        "WR": {"played": 2, "ours_missing": 1, "sleeper_missing": 1, "both_missing": 1}}


def test_season_end_holm():
    rows = _rows(40).assign(sleeper=lambda d: d["actual"] + 5.0)              # Sleeper always 5 off
    rows = rows.assign(ours=rows["actual"] + 0.1, blend=0.5 * (rows["actual"] + 0.1) + 0.5 * rows["sleeper"])
    r = sc.season_end(rows)
    assert [c["outcome"] for c in r["claims"]] == ["ours_lower_error", "blend_lower_error"]
    tie = _rows(40)
    tie = tie.assign(sleeper=tie["ours"], blend=tie["ours"])
    assert all(c["outcome"] == "inconclusive" for c in sc.season_end(tie)["claims"])


# --- end to end: run() + write_report, privacy ---------------------------------------------------------------------
def _store(root: Path, week, retrieved_at, records):
    raw = json.dumps(records).encode()
    rel = f"sleeper/2026/w{week:02d}/{retrieved_at.replace(':', '-')}.json.gz"
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_bytes(gzip.compress(raw))
    line = {"retrieved_at": retrieved_at, "sha256": hashlib.sha256(raw).hexdigest(), "season": 2026, "week": week,
            "path": rel, "request_url": "https://example.invalid/x", "http_status": 200, "records": len(records),
            "source_updated_at_min": None, "source_updated_at_max": None, "source_updated_at_count": 0,
            "published_commit": "pub", "published_batch_id": "b1", "capture_kind": "scheduled"}
    with (root / "sleeper" / "manifest.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(line) + "\n")


def _world(tmp_path, first_week=1):
    ids = [f"{t}{p}{i}" for t in TEAMS for p in POS for i in range(5)]
    payload = _legacy(gen="g1", week=1, players=[(i, i[3:5], i[:3], 6.0, 9.0 + k % 3, 14.0) for k, i in enumerate(ids)])
    git = FakeGit({"pub": _c([], la.BOT, {la.WEEKLY_FILES[0]}, {la.WEEKLY_FILES[0]: json.dumps(payload).encode()})})
    artifact = {"season": 2026, "protocol_version": "live-accuracy-v1", "weeks_scored": [1],
                "weeks": {"1": {"cutoff": CUT, "publication": {"commit": "pub", "available_by": AVAIL}}}}
    store = tmp_path / "private"
    recs = [_rec(str(k), pos=i[3:5], stats={"rec": 4.0, "rec_yd": 50.0 + k, "pts_ppr": 9.0}) for k, i in enumerate(ids)]
    _store(store, 1, "2026-09-09T11:00:00Z", recs)
    cw = pd.DataFrame({"sleeper_id": [float(k) for k in range(len(ids))], "gsis_id": ids})
    weekly, sched = _raw_world()
    old = dict(sc.FIRST_COMPARABLE_WEEK)
    sc.FIRST_COMPARABLE_WEEK[2026] = first_week
    return store, artifact, sw.prepare(weekly, sched), cw, git, old


def test_run_end_to_end_and_writes_only_under_out(tmp_path):
    store, artifact, prep, cw, git, old = _world(tmp_path)
    try:
        before = {p for p in tmp_path.rglob("*")}
        report = sc.run(store, artifact, prep, cw, git, season_end_read=True)
        written = sc.write_report(report, tmp_path / "out" / "reports")
    finally:
        sc.FIRST_COMPARABLE_WEEK.clear()
        sc.FIRST_COMPARABLE_WEEK.update(old)
    new = {p for p in tmp_path.rglob("*")} - before
    assert all(str(p).startswith(str(tmp_path / "out")) for p in new)
    assert sorted(p.name for p in written) == ["sleeper_2026.json", "sleeper_2026.md"]
    wk = report["by_week"]["1"]
    assert wk["paired"]["status"] == "scored" and wk["paired"]["diagnostic"]["n"] == 20
    assert report["season_end"]["status"] == "read"
    cap = sc.load_manifest(store)[0]
    assert report["provenance"]["selected_captures"] == [{"path": cap["path"], "sha256": cap["sha256"]}]
    assert report["provenance"]["evaluator_version"]["protocol_version"] == "sleeper-compare-v1"
    json.dumps(report, allow_nan=False)


def test_private_vintage_missing_team_is_private_inputs_incomplete_with_provenance(tmp_path):
    # astra S7-I5: the public artifact scored 2026 week 1, but the private job's own fresh pull has only team AAA's
    # rows for the AAA-BBB game. The public completeness decision is not borrowed; the week is skipped.
    store, artifact, _, cw, git, old = _world(tmp_path)
    weekly, sched = _raw_world(missing_team_week=(2026, 1, "BBB"))
    assert not la.week_complete(sw.prepare(weekly, sched), 2026, 1)
    art_path = tmp_path / "live_2026_weekly.json"
    art_bytes = json.dumps(artifact).encode()
    art_path.write_bytes(art_bytes)
    out = tmp_path / "out" / "reports"
    try:
        rc = sc.main(["--snapshots", str(store), "--live-artifact", str(art_path), "--out", str(out),
                      "--data-dir", str(tmp_path / "cache")],
                     load_inputs=lambda season, data_dir: (weekly, sched, cw), git=git)
    finally:
        sc.FIRST_COMPARABLE_WEEK.clear()
        sc.FIRST_COMPARABLE_WEEK.update(old)
    report = json.loads((out / "sleeper_2026.json").read_text(encoding="utf-8"))
    assert rc == 0 and report["by_week"]["1"] == {"status": "skipped", "reason": "private_inputs_incomplete"}
    assert report["cumulative"]["paired"] == {"status": "no_data"}
    inputs = report["provenance"]["inputs"]
    assert inputs["actuals"] == la.frame_sha256(weekly) and inputs["schedules"] == la.frame_sha256(sched)
    assert inputs["crosswalk"] == la.frame_sha256(cw)
    assert inputs["live_artifact"] == hashlib.sha256(art_bytes).hexdigest()
    assert inputs["manifest"] == hashlib.sha256((store / "sleeper" / "manifest.jsonl").read_bytes()).hexdigest()
    assert report["provenance"]["evaluator_version"]["id"] == "sleeper-compare-v1+tree0"
    assert report["provenance"]["run_at"] and report["provenance"]["selected_captures"] == []


def test_sleeper_table_above_threshold_skips_never_runs_on_subset(tmp_path):
    store, artifact, prep, cw, git, old = _world(tmp_path)
    try:
        cap = sc.load_manifest(store)[0]
        recs = sc.read_capture(store, cap)
        recs[0]["stats"]["rec"] = None                                        # 1 of 20 keys = 5% > 1%
        raw = json.dumps(recs).encode()
        (store / cap["path"]).write_bytes(gzip.compress(raw))
        line = {**cap, "sha256": hashlib.sha256(raw).hexdigest()}
        (store / "sleeper" / "manifest.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
        report = sc.run(store, artifact, prep, cw, git)
    finally:
        sc.FIRST_COMPARABLE_WEEK.clear()
        sc.FIRST_COMPARABLE_WEEK.update(old)
    paired = report["by_week"]["1"]["paired"]
    assert paired["status"] == "skipped" and paired["reason"] == "validation_failed" and "primary" not in paired
    assert report["cumulative"]["paired"] == {"status": "no_data"}


def test_exploratory_weeks_never_pooled_and_tampered_snapshot_skipped(tmp_path):
    store, artifact, prep, cw, git, old = _world(tmp_path, first_week=5)
    try:
        report = sc.run(store, artifact, prep, cw, git)
        assert report["by_week"]["1"] == {"status": "skipped", "reason": "exploratory_weeks_excluded"}
        sc.FIRST_COMPARABLE_WEEK[2026] = 1
        gz = next(store.rglob("*.json.gz"))
        gz.write_bytes(gzip.compress(b"[]"))
        report2 = sc.run(store, artifact, prep, cw, git)
        assert report2["by_week"]["1"]["paired"]["reason"] == "snapshot_integrity_failed"
    finally:
        sc.FIRST_COMPARABLE_WEEK.clear()
        sc.FIRST_COMPARABLE_WEEK.update(old)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sleeper_compare.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'ffmodel.eval.sleeper_compare'`.

- [ ] **Step 3: Implement**

```python
"""Private Sleeper comparator (spec docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md §4.8).

Reads the private snapshot store (sleeper/manifest.jsonl + sleeper/<S>/w<NN>/<retrieved_at>.json.gz) and the
public live artifact's selected publications; writes reports/sleeper_<S>.{json,md} ONLY under --out. Nothing
here may be written to the public repository: the report carries Sleeper-derived values.

Weekly runs compute per-week and cumulative numbers only. The pre-registered decision (Holm across the two
primary claims) is computed only with --season-end, read once after the last REG week (spec §4.8.4, §8 step 8).
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import tempfile
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import ConstantInputWarning

from ffmodel.eval import live_accuracy as la
from ffmodel.eval import sameweek as sw
from ffmodel.eval.weekly_rankings import goodness_spearman
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

PROTOCOL_VERSION = "sleeper-compare-v1"
SLEEPER_TO_STAT = {"pass_yd": "passing_yards", "pass_td": "passing_tds", "pass_int": "passing_interceptions",
                   "rush_att": "carries", "rush_yd": "rushing_yards", "rush_td": "rushing_tds",
                   "rec_tgt": "targets", "rec": "receptions", "rec_yd": "receiving_yards",
                   "rec_td": "receiving_tds", "fum_lost": "fumbles_lost"}
RELEVANT_POINTS = 8.0              # fixed now, never searched (spec §4.8.4)
PAIR_WINDOW = pd.Timedelta(hours=24)
FIRST_COMPARABLE_WEEK = {2026: 5}  # 2026 weeks 1-4 are exploratory only, never pooled (spec §1, §4.8.4)
MIN_CELL = 5
CLAIMS = (("ours", "sleeper"), ("blend", "sleeper"))
DIAGNOSTIC_PAIRS = CLAIMS + (("blend", "ours"),)
ALPHA = 0.05


class SnapshotIntegrityError(Exception):
    pass


# --- snapshots ----------------------------------------------------------------------------------------------------
def load_manifest(root: Path) -> list[dict]:
    path = Path(root) / "sleeper" / "manifest.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _eligible(cap: dict) -> bool:
    return cap.get("capture_kind") == "manual" or cap.get("http_status") == 200


def choose_snapshots(manifest: list[dict], season: int, week: int, available_by, cutoff) -> dict:
    """Spec §4.8.2. Paired: nearest to available_by, before the cutoff, within 24 h, ties to the earlier.
    Latest: the last capture before the cutoff, labelled with its timing gap."""
    a, cut = la._ts(available_by), la._ts(cutoff)
    caps = [c for c in manifest if int(c["season"]) == season and int(c["week"]) == week and _eligible(c)
            and la._ts(c["retrieved_at"]) < cut]
    paired_pool = [c for c in caps if abs(la._ts(c["retrieved_at"]) - a) <= PAIR_WINDOW]
    paired = min(paired_pool, key=lambda c: (abs(la._ts(c["retrieved_at"]) - a), la._ts(c["retrieved_at"])),
                 default=None)
    latest = max(caps, key=lambda c: la._ts(c["retrieved_at"]), default=None)
    gap = None if latest is None else (la._ts(latest["retrieved_at"]) - a).total_seconds() / 3600
    return {"paired": paired, "latest": latest, "latest_gap_hours": gap}


def read_capture(root: Path, cap: dict) -> list[dict]:
    path = Path(root) / cap["path"]
    if not path.exists():
        raise SnapshotIntegrityError(f"missing capture {cap['path']}")
    raw = gzip.decompress(path.read_bytes())
    if hashlib.sha256(raw).hexdigest() != cap["sha256"]:
        raise SnapshotIntegrityError(f"sha256 mismatch for {cap['path']}")
    data = json.loads(raw)
    if not isinstance(data, list):
        raise SnapshotIntegrityError(f"capture {cap['path']} is not a JSON array")
    return data


# --- validation and scoring ---------------------------------------------------------------------------------------
def _sleeper_key(v) -> str | None:
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return None
    if isinstance(v, (float, np.floating)) and float(v).is_integer():
        return str(int(v))
    return str(v).strip() or None


def crosswalk_map(crosswalk: pd.DataFrame) -> tuple[dict, set]:
    """sleeper_id -> gsis_id, and the Sleeper ids in a one-to-many or many-to-one collision (spec §4.8.3)."""
    x = crosswalk[["sleeper_id", "gsis_id"]].dropna()
    x = x.assign(sleeper_id=x["sleeper_id"].map(_sleeper_key)).dropna().drop_duplicates()
    per_s = x.groupby("sleeper_id")["gsis_id"].nunique()
    per_g = x.groupby("gsis_id")["sleeper_id"].nunique()
    collided = set(per_s[per_s > 1].index) | set(x.loc[x["gsis_id"].isin(per_g[per_g > 1].index), "sleeper_id"])
    ok = x[~x["sleeper_id"].isin(collided)]
    return dict(zip(ok["sleeper_id"], ok["gsis_id"])), collided


def sleeper_frame(records: list[dict], season: int, week: int) -> pd.DataFrame:
    """Rows of category proj, season S, week N, QB/RB/WR/TE. Absent mapped keys are 0 (Sleeper omits zeros); a
    present null/non-finite value becomes NaN so validation invalidates the row; pts_ppr must be present."""
    rows = []
    for r in records:
        pos = (r.get("player") or {}).get("position")
        if r.get("category") != "proj" or str(r.get("season")) != str(season) or r.get("week") != week \
                or pos not in sw.POSITIONS:
            continue
        stats = r.get("stats") or {}
        row = {"sleeper_id": _sleeper_key(r.get("player_id")), "position": pos}
        for key, col in SLEEPER_TO_STAT.items():
            v = stats[key] if key in stats else 0.0
            row[col] = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else np.nan
        pts = stats.get("pts_ppr")
        row["pts_ppr"] = float(pts) if isinstance(pts, (int, float)) and not isinstance(pts, bool) else np.nan
        rows.append(row)
    return pd.DataFrame(rows, columns=["sleeper_id", "position", *SLEEPER_TO_STAT.values(), "pts_ppr"])


def validate_sleeper(frame: pd.DataFrame, crosswalk: pd.DataFrame) -> dict:
    """§3.7 for the Sleeper table, plus identity. Returns the validation, the valid mapped rows with
    sleeper_pts (common-component PPR) and the reconciliation of pts_ppr against the re-score."""
    mapping, collided = crosswalk_map(crosswalk)
    v = sw.validate_table(frame, ["sleeper_id"], [*SLEEPER_TO_STAT.values(), "pts_ppr"], ["position"],
                          extra_invalid={"crosswalk_collision": frame["sleeper_id"].isin(collided)},
                          position_col="position")
    ok = v.valid.copy()
    ok["player_id"] = ok["sleeper_id"].map(mapping)
    unmapped = int(ok["player_id"].isna().sum())
    ok = ok.dropna(subset=["player_id"])
    ok["sleeper_pts"] = fantasy_points(ok[list(SLEEPER_TO_STAT.values())], PPR).to_numpy()
    gap = (ok["pts_ppr"] - ok["sleeper_pts"]).abs().to_numpy(float)
    recon = ({"n": int(len(gap)), "median": float(np.median(gap)), "p90": float(np.percentile(gap, 90)),
              "max": float(gap.max())} if len(gap) else {"n": 0})
    return {"validation": v, "rows": ok[["player_id", "position", "sleeper_pts"]], "unmapped": unmapped,
            "reconciliation_abs_pts_ppr_minus_rescore": recon}


# --- metrics ------------------------------------------------------------------------------------------------------
def _boot_means(deltas: np.ndarray, clusters: np.ndarray, n_boot: int = sw.N_BOOT, seed: int = sw.BOOT_SEED):
    """The resample of mean_head_gate.paired_bootstrap, returning the replicate means (for p-values)."""
    uniq = np.unique(clusters)
    by_cluster = [deltas[clusters == c] for c in uniq]
    rng = np.random.default_rng(seed)
    means = np.empty(n_boot, dtype=float)
    for b in range(n_boot):
        pick = rng.integers(0, len(by_cluster), len(by_cluster))
        means[b] = np.concatenate([by_cluster[i] for i in pick]).mean()
    return means


def _abs_err(rows: pd.DataFrame, col: str) -> np.ndarray:
    return np.abs(rows["actual"].to_numpy(float) - rows[col].to_numpy(float))


def _clusters(rows: pd.DataFrame) -> dict:
    return {"player": rows["player_id"].astype(str).to_numpy(),
            "week_team": (rows["week"].astype(str) + "|" + rows["team"].astype(str)).to_numpy()}


def view_metrics(rows: pd.DataFrame) -> dict:
    """One view (primary or diagnostic). rows: player_id, position, team, week, actual, ours, sleeper, blend."""
    n = len(rows)
    if n == 0:
        return {"n": 0, "mae": {s: None for s in ("ours", "sleeper", "blend")}, "deltas": {}, "by_position": {},
                "spearman_cells": [], "degenerate_cells": 0}
    cl = _clusters(rows)
    deltas = {}
    for a, b in DIAGNOSTIC_PAIRS:
        d = _abs_err(rows, a) - _abs_err(rows, b)
        deltas[f"{a}_minus_{b}"] = {"mean": float(d.mean()), **{
            f"ci95_{k}": [float(x) for x in np.percentile(_boot_means(d, c), [2.5, 97.5])] for k, c in cl.items()}}
    cells, degenerate = [], 0
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", ConstantInputWarning)
        for (w, pos), g in rows.groupby(["week", "position"]):
            if len(g) < MIN_CELL:
                continue
            so = goodness_spearman(g["ours"].to_numpy(), g["actual"].to_numpy())
            ss = goodness_spearman(g["sleeper"].to_numpy(), g["actual"].to_numpy())
            if not (np.isfinite(so) and np.isfinite(ss)):
                degenerate += 1
                continue
            cells.append({"week": int(w), "position": pos, "n": int(len(g)), "sp_ours": so, "sp_sleeper": ss})
    return {"n": int(n), "mae": {s: float(_abs_err(rows, s).mean()) for s in ("ours", "sleeper", "blend")},
            "deltas": deltas,
            "by_position": {p: {"n": int(len(g)), **{s: float(_abs_err(g, s).mean()) for s in ("ours", "sleeper",
                                                                                                   "blend")}}
                            for p, g in rows.groupby("position")},
            "spearman_cells": cells, "degenerate_cells": degenerate}


def relevant(rows: pd.DataFrame) -> pd.DataFrame:
    """Primary view: the fantasy-relevant union, from PROJECTIONS only (never actuals)."""
    return rows[(rows["ours"] >= RELEVANT_POINTS) | (rows["sleeper"] >= RELEVANT_POINTS)]


def missingness(played: pd.DataFrame, ours_ids: set, sleeper_ids: set) -> dict:
    out = {}
    for pos, g in played.groupby("position"):
        o, s = ~g["player_id"].isin(ours_ids), ~g["player_id"].isin(sleeper_ids)
        out[pos] = {"played": int(len(g)), "ours_missing": int(o.sum()), "sleeper_missing": int(s.sum()),
                    "both_missing": int((o & s).sum())}
    return out


def compare_rows(played: pd.DataFrame, ours: pd.DataFrame, sleeper: pd.DataFrame) -> pd.DataFrame:
    """played (player_id, position, team, week, actual) ∩ our valid p50 ∩ valid Sleeper; adds the 50/50 blend."""
    rows = played.merge(ours[["player_id", "p50"]].rename(columns={"p50": "ours"}), on="player_id")
    rows = rows.merge(sleeper[["player_id", "sleeper_pts"]].rename(columns={"sleeper_pts": "sleeper"}),
                      on="player_id")
    return rows.assign(blend=0.5 * rows["ours"] + 0.5 * rows["sleeper"])


def season_end(rows: pd.DataFrame) -> dict:
    """Spec §4.8.4: the two primary claims in the primary view, Holm-adjusted. Each claim's two-sided bootstrap
    p-value is the larger of its player- and week|team-clustered p-values (the conservative reading)."""
    if rows.empty:
        return {"status": "no_data"}
    cl = _clusters(rows)
    claims = []
    for a, b in CLAIMS:
        d = _abs_err(rows, a) - _abs_err(rows, b)
        ps = {}
        for k, c in cl.items():
            m = _boot_means(d, c)
            ps[k] = float(min(1.0, 2 * min((m <= 0).mean(), (m >= 0).mean())))
        claims.append({"claim": f"{a}_minus_{b}", "mean": float(d.mean()), "p_by_clustering": ps,
                       "p": max(ps.values())})
    order = sorted(range(len(claims)), key=lambda i: claims[i]["p"])
    still = True
    for rank, i in enumerate(order):
        threshold = ALPHA / (len(claims) - rank)
        reject = still and claims[i]["p"] <= threshold
        still = reject
        c = claims[i]
        c["holm_threshold"] = threshold
        c["rejected"] = bool(reject)
        a, b = c["claim"].split("_minus_")
        c["outcome"] = (f"{a}_lower_error" if c["mean"] < 0 else f"{b}_lower_error") if reject else "inconclusive"
    return {"status": "read", "claims": claims, "n": int(len(rows)),
            "note": "read once after the last REG week; everything else in this report is diagnostic"}


# --- orchestration ------------------------------------------------------------------------------------------------
def _week_variant(root, cap, season, week, crosswalk, played, ours) -> tuple[dict, pd.DataFrame | None]:
    if cap is None:
        return {"status": "skipped", "reason": "no_sleeper_snapshot"}, None
    snap = {k: cap.get(k) for k in ("retrieved_at", "path", "sha256", "capture_kind", "published_commit",
                                    "published_batch_id", "source_updated_at_min", "source_updated_at_max",
                                    "source_updated_at_count")}
    try:
        records = read_capture(root, cap)
    except SnapshotIntegrityError as exc:
        return {"status": "skipped", "reason": "snapshot_integrity_failed", "detail": str(exc), "snapshot": snap}, None
    vs = validate_sleeper(sleeper_frame(records, season, week), crosswalk)
    rec = {"snapshot": snap, "validation": vs["validation"].report(), "unmapped": vs["unmapped"],
           "reconciliation": vs["reconciliation_abs_pts_ppr_minus_rescore"],
           "missingness": missingness(played, set(ours["player_id"]), set(vs["rows"]["player_id"]))}
    if vs["validation"].fails():
        return {**rec, "status": "skipped", "reason": "validation_failed"}, None
    rows = compare_rows(played, ours, vs["rows"])
    return {**rec, "status": "scored", "primary": view_metrics(relevant(rows)),
            "diagnostic": view_metrics(rows)}, rows


def private_input_hashes(weekly: pd.DataFrame, schedules: pd.DataFrame, crosswalk: pd.DataFrame,
                         artifact_bytes: bytes) -> dict:
    """Spec §4.8.5 private provenance: the private run's own data vintage, as actually read."""
    return {"actuals": la.frame_sha256(weekly), "schedules": la.frame_sha256(schedules),
            "crosswalk": la.frame_sha256(crosswalk), "live_artifact": hashlib.sha256(artifact_bytes).hexdigest()}


def run(snapshots: Path, artifact: dict, prepared: sw.Prepared, crosswalk: pd.DataFrame, git,
        season_end_read: bool = False, inputs: dict | None = None, run_at: str | None = None) -> dict:
    """The private stats are a separate data vintage (spec §4.8.5, astra S7-I5): every week the public artifact
    scored is re-checked on THESE inputs -- team_presence_complete, then §3.7 -- and skipped with
    private_inputs_incomplete or validation_failed; the public run's decision is never borrowed."""
    S = int(artifact["season"])
    manifest = load_manifest(snapshots)
    weights = la.ppr_weights()
    by_week, pooled, selected = {}, {"paired": [], "latest": []}, {}
    for N in sorted(int(w) for w in artifact["weeks_scored"]):
        if N < FIRST_COMPARABLE_WEEK.get(S, 1):
            by_week[str(N)] = {"status": "skipped", "reason": "exploratory_weeks_excluded"}
            continue
        wrec = artifact["weeks"][str(N)]
        pub = wrec["publication"]
        if not la.week_complete(prepared, S, N):
            by_week[str(N)] = {"status": "skipped", "reason": "private_inputs_incomplete"}
            continue
        wi = sw.week_inputs(prepared, S, N)
        if wi["failed"]:
            by_week[str(N)] = {"status": "skipped", "reason": "validation_failed", "validation": wi["report"]}
            continue
        legacy, neutral = la.read_payloads(git, pub["commit"])
        vp, reason, _ = la.published_values(legacy, neutral, weights, S, N)
        if reason:
            by_week[str(N)] = {"status": "skipped", "reason": reason}
            continue
        if vp.fails():
            by_week[str(N)] = {"status": "skipped", "reason": "validation_failed",
                               "validation": {"projections": vp.report()}}
            continue
        ours = vp.valid
        act = wi["actuals"].valid
        played = act[["player_id", "position", "team", "week"]].assign(
            actual=fantasy_points(act[PREDICTED_STATS], PPR).to_numpy())
        choice = choose_snapshots(manifest, S, N, pub["available_by"], wrec["cutoff"])
        out = {"publication": {"commit": pub["commit"], "available_by": pub["available_by"]},
               "cutoff": wrec["cutoff"], "latest_gap_hours": choice["latest_gap_hours"],
               "latest_label": "sleeper_timing_advantage"}
        for variant in ("paired", "latest"):
            cap = choice[variant]
            if cap is not None:
                selected[cap["path"]] = cap.get("sha256")
            res, rows = _week_variant(snapshots, cap, S, N, crosswalk, played, ours)
            out[variant] = res
            if rows is not None:
                pooled[variant].append(rows)
        by_week[str(N)] = out
    cumulative = {}
    for variant, frames in pooled.items():
        rows = pd.concat(frames, ignore_index=True) if frames else None
        cumulative[variant] = ({"primary": view_metrics(relevant(rows)), "diagnostic": view_metrics(rows)}
                               if rows is not None else {"status": "no_data"})
    provenance = {"evaluator_version": la.evaluator_version(git, PROTOCOL_VERSION),
                  "run_at": run_at or pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "inputs": {**(inputs or {}),
                             "manifest": la.file_sha256(Path(snapshots) / "sleeper" / "manifest.jsonl")},
                  "selected_captures": [{"path": p, "sha256": h} for p, h in sorted(selected.items())]}
    report = {"protocol_version": PROTOCOL_VERSION, "season": S, "private": True, "provenance": provenance,
              "live_artifact": {"protocol_version": artifact.get("protocol_version"),
                                "run": artifact.get("run"), "evaluator_version": artifact.get("evaluator_version")},
              "by_week": by_week, "cumulative": cumulative,
              "caveats": ["Private: Sleeper-derived values never enter the public repository.",
                          "Paired snapshot approximates an equal information deadline only to within the capture "
                          "schedule; 'latest' answers which available product was better, not which method.",
                          "Common-component PPR re-score on both sides; two-point conversions and special-teams "
                          "scores are excluded.", "Weekly numbers are diagnostic; there are no weekly decisions."]}
    if season_end_read:
        frames = pooled["paired"]
        report["season_end"] = season_end(relevant(pd.concat(frames, ignore_index=True)) if frames
                                          else pd.DataFrame())
    return report


def render_markdown(report: dict) -> str:
    def f(x):
        return "—" if x is None else f"{x:.2f}"

    lines = [f"# Sleeper comparison (private) — {report['season']}", "",
             "| week | variant | gap h | n (relevant) | MAE ours | MAE Sleeper | MAE blend |", "|---|---|---|---|---|---|---|"]
    for w, rec in sorted(report["by_week"].items(), key=lambda kv: int(kv[0])):
        for variant in ("paired", "latest"):
            v = rec.get(variant)
            if not v:
                continue
            if v.get("status") != "scored":
                lines.append(f"| {w} | {variant} | — | — | {v.get('reason')} | | |")
                continue
            m = v["primary"]
            gap = rec["latest_gap_hours"] if variant == "latest" else None
            lines.append(f"| {w} | {variant} | {f(gap)} | {m['n']} | {f(m['mae']['ours'])} | "
                         f"{f(m['mae']['sleeper'])} | {f(m['mae']['blend'])} |")
    if "season_end" in report and report["season_end"].get("status") == "read":
        lines += ["", "## Season-end read (Holm across two claims)"]
        for c in report["season_end"]["claims"]:
            lines.append(f"- {c['claim']}: mean {c['mean']:.3f}, p {c['p']:.4f}, outcome {c['outcome']}")
    lines += ["", *[f"- {c}" for c in report["caveats"]], ""]
    return "\n".join(lines)


def write_report(report: dict, out_dir: Path) -> list[Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    js = out_dir / f"sleeper_{report['season']}.json"
    md = out_dir / f"sleeper_{report['season']}.md"
    js.write_text(json.dumps(report, indent=1, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    md.write_text(render_markdown(report), encoding="utf-8")
    return [js, md]


def _load_inputs(season: int, data_dir: Path):
    """The private run's own pull (a separate data vintage): raw weekly actuals, schedule and crosswalk."""
    from ffmodel.data.pull import pull_schedules, pull_weekly
    from ffmodel.data.rankings import pull_player_ids

    weekly, schedules = pull_weekly([season], cache_dir=data_dir), pull_schedules([season], cache_dir=data_dir)
    return weekly, schedules, pull_player_ids(data_dir)


def main(argv=None, load_inputs=_load_inputs, git=None) -> int:
    ap = argparse.ArgumentParser(description="Private Sleeper comparator (spec §4.8).")
    ap.add_argument("--snapshots", type=Path, required=True, help="private repository checkout")
    ap.add_argument("--live-artifact", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True, help="directory; the only place this writes")
    ap.add_argument("--data-dir", type=Path, default=None, help="nflverse cache (default: a fresh temp dir)")
    ap.add_argument("--season-end", action="store_true", help="the one pre-registered read after the last REG week")
    args = ap.parse_args(argv)
    artifact_bytes = args.live_artifact.read_bytes()
    artifact = json.loads(artifact_bytes.decode("utf-8"))
    data_dir = args.data_dir or Path(tempfile.mkdtemp(prefix="sleeper-cmp-"))
    weekly, schedules, crosswalk = load_inputs(int(artifact["season"]), data_dir)
    report = run(args.snapshots, artifact, sw.prepare(weekly, schedules), crosswalk, git or la.Git("."),
                 season_end_read=args.season_end,
                 inputs=private_input_hashes(weekly, schedules, crosswalk, artifact_bytes))
    for p in write_report(report, args.out):
        print(p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sleeper_compare.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/sleeper_compare.py tests/test_sleeper_compare.py
git commit -m "feat(sleeper_compare): private Sleeper comparator — paired/latest snapshots, common-component PPR, relevant union, season-end Holm read (spec §4.8)"
```

---

### Task 8: Ledger seed and workflow (public job and private fail-soft job)

**Model:** implementer sonnet (transcription); reviewer sonnet.

**Files:**
- Create: `tools/build_push_ledger_seed.py`
- Create: `models/diagnostics/main_push_ledger.json`, generated by the tool
- Create: `.github/workflows/weekly-accuracy.yml`
- Test: `tests/test_weekly_accuracy_workflow.py`

**Interfaces:**
- Consumes: `live_accuracy.merge_collection`, `save_ledger`, `LEDGER_PATH`; the CLIs `ffmodel.eval.live_accuracy`
  and `ffmodel.eval.sleeper_compare`.
- Requires outside the repo (spec §8 step 4; not part of this task): the private repository
  `mtsilverstein/megatron-private-data` and the repository secret `PRIVATE_DATA_TOKEN` (fine-grained, that repository
  only). Until both exist the private job prints a notice and skips.

- [ ] **Step 1: Write the failing test**

```python
"""Static checks on the weekly-accuracy workflow and the committed ledger seed (spec §4.1, §4.7, §4.8.5)."""
import json
from pathlib import Path

import yaml

WF = Path(".github/workflows/weekly-accuracy.yml")
LEDGER = Path("models/diagnostics/main_push_ledger.json")


def _wf():
    return yaml.safe_load(WF.read_text(encoding="utf-8"))


def _run_text(job):
    return "\n".join(s.get("run", "") for s in job["steps"])


def test_public_job_contract():
    wf = _wf()
    on = wf.get("on", wf.get(True))
    assert sorted(s["cron"] for s in on["schedule"]) == ["47 13 * 9-12,1 3", "47 16 * 9-12,1 2"]
    assert "workflow_dispatch" in on
    assert wf["concurrency"] == {"group": "weekly-site-refresh", "cancel-in-progress": False}
    job = wf["jobs"]["accuracy"]
    assert job["permissions"] == {"contents": "write"} and job["env"]["GH_TOKEN"] == "${{ github.token }}"
    assert job["steps"][0]["with"]["fetch-depth"] == 0
    run = _run_text(job)
    assert 'git config user.name "weekly-accuracy-bot"' in run and "python -m ffmodel.eval.live_accuracy" in run
    assert ("git add models/diagnostics/live_*_weekly.json models/diagnostics/live_*_weekly.md "
            "models/diagnostics/main_push_ledger.json") in run
    assert "git pull --rebase origin main && git push origin HEAD:main" in run          # rebase, then push
    assert "--force" not in run and " -f " not in run


def test_workflow_never_writes_site():
    text = WF.read_text(encoding="utf-8")
    assert "site/" not in text


def test_private_job_is_fail_soft_and_cannot_write_public_repo():
    job = _wf()["jobs"]["sleeper"]
    assert job["needs"] == "accuracy" and job["continue-on-error"] is True
    assert job["permissions"] == {"contents": "read"}
    assert job["env"]["PRIVATE_DATA_TOKEN"] == "${{ secrets.PRIVATE_DATA_TOKEN }}"
    skip = job["steps"][0]
    assert skip["if"] == "env.PRIVATE_DATA_TOKEN == ''" and "::notice::" in skip["run"]
    assert all(s.get("if") in ("env.PRIVATE_DATA_TOKEN != ''", "failure()") for s in job["steps"][1:])
    public, private = job["steps"][1], job["steps"][2]
    assert public["with"]["persist-credentials"] is False
    assert private["with"]["repository"] == "mtsilverstein/megatron-private-data"
    assert private["with"]["token"] == "${{ secrets.PRIVATE_DATA_TOKEN }}" and private["with"]["path"] == "private"
    push = next(s for s in job["steps"] if s.get("working-directory") == "private")
    assert "git add reports/sleeper_*.json reports/sleeper_*.md" in push["run"]
    assert "--out private/reports" in _run_text(job)
    assert "::warning::" in job["steps"][-1]["run"] and job["steps"][-1]["if"] == "failure()"


def test_ledger_seed_shape():
    led = json.loads(LEDGER.read_text(encoding="utf-8"))
    assert led["coverage"] == [["-inf", "2026-10-06T19:02:01Z"]] and len(led["events"]) == 239
    ids = [e["id"] for e in led["events"]]
    assert len(ids) == len(set(ids))
    assert all(isinstance(e["actor"], (str, type(None))) for e in led["events"])
    kinds = [e["activity_type"] for e in led["events"]]
    assert kinds.count("push") == 235 and kinds.count("pr_merge") == 3 and kinds.count("branch_creation") == 1
    assert "force_push" not in kinds
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_weekly_accuracy_workflow.py -q`
Expected: FAIL with `FileNotFoundError`.

- [ ] **Step 3: Implement the seed tool and generate the ledger**

```python
"""Build models/diagnostics/main_push_ledger.json from the 2026-10-06 raw activity capture (spec §4.1 seed).

Usage: .venv/Scripts/python.exe tools/build_push_ledger_seed.py .review/evidence-seed/activity-main-2026-10-06T190201Z.json
The capture paginated to the end of history and its oldest event is main's branch_creation, so its coverage
interval is ["-inf", capture time].
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
Expected: `239 events; coverage [['-inf', '2026-10-06T19:02:01Z']]`.

- [ ] **Step 4: Write the workflow**

```yaml
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
      - name: Score published projections (infrastructure errors fail here, before any commit)
        run: python -m ffmodel.eval.live_accuracy --main-ref origin/main
      - name: Commit accuracy artifacts
        run: |
          git config user.name "weekly-accuracy-bot"
          git config user.email "actions@users.noreply.github.com"
          git add models/diagnostics/live_*_weekly.json models/diagnostics/live_*_weekly.md models/diagnostics/main_push_ledger.json
          git diff --cached --quiet && echo "no changes" && exit 0
          git commit -m "data: weekly accuracy refresh"
          for i in 1 2 3; do
            git pull --rebase origin main && git push origin HEAD:main && exit 0
          done
          exit 1

  # Private Sleeper comparator (spec §4.8). Fail-soft: it runs after the public job, cannot write the public
  # repository (contents: read), and its failure only annotates the run.
  sleeper:
    needs: accuracy
    runs-on: ubuntu-latest
    continue-on-error: true
    permissions:
      contents: read
    env:
      PRIVATE_DATA_TOKEN: ${{ secrets.PRIVATE_DATA_TOKEN }}
    steps:
      - name: Skip without the private-data secret
        if: env.PRIVATE_DATA_TOKEN == ''
        run: echo "::notice::PRIVATE_DATA_TOKEN is not set; Sleeper comparison skipped"
      - uses: actions/checkout@v7
        if: env.PRIVATE_DATA_TOKEN != ''
        with:
          ref: main
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/checkout@v7
        if: env.PRIVATE_DATA_TOKEN != ''
        with:
          repository: mtsilverstein/megatron-private-data
          token: ${{ secrets.PRIVATE_DATA_TOKEN }}
          path: private
      - uses: actions/setup-python@v6
        if: env.PRIVATE_DATA_TOKEN != ''
        with: { python-version: "3.12" }
      - if: env.PRIVATE_DATA_TOKEN != ''
        run: pip install -e .
      - name: Compare against Sleeper snapshots
        if: env.PRIVATE_DATA_TOKEN != ''
        run: |
          S=$(python -c "from ffmodel.data.pull import current_nfl_season; print(current_nfl_season())")
          python -m ffmodel.eval.sleeper_compare --snapshots private --live-artifact "models/diagnostics/live_${S}_weekly.json" --out private/reports
      - name: Push the private report
        if: env.PRIVATE_DATA_TOKEN != ''
        working-directory: private
        run: |
          git config user.name "weekly-accuracy-bot"
          git config user.email "actions@users.noreply.github.com"
          git add reports/sleeper_*.json reports/sleeper_*.md
          git diff --cached --quiet && echo "no changes" && exit 0
          git commit -m "data: sleeper comparison refresh"
          for i in 1 2 3; do
            git pull --rebase && git push && exit 0
          done
          exit 1
      - name: Annotate a failed comparison
        if: failure()
        run: echo "::warning::Sleeper comparison failed; the public accuracy artifact is unaffected"
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_weekly_accuracy_workflow.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/build_push_ledger_seed.py models/diagnostics/main_push_ledger.json .github/workflows/weekly-accuracy.yml tests/test_weekly_accuracy_workflow.py
git commit -m "feat: weekly-accuracy workflow (rebase-then-push, private fail-soft Sleeper job) and push ledger seed (spec §4.1/§4.7/§4.8.5)"
```

---

### Task 9: (B) driver — `weekly_consensus_sameweek.py`

**Model:** implementer sonnet (transcription); reviewer **opus** (leak surface: the driver path into the model).

**Files:**
- Create: `src/ffmodel/eval/weekly_consensus_sameweek.py`
- Test: `tests/test_weekly_consensus_sameweek.py`

**Interfaces:**
- Consumes:
  - `sameweek.*` (Tasks 1–4), including `prepare` and `week_inputs`;
  - `ffmodel.eval.splits.walk_forward_splits`;
  - `live_accuracy.evaluator_version`, `Git`, `frame_sha256`, `file_sha256`;
  - in `main` only: `ffmodel.eval.weekly_consensus.transformer_predictor`, `V1_ROOTS`, `ffmodel.data.pull`,
    `ffmodel.data.rankings.pull_player_ids`, `weekly_rankings.normalize_weekly_rankings`.
- Produces:
  - `PROTOCOL_VERSION = "sameweek-v1"`, `DISCOVERY`, `REPLICATION`, `FOLD_FILES`, `AUDIT_FIXTURES`
  - `run_sample(prep, rankings, crosswalk, seasons, predict_season) -> dict`
    - keys: `cells` (DataFrame), `weeks` (provenance list), `target_weeks`, `audit`, `alarm` (bool)
    - `predict_season(season, train, test) -> pd.Series` indexed like `test`
    - dates come from `prep.schedule.dates(season)`; a week whose own or N−1 schedule slice fails is skipped with
      `validation_failed` / `schedule_dependency_failed` (astra S7-I3)
  - `evaluator(git) -> dict` (`live_accuracy.evaluator_version` with protocol `sameweek-v1`)
  - `audit_cells(sample) -> list[dict]`, `check_alarm_audit(record, expected_cells) -> None`
  - `aggregate_validation(weeks) -> dict`
  - `build_report(disc, rep, provenance, alarm_audit=None) -> dict`
  - `model_artifact_hashes(roots, seasons) -> dict`
  - `main(argv=None) -> int` (flags `--data-dir`, `--first-season`, `--out`, `--alarm-audited`)

The §3.9 alarm procedure, as code: a negative mean model Spearman writes `status: "alarm_negative_correlation"`,
`verdicts: null` and `alarm_audit_cells` (the first cell in (season, week, position) order of each season of each
alarmed sample, positions ordered QB, RB, WR, TE, with the driver's values). The operator then (1) runs
`AUDIT_FIXTURES` and records the result, (2) recomputes both Spearman values of those cells by hand from the raw
inputs, (3) writes a JSON record
`{"fixtures": {"command": ..., "result": "passed"}, "hand_checks": [{season, week, position, sp_ours_driver,
sp_con_driver, sp_ours_hand, sp_con_hand}, ...], "conclusion": "no_defect" | "defect_found"}`. On `no_defect` the
driver is re-run with `--alarm-audited <record>` and publishes as computed with the limited-sample warning; on
`defect_found` the driver refuses, and Rule 4 applies (fix, re-run, publish both). Population and sign are never
changed to clear the alarm. The `_old_cells` snapshot-change diagnostic (old §5.3) is cut in draft 7 and does not
appear.

- [ ] **Step 1: Write the failing tests**

```python
"""(B) driver orchestration on synthetic raw tables with a fake model (spec §3.9, §5, §6.6)."""
import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.eval import sameweek as sw
from ffmodel.eval import weekly_consensus_sameweek as drv
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

TEAMS = ["AAA", "BBB", "CCC", "DDD"]


def _world(season=2024, weeks=4, duplicate=None, weekly_edit=None, extra_games=()):
    """Raw weekly rows (as pull_weekly returns) + schedule; Thursday AAA-BBB, Sunday CCC-DDD; Friday scrapes.
    `weekly_edit(weekly) -> weekly` and `extra_games` alter the raw tables before sw.prepare."""
    sched, ranks, weekly = [], [], []
    rng = np.random.default_rng(1)
    for w in range(1, weeks + 1):
        thu = pd.Timestamp(f"{season}-09-05") + pd.Timedelta(days=7 * (w - 1))
        sched += [(season, w, str(thu.date()), "AAA", "BBB"), (season, w, str((thu + pd.Timedelta(days=3)).date()), "CCC", "DDD")]
        for t in TEAMS:
            for pos in sw.POSITIONS:
                for i in range(4):
                    pid = f"{t}{pos}{i}"
                    ranks.append({"fp_id": pid, "player": pid, "pos": pos, "team": t, "ecr": float(i + 1), "sd": 1.0,
                                  "mergename": pid.lower(), "scrape_date": thu + pd.Timedelta(days=1)})
                    row = {"player_id": f"g-{pid}", "player_display_name": pid, "position": pos, "team": t,
                           "opponent_team": {"AAA": "BBB", "BBB": "AAA", "CCC": "DDD", "DDD": "CCC"}[t],
                           "season": season, "week": w, "target_share": np.nan, "snap_pct": np.nan,
                           "two_point_conversions": 0, "special_teams_tds": 0}
                    row.update({s: float(rng.poisson(3)) for s in PREDICTED_STATS})
                    weekly.append(row)
    weekly = pd.DataFrame(weekly)
    if duplicate is not None:
        weekly = pd.concat([weekly, weekly.iloc[[duplicate]]], ignore_index=True)
    if weekly_edit is not None:
        weekly = weekly_edit(weekly)
    sched = pd.DataFrame([*sched, *extra_games], columns=["season", "week", "gameday", "home_team", "away_team"])
    ranks = pd.DataFrame(ranks)
    first = ranks.drop_duplicates("fp_id")
    cw = pd.DataFrame({"gsis_id": "g-" + first["fp_id"], "fantasypros_id": first["fp_id"],
                       "merge_name": first["fp_id"].str.lower(), "position": first["pos"]})
    return sw.prepare(weekly, sched), ranks, cw


def _good(season, train, test):
    return fantasy_points(test[PREDICTED_STATS], PPR)          # positively correlated, indexed like test


def _anti(season, train, test):
    return -fantasy_points(test[PREDICTED_STATS], PPR)


def test_run_sample_scores_sunday_players_only_and_records_audit():
    prep, ranks, cw = _world()
    res = drv.run_sample(prep, ranks, cw, [2024], _good)
    scored = [w for w in res["weeks"] if w["status"] == "scored"]
    assert scored and all(w["retention"]["excluded_early_game"] == 32 for w in scored)   # AAA/BBB on Thursday
    assert set(res["cells"]["gate_state"]) <= {"bye_consistent", "unverified"}
    assert len(res["audit"]) == 4 and res["target_weeks"] == {2024: [1, 2, 3, 4]}
    assert all("pages" in c for w in scored for c in w["selection"]["candidates"])
    assert all(w["selection"]["label"] == "inferred_by_window" for w in scored)        # no byes: unverified
    assert all(set(c) == {"position", "n", "sp_ours", "sp_con", "delta"} for w in scored for c in w["cells"])


def test_driver_path_collapses_raw_duplicate_before_model_inputs():
    prep, ranks, cw = _world(duplicate=0)                       # an exact duplicate raw row for week 1
    assert prep.exact_by_week == {(2024, 1): 1}
    assert len(prep.features) == 4 * 4 * 4 * 4
    wk1 = [w for w in drv.run_sample(prep, ranks, cw, [2024], _good)["weeks"] if w["week"] == 1][0]
    assert wk1["input_validation"]["actuals"]["exact_duplicates"] == 1


def _mixed_group(weekly):
    # astra S7-I2: player g-CCCRB0 carries 10 | 20, 20, 25 | 30 in weeks 1-3; week 2 is one conflicting key
    pid = weekly["player_id"] == "g-CCCRB0"
    for w, c in ((1, 10.0), (2, 20.0), (3, 30.0)):
        weekly.loc[pid & (weekly["week"] == w), "carries"] = c
    wk2 = weekly[pid & (weekly["week"] == 2)]
    return pd.concat([weekly, wk2, wk2.assign(carries=25.0)], ignore_index=True)


def test_driver_path_keeps_mixed_conflicting_group_in_model_inputs():
    prep, ranks, cw = _world(weekly_edit=_mixed_group)
    seen = {}

    def spy(season, train, test):
        row = test[(test["player_id"] == "g-CCCRB0") & (test["week"] == 3)]
        seen["lag4_carries"] = float(row["lag4_carries"].iloc[0])
        seen["week2_rows"] = int(((test["player_id"] == "g-CCCRB0") & (test["week"] == 2)).sum())
        return _good(season, train, test)

    res = drv.run_sample(prep, ranks, cw, [2024], spy)
    assert seen == {"lag4_carries": pytest.approx(18.75), "week2_rows": 3}           # 10, 20, 20, 25 -> 18.75
    by_week = {w["week"]: w for w in res["weeks"]}
    assert by_week[2]["reason"] == "validation_failed"                               # 1 of 64 keys > 1%
    v2 = by_week[2]["validation"]["actuals"]
    assert v2["invalid_by_reason"] == {"conflicting_duplicates": 1} and v2["exact_duplicates"] == 0
    assert by_week[3]["status"] == "scored"                                          # week 3 scored on those inputs


def test_driver_path_failed_prior_week_schedule_is_a_dependency_failure():
    # astra S7-I3 through the (B) driver: week 1's CCC-DDD game is also listed on Monday (conflicting)
    prep, ranks, cw = _world(extra_games=[(2024, 1, "2024-09-09", "CCC", "DDD")])
    res = drv.run_sample(prep, ranks, cw, [2024], _good)
    by_week = {w["week"]: w for w in res["weeks"]}
    assert by_week[1]["reason"] == "validation_failed" and by_week[1]["detail"] == "schedule_dependency_failed"
    assert by_week[2]["status"] == "skipped" and by_week[2]["reason"] == "validation_failed"
    assert by_week[2]["detail"] == "schedule_dependency_failed" and by_week[2]["cells"] == []
    assert by_week[3]["status"] == "scored"                                          # weeks 2 and 3 both pass
    assert drv.aggregate_validation(res["weeks"])["schedule"]["failed_weeks"] == 1


def test_schedule_duplicate_count_reaches_the_artifact():
    prep, ranks, cw = _world(extra_games=[(2024, 2, "2024-09-15", "CCC", "DDD")])    # exact duplicate game
    disc = drv.run_sample(prep, ranks, cw, [2024], _good)
    report = drv.build_report(disc, disc, {"inputs": {}})
    assert report["discovery"]["validation"]["schedule"]["exact_duplicates"] == 1


def test_evaluator_version_uses_the_sameweek_protocol():
    class _Checkout:
        def tree_id(self, path="src/ffmodel"):
            return "tree0"

        def dirty(self, path="src/ffmodel"):
            return False

    ev = drv.evaluator(_Checkout())
    assert ev["protocol_version"] == "sameweek-v1" and ev["id"] == "sameweek-v1+tree0"


def test_alarm_blocks_verdicts_until_a_no_defect_audit():
    prep, ranks, cw = _world()
    disc = drv.run_sample(prep, ranks, cw, [2024], _anti)
    report = drv.build_report(disc, disc, {"inputs": {}})
    assert disc["alarm"] is True and report["status"] == "alarm_negative_correlation" and report["verdicts"] is None
    cells = report["alarm_audit_cells"]["discovery"]
    assert len(cells) == 1 and cells[0]["season"] == 2024
    record = {"fixtures": {"command": drv.AUDIT_FIXTURES, "result": "passed"}, "conclusion": "no_defect",
              "hand_checks": [{**c, "sp_ours_hand": c["sp_ours_driver"], "sp_con_hand": c["sp_con_driver"]}
                              for c in cells]}
    audited = drv.build_report(disc, disc, {"inputs": {}}, alarm_audit=record)
    assert audited["status"] == "alarm_negative_correlation" and audited["verdicts"]["rule_1"]["value"]
    assert "limited sample" in audited["warning"] and audited["alarm_audit"] == record
    with pytest.raises(ValueError):
        drv.build_report(disc, disc, {"inputs": {}}, alarm_audit={**record, "conclusion": "defect_found"})
    with pytest.raises(ValueError):
        drv.build_report(disc, disc, {"inputs": {}}, alarm_audit={**record, "hand_checks": []})


def test_build_report_verdicts_and_audit_block():
    prep, ranks, cw = _world()
    disc = drv.run_sample(prep, ranks, cw, [2024], _good)
    report = drv.build_report(disc, disc, {"inputs": {}, "evaluator_version": {"id": "x"}})
    assert report["status"] == "ok"
    assert report["verdicts"]["rule_1"]["value"] in {"insufficient", "behind", "ahead", "not_established"}
    assert report["verdicts"]["rule_2"]["value"] in {"insufficient", "established", "not_established"}
    audit = report["old_protocol_staleness_audit"]
    assert len(audit["weeks"]) == 8 and audit["definition"] and "protocol" in report
    assert report["discovery"]["validation"]["actuals"]["failed_weeks"] == 0
    json.dumps(report, allow_nan=False)


def test_model_artifact_hashes_name_every_fold_file(tmp_path):
    root = tmp_path / "v1"
    (root / "through2022").mkdir(parents=True)
    (root / "through2022" / "model.pt").write_bytes(b"w")
    h = drv.model_artifact_hashes([root], [2023])
    assert len(h) == len(drv.FOLD_FILES) and h[(root / "through2022" / "model.pt").as_posix()]
    assert h[(root / "through2022" / "config.yaml").as_posix()] is None        # a missing file shows as None
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_weekly_consensus_sameweek.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'ffmodel.eval.weekly_consensus_sameweek'`.

- [ ] **Step 3: Implement**

```python
"""Pre-registered same-week re-measurement of the weekly expert benchmark (spec §5-§6).

Run once by hand: .venv/Scripts/python.exe -m ffmodel.eval.weekly_consensus_sameweek
Verdicts are computed here from the numbers; nothing in §3/§5/§6 may change in response to a result (Rule 4).
A negative mean model Spearman is an alarm (§3.9): the artifact carries no verdict until the operator's audit
record is supplied with --alarm-audited.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from ffmodel.eval import live_accuracy as la
from ffmodel.eval import sameweek as sw
from ffmodel.eval.splits import walk_forward_splits
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

PROTOCOL_VERSION = "sameweek-v1"
DISCOVERY = [2023, 2024, 2025]
REPLICATION = [2020, 2021, 2022]
SPEC = "docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md"
FOLD_FILES = ("model.pt", "config.yaml", "scaler.json", "calibration.json", "metrics.json")
AUDIT_FIXTURES = ('pytest tests/test_sameweek_gate.py tests/test_sameweek_validation.py '
                  'tests/test_sameweek_selection.py -k "sign or identity"')


def run_sample(prep: sw.Prepared, rankings: pd.DataFrame, crosswalk: pd.DataFrame, seasons: list[int],
               predict_season) -> dict:
    """One sample through stage 2, same-week selection and cells. `prep` is sw.prepare over the raw tables, so
    the model sees the de-duplicated, unmasked feature input and scoring sees only validated rows."""
    cells, weeks_prov, audit, target_weeks = [], [], [], {}
    for season, train_idx, test_idx in walk_forward_splits(prep.features, seasons):
        train, test = prep.features.loc[train_idx], prep.features.loc[test_idx]
        our = predict_season(season, train, test)
        dates = prep.schedule.dates(season)              # a week whose schedule slice fails has no K_N/Z_N
        weeks = sorted(int(w) for w in prep.schedule.games.loc[prep.schedule.games["season"] == season, "week"].unique())
        target_weeks[int(season)] = weeks
        for week in weeks:
            if week not in dates:
                sched_report = prep.schedule.week_validation(season, week).report()
                weeks_prov.append({"season": int(season), "week": week, "status": "skipped",
                                   "reason": "validation_failed", "detail": "schedule_dependency_failed",
                                   "input_validation": {"schedule": sched_report}})
                continue
            audit.append({"season": int(season), **sw.staleness_audit_week(rankings, prep.schedule, season, week,
                                                                           dates)})
            wi = sw.week_inputs(prep, season, week)
            if wi["failed"]:
                weeks_prov.append({"season": int(season), "week": week, "status": "skipped",
                                   "reason": "validation_failed", "validation": wi["report"]})
                continue
            ok = wi["actuals"].valid
            played = pd.DataFrame({"player_id": ok["player_id"].to_numpy(), "position": ok["position"].to_numpy(),
                                   "team": ok["team"].to_numpy(), "our_pts": our.loc[ok.index].to_numpy(dtype=float),
                                   "actual": fantasy_points(ok[PREDICTED_STATS], PPR).to_numpy()})
            res = sw.sameweek_week(played, prep.schedule, rankings, crosswalk, season, week, dates)
            cells += res["cells"]
            weeks_prov.append({"season": int(season), "week": week, **{k: v for k, v in res.items() if k != "cells"},
                               "cells": sw.cell_summary(res["cells"]), "input_validation": wi["report"]})
    frame = pd.DataFrame(cells)
    return {"cells": frame, "weeks": weeks_prov, "target_weeks": target_weeks, "audit": audit,
            "alarm": bool(len(frame) and frame["sp_ours"].mean() < 0)}


def audit_cells(sample: dict) -> list[dict]:
    """§3.9 fixed rule: the first cell in (season, week, position) order of each season, with the driver's
    values, for the operator to recompute by hand."""
    c = sample["cells"]
    if c.empty:
        return []
    order = {p: i for i, p in enumerate(sw.POSITIONS)}
    c = c.assign(_p=c["position"].map(order)).sort_values(["season", "week", "_p"])
    first = c.groupby("season", sort=True).head(1)
    return [{"season": int(r.season), "week": int(r.week), "position": r.position, "sp_ours_driver": float(r.sp_ours),
             "sp_con_driver": float(r.sp_con)} for r in first.itertuples()]


def check_alarm_audit(record: dict, expected_cells: list[dict]) -> None:
    """Accept only a complete no_defect audit of exactly the fixed-rule cells (spec §3.9 step 2-3)."""
    if record.get("conclusion") != "no_defect":
        raise ValueError("alarm audit conclusion is not no_defect: fix the defect, re-run, publish both (Rule 4)")
    if (record.get("fixtures") or {}).get("result") != "passed":
        raise ValueError("alarm audit must record the sign/identity fixture run as passed")
    want = {(c["season"], c["week"], c["position"]) for c in expected_cells}
    got = {(h.get("season"), h.get("week"), h.get("position")) for h in record.get("hand_checks", [])}
    if want != got:
        raise ValueError(f"alarm audit hand checks {sorted(got)} differ from the fixed-rule cells {sorted(want)}")
    for h in record["hand_checks"]:
        if not all(isinstance(h.get(k), (int, float)) for k in ("sp_ours_hand", "sp_con_hand")):
            raise ValueError("every hand check records both hand-computed Spearman values")


def aggregate_validation(weeks: list[dict]) -> dict:
    """Validation counts per reason, table and position over a sample's weeks (spec §3.7, §6.6)."""
    out: dict = {}

    def add(table: str, rep: dict | None):
        if not rep:
            return
        t = out.setdefault(table, {"invalid_by_reason": {}, "invalid_by_reason_position": {},
                                   "exact_duplicates": 0, "failed_weeks": 0})
        t["exact_duplicates"] += rep.get("exact_duplicates", 0)
        t["failed_weeks"] += int(bool(rep.get("failed")))
        for r, n in rep.get("invalid_by_reason", {}).items():
            t["invalid_by_reason"][r] = t["invalid_by_reason"].get(r, 0) + n
        for r, byp in rep.get("invalid_by_reason_position", {}).items():
            for p, n in byp.items():
                t["invalid_by_reason_position"].setdefault(r, {})
                t["invalid_by_reason_position"][r][p] = t["invalid_by_reason_position"][r].get(p, 0) + n

    for w in weeks:
        rep = w.get("input_validation") or w.get("validation") or {}
        add("actuals", rep.get("actuals"))
        add("schedule", rep.get("schedule"))
        if "n_keys" in (w.get("validation") or {}):
            add("consensus", w["validation"])
    return out


def _sample_block(s: dict) -> dict:
    c = s["cells"]
    base = {"weeks": s["weeks"], "validation": aggregate_validation(s["weeks"])}
    if c.empty:
        return {"cells": 0, **base}
    return {"cells": int(len(c)), "overall": sw.delta_stats(c), "sensitivity": sw.sensitivity_stats(c),
            "per_season": {int(k): sw.delta_stats(g) for k, g in c.groupby("season")},
            "per_position": {p: {"stats": sw.delta_stats(g), "sensitivity": sw.sensitivity_stats(g)}
                             for p, g in c.groupby("position")},
            "sp_ours": float(c["sp_ours"].mean()), "sp_con": float(c["sp_con"].mean()),
            "hit_rate_ours": float(c["hit_ours"].sum() / c["slots"].sum()),
            "hit_rate_con": float(c["hit_con"].sum() / c["slots"].sum()),
            "n_le_slots_cells": int(c["n_le_slots"].sum()), **base}


def build_report(disc: dict, rep: dict, provenance: dict, alarm_audit: dict | None = None) -> dict:
    audit = disc["audit"] + rep["audit"]
    discriminating = [a for a in audit if a["discriminating"] and a["state"]]
    alarmed = [n for n, s in (("discovery", disc), ("replication", rep)) if s["alarm"]]
    out = {"protocol_version": PROTOCOL_VERSION, "protocol": f"{SPEC} §3, §5, §6 (draft 7.1)",
           "multiplicity": "Rules 1 and 2 are separate pre-specified claims at 95%; no family-wise correction.",
           "estimand": "within-position ranking of players who recorded a stat line, were matched, and had not yet "
                       "played at the scrape date; cutoffs asymmetric; selection effect undetermined",
           "limitations": "three seasons = three clusters; within-season serial dependence not modelled",
           **provenance, "discovery": _sample_block(disc), "replication": _sample_block(rep),
           "old_protocol_staleness_audit": {
               "weeks": audit,
               "counts": {k: sum(1 for a in discriminating if a["state"] == k)
                          for k in ("contradicted", "bye_consistent", "unverified")},
               "discriminating_weeks": [[a["season"], a["week"]] for a in discriminating],
               "definition": "A and B both non-empty and different"},
           "status": "alarm_negative_correlation" if alarmed else "ok"}
    if alarmed:
        out["alarm_audit_cells"] = {n: audit_cells(s) for n, s in (("discovery", disc), ("replication", rep))
                                    if n in alarmed}
        if alarm_audit is None:
            out["verdicts"] = None
            return out
        check_alarm_audit(alarm_audit, [c for n in alarmed for c in out["alarm_audit_cells"][n]])
        out["alarm_audit"] = alarm_audit
        out["warning"] = ("limited sample: the model's mean Spearman is negative; the audit found no defect and the "
                          "result is published as computed")
    out["verdicts"] = {"rule_1": sw.rule_1(disc["cells"], disc["target_weeks"]),
                       "rule_1_replication_descriptive": sw.rule_1(rep["cells"], rep["target_weeks"]),
                       "rule_2": sw.rule_2(disc["cells"], disc["target_weeks"], rep["cells"], rep["target_weeks"])}
    return out


def evaluator(git) -> dict:
    """Spec §6.6: evaluator_version built with THIS artifact's protocol (sameweek-v1), not the live one."""
    return la.evaluator_version(git, PROTOCOL_VERSION)


def model_artifact_hashes(roots: list[Path], seasons: list[int]) -> dict:
    """Every fold artifact used, by path and sha256 (spec §6.6)."""
    out = {}
    for root in roots:
        for s in sorted(set(seasons)):
            for f in FOLD_FILES:
                p = Path(root) / f"through{s - 1}" / f
                out[p.as_posix()] = la.file_sha256(p)
    return out


def main(argv=None) -> int:
    from ffmodel.data.pull import LIVE_MAX_AGE_HOURS, _cached, pull_schedules, pull_weekly
    from ffmodel.data.rankings import pull_player_ids
    from ffmodel.eval.weekly_consensus import V1_ROOTS, transformer_predictor
    from ffmodel.eval.weekly_rankings import normalize_weekly_rankings

    ap = argparse.ArgumentParser(description="Same-week re-measurement (spec §5-§6).")
    ap.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    ap.add_argument("--first-season", type=int, default=2012)
    ap.add_argument("--out", type=Path, default=Path("models/diagnostics/weekly_consensus_sameweek.json"))
    ap.add_argument("--alarm-audited", type=Path, default=None, help="§3.9 audit record (JSON) with no_defect")
    args = ap.parse_args(argv)
    spans = list(range(args.first_season, max(DISCOVERY) + 1))
    weekly, schedules = pull_weekly(spans, cache_dir=args.data_dir), pull_schedules(spans, cache_dir=args.data_dir)
    prep = sw.prepare(weekly, schedules)

    def load_raw_rankings() -> pd.DataFrame:
        import nflreadpy

        return nflreadpy.load_ff_rankings("all").to_pandas()

    raw = _cached(args.data_dir, "ff_rankings_all_raw", load_raw_rankings, LIVE_MAX_AGE_HOURS)
    rankings, crosswalk = normalize_weekly_rankings(raw), pull_player_ids(args.data_dir)
    roots = [Path(r) for r in V1_ROOTS]
    predict = transformer_predictor(roots, prep.features)
    disc = run_sample(prep, rankings, crosswalk, DISCOVERY, predict)
    rep = run_sample(prep, rankings, crosswalk, REPLICATION, predict)
    old = {"weekly_consensus.json": json.loads(Path("models/diagnostics/weekly_consensus.json").read_text())["overall"],
           "rb_oos_weekly.json": json.loads(Path("models/diagnostics/rb_oos_weekly.json").read_text())["result"],
           "label": "different_estimand"}
    prov = {"evaluator_version": evaluator(la.Git(".")),
            "inputs": {"ff_rankings_all_raw": la.frame_sha256(raw), "schedules": la.frame_sha256(schedules),
                       "weekly_actuals": la.frame_sha256(weekly), "crosswalk": la.frame_sha256(crosswalk),
                       "model_artifacts": model_artifact_hashes(roots, DISCOVERY + REPLICATION),
                       "first_season": args.first_season},
            "coverage": sw.ranking_coverage(raw, rankings, REPLICATION + DISCOVERY),
            "old_protocol_numbers": old}
    audit = json.loads(args.alarm_audited.read_text(encoding="utf-8")) if args.alarm_audited else None
    report = build_report(disc, rep, prov, alarm_audit=audit)
    args.out.write_text(json.dumps(report, indent=1, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "verdicts": report["verdicts"]}, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run:
- `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_weekly_consensus_sameweek.py -q`
- `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_sameweek_gate.py tests/test_sameweek_validation.py tests/test_sameweek_selection.py -k "sign or identity" -q`

Expected: all pass; the second command (the `AUDIT_FIXTURES` selection) runs exactly 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/weekly_consensus_sameweek.py tests/test_weekly_consensus_sameweek.py
git commit -m "feat: same-week re-measurement driver — prepared inputs, staleness audit, alarm audit procedure, model artifact hashes, coded verdicts (spec §3.9/§5-§6)"
```

---

### Task 10: Offline acceptance tool (real caches, run by the controller)

**Model:** implementer sonnet (transcription); reviewer sonnet. Running it and accounting for any FAIL is the
controller's job (opus).

**Files:**
- Create: `tools/weekly_accuracy_acceptance.py`
- Test: `tests/test_weekly_accuracy_acceptance.py`

**Interfaces:**
- Consumes: `live_accuracy` (Tasks 5–6), `sameweek` (Tasks 1–3), `ffmodel.data.pull.normalize_schedule_teams`,
  `weekly_rankings.normalize_weekly_rankings`.
- Produces: `team_code_failures(rankings_path, schedules_path)`, `selection_lines(schedules_path, ledger_path, git,
  main_ref)`, `main(argv=None, git=None) -> int`.

The tool never calls a `pull_*` function: it reads the explicit parquet paths it is given (a missing file is an
error) and sets `FFMODEL_CACHE_FROZEN=1` for its run (astra P7).

- [ ] **Step 1: Write the failing test**

```python
"""The acceptance tool runs offline: explicit existing files only, frozen cache, no sockets (spec §7.5, astra P7)."""
import importlib.util
import socket
from pathlib import Path

import pandas as pd
import pytest

_spec = importlib.util.spec_from_file_location(
    "weekly_accuracy_acceptance", Path(__file__).resolve().parents[1] / "tools" / "weekly_accuracy_acceptance.py")
acc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(acc)


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*a, **k):
        raise AssertionError("acceptance tool attempted a network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setenv("FFMODEL_CACHE_FROZEN", "0")        # restored after the test; main() sets "1"


def _files(tmp_path, team="LAR"):
    raw = pd.DataFrame({"ecr_type": "wp", "page_type": "weekly-rb", "pos": "RB", "id": [1, 2], "player": ["a", "b"],
                        "team": [team, "JAC"], "ecr": [1.0, 2.0], "sd": 1.0, "mergename": ["a", "b"],
                        "scrape_date": ["2024-09-13", "2024-09-13"]})
    sched = pd.DataFrame({"season": [2024], "week": [2], "gameday": ["2024-09-15"], "home_team": ["LA"],
                          "away_team": ["JAX"]})
    rp, sp = tmp_path / "rank.parquet", tmp_path / "sched.parquet"
    raw.to_parquet(rp)
    sched.to_parquet(sp)
    return rp, sp


def test_team_codes_offline(tmp_path, no_network):
    rp, sp = _files(tmp_path)
    assert acc.team_code_failures(rp, sp) == []
    rp2, sp2 = _files(tmp_path, team="ZZZ")
    assert acc.team_code_failures(rp2, sp2) == [("2024-09-13", 1)]


def test_missing_cache_is_an_error_never_a_download(tmp_path, no_network):
    import os

    rp, _ = _files(tmp_path)
    with pytest.raises(FileNotFoundError):
        acc.main(["--rankings", str(rp), "--schedules", str(tmp_path / "absent.parquet")])
    assert os.environ["FFMODEL_CACHE_FROZEN"] == "1"
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_weekly_accuracy_acceptance.py -q`
Expected: FAIL with `FileNotFoundError` (the tool does not exist yet).

- [ ] **Step 3: Write the tool**

```python
"""Spec §7.5 offline acceptance checks on the real local caches. Prints PASS/FAIL lines; exit code 1 on any FAIL.

1. unknown_team_codes == 0 for every 2020-25 nflverse weekly scrape (team mapping, spec §3.4).
2. §4.1: 2026 weeks 1-4 select b451562 / fa9c095 / fbd66fd / d43adc4 with the documented push times.
3. §4.3: weeks 1-3 have no qualifying archive; week 4 selects ...5aec56b70c3784e6 with ...220d00155877a0a7 listed.

Offline by construction (astra P7): every input is an explicit, existing file path, read directly, and the run sets
FFMODEL_CACHE_FROZEN=1 so any cache access that slipped in raises instead of downloading.

Usage:
  .venv/Scripts/python.exe tools/weekly_accuracy_acceptance.py \
      --rankings data/raw/ff_rankings_all_raw.parquet --schedules data/raw/schedules_v3_2012_2026.parquet
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import pandas as pd

from ffmodel.data.pull import normalize_schedule_teams
from ffmodel.eval import live_accuracy as la
from ffmodel.eval import sameweek as sw
from ffmodel.eval.weekly_rankings import normalize_weekly_rankings

EXPECTED_PUBLICATIONS = {1: ("b451562", "2026-09-02T09:45:11Z"), 2: ("fa9c095", "2026-09-16T20:15:31Z"),
                         3: ("fbd66fd", "2026-09-23T20:33:45Z"), 4: ("d43adc4", "2026-09-30T21:32:42Z")}
EXPECTED_ARCHIVE_W4 = ("2026-w04-2026-09-30-5aec56b70c3784e6.json", "2026-w04-2026-09-30-220d00155877a0a7.json")


def _existing(path) -> Path:
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"acceptance reads only existing cache files; missing: {p}")
    return p


def load_schedules(path) -> pd.DataFrame:
    return normalize_schedule_teams(pd.read_parquet(_existing(path)))


def team_code_failures(rankings_path, schedules_path) -> list[tuple[str, int]]:
    r = normalize_weekly_rankings(pd.read_parquet(_existing(rankings_path)))
    sched = load_schedules(schedules_path)
    d = r["scrape_date"]
    r = r.assign(_season=d.dt.year.where(d.dt.month >= 3, d.dt.year - 1))
    bad = []
    for date, snap in r[r["_season"].between(2020, 2025)].groupby("scrape_date"):
        teams = sw.season_teams(sched, int(snap["_season"].iloc[0]))
        mapped = snap.loc[snap["pos"].isin(sw.POSITIONS), "team"].map(sw.map_team)
        n = int((mapped.notna() & ~mapped.isin(teams)).sum())
        if n:
            bad.append((str(date.date()), n))
    return bad


def selection_lines(schedules_path, ledger_path, git, main_ref: str) -> list[tuple[bool, str]]:
    sc = sw.validate_schedule(load_schedules(schedules_path))
    dates = sc.dates(2026)
    ledger = la.load_ledger(_existing(ledger_path))
    main_sha = git.rev_parse(main_ref)
    index = la.candidate_index(ledger, git, 2026, main_sha)
    out = []
    for week, (sha, ts) in EXPECTED_PUBLICATIONS.items():
        cutoff = pd.Timestamp(dates[week][0]).tz_localize("UTC")
        res = la.select_publication(ledger, git, 2026, week, cutoff, main_sha, index=index)
        ok = res["status"] == "selected" and res["commit"].startswith(sha) and res["available_by"] == ts
        out.append((ok, f"publication week {week}: {res['status']} {str(res['commit'])[:7]} {res['available_by']}"))
        arc = la.select_archive(ledger, git, 2026, week, cutoff, main_sha)
        if week < 4:
            ok = arc["status"] == "no_archive"
        else:
            ok = (arc["status"] == "selected" and arc["name"] == EXPECTED_ARCHIVE_W4[0]
                  and [a["name"] for a in arc["alternatives"]] == [EXPECTED_ARCHIVE_W4[1]])
        out.append((ok, f"archive week {week}: {arc['status']} {arc['name']} "
                        f"alternatives={[a['name'] for a in arc['alternatives']]}"))
    return out


def main(argv=None, git=None) -> int:
    os.environ["FFMODEL_CACHE_FROZEN"] = "1"
    ap = argparse.ArgumentParser(description="Offline acceptance checks (spec §7.5).")
    ap.add_argument("--rankings", required=True, help="existing ff_rankings_all_raw parquet")
    ap.add_argument("--schedules", required=True, help="existing schedules_v3 parquet covering 2019-2026")
    ap.add_argument("--ledger", default=str(la.LEDGER_PATH))
    ap.add_argument("--main-ref", default="origin/main")
    args = ap.parse_args(argv)
    fails = 0
    bad = team_code_failures(args.rankings, args.schedules)
    print(("PASS" if not bad else "FAIL") + f" unknown_team_codes 2020-25: {bad[:10]}")
    fails += bool(bad)
    for ok, line in selection_lines(args.schedules, args.ledger, git or la.Git("."), args.main_ref):
        print(("PASS " if ok else "FAIL ") + line)
        fails += not ok
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the test, then the tool on the real caches**

Run:
- `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider tests/test_weekly_accuracy_acceptance.py -q`
- `.venv/Scripts/python.exe tools/weekly_accuracy_acceptance.py --rankings data/raw/ff_rankings_all_raw.parquet --schedules data/raw/schedules_v3_2012_2026.parquet`

Expected: the test passes; the tool prints nine `PASS` lines (team codes; publication and archive for weeks 1–4)
and exits 0. A `FAIL` on the team codes means the mapping or the cache is wrong; report it and do not adjust the
threshold.

- [ ] **Step 5: Run the full suites**

Run:
- `.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q`
- `for f in tests/*_fixture.cjs; do node "$f" >/dev/null || echo FAIL $f; done`

Expected: everything passes, and the fixture loop prints no `FAIL` line.

- [ ] **Step 6: Commit**

```bash
git add tools/weekly_accuracy_acceptance.py tests/test_weekly_accuracy_acceptance.py
git commit -m "chore: offline real-cache acceptance checks — frozen cache, explicit paths (spec §7.5)"
```

---

## After the build (controller, owner-gated; not implementer tasks)

Follows spec §8.

1. **Review:** astra re-reviews spec draft 7.1 together with this plan. Fold in its findings.
2. **Build:** subagent-driven, per the model assignments above; Opus does the final whole-branch review.
3. **Merge:** code, workflow, tests and the ledger seed. No site data, no frozen paths. The owner OKs the push.
4. **Collector prerequisite:** `market-snapshots.yml` is live, the private repository and `PRIVATE_DATA_TOKEN`
   exist, and the week-5 manual capture is imported with `capture_kind: "manual"`. Until then the private job is
   skipped with a notice. Confirm with the collector's author that its manifest `sha256` is computed over the
   decompressed response bytes and `path` is relative to the repository root, as Task 7 reads them.
5. **First live run:**
   - Dispatch `weekly-accuracy.yml` by hand and check its artifact.
   - Locally, run `.venv/Scripts/python.exe -m ffmodel.eval.live_accuracy --weeks 1-4 --no-fetch --frozen-record models/diagnostics/live_2026_w1-4_reproduction.json`.
   - Account for every divergence from the scratch numbers at row level (spec §4.5), including astra's naive MAE
     4.6757 against the scratch 4.673. Never adjust a rule to match.
   - Commit the record with the divergence notes.
6. **Re-measurement:** run `.venv/Scripts/python.exe -m ffmodel.eval.weekly_consensus_sameweek` once and commit its
   artifact. On `alarm_negative_correlation`, follow the Task 9 audit procedure. Report the verdicts and full
   numbers to the owner.
7. **Copy:** apply §6.7; the owner OKs the push.
8. **Season end:** after the last REG week, run the comparator once with `--season-end` against the private
   checkout and report the result privately to the owner.
