# Site UI Redesign — Design

**Status:** approved 2026-08-09
**Scope:** `site/` only — HTML, CSS, and presentation JS.
**Explicit non-goal:** no data, model, pipeline, or `site/data/*.json` schema changes.

The site already has a deliberate identity (a dark "war-room board": chalk on
slate, Barlow Condensed / IBM Plex Mono / Source Sans 3, position colors, 290
lines of hand-written CSS). This is not a rescue. It is raising an already
competent design, and the main risk is making it louder and worse.

## 1. What "cracked" has to mean here

Three audiences, no compromise between them — each page leads with one:

| page | leads for | must feel |
|---|---|---|
| `about.html` | ML recruiter / engineer | rigorous, calibrated, honest |
| `index.html` | the owner, drafting live | dense, instant, zero hesitation |
| `trade.html` | the owner + leaguemates | decisive, explains itself |
| `weekly.html` | leaguemates | legible at a glance |

Two directions were compared against real board rows and one was chosen:

- **A — trading desk.** Hairline rules, tabular monospace numerals, ruthless
  density. Reads as: this person ships quant tools.
- **B — editorial / data journalism.** Air, big condensed names, the band
  promoted to a real distribution shape. Reads as: this person can explain
  uncertainty.

**Decision: A is the chassis, B is reserved for the moments that matter.** A
third direction (broadcast graphics — oversized names, gradient bars, team
colors) was rejected: it flatters the football audience and undercuts the
recruiter audience, which counts equally.

## 2. The one idea the redesign is built on

The site is named **Floor & Ceiling**. Quantile bands are the model's actual
differentiator and a first-class eval metric (CLAUDE.md). Today they are a
~160px sparkline in a table column, drawn ad hoc on each page.

That is the opportunity — but stated precisely, because the obvious version of
this claim is false. Compare two real rows from the current board:

```
Jahmyr Gibbs    floor  63.5   median 219.0   ceiling 409.3
Ja'Marr Chase   floor 100.3   median 204.3   ceiling 315.1
```

Gibbs can bust to replacement level or win the league outright; Chase is the
safe one. **The current UI already conveys part of this**, and the redesign
must not pretend otherwise: `FC.bandBar` (`site/assets/app.js:33`) scales every
band against one shared `maxCeil` computed across all players
(`site/index.html:131`), so extent is genuinely comparable between rows, and a
tick already marks the median. Chase's bar is visibly shorter than Gibbs'.

Two things are actually missing, and they are what §4 exists to fix:

1. **A bar asserts a uniform interval.** The fill between p10 and p90 is
   flat, which reads as "equally likely anywhere in here" — the one claim a
   quantile model knows to be false. Bijan's median sits at 42% of his
   floor-to-ceiling range; the distribution is skewed, and a rectangle cannot
   show skew or where the mass concentrates.
2. **The numbers exist only on hover.** p10/p50/p90 are in a `title`
   attribute. That is unavailable on touch, invisible when scanning, and
   absent from any screenshot the owner sends a leaguemate or a recruiter.

So the deliverable is not "make the band visible" — it is **make the band
honest about shape, and readable without a mouse.**

## 3. The chassis (A)

Formalize what the CSS currently does by hand.

- **Tokens.** Keep the committed palette (`--board`, `--board-raised`,
  `--chalk`, `--chalk-dim`, `--rule`, position colors, `--band-track`). Add
  the elevation and spacing steps that are presently inlined per rule, so
  panels stop being one-off hex values.
- **Type scale.** A defined ramp rather than per-component font declarations.
  Barlow Condensed for display and names, IBM Plex Mono for all numerics and
  labels, Source Sans 3 for prose. **No new fonts and no new dependencies** —
  all three are already loaded from Google Fonts on every page.
- **Tabular numerals.** `font-variant-numeric: tabular-nums` everywhere a
  number can change. Digits currently reflow as values update, which reads as
  jitter on the draft board and in the trade grade.
- **Density.** Tighter row rhythm and hairline rules. The board must not show
  fewer players per screen than it does today; that is a hard constraint, not
  a preference.

## 4. The band component (B)

One component, one source of truth, three renderings.

```
quantileGeometry(p10, p50, p90, domain) -> { lo, med, hi, path }
```

A **pure function** — no DOM, no globals, no page state. It returns normalized
positions (0..1) plus an SVG path for the ridge rendering.

**`domain` is shared across every row on screen, never per-row.** This
preserves today's behaviour (`maxCeil`, one max over all players) and it is the
property that makes bands comparable at all: a per-row domain would stretch
every player to full width and destroy the Gibbs-vs-Chase distinction the
component exists to show. A fixture asserts that two different players on one
shared domain produce different geometry — the per-row bug would pass any test
that checked a single row in isolation.

Callers:

1. **gauge** — compact, for table rows (draft board, trade columns)
2. **ridge** — the editorial distribution shape (expanded row, about page)
3. **bar** — the weekly page's floor/ceiling columns

Purity is the point: a band that mispositions the median against its own
endpoints is exactly the class of defect this repo's fixtures exist to catch,
and a geometry function that reads the DOM cannot be fixture-tested. This
mirrors the existing split between `trade.js` (pure, node-testable) and
`trademode.js` (the page).

**Degenerate inputs are part of the contract**, not an afterthought: `p10 ==
p90` (zero width), a median outside its own endpoints (upstream bug — must be
visible, never silently clamped into place), and null/absent quantiles. Each
has a defined, tested rendering.

## 5. Draft board — dense by default, editorial on click

Density is unchanged until the user asks for more. Clicking a row expands it
into the B panel:

- the **distribution** (ridge), with floor / median / ceiling labelled;
- **one sentence that reads it in plain language** — e.g. *"A 1-in-10 season
  here is 67.8, replacement level. The same 1-in-10 the other way is 401.0,
  which wins the league. He is not a safe pick; he is a wide one."*;
- **market vs your rank** — ADP against board rank, and the edge between them;
- **the cost of passing** — VORP delta to the next player at that position.

Every value listed already exists in `draft.json` (`vorp`, `season_points.ppr.
{p10,p50,p90}`, `adp`, `tier`, `bye`, `position_rank`). **No new model output,
no regeneration, no pipeline change.**

**Draft mode, sorting, and filtering keep their current behaviour exactly.**
This is the one place the redesign touches shipped, browser-verified
interaction, so it carries its own task and its own verification (§8).

## 6. About page — the recruiter moment

Currently the strongest evidence on the site sits in a table below six
paragraphs of prose. Invert it. Lead with measured calibration, from
`about.json`, which already carries `coverage_p10_p90` per model / position /
season:

```
p10–p90 coverage against an 0.80 target, walk-forward, held-out seasons
2023  0.819        2024  0.792        2025  0.795
```

Then the walk-forward bake-off (transformer vs XGBoost vs naive-last-4) as a
chart rather than a wall of numbers. The prose stays — it is good and it is
honest — but underneath, and scannable.

Reporting stays honest whichever way results land (CLAUDE.md): the charts
render what is in `about.json`, including any position or season where a
baseline wins.

## 7. Trade calculator and weekly

**Trade calculator.** Chassis applied. The verdict's three numbers (your gain,
their gain, market) get real hierarchy instead of one flat line. **All existing
copy is preserved verbatim** — the noise disclaimers, the ineligibility
explanations, the "comparing two offers needs a 5-point gap" line. That copy
was measured and argued for; the redesign restyles it and does not rewrite it.

**Weekly.** Chassis plus the band component.

## 8. Correctness, testing, and the nav bug

**A shipped nav bug is in scope.** `weekly.html` and `about.html` have no link
to the trade calculator — Task 6 of the trade-calculator branch added it only
to `index.html`. Two of four pages currently cannot reach the tool.

| page | index | trade | weekly | about |
|---|---|---|---|---|
| index.html | • | • | • | • |
| trade.html | • | • | • | • |
| weekly.html | • | — | • | • |
| about.html | • | — | • | • |

Testing:

- a **new node fixture** for `quantileGeometry`, including every degenerate
  case in §4;
- **all 8 existing node fixtures and 586 pytest tests stay green** — this work
  changes no logic they cover, so any movement is a regression, not an update;
- **browser verification per page** against the live league, as done for the
  trade calculator: interaction works, console is clean, layout does not
  scroll horizontally;
- the draft board's density (players visible per screen) is measured before
  and after and must not regress.

## 9. Constraints

- Static site: **no framework, no build step, no new runtime dependencies.**
- **No data, model, or pipeline changes.** Nothing here may alter
  `site/data/*.json`, and nothing may touch the weekly Actions run.
- Work happens on a branch; `main` stays draft-ready throughout. The draft is
  ~2026-08-20; if the redesign is not finished, the owner drafts on the
  current, verified UI at no cost.
- Accessibility: keyboard reachability and visible focus are preserved. The
  expandable row is operable by keyboard and exposes its state.

## 10. Out of scope

- Any change to projections, scoring, keeper logic, or trade math.
- The in-season trade tool, K/DST/IDP, DFS.
- Unifying `keepers.js` and the trade page's two valuation currencies — that
  remains the recorded follow-up in the trade-calculator spec §10.2.
- Fixing `Optimizer.finishRoster`'s non-monotone greedy rollout. It is
  documented, bounded under `MIN_GAIN`, and labelled in the UI; replacing it
  would move every number on the draft board and is not a UI task.
