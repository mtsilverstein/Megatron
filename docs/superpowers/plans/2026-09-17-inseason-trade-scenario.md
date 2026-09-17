# In-Season Trade Scenario Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make `trade.html` work in season by wiring the existing conditional lineup engine (`seasontrade.js`) into the page as a "conditional lineup scenario" — both sides' week-by-week starting-lineup change under user-stated availability assumptions — with no grade, verdict, suggestions or pick/keeper valuation.

**Architecture:** One shared exact lineup solver (`site/assets/ros.js`) replaces the two private copies in `waivers.js` and `seasontrade.js`, and hosts the evaluation-text helper the waiver page already uses. A new controller `site/assets/seasontrademode.js` (pure helpers exported for node tests + a DOM `init`) drives an in-season section of `trade.html`; the page's bootstrap chooses the pre-draft controller or the in-season one from the live league status. The pre-draft engine stays gated in season.

**Tech Stack:** plain browser JS in UMD modules tested with `node tests/<name>_fixture.cjs`; no Python changes.

**Spec:** `docs/superpowers/specs/2026-09-17-inseason-trade-scenario-design.md` — read it first; strings below are copied from it.

## Global Constraints

- The pre-draft engine (`Trade.*`, `TradeMode.leagueWorld`) is never called for an in-season league; `trademode.js:135`'s gate and its fixture stay (spec §6.6).
- Unknown is never zero: the engine blocks on any unmodeled active player-week on either roster; the page lists the gaps and scores nothing (spec §6.1).
- Exclusions are user assumptions, displayed back verbatim, never auto-filled from an injury tag (spec §6.3).
- Picks and keeper effects are never folded into any number (spec §6.4).
- Forbidden words in controller text-builder output: `verdict`, `win/win`, `fair`, `winner`, `accept`, `recommend`, `grade` — except the two literal sentences `"Conditional lineup scenario — not a trade verdict."` and the sub-line ending `"…so no overall grade is shown."` (spec §4.5).
- `ros.js` loads before `waivers.js`/`waivermode.js`/`seasontrade.js` on `waivers.html`, `weekly.html`, `trade.html`, as `assets/ros.js?v=1`; shared-assets fixture enforces one version (spec §2).
- Parity: `tests/waivers_fixture.cjs` (43 groups), `tests/waivermode_fixture.cjs`, `tests/seasontrade_fixture.cjs` keep passing with the shared solver (spec §2).
- Sign formatting for deltas: leading `+`/`−` (U+2212), two decimals (spec §4.5.2).
- Commit after every task; commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: `ros.js` — one lineup solver, one evaluation-text helper

**Files:**
- Create: `site/assets/ros.js`
- Modify: `site/assets/waivers.js` (delete `lineupScore` at ~lines 60–88, call `Lineup.lineupScore`; `SLOT_ELIGIBLE` may stay local)
- Modify: `site/assets/seasontrade.js` (delete `lineup()` at lines 15–26; adapt the two calls at lines 148–149)
- Modify: `site/assets/waivermode.js` (delete `evaluationText` at ~114–129; export `ROS.evaluationText` under the same name for backward compatibility of the fixture)
- Modify: `site/waivers.html`, `site/weekly.html`, `site/trade.html` (add `<script src="assets/ros.js?v=1"></script>` before the first consumer)
- Modify: `tests/shared_assets_fixture.cjs` (add `'ros.js'` to the shared-consumer list)
- Modify: `tests/waivermode_fixture.cjs` (move the `evaluationText` cases out)
- Create: `tests/ros_fixture.cjs`

**Interfaces:**
- Produces: `ROS.SLOT_ELIGIBLE`, `ROS.lineupScore(players, slots, scoreOf) -> number | -Infinity`, `ROS.bestLineup(players, slots, scoreOf) -> { total, starters: [{ player, slot, points }] }` (starters in `slots` order; `total: -Infinity, starters: []` when unfillable), `ROS.evaluationText(evaluation) -> string[]`. In node: `const ROS = require("../site/assets/ros.js")`.

- [ ] **Step 1: Write the failing fixture**

Create `tests/ros_fixture.cjs`:

```js
// tests/ros_fixture.cjs — run with: node tests/ros_fixture.cjs
const assert = require("node:assert/strict");
const ROS = require("../site/assets/ros.js");

let n = 0;
function check(name, fn) { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }

// Exhaustive assignment: every injective map of players onto slots that respects
// eligibility; the best total is the ground truth both solvers must match.
function bruteForce(players, slots, scoreOf) {
  let best = -Infinity;
  const used = new Array(players.length).fill(false);
  (function rec(i, total) {
    if (i === slots.length) { best = Math.max(best, total); return; }
    for (let j = 0; j < players.length; j++) {
      if (used[j]) continue;
      const v = scoreOf(players[j]);
      if (v === null || !ROS.SLOT_ELIGIBLE[slots[i]].includes(players[j].position)) continue;
      used[j] = true; rec(i + 1, total + v); used[j] = false;
    }
  })(0, 0);
  return best;
}

let seed = 11; const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const POS = ["QB", "RB", "WR", "TE"];
const SHAPES = [["QB","RB","WR","TE","FLEX"], ["QB","RB","RB","WR","WR","TE","FLEX","FLEX"], ["RB","SUPER_FLEX"], ["QB","RB","WR","TE","FLEX","SUPER_FLEX"], ["RB","FLEX"], ["QB"]];

check("lineupScore and bestLineup match exhaustive search on random rosters", () => {
  for (let t = 0; t < 300; t++) {
    const slots = SHAPES[t % SHAPES.length];
    const size = slots.length + Math.floor(rand() * 3);
    const players = Array.from({ length: size }, (_, i) => ({ id: `p${i}`, position: POS[Math.floor(rand() * 4)], pts: rand() < 0.15 ? null : Math.round(rand() * 250) / 10 }));
    const scoreOf = p => p.pts;
    const truth = bruteForce(players, slots, scoreOf);
    const score = ROS.lineupScore(players, slots, scoreOf);
    const best = ROS.bestLineup(players, slots, scoreOf);
    assert.ok(Math.abs(score - truth) < 1e-9 || (score === -Infinity && truth === -Infinity), `lineupScore ${score} vs brute ${truth} for ${slots}`);
    assert.ok(Math.abs(best.total - truth) < 1e-9 || (best.total === -Infinity && truth === -Infinity), `bestLineup ${best.total} vs brute ${truth}`);
    if (Number.isFinite(truth)) {
      assert.equal(best.starters.length, slots.length);
      assert.deepEqual(best.starters.map(s => s.slot), slots, "starters come back in slot order");
      assert.ok(best.starters.every(s => ROS.SLOT_ELIGIBLE[s.slot].includes(s.player.position)), "every starter is eligible for its slot");
      assert.equal(new Set(best.starters.map(s => s.player.id)).size, slots.length, "no player starts twice");
      assert.ok(Math.abs(best.starters.reduce((a, s) => a + s.points, 0) - best.total) < 1e-9);
    } else {
      assert.deepEqual(best.starters, []);
    }
  }
});

check("null scores are skipped, never zero", () => {
  const players = [{ id: "a", position: "RB", pts: null }, { id: "b", position: "RB", pts: 4 }];
  assert.equal(ROS.lineupScore(players, ["RB"], p => p.pts), 4);
  assert.equal(ROS.bestLineup(players, ["RB"], p => p.pts).starters[0].player.id, "b");
  assert.equal(ROS.lineupScore(players, ["RB", "RB"], p => p.pts), -Infinity);
});

check("evaluationText builds from the payload block and never throws on null fields", () => {
  assert.deepEqual(ROS.evaluationText(null), ["no measured evaluation for this league's scoring"]);
  const block = { source: "x", baseline: "mean league-scored production in the last four recorded pre-origin games", seasons: [2023, 2024, 2025], origins: [5, 9],
    horizons: [{ horizon: 1, model_mae: 4.612, baseline_mae: 4.815, paired_forecasts: 1817, forecast_players: 3701, missing_actuals: 1857 },
               { horizon: 8, model_mae: null, baseline_mae: 4.987, paired_forecasts: 1834 }], limitation: "Dependent windows.", scoring_scope: "evaluated under gabagool scoring, which matches this league" };
  const lines = ROS.evaluationText(block);
  assert.equal(lines[0], "Measured on 2023–2025 (origins week 5 and 9) against mean league-scored production in the last four recorded pre-origin games:");
  assert.equal(lines[1], "1 week ahead: model MAE 4.61 vs baseline 4.82 (1,817 paired forecasts)");
  assert.match(lines[2], /^8 weeks ahead: model MAE n\/a vs baseline 4\.99/);
  assert.match(lines[3], /^Horizons beyond 8 weeks are not measured; errors are over players who recorded a game \(1,817 of 3,701 forecasts at 1 week ahead had an outcome\)\.$/);
  assert.equal(lines[4], "evaluated under gabagool scoring, which matches this league");
  assert.equal(lines[5], "Dependent windows.");
});

console.log(`ros_fixture: ${n} groups OK`);
```

Move (cut, do not copy) the existing `evaluationText` assertions out of `tests/waivermode_fixture.cjs` — the block that begins `// Evaluation text is built from the payload block, never typed.` through the last `M.evaluationText(...)` assertion — and drop them; the third check above replaces them. If a waivermode assertion referenced `M.evaluationText`, it now must reference `ROS.evaluationText` via `require("../site/assets/ros.js")` or be deleted as covered.

- [ ] **Step 2: Run to verify failure**

Run: `node tests/ros_fixture.cjs`
Expected: `Cannot find module '../site/assets/ros.js'`.

- [ ] **Step 3: Create `site/assets/ros.js`**

```js
/* Shared remaining-season helpers: ONE exact lineup solver for every page that
   values a roster week by week, and the evaluation-text helper the pages print
   beside any rest-of-season number. No DOM, no fetch. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ROS = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";
  const POSITIONS = ["QB", "RB", "WR", "TE"];
  const FLEX_POS = ["RB", "WR", "TE"];
  const SLOT_ELIGIBLE = Object.freeze({
    QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"],
    FLEX: FLEX_POS.slice(), SUPER_FLEX: POSITIONS.slice(),
  });

  // Exact for the supported laminar slot family: dedicated position sets are
  // disjoint, FLEX contains RB/WR/TE, and SUPER_FLEX contains all of them.
  // Taking the best mandatory players first cannot hurt a broader slot; the
  // remaining broader slots then take the best remaining eligible scores.
  // Players whose score is null are skipped -- unknown is not zero -- and a slot
  // nobody can fill makes the whole lineup -Infinity rather than a partial sum.
  function pools(players, scoreOf) {
    const byPos = { QB: [], RB: [], WR: [], TE: [] };
    for (const p of players || []) {
      if (!byPos[p.position]) continue;
      const v = scoreOf(p);
      if (v === null || v === undefined || Number.isNaN(v)) continue;
      byPos[p.position].push({ player: p, points: v });
    }
    for (const pos of POSITIONS) byPos[pos].sort((a, b) => b.points - a.points);
    return byPos;
  }
  function need(slots) {
    const n = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPER_FLEX: 0 };
    for (const s of slots) { if (!(s in n)) throw new Error(`unsupported lineup slot ${s}`); n[s]++; }
    return n;
  }
  // The assignment itself; both public functions read it. Returns null when a
  // slot cannot be filled, naming the slot so callers can report it.
  function assign(players, slots, scoreOf) {
    const byPos = pools(players, scoreOf), n = need(slots);
    const chosen = { QB: [], RB: [], WR: [], TE: [], FLEX: [], SUPER_FLEX: [] };
    for (const pos of POSITIONS) {
      if (byPos[pos].length < n[pos]) return { unfillable: pos };
      chosen[pos] = byPos[pos].splice(0, n[pos]);
    }
    const flex = FLEX_POS.flatMap(pos => byPos[pos]).sort((a, b) => b.points - a.points);
    if (flex.length < n.FLEX) return { unfillable: "FLEX" };
    chosen.FLEX = flex.splice(0, n.FLEX);
    const superFlex = byPos.QB.concat(flex).sort((a, b) => b.points - a.points);
    if (superFlex.length < n.SUPER_FLEX) return { unfillable: "SUPER_FLEX" };
    chosen.SUPER_FLEX = superFlex.splice(0, n.SUPER_FLEX);
    return { chosen };
  }
  function lineupScore(players, slots, scoreOf) {
    const r = assign(players, slots, scoreOf);
    if (r.unfillable) return -Infinity;
    let total = 0;
    for (const k in r.chosen) for (const c of r.chosen[k]) total += c.points;
    return total;
  }
  function bestLineup(players, slots, scoreOf) {
    const r = assign(players, slots, scoreOf);
    if (r.unfillable) return { total: -Infinity, starters: [], unfillable: r.unfillable };
    const queues = {}; for (const k in r.chosen) queues[k] = r.chosen[k].slice();
    const starters = slots.map(slot => { const c = queues[slot].shift(); return { player: c.player, slot, points: c.points }; });
    return { total: starters.reduce((a, s) => a + s.points, 0), starters };
  }

  // Descriptive evaluation of the remaining-season projections, built from the
  // payload's block and never typed in; null fields print n/a rather than throw.
  function evaluationText(evaluation) {
    if (!evaluation || !Array.isArray(evaluation.horizons)) return ["no measured evaluation for this league's scoring"];
    const num = x => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
    const count = n => (Number.isFinite(n) ? n.toLocaleString("en-US") : "n/a");
    const seasons = evaluation.seasons || [], origins = evaluation.origins || [];
    const span = seasons.length ? `${seasons[0]}–${seasons[seasons.length - 1]}` : "the evaluation seasons";
    const originText = origins.length ? ` (origins week ${origins.join(" and ")})` : "";
    const lines = [`Measured on ${span}${originText} against ${evaluation.baseline}:`];
    for (const h of evaluation.horizons) lines.push(`${h.horizon} week${h.horizon === 1 ? "" : "s"} ahead: model MAE ${num(h.model_mae)} vs baseline ${num(h.baseline_mae)} (${count(h.paired_forecasts)} paired forecasts)`);
    const horizons = evaluation.horizons.map(h => h.horizon).filter(Number.isFinite);
    if (horizons.length) {
      const maxHorizon = Math.max(...horizons);
      const outcomeRow = evaluation.horizons.find(h => h.horizon === 1) || evaluation.horizons[0];
      const paren = Number.isFinite(outcomeRow.forecast_players)
        ? ` (${count(outcomeRow.paired_forecasts)} of ${count(outcomeRow.forecast_players)} forecasts at ${outcomeRow.horizon} week${outcomeRow.horizon === 1 ? "" : "s"} ahead had an outcome)` : "";
      lines.push(`Horizons beyond ${maxHorizon} weeks are not measured; errors are over players who recorded a game${paren}.`);
    }
    if (evaluation.scoring_scope) lines.push(evaluation.scoring_scope);
    if (evaluation.limitation) lines.push(evaluation.limitation);
    return lines;
  }

  return Object.freeze({ SLOT_ELIGIBLE, lineupScore, bestLineup, evaluationText });
});
```

**Before deleting the old `evaluationText` from `waivermode.js`, diff it against the version above**: the fix-wave commit a359c0e is the source of truth for its exact strings (the disclosure line, `n/a`, the parenthetical). If they differ in any character, copy waivermode's current body into `ros.js` verbatim — the fixture above pins the same strings the waivermode fixture pinned.

- [ ] **Step 4: Switch the three consumers**

`site/assets/waivers.js`: at the top of the factory, resolve the shared module the way the file resolves nothing else yet — add
```js
  const ROS = (typeof module !== "undefined" && module.exports) ? require("./ros.js") : window.ROS;
```
inside the factory (after `"use strict"` if present), delete the `lineupScore` function body (keep a one-line comment pointing at `ros.js`), and add `const lineupScore = ROS.lineupScore;`. Nothing else in the file changes; the waiver fixture is the parity test.

`site/assets/seasontrade.js`: same resolution line; delete `lineup()`; replace the two calls with
```js
        const b=asLineup(ROS.bestLineup(before[i].map(id=>resolved.get(week).get(id)).filter(Boolean),slots));
        const a=asLineup(ROS.bestLineup(after[i].map(id=>resolved.get(week).get(id)).filter(Boolean),slots));
```
and add, where `lineup()` was,
```js
  const asLineup=r=>{require(Number.isFinite(r.total),`Roster cannot fill required ${r.unfillable} slot; no replacement score assumed`);return {total:r.total,lineup:r.starters.map(s=>({...s.player,slot:s.slot}))};};
```
(`resolved` rows already carry `id,name,position,points,status`, so `bestLineup`'s `scoreOf` is `p=>p.points`; pass it explicitly: `ROS.bestLineup(list, slots, p=>p.points)`.) The seasontrade fixture asserts `before.lineup[1].position === 'QB'` for `['RB','SUPER_FLEX']` — starters come back in slot order, so this holds.

`site/assets/waivermode.js`: same resolution line at module top; delete `evaluationText`; keep the export name by adding `const evaluationText = ROS.evaluationText;` so `api.evaluationText` and every `evaluationText(...)` call in `init()` keep working.

Pages: insert `<script src="assets/ros.js?v=1"></script>` immediately before `assets/waivers.js` on `waivers.html`, before `assets/waivermode.js` on `weekly.html`, and before `assets/trademode.js` on `trade.html` (Task 4 adds `seasontrade.js` after it). `tests/shared_assets_fixture.cjs:8` — change `['app.js', 'waivermode.js']` to `['app.js', 'waivermode.js', 'ros.js']`.

- [ ] **Step 5: Run everything**

Run: `for f in tests/*_fixture.cjs; do node "$f" || exit 1; done`
Expected: all green, `ros_fixture: 3 groups OK`, `waivers_fixture: 43 groups OK`.

- [ ] **Step 6: Commit**

```bash
git add site/assets/ros.js site/assets/waivers.js site/assets/seasontrade.js site/assets/waivermode.js site/waivers.html site/weekly.html site/trade.html tests/ros_fixture.cjs tests/waivermode_fixture.cjs tests/shared_assets_fixture.cjs
git commit -m "refactor: one shared lineup solver and evaluation text (ros.js)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Engine fixtures the consensus named

**Files:**
- Modify: `tests/seasontrade_fixture.cjs` (append before the end)
- Modify only if a case fails: `site/assets/seasontrade.js`

**Interfaces:** none new. `analyze` contract as in spec §3.

- [ ] **Step 1: Append the cases**

Append to `tests/seasontrade_fixture.cjs` (the file uses top-level asserts; keep that style):

```js
// --- consensus cases ---------------------------------------------------------
// 2-for-1 with the explicit drop on the RECEIVING side: roster 2 takes a and b for c,
// must drop d to fit, and d's contribution counts against the trade for roster 2.
{
  const two = clone(base);
  two.league.roster_positions = ['RB', 'RB', 'BN'];            // capacity 3, two starters
  two.rosters = [{ roster_id: 1, players: ['a', 'b', 'e'] }, { roster_id: 2, players: ['c', 'd', 'f'] }];
  two.catalog = { ...catalog, e: { gsis_id: 'ge', position: 'RB', team: 'A', full_name: 'e' }, f: { gsis_id: 'gf', position: 'RB', team: 'A', full_name: 'f' } };
  const v2 = { ...value, e: 1, f: 3 };
  two.remaining.players = Object.keys(two.catalog).map(id => ({ player_id: 'g' + id, team: 'A', position: 'RB', weeks: [2, 3].map(week => ({ week, status: 'conditional_projection', points: { league: { p50: v2[id] } } })) }));
  two.give = ['a', 'b']; two.receive = ['c'];
  assert.throws(() => analyze(two), /capacity/, 'roster 2 would hold four with a three-man capacity');
  const out2 = analyze({ ...two, drops: { 2: ['d'] } });
  // roster 1 before: a10+b5=15 → after: c20+e1=21 (+6/wk); roster 2 before: c20+f3=23 → after: a10+b5=15 (−8/wk), d gone.
  assert.deepEqual(out2.weeks.map(w => w.sides.map(s => s.delta)), [[6, -8], [6, -8]]);
  assert.deepEqual(out2.sides.map(s => s.delta), [12, -16]);
  assert.throws(() => analyze({ ...two, drops: { 2: ['c'] } }), /retained owned player, not trade asset/);
}
// Scarce position: the only TE on a roster cannot be traded away without a replacement.
{
  const te = clone(base);
  te.league.roster_positions = ['RB', 'TE', 'BN'];
  te.catalog = { ...catalog, t: { gsis_id: 'gt', position: 'TE', team: 'A', full_name: 't' } };
  te.rosters = [{ roster_id: 1, players: ['a', 't'] }, { roster_id: 2, players: ['c', 'd'] }];
  te.remaining.players.push({ player_id: 'gt', team: 'A', position: 'TE', weeks: [2, 3].map(week => ({ week, status: 'conditional_projection', points: { league: { p50: 7 } } })) });
  te.give = ['t']; te.receive = ['d'];
  assert.throws(() => analyze(te), /cannot fill required TE slot/);
}
// A bye and an exclusion in the same week are both zero, labeled differently.
{
  const bye = clone(base);
  bye.remaining.players.find(p => p.player_id === 'ga').weeks[0] = { week: 2, status: 'bye', points: null };
  const outBye = analyze({ ...bye, excludeWeeks: { c: [2] } });
  const wk2 = outBye.weeks[0];
  assert.equal(wk2.week, 2);
  // roster 1 before: a on bye → b5 only; after: c excluded → b5 → delta 0. roster 2 before: c20; after: a bye → d2 → −18.
  assert.deepEqual(wk2.sides.map(s => s.delta), [0, -18]);
  assert.equal(wk2.sides[1].after.lineup[0].status, 'bye');
  assert.equal(wk2.sides[0].after.lineup.find(p => p.id === 'b') ? 'ok' : 'missing', 'ok');
}
// Duplicate week rows are a contract violation, not a silent double count.
{
  const dup = clone(base);
  const p = dup.remaining.players.find(p => p.player_id === 'ga');
  p.weeks.push({ ...p.weeks[0] });
  assert.throws(() => analyze(dup), /Missing\/duplicate projection week/);
}
console.log('seasontrade_fixture: OK');
```

If the file already ends with a `console.log`, put the new block before it and do not add a second one.

- [ ] **Step 2: Run**

Run: `node tests/seasontrade_fixture.cjs`
Expected: passes. If a case fails, first re-derive the arithmetic by hand from the fixture values (they are all in the comments); fix the test if the derivation was wrong, fix the engine only if the engine's behaviour contradicts spec §3/§6, and say which in the report.

- [ ] **Step 3: Commit**

```bash
git add tests/seasontrade_fixture.cjs site/assets/seasontrade.js
git commit -m "test: seasontrade consensus cases — 2-for-1 drops, scarce TE, bye+exclusion, duplicate weeks

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `seasontrademode.js` pure helpers

**Files:**
- Create: `site/assets/seasontrademode.js` (pure helpers now; `init` is Task 4)
- Create: `tests/seasontrademode_fixture.cjs`

**Interfaces:**
- Produces (all exported on the UMD object, `window.SeasonTradeMode` / `module.exports`):
  - `parseWeeks(text, first, last) -> number[]` sorted unique; `""` → `[]`; throws `weeks must look like 3-5, 8 and fall within ${first}–${last}`.
  - `identifyRoster(rosters, userId) -> roster`; throws `Could not uniquely match this account to a roster in this league.`
  - `capacityOf(league) -> number` (roster_positions minus `IR`/`TAXI`).
  - `activeSkill(roster, catalog) -> string[]` ids of QB/RB/WR/TE in `players` not in `reserve`/`taxi`.
  - `neededDrops({ activeCount, giveCount, receiveCount, capacity }) -> number` = `max(0, activeCount − giveCount + receiveCount − capacity)`.
  - `fmtDelta(x) -> string` `+12.40` / `−3.10` (U+2212) / `0.00`.
  - `scenarioText(result, ctx) -> { headline, subline, sides: [{ name, before, after, delta }], notValued: string[], assumptions: string[] }` where `ctx = { names: {rosterId: teamName}, currentWeek, firstWeek, endWeek, picks: [{label}], excludeWeeks: {id: weeks[]}, playerNames: {id: name}, drops: {rosterId: [id]} }`.
  - `coverageText(error) -> { headline, rows: [string] }`.
  - `FORBIDDEN = ["verdict", "win/win", "fair", "winner", "accept", "recommend", "grade"]` and `ALLOWED_SENTENCES` (the two literals) for the fixture.

- [ ] **Step 1: Write the failing fixture**

```js
// tests/seasontrademode_fixture.cjs — run with: node tests/seasontrademode_fixture.cjs
const assert = require("node:assert/strict");
const M = require("../site/assets/seasontrademode.js");
let n = 0;
function check(name, fn) { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }

check("parseWeeks accepts ranges and singles inside the horizon", () => {
  assert.deepEqual(M.parseWeeks("3-5, 8", 2, 17), [3, 4, 5, 8]);
  assert.deepEqual(M.parseWeeks(" 9 ", 2, 17), [9]);
  assert.deepEqual(M.parseWeeks("", 2, 17), []);
  assert.deepEqual(M.parseWeeks("5-3", 2, 17), [3, 4, 5], "a reversed range is still a range");
  assert.deepEqual(M.parseWeeks("4,4,4", 2, 17), [4]);
  for (const bad of ["1", "18", "3-19", "abc", "3;4", "2-", "0"]) assert.throws(() => M.parseWeeks(bad, 2, 17), /weeks must look like 3-5, 8 and fall within 2–17/, bad);
});
check("identifyRoster matches owner or co-owner, exactly once", () => {
  const rosters = [{ roster_id: 1, owner_id: "u1", co_owners: null }, { roster_id: 2, owner_id: "u2", co_owners: ["u3"] }];
  assert.equal(M.identifyRoster(rosters, "u1").roster_id, 1);
  assert.equal(M.identifyRoster(rosters, "u3").roster_id, 2);
  assert.throws(() => M.identifyRoster(rosters, "u9"), /Could not uniquely match this account to a roster in this league\./);
  assert.throws(() => M.identifyRoster(rosters.concat([{ roster_id: 3, owner_id: "u1" }]), "u1"), /Could not uniquely match/);
});
check("capacity, active skill players and needed drops", () => {
  const league = { roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "IR", "TAXI"] };
  assert.equal(M.capacityOf(league), 15);
  const catalog = { a: { position: "RB" }, b: { position: "K" }, c: { position: "WR" }, d: { position: "DEF" }, e: { position: "TE" } };
  assert.deepEqual(M.activeSkill({ players: ["a", "b", "c", "d", "e"], reserve: ["e"], taxi: [] }, catalog), ["a", "c"]);
  assert.equal(M.neededDrops({ activeCount: 15, giveCount: 1, receiveCount: 2, capacity: 15 }), 1);
  assert.equal(M.neededDrops({ activeCount: 14, giveCount: 1, receiveCount: 2, capacity: 15 }), 0);
  assert.equal(M.neededDrops({ activeCount: 15, giveCount: 2, receiveCount: 1, capacity: 15 }), 0);
});
check("fmtDelta uses a leading sign and a real minus", () => {
  assert.equal(M.fmtDelta(12.4), "+12.40"); assert.equal(M.fmtDelta(-3.1), "−3.10"); assert.equal(M.fmtDelta(0), "0.00");
});
const result = {
  weeks: [{ week: 3, sides: [{ rosterId: 1, before: { total: 100 }, after: { total: 106 }, delta: 6 }, { rosterId: 2, before: { total: 90 }, after: { total: 82 }, delta: -8 }] },
          { week: 4, sides: [{ rosterId: 1, before: { total: 100 }, after: { total: 106 }, delta: 6 }, { rosterId: 2, before: { total: 90 }, after: { total: 82 }, delta: -8 }] }],
  sides: [{ rosterId: 1, delta: 12 }, { rosterId: 2, delta: -16 }],
  warnings: ["All non-excluded active players are assumed available, including reported injuries; availability is not predicted."],
};
const ctx = { names: { 1: "Me", 2: "Them" }, currentWeek: 2, firstWeek: 3, endWeek: 17, picks: [{ label: "2027 R1 (Them)" }], excludeWeeks: { p9: [3, 4] }, playerNames: { p9: "A.J. Brown" }, drops: { 2: ["p7"] }, playerNamesAll: { p7: "Bench Guy" } };
check("scenarioText: headline, subline, sides and assumptions", () => {
  const t = M.scenarioText(result, ctx);
  assert.equal(t.headline, "Conditional lineup scenario — not a trade verdict.");
  assert.equal(t.subline, "Sum of weekly central (p50) lineup scenarios for weeks 3–17; week 2 is excluded because trades may process after games start. Keeper value and draft picks are not valued, so no overall grade is shown.");
  assert.deepEqual(t.sides, [{ name: "Me", before: "200.00", after: "212.00", delta: "+12.00" }, { name: "Them", before: "180.00", after: "164.00", delta: "−16.00" }]);
  assert.deepEqual(t.notValued, ["Not valued: picks — 2027 R1 (Them)"]);
  assert.deepEqual(t.assumptions, ["A.J. Brown assumed unavailable weeks 3, 4 (your assumption, not a return-date prediction)", "Them drops Bench Guy"]);
});
check("no forbidden word leaves the text builders outside the two allowed sentences", () => {
  const t = M.scenarioText(result, ctx);
  const c = M.coverageText(Object.assign(new Error("Projection coverage blocked: 1 players, 2 player-weeks."), { name: "ProjectionCoverageError", coverageIssues: [{ id: "x", name: "X", week: 3, reason: "unknown is not zero (no_observed_history)" }, { id: "x", name: "X", week: 4, reason: "unknown is not zero (no_observed_history)" }] }));
  const all = [t.subline, ...t.sides.flatMap(s => Object.values(s)), ...t.notValued, ...t.assumptions, c.headline, ...c.rows];
  const scrubbed = all.map(s => M.ALLOWED_SENTENCES.reduce((x, a) => x.split(a).join(""), s)).join("\n").toLowerCase();
  for (const w of M.FORBIDDEN) assert.ok(!scrubbed.includes(w), `forbidden word "${w}" in: ${scrubbed}`);
  assert.equal(c.headline, "Comparison blocked: 1 player(s), 2 player-week(s) without a projection");
  assert.deepEqual(c.rows, ["X · week 3 · unknown is not zero (no_observed_history)", "X · week 4 · unknown is not zero (no_observed_history)"]);
  const other = M.coverageText(new Error("Scoring mismatch"));
  assert.equal(other.headline, "Comparison blocked"); assert.deepEqual(other.rows, ["Scoring mismatch"]);
});
console.log(`seasontrademode_fixture: ${n} groups OK`);
```

- [ ] **Step 2: Run to verify failure** — `node tests/seasontrademode_fixture.cjs` → module not found.

- [ ] **Step 3: Create the module (helpers only; `init` is a stub that Task 4 fills)**

```js
/* In-season trade page controller. The pure helpers here are what the fixture
   tests; init() (Task 4) wires them to the DOM and to SeasonTrade.analyze. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SeasonTradeMode = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";
  const SKILL = new Set(["QB", "RB", "WR", "TE"]);
  const HEADLINE = "Conditional lineup scenario — not a trade verdict.";
  const SUBLINE_TAIL = "Keeper value and draft picks are not valued, so no overall grade is shown.";
  const FORBIDDEN = Object.freeze(["verdict", "win/win", "fair", "winner", "accept", "recommend", "grade"]);
  const ALLOWED_SENTENCES = Object.freeze([HEADLINE, SUBLINE_TAIL]);

  // "3-5, 8" -> [3,4,5,8]. Anything else is an error the user sees; an
  // unparseable exclusion must never silently mean "no exclusion".
  function parseWeeks(text, first, last) {
    const fail = () => { throw new Error(`weeks must look like 3-5, 8 and fall within ${first}–${last}`); };
    const out = new Set();
    for (const part of String(text || "").split(",").map(s => s.trim()).filter(Boolean)) {
      const m = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/.exec(part);
      if (!m) fail();
      let a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
      if (a > b) [a, b] = [b, a];
      if (a < first || b > last) fail();
      for (let w = a; w <= b; w++) out.add(w);
    }
    return [...out].sort((x, y) => x - y);
  }
  function identifyRoster(rosters, userId) {
    const mine = (rosters || []).filter(r => r.owner_id === userId || (r.co_owners || []).includes(userId));
    if (mine.length !== 1) throw new Error("Could not uniquely match this account to a roster in this league.");
    return mine[0];
  }
  const capacityOf = league => (league.roster_positions || []).filter(s => !["IR", "TAXI"].includes(String(s).toUpperCase())).length;
  function activeSkill(roster, catalog) {
    const locked = new Set([...(roster.reserve || []), ...(roster.taxi || [])].map(String));
    return (roster.players || []).map(String).filter(id => !locked.has(id) && SKILL.has((catalog[id] || {}).position));
  }
  const neededDrops = ({ activeCount, giveCount, receiveCount, capacity }) => Math.max(0, activeCount - giveCount + receiveCount - capacity);
  const fmtDelta = x => (x === 0 ? "0.00" : `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(2)}`);
  const fmt = x => Number(x).toFixed(2);

  function scenarioText(result, ctx) {
    const name = id => ctx.names[id] || `roster ${id}`;
    const pname = id => (ctx.playerNames && ctx.playerNames[id]) || (ctx.playerNamesAll && ctx.playerNamesAll[id]) || String(id);
    const sides = result.sides.map((s, i) => {
      const before = result.weeks.reduce((a, w) => a + w.sides[i].before.total, 0);
      const after = result.weeks.reduce((a, w) => a + w.sides[i].after.total, 0);
      return { name: name(s.rosterId), before: fmt(before), after: fmt(after), delta: fmtDelta(s.delta) };
    });
    const subline = `Sum of weekly central (p50) lineup scenarios for weeks ${ctx.firstWeek}–${ctx.endWeek}; week ${ctx.currentWeek} is excluded because trades may process after games start. ${SUBLINE_TAIL}`;
    const notValued = (ctx.picks || []).length ? [`Not valued: picks — ${ctx.picks.map(p => p.label).join(", ")}`] : [];
    const assumptions = [];
    for (const [id, weeks] of Object.entries(ctx.excludeWeeks || {})) if (weeks.length) assumptions.push(`${pname(id)} assumed unavailable weeks ${weeks.join(", ")} (your assumption, not a return-date prediction)`);
    for (const [rid, ids] of Object.entries(ctx.drops || {})) for (const id of ids) assumptions.push(`${name(rid)} drops ${pname(id)}`);
    return { headline: HEADLINE, subline, sides, notValued, assumptions };
  }
  function coverageText(error) {
    if (error && Array.isArray(error.coverageIssues)) {
      const players = new Set(error.coverageIssues.map(x => x.id)).size;
      return { headline: `Comparison blocked: ${players} player(s), ${error.coverageIssues.length} player-week(s) without a projection`,
               rows: error.coverageIssues.map(x => `${x.name} · week ${x.week} · ${x.reason}`) };
    }
    return { headline: "Comparison blocked", rows: [String(error && error.message || error)] };
  }

  function init() { throw new Error("SeasonTradeMode.init is wired in the next task"); }

  return Object.freeze({ parseWeeks, identifyRoster, capacityOf, activeSkill, neededDrops, fmtDelta, scenarioText, coverageText, FORBIDDEN, ALLOWED_SENTENCES, HEADLINE, init });
});
```

- [ ] **Step 4: Run** — `node tests/seasontrademode_fixture.cjs` → `seasontrademode_fixture: 6 groups OK`.

- [ ] **Step 5: Commit**

```bash
git add site/assets/seasontrademode.js tests/seasontrademode_fixture.cjs
git commit -m "feat: in-season trade page pure helpers (parseWeeks, roster identity, scenario text)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The in-season page — controller `init`, markup, bootstrap, copy

This task is specified in prose; it needs design judgment about DOM structure and error flow and goes to the most capable implementer.

**Files:**
- Modify: `site/assets/seasontrademode.js` (replace the `init` stub)
- Modify: `site/trade.html` (in-season section markup, script tags, bootstrap, footer/eyebrow/note copy)
- Modify: `site/assets/style.css` only if a new class is needed (reuse `.trade-cols`, `.trade-assets`, `.draft-row`, `.draft-note`, `.draft-shortlist-panel`, `.waiver-row-note` where possible)
- Modify: `tests/interface_hierarchy_fixture.cjs` / `tests/navigation_fixture.cjs` only if they assert trade.html structure that changes (read them first; keep them green)

**Interfaces:**
- Consumes: Task 3 helpers; `ROS.evaluationText`; `SeasonTrade.analyze` (spec §3); `Sleeper.get(path)` (cache-busting fetch); `FC.loadJSON`, `FC.leagueDataPath("remaining")`, `FC.leagueNavigation()`, `FC.stampHeader(board)`; `Trade.defaultPicks(rosterIds, seasons, rounds)` + `Trade.applyTradedPicks(owned, tradedPicks)` and `Keepers.DRAFT_ROUNDS` for the pick rows (both already loaded on trade.html).
- Produces: `SeasonTradeMode.init({ board, league, slug, els })` where `els` names every element listed below.

- [ ] **Step 1: Markup** — in `site/trade.html` add, after `#trade-suggestions`, a section `<section id="season-trade" hidden>` containing:
  - `<p class="eyebrow" id="season-eyebrow"></p>`, `<p class="draft-note" id="season-note"></p>` (the three-sentence intro from spec §4.6, static text).
  - Connect row: `<input id="season-user" aria-label="Sleeper username" placeholder="Sleeper username" autocomplete="off">`, `<button id="season-load">Load my league</button>`, `<span class="draft-status" id="season-status">— not loaded</span>`.
  - Controls row (hidden until loaded): `<label>Trade with <select id="season-partner"></select></label>`, `<label><input type="checkbox" id="season-ack"> All players not marked unavailable are assumed to play every remaining week.</label>`, `<button id="season-compare" disabled>Compare lineups</button>`.
  - `<p class="draft-note" id="season-warn" hidden></p>`.
  - Columns `<div class="trade-cols" id="season-cols" hidden>` with `<ul class="trade-assets" id="season-mine">` under "You give" and `#season-theirs` under "You get"; each column has a `<p class="trade-col-note" id="season-mine-drops">`/`#season-theirs-drops` for the drop prompt.
  - Output `<div class="draft-shortlist-panel" id="season-result" hidden>`.
  - Provenance `<p class="draft-note" id="season-provenance"></p>`.
  - The pre-draft footer text becomes: `Pre-draft: values players and draft picks before the draft. In season: conditional lineup scenarios only — no trade grades.`
  - Script tags after `trademode.js`: `<script src="assets/seasontrade.js?v=page1"></script>`, `<script src="assets/seasontrademode.js?v=page1"></script>` (Task 1 already added `ros.js?v=1` earlier in the list).

- [ ] **Step 2: Bootstrap** — rewrite the inline script per spec §4.1: load the board for the slug (`FC.leagueDataPath("draft")`), `FC.stampHeader(board)`, fetch `Sleeper.get(`/league/${board.league.league_id}`)`, then branch on `league.status`: `pre_draft` + gabagool → the existing `TradeMode.init(...)` block unchanged; `pre_draft` + fam → the existing "not available for this league yet" stamp; `in_season` → hide `#trade-connect`, `#trade-controls`, `#trade-cols`, `#trade-grade`, `#trade-suggestions`, the pre-draft `.eyebrow` and `.draft-note`, show `#season-trade`, call `SeasonTradeMode.init({ board, league, slug, els: {...} })`; any other status → stamp `Trade tools are available before the draft and during the regular season; this league is ${league.status}.` `espnfam` keeps today's early return.

- [ ] **Step 3: `init` behaviour** (spec §4.2–4.5), in this order:
  1. **Load** on `#season-load` click (and Enter in the username field): `/user/<name>` → `user_id` (status `user not found` if missing); in parallel `users`, `rosters`, `traded_picks` (catch → `picksUnknown = true`), `/state/nfl`, `FC.loadJSON(FC.leagueDataPath("remaining"))` (catch → null), and the catalog `/players/nfl` behind a module-level session cache with `catalogFetchedAt`. Pre-flight checks with the exact messages in spec §4.2; `identifyRoster`. Then fill the partner select (every other roster, team name from users' `metadata.team_name` / `display_name` / `Roster <id>` — same rule as `TradeMode.teamName`), draw both columns, show controls and columns, status `${rosters.length} teams loaded — you are ${myName}`.
  2. **Columns**: rows per spec §4.3. Active skill players: `<li><label><input type="checkbox" data-id> name · pos · team</label> <span class="waiver-row-note">reported tag: Out — no return-date inference</span> <input class="season-weeks" placeholder="unavailable weeks e.g. 3-5, 8" hidden></li>`; the weeks input is shown when the row is checked OR the catalog carries an `injury_status`. Reserve/taxi and K/DEF rows: disabled checkbox + note text from the spec. Picks: from `Trade.defaultPicks(rosterIds, [season+1, season+2], Keepers.DRAFT_ROUNDS)` + `applyTradedPicks` when available, filtered to the column's roster, label `${season} R${round}${original owner differs ? ` (via ${name})` : ""}`, note `not valued in season`; when `picksUnknown`, one disabled row `picks: unknown ownership (traded_picks unavailable)`.
  3. **Drops**: on any change, compute `neededDrops` per side (active count from `activeSkill` PLUS the side's non-skill active players, since K/DEF occupy roster spots too — capacity counts every non-IR/TAXI slot); when > 0, render `${team} must drop ${n} player(s) to fit this trade` plus checkboxes over that side's active players not in the trade (skill and K/DEF alike); the compare button is disabled until each side's drop count is satisfied, the acknowledgement is checked, at least one player is selected on either side, and every visible weeks field parses (parse on input; show the error text in the row's note and disable compare).
  4. **Compare**: re-fetch `rosters` and `/state/nfl` (`snapshotAt = Date.now()` immediately after); verify every selected/dropped id is still on the roster it was drawn from, else status `Rosters changed since they were loaded — reload the league.`; build `excludeWeeks` from the parsed fields (skill players only); call `SeasonTrade.analyze({ remaining, league, rosters, catalog, board, rosterIds: [me, partner], give, receive, drops, excludeWeeks, currentWeek: Number(state.week), assumeAvailable: true, now: Date.now(), snapshotAt })`. Render into `#season-result` in the spec's order using `scenarioText` and `coverageText`; on `ProjectionCoverageError` render the blocked panel; on any other error render `coverageText(error)`.
  5. **Output rendering** (spec §4.5): headline as `<strong>`; subline; a two-row table for the sides (`name · before · after · Δ`); the week table with columns `week | ${me} before/after/Δ | ${them} before/after/Δ`, marking a moved player's excluded/bye week with the status word from `weeks[i].sides[j].after.lineup[*].status` when that player is in the lineup rows; assumptions list; availability flags (`${name}: ${status} — ${interpretation}`); engine warnings verbatim; `ROS.evaluationText(remaining.evaluation)` as paragraphs; provenance line `Remaining-season projections generated ${remaining.generated_at}, data through ${remaining.data_through}. Roster snapshot ${new Date(snapshotAt).toISOString()}. Player catalog fetched ${catalogFetchedAt}.${league.settings?.trade_deadline ? ` Trade deadline: week ${league.settings.trade_deadline} (league setting).` : ""}`.
  6. **Invalidation**: changing partner, any checkbox, or a weeks field hides `#season-result` (a stale scenario must not sit under new inputs).
  7. Nothing in this controller calls `Trade.*` except `defaultPicks`/`applyTradedPicks`, and never `TradeMode.*`.

- [ ] **Step 4: Fixture updates** — run `node tests/interface_hierarchy_fixture.cjs`, `node tests/navigation_fixture.cjs`, `node tests/shared_assets_fixture.cjs`; if one asserts a structure this change alters (e.g. exactly one `.eyebrow` on trade.html), extend the expectation to the new section rather than weakening the check, and say so in the report. Add to `tests/seasontrademode_fixture.cjs` one check that `require`-ing the module in node does not touch `window` and that `init` is a function.

- [ ] **Step 5: Static smoke** — `node -e "new (require('jsdom').JSDOM)"` is NOT available; instead verify the HTML parses by running the existing hierarchy fixture (it loads trade.html) and by `grep -c 'id="season-'` returning ≥ 12. Run every fixture: `for f in tests/*_fixture.cjs; do node "$f" || exit 1; done`.

- [ ] **Step 6: Commit**

```bash
git add site/assets/seasontrademode.js site/trade.html site/assets/style.css tests/seasontrademode_fixture.cjs tests/interface_hierarchy_fixture.cjs tests/navigation_fixture.cjs
git commit -m "feat: in-season trade page — conditional lineup scenario, no verdict

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Docs and gate

**Files:**
- Modify: `docs/trade-scenarios.md` (retitle to cover the page; keep the CLI section)
- Modify: `docs/inseason-consensus.md` ("Remaining trade work")
- Modify: `docs/multi-league-tools.md` (trade row of the table at line 16, and lines 18–19)
- Modify: `docs/interface-release-checklist.md` (append)

- [ ] **Step 1: Edits**

`docs/trade-scenarios.md`: change the H1 to `# In-season trade scenarios` and insert as the new first section:

```markdown
## The page (2026-09-17)

`trade.html?league=gabagool` and `?league=fam` switch to an in-season branch when the
Sleeper league is `in_season`. Enter your username, pick a partner, tick the players
on each side, mark any weeks a player should be assumed unavailable (your assumption —
the page never fills one in from an injury tag), acknowledge that everyone else is
assumed to play, add explicit drops when a side would exceed roster capacity, and
press "Compare lineups". The result is both sides' week-by-week and remaining-season
starting-lineup change from the model's remaining-season projections, labeled
"Conditional lineup scenario — not a trade verdict." Picks in the offer are listed as
not valued; keeper value is not modeled; the current week is excluded because trades
may process after games start. No suggestions, no league scan, no grade: those are
gated behind the roster-level promotion test recorded in
`docs/superpowers/specs/2026-09-17-inseason-trade-scenario-design.md` §8. The pre-draft
calculator is unchanged and still refuses in-season leagues.
```

`docs/inseason-consensus.md` — replace the "Remaining trade work" section body's last paragraph (`Until those inputs and tests exist, …`) with:

```markdown
The page now ships the conditional scenario those requirements describe
(`trade-scenarios.md`, "The page"): remaining-week league-scored lineups for both
sides, explicit drops, unknown never zero, user-stated availability assumptions, keeper
and pick effects disclosed as excluded. It still does not produce a win/win verdict,
a grade, suggestions or a league scan; the promotion test that would unlock a
player-only grade is specified in
`docs/superpowers/specs/2026-09-17-inseason-trade-scenario-design.md` §8 and has not
been run.
```

`docs/multi-league-tools.md` line 16: `| Existing trade calculator | Pre-draft only | Not supported | Not supported |` → `| Trade calculator | Pre-draft grader; in-season conditional lineup scenario | In-season conditional lineup scenario | Not supported |`. Lines 18–19: replace `The trade calculator is not an in-season trade evaluator even for Gabagool.` with `In season the trade page shows a conditional lineup scenario, not a trade evaluation or grade.`

`docs/interface-release-checklist.md` — append:

```markdown
In-season trade scenario (September 17, Claude/astra consensus): trade.html
branches on live league status; in season it renders both sides' week-by-week
lineup change from the remaining-season payload with user-stated availability
exclusions, explicit drops, picks listed as not valued, and no grade, verdict,
suggestions or scan (spec `docs/superpowers/specs/2026-09-17-inseason-trade-scenario-design.md`).
Fixture-verified: shared solver parity (ros_fixture brute force, waivers 43
groups, seasontrade incl. 2-for-1 drops / scarce TE / bye+exclusion / duplicate
weeks), controller helpers incl. the forbidden-word scan. Pending for root: a
live browser round trip on Gabagool and FAM (load, exclude weeks, uneven trade
with drops, coverage-blocked case), and mobile layout of the new section.
```

- [ ] **Step 2: Gate** — `.venv/Scripts/python.exe -m pytest -q` (no Python changed; expect 841 passed) and `for f in tests/*_fixture.cjs; do node "$f" || exit 1; done` (expect 26 fixtures).

- [ ] **Step 3: Commit**

```bash
git add docs/trade-scenarios.md docs/inseason-consensus.md docs/multi-league-tools.md docs/interface-release-checklist.md
git commit -m "docs: in-season trade scenario page, consensus and remaining bar

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage:** §1 decisions → Tasks 3–5 copy and gates; §2 shared primitive → Task 1; §3 engine contract → Task 2 fixtures (no contract change); §4.1 bootstrap → Task 4 step 2; §4.2 loading/pre-flight → Task 4 step 3.1; §4.3 columns → 3.2; §4.4 drops → 3.3; §4.5 compare/output/forbidden words → Task 3 builders + Task 4 3.4–3.5 + fixture; §4.6 copy → Task 4 step 1; §5 pure pieces → Task 3; §6 fail-closed → engine (Task 2) + controller gating (Task 4) + trademode fixture untouched; §7 tests → Tasks 1–4; §8/§9 → Task 5 docs.
- **Placeholder scan:** none. Task 4 is prose by design (opus implementer) but every element id, message string and call is named.
- **Type consistency:** `ROS.bestLineup` returns `{total, starters:[{player,slot,points}], unfillable?}` in Task 1 and is adapted by `asLineup` in seasontrade.js to the engine's `{total, lineup}`; `scenarioText(result, ctx)` fields in Task 3 match the Task 4 renderer; `identifyRoster` message matches spec §4.2; `FC.leagueDataPath("remaining")` exists from the drop-cost branch.
