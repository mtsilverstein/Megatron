# Feature Pack v2 (Local Half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three leak-free model inputs — air-yards share, team pass volume, indoor/roof flag — through the data pull, feature builder, versioned transformer feature sets, and v2 training configs, without changing anything the deployed v1 pipeline produces.

**Architecture:** Pull keeps three new nflverse columns (`attempts`, `receiving_air_yards`, `passing_air_yards`) and `roof`, with cache-prefix bumps so stale caches self-heal. `features.py` computes the three features with existing leak-free idioms (share-of-team, shifted-then-rolled, schedule-merged), conditionally on source columns so pre-v2 frames still build. `dataset.py` gains a versioned `FEATURE_SETS` registry; configs select `feature_set: v2`; artifacts self-describe their feature lists in `metrics.json`; the predictor resolves lists per-artifact (missing keys → v1 constants) so deployed v1 artifacts predict byte-identically.

**Tech Stack:** Python, pandas, PyTorch, pytest, yaml. No new dependencies.

## Global Constraints

- Run tests as: `PYTHONPATH=src python -m pytest tests/ -x -q` (suite runs with `-W error`; any warning is a failure).
- `models/backtests/` is SCHEMA-LOCKED — never write there. Diagnostics go to `models/diagnostics/` (not needed in this plan).
- Do NOT touch `site/` — nothing deploys from this plan.
- Do NOT touch `models/transformer/v1*` artifacts or `models/checkpoints/`.
- v2 configs mirror v1 byte-for-byte except `run_name` and `feature_set` (spec: "no new sweep"). Exact v1 values: `seed: 42`, `seq_len: 16`, `first_season: 2012`, `quantiles: [0.1, 0.5, 0.9]`, model `{d_model: 96, n_heads: 4, n_layers: 3, dropout: 0.1}`, train `{batch_size: 256, lr: 1.0e-3, weight_decay: 0.01, epochs: 60, patience: 8, grad_clip: 1.0, amp: true}`, `out_root: models/transformer`, `checkpoint_root: models/checkpoints`.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Branch: `feat/feature-pack-v2` off `main`.

---

### Task 1: Pull layer — v2 source columns, roof, cache-prefix bumps

**Files:**
- Modify: `src/ffmodel/data/pull.py`
- Test: `tests/test_pull.py`

**Interfaces:**
- Consumes: existing `normalize_weekly`, `pull_weekly`, `pull_schedules`, `_cached`, `_cache_name`.
- Produces: module constant `V2_SOURCE_COLUMNS = ["attempts", "receiving_air_yards", "passing_air_yards"]` (exact name, exact order — Task 2's `future.py` imports it); `normalize_weekly` output containing those three columns (NaN→0); `pull_schedules` output containing `roof`; cache prefixes `weekly_v2` and `schedules_v3`.

**Context you need:** `pull_weekly` currently caches the *normalized* frame under prefix `weekly`; `pull_schedules` caches under `schedules_v2` and there is an existing test `test_pull_schedules_includes_completion_columns_and_uses_v2_cache` pinning that prefix — you will update that test. nflverse `player_stats` raw columns include `attempts` (pass attempts), `receiving_air_yards`, `passing_air_yards`; schedules include `roof` with values `outdoors`/`dome`/`closed` (verified empirically 2026-07-21).

- [ ] **Step 1: Update `_raw_row` fixture and write failing tests**

In `tests/test_pull.py`, add to the `_raw_row` base dict (after `"completions": 0, "attempts": 0,` line — `attempts` already exists; add the two air-yards keys next to it):

```python
        "passing_air_yards": 0.0, "receiving_air_yards": 0.0,
```

Append these tests to `tests/test_pull.py`:

```python
def test_normalize_weekly_retains_v2_source_columns():
    from ffmodel.data.pull import V2_SOURCE_COLUMNS

    assert V2_SOURCE_COLUMNS == ["attempts", "receiving_air_yards",
                                 "passing_air_yards"]
    raw = pd.DataFrame([_raw_row(attempts=34, receiving_air_yards=88.0,
                                 passing_air_yards=310.0)])
    out = normalize_weekly(raw)
    assert out["attempts"].iloc[0] == 34
    assert out["receiving_air_yards"].iloc[0] == pytest.approx(88.0)
    assert out["passing_air_yards"].iloc[0] == pytest.approx(310.0)


def test_normalize_weekly_v2_columns_nan_filled_to_zero():
    import numpy as np

    raw = pd.DataFrame([_raw_row(attempts=np.nan, receiving_air_yards=np.nan,
                                 passing_air_yards=np.nan)])
    out = normalize_weekly(raw)
    for col in ("attempts", "receiving_air_yards", "passing_air_yards"):
        assert out[col].iloc[0] == 0, col


def test_pull_weekly_uses_v2_prefix_and_ignores_stale_v1_cache(tmp_path, monkeypatch):
    """Pin: pull_weekly caches under 'weekly_v2' so a pre-v2 local cache
    (no air-yards/attempts columns) is never silently reused."""
    import sys

    from ffmodel.data.pull import V2_SOURCE_COLUMNS, _cache_name, pull_weekly

    raw = pd.DataFrame([_raw_row()])

    class _Result:
        def __init__(self, frame):
            self._frame = frame

        def to_pandas(self):
            return self._frame

    class _FakeNflreadpy:
        @staticmethod
        def load_player_stats(seasons):
            return _Result(raw)

        @staticmethod
        def load_snap_counts(seasons):
            return _Result(pd.DataFrame(columns=[
                "pfr_player_id", "season", "week", "offense_pct", "game_type"]))

        @staticmethod
        def load_players():
            return _Result(pd.DataFrame([{"pfr_id": "x", "gsis_id": "y"}]))

    monkeypatch.setitem(sys.modules, "nflreadpy", _FakeNflreadpy())

    # Stale cache under the OLD "weekly" prefix: must be ignored, not read.
    stale = normalize_weekly(pd.DataFrame([_raw_row()])).drop(
        columns=V2_SOURCE_COLUMNS)
    stale.to_parquet(tmp_path / f"{_cache_name('weekly', [2023])}.parquet",
                     index=False)

    out = pull_weekly([2023], cache_dir=tmp_path)
    for col in V2_SOURCE_COLUMNS:
        assert col in out.columns, col
    assert (tmp_path / f"{_cache_name('weekly_v2', [2023])}.parquet").exists()


def test_pull_weekly_rejects_cache_missing_v2_columns(tmp_path):
    """The v2-column guard runs on EVERY read path: a weekly_v2 cache that
    somehow lacks the columns (hand-written, corrupt) fails loudly instead
    of silently producing v1-only features. No network stub on purpose --
    the guard must fire on the cached frame before any other loader runs."""
    from ffmodel.data.pull import V2_SOURCE_COLUMNS, _cache_name, pull_weekly

    bad = normalize_weekly(pd.DataFrame([_raw_row()])).drop(
        columns=V2_SOURCE_COLUMNS)
    bad.to_parquet(tmp_path / f"{_cache_name('weekly_v2', [2023])}.parquet",
                   index=False)
    with pytest.raises(ValueError, match="receiving_air_yards"):
        pull_weekly([2023], cache_dir=tmp_path)
```

Then MODIFY the existing `test_pull_schedules_includes_completion_columns_and_uses_v2_cache`: rename it to `test_pull_schedules_includes_roof_and_uses_v3_cache`, add `"roof": ["dome", "outdoors"]` to its `raw` frame dict, change the stale-cache prefix from `'schedules'` to `'schedules_v2'` (the previously-current prefix, now stale), change the asserted new-cache prefix from `'schedules_v2'` to `'schedules_v3'`, and add these assertions before the cache-file check:

```python
    assert "roof" in out.columns
    assert out.loc[out["home_team"] == "KC", "roof"].iloc[0] == "dome"
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `PYTHONPATH=src python -m pytest tests/test_pull.py -x -q`
Expected: FAIL — `ImportError: cannot import name 'V2_SOURCE_COLUMNS'` on the first new test.

- [ ] **Step 3: Implement in `src/ffmodel/data/pull.py`**

Add the constant directly below `CONTEXT_COLUMNS`:

```python
# Feature-pack-v2 source columns kept through normalization: attempts is
# PASS attempts (team pass volume); receiving_air_yards feeds air_share;
# passing_air_yards is retained for the QB air-volume path. Counting
# stats, so NaN -> 0 like PREDICTED_STATS.
V2_SOURCE_COLUMNS = ["attempts", "receiving_air_yards", "passing_air_yards"]
```

In `normalize_weekly`, change the `keep` list and `stat_cols`:

```python
    keep = (
        CONTEXT_COLUMNS + PREDICTED_STATS + SCORING_EXTRAS + V2_SOURCE_COLUMNS
        + ["target_share", "fantasy_points_ppr"]
    )
    df = df[keep].copy()
    stat_cols = PREDICTED_STATS + SCORING_EXTRAS + V2_SOURCE_COLUMNS
```

In `pull_weekly`, bump the prefix and add the guard **immediately after** the weekly `_cached` call (before the snaps/players loads, so a bad cache fails before any other loader can run):

```python
    # Prefix bumped to weekly_v2 for the feature-pack-v2 source columns: a
    # local cache written before they existed must never be silently reused.
    weekly = _cached(cache_dir, _cache_name("weekly_v2", seasons), load)
    missing = [c for c in V2_SOURCE_COLUMNS if c not in weekly.columns]
    if missing:
        raise ValueError(
            f"weekly cache is missing v2 source column(s) {missing} — delete "
            f"the weekly_v2 parquet under the cache dir and re-pull"
        )
```

In `pull_schedules`, add `"roof"` to `keep` and bump the prefix:

```python
        keep = ["season", "week", "gameday", "home_team", "away_team",
                "home_score", "away_score", "roof"]
```

and change the cached call to `_cache_name("schedules_v3", seasons)`. Extend the existing prefix comment with one line: `# v3 bump: adds the roof column (feature-pack v2 is_indoor).`

- [ ] **Step 4: Run the full suite**

Run: `PYTHONPATH=src python -m pytest tests/ -x -q`
Expected: PASS (integration-marked tests are skipped by default; nothing else imports the dropped raw columns).

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/data/pull.py tests/test_pull.py
git commit -m "feat: pull retains v2 source columns (air yards, attempts, roof)

Cache prefixes bumped (weekly_v2, schedules_v3) so pre-v2 local caches
self-heal; v2-column guard runs on every weekly read path.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Features — air_share, team_pass_att_last4, is_indoor (+ future rows)

**Files:**
- Modify: `src/ffmodel/data/features.py`
- Modify: `src/ffmodel/data/future.py`
- Test: `tests/test_features.py`, `tests/test_future.py`

**Interfaces:**
- Consumes: `V2_SOURCE_COLUMNS` from `ffmodel.data.pull` (Task 1); weekly frames containing `attempts`, `receiving_air_yards` (or legitimately lacking them — pre-v2 fixtures).
- Produces: feature columns named exactly `air_share` (raw, per-game), `lag4_air_share`, `lag8_air_share`, `team_pass_att_last4`, `is_indoor` — Task 3's `SEQ_FEATURES_V2`/`CTX_FEATURES_V2` reference these names verbatim. `CONTEXT_FEATURES` gains `"is_indoor"`. `feature_columns` gains `team_pass_att_last4` in its guarded `extra` block. New module constant `OPTIONAL_LAG_STATS = ["air_share"]`.

**Design rule (from spec):** v2 feature computation is *conditional* on source columns (`receiving_air_yards` → air_share; `attempts` → team_pass_att_last4) so pre-v2 frames and fixtures still build; `is_indoor` is *always* computed (missing `roof` column or unknown value → 0). Only stats listed in `OPTIONAL_LAG_STATS` may be skipped by the lag loop — a typo in `LAG_STATS` must still fail loudly.

- [ ] **Step 1: Update fixtures and write failing tests in `tests/test_features.py`**

In `make_weekly`'s `base` dict, add (next to the existing stat defaults):

```python
        "attempts": 0.0, "receiving_air_yards": 0.0, "passing_air_yards": 0.0,
```

In `make_schedules`, add an optional roof parameter:

```python
def make_schedules(weeks: int = 6, season: int = 2023,
                   roof: str | None = None) -> pd.DataFrame:
    days = pd.date_range(f"{season}-09-10", periods=weeks, freq="7D")
    sched = pd.DataFrame({
        "season": season, "week": range(1, weeks + 1),
        "gameday": days.strftime("%Y-%m-%d"),
        "home_team": "AAA", "away_team": "BBB",
    })
    if roof is not None:
        sched["roof"] = roof
    return sched
```

Extend the existing `test_feature_columns_never_include_same_week_stats` with two lines at the end:

```python
    assert not {"air_share", "attempts", "receiving_air_yards",
                "passing_air_yards"} & set(cols)
    assert "team_pass_att_last4" in cols and "is_indoor" in cols
```

Append these tests:

```python
def test_air_share_is_share_of_team_air_yards():
    weekly = make_weekly([
        {"player_id": "p1", "receiving_air_yards": 75.0},
        {"player_id": "p2", "receiving_air_yards": 25.0},
    ])
    out = build_features(weekly, make_schedules())
    assert out[out["player_id"] == "p1"]["air_share"].iloc[0] == pytest.approx(0.75)
    assert out[out["player_id"] == "p2"]["air_share"].iloc[0] == pytest.approx(0.25)


def test_air_share_zero_team_air_yards_is_nan():
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    assert np.isnan(out["air_share"].iloc[0])


def test_air_share_lagged_not_same_week_in_feature_columns():
    weekly = make_weekly([
        {"week": 1, "receiving_air_yards": 80.0},
        {"week": 2, "receiving_air_yards": 20.0},
    ])
    out = build_features(weekly, make_schedules())
    cols = feature_columns(out)
    assert "lag4_air_share" in cols and "lag8_air_share" in cols
    assert "air_share" not in cols
    wk2 = out[out["week"] == 2].iloc[0]
    assert wk2["lag4_air_share"] == pytest.approx(1.0)  # sole receiver week 1


def test_team_pass_volume_uses_only_prior_weeks():
    weekly = make_weekly([
        {"player_id": "qb", "position": "QB", "week": 1, "attempts": 30.0},
        {"player_id": "qb", "position": "QB", "week": 2, "attempts": 40.0},
        {"player_id": "qb", "position": "QB", "week": 3, "attempts": 99.0},
    ])
    out = build_features(weekly, make_schedules())
    assert np.isnan(out[out["week"] == 1]["team_pass_att_last4"].iloc[0])
    assert out[out["week"] == 2]["team_pass_att_last4"].iloc[0] == pytest.approx(30.0)
    # the current week's 99 must not leak into week 3's own feature value
    assert out[out["week"] == 3]["team_pass_att_last4"].iloc[0] == pytest.approx(35.0)


def test_team_pass_volume_sums_across_team_players():
    weekly = make_weekly([
        {"player_id": "qb1", "position": "QB", "week": 1, "attempts": 20.0},
        {"player_id": "qb2", "position": "QB", "week": 1, "attempts": 10.0},
        {"player_id": "qb1", "position": "QB", "week": 2},
    ])
    out = build_features(weekly, make_schedules())
    assert out[out["week"] == 2]["team_pass_att_last4"].iloc[0] == pytest.approx(30.0)


def test_is_indoor_roof_values():
    weekly = make_weekly([{"week": 1}])
    for roof, expected in (("dome", 1), ("closed", 1), ("outdoors", 0),
                           ("open", 0)):
        out = build_features(weekly, make_schedules(roof=roof))
        assert out["is_indoor"].iloc[0] == expected, roof


def test_is_indoor_defaults_to_zero_without_roof_column():
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    assert out["is_indoor"].iloc[0] == 0
    assert "is_indoor" in feature_columns(out)


def test_build_features_without_v2_source_columns_still_builds():
    """Pre-v2 frames (fixtures, old exports) must still build v1 features:
    v2 stat features are conditional on their source columns, never a hard
    requirement. is_indoor is schedule-derived and always present."""
    weekly = make_weekly([{"week": 1}, {"week": 2}]).drop(
        columns=["attempts", "receiving_air_yards", "passing_air_yards"])
    out = build_features(weekly, make_schedules())
    cols = feature_columns(out)
    assert "lag4_air_share" not in cols
    assert "team_pass_att_last4" not in cols
    assert "is_indoor" in cols
    assert "lag4_receiving_yards" in out.columns
```

- [ ] **Step 2: Write the failing future-row test in `tests/test_future.py`**

Append (note `make_schedules` is already imported from `tests.test_features` at the top of the file):

```python
def test_future_week_inherits_team_pass_volume_and_roof():
    """The unplayed target week gets team_pass_att_last4 from prior weeks
    (shift-then-roll frontier, like opp_allowed) and is_indoor from the
    schedule; its own v2 source columns are NaN like every stat."""
    rows = []
    for week in range(1, 7):
        rows.append({"player_id": "p1", "week": week, "attempts": 30.0 + week})
        rows.append({"player_id": "p2", "week": week, "position": "RB",
                     "team": "BBB", "opponent_team": "AAA"})
    weekly = make_weekly(rows)
    sched = make_schedules(8, roof="dome")
    future = build_future_features(weekly, sched, season=2023, week=7)
    p1 = future[future["player_id"] == "p1"].iloc[0]
    # AAA attempts weeks 3-6: mean(33, 34, 35, 36) = 34.5; week 7 is unplayed
    assert p1["team_pass_att_last4"] == pytest.approx(34.5)
    assert p1["is_indoor"] == 1
    assert np.isnan(p1["attempts"])
    assert np.isnan(p1["receiving_air_yards"])
```

- [ ] **Step 3: Run to verify failures**

Run: `PYTHONPATH=src python -m pytest tests/test_features.py tests/test_future.py -x -q`
Expected: FAIL — `KeyError: 'air_share'` (or missing-column assertion) on the first new test.

- [ ] **Step 4: Implement `src/ffmodel/data/features.py`**

Change the module constants:

```python
LAG_STATS = PREDICTED_STATS + ["target_share", "carry_share", "ppr_points", "snap_pct"]
# v2 lag stats are computed (and lagged) only when their source columns
# exist in the weekly frame, so pre-v2 frames/fixtures still build. Only
# stats listed here may be skipped -- a typo in LAG_STATS still fails loud.
OPTIONAL_LAG_STATS = ["air_share"]
LAG_WINDOWS = (4, 8)
CONTEXT_FEATURES = ["games_prior", "is_home", "rest_days", "week", "is_indoor"]
```

Change `build_features`:

```python
def build_features(weekly: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    df = weekly.sort_values(["player_id", "season", "week"]).reset_index(drop=True)
    df["ppr_points"] = fantasy_points(df, PPR)
    df = _add_carry_share(df)
    if "receiving_air_yards" in df.columns:
        df = _add_air_share(df)
    df = _add_player_lags(df)
    df = _add_schedule_context(df, schedules)
    df = _add_opponent_allowed(df)
    if "attempts" in df.columns:
        df = _add_team_pass_volume(df)
    df = _add_position_dummies(df)
    return df
```

Change `feature_columns`'s `extra` line:

```python
    extra = [c for c in ("opp_allowed_last4", "opp_allowed_season",
                         "team_pass_att_last4") if c in df.columns]
```

Add `_add_air_share` directly below `_add_carry_share` (same idiom):

```python
def _add_air_share(df: pd.DataFrame) -> pd.DataFrame:
    team_air = df.groupby(["team", "season", "week"])["receiving_air_yards"].transform("sum")
    df["air_share"] = df["receiving_air_yards"] / team_air.replace(0, np.nan)
    return df
```

In `_add_player_lags`, change the loop header (one line):

```python
    for stat in LAG_STATS + [s for s in OPTIONAL_LAG_STATS if s in df.columns]:
```

In `_add_schedule_context`, add `is_indoor` handling. After `sched["gameday"] = pd.to_datetime(sched["gameday"])` insert:

```python
    # Roof is known from the schedule before kickoff, so the CURRENT week's
    # value is a legitimate context feature (like is_home). Missing column
    # or unrecognized value -> 0 (treated as outdoors).
    if "roof" in sched.columns:
        sched["is_indoor"] = sched["roof"].isin(["dome", "closed"]).astype(int)
    else:
        sched["is_indoor"] = 0
```

Change the sides `part` selection to carry it:

```python
        part = sched.rename(columns={side: "team"})[
            ["season", "week", "team", "gameday", "is_indoor"]]
```

Change the merge column list to include it, and fill after the merge:

```python
    merged = df.merge(
        team_games[["season", "week", "team", "is_home", "rest_days", "is_indoor"]],
        on=["season", "week", "team"], how="left",
    )
    merged["rest_days"] = merged["rest_days"].fillna(7).astype(int)
    merged["is_home"] = merged["is_home"].fillna(0).astype(int)
    merged["is_indoor"] = merged["is_indoor"].fillna(0).astype(int)
    return merged
```

Add `_add_team_pass_volume` directly below `_add_opponent_allowed` (same shifted-then-rolled idiom; grouping by team only spans season boundaries, matching the "last N games" convention used by opp_allowed_last4):

```python
def _add_team_pass_volume(df: pd.DataFrame) -> pd.DataFrame:
    team = (
        df.groupby(["team", "season", "week"], as_index=False)["attempts"].sum()
        .sort_values(["team", "season", "week"])
        .reset_index(drop=True)
    )
    shifted = team.groupby("team", sort=False)["attempts"].shift(1)
    team["team_pass_att_last4"] = (
        shifted.groupby(team["team"])
        .rolling(4, min_periods=1)
        .mean()
        .reset_index(level=0, drop=True)
    )
    return df.merge(
        team[["team", "season", "week", "team_pass_att_last4"]],
        on=["team", "season", "week"], how="left",
    )
```

- [ ] **Step 5: Implement `src/ffmodel/data/future.py`**

Change the pull import and skeleton NaN handling so skeleton rows mirror the weekly frame's schema (a pre-v2 weekly frame must not gain v2 columns from the skeleton):

```python
from ffmodel.data.pull import CONTEXT_COLUMNS, V2_SOURCE_COLUMNS
```

`_NAN_COLUMNS` stays as-is. In `future_skeleton`, replace the final NaN-fill block:

```python
    nan_cols = _NAN_COLUMNS + [c for c in V2_SOURCE_COLUMNS
                               if c in weekly.columns]
    for col in nan_cols:
        rows[col] = np.nan
    return rows[CONTEXT_COLUMNS + nan_cols].reset_index(drop=True)
```

- [ ] **Step 6: Run the full suite**

Run: `PYTHONPATH=src python -m pytest tests/ -x -q`
Expected: PASS. Note: `tests/test_dataset.py`, `tests/test_train.py`, `tests/test_harness.py` reuse `make_weekly` — they now build frames containing the new columns, which the v1 `SEQ_FEATURES`/`CTX_FEATURES` constants simply ignore. If anything fails, it is a real regression — investigate, don't loosen the test.

- [ ] **Step 7: Commit**

```bash
git add src/ffmodel/data/features.py src/ffmodel/data/future.py tests/test_features.py tests/test_future.py
git commit -m "feat: air_share, team_pass_att_last4, is_indoor features (leak-free)

Conditional on source columns so pre-v2 frames still build; is_indoor
always present (roof-missing -> 0). Future skeleton mirrors weekly schema.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Versioned feature sets — dataset registry, config-driven training, artifact-driven inference

**Files:**
- Modify: `src/ffmodel/model/dataset.py`
- Modify: `src/ffmodel/model/train.py`
- Modify: `src/ffmodel/model/predictor.py`
- Test: `tests/test_dataset.py`, `tests/test_train.py`, `tests/test_predictor.py`

**Interfaces:**
- Consumes: feature column names from Task 2 (`air_share`, `team_pass_att_last4`, `is_indoor`).
- Produces: `SEQ_FEATURES_V2`, `CTX_FEATURES_V2`, `FEATURE_SETS` dict in `dataset.py`; `build_sequences(features, seq_len=16, min_history=1, seq_features=None, ctx_features=None)` (None → v1 constants); `_resolve_feature_set(cfg) -> (name, seq_list, ctx_list)` in `train.py`; `metrics.json` keys `feature_set`, `seq_features`, `ctx_features`; predictor that resolves feature lists from each artifact's metrics (missing → v1 constants). Task 4's configs rely on the `feature_set: v2` config key.

**Hard requirement:** deployed v1 artifacts (metrics.json WITHOUT the new keys) must predict byte-identically. The default path through every changed function must be a true no-op.

- [ ] **Step 1: Write failing tests in `tests/test_dataset.py`**

Append:

```python
def test_feature_set_registry_pins_v2_lists():
    from ffmodel.model.dataset import (
        CTX_FEATURES_V2, FEATURE_SETS, SEQ_FEATURES_V2,
    )

    assert FEATURE_SETS["v1"] == (SEQ_FEATURES, CTX_FEATURES)
    assert SEQ_FEATURES_V2 == SEQ_FEATURES + ["air_share"]
    assert CTX_FEATURES_V2 == CTX_FEATURES + ["team_pass_att_last4", "is_indoor"]
    assert FEATURE_SETS["v2"] == (SEQ_FEATURES_V2, CTX_FEATURES_V2)


def test_build_sequences_with_v2_lists_and_v1_default():
    from ffmodel.model.dataset import CTX_FEATURES_V2, SEQ_FEATURES_V2

    features = _features()
    v2 = build_sequences(features, seq_len=4, min_history=1,
                         seq_features=SEQ_FEATURES_V2,
                         ctx_features=CTX_FEATURES_V2)
    assert v2.x_seq.shape == (5, 4, len(SEQ_FEATURES_V2))
    assert v2.x_ctx.shape == (5, len(CTX_FEATURES_V2))
    v1 = build_sequences(features, seq_len=4, min_history=1)
    assert v1.x_seq.shape == (5, 4, len(SEQ_FEATURES))
    assert v1.x_ctx.shape == (5, len(CTX_FEATURES))
```

- [ ] **Step 2: Write failing tests in `tests/test_train.py`**

Append:

```python
def test_feature_set_v2_trains_and_records_lists(tmp_path):
    from ffmodel.model.dataset import CTX_FEATURES_V2, SEQ_FEATURES_V2, Scaler

    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=1)
    cfg["feature_set"] = "v2"
    art = train_from_config(cfg, features)
    metrics = json.loads((art / "metrics.json").read_text())
    assert metrics["feature_set"] == "v2"
    assert metrics["seq_features"] == SEQ_FEATURES_V2
    assert metrics["ctx_features"] == CTX_FEATURES_V2
    assert metrics["n_seq_features"] == len(SEQ_FEATURES_V2)
    assert metrics["n_ctx_features"] == len(CTX_FEATURES_V2)
    scaler = Scaler.load(art / "scaler.json")
    assert scaler.seq_mean.shape == (len(SEQ_FEATURES_V2),)
    assert scaler.ctx_mean.shape == (len(CTX_FEATURES_V2),)


def test_default_config_records_v1_feature_set(tmp_path):
    from ffmodel.model.dataset import CTX_FEATURES, SEQ_FEATURES

    features = _synthetic_features()
    art = train_from_config(_cfg(tmp_path, epochs=1), features)
    metrics = json.loads((art / "metrics.json").read_text())
    assert metrics["feature_set"] == "v1"
    assert metrics["seq_features"] == SEQ_FEATURES
    assert metrics["ctx_features"] == CTX_FEATURES


def test_unknown_feature_set_raises_before_touching_artifacts(tmp_path):
    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=1)
    cfg["feature_set"] = "v99"
    with pytest.raises(ValueError, match="v99"):
        train_from_config(cfg, features)
```

- [ ] **Step 3: Write failing tests in `tests/test_predictor.py`**

Append (module already imports `json`, `pd`, `np`, `pytest`, `TransformerPredictor`, `train_from_config`, `_cfg`, `_synthetic_features`):

```python
def test_pre_v2_artifact_without_feature_lists_defaults_to_v1(tmp_path):
    """Deployed v1 artifacts predate the metrics.json feature lists.
    Stripping the new keys must reproduce EXACTLY the same predictions --
    the default path is the frozen v1 constants."""
    features = _synthetic_features(seasons=(2020, 2021, 2022))
    test_features = _synthetic_features(seasons=(2020, 2021, 2022, 2023))
    art = train_from_config(_cfg(tmp_path, epochs=1), features)
    train = test_features[test_features["season"] <= 2022]
    test = test_features[test_features["season"] == 2023]

    p = TransformerPredictor(art.parent, test_features, calibration=False)
    p.fit(train)
    baseline = p.predict_quantiles(test)

    metrics = json.loads((art / "metrics.json").read_text())
    for key in ("feature_set", "seq_features", "ctx_features"):
        metrics.pop(key, None)
    (art / "metrics.json").write_text(json.dumps(metrics))

    p2 = TransformerPredictor(art.parent, test_features, calibration=False)
    p2.fit(train)
    stripped = p2.predict_quantiles(test)
    for key in ("p10", "p50", "p90"):
        pd.testing.assert_frame_equal(baseline[key], stripped[key])


def test_v2_artifact_predicts_with_v2_inputs(tmp_path):
    features = _synthetic_features(seasons=(2020, 2021, 2022))
    test_features = _synthetic_features(seasons=(2020, 2021, 2022, 2023))
    cfg = _cfg(tmp_path, epochs=1)
    cfg["feature_set"] = "v2"
    art = train_from_config(cfg, features)

    p = TransformerPredictor(art.parent, test_features, calibration=False)
    train = test_features[test_features["season"] <= 2022]
    test = test_features[test_features["season"] == 2023]
    p.fit(train)
    qs = p.predict_quantiles(test)
    assert list(qs["p50"].columns) == PREDICTED_STATS
    assert np.isfinite(qs["p50"].to_numpy()).all()


def test_inconsistent_artifact_feature_lists_raise(tmp_path):
    features = _synthetic_features(seasons=(2020, 2021, 2022))
    art = train_from_config(_cfg(tmp_path, epochs=1), features)
    metrics = json.loads((art / "metrics.json").read_text())
    metrics["seq_features"] = metrics["seq_features"][:-1]  # disagrees with n_seq_features
    (art / "metrics.json").write_text(json.dumps(metrics))

    p = TransformerPredictor(art.parent, features, calibration=False)
    with pytest.raises(ValueError, match="disagree"):
        p.fit(features[features["season"] <= 2022])
```

- [ ] **Step 4: Run to verify failures**

Run: `PYTHONPATH=src python -m pytest tests/test_dataset.py tests/test_train.py tests/test_predictor.py -x -q`
Expected: FAIL — `ImportError: cannot import name 'CTX_FEATURES_V2'`.

- [ ] **Step 5: Implement `src/ffmodel/model/dataset.py`**

Below the existing `CTX_FEATURES` definition add:

```python
# Feature-pack v2: per-game air-yards share rides in the sequence (the
# transformer's history mechanism); pass-volume and roof are target-week
# context. The v1 constants above stay FROZEN -- deployed v1 artifacts
# (metrics.json without explicit feature lists) resolve to them.
SEQ_FEATURES_V2 = SEQ_FEATURES + ["air_share"]
CTX_FEATURES_V2 = CTX_FEATURES + ["team_pass_att_last4", "is_indoor"]
# Registry keyed by the training config's `feature_set` (default "v1").
FEATURE_SETS = {
    "v1": (SEQ_FEATURES, CTX_FEATURES),
    "v2": (SEQ_FEATURES_V2, CTX_FEATURES_V2),
}
```

Change `build_sequences` to accept explicit lists (None → v1 constants, so every existing call is a true no-op):

```python
def build_sequences(
    features: pd.DataFrame, seq_len: int = 16, min_history: int = 1,
    seq_features: list[str] | None = None, ctx_features: list[str] | None = None,
) -> SequenceData:
    seq_features = SEQ_FEATURES if seq_features is None else list(seq_features)
    ctx_features = CTX_FEATURES if ctx_features is None else list(ctx_features)
    df = features.sort_values(["player_id", "season", "week"]).reset_index(names="row_id")
    seq_vals = df[seq_features].to_numpy(dtype=np.float32)
    n = len(df)
    x_seq = np.zeros((n, seq_len, len(seq_features)), dtype=np.float32)
```

and in the return, `df[CTX_FEATURES]` becomes `df[ctx_features]`. No other body changes.

- [ ] **Step 6: Implement `src/ffmodel/model/train.py`**

Change the dataset import line to:

```python
from ffmodel.model.dataset import (
    FEATURE_SETS, apply_scaler, build_sequences, fit_scaler, subset,
)
```

Add below `_loader`:

```python
def _resolve_feature_set(cfg: dict) -> tuple[str, list[str], list[str]]:
    """cfg['feature_set'] names an entry in dataset.FEATURE_SETS (default
    'v1', so every pre-v2 config trains byte-identically). The resolved
    lists drive sequence building, model input dims, and the artifact's
    metrics.json, from which inference reconstructs the exact inputs."""
    name = cfg.get("feature_set", "v1")
    if name not in FEATURE_SETS:
        raise ValueError(
            f"unknown feature_set {name!r} (known: {sorted(FEATURE_SETS)})")
    seq_features, ctx_features = FEATURE_SETS[name]
    return name, list(seq_features), list(ctx_features)
```

In `_prepare_data`, resolve and pass the lists:

```python
    _, seq_features, ctx_features = _resolve_feature_set(cfg)
    raw = build_sequences(window, cfg["seq_len"],
                          seq_features=seq_features, ctx_features=ctx_features)
```

In `train_from_config`, add as the FIRST line of the function body (fail fast on a bad config before any skip/delete logic can act):

```python
    feature_set, seq_features, ctx_features = _resolve_feature_set(cfg)
```

Change the model construction to use the resolved lists:

```python
    model = QuantileTransformer(
        n_seq_features=len(seq_features), n_ctx_features=len(ctx_features),
        max_seq_len=cfg["seq_len"], n_stats=len(PREDICTED_STATS),
        n_quantiles=len(quantiles), **cfg["model"],
    ).to(device)
```

Change the metrics.json write to record the resolved set:

```python
            (art_dir / "metrics.json").write_text(json.dumps({
                "val_season": val_season, "best_epoch": epoch,
                "last_epoch": epoch, "val_pinball": val_loss,
                "quantiles": list(quantiles), "seq_len": cfg["seq_len"],
                "n_seq_features": len(seq_features),
                "n_ctx_features": len(ctx_features), "model": cfg["model"],
                "feature_set": feature_set,
                "seq_features": seq_features, "ctx_features": ctx_features,
                "complete": False,  # only the post-loop write below marks completion
            }, indent=2))
```

- [ ] **Step 7: Implement `src/ffmodel/model/predictor.py`**

Change the dataset import to:

```python
from ffmodel.model.dataset import (
    CTX_FEATURES, SEQ_FEATURES, Scaler, apply_scaler, build_sequences,
)
```

In `_SingleRootTransformer.fit`, after `self._quantiles = metrics["quantiles"]` add:

```python
        # Feature lists are resolved from the ARTIFACT, not module globals:
        # pre-v2 artifacts lack the keys and get the frozen v1 constants,
        # so their predictions are byte-identical to before this existed.
        self._seq_features = metrics.get("seq_features", SEQ_FEATURES)
        self._ctx_features = metrics.get("ctx_features", CTX_FEATURES)
        if (len(self._seq_features) != metrics["n_seq_features"]
                or len(self._ctx_features) != metrics["n_ctx_features"]):
            raise ValueError(
                f"{art}: feature lists in metrics.json disagree with the "
                f"recorded n_seq_features/n_ctx_features — artifact is "
                f"inconsistent"
            )
```

In `predict_quantiles`, pass them:

```python
        data = apply_scaler(
            build_sequences(self.features, self._seq_len, min_history=0,
                            seq_features=self._seq_features,
                            ctx_features=self._ctx_features),
            self._scaler,
        )
```

- [ ] **Step 8: Run the full suite**

Run: `PYTHONPATH=src python -m pytest tests/ -x -q`
Expected: PASS. The existing `test_val_sequences_span_prior_seasons` calls `_prepare_data(_cfg(tmp_path), features)` — it must pass unchanged (no `feature_set` key → v1 default).

- [ ] **Step 9: Commit**

```bash
git add src/ffmodel/model/dataset.py src/ffmodel/model/train.py src/ffmodel/model/predictor.py tests/test_dataset.py tests/test_train.py tests/test_predictor.py
git commit -m "feat: versioned transformer feature sets (v1 frozen, v2 adds pack)

Configs select feature_set; artifacts self-describe their lists in
metrics.json; predictor resolves per-artifact with v1 default, so
deployed v1 artifacts predict byte-identically.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: v2 training configs + mirror-invariant test

**Files:**
- Create: `configs/transformer_v2.yaml`, `configs/transformer_v2_through2022.yaml`, `configs/transformer_v2_through2023.yaml`, `configs/transformer_v2_through2024.yaml`
- Test: `tests/test_configs.py` (new file)

**Interfaces:**
- Consumes: the `feature_set: v2` config key from Task 3.
- Produces: the four configs the user will pass to `python -m ffmodel.model.train --config ... [--seed 43|44]` on Kaggle.

- [ ] **Step 1: Write the failing test — `tests/test_configs.py` (new file)**

```python
"""Pins the feature-pack-v2 experimental control: every v2 config mirrors
its v1 counterpart byte-for-byte except run_name and feature_set -- the
experiment isolates FEATURES, not tuning (spec 2026-07-21, 'no new sweep')."""
from pathlib import Path

import yaml


def _by_stem(pattern):
    return {p.stem: p for p in Path("configs").glob(pattern)}


def test_v2_config_exists_for_every_v1_fold():
    v1 = _by_stem("transformer_v1*.yaml")
    v2 = _by_stem("transformer_v2*.yaml")
    assert set(v2) == {name.replace("v1", "v2") for name in v1}


def test_v2_mirrors_v1_except_run_name_and_feature_set():
    v1 = _by_stem("transformer_v1*.yaml")
    for name, path in _by_stem("transformer_v2*.yaml").items():
        cfg2 = yaml.safe_load(path.read_text())
        cfg1 = yaml.safe_load(v1[name.replace("v2", "v1")].read_text())
        assert cfg2.pop("feature_set") == "v2", name
        assert cfg2.pop("run_name") == "v2", name
        assert cfg1.pop("run_name") == "v1", name
        assert "feature_set" not in cfg1, name  # v1 configs stay pre-v2
        assert cfg2 == cfg1, name  # every remaining key equal, incl. val_season
```

- [ ] **Step 2: Run to verify it fails**

Run: `PYTHONPATH=src python -m pytest tests/test_configs.py -x -q`
Expected: FAIL — the `set(v2) == ...` assertion (no v2 configs exist yet).

- [ ] **Step 3: Create the four configs**

`configs/transformer_v2.yaml`:

```yaml
run_name: v2
seed: 42
seq_len: 16
val_season: 2025
first_season: 2012
feature_set: v2
quantiles: [0.1, 0.5, 0.9]
model:
  d_model: 96
  n_heads: 4
  n_layers: 3
  dropout: 0.1
train:
  batch_size: 256
  lr: 1.0e-3
  weight_decay: 0.01
  epochs: 60
  patience: 8
  grad_clip: 1.0
  amp: true
out_root: models/transformer
checkpoint_root: models/checkpoints
```

`configs/transformer_v2_through2022.yaml`, `_through2023.yaml`, `_through2024.yaml`: identical content except `val_season: 2022` / `2023` / `2024` respectively. Before writing them, read each `transformer_v1_through*.yaml` and copy it exactly, changing only `run_name: v1` → `run_name: v2` and inserting `feature_set: v2` after `first_season` — do not retype from memory.

- [ ] **Step 4: Run the full suite**

Run: `PYTHONPATH=src python -m pytest tests/ -x -q`
Expected: PASS.

- [ ] **Step 5: Check the training notebook for hardcoded config paths**

Run: `grep -o "transformer_v[0-9][a-z0-9_]*\.yaml" notebooks/train_studio_lab.ipynb | sort -u`
Report what you find in your task report. Do NOT edit the notebook — the user drives Kaggle training and will pass v2 config paths themselves; the report just tells them whether the notebook needs a path swap.

- [ ] **Step 6: Commit**

```bash
git add configs/transformer_v2.yaml configs/transformer_v2_through2022.yaml configs/transformer_v2_through2023.yaml configs/transformer_v2_through2024.yaml tests/test_configs.py
git commit -m "feat: v2 training configs — v1 mirror + feature_set, test-pinned

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## After the tasks (not part of subagent work)

- Final whole-branch review (opus), then merge `feat/feature-pack-v2` → `main`, push.
- Nothing deploys: the weekly Actions pipeline keeps using v1 artifacts (their metrics.json resolves v1 feature lists). The next Actions run will do a fresh pull under the new prefixes — column availability for 2026 is already covered by the existing fail-safe.
- Handoff to user for Kaggle: 4 configs × 3 seeds (default + `--seed 43` + `--seed 44`) = 12 runs; skip-if-complete makes them resumable across sessions. Then the eval/calibration/gate session (Opus high) applies the pre-registered promotion gate.
