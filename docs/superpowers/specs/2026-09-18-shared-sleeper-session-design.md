# Shared Sleeper Session — Design

**Status:** draft for review, 2026-09-18. First of three steps toward a single-stream,
general-purpose site: (1) this — one identity, one league, one loaded roster, shared by
every page; (2) a demo path seeded from a public league (falls out of this design);
(3) arbitrary Sleeper leagues (separate spec; needs the pipeline).

**Goal:** you type your Sleeper username once, anywhere, and every page knows who you
are, which league you're in, and which roster is yours. No more per-page "Load my
league" buttons, no more six independent `/user/<name>` lookups, no more three
independent 5 MB catalog downloads.

**What it is not.** Not a login. Sleeper's API is public and read-only; the "session"
holds only public identity (a username, a user id, a display name) and public league
data (rosters, users, settings). Nothing here writes to Sleeper or stores a credential.

---

## 1. What exists today, measured

Six pages, five username inputs (`#draft-username`, `.keeper-user`, `#trade-user`,
`#season-user`, `#waiver-user`, `#ss-user`) plus `#connect-user`, all autofilled from one
`localStorage` key (`megatron:sleeper-username`) — so the *text* is shared but nothing
else is. Each controller then:

| Controller | Looks up `/user/<name>` | Loads rosters/users | Fetches `/players/nfl` (≈5 MB) | Identifies my roster |
| --- | --- | --- | --- | --- |
| draftmode (live draft) | yes | via draft/league | no | via `draft_slot` |
| keepers (index.html) | yes | yes | no | yes |
| trademode (pre-draft) | yes, then lists leagues to pick | yes + traded_picks + prior drafts | no | yes |
| seasontrademode | yes | yes + traded_picks + state | yes (own cache) | yes |
| waivermode | yes | yes + transactions | yes (own cache) | yes |
| startsitmode | via waivermode.loadWorld | yes | yes (own cache) | yes |
| connect.js | yes, then lists leagues | reads settings | no | — |

Same roster-identity rule copied in four places ("owner_id or co_owners contains
user_id, exactly one match"). League selection travels in the URL (`?league=<slug>`)
and is resolved against a hardcoded allowlist of three slugs (`FC.LEAGUES`).

## 2. The design in one paragraph

A new module `site/assets/session.js` (`window.Session`, node-testable) owns identity
and league state for the tab. The masthead's existing league panel becomes an
**identity chip**: `Max973 · Gabagool Fools · your roster: 9 · rosters 14 s ago ·
change`. Pages call `Session.ready()` on load and receive `{ user, league, rosters,
users, state, myRoster, fetchedAt, refresh() }`; the per-page connect rows and Load
buttons are removed. Identity persists in `localStorage` (public data); league data is
fetched fresh on every page load and re-fetched by `refresh()`, so every freshness rule
the engines enforce today (waiver desk snapshot expiry, the trade engine's 60-second
roster rule) still holds — the session makes freshness *shared*, not stale. The
catalog is fetched once per tab and shared through the same module.

## 3. `session.js`

UMD module; no DOM except through the chip renderer (§4), which is a separate function
pages may skip (the connect page renders its own).

### 3.1 State

```
identity   = { username, userId, displayName, fetchedAt }        // localStorage "megatron:session:identity"
league     = { slug, leagueId, league, users, rosters, state, fetchedAt }   // memory only
myRoster   = the unique roster whose owner_id or co_owners contains userId, or null
catalog    = { players, fetchedAt }                                // memory only, lazy
```

Persisting identity but never league data is deliberate: identity is a public username
the user typed; league data is a snapshot whose age matters to every engine.

### 3.2 API (all return promises unless noted)

- `Session.identify(username)` — `/user/<name>`; stores identity; rejects with
  `"Sleeper username was not found."` on a missing `user_id`. Clears `myRoster` and
  re-derives it if a league is loaded.
- `Session.forget()` — clears identity and `myRoster`; league data stays (it's public).
- `Session.ready({ slug })` — the one call every page makes. Resolves the league for
  the URL slug (`FC.leagueDataPath`'s allowlist for now; §7 widens it), fetches in
  parallel `/league/<id>`, `/league/<id>/users`, `/league/<id>/rosters`, `/state/nfl`
  with the cache-busting `Sleeper.get`, derives `myRoster` if identity is known, and
  resolves the bundle. If identity is unknown it still resolves — with `myRoster: null`
  — so pages that don't need a roster (the draft board before connecting) render, and
  pages that do show the chip's prompt instead of their own form.
- `Session.refresh()` — re-fetches rosters and state (the two things that change), keeps
  users/league, updates `fetchedAt`; returns the bundle. The trade page calls this
  right before `analyze` (60-second rule); the waiver desk calls it on its existing
  15-second timer path instead of its own `Sleeper.get`.
- `Session.catalog()` — `/players/nfl` once per tab, with `fetchedAt`; the three
  controllers that fetch it today call this instead. Rejects propagate (no silent
  empty catalog).
- `Session.leaguesFor(userId)` — `/user/<id>/leagues/nfl/<season>` for the connect page
  and the pre-draft trade flow.
- `Session.onChange(fn)` — fires after `identify`, `forget`, `ready`, `refresh`; the chip
  and controllers subscribe rather than polling.
- Pure, exported for tests: `identifyRoster(rosters, userId)` (moved from
  `seasontrademode.js`; the other three copies are deleted), `chipText(bundle)`.

### 3.3 Fail-closed rules carried over, now in one place

- Zero or two matching rosters → `myRoster: null` plus the message
  `"Could not uniquely match this account to a roster in this league."` on the chip.
  Pages never guess a roster.
- `state.season !== league.season` or `season_type !== "regular"` in season → bundle
  resolves with `state` but a `warnings[]` entry; engines keep their own checks.
- A failed `/league/*` fetch rejects `ready()`; pages show the rejection text in the
  chip, not a default league.

## 4. The identity chip

Replaces the note text in `FC.mountLeagueContext`'s panel (the league `<select>` stays —
it's already the league switch). Three states:

1. **No identity:** `Sleeper username [input] [Use this account]` inline in the panel.
   Submitting calls `Session.identify` then `Session.ready`.
2. **Identity, roster found:** `Max973 · Gabagool Fools · your roster: 9 · rosters 14 s ago · [refresh] · [change account]`.
   The age ticks every second from `fetchedAt` (same heartbeat idea as the draft page's
   "synced Ns ago"), so a stale snapshot is visible rather than asserted.
3. **Identity, no unique roster:** the §3.3 message plus `[change account]`.

On `espnfam` the chip shows identity only (no rosters) with the existing "not connected"
note — ESPN has no session.

The chip is the only username input on the site. `#draft-username`, `.keeper-user`,
`#trade-user`, `#season-user`, `#waiver-user`, `#ss-user` and their Load buttons are
removed; `connect.html` keeps its own form because its job *is* identity discovery, and
it writes through `Session.identify` so the chip agrees with it.

## 5. Controller changes (each a small, mechanical edit)

| Controller | Before | After |
| --- | --- | --- |
| `waivermode.js` | `loadWorld({username, board, week})` fetches league/rosters/user/transactions | `loadWorld({session, board, week})` reads league/rosters/myRoster from the bundle, fetches only `/league/<id>/transactions/<week>`; catalog via `Session.catalog()` |
| `startsitmode.js` | own `#ss-user`, own catalog | `Session.ready()` + `Session.catalog()` |
| `seasontrademode.js` | own load flow, own catalog, own `identifyRoster` | `Session.ready()`; `compare()` calls `Session.refresh()` then reads the fresh bundle; catalog via session |
| `trademode.js` (pre-draft) | username → leagues → pick one → `leagueWorld(league, board)` | `Session.ready()` supplies `league` and identity; `leagueWorld` unchanged (still fetches `traded_picks` and prior-season drafts itself, still throws for non-pre-draft) |
| `keepers.js` | own username → leagues → league | `Session.ready()`; the league is the page's league |
| `draftmode.js` (live draft) | username → drafts list → connect | `Session.identity` pre-fills the user; draft discovery unchanged (drafts, not leagues, are the unit there) |
| `connect.js` | own identity lookup | `Session.identify` + `Session.leaguesFor`; results unchanged |

Nothing about any engine (`waivers.js`, `trade.js`, `seasontrade.js`, `startsit.js`)
changes. Every controller keeps its own contract checks; the session hands them the
same objects they fetched before.

## 6. What a visitor experiences

Open any page → the chip asks for a username once → every page after that loads your
roster automatically with a visible snapshot age. Change league in the select → same
identity, new league, roster re-identified. Change account → one click in the chip.
Refresh → one click, or automatic where a tool needs it (the trade compare). The
"Load / refresh league" ritual disappears from four pages.

## 7. Hooks for the next two steps (designed now, built later)

- **Demo seed:** `Session.ready({ slug, seed: { username } })` — a page may pass a
  public demo account so a visitor with no Sleeper account sees a populated site. The
  chip shows `demo · <name>` and a `use my account` link. Nothing else changes.
- **Arbitrary leagues:** `Session.ready` resolves a league by slug today. The
  general version resolves by `leagueId` from `connect.html`'s discovery, and the
  question becomes where that league's projections come from — the subject of spec (3).
  This spec keeps the allowlist so nothing claims support it doesn't have.

## 8. Testing

- `tests/session_fixture.cjs` (new): stubbed `get`; `identify` success/miss;
  `ready` with/without identity; `identifyRoster` owner / co-owner / none / two;
  `refresh` updates `fetchedAt` and rosters only; `catalog()` fetches once across two
  calls; `chipText` for the three states; failed league fetch rejects rather than
  defaulting.
- Existing controller fixtures pass with `loadWorld`'s new signature (the waivermode
  fixture stubs `get` today; it will stub the session bundle instead).
- `tests/navigation_fixture.cjs`: the chip renders in the league panel on every page;
  no `#trade-user`/`#waiver-user`/… inputs remain (a11y fixture's aria-label rule keeps
  applying to the one remaining input).
- Browser round trip by the user: identify once on the draft board, then open
  waivers, weekly, trade in new tabs and see the roster loaded on each without typing.

## 9. Out of scope

Login/OAuth of any kind; storing anything but a public username; ESPN sessions; the
demo content itself; arbitrary-league projections (spec 3); any engine change.
