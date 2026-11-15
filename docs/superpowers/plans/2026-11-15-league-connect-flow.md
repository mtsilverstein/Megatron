# League Connect Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the site's four ways into a Sleeper league with one compact league bar that leads with your team and remembers the team you view.

**Architecture:** The bar is the existing `#league-context` panel (`mountLeagueContext` + identity chip + league picker in `site/assets/app.js`), rebuilt around one input. `session.js` gains a per-league remembered viewed team. The old surfaces (`connect.js`, the connect page's forms, the tool-card prompt forms) are removed last, once the bar can do their job.

**Tech Stack:** Plain static HTML/CSS/JS (no framework, no build), Node fixtures `tests/*_fixture.cjs` (CI runs every one), pytest for Python (untouched here).

**Spec:** `docs/superpowers/specs/2026-11-15-league-connect-flow-design.md`

## Global Constraints

- No framework, no build step, no new dependency. UMD modules as today (`window.X` in the browser, `module.exports` under node).
- Synthetic ids, league names, team names and usernames only — in code, fixtures, docs and commit messages. Never a real one.
- Never hand-edit `site/data/**`.
- `session.js` header invariants hold: immutable committed bundle, generation tokens (superseded results commit nothing), `myRoster` cleared first, storage that throws or holds corrupt JSON degrades to memory-only and never throws, every Sleeper call through `Sleeper.get` / the injected `get`.
- No Sleeper request beyond today's: the bar's league list comes from `pickerLeagues`' existing `leaguesFor` call.
- At most one text input that accepts a username or league link on any page, in any state (after Task 4).
- A team chosen without an owning account is "Viewing <team>"; never "your team" / "your roster" when `analysisRole` is `"viewer"`.
- Keep every existing element id whose role survives (`session-user`, `session-use`, `session-change`, `session-forget`, `session-cancel`, `session-refresh`, `session-retry`, `session-team`, `session-text`, `session-chip`, `league-context`, `connect-prompt`, `connect-prompt-lead`); only their text changes. Removed: `session-settings`, `session-who`, `connect-prompt-form`, `connect-prompt-input`, `connect-prompt-status`, `connect-prompt-results`, `connect-user`, `connect-league` and the connect page's other ids.
- Worktree test commands (no `.venv` in a worktree): one fixture `node tests/<name>_fixture.cjs`; all fixtures `for f in tests/*_fixture.cjs; do PYTHON="$(cygpath -w "$(which python)")" node "$f" || { echo "FAIL $f"; break; }; done`; pytest `PYTHONPATH=src python -m pytest -q -p no:cacheprovider`. Baseline before Task 1: every fixture passes.

## Review Focus

1. **A visitor viewing a remembered team types the username of that team's owner** → the bar flips to "Your team: …" (owned roster wins) and the remembered view is not shown again. Pinned in Task 1 (check 31).
2. **The account's league list fails or times out on a page with no league** → the bar shows the error and a Retry that refetches once, never an empty bar. Pinned in Task 3 (B7).
3. **A remembered league that no longer loads, plus a remembered account with exactly one league** → the page lists that league and never opens it by itself, so there is no reload loop. Pinned in Task 3 (B5).
4. **Pasted links with spaces, a trailing path, a query or an `m.` / `www.` subdomain** → open the league; look-alike hosts are refused. Pinned in Task 2.
5. **Storage that throws, or holds a corrupt viewed-team record** → the page still loads and choosing a team still works for this page. Pinned in Task 1 (check 32).

---

### Task 1: Remember the viewed team per league (`session.js`)

**Files:**
- Modify: `site/assets/session.js` (constants near line 73; `deleteKeys` ~273; `ready` id path ~443; `view` ~535)
- Test: `tests/session_fixture.cjs` (new checks 29–32, inserted after check 28, before `"registry and module hygiene"`)

**Interfaces:**
- Consumes: nothing new.
- Produces: storage key `megatron:viewedTeams` = JSON array of `[leagueIdString, rosterIdString]` pairs, oldest first, max 20. Behaviour: `Session.ready({leagueId})` seeds `bundle.viewedRosterId` (the roster's own `roster_id` value, e.g. number `3`) from it; `Session.view(id)` writes it; `Session.view(null)` deletes this league's pair; `Session.forget()` deletes the key. No API names change. The registry (board) path neither reads nor writes it.

- [ ] **Step 1: Write the failing tests** (inside the id-path block, so `X`, `routesX`, `fakeStorage`, `throwingStorage`, `fakeGet` are in scope)

```js
  const VT = "megatron:viewedTeams";
  const pairs = store => JSON.parse(store.getItem(VT));
  await check("29. viewed team: remembered per league, seeded on load, cleared by view(null) and forget", async () => {
    const store = fakeStorage();
    Session._storage(store); Session._get(fakeGet(routesX()).get);
    await Session.ready({ leagueId: X });
    Session.view(3);
    assert.deepEqual(pairs(store), [[X, "3"]]);
    Session._storage(store); Session._get(fakeGet(routesX()).get);   // a new page load, same device
    const b = await Session.ready({ leagueId: X });
    assert.equal(b.viewedRosterId, 3);
    assert.equal(b.analysisRole, "viewer");
    assert.equal(b.analysisRoster.roster_id, 3);
    store.setItem(VT, JSON.stringify([["700000000000000002", "5"], [X, "3"]]));
    Session.view(null);
    assert.deepEqual(pairs(store), [["700000000000000002", "5"]], "view(null) clears only this league");
    Session.view(2);
    assert.deepEqual(pairs(store), [["700000000000000002", "5"], [X, "2"]]);
    Session.forget();
    assert.equal(store.getItem(VT), null, "forget deletes every league's remembered team");
  });
  await check("30. viewed team: missing roster dropped, other league not inherited, 20-pair cap", async () => {
    const s1 = fakeStorage({ [VT]: JSON.stringify([[X, "99"]]) });
    Session._storage(s1); Session._get(fakeGet(routesX()).get);
    assert.equal((await Session.ready({ leagueId: X })).viewedRosterId, null);
    assert.deepEqual(pairs(s1), [], "a roster id missing from the league is dropped");
    const Y = "700000000000000002";
    const s2 = fakeStorage({ [VT]: JSON.stringify([[Y, "2"]]) });
    Session._storage(s2); Session._get(fakeGet(routesX()).get);
    assert.equal((await Session.ready({ leagueId: X })).viewedRosterId, null);
    assert.deepEqual(pairs(s2), [[Y, "2"]], "another league's pair is untouched");
    const many = Array.from({ length: 20 }, (_, i) => [`8000000000000000${String(i).padStart(3, "0")}`, "1"]);
    const s3 = fakeStorage({ [VT]: JSON.stringify(many) });
    Session._storage(s3); Session._get(fakeGet(routesX()).get);
    await Session.ready({ leagueId: X });
    Session.view(2);
    const kept = pairs(s3);
    assert.equal(kept.length, 20);
    assert.deepEqual(kept[19], [X, "2"]);
    assert.deepEqual(kept[0], many[1], "the oldest pair is dropped");
    Session.view(3);
    assert.equal(pairs(s3).filter(p => p[0] === X).length, 1, "re-choosing moves the league's pair, never duplicates it");
  });
  await check("31. viewed team: an owned roster wins, at load and when the owner identifies", async () => {
    const s1 = fakeStorage({ [VT]: JSON.stringify([[X, "3"]]) });
    Session._storage(s1); Session._get(fakeGet(routesX()).get);
    await Session.identify("gamma");                 // owns roster 3
    const own = await Session.ready({ leagueId: X });
    assert.equal(own.analysisRole, "owner");
    assert.equal(own.viewedRosterId, null);
    assert.deepEqual(pairs(s1), [], "seeding over an owned roster deletes the pair");
    const s2 = fakeStorage({ [VT]: JSON.stringify([[X, "1"]]) });
    Session._storage(s2); Session._get(fakeGet(routesX()).get);
    assert.equal((await Session.ready({ leagueId: X })).analysisRole, "viewer");
    await Session.identify("alpha");                 // owns roster 1: the remembered view gives way
    assert.equal(Session.bundle().analysisRole, "owner");
    assert.equal(Session.bundle().viewedRosterId, null);
  });
  await check("32. viewed team: corrupt or throwing storage never throws", async () => {
    const s1 = fakeStorage({ [VT]: "{not json" });
    Session._storage(s1); Session._get(fakeGet(routesX()).get);
    assert.equal((await Session.ready({ leagueId: X })).viewedRosterId, null);
    Session.view(2);
    assert.deepEqual(pairs(s1), [[X, "2"]], "a corrupt record is replaced");
    Session._storage(throwingStorage()); Session._get(fakeGet(routesX()).get);
    await Session.ready({ leagueId: X });
    assert.doesNotThrow(() => Session.view(3));
    assert.equal(Session.bundle().viewedRosterId, 3, "memory-only: the view still applies on this page");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/session_fixture.cjs`
Expected: FAIL at check 29 (`pairs(store)` is `null`).

- [ ] **Step 3: Implement in `site/assets/session.js`**

Add `VIEWED_TEAMS_KEY = "megatron:viewedTeams"` and `MAX_VIEWED = 20`; two private helpers, `readViewed()` → array of valid `[string, string]` pairs (anything unreadable → `[]`, never throws) and `writeViewed(pairs)` (best-effort, never throws; writes `[]` as `[]`). In `ready()`'s id path, after the generation check, look up the league's pair, match it against `parts.rosters` by `String(roster_id)`, pass the hit's `roster_id` as `buildBundle`'s `viewedRosterId`; delete the pair when the roster is missing or the bundle has `myRoster`. `view()` writes/moves (or, for `null`, deletes) this league's pair after it commits. Add `VIEWED_TEAMS_KEY` to `deleteKeys`' doomed set. Update the header comment's storage list in one line.

- [ ] **Step 4: Run to verify they pass, then the whole suite**

Run: `node tests/session_fixture.cjs` → `session_fixture: <N> groups OK` with N four higher than before.
Run the all-fixtures loop (Global Constraints) → no FAIL.

- [ ] **Step 5: Commit**

```bash
git add site/assets/session.js tests/session_fixture.cjs
git commit -m "feat(session): remember the team viewed in each league on this device"
```

---

### Task 2: One-box helpers in `app.js` (`FC.parseLeagueInput`, `FC.leagueFormatLabel`)

**Files:**
- Modify: `site/assets/app.js` (add both next to `boardFormatLabel`, ~line 129; export on the returned API object, ~line 893)
- Modify: `site/assets/connect.js` (its own `parseLeagueInput` body is replaced by delegation to `FC.parseLeagueInput`, resolved with the file's existing `dep` helper, so one copy exists; connect.js is deleted in Task 4)
- Create: `tests/league_input_fixture.cjs`
- Modify: `tests/connect_fixture.cjs` (move its `parseLeagueInput` cases, ~lines 146–152, into the new fixture)

**Interfaces:**
- Produces: `FC.parseLeagueInput(text: any) => string | null` — today's `connect.js` function, unchanged behaviour. `FC.leagueFormatLabel(league: SleeperLeague | null) => string` — parts joined by `" · "`, each omitted when unknown: `"<total_rosters> teams"` (positive integer only); rec `1` → `"PPR"`, `0.5` → `"Half-PPR"`, missing/`0` → `"Standard"`, any other number x → `` `${x}-pt PPR` ``; `"Superflex"` when `roster_positions` includes `"SUPER_FLEX"`; `settings.waiver_type` `2` → `"FAAB"`, `0` → `"Rolling waivers"`, anything else → omitted (no guess). `null`/non-object → `""`.

- [ ] **Step 1: Write the failing test** (`tests/league_input_fixture.cjs`)

```js
// tests/league_input_fixture.cjs — run with: node tests/league_input_fixture.cjs
// The one box's pure helpers (connect-flow spec §5.1, §5.3). Synthetic ids only.
const assert = require("node:assert/strict");
const FC = require("../site/assets/app.js");
const P = FC.parseLeagueInput;
const X = "123456789012345678";
assert.equal(P(X), X);
assert.equal(P(` https://sleeper.com/leagues/${X}/team?x=1 `), X);
assert.equal(P(`sleeper.com/leagues/${X}`), X);
assert.equal(P(`https://m.sleeper.com/leagues/${X}/matchup`), X);
assert.equal(P("https://www.sleeper.com/leagues/42"), "42");
assert.equal(P("https://evilsleeper.com/leagues/42"), null);
assert.equal(P(`https://sleeper.com.evil.example/leagues/${X}`), null);
assert.equal(P("https://sleeper.com/users/abc"), null);
assert.equal(P("user_a"), null);
assert.equal(P(""), null);
assert.equal(P(null), null);
const F = FC.leagueFormatLabel;
const lg = o => ({ total_rosters: 12, scoring_settings: { rec: 1 }, roster_positions: ["QB", "RB", "WR", "TE", "FLEX", "BN"], settings: { waiver_type: 2 }, ...o });
assert.equal(F(lg()), "12 teams · PPR · FAAB");
assert.equal(F(lg({ total_rosters: 10, scoring_settings: { rec: 0.5 }, roster_positions: ["QB", "SUPER_FLEX", "BN"], settings: { waiver_type: 0 } })),
  "10 teams · Half-PPR · Superflex · Rolling waivers");
assert.equal(F(lg({ scoring_settings: {} })), "12 teams · Standard · FAAB");
assert.equal(F(lg({ scoring_settings: { rec: 0 } })), "12 teams · Standard · FAAB");
assert.equal(F(lg({ scoring_settings: { rec: 0.25 } })), "12 teams · 0.25-pt PPR · FAAB");
assert.equal(F(lg({ settings: { waiver_type: 1 } })), "12 teams · PPR");
assert.equal(F(lg({ total_rosters: undefined, settings: {} })), "PPR");
assert.equal(F(null), "");
console.log("league_input_fixture: OK");
```

Also carry over every other `parseLeagueInput` case from `tests/connect_fixture.cjs` that is not already above, then delete them there.

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/league_input_fixture.cjs` → FAIL (`P is not a function`).

- [ ] **Step 3: Implement both helpers in `app.js` and delegate `connect.js`'s `parseLeagueInput` to `FC.parseLeagueInput`**

- [ ] **Step 4: Run** `node tests/league_input_fixture.cjs` → `league_input_fixture: OK`; `node tests/connect_fixture.cjs` → OK; then the all-fixtures loop → no FAIL.

- [ ] **Step 5: Commit**

```bash
git add site/assets/app.js site/assets/connect.js tests/league_input_fixture.cjs tests/connect_fixture.cjs
git commit -m "feat(site): league-link parser and short league format label in app.js"
```

---

### Task 3: The league bar (`app.js` panel + chip + picker, `session.js` `chipText`, CSS)

**Files:**
- Modify: `site/assets/app.js` — `mountLeagueContext` (~586), the chip (`identifyForm`, `teamPicker`, `renderChip`, `chipRetry`, `chipIdentify`, `promptShown` removed), the picker (`renderPicker`, `pickerLeagues`).
- Modify: `site/assets/session.js` — `chipText` (~181) only.
- Modify: `site/assets/interface.css` (bar rules ~34–63 and the ≤480 px block ~96–106); `site/assets/style.css` only if a `.session-*` rule there fights the new layout.
- Create: `tests/league_bar_fixture.cjs` (real `Session`, fake Sleeper/storage/DOM — copy the fake-DOM helpers from `tests/chip_session_fixture.cjs`, adding `hidden`, `href`, and a `location.assign` recorder).
- Modify: every fixture this task's copy breaks — expected `tests/chip_session_fixture.cjs`, `tests/navigation_fixture.cjs` (chip block ~258+ and the "Find my Sleeper leagues" link checks), `tests/session_fixture.cjs` (`chipText` checks, e.g. lines 154/160), `tests/trademode_fixture.cjs:447`, and the tool fixtures whose gate text embeds `chipText` for none/ambiguous. List every changed assertion and why in the report.

**Interfaces:**
- Consumes: Task 1's seeded `viewedRosterId`; Task 2's `FC.parseLeagueInput`, `FC.leagueFormatLabel`.
- Produces (Task 4 relies on): the bar works with no `#connect-prompt` present on the page; on in-season pages and About it accepts a link or a username; `chipText` strings below.

**The bar, by state.** "Bar pages" = the in-season tool pages and About (the id path or no league). "Registry pages" = the board and pre-draft trade (`setBoard`). Line = `#session-text`. Controls render in the order listed. At no point does the panel hold more than one `<input>`.

| State | League control | Line | Controls / extra |
|---|---|---|---|
| Bar page, no league, no account | none | `""` | `#session-heading` "Connect your Sleeper league"; form; `#session-note` "No password. Read-only: nothing is changed in Sleeper." |
| Identifying | as before | `Looking up Sleeper account…` | none |
| Bar page, no league, account known | none | `Sleeper account: <displayName \|\| username>` | `#session-change` "Not you?"; `#session-leagues` (below) |
| Loading league | as before | `Loading league…` | `#session-change` "Not you?" if an account is known |
| League open, owner | select (account's leagues, open one first) | `Your team: <team name> · rosters N s ago` (+ ` · refreshing…`) | `#session-refresh` "Refresh", `#session-change` "Not you?" |
| League open, no account, no team | `#league-name` (text) | `Which team do you want to see?` | `#session-team` (label "Team", first option "Choose a team"), `#session-find` "or find your team with your username" |
| League open, no account, team chosen | `#league-name` | `Viewing <team> · rosters N s ago` | `#session-team`, `#session-refresh`, `#session-find` "Use my username" |
| League open, account, no roster | select | `You have no team here.` (+ ` Viewing <team> · rosters N s ago` once chosen) | `#session-team`, `#session-refresh`, `#session-change` "Not you?" |
| …ambiguous | select | `This account is on more than one team here.` (same suffix) | same |
| Error, no account, identify failed, no league bundle | as before | the error text | form prefilled with the failed name (no Retry) |
| Any other error | as before | the error text | `#session-retry` "Retry", `#session-change` ("Not you?" with an account, else "Use my username") |
| Revealed box (after Not you? / Use my username / or find your team…) | unchanged | unchanged | form (empty), `#session-cancel` "Cancel", `#session-forget` "Forget me on this device" only with an account; `#session-team` is not rendered |
| Registry page, anonymous | text, as today | `Remembered on this device until you choose forget.` (unchanged) | form labelled "Sleeper username" |
| Registry page, ESPN | as today | `<name> · <label>` (unchanged) | `#session-change` "Not you?" |

- The form: `form.session-form` > label ("Sleeper username or league link" on bar pages, "Sleeper username" on registry pages) wrapping `input#session-user` (same placeholder text as the label, `autocomplete="off"`, `spellcheck="false"`), `button#session-use` "Connect". Submit: trimmed empty → notice "Enter your Sleeper username or paste a sleeper.com league link." (registry: "Enter your Sleeper username."). Bar page and `FC.parseLeagueInput` gives an id → `location.assign` to this page (or `weekly.html` when this page is not an in-season tool) with `?league=<id>`, no Sleeper call. Link-shaped text (`/[/.:]/`) that is not a league → notice "Enter a Sleeper league id or a sleeper.com league link." (registry: "Enter your Sleeper username."), no call. Otherwise identify in place; when no league is open, set a one-shot `autoOpen` flag.
- `#session-leagues` (bar pages, no league open, account known): while loading `Finding your leagues…`; rows `"Your <season> leagues"` then `ul > li > a[href=<this page or weekly.html>?league=<id>] (league name) + span.league-format (FC.leagueFormatLabel)`; zero leagues → `No <season> Sleeper leagues for <name>. Paste a league link instead.` plus the form; failure → the error message and `button#session-leagues-retry` "Retry", which re-runs the lookup once. `pickerLeagues` keeps each league object (for the label) and records loading/error instead of swallowing them. `autoOpen` + exactly one row → `location.assign` to it, once; any other result clears the flag. A page load never sets `autoOpen`.
- Removed from the panel: `#session-settings`, the bar pages' note paragraph ("In-season tools read this league's live Sleeper settings…" / "No league is open…"), the "Find my Sleeper leagues" link, `#session-who`, the `promptShown()` hand-off. Registry pages keep their existing note (the board's and ESPN's "not connected" sentence, `mountLeagueContext` ~631–635). The connect page's `connection-account` disclosure stays until Task 4.
- `chipText` (session.js) returns exactly the line strings above; `NO_UNIQUE_ROSTER` stays as the thrown error text of `identifyRoster`.
- CSS: connected bar is one row on desktop; at ≤ 480 px at most two rows (league; team control + refresh + account link). Use existing tokens.

- [ ] **Step 1: Write the failing tests** — `tests/league_bar_fixture.cjs`, one `check` per case, Sleeper routes for a synthetic account `user_a` (display "User A") with leagues `X` ("Synthetic Six", 12 teams, rec 1, FAAB) and `Y` ("Synthetic Ten", 10 teams, rec 0.5, `SUPER_FLEX`, rolling). League X's users and rosters copy `session_fixture.cjs`'s id-path block (~760–770: roster 1 "Alpha Squad", 2 "Beta", 3 "Gamma Rays"); add usernames `alpha`/`gamma`/`outsider` as there:
  - **B1** weekly.html, no league, no account: heading, label "Sleeper username or league link", `#session-use` "Connect", note text; no `#session-settings`; no element with text "Find my Sleeper leagues"; zero Sleeper calls.
  - **B2** box input `` ` https://sleeper.com/leagues/${X}/x ` `` → one `location.assign` of `.../weekly.html?league=X`, zero calls; same on about.html → `.../weekly.html?league=X`; `"evil.example/leagues/1"` → notice "Enter a Sleeper league id or a sleeper.com league link.", zero calls; `""` → notice "Enter your Sleeper username or paste a sleeper.com league link."
  - **B3** username `user_a`, two leagues: line `Sleeper account: User A`; two rows with hrefs `weekly.html?league=X|Y` and labels `12 teams · PPR · FAAB`, `10 teams · Half-PPR · Superflex · Rolling waivers`; no `assign`; each of `/user/user_a`, `/state/nfl`, `/user/<id>/leagues/nfl/2026` requested once.
  - **B4** username with exactly one league → exactly one `assign` to `.../weekly.html?league=X`.
  - **B5** identity already in storage, page load, no league, one league → the row is listed, zero `assign`.
  - **B6** zero leagues → `No 2026 Sleeper leagues for User A. Paste a league link instead.` and the form present.
  - **B7** leagues request rejects → `#session-leagues` shows the message and `#session-leagues-retry`; click → one more leagues request → rows.
  - **B8** weekly.html?league=X anonymous: `#league-name` "Synthetic Six", no visible league select, line `Which team do you want to see?`, `#session-team` options "Choose a team" + team names, `#session-find` "or find your team with your username"; choosing roster 3 → line matches `/^Viewing Gamma Rays · rosters \d+ s ago$/`, `#session-find` "Use my username", `#session-refresh` present.
  - **B9** click `#session-find` → `#session-user` present, no `#session-team`, `#session-cancel` "Cancel", no `#session-forget`; Cancel → back to B8's controls.
  - **B10** owner on X: line `/^Your team: Alpha Squad · rosters \d+ s ago$/`; controls exactly `session-refresh`, `session-change` ("Not you?"); click → form, `#session-cancel`, `#session-forget` "Forget me on this device".
  - **B11** account with no roster in X → `You have no team here.`; with two → `This account is on more than one team here.`; choose a team → `/^You have no team here\. Viewing .+ · rosters \d+ s ago$/`.
  - **B12** username submitted while X is open → zero `assign`, `Session.bundle().league.league_id === X`, no second `/league/X` request.
  - **B13** board page (`setBoard`, registry path): label "Sleeper username"; no heading, no `#session-leagues`, no `#session-team`; link-shaped input → notice "Enter your Sleeper username.", zero calls.
  - **B14** after every case above: the panel holds at most one `input`.
  - **B15** owner opened a league that is not in the account's list (a shared link): the select's first option is the open league, followed by the account's leagues.

- [ ] **Step 2: Run** `node tests/league_bar_fixture.cjs` → FAIL at B1.

- [ ] **Step 3: Implement the table and rules above** in `app.js`, `chipText` in `session.js`, and the CSS.

- [ ] **Step 4: Run** `node tests/league_bar_fixture.cjs` → all cases OK; update the fixtures this broke (Files list), then the all-fixtures loop → no FAIL.

- [ ] **Step 5: Commit**

```bash
git add site/assets/app.js site/assets/session.js site/assets/interface.css site/assets/style.css tests/
git commit -m "feat(site): one league bar — connect box, your-leagues list, compact connected line"
```

---

### Task 4: Remove the other ways in; tool cards point at the bar; cache keys

**Files:**
- Delete: `site/assets/connect.js`, `tests/connect_fixture.cjs` (its remaining cases are obsolete; Task 2 moved the parser cases).
- Replace: `site/connect.html` with a forwarder (below).
- Modify: `site/weekly.html`, `site/waivers.html`, `site/trade.html` — `#connect-prompt` keeps its element and classes but holds only `<p id="connect-prompt-lead">…</p>`; delete the form, status, results list and "More ways to connect"; drop the `connect.js` script tag; `trade.html` drops its `LeagueConnect.initPrompt()` call (~131). `weekly.html`'s `.page-intro` becomes `Set your lineup, then explore the projections behind it.`
- Modify: `site/assets/startsitmode.js` (~73, ~163), `site/assets/waivermode.js` (~458, ~979), `site/assets/seasontrademode.js` (~714), `site/assets/liveworld.js` (`NO_ANALYSIS`, ~26).
- Modify: `site/assets/app.js` `mountLeagueNotice` (~641): no "Go to the connect page" link; the note text is unchanged.
- Modify: `site/assets/interface.css` — delete the `.connect-options`, `.connect-prompt form/input/button/ul`, `.connection-account` rules.
- Modify: cache keys to `?v=cf1` for `app.js`, `session.js`, `liveworld.js`, `startsitmode.js`, `waivermode.js`, `seasontrademode.js`, `style.css`, `interface.css` on every page that loads each (`tests/shared_assets_fixture.cjs` requires one version per asset across pages).
- Test: `tests/navigation_fixture.cjs` (the "one identity input" block ~237–257 and the notice-link check ~138), `tests/weekly_page_fixture.cjs` (~131), `tests/seasontrademode_fixture.cjs` (~47, ~1608–1632), `tests/startsitmode_session_fixture.cjs`, `tests/waivermode_session_fixture.cjs`, `tests/waivermode_fixture.cjs` (~412), `tests/liveworld_fixture.cjs` (~16), `tests/interface_hierarchy_fixture.cjs` (~12), `tests/shared_assets_fixture.cjs`.

**Interfaces:**
- Consumes: Task 3's bar (the only input).
- Produces: final copy. `LiveWorld.NO_ANALYSIS = "Choose a team in the bar above."`. Tool sentences, where `<what>` is `start/sit advice` (weekly), `waiver advice` (waivers), `trade scenarios` (trade):
  - `#connect-prompt-lead`, no league open: `Connect your league in the bar above to see <what>.`
  - gate, league open, no team, no account: `Choose a team in the bar above to see <what>.`
  - gate, account with no unique roster: `` `${chipText} Choose a team in the bar above to see <what>.` `` (chipText from Task 3, e.g. `You have no team here.`)

`site/connect.html`, whole file:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Megatron</title>
<script>
// The connect page moved into the league bar on every page (connect-flow spec §5.5).
// Old links and bookmarks forward to Weekly, keeping a numeric ?league=.
(function () {
  var to = new URL("weekly.html", location.href);
  var league = new URLSearchParams(location.search).get("league");
  if (league && /^\d+$/.test(league)) to.searchParams.set("league", league);
  location.replace(to.href);
})();
</script>
<noscript><meta http-equiv="refresh" content="0; url=weekly.html"></noscript>
</head>
<body>
<p><a href="weekly.html">Continue to Megatron</a></p>
</body>
</html>
```

- [ ] **Step 1: Update the tests to the final contract**
  - `navigation_fixture` one-input block: no `site/*.html` contains `connect-prompt-form`, `connect-prompt-input`, `connect-user`, `connect-league`, `More ways to connect`, `Find my Sleeper leagues`, or loads `connect.js`; `site/assets/connect.js` does not exist. The notice check asserts no link to `connect.html`.
  - New check (in `navigation_fixture`): run `connect.html`'s inline script in `vm` with a stub `location` (`href`/`search`/`replace` recorder): `?league=123` → replaced with `.../weekly.html?league=123`; `?league=abc` → `.../weekly.html`; no `?league=` → `.../weekly.html`. The file contains no `<form`.
  - Page fixtures: each `#connect-prompt-lead` equals its `Connect your league in the bar above to see <what>.` sentence; each tool's gate strings are the three above; `liveworld_fixture`/`waivermode_fixture` `NO_ANALYSIS` constants updated; weekly intro text; `interface_hierarchy` drops `connect.html` as a content page.
  - `shared_assets_fixture`: passes with `cf1` everywhere.

- [ ] **Step 2: Run** the all-fixtures loop → FAIL in the updated fixtures.

- [ ] **Step 3: Apply the file changes listed above.**

- [ ] **Step 4: Run** the all-fixtures loop → no FAIL; `PYTHONPATH=src python -m pytest -q -p no:cacheprovider` → passes (no Python changed; guards the site-JSON schema tests).

- [ ] **Step 5: Commit**

```bash
git add -A site tests
git commit -m "feat(site): the league bar is the only way in; connect page forwards to Weekly"
```

---

## After Task 4 (final review's browser pass, desktop and 390 px)

First visit → username → pick a league → Weekly → Waivers → Trade with the team carried; link path → choose a team → other pages keep it; "Not you?" → switch account, then forget; a bad `?league=`; `connect.html?league=<id>` forwards; the archived board still loads and identifies. The connected bar is one line on desktop and at most two at 390 px.
