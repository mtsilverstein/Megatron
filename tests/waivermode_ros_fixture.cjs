// tests/waivermode_ros_fixture.cjs — run with: node tests/waivermode_ros_fixture.cjs
//
// astra I1 on the waiver desk: every standalone rest-of-season number (the
// watchlist line and the engine's why-value / tie-break input, board
// `ros_value`) passes the waiver engine's own checks -- the league's season,
// the analysed week, 72 h age and the 1 h future-date tolerance, and the
// player's current team -- or is withheld with its reason while the player
// stays listed. The REAL WaiverMode.init, Session, chip, LeagueData and
// LiveWorld under a fake DOM; the engines are recording stubs (the engine's
// handling of a null ros_value is pinned in waivers_fixture). One controller
// per document, so every scenario is driven through a refresh: the clock
// (stale / future-dated), the live catalog team (changed team) and the league
// settings (normal, best ball, unknown starting slot). Synthetic data only.
const assert = require("node:assert/strict");

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
const main = element("main");
global.document = {
  createElement: element, addEventListener() {}, hidden: false,
  querySelector(selector) { return selector === "main" ? main : null; },
  querySelectorAll() { return []; },
  getElementById(id) { return all(main).find(n => n.id === id) || null; },
};
const withId = (tag, id, parent = main) => { const e = element(tag); e.id = id; parent.append(e); return e; };

global.window = {};
const Session = require("../site/assets/session.js");
require("../site/assets/app.js");
const LD = require("../site/assets/leaguedata.js");
require("../site/assets/liveworld.js");
const LL = require("../site/assets/leaguelens.js");
let routes = {};
const get = p => { const hit = routes[p]; if (hit === undefined) return Promise.reject(new Error(`unrouted ${p}`));
  return Promise.resolve().then(() => typeof hit === "function" ? hit(p) : hit); };
window.Sleeper = { get };
Session._get(get);
const WaiverMode = require("../site/assets/waivermode.js");
const analyzeCalls = [];
window.Waivers = { analyze(args) { analyzeCalls.push(args); return {
  rows: [], warnings: [], recommendationBlock: null, budget: { total: 100, used: 0, remaining: 100, reserve: 20, spendable: 80 },
  waiver: { type: "faab", priority: null, guidance: "g" },
  coverage: { scoringLabel: "fresh weekly projection", weeklyFresh: true, projectedOwnedSkills: 1, activeOwnedSkills: 1, missingOwnedWeekly: [], unmappedOwnedIds: [],
    ros: { fresh: false, reason: "stub" } } }; } };
window.WaiverIntel = { analyze: () => ({ radar: [], fetchedAt: "t", rosStatus: "", warnings: [], roleStatus: "", byeRisks: [], bids: [], freeAgentMoves: 0 }) };

// ---- synthetic batch with a complete remaining-season payload (weeks 3..17) ----
const realNow = Date.now;
const T0 = Date.parse("2026-09-23T12:00:00Z");
let clock = T0 + 60000;
Date.now = () => clock;
const H = 3600000;
const HDR = { season: 2026, week: 3, data_through: "2026-wk2", generated_at: new Date(T0).toISOString(), batch_id: "b-w3" };
const METHOD = { v: 1, model: "transformer", artifacts: ["models/transformer/v1"], ensemble: "mean_of_seed_quantiles",
  band_construction: "sign_coherent_v1", calibration: [], prior: { method: "pooled", rate: 0.09, first_season: 2021, through_season: 2025 } };
const obj = (rec, yds, f) => Object.fromEntries(LL.STATS.map(s => [s, s === "receptions" ? rec * f : s === "receiving_yards" ? yds * f : 0]));
const vec = (rec, yds, f) => LL.STATS.map(s => obj(rec, yds, f)[s]);
// [sleeper id, gsis, position, name, receptions, yards, ecr]; c is the free agent.
const PEOPLE = [["a", "00-0000001", "RB", "A Back", 4, 60, 20], ["b", "00-0000002", "WR", "B Wide", 6, 80, 8], ["c", "00-0000003", "WR", "C Free", 5, 70, 12]];
const WEEKS = Array.from({ length: 15 }, (_, i) => i + 3);
const statics = {
  "data/neutral/weekly.json": { ...HDR, schema_version: 1, kind: "neutral_weekly", model: "transformer", method: METHOD,
    players: PEOPLE.map(([, pid, pos, name, rec, yds]) => ({ player_id: pid, name, team: "X", opponent: "Y", position: pos, is_home: true,
      stat_quantiles: { p10: obj(rec, yds, 0.5), p50: obj(rec, yds, 1), p90: obj(rec, yds, 1.5) }, points: { ppr: null, half_ppr: null, standard: null } })) },
  "data/neutral/remaining.json": { ...HDR, schema_version: 2, kind: "neutral_remaining", horizon: "remaining_season", status: "experimental",
    start_week: 3, end_week: 17, model: "transformer", stat_order: LL.STATS.slice(), method: METHOD, pick_six_forecast: METHOD.prior,
    players: PEOPLE.map(([, pid, pos, name, rec, yds]) => ({ player_id: pid, team: "X", position: pos, name,
      weeks: WEEKS.map(w => ({ week: w, status: "conditional_projection", opponent: "Y", stats: [vec(rec, yds, 0.5), vec(rec, yds, 1), vec(rec, yds, 1.5)] })) })) },
  "data/neutral/players.json": { ...HDR, schema_version: 1, kind: "neutral_players",
    players: PEOPLE.map(([sid, pid, pos, name, , , ecr]) => ({ player_id: pid, sleeper_id: sid, name, team: "X", position: pos, bye: 9, ecr, identity_only: false, reason: null })) },
  "data/neutral/formats.json": { ...require("./fixtures/neutral_formats.json"), ...HDR },
  "data/neutral/evaluation.json": { ...require("./fixtures/neutral_evaluation.json"), ...HDR },
  "data/kickoffs.json": { season: 2026, week: 3, generated_at: HDR.generated_at, teams: ["X", "Y"], games: [] },
};
global.fetch = async p => statics[p] ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(statics[p])) } : { ok: false, status: 404, json: async () => ({}) };

const users = [{ user_id: "u1", display_name: "Max973" }, { user_id: "u2", display_name: "Bo" }];
const rosters = [
  { roster_id: 9, owner_id: "u1", players: ["a", "k"], starters: ["a", "k"], reserve: [], taxi: [], settings: { waiver_position: 4, waiver_budget_used: 0 } },
  { roster_id: 3, owner_id: "u2", players: ["b"], starters: ["b"], reserve: [], taxi: [], settings: { waiver_position: 1, waiver_budget_used: 0 } },
];
const OWNER = require("./fixtures/owner_league_settings.json").gabagool;
const L = "900000000000000889";
const baseLeague = { league_id: L, name: "Synthetic League", season: "2026", status: "in_season", total_rosters: OWNER.total_rosters,
  settings: { type: 0, waiver_type: 2, waiver_budget: 100, best_ball: 0 }, scoring_settings: { ...OWNER.scoring_settings }, roster_positions: OWNER.roster_positions.slice() };
let league = baseLeague;
const catalog = {
  a: { position: "RB", full_name: "A Back", team: "X", gsis_id: "00-0000001" },
  b: { position: "WR", full_name: "B Wide", team: "X", gsis_id: "00-0000002" },
  c: { position: "WR", full_name: "C Free", team: "X", gsis_id: "00-0000003" },
  k: { position: "K", full_name: "Kicker", team: "X" },
};
routes = {
  "/user/max973": { user_id: "u1", username: "max973", display_name: "Max973" },
  [`/league/${L}`]: () => league, [`/league/${L}/users`]: users, [`/league/${L}/rosters`]: () => rosters,
  "/state/nfl": { season: "2026", season_type: "regular", week: 3 }, [`/league/${L}/transactions/3`]: [],
  "/players/nfl": catalog,
  "/players/nfl/trending/add?lookback_hours=24&limit=100": [], "/players/nfl/trending/drop?lookback_hours=24&limit=100": [],
};
const m = new Map();
Session._storage({ getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
  removeItem: k => { m.delete(k); }, key: i => [...m.keys()][i] ?? null, get length() { return m.size; } });
const until = async (pred, what, ms = 4000) => {
  const t0 = realNow();
  while (!pred()) {
    if (realNow() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setImmediate(r));
  }
};

(async () => {
  global.location = new URL(`https://example.test/Megatron/waivers.html?league=${L}`);
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
    ["ul", "waiver-byes"], ["select", "waiver-radar-sort"], ["table", "waiver-radar"], ["p", "waiver-market"], ["ol", "waiver-watchlist"]]) withId(tag, id, results);
  const details = element("details"); results.append(details); withId("textarea", "waiver-backup", details);
  document.getElementById("waiver-position").value = "ALL";
  document.getElementById("waiver-radar-sort").value = "usage";
  for (const t of ["waiver-table", "waiver-radar"]) document.getElementById(t).append(element("tbody"));
  withId("a", "waiver-league-link");
  const $ = id => document.getElementById(id);
  const watch = () => all($("waiver-watchlist")).filter(n => n.tagName === "li").map(n => n.textContent);
  const cLine = () => watch().find(l => l.startsWith("C Free"));

  WaiverMode.init();
  $("session-user").value = "max973";
  all($("session-chip")).find(n => n.tagName === "form").dispatch("submit");
  await until(() => !$("waiver-results").hidden && analyzeCalls.length === 1, "the owner's desk");
  // Control: fresh, current team -> the number shows and reaches the engine.
  const lastBoard = () => analyzeCalls.at(-1).board.players;
  const fresh = lastBoard().find(p => p.sleeper_id === "c");
  assert.ok(Number.isFinite(fresh.ros_value) && fresh.ros_value > 0, "a complete projection has a ros_value");
  assert.equal(fresh.ros_withheld, undefined);
  assert.match(cLine(), new RegExp(`· rest-of-season ${fresh.ros_value.toFixed(2)} \\(sum of weekly medians`));
  const FRESH_VALUE = fresh.ros_value;

  let n = 0;
  async function scenario({ at, team = "X", lg = baseLeague, engine }) {
    clock = at; catalog.c.team = team; catalog.a.team = team; league = lg;
    const runs = analyzeCalls.length;
    $("session-refresh").dispatch("click");
    await until(() => Session.state() === "ready" && !$("waiver-results").hidden && (!engine || analyzeCalls.length > runs) && cLine()
      && Session.bundle().rostersFetchedAt === at, `scenario ${++n}`);
    if (!engine) assert.equal(analyzeCalls.length, runs, "projections-only: the engine is never run");
  }
  const STALE = "remaining-season projections are stale (over 72 hours old)";
  const FUTURE = "remaining-season projections are future-dated or undated";
  const TEAM = "current team Z differs from the projection's X";
  const CASES = [
    ["stale (>72 h)", { at: T0 + 73 * H }, STALE],
    ["future-dated (beyond the 1 h tolerance)", { at: T0 - 2 * H }, FUTURE],
    ["changed team", { at: T0 + 2 * 60000, team: "Z" }, TEAM],
  ];
  // Normal league: the engine's why-value / tie-break input and the watchlist.
  for (const [name, s, reason] of CASES) {
    await scenario({ ...s, engine: true });
    const c = lastBoard().find(p => p.sleeper_id === "c"), a = lastBoard().find(p => p.sleeper_id === "a");
    assert.equal(c.ros_value, null, `${name}: the why-value input is null`);
    assert.equal(c.ros_withheld, reason, name);
    assert.equal(a.ros_value, null, `${name}: an owned player's value is withheld too`);
    assert.equal(c.name, "C Free", "identity kept"); assert.equal(c.player_id, "00-0000003");
    assert.equal(cLine(), `C Free · WR · preseason ECR 12 (PPR reference ranking) · rest-of-season withheld (${reason})`, name);
  }
  // Within the waiver engine's own 1 h future tolerance the value stands.
  await scenario({ at: T0 - 30 * 60000, engine: true });
  assert.equal(lastBoard().find(p => p.sleeper_id === "c").ros_value, FRESH_VALUE, "30 min early is inside the waiver tolerance");
  // Best ball and an unknown starting slot: projections only (watchlist), same checks.
  const modes = [
    ["best ball", { ...baseLeague, settings: { ...baseLeague.settings, best_ball: 1 } }, WaiverMode.COPY.bestBall],
    ["unknown starting slot", { ...baseLeague, roster_positions: ["QB", "XFLEX", "RB", "WR", "BN", "BN"] }, "Unsupported lineup slot: XFLEX — no waiver lineup gains for this league; the projections below still apply."],
  ];
  for (const [mode, lg, note] of modes) {
    await scenario({ at: T0 + 3 * 60000, lg });
    assert.equal($("waiver-count").textContent, note, mode);
    assert.match(cLine(), new RegExp(`· rest-of-season ${FRESH_VALUE.toFixed(2)} \\(`), `${mode}: fresh value shown`);
    for (const [name, s, reason] of CASES) {
      await scenario({ ...s, lg });
      assert.equal($("waiver-count").textContent, note, `${mode} / ${name}`);
      assert.equal(cLine(), `C Free · WR · preseason ECR 12 (PPR reference ranking) · rest-of-season withheld (${reason})`, `${mode} / ${name}`);
      assert.doesNotMatch(watch().join(" | "), /rest-of-season \d/, `${mode} / ${name}: no number survives`);
    }
  }
  Date.now = realNow;
  console.log("waivermode_ros_fixture: watchlist and why-value inputs withheld for stale, future-dated and changed-team data (normal, best ball, unknown slot) OK");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
