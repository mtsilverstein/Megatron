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
const L = "1376245373244301312";   // gabagool's registry id
const user = { user_id: "u1", username: "max973", display_name: "Max973" };
const league = { league_id: L, name: "Gabagool Fools", season: "2026", status: "in_season" };
const users = [{ user_id: "u1", display_name: "Max973" }, { user_id: "u2", display_name: "Bo" }];
const rosters = [{ roster_id: 9, owner_id: "u1", players: ["a"] }, { roster_id: 3, owner_id: "u2", players: ["b"] }];
const state = { season: "2026", season_type: "regular", week: 3 };
const routes = {
  "/user/max973": user, [`/league/${L}`]: league, [`/league/${L}/users`]: users,
  [`/league/${L}/rosters`]: rosters, "/state/nfl": state,
};
const calls = [];
Session._get(path => {
  calls.push(path);
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
  const main = dom("https://example.test/Megatron/index.html?league=gabagool");
  FC._session(null);                                   // the chip must find window.Session itself
  FC.mountLeagueContext("gabagool");
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
  byId(panel, "session-user").value = " max973 ";
  all(panel).find(n => n.tagName === "form").dispatch("submit");
  assert.equal(Session.state(), "identifying");
  assert.equal(byId(panel, "session-text").textContent, "Looking up Sleeper account…", "identifying is rendered synchronously");
  await until(() => Session.state() === "ready", "the league to load after identify");
  assert.deepEqual(calls.slice().sort(), ["/user/max973", `/league/${L}`, `/league/${L}/users`, `/league/${L}/rosters`, "/state/nfl"].sort(),
    "identify + one league load, nothing else");
  const b1 = Session.bundle();
  assert.equal(b1.myRoster.roster_id, 9);
  assert.equal(JSON.parse(m.get(IDENTITY_KEY)).userId, "u1", "the identity is persisted");
  assert.match(byId(panel, "session-text").textContent, /^Max973 · Gabagool Fools · your roster: 9 · rosters 0 s ago$/);
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
  assert.ok(input && input.value === "max973", "change: input prefilled with the current username");
  assert.ok(byId(panel, "session-cancel"), "change from ready offers cancel");
  input.value = "newname-typed";
  FC.chip.render();
  assert.equal(byId(panel, "session-user"), input, "render must not rebuild the input");
  await realTick(panel);
  assert.equal(byId(panel, "session-user"), input, "a real tick must not rebuild the input");
  assert.equal(input.value, "newname-typed", "a real tick must not revert the typed name");
  assert.match(byId(panel, "session-text").textContent, /^Max973 · Gabagool Fools · your roster: 9 · rosters [2-6] s ago$/,
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
  anonInput.value = "max973";
  all(panel).find(n => n.tagName === "form").dispatch("submit");
  await until(() => Session.state() === "ready" && Session.bundle().myRoster, "re-identify to re-derive the seat");
  assert.deepEqual(calls.slice(callsBefore), ["/user/max973"], "re-identify looks the user up and loads nothing else");
  assert.equal(Session.bundle().rostersFetchedAt, b1.rostersFetchedAt);
  assert.match(byId(panel, "session-text").textContent, /^Max973 · Gabagool Fools · your roster: 9 · rosters [3-9] s ago$/);
  assert.ok(byId(panel, "session-refresh") && byId(panel, "session-forget") && !byId(panel, "session-user"));

  FC.setBoard(null);
  console.log("chip_session_fixture: real chip + real Session (mount, identify, tick, change, forget) OK");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
