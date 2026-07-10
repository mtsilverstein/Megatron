# Plan 3a: Future-Week Inference, Draft Values & Site JSON — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the static site consumes, as tested Python: model-ready feature rows for weeks that haven't happened yet, weekly projection payloads, a VORP-ordered draft board for 2026, and a fail-safe CLI that writes the site's JSON atomically.

**Architecture:** A future-week skeleton generator reuses `build_features` verbatim (rows with NaN stats — lags shift past them, so leak-freedom is inherited, not re-proven). Site payload builders are pure functions over (features, predictor) pairs; any `Predictor` works, so the site can launch on XGBoost today and switch to the transformer artifact with a flag when GPU training lands. Plan 3b (static site + GitHub Actions) consumes these JSONs.

**Tech Stack:** Existing project stack; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-fantasy-football-model-design.md` §7 (draft values), §8 (site), §9 (fail-safe).

## Global Constraints

- Leak-freedom: future rows carry NaN stats and contribute nothing to any feature; every feature on a future row derives from strictly-prior real games.
- Site payloads carry raw stat-line quantiles AND precomputed points under ppr/half_ppr/standard (points come only from `ffmodel.scoring.fantasy_points`).
- Draft methodology (spec §7): all 2026 weeks are seeded from end-of-2025 form (input sequences do NOT roll forward over predicted games); season p50 = sum of weekly p50s; bands = sum of weekly p10/p90 (a documented approximation — sums of quantiles are wider than quantiles of sums); board ordered by VORP with explicit replacement ranks.
- Fail-safe (spec §9): the generate CLI validates inputs first and writes JSON atomically (temp file + rename); any failure exits nonzero leaving prior outputs untouched. Every payload has a `generated_at` UTC timestamp and `data_through` (latest real game date used).
- Model-agnostic: builders take any harness `Predictor`; quantile fields are null when the predictor has no `predict_quantiles`.
- Rookies with zero NFL games are OUT of v1 draft board/projections (documented site limitation; position-prior rows for named rookies need a 2026 roster source — deferred to a gated follow-up like snap counts was).
- Zero-warning suite; integration tests marked; QB/RB/WR/TE; free tiers only.

---

### Task 1: Future-week feature frames

**Files:**
- Create: `src/ffmodel/data/future.py`
- Test: `tests/test_future.py`

**Interfaces:**
- Consumes: canonical weekly + schedules frames, `build_features`.
- Produces:
  - `future_skeleton(weekly: pd.DataFrame, schedules: pd.DataFrame, season: int, week: int) -> pd.DataFrame` — one canonical-schema row per eligible player: players whose most recent real game is in `season` or `season - 1`, team = their most recent team, joined to the (season, week) schedule; players whose team has no game that week (bye) are excluded. All stat columns NaN, `target_share`/`snap_pct` NaN, `fantasy_points_ppr` NaN.
  - `combined_future_features(weekly, schedules, season, week) -> tuple[pd.DataFrame, pd.DataFrame]` — `(combined, future)`: the full feature frame over history + skeleton, and the future-row slice of it (index preserved, `player_display_name` intact).
  - `build_future_features(weekly, schedules, season, week) -> pd.DataFrame` — convenience wrapper returning just `future`.
  - **`TransformerPredictor.attach_features(features)`** (modify `src/ffmodel/model/predictor.py`): repoints the predictor's stored feature frame. REQUIRED because the predictor resolves test rows by index inside its stored frame — future rows only exist in the freshly built combined frame, so site code must attach it before predicting. Duck-typed: site code calls it only `if hasattr(predictor, "attach_features")`; XGBoost/naive don't need it.

- [ ] **Step 1: Write the failing tests**

`tests/test_future.py`:

```python
import numpy as np
import pandas as pd
import pytest

from ffmodel.data.features import feature_columns
from ffmodel.data.future import build_future_features, future_skeleton
from ffmodel.scoring import PREDICTED_STATS

from tests.test_features import make_schedules, make_weekly


def _history():
    rows = []
    for week in range(1, 7):
        rows.append({"player_id": "p1", "week": week, "receiving_yards": 50.0 + week})
        rows.append({"player_id": "p2", "week": week, "position": "RB",
                     "team": "BBB", "opponent_team": "AAA", "rushing_yards": 40.0})
    return make_weekly(rows)


def _sched_with_future():
    sched = make_schedules(8)          # weeks 1-8, AAA hosts BBB
    return sched


def test_skeleton_rows_only_for_scheduled_teams():
    weekly = _history()
    sk = future_skeleton(weekly, _sched_with_future(), season=2023, week=7)
    assert set(sk["player_id"]) == {"p1", "p2"}
    assert (sk["season"] == 2023).all() and (sk["week"] == 7).all()
    p1 = sk[sk["player_id"] == "p1"].iloc[0]
    assert p1["team"] == "AAA" and p1["opponent_team"] == "BBB"
    assert np.isnan(sk[PREDICTED_STATS].to_numpy()).all()


def test_skeleton_excludes_bye_teams():
    weekly = _history()
    sched = _sched_with_future()
    sched = sched[sched["week"] != 7]  # nobody plays week 7
    sk = future_skeleton(weekly, sched, season=2023, week=7)
    assert len(sk) == 0


def test_future_features_lags_from_history_only():
    weekly = _history()
    future = build_future_features(weekly, _sched_with_future(), season=2023, week=7)
    p1 = future[future["player_id"] == "p1"].iloc[0]
    # lag4 over weeks 3-6: mean(53, 54, 55, 56) = 54.5
    assert p1["lag4_receiving_yards"] == pytest.approx(54.5)
    assert p1["games_prior"] == 6
    assert p1["is_home"] == 1
    # future rows only, labels are NaN
    assert (future["week"] == 7).all()
    assert np.isnan(future[PREDICTED_STATS].to_numpy()).all()


def test_future_rows_do_not_pollute_history_features():
    weekly = _history()
    future = build_future_features(weekly, _sched_with_future(), season=2023, week=7)
    assert set(feature_columns(future)) == set(feature_columns(
        build_future_features(weekly, _sched_with_future(), season=2023, week=8)))
    # opponent-allowed for the future week must come from real prior weeks
    p1 = future[future["player_id"] == "p1"].iloc[0]
    assert np.isfinite(p1["opp_allowed_last4"])


def test_player_last_seen_two_seasons_ago_is_excluded():
    old = make_weekly([{"player_id": "old", "season": 2021, "week": 1}])
    recent = _history()
    weekly = pd.concat([old, recent], ignore_index=True)
    sk = future_skeleton(weekly, _sched_with_future(), season=2023, week=7)
    assert "old" not in set(sk["player_id"])


def test_combined_contains_future_rows_by_index():
    weekly = _history()
    combined, future = __import__("ffmodel.data.future", fromlist=["x"]) \
        .combined_future_features(weekly, _sched_with_future(), 2023, 7)
    assert future.index.isin(combined.index).all()
    assert len(combined) == len(future) + 12  # 2 players x 6 real weeks
```

Also append to `tests/test_predictor.py` (uses the existing `trained` fixture):

```python
def test_attach_features_enables_prediction_on_extended_frame(trained):
    root, features = trained
    p = TransformerPredictor(root, features.iloc[0:0])  # constructed with empty frame
    p.fit(features[features["season"] <= 2022])
    test = features[features["season"] == 2023]
    with pytest.raises(ValueError, match="missing"):
        p.predict_quantiles(test)
    p.attach_features(features)
    qs = p.predict_quantiles(test)
    assert qs["p50"].index.equals(test.index)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_future.py -v`
Expected: FAIL — `ModuleNotFoundError: ffmodel.data.future`.

- [ ] **Step 3: Write the implementation**

`src/ffmodel/data/future.py`:

```python
"""Feature rows for weeks that have not been played yet.

A future row is a canonical weekly row with every stat NaN. Reusing
build_features on (history + skeleton) inherits leak-freedom: lag features
shift past the current row, so NaN stats contribute nothing anywhere.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ffmodel.data.features import build_features
from ffmodel.data.pull import CONTEXT_COLUMNS
from ffmodel.scoring import PREDICTED_STATS, SCORING_EXTRAS

_NAN_COLUMNS = PREDICTED_STATS + SCORING_EXTRAS + [
    "target_share", "snap_pct", "fantasy_points_ppr",
]


def future_skeleton(weekly: pd.DataFrame, schedules: pd.DataFrame,
                    season: int, week: int) -> pd.DataFrame:
    ordered = weekly.sort_values(["player_id", "season", "week"])
    latest = ordered.groupby("player_id").tail(1)
    active = latest[latest["season"] >= season - 1]

    games = schedules[(schedules["season"] == season) & (schedules["week"] == week)]
    home = games.rename(columns={"home_team": "team", "away_team": "opponent_team"})
    away = games.rename(columns={"away_team": "team", "home_team": "opponent_team"})
    matchups = pd.concat([home, away])[["team", "opponent_team"]]

    rows = active[["player_id", "player_display_name", "position", "team"]].merge(
        matchups, on="team", how="inner"          # bye teams drop out here
    )
    rows["season"] = season
    rows["week"] = week
    for col in _NAN_COLUMNS:
        rows[col] = np.nan
    return rows[CONTEXT_COLUMNS + _NAN_COLUMNS].reset_index(drop=True)


def combined_future_features(weekly: pd.DataFrame, schedules: pd.DataFrame,
                             season: int, week: int
                             ) -> tuple[pd.DataFrame, pd.DataFrame]:
    skeleton = future_skeleton(weekly, schedules, season, week)
    combined = pd.concat([weekly, skeleton], ignore_index=True)
    features = build_features(combined, schedules)
    mask = (features["season"] == season) & (features["week"] == week) \
        & features[PREDICTED_STATS[0]].isna()
    return features, features[mask]


def build_future_features(weekly: pd.DataFrame, schedules: pd.DataFrame,
                          season: int, week: int) -> pd.DataFrame:
    return combined_future_features(weekly, schedules, season, week)[1]
```

Note: the mask keeps NaN-stat rows only, so a real (already played) row for the same (season, week) is never returned as "future".

And in `src/ffmodel/model/predictor.py`, add below `__init__`:

```python
    def attach_features(self, features: pd.DataFrame) -> None:
        """Repoint the stored feature frame (e.g. one extended with
        future-week rows). Sequences are always built from this frame, so
        test rows must exist in it by index."""
        self.features = features
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_future.py -v`
Expected: 5 passed. Then the full suite — all green (existing tests untouched).

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/data/future.py src/ffmodel/model/predictor.py tests/test_future.py tests/test_predictor.py
git commit -m "feat: future-week feature frames via NaN-stat skeleton rows"
```

---

### Task 2: Weekly projections payload

**Files:**
- Create: `src/ffmodel/site/__init__.py` (empty)
- Create: `src/ffmodel/site/weekly.py`
- Test: `tests/test_site_weekly.py`

**Interfaces:**
- Consumes: a fitted `Predictor` (point or quantile), a future feature frame, `fantasy_points`, `HALF_PPR`, `STANDARD`, `PPR`.
- Produces: `build_weekly_projections(future: pd.DataFrame, predictor, season: int, week: int, data_through: str) -> dict` with schema:

```
{
  "generated_at": iso8601-utc, "data_through": "YYYY-MM-DD",
  "season": int, "week": int, "model": predictor.name, "has_bands": bool,
  "players": [{
    "player_id", "name", "team", "opponent", "position", "is_home": bool,
    "points": {"ppr": {"p50": float, "p10": float|null, "p90": float|null},
               "half_ppr": {...}, "standard": {...}},
    "stats_p50": {stat: float for the 11 PREDICTED_STATS}
  }, ...]  # sorted by points.ppr.p50 descending
}
```

- [ ] **Step 1: Write the failing tests**

`tests/test_site_weekly.py`:

```python
import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.baseline.naive import NaiveLast4
from ffmodel.data.future import build_future_features
from ffmodel.site.weekly import build_weekly_projections
from ffmodel.scoring import PREDICTED_STATS

from tests.test_future import _history, _sched_with_future


class _QuantileStub:
    name = "stub"

    def fit(self, train):
        pass

    def predict(self, test):
        return self.predict_quantiles(test)["p50"]

    def predict_quantiles(self, test):
        base = pd.DataFrame(0.0, index=test.index, columns=PREDICTED_STATS)
        base["receiving_yards"] = 80.0
        base["receptions"] = 5.0
        return {"p10": base * 0.5, "p50": base.copy(), "p90": base * 1.5}


def _future():
    weekly = _history()
    future = build_future_features(weekly, _sched_with_future(), 2023, 7)
    return weekly, future


def test_payload_schema_and_scoring():
    weekly, future = _future()
    stub = _QuantileStub()
    payload = build_weekly_projections(future, stub, 2023, 7, data_through="2023-10-15")
    assert payload["has_bands"] is True and payload["model"] == "stub"
    top = payload["players"][0]
    # 80*0.1 + 5 = 13.0 PPR; half = 10.5; standard = 8.0
    assert top["points"]["ppr"]["p50"] == pytest.approx(13.0)
    assert top["points"]["half_ppr"]["p50"] == pytest.approx(10.5)
    assert top["points"]["standard"]["p50"] == pytest.approx(8.0)
    assert top["points"]["ppr"]["p10"] == pytest.approx(6.5)
    assert set(top["stats_p50"]) == set(PREDICTED_STATS)
    json.dumps(payload)  # strictly serializable


def test_sorted_by_ppr_p50_desc():
    weekly, future = _future()
    payload = build_weekly_projections(future, _QuantileStub(), 2023, 7, "2023-10-15")
    p50s = [p["points"]["ppr"]["p50"] for p in payload["players"]]
    assert p50s == sorted(p50s, reverse=True)


def test_point_only_predictor_has_null_bands():
    weekly, future = _future()
    from ffmodel.data.features import build_features

    model = NaiveLast4()
    model.fit(build_features(weekly, _sched_with_future()))
    payload = build_weekly_projections(future, model, 2023, 7, "2023-10-15")
    assert payload["has_bands"] is False
    top = payload["players"][0]
    assert top["points"]["ppr"]["p10"] is None and top["points"]["ppr"]["p90"] is None
    json.dumps(payload)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_site_weekly.py -v`
Expected: FAIL — `ModuleNotFoundError: ffmodel.site`.

- [ ] **Step 3: Write the implementation**

`src/ffmodel/site/__init__.py`: empty.

`src/ffmodel/site/weekly.py`:

```python
"""Weekly projections payload for the static site."""
from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from ffmodel.scoring import HALF_PPR, PPR, PREDICTED_STATS, STANDARD, fantasy_points

RULESETS = {"ppr": PPR, "half_ppr": HALF_PPR, "standard": STANDARD}


def _quantile_frames(future: pd.DataFrame, predictor) -> dict[str, pd.DataFrame | None]:
    if hasattr(predictor, "predict_quantiles"):
        qs = predictor.predict_quantiles(future)
        return {"p10": qs["p10"], "p50": qs["p50"], "p90": qs["p90"]}
    return {"p10": None, "p50": predictor.predict(future), "p90": None}


def build_weekly_projections(future: pd.DataFrame, predictor, season: int,
                             week: int, data_through: str) -> dict:
    frames = _quantile_frames(future, predictor)
    points = {
        rules_name: {
            q: (None if frame is None else fantasy_points(frame, rules))
            for q, frame in frames.items()
        }
        for rules_name, rules in RULESETS.items()
    }
    p50_stats = frames["p50"]

    players = []
    for idx, row in future.iterrows():
        players.append({
            "player_id": row["player_id"],
            "name": row["player_display_name"],
            "team": row["team"],
            "opponent": row["opponent_team"],
            "position": row["position"],
            "is_home": bool(row["is_home"]),
            "points": {
                rules_name: {
                    q: (None if series is None else round(float(series.loc[idx]), 2))
                    for q, series in by_q.items()
                }
                for rules_name, by_q in points.items()
            },
            "stats_p50": {s: round(float(p50_stats.loc[idx, s]), 2)
                          for s in PREDICTED_STATS},
        })
    players.sort(key=lambda p: p["points"]["ppr"]["p50"], reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_through": data_through,
        "season": season, "week": week,
        "model": predictor.name,
        "has_bands": frames["p10"] is not None,
        "players": players,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_site_weekly.py -v` → 3 passed; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/site/ tests/test_site_weekly.py
git commit -m "feat: weekly projections site payload"
```

---

### Task 3: Draft board payload (season roll + VORP + tiers)

**Files:**
- Create: `src/ffmodel/site/draft.py`
- Test: `tests/test_site_draft.py`

**Interfaces:**
- Consumes: weekly history + full-season schedules for the target season, a predictor, Task 1's future frames, Task 2's `RULESETS`.
- Produces:
  - `REPLACEMENT_RANK = {"QB": 13, "RB": 25, "WR": 25, "TE": 13}` (12-team league: last starter-ish slot +1; module constant with comment).
  - `season_projection(weekly, schedules, predictor, season, weeks) -> pd.DataFrame` — per player: `season_p50/p10/p90` (PPR), `games` (non-bye scheduled weeks), plus identity columns. All weeks seeded from the same pre-season history (spec §7).
  - `build_draft_board(weekly, schedules, predictor, season, data_through, weeks=range(1, 19)) -> dict`:

```
{"generated_at", "data_through", "season", "model", "has_bands",
 "methodology": {"seeding": "end-of-prior-season form", "bands": "sum of weekly quantiles (approximation)",
                 "replacement_rank": {...}},
 "players": [{"player_id","name","team","position",
              "season_points": {"ppr": {"p50","p10","p90"}},  # p10/p90 null if no bands
              "vorp": float, "position_rank": int, "tier": int}, ...]}  # sorted by vorp desc
```

  - Tiers: within each position, sorted by VORP desc, a new tier starts where the VORP drop to the next player exceeds `max(2.0, 15% of the position's VORP range)`; tier ids are 1-based per position. Deterministic, tested.

- [ ] **Step 1: Write the failing tests**

`tests/test_site_draft.py`:

```python
import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.site.draft import (
    REPLACEMENT_RANK, _assign_tiers, build_draft_board, season_projection,
)
from ffmodel.scoring import PREDICTED_STATS

from tests.test_future import _history, _sched_with_future
from tests.test_site_weekly import _QuantileStub


def test_season_projection_sums_weeks():
    weekly = _history()
    sched = _sched_with_future()          # 8 scheduled weeks
    proj = season_projection(weekly, sched, _QuantileStub(), 2023,
                             weeks=range(7, 9))   # two future weeks
    p1 = proj[proj["player_id"] == "p1"].iloc[0]
    # stub: 13.0 PPR per week x 2 weeks
    assert p1["season_p50"] == pytest.approx(26.0)
    assert p1["season_p10"] == pytest.approx(13.0)
    assert p1["games"] == 2


def test_bye_week_reduces_games():
    weekly = _history()
    sched = _sched_with_future()
    sched = sched[sched["week"] != 8]     # week 8 becomes a universal bye
    proj = season_projection(weekly, sched, _QuantileStub(), 2023, weeks=range(7, 9))
    assert (proj["games"] == 1).all()


def test_vorp_and_ordering():
    players = pd.DataFrame({
        "player_id": [f"wr{i}" for i in range(30)] + [f"rb{i}" for i in range(30)],
        "name": "x", "team": "AAA",
        "position": ["WR"] * 30 + ["RB"] * 30,
        "season_p50": list(range(300, 270, -1)) + list(range(400, 370, -1)),
        "season_p10": np.nan, "season_p90": np.nan, "games": 17,
    })
    from ffmodel.site.draft import _finalize_board

    payload = _finalize_board(players, model="m", season=2026,
                              data_through="2025-01-05", has_bands=False)
    vorps = [p["vorp"] for p in payload["players"]]
    assert vorps == sorted(vorps, reverse=True)
    top = payload["players"][0]
    assert top["position"] == "RB" and top["position_rank"] == 1
    # replacement: RB rank 25 has p50 400-24=376 -> top RB vorp = 400-376 = 24
    assert top["vorp"] == pytest.approx(24.0)
    json.dumps(payload)


def test_tier_breaks_on_gaps():
    vorp = pd.Series([50.0, 49.0, 48.0, 30.0, 29.0, 5.0])
    tiers = _assign_tiers(vorp)
    assert tiers == [1, 1, 1, 2, 2, 3]


def test_end_to_end_board():
    weekly = _history()
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9))
    assert board["has_bands"] is True
    assert board["methodology"]["replacement_rank"] == REPLACEMENT_RANK
    assert len(board["players"]) == 2
    json.dumps(board)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_site_draft.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write the implementation**

`src/ffmodel/site/draft.py`:

```python
"""Season-long draft values: weekly roll -> sums -> VORP -> tiers."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ffmodel.data.future import combined_future_features
from ffmodel.scoring import PPR, fantasy_points

# 12-team league: points above the player at this positional rank define
# value over replacement (roughly the first waiver-tier player).
REPLACEMENT_RANK = {"QB": 13, "RB": 25, "WR": 25, "TE": 13}


def season_projection(weekly: pd.DataFrame, schedules: pd.DataFrame, predictor,
                      season: int, weeks=range(1, 19)) -> pd.DataFrame:
    """All weeks seeded from the same pre-season history (spec §7)."""
    predictor.fit(_fit_frame(weekly, schedules))
    totals: dict[str, dict] = {}
    for week in weeks:
        combined, future = combined_future_features(weekly, schedules, season, week)
        if future.empty:
            continue
        if hasattr(predictor, "attach_features"):
            predictor.attach_features(combined)   # future rows live in this frame
        if hasattr(predictor, "predict_quantiles"):
            qs = predictor.predict_quantiles(future)
            week_pts = {q: fantasy_points(qs[q], PPR) for q in ("p10", "p50", "p90")}
        else:
            week_pts = {"p50": fantasy_points(predictor.predict(future), PPR),
                        "p10": None, "p90": None}
        for idx, row in future.iterrows():
            entry = totals.setdefault(row["player_id"], {
                "player_id": row["player_id"], "name": row["player_display_name"],
                "team": row["team"], "position": row["position"],
                "season_p50": 0.0, "season_p10": 0.0, "season_p90": 0.0, "games": 0,
            })
            entry["season_p50"] += float(week_pts["p50"].loc[idx])
            entry["games"] += 1
            for q in ("p10", "p90"):
                if week_pts[q] is None:
                    entry[f"season_{q}"] = np.nan
                else:
                    entry[f"season_{q}"] += float(week_pts[q].loc[idx])
    return pd.DataFrame(list(totals.values()))


def _fit_frame(weekly: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    from ffmodel.data.features import build_features

    return build_features(weekly, schedules)


def _assign_tiers(vorp_desc: pd.Series) -> list[int]:
    values = vorp_desc.to_numpy(dtype=float)
    if len(values) == 0:
        return []
    span = float(values.max() - values.min())
    threshold = max(2.0, 0.15 * span)
    tiers, tier = [1], 1
    for prev, cur in zip(values, values[1:]):
        if prev - cur > threshold:
            tier += 1
        tiers.append(tier)
    return tiers


def _finalize_board(players: pd.DataFrame, model: str, season: int,
                    data_through: str, has_bands: bool) -> dict:
    frames = []
    for pos, group in players.groupby("position"):
        group = group.sort_values("season_p50", ascending=False).reset_index(drop=True)
        rank = REPLACEMENT_RANK.get(pos, 20)
        replacement = group["season_p50"].iloc[min(rank, len(group)) - 1]
        group["vorp"] = (group["season_p50"] - replacement).round(2)
        group["position_rank"] = group.index + 1
        group["tier"] = _assign_tiers(group["vorp"])
        frames.append(group)
    board = pd.concat(frames).sort_values("vorp", ascending=False)

    def _band(value) -> float | None:
        return None if pd.isna(value) else round(float(value), 1)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_through": data_through, "season": season, "model": model,
        "has_bands": has_bands,
        "methodology": {
            "seeding": "end-of-prior-season form",
            "bands": "sum of weekly quantiles (approximation)",
            "replacement_rank": REPLACEMENT_RANK,
        },
        "players": [{
            "player_id": row["player_id"], "name": row["name"], "team": row["team"],
            "position": row["position"],
            "season_points": {"ppr": {"p50": round(float(row["season_p50"]), 1),
                                      "p10": _band(row["season_p10"]),
                                      "p90": _band(row["season_p90"])}},
            "vorp": float(row["vorp"]),
            "position_rank": int(row["position_rank"]),
            "tier": int(row["tier"]),
        } for _, row in board.iterrows()],
    }


def build_draft_board(weekly: pd.DataFrame, schedules: pd.DataFrame, predictor,
                      season: int, data_through: str, weeks=range(1, 19)) -> dict:
    players = season_projection(weekly, schedules, predictor, season, weeks)
    has_bands = hasattr(predictor, "predict_quantiles")
    return _finalize_board(players, predictor.name, season, data_through, has_bands)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_site_draft.py -v` → 5 passed; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/site/draft.py tests/test_site_draft.py
git commit -m "feat: draft board payload with VORP and gap-based tiers"
```

---

### Task 4: About-the-model payload

**Files:**
- Create: `src/ffmodel/site/about.py`
- Test: `tests/test_site_about.py`

**Interfaces:**
- Produces: `build_about(backtest_paths: list[Path], data_through: str) -> dict` — merges every backtest JSON in `models/backtests/` into `{"generated_at", "data_through", "reports": [{"source": filename, "created", "test_seasons", "scoring", "results": [...rows verbatim...]}]}`, sorted newest first by the report's own `created` stamp. Raises `ValueError` on a file missing required keys (fail-safe: bad inputs never become site content silently).

- [ ] **Step 1: Write the failing tests**

`tests/test_site_about.py`:

```python
import json
from pathlib import Path

import pytest

from ffmodel.site.about import build_about


def _report(tmp_path, name, created):
    payload = {"created": created, "seasons": [2012, 2025],
               "test_seasons": [2023], "scoring": "ppr",
               "results": [{"model": "naive_last4", "test_season": 2023,
                            "position": "OVERALL", "mae": 4.6, "rmse": 6.4, "n": 100}]}
    p = tmp_path / name
    p.write_text(json.dumps(payload))
    return p


def test_merges_and_sorts_newest_first(tmp_path):
    older = _report(tmp_path, "baselines.json", "2026-07-10T05:00:00+00:00")
    newer = _report(tmp_path, "bakeoff.json", "2026-07-12T05:00:00+00:00")
    about = build_about([older, newer], data_through="2025-01-05")
    assert [r["source"] for r in about["reports"]] == ["bakeoff.json", "baselines.json"]
    json.dumps(about)


def test_rejects_malformed_report(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"created": "x"}))
    with pytest.raises(ValueError, match="bad.json"):
        build_about([bad], data_through="2025-01-05")
```

- [ ] **Step 2: RED** — `pytest tests/test_site_about.py -v` fails with ModuleNotFoundError.

- [ ] **Step 3: Write the implementation**

`src/ffmodel/site/about.py`:

```python
"""About-the-model payload: honest backtest tables, straight from models/backtests."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

REQUIRED_KEYS = {"created", "test_seasons", "scoring", "results"}


def build_about(backtest_paths: list[Path], data_through: str) -> dict:
    reports = []
    for path in backtest_paths:
        payload = json.loads(Path(path).read_text())
        missing = REQUIRED_KEYS - payload.keys()
        if missing:
            raise ValueError(f"{Path(path).name}: missing keys {sorted(missing)}")
        reports.append({"source": Path(path).name, **{k: payload[k] for k in
                        ("created", "test_seasons", "scoring", "results")}})
    reports.sort(key=lambda r: r["created"], reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_through": data_through,
        "reports": reports,
    }
```

- [ ] **Step 4: GREEN** — 2 passed; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/site/about.py tests/test_site_about.py
git commit -m "feat: about-the-model payload from committed backtests"
```

---

### Task 5: Fail-safe site-JSON generator CLI

**Files:**
- Create: `src/ffmodel/site/generate.py`
- Test: `tests/test_generate.py`

**Interfaces:**
- CLI: `python -m ffmodel.site.generate --out site/data --model xgboost|transformer [--artifact-root models/transformer/v1] [--season 2026] [--week N | --draft] [--data-dir data/raw]`
  - `--week N` writes `weekly.json`; `--draft` writes `draft.json`; both write `about.json`. Season/week default: season = max season in schedules with games on/after today is out of scope — season is explicit (Actions passes it; no clock-guessing in v1).
- Behavior contract (spec §9 fail-safe):
  - `validate_inputs(weekly, schedules, season)` runs first: weekly nonempty, ≥ 200 rows per completed season present, schedules cover the target season; raises `RuntimeError` on failure.
  - All writes are atomic: payload → `<name>.json.tmp` → `os.replace` to final path. Any exception before replace leaves existing files untouched and exits nonzero.
  - `--model transformer` requires `--artifact-root`; a missing artifact dir must surface the predictor's FileNotFoundError (nonzero exit), never a blank payload.
  - Model fitting: predictor.fit(features of all real data) — for the transformer this selects `through{max season}`; for xgboost it trains on all history (minutes on CPU).

- [ ] **Step 1: Write the failing tests**

`tests/test_generate.py`:

```python
import json
from pathlib import Path

import pandas as pd
import pytest

from ffmodel.site.generate import _atomic_write, build_parser, validate_inputs

from tests.test_features import make_schedules, make_weekly


def test_parser_defaults_and_flags():
    args = build_parser().parse_args(["--out", "site/data", "--model", "xgboost",
                                      "--season", "2023", "--week", "7"])
    assert args.model == "xgboost" and args.week == 7 and not args.draft


def test_validate_rejects_empty_and_sparse():
    sched = make_schedules(6)
    with pytest.raises(RuntimeError, match="empty"):
        validate_inputs(make_weekly([]).iloc[0:0], sched, season=2023)
    sparse = make_weekly([{"week": 1}])
    with pytest.raises(RuntimeError, match="rows"):
        validate_inputs(sparse, sched, season=2023)


def test_validate_requires_schedule_coverage():
    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in range(1, 7) for i in range(40)])
    with pytest.raises(RuntimeError, match="schedule"):
        validate_inputs(weekly, make_schedules(6, season=2022), season=2023)


def test_atomic_write_never_leaves_partial(tmp_path):
    target = tmp_path / "weekly.json"
    target.write_text('{"old": true}')

    class Boom:
        def __iter__(self):  # break json serialization mid-flight
            raise RuntimeError("boom")

    with pytest.raises(TypeError):
        _atomic_write(target, {"players": Boom()})
    assert json.loads(target.read_text()) == {"old": True}   # untouched
    assert not list(tmp_path.glob("*.tmp"))                  # tmp cleaned up


def test_atomic_write_happy_path(tmp_path):
    target = tmp_path / "draft.json"
    _atomic_write(target, {"ok": 1})
    assert json.loads(target.read_text()) == {"ok": 1}
```

- [ ] **Step 2: RED** — ModuleNotFoundError.

- [ ] **Step 3: Write the implementation**

`src/ffmodel/site/generate.py`:

```python
"""Site-JSON generator. Fail-safe: validate first, write atomically, never
leave a broken or partial file for the site to serve (spec §9)."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import pandas as pd

MIN_ROWS_PER_SEASON = 200


def validate_inputs(weekly: pd.DataFrame, schedules: pd.DataFrame, season: int) -> None:
    if weekly.empty:
        raise RuntimeError("weekly frame is empty — refusing to generate")
    counts = weekly.groupby("season").size()
    thin = counts[counts < MIN_ROWS_PER_SEASON]
    if not thin.empty:
        raise RuntimeError(f"suspiciously few rows in season(s) {list(thin.index)} "
                           f"— data pull looks incomplete")
    if schedules[schedules["season"] == season].empty:
        raise RuntimeError(f"no schedule rows for season {season}")


def _atomic_write(path: Path, payload: dict) -> None:
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(json.dumps(payload, indent=2, allow_nan=False))
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate the site's JSON payloads.")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", choices=["xgboost", "transformer"], required=True)
    parser.add_argument("--artifact-root", type=Path, default=None)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, default=None)
    parser.add_argument("--draft", action="store_true")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    return parser


def _make_predictor(args, features: pd.DataFrame):
    if args.model == "transformer":
        if args.artifact_root is None:
            raise SystemExit("--model transformer requires --artifact-root")
        from ffmodel.model.predictor import TransformerPredictor

        return TransformerPredictor(args.artifact_root, features)
    from ffmodel.baseline.xgb import XGBBaseline

    return XGBBaseline()


def main() -> None:
    args = build_parser().parse_args()
    from ffmodel.data.features import build_features
    from ffmodel.data.future import combined_future_features
    from ffmodel.data.pull import pull_schedules, pull_weekly
    from ffmodel.site.about import build_about
    from ffmodel.site.draft import build_draft_board
    from ffmodel.site.weekly import build_weekly_projections

    seasons = list(range(args.first_season, args.season + 1))
    weekly = pull_weekly(seasons, cache_dir=args.data_dir)
    schedules = pull_schedules(seasons, cache_dir=args.data_dir)
    validate_inputs(weekly, schedules, args.season)
    latest_season = int(weekly["season"].max())
    latest_week = int(weekly[weekly["season"] == latest_season]["week"].max())
    data_through = f"{latest_season}-wk{latest_week}"

    features = build_features(weekly, schedules)
    predictor = _make_predictor(args, features)
    predictor.fit(features)

    args.out.mkdir(parents=True, exist_ok=True)
    if args.week is not None:
        combined, future = combined_future_features(weekly, schedules,
                                                    args.season, args.week)
        if hasattr(predictor, "attach_features"):
            predictor.attach_features(combined)
        payload = build_weekly_projections(future, predictor, args.season,
                                           args.week, data_through)
        _atomic_write(args.out / "weekly.json", payload)
        print(f"weekly.json: {len(payload['players'])} players")
    if args.draft:
        board = build_draft_board(weekly, schedules, predictor,
                                  args.season, data_through)
        _atomic_write(args.out / "draft.json", board)
        print(f"draft.json: {len(board['players'])} players")
    backtests = sorted(Path("models/backtests").glob("*.json"))
    _atomic_write(args.out / "about.json", build_about(backtests, data_through))
    print("about.json written")


if __name__ == "__main__":
    main()
```

(The transformer path is exercised indirectly by `test_attach_features_enables_prediction_on_extended_frame` from Task 1; the CLI-level transformer run happens for real once GPU artifacts exist.)

- [ ] **Step 4: GREEN** — 5 passed; full suite green.

- [ ] **Step 5: Real-data acceptance run (XGBoost path)**

Run: `.venv/Scripts/python.exe -m ffmodel.site.generate --out "$TEMP/site-data" --model xgboost --season 2025 --week 18 --draft`
Expected: completes in a few minutes (XGB trains on full history); prints player counts (weekly ~300+, draft ~200+); the three JSONs parse; spot-check the draft board's top-10 names are plausible 2025 fantasy stars. Record the top-10 in the report. (Season 2025 is used because 2026 schedules may not be in the cached range — this validates mechanics; the real 2026 run happens in Plan 3b/production.)

- [ ] **Step 6: Commit**

```bash
git add src/ffmodel/site/generate.py tests/test_generate.py
git commit -m "feat: fail-safe atomic site-JSON generator CLI"
```

---

## Done criteria for Plan 3a

- Full suite green, zero warnings; all new payload schemas covered by tests.
- Real-data acceptance run produces plausible weekly + draft + about JSONs with the XGBoost path (transformer path activates when GPU artifacts land — same flag, no code change).
- Fail-safe behaviors test-pinned: input validation raises before any write; atomic writes never leave partial/corrupt files.

**Next (Plan 3b):** static site pages (draft board, weekly, about) + GitHub Actions weekly cron + Pages deploy — written after this plan ships. Design work in 3b should use the frontend-design skill.
