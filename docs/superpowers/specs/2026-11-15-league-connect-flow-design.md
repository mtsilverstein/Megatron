# League connect flow — Design

Date: 2026-11-15 · Status: draft for owner review · Branch: `feat/connect-flow`

## 1. Why

Owner, 2026-11-14: "the select league/import league feature/username page flow is kind of weird and not intuitive
and needs a revamp." Asked what tripped them up, 2026-11-15: "just the multiple different ways in. I feel like it
could be all streamlined. Then when you pull up your league the UI that just says your league format is not great."
The owner handed over the how ("I trust your vision").

The shared-session design already promised one input (`2026-09-18-shared-sleeper-session-design.md` §8: "Four Load
buttons and seven inputs become one input"). Later features (any-league in-season, the 2026-11-07 connect prompt)
each added their own way in, so there are now four.

## 2. How it works today (checked in a browser, desktop and 390 px, 2026-11-15)

Ways in:

1. **`connect.html`** — two forms side by side: "Open by league link" and "Find by username". A username lists one
   card per league. Not in the main nav; reached by links only.
2. **The tool-card prompt** (`#connect-prompt` in `weekly.html`, `waivers.html`, `trade.html`; shown by
   `startsitmode.js:71-73`, `waivermode.js:456-458`, `trade.html:130-131`; driven by `LeagueConnect.initPrompt` in
   `connect.js`) — one field that takes a username or a link, shown inside the tool's card when no league is open.
3. **The league bar** (`#league-context`, built by `mountLeagueContext` + the identity chip in `app.js`) — a League
   select, a username box with "Use this account", a "View team" select, refresh, change/forget, a settings stamp and
   a note.
4. **Links between them** — "Find my Sleeper leagues" (bar), "More ways to connect" (tool card), "Go to the connect
   page" (the bad-`?league=` notice, `app.js:641-656`).

What goes wrong:

- **First visit points the wrong way.** The bar says "Enter your Sleeper username to choose one of your leagues" but
  has no box; the box is in the tool card below. Weekly's lead says "Select your league and team above".
- **Opening by link still asks again**: username or "View team".
- **A team picked to view is forgotten between pages.** Picked on Weekly; Trade asked again ("Choose a team").
  `megatron:lastLeague` is remembered; the viewed roster is not.
- **Pulling up a league shows its format, not your team.** Each connect-page card is team count, status, waiver type,
  every roster slot, the raw scoring JSON in a disclosure, a disclaimer and three links. The bar's lines are about
  plumbing ("League settings read 11:53:04 AM", "In-season tools read this league's live Sleeper settings").
- **On a 390 px phone the connected bar fills about half the first screen** before the tool starts.
- The League select holds a single option until a username is known.

## 3. Goals, non-goals, anti-goals

Goals

- **One way in.** The league bar at the top of Weekly, Waivers and Trade is the only place to connect, with the
  same single box and the same behaviour on every page.
- **The bar leads with your league and your team.** Once a league is open it is one line on desktop and at most two
  at 390 px.
- **Choose once.** A team chosen to view is remembered per league on this device, so moving between pages never asks
  again.
- **Old links keep working**: `connect.html` (with or without `?league=`), `?league=<id>`, the legacy slugs.

Non-goals

- No change to `session.js`'s invariants (immutable bundle, generation tokens, `myRoster` cleared first, storage
  degradation, `Sleeper.get` only), to what any tool computes, or to the fail-closed checks.
- No behaviour change on the archived draft board (`index.html`) or trade's pre-draft mode beyond the shared bar's
  new look: the registry path and the owner-only pre-draft trade stay as they are.
- No ESPN in-season connect. No login, no password, nothing written to Sleeper.

Anti-goals (failure even if everything technically works)

- **Two places to type a username or link on one page, in any state.**
- **Calling a team "your team" when it was picked without a username.** Any-league spec §5.1 stands: a team chosen
  without an account is "Viewing <team>", never "your roster".
- Any real league id, team name or username in code, fixtures, docs or commits.

## 4. Approaches

- **A. One league bar, the only way in — chosen.** The bar becomes the single connect surface; the tool-card prompt,
  the extra links and the connect page's forms go; `connect.html` forwards. Cost: the shared bar code is the biggest
  rewrite, and the archived board shares it.
- **B. A front-door page.** Tool pages with no league show one "Connect your league" button that goes to a one-box
  `connect.html` and returns you to the page you came from. One clear, linkable door, but every first visit costs a
  trip there and back, and the bar on the tool pages still needs the same compacting.
- **C. Trim in place.** Delete the tool-card prompt and one connect-page form; remember the viewed team. About a day,
  but two ways in remain (bar and connect page) and the bar still fills half a phone screen.

A, because visitors arrive on a tool page from the nav or a shared link, so the way in belongs where they already
are. B adds a hop; C leaves two doors. (Owner delegated the choice.)

## 5. Design

### 5.1 The one box

A single field, **"Sleeper username or league link"**, plus **Connect**. It always accepts both, using
`parseLeagueInput` (moved unchanged from `connect.js` into `app.js` as `FC.parseLeagueInput`): a league id or a
`sleeper.com/leagues/<id>` link opens that league on this page; link-shaped text that is not a Sleeper league link is
refused with today's `BAD_LEAGUE` text, never looked up as a username; anything else is a username, identified
through the shared session (the chip's `identify`), and the account's leagues are listed from the league picker's
existing `leaguesFor` lookup (`pickerLeagues`), so listing costs no request beyond today's. On a page the box exists
in exactly one place, the bar, and only in the states below that show it.

What a submit does:

- **A link or id** navigates (`location.assign`) to this page with `?league=<id>` (Weekly when the page is not an
  in-season tool). A known account is kept.
- **A username** identifies in place, as the chip's `identify` does today: it replaces any known account, an open
  league stays open and the roster is re-derived for the new account, and with no league open the account's leagues
  are listed (below). It never navigates by itself.
- **A league row or the League select** navigates, as today.
- **Exactly one league opens straight away only after an explicit username submit**, never on page load. A page load
  with a remembered account and no league lists the leagues, even when there is just one; a league that fails to load
  and is forgotten can therefore never re-open itself in a loop.

### 5.2 The bar's states

Sketches use invented names. `▾` is a select; `[ ]` a button.

**No league open** (first visit, or after a bad `?league=`):

```
Connect your Sleeper league
[ Sleeper username or league link            ] [Connect]
No password. Read-only: nothing is changed in Sleeper.
```

**Username entered, leagues found** — the rows appear in the bar under the box:

```
Your 2026 leagues
  Sunday Scaries        12 teams · PPR · FAAB
  Office League         10 teams · Half-PPR · Superflex · Rolling waivers
```

Each row is a link that opens that league on the current page (`?league=<id>`; on a non-tool page, Weekly). With
**exactly one** current-season league, it opens straight away (§5.1 limits when). **Zero** leagues: "No <season>
Sleeper leagues for <display name>. Paste a league link instead." with the box still there. The season is
`/state/nfl`'s, exactly as `discover` reads it today.

**No league open, account known** (a returning visitor whose last league is gone or was never set):

```
Sleeper account: Taco Tuesday   Not you?
Your 2026 leagues
  Sunday Scaries        12 teams · PPR · FAAB
```

The list loads by itself. That costs no new request: `pickerLeagues` already calls `leaguesFor` whenever an account
is known. While it loads, the line says "Finding your leagues…"; if it fails, the error line with **Retry**. The box
is hidden here (it is behind "Not you?").

**League open, account known, your roster found:**

```
[Sunday Scaries ▾]   Your team: Taco Corp   ↻ 2 min ago   Not you?
```

**League open, no account, no team chosen yet:**

```
[Sunday Scaries]   Which team do you want to see? [Choose a team ▾]
                   or find your team with your username
```

"or find your team with your username" is a text button that swaps the line for the one box in place (the team
select hides while the box shows, so there is still one input). The league is plain text, not a one-option select.

**League open, team chosen without an account:**

```
[Sunday Scaries]   Viewing: [Taco Corp ▾]   ↻ 2 min ago   Use my username
```

**League open, account known but no unique roster here** (none / ambiguous):

```
[Sunday Scaries ▾]   You have no team here. Viewing: [Choose a team ▾]   Not you?
```

For `ambiguous` the first sentence is "This account is on more than one team here." instead; the rest is the same.

**"Not you?"** (and "or find your team with your username" / "Use my username" in the anonymous states) reveals the
one box in place, empty, with **Cancel** to put the line back. With an account known it also shows a "Forget me on
this device" button. A submit follows §5.1; forget behaves as `Session.forget()` does today plus §5.4. When an
account is known and a league is open, the League select is the way to switch leagues; the league list rows only
appear when no league is open.

**Loading / error**: one line of status text in the bar. Errors keep today's messages, with **Retry** and "Not
you?". A bad `?league=` keeps the recovery notice (`mountLeagueNotice`) above the bar, minus its "Go to the connect
page" link; the bar below it is in the no-league state.

The League select appears when an account is known and lists that account's current-season leagues plus the open
one (today's `pickerLeagues` rules). Choosing one opens it on this page.

**Mobile (≤ 480 px)**: line 1 = league; line 2 = team control, refresh and the account link. Nothing else in the
connected bar.

### 5.3 What the bar no longer shows

- The settings stamp ("League settings read …"): every tool already prints `Session.settingsText` in its own data
  line (`startsitmode.js:113`, `waivermode.js:887`, `seasontrademode.js:1229`), which is where any-league spec §5.2
  puts it.
- The note "In-season tools read this league's live Sleeper settings. No password needed." and the "Find my Sleeper
  leagues" link.
- Format detail. A league's format appears as one short line on its row in the league list (§5.2), built from the
  league object `discover` already returns: `<n> teams · <PPR | Half-PPR | Standard | <x>-pt PPR> [· Superflex]
  · <FAAB | Rolling waivers>`. Roster slots and raw scoring are not shown. The tool cards' own scoring/accuracy line
  ("Scored with your league's own settings (…)") stays: it is the honest accuracy disclosure.

### 5.4 Remembering the viewed team

New storage key `megatron:viewedTeams`: a JSON array of `["<leagueId>", "<rosterId>"]` pairs, oldest first, at
most 20 (writing a 21st drops the oldest; writing an existing league moves it to the end). An array, not an object:
JavaScript orders integer-like object keys numerically, which would break "oldest".

It lives in `session.js`, behind the same storage wrapper the identity uses, so no page ever shows a "Choose a team"
flash before the remembered team arrives:

- `ready()` seeds the new bundle's `viewedRosterId` from the entry for that league when it commits a league that is
  not the one already committed (a refresh of the same league keeps the newest in-memory view, as today). The seed is
  read inside the same generation that builds the bundle, so a superseded load commits nothing, as today.
- The seed applies only when no owned roster is found (`myRoster` still wins and drops the view, as today) and the
  roster id exists in the loaded league; otherwise that league's entry is deleted.
- `view(rosterId)` writes the entry; `view(null)` ("Choose a team") deletes it. That is how a visitor with no account
  clears one league's remembered team.
- `forget()` deletes the whole key: every league's remembered team.
- Storage that throws or holds corrupt JSON degrades the same way the identity does (memory-only, no throw).

This amends shared-session §7 ("League, roster, user and catalog data are never persisted") for one thing only: a
roster id per league id. No names or roster contents are stored.

### 5.5 What goes away

- The form inside `#connect-prompt` on Weekly, Waivers and Trade, `LeagueConnect.initPrompt`, and the "More ways to
  connect" links. `#connect-prompt` stays as the container the pages already unhide when no league is open; it now
  holds one sentence and no input. Where a tool card today says "Enter your Sleeper username, or choose a team to
  view" (`startsitmode.js:163`, `waivermode.js:979`, `seasontrademode.js:714`), it now points up: with a league open,
  "Choose a team in the bar above to see <this tool's advice>."; with no league open, "Connect your league in the bar
  above to see <this tool's advice>."
- `connect.js` as a whole (`init`, `initPrompt`, `discover`) and the connect page's two forms: nothing calls them once
  the bar lists leagues through `pickerLeagues`. `parseLeagueInput` lives on in `app.js` (§5.1).
- `connect.html` becomes a forwarder: `location.replace` to `weekly.html`, carrying `?league=` when present, with a
  plain link as the no-script fallback. It is not deleted, so old links and bookmarks keep working.
- Weekly's lead drops "Select your league and team above to personalize the advice."
- The "Current league and saved account" disclosure (connect page only) goes with the page.

### 5.6 Draft board and pre-draft trade

They mount the same bar through the registry path and keep today's chip states, restyled to the compact bar:
anonymous = the board's league as text plus the one box (label "Sleeper username", since a link means nothing on a
board; link-shaped text there is refused with "Enter your Sleeper username." and never looked up); ready = "Your team: …", refresh, "Not you?"; none/ambiguous = the §5.2 sentence plus "Not you?"; error =
text, Retry, "Not you?"; ESPN = identity only, no Sleeper calls, today's "not connected" note. There is no "no league
open" state and no team-to-view picker on these pages (there is none today), and the "Connect your Sleeper league"
heading is in-season only. "Not you?" replaces today's "change" everywhere. Pre-draft trade still needs the owner's
username. Acceptance there is only that the board loads and the username path still finds the owner's roster.

## 6. Testing

- **Fixtures to update** (each currently pins today's surfaces): `connect_fixture`, `chip_session_fixture`,
  `navigation_fixture`, `interface_hierarchy_fixture`, `weekly_page_fixture`, `startsitmode_session_fixture`,
  `waivermode_session_fixture`, `seasontrademode_fixture`, `shared_assets_fixture` (cache keys).
- **New pins**:
  - in every bar state, each page has at most one input that accepts a username or league link (the anti-goal);
  - a team viewed on one page loads on the next page and on reload for the same league; a different league does not
    inherit it; `forget()` clears it; an owned roster beats it; a remembered roster id missing from the league is
    dropped; corrupt or throwing storage does not throw;
  - exactly one league opens directly after a username submit, and never on a page load with a remembered account;
    zero leagues shows the message with the box;
  - a remembered account with no league open lists its leagues with no typing and no extra request;
  - a username submitted with a league open keeps the league and re-derives the roster; a link keeps the account;
  - `view(null)` clears that league's remembered team; the ambiguous sentence differs from the none sentence;
  - registry pages (board, pre-draft trade, ESPN) show no "no league open" state and no team picker;
  - the format row label for PPR / half / standard / fractional, superflex, FAAB / rolling;
  - `connect.html` forwards to `weekly.html` and carries `?league=`;
  - no "your team"/"your roster" wording when the analysis role is viewer.
- **Browser pass** at desktop and 390 px: first visit → username → pick league → Weekly → Waivers → Trade with the team
  carried; link path → choose team → other pages carry it; "Not you?" → switch and forget; a bad `?league=`; the
  archived board still loads.

## 7. Left to the builder

- Exact CSS within the existing tokens in `interface.css` / `style.css`.
- Where the format-label helper lives (next to `boardFormatLabel` in `app.js` is the obvious place; it reads a live
  Sleeper league object, not a board block).
- Row order in the league list: Sleeper's order.

## 8. Calls made without the owner (check these)

1. Approach A (one bar) over B and C.
2. Read "the UI that just says your league format" as the connect-page league cards and the bar's settings lines;
   both go, and format shrinks to one short line per league row.
3. Exactly one current-season league opens without a click, but only right after you type a username, never on
   page load.
4. A team picked without a username stays "Viewing <team>" (not "your team") and is remembered per league, inside
   `session.js`; choosing "Choose a team" clears that league's, forget clears all.
5. A returning visitor with a remembered account and no league sees their leagues listed without typing.
6. Typing a username swaps the account in place and keeps the open league; pasting a link opens that league and
   keeps the account.
7. `connect.html` forwards to Weekly rather than being deleted.
8. The archived board keeps its states in the new compact look; "Not you?" replaces "change" everywhere.
