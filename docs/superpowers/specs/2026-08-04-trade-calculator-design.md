# Pre-Draft Trade Calculator — Design

**Status:** approved 2026-08-04. Scope is PRE-DRAFT ONLY; in-season trading is a
separate spec written after the draft (deadline for that half is week 1, not
Aug 20).

**Goal:** grade a proposed pre-draft trade — players and draft picks, current
and future — in one honest currency, and suggest trades worth offering.

**There are exactly two asset classes: players and picks.** A keeper is not a
tradeable thing. Pre-draft a player is just a player; keeper designation
happens afterwards, and whoever owns him then sets their own keepers. Every
keeper consequence in this design is therefore *derived* from ownership, never
traded directly.

**Architecture:** a trade is a different draft. Value it by simulating the rest
of the draft from the post-trade state and reporting the best starting lineup
you could finish. Client-side only, over the already-published `draft.json`.

**Tech:** `site/assets/trade.js` (UMD, pure math, node-testable), a panel in a
new `site/trade.html`, the public read-only Sleeper API. No Python change, no
model change, no board regeneration.

---

## 1. League facts this depends on

Taken from our own config and from the user's restatement — **never from
Sleeper's league settings**, which are demonstrably unmaintained in this league
(`draft_rounds: 3` for a 15-round draft; `max_keepers: 1` against a restated 2).

| fact | value | source |
|---|---|---|
| teams | 12 | `Keepers.TEAMS` |
| draft rounds | 15 | `Keepers.DRAFT_ROUNDS` |
| starters | QB, RB×2, WR×2, TE, FLEX×2 (+K, DST unmodelled) | `Optimizer.DEDICATED`, `FLEX_SLOTS` |
| keepers | up to 2 (one team took 2 in the 2025 draft) | `Keepers.MAX_KEEPERS` |
| keeper cost | `originalRound − (season − originalYear)`; waiver ladder starts R12 | `Keepers.keeperCost` |
| keeper eligibility | cost ≥ R3, else back to the pool | `Keepers.eligible` |
| **keeper cost on trade** | **follows the player** — new owner inherits the round and the years-kept clock | league restatement, 2026-08-04 |
| **keeper cost collision** | bumps **downward** — two keepers computing to the same cost round: the second pays the next EARLIER pick (two R5s cost R5 and R4, not R5 and R6); worth 20.4 pts on an early collision, 0 on a late one (`Optimizer.ROLLOUT_PICKS` = 8) | league restatement, 2026-08-05 |
| scoring | full PPR, 6-point passing TDs | `ffmodel.scoring.LEAGUE` |

The keeper-follows-the-player rule is what `keepers.js` already assumes:
`buildOriginalByPlayerId` keys on the draft chain, not on ownership. No rework.

## 2. Why the obvious design is wrong

Every public trade calculator is an additive value chart: score each asset,
sum both sides, compare. That is precisely the defect this codebase has already
removed twice — v1's VORP scoring, and `waitCost` before 48795d2. Additive
value prices your fifth running back at full freight when he cannot start, and
it cannot see that the same player is worth 90 points to a team starting one RB
and ~0 to you.

Additive value survives here **only as a search heuristic**. It never reaches
the screen.

## 3. Core model

### 3.1 State

A team's pre-draft state is:

```
{ roster: [player, ...],             // everyone they hold, post-trade
  picks:  [{season, round}, ...] }   // current-year and future, post-trade ownership
```

**Keepers are derived, never traded.** A team's keepers are computed from
`roster` by taking the best `MAX_KEEPERS` eligible players by impact — the same
greedy selection `Keepers.recommendKeepers` already performs — recomputed on
BOTH sides of every trade. Two consequences, and the whole valuation turns on
them:

**(a) An acquired player competes for a slot, he does not add one.** Trading
for a star when both slots are already filled by better players gains close to
nothing. A design that treated him as an automatic extra keeper would
systematically overvalue every incoming star.

**(b) A keeper-INELIGIBLE player has zero pre-draft trade value.** If his
computed cost is R2 or lower he returns to the draft pool for everybody
(`Keepers.eligible`), so owning him before the draft confers nothing — you
would have to draft him like anyone else. Since cost is
`originalRound − yearsKept`, this means **last year's first- and
second-round picks are not tradeable assets at all**, and neither is anyone
whose ladder has run out. The tradeable player universe pre-draft is only those
with cost ≥ R3, which is far smaller than "every rostered player" and is
strongly counterintuitive — the best players on a roster are frequently the
ones worth nothing to trade. The UI must state this outright on any ineligible
player rather than showing a quiet zero.

**(c) The asset is the SURPLUS, not the player.** What a player is worth
pre-draft is the gap between what he costs to keep and what the market charges
for him. Measured on the live board against the real 2025 draft:

| player | 2026 keeper cost | ADP | surplus |
|---|---|---|---|
| Jaxon Smith-Njigba | R8 | pick 5 (R1) | **+7 rounds** |
| Bucky Irving | R11 | pick 30 (R3) | +8 rounds |
| Drake Maye | R12 | pick 51 (R5) | +7 rounds |
| Cam Skattebo | R8 | pick 49 (R5) | +3 rounds |

This is not a separate term to add — it is exactly what `stateValue` already
prices, because keeping Smith-Njigba spends only the R8 pick while delivering a
first-round player, and `finishRoster` then drafts on from a much stronger
position. It is called out because it inverts the intuition the UI has to
serve: a mid-round pick from two years ago can be a more valuable trade asset
than a better player drafted in round one, and the numbers must make that
legible rather than merely correct.

### 3.1.1 Sleeper's `keepers` field is not read

A manager may designate a keeper precisely *because* they intend to shop him,
and the tag carries no commitment before the draft. Keeper status is derived
from rosters plus draft history only. (It is also empty in practice — every
roster in the league returns `keepers: null`.)

`MAX_KEEPERS = 2` is confirmed by evidence, not recollection: Sleeper's league
settings claim `max_keepers: 1`, but one team took two keeper picks in the 2025
draft. Sleeper's settings are unmaintained here (§1), our config is right.

### 3.2 Value

```
kept   = chooseKeepers(state.roster)          // §3.1 — derived, never traded
pool   = board minus every team's chosen keepers
picks  = currentYearPickNumbers(state.picks) minus the rounds `kept` consumes

stateValue(state) = lineupPoints(finishRoster(kept, pool, picks, 0))
                                                            // 0: nothing drafted yet
```

`currentYearPickNumbers` maps each current-season pick to its **mid-round
overall pick** (`Keepers.pickForRound`); keeping a player at R6 spends the R6
pick. Draft order is not set pre-draft, so mid-round is the honest slot;
pretending to know the
exact pick would be false precision.

Everything the trade tool needs falls out of this one function:

| asset moves | how it enters `stateValue` |
|---|---|
| player traded away | leaves `roster`; keepers are re-derived, so if he *was* one, his cost round returns to the pick pool and the next-best eligible player may take the slot |
| player acquired | joins `roster`; keepers are re-derived, so he takes a slot only if he beats the incumbents, and if he does, his **inherited** cost round is spent |
| current-year pick | added to / removed from `picks` |
| future pick | see §3.3 |

Nothing in this table special-cases a keeper. Both sides run the same
derivation on their new roster, which is what makes the model match the league:
you trade players, then set keepers.

### 3.3 Future picks

`finishRoster` simulates *this* draft, so a 2027 pick has no slot in it. It is
valued in the same currency by asking what the equivalent current-year pick
would be worth, then discounting:

```
futurePickValue(round, seasonsAhead, state) =
    (stateValue(state + currentYearPick(round)) − stateValue(state))
    * FUTURE_DISCOUNT ** seasonsAhead
```

`FUTURE_DISCOUNT` defaults to **0.8 per season** and is a user-facing slider.
It is an un-tuned judgment constant in the same spirit as the optimizer's
`BYE_PEN` — deliberately NOT fitted, because we have no 2027 board to fit it
against.

**Known and intended consequence:** picks past the rollout horizon
(`ROLLOUT_PICKS = 8`) evaluate to ~0 lineup impact, so the tool will say your
R12 is worth nothing to your lineup. That is the objective's honest answer — a
12th-round pick rarely changes a starting lineup. Past round 8 the market
column (§4) is 0 too, measured: every board row past rank 96 sits at or below
positional replacement, so a pick that buys a replacement-level player is
worth nothing in either currency — there is no gap here to trade on. *The
tradeable edge this model surfaces lives in players whose ADP sits well
adrift of our board, not in late picks.*

## 4. Grading a trade

Every candidate carries three numbers, all displayed:

| number | computed with | answers |
|---|---|---|
| `myGain` | our lineup objective | what you actually get |
| `theirGain` | our lineup objective | what they actually get |
| `marketDelta` | additive ADP/ECR value, from their side | what the offer **looks like** to them |

`marketDelta` exists because the counterparty will judge the offer on market
numbers, not ours. A trade is worth offering when `myGain` is real **and**
`marketDelta ≥ 0` — it must look fair-or-better on the numbers they will use.

Market value of an asset, for `marketDelta` only:

- player: his position on the ADP curve, `parVorp(board, adpPick)`, falling back
  to his board slot when he has no ADP (460 of 695 players have none — the
  fallback must be LABELLED as ours, per the `valueLabel` precedent in a6e2161)
- pick: `parVorp(board, pickForRound(round))`, times `FUTURE_DISCOUNT ** seasonsAhead`

### 4.1 Where the edge is, and is not

Stated explicitly so no future change quietly violates it. This project has
measured that our per-player ranking **loses** to expert consensus
(`consensus_benchmark.json`: 60.5% vs 53.9% starter hit-rate, ECR wins 12/12
positions on Spearman). A trade recommendation resting on "our model likes this
player more than the market does" would be selling ourselves the worse signal.

The defensible edges, all of which this design uses:

1. **Keeper-cost arbitrage — pre-draft this is very nearly the whole thing.**
   The cost ladder is league-specific and routinely misjudged; `keepers.js`
   computes it exactly and `buildOriginalByPlayerId` gives it for *every*
   player in the league. §3.1c shows live surpluses of +7 and +8 rounds sitting
   on other teams' rosters, and exploiting them requires predicting no football
   whatsoever.

   **Measured against the shipped optimizer:** holding the same player at a R11
   keeper cost instead of R3 is worth **+51.0 projected lineup points**.

2. **Roster-shape math — NOT a pre-draft edge.** *Corrected 2026-08-05 while
   writing the implementation plan; the first draft of this section had it
   first, which was wrong.* Shape is what earns the +120 in the draft backtest
   and it will matter in-season, when a roster is 15 players. **Pre-draft a
   roster is at most two keepers**, and `finishRoster` drafts everything else,
   so shape has almost nothing to bite on. Measured the same way: keeping two
   RBs instead of an RB and a WR moves the finishable lineup by **0.8 points**
   — sixty times smaller than the cost effect above, and inside the noise floor
   `MIN_GAIN` already rejects.

   The consequence for the design is concrete: a pre-draft trade is worth
   making because of the *ladder* a player sits on, not because of the *hole*
   he fills. The UI must lead with cost surplus, and §9's first test changes
   accordingly.
3. **The QB mispricing.** This league leaves QBs on the board +19.4 picks past
   market position, consistently across all four measured drafts, in a
   6-point-passing-TD league.

None of these requires out-predicting the experts. All three are arithmetic the
counterparty has not done.

## 5. The suggester

### 5.1 Search space and pruning

2-team trades only, at most 2 assets per side. Unpruned that is ~2.4M
combinations across 11 opponents, so:

1. **My offerable assets** — players whose removal costs me less than
   `MIN_GAIN` (i.e. `stateValue(me) − stateValue(me without him) < MIN_GAIN`),
   plus my picks. A player I actually need is not an asset I am shopping. This
   is one `stateValue` call per roster player, memoized once per session.
2. **Their offerable assets** — the mirror: players whose addition to my state
   gains me at least `MIN_GAIN`, plus their picks.
3. **Additive prefilter** — rank candidate packages by additive value
   difference, keep the top `SUGGEST_PER_TEAM = 40` per opponent within a
   rough parity band.
4. **Honest scoring** — the survivors get `stateValue` on both sides.

Cost: ~880 `finishRoster` calls at ~4 ms ≈ **3–4 seconds**, behind an explicit
"Suggest trades" button with a progress line, never on keystroke.

### 5.2 Ranking and the acceptability filter

Surface when `myGain >= MIN_GAIN` (default 5 season points, ~0.3/week — below
that the objective cannot tell the trade from noise, same reasoning as
`Keepers.MARGINAL_POINTS`) **and** `marketDelta >= 0`.

Rank by `myGain`. Display `theirGain` beside it. Provide a toggle,
**default ON**, that hides any trade where `theirGain > myGain` — the user's
stated goal is a slight edge without handing a competitor an advantage, and
that is a filter they can inspect rather than a weight baked into a score.

## 6. Data layer

All read-only, no auth, public Sleeper API. Every endpoint below was verified
against the user's real league on 2026-08-04.

| endpoint | gives |
|---|---|
| `/user/{name}` | `user_id` |
| `/user/{id}/leagues/nfl/{season}` | league list, `previous_league_id` |
| `/league/{id}/users` | 12 display names |
| `/league/{id}/rosters` | `roster_id`, `owner_id`, `players[]` for all 12 |
| `/league/{id}/traded_picks` | `[{round, season, roster_id, owner_id, previous_owner_id}]` |
| `/league/{id}/drafts` + `/draft/{id}/picks` | the draft chain, for keeper cost |

**Pick ownership.** Seed every team with rounds 1..15 for the current and next
two seasons, then apply `traded_picks`: `roster_id` is the pick's original
owner, `owner_id` is who holds it now. Verified live — the 2025 league carried
25 traded picks including 9 for the 2026 season.

**Caching.** Sleeper sends no `Cache-Control` and sits behind a CDN measured
serving 6-hour-old copies (342310a). The cache-busting fetch currently lives
private inside `draftmode.js`; `keepers.js`'s `sapi` does NOT have it and is
therefore still cache-vulnerable today. This spec **extracts that fetch into a
shared `FC.sleeper(path)` helper in `app.js`** and points `trade.js`,
`keepers.js` and `draftmode.js` at it — one implementation, one place to fix.
That is a small in-flight repair of code this feature depends on, not unrelated
refactoring: a trade tool reading a six-hour-old roster would grade trades
against players who have already moved.

## 7. UI

`site/trade.html`, linked from the draft board. The draft board is already
dense and on draft day a trade UI is in the way; pre-draft trades happen before
draft day regardless.

- **Load from Sleeper** — username → league, the same flow and the same
  fail-soft behaviour as the keeper panel.
- **Counterparty picker** — the other 11 teams by display name.
- **Two asset columns** — yours and theirs; click to add to the trade.
- **Live grade** — the three numbers of §4, plus a one-line reason
  ("fills your WR2 · costs your R6 keeper slot").
- **Suggest trades** — the ranked list of §5, with the `theirGain` toggle.

## 8. Failure modes

The project rule holds: degrade loudly, never silently.

| condition | behaviour |
|---|---|
| player has no board row (K/DST/retired) | listed as **unvalued**, excluded from every total — never silently zero |
| `traded_picks` fetch fails | banner: pick ownership may be wrong; picks are NOT guessed |
| no `previous_league_id` | keeper costs unknown — say so, grade players at full value with a warning |
| a name/id does not resolve | loud, per `_load_returning`'s precedent |
| Sleeper league settings | **never read for rules** — §1 |

## 9. Testing

`tests/trade_fixture.cjs`, node, pure math — the same gate style as
`optimizer_fixture.cjs`:

1. **The premise.** The same player on a cheap keeper ladder is worth
   materially more than on an expensive one — measured at +51 lineup points for
   R11 against R3. If this fails the whole feature is an additive value chart.
   (This test replaced a roster-shape assertion, which measured 0.8 points
   pre-draft and would have pinned nothing — see §4.1(2).)
2. Acquiring a player who displaces an incumbent keeper spends his
   **inherited** cost round, and frees the displaced player's.
3. Trading away a player who was a keeper returns his cost round to the pool
   AND promotes the next-best eligible player into the slot.
4. `FUTURE_DISCOUNT` compounds per season and 0 seasons ahead is a no-op.
5. A pick past `ROLLOUT_PICKS` grades ~0 on lineup but nonzero on market —
   the documented gap of §3.3.
6. Pick ownership after `traded_picks` is applied, including a pick traded twice.
7. The suggester never proposes a trade with `myGain < 0`.
8. `marketDelta` uses ADP where present and a LABELLED board-rank fallback where
   not.
9. **Keeper competition.** Acquiring a star when both keeper slots are already
   filled by better players gains ~0, not his full value (§3.1a). The one
   assertion that catches the most likely overvaluation bug.
9b. **Ineligibility.** A player whose cost is R2 or lower grades at exactly 0
    pre-draft, however good he is (§3.1b) — last year's first-rounder included.
9c. **Surplus beats talent.** A worse player on a cheap keeper ladder grades
    ABOVE a better player on an expensive one (§3.1c). Pins the inversion the
    whole pre-draft market misses.
10. `FC.sleeper` cache-busts: two calls to the same path produce different URLs
    and carry `cache: "no-store"` (mirrors the assertion already made against
    `draftmode.js`).

## 10. Known inconsistency, deliberately not fixed here

`keepers.js` scores a keeper as `slotWeight * vorp − parVorp(effectivePick)`.
That is a different currency from lineup points, so the trade tool and the
keeper panel will report different numbers for the same player.

This is recorded rather than silently absorbed. Unifying `keepers.js` onto the
lineup objective is the right end state and is a **follow-up spec**, not part of
this one: it changes a shipped, browser-verified tool 15 days before the draft,
and the trade calculator does not require it.

## 11. Out of scope

- In-season trading (separate spec, post-draft)
- 3+ team trades
- K/DST valuation (v1 scope guard)
- FAAB / waiver budget as a trade asset
- Injury or news signals beyond the existing `returning` flag
- Any change to the model, the board payload, or the weekly pipeline
