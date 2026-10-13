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
//   Page layout (waiver cleanup, 2026-10-10): the fake DOM is parsed from the
//   real waivers.html; the claim table has one row per add listing EVERY
//   drop option with its rest-of-season figure, highest first (fix round 1:
//   no "best drop" claim); the best-move card names the add only, for FAAB,
//   rolling and viewers, with its no-claim and no-positive-move states; the
//   data stamp and warnings signpost; protections, position filter and fold
//   state across re-renders; fix round 2: position-scoped card wording with
//   the per-week move-value basis, the preseason entry and radar identity in
//   a claim's Details (with and without a radar entry), and the owner-only
//   tier beside an unaffordable status; minors round: the explicit display
//   limit with a Show all toggle (table, export), total vs shown counts, the
//   export's hidden-adds line, and every claim add kept out of Worth watching; boilerplate stated once above the
//   table; Worth watching collapsed and without the claim adds; summary
//   line, settings row and protection toggle; clipboard copy with the
//   text-box fallback.
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
// waivers.html itself, parsed into the fake DOM (tests/waiverpage_dom.cjs):
// the real ids, nesting and initial hidden/open state.
const { buildWaiverPage } = require("./waiverpage_dom.cjs");
function waiversPage(main) {
  buildWaiverPage(element, main);
  document.getElementById("waiver-position").value = "ALL";
  document.getElementById("waiver-radar-sort").value = "usage";
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
const BID_LABEL = "heuristic, not calibrated and not a win probability";
const WEAK_LABEL = "weak signal: the move's value (this week's gain plus the priced rest-of-season change, averaged per week through NFL week 17; this week's gain alone where the rest of season is not priced) is under 1.0 projected pt/week, below the conservative product threshold — research only, not a bid or priority claim";
// The same add (C Free) with a second, lower-ranked drop, then a weak add.
const ROW_C2 = { ...ROW, drop: { id: "a", name: "A Back", position: "RB" }, lineupGain: 1.5,
  rosterCost: "dropping A Back costs their rest-of-season value, which this desk does not price",
  dropCost: { status: "unassessed", label: "drop cost unassessed: the rest-of-season change is not priced for this swap, so no spend guidance is offered", reason: "remaining-season projections unavailable" },
  signal: { ...ROW.signal, perWeekGain: 1.5, guidance: "no bid suggested; the dropped player's rest-of-season cost is not priced, so assess the drop cost independently before any move" },
  bid: { low: null, high: null, tier: "drop cost unassessed", affordable: 80, canAfford: true, status: "no bid suggested: drop cost unassessed — remaining-season projections unavailable", label: BID_LABEL } };
const ROW_E = { ...ROW, add: { id: "e", name: "E Spare", position: "TE" }, drop: { id: "a", name: "A Back", position: "RB" }, lineupGain: 0.4,
  rosterCost: "dropping A Back costs their rest-of-season value, which this desk does not price",
  dropCost: { status: "unassessed", label: "drop cost unassessed: the rest-of-season change is not priced for this swap, so no spend guidance is offered", reason: "remaining-season projections unavailable" },
  signal: { strength: "weak", perWeekGain: 0.4, thresholdPerWeek: 1, moveValue: null, basis: "this_week", label: WEAK_LABEL, guidance: "no bid suggested; assess the drop cost independently before any move" },
  valueEstimate: { points: 12, label: "rest-of-season value 12.00 (sum of weekly medians through NFL week 17, not a season median); not a FAAB price" },
  bid: { low: null, high: null, tier: "weak signal", affordable: 80, canAfford: true, status: "no bid suggested: the move's value (this week's gain plus the priced rest-of-season change, averaged per week through NFL week 17; this week's gain alone where the rest of season is not priced) is under 1.0 pt/week", label: BID_LABEL } };
let engineRows = null;                  // a scenario's override of the engine's rows
const ENGINE_RESULT = args => {
  const wt = args.league.settings.waiver_type;
  const rows = engineRows || [ROW, ROW_C2, ROW_E];
  return {
    rows: rows.map(r => ({ ...r, bid: wt === 2 ? r.bid : null })), warnings: ["engine warning"], recommendationBlock: null,
    budget: wt === 2 ? { total: args.league.settings.waiver_budget, used: 0, remaining: args.league.settings.waiver_budget, reserve: args.budgetReserve, spendable: Math.max(0, args.league.settings.waiver_budget - args.budgetReserve) } : null,
    waiver: { type: wt === 2 ? "faab" : wt === 1 ? "reverse_standings" : "rolling", priority: wt === 0 ? 4 : null, guidance: require("../site/assets/waivers.js").COPY.guidance[wt === 2 ? "faab" : wt === 1 ? "reverse_standings" : "rolling"] },
    coverage: { scoringLabel: "fresh weekly projection", weeklyFresh: true, projectedOwnedSkills: 1, activeOwnedSkills: 1,
                missingOwnedWeekly: [], unmappedOwnedIds: [], ros: { fresh: false, reason: "remaining-season projections unavailable" } },
  };
};
// The controller captures this stub at init (a later require of waivers.js replaces window.Waivers).
const WaiversStub = window.Waivers = { analyze(args) { analyzeCalls.push(args); return ENGINE_RESULT(args); } };
let intelRadar = null;                  // a scenario's override of the research radar
const BASIS = "the 1-point-per-week heuristic for the move's value (this week's gain plus the priced rest-of-season change, averaged per week through NFL week 17; this week's gain alone where the rest of season is not priced)";
window.WaiverIntel = { analyze: () => ({ radar: intelRadar || [
    { id: "c", name: "C Free", position: "WR", team: "X", status: null, ecr: 12, rosRank: 30, adds: 5, drops: null, sameTeam: [], byeCover: [], role: null, roleFlags: ["snap share and opportunity share both increased"], projectionCovered: true },
    { id: "z", name: "Z Watch", position: "RB", team: "Y", status: "Questionable", ecr: null, rosRank: 80, adds: 40, drops: 2, sameTeam: [], byeCover: [], role: null, roleFlags: [], projectionCovered: false }],
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
  assert.match($("waiver-source").textContent, new RegExp(`requested ${new Date(b1.rostersRequestedAt).toISOString()} \\(kickoff gate\\), received ${new Date(b1.rostersFetchedAt).toISOString()} \\(marked stale after 60 s\\)`));
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
  // Grouped by add: one main row per added player (C Free, E Spare), the
  // engine's rank order kept. Every drop option is listed in the Drop cell
  // with its own rest-of-season figure (no hidden drops, no "best drop");
  // what differs between options is shown with each option.
  const tbody = $("waiver-table").querySelector("tbody");
  const mainRows = tbody.children.filter(tr => tr.className !== "waiver-detail-row");
  const detailRows = tbody.children.filter(tr => tr.className === "waiver-detail-row");
  assert.equal(mainRows.length, 2, "one row per add");
  assert.deepEqual(mainRows.map(tr => tr.children[0].children[0].textContent), ["C Free", "E Spare"], "ranked as the engine ranked them");
  const dropItems = tr => tr.children[1].children[0].children.map(li => li.textContent);
  assert.deepEqual(dropItems(mainRows[0]), [
    "Open roster spot (no drop) — ROS not priced · this week +2.50 · $4–$10 · useful tier",
    "A Back — ROS not priced · this week +1.50 · drop cost unassessed · None suggested (drop cost unassessed)"], "every drop option, each with its own figures");
  assert.equal(mainRows[0].children[1].children[0].tagName, "ul", "a plain list: the order is information, not a numbered pick");
  assert.deepEqual(dropItems(mainRows[1]), ["A Back — ROS not priced"], "shared status is not repeated per option");
  assert.deepEqual(mainRows[0].children[2].children.map(n => n.textContent), ["+1.50 to +2.50", "varies by drop"]);
  assert.deepEqual(mainRows[1].children[2].children.map(n => n.textContent), ["+0.40", "weak signal"]);
  assert.equal(mainRows[0].children[3].textContent, "Varies by drop option (listed with each drop)");
  assert.equal(mainRows[1].children[3].textContent, "None suggested (weak signal)");
  assert.equal(mainRows[0].children[5].textContent, "Add's ROS value 55.00"); assert.equal(mainRows[0].children[5].title, LABEL);
  assert.equal(detailRows.length, 2);
  const cDetail = detailRows[0].children[0].children[0];
  assert.equal(cDetail.tagName, "details"); assert.equal(cDetail.open, false, "row details start collapsed");
  assert.equal(cDetail.children[0].textContent, "Details");
  assert.deepEqual(cDetail.children.filter(n => n.className === "waiver-detail-head").map(n => n.textContent), ["Open roster spot (no drop)", "Drop A Back"], "the long text per drop option");
  assert.ok(all(cDetail).some(n => n.textContent === "Claim guidance: no bid suggested: drop cost unassessed — remaining-season projections unavailable"));
  assert.ok(all(cDetail).some(n => /^drop cost unassessed: .* — remaining-season projections unavailable$/.test(n.textContent)), "the unassessed note with its reason");
  // Signals: badges from the research radar's entry for the same player.
  assert.deepEqual(mainRows[0].children[4].children.map(n => n.textContent), ["Usage rising", "Trending add"]);
  assert.match(mainRows[0].children[4].children[1].title, /^Sleeper 24h adds 5 \/ drops Not listed/);
  assert.equal(mainRows[1].children[4].children[0].textContent, "—", "no radar entry, no badges");
  // Above the table: two short lines only.
  assert.equal($("waiver-count").textContent, "Each row is a separate option — make one claim at a time.");
  assert.equal($("waiver-row-notes").textContent, "Gain = this week's projected lineup change; drop options show each move's rest-of-season change (information, not a pick). Weak signal = the move's value (this week plus the priced rest of season) averages under 1 pt/week through week 17.");
  // Boilerplate identical for every row is stated once, in How this works ("Reading the claim table"), never per row.
  assert.match($("waiver-table-notes").textContent, /^2 players, 3 add\/drop options in total, each evaluated against your current roster; showing 2 players and 3 options\. /);
  assert.ok(text("waiver-table-notes").includes("Add's ROS value: sum of weekly medians through NFL week 17, not a season median; not a FAAB price."));
  for (const once of [BID_LABEL, WEAK_LABEL, "modeled lineup gain", "not a validated best-drop pick"]) {
    assert.ok(text("waiver-table-notes").toLowerCase().includes(once.toLowerCase()), `stated once: ${once}`);
    assert.ok(!text("waiver-table").includes(once), `not repeated per row: ${once}`);
  }
  assert.equal(text("waiver-table-notes").split(BID_LABEL).length - 1, 1, "the bid caveat appears exactly once");
  assert.ok(all($("waiver-method")).some(n => n.id === "waiver-table-notes"), "the full notes live in How this works");
  // The research detail of a claim-table add moved into its row; Worth watching lists the others.
  assert.ok(text("waiver-table").includes("ROS overall rank 30 (PPR reference ranking)") && text("waiver-table").includes("Preseason ECR 12 (PPR reference ranking)"));
  // Fix 3: the claim's Details keep the gated preseason watchlist entry and the radar identity (team).
  const cDetailText = all(detailRows[0]).map(n => n.textContent);
  assert.ok(cDetailText.some(t => /^Preseason watchlist: C Free · WR · preseason ECR 12 \(PPR reference ranking\)/.test(t)), "the preseason entry moves with the player");
  assert.ok(cDetailText.some(t => t.startsWith("Research (C Free · WR · X): ")), "the radar's team stays with the research line");
  assert.doesNotMatch(text("waiver-radar") + text("waiver-watchlist"), /C Free/, "a claim-table add is not repeated in Worth watching");
  assert.ok(text("waiver-radar").includes("Z Watch · RB · Y · Questionable") && text("waiver-radar").includes("Market activity; investigate the cause"));
  assert.ok(text("waiver-radar").includes("Sleeper 24h adds / drops: 40 / 2"), "the usage/market numbers ride in the entry's fold-out");
  assert.doesNotMatch(text("waiver-radar") + text("waiver-watchlist"), /A Back|B Wide/, "rostered players are not on the watchlist");
  assert.equal($("waiver-watchlist").tagName, "ol", "the preseason part keeps its ECR order as an ordered list");
  assert.equal($("waiver-watchlist-head").hidden, true, "no preseason-only entries here: its heading is hidden");
  assert.equal($("waiver-watching").open, false, "Worth watching starts collapsed");
  // Best move: the top-ranked ADD carrying a suggestion; never a drop.
  assert.equal($("waiver-best-text").textContent, "Add C Free (WR) — +1.50 to +2.50 pts this week, depending on the drop. 2 drop options — see the claim table.");
  assert.doesNotMatch($("waiver-best-text").textContent, /A Back/, "the card names no drop");
  assert.equal($("waiver-best-claim").textContent, "Bid or claim depends on the drop option — see the claim table.");
  assert.equal($("waiver-claims").hidden, false);
  // Summary line: data stamp (rosters + projection batch) and the warnings signpost.
  assert.match($("waiver-summary-data").textContent, /^rosters as of .+ · projections through 2026-wk2, generated [A-Z][a-z]{2} \d{1,2} · Your team: /);
  assert.equal($("waiver-warning-link").hidden, false);
  assert.equal($("waiver-warning-link").textContent, "1 data warning — see How this works");
  assert.equal($("waiver-warning-link").attrs.href, "#waiver-warnings-heading");
  assert.equal($("waiver-method").open, false);
  $("waiver-warning-link").dispatch("click");
  assert.equal($("waiver-method").open, true, "the signpost opens the method fold");
  $("waiver-method").open = false;
  // A protection change re-runs the engine with the new protections.
  {
    const boxes = $("waiver-roster").querySelectorAll("input");
    const an = analyzeCalls.length;
    boxes[0].checked = false; boxes[0].dispatch("change");
    assert.equal(analyzeCalls.length, an + 1);
    assert.deepEqual(analyzeCalls.at(-1).protectedIds.slice().sort(), ["k"], "unprotected A Back reaches the engine");
    assert.equal($("waiver-protect-toggle").textContent, "Protected: 1 player");
    boxes[0].checked = true; boxes[0].dispatch("change");
    assert.deepEqual(analyzeCalls.at(-1).protectedIds.slice().sort(), ["a", "k"]);
    assert.equal($("waiver-protect-toggle").textContent, "Protected: 2 players");
  }
  // The position filter narrows the claim table, the card and Worth watching together.
  {
    const mainAdds = () => $("waiver-table").querySelector("tbody").children.filter(tr => tr.className !== "waiver-detail-row").map(tr => tr.children[0].children[0].textContent);
    $("waiver-position").value = "TE"; $("waiver-position").dispatch("change");
    assert.deepEqual(mainAdds(), ["E Spare"]);
    assert.doesNotMatch(text("waiver-radar"), /Z Watch/, "an RB is filtered out of Worth watching");
    // Fix 2: the conclusion is scoped to TE, though C Free (WR) still has a $4–$10 suggestion.
    assert.equal($("waiver-best-text").textContent, `No spend guidance for the modeled TE options this week: all are below ${BASIS}. Closest option: add E Spare (TE) — +0.40 pts this week. 1 drop option — see the claim table.`);
    $("waiver-position").value = "RB"; $("waiver-position").dispatch("change");
    assert.deepEqual(mainAdds(), []); assert.equal($("waiver-claims").hidden, true);
    assert.match($("waiver-best-text").textContent, /^No claim option at RB this week/);
    assert.ok(text("waiver-radar").includes("Z Watch"));
    $("waiver-position").value = "ALL"; $("waiver-position").dispatch("change");
    assert.deepEqual(mainAdds(), ["C Free", "E Spare"]);
  }
  // Fold state survives a re-render (the 15 s tick's recompute rebuilds the rows).
  {
    const claimFold = () => $("waiver-table").querySelector("tbody").children[1].children[0].children[0];
    const watchFold = () => all($("waiver-radar")).find(n => n.tagName === "details");
    claimFold().open = true; claimFold().dispatch("toggle");
    watchFold().open = true; watchFold().dispatch("toggle");
    const before = claimFold();
    $("waiver-reserve").dispatch("change");
    assert.notEqual(claimFold(), before, "the rows were rebuilt");
    assert.equal(claimFold().open, true, "an open row detail stays open");
    assert.equal(watchFold().open, true, "an open watch entry stays open");
    assert.equal($("waiver-table").querySelector("tbody").children[3].children[0].children[0].open, false, "others stay closed");
    claimFold().open = false; claimFold().dispatch("toggle"); watchFold().open = false; watchFold().dispatch("toggle");
  }
  // Summary line and settings row.
  assert.equal($("waiver-summary").hidden, false);
  assert.equal($("waiver-summary-league").textContent, "Synthetic League · Week 3");
  assert.equal($("waiver-budget").textContent, "$100 FAAB remaining · tie priority 4");
  assert.match($("waiver-summary-data").textContent, /^rosters as of .+ · Your team: /);
  assert.equal($("waiver-spendable").textContent, "Keep in reserve $20 · spendable ceiling $80");
  assert.equal($("waiver-status").className, "visually-hidden", "the loaded status stays in the live region, shown by the summary line");
  assert.equal($("waiver-data").hidden, false, "the method fold's data part follows the results");
  assert.equal($("waiver-protect-toggle").hidden, false);
  assert.equal($("waiver-protect-toggle").textContent, "Protected: 2 players", "the starters are protected initially");
  assert.equal($("waiver-protect").hidden, true);
  $("waiver-protect-toggle").dispatch("click");
  assert.equal($("waiver-protect").hidden, false); assert.equal($("waiver-protect-toggle").attrs["aria-expanded"], "true");
  $("waiver-protect-toggle").dispatch("click");
  assert.equal($("waiver-protect").hidden, true); assert.equal($("waiver-protect-toggle").attrs["aria-expanded"], "false");
  assert.equal($("waiver-roster").children.length, 2, "my roster's players are listed for protection");
  assert.equal(transactionsCalls(), 1, "the week's transactions were fetched once by loadWorld");
  // Copy shortlist, fallback: no clipboard API -> the text box shows the same text.
  const setNavigator = value => Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  setNavigator({});
  const settle = () => new Promise(r => setImmediate(r));
  $("waiver-copy").dispatch("click"); await settle();
  assert.match($("waiver-backup").value, /^Synthetic League waiver shortlist/);
  assert.doesNotMatch($("waiver-backup").value, /sims|simulated price/);
  assert.equal($("waiver-backup-wrap").hidden, false, "no clipboard API: the text box is the fallback");
  assert.equal($("waiver-copy-status").textContent, "Clipboard unavailable: copy the text below instead.");
  // ... a refused clipboard falls back the same way ...
  setNavigator({ clipboard: { writeText: async () => { throw new Error("denied"); } } });
  $("waiver-backup-wrap").hidden = true;
  $("waiver-copy").dispatch("click"); await settle(); await settle();
  assert.equal($("waiver-backup-wrap").hidden, false, "a refused clipboard write falls back to the text box");
  // ... and a working clipboard gets the exact text, the box stays hidden.
  const copied = [];
  setNavigator({ clipboard: { writeText: async t => { copied.push(t); } } });
  $("waiver-copy").dispatch("click"); await settle(); await settle();
  assert.equal(copied.length, 1); assert.equal(copied[0], $("waiver-backup").value);
  assert.match(copied[0], /^Synthetic League waiver shortlist/);
  assert.match(copied[0], /\nADD C Free; DROP none; /, "the export keeps one line per add/drop alternative");
  assert.equal(copied[0].split("\n").filter(l => l.startsWith("ADD ")).length, 3, "every alternative, not only the grouped rows");
  assert.equal($("waiver-backup-wrap").hidden, true);
  assert.equal($("waiver-copy-status").textContent, "Shortlist copied to the clipboard. Nothing was sent anywhere.");
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator); else delete globalThis.navigator;

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

  // 6. Roster age reads rostersFetchedAt (the reserve change handler is the tick's recompute()).
  //    Past 60 s the desk STAYS on screen, marked stale, with its own refresh
  //    button (owner report 2026-10-13: the old expiry hid the whole desk every
  //    minute). The hard stop is the engine's kickoff gate: an engine refusal
  //    still hides the results.
  assert.equal($("waiver-stale").hidden, true, "fresh rosters: no stale notice");
  clock = b4.rostersFetchedAt + 59000;
  $("waiver-reserve").dispatch("change");
  assert.ok(!$("waiver-results").hidden, "59 s after the FETCH the snapshot is fresh");
  assert.equal($("waiver-stale").hidden, true);
  assert.equal(analyzeCalls.length, an5 + 2);
  assert.equal(analyzeCalls[an5 + 1].snapshotAt, b4.rostersRequestedAt, "recompute keeps the committed snapshotAt");
  clock = b4.rostersFetchedAt + 61000;
  $("waiver-reserve").dispatch("change");
  assert.ok(!$("waiver-results").hidden, "past 60 s the recommendations stay on screen");
  assert.equal(analyzeCalls.length, an5 + 3, "stale: the engine still runs (its kickoff gate is the hard stop)");
  assert.equal($("waiver-stale").hidden, false, "past 60 s the stale notice shows");
  assert.equal($("waiver-stale-text").textContent, "Rosters loaded 1 min ago — claims may have processed since. Refresh before placing a claim.");
  clock = b4.rostersFetchedAt + 2 * 3600000 + 5000;
  $("waiver-reserve").dispatch("change");
  assert.equal($("waiver-stale-text").textContent, "Rosters loaded 2 h ago — claims may have processed since. Refresh before placing a claim.");
  // The live status announces the stale state with constant text (no age), so the tick does not re-announce it.
  assert.match(statusText(), /\. Rosters are over a minute old and claims may have processed since; use Refresh rosters above the recommendations before placing a claim\.$/);
  const staleStatus = statusText();
  clock += 15000; $("waiver-reserve").dispatch("change");
  assert.equal(statusText(), staleStatus, "the stale status text is stable across ticks");
  // A copied stale shortlist carries the stale warning, computed at copy time.
  setNavigator({});
  $("waiver-copy").dispatch("click"); await settle();
  const staleLines = $("waiver-backup").value.split("\n");
  assert.equal(staleLines[2], "STALE: Rosters loaded 2 h ago — claims may have processed since. Refresh before placing a claim.", "the warning sits right after the source line, before any claim row");
  assert.ok(staleLines.findIndex(l => l.startsWith("ADD ")) > 2);
  assert.equal($("waiver-backup-wrap").hidden, false);
  // The notice's button refreshes like the chip (transactions in the same
  // generation); the desk stays visible throughout and the notice clears.
  {
    const an6 = analyzeCalls.length, tx6 = transactionsCalls(), hiddenSeen = [];
    const off = Session.onChange(() => hiddenSeen.push($("waiver-results").hidden));
    $("waiver-stale-refresh").dispatch("click");
    assert.equal($("waiver-stale-refresh").disabled, true, "disabled while the refresh runs");
    await until(() => Session.bundle() !== b4 && analyzeCalls.length > an6, "the stale-notice refresh to be adopted", 5000);
    if (typeof off === "function") off();
    await until(() => !$("waiver-stale-refresh").disabled, "the button to re-enable");
    assert.equal(transactionsCalls(), tx6 + 1, "the page's refresh options ride along (transactions re-read)");
    assert.ok(!hiddenSeen.includes(true) && !$("waiver-results").hidden, "a same-team refresh never hides the desk");
    assert.equal($("waiver-stale").hidden, true, "fresh rosters again: the notice clears");
    assert.equal($("waiver-backup-wrap").hidden, true, "a same-team refresh clears the old snapshot's copied shortlist");
    assert.equal($("waiver-backup").value, ""); assert.equal($("waiver-copy-status").textContent, "");
    assert.match(statusText(), /Refresh from the league panel before placing a claim\.$/, "fresh again: the status drops the stale wording");
  }
  // A week change (same team) clears a copied shortlist too.
  {
    $("waiver-copy").dispatch("click"); await settle();
    assert.equal($("waiver-backup-wrap").hidden, false);
    assert.doesNotMatch($("waiver-backup").value, /^STALE:/m, "fresh rosters: no stale line in the export");
    const an7 = analyzeCalls.length;
    $("waiver-week").value = "3"; $("waiver-week").dispatch("change");
    await until(() => analyzeCalls.length > an7, "the week-change reload");
    assert.equal($("waiver-backup-wrap").hidden, true, "a week change clears the copied shortlist");
    assert.equal($("waiver-backup").value, "");
    $("waiver-week").value = ""; $("waiver-week").dispatch("change");
    await until(() => analyzeCalls.length > an7 + 1, "back to the automatic week");
  }
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator); else delete globalThis.navigator;
  // An engine refusal (e.g. its kickoff gate) still withholds the desk.
  {
    const realAnalyze = WaiversStub.analyze;
    WaiversStub.analyze = () => { throw new Error("a game started since the roster was loaded; refresh required"); };
    $("waiver-reserve").dispatch("change");
    assert.ok($("waiver-results").hidden, "an engine refusal hides the recommendations");
    assert.equal(statusText(), "a game started since the roster was loaded; refresh required");
    WaiversStub.analyze = realAnalyze;
    $("waiver-reserve").dispatch("change");
    assert.ok(!$("waiver-results").hidden);
  }

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
  // The weak-signal sentence (now in the method fold) carries a single parenthetical.
  assert.ok(!/\([^)]*\([^)]*\)/.test($("waiver-count-detail").textContent), "no nested parentheses in the count line");
  assert.match($("waiver-count-detail").textContent, /^3 independent add\/drop alternatives\. .* 1 are weak signals: the move's value averages under 1 point per week through NFL week 17 \(this week's gain plus the priced rest-of-season change; this week's gain alone where the rest of season is not priced\)/);

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
  // The owner-only line is stated once, in the best-move card: not in the notes, not in every row.
  const OWNER_ONLY = "Claim guidance is for the team's owner.";
  assert.equal(text("waiver-results").split(OWNER_ONLY).length - 1, 1, "owner-only line stated exactly once on the page's results");
  assert.ok(!text("waiver-row-notes").includes(OWNER_ONLY) && !text("waiver-table-notes").includes(OWNER_ONLY), "not in the notes");
  assert.ok(!text("waiver-table").includes(OWNER_ONLY), "not repeated per row");
  assert.ok(all($("waiver-table").querySelector("tbody")).filter(n => n.tagName === "tr" && n.className !== "waiver-detail-row").every(tr => tr.children[3].textContent === "Owner's call"));
  assert.equal($("waiver-best-claim").textContent, "Claim guidance is for the team's owner.");
  // I1: the viewer's card reads the signal state only (no owner guardrails) and is worded "Top-ranked option".
  assert.equal($("waiver-best-text").textContent, "Top-ranked option: add C Free (WR) — +1.50 to +2.50 pts this week, depending on the drop. 2 drop options — see the claim table.");
  assert.match($("waiver-summary-data").textContent, / · Viewing Bo's Bunch$/);
  assert.equal($("waiver-spendable").textContent, "", "reserve and spendable are the owner's");
  assert.equal($("waiver-protect-toggle").textContent, "Protected: 1 starter (owner's choice)");
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

  // 9b. Rolling priority: no dollars; the best-move card says claim or not, and the priority.
  league = { ...baseLeague, settings: { ...baseLeague.settings, waiver_type: 0 } };
  engineRows = [ROW, ROW_E];
  await refresh("the rolling desk");
  assert.equal($("waiver-reserve").closest("label").hidden, true, "no budget to keep in a rolling league");
  assert.equal($("waiver-budget").textContent, "Waiver priority 4 (rolling) · rank claims");
  assert.equal($("waiver-best-text").textContent, "Add C Free (WR) — +2.50 pts this week. No drop needed (open roster spot).");
  assert.equal($("waiver-best-claim").textContent, "Claim: suggested — rank it by value and roster need when you set claim order in Sleeper. Current waiver priority: 4 (context, not a claim-success probability).");
  assert.equal(text("waiver-table").includes("$"), false);
  assert.ok(text("waiver-table-notes").includes("Order claims by value and roster need"), "the rolling guidance is stated once");
  // Only withheld options: the card says no claim is recommended and names the closest ADD.
  engineRows = [ROW_E];
  await refresh("the rolling desk with only a weak option");
  assert.equal($("waiver-best-text").textContent, `No spend guidance for the modeled options this week: all are below ${BASIS}. Closest option: add E Spare (TE) — +0.40 pts this week. 1 drop option — see the claim table.`);
  assert.equal($("waiver-best-claim").textContent, "Claim: none suggested (weak signal). Current waiver priority: 4 (context, not a claim-success probability).");
  // C1: one add, three drops tied on this week's gain, different rest-of-season move
  // values (engine order = roster order): all three listed, highest ROS first, and
  // the card names no drop.
  league = baseLeague;
  const tiedDrop = (id, name, rosDelta) => ({ ...ROW_E, drop: { id, name, position: "WR" },
    rosterCost: `dropping ${name} forfeits ${(9 - rosDelta).toFixed(2)} projected lineup points over weeks 4–17; E Spare adds 9.00 in his place`,
    dropCost: { status: "priced", label: "priced: rest-of-season lineup change over weeks 4–17, assuming participation", addContributes: 9, dropForfeits: 9 - rosDelta, rosDelta, futureWeeks: 14, endWeek: 17 },
    signal: { ...ROW_E.signal, moveValue: 0.4 + rosDelta, basis: "move" } });
  engineRows = [tiedDrop("r1", "Roster First", 5.59), tiedDrop("r2", "Roster Second", 7.14), tiedDrop("r3", "Roster Third", 6.2)];
  await refresh("three tied drops");
  const tiedRows = $("waiver-table").querySelector("tbody").children.filter(tr => tr.className !== "waiver-detail-row");
  assert.equal(tiedRows.length, 1, "one row for the add");
  assert.deepEqual(tiedRows[0].children[1].children[0].children.map(li => li.textContent),
    ["Roster Second — ROS +7.14", "Roster Third — ROS +6.20", "Roster First — ROS +5.59"], "every drop option, highest rest-of-season move value first");
  assert.equal(tiedRows[0].children[3].textContent, "None suggested (weak signal)", "a shared status is shown once, visibly");
  assert.equal($("waiver-best-text").textContent, `No spend guidance for the modeled options this week: all are below ${BASIS}. Closest option: add E Spare (TE) — +0.40 pts this week. 3 drop options — see the claim table.`);
  assert.doesNotMatch($("waiver-best-text").textContent + $("waiver-best-claim").textContent, /Roster (First|Second|Third)/, "the card names no drop");
  assert.equal($("waiver-best-claim").textContent, "Bid: none suggested (weak signal).", "what the card says about the bid is visible in the row");
  assert.ok(text("waiver-table-notes").includes("not a validated best-drop pick"));
  // Fix 3: overlap WITHOUT a radar entry -- the preseason ECR still reaches the page, in the claim's Details.
  engineRows = null; intelRadar = [];
  await refresh("a claim add with no radar entry");
  {
    const cRow = $("waiver-table").querySelector("tbody").children[1];
    assert.ok(all(cRow).some(n => /^Preseason watchlist: C Free · WR · preseason ECR 12 \(PPR reference ranking\)/.test(n.textContent)));
    assert.ok(!all(cRow).some(n => /^Research \(/.test(n.textContent)), "no radar entry, no research line");
    assert.doesNotMatch(text("waiver-radar") + text("waiver-watchlist"), /C Free/, "still not repeated in Worth watching");
  }
  intelRadar = null;
  // Fix 3: an unaffordable owner row keeps its tier as information, never as a suggestion.
  engineRows = [{ ...ROW, bid: { ...ROW.bid, low: null, high: null, canAfford: false, status: "minimum bid exceeds spendable budget" } }];
  await refresh("an unaffordable owner row");
  {
    const tr = $("waiver-table").querySelector("tbody").children[0];
    assert.equal(tr.children[3].textContent, "None: minimum bid exceeds spendable budget (useful tier, not suggested)");
    assert.equal($("waiver-best-claim").textContent, "Bid: none — minimum bid exceeds spendable budget (useful tier, not suggested).");
    assert.equal($("waiver-best-text").textContent, "No spend guidance for the modeled options this week: each option is withheld (minimum bid exceeds spendable budget). Closest option: add C Free (WR) — +2.50 pts this week. No drop needed (open roster spot).");
    assert.doesNotMatch(text("waiver-table") + $("waiver-best-claim").textContent, /\$\d/, "no dollars");
  }
  // Fix 1 in the controller: 17 adds (two drops each), only the last carrying a bid.
  // The table shows the top 15 adds plus the card's add, each with BOTH drops, and says so.
  engineRows = Array.from({ length: 17 }, (_, i) => [0, 1].map(j => ({ ...ROW_E, add: { id: `m${i}`, name: `M Add${i}`, position: "WR" },
    drop: { id: `x${j}`, name: `Drop${j}`, position: "WR" }, lineupGain: 3 - i * 0.1,
    ...(i === 16 ? { signal: { ...ROW.signal }, dropCost: { ...ROW.dropCost }, bid: { ...ROW.bid } } : {}) }))).flat();
  // A radar entry for the one HIDDEN add (M Add15) and an unrelated player.
  intelRadar = [{ id: "m15", name: "M Add15", position: "WR", team: "X", status: null, ecr: null, rosRank: 40, adds: 9, drops: null, sameTeam: [], byeCover: [], role: null, roleFlags: [], projectionCovered: true },
    { id: "z", name: "Z Watch", position: "RB", team: "Y", status: null, ecr: null, rosRank: 80, adds: 40, drops: 2, sameTeam: [], byeCover: [], role: null, roleFlags: [], projectionCovered: false }];
  await refresh("a result larger than the display limit");
  {
    const mainOf = () => $("waiver-table").querySelector("tbody").children.filter(tr => tr.className !== "waiver-detail-row");
    const shownAdds = mainOf();
    assert.equal(shownAdds.length, 16, "top 15 adds plus the card's add");
    assert.equal(shownAdds[15].children[0].children[0].textContent, "M Add16", "the card's add is visible");
    assert.ok(shownAdds.every(tr => tr.children[1].children[0].children.length === 2), "every shown add lists both drop options");
    assert.equal($("waiver-count").textContent, "Each row is a separate option — make one claim at a time.");
    assert.equal($("waiver-limit").hidden, false);
    assert.equal($("waiver-limit-text").textContent, "Showing the top 15 of 17 adds by this week's gain, plus the modeled top option, each with every drop option; 1 more is hidden.");
    assert.equal($("waiver-show-all").tagName, "button");
    assert.equal($("waiver-show-all").textContent, "Show all 17 adds"); assert.equal($("waiver-show-all").attrs["aria-pressed"], "false");
    assert.equal($("waiver-best-text").textContent, "Add M Add16 (WR) — +1.40 pts this week. 2 drop options — see the claim table.");
    // Total vs shown, both stated.
    assert.match($("waiver-table-notes").textContent, /^17 players, 34 add\/drop options in total, each evaluated against your current roster; showing 16 players and 32 options\. /);
    // Worth watching excludes every claim add, hidden ones included.
    assert.doesNotMatch(text("waiver-radar"), /M Add15/, "a hidden claim add is not offered as 'worth watching'");
    assert.ok(text("waiver-radar").includes("Z Watch"));
    // The copy export says what it leaves out.
    const setNav = value => Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
    const savedNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    setNav({});
    $("waiver-copy").dispatch("click"); await new Promise(r => setImmediate(r));
    const limitedExport = $("waiver-backup").value.split("\n");
    assert.ok(limitedExport.includes("Showing the top 15 of 17 adds; 1 more not included — use Show all adds on the page."));
    assert.equal(limitedExport.filter(l => l.startsWith("ADD ")).length, 32);
    // Show all: every add in the table and the export; the card's selection is the same complete-result pick.
    $("waiver-show-all").dispatch("click");
    assert.equal(mainOf().length, 17);
    assert.equal($("waiver-limit-text").textContent, "Showing all 17 adds by this week's gain, each with every drop option.");
    assert.equal($("waiver-show-all").textContent, "Show top 15"); assert.equal($("waiver-show-all").attrs["aria-pressed"], "true");
    assert.equal($("waiver-best-text").textContent, "Add M Add16 (WR) — +1.40 pts this week. 2 drop options — see the claim table.");
    assert.match($("waiver-table-notes").textContent, /in total, each evaluated against your current roster; showing 17 players and 34 options\. /);
    $("waiver-copy").dispatch("click"); await new Promise(r => setImmediate(r));
    const fullExport = $("waiver-backup").value.split("\n");
    assert.ok(!fullExport.some(l => l.includes("not included")));
    assert.equal(fullExport.filter(l => l.startsWith("ADD ")).length, 34);
    assert.doesNotMatch(text("waiver-radar"), /M Add15/, "now in the table; still not in Worth watching");
    // The toggle survives a re-render (the 15 s tick) for this tab, and toggles back.
    $("waiver-reserve").dispatch("change");
    assert.equal(mainOf().length, 17, "show-all persists across the re-render");
    $("waiver-show-all").dispatch("click");
    assert.equal(mainOf().length, 16); assert.equal($("waiver-show-all").textContent, "Show all 17 adds");
    if (savedNav) Object.defineProperty(globalThis, "navigator", savedNav); else delete globalThis.navigator;
  }
  intelRadar = null;
  // No positive move at all: the card says so plainly and is the only result above the fold-outs.
  engineRows = [];
  await refresh("the desk with no positive move");
  assert.equal($("waiver-best-text").textContent, "No claim recommended this week — no positive modeled lineup swap under the current protections. Do not spend simply because budget remains.");
  assert.equal($("waiver-best-claim").hidden, true);
  assert.equal($("waiver-claims").hidden, true, "no claim table when there is nothing to claim");
  assert.equal($("waiver-table").querySelector("tbody").children.length, 0);
  assert.equal($("waiver-watching").open, false, "Worth watching stays collapsed");
  assert.ok(text("waiver-radar").includes("C Free"), "with no claim rows, every research player is worth watching");
  assert.equal($("waiver-count-detail").textContent, "No positive modeled lineup swaps under the current protections. Do not spend simply because budget remains.");
  engineRows = null;

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
  await until(() => $("waiver-best-text").textContent === WaiverMode.COPY.bestBall && !$("waiver-results").hidden, "the best-ball note", 5000);
  assert.equal($("waiver-claims").hidden, true, "best ball: no claim table, the card carries the note");
  assert.equal($("waiver-count-detail").textContent, WaiverMode.COPY.bestBall);
  assert.equal(analyzeCalls.length, an11, "best ball: the engine is never run");
  assert.ok(text("waiver-context").includes("Best ball — not eligible for the format test"));
  assert.equal($("waiver-table").querySelector("tbody").children.length, 0, "no shortlist");
  assert.ok($("waiver-ros").textContent.includes(AGG));
  assert.ok(text("waiver-radar").includes("preseason ECR 12 (PPR reference ranking)"), "projections/research still render");

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
  assert.match(html, /aria-describedby="reserve-hint[ "]/);
  assert.ok(html.includes('id="reserve-hint"'));
  assert.ok(html.includes("Defaults to 20% of your league budget"));
  assert.ok(html.includes('id="waiver-context"'));

  Date.now = realNow;
  console.log("waivermode_session_fixture: real WaiverMode.init + Session + chip + LeagueData + LiveWorld (anonymous gate, owner flow, identity change, failed/successful refresh, timestamps, statics, rendered labels, reserve default, viewer -> owner, live settings, reverse standings, best ball, unsupported type, page wiring; grouped claim table with every drop option, best move (add only) FAAB/rolling/viewer/empty, data stamp, warnings signpost, protections, position filter, fold state, boilerplate once, worth watching, clipboard copy + fallback) OK");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
