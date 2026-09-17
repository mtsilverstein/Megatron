# In-Season Trade Scenario — Design

**Status:** approved 2026-09-17 as the consensus between Claude and astra
(astra's written position: `.review/ASTRA-TRADE-CONSULT-2026-09-17.md`, gitignored;
its conclusions are restated here so this document stands alone).

**Goal:** make `trade.html` useful in season without printing a verdict the model
cannot support. The page shows, for a proposed player trade between two Sleeper
rosters, both sides' week-by-week and remaining-season **starting-lineup change** under
explicit, user-stated availability assumptions — a *conditional lineup scenario*, never
a grade, a winner, a fairness score, or "win/win".

**What this is not.** It is not "option A" (a season mode of the pre-draft grader with
suggestions and a league-wide scan). That is gated behind a roster-level promotion
test described in §8; until it passes, the only in-season output is the scenario
defined here. The pre-draft engine (`trade.js` / `trademode.js`) stays gated in season
exactly as today (`trademode.js:135`): its numbers are differences of state values built
from keeper choice plus a simulated draft, and in season there is no draft.

---

## 1. Decisions, with the reasoning that produced them

| Question | Decision | Why |
| --- | --- | --- |
| Ship A, B or remove the gate? | **B**: wire the conditional engine (`site/assets/seasontrade.js`) into the trade page as the in-season branch. | The engine's requirements — remaining-week league-scored lineups for both sides, explicit drops, unknown ≠ zero, symmetric recomputation — are exactly the accepted list in `docs/inseason-consensus.md` §"Remaining trade work". Removing the gate prints plausible wrong numbers. |
| Overall grade / winner? | **No.** The summed delta is labeled "sum of weekly central lineup scenarios; not a trade verdict". | The player-level evaluation is descriptive, on dependent windows, and reverses in at least one subgroup (RB at h=8). No roster-level test exists yet (§8). |
| 2027 picks | **Shown, not valued.** Selectable so the offer is recorded faithfully; the output states "picks in this offer are not valued". | The slot proxy is a market proxy; rebranding it as our value collapses two currencies the pre-draft UI keeps apart. |
| Keeper effects | **Disclosed and omitted**, and named as the reason no overall grade is shown in Gabagool. | The pre-draft spec measured a 51-point swing for the same player at R11 vs R3 keeper cost; a correct remaining-2026 delta can still be a badly wrong transaction. |
| Suggestions / scan all teams | **Not in this release.** | An optimizer hunts the engine's blind spots (keepers, picks, availability); labels do not neutralize selection bias. |
| Injuries | **Per-player "assume unavailable weeks", v1, user-supplied.** Never auto-filled from an injury tag. | The only honest handling of "my leaguemate wants to dump injured A.J. Brown": the user states the assumption; the tool never predicts a return date. |
| Current week | **Excluded** (engine starts at `max(currentWeek, start_week) + 1`), disclosed on the page. | A trade may process after games start; locking actual contributions is later work. |
| Coverage | **Strict**: every active skill player-week on both rosters, before and after, must be modeled or a bye; otherwise the whole scenario is blocked with the list of gaps. | The waiver desk may exclude an unmodeled bench player from a one-roster swap; in a two-roster comparison that can inflate or reverse the delta. |
| Leagues | Gabagool and FAM (both `in_season`). ESPN stays "not connected". | Both have published `remaining-<slug>.json`; the engine is league-agnostic over Sleeper skill slots. |

## 2. Shared primitive: `site/assets/ros.js`

One exact lineup solver instead of two subtly different ones (astra §6.6). UMD module,
`window.ROS` in the browser, `module.exports` in node, no DOM.

- `SLOT_ELIGIBLE` — `{QB:[QB], RB:[RB], WR:[WR], TE:[TE], FLEX:[RB,WR,TE], SUPER_FLEX:[QB,RB,WR,TE]}`.
- `lineupScore(players, slots, scoreOf)` — moved verbatim from `waivers.js` (the exact
  laminar solver: dedicated positions first, then FLEX from the leftovers, then
  SUPER_FLEX). Players whose `scoreOf(p)` is `null` are skipped; an unfillable slot
  returns `-Infinity`. `waivers.js` calls this and deletes its own copy.
- `bestLineup(players, slots, scoreOf)` — same algorithm, returns
  `{ total, starters: [{ player, slot, points }] }` (or `total: -Infinity, starters: []`
  when unfillable) for display. `seasontrade.js` uses this in place of its private
  `lineup()`; its error `"Roster cannot fill required <slot> slot; no replacement score assumed"`
  is preserved (thrown when `total` is not finite, naming the first unfillable slot).
- `evaluationText(evaluation)` — moved from `waivermode.js` unchanged (the fixture that
  pins it moves to `tests/ros_fixture.cjs`); `waivermode.js` calls `ROS.evaluationText`.

Parity is the acceptance test: `tests/waivers_fixture.cjs` (43 groups) and
`tests/seasontrade_fixture.cjs` must pass unchanged in behaviour, and
`tests/ros_fixture.cjs` brute-forces `lineupScore`/`bestLineup` against an exhaustive
assignment on random rosters for QB/RB/WR/TE/FLEX/SUPER_FLEX shapes.

Pages that load `waivers.js`, `waivermode.js` or `seasontrade.js` load `ros.js?v=1`
first (`waivers.html`, `weekly.html`, `trade.html`); the shared-assets fixture enforces
one version everywhere.

## 3. Engine: `site/assets/seasontrade.js`

Contract unchanged except for §2 (shared solver). Inputs the page must supply, all
already required by `analyze`: `remaining` (published payload), `league` (`/league/<id>`,
must be `in_season`), `rosters` (all of them, fetched ≤ 60 s before `analyze`), `catalog`
(`/players/nfl`), `board` (identity crosswalk only), `rosterIds` (two), `give`,
`receive`, `drops` (per roster id), `excludeWeeks` (per Sleeper id), `currentWeek`
(`/state/nfl`), `assumeAvailable: true` (an explicit acknowledgement), `now`, `snapshotAt`.

The engine's output keeps `advice_eligible: false`, `scenario`, `weeks[]`, `sides[]`,
`assumptions`, `availabilityFlags`, `warnings`, and on a coverage failure throws a
`ProjectionCoverageError` carrying `coverageIssues[{id, name, week, reason}]`.

## 4. Page: `trade.html` in-season branch, controller `site/assets/seasontrademode.js`

### 4.1 Bootstrap (`trade.html` inline script)

1. Resolve the league slug (`FC.leagueNavigation()`); `espnfam` → existing "not
   connected" message.
2. Load the league's board (`FC.leagueDataPath("draft")`) and fetch `/league/<board.league.league_id>`.
3. `status === "pre_draft"` **and** slug `gabagool` → `TradeMode.init(...)` exactly as
   today (the pre-draft page). `status === "pre_draft"` and slug `fam` → today's message.
4. `status === "in_season"` (gabagool or fam) → hide the pre-draft blocks
   (`#trade-controls`, `#trade-cols`, `#trade-grade`, `#trade-suggestions`, the
   pre-draft `.draft-note` and eyebrow) and `SeasonTradeMode.init(...)`.
5. Any other status (`drafting`, `complete`, …) → stamp
   `"Trade tools are available before the draft and during the regular season; this league is <status>."`

### 4.2 Loading

Username → `/user/<name>` → `user_id`. Then in parallel: `/league/<id>/users`,
`/league/<id>/rosters`, `/league/<id>/traded_picks` (may fail → picks shown as "unknown
ownership"), `/state/nfl`, `data/remaining-<slug>.json`, and the Sleeper catalog
`/players/nfl` (session-cached with its fetch time displayed, same as the waiver page).
My roster = the unique roster whose `owner_id` or `co_owners` contains `user_id`; zero
or two matches → `"Could not uniquely match this account to a roster in this league."`

Pre-flight checks before the columns render (each is a named status message, not a
silent default): `league.status === "in_season"`; `remaining` present with
`league.league_id` matching; `state.season === league.season` and
`state.season_type === "regular"`; `remaining.start_week === state.week` (else
`"remaining-season projections are for week <s>, the league is in week <w>; wait for the next refresh"`).
`evaluation` null is allowed (the page then says "no measured evaluation for this
league's scoring").

### 4.3 Columns

Two columns as today ("You give" / "You get"), partner chosen from a select. Rows:

- **Active skill players** (QB/RB/WR/TE on `players` minus `reserve`/`taxi`): selectable.
  Row text: name · position · team · injury tag from the catalog if any (labeled
  "reported tag; no return-date inference").
- **Reserve/taxi players**: listed, disabled, note `"IR/taxi — not tradeable in this version"`.
- **K/DEF**: listed, disabled, note `"no modeled points"`.
- **Future-season picks** (from `Trade.defaultPicks` + `applyTradedPicks`, seasons >
  current): selectable, note `"not valued in season"`.

Each **selected player** gets an inline text field "assume unavailable weeks"
accepting `3-5, 8` style input (parsed by the pure `parseWeeks(text, first, last)`;
invalid input is reported inline and blocks the comparison, never silently ignored).
Any **injury-flagged** active player on either roster, selected or not, also gets the
field, because a tag on a bench player changes both baselines.

An acknowledgement checkbox, unchecked on load:
`"All players not marked unavailable are assumed to play every remaining week."`
The comparison cannot run until it is checked; it maps to `assumeAvailable: true`.

### 4.4 Drops

After each selection change the controller computes each side's post-trade active
roster size against `capacity = roster_positions minus IR/TAXI slots`. A side over
capacity shows `"<team> must drop <n> player(s) to fit this trade"` with checkboxes
over that side's remaining active players (not in the trade). Fewer than `n` chosen
blocks the comparison. Dropped players stay in the *before* lineup and leave the
*after* lineup, so their contribution counts against the trade (engine behaviour).

### 4.5 Compare

Button `"Compare lineups"` (not "Grade", not "Evaluate"). On click the controller
**re-fetches** `/league/<id>/rosters` and `/state/nfl` (the engine requires a snapshot
≤ 60 s old), re-validates that the selected players are still owned as displayed
(otherwise `"Rosters changed since they were loaded — reload the league."`), and calls
`SeasonTrade.analyze(...)`.

Output panel, in this order:

1. Headline label, always present: **`Conditional lineup scenario — not a trade verdict.`**
   Beneath it, one line: `"Sum of weekly central (p50) lineup scenarios for weeks <first>–<end>; week <current> is excluded because trades may process after games start. Keeper value and draft picks are not valued, so no overall grade is shown."`
2. Per side: team name, `before` and `after` remaining-lineup totals and the delta,
   formatted `+12.40` / `−3.10` with a leading sign, two decimals.
3. Week table: week · my before / after / Δ · their before / after / Δ; a week where a
   moved player is excluded or on bye shows `0` with the status word.
4. Assumptions: the exclude-weeks the user entered, per player; the drops per side;
   picks in the offer under `"Not valued: picks"`.
5. Availability flags from the engine (catalog tags) with their `interpretation`.
6. Engine warnings verbatim.
7. Evaluation: `ROS.evaluationText(remaining.evaluation)`.
8. Provenance line: remaining payload `generated_at` / `data_through`, roster snapshot
   time, catalog fetch time, league trade deadline week from `league.settings.trade_deadline`
   if present (`"Trade deadline: week 11 (league setting)"`).

On `ProjectionCoverageError`: the panel shows `"Comparison blocked: <n> player(s), <m> player-week(s) without a projection"` and lists every `{name, week, reason}`; nothing is scored. On any other engine error: the message verbatim under `"Comparison blocked"`.

Words that must not appear in any string the controller's text builders produce
(`scenarioText`, `coverageText`, row notes): `verdict`, `win/win`, `fair`, `winner`,
`accept`, `recommend`, `grade` — with exactly two fixed exceptions, both negations:
the headline `"Conditional lineup scenario — not a trade verdict."` and the sub-line's
`"…so no overall grade is shown."` The fixture asserts the builders' output contains
none of the words outside those two literal sentences.

### 4.6 Copy changes on `trade.html`

- Footer becomes: `"Pre-draft: values players and draft picks before the draft. In season: conditional lineup scenarios only — no trade grades."`
- In-season eyebrow: `"<League> · 2026 week <w> · conditional lineup scenario"`.
- In-season intro note (replaces the pre-draft `.draft-note`): three sentences —
  what the number is (starting-lineup points over the remaining weeks, both sides,
  week by week), what it assumes (participation unless you mark weeks unavailable),
  what it leaves out (keeper value, picks, the current week, injuries not marked).

## 5. Pure, testable pieces of the controller (exported)

- `parseWeeks(text, first, last)` → sorted unique ints within `[first, last]`, or
  throws `"weeks must look like 3-5, 8 and fall within <first>–<last>"`.
- `activeSkill(roster, catalog)` / `capacityOf(league)` / `neededDrops(side)`.
- `identifyRoster(rosters, userId)` → the unique roster or throws the §4.2 message.
- `scenarioText(result, ctx)` → the strings for §4.5 items 1, 2 and 4 (so the
  no-forbidden-words fixture and the sign formatting are tested without a DOM).
- `coverageText(error)` → the blocked-panel strings.

## 6. Fail-closed rules

1. Unknown is never zero — the engine blocks on any unmodeled active player-week on
   either roster; the page shows the gaps and scores nothing.
2. A stale or misaligned payload, a roster snapshot older than 60 s, a league not in
   season, or a `state.week` that does not match `start_week` → no comparison.
3. Exclusions are user assumptions, displayed back verbatim; the page never fills one
   in from an injury tag.
4. Picks and keeper effects are never folded into any number.
5. No word in §4.5's forbidden list appears in the in-season UI.
6. The pre-draft engine is never called for an in-season league.

## 7. Testing

- `tests/ros_fixture.cjs` (new): brute-force parity for `lineupScore` and `bestLineup`
  over random rosters and the six slot shapes; `evaluationText` cases moved from the
  waivermode fixture (plus the null-field case).
- `tests/waivers_fixture.cjs`, `tests/waivermode_fixture.cjs`, `tests/seasontrade_fixture.cjs`:
  pass with the shared solver; seasontrade gains cases for a 2-for-1 with explicit
  drops on the receiving side, a scarce-position roster (one TE), a bye plus an
  exclusion in the same week, and duplicate week rows rejected.
- `tests/seasontrademode_fixture.cjs` (new): `parseWeeks` (ranges, singles, out of
  bounds, junk), `identifyRoster` (owner, co-owner, none, two), `neededDrops`,
  `scenarioText` sign formatting and forbidden-word scan, `coverageText`.
- `tests/trademode_fixture.cjs`: the existing "reject non-predraft leagues" check stays —
  `leagueWorld` is still pre-draft only.
- `tests/shared_assets_fixture.cjs`: `ros.js` version consistent across the three pages.
- Browser check by the user against live Gabagool/FAM rosters (recorded in
  `docs/interface-release-checklist.md` as pending).

## 8. The promotion test that would unlock a grade (not in this release)

Restated from astra's position so the bar is on record: a frozen, roster-aware
retrospective on 2023–2025, origins 5 and 9, horizons 1/2/4/8 — fixed legal roster
portfolios under the league's slots, a frozen set of 1-for-1 / 2-for-1 / 1-for-2 /
2-for-2 packages with explicit overflow drops, predicted two-side lineup deltas vs
realized remaining-week deltas, the four-game mean through the same roster/lineup path,
delta MAE, sign accuracy, decision regret, coverage, subgroups (position scarcity,
depth, uneven trades), a season-origin or roster-pair clustered bootstrap, absences
included as outcomes via postgame participation. Predeclared rule: better overall
error/regret interval than baseline and no material regression in the named
subgroups; the action threshold must exceed the observed trade-delta error and
replaces the pre-draft `MIN_GAIN = 5`. Estimated at two to three engineering days plus
an overnight run. A clean pass converts this page's label into a player-only grade;
suggestions and the league scan stay gated behind a validated market function on top
of that.

## 9. Out of scope

Suggestions and the league-wide scan; pick valuation; keeper premium; a return-date
or availability model; locking started games' actual contributions; ESPN; any change
to the model, the payload builder, or the waiver desk's behaviour beyond calling the
shared solver.
