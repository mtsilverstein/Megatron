# Any Sleeper league, phase 1: the in-season pages — design

**Status:** draft 2, 2026-10-03. Draft 1 was agreed with the owner section by section on 2026-10-01; astra's
methodology review (`.review/astra-anyleague-spec-response.md`, gitignored, verdict REVISE: 4 blockers, 9 important,
3 minor) is resolved here, each finding traced in §12. Next: astra re-check, then the owner's review. No
implementation before both, and nothing merged to `main` before the `prospective-2026-o5` tag exists (§10).

**Goal:** any Sleeper league — not just Gabagool Fools and FAM FOOTBALL — gets working weekly start/sit, waivers
and in-season trade comparison (with rest-of-season projections inside the last two), scored by its own live
settings. No number is shown as measured evidence unless it was measured under that league's scoring, and no
simulation-backed output runs for anyone until a format has passed a test.

**Why this shape.** The project's own rule, set after the v1 waiver pass failed to replicate: something that works
in one league is not something that works. Validation is by **format** (`2026-09-30-roster-sim-v2-prospective-design.md`
§4). Phase 1 makes Gabagool and FAM ordinary leagues on the same general code path as everyone else.

---

## 1. Decisions taken (owner, 2026-10-01)

| Question | Decision |
|---|---|
| What does a league outside the tested formats get? | **Tiered.** Projection-derived tools everywhere, rescored to the league's scoring; simulation-backed outputs only under a passed, exactly matching test. |
| Scope of phase 1 | **In-season first:** `weekly.html` (start/sit), `waivers.html`, `trade.html` in-season mode. Rest-of-season appears inside waivers and trade (there is no standalone ROS page). Phase 2 (own spec, before Aug 2027): draft board, live draft, keepers, pre-draft trade calculator, ESPN. |
| Architecture | **A — league-neutral data, scored in the browser.** Rejected: B (precompute common rulesets — coverage is whatever we picked; no backend), C (per-league files for our leagues, general path for others — the general path becomes the one we never run). |

## 2. Verified premises

- **The arithmetic matches.** `ffmodel.scoring.fantasy_points_quantiles` scores p50 linearly from the p50 stat frame
  and p10/p90 as sign-coherent component bands; `site/assets/league-scoring.js` does the same arithmetic for its
  supported keys. With unsupported keys filtered out first (the existing scorer *throws* on them, e.g.
  `Unsupported scoring category: pass_2pt`, so the new adapter's classification step is required), browser
  rescoring of `site/data/weekly.json` (Gabagool) and `weekly-fam.json` (FAM) reproduces `points.league` for
  695/695 players, all three endpoints, max |diff| 0.004998 (the published 2-decimal rounding). Verified twice
  (2026-10-01, and independently by astra 2026-10-03).
- **Offensive omissions are the same both ways.** The nonzero *offensive* keys the server leaves unscored —
  Gabagool `pass_2pt, pass_td_50p, rush_2pt, rush_td_50p, rec_2pt, rec_td_50p, fum_rec_td, st_td`; FAM `pass_2pt,
  rush_2pt, rec_2pt, fum_rec_td, st_td` — are exactly what the browser would leave unscored. K/DEF keys are ignored
  on both sides. This is parity with the server's supported projection subset, not with complete Sleeper scoring.
- **Size is an estimate, not yet a bound.** Today's `remaining-gabagool.json` (weeks 4–17, 942 players) has 8,268
  `conditional_projection` rows. One week's numeric stat blocks at 4 decimals measure 179–196 KB raw / 60–64 KB gzip
  depending on encoding; extrapolated, ≈ 2.1 MB raw / 0.7 MB gzip before ids, statuses and metadata. The real bound is
  measured at week 1, full horizon, before the cap is fixed (§3.3).
- **The prospective test is insulated from `main` once the o5 tag exists** — for its *code*, not its orchestration.
  `tools/prospective_eval.cjs:524-538,657-664` refuses a real evaluation whose working tree does not match the
  freeze manifest; origin 9 builds from the o5 tag (`prospective-freeze.yml:74-109`); the outcome workflow checks out
  the selected tag (`prospective-outcomes.yml:63-89`). But workflow YAML, setup steps and
  `tools/select_outcome_tag.py` run from `main` before checkout. **Phase 1 does not touch**
  `.github/workflows/prospective-*.yml`, `tools/select_outcome_tag.py`, `tools/prospective_*.cjs`,
  `src/ffmodel/prospective/**`, or `site/assets/rostersim.js` / `ros.js` (`bestLineup`, `lineupScore`). The January
  evaluation is "o5 code plus verified o9 artifacts and outcomes", never "check out the latest tag".

## 3. Published data (league-neutral)

### 3.1 Files

The weekly Actions job publishes one **neutral batch** under `site/data/neutral/`:

| File | Contents |
|---|---|
| `weekly.json` | This week's per-player `stat_quantiles` {p10,p50,p90} × the 12 published stats at **full precision** (as today), the `ppr`/`half_ppr`/`standard` display lenses, `pick_six_forecast` provenance, `stat_projection_schema`. No `league` lens. |
| `remaining.json` | Weeks `start_week`..`end_week`: per player-week `status` (`conditional_projection` / `bye` / `unmodeled`) with reason, opponent, and for projections the stat block as compact arrays `[quantile][stat]` (stat order and `schema_version` in a header; p10/p90 may be `null` for point-only predictors). Stats rounded to 4 decimals. Provenance fields as today's file minus `league` and minus `evaluation` (moved to §3.2). |
| `players.json` | The player universe (§3.4): GSIS id ↔ Sleeper id, name, team, scoring position, bye week, preseason ECR with `{source, date, scoring}` provenance (nullable). |
| `evaluation.json` | Measured-evidence records (§3.2). |

All four are produced from **one validated input snapshot** and must share `season`, `week`, `data_through` and
`generated_at` batch id.

### 3.2 Evidence is scoped to the scoring it was measured under

Today's `remaining-<slug>.json.evaluation` holds point-scale MAEs measured against a league-scored baseline
(`src/ffmodel/site/remaining.py:17-61`; e.g. Gabagool horizon-1 MAE 4.612 vs baseline 4.815), and `weekly.html`
hardcodes a 56.3% close-call rate and an "≈80% of player-weeks inside the band" calibration claim. None of these
transfers to other scoring — even a uniform multiplier changes an MAE.

`evaluation.json` therefore holds records `{id, kind, scoring_fingerprint, scoring_description, method, scope,
values, source}` where `scoring_fingerprint` is the canonical fingerprint of the full offensive scoring the number
was measured under (the `format_key` predicted-weights part plus `compat`, via `ffmodel.formats` — the same canonical
JSON, without team/slot fields). A page shows a measured number **only** when the live league's scoring fingerprint
equals the record's; otherwise it shows "no measured evaluation for your league's scoring". The weekly page's
close-call and calibration copy becomes data-driven the same way. The plan verifies, from each source artifact, which
scoring each existing claim was measured under before writing its record. No new fantasy-point error is derived
from per-stat errors.

### 3.3 Precision, size, horizon

- Ranking and comparisons use **unrounded** scored values; rounding happens only for display. Python/JS parity is
  checked per league against a full-precision Python reference with tolerance
  `0.00005 × Σ|effective stat weight|` per endpoint for `remaining.json` (4-decimal stats) and 1e-9 for `weekly.json`.
- Horizon: the model's published horizon, `start_week`..17. Leagues whose season runs into week 18 get a disclosed
  truncation ("projections stop at week 17"). Simulation, if ever enabled, stays within its measured horizon.
- Size: the plan measures the full serialized `remaining.json` at week 1 with the maximum player universe; the cap is
  set to that measurement × 1.25 and enforced by a test and by the generator. **Oversize fails the batch**; players or
  weeks are never dropped to fit.

### 3.4 Player universe

`players.json` is generated independently of the draft board, VORP, tiers and keeper logic, from the Sleeper player
catalog and the existing GSIS↔Sleeper crosswalk code (`src/ffmodel/data/sleeper.py`, with its ambiguity handling).
Universe = union of players in `weekly.json`, `remaining.json`, and every QB/RB/WR/TE in the Sleeper catalog on an
NFL team. Validation: one-to-one GSIS↔Sleeper mapping (ambiguity → that player is identity-only, never priced),
team and position agreement between sources, nullable ECR/bye. Players with no projection stay "unknown", never 0.

This **expands coverage**: today 31 weekly and 304 remaining-payload players are absent from Gabagool's 698-player
board. That is an intentional change, tested separately from numeric parity (§9).

### 3.5 Publication

- The neutral batch is staged, validated as a whole (schema, ids, shared batch fields, size cap), and published only
  if every file succeeds; any failure leaves the previously published neutral batch untouched. Today's fail-soft
  remaining-season path (`generate.py:724-742`) does **not** apply to the neutral batch.
- Optional reference feeds (weekly/ROS ECR) stay optional and outside the batch, as today.
- During coexistence (§10) the legacy per-league files keep today's behavior.

## 4. Scoring lens (browser)

One scorer module classifies every nonzero key of the live `scoring_settings`, then **combines weights per
(predicted stat, scoring position) before building bands**. For a TE with reception quantiles (2,5,8), `rec = −1`
and `bonus_rec_te = +2` give an effective weight +1 and band (2,8), not the (−4,14) that per-key min/max would give.
Opposing, cancelling and zero effective weights are tested. Weights must be finite numbers; position must be one of
QB/RB/WR/TE from `players.json`; missing stats or malformed bands refuse that player, not the league.

| Class | Keys | Display |
|---|---|---|
| **Linear (supported)** | `pass_yd, pass_td, pass_int, rush_yd, rush_td, rush_att, rec, rec_yd, rec_td, fum_lost`; `bonus_rec_te/rb/wr` (per-reception, by the player's scoring position, not the slot) | — ("linear" describes the formula, not forecast accuracy) |
| **Supported, approximation disclosed** | `pass_int_td` → `passing_pick_sixes`, a prior-based expectation added equally at every endpoint (`src/ffmodel/site/pick_sixes.py`) | footnote: "pick-sixes use an average rate, not a forecast" |
| **Omitted, rare-event** | `pass_2pt, rush_2pt, rec_2pt, pass_td_40p, pass_td_50p, rush_td_40p, rush_td_50p, rec_td_40p, rec_td_50p, st_td, fum_rec_td` | footnote when every such weight is within common bounds (2-pt ≤ 2, long-TD bonus ≤ 3, return/fumble-recovery TD ≤ 6, absolute values); otherwise the banner |
| **Omitted, recurring** | `fum`; first downs (`bonus_fd_*, pass_fd, rush_fd, rec_fd`); `pass_cmp, pass_inc, pass_att, pass_cmp_40p, pass_sack`; `rec_0_4, rec_5_9, rec_10_19, rec_20_29, rec_30_39, rec_40p, rush_40p`; milestones (`bonus_pass_cmp_25, bonus_pass_yd_300/400, bonus_rec_yd_100/200, bonus_rush_att_20, bonus_rush_rec_yd_100/200, bonus_rush_yd_100/200`); `kr_yd, pr_yd`; `bonus_rush_td_qb` until its meaning is verified from Sleeper's own documentation (then linear by position if it is per QB rushing TD); **any unrecognised offensive key** | banner on every page: "your league also scores <categories>, which these projections leave out; rankings may be off for your league" |
| **Ignored** | K, DEF, IDP keys (`formats.js` `IGNORE_EXACT` / `IGNORE_PATTERNS`) | slots shown as "not projected; your current starter is kept" |

A threshold on a median is not an expected milestone bonus, so milestones are never approximated. Projections are
refused only when no predicted stat has a nonzero effective weight for any position. Bands keep today's label
("sign-coherent component bands; not calibrated coverage for custom scoring").

## 5. League selection and lifecycle

### 5.1 Which league, whose roster

- In-season pages accept any Sleeper league id via `?league=<sleeper league_id>`; the legacy slugs `gabagool` / `fam`
  resolve to their ids.
- With a username (the shared session), the picker lists the user's current-season Sleeper leagues; the user's
  roster is found by the existing exact owner/co-owner matcher.
- Without a username, a pasted league link or id loads the league **read-only**. The user may choose any team to
  view; the page says "Viewing <team name>", never "your roster", and every roster-owner phrase is reworded.
- `session.js` keeps every invariant in its header (immutable bundle, generation tokens, `myRoster` cleared first,
  storage degradation, `Sleeper.get` only). Its league key becomes a Sleeper league id for the in-season pages; a new
  anonymous bootstrap path loads a league without identity or board.

### 5.2 Live settings lifecycle

Every load and every refresh refetches the **league object** (today a roster-only refresh reuses it,
`session.js:265-274`, and the trade controller keeps the original league in a closure, `seasontrademode.js:292-296`).
When scoring, roster slots, status or season change, the page atomically recomputes scoring classification, format
line, eligibility and analysis, and supersedes any outstanding work. The settings timestamp is shown with the data
timestamps.

### 5.3 Checks: removed and kept

Removed: comparisons of a published league contract with the live league (scoring, slots, team count, league id vs
board, `waiver_type` restriction for start/sit).

Kept: projections are for the league's season and current week; age limits as today (7 days weekly, 72 h
remaining); league `status` is `in_season`, else a plain message naming the state; every rostered skill player has
either a declared bye or kickoff coverage (a declared bye is not "missing coverage"); live roster completeness,
unique ownership, reserve/taxi handling and capacity.

### 5.4 Navigation boundary with the draft pages

- Between in-season pages the canonical parameter is the league id.
- Entering a draft-side page (index, trade pre-draft mode, keepers): a known owner league id maps to its registry slug;
  any other id shows "the draft board is only built for registered leagues" — never a substituted league.
- `trade.html` decides pre-draft vs in-season mode **before** fetching any draft data.
- `connect.js` lists every current-season league with in-season links; `about.html` and the identity chip use the
  same rules. ESPN keeps its registry route.

## 6. Format, eligibility and simulation

### 6.1 Format line

On load the page runs `Formats.match` (exact `format_key` + `compat`) and shows one line:
"Format: 12-team 1QB PPR, 6-pt pass TD — in the 2026 format test (results January 2027)" or "Format: not in the
format test". **"In the test" is not "tested".** Best-ball leagues and leagues with IDP or other unrecognised slots
can share a `format_key` with a grid format (`Formats.describeSleeper` ignores `best_ball` and `type`), so the line
also runs a separate **eligibility check**: managed-lineup redraft/keeper/dynasty leagues with only recognised slots
are eligible for a simulation verdict; best-ball leagues and leagues with unrecognised slots never are.

### 6.2 Simulation outputs are off in phase 1

The v1 verdicts cannot be relabeled as format results. v1 drafted synthetic rosters of 15 offensive players
(`trade_sim_eval.json.gz`: rounds 15, roster size 15 for both leagues), while the grid formats Gabagool and FAM
match (`f12-1qb-ppr-6`, `f10-1qb-ppr-6`) have 13 offensive roster spots. So phase 1:

- removes the per-league v1 gate path (`waivers.js:192-200`, `seasontrademode.js:127-151`);
- shows simulation-backed outputs (drop-cost simulation, trade grade) to **no one**, with the note "simulation is
  off: the 2025-season test failed (on synthetic 15-player rosters), and the per-format 2026 test reports in
  January 2027" — a product decision, stated as one, not a measured failure of the live league's format;
- publishes **no gate file**. The January project defines it from the v2 schema-3 records, under these
  requirements: records carry `format_key`, canonical `compat`, feature, method/engine identity and evidence scope;
  authorization requires a unique full-record match plus §6.1 eligibility; missing, malformed, duplicate,
  unknown-status, `conditional_fail`, `inconclusive` and not-yet-built `conditional_pass` displays all stay closed.

Today both v1 gates are already closed, so Gabagool and FAM see no loss — only the note's wording changes.

## 7. The three pages

### 7.1 Shared lineup kernel

Today start/sit has its own greedy solver (`startsit.js`, FLEX only) and waivers/trade/simulation share
`ROS.bestLineup` / `ROS.lineupScore` (`ros.js`, FLEX + SUPER_FLEX, ties broken by input order). Neither handles
`WRRB_FLEX` / `REC_FLEX`, where eligibility sets stop being nested and greedy assignment is not exact.

Phase 1 adds one kernel module, used by start/sit, waivers and in-season trade. `rostersim.js` keeps calling
`ROS.bestLineup`, unchanged: its lineup policy is part of the method the prospective test freezes.

- **Input:** ordered slot list (indices), each with an eligibility set from `formats.js` `SLOT_ELIGIBLE`; candidate
  players with unique ids, scoring position and score (may be negative); fixed assignments (slot index → player);
  unmodeled slots (K/DEF/IDP) with their current occupant, which reserves that player and the slot's capacity;
  current starters by slot index.
- **Objective, lexicographic:** (1) maximise the total score of modeled slots; (2) maximise the number of current
  starters kept in their exact current slot index; (3) the lexicographically smallest vector of player ids in slot
  order (string comparison). No epsilon perturbation of scores.
- **Validation:** duplicate occupants, a fixed player ineligible for its slot, or an infeasible required lineup →
  refuse with a reason; never a partial sum. (Today `startsit.js:59` can place one player in two slots.)
- **Caller policies stay explicit and separate** (shared kernel, not shared preprocessing):
  - start/sit (current week): exclude declared bye, user-excluded, IR, taxi; game-started slots fixed; an unfillable
    active slot refuses;
  - waivers (current week + rest of season): owned unavailable/bye players allowed at 0; started slots removed and
    their fixed contributions cancelled from transaction deltas; unknown-projection members excluded with a warning;
  - trade (future weeks only): current week skipped; bye/unavailable candidates at 0; missing projection coverage
    refuses.

### 7.2 Per page

| Page | Behavior |
|---|---|
| Start/sit | Any in-season league. Best ball: projections with a note, no start/sit advice. |
| Waivers | FAAB (`waiver_type 2`) and rolling (`0`) as today; reverse standings (`1`, refused today) shares the non-dollar ranking mechanics, labeled "reverse-standings waivers", without claiming its priority rules. FAAB reserve default = 20% of the league's budget, rounded to whole dollars (Gabagool's $100 → $20, unchanged; the plan verifies the budget). Shortlist (this-week and rest-of-season lineup gain) everywhere; rest-of-season shown as "sum of weekly medians, not a season median". |
| In-season trade | Side-by-side lineup comparison everywhere. **Future draft picks are removed** from the in-season asset list: they came from `Keepers.DRAFT_ROUNDS` (Gabagool's 15 rounds × 2 seasons, `seasontrademode.js:467-478`) and were never valued. |

Point thresholds (start/sit 3-pt close call; waivers 1-pt weak signal, 2/5-pt FAAB bands) stay, labeled as
heuristics in the league's own points. Weekly and ROS ECR stay labeled as PPR reference rankings on every league.

## 8. Behavior changes for Gabagool and FAM (intentional, enumerated)

Replaces draft 1's "everything else identical", which the current code cannot satisfy (its two solvers break ties
differently: astra's counterexamples, review §B4).

1. Lineup ties resolve by §7.1's rule (affects only equal-score alternatives; totals unchanged).
2. The waiver shortlist's tie-break and "why" value change from the board's `value_points` (an ECR-ordered value
   curve, not the player's own projection) to the rest-of-season p50 sum; this can change which rows survive the
   40-row cut.
3. More players are in scope (§3.4).
4. Remaining-season stats are 4-decimal; a few published cents can differ (astra: 47 of 2,085 weekly endpoints at
   4-decimal stats), while comparisons use unrounded values.
5. The dead preseason-proxy code path is removed (already unreachable for in-season leagues: `waivers.js:384-385`,
   `waivermode.js:29`).
6. Contract-mismatch refusals disappear; a mid-season scoring change is rescored, not refused.
7. Future picks leave the in-season trade page; v1 gate note rewording; evaluation numbers appear only under their
   measured scoring (Gabagool's and FAM's own numbers still appear for them if measured under their scoring).

## 9. Testing (acceptance criteria)

1. **Scoring:** Python/JS parity per §3.3 on Gabagool and FAM, for weekly and every remaining week, using an
   independent Python reference scorer (Python `ScoringRules` has no per-carry or position bonus fields). Fixtures:
   position bonuses, opposing/cancelling weights, `pass_int_td` disclosure, null bands, missing stats, every class in
   §4 including unknown keys and the no-predicted-stat refusal.
2. **Kernel:** equals brute force on seeded random rosters across FLEX, SUPER_FLEX, WRRB_FLEX, REC_FLEX, fixed slots,
   unmodeled occupancy (incl. empty unmodeled slots), negative scores, infeasible lineups, duplicate occupants and the
   tie-break; separate tests for each caller policy.
3. **Baseline:** a captured offline snapshot of today's outputs (start/sit plans, waiver shortlists, trade
   comparisons) for Gabagool and FAM fixtures, compared to the new outputs; every difference must belong to a §8 item.
4. **Evidence:** a number appears only under a matching scoring fingerprint; mismatches show the "no measured
   evaluation" copy.
5. **Eligibility and format line:** grid match, compat-only difference (e.g. TE premium) → not in the test,
   best-ball and IDP leagues sharing a grid `format_key` → ineligible.
6. **Lifecycle and navigation:** anonymous load and team viewing, owner/non-owner identity, league switch during an
   async load, settings change on refresh, in/out of draft pages with owner and non-owner ids; pre-draft trade and
   ESPN unchanged.
7. **Data:** complete neutral schema, players universe validation, batch-field agreement, size cap at week 1 full
   horizon, oversize refusal; fault injection at every batch stage leaves the previous batch published.
8. **No other managers' data in the repo:** league fixtures synthetic, in Sleeper's response shape; real third-party
   leagues only in live browser checks, never committed.
9. **Browser, before merge:** Gabagool and FAM end to end on all three pages; one public superflex league and one
   best-ball league pasted by id.

## 10. Rollout

- Branch `feat/any-league-inseason`. **No merge to `main` until the `prospective-2026-o5` tag exists.**
- Coexistence: after merge the weekly job publishes the legacy per-league files (today's behavior) and the neutral
  batch. Rollback = revert the phase-1 code commits only; data commits stay, so the legacy pages come back with the
  freshest legacy files. The legacy in-season files and the `league` lens are retired after **two consecutive
  successful weekly refreshes** with the neutral pages verified, and a rollback rehearsal on a branch.
- Draft regeneration and the draft pages are untouched.

## 11. Out of scope

Draft board, live draft, keepers, pre-draft trade calculator, ESPN (phase 2). Any model change. The gate file and any
simulation display (January project). Long-term/dynasty value. Non-Sleeper platforms. League types other than
redraft/keeper/dynasty with managed or best-ball lineups get "this league type isn't supported yet".

## 12. Astra review trace (2026-10-03)

| Finding | Resolution |
|---|---|
| B1 v1 ≠ 13-player formats | §6.2: no relabel; simulation off for all, stated as a decision |
| B2 gate identity | §6.2: no gate file in phase 1; full-record requirements for January |
| B3 evidence transfer | §3.2 scoped `evaluation.json`; weekly copy data-driven |
| B4 parity impossible | §7.1 explicit kernel + tie-break; §8 enumerated changes; §9.3 baseline |
| I1 kernel/caller policies | §7.1 |
| I2 scoring buckets | §4: combined weights, `fum` recurring, `pass_int_td` disclosed, `bonus_rush_td_qb` pending, weight bounds |
| I3 best ball / type | §6.1 eligibility check; §11 types |
| I4 player universe | §3.4 |
| I5 live settings | §5.2; anonymous viewing §5.1 |
| I6 future picks | §7.2 removed; §8.7 |
| I7 publication | §3.5 batch; §10 rollback/retirement |
| I8 horizon/size/ROS surface | §3.3; §1 three pages |
| I9 navigation | §5.4 |
| M1 preseason proxy | §8.5 |
| M2 heuristics/budget/reverse standings | §7.2 |
| M3 ECR scope | §3.1 provenance; §7.2 labels |
| Orchestration on main | §2 do-not-touch list |
