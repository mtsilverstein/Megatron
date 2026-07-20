# Rookie Projections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put drafted rookies on the draft board via an empirical draft-capital cohort prior — walk-forward fitted, honestly banded, jointly VORP-ranked with veterans.

**Architecture:** New `pull_draft_picks` (leakage-guarded, PFR team codes normalized) feeds a cohort prior module (`ffmodel/model/rookie.py`: position × capital buckets with deterministic min-n merging, playing-week stat quantiles, zero-inflated games distribution). A rookie-only walk-forward backtest (`ffmodel/eval/rookies.py`) measures the pre-registered gates BEFORE board integration. `build_draft_board` then appends rookie rows through the existing `simulate_season` machinery; the site shows an "R" chip and explains the method.

**Tech Stack:** Python/pandas/numpy, scipy.stats.spearmanr (already transitively available — `simulate.py` imports scipy), pytest; vanilla JS/CSS.

**Spec:** `docs/superpowers/specs/2026-07-19-rookie-projections-design.md` — read it first.

## Global Constraints

- Run tests with `$env:PYTHONPATH = "src"; python -m pytest ...` (PowerShell). Suite runs warnings-as-errors.
- No new pip dependencies. `from scipy.stats import spearmanr` is allowed (scipy ships with scikit-learn, already imported by `ffmodel/model/simulate.py`).
- **Leakage guard:** draft-picks features are ONLY `season, round, pick, team, gsis_id, player_name, position, age, college`. nflverse's career-outcome columns (games, w_av, to, career stats, allpro, probowls, …) describe the future — structurally excluded, test-pinned.
- **Walk-forward only:** cohorts fit on classes ≤ boundary; never tune bucket boundaries or min-n against held-out classes (2023–2025). The STOP rule (Gate 1 fails → position-only priors) is pre-registered, not a tuning knob.
- **Fail-safe:** draft-picks pull failure or an empty target-season class aborts a `--draft` run before any writes. The weekly cron never pulls draft picks.
- Legacy paths: `build_draft_board(...)` without `draft_picks` adds no rookie rows; `models/backtests/` stays schema-locked (rookie report goes to `models/diagnostics/`).
- All payloads survive `json.dumps(payload, allow_nan=False)` — cast numpy types.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `pull_draft_picks` — leakage-guarded, team-normalized pull

**Files:**
- Modify: `src/ffmodel/data/pull.py` (append; also extend its imports if needed)
- Modify: `tests/test_pull.py` (append)

**Interfaces:**
- Consumes: existing `_cached`, `_cache_name`, `POSITIONS` in pull.py.
- Produces:
  - `normalize_draft_picks(raw: pd.DataFrame) -> pd.DataFrame` — pure; filters to skill positions, maps PFR team codes, enforces the column whitelist, raises `ValueError` on unknown team codes.
  - `pull_draft_picks(seasons: list[int], cache_dir: Path | None = None) -> pd.DataFrame` — cached fetch (nflreadpy deferred import) + normalize. Columns exactly: `season, round, pick, team, gsis_id, player_name, position, age, college`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_pull.py`:

```python
def _raw_draft(rows):
    """Synthetic nflverse draft_picks frame with the future-leaking columns
    present, to prove they get dropped."""
    base = {"season": 2024, "round": 1, "pick": 1, "team": "KAN",
            "gsis_id": "00-0099999", "pfr_player_id": "X", "cfb_player_id": "Y",
            "pfr_player_name": "Some Guy", "position": "RB", "age": 22.0,
            "college": "State", "hof": False,
            # future-leaking career-outcome columns:
            "to": 2035, "w_av": 80, "car_av": 75, "dr_av": 70, "games": 150,
            "allpro": 3, "probowls": 5, "seasons_started": 9,
            "rush_yards": 9000, "rec_yards": 3000, "pass_yards": 0}
    return pd.DataFrame([{**base, **r} for r in rows])


def test_normalize_draft_picks_column_whitelist_excludes_career_outcomes():
    from ffmodel.data.pull import normalize_draft_picks

    out = normalize_draft_picks(_raw_draft([{}]))
    assert list(out.columns) == ["season", "round", "pick", "team", "gsis_id",
                                 "player_name", "position", "age", "college"]


def test_normalize_draft_picks_maps_pfr_team_codes():
    from ffmodel.data.pull import normalize_draft_picks

    out = normalize_draft_picks(_raw_draft([
        {"team": "GNB"}, {"team": "KAN"}, {"team": "NOR"}, {"team": "LVR"},
        {"team": "LAR"}, {"team": "SDG"}, {"team": "STL"}, {"team": "OAK"},
        {"team": "PHI"},
    ]))
    assert list(out["team"]) == ["GB", "KC", "NO", "LV", "LA", "LAC", "LA",
                                 "LV", "PHI"]


def test_normalize_draft_picks_rejects_unknown_team_code():
    from ffmodel.data.pull import normalize_draft_picks

    with pytest.raises(ValueError, match="ZZZ"):
        normalize_draft_picks(_raw_draft([{"team": "ZZZ"}]))


def test_normalize_draft_picks_filters_to_skill_positions():
    from ffmodel.data.pull import normalize_draft_picks

    out = normalize_draft_picks(_raw_draft([
        {"position": "QB"}, {"position": "T"}, {"position": "DB"},
        {"position": "TE"},
    ]))
    assert list(out["position"]) == ["QB", "TE"]


def test_pull_draft_picks_uses_cache(tmp_path):
    from ffmodel.data.pull import normalize_draft_picks, pull_draft_picks

    cached = normalize_draft_picks(_raw_draft([{}]))
    cached.to_parquet(tmp_path / "draft_picks_2024_2024.parquet", index=False)
    # No network stub: a real fetch attempt would fail loudly here.
    out = pull_draft_picks([2024], cache_dir=tmp_path)
    assert len(out) == 1 and out["team"].iloc[0] == "KC"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_pull.py -v`
Expected: new tests FAIL with `ImportError: cannot import name 'normalize_draft_picks'`; existing tests PASS.

- [ ] **Step 3: Implement**

Append to `src/ffmodel/data/pull.py`:

```python
# PFR-style codes used by nflverse draft_picks, mapped to the current
# franchise codes the rest of the project uses (relocations map to the
# current franchise, consistent with TEAM_CODE_FIXES above).
PFR_TEAM_FIXES = {
    "GNB": "GB", "KAN": "KC", "NOR": "NO", "NWE": "NE", "SFO": "SF",
    "TAM": "TB", "LVR": "LV", "LAR": "LA", "SDG": "LAC",
    "STL": "LA", "OAK": "LV",
}
FRANCHISE_CODES = {
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN",
    "DET", "GB", "HOU", "IND", "JAX", "KC", "LA", "LAC", "LV", "MIA", "MIN",
    "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
}
# Draft-day-known columns ONLY. nflverse's draft_picks also carries career
# OUTCOMES (games, w_av, to, career stats, allpro, ...) which encode the
# future -- structurally excluded here so no downstream consumer can leak.
DRAFT_COLUMNS = ["season", "round", "pick", "team", "gsis_id",
                 "player_name", "position", "age", "college"]


def normalize_draft_picks(raw: pd.DataFrame) -> pd.DataFrame:
    df = raw[raw["position"].isin(POSITIONS)].copy()
    df["team"] = df["team"].replace(PFR_TEAM_FIXES)
    unknown = sorted(set(df["team"]) - FRANCHISE_CODES)
    if unknown:
        raise ValueError(f"unknown draft team code(s) {unknown} — refusing "
                         "to silently mis-assign teams/byes")
    df = df.rename(columns={"pfr_player_name": "player_name"})
    return df[DRAFT_COLUMNS].sort_values(["season", "pick"]).reset_index(drop=True)


def pull_draft_picks(seasons: list[int], cache_dir: Path | None = None) -> pd.DataFrame:
    def load() -> pd.DataFrame:
        import nflreadpy  # deferred: keep offline unit tests import-light

        raw = nflreadpy.load_draft_picks().to_pandas()
        return normalize_draft_picks(raw[raw["season"].isin(seasons)])

    return _cached(cache_dir, _cache_name("draft_picks", seasons), load)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_pull.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/data/pull.py tests/test_pull.py
git commit -m "feat: draft-picks pull — leakage-guarded, PFR team codes normalized"
```

---

### Task 2: Cohort prior — `ffmodel/model/rookie.py`

**Files:**
- Create: `src/ffmodel/model/rookie.py`
- Create: `tests/test_rookie.py`

**Interfaces:**
- Consumes: `PREDICTED_STATS` from `ffmodel.scoring`; weekly frames with `player_id, season, week` + stat columns; draft-picks frames from Task 1.
- Produces (Tasks 3–4 rely on these exact signatures):
  - `assign_bucket(round_: int, pick: int) -> str` — one of `"top12" | "r1" | "r2" | "r3" | "day3"`.
  - `merge_buckets(counts: dict[str, int], min_n: int = 25) -> dict[str, str]` — bucket → merged cohort label (e.g. `"top12+r1"`), deterministic, thin buckets absorb toward day3.
  - `fit_rookie_cohorts(weekly, draft_picks, through_season, *, min_n: int = 25) -> dict` — `{"through": int, "min_n": int, "positions": {pos: {"merge_map": {bucket: label}, "cohorts": {label: {"n_players", "n_weeks", "stats": {"p10"|"p50"|"p90": {stat: float}}, "games_probs": np.ndarray(19,)}}}}}`. Only classes ≤ `through_season` contribute. `min_n=10**9` collapses to one cohort per position (the STOP-rule fallback).
  - `rookie_projection(cohorts, position, round_, pick) -> tuple[dict, np.ndarray]` — `({"p10": DataFrame, "p50": ..., "p90": ...}, games_probs)`; the frames are one-row stat frames over `PREDICTED_STATS` ready for `fantasy_points_quantiles`. Unknown position → `ValueError`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_rookie.py`:

```python
import numpy as np
import pandas as pd
import pytest

from ffmodel.model.rookie import (
    assign_bucket, fit_rookie_cohorts, merge_buckets, rookie_projection,
)
from ffmodel.scoring import PREDICTED_STATS


def test_assign_bucket_boundaries():
    assert assign_bucket(1, 1) == "top12"
    assert assign_bucket(1, 12) == "top12"
    assert assign_bucket(1, 13) == "r1"
    assert assign_bucket(2, 40) == "r2"
    assert assign_bucket(3, 70) == "r3"
    assert assign_bucket(4, 110) == "day3"
    assert assign_bucket(7, 250) == "day3"


def test_merge_buckets_identity_when_all_thick():
    counts = {"top12": 30, "r1": 30, "r2": 30, "r3": 30, "day3": 100}
    m = merge_buckets(counts)
    assert m == {b: b for b in ["top12", "r1", "r2", "r3", "day3"]}


def test_merge_buckets_thin_buckets_absorb_toward_day3():
    # QB-like counts: walk accumulates top12(8)+r1(6)+r2(10)=24 < 25, +r3(9)=33
    counts = {"top12": 8, "r1": 6, "r2": 10, "r3": 9, "day3": 40}
    m = merge_buckets(counts)
    assert m["top12"] == m["r1"] == m["r2"] == m["r3"] == "top12+r1+r2+r3"
    assert m["day3"] == "day3"


def test_merge_buckets_everything_thin_collapses_to_one():
    m = merge_buckets({"top12": 2, "r1": 1, "r2": 3, "r3": 2, "day3": 5})
    assert len(set(m.values())) == 1


def test_merge_buckets_min_n_override_forces_position_only():
    counts = {"top12": 30, "r1": 30, "r2": 30, "r3": 30, "day3": 100}
    m = merge_buckets(counts, min_n=10**9)
    assert len(set(m.values())) == 1   # the STOP-rule fallback shape


def _weekly(rows):
    base = {s: 0.0 for s in PREDICTED_STATS}
    return pd.DataFrame([{**base, "player_id": "x", "season": 2020, "week": 1,
                          **r} for r in rows])


def _picks(rows):
    base = {"season": 2020, "round": 1, "pick": 1, "team": "KC",
            "gsis_id": "00-0", "player_name": "P", "position": "RB",
            "age": 22.0, "college": "State"}
    return pd.DataFrame([{**base, **r} for r in rows])


def test_fit_walk_forward_excludes_future_classes():
    # A monster 2024 rookie must NOT influence cohorts fit through 2023.
    picks = _picks([
        {"season": 2023, "gsis_id": "00-A", "pick": 5},
        {"season": 2024, "gsis_id": "00-B", "pick": 6},
    ])
    weekly = _weekly([
        {"player_id": "00-A", "season": 2023, "week": 1, "rushing_yards": 50.0},
        {"player_id": "00-B", "season": 2024, "week": 1, "rushing_yards": 500.0},
    ])
    cohorts = fit_rookie_cohorts(weekly, picks, through_season=2023)
    label = cohorts["positions"]["RB"]["merge_map"]["top12"]
    c = cohorts["positions"]["RB"]["cohorts"][label]
    assert c["n_players"] == 1
    assert c["stats"]["p50"]["rushing_yards"] == pytest.approx(50.0)


def test_fit_zero_inflated_games_distribution():
    # Two drafted RBs: one plays 2 rookie-year weeks, one never plays.
    picks = _picks([
        {"season": 2020, "gsis_id": "00-A", "pick": 5},
        {"season": 2020, "gsis_id": "00-B", "pick": 6},
    ])
    weekly = _weekly([
        {"player_id": "00-A", "season": 2020, "week": 1, "rushing_yards": 60.0},
        {"player_id": "00-A", "season": 2020, "week": 2, "rushing_yards": 80.0},
        # 00-B has NO rows: the zero-games outcome.
        # a 2021 week for 00-A must not count toward his ROOKIE season:
        {"player_id": "00-A", "season": 2021, "week": 1, "rushing_yards": 999.0},
    ])
    cohorts = fit_rookie_cohorts(weekly, picks, through_season=2020)
    label = cohorts["positions"]["RB"]["merge_map"]["top12"]
    c = cohorts["positions"]["RB"]["cohorts"][label]
    assert c["games_probs"][0] == pytest.approx(0.5)   # the never-played rookie
    assert c["games_probs"][2] == pytest.approx(0.5)
    assert c["n_weeks"] == 2                            # 2021 week excluded
    assert c["stats"]["p50"]["rushing_yards"] == pytest.approx(70.0)


def test_fit_quantiles_across_playing_weeks():
    picks = _picks([{"season": 2020, "gsis_id": "00-A", "pick": 3}])
    weekly = _weekly([
        {"player_id": "00-A", "season": 2020, "week": w,
         "receiving_yards": float(v)}
        for w, v in enumerate([0, 25, 50, 75, 100], start=1)
    ])
    cohorts = fit_rookie_cohorts(weekly, picks, through_season=2020)
    label = cohorts["positions"]["RB"]["merge_map"]["top12"]
    stats = cohorts["positions"]["RB"]["cohorts"][label]["stats"]
    assert stats["p50"]["receiving_yards"] == pytest.approx(50.0)
    assert stats["p10"]["receiving_yards"] == pytest.approx(10.0)
    assert stats["p90"]["receiving_yards"] == pytest.approx(90.0)


def test_projection_returns_scorable_frames_and_games():
    picks = _picks([{"season": 2020, "gsis_id": "00-A", "pick": 3}])
    weekly = _weekly([{"player_id": "00-A", "season": 2020, "week": 1,
                       "rushing_yards": 50.0}])
    cohorts = fit_rookie_cohorts(weekly, picks, through_season=2020)
    frames, games_probs = rookie_projection(cohorts, "RB", 1, 5)
    assert list(frames["p50"].columns) == PREDICTED_STATS
    assert frames["p50"]["rushing_yards"].iloc[0] == pytest.approx(50.0)
    assert games_probs.shape == (19,)
    assert games_probs.sum() == pytest.approx(1.0)


def test_projection_unknown_position_fails_loud():
    picks = _picks([{"season": 2020, "gsis_id": "00-A"}])
    weekly = _weekly([{"player_id": "00-A", "season": 2020, "week": 1}])
    cohorts = fit_rookie_cohorts(weekly, picks, through_season=2020)
    with pytest.raises(ValueError, match="position"):
        rookie_projection(cohorts, "K", 1, 5)


def test_fit_empty_history_fails_loud():
    with pytest.raises(ValueError, match="no draft classes"):
        fit_rookie_cohorts(_weekly([]), _picks([{"season": 2024}]),
                           through_season=2020)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_rookie.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ffmodel.model.rookie'`

- [ ] **Step 3: Implement**

Create `src/ffmodel/model/rookie.py`:

```python
"""Rookie draft-capital cohort prior.

Walk-forward empirical prior for drafted rookies with no NFL history
(spec: docs/superpowers/specs/2026-07-19-rookie-projections-design.md).
Cohorts are position x capital bucket; each yields per-stat weekly
quantiles across the cohort's PLAYING weeks plus a games-played
distribution over 0..18 that keeps the zero-games outcome (the ~10% of
drafted skill players who never record a week) -- that zero inflation is
what makes rookie floors honest. v1 simplification (documented on the
site): games-played and per-week quality are independent within a cohort.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ffmodel.scoring import PREDICTED_STATS

_MIN_PLAYERS = 25
_MAX_GAMES = 18
BUCKET_ORDER = ["top12", "r1", "r2", "r3", "day3"]


def assign_bucket(round_: int, pick: int) -> str:
    if round_ == 1:
        return "top12" if pick <= 12 else "r1"
    if round_ == 2:
        return "r2"
    if round_ == 3:
        return "r3"
    return "day3"


def merge_buckets(counts: dict[str, int], min_n: int = _MIN_PLAYERS) -> dict[str, str]:
    """Deterministic thin-bucket merging, walking top12 -> day3.

    Buckets accumulate until the running count reaches min_n, then a group
    closes. A thin tail joins the last-formed group. min_n=10**9 collapses
    everything to one cohort per position -- the pre-registered STOP-rule
    fallback shape (position-only prior).
    """
    groups: list[list[str]] = []
    current: list[str] = []
    total = 0
    for bucket in BUCKET_ORDER:
        current.append(bucket)
        total += counts.get(bucket, 0)
        if total >= min_n:
            groups.append(current)
            current, total = [], 0
    if current:
        if groups:
            groups[-1].extend(current)
        else:
            groups.append(current)
    return {b: "+".join(g) for g in groups for b in g}


def fit_rookie_cohorts(weekly: pd.DataFrame, draft_picks: pd.DataFrame,
                       through_season: int, *, min_n: int = _MIN_PLAYERS) -> dict:
    dp = draft_picks[draft_picks["season"] <= through_season]
    if dp.empty:
        raise ValueError(f"no draft classes at or before {through_season} — "
                         "cannot fit rookie cohorts")
    rookie_weeks = weekly.merge(
        dp[["season", "gsis_id"]].rename(
            columns={"season": "draft_season", "gsis_id": "player_id"}),
        on="player_id")
    # rookie SEASON only: a sophomore-year week must not leak into the prior
    rookie_weeks = rookie_weeks[rookie_weeks["season"] == rookie_weeks["draft_season"]]

    positions: dict = {}
    for pos, group in dp.groupby("position"):
        buckets = group.apply(
            lambda r: assign_bucket(int(r["round"]), int(r["pick"])), axis=1)
        merge_map = merge_buckets(buckets.value_counts().to_dict(), min_n=min_n)
        cohorts: dict = {}
        for label in sorted(set(merge_map.values())):
            members = group[buckets.map(merge_map) == label]
            weeks = rookie_weeks[rookie_weeks["player_id"].isin(members["gsis_id"])]
            games = (weeks.groupby("player_id").size()
                     .reindex(members["gsis_id"], fill_value=0)
                     .clip(upper=_MAX_GAMES))
            probs = np.zeros(_MAX_GAMES + 1, dtype=float)
            for g in games:
                probs[int(g)] += 1.0
            probs /= probs.sum()
            stats: dict = {}
            for q, qv in (("p10", 0.1), ("p50", 0.5), ("p90", 0.9)):
                if weeks.empty:
                    stats[q] = {s: 0.0 for s in PREDICTED_STATS}
                else:
                    stats[q] = {s: float(np.quantile(weeks[s].to_numpy(), qv))
                                for s in PREDICTED_STATS}
            cohorts[label] = {"n_players": int(len(members)),
                              "n_weeks": int(len(weeks)),
                              "stats": stats, "games_probs": probs}
        positions[pos] = {"merge_map": merge_map, "cohorts": cohorts}
    return {"through": int(through_season), "min_n": int(min_n),
            "positions": positions}


def rookie_projection(cohorts: dict, position: str, round_: int,
                      pick: int) -> tuple[dict, np.ndarray]:
    if position not in cohorts["positions"]:
        raise ValueError(f"no rookie cohorts for position {position!r} "
                         f"(through {cohorts['through']})")
    pos = cohorts["positions"][position]
    label = pos["merge_map"][assign_bucket(int(round_), int(pick))]
    cohort = pos["cohorts"][label]
    frames = {q: pd.DataFrame([cohort["stats"][q]], columns=PREDICTED_STATS)
              for q in ("p10", "p50", "p90")}
    return frames, cohort["games_probs"]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_rookie.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/model/rookie.py tests/test_rookie.py
git commit -m "feat: rookie cohort prior — capital buckets, zero-inflated availability"
```

---

### Task 3: Rookie backtest CLI + REAL gate measurement

**Files:**
- Create: `src/ffmodel/eval/rookies.py`
- Create: `tests/test_eval_rookies.py`
- Create (real run): `models/diagnostics/rookie_backtest.json`

**Interfaces:**
- Consumes: Task 1 `pull_draft_picks`, Task 2 `fit_rookie_cohorts`/`rookie_projection`, existing `simulate_season`, `fantasy_points_quantiles`, `RULESETS` (from `ffmodel.site.weekly` — precedent: `ffmodel.eval.board` already imports from the site layer), `pull_weekly`.
- Produces: `project_class(weekly, draft_picks, class_season, *, min_n=None, n_draws=2000, seed=0) -> list[dict]` (each: player_id, player_name, position, round, pick, p10, p50, p90) and CLI `python -m ffmodel.eval.rookies --out models/diagnostics/rookie_backtest.json` (defaults: classes 2023 2024 2025, `--data-dir data/raw`, `--first-season 2012`). Report schema below. **This task also runs the CLI on real data and commits the report — the Gate 1 measurement.**

- [ ] **Step 1: Write the failing tests**

Create `tests/test_eval_rookies.py`:

```python
import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.scoring import PREDICTED_STATS


def _weekly(rows):
    base = {s: 0.0 for s in PREDICTED_STATS}
    base["fantasy_points_ppr"] = 0.0
    return pd.DataFrame([{**base, "player_id": "x", "season": 2020, "week": 1,
                          **r} for r in rows])


def _picks(rows):
    base = {"season": 2020, "round": 1, "pick": 1, "team": "KC",
            "gsis_id": "00-0", "player_name": "P", "position": "RB",
            "age": 22.0, "college": "State"}
    return pd.DataFrame([{**base, **r} for r in rows])


def _toy_world():
    """Two history classes (2020, 2021) where early picks produce and late
    picks don't, plus a 2022 class to project."""
    picks, weekly = [], []
    pid = 0
    for season in (2020, 2021, 2022):
        for i in range(30):          # early picks: productive rookies
            pid += 1
            picks.append({"season": season, "round": 1, "pick": (i % 12) + 1,
                          "gsis_id": f"00-{pid:04d}", "player_name": f"E{pid}"})
            if season < 2022:
                for w in range(1, 15):
                    weekly.append({"player_id": f"00-{pid:04d}", "season": season,
                                   "week": w, "rushing_yards": 80.0,
                                   "fantasy_points_ppr": 8.0})
        for i in range(30):          # day-3 picks: mostly nothing
            pid += 1
            picks.append({"season": season, "round": 6, "pick": 180 + i,
                          "gsis_id": f"00-{pid:04d}", "player_name": f"L{pid}"})
    return _weekly(weekly), _picks(picks)


def test_project_class_walk_forward_and_ordering():
    from ffmodel.eval.rookies import project_class

    weekly, picks = _toy_world()
    rows = project_class(weekly, picks, 2022, n_draws=500, seed=0)
    assert len(rows) == 60
    early = [r for r in rows if r["round"] == 1]
    late = [r for r in rows if r["round"] == 6]
    # capital signal must separate the cohorts in the projection
    assert min(r["p50"] for r in early) > max(r["p50"] for r in late)
    for r in rows:
        assert r["p10"] <= r["p50"] <= r["p90"]


def test_report_schema_and_gate(tmp_path, monkeypatch):
    import sys

    import ffmodel.eval.rookies as rk_mod

    weekly, picks = _toy_world()
    monkeypatch.setattr(rk_mod, "pull_weekly", lambda *a, **k: weekly)
    monkeypatch.setattr(rk_mod, "pull_draft_picks", lambda *a, **k: picks)
    out = tmp_path / "rookie_backtest.json"
    monkeypatch.setattr(sys, "argv", ["rookies", "--classes", "2022",
                                      "--out", str(out)])
    rk_mod.main()
    report = json.loads(out.read_text())
    assert report["classes"] == [2022]
    g = report["gate1"]
    assert set(g) >= {"bucketed_spearman", "position_only_spearman", "passed"}
    # toy world has genuine capital signal -> bucketed must win
    assert g["passed"] is True
    assert "coverage_p10_p90" in report and "per_class" in report
    json.dumps(report)


def test_actuals_include_zero_for_never_played(tmp_path):
    from ffmodel.eval.rookies import actual_rookie_points

    weekly, picks = _toy_world()
    cls = picks[picks["season"] == 2022]
    actuals = actual_rookie_points(weekly, cls, 2022)
    assert len(actuals) == 60
    assert (actuals == 0.0).all()   # toy 2022 class has no weekly rows
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_eval_rookies.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ffmodel.eval.rookies'`

- [ ] **Step 3: Implement**

Create `src/ffmodel/eval/rookies.py`:

```python
"""Walk-forward rookie backtest.

For each held-out class S: fit cohorts on classes <= S-1, project class S
from draft capital alone, compare to actual rookie-season PPR totals
(players who never played count as 0.0 -- they were draftable and busted;
excluding them would flatter the prior). Output goes to models/diagnostics/
-- models/backtests/ is schema-locked to weekly/board reports.

Pre-registered gates (spec 2026-07-19-rookie-projections-design.md):
Gate 1: capital-bucketed prior beats a position-only baseline on pooled
Spearman vs actual rookie-season PPR. Gate 2: rookie band coverage is
measured and reported per position, whatever it is. STOP rule: Gate 1
failing means the board ships position-only priors (min_n=10**9), reported
honestly -- bucket boundaries are never tuned against the held-out classes.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from ffmodel.data.pull import pull_draft_picks, pull_weekly
from ffmodel.model.rookie import fit_rookie_cohorts, rookie_projection
from ffmodel.model.simulate import simulate_season
from ffmodel.scoring import fantasy_points_quantiles
from ffmodel.site.weekly import RULESETS

_POSITION_ONLY_MIN_N = 10**9
_SEASON_WEEKS = 17


def project_class(weekly: pd.DataFrame, draft_picks: pd.DataFrame,
                  class_season: int, *, min_n: int | None = None,
                  n_draws: int = 2000, seed: int = 0) -> list[dict]:
    kwargs = {} if min_n is None else {"min_n": min_n}
    cohorts = fit_rookie_cohorts(
        weekly[weekly["season"] < class_season],
        draft_picks[draft_picks["season"] < class_season],
        through_season=class_season - 1, **kwargs)
    rng = np.random.default_rng(seed)
    rows = []
    cls = draft_picks[draft_picks["season"] == class_season]
    for _, r in cls.iterrows():
        frames, games_probs = rookie_projection(
            cohorts, r["position"], int(r["round"]), int(r["pick"]))
        pts = fantasy_points_quantiles(frames, RULESETS["ppr"])
        triple = (float(pts["p10"].iloc[0]), float(pts["p50"].iloc[0]),
                  float(pts["p90"].iloc[0]))
        sim = simulate_season(np.array([triple] * _SEASON_WEEKS),
                              games_probs, n_draws, rng)
        rows.append({"player_id": r["gsis_id"], "player_name": r["player_name"],
                     "position": r["position"], "round": int(r["round"]),
                     "pick": int(r["pick"]),
                     "p10": sim["p10"], "p50": sim["p50"], "p90": sim["p90"]})
    return rows


def actual_rookie_points(weekly: pd.DataFrame, cls: pd.DataFrame,
                         class_season: int) -> pd.Series:
    season_weeks = weekly[weekly["season"] == class_season]
    totals = season_weeks.groupby("player_id")["fantasy_points_ppr"].sum()
    return totals.reindex(cls["gsis_id"], fill_value=0.0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Walk-forward rookie backtest.")
    parser.add_argument("--classes", nargs="+", type=int,
                        default=[2023, 2024, 2025])
    parser.add_argument("--out", type=Path,
                        default=Path("models/diagnostics/rookie_backtest.json"))
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--n-draws", type=int, default=2000)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    last = max(args.classes)
    weekly = pull_weekly(list(range(args.first_season, last + 1)),
                         cache_dir=args.data_dir)
    picks = pull_draft_picks(list(range(args.first_season, last + 1)),
                             cache_dir=args.data_dir)

    per_class, pred_b, pred_p, actual_all, positions = [], [], [], [], []
    covered = {}
    for class_season in sorted(args.classes):
        cls = picks[picks["season"] == class_season]
        bucketed = project_class(weekly, picks, class_season,
                                 n_draws=args.n_draws)
        pos_only = project_class(weekly, picks, class_season,
                                 min_n=_POSITION_ONLY_MIN_N,
                                 n_draws=args.n_draws)
        actuals = actual_rookie_points(weekly, cls, class_season)
        for row_b, row_p, actual in zip(bucketed, pos_only, actuals):
            pred_b.append(row_b["p50"])
            pred_p.append(row_p["p50"])
            actual_all.append(float(actual))
            positions.append(row_b["position"])
            covered.setdefault(row_b["position"], []).append(
                row_b["p10"] <= float(actual) <= row_b["p90"])
        per_class.append({"class": class_season, "n": int(len(cls))})

    rho_b = float(spearmanr(pred_b, actual_all).statistic)
    rho_p = float(spearmanr(pred_p, actual_all).statistic)
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "classes": sorted(args.classes),
        "n_rookies": len(actual_all),
        "gate1": {"bucketed_spearman": round(rho_b, 4),
                  "position_only_spearman": round(rho_p, 4),
                  "passed": bool(rho_b > rho_p)},
        "coverage_p10_p90": {pos: round(float(np.mean(v)), 4)
                             for pos, v in sorted(covered.items())},
        "per_class": per_class,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False))
    print(f"{args.out}: gate1 passed={report['gate1']['passed']} "
          f"(bucketed {rho_b:.3f} vs position-only {rho_p:.3f})")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_eval_rookies.py tests/test_rookie.py -v`
Expected: all PASS

- [ ] **Step 5: REAL RUN — measure the gates**

```powershell
$env:PYTHONPATH = "src"
python -m ffmodel.eval.rookies --out models/diagnostics/rookie_backtest.json
```

(Uses the cached weekly parquet + fetches/caches draft picks; CPU-only, ~1–3 min.) Record the printed gate line in your report. **Do not edit buckets/min-n in response to these numbers** — if `gate1.passed` is false, say so; the coordinator applies the pre-registered STOP rule in Task 4.

- [ ] **Step 6: Full suite, commit code + report**

Run: `$env:PYTHONPATH = "src"; python -m pytest -q` — all PASS. Then:

```bash
git add src/ffmodel/eval/rookies.py tests/test_eval_rookies.py models/diagnostics/rookie_backtest.json
git commit -m "feat: walk-forward rookie backtest — gate 1 measured and committed"
```

---

### Task 4: Board integration — rookies jointly ranked

**Files:**
- Modify: `src/ffmodel/site/draft.py`
- Modify: `src/ffmodel/site/generate.py`
- Modify: `tests/test_site_draft.py` (append)

**Interfaces:**
- Consumes: Task 1 `pull_draft_picks`; Task 2 `fit_rookie_cohorts`/`rookie_projection`; existing `simulate_season`, `fantasy_points_quantiles`, `RULESETS`, `weekly_residual_icc`/`rho_from_icc`, `_normalize_name` from `ffmodel.site.sleeper`.
- Produces: `build_draft_board(..., draft_picks: pd.DataFrame | None = None)` (new keyword-only param after `sleeper_players`). When provided: rookie rows appended before `_finalize_board` (joint VORP/tiers/ranks), every payload player carries `"rookie": true|false`, methodology gains `"rookie_prior"`, empty target class raises. When `None`: no rookie rows; `_finalize_board` tolerates frames without the rookie column (payload emits `false`). The coordinator confirms from Task 3's committed report whether to use default buckets (gate passed) or the position-only STOP fallback; the code default is `rookie_min_n=None` → bucketed. `generate.py` pulls draft picks 2012→season only when `--draft`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_site_draft.py`:

```python
def _rookie_world():
    """History with a productive 2022 rookie class + a 2023 class to draft.
    Reuses _history() (2023 veteran weeks 1-6, players p1/p2)."""
    from tests.test_features import make_weekly

    weekly = _history()
    hist_rows = []
    for i in range(30):
        pid = f"00-H{i:03d}"
        for w in range(1, 10):
            hist_rows.append({"player_id": pid, "season": 2022, "week": w,
                              "position": "RB", "team": "AAA",
                              "rushing_yards": 90.0})
    hist = make_weekly(hist_rows)
    weekly = pd.concat([weekly, hist], ignore_index=True)

    import pandas as _pd
    picks = _pd.DataFrame([
        {"season": 2022, "round": 1, "pick": i + 1, "team": "AAA",
         "gsis_id": f"00-H{i:03d}", "player_name": f"H{i}", "position": "RB",
         "age": 22.0, "college": "State"} for i in range(30)
    ] + [
        {"season": 2023, "round": 1, "pick": 2, "team": "AAA",
         "gsis_id": "DRAFT001", "player_name": "New Rookie", "position": "RB",
         "age": 21.0, "college": "State"},
    ])
    return weekly, picks


def test_board_appends_rookie_jointly_ranked():
    weekly, picks = _rookie_world()
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9),
                              draft_picks=picks)
    rookies = [p for p in board["players"] if p["rookie"]]
    vets = [p for p in board["players"] if not p["rookie"]]
    assert len(rookies) == 1 and rookies[0]["name"] == "New Rookie"
    assert len(vets) == 2
    r = rookies[0]
    assert r["position"] == "RB" and r["player_id"] == "DRAFT001"
    assert r["season_points"]["ppr"]["p10"] is not None
    # joint ranking: rookie has a position_rank among RBs, vorp on same scale
    assert isinstance(r["vorp"], float) and isinstance(r["position_rank"], int)
    assert board["methodology"]["rookie_prior"]["n_rookies"] == 1
    json.dumps(board, allow_nan=False)


def test_board_without_draft_picks_has_rookie_false_only():
    weekly, _ = _rookie_world()
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9))
    assert all(p["rookie"] is False for p in board["players"])
    assert "rookie_prior" not in board["methodology"]


def test_rookie_dedupe_by_gsis_prefers_real_model():
    weekly, picks = _rookie_world()
    # draft p1 (who HAS 2023 weekly history) in the 2023 class:
    import pandas as _pd
    picks = _pd.concat([picks, _pd.DataFrame([
        {"season": 2023, "round": 1, "pick": 3, "team": "AAA",
         "gsis_id": "p1", "player_name": "Someone Else", "position": "WR",
         "age": 21.0, "college": "State"}])], ignore_index=True)
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9),
                              draft_picks=picks)
    p1_rows = [p for p in board["players"] if p["player_id"] == "p1"]
    assert len(p1_rows) == 1 and p1_rows[0]["rookie"] is False


def test_rookie_dedupe_by_name_position():
    weekly, picks = _rookie_world()
    import pandas as _pd
    # placeholder id, but same normalized name+position as veteran p1 (WR "P One")
    vet_name = [p for p in build_draft_board(
        weekly, _sched_with_future(), _QuantileStub(), 2023, "2023-10-15",
        weeks=range(7, 9))["players"] if p["player_id"] == "p1"][0]["name"]
    vet_pos = "WR"
    picks = _pd.concat([picks, _pd.DataFrame([
        {"season": 2023, "round": 2, "pick": 40, "team": "AAA",
         "gsis_id": "PLACEHOLDER9", "player_name": vet_name,
         "position": vet_pos, "age": 21.0, "college": "State"}])],
        ignore_index=True)
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9),
                              draft_picks=picks)
    assert sum(1 for p in board["players"] if p["name"] == vet_name) == 1


def test_empty_target_class_fails_loud():
    weekly, picks = _rookie_world()
    picks = picks[picks["season"] != 2023]
    with pytest.raises(RuntimeError, match="draft class"):
        build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                          2023, "2023-10-15", weeks=range(7, 9),
                          draft_picks=picks)
```

Note: `_history()`'s p1 is a WR (receiving stats) named per the fixture — read `tests/test_future.py`'s `_history` before finalizing `test_rookie_dedupe_by_name_position`; use p1's actual `player_display_name` and position from the fixture. If `make_weekly` defaults differ (team/opponent), pass explicit team "AAA" so byes resolve.

- [ ] **Step 2: Run tests to verify they fail**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_site_draft.py -v`
Expected: new tests FAIL (`unexpected keyword argument 'draft_picks'`); existing PASS.

- [ ] **Step 3: Implement in `src/ffmodel/site/draft.py`**

1. Signature (currently line 243) gains a keyword-only param after `sleeper_players`:

```python
def build_draft_board(weekly: pd.DataFrame, schedules: pd.DataFrame, predictor,
                      season: int, data_through: str, weeks=range(1, 19),
                      prefit: bool = False, *, n_draws: int = 2000, seed: int = 0,
                      games_dist: dict[str, np.ndarray] | None = None,
                      diagnostics: dict | None = None,
                      sleeper_players: dict | None = None,
                      draft_picks: pd.DataFrame | None = None,
                      rookie_min_n: int | None = None) -> dict:
```

2. After the `players.empty` check and the existing `team_weeks`/`_bye` setup, but BEFORE `players["bye"] = ...`, insert:

```python
    rookie_prior_meta = None
    players["rookie"] = False
    if draft_picks is not None:
        rookie_rows, rookie_prior_meta = _rookie_frame(
            weekly, draft_picks, season, players, team_weeks, weeks_list,
            n_draws=n_draws, seed=seed, rookie_min_n=rookie_min_n)
        players = pd.concat([players, rookie_rows], ignore_index=True)
```

3. Add the helper (above `build_draft_board`):

```python
def _rookie_frame(weekly, draft_picks, season, players, team_weeks, weeks_list,
                  *, n_draws, seed, rookie_min_n):
    """Rookie rows for the target season's draft class, on the veterans'
    scale: cohort weekly triples -> simulate_season -> season quantiles.
    Dedupe: a drafted player already carrying weekly history (by gsis id,
    or by normalized name+position against the veteran board) gets the
    real model only."""
    from ffmodel.eval.diagnose import weekly_residual_icc
    from ffmodel.model.rookie import fit_rookie_cohorts, rookie_projection
    from ffmodel.site.sleeper import _normalize_name

    cls = draft_picks[draft_picks["season"] == season]
    if cls.empty:
        raise RuntimeError(f"draft class for season {season} is empty — "
                           "aborting (data problem, not a skip)")
    kwargs = {} if rookie_min_n is None else {"min_n": rookie_min_n}
    cohorts = fit_rookie_cohorts(weekly, draft_picks[draft_picks["season"] < season],
                                 through_season=season - 1, **kwargs)
    try:
        rho_map = rho_from_icc(weekly_residual_icc(
            weekly, through_season=int(weekly["season"].max())))
    except ValueError:
        rho_map = {}

    known_ids = set(weekly["player_id"])
    vet_keys = {(_normalize_name(n), p)
                for n, p in zip(players["name"], players["position"])}
    rng = np.random.default_rng(seed + 1)   # distinct stream from the vets'
    rows = []
    for _, r in cls.iterrows():
        if r["gsis_id"] in known_ids:
            continue                                    # real model wins
        if (_normalize_name(r["player_name"]), r["position"]) in vet_keys:
            continue
        scheduled = int(team_weeks[team_weeks["team"] == r["team"]]["week"]
                        .isin(weeks_list).sum())
        if scheduled == 0:
            scheduled = len(weeks_list)                 # toy schedules: play on
        frames, games_probs = rookie_projection(
            cohorts, r["position"], int(r["round"]), int(r["pick"]))
        row = {"player_id": r["gsis_id"], "name": r["player_name"],
               "team": r["team"], "position": r["position"],
               "games": scheduled, "rookie": True}
        for rn, rules in RULESETS.items():
            pts = fantasy_points_quantiles(frames, rules)
            triple = (float(pts["p10"].iloc[0]), float(pts["p50"].iloc[0]),
                      float(pts["p90"].iloc[0]))
            sim = simulate_season(np.array([triple] * scheduled), games_probs,
                                  n_draws, rng,
                                  rho=rho_map.get(r["position"], 0.0))
            row[f"{rn}_p10"] = sim["p10"]
            row[f"{rn}_p50"] = sim["p50"]
            row[f"{rn}_p90"] = sim["p90"]
        rows.append(row)
    meta = {"classes": f"2012–{season - 1}",
            "n_rookies": len(rows),
            "min_n": cohorts["min_n"],
            "buckets": {pos: d["merge_map"]
                        for pos, d in cohorts["positions"].items()}}
    columns = ["player_id", "name", "team", "position",
               *[f"{rn}_{q}" for rn in RULESETS for q in ("p10", "p50", "p90")],
               "games", "rookie"]
    return pd.DataFrame(rows, columns=columns), meta
```

4. `_finalize_board` (line ~200): signature gains `rookie_prior: dict | None = None`; in the returned dict, methodology gets the block only when present, and each player dict gains the flag tolerant of legacy frames:

```python
        # in the methodology dict, after "n_draws":
        # (build the dict, then:)
    if rookie_prior is not None:
        payload["methodology"]["rookie_prior"] = rookie_prior
```

(i.e. assign `payload = { ... }` first, then conditionally attach.) And in the per-player dict add:

```python
            "rookie": bool(row["rookie"]) if "rookie" in row.index else False,
```

5. The `build_draft_board` tail passes the meta through:

```python
    payload = _finalize_board(players, predictor.name, season, data_through,
                              has_bands, n_draws, rookie_prior=rookie_prior_meta)
```

6. `src/ffmodel/site/generate.py`: in `main()`, inside the existing `if args.draft:` block (after the sleeper pull), add:

```python
        from ffmodel.data.pull import pull_draft_picks

        draft_picks = pull_draft_picks(list(range(2012, args.season + 1)),
                                       cache_dir=args.data_dir)
```

initialize `draft_picks = None` next to `sleeper_players = None`, and extend the board call:

```python
        payloads["draft.json"] = build_draft_board(
            weekly, schedules, predictor, args.season, data_through, prefit=True,
            sleeper_players=sleeper_players, draft_picks=draft_picks)
```

Also add the imports draft.py now needs at module top: `from ffmodel.model.simulate import ... rho_from_icc` is already imported (line 10 imports `games_probs_from_counts, rho_from_icc, simulate_season`) — verify and reuse; `RULESETS` is already imported from `ffmodel.site.weekly` (line 12).

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_site_draft.py tests/test_generate.py -v`
Expected: all PASS (generate's stubbed harness passes `draft_picks` through the same monkeypatch capture — extend `test_generate.py`'s `fake_board` capture with `capture["draft_picks"] = k.get("draft_picks")` and monkeypatch `ffmodel.data.pull.pull_draft_picks` to a stub in `_run_generate_with_stubs`; add one assertion to the draft-run test that it is not None, and the weekly-only boom-stub principle extends: monkeypatch `pull_draft_picks` to raise in the weekly-only test).

- [ ] **Step 5: Full suite**

Run: `$env:PYTHONPATH = "src"; python -m pytest -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ffmodel/site/draft.py src/ffmodel/site/generate.py tests/test_site_draft.py tests/test_generate.py
git commit -m "feat: draft board appends rookie cohort rows, jointly VORP-ranked"
```

---

### Task 5: Site — R chip, about copy, footer

**Files:**
- Modify: `site/index.html`
- Modify: `site/assets/style.css`
- Modify: `site/about.html`

**Interfaces:**
- Consumes: `p.rookie` boolean on board players (Task 4).
- Produces: visible R chip; about-page "Rookies" section; footer mention.

- [ ] **Step 1: R chip in the board render**

In `site/index.html`'s row template, change the name cell from
`<td>${FC.esc(p.name)}</td>` to:

```js
        <td>${FC.esc(p.name)}${p.rookie ? ' <span class="rookie-chip" title="rookie — draft-capital cohort prior">R</span>' : ""}</td>
```

- [ ] **Step 2: Chip style**

Append to `site/assets/style.css`:

```css
/* -- rookie chip ---------------------------------------------------------- */
.rookie-chip {
  display: inline-block; margin-left: .35rem; padding: 0 .3rem;
  font: 600 .7rem/1.5 "Barlow Condensed", sans-serif; letter-spacing: .06em;
  border: 1px solid var(--te); border-radius: 3px; color: var(--te);
}
```

- [ ] **Step 3: About copy**

Read `site/about.html` first to match its structure (static `.prose` sections). Add a "Rookies" section with exactly this copy:

```html
<h2>Rookies</h2>
<div class="prose">
<p>Drafted rookies have no NFL games to model, so they get an empirical
prior instead: we group every drafted QB/RB/WR/TE since 2012 by position
and draft capital (top-12 picks, rest of round 1, round 2, round 3, day
3), and a 2026 rookie inherits the distribution of what players with his
draft profile actually did as rookies — including the ones who never
played a snap. That zero-games outcome is kept in the math, which is why
rookie floors are low and rookie bands are wide.</p>
<p class="lim">This makes rookie ranks look conservative next to draft-hype
ADP — historically, that conservatism has been the accurate call on
average, and the p90 ceiling still shows the upside case. Limitations we
accept and label: games played and per-game quality are treated as
independent within a cohort, and undrafted rookies aren't projected at
all. The walk-forward rookie backtest behind this lives in
models/diagnostics/.</p>
</div>
```

- [ ] **Step 4: Footer sentence**

In `site/index.html`'s `<footer>`, append after "…don't chase.":

```
Rookies (marked R) carry draft-capital cohort priors — wide bands on
purpose; see the about page.
```

- [ ] **Step 5: Verify + commit**

Serve `python -m http.server 8001 --directory site`, curl `/` and `/about.html` for 200 + presence of `rookie-chip` and `<h2>Rookies</h2>`; kill server. Run `$env:PYTHONPATH = "src"; python -m pytest -q` (unchanged, proves nothing broke). Commit:

```bash
git add site/index.html site/assets/style.css site/about.html
git commit -m "feat: rookie chip + honest rookie methodology copy"
```

---

### Task 6: Live verification, regeneration, data commit

Verification task (coordinator-driven, like the sleeper Task 7): real network + real model.

- [ ] **Step 1:** Confirm Task 3's committed `models/diagnostics/rookie_backtest.json`: gate1 verdict + coverage numbers; if gate1 failed, confirm Task 4 was built with the position-only STOP fallback (coordinator adjudication, recorded in the ledger).
- [ ] **Step 2:** Regenerate: `python -u -m ffmodel.site.generate --out site/data --model transformer --artifact-root "models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44" --season 2026 --draft` (background, minutes). Verify: player count ≈ 616 + ~80 rookies − dedupes; `crosswalk` stats sane (rookies match by name — unmatched count should NOT balloon; Sleeper's dump carries all drafted rookies); rookies present with `"rookie": true`, wide bands, plausible slots (top-12 RB around RB15–20 per the base rates).
- [ ] **Step 3:** Browser check: R chips render; rookie rows strike in draft mode (their sleeper_ids resolved via name fallback); about page section renders; zero console errors.
- [ ] **Step 4:** Full suite; commit `site/data` (and `data/raw` stays gitignored); ledger the results.

---

## Verification sweep (after all tasks)

- `$env:PYTHONPATH = "src"; python -m pytest -q` — green, warnings-as-errors.
- Spec walk: every error-table row has a test or a live verification.
- The gates were measured BEFORE integration and never tuned — check the git order: rookie_backtest.json commits in Task 3, board integration in Task 4.
