# Draft-Mode QoL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pick ticker, on-the-clock countdown, and full VONA ("waiting costs") in draft mode, plus the four ledgered hardening items.

**Architecture:** Everything lives in `site/assets/draftmode.js` (+ two panel `<p>` rows and one CSS selector extension). The snake/VONA math is pure and exported on `DraftMode` for node-fixture verification; the aids render from the existing `applyPicks` path; hardening reuses existing state (append-only picks guard, 10th-poll status re-check, stored-blob validation, disconnect resets). The board's `onUpdate` state contract is unchanged.

**Tech Stack:** Vanilla JS/CSS; node (syntax check + fixture script); no framework, no build, no Python changes.

**Spec:** `docs/superpowers/specs/2026-07-21-draft-mode-qol-design.md` — read it first.

## Global Constraints

- Every failure degrades the panel, never the board; an aid with missing inputs renders nothing — never a wrong number.
- Non-snake handling: `draft.type === "linear"` uses the linear formula; auction/unknown types hide countdown + VONA (ticker still works).
- No other-user name lookups; countdown is self-centric.
- The `onUpdate` state shape (`{connected, drafted, mine, hideDrafted}`) must not change — the board render in index.html is untouched.
- No JS test framework (site invariant): the pure math is verified by the node fixture script in Task 1 (run, output recorded in the report, NOT committed under `site/`).
- Python suite must stay green: `$env:PYTHONPATH = "src"; python -m pytest -q` (PowerShell) → 299 passed expected (no Python files change).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Pure snake/VONA math, exported + fixture-verified

**Files:**
- Modify: `site/assets/draftmode.js` (add two pure functions inside the IIFE; extend the return statement)
- Create (NOT committed): `<scratchpad>/qol_math_fixture.js` — the coordinator provides the scratchpad path in the dispatch; if absent, use the repo-external temp dir, never `site/`.

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces (Task 2 calls these; both exported on `window.DraftMode`):
  - `nextPickNumber(slot, teams, rounds, reversalRound, picksMade, type = "snake") -> number | null` — smallest pick number > `picksMade` belonging to `slot`; `null` on bad/missing inputs, unknown type, or exhausted draft.
  - `vonaDeltas(players, draftedSet, picksUntilMine) -> {QB?, RB?, WR?, TE?} | null` — per-position VORP cost of waiting; positions with no remaining player omitted; `null` on invalid inputs.

- [ ] **Step 1: Add the pure functions**

In `site/assets/draftmode.js`, insert directly above the `function init(options) {` line:

```js
  // --- pure draft math (exported for fixture verification) -----------------
  function pickForRoundSlot(r, slot, teams, reversalRound, type) {
    if (type === "linear") return (r - 1) * teams + slot;
    // Snake; Sleeper third-round-reversal flips direction parity from
    // reversalRound on (round 3 repeats round 2's direction, etc).
    let reversed = r % 2 === 0;
    if (reversalRound && r >= reversalRound) reversed = !reversed;
    return reversed ? r * teams - slot + 1 : (r - 1) * teams + slot;
  }

  function nextPickNumber(slot, teams, rounds, reversalRound, picksMade, type = "snake") {
    if (!Number.isInteger(slot) || !Number.isInteger(teams) || !Number.isInteger(rounds)
        || slot < 1 || teams < 1 || rounds < 1 || slot > teams
        || !Number.isInteger(picksMade) || picksMade < 0) return null;
    if (type !== "snake" && type !== "linear") return null;
    for (let r = 1; r <= rounds; r++) {
      const p = pickForRoundSlot(r, slot, teams, reversalRound || 0, type);
      if (p > picksMade) return p;
    }
    return null;                       // this slot has no pick left
  }

  function vonaDeltas(players, draftedSet, picksUntilMine) {
    if (!Array.isArray(players) || !(draftedSet instanceof Set)
        || !Number.isInteger(picksUntilMine) || picksUntilMine < 0) return null;
    // Available = not struck (same predicate as the board render: only a
    // matched sleeper_id can be drafted). Sorted by VORP desc; the naive
    // assumption removes the top picksUntilMine overall.
    const avail = players
      .filter(p => !(p.sleeper_id && draftedSet.has(p.sleeper_id)))
      .slice()
      .sort((a, b) => (b.vorp ?? -Infinity) - (a.vorp ?? -Infinity));
    const after = avail.slice(picksUntilMine);
    const deltas = {};
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      const now = avail.find(p => p.position === pos);
      if (!now) continue;                              // position empty: omit
      const later = after.find(p => p.position === pos);
      // No survivor at the position => next-best is replacement level
      // (VORP 0 by construction), so the cost is the whole current VORP.
      const cost = now.vorp - (later ? later.vorp : 0);
      deltas[pos] = Math.round(cost * 10) / 10;
    }
    return deltas;
  }
```

and change the return statement at the bottom of the IIFE from
`return { init, disable };` to:

```js
  return { init, disable, nextPickNumber, vonaDeltas };
```

- [ ] **Step 2: Syntax check**

Run: `node --check site/assets/draftmode.js`
Expected: silent success (exit 0).

- [ ] **Step 3: Write and run the fixture script**

Create `<scratchpad>/qol_math_fixture.js`:

```js
const fs = require("fs");
global.window = {};
eval(fs.readFileSync(process.argv[2], "utf8"));
const { nextPickNumber: npn, vonaDeltas } = window.DraftMode;

let failures = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// standard snake, 12 teams, slot 3: picks 3, 22, 27, 46
eq("snake r1", npn(3, 12, 15, 0, 0), 3);
eq("snake r2", npn(3, 12, 15, 0, 3), 22);
eq("snake r2 mid", npn(3, 12, 15, 0, 21), 22);
eq("snake r3", npn(3, 12, 15, 0, 22), 27);
// 3RR, 12 teams, slot 1, reversal_round 3: picks 1, 24, 36, 37 (back-to-back)
eq("3rr r1", npn(1, 12, 15, 3, 0), 1);
eq("3rr r2", npn(1, 12, 15, 3, 1), 24);
eq("3rr r3", npn(1, 12, 15, 3, 24), 36);
eq("3rr r4", npn(1, 12, 15, 3, 36), 37);
// linear, 10 teams, slot 5: 5, 15, 25
eq("linear r1", npn(5, 10, 15, 0, 0, "linear"), 5);
eq("linear r2", npn(5, 10, 15, 0, 5, "linear"), 15);
// exhausted + bad inputs
eq("exhausted", npn(3, 12, 2, 0, 24), null);
eq("bad slot", npn(0, 12, 15, 0, 0), null);
eq("slot > teams", npn(13, 12, 15, 0, 0), null);
eq("auction", npn(3, 12, 15, 0, 0, "auction"), null);
eq("nonint picks", npn(3, 12, 15, 0, 1.5), null);

// vonaDeltas
const players = [
  { sleeper_id: "1", position: "RB", vorp: 50.0 },
  { sleeper_id: "2", position: "RB", vorp: 37.5 },
  { sleeper_id: "3", position: "WR", vorp: 40.0 },
  { sleeper_id: "4", position: "WR", vorp: 39.0 },
  { sleeper_id: "5", position: "QB", vorp: 10.0 },
  { sleeper_id: null, position: "TE", vorp: 8.0 },   // unmatched: always available
];
// 2 picks before mine remove RB50 and WR40:
eq("vona removal", vonaDeltas(players, new Set(), 2),
   { QB: 0, RB: 12.5, WR: 1.0, TE: 0 });
// drafted RB50 already struck; 1 pick removes WR40:
eq("vona drafted", vonaDeltas(players, new Set(["1"]), 1),
   { QB: 0, RB: 0, WR: 1.0, TE: 0 });
// position empties entirely: only 1 QB, removed by the 3 picks => cost = full vorp
eq("vona empties", vonaDeltas(players, new Set(["1", "2"]), 3).QB, 10.0);
// position with nothing remaining is OMITTED
const noTE = players.filter(p => p.position !== "TE");
eq("vona omit", "TE" in vonaDeltas(noTE, new Set(), 0), false);
// invalid inputs
eq("vona bad set", vonaDeltas(players, null, 1), null);
eq("vona bad n", vonaDeltas(players, new Set(), -1), null);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
```

Run: `node <scratchpad>/qol_math_fixture.js site/assets/draftmode.js`
Expected: every line PASS, final `ALL PASS`, exit 0. Paste the full output in your report. If any line fails, fix the implementation (not the fixture) — the fixture values above are hand-derived from the formulas in the spec.

- [ ] **Step 4: Python suite unchanged**

Run: `$env:PYTHONPATH = "src"; python -m pytest -q`
Expected: 299 passed, 2 deselected.

- [ ] **Step 5: Commit**

```bash
git add site/assets/draftmode.js
git commit -m "feat: exported snake/VONA math — 3RR-aware, fixture-verified"
```

---

### Task 2: Panel aids + hardening

**Files:**
- Modify: `site/assets/draftmode.js`
- Modify: `site/index.html` (two panel rows + two `els` entries)
- Modify: `site/assets/style.css` (one selector extension)

**Interfaces:**
- Consumes: `nextPickNumber`, `vonaDeltas` (Task 1, same IIFE scope — call them directly, not via `window.DraftMode`).
- Produces: the user-visible aids + hardening. `onUpdate` state shape unchanged.

- [ ] **Step 1: Panel markup**

In `site/index.html`, inside the draft panel's `.draft-body`, directly after the `<p class="draft-roster" ...>` line, add:

```html
      <p class="draft-ticker" id="draft-ticker" hidden></p>
      <p class="draft-vona" id="draft-vona" hidden></p>
```

and in the `DraftMode.init({ ... els: { ... } })` block add two entries after `roster: ...`:

```js
          ticker: document.getElementById("draft-ticker"),
          vona: document.getElementById("draft-vona"),
```

- [ ] **Step 2: CSS**

In `site/assets/style.css`, extend the existing rule
`.draft-roster, .draft-note { ... }` to
`.draft-roster, .draft-note, .draft-ticker, .draft-vona { ... }` (same styling, no new block).

- [ ] **Step 3: draftmode.js integration + hardening**

All edits in `site/assets/draftmode.js`:

1. Module state (next to `let timer = null, backoff = POLL_MS;`):

```js
  let lastPickCount = -1;   // render guard: picks are append-only
  let statusChecks = 0;     // draft-complete fallback when settings lack rounds/teams
```

2. `connect(...)`: replace the `session = { ... }` assignment with:

```js
      const order = draft.draft_order || {};
      session = { username, userId, draftId,
                  totalPicks: (s.rounds || 0) * (s.teams || 0),
                  slot: (userId && order[userId]) || null,
                  teams: s.teams || 0, rounds: s.rounds || 0,
                  reversalRound: s.reversal_round || 0,
                  type: draft.type || "snake" };
      lastPickCount = -1;
      statusChecks = 0;
```

3. `pollOnce(seq)`: replace the two lines `backoff = POLL_MS;` and
`applyPicks(picks);` with:

```js
      backoff = POLL_MS;
      if (picks.length !== lastPickCount) {
        applyPicks(picks);                    // render guard: append-only picks
      }
      if (!session.totalPicks && ++statusChecks % 10 === 0) {
        // Sleeper omitted settings.rounds/teams: fall back to re-checking
        // the draft object's status every 10th poll so completion still stops us.
        const d = await api(`/draft/${session.draftId}`);
        if (seq !== pollSeq || !session) return;
        if (d && d.status === "complete") {
          setStatus(`draft complete — ${picks.length} picks`);
          return;
        }
      }
```

4. `applyPicks(picks)`: first line becomes `lastPickCount = picks.length;`, and directly before `setStatus(\`connected — live\`);` add `updateAids(picks);`.

5. New function, directly after `applyPicks`:

```js
  function updateAids(picks) {
    const t = cfg.els.ticker, v = cfg.els.vona;
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
    if (!session || !session.slot || !session.teams || !session.rounds) return;
    const next = nextPickNumber(session.slot, session.teams, session.rounds,
                                session.reversalRound, picks.length, session.type);
    if (next === null) return;          // auction/unknown type or no pick left
    const until = next - picks.length - 1;   // full picks before yours
    let line = until <= 0 ? "you're on the clock"
                          : `pick #${picks.length + 1} next · your turn in ${until + 1}`;
    if (until > 0) {
      const deltas = vonaDeltas(cfg.board.players, state.drafted, until);
      if (deltas) {
        const parts = Object.entries(deltas).map(([pos, d]) => `${pos} −${d.toFixed(1)}`);
        if (parts.length) line += ` · waiting costs: ${parts.join(" · ")}`;
      }
    }
    v.textContent = line;
    v.title = "assumes the picks before yours take the best available by VORP";
    v.hidden = false;
  }
```

6. `disconnect()`: after `cfg.els.roster.hidden = true;` add:

```js
    cfg.els.ticker.hidden = true;
    cfg.els.vona.hidden = true;
    cfg.els.note.hidden = true;
    cfg.els.hide.checked = false;
    state.hideDrafted = false;
    lastPickCount = -1;
    statusChecks = 0;
```

7. `init(...)` stored-state guard: replace the `try { ... } catch` block's body with:

```js
      try {
        const parsed = JSON.parse(stored);
        if (parsed && parsed.draftId) {
          document.getElementById("draft-panel").open = true;
          connect(parsed.username, parsed.userId, parsed.draftId);
        } else {
          localStorage.removeItem(STORE_KEY);   // incomplete blob: clear, don't 404
        }
      } catch (e) { localStorage.removeItem(STORE_KEY); }
```

- [ ] **Step 4: Verify**

- `node --check site/assets/draftmode.js` → clean.
- Re-run the Task 1 fixture (`node <scratchpad>/qol_math_fixture.js site/assets/draftmode.js`) → still ALL PASS (proves the exports survived the edits).
- Serve `python -m http.server 8001 --directory site`; curl `/` → 200, contains `draft-ticker` and `draft-vona`; kill server.
- `$env:PYTHONPATH = "src"; python -m pytest -q` → 299 passed.

- [ ] **Step 5: Commit**

```bash
git add site/assets/draftmode.js site/index.html site/assets/style.css
git commit -m "feat: draft-mode ticker, on-the-clock countdown, VONA + hardening"
```

---

### Task 3: Browser verification (coordinator-driven)

- [ ] **Step 1:** Serve the site; connect to completed draft 289646328508579840. Expect: ticker shows the last 3 picks (`#178/#179/#180 ...`); countdown/VONA hidden (no pick remains → `nextPickNumber` null); complete-detection line intact; zero console errors.
- [ ] **Step 2:** Render guard: with the connection live, install a `MutationObserver` counting tbody mutations, wait ≥2 poll cycles (picks stable at 180) — expect ZERO mutations between polls (guard short-circuits `applyPicks`).
- [ ] **Step 3:** Disconnect: ticker/vona/note hidden, hide-drafted unchecked, board restored. Reload with a hand-corrupted `localStorage` blob (`{"username":"x"}`) → panel stays closed, blob cleared, no console error.
- [ ] **Step 4:** Suite green; merge gate per superpowers:finishing-a-development-branch. The live VONA/countdown path is acceptance-tested in the user's mock-draft rehearsal (only an ACTIVE draft can exercise it end-to-end).

---

## Verification sweep

- Spec error-table walk: auction hidden (fixture `auction → null` + `updateAids` early return), spectator hidden (`session.slot` null check), 3RR (fixture), missing metadata (name fallback chain), missing inputs render nothing (`v.hidden = true` default).
- `onUpdate` contract: grep the diff — no changes to the `state` object's keys.
- No Python changes: `git diff --stat main` touches only `site/` + docs.
