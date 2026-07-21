# Draft-mode QoL — design

**Date:** 2026-07-21 · **Status:** approved
**Feature:** draft-night decision aids in the existing Sleeper draft mode —
pick ticker, on-the-clock countdown, full VONA ("waiting costs") — plus the
four ledgered draft-mode hardening items. All changes live in
`site/assets/draftmode.js` + panel markup/CSS; the board render contract
(`onUpdate` state shape) is unchanged.

## Decisions (approved 2026-07-21)

1. **Full VONA panel** (user choice): per-position cost of waiting until
   your next pick, computed live; naive top-N removal assumption, labeled.
2. No other-user name lookups (mock drafts lack reliable usernames); the
   countdown is self-centric ("pick #48 next · your turn in 3").
3. Non-snake handling: linear drafts get the linear formula; auction or
   unknown types hide VONA/countdown gracefully — never wrong math.

## Components

### Snake/pick math (pure, exported for verification)

- `DraftMode.nextPickNumber(slot, teams, rounds, reversalRound, picksMade)
  -> int | null` — the smallest pick number > `picksMade` belonging to
  `slot`. Standard snake: round r odd → `(r-1)*teams + slot`, even →
  `r*teams - slot + 1`. Third-round-reversal (`settings.reversal_round`,
  nonzero): from that round on, direction parity flips (Sleeper 3RR).
  Linear (`draft.type === "linear"`): every round `(r-1)*teams + slot`.
  Returns null when no pick remains or inputs are missing/invalid.
- `DraftMode.vonaDeltas(players, draftedSet, picksUntilMine) ->
  {QB, RB, WR, TE} | null` — remove the top-`picksUntilMine` remaining
  players by VORP (position-blind), then per position:
  `bestNow.vorp - bestAfterRemoval.vorp` (0 when the position's best
  survives; null overall when inputs are missing). Operates on the board
  payload's players array; no network.

Slot comes from `draft.draft_order[userId]` (fetched at connect; the draft
object is already fetched there). Missing `draft_order` entry (spectator
connect, no username) → aids hidden, strikeouts unaffected.

### Panel additions (markup + CSS, same idiom as existing rows)

- Ticker row: `Recent: 4.10 T.Hill WR · 4.11 K.Walker RB · 4.12 M.Evans WR`
  (last 3 picks, `metadata.first_name/last_name/position`), plus
  `pick #<n+1> next · your turn in <k>` when slot known.
- VONA row: `Waiting costs: RB −12.3 · WR −4.1 · TE −0.8` with a `title`
  tooltip: "assumes the picks before yours take the best available by
  VORP". When `picksUntilMine === 0`: shows `you're on the clock`.
  Positions with no remaining players are omitted from the line.

### Hardening (ledgered items, all in draftmode.js)

1. **Render guard:** picks are append-only → `applyPicks` short-circuits
   (no state rebuild, no `emit`, no roster/ticker DOM writes) when
   `picks.length` equals the previous poll's count. Status text still
   refreshes cheaply.
2. **Draft-complete fallback:** when `session.totalPicks === 0` (Sleeper
   omitted `settings.rounds/teams`), every 10th poll re-fetches
   `/draft/<id>` and stops with "draft complete" when
   `status === "complete"`.
3. **Stored-state guard:** a parsed localStorage blob missing `draftId`
   is cleared and ignored (no panel auto-open, no doomed connect).
4. **Disconnect cosmetics:** disconnect also unchecks + resets
   `hideDrafted`, hides the unmatched note, and clears ticker/VONA rows.

## Error handling

| Case | Behavior |
|---|---|
| Auction / unknown draft type | Ticker shows picks; countdown + VONA hidden |
| No username / not in draft_order | Countdown + VONA hidden; strikes work |
| reversal_round present | 3RR formula branch (covered by fixture check) |
| Missing pick metadata fields | Ticker entry falls back to position-only, never throws |
| Any computation input missing | The aid renders nothing — never a wrong number |

## Testing

No JS test framework (site invariant). The risky logic is pure and
exported: a node fixture script (run during implementation, reported in
the task report, not committed under `site/`) exercises
`nextPickNumber` (odd/even rounds, 3RR, linear, exhausted draft, bad
inputs → null) and `vonaDeltas` (removal ordering, position omitted when
empty, zero-delta when best survives). Browser E2E against the completed
test draft (289646328508579840): ticker renders 3 entries, render guard
verified (no tbody churn between unchanged polls — observable via a DOM
mutation counter in the console), complete-detection still fires. Python
suite stays green (no Python changes). The live mock-draft rehearsal
remains the real-time acceptance test.

## Out of scope

Other-user names in the ticker; auction VONA; ADP-based removal models;
roster-need weighting of VONA; any Python/payload changes.
