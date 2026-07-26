# Keeper auto-fill from Sleeper (multi-year) — design

**Date:** 2026-07-26
**Status:** approved design, pre-implementation
**Extends:** the manual keeper gauge shipped 2026-07-25 (`site/assets/keepers.js`),
spec `docs/superpowers/specs/2026-07-25-consensus-anchored-board-design.md` §7.

## 1. Context & goal

The keeper tool recommends whom to keep (positive-surplus only) from candidates
you enter by hand. This adds two things:

1. **Multi-year cost.** The league keeps players across years, and a keeper's
   cost drops one round per year kept, anchored to his **original** draft round.
   The current tool only knows the single-year "round − 1" rule; this makes the
   cost model escalation-aware.
2. **"Load from Sleeper".** A standalone button pulls your end-of-last-season
   roster and traces each player's original draft round + year from your past
   Sleeper seasons, pre-filling the candidates. Manual entry and per-row override
   stay.

## 2. Decisions (locked during brainstorming)

- **Cost escalates from the original draft:**
  `cost = max(1, original_round − (current_season − original_year))` — one round
  costlier per year kept, anchored to where the player was **originally** drafted
  (by any team; traded-for players keep that original round).
- **Waiver pickups** (never drafted) cost **R12 flat**; multi-year waiver
  escalation is NOT auto-computed (manual override).
- **Eligibility** (the "no keepers from rounds 1–2" rule) is judged on the
  **original** draft round: `eligible = isWaiver || original_round > 2`.
- **Standalone connection:** the keeper panel has its own username field +
  "Load" button; it does NOT require the live draft-mode connection.
- **Roster source** = your **end-of-last-season** roster.
- **Prefilled rows stay editable** (override original round/year, mark waiver,
  remove). Manual entry covers anyone the API misses.
- **Client-side only**, no backend; reuses draft-mode's Sleeper fetch pattern and
  the `sleeper_id` crosswalk baked into `draft.json`. `current_season` comes from
  `draft.json`'s `season` field.

## 3. Non-goals / scope

- No Python, no backend, no build step; the published board never depends on this
  (an in-browser convenience that fails soft).
- K/DST are out of model scope; roster players with no board entry are skipped
  with a count note, not valued.
- No persistence beyond the page session; no write access to Sleeper.
- No multi-year waiver escalation, no co-owner roster matching (documented
  limitations; manual entry covers them).

## 4. Architecture & components

| Unit | Status | Responsibility |
|---|---|---|
| pure cost model in `site/assets/keepers.js` | **modify** | `keeperCost`/`eligible`/`surplus`/`rankKeepers`/`recommendKeepers` become escalation-aware (take a candidate carrying `originalRound`/`originalYear`/`isWaiver`, plus `currentSeason`). |
| `buildKeeperCandidates(...)` | **new** (in `keepers.js`, exported) | From (roster player_ids, `originalByPlayerId`, `boardBySleeperId`) → candidate objects + a skipped-count. Node-fixture tested. |
| `loadFromSleeper(...)` orchestration | **new** (in `keepers.js`) | The async fetch chain (username → league → chain walk → candidates). Browser-side, fail-soft. |
| `site/index.html` | **modify** | "Load from Sleeper" row (username input + button + status/league-picker slot); manual form fields change to **original round + year** (+ waiver). |
| `tests/keepers_fixture.cjs` | **modify** | Escalation cost cases + `buildKeeperCandidates` (original vs escalated re-entry, waiver, R1–2 ineligible on original, off-board skip). |

The pure cost model + `buildKeeperCandidates` are separated from the async fetch
so all the arithmetic and mapping is unit-testable without a network.

## 5. Data flow (all client-side)

On "Load" with username `u` (let `S` = `draft.json`'s `season`, e.g. 2026):

1. `GET /v1/user/<u>` → `user_id` (bad username → null → message).
2. `GET /v1/user/<user_id>/leagues/nfl/<S>` → leagues.
   0 → "no <S> leagues for that user"; 1 → use it; >1 → league picker (name
   buttons), continue on selection.
3. `GET /v1/league/<lid_S>` → `previous_league_id` (last season's league).
   null → "no prior season found — enter keepers manually".
4. **Roster (whom you can keep):** `GET /v1/league/<prev_lid>/rosters` → the
   roster whose `owner_id == user_id` → its `players` (Sleeper player_ids). Not
   found → message.
5. **Original draft round + year:** walk the `previous_league_id` chain backward
   from `prev_lid` (last season → the one before → …, until `previous_league_id`
   is null or a safety cap of 8 hops). For each league in the chain:
   `GET /v1/league/<id>/drafts` → pick the completed draft (`/drafts` returns
   newest first; first with `status == "complete"`, else the first) →
   `GET /v1/draft/<id>/picks`; record per `player_id` the `(round, season)`,
   **keeping the earliest season seen** (that is his original draft — later
   escalated re-entries are ignored). `season` comes from the draft object's
   `season` field.
6. `buildKeeperCandidates(rosterPlayerIds, originalByPlayerId, boardBySleeperId)`
   → candidate objects + skipped count; render via the recommender with
   `currentSeason = S`.

`boardBySleeperId` is built once at init from `board.players` (each carries
`sleeper_id`) → `{ name, position, adp_round, overallRank }`.

## 6. Rules

`buildKeeperCandidates`, per roster `player_id`:

- Map to the board via `sleeper_id`. No match → add to `skipped` (K/DST/retired/
  deep), emit no candidate.
- If `player_id` in `originalByPlayerId` → `originalRound`, `originalYear` from
  its earliest-season pick. Else → `isWaiver = true` (no original draft found).
- Emit `{ name, position, originalRound, originalYear, isWaiver, adpRound,
  overallRank }`.

Pure cost model (escalation-aware), given `currentSeason`:

- `keeperCost(c, currentSeason)` = `c.isWaiver ? 12 : max(1, c.originalRound −
  (currentSeason − c.originalYear))`.
- `eligible(c)` = `c.isWaiver || c.originalRound > 2`.
- `valueRound(adpRound, overallRank)` = `adpRound ?? ceil(overallRank / 12)`
  (unchanged).
- `surplus(c, currentSeason)` = `keeperCost − valueRound`.
- `rankKeepers` / `recommendKeepers(candidates, currentSeason, max = 2)` —
  recommend positive-surplus only, best ≤ 2, "keep none" otherwise (unchanged
  policy).

Render (unchanged shape): "Keep: …" headline, editable per-player breakdown
(`keep for R{cost} · worth R{value} · ±{surplus}`), ineligible rows greyed, and a
"N skipped (not on board)" note.

## 7. Error / fail-soft behavior

Every network step is wrapped; on any failure (fetch error, 404, empty result,
missing `previous_league_id`, roster/user mismatch, a mid-chain hop failing) the
panel shows a specific inline message and the **manual add form stays fully
functional**. A partial chain walk still yields candidates for the players it did
resolve. A load never throws to the console or blanks the panel. Re-clicked loads
are guarded by a generation token so a stale response can't overwrite a newer one.

## 8. Testing

- **Pure** (`tests/keepers_fixture.cjs`):
  - `keeperCost` escalation: drafted R10 in `S−1` → R9 at `S`; R10 in `S−2` →
    R8; floor at R1; waiver → R12 regardless of year.
  - `eligible` on original round: original R2 → ineligible; R3 → eligible; waiver
    → eligible.
  - `buildKeeperCandidates`: a player whose earliest pick is `S−2` (kept, so also
    appears escalated in `S−1` — earliest wins), a waiver player (not in any
    draft → isWaiver), an R1–2-original player (ineligible downstream), an
    off-board player_id (skipped + counted).
  - `recommendKeepers` still returns positive-surplus best-≤2 / empty.
- **Browser E2E** at acceptance: "Load" against the user's real league — roster +
  original rounds/years pre-fill, escalated costs look right for multi-year
  keepers, overrides work, bad username / prior-less league fails soft, zero
  console errors.
- No CI/pytest impact (client-side only); the node fixture is the automated gate,
  the browser check the acceptance gate.

## 9. Open / limitations (documented)

- **Multi-year waiver escalation** is not auto-computed (waiver → R12 flat);
  override manually if you've kept an undrafted player several years.
- **Co-owners:** if you are a Sleeper `co_owner` rather than the `owner_id` of
  last season's roster, v1 won't auto-match it — manual entry covers it.
- **History horizon:** if the `previous_league_id` chain doesn't reach a player's
  original draft (very long-kept player + truncated league history) and kept
  players never re-entered past drafts, he falls to waiver (R12) — override
  manually. When kept players DO re-enter past drafts at escalated rounds, the
  earliest available pick still yields the correct cost (the round already
  encodes the escalation), so truncation is harmless in that common case.
