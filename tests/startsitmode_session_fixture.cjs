// tests/startsitmode_session_fixture.cjs — run with: node tests/startsitmode_session_fixture.cjs
//
// The REAL start/sit controller (StartSitMode.init) driven through the REAL
// Session, the REAL identity chip (app.js), the REAL league data adapter
// (LeagueData over a synthetic neutral batch) and the REAL live-world
// resolver (LiveWorld) under a fake DOM, the way weekly.html wires it:
// StartSitMode.init() first, then FC.leagueNavigation() and
// FC.setLeague(<Sleeper league id>) (any-league spec §5.1). startsit_fixture
// covers the ENGINE (StartSit.analyze); this one pins the controller with the
// engine stubbed to record what it is handed:
//   anonymous load (no team) -> gate, views still emitted, evidence fallback;
//   owner flow: identify -> plan; identity change clears SYNCHRONOUSLY;
//   failed refresh keeps the snapshot and BOTH roster timestamps; a successful
//   refresh adopts the new bundle; snapshotAt === bundle.rostersRequestedAt
//   while the 60 s UI expiry reads bundle.rostersFetchedAt;
//   viewer flow (Review Focus 5): anonymous chooses a team -> plan "Viewing
//   ...", no exclusions; then identifies as the owner of ANOTHER roster ->
//   the owner's plan, the viewer label gone;
//   live settings (spec §5.2): a refresh with changed scoring recomputes the
//   views and the plan; best ball -> no plan, the note; an unknown starting
//   slot -> no plan, the slot named; an unsupported league type -> refused.
// All league data is synthetic (fictional owners and ids); the scoring is the
// owner's own league settings fixture.
const assert = require("node:assert/strict");
const path = require("node:path");

// ---- fake DOM -----------------------------------------------------------------
const all = node => [node, ...node.children.flatMap(all)];
const matches = (n, sel) => sel === "input:checked" ? n.tagName === "input" && n.checked : n.tagName === sel;
function element(tagName) {
  const el = {
    tagName, children: [], listeners: {}, attrs: {}, parent: null, dataset: {},
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
// weekly.html's load order: session, app (FC), sleeper, formats, lineup,
// leaguelens, leaguedata, liveworld, startsit (engine, stubbed here),
// startsitmode. The controller reads them as bare globals.
global.window = {};
const Session = require("../site/assets/session.js");
const FC = require("../site/assets/app.js");
global.FC = FC;
global.LeagueData = require("../site/assets/leaguedata.js");
global.LiveWorld = require("../site/assets/liveworld.js");
const LL = require("../site/assets/leaguelens.js");
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
const analyzeCalls = [];
const ENGINE = { label: "Model lineup", warnings: ["w1"], lineup: [],
  bench: [{ id: "b", name: "B Wide", alternative: "A Back", gap: 1.5, close: true, overlap: true, eligible: true, locked: false, bye: false }] };
let engineThrows = null;
global.StartSit = window.StartSit = { analyze(args) { analyzeCalls.push(args); if (engineThrows) throw new Error(engineThrows); return ENGINE; } };
require("../site/assets/startsitmode.js");
const StartSitMode = window.StartSitMode;
assert.equal(typeof StartSitMode.init, "function");

// ---- synthetic neutral batch, Sleeper data, clock ---------------------------------
const L = "900000000000000777";              // not in the registry
const HDR = { season: 2026, week: 3, data_through: "2026-wk2", generated_at: "2026-09-16T00:00:00Z", batch_id: "2026-09-16T00:00:00Z|2026-wk2|w3" };
const METHOD = { v: 1, model: "transformer", artifacts: ["models/transformer/v1"], ensemble: "mean_of_seed_quantiles",
  band_construction: "sign_coherent_v1", calibration: [], prior: { method: "pooled", rate: 0.09, first_season: 2021, through_season: 2025 } };
const sq = (rec, yds) => {
  const o = f => Object.fromEntries(LL.STATS.map(s => [s, s === "receptions" ? rec * f : s === "receiving_yards" ? yds * f : 0]));
  return { p10: o(0.5), p50: o(1), p90: o(1.5) };
};
const ppr = v => ({ ppr: { p10: v - 4, p50: v, p90: v + 4 }, half_ppr: { p10: v - 5, p50: v - 1, p90: v + 3 }, standard: { p10: v - 6, p50: v - 2, p90: v + 2 } });
const PEOPLE = [["a", "00-0000001", "RB", "A Back", 4, 60], ["b", "00-0000002", "WR", "B Wide", 6, 80]];
const statics = {
  "data/neutral/weekly.json": { ...HDR, schema_version: 1, kind: "neutral_weekly", model: "transformer", method: METHOD,
    players: PEOPLE.map(([sid, pid, pos, name, rec, yds]) => ({ player_id: pid, name, team: "X", opponent: "Y", position: pos, is_home: true,
      stat_quantiles: sq(rec, yds), points: ppr(rec + yds / 10) })) },
  "data/neutral/players.json": { ...HDR, schema_version: 1, kind: "neutral_players",
    players: PEOPLE.map(([sid, pid, pos, name]) => ({ player_id: pid, sleeper_id: sid, name, team: "X", position: pos, bye: 9, ecr: null, identity_only: false, reason: null })) },
  "data/neutral/formats.json": { ...require("./fixtures/neutral_formats.json"), ...HDR },
  "data/neutral/evaluation.json": { ...require("./fixtures/neutral_evaluation.json"), ...HDR },
  "data/kickoffs.json": { season: 2026, week: 3, generated_at: HDR.generated_at, teams: ["X", "Y"], games: [] },
};
const fetched = [];
global.fetch = async p => { fetched.push(p); return statics[p] ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(statics[p])) } : { ok: false, status: 404, json: async () => ({}) }; };

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const ROSTERS_STEP = 5000;
const users = [{ user_id: "u1", display_name: "Max973" }, { user_id: "u2", display_name: "Bo", metadata: { team_name: "Bo's Bunch" } }];
const rosters = [
  { roster_id: 9, owner_id: "u1", players: ["a", "k"], starters: ["a", "k"], reserve: [], taxi: [] },
  { roster_id: 3, owner_id: "u2", players: ["b"], starters: ["b"], reserve: [], taxi: [] },
];
const OWNER = require("./fixtures/owner_league_settings.json").gabagool;
const baseLeague = { league_id: L, name: "Synthetic League", season: "2026", status: "in_season", total_rosters: OWNER.total_rosters,
  settings: { type: 0, waiver_type: 2, best_ball: 0 }, scoring_settings: { ...OWNER.scoring_settings }, roster_positions: OWNER.roster_positions.slice() };
let league = baseLeague;
const state = { season: "2026", season_type: "regular", week: 3 };
const catalog = {
  a: { position: "RB", full_name: "A Back", team: "X", gsis_id: "00-0000001" },
  b: { position: "WR", full_name: "B Wide", team: "Y", gsis_id: "00-0000002" },
  k: { position: "K", full_name: "Kicker", team: "X" },
};
function baseRoutes() {
  return {
    "/user/max973": { user_id: "u1", username: "max973", display_name: "Max973" },
    "/user/bo": { user_id: "u2", username: "bo", display_name: "Bo" },
    [`/league/${L}`]: () => league, [`/league/${L}/users`]: users,
    [`/league/${L}/rosters`]: () => { clock += ROSTERS_STEP; return rosters; },
    "/state/nfl": state, "/players/nfl": catalog,
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
const GATE = "Enter your Sleeper username, or choose a team to view.";
const NO_EVIDENCE = "No measured evaluation for your league's scoring and this model.";
const BEST_BALL = "Best-ball scoring picks your top scorers after the games; lineup advice doesn't apply.";
const HEURISTIC = "3-point threshold in your league's points (a heuristic)";
const IN_TEST = "Format: 12-team 1QB PPR, 6-pt pass TD — in the 2026 format test (results January 2027)";

(async () => {
  routes = baseRoutes();
  const main = dom(`https://example.test/Megatron/weekly.html?league=${L}`);
  for (const [tag, id] of [["p", "ss-status"], ["div", "ss-exclude"], ["div", "ss-output"], ["p", "ss-evidence"], ["span", "band-evidence"]]) {
    const e = element(tag); e.id = id; main.append(e);
  }
  const $ = id => document.getElementById(id);
  const statusText = () => $("ss-status").textContent;
  const chipForm = () => all($("session-chip")).find(n => n.tagName === "form");
  const outputText = () => all($("ss-output")).map(n => n.textContent).join(" ");
  const excludeText = () => all($("ss-exclude")).map(n => n.textContent).join(" ");
  const views = [];
  StartSitMode.onView(v => views.push(v));

  // 1. weekly.html's order: the controller subscribes first, then the page
  //    mounts the chip and loads the league by id -- anonymously.
  StartSitMode.init();
  assert.equal(statusText(), "Loading league…", "no bundle yet");
  assert.equal(FC.leagueNavigation(), null, "an unregistered id has no registry slug");
  FC.setLeague(FC.inSeasonLeague().leagueId);
  await until(() => views.length === 1, "the anonymous bundle's league views");
  assert.equal(Session.bundle().analysisRoster, null);
  assert.equal(statusText(), GATE, "anonymous with no team: the resolver's message");
  assert.equal($("ss-output").children.length, 0);
  assert.equal(analyzeCalls.length, 0, "no roster under analysis, no engine call");
  // The views exist anyway (the projection table's 'Your league' lens).
  assert.equal(views[0].league, baseLeague);
  const pA = views[0].view.weekly.players.find(p => p.player_id === "00-0000001");
  const scoreA = sc => LL.score(sq(4, 60), "RB", LL.classify(sc).weights).p50;
  assert.equal(pA.points.league.p50, scoreA(OWNER.scoring_settings), "points.league = the live league's scoring");
  assert.deepEqual(Object.keys(pA.points).sort(), ["half_ppr", "league", "ppr", "standard"]);
  // Close-call and calibration lines: only via evidenceFor -> the fallback today.
  assert.match($("ss-evidence").textContent, new RegExp(NO_EVIDENCE.replace(/[.']/g, "\\$&")));
  assert.doesNotMatch($("ss-evidence").textContent, /56\.3/);
  assert.equal($("band-evidence").textContent, NO_EVIDENCE);
  assert.deepEqual(fetched.filter(p => /neutral/.test(p)).sort(),
    ["data/neutral/evaluation.json", "data/neutral/formats.json", "data/neutral/players.json", "data/neutral/remaining.json", "data/neutral/weekly.json"]);
  assert.ok(!fetched.some(p => /draft\.json|data\/weekly\.json/.test(p)), "no legacy per-league file is read");

  // 2. Owner flow: identify through the chip's form. The plan renders from
  //    the committed bundle; the engine is handed the PRE-request time.
  let release;
  routes["/user/max973"] = () => new Promise(r => { release = () => r({ user_id: "u1", username: "max973", display_name: "Max973" }); });
  $("session-user").value = "max973";
  chipForm().dispatch("submit");
  assert.equal(Session.state(), "identifying");
  assert.equal(statusText(), GATE);
  await until(() => release, "the deferred user lookup");
  release();
  await until(() => analyzeCalls.length === 1 && $("ss-output").children.length > 0, "the owner's plan", 5000);
  const b1 = Session.bundle();
  assert.equal(b1.analysisRole, "owner"); assert.equal(b1.myRoster.roster_id, 9);
  assert.equal(b1.rostersFetchedAt - b1.rostersRequestedAt, ROSTERS_STEP);
  const c0 = analyzeCalls[0];
  assert.equal(c0.snapshotAt, b1.rostersRequestedAt, "snapshotAt === bundle.rostersRequestedAt (kickoff gate)");
  assert.notEqual(c0.snapshotAt, b1.rostersFetchedAt);
  assert.equal(c0.roster.roster_id, 9);
  assert.equal(c0.league, baseLeague, "the live league object");
  assert.equal(c0.catalog, catalog);
  assert.equal(c0.kickoffs.week, 3);
  assert.deepEqual(c0.excludeIds, []);
  // board/weekly are the league-neutral views.
  assert.deepEqual(c0.board.players.map(p => p.sleeper_id).sort(), ["a", "b"]);
  assert.ok(c0.weekly.players.every(p => Number.isFinite(p.points.league.p50)));
  assert.equal(c0.weekly.week, 3);
  assert.match(statusText(), new RegExp(`^Read-only roster 9; week 3; rosters requested ${new Date(b1.rostersRequestedAt).toISOString()}, received ${new Date(b1.rostersFetchedAt).toISOString()}\\.`));
  assert.match(statusText(), /League settings read /, "the settings stamp sits with the data timestamps");
  assert.doesNotMatch(statusText(), /Viewing/);
  assert.match(outputText(), /Model lineup/); assert.match(outputText(), /w1/);
  assert.ok(outputText().includes(IN_TEST), "format line");
  assert.ok(outputText().includes("Pick-sixes use an average rate, not a forecast."), "footnotes");
  assert.ok(outputText().includes(HEURISTIC), "heuristic label on the close-call note");
  assert.match(outputText(), /A Back projects 1\.50 points higher — close call/);
  // The exclusion list offers the owner's QB/RB/WR/TE players only.
  assert.equal($("ss-exclude").children.length, 1);
  assert.match(excludeText(), /A Back/); assert.doesNotMatch(excludeText(), /Kicker/);

  // 3. Identity change: plan AND exclusion list cleared the instant the
  //    lookup starts; the new account's roster renders with no league load.
  $("session-change").dispatch("click");
  let releaseBo;
  routes["/user/bo"] = () => new Promise(r => { releaseBo = () => r({ user_id: "u2", username: "bo", display_name: "Bo" }); });
  $("session-user").value = "bo";
  const before3 = calls.length;
  chipForm().dispatch("submit");
  assert.equal(Session.state(), "identifying");
  assert.equal($("ss-output").children.length, 0, "an identity change must clear the plan synchronously");
  assert.equal($("ss-exclude").children.length, 0, "an identity change must clear the exclusion list synchronously");
  assert.equal(statusText(), GATE);
  await until(() => releaseBo, "the deferred lookup for bo");
  releaseBo();
  await until(() => /^Read-only roster 3;/.test(statusText()) && $("ss-output").children.length > 0, "the new account's plan", 5000);
  const b2 = Session.bundle();
  assert.notEqual(b2, b1); assert.equal(b2.rostersFetchedAt, b1.rostersFetchedAt, "identity change: no refetch");
  assert.deepEqual(calls.slice(before3).filter(p => /^\/league\//.test(p)), []);
  assert.equal(analyzeCalls.at(-1).roster.roster_id, 3);
  assert.match(excludeText(), /B Wide/);
  // forget clears synchronously as well, back to the anonymous gate.
  $("session-forget").dispatch("click");
  assert.equal($("ss-output").children.length, 0); assert.equal($("ss-exclude").children.length, 0);
  assert.equal(statusText(), GATE);
  routes["/user/max973"] = baseRoutes()["/user/max973"];
  $("session-user").value = "max973";
  chipForm().dispatch("submit");
  await until(() => /^Read-only roster 9;/.test(statusText()), "roster 9 back", 5000);
  const b3 = Session.bundle();
  const an3 = analyzeCalls.length;

  // 4. A FAILED refresh: the bundle object, both timestamps and the rendered
  //    snapshot all stay; the status says so and names the retained fetch time.
  routes[`/league/${L}/rosters`] = new Error("HTTP 503");
  const outputBefore = $("ss-output").children;
  $("session-refresh").dispatch("click");
  assert.equal(Session.state(), "refreshing");
  assert.equal(statusText(), "Refreshing rosters…");
  assert.equal($("ss-output").children, outputBefore, "a refresh in flight keeps the plan on screen");
  await until(() => Session.state() === "ready", "the failed refresh to settle");
  assert.equal(Session.bundle(), b3, "a failed refresh leaves the committed bundle untouched");
  assert.equal(b3.rostersRequestedAt, b1.rostersRequestedAt); assert.equal(b3.rostersFetchedAt, b1.rostersFetchedAt);
  assert.equal(statusText(), `Refresh did not complete; the roster snapshot received ${new Date(b1.rostersFetchedAt).toISOString()} is still shown. See the league panel for the reason.`);
  assert.equal($("ss-output").children, outputBefore, "the previous plan is still shown");
  assert.equal(analyzeCalls.length, an3, "nothing committed: the engine did not re-run");
  // The retained snapshot still drives a re-render (an exclusion toggle) with
  // the OLD pre-request time -- proof the snapshot, not just the DOM, survived.
  const box = () => all($("ss-exclude")).find(n => n.tagName === "input");
  box().checked = true; box().dispatch("change");
  assert.equal(analyzeCalls.length, an3 + 1);
  assert.equal(analyzeCalls.at(-1).snapshotAt, b1.rostersRequestedAt, "re-render after a failed refresh keeps the old snapshotAt");
  assert.deepEqual(analyzeCalls.at(-1).excludeIds, ["a"]);
  box().checked = false;

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
  //    pre-request time the engine gates on.
  const toggle = () => box().dispatch("change");
  clock = b4.rostersFetchedAt + 59000;
  toggle();
  assert.ok($("ss-output").children.length > 0, "59 s after the FETCH the plan still renders");
  assert.equal(analyzeCalls.length, an5 + 2);
  assert.equal(analyzeCalls[an5 + 1].snapshotAt, b4.rostersRequestedAt);
  clock = b4.rostersFetchedAt + 61000;
  toggle();
  assert.equal(statusText(), "Roster snapshot expired. Refresh from the league panel before using these decisions.");
  assert.equal($("ss-output").children.length, 0, "an expired snapshot renders no plan");
  assert.equal(analyzeCalls.length, an5 + 2, "expired: the engine is not run");

  // 7. Viewer flow (Review Focus 5). Forget -> anonymous; choose Bo's team.
  clock = b4.rostersFetchedAt + 2000;   // back inside the 60 s window
  $("session-forget").dispatch("click");
  assert.equal(statusText(), GATE);
  const picker = () => all($("session-chip")).find(n => n.id === "session-team");
  assert.ok(picker(), "an anonymous visitor gets the team picker");
  const an7 = analyzeCalls.length;
  picker().value = "3"; picker().dispatch("change");
  await until(() => analyzeCalls.length === an7 + 1 && $("ss-output").children.length > 0, "the viewed team's plan", 5000);
  assert.equal(Session.bundle().analysisRole, "viewer");
  assert.equal(analyzeCalls.at(-1).roster.roster_id, 3);
  assert.deepEqual(analyzeCalls.at(-1).excludeIds, [], "viewers get no exclusions");
  assert.match(statusText(), /^Viewing Bo's Bunch; week 3; rosters requested /);
  assert.doesNotMatch(statusText(), /Read-only roster|your roster/i);
  assert.equal($("ss-exclude").children.length, 0, "exclusion checkboxes are owner-only");
  // A viewer cannot exclude: a missing-projection refusal says who can.
  const MISSING = "B Wide: missing current-team weekly projection";
  engineThrows = MISSING;
  const an7b = analyzeCalls.length;
  picker().value = "3"; picker().dispatch("change");
  await until(() => analyzeCalls.length === an7b + 1, "the viewer re-render", 5000);
  assert.equal(statusText(), `No safe full-lineup recommendation: ${MISSING} Only the team's owner can exclude players here.`);
  engineThrows = null;
  // ...then identifies as the owner of ANOTHER roster: owner's plan, viewer label gone.
  $("session-user").value = "max973";
  chipForm().dispatch("submit");
  await until(() => /^Read-only roster 9;/.test(statusText()) && analyzeCalls.at(-1).roster.roster_id === 9 && $("ss-output").children.length > 0, "the owner's own plan", 5000);
  const b7 = Session.bundle();
  assert.equal(b7.analysisRole, "owner"); assert.equal(b7.viewedRosterId, null, "the viewed choice is dropped, not merged");
  assert.doesNotMatch(statusText(), /Viewing/); assert.doesNotMatch(outputText(), /Viewing/);
  assert.match(excludeText(), /A Back/, "the owner's exclusions are back");
  // The owner's refusal copy is unchanged (exclusions are available to him).
  engineThrows = "A Back: missing current-team weekly projection";
  box().dispatch("change");
  assert.equal(statusText(), "No safe full-lineup recommendation: A Back: missing current-team weekly projection");
  engineThrows = null;
  box().dispatch("change");
  assert.match(statusText(), /^Read-only roster 9;/);

  // 8. Live settings (spec 5.2): the refresh re-reads the league; changed
  //    scoring recomputes the views and the plan.
  league = { ...baseLeague, scoring_settings: { ...baseLeague.scoring_settings, rec: 0.5, bonus_fd_wr: 0.5 } };
  const an8 = analyzeCalls.length, v8 = views.length;
  clock += 1000;
  $("session-refresh").dispatch("click");
  await until(() => analyzeCalls.length === an8 + 1 && views.length === v8 + 1, "the recomputed plan", 5000);
  const c8 = analyzeCalls.at(-1);
  assert.equal(c8.league.scoring_settings.rec, 0.5);
  const pA8 = c8.weekly.players.find(p => p.player_id === "00-0000001");
  assert.equal(pA8.points.league.p50, scoreA(league.scoring_settings), "rescored, not refused (spec §8.7)");
  assert.ok(Math.abs(pA8.points.league.p50 - pA.points.league.p50) > 1);
  assert.equal(views.at(-1).league, league);
  assert.ok(outputText().includes("Your league also scores"), "the banner follows the new scoring");
  assert.ok(outputText().includes("Format: not in the format test"));

  // 9. Best ball: projections only, no plan, the note; the eligibility line wins.
  league = { ...baseLeague, settings: { ...baseLeague.settings, best_ball: 1 } };
  const an9 = analyzeCalls.length;
  clock += 1000;
  $("session-refresh").dispatch("click");
  await until(() => outputText().includes(BEST_BALL), "the best-ball note", 5000);
  assert.equal(analyzeCalls.length, an9, "best ball: the engine is never run");
  assert.ok(outputText().includes("Best ball — not eligible for the format test"));
  assert.equal($("ss-exclude").children.length, 0);
  assert.doesNotMatch(outputText(), /Suggested starter/);
  assert.equal(views.at(-1).league, league, "projections (views) still computed for best ball");

  // 10. An unknown starting slot: projections only, the slot named.
  league = { ...baseLeague, roster_positions: ["QB", "XFLEX", "RB", "BN"] };
  clock += 1000;
  $("session-refresh").dispatch("click");
  await until(() => /XFLEX/.test(outputText()), "the unknown-slot message", 5000);
  assert.equal(analyzeCalls.length, an9);
  assert.ok(outputText().includes("Unsupported lineup slot: XFLEX"));

  // 11. An unsupported league type is refused with the plain message.
  league = { ...baseLeague, settings: { ...baseLeague.settings, type: 3 } };
  clock += 1000;
  $("session-refresh").dispatch("click");
  await until(() => /isn't supported yet/.test(statusText()), "the unsupported-type message", 5000);
  assert.equal(statusText(), "Could not load lineup: This league type isn't supported yet.");
  assert.equal(analyzeCalls.length, an9);
  assert.equal($("ss-output").children.length, 0);

  Date.now = realNow;
  console.log("startsitmode_session_fixture: real StartSitMode.init + Session + chip + LeagueData + LiveWorld (anonymous gate, owner flow, identity change, failed/successful refresh, timestamps, viewer -> owner, live settings recompute, best ball, unknown slot, unsupported type, evidence fallback) OK");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
