# Consensus-Anchored Draft Board + Keeper Gauge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-anchor the draft board's ranking to expert consensus (ECR), demote the model to floor/ceiling bands + the value curve, add ADP as a market/keeper overlay, and add a manual keeper-value gauge — the measured-best draft edge for the user's 12-team 1-QB PPR keeper league.

**Architecture:** ECR sets the intra-position order; the model's `ppr_p50` values, sorted descending and laid onto that order, set the value curve (VORP/tiers/VONA); each player's own model p10/p90 stay the bands. The fusion lives in one pure module (`board_rank.py`) that `draft.py` calls; with no ECR it reduces *exactly* to today's model ordering, so the existing suite is untouched. ADP is a best-effort overlay; ECR is the required spine. A client-side keeper panel reads the board's ADP.

**Tech Stack:** Python (pandas, numpy, nflreadpy), pytest; vanilla browser JS (no framework/build); FantasyFootballCalculator JSON API (ADP), FantasyPros ECR via nflreadpy.

## Global Constraints

- **Walk-forward / leak-safe only.** ECR snapshot must be strictly before kickoff (already enforced in `rankings.py`); ADP is pre-draft by construction. Never a random split.
- **Scope guard: QB/RB/WR/TE only.** No K/DST/IDP.
- **Free tiers only.** No paid infra; ECR + ADP are the two free APIs.
- **Fail-safe generation.** On a failed *required* pull (ECR), abort before writing any site JSON. ADP failure degrades visibly, never silently.
- **`models/backtests/` is schema-locked**; diagnostics go to `models/diagnostics/`. This plan touches neither.
- **Tests run** `PYTHONPATH=src python -m pytest`, and CI adds `-W error`. Run `-W error` locally before every commit.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Spec:** `docs/superpowers/specs/2026-07-25-consensus-anchored-board-design.md` — the source of truth.

## File Structure

- `src/ffmodel/data/adp.py` **(new)** — pull + crosswalk FFCalculator ADP to `gsis_id`.
- `src/ffmodel/site/board_rank.py` **(new)** — pure fusion: `order_and_value`, `adp_round`, `flex_replacement_ranks`, `rank_board`; owns `_assign_tiers` (moved from `draft.py`).
- `src/ffmodel/site/draft.py` **(modify)** — `_finalize_board` calls `board_rank`; `build_draft_board`/`_finalize_board` gain `ecr`/`adp`/`replacement_rank`; payload gains `ecr`/`adp`/`adp_round`; re-exports `_assign_tiers`.
- `src/ffmodel/site/generate.py` **(modify)** — `--draft` pulls ECR (required) + ADP (best-effort) via a testable `_draft_consensus` helper; **derives** flex-aware replacement from the ECR pool (`flex_replacement_ranks`) and passes it to the board build.
- `site/index.html` **(modify)** — ADP + ECR columns, `colspan` bump, "how to read" copy, keeper-panel container, `keepers.js` include + init.
- `site/about.html` + `docs/methodology.md` **(modify)** — disclose consensus-anchored ranking.
- `site/assets/keepers.js` **(new)** — keeper surplus math + panel wiring (dual browser/CJS export).
- `tests/test_adp.py`, `tests/test_board_rank.py` **(new)**; `tests/test_site_draft.py`, `tests/test_generate.py` **(modify)**; `tests/keepers_fixture.cjs` **(new, node)**.

---

## Task 1: ADP pull + crosswalk (`data/adp.py`)

**Files:**
- Create: `src/ffmodel/data/adp.py`
- Test: `tests/test_adp.py`

**Interfaces:**
- Consumes: `ffmodel.data.rankings.pull_player_ids(cache_dir)` → frame with `gsis_id`, `merge_name`; `ffmodel.data.pull._cached(cache_dir, name, load)`.
- Produces: `normalize_adp(raw: dict, crosswalk: pd.DataFrame) -> pd.DataFrame` with columns `player_id, name, position, adp, stdev, times_drafted`; `pull_adp(season: int, cache_dir=None, teams=12, scoring="ppr") -> pd.DataFrame` (same columns).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_adp.py
import pandas as pd
import pytest

from ffmodel.data.adp import normalize_adp


def _crosswalk():
    # merge_name is lowercase in ff_playerids (matches rankings._merge_key)
    return pd.DataFrame({
        "gsis_id": ["00-1", "00-2", "00-3", "00-4"],
        "merge_name": ["marquise brown", "kenneth gainwell", "aj brown", "patrick mahomes"],
    })


def _raw():
    # FFCalculator /adp JSON shape
    return {"players": [
        {"name": "Hollywood Brown", "position": "WR", "adp": 95.4, "stdev": 12.0, "times_drafted": 40},
        {"name": "Kenny Gainwell", "position": "RB", "adp": 140.1, "stdev": 9.0, "times_drafted": 22},
        {"name": "A.J. Brown", "position": "WR", "adp": 12.3, "stdev": 4.0, "times_drafted": 88},
        {"name": "Patrick Mahomes II", "position": "QB", "adp": 40.0, "stdev": 6.0, "times_drafted": 70},
        {"name": "Some Kicker", "position": "K", "adp": 200.0, "stdev": 3.0, "times_drafted": 5},
    ]}


def test_normalize_adp_crosswalks_nicknames_suffixes_and_drops_out_of_scope():
    out = normalize_adp(_raw(), _crosswalk())
    # K is out of scope -> dropped; the other four crosswalk via nickname/suffix norm
    assert set(out["position"]) == {"WR", "RB", "QB"}
    by_id = dict(zip(out["player_id"], out["adp"]))
    assert by_id["00-1"] == pytest.approx(95.4)   # Hollywood -> marquise brown
    assert by_id["00-2"] == pytest.approx(140.1)  # Kenny -> kenneth gainwell
    assert by_id["00-3"] == pytest.approx(12.3)   # A.J. -> aj brown (punct stripped)
    assert by_id["00-4"] == pytest.approx(40.0)   # Mahomes II -> suffix stripped
    assert set(out.columns) >= {"player_id", "name", "position", "adp", "stdev", "times_drafted"}


def test_normalize_adp_drops_unmatched_without_crashing():
    raw = {"players": [{"name": "Nobody Atall", "position": "WR", "adp": 5.0,
                        "stdev": 1.0, "times_drafted": 3}]}
    out = normalize_adp(raw, _crosswalk())
    assert out.empty
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PYTHONPATH=src python -m pytest tests/test_adp.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'ffmodel.data.adp'`.

- [ ] **Step 3: Write minimal implementation**

```python
# src/ffmodel/data/adp.py
"""Average draft position from FantasyFootballCalculator's free JSON API.

The crowd's market a drafter faces, snapshotted before drafts complete (ADP is
pre-draft by construction, so it is leak-safe for a preseason board). Never a
model input — only a display/keeper overlay. Crosswalked to gsis_id with the
same normalize-then-nickname approach the ADP benchmark used."""
from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

import pandas as pd

from ffmodel.data.pull import POSITIONS, _cached
from ffmodel.data.rankings import pull_player_ids

# FFCalculator display name -> nflverse merge_name form (known mismatches).
NICK = {"hollywood brown": "marquise brown", "kenny gainwell": "kenneth gainwell",
        "gabe davis": "gabriel davis", "chig okonkwo": "chigoziem okonkwo"}
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def norm(name: str) -> str:
    s = (str(name).lower().replace(".", "").replace("'", "")
         .replace(",", "").replace("-", " "))
    s = re.sub(r"\s+", " ", SUFFIX.sub("", s)).strip()
    return NICK.get(s, s)


def normalize_adp(raw: dict, crosswalk: pd.DataFrame) -> pd.DataFrame:
    """Reduce a raw FFCalculator `/adp` payload to in-scope players on gsis ids."""
    df = pd.DataFrame(raw["players"])
    df = df[df["position"].isin(POSITIONS)].copy()
    x = crosswalk[crosswalk["gsis_id"].notna()].copy()
    x["_k"] = x["merge_name"].map(norm)
    by_name = x.drop_duplicates("_k").set_index("_k")["gsis_id"]
    df["player_id"] = df["name"].map(norm).map(by_name)
    df = df.dropna(subset=["player_id"]).drop_duplicates("player_id")
    for col in ("stdev", "times_drafted"):
        if col not in df.columns:
            df[col] = pd.NA
    return df[["player_id", "name", "position", "adp", "stdev",
               "times_drafted"]].reset_index(drop=True)


def pull_adp(season: int, cache_dir: Path | None = None, teams: int = 12,
             scoring: str = "ppr") -> pd.DataFrame:
    """Current FFCalculator ADP for `season`, normalized on our ids."""
    url = (f"https://fantasyfootballcalculator.com/api/v1/adp/{scoring}"
           f"?teams={teams}&year={season}&position=all")

    def load() -> pd.DataFrame:
        # FFCalculator 403s the default urllib UA; a browser UA is required.
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        return normalize_adp(raw, pull_player_ids(cache_dir))

    return _cached(cache_dir, f"adp_{scoring}_{teams}_{season}", load)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PYTHONPATH=src python -m pytest tests/test_adp.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/data/adp.py tests/test_adp.py
git commit -m "feat: ADP pull + gsis crosswalk (FantasyFootballCalculator)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Board fusion core (`site/board_rank.py`)

Moves `_assign_tiers` out of `draft.py` (re-exported there in Task 3) and adds the pure fusion math.

**Files:**
- Create: `src/ffmodel/site/board_rank.py`
- Test: `tests/test_board_rank.py`

**Interfaces:**
- Consumes: nothing project-internal (pure pandas/numpy/math).
- Produces:
  - `adp_round(adp: float | None, teams: int = 12) -> int | None` (`ceil(adp/teams)`).
  - `order_and_value(group: pd.DataFrame) -> pd.DataFrame` — `group` has `ppr_p50`, `ecr` (NaN allowed); returns it ordered (ECR asc, then `ppr_p50` desc tail) with a monotone `value_points` column.
  - `flex_replacement_ranks(players: pd.DataFrame, dedicated: dict[str, int], flex_slots: int, flex_positions=("RB","WR","TE")) -> dict[str, int]` — derives each position's replacement rank by handing flex slots to the best remaining players by ECR (no guessed split).
  - `_assign_tiers(vorp_desc: pd.Series, replacement_rank: int) -> list[int]` (moved verbatim from `draft.py`).
  - `rank_board(players: pd.DataFrame, replacement_rank: dict[str, int]) -> pd.DataFrame` — `players` has `player_id, position, ppr_p50, ecr, adp`; returns the whole board with `value_points, vorp, position_rank, tier, adp_round`, sorted by `vorp` desc.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_board_rank.py
import numpy as np
import pandas as pd
import pytest

from ffmodel.site.board_rank import adp_round, order_and_value, rank_board


def test_adp_round_ceils_by_team_count():
    assert adp_round(1.0) == 1
    assert adp_round(12.0) == 1
    assert adp_round(13.0) == 2
    assert adp_round(30.4) == 3
    assert adp_round(None) is None
    assert adp_round(float("nan")) is None


def test_order_and_value_ecr_orders_and_value_is_monotone():
    # model likes A least (p50 10) but experts rank A #1; C has no ECR.
    group = pd.DataFrame({
        "player_id": ["A", "B", "C"],
        "position": "RB",
        "ppr_p50": [10.0, 30.0, 20.0],
        "ecr": [1.0, 2.0, np.nan],
    })
    out = order_and_value(group)
    # ECR order: A, B, then the ECR-less tail C
    assert list(out["player_id"]) == ["A", "B", "C"]
    # value_points = sorted(ppr_p50) desc laid onto that order -> monotone
    assert list(out["value_points"]) == [30.0, 20.0, 10.0]
    assert list(out["value_points"]) == sorted(out["value_points"], reverse=True)


def test_order_and_value_no_ecr_reduces_to_p50_order():
    group = pd.DataFrame({
        "player_id": ["A", "B", "C"], "position": "WR",
        "ppr_p50": [10.0, 30.0, 20.0], "ecr": [np.nan, np.nan, np.nan],
    })
    out = order_and_value(group)
    assert list(out["player_id"]) == ["B", "C", "A"]           # p50 desc
    assert list(out["value_points"]) == [30.0, 20.0, 10.0]     # == own p50 in order


def test_rank_board_vorp_monotone_and_flex_replacement():
    players = pd.DataFrame({
        "player_id": [f"rb{i}" for i in range(5)],
        "position": "RB",
        "ppr_p50": [200.0, 180.0, 160.0, 140.0, 120.0],
        "ecr": [1.0, 2.0, 3.0, 4.0, 5.0],
        "adp": [6.0, 18.0, 30.0, np.nan, 42.0],
    })
    board = rank_board(players, replacement_rank={"RB": 3})
    assert list(board["vorp"]) == sorted(board["vorp"], reverse=True)
    # replacement = value_points at rank 3 = 160 -> top vorp = 200 - 160 = 40
    assert board.iloc[0]["vorp"] == pytest.approx(40.0)
    assert list(board["position_rank"]) == [1, 2, 3, 4, 5]
    # adp_round attached: adp 6 -> R1, 18 -> R2, 30 -> R3, NaN -> None, 42 -> R4
    rounds = list(board["adp_round"])
    assert rounds[:3] == [1, 2, 3] and rounds[3] is None and rounds[4] == 4


def test_flex_replacement_derives_split_from_ecr():
    from ffmodel.site.board_rank import flex_replacement_ranks
    # dedicated 2 QB / 4 RB / 4 WR / 2 TE, 3 flex slots (toy). Beyond the
    # dedicated slots, the leftovers by ECR are WR12, WR13, RB20, RB21, TE32;
    # the top 3 (the flex) are WR, WR, RB -> RB +1, WR +2, TE +0.
    players = pd.DataFrame({
        "position": (["QB"] * 3 + ["RB"] * 6 + ["WR"] * 6 + ["TE"] * 3),
        "ecr": [1, 2, 3,                      # QB
                5, 6, 7, 8, 20, 21,           # RB (dedicated top 4: 5-8)
                4, 9, 10, 11, 12, 13,         # WR (dedicated top 4: 4,9,10,11)
                30, 31, 32],                  # TE (dedicated top 2: 30,31)
    }).astype({"ecr": float})
    repl = flex_replacement_ranks(
        players, dedicated={"QB": 2, "RB": 4, "WR": 4, "TE": 2}, flex_slots=3)
    assert repl == {"QB": 3, "RB": 6, "WR": 7, "TE": 3}


def test_flex_replacement_small_pool_falls_back_to_dedicated_plus_one():
    from ffmodel.site.board_rank import flex_replacement_ranks
    players = pd.DataFrame({"position": ["RB", "WR"], "ecr": [1.0, 2.0]})
    repl = flex_replacement_ranks(
        players, dedicated={"QB": 12, "RB": 24, "WR": 24, "TE": 12}, flex_slots=24)
    # pool smaller than dedicated -> no flex filled -> base replacement, no crash
    assert repl == {"QB": 13, "RB": 25, "WR": 25, "TE": 13}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PYTHONPATH=src python -m pytest tests/test_board_rank.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'ffmodel.site.board_rank'`.

- [ ] **Step 3: Write minimal implementation**

```python
# src/ffmodel/site/board_rank.py
"""Consensus-anchored board ranking (spec 2026-07-25).

ECR sets the intra-position order; the model's points, sorted descending and
laid onto that order, set the value curve; VORP/tiers follow. Pure functions,
no I/O. With no ECR this reduces exactly to ordering by the model's p50 (the
pre-consensus behavior), so callers that pass no consensus are unchanged."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd


def adp_round(adp: float | None, teams: int = 12) -> int | None:
    """Overall ADP pick -> draft round in a `teams`-team league."""
    if adp is None or (isinstance(adp, float) and math.isnan(adp)):
        return None
    return math.ceil(float(adp) / teams)


def order_and_value(group: pd.DataFrame) -> pd.DataFrame:
    """Order one position and assign a monotone value curve.

    Players with a finite `ecr` sort by it ascending; the ECR-less tail sorts
    by `ppr_p50` descending and falls below them. `value_points` is the group's
    `ppr_p50` values sorted descending, laid onto that order -- so value falls
    monotonically while the ORDER is ECR's, not the model's."""
    has_ecr = group["ecr"].notna()
    ranked = group[has_ecr].sort_values("ecr", kind="mergesort")
    tail = group[~has_ecr].sort_values("ppr_p50", ascending=False, kind="mergesort")
    ordered = pd.concat([ranked, tail]).reset_index(drop=True)
    ordered["value_points"] = np.sort(group["ppr_p50"].to_numpy())[::-1]
    return ordered


def _assign_tiers(vorp_desc: pd.Series, replacement_rank: int) -> list[int]:
    values = vorp_desc.to_numpy(dtype=float)
    if len(values) == 0:
        return []
    n_draft = min(2 * replacement_rank, len(values))
    if n_draft < 2:
        return [1] * len(values)
    mean_gap = (values[0] - values[n_draft - 1]) / (n_draft - 1)
    threshold = max(2.0, 2.0 * mean_gap)
    tiers, tier = [1], 1
    for prev, cur in zip(values, values[1:]):
        if prev - cur > threshold:
            tier += 1
        tiers.append(tier)
    return tiers


def flex_replacement_ranks(players: pd.DataFrame, dedicated: dict[str, int],
                           flex_slots: int,
                           flex_positions=("RB", "WR", "TE")) -> dict[str, int]:
    """Per-position replacement rank, deriving the flex split from ECR.

    Every team fills its dedicated slots first (`dedicated` = league-wide counts,
    e.g. {"QB":12,"RB":24,"WR":24,"TE":12}); the `flex_slots` remaining lineup
    spots go to the best players by ECR across `flex_positions`, regardless of
    position -- so the split falls out of the rankings instead of a guess.
    Replacement rank = (dedicated + flex started) + 1. Non-flex positions get
    dedicated + 1. Players without an ECR never start and are ignored."""
    ranked = players[players["ecr"].notna()]
    leftovers = []                       # (ecr, position) beyond dedicated
    for pos in flex_positions:
        grp = ranked[ranked["position"] == pos].sort_values("ecr", kind="mergesort")
        for ecr in grp["ecr"].to_numpy()[dedicated.get(pos, 0):]:
            leftovers.append((float(ecr), pos))
    leftovers.sort(key=lambda t: t[0])
    flex_taken = [pos for _ecr, pos in leftovers[:flex_slots]]
    repl = {pos: dedicated.get(pos, 0) + flex_taken.count(pos) + 1
            for pos in flex_positions}
    for pos, ded in dedicated.items():
        if pos not in flex_positions:
            repl[pos] = ded + 1
    return repl


def rank_board(players: pd.DataFrame,
               replacement_rank: dict[str, int]) -> pd.DataFrame:
    """Per-position order_and_value -> VORP -> position_rank -> tier, then the
    whole board sorted by VORP descending, with adp_round attached."""
    frames = []
    for _pos, group in players.groupby("position"):
        pos = group["position"].iloc[0]
        ordered = order_and_value(group)
        rank = replacement_rank.get(pos, 20)
        repl = ordered["value_points"].iloc[min(rank, len(ordered)) - 1]
        ordered["vorp"] = (ordered["value_points"] - repl).round(2)
        ordered["position_rank"] = ordered.index + 1
        ordered["tier"] = _assign_tiers(ordered["vorp"], rank)
        frames.append(ordered)
    board = pd.concat(frames).sort_values("vorp", ascending=False, kind="mergesort")
    board["adp_round"] = board["adp"].map(lambda a: adp_round(a))
    return board.reset_index(drop=True)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PYTHONPATH=src python -m pytest tests/test_board_rank.py -q`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/site/board_rank.py tests/test_board_rank.py
git commit -m "feat: consensus-anchored board fusion (ECR order + model value curve)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire the fusion into the board build (`site/draft.py`)

**Files:**
- Modify: `src/ffmodel/site/draft.py` (`_assign_tiers` removed + re-imported; `_finalize_board` and `build_draft_board` gain `ecr`/`adp`/`replacement_rank`; payload gains fields; add `FLEX_REPLACEMENT_RANK`)
- Test: `tests/test_site_draft.py` (existing tests unchanged; add fusion tests)

**Interfaces:**
- Consumes: `ffmodel.site.board_rank.rank_board`, `_assign_tiers`.
- Produces: `build_draft_board(..., ecr: dict | None = None, adp: dict | None = None, replacement_rank: dict = REPLACEMENT_RANK)`; payload players gain `ecr`, `adp`, `adp_round`.

- [ ] **Step 1: Write the failing test** (append to `tests/test_site_draft.py`)

```python
def test_finalize_board_consensus_orders_by_ecr():
    # Model would rank by ppr_p50 (rb-hi best); ECR flips the top two.
    from ffmodel.site.draft import _finalize_board
    players = pd.DataFrame({
        "player_id": ["r0", "r1", "r2"],
        "name": "x", "team": "AAA", "position": ["RB"] * 3,
        "ppr_p50": [300.0, 290.0, 280.0],
        "ppr_p10": np.nan, "ppr_p90": np.nan,
        "half_ppr_p50": [300.0, 290.0, 280.0], "half_ppr_p10": np.nan, "half_ppr_p90": np.nan,
        "standard_p50": [300.0, 290.0, 280.0], "standard_p10": np.nan, "standard_p90": np.nan,
        "games": 17, "bye": None,
    })
    ecr = {"r1": 1.0, "r0": 2.0, "r2": 3.0}          # experts prefer r1
    adp = {"r1": 6.0, "r0": 18.0, "r2": 30.0}
    payload = _finalize_board(players, model="m", season=2026,
                              data_through="2025-01-05", has_bands=False,
                              ecr=ecr, adp=adp, replacement_rank={"RB": 2})
    order = [p["player_id"] for p in payload["players"]]
    assert order[0] == "r1"                          # ECR winner leads the board
    top = payload["players"][0]
    assert top["ecr"] == 1.0 and top["adp"] == 6.0 and top["adp_round"] == 1
    assert [p["vorp"] for p in payload["players"]] == sorted(
        [p["vorp"] for p in payload["players"]], reverse=True)


def test_finalize_board_without_ecr_matches_model_ordering():
    # Regression: no ecr/adp -> value_points == ppr_p50 -> identical to before,
    # and the new fields serialize as null.
    from ffmodel.site.draft import _finalize_board
    ppr = list(range(400, 370, -1))
    players = pd.DataFrame({
        "player_id": [f"rb{i}" for i in range(30)], "name": "x", "team": "AAA",
        "position": ["RB"] * 30, "ppr_p50": ppr, "ppr_p10": np.nan, "ppr_p90": np.nan,
        "half_ppr_p50": ppr, "half_ppr_p10": np.nan, "half_ppr_p90": np.nan,
        "standard_p50": ppr, "standard_p10": np.nan, "standard_p90": np.nan,
        "games": 17, "bye": None,
    })
    payload = _finalize_board(players, model="m", season=2026,
                              data_through="2025-01-05", has_bands=False)
    top = payload["players"][0]
    assert top["position_rank"] == 1 and top["vorp"] == pytest.approx(24.0)
    assert top["ecr"] is None and top["adp"] is None and top["adp_round"] is None
    json.dumps(payload, allow_nan=False)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PYTHONPATH=src python -m pytest tests/test_site_draft.py::test_finalize_board_consensus_orders_by_ecr -q`
Expected: FAIL — `TypeError: _finalize_board() got an unexpected keyword argument 'ecr'`.

- [ ] **Step 3: Implement**

In `src/ffmodel/site/draft.py`, keep `REPLACEMENT_RANK` unchanged (it stays the standard 1-flex default used by the board backtest and diagnostics; the live board's flex-aware replacement is *derived* in Task 4, not a constant here). Move `_assign_tiers` to `board_rank.py` and re-import it, then rewrite `_finalize_board`.

Delete the entire local `def _assign_tiers(...)` (lines 190-204) and add to the imports near the top:

```python
from ffmodel.site.board_rank import _assign_tiers, rank_board
```

(`_assign_tiers` is re-exported so `from ffmodel.site.draft import _assign_tiers` in the existing tests still resolves.)

Rewrite `_finalize_board` (currently lines 281-326) as:

```python
def _finalize_board(players: pd.DataFrame, model: str, season: int,
                    data_through: str, has_bands: bool, n_draws: int = 2000,
                    rookie_prior: dict | None = None, *,
                    ecr: dict | None = None, adp: dict | None = None,
                    replacement_rank: dict = REPLACEMENT_RANK) -> dict:
    players = players.copy()
    players["ecr"] = (players["player_id"].map(ecr) if ecr is not None
                      else np.nan)
    players["adp"] = (players["player_id"].map(adp) if adp is not None
                      else np.nan)
    board = rank_board(players, replacement_rank)
    consensus_anchored = ecr is not None

    def _band(value) -> float | None:
        return None if pd.isna(value) else round(float(value), 1)

    def _opt(value, cast):
        return None if pd.isna(value) else cast(value)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_through": data_through, "season": season, "model": model,
        "has_bands": has_bands,
        "methodology": {
            "seeding": "end-of-prior-season form",
            "bands": "simulated season distribution (calibrated weekly bands, "
                     "availability-adjusted)",
            "ranking": ("expert-consensus (FantasyPros ECR); the model supplies "
                        "the value curve and the floor/ceiling bands, not the order"
                        if consensus_anchored else "model season median (VORP)"),
            "replacement_rank": replacement_rank,
            "n_draws": n_draws,
        },
        "players": [{
            "player_id": row["player_id"], "name": row["name"], "team": row["team"],
            "position": row["position"],
            "season_points": {rn: {"p50": round(float(row[f"{rn}_p50"]), 1),
                                   "p10": _band(row[f"{rn}_p10"]),
                                   "p90": _band(row[f"{rn}_p90"])}
                              for rn in ("ppr", "half_ppr", "standard")},
            "games": int(row["games"]),
            "bye": None if pd.isna(row["bye"]) else int(row["bye"]),
            "vorp": float(row["vorp"]),
            "position_rank": int(row["position_rank"]),
            "tier": int(row["tier"]),
            "ecr": _opt(row["ecr"], float),
            "adp": _opt(row["adp"], float),
            "adp_round": _opt(row["adp_round"], int),
            "rookie": bool(row["rookie"]) if "rookie" in row.index else False,
        } for _, row in board.iterrows()],
    }
    if rookie_prior is not None:
        payload["methodology"]["rookie_prior"] = rookie_prior
    return payload
```

Update `build_draft_board` (line 329) signature and its `_finalize_board` call to thread the three new arguments:

```python
def build_draft_board(weekly: pd.DataFrame, schedules: pd.DataFrame, predictor,
                      season: int, data_through: str, weeks=range(1, 19),
                      prefit: bool = False, *, n_draws: int = 2000, seed: int = 0,
                      games_dist: dict[str, np.ndarray] | None = None,
                      diagnostics: dict | None = None,
                      sleeper_players: dict | None = None,
                      draft_picks: pd.DataFrame | None = None,
                      rookie_min_n: int | None = None,
                      ecr: dict | None = None, adp: dict | None = None,
                      replacement_rank: dict = REPLACEMENT_RANK) -> dict:
```

and change the `_finalize_board(...)` call (line 367) to:

```python
    payload = _finalize_board(players, predictor.name, season, data_through, has_bands,
                              n_draws, rookie_prior=rookie_prior_meta,
                              ecr=ecr, adp=adp, replacement_rank=replacement_rank)
```

- [ ] **Step 4: Run the full draft-board suite**

Run: `PYTHONPATH=src python -m pytest tests/test_site_draft.py tests/test_board_rank.py -q -W error`
Expected: PASS — the two new tests plus every pre-existing `test_site_draft.py` test (the no-ECR path is byte-identical ordering).

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/site/draft.py tests/test_site_draft.py
git commit -m "feat: board build consumes ECR/ADP, keeps model-only fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `--draft` pulls ECR (required) + ADP (best-effort) (`site/generate.py`)

**Files:**
- Modify: `src/ffmodel/site/generate.py`
- Test: `tests/test_generate.py`

**Interfaces:**
- Consumes: `ffmodel.data.rankings.consensus_for_season(season, schedules, cache_dir) -> (DataFrame[player_id, pos, ecr, ...], stats)`; `ffmodel.data.adp.pull_adp(season, cache_dir)`; `ffmodel.site.board_rank.flex_replacement_ranks`.
- Produces: `_draft_consensus(season, schedules, data_dir) -> tuple[dict, dict | None, dict]` returning `(ecr_map, adp_map_or_None, replacement_map)`; ECR raising propagates (required), ADP raising → `None`; replacement is derived from the ECR pool.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_generate.py  (add)
import pandas as pd
import pytest

from ffmodel.site import generate


def test_draft_consensus_ecr_required_adp_best_effort(monkeypatch):
    ecr_df = pd.DataFrame({"player_id": ["00-1", "00-2"],
                           "pos": ["RB", "WR"], "ecr": [1.0, 2.0]})
    monkeypatch.setattr(generate, "_load_consensus",
                        lambda s, sched, d: (ecr_df, {"match_rate": 1.0}))

    # ADP fails -> swallowed, ecr still returned; replacement derived (tiny pool)
    monkeypatch.setattr(generate, "_load_adp",
                        lambda s, d: (_ for _ in ()).throw(RuntimeError("403")))
    ecr, adp, replacement = generate._draft_consensus(2026, pd.DataFrame(), "data/raw")
    assert ecr == {"00-1": 1.0, "00-2": 2.0} and adp is None
    assert set(replacement) == {"QB", "RB", "WR", "TE"}   # derived, all positions

    # ADP ok -> mapped
    adp_df = pd.DataFrame({"player_id": ["00-1"], "adp": [6.0]})
    monkeypatch.setattr(generate, "_load_adp", lambda s, d: adp_df)
    ecr, adp, replacement = generate._draft_consensus(2026, pd.DataFrame(), "data/raw")
    assert adp == {"00-1": 6.0}


def test_draft_consensus_ecr_failure_propagates(monkeypatch):
    monkeypatch.setattr(generate, "_load_consensus",
                        lambda s, sched, d: (_ for _ in ()).throw(
                            ValueError("no consensus scrape before kickoff")))
    with pytest.raises(ValueError, match="no consensus scrape"):
        generate._draft_consensus(2026, pd.DataFrame(), "data/raw")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PYTHONPATH=src python -m pytest tests/test_generate.py -q -k draft_consensus`
Expected: FAIL — `AttributeError: module 'ffmodel.site.generate' has no attribute '_draft_consensus'`.

- [ ] **Step 3: Implement**

In `src/ffmodel/site/generate.py`, add the league config and these helpers above `main()`:

```python
# The live board's league: 12-team, dedicated 1 QB / 2 RB / 2 WR / 1 TE per
# team (x12), plus 2 FLEX per team (24 league-wide). Replacement is DERIVED
# from these + the ECR pool (flex split falls out of the rankings), not guessed.
LEAGUE_DEDICATED = {"QB": 12, "RB": 24, "WR": 24, "TE": 12}
LEAGUE_FLEX_SLOTS = 24


def _load_consensus(season, schedules, data_dir):
    from ffmodel.data.rankings import consensus_for_season
    return consensus_for_season(season, schedules, data_dir)


def _load_adp(season, data_dir):
    from ffmodel.data.adp import pull_adp
    return pull_adp(season, cache_dir=data_dir)


def _draft_consensus(season, schedules, data_dir):
    """ECR is the required spine (raise -> abort the run, fail-safe); ADP is a
    best-effort overlay (failure -> None, board still builds). Replacement is
    derived from the ECR pool so the flex split is not a guess."""
    from ffmodel.site.board_rank import flex_replacement_ranks

    ecr_df, _stats = _load_consensus(season, schedules, data_dir)
    ecr = dict(zip(ecr_df["player_id"], ecr_df["ecr"]))
    pool = ecr_df.rename(columns={"pos": "position"})[["position", "ecr"]]
    replacement = flex_replacement_ranks(pool, LEAGUE_DEDICATED, LEAGUE_FLEX_SLOTS)
    try:
        adp_df = _load_adp(season, data_dir)
        adp = dict(zip(adp_df["player_id"], adp_df["adp"]))
    except Exception as exc:                     # noqa: BLE001 - overlay is optional
        print(f"ADP unavailable ({exc}); board builds without the market overlay")
        adp = None
    return ecr, adp, replacement
```

Then, inside `main()`'s `if args.draft:` block (after `draft_picks = pull_draft_picks(...)`, line ~189), fetch consensus BEFORE any model work so an ECR failure aborts fail-safe:

```python
        ecr, adp, replacement = _draft_consensus(args.season, schedules, args.data_dir)
```

And change the draft-board build call (lines 213-215) to pass them plus the derived replacement:

```python
    if args.draft:
        payloads["draft.json"] = build_draft_board(
            weekly, schedules, predictor, args.season, data_through, prefit=True,
            sleeper_players=sleeper_players, draft_picks=draft_picks,
            ecr=ecr, adp=adp, replacement_rank=replacement)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PYTHONPATH=src python -m pytest tests/test_generate.py -q -W error`
Expected: PASS (all generate tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/site/generate.py tests/test_generate.py
git commit -m "feat: --draft pulls ECR (required) + ADP (best-effort), flex replacement

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Site render — ADP/ECR columns + disclosure (`site/index.html`, about, methodology)

No unit test (browser-verified in Task 7). Deliverable: the board table shows ADP + ECR, the sort/tier-break still works, and the copy discloses the consensus anchor.

**Files:**
- Modify: `site/index.html`, `site/about.html`, `docs/methodology.md`

- [ ] **Step 1: Add the ECR + ADP header cells.** In `site/index.html`, in the `<thead><tr>` (lines 52-60), insert after the `Pos rank` `<th>`:

```html
        <th data-key="ecr" class="num">ECR</th>
        <th data-key="adp" class="num">ADP</th>
```

- [ ] **Step 2: Render the cells + bump the tier-break colspan.** In the `render(data)` function (line ~94): change the tier-break `colspan="8"` (line 107) to `colspan="10"` (two columns were added). Then, in the row template (the `tr.innerHTML` ending at line 121 with `<td class="num">${p.position_rank}</td>`), append:

```html
        <td class="num">${p.ecr == null ? "—" : p.ecr.toFixed(1)}</td>
        <td class="num" title="${p.adp == null ? "no ADP" : "avg pick " + p.adp.toFixed(1)}">${p.adp_round == null ? "—" : "R" + p.adp_round}</td>
```

- [ ] **Step 3: Update the "how to read" copy** (lines ~66-72) to disclose the anchor. Replace that paragraph's lead with:

```html
Players are ranked by <strong>expert consensus (FantasyPros ECR)</strong>, the
most accurate free ranking a drafter has — the model contributes the
floor→ceiling <strong>bands</strong> and the VORP value curve, not the order.
ADP shows where your league-mates' market takes each player. VORP prices in
positional scarcity; tier gaps mark real value cliffs.
```

- [ ] **Step 4: Disclose in `site/about.html`.** Find the board/methodology section and add one sentence (place it near the existing board description):

```html
<p>The draft board is <strong>consensus-anchored</strong>: players are ordered
by FantasyPros expert-consensus ranking, because in walk-forward tests the
model's own season-long ranking lost to both expert consensus and ADP. The
model earns its place with calibrated floor/ceiling bands and the value curve —
the parts ADP and ECR don't give you.</p>
```

- [ ] **Step 5: Note it in `docs/methodology.md`.** Under §6 ("What the model is genuinely good for") add a bullet:

```markdown
- **A draft board that ranks on consensus and shows the model's bands.** The
  ordering is expert-consensus (ECR), not the model — because the model's own
  ranking was measured to lose — with ADP as a market/keeper overlay and the
  model's calibrated floor/ceiling bands on every player. The board embodies the
  conclusion above: a banded view of consensus, not a contrarian oracle.
```

- [ ] **Step 6: Commit**

```bash
git add site/index.html site/about.html docs/methodology.md
git commit -m "feat: board UI shows ECR/ADP, discloses consensus anchor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Keeper gauge (`site/assets/keepers.js` + node fixture)

**Files:**
- Create: `site/assets/keepers.js`, `tests/keepers_fixture.cjs`
- Modify: `site/index.html` (keeper panel container + include + init)

**Interfaces:**
- Produces (on `window.Keepers` and CommonJS): `costRound(draftedRound, isWaiver)`, `eligible(draftedRound, isWaiver)`, `valueRound(adpRound, overallRank, teams=12)`, `surplus(candidate)`, `rankKeepers(candidates)`.

- [ ] **Step 1: Write the failing node fixture**

```javascript
// tests/keepers_fixture.cjs  — run with: node tests/keepers_fixture.cjs
const assert = require("assert");
const K = require("../site/assets/keepers.js");

// cost: one round earlier; waiver flat 12
assert.strictEqual(K.costRound(8, false), 7);
assert.strictEqual(K.costRound(15, false), 14);
assert.strictEqual(K.costRound(4, true), 12);

// eligibility: drafted R1-2 ineligible; waiver always eligible
assert.strictEqual(K.eligible(2, false), false);
assert.strictEqual(K.eligible(3, false), true);
assert.strictEqual(K.eligible(1, true), true);

// value round: adp round if present, else board rank -> round
assert.strictEqual(K.valueRound(3, 99), 3);
assert.strictEqual(K.valueRound(null, 30), 3);   // ceil(30/12)
assert.strictEqual(K.valueRound(null, 25), 3);   // ceil(25/12)

// surplus = cost - value; keep a now-R3 player for a R7 pick -> +4
assert.strictEqual(K.surplus({ draftedRound: 8, isWaiver: false, adpRound: 3, overallRank: 30 }), 4);

// rankKeepers filters ineligible and sorts by surplus desc
const ranked = K.rankKeepers([
  { name: "A", draftedRound: 2, isWaiver: false, adpRound: 1, overallRank: 1 },  // ineligible
  { name: "B", draftedRound: 10, isWaiver: false, adpRound: 4, overallRank: 44 }, // +5
  { name: "C", draftedRound: 6, isWaiver: false, adpRound: 3, overallRank: 30 },  // +2
]);
assert.deepStrictEqual(ranked.map(r => r.name), ["B", "C"]);
assert.strictEqual(ranked[0].surplus, 5);

console.log("keepers_fixture: OK");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/keepers_fixture.cjs`
Expected: FAIL — `Cannot find module '../site/assets/keepers.js'`.

- [ ] **Step 3: Implement the math + panel (dual export)**

```javascript
// site/assets/keepers.js
/* Keeper-value gauge. Pure math + a manual panel; reads the board's ADP.
   Rules (spec 2026-07-25): up to 2 keepers, cost = one round earlier than last
   year's draft round, waiver pickups cost round 12, players drafted in rounds
   1-2 are ineligible. Surplus = keeper cost round - where he goes now. */
(function (root, factory) {
  const K = factory();
  if (typeof window !== "undefined") window.Keepers = K;
  if (typeof module !== "undefined" && module.exports) module.exports = K;
})(this, function () {
  const WAIVER_COST_ROUND = 12;

  function costRound(draftedRound, isWaiver) {
    return isWaiver ? WAIVER_COST_ROUND : draftedRound - 1;
  }
  function eligible(draftedRound, isWaiver) {
    return isWaiver || draftedRound > 2;
  }
  function valueRound(adpRound, overallRank, teams = 12) {
    if (adpRound != null) return adpRound;
    return Math.ceil(overallRank / teams);
  }
  function surplus(c) {
    return costRound(c.draftedRound, c.isWaiver)
         - valueRound(c.adpRound, c.overallRank);
  }
  function rankKeepers(candidates) {
    return candidates
      .filter(c => eligible(c.draftedRound, c.isWaiver))
      .map(c => Object.assign({}, c, { surplus: surplus(c) }))
      .sort((a, b) => b.surplus - a.surplus);
  }

  // Panel: players is the loaded board (sorted VORP desc -> overallRank = i+1).
  function init(options) {
    const { players, panel } = options;
    if (!panel) return;
    const rankByName = new Map(players.map((p, i) => [p.name, {
      adpRound: p.adp_round, overallRank: i + 1, position: p.position,
    }]));
    const candidates = [];
    function redraw() {
      const ranked = rankKeepers(candidates);
      const best = new Set(ranked.slice(0, 2).map(r => r.name));
      panel.querySelector(".keeper-out").innerHTML = candidates.map(c => {
        const ok = eligible(c.draftedRound, c.isWaiver);
        const s = ok ? surplus(c) : null;
        const tag = !ok ? "ineligible (drafted R1–2)"
          : `keep for R${costRound(c.draftedRound, c.isWaiver)} · worth R${valueRound(c.adpRound, c.overallRank)} · <strong>${s >= 0 ? "+" : ""}${s} rds</strong>`;
        return `<li class="${best.has(c.name) ? "keep-best" : ""}">${window.FC.esc(c.name)} — ${tag}</li>`;
      }).join("");
    }
    panel.querySelector(".keeper-add").addEventListener("submit", e => {
      e.preventDefault();
      const name = panel.querySelector(".keeper-name").value.trim();
      const isWaiver = panel.querySelector(".keeper-waiver").checked;
      const draftedRound = parseInt(panel.querySelector(".keeper-round").value, 10) || 0;
      const meta = rankByName.get(name);
      if (!meta) { panel.querySelector(".keeper-msg").textContent = "no board match for that name"; return; }
      panel.querySelector(".keeper-msg").textContent = "";
      candidates.push({ name, isWaiver, draftedRound, adpRound: meta.adpRound, overallRank: meta.overallRank });
      redraw();
    });
  }

  return { init, costRound, eligible, valueRound, surplus, rankKeepers };
});
```

- [ ] **Step 4: Run the fixture to verify it passes**

Run: `node tests/keepers_fixture.cjs`
Expected: prints `keepers_fixture: OK` and exits 0.

- [ ] **Step 5: Wire the panel into `site/index.html`.** Add a container inside `<main>` (below the board table) — keep it collapsed by default:

```html
<details class="keeper-panel" id="keepers">
  <summary>Keeper value (manual)</summary>
  <form class="keeper-add">
    <input class="keeper-name" placeholder="Player (exact board name)" list="playerlist" />
    <input class="keeper-round" type="number" min="1" max="20" placeholder="Round drafted" />
    <label><input class="keeper-waiver" type="checkbox" /> waiver pickup (R12)</label>
    <button type="submit">Add</button>
    <span class="keeper-msg" role="alert"></span>
  </form>
  <ol class="keeper-out"></ol>
</details>
```

Add `<script src="assets/keepers.js"></script>` after the `draftmode.js` include (line 74). Then, in the inline `<script>` where the board loads (where `render` is defined and `data`/players is available), after the board data is loaded, initialize the panel:

```javascript
  if (window.Keepers) {
    Keepers.init({ players: data.players, panel: document.getElementById("keepers") });
  }
```

- [ ] **Step 6: Commit**

```bash
git add site/assets/keepers.js tests/keepers_fixture.cjs site/index.html
git commit -m "feat: manual keeper-value gauge (ADP surplus) in draft mode

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Regenerate the live board + full verification (controller-run)

No new code. Regenerate `site/data`, verify in a browser, and prove the suite is green. This is a controller/coordinator step (network + transformer artifacts + browser), matching prior board regenerations.

- [ ] **Step 1: Full suite green (`-W error`).**

Run: `PYTHONPATH=src python -m pytest -q -W error`
Expected: PASS (previous total + the new `test_adp.py`, `test_board_rank.py`, and the added draft/generate tests).

- [ ] **Step 2: Run the keeper fixture.**

Run: `node tests/keepers_fixture.cjs`
Expected: `keepers_fixture: OK`.

- [ ] **Step 3: Regenerate the 2026 board** with the production flags (3-seed transformer ensemble; the ARTIFACT_ROOT comma list from `.github/workflows/weekly-update.yml`):

```bash
PYTHONPATH=src python -m ffmodel.site.generate \
  --out site/data --model transformer \
  --artifact-root models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44 \
  --season 2026 --draft
```

Expected: `draft.json: written (N players)`. Sanity checks (fail the task if any is off): a top-of-board player whose `ecr` is a small number leads; `adp_round` populated for well-known players; `methodology.ranking` mentions "expert-consensus"; `json.dumps(..., allow_nan=False)` clean (the atomic writer already enforces this).

- [ ] **Step 4: Browser verify** (chrome-devtools, as the Sleeper draft-mode tasks were verified): board renders with ECR + ADP columns; sort + tier breaks still work; the keeper panel accepts a player + round and shows the surplus, greys an R1–2 pick as ineligible, highlights the best two; live draft-mode strike-through still works against a Sleeper draft; **zero console errors**.

- [ ] **Step 5: Commit the regenerated site data**

```bash
git add site/data/draft.json
git commit -m "chore: regenerate 2026 board — consensus-anchored, ECR/ADP + keeper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §2 spine=ECR → Tasks 2–4; §2 ADP=FFCalculator → Task 1; §2 fusion ① → Task 2; §2 hide model rank → Task 2 (remap) + Task 5 (no model-rank column); §3 K/DST out → untouched (POSITIONS filter); §4 components → Tasks 1–6 map 1:1 to the table; §5 data flow → Task 4 wiring; §6 fusion detail → Task 2/3; §6 flex-aware replacement → Task 2 `flex_replacement_ranks` (derived from ECR, no guessed split) wired in Task 4; §6 unranked tail → Task 2 `order_and_value` tail; §6 ADP attach/`adp_round` → Task 2; §7 keeper math → Task 6; §8 ECR required / ADP best-effort → Task 4 `_draft_consensus`; §8 leak snapshot → inherited from `rankings.py`; §9 tests → Tasks 1,2,3,4,6; §9 schema fields → Task 3 tests; §10 disclosure → Task 5; §11 knobs → league config (`LEAGUE_DEDICATED`/`LEAGUE_FLEX_SLOTS`) + optional ADP cue rendered in Task 5; §12 sequencing → task order (board core 1–5, keeper 6, regen 7). No gaps.

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `rank_board(players, replacement_rank)` and `_finalize_board(..., ecr, adp, replacement_rank)` and `build_draft_board(..., ecr, adp, replacement_rank)` agree; payload fields `ecr`/`adp`/`adp_round` match between Task 3 producer and Task 5 consumer (`p.ecr`, `p.adp`, `p.adp_round`) and Task 6 (`p.adp_round`); `_assign_tiers` moved to `board_rank.py` and re-imported into `draft.py` so the existing `from ffmodel.site.draft import _assign_tiers` still resolves; keeper fns (`costRound`/`eligible`/`valueRound`/`surplus`/`rankKeepers`) named identically in `keepers.js` and the fixture.
