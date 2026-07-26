# Keeper Auto-Fill (Multi-Year) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the keeper tool's cost model multi-year (escalates from the original draft round) and add a "Load from Sleeper" button that pulls the user's last-season roster + original draft rounds from the Sleeper API to pre-fill keeper candidates.

**Architecture:** All client-side vanilla JS in `site/assets/keepers.js` + wiring in `site/index.html`, reusing draft-mode's read-only Sleeper `fetch` pattern and the `sleeper_id` crosswalk baked into `draft.json`. Pure cost/mapping logic is node-fixture tested; the async fetch orchestration is browser-verified (mocked fetch + fail-soft). No Python, no backend, no `draft.json` regeneration.

**Tech Stack:** Vanilla browser JS (no framework/build), Node.js `assert` for the fixture, Sleeper read-only HTTP API (`https://api.sleeper.app/v1`).

## Global Constraints

- **Client-side only.** No backend, no build step, no new dependency. The published board never depends on this — every failure degrades the panel, never the board.
- **Cost model (exact):** `keeperCost = isWaiver ? 12 : max(1, originalRound − (currentSeason − originalYear))`. Waiver = R12 flat. Eligibility `= isWaiver || originalRound > 2` (judged on the ORIGINAL round). `valueRound = adpRound ?? ceil(overallRank / 12)`. `surplus = keeperCost − valueRound`. Recommend positive-surplus only, best ≤ 2, else "keep none".
- **`currentSeason`** comes from `draft.json`'s `season` field (`board.season`), never hardcoded.
- **Sleeper fetch** mirrors `draftmode.js`: `fetch(API + path)`, throw on `!res.ok`. Read-only, no auth.
- **Node fixture** is run with `node tests/keepers_fixture.cjs` → must print `keepers_fixture: OK`.
- **Commit trailer (last line):** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Spec:** `docs/superpowers/specs/2026-07-26-keeper-autofill-design.md` — source of truth.

## File Structure

- `site/assets/keepers.js` **(modify)** — escalation-aware pure cost model (Task 1); `buildKeeperCandidates` (Task 2); `loadFromSleeper` + chain walk + init wiring (Task 3).
- `site/index.html` **(modify)** — manual form switches to original-round + year (Task 1); "Load from Sleeper" row (Task 3).
- `tests/keepers_fixture.cjs` **(modify)** — escalation cost cases (Task 1); `buildKeeperCandidates` cases (Task 2).

---

## Task 1: Escalation-aware cost model + manual form

Rework the pure functions so cost escalates from the original draft round, thread `currentSeason`, and switch the manual form to collect original round + year.

**Files:**
- Modify: `site/assets/keepers.js`
- Modify: `site/index.html`
- Test: `tests/keepers_fixture.cjs`

**Interfaces:**
- Produces (on `window.Keepers` + CommonJS): `keeperCost(c, currentSeason)`, `eligible(c)`, `valueRound(adpRound, overallRank, teams=12)`, `surplus(c, currentSeason)`, `rankKeepers(candidates, currentSeason)`, `recommendKeepers(candidates, currentSeason, maxKeepers=2)`. A candidate `c` = `{ name, position, originalRound, originalYear, isWaiver, adpRound, overallRank }`.

- [ ] **Step 1: Rewrite the fixture's cost assertions to the escalation model**

Replace the body of `tests/keepers_fixture.cjs` from the top through the existing `recommendKeepers`/`none` blocks with:

```javascript
// tests/keepers_fixture.cjs  — run with: node tests/keepers_fixture.cjs
const assert = require("assert");
const K = require("../site/assets/keepers.js");

const S = 2026;  // currentSeason
const drafted = (originalRound, originalYear, extra = {}) =>
  Object.assign({ name: "x", position: "RB", originalRound, originalYear,
                  isWaiver: false, adpRound: null, overallRank: 100 }, extra);
const waiver = (extra = {}) =>
  Object.assign({ name: "w", position: "RB", isWaiver: true,
                  adpRound: null, overallRank: 100 }, extra);

// cost escalates one round per year kept, from the original round, floored at R1
assert.strictEqual(K.keeperCost(drafted(10, 2025), S), 9);   // 1 year kept
assert.strictEqual(K.keeperCost(drafted(10, 2024), S), 8);   // 2 years kept
assert.strictEqual(K.keeperCost(drafted(3, 2021), S), 1);    // floored at R1 (3-5<1)
assert.strictEqual(K.keeperCost(waiver(), S), 12);           // waiver flat, any year

// eligibility judged on the ORIGINAL round; waiver always eligible
assert.strictEqual(K.eligible(drafted(2, 2025)), false);     // original R2 -> never keepable
assert.strictEqual(K.eligible(drafted(3, 2025)), true);
assert.strictEqual(K.eligible(waiver()), true);

// value round: adp round if present, else board rank -> round
assert.strictEqual(K.valueRound(3, 99), 3);
assert.strictEqual(K.valueRound(null, 30), 3);   // ceil(30/12)

// surplus = cost - value; drafted R10 in 2024 (cost 8), now going R3 -> +5
assert.strictEqual(K.surplus(drafted(10, 2024, { adpRound: 3 }), S), 5);

// recommendKeepers: positive-surplus only, best up to 2
const rec = K.recommendKeepers([
  drafted(12, 2024, { name: "Best", adpRound: 3 }),     // cost 10, value 3 -> +7
  drafted(10, 2025, { name: "Good", adpRound: 4 }),     // cost 9,  value 4 -> +5
  drafted(6, 2025, { name: "Neutral", adpRound: 5 }),   // cost 5,  value 5 -> 0 -> not kept
  drafted(2, 2025, { name: "Elite", adpRound: 1 }),     // original R2 -> ineligible
], S);
assert.deepStrictEqual(rec.map(r => r.name), ["Best", "Good"]);

// keep NONE when nothing beats its cost
const none = K.recommendKeepers([
  drafted(6, 2025, { name: "Zero", adpRound: 5 }),   // 0
  drafted(3, 2025, { name: "Neg", adpRound: 6 }),    // cost 2, value 6 -> -4
], S);
assert.deepStrictEqual(none, []);

console.log("keepers_fixture: OK");
```

- [ ] **Step 2: Run the fixture to verify it fails**

Run: `node tests/keepers_fixture.cjs`
Expected: FAIL — `TypeError: K.keeperCost is not a function` (still the old `costRound` API).

- [ ] **Step 3: Rewrite the pure model in `keepers.js`**

In `site/assets/keepers.js`, replace the block from `const WAIVER_COST_ROUND = 12;` through the end of `recommendKeepers` (the pure functions, before `function init`) with:

```javascript
  const WAIVER_COST_ROUND = 12;
  const MAX_KEEPERS = 2;

  // Cost escalates one round per year kept, anchored to the ORIGINAL draft
  // round, floored at R1. Waiver pickups (never drafted) are R12 flat.
  function keeperCost(c, currentSeason) {
    if (c.isWaiver) return WAIVER_COST_ROUND;
    return Math.max(1, c.originalRound - (currentSeason - c.originalYear));
  }
  function eligible(c) {
    return c.isWaiver || c.originalRound > 2;   // "no keepers from rounds 1-2"
  }
  function valueRound(adpRound, overallRank, teams = 12) {
    if (adpRound != null) return adpRound;
    return Math.ceil(overallRank / teams);
  }
  function surplus(c, currentSeason) {
    return keeperCost(c, currentSeason) - valueRound(c.adpRound, c.overallRank);
  }
  function rankKeepers(candidates, currentSeason) {
    return candidates
      .filter(eligible)
      .map(c => Object.assign({}, c, { surplus: surplus(c, currentSeason) }))
      .sort((a, b) => b.surplus - a.surplus);
  }
  // Which players to actually keep: best up-to-maxKeepers with POSITIVE surplus.
  function recommendKeepers(candidates, currentSeason, maxKeepers = MAX_KEEPERS) {
    return rankKeepers(candidates, currentSeason)
      .filter(c => c.surplus > 0).slice(0, maxKeepers);
  }
```

- [ ] **Step 4: Thread `currentSeason` through `init` and update the render + manual submit**

In `keepers.js`, replace the entire `function init(options) { … }` body with:

```javascript
  function init(options) {
    const { players, panel, currentSeason } = options;
    if (!panel) return;
    const esc = window.FC.esc;
    const rankByName = new Map(players.map((p, i) => [p.name, {
      adpRound: p.adp_round, overallRank: i + 1, position: p.position,
    }]));
    // Autocomplete: fill the datalist the name input references.
    let dl = document.getElementById("playerlist");
    if (!dl) { dl = document.createElement("datalist"); dl.id = "playerlist"; panel.appendChild(dl); }
    dl.innerHTML = players.map(p => `<option value="${esc(p.name)}"></option>`).join("");

    const candidates = [];
    const recEl = panel.querySelector(".keeper-rec");
    const outEl = panel.querySelector(".keeper-out");

    function redraw() {
      const ranked = rankKeepers(candidates, currentSeason);
      const rec = recommendKeepers(candidates, currentSeason);
      const recNames = new Set(rec.map(r => r.name));
      if (!candidates.length) {
        recEl.innerHTML = "";
      } else if (!rec.length) {
        recEl.innerHTML = "<strong>Keep none.</strong> No candidate is worth more than his keeper cost.";
      } else {
        recEl.innerHTML = "<strong>Keep:</strong> " + rec.map(r =>
          `${esc(r.name)} (+${r.surplus} rd${r.surplus === 1 ? "" : "s"})`).join(", ");
      }
      const detail = c => {
        const cost = keeperCost(c, currentSeason);
        const val = valueRound(c.adpRound, c.overallRank);
        const s = c.surplus;
        return `keep for R${cost} · worth R${val} · <strong>${s >= 0 ? "+" : ""}${s} rds</strong>`;
      };
      const ineligible = candidates.filter(c => !eligible(c));
      outEl.innerHTML = ranked.map(c =>
          `<li class="${recNames.has(c.name) ? "keep-best" : ""}">${esc(c.name)} — ${detail(c)}</li>`)
        .concat(ineligible.map(c =>
          `<li class="keeper-ineligible">${esc(c.name)} — ineligible (drafted R1–2)</li>`))
        .join("");
    }
    // Exposed so the Sleeper loader (Task 3) can push a batch of candidates.
    panel._keeperAdd = (list) => { candidates.push(...list); redraw(); };
    panel._keeperReset = () => { candidates.length = 0; redraw(); };

    panel.querySelector(".keeper-add").addEventListener("submit", e => {
      e.preventDefault();
      const name = panel.querySelector(".keeper-name").value.trim();
      const isWaiver = panel.querySelector(".keeper-waiver").checked;
      const originalRound = parseInt(panel.querySelector(".keeper-round").value, 10) || 0;
      // blank year defaults to last season (a single-year keeper)
      const originalYear = parseInt(panel.querySelector(".keeper-year").value, 10) || (currentSeason - 1);
      const meta = rankByName.get(name);
      if (!meta) { panel.querySelector(".keeper-msg").textContent = "no board match for that name"; return; }
      panel.querySelector(".keeper-msg").textContent = "";
      candidates.push({ name, position: meta.position, originalRound, originalYear,
                        isWaiver, adpRound: meta.adpRound, overallRank: meta.overallRank });
      redraw();
    });
  }
```

- [ ] **Step 5: Update the exports line**

In `keepers.js`, change the final `return { … };` to:

```javascript
  return { init, keeperCost, eligible, valueRound, surplus, rankKeepers, recommendKeepers };
```

- [ ] **Step 6: Update the manual form + `init` call in `index.html`**

In `site/index.html`, change the manual form's single round input to two inputs (original round + year):

```html
      <input class="keeper-name" placeholder="Player (start typing)" list="playerlist" autocomplete="off" />
      <input class="keeper-round" type="number" min="1" max="20" placeholder="Original round" />
      <input class="keeper-year" type="number" min="2000" max="2100" placeholder="Year drafted" />
      <label><input class="keeper-waiver" type="checkbox" /> waiver pickup (R12)</label>
```

And update the help copy line inside the panel to:

```html
    <p class="keeper-help">Add each keeper-eligible player with the round and year you ORIGINALLY drafted him (cost drops one round per year kept). Keeping is optional — the tool recommends only players worth more than their keeper cost.</p>
```

And pass `currentSeason` to `init` (find the `Keepers.init({ … })` call):

```javascript
  if (window.Keepers) {
    Keepers.init({ players: board.players, panel: document.getElementById("keepers"),
                   currentSeason: board.season });
  }
```

- [ ] **Step 7: Run the fixture to verify it passes**

Run: `node tests/keepers_fixture.cjs`
Expected: prints `keepers_fixture: OK`, exit 0.

- [ ] **Step 8: Commit**

```bash
git add site/assets/keepers.js site/index.html tests/keepers_fixture.cjs
git commit -m "feat: multi-year keeper cost (escalates from original draft round)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `buildKeeperCandidates` (roster + draft history → candidates)

Pure mapping from Sleeper roster data + the board into candidate objects the recommender consumes.

**Files:**
- Modify: `site/assets/keepers.js`
- Test: `tests/keepers_fixture.cjs`

**Interfaces:**
- Consumes (Task 1): candidate shape `{ name, position, originalRound, originalYear, isWaiver, adpRound, overallRank }`.
- Produces: `buildKeeperCandidates(rosterPlayerIds, originalByPlayerId, boardBySleeperId) -> { candidates, skipped }`. `rosterPlayerIds` = array of Sleeper player_id strings; `originalByPlayerId` = Map(player_id → `{ round, season }`); `boardBySleeperId` = Map(sleeper_id → `{ name, position, adpRound, overallRank }`); `skipped` = array of unmatched player_ids.

- [ ] **Step 1: Add fixture cases for `buildKeeperCandidates`**

Append to `tests/keepers_fixture.cjs`, just before the final `console.log("keepers_fixture: OK");`:

```javascript
// buildKeeperCandidates: map roster + draft history + board -> candidates
const board = new Map([
  ["s_bijan", { name: "Bijan", position: "RB", adpRound: 1, overallRank: 2 }],
  ["s_puka",  { name: "Puka",  position: "WR", adpRound: 1, overallRank: 5 }],
  ["s_waiverguy", { name: "WaiverGuy", position: "WR", adpRound: 9, overallRank: 110 }],
]);
// Bijan's earliest pick is 2024 (kept, so he ALSO appears escalated in 2025 —
// earliest season must win); WaiverGuy is on no draft; s_kicker is off-board.
const original = new Map([
  ["s_bijan", { round: 4, season: 2024 }],
  ["s_puka",  { round: 6, season: 2025 }],
]);
const { candidates, skipped } = K.buildKeeperCandidates(
  ["s_bijan", "s_puka", "s_waiverguy", "s_kicker"], original, board);
assert.deepStrictEqual(skipped, ["s_kicker"]);               // off-board, dropped
const byName = Object.fromEntries(candidates.map(c => [c.name, c]));
assert.deepStrictEqual(
  { r: byName.Bijan.originalRound, y: byName.Bijan.originalYear, w: byName.Bijan.isWaiver },
  { r: 4, y: 2024, w: false });
assert.strictEqual(byName.WaiverGuy.isWaiver, true);          // not in any draft
assert.strictEqual(byName.Puka.adpRound, 1);                  // board fields carried
// escalation end-to-end via Task 1: Bijan cost = 4 - (2026-2024) = 2, value R1 -> +1
assert.strictEqual(K.surplus(byName.Bijan, 2026), 1);
```

- [ ] **Step 2: Run the fixture to verify it fails**

Run: `node tests/keepers_fixture.cjs`
Expected: FAIL — `TypeError: K.buildKeeperCandidates is not a function`.

- [ ] **Step 3: Implement `buildKeeperCandidates`**

In `keepers.js`, add this function after `recommendKeepers` and before `function init`:

```javascript
  // Map a Sleeper roster (player_ids) + original-draft history + the board into
  // keeper candidates. Players with no board entry (K/DST/retired/deep) are
  // dropped into `skipped` and counted, never valued.
  function buildKeeperCandidates(rosterPlayerIds, originalByPlayerId, boardBySleeperId) {
    const candidates = [], skipped = [];
    for (const pid of rosterPlayerIds) {
      const b = boardBySleeperId.get(pid);
      if (!b) { skipped.push(pid); continue; }
      const orig = originalByPlayerId.get(pid);
      const c = { name: b.name, position: b.position,
                  adpRound: b.adpRound, overallRank: b.overallRank };
      if (orig) { c.originalRound = orig.round; c.originalYear = orig.season; c.isWaiver = false; }
      else { c.isWaiver = true; }          // on no draft in the chain -> waiver R12
      candidates.push(c);
    }
    return { candidates, skipped };
  }
```

- [ ] **Step 4: Add it to the exports**

Change the `return { … };` line to include it:

```javascript
  return { init, keeperCost, eligible, valueRound, surplus, rankKeepers,
           recommendKeepers, buildKeeperCandidates };
```

- [ ] **Step 5: Run the fixture to verify it passes**

Run: `node tests/keepers_fixture.cjs`
Expected: prints `keepers_fixture: OK`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add site/assets/keepers.js tests/keepers_fixture.cjs
git commit -m "feat: buildKeeperCandidates — Sleeper roster + draft history -> candidates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: "Load from Sleeper" — fetch orchestration + UI

Wire the async chain (username → league → previous_league_id chain walk → candidates) and the panel UI. Browser-verified (mocked fetch happy path + fail-soft); no node test for the network layer.

**Files:**
- Modify: `site/assets/keepers.js`
- Modify: `site/index.html`

**Interfaces:**
- Consumes (Tasks 1–2): `panel._keeperReset()`, `panel._keeperAdd(list)`, `buildKeeperCandidates`.
- Produces: the panel's "Load from Sleeper" behavior. No exported pure functions.

- [ ] **Step 1: Add the "Load from Sleeper" UI to `index.html`**

In `site/index.html`, inside the keeper `<details>`, immediately after the `<summary>` and `keeper-help` paragraph and BEFORE `<form class="keeper-add">`, add:

```html
    <div class="keeper-load">
      <input class="keeper-user" placeholder="Sleeper username" autocomplete="off" />
      <button type="button" class="keeper-load-btn">Load from Sleeper</button>
      <span class="keeper-load-status" role="status"></span>
      <div class="keeper-league-picker"></div>
      <span class="keeper-skip-note"></span>
    </div>
```

- [ ] **Step 2: Add the Sleeper fetch + chain walk to `keepers.js`**

In `keepers.js`, add near the top of the factory (after `const MAX_KEEPERS = 2;`):

```javascript
  const SLEEPER = "https://api.sleeper.app/v1";
  const CHAIN_CAP = 8;   // safety cap on previous_league_id hops
  let loadSeq = 0;       // generation token: a stale load can't overwrite a newer one

  async function sapi(path) {
    const res = await fetch(`${SLEEPER}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Walk previous_league_id backward from `startLeagueId`, recording each
  // player's EARLIEST draft (round, season) -> his original draft. Partial
  // failures skip that hop and keep walking.
  async function buildOriginalByPlayerId(startLeagueId) {
    const original = new Map();
    let lid = startLeagueId, hops = 0;
    while (lid && hops < CHAIN_CAP) {
      let league = null;
      try { league = await sapi(`/league/${lid}`); } catch (e) { break; }
      try {
        const drafts = (await sapi(`/league/${lid}/drafts`)) || [];
        const draft = drafts.find(d => d.status === "complete") || drafts[0];
        if (draft) {
          const season = parseInt(draft.season, 10);
          const picks = (await sapi(`/draft/${draft.draft_id}/picks`)) || [];
          for (const p of picks) {
            if (!p.player_id) continue;
            const prev = original.get(p.player_id);
            if (!prev || season < prev.season) original.set(p.player_id, { round: p.round, season });
          }
        }
      } catch (e) { /* skip this season's draft, keep walking */ }
      lid = league && league.previous_league_id;
      hops++;
    }
    return original;
  }
```

- [ ] **Step 3: Add the `loadFromSleeper` orchestration and wire it in `init`**

In `keepers.js`, inside `init`, after the manual-submit listener, add the loader wiring. `players` and `currentSeason` are in scope:

```javascript
    // --- Load from Sleeper -------------------------------------------------
    const boardBySleeperId = new Map();
    players.forEach((p, i) => {
      if (p.sleeper_id) boardBySleeperId.set(p.sleeper_id,
        { name: p.name, position: p.position, adpRound: p.adp_round, overallRank: i + 1 });
    });
    const loadEls = {
      user: panel.querySelector(".keeper-user"),
      btn: panel.querySelector(".keeper-load-btn"),
      status: panel.querySelector(".keeper-load-status"),
      picker: panel.querySelector(".keeper-league-picker"),
      skip: panel.querySelector(".keeper-skip-note"),
    };
    const setLoad = t => { loadEls.status.textContent = t; };

    // Render league buttons and resolve with the chosen league (or null).
    function pickLeague(leagues) {
      return new Promise(resolve => {
        loadEls.picker.innerHTML = "";
        setLoad(`${leagues.length} leagues — pick one`);
        leagues.forEach(lg => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = lg.name || lg.league_id;
          b.addEventListener("click", () => { loadEls.picker.innerHTML = ""; resolve(lg); });
          loadEls.picker.appendChild(b);
        });
      });
    }

    async function loadFromSleeper() {
      const username = loadEls.user.value.trim();
      if (!username) { setLoad("enter your Sleeper username"); return; }
      const seq = ++loadSeq;
      const stale = () => seq !== loadSeq;
      loadEls.skip.textContent = "";
      try {
        setLoad("looking up user…");
        const user = await sapi(`/user/${encodeURIComponent(username)}`);
        if (!user || !user.user_id) { setLoad("user not found"); return; }
        const leagues = (await sapi(`/user/${user.user_id}/leagues/nfl/${currentSeason}`)) || [];
        if (stale()) return;
        if (!leagues.length) { setLoad(`no ${currentSeason} leagues for ${username}`); return; }
        const league = leagues.length === 1 ? leagues[0] : await pickLeague(leagues);
        if (!league || stale()) return;
        const prevId = league.previous_league_id;
        if (!prevId) { setLoad("no prior season found — enter keepers manually"); return; }
        setLoad("reading last season's roster…");
        const rosters = (await sapi(`/league/${prevId}/rosters`)) || [];
        const mine = rosters.find(r => r.owner_id === user.user_id);
        if (!mine || !mine.players) { setLoad("couldn't find your roster last season — enter manually"); return; }
        setLoad("tracing draft history…");
        const original = await buildOriginalByPlayerId(prevId);
        if (stale()) return;
        const { candidates, skipped } = buildKeeperCandidates(mine.players, original, boardBySleeperId);
        panel._keeperReset();
        panel._keeperAdd(candidates);
        setLoad(`loaded ${candidates.length} player(s)`);
        loadEls.skip.textContent = skipped.length
          ? ` · ${skipped.length} not on the board (K/DST/retired) — add manually if needed` : "";
      } catch (e) {
        setLoad(`load failed: ${e.message} — enter keepers manually`);
      }
    }
    loadEls.btn.addEventListener("click", loadFromSleeper);
```

- [ ] **Step 4: Verify the file parses (no syntax errors)**

Run: `node -e "require('./site/assets/keepers.js'); console.log('parse OK')"`
Expected: prints `parse OK` (the module loads under Node; browser-only globals like `document`/`fetch` are only touched inside `init`/handlers, which Node never calls here).

- [ ] **Step 5: Run the node fixture (unchanged pure logic still green)**

Run: `node tests/keepers_fixture.cjs`
Expected: `keepers_fixture: OK`.

- [ ] **Step 6: Commit**

```bash
git add site/assets/keepers.js site/index.html
git commit -m "feat: Load from Sleeper — roster + draft-history auto-fill for keepers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 7: Browser verification (coordinator-run, mocked fetch)**

Serve the site (`python -m http.server 8099` in `site/`), open `http://127.0.0.1:8099/index.html`, and in the page override `window.fetch` to return canned Sleeper responses, then exercise the loader. Confirm:
- Happy path: a stubbed user → one 2026 league (with `previous_league_id`) → last-season roster of 2–3 sleeper_ids present on the board + a draft with picks → clicking "Load from Sleeper" resets and fills the candidate list, the "Keep:" headline recommends the right players, escalated costs are correct, and an off-board id shows the "N not on the board" note.
- Fail-soft: a bad username (stub `/user/...` → `{}`) shows "user not found" and leaves the manual form working; a league with `previous_league_id: null` shows "no prior season found".
- Zero console errors in every path.

---

## Self-Review

**Spec coverage:** §2 escalation cost → Task 1 `keeperCost`; §2 waiver R12 / eligibility-on-original → Task 1; §2 standalone connection → Task 3 UI; §2 roster source (prev league rosters) → Task 3 `loadFromSleeper`; §5 data-flow chain walk → Task 3 `buildOriginalByPlayerId` + `loadFromSleeper`; §5 league picker → Task 3 `pickLeague`; §6 `buildKeeperCandidates` rules → Task 2; §6 cost model → Task 1; §7 fail-soft + generation token → Task 3 (`try/catch` per step, `loadSeq`); §8 pure tests → Tasks 1–2 fixture, browser E2E → Task 3 Step 7; §9 limitations (waiver flat, co-owner, history horizon) → inherent in the code (waiver flat in `keeperCost`; `owner_id` match only; earliest-season wins). No gaps.

**Placeholder scan:** none — every step carries complete code.

**Type consistency:** candidate shape `{ name, position, originalRound, originalYear, isWaiver, adpRound, overallRank }` is identical across Task 1 (manual submit + fixture), Task 2 (`buildKeeperCandidates` output), and Task 3 (`buildKeeperCandidates` call). `keeperCost(c, currentSeason)`/`surplus(c, currentSeason)`/`rankKeepers(candidates, currentSeason)`/`recommendKeepers(candidates, currentSeason, max)` take `currentSeason` consistently. `boardBySleeperId` value shape `{ name, position, adpRound, overallRank }` matches between Task 2 fixture and Task 3 construction. `originalByPlayerId` value `{ round, season }` matches Task 2 and Task 3. `panel._keeperAdd`/`_keeperReset` defined in Task 1 `init`, consumed in Task 3.
