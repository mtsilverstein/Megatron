# Draft-mode pick-time optimizer (need-weighted VONA) — design

> **SUPERSEDED 2026-08-03 by the v2 lookahead objective.** The scoring rule
> below (`score = vona(X) + w_s·steal(X) − bye_penalty(X)`) shipped, was
> measured against the live 2026 board, and failed. Simulating all 12 draft
> slots for 8 rounds against an ADP field, it spent **42 of 96 picks on tight
> ends** — you start one — and **zero on quarterbacks**. Three causes, each
> traceable to a decision recorded in this document:
>
> 1. **§4's `replacement(pos, gap)` forecasts the field off our own board.**
>    It removes the top `gap` players *by our VORP*, so a player we rate above
>    consensus is assumed to be about to vanish and the score manufactures
>    urgency to take him. At pick #30 it got 5 of the next 12 picks wrong and
>    mispriced the surviving TE by 23.5 VORP points.
> 2. **VORP is used to compare across positions.** It cannot: replacement
>    level is per-position (TE 110, WR 122 PPR points on this board), so a TE
>    outranked a WR who outscores him. This is fine for a dedicated slot and
>    wrong for a flex slot, where you simply start whoever scores more.
> 3. **§4's claim that `steal` is "measured against ECR/board rank, never
>    ADP" is factually wrong in the shipped code**, because
>    `board_rank.rank_board` sorts the board by VORP descending. `steal`
>    therefore reduced to "more VORP than the Nth-best VORP" — VORP re-added
>    under another name, carrying no market information, and paying a bonus
>    for *reaching* (Loveland, ADP 41, drew +5.34 at pick 30).
>
> v2 replaces the whole additive score with a single objective: the projected
> points of the best **starting lineup you can still finish** if you take a
> player now and draft on. Roster completion, positional saturation, timing
> and bye stacking all fall out of it rather than needing separate terms. The
> field is modelled by ADP. Bands and market mispricing became indicators
> instead of score terms. See the module header of `site/assets/optimizer.js`
> for the current contract, and `tests/optimizer_fixture.cjs` for the
> regression tests that pin each of the three failures above.
>
> The rest of this document is kept as the historical record of v1.

**Date:** 2026-07-26
**Status:** SUPERSEDED (implemented as v1/v1.1; replaced by v2 on 2026-08-03)
**Extends:** the live draft overlay shipped in `site/assets/draftmode.js` (which
already computes roster-blind VONA "waiting costs") and the consensus-anchored
board (`docs/superpowers/specs/2026-07-25-consensus-anchored-board-design.md`).

## 1. Context & goal

Draft mode already overlays a live Sleeper draft on the board and shows a
roster-**blind**, informational line: `waiting costs: RB −8.4 · WR −3.1`
(`vonaDeltas`, the VORP you lose at each position by waiting until your next
snake pick). It never says *take this player*, and it ignores what your roster
already has.

This turns that signal into an **actionable, need-weighted pick recommendation**:
a ranked shortlist of the best QB/RB/WR/TE picks *right now*, given who's gone
and what your roster still needs — plus a late-round nudge to fill your K and
D/ST slots. Best-player-available, corrected for roster need and positional
scarcity, without ever going blind to an absolute steal.

**North Star: ECR sets value.** Consistent with the consensus board, the value
base is ECR-anchored (the board's `vorp` is built from `value_points` laid onto
ECR order). ADP is demoted to a market-timing overlay: it only orders the K/DST
late-slot pool and (optionally) signals runs. It never sets value.

## 2. Decisions (locked during brainstorming)

- **Output = ranked shortlist** (top 3–5) with a one-line "why" per row, not a
  single "take X" and not a board-only re-tint. The user still chooses.
- **Objective (stated).** Maximize expected **starting-lineup VORP**, subject to
  filling roster slots, given other drafters pick between your picks. The score
  approximates each player's **marginal contribution** to that objective.
- **Scoring model** (per available player), computed each poll:
  ```
  score = vona(X) + w_s·steal(X) − bye_penalty(X)
  ```
  where `vona(X)` is a single **roster-aware VONA** term (below) that unifies
  value, need, and timing — replacing the earlier `vorp × need + w_u·urgency`
  decomposition, which double-counted scarcity (VORP already prices it) and
  carried two arbitrary weights.
- **`vona(X)` = roster-aware Value Over Next Available:**
  `startValue(X) − replacement(pos, gap)`. `startValue(X)` is X's VORP if he'd
  crack your lineup (an open dedicated **or** flex slot) else a small bench
  value; `replacement(pos, gap)` is the best VORP at his position expected to
  **survive to your next pick** (`gap` picks away). This one term auto-discounts
  deep positions (survivor ≈ X ⇒ vona ≈ 0 ⇒ "wait"), auto-boosts positions about
  to cliff, and collapses a filled position to bench value — no `need` multiplier
  or `w_u` needed. See §6.
- **Timing (`gap`) is measured to your NEXT pick and is active on the clock.**
  The relevant cliff for an on-the-clock decision is "who survives the `gap`
  picks until I pick *again*" — never zero when it's your turn. (The shipped
  `vonaDeltas` line used the gap to your *upcoming* pick, which is 0 on the
  clock; that inversion is corrected here.)
- **`steal(X)`** is measured against **ECR/board rank, never ADP**: getting a
  player later than his consensus value says he should go. Expressed in VORP
  points as surplus over a "par" pick at the current slot (see §6). Kept as a
  separate additive term because trade/price value is a different currency than
  expected starting points — so a genuine steal surfaces **even on a position
  you're heavy at**.
- **`bye_penalty`** is a small ding only when a player would give you a **3rd+
  starter** sharing a bye week (read from the board's `bye` field). Marginal by
  design; never overrides a real value gap.
- **K / D/ST**: no projection (scope guard held — kickers/defenses don't predict
  year-to-year). Handled as a **late-round slot reminder** ordered by **ADP
  only**, flagged "not projected".
- **League shape** (locked): starters QB1 · RB2 · WR2 · TE1 · **FLEX2** (RB/WR/TE)
  · K1 · D/ST1; **5 bench**; **15 total rounds**.
- **Client-side only** (except a small `generate.py` data addition for K/DST
  ADP). Fails soft: any error hides the widget, never touches the board.
- **Weights are principled, documented defaults** — NOT tuned against held-out
  data (that would violate the walk-forward eval rule). Interpretable knobs.

## 3. Non-goals / scope

- No projections for K/DST/IDP (v1 scope guard intact); no DFS, no injury/news.
- No auto-pick, no write access to Sleeper, no persistence beyond the session.
- No re-tuning of the board or its VORP; the optimizer consumes `vorp`/`ecr`/
  `adp`/`bye` as published.
- Auction/unknown draft types: the widget simply doesn't render (same guard the
  existing VONA line already uses — needs snake/linear slot math).

## 4. Architecture & components

| Unit | Status | Responsibility |
|---|---|---|
| pure scoring module (new, in `draftmode.js` or a sibling exported for the fixture) | **new** | `rosterSlots`, `openSlot`, `replacement`, `vona`, `parVorp`, `steal`, `byePenalty`, `scorePlayer`, `rankShortlist`, `lateSlotTrigger` — all pure, node-tested. |
| `updateAids` in `draftmode.js` | **modify** | Replace the roster-blind "waiting costs" line with the ranked shortlist render + late-slot nudge; drive from `state.mine` + board. |
| roster inference | **modify/extend** | Map `state.mine` (my drafted player_ids) → filled starter/flex slots + my drafted players' bye weeks (via the crosswalk / board lookup). |
| `site/index.html` draft panel | **modify** | The `#draft-vona` slot becomes the shortlist container (+ a late-slot line). Minor copy. |
| `generate.py` + `adp.py` | **modify** | Emit a `late_slots` block `{K:[{name,adp}], DST:[...]}` into `draft.json` from the FFCalculator ADP already fetched (K/DST currently filtered out). No projection. |
| `tests/*` (node fixture + python) | **new/modify** | Pure scoring cases; `late_slots` serialization. |

The pure scoring functions are separated from the async poll/render so all the
arithmetic is unit-testable without a network or DOM.

## 5. Data flow (all client-side except the data block)

Each poll, `applyPicks` already builds `state.drafted` (all struck ids) and
`state.mine` (my ids). The optimizer then:

1. **Roster → slots.** From `state.mine`, look each up on the board (by
   `sleeper_id`), count starters per position, derive open dedicated + flex
   slots, and collect my drafted players' `bye` weeks.
2. **Available pool.** Board players not in `state.drafted`, with finite `vorp`
   (same predicate the board render + existing VONA use).
3. **Score** every available QB/RB/WR/TE via §6; take the top 3–5.
4. **Gap to your next pick.** Using `nextPickNumber` twice (this pick and the one
   after), compute `gap` = picks between the current selection and your next
   pick. The `replacement(pos, gap)` in `vona` is the best available at each
   position after `gap` best-VORP picks are removed (the existing `vonaDeltas`
   survivor logic, but over the *next* gap, so it is live on the clock).
5. **Late-slot trigger.** If rounds-remaining ≤ 2 (from `session.rounds` − your
   picks made) and your K/DST slots are unfilled, surface the K/DST nudge from
   `board.late_slots`, ordered by ADP.
6. Render the shortlist + optional nudge into the panel; fail soft.

## 6. Scoring rules (exact, with default constants)

Given the available pool, your roster slots, the current overall pick number
`P`, and `gap` = picks between this selection and your **next** pick (§5.4):

- **Open slot.** `openSlot(pos, roster) ∈ {dedicated, flex, none}`:
  - a dedicated starter slot for `pos` is unfilled → **dedicated**
  - else a **flex** slot is open (your RB+WR+TE surplus beyond dedicated < 2) and
    `pos ∈ {RB,WR,TE}` → **flex**
  - else → **none** (QB/TE reach `none` the moment their single starter is
    filled; they are not flex-eligible).
  `starts = openSlot ≠ none`.
- **`replacement(pos, gap)`** = the `vorp` of the best available player at `pos`
  after the top `gap` available players (by VORP, across all positions) are
  removed — the survivor at your next pick. Floored at 0 (no survivor ⇒
  replacement level, VORP 0 by construction). When `gap = 0` (rare; you pick
  again immediately) it equals the current best at `pos`, so `vona` for an open
  slot is 0 — correct (you can just take him next too).
- **`vona(X)`** (roster-aware Value Over Next Available):
  - `starts` → `vorp(X) − replacement(pos, gap)` (≥ 0). High when X's position
    cliffs before your next pick; ~0 when the position is deep.
  - `!starts` (would ride the bench) → `BENCH_WEIGHT × vorp(X)` (**default
    `BENCH_WEIGHT = 0.2`**) — his standalone depth value, so benched players
    still order sensibly among themselves. This is the sole "need" discount;
    there is no separate multiplier.
- **`parVorp(P)`** = `vorp` of the board player at overall rank `P` (the value
  you'd "normally" get at this pick); if `P` exceeds the board, par = 0.
- **`steal(X)`** = `max(0, vorp(X) − parVorp(P))` — surplus value over a par pick
  at this slot. ECR-anchored (board rank encodes ECR order), in VORP points.
- **`byePenalty(X, roster)`** = `BYE_PEN` (**default 3.0** VORP points) if adding
  X as a *starter* would make ≥ 3 of your starters share his bye week; else 0.
  Only applies when `starts` (a pure-depth/bench pick is not penalized).
- **`scorePlayer`** = `vona(X) + W_STEAL·steal(X) − byePenalty(X)`.
  Default **`W_STEAL = 0.5`** — the only free weight (the unification removed
  `W_URGENCY`). `vona` carries value+need+timing in native VORP points and stays
  dominant; `steal` at 0.5 lets a genuine faller surface even on a filled
  position (a liquid-trade asset) without routinely overriding a real starter
  need.
- **"why" label** per row = the single largest positive contributor:
  - `vona` dominated by an open slot with a low survivor → "fills RB2 · cliff −X
    before your next pick" (or just "fills WR2" when no cliff);
  - `steal` dominant → "steal: ECR r, here at P";
  - benched with no steal → "depth · safe to wait";
  with a bye note appended when penalized.

**Worked check.** Pick #29, WR2 slot open, gap 23. Best WR vorp 40, survivor WR
after 23 picks vorp 22 ⇒ `vona = 18` (fills + cliff). A benched elite RB (all RB
slots full) vorp 100, `parVorp(29)` 45 ⇒ `vona = 0.2·100 = 20`, `steal =
0.5·(100−45) = 27.5` ⇒ score 47.5, and he surfaces *above* the WR as a trade
steal — matching the "don't go blind to a faller" intent, while a *par* benched
RB (vorp≈45, steal 0) scores just `0.2·45 = 9` and correctly sinks.

## 7. UI

Inside the existing draft `<details>`, replacing the roster-blind waiting-costs
line:

```
ON THE CLOCK · pick #29 · your turn in 1        (or: pick #17 · your turn in 6)
  1. Player A (RB)  ★ fills RB2 · cliff −8.4 before your next pick
  2. Player B (WR)  fills WR2
  3. Player C (RB)  steal: ECR 18, here at 29
  4. Player D (TE)  depth · safe to wait
[final 2 rounds:] ⚠ fill K + D/ST — ADP says now:  K Aubrey · Tucker … | DST …  (not projected)
```

- Header shows on-the-clock vs. plan-ahead ("your turn in N") from
  `nextPickNumber`.
- 3–5 rows, each `name (POS)` + one-line why.
- The K/DST nudge is a separate line, only in the final ~2 rounds with the slot
  unfilled.
- Every failure path hides the widget and leaves the board + rest of the panel
  intact (same fail-soft contract as today).

## 8. Data addition (`generate.py`)

- Add `late_slots: { "K": [{name, adp}], "DST": [{name, adp}] }` to `draft.json`,
  built from the FFCalculator ADP already pulled (position=all returns K/DST;
  currently filtered to skill positions). Ordered by ADP ascending. No
  projection, no `vorp`/`ecr`. If the ADP pull yields no K/DST, the block is
  `{"K": [], "DST": []}` and the UI nudge degrades to a generic "grab a K/D-ST".
- Schema-locked like the rest of the payload; a test asserts the block
  serializes and is ADP-ordered.

## 9. Error / fail-soft behavior

- Missing/auction draft type, no slot, empty pool, unmatched roster, or any
  thrown error → the shortlist widget hides; the board and the rest of draft
  mode are untouched. No console errors, no board dependency.
- A player on the roster with no board match (K/DST/retired) is ignored for
  need/bye (counted only toward K/DST slot-fill via position metadata from the
  pick, which `applyPicks` already reads).
- Weights and thresholds are module constants (documented) so they can be tuned
  by inspection, never fit to the held-out 2023–25 seasons.

## 10. Testing

- **Pure (node fixture, `keepers_fixture.cjs` pattern):**
  - `openSlot()` at each roster state: RB dedicated open → `dedicated`; dedicated
    full + flex open → `flex`; flex full → `none`; QB → `none` the moment its
    starter is filled (never `flex`).
  - `replacement(pos, gap)`: with a planted pool, the survivor after `gap`
    best-VORP picks is correct; `gap = 0` ⇒ replacement = current best ⇒ open-slot
    `vona = 0`.
  - `vona()`: open slot at a cliff position scores high; open slot at a deep
    position scores ~0 ("wait"); a benched player scores `BENCH_WEIGHT × vorp`.
  - `parVorp`/`steal`: ECR-15 player available at pick 40 scores a positive
    steal; a par pick scores steal 0.
  - `scorePlayer` ordering (the §6 worked check): a benched elite faller
    (vona `BENCH_WEIGHT·vorp` + steal) outranks a marginal open-slot player; a
    par benched player sinks below every open-slot starter.
  - `byePenalty`: 3rd starter on a shared bye penalized; a benched (`!starts`)
    pick not penalized.
  - `lateSlotTrigger`: fires only when rounds-remaining ≤ 2 and the slot is
    open; K/DST ordered by ADP.
- **Browser E2E (mocked draft, `draftmode` pattern):** connect to a stubbed
  snake draft, feed picks, confirm the shortlist renders, updates as your roster
  fills (need decays), a planted steal surfaces on a heavy position, the cliff
  "why" appears, and the K/DST nudge shows in the final rounds — zero console
  errors, board never disturbed.
- **Python:** `late_slots` present, ADP-ordered, K/DST-only, no projection
  fields; existing suite stays green (`-W error`).

## 11. Open / limitations (documented)

- **Bands unused (planned v1.1 lever).** The optimizer scores on the median
  (`vorp`) and ignores the model's p10/p90 — its own differentiator. A follow-up
  can weight `startValue`/`steal` toward **ceiling (p90)** for bench/flex upside
  darts and **floor (p10)** for must-hit starters, and surface floor→ceiling in
  the "why". Deferred to keep v1 focused on the roster-aware VONA core.
- **Constants are un-tuned defaults** (`W_STEAL = 0.5`, `BENCH_WEIGHT = 0.2`,
  `BYE_PEN = 3.0`). They encode priorities (VONA dominant, steal/bye as nudges),
  not fitted parameters; deliberately so, to respect the no-held-out-tuning rule.
  Revisit only via forward observation.
- **Flex replacement is per-position.** `replacement(pos, gap)` uses the same
  position's survivor, not the best survivor across flex-eligible positions; a
  finer flex model is a possible refinement.
- **Others' picks assumed best-VORP** for the urgency survivor estimate (same
  assumption the shipped VONA line already makes) — real drafters reach/slide,
  so urgency is a guide, not a guarantee.
- **Bye penalty is starter-only and coarse** (a flat ding at the 3rd shared
  bye); it won't model full lineup optimization.
- **Co-owner drafts:** roster inference keys on `picked_by == your user_id`
  (the existing `state.mine` rule); a co-owner's picks won't count.
