# Pre-Draft Trade Calculator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grade a proposed pre-draft trade (players + draft picks) in projected
starting-lineup points, and suggest trades worth offering.

**Architecture:** A trade is a different draft. Value a post-trade state by
simulating the rest of the draft from it (`Optimizer.finishRoster` →
`Optimizer.lineupPoints`) and comparing. Keepers are *derived* from the roster
on both sides, never traded. Entirely client-side over the published
`site/data/draft.json`.

**Tech Stack:** Vanilla JS, UMD modules (browser + node), `node`-run assertion
fixtures. No Python, no model change, no board regeneration.

Spec: `docs/superpowers/specs/2026-08-04-trade-calculator-design.md`

## Global Constraints

- **Two asset classes only: players and picks.** A keeper is never a tradeable
  asset. Keeper status is derived from roster + draft history on both sides.
- **Never read Sleeper's `keepers` field**, and never read Sleeper league
  settings for rules. League rules come from `Keepers.TEAMS` (12),
  `Keepers.DRAFT_ROUNDS` (15), `Keepers.MAX_KEEPERS` (2).
- **One currency: projected starting-lineup points.** Additive asset value
  exists only as a search heuristic and must never be displayed as a verdict.
- **A keeper-ineligible player (cost ≤ R2) is worth exactly 0 pre-draft** and
  the UI must say so, never show a bare zero.
- **Degrade loudly.** A player with no board row is listed `unvalued` and
  excluded from totals — never silently zero. A failed `traded_picks` fetch
  shows a banner; pick ownership is never guessed.
- `FUTURE_DISCOUNT = 0.8` per season ahead. `MIN_GAIN = 5` season points.
  `SUGGEST_PER_TEAM = 40`.
- Every Sleeper request goes through the shared cache-busting helper (Task 1).
- All new modules follow the existing UMD wrapper so `node tests/*.cjs` can
  require them.

## File Structure

| file | responsibility |
|---|---|
| `site/assets/sleeper.js` *(new)* | The one cache-busting Sleeper fetch. UMD. No other logic. |
| `site/assets/trade.js` *(new)* | All trade math: pick ownership, keeper derivation, state value, grading, suggester. Pure — no DOM, no network. |
| `site/assets/trademode.js` *(new)* | The panel: loads a league from Sleeper, renders assets, grades, suggests. DOM + network only. |
| `site/trade.html` *(new)* | Page shell + wiring, mirroring `index.html`'s inline-script pattern. |
| `site/assets/keepers.js` *(modify)* | `sapi` → shared helper. |
| `site/assets/draftmode.js` *(modify)* | private `api` → shared helper. |
| `site/index.html` *(modify)* | link to the trade page. |
| `site/assets/style.css` *(modify)* | trade panel styles. |
| `tests/sleeper_fixture.cjs` *(new)* | cache-busting assertions. |
| `tests/trade_fixture.cjs` *(new)* | all trade math assertions. |

**Deviation from spec §6, deliberate:** the spec put the shared fetch in
`app.js` as `FC.sleeper`. `app.js` is not UMD (it only assigns `window.FC`), so
`keepers.js` — which *is* required directly by its node fixture — could not
reach it without restructuring `app.js`. A dedicated single-responsibility
`sleeper.js` serves the spec's stated goal ("one implementation, one place to
fix") without that restructuring. Everything else in §6 is unchanged.

---

### Task 1: Shared cache-busting Sleeper fetch

Sleeper sends no `Cache-Control` and sits behind a CDN measured serving
6-hour-old copies of a live pick list. `draftmode.js` was fixed for this in
342310a; `keepers.js` still has the unprotected version, and the trade tool
must not add a third.

**Files:**
- Create: `site/assets/sleeper.js`
- Create: `tests/sleeper_fixture.cjs`
- Modify: `site/assets/keepers.js` (the `sapi` function, ~line 49)
- Modify: `site/assets/draftmode.js` (the `api` function, ~line 23)
- Modify: `site/index.html` (add the script tag before `keepers.js`)

**Interfaces:**
- Produces: `Sleeper.get(path) -> Promise<any>`, `Sleeper.API` (base URL string).
  Throws `Error("HTTP <status>")` on a non-ok response.

- [ ] **Step 1: Write the failing test**

Create `tests/sleeper_fixture.cjs`:

```js
// tests/sleeper_fixture.cjs — run with: node tests/sleeper_fixture.cjs
const assert = require("assert");
const S = require("../site/assets/sleeper.js");

const calls = [];
global.fetch = (url, opts) => {
  calls.push({ url, opts });
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) });
};

(async () => {
  await S.get("/league/123/rosters");
  await S.get("/league/123/rosters");
  // Sleeper's CDN keys on the full URL, so two reads of the SAME path must
  // produce two DIFFERENT urls or the second is served from a shared entry
  // measured at Age: 22072 -- six hours stale on a live draft.
  assert.notStrictEqual(calls[0].url, calls[1].url, "repeat reads must not share a URL");
  for (const c of calls) {
    assert.ok(/[?&]_=\d+/.test(c.url), `missing cache key: ${c.url}`);
    assert.strictEqual(c.opts.cache, "no-store", "must bypass the browser HTTP cache too");
    assert.ok(c.url.startsWith("https://api.sleeper.app/v1/"), c.url);
  }
  // A path that already carries a query keeps it, and appends with &.
  calls.length = 0;
  await S.get("/x?a=1");
  assert.ok(/\?a=1&_=\d+/.test(calls[0].url), calls[0].url);

  // A non-ok response throws with the status, so callers can distinguish a
  // 404 (offseason / no such league) from a real failure.
  global.fetch = () => Promise.resolve({ ok: false, status: 404 });
  await assert.rejects(() => S.get("/nope"), /HTTP 404/);

  console.log("sleeper_fixture: OK");
})().catch(e => { console.error("sleeper_fixture: FAILED"); console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node tests/sleeper_fixture.cjs`
Expected: FAIL — `Cannot find module '../site/assets/sleeper.js'`

- [ ] **Step 3: Write the module**

Create `site/assets/sleeper.js`:

```js
// site/assets/sleeper.js
/* The one Sleeper fetch. Read-only public API (api.sleeper.app), no auth.

   Sleeper sends NO Cache-Control on its live endpoints and sits behind a CDN.
   Measured against a real draft: two consecutive requests both returned
   Age: 22072 -- the same shared cache entry, six hours old -- while a
   cache-busted URL reached origin. On a live draft that is a board several
   picks behind reporting itself as current, and re-requesting the same URL
   (what pressing a refresh button does) hits the SAME entry, so it never
   recovers. The response also carries an ETag and no Cache-Control, so
   Chrome's own heuristic freshness applies on top of the CDN's.

   Both defences are required and they defeat different caches: the unique
   query key misses the CDN's shared entry, `no-store` keeps the browser's
   own HTTP cache out. Every caller goes through here so there is exactly one
   implementation to get right. */
(function (root, factory) {
  const S = factory();
  if (typeof window !== "undefined") window.Sleeper = S;
  if (typeof module !== "undefined" && module.exports) module.exports = S;
})(this, function () {
  const API = "https://api.sleeper.app/v1";

  async function get(path) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${API}${path}${sep}_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  return { get, API };
});
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `node tests/sleeper_fixture.cjs`
Expected: `sleeper_fixture: OK`

- [ ] **Step 5: Repoint `keepers.js`**

In `site/assets/keepers.js`, add the module resolution next to the existing
`Optimizer` one (which is the pattern to copy), directly below it:

```js
  const Sleeper = (typeof window !== "undefined" && window.Sleeper)
    ? window.Sleeper
    : (typeof require !== "undefined" ? require("./sleeper.js") : null);
  if (!Sleeper) throw new Error("keepers.js requires sleeper.js to be loaded first");
```

Then replace the whole `sapi` function:

```js
  async function sapi(path) {
    const res = await fetch(`${SLEEPER}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
```

with:

```js
  // Delegates so there is ONE cache-busting implementation (see sleeper.js).
  // This path was previously unprotected: the keeper panel could read a
  // six-hour-old roster and price keepers against players who had moved.
  const sapi = path => Sleeper.get(path);
```

Delete the now-unused `const SLEEPER = "https://api.sleeper.app/v1";` line.

- [ ] **Step 6: Repoint `draftmode.js`**

In `site/assets/draftmode.js`, add the same resolution block near the top of
the factory (draftmode.js is browser-only in practice but its fixture requires
it under a `global.window = {}` shim, so the same two-branch form is needed):

```js
  const Sleeper = (typeof window !== "undefined" && window.Sleeper)
    ? window.Sleeper
    : (typeof require !== "undefined" ? require("./sleeper.js") : null);
```

Replace the whole `api` function with:

```js
  // `fresh` is now the only mode -- see sleeper.js for why both defences are
  // required. The parameter is kept at the call sites' existing arity.
  const api = path => Sleeper.get(path);
```

Then remove the second argument at all four call sites (`api(..., true)` →
`api(...)`), and delete `const API = "https://api.sleeper.app/v1";`.

- [ ] **Step 7: Load it on the page**

In `site/index.html`, add before the `optimizer.js` tag:

```html
<script src="assets/sleeper.js"></script>
```

- [ ] **Step 8: Run every fixture**

Run: `for f in tests/*_fixture.cjs; do node "$f" || echo "FAILED: $f"; done`
Expected: all OK, including `draftmode_fixture` and `keepers_fixture`.

- [ ] **Step 9: Commit**

```bash
git add site/assets/sleeper.js site/assets/keepers.js site/assets/draftmode.js \
        site/index.html tests/sleeper_fixture.cjs
git commit -m "refactor: one cache-busting Sleeper fetch, and fix the keeper panel's"
```

---

### Task 2: Pick ownership

Who actually holds which pick, after trades. Verified live: the 2025 league
carried 25 traded picks, 9 of them for the 2026 season.

**Files:**
- Create: `site/assets/trade.js`
- Create: `tests/trade_fixture.cjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `Trade.defaultPicks(rosterIds, seasons, rounds) -> Map<rosterId, Array<{season, round}>>`
  - `Trade.applyTradedPicks(owned, tradedPicks) -> Map<rosterId, Array<{season, round}>>`
    where `tradedPicks` is Sleeper's shape `[{round, season, roster_id, owner_id}]`
    (`roster_id` = original owner, `owner_id` = current holder). `season` arrives
    as a STRING from Sleeper and is normalised to Number here.

- [ ] **Step 1: Write the failing test**

Create `tests/trade_fixture.cjs`:

```js
// tests/trade_fixture.cjs — run with: node tests/trade_fixture.cjs
const assert = require("assert");
const T = require("../site/assets/trade.js");

let n = 0;
const check = (label, fn) => { fn(); n++; };
const key = p => `${p.season}R${p.round}`;
const keys = list => list.map(key).sort().join(",");

check("every team starts with every round of every season", () => {
  const owned = T.defaultPicks([1, 2], [2026, 2027], 3);
  assert.strictEqual(owned.size, 2);
  assert.strictEqual(keys(owned.get(1)),
    "2026R1,2026R2,2026R3,2027R1,2027R2,2027R3");
});

check("a traded pick moves from its original owner to its holder", () => {
  const owned = T.defaultPicks([1, 2], [2026], 3);
  // Sleeper's shape: roster_id is who it ORIGINALLY belonged to, owner_id who
  // holds it now. season arrives as a string.
  T.applyTradedPicks(owned, [{ round: 2, season: "2026", roster_id: 1, owner_id: 2 }]);
  assert.strictEqual(keys(owned.get(1)), "2026R1,2026R3");
  assert.strictEqual(keys(owned.get(2)), "2026R1,2026R2,2026R2,2026R3",
    "team 2 now holds its own R2 AND team 1's");
});

check("a pick traded twice ends with the final holder only", () => {
  const owned = T.defaultPicks([1, 2, 3], [2026], 2);
  // Sleeper collapses a chain to ONE row per pick, carrying the final owner.
  T.applyTradedPicks(owned, [
    { round: 1, season: "2026", roster_id: 1, owner_id: 3, previous_owner_id: 2 },
  ]);
  assert.strictEqual(keys(owned.get(1)), "2026R2");
  assert.strictEqual(keys(owned.get(2)), "2026R1,2026R2");
  assert.strictEqual(keys(owned.get(3)), "2026R1,2026R1,2026R2");
});

check("a traded pick for an unknown season or roster is ignored, not crashed", () => {
  const owned = T.defaultPicks([1, 2], [2026], 2);
  T.applyTradedPicks(owned, [
    { round: 1, season: "2099", roster_id: 1, owner_id: 2 },   // season we don't model
    { round: 1, season: "2026", roster_id: 9, owner_id: 2 },   // roster not in the league
    { round: 9, season: "2026", roster_id: 1, owner_id: 2 },   // round beyond the draft
  ]);
  assert.strictEqual(keys(owned.get(1)), "2026R1,2026R2", "nothing should have moved");
});

console.log(`trade_fixture: ${n} groups OK`);
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node tests/trade_fixture.cjs`
Expected: FAIL — `Cannot find module '../site/assets/trade.js'`

- [ ] **Step 3: Write the module skeleton and the two functions**

Create `site/assets/trade.js`:

```js
// site/assets/trade.js
/* Pre-draft trade valuation. Pure math -- no DOM, no network -- so the node
   fixture can require it. Spec:
   docs/superpowers/specs/2026-08-04-trade-calculator-design.md

   THE MODEL. A trade is a different draft. A team's pre-draft state is the
   roster it holds and the picks it holds; its value is the best starting
   lineup it could still finish from there, which is exactly
   Optimizer.finishRoster -> Optimizer.lineupPoints. Everything else falls out.

   TWO ASSET CLASSES, PLAYERS AND PICKS. A keeper is NOT a tradeable thing.
   Pre-draft a player is just a player; keeper designation happens afterwards
   and whoever owns him then sets their own keepers. So keeper status is
   DERIVED from the roster on both sides of every trade, never moved as an
   asset. Two consequences the whole valuation turns on:
     - an acquired player COMPETES for a keeper slot, he does not add one;
     - a keeper-ineligible player (cost <= R2) is worth exactly ZERO pre-draft,
       because he returns to the draft pool for everybody. Last year's first-
       and second-round picks are therefore not tradeable assets at all.

   WHAT IS DELIBERATELY NOT HERE. No additive "trade value chart". Additive
   asset value prices a fifth running back at full freight when he cannot
   start; that defect has been removed from this codebase twice already (v1's
   VORP scoring, and waitCost before 48795d2). It survives here only as a
   search heuristic inside the suggester and never reaches a displayed
   verdict. */
(function (root, factory) {
  const T = factory();
  if (typeof window !== "undefined") window.Trade = T;
  if (typeof module !== "undefined" && module.exports) module.exports = T;
})(this, function () {

  // --- pick ownership --------------------------------------------------------

  // Every team starts holding every round of every modelled season; traded
  // picks then move them. Picks are plain {season, round} -- the overall pick
  // NUMBER is not known pre-draft (draft order is unset), so it is derived
  // only when a pick is valued, at its round's mid-slot.
  function defaultPicks(rosterIds, seasons, rounds) {
    const owned = new Map();
    for (const rid of rosterIds) {
      const list = [];
      for (const season of seasons) {
        for (let round = 1; round <= rounds; round++) list.push({ season, round });
      }
      owned.set(rid, list);
    }
    return owned;
  }

  // Sleeper's traded_picks: roster_id is the pick's ORIGINAL owner, owner_id
  // is who holds it now, and `season` is a STRING. Sleeper collapses a chain
  // of trades to one row per pick carrying the final owner, so this is a move,
  // never a replay. Mutates and returns `owned`.
  //
  // Rows we cannot place -- a season we do not model, a roster not in this
  // league, a round beyond the draft -- are IGNORED rather than crashing or
  // inventing a pick: they are real (Sleeper keeps picks for seasons past our
  // horizon) and dropping one costs nothing, while fabricating one would
  // silently hand a team an asset it does not own.
  function applyTradedPicks(owned, tradedPicks) {
    for (const t of tradedPicks || []) {
      const season = Number(t.season), round = Number(t.round);
      const from = owned.get(t.roster_id), to = owned.get(t.owner_id);
      if (!from || !to || !Number.isFinite(season) || !Number.isFinite(round)) continue;
      const i = from.findIndex(p => p.season === season && p.round === round);
      if (i === -1) continue;
      to.push(from.splice(i, 1)[0]);
    }
    return owned;
  }

  return { defaultPicks, applyTradedPicks };
});
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `node tests/trade_fixture.cjs`
Expected: `trade_fixture: 4 groups OK`

- [ ] **Step 5: Commit**

```bash
git add site/assets/trade.js tests/trade_fixture.cjs
git commit -m "feat: pick ownership from Sleeper's traded_picks"
```

---

### Task 3: Derived keepers and state value

The core. Everything downstream is a difference of two `stateValue` calls.

**Files:**
- Modify: `site/assets/trade.js`
- Modify: `tests/trade_fixture.cjs`

**Interfaces:**
- Consumes: `Trade.defaultPicks`, `Trade.applyTradedPicks` (Task 2).
- Produces:
  - `Trade.candidate(player, ctx) -> keeperCandidate` — maps a board player +
    draft history to the shape `Keepers.keeperCost`/`eligible` expect:
    `{name, position, vorp, adpRound, overallRank, originalRound, originalYear, isWaiver}`
  - `Trade.chooseKeepers(roster, ctx) -> Array<{player, cost}>`
  - `Trade.draftPool(ctx, ...states) -> Array<boardPlayer>`
  - `Trade.currentDraftValue(state, pool, ctx) -> Number`
- `ctx` shape, used by every function from here on:
  ```js
  { season, teams, rounds, board, maxKeepers, futureDiscount,
    originalByPlayerId,   // Map player_id -> {round, season} | undefined
    keptElsewhere }       // Set<player_id> kept by the 10 uninvolved teams
  ```
- A `state` is `{ roster: Array<boardPlayer>, picks: Array<{season, round}> }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/trade_fixture.cjs`, above the final `console.log`:

```js
// --- state value ------------------------------------------------------------
const O = require("../site/assets/optimizer.js");

// A board row the optimizer will accept. value_points is the absolute season
// projection the lineup objective reads; vorp is position-relative and only
// feeds the keeper selection.
let _id = 0;
const P = (name, position, value_points, extra = {}) =>
  Object.assign({ name, position, value_points, player_id: `p${++_id}`,
                  vorp: value_points, bye: null, adp: null, adp_round: null,
                  position_rank: 1, season_points: null }, extra);

// A realistic filler board: 240 players, all four positions interleaved, value
// descending 250 -> ~47. Both properties are load-bearing. DESCENDING because
// Optimizer.parVorp reads "the board row at this rank" and a shuffled board
// makes every keeper cost meaningless. REALISTIC SCALE because if the filler
// is far weaker than the test players, a draft pick buys nothing and the cost
// of keeping someone vanishes -- which would let a broken implementation pass.
const filler = [];
for (let i = 0; i < 240; i++) {
  filler.push(P(`${["QB", "RB", "WR", "TE"][i % 4]}f${i}`,
                ["QB", "RB", "WR", "TE"][i % 4], 250 - i * 0.85));
}

const CTX = (over = {}) => Object.assign({
  season: 2026, teams: 12, rounds: 15, maxKeepers: 2, futureDiscount: 0.8,
  board: filler, originalByPlayerId: new Map(), keptElsewhere: new Set(),
}, over);

// Drafted in `round` of `season` -> keeper cost decays one round per year.
const withHistory = (ctx, player, round, season = 2025) => {
  ctx.originalByPlayerId.set(player.player_id, { round, season });
  return player;
};
const state = (roster, picks) => ({ roster, picks });
const allPicks = (season = 2026, rounds = 15) =>
  Array.from({ length: rounds }, (_, i) => ({ season, round: i + 1 }));

check("an ineligible player is worth exactly zero pre-draft", () => {
  // Cost = originalRound - yearsKept. A round-1 pick from last season computes
  // to R0, so he returns to the draft pool for EVERYBODY and owning him first
  // buys nothing. This is the counterintuitive one: your best player is often
  // the one worth nothing to trade.
  const ctx = CTX();
  const star = withHistory(ctx, P("Star", "RB", 300), 1);
  ctx.board = filler.concat([star]);
  const picks = allPicks();
  const empty = state([], picks);
  const withStar = state([star], picks);
  const pool = T.draftPool(ctx, withStar);
  assert.strictEqual(T.chooseKeepers(withStar.roster, ctx).length, 0,
    "an R1 keeper cost is R0 -> ineligible");
  assert.ok(Math.abs(T.currentDraftValue(withStar, pool, ctx)
                   - T.currentDraftValue(empty, T.draftPool(ctx, empty), ctx)) < 1e-6,
    "holding an ineligible player must change nothing");
});

check("a cheap ladder outvalues a strictly better player", () => {
  // The inversion the whole pre-draft market misses. `good` is strictly the
  // better player but costs an early pick; `cheap` is worse and costs a late
  // one. The cheap ladder must win.
  const ctxA = CTX(), ctxB = CTX();
  const good = withHistory(ctxA, P("Good", "WR", 220), 4);    // cost R3
  const cheap = withHistory(ctxB, P("Cheap", "WR", 180), 12); // cost R11
  ctxA.board = filler.concat([good]);
  ctxB.board = filler.concat([cheap]);
  const a = state([good], allPicks()), b = state([cheap], allPicks());
  const va = T.currentDraftValue(a, T.draftPool(ctxA, a), ctxA);
  const vb = T.currentDraftValue(b, T.draftPool(ctxB, b), ctxB);
  assert.ok(vb > va,
    `cheap ladder ${vb.toFixed(1)} must beat better-but-expensive ${va.toFixed(1)}`);
});

check("an acquired player competes for a slot, he does not add one", () => {
  // Both keeper slots already hold better players, so a third star gains
  // ~nothing. A design treating him as an extra keeper would overvalue every
  // incoming star.
  const ctx = CTX();
  const k1 = withHistory(ctx, P("K1", "WR", 240), 10);
  const k2 = withHistory(ctx, P("K2", "RB", 235), 10);
  const third = withHistory(ctx, P("Third", "WR", 150), 10);
  ctx.board = filler.concat([k1, k2, third]);
  const before = state([k1, k2], allPicks());
  const after = state([k1, k2, third], allPicks());
  assert.strictEqual(T.chooseKeepers(after.roster, ctx).length, 2, "cap is 2");
  const gain = T.currentDraftValue(after, T.draftPool(ctx, after), ctx)
             - T.currentDraftValue(before, T.draftPool(ctx, before), ctx);
  assert.ok(Math.abs(gain) < 5,
    `a third keeper behind two better ones should gain ~0, got ${gain.toFixed(1)}`);
});

check("keeping a player spends the pick at his cost round", () => {
  const ctx = CTX();
  const k = withHistory(ctx, P("Keep", "RB", 200), 8);        // cost R7
  ctx.board = filler.concat([k]);
  const s = state([k], allPicks());
  const kept = T.chooseKeepers(s.roster, ctx);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].cost, 7, "8 drafted in 2025 -> R7 in 2026");
});

check("the draft pool excludes every kept player", () => {
  const ctx = CTX();
  const mine = withHistory(ctx, P("Mine", "RB", 200), 8);
  const theirs = withHistory(ctx, P("Theirs", "WR", 200), 8);
  ctx.board = filler.concat([mine, theirs]);
  const pool = T.draftPool(ctx, state([mine], []), state([theirs], []));
  const ids = new Set(pool.map(p => p.player_id));
  assert.ok(!ids.has(mine.player_id) && !ids.has(theirs.player_id),
    "a kept player is off the board for everyone");
});

check("a player with no draft history is on the waiver ladder", () => {
  // Never drafted in this league -> R12 the first year he's kept.
  const ctx = CTX();
  const w = P("Waiver", "TE", 200);
  ctx.board = filler.concat([w]);
  const kept = T.chooseKeepers([w], ctx);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].cost, 12);
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node tests/trade_fixture.cjs`
Expected: FAIL — `TypeError: T.draftPool is not a function`

- [ ] **Step 3: Implement**

In `site/assets/trade.js`, add the module resolution immediately after the
`})(this, function () {` line:

```js
  const Optimizer = (typeof window !== "undefined" && window.Optimizer)
    ? window.Optimizer
    : (typeof require !== "undefined" ? require("./optimizer.js") : null);
  const Keepers = (typeof window !== "undefined" && window.Keepers)
    ? window.Keepers
    : (typeof require !== "undefined" ? require("./keepers.js") : null);
  if (!Optimizer || !Keepers) {
    throw new Error("trade.js requires optimizer.js and keepers.js to be loaded first");
  }
```

Add before the final `return {...}`:

```js
  // --- derived keepers -------------------------------------------------------

  // A board player + his league draft history, in the shape Keepers'
  // cost/eligibility functions expect. No draft row in the chain means he was
  // never drafted here, which is the waiver ladder (R12 on the first keep).
  function candidate(player, ctx) {
    const orig = ctx.originalByPlayerId.get(player.player_id);
    const c = { name: player.name, position: player.position,
                vorp: player.vorp, adpRound: player.adp_round,
                overallRank: player.position_rank, player };
    if (orig) {
      c.originalRound = orig.round;
      c.originalYear = orig.season;
      c.isWaiver = false;
    } else {
      c.isWaiver = true;
    }
    return c;
  }

  // Which players a team would actually keep. DERIVED on both sides of every
  // trade -- never an input, because pre-draft the keeper tag is moot and a
  // manager may even designate one BECAUSE they intend to shop him.
  //
  // Selection reuses Keepers.recommendKeepers so the trade tool and the keeper
  // panel agree on WHO to keep. (They still differ on what a keeper is WORTH:
  // keepers.js scores `slotWeight * vorp - parVorp`, this file scores lineup
  // points. Unifying them is a recorded follow-up, deliberately not done here
  // -- see the spec's section 10.)
  function chooseKeepers(roster, ctx) {
    const cands = (roster || []).map(p => candidate(p, ctx))
      .filter(c => Number.isFinite(c.vorp));
    const rec = Keepers.recommendKeepers(cands, ctx.season, ctx.board,
      { teams: ctx.teams, maxKeepers: ctx.maxKeepers });
    return rec.map(r => ({ player: r.player, cost: r.cost }));
  }

  // --- state value -----------------------------------------------------------

  // The board minus every keeper anyone has chosen. Players on a roster who
  // are NOT kept go back into the draft, which is why this takes the states
  // rather than the rosters.
  function draftPool(ctx, ...states) {
    const gone = new Set(ctx.keptElsewhere);
    for (const s of states) {
      for (const k of chooseKeepers(s.roster, ctx)) gone.add(k.player.player_id);
    }
    return ctx.board.filter(p => !gone.has(p.player_id));
  }

  // The best starting lineup this state could still finish, from THIS year's
  // picks. Keepers occupy their cost rounds, so those picks are spent.
  //
  // Draft order is unset pre-draft, so each pick is valued at its round's
  // MID-slot (Keepers.pickForRound) -- pretending to know the exact overall
  // pick would be false precision. fromPick is 0: nothing has been drafted.
  function currentDraftValue(state, pool, ctx) {
    const kept = chooseKeepers(state.roster, ctx);
    const spent = new Set(kept.map(k => k.cost));
    const picks = (state.picks || [])
      .filter(p => p.season === ctx.season && !spent.has(p.round))
      .map(p => Keepers.pickForRound(p.round, ctx.teams))
      .sort((a, b) => a - b);
    return Optimizer.lineupPoints(
      Optimizer.finishRoster(kept.map(k => k.player), pool, picks, 0));
  }
```

Update the export line to:

```js
  return { defaultPicks, applyTradedPicks, candidate, chooseKeepers,
           draftPool, currentDraftValue };
```

- [ ] **Step 4: Run to confirm it passes**

Run: `node tests/trade_fixture.cjs`
Expected: `trade_fixture: 10 groups OK`

- [ ] **Step 5: Commit**

```bash
git add site/assets/trade.js tests/trade_fixture.cjs
git commit -m "feat: derive keepers and value a pre-draft state as a finishable lineup"
```

---

### Task 4: Future picks, market value, and grading a trade

**Files:**
- Modify: `site/assets/trade.js`
- Modify: `tests/trade_fixture.cjs`

**Interfaces:**
- Consumes: `Trade.draftPool`, `Trade.currentDraftValue` (Task 3).
- Produces:
  - `Trade.futurePicksValue(state, pool, ctx) -> Number`
  - `Trade.stateValue(state, pool, ctx) -> Number`
  - `Trade.marketValue(asset, ctx) -> Number` where an asset is either a board
    player or `{season, round}`
  - `Trade.gradeTrade({me, them}, {toMe, toThem}, ctx) -> {myGain, theirGain, marketDelta, myAfter, themAfter}`
    `toMe`/`toThem` are `{players: Array<boardPlayer>, picks: Array<{season, round}>}`

- [ ] **Step 1: Write the failing tests**

Append to `tests/trade_fixture.cjs`, above the final `console.log`:

```js
// --- future picks, market value, grading ------------------------------------

check("the future discount compounds per season and is a no-op at zero", () => {
  const ctx = CTX();
  ctx.board = filler;
  const base = state([], allPicks());
  const pool = T.draftPool(ctx, base);
  const now = T.futurePicksValue(state([], [{ season: 2026, round: 3 }]), pool, ctx);
  assert.strictEqual(now, 0, "a CURRENT-year pick is not a future pick");
  const one = T.futurePicksValue(state([], [{ season: 2027, round: 3 }]), pool, ctx);
  const two = T.futurePicksValue(state([], [{ season: 2028, round: 3 }]), pool, ctx);
  assert.ok(one > 0, "a future 3rd must be worth something");
  assert.ok(Math.abs(two - one * ctx.futureDiscount) < 1e-6,
    `0.8 per season: expected ${(one * 0.8).toFixed(3)}, got ${two.toFixed(3)}`);
});

check("a pick past the rollout horizon grades ~0 on lineup but >0 on market", () => {
  // Documented and intended (spec section 3.3): a 15th-rounder will not change
  // a starting lineup, and saying so is the honest answer. The gap against its
  // market value is itself the tradeable signal.
  const ctx = CTX();
  ctx.board = filler;
  const base = state([], allPicks());
  const pool = T.draftPool(ctx, base);
  const late = T.futurePicksValue(state([], [{ season: 2027, round: 15 }]), pool, ctx);
  assert.ok(late < 1, `a future R15 should be ~0 on lineup, got ${late.toFixed(2)}`);
  assert.ok(T.marketValue({ season: 2027, round: 15 }, ctx) >= 0);
});

check("market value uses ADP when present and the board rank when not", () => {
  const ctx = CTX();
  ctx.board = filler;
  const withAdp = P("HasAdp", "WR", 100, { adp: 12, adp_round: 1 });
  const noAdp = P("NoAdp", "WR", 100);
  assert.ok(T.marketValue(withAdp, ctx) > 0);
  assert.ok(T.marketValue(noAdp, ctx) >= 0, "no ADP must not produce NaN");
  assert.ok(Number.isFinite(T.marketValue({ season: 2026, round: 5 }, ctx)));
});

check("a straight swap of equals grades near zero for both sides", () => {
  const ctx = CTX();
  const a = withHistory(ctx, P("A", "WR", 200), 10);
  const b = withHistory(ctx, P("B", "WR", 200), 10);
  ctx.board = filler.concat([a, b]);
  const me = state([a], allPicks()), them = state([b], allPicks());
  const g = T.gradeTrade({ me, them },
    { toMe: { players: [b], picks: [] }, toThem: { players: [a], picks: [] } }, ctx);
  assert.ok(Math.abs(g.myGain) < 5, `expected ~0, got ${g.myGain.toFixed(1)}`);
  assert.ok(Math.abs(g.theirGain) < 5, `expected ~0, got ${g.theirGain.toFixed(1)}`);
});

check("THE PREMISE: trading up the keeper ladder is what pays", () => {
  // Pre-draft a roster is at most two keepers and finishRoster drafts all the
  // rest, so ROSTER SHAPE is worth ~0.8 points and the LADDER is worth ~51.
  // (An earlier draft of this plan asserted the shape version. Measured
  //  against the shipped optimizer it moved 0.8 points -- it would have pinned
  //  nothing. See the spec's section 4.1(2).)
  //
  // Same player on both sides. All that differs is what keeping him costs.
  const ctx = CTX();
  const dear = withHistory(ctx, P("Dear", "RB", 200), 4);    // cost R3
  const cheapGuy = withHistory(ctx, P("Cheap", "RB", 200), 12);   // cost R11
  ctx.board = filler.concat([dear, cheapGuy]);
  const a = state([dear], allPicks()), b = state([cheapGuy], allPicks());
  const va = T.currentDraftValue(a, T.draftPool(ctx, a), ctx);
  const vb = T.currentDraftValue(b, T.draftPool(ctx, b), ctx);
  assert.ok(vb - va > 25,
    `the cheap ladder must pay a large, obvious premium; got ${(vb - va).toFixed(1)}`);
});

check("roster shape barely moves a PRE-DRAFT state, and that is correct", () => {
  // Pinned so nobody 'fixes' it later by reintroducing an additive shape term:
  // with two keepers there is almost no shape to have.
  const ctx = CTX();
  const rb1 = withHistory(ctx, P("RB1", "RB", 220), 10);
  const rb2 = withHistory(ctx, P("RB2", "RB", 218), 10);
  const wr1 = withHistory(ctx, P("WR1", "WR", 218), 10);
  ctx.board = filler.concat([rb1, rb2, wr1]);
  const twoRb = state([rb1, rb2], allPicks());
  const mixed = state([rb1, wr1], allPicks());
  const d = Math.abs(T.currentDraftValue(mixed, T.draftPool(ctx, mixed), ctx)
                   - T.currentDraftValue(twoRb, T.draftPool(ctx, twoRb), ctx));
  assert.ok(d < T.MIN_GAIN,
    `pre-draft shape must sit inside the noise floor; got ${d.toFixed(1)}`);
});

check("marketDelta is positive when they receive more market value", () => {
  const ctx = CTX();
  const mine = P("Mine", "WR", 200, { adp: 10, adp_round: 1 });
  const theirs = P("Theirs", "WR", 100, { adp: 120, adp_round: 10 });
  ctx.board = filler.concat([mine, theirs]);
  const d = T.marketDelta({ players: [mine], picks: [] },
                          { players: [theirs], picks: [] }, ctx);
  assert.ok(d > 0, "giving up the earlier-ADP player looks generous to them");
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node tests/trade_fixture.cjs`
Expected: FAIL — `TypeError: T.futurePicksValue is not a function`

- [ ] **Step 3: Implement**

Add to `site/assets/trade.js` before the export:

```js
  // --- future picks ----------------------------------------------------------

  // A 2027 pick has no slot in THIS draft, so finishRoster cannot place it. It
  // is valued in the same currency by asking what the equivalent current-year
  // pick would add, then discounting per season ahead.
  //
  // Picks are valued MARGINALLY and summed, which slightly overstates a large
  // haul (each is measured against the state without any of them, so
  // diminishing returns are not compounded). With the handful of picks a real
  // trade moves the error is small, and the alternative -- inserting them all
  // and re-solving -- would hide which pick contributed what.
  function futurePicksValue(state, pool, ctx) {
    const future = (state.picks || []).filter(p => p.season > ctx.season);
    if (!future.length) return 0;
    const base = currentDraftValue(state, pool, ctx);
    let total = 0;
    for (const p of future) {
      const asCurrent = Object.assign({}, state, {
        picks: (state.picks || []).concat([{ season: ctx.season, round: p.round }]),
      });
      const marginal = currentDraftValue(asCurrent, pool, ctx) - base;
      total += Math.max(0, marginal) * Math.pow(ctx.futureDiscount, p.season - ctx.season);
    }
    return total;
  }

  function stateValue(state, pool, ctx) {
    return currentDraftValue(state, pool, ctx) + futurePicksValue(state, pool, ctx);
  }

  // --- market value: what the OTHER manager sees -----------------------------

  // Used ONLY for the acceptability filter, never as a verdict. The
  // counterparty will judge an offer on the market's numbers, not ours, and
  // the edge lives in that gap.
  //
  // A player with no ADP falls back to his board rank. 460 of 695 players on
  // the live board have no ADP, so the fallback is the common case and the UI
  // must LABEL which one it used -- a model opinion reading as a market fact
  // is the bug Keepers.valueLabel was added to fix.
  function marketValue(asset, ctx) {
    if (asset && asset.season && asset.round) {
      const v = Optimizer.parVorp(ctx.board, Keepers.pickForRound(asset.round, ctx.teams));
      return v * Math.pow(ctx.futureDiscount, Math.max(0, asset.season - ctx.season));
    }
    const round = asset.adp_round != null
      ? asset.adp_round
      : Math.ceil((asset.position_rank || ctx.rounds * ctx.teams) / ctx.teams);
    return Optimizer.parVorp(ctx.board, Keepers.pickForRound(round, ctx.teams));
  }

  const sideMarket = (side, ctx) =>
    (side.players || []).reduce((n, p) => n + marketValue(p, ctx), 0)
    + (side.picks || []).reduce((n, p) => n + marketValue(p, ctx), 0);

  // Positive = they receive more market value than they give, i.e. the offer
  // looks fair-or-better on the numbers they will actually use.
  function marketDelta(toThem, toMe, ctx) {
    return sideMarket(toThem, ctx) - sideMarket(toMe, ctx);
  }

  // --- grading ---------------------------------------------------------------

  const without = (list, gone) => {
    const ids = new Set(gone.map(p => p.player_id));
    return list.filter(p => !ids.has(p.player_id));
  };
  const withoutPicks = (list, gone) => {
    const keys = new Set(gone.map(p => `${p.season}R${p.round}`));
    const out = [];
    for (const p of list) {
      const k = `${p.season}R${p.round}`;
      if (keys.has(k)) { keys.delete(k); continue; }   // remove ONE per matching key
      out.push(p);
    }
    return out;
  };

  function applyTrade(me, them, toMe, toThem) {
    return {
      me: { roster: without(me.roster, toThem.players || []).concat(toMe.players || []),
            picks: withoutPicks(me.picks, toThem.picks || []).concat(toMe.picks || []) },
      them: { roster: without(them.roster, toMe.players || []).concat(toThem.players || []),
              picks: withoutPicks(them.picks, toMe.picks || []).concat(toThem.picks || []) },
    };
  }

  // The three numbers of the spec's section 4, all displayed together:
  // myGain/theirGain in OUR currency (projected lineup points), marketDelta in
  // THEIRS. A trade is worth offering when myGain is real AND marketDelta >= 0.
  function gradeTrade(before, moves, ctx) {
    const after = applyTrade(before.me, before.them, moves.toMe, moves.toThem);
    const poolB = draftPool(ctx, before.me, before.them);
    const poolA = draftPool(ctx, after.me, after.them);
    return {
      myGain: stateValue(after.me, poolA, ctx) - stateValue(before.me, poolB, ctx),
      theirGain: stateValue(after.them, poolA, ctx) - stateValue(before.them, poolB, ctx),
      marketDelta: marketDelta(moves.toThem, moves.toMe, ctx),
      myAfter: after.me, themAfter: after.them,
    };
  }
```

Update the export to:

```js
  return { defaultPicks, applyTradedPicks, candidate, chooseKeepers,
           draftPool, currentDraftValue, futurePicksValue, stateValue,
           marketValue, marketDelta, applyTrade, gradeTrade };
```

- [ ] **Step 4: Run to confirm it passes**

Run: `node tests/trade_fixture.cjs`
Expected: `trade_fixture: 17 groups OK`

- [ ] **Step 5: Commit**

```bash
git add site/assets/trade.js tests/trade_fixture.cjs
git commit -m "feat: grade a trade in lineup points, with the market's view beside it"
```

---

### Task 5: The suggester

**Files:**
- Modify: `site/assets/trade.js`
- Modify: `tests/trade_fixture.cjs`

**Interfaces:**
- Consumes: `Trade.gradeTrade`, `Trade.stateValue`, `Trade.draftPool` (Task 4).
- Produces:
  - `Trade.offerable(state, other, ctx) -> {mine: Array<asset>, theirs: Array<asset>}`
  - `Trade.suggestTrades(me, others, ctx, opts) -> Array<suggestion>` where a
    suggestion is `{teamId, toMe, toThem, myGain, theirGain, marketDelta}`
    sorted by `myGain` descending. `others` is `Array<{teamId, state}>`.
  - Constants `Trade.MIN_GAIN` (5), `Trade.SUGGEST_PER_TEAM` (40),
    `Trade.FUTURE_DISCOUNT` (0.8).

- [ ] **Step 1: Write the failing tests**

Append to `tests/trade_fixture.cjs`, above the final `console.log`:

```js
// --- the suggester ----------------------------------------------------------

check("never proposes a trade that lowers my own lineup", () => {
  const ctx = CTX();
  const mine = [1, 2, 3].map(i => withHistory(ctx, P(`M${i}`, "RB", 200 - i), 10));
  const theirs = [1, 2].map(i => withHistory(ctx, P(`T${i}`, "WR", 200 - i), 10));
  ctx.board = filler.concat(mine).concat(theirs);
  const me = state(mine, allPicks());
  const out = T.suggestTrades(me, [{ teamId: 2, state: state(theirs, allPicks()) }], ctx);
  for (const s of out) {
    assert.ok(s.myGain > 0, `suggested a losing trade: ${s.myGain}`);
    assert.ok(s.myGain >= T.MIN_GAIN, `below the noise floor: ${s.myGain}`);
  }
});

check("only offers players I do not need, and asks for ones I do", () => {
  const ctx = CTX();
  // Four RBs (surplus) and no WR at all -- the RB4 is offerable, the RB1 is not.
  const rbs = [1, 2, 3, 4].map(i => withHistory(ctx, P(`RB${i}`, "RB", 210 - i * 2), 10));
  const theirWr = withHistory(ctx, P("WR1", "WR", 208), 10);
  ctx.board = filler.concat(rbs).concat([theirWr]);
  const me = state(rbs, allPicks()), them = state([theirWr], allPicks());
  const { mine, theirs } = T.offerable(me, them, ctx);
  const names = a => a.filter(x => x.name).map(x => x.name);
  assert.ok(names(mine).includes("RB4"), "my surplus RB must be offerable");
  assert.ok(!names(mine).includes("RB1"), "my best RB is not surplus");
  assert.ok(names(theirs).includes("WR1"), "the WR I need must be sought");
});

check("suggestions are ranked by my gain and carry all three numbers", () => {
  const ctx = CTX();
  const rbs = [1, 2, 3, 4].map(i => withHistory(ctx, P(`RB${i}`, "RB", 210 - i * 2), 10));
  const theirs = [
    withHistory(ctx, P("BigWR", "WR", 240), 10),
    withHistory(ctx, P("SmallWR", "WR", 150), 10),
  ];
  ctx.board = filler.concat(rbs).concat(theirs);
  const out = T.suggestTrades(state(rbs, allPicks()),
    [{ teamId: 7, state: state(theirs, allPicks()) }], ctx);
  assert.ok(out.length > 0, "an obvious shape mismatch must produce a suggestion");
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].myGain >= out[i].myGain, "must be sorted by my gain");
  }
  for (const s of out) {
    for (const k of ["teamId", "toMe", "toThem", "myGain", "theirGain", "marketDelta"]) {
      assert.ok(k in s, `suggestion missing ${k}`);
    }
  }
});

check("an ineligible player is never suggested as an asset", () => {
  // He returns to the draft pool for everybody, so trading for him is worth 0.
  const ctx = CTX();
  const star = withHistory(ctx, P("R1Star", "WR", 300), 1);   // cost R0 -> ineligible
  const mineRb = withHistory(ctx, P("MyRB", "RB", 200), 10);
  ctx.board = filler.concat([star, mineRb]);
  const out = T.suggestTrades(state([mineRb], allPicks()),
    [{ teamId: 3, state: state([star], allPicks()) }], ctx);
  for (const s of out) {
    assert.ok(!(s.toMe.players || []).some(p => p.name === "R1Star"),
      "an ineligible player has no pre-draft value and must not be sought");
  }
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node tests/trade_fixture.cjs`
Expected: FAIL — `TypeError: T.suggestTrades is not a function`

- [ ] **Step 3: Implement**

Add to `site/assets/trade.js` before the export:

```js
  // --- the suggester ---------------------------------------------------------

  // Below this the objective cannot tell a trade from projection noise: 5
  // season points is ~0.3 a week, well inside the model's own ~4.3/week MAE.
  // Same reasoning as Keepers.MARGINAL_POINTS, and deliberately NOT tuned.
  const MIN_GAIN = 5;
  const SUGGEST_PER_TEAM = 40;   // scored honestly per opponent, after prefilter
  const FUTURE_DISCOUNT = 0.8;
  const MAX_PER_SIDE = 2;        // 1-for-1, 2-for-1, 1-for-2, 2-for-2

  // What each side should even consider moving. Mine: players I can lose for
  // less than MIN_GAIN (surplus), plus my picks. Theirs: players who would
  // gain me at least MIN_GAIN, plus their picks. A player I need is not an
  // asset I am shopping, and a player who does not help me is not one I want.
  //
  // An INELIGIBLE player is excluded from both sides: his keeper cost is R2 or
  // lower so he returns to the draft pool for everybody, and acquiring him
  // pre-draft buys literally nothing.
  function offerable(me, them, ctx) {
    const poolMe = draftPool(ctx, me, them);
    const base = stateValue(me, poolMe, ctx);
    const keepable = p => {
      const c = candidate(p, ctx);
      return Number.isFinite(c.vorp) && Keepers.eligible(c, ctx.season);
    };
    const mine = (me.roster || []).filter(keepable).filter(p => {
      const s = { roster: without(me.roster, [p]), picks: me.picks };
      return base - stateValue(s, draftPool(ctx, s, them), ctx) < MIN_GAIN;
    });
    const theirs = (them.roster || []).filter(keepable).filter(p => {
      const s = { roster: (me.roster || []).concat([p]), picks: me.picks };
      return stateValue(s, draftPool(ctx, s, them), ctx) - base >= MIN_GAIN;
    });
    return { mine: mine.concat(me.picks || []),
             theirs: theirs.concat(them.picks || []) };
  }

  const packages = (assets, max) => {
    const out = assets.map(a => [a]);
    if (max >= 2) {
      for (let i = 0; i < assets.length; i++) {
        for (let j = i + 1; j < assets.length; j++) out.push([assets[i], assets[j]]);
      }
    }
    return out;
  };
  const split = list => ({
    players: list.filter(a => a.player_id !== undefined),
    picks: list.filter(a => a.player_id === undefined),
  });

  // Two-team trades only. The additive prefilter is a SEARCH heuristic and its
  // numbers are never shown: it exists so the honest lineup objective only has
  // to run on plausible packages, the same topCandidates -> finishRoster
  // pattern the draft optimizer uses.
  function suggestTrades(me, others, ctx, opts = {}) {
    const minGain = opts.minGain != null ? opts.minGain : MIN_GAIN;
    const perTeam = opts.perTeam != null ? opts.perTeam : SUGGEST_PER_TEAM;
    const out = [];
    for (const other of others) {
      const them = other.state;
      const { mine, theirs } = offerable(me, them, ctx);
      if (!mine.length || !theirs.length) continue;
      const cands = [];
      for (const give of packages(mine, MAX_PER_SIDE)) {
        for (const get of packages(theirs, MAX_PER_SIDE)) {
          const toThem = split(give), toMe = split(get);
          // Prefilter: keep packages that look fair-or-generous to them, since
          // anything else will simply be declined.
          const md = marketDelta(toThem, toMe, ctx);
          if (md < 0) continue;
          cands.push({ toMe, toThem, md });
        }
      }
      cands.sort((a, b) => a.md - b.md);        // least overpay first
      for (const c of cands.slice(0, perTeam)) {
        const g = gradeTrade({ me, them }, { toMe: c.toMe, toThem: c.toThem }, ctx);
        if (g.myGain < minGain || g.marketDelta < 0) continue;
        out.push({ teamId: other.teamId, toMe: c.toMe, toThem: c.toThem,
                   myGain: g.myGain, theirGain: g.theirGain,
                   marketDelta: g.marketDelta });
      }
    }
    out.sort((a, b) => b.myGain - a.myGain);
    return out;
  }
```

Update the export to:

```js
  return { defaultPicks, applyTradedPicks, candidate, chooseKeepers,
           draftPool, currentDraftValue, futurePicksValue, stateValue,
           marketValue, marketDelta, applyTrade, gradeTrade,
           offerable, suggestTrades,
           MIN_GAIN, SUGGEST_PER_TEAM, FUTURE_DISCOUNT, MAX_PER_SIDE };
```

- [ ] **Step 4: Run to confirm it passes**

Run: `node tests/trade_fixture.cjs`
Expected: `trade_fixture: 21 groups OK`

- [ ] **Step 5: Commit**

```bash
git add site/assets/trade.js tests/trade_fixture.cjs
git commit -m "feat: suggest trades that gain me points and look fair to them"
```

---

### Task 6: The page

**Files:**
- Create: `site/assets/trademode.js`
- Create: `site/trade.html`
- Modify: `site/assets/style.css`
- Modify: `site/index.html` (nav link)

**Interfaces:**
- Consumes: everything from `Trade` (Tasks 2–5), `Sleeper.get` (Task 1),
  `Keepers.buildOriginalByPlayerId`, `Optimizer.withValuePoints`, `FC.esc`.
- Produces: `TradeMode.init({board, els})`, plus the pure helper
  `TradeMode.leagueWorld(league, board) -> Promise<{teams, ctx}>` used by tests.

- [ ] **Step 1: Build the page shell**

Create `site/trade.html` by copying `site/index.html`'s `<head>` block verbatim
(same `<link rel="icon">`, same stylesheet link, same fonts), then this body:

```html
<body>
<header>
  <a class="home" href="index.html">← draft board</a>
  <p class="stamp">loading…</p>
</header>
<main>
  <p class="eyebrow">2026 pre-draft · players and picks</p>
  <h1>Trade calculator</h1>
  <p class="draft-note">Every number is season points in your best STARTING
  LINEUP, measured by playing the rest of your draft out from the post-trade
  roster. Keepers are worked out for both sides — a player you acquire competes
  for one of your two slots, he does not add one. A player whose keeper cost
  would be round 2 or lower goes back in the draft pool for everybody, so he is
  worth nothing to trade before the draft, however good he is.</p>
  <div class="draft-row" id="trade-connect">
    <input id="trade-user" type="text" placeholder="Sleeper username" autocomplete="off">
    <button id="trade-load">Load my league</button>
    <span class="draft-status" id="trade-status">— not loaded</span>
  </div>
  <div class="draft-row" id="trade-league-picker"></div>
  <div class="draft-row" id="trade-controls" hidden>
    <label>Trade with <select id="trade-partner"></select></label>
    <label>future picks ×<input id="trade-discount" type="number" min="0" max="1"
           step="0.05" value="0.8" style="width:5rem"></label>
    <label><input type="checkbox" id="trade-hide-generous" checked> hide trades that help them more</label>
    <button id="trade-suggest">Suggest trades</button>
  </div>
  <p class="draft-note" id="trade-warn" hidden></p>
  <div class="trade-cols" id="trade-cols" hidden>
    <div><h2>You give</h2><ul class="trade-assets" id="trade-mine"></ul></div>
    <div><h2>You get</h2><ul class="trade-assets" id="trade-theirs"></ul></div>
  </div>
  <div class="draft-shortlist-panel" id="trade-grade" hidden></div>
  <div class="draft-shortlist-panel" id="trade-suggestions" hidden></div>
</main>
<footer>Pre-draft only: this values players and draft picks before the draft.
In-season trading is a separate tool.</footer>
<script src="assets/app.js"></script>
<script src="assets/sleeper.js"></script>
<script src="assets/optimizer.js"></script>
<script src="assets/keepers.js"></script>
<script src="assets/trade.js"></script>
<script src="assets/trademode.js"></script>
<script>
(async () => {
  const board = await FC.loadJSON("data/draft.json");
  FC.stampHeader(board);
  TradeMode.init({
    board,
    els: {
      user: document.getElementById("trade-user"),
      load: document.getElementById("trade-load"),
      status: document.getElementById("trade-status"),
      picker: document.getElementById("trade-league-picker"),
      controls: document.getElementById("trade-controls"),
      partner: document.getElementById("trade-partner"),
      discount: document.getElementById("trade-discount"),
      hideGenerous: document.getElementById("trade-hide-generous"),
      suggest: document.getElementById("trade-suggest"),
      warn: document.getElementById("trade-warn"),
      cols: document.getElementById("trade-cols"),
      mine: document.getElementById("trade-mine"),
      theirs: document.getElementById("trade-theirs"),
      grade: document.getElementById("trade-grade"),
      suggestions: document.getElementById("trade-suggestions"),
    },
  });
})().catch(e => {
  document.querySelector(".stamp").textContent = `failed to load: ${e.message}`;
});
</script>
</body>
```

- [ ] **Step 2: Add the nav link**

In `site/index.html`, inside the existing `<header>`, add beside the other
links:

```html
<a class="home" href="trade.html">trade calculator →</a>
```

- [ ] **Step 3: Add styles**

Append to `site/assets/style.css`:

```css
/* Trade calculator. Two asset columns; a selected asset is part of the offer. */
.trade-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1rem; }
@media (max-width: 700px) { .trade-cols { grid-template-columns: 1fr; } }
.trade-assets { list-style: none; margin: 0; padding: 0; max-height: 26rem; overflow-y: auto; }
.trade-assets li { display: flex; justify-content: space-between; gap: .5rem;
  padding: .3rem .45rem; border-bottom: 1px solid rgba(255,255,255,.06);
  font: 500 .8rem/1.4 "IBM Plex Mono", monospace; cursor: pointer; }
.trade-assets li:hover { background: rgba(255,255,255,.04); }
.trade-assets li.picked { background: rgba(255,255,255,.09); border-left: 2px solid var(--rb); }
/* An ineligible player is not a quiet zero -- he is worth nothing to trade and
   the page has to say why, because it is the least intuitive rule in the league. */
.trade-assets li.trade-ineligible { opacity: .55; cursor: not-allowed; }
.trade-assets li.trade-ineligible .trade-why { color: var(--te); }
.trade-why { opacity: .8; font-size: .72rem; }
.trade-gain-pos { color: var(--rb); }
.trade-gain-neg { color: var(--te); }
```

- [ ] **Step 4: Write the panel**

Create `site/assets/trademode.js`. It must:

1. On **Load**: `Sleeper.get("/user/{name}")` → `/user/{id}/leagues/nfl/{season}`.
   If more than one league, render buttons and wait for a pick (copy
   `keepers.js`'s `pickLeague` promise pattern verbatim).
2. Fetch in parallel: `/league/{id}/users`, `/league/{id}/rosters`,
   `/league/{id}/traded_picks`. If `traded_picks` rejects, set
   `els.warn.textContent = "couldn't read traded picks — pick ownership may be wrong"`,
   unhide it, and continue with `defaultPicks` only. **Never guess ownership.**
3. Build the draft chain with `Keepers.buildOriginalByPlayerId(league.previous_league_id)`.
   If there is no `previous_league_id`, set the warning
   `"no prior season — keeper costs unknown, every player priced at full value"`.
4. Build `ctx`:
   ```js
   const board = Optimizer.withValuePoints(cfg.board.players)
     .filter(p => Number.isFinite(Optimizer.seasonValue(p)));
   const bySleeper = new Map(board.filter(p => p.sleeper_id).map(p => [p.sleeper_id, p]));
   const ctx = { season: cfg.board.season, teams: Keepers.TEAMS,
                 rounds: Keepers.DRAFT_ROUNDS, maxKeepers: Keepers.MAX_KEEPERS,
                 board, futureDiscount: Number(els.discount.value) || 0.8,
                 originalByPlayerId: byBoardId, keptElsewhere: new Set() };
   ```
   where `byBoardId` maps **board `player_id`** (not `sleeper_id`) to
   `{round, season}`, translated through `bySleeper` — `buildOriginalByPlayerId`
   is keyed on Sleeper ids and `Trade.candidate` looks up `player.player_id`.
   Getting this wrong makes every player look like a waiver pickup.
5. Compute `keptElsewhere` once: for every team that is neither me nor the
   selected partner, `Trade.chooseKeepers(theirState.roster, ctx)`.
   **Recompute it whenever the partner changes.**
6. Render both asset lists. Each `<li>` carries `data-kind="player|pick"` and an
   id. A player whose `Keepers.eligible` is false renders with class
   `trade-ineligible`, is not clickable, and shows
   `"keeper cost would be R{n} — back to the draft pool, worth 0 to trade"`.
   A roster player with no board row renders as
   `"no projection — value unknown"` and is not clickable.
7. Clicking toggles `picked` and re-grades with `Trade.gradeTrade`, rendering
   into `els.grade`:
   ```
   You gain +34.2 pts · they gain +8.1 pts · looks +12 to them on ADP
   ```
   using `.trade-gain-pos` / `.trade-gain-neg`, and `FC.esc` on every name.
8. **Suggest** disables the button, sets status `"searching…"`, then in a
   `setTimeout(..., 0)` (so the label paints before the ~3s of maths) runs
   `Trade.suggestTrades(me, others, ctx)`, filters out `theirGain > myGain`
   when `els.hideGenerous.checked`, and renders the top 10.
9. Changing the discount input updates `ctx.futureDiscount` and re-grades.

Export `{ init }` under the same UMD wrapper as `sleeper.js`.

- [ ] **Step 5: Verify in a browser**

```bash
cd site && python -m http.server 8731 --bind 127.0.0.1
```

Load `http://127.0.0.1:8731/trade.html`, enter the Sleeper username, and check:
- both asset columns populate; ineligible players are dimmed with the reason
- selecting one player each side produces three numbers
- **Suggest trades** returns a ranked list in a few seconds
- zero console errors

- [ ] **Step 6: Run the whole suite**

```bash
for f in tests/*_fixture.cjs; do node "$f" || echo "FAILED: $f"; done
python -m pytest -q
```
Expected: every fixture OK, 586 Python tests pass (this task touches no Python).

- [ ] **Step 7: Commit**

```bash
git add site/trade.html site/assets/trademode.js site/assets/style.css site/index.html
git commit -m "feat: pre-draft trade calculator page"
```

---

## Self-Review

**Spec coverage.** §1 league facts → Task 3 `ctx` + Global Constraints. §2
no-additive-charts → Task 5 (heuristic only, never displayed). §3.1a keeper
competition → Task 3 test. §3.1b ineligibility → Task 3 test, Task 5 test, Task
6 UI. §3.1c surplus-beats-talent → Task 3 test. §3.1.1 never read `keepers`
field → Task 6 step 4 reads rosters only. §3.2 state value → Task 3. §3.3
future picks → Task 4, including the past-the-horizon test. §4 three numbers →
Task 4 `gradeTrade`. §4.1 where the edge is → encoded by using `marketValue`
only as a filter. §5 suggester → Task 5. §6 data layer → Task 1 + Task 6. §7 UI
→ Task 6. §8 failure modes → Task 6 steps 2, 3, 6. §9 tests → Tasks 2–5. §10
known inconsistency → documented in `chooseKeepers`'s comment.

**Two deviations from the spec, both reasoned:**

1. The shared fetch lives in `sleeper.js`, not `app.js` — see File Structure.
2. **Spec §9's first test was wrong and the spec has been corrected.** It
   asserted the roster-shape premise ("a surplus RB is worth ~0 to me and a lot
   to an RB-poor team"). Measured against the shipped optimizer, pre-draft
   roster shape moves a finishable lineup by **0.8 points** while the keeper
   ladder moves it by **51.0** — because pre-draft a roster is at most two
   keepers and `finishRoster` drafts everything else. The shape assertion would
   have pinned nothing. The premise test is now the ladder, and a second test
   pins shape as correctly *small* so nobody reintroduces an additive shape
   term later. Spec §4.1 and §9 updated to match.

**Type consistency check.** `ctx` keys are identical in Tasks 3, 4, 5.
`state` is `{roster, picks}` throughout. A pick is `{season, round}` (Number,
Number) everywhere; `applyTradedPicks` is the only place a string season is
accepted, and it normalises. An asset is distinguished by `player_id !==
undefined`, used identically in `split` and `marketValue`. `chooseKeepers`
returns `{player, cost}` and is consumed that way in `draftPool`,
`currentDraftValue` and Task 6.
