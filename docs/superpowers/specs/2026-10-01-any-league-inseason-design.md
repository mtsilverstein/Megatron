# Any Sleeper league, phase 1: the in-season pages — design

**Status:** draft 1, 2026-10-01. Approved section by section in conversation; awaiting astra's methodology
review, then the owner's review of this file. No implementation before both, and none merged to `main` before the
`prospective-2026-o5` tag exists (§9).

**Goal:** any Sleeper league — not just Gabagool Fools and FAM FOOTBALL — gets working weekly start/sit, waivers,
in-season trade comparison and rest-of-season projections, scored by its own live settings, with every
simulation-backed output gated on whether *that league's format* was tested.

**Why this shape.** The project's own rule, set after the v1 waiver pass failed to replicate: something that works
in one league is not something that works. Validation is by **format** (`2026-09-30-roster-sim-v2-prospective-design.md`
§4), not by league. Phase 1 makes Gabagool and FAM ordinary leagues that happen to match tested formats, running the
same general code path as everyone else, so our own leagues exercise the general path every week.

---

## 1. Decisions taken (owner, 2026-10-01)

| Question | Decision |
|---|---|
| What does a league outside the five tested formats get? | **Tiered.** Projection-derived tools everywhere, rescored to the league's scoring; simulation-backed outputs only where the format has a gate entry, else "not tested for your format". |
| Scope of phase 1 | **In-season first:** start/sit (`weekly.html`), waivers (`waivers.html`), in-season trade (`trade.html` in-season mode), rest-of-season. Phase 2 (own spec, before Aug 2027): draft board, live draft, keepers, pre-draft trade calculator, ESPN. |
| Architecture | **A — league-neutral data, scored in the browser.** Rejected: B (precompute the N most common rulesets — coverage is whatever N we picked, no backend to fill gaps); C (keep per-league files for our leagues, general path for others — the general path becomes the one we never run). |

## 2. Verified premises

- **Server league points are a linear per-stat rescoring.** `ffmodel.scoring.fantasy_points_quantiles` scores p50
  from the p50 stat frame and p10/p90 as sign-coherent component bands. `site/assets/league-scoring.js` does the
  same arithmetic. Measured 2026-10-01: browser-rescoring every player of `site/data/weekly.json` (Gabagool) and
  `weekly-fam.json` (FAM) from `stat_quantiles` with each file's `sleeper_scoring` reproduces `points.league` for
  **695/695 players, all three quantiles, max |diff| 0.00500** (= the published 2-decimal rounding).
- **Nothing hidden is lost.** The keys the server leaves unscored for those two leagues are exactly the ones the
  browser would also leave unscored: Gabagool `pass_2pt, pass_td_50p, rush_2pt, rush_td_50p, rec_2pt, rec_td_50p,
  fum_rec_td, st_td`; FAM `pass_2pt, rush_2pt, rec_2pt, fum_rec_td, st_td`.
- **Neutral rest-of-season size.** `remaining-gabagool.json` (weeks 4–17, 942 players) has 8,268
  `conditional_projection` rows, 3,978 `unmodeled`, 942 `bye`. Encoding one week's 12 stats × 3 quantiles for 695
  players as compact arrays at 4 decimals is 196 KB raw / 64 KB gzip, so the full neutral file is ≈ 1.6–2.7 MB raw,
  ≈ 0.6–0.9 MB gzip.
- **The prospective test is insulated from `main`.** `tools/prospective_eval.cjs` refuses to evaluate when the
  working tree does not match the freeze manifest ("run the evaluator from the frozen SHA"); the January outcome
  workflow checks out the selected tag; origin 9 builds from the `prospective-2026-o5` tag tree. After that tag
  exists, phase 1 may change frozen files on `main` (including `src/ffmodel/**`, `site/assets/formats.js`).

## 3. Published data (league-neutral)

The weekly Actions job publishes, under `site/data/neutral/`:

| File | Contents |
|---|---|
| `weekly.json` | This week's per-player `stat_quantiles` {p10,p50,p90} × the 12 published stats (today's schema minus the `league` points lens; `ppr`/`half_ppr`/`standard` lenses kept for display). |
| `remaining.json` | Every week from `start_week` to `end_week`: per player-week `status` (`conditional_projection` / `bye` / `unmodeled`), opponent, and for projections the 12-stat × 3-quantile block as compact arrays with the stat order in a header. Stats rounded to **4 decimals**. Same provenance fields as today's `remaining-<slug>.json` (`season, start_week, end_week, generated_at, data_through, forecast_cutoff, input_timing, availability_model, limitations, evaluation`) minus `league`. |
| `players.json` | Crosswalk and league-neutral attributes: model id (GSIS) ↔ Sleeper id, name, team, position, bye, preseason ECR. Today the in-season pages borrow these from the league-specific draft board. |

`site/data/gates.json` (§5.3) is also new. The per-league files `weekly-fam.json`, `remaining-gabagool.json`,
`remaining-fam.json` and the `league` lens in `weekly.json` are retired one week after merge (§9). The draft files
(`draft*.json`) stay, untouched, for phase 2.

**Size budget:** `neutral/remaining.json` ≤ 3 MB raw, enforced by a Python test.

## 4. Scoring lens (browser)

One scorer module takes the league's live `scoring_settings` and classifies every key exactly once:

1. **Scored exactly** — a weight on a stat we predict, including position-specific weights that are linear in a
   predicted stat:
   - the 11 keys `league-scoring.js` already maps (`pass_yd, pass_td, pass_int, pass_int_td, rush_yd, rush_td,
     rush_att, rec, rec_yd, rec_td, fum_lost`);
   - `bonus_rec_te`, `bonus_rec_rb`, `bonus_rec_wr` (extra points per reception for that position);
   - `bonus_rush_td_qb` is **not** assumed linear: classify it after checking Sleeper's definition in the plan
     (verify, don't assert; if it is "points per QB rushing TD" it is exact, otherwise major-unmodeled).
   Scoring becomes position-aware: weights may depend on the player's position.
2. **Unmodeled, minor** (rare events; footnote, as Gabagool/FAM effectively have today): `pass_2pt, rush_2pt,
   rec_2pt, pass_td_40p, pass_td_50p, rush_td_40p, rush_td_50p, rec_td_40p, rec_td_50p, st_td, fum_rec_td, fum`.
3. **Unmodeled, major** (banner on every page: "your league also scores <categories>, which these projections
   leave out; rankings may be off"): first downs (`bonus_fd_*, pass_fd, rush_fd, rec_fd`), completions/attempts
   (`pass_cmp, pass_inc, pass_att, pass_cmp_40p, pass_sack`), reception-length and long-play bonuses (`rec_0_4,
   rec_5_9, rec_10_19, rec_20_29, rec_30_39, rec_40p, rush_40p`), yardage/volume milestones (`bonus_pass_cmp_25,
   bonus_pass_yd_300, bonus_pass_yd_400, bonus_rec_yd_100, bonus_rec_yd_200, bonus_rush_att_20,
   bonus_rush_rec_yd_100, bonus_rush_rec_yd_200, bonus_rush_yd_100, bonus_rush_yd_200`), return yards (`kr_yd,
   pr_yd`), and **any unrecognised offensive-looking key** (fail toward disclosure, mirroring `formats.js`'s
   fail-closed rule).
4. **Ignored** — K, DEF and IDP keys (`formats.js` `IGNORE_EXACT` / `IGNORE_PATTERNS`): out of scope; their slots
   stay "unmodeled; your current starter is kept".

Only nonzero weights classify. Projections are **refused** only when no predicted stat carries a nonzero weight.
Bands keep today's label ("sign-coherent component bands; not calibrated coverage for custom scoring") everywhere.

## 5. League selection, format detection, gating

### 5.1 Which league

- In-season pages accept **any Sleeper league id** via `?league=<sleeper league_id>` (linkable). The legacy slugs
  `?league=gabagool` / `?league=fam` map to their ids. ESPN stays draft-board-only via the registry.
- With a username (the shared session), the picker lists the user's current-season Sleeper leagues
  (`/user/<id>/leagues/nfl/<season>`, already fetched by `connect.js`). Without one, a pasted league link or id
  loads the league read-only; nothing is marked "your roster".
- `session.js` keeps every invariant in its header (immutable bundle, generation tokens, `myRoster` cleared first,
  storage degradation, `Sleeper.get` only). Its league key changes from a registry slug + static board to a
  Sleeper league id for the in-season pages; the draft pages keep the slug flow until phase 2.

### 5.2 What disappears, what stays

Removed for in-season pages: every comparison of a published league contract with the live league (scoring,
roster slots, team count, league id vs board). Scoring and slots come from the live league.

Kept: our-data checks — projections are for the league's season and current week; `generated_at` within today's
age limits (72 h for rest-of-season); every rostered skill player's team has a known kickoff; league `status` is
`in_season` (otherwise a plain message naming the state).

### 5.3 Format detection and gates

- On load the page runs `Formats.match` (exact `format_key` + `compat`, no nearest-format fallback) and shows one
  line: the matched format's description and "(tested)", or "Format: untested — projection tools only".
- Simulation-backed outputs (waiver drop-cost simulation, trade grade, the later experimental display) look up
  `site/data/gates.json`, keyed by `format_key`:
  `{format_key: {label, trade: {status, source}, waiver: {status, source}}}` with `status` ∈
  {`fail`, `conditional_pass`, `conditional_fail`, `inconclusive`}.
- Phase 1 builds `gates.json` with a Python tool from the v1 result (`site/data/trade_sim_eval.json`: Gabagool →
  `f12-1qb-ppr-6`, FAM → `f10-1qb-ppr-6`, mapped by running each league's stored settings through
  `ffmodel.formats`, never by name) — both `fail` for trade and waiver today. January's `sim_gates.json` (schema 3)
  becomes a second input in a later project; phase 1 only guarantees the reader handles every status.
- Display: no entry → "not tested for your format"; `fail` → today's method, failure noted (what Gabagool/FAM show
  now); `conditional_pass` → the labeled experimental display (January at the earliest; not built in phase 1).

## 6. The four pages

### 6.1 One lineup solver

Today three implementations pick lineups: `startsit.js` (FLEX only, nested greedy), `waivers.js` and
`seasontrade.js` (FLEX + SUPER_FLEX). None handles `WRRB_FLEX` or `REC_FLEX`, and with those the eligibility sets
are no longer nested, so greedy assignment is not exact.

Phase 1 replaces all three with one module: an **exact maximum-weight assignment** of players to the league's
starter slots (`roster_positions` minus `BN`, `IR`, `TAXI`), slot eligibility read from `formats.js`
`SLOT_ELIGIBLE` (single source of truth). K/DEF/IDP slots are passed through as unmodeled with the current starter
kept. Tie-break among optimal lineups (to keep today's "no cosmetic swaps"): maximise the number of current
starters kept in their current slot, then lowest player-id order. Locked players (game started, reserve, taxi)
keep today's handling.

### 6.2 Per page

| Page | Behavior |
|---|---|
| Start/sit | Any in-season league. Best-ball leagues (`settings.best_ball = 1`): projections with a note, no start/sit advice. |
| Waivers | FAAB (`waiver_type 2`) and rolling (`0`) as today. **Reverse standings (`1`) — refused today — gets the rolling treatment** (ranked claims, no bids). Shortlist (this-week and rest-of-season lineup gain) everywhere; drop-cost simulation follows the gate. |
| In-season trade | Side-by-side lineup comparison everywhere; grade follows the gate. |
| Rest of season | Rescored from `neutral/remaining.json`. |

### 6.3 Behavior changes for Gabagool and FAM (intentional)

1. **Preseason proxy removed.** When weekly projections are not fresh, waivers today fall back to the draft
   board's league-scored preseason season points ("ROUGH REST-OF-SEASON PRESEASON PROXY"). That value is
   league-scored and preseason-stale by week 5. Phase 1 drops the fallback: stale weekly → the page refuses with
   "projections are stale; wait for the next refresh", as start/sit already does. The "why" column's value
   estimate becomes the rest-of-season p50 sum from `neutral/remaining.json`.
2. **Contract-mismatch refusals disappear** (§5.2): a league that changes its scoring mid-season is rescored
   instead of refused.
3. Everything else — numbers, lineups, shortlists — must be identical (§8 parity tests).

## 7. Out of scope

Draft board, live draft mode, keepers, pre-draft trade calculator, ESPN (phase 2). Any model change. Building the
`conditional_pass` experimental display. Non-Sleeper platforms. Guillotine/other exotic league types beyond a
plain "not supported" message if `settings.type` or roster shape is unrecognised (the plan enumerates).

## 8. Testing

- **Scoring parity:** browser-scored Gabagool and FAM points from `neutral/weekly.json` and every week of
  `neutral/remaining.json` match a Python full-precision reference rescoring within **0.005** per player, quantile
  and week. (4-decimal rounding bounds the error at Σ|w| × 0.00005 ≈ 0.0013 for Gabagool's weights.)
- **Scorer classification:** fixtures for exact (incl. TE premium, per-carry), minor, major, ignored, unknown
  offensive key → major, and the no-predicted-stat refusal.
- **Lineup solver:** equals brute force on seeded random rosters across every slot type (FLEX, SUPER_FLEX,
  WRRB_FLEX, REC_FLEX, K, DEF, IDP slots); reproduces the three old implementations' lineups and totals on
  Gabagool and FAM fixtures before they are deleted; tie-break rule covered.
- **Format + gate:** tested / untested / fail / conditional_pass each render the right label and output.
- **Python:** `neutral/remaining.json` schema and the 3 MB budget; `gates.json` builder maps leagues by settings.
- **No other managers' data in the repo.** League fixtures are synthetic, in Sleeper's response shape. Real
  third-party leagues are used only in live browser checks, never committed.
- **Browser, before merge:** Gabagool and FAM end to end on all four pages, matching today's live site; at least
  one public superflex league and one best-ball league pasted by id.

## 9. Rollout

- Branch `feat/any-league-inseason`. **No merge to `main` until the `prospective-2026-o5` tag exists** (the freeze
  fingerprints `main` until then; §2).
- For one week after merge the weekly Actions job publishes both the old per-league files and `neutral/`; the old
  pages can be restored by a revert with no data gap. Then the old in-season files and the `league` lens are retired.
- The weekly job keeps its fail-safe rule: a failed or incomplete pull publishes nothing new, old or neutral.
