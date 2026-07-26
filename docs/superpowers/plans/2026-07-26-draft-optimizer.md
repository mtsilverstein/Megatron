# Draft-Mode Pick-Time Optimizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn draft mode's roster-blind "waiting costs" line into a ranked shortlist of the best 3–5 picks right now, scored by roster-aware VONA + ECR-anchored steal − bye penalty, plus a late-round K/DST slot reminder.

**Architecture:** A new browser+CommonJS module `site/assets/optimizer.js` holds all pure scoring math (node-fixture tested, no DOM/network). `site/assets/draftmode.js` consumes it inside its existing poll loop, replacing the `updateAids` VONA line with a shortlist render. A small `generate.py` addition emits a `late_slots` block of K/DST ADP into `draft.json` (no projections).

**Tech Stack:** Vanilla browser JS (no framework/build), Node.js `assert` fixture, Python 3 + pandas (`generate.py`/`adp.py`), pytest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-26-draft-optimizer-design.md` — source of truth.
- **Objective:** maximize expected starting-lineup VORP; score approximates each player's marginal contribution.
- **Score (exact):** `scorePlayer = vona(X) + W_STEAL * steal(X) - byePenalty(X)`.
- **Constants (exact, un-tuned defaults):** `W_STEAL = 0.5`, `BENCH_WEIGHT = 0.2`, `BYE_PEN = 3.0`, `LATE_ROUNDS = 2`, `SHORTLIST_N = 5`.
- **`vona(X)`:** `starts` → `vorp(X) - replacement(pos, gap)` (≥ 0); `!starts` → `BENCH_WEIGHT * vorp(X)`.
- **`gap` is to your NEXT pick and is ACTIVE on the clock** — never zeroed when it's your turn.
- **`steal(X) = max(0, vorp(X) - parVorp(P))`** — ECR-anchored via board rank. **ECR is the North Star; ADP never sets value** (ADP only orders the K/DST pool).
- **League shape:** starters QB1 · RB2 · WR2 · TE1 · FLEX2 (RB/WR/TE) · K1 · D/ST1; 5 bench; 15 rounds.
- **Scope guard:** no K/DST projections — ADP-only late-slot list, flagged "not projected".
- **Fail soft:** any error hides the widget; the board and the rest of draft mode are never disturbed. No console errors.
- **Python:** run pytest with `PYTHONPATH=src`; the suite must stay green (CI runs `-W error`).
- **Node fixture** gate: `node tests/optimizer_fixture.cjs` → prints `optimizer_fixture: OK`.
- **Commit trailer (last line):** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- `site/assets/optimizer.js` **(create)** — ALL pure scoring math, UMD-wrapped (`window.Optimizer` + `module.exports`) so the node fixture can require it. Owns: `rosterSlots`, `openSlot`, `replacement`, `vona`, `parVorp`, `steal`, `byePenalty`, `scorePlayer`, `rankShortlist`, `whyLabel`, `lateSlotTrigger`. No DOM, no `fetch`.
- `tests/optimizer_fixture.cjs` **(create)** — node assertions over the pure module.
- `site/assets/draftmode.js` **(modify)** — `updateAids` renders the shortlist via `window.Optimizer`; add roster/bye inference from `state.mine`; add gap-to-next-pick.
- `site/index.html` **(modify)** — load `optimizer.js` before `draftmode.js`; add the `#draft-late` line element and pass it in `els`.
- `src/ffmodel/data/adp.py` **(modify)** — `pull_adp_late_slots(season, …)` returning K/DST rows (name + adp only).
- `src/ffmodel/site/generate.py` **(modify)** — attach `late_slots` to the draft payload.
- `tests/test_adp.py`, `tests/test_generate.py` **(modify)** — python coverage for the above.

Why a separate `optimizer.js`: `draftmode.js` is a browser-only IIFE (`window.DraftMode = (()=>{…})()`) that cannot be `require()`d by node, and it is already 311 lines. The spec permits "a sibling exported for the fixture"; this keeps the math unit-testable and each file single-responsibility.

---

## Task 1: Pure scoring module — roster slots, VONA, steal, bye, score

Build `optimizer.js` with every pure function and its fixture. No DOM, no network, no rendering.

**Files:**
- Create: `site/assets/optimizer.js`
- Create: `tests/optimizer_fixture.cjs`

**Interfaces:**
- Produces (on `window.Optimizer` + CommonJS export):
  - `rosterSlots(myPlayers)` → `{ QB, RB, WR, TE }` counts. `myPlayers` = array of `{ position, bye }`.
  - `openSlot(pos, counts)` → `"dedicated" | "flex" | "none"`.
  - `replacement(available, pos, gap)` → number ≥ 0.
  - `vona(player, counts, available, gap)` → number.
  - `parVorp(players, pickNo)` → number ≥ 0.
  - `steal(player, players, pickNo)` → number ≥ 0.
  - `byePenalty(player, myPlayers, counts)` → `0` or `BYE_PEN`.
  - `scorePlayer(player, ctx)` → number, where `ctx = { counts, available, gap, players, pickNo, myPlayers }`.
  - `whyLabel(player, ctx)` → string.
  - `rankShortlist(ctx)` → array of `{ player, score, why }`, length ≤ `SHORTLIST_N`.
  - `lateSlotTrigger(roundsLeft, haveK, haveDst)` → `boolean`.
  - Constants exported for assertion: `W_STEAL`, `BENCH_WEIGHT`, `BYE_PEN`, `LATE_ROUNDS`, `SHORTLIST_N`, `DEDICATED`, `FLEX_SLOTS`.
- A `player` is a board row: `{ name, position, vorp, bye, ecr }`. `available` is an array of players sorted by `vorp` desc.

- [ ] **Step 1: Write the failing fixture**

Create `tests/optimizer_fixture.cjs`:

```javascript
// tests/optimizer_fixture.cjs — run with: node tests/optimizer_fixture.cjs
const assert = require("assert");
const O = require("../site/assets/optimizer.js");

const P = (name, position, vorp, extra = {}) =>
  Object.assign({ name, position, vorp, bye: 7, ecr: 50 }, extra);

// --- rosterSlots / openSlot -------------------------------------------------
assert.deepStrictEqual(O.rosterSlots([]), { QB: 0, RB: 0, WR: 0, TE: 0 });
assert.deepStrictEqual(
  O.rosterSlots([P("a", "RB", 1), P("b", "RB", 1), P("c", "WR", 1)]),
  { QB: 0, RB: 2, WR: 1, TE: 0 });

// dedicated open while under the dedicated count
assert.strictEqual(O.openSlot("RB", { QB: 0, RB: 1, WR: 0, TE: 0 }), "dedicated");
// RB dedicated (2) full, flex still open -> flex
assert.strictEqual(O.openSlot("RB", { QB: 0, RB: 2, WR: 0, TE: 0 }), "flex");
// both flex slots consumed by surplus RB/WR/TE -> none
assert.strictEqual(O.openSlot("RB", { QB: 0, RB: 4, WR: 2, TE: 1 }), "none");
// QB is never flex-eligible: 1 dedicated, then straight to none
assert.strictEqual(O.openSlot("QB", { QB: 0, RB: 0, WR: 0, TE: 0 }), "dedicated");
assert.strictEqual(O.openSlot("QB", { QB: 1, RB: 0, WR: 0, TE: 0 }), "none");
// TE: dedicated 1, then flex-eligible
assert.strictEqual(O.openSlot("TE", { QB: 0, RB: 0, WR: 0, TE: 1 }), "flex");

// --- replacement ------------------------------------------------------------
// pool by vorp desc: RB100, WR90, RB80, WR70, RB60
const pool = [P("r1", "RB", 100), P("w1", "WR", 90), P("r2", "RB", 80),
              P("w2", "WR", 70), P("r3", "RB", 60)];
assert.strictEqual(O.replacement(pool, "RB", 0), 100);  // gap 0 -> current best
assert.strictEqual(O.replacement(pool, "RB", 2), 80);   // top 2 gone -> r2
assert.strictEqual(O.replacement(pool, "RB", 4), 60);   // top 4 gone -> r3
assert.strictEqual(O.replacement(pool, "RB", 5), 0);    // none survive -> replacement level
assert.strictEqual(O.replacement(pool, "TE", 0), 0);    // position absent -> 0

// --- vona -------------------------------------------------------------------
const empty = { QB: 0, RB: 0, WR: 0, TE: 0 };
// starts + cliff: best RB 100, survivor after 2 picks 80 -> 20
assert.strictEqual(O.vona(pool[0], empty, pool, 2), 20);
// starts, gap 0 -> 0 (you could just take him next pick too)
assert.strictEqual(O.vona(pool[0], empty, pool, 0), 0);
// would ride the bench (all RB slots + both flex full) -> BENCH_WEIGHT * vorp
const full = { QB: 1, RB: 4, WR: 2, TE: 1 };
assert.strictEqual(O.vona(pool[0], full, pool, 2), O.BENCH_WEIGHT * 100);

// --- parVorp / steal --------------------------------------------------------
// board (rank order = ECR order): ranks 1..5 by vorp desc
const board = [P("b1", "RB", 100), P("b2", "WR", 90), P("b3", "RB", 80),
               P("b4", "WR", 70), P("b5", "TE", 60)];
assert.strictEqual(O.parVorp(board, 3), 80);    // pick #3 -> 3rd board row
assert.strictEqual(O.parVorp(board, 99), 0);    // past the board -> 0
// an elite still available well past his rank is a steal
assert.strictEqual(O.steal(board[0], board, 3), 20);   // 100 - par 80
assert.strictEqual(O.steal(board[2], board, 3), 0);    // par pick -> no steal
assert.strictEqual(O.steal(board[4], board, 3), 0);    // below par -> floored at 0

// --- byePenalty -------------------------------------------------------------
// two starters already on bye 7; a third STARTER on bye 7 is penalized
const mine2 = [P("m1", "RB", 50, { bye: 7 }), P("m2", "WR", 50, { bye: 7 })];
assert.strictEqual(O.byePenalty(P("x", "TE", 40, { bye: 7 }), mine2, empty), O.BYE_PEN);
// different bye week -> no penalty
assert.strictEqual(O.byePenalty(P("x", "TE", 40, { bye: 9 }), mine2, empty), 0);
// only ONE existing starter on that bye -> the newcomer is only the 2nd -> no penalty
const mine1 = [P("m1", "RB", 50, { bye: 7 })];
assert.strictEqual(O.byePenalty(P("x", "TE", 40, { bye: 7 }), mine1, empty), 0);
// a bench pick is never penalized (would not start)
assert.strictEqual(O.byePenalty(P("x", "RB", 40, { bye: 7 }), mine2, full), 0);

// --- scorePlayer: the spec's worked check ----------------------------------
// WR2 open, gap 23: best WR 40, survivor WR 22 -> vona 18, no steal (par 45)
const wrPool = [P("eliteRB", "RB", 100), P("par", "RB", 45), P("wrNow", "WR", 40),
                P("wrLater", "WR", 22)];
const ctxWR = { counts: { QB: 0, RB: 2, WR: 1, TE: 1 }, available: wrPool, gap: 1,
                players: [P("x1", "RB", 100), P("x2", "RB", 60), P("x3", "RB", 45)],
                pickNo: 3, myPlayers: [] };
// gap 1 removes only eliteRB, so the WR survivor is still wrNow -> vona 0
assert.strictEqual(O.vona(wrPool[2], ctxWR.counts, wrPool, 1), 0);
// with a real gap of 3 the WR survivor is wrLater -> 40 - 22 = 18
assert.strictEqual(O.vona(wrPool[2], ctxWR.counts, wrPool, 3), 18);
// benched elite: vona 0.2*100 = 20, steal 0.5*(100-45) = 27.5 -> 47.5
const benchCtx = { counts: { QB: 1, RB: 4, WR: 2, TE: 1 }, available: wrPool, gap: 3,
                   players: [P("x1", "RB", 100), P("x2", "RB", 60), P("x3", "RB", 45)],
                   pickNo: 3, myPlayers: [] };
assert.strictEqual(O.scorePlayer(wrPool[0], benchCtx), 47.5);
// a PAR benched player sinks: vona 0.2*45 = 9, steal 0
assert.strictEqual(O.scorePlayer(wrPool[1], benchCtx), 9);

// --- rankShortlist ----------------------------------------------------------
const shortlist = O.rankShortlist({
  counts: { QB: 0, RB: 0, WR: 0, TE: 0 }, available: pool, gap: 2,
  players: board, pickNo: 3, myPlayers: [],
});
assert.ok(shortlist.length <= O.SHORTLIST_N);
assert.ok(shortlist.every(r => typeof r.why === "string" && r.why.length));
// sorted by score desc
const scores = shortlist.map(r => r.score);
assert.deepStrictEqual(scores, scores.slice().sort((a, b) => b - a));

// --- lateSlotTrigger --------------------------------------------------------
assert.strictEqual(O.lateSlotTrigger(2, false, false), true);   // in the window, both open
assert.strictEqual(O.lateSlotTrigger(2, true, true), false);    // both already filled
assert.strictEqual(O.lateSlotTrigger(5, false, false), false);  // too early
assert.strictEqual(O.lateSlotTrigger(1, true, false), true);    // DST still open

console.log("optimizer_fixture: OK");
```

- [ ] **Step 2: Run the fixture to verify it fails**

Run: `node tests/optimizer_fixture.cjs`
Expected: FAIL — `Cannot find module '../site/assets/optimizer.js'`.

- [ ] **Step 3: Write `site/assets/optimizer.js`**

Create the file exactly:

```javascript
// site/assets/optimizer.js
/* Pick-time draft optimizer — pure math only (no DOM, no network) so the node
   fixture can require it. Spec: docs/superpowers/specs/2026-07-26-draft-optimizer-design.md

   Objective: maximize expected STARTING-LINEUP VORP. A player's score is his
   marginal contribution to that objective:

     score = vona(X) + W_STEAL * steal(X) - byePenalty(X)

   vona = roster-aware Value Over Next Available. It unifies value, need and
   timing in one term: a player who fills a slot is worth what he beats the
   survivor-at-his-position by (so a deep position scores ~0 = "wait", and a
   cliff scores high = "take him now"); a player who'd ride the bench is worth
   a fraction of his standalone value. There is deliberately no separate `need`
   multiplier or urgency weight -- VORP already prices positional scarcity, so
   adding one would double-count it. */
(function (root, factory) {
  const O = factory();
  if (typeof window !== "undefined") window.Optimizer = O;
  if (typeof module !== "undefined" && module.exports) module.exports = O;
})(this, function () {
  const W_STEAL = 0.5;        // steal is a different currency (trade value)
  const BENCH_WEIGHT = 0.2;   // a benched player's share of standalone value
  const BYE_PEN = 3.0;        // VORP points, marginal by design
  const LATE_ROUNDS = 2;      // K/DST nudge window, in rounds remaining
  const SHORTLIST_N = 5;
  const DEDICATED = { QB: 1, RB: 2, WR: 2, TE: 1 };
  const FLEX_SLOTS = 2;
  const FLEX_POS = ["RB", "WR", "TE"];
  const POSITIONS = ["QB", "RB", "WR", "TE"];
  const BYE_STACK_LIMIT = 3;  // penalize the 3rd+ starter sharing a bye

  function rosterSlots(myPlayers) {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const p of myPlayers || []) {
      if (counts[p.position] !== undefined) counts[p.position]++;
    }
    return counts;
  }

  // Which lineup slot this position would fill next: its dedicated starter
  // slot, else a shared flex slot, else nothing (he'd ride the bench).
  function openSlot(pos, counts) {
    const ded = DEDICATED[pos];
    if (ded === undefined) return "none";
    if (counts[pos] < ded) return "dedicated";
    if (!FLEX_POS.includes(pos)) return "none";
    const flexUsed = FLEX_POS.reduce(
      (n, q) => n + Math.max(0, counts[q] - DEDICATED[q]), 0);
    return flexUsed < FLEX_SLOTS ? "flex" : "none";
  }

  // Best VORP at `pos` expected to survive `gap` picks, assuming the drafters
  // between now and your next pick take the best available by VORP. Floored at
  // 0: no survivor means replacement level, which is VORP 0 by construction.
  function replacement(available, pos, gap) {
    const after = available.slice(gap);
    const survivor = after.find(p => p.position === pos);
    return survivor ? Math.max(0, survivor.vorp) : 0;
  }

  function vona(player, counts, available, gap) {
    const starts = openSlot(player.position, counts) !== "none";
    if (!starts) return BENCH_WEIGHT * player.vorp;
    return Math.max(0, player.vorp - replacement(available, player.position, gap));
  }

  // The value you'd "normally" get at this overall pick: the board row at that
  // rank. Board rank encodes ECR order, so this is an ECR-anchored yardstick.
  function parVorp(players, pickNo) {
    const row = players[pickNo - 1];
    return row && Number.isFinite(row.vorp) ? Math.max(0, row.vorp) : 0;
  }

  function steal(player, players, pickNo) {
    return Math.max(0, player.vorp - parVorp(players, pickNo));
  }

  // Only starters are penalized: a bench stash on a crowded bye costs nothing.
  function byePenalty(player, myPlayers, counts) {
    if (openSlot(player.position, counts) === "none") return 0;
    if (!player.bye) return 0;
    const shared = (myPlayers || []).filter(p => p.bye === player.bye).length;
    return shared + 1 >= BYE_STACK_LIMIT ? BYE_PEN : 0;
  }

  function scorePlayer(player, ctx) {
    return vona(player, ctx.counts, ctx.available, ctx.gap)
      + W_STEAL * steal(player, ctx.players, ctx.pickNo)
      - byePenalty(player, ctx.myPlayers, ctx.counts);
  }

  // One-line "why", from whichever term dominates.
  function whyLabel(player, ctx) {
    const slot = openSlot(player.position, ctx.counts);
    const v = vona(player, ctx.counts, ctx.available, ctx.gap);
    const s = W_STEAL * steal(player, ctx.players, ctx.pickNo);
    const bye = byePenalty(player, ctx.myPlayers, ctx.counts);
    const parts = [];
    if (s > v && s > 0) {
      parts.push(`steal: ECR ${Math.round(player.ecr)}, here at ${ctx.pickNo}`);
    } else if (slot !== "none") {
      const cliff = player.vorp - replacement(ctx.available, player.position, ctx.gap);
      const where = slot === "flex" ? "flex" : `${player.position}${ctx.counts[player.position] + 1}`;
      parts.push(cliff > 0
        ? `fills ${where} · cliff −${cliff.toFixed(1)} before your next pick`
        : `fills ${where}`);
    } else {
      parts.push("depth · safe to wait");
    }
    if (bye) parts.push(`bye ${player.bye} stacked`);
    return parts.join(" · ");
  }

  function rankShortlist(ctx) {
    return (ctx.available || [])
      .filter(p => POSITIONS.includes(p.position) && Number.isFinite(p.vorp))
      .map(p => ({ player: p, score: scorePlayer(p, ctx), why: whyLabel(p, ctx) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, SHORTLIST_N);
  }

  // Remind about K/DST only in the last rounds, and only while a slot is open.
  function lateSlotTrigger(roundsLeft, haveK, haveDst) {
    if (!Number.isFinite(roundsLeft) || roundsLeft > LATE_ROUNDS) return false;
    return !haveK || !haveDst;
  }

  return { rosterSlots, openSlot, replacement, vona, parVorp, steal, byePenalty,
           scorePlayer, whyLabel, rankShortlist, lateSlotTrigger,
           W_STEAL, BENCH_WEIGHT, BYE_PEN, LATE_ROUNDS, SHORTLIST_N,
           DEDICATED, FLEX_SLOTS };
});
```

- [ ] **Step 4: Run the fixture to verify it passes**

Run: `node tests/optimizer_fixture.cjs`
Expected: prints `optimizer_fixture: OK`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add site/assets/optimizer.js tests/optimizer_fixture.cjs
git commit -m "feat: pure pick-time optimizer math (roster-aware VONA + steal)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: K/DST late-slot ADP data (`late_slots` in `draft.json`)

Emit an ADP-only K/DST list into the draft payload. No projections, no `vorp`/`ecr`.

**Files:**
- Modify: `src/ffmodel/data/adp.py`
- Modify: `src/ffmodel/site/generate.py`
- Test: `tests/test_adp.py`, `tests/test_generate.py`

**Interfaces:**
- Produces: `ffmodel.data.adp.late_slot_adp(raw: dict) -> dict` → `{"K": [{"name": str, "adp": float}, …], "DST": [...]}`, each list sorted by `adp` ascending. Consumed by `generate.py` and rendered by Task 4.

**Context the implementer needs:** `pull_adp` already requests `position=all`, so the raw FFCalculator payload already contains K and DEF rows — `normalize_adp` filters them out via `POSITIONS` (QB/RB/WR/TE). FFCalculator labels defenses `"DEF"`; the payload key is `"DST"`. These rows are display-only, so they are NOT crosswalked to gsis ids (no model ever consumes them).

- [ ] **Step 1: Write the failing python test**

Add to `tests/test_adp.py`:

```python
def test_late_slot_adp_keeps_only_k_and_dst_sorted_by_adp():
    from ffmodel.data.adp import late_slot_adp

    raw = {"players": [
        {"name": "Some RB", "position": "RB", "adp": 1.2},
        {"name": "Late K", "position": "K", "adp": 150.0},
        {"name": "Early K", "position": "K", "adp": 140.5},
        {"name": "A Defense", "position": "DEF", "adp": 138.0},
    ]}
    out = late_slot_adp(raw)
    assert list(out) == ["K", "DST"]
    assert out["K"] == [{"name": "Early K", "adp": 140.5},
                        {"name": "Late K", "adp": 150.0}]
    assert out["DST"] == [{"name": "A Defense", "adp": 138.0}]


def test_late_slot_adp_missing_positions_yield_empty_lists():
    from ffmodel.data.adp import late_slot_adp

    out = late_slot_adp({"players": [{"name": "RB", "position": "RB", "adp": 1.0}]})
    assert out == {"K": [], "DST": []}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PYTHONPATH=src python -m pytest tests/test_adp.py -k late_slot -v`
Expected: FAIL with `ImportError: cannot import name 'late_slot_adp'`.

- [ ] **Step 3: Implement `late_slot_adp`**

Append to `src/ffmodel/data/adp.py`:

```python
# K/DST are OUT of model scope (kickers/defenses do not predict year to year),
# so they get no projection -- only the crowd's ADP, as a late-round slot
# reminder. Display-only, hence no gsis crosswalk.
LATE_SLOT_POSITIONS = {"K": "K", "DEF": "DST"}


def late_slot_adp(raw: dict) -> dict:
    """K/DST rows from a raw FFCalculator `/adp` payload, ADP-ascending."""
    out: dict[str, list] = {"K": [], "DST": []}
    for row in raw.get("players", []):
        key = LATE_SLOT_POSITIONS.get(row.get("position"))
        if key is None:
            continue
        out[key].append({"name": row["name"], "adp": float(row["adp"])})
    for key in out:
        out[key].sort(key=lambda r: r["adp"])
    return out
```

- [ ] **Step 4: Run it to verify it passes**

Run: `PYTHONPATH=src python -m pytest tests/test_adp.py -k late_slot -v`
Expected: 2 passed.

- [ ] **Step 5: Write the failing generate test**

Add to `tests/test_generate.py`:

```python
def test_draft_payload_carries_late_slots(monkeypatch, tmp_path):
    from ffmodel.site import generate

    payload = {"season": 2026, "players": []}
    monkeypatch.setattr(generate, "_late_slots", lambda season, data_dir:
                        {"K": [{"name": "Early K", "adp": 140.5}], "DST": []})
    out = generate._attach_late_slots(payload, 2026, tmp_path)
    assert out["late_slots"] == {"K": [{"name": "Early K", "adp": 140.5}],
                                 "DST": []}


def test_late_slots_degrade_to_empty_when_adp_unavailable(monkeypatch, tmp_path):
    from ffmodel.site import generate

    def boom(season, data_dir):
        raise RuntimeError("ffcalculator down")

    monkeypatch.setattr(generate, "_late_slots", boom)
    out = generate._attach_late_slots({"season": 2026, "players": []}, 2026, tmp_path)
    assert out["late_slots"] == {"K": [], "DST": []}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `PYTHONPATH=src python -m pytest tests/test_generate.py -k late_slots -v`
Expected: FAIL with `AttributeError: module 'ffmodel.site.generate' has no attribute '_attach_late_slots'`.

- [ ] **Step 7: Implement the generate wiring**

In `src/ffmodel/site/generate.py`, add these two functions immediately after `_load_adp` (around line 149):

```python
def _late_slots(season, data_dir):
    """Raw K/DST ADP for the late-round slot reminder (display-only)."""
    import json
    import urllib.request

    from ffmodel.data.adp import late_slot_adp

    url = ("https://fantasyfootballcalculator.com/api/v1/adp/ppr"
           f"?teams=12&year={season}&position=all")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    return late_slot_adp(raw)


def _attach_late_slots(payload, season, data_dir):
    """Best-effort: the board never depends on K/DST ADP, so a failure just
    yields empty lists and the UI degrades to a generic reminder."""
    try:
        payload["late_slots"] = _late_slots(season, data_dir)
    except Exception as exc:                     # noqa: BLE001 - overlay is optional
        print(f"K/DST ADP unavailable ({exc}); late-slot lists will be empty")
        payload["late_slots"] = {"K": [], "DST": []}
    return payload
```

Then, in `main()`, change the draft payload line (currently `payloads["draft.json"] = build_draft_board(...)`) to wrap the result:

```python
    if args.draft:
        payloads["draft.json"] = _attach_late_slots(build_draft_board(
            weekly, schedules, predictor, args.season, data_through, prefit=True,
            sleeper_players=sleeper_players, draft_picks=draft_picks,
            ecr=ecr, adp=adp, replacement_rank=replacement), args.season, args.data_dir)
```

- [ ] **Step 8: Run the python suite**

Run: `PYTHONPATH=src python -m pytest tests/test_adp.py tests/test_generate.py -q`
Expected: all pass (no failures, no errors).

- [ ] **Step 9: Commit**

```bash
git add src/ffmodel/data/adp.py src/ffmodel/site/generate.py tests/test_adp.py tests/test_generate.py
git commit -m "feat: late_slots K/DST ADP block in draft.json (no projections)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Draft-mode integration — roster inference, gap-to-next-pick, shortlist render

Replace the roster-blind waiting-costs line with the shortlist, driven by `window.Optimizer`.

**Files:**
- Modify: `site/assets/draftmode.js`
- Modify: `site/index.html`

**Interfaces:**
- Consumes (Task 1): `window.Optimizer.{rosterSlots, rankShortlist, lateSlotTrigger}`.
- Consumes (Task 2): `board.late_slots` = `{K: [{name, adp}], DST: [...]}`.
- Produces: `DraftMode.gapToNextPick(slot, teams, rounds, reversalRound, picksMade, type)` → integer ≥ 0 or `null`, exported for the fixture. It is the count of picks between the selection now on the clock and your NEXT pick after it.

**Context the implementer needs:** `draftmode.js` already exports `nextPickNumber(slot, teams, rounds, reversalRound, picksMade, type)` returning the next overall pick number for your slot, or `null`. `applyPicks` already computes `state.mine` (your player_ids) and `state.drafted`. Board rows carry `sleeper_id`, `position`, `vorp`, `bye`, `ecr`. The existing `vonaDeltas` function is REPLACED by the shortlist — delete it; after Step 3 nothing calls it (verify with `grep -rn vonaDeltas site tests`).

**There is NO `tests/draftmode_fixture.cjs` — you create it in Step 1.** `draftmode.js` is a browser-only IIFE (`window.DraftMode = (() => {…})();`), so `require()` alone does not work: it references `window` at load. The fixture below defines a minimal `global.window`/`global.document` first, then requires the file for its side effect and reads `window.DraftMode`. Do NOT restructure `draftmode.js` into a UMD module — the shim is the smaller change and keeps this task focused.

- [ ] **Step 1: Create the failing draft-mode fixture**

Create `tests/draftmode_fixture.cjs`:

```javascript
// tests/draftmode_fixture.cjs — run with: node tests/draftmode_fixture.cjs
// draftmode.js is a browser IIFE: shim the globals it touches at load time,
// then read the module off the fake window.
const assert = require("assert");
global.window = {};
global.document = { addEventListener() {}, getElementById: () => null,
                    querySelector: () => null, hidden: false };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
require("../site/assets/draftmode.js");
const D = global.window.DraftMode;

// nextPickNumber: 12-team snake, slot 3 -> picks #3, #22, #27, #46, #51 ...
// (values below were verified against the shipped implementation)
assert.strictEqual(D.nextPickNumber(3, 12, 15, 0, 0, "snake"), 3);
assert.strictEqual(D.nextPickNumber(3, 12, 15, 0, 2, "snake"), 3);
assert.strictEqual(D.nextPickNumber(3, 12, 15, 0, 3, "snake"), 22);

// gapToNextPick: picks BETWEEN the selection on the clock and your next pick.
// On the clock at #3 (2 picks made): #22 is next -> 18 picks in between.
// NOTE this is nonzero ON THE CLOCK -- the whole point of the fix.
assert.strictEqual(D.gapToNextPick(3, 12, 15, 0, 2, "snake"), 18);
// On the clock at #22 (21 made): next is #27 -> 4 in between (turn-of-snake).
assert.strictEqual(D.gapToNextPick(3, 12, 15, 0, 21, "snake"), 4);
// Just past the turn, on the clock at #27 (22 made): next is #46 -> 18.
assert.strictEqual(D.gapToNextPick(3, 12, 15, 0, 22, "snake"), 18);
// A 1-round draft has no pick after your first -> null
assert.strictEqual(D.gapToNextPick(3, 12, 1, 0, 2, "snake"), null);
// Invalid inputs propagate null (same guard as nextPickNumber)
assert.strictEqual(D.gapToNextPick(0, 12, 15, 0, 2, "snake"), null);

console.log("draftmode_fixture: OK");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/draftmode_fixture.cjs`
Expected: FAIL — `TypeError: D.gapToNextPick is not a function` (the shim loads and `nextPickNumber` passes; only the new function is missing).

- [ ] **Step 3: Implement `gapToNextPick` and delete `vonaDeltas`**

In `site/assets/draftmode.js`, DELETE the whole `vonaDeltas` function (it is superseded by the optimizer's `replacement`), and add in its place:

```javascript
  // Picks between the selection currently on the clock and your NEXT pick.
  // This is the window other drafters get before you choose again -- the
  // horizon the optimizer's replacement level is measured over. It is nonzero
  // when you are on the clock, which is exactly when it drives the decision.
  function gapToNextPick(slot, teams, rounds, reversalRound, picksMade, type = "snake") {
    const current = nextPickNumber(slot, teams, rounds, reversalRound, picksMade, type);
    if (current === null) return null;
    const after = nextPickNumber(slot, teams, rounds, reversalRound, current, type);
    if (after === null) return null;
    return after - current - 1;
  }
```

Change the export line at the bottom of the file from
`return { init, disable, nextPickNumber, vonaDeltas };` to:

```javascript
  return { init, disable, nextPickNumber, gapToNextPick };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node tests/draftmode_fixture.cjs`
Expected: prints its OK line, exit 0.

- [ ] **Step 5: Replace `updateAids` with the shortlist render**

In `site/assets/draftmode.js`, replace the entire `updateAids` function with:

```javascript
  // My drafted board rows (for roster counts + bye stacking). Players with no
  // board entry (K/DST/retired) simply do not contribute.
  function myBoardPlayers() {
    const rows = [];
    for (const p of cfg.board.players) {
      if (p.sleeper_id && state.mine.has(p.sleeper_id)) rows.push(p);
    }
    return rows;
  }

  function haveLateSlot(picks, position) {
    if (!session || !session.userId) return false;
    return picks.some(p => p.picked_by === session.userId
      && p.metadata && p.metadata.position === position);
  }

  function updateAids(picks) {
    const t = cfg.els.ticker, v = cfg.els.vona, l = cfg.els.late;
    if (picks.length) {
      const recent = picks.slice(-3).map(p => {
        const m = p.metadata || {};
        const name = [m.first_name, m.last_name].filter(Boolean).join(" ")
                     || m.position || "?";
        return `#${p.pick_no} ${name}`;
      });
      t.textContent = "Recent: " + recent.join(" · ");
      t.hidden = false;
    } else {
      t.hidden = true;
    }
    v.hidden = true;                    // default: render nothing, never wrong math
    if (l) l.hidden = true;
    if (!window.Optimizer) return;
    if (!session || !session.slot || !session.teams || !session.rounds) return;
    const next = nextPickNumber(session.slot, session.teams, session.rounds,
                                session.reversalRound, picks.length, session.type);
    if (next === null) return;          // auction/unknown type or no pick left
    const gap = gapToNextPick(session.slot, session.teams, session.rounds,
                              session.reversalRound, picks.length, session.type);
    const until = next - picks.length - 1;   // full picks before yours
    const mine = myBoardPlayers();
    const available = cfg.board.players
      .filter(p => !(p.sleeper_id && state.drafted.has(p.sleeper_id))
                   && Number.isFinite(p.vorp))
      .slice()
      .sort((a, b) => b.vorp - a.vorp);
    const shortlist = window.Optimizer.rankShortlist({
      counts: window.Optimizer.rosterSlots(mine),
      available, gap: gap === null ? 0 : gap,
      players: cfg.board.players, pickNo: picks.length + 1, myPlayers: mine,
    });
    const head = until <= 0
      ? `ON THE CLOCK · pick #${picks.length + 1}`
      : `pick #${picks.length + 1} · your turn in ${until + 1}`;
    const rows = shortlist.map((r, i) =>
      `<li>${i + 1}. ${esc(r.player.name)} (${esc(r.player.position)}) — ${esc(r.why)}</li>`)
      .join("");
    v.innerHTML = `<strong>${esc(head)}</strong><ol class="draft-shortlist">${rows}</ol>`;
    v.title = "assumes the picks before yours take the best available by VORP";
    v.hidden = false;
    renderLateSlots(picks, l);
  }

  function renderLateSlots(picks, l) {
    if (!l || !session || !session.rounds) return;
    const myPickCount = session.userId
      ? picks.filter(p => p.picked_by === session.userId).length : 0;
    const roundsLeft = session.rounds - myPickCount;
    const haveK = haveLateSlot(picks, "K");
    const haveDst = haveLateSlot(picks, "DEF");
    if (!window.Optimizer.lateSlotTrigger(roundsLeft, haveK, haveDst)) return;
    const late = cfg.board.late_slots || { K: [], DST: [] };
    const need = [!haveK ? "K" : null, !haveDst ? "D/ST" : null].filter(Boolean);
    const names = key => (late[key] || []).slice(0, 3)
      .map(r => esc(r.name)).join(" · ");
    const lists = [!haveK && names("K") ? `K: ${names("K")}` : null,
                   !haveDst && names("DST") ? `D/ST: ${names("DST")}` : null]
      .filter(Boolean).join(" | ");
    l.innerHTML = `⚠ fill ${esc(need.join(" + "))} — ADP says now`
      + (lists ? ` · ${lists} <em>(not projected)</em>` : "");
    l.hidden = false;
  }
```

Add this escape helper immediately above `updateAids` (the board's `FC.esc` is not guaranteed loaded inside this module):

```javascript
  const esc = s => String(s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
```

- [ ] **Step 6: Add the late-slot element and script tag to `index.html`**

In `site/index.html`, immediately after the `<p class="draft-vona" id="draft-vona" hidden></p>` line (line 44), add:

```html
      <p class="draft-late" id="draft-late" hidden></p>
```

In the `els:` object of the `DraftMode.init({…})` call, add after the `vona:` line:

```javascript
          late: document.getElementById("draft-late"),
```

And add the optimizer script tag immediately BEFORE the existing `draftmode.js` script tag (order matters — `draftmode.js` reads `window.Optimizer`):

```html
<script src="assets/optimizer.js"></script>
```

- [ ] **Step 7: Verify both fixtures still pass**

Run: `node tests/draftmode_fixture.cjs && node tests/optimizer_fixture.cjs`
Expected: both print their OK lines.

- [ ] **Step 8: Commit**

```bash
git add site/assets/draftmode.js site/index.html tests/draftmode_fixture.cjs
git commit -m "feat: pick-time shortlist replaces roster-blind VONA line

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Styling, copy, and browser verification

Make the widget legible and prove it works end-to-end against a mocked draft.

**Files:**
- Modify: `site/assets/style.css`
- Modify: `site/index.html`

**Interfaces:**
- Consumes (Tasks 1–3): the rendered `#draft-vona` shortlist markup (`<ol class="draft-shortlist">`) and `#draft-late`.

- [ ] **Step 1: Add the shortlist styles**

Append to `site/assets/style.css`:

```css
/* Pick-time optimizer shortlist */
.draft-shortlist { margin: .35rem 0 0; padding-left: 1.1rem; }
.draft-shortlist li { line-height: 1.45; }
.draft-late { margin-top: .4rem; font-size: .95em; }
.draft-late em { opacity: .75; }
```

- [ ] **Step 2: Update the draft-panel copy**

In `site/index.html`, replace the `<p class="draft-note">` text inside the draft panel (line 28–29) with:

```html
      <p class="draft-note">Live Sleeper overlay: drafted players get struck on the
      board as picks come in, and the shortlist ranks your best picks right now —
      value, roster need, and who survives to your next pick. Read-only, no login —
      works on mock drafts too.</p>
```

- [ ] **Step 3: Serve the site**

Run: `cd site && python -m http.server 8099`
Expected: server starts; `http://127.0.0.1:8099/index.html` returns 200.

- [ ] **Step 4: Browser-verify the happy path (mocked draft)**

Open `http://127.0.0.1:8099/index.html`, override `window.fetch` with canned Sleeper responses for a 12-team snake draft (a `/draft/<id>` object with `settings.rounds = 15`, `settings.teams = 12`, and a `draft_order` giving your user a slot; a `/draft/<id>/picks` array whose `player_id`s match real `sleeper_id`s on the board), connect via the draft panel, and confirm:
- The shortlist renders 3–5 rows with names, positions, and a "why" for each.
- The header reads `ON THE CLOCK · pick #N` when it's your turn and `pick #N · your turn in K` otherwise.
- As picks are added that fill your RB slots, RB rows fall down the list (need decays) — and a planted elite faller still surfaces with a `steal:` why.
- A "cliff" why appears for a position whose survivor is far worse.
- Zero console errors; the board table itself still renders and sorts.

- [ ] **Step 5: Browser-verify the late-slot nudge and fail-soft**

- Feed picks until your rounds-remaining ≤ 2 with no K/DST taken: the `#draft-late` line appears with ADP names and "(not projected)".
- Stub `/draft/<id>` to return an auction type (`type: "auction"`): the shortlist stays hidden, no console error, board intact.
- Disconnect: shortlist and late line both hide.

- [ ] **Step 6: Stop the server and commit**

```bash
git add site/assets/style.css site/index.html
git commit -m "feat: shortlist styling + draft-panel copy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §2 objective + score → Task 1 `scorePlayer`; §2 `vona` unification → Task 1 `vona`/`replacement`; §2 gap-to-NEXT-pick active on the clock → Task 3 `gapToNextPick` (+ fixture asserting nonzero on the clock); §2 steal vs ECR → Task 1 `steal`/`parVorp`; §2 bye penalty → Task 1 `byePenalty`; §2 K/DST ADP-only → Tasks 2 + 3 `renderLateSlots`; §4 component table → Task 1 (pure module), Task 3 (`updateAids`, roster inference), Task 2 (`generate.py`/`adp.py`), Task 4 (index.html/css); §5 data flow steps 1–6 → Task 3 `updateAids`; §6 exact constants and formulas → Task 1 verbatim; §6 worked check → Task 1 fixture asserts 47.5 and 9; §7 UI shape → Tasks 3–4; §8 `late_slots` + empty degrade → Task 2 (both tests); §9 fail-soft → Task 3 (early returns hide the widget) + Task 2 (`_attach_late_slots` try/except) + Task 4 Step 5; §10 testing → Task 1 fixture, Task 2 pytest, Task 3 fixture, Task 4 browser; §11 limitations are documented, not implemented. No gaps.

**Placeholder scan:** none — every step carries complete code or an exact command.

**Type consistency:** `player` = `{ name, position, vorp, bye, ecr }` in Task 1's fixture, Task 1's implementation, and Task 3's board rows. `counts` = `{QB,RB,WR,TE}` produced by `rosterSlots`, consumed by `openSlot`/`vona`/`byePenalty`/`whyLabel`. `ctx` = `{ counts, available, gap, players, pickNo, myPlayers }` — built identically in the Task 1 fixture and Task 3's `updateAids`. `late_slots` = `{K:[{name,adp}],DST:[…]}` produced by Task 2 `late_slot_adp`, consumed by Task 3 `renderLateSlots`. `gapToNextPick` is defined in Task 3 and used only there and in its fixture. `vonaDeltas` is deleted in Task 3 and referenced nowhere afterward.
