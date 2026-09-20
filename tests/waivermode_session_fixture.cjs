// tests/waivermode_session_fixture.cjs — run with: node tests/waivermode_session_fixture.cjs
//
// The REAL waiver-desk controller (WaiverMode.init) driven through the REAL
// Session and the REAL identity chip (app.js) under a fake DOM -- the seam
// waivermode_fixture (pure functions: loadWorld/validateContract/rowText)
// never crosses. Sleeper is an injected `get`; static JSON comes from a fetch
// stub; the waiver ENGINE (Waivers/WaiverIntel.analyze) is a recording stub
// so the desk's Session contract is pinned without a projection run:
//   anonymous -> identifying -> loading -> found (results up);
//   an identity change clears the account-derived output SYNCHRONOUSLY;
//   a failed refresh keeps the old snapshot and BOTH roster timestamps;
//   a successful refresh adopts the new bundle (and its `also` transactions);
//   the engine's kickoff gate gets snapshotAt === bundle.rostersRequestedAt
//   while the 60 s UI expiry reads bundle.rostersFetchedAt.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// ---- fake DOM -----------------------------------------------------------------
const all = node => [node, ...node.children.flatMap(all)];
const matches = (n, sel) => sel === "input:checked" ? n.tagName === "input" && n.checked : n.tagName === sel;
function element(tagName) {
  const el = {
    tagName, children: [], listeners: {}, attrs: {}, parent: null,
    textContent: "", innerHTML: "", className: "", id: "", value: "", href: "", type: "",
    hidden: false, checked: false, disabled: false, open: false,
    append(...nodes) { for (const n of nodes) if (n && typeof n === "object") { n.parent = el; el.children.push(n); } },
    appendChild(n) { el.append(n); return n; },
    prepend(...nodes) { for (const n of nodes) n.parent = el; el.children.unshift(...nodes); },
    replaceChildren(...nodes) { el.children = []; el.append(...nodes); },
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    dispatch(type) { for (const fn of el.listeners[type] || []) fn({ preventDefault() {}, target: el }); },
    setAttribute(k, v) { el.attrs[k] = v; },
    focus() {},
    closest(tag) { let n = el; while (n && n.tagName !== tag) n = n.parent; return n || null; },
    querySelector(sel) { return all(el).slice(1).find(n => matches(n, sel)) || null; },
    querySelectorAll(sel) { return all(el).slice(1).filter(n => matches(n, sel)); },
  };
  return el;
}
function dom(href) {
  const main = element("main");
  global.location = new URL(href);
  global.document = {
    createElement: element, addEventListener() {}, hidden: false,
    querySelector(selector) { return selector === "main" ? main : null; },
    querySelectorAll() { return []; },
    getElementById(id) { return all(main).find(n => n.id === id) || null; },
  };
  return main;
}
// waivers.html's ids, in the shape init() reads them (a label around the
// reserve input for closest("label"); tbodies inside the two tables).
function waiversPage(main) {
  const withId = (tag, id, parent = main) => { const e = element(tag); e.id = id; parent.append(e); return e; };
  withId("div", "waiver-controls");
  withId("input", "waiver-week").value = "";
  const reserveLabel = element("label"); main.append(reserveLabel);
  withId("input", "waiver-reserve", reserveLabel).value = "20";
  withId("p", "waiver-status");
  withId("div", "waiver-warnings").hidden = true;
  const results = withId("section", "waiver-results"); results.hidden = true;
  for (const [tag, id] of [["div", "waiver-budget"], ["p", "waiver-coverage"], ["p", "waiver-ros"], ["p", "waiver-source"],
    ["div", "waiver-evaluation"], ["select", "waiver-position"], ["button", "waiver-export"], ["p", "waiver-count"],
    ["table", "waiver-table"], ["div", "waiver-roster"], ["p", "waiver-intel-source"], ["p", "waiver-role-source"],
    ["ul", "waiver-byes"], ["select", "waiver-radar-sort"], ["table", "waiver-radar"], ["p", "waiver-market"],
    ["ol", "waiver-watchlist"], ["textarea", "waiver-backup"]]) withId(tag, id, results);
  document.getElementById("waiver-position").value = "ALL";
  document.getElementById("waiver-radar-sort").value = "usage";
  for (const t of ["waiver-table", "waiver-radar"]) document.getElementById(t).append(element("tbody"));
  withId("a", "waiver-league-link");
}

// ---- modules ------------------------------------------------------------------
// Load order as waivers.html: session, app (FC), Sleeper, ros, waivermode.
// The engine is stubbed BEFORE init reads window.Waivers/WaiverIntel.
global.window = {};
const Session = require("../site/assets/session.js");
const FC = require("../site/assets/app.js");
assert.equal(window.Session, Session); assert.equal(window.FC, FC);
const calls = [];
let routes = {};
function get(p) {
  calls.push(p);
  const hit = routes[p];
  if (hit === undefined) return Promise.reject(new Error(`unrouted ${p}`));
  if (hit instanceof Error) return Promise.reject(hit);
  if (typeof hit === "function") return Promise.resolve().then(() => hit(p));
  return Promise.resolve(hit);
}
window.Sleeper = { get };               // WaiverMode.loadWorld/loadSignals default getter
Session._get(get);                      // Session.identify/ready/refresh/catalog
const WaiverMode = require("../site/assets/waivermode.js");
assert.equal(window.WaiverMode, WaiverMode);
const analyzeCalls = [];
const ENGINE_RESULT = () => ({
  rows: [], warnings: [], recommendationBlock: null,
  budget: { remaining: 100, reserve: 20, spendable: 80 },
  waiver: { type: "faab", guidance: "Bid ranges are budgeting heuristics." },
  coverage: { scoringLabel: "league scoring", weeklyFresh: false, projectedOwnedSkills: 0, activeOwnedSkills: 1,
              missingOwnedWeekly: [], unmappedOwnedIds: [], ros: {} },
});
window.Waivers = { analyze(args) { analyzeCalls.push(args); return ENGINE_RESULT(); } };
window.WaiverIntel = { analyze: () => ({ radar: [], fetchedAt: "t", rosStatus: "", warnings: [], roleStatus: "", byeRisks: [], bids: [], freeAgentMoves: 0 }) };

// ---- static JSON, Sleeper data, clock -------------------------------------------
const site = path.join(__dirname, "..", "site");
const draftBoard = JSON.parse(fs.readFileSync(path.join(site, "data", "draft.json"), "utf8"));
const L = String(draftBoard.league.league_id);
assert.equal(draftBoard.league.slug, "gabagool");
const statics = {
  "data/draft.json": draftBoard,
  "data/weekly.json": { league: { slug: "gabagool", league_id: L }, season: draftBoard.season, week: 3, generated_at: "2026-09-16T00:00:00Z", data_through: "2026-09-15", players: [] },
  "data/kickoffs.json": { season: draftBoard.season, week: 3, games: [] },
};
global.fetch = async p => statics[p] ? { ok: true, status: 200, json: async () => statics[p] } : { ok: false, status: 404, json: async () => ({}) };

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;                 // Session stamps the two roster timestamps with this
const ROSTERS_STEP = 5000;              // the rosters request "takes" 5 s: requestedAt and fetchedAt differ
const users = [{ user_id: "u1", display_name: "Max973" }, { user_id: "u2", display_name: "Bo" }];
const rosters = [
  { roster_id: 9, owner_id: "u1", players: ["a"], starters: ["a"], reserve: [], taxi: [], settings: { waiver_position: 4, waiver_budget_used: 0 } },
  { roster_id: 3, owner_id: "u2", players: ["b"], starters: ["b"], reserve: [], taxi: [], settings: { waiver_position: 1, waiver_budget_used: 0 } },
];
const league = { league_id: L, name: "Gabagool Fools", season: String(draftBoard.season), status: "in_season", total_rosters: draftBoard.league.teams,
  settings: { waiver_type: 2, waiver_budget: 100 }, scoring_settings: { ...draftBoard.league.sleeper_scoring },
  roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN"] };
const state = { season: String(draftBoard.season), season_type: "regular", week: 3 };
const catalog = { a: { position: "RB", full_name: "A Back", team: "X" }, b: { position: "WR", full_name: "B Wide", team: "Y" } };
function baseRoutes() {
  return {
    "/user/max973": { user_id: "u1", username: "max973", display_name: "Max973" },
    "/user/bo": { user_id: "u2", username: "bo", display_name: "Bo" },
    [`/league/${L}`]: league, [`/league/${L}/users`]: users,
    [`/league/${L}/rosters`]: () => { clock += ROSTERS_STEP; return rosters; },
    "/state/nfl": state, [`/league/${L}/transactions/3`]: [],
    "/players/nfl": catalog,
    "/players/nfl/trending/add?lookback_hours=24&limit=100": [], "/players/nfl/trending/drop?lookback_hours=24&limit=100": [],
  };
}
const m = new Map();
Session._storage({ getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
  removeItem: k => { m.delete(k); }, key: i => [...m.keys()][i] ?? null, get length() { return m.size; } });
const until = async (pred, what, ms = 3000) => {
  const t0 = realNow();
  while (!pred()) {
    if (realNow() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setImmediate(r));
  }
};
const GATE = "Enter your Sleeper username in the league panel above; the desk reads your roster from there.";
const transactionsCalls = () => calls.filter(p => p === `/league/${L}/transactions/3`).length;

(async () => {
  routes = baseRoutes();
  const main = dom("https://example.test/Megatron/waivers.html?league=gabagool");
  waiversPage(main);
  const $ = id => document.getElementById(id);
  const statusText = () => $("waiver-status").textContent;
  const chipForm = () => all($("session-chip")).find(n => n.tagName === "form");

  // 1. Anonymous mount: the chip mounts, statics load, the desk gates on the
  //    session with no Sleeper call and no results.
  WaiverMode.init();
  await until(() => statusText() === GATE, "the desk to gate on the anonymous session");
  assert.ok($("session-chip"), "the identity chip is mounted in #league-context by the controller's leagueNavigation()");
  assert.ok($("waiver-results").hidden);
  assert.deepEqual(calls, [], "anonymous: nothing is asked of Sleeper");
  assert.equal(Session.state(), "anonymous");
  // Registered AFTER init: the desk's own listener has run when this sees
  // each fire, so the trace pairs every session state with the desk's status.
  const trace = [];
  Session.onChange(snap => trace.push([snap.state, statusText(), $("waiver-results").hidden]));

  // 2. Identify through the chip's own form -> Session.identify -> the chip's
  //    ready() -> the desk loads. The identifying transient shows no results.
  let release;
  routes["/user/max973"] = () => new Promise(r => { release = () => r({ user_id: "u1", username: "max973", display_name: "Max973" }); });
  $("session-user").value = "max973";
  chipForm().dispatch("submit");
  assert.equal(Session.state(), "identifying");
  assert.ok($("waiver-results").hidden, "identifying: no results");
  await until(() => release, "the deferred user lookup to be issued");
  release();
  await until(() => !$("waiver-results").hidden, "the desk to render for the found roster", 5000);
  assert.deepEqual(trace.map(t => t[0]), ["identifying", "identified", "loadingLeague", "ready"], "identify cleared and resolved, the chip called ready(), the league committed");
  assert.deepEqual(trace.map(t => t[1]), [GATE, "Loading league…", "Loading league…", "Reading current rosters, waiver settings, scoring, and projections…"],
    "identifying gates; identified (no bundle yet) and loadingLeague read as loading; the commit starts the desk's load");
  assert.ok(trace.every(t => t[2] === true), "no results are shown before the desk's own load completes");
  trace.length = 0;
  const b1 = Session.bundle();
  assert.equal(b1.myRosterStatus, "found"); assert.equal(b1.myRoster.roster_id, 9);
  assert.match(statusText(), /^Connected read-only · roster 9 · rosters received /);
  assert.equal(analyzeCalls.length, 1, "one engine run per committed bundle");
  // The engine's kickoff gate is the PRE-request time; the two stamps differ.
  assert.equal(b1.rostersFetchedAt - b1.rostersRequestedAt, ROSTERS_STEP, "the fake rosters request took 5 s");
  assert.equal(analyzeCalls[0].snapshotAt, b1.rostersRequestedAt, "snapshotAt === bundle.rostersRequestedAt (kickoff gate)");
  assert.notEqual(analyzeCalls[0].snapshotAt, b1.rostersFetchedAt);
  assert.match($("waiver-source").textContent, new RegExp(`requested ${new Date(b1.rostersRequestedAt).toISOString()} \\(kickoff gate\\), received ${new Date(b1.rostersFetchedAt).toISOString()} \\(60 s expiry\\)`));
  assert.equal($("waiver-roster").children.length, 1, "my roster's one player is listed for protection");
  assert.equal(transactionsCalls(), 1, "the week's transactions were fetched once by loadWorld");

  // 3. Identity change: the moment the chip starts looking up another account
  //    (synchronous `identifying` fire), the account-derived output is gone.
  $("session-change").dispatch("click");
  let releaseBo;
  routes["/user/bo"] = () => new Promise(r => { releaseBo = () => r({ user_id: "u2", username: "bo", display_name: "Bo" }); });
  $("session-user").value = "bo";
  const before3 = calls.length;
  chipForm().dispatch("submit");
  assert.equal(Session.state(), "identifying");
  assert.ok($("waiver-results").hidden, "an identity change must hide the previous account's results synchronously");
  assert.equal(statusText(), GATE);
  await until(() => releaseBo, "the deferred lookup for bo");
  releaseBo();
  // identify/forget never refetch: the SAME league data is re-derived for u2
  // (a new bundle object), and the desk reloads for roster 3 from it.
  await until(() => !$("waiver-results").hidden && /roster 3/.test(statusText()), "the desk to render for the new account's roster", 5000);
  const b2 = Session.bundle();
  assert.notEqual(b2, b1); assert.equal(b2.myRoster.roster_id, 3);
  assert.equal(b2.rostersFetchedAt, b1.rostersFetchedAt, "no refetch on identity change: the timestamps carry over");
  assert.deepEqual(calls.slice(before3).filter(p => /^\/league\//.test(p) && !/transactions/.test(p)), [], "an identity change loads no league data");
  assert.equal(analyzeCalls.length, 2);
  assert.equal(analyzeCalls[1].snapshotAt, b2.rostersRequestedAt);
  // The protection checklist (inside the hidden #waiver-results section in
  // waivers.html) is rebuilt for the NEW roster, never left with the old one's.
  assert.equal($("waiver-roster").children.length, 1);
  assert.match(all($("waiver-roster")).map(n => n.textContent).join(" "), /B Wide/);
  assert.doesNotMatch(all($("waiver-roster")).map(n => n.textContent).join(" "), /A Back/);

  // 3b. forget: cleared synchronously too, back to the gate.
  $("session-forget").dispatch("click");
  assert.ok($("waiver-results").hidden, "forget hides the results synchronously");
  assert.equal(statusText(), GATE);
  assert.equal(Session.identity(), null);
  // ...and re-identifying as max973 brings roster 9 back without a league load.
  routes["/user/max973"] = baseRoutes()["/user/max973"];
  $("session-user").value = "max973";
  chipForm().dispatch("submit");
  await until(() => !$("waiver-results").hidden && /roster 9/.test(statusText()), "roster 9 back after re-identify", 5000);
  const b3 = Session.bundle();
  assert.equal(b3.rostersFetchedAt, b1.rostersFetchedAt);
  assert.equal(analyzeCalls.length, 3);

  // 4. A FAILED refresh (rosters 503): nothing commits. The desk keeps the
  //    previous snapshot and says so; both timestamps stay exactly as they
  //    were; the engine is not re-run; the chip carries the failure notice.
  routes[`/league/${L}/rosters`] = new Error("HTTP 503");
  const refreshBtn = $("session-refresh");
  assert.ok(refreshBtn, "ready: the chip offers refresh");
  refreshBtn.dispatch("click");
  assert.equal(Session.state(), "refreshing");
  assert.match(statusText(), /^Refreshing rosters and this week's transactions…$/);
  assert.ok(!$("waiver-results").hidden, "a refresh in flight keeps the results visible");
  await until(() => Session.state() === "ready", "the failed refresh to settle");
  assert.equal(Session.bundle(), b3, "a failed refresh must leave the committed bundle object untouched");
  assert.equal(Session.bundle().rostersRequestedAt, b1.rostersRequestedAt);
  assert.equal(Session.bundle().rostersFetchedAt, b1.rostersFetchedAt);
  assert.match(statusText(), /^Refresh did not complete; see the league panel for the reason\. The roster snapshot received .* is still shown\.$/);
  assert.ok(!$("waiver-results").hidden, "the previous snapshot stays on screen");
  assert.equal(analyzeCalls.length, 3, "nothing committed: the engine did not re-run");
  assert.ok(all($("session-chip")).some(n => n.className === "session-notice" && /Refresh failed: HTTP 503/.test(n.textContent)), "the chip names the failure");
  // 4b. The `also` hook failing (transactions 502) is the same contract:
  //     rosters were fetched but NOTHING commits, and the desk names the reason.
  routes[`/league/${L}/rosters`] = baseRoutes()[`/league/${L}/rosters`];
  routes[`/league/${L}/transactions/3`] = new Error("HTTP 502");
  $("session-refresh").dispatch("click");
  await until(() => Session.state() === "ready" && /did not complete/.test(statusText()), "the also-failure to settle");
  assert.equal(Session.bundle(), b3, "a failed `also` must commit nothing");
  assert.equal(Session.bundle().rostersFetchedAt, b1.rostersFetchedAt, "rostersFetchedAt must not move when the transactions fetch fails");
  assert.match(statusText(), /^Refresh did not complete \(HTTP 502\)\. The roster snapshot received .* is still shown\.$/);
  assert.equal(analyzeCalls.length, 3);

  // 5. A SUCCESSFUL refresh adopts the new bundle: new timestamps, the engine
  //    re-runs with the NEW pre-request time, and the transactions fetched by
  //    the `also` hook ride on bundle.extra so loadWorld does not fetch again.
  routes[`/league/${L}/transactions/3`] = [{ type: "waiver", status: "complete" }];
  const tx5 = transactionsCalls(), an5 = analyzeCalls.length;
  clock += 10000;
  $("session-refresh").dispatch("click");
  await until(() => Session.bundle() !== b3 && analyzeCalls.length === an5 + 1, "the refreshed bundle to be adopted", 5000);
  const b4 = Session.bundle();
  assert.ok(b4.rostersRequestedAt > b1.rostersRequestedAt && b4.rostersFetchedAt > b1.rostersFetchedAt, "new stamps");
  assert.equal(b4.rostersFetchedAt - b4.rostersRequestedAt, ROSTERS_STEP);
  assert.deepEqual(b4.extra, { week: 3, transactions: [{ type: "waiver", status: "complete" }] }, "the also hook's transactions ride on the bundle");
  assert.equal(transactionsCalls(), tx5 + 1, "one transactions fetch (the also hook); loadWorld reused bundle.extra");
  assert.equal(analyzeCalls[an5].snapshotAt, b4.rostersRequestedAt, "the engine gets the NEW pre-request time");
  assert.deepEqual(analyzeCalls[an5].transactions, b4.extra.transactions);
  assert.match(statusText(), new RegExp(`^Connected read-only · roster 9 · rosters received ${new Date(b4.rostersFetchedAt).toLocaleTimeString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  // 6. The 60 s UI expiry reads rostersFetchedAt, not rostersRequestedAt:
  //    59 s after the fetch (64 s after the request) is still fresh; 61 s is not.
  //    The reserve input's change handler is recompute(), the same path the
  //    15 s tick takes.
  clock = b4.rostersFetchedAt + 59000;
  $("waiver-reserve").dispatch("change");
  assert.ok(!$("waiver-results").hidden, "59 s after the FETCH the snapshot is still usable");
  assert.match(statusText(), /^Connected read-only · roster 9/);
  assert.equal(analyzeCalls.length, an5 + 2, "recompute re-ran the engine on the committed snapshot");
  assert.equal(analyzeCalls[an5 + 1].snapshotAt, b4.rostersRequestedAt, "recompute keeps the committed snapshotAt");
  clock = b4.rostersFetchedAt + 61000;
  $("waiver-reserve").dispatch("change");
  assert.equal(statusText(), "Roster snapshot expired. Refresh from the league panel before using waiver recommendations.");
  assert.ok($("waiver-results").hidden, "an expired snapshot hides the recommendations");
  assert.equal(analyzeCalls.length, an5 + 2, "expired: the engine is not run");

  Date.now = realNow;
  console.log("waivermode_session_fixture: real WaiverMode.init + real Session + real chip (gate, identify, identity change, failed/successful refresh, timestamps) OK");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
