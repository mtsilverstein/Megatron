# Shared Sleeper Session — Design

**Status:** revision 2, 2026-09-18, after astra's review (`.review/ASTRA-SESSION-REVIEW-2026-09-18.md`,
gitignored; every finding is either adopted below or answered in §11). Awaiting the user's
approval before a plan is written.

**Goal:** you type your Sleeper username once, anywhere on the site, and every page knows
who you are, which league you're in, and which roster is yours. The per-page "Load my
league" ritual disappears; the roster matcher, the league registry and the freshness
bookkeeping live in one place instead of six.

**What it is not.** Not a login. Sleeper's API is public and read-only; the session holds
a public username and public league data. Nothing writes to Sleeper; no credential is ever
stored. It is also not cross-tab synchronisation and not a demo mechanism — both are
scoped out explicitly (§8, §10).

---

## 1. Current state, corrected

Seven username inputs (`site/index.html:44` draft, `:150` keeper, `site/trade.html:35`
pre-draft, `:64` in-season, `site/weekly.html:32`, `site/waivers.html:30`,
`site/connect.html:24`), all reading/writing one `localStorage` key
`megatron:sleeper-username` (`app.js:48-56`, `connect.js:28-40`). The live draft page
separately persists `{username, userId, draftId}` per league under `fc-draft-mode:<slug>`
and auto-reconnects from it (`draftmode.js:11-13`, `:305-316`, `:988-999`).

What each controller fetches and how it decides which roster is "mine":

| Controller | `/user/<name>` | Live data it loads | `/players/nfl` | Roster identity |
| --- | --- | --- | --- | --- |
| `draftmode` (live draft) | yes, for draft discovery; optional for pasted draft id | draft object, league object for scoring only; polls draft picks every 3 s | no | a **draft seat**, from `draft_order` / pick `draft_slot` — not a roster |
| `keepers` (index.html) | yes | current-season leagues → follows `previous_league_id` → **previous** league's rosters; then prior drafts/picks | no | first `owner_id` match only; ignores `co_owners`; no uniqueness check |
| `trademode` (pre-draft) | yes, then lists the user's leagues to pick one | league users, rosters, traded picks, prior-season draft chain | no | first owner/co-owner match; no uniqueness check |
| `seasontrademode` | yes | users, rosters, traded picks, `/state/nfl` (league object fetched by the page shell) | yes, own per-document cache | owner/co-owner, **exactly one** |
| `waivermode` | yes | league, rosters, the week's transactions (not league users) | yes, own cache | owner/co-owner, **exactly one** |
| `startsitmode` | via `waivermode.loadWorld` | same, plus `/state/nfl` | yes, own cache | via `loadWorld` |
| `connect.js` | yes | `/state/nfl`, the user's current-season leagues (settings embedded) | no | — |

So: two controllers already use the exact matcher, two use weaker ones (keepers would
mis-identify a co-owned roster; pre-draft trade would silently take the first of two).
Consolidating is a **behaviour tightening** for those two, not a deletion of four
identical copies. The slug allowlist in `app.js:4-6` carries no league ids; the
slug→league-id map lives in `waivermode.js:8` and `connect.js:4`.

## 2. The design in one paragraph

A new module `site/assets/session.js` (`window.Session`, node-testable) owns identity,
the supported-league registry, and the committed league bundle for one document.
The existing `#league-context` panel at the top of `<main>` (`app.js:24-47`) gains an
**identity chip**. Pages call `Session.ready()` on load and receive an immutable bundle;
the seven inputs and four Load buttons are removed (the connect page keeps its form and
writes through the session). Identity persists in `localStorage`; league data is
memory-only for the document and always fetched fresh. Freshness is carried with two
timestamps per roster snapshot so every existing 60-second gate keeps its exact meaning.

## 3. Supported-league registry

One exported table replaces the three partial ones (`app.js` slugs, `waivermode.js:8`,
`connect.js:4`):

```js
FC.REGISTRY = [
  { slug: "gabagool", platform: "sleeper", leagueId: "1376245373244301312", label: "Gabagool · Sleeper",
    tools: { draft: true, keepers: true, trade: true, waivers: true, startsit: true } },
  { slug: "fam",      platform: "sleeper", leagueId: "1389736745205002240", label: "FAM · Sleeper",
    tools: { draft: true, keepers: false, trade: true, waivers: true, startsit: true } },
  { slug: "espnfam",  platform: "espn",    leagueId: "69827905",            label: "ESPN family · draft board only",
    tools: { draft: true, keepers: false, trade: false, waivers: false, startsit: false } },
];
```

Rules: an unknown slug still refuses to default (today's `mountInvalidLeagueRecovery`
path); `Session.ready()` **validates that the live `/league/<id>` id equals the static
board's `league.league_id`** and rejects on mismatch (`"live league does not match this
board; refusing to load advice"`); a tool the registry marks `false` renders its existing
"not connected"/"Gabagool only" state without making a Sleeper call. ESPN never creates
a Sleeper session. The nav-label rule in `app.js` reads `tools` instead of the slug.

## 4. `session.js`

### 4.1 State machine

```
anonymous ──identify()──▶ identifying ──ok──▶ identified
identified/anonymous ──ready(slug)──▶ loadingLeague ──ok──▶ ready ──refresh()──▶ refreshing ──ok──▶ ready
any ──error──▶ error(reason)          any ──forget()──▶ anonymous (league bundle kept, myRoster cleared)
```

- Every async operation carries a **generation token**; a result whose generation is
  no longer current is discarded and fires nothing. Single-flight: a second
  `refresh()` while one is in flight returns the same promise.
- The bundle is **immutable once committed**; `refresh()` builds a new bundle and swaps
  it atomically, or leaves the old one untouched on any failure. `fetchedAt` never
  advances on a failed or partial refresh.
- Entering `identifying` or `loadingLeague` clears `myRoster` **first** and fires
  `onChange` so subscribers disable account-derived surfaces before the network round
  trip; on failure the previous identity is **not** restored silently — the chip shows
  the error and the page stays disabled until the user acts.

### 4.2 Bundle

```
{
  registry:  { slug, platform, leagueId, label, tools },
  identity:  { username, userId, displayName } | null,
  league, users, rosters, state,
  rostersRequestedAt,   // Date.now() taken BEFORE the rosters request is issued
  rostersFetchedAt,     // Date.now() taken AFTER it resolved
  myRoster:  roster | null,
  myRosterStatus: "found" | "none" | "ambiguous" | "anonymous",
  warnings: [ ... ],    // e.g. state.season !== league.season, season_type !== "regular"
  generation: n,
}
```

Two roster timestamps because the waiver desk and start-sit deliberately use a
**pre-request** snapshot time so a kickoff during retrieval blocks the result
(`waivermode.js:301-321`, `waivers.js:253-254`), and a **post-fetch** time for the
60-second UI expiry. One timestamp cannot serve both.

### 4.3 API

- `Session.identify(username)` → `/user/<name>` via `Sleeper.get`; on success stores
  identity (§7) and re-derives `myRoster` for the committed bundle; on a missing
  `user_id` rejects `"Sleeper username was not found."` and leaves state `error`.
- `Session.forget()` → clears identity, `myRoster`, and the draft-restore records (§7);
  fires `onChange` synchronously.
- `Session.ready({ slug })` → resolves the registry entry, fetches `/league/<id>`,
  `/league/<id>/users`, `/league/<id>/rosters`, `/state/nfl` in parallel through
  `Sleeper.get`, validates the live/static id, derives `myRoster`, commits the bundle.
  Resolves with `myRosterStatus: "anonymous"` when no identity is stored, so pages
  that can render without a roster (the draft board before connecting) do.
- `Session.refresh({ scope })` → `scope` is `"rosters"` (rosters + state; default) or
  `"league"` (league + users + rosters + state). Controllers that need more (the waiver
  desk's week transactions) fetch that themselves **inside the same generation** and
  fail the whole refresh if it fails — the chip's age never advances past a partial
  refresh.
- `Session.catalog()` → `/players/nfl` once per document with `fetchedAt`; rejections
  propagate. (Honest scope: this removes the three duplicate caches *within a page*;
  separate pages and tabs are separate documents and still download once each. A
  versioned browser-shared cache is a separate decision — §10.)
- `Session.leaguesFor()` → requires a committed bundle for `state.season`; returns
  `/user/<userId>/leagues/nfl/<season>`. Consumer: `connect.js` only.
- `Session.onChange(fn)`; pure exports `identifyRoster(rosters, userId)` (moved from
  `seasontrademode.js`; keepers and pre-draft trade are switched to it — the behaviour
  change is named in §5) and `chipText(bundle)`.

### 4.4 Fail-closed rules

1. Unknown slug, missing registry entry, live/static id mismatch, malformed league/
   users/rosters/state, or any required fetch failure → `ready()` rejects; no prior
   bundle remains usable (it was cleared on entering `loadingLeague`).
2. Zero or two matching rosters → `myRosterStatus` `"none"`/`"ambiguous"`, chip message
   `"Could not uniquely match this account to a roster in this league."`, and every
   account-derived surface (waiver rows, start-sit output, trade columns, keeper panel,
   "your picks" highlights) is hidden or disabled by its controller — not just labeled.
3. Contract checks stay in the controllers. The session hands over the same objects;
   `waivers.js`, `seasontrade.js`, `startsit.js` still run league/scoring/week/
   projection/snapshot checks before rendering anything.
4. All endpoints go through `Sleeper.get` (unique query key, `no-store`, 4 s abort).

## 5. Controller integration (each a deliberate design, not a mechanical edit)

| Controller | Change |
| --- | --- |
| `waivermode.js` | `loadWorld({ bundle, board, week })`: takes league/rosters/identity from the bundle; fetches only `/league/<id>/transactions/<week>`. `snapshotAt` = `bundle.rostersRequestedAt`; UI expiry uses `bundle.rostersFetchedAt`. **Refresh policy unchanged**: the 15 s timer ticks the age and expires at 60 s; the "Load / refresh" button becomes the chip's refresh, which calls `Session.refresh({scope:"league"})` and then re-runs `loadWorld` (transactions included) in the same generation. No auto-polling is introduced. |
| `startsitmode.js` | Same bundle; `/state/nfl` comes from the bundle; catalog via `Session.catalog()`. |
| `seasontrademode.js` | `Session.ready()` supplies users/rosters/state; `compare()` calls `Session.refresh({scope:"rosters"})` and reads the **fresh bundle's** rosters and `rostersFetchedAt` as `snapshotAt` (the engine's ≤60 s rule at `seasontrade.js:21-25`); the existing revalidation of selected/dropped ids against fresh rosters stays. `identifyRoster` moves out; behaviour identical. |
| `trademode.js` (pre-draft) | League is the page's registry league; the "pick a league" list is removed. `leagueWorld(league, board)` is unchanged (traded picks and prior-season draft chain stay its job; it still throws for non-pre-draft). Roster identity switches to the exact matcher — **behaviour change:** two matching rosters now block instead of taking the first. |
| `keepers.js` | Needs the **previous** league's roster, not `myRoster`. New helper `Session.previousLeagueRoster()` → follows `league.previous_league_id`, fetches that league's rosters, applies the exact matcher with the shared `userId`. **Behaviour change:** co-owned rosters are now found; two matches now block instead of guessing. The multi-season draft-chain walk is unchanged. |
| `draftmode.js` (live draft) | Keeps its own polling, backoff, visibility handling and pasted-draft-id anonymous mode untouched. Receives identity explicitly (`Session.identity` at connect time) instead of an input. Restore records (§7) are checked against the shared identity: **if the stored `userId` differs from the session's, the page does not auto-highlight the stored account** — it offers "reconnect as <shared identity>" or "view anonymously" and rewrites the record. A session identity change while connected re-derives "mine" through the existing `beginConnect` cancellation path; it never spawns a second poller. |
| `connect.js` | `Session.identify` + `Session.leaguesFor`; results unchanged. |

## 6. The identity chip

In `#league-context` (kept there deliberately — the masthead was just reduced to fit a
phone, `docs/interface-release-checklist.md:132-145`, and is navigation, not state).
Mobile: one compact row (league select · name · age), details below.

States: **anonymous** — `Sleeper username [__] [Use this account]` plus the sentence
`"Remembered on this device until you choose forget."`; **ready** — `Max973 · Gabagool
Fools · your roster: 9 · rosters 14 s ago · [refresh] · [change] · [forget]`, age ticking
from `rostersFetchedAt`; **none/ambiguous** — the §4.4 message plus `[change]`;
**error** — the rejection text plus `[retry] [change]`; **ESPN** — identity only, no
Sleeper calls, existing "not connected" note.

## 7. Storage

| Key | Fields | Written by | Retention | `forget()` |
| --- | --- | --- | --- | --- |
| `megatron:session:identity` | `{ username, userId, displayName, storedAt }` | `Session.identify` | until forget | deleted |
| `megatron:sleeper-username` | *(legacy)* | — | **migrated**: read once into identity on first load, then deleted | deleted |
| `fc-draft-mode:<slug>` | `{ username, userId, draftId }` | `draftmode` (unchanged shape) | until draft ends / forget | **deleted for every slug** |

League, roster, user and catalog data are never persisted. All reads validate JSON
shape and fall back to `anonymous` on parse failure; storage that throws (private mode,
quota) degrades to a memory-only identity for the document. Cross-tab: identity is
available to *later* page loads; an already-open tab is not updated live (no `storage`
listener in this version — §10).

## 8. What a visitor experiences

Open any page → the chip asks for a username once → every page after that loads your
roster on arrival with a visible snapshot age and the same 60-second expiry the tools
have today. Change league in the select → same identity, roster re-identified. Change or
forget account → one click; every account-derived panel clears before the lookup starts.
Refresh → the chip's button (waivers, start-sit) or automatic where a tool requires it
(trade compare). Four Load buttons and seven inputs become one input.

## 9. Testing

`tests/session_fixture.cjs` (stubbed `Sleeper.get`): identify success/miss; ready with
and without identity; live/static id mismatch rejects; `identifyRoster` owner /
co-owner / none / two; refresh advances `rostersFetchedAt` only on full success and
never on a failed component; generation: an older `ready` resolving after a newer one
fires nothing; `catalog()` fetches once across two calls; `chipText` for every state;
corrupt/unavailable storage → anonymous, no throw; `forget()` deletes every
`fc-draft-mode:*` key; ESPN slug makes zero Sleeper calls.
Controller fixtures: waiver/start-sit `snapshotAt` still equals the pre-request time
(kickoff-during-fetch case); season-trade compare uses the refreshed bundle and still
rejects a changed roster; keepers finds a co-owned previous-season roster and blocks on
two; pre-draft trade blocks on two matches; draft restore with a mismatched `userId`
does not auto-highlight. `navigation_fixture`: chip present in `#league-context` on
every page, no legacy inputs remain, labels read from `REGISTRY.tools`.
User: identify once on the draft board, open waivers/weekly/trade in new tabs, see the
roster loaded without typing; forget, confirm every page returns to anonymous.

## 10. Deferred, with the decision recorded

- **Cross-tab live sync** (`storage` listener) — not in this version; identity applies
  on the next load.
- **Browser-shared catalog cache** — per-document only now; a versioned cache is a
  separate decision with a TTL/eviction design.
- **Demo path** — will be a **synthetic, versioned fixture league** with synthetic
  manager names and a controlled clock, delivered through a data-source abstraction,
  not a real account passed to the live API (astra's argument: a real account can be
  renamed, leave the league, expose real managers, and makes screenshots
  non-reproducible; it also turns someone's live roster into a permanent product
  sample). No `seed: {username}` hook is added to the session API.
- **Arbitrary leagues** — the registry is the seam; resolution by discovered
  `leagueId` and where its projections come from is spec 3.

## 11. Astra's findings not adopted verbatim

None rejected. Two were narrowed rather than dropped: the catalog claim is now scoped to
one document (§4.3) instead of cut, because removing three in-page duplicate caches is
still real; and the waiver auto-refresh question is resolved by keeping today's policy
exactly (§5) rather than designing polling.

## 12. Out of scope

Login/OAuth; ESPN sessions; the demo fixture itself; arbitrary-league projections; any
engine change; cross-tab sync; a shared catalog cache.
