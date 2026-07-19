# Sleeper draft mode — design

**Date:** 2026-07-19 · **Status:** approved
**Feature:** live draft-night mode on the draft board — connect to a Sleeper
draft, strike drafted players in real time, track your own roster, keep the
remaining pool VORP-sorted as a best-available cheat sheet.

## Goals and constraints

- Draft board live ~Aug 20 2026; the user's real Sleeper draft night is the
  acceptance test. Practice runs use Sleeper mock drafts.
- Fits every site invariant: static GitHub Pages, no backend, no framework,
  no secrets, free tier only. Sleeper's API is public and read-only — no
  auth, no OAuth, no account linking.
- Sleeper's `/v1/players/nfl` dump (~5MB) is documented as ≤1 call/day. It is
  fetched only at site-generation time, never on draft night in the browser.
- Scope guard v1 unchanged: the board carries QB/RB/WR/TE only. K/DST picks
  exist in Sleeper drafts; they are counted but never displayed as rows.

## Decision summary (approved 2026-07-19)

1. **Crosswalk baked into `draft.json`** at `--draft` generation time — a
   nullable `sleeper_id` per player plus a `crosswalk` stats block. No
   separate map file, no runtime join, no browser-side player dump.
2. **Sleeper fetch failure aborts the `--draft` generation run** (project
   fail-safe invariant). The published site keeps its last-good data,
   which includes the last-good crosswalk. The weekly in-season cron never
   touches Sleeper (it runs `--week auto` without `--draft`), so scheduled
   automation cannot be broken by a Sleeper outage.
3. **Panel scope: strikeouts + my-roster tracker.** Drafted players
   struck/greyed with a hide-drafted toggle; the user's own picks
   highlighted; a one-line roster tracker (`QB n · RB n · WR n · TE n ·
   +n other`). No pick ticker.

## Architecture

### Build side — `src/ffmodel/site/sleeper.py` (new)

- `pull_sleeper_players(cache_dir) -> dict` — GET
  `https://api.sleeper.app/v1/players/nfl`, cache the raw JSON under
  `data/raw/` (same convention as the nflverse pulls). Any fetch/parse
  failure raises; `generate.py` lets that propagate (fail-safe abort).
- `build_crosswalk(board_players, sleeper_players) -> (mapping, stats)` —
  `mapping: {gsis player_id -> sleeper_id}`, `stats` with counts per match
  path. Matching order:
  1. **Exact `gsis_id`** — Sleeper's `gsis_id` field is known to carry stray
     whitespace; `.strip()` before comparing. Our `player_id` is already
     GSIS format (`00-00xxxxx`).
  2. **Normalized name + position** for the remainder: lowercase; strip
     periods, apostrophes, hyphens; strip Jr/Sr/II/III/IV suffixes. If a
     normalized (name, position) key is ambiguous on either side, the player
     is counted **unmatched** — never guess, a silent wrong strikeout is the
     one unacceptable failure mode.
  3. Everything else → unmatched (rookies are the expected weak spot).

### Payload — `draft.json` additions (in `draft.py`)

- Per player: `"sleeper_id": str | null`.
- Top-level `"crosswalk"` block:
  `{"matched_gsis": int, "matched_name": int, "unmatched": int,
  "unmatched_names": [str, ...]}` — powers the visible "couldn't match N
  players" notice; `unmatched_names` keeps the failure inspectable.
- `generate.py`: the Sleeper fetch + crosswalk runs **only when `--draft`
  is set**. Weekly-only runs are byte-identical to today.

### Draft night — `site/assets/draftmode.js` (new) + panel on `index.html`

Connection flow (all `api.sleeper.app`, read-only, CORS-open):

1. Username → `GET /v1/user/<name>` → `user_id`.
2. `GET /v1/user/<user_id>/drafts/nfl/<season>` (season from the loaded
   `draft.json` payload, not hardcoded) → list of drafts (league drafts
   and mock drafts both appear here) → user picks one, shown with type,
   status, and start time. Fallback: paste a Sleeper draft URL or raw
   `draft_id` directly (covers any discoverability gap).
3. Poll `GET /v1/draft/<draft_id>/picks` every 3 s while the draft is live.
   Pause polling when `document.hidden`; resume on visibility. On fetch
   errors: exponential backoff and a visible "reconnecting…" state. Stop
   when the draft status is complete.
4. `localStorage` persists `{username, user_id, draft_id}` — a mid-draft
   refresh reconnects without re-entering anything. Explicit Disconnect
   clears it.

### Board integration (changes to the `index.html` board script)

- Drafted = pick's Sleeper `player_id` ∈ board `sleeper_id`s. Struck/greyed
  **in place** — rows don't move, tier shelves don't jump. A hide-drafted
  toggle collapses them.
- Picks with `picked_by === user_id` are additionally highlighted as "yours";
  the roster tracker counts them by position. K/DST (and any pick matching
  no board row) count in `+n other` using Sleeper's own position metadata.
- Board players with `sleeper_id === null` can never be struck: the panel
  shows "couldn't match N board players to Sleeper" (from the `crosswalk`
  block) whenever N > 0. Unmatched picks are simply not struck.
- Draft mode is strictly additive: with the panel unused, the board renders
  exactly as today. Every Sleeper call in the browser is non-fatal — a
  draft-mode error can degrade the panel but never break the board.

## Error handling

| Failure | Behavior |
|---|---|
| Sleeper fetch fails at `--draft` generation | Run aborts; published site keeps last-good data (incl. crosswalk) |
| Ambiguous name+position match at build | Counted unmatched; listed in `unmatched_names` |
| Username not found on draft night | Inline panel error, board untouched |
| No 2026 drafts for the user | Panel message + direct draft-id paste path |
| Picks polling errors mid-draft | Backoff + "reconnecting…" indicator; last-known strikeouts stay |
| Pick has no board match | Ignored for strikeouts; counted in roster "+other" if it's yours |
| Board player has null `sleeper_id` | Visible unmatched-count notice; never struck |

## Testing

- **pytest (build side):** gsis match incl. whitespace quirk; name
  normalization (case, punctuation, suffixes); ambiguity → unmatched;
  rookies/unknowns → unmatched with names listed; crosswalk stats add up;
  `draft.json` schema (nullable `sleeper_id`, `crosswalk` block, strict
  JSON-serializable); `--draft` generation aborts when the Sleeper pull
  raises; weekly-only generation performs no Sleeper fetch.
- **Browser side:** `draftmode.js` kept small and mostly declarative; no JS
  test framework is introduced. Verification is live: connect to a real
  Sleeper mock draft from the deployed Pages origin (also confirms CORS on
  `api.sleeper.app` in production conditions) and watch picks strike in
  real time.
- **Implementation-time verifications** (assumed true, must be confirmed):
  CORS headers on all four endpoints used; mock drafts appearing under
  `/v1/user/<id>/drafts/nfl/2026`; `gsis_id` coverage rate in the current
  player dump (expect high for veterans, weak for rookies).

## Out of scope (v1)

Pick ticker / on-the-clock indicator; keeper or dynasty handling; auction
drafts; positional-need advice; any Sleeper write operations; weekly-page
integration.
