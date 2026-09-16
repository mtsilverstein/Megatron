# Waiver Drop Cost — Design

**Status:** approved 2026-09-16 (design and the claim-discipline call below approved
in conversation). Independent of the in-season trade project; the trade project may
later reuse the payload and the roster-value primitive, but nothing here waits on it.

**Goal:** price what a required drop costs, so the waiver desk can give spend guidance
on add/drop swaps instead of withholding it. Today every alternative that requires a
drop is `dropCost.status = "unassessed"` and receives no bid range or claim guidance
(commit 606bd0f), because the dropped player's rest-of-season value was unpriced.

**The one-sentence design:** value a move as the change in *your lineup's* projected
points over the rest of the season, computed week by week from the model's own
remaining-season projections, and apply the existing (uncalibrated, labeled) bid bands
to that number instead of to this week's gain alone.

---

## 1. Definitions

- **Current week** `W`: the week the desk is analysing (`args.week`). This week's gain
  is already computed by the existing weekly comparison (`lineupGain`).
- **Future weeks**: `W+1 .. end_week` where `end_week` comes from the remaining-season
  payload (17 by default; the payload is authoritative, the engine never assumes 17).
- **Remaining-season lineup value** of a set of players `P`:

  ```
  rosValue(P) = Σ_{w = W+1}^{end_week} lineupScore(P, fullStarterSlots, p => pointsAt(p, w))
  ```

  `lineupScore` is the existing exact laminar-slot solver in `waivers.js`.
  `fullStarterSlots` are the league's skill starting slots with **no locked slots** —
  locked starters only exist for the current week. `pointsAt(p, w)` is the player's
  league-lens `p50` for week `w`; a **bye** week is `0`; an **unmodeled** week is `null`
  (excluded from that week's lineup by `lineupScore`, exactly as today's weekly path
  treats a missing projection).
- **Drop cost decomposition** for a swap (add `A`, drop `D`) against the current
  active roster `R` (the same `availableOwn` set the weekly comparison uses, plus the
  started/locked players — future weeks have no locks, so the future roster is the
  full active skill roster):

  ```
  addContributes = rosValue(R + A)      − rosValue(R)          (≥ 0)
  dropForfeits   = rosValue(R + A)      − rosValue(R + A − D)  (≥ 0)
  rosDelta       = rosValue(R + A − D)  − rosValue(R)          (= addContributes − dropForfeits)
  ```

  The split is taken against `R + A` rather than `R − D` on purpose: `R − D` may be
  unable to field a legal lineup (a roster with exactly enough skill players), while
  `R + A` is legal whenever `R` is. It also reads correctly — what the drop forfeits
  *given the add is on the roster* is the marginal that matters for a swap. If any of
  the three `rosValue` terms is non-finite (a future week's lineup cannot be filled
  from modeled players), the pair is `unassessed` with reason
  `"roster cannot field a full lineup from modeled players in every future week"`.

  For an open-slot add (`D = null`): `dropForfeits = 0`, `rosDelta = addContributes`.
- **Move value** (season points remaining): `moveValue = lineupGain + rosDelta`.
- **Per-week value**: `perWeekValue = moveValue / (futureWeeks + 1)`, where
  `futureWeeks = end_week − W`. This is the number the weak-signal threshold and the
  bid bands read. **Fallback:** when `rosDelta` is `null` (an open-slot row whose add
  cannot be priced, or no fresh payload), `perWeekValue = lineupGain` — exactly
  today's basis — and the label says the rest-of-season contribution is not priced.

A bench player who never cracks the lineup forfeits ~0 whatever his season total; a
starter forfeits his lineup contribution. That roster-awareness is the point — the
preseason board total was rejected (606bd0f) precisely because it is neither
roster-aware nor current.

## 2. Data contract: `remaining-<slug>.json`

Produced by `ffmodel.site.remaining.build_remaining` (existing, opt-in `--remaining`),
published by the weekly workflow for both Sleeper leagues.

### 2.1 Slimming (build_remaining changes)

Per player-week, `points` keeps **only the `league` lens** (`p10/p50/p90`) and
`stat_quantiles` is **dropped**. Everything else in the existing schema is unchanged
(`schema_version` stays `1` — nothing a consumer reads is removed; `seasontrade.js`
reads only `points.league.p50`, `status`, `week`, `team`). Measured: 24.3 MB → about
1 MB for 924 players × 16 weeks.

### 2.2 Evaluation block (replaces the `advice_eligible` boolean)

`advice_eligible: false` is removed from the payload. In its place:

```json
"evaluation": {
  "source": "models/diagnostics/remaining_matrix_gabagool.json",
  "baseline": "mean league-scored production in the last four recorded pre-origin games",
  "seasons": [2023, 2024, 2025], "origins": [5, 9],
  "horizons": [
    {"horizon": 1, "model_mae": 4.612, "baseline_mae": 4.815, "paired_forecasts": 1817},
    {"horizon": 2, "model_mae": 4.452, "baseline_mae": 4.722, "paired_forecasts": 1791},
    {"horizon": 4, "model_mae": 4.663, "baseline_mae": 4.873, "paired_forecasts": 1829},
    {"horizon": 8, "model_mae": 4.800, "baseline_mae": 4.987, "paired_forecasts": 1834}
  ],
  "limitation": "<copied verbatim from the diagnostic's `limitation` field>"
}
```

The numbers are **read from the committed diagnostic JSON at generate time**
(`summary` rows with `position == "ALL"`), never typed into code. If the diagnostic
file for the league is absent, the generator uses the Gabagool diagnostic **only if**
the league's `sleeper_scoring` equals Gabagool's (the doc records that the supported
scoring subset currently matches for Gabagool and FAM) and records
`"scoring_scope": "evaluated under gabagool scoring, which matches this league"`;
otherwise `evaluation` is `null` and the desk says so.

`seasontrade.js` currently requires `remaining.advice_eligible === false`; that check
becomes `remaining.status === "experimental" && remaining.evaluation !== undefined`
(the field may be null). The CLI prototype's own "not a verdict" wording is unchanged.
`tests/test_remaining.py::test_frozen_history_missing_and_bye_distinct` asserts the
old boolean and must be updated to assert the new block's shape.

### 2.3 Workflow (fail-soft)

The weekly job passes `--remaining` for both leagues. Inside `generate.py`, the
remaining build is wrapped so that **an exception there prints the error and skips the
remaining payload; the weekly, roles and kickoffs payloads still publish**. The
fail-safe rule (a failed data pull must not touch published JSON) is unchanged: the
guard is around one optional payload, not around the run. A skipped remaining payload
leaves the previously published file in place; the desk's 72-hour freshness guard then
withholds drop pricing on its own.

Cost: the local run for Gabagool took 2 m 20 s including the weekly build; CI adds
roughly one minute per league.

## 3. Engine (`site/assets/waivers.js`)

### 3.1 `remainingMap(remaining, league, week, boardByGsis, now)`

Mirrors `weeklyMap`. Returns `{ fresh, reason, endWeek, at: Map<sleeperId, Map<week, number|null>>, unmodeled: Set<sleeperId> }`.
It is **not fresh** (with the named reason) when any of these fail, checked in this
order:

1. payload missing → `"remaining-season projections unavailable"`
2. `league.league_id` mismatch → `"remaining-season league id does not match live league"`
3. scoring contract mismatch (same rule as `weeklyMap`) → `"remaining-season scoring contract is incomplete or does not match live league"`
4. `season` mismatch → `"remaining-season season does not match league season"`
5. `start_week !== week` → `"remaining-season start week does not match requested week"`
6. `generated_at` older than 72 h or more than 1 h in the future → `"remaining-season projections are stale (over 72 hours old)"`
7. `players` not an array, or `end_week` not an integer ≥ `week` → `"remaining-season payload is incomplete"`

Per player-week: status `conditional_projection` → `p50` (finite required, else treated
as unmodeled); `bye` → `0`; `unmodeled` or a missing week row → `null`, and the player
is added to `unmodeled`. A player whose projection `team` disagrees with the board's
current team is treated as unmodeled for every week (same rule as `weeklyMap`'s
`invalidTeamIds`), because his future-week opponents are wrong.

### 3.2 Pricing a row

`dropCostOf(drop, add, ctx)` returns one of three states (the field set is fixed;
fixtures assert no other keys leak):

| status | when | fields |
| --- | --- | --- |
| `open_slot` | no drop required | `label`, `addContributes`, `rosDelta`, `futureWeeks`, `endWeek` |
| `priced` | drop required; remaining payload fresh; **both** `add` and `drop` have a finite value or bye in **every** future week | `label`, `dropForfeits`, `addContributes`, `rosDelta`, `futureWeeks`, `endWeek` |
| `unassessed` | anything else | `label`, `reason` |

`reason` is one of: the `remainingMap` reason; `"<name> has no rest-of-season projection"`
naming the add or the drop (whichever is unmodeled; both if both). **Unknown is never
zero:** an unmodeled add or drop is never priced at 0.

Other roster players with unmodeled future weeks do not block pricing; they are
excluded from those weeks' lineups (they cannot be counted) and reported in
`coverage.rosUnmodeledOwned` (ids and names) so the page can say
"N roster players have no rest-of-season projection and are excluded from future
lineups". In the live Gabagool check on 2026-09-16 this was 3 of 159 rostered skill
players league-wide, all zero-snap rookies or absent from the roster map.

`open_slot` rows also compute `addContributes` when the payload is fresh and the add
is fully modeled; if not, `open_slot` keeps `rosDelta: null` and the row falls back to
today's behaviour (bands on this week's gain) with the label saying the add's
rest-of-season contribution is not priced. This is the only place the old basis
survives, and only for open-slot rows whose add cannot be priced.

All money-relevant numbers round to two decimals, like `lineupGain`.

### 3.3 Guidance

`signal.perWeekGain` becomes `perWeekValue` (§1). `WEAK_SIGNAL_PTS = 1` and the tier
bands (1–2 small, 2–5 useful, 5+ impact, as fractions of starting budget) are
**unchanged in value and unchanged in labeling** — they remain "heuristic, not
calibrated and not a win probability".

`bidGuide` precedence, first match wins:

1. affordability: `gain > 0 && affordable < minBid` → unchanged status
2. priced and `moveValue <= 0` → `tier "drop costs more than the add returns"`, status
   `"no bid suggested: dropping <D> forfeits <dropForfeits> rest-of-season lineup points against <addContributes> from <A>"`
3. `perWeekValue < WEAK_SIGNAL_PTS` → weak (unchanged wording; the number is the
   per-week move value, or this week's gain under the §1 fallback — so with no payload
   today's weak rows stay weak)
4. `dropCost.status === "unassessed"` → `tier "drop cost unassessed"`, status
   `"no bid suggested: drop cost unassessed — <reason>"`
5. otherwise bands on `perWeekValue`

Rolling leagues get the parallel guidance strings ("research only: no priority claim
suggested; …" for 2–4, "rank by value and roster need" for 5).

Weak still precedes unassessed, exactly as shipped, so every existing fixture pin on
weak rows holds when no payload is present. Net-negative precedes weak because a
negative per-week value is not "weak" — it is a loss, and the two numbers say why.

**Preseason-proxy mode** (`weekly` not fresh, league not in season): no ROS pricing
at all — `dropCost` behaves as today and `perWeekGain` keeps its proxy meaning.

`signal.label` for a modeled row states the basis:
`"modeled lineup gain this week plus rest-of-season lineup change; projection error is not quantified and no claim-success probability is implied"`.
`rosterCost` (the per-row sentence) becomes, for priced rows,
`"dropping <D> forfeits <dropForfeits> projected lineup points over weeks <W+1>–<end>; <A> adds <addContributes> in his place"`
and for open-slot rows `"uses an open roster spot; <A> adds <addContributes> over weeks <W+1>–<end>; roster flexibility is not priced"`.

### 3.4 Result additions

- `coverage.ros`: `{ fresh, reason, endWeek, futureWeeks, generatedAt, dataThrough, pricedOwned, unmodeledOwned: [{id,name}], pricedFreeAgents, evaluation }` where `evaluation` is the payload's block (or null).
- warnings: when `!ros.fresh`: `"<reason>; drop costs unassessed, spend guidance limited to open-slot adds"`; when `unmodeledOwned.length`: the count sentence above; a summary count of rows in each of the three states.

### 3.5 Performance bound

Gabagool week 2: ~409 priceable free agents × up to ~10 drop candidates × 15 future
weeks ≈ 61k `lineupScore` calls on ≤15 players. `rosValue(R)` and `rosValue(R − D)`
are computed once per drop candidate, not per pair. The existing fixture's full-size
performance bound is extended to cover the priced path and must stay under its
current limit.

## 4. Page (`site/assets/waivermode.js`, `waivers.html`)

- Load `data/remaining-<slug>.json` alongside the other payloads (`leagueDataPath`
  gains the `"remaining"` kind; Gabagool's file is `remaining-gabagool.json`, so this
  kind does **not** use the bare-name convention `weekly.json` uses — the helper maps
  `remaining` → `data/remaining-<slug>.json` for every league).
- `rowText`: gain cell `+X.XX this week · ROS +Y.YY` (or `· ROS −Y.YY`; omitted when
  `rosDelta` is null); why cell prefixes the tier as today; a new `dropCostNote` for
  priced rows carries the forfeits/adds sentence; export line gains
  `; ROS <±rosDelta> (wk <W+1>–<end>)` and, for state 3 rows, `DROP COSTS MORE THAN ADD RETURNS`.
  Withheld rows still never print `$`, `null`, or a dollar range (existing pins keep
  holding).
- Coverage line under the table: `Rest-of-season projections: weeks <W+1>–<end>, generated <date>, data through <data_through>; <pricedOwned>/<activeOwnedSkills> roster players priced` and, when applicable, the unmodeled names.
- Disclosure paragraph (collapsed with the other provenance): the ROS estimate is the
  model's frozen-history forecast, assumes participation (injuries and returns are not
  forecast), and shows the evaluation table (model MAE vs four-game mean by horizon,
  paired forecast counts) with the diagnostic's limitation sentence. If `evaluation` is
  null: "no measured evaluation for this league's scoring".
- Cache versions: `waivers.js?v=dropcost3`, `waivermode.js?v=dropcost3` on
  `waivers.html` and `weekly.html`; the shared-assets fixture enforces the match.
- `docs/faab-waivers.md` "Bid ranges" section rewritten to describe the new basis;
  `docs/remaining-season-projections.md` first paragraph updated (now consumed by the
  waiver desk; evaluation block replaces the boolean); `docs/inseason-consensus.md`
  "Remaining trade work" left as is (the trade engine is still blocked).

## 5. Fail-closed rules (restated, because they are the contract)

1. Unknown is never zero: an unmodeled add or drop → `unassessed`, never priced.
2. Stale, misaligned or missing payload → every required-drop row `unassessed` with the
   reason; open-slot rows keep the old this-week basis.
3. A projection whose team disagrees with the board's current team is unmodeled.
4. Nothing here changes what the current-week comparison does, which rows are legal, or
   who may be dropped (protected, started, IR/taxi, unmapped rules are untouched).
5. No text says a swap is "wrong" or "right"; the net-negative status reports two
   numbers and declines to suggest spend.

## 6. Testing

`tests/waivers_fixture.cjs` (extend; the file already carries a synthetic league,
board, weekly and kickoff builders):

- a `remaining()` builder producing the slim schema for the fixture's players;
- priced swap: bench drop with tiny future contribution, add who starts every week →
  `priced`, `dropForfeits ≈ 0`, `addContributes > 0`, bid range present, tier from
  `perWeekValue`;
- net negative: drop a weekly starter for a marginal add → state 3 status, `low/high
  null`, no `$` in `rowText`;
- unmodeled add, unmodeled drop, both → `unassessed` with the naming reason;
- stale / wrong start_week / wrong league id / scoring mismatch / missing → `unassessed`
  with the `remainingMap` reason, open-slot rows unaffected;
- bye week counts as 0, not as unmodeled;
- team mismatch → unmodeled;
- open-slot add: `rosDelta = addContributes`; a one-week fill (add projected only this
  week, 0 after) yields a smaller `perWeekValue` than the same weekly gain from a
  season-long add;
- precedence: affordability > net-negative (priced only) > weak > unassessed > bands;
- decomposition identity `rosDelta === addContributes − dropForfeits` (to 1e-6) on a
  randomized roster, and `rosValue` equals a brute-force per-week `lineupScore` sum;
- `dropCost` key sets are exactly the three fixed sets;
- performance: full-size synthetic league with the priced path inside the existing bound.

`tests/waivermode_fixture.cjs`: `rowText` for priced, net-negative, unassessed and
open-slot-with-ROS rows; no `$`/`null` on withheld rows; export line contents.

Python: `tests/test_remaining.py` — slim shape (only `league` lens, no
`stat_quantiles`), evaluation block read from a fixture diagnostic, null evaluation
when absent and scoring differs, the FAM scoring-match rule; `tests/test_generate.py`
— remaining failure is logged and skipped while other payloads are written; a
workflow-file assertion that both league runs pass `--remaining`.

## 7. Out of scope

- Multiple-claim planning, shared-drop conflicts, combined budgets (astra's item 2).
- Bid calibration against observed winning bids (item 3).
- Injury/return forecasting; keeper premium on the dropped or added player.
- The in-season trade calculator (separate spec; may reuse §1 and §2).
- Any change to the model, the weekly payload, or the draft board.
