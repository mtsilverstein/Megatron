# Any Sleeper league, phase 1: the in-season pages — design

**Status:** draft 4, 2026-10-03 — **astra: READY FOR PLAN** (`.review/astra-anyleague-spec-recheck3-response.md`).
Draft 1 was agreed with the owner section by section on 2026-10-01; three astra rounds (draft 1: 4 blockers,
9 important, 3 minor; draft 2: F1–F9; draft 3: G1–G2) are resolved here and traced in §12. Next: the owner's
review of this file. No implementation before that, and nothing merged to `main` before the `prospective-2026-o5`
tag exists (§10).

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
| `weekly.json` | This week's per-player `stat_quantiles` {p10,p50,p90} × the 12 published stats at **full precision** (as today), the `ppr`/`half_ppr`/`standard` display lenses, `stat_projection_schema`. No `league` lens. |
| `remaining.json` | Weeks `start_week`..`end_week`: per player-week `status` (`conditional_projection` / `bye` / `unmodeled`) with reason, opponent, and for projections the stat block as compact arrays `[quantile][stat]` (stat order and `schema_version` in a header; p10/p90 may be `null` for point-only predictors). Stats rounded to 4 decimals. Provenance fields as today's file minus `league` and minus `evaluation` (moved to §3.2). When no supported week remains, a valid empty state (§3.3). |
| `players.json` | The **scorable universe** (§3.4): GSIS id ↔ Sleeper id, name, team, scoring position, bye week, preseason ECR with `{source, date, scoring}` provenance (nullable). |

Both projection payloads carry the batch's **pick-six prior provenance** (`pick_six_forecast`: prior source, rate,
and the fact that it is an expectation), since `passing_pick_sixes` in every stat block depends on it.
| `evaluation.json` | Measured-evidence records (§3.2). |

All four are produced from **one validated input snapshot** and must share `season`, `week`, `data_through` and
`generated_at` batch id.

### 3.2 Evidence is scoped to the scoring it was measured under

Today's `remaining-<slug>.json.evaluation` holds point-scale MAEs measured against a league-scored baseline
(`src/ffmodel/site/remaining.py:17-61`; e.g. Gabagool horizon-1 MAE 4.612 vs baseline 4.815), and `weekly.html`
hardcodes a 56.3% close-call rate and an "≈80% of player-weeks inside the band" calibration claim. None of these
transfers to other scoring — even a uniform multiplier changes an MAE.

A league's settings are not what was measured. Example: the Gabagool rest-of-season diagnostic carries Gabagool's
full settings (`pass_int_td = −3`), but all 24 of its horizon reports have `pick_six_evaluated = false`
(`src/ffmodel/eval/remaining.py:95-103` zeroes the pick-six weight when actual counts are unavailable), while today's
weekly output *does* apply a pick-six prior. So the 4.612 figure is not a measurement of the current Gabagool lens.

`evaluation.json` therefore holds records with separate identities:

- `source_settings` — the league whose settings were used, for provenance only (never matched on);
- `effective_scoring` — the weights actually applied when the number was measured, with every omitted or zeroed
  component explicit (e.g. `pass_int_td: 0` with reason "pick-six actuals unavailable"), in the evidence
  normalization below;
- `method` — model artifact id, band construction, lineup/selection policy where the metric depends on one;
- `population`, `horizon`, `metric`, `values`, `source` (artifact path + sha256).

**Evidence normalization** is its own versioned, lossless canonical form, not the frozen six-decimal format
fingerprint (`formats.py` / `formats.js` round weights to six decimals, so `pass_yd 0.04` and `0.0400001` collide;
the frozen fingerprint stays untouched): supported offensive keys only, each weight as its shortest round-trip
decimal string with one agreed exponent-free rendering, keys sorted; Python and JS must produce identical bytes
(fixture includes the colliding pair above). The browser builds the same form from what it actually scores
(including the pick-six prior where `pass_int_td ≠ 0`).

A page shows a number as a **claim about the current output only** when the league's effective scoring equals the
record's `effective_scoring` **and** the record's `method` equals the current model artifact and band/lineup
construction. Anything else — including unknown method fields — shows "no measured evaluation for your league's
scoring and this model". Historical results stay on the about page with their full scope, never as current-output
claims. The weekly page's close-call and calibration copy follows the same rule. The plan reads each existing
claim's source artifact to fill its record; a claim whose effective scoring or method cannot be established is not
published as a current-output claim. No new fantasy-point error is derived from per-stat errors.

### 3.3 Precision, size, horizon

- Ranking and comparisons use **unrounded** scored values; rounding happens only for display. (Today start/sit
  compares published cents and waivers round a gain before filtering; both change, §8.) Waiver admission keeps
  today's effective threshold explicitly: a move is admitted when its raw weekly gain is ≥ 0.005 points (what
  "rounds to a positive cent" meant). Heuristic thresholds (3-pt close call, 1-pt weak signal, 2/5-pt FAAB bands)
  compare raw values. Python/JS parity is
  checked per league against a full-precision Python reference with tolerance
  `0.00005 × Σ|effective stat weight|` per endpoint for `remaining.json` (4-decimal stats) and 1e-9 for `weekly.json`.
- Horizon: NFL weeks `start_week`..17, the model's published horizon, labeled "through NFL week 17, regardless of
  your league's schedule" (a league whose season ends earlier or runs into week 18 sees that label; no league-specific
  clipping in phase 1). Simulation, if ever enabled, stays within its measured horizon.
- **End state:** when `start_week > 17`, `remaining.json` is a valid empty payload (`status: "no_remaining_weeks"`,
  no player rows). The batch still publishes; the weekly file stays fresh; rest-of-season values and trade
  comparisons are disabled with the reason "no projected weeks remain". Fixtures cover weeks 16, 17 and 18.
- Size: the plan measures the full serialized `remaining.json` at week 1 with the maximum player universe; the cap is
  set to that measurement × 1.25 and enforced by a test and by the generator. **Oversize fails the batch**; players or
  weeks are never dropped to fit.

### 3.4 Two universes: scorable players and roster identities

**Scorable universe (`players.json`).** Generated independently of the draft board, VORP, tiers and keeper logic.
Members: every player in `weekly.json` or `remaining.json`. For each, the Sleeper id comes from the Sleeper player
catalog via a crosswalk built on `src/ffmodel/site/sleeper.py`, with a **stricter rule than that helper**: today it
falls back to a unique name/position match when a GSIS id is duplicated (`sleeper.py:37-39,64-73`); phase 1 requires
a one-to-one GSIS↔Sleeper mapping, and any duplicate or ambiguity makes that player identity-only (never priced).
Source precedence: GSIS id, position and team come from the projection payload; Sleeper id, name and injury status
from the catalog; a team or position disagreement makes the player identity-only with the reason recorded. Team
codes go through one normalization table (today's `LAR→LA`, `WSH→WAS`). The catalog cache is refetched when older
than 24 hours (today it is reused with no age check, `sleeper.py:114-118`).

*Correction 2026-10-05 (Ruling 16):* the Sleeper catalog carries a `gsis_id` for only a minority of active skill
players (160 of 828 on NFL teams), so a GSIS-only crosswalk left ~80% of real players unpriceable. When the catalog
has **no** entry for a player's GSIS id, `players.json` falls back to the existing unique name+position match
(`sleeper._normalize_name`; unique on both the catalog and the projection side, else `ambiguous_name_match`; a
matched catalog entry carrying a different GSIS → `gsis_disagrees`), and the team/position checks still apply. A
duplicated GSIS stays identity-only with no name fallback. Each player records `match: "gsis" | "name" | null` and
the header carries `crosswalk: {matched_gsis, matched_name, unmatched}` over projected players.

**Roster identities (browser).** Roster accounting never depends on `players.json`. Every live roster, reserve and
taxi occupant — K, DEF, IDP, teamless players, players with no or ambiguous GSIS id — is represented by Sleeper id,
hydrated from the live Sleeper catalog the pages already fetch (generalizing today's K/DEF-only supplement,
`waivermode.js:98-111`). A null GSIS id never erases ownership or roster capacity; such a player is simply
"no projection".

This **expands coverage**: today 31 weekly and 304 remaining-payload players are absent from Gabagool's 698-player
board. That is an intentional change, tested separately from numeric parity (§9). Players with no projection stay
"unknown", never 0.

### 3.5 Publication

- The neutral batch is staged, validated as a whole (schema, ids, shared batch fields, size cap), and published only
  if every file succeeds; any failure leaves the previously published neutral batch untouched. Today's fail-soft
  remaining-season path (`generate.py:724-742`) does **not** apply to the neutral batch.
- Optional reference feeds (weekly/ROS ECR) stay optional and outside the batch, as today.
- **During coexistence (§10) the legacy in-season files join the same transaction**: legacy weekly and remaining for
  each league plus the neutral batch publish together or not at all, so the rollback set is always as fresh as the
  neutral one. This deliberately makes the legacy remaining-season failure fatal for the coexistence period (today
  it is skipped, `generate.py:712-728`). Draft-board generation is not part of the transaction.

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

Kept: projections are for the league's season and current week; **age limits per caller, exactly as today** —
start/sit: weekly projections and kickoffs ≤ 7 days (`startsit.js:14-17`); waivers: weekly projections, kickoff
coverage and remaining-season ≤ 72 h (`waivers.js:95,119,162`); trade: remaining-season ≤ 72 h
(`seasontrade.js:50-51`); existing future-timestamp and roster-snapshot checks stay; league `status` is `in_season`, else a plain message naming the state; every rostered skill player has
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
format test". **"In the test" is not "tested".** The frozen fingerprint is untouched. Two different cases:

- **Unrecognised roster slots (IDP etc.) produce no match at all.** `formats.js` / `formats.py` drop only
  K/DEF/IR/TAXI and throw on any other unknown slot, so `match` returns null (`tests/formats_fixture.cjs` already
  asserts this for `IDP_FLEX`). Such a league is "not in the format test".
- **Best ball shares the fingerprint** (`describeSleeper` ignores `best_ball` and `type`; the owner fixture with
  `best_ball: 1, type: 2` still matches `f12-1qb-ppr-6`). So a separate **eligibility check** runs first and
  overrides the format line: best-ball leagues read "Best ball — not eligible for the format test".

Eligible for a future simulation verdict: managed-lineup redraft/keeper/dynasty leagues (`settings.type` 0/1/2)
whose slots all come from the frozen recognised set. Never eligible: best ball, any other type, any unrecognised slot.

**Projection-UI slots** are a separate, explicit list: modeled `QB, RB, WR, TE, FLEX, SUPER_FLEX, WRRB_FLEX,
REC_FLEX`; recognised-unmodeled starting slots `K, DEF, DL, LB, DB, IDP_FLEX` (occupant kept, capacity counted);
non-starting `BN, IR, TAXI` (`BN` counts toward active capacity but never creates a lineup assignment; `IR` and
`TAXI` keep today's separate reserve/taxi accounting and exclusions). The unknown-slot rule applies only to
*starting* slots after the non-starting ones are classified: a league with any other starting slot gets projections
and rest-of-season values but no lineup-based advice, with the slot named.

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
- **Caller policies are preserved exactly as today's code implements them** (shared kernel, not shared
  preprocessing). Any deviation must be listed in §8; none is intended.
  - **Start/sit (current week)** — `startsit.js:7,40-53,65`: exclude declared bye, injury tags
    OUT/IR/SUSPENDED/PUP/DOUBTFUL, user exclusions, reserve and taxi; game-started slots are fixed and the
    refresh-after-kickoff rule stays; **a missing projection for any eligible, unlocked player refuses the plan**
    even if the rest of the roster could fill the slots (a projection for a different team than the player's current
    team counts as missing). Locked (started) players stay fixed in their slot whether or not they have a projection,
    and a locked player in an ineligible slot refuses. Start/sit reports **no lineup total**, as today, so an unknown
    locked score can never become a fabricated total.
  - **Waivers, this week** — `waivers.js:398-442`: owned unavailable/bye players allowed at 0; started slots removed
    and their fixed contributions cancelled from transaction deltas; started bench players excluded; **any unknown
    contributor blocks the result and withholds lineup gains** (`:437-440`).
  - **Waivers, rest of season** — `waivers.js:459-476`: weeks `currentWeek+1`..17; unknown-projection members
    excluded with a warning.
  - **Trade (future weeks)** — `seasontrade.js:107-125,157-161`: current week skipped; a player scores 0 only in a
    declared bye week or a week the user explicitly excluded; catalog injury tags are warnings, not exclusions;
    missing projection coverage refuses.
- Phase-1 pages make **no simulation calls**.

### 7.2 Per page

| Page | Behavior |
|---|---|
| Start/sit | Any in-season league with only projection-UI slots (§6.1). |
| Waivers | FAAB (`waiver_type 2`) and rolling (`0`) as today; reverse standings (`1`, refused today) shares the non-dollar ranking mechanics, labeled "reverse-standings waivers", without claiming its priority rules. Candidates are admitted by **this-week** gain (≥ 0.005, §3.3), as today; a separate stash list for players with zero gain this week but positive rest-of-season value is out of scope. Rest-of-season value and the "why" value both use weeks `currentWeek+1`..17, shown as "sum of weekly medians through NFL week 17, not a season median". FAAB reserve default = 20% of the league's `waiver_budget`, rounded to whole dollars (a $100 league defaults to $20, today's fixed default; owner parity holds only if the owner league's budget is verified as $100). The default resets when the league or its budget changes, unless the user has typed a value; remaining/spendable clamps as today. |
| In-season trade | Side-by-side lineup comparison everywhere. **Future draft picks are removed** from the in-season asset list: they came from `Keepers.DRAFT_ROUNDS` (Gabagool's 15 rounds × 2 seasons, `seasontrademode.js:467-478`) and were never valued. |

**Best ball** (`settings.best_ball = 1`): projections and rest-of-season values only. No start/sit plan, no waiver
lineup gain, no trade lineup comparison — the managed-lineup p50 model does not describe best-ball scoring — with the
note "best-ball scoring picks your top scorers after the games; lineup advice doesn't apply".

Point thresholds (start/sit 3-pt close call; waivers 1-pt weak signal, 2/5-pt FAAB bands) stay, labeled as
heuristics in the league's own points. Weekly and ROS ECR stay labeled as PPR reference rankings on every league.

## 8. Behavior changes for Gabagool and FAM (intentional, enumerated)

Replaces draft 1's "everything else identical", which the current code cannot satisfy (its two solvers break ties
differently: astra's counterexamples, review §B4). Caller policies (§7.1) are **not** on this list: they are preserved.

1. Lineup ties resolve by §7.1's rule (affects only equal-score alternatives; totals unchanged).
2. **Comparisons move from published cents to raw values.** Start/sit compares raw p50s instead of rounded ones
   (e.g. this week DK Metcalf 9.17528 vs Luther Burden III 9.17795, both published 9.18: tied today, ordered under
   phase 1); waiver gains are no longer rounded before filtering, with admission pinned at ≥ 0.005 (§3.3); heuristic
   thresholds (3/1/2/5 pt) compare raw values, so near-boundary cases can flip.
3. The waiver shortlist's tie-break and "why" value change from the board's `value_points` (an ECR-ordered value
   curve, not the player's own projection) to the rest-of-season p50 sum over `currentWeek+1`..17; this can change
   which rows survive the 40-row cut.
4. Scorable coverage changes both ways (§3.4): more players are in scope (31 weekly, 304 remaining-payload players
   absent from today's board), and the stricter one-to-one crosswalk makes any duplicate-GSIS player identity-only
   where today's name fallback priced it.
5. Remaining-season stats are 4-decimal; a few published cents can differ (astra: 47 of 2,085 weekly endpoints at
   4-decimal stats).
6. The dead preseason-proxy code path is removed (already unreachable for in-season leagues: `waivers.js:384-385`,
   `waivermode.js:29`).
7. Contract-mismatch refusals disappear; a mid-season scoring change is rescored, not refused.
8. Future picks leave the in-season trade page; the v1 gate note is reworded.
9. **Evidence lines can disappear for Gabagool and FAM themselves.** A measured number shows only under §3.2's
   effective-scoring + method match; the rest-of-season MAE (measured with pick-six penalties excluded, against
   today's pick-six-inclusive output) therefore no longer shows on the waiver/trade panels and moves to the about
   page with its scope. The weekly close-call and calibration lines stay only if their records match.
10. During coexistence a legacy remaining-season failure blocks the whole publication (§3.5) instead of being skipped.
11. The FAAB reserve default becomes 20% of the league budget with reset-on-change (§7.2); identical to today's
    fixed $20 only for a $100 budget.
12. Malformed roster occupancy (duplicate occupants, a fixed player in an ineligible slot) now refuses (§7.1)
    where today's start/sit could place one player in two slots.
13. In week 18 the rest-of-season state is the explicit empty payload (§3.3) instead of attempting a week-18 legacy payload (`end_week = max(week, 17)`, failures skipped).

## 9. Testing (acceptance criteria)

1. **Scoring:** Python/JS parity per §3.3 on Gabagool and FAM, for weekly and every remaining week, using an
   independent Python reference scorer (Python `ScoringRules` has no per-carry or position bonus fields). Fixtures:
   position bonuses, opposing/cancelling weights, `pass_int_td` disclosure, null bands, missing stats, overflow, every
   class in §4 including unknown keys and the no-predicted-stat refusal.
2. **Kernel:** equals brute force on seeded random rosters across FLEX, SUPER_FLEX, WRRB_FLEX, REC_FLEX, fixed slots,
   recognised-unmodeled occupancy (incl. empty unmodeled slots), negative scores, infeasible lineups, duplicate
   occupants and the tie-break.
3. **Caller policies:** one focused suite per policy in §7.1, each case taken from today's code and asserting today's
   outcome: start/sit injury tags, unlocked missing projection → refusal, wrong-team projection, locked player
   without projection, locked player in an ineligible slot, refresh-after-kickoff; weekly waivers unknown contributor
   → blocked, started bench excluded, fixed-contribution cancellation; ROS waivers unknown member → warning; trade
   declared bye / user-excluded week → 0, injury tag → warning only, missing coverage → refusal.
4. **Baseline:** a captured offline snapshot of today's outputs (start/sit plans, waiver shortlists, trade
   comparisons) for Gabagool and FAM fixtures, compared to the new outputs; every difference must belong to a §8 item.
   Near-tie, zero-gain (incl. a 0.004 and a 0.006 gain) and heuristic-boundary fixtures cover §8.2.
5. **Evidence:** Python/JS byte-identical evidence normalization (incl. `0.04` vs `0.0400001`); a number appears only
   under an effective-scoring + method match; same league settings with different evaluated components (the pick-six
   case) or a different band method → no claim; unknown method fields → no claim.
6. **Eligibility and format line:** grid match → "in the test"; compat-only difference (e.g. TE premium) → not in
   the test; IDP/unrecognised slot → no fingerprint match; best ball with a matching fingerprint → ineligible and the
   eligibility line wins; projection-UI slot lists; unknown slot → projections only.
7. **Roster identities:** K, DEF, IDP, teamless, null-GSIS and ambiguous-GSIS roster occupants keep ownership and
   capacity with "no projection".
8. **Waivers money and horizon:** budgets $0, $10, $100 and exhausted; default reset on league/budget change vs a
   typed override; reverse-standings labeling; weeks 16, 17, 18 including the empty `remaining.json` state and
   disabled trade comparisons.
9. **Lifecycle and navigation:** anonymous load and team viewing (never "your roster"; `myRoster` only from the exact
   owner match), owner/non-owner identity, league switch during an async load, settings change on refresh, in/out of
   draft pages with owner and non-owner ids; pre-draft trade and ESPN unchanged.
10. **Data:** complete neutral schema incl. pick-six provenance in both payloads, scorable-universe validation
    (one-to-one rule, team/position disagreement → identity-only), catalog age refetch, batch-field agreement, size
    cap at week 1 full horizon, oversize refusal; fault injection at every stage of the coexistence transaction
    (neutral and legacy files) leaves the previous complete set published.
11. **No other managers' data in the repo:** league fixtures synthetic, in Sleeper's response shape; real third-party
    leagues only in live browser checks, never committed.
12. **Browser, before merge:** Gabagool and FAM end to end on all three pages; one public superflex league and one
    best-ball league pasted by id.

## 10. Rollout

- Branch `feat/any-league-inseason`. **No merge to `main` until the `prospective-2026-o5` tag exists.**
- **Coexistence:** after merge the weekly job publishes legacy in-season files and the neutral batch as one
  transaction (§3.5). The workflow runs twice daily (`weekly-update.yml:3-4`), so "success" is counted per **NFL
  week**, not per job.
- **Rollback** = revert the phase-1 code commits only; data commits stay. Because of the shared transaction, the
  retained legacy files are always as fresh as the last neutral publish. The rollback rehearsal (on a branch)
  loads the restored legacy pages against the retained data, including rest-of-season and schedule checks.
- **Retirement** of the legacy in-season files (`weekly-fam.json`, `remaining-gabagool.json`, `remaining-fam.json`)
  and of the `league` lens **in the in-season weekly output only**, after: two distinct NFL weeks each with at least
  one complete transaction and the neutral pages verified, plus a passed rollback rehearsal. The draft board's
  `league` lens (built through `site/weekly.py`'s rule set for the board) is unchanged. After retirement, rollback
  means a forward fix; the legacy path is not supported.
- Draft regeneration and the draft pages are untouched.

## 11. Out of scope

Draft board, live draft, keepers, pre-draft trade calculator, ESPN (phase 2). Any model change. The gate file and any
simulation display (January project). Long-term/dynasty value. Non-Sleeper platforms. League types other than
redraft/keeper/dynasty with managed or best-ball lineups get "this league type isn't supported yet".

## 12. Astra review trace (2026-10-03)

Draft-1 review:

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

Draft-2 re-check (B3, B4, I1, I3, I4, I7, I8 were reopened under these):

| Finding | Resolution |
|---|---|
| F1 settings ≠ measured scoring/method (Blocker) | §3.2: `effective_scoring` + `method` identity, match on both; pick-six provenance in both payloads (§3.1); §8.9 |
| F2 lossy six-decimal fingerprint | §3.2: separate lossless evidence normalization; frozen fingerprint untouched |
| F3 caller policies misdescribed | §7.1 rewritten from the code, preserved exactly; §9.3 suite |
| F4 roster identities / crosswalk | §3.4: two universes, stricter one-to-one rule, catalog age, correct module path; §9.7 |
| F5 IDP vs best ball | §6.1: IDP → no match, best ball → separate eligibility; projection-UI slot lists; best ball gets no lineup advice (§7.2) |
| F6 raw comparisons unlisted | §3.3 admission threshold; §8.2; §9.4 boundary fixtures |
| F7 rollback readiness / counter | §3.5 coexistence transaction; §10 per-NFL-week counter, rehearsal, lens scope |
| F8 ROS candidates / terminal horizon | §7.2 admission + interval; §3.3 empty end state; §9.8 |
| F9 unverified $100 budget | §7.2 wording; reset rule; §9.8 budgets |

Draft-3 re-check (`.review/astra-anyleague-spec-recheck2-response.md`): F1–F4, F6–F9 and B3, I1, I4, I7, I8
resolved; §7.1 caller bullets verified faithful.

| Finding | Resolution |
|---|---|
| G1 slot list omitted `BN/IR/TAXI` | §6.1 three slot categories; unknown-slot rule applies to starting slots only |
| G2 freshness relaxed for waivers | §5.3 age limits per caller, exactly as today |
| P1–P4 (plan-level) | carried into the implementation plan: evidence normalization domain and display binding (P1); single validated mapping, unknown-ID placeholders, shared team-alias table incl. `JAC→JAX` (P2); §8 items 11–13 added (P3); staged publication incl. the kickoff artifact, rollover and week-18 tests (P4) |
