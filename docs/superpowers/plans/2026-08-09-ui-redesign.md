# Site UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the site from competent to striking — a "trading desk" chassis everywhere, editorial distribution moments where they earn their keep — without touching a single number the model produces.

**Architecture:** One new pure module (`site/assets/bands.js`) owns all quantile→geometry math and the shared-domain rule, so both properties that make bands comparable are fixture-testable instead of buried in page code. Pages consume it. The draft board gains an expandable row whose state lives outside the DOM, because the board rebuilds its tbody every 3 seconds under draft mode.

**Tech Stack:** Static HTML/CSS/vanilla JS, UMD modules, `node` fixtures with `assert`. No framework, no build step, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-09-ui-redesign-design.md`

## Global Constraints

Every task's requirements implicitly include these.

- **`site/` only.** No changes to `src/`, `configs/`, `models/`, `.github/`, or any file under `site/data/`. Nothing may alter published JSON or the weekly Actions run.
- **No new runtime dependencies, no framework, no build step.** Fonts already loaded (Barlow Condensed, IBM Plex Mono, Source Sans 3) — do not add more.
- **All existing node fixtures stay green.** Run every one, not just the new file: `for f in tests/*_fixture.cjs; do node "$f"; done`
- **`python -m pytest` reports no failures.** Expressed as the command, not a count.
- **Preserve all existing user-facing copy verbatim** unless a task explicitly changes it — especially the trade page's noise disclaimers (`site/assets/trademode.js:562-580`).
- **Density must not regress.** The draft board shows no fewer players per screen after than before.
- **Escape every interpolated string.** Build dynamic content with DOM nodes and `textContent`, or with the existing `FC.esc()` helper. Player names come from an external feed.
- **Keyboard reachability and visible focus are preserved.** Anything clickable is operable by keyboard and exposes its state.
- Work on branch `feat/ui-redesign`. `main` stays draft-ready throughout.

---

## File Structure

| File | Responsibility |
|---|---|
| `site/assets/bands.js` | **new.** Pure quantile geometry + the shared/pinned domain rule. No DOM. |
| `tests/bands_fixture.cjs` | **new.** Fixture for the above, including every degenerate case. |
| `site/assets/style.css` | Chassis tokens, type scale, keeper panel, band + expanded-row styles. |
| `site/index.html` | Draft board: gauge rendering, expandable row, expansion state. |
| `site/weekly.html` | Chassis + band (no duplicate Floor/Ceiling). |
| `site/trade.html`, `site/assets/trademode.js` | Verdict hierarchy (presentation only). |
| `site/about.html` | Calibration chart + bake-off chart. |
| `site/assets/app.js` | `bandBar` retired in favour of `bands.js` once all callers move. |

---

### Task 1: Fix the shipped nav bug

Two of four pages have no link to the trade calculator. This is live right now and independent of everything else.

**Files:**
- Modify: `site/weekly.html`, `site/about.html`

- [ ] **Step 1: Confirm the bug**

```bash
for f in index weekly about trade; do printf "%-8s: " "$f"; \
  grep -oE '<a href="(index|weekly|about|trade)\.html"' site/$f.html \
  | sed 's/<a href="//;s/"//' | tr '\n' ' '; echo; done
```

Expected: `weekly` and `about` list only `index weekly about` — no `trade.html`.

- [ ] **Step 2: Add the link to both pages**

In `site/weekly.html` and `site/about.html`, find the `<nav>` block in the masthead. It contains a link to `index.html` followed by one to `weekly.html`. Insert between them, matching the exact markup already used in `site/index.html`:

```html
<a href="trade.html">Trade calculator</a>
```

Keep each page's existing `aria-current="page"` attribute on its own link — do not add `aria-current` to the new link.

- [ ] **Step 3: Verify all four pages agree**

Re-run the Step 1 command. Expected: all four rows read `index trade weekly about`.

- [ ] **Step 4: Commit**

```bash
git add site/weekly.html site/about.html
git commit -m "fix: link the trade calculator from every page"
```

---

### Task 2: `bands.js` — pure quantile geometry

**Interfaces:**
- Produces: `window.Bands` / `module.exports` with `quantileGeometry(p10, p50, p90, domain)`, `sharedDomain(rows, pick)`, `boardDomain(players)`, `RULER_LENSES`.
- Consumed by: Tasks 4, 5, 6.

**Files:**
- Create: `site/assets/bands.js`
- Create: `tests/bands_fixture.cjs`

**Why this is a module and not page code.** Two properties make bands comparable at all: the domain is shared across rows, and it is pinned to one scoring lens. Both currently live inline in `site/index.html:126-131` (and again in `site/weekly.html:63-68`). A refactor that switched either one would break commented, intentional behaviour that **no test can see**. Moving them here makes them testable.

- [ ] **Step 1: Write the failing fixture**

Create `tests/bands_fixture.cjs`:

```js
// tests/bands_fixture.cjs — run with: node tests/bands_fixture.cjs
const assert = require("assert");
const B = require("../site/assets/bands.js");

let n = 0;
const check = (label, fn) => { fn(); n++; };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps,
  `expected ${b}, got ${a}`);

const D = { min: 0, max: 400 };

check("positions are the value's fraction of the domain", () => {
  const g = B.quantileGeometry(100, 200, 300, D);
  near(g.lo, 0.25); near(g.med, 0.50); near(g.hi, 0.75);
  assert.strictEqual(g.ok, true);
});

check("width is hi - lo, not a per-row rescale", () => {
  const g = B.quantileGeometry(100, 200, 300, D);
  near(g.width, 0.5);
});

// THE regression guard. A per-row domain would stretch every player to full
// width and make these two identical -- exactly the bug that destroys the
// comparison the component exists to make. A test checking one row in
// isolation could never catch it.
check("two different players on ONE shared domain differ", () => {
  const gibbs = B.quantileGeometry(63.5, 219.0, 409.3, { min: 0, max: 409.3 });
  const chase = B.quantileGeometry(100.3, 204.3, 315.1, { min: 0, max: 409.3 });
  assert.ok(gibbs.width > chase.width,
    "Gibbs' band must be wider than Chase's on a shared domain");
  assert.ok(gibbs.lo < chase.lo, "Gibbs' floor must sit lower");
});

check("median position reflects real skew, not the midpoint", () => {
  // Bijan, PPR: (226.4-67.8)/(401.0-67.8) = 0.4760...
  const g = B.quantileGeometry(67.8, 226.4, 401.0, { min: 0, max: 401.0 });
  const withinBand = (g.med - g.lo) / (g.hi - g.lo);
  assert.ok(Math.abs(withinBand - 0.476) < 0.001,
    `median should sit at 47.6% of the band, got ${(withinBand * 100).toFixed(1)}%`);
});

check("the ridge touches exactly the three known points", () => {
  const g = B.quantileGeometry(100, 200, 300, D);
  // baseline at lo, apex at med, baseline at hi -- no tails, no curvature.
  assert.strictEqual(g.path, "M 25 100 L 50 0 L 75 100 Z");
  assert.ok(!/[CSQTA]/.test(g.path), "path must be piecewise-linear: no curves");
});

check("zero-width band renders a tick and no fill", () => {
  const g = B.quantileGeometry(200, 200, 200, D);
  near(g.width, 0);
  assert.strictEqual(g.path, null);
  assert.strictEqual(g.ok, true);
  near(g.med, 0.5);
});

check("a median outside its endpoints is reported, never clamped", () => {
  const g = B.quantileGeometry(100, 50, 300, D);   // upstream bug
  assert.strictEqual(g.medianOutside, true);
  near(g.med, 0.125);            // where it ACTUALLY falls
  assert.ok(g.med < g.lo, "must not be clamped into the band");
});

check("missing quantiles give a tick only", () => {
  const g = B.quantileGeometry(null, 200, null, D);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.path, null);
  assert.strictEqual(g.lo, null);
  near(g.med, 0.5);
});

check("a bad domain throws instead of dividing by zero", () => {
  assert.throws(() => B.quantileGeometry(1, 2, 3, { min: 0, max: 0 }), /domain/);
  assert.throws(() => B.quantileGeometry(1, 2, 3, null), /domain/);
});

check("sharedDomain takes one max over ALL rows", () => {
  const rows = [{ q: { p90: 100 } }, { q: { p90: 350 } }, { q: { p90: 200 } }];
  const d = B.sharedDomain(rows, r => r.q);
  assert.strictEqual(d.max, 350);
  assert.strictEqual(d.min, 0);
});

check("sharedDomain falls back to p50 when p90 is absent", () => {
  const rows = [{ q: { p50: 120 } }, { q: { p90: 90 } }];
  assert.strictEqual(B.sharedDomain(rows, r => r.q).max, 120);
});

// The pinned-lens guard. index.html deliberately measures the ruler against
// ONE lens so bars don't rescale when the user toggles PPR/half/standard.
check("boardDomain pins to the league lens, ignoring other lenses", () => {
  const players = [
    { season_points: { league: { p90: 300 }, ppr: { p90: 999 },
                       half_ppr: { p90: 10 } } },
    { season_points: { league: { p90: 250 }, ppr: { p90: 998 },
                       half_ppr: { p90: 20 } } },
  ];
  assert.strictEqual(B.boardDomain(players).max, 300);
});

check("boardDomain falls back to ppr when there is no league lens", () => {
  const players = [{ season_points: { ppr: { p90: 275 } } }];
  assert.strictEqual(B.boardDomain(players).max, 275);
});

// weekly.html holds its quantiles under `points`, not `season_points`, and
// pins its own ruler the same way (weekly.html:66). Without this parameter a
// caller would have to reach for sharedDomain and hardcode a lens, silently
// dropping the pinning on that page.
check("boardDomain reads an alternate key and still pins the lens", () => {
  const players = [
    { points: { league: { p90: 40 }, ppr: { p90: 900 } } },
    { points: { league: { p90: 55 }, ppr: { p90: 800 } } },
  ];
  assert.strictEqual(B.boardDomain(players, "points").max, 55);
});

console.log(`bands_fixture: ${n} groups OK`);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/bands_fixture.cjs`
Expected: FAIL — `Cannot find module '../site/assets/bands.js'`

- [ ] **Step 3: Write the module**

Create `site/assets/bands.js`:

```js
// site/assets/bands.js
/* Quantile band geometry. Pure -- no DOM, no network -- so the node fixture
   can require it. Spec: docs/superpowers/specs/2026-08-09-ui-redesign-design.md

   WHY THIS IS NOT PAGE CODE. Two properties are what make bands comparable
   between rows, and both used to live inline in index.html where no test
   could see them:

     1. THE DOMAIN IS SHARED across every row on screen. A per-row domain
        stretches every player to full width, so a safe player and a volatile
        one look identical -- destroying the only thing the band is for.
     2. THE DOMAIN IS PINNED to one scoring lens, not the active one, so bars
        do not rescale when the user toggles PPR / half-PPR / standard.

   WHAT THE RIDGE MAY ASSERT. Three quantiles do not determine a density. A
   smooth curve drawn through p10/p50/p90 invents mass the model never
   estimated -- the same dishonesty as a flat rectangle, pointed the other
   way. So the path is a piecewise-linear silhouette through exactly the three
   known points: baseline at p10, apex at p50, baseline at p90, nothing
   beyond. Its asymmetry comes only from where the median really sits. */
(function (root, factory) {
  const B = factory();
  if (typeof window !== "undefined") window.Bands = B;
  if (typeof module !== "undefined" && module.exports) module.exports = B;
})(this, function () {

  // First lens present wins. `league` is the owner's actual scoring, which is
  // also the order the board arrives in, so the ruler and the ranking agree.
  const RULER_LENSES = ["league", "ppr"];

  // The path is emitted in a 0..100 box; callers set
  // viewBox="0 0 100 100" preserveAspectRatio="none" and scale with CSS.
  const VIEW = 100;
  const r2 = x => Math.round(x * VIEW * 1000) / 1000;

  function quantileGeometry(p10, p50, p90, domain) {
    const min = domain && Number.isFinite(domain.min) ? domain.min : 0;
    const max = domain && domain.max;
    if (!Number.isFinite(max) || max <= min) {
      throw new Error("bands.js: domain.max must be finite and greater than domain.min");
    }
    const span = max - min;
    const norm = v => (v - min) / span;

    const med = Number.isFinite(p50) ? norm(p50) : null;
    const hasBand = Number.isFinite(p10) && Number.isFinite(p90);

    if (!hasBand) {
      // Preserves bandBar's existing behaviour: tick only, no fill.
      return { ok: false, lo: null, med, hi: null, width: 0,
               medianOutside: false, path: null };
    }

    const lo = norm(p10), hi = norm(p90);
    const width = hi - lo;
    // Reported, never corrected. A median outside its own endpoints is an
    // upstream bug and must stay visible -- clamping it into range would hide
    // exactly the defect the eval harness exists to catch.
    const medianOutside = med !== null && (med < lo || med > hi);

    // Zero width has no shape to draw, and no apex to place.
    const path = (width > 0 && med !== null)
      ? `M ${r2(lo)} ${VIEW} L ${r2(med)} 0 L ${r2(hi)} ${VIEW} Z`
      : null;

    return { ok: true, lo, med, hi, width, medianOutside, path };
  }

  // rows: any array. pick(row) -> {p10,p50,p90}. ONE max over all of them.
  function sharedDomain(rows, pick) {
    let max = 0;
    for (const row of rows) {
      const q = pick(row) || {};
      const top = Number.isFinite(q.p90) ? q.p90 : q.p50;
      if (Number.isFinite(top) && top > max) max = top;
    }
    return { min: 0, max };
  }

  // The page's ruler. Pinned lens, chosen once from the data -- NOT the
  // user's active scoring toggle. `key` exists because the draft board nests
  // quantiles under `season_points` and the weekly page under `points`; both
  // must keep their pinning, so neither caller hardcodes a lens.
  function boardDomain(players, key = "season_points") {
    const first = players && players[0] && players[0][key];
    const lens = RULER_LENSES.find(k => first && first[k]) || "ppr";
    return sharedDomain(players, p => p[key][lens]);
  }

  return { quantileGeometry, sharedDomain, boardDomain, RULER_LENSES };
});
```

- [ ] **Step 4: Run the fixture to verify it passes**

Run: `node tests/bands_fixture.cjs`
Expected: `bands_fixture: 14 groups OK`

- [ ] **Step 5: Confirm nothing else broke**

```bash
for f in tests/*_fixture.cjs; do printf "%-30s " "$(basename $f)"; node "$f" | tail -1; done
```
Expected: every fixture prints OK.

- [ ] **Step 6: Commit**

```bash
git add site/assets/bands.js tests/bands_fixture.cjs
git commit -m "feat: quantile band geometry as a pure, testable module"
```

---

### Task 3: The chassis — tokens, type scale, keeper panel

**Files:**
- Modify: `site/assets/style.css`

Read `site/assets/style.css:1-10` first — the palette already exists and must not change hue. This task **adds** structure around it.

- [ ] **Step 1: Extend the token block**

Replace the `:root` block at `site/assets/style.css:2-10` with:

```css
:root {
  --board: #1B2127;
  --board-raised: #232A31;
  --chalk: #E9E4D8;
  --chalk-dim: #9AA3AB;
  --rule: #39424B;
  --qb: #D64545; --rb: #3FA46A; --wr: #4A90D9; --te: #E8A33D;
  --band-track: #2E363E;

  /* Elevation — these values were previously inlined per rule. */
  --sunken: #161C22;
  --hairline: #1E262D;
  --accent: var(--te);

  /* Spacing step. */
  --s1: .25rem; --s2: .5rem; --s3: .75rem; --s4: 1.1rem; --s5: 1.75rem;

  /* Type scale. */
  --t-display: 700 1.6rem/1 "Barlow Condensed", sans-serif;
  --t-name:    600 1rem/1.15 "Barlow Condensed", sans-serif;
  --t-num:     500 .82rem/1.2 "IBM Plex Mono", monospace;
  --t-label:   600 .62rem/1 "IBM Plex Mono", monospace;
}
```

- [ ] **Step 2: Style the keeper panel**

`grep -c keeper site/assets/style.css` currently returns **0** — the panel at `site/index.html:72-93` renders as a bare `<details>` with default form controls, on the page used during a live draft. Append to `style.css`:

```css
/* -- keeper panel ------------------------------------------------------ */
.keeper-panel {
  background: var(--sunken); border: 1px solid var(--rule);
  padding: var(--s3) var(--s4); margin: var(--s4) 0;
}
.keeper-panel > summary {
  font: var(--t-label); letter-spacing: .13em; text-transform: uppercase;
  color: var(--chalk-dim); cursor: pointer;
}
.keeper-panel > summary::marker { color: var(--rule); }
.keeper-help, .keeper-depletion {
  font: 400 .8rem/1.5 "Source Sans 3", system-ui, sans-serif;
  color: var(--chalk-dim); margin: var(--s2) 0 0;
}
.keeper-load, .keeper-add { display: flex; gap: var(--s2); margin-top: var(--s3); flex-wrap: wrap; }
.keeper-load input, .keeper-add input, .keeper-load select, .keeper-add select {
  background: var(--board); color: var(--chalk);
  border: 1px solid var(--rule); padding: var(--s1) var(--s2);
  font: var(--t-num);
}
.keeper-load button, .keeper-add button {
  background: var(--board-raised); color: var(--chalk);
  border: 1px solid var(--rule); padding: var(--s1) var(--s3);
  font: var(--t-label); letter-spacing: .1em; text-transform: uppercase;
  cursor: pointer;
}
.keeper-load button:hover, .keeper-add button:hover { border-color: var(--chalk-dim); }
/* These print CHANGING values (keepers.js:274,278) in the proportional body
   font, so their digits reflow as numbers update. This is the one surface on
   the site that genuinely needed tabular figures -- the board and weekly
   tables already declare them (style.css `td.num, th.num`). */
.keeper-rec, .keeper-out {
  font: var(--t-num); font-variant-numeric: tabular-nums;
  display: block; padding: var(--s1) 0;
}
.keeper-rec { color: var(--rb); }
.keeper-out { color: var(--chalk-dim); }
```

- [ ] **Step 3: Verify in a browser**

```bash
cd site && python -m http.server 8899
```
Open `http://localhost:8899/index.html`, expand the keeper panel. Expected: panel matches the board's dark chassis — no default white form controls. Console clean.

- [ ] **Step 4: Confirm no regressions**

```bash
for f in tests/*_fixture.cjs; do node "$f" | tail -1; done && python -m pytest -q | tail -3
```
Expected: all fixtures OK, pytest no failures.

- [ ] **Step 5: Commit**

```bash
git add site/assets/style.css
git commit -m "feat: chassis tokens, type scale, and a styled keeper panel"
```

---

### Task 4: Draft board — render the band through `bands.js`

**Files:**
- Modify: `site/index.html` (script tags, domain derivation, band cell)
- Modify: `site/assets/style.css` (band styles)

**Interfaces:**
- Consumes: `Bands.boardDomain`, `Bands.quantileGeometry` from Task 2.

- [ ] **Step 1: Load the module**

In `site/index.html`, add before `<script src="assets/app.js"></script>`:

```html
<script src="assets/bands.js"></script>
```

- [ ] **Step 2: Replace the inline domain derivation**

`site/index.html:126-131` is a three-line comment followed by `const RULER` and `const maxCeil`. Replace that whole block with:

```js
  // The ruler is pinned to one lens and shared across every row -- both
  // properties now live in bands.js where the fixture can see them.
  const domain = Bands.boardDomain(board.players);
```

- [ ] **Step 3: Render the gauge**

In `render()`, replace the `FC.bandBar(...)` call (`site/index.html:166`) with:

```js
      tr.children[6].appendChild(bandCell(s, p.position));
```

Add this helper next to `render`. It builds nodes rather than markup — player-derived values never become HTML:

```js
  const POS_COLOR = { QB: "--qb", RB: "--rb", WR: "--wr", TE: "--te" };

  function bandCell(sp, position) {
    const g = Bands.quantileGeometry(sp.p10, sp.p50, sp.p90, domain);
    const wrap = document.createElement("div");
    wrap.className = "band";
    const pct = x => `${(x * 100).toFixed(3)}%`;

    if (g.ok) {
      const fill = document.createElement("div");
      fill.className = "fill";
      fill.style.left = pct(g.lo);
      fill.style.width = pct(g.width);
      fill.style.background = `var(${POS_COLOR[position] || "--chalk"})`;
      wrap.appendChild(fill);

      const lo = document.createElement("span");
      lo.className = "edge lo";
      lo.textContent = FC.fmt(sp.p10, 0);
      const hi = document.createElement("span");
      hi.className = "edge hi";
      hi.textContent = FC.fmt(sp.p90, 0);
      wrap.append(lo, hi);
    }
    if (g.med !== null) {
      const tick = document.createElement("div");
      tick.className = "tick" + (g.medianOutside ? " outside" : "");
      tick.style.left = pct(g.med);
      wrap.appendChild(tick);
    }
    return wrap;
  }
```

The floor and ceiling numbers become **visible text**, not a `title` tooltip — that is the point of §2 of the spec. Hover text is unavailable on touch and absent from screenshots.

- [ ] **Step 4: Style it**

Append to `site/assets/style.css`:

```css
.band { position: relative; height: 15px; min-width: 150px; }
.band::before {
  content: ""; position: absolute; top: 7px; left: 0; right: 0;
  height: 2px; background: var(--band-track);
}
.band .fill { position: absolute; top: 6px; height: 4px; }
.band .tick { position: absolute; top: 1px; width: 1px; height: 13px; background: var(--chalk); }
/* An out-of-range median is a real upstream defect; make it unmissable. */
.band .tick.outside { background: var(--qb); width: 2px; }
.band .edge {
  position: absolute; top: -2px; font: 500 .58rem/1 "IBM Plex Mono", monospace;
  color: var(--chalk-dim); font-variant-numeric: tabular-nums;
}
.band .edge.lo { left: 0; } .band .edge.hi { right: 0; }
```

- [ ] **Step 5: Verify density did not regress**

Serve `site/`, open the board, and in the DevTools console run before and after:

```js
document.querySelectorAll("#board tbody tr").length
```

Also count rows visible without scrolling. Expected: no fewer than before this task.

- [ ] **Step 6: Run fixtures and commit**

```bash
for f in tests/*_fixture.cjs; do node "$f" | tail -1; done
git add site/index.html site/assets/style.css
git commit -m "feat: draft board bands render through the tested geometry"
```

---

### Task 5: Draft board — the expandable row

**This is the highest-risk task in the plan.** Read this paragraph before writing code.

The board is **not** a static table. Draft mode polls Sleeper every 3 seconds (`site/assets/draftmode.js:9`, `POLL_MS = 3000`); each poll calls `onUpdate` (`site/index.html:214`) → `render(rows)`, and `render` clears the entire tbody before redrawing (`site/index.html:137`). Sorting, the position filter, and the scoring-lens toggle rebuild it the same way. **Expansion state held in the DOM closes the panel every 3 seconds during a live draft** — the exact page and moment the design targets.

**Files:**
- Modify: `site/index.html`
- Modify: `site/assets/style.css`

- [ ] **Step 1: Hold expansion state outside the DOM**

Near the other page state in `site/index.html`, add:

```js
  // Keyed by player_id and re-applied after every render, because render()
  // destroys the tbody -- on each 3s draft-mode poll, and on every sort,
  // filter and lens change. DOM-held state would not survive any of them.
  const expanded = new Set();
```

- [ ] **Step 2: Re-apply it inside `render`**

In `render()`, immediately after `tbody.appendChild(tr);`, add:

```js
      if (expanded.has(p.player_id)) tbody.appendChild(detailRow(p));
```

- [ ] **Step 3: Make the row toggle**

On the player `<tr>`, before appending, add:

```js
      tr.dataset.playerId = p.player_id;
      tr.tabIndex = 0;
      tr.setAttribute("aria-expanded", String(expanded.has(p.player_id)));
```

Bind once, after `render` is defined — delegation on the tbody survives its rebuilds:

```js
  const toggleRow = id => {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    render(rows);
  };
  tbody.addEventListener("click", e => {
    const tr = e.target.closest("tr[data-player-id]");
    if (tr) toggleRow(tr.dataset.playerId);
  });
  tbody.addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-player-id]");
    if (!tr) return;
    e.preventDefault();
    toggleRow(tr.dataset.playerId);
  });
```

- [ ] **Step 4: Build the detail row from DOM nodes**

Player names and teams come from an external feed, so every dynamic value is set with `textContent` and never interpolated into markup.

```js
  // el("div", "cls", "text") -> element. Keeps the builder below readable
  // without ever turning feed data into HTML.
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function kv(label, value) {
    const row = el("div", "kv");
    row.append(el("span", null, label), el("b", null, value));
    return row;
  }

  function detailRow(p) {
    const sp = p.season_points[scoring];
    const g = Bands.quantileGeometry(sp.p10, sp.p50, sp.p90, domain);

    const tr = el("tr", "detail");
    const td = document.createElement("td");
    td.colSpan = 10;
    const grid = el("div", "detail-grid");

    // --- 1. the distribution -------------------------------------------
    const dist = el("div");
    dist.appendChild(el("div", "label", "Season outcome"));
    if (g.path) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "ridge");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", g.path);
      path.setAttribute("fill", `var(${POS_COLOR[p.position] || "--chalk"})`);
      path.setAttribute("fill-opacity", ".45");
      svg.appendChild(path);
      dist.appendChild(svg);
    } else {
      dist.appendChild(el("p", "detail-none", "No band for this player."));
    }
    const cap = el("div", "ridge-cap");
    cap.append(el("span", null, `FLOOR ${FC.fmt(sp.p10, 0)}`),
               el("b", null, `MED ${FC.fmt(sp.p50, 0)}`),
               el("span", null, `CEILING ${FC.fmt(sp.p90, 0)}`));
    dist.appendChild(cap);

    // --- 2. market vs your rank ----------------------------------------
    // 462 of 695 rows have no ADP. Say so in words -- never print a
    // comparison against a value that does not exist.
    const market = el("div");
    market.appendChild(el("div", "label", "Where he goes vs what he's worth"));
    if (p.adp == null) {
      market.appendChild(el("p", "detail-none",
        "No market price — he is undrafted in the ADP sample, so there is "
        + "nothing to compare your rank against."));
    } else {
      market.append(kv("Market ADP", p.adp.toFixed(1)),
                    kv("Your rank", `${p.position_rank} at ${p.position}`),
                    kv("Tier", String(p.tier)));
    }

    // --- 3. the cost of passing ----------------------------------------
    const pass = el("div");
    pass.appendChild(el("div", "label", "If you pass"));
    const next = nextAtPosition(p);
    if (next) {
      const big = el("div", "big", FC.fmt(p.vorp - next.vorp));
      big.appendChild(el("span", "unit", " VORP"));
      const note = el("p", "detail-note");
      note.append(`Next ${p.position} is `, el("b", null, next.name),
                  ` at ${FC.fmt(next.vorp)}.`);
      pass.append(big, note);
    } else {
      pass.appendChild(el("p", "detail-none",
        `Last ${p.position} on the board — nothing behind him.`));
    }

    grid.append(dist, market, pass);
    td.appendChild(grid);
    tr.appendChild(td);
    return tr;
  }

  // `rows` is the full board; the next player at a position is the next one
  // down in VORP order, which is what passing on him actually costs.
  function nextAtPosition(p) {
    const same = rows.filter(q => q.position === p.position)
      .sort((a, b) => b.vorp - a.vorp);
    const i = same.findIndex(q => q.player_id === p.player_id);
    return (i >= 0 && i + 1 < same.length) ? same[i + 1] : null;
  }
```

- [ ] **Step 5: Style it**

```css
tr.detail > td { background: var(--sunken); border-bottom: 1px solid var(--rule); padding: var(--s4); }
.detail-grid { display: grid; grid-template-columns: 1.35fr 1fr 1fr; gap: var(--s5); align-items: start; }
.detail-grid .label { font: var(--t-label); letter-spacing: .14em; text-transform: uppercase; color: var(--chalk-dim); margin-bottom: var(--s2); }
.ridge { width: 100%; height: 54px; display: block; }
.ridge-cap { display: flex; justify-content: space-between; font: 500 .6rem/1 "IBM Plex Mono", monospace; color: var(--chalk-dim); font-variant-numeric: tabular-nums; }
.ridge-cap b { color: var(--chalk); }
.detail-grid .kv { display: flex; justify-content: space-between; padding: var(--s1) 0; border-bottom: 1px solid var(--hairline); font: var(--t-num); font-variant-numeric: tabular-nums; }
.detail-grid .kv b { color: var(--chalk); }
.detail-grid .big { font: 700 1.5rem/1 "Barlow Condensed", sans-serif; color: var(--chalk); font-variant-numeric: tabular-nums; }
.detail-grid .big .unit { font-size: 1rem; color: var(--chalk-dim); }
.detail-note, .detail-none { font: 400 .72rem/1.5 "Source Sans 3", system-ui, sans-serif; color: var(--chalk-dim); margin: var(--s2) 0 0; }
@media (max-width: 800px) { .detail-grid { grid-template-columns: 1fr; gap: var(--s3); } }
```

- [ ] **Step 6: Verify all four rebuild triggers separately**

They share a code path but not a cause; passing one does not imply the others. Serve `site/`, open a row, and confirm it stays open through each:

1. **Sort** — click the VORP header twice.
2. **Position filter** — click RB, then ALL.
3. **Scoring lens** — click PPR, then My league.
4. **Draft-mode poll** — connect draft mode and wait >6 seconds (two poll cycles).

Expected in all four: the panel remains open and its numbers update with the lens. Console clean.

- [ ] **Step 7: Verify keyboard operation**

Tab to a player row, press Enter. Expected: expands, `aria-expanded="true"`, focus ring visible.

- [ ] **Step 8: Run fixtures and commit**

```bash
for f in tests/*_fixture.cjs; do node "$f" | tail -1; done && python -m pytest -q | tail -3
git add site/index.html site/assets/style.css
git commit -m "feat: expandable board rows whose state survives the draft poll"
```

---

### Task 6: Weekly page

**Files:**
- Modify: `site/weekly.html`

The weekly page **already renders Proj (p50), Floor (p10) and Ceiling (p90) as three real columns** (`site/weekly.html:30,36-37`). The band there must not restate them — no edge labels.

- [ ] **Step 1: Load the module**

Add `<script src="assets/bands.js"></script>` before `assets/app.js`.

- [ ] **Step 2: Swap the domain and the band**

Replace the inline `RULER`/`maxCeil` block (`site/weekly.html:63-68`) with:

```js
  // "points", not "season_points" -- weekly nests its quantiles differently.
  // boardDomain keeps the lens pinning this page already had (weekly.html:66
  // picks `league` when present); do NOT hardcode a lens here.
  const domain = Bands.boardDomain(payload.players, "points");
```

Replace the `FC.bandBar(...)` call at `site/weekly.html:86` with a gauge built exactly like Task 4's `bandCell`, but **omitting** the two `.edge` elements, since Floor and Ceiling are already columns.

- [ ] **Step 3: Verify**

Serve and open `weekly.html`. Expected: bands render, no duplicated floor/ceiling numbers, console clean.

- [ ] **Step 4: Commit**

```bash
git add site/weekly.html
git commit -m "feat: weekly bands through the tested geometry"
```

---

### Task 7: Trade page — verdict hierarchy

**Files:**
- Modify: `site/assets/style.css`

**Presentation only.** Do **not** edit `trademode.js`'s copy: the noise disclaimers, ineligibility explanations, and the "comparing two offers needs a 5 pts gap" line (`site/assets/trademode.js:562-580`) were measured and argued for. Restyle, do not rewrite.

- [ ] **Step 1: Give the three numbers hierarchy**

```css
.trade-verdict {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s3);
  font: 700 1.5rem/1.1 "Barlow Condensed", sans-serif;
  font-variant-numeric: tabular-nums;
  padding: var(--s3) 0; border-bottom: 1px solid var(--rule);
}
.trade-verdict strong { font-size: 1.9rem; }
.trade-market { font: var(--t-num); color: var(--chalk-dim); }
.draft-basis { font: 400 .78rem/1.6 "Source Sans 3", system-ui, sans-serif; color: var(--chalk-dim); max-width: 68ch; }
```

- [ ] **Step 2: Verify copy is untouched**

```bash
git diff --stat site/assets/trademode.js
```
Expected: **no output** — the file is unchanged.

- [ ] **Step 3: Verify in a browser**

Load a real league on `trade.html`, build an offer. Expected: your gain is visually dominant, market subordinate, all disclaimer text still present.

- [ ] **Step 4: Commit**

```bash
git add site/assets/style.css
git commit -m "feat: give the trade verdict real hierarchy"
```

---

### Task 8: About page — lead with calibration

**Files:**
- Modify: `site/about.html`

**Coverage is a transformer-only series.** In `site/data/about.json`, `coverage_p10_p90` is populated on the 15 `transformer` rows and **null** on all 15 `xgboost` and 15 `naive_last4` rows — baselines are point predictors with no interval to measure. The calibration chart plots **one** model against the target line. It must not render three series with two empty.

- [ ] **Step 1: Add the calibration section above the prose**

Insert directly after the page `<h1>` an inline-SVG bar chart built from `about.json`: for each `transformer` row with `position === "OVERALL"`, one bar for measured coverage against a reference line at **0.80**. Label each bar with its season and value. Current data yields `2023 0.819`, `2024 0.792`, `2025 0.795`.

Read the values from the payload — **do not hardcode them**; they change when the model is retrained. Build the chart with `document.createElementNS` and `textContent`, consistent with Task 5.

- [ ] **Step 2: Add the bake-off chart**

Below calibration, chart MAE by season for all three models (`transformer`, `xgboost`, `naive_last4`) from the same `bakeoff.json` report — all three have MAE, so all three appear here.

Report whatever the data says, including any season a baseline wins (CLAUDE.md: results are reported honestly whichever model wins).

- [ ] **Step 3: Verify the empty guard**

Confirm the page degrades to a stated absence rather than a blank chart when coverage is missing. Do this against an in-memory copy of the payload in the DevTools console — **do not edit `site/data/about.json`**, which is out of scope.

```bash
git status --short site/data/
```
Expected: **no output**.

- [ ] **Step 4: Verify in a browser and commit**

```bash
git add site/about.html
git commit -m "feat: lead the about page with measured calibration"
```

---

### Task 9: Retire `bandBar` and verify the whole branch

**Files:**
- Modify: `site/assets/app.js`

- [ ] **Step 1: Confirm no callers remain**

```bash
grep -rn "bandBar" site/ tests/
```
Expected: only the definition and the export in `site/assets/app.js`.

- [ ] **Step 2: Remove it**

Delete the `bandBar` function and drop it from the export list at the end of `site/assets/app.js`. Also remove the now-unused `POS_VAR` map if nothing else references it (`grep -rn "POS_VAR" site/`).

- [ ] **Step 3: Full verification**

```bash
for f in tests/*_fixture.cjs; do printf "%-30s " "$(basename $f)"; node "$f" | tail -1; done
python -m pytest -q | tail -3
git status --short site/data/     # must be empty
```

Then in a browser, on all four pages: no console errors, no horizontal scrolling, nav reaches every page.

- [ ] **Step 4: Commit**

```bash
git add site/assets/app.js
git commit -m "refactor: retire bandBar now that bands.js owns the geometry"
```
