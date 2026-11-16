// tests/league_bar_fixture.cjs — run with: node tests/league_bar_fixture.cjs
//
// The league bar (league connect flow spec §5.1-5.3, §5.6): the REAL panel and
// chip (app.js) against the REAL Session (session.js), one check per brief
// case B1-B15. Sleeper is an injected `get` (also window.Sleeper.get, which the
// league picker reads); storage is a Map; the DOM is a small fake with
// `hidden`, `href` and a `location.assign` recorder. Every id, league name,
// team name and username is synthetic.
const assert = require("node:assert/strict");
global.window = {};
require("../site/assets/app.js");
const FC = window.FC;
const Session = require("../site/assets/session.js");   // installs window.Session, which the chip reads
assert.equal(window.Session, Session);

// ---- fake DOM (chip_session_fixture's, plus hidden / href / assign) ----------
function element(tagName) {
  return {
    tagName, children: [], listeners: {}, textContent: "", className: "", id: "", value: "", href: "", hidden: false, attrs: {},
    append(...nodes) { this.children.push(...nodes); },
    prepend(...nodes) { this.children.unshift(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    focus() { global.document.activeElement = this; },
    contains(node) { return all(this).includes(node); },
    dispatch(type) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {} }); },
  };
}
const all = node => [node, ...node.children.flatMap(all)];
const byId = (root, id) => all(root).find(n => n.id === id) || null;
const textOf = node => node.textContent + node.children.filter(n => n.tagName !== "input" && n.tagName !== "select").map(textOf).join("");
let assigned = [];
function dom(href) {
  const main = element("main");
  global.location = new URL(href);
  assigned = [];
  global.location.assign = url => { assigned.push(String(url)); };
  global.document = {
    activeElement: null,
    createElement: element,
    querySelector(selector) { return selector === "main" ? main : null; },
    querySelectorAll() { return []; },
    getElementById(id) { return byId(main, id); },
  };
  return main;
}

// ---- fake Sleeper + storage ---------------------------------------------------
const X = "700000000000000001", Y = "700000000000000002", L = "100000000000000001";
const leagueX = { league_id: X, name: "Synthetic Six", season: "2026", status: "in_season", total_rosters: 12,
  scoring_settings: { rec: 1 }, settings: { waiver_type: 2 }, roster_positions: ["QB", "RB", "WR", "TE", "FLEX", "BN"] };
const leagueY = { league_id: Y, name: "Synthetic Ten", season: "2026", status: "in_season", total_rosters: 10,
  scoring_settings: { rec: 0.5 }, settings: { waiver_type: 0 }, roster_positions: ["QB", "SUPER_FLEX", "RB", "WR", "BN"] };
// League X's users and rosters: session_fixture's id-path block.
const usersX = [
  { user_id: "s1", display_name: "Alpha", metadata: { team_name: "Alpha Squad" } },
  { user_id: "s2", display_name: "Beta" },
  { user_id: "s3", display_name: "Gamma", metadata: { team_name: "Gamma Rays" } },
];
const rostersX = [
  { roster_id: 1, owner_id: "s1", co_owners: null, players: ["p1"] },
  { roster_id: 2, owner_id: "s2", co_owners: null, players: ["p2"] },
  { roster_id: 3, owner_id: "s3", co_owners: null, players: ["p3"] },
];
const usersY = [{ user_id: "s1", display_name: "Alpha", metadata: { team_name: "Alpha Tenners" } }, { user_id: "s5", display_name: "Echo" }];
const rostersY = [{ roster_id: 1, owner_id: "s1", players: ["p4"] }, { roster_id: 2, owner_id: "s5", players: ["p5"] }];
const state = { season: "2026", season_type: "regular", week: 10 };
const baseRoutes = () => ({
  "/state/nfl": state,
  "/user/user_a": { user_id: "ua", username: "user_a", display_name: "User A" },
  "/user/solo": { user_id: "so", username: "solo", display_name: "Solo" },
  "/user/alpha": { user_id: "s1", username: "alpha", display_name: "Alpha" },
  "/user/gamma": { user_id: "s3", username: "gamma", display_name: "Gamma" },
  "/user/outsider": { user_id: "s9", username: "outsider", display_name: "Outsider" },
  "/user/ua/leagues/nfl/2026": [leagueX, leagueY],
  "/user/so/leagues/nfl/2026": [leagueX],
  "/user/s1/leagues/nfl/2026": [leagueX],
  "/user/s3/leagues/nfl/2026": [leagueX],
  "/user/s9/leagues/nfl/2026": [],
  [`/league/${X}`]: leagueX, [`/league/${X}/users`]: usersX, [`/league/${X}/rosters`]: rostersX,
  [`/league/${Y}`]: leagueY, [`/league/${Y}/users`]: usersY, [`/league/${Y}/rosters`]: rostersY,
});
let routes = baseRoutes();
const failures = {};   // path -> message: Sleeper answers with an error
const gates = {};      // path -> promise: the answer waits for it
const calls = [];
function get(path) {
  calls.push(path);
  const answer = () => {
    if (failures[path]) return Promise.reject(new Error(failures[path]));
    const hit = routes[path];
    return hit === undefined ? Promise.reject(new Error(`unrouted ${path}`)) : Promise.resolve(JSON.parse(JSON.stringify(hit)));
  };
  return gates[path] ? gates[path].then(answer) : answer();
}
Session._get(get);
window.Sleeper = { get };
const m = new Map();
const store = {
  getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
  removeItem: k => { m.delete(k); }, key: i => [...m.keys()][i] ?? null, get length() { return m.size; },
};
global.localStorage = store;
const IDENTITY_KEY = "megatron:session:identity";
const base = "https://example.test/Megatron/";

const pause = ms => new Promise(r => setTimeout(r, ms));
const until = async (pred, what, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await pause(5);
  }
};
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

// A fresh document: no league on the chip, storage seeded, Session cold, the
// page's own leagueNavigation (the panel mounts there). In-season pages then
// call FC.setLeague themselves, as weekly.html does.
async function page(href, identity) {
  FC.setLeague(null); FC.setBoard(null);
  await pause(10);                                     // let the previous page's work settle
  m.clear();
  if (identity) m.set(IDENTITY_KEY, JSON.stringify(identity));
  Session._storage(store);
  routes = baseRoutes();
  for (const k of Object.keys(failures)) delete failures[k];
  for (const k of Object.keys(gates)) delete gates[k];
  const main = dom(href);
  calls.length = 0;
  FC.leagueNavigation();
  return { main, panel: byId(main, "league-context") };
}
const line = panel => byId(panel, "session-text").textContent;
const status = panel => byId(panel, "session-status").textContent;
const active = () => global.document.activeElement;
const notice = panel => (all(panel).find(n => n.className === "session-notice") || { textContent: "" }).textContent;
const controls = panel => all(panel).find(n => n.className === "session-controls");
const form = panel => all(panel).find(n => n.tagName === "form") || null;
const leagueSelect = panel => all(panel).find(n => n.tagName === "select" && n.attrs["aria-label"] === "Selected league");
const selectLabel = panel => all(panel).find(n => n.tagName === "label" && n.children.includes(leagueSelect(panel)));
const rows = panel => all(byId(panel, "session-leagues") || element("x")).filter(n => n.tagName === "li");
const rowParts = li => {
  const a = li.children.find(n => n.tagName === "a"), f = li.children.find(n => n.className === "league-format");
  return [a.href, a.textContent, f.textContent];
};
function submit(panel, text) {
  byId(panel, "session-user").value = text;
  form(panel).dispatch("submit");
}
// B14: checked after every case (and in the states between).
let inputChecks = 0;
const casesChecked = new Set();
function oneInput(panel, name) {
  const inputs = all(panel).filter(n => n.tagName === "input");
  assert.ok(inputs.length <= 1, `${name}: the panel holds ${inputs.length} inputs`);
  inputChecks++; casesChecked.add(name);
}
let n = 0;
async function check(name, fn) {
  try { await fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
}

(async () => {
  await check("B1 weekly.html, no league, no account: the connect box", async () => {
    const { main, panel } = await page(`${base}weekly.html`);
    await pause(10);
    assert.equal(byId(panel, "session-heading").textContent, "Connect your Sleeper league");
    assert.equal(byId(panel, "session-heading").tagName, "p", "not a heading element: it must not precede the page's h1");
    assert.equal(panel.attrs["aria-labelledby"], "session-heading", "the panel is named by it while it shows");
    const live = byId(panel, "session-status");
    assert.equal(live.tagName, "p");
    assert.equal(live.attrs.role, "status");
    assert.equal(live.attrs["aria-live"], "polite");
    assert.match(live.className, /visually-hidden/);
    assert.equal(all(panel).filter(x => x.attrs && x.attrs["aria-live"]).length, 1, "one live region, never on #session-text");
    assert.equal(byId(panel, "session-text").attrs.tabindex, "-1");
    assert.equal(textOf(all(form(panel)).find(x => x.tagName === "label")).trim(), "Sleeper username or league link");
    const input = byId(panel, "session-user");
    assert.equal(input.placeholder, "Sleeper username or league link");
    assert.equal(input.autocomplete, "off");
    assert.equal(input.attrs.spellcheck, "false");
    assert.equal(byId(panel, "session-use").textContent, "Connect");
    assert.equal(byId(panel, "session-note").textContent, "No password. Read-only: nothing is changed in Sleeper. A username you enter is remembered on this device.");
    assert.deepEqual(controls(panel).children.map(x => x.id || x.tagName), ["session-heading", "form", "session-note"], "heading, form, note in that order");
    assert.equal(line(panel), "");
    assert.equal(byId(main, "session-settings"), null);
    assert.ok(!all(main).some(x => x.textContent === "Find my Sleeper leagues"));
    assert.equal(selectLabel(panel).hidden, true, "no league control");
    assert.equal(byId(panel, "league-name").hidden, true);
    assert.deepEqual(calls, [], "no Sleeper call");
    oneInput(panel, "B1");
  });

  await check("B2 the box: a league link navigates, link-shaped text is refused, empty asks", async () => {
    const { panel } = await page(`${base}weekly.html`);
    submit(panel, ` https://sleeper.com/leagues/${X}/x `);
    assert.deepEqual(assigned, [`${base}weekly.html?league=${X}`]);
    const about = await page(`${base}about.html`);
    submit(about.panel, ` https://sleeper.com/leagues/${X}/x `);
    assert.deepEqual(assigned, [`${base}weekly.html?league=${X}`], "a page that is not an in-season tool opens Weekly");
    oneInput(about.panel, "B2");
    const w = await page(`${base}weekly.html`);
    const input = byId(w.panel, "session-user");
    submit(w.panel, "evil.example/leagues/1");
    assert.equal(notice(w.panel), "Enter a Sleeper league id or a sleeper.com league link.");
    assert.equal(status(w.panel), "Enter a Sleeper league id or a sleeper.com league link.", "a refusal is announced");
    assert.equal(byId(w.panel, "session-user"), input, "the refusal keeps the input (and what was typed)");
    assert.equal(input.value, "evil.example/leagues/1");
    submit(w.panel, "");
    assert.equal(notice(w.panel), "Enter your Sleeper username or paste a sleeper.com league link.");
    assert.equal(status(w.panel), "Enter your Sleeper username or paste a sleeper.com league link.");
    await pause(10);
    assert.deepEqual(assigned, []);
    assert.deepEqual(calls, [], "no Sleeper call");
    oneInput(w.panel, "B2");
  });

  await check("B3 a username with two leagues lists them, opens none", async () => {
    const { panel } = await page(`${base}weekly.html`);
    const held = deferred();
    gates["/user/ua/leagues/nfl/2026"] = held.promise;
    submit(panel, "user_a");
    assert.equal(status(panel), "Looking up Sleeper account…", "the lookup is announced");
    await until(() => byId(panel, "session-leagues"), "the account's leagues box");
    assert.equal(line(panel), "Sleeper account: User A");
    assert.equal(status(panel), "Sleeper account: User A Finding your leagues…");
    assert.equal(textOf(byId(panel, "session-leagues")), "Finding your leagues…");
    assert.equal(byId(panel, "session-change").textContent, "Not you?");
    oneInput(panel, "B3");
    held.resolve();
    await until(() => rows(panel).length === 2, "two league rows");
    assert.ok(all(byId(panel, "session-leagues")).some(x => x.textContent === "Your 2026 leagues"));
    assert.equal(status(panel), "Sleeper account: User A Your 2026 leagues: 2 found.", "the result is announced");
    assert.deepEqual(rows(panel).map(rowParts), [
      [`${base}weekly.html?league=${X}`, "Synthetic Six", "12 teams · PPR · FAAB"],
      [`${base}weekly.html?league=${Y}`, "Synthetic Ten", "10 teams · Half-PPR · Superflex · Rolling waivers"],
    ]);
    await pause(10);
    assert.deepEqual(assigned, []);
    assert.deepEqual(calls.slice().sort(), ["/state/nfl", "/user/ua/leagues/nfl/2026", "/user/user_a"], "each requested once, nothing else");
    oneInput(panel, "B3");
  });

  await check("B4 a username with exactly one league opens it, once", async () => {
    const { panel } = await page(`${base}weekly.html`);
    submit(panel, "solo");
    await until(() => assigned.length > 0, "the only league to open");
    await pause(20);
    FC.chip.render();
    assert.deepEqual(assigned, [`${base}weekly.html?league=${X}`]);
    oneInput(panel, "B4");
  });

  await check("B5 a remembered account on page load lists its one league and opens nothing", async () => {
    const { panel } = await page(`${base}weekly.html`, { username: "solo", userId: "so", displayName: "Solo" });
    await until(() => rows(panel).length === 1, "the one league row");
    assert.equal(line(panel), "Sleeper account: Solo");
    assert.deepEqual(rows(panel).map(rowParts), [[`${base}weekly.html?league=${X}`, "Synthetic Six", "12 teams · PPR · FAAB"]]);
    await pause(20);
    assert.deepEqual(assigned, [], "a page load never opens a league by itself");
    assert.deepEqual(calls.slice().sort(), ["/state/nfl", "/user/so/leagues/nfl/2026"], "the leagues lookup and the season it needs, nothing else");
    oneInput(panel, "B5");
  });

  await check("B6 zero leagues: the sentence and the box", async () => {
    const { panel } = await page(`${base}weekly.html`);
    routes["/user/ua/leagues/nfl/2026"] = [];
    submit(panel, "user_a");
    await until(() => byId(panel, "session-leagues") && /^No /.test(textOf(byId(panel, "session-leagues"))), "the zero-leagues sentence");
    assert.equal(textOf(byId(panel, "session-leagues")), "No 2026 Sleeper leagues for User A. Paste a league link instead.");
    assert.ok(form(panel) && byId(panel, "session-user"), "the box is there");
    assert.equal(byId(panel, "session-user").value, "");
    assert.equal(status(panel), "Sleeper account: User A No 2026 Sleeper leagues for User A. Paste a league link instead.");
    assert.equal(byId(panel, "session-forget").textContent, "Forget me on this device");
    assert.equal(byId(panel, "session-change"), null, "the box is already showing");
    await pause(10);
    assert.deepEqual(assigned, []);
    oneInput(panel, "B6");
  });

  await check("B7 a failed league lookup offers Retry, which looks up once more", async () => {
    const { panel } = await page(`${base}weekly.html`);
    failures["/user/ua/leagues/nfl/2026"] = "HTTP 503";
    submit(panel, "user_a");
    await until(() => byId(panel, "session-leagues-retry"), "the leagues Retry");
    assert.match(textOf(byId(panel, "session-leagues")), /HTTP 503/);
    assert.match(status(panel), /^Sleeper account: User A Unable to load your leagues: .*HTTP 503/, "the lookup error is announced");
    assert.equal(byId(panel, "session-leagues-retry").textContent, "Retry");
    const before = calls.filter(c => c === "/user/ua/leagues/nfl/2026").length;
    assert.equal(before, 1);
    delete failures["/user/ua/leagues/nfl/2026"];
    byId(panel, "session-leagues-retry").dispatch("click");
    await until(() => rows(panel).length === 2, "the rows after Retry");
    assert.equal(calls.filter(c => c === "/user/ua/leagues/nfl/2026").length, 2, "one more leagues request");
    await pause(10);
    assert.deepEqual(assigned, [], "a failed lookup cleared the one-shot open");
    oneInput(panel, "B7");
  });

  // B8 and B9 share one page: weekly.html?league=X, anonymous.
  let viewer = null;
  await check("B8 a league open by link, no account: choose a team to view", async () => {
    viewer = await page(`${base}weekly.html?league=${X}`);
    const { panel } = viewer;
    FC.setLeague(X);
    await until(() => Session.state() === "ready" && line(panel) === "Which team do you want to see?", "the anonymous league line");
    assert.equal(byId(panel, "league-name").textContent, "Synthetic Six");
    assert.equal(byId(panel, "league-name").hidden, false);
    assert.equal(selectLabel(panel).hidden, true, "no visible league select");
    const team = byId(panel, "session-team");
    assert.deepEqual(team.children.map(o => o.textContent), ["Choose a team", "Alpha Squad", "Beta", "Gamma Rays"]);
    assert.equal(textOf(all(panel).find(x => x.tagName === "label" && x.children.includes(team))).trim(), "Team");
    assert.match(all(panel).find(x => x.tagName === "label" && x.children.includes(team)).children[0].className, /visually-hidden/, "no team chosen: the Viewing label stays hidden");
    assert.equal(byId(panel, "session-find").textContent, "or find your team with your username");
    assert.equal(byId(panel, "session-refresh"), null);
    assert.equal(byId(panel, "session-user"), null, "the box hides behind the find button");
    oneInput(panel, "B8");
    const outside = element("input"); outside.focus();   // the visitor is working elsewhere on the page
    const statusBefore = status(panel);
    team.value = "3"; team.dispatch("change");
    assert.equal(active(), outside, "a rebuild while focus is outside the bar never moves it");
    assert.match(line(panel), /^rosters \d+ s ago$/, "the line drops the team name: the select shows it");
    assert.ok(!line(panel).includes("Gamma Rays"), "no team name in the line");
    const viewLabel = all(panel).find(x => x.tagName === "label" && x.children.includes(byId(panel, "session-team")));
    const viewCap = viewLabel.children[0];
    assert.equal(textOf(viewCap).trim(), "Viewing", "the select's label reads Viewing");
    assert.ok(!/visually-hidden/.test(viewCap.className || ""), "the Viewing label is visible");
    assert.equal(byId(panel, "session-find").textContent, "Use my username");
    assert.ok(byId(panel, "session-refresh"));
    assert.equal(byId(panel, "session-team").value, "3");
    assert.ok(!/your team/i.test(textOf(panel)), "a viewer is never 'your team'");
    assert.notEqual(status(panel), statusBefore, "the state change is announced");
    assert.match(status(panel), /^Viewing Gamma Rays · rosters \d+ s ago$/, "the live region still announces the team");
    const ticked = status(panel), lineThen = line(panel);
    await pause(2300);
    assert.notEqual(line(panel), lineThen, "the ticker moved the line");
    assert.equal(status(panel), ticked, "the ticker never writes the live region");
    oneInput(panel, "B8");
  });

  await check("B9 the find button reveals the box in place; Cancel puts the line back", async () => {
    const { panel } = viewer;
    const lineBefore = line(panel);
    byId(panel, "session-find").focus();
    byId(panel, "session-find").dispatch("click");
    assert.ok(byId(panel, "session-user"));
    assert.equal(active(), byId(panel, "session-user"), "the removed button's focus moves to the box");
    assert.equal(byId(panel, "session-user").value, "");
    assert.equal(byId(panel, "session-team"), null, "one input: the team select hides");
    assert.equal(byId(panel, "session-cancel").textContent, "Cancel");
    assert.equal(byId(panel, "session-forget"), null, "nothing to forget without an account");
    assert.equal(line(panel).replace(/\d+ s ago/, ""), "Viewing Gamma Rays · rosters ", "the select is hidden, so the line names the team again");
    oneInput(panel, "B9");
    byId(panel, "session-cancel").focus();
    byId(panel, "session-cancel").dispatch("click");
    assert.equal(byId(panel, "session-user"), null);
    assert.equal(active(), byId(panel, "session-team"), "Cancel's focus moves to the first control");
    assert.equal(byId(panel, "session-team").value, "3");
    assert.equal(line(panel).replace(/\d+ s ago/, ""), lineBefore.replace(/\d+ s ago/, ""), "Cancel puts the line back");
    assert.ok(byId(panel, "session-refresh"));
    assert.equal(byId(panel, "session-find").textContent, "Use my username");
    oneInput(panel, "B9");
  });

  await check("B10 the owner's compact line: Refresh and Not you?", async () => {
    const { panel } = await page(`${base}weekly.html?league=${X}`, { username: "alpha", userId: "s1", displayName: "Alpha" });
    FC.setLeague(X);
    await until(() => Session.state() === "ready" && Session.bundle().myRoster, "the owner's league");
    assert.match(line(panel), /^Your team: Alpha Squad · rosters \d+ s ago$/);
    assert.deepEqual(controls(panel).children.map(x => x.id), ["session-refresh", "session-change"]);
    assert.equal(byId(panel, "session-refresh").textContent, "Refresh");
    assert.equal(byId(panel, "session-change").textContent, "Not you?");
    assert.equal(selectLabel(panel).hidden, false, "an account gets the League select");
    assert.equal(byId(panel, "league-name").hidden, true);
    oneInput(panel, "B10");
    byId(panel, "session-change").dispatch("click");
    assert.ok(form(panel) && byId(panel, "session-user"));
    assert.equal(byId(panel, "session-user").value, "", "the revealed box is empty");
    assert.equal(byId(panel, "session-cancel").textContent, "Cancel");
    assert.equal(byId(panel, "session-forget").textContent, "Forget me on this device");
    assert.match(line(panel), /^Your team: Alpha Squad · rosters \d+ s ago$/, "the line is unchanged");
    oneInput(panel, "B10");
  });

  await check("B11 an account with no team here, or with two", async () => {
    const none = await page(`${base}weekly.html?league=${X}`, { username: "outsider", userId: "s9", displayName: "Outsider" });
    FC.setLeague(X);
    await until(() => Session.state() === "ready" && line(none.panel) !== "Loading league…", "the league for a non-member");
    assert.equal(line(none.panel), "You have no team here.");
    assert.deepEqual(controls(none.panel).children.map(x => x.id || x.tagName), ["label", "session-refresh", "session-change"]);
    assert.ok(byId(none.panel, "session-team"));
    assert.equal(byId(none.panel, "session-change").textContent, "Not you?");
    oneInput(none.panel, "B11");
    const team = byId(none.panel, "session-team");
    team.value = "2"; team.dispatch("change");
    assert.match(line(none.panel), /^You have no team here · rosters \d+ s ago$/);
    assert.match(status(none.panel), /^You have no team here\. Viewing .+ · rosters \d+ s ago$/, "the live region names the team");
    oneInput(none.panel, "B11");
    const two = await page(`${base}weekly.html?league=${X}`, { username: "outsider", userId: "s9", displayName: "Outsider" });
    routes[`/league/${X}/rosters`] = rostersX.map(r => (r.roster_id === 1 ? r : { ...r, co_owners: ["s9"] }));
    FC.setLeague(X);
    await until(() => Session.state() === "ready" && line(two.panel) !== "Loading league…", "the league for a two-team account");
    assert.equal(Session.bundle().myRosterStatus, "ambiguous");
    assert.equal(line(two.panel), "This account is on more than one team here.");
    assert.ok(byId(two.panel, "session-team") && byId(two.panel, "session-refresh") && byId(two.panel, "session-change"));
    oneInput(two.panel, "B11");
  });

  await check("B12 a username submitted with a league open keeps the league", async () => {
    const { panel } = await page(`${base}weekly.html?league=${X}`);
    FC.setLeague(X);
    await until(() => Session.state() === "ready" && byId(panel, "session-find"), "the anonymous league");
    byId(panel, "session-find").dispatch("click");
    submit(panel, "gamma");
    await until(() => Session.state() === "ready" && Session.bundle().myRoster, "the roster re-derived for the account");
    await pause(20);
    assert.deepEqual(assigned, [], "a username never navigates");
    assert.equal(Session.bundle().league.league_id, X);
    assert.equal(calls.filter(c => c === `/league/${X}`).length, 1, "no second league load");
    assert.match(line(panel), /^Your team: Gamma Rays · rosters \d+ s ago$/);
    oneInput(panel, "B12");
  });

  await check("B13 the board page keeps the registry path: username only", async () => {
    FC.setLeague(null); FC.setBoard(null);
    await pause(10);
    m.clear(); Session._storage(store); routes = baseRoutes();
    const main = dom(`${base}index.html`);
    calls.length = 0;
    const board = { season: 2026, league: { slug: "leaguea", platform: "sleeper", league_id: L, teams: 12, sleeper_scoring: { rec: 1, pass_td: 6 } } };
    assert.equal(FC.leagueNavigation(), null);
    FC.setBoard(board);
    FC.mountLeagueContext(board.league.slug);
    const panel = byId(main, "league-context");
    await pause(10);
    assert.equal(textOf(all(form(panel)).find(x => x.tagName === "label")).trim(), "Sleeper username");
    assert.equal(byId(panel, "session-user").placeholder, "Sleeper username");
    assert.equal(byId(panel, "session-use").textContent, "Connect");
    assert.equal(line(panel), "Remembered on this device; use “Not you?” to forget it.");
    assert.equal(byId(panel, "session-heading"), null);
    assert.equal(byId(panel, "session-leagues"), null);
    assert.equal(byId(panel, "session-team"), null);
    assert.equal(byId(panel, "league-name").textContent, "12-team PPR, 6-pt pass TD", "the board's league as text");
    assert.ok(panel.children.some(x => x.tagName === "p" && /^This draft board's league\./.test(x.textContent)), "the board's note stays");
    submit(panel, "sleeper.com/leagues/123");
    assert.equal(notice(panel), "Enter your Sleeper username.");
    submit(panel, "");
    assert.equal(notice(panel), "Enter your Sleeper username.");
    await pause(10);
    assert.deepEqual(calls, [], "no Sleeper call");
    assert.deepEqual(assigned, []);
    oneInput(panel, "B13");
    FC.setBoard(null);
    FC._registry([]);
  });

  await check("B15 an owner on a shared link's league: the open league first, then the account's", async () => {
    const { panel } = await page(`${base}weekly.html?league=${Y}`, { username: "alpha", userId: "s1", displayName: "Alpha" });
    FC.setLeague(Y);
    await until(() => Session.state() === "ready" && leagueSelect(panel).children.length === 2, "the League select");
    assert.deepEqual(leagueSelect(panel).children.map(o => [o.value, o.textContent]), [[Y, "Synthetic Ten"], [X, "Synthetic Six"]]);
    assert.equal(leagueSelect(panel).value, Y);
    assert.match(line(panel), /^Your team: Alpha Tenners · rosters \d+ s ago$/);
    oneInput(panel, "B15");
  });

  await check("B16 first visit, unknown username: the failure line, the box holds the name, no Retry", async () => {
    const { panel } = await page(`${base}weekly.html`);
    routes["/user/nobody"] = {};
    byId(panel, "session-user").focus();
    submit(panel, "nobody");
    assert.equal(active(), byId(panel, "session-text"), "the focused box was removed while identifying: focus lands on the line, not <body>");
    await until(() => line(panel) === "Sleeper username was not found.", "the not-found line");
    assert.equal(byId(panel, "session-user").value, "nobody");
    assert.equal(byId(panel, "session-retry"), null);
    assert.equal(status(panel), "Sleeper username was not found.");
    oneInput(panel, "B16");
  });

  await check("B14 every case above: at most one input in the panel", () => {
    assert.deepEqual([...casesChecked].sort(), ["B1", "B10", "B11", "B12", "B13", "B15", "B16", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9"]);
    assert.ok(inputChecks >= 20, `only ${inputChecks} input checks ran`);
  });

  FC.setLeague(null);
  console.log(`league_bar_fixture: ${n} cases OK (B1-B15: connect box, link/username paths, your-leagues list, compact connected line, registry path, one input)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
