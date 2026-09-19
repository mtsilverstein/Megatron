# Shared Sleeper Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one Sleeper identity, one league, one loaded roster, shared by every page — the seven username inputs and four "Load my league" buttons become one identity chip; the roster matcher, league registry and freshness bookkeeping live in one module.

**Architecture:** `site/assets/session.js` (UMD `Session`) owns identity (persisted, public), the supported-league registry (`FC.REGISTRY`), and an immutable per-document league bundle with two roster timestamps and generation tokens. The chip renders inside the existing `#league-context` panel. Controllers are switched one page at a time, each keeping its own contract checks and freshness gates; the legacy inputs are removed only when a page's controllers no longer read them.

**Tech Stack:** browser JS (UMD, no build) tested with `node tests/<name>_fixture.cjs`; no Python.

**Spec:** `docs/superpowers/specs/2026-09-18-shared-sleeper-session-design.md` (rev 2). Read it first; §4 (module), §5 (controller table), §7 (storage) are the contracts.

## Global Constraints

- Every Sleeper endpoint goes through `Sleeper.get` (unique query key, `no-store`, 4 s abort). Never `fetch` Sleeper directly (spec §4.4.4).
- Bundle is immutable once committed; `rostersFetchedAt` never advances on a failed or partial refresh (spec §4.1).
- Two roster timestamps: `rostersRequestedAt` (taken before the rosters request) and `rostersFetchedAt` (after). Waiver/start-sit `snapshotAt` = requested; UI expiry = fetched (spec §4.2, §5).
- Generation tokens on `identify`/`ready`/`refresh`; a stale result fires nothing (spec §4.1).
- Entering `identifying`/`loadingLeague` clears `myRoster` and fires `onChange` first; controllers hide/disable account-derived surfaces on that event (spec §4.1, §4.4.2).
- Exact matcher everywhere: owner or co-owner, exactly one; zero or two → `myRosterStatus` `"none"`/`"ambiguous"` and the message `Could not uniquely match this account to a roster in this league.` (spec §4.4.2).
- Live `/league/<id>` id must equal the static board's `league.league_id` or `ready()` rejects with `live league does not match this board; refusing to load advice` (spec §3).
- ESPN slug makes zero Sleeper calls (spec §3).
- Storage keys exactly as spec §7; `forget()` deletes `megatron:session:identity`, legacy `megatron:sleeper-username`, and every `fc-draft-mode:*` key.
- No polling is introduced: waiver/start-sit keep tick-and-expire at 60 s with explicit refresh (spec §5).
- Every JS fixture green after every task (`for f in tests/*_fixture.cjs; do node "$f" || exit 1; done`); commit after every task with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Registry + `session.js` core + fixture

**Files:**
- Modify: `site/assets/app.js` (add `FC.REGISTRY`; nav label rule reads `tools`; keep `LEAGUES`/`LEAGUE_SLUGS` derived from it)
- Create: `site/assets/session.js`
- Create: `tests/session_fixture.cjs`
- Modify: `tests/navigation_fixture.cjs` only if it asserts `LEAGUES` shape (read it first)

**Interfaces:**
- Produces `FC.REGISTRY` (spec §3 literal), `FC.registryFor(slug) -> entry | null`.
- Produces `Session` with: `identify(username)`, `forget()`, `ready({ slug, board, get? })`, `refresh({ scope })`, `catalog()`, `leaguesFor()`, `onChange(fn) -> unsubscribe`, `state()` (`"anonymous"|"identifying"|"identified"|"loadingLeague"|"ready"|"refreshing"|"error"`), `bundle()` (committed bundle or null), `identity()`; pure `identifyRoster(rosters, userId)`, `chipText(bundle, stateName, nowMs)`, `readIdentity(storage)`, `migrateLegacy(storage)`. `get` defaults to `Sleeper.get`; injectable for tests. Storage injectable via `Session._storage(obj)` for tests.
- `ready` takes the already-loaded static `board` so the live/static id check needs no extra fetch.

- [ ] **Step 1: Fixture (write first)** — `tests/session_fixture.cjs` with a fake `get` (path → canned JSON or rejection, records calls) and a fake storage (`Map`-backed object with `getItem/setItem/removeItem/key/length`, plus a variant whose methods throw). Checks, each a `check(name, fn)` group:
  1. `identify("max")` resolves identity `{username, userId:"u1", displayName}`, persists `megatron:session:identity`, state `identified`; missing `user_id` rejects `/was not found/`, state `error`, nothing persisted.
  2. `ready({slug:"gabagool", board})` with identity: calls exactly `/league/L`, `/league/L/users`, `/league/L/rosters`, `/state/nfl` (assert the call list, order-insensitive); bundle has `registry.leagueId==="L"`, `myRosterStatus:"found"`, `rostersRequestedAt <= rostersFetchedAt`.
  3. `ready` without identity → `myRosterStatus:"anonymous"`, `myRoster:null`.
  4. Live id mismatch (board.league.league_id ≠ league.league_id) → rejects `/does not match this board/`; `bundle()` is null afterwards.
  5. `identifyRoster`: owner → found; co-owner → found; none → throws the exact message; two → throws.
  6. `refresh({scope:"rosters"})` calls only rosters+state; new bundle with later `rostersFetchedAt`; `users` object identity unchanged. `refresh({scope:"league"})` calls league+users+rosters+state.
  7. Failed refresh (rosters rejects) → `refresh` rejects, `bundle()` is the OLD bundle with the OLD timestamps, state back to `ready`.
  8. Generation: start `ready` for slug A (rosters promise pending), start `ready` for slug B and resolve it, then resolve A → `bundle().registry.slug === "B"`, and `onChange` fired for B's commit but not for A's.
  9. Entering `identify` fires `onChange` synchronously with `myRoster:null` before the network resolves (assert via a subscriber that records `bundle().myRoster` at first fire).
  10. `catalog()` twice → one `/players/nfl` call; rejection propagates and the next call retries.
  11. ESPN: `ready({slug:"espnfam", board})` resolves a bundle with `registry.platform:"espn"`, `league:null`, `myRosterStatus:"anonymous"` and makes ZERO `get` calls.
  12. Storage: corrupt JSON in `megatron:session:identity` → `identity()` null, no throw; throwing storage → identify still resolves (memory-only) and `state()` is `identified`; `migrateLegacy` moves `megatron:sleeper-username` into a pending username (returned) and deletes the key.
  13. `forget()` deletes `megatron:session:identity`, `megatron:sleeper-username`, `fc-draft-mode:gabagool`, `fc-draft-mode:fam` (seeded), keeps unrelated keys; fires `onChange`; `bundle().myRoster === null`, league data retained.
  14. `chipText` for states anonymous / ready(found) / none / ambiguous / error / espn — assert the exact strings from spec §6 (`Max973 · Gabagool Fools · your roster: 9 · rosters 14 s ago` given `nowMs = rostersFetchedAt + 14000`; the ambiguity message; `Remembered on this device until you choose forget.`).
  15. Unknown slug → `ready` rejects `/Unknown league/`; no calls.
  16. `leaguesFor()` without a bundle rejects; with one, calls `/user/u1/leagues/nfl/<state.season>`.
- [ ] **Step 2: Run → module not found.**
- [ ] **Step 3: Implement** `session.js` per spec §4 (UMD like `ros.js`; resolve `Sleeper` lazily inside functions, never at load; `get` injectable). Team names: `users.find(u => u.user_id === roster.owner_id)?.metadata?.team_name || display_name || "Roster <id>"` (same rule as `TradeMode.teamName`). Add to `app.js`: `const REGISTRY = [...]` (spec §3 literal), `LEAGUES = REGISTRY.map(r => [r.slug, r.label])`, export `REGISTRY, registryFor`; nav rule: `if (!entry.tools[toolFor(url.pathname)])` → `" · not connected"` where `toolFor` maps `trade.html→trade, weekly.html→startsit, waivers.html→waivers` (index/about/connect always connected). Keep `SUFFIXES` stripping.
- [ ] **Step 4: Run all fixtures green.** `navigation_fixture` must still pass (labels unchanged for the three slugs today).
- [ ] **Step 5: Commit** `feat: Session module and league registry (identity, immutable bundle, two roster timestamps)`.

---

### Task 2: Identity chip in `#league-context`

**Files:** `site/assets/app.js` (`mountLeagueContext`), `site/assets/style.css` (chip layout, mobile one-row), `tests/navigation_fixture.cjs`, all six `site/*.html` (add `<script src="assets/session.js?v=1"></script>` immediately before `app.js`; bump `app.js?v=recovery6` → `?v=session1` everywhere), `tests/shared_assets_fixture.cjs` (add `session.js` to the shared list).

**Interfaces:** `FC.mountLeagueContext(slug)` now renders the chip via `Session.chipText` and subscribes to `Session.onChange`; exposes `FC.chip.refresh()` for controllers that want to trigger the chip's refresh action programmatically. The chip's controls: username input `#session-user` + `#session-use` button (anonymous state), `#session-refresh`, `#session-change`, `#session-forget`, age `#session-age` ticking every 1 s from `bundle().rostersFetchedAt`.

- [ ] **Step 1:** Extend `navigation_fixture` (it builds a fake DOM for `app.js` — read how) to assert: chip mounted inside `#league-context` on each page; anonymous state shows `#session-user`; after a stubbed `Session` bundle, the text matches `chipText`; ESPN shows identity only and no refresh button. Add to `shared_assets_fixture`: `'session.js'`.
- [ ] **Step 2:** Implement. On `#session-use` submit: `Session.identify(v).then(() => Session.ready({slug, board}))` — `board` comes from `FC.stampHeader`'s payload? No: the page's bootstrap already loads the board; expose it with `FC.setBoard(board)` (Task 2 adds; each page's inline script calls it right after `loadJSON`) so the chip can call `ready`. Until a page sets it, the chip only identifies. Migration: on mount, `Session.migrateLegacy(localStorage)` → if it returns a username and no identity is stored, prefill `#session-user` (do NOT auto-identify — one explicit click). Remove the legacy autofill block (`app.js:48-56`) — the inputs it targets go away in Tasks 3–6; leave the selector list until then, minus nothing (harmless).
- [ ] **Step 3:** Fixtures green. **Step 4: Commit** `feat: identity chip in the league panel`.

---

### Task 3: Waiver desk and start-sit on the session

**Files:** `site/assets/waivermode.js`, `site/assets/startsitmode.js`, `site/waivers.html`, `site/weekly.html`, `tests/waivermode_fixture.cjs`, `tests/waivers_fixture.cjs` (only if `loadWorld` is exercised there — check).

**Interfaces:** `WaiverMode.loadWorld({ bundle, board, week, get })` — reads `league`, `rosters`, `myRoster` from the bundle; still runs `validateContract`/KNOWN_LEAGUES check via `bundle.registry.leagueId === board.league.league_id`; fetches only `/league/<id>/transactions/<week>`; returns `{ league, rosters, rosterId, transactions, fetchedAt: bundle.rostersFetchedAt, requestedAt: bundle.rostersRequestedAt }`; throws the exact matcher message when `myRosterStatus !== "found"`.

- [ ] **Step 1 (waivers):** in `init()`: replace the `#waiver-connect` submit flow with `Session.ready({slug, board})` on page load (after the board loads) plus `Session.onChange` → if `bundle().myRosterStatus !== "found"` hide results/warnings and set status to the chip's message; else run today's load body with `loadWorld({bundle, …})`, `snapshotAt = bundle.rostersRequestedAt`, catalog via `Session.catalog()`, `catalogFetchedAt` from its `fetchedAt`. The `#waiver-load` button and `#waiver-user` input are removed from `waivers.html`; the week and reserve inputs stay; week change re-runs the load body against the committed bundle. Refresh: the chip's `#session-refresh` calls `Session.refresh({scope:"league"})`; on the resulting `onChange` the waiver page re-runs load (transactions re-fetched inside it; if transactions fail, the page shows the error and does not update `snapshotAt`). The 15 s `recompute` tick and 60 s expiry (now against `bundle.rostersFetchedAt`) are unchanged. `waiver-source` provenance text prints both timestamps.
- [ ] **Step 2 (start-sit):** same pattern; `#ss-form`/`#ss-user` removed; `snapshotAt = bundle.rostersRequestedAt`; `/state/nfl` from the bundle; catalog via session; expiry against `rostersFetchedAt`.
- [ ] **Step 3 (fixtures):** `waivermode_fixture`: `loadWorld` tests stub a bundle instead of `get` for user/league/rosters; add: `myRosterStatus:"ambiguous"` → throws the exact message; `requestedAt`/`fetchedAt` passed through. A11y fixture's aria-label rule still passes (fewer inputs).
- [ ] **Step 4:** All fixtures green. **Step 5: Commit** `feat: waiver desk and start-sit read the shared session`.

---

### Task 4: In-season trade page on the session

**Files:** `site/assets/seasontrademode.js`, `site/trade.html`, `tests/seasontrademode_fixture.cjs`.

- [ ] `init({ board, league, slug, els })`: drop `#season-user`/`#season-load` (remove from markup); on `Session.onChange`, when `myRosterStatus === "found"` run today's `load()` body minus the user/rosters/users/state fetches (take them from the bundle; keep `traded_picks`, `remaining`, catalog via `Session.catalog()`); otherwise hide controls/columns/result and show the chip message in `#season-status`. `compare()`: `const b = await Session.refresh({scope:"rosters"})`; use `b.rosters`, `b.state`, `snapshotAt = b.rostersFetchedAt`; keep the changed-roster revalidation and the `compareSeq` guard (bump `compareSeq` in the `onChange` handler too). `identifyRoster` is deleted here and imported from `Session` (fixture imports move: `M.identifyRoster` → `Session.identifyRoster`; keep one re-export `identifyRoster: Session.identifyRoster` if the fixture would otherwise need rewriting — say which you did).
- [ ] Bootstrap in `trade.html`: `FC.setBoard(board)` after loading; the in-season branch no longer reads a username.
- [ ] Fixtures green; commit `feat: in-season trade page reads the shared session`.

---

### Task 5: Pre-draft trade and keepers — exact matcher, previous-season roster

**Files:** `site/assets/trademode.js`, `site/assets/keepers.js`, `site/assets/session.js` (add `previousLeagueRoster()`), `site/trade.html`, `site/index.html`, `tests/trademode_fixture.cjs`, `tests/keepers_fixture.cjs` (if present; else add cases to the existing keeper tests — check `tests/` first), `tests/session_fixture.cjs`.

**Interfaces:** `Session.previousLeagueRoster()` → requires a committed bundle with identity; follows `bundle.league.previous_league_id` (rejects `no prior season found` when absent), fetches `/league/<prev>/rosters` via `get`, applies `identifyRoster` with `identity.userId`, returns `{ previousLeagueId, roster }`.

- [ ] **trademode:** `load()` no longer looks up the user or lists leagues; it runs on `Session.onChange` when `myRosterStatus === "found"` and `league.status === "pre_draft"`: `leagueWorld(bundle.league, cfg.board, {futureDiscount})` unchanged, then `me = w.teams.find(t => t.rosterId === bundle.myRoster.roster_id)` (exact match is already enforced by the session — the old first-match `find` at `trademode.js:375-380` is gone). Remove `pickLeague`, `#trade-user`, `#trade-load`. `leagueWorld`'s own `status !== "pre_draft"` throw stays.
- [ ] **keepers:** `loadFromSleeper()` becomes: `const { previousLeagueId, roster } = await Session.previousLeagueRoster()`; then `buildOriginalByPlayerId(previousLeagueId)` and the existing candidate build. Remove the keeper username input and its `pickLeague`. **Behaviour change (name it in the commit body):** co-owned previous-season rosters are now found; two matches block with the exact message instead of guessing.
- [ ] **Fixtures:** `session_fixture`: `previousLeagueRoster` happy path, missing `previous_league_id`, co-owner found, two → throws. `trademode_fixture`: the `reject non-predraft leagues` check stays; add a check that `init` never calls `/user/` (stub `get`, assert). Keeper tests: previous-season co-owner case.
- [ ] Commit `feat: pre-draft trade and keepers use the session; exact roster matcher for both`.

---

### Task 6: Live draft — identity from the session, restore mismatch, anonymous mode kept

**Files:** `site/assets/draftmode.js`, `site/index.html`, `tests/draftmode_fixture.cjs` (or the existing draft fixture — check name).

- [ ] `init(options)`: `cfg.els.username` is removed; `findDrafts()` reads `Session.identity()` (status `identify yourself in the league panel first` when null); `connectById()` keeps anonymous mode (no identity → `userId:null`, exactly today's pasted-id behaviour). Polling/backoff/visibility/heartbeat untouched (`draftmode.js:367-430`, `:985-987`).
- [ ] Restore: on init, parse `fc-draft-mode:<slug>`; if `parsed.userId` and `Session.identity()?.userId` are both present and differ → do NOT `connect(parsed…)`; render two buttons in the draft panel: `Reconnect as <identity.displayName>` (connects with the session's identity and rewrites the record) and `View anonymously` (connects with `userId:null`, rewrites the record without identity). If identities match or the record has no `userId`, restore as today.
- [ ] `Session.onChange`: if connected and identity changed → `beginConnect()` path re-derives "mine" with the new `userId` (reuse `connect(username, userId, draftId)` which already cancels the prior chain via `pollSeq`); never a second poller.
- [ ] Fixture: restore-mismatch renders the two choices and does not auto-connect; anonymous pasted id still connects; identity change re-connects once (assert poll sequence bumped once).
- [ ] Commit `feat: live draft takes identity from the session; restore never highlights a different account`.

---

### Task 7: Connect page, cleanup, docs, gate

**Files:** `site/assets/connect.js`, `site/connect.html`, `site/assets/app.js` (delete the legacy autofill block and `KNOWN_LEAGUES`-style duplicates: `waivermode.js:8` and `connect.js:4` now read `FC.REGISTRY`), `docs/interface-release-checklist.md`, `docs/multi-league-tools.md`, `docs/league-onboarding-handoff.md`, `README.md` if it describes the username flow.

- [ ] `connect.js`: `discover` uses `Session.identify(username)` then `Session.leaguesFor()` (needs a bundle → call `Session.ready({slug: current, board})` first, or fall back to fetching `/state/nfl` via `get` when no board is present on the connect page — the connect page has no board; keep its own `/state/nfl` fetch and pass `season` into a new optional `Session.leaguesFor({ season })`). Configured-league detection via `FC.registryFor`.
- [ ] Remove every remaining legacy input/button and the `app.js` autofill block; grep for `#draft-username|keeper-user|trade-user|season-user|waiver-user|ss-user|connect-user` — only `#connect-user` and `#session-user` may remain.
- [ ] Docs: checklist paragraph (what changed, the two behaviour changes, browser round trip pending: identify once → open waivers/weekly/trade/index in new tabs → forget → all anonymous); `multi-league-tools.md` mention the registry as the single source of league capabilities.
- [ ] Gate: `.venv/Scripts/python.exe -m pytest -q` (841) and all fixtures; commit `chore: connect page on the session; remove legacy username inputs; docs`.

---

## Self-review

- **Spec coverage:** §3 registry → T1; §4 module/state machine/bundle/API/fail-closed → T1 (+T5 `previousLeagueRoster`); §5 each controller row → T3 (waiver, start-sit), T4 (season trade), T5 (pre-draft trade, keepers), T6 (draft), T7 (connect); §6 chip → T2; §7 storage → T1 (keys, migrate, forget) + T2 (prefill) + T6 (restore records); §8 experience → T7 browser round trip; §9 tests → T1–T6 fixtures; §10/§12 deferrals untouched.
- **Placeholder scan:** T1 has the fixture list and the code contracts; T3–T7 are prose (opus implementers) with exact ids, messages and behaviours named. No TBD.
- **Type consistency:** bundle fields (`registry, identity, league, users, rosters, state, rostersRequestedAt, rostersFetchedAt, myRoster, myRosterStatus, warnings, generation`) used identically across T1–T6; `loadWorld` signature `{bundle, board, week, get}` in T3 and T4's independence from it; `Session.ready({slug, board})` everywhere; `FC.setBoard` introduced in T2 and used in T3/T4/T5 bootstraps.
