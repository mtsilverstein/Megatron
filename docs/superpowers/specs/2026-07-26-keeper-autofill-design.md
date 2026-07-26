# Keeper auto-fill from Sleeper — design

**Date:** 2026-07-26
**Status:** approved design, pre-implementation
**Extends:** the manual keeper gauge shipped 2026-07-25 (`site/assets/keepers.js`),
spec `docs/superpowers/specs/2026-07-25-consensus-anchored-board-design.md` §7.

## 1. Context & goal

The keeper tool currently takes manual entry: you type each keeper-eligible
player and the round you drafted him last year, and it recommends whom to keep
(positive-surplus only). This adds a **"Load from Sleeper"** path that pulls your
end-of-last-season roster and last year's draft rounds from the Sleeper API and
pre-fills those candidates, so you don't hand-enter them. Manual entry and
per-row override stay.

## 2. Decisions (locked during brainstorming)

- **Standalone connection.** The keeper panel has its own username field +
  "Load" button; it does NOT require the live draft-mode connection (keeper
  decisions happen pre-draft, before a draft lobby exists).
- **Keeper cost is uniform**: the round the player was drafted last season by
  **any** team, minus 1. Traded-for players keep their original draft round.
  Players not in last year's draft (waiver pickups) cost **R12** flat.
- **Roster source** = your **end-of-last-season** roster (whom you can keep from).
- **Every prefilled row stays editable** (override round, mark waiver, remove).
- **Client-side only**, no backend; reuses draft-mode's Sleeper fetch pattern and
  the `sleeper_id` crosswalk already baked into `draft.json`.

## 3. Non-goals / scope

- No Python, no backend, no build step; the published board never depends on this
  (it is an in-browser convenience that fails soft).
- K/DST are out of model scope; roster players with no board entry are skipped
  with a count note, not valued.
- No caching/persistence beyond the page session; no write access to Sleeper.
- Not tied to draft mode; no shared state with the live-draft panel.

## 4. Architecture & components

| Unit | Status | Responsibility |
|---|---|---|
| `site/assets/keepers.js` | modify | Gains the "Load from Sleeper" UI + a fetch orchestration function; reuses existing `costRound`/`eligible`/`surplus`/`recommendKeepers` and the render. |
| pure `buildKeeperCandidates(...)` | new (in `keepers.js`, exported) | From (roster player_ids, draft picks, board players) → candidate objects the existing pipeline consumes. Node-fixture tested. |
| `site/index.html` | modify | A "Load from Sleeper" row (username input + button + status/league-picker slot) inside the keeper `<details>`. |
| `tests/keepers_fixture.cjs` | modify | Cover `buildKeeperCandidates` (waiver default, R1–2 ineligible, off-board skip, traded-player original round). |

The pure core (`buildKeeperCandidates`) is separated from the async fetch so the
cost/eligibility/mapping logic is unit-testable without a network.

## 5. Data flow (all client-side)

On "Load" with a username `u`:

1. `GET /v1/user/<u>` → `user_id` (bad username → null → message).
2. `GET /v1/user/<user_id>/leagues/nfl/2026` → leagues.
   - 0 → "no 2026 leagues for that user"; 1 → use it; >1 → render a league picker
     (name buttons), and continue on selection.
3. `GET /v1/league/<lid_2026>` → `previous_league_id`.
   - null → "no prior season found for this league — enter keepers manually".
4. `GET /v1/league/<prev_lid>/rosters` → the roster whose `owner_id == user_id`
   → its `players` (Sleeper player_ids). (Not found → message.)
5. `GET /v1/league/<prev_lid>/drafts` → pick the draft (`/drafts` returns newest
   first; take the first entry with `status == "complete"`, else the first) →
   `draft_id`; `GET /v1/draft/<draft_id>/picks` → build `roundByPlayerId` from
   `player_id` → `round`.
6. `buildKeeperCandidates(rosterPlayerIds, roundByPlayerId, boardBySleeperId)`
   produces candidate objects; feed them to the existing recommender render.

`boardBySleeperId` is built once at init from `board.players` (each carries
`sleeper_id` from the baked crosswalk) → `{ name, position, adp_round,
overallRank }`.

## 6. Rules (in `buildKeeperCandidates`)

For each Sleeper `player_id` on the roster:

- **Map to the board** via `sleeper_id`. No match → collect into a "skipped"
  list (K/DST/retired/deep); do not emit a candidate.
- **Drafted round** = `roundByPlayerId[player_id]` if present, else mark
  `isWaiver = true` (cost R12). Traded-for players appear in the draft picks
  under their original round, so this yields their original round automatically.
- Emit `{ name, position, draftedRound, isWaiver, adpRound, overallRank }`.

Downstream (unchanged): `costRound` = `isWaiver ? 12 : draftedRound - 1`;
`eligible` = `isWaiver || draftedRound > 2`; `surplus` = cost − value;
`recommendKeepers` = positive-surplus, best ≤ 2. The render shows the "Keep: …"
headline, the editable per-player breakdown, and a "N skipped (not on board)"
note.

## 7. Error / fail-soft behavior

Every network step is wrapped; on any failure (fetch error, 404, empty result,
missing `previous_league_id`, roster/user mismatch) the panel shows a specific
inline message and the **manual add form remains fully functional**. A load
never throws to the console or blanks the panel. Concurrent/re-clicked loads are
guarded so a stale response can't overwrite a newer one (the draft-mode
`pollSeq`-style generation token, scoped to loads).

## 8. Testing

- **Pure**: `buildKeeperCandidates` via `tests/keepers_fixture.cjs` — a drafted
  player (round − 1 downstream), a traded player under his original round, a
  waiver pickup (→ R12), an R1–2 player (ineligible downstream), and an
  off-board player_id (skipped, counted). Assert the emitted candidate objects.
- **Browser E2E** at acceptance: load against the user's real Sleeper league
  (last season), confirm the roster + rounds pre-fill, the recommendation
  matches, overrides work, and a bad username / prior-less league fails soft with
  zero console errors.
- No CI/pytest impact (client-side only); the node fixture is the automated gate,
  the browser check is the acceptance gate — the established pattern for this
  repo's JS.

## 9. Open / tunable

- Waiver keeper round (12) and the R1–2 ineligibility come from the league rules
  already encoded in `keepers.js`; unchanged here.
- If the user is a co-owner (Sleeper `co_owners`) rather than `owner_id`, v1 does
  not match that roster — documented limitation, manual entry covers it.
