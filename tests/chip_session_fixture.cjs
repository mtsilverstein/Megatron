// tests/chip_session_fixture.cjs — run with: node tests/chip_session_fixture.cjs
//
// The REAL identity chip (app.js) driven against the REAL Session (session.js)
// -- the seam navigation_fixture stubs and session_fixture never renders. One
// page's life: mount anonymous, set the board, identify from the chip's own
// form, watch the league load and the ticker move the age, click "change" and
// type, then "forget". Sleeper is an injected `get`; storage is a Map.
const assert = require("node:assert/strict");
global.window = {};
require("../site/assets/app.js");
const FC = window.FC;
const Session = require("../site/assets/session.js");   // installs window.Session, which the chip reads
assert.equal(window.Session, Session);

// ---- fake DOM (the shape navigation_fixture's chip block uses) --------------
function element(tagName) {
  return {
    tagName, children: [], listeners: {}, textContent: "", className: "", id: "", value: "", attrs: {},
    append(...nodes) { this.children.push(...nodes); },
    prepend(...nodes) { this.children.unshift(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; },
    dispatch(type) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {} }); },
  };
}
const all = node => [node, ...node.children.flatMap(all)];
const byId = (root, id) => all(root).find(n => n.id === id) || null;
function dom(href) {
  const main = element("main");
  global.location = new URL(href);
  global.document = {
    createElement: element,
    querySelector(selector) { return selector === "main" ? main : null; },
    querySelectorAll() { return []; },
    getElementById(id) { return byId(main, id); },
  };
  return main;
}

// ---- fake Sleeper + storage ---------------------------------------------------
const L = "100000000000000001";   // League A's synthetic registry id
// A board page registers its board's own league block; the hook stands in for it.
FC._registry([{ slug: "leaguea", platform: "sleeper", leagueId: L, label: "12-team PPR, 6-pt pass TD",
  tools: { draft: true, keepers: true, trade: true, waivers: true, startsit: true } }]);
const user = { user_id: "u1", username: "user_a", display_name: "User A" };
const league = { league_id: L, name: "League A", season: "2026", status: "in_season" };
const users = [{ user_id: "u1", display_name: "User A" }, { user_id: "u2", display_name: "Bo" }];
const rosters = [{ roster_id: 9, owner_id: "u1", players: ["a"] }, { roster_id: 3, owner_id: "u2", players: ["b"] }];
const state = { season: "2026", season_type: "regular", week: 3 };
const routes = {
  "/user/user_a": user, [`/league/${L}`]: league, [`/league/${L}/users`]: users,
  [`/league/${L}/rosters`]: rosters, "/state/nfl": state,
  "/user/u1/leagues/nfl/2026": [league],
};
const calls = [];
const failures = {};   // path -> message: Sleeper answers with an error
Session._get(path => {
  calls.push(path);
  if (failures[path]) return Promise.reject(new Error(failures[path]));
  const hit = routes[path];
  return hit === undefined ? Promise.reject(new Error(`unrouted ${path}`)) : Promise.resolve(hit);
});
const m = new Map();
const store = {
  getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
  removeItem: k => { m.delete(k); }, key: i => [...m.keys()][i] ?? null, get length() { return m.size; },
};
Session._storage(store);
const IDENTITY_KEY = "megatron:session:identity";
const REMEMBERED = "Remembered on this device until you choose forget.";
const pause = ms => new Promise(r => setTimeout(r, ms));
const until = async (pred, what, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
};
// A REAL tick of the chip's 1 s interval: wait until the line's age text
// changes (the age is floored to whole seconds, so up to ~2 s).
async function realTick(panel) {
  const before = byId(panel, "session-text").textContent;
  await until(() => byId(panel, "session-text").textContent !== before, "the ticker to move the age", 3000);
}

(async () => {
  // 1. Anonymous mount on the draft board: the form, the sentence, no calls.
  const main = dom("https://example.test/Megatron/index.html?league=leaguea");
  FC._session(null);                                   // the chip must find window.Session itself
  FC.mountLeagueContext("leaguea");
  const panel = main.children[0];
  assert.equal(panel.id, "league-context");
  assert.ok(byId(panel, "session-user"), "anonymous: username input offered");
  assert.equal(byId(panel, "session-user").attrs.spellcheck, "false");
  assert.equal(byId(panel, "session-user").autocomplete, "off", "not a login field: no saved-login suggestions");
  assert.equal(byId(panel, "session-text").textContent, REMEMBERED);
  assert.equal(Session.state(), "anonymous");

  // 2. The board arrives before any identity: nothing is fetched.
  FC.setBoard({ league: { league_id: L } });
  await pause(5);
  assert.deepEqual(calls, [], "a board with no identity must not load the league");

  // 3. Identify through the chip's own form -> Session.identify -> ready().
  byId(panel, "session-user").value = " user_a ";
  all(panel).find(n => n.tagName === "form").dispatch("submit");
  assert.equal(Session.state(), "identifying");
  assert.equal(byId(panel, "session-text").textContent, "Looking up Sleeper account…", "identifying is rendered synchronously");
  await until(() => Session.state() === "ready", "the league to load after identify");
  assert.deepEqual(calls.slice().sort(), ["/user/user_a", `/league/${L}`, `/league/${L}/users`, `/league/${L}/rosters`, "/state/nfl"].sort(),
    "identify + one league load, nothing else");
  const b1 = Session.bundle();
  assert.equal(b1.myRoster.roster_id, 9);
  assert.equal(JSON.parse(m.get(IDENTITY_KEY)).userId, "u1", "the identity is persisted");
  assert.match(byId(panel, "session-text").textContent, /^User A · League A · your roster: 9 · rosters 0 s ago$/);
  const refreshBtn = byId(panel, "session-refresh"), changeBtn = byId(panel, "session-change"), forgetBtn = byId(panel, "session-forget");
  assert.ok(refreshBtn && changeBtn && forgetBtn, "ready: refresh, change, forget");
  assert.ok(!byId(panel, "session-user"), "ready: no username input");

  // 4. A real tick of the 1 s ticker: the age moves, the buttons are the SAME nodes.
  await realTick(panel);
  assert.match(byId(panel, "session-text").textContent, /rosters [1-3] s ago$/, "the ticker moved the age");
  assert.equal(byId(panel, "session-refresh"), refreshBtn, "a tick must not rebuild the refresh button");
  assert.equal(byId(panel, "session-change"), changeBtn);
  assert.equal(byId(panel, "session-forget"), forgetBtn);

  // 5. change -> type -> a tick (both the direct render and the real interval):
  //    the typed name survives in the same input node; cancel restores ready.
  changeBtn.dispatch("click");
  const input = byId(panel, "session-user");
  assert.ok(input && input.value === "user_a", "change: input prefilled with the current username");
  assert.ok(byId(panel, "session-cancel"), "change from ready offers cancel");
  input.value = "newname-typed";
  FC.chip.render();
  assert.equal(byId(panel, "session-user"), input, "render must not rebuild the input");
  await realTick(panel);
  assert.equal(byId(panel, "session-user"), input, "a real tick must not rebuild the input");
  assert.equal(input.value, "newname-typed", "a real tick must not revert the typed name");
  assert.match(byId(panel, "session-text").textContent, /^User A · League A · your roster: 9 · rosters [2-6] s ago$/,
    "the line kept the account and kept ticking behind the form");
  byId(panel, "session-cancel").dispatch("click");
  assert.ok(byId(panel, "session-refresh") && !byId(panel, "session-user"), "cancel returns to the ready controls");
  assert.equal(Session.identity().userId, "u1", "cancel changes nothing in the session");

  // 6. forget: identity and storage gone, the bundle re-derived anonymous with
  //    its timestamps kept (so the ticker keeps running), no network call, and
  //    the anonymous form survives the ticks like the change form did.
  const callsBefore = calls.length;
  byId(panel, "session-forget").dispatch("click");
  assert.equal(Session.identity(), null);
  assert.equal(Session.state(), "anonymous");
  assert.equal(m.has(IDENTITY_KEY), false, "forget deletes the stored identity");
  const b2 = Session.bundle();
  assert.ok(b2 && b2.identity === null && b2.myRoster === null && b2.myRosterStatus === "anonymous", "the bundle is re-derived for no account");
  assert.equal(b2.rostersFetchedAt, b1.rostersFetchedAt, "forget does not refetch or move the timestamps");
  assert.equal(byId(panel, "session-text").textContent, REMEMBERED);
  const anonInput = byId(panel, "session-user");
  assert.ok(anonInput && anonInput.value === "", "forget offers an empty username input");
  assert.ok(!byId(panel, "session-forget") && !byId(panel, "session-refresh") && !byId(panel, "session-cancel"));
  anonInput.value = "other-typed";
  FC.chip.render();
  await pause(1100);                                   // the anonymous line has no age, so wait a full tick
  assert.equal(byId(panel, "session-user"), anonInput, "a tick after forget must not rebuild the input");
  assert.equal(anonInput.value, "other-typed", "a tick after forget must not empty the input");
  assert.equal(calls.length, callsBefore, "forget makes no Sleeper call");

  // 7. Identifying again from the anonymous form: identify/forget never
  //    refetch (spec §4), so the retained bundle is re-derived for the new
  //    account -- one /user call, no league load, the seat back, the age
  //    still counting from the ORIGINAL fetch.
  anonInput.value = "user_a";
  all(panel).find(n => n.tagName === "form").dispatch("submit");
  await until(() => Session.state() === "ready" && Session.bundle().myRoster, "re-identify to re-derive the seat");
  assert.deepEqual(calls.slice(callsBefore), ["/user/user_a", "/user/u1/leagues/nfl/2026"],
    "re-identify looks the user up and the league picker reads the account's own leagues (the bundle's season); no league load");
  {
    // The board page's picker: the open board (by its format label, never a
    // league name), then the account's own current-season leagues.
    const select = all(panel).find(n => n.tagName === "select");
    await until(() => select.children.length === 2, "the picker to list the account's league");
    assert.deepEqual(select.children.map(o => [o.value, o.textContent]), [["leaguea", "12-team PPR, 6-pt pass TD"], [L, "League A"]]);
  }
  assert.equal(Session.bundle().rostersFetchedAt, b1.rostersFetchedAt);
  assert.match(byId(panel, "session-text").textContent, /^User A · League A · your roster: 9 · rosters [3-9] s ago$/);
  assert.ok(byId(panel, "session-refresh") && byId(panel, "session-forget") && !byId(panel, "session-user"));

  // 8. An in-season page by Sleeper id (any-league spec 5.1, 5.2), real
  //    Session: anonymous load at once, choose a team to VIEW, then identify
  //    as the owner of a DIFFERENT team -- the owner's roster wins and the
  //    viewed choice is dropped. Refresh re-reads the league's settings.
  FC.setBoard(null);
  Session._storage(store);                             // a fresh document: anonymous again
  m.clear();
  const X = "700000000000000001";
  Object.assign(routes, {
    [`/league/${X}`]: { league_id: X, name: "Synthetic Six", season: "2026", status: "in_season", scoring_settings: { rec: 0.5 } },
    [`/league/${X}/users`]: [{ user_id: "s1", display_name: "Alpha", metadata: { team_name: "Alpha Squad" } }, { user_id: "s2", display_name: "Beta" }, { user_id: "s3", display_name: "Gamma" }],
    [`/league/${X}/rosters`]: [{ roster_id: 1, owner_id: "s1", players: ["p1"] }, { roster_id: 2, owner_id: "s2", players: ["p2"] }, { roster_id: 3, owner_id: "s3", players: ["p3"] }],
    "/user/gamma": { user_id: "s3", username: "gamma", display_name: "Gamma" },
  });
  global.localStorage = store;                         // the page's own storage, the same one Session uses
  const idMain = dom(`https://example.test/Megatron/weekly.html?league=${X}`);
  FC.mountLeagueContext(X);
  const idPanel = idMain.children[0];
  calls.length = 0;
  FC.setLeague(X);
  await until(() => Session.state() === "ready", "the anonymous league load by id");
  assert.deepEqual(calls.slice().sort(), [`/league/${X}`, `/league/${X}/users`, `/league/${X}/rosters`, "/state/nfl"].sort(),
    "identity is optional: the league loads without one");
  const v0 = Session.bundle();
  assert.equal(v0.registry.leagueId, X); assert.equal(v0.registry.slug, null); assert.equal(v0.identity, null);
  // The league opened by id is the one this browser remembers (only the id).
  await until(() => m.get("megatron:lastLeague") === X, "the opened league to be remembered");
  assert.equal(byId(idPanel, "session-text").textContent, "Synthetic Six · choose a team to view, or enter your Sleeper username",
    "an anonymous visitor with a league loaded is told what to do, not about storage");
  assert.equal(byId(idPanel, "session-settings").textContent, Session.settingsText(v0));
  const picker = byId(idPanel, "session-team");
  assert.deepEqual(picker.children.map(o => o.textContent), ["Choose a team", "Alpha Squad", "Beta", "Gamma"]);
  picker.value = "2"; picker.dispatch("change");
  assert.equal(Session.bundle().analysisRole, "viewer");
  assert.equal(Session.bundle().myRoster, null);
  assert.match(byId(idPanel, "session-text").textContent, /^Viewing Beta · rosters [0-2] s ago$/);
  // Identify as the owner of roster 3 through the chip's own form.
  byId(idPanel, "session-user").value = "gamma";
  all(idPanel).find(n => n.tagName === "form").dispatch("submit");
  await until(() => Session.state() === "ready" && Session.bundle().myRoster, "identify as the owner");
  const o = Session.bundle();
  assert.equal(o.analysisRoster.roster_id, 3);
  assert.equal(o.analysisRole, "owner");
  assert.equal(o.viewedRosterId, null, "the viewed choice is dropped, not merged");
  assert.match(byId(idPanel, "session-text").textContent, /^Gamma · Synthetic Six · your roster: 3 · rosters [0-3] s ago$/);
  assert.ok(!byId(idPanel, "session-team"), "an owner is not offered other teams");
  assert.ok(!calls.slice(4).some(c => c.startsWith("/league/")), "identify never refetches the league");
  // The chip's refresh re-reads /league/<id>; changed settings land in a new bundle.
  routes[`/league/${X}`] = { ...routes[`/league/${X}`], scoring_settings: { rec: 1 } };
  await pause(5);
  calls.length = 0;
  byId(idPanel, "session-refresh").dispatch("click");
  await until(() => Session.bundle() !== o && Session.state() === "ready", "the refresh to commit");
  assert.ok(calls.includes(`/league/${X}`), "refresh always re-reads the league object");
  assert.deepEqual(Session.bundle().league.scoring_settings, { rec: 1 });
  assert.ok(Session.bundle().leagueFetchedAt > o.leagueFetchedAt);
  assert.equal(byId(idPanel, "session-settings").textContent, Session.settingsText(Session.bundle()));
  FC.setLeague(null);

  FC.setBoard(null);
  const connectMain = dom("https://example.test/Megatron/connect.html");
  FC.mountLeagueContext(null);
  const account = connectMain.children[0];
  assert.equal(account.tagName, "details", "discovery keeps secondary account controls in a disclosure");
  assert.ok(!account.open, "the second account form is collapsed initially");
  assert.equal(account.children[0].tagName, "summary");
  assert.ok(byId(account, "session-forget"), "saved identity can still be forgotten on discovery");
  assert.equal(m.get("megatron:lastLeague"), X);
  byId(account, "session-forget").dispatch("click");
  assert.equal(Session.identity(), null);
  assert.equal(m.has("megatron:lastLeague"), false, "forget removes the remembered league");
  assert.ok(byId(account, "session-user"), "account controls remain usable after forgetting");
  FC.mountLeagueContext(null);
  assert.equal(connectMain.children.length, 1, "reinitializing does not duplicate the panel");
  // 9. A remembered league that stops loading (review fix): a definitive
  //    failure (wrong season, HTTP 404, a null league body) forgets it and,
  //    when it came from memory, reopens the page league-free with a note; a
  //    timeout or a 5xx keeps it, since a retry may succeed.
  {
    const KEY = "megatron:lastLeague", NOTE = "megatron:forgotLeague";
    const ss = new Map();
    global.sessionStorage = { getItem: k => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => { ss.set(k, String(v)); }, removeItem: k => { ss.delete(k); } };
    const cases = [
      ["wrong season", "100000000000000021", () => { routes["/league/100000000000000021"] = { league_id: "100000000000000021", name: "League D", season: "2025", status: "complete" }; }, true],
      ["HTTP 404", "100000000000000022", () => { failures["/league/100000000000000022"] = "HTTP 404"; }, true],
      ["null league body", "100000000000000023", () => { routes["/league/100000000000000023"] = null; }, true],
      ["timeout", "100000000000000024", () => { failures["/league/100000000000000024"] = "timeout"; }, false],
      ["HTTP 503", "100000000000000025", () => { failures["/league/100000000000000025"] = "HTTP 503"; }, false],
    ];
    for (const [name, id, arrange, forgets] of cases) {
      arrange();
      for (const suffix of ["users", "rosters"]) routes[`/league/${id}/${suffix}`] = routes[`/league/${id}/${suffix}`] || [];
      FC.setLeague(null);
      Session._storage(store);
      m.clear(); ss.clear(); m.set(KEY, id);
      dom("https://example.test/Megatron/weekly.html");
      const replaced = [];
      global.location.replace = u => { replaced.push(String(u)); };
      assert.deepEqual(FC.inSeasonLeague(), { leagueId: id }, `${name}: opened from memory`);
      FC.setLeague(id);
      if (forgets) {
        await until(() => !m.has(KEY), `${name}: the remembered league to be forgotten`);
        assert.deepEqual(replaced, ["https://example.test/Megatron/weekly.html"], `${name}: reopened league-free`);
        assert.equal(ss.get(NOTE), "1", `${name}: the note is queued`);
      } else {
        await until(() => Session.error(), `${name}: the load to fail`);
        await pause(20);
        assert.equal(m.get(KEY), id, `${name}: a transient failure keeps the remembered league`);
        assert.deepEqual(replaced, [], `${name}: no reload`);
        assert.equal(ss.has(NOTE), false);
      }
    }
    // An id from the URL that fails is not reopened (the visitor sees its error), but a matching remembered id is dropped.
    FC.setLeague(null); Session._storage(store);
    const U = "100000000000000022";
    m.clear(); ss.clear(); m.set(KEY, U);
    dom(`https://example.test/Megatron/weekly.html?league=${U}`);
    const rep2 = []; global.location.replace = u => { rep2.push(String(u)); };
    FC.inSeasonLeague(); FC.setLeague(U);
    await until(() => !m.has(KEY), "a URL-opened remembered id that 404s to be forgotten");
    assert.deepEqual(rep2, [], "a league opened by a link is not reopened without it");
    // The next league-free page shows the one-line note once, then not again.
    ss.set(NOTE, "1"); m.clear();
    const nm = dom("https://example.test/Megatron/weekly.html");
    FC.leagueNavigation();
    assert.ok(all(nm).some(n => n.textContent === "The league this browser remembered is no longer available. Connect your Sleeper league to continue."), "the note is shown");
    assert.equal(ss.has(NOTE), false, "the note is one-shot");
    FC.setLeague(null);
    delete global.sessionStorage;
  }

  console.log("chip_session_fixture: real chip + real Session (mount, identify, tick, change, forget; by-id viewer then owner) OK");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
