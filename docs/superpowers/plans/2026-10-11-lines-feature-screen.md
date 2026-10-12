# Betting-Lines Feature Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the code for the pre-registered betting-lines decision test: a lines loader with the §2.1 error
taxonomy, a `v1_lines` XGBoost feature set, a frozen modeling frame, a paired row-level collector, the crossed-cluster
bootstrap statistics, and a driver that writes `models/diagnostics/lines_screen.json`. The experiment itself is run
afterwards by the controller (owner-gated, see "After the build").

**Architecture:**

- `src/ffmodel/data/lines.py` owns the market data. It snapshots the raw schedule payload once, keeps exactly the
  eight allowed columns, classifies every game (recoverable missing quote vs fatal ambiguous identity), builds a
  two-sides-per-game table and joins two current-game columns onto the feature frame many-to-one. Fatal problems raise
  `LinesDataError`.
- `src/ffmodel/data/features.py` gains `LINE_FEATURE_COLUMNS` and a registered `v1_lines` set. It resolves to the
  frozen v1 list plus exactly the two line columns, and raises if either is absent. v1 and v2 do not change.
- `src/ffmodel/eval/lines_stats.py` holds the pure statistics: the per-seed loss differences, G / G_S / G^(s), the
  arm-A relevant cohort, the crossed player × week-pair bootstrap on `Generator(PCG64(20261007))`, the three-valued
  ranking status, and the decision with `invalid` deciding first. It raises `ScreenInvalid` internally, and its
  `evaluate` turns that into disposition `invalid`.
- `src/ffmodel/eval/lines_screen.py` is the driver:
  - frozen-frame build, write, hash and read-back;
  - the row-level collector, with the harness's prediction-index check;
  - the manifest and the artifact;
  - a CLI with four subcommands: `snapshot`, `freeze`, `run`, `abandon`.

**Tech Stack:** Python 3.14 (local venv), pandas 3.0.3, numpy 2.5.1, scipy 1.18.0 (`rankdata`), xgboost 3.3.0,
pyarrow 24.0.0, nflreadpy 0.1.5 (snapshot only), pytest.

**Spec:** `docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md`, draft 3 (commit bcade0c, blob
`fd3217b66351c257716a8f0ca97c86dd213a5fea`). astra found it READY TO PLAN (`.review/astra-lines-spec3-response.md` in the
main checkout). The spec is the source of truth; read it before any task. Section references below (§n) are to it.

**Verified when this plan was written (2026-10-11), and re-verified after astra's plan review (rev 1, 2026-10-12):**
every task's code and tests below were materialised from this file into the worktree and run. Revision 1 changed the
embedded code and tests and the controller procedure (see "Plan-review revisions" at the end). It re-ran the test
files and the full suite below. It did not re-run `freeze` or `run` on real data, and it fitted no model.

- **The new and touched test files (rev 1):** 188 tests pass with `-W error`. Per file: `test_lines_features` 6,
  `test_lines_data` 52, `test_lines_stats` 60, `test_lines_screen` 40, `test_features` 25, `test_xgb` 5. (The
  original plan had 150: 49 / 42 / 23 in the three changed files.)
- **The full suite (rev 1):** `1463 passed, 2 deselected` in about 4 minutes. The deselected two are the network
  `integration` tests. The branch base was `1305 passed`, and the original plan recorded `1425 passed, 2 deselected`.
  Run the suite with `FFMODEL_CACHE_FROZEN` unset: with it set to `1`, 15 existing cache tests in `test_pull.py` and
  `test_rosters.py` fail by design. The plan does not touch those files.
- **The new tests fail on the original plan's code.** With the 2026-10-11 modules swapped back in: 3 of the 52 data
  tests fail (the two joint-non-finite quote cases and the sidecar refusal), 17 of the 60 statistics tests (every
  interval-family case), and 17 of the 40 driver tests (freeze replacement, refusal-before-validation, `write_json`,
  abandon, and the `tracked_changes_uncommitted` record).

The remaining bullets are the plan author's 2026-10-11 checks. Revision 1 did not repeat them.
- **Premises checked against the real data:**
  - The live `nflreadpy.load_schedules(2012..2025)` payload has 3,829 records and 46 columns.
  - It has 3,663 REG games with zero missing `spread_line`/`total_line`.
  - The spread/result correlation is +0.439.
  - The team codes include the legacy `OAK`/`SD`/`STL`.
  - No `game_id` is repeated.
- **`freeze` on the local caches** (`C:/Users/reisu/projects/Megatron/data/raw`, `FFMODEL_CACHE_FROZEN=1`, run into a
  scratch directory):
  - 80,090 frame rows;
  - test rows 5,893 / 5,920 / 6,095, matching §4 exactly;
  - every player team-week matched;
  - 0 home-side disagreements with `is_home`;
  - A = 40 columns and B = 42;
  - frame schema of 57 columns.
- **`run` on that frozen frame** exercised the driver path only. It used a stand-in predictor, completed 10,000
  accepted replicates with 0 rejections, found 216 eligible ranking cells and finished in 4.4 s. That driver run computed
  and recorded no XGBoost result.
- **Timing-fit disclosure.** During plan authoring on 2026-10-11 a single timing fit was run:
  - arm B (`v1_lines`), seed 0, the existing XGBoost baseline config;
  - trained on the dry-run frozen frame's 2012–2024 rows, predicting 2025
    (`m=make_xgb_predictor('B',0); m.fit(tr); p=m.predict(te)`);
  - only the elapsed wall time (~18 s) was printed.

  The timed call produced arm-B stat predictions for 2025 inside the timed statement. They were never printed,
  scored or inspected. No losses, A/B differences, ranking values or decisions were computed or inspected, and the
  frame was deleted. The manifest cannot retroactively preregister that fit. The registered run's fits are the ones
  that follow the committed manifest. From that timing, the real run (18 fits) takes roughly 6 minutes.
- All of these files were then deleted; only this plan is committed.

## Global Constraints

**Repo and environment (every task):**
- Work only in the worktree `C:/Users/reisu/projects/Megatron-lines`, branch `feat/lines-screen`. Never touch
  `C:/Users/reisu/projects/Megatron` (another branch is checked out there). Never commit to `main`, never push, never
  `git stash`, never `git add -A`, `git add .` or `git add -f`; stage by explicit path.
- The shared venv has the MAIN checkout installed editable. Every Python command in this worktree must set
  `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src`, or the tests silently exercise the main checkout's code.
  Every pytest command below is written out in full for that reason; run them from the worktree root in Git Bash.
- pytest always runs with `-W error -p no:cacheprovider`.
- Tests are synthetic and network-free. The repo is PUBLIC: no real betting lines, no third-party data values, in any
  fixture. Raw schedule snapshots and frozen frames live under `data/` (gitignored), never committed.
- Read and write JSON with `encoding="utf-8"` (Windows default is cp1252).
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Values fixed by the spec (copied verbatim; no task may change them):**
- Source: `nflreadpy.load_schedules(seasons)`; `ffmodel.data.pull.pull_schedules` (eight columns) is not edited.
- Allow-list: exactly `season`, `week`, `game_type`, `game_id`, `home_team`, `away_team`, `spread_line`, `total_line`
  before any transformation.
- Coverage claim: 3,663 REG games 2012–25, zero missing `spread_line`/`total_line` (re-checked and recorded, not fatal).
- Sign: positive `spread_line` = **home favoured** (nflverse schedule dictionary). Never inferred or flipped from
  outcomes. Neutral sites: the documented home team is the home side, its spread used as is.
- Scope: REG games only (`game_type == "REG"`), seasons 2012–2025; QB/RB/WR/TE.
- Team codes: `OAK→LV`, `SD→LAC`, `STL→LA`, validated against the fixed canonical 32-team set; `game_id` preserved.
- `team_implied_total` = `(T + m)/2` home, `(T − m)/2` away; `team_expected_margin` = `m` home, `−m` away
  (`T = total_line`, `m = spread_line`). Worked example `T = 46`, `m = +6` → 26 / 20, +6 / −6.
- Arm A = `XGBBaseline(feature_set="v1")` (40 columns); arm B = `XGBBaseline(feature_set="v1_lines")` =
  `A_list + ["team_implied_total", "team_expected_margin"]` (42 columns, this order).
- Estimator: 300 trees, depth 5, lr 0.05, subsample 0.8, colsample 0.8, `hist`, `n_jobs=-1`, no tuning; seeds 0, 1, 2
  paired across arms; predictions unclipped.
- Walk-forward: train 2012..S−1, test S ∈ {2023, 2024, 2025}; expected test rows 5,893 / 5,920 / 6,095 (17,908);
  a mismatch is reported, not tuned away.
- Scoring: `actual = fantasy_points(test[PREDICTED_STATS], PPR)`, `pred = fantasy_points(pred_stats[PREDICTED_STATS],
  PPR)` (4-point passing TDs, no 2-pt conversions or special-teams TDs). Non-finite predicted component → `invalid`.
- `d_{i,s} = |actual_i − predA_{i,s}| − |actual_i − predB_{i,s}|`; `d_i = mean_s d_{i,s}`; G = equal-weight mean over
  seasons of within-season row means.
- Bootstrap: player universe = sorted distinct `player_id`s of the 2023–25 test panel; blocks `b = (week − 1) // 2`
  per season; `Generator(PCG64(20261007))`; draw P players, then per season ascending its blocks; `w_i =
  player_count × block_count`; reject a replicate with any season (or relevant-cohort season) weight 0; **10,000
  accepted**, at most **100,000** attempts; central 95% percentile interval, `method="linear"`.
- Relevant cohort: `mean_s predA_{i,s} ≥ 8` PPR; guardrail passes when `−(lower endpoint of G_rel's 95% interval)
  ≤ 0.10`; an original season with no relevant rows → `invalid` before any bootstrap attempt.
- Ranking: cells `(season, week, position)` with ≥ 5 distinct players; average-rank Spearman per seed; seeds → cells
  in season → seasons; `ranking_ok` if `R ≥ −0.005`, `ranking_veto` if `R < −0.005`, `ranking_not_evaluable` on a
  finite constant prediction in an otherwise eligible cell or a season with no eligible cell.
- Decision (unrounded): 1. `G ≥ 0.05`; 2. lower bound `> 0`; 3. ≥ 2 seasons `G_S > 0`; 4. no `G_S < −0.05`;
  5. all `G^{(s)} > 0`; 6. guardrail passes. `invalid` is decided first. Failure labels on valid runs only:
  below materiality (upper bound `< 0.05`) or inconclusive/unstable (failed conditions named).
- **Both `ranking_veto` and `ranking_not_evaluable` forbid recommending lines for any ranking product and are carried
  into the forward test's pre-registration (§5.4, §9).** Neither changes the point gate or validity.
- Artifact: `models/diagnostics/lines_screen.json`, written with `allow_nan=False`; unavailable values are `null`
  with a status and reason.

## Review Focus

These are the five inputs most likely to break the screen silently. Each one is pinned by a test in the task that
owns the code.

1. **A player row whose team is null or unknown in the feature frame.** It must make the run `invalid`, as an
   unmatched team-week. It must not become a NaN feature or a reordered-key error.
   Pinned by `test_player_row_with_null_team_is_unmatched_not_missing_quote` (Task 2).
2. **Two copies of one game that differ outside the allow-list, or only by a legacy team code.**
   - A difference only in outcome columns is an exact duplicate: collapsed and counted.
   - `OAK` and `LV` sides of one game become identical teams after normalisation, which is fatal.
   Pinned by `test_outcome_only_difference_is_still_an_exact_duplicate` and
   `test_identical_after_normalisation_is_fatal` (Task 2).
3. **A predictor that omits a stat component.** `fantasy_points` silently scores a missing column as zero, so this
   must be `invalid`, never a quietly lower prediction.
   Pinned by `test_collector_invalid_predictions[missing_column]` (Task 4).
4. **Column order in the frozen frame.** `feature_columns` orders lag and `pos_` columns by their order in the frame,
   and XGBoost's `colsample_bytree` makes order part of the result. The frozen frame must reproduce the exact A and B
   lists, and `week` appears once even though it is both a key and a feature.
   Pinned by `test_model_frame_holds_exactly_keys_features_and_targets` and the read-back list check in `run_screen`
   (Task 4).
5. **Re-running over an existing frozen input or result.** The schedule snapshot and its sidecar, the frozen frame, the
   manifest, the paired rows and the artifact are each written once and refused if they already exist. `freeze`
   refuses an existing manifest, artifact or frame path before any validation or write, so even a failing freeze
   cannot replace an earlier `invalid` result. `write_json` itself opens with exclusive create. A defect rerun uses
   new manifest, frame, result and paired-row paths and keeps every earlier record (§7).
   Pinned by `test_snapshot_writes_meta_and_refuses_overwrite` and
   `test_snapshot_refuses_an_existing_sidecar_and_keeps_its_bytes` (Task 2), and by
   `test_frozen_frame_hash_schema_and_no_overwrite`, `test_run_reads_frozen_frame_and_writes_strict_artifact`,
   `test_freeze_never_replaces_an_existing_manifest_or_result`, `test_freeze_refuses_before_any_validation`,
   `test_second_failing_freeze_preserves_the_first_invalid_result`,
   `test_second_freeze_with_a_new_frame_path_cannot_replace_the_manifest` and
   `test_write_json_refuses_replacement_and_leaves_no_partial_file` (Task 4).

## File Structure

| File | Responsibility |
|---|---|
| `src/ffmodel/data/features.py` (modify) | `LINE_FEATURE_COLUMNS`, `LINE_FEATURE_SETS`, `v1_lines` registry entry; `feature_columns` appends + raises |
| `tests/test_features.py` (modify, one test) | the all-sets test supplies the two line columns |
| `tests/test_lines_features.py` (create) | §3 / §11 feature-list pins (A 40 unchanged, B 42, raise, v2 unchanged) |
| `src/ffmodel/data/lines.py` (create) | snapshot, allow-list, §2.1 taxonomy, team-game table, many-to-one join |
| `tests/test_lines_data.py` (create) | §11 formula, team-code, duplicate, quote, join, allow-list, snapshot cases |
| `src/ffmodel/eval/lines_stats.py` (create) | §4–§7 pure statistics, bootstrap, ranking status, decision, consequences |
| `tests/test_lines_stats.py` (create) | §11 statistics, bootstrap, ranking and decision cases |
| `tests/lines_world.py` (create, helper — not collected) | seeded synthetic 4-team world + stand-in predictor |
| `src/ffmodel/eval/lines_screen.py` (create) | frozen frame, collector, manifest, run, CLI |
| `tests/test_lines_screen.py` (create) | §8 / §11 frozen-frame, collector, freeze/run, abandon cases |

Tasks run **sequentially**: 2 imports Task 1's constant, 4 imports 1–3.

**Model assignment (CLAUDE.md):** every task below carries complete code, so implementers are `sonnet`. Reviewers:
- Task 1: `sonnet`.
- Tasks 2, 3 and 4: `opus`. Task 2 is the leak surface (allow-list and join), Task 3 is numerics, and Task 4 is the
  frozen-input integrity.
- Final whole-branch review: `opus`.

---

### Task 1: `v1_lines` feature set

**Model:** implementer `sonnet`; reviewer `sonnet`.

**Files:**
- Modify: `src/ffmodel/data/features.py` (the `BASELINE_FEATURE_SETS` block and the end of `feature_columns`)
- Modify: `tests/test_features.py` (`test_feature_columns_never_include_same_week_stats`)
- Create: `tests/test_lines_features.py`

**Interfaces:**
- Consumes: `feature_columns(df, feature_set="v1") -> list[str]` and `BASELINE_FEATURE_SETS` (existing,
  `src/ffmodel/data/features.py`); `XGBBaseline(n_estimators=300, seed=0, feature_set="v1")` and its `_matrix(df)`
  (existing, `src/ffmodel/baseline/xgb.py`). `XGBBaseline.__init__` validates `feature_set in BASELINE_FEATURE_SETS`
  and renames non-default sets to `xgboost_<set>`, so it needs no change.
- Produces: `LINE_FEATURE_COLUMNS: list[str] = ["team_implied_total", "team_expected_margin"]`;
  `LINE_FEATURE_SETS: frozenset[str] = frozenset({"v1_lines"})`; `BASELINE_FEATURE_SETS["v1_lines"] = ()`;
  `feature_columns(df, "v1_lines")` returns the v1 list plus `LINE_FEATURE_COLUMNS`, and raises
  `ValueError("... needs line column(s) ...")` if either is missing.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_lines_features.py`:

```python
"""Feature-set resolution for the lines screen (spec 2026-10-11 §3, §11)."""
import numpy as np
import pandas as pd
import pytest

from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.data.features import (
    LINE_FEATURE_COLUMNS,
    build_features,
    feature_columns,
)

from tests.test_features import V1_FEATURE_COLUMNS, make_schedules, make_weekly


def _frames() -> tuple[pd.DataFrame, pd.DataFrame]:
    """(plain, augmented): the same build_features output, without and with
    the two line columns (one NaN quote row included)."""
    weekly = make_weekly([
        {"week": 1, "receiving_yards": 50.0, "receiving_air_yards": 10.0, "attempts": 20.0},
        {"week": 2, "receiving_yards": 70.0, "receiving_air_yards": 5.0, "attempts": 30.0},
        {"week": 3, "receiving_yards": 90.0, "receiving_air_yards": 7.0, "attempts": 25.0},
    ])
    plain = build_features(weekly, make_schedules(roof="dome"))
    augmented = plain.assign(
        team_implied_total=[26.0, np.nan, 20.5],
        team_expected_margin=[6.0, np.nan, -3.5],
    )
    return plain, augmented


def test_v1_list_and_values_unchanged_on_augmented_frame():
    plain, augmented = _frames()
    assert feature_columns(augmented, "v1") == V1_FEATURE_COLUMNS
    assert len(feature_columns(augmented, "v1")) == 40
    pd.testing.assert_frame_equal(
        XGBBaseline(feature_set="v1")._matrix(augmented),
        XGBBaseline(feature_set="v1")._matrix(plain),
    )


def test_v1_lines_is_v1_plus_exactly_the_two_line_columns_in_order():
    _, augmented = _frames()
    cols = feature_columns(augmented, "v1_lines")
    assert LINE_FEATURE_COLUMNS == ["team_implied_total", "team_expected_margin"]
    assert cols == V1_FEATURE_COLUMNS + LINE_FEATURE_COLUMNS
    assert len(cols) == 42
    matrix = XGBBaseline(feature_set="v1_lines")._matrix(augmented)
    assert list(matrix.columns) == cols
    assert np.isnan(matrix["team_implied_total"].iloc[1])   # NaN kept, not filled


@pytest.mark.parametrize("absent", ["team_implied_total", "team_expected_margin"])
def test_v1_lines_raises_when_a_line_column_is_absent(absent):
    _, augmented = _frames()
    with pytest.raises(ValueError, match="needs line column"):
        feature_columns(augmented.drop(columns=[absent]), "v1_lines")
    with pytest.raises(ValueError, match="needs line column"):
        XGBBaseline(feature_set="v1_lines")._matrix(augmented.drop(columns=[absent]))


def test_v2_unchanged_on_augmented_frame():
    plain, augmented = _frames()
    assert feature_columns(augmented, "v2") == feature_columns(plain, "v2")
    assert not set(LINE_FEATURE_COLUMNS) & set(feature_columns(augmented, "v2"))


def test_lines_entrant_is_renamed():
    assert XGBBaseline(feature_set="v1_lines").name == "xgboost_v1_lines"
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_features.py`
Expected: collection error, `ImportError: cannot import name 'LINE_FEATURE_COLUMNS'`.

- [ ] **Step 3: Implement in `src/ffmodel/data/features.py`**

Replace

```python
BASELINE_FEATURE_SETS = {
    "v1": (),
    "v2": tuple(V2_FEATURE_COLUMNS),
}
DEFAULT_BASELINE_FEATURE_SET = "v1"
```

with

```python
BASELINE_FEATURE_SETS = {
    "v1": (),
    "v2": tuple(V2_FEATURE_COLUMNS),
    # Lines screen (docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md
    # §3): the frozen v1 list, then exactly LINE_FEATURE_COLUMNS appended.
    "v1_lines": (),
}
DEFAULT_BASELINE_FEATURE_SET = "v1"
# Current-game betting-market columns. Never built by build_features: they are
# joined by ffmodel.data.lines.join_line_features, and only a feature set in
# LINE_FEATURE_SETS consumes them -- appended after its base list, in this order.
LINE_FEATURE_COLUMNS = ["team_implied_total", "team_expected_margin"]
LINE_FEATURE_SETS = frozenset({"v1_lines"})
```

and replace the last line of `feature_columns`

```python
    return lag_cols + context + extra + pos_cols
```

with

```python
    cols = lag_cols + context + extra + pos_cols
    if feature_set in LINE_FEATURE_SETS:
        # Raise rather than skip: a lines arm silently resolving to its base
        # list would run arm B as arm A and report a zero effect.
        missing = [c for c in LINE_FEATURE_COLUMNS if c not in df.columns]
        if missing:
            raise ValueError(
                f"feature_set {feature_set!r} needs line column(s) {missing}; "
                f"join them with ffmodel.data.lines.join_line_features first")
        cols = cols + LINE_FEATURE_COLUMNS
    return cols
```

`v1_lines` excludes every v2-pack column exactly as v1 does (its registry tuple is empty). The two line names match
none of the prefix or explicit lists v1 and v2 draw from, so v1 and v2 are unchanged on a frame carrying them.

- [ ] **Step 4: Keep the existing all-sets test meaningful**

`test_feature_columns_never_include_same_week_stats` in `tests/test_features.py` loops over every registered set and
would now raise for `v1_lines` (its frame has no line columns). In that test replace

```python
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    for feature_set in sorted(BASELINE_FEATURE_SETS):
```

with

```python
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    # v1_lines raises without its two joined line columns; supply them so
    # every registered set is checked.
    out = out.assign(team_implied_total=24.0, team_expected_margin=3.0)
    for feature_set in sorted(BASELINE_FEATURE_SETS):
```

(The `out = build_features(...)` line occurs in several tests; edit only the one inside
`test_feature_columns_never_include_same_week_stats`.)

- [ ] **Step 5: Run to verify pass**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_features.py tests/test_features.py tests/test_xgb.py`
Expected: `36 passed`.

- [ ] **Step 6: Commit**

```bash
git add src/ffmodel/data/features.py tests/test_features.py tests/test_lines_features.py
git commit -m "feat(features): v1_lines feature set — frozen v1 + two line columns, raises if absent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Lines loader, §2.1 taxonomy and join

**Model:** implementer `sonnet`; reviewer `opus` (leak surface: allow-list boundary, duplicate/identity taxonomy,
join cardinality).

**Files:**
- Create: `src/ffmodel/data/lines.py`
- Create: `tests/test_lines_data.py`

**Interfaces:**
- Consumes:
  - `LINE_FEATURE_COLUMNS` (Task 1);
  - `FRANCHISE_CODES: set[str]` (the canonical 32) and `normalize_schedule_teams(sched) -> DataFrame` (which
    replaces `STL/SD/OAK` in `home_team`/`away_team`), both existing in `src/ffmodel/data/pull.py`;
  - `build_features(weekly, schedules)` and `make_weekly(rows)` (tests only; existing).
- Produces:
  - `class LinesDataError(ValueError)`.
  - `ALLOWED_COLUMNS: list[str]` (the eight), `QUOTE_STATUSES = ("valid", "missing_quote", "nonpositive_total",
    "negative_implied_total")` and `EXPECTED_REG_GAMES = 3663`.
  - `file_sha256(path) -> str` and `package_version(name) -> str | None`.
  - `snapshot_meta_path(path) -> Path`, which gives `<stem>.meta.json`.
  - `snapshot_schedules(seasons, path, loader=None) -> dict` returns `{path, seasons, rows, retrieved_at,
    nflreadpy_version, sha256}`. It writes the parquet and the sidecar (exclusive create), and raises
    `FileExistsError` if the path or its sidecar exists.
  - `read_snapshot(path, expected_sha256) -> DataFrame` raises `LinesDataError` on a hash mismatch.
  - `select_allowed(raw) -> DataFrame` returns exactly `ALLOWED_COLUMNS`.
  - `validate_games(allowed, seasons) -> (games, report)`. `games` holds the REG games in `seasons`, sorted by
    (season, week, game_id), with an added `quote_status`. `report` has `payload_records`,
    `exact_duplicates_collapsed`, `reg_games`, `reg_games_by_season`, `quote_status_counts`, `expected_reg_games` and
    `coverage_matches_claim`.
  - `team_game_lines(games) -> DataFrame` has columns `season, week, game_id, team, side, quote_status,
    team_implied_total, team_expected_margin`, two rows per game.
  - `build_line_table(raw, seasons) -> (team_lines, report)`.
  - `join_line_features(features, team_lines) -> (features_with_two_columns, report_by_season)`. Each season's
    report is `{rows, matched_valid_quote, missing_quote_by_reason: {missing_quote, nonpositive_total,
    negative_implied_total}}`.

Behaviour notes for the reviewer:

- **Order of checks.** Missing key fields are checked first. Next, exact duplicates over the eight raw allowed values
  are collapsed, before team normalisation. Then any remaining repeated `game_id` is fatal, so `OAK`/`LV` copies of
  one game are fatal and are not collapsed.
- **Fatal checks after normalisation:** an unknown code, identical home and away teams, and a (season, week, team)
  claimed by two `game_id`s. All identity checks run on every payload record, of every game type, before scoping to
  REG and `seasons`.
- **Quote status precedence:** a non-finite spread or total is `missing_quote`, then `total ≤ 0` is
  `nonpositive_total`, then either side's implied total `< 0` is `negative_implied_total`. An implied total of
  exactly 0 is allowed.
- **No arithmetic on unusable quotes.** The status checks do arithmetic only on rows with a finite spread and total,
  and `team_game_lines` computes implied totals and margins only on `valid` rows (mask first, never `np.where`). This
  matters because `np.where` evaluates both branches: with spread and total both infinite, `inf - inf` emits a
  `RuntimeWarning`, and that warning is an error under `-W error`. Pinned by the joint-non-finite cases of
  `test_unusable_quote_gives_nan_for_both_sides`.
- **The join** checks unmatched rows before key equality, so a null team is reported as unmatched.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_lines_data.py`:

```python
"""Lines loader, validation taxonomy and join (spec 2026-10-11 §2-3, §11).

All synthetic; no network. Quote values are invented round numbers, not
real market data.
"""
import json
import warnings

import numpy as np
import pandas as pd
import pytest

from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.data.features import build_features
from ffmodel.data.lines import (
    ALLOWED_COLUMNS,
    LinesDataError,
    build_line_table,
    file_sha256,
    join_line_features,
    read_snapshot,
    select_allowed,
    snapshot_meta_path,
    snapshot_schedules,
    team_game_lines,
    validate_games,
)

from tests.test_features import make_weekly

SEASONS = [2023]


def raw_game(**overrides) -> dict:
    """One raw nflverse-style schedule record, outcome columns included."""
    base = {
        "game_id": "2023_01_BUF_KC", "season": 2023, "game_type": "REG", "week": 1,
        "gameday": "2023-09-10", "away_team": "BUF", "home_team": "KC",
        "away_score": 20, "home_score": 27, "location": "Home", "result": 7,
        "total": 47, "overtime": 0, "spread_line": 6.0, "total_line": 46.0,
        "away_moneyline": 200.0, "home_moneyline": -240.0, "roof": "outdoors",
    }
    return {**base, **overrides}


def raw_frame(*records: dict) -> pd.DataFrame:
    return pd.DataFrame(list(records))


def lines_for(*records: dict) -> pd.DataFrame:
    table, _ = build_line_table(raw_frame(*records), SEASONS)
    return table


def side(table: pd.DataFrame, team: str) -> pd.Series:
    return table[table["team"] == team].iloc[0]


# --- feature formulas -----------------------------------------------------

def test_worked_example_46_and_plus_6():
    table = lines_for(raw_game(total_line=46.0, spread_line=6.0))
    home, away = side(table, "KC"), side(table, "BUF")
    assert (home["side"], away["side"]) == ("home", "away")
    assert home["team_implied_total"] == 26.0 and away["team_implied_total"] == 20.0
    assert home["team_expected_margin"] == 6.0 and away["team_expected_margin"] == -6.0


@pytest.mark.parametrize("total,spread", [(46.0, 6.0), (41.5, -3.5), (50.0, 13.0), (38.0, 0.0)])
def test_implied_total_identities(total, spread):
    table = lines_for(raw_game(total_line=total, spread_line=spread))
    home, away = side(table, "KC"), side(table, "BUF")
    assert home["team_implied_total"] + away["team_implied_total"] == pytest.approx(total, abs=1e-9)
    assert home["team_implied_total"] - away["team_implied_total"] == pytest.approx(spread, abs=1e-9)
    assert home["team_expected_margin"] == -away["team_expected_margin"] == spread


def test_sign_convention_positive_spread_is_home_favoured():
    fav_home = lines_for(raw_game(spread_line=3.0))
    fav_away = lines_for(raw_game(spread_line=-3.0))
    assert side(fav_home, "KC")["team_implied_total"] > side(fav_home, "BUF")["team_implied_total"]
    assert side(fav_away, "KC")["team_implied_total"] < side(fav_away, "BUF")["team_implied_total"]
    assert side(fav_away, "BUF")["team_expected_margin"] == 3.0


def test_pick_em_splits_the_total_evenly():
    table = lines_for(raw_game(total_line=44.0, spread_line=0.0))
    for team in ("KC", "BUF"):
        assert side(table, team)["team_implied_total"] == 22.0
        assert side(table, team)["team_expected_margin"] == 0.0


def test_neutral_site_uses_documented_home_side_as_is():
    home_site = lines_for(raw_game(location="Home"))
    neutral = lines_for(raw_game(location="Neutral"))
    pd.testing.assert_frame_equal(home_site, neutral)
    assert side(neutral, "KC")["side"] == "home"
    assert side(neutral, "KC")["team_expected_margin"] == 6.0


# --- team codes -------------------------------------------------------------

@pytest.mark.parametrize("legacy,current", [("OAK", "LV"), ("SD", "LAC"), ("STL", "LA")])
def test_legacy_team_codes_are_normalised_and_game_id_preserved(legacy, current):
    gid = f"2023_01_BUF_{legacy}"
    table = lines_for(raw_game(home_team=legacy, game_id=gid))
    assert set(table["team"]) == {current, "BUF"}
    assert set(table["game_id"]) == {gid}


def test_unknown_team_code_is_fatal():
    with pytest.raises(LinesDataError, match="unknown team code"):
        lines_for(raw_game(home_team="XXX"))


def test_identical_home_and_away_is_fatal():
    with pytest.raises(LinesDataError, match="identical home and away"):
        lines_for(raw_game(home_team="BUF", away_team="BUF"))


def test_identical_after_normalisation_is_fatal():
    with pytest.raises(LinesDataError, match="identical home and away"):
        lines_for(raw_game(home_team="OAK", away_team="LV"))


# --- duplicate / identity taxonomy ---------------------------------------------

def test_exact_duplicate_collapses_and_is_counted():
    games, report = validate_games(select_allowed(raw_frame(raw_game(), raw_game())), SEASONS)
    assert len(games) == 1
    assert report["exact_duplicates_collapsed"] == 1


def test_exact_duplicate_with_missing_quote_collapses_too():
    games, report = validate_games(
        select_allowed(raw_frame(raw_game(total_line=np.nan), raw_game(total_line=np.nan))), SEASONS)
    assert len(games) == 1 and report["exact_duplicates_collapsed"] == 1
    assert games["quote_status"].iloc[0] == "missing_quote"


def test_outcome_only_difference_is_still_an_exact_duplicate():
    # result/score columns are outside the allow-list, so they cannot make
    # two otherwise identical records "different".
    games, report = validate_games(
        select_allowed(raw_frame(raw_game(result=7), raw_game(result=-3))), SEASONS)
    assert len(games) == 1 and report["exact_duplicates_collapsed"] == 1


@pytest.mark.parametrize("override", [
    {"home_team": "MIA"},              # different teams
    {"total_line": 47.0},             # same teams, different quote (44 vs 47 style)
    {"spread_line": 3.0},             # same teams, different spread
    {"week": 2},                      # same teams, different week
    {"game_type": "WC"},              # same teams, different game_type
    {"season": 2022},                 # same teams, different season
])
def test_repeated_game_id_that_is_not_an_exact_duplicate_is_fatal(override):
    first = raw_game(total_line=44.0)
    second = raw_game(**{"total_line": 44.0, **override})
    with pytest.raises(LinesDataError, match="repeated game_id"):
        lines_for(first, second)


def test_legacy_and_current_code_copies_of_one_game_are_fatal_not_collapsed():
    # Exact-duplicate collapse compares the RAW allowed values, before team
    # normalisation, so an OAK copy and an LV copy are two different records.
    with pytest.raises(LinesDataError, match="repeated game_id"):
        lines_for(raw_game(game_id="2019_01_BUF_OAK", home_team="OAK", season=2023),
                  raw_game(game_id="2019_01_BUF_OAK", home_team="LV", season=2023))


def test_team_week_collision_is_fatal():
    other = raw_game(game_id="2023_01_KC_MIA", home_team="MIA", away_team="KC")
    with pytest.raises(LinesDataError, match="team-week collision"):
        lines_for(raw_game(), other)


@pytest.mark.parametrize("column", ["season", "week", "game_type", "game_id", "home_team", "away_team"])
def test_missing_key_field_is_fatal(column):
    record = raw_game()
    record[column] = None
    frame = raw_frame(record, raw_game(game_id="2023_02_BUF_KC", week=2))
    with pytest.raises(LinesDataError, match="missing key field"):
        build_line_table(frame, SEASONS)


def test_missing_allowed_column_is_fatal():
    with pytest.raises(LinesDataError, match="missing allowed column"):
        select_allowed(raw_frame(raw_game()).drop(columns=["total_line"]))


# --- recoverable quotes --------------------------------------------------------

@pytest.mark.parametrize("quote,reason", [
    ({"spread_line": np.nan}, "missing_quote"),
    ({"total_line": np.nan}, "missing_quote"),
    ({"total_line": np.inf}, "missing_quote"),
    # Joint non-finite: inf - inf / inf + -inf must never be evaluated (it
    # would emit a RuntimeWarning, an error under -W error).
    ({"total_line": np.inf, "spread_line": np.inf}, "missing_quote"),
    ({"total_line": np.inf, "spread_line": -np.inf}, "missing_quote"),
    ({"total_line": 0.0}, "nonpositive_total"),
    ({"total_line": -40.0}, "nonpositive_total"),
    ({"total_line": 10.0, "spread_line": 14.0}, "negative_implied_total"),
])
def test_unusable_quote_gives_nan_for_both_sides(quote, reason):
    with warnings.catch_warnings():
        warnings.simplefilter("error")                       # no warning, whatever the pytest flags
        table, report = build_line_table(raw_frame(raw_game(**quote)), SEASONS)
    assert len(table) == 2                                   # both sides kept
    assert set(table["quote_status"]) == {reason}
    assert table[["team_implied_total", "team_expected_margin"]].isna().all().all()
    assert report["quote_status_counts"][reason] == 1
    assert report["quote_status_counts"]["valid"] == 0


def test_team_game_lines_rejects_a_broken_identity():
    games, _ = validate_games(select_allowed(raw_frame(raw_game())), SEASONS)
    games = games.assign(quote_status="valid", total_line=np.nan)  # valid label, no total
    with pytest.raises(LinesDataError, match="identities"):
        team_game_lines(games)


def test_scope_is_reg_games_in_requested_seasons():
    frame = raw_frame(
        raw_game(),
        raw_game(game_id="2023_19_BUF_KC", week=19, game_type="WC"),
        raw_game(game_id="2022_01_BUF_KC", season=2022),
    )
    games, report = validate_games(select_allowed(frame), SEASONS)
    assert list(games["game_id"]) == ["2023_01_BUF_KC"]
    assert report["payload_records"] == 3 and report["reg_games"] == 1
    assert report["coverage_matches_claim"] is False        # 1 != 3663, recorded not fatal


# --- join ---------------------------------------------------------------------

def players(rows: list[dict]) -> pd.DataFrame:
    base = {"player_id": "p1", "season": 2023, "week": 1, "team": "KC", "position": "WR"}
    return pd.DataFrame([{**base, **r} for r in rows], index=[10 + i for i in range(len(rows))])


def two_week_lines(week2_quote: dict | None = None) -> pd.DataFrame:
    return lines_for(raw_game(),
                     raw_game(game_id="2023_02_BUF_KC", week=2, **(week2_quote or {})))


def test_join_keeps_row_count_order_index_and_keys():
    feats = players([
        {"player_id": "p2", "week": 2, "team": "BUF"},
        {"player_id": "p1", "week": 1, "team": "KC"},
        {"player_id": "p3", "week": 1, "team": "BUF"},
        {"player_id": "p1", "week": 2, "team": "KC"},
    ])
    out, report = join_line_features(feats, two_week_lines())
    pd.testing.assert_frame_equal(out.drop(columns=["team_implied_total", "team_expected_margin"]), feats)
    assert list(out["team_implied_total"]) == [20.0, 26.0, 20.0, 26.0]
    assert list(out["team_expected_margin"]) == [-6.0, 6.0, -6.0, 6.0]
    assert report[2023]["rows"] == 4 and report[2023]["matched_valid_quote"] == 4


def test_join_is_many_to_one():
    table = two_week_lines()
    dup = pd.concat([table, table.iloc[[0]]], ignore_index=True)
    with pytest.raises(LinesDataError, match="not unique"):
        join_line_features(players([{}]), dup)


def test_missing_quote_rows_are_kept_and_counted_separately_from_unmatched():
    feats = players([{"week": 1}, {"week": 2}, {"week": 2, "player_id": "p9", "team": "BUF"}])
    out, report = join_line_features(feats, two_week_lines({"total_line": np.nan}))
    assert len(out) == 3
    assert np.isnan(out["team_implied_total"].iloc[1]) and np.isnan(out["team_implied_total"].iloc[2])
    assert out["team_implied_total"].iloc[0] == 26.0
    assert report[2023]["matched_valid_quote"] == 1
    assert report[2023]["missing_quote_by_reason"]["missing_quote"] == 2


def test_unmatched_player_team_week_is_fatal():
    feats = players([{"week": 1}, {"week": 3}])          # no week-3 game
    with pytest.raises(LinesDataError, match="unmatched player team-week"):
        join_line_features(feats, two_week_lines())


def test_player_row_with_null_team_is_unmatched_not_missing_quote():
    feats = players([{"week": 1}, {"week": 1, "player_id": "p2", "team": None}])
    with pytest.raises(LinesDataError, match="unmatched player team-week"):
        join_line_features(feats, two_week_lines())


def test_join_refuses_a_frame_that_already_has_line_columns():
    with pytest.raises(ValueError, match="already in the feature frame"):
        join_line_features(players([{}]).assign(team_implied_total=1.0), two_week_lines())


# --- allow-list: outcome columns cannot move features or the model matrix -------

def _world_raw() -> pd.DataFrame:
    return raw_frame(*[
        raw_game(game_id=f"2023_{w:02d}_BUF_KC", week=w, spread_line=float(w) - 2.5,
                 total_line=40.0 + w)
        for w in range(1, 5)
    ])


def _world_features() -> pd.DataFrame:
    rows = []
    for w in range(1, 5):
        rows.append({"player_id": "p1", "team": "KC", "opponent_team": "BUF", "week": w,
                     "receiving_yards": 30.0 * w, "receptions": float(w)})
        rows.append({"player_id": "p2", "team": "BUF", "opponent_team": "KC", "week": w,
                     "position": "RB", "rushing_yards": 20.0 * w, "carries": 5.0 + w})
    sched = pd.DataFrame({
        "season": 2023, "week": range(1, 5),
        "gameday": pd.date_range("2023-09-10", periods=4, freq="7D").strftime("%Y-%m-%d"),
        "home_team": "KC", "away_team": "BUF",
    })
    return build_features(make_weekly(rows), sched)


def test_outcome_columns_cannot_change_features_or_matrix():
    raw = _world_raw()
    perturbed = raw.assign(
        result=-raw["result"] * 9, total=raw["total"] + 30, home_score=0, away_score=99,
        overtime=1, away_moneyline=-raw["away_moneyline"], location="Neutral",
        surprise_outcome_column=123.0,
    )
    feats = _world_features()
    out_a, _ = join_line_features(feats, build_line_table(raw, SEASONS)[0])
    out_b, _ = join_line_features(feats, build_line_table(perturbed, SEASONS)[0])
    pd.testing.assert_frame_equal(out_a, out_b)
    m_a = XGBBaseline(feature_set="v1_lines")._matrix(out_a)
    m_b = XGBBaseline(feature_set="v1_lines")._matrix(out_b)
    assert list(m_a.columns) == list(m_b.columns)
    assert m_a.to_numpy().tobytes() == m_b.to_numpy().tobytes()
    assert list(select_allowed(perturbed).columns) == ALLOWED_COLUMNS


# --- snapshot -----------------------------------------------------------------

def test_snapshot_writes_meta_and_refuses_overwrite(tmp_path):
    path = tmp_path / "lines" / "schedules_raw.parquet"
    meta = snapshot_schedules([2023], path, loader=lambda: _world_raw())
    assert meta["sha256"] == file_sha256(path)
    assert meta["rows"] == 4 and meta["seasons"] == [2023]
    assert json.loads(snapshot_meta_path(path).read_text(encoding="utf-8")) == meta
    assert "retrieved_at" in meta and "nflreadpy_version" in meta
    pd.testing.assert_frame_equal(read_snapshot(path, meta["sha256"]), _world_raw())
    with pytest.raises(FileExistsError):
        snapshot_schedules([2023], path, loader=lambda: _world_raw())


def test_snapshot_refuses_an_existing_sidecar_and_keeps_its_bytes(tmp_path):
    path = tmp_path / "schedules_raw.parquet"
    snapshot_meta_path(path).write_bytes(b"original sidecar")

    def never():
        raise AssertionError("must not pull when the sidecar exists")

    with pytest.raises(FileExistsError):
        snapshot_schedules([2023], path, loader=never)
    assert snapshot_meta_path(path).read_bytes() == b"original sidecar"
    assert not path.exists()


def test_read_snapshot_rejects_changed_bytes(tmp_path):
    path = tmp_path / "schedules_raw.parquet"
    meta = snapshot_schedules([2023], path, loader=lambda: _world_raw())
    _world_raw().assign(total_line=1.0).to_parquet(path, index=False)
    with pytest.raises(LinesDataError, match="sha256"):
        read_snapshot(path, meta["sha256"])
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_data.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ffmodel.data.lines'`.

- [ ] **Step 3: Implement**

Create `src/ffmodel/data/lines.py`:

```python
"""Betting-market lines for the lines feature screen.

Spec: docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md §2-3.

The nflverse schedule feed carries a spread and a total per game, treated as
closing-time context (their book and quote time are not recorded; availability
at our mid-week deadline is unverified). This module

- snapshots the raw payload once, so every model run reads frozen bytes;
- keeps exactly ALLOWED_COLUMNS before any transformation, so outcome columns
  (`result`, `total`, scores) can never reach a feature;
- classifies every game under the §2.1 taxonomy: a uniquely identified game
  with an unusable quote is RECOVERABLE (both features NaN for both teams);
  any ambiguity of identity is FATAL (LinesDataError -> the run is `invalid`);
- joins the two current-game columns onto the feature frame, many-to-one.

Sign convention: the nflverse schedule dictionary defines positive
`spread_line` as HOME FAVOURED. That dictionary is the authority; signs are
never inferred or flipped from outcomes. At neutral sites the documented home
team is the home side.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.data.features import LINE_FEATURE_COLUMNS
from ffmodel.data.pull import FRANCHISE_CODES, normalize_schedule_teams

ALLOWED_COLUMNS = ["season", "week", "game_type", "game_id",
                   "home_team", "away_team", "spread_line", "total_line"]
KEY_COLUMNS = ["season", "week", "game_type", "game_id", "home_team", "away_team"]
CANONICAL_TEAMS = frozenset(FRANCHISE_CODES)
# Spec §2 coverage claim for REG 2012-2025; re-checked and recorded, never fatal.
EXPECTED_REG_GAMES = 3663
IDENTITY_TOL = 1e-9
QUOTE_STATUSES = ("valid", "missing_quote", "nonpositive_total", "negative_implied_total")


class LinesDataError(ValueError):
    """Fatal data error under spec §2.1 (ambiguous identity or unmatched join).

    The screen's disposition becomes `invalid`; no record is preferred,
    averaged or dropped to continue.
    """


def file_sha256(path: Path | str) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def snapshot_meta_path(path: Path | str) -> Path:
    path = Path(path)
    return path.with_name(path.stem + ".meta.json")


def snapshot_schedules(seasons: list[int], path: Path | str, loader=None) -> dict:
    """Pull the raw schedule payload ONCE and freeze it as a local parquet.

    Refuses to overwrite an existing snapshot or sidecar: the input freeze
    (spec §2) is only meaningful if the bytes cannot be silently replaced.
    Writes a sidecar `<stem>.meta.json` (exclusive create) with retrieval time
    (UTC), nflreadpy version, row count and the file's sha256, and returns the
    same dict.
    """
    path = Path(path)
    for p in (path, snapshot_meta_path(path)):
        if p.exists():
            raise FileExistsError(f"{p} already exists; a schedule snapshot is never overwritten")
    if loader is None:
        def loader() -> pd.DataFrame:
            import nflreadpy  # deferred: keep offline unit tests import-light

            return nflreadpy.load_schedules(seasons).to_pandas()
    retrieved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    raw = loader()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        raw.to_parquet(tmp, index=False)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()
    meta = {
        "path": path.as_posix(),
        "seasons": sorted(int(s) for s in seasons),
        "rows": int(len(raw)),
        "retrieved_at": retrieved_at,
        "nflreadpy_version": package_version("nflreadpy"),
        "sha256": file_sha256(path),
    }
    with snapshot_meta_path(path).open("x", encoding="utf-8") as fh:   # "x": never replace
        fh.write(json.dumps(meta, indent=2))
    return meta


def read_snapshot(path: Path | str, expected_sha256: str) -> pd.DataFrame:
    """Read the frozen payload, refusing bytes that differ from the recorded hash."""
    actual = file_sha256(path)
    if actual != expected_sha256:
        raise LinesDataError(
            f"schedule snapshot {path} sha256 {actual} != recorded {expected_sha256}")
    return pd.read_parquet(path)


def select_allowed(raw: pd.DataFrame) -> pd.DataFrame:
    """Exactly ALLOWED_COLUMNS, in that order, before any transformation."""
    missing = [c for c in ALLOWED_COLUMNS if c not in raw.columns]
    if missing:
        raise LinesDataError(f"schedule payload is missing allowed column(s) {missing}")
    return raw[ALLOWED_COLUMNS].copy()


def validate_games(allowed: pd.DataFrame, seasons: list[int]) -> tuple[pd.DataFrame, dict]:
    """Apply the spec §2.1 taxonomy; return (REG games in `seasons`, report).

    Identity checks run on every record in the payload (all game types) so a
    repeated `game_id` cannot hide behind a scope filter. Order:
    missing key field (fatal) -> exact-duplicate collapse on the raw allowed
    values (counted) -> any remaining repeated game_id (fatal) -> team-code
    normalisation, unknown code (fatal), identical home/away (fatal) ->
    two game_ids claiming one (season, week, team) (fatal) -> scope to REG
    games in `seasons` -> per-game quote status.
    """
    if list(allowed.columns) != ALLOWED_COLUMNS:
        raise LinesDataError("validate_games expects exactly ALLOWED_COLUMNS (call select_allowed)")
    null_keys = allowed[KEY_COLUMNS].isna()
    if null_keys.to_numpy().any():
        bad = sorted(c for c in KEY_COLUMNS if null_keys[c].any())
        raise LinesDataError(f"missing key field(s) {bad} in {int(null_keys.any(axis=1).sum())} record(s)")
    records = len(allowed)
    dup_mask = allowed.duplicated(keep="first")
    games = allowed[~dup_mask].reset_index(drop=True)
    repeated = games["game_id"][games["game_id"].duplicated(keep=False)]
    if len(repeated):
        raise LinesDataError(
            f"repeated game_id(s) with differing records: {sorted(set(repeated))[:5]}")
    games = normalize_schedule_teams(games)
    unknown = sorted((set(games["home_team"]) | set(games["away_team"])) - CANONICAL_TEAMS)
    if unknown:
        raise LinesDataError(f"unknown team code(s) {unknown}")
    same = games["home_team"] == games["away_team"]
    if same.any():
        raise LinesDataError(f"identical home and away team in game(s) {list(games.loc[same, 'game_id'])[:5]}")
    sides = pd.concat([
        games[["season", "week", "game_id"]].assign(team=games["home_team"]),
        games[["season", "week", "game_id"]].assign(team=games["away_team"]),
    ], ignore_index=True)
    per_team_week = sides.groupby(["season", "week", "team"])["game_id"].nunique()
    collisions = per_team_week[per_team_week > 1]
    if len(collisions):
        raise LinesDataError(
            f"team-week collision: {len(collisions)} (season, week, team) key(s) claimed by "
            f"more than one game_id, e.g. {list(collisions.index[:3])}")

    scoped = games[(games["game_type"] == "REG") & games["season"].isin(list(seasons))]
    scoped = scoped.sort_values(["season", "week", "game_id"], kind="mergesort").reset_index(drop=True)
    total = scoped["total_line"].astype(float).to_numpy()
    spread = scoped["spread_line"].astype(float).to_numpy()
    finite = np.isfinite(total) & np.isfinite(spread)
    # Arithmetic on finite rows only: inf - inf would warn (an error under -W error).
    nonpositive = np.zeros(len(scoped), dtype=bool)
    negative_implied = np.zeros(len(scoped), dtype=bool)
    t, m = total[finite], spread[finite]
    nonpositive[finite] = t <= 0
    negative_implied[finite] = ((t + m) / 2 < 0) | ((t - m) / 2 < 0)
    status = np.select(
        [~finite, nonpositive, negative_implied],
        ["missing_quote", "nonpositive_total", "negative_implied_total"],
        default="valid",
    )
    scoped = scoped.assign(quote_status=status)
    counts = scoped["quote_status"].value_counts()
    report = {
        "payload_records": int(records),
        "exact_duplicates_collapsed": int(dup_mask.sum()),
        "reg_games": int(len(scoped)),
        "reg_games_by_season": {int(k): int(v) for k, v in scoped.groupby("season").size().items()},
        "quote_status_counts": {s: int(counts.get(s, 0)) for s in QUOTE_STATUSES},
        "expected_reg_games": EXPECTED_REG_GAMES,
        "coverage_matches_claim": bool(
            len(scoped) == EXPECTED_REG_GAMES and int(counts.get("valid", 0)) == EXPECTED_REG_GAMES),
    }
    return scoped, report


def team_game_lines(games: pd.DataFrame) -> pd.DataFrame:
    """Two rows per validated game: the home side and the away side.

    implied = (T + m)/2 home, (T - m)/2 away; margin = m home, -m away, with
    T = total_line and m = spread_line (positive = home favoured). Both
    features are NaN for both sides of a non-valid quote.
    """
    valid = (games["quote_status"] == "valid").to_numpy()
    total = games["total_line"].astype(float).to_numpy()
    spread = games["spread_line"].astype(float).to_numpy()
    # Mask first, then compute on valid rows only. np.where would evaluate
    # both branches, and inf - inf on a missing quote emits a RuntimeWarning.
    home_implied, away_implied = np.full(len(games), np.nan), np.full(len(games), np.nan)
    home_margin, away_margin = np.full(len(games), np.nan), np.full(len(games), np.nan)
    t, m = total[valid], spread[valid]
    home_implied[valid], away_implied[valid] = (t + m) / 2, (t - m) / 2
    home_margin[valid], away_margin[valid] = m, -m
    base = games[["season", "week", "game_id", "quote_status"]].reset_index(drop=True)
    home = base.assign(
        team=games["home_team"].to_numpy(), side="home",
        team_implied_total=home_implied, team_expected_margin=home_margin,
    )
    away = base.assign(
        team=games["away_team"].to_numpy(), side="away",
        team_implied_total=away_implied, team_expected_margin=away_margin,
    )
    h_imp, a_imp = home["team_implied_total"].to_numpy(), away["team_implied_total"].to_numpy()
    h_mar, a_mar = home["team_expected_margin"].to_numpy(), away["team_expected_margin"].to_numpy()
    ok_valid = (
        np.isfinite(h_imp[valid]).all() and np.isfinite(a_imp[valid]).all()
        and np.allclose(h_imp[valid] + a_imp[valid], total[valid], rtol=0, atol=IDENTITY_TOL)
        and np.allclose(h_imp[valid] - a_imp[valid], spread[valid], rtol=0, atol=IDENTITY_TOL)
        and np.allclose(h_mar[valid], -a_mar[valid], rtol=0, atol=IDENTITY_TOL)
    )
    ok_missing = all(np.isnan(x[~valid]).all() for x in (h_imp, a_imp, h_mar, a_mar))
    if not (ok_valid and ok_missing):
        raise LinesDataError("team-game identities failed (implied totals / margins)")
    table = pd.concat([home, away], ignore_index=True)
    table = table[["season", "week", "game_id", "team", "side", "quote_status", *LINE_FEATURE_COLUMNS]]
    if table.duplicated(["season", "week", "team"]).any():
        raise LinesDataError("team-game table has a repeated (season, week, team)")
    return table.sort_values(["season", "week", "game_id", "side"], kind="mergesort").reset_index(drop=True)


def build_line_table(raw: pd.DataFrame, seasons: list[int]) -> tuple[pd.DataFrame, dict]:
    """raw schedule payload -> (validated team-game table, validation report)."""
    games, report = validate_games(select_allowed(raw), seasons)
    return team_game_lines(games), report


def join_line_features(features: pd.DataFrame,
                       team_lines: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Append LINE_FEATURE_COLUMNS to `features` on (season, week, team).

    Many-to-one; player-row count, order, index and keys are unchanged. A
    player team-week with no game in the table raises LinesDataError (spec
    §2.1: unmatched joins are never continued past). Rows of missing-quote
    games are kept with NaN features and counted per season by reason.
    """
    present = [c for c in LINE_FEATURE_COLUMNS if c in features.columns]
    if present:
        raise ValueError(f"line column(s) {present} already in the feature frame")
    keys = ["season", "week", "team"]
    right = team_lines[keys + ["quote_status", *LINE_FEATURE_COLUMNS]]
    try:
        merged = features[keys].merge(right, on=keys, how="left",
                                      validate="many_to_one", indicator=True)
    except pd.errors.MergeError as exc:
        raise LinesDataError(f"team-game table is not unique on {keys}: {exc}") from exc
    if len(merged) != len(features):
        raise LinesDataError("join changed the player-row count")
    # Unmatched first: a null key never matches, and must be reported as an
    # unmatched team-week rather than as a reordered key.
    unmatched = (merged["_merge"] == "left_only").to_numpy()
    if unmatched.any():
        sample = features.loc[unmatched, keys].drop_duplicates().head(5).to_dict("records")
        raise LinesDataError(
            f"unmatched player team-week: {int(unmatched.sum())} row(s) have no game, e.g. {sample}")
    for k in keys:
        if not np.array_equal(merged[k].to_numpy(), features[k].to_numpy()):
            raise LinesDataError(f"join changed player-row order or key {k!r}")
    out = features.copy()
    for c in LINE_FEATURE_COLUMNS:
        out[c] = merged[c].to_numpy()
    status = merged["quote_status"].to_numpy()
    report = {}
    for season in sorted(int(s) for s in pd.unique(features["season"])):
        in_season = (features["season"] == season).to_numpy()
        report[season] = {
            "rows": int(in_season.sum()),
            "matched_valid_quote": int((in_season & (status == "valid")).sum()),
            "missing_quote_by_reason": {
                s: int((in_season & (status == s)).sum()) for s in QUOTE_STATUSES[1:]},
        }
    return out, report
```

- [ ] **Step 4: Run to verify pass**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_data.py`
Expected: `52 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/data/lines.py tests/test_lines_data.py
git commit -m "feat(data): lines loader — snapshot, allow-list, §2.1 identity taxonomy, many-to-one join

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Screen statistics, bootstrap, ranking status and decision

**Model:** implementer `sonnet`; reviewer `opus` (numerics: estimand, weighting, RNG draw order, interval endpoints,
threshold boundaries, disposition precedence).

**Files:**
- Create: `src/ffmodel/eval/lines_stats.py`
- Create: `tests/test_lines_stats.py`

**Interfaces:**
- Consumes: `POSITIONS` (`src/ffmodel/data/pull.py`); `scipy.stats.rankdata`.
- Produces (all in `ffmodel.eval.lines_stats`):
  - Constants: `ARMS = ("A", "B")`, `SEEDS = (0, 1, 2)`, `TEST_SEASONS = (2023, 2024, 2025)`, `RNG_SEED = 20261007`,
    `N_ACCEPT = 10_000`, `MAX_ATTEMPTS = 100_000`, `PERCENTILES = (2.5, 97.5)`, `PERCENTILE_METHOD = "linear"`,
    `RELEVANT_MIN_PPR = 8.0`, `MATERIALITY = 0.05`, `SEASON_FLOOR = -0.05`, `MAX_DETERIORATION = 0.10`,
    `RANKING_VETO_BELOW = -0.005`, `MIN_CELL_PLAYERS = 5`, and `CONDITIONS` (the six names in §6 order).
  - `class ScreenInvalid(RuntimeError)`.
  - `pred_col(arm, seed) -> str` returns `"pred_<arm>_<seed>"`. The paired frame columns are `player_id, season,
    week, position, actual` plus one `pred_col` per arm and seed.
  - `loss_differences(paired, seeds) -> DataFrame` has columns `d_<seed>…` and `d`.
  - `season_equal_mean(values, seasons, season_order) -> (float, dict[int, float])`.
  - `point_effects(paired, seeds, season_order) -> {"G", "G_S", "G_seed"}`.
  - `relevant_membership(paired, seeds) -> np.ndarray[bool]`.
  - `relevant_counts(paired, relevant, season_order) -> dict`. It raises `ScreenInvalid("no relevant-cohort rows
    in season(s) [...]")`.
  - The bootstrap helpers:
    - `BootstrapDesign`;
    - `make_design(paired, season_order)`;
    - `draw_counts(rng, design) -> (player_counts, [block_counts per season])`;
    - `row_weights(design, player_counts, block_counts) -> np.ndarray`.
  - `crossed_bootstrap(paired, seeds, relevant, season_order, *, n_accept=N_ACCEPT, max_attempts=MAX_ATTEMPTS,
    rng_seed=RNG_SEED)` returns `{"accepted", "attempts", "rejected", "G", "G_S", "G_seed", "G_rel"}` as arrays of
    accepted replicates.
  - `percentile_interval(samples) -> [lo, hi]`.
  - `ranking_status(paired, seeds, season_order)` returns `{"status", "R", "reasons", "R_by_season", "by_position":
    {pos: {"delta", "reason"}}, "eligible_cells", "excluded_cells", "constant_prediction_cells"}`.
  - `guardrail(G_rel, G_rel_interval)` returns `{"G_rel", "G_rel_interval", "H", "H_upper", "passed"}`.
  - `validity_reasons(point, guard, season_order, seeds) -> list[str]` names every required metric that is missing,
    `None`, NaN or ±inf, as `"undefined point metric <name>"`.
  - `decide(point, guard, invalid_reasons, season_order=TEST_SEASONS, seeds=SEEDS)` returns `{"disposition":
    "pass"|"fail"|"invalid", "failure_label": None|"below_materiality"|"inconclusive", "conditions",
    "failed_conditions", "invalid_reasons"}`. The `point` argument needs `G`, `G_interval`, and the complete
    families `G_S` and `G_S_interval` (one entry per registered test season) and `G_seed` and `G_seed_interval` (one
    entry per registered seed). Every required value and both endpoints of every required interval are validated
    before the six conditions; any failure is `invalid`, naming the metric (spec §7).
  - `consequences(decision, ranking) -> {"buys_forward_shadow_test", "ranking_status",
    "ranking_recommendation_forbidden", "carry_into_forward_preregistration", "site_change_authorized"}`.
  - `evaluate(paired, seeds=SEEDS, season_order=TEST_SEASONS, *, n_accept, max_attempts, rng_seed)` returns
    `{"point", "bootstrap", "relevant", "ranking", "decision", "consequences"}` and never raises `ScreenInvalid`.

Decisions this task fixes where the spec leaves a degree of freedom. Each is fixed here, before any result, and is
listed in the plan's ambiguity notes.

- **Failure label.** Any failed valid run is labelled `below_materiality` when the upper bound is `< 0.05`, and
  `inconclusive` otherwise. All failed conditions are always named.
- **Ranking with a constant-prediction cell.** That cell makes pooled `R` null (`ranking_not_evaluable`). The cell's
  season `R_by_season` is null, and the position diagnostic for that position is null with a reason. Other positions
  are still reported.
- **Ranking under an invalid run.** `ranking_status` is computed before the point statistics and is still reported
  when the point side is invalid. It is not computed when a prediction is non-finite, because that run is invalid
  globally.
- **`consequences`.** `ranking_recommendation_forbidden` is true for `ranking_veto`, for `ranking_not_evaluable`, and
  when ranking was not computed. `carry_into_forward_preregistration` is populated only on a point pass, and then
  carries the status whichever of the three it is.

Behaviour note for the reviewer (not a spec degree of freedom; spec §7 requires it):

- **Required-metric validity runs before the six conditions.** `decide` checks `G`, `G_interval`, and `G_S` plus
  `G_S_interval` for every registered test season. It also checks `G_seed` plus `G_seed_interval` for every
  registered seed, and `G_rel` plus `G_rel_interval`. Each interval must have both endpoints. A missing family, a
  missing entry, a malformed interval, `None`, NaN or ±inf makes the disposition `invalid`, and `invalid_reasons`
  names each offending metric (e.g. `undefined point metric G_S_interval[2023].lower`). The expected families come
  from the caller's registered `season_order` and `seeds`, never from the keys the dict happens to have. The
  conditions then read exactly those entries. This adds no decision condition and no per-season cohort interval.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_lines_stats.py`:

```python
"""Statistics, bootstrap, ranking status and decision for the lines screen
(spec 2026-10-11 §4-7, §11). Synthetic paired frames only."""
import numpy as np
import pandas as pd
import pytest

import ffmodel.eval.lines_stats as ls
from ffmodel.eval.lines_stats import (
    ScreenInvalid,
    consequences,
    crossed_bootstrap,
    decide,
    draw_counts,
    evaluate,
    guardrail,
    loss_differences,
    make_design,
    percentile_interval,
    point_effects,
    pred_col,
    ranking_status,
    relevant_membership,
    row_weights,
    season_equal_mean,
)

SEEDS = (0, 1, 2)
SEASONS = (2023, 2024, 2025)


def make_paired(rows_per_season=None, weeks=4, players_per_week=12, seed=0,
                gain=0.3, base=10.0) -> pd.DataFrame:
    """A paired frame where B is closer to actual than A by about `gain` on
    average. Every (season, week) has `players_per_week` WRs."""
    rng = np.random.default_rng(seed)
    rows = []
    for season in SEASONS:
        for week in range(1, weeks + 1):
            for p in range(players_per_week):
                rows.append({"player_id": f"p{p:03d}", "season": season, "week": week,
                             "position": "WR"})
    frame = pd.DataFrame(rows)
    n = len(frame)
    frame["actual"] = base + rng.normal(0, 5, n)
    for s in SEEDS:
        noise = rng.normal(0, 3, n)
        frame[pred_col("A", s)] = frame["actual"] + noise + 2.0
        frame[pred_col("B", s)] = frame["actual"] + noise + 2.0 - gain
    return frame


# --- §5.1 point effects --------------------------------------------------------

def test_seasons_weighted_equally_despite_unequal_sizes():
    # 2023 has 3 rows with d=1, 2024 one row with d=0, 2025 one row with d=0.
    seasons = np.array([2023, 2023, 2023, 2024, 2025])
    values = np.array([1.0, 1.0, 1.0, 0.0, 0.0])
    G, G_S = season_equal_mean(values, seasons, SEASONS)
    assert G_S == {2023: 1.0, 2024: 0.0, 2025: 0.0}
    assert G == pytest.approx(1 / 3)                 # pooled row mean would be 0.6


def test_seed_averaging_is_on_losses_not_on_predictions():
    paired = pd.DataFrame({"player_id": ["a"], "season": [2023], "week": [1],
                           "position": ["WR"], "actual": [10.0]})
    # A is exact on average but wrong per seed; B is off by 1 on every seed.
    for s, a in zip(SEEDS, (6.0, 14.0, 10.0)):
        paired[pred_col("A", s)] = a
        paired[pred_col("B", s)] = 11.0
    d = loss_differences(paired, SEEDS)
    assert list(d.loc[0, ["d_0", "d_1", "d_2"]]) == [3.0, 3.0, -1.0]
    assert d.loc[0, "d"] == pytest.approx(5 / 3)
    loss_of_avg = abs(10.0 - 10.0) - abs(10.0 - 11.0)  # = -1: the forbidden estimand
    assert d.loc[0, "d"] != pytest.approx(loss_of_avg)


def test_point_effects_per_seed_uses_same_season_weighting():
    paired = make_paired()
    effects = point_effects(paired, SEEDS, SEASONS)
    d = loss_differences(paired, SEEDS)
    for s in SEEDS:
        expected = np.mean([d.loc[paired["season"] == y, f"d_{s}"].mean() for y in SEASONS])
        assert effects["G_seed"][s] == pytest.approx(expected)
    assert effects["G"] == pytest.approx(np.mean(list(effects["G_S"].values())))


# --- §5.3 relevant cohort ---------------------------------------------------------

def test_relevant_membership_uses_arm_a_only_and_threshold_is_inclusive():
    paired = make_paired()
    for s in SEEDS:
        paired.loc[0, pred_col("A", s)] = 8.0
        paired.loc[1, pred_col("A", s)] = 7.999
    before = relevant_membership(paired, SEEDS)
    assert before[0] and not before[1]
    changed = paired.copy()
    for s in SEEDS:
        changed[pred_col("B", s)] = changed[pred_col("B", s)] + 100.0
    np.testing.assert_array_equal(relevant_membership(changed, SEEDS), before)


def test_empty_relevant_season_is_invalid_before_any_bootstrap(monkeypatch):
    paired = make_paired()
    in_2024 = paired["season"] == 2024
    for s in SEEDS:
        # nothing relevant in 2024 (scaled far below 8 PPR, order kept)
        paired.loc[in_2024, pred_col("A", s)] = paired.loc[in_2024, pred_col("A", s)] / 100

    def boom(*args, **kwargs):
        raise AssertionError("bootstrap must not run")

    monkeypatch.setattr(ls, "crossed_bootstrap", boom)
    result = evaluate(paired, SEEDS, SEASONS, n_accept=50, max_attempts=500)
    assert result["decision"]["disposition"] == "invalid"
    assert "no relevant-cohort rows in season(s) [2024]" in result["decision"]["invalid_reasons"][0]
    assert result["ranking"]["status"] in {"ranking_ok", "ranking_veto"}   # still reported
    assert result["consequences"]["buys_forward_shadow_test"] is False


# --- §5.2 crossed bootstrap ---------------------------------------------------------

def test_bootstrap_is_deterministic_and_uses_the_registered_generator():
    paired = make_paired()
    rel = relevant_membership(paired, SEEDS)
    one = crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=200, max_attempts=2000)
    two = crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=200, max_attempts=2000)
    np.testing.assert_array_equal(one["G"], two["G"])
    np.testing.assert_array_equal(one["G_rel"], two["G_rel"])
    # First replicate re-derived by hand: PCG64(20261007), players first,
    # then each season's blocks in ascending season order.
    design = make_design(paired, SEASONS)
    rng = np.random.Generator(np.random.PCG64(20261007))
    pc = np.bincount(rng.integers(0, design.n_players, size=design.n_players),
                     minlength=design.n_players)
    bcs = [np.bincount(rng.integers(0, k, size=k), minlength=k) for k in design.n_blocks]
    w = row_weights(design, pc, bcs).astype(float)
    d = loss_differences(paired, SEEDS)["d"].to_numpy()
    seasons = paired["season"].to_numpy()
    manual = np.mean([(w[seasons == s] * d[seasons == s]).sum() / w[seasons == s].sum()
                      for s in SEASONS])
    assert one["rejected"] == 0
    assert one["G"][0] == pytest.approx(manual, abs=1e-12)
    other = crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=200, max_attempts=2000,
                              rng_seed=1)
    assert not np.array_equal(one["G"], other["G"])


def test_week_pairs_move_together():
    # One player -> player count is always 1, so weights are block counts.
    rows = [{"player_id": "solo", "season": s, "week": w, "position": "WR"}
            for s in SEASONS for w in range(1, 7)]
    design = make_design(pd.DataFrame(rows), SEASONS)
    assert design.n_blocks == (3, 3, 3)
    rng = np.random.Generator(np.random.PCG64(20261007))
    weeks = pd.DataFrame(rows)["week"].to_numpy()
    seasons = pd.DataFrame(rows)["season"].to_numpy()
    differed = False
    for _ in range(50):
        w = row_weights(design, *draw_counts(rng, design))
        for s in SEASONS:
            ws = {wk: w[(seasons == s) & (weeks == wk)][0] for wk in range(1, 7)}
            assert ws[1] == ws[2] and ws[3] == ws[4] and ws[5] == ws[6]
            differed |= ws[1] != ws[3]
    assert differed


def test_player_multiplicity_carries_across_seasons():
    # One block per season (weeks 1-2) -> block count is always 1.
    rows = [{"player_id": p, "season": s, "week": 1, "position": "WR"}
            for s in SEASONS for p in ("a", "b", "c", "d")]
    frame = pd.DataFrame(rows)
    design = make_design(frame, SEASONS)
    rng = np.random.Generator(np.random.PCG64(20261007))
    varied = set()
    for _ in range(50):
        w = row_weights(design, *draw_counts(rng, design))
        for p in ("a", "b", "c", "d"):
            per_season = w[(frame["player_id"] == p).to_numpy()]
            assert len(set(per_season)) == 1           # same multiplicity every season
            varied.add(int(per_season[0]))
    assert len(varied) > 1


def test_empty_season_replicates_are_rejected_and_counted():
    # 2025 holds a single player out of 40 -> it is often drawn zero times.
    paired = make_paired(players_per_week=40)
    keep = (paired["season"] != 2025) | (paired["player_id"] == "p000")
    paired = paired[keep].reset_index(drop=True)
    for s in SEEDS:
        paired[pred_col("A", s)] = 20.0                 # everyone relevant
    rel = relevant_membership(paired, SEEDS)
    boot = crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=100, max_attempts=10_000)
    assert boot["accepted"] == 100
    assert boot["rejected"] > 0
    assert boot["attempts"] == boot["accepted"] + boot["rejected"]
    assert np.isfinite(boot["G"]).all()


def test_relevant_cohort_zero_weight_rejects_jointly():
    paired = make_paired(players_per_week=40)
    for s in SEEDS:
        paired[pred_col("A", s)] = 20.0
        # In 2025 only p000 is relevant.
        paired.loc[(paired["season"] == 2025) & (paired["player_id"] != "p000"),
                   pred_col("A", s)] = 1.0
    rel = relevant_membership(paired, SEEDS)
    boot = crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=100, max_attempts=10_000)
    assert boot["rejected"] > 0 and np.isfinite(boot["G_rel"]).all()


def test_attempt_limit_raises_screen_invalid():
    paired = make_paired(players_per_week=200, weeks=2)
    keep = (paired["season"] != 2025) | (paired["player_id"] == "p000")
    paired = paired[keep].reset_index(drop=True)
    rel = np.ones(len(paired), dtype=bool)
    with pytest.raises(ScreenInvalid, match="accepted within 100 attempts"):
        crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=100, max_attempts=100)


def test_percentile_interval_is_central_95_linear():
    samples = np.arange(1, 101, dtype=float)
    lo, hi = percentile_interval(samples)
    assert (lo, hi) == (np.percentile(samples, 2.5, method="linear"),
                        np.percentile(samples, 97.5, method="linear"))


# --- §5.4 ranking -------------------------------------------------------------------

def ranking_frame(n_players=6, weeks=2, b_order="same", seasons=SEASONS,
                  position="WR") -> pd.DataFrame:
    rows = []
    for season in seasons:
        for week in range(1, weeks + 1):
            for p in range(n_players):
                actual = float(p * 3 + week)
                a = float(p)                                      # A ranks perfectly
                b = float(p) if b_order == "same" else float(n_players - p)
                row = {"player_id": f"p{p}", "season": season, "week": week,
                       "position": position, "actual": actual}
                for s in SEEDS:
                    row[pred_col("A", s)] = a
                    row[pred_col("B", s)] = b
                rows.append(row)
    return pd.DataFrame(rows)


def test_ranking_identical_orders_give_zero_delta_and_ok():
    out = ranking_status(ranking_frame(), SEEDS, SEASONS)
    assert out["status"] == "ranking_ok" and out["R"] == pytest.approx(0.0)
    assert out["eligible_cells"] == 6


def test_ranking_reversed_b_is_a_veto_paired_per_cell():
    out = ranking_status(ranking_frame(b_order="reversed"), SEEDS, SEASONS)
    assert out["status"] == "ranking_veto"
    assert out["R"] == pytest.approx(-2.0)               # rho_B=-1 minus rho_A=+1


@pytest.mark.parametrize("rho_b,status", [(-0.005, "ranking_ok"), (-0.0050001, "ranking_veto")])
def test_ranking_veto_threshold_boundary(monkeypatch, rho_b, status):
    # Stub the correlation so R is exactly rho_b: arm A's predictions are all
    # non-negative (rho 0), arm B's all negative (rho = rho_b).
    frame = ranking_frame()
    for s in SEEDS:
        frame[pred_col("B", s)] = -frame[pred_col("B", s)] - 1.0
    monkeypatch.setattr(ls, "_spearman", lambda x, y: rho_b if x.max() < 0 else 0.0)
    out = ranking_status(frame, SEEDS, SEASONS)
    assert out["R"] == rho_b and out["status"] == status


def test_ranking_cells_need_five_distinct_players():
    out = ranking_status(ranking_frame(n_players=4), SEEDS, SEASONS)
    assert out["excluded_cells"]["too_few_players"] == 6
    assert out["status"] == "ranking_not_evaluable" and out["R"] is None


def test_constant_actual_cell_is_excluded_symmetrically_and_counted():
    frame = ranking_frame()
    frame.loc[(frame["season"] == 2023) & (frame["week"] == 1), "actual"] = 5.0
    out = ranking_status(frame, SEEDS, SEASONS)
    assert out["excluded_cells"]["constant_actual"] == 1
    assert out["eligible_cells"] == 5 and out["status"] == "ranking_ok"


def test_finite_constant_prediction_is_not_evaluable_and_point_gate_unchanged():
    wr = make_paired(seed=0)
    rb = make_paired(seed=1).assign(position="RB")
    rb["player_id"] = "rb_" + rb["player_id"]
    paired = pd.concat([wr, rb], ignore_index=True)
    cell = (paired["season"] == 2023) & (paired["week"] == 1) & (paired["position"] == "WR")
    paired.loc[cell, pred_col("B", 1)] = 12.0            # finite but constant, one WR cell
    out = evaluate(paired, SEEDS, SEASONS, n_accept=200, max_attempts=2000)
    ranking = out["ranking"]
    assert ranking["status"] == "ranking_not_evaluable"
    assert ranking["R"] is None
    assert ranking["constant_prediction_cells"] == [
        {"season": 2023, "week": 1, "position": "WR", "arms": ["B/seed1"]}]
    # Only the affected season and position are nulled ...
    assert ranking["R_by_season"][2023] is None
    assert ranking["by_position"]["WR"] == {
        "delta": None, "reason": "constant prediction in an eligible WR cell in season 2023"}
    # ... the other seasons' R and the unaffected position's diagnostic are kept.
    for season in (2024, 2025):
        assert ranking["R_by_season"][season] is not None
        assert np.isfinite(ranking["R_by_season"][season])
    assert ranking["by_position"]["RB"]["reason"] is None
    assert ranking["by_position"]["RB"]["delta"] is not None
    assert np.isfinite(ranking["by_position"]["RB"]["delta"])
    assert ranking["eligible_cells"] == 24                  # 3 seasons x 4 weeks x 2 positions
    assert out["decision"]["disposition"] in {"pass", "fail"}       # never invalid for ranking
    assert out["consequences"]["ranking_recommendation_forbidden"] is True


def test_season_without_eligible_ranking_cell_is_not_evaluable():
    frame = ranking_frame()
    small = ranking_frame(n_players=3, seasons=(2025,))
    frame = pd.concat([frame[frame["season"] != 2025], small], ignore_index=True)
    out = ranking_status(frame, SEEDS, SEASONS)
    assert out["status"] == "ranking_not_evaluable"
    assert "season 2025 has no eligible ranking cell" in out["reasons"]
    assert out["R_by_season"][2025] is None and out["R"] is None


def test_missing_position_season_nulls_only_that_diagnostic():
    wr = ranking_frame()
    te = ranking_frame(position="TE", seasons=(2023, 2024))       # no TE cells in 2025
    out = ranking_status(pd.concat([wr, te], ignore_index=True), SEEDS, SEASONS)
    assert out["status"] == "ranking_ok"
    assert out["by_position"]["TE"] == {"delta": None, "reason": "no eligible TE cell in season 2025"}
    assert out["by_position"]["WR"]["delta"] == pytest.approx(0.0)
    assert out["by_position"]["QB"]["delta"] is None


# --- §6 / §7 decision -------------------------------------------------------------

def passing_point(**over) -> dict:
    """An otherwise passing point dict carrying the COMPLETE required families:
    one G_S / G_S_interval entry per registered season and one G_seed /
    G_seed_interval entry per registered seed."""
    point = {"G": 0.1, "G_interval": [0.02, 0.18],
             "G_S": {2023: 0.1, 2024: 0.1, 2025: 0.1},
             "G_S_interval": {2023: [0.01, 0.2], 2024: [0.01, 0.2], 2025: [0.01, 0.2]},
             "G_seed": {0: 0.1, 1: 0.1, 2: 0.1},
             "G_seed_interval": {0: [0.01, 0.2], 1: [0.01, 0.2], 2: [0.01, 0.2]}}
    point.update(over)
    return point


MISSING = object()
NAN, INF = float("nan"), float("inf")


def with_entry(family: str, key: int, value) -> dict:
    """passing_point() with one entry of `family` replaced (value=MISSING drops it)."""
    entries = dict(passing_point()[family])
    if value is MISSING:
        del entries[key]
    else:
        entries[key] = value
    return passing_point(**{family: entries})


def passing_guard(lower=0.0) -> dict:
    return guardrail(0.1, [lower, 0.2])


def test_all_conditions_hold_is_a_pass():
    out = decide(passing_point(), passing_guard(), [])
    assert out["disposition"] == "pass" and out["failed_conditions"] == []


@pytest.mark.parametrize("point,guard_lower,failed", [
    (passing_point(G=0.0499999), 0.0, ["materiality"]),
    (passing_point(G_interval=[0.0, 0.18]), 0.0, ["interval_lower_above_0"]),
    (passing_point(G_S={2023: 0.1, 2024: -0.01, 2025: 0.0}), 0.0, ["two_seasons_positive"]),
    (passing_point(G_S={2023: 0.2, 2024: 0.2, 2025: -0.0500001}), 0.0, ["no_season_below_floor"]),
    (passing_point(G_seed={0: 0.1, 1: 0.0, 2: 0.1}), 0.0, ["all_seeds_positive"]),
    (passing_point(), -0.1000001, ["relevant_guardrail"]),
])
def test_each_condition_failing_in_turn(point, guard_lower, failed):
    out = decide(point, passing_guard(guard_lower), [])
    assert out["disposition"] == "fail"
    assert out["failed_conditions"] == failed
    assert out["failure_label"] == "inconclusive"


def test_exact_boundaries():
    assert decide(passing_point(G=0.05), passing_guard(), [])["disposition"] == "pass"
    assert decide(passing_point(G_interval=[0.0, 0.2]), passing_guard(), [])["disposition"] == "fail"
    at_floor = passing_point(G_S={2023: 0.2, 2024: 0.2, 2025: -0.05})
    assert decide(at_floor, passing_guard(), [])["disposition"] == "pass"
    guard = passing_guard(-0.10)
    assert guard["H_upper"] == 0.10
    assert decide(passing_point(), guard, [])["disposition"] == "pass"


def test_below_materiality_label():
    out = decide(passing_point(G=0.01, G_interval=[-0.02, 0.0499]), passing_guard(), [])
    assert out["disposition"] == "fail" and out["failure_label"] == "below_materiality"
    assert "materiality" in out["failed_conditions"]


def test_invalid_takes_precedence_over_any_label():
    out = decide(passing_point(), passing_guard(), ["unmatched player team-week"])
    assert out == {"disposition": "invalid", "failure_label": None, "conditions": None,
                   "failed_conditions": None, "invalid_reasons": ["unmatched player team-week"]}


@pytest.mark.parametrize("over", [{"G": float("nan")}, {"G_interval": [0.01, float("inf")]},
                                  {"G_S": {2023: 0.1, 2024: None, 2025: 0.1}},
                                  {"G_seed": {0: 0.1, 1: float("nan"), 2: 0.1}}])
def test_undefined_point_metric_is_invalid(over):
    out = decide(passing_point(**over), passing_guard(), [])
    assert out["disposition"] == "invalid"
    assert out["invalid_reasons"][0].startswith("undefined point metric")


def test_complete_families_are_required_by_the_passing_fixture():
    # The fixture itself passes; every case below changes exactly one entry.
    assert decide(passing_point(), passing_guard(), [])["disposition"] == "pass"


@pytest.mark.parametrize("family,key,value,named", [
    # season-interval family: an endpoint that is None / NaN / +inf / -inf
    ("G_S_interval", 2023, [NAN, 0.2], "G_S_interval[2023].lower"),   # astra's reproduction
    ("G_S_interval", 2024, [0.01, None], "G_S_interval[2024].upper"),
    ("G_S_interval", 2025, [0.01, INF], "G_S_interval[2025].upper"),
    ("G_S_interval", 2023, [-INF, 0.2], "G_S_interval[2023].lower"),
    # ... a null or missing entry
    ("G_S_interval", 2024, None, "G_S_interval[2024] (missing or malformed interval)"),
    ("G_S_interval", 2025, MISSING, "G_S_interval[2025] (missing or malformed interval)"),
    # seed-interval family: the same cases
    ("G_seed_interval", 0, [NAN, 0.2], "G_seed_interval[0].lower"),
    ("G_seed_interval", 1, [0.01, None], "G_seed_interval[1].upper"),
    ("G_seed_interval", 2, [0.01, INF], "G_seed_interval[2].upper"),
    ("G_seed_interval", 0, [-INF, 0.2], "G_seed_interval[0].lower"),
    ("G_seed_interval", 1, None, "G_seed_interval[1] (missing or malformed interval)"),
    ("G_seed_interval", 2, MISSING, "G_seed_interval[2] (missing or malformed interval)"),
    # point families: a missing entry is undefined, not silently skipped
    ("G_S", 2024, MISSING, "G_S[2024]"),
    ("G_seed", 1, MISSING, "G_seed[1]"),
])
def test_undefined_season_or_seed_interval_is_invalid_and_named(family, key, value, named):
    out = decide(with_entry(family, key, value), passing_guard(), [])
    assert out["disposition"] == "invalid"
    assert out["conditions"] is None and out["failure_label"] is None
    assert out["invalid_reasons"] == [f"undefined point metric {named}"]


@pytest.mark.parametrize("family", ["G_S_interval", "G_seed_interval"])
def test_absent_interval_family_names_every_registered_entry(family):
    point = passing_point()
    del point[family]
    out = decide(point, passing_guard(), [])
    keys = SEASONS if family == "G_S_interval" else SEEDS
    assert out["disposition"] == "invalid"
    assert out["invalid_reasons"] == [
        f"undefined point metric {family}[{k}] (missing or malformed interval)" for k in keys]


def test_registered_families_come_from_the_caller():
    # Two registered seasons/seeds: complete for those, so it passes;
    # registering a third season the dict lacks makes it invalid.
    point = passing_point(G_S={2024: 0.1, 2025: 0.1},
                          G_S_interval={2024: [0.01, 0.2], 2025: [0.01, 0.2]})
    assert decide(point, passing_guard(), [], season_order=(2024, 2025))["disposition"] == "pass"
    out = decide(point, passing_guard(), [], season_order=SEASONS)
    assert out["disposition"] == "invalid"
    assert "undefined point metric G_S[2023]" in out["invalid_reasons"]


def test_undefined_guardrail_metric_is_invalid():
    out = decide(passing_point(), guardrail(float("nan"), [-0.01, 0.2]), [])
    assert out["disposition"] == "invalid"


def test_non_finite_prediction_in_paired_frame_is_invalid():
    paired = make_paired()
    paired.loc[3, pred_col("A", 2)] = np.nan
    out = evaluate(paired, SEEDS, SEASONS, n_accept=50, max_attempts=500)
    assert out["decision"]["disposition"] == "invalid"
    assert out["ranking"] is None


@pytest.mark.parametrize("status,forbidden", [("ranking_ok", False), ("ranking_veto", True),
                                              ("ranking_not_evaluable", True)])
def test_ranking_status_is_independent_of_the_point_pass(status, forbidden):
    passed = decide(passing_point(), passing_guard(), [])
    out = consequences(passed, {"status": status})
    assert out["buys_forward_shadow_test"] is True               # point pass still buys it
    assert out["ranking_recommendation_forbidden"] is forbidden
    assert out["carry_into_forward_preregistration"] == {
        "ranking_status": status, "ranking_recommendation_forbidden": forbidden}
    assert out["site_change_authorized"] is False
    failed = decide(passing_point(G=0.0), passing_guard(), [])
    assert consequences(failed, {"status": status})["buys_forward_shadow_test"] is False


def test_evaluate_end_to_end_on_a_clear_gain():
    out = evaluate(make_paired(gain=0.3), SEEDS, SEASONS, n_accept=300, max_attempts=3000)
    assert out["decision"]["disposition"] == "pass"
    assert out["bootstrap"]["accepted"] == 300
    assert out["point"]["G_interval"][0] > 0
    assert set(out["point"]["G_S_interval"]) == set(SEASONS)
    assert set(out["point"]["G_seed_interval"]) == set(SEEDS)
    assert out["decision"]["invalid_reasons"] == []
    assert out["relevant"]["passed"] is True
    assert out["relevant"]["counts"]["rows_by_season"][2023] > 0


def test_evaluate_end_to_end_on_no_gain_fails():
    out = evaluate(make_paired(gain=0.0), SEEDS, SEASONS, n_accept=300, max_attempts=3000)
    assert out["decision"]["disposition"] == "fail"
    assert out["point"]["G"] == pytest.approx(0.0)
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_stats.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ffmodel.eval.lines_stats'`.

- [ ] **Step 3: Implement**

Create `src/ffmodel/eval/lines_stats.py`:

```python
"""Pre-registered statistics for the betting-lines screen.

Spec: docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md §4-7.
Pure functions over the paired row-level frame the collector produces:
one row per test player-week with `player_id`, `season`, `week`,
`position`, `actual` and one PPR point prediction per arm and seed in
columns named by `pred_col(arm, seed)`.

Every threshold below is fixed by the spec. Nothing here is tuned.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import rankdata

from ffmodel.data.pull import POSITIONS

ARMS = ("A", "B")
SEEDS = (0, 1, 2)
TEST_SEASONS = (2023, 2024, 2025)
RNG_SEED = 20261007
N_ACCEPT = 10_000
MAX_ATTEMPTS = 100_000
PERCENTILES = (2.5, 97.5)                 # central 95%
PERCENTILE_METHOD = "linear"
RELEVANT_MIN_PPR = 8.0                    # §5.3 membership: mean_s predA >= 8
MATERIALITY = 0.05                        # §6.1
SEASON_FLOOR = -0.05                      # §6.4
MAX_DETERIORATION = 0.10                  # §5.3 guardrail
RANKING_VETO_BELOW = -0.005               # §5.4
MIN_CELL_PLAYERS = 5                      # §5.4


class ScreenInvalid(RuntimeError):
    """The run cannot produce a valid result (spec §7) -> disposition `invalid`."""


def pred_col(arm: str, seed: int) -> str:
    return f"pred_{arm}_{seed}"


def _finite(x) -> bool:
    return x is not None and bool(np.isfinite(x))


# --- §4 / §5.1 point effects ------------------------------------------------

def loss_differences(paired: pd.DataFrame, seeds) -> pd.DataFrame:
    """d_{i,s} = |actual - predA_s| - |actual - predB_s| per seed (`d_<s>`),
    and the seed-averaged `d` = mean_s d_{i,s}. Positive = lines helped.
    Loss is taken per seed BEFORE averaging -- never loss of averaged predictions."""
    actual = paired["actual"].to_numpy(float)
    out = {}
    for s in seeds:
        out[f"d_{s}"] = (np.abs(actual - paired[pred_col("A", s)].to_numpy(float))
                         - np.abs(actual - paired[pred_col("B", s)].to_numpy(float)))
    frame = pd.DataFrame(out, index=paired.index)
    frame["d"] = frame[[f"d_{s}" for s in seeds]].mean(axis=1)
    return frame


def season_equal_mean(values: np.ndarray, seasons: np.ndarray,
                      season_order) -> tuple[float, dict[int, float]]:
    """Rows averaged within season, seasons weighted equally. A season with no
    rows yields NaN (so the caller's finiteness check makes the run invalid)."""
    by_season = {}
    for s in season_order:
        mask = seasons == s
        by_season[int(s)] = float(values[mask].mean()) if mask.any() else float("nan")
    return float(np.mean(list(by_season.values()))), by_season


def point_effects(paired: pd.DataFrame, seeds, season_order) -> dict:
    """G, per-season G_S and per-seed G^(s) (same formula on d_{i,s})."""
    d = loss_differences(paired, seeds)
    seasons = paired["season"].to_numpy()
    G, G_S = season_equal_mean(d["d"].to_numpy(), seasons, season_order)
    G_seed = {int(s): season_equal_mean(d[f"d_{s}"].to_numpy(), seasons, season_order)[0]
              for s in seeds}
    return {"G": G, "G_S": G_S, "G_seed": G_seed}


# --- §5.3 relevant cohort ----------------------------------------------------

def relevant_membership(paired: pd.DataFrame, seeds) -> np.ndarray:
    """Frozen once from arm A only: mean_s predA_{i,s} >= 8 PPR."""
    pred_a = paired[[pred_col("A", s) for s in seeds]].to_numpy(float).mean(axis=1)
    return pred_a >= RELEVANT_MIN_PPR


def relevant_counts(paired: pd.DataFrame, relevant: np.ndarray, season_order) -> dict:
    """Cohort counts; raises ScreenInvalid if an original season has no
    relevant row (spec §5.3: invalid immediately, before any bootstrap)."""
    rel = paired[relevant]
    empty = [int(s) for s in season_order if not (rel["season"] == s).any()]
    if empty:
        raise ScreenInvalid(f"no relevant-cohort rows in season(s) {empty}")
    blocks = (rel["week"].astype(int) - 1) // 2
    return {
        "rows": int(len(rel)),
        "rows_by_season": {int(s): int((rel["season"] == s).sum()) for s in season_order},
        "rows_by_season_position": {
            int(s): {p: int(((rel["season"] == s) & (rel["position"] == p)).sum()) for p in POSITIONS}
            for s in season_order},
        "unique_players": int(rel["player_id"].nunique()),
        "blocks_represented_by_season": {
            int(s): int(blocks[rel["season"] == s].nunique()) for s in season_order},
    }


# --- §5.2 crossed bootstrap ----------------------------------------------------

@dataclass(frozen=True)
class BootstrapDesign:
    season_order: tuple[int, ...]
    season_code: np.ndarray        # row -> index into season_order
    player_code: np.ndarray        # row -> index into sorted distinct player_ids
    n_players: int
    block_code: np.ndarray         # row -> index into its season's sorted block list
    n_blocks: tuple[int, ...]      # per season, in season_order


def make_design(paired: pd.DataFrame, season_order) -> BootstrapDesign:
    season_order = tuple(int(s) for s in season_order)
    seasons = paired["season"].to_numpy().astype(int)
    season_index = {s: i for i, s in enumerate(season_order)}
    if not set(np.unique(seasons)) <= set(season_order):
        raise ScreenInvalid("paired rows contain a season outside the test seasons")
    season_code = np.array([season_index[s] for s in seasons], dtype=np.int64)
    players = np.array(sorted(pd.unique(paired["player_id"]).tolist()), dtype=object)
    player_code = np.searchsorted(players, paired["player_id"].to_numpy(dtype=object))
    block = (paired["week"].to_numpy().astype(int) - 1) // 2
    block_code = np.empty(len(paired), dtype=np.int64)
    n_blocks = []
    for i, s in enumerate(season_order):
        mask = season_code == i
        blocks = np.unique(block[mask])            # sorted block list for the season
        n_blocks.append(len(blocks))
        block_code[mask] = np.searchsorted(blocks, block[mask])
    return BootstrapDesign(season_order, season_code, player_code.astype(np.int64),
                           len(players), block_code, tuple(n_blocks))


def draw_counts(rng: np.random.Generator,
                design: BootstrapDesign) -> tuple[np.ndarray, list[np.ndarray]]:
    """One replicate's draws, in the registered order: P player indices with
    replacement, then each season's block list (ascending seasons)."""
    players = rng.integers(0, design.n_players, size=design.n_players)
    player_counts = np.bincount(players, minlength=design.n_players)
    block_counts = []
    for k in design.n_blocks:
        draws = rng.integers(0, k, size=k)
        block_counts.append(np.bincount(draws, minlength=k))
    return player_counts, block_counts


def row_weights(design: BootstrapDesign, player_counts: np.ndarray,
                block_counts: list[np.ndarray]) -> np.ndarray:
    """w_i = player_count[player_i] * block_count[season_i, block_i]."""
    block_w = np.empty(len(design.season_code), dtype=np.int64)
    for i, counts in enumerate(block_counts):
        mask = design.season_code == i
        block_w[mask] = counts[design.block_code[mask]]
    return player_counts[design.player_code] * block_w


def crossed_bootstrap(paired: pd.DataFrame, seeds, relevant: np.ndarray, season_order, *,
                      n_accept: int = N_ACCEPT, max_attempts: int = MAX_ATTEMPTS,
                      rng_seed: int = RNG_SEED) -> dict:
    """Accepted replicates of G*, G_S*, G^(s)* and G_rel* (spec §5.2-5.3).

    A replicate is rejected (and counted) when any season's total weight is
    zero, or any season's relevant-cohort weight is zero -- jointly, so every
    statistic shares the same accepted replicates. Raises ScreenInvalid if
    `n_accept` replicates are not reached within `max_attempts`.
    """
    design = make_design(paired, season_order)
    d = loss_differences(paired, seeds)
    columns = ["d"] + [f"d_{s}" for s in seeds]
    D = d[columns].to_numpy(float)                               # n x (1 + seeds)
    n_seasons = len(design.season_order)
    onehot = np.zeros((len(paired), n_seasons))
    onehot[np.arange(len(paired)), design.season_code] = 1.0
    rel = relevant.astype(float)
    rng = np.random.Generator(np.random.PCG64(rng_seed))
    G = np.empty(n_accept)
    G_S = np.empty((n_accept, n_seasons))
    G_seed = np.empty((n_accept, len(seeds)))
    G_rel = np.empty(n_accept)
    accepted = attempts = 0
    while accepted < n_accept:
        if attempts >= max_attempts:
            raise ScreenInvalid(
                f"only {accepted} of {n_accept} bootstrap replicates accepted "
                f"within {max_attempts} attempts")
        attempts += 1
        w = row_weights(design, *draw_counts(rng, design)).astype(float)
        den = onehot.T @ w
        den_rel = onehot.T @ (w * rel)
        if (den == 0).any() or (den_rel == 0).any():
            continue
        season_means = (onehot.T @ (D * w[:, None])) / den[:, None]   # seasons x cols
        rel_means = (onehot.T @ (D[:, 0] * w * rel)) / den_rel
        G_S[accepted] = season_means[:, 0]
        G[accepted] = season_means[:, 0].mean()
        G_seed[accepted] = season_means[:, 1:].mean(axis=0)
        G_rel[accepted] = rel_means.mean()
        accepted += 1
    return {"accepted": accepted, "attempts": attempts, "rejected": attempts - accepted,
            "G": G, "G_S": G_S, "G_seed": G_seed, "G_rel": G_rel}


def percentile_interval(samples: np.ndarray) -> list[float]:
    lo, hi = np.percentile(samples, PERCENTILES, method=PERCENTILE_METHOD)
    return [float(lo), float(hi)]


# --- §5.4 ranking status ---------------------------------------------------------

def _spearman(x: np.ndarray, y: np.ndarray) -> float:
    """Average-rank Spearman. Callers guarantee neither input is constant."""
    rx = rankdata(x, method="average")
    ry = rankdata(y, method="average")
    rx = rx - rx.mean()
    ry = ry - ry.mean()
    return float((rx * ry).sum() / np.sqrt((rx * rx).sum() * (ry * ry).sum()))


def ranking_status(paired: pd.DataFrame, seeds, season_order) -> dict:
    """Pooled seed-averaged Spearman delta R (B - A) over (season, week,
    position) cells; status ranking_ok / ranking_veto / ranking_not_evaluable.
    Independent of the point gate and of validity."""
    excluded = {"too_few_players": 0, "constant_actual": 0}
    constant_prediction_cells = []
    cells = []                                  # (season, position, delta or None)
    for (season, week, position), cell in paired.groupby(["season", "week", "position"], sort=True):
        if position not in POSITIONS or int(season) not in season_order:
            continue
        if cell["player_id"].nunique() < MIN_CELL_PLAYERS:
            excluded["too_few_players"] += 1
            continue
        actual = cell["actual"].to_numpy(float)
        if np.ptp(actual) == 0:
            excluded["constant_actual"] += 1
            continue
        deltas, constant = [], []
        for s in seeds:
            rho = {}
            for arm in ARMS:
                pred = cell[pred_col(arm, s)].to_numpy(float)
                if not np.isfinite(pred).all():
                    raise ScreenInvalid("non-finite prediction reached ranking")
                if np.ptp(pred) == 0:
                    constant.append(f"{arm}/seed{s}")
                    continue
                rho[arm] = _spearman(pred, actual)
            if len(rho) == 2:
                deltas.append(rho["B"] - rho["A"])
        if constant:
            constant_prediction_cells.append(
                {"season": int(season), "week": int(week), "position": position, "arms": constant})
            cells.append((int(season), position, None))
        else:
            cells.append((int(season), position, float(np.mean(deltas))))

    reasons = []
    if constant_prediction_cells:
        reasons.append(f"finite constant prediction in {len(constant_prediction_cells)} eligible cell(s)")
    by_season = {}
    for s in season_order:
        vals = [v for (cs, _, v) in cells if cs == s]
        if not vals:
            reasons.append(f"season {s} has no eligible ranking cell")
            by_season[int(s)] = None
        elif any(v is None for v in vals):
            by_season[int(s)] = None
        else:
            by_season[int(s)] = float(np.mean(vals))
    by_position = {}
    for p in POSITIONS:
        per_season, why = [], None
        for s in season_order:
            vals = [v for (cs, cp, v) in cells if cs == s and cp == p]
            if not vals:
                why = f"no eligible {p} cell in season {s}"
                break
            if any(v is None for v in vals):
                why = f"constant prediction in an eligible {p} cell in season {s}"
                break
            per_season.append(float(np.mean(vals)))
        by_position[p] = ({"delta": None, "reason": why} if why is not None
                          else {"delta": float(np.mean(per_season)), "reason": None})
    n_eligible = len(cells)
    if reasons:
        return {"status": "ranking_not_evaluable", "R": None, "reasons": reasons,
                "R_by_season": by_season, "by_position": by_position,
                "eligible_cells": n_eligible, "excluded_cells": excluded,
                "constant_prediction_cells": constant_prediction_cells}
    R = float(np.mean(list(by_season.values())))
    status = "ranking_ok" if R >= RANKING_VETO_BELOW else "ranking_veto"
    return {"status": status, "R": R, "reasons": [], "R_by_season": by_season,
            "by_position": by_position, "eligible_cells": n_eligible,
            "excluded_cells": excluded, "constant_prediction_cells": []}


# --- §6 / §7 decision -------------------------------------------------------------

CONDITIONS = (
    "materiality",            # 1. G >= 0.05
    "interval_lower_above_0",  # 2. lower bound > 0
    "two_seasons_positive",   # 3. >= 2 of 3 seasons G_S > 0
    "no_season_below_floor",  # 4. no G_S < -0.05
    "all_seeds_positive",     # 5. every G^(s) > 0
    "relevant_guardrail",     # 6. H upper <= 0.10
)


def guardrail(G_rel: float, G_rel_interval: list[float]) -> dict:
    """H = -G_rel; its 95% upper endpoint is -(lower endpoint of G_rel's interval)."""
    h_upper = -G_rel_interval[0]
    return {"G_rel": G_rel, "G_rel_interval": G_rel_interval, "H": -G_rel,
            "H_upper": h_upper, "passed": bool(h_upper <= MAX_DETERIORATION)}


def validity_reasons(point: dict | None, guard: dict | None, season_order, seeds) -> list[str]:
    """Every metric §7 requires to be defined, checked BEFORE the six conditions.

    Required: G and both endpoints of G_interval; for every registered test
    season, G_S[S] and both endpoints of G_S_interval[S]; for every registered
    seed, G_seed[s] and both endpoints of G_seed_interval[s]; G_rel and both
    endpoints of G_rel_interval. A missing family, a missing entry, a malformed
    interval, None, NaN or +/-inf is named as `undefined point metric <name>`.
    """
    point, guard = point or {}, guard or {}
    reasons: list[str] = []

    def scalar(name: str, value) -> None:
        if not _finite(value):
            reasons.append(f"undefined point metric {name}")

    def interval(name: str, value) -> None:
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            reasons.append(f"undefined point metric {name} (missing or malformed interval)")
            return
        for end, v in zip(("lower", "upper"), value):
            scalar(f"{name}.{end}", v)

    scalar("G", point.get("G"))
    interval("G_interval", point.get("G_interval"))
    G_S, G_S_int = point.get("G_S") or {}, point.get("G_S_interval") or {}
    for s in season_order:
        scalar(f"G_S[{s}]", G_S.get(s))
        interval(f"G_S_interval[{s}]", G_S_int.get(s))
    G_seed, G_seed_int = point.get("G_seed") or {}, point.get("G_seed_interval") or {}
    for s in seeds:
        scalar(f"G_seed[{s}]", G_seed.get(s))
        interval(f"G_seed_interval[{s}]", G_seed_int.get(s))
    scalar("G_rel", guard.get("G_rel"))
    interval("G_rel_interval", guard.get("G_rel_interval"))
    return reasons


def decide(point: dict | None, guard: dict | None, invalid_reasons: list[str],
           season_order=TEST_SEASONS, seeds=SEEDS) -> dict:
    """Disposition with `invalid` decided first (spec §7), then the six
    conditions on unrounded values (§6), then the scientific failure label.
    `season_order` and `seeds` are the registered families every required
    metric must cover; the conditions read exactly those entries."""
    season_order = tuple(int(s) for s in season_order)
    seeds = tuple(int(s) for s in seeds)
    reasons = list(invalid_reasons)
    if not reasons:
        reasons = validity_reasons(point, guard, season_order, seeds)
    if reasons:
        return {"disposition": "invalid", "failure_label": None, "conditions": None,
                "failed_conditions": None, "invalid_reasons": reasons}
    G_S = [point["G_S"][s] for s in season_order]
    conditions = {
        "materiality": point["G"] >= MATERIALITY,
        "interval_lower_above_0": point["G_interval"][0] > 0,
        "two_seasons_positive": sum(g > 0 for g in G_S) >= 2,
        "no_season_below_floor": all(g >= SEASON_FLOOR for g in G_S),
        "all_seeds_positive": all(point["G_seed"][s] > 0 for s in seeds),
        "relevant_guardrail": guard["H_upper"] <= MAX_DETERIORATION,
    }
    conditions = {k: bool(v) for k, v in conditions.items()}
    failed = [k for k in CONDITIONS if not conditions[k]]
    if not failed:
        return {"disposition": "pass", "failure_label": None, "conditions": conditions,
                "failed_conditions": [], "invalid_reasons": []}
    label = "below_materiality" if point["G_interval"][1] < MATERIALITY else "inconclusive"
    return {"disposition": "fail", "failure_label": label, "conditions": conditions,
            "failed_conditions": failed, "invalid_reasons": []}


def consequences(decision: dict, ranking: dict | None) -> dict:
    """What the result buys (spec §5.4, §9). Both ranking_veto and
    ranking_not_evaluable forbid ranking recommendations and are carried into
    the forward test's pre-registration; neither changes the point gate."""
    status = None if ranking is None else ranking["status"]
    return {
        "buys_forward_shadow_test": decision["disposition"] == "pass",
        "ranking_status": status,
        "ranking_recommendation_forbidden": status != "ranking_ok",
        "carry_into_forward_preregistration": (
            {"ranking_status": status, "ranking_recommendation_forbidden": status != "ranking_ok"}
            if decision["disposition"] == "pass" else None),
        "site_change_authorized": False,
    }


def evaluate(paired: pd.DataFrame, seeds=SEEDS, season_order=TEST_SEASONS, *,
             n_accept: int = N_ACCEPT, max_attempts: int = MAX_ATTEMPTS,
             rng_seed: int = RNG_SEED) -> dict:
    """All §5-§7 outputs for one paired frame. Never raises ScreenInvalid:
    an invalid condition becomes disposition `invalid` with its reason."""
    seeds = tuple(int(s) for s in seeds)
    season_order = tuple(int(s) for s in season_order)
    preds = paired[[pred_col(a, s) for a in ARMS for s in seeds]].to_numpy(float)
    if not np.isfinite(preds).all() or not np.isfinite(paired["actual"].to_numpy(float)).all():
        decision = decide(None, None, ["non-finite prediction or actual in the paired frame"])
        return {"point": None, "bootstrap": None, "relevant": None, "ranking": None,
                "decision": decision, "consequences": consequences(decision, None)}
    ranking = ranking_status(paired, seeds, season_order)
    point = relevant = boot_summary = None
    invalid = []
    try:
        point = point_effects(paired, seeds, season_order)
        membership = relevant_membership(paired, seeds)
        counts = relevant_counts(paired, membership, season_order)   # may raise: before bootstrap
        G_rel, G_rel_S = season_equal_mean(
            loss_differences(paired, seeds)["d"].to_numpy()[membership],
            paired["season"].to_numpy()[membership], season_order)
        boot = crossed_bootstrap(paired, seeds, membership, season_order,
                                 n_accept=n_accept, max_attempts=max_attempts, rng_seed=rng_seed)
        point["G_interval"] = percentile_interval(boot["G"])
        point["G_S_interval"] = {s: percentile_interval(boot["G_S"][:, i])
                                 for i, s in enumerate(season_order)}
        point["G_seed_interval"] = {s: percentile_interval(boot["G_seed"][:, i])
                                    for i, s in enumerate(seeds)}
        relevant = {**guardrail(G_rel, percentile_interval(boot["G_rel"])),
                    "G_rel_by_season": G_rel_S, "counts": counts}
        boot_summary = {"accepted": boot["accepted"], "attempts": boot["attempts"],
                        "rejected": boot["rejected"]}
    except ScreenInvalid as exc:
        invalid.append(str(exc))
    decision = decide(point, relevant, invalid, season_order, seeds)
    return {"point": point, "bootstrap": boot_summary, "relevant": relevant,
            "ranking": ranking, "decision": decision,
            "consequences": consequences(decision, ranking)}
```

- [ ] **Step 4: Run to verify pass**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_stats.py`
Expected: `60 passed` (about 3 s).

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/lines_stats.py tests/test_lines_stats.py
git commit -m "feat(eval): lines-screen statistics — crossed bootstrap, cohort guardrail, ranking status, decision

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Driver — frozen frame, collector, manifest, run, CLI

**Model:** implementer `sonnet`; reviewer `opus` (frozen-input integrity, scoring contract, manifest completeness
against §8).

**Files:**
- Create: `tests/lines_world.py` (helper module; its name does not start with `test_`, so pytest does not collect it)
- Create: `src/ffmodel/eval/lines_screen.py`
- Create: `tests/test_lines_screen.py`

**Interfaces:**
- Consumes:
  - From Task 1: `LINE_FEATURE_COLUMNS` and `feature_columns`.
  - From Task 2: `LinesDataError`, `build_line_table`, `file_sha256`, `join_line_features`, `package_version`,
    `read_snapshot`, `snapshot_meta_path` and `snapshot_schedules`.
  - From Task 3: `ARMS`, `SEEDS`, `TEST_SEASONS`, `RNG_SEED`, `N_ACCEPT`, `MAX_ATTEMPTS`, `PERCENTILES`,
    `PERCENTILE_METHOD`, every threshold constant, `ScreenInvalid`, `evaluate`, `loss_differences` and `pred_col`.
  - Existing code:
    - `walk_forward_splits(df, test_seasons)` yields `(season, train_idx, test_idx)` (`src/ffmodel/eval/splits.py`);
    - `fantasy_points(stats, rules)`, `PPR` and `PREDICTED_STATS` (`src/ffmodel/scoring.py`);
    - `XGBBaseline` (`src/ffmodel/baseline/xgb.py`);
    - `POSITIONS` (`src/ffmodel/data/pull.py`).
  - Inside the `freeze` CLI only: `pull_weekly(seasons, cache_dir)`, `pull_schedules(seasons, cache_dir)`,
    `build_features(weekly, schedules)` and `data_vintage(data_dir, seasons, feature_rows) -> dict`
    (`src/ffmodel/eval/run.py`). `data_vintage` hashes `weekly_v2_*`, `snaps_*`, `players` and `schedules_v3_*`
    parquet files under `data_dir`.
- Produces (all in `ffmodel.eval.lines_screen`):
  - Constants: `SPEC_PATH`, `ARM_FEATURE_SETS = {"A": "v1", "B": "v1_lines"}`, `KEY_COLUMNS`, `EXPECTED_TEST_ROWS`,
    `ESTIMATOR_CONFIG`, `SCORING_CONFIG` and `TIMING_LABEL`.
  - `arm_feature_lists(frame) -> (A, B)`.
  - `build_model_frame(joined) -> DataFrame`. Its columns are `player_id, season, week, position, team`, then the B
    list minus `week`, then `PREDICTED_STATS`. Rows are sorted by (season, week, player_id), with a RangeIndex.
  - `frame_schema(frame)`.
  - `write_frozen_frame(frame, path) -> {path, sha256, rows, schema}`.
  - `read_frozen_frame(path, expected_sha256, expected_schema)`.
  - `assert_arms_paired(frame)`.
  - `make_xgb_predictor(arm, seed)`.
  - `collect_paired_predictions(frame, seeds, test_seasons, make_predictor=make_xgb_predictor) -> DataFrame`.
  - `software_versions()`, `resolved_estimator_params(seed=0)`, `row_counts(frame, test_seasons)` and
    `git_provenance(spec_path=SPEC_PATH)`.
  - `refuse_existing(*paths)` raises `FileExistsError` naming every given path that exists.
  - `write_json(payload, path)`, which applies `allow_nan=False` after converting NaN to `None` and opens the file
    with exclusive create (`"x"`): it never replaces an existing file. Every JSON this module writes is evidence
    (manifest or artifact), so there is no separate overwriting writer.
  - `invalid_artifact(reasons, manifest, stage)`.
  - `freeze_screen(raw_schedules, features, *, frame_path, manifest_path, artifact_path, provenance, seasons,
    test_seasons, seeds) -> manifest | invalid artifact`. It calls `refuse_existing(manifest_path, artifact_path,
    frame_path)` before any validation or write.
  - `run_screen(manifest_path, artifact_path, paired_path, *, make_predictor, n_accept=None, max_attempts=None) ->
    artifact`. Its `run` block records `run_commit` (HEAD) and `tracked_changes_uncommitted`.
  - `build_parser()` and `main(argv) -> int`.

`build_model_frame` and `collect_paired_predictions` accept any frame from `build_features`. The `world()` helper gives
40 A columns, because the v1 list depends only on `LAG_STATS`, `CONTEXT_FEATURES`, the opponent columns and
`POSITIONS`.

- [ ] **Step 1: Write the synthetic-world helper**

Create `tests/lines_world.py`:

```python
"""A small synthetic NFL world for the lines-screen driver tests.

Four canonical teams, two games a week, seasons 2022-2025 x weeks 1-4, seven
players per team. Every number is invented by a seeded RNG -- no real
statistics and no real betting lines.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ffmodel.data.features import build_features
from ffmodel.scoring import PREDICTED_STATS

from tests.test_features import make_weekly

TEAMS = ("KC", "BUF", "MIA", "NYJ")
ROSTER = (("QB", 1), ("RB", 2), ("WR", 3), ("TE", 1))
WORLD_SEASONS = (2022, 2023, 2024, 2025)
WEEKS = 4


def _pairings(week: int) -> list[tuple[str, str]]:
    """(home, away) pairs; home sides alternate by week."""
    if week % 2:
        return [("KC", "BUF"), ("MIA", "NYJ")]
    return [("BUF", "KC"), ("NYJ", "MIA")]


def _stat_line(rng: np.random.Generator, position: str) -> dict:
    line = {s: 0.0 for s in PREDICTED_STATS}
    if position == "QB":
        line.update(passing_yards=float(rng.normal(240, 50)), passing_tds=float(rng.poisson(1.6)),
                    passing_interceptions=float(rng.poisson(0.8)), carries=float(rng.poisson(3)),
                    rushing_yards=float(rng.normal(12, 6)))
    elif position == "RB":
        carries = float(rng.poisson(12))
        line.update(carries=carries, rushing_yards=float(carries * 4.2 + rng.normal(0, 10)),
                    rushing_tds=float(rng.poisson(0.4)), targets=float(rng.poisson(3)),
                    receptions=float(rng.poisson(2)), receiving_yards=float(rng.normal(15, 8)),
                    fumbles_lost=float(rng.poisson(0.05)))
    else:
        scale = 1.0 if position == "WR" else 0.6
        targets = float(rng.poisson(7 * scale))
        receptions = float(rng.binomial(int(targets), 0.65))
        line.update(targets=targets, receptions=receptions,
                    receiving_yards=float(receptions * 12 + rng.normal(0, 8)),
                    receiving_tds=float(rng.poisson(0.4 * scale)))
    return line


def world(seed: int = 0) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """(weekly, schedules, raw_schedule_payload) for the synthetic world."""
    rng = np.random.default_rng(seed)
    weekly_rows, sched_rows, raw_rows = [], [], []
    for season in WORLD_SEASONS:
        days = pd.date_range(f"{season}-09-10", periods=WEEKS, freq="7D").strftime("%Y-%m-%d")
        for week in range(1, WEEKS + 1):
            for home, away in _pairings(week):
                total = float(np.round(rng.uniform(40, 52) * 2) / 2)
                spread = float(np.round(rng.uniform(-7, 7) * 2) / 2)
                sched_rows.append({"season": season, "week": week, "gameday": days[week - 1],
                                   "home_team": home, "away_team": away})
                raw_rows.append({
                    "game_id": f"{season}_{week:02d}_{away}_{home}", "season": season,
                    "game_type": "REG", "week": week, "gameday": days[week - 1],
                    "away_team": away, "home_team": home, "away_score": int(rng.integers(10, 35)),
                    "home_score": int(rng.integers(10, 35)), "location": "Home", "result": 0,
                    "total": 0, "spread_line": spread, "total_line": total,
                })
                for team, opp in ((home, away), (away, home)):
                    for position, count in ROSTER:
                        for i in range(count):
                            weekly_rows.append({
                                "player_id": f"{team}_{position}{i}", "position": position,
                                "team": team, "opponent_team": opp, "season": season,
                                "week": week, **_stat_line(rng, position),
                            })
    weekly = make_weekly(weekly_rows)
    weekly["two_point_conversions"] = 1          # scoring extras present on actuals
    weekly["special_teams_tds"] = 1
    return weekly, pd.DataFrame(sched_rows), pd.DataFrame(raw_rows)


def world_features(seed: int = 0) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(build_features output, raw schedule payload)."""
    weekly, sched, raw = world(seed)
    return build_features(weekly, sched), raw


class FakePredictor:
    """Deterministic stand-in for XGBBaseline: last-4 average per component
    (train mean when missing), nudged by the seed; arm B also reads the
    expected margin so the arms differ. Consumes only frozen-frame columns."""

    def __init__(self, arm: str, seed: int, bad: str | None = None):
        self.arm, self.seed, self.bad = arm, seed, bad
        self.name = f"fake_{arm}_{seed}"

    def fit(self, train: pd.DataFrame) -> None:
        self.means = train[PREDICTED_STATS].mean()

    def predict(self, test: pd.DataFrame) -> pd.DataFrame:
        out = pd.DataFrame(index=test.index)
        for stat in PREDICTED_STATS:
            out[stat] = test[f"lag4_{stat}"].fillna(self.means[stat]) * (1 + 0.01 * self.seed)
        if self.arm == "B":
            out["receiving_yards"] = out["receiving_yards"] + test["team_expected_margin"].fillna(0)
        if self.bad == "nan" and self.arm == "B":
            out.iloc[0, 0] = np.nan
        if self.bad == "misaligned":
            out = out.iloc[::-1].reset_index(drop=True)
        if self.bad == "missing_column":
            out = out.drop(columns=["receptions"])
        return out[[c for c in PREDICTED_STATS if c in out.columns]]
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_lines_screen.py`:

```python
"""Lines-screen driver: frozen frame, collector, manifest and run
(spec 2026-10-11 §4, §8, §11). Synthetic world + stand-in predictors."""
import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.data.features import LINE_FEATURE_COLUMNS
from ffmodel.data.lines import build_line_table, file_sha256, join_line_features
from ffmodel.eval import lines_screen
from ffmodel.eval.lines_screen import (
    ARM_FEATURE_SETS,
    ESTIMATOR_CONFIG,
    KEY_COLUMNS,
    TIMING_LABEL,
    arm_feature_lists,
    assert_arms_paired,
    build_model_frame,
    collect_paired_predictions,
    freeze_screen,
    read_frozen_frame,
    run_screen,
    write_frozen_frame,
)
from ffmodel.eval.lines_stats import RNG_SEED, ScreenInvalid, evaluate, pred_col
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

from tests.lines_world import FakePredictor, world_features

SEASONS = list(range(2012, 2026))
TEST_SEASONS = (2023, 2024, 2025)
SEEDS = (0, 1, 2)


@pytest.fixture(scope="module")
def joined() -> pd.DataFrame:
    features, raw = world_features()
    table, _ = build_line_table(raw, SEASONS)
    out, _ = join_line_features(features, table)
    return out


@pytest.fixture(scope="module")
def frame(joined) -> pd.DataFrame:
    return build_model_frame(joined)


def fake(bad=None):
    return lambda arm, seed: FakePredictor(arm, seed, bad=bad)


def strict_json(path):
    def reject(token):
        raise ValueError(f"non-JSON constant {token}")
    return json.loads(path.read_text(encoding="utf-8"), parse_constant=reject)


# --- frozen modeling frame ------------------------------------------------------

def test_model_frame_holds_exactly_keys_features_and_targets(frame):
    a_cols, b_cols = arm_feature_lists(frame)
    assert len(a_cols) == 40 and b_cols == a_cols + LINE_FEATURE_COLUMNS
    lead = ["player_id", "season", "week", "position", "team"]
    assert list(frame.columns) == lead + [c for c in b_cols if c not in lead] + PREDICTED_STATS
    for absent in ("two_point_conversions", "special_teams_tds", "ppr_points", "fantasy_points_ppr"):
        assert absent not in frame.columns
    assert frame.index.equals(pd.RangeIndex(len(frame)))
    order = frame[["season", "week", "player_id"]].apply(tuple, axis=1).tolist()
    assert order == sorted(order)


@pytest.mark.parametrize("breakage,match", [
    (lambda f: pd.concat([f, f.iloc[[0]]], ignore_index=True), "duplicate row key"),
    (lambda f: f.assign(player_id=[None] + list(f["player_id"].iloc[1:])), "null row key"),
    (lambda f: f.assign(position=["K"] + list(f["position"].iloc[1:])), "positions outside"),
    (lambda f: f.assign(season=f["season"].replace(2022, 2011)), "seasons outside"),
])
def test_model_frame_rejects_bad_population(joined, breakage, match):
    with pytest.raises(ScreenInvalid, match=match):
        build_model_frame(breakage(joined))


def test_arm_lists_require_the_line_columns_and_forty_a_columns(joined):
    with pytest.raises(ValueError, match="needs line column"):
        arm_feature_lists(joined.drop(columns=["team_expected_margin"]))
    with pytest.raises(ScreenInvalid, match="expected 40"):
        arm_feature_lists(joined.drop(columns=["lag4_carries"]))


def test_arms_paired_on_the_frozen_frame(frame):
    assert_arms_paired(frame)       # does not raise


def test_frozen_frame_hash_schema_and_no_overwrite(frame, tmp_path):
    info = write_frozen_frame(frame, tmp_path / "frame.parquet")
    assert info["sha256"] == file_sha256(tmp_path / "frame.parquet")
    assert info["schema"][0] == {"name": "player_id", "dtype": str(frame["player_id"].dtype)}
    assert [c["name"] for c in info["schema"]] == list(frame.columns)
    back = read_frozen_frame(info["path"], info["sha256"], info["schema"])
    pd.testing.assert_frame_equal(back, frame)
    again = write_frozen_frame(frame, tmp_path / "again.parquet")
    assert again["sha256"] == info["sha256"]                      # deterministic bytes
    with pytest.raises(FileExistsError):
        write_frozen_frame(frame, tmp_path / "frame.parquet")


def test_changed_frame_changes_hash_and_is_refused(frame, tmp_path):
    info = write_frozen_frame(frame, tmp_path / "frame.parquet")
    changed = frame.assign(team_implied_total=frame["team_implied_total"] + 0.5)
    other = write_frozen_frame(changed, tmp_path / "changed.parquet")
    assert other["sha256"] != info["sha256"]
    with pytest.raises(ScreenInvalid, match="sha256"):
        read_frozen_frame(other["path"], info["sha256"], info["schema"])
    with pytest.raises(ScreenInvalid, match="schema"):
        read_frozen_frame(info["path"], info["sha256"], info["schema"][:-1])


# --- collector ----------------------------------------------------------------------

def test_collector_scores_common_components_only(joined, frame):
    assert (joined["two_point_conversions"] == 1).all()          # extras are in the frame...
    from_joined = collect_paired_predictions(joined, SEEDS, TEST_SEASONS, make_predictor=fake())
    test = joined[joined["season"].isin(TEST_SEASONS)]
    expected = fantasy_points(test[PREDICTED_STATS], PPR)
    np.testing.assert_allclose(from_joined.loc[test.index, "actual"], expected)
    with_extras = fantasy_points(test, PPR)
    np.testing.assert_allclose(with_extras - expected, 8.0)     # ...but never enter actual
    from_frame = collect_paired_predictions(frame, SEEDS, TEST_SEASONS, make_predictor=fake())
    assert sorted(from_frame["actual"]) == pytest.approx(sorted(from_joined["actual"]))


def test_collector_shape_keys_and_pairing(frame):
    paired = collect_paired_predictions(frame, SEEDS, TEST_SEASONS, make_predictor=fake())
    test = frame[frame["season"].isin(TEST_SEASONS)]
    assert paired.index.equals(test.index)
    assert list(paired.columns[:5]) == ["player_id", "season", "week", "position", "actual"]
    assert [c for c in paired.columns[5:]] == [pred_col(a, s) for a in ("A", "B") for s in SEEDS]
    assert not paired[KEY_COLUMNS].duplicated().any()
    assert not np.allclose(paired[pred_col("A", 0)], paired[pred_col("B", 0)])


@pytest.mark.parametrize("bad,match", [("nan", "non-finite predicted component"),
                                       ("misaligned", "misaligned"),
                                       ("missing_column", "missing predicted component")])
def test_collector_invalid_predictions(frame, bad, match):
    with pytest.raises(ScreenInvalid, match=match):
        collect_paired_predictions(frame, SEEDS, TEST_SEASONS, make_predictor=fake(bad))


def test_collector_with_real_xgb_arms(frame):
    make = lambda arm, seed: XGBBaseline(n_estimators=5, seed=seed,
                                         feature_set=ARM_FEATURE_SETS[arm])
    paired = collect_paired_predictions(frame, (0,), (2025,), make_predictor=make)
    assert len(paired) == int((frame["season"] == 2025).sum())
    assert np.isfinite(paired[[pred_col("A", 0), pred_col("B", 0)]].to_numpy()).all()


def test_estimator_config_matches_xgb_baseline(frame):
    model = XGBBaseline(seed=0)
    model.fit(frame[frame["season"] == 2022])
    params = model._models[PREDICTED_STATS[0]].get_params()
    for key, value in ESTIMATOR_CONFIG.items():
        assert params[key] == value, key


# --- freeze + run ---------------------------------------------------------------------

def paths(tmp_path):
    return {"frame_path": tmp_path / "data" / "frame.parquet",
            "manifest_path": tmp_path / "manifest.json",
            "artifact_path": tmp_path / "lines_screen.json"}


PROVENANCE = {"spec": {"path": "spec.md", "git_blob": "abc"}, "implementation_commit": "def",
              "schedule_snapshot": {"sha256": "0" * 64}, "source_data_vintage": {"sources": []}}


def frozen(tmp_path):
    features, raw = world_features()
    p = paths(tmp_path)
    manifest = freeze_screen(raw, features, provenance=PROVENANCE, **p)
    return manifest, p


def test_freeze_writes_frame_and_complete_manifest(tmp_path):
    manifest, p = frozen(tmp_path)
    on_disk = strict_json(p["manifest_path"])
    assert on_disk["model_frame"]["sha256"] == file_sha256(p["frame_path"])
    for key in ("spec", "implementation_commit", "schedule_snapshot", "source_data_vintage",
                "lines_validation", "line_join_by_season", "model_frame", "feature_lists",
                "estimator", "scoring", "software", "rows", "train_test_ranges", "seeds",
                "test_seasons", "rng", "thresholds", "timing_label"):
        assert key in on_disk, key
    assert len(on_disk["feature_lists"]["A"]) == 40 and len(on_disk["feature_lists"]["B"]) == 42
    assert on_disk["rng"]["seed"] == 20261007 and on_disk["rng"]["percentile_method"] == "linear"
    assert on_disk["train_test_ranges"]["2023"] == {"train": [2022, 2022], "test": 2023}
    assert on_disk["rows"]["test_rows"]["2023"] == {"rows": 112, "expected": 5893}
    assert on_disk["rows"]["test_rows_match_expected"] is False     # recorded, not fatal
    assert on_disk["scoring"]["pass_td"] == 4.0
    assert on_disk["timing_label"] == TIMING_LABEL
    assert not p["artifact_path"].exists()                           # nothing fitted yet


def unmatched(raw: pd.DataFrame) -> pd.DataFrame:
    """Drop one game, so its players' team-week is unmatched (a fatal join error)."""
    return raw[~((raw["season"] == 2024) & (raw["week"] == 3) & (raw["home_team"] == "MIA"))]


def test_freeze_on_unmatched_join_writes_invalid_and_no_frame(tmp_path):
    features, raw = world_features()
    raw = unmatched(raw)
    p = paths(tmp_path)
    out = freeze_screen(raw, features, provenance=PROVENANCE, **p)
    assert out["decision"]["disposition"] == "invalid"
    assert "unmatched player team-week" in out["decision"]["invalid_reasons"][0]
    assert strict_json(p["artifact_path"])["decision"]["disposition"] == "invalid"
    assert not p["frame_path"].exists() and not p["manifest_path"].exists()


# --- evidence files are written once (R1) ------------------------------------------------

ORIGINAL = {"manifest_path": b'{"original": "manifest"}\n',
            "artifact_path": b'{"original": "result"}\n'}


@pytest.mark.parametrize("scenario", ["would_succeed", "fatal_join"])
@pytest.mark.parametrize("existing", ["manifest_path", "artifact_path"])
def test_freeze_never_replaces_an_existing_manifest_or_result(tmp_path, existing, scenario):
    features, raw = world_features()
    if scenario == "fatal_join":
        raw = unmatched(raw)          # would write an `invalid` artifact
    p = paths(tmp_path)               # a fresh frame path: only the one record exists
    p[existing].write_bytes(ORIGINAL[existing])
    with pytest.raises(FileExistsError, match="never replaced"):
        freeze_screen(raw, features, provenance=PROVENANCE, **p)
    assert p[existing].read_bytes() == ORIGINAL[existing]
    assert [k for k in p if p[k].exists()] == [existing]        # nothing else written


@pytest.mark.parametrize("existing", ["manifest_path", "artifact_path", "frame_path"])
def test_freeze_refuses_before_any_validation(tmp_path, monkeypatch, existing):
    def boom(*args, **kwargs):
        raise AssertionError("validation must not start when a destination exists")

    monkeypatch.setattr(lines_screen, "build_line_table", boom)
    features, raw = world_features()
    p = paths(tmp_path)
    p[existing].parent.mkdir(parents=True, exist_ok=True)
    p[existing].write_bytes(b"original")
    with pytest.raises(FileExistsError):
        freeze_screen(raw, features, provenance=PROVENANCE, **p)
    assert p[existing].read_bytes() == b"original"


def test_second_failing_freeze_preserves_the_first_invalid_result(tmp_path):
    features, raw = world_features()
    raw = unmatched(raw)
    p = paths(tmp_path)
    assert freeze_screen(raw, features, provenance=PROVENANCE, **p)["decision"]["disposition"] == "invalid"
    original = p["artifact_path"].read_bytes()
    retry = {**p, "frame_path": tmp_path / "data" / "frame_v2.parquet",
             "manifest_path": tmp_path / "manifest_v2.json"}
    with pytest.raises(FileExistsError):        # the replacement would also be `invalid`
        freeze_screen(raw, features, provenance={**PROVENANCE, "implementation_commit": "fix"}, **retry)
    assert p["artifact_path"].read_bytes() == original
    # A rerun under a new result path is allowed and keeps both records.
    retry["artifact_path"] = tmp_path / "lines_screen_v2.json"
    assert freeze_screen(raw, features, provenance=PROVENANCE, **retry)["decision"]["disposition"] == "invalid"
    assert p["artifact_path"].read_bytes() == original and retry["artifact_path"].exists()


def test_second_freeze_with_a_new_frame_path_cannot_replace_the_manifest(tmp_path):
    _, p = frozen(tmp_path)
    original = p["manifest_path"].read_bytes()
    features, raw = world_features()
    new_frame = tmp_path / "data" / "frame_v2.parquet"
    with pytest.raises(FileExistsError):
        freeze_screen(raw, features, provenance=PROVENANCE, **{**p, "frame_path": new_frame})
    assert p["manifest_path"].read_bytes() == original
    assert not new_frame.exists() and not p["artifact_path"].exists()


def test_write_json_refuses_replacement_and_leaves_no_partial_file(tmp_path):
    path = tmp_path / "evidence.json"
    path.write_bytes(b"original")
    with pytest.raises(FileExistsError):
        lines_screen.write_json({"a": 1}, path)
    assert path.read_bytes() == b"original"
    fresh = tmp_path / "fresh.json"
    with pytest.raises(TypeError):
        lines_screen.write_json({"a": object()}, fresh)       # serialised before opening
    assert not fresh.exists()


def test_run_reads_frozen_frame_and_writes_strict_artifact(tmp_path):
    manifest, p = frozen(tmp_path)
    paired_path = tmp_path / "data" / "paired.parquet"
    out = run_screen(p["manifest_path"], p["artifact_path"], paired_path,
                     make_predictor=fake(), n_accept=200, max_attempts=2000)
    art = strict_json(p["artifact_path"])
    assert art["decision"]["disposition"] in {"pass", "fail"}
    assert art["paired_rows"]["sha256"] == file_sha256(paired_path)
    assert art["paired_rows"]["rows"] == 336
    assert art["manifest"]["model_frame"]["sha256"] == manifest["model_frame"]["sha256"]
    assert art["ranking"]["status"] in {"ranking_ok", "ranking_veto", "ranking_not_evaluable"}
    assert set(art["consequences"]) >= {"buys_forward_shadow_test", "ranking_recommendation_forbidden",
                                        "carry_into_forward_preregistration"}
    assert art["bootstrap"]["accepted"] == 200
    saved = pd.read_parquet(paired_path)
    assert {"d", "d_0", "d_1", "d_2"} <= set(saved.columns)
    assert out["point"]["G"] == pytest.approx(saved.groupby("season")["d"].mean().mean())
    with pytest.raises(FileExistsError):
        run_screen(p["manifest_path"], p["artifact_path"], tmp_path / "other.parquet",
                   make_predictor=fake(), n_accept=200, max_attempts=2000)


def _tamper_frame(p) -> None:
    frame = pd.read_parquet(p["frame_path"])
    frame.assign(team_implied_total=0.0).to_parquet(p["frame_path"], index=False)


def _tamper_manifest(edit):
    def apply(p) -> None:
        manifest = json.loads(p["manifest_path"].read_text(encoding="utf-8"))
        edit(manifest)
        p["manifest_path"].write_text(json.dumps(manifest), encoding="utf-8")
    return apply


def _set_dtype(m) -> None:
    m["model_frame"]["schema"][5]["dtype"] = "int8"


def _swap_b_line_columns(m) -> None:
    b = m["feature_lists"]["B"]
    b[-2], b[-1] = b[-1], b[-2]


def _drop_a_column(m) -> None:
    m["feature_lists"]["A"] = m["feature_lists"]["A"][:-1]


@pytest.mark.parametrize("tamper,match", [
    (_tamper_frame, "sha256"),                                    # frame bytes changed
    (_tamper_manifest(_set_dtype), "schema differs"),             # schema mismatch
    (_tamper_manifest(_swap_b_line_columns), "feature lists differ"),   # B list mismatch
    (_tamper_manifest(_drop_a_column), "feature lists differ"),         # A list mismatch
], ids=["hash", "schema", "feature_list_B", "feature_list_A"])
def test_run_integrity_mismatch_is_invalid_without_fitting(tmp_path, tamper, match):
    _, p = frozen(tmp_path)
    tamper(p)
    calls = []

    def recording(arm, seed):
        calls.append((arm, seed))
        raise AssertionError("must not fit when the frozen inputs do not match the manifest")

    paired_path = tmp_path / "paired.parquet"
    out = run_screen(p["manifest_path"], p["artifact_path"], paired_path, make_predictor=recording)
    assert calls == []                                            # factory never called
    assert out["decision"]["disposition"] == "invalid"
    assert match in out["decision"]["invalid_reasons"][0]
    assert not paired_path.exists()
    art = strict_json(p["artifact_path"])
    assert art["stage"] == "run" and art["decision"]["disposition"] == "invalid"
    assert art["consequences"]["buys_forward_shadow_test"] is False
    assert "tracked_changes_uncommitted" in art["run"]


def test_run_with_non_finite_prediction_is_invalid(tmp_path):
    _, p = frozen(tmp_path)
    out = run_screen(p["manifest_path"], p["artifact_path"], tmp_path / "paired.parquet",
                     make_predictor=fake("nan"), n_accept=50, max_attempts=500)
    assert out["decision"]["disposition"] == "invalid"
    assert "non-finite" in out["decision"]["invalid_reasons"][0]


def test_abandon_records_invalid(tmp_path):
    artifact = tmp_path / "lines_screen.json"
    code = lines_screen.main(["abandon", "--reason", "effort cap reached", "--artifact", str(artifact)])
    assert code == 2
    art = strict_json(artifact)
    assert art["decision"]["invalid_reasons"] == ["effort cap reached"]
    assert art["stage"] == "abandon"
    assert art["manifest"] is None


def test_abandon_with_a_manifest_that_does_not_exist_writes_nothing(tmp_path):
    artifact = tmp_path / "lines_screen.json"
    with pytest.raises(SystemExit, match="omit --manifest"):
        lines_screen.main(["abandon", "--reason", "effort cap reached",
                           "--manifest", str(tmp_path / "no_manifest.json"), "--artifact", str(artifact)])
    assert not artifact.exists()


def test_abandon_never_replaces_an_existing_artifact(tmp_path):
    artifact = tmp_path / "lines_screen.json"
    artifact.write_bytes(ORIGINAL["artifact_path"])
    with pytest.raises(SystemExit, match="preserve and report"):
        lines_screen.main(["abandon", "--reason", "effort cap reached", "--artifact", str(artifact)])
    assert artifact.read_bytes() == ORIGINAL["artifact_path"]


def test_abandon_after_a_successful_freeze_carries_the_manifest(tmp_path):
    manifest, p = frozen(tmp_path)
    code = lines_screen.main(["abandon", "--reason", "effort cap reached",
                              "--manifest", str(p["manifest_path"]), "--artifact", str(p["artifact_path"])])
    assert code == 2
    art = strict_json(p["artifact_path"])
    assert art["manifest"]["model_frame"]["sha256"] == manifest["model_frame"]["sha256"]
    assert art["decision"]["invalid_reasons"] == ["effort cap reached"]


def test_run_takes_seeds_seasons_and_bootstrap_protocol_from_the_manifest(tmp_path):
    _, p = frozen(tmp_path)
    manifest = json.loads(p["manifest_path"].read_text(encoding="utf-8"))
    manifest["seeds"] = [0, 2]
    manifest["test_seasons"] = [2024, 2025]
    manifest["rng"].update(seed=7, n_accept=120, max_attempts=4_000)   # small, so the test stays fast
    p["manifest_path"].write_text(json.dumps(manifest), encoding="utf-8")
    calls = []

    def recording(arm, seed):
        calls.append((arm, seed))
        return FakePredictor(arm, seed)

    paired_path = tmp_path / "paired.parquet"
    out = run_screen(p["manifest_path"], p["artifact_path"], paired_path, make_predictor=recording)
    # Seeds and test seasons: 2 arms x seeds {0, 2} x folds {2024, 2025}; no seed 1, no 2023.
    assert sorted(calls) == sorted([(a, s) for a in ("A", "B") for s in (0, 2)] * 2)
    saved = pd.read_parquet(paired_path)
    assert set(saved["season"]) == {2024, 2025}
    assert [c for c in saved.columns if c.startswith("pred_")] == [
        pred_col(a, s) for a in ("A", "B") for s in (0, 2)]
    assert set(out["point"]["G_S"]) == {2024, 2025} and set(out["point"]["G_seed"]) == {0, 2}
    # Bootstrap protocol: accepted count, attempt limit and generator seed.
    assert out["bootstrap"]["accepted"] == 120
    assert out["run"]["n_accept"] == 120 and out["run"]["max_attempts"] == 4_000
    paired = saved.drop(columns=["d", "d_0", "d_2"])
    kwargs = {"n_accept": 120, "max_attempts": 4_000}
    with_manifest_seed = evaluate(paired, (0, 2), (2024, 2025), rng_seed=7, **kwargs)
    with_code_default = evaluate(paired, (0, 2), (2024, 2025), rng_seed=RNG_SEED, **kwargs)
    assert out["point"]["G_interval"] == with_manifest_seed["point"]["G_interval"]
    assert out["point"]["G_interval"] != with_code_default["point"]["G_interval"]


def test_run_records_head_and_dirty_status(tmp_path, monkeypatch):
    _, p = frozen(tmp_path)
    monkeypatch.setattr(lines_screen, "git_provenance", lambda *a, **k: {
        "spec": None, "implementation_commit": "abc123", "tracked_changes_uncommitted": True})
    run_screen(p["manifest_path"], p["artifact_path"], tmp_path / "paired.parquet",
               make_predictor=fake(), n_accept=50, max_attempts=500)
    run = strict_json(p["artifact_path"])["run"]
    assert run["run_commit"] == "abc123"
    assert run["tracked_changes_uncommitted"] is True             # recorded, not discarded
```

- [ ] **Step 3: Run to verify failure**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_screen.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ffmodel.eval.lines_screen'`.

- [ ] **Step 4: Implement**

Create `src/ffmodel/eval/lines_screen.py`:

```python
"""Betting-lines feature screen driver: freeze, collect, evaluate, report.

Spec: docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md.

Three steps, each a CLI subcommand, run in order by the controller:

1. `snapshot` -- pull the raw nflverse schedule payload once into a private
   local parquet (never overwritten).
2. `freeze`   -- validate lines, build features from the frozen weekly and
   schedule caches, join the two line columns, write the complete ordered
   2012-2025 modeling frame to `data/` and its sha256 + the full run manifest
   to a committed JSON. No model is fitted.
3. `run`      -- read ONLY the frozen frame (hash- and schema-checked), fit
   2 arms x 3 seeds x 3 walk-forward folds, write paired row-level
   predictions/losses to `data/` and the result artifact (allow_nan=False).

`abandon` writes an `invalid` artifact for the effort cap (spec §10).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.data.features import LINE_FEATURE_COLUMNS, feature_columns
from ffmodel.data.lines import (
    LinesDataError,
    build_line_table,
    file_sha256,
    join_line_features,
    package_version,
    read_snapshot,
    snapshot_meta_path,
    snapshot_schedules,
)
from ffmodel.data.pull import POSITIONS
from ffmodel.eval.lines_stats import (
    ARMS,
    MATERIALITY,
    MAX_ATTEMPTS,
    MAX_DETERIORATION,
    MIN_CELL_PLAYERS,
    N_ACCEPT,
    PERCENTILE_METHOD,
    PERCENTILES,
    RANKING_VETO_BELOW,
    RELEVANT_MIN_PPR,
    RNG_SEED,
    SEASON_FLOOR,
    SEEDS,
    TEST_SEASONS,
    ScreenInvalid,
    evaluate,
    loss_differences,
    pred_col,
)
from ffmodel.eval.splits import walk_forward_splits
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

SPEC_PATH = "docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md"
FIRST_SEASON, LAST_SEASON = 2012, 2025
ARM_FEATURE_SETS = {"A": "v1", "B": "v1_lines"}
N_A_COLUMNS = 40
KEY_COLUMNS = ["player_id", "season", "week"]
META_COLUMNS = ["position", "team"]
# Spec §4: expected test rows (recorded; a mismatch is reported, not tuned away).
EXPECTED_TEST_ROWS = {2023: 5893, 2024: 5920, 2025: 6095}
# Must equal the regressor configuration hard-coded in XGBBaseline.fit
# (pinned by a test); random_state is the arm/seed's seed.
ESTIMATOR_CONFIG = {
    "n_estimators": 300, "max_depth": 5, "learning_rate": 0.05, "subsample": 0.8,
    "colsample_bytree": 0.8, "tree_method": "hist", "n_jobs": -1,
}
SCORING_CONFIG = {
    "construction": "common-component PPR",
    "actual": "fantasy_points(test[PREDICTED_STATS], PPR)",
    "pred": "fantasy_points(pred_stats[PREDICTED_STATS], PPR)",
    "components": PREDICTED_STATS,
    "pass_td": PPR.pass_td, "reception": PPR.reception,
    "excluded": ["two_point_conversions", "special_teams_tds", "passing_pick_sixes"],
    "predictions": "unclipped stat components; a non-finite component makes the run invalid",
}
TIMING_LABEL = (
    "Optimistic historical information screen. These are historical schedule lines, treated as "
    "closing-time context based on nflfastR's documentation of the related fields; their book and "
    "quote time are not recorded in the feed and their availability at our mid-week deadline is "
    "unverified. The screen admits information later than our publication deadline (injuries, "
    "lineup decisions, weather and market moves up to the close). A pass shows the information is "
    "worth chasing, not that a mid-week deployment would gain the same; it is never deployable "
    "performance. 'Optimistic' is a description, not a mathematical bound."
)


# --- frozen modeling frame (spec §8) --------------------------------------------

def arm_feature_lists(frame: pd.DataFrame) -> tuple[list[str], list[str]]:
    """(A, B) column lists; B must be exactly A + the two line columns."""
    a_cols = feature_columns(frame, ARM_FEATURE_SETS["A"])
    b_cols = feature_columns(frame, ARM_FEATURE_SETS["B"])
    if len(a_cols) != N_A_COLUMNS:
        raise ScreenInvalid(f"arm A resolved {len(a_cols)} columns, expected {N_A_COLUMNS}")
    if b_cols != a_cols + LINE_FEATURE_COLUMNS:
        raise ScreenInvalid("arm B list is not arm A + the two line columns in order")
    return a_cols, b_cols


def build_model_frame(joined: pd.DataFrame) -> pd.DataFrame:
    """The complete ordered modeling frame: keys, position, team, every A/B
    feature and every PREDICTED_STATS target -- nothing else. Rows sorted by
    (season, week, player_id); RangeIndex."""
    a_cols, b_cols = arm_feature_lists(joined)
    if joined[KEY_COLUMNS].isna().to_numpy().any():
        raise ScreenInvalid("null row key (player_id, season, week)")
    if joined.duplicated(KEY_COLUMNS).any():
        raise ScreenInvalid("duplicate row key (player_id, season, week)")
    if not set(joined["position"]) <= set(POSITIONS):
        raise ScreenInvalid(f"positions outside {POSITIONS}")
    seasons = joined["season"]
    if seasons.min() < FIRST_SEASON or seasons.max() > LAST_SEASON:
        raise ScreenInvalid(f"seasons outside {FIRST_SEASON}-{LAST_SEASON}")
    lead = KEY_COLUMNS + META_COLUMNS
    columns = lead + [c for c in b_cols if c not in lead] + PREDICTED_STATS
    frame = (joined[columns]
             .sort_values(["season", "week", "player_id"], kind="mergesort")
             .reset_index(drop=True))
    if feature_columns(frame, "v1") != a_cols or feature_columns(frame, "v1_lines") != b_cols:
        raise ScreenInvalid("feature lists changed when the frame was assembled")
    return frame


def frame_schema(frame: pd.DataFrame) -> list[dict]:
    return [{"name": c, "dtype": str(frame[c].dtype)} for c in frame.columns]


def write_frozen_frame(frame: pd.DataFrame, path: Path | str) -> dict:
    """Write once (never overwrite) and return {path, sha256, rows, schema}."""
    path = Path(path)
    if path.exists():
        raise FileExistsError(f"{path} exists; a frozen modeling frame is never overwritten")
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(path, index=False)
    return {"path": path.as_posix(), "sha256": file_sha256(path), "rows": int(len(frame)),
            "schema": frame_schema(frame)}


def read_frozen_frame(path: Path | str, expected_sha256: str, expected_schema: list[dict]) -> pd.DataFrame:
    actual = file_sha256(path)
    if actual != expected_sha256:
        raise ScreenInvalid(f"frozen frame {path} sha256 {actual} != manifest {expected_sha256}")
    frame = pd.read_parquet(path)
    if frame_schema(frame) != expected_schema:
        raise ScreenInvalid("frozen frame schema differs from the manifest")
    return frame


def assert_arms_paired(frame: pd.DataFrame) -> None:
    """Both arms see identical rows/indices/targets; B's matrix minus the two
    line columns is A's matrix exactly."""
    a = XGBBaseline(feature_set=ARM_FEATURE_SETS["A"])._matrix(frame)
    b = XGBBaseline(feature_set=ARM_FEATURE_SETS["B"])._matrix(frame)
    if list(b.columns) != list(a.columns) + LINE_FEATURE_COLUMNS:
        raise ScreenInvalid("arm matrices are not paired (column lists)")
    if not b.index.equals(a.index) or not b[list(a.columns)].equals(a):
        raise ScreenInvalid("arm matrices are not paired (non-line values)")


# --- row-level collector (spec §4) -----------------------------------------------

def make_xgb_predictor(arm: str, seed: int) -> XGBBaseline:
    return XGBBaseline(n_estimators=ESTIMATOR_CONFIG["n_estimators"], seed=seed,
                       feature_set=ARM_FEATURE_SETS[arm])


def collect_paired_predictions(frame: pd.DataFrame, seeds, test_seasons,
                               make_predictor=make_xgb_predictor) -> pd.DataFrame:
    """Per test row: keys, position, actual and one PPR point prediction per
    arm/seed (`pred_col`). Same walk-forward split and scoring contract as
    harness.run_backtest, including its prediction-index check."""
    parts = []
    for season, train_idx, test_idx in walk_forward_splits(frame, list(test_seasons)):
        train, test = frame.loc[train_idx], frame.loc[test_idx]
        if len(test) == 0 or len(train) == 0:
            raise ScreenInvalid(f"test season {season} has an empty train or test set")
        out = pd.DataFrame({
            "player_id": test["player_id"].to_numpy(), "season": test["season"].to_numpy(),
            "week": test["week"].to_numpy(), "position": test["position"].to_numpy(),
            "actual": fantasy_points(test[PREDICTED_STATS], PPR).to_numpy(),
        }, index=test.index)
        for arm in ARMS:
            for seed in seeds:
                predictor = make_predictor(arm, seed)
                predictor.fit(train)
                pred_stats = predictor.predict(test)
                if not pred_stats.index.equals(test.index):
                    raise ScreenInvalid(
                        f"{arm}/seed{seed}: prediction index misaligned with test frame")
                missing = [c for c in PREDICTED_STATS if c not in pred_stats.columns]
                if missing:
                    raise ScreenInvalid(f"{arm}/seed{seed}: missing predicted component(s) {missing}")
                values = pred_stats[PREDICTED_STATS].to_numpy(dtype=float)
                if not np.isfinite(values).all():
                    raise ScreenInvalid(
                        f"{arm}/seed{seed}: non-finite predicted component in season {season}")
                out[pred_col(arm, seed)] = fantasy_points(pred_stats[PREDICTED_STATS], PPR).to_numpy()
        parts.append(out)
    return pd.concat(parts)


# --- manifest / artifact -----------------------------------------------------------

def software_versions() -> dict:
    return {"python": platform.python_version(),
            **{name: package_version(name)
               for name in ("xgboost", "numpy", "pandas", "scipy", "pyarrow", "nflreadpy")}}


def resolved_estimator_params(seed: int = 0) -> dict:
    from xgboost import XGBRegressor

    params = XGBRegressor(**ESTIMATOR_CONFIG, random_state=seed).get_params()
    return {k: v for k, v in sorted(params.items())
            if v is not None and isinstance(v, (bool, int, float, str))}


def row_counts(frame: pd.DataFrame, test_seasons) -> dict:
    per_season = {int(s): int(n) for s, n in frame.groupby("season").size().items()}
    test = {int(s): {"rows": per_season.get(int(s), 0), "expected": EXPECTED_TEST_ROWS.get(int(s))}
            for s in test_seasons}
    total_test = sum(v["rows"] for v in test.values())
    return {
        "per_season": per_season,
        "test_rows": test,
        "test_rows_match_expected": all(v["rows"] == v["expected"] for v in test.values()),
        "per_arm_test_rows": {arm: total_test for arm in ARMS},
    }


def git_provenance(spec_path: str = SPEC_PATH) -> dict:
    def git(*args: str) -> str | None:
        try:
            return subprocess.run(["git", *args], capture_output=True, text=True,
                                  check=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return None

    status = git("status", "--porcelain", "--untracked-files=no")
    return {"spec": {"path": spec_path, "git_blob": git("rev-parse", f"HEAD:{spec_path}")},
            "implementation_commit": git("rev-parse", "HEAD"),
            "tracked_changes_uncommitted": None if status is None else bool(status)}


def _jsonable(obj):
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        return float(obj) if math.isfinite(obj) else None
    return obj


def refuse_existing(*paths: Path | str) -> None:
    """Raise FileExistsError naming every evidence path that already exists.

    A manifest, frozen frame, result artifact or paired-row file is written
    once. A defect rerun uses NEW manifest, frame, result and paired-row paths
    and keeps the earlier files (spec §7) -- even an earlier `invalid` result."""
    existing = [Path(p).as_posix() for p in paths if Path(p).exists()]
    if existing:
        raise FileExistsError(
            f"{existing} already exist(s); evidence files are never replaced -- "
            f"a rerun uses new manifest, frame, result and paired-row paths")


def write_json(payload: dict, path: Path | str) -> None:
    """Write an evidence JSON once: exclusive create ("x"), so an existing
    file raises FileExistsError and its bytes are untouched. Serialised
    before the file is opened, so a serialisation error leaves no file."""
    path = Path(path)
    text = json.dumps(_jsonable(payload), indent=2, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as fh:
        fh.write(text)


def invalid_artifact(reasons: list[str], manifest: dict | None, stage: str) -> dict:
    return {
        "screen": "lines_feature_screen",
        "timing_label": TIMING_LABEL,
        "manifest": manifest,
        "stage": stage,
        "point": None, "bootstrap": None, "relevant": None, "ranking": None,
        "decision": {"disposition": "invalid", "failure_label": None, "conditions": None,
                     "failed_conditions": None, "invalid_reasons": reasons},
        "consequences": {"buys_forward_shadow_test": False, "ranking_status": None,
                         "ranking_recommendation_forbidden": True,
                         "carry_into_forward_preregistration": None,
                         "site_change_authorized": False},
    }


def freeze_screen(raw_schedules: pd.DataFrame, features: pd.DataFrame, *,
                  frame_path: Path | str, manifest_path: Path | str,
                  artifact_path: Path | str, provenance: dict,
                  seasons=tuple(range(FIRST_SEASON, LAST_SEASON + 1)),
                  test_seasons=TEST_SEASONS, seeds=SEEDS) -> dict:
    """Validate + join lines, write the frozen frame and the manifest. On a
    fatal data error writes an `invalid` artifact instead and returns it.

    Refuses (FileExistsError) BEFORE any validation or write if the manifest,
    the artifact or the frame path already exists, so neither a successful nor
    a failing freeze can replace an earlier manifest or result."""
    refuse_existing(manifest_path, artifact_path, frame_path)
    try:
        team_lines, lines_report = build_line_table(raw_schedules, list(seasons))
        joined, join_report = join_line_features(features, team_lines)
        frame = build_model_frame(joined)
        a_cols, b_cols = arm_feature_lists(frame)
        assert_arms_paired(frame)
    except (LinesDataError, ScreenInvalid) as exc:
        artifact = invalid_artifact([str(exc)], provenance, stage="freeze")
        write_json(artifact, artifact_path)
        return artifact
    frozen = write_frozen_frame(frame, frame_path)
    first = int(frame["season"].min())
    manifest = {
        "screen": "lines_feature_screen",
        "frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        **provenance,
        "lines_validation": lines_report,
        "line_join_by_season": join_report,
        "model_frame": frozen,
        "feature_lists": {"A": a_cols, "B": b_cols},
        "arms": {arm: {"feature_set": fs} for arm, fs in ARM_FEATURE_SETS.items()},
        "estimator": {"config": ESTIMATOR_CONFIG, "resolved_params": resolved_estimator_params(),
                      "per_component": PREDICTED_STATS},
        "scoring": SCORING_CONFIG,
        "software": software_versions(),
        "rows": row_counts(frame, test_seasons),
        "train_test_ranges": {int(s): {"train": [first, int(s) - 1], "test": int(s)}
                              for s in test_seasons},
        "seeds": [int(s) for s in seeds],
        "test_seasons": [int(s) for s in test_seasons],
        "rng": {"bit_generator": "numpy.random.PCG64", "seed": RNG_SEED,
                "draws": "integers(0, P, size=P) for players, then integers(0, k_S, size=k_S) "
                         "per season ascending",
                "n_accept": N_ACCEPT, "max_attempts": MAX_ATTEMPTS,
                "percentiles": list(PERCENTILES), "percentile_method": PERCENTILE_METHOD},
        "thresholds": {"materiality": MATERIALITY, "season_floor": SEASON_FLOOR,
                       "max_deterioration": MAX_DETERIORATION,
                       "relevant_min_ppr": RELEVANT_MIN_PPR,
                       "ranking_veto_below": RANKING_VETO_BELOW,
                       "min_cell_players": MIN_CELL_PLAYERS},
        "timing_label": TIMING_LABEL,
    }
    write_json(manifest, manifest_path)
    return manifest


def run_screen(manifest_path: Path | str, artifact_path: Path | str, paired_path: Path | str, *,
               make_predictor=make_xgb_predictor, n_accept: int | None = None,
               max_attempts: int | None = None) -> dict:
    """Fit/evaluate from the frozen frame only and write the artifact once.

    Seeds, test seasons and the bootstrap protocol come from the manifest;
    `n_accept`/`max_attempts` overrides exist for tests only (the CLI never
    passes them) and are recorded in the artifact when used."""
    artifact_path, paired_path = Path(artifact_path), Path(paired_path)
    refuse_existing(artifact_path, paired_path)
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    n_accept = manifest["rng"]["n_accept"] if n_accept is None else n_accept
    max_attempts = manifest["rng"]["max_attempts"] if max_attempts is None else max_attempts
    started = time.perf_counter()
    prov = git_provenance()
    run_info = {"started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                # HEAD at run time (the manifest commit, one after implementation_commit)
                # and whether tracked files were dirty -- recorded, never discarded.
                "run_commit": prov["implementation_commit"],
                "tracked_changes_uncommitted": prov["tracked_changes_uncommitted"],
                "software": software_versions()}
    try:
        mf = manifest["model_frame"]
        frame = read_frozen_frame(mf["path"], mf["sha256"], mf["schema"])
        a_cols, b_cols = arm_feature_lists(frame)
        if [a_cols, b_cols] != [manifest["feature_lists"]["A"], manifest["feature_lists"]["B"]]:
            raise ScreenInvalid("feature lists differ from the manifest")
        assert_arms_paired(frame)
        paired = collect_paired_predictions(frame, manifest["seeds"], manifest["test_seasons"],
                                            make_predictor=make_predictor)
    except ScreenInvalid as exc:
        artifact = invalid_artifact([str(exc)], manifest, stage="run")
        artifact["run"] = {**run_info, "runtime_seconds": time.perf_counter() - started}
        write_json(artifact, artifact_path)
        return artifact
    losses = loss_differences(paired, manifest["seeds"])
    paired_path.parent.mkdir(parents=True, exist_ok=True)
    pd.concat([paired, losses], axis=1).to_parquet(paired_path, index=True)
    result = evaluate(paired, manifest["seeds"], manifest["test_seasons"], n_accept=n_accept,
                      max_attempts=max_attempts, rng_seed=manifest["rng"]["seed"])
    artifact = {
        "screen": "lines_feature_screen",
        "timing_label": TIMING_LABEL,
        "manifest": manifest,
        "stage": "run",
        "run": {**run_info, "runtime_seconds": time.perf_counter() - started,
                "n_accept": n_accept, "max_attempts": max_attempts},
        "paired_rows": {"path": paired_path.as_posix(), "sha256": file_sha256(paired_path),
                        "rows": int(len(paired))},
        **result,
    }
    write_json(artifact, artifact_path)
    return artifact


# --- CLI ----------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Betting-lines feature screen (spec 2026-10-11).")
    sub = parser.add_subparsers(dest="command", required=True)
    snap = sub.add_parser("snapshot", help="pull + freeze the raw schedule payload (network)")
    snap.add_argument("--out", type=Path, default=Path("data/lines/schedules_raw_2012_2025.parquet"))
    freeze = sub.add_parser("freeze", help="validate, build and freeze the modeling frame")
    freeze.add_argument("--snapshot", type=Path, default=Path("data/lines/schedules_raw_2012_2025.parquet"))
    freeze.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    freeze.add_argument("--frame", type=Path, default=Path("data/lines/model_frame_2012_2025.parquet"))
    freeze.add_argument("--manifest", type=Path,
                        default=Path("models/diagnostics/lines_screen_manifest.json"))
    freeze.add_argument("--artifact", type=Path, default=Path("models/diagnostics/lines_screen.json"))
    run = sub.add_parser("run", help="fit both arms from the frozen frame and evaluate")
    run.add_argument("--manifest", type=Path,
                     default=Path("models/diagnostics/lines_screen_manifest.json"))
    run.add_argument("--artifact", type=Path, default=Path("models/diagnostics/lines_screen.json"))
    run.add_argument("--paired", type=Path, default=Path("data/lines/paired_rows.parquet"))
    abandon = sub.add_parser("abandon", help="record an invalid run (e.g. effort cap reached)")
    abandon.add_argument("--reason", required=True)
    abandon.add_argument("--manifest", type=Path, default=None)
    abandon.add_argument("--artifact", type=Path, default=Path("models/diagnostics/lines_screen.json"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    seasons = list(range(FIRST_SEASON, LAST_SEASON + 1))
    if args.command == "snapshot":
        meta = snapshot_schedules(seasons, args.out)
        print(json.dumps(meta, indent=2))
        return 0
    if args.command == "freeze":
        from ffmodel.data.features import build_features
        from ffmodel.data.pull import pull_schedules, pull_weekly
        from ffmodel.eval.run import data_vintage

        if os.environ.get("FFMODEL_CACHE_FROZEN") != "1":
            raise SystemExit("set FFMODEL_CACHE_FROZEN=1: freeze must read existing caches only")
        refuse_existing(args.manifest, args.artifact, args.frame)   # before reading any input
        meta = json.loads(snapshot_meta_path(args.snapshot).read_text(encoding="utf-8"))
        raw = read_snapshot(args.snapshot, meta["sha256"])
        weekly = pull_weekly(seasons, cache_dir=args.data_dir)
        schedules = pull_schedules(seasons, cache_dir=args.data_dir)
        features = build_features(weekly, schedules)
        provenance = {**git_provenance(), "schedule_snapshot": meta,
                      "source_data_vintage": data_vintage(args.data_dir, seasons, len(features))}
        out = freeze_screen(raw, features, frame_path=args.frame, manifest_path=args.manifest,
                            artifact_path=args.artifact, provenance=provenance)
        if out.get("decision", {}).get("disposition") == "invalid":
            print(f"INVALID at freeze: {out['decision']['invalid_reasons']} -> {args.artifact}")
            return 2
        print(f"frozen: {out['model_frame']['path']} sha256={out['model_frame']['sha256']} "
              f"rows={out['rows']['test_rows']} -> {args.manifest}")
        return 0
    if args.command == "run":
        out = run_screen(args.manifest, args.artifact, args.paired)
        d = out["decision"]
        print(f"disposition={d['disposition']} label={d['failure_label']} "
              f"failed={d['failed_conditions']} reasons={d['invalid_reasons']} "
              f"ranking={out['consequences']['ranking_status']} -> {args.artifact}")
        return 0 if d["disposition"] != "invalid" else 2
    # abandon: an existing artifact is the record -- preserve and report it.
    if args.artifact.exists():
        raise SystemExit(f"{args.artifact} exists; not overwriting -- preserve and report it")
    if args.manifest is not None and not args.manifest.exists():
        raise SystemExit(f"{args.manifest} does not exist; omit --manifest before a successful freeze")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8")) if args.manifest else None
    write_json(invalid_artifact([args.reason], manifest, stage="abandon"), args.artifact)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Run to verify pass**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_screen.py`
Expected: `40 passed` (about 15 s).

- [ ] **Step 6: Run every lines test plus the touched existing files**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_features.py tests/test_lines_data.py tests/test_lines_stats.py tests/test_lines_screen.py tests/test_features.py tests/test_xgb.py`
Expected: `188 passed`.

- [ ] **Step 7: Commit**

```bash
git add tests/lines_world.py src/ffmodel/eval/lines_screen.py tests/test_lines_screen.py
git commit -m "feat(eval): lines-screen driver — frozen modeling frame, paired collector, manifest, CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Final verification (controller, before the whole-branch review)

- [ ] Run the full suite from the worktree root:
  `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q`
  Expected: `1463 passed, 2 deselected` (about 4 minutes). The deselected two are the network `integration` tests,
  and the branch base was `1305 passed`. Leave `FFMODEL_CACHE_FROZEN` unset for the suite: with it set to `1`, 15
  existing `test_pull.py` / `test_rosters.py` cache tests fail by design.
- [ ] Confirm the import really resolves into the worktree:
  `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -c "import ffmodel; print(ffmodel.__file__)"`
  Expected: a path under `Megatron-lines\src`.
- [ ] Dispatch the final whole-branch review (`opus`) with the spec, this plan and the branch diff against `bcade0c`.

## After the build (controller, owner-gated)

This section is not an implementer task. It runs only after the final review passes, the branch is clean, and the
owner says go. It is the one real experiment run, and it must follow spec §7–§8 exactly:
- the manifest is frozen and committed **before any of the registered run's models is fitted**;
- all fits read only the frozen frame;
- nothing is shortened to finish.

One fit did precede the manifest: the single timing-only fit disclosed under "Verified when this plan was written". It
is not covered by the manifest, and nothing from it enters the run. The two-working-day cap (§10) includes this
section.

From the worktree root, in Git Bash:

```bash
export PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src
PY=C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe
M=models/diagnostics/lines_screen_manifest.json

# 0. Preconditions: on feat/lines-screen, final review passed, no tracked changes.
git status --porcelain --untracked-files=no        # must print nothing

# 1. Snapshot the raw schedule payload ONCE (network; refuses to overwrite).
#    Writes data/lines/schedules_raw_2012_2025.parquet + .meta.json (gitignored).
$PY -m ffmodel.eval.lines_screen snapshot

# 2. Freeze: validate lines, build features from the frozen local caches, join,
#    write data/lines/model_frame_2012_2025.parquet and the manifest. No fitting.
#    Refuses (before reading anything) if the manifest, artifact or frame path exists.
FFMODEL_CACHE_FROZEN=1 $PY -m ffmodel.eval.lines_screen freeze \
    --data-dir C:/Users/reisu/projects/Megatron/data/raw
```

Check the exit code first. Not every freeze failure returns exit 2 with an artifact.
- **Exit `0`: frozen.** The frame and `$M` are written. Continue below.
- **Exit `2`: fatal data error at freeze.** This covers an identity, join or frame-population error. The `invalid`
  artifact is written to `models/diagnostics/lines_screen.json`; no manifest or frame is written. Commit that
  artifact, write the methodology note below, and stop. Do not run `abandon` over it.
- **Any other non-zero exit (a traceback or an exit message): a pre-manifest failure.** Nothing was recorded: no
  manifest and no artifact. The accepted ruling 5 makes a schedule-snapshot hash mismatch (`LinesDataError` from
  `read_snapshot`) end this way on purpose. So does a missing local cache, an existing destination
  (`FileExistsError`), or a failed `snapshot` in step 1. Stop: do not retry, edit or work around it. Record the reason
  through the no-manifest abandonment path below, quoting the exception.

After exit `0`, read `$M`:
- `rows.test_rows` should match 5,893 / 5,920 / 6,095. A mismatch is recorded and reported, not fixed.
- `lines_validation.coverage_matches_claim`.
- `tracked_changes_uncommitted` must be `false`.
- `implementation_commit` must be the reviewed branch head.
- `spec.git_blob` must equal `fd3217b66351c257716a8f0ca97c86dd213a5fea` (the spec astra reviewed).

If `tracked_changes_uncommitted`, `implementation_commit` or `spec.git_blob` is wrong, stop and report. Record that
through abandonment with `--manifest` (below).

```bash
# 3. Commit the manifest BEFORE fitting (the pre-registration record).
#    A successful commit is a prerequisite of step 4, not just the previous
#    command: if it fails, stop. Step 4's checks verify it independently.
git add "$M"
git commit -m "lines screen: freeze run manifest before fitting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"

# 4. Pre-run checks, then run. `run` executes only if every check passes:
#    (a) no tracked changes;
#    (b) the manifest file equals its committed blob (git hash-object applies the
#        same clean filters git add used, so line-ending conversion cannot mask or
#        fake a difference; a missing HEAD:$M blob also fails);
#    (c) the commit(s) between implementation_commit and HEAD change ONLY the
#        manifest. HEAD is expected to differ from implementation_commit (the
#        manifest commit sits on top) -- never test them for equality.
#    The run fits 2 arms x 3 seeds x 3 folds from the frozen frame (~6 min on CPU),
#    draws 10,000 accepted bootstrap replicates, and writes data/lines/paired_rows.parquet
#    (gitignored, sha256 in the artifact) and models/diagnostics/lines_screen.json.
#    The artifact's run block records run_commit (HEAD) and tracked_changes_uncommitted.
IMPL=$($PY -c "import json, sys; print(json.load(open(sys.argv[1], encoding='utf-8'))['implementation_commit'])" "$M")
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  && [ "$(git hash-object "$M")" = "$(git rev-parse --verify --quiet "HEAD:$M")" ] \
  && [ "$(git diff --name-only "$IMPL"..HEAD)" = "$M" ] \
  && echo "pre-run checks OK" \
  && $PY -m ffmodel.eval.lines_screen run
```

If step 4 prints neither `pre-run checks OK` nor a disposition, a check failed and nothing was fitted. Stop and report
which check failed. Do not amend, re-commit or rerun to make the checks pass.

**Effort cap or a stop before a valid artifact (§10).** Record the stop instead of extending. Which form to use depends
on what already exists:
- **An artifact already exists** at `models/diagnostics/lines_screen.json`. This is an `invalid` result from `freeze`
  (exit 2) or from `run`. Do not abandon over it; `abandon` refuses anyway. Preserve it, commit it and report it as
  the outcome.
- **No manifest exists yet.** This is the case before or during `snapshot`/`freeze`, and after a pre-manifest freeze
  failure. Omit `--manifest`:
  `$PY -m ffmodel.eval.lines_screen abandon --reason "effort cap reached (spec §10)"`, or
  `--reason "freeze failed before a manifest existed: <exception>"`.
- **After a successful freeze** (`$M` exists). Include it:
  `$PY -m ffmodel.eval.lines_screen abandon --reason "effort cap reached (spec §10)" --manifest "$M"`.

`abandon` exits `2` after writing the `invalid` artifact. If it is given a `--manifest` path that does not exist, it
writes nothing and says to omit the flag.

5. **Report the outcome either way.** Commit `models/diagnostics/lines_screen.json` with a short `docs/methodology.md`
   paragraph, staged by explicit path. The paragraph always quotes the artifact's `timing_label`, and its wording
   follows the disposition:
   - **`pass`:** "a positive gain whose point estimate is material in an optimistic historical information screen".
     Never "the true gain exceeds 0.05" and never deployable performance. It buys exactly one forward shadow test,
     pre-registered separately (§9). It authorizes no site change. Copy the artifact's
     `consequences.carry_into_forward_preregistration` into that pre-registration verbatim: it carries the ranking
     status whether it is `ranking_veto`, `ranking_not_evaluable` or `ranking_ok`.
   - **`fail` / `below_materiality`:** "below our materiality threshold", in the "What didn't work" section. Never
     "markets contain no useful information".
   - **`fail` / `inconclusive`:** name each failed condition, in "What didn't work".
   - **`invalid`:** "not completed", with the reasons. It is **not** in "What didn't work" and is not evidence that
     lines failed.
   - **Every disposition:** state the ranking status. `ranking_veto` and `ranking_not_evaluable` both forbid
     recommending lines for any ranking product.
   - **Any disposition other than `pass`:** model work returns to maintenance (§1, §10).
   - **The methodology note also states the timing-fit disclosure** (one timing-only arm-B fit before the manifest,
     nothing inspected).
6. **Defects.** A defect found at freeze or after the run is named and fixed. The screen is then repeated under new
   manifest, frame, result and paired-row paths, every one a CLI flag:
   - `freeze --manifest <new> --frame <new> --artifact <new>`;
   - `run --manifest <new> --artifact <new> --paired <new>`, with the step-4 checks run against the new manifest.

   Every earlier manifest and result is kept, including an earlier `invalid` one (§7). `freeze`, `run`, `abandon` and
   `write_json` all refuse to replace an existing evidence file.

## Spec ambiguities resolved in this plan (fixed before any result)

Each of these is a degree of freedom the spec leaves open. Each is fixed by code and a test above, before any result
exists.

1. **Failure label when several conditions fail.**
   - Ruling: a failed valid run whose interval upper bound is `< 0.05` is labelled `below_materiality`, even when other
     conditions also fail. Otherwise it is `inconclusive`. `failed_conditions` always names every failed condition.
   - Pinned by: Task 3 `test_below_materiality_label` and `test_each_condition_failing_in_turn`.
2. **Duplicate-collapse order and the identity scope (§2.1).**
   - Ruling: exact duplicates are compared on the eight raw allowed values before team normalisation. So an `OAK`
     record and an `LV` record of one game are a repeated `game_id`, which is fatal. Identity checks run on every
     payload record, of every game type, before scoping to REG and 2012–2025. So a REG/WC pair sharing a `game_id` is
     fatal.
   - Pinned by: Task 2 `test_legacy_and_current_code_copies_of_one_game_are_fatal_not_collapsed` and
     `test_repeated_game_id_that_is_not_an_exact_duplicate_is_fatal[override4]`.
3. **"Negative implied total" (§2.1).**
   - Ruling: either side's implied total is `< 0`, which means `|m| > T`. An implied total of exactly 0 is valid.
     Precedence is non-finite, then `T ≤ 0`, then negative implied. Arithmetic runs on finite (status) or valid
     (features) rows only, so a jointly infinite quote is a warning-free `missing_quote` (rev 1).
   - Pinned by: Task 2 `test_unusable_quote_gives_nan_for_both_sides`, including its two joint-non-finite cases.
4. **Ranking diagnostics around a constant-prediction cell (§5.4).**
   - Ruling: pooled `R` is null and the status is `ranking_not_evaluable`. That season's `R_by_season` is null, and
     that position's diagnostic is null with a reason. Other positions are still reported. Ranking is computed, and
     reported, even when the point side ends `invalid` for a non-prediction reason.
   - Pinned by: Task 3 `test_finite_constant_prediction_is_not_evaluable_and_point_gate_unchanged` and
     `test_empty_relevant_season_is_invalid_before_any_bootstrap`. Since rev 1 the first test uses a WR + RB frame
     with one constant WR cell in 2023. It asserts that `R_by_season[2023]` and the WR diagnostic are null with the
     stated reason. It also asserts that `R_by_season` for 2024 and 2025 and the RB diagnostic stay finite and
     non-null, and that all 24 cells stay eligible.
5. **Integrity failures at run time.**
   - Ruling: a frozen-frame hash, schema or feature-list mismatch at `run` is treated as a §7 fatal data error. It
     writes an `invalid` artifact without fitting. A schedule-snapshot hash mismatch at `freeze` raises before
     anything is written (nothing was fitted or recorded). That is a pre-manifest failure, so the controller stops and
     records it through the no-manifest `abandon` form ("After the build").
   - Pinned by: Task 4 `test_run_integrity_mismatch_is_invalid_without_fitting`, with four cases (rev 1): frame
     bytes changed (`sha256`), a manifest schema mismatch, and a B and an A feature-list mismatch. Each case asserts
     an `invalid` artifact, no paired rows, and that the predictor factory was never called. Task 2
     `test_read_snapshot_rejects_changed_bytes` pins the snapshot raise.
6. **Relevant-cohort reporting (§5.3).**
   - Ruling: the gate uses the pooled `G_rel` interval from the shared accepted replicates. Per-season `G_rel` values
     are reported as point estimates only. The spec requires no per-season cohort interval, so none is added. (The
     separately required primary `G_S_interval` and `G_seed_interval` families are validated before the gate: see
     revision R2 below.)
   - Pinned by: Task 3 `test_evaluate_end_to_end_on_a_clear_gain`.
7. **Where the bootstrap protocol lives.**
   - Ruling: `run` reads `n_accept`, `max_attempts`, the RNG seed, the seeds and the test seasons from the committed
     manifest, not from code defaults. Overrides exist for tests only and are recorded in the artifact. PCG64, the
     draw algorithm, the percentile method, the estimator and scoring settings, and the thresholds come from the
     reviewed implementation code. The manifest records them but does not execute them, so the binding also requires
     that implementation to stay fixed (checked before `run` by the "After the build" step-4 checks). The production
     manifest keeps 10,000 / 100,000 and the registered seeds and seasons.
   - Pinned by: Task 4 `test_run_takes_seeds_seasons_and_bootstrap_protocol_from_the_manifest` (rev 1). The test
     edits the manifest to seeds `[0, 2]`, test seasons `[2024, 2025]`, RNG seed 7, and 120 / 4,000. It asserts the
     exact fits made (2 arms × seeds {0, 2} × 2 folds), the paired seasons and columns, and the `G_S` / `G_seed`
     keys. It asserts the accepted count and attempt limit. It asserts that `G_interval` equals the RNG-seed-7
     interval and differs from the code-default seed's interval.

## Plan-review revisions (astra, rev 1, 2026-10-12)

astra reviewed this plan at `bfc2e58` (`.review/astra-lines-plan-response.md` in the main checkout) and returned
REVISE. All seven rulings above were accepted. Revision 1 resolves each finding below. It does not change the
registered analysis: estimand, thresholds, population, seeds, seasons, the bootstrap protocol (`PCG64(20261007)`,
10,000 accepted / 100,000 attempts), the ranking consequences and the six pass conditions are all unchanged.

1. **R1 — `freeze` could overwrite a prior manifest or result (Task 4).**
   - Fix: `refuse_existing(manifest_path, artifact_path, frame_path)` runs first in `freeze_screen`, before any
     validation or write. The `freeze` CLI also runs it before it reads the snapshot or caches.
   - `write_json` opens with exclusive create (`"x"`). Every JSON it writes is evidence, so there is no separate
     overwriting writer.
   - The `snapshot` sidecar is also exclusive-create, and `snapshot` refuses an existing sidecar.
   - Rerun guidance: a defect rerun uses new manifest, frame, result and paired-row paths.
   - Pinned by (Task 4):
     - `test_freeze_never_replaces_an_existing_manifest_or_result`, which covers a pre-existing manifest or result ×
       a freeze that would succeed or would write `invalid`;
     - `test_freeze_refuses_before_any_validation`;
     - `test_second_failing_freeze_preserves_the_first_invalid_result`, where the replacement would also be
       `invalid`;
     - `test_second_freeze_with_a_new_frame_path_cannot_replace_the_manifest`;
     - `test_write_json_refuses_replacement_and_leaves_no_partial_file`.
   - Also pinned by Task 2 `test_snapshot_refuses_an_existing_sidecar_and_keeps_its_bytes`.
2. **R2 — interval validity was incomplete (Task 3).**
   - Fix: `validity_reasons` / `decide` require the complete registered families. That means `G_S` and both
     endpoints of `G_S_interval` for every test season, and `G_seed` and both endpoints of `G_seed_interval` for
     every seed. This is on top of `G`, `G_interval`, `G_rel` and `G_rel_interval`. Each offending metric is named.
   - `evaluate` passes its `season_order` and `seeds` as the expected families.
   - Fixtures now carry the full families.
   - Pinned by:
     - `test_undefined_season_or_seed_interval_is_invalid_and_named`: 14 cases of null, NaN, ±inf, null-entry and
       missing-entry, across both interval families and both point families, including astra's
       `G_S_interval[2023] = [NaN, 0.2]` reproduction;
     - `test_absent_interval_family_names_every_registered_entry`;
     - `test_registered_families_come_from_the_caller`;
     - `test_complete_families_are_required_by_the_passing_fixture`.
3. **R3 — cap handling assumed a manifest (After the build).**
   - The abandonment procedure omits `--manifest` until a freeze succeeds and includes it afterwards.
   - An existing `invalid` artifact is preserved and reported, never abandoned over.
   - A snapshot-hash exception or another pre-manifest failure stops the run and is recorded through the
     no-manifest form.
   - The exit-code guidance no longer implies that every freeze failure returns exit 2 with an artifact.
   - `abandon` now checks the artifact first. Given a `--manifest` path that does not exist, it writes nothing and
     says to omit the flag.
   - Pinned by `test_abandon_with_a_manifest_that_does_not_exist_writes_nothing`,
     `test_abandon_never_replaces_an_existing_artifact` and
     `test_abandon_after_a_successful_freeze_carries_the_manifest` (Task 4).
4. **Joint non-finite quote warning (Task 2).**
   - Fix: arithmetic runs on finite or valid rows only, masked first.
   - Pinned by two new cases of `test_unusable_quote_gives_nan_for_both_sides`: total and spread both `inf`, and
     total `inf` with spread `-inf`. Each case runs under `warnings.simplefilter("error")`.
5. **Pre-run controller checks (After the build, step 4).** `run` executes only after all three checks pass, chained
   with `&&`:
   - the tracked files are clean;
   - `git hash-object $M` equals `git rev-parse HEAD:$M`;
   - `git diff --name-only <implementation_commit>..HEAD` is exactly the manifest path. HEAD is never compared for
     equality with `implementation_commit`.

   The chain was exercised in a throwaway `core.autocrlf=true` repository. It stopped on an uncommitted manifest, a
   dirty tracked file and an extra code commit, and passed on a committed CRLF manifest. `run` now records
   `tracked_changes_uncommitted` beside `run_commit`. Pinned by `test_run_records_head_and_dirty_status`, and by the
   `run`-block assertion in `test_run_integrity_mismatch_is_invalid_without_fitting`.
6. **Timing-fit disclosure.** The "Timing" bullet now records the single 2026-10-11 timing-only fit as a disclosure:
   - arm B, seed 0, the baseline config;
   - trained on the dry-run frame's 2012–2024 rows, predicting 2025;
   - only the wall time was printed, and nothing was scored or inspected.

   The "After the build" wording now says the manifest precedes the registered run's fits, not every fit.
7. **Pinning tests strengthened, as astra noted:**
   - the constant-cell test now covers the unaffected seasons and position (ruling 4);
   - the run-integrity test now covers schema and both feature-list mismatches, with no factory call (ruling 5);
   - the manifest-parameters test now varies the seeds, the test seasons and the RNG seed, not only `n_accept`
     (ruling 7).
