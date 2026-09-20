// tests/startsitmode_session_fixture.cjs — run with: node tests/startsitmode_session_fixture.cjs
//
// The REAL start/sit controller (StartSitMode.init) driven through the REAL
// Session and the REAL identity chip (app.js) under a fake DOM, the way
// weekly.html wires it: StartSitMode.init() first, then FC.leagueNavigation()
// and FC.setBoard(weekly payload). startsit_fixture covers the ENGINE
// (StartSit.analyze); this one pins the controller's Session contract with
// the engine stubbed to record what it is handed:
//   anonymous -> identifying -> loading -> found (lineup rendered);
//   an identity change clears the lineup and the exclusion list SYNCHRONOUSLY;
//   a failed refresh keeps the old snapshot and BOTH roster timestamps;
//   a successful refresh adopts the new bundle;
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

// ---- modules ------------------------------------------------------------------
// weekly.html's load order: session, app (FC), Sleeper, ros, waivermode
// (loadWorld), startsit (engine, stubbed here), startsitmode. The controller
// reads FC/StartSit/WaiverMode/Session as bare globals.
global.window = {};
const Session = require("../site/assets/session.js");
const FC = require("../site/assets/app.js");
global.FC = FC;
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
window.Sleeper = { get };
Session._get(get);
global.WaiverMode = require("../site/assets/waivermode.js");
const analyzeCalls = [];
global.StartSit = window.StartSit = { analyze(args) { analyzeCalls.push(args); return { label: "Model lineup", warnings: ["w1"], lineup: [], bench: [] }; } };
require("../site/assets/startsitmode.js");
const StartSitMode = window.StartSitMode;
assert.equal(typeof StartSitMode.init, "function");

// ---- static JSON, Sleeper data, clock -------------------------------------------
const site = path.join(__dirname, "..", "site");
const draftBoard = JSON.parse(fs.readFileSync(path.join(site, "data", "draft.json"), "utf8"));
const L = String(draftBoard.league.league_id);
const weekly = { league: { slug: "gabagool", league_id: L, name: "Gabagool Fools" }, season: draftBoard.season, week: 3,
  generated_at: "2026-09-16T00:00:00Z", data_through: "2026-09-15", players: [] };
const statics = { "data/draft.json": draftBoard, "data/weekly.json": weekly, "data/kickoffs.json": { season: draftBoard.season, week: 3, games: [] } };
global.fetch = async p => statics[p] ? { ok: true, status: 200, json: async () => statics[p] } : { ok: false, status: 404, json: async () => ({}) };

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const ROSTERS_STEP = 5000;
const users = [{ user_id: "u1", display_name: "Max973" }, { user_id: "u2", display_name: "Bo" }];
const rosters = [
  { roster_id: 9, owner_id: "u1", players: ["a", "k"], starters: ["a", "k"], reserve: [], taxi: [] },
  { roster_id: 3, owner_id: "u2", players: ["b"], starters: ["b"], reserve: [], taxi: [] },
];
const league = { league_id: L, name: "Gabagool Fools", season: String(draftBoard.season), status: "in_season", total_rosters: draftBoard.league.teams,
  settings: { waiver_type: 2 }, scoring_settings: { ...draftBoard.league.sleeper_scoring },
  roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN"] };
const state = { season: String(draftBoard.season), season_type: "regular", week: 3 };
const catalog = { a: { position: "RB", full_name: "A Back", team: "X" }, b: { position: "WR", full_name: "B Wide", team: "Y" }, k: { position: "K", full_name: "Kicker", team: "X" } };
function baseRoutes() {
  return {
    "/user/max973": { user_id: "u1", username: "max973", display_name: "Max973" },
    "/user/bo": { user_id: "u2", username: "bo", display_name: "Bo" },
    [`/league/${L}`]: league, [`/league/${L}/users`]: users,
    [`/league/${L}/rosters`]: () => { clock += ROSTERS_STEP; return rosters; },
    "/state/nfl": state, [`/league/${L}/transactions/3`]: [], "/players/nfl": catalog,
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
const GATE = "Enter your Sleeper username in the league panel above; the plan reads your roster from there.";

(async () => {
  routes = baseRoutes();
  const main = dom("https://example.test/Megatron/weekly.html?league=gabagool");
  for (const [tag, id] of [["p", "ss-status"], ["div", "ss-exclude"], ["div", "ss-output"]]) { const e = element(tag); e.id = id; main.append(e); }
  const $ = id => document.getElementById(id);
  const statusText = () => $("ss-status").textContent;
  const chipForm = () => all($("session-chip")).find(n => n.tagName === "form");
  const outputText = () => all($("ss-output")).map(n => n.textContent).join(" ");

  // 1. weekly.html's order: the controller subscribes first, then the page
  //    mounts the chip and sets the board. Anonymous: gated, no Sleeper call.
  StartSitMode.init();
  assert.equal(statusText(), GATE, "anonymous at init: the plan gates on the session");
  const slug = FC.leagueNavigation();
  assert.equal(slug, "gabagool");
  FC.setBoard(weekly);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [], "a board with no identity loads nothing");
  assert.ok($("session-chip"));
  const trace = [];
  Session.onChange(snap => trace.push([snap.state, statusText(), $("ss-output").children.length]));

  // 2. Identify through the chip's form. The lineup renders from the
  //    committed bundle; the engine is handed the PRE-request time.
  let release;
  routes["/user/max973"] = () => new Promise(r => { release = () => r({ user_id: "u1", username: "max973", display_name: "Max973" }); });
  $("session-user").value = "max973";
  chipForm().dispatch("submit");
  assert.equal(Session.state(), "identifying");
  assert.equal($("ss-output").children.length, 0);
  await until(() => release, "the deferred user lookup");
  release();
  await until(() => $("ss-output").children.length > 0, "the lineup to render", 5000);
  assert.deepEqual(trace.map(t => t[0]), ["identifying", "identified", "loadingLeague", "ready"]);
  assert.deepEqual(trace.map(t => t[1]), [GATE, "Loading league…", "Loading league…", "Reading roster, scoring, projections and kickoff times…"]);
  assert.ok(trace.every(t => t[2] === 0), "nothing is rendered before the controller's own load completes");
  trace.length = 0;
  const b1 = Session.bundle();
  assert.equal(b1.myRoster.roster_id, 9);
  assert.equal(b1.rostersFetchedAt - b1.rostersRequestedAt, ROSTERS_STEP);
  assert.equal(analyzeCalls.length, 1);
  assert.equal(analyzeCalls[0].snapshotAt, b1.rostersRequestedAt, "snapshotAt === bundle.rostersRequestedAt (kickoff gate)");
  assert.notEqual(analyzeCalls[0].snapshotAt, b1.rostersFetchedAt);
  assert.equal(analyzeCalls[0].roster.roster_id, 9);
  assert.equal(analyzeCalls[0].league, league);
  assert.match(statusText(), new RegExp(`^Read-only roster 9; week 3; rosters requested ${new Date(b1.rostersRequestedAt).toISOString()}, received ${new Date(b1.rostersFetchedAt).toISOString()}\\.`));
  assert.match(outputText(), /Model lineup/); assert.match(outputText(), /w1/);
  // The exclusion list offers my QB/RB/WR/TE players only (the kicker is not offered).
  assert.equal($("ss-exclude").children.length, 1);
  assert.match(all($("ss-exclude")).map(n => n.textContent).join(" "), /A Back/);
  assert.doesNotMatch(all($("ss-exclude")).map(n => n.textContent).join(" "), /Kicker/);

  // 3. Identity change: lineup AND exclusion list cleared the instant the
  //    lookup starts; the new account's roster renders from the re-derived
  //    bundle with no league load.
  $("session-change").dispatch("click");
  let releaseBo;
  routes["/user/bo"] = () => new Promise(r => { releaseBo = () => r({ user_id: "u2", username: "bo", display_name: "Bo" }); });
  $("session-user").value = "bo";
  const before3 = calls.length;
  chipForm().dispatch("submit");
  assert.equal(Session.state(), "identifying");
  assert.equal($("ss-output").children.length, 0, "an identity change must clear the lineup synchronously");
  assert.equal($("ss-exclude").children.length, 0, "an identity change must clear the exclusion list synchronously");
  assert.equal(statusText(), GATE);
  await until(() => releaseBo, "the deferred lookup for bo");
  releaseBo();
  await until(() => /^Read-only roster 3;/.test(statusText()) && $("ss-output").children.length > 0, "the new account's lineup", 5000);
  const b2 = Session.bundle();
  assert.notEqual(b2, b1); assert.equal(b2.rostersFetchedAt, b1.rostersFetchedAt, "identity change: no refetch");
  assert.deepEqual(calls.slice(before3).filter(p => /^\/league\//.test(p) && !/transactions/.test(p)), []);
  assert.equal(analyzeCalls.length, 2);
  assert.equal(analyzeCalls[1].roster.roster_id, 3);
  assert.match(all($("ss-exclude")).map(n => n.textContent).join(" "), /B Wide/);
  // forget clears synchronously as well.
  $("session-forget").dispatch("click");
  assert.equal($("ss-output").children.length, 0); assert.equal($("ss-exclude").children.length, 0);
  assert.equal(statusText(), GATE);
  routes["/user/max973"] = baseRoutes()["/user/max973"];
  $("session-user").value = "max973";
  chipForm().dispatch("submit");
  await until(() => /^Read-only roster 9;/.test(statusText()), "roster 9 back", 5000);
  const b3 = Session.bundle();
  assert.equal(analyzeCalls.length, 3);

  // 4. A FAILED refresh: the bundle object, both timestamps and the rendered
  //    snapshot all stay; the status says so and names the retained fetch time.
  routes[`/league/${L}/rosters`] = new Error("HTTP 503");
  const outputBefore = $("ss-output").children;
  $("session-refresh").dispatch("click");
  assert.equal(Session.state(), "refreshing");
  assert.equal(statusText(), "Refreshing rosters…");
  assert.equal($("ss-output").children, outputBefore, "a refresh in flight keeps the lineup on screen");
  await until(() => Session.state() === "ready", "the failed refresh to settle");
  assert.equal(Session.bundle(), b3, "a failed refresh leaves the committed bundle untouched");
  assert.equal(b3.rostersRequestedAt, b1.rostersRequestedAt); assert.equal(b3.rostersFetchedAt, b1.rostersFetchedAt);
  assert.equal(statusText(), `Refresh did not complete; the roster snapshot received ${new Date(b1.rostersFetchedAt).toISOString()} is still shown. See the league panel for the reason.`);
  assert.equal($("ss-output").children, outputBefore, "the previous lineup is still shown");
  assert.equal(analyzeCalls.length, 3, "nothing committed: the engine did not re-run");
  // The retained snapshot still drives a re-render (an exclusion toggle) with
  // the OLD pre-request time -- proof the snapshot, not just the DOM, survived.
  all($("ss-exclude")).find(n => n.tagName === "input").dispatch("change");
  assert.equal(analyzeCalls.length, 4);
  assert.equal(analyzeCalls[3].snapshotAt, b1.rostersRequestedAt, "re-render after a failed refresh keeps the old snapshotAt");

  // 5. A SUCCESSFUL refresh adopts the new bundle: new stamps, new snapshotAt.
  routes[`/league/${L}/rosters`] = baseRoutes()[`/league/${L}/rosters`];
  clock += 10000;
  const an5 = analyzeCalls.length;
  $("session-refresh").dispatch("click");
  await until(() => Session.bundle() !== b3 && analyzeCalls.length === an5 + 1, "the refreshed bundle to be adopted", 5000);
  const b4 = Session.bundle();
  assert.ok(b4.rostersRequestedAt > b1.rostersRequestedAt && b4.rostersFetchedAt > b1.rostersFetchedAt);
  assert.equal(analyzeCalls[an5].snapshotAt, b4.rostersRequestedAt, "the engine gets the NEW pre-request time");
  assert.match(statusText(), new RegExp(`^Read-only roster 9; week 3; rosters requested ${new Date(b4.rostersRequestedAt).toISOString()}, received ${new Date(b4.rostersFetchedAt).toISOString()}\\.`));

  // 6. The 60 s expiry reads rostersFetchedAt (POST-fetch), not the
  //    pre-request time the engine gates on: 59 s after the fetch is 64 s
  //    after the request and must still render.
  const toggle = () => all($("ss-exclude")).find(n => n.tagName === "input").dispatch("change");
  clock = b4.rostersFetchedAt + 59000;
  toggle();
  assert.ok($("ss-output").children.length > 0, "59 s after the FETCH the lineup still renders");
  assert.equal(analyzeCalls.length, an5 + 2);
  assert.equal(analyzeCalls[an5 + 1].snapshotAt, b4.rostersRequestedAt);
  clock = b4.rostersFetchedAt + 61000;
  toggle();
  assert.equal(statusText(), "Roster snapshot expired. Refresh from the league panel before using these decisions.");
  assert.equal($("ss-output").children.length, 0, "an expired snapshot renders no lineup");
  assert.equal(analyzeCalls.length, an5 + 2, "expired: the engine is not run");

  Date.now = realNow;
  console.log("startsitmode_session_fixture: real StartSitMode.init + real Session + real chip (gate, identify, identity change, failed/successful refresh, timestamps) OK");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
