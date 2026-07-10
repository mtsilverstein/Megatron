# Plan 1: Data Pipeline, Scoring, Eval Harness & Baselines — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested Python package that pulls nflverse weekly NFL data, builds leak-free features, scores stat lines under PPR/half/standard rules, and reports walk-forward backtest results for two baselines (naive last-4 average, XGBoost).

**Architecture:** src-layout package `ffmodel` (spec §3). All network access is isolated in `ffmodel/data/pull.py`; features are pure pandas transforms; the eval harness runs any object satisfying a small `Predictor` protocol through identical walk-forward splits. This plan is CPU-only and local — it is the "July" milestone of spec §12 and the foundation Plans 2 (transformer) and 3 (site/automation) build on.

**Tech Stack:** Python ≥3.10, pandas, pyarrow, nflreadpy (polars → pandas at the pull boundary), xgboost + scikit-learn, pytest.

**Spec:** `docs/superpowers/specs/2026-07-09-fantasy-football-model-design.md` — read it first.

## Global Constraints

- Free tiers only; no paid infrastructure of any kind.
- Models predict **raw stat lines**, never fantasy points directly; points come from pure scoring functions. PPR is the display/eval default.
- **Walk-forward evaluation only**: train on seasons < S, test on season S; held-out test seasons 2023, 2024, 2025. Never a random split.
- Every feature for a (player, week) row uses only games strictly before that week — leak-freedom is test-enforced.
- Positions QB/RB/WR/TE only; regular-season games only; seasons 2012–2025.
- Data source is `nflreadpy` (NOT the deprecated `nfl_data_py`). Raw column names verified against the nflverse data dictionary on 2026-07-09: `passing_interceptions` (not `interceptions`), `carries`, `sacks_suffered`, `player_display_name`, `team`, `opponent_team`, `fantasy_points_ppr`, etc.
- Seeded determinism; no logic that lives only in a notebook.
- `data/` is gitignored (pulled/cached parquet); `models/` artifacts ARE committed.
- Integration tests that hit the network are marked `@pytest.mark.integration` and excluded from the default pytest run.

---

### Task 1: Package scaffolding + scoring module

The stat-line column contract and scoring math. Scaffolding (pyproject, gitignore) folds in here because this is the first deliverable that needs it.

**Files:**
- Create: `pyproject.toml`
- Create: `.gitignore`
- Create: `src/ffmodel/__init__.py`
- Create: `src/ffmodel/scoring.py`
- Test: `tests/test_scoring.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `PREDICTED_STATS: list[str]` (11 stat names, fixed order), `SCORING_EXTRAS: list[str]`, `ScoringRules` dataclass, presets `PPR`, `HALF_PPR`, `STANDARD`, and `fantasy_points(stats: pd.DataFrame, rules: ScoringRules = PPR) -> pd.Series` (missing columns count as 0). Every later task imports from `ffmodel.scoring`.

- [ ] **Step 1: Write scaffolding**

`pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "ffmodel"
version = "0.1.0"
description = "Fantasy football projection model: quantile transformer vs. baselines"
requires-python = ">=3.10"
dependencies = [
    "nflreadpy>=0.1",
    "pandas>=2.0",
    "pyarrow>=14",
    "xgboost>=2.0",
    "scikit-learn>=1.3",
]

[project.optional-dependencies]
dev = ["pytest>=8"]

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
testpaths = ["tests"]
markers = ["integration: hits the network for real nflverse data"]
addopts = "-m 'not integration'"
```

`.gitignore`:

```
__pycache__/
*.egg-info/
.pytest_cache/
.venv/
data/
```

`src/ffmodel/__init__.py`: empty file.
`tests/__init__.py`: empty file (tests import shared fixtures from each other as `tests.test_features`; the package marker makes pytest put the repo root on `sys.path`).

Then install: `pip install -e ".[dev]"`

- [ ] **Step 2: Write the failing tests**

`tests/test_scoring.py`:

```python
import pandas as pd
import pytest

from ffmodel.scoring import HALF_PPR, PPR, PREDICTED_STATS, STANDARD, fantasy_points


def test_predicted_stats_contract():
    assert PREDICTED_STATS == [
        "passing_yards", "passing_tds", "passing_interceptions",
        "carries", "rushing_yards", "rushing_tds",
        "targets", "receptions", "receiving_yards", "receiving_tds",
        "fumbles_lost",
    ]


def test_ppr_receiver_line():
    # 6 rec, 84 yds, 1 TD, 1 fumble lost: 6*1 + 8.4 + 6 - 2 = 18.4
    df = pd.DataFrame([{"receptions": 6, "receiving_yards": 84, "receiving_tds": 1, "fumbles_lost": 1}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(18.4)


def test_reception_value_across_rulesets():
    df = pd.DataFrame([{"receptions": 10}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(10.0)
    assert fantasy_points(df, HALF_PPR).iloc[0] == pytest.approx(5.0)
    assert fantasy_points(df, STANDARD).iloc[0] == pytest.approx(0.0)


def test_qb_line_with_two_point_and_int():
    # 300 pass yds, 2 TD, 1 INT, 1 two-point: 12 + 8 - 2 + 2 = 20
    df = pd.DataFrame([{
        "passing_yards": 300, "passing_tds": 2, "passing_interceptions": 1,
        "two_point_conversions": 1,
    }])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(20.0)


def test_missing_columns_count_as_zero():
    df = pd.DataFrame([{"rushing_yards": 50}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(5.0)


def test_carries_and_targets_do_not_score():
    df = pd.DataFrame([{"carries": 20, "targets": 12}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(0.0)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pytest tests/test_scoring.py -v`
Expected: FAIL — `ModuleNotFoundError` / `ImportError` (scoring module doesn't exist).

- [ ] **Step 4: Write the implementation**

`src/ffmodel/scoring.py`:

```python
"""Stat-line -> fantasy-points scoring. The stat-line column contract lives here."""
from dataclasses import dataclass

import pandas as pd

# The stat components every model predicts, in fixed order (model output
# heads and label columns follow this order everywhere).
PREDICTED_STATS = [
    "passing_yards", "passing_tds", "passing_interceptions",
    "carries", "rushing_yards", "rushing_tds",
    "targets", "receptions", "receiving_yards", "receiving_tds",
    "fumbles_lost",
]

# Columns that affect scoring but are not predicted; present on actuals so
# our points match official totals, absent (-> 0) on model output.
SCORING_EXTRAS = ["two_point_conversions", "special_teams_tds"]


@dataclass(frozen=True)
class ScoringRules:
    name: str
    pass_yd: float = 0.04
    pass_td: float = 4.0
    interception: float = -2.0
    rush_yd: float = 0.1
    rush_td: float = 6.0
    rec_yd: float = 0.1
    rec_td: float = 6.0
    reception: float = 1.0
    fumble_lost: float = -2.0
    two_point: float = 2.0
    st_td: float = 6.0


PPR = ScoringRules(name="ppr", reception=1.0)
HALF_PPR = ScoringRules(name="half_ppr", reception=0.5)
STANDARD = ScoringRules(name="standard", reception=0.0)


def fantasy_points(stats: pd.DataFrame, rules: ScoringRules = PPR) -> pd.Series:
    """Score a stat-line frame. Missing columns count as zero."""

    def col(name: str) -> pd.Series:
        if name in stats.columns:
            return stats[name].fillna(0)
        return pd.Series(0.0, index=stats.index)

    return (
        col("passing_yards") * rules.pass_yd
        + col("passing_tds") * rules.pass_td
        + col("passing_interceptions") * rules.interception
        + col("rushing_yards") * rules.rush_yd
        + col("rushing_tds") * rules.rush_td
        + col("receiving_yards") * rules.rec_yd
        + col("receiving_tds") * rules.rec_td
        + col("receptions") * rules.reception
        + col("fumbles_lost") * rules.fumble_lost
        + col("two_point_conversions") * rules.two_point
        + col("special_teams_tds") * rules.st_td
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/test_scoring.py -v`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml .gitignore src/ffmodel/__init__.py src/ffmodel/scoring.py tests/__init__.py tests/test_scoring.py
git commit -m "feat: package scaffolding and stat-line scoring module"
```

---

### Task 2: Data pull module

All network access for the project. Normalizes raw nflverse frames to the canonical schema and caches parquet locally.

**Files:**
- Create: `src/ffmodel/data/__init__.py`
- Create: `src/ffmodel/data/pull.py`
- Test: `tests/test_pull.py`

**Interfaces:**
- Consumes: `PREDICTED_STATS`, `SCORING_EXTRAS`, `PPR`, `fantasy_points` from `ffmodel.scoring`.
- Produces:
  - `normalize_weekly(raw: pd.DataFrame) -> pd.DataFrame` — pure transform (testable offline).
  - `pull_weekly(seasons: list[int], cache_dir: Path | None = None) -> pd.DataFrame` — canonical weekly frame: columns `player_id, player_display_name, position, team, opponent_team, season, week` + `PREDICTED_STATS` + `SCORING_EXTRAS` + `target_share` + `fantasy_points_ppr`.
  - `pull_schedules(seasons: list[int], cache_dir: Path | None = None) -> pd.DataFrame` — columns `season, week, gameday, home_team, away_team`, regular season only.
  - `POSITIONS = ["QB", "RB", "WR", "TE"]`.
  - CLI: `python -m ffmodel.data.pull --seasons 2012 2025 --out data/raw`.

- [ ] **Step 1: Write the failing unit tests (offline, synthetic raw frame)**

`tests/test_pull.py`:

```python
import pandas as pd
import pytest

from ffmodel.data.pull import POSITIONS, normalize_weekly
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points


def _raw_row(**overrides):
    row = {
        "player_id": "00-001", "player_display_name": "Test Player",
        "position": "WR", "position_group": "WR",
        "season": 2023, "week": 1, "season_type": "REG",
        "team": "KC", "opponent_team": "DET",
        "completions": 0, "attempts": 0, "passing_yards": 0.0, "passing_tds": 0,
        "passing_interceptions": 0, "sack_fumbles_lost": 0,
        "passing_2pt_conversions": 0,
        "carries": 0, "rushing_yards": 0.0, "rushing_tds": 0,
        "rushing_fumbles_lost": 0, "rushing_2pt_conversions": 0,
        "receptions": 0, "targets": 0, "receiving_yards": 0.0, "receiving_tds": 0,
        "receiving_fumbles_lost": 0, "receiving_2pt_conversions": 0,
        "special_teams_tds": 0, "target_share": 0.1,
        "fantasy_points_ppr": 0.0,
    }
    row.update(overrides)
    return row


def test_filters_positions_and_season_type():
    raw = pd.DataFrame([
        _raw_row(position_group="WR"),
        _raw_row(position_group="K"),
        _raw_row(position_group="WR", season_type="POST"),
    ])
    out = normalize_weekly(raw)
    assert len(out) == 1
    assert set(out["position"]).issubset(set(POSITIONS))


def test_sums_fumbles_and_two_point_conversions():
    raw = pd.DataFrame([_raw_row(
        rushing_fumbles_lost=1, receiving_fumbles_lost=1, sack_fumbles_lost=1,
        passing_2pt_conversions=1, receiving_2pt_conversions=1,
    )])
    out = normalize_weekly(raw)
    assert out["fumbles_lost"].iloc[0] == 3
    assert out["two_point_conversions"].iloc[0] == 2


def test_canonical_columns_present():
    out = normalize_weekly(pd.DataFrame([_raw_row()]))
    for col in PREDICTED_STATS + ["player_id", "position", "team", "opponent_team",
                                  "season", "week", "target_share", "fantasy_points_ppr"]:
        assert col in out.columns, col


@pytest.mark.integration
def test_pull_real_season_and_scoring_matches_nflverse(tmp_path):
    from ffmodel.data.pull import pull_weekly

    df = pull_weekly([2023], cache_dir=tmp_path)
    assert len(df) > 4000          # ~5-6k QB/RB/WR/TE player-weeks per season
    assert df["week"].nunique() >= 17
    # Our PPR scoring must reproduce nflverse's official fantasy_points_ppr.
    diff = (fantasy_points(df, PPR) - df["fantasy_points_ppr"]).abs()
    assert (diff < 0.01).mean() > 0.98
    # Cache round-trip: second call must not hit the network (delete nflreadpy
    # from sys.modules is overkill; just assert the parquet file now exists).
    assert any(tmp_path.glob("*.parquet"))
```

- [ ] **Step 2: Run unit tests to verify they fail**

Run: `pytest tests/test_pull.py -v`
Expected: FAIL — `ModuleNotFoundError: ffmodel.data`.

- [ ] **Step 3: Write the implementation**

`src/ffmodel/data/__init__.py`: empty file.

`src/ffmodel/data/pull.py`:

```python
"""nflverse data pulls. All network access for the project lives here."""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from ffmodel.scoring import PREDICTED_STATS, SCORING_EXTRAS

POSITIONS = ["QB", "RB", "WR", "TE"]

CONTEXT_COLUMNS = [
    "player_id", "player_display_name", "position", "team", "opponent_team",
    "season", "week",
]

# Canonical columns derived by summing raw nflverse columns.
_RAW_SUMS = {
    "fumbles_lost": [
        "rushing_fumbles_lost", "receiving_fumbles_lost", "sack_fumbles_lost",
    ],
    "two_point_conversions": [
        "passing_2pt_conversions", "rushing_2pt_conversions",
        "receiving_2pt_conversions",
    ],
}


def normalize_weekly(raw: pd.DataFrame) -> pd.DataFrame:
    """Reduce a raw nflverse player-stats frame to the canonical schema."""
    df = raw[(raw["season_type"] == "REG") & raw["position_group"].isin(POSITIONS)].copy()
    df["position"] = df["position_group"]
    for out, parts in _RAW_SUMS.items():
        df[out] = sum(df[p].fillna(0) for p in parts)
    keep = (
        CONTEXT_COLUMNS + PREDICTED_STATS + SCORING_EXTRAS
        + ["target_share", "fantasy_points_ppr"]
    )
    df = df[keep].copy()
    stat_cols = PREDICTED_STATS + SCORING_EXTRAS
    df[stat_cols] = df[stat_cols].fillna(0)
    return df.sort_values(["player_id", "season", "week"]).reset_index(drop=True)


def _cached(cache_dir: Path | None, name: str, loader) -> pd.DataFrame:
    if cache_dir is not None:
        path = Path(cache_dir) / f"{name}.parquet"
        if path.exists():
            return pd.read_parquet(path)
    df = loader()
    if cache_dir is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(path, index=False)
    return df


def pull_weekly(seasons: list[int], cache_dir: Path | None = None) -> pd.DataFrame:
    def load() -> pd.DataFrame:
        import nflreadpy  # deferred: keep offline unit tests import-light

        raw = nflreadpy.load_player_stats(seasons).to_pandas()
        return normalize_weekly(raw)

    return _cached(cache_dir, f"weekly_{min(seasons)}_{max(seasons)}", load)


def pull_schedules(seasons: list[int], cache_dir: Path | None = None) -> pd.DataFrame:
    def load() -> pd.DataFrame:
        import nflreadpy

        raw = nflreadpy.load_schedules(seasons).to_pandas()
        raw = raw[raw["game_type"] == "REG"]
        keep = ["season", "week", "gameday", "home_team", "away_team"]
        return raw[keep].reset_index(drop=True)

    return _cached(cache_dir, f"schedules_{min(seasons)}_{max(seasons)}", load)


def main() -> None:
    parser = argparse.ArgumentParser(description="Pull and cache nflverse data.")
    parser.add_argument("--seasons", nargs=2, type=int, default=[2012, 2025],
                        metavar=("FIRST", "LAST"))
    parser.add_argument("--out", type=Path, default=Path("data/raw"))
    args = parser.parse_args()
    seasons = list(range(args.seasons[0], args.seasons[1] + 1))
    weekly = pull_weekly(seasons, cache_dir=args.out)
    sched = pull_schedules(seasons, cache_dir=args.out)
    print(f"weekly: {len(weekly):,} rows, schedules: {len(sched):,} rows -> {args.out}")


if __name__ == "__main__":
    main()
```

Note the `path` variable in `_cached` is only bound when `cache_dir` is not None — both uses are guarded by the same condition, but if you touch this function, keep them paired.

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `pytest tests/test_pull.py -v`
Expected: 3 passed, 1 deselected (integration).

- [ ] **Step 5: Run the integration test (network)**

Run: `pytest tests/test_pull.py -m integration -v`
Expected: 1 passed. If the scoring cross-check assertion fails, print `diff.describe()` and inspect which stat the mismatch traces to before changing anything — the scoring rules in Task 1 are the project contract; a mismatch means a column is being dropped or misnamed in `normalize_weekly`, not that the rules are wrong.

- [ ] **Step 6: Pull the full dataset once and sanity-check volume**

Run: `python -m ffmodel.data.pull --seasons 2012 2025 --out data/raw`
Expected: prints roughly `weekly: 70,000-90,000 rows, schedules: 3,500-3,800 rows`. The parquet files land in `data/raw/` (gitignored).

- [ ] **Step 7: Commit**

```bash
git add src/ffmodel/data/ tests/test_pull.py
git commit -m "feat: nflreadpy pull module with caching and canonical schema"
```

---

### Task 3: Player-history features (lags, usage, schedule context)

First half of the feature builder: everything derived from the player's own past games plus schedule context. Leak-freedom is the point of every test here.

**Files:**
- Create: `src/ffmodel/data/features.py`
- Test: `tests/test_features.py`

**Interfaces:**
- Consumes: `PREDICTED_STATS`, `PPR`, `fantasy_points` from `ffmodel.scoring`; canonical weekly/schedules frames from Task 2.
- Produces (consumed by Task 4, baselines, and Plan 2):
  - `build_features(weekly: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame` — one row per (player, season, week); adds all feature columns, keeps label columns (`PREDICTED_STATS`) untouched.
  - Feature columns added in this task: `ppr_points` (that week's actual, used as a *label/lag source*, never a feature directly), `carry_share`, `lag4_{stat}` / `lag8_{stat}` for every stat in `LAG_STATS`, `games_prior`, `is_home`, `rest_days`, `pos_QB`/`pos_RB`/`pos_WR`/`pos_TE`.
  - `LAG_STATS = PREDICTED_STATS + ["target_share", "carry_share", "ppr_points"]`
  - `feature_columns(df: pd.DataFrame) -> list[str]` — the model-input column list (lag columns + context + position dummies; NEVER same-week stats).

- [ ] **Step 1: Write the failing tests**

`tests/test_features.py`:

```python
import numpy as np
import pandas as pd
import pytest

from ffmodel.data.features import build_features, feature_columns
from ffmodel.scoring import PREDICTED_STATS


def make_weekly(rows: list[dict]) -> pd.DataFrame:
    """Synthetic canonical weekly frame; unspecified stats are zero."""
    base = {
        "player_id": "p1", "player_display_name": "P One", "position": "WR",
        "team": "AAA", "opponent_team": "BBB", "season": 2023, "week": 1,
        "target_share": np.nan, "fantasy_points_ppr": 0.0,
        "two_point_conversions": 0, "special_teams_tds": 0,
        **{s: 0.0 for s in PREDICTED_STATS},
    }
    return pd.DataFrame([{**base, **r} for r in rows])


def make_schedules(weeks: int = 6, season: int = 2023) -> pd.DataFrame:
    days = pd.date_range(f"{season}-09-10", periods=weeks, freq="7D")
    return pd.DataFrame({
        "season": season, "week": range(1, weeks + 1),
        "gameday": days.strftime("%Y-%m-%d"),
        "home_team": "AAA", "away_team": "BBB",
    })


def test_lag_features_use_only_prior_weeks():
    weekly = make_weekly([
        {"week": 1, "receiving_yards": 100.0},
        {"week": 2, "receiving_yards": 50.0},
        {"week": 3, "receiving_yards": 80.0},
    ])
    out = build_features(weekly, make_schedules())
    wk3 = out[out["week"] == 3].iloc[0]
    assert wk3["lag4_receiving_yards"] == pytest.approx(75.0)  # mean(100, 50)
    assert wk3["receiving_yards"] == pytest.approx(80.0)       # label untouched


def test_first_game_has_nan_lags_and_zero_games_prior():
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    row = out.iloc[0]
    assert np.isnan(row["lag4_receiving_yards"])
    assert row["games_prior"] == 0


def test_lags_span_season_boundaries():
    weekly = make_weekly([
        {"season": 2022, "week": 18, "receiving_yards": 60.0},
        {"season": 2023, "week": 1, "receiving_yards": 0.0},
    ])
    sched = pd.concat([make_schedules(18, 2022), make_schedules(6, 2023)])
    out = build_features(weekly, sched)
    wk1_2023 = out[(out["season"] == 2023) & (out["week"] == 1)].iloc[0]
    assert wk1_2023["lag4_receiving_yards"] == pytest.approx(60.0)


def test_carry_share():
    weekly = make_weekly([
        {"player_id": "p1", "carries": 15.0},
        {"player_id": "p2", "carries": 5.0},
    ])
    out = build_features(weekly, make_schedules())
    assert out[out["player_id"] == "p1"]["carry_share"].iloc[0] == pytest.approx(0.75)


def test_home_and_rest_days():
    weekly = make_weekly([{"week": 1}, {"week": 2}])
    out = build_features(weekly, make_schedules())
    assert out[out["week"] == 1]["is_home"].iloc[0] == 1     # AAA hosts every game
    assert out[out["week"] == 1]["rest_days"].iloc[0] == 7   # unknown -> default 7
    assert out[out["week"] == 2]["rest_days"].iloc[0] == 7   # 7-day gap


def test_feature_columns_never_include_same_week_stats():
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    cols = feature_columns(out)
    assert not set(cols) & set(PREDICTED_STATS)
    assert "ppr_points" not in cols
    assert "fantasy_points_ppr" not in cols
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_features.py -v`
Expected: FAIL — `ModuleNotFoundError: ffmodel.data.features`.

- [ ] **Step 3: Write the implementation**

`src/ffmodel/data/features.py`:

```python
"""Leak-free feature building.

Every feature attached to a (player, week) row is computed from games
strictly before that week. Same-week stat columns remain in the frame as
labels only; `feature_columns` is the single source of truth for what a
model may consume.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

LAG_STATS = PREDICTED_STATS + ["target_share", "carry_share", "ppr_points"]
LAG_WINDOWS = (4, 8)
CONTEXT_FEATURES = ["games_prior", "is_home", "rest_days", "week"]


def build_features(weekly: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    df = weekly.sort_values(["player_id", "season", "week"]).reset_index(drop=True).copy()
    df["ppr_points"] = fantasy_points(df, PPR)
    df = _add_carry_share(df)
    df = _add_player_lags(df)
    df = _add_schedule_context(df, schedules)
    df = _add_position_dummies(df)
    return df


def feature_columns(df: pd.DataFrame) -> list[str]:
    lag_cols = [c for c in df.columns if c.startswith(("lag4_", "lag8_"))]
    pos_cols = [c for c in df.columns if c.startswith("pos_")]
    extra = [c for c in ("opp_allowed_last4", "opp_allowed_season") if c in df.columns]
    return lag_cols + CONTEXT_FEATURES + extra + pos_cols


def _add_carry_share(df: pd.DataFrame) -> pd.DataFrame:
    team_carries = df.groupby(["team", "season", "week"])["carries"].transform("sum")
    df["carry_share"] = df["carries"] / team_carries.replace(0, np.nan)
    return df


def _add_player_lags(df: pd.DataFrame) -> pd.DataFrame:
    # df is sorted by (player_id, season, week); "last N games played"
    # deliberately spans season boundaries (spec §4).
    grouped = df.groupby("player_id", sort=False)
    for stat in LAG_STATS:
        shifted = grouped[stat].shift(1)  # exclude the current game
        for window in LAG_WINDOWS:
            df[f"lag{window}_{stat}"] = (
                shifted.groupby(df["player_id"])
                .rolling(window, min_periods=1)
                .mean()
                .reset_index(level=0, drop=True)
            )
    df["games_prior"] = grouped.cumcount()
    return df


def _add_schedule_context(df: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    sched = schedules.copy()
    sched["gameday"] = pd.to_datetime(sched["gameday"])
    sides = []
    for side, flag in (("home_team", 1), ("away_team", 0)):
        part = sched.rename(columns={side: "team"})[["season", "week", "team", "gameday"]]
        sides.append(part.assign(is_home=flag))
    team_games = pd.concat(sides, ignore_index=True).sort_values(["team", "gameday"])
    team_games["rest_days"] = (
        team_games.groupby("team")["gameday"].diff().dt.days
        .clip(4, 14)          # season gaps collapse to "long rest"
        .fillna(7)
        .astype(int)
    )
    merged = df.merge(
        team_games[["season", "week", "team", "is_home", "rest_days"]],
        on=["season", "week", "team"], how="left",
    )
    merged["rest_days"] = merged["rest_days"].fillna(7).astype(int)
    merged["is_home"] = merged["is_home"].fillna(0).astype(int)
    return merged


def _add_position_dummies(df: pd.DataFrame) -> pd.DataFrame:
    for pos in ("QB", "RB", "WR", "TE"):
        df[f"pos_{pos}"] = (df["position"] == pos).astype(int)
    return df
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_features.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/data/features.py tests/test_features.py
git commit -m "feat: leak-free player lag and schedule-context features"
```

---

### Task 4: Opponent-allowed features

Second half of the feature builder: how many PPR points each defense has allowed to each position, computed only from prior weeks.

**Files:**
- Modify: `src/ffmodel/data/features.py` (add `_add_opponent_allowed`, call it from `build_features` after `_add_schedule_context`)
- Test: `tests/test_features.py` (append tests)

**Interfaces:**
- Consumes: Task 3's `build_features` internals.
- Produces: two new columns on the feature frame — `opp_allowed_last4` and `opp_allowed_season` (PPR points the current opponent allowed to the player's position: rolling last-4-games mean and season-to-date mean, both excluding the current week). `feature_columns` already picks them up (Task 3 wrote the hook).

- [ ] **Step 1: Write the failing tests (append to `tests/test_features.py`)**

```python
def test_opponent_allowed_uses_only_prior_weeks():
    # Two WRs face defense BBB in weeks 1-3; BBB allowed 10 then 30 PPR pts.
    weekly = make_weekly([
        {"player_id": "p1", "week": 1, "receiving_yards": 100.0},  # 10 pts
        {"player_id": "p1", "week": 2, "receiving_yards": 300.0},  # 30 pts
        {"player_id": "p1", "week": 3, "receiving_yards": 0.0},
    ])
    out = build_features(weekly, make_schedules())
    wk2 = out[out["week"] == 2].iloc[0]
    wk3 = out[out["week"] == 3].iloc[0]
    assert wk2["opp_allowed_last4"] == pytest.approx(10.0)
    assert wk3["opp_allowed_last4"] == pytest.approx(20.0)   # mean(10, 30)
    assert wk3["opp_allowed_season"] == pytest.approx(20.0)


def test_opponent_allowed_is_position_specific():
    weekly = make_weekly([
        {"player_id": "wr", "position": "WR", "week": 1, "receiving_yards": 100.0},
        {"player_id": "rb", "position": "RB", "week": 1, "rushing_yards": 200.0},
        {"player_id": "wr", "position": "WR", "week": 2},
    ])
    out = build_features(weekly, make_schedules())
    wk2 = out[(out["week"] == 2) & (out["player_id"] == "wr")].iloc[0]
    assert wk2["opp_allowed_last4"] == pytest.approx(10.0)   # WR pts only, not RB's 20


def test_opponent_allowed_nan_when_no_history():
    out = build_features(make_weekly([{"week": 1}]), make_schedules())
    assert np.isnan(out["opp_allowed_last4"].iloc[0])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_features.py -v`
Expected: 3 new tests FAIL with `KeyError: 'opp_allowed_last4'`; the 7 existing tests still pass.

- [ ] **Step 3: Write the implementation**

Append to `src/ffmodel/data/features.py`, and add `df = _add_opponent_allowed(df)` in `build_features` between `_add_schedule_context` and `_add_position_dummies`:

```python
def _add_opponent_allowed(df: pd.DataFrame) -> pd.DataFrame:
    allowed = (
        df.groupby(["opponent_team", "position", "season", "week"], as_index=False)
        ["ppr_points"].sum()
        .rename(columns={"opponent_team": "def_team", "ppr_points": "allowed"})
        .sort_values(["def_team", "position", "season", "week"])
        .reset_index(drop=True)
    )
    shifted = allowed.groupby(["def_team", "position"], sort=False)["allowed"].shift(1)
    allowed["opp_allowed_last4"] = (
        shifted.groupby([allowed["def_team"], allowed["position"]])
        .rolling(4, min_periods=1)
        .mean()
        .reset_index(level=[0, 1], drop=True)
    )
    allowed["opp_allowed_season"] = (
        allowed.groupby(["def_team", "position", "season"], sort=False)["allowed"]
        .transform(lambda s: s.shift(1).expanding().mean())
    )
    return df.merge(
        allowed[["def_team", "position", "season", "week",
                 "opp_allowed_last4", "opp_allowed_season"]],
        left_on=["opponent_team", "position", "season", "week"],
        right_on=["def_team", "position", "season", "week"],
        how="left",
    ).drop(columns=["def_team"])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_features.py -v`
Expected: 10 passed.

- [ ] **Step 5: Smoke-run on real data**

Run:

```bash
python -c "
from pathlib import Path
from ffmodel.data.pull import pull_weekly, pull_schedules
from ffmodel.data.features import build_features, feature_columns
seasons = list(range(2012, 2026))
df = build_features(pull_weekly(seasons, Path('data/raw')), pull_schedules(seasons, Path('data/raw')))
print(len(df), 'rows,', len(feature_columns(df)), 'feature columns')
print(df[feature_columns(df)].isna().mean().sort_values().tail(3))
"
```

Expected: same row count as the weekly pull; ~40 feature columns; NaN fractions highest for lag8/opp columns but all well under 0.25 (early-career and 2012-week-1 rows).

- [ ] **Step 6: Commit**

```bash
git add src/ffmodel/data/features.py tests/test_features.py
git commit -m "feat: opponent-allowed defensive features"
```

---

### Task 5: Walk-forward splits + metrics

**Files:**
- Create: `src/ffmodel/eval/__init__.py`
- Create: `src/ffmodel/eval/splits.py`
- Create: `src/ffmodel/eval/metrics.py`
- Test: `tests/test_eval.py`

**Interfaces:**
- Consumes: a feature frame with `season` and `position` columns.
- Produces:
  - `walk_forward_splits(df: pd.DataFrame, test_seasons: list[int]) -> Iterator[tuple[int, pd.Index, pd.Index]]` — yields `(test_season, train_idx, test_idx)`; train is strictly earlier seasons.
  - `mae(y_true, y_pred) -> float`, `rmse(y_true, y_pred) -> float` (numpy arrays or Series).
  - `pinball_loss(y_true, y_pred, q: float) -> float` and `coverage(y_true, lo, hi) -> float` — needed by Plan 2's quantile model; built now so the harness supports quantiles from day one (spec §6).
  - `score_table(frame: pd.DataFrame) -> pd.DataFrame` — input columns `position, actual, pred`; output one row per position plus `OVERALL`, columns `position, mae, rmse, n`.

- [ ] **Step 1: Write the failing tests**

`tests/test_eval.py`:

```python
import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.metrics import coverage, mae, pinball_loss, rmse, score_table
from ffmodel.eval.splits import walk_forward_splits


def test_walk_forward_train_strictly_earlier():
    df = pd.DataFrame({"season": [2021, 2022, 2023, 2024, 2025]})
    splits = list(walk_forward_splits(df, test_seasons=[2023, 2024]))
    assert [s for s, _, _ in splits] == [2023, 2024]
    for test_season, train_idx, test_idx in splits:
        assert (df.loc[train_idx, "season"] < test_season).all()
        assert (df.loc[test_idx, "season"] == test_season).all()
        assert set(train_idx).isdisjoint(test_idx)


def test_mae_rmse():
    y, p = np.array([0.0, 10.0]), np.array([2.0, 6.0])
    assert mae(y, p) == pytest.approx(3.0)
    assert rmse(y, p) == pytest.approx(np.sqrt((4 + 16) / 2))


def test_pinball_loss_asymmetry():
    y, p = np.array([10.0]), np.array([8.0])   # under-prediction by 2
    assert pinball_loss(y, p, q=0.9) == pytest.approx(1.8)  # 0.9 * 2
    assert pinball_loss(y, p, q=0.1) == pytest.approx(0.2)  # 0.1 * 2


def test_coverage():
    y = np.array([1.0, 5.0, 9.0, 20.0])
    lo, hi = np.zeros(4), np.full(4, 10.0)
    assert coverage(y, lo, hi) == pytest.approx(0.75)


def test_score_table_per_position_and_overall():
    frame = pd.DataFrame({
        "position": ["WR", "WR", "RB"],
        "actual": [10.0, 20.0, 5.0],
        "pred": [12.0, 20.0, 9.0],
    })
    table = score_table(frame).set_index("position")
    assert table.loc["WR", "mae"] == pytest.approx(1.0)
    assert table.loc["RB", "n"] == 1
    assert table.loc["OVERALL", "mae"] == pytest.approx(2.0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_eval.py -v`
Expected: FAIL — `ModuleNotFoundError: ffmodel.eval`.

- [ ] **Step 3: Write the implementation**

`src/ffmodel/eval/__init__.py`: empty file.

`src/ffmodel/eval/splits.py`:

```python
"""Walk-forward season splits. The only split logic allowed in this project."""
from __future__ import annotations

from typing import Iterator

import pandas as pd


def walk_forward_splits(
    df: pd.DataFrame, test_seasons: list[int]
) -> Iterator[tuple[int, pd.Index, pd.Index]]:
    for season in sorted(test_seasons):
        train_idx = df.index[df["season"] < season]
        test_idx = df.index[df["season"] == season]
        yield season, train_idx, test_idx
```

`src/ffmodel/eval/metrics.py`:

```python
from __future__ import annotations

import numpy as np
import pandas as pd


def mae(y_true, y_pred) -> float:
    return float(np.mean(np.abs(np.asarray(y_true) - np.asarray(y_pred))))


def rmse(y_true, y_pred) -> float:
    return float(np.sqrt(np.mean((np.asarray(y_true) - np.asarray(y_pred)) ** 2)))


def pinball_loss(y_true, y_pred, q: float) -> float:
    diff = np.asarray(y_true) - np.asarray(y_pred)
    return float(np.mean(np.maximum(q * diff, (q - 1) * diff)))


def coverage(y_true, lo, hi) -> float:
    y = np.asarray(y_true)
    return float(np.mean((y >= np.asarray(lo)) & (y <= np.asarray(hi))))


def score_table(frame: pd.DataFrame) -> pd.DataFrame:
    """Per-position + OVERALL error table. Input columns: position, actual, pred."""
    def _row(name: str, part: pd.DataFrame) -> dict:
        return {
            "position": name,
            "mae": mae(part["actual"], part["pred"]),
            "rmse": rmse(part["actual"], part["pred"]),
            "n": len(part),
        }

    rows = [_row(pos, part) for pos, part in frame.groupby("position")]
    rows.append(_row("OVERALL", frame))
    return pd.DataFrame(rows)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_eval.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/ tests/test_eval.py
git commit -m "feat: walk-forward splits and error/quantile metrics"
```

---

### Task 6: Predictor protocol, harness, naive baseline

**Files:**
- Create: `src/ffmodel/eval/harness.py`
- Create: `src/ffmodel/baseline/__init__.py`
- Create: `src/ffmodel/baseline/naive.py`
- Test: `tests/test_harness.py`

**Interfaces:**
- Consumes: `walk_forward_splits`, `score_table`, `fantasy_points`, `PPR`, `PREDICTED_STATS`, feature frame from Tasks 3-4.
- Produces:
  - `Predictor` protocol: attribute `name: str`; `fit(train: pd.DataFrame) -> None`; `predict(test: pd.DataFrame) -> pd.DataFrame` returning exactly the `PREDICTED_STATS` columns (point predictions).
  - `run_backtest(features: pd.DataFrame, predictors: list, test_seasons: list[int], rules=PPR) -> pd.DataFrame` — tidy results, columns `model, test_season, position, mae, rmse, n`. Plan 2's transformer will be evaluated by calling this exact function.
  - `NaiveLast4` — predicts each stat as the player's `lag4_` value, position-mean fallback for missing history.

- [ ] **Step 1: Write the failing tests**

`tests/test_harness.py`:

```python
import numpy as np
import pandas as pd
import pytest

from ffmodel.baseline.naive import NaiveLast4
from ffmodel.eval.harness import run_backtest
from ffmodel.scoring import PREDICTED_STATS

from tests.test_features import make_schedules, make_weekly
from ffmodel.data.features import build_features


def _toy_features() -> pd.DataFrame:
    rows = []
    for season in (2022, 2023):
        for week in range(1, 5):
            rows.append({"player_id": "p1", "season": season, "week": week,
                         "receiving_yards": 100.0, "receptions": 5.0})
            rows.append({"player_id": "p2", "season": season, "week": week,
                         "position": "RB", "rushing_yards": 80.0})
    sched = pd.concat([make_schedules(4, 2022), make_schedules(4, 2023)])
    return build_features(make_weekly(rows), sched)


def test_naive_predicts_lag4_values():
    features = _toy_features()
    model = NaiveLast4()
    train = features[features["season"] == 2022]
    test = features[features["season"] == 2023]
    model.fit(train)
    pred = model.predict(test)
    assert list(pred.columns) == PREDICTED_STATS
    # p1 has constant 100 receiving yards -> lag4 is exactly 100 mid-season
    p1_wk3 = pred[(test["player_id"] == "p1").to_numpy() & (test["week"] == 3).to_numpy()]
    assert p1_wk3["receiving_yards"].iloc[0] == pytest.approx(100.0)


def test_naive_fallback_for_no_history():
    features = _toy_features()
    model = NaiveLast4()
    model.fit(features[features["season"] == 2022])
    rookie = features[(features["season"] == 2023) & (features["week"] == 1)].copy()
    lag_cols = [c for c in rookie.columns if c.startswith("lag")]
    rookie[lag_cols] = np.nan  # simulate a debut player
    pred = model.predict(rookie)
    assert pred.notna().all().all()


def test_run_backtest_shape_and_perfect_model():
    features = _toy_features()

    class Oracle:  # cheats: returns the actual stats; proves harness wiring
        name = "oracle"
        def fit(self, train): pass
        def predict(self, test): return test[PREDICTED_STATS].copy()

    results = run_backtest(features, [Oracle(), NaiveLast4()], test_seasons=[2023])
    assert set(results["model"]) == {"oracle", "naive_last4"}
    oracle_overall = results[(results["model"] == "oracle") & (results["position"] == "OVERALL")]
    assert oracle_overall["mae"].iloc[0] == pytest.approx(0.0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_harness.py -v`
Expected: FAIL — `ModuleNotFoundError: ffmodel.baseline`.

- [ ] **Step 3: Write the implementation**

`src/ffmodel/baseline/__init__.py`: empty file.

`src/ffmodel/baseline/naive.py`:

```python
"""Floor baseline: a player's last-4-games average, position mean as fallback."""
from __future__ import annotations

import pandas as pd

from ffmodel.scoring import PREDICTED_STATS


class NaiveLast4:
    name = "naive_last4"

    def fit(self, train: pd.DataFrame) -> None:
        self._pos_means = train.groupby("position")[PREDICTED_STATS].mean()

    def predict(self, test: pd.DataFrame) -> pd.DataFrame:
        pred = test[[f"lag4_{s}" for s in PREDICTED_STATS]].copy()
        pred.columns = PREDICTED_STATS
        for stat in PREDICTED_STATS:
            fallback = test["position"].map(self._pos_means[stat])
            pred[stat] = pred[stat].fillna(fallback)
        return pred
```

`src/ffmodel/eval/harness.py`:

```python
"""Backtest harness: every entrant (baseline or transformer) runs through here."""
from __future__ import annotations

from typing import Protocol

import pandas as pd

from ffmodel.eval.metrics import score_table
from ffmodel.eval.splits import walk_forward_splits
from ffmodel.scoring import PPR, PREDICTED_STATS, ScoringRules, fantasy_points


class Predictor(Protocol):
    name: str

    def fit(self, train: pd.DataFrame) -> None: ...
    def predict(self, test: pd.DataFrame) -> pd.DataFrame: ...


def run_backtest(
    features: pd.DataFrame,
    predictors: list[Predictor],
    test_seasons: list[int],
    rules: ScoringRules = PPR,
) -> pd.DataFrame:
    tables = []
    for season, train_idx, test_idx in walk_forward_splits(features, test_seasons):
        train, test = features.loc[train_idx], features.loc[test_idx]
        actual = fantasy_points(test[PREDICTED_STATS], rules)
        for predictor in predictors:
            predictor.fit(train)
            pred_points = fantasy_points(predictor.predict(test), rules)
            scored = pd.DataFrame({
                "position": test["position"].to_numpy(),
                "actual": actual.to_numpy(),
                "pred": pred_points.to_numpy(),
            })
            tables.append(
                score_table(scored).assign(model=predictor.name, test_season=season)
            )
    return pd.concat(tables, ignore_index=True)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_harness.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/eval/harness.py src/ffmodel/baseline/ tests/test_harness.py
git commit -m "feat: backtest harness, Predictor protocol, naive baseline"
```

---

### Task 7: XGBoost baseline + backtest CLI + first committed results

The credible tabular incumbent, plus the runnable entry point that produces the project's first real numbers.

**Files:**
- Create: `src/ffmodel/baseline/xgb.py`
- Create: `src/ffmodel/eval/run.py`
- Create: `README.md`
- Create: `models/backtests/baselines.json` (generated, committed)
- Test: `tests/test_xgb.py`

**Interfaces:**
- Consumes: `feature_columns` (Task 3), harness protocol (Task 6).
- Produces:
  - `XGBBaseline(n_estimators=300, seed=0)` — one `XGBRegressor` per stat in `PREDICTED_STATS`, NaNs handled natively.
  - CLI: `python -m ffmodel.eval.run --data-dir data/raw --first-season 2012 --last-season 2025 --test-seasons 2023 2024 2025 --out models/backtests/baselines.json`
  - JSON report schema (Plan 3's "About the model" page reads this): `{"created": iso8601, "seasons": [first, last], "test_seasons": [...], "scoring": "ppr", "results": [{"model", "test_season", "position", "mae", "rmse", "n"}, ...]}`

- [ ] **Step 1: Write the failing tests**

`tests/test_xgb.py`:

```python
import pandas as pd
import pytest

from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.scoring import PREDICTED_STATS

from tests.test_harness import _toy_features


def test_xgb_fit_predict_shapes_and_determinism():
    features = _toy_features()
    train = features[features["season"] == 2022]
    test = features[features["season"] == 2023]

    preds = []
    for _ in range(2):
        model = XGBBaseline(n_estimators=5, seed=0)
        model.fit(train)
        preds.append(model.predict(test))

    assert list(preds[0].columns) == PREDICTED_STATS
    assert len(preds[0]) == len(test)
    pd.testing.assert_frame_equal(preds[0], preds[1])  # seeded -> identical
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_xgb.py -v`
Expected: FAIL — `ModuleNotFoundError: ffmodel.baseline.xgb`.

- [ ] **Step 3: Write the XGBoost baseline**

`src/ffmodel/baseline/xgb.py`:

```python
"""Tabular incumbent: one gradient-boosted regressor per stat component."""
from __future__ import annotations

import pandas as pd
from xgboost import XGBRegressor

from ffmodel.data.features import feature_columns
from ffmodel.scoring import PREDICTED_STATS


class XGBBaseline:
    name = "xgboost"

    def __init__(self, n_estimators: int = 300, seed: int = 0):
        self.n_estimators = n_estimators
        self.seed = seed
        self._models: dict[str, XGBRegressor] = {}

    def _matrix(self, df: pd.DataFrame) -> pd.DataFrame:
        return df[feature_columns(df)].astype(float)

    def fit(self, train: pd.DataFrame) -> None:
        X = self._matrix(train)
        for stat in PREDICTED_STATS:
            model = XGBRegressor(
                n_estimators=self.n_estimators, max_depth=5, learning_rate=0.05,
                subsample=0.8, colsample_bytree=0.8, tree_method="hist",
                random_state=self.seed, n_jobs=-1,
            )
            model.fit(X, train[stat])
            self._models[stat] = model

    def predict(self, test: pd.DataFrame) -> pd.DataFrame:
        X = self._matrix(test)
        return pd.DataFrame(
            {stat: model.predict(X) for stat, model in self._models.items()},
            index=test.index,
        )[PREDICTED_STATS]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_xgb.py -v`
Expected: 1 passed.

- [ ] **Step 5: Write the backtest CLI**

`src/ffmodel/eval/run.py`:

```python
"""Run the full walk-forward backtest and write the committed JSON report."""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from ffmodel.baseline.naive import NaiveLast4
from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.data.features import build_features
from ffmodel.data.pull import pull_schedules, pull_weekly
from ffmodel.eval.harness import run_backtest


def main() -> None:
    parser = argparse.ArgumentParser(description="Walk-forward baseline backtest.")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--last-season", type=int, default=2025)
    parser.add_argument("--test-seasons", nargs="+", type=int,
                        default=[2023, 2024, 2025])
    parser.add_argument("--out", type=Path,
                        default=Path("models/backtests/baselines.json"))
    args = parser.parse_args()

    seasons = list(range(args.first_season, args.last_season + 1))
    weekly = pull_weekly(seasons, cache_dir=args.data_dir)
    schedules = pull_schedules(seasons, cache_dir=args.data_dir)
    features = build_features(weekly, schedules)

    results = run_backtest(
        features, [NaiveLast4(), XGBBaseline()], test_seasons=args.test_seasons
    )

    report = {
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seasons": [args.first_season, args.last_season],
        "test_seasons": args.test_seasons,
        "scoring": "ppr",
        "results": results.to_dict(orient="records"),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))

    overall = results[results["position"] == "OVERALL"]
    print(overall.groupby("model")[["mae", "rmse"]].mean().round(3))
    print(f"\nfull report -> {args.out}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Run the full backtest on real data**

Run: `python -m ffmodel.eval.run`
Expected: completes in a few minutes on CPU. Printed overall PPR-point MAE (averaged over 2023-2025) in the vicinity of 4.5-6.0 for both models, with `xgboost` beating `naive_last4` by a visible margin (roughly 0.3-1.0 MAE). If naive beats XGBoost, stop and investigate the feature frame for leakage or NaN explosions before proceeding — that ordering is a red flag, not a finding.

- [ ] **Step 7: Run the full test suite**

Run: `pytest -v`
Expected: all tests pass (integration tests deselected by default).

- [ ] **Step 8: Write the README**

`README.md`:

````markdown
# ff-model

NFL fantasy football projections: a small quantile transformer (trained on a
free SageMaker Studio Lab T4) versus classical baselines, evaluated honestly
with walk-forward backtests, published as a static site that updates itself
weekly during the season.

**Design spec:** `docs/superpowers/specs/2026-07-09-fantasy-football-model-design.md`

## Quickstart

```bash
pip install -e ".[dev]"
pytest                          # unit tests (offline)
pytest -m integration           # network tests against live nflverse data

python -m ffmodel.data.pull     # cache 2012-2025 data to data/raw/
python -m ffmodel.eval.run      # walk-forward backtest -> models/backtests/baselines.json
```

## Status

- [x] Plan 1: data pipeline, scoring, features, eval harness, baselines
- [ ] Plan 2: quantile transformer trained on Studio Lab (T4)
- [ ] Plan 3: draft board + weekly site, GitHub Actions automation
````

- [ ] **Step 9: Commit (including the generated report)**

```bash
git add src/ffmodel/baseline/xgb.py src/ffmodel/eval/run.py tests/test_xgb.py README.md models/backtests/baselines.json
git commit -m "feat: XGBoost baseline, backtest CLI, first committed results"
```

---

## Done criteria for Plan 1

- `pytest` green; `pytest -m integration` green.
- `models/backtests/baselines.json` committed with walk-forward MAE/RMSE for naive and XGBoost on 2023-2025, XGBoost winning.
- README quickstart reproduces everything from a clean clone.

**Next:** Plan 2 (quantile transformer + Studio Lab training workflow) gets written once this plan's interfaces are real. Deliberately deferred to Plan 2: snap-count features (spec §4 lists snap % as a sequence-model input; the snap-count dataset uses PFR player IDs and needs a join that belongs with the sequence builder). Before writing Plan 2, re-verify SageMaker Studio Lab's current session limits and status.
