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
| keepers | up to 2 | `Keepers.MAX_KEEPERS` |
| keeper cost | `originalRound − (season − originalYear)`; waiver ladder starts R12 | `Keepers.keeperCost` |
| keeper eligibility | cost ≥ R3, else back to the pool | `Keepers.eligible` |
| **keeper cost on trade** | **follows the player** — new owner inherits the round and the years-kept clock | league restatement, 2026-08-04 |
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
12th-round pick rarely changes a starting lineup. The market column (§4) will
still show it has trade value, and that gap is itself a tradeable edge:
*the market pays for this pick and it will not change my lineup.*

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

1. **Roster-shape math.** Your surplus RB is worth ~0 to you and a lot to an
   RB-poor team. Measured at +120 points of draft edge in the backtest.
2. **Keeper-cost arbitrage.** The cost ladder is league-specific and routinely
   misjudged by managers; `keepers.js` computes it exactly, and
   `buildOriginalByPlayerId` gives it for *every* player in the league.
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

1. **The premise.** A surplus RB scores ~0 for a team with 4 RBs and high for a
   team with 1. If this fails the whole feature is an additive value chart.
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
