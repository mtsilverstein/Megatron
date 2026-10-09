// tests/waivermode_session_fixture.cjs — run with: node tests/waivermode_session_fixture.cjs
//
// The REAL waiver-desk controller (WaiverMode.init) driven through the REAL
// Session, the REAL identity chip (app.js), the REAL league data adapter
// (LeagueData over a synthetic neutral batch) and the REAL live-world
// resolver (LiveWorld) under a fake DOM, the way waivers.html wires it: the
// controller itself mounts the chip and loads the league by Sleeper id
// (any-league spec §5.1). waivers_fixture covers the ENGINE; here the engine
// (Waivers/WaiverIntel.analyze) is a recording stub so the controller's
// contract is pinned:
//   anonymous load -> gate; owner flow: identify -> desk; identity change
//   clears SYNCHRONOUSLY; failed refresh keeps the snapshot and BOTH roster
//   timestamps; a successful refresh adopts the new bundle (and its `also`
//   transactions); snapshotAt === bundle.rostersRequestedAt while the 60 s
//   UI expiry reads bundle.rostersFetchedAt;
//   statics = the neutral batch + roles/kickoffs/ros-ecr only (no draft,
//   remaining, availability or simulation-eval file) and views per bundle;
//   rendered format line, banner, footnotes, heuristic labels, simulation
//   note, aggregation/horizon labels, ECR labels, settings stamp, evidence
//   fallback; FAAB reserve default (20% of the budget) reset on a budget
//   change unless typed; viewer flow ("Viewing {team}", protections and bids
//   owner-only) then owner; live settings recompute; best ball (projections
//   only, no shortlist); reverse standings.
// All league data is synthetic (fictional owners and ids).
const assert = require("node:assert/strict");
const fs = require("node:fs");
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
// waivers.html's ids, in the shape init() reads them (a label around the
// reserve input for closest("label"); tbodies inside the two tables; the
// export textarea inside a details).
function waiversPage(main) {
  const withId = (tag, id, parent = main) => { const e = element(tag); e.id = id; parent.append(e); return e; };
  const controls = withId("div", "waiver-controls");
  withId("input", "waiver-week", controls).value = "";
  const reserveLabel = element("label"); controls.append(reserveLabel);
  withId("input", "waiver-reserve", reserveLabel).value = "";
  withId("p", "waiver-status");
  withId("div", "waiver-warnings").hidden = true;
  const results = withId("section", "waiver-results"); results.hidden = true;
  for (const [tag, id] of [["div", "waiver-context"], ["div", "waiver-budget"], ["p", "waiver-coverage"], ["p", "waiver-ros"], ["p", "waiver-source"],
    ["div", "waiver-evaluation"], ["select", "waiver-position"], ["button", "waiver-export"], ["p", "waiver-count"],
    ["table", "waiver-table"], ["div", "waiver-roster"], ["p", "waiver-intel-source"], ["p", "waiver-role-source"],
    ["ul", "waiver-byes"], ["select", "waiver-radar-sort"], ["table", "waiver-radar"], ["p", "waiver-market"],
    ["ol", "waiver-watchlist"]]) withId(tag, id, results);
  const details = element("details"); results.append(details);
  withId("textarea", "waiver-backup", details);
  document.getElementById("waiver-position").value = "ALL";
  document.getElementById("waiver-radar-sort").value = "usage";
  for (const t of ["waiver-table", "waiver-radar"]) document.getElementById(t).append(element("tbody"));
  withId("a", "waiver-league-link");
}

// ---- modules ------------------------------------------------------------------
// waivers.html's load order: session, app (FC), sleeper, formats, lineup,
// leaguelens, leaguedata, liveworld, waivers + waiverintel (stubbed here),
// waivermode.
global.window = {};
const Session = require("../site/assets/session.js");
const FC = require("../site/assets/app.js");
assert.equal(window.Session, Session); assert.equal(window.FC, FC);
require("../site/assets/leaguedata.js");
require("../site/assets/liveworld.js");
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
window.Sleeper = { get };               // WaiverMode.loadWorld/loadSignals default getter
Session._get(get);                      // Session.identify/ready/refresh/catalog
const WaiverMode = require("../site/assets/waivermode.js");
assert.equal(window.WaiverMode, WaiverMode);
const analyzeCalls = [];
const LABEL = "rest-of-season value 55.00 (sum of weekly medians through NFL week 17, not a season median); not a FAAB price";
const ROW = { add: { id: "c", name: "C Free", position: "WR" }, drop: null, lineupGain: 2.5, scoring: { source: "weekly", label: "week 3 projection" },
  signal: { strength: "modeled", perWeekGain: 2.5, thresholdPerWeek: 1, moveValue: null, basis: "this_week", label: "modeled lineup gain", guidance: "heuristic bid range" },
  rosterCost: "uses an open roster spot", dropCost: { status: "open_slot", label: "no drop required", addContributes: null, rosDelta: null, futureWeeks: null, endWeek: null },
  availability: { status: null, actionableNow: true, warning: null }, valueEstimate: { points: 55, label: LABEL },
  bid: { low: 4, high: 10, tier: "useful", affordable: 80, canAfford: true, status: null, label: "heuristic, not calibrated and not a win probability" } };
const ENGINE_RESULT = args => {
  const wt = args.league.settings.waiver_type;
  return {
    rows: [{ ...ROW, bid: wt === 2 ? ROW.bid : null }], warnings: ["engine warning"], recommendationBlock: null,
    budget: wt === 2 ? { total: args.league.settings.waiver_budget, used: 0, remaining: args.league.settings.waiver_budget, reserve: args.budgetReserve, spendable: Math.max(0, args.league.settings.waiver_budget - args.budgetReserve) } : null,
    waiver: { type: wt === 2 ? "faab" : wt === 1 ? "reverse_standings" : "rolling", priority: wt === 0 ? 4 : null, guidance: "g" },
    coverage: { scoringLabel: "fresh weekly projection", weeklyFresh: true, projectedOwnedSkills: 1, activeOwnedSkills: 1,
                missingOwnedWeekly: [], unmappedOwnedIds: [], ros: { fresh: false, reason: "remaining-season projections unavailable" } },
  };
};
window.Waivers = { analyze(args) { analyzeCalls.push(args); return ENGINE_RESULT(args); } };
window.WaiverIntel = { analyze: () => ({ radar: [{ id: "c", name: "C Free", position: "WR", team: "X", status: null, ecr: 12, rosRank: 30, adds: 5, drops: null, sameTeam: [], byeCover: [], role: null, roleFlags: [], projectionCovered: true }],
  fetchedAt: "t", rosStatus: "ros", warnings: [], roleStatus: "roles", byeRisks: [], bids: [], freeAgentMoves: 0 }) };

// ---- synthetic neutral batch, Sleeper data, clock ---------------------------------
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;                 // Session stamps the two roster timestamps with this
const L = "900000000000000888";              // not in the registry
const HDR = { season: 2026, week: 3, data_through: "2026-wk2", generated_at: new Date(clock).toISOString(), batch_id: "b-w3" };
const METHOD = { v: 1, model: "transformer", artifacts: ["models/transformer/v1"], ensemble: "mean_of_seed_quantiles",
  band_construction: "sign_coherent_v1", calibration: [], prior: { method: "pooled", rate: 0.09, first_season: 2021, through_season: 2025 } };
const sq = (rec, yds) => {
  const o = f => Object.fromEntries(LL.STATS.map(s => [s, s === "receptions" ? rec * f : s === "receiving_yards" ? yds * f : 0]));
  return { p10: o(0.5), p50: o(1), p90: o(1.5) };
};
// [sleeper id, gsis, position, name, receptions, yards, ecr]
const PEOPLE = [["a", "00-0000001", "RB", "A Back", 4, 60, 20], ["b", "00-0000002", "WR", "B Wide", 6, 80, 8], ["c", "00-0000003", "WR", "C Free", 5, 70, 12]];
const statics = {
  "data/neutral/weekly.json": { ...HDR, schema_version: 1, kind: "neutral_weekly", model: "transformer", method: METHOD,
    players: PEOPLE.map(([sid, pid, pos, name, rec, yds]) => ({ player_id: pid, name, team: "X", opponent: "Y", position: pos, is_home: true,
      stat_quantiles: sq(rec, yds), points: { ppr: null, half_ppr: null, standard: null } })) },
  "data/neutral/players.json": { ...HDR, schema_version: 1, kind: "neutral_players",
    players: PEOPLE.map(([sid, pid, pos, name, , , ecr]) => ({ player_id: pid, sleeper_id: sid, name, team: "X", position: pos, bye: 9, ecr, identity_only: false, reason: null })) },
  "data/neutral/formats.json": { ...require("./fixtures/neutral_formats.json"), ...HDR },
  "data/neutral/evaluation.json": { ...require("./fixtures/neutral_evaluation.json"), ...HDR },
  "data/kickoffs.json": { season: 2026, week: 3, generated_at: HDR.generated_at, teams: ["X", "Y"], games: [] },
  "data/roles.json": { schema_version: 1, season: 2026, before_week: 3, generated_at: HDR.generated_at, status: "observed", players: [] },
};
const fetched = [];
global.fetch = async p => { fetched.push(p); return statics[p] ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(statics[p])) } : { ok: false, status: 404, json: async () => ({}) }; };

const ROSTERS_STEP = 5000;              // the rosters request "takes" 5 s: requestedAt and fetchedAt differ
const users = [{ user_id: "u1", display_name: "Max973" }, { user_id: "u2", display_name: "Bo", metadata: { team_name: "Bo's Bunch" } }];
const rosters = [
  { roster_id: 9, owner_id: "u1", players: ["a", "k"], starters: ["a", "k"], reserve: [], taxi: [], settings: { waiver_position: 4, waiver_budget_used: 0 } },
  { roster_id: 3, owner_id: "u2", players: ["b"], starters: ["b"], reserve: [], taxi: [], settings: { waiver_position: 1, waiver_budget_used: 0 } },
];
const OWNER = require("./fixtures/owner_league_settings.json").gabagool;
const baseLeague = { league_id: L, name: "Synthetic League", season: "2026", status: "in_season", total_rosters: OWNER.total_rosters,
  settings: { type: 0, waiver_type: 2, waiver_budget: 100, best_ball: 0 }, scoring_settings: { ...OWNER.scoring_settings }, roster_positions: OWNER.roster_positions.slice() };
let league = baseLeague;
const state = { season: "2026", season_type: "regular", week: 3 };
const catalog = {
  a: { position: "RB", full_name: "A Back", team: "X", gsis_id: "00-0000001" },
  b: { position: "WR", full_name: "B Wide", team: "X", gsis_id: "00-0000002" },
  c: { position: "WR", full_name: "C Free", team: "X", gsis_id: "00-0000003" },
  k: { position: "K", full_name: "Kicker", team: "X" },
};
function baseRoutes() {
  return {
    "/user/max973": { user_id: "u1", username: "max973", display_name: "Max973" },
    "/user/bo": { user_id: "u2", username: "bo", display_name: "Bo" },
    [`/league/${L}`]: () => league, [`/league/${L}/users`]: users,
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
const GATE = "Enter your Sleeper username, or choose a team to view.";
const SIM_OFF = "Simulation is off: the 2025-season test failed (on synthetic 15-player rosters), and the per-format 2026 test reports in January 2027.";
const IN_TEST = "Format: 12-team 1QB PPR, 6-pt pass TD — in the 2026 format test (results January 2027)";
const AGG = "sum of weekly medians through NFL week 17, not a season median";
const transactionsCalls = () => calls.filter(p => p === `/league/${L}/transactions/3`).length;

(async () => {
  routes = baseRoutes();
  const main = dom(`https://example.test/Megatron/waivers.html?league=${L}`);
  waiversPage(main);
  const $ = id => document.getElementById(id);
  const statusText = () => $("waiver-status").textContent;
  const text = id => all($(id)).map(n => n.textContent).join(" ");
  const chipForm = () => all($("session-chip")).find(n => n.tagName === "form");
  const refresh = async (what, pred) => { clock += 1000; const an = analyzeCalls.length; $("session-refresh").dispatch("click"); await until(pred || (() => analyzeCalls.length > an), what, 5000); };

  // 1. Anonymous mount: the controller mounts the chip and loads the league
  //    by id at once; with no team chosen it gates with the resolver's message.
  WaiverMode.init();
  assert.ok($("session-chip"), "the identity chip is mounted in #league-context by the controller's leagueNavigation()");
  await until(() => statusText() === GATE, "the anonymous gate");
  assert.equal(Session.bundle().analysisRoster, null);
  assert.ok($("waiver-results").hidden);
  assert.equal(analyzeCalls.length, 0, "no roster under analysis, no engine call");
  assert.equal($("waiver-league-link").href, `https://sleeper.com/leagues/${L}/team`, "league link from the live league");
  assert.equal($("waiver-league-link").textContent, "Open Synthetic League in Sleeper");
  const trace = [];
  Session.onChange(snap => trace.push([snap.state, statusText(), $("waiver-results").hidden]));

  // 2. Owner flow: identify through the chip's own form.
  let release;
  routes["/user/max973"] = () => new Promise(r => { release = () => r({ user_id: "u1", username: "max973", display_name: "Max973" }); });
  $("session-user").value = "max973";
  chipForm().dispatch("submit");
  assert.equal(Session.state(), "identifying");
  assert.ok($("waiver-results").hidden, "identifying: no results");
  await until(() => release, "the deferred user lookup to be issued");
  release();
  await until(() => !$("waiver-results").hidden, "the desk to render for the owner's roster", 5000);
  const b1 = Session.bundle();
  assert.equal(b1.analysisRole, "owner"); assert.equal(b1.myRoster.roster_id, 9);
  assert.match(statusText(), /^Connected read-only · roster 9 · rosters received /);
  assert.equal(analyzeCalls.length, 1, "one engine run per committed bundle");
  const c0 = analyzeCalls[0];
  // Statics: the neutral batch + optional reference files only (spec §6.2: no simulation inputs).
  assert.deepEqual(fetched.slice().sort(), ["data/kickoffs.json", "data/neutral/evaluation.json", "data/neutral/formats.json", "data/neutral/players.json",
    "data/neutral/remaining.json", "data/neutral/weekly.json", "data/roles.json", "data/ros-ecr.json"]);
  assert.ok(!("availability" in c0) && !("evalFile" in c0) && !("leagueSlug" in c0), "no simulation inputs reach the engine");
  // The engine's inputs are the league views; the board is hydrated with every roster identity.
  assert.deepEqual(c0.board.players.map(p => p.sleeper_id).sort(), ["a", "b", "c", "k"]);
  assert.equal(c0.board.players.find(p => p.sleeper_id === "k").identity_only, true);
  assert.equal(c0.board.players.find(p => p.sleeper_id === "a").current_team, "X");
  const pA = c0.weekly.players.find(p => p.player_id === "00-0000001");
  assert.equal(pA.points.league.p50, LL.score(sq(4, 60), "RB", LL.classify(OWNER.scoring_settings).weights).p50, "points.league = the live league's scoring");
  assert.equal(c0.remaining, null); assert.equal(c0.remainingReason, "remaining-season projections unavailable");
  assert.equal(c0.week, 3); assert.equal(c0.league, baseLeague); assert.equal(c0.rosterId, 9);
  // Kickoff gate: the PRE-request time; the two stamps differ.
  assert.equal(b1.rostersFetchedAt - b1.rostersRequestedAt, ROSTERS_STEP);
  assert.equal(c0.snapshotAt, b1.rostersRequestedAt, "snapshotAt === bundle.rostersRequestedAt (kickoff gate)");
  assert.notEqual(c0.snapshotAt, b1.rostersFetchedAt);
  assert.match($("waiver-source").textContent, new RegExp(`requested ${new Date(b1.rostersRequestedAt).toISOString()} \\(kickoff gate\\), received ${new Date(b1.rostersFetchedAt).toISOString()} \\(60 s expiry\\)`));
  assert.match($("waiver-source").textContent, /League settings read /, "the settings stamp sits with the data timestamps");
  // Reserve default: 20% of a $100 budget.
  assert.equal($("waiver-reserve").value, "20"); assert.equal(c0.budgetReserve, 20);
  assert.equal($("waiver-reserve").closest("label").hidden, false);
  // Format line, footnotes, heuristics, simulation note.
  const ctx = text("waiver-context");
  for (const s of [IN_TEST, "Pick-sixes use an average rate, not a forecast.", "1-point threshold in your league's points (a heuristic)",
    "2-point threshold in your league's points (a heuristic)", "5-point threshold in your league's points (a heuristic)", SIM_OFF]) assert.ok(ctx.includes(s), `context: ${s}`);
  assert.match(ctx, /Not projected: .*\(rare events\)\./);
  // ROS line: horizon + aggregation labels; evidence: fallback (no record binds).
  assert.ok($("waiver-ros").textContent.includes(AGG) && $("waiver-ros").textContent.includes("through NFL week 17, regardless of your league's schedule"));
  assert.equal(text("waiver-evaluation").trim(), "Rest-of-season accuracy: No measured evaluation for your league's scoring and this model.");
  assert.doesNotMatch(text("waiver-evaluation"), /4\.61/);
  // Rows: the "why" value with its aggregation label, owner bid shown; ECR labels.
  assert.ok(text("waiver-table").includes(LABEL));
  assert.ok(text("waiver-table").includes("$4–$10"));
  assert.ok(text("waiver-watchlist").includes("C Free · WR · preseason ECR 12 (PPR reference ranking)"));
  assert.doesNotMatch(text("waiver-watchlist"), /A Back|B Wide/, "rostered players are not on the watchlist");
  assert.ok(text("waiver-radar").includes("ROS overall rank 30 (PPR reference ranking)") && text("waiver-radar").includes("Preseason ECR 12 (PPR reference ranking)"));
  assert.equal($("waiver-roster").children.length, 2, "my roster's players are listed for protection");
  assert.equal(transactionsCalls(), 1, "the week's transactions were fetched once by loadWorld");
  // The export carries the league name and no simulation note.
  $("waiver-export").dispatch("click");
  assert.match($("waiver-backup").value, /^Synthetic League waiver shortlist/);
  assert.doesNotMatch($("waiver-backup").value, /sims|simulated price/);

  // 3. Identity change: the account-derived output is gone the moment the lookup starts.
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
  await until(() => !$("waiver-results").hidden && /roster 3/.test(statusText()), "the desk for the new account's roster", 5000);
  const b2 = Session.bundle();
  assert.notEqual(b2, b1); assert.equal(b2.myRoster.roster_id, 3);
  assert.equal(b2.rostersFetchedAt, b1.rostersFetchedAt, "no refetch on identity change: the timestamps carry over");
  assert.deepEqual(calls.slice(before3).filter(p => /^\/league\//.test(p) && !/transactions/.test(p)), [], "an identity change loads no league data");
  assert.equal(analyzeCalls.at(-1).snapshotAt, b2.rostersRequestedAt);
  assert.match(text("waiver-roster"), /B Wide/); assert.doesNotMatch(text("waiver-roster"), /A Back/);
  // forget: cleared synchronously, back to the gate; re-identify brings roster 9 back.
  $("session-forget").dispatch("click");
  assert.ok($("waiver-results").hidden, "forget hides the results synchronously");
  assert.equal(statusText(), GATE);
  routes["/user/max973"] = baseRoutes()["/user/max973"];
  $("session-user").value = "max973";
  chipForm().dispatch("submit");
  await until(() => !$("waiver-results").hidden && /roster 9/.test(statusText()), "roster 9 back after re-identify", 5000);
  const b3 = Session.bundle();
  const an3 = analyzeCalls.length;

  // 4. A FAILED refresh: nothing commits, both stamps stay, the desk says so.
  routes[`/league/${L}/rosters`] = new Error("HTTP 503");
  $("session-refresh").dispatch("click");
  assert.equal(Session.state(), "refreshing");
  assert.equal(statusText(), "Refreshing rosters and this week's transactions…");
  assert.ok(!$("waiver-results").hidden, "a refresh in flight keeps the results visible");
  await until(() => Session.state() === "ready", "the failed refresh to settle");
  assert.equal(Session.bundle(), b3, "a failed refresh must leave the committed bundle object untouched");
  assert.equal(Session.bundle().rostersRequestedAt, b1.rostersRequestedAt);
  assert.equal(Session.bundle().rostersFetchedAt, b1.rostersFetchedAt);
  assert.match(statusText(), /^Refresh did not complete; see the league panel for the reason\. The roster snapshot received .* is still shown\.$/);
  assert.equal(analyzeCalls.length, an3, "nothing committed: the engine did not re-run");
  // 4b. The `also` hook failing (transactions 502) commits nothing and names the reason.
  routes[`/league/${L}/rosters`] = baseRoutes()[`/league/${L}/rosters`];
  routes[`/league/${L}/transactions/3`] = new Error("HTTP 502");
  $("session-refresh").dispatch("click");
  await until(() => Session.state() === "ready" && /did not complete/.test(statusText()), "the also-failure to settle");
  assert.equal(Session.bundle(), b3, "a failed `also` must commit nothing");
  assert.match(statusText(), /^Refresh did not complete \(HTTP 502\)\. The roster snapshot received .* is still shown\.$/);
  assert.equal(analyzeCalls.length, an3);

  // 5. A SUCCESSFUL refresh adopts the new bundle; the also-hook transactions ride on bundle.extra.
  routes[`/league/${L}/transactions/3`] = [{ type: "waiver", status: "complete" }];
  const tx5 = transactionsCalls(), an5 = analyzeCalls.length;
  clock += 10000;
  $("session-refresh").dispatch("click");
  await until(() => Session.bundle() !== b3 && analyzeCalls.length === an5 + 1, "the refreshed bundle to be adopted", 5000);
  const b4 = Session.bundle();
  assert.ok(b4.rostersRequestedAt > b1.rostersRequestedAt && b4.rostersFetchedAt > b1.rostersFetchedAt, "new stamps");
  assert.deepEqual(b4.extra, { week: 3, transactions: [{ type: "waiver", status: "complete" }] });
  assert.equal(transactionsCalls(), tx5 + 1, "one transactions fetch (the also hook); loadWorld reused bundle.extra");
  assert.equal(analyzeCalls[an5].snapshotAt, b4.rostersRequestedAt, "the engine gets the NEW pre-request time");
  assert.deepEqual(analyzeCalls[an5].transactions, b4.extra.transactions);

  // 6. The 60 s UI expiry reads rostersFetchedAt (the reserve change handler is the tick's recompute()).
  clock = b4.rostersFetchedAt + 59000;
  $("waiver-reserve").dispatch("change");
  assert.ok(!$("waiver-results").hidden, "59 s after the FETCH the snapshot is still usable");
  assert.equal(analyzeCalls.length, an5 + 2);
  assert.equal(analyzeCalls[an5 + 1].snapshotAt, b4.rostersRequestedAt, "recompute keeps the committed snapshotAt");
  clock = b4.rostersFetchedAt + 61000;
  $("waiver-reserve").dispatch("change");
  assert.equal(statusText(), "Roster snapshot expired. Refresh from the league panel before using waiver recommendations.");
  assert.ok($("waiver-results").hidden, "an expired snapshot hides the recommendations");
  assert.equal(analyzeCalls.length, an5 + 2, "expired: the engine is not run");

  // 7. FAAB reserve: the default follows a budget change; a typed value is kept; an emptied box hands back.
  league = { ...baseLeague, settings: { ...baseLeague.settings, waiver_budget: 10 } };
  await refresh("the $10 budget");
  assert.equal($("waiver-reserve").value, "2", "budget change resets the default (20% of $10)");
  assert.equal(analyzeCalls.at(-1).budgetReserve, 2);
  $("waiver-reserve").value = "7"; $("waiver-reserve").dispatch("input"); $("waiver-reserve").dispatch("change");
  assert.equal(analyzeCalls.at(-1).budgetReserve, 7);
  league = { ...baseLeague, settings: { ...baseLeague.settings, waiver_budget: 0 } };
  await refresh("the $0 budget");
  assert.equal($("waiver-reserve").value, "7", "a typed reserve survives a budget change");
  assert.equal(analyzeCalls.at(-1).budgetReserve, 7);
  $("waiver-reserve").value = ""; $("waiver-reserve").dispatch("input");
  league = { ...baseLeague, settings: { ...baseLeague.settings, waiver_budget: 50 } };
  await refresh("the $50 budget");
  assert.equal($("waiver-reserve").value, "10", "an emptied box hands control back to the default");
  league = { ...baseLeague, settings: { ...baseLeague.settings, waiver_budget: 50 } };
  $("waiver-reserve").value = "12";   // set without typing (e.g. an earlier default) -- same budget keeps it
  await refresh("the same budget");
  assert.equal($("waiver-reserve").value, "12", "no budget change: no reset");
  league = baseLeague;
  await refresh("back to $100");
  assert.equal($("waiver-reserve").value, "20");
  // Emptying the box (change, no budget change) refills the default and keeps the results visible.
  $("waiver-reserve").value = ""; $("waiver-reserve").dispatch("input"); $("waiver-reserve").dispatch("change");
  assert.equal($("waiver-reserve").value, "20", "emptied box refills the league default");
  assert.ok(!$("waiver-results").hidden, "results stay visible");
  assert.equal(analyzeCalls.at(-1).budgetReserve, 20);
  $("waiver-reserve").value = "9"; $("waiver-reserve").dispatch("input"); $("waiver-reserve").dispatch("change");
  assert.equal(analyzeCalls.at(-1).budgetReserve, 9, "a typed value still persists");
  assert.equal($("waiver-reserve").value, "9");
  $("waiver-reserve").value = "20"; $("waiver-reserve").dispatch("input"); $("waiver-reserve").dispatch("change");
  // The weak-signal sentence carries a single parenthetical.
  assert.ok(!/\([^)]*\([^)]*\)/.test($("waiver-count").textContent), "no nested parentheses in the count line");

  // 8. Viewer flow: forget -> choose Bo's team -> "Viewing ...", protections and bids owner-only.
  $("session-forget").dispatch("click");
  assert.equal(statusText(), GATE);
  const picker = () => all($("session-chip")).find(n => n.id === "session-team");
  assert.ok(picker(), "an anonymous visitor gets the team picker");
  const an8 = analyzeCalls.length;
  picker().value = "3"; picker().dispatch("change");
  await until(() => analyzeCalls.length === an8 + 1 && !$("waiver-results").hidden, "the viewed team's desk", 5000);
  assert.equal(Session.bundle().analysisRole, "viewer");
  assert.equal(analyzeCalls.at(-1).rosterId, 3);
  assert.match(statusText(), /^Viewing Bo's Bunch · rosters received /);
  assert.doesNotMatch(statusText() + text("waiver-results"), /your roster|Your active/i);
  assert.equal($("waiver-roster").querySelectorAll("input").length, 0, "protect boxes are owner-only");
  assert.ok(text("waiver-table").includes("Claim guidance is for the team's owner."));
  assert.doesNotMatch(text("waiver-table"), /\$4–\$10/, "no bids for viewers");
  assert.equal($("waiver-reserve").closest("label").hidden, true, "the reserve is the owner's choice");
  assert.equal(analyzeCalls.at(-1).budgetReserve, 20, "the viewer's engine run uses the league default");
  assert.ok(!text("waiver-budget").includes("Keep in reserve"));
  // ...then identifies as the owner of ANOTHER roster: the owner's desk, the viewer label gone.
  $("session-user").value = "max973";
  chipForm().dispatch("submit");
  await until(() => /^Connected read-only · roster 9/.test(statusText()) && analyzeCalls.at(-1).rosterId === 9 && !$("waiver-results").hidden, "the owner's own desk", 5000);
  assert.equal(Session.bundle().viewedRosterId, null, "the viewed choice is dropped, not merged");
  assert.doesNotMatch(statusText(), /Viewing/);
  assert.ok($("waiver-roster").querySelectorAll("input").length > 0, "the owner's protections are back");
  assert.ok(text("waiver-table").includes("$4–$10"));

  // 9. Live settings (spec §5.2): a changed scoring is rescored, never refused; the banner follows.
  league = { ...baseLeague, scoring_settings: { ...baseLeague.scoring_settings, rec: 0.5, bonus_fd_wr: 0.5 } };
  await refresh("the rescored desk");
  const c9 = analyzeCalls.at(-1);
  assert.equal(c9.league.scoring_settings.rec, 0.5);
  assert.equal(c9.weekly.players.find(p => p.player_id === "00-0000001").points.league.p50, LL.score(sq(4, 60), "RB", LL.classify(league.scoring_settings).weights).p50);
  assert.ok(text("waiver-context").includes("Your league also scores bonus_fd_wr, which these projections leave out; rankings may be off for your league."));
  assert.ok(text("waiver-context").includes("Format: not in the format test"));

  // 10. Reverse standings: no dollars, labeled, no priority claimed.
  league = { ...baseLeague, settings: { ...baseLeague.settings, waiver_type: 1 } };
  await refresh("the reverse-standings desk");
  assert.equal($("waiver-reserve").closest("label").hidden, true);
  assert.ok(text("waiver-budget").includes("Reverse-standings waivers"));
  assert.match($("waiver-market").textContent, /reverse-standings waivers\. .*does not model reverse-standings priority/);
  assert.doesNotMatch(text("waiver-context"), /FAAB bid bands/);
  assert.doesNotMatch(text("waiver-table"), /\$/);

  // 11. Best ball: projections and rest-of-season values only -- no engine run, no shortlist, the note.
  league = { ...baseLeague, settings: { ...baseLeague.settings, best_ball: 1 } };
  const an11 = analyzeCalls.length;
  clock += 1000;
  $("session-refresh").dispatch("click");
  await until(() => $("waiver-count").textContent === WaiverMode.COPY.bestBall && !$("waiver-results").hidden, "the best-ball note", 5000);
  assert.equal(analyzeCalls.length, an11, "best ball: the engine is never run");
  assert.ok(text("waiver-context").includes("Best ball — not eligible for the format test"));
  assert.equal($("waiver-table").querySelector("tbody").children.length, 0, "no shortlist");
  assert.ok($("waiver-ros").textContent.includes(AGG));
  assert.ok(text("waiver-watchlist").includes("preseason ECR 12 (PPR reference ranking)"), "projections/research still render");

  // 12. An unsupported league type is refused with the plain message.
  league = { ...baseLeague, settings: { ...baseLeague.settings, type: 3 } };
  clock += 1000;
  $("session-refresh").dispatch("click");
  await until(() => /isn't supported yet/.test(statusText()), "the unsupported-type message", 5000);
  assert.equal(statusText(), "Could not load safe recommendations: This league type isn't supported yet.");
  assert.ok($("waiver-results").hidden);

  // 13. Page wiring: every page that loads waivermode.js also loads the shared
  //     resolver and its dependencies, once each, in dependency order; the
  //     waiver engine loads after the kernel; no simulation scripts on the desk.
  const site = path.join(__dirname, "..", "site");
  const ORDER = ["formats.js", "lineup.js", "leaguelens.js", "leaguedata.js", "liveworld.js", "waivermode.js"];
  for (const page of fs.readdirSync(site).filter(f => f.endsWith(".html"))) {
    const srcs = [...fs.readFileSync(path.join(site, page), "utf8").matchAll(/<script\b[^>]*src="assets\/([^"?]+)(?:\?[^"]*)?"/g)].map(x => x[1]);
    if (!srcs.includes("waivermode.js")) continue;
    for (const f of ORDER) assert.equal(srcs.filter(s => s === f).length, 1, `${page}: exactly one ${f}`);
    const at = ORDER.map(f => srcs.indexOf(f));
    assert.deepEqual([...at].sort((a, b) => a - b), at, `${page}: ${ORDER.join(" -> ")} in order`);
  }
  const html = fs.readFileSync(path.join(site, "waivers.html"), "utf8");
  const srcs = [...html.matchAll(/<script\b[^>]*src="assets\/([^"?]+)(?:\?[^"]*)?"/g)].map(x => x[1]);
  assert.ok(srcs.indexOf("lineup.js") < srcs.indexOf("waivers.js") && srcs.indexOf("waivers.js") < srcs.indexOf("waivermode.js"));
  assert.ok(!srcs.includes("rostersim.js") && !srcs.includes("ros.js"), "the desk ships no simulation");
  assert.ok(html.includes("Budget to keep ($)"));
  assert.ok(html.includes('aria-describedby="reserve-hint"'));
  assert.ok(html.includes('id="reserve-hint"'));
  assert.ok(html.includes("Defaults to 20% of your league budget"));
  assert.ok(html.includes('id="waiver-context"'));

  Date.now = realNow;
  console.log("waivermode_session_fixture: real WaiverMode.init + Session + chip + LeagueData + LiveWorld (anonymous gate, owner flow, identity change, failed/successful refresh, timestamps, statics, rendered labels, reserve default, viewer -> owner, live settings, reverse standings, best ball, unsupported type, page wiring) OK");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
