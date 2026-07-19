# Sleeper Draft Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live draft-night mode on the static draft board — connect to a Sleeper draft by username, strike drafted players in real time, highlight and count your own picks, keep the remaining pool VORP-sorted as a best-available cheat sheet.

**Architecture:** A gsis→sleeper id crosswalk is baked into `draft.json` at `--draft` generation time (new `src/ffmodel/site/sleeper.py`; Sleeper fetch failure aborts the run, fail-safe). On draft night the browser polls Sleeper's public read-only API (`api.sleeper.app`) from a new `site/assets/draftmode.js` panel; the board page consumes a state callback and re-renders. No backend, no auth, no framework.

**Tech Stack:** Python 3.12 (stdlib `urllib` for the one new fetch — no new pip dependency), pytest; vanilla JS/CSS on the existing static site.

**Spec:** `docs/superpowers/specs/2026-07-19-sleeper-draft-mode-design.md` — the approved design. Read it first.

## Global Constraints

- Free tiers only; no paid infrastructure; no new pip dependencies (`pull_sleeper_players` uses stdlib `urllib.request`); no JS framework or build step.
- Run tests with `PYTHONPATH=src` (the venv's editable install is stale after a folder rename): PowerShell `$env:PYTHONPATH = "src"; python -m pytest tests/test_sleeper.py -v`. The suite runs with warnings-as-errors; a new `DeprecationWarning` is a failure.
- **Never-guess matching:** an ambiguous name+position match (on either the board side or the Sleeper side) is counted unmatched, never resolved by guess. A silent wrong strikeout is the one unacceptable failure mode.
- **Fail-safe generation:** a Sleeper fetch failure during a `--draft` run must abort before any site JSON is written. Weekly-only runs (`--week` without `--draft`) must never touch Sleeper.
- Legacy compatibility: `build_draft_board(...)` without `sleeper_players` produces a payload with NO `sleeper_id` fields and NO `crosswalk` block — byte-identical to today. The board-backtest CLI and all existing tests go through that path.
- The drafts-list endpoint year comes from the loaded `draft.json` payload's `season` field, never hardcoded.
- All JSON payloads must survive `json.dumps(payload, allow_nan=False)`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Crosswalk pure functions (`_normalize_name`, `build_crosswalk`)

**Files:**
- Create: `src/ffmodel/site/sleeper.py`
- Create: `tests/test_sleeper.py`

**Interfaces:**
- Consumes: nothing (pure functions, plain dicts in/out).
- Produces:
  - `_normalize_name(name: str) -> str` — lowercase; periods/apostrophes/hyphens removed; Jr/Sr/II/III/IV suffix tokens dropped; whitespace collapsed to single spaces.
  - `build_crosswalk(board_players: list[dict], sleeper_players: dict) -> tuple[dict[str, str], dict]` — `board_players` items need keys `player_id` (gsis string), `name`, `position`. `sleeper_players` is Sleeper's `/v1/players/nfl` shape: `{sleeper_id: {"gsis_id": ..., "full_name": ..., "first_name": ..., "last_name": ..., "position": ...}}`. Returns `(mapping, stats)`: `mapping` maps gsis `player_id -> sleeper_id`; `stats` is `{"matched_gsis": int, "matched_name": int, "unmatched": int, "unmatched_names": list[str]}`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_sleeper.py`:

```python
import pytest

from ffmodel.site.sleeper import _normalize_name, build_crosswalk


# --- name normalization -------------------------------------------------------

def test_normalize_lowercases_and_strips_punctuation():
    assert _normalize_name("Ja'Marr Chase") == "jamarr chase"
    assert _normalize_name("A.J. Brown") == "aj brown"
    assert _normalize_name("Clyde Edwards-Helaire") == "clyde edwardshelaire"


def test_normalize_strips_generation_suffixes():
    assert _normalize_name("Odell Beckham Jr.") == "odell beckham"
    assert _normalize_name("Marvin Harrison Jr") == "marvin harrison"
    assert _normalize_name("Patrick Surtain II") == "patrick surtain"
    assert _normalize_name("Will Fuller V") == "will fuller v"   # V not stripped (real-name risk)


def test_normalize_collapses_whitespace():
    assert _normalize_name("  Kenneth   Walker  III ") == "kenneth walker"


# --- crosswalk ----------------------------------------------------------------

def _board(*players):
    return [{"player_id": pid, "name": name, "position": pos}
            for pid, name, pos in players]


def test_gsis_exact_match_including_whitespace_quirk():
    # Sleeper's gsis_id field is known to carry stray whitespace.
    sleeper = {"4046": {"gsis_id": " 00-0033873", "full_name": "Patrick Mahomes",
                        "position": "QB"}}
    mapping, stats = build_crosswalk(_board(("00-0033873", "Patrick Mahomes", "QB")), sleeper)
    assert mapping == {"00-0033873": "4046"}
    assert stats == {"matched_gsis": 1, "matched_name": 0, "unmatched": 0,
                     "unmatched_names": []}


def test_name_position_fallback_when_gsis_missing():
    sleeper = {"9999": {"gsis_id": None, "full_name": "Rookie Guy Jr.",
                        "position": "WR"}}
    mapping, stats = build_crosswalk(_board(("00-0099999", "Rookie Guy", "WR")), sleeper)
    assert mapping == {"00-0099999": "9999"}
    assert stats["matched_name"] == 1 and stats["matched_gsis"] == 0


def test_name_fallback_requires_position_match():
    sleeper = {"9999": {"gsis_id": None, "full_name": "Taysom Hill", "position": "TE"}}
    mapping, stats = build_crosswalk(_board(("00-0099998", "Taysom Hill", "QB")), sleeper)
    assert mapping == {}
    assert stats["unmatched"] == 1 and stats["unmatched_names"] == ["Taysom Hill"]


def test_ambiguous_sleeper_side_is_unmatched_never_guessed():
    # Two Sleeper entries normalize to the same (name, position): no gsis on
    # either -> the board player must be UNMATCHED, not assigned arbitrarily.
    sleeper = {
        "1001": {"gsis_id": None, "full_name": "Mike Williams", "position": "WR"},
        "1002": {"gsis_id": None, "full_name": "Mike Williams", "position": "WR"},
    }
    mapping, stats = build_crosswalk(_board(("00-0011111", "Mike Williams", "WR")), sleeper)
    assert mapping == {}
    assert stats["unmatched"] == 1


def test_ambiguous_board_side_is_unmatched_never_guessed():
    # Two BOARD players share a normalized (name, position); only one Sleeper
    # candidate exists. Neither may claim it via the name path.
    sleeper = {"1001": {"gsis_id": None, "full_name": "Mike Williams", "position": "WR"}}
    board = _board(("00-0011111", "Mike Williams", "WR"),
                   ("00-0022222", "Mike Williams", "WR"))
    mapping, stats = build_crosswalk(board, sleeper)
    assert mapping == {}
    assert stats["unmatched"] == 2


def test_duplicate_gsis_in_sleeper_dump_falls_back_to_name():
    # Data error in the dump: two entries claim the same gsis_id. The gsis
    # path must not pick one arbitrarily; the name path may still resolve it
    # if unambiguous.
    sleeper = {
        "1001": {"gsis_id": "00-0033873", "full_name": "Patrick Mahomes", "position": "QB"},
        "1002": {"gsis_id": "00-0033873", "full_name": "Someone Else", "position": "QB"},
    }
    mapping, stats = build_crosswalk(_board(("00-0033873", "Patrick Mahomes", "QB")), sleeper)
    assert mapping == {"00-0033873": "1001"}
    assert stats["matched_name"] == 1 and stats["matched_gsis"] == 0


def test_unmatched_rookie_listed_by_name():
    mapping, stats = build_crosswalk(_board(("00-0099997", "Unknown Rookie", "RB")), {})
    assert mapping == {}
    assert stats == {"matched_gsis": 0, "matched_name": 0, "unmatched": 1,
                     "unmatched_names": ["Unknown Rookie"]}


def test_stats_counts_add_up_across_paths():
    sleeper = {
        "1": {"gsis_id": "00-0000001", "full_name": "Vet One", "position": "QB"},
        "2": {"gsis_id": None, "full_name": "Name Match", "position": "RB"},
    }
    board = _board(("00-0000001", "Vet One", "QB"),
                   ("00-0000002", "Name Match", "RB"),
                   ("00-0000003", "No Match", "WR"))
    mapping, stats = build_crosswalk(board, sleeper)
    assert len(mapping) == 2
    assert stats["matched_gsis"] + stats["matched_name"] + stats["unmatched"] == len(board)


def test_sleeper_entries_without_name_or_position_are_skipped():
    # Team-defense entries ("KC": {"position": "DEF", no full_name}) and other
    # malformed rows must not crash the index build.
    sleeper = {"KC": {"position": "DEF"}, "X": {}, "1": None}
    mapping, stats = build_crosswalk(_board(("00-0000001", "Some Guy", "QB")), sleeper)
    assert mapping == {} and stats["unmatched"] == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_sleeper.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ffmodel.site.sleeper'`

- [ ] **Step 3: Write the implementation**

Create `src/ffmodel/site/sleeper.py`:

```python
"""Sleeper id crosswalk for draft mode.

Matching is deliberately conservative: exact (whitespace-stripped) gsis_id
first, then normalized name+position ONLY when unambiguous on both sides.
An ambiguous candidate is counted unmatched -- a visible "couldn't match N
players" notice on the site beats a silent wrong strikeout on draft night
(spec: 2026-07-19-sleeper-draft-mode-design.md).
"""
from __future__ import annotations

import re

# Generation suffixes only. "V" is intentionally NOT stripped: it is a
# plausible real surname token, and no current fantasy-relevant player
# needs it.
_SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}


def _normalize_name(name: str) -> str:
    cleaned = re.sub(r"[.'\-]", "", str(name).lower())
    return " ".join(t for t in cleaned.split() if t not in _SUFFIXES)


def build_crosswalk(board_players: list[dict], sleeper_players: dict) -> tuple[dict, dict]:
    """Map board gsis ``player_id`` -> Sleeper player id.

    Returns ``(mapping, stats)`` where ``stats`` powers the site's visible
    unmatched-count notice: ``{"matched_gsis", "matched_name", "unmatched",
    "unmatched_names"}``.
    """
    # gsis index; a duplicated gsis_id in the dump is a data error -- mark it
    # None (ambiguous) so the gsis path never guesses. Name fallback may
    # still resolve the player.
    by_gsis: dict[str, str | None] = {}
    by_name_pos: dict[tuple[str, str], list[str]] = {}
    for sid, meta in sleeper_players.items():
        if not isinstance(meta, dict):
            continue
        gsis = str(meta.get("gsis_id") or "").strip()
        if gsis:
            by_gsis[gsis] = None if gsis in by_gsis else str(sid)
        full = meta.get("full_name") or " ".join(
            p for p in (meta.get("first_name"), meta.get("last_name")) if p)
        key = (_normalize_name(full), str(meta.get("position") or ""))
        if key[0] and key[1]:
            by_name_pos.setdefault(key, []).append(str(sid))

    board_key_counts: dict[tuple[str, str], int] = {}
    for player in board_players:
        key = (_normalize_name(player["name"]), player["position"])
        board_key_counts[key] = board_key_counts.get(key, 0) + 1

    mapping: dict[str, str] = {}
    stats = {"matched_gsis": 0, "matched_name": 0, "unmatched": 0,
             "unmatched_names": []}
    for player in board_players:
        pid = player["player_id"]
        sid = by_gsis.get(pid)
        if sid is not None:
            mapping[pid] = sid
            stats["matched_gsis"] += 1
            continue
        key = (_normalize_name(player["name"]), player["position"])
        candidates = by_name_pos.get(key, [])
        if len(candidates) == 1 and board_key_counts[key] == 1:
            mapping[pid] = candidates[0]
            stats["matched_name"] += 1
        else:
            stats["unmatched"] += 1
            stats["unmatched_names"].append(player["name"])
    return mapping, stats
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_sleeper.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/site/sleeper.py tests/test_sleeper.py
git commit -m "feat: sleeper crosswalk — conservative gsis + name+position matching"
```

---

### Task 2: `pull_sleeper_players` — fetch, cache, validate

**Files:**
- Modify: `src/ffmodel/site/sleeper.py` (append)
- Modify: `tests/test_sleeper.py` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `pull_sleeper_players(cache_dir: Path | None = None) -> dict` — fetches `https://api.sleeper.app/v1/players/nfl` via stdlib `urllib.request.urlopen` (deferred import), caches the raw JSON at `<cache_dir>/sleeper_players.json` (same convention as `ffmodel.data.pull._cached`), and validates: the payload must be a dict with ≥ 1000 entries of which ≥ 100 carry a non-empty (stripped) `gsis_id`, else `RuntimeError`. Cached copies are re-validated on read. Any fetch/parse/validation failure raises — callers (generate.py, Task 4) let it propagate as the fail-safe abort.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_sleeper.py`:

```python
import json

from ffmodel.site.sleeper import pull_sleeper_players


def _fake_dump(n: int = 1200, with_gsis: int = 200) -> dict:
    dump = {}
    for i in range(n):
        gsis = f"00-{i:07d}" if i < with_gsis else None
        dump[str(i)] = {"gsis_id": gsis, "full_name": f"Player {i}", "position": "WR"}
    return dump


def test_pull_uses_cache_when_present(tmp_path):
    (tmp_path / "sleeper_players.json").write_text(json.dumps(_fake_dump()))
    # No network stub installed: a fetch attempt would blow up loudly.
    data = pull_sleeper_players(cache_dir=tmp_path)
    assert len(data) == 1200


def test_pull_fetches_validates_and_writes_cache(tmp_path, monkeypatch):
    import ffmodel.site.sleeper as sleeper_mod

    monkeypatch.setattr(sleeper_mod, "_fetch_players", lambda: _fake_dump())
    data = pull_sleeper_players(cache_dir=tmp_path)
    assert len(data) == 1200
    cached = json.loads((tmp_path / "sleeper_players.json").read_text())
    assert cached == data


def test_pull_rejects_tiny_dump(tmp_path, monkeypatch):
    import ffmodel.site.sleeper as sleeper_mod

    monkeypatch.setattr(sleeper_mod, "_fetch_players", lambda: _fake_dump(n=50))
    with pytest.raises(RuntimeError, match="suspicious"):
        pull_sleeper_players(cache_dir=tmp_path)
    assert not (tmp_path / "sleeper_players.json").exists()   # nothing cached


def test_pull_rejects_dump_without_gsis_ids(tmp_path, monkeypatch):
    import ffmodel.site.sleeper as sleeper_mod

    monkeypatch.setattr(sleeper_mod, "_fetch_players",
                        lambda: _fake_dump(with_gsis=0))
    with pytest.raises(RuntimeError, match="gsis"):
        pull_sleeper_players(cache_dir=tmp_path)


def test_pull_revalidates_cached_copy(tmp_path):
    (tmp_path / "sleeper_players.json").write_text(json.dumps({"1": {}}))
    with pytest.raises(RuntimeError, match="suspicious"):
        pull_sleeper_players(cache_dir=tmp_path)


def test_pull_propagates_fetch_failure(tmp_path, monkeypatch):
    import ffmodel.site.sleeper as sleeper_mod

    def boom():
        raise OSError("connection refused")
    monkeypatch.setattr(sleeper_mod, "_fetch_players", boom)
    with pytest.raises(OSError):
        pull_sleeper_players(cache_dir=tmp_path)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_sleeper.py -v`
Expected: new tests FAIL — `ImportError: cannot import name 'pull_sleeper_players'`; Task 1 tests still PASS.

- [ ] **Step 3: Write the implementation**

Append to `src/ffmodel/site/sleeper.py` (add `import json`, `import os`, `from pathlib import Path` to the imports):

```python
SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl"
# Sleeper documents /players/nfl as a <=1-call/day endpoint (~5MB). It is
# only ever called at --draft generation time, never from the browser.
_MIN_PLAYERS = 1000
_MIN_GSIS = 100


def _fetch_players() -> dict:
    from urllib.request import urlopen  # deferred: keep offline unit tests import-light

    with urlopen(SLEEPER_PLAYERS_URL, timeout=120) as resp:
        return json.load(resp)


def _validate_players(data) -> None:
    if not isinstance(data, dict) or len(data) < _MIN_PLAYERS:
        size = len(data) if isinstance(data, dict) else type(data).__name__
        raise RuntimeError(f"sleeper players dump looks suspicious ({size} entries; "
                           f"expected >= {_MIN_PLAYERS}) — refusing to build a crosswalk")
    with_gsis = sum(1 for m in data.values()
                    if isinstance(m, dict) and str(m.get("gsis_id") or "").strip())
    if with_gsis < _MIN_GSIS:
        raise RuntimeError(f"sleeper players dump has only {with_gsis} gsis ids "
                           f"(expected >= {_MIN_GSIS}) — format drift? refusing to "
                           "build a crosswalk")


def pull_sleeper_players(cache_dir: Path | None = None) -> dict:
    """Sleeper's full player dump, cached like the nflverse pulls.

    Raises on any fetch/parse/sanity failure; site.generate lets that
    propagate so a --draft run aborts before writing anything (fail-safe:
    the published site keeps its last-good data AND last-good crosswalk).
    """
    path = Path(cache_dir) / "sleeper_players.json" if cache_dir is not None else None
    if path is not None and path.exists():
        data = json.loads(path.read_text())
        _validate_players(data)   # a stale/corrupt cache must not slip through
        return data
    data = _fetch_players()
    _validate_players(data)
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        try:
            tmp.write_text(json.dumps(data))
            os.replace(tmp, path)
        finally:
            if tmp.exists():
                tmp.unlink()
    return data
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_sleeper.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/site/sleeper.py tests/test_sleeper.py
git commit -m "feat: sleeper players pull — cached, validated, fail-loud"
```

---

### Task 3: `draft.py` — bake the crosswalk into the payload

**Files:**
- Modify: `src/ffmodel/site/draft.py` (`build_draft_board`, around line 243)
- Modify: `tests/test_site_draft.py` (append)

**Interfaces:**
- Consumes: `build_crosswalk` from Task 1 (`from ffmodel.site.sleeper import build_crosswalk`, deferred import inside the function).
- Produces: `build_draft_board(..., sleeper_players: dict | None = None)` (new keyword-only param, default `None`). When `sleeper_players` is provided: every payload player gains `"sleeper_id": str | None`, the payload gains a top-level `"crosswalk"` stats block, and a crosswalk that matches ZERO board players raises `RuntimeError` (fail-safe: an unusable dump must not publish a board with dead draft mode). When `None`: payload is byte-identical to today (no `sleeper_id`, no `crosswalk`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_site_draft.py`:

```python
def _sleeper_for(board_payload: dict, skip: int = 0) -> dict:
    """A fake Sleeper dump whose gsis ids mirror the board, minus `skip`."""
    dump = {}
    for i, p in enumerate(board_payload["players"]):
        if i < skip:
            continue
        dump[str(1000 + i)] = {"gsis_id": p["player_id"],
                               "full_name": p["name"], "position": p["position"]}
    return dump


def test_board_without_sleeper_players_is_unchanged():
    weekly = _history()
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9))
    assert "crosswalk" not in board
    assert all("sleeper_id" not in p for p in board["players"])


def test_board_bakes_sleeper_ids_and_crosswalk_stats():
    weekly = _history()
    base = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                             2023, "2023-10-15", weeks=range(7, 9))
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9),
                              sleeper_players=_sleeper_for(base))
    assert all(isinstance(p["sleeper_id"], str) for p in board["players"])
    cw = board["crosswalk"]
    assert cw["matched_gsis"] == len(board["players"])
    assert cw["unmatched"] == 0 and cw["unmatched_names"] == []
    json.dumps(board, allow_nan=False)


def test_board_unmatched_players_get_null_sleeper_id():
    weekly = _history()
    base = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                             2023, "2023-10-15", weeks=range(7, 9))
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9),
                              sleeper_players=_sleeper_for(base, skip=1))
    ids = [p["sleeper_id"] for p in board["players"]]
    assert ids.count(None) == 1
    assert board["crosswalk"]["unmatched"] == 1
    assert len(board["crosswalk"]["unmatched_names"]) == 1
    json.dumps(board, allow_nan=False)


def test_board_zero_match_crosswalk_fails_loud():
    weekly = _history()
    with pytest.raises(RuntimeError, match="crosswalk matched zero"):
        build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                          2023, "2023-10-15", weeks=range(7, 9),
                          sleeper_players={"1": {"gsis_id": "00-9999999",
                                                 "full_name": "Nobody",
                                                 "position": "QB"}})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_site_draft.py -v`
Expected: the four new tests FAIL (`unexpected keyword argument 'sleeper_players'` / missing keys); all pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `src/ffmodel/site/draft.py`, change `build_draft_board`'s signature (line 243) to add the keyword-only param after `diagnostics`:

```python
def build_draft_board(weekly: pd.DataFrame, schedules: pd.DataFrame, predictor,
                      season: int, data_through: str, weeks=range(1, 19),
                      prefit: bool = False, *, n_draws: int = 2000, seed: int = 0,
                      games_dist: dict[str, np.ndarray] | None = None,
                      diagnostics: dict | None = None,
                      sleeper_players: dict | None = None) -> dict:
```

and change the final `return _finalize_board(...)` line to:

```python
    payload = _finalize_board(players, predictor.name, season, data_through,
                              has_bands, n_draws)
    if sleeper_players is not None:
        # Deferred import keeps draft.py import-light for consumers that
        # never touch draft mode (board backtests, tests).
        from ffmodel.site.sleeper import build_crosswalk

        mapping, stats = build_crosswalk(payload["players"], sleeper_players)
        if stats["unmatched"] == len(payload["players"]):
            raise RuntimeError(
                "sleeper crosswalk matched zero board players — dump format "
                "drift? refusing to publish a board with dead draft mode")
        for p in payload["players"]:
            p["sleeper_id"] = mapping.get(p["player_id"])
        payload["crosswalk"] = stats
    return payload
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_site_draft.py -v`
Expected: all PASS

- [ ] **Step 5: Run the adjacent suites to catch regressions**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_site_draft.py tests/test_site_weekly.py tests/test_board.py tests/test_generate.py -v`
Expected: all PASS (the no-`sleeper_players` path is untouched).

- [ ] **Step 6: Commit**

```bash
git add src/ffmodel/site/draft.py tests/test_site_draft.py
git commit -m "feat: draft board bakes sleeper_id crosswalk when a dump is provided"
```

---

### Task 4: `generate.py` — gated fetch, fail-safe abort

**Files:**
- Modify: `src/ffmodel/site/generate.py` (`main`, lines ~152–205)
- Modify: `tests/test_generate.py` (append)

**Interfaces:**
- Consumes: `pull_sleeper_players` (Task 2), `build_draft_board(..., sleeper_players=...)` (Task 3).
- Produces: `python -m ffmodel.site.generate ... --draft` fetches the Sleeper dump (cached under `--data-dir`) right after `validate_inputs` — before any model work, before any file writes — and threads it into `build_draft_board`. Weekly-only runs (`--week` without `--draft`) never import or call the Sleeper module.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_generate.py`:

```python
def _run_generate_with_stubs(monkeypatch, tmp_path, argv, capture: dict):
    """Run generate.main() end-to-end with data pulls, predictor, and payload
    builders stubbed. Records the sleeper_players kwarg build_draft_board saw."""
    import sys

    import ffmodel.data.features as features_mod
    import ffmodel.data.pull as pull_mod
    import ffmodel.site.about as about_mod
    import ffmodel.site.draft as draft_mod
    import ffmodel.site.generate as gen_mod

    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in range(1, 7) for i in range(40)])
    sched = make_schedules(6)
    monkeypatch.setattr(pull_mod, "pull_weekly", lambda *a, **k: weekly)
    monkeypatch.setattr(pull_mod, "pull_schedules", lambda *a, **k: sched)
    monkeypatch.setattr(features_mod, "build_features", lambda *a, **k: weekly)

    class _Stub:
        name = "stub"
        def fit(self, train): pass
    monkeypatch.setattr(gen_mod, "_make_predictor", lambda args, feats: _Stub())

    def fake_board(*a, **k):
        capture["sleeper_players"] = k.get("sleeper_players")
        return {"players": []}
    monkeypatch.setattr(draft_mod, "build_draft_board", fake_board)
    monkeypatch.setattr(about_mod, "build_about",
                        lambda *a, **k: {"site_model": "stub"})
    monkeypatch.setattr(gen_mod, "require_backtests", lambda paths: paths)

    monkeypatch.setattr(sys, "argv", ["gen", "--out", str(tmp_path / "out"),
                                      "--model", "xgboost", "--season", "2023",
                                      *argv])
    gen_mod.main()


def test_draft_run_threads_sleeper_dump_into_board(monkeypatch, tmp_path):
    import ffmodel.site.sleeper as sleeper_mod

    dump = {"1": {"gsis_id": "00-0000001", "full_name": "A B", "position": "QB"}}
    monkeypatch.setattr(sleeper_mod, "pull_sleeper_players", lambda **k: dump)
    capture = {}
    _run_generate_with_stubs(monkeypatch, tmp_path, ["--draft"], capture)
    assert capture["sleeper_players"] is dump
    assert (tmp_path / "out" / "draft.json").exists()


def test_weekly_only_run_never_touches_sleeper(monkeypatch, tmp_path):
    import ffmodel.site.sleeper as sleeper_mod

    def boom(**k):
        raise AssertionError("weekly-only run must not fetch Sleeper")
    monkeypatch.setattr(sleeper_mod, "pull_sleeper_players", boom)
    import ffmodel.data.future as future_mod
    import ffmodel.site.weekly as weekly_mod
    monkeypatch.setattr(future_mod, "combined_future_features",
                        lambda *a, **k: (None, None))
    monkeypatch.setattr(weekly_mod, "build_weekly_projections",
                        lambda *a, **k: {"players": []})
    capture = {}
    _run_generate_with_stubs(monkeypatch, tmp_path, ["--week", "6"], capture)
    assert (tmp_path / "out" / "weekly.json").exists()


def test_draft_run_aborts_before_writing_when_sleeper_pull_fails(monkeypatch, tmp_path):
    import ffmodel.site.sleeper as sleeper_mod

    def fail(**k):
        raise RuntimeError("sleeper is down")
    monkeypatch.setattr(sleeper_mod, "pull_sleeper_players", fail)
    capture = {}
    with pytest.raises(RuntimeError, match="sleeper is down"):
        _run_generate_with_stubs(monkeypatch, tmp_path, ["--draft"], capture)
    out = tmp_path / "out"
    assert not (out / "draft.json").exists()
    assert not (out / "about.json").exists()   # fail-safe: NOTHING was written
```

Note on the weekly-only test: `--week 6` with played weeks 1–6 in the stub weekly frame would fail `resolve_week` only for `auto`; a fixed `--week 6` skips schedule math but still calls `_extend_with_target_season` → the real `pull_weekly` is stubbed to return the same frame, and `_season_has_completed_game` needs score columns — `make_schedules` includes them. If `make_schedules` in `tests/test_features.py` lacks `home_score`/`away_score`, extend the local `sched` frame in the harness with `sched = sched.assign(home_score=float("nan"), away_score=float("nan"))` instead of modifying the shared fixture.

- [ ] **Step 2: Run tests to verify they fail**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_generate.py -v`
Expected: `test_draft_run_threads_sleeper_dump_into_board` FAILS (`capture["sleeper_players"]` is `None` — generate never fetched); the abort test FAILS (no RuntimeError raised). Pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `src/ffmodel/site/generate.py` `main()`, immediately after the `validate_inputs(weekly, schedules, args.season)` line, insert:

```python
    sleeper_players = None
    if args.draft:
        # Fetched BEFORE any model work or file writes: a Sleeper outage
        # aborts the whole run fail-safe (site keeps last-good data,
        # including the last-good crosswalk). Weekly-only runs never
        # reach this import.
        from ffmodel.site.sleeper import pull_sleeper_players

        sleeper_players = pull_sleeper_players(cache_dir=args.data_dir)
```

and change the `build_draft_board` call to:

```python
        payloads["draft.json"] = build_draft_board(
            weekly, schedules, predictor, args.season, data_through, prefit=True,
            sleeper_players=sleeper_players)
```

Also update the import at the top of `main()` — no change needed (`build_draft_board` is already imported); the sleeper import stays inside the `if args.draft` block on purpose.

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:PYTHONPATH = "src"; python -m pytest tests/test_generate.py tests/test_sleeper.py -v`
Expected: all PASS

- [ ] **Step 5: Full suite**

Run: `$env:PYTHONPATH = "src"; python -m pytest -q`
Expected: all PASS (previously 246 + new tests).

- [ ] **Step 6: Commit**

```bash
git add src/ffmodel/site/generate.py tests/test_generate.py
git commit -m "feat: --draft generation pulls sleeper dump, aborts fail-safe on failure"
```

---

### Task 5: `draftmode.js` — panel, connection flow, polling engine

**Files:**
- Create: `site/assets/draftmode.js`
- Modify: `site/index.html` (panel markup + script tag; board `render` NOT touched in this task)
- Modify: `site/assets/style.css` (panel styles; strike styles come in Task 6)

**Interfaces:**
- Consumes: the loaded `draft.json` payload (`board.season`, `board.crosswalk`).
- Produces: `window.DraftMode.init({board, els, onUpdate})` where `els` is `{status, connect, username, find, idInput, connectId, list, live, picksCount, hide, disconnect, roster, note}` (DOM elements) and `onUpdate(state)` is called on every picks update / toggle / disconnect with `state = {connected: bool, drafted: Set<string>, mine: Set<string>, hideDrafted: bool}`. Task 6's board render consumes exactly that state shape. All Sleeper endpoints used: `GET /v1/user/<name>`, `GET /v1/user/<id>/drafts/nfl/<season>`, `GET /v1/draft/<id>`, `GET /v1/draft/<id>/picks`.

**No JS test framework** (site invariant). The deliverable check is behavioral: with the page served locally, entering a username lists real drafts and connecting to a real (even completed) draft logs state updates — Task 7 automates this check in the browser. Keep every function small and defensive; a reviewer must be able to verify correctness by reading.

- [ ] **Step 1: Panel markup**

In `site/index.html`, insert between `<h1>Draft board</h1>` and the `pos-filters` div:

```html
  <details class="draft-panel" id="draft-panel">
    <summary>Draft mode <span class="draft-status" id="draft-status">— off</span></summary>
    <div class="draft-body">
      <p class="draft-note">Live Sleeper overlay: drafted players get struck on the
      board as picks come in. Read-only, no login — works on mock drafts too.</p>
      <div class="draft-row" id="draft-connect">
        <input id="draft-username" type="text" placeholder="Sleeper username" autocomplete="off">
        <button id="draft-find">Find my drafts</button>
        <input id="draft-id-input" type="text" placeholder="…or paste a draft URL / id">
        <button id="draft-connect-id">Connect</button>
      </div>
      <div class="draft-row" id="draft-list"></div>
      <div class="draft-row" id="draft-live" hidden>
        <span id="draft-picks-count"></span>
        <label><input type="checkbox" id="draft-hide"> hide drafted</label>
        <button id="draft-disconnect">Disconnect</button>
      </div>
      <p class="draft-roster" id="draft-roster" hidden></p>
      <p class="draft-note" id="draft-unmatched" hidden></p>
    </div>
  </details>
```

and add `<script src="assets/draftmode.js"></script>` directly after the existing `<script src="assets/app.js"></script>` line.

- [ ] **Step 2: Panel styles**

Append to `site/assets/style.css`:

```css
/* -- draft mode ----------------------------------------------------------- */
.draft-panel { border: 1px solid var(--rule); border-radius: 6px; margin: 0 0 1rem; }
.draft-panel summary {
  cursor: pointer; padding: .55rem .9rem;
  font: 600 .95rem/1 "Barlow Condensed", sans-serif; letter-spacing: .09em;
  text-transform: uppercase; color: var(--chalk-dim);
}
.draft-panel[open] summary { color: var(--chalk); border-bottom: 1px solid var(--rule); }
.draft-status {
  margin-left: .6rem; font: 500 .78rem/1.2 "IBM Plex Mono", monospace;
  text-transform: none; letter-spacing: .02em;
}
.draft-body { padding: .8rem .9rem; display: grid; gap: .6rem; }
.draft-row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
.draft-row input[type="text"] {
  background: var(--board-raised); border: 1px solid var(--rule); color: var(--chalk);
  padding: .4rem .6rem; border-radius: 4px;
  font: 400 .9rem/1.3 "Source Sans 3", sans-serif; min-width: 14rem;
}
.draft-row button {
  background: none; border: 1px solid var(--rule); color: var(--chalk-dim);
  font: 600 .85rem/1 "Barlow Condensed", sans-serif; letter-spacing: .08em;
  text-transform: uppercase; padding: .45rem .8rem; border-radius: 4px; cursor: pointer;
}
.draft-row button:hover { color: var(--chalk); border-color: var(--chalk); }
.draft-row label { font: 500 .85rem/1.3 "Source Sans 3", sans-serif; color: var(--chalk-dim); }
.draft-roster, .draft-note { margin: 0; font: 500 .82rem/1.4 "IBM Plex Mono", monospace;
  color: var(--chalk-dim); }
```

- [ ] **Step 3: Implement `site/assets/draftmode.js`**

```js
/* Draft mode — live Sleeper draft overlay. Read-only public API
   (api.sleeper.app), no auth, no backend. Strictly additive: every failure
   here degrades the panel, never the board. */
window.DraftMode = (() => {
  const API = "https://api.sleeper.app/v1";
  const STORE_KEY = "fc-draft-mode";
  const POLL_MS = 3000, MAX_BACKOFF_MS = 30000;

  let cfg = null;       // {board, els, onUpdate}
  let session = null;   // {username, userId, draftId, totalPicks}
  let timer = null, backoff = POLL_MS;
  const state = { connected: false, drafted: new Set(), mine: new Set(),
                  hideDrafted: false };

  async function api(path) {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function emit() { cfg.onUpdate(state); }
  // DOM fallback: disable(reason) runs BEFORE init in the no-crosswalk case,
  // when cfg is still null.
  function setStatus(text) {
    const el = (cfg && cfg.els.status) || document.getElementById("draft-status");
    if (el) el.textContent = text;
  }

  async function findDrafts() {
    const username = cfg.els.username.value.trim();
    if (!username) { setStatus("enter a username"); return; }
    try {
      setStatus("looking up user…");
      const user = await api(`/user/${encodeURIComponent(username)}`);
      if (!user || !user.user_id) throw new Error("user not found");
      const drafts = await api(`/user/${user.user_id}/drafts/nfl/${cfg.board.season}`) || [];
      if (!drafts.length) {
        setStatus(`no ${cfg.board.season} drafts for ${username} — paste a draft id instead`);
        return;
      }
      cfg.els.list.innerHTML = "";
      for (const d of drafts) {
        const b = document.createElement("button");
        const when = d.start_time ? new Date(d.start_time).toLocaleDateString() : "unscheduled";
        b.textContent = `${d.metadata && d.metadata.name || d.type} · ${d.status} · ${when}`;
        b.addEventListener("click", () => connect(username, user.user_id, d.draft_id));
        cfg.els.list.appendChild(b);
      }
      setStatus(`${drafts.length} draft(s) — pick one`);
    } catch (e) { setStatus(`lookup failed: ${e.message}`); }
  }

  async function connectById() {
    const raw = cfg.els.idInput.value.trim();
    const m = raw.match(/(\d{6,})/);          // raw id or any sleeper.com draft URL
    if (!m) { setStatus("that doesn't look like a draft id"); return; }
    // Username optional here — without it, picks still strike but none are "yours".
    let userId = null;
    const username = cfg.els.username.value.trim();
    if (username) {
      try {
        const user = await api(`/user/${encodeURIComponent(username)}`);
        userId = user && user.user_id || null;
      } catch (e) { /* non-fatal: connect without highlight */ }
    }
    connect(username || null, userId, m[1]);
  }

  async function connect(username, userId, draftId) {
    try {
      setStatus("connecting…");
      const draft = await api(`/draft/${draftId}`);
      if (!draft || !draft.draft_id) throw new Error("draft not found");
      const s = draft.settings || {};
      session = { username, userId, draftId,
                  totalPicks: (s.rounds || 0) * (s.teams || 0) };
      localStorage.setItem(STORE_KEY, JSON.stringify({ username, userId, draftId }));
      state.connected = true;
      cfg.els.connect.hidden = true;
      cfg.els.list.innerHTML = "";
      cfg.els.live.hidden = false;
      unmatchedNote();
      poll();
    } catch (e) { setStatus(`connect failed: ${e.message}`); }
  }

  function disconnect() {
    clearTimeout(timer);
    localStorage.removeItem(STORE_KEY);
    session = null;
    state.connected = false;
    state.drafted = new Set();
    state.mine = new Set();
    cfg.els.connect.hidden = false;
    cfg.els.live.hidden = true;
    cfg.els.roster.hidden = true;
    setStatus("— off");
    emit();
  }

  async function poll() {
    clearTimeout(timer);
    if (!session) return;
    if (document.hidden) { timer = setTimeout(poll, POLL_MS); return; }
    try {
      const picks = await api(`/draft/${session.draftId}/picks`) || [];
      backoff = POLL_MS;
      applyPicks(picks);
      if (session.totalPicks && picks.length >= session.totalPicks) {
        setStatus(`draft complete — ${picks.length} picks`);
        return;                                   // stop polling
      }
      timer = setTimeout(poll, POLL_MS);
    } catch (e) {
      setStatus(`reconnecting… (${e.message})`);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      timer = setTimeout(poll, backoff);
    }
  }

  function applyPicks(picks) {
    state.drafted = new Set(picks.map(p => String(p.player_id)));
    state.mine = new Set(picks.filter(p => session.userId && p.picked_by === session.userId)
                              .map(p => String(p.player_id)));
    cfg.els.picksCount.textContent = `${picks.length} picks in`;
    if (session.userId) {
      const counts = { QB: 0, RB: 0, WR: 0, TE: 0, other: 0 };
      for (const p of picks) {
        if (p.picked_by !== session.userId) continue;
        const pos = p.metadata && p.metadata.position;
        if (counts[pos] !== undefined) counts[pos]++; else counts.other++;
      }
      cfg.els.roster.hidden = false;
      cfg.els.roster.textContent =
        `Your roster: QB ${counts.QB} · RB ${counts.RB} · WR ${counts.WR} · TE ${counts.TE}`
        + (counts.other ? ` · +${counts.other} other` : "");
    }
    setStatus(`connected — live`);
    emit();
  }

  function unmatchedNote() {
    const cw = cfg.board.crosswalk;
    if (cw && cw.unmatched > 0) {
      cfg.els.note.hidden = false;
      cfg.els.note.textContent =
        `heads up: ${cw.unmatched} board player(s) have no Sleeper mapping and will never strike`;
    }
  }

  function init(options) {
    cfg = options;
    cfg.els.find.addEventListener("click", findDrafts);
    cfg.els.username.addEventListener("keydown", e => { if (e.key === "Enter") findDrafts(); });
    cfg.els.connectId.addEventListener("click", connectById);
    cfg.els.idInput.addEventListener("keydown", e => { if (e.key === "Enter") connectById(); });
    cfg.els.disconnect.addEventListener("click", disconnect);
    cfg.els.hide.addEventListener("change", () => {
      state.hideDrafted = cfg.els.hide.checked;
      emit();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && session) poll();    // poll() clears any pending timer
    });
    const stored = localStorage.getItem(STORE_KEY);
    if (stored) {
      try {
        const { username, userId, draftId } = JSON.parse(stored);
        document.getElementById("draft-panel").open = true;
        connect(username, userId, draftId);       // mid-draft refresh reconnects
      } catch (e) { localStorage.removeItem(STORE_KEY); }
    }
  }

  function disable(reason) {
    // Called INSTEAD of init when the board payload has no crosswalk
    // (cfg is null here — setStatus falls back to the DOM).
    setStatus(reason);
    const body = document.querySelector("#draft-panel .draft-body");
    if (body) body.querySelectorAll("input, button").forEach(el => { el.disabled = true; });
  }

  return { init, disable };
})();
```

- [ ] **Step 4: Wire init in `index.html` (logging only, board render untouched)**

At the end of the async IIFE in `site/index.html`, after `render(rows);`, add:

```js
  if (window.DraftMode) {
    if (board.crosswalk) {
      DraftMode.init({
        board,
        els: {
          status: document.getElementById("draft-status"),
          connect: document.getElementById("draft-connect"),
          username: document.getElementById("draft-username"),
          find: document.getElementById("draft-find"),
          idInput: document.getElementById("draft-id-input"),
          connectId: document.getElementById("draft-connect-id"),
          list: document.getElementById("draft-list"),
          live: document.getElementById("draft-live"),
          picksCount: document.getElementById("draft-picks-count"),
          hide: document.getElementById("draft-hide"),
          disconnect: document.getElementById("draft-disconnect"),
          roster: document.getElementById("draft-roster"),
          note: document.getElementById("draft-unmatched"),
        },
        onUpdate: s => { console.log("draft-mode state", s); },   // Task 6 replaces this
      });
    } else {
      DraftMode.disable("this board build has no Sleeper mapping — regenerate with --draft");
    }
  }
```

- [ ] **Step 5: Behavioral smoke check**

Serve the site and confirm the panel renders and errors are non-fatal:

```powershell
python -m http.server 8000 --directory site
```

Open `http://localhost:8000` in a browser: the board must render exactly as before; the Draft mode panel must show "— off" (current committed `draft.json` has no `crosswalk`, so the disabled path is what's exercised here: controls disabled, status text explains why, ZERO console errors from the board itself).
Expected: board unaffected; panel present and politely disabled.

- [ ] **Step 6: Commit**

```bash
git add site/assets/draftmode.js site/index.html site/assets/style.css
git commit -m "feat: draft-mode panel — sleeper connection flow and polling engine"
```

---

### Task 6: Board integration — strikeouts, hide toggle, mine highlight

**Files:**
- Modify: `site/index.html` (board script: `render`, `onUpdate`)
- Modify: `site/assets/style.css` (row states)

**Interfaces:**
- Consumes: `DraftMode.init`'s `onUpdate(state)` with `state = {connected, drafted: Set<string>, mine: Set<string>, hideDrafted}` (Task 5); `p.sleeper_id` on board players (Task 3).
- Produces: the visible draft-night behavior (spec "Board integration" section).

- [ ] **Step 1: Row-state styles**

Append to `site/assets/style.css`:

```css
tr.drafted td { opacity: .38; }
tr.drafted td:nth-child(3) { text-decoration: line-through; }
tr.mine td { opacity: 1; }
tr.mine { background: color-mix(in srgb, var(--te) 12%, transparent); }
```

- [ ] **Step 2: Integrate state into the board render**

In `site/index.html`'s board script:

1. Near the top of the IIFE (after `let rows = ...`), add:

```js
  let draftState = null;
  const isDrafted = p => !!(draftState && p.sleeper_id && draftState.drafted.has(p.sleeper_id));
  const isMine = p => !!(draftState && p.sleeper_id && draftState.mine.has(p.sleeper_id));
```

2. In `render(data)`, change the `filtered` line to:

```js
    const filtered = data.filter(p => pos === "ALL" || p.position === pos)
      .filter(p => !(draftState && draftState.hideDrafted && isDrafted(p) && !isMine(p)));
```

(your own picks stay visible even under hide-drafted — you want to see your roster on the board).

3. Inside the row loop, after `tr.children[6].appendChild(...)` add:

```js
      if (isDrafted(p)) tr.classList.add("drafted");
      if (isMine(p)) tr.classList.add("mine");
```

4. Replace the Task 5 placeholder `onUpdate` with:

```js
        onUpdate: s => { draftState = s.connected ? s : null; render(rows); },
```

- [ ] **Step 3: Behavioral check with a synthetic state**

Serve locally (`python -m http.server 8000 --directory site`), open the console, and — because the committed `draft.json` has no `sleeper_id`s yet — verify wiring by simulating: the board page's `render` must not crash with `draftState` null (default path, reload) and the `drafted`/`mine`/hide behavior can be sanity-checked in Task 7 against a real regenerated board. In this task assert only: page loads clean, zero console errors, sorting/filtering/scoring toggles all still work.
Expected: identical pre-draft-mode behavior.

- [ ] **Step 4: Commit**

```bash
git add site/index.html site/assets/style.css
git commit -m "feat: board render strikes drafted players, highlights yours"
```

---

### Task 7: Live verification and board regeneration

This task runs REAL network calls and the real model — it is verification, not TDD.

**Files:**
- Modify: `site/data/draft.json` (regenerated with crosswalk)
- Possibly modify: anything the verification exposes (fix-forward with tests).

**Interfaces:**
- Consumes: everything above.
- Produces: a published-ready board with baked `sleeper_id`s, a measured gsis coverage number, and a browser-verified draft-mode flow against the real Sleeper API.

- [ ] **Step 1: Real Sleeper pull + coverage measurement**

```powershell
$env:PYTHONPATH = "src"
python -c @"
import json
from pathlib import Path
from ffmodel.site.sleeper import pull_sleeper_players, build_crosswalk
dump = pull_sleeper_players(cache_dir=Path('data/raw'))
board = json.loads(Path('site/data/draft.json').read_text())
mapping, stats = build_crosswalk(board['players'], dump)
print('dump entries:', len(dump))
print('stats:', {k: v for k, v in stats.items() if k != 'unmatched_names'})
print('unmatched:', stats['unmatched_names'])
"@
```

Expected: dump ≥ 10,000 entries; matched fraction ≥ 0.95 of 616 board players; the unmatched list should be short and explainable (rookies, recently retired). **If matched < 0.90, STOP and investigate the dump format before proceeding** — do not weaken the matcher to force numbers.

- [ ] **Step 2: Regenerate the board with the crosswalk**

```powershell
$env:PYTHONPATH = "src"
python -u -m ffmodel.site.generate --out site/data --model transformer --artifact-root "models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44" --season 2026 --draft
```

(Full model inference — takes a few minutes.) Then verify:

```powershell
python -c "import json; d = json.load(open('site/data/draft.json')); print(d['crosswalk']); print('with sleeper_id:', sum(1 for p in d['players'] if p['sleeper_id']))"
```

Expected: `crosswalk` block present; `sleeper_id` count equals `matched_gsis + matched_name`. Also confirm `weekly.json`/`about.json` were regenerated cleanly (generate prints one line per payload).

- [ ] **Step 3: Browser verification against the real API**

Serve locally (`python -m http.server 8000 --directory site`) and, with browser tooling (chrome-devtools MCP in the driving session), verify on `http://localhost:8000`:

1. Panel is ENABLED (crosswalk present).
2. Enter a real Sleeper username (ask the user for theirs; any public username works for the read-only flow) → drafts list appears (CORS proof #1: `/user`, `/drafts` succeed from a browser origin).
3. Connect to a real draft — a COMPLETED one is fine (e.g. the user's league's last draft, or a mock): every drafted player on the board strikes at once, picks count is right, "hide drafted" collapses struck rows but keeps "mine" visible when a username was given, Disconnect restores everything.
4. Reload mid-connection → auto-reconnect from localStorage.
5. Console: zero uncaught errors throughout.

Expected: all five pass. Record the outcome (numbers seen, draft id used) in the task report.

- [ ] **Step 4: Full suite, then commit the regenerated data**

```powershell
$env:PYTHONPATH = "src"; python -m pytest -q
```

Expected: all PASS. Then:

```bash
git add site/data
git commit -m "data: regenerate 2026 board with sleeper crosswalk baked in"
```

- [ ] **Step 5: Draft-night rehearsal checklist (hand to the user)**

Produce (in the final report, not a repo file) the rehearsal steps: create a Sleeper mock draft in the app → open the live site → Draft mode → username → pick the mock → watch picks strike in real time as the mock autodrafts. This is the acceptance test the user runs before real draft night.

---

## Verification sweep (after all tasks)

- `$env:PYTHONPATH = "src"; python -m pytest -q` — everything green.
- `git log --oneline` — one commit per task, trailer present.
- Spec cross-check: every row of the spec's error-handling table has either a test (build side) or a verified browser behavior (Task 7) — walk the table row by row in the final review.
