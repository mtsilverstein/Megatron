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

**Verified when this plan was written (2026-10-11):** every task's code and tests below were materialised from this
file into the worktree and run.

- **The new and touched test files:** 150 tests pass with `-W error`. Per file: `test_lines_features` 6,
  `test_lines_data` 49, `test_lines_stats` 42, `test_lines_screen` 23, `test_features` 25, `test_xgb` 5.
- **The full suite:** `1425 passed, 2 deselected` (the deselected two are the network `integration` tests; the branch base was `1305 passed`).
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
  accepted replicates with 0 rejections, found 216 eligible ranking cells and finished in 4.4 s. No XGBoost result was
  computed or recorded.
- **Timing:** one real XGBoost arm fit plus predict (2012–24 → 2025) takes about 18 s, so the real run is about
  18 fits, roughly 6 minutes. All of these files were then deleted; only this plan is committed.

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
5. **Re-running over an existing frozen input or result.** The schedule snapshot, the frozen frame, the paired rows
   and the artifact are each written once and refused if they already exist. A defect rerun keeps both results under
   new paths (§7).
   Pinned by `test_snapshot_writes_meta_and_refuses_overwrite` (Task 2), and by
   `test_frozen_frame_hash_schema_and_no_overwrite` and `test_run_reads_frozen_frame_and_writes_strict_artifact`
   (Task 4).

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
    nflreadpy_version, sha256}`. It writes the parquet and the sidecar, and raises `FileExistsError` if the path
    exists.
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
- **The join** checks unmatched rows before key equality, so a null team is reported as unmatched.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_lines_data.py`:

```python
"""Lines loader, validation taxonomy and join (spec 2026-10-11 §2-3, §11).

All synthetic; no network. Quote values are invented round numbers, not
real market data.
"""
import json

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
    ({"total_line": 0.0}, "nonpositive_total"),
    ({"total_line": -40.0}, "nonpositive_total"),
    ({"total_line": 10.0, "spread_line": 14.0}, "negative_implied_total"),
])
def test_unusable_quote_gives_nan_for_both_sides(quote, reason):
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

    Refuses to overwrite an existing snapshot: the input freeze (spec §2) is
    only meaningful if the bytes cannot be silently replaced. Writes a sidecar
    `<stem>.meta.json` with retrieval time (UTC), nflreadpy version, row count
    and the file's sha256, and returns the same dict.
    """
    path = Path(path)
    if path.exists():
        raise FileExistsError(f"{path} already exists; a schedule snapshot is never overwritten")
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
    snapshot_meta_path(path).write_text(json.dumps(meta, indent=2), encoding="utf-8")
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
    with np.errstate(invalid="ignore"):
        negative_implied = finite & (((total + spread) / 2 < 0) | ((total - spread) / 2 < 0))
        nonpositive = finite & (total <= 0)
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
    nan = np.full(len(games), np.nan)
    base = games[["season", "week", "game_id", "quote_status"]].reset_index(drop=True)
    home = base.assign(
        team=games["home_team"].to_numpy(), side="home",
        team_implied_total=np.where(valid, (total + spread) / 2, nan),
        team_expected_margin=np.where(valid, spread, nan),
    )
    away = base.assign(
        team=games["away_team"].to_numpy(), side="away",
        team_implied_total=np.where(valid, (total - spread) / 2, nan),
        team_expected_margin=np.where(valid, -spread, nan),
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
Expected: `49 passed`.

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
  - `decide(point, guard, invalid_reasons)` returns `{"disposition": "pass"|"fail"|"invalid", "failure_label":
    None|"below_materiality"|"inconclusive", "conditions", "failed_conditions", "invalid_reasons"}`. The `point`
    argument needs `G`, `G_interval`, `G_S` and `G_seed`.
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
    paired = make_paired()
    cell = (paired["season"] == 2023) & (paired["week"] == 1)
    paired.loc[cell, pred_col("B", 1)] = 12.0            # finite but constant
    out = evaluate(paired, SEEDS, SEASONS, n_accept=200, max_attempts=2000)
    assert out["ranking"]["status"] == "ranking_not_evaluable"
    assert out["ranking"]["R"] is None
    assert out["ranking"]["constant_prediction_cells"][0]["arms"] == ["B/seed1"]
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
    point = {"G": 0.1, "G_interval": [0.02, 0.18],
             "G_S": {2023: 0.1, 2024: 0.1, 2025: 0.1}, "G_seed": {0: 0.1, 1: 0.1, 2: 0.1}}
    point.update(over)
    return point


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


def decide(point: dict | None, guard: dict | None, invalid_reasons: list[str]) -> dict:
    """Disposition with `invalid` decided first (spec §7), then the six
    conditions on unrounded values (§6), then the scientific failure label."""
    reasons = list(invalid_reasons)
    if not reasons:
        required = {"G": point["G"], "G_interval_lower": point["G_interval"][0],
                    "G_interval_upper": point["G_interval"][1], "G_rel": guard["G_rel"],
                    "G_rel_interval_lower": guard["G_rel_interval"][0],
                    "G_rel_interval_upper": guard["G_rel_interval"][1]}
        required.update({f"G_S[{s}]": v for s, v in point["G_S"].items()})
        required.update({f"G_seed[{s}]": v for s, v in point["G_seed"].items()})
        for name, value in required.items():
            if not _finite(value):
                reasons.append(f"undefined point metric {name}")
    if reasons:
        return {"disposition": "invalid", "failure_label": None, "conditions": None,
                "failed_conditions": None, "invalid_reasons": reasons}
    G_S = list(point["G_S"].values())
    conditions = {
        "materiality": point["G"] >= MATERIALITY,
        "interval_lower_above_0": point["G_interval"][0] > 0,
        "two_seasons_positive": sum(g > 0 for g in G_S) >= 2,
        "no_season_below_floor": all(g >= SEASON_FLOOR for g in G_S),
        "all_seeds_positive": all(g > 0 for g in point["G_seed"].values()),
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
    decision = decide(point, relevant, invalid)
    return {"point": point, "bootstrap": boot_summary, "relevant": relevant,
            "ranking": ranking, "decision": decision,
            "consequences": consequences(decision, ranking)}
```

- [ ] **Step 4: Run to verify pass**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_stats.py`
Expected: `42 passed` (about 2 s).

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
  - `write_json(payload, path)`, which applies `allow_nan=False` after converting NaN to `None`.
  - `invalid_artifact(reasons, manifest, stage)`.
  - `freeze_screen(raw_schedules, features, *, frame_path, manifest_path, artifact_path, provenance, seasons,
    test_seasons, seeds) -> manifest | invalid artifact`.
  - `run_screen(manifest_path, artifact_path, paired_path, *, make_predictor, n_accept=None, max_attempts=None) ->
    artifact`.
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
from ffmodel.eval.lines_stats import ScreenInvalid, pred_col
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


def test_freeze_on_unmatched_join_writes_invalid_and_no_frame(tmp_path):
    features, raw = world_features()
    raw = raw[~((raw["season"] == 2024) & (raw["week"] == 3) & (raw["home_team"] == "MIA"))]
    p = paths(tmp_path)
    out = freeze_screen(raw, features, provenance=PROVENANCE, **p)
    assert out["decision"]["disposition"] == "invalid"
    assert "unmatched player team-week" in out["decision"]["invalid_reasons"][0]
    assert strict_json(p["artifact_path"])["decision"]["disposition"] == "invalid"
    assert not p["frame_path"].exists() and not p["manifest_path"].exists()


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


def test_run_on_tampered_frame_is_invalid_without_fitting(tmp_path):
    manifest, p = frozen(tmp_path)
    frame = pd.read_parquet(p["frame_path"])
    frame.assign(team_implied_total=0.0).to_parquet(p["frame_path"], index=False)

    def never(arm, seed):
        raise AssertionError("must not fit on a tampered frame")

    paired_path = tmp_path / "paired.parquet"
    out = run_screen(p["manifest_path"], p["artifact_path"], paired_path, make_predictor=never)
    assert out["decision"]["disposition"] == "invalid"
    assert "sha256" in out["decision"]["invalid_reasons"][0]
    assert not paired_path.exists()
    assert strict_json(p["artifact_path"])["consequences"]["buys_forward_shadow_test"] is False


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


def test_run_takes_the_bootstrap_protocol_from_the_manifest(tmp_path):
    _, p = frozen(tmp_path)
    manifest = json.loads(p["manifest_path"].read_text(encoding="utf-8"))
    manifest["rng"]["n_accept"] = 120            # a small protocol, so the test stays fast
    p["manifest_path"].write_text(json.dumps(manifest), encoding="utf-8")
    out = run_screen(p["manifest_path"], p["artifact_path"], tmp_path / "paired.parquet",
                     make_predictor=fake())
    assert out["bootstrap"]["accepted"] == 120
    assert out["run"]["n_accept"] == 120 and out["run"]["max_attempts"] == 100_000
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


def write_json(payload: dict, path: Path | str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_jsonable(payload), indent=2, allow_nan=False) + "\n",
                    encoding="utf-8")


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
    fatal data error writes an `invalid` artifact instead and returns it."""
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
    for p in (artifact_path, paired_path):
        if p.exists():
            raise FileExistsError(f"{p} exists; a rerun keeps both results under new paths")
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    n_accept = manifest["rng"]["n_accept"] if n_accept is None else n_accept
    max_attempts = manifest["rng"]["max_attempts"] if max_attempts is None else max_attempts
    started = time.perf_counter()
    run_info = {"started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "run_commit": git_provenance()["implementation_commit"],
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
    manifest = json.loads(args.manifest.read_text(encoding="utf-8")) if args.manifest else None
    if args.artifact.exists():
        raise SystemExit(f"{args.artifact} exists; not overwriting")
    write_json(invalid_artifact([args.reason], manifest, stage="abandon"), args.artifact)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Run to verify pass**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_screen.py`
Expected: `23 passed` (about 8 s).

- [ ] **Step 6: Run every lines test plus the touched existing files**

Run: `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -m pytest -W error -p no:cacheprovider -q tests/test_lines_features.py tests/test_lines_data.py tests/test_lines_stats.py tests/test_lines_screen.py tests/test_features.py tests/test_xgb.py`
Expected: `150 passed`.

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
  Expected: `1425 passed, 2 deselected` (the deselected two are the network `integration` tests; the branch base was `1305 passed`) (about 4 minutes).
- [ ] Confirm the import really resolves into the worktree:
  `PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe -c "import ffmodel; print(ffmodel.__file__)"`
  Expected: a path under `Megatron-lines\src`.
- [ ] Dispatch the final whole-branch review (`opus`) with the spec, this plan and the branch diff against `bcade0c`.

## After the build (controller, owner-gated)

This section is not an implementer task. It runs only after the final review passes, the branch is clean, and the
owner says go. It is the one real experiment run, and it must follow spec §7–§8 exactly: the manifest is frozen and
committed **before any model is fitted**, all fits read only the frozen frame, and nothing is shortened to finish.
The two-working-day cap (§10) includes this.

From the worktree root, in Git Bash:

```bash
export PYTHONPATH=C:/Users/reisu/projects/Megatron-lines/src
PY=C:/Users/reisu/projects/Megatron/.venv/Scripts/python.exe

# 0. Preconditions: on feat/lines-screen, final review passed, no tracked changes.
git status --porcelain --untracked-files=no        # must print nothing

# 1. Snapshot the raw schedule payload ONCE (network; refuses to overwrite).
#    Writes data/lines/schedules_raw_2012_2025.parquet + .meta.json (gitignored).
$PY -m ffmodel.eval.lines_screen snapshot

# 2. Freeze: validate lines, build features from the frozen local caches, join,
#    write data/lines/model_frame_2012_2025.parquet and the manifest. No fitting.
FFMODEL_CACHE_FROZEN=1 $PY -m ffmodel.eval.lines_screen freeze \
    --data-dir C:/Users/reisu/projects/Megatron/data/raw
```

Check the printed line and `models/diagnostics/lines_screen_manifest.json`:
- **Exit code.** Exit `0` means frozen. Exit `2` means a fatal data error: the `invalid` artifact is already written to
  `models/diagnostics/lines_screen.json`. In that case commit that artifact, write the methodology note below, and stop.
- **Recorded fields to read:**
  - `rows.test_rows` should match 5,893 / 5,920 / 6,095. A mismatch is recorded and reported, not fixed.
  - `lines_validation.coverage_matches_claim`.
  - `tracked_changes_uncommitted` must be `false`.
  - `implementation_commit` must be the reviewed branch head.
  - `spec.git_blob` must equal `fd3217b66351c257716a8f0ca97c86dd213a5fea` (the spec astra reviewed). If either
    differs, stop and report.

```bash
# 3. Commit the manifest BEFORE fitting (the pre-registration record).
git add models/diagnostics/lines_screen_manifest.json
git commit -m "lines screen: freeze run manifest before fitting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"

# 4. Run: 2 arms x 3 seeds x 3 folds from the frozen frame (~6 min on CPU),
#    10,000 accepted bootstrap replicates; writes data/lines/paired_rows.parquet
#    (gitignored, sha256 in the artifact) and models/diagnostics/lines_screen.json.
$PY -m ffmodel.eval.lines_screen run
```

If the effort cap is reached at any point before a valid artifact exists, record it instead of extending:
`$PY -m ffmodel.eval.lines_screen abandon --reason "effort cap reached (spec §10)" --manifest models/diagnostics/lines_screen_manifest.json`.

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
6. **Defects.** A defect found after the run is named, fixed, and the run repeated under new artifact and paired paths
   (both CLI paths are flags), keeping both manifests and results (§7).

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
     Precedence is non-finite, then `T ≤ 0`, then negative implied.
   - Pinned by: Task 2 `test_unusable_quote_gives_nan_for_both_sides`.
4. **Ranking diagnostics around a constant-prediction cell (§5.4).**
   - Ruling: pooled `R` is null and the status is `ranking_not_evaluable`. That season's `R_by_season` is null, and
     that position's diagnostic is null with a reason. Other positions are still reported. Ranking is computed, and
     reported, even when the point side ends `invalid` for a non-prediction reason.
   - Pinned by: Task 3 `test_finite_constant_prediction_is_not_evaluable_and_point_gate_unchanged` and
     `test_empty_relevant_season_is_invalid_before_any_bootstrap`.
5. **Integrity failures at run time.**
   - Ruling: a frozen-frame hash, schema or feature-list mismatch at `run` is treated as a §7 fatal data error. It
     writes an `invalid` artifact without fitting. A schedule-snapshot hash mismatch at `freeze` raises before
     anything is written (nothing was fitted or recorded).
   - Pinned by: Task 4 `test_run_on_tampered_frame_is_invalid_without_fitting`.
6. **Relevant-cohort reporting (§5.3).**
   - Ruling: the gate uses the pooled `G_rel` interval from the shared accepted replicates. Per-season `G_rel` values
     are reported as point estimates only. The spec requires no per-season cohort interval, so none is added.
   - Pinned by: Task 3 `test_evaluate_end_to_end_on_a_clear_gain`.
7. **Where the bootstrap protocol lives.**
   - Ruling: `run` reads `n_accept`, `max_attempts`, the RNG seed, the seeds and the test seasons from the committed
     manifest, not from code defaults. Overrides exist for tests only and are recorded in the artifact.
   - Pinned by: Task 4 `test_run_takes_the_bootstrap_protocol_from_the_manifest`.
