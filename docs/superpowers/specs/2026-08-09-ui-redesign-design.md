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
   quantile model knows to be false. Bijan's median sits at **47.6%** of his
   floor-to-ceiling range ((226.4−67.8)/(401.0−67.8), PPR); the distribution
   is right-skewed, and a rectangle cannot show skew or where mass sits.
2. **On the draft board, the floor and ceiling numbers are hover-only.** p10
   and p90 live in a `title` attribute (`site/assets/app.js:36`); p50 has its
   own column. Hover text is unavailable on touch, invisible when scanning,
   and absent from any screenshot the owner sends a leaguemate or recruiter.
   **This applies to the draft board only** — `weekly.html` already renders
   Proj/Floor/Ceiling as three real columns (`site/weekly.html:30,36-37`), so
   the band there must not restate them.

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
- **Tabular numerals — extend, do not "add".** The board and weekly tables
  already declare `font-variant-numeric: tabular-nums` on `td.num, th.num`
  (`style.css:80`) and again at `:197`, in IBM Plex Mono, so those digits do
  **not** reflow today. The surface that actually needs it is the **keeper
  panel**, which prints changing `+N.N pts` values (`keepers.js:274,278`) in
  the proportional body font.
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

**`domain` is shared across every row on screen, never per-row**, and it is
**computed from one pinned scoring lens, not the active one.** Both properties
preserve deliberate existing behaviour: `maxCeil` is one max over all players
(`site/index.html:131`), taken from `RULER` — the league lens, falling back to
PPR — with a comment stating the intent, "a stable ruler across scoring
toggles, so bars don't rescale when you switch format."

A per-row domain would stretch every player to full width and destroy the
Gibbs-vs-Chase distinction the component exists to show. A domain computed
from the *active* lens would make every band jump when the user toggles
PPR/half-PPR/standard. Neither is covered by an existing test, so both get
fixtures: two different players on one shared domain must produce different
geometry, and the same player under two lenses must produce the same domain.

### What the ridge may and may not assert

Three quantiles do not determine a density. A smooth bell drawn through p10 /
p50 / p90 invents mass the model never estimated — precisely the dishonesty §2
objects to in the flat bar, in the opposite direction.

So the ridge is defined as a **piecewise-linear silhouette through exactly the
three known points** — baseline at p10, apex at p50, baseline at p90, straight
segments between, no tails beyond the endpoints and no curvature implying
sub-quantile structure. It is a shape that says "the middle is here and the
mass leans this way," and nothing more. Its asymmetry comes only from the
median's real position within the interval. Any rendering that extends past p10
or p90 is out of contract.

Callers:

1. **gauge** — compact, for table rows (draft board, trade columns)
2. **ridge** — the editorial distribution shape (expanded row, about page)
3. **bar** — the weekly page's floor/ceiling columns

Purity is the point: a band that mispositions the median against its own
endpoints is exactly the class of defect this repo's fixtures exist to catch,
and a geometry function that reads the DOM cannot be fixture-tested. This
mirrors the existing split between `trade.js` (pure, node-testable) and
`trademode.js` (the page).

**Degenerate inputs are part of the contract**, not an afterthought. Each has
a defined, tested rendering:

- **`p10 == p90`** (zero width) — collapse to a single median tick, no fill.
  Must not divide by zero or render a full-width band.
- **median outside its own endpoints** — an upstream bug. Render it where it
  actually falls, outside the fill, so it is visible. **Never silently clamp
  it into range**; clamping hides the defect that the eval harness exists to
  catch.
- **null / absent quantiles** — preserve `bandBar`'s existing behaviour
  exactly (`app.js:36,40`): median tick only, no fill. Note this path is
  **currently unreachable from published data** — 0 of 695 draft rows and 0 of
  615 weekly rows have a null p10/p50/p90 — so it cannot be verified against
  the live board and must be covered by fixture alone. It is retained rather
  than dropped because `bandBar` already implements it and a future
  non-projectable player would otherwise crash the geometry.

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

### Expansion state must survive the poll — the load-bearing requirement

The draft board is **not** a static table. Draft mode polls Sleeper every 3
seconds (`draftmode.js:9`, `POLL_MS = 3000`); every poll calls `onUpdate`
(`site/index.html:214`), which calls `render(rows)`, and that function clears
the whole tbody before redrawing (`site/index.html:137`). Sorting, position
filters and scoring-lens changes rebuild the tbody the same way.

So the naive implementation — expansion state held in the DOM — **closes the
open panel every 3 seconds during a live draft**, on exactly the page and in
exactly the moment §1 designs for. This is the single highest-risk item in the
redesign.

Requirement: expansion state lives **outside the DOM**, keyed by `player_id`,
and is re-applied after every render. It must survive a draft-mode poll, a
sort, a position filter change, and a scoring-lens change. Each of those is
verified explicitly (§8), not inferred from one of them working.

### Degrading when the data isn't there

Two of the four panel bullets can hit missing inputs, and they degrade
differently:

- **Market vs your rank** — **462 of 695 rows have `adp: null`.** For those the
  panel says so in words; it must never print a comparison against an absent
  value or imply a market rank that does not exist. This follows the rule
  already shipped in `trademode.js` for the same situation.
- **Cost of passing** — safe. Only 4 of 695 rows have `vorp` exactly 0; 595 are
  negative (below replacement) and 96 positive, so the delta to the next player
  at a position is meaningful essentially everywhere. No special case needed
  beyond the last player at a position, which has no next.

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

**Coverage is a transformer-only series.** In `about.json`,
`coverage_p10_p90` is populated on the 15 `transformer` rows and null on all
15 `xgboost` and 15 `naive_last4` rows — the baselines are point predictors
and have no interval to measure. The calibration chart therefore plots one
model against the target line; it must not render three series, two of them
empty. (`about.html` already guards this with its `hasQ` check.)

The walk-forward bake-off — transformer vs XGBoost vs naive-last-4, which
*do* all have MAE — is a separate chart, and the place all three models
appear.

The prose stays — it is good and it is honest — but underneath, and scannable.

Reporting stays honest whichever way results land (CLAUDE.md): the charts
render what is in `about.json`, including any position or season where a
baseline wins.

## 7. Trade calculator and weekly

**Trade calculator.** Chassis applied. The verdict's three numbers (your gain,
their gain, market) get real hierarchy instead of one flat line. **All existing
copy is preserved verbatim** — the noise disclaimers, the ineligibility
explanations, the "comparing two offers needs a 5-point gap" line
(`trademode.js:562-580`). That copy was measured and argued for; the redesign
restyles it and does not rewrite it.

**Weekly.** Chassis plus the band component — without duplicating the Floor and
Ceiling columns that already exist there (§2).

**Keeper panel — in scope.** `grep -c keeper site/assets/style.css` returns
**0**: the panel at `site/index.html:72-93` (`.keeper-panel`, `.keeper-help`,
`.keeper-depletion`, `.keeper-load`, `.keeper-add`, `.keeper-rec`,
`.keeper-out`) has no styling at all and renders as a bare `<details>` with
default form controls. It sits on the draft board — the owner's live-draft
surface — so a chassis rollout that skipped it would ship a visibly
inconsistent page. Styling only: **no change to keeper logic, costs, or
eligibility**, and the two-currencies divergence stays out of scope (§10).

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

- a **new node fixture** for `quantileGeometry`, covering every degenerate case
  in §4, the shared-domain property, and the pinned-lens property;
- **all 8 existing node fixtures stay green, and `python -m pytest` reports no
  failures** — expressed as the command, not a count, since collection totals
  drift. This work changes no logic those tests cover, so any movement is a
  regression, not an update;
- **the expanded row is verified against all four rebuild triggers
  separately** — draft-mode poll, sort, position filter, scoring lens — since
  they share a code path but not a cause, and passing one does not imply the
  others;
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
