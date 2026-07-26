# Draft-mode pick-time optimizer (need-weighted VONA) — design

**Date:** 2026-07-26
**Status:** approved design, pre-implementation
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
- **Scoring model** (per available player), computed each poll:
  ```
  score = vorp × need(pos) + w_u·urgency(pos) + w_s·steal(player) − bye_penalty
  ```
- **`need(pos)`** decays with your live roster but **never to zero** (a floor),
  so an absolute steal stays visible while "6th QB" is killed.
- **`steal`** is measured against **ECR/board rank, never ADP**: getting a
  player later than his consensus value says he should go. Expressed in VORP
  points as surplus over a "par" pick at the current slot (see §6).
- **`urgency`** is the existing VONA waiting-cost (positional cliff before your
  next pick) — the dynamic "given who's gone" push.
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
| pure scoring module (new, in `draftmode.js` or a sibling exported for the fixture) | **new** | `rosterSlots`, `need`, `parVorp`, `steal`, `byePenalty`, `scorePlayer`, `rankShortlist`, `lateSlotTrigger` — all pure, node-tested. |
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
4. **Urgency** reuses the existing next-pick math (`nextPickNumber`) to know how
   many picks fall before yours, and the survivor-at-position after that many
   best-VORP picks (the existing `vonaDeltas` logic, per position).
5. **Late-slot trigger.** If rounds-remaining ≤ 2 (from `session.rounds` − your
   picks made) and your K/DST slots are unfilled, surface the K/DST nudge from
   `board.late_slots`, ordered by ADP.
6. Render the shortlist + optional nudge into the panel; fail soft.

## 6. Scoring rules (exact, with default weights)

Given the available pool, your roster slots, the current overall pick number
`P`, and `until` = picks before yours:

- **`need(pos)`** (QB/RB/WR/TE):
  - dedicated starter slot for `pos` still open → **1.0**
  - dedicated full, a **flex** slot still open (your RB+WR+TE surplus beyond
    dedicated < 2) → **0.7** (`FLEX_NEED`)
  - all `pos`-eligible slots (dedicated + flex) full → **0.35** (`NEED_FLOOR`)
  - QB/TE are not flex-eligible: they go 1.0 → 0.35 the moment their single
    starter is filled.
- **`parVorp(P)`** = `vorp` of the board player at overall rank `P` (the value
  you'd "normally" get at this pick); if `P` exceeds the board, par = 0.
- **`steal(player)`** = `max(0, player.vorp − parVorp(P))` — surplus value over a
  par pick at this slot. ECR-anchored (board rank encodes ECR order). In VORP
  points, so it adds cleanly.
- **`urgency(pos)`** = `now.vorp − survivor.vorp` where `now` is the best
  available at `pos` and `survivor` is the best at `pos` expected to remain after
  `until` best-VORP picks (the existing `vonaDeltas` computation). A player at a
  position about to fall off a cliff gets boosted. `urgency = 0` when it's your
  turn (`until ≤ 0`) or no cliff.
- **`byePenalty(player, roster)`** = `BYE_PEN` (**default 3.0** VORP points) if
  adding this player as a *starter* would make ≥ 3 of your starters share his
  bye week; else 0. Only applies while `need(pos) ≥ FLEX_NEED` (i.e. he'd
  actually start); pure-depth picks aren't penalized.
- **`scorePlayer`** = `vorp × need(pos) + W_URGENCY·urgency(pos)
  + W_STEAL·steal(player) − byePenalty`.
  Defaults: **`W_URGENCY = 0.5`**, **`W_STEAL = 0.5`**. Urgency and steal are
  both already in VORP points; the 0.5 weights keep the static ECR-anchored base
  dominant while letting cliffs and steals reorder near-ties and surface
  genuine outliers.
- **"why" label** per row = the single largest positive contributor among
  {need (as "fills RB2"/"flex"), urgency ("cliff −X"), steal ("ECR r, here at
  P")}, with a bye note appended when penalized. Depth picks (floor need, no
  cliff, no steal) read "depth · safe to wait".

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
  - `need()` at each roster state: RB2 open → 1.0; dedicated full + flex open →
    0.7; flex full → 0.35; QB filled → 0.35 immediately.
  - `parVorp`/`steal`: ECR-15 player available at pick 40 scores a positive
    steal; a par pick scores steal 0.
  - `scorePlayer` ordering: a filled-position elite steal outranks a
    marginal open-need player; a cliff position boosts over an equal-vorp
    non-cliff position.
  - `byePenalty`: 3rd starter on a shared bye penalized; a depth pick (floor
    need) not penalized.
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

- **Weights are un-tuned defaults.** They encode priorities (ECR base dominant,
  cliffs/steals as nudges), not fitted parameters; deliberately so, to respect
  the no-held-out-tuning rule. Revisit only via forward observation.
- **Others' picks assumed best-VORP** for the urgency survivor estimate (same
  assumption the shipped VONA line already makes) — real drafters reach/slide,
  so urgency is a guide, not a guarantee.
- **Bye penalty is starter-only and coarse** (a flat ding at the 3rd shared
  bye); it won't model full lineup optimization.
- **Co-owner drafts:** roster inference keys on `picked_by == your user_id`
  (the existing `state.mine` rule); a co-owner's picks won't count.
