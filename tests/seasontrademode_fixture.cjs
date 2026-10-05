// tests/seasontrademode_fixture.cjs — run with: node tests/seasontrademode_fixture.cjs
//
// The in-season trade controller (SeasonTradeMode) and the trade page's mode
// resolution (trade.html's inline script), any-league phase 1 (spec §7.1
// trade, §7.2, §5.2, §5.4, §6.1, §6.2, §8).
//
// Part 1 pins the pure helpers. Part 2 drives the REAL controller through the
// REAL Session, LeagueData (a synthetic neutral batch), LiveWorld and the REAL
// SeasonTrade engine (wrapped to record its calls) under a fake DOM: owner
// flow, no future picks and no traded_picks request, no simulation inputs,
// rendered format line / banner / footnotes / settings stamp / simulation
// note / aggregation label / evidence fallback, live settings recompute,
// viewer flow, best ball, week 18, Review Focus 1. Part 3 runs trade.html's
// inline script: the mode is resolved from the live league before any draft
// data is fetched, and the in-season page never requests draft.json.
// All league data is synthetic (fictional owners and ids).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.window = {};
const Session = require("../site/assets/session.js");
const FC = require("../site/assets/app.js");
const LD = require("../site/assets/leaguedata.js");
require("../site/assets/liveworld.js");
const LL = require("../site/assets/leaguelens.js");
const RealSeasonTrade = require("../site/assets/seasontrade.js");
const M = require("../site/assets/seasontrademode.js");
assert.equal(window.Session, Session); assert.equal(window.LeagueData, LD);

let n = 0; const failed = [];
// FIXTURE_ALL=1 reports every failing group instead of stopping at the first (used to show new cases fail on old code).
function check(name, fn) { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; if (process.env.FIXTURE_ALL) { failed.push(e.message.split("\n")[0]); return; } throw e; } }
async function sub(name, fn) { try { await fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; if (process.env.FIXTURE_ALL) { failed.push(e.message.split("\n")[0]); return; } throw e; } }

const SIM_OFF = "Simulation is off: the 2025-season test failed (on synthetic 15-player rosters), and the per-format 2026 test reports in January 2027.";
const BEST_BALL = "Best-ball scoring picks your top scorers after the games; lineup advice doesn't apply.";
const NO_EVIDENCE = "No measured evaluation for your league's scoring and this model.";
const AGG = "sum of weekly medians through NFL week 17, not a season median";
const HORIZON = "through NFL week 17, regardless of your league's schedule";
const GATE = "Enter your Sleeper username, or choose a team to view.";

// ============================ Part 1: pure helpers ============================
check("parseWeeks accepts ranges and singles inside the horizon", () => {
  assert.deepEqual(M.parseWeeks("3-5, 8", 2, 17), [3, 4, 5, 8]);
  assert.deepEqual(M.parseWeeks(" 9 ", 2, 17), [9]);
  assert.deepEqual(M.parseWeeks("", 2, 17), []);
  assert.deepEqual(M.parseWeeks("5-3", 2, 17), [3, 4, 5], "a reversed range is still a range");
  assert.deepEqual(M.parseWeeks("4,4,4", 2, 17), [4]);
  for (const bad of ["1", "18", "3-19", "abc", "3;4", "2-", "0"]) assert.throws(() => M.parseWeeks(bad, 2, 17), /weeks must look like 3-5, 8 and fall within 2–17/, bad);
});
check("identifyRoster is Session's exact matcher, re-exported unchanged", () => {
  assert.equal(M.identifyRoster, Session.identifyRoster, "one matcher for every page, not a local copy");
  const rosters = [{ roster_id: 1, owner_id: "u1", co_owners: null }, { roster_id: 2, owner_id: "u2", co_owners: ["u3"] }];
  assert.equal(M.identifyRoster(rosters, "u1").roster_id, 1);
  assert.equal(M.identifyRoster(rosters, "u3").roster_id, 2);
  assert.throws(() => M.identifyRoster(rosters, "u9"), /Could not uniquely match this account to a roster in this league\./);
});
check("capacity (IDP slots count, IR/TAXI do not), active skill players and needed drops", () => {
  const league = { roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "IR", "TAXI"] };
  assert.equal(M.capacityOf(league), 15);
  assert.equal(M.capacityOf({ roster_positions: ["QB", "WRRB_FLEX", "REC_FLEX", "LB", "DL", "DB", "IDP_FLEX", "BN", "IR"] }), 8);
  const catalog = { a: { position: "RB" }, b: { position: "K" }, c: { position: "WR" }, d: { position: "DEF" }, e: { position: "TE" }, f: { position: "LB" } };
  assert.deepEqual(M.activeSkill({ players: ["a", "b", "c", "d", "e", "f"], reserve: ["e"], taxi: [] }, catalog), ["a", "c"]);
  assert.equal(M.neededDrops({ activeCount: 15, giveCount: 1, receiveCount: 2, capacity: 15 }), 1);
  assert.equal(M.neededDrops({ activeCount: 14, giveCount: 1, receiveCount: 2, capacity: 15 }), 0);
});
check("fmtDelta uses a leading sign and a real minus", () => {
  assert.equal(M.fmtDelta(12.4), "+12.40"); assert.equal(M.fmtDelta(-3.1), "−3.10"); assert.equal(M.fmtDelta(0), "0.00");
});
const result = {
  weeks: [{ week: 3, sides: [{ rosterId: 1, before: { total: 100 }, after: { total: 106 }, delta: 6 }, { rosterId: 2, before: { total: 90 }, after: { total: 82 }, delta: -8 }] },
          { week: 4, sides: [{ rosterId: 1, before: { total: 100 }, after: { total: 106 }, delta: 6 }, { rosterId: 2, before: { total: 90 }, after: { total: 82 }, delta: -8 }] }],
  sides: [{ rosterId: 1, delta: 12 }, { rosterId: 2, delta: -16 }],
  warnings: ["All non-excluded active players are assumed available, including reported injuries; availability is not predicted."],
};
const ctx = { names: { 1: "Me", 2: "Them" }, currentWeek: 2, firstWeek: 3, endWeek: 17, excludeWeeks: { p9: [3, 4] }, playerNames: { p9: "A.J. Brown" }, drops: { 2: ["p7"] }, playerNamesAll: { p7: "Bench Guy" } };
check("scenarioText: headline, subline, sides and assumptions; no future-pick line (§8.8)", () => {
  const t = M.scenarioText(result, ctx);
  assert.equal(t.headline, "Conditional lineup scenario — not a trade verdict.");
  assert.equal(t.subline, "Sum of weekly central (p50) lineup scenarios for weeks 3–17; week 2 is excluded because trades may process after games start. Keeper value and draft picks are not valued, so no overall grade is shown.");
  assert.deepEqual(t.sides, [{ name: "Me", before: "200.00", after: "212.00", delta: "+12.00" }, { name: "Them", before: "180.00", after: "164.00", delta: "−16.00" }]);
  assert.ok(!("notValued" in t), "no picks are offered, so no 'Not valued: picks' line");
  assert.deepEqual(t.assumptions, ["A.J. Brown assumed unavailable weeks 3, 4 (your assumption, not a return-date prediction)", "Them drops Bench Guy"]);
});
check("no forbidden word leaves the text builders outside the two allowed sentences", () => {
  const t = M.scenarioText(result, ctx);
  const c = M.coverageText(Object.assign(new Error("Projection coverage blocked: 1 players, 2 player-weeks."), { name: "ProjectionCoverageError", coverageIssues: [{ id: "x", name: "X", week: 3, reason: "unknown is not zero (no_observed_history)" }, { id: "x", name: "X", week: 4, reason: "unknown is not zero (no_observed_history)" }] }));
  const all = [t.subline, ...t.sides.flatMap(s => Object.values(s)), ...t.assumptions, c.headline, ...c.rows, ...M.contextLines({ format: { text: "Format: not in the format test" }, view: { disclosures: { banner: null, footnotes: [] } } })];
  const scrubbed = all.map(s => M.ALLOWED_SENTENCES.reduce((x, a) => x.split(a).join(""), s)).join("\n").toLowerCase();
  for (const w of M.FORBIDDEN) assert.ok(!scrubbed.includes(w), `forbidden word "${w}" in: ${scrubbed}`);
  assert.equal(c.headline, "Comparison blocked: 1 player(s), 2 player-week(s) without a projection");
  const other = M.coverageText(new Error("Unsupported roster slots"));
  assert.equal(other.headline, "Comparison blocked"); assert.deepEqual(other.rows, ["Unsupported roster slots"]);
});
const P = (id, name, slot) => ({ id, name, slot, points: 0, status: "conditional_projection" });
const BASE0 = [P("h", "Justin Herbert", "QB"), P("r1", "Bijan Robinson", "RB"), P("w1", "Chris Olave", "WR")];
const BASE1 = [P("d", "Dak Prescott", "QB"), P("r2", "Jaylen Warren", "RB"), P("w2", "Jalen Coker", "WR")];
const swap = (lineup, outId, inP) => lineup.map(p => (p.id === outId ? inP : p));
const KYLER = P("k", "Kyler Murray", "QB"), HERBERT = P("h", "Justin Herbert", "QB");
function mkResult(changes, first = 4, last = 17) {
  const weeks = [];
  for (let w = first; w <= last; w++) {
    const c = changes[w] || [null, null];
    const sides = [BASE0, BASE1].map((base, i) => {
      const ch = c[i];
      return { rosterId: i + 1, before: { total: 100, lineup: base }, after: { total: 100 + (ch ? ch.delta : 0), lineup: ch ? ch.after : base }, delta: ch ? ch.delta : 0 };
    });
    weeks.push({ week: w, sides });
  }
  return { weeks, sides: [0, 1].map(i => ({ rosterId: i + 1, delta: weeks.reduce((s, wk) => s + wk.sides[i].delta, 0) })) };
}
const sumCtx = { names: { 1: "Bake God", 2: "Easy Breecey" }, firstWeek: 4, endWeek: 17 };
const herbertForKyler = mkResult({
  5: [null, { after: swap(BASE1, "d", HERBERT), delta: 7.87 }],
  8: [{ after: swap(BASE0, "h", KYLER), delta: -6.06 }, null],
});
check("lineupSummary: a one-week change on each side names who enters and leaves", () => {
  assert.deepEqual(M.lineupSummary(herbertForKyler, sumCtx), [
    "Your lineup: −6.1 pts over weeks 4–17. All of it is week 8: Kyler Murray starts instead of Justin Herbert.",
    "Easy Breecey: +7.9 pts over weeks 4–17. All of it is week 5: Justin Herbert starts instead of Dak Prescott.",
  ]);
});
check("lineupSummary: a viewer's side is named by its team, never 'Your lineup'", () => {
  const lines = M.lineupSummary(herbertForKyler, { ...sumCtx, ownLabel: "Bake God" });
  assert.equal(lines[0], "Bake God: −6.1 pts over weeks 4–17. All of it is week 8: Kyler Murray starts instead of Justin Herbert.");
  assert.ok(!lines.join(" ").includes("Your lineup"));
});
check("lineupSummary: many changed weeks -> the 3 largest named, the rest summarised; nothing changes -> one sentence", () => {
  const manyWeeks = mkResult({
    5: [{ after: swap(BASE0, "h", KYLER), delta: 1.0 }, null], 6: [{ after: swap(BASE0, "h", KYLER), delta: 4.0 }, null],
    7: [{ after: swap(swap(BASE0, "h", KYLER), "w1", P("w9", "Rome Odunze", "WR")), delta: -3.5 }, null],
    9: [{ after: swap(BASE0, "h", KYLER), delta: 5.0 }, null], 10: [{ after: swap(BASE0, "h", KYLER), delta: 0.5 }, null], 11: [{ after: swap(BASE0, "h", KYLER), delta: 2.0 }, null],
  });
  assert.equal(M.lineupSummary(manyWeeks, sumCtx)[0], "Your lineup: +9.0 pts over weeks 4–17. Lineup changes in 6 weeks; the 3 largest: week 9 (+5.0): Kyler Murray starts instead of Justin Herbert; week 6 (+4.0): Kyler Murray starts instead of Justin Herbert; week 7 (−3.5): Kyler Murray and Rome Odunze start instead of Justin Herbert and Chris Olave; and smaller changes in 3 other weeks (+3.5 pts combined).");
  assert.deepEqual(M.lineupSummary(mkResult({}), sumCtx), ["No change to either starting lineup in weeks 4–17 under these assumptions."]);
});
check("the v1 simulation gate is gone (spec §6.2): no evalView/gateOpen; the measured-method helpers stay pure", () => {
  assert.equal(M.evalView, undefined); assert.equal(M.gateOpen, undefined);
  for (const f of ["gradeLabel", "pickHorizon", "stratumOf", "lopsidedMeasure", "errorFor", "gradeText", "marketText", "startCounts"]) assert.equal(typeof M[f], "function", f);
  assert.equal(M.gradeLabel(6, 6), "Small gain");
  assert.equal(M.lopsidedMeasure([{ delta: 6 }, { delta: -60 }]), 60);
  assert.deepEqual(M.stratumOf({ positions: ["WR", "WR"], sides: [{ give: [1], receive: [1] }, { give: [1], receive: [1] }] }, 31, { strata: {}, lopsided_cutoff: 30 }), ["same_position", "lopsided"]);
  assert.equal(M.pickHorizon([{ weeks: 13, strata: { same_position: { E: 1 } } }, { weeks: 9, strata: { same_position: { E: 1 } } }], 11).weeks, 9);
  assert.equal(M.errorFor(["same_position"], { strata: { same_position: { E: 5.5 } } }), 5.5);
});
check("COPY strings are the plan's exact copy", () => {
  assert.equal(M.COPY.simulationOff, SIM_OFF);
  assert.equal(M.COPY.bestBall, BEST_BALL);
  assert.equal(M.COPY.noEvidence, NO_EVIDENCE);
  assert.equal(M.COPY.aggregation, AGG);
  assert.equal(M.COPY.horizon, HORIZON);
});
check("contextLines: format line, banner, footnotes, the aggregation label and the simulation note, in that order", () => {
  const view = { disclosures: { banner: "Your league also scores first downs, which these projections leave out; rankings may be off for your league.", footnotes: ["Pick-sixes use an average rate, not a forecast.", "Not projected: pass_2pt (rare events)."] } };
  assert.deepEqual(M.contextLines({ format: { text: "Format: not in the format test" }, view }), [
    "Format: not in the format test", view.disclosures.banner, ...view.disclosures.footnotes,
    `Lineup totals. Horizon: ${HORIZON}. Totals: ${AGG}.`, SIM_OFF]);
  assert.deepEqual(M.contextLines({ format: { text: "Best ball — not eligible for the format test" }, view: { disclosures: { banner: null, footnotes: [] } } }),
    ["Best ball — not eligible for the format test", `Lineup totals. Horizon: ${HORIZON}. Totals: ${AGG}.`, SIM_OFF]);
});
const EVAL_DOC = require("./fixtures/neutral_evaluation.json");
check("evidenceLines: the fallback unless a rest-of-season record binds to the live lens and the current method", () => {
  const lens = LL.classify({ rec: 1 });
  assert.deepEqual(M.evidenceLines(null, { lens, method: null }), [`Rest-of-season accuracy: ${NO_EVIDENCE}`]);
  assert.deepEqual(M.evidenceLines(EVAL_DOC, { lens, method: null }), [`Rest-of-season accuracy: ${NO_EVIDENCE}`], "a null method never binds");
  const rec = EVAL_DOC.records.find(r => r.metric === "rest_of_season_points_mae");
  assert.ok(rec, "the fixture carries a rest-of-season record");
  const method = { v: 1, model: "transformer", artifacts: ["models/transformer/v1"], ensemble: "mean_of_seed_quantiles", band_construction: "sign_coherent_v1",
    calibration: [], prior: { method: "pooled", rate: 0.09, first_season: 2021, through_season: 2025 } };
  const bound = { records: [{ ...rec, method, effective_scoring: LL.evidenceIdentity(lens.weights), prediction_scoring: LL.evidenceIdentity(lens.weights) }] };
  const lines = M.evidenceLines(bound, { lens, method });
  assert.equal(lines[0], "Rest-of-season accuracy, measured under this league's scoring and this model:");
  assert.ok(lines.length > 1 && lines.slice(1).every(l => /weeks? ahead: model MAE/.test(l)), lines.join(" | "));
  assert.deepEqual(M.evidenceLines(bound, { lens: LL.classify({ rec: 0.5 }), method }), [`Rest-of-season accuracy: ${NO_EVIDENCE}`], "other scoring: fallback");
  assert.deepEqual(M.evidenceLines(bound, { lens, method: { ...method, model: "xgboost" } }), [`Rest-of-season accuracy: ${NO_EVIDENCE}`], "other method: fallback");
});
check("rosValueLines: each active skill player's rest-of-season value with the aggregation label; unknown is not zero", () => {
  const board = { players: [{ sleeper_id: "a", name: "A Back", position: "RB", ros_value: 41.25 }, { sleeper_id: "b", name: "B Wide", position: "WR", ros_value: null }] };
  const catalog = { a: { full_name: "A Back", position: "RB" }, b: { full_name: "B Wide", position: "WR" }, x: { full_name: "X Only", position: "TE" }, k: { full_name: "Kicker", position: "K" }, r: { full_name: "Res", position: "RB" } };
  assert.deepEqual(M.rosValueLines(board, { players: ["a", "b", "x", "k", "r"], reserve: ["r"] }, catalog), [
    `Rest-of-season values. Horizon: ${HORIZON}. Totals: ${AGG}.`,
    "A Back · RB · 41.25", "B Wide · WR · no rest-of-season projection", "X Only · TE · no rest-of-season projection"]);
});
check("sources: no traded_picks, future picks, gate file or simulation in the controller; trade.html loads the kernel and the adapter", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "site", "assets", "seasontrademode.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "site", "trade.html"), "utf8");
  for (const re of [/traded_picks/, /pickOwnership/, /DRAFT_ROUNDS/, /defaultPicks/, /trade_sim_eval/, /availability\.json/, /\.simulate\(/, /stratumInputs\(/, /picksUnknown/, /\/user\//, /\/players\/nfl/, /leagueDataPath/])
    assert.ok(!re.test(src), `seasontrademode.js must not contain ${re}`);
  const srcs = [...html.matchAll(/<script\b[^>]*src="assets\/([^"?]+)(?:\?[^"]*)?"/g)].map(x => x[1]);
  const ORDER = ["formats.js", "lineup.js", "leaguelens.js", "leaguedata.js", "liveworld.js", "seasontrade.js", "seasontrademode.js"];
  for (const f of ORDER) assert.equal(srcs.filter(s => s === f).length, 1, `trade.html: exactly one ${f}`);
  const at = ORDER.map(f => srcs.indexOf(f));
  assert.deepEqual([...at].sort((a, b) => a - b), at, `trade.html: ${ORDER.join(" -> ")} in order`);
  assert.ok(srcs.indexOf("ros.js") < srcs.indexOf("seasontrade.js") && srcs.indexOf("rostersim.js") < srcs.indexOf("seasontrade.js"), "the frozen method's modules still load before the engine");
  assert.ok(!srcs.includes("waiverintel.js"), "the ROS market check left with the grade");
  assert.ok(/seasontrademode\.js\?v=neutral1/.test(html) && /seasontrade\.js\?v=neutral1/.test(html), "cache keys bumped");
  assert.ok(/id="season-context"/.test(html), "the context lines have a home on the page");
});

// ============================ Part 2: the controller ============================
const all = node => [node, ...(node.children || []).flatMap(all)];
const text = node => all(node).map(x => x.textContent || "").filter(Boolean).join("\n");
function element(tagName) {
  const el = {
    tagName, children: [], listeners: {}, attrs: {}, parent: null, parentElement: null, dataset: {},
    textContent: "", className: "", id: "", value: "", href: "", type: "", placeholder: "",
    hidden: false, checked: false, disabled: false, open: false,
    classList: { toggle() {} },
    append(...nodes) { for (const x of nodes) if (x && typeof x === "object") { x.parent = el; x.parentElement = el; el.children.push(x); } },
    appendChild(x) { el.append(x); return x; },
    prepend(...nodes) { for (const x of nodes) { x.parent = el; x.parentElement = el; } el.children.unshift(...nodes); },
    replaceChildren(...nodes) { el.children = []; el.append(...nodes); },
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    dispatch(type) { for (const fn of el.listeners[type] || []) fn({ preventDefault() {}, target: el }); },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return k === "href" ? el.href : el.attrs[k]; },
    focus() {},
    querySelector(sel) { return all(el).slice(1).find(x => x.tagName === sel) || null; },
    querySelectorAll(sel) { return all(el).slice(1).filter(x => x.tagName === sel); },
  };
  return el;
}
// trade.html's in-season ids; each column <ul> sits in a div with its <h2>.
function tradeDom(href) {
  const main = element("main"), stamp = element("p");
  stamp.className = "stamp";
  const NAV = [["index.html", "Draft board"], ["trade.html", "Trade calculator"], ["weekly.html", "Weekly"], ["about.html", "About the model"], ["waivers.html", "FAAB & waivers"]];
  const navLinks = NAV.map(([h, t]) => { const a = element("a"); a.href = h; a.textContent = t; return a; });
  global.location = new URL(href);
  global.document = {
    createElement: element, createTextNode: t => Object.assign(element("#text"), { textContent: String(t) }), addEventListener() {},
    querySelector(sel) { return sel === "main" ? main : sel === ".stamp" ? stamp : null; },
    querySelectorAll(sel) { return sel === ".masthead nav a" ? navLinks : []; },
    getElementById(id) { return all(main).find(x => x.id === id) || null; },
  };
  const html = fs.readFileSync(path.join(__dirname, "..", "site", "trade.html"), "utf8");
  const body = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
  for (const m of body.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"([^>]*)>/g)) {
    const [, tag, id] = m;
    const x = element(tag); x.id = id; x.hidden = /\bhidden\b/.test(m[0]);
    if (["season-mine", "season-theirs", "trade-mine", "trade-theirs"].includes(id)) {
      const col = element("div"); col.append(element("h2"), x); main.append(col);
    } else main.append(x);
  }
  return { main, stamp, navLinks, $: id => document.getElementById(id) };
}
const els$ = $ => ({ eyebrow: $("season-eyebrow"), status: $("season-status"), controls: $("season-controls"), partner: $("season-partner"),
  compare: $("season-compare"), warn: $("season-warn"), cols: $("season-cols"), mine: $("season-mine"), theirs: $("season-theirs"),
  mineDrops: $("season-mine-drops"), theirsDrops: $("season-theirs-drops"), result: $("season-result"), provenance: $("season-provenance"),
  context: $("season-context") });

// ---- the engine, recorded; simulation calls are counted (must stay 0) ----
const analyzeCalls = [], analyzeErrors = [];
let simCalls = 0;
window.SeasonTrade = {
  analyze(args) { analyzeCalls.push(args); try { return RealSeasonTrade.analyze(args); } catch (e) { analyzeErrors.push(e); throw e; } },
  simulate() { simCalls++; throw new Error("simulation is off"); },
  stratumInputs() { simCalls++; throw new Error("simulation is off"); },
};
window.TradeMode = { calls: [], init(opts) { this.calls.push(opts); } };

// ---- Sleeper and statics, both logged ----
const events = [], calls = [], fetched = [];
let routes = {};
function get(p) {
  calls.push(p); events.push(`sleeper ${p}`);
  const hit = routes[p];
  if (hit === undefined) return Promise.reject(new Error(`unrouted ${p}`));
  if (hit instanceof Error) return Promise.reject(hit);
  if (typeof hit === "function") return Promise.resolve().then(() => hit(p));
  return Promise.resolve(JSON.parse(JSON.stringify(hit)));
}
window.Sleeper = { get };
Session._get(get);
let statics = {};
global.fetch = async p => {
  fetched.push(p); events.push(`fetch ${p}`);
  const doc = statics[p];
  return doc ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(doc)) } : { ok: false, status: 404, json: async () => ({}) };
};
const STATS = LL.STATS;
const METHOD = { v: 1, model: "transformer", artifacts: ["models/transformer/v1"], ensemble: "mean_of_seed_quantiles",
  band_construction: "sign_coherent_v1", calibration: [], prior: { method: "pooled", rate: 0.09, first_season: 2021, through_season: 2025 } };
// [sleeper id, gsis, position, name, receptions, receiving yards]
const PEOPLE = [["a", "00-0000001", "RB", "A Back", 4, 60], ["d", "00-0000004", "WR", "D Deep", 2, 30], ["e", "00-0000005", "WR", "E Slot", 1, 20],
  ["b", "00-0000002", "WR", "B Wide", 6, 80], ["c", "00-0000003", "RB", "C Run", 3, 40], ["f", "00-0000006", "RB", "F Flex", 2, 10]];
const sqOf = (rec, yds) => { const o = f => Object.fromEntries(STATS.map(s => [s, s === "receptions" ? rec * f : s === "receiving_yards" ? yds * f : 0])); return { p10: o(0.5), p50: o(1), p90: o(1.5) }; };
const vecOf = (rec, yds, f) => STATS.map(s => s === "receptions" ? rec * f : s === "receiving_yards" ? yds * f : 0);
function makeStatics({ week = 3, noWeeks = false, lastWeek = 6 } = {}) {
  const HDR = { season: 2026, week, data_through: `2026-wk${week - 1}`, generated_at: new Date().toISOString(), batch_id: `b-w${week}` };
  const weeks = [];
  for (let w = week; w <= lastWeek; w++) weeks.push(w);
  return {
    "data/neutral/weekly.json": { ...HDR, schema_version: 1, kind: "neutral_weekly", model: "transformer", method: METHOD,
      players: PEOPLE.map(([sid, pid, pos, name, rec, yds]) => ({ player_id: pid, name, team: "X", opponent: "Y", position: pos, is_home: true, stat_quantiles: sqOf(rec, yds), points: { ppr: null, half_ppr: null, standard: null } })) },
    "data/neutral/remaining.json": noWeeks
      ? { ...HDR, schema_version: 2, kind: "neutral_remaining", horizon: "remaining_season", status: "no_remaining_weeks", start_week: week, end_week: 17, model: "transformer", stat_order: STATS.slice(), players: [] }
      : { ...HDR, schema_version: 2, kind: "neutral_remaining", horizon: "remaining_season", status: "experimental", start_week: week, end_week: lastWeek, model: "transformer",
          stat_order: STATS.slice(), method: METHOD, pick_six_forecast: METHOD.prior,
          players: PEOPLE.map(([sid, pid, pos, name, rec, yds]) => ({ player_id: pid, team: "X", position: pos, name,
            weeks: weeks.map(w => sid === "b" && w === 5 ? { week: w, status: "bye", points: null } : { week: w, status: "conditional_projection", opponent: "Y", stats: [vecOf(rec, yds, 0.5), vecOf(rec, yds, 1), vecOf(rec, yds, 1.5)] }) })) },
    "data/neutral/players.json": { ...HDR, schema_version: 1, kind: "neutral_players",
      players: PEOPLE.map(([sid, pid, pos, name]) => ({ player_id: pid, sleeper_id: sid, name, team: "X", position: pos, bye: sid === "b" ? 5 : 9, ecr: null, identity_only: false, reason: null })) },
    "data/neutral/formats.json": { ...require("./fixtures/neutral_formats.json"), ...HDR },
    "data/neutral/evaluation.json": { ...require("./fixtures/neutral_evaluation.json"), ...HDR },
  };
}
const OWNER = require("./fixtures/owner_league_settings.json").gabagool;
const L = "900000000000000777";                          // not in the registry
const users = [{ user_id: "u1", display_name: "Max973" }, { user_id: "u2", display_name: "Bo", metadata: { team_name: "Bo's Bunch" } }];
const rosters = [
  { roster_id: 9, owner_id: "u1", players: ["a", "d", "e", "k"], starters: ["a", "d", "e", "k"], reserve: [], taxi: [] },
  { roster_id: 3, owner_id: "u2", players: ["b", "c", "f"], starters: ["b", "c", "f"], reserve: [], taxi: [] },
];
const baseLeague = { league_id: L, name: "Synthetic Trade League", season: "2026", status: "in_season", total_rosters: 2,
  settings: { type: 0, best_ball: 0, trade_deadline: 11 }, scoring_settings: { ...OWNER.scoring_settings }, roster_positions: ["RB", "WR", "FLEX", "K", "BN", "BN"] };
const baseCatalog = () => ({
  ...Object.fromEntries(PEOPLE.map(([sid, pid, pos, name]) => [sid, { position: pos, full_name: name, team: "X", gsis_id: pid }])),
  k: { position: "K", full_name: "Kicker", team: "X" },
});
let league = baseLeague;
let state = { season: "2026", season_type: "regular", week: 3 };
let catalog = baseCatalog();
function leagueRoutes(id, lg) {
  return { [`/league/${id}`]: () => lg(), [`/league/${id}/users`]: users, [`/league/${id}/rosters`]: () => rosters.map(r => ({ ...r })) };
}
function baseRoutes() {
  return {
    "/user/max973": { user_id: "u1", username: "max973", display_name: "Max973" },
    ...leagueRoutes(L, () => league), "/state/nfl": () => state, "/players/nfl": () => catalog,
  };
}
function fresh(storage = new Map()) {
  Session._storage({ getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: k => { storage.delete(k); }, key: i => [...storage.keys()][i] ?? null, get length() { return storage.size; } });
  M._reset();
  analyzeCalls.length = 0; analyzeErrors.length = 0; calls.length = 0; fetched.length = 0; events.length = 0; window.TradeMode.calls.length = 0;
}
const until = async (pred, what, ms = 4000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setImmediate(r));
  }
};
const tickPlayer = (ul, id) => { const li = ul.children.find(x => x.dataset.id === id); const box = li.children[0].children[0]; box.checked = true; box.dispatch("change"); };
const clickCompare = async (els, pred, what) => { els.compare.dispatch("click"); await until(pred, what); };
const NEUTRAL = ["data/neutral/evaluation.json", "data/neutral/formats.json", "data/neutral/players.json", "data/neutral/remaining.json", "data/neutral/weekly.json"];
const lensP50 = (sid, lg) => { const p = PEOPLE.find(x => x[0] === sid); return LL.score(sqOf(p[4], p[5]), p[2], LL.classify(lg.scoring_settings).weights).p50; };

async function ownerFlow() {
  fresh(); statics = makeStatics(); routes = baseRoutes(); league = baseLeague; state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els });
  FC.setLeague(L);
  await until(() => els.status.textContent === GATE, "the anonymous gate");
  assert.equal(els.cols.hidden, true); assert.equal(els.controls.hidden, true);

  await Session.identify("max973");
  await until(() => /teams loaded/.test(els.status.textContent), "the owner's columns");
  assert.equal(els.status.textContent, "2 teams loaded — you are Max973");
  assert.equal(els.cols.hidden, false); assert.equal(els.controls.hidden, false);
  await sub("statics are the neutral batch only: no draft, legacy remaining, gate or simulation file; no traded_picks request", async () => {
    assert.deepEqual([...new Set(fetched)].sort(), NEUTRAL);
    assert.ok(!calls.some(c => /traded_picks/.test(c)), calls.join(", "));
  });
  await sub("no pick rows on either side (§8.8); K is listed as not modeled", async () => {
    for (const ul of [els.mine, els.theirs]) {
      assert.ok(!ul.children.some(li => /season-pick/.test(li.className)), "no pick rows");
      assert.ok(!/picks|R1|R2|unknown ownership/.test(text(ul)), text(ul));
    }
    const k = els.mine.children.find(li => li.dataset.id === "k");
    assert.ok(k && /season-disabled/.test(k.className) && /no modeled points/.test(text(k)));
    assert.match(els.mine.parent.children[0].textContent, /^You give — Max973$/);
    assert.match(els.theirs.parent.children[0].textContent, /^You get — Bo's Bunch$/);
  });
  await sub("rendered context: format line, footnotes, aggregation label, simulation note; evidence fallback; settings stamp", async () => {
    const view = LD.views(LD_BATCH(), league, { week: 3, catalog });
    const format = await LD.formatLine(league, statics["data/neutral/formats.json"].formats);
    const ctxText = els.context.children.map(x => x.textContent);
    assert.deepEqual(ctxText, M.contextLines({ format, view }));
    for (const s of [format.text, ...view.disclosures.footnotes, `Lineup totals. Horizon: ${HORIZON}. Totals: ${AGG}.`, SIM_OFF]) assert.ok(ctxText.includes(s), s);
    assert.equal(els.context.hidden, false);
    assert.equal(els.warn.textContent, NO_EVIDENCE); assert.equal(els.warn.hidden, false);
    assert.match(els.provenance.textContent, /League settings read /);
    assert.match(els.provenance.textContent, /Trade deadline: week 11 \(league setting\)\./);
    assert.match(els.eyebrow.textContent, /^Synthetic Trade League · 2026 week 3 · conditional lineup scenario$/);
  });

  // Compare: give D Deep (WR), get B Wide (WR).
  tickPlayer(els.mine, "d"); tickPlayer(els.theirs, "b");
  assert.equal(els.compare.disabled, false);
  await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 1, "the first comparison");
  const b1 = Session.bundle(), c1 = analyzeCalls[0];
  await sub("analyze reads the refreshed bundle's league and rosters and the league views (no published contract)", async () => {
    assert.equal(c1.league, b1.league, "league from the committed bundle, not a closure copy");
    assert.equal(c1.rosters, b1.rosters);
    assert.equal(c1.snapshotAt, b1.rostersFetchedAt, "the 60 s roster snapshot is the refreshed bundle's post-fetch time");
    assert.deepEqual(c1.rosterIds, [9, 3]); assert.deepEqual(c1.give, ["d"]); assert.deepEqual(c1.receive, ["b"]);
    assert.ok(!("league" in c1.remaining) && !("league" in c1.board), "views carry no league contract");
    assert.deepEqual(c1.board.players.map(p => p.sleeper_id).sort(), ["a", "b", "c", "d", "e", "f"]);
    const row = c1.remaining.players.find(p => p.player_id === "00-0000004").weeks.find(w => w.week === 4);
    assert.equal(row.points.league.p50, lensP50("d", league), "points.league = the live league's scoring");
    assert.equal(c1.currentWeek, 3); assert.equal(c1.assumeAvailable, true);
    assert.equal(simCalls, 0, "no simulation call");
  });
  await sub("rendered result: summary first, no grade panel, evaluation fallback; never the old pick line", async () => {
    assert.equal(els.result.children[0].className, "season-summary");
    assert.ok(!els.result.children.some(x => x.className === "season-grade"));
    const details = els.result.children.filter(x => x.tagName === "details");
    assert.deepEqual(details.map(d => d.children[0].textContent), ["Week-by-week lineup totals", "Assumptions", "Engine notes", "Measured evaluation"]);
    assert.equal(text(details[3]).split("\n").slice(1).join("\n"), `Rest-of-season accuracy: ${NO_EVIDENCE}`);
    assert.ok(!/Not valued: picks/.test(text(els.result)));
    assert.equal(els.status.textContent, "lineups compared for weeks 4–6");
  });

  await sub("a live settings change recomputes the views, the context and the next comparison (spec §5.2)", async () => {
    league = { ...baseLeague, scoring_settings: { ...baseLeague.scoring_settings, rec: 0.5, bonus_fd_wr: 0.5 } };
    await Session.refresh({ scope: "league" });
    await until(() => /teams loaded/.test(els.status.textContent) && els.context.children.length > 0, "the recomputed load");
    const ctxText = els.context.children.map(x => x.textContent);
    assert.ok(ctxText.some(l => /^Your league also scores .*, which these projections leave out; rankings may be off for your league\.$/.test(l)), ctxText.join(" | "));
    tickPlayer(els.mine, "d"); tickPlayer(els.theirs, "b");
    await clickCompare(els, () => analyzeCalls.length === 2 && !els.result.hidden, "the comparison under the new scoring");
    const c2 = analyzeCalls[1];
    assert.equal(c2.league, Session.bundle().league);
    assert.equal(c2.league.scoring_settings.rec, 0.5);
    assert.equal(c2.remaining.players.find(p => p.player_id === "00-0000004").weeks.find(w => w.week === 4).points.league.p50, lensP50("d", league));
    assert.notEqual(c2.remaining, c1.remaining);
  });
  await sub("a settings change arriving with a comparison's own refresh supersedes it: no stale analyze, then the new scoring", async () => {
    tickPlayer(els.mine, "d"); tickPlayer(els.theirs, "b");
    const before = analyzeCalls.length;
    league = { ...baseLeague, scoring_settings: { ...baseLeague.scoring_settings, rec: 0.25 } };
    els.compare.dispatch("click");
    await until(() => Session.bundle().league.scoring_settings.rec === 0.25 && /teams loaded/.test(els.status.textContent), "the reload under the changed settings");
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
    assert.equal(analyzeCalls.length, before, "the comparison started under the old scoring never ran");
    assert.equal(els.result.hidden, true);
    tickPlayer(els.mine, "d"); tickPlayer(els.theirs, "b");
    await clickCompare(els, () => analyzeCalls.length === before + 1 && !els.result.hidden, "the comparison after the reload");
    assert.equal(analyzeCalls.at(-1).league.scoring_settings.rec, 0.25);
  });
  await sub("a refresh that moves only waiver bookkeeping (daily_waivers_last_ran, leg) keeps the comparison and selections", async () => {
    tickPlayer(els.mine, "d"); tickPlayer(els.theirs, "b");
    const before = analyzeCalls.length;
    league = { ...league, settings: { ...league.settings, daily_waivers_last_ran: 7, leg: 99 } };
    els.compare.dispatch("click");
    await until(() => analyzeCalls.length === before + 1 && !els.result.hidden, "the comparison across the bookkeeping change");
    assert.equal(analyzeCalls.at(-1).league.settings.leg, 99, "it analysed the refreshed league");
    assert.ok(!els.result.hidden, "the result stands");
  });
}

// A tiny stand-in for the batch the controller loaded (same statics), for computing expectations.
const LD_BATCH = () => {
  const d = name => JSON.parse(JSON.stringify(statics[`data/neutral/${name}.json`]));
  return { weekly: d("weekly"), remaining: d("remaining"), players: d("players"), evaluation: d("evaluation"), formats: d("formats").formats };
};

async function reviewFocus1() {
  fresh(); statics = makeStatics(); routes = baseRoutes(); league = baseLeague; state = { season: "2026", season_type: "regular", week: 3 };
  catalog = baseCatalog(); catalog.d = { ...catalog.d, team: "Z" };     // traded after the batch
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("max973");
  await until(() => /teams loaded/.test(els.status.textContent), "the owner's columns");
  tickPlayer(els.mine, "a"); tickPlayer(els.theirs, "c");
  await clickCompare(els, () => !els.result.hidden && analyzeErrors.length === 1, "the blocked comparison");
  assert.equal(els.status.textContent, "comparison blocked");
  assert.match(text(els.result.children[0]), /^Comparison blocked: 1 player\(s\), 3 player-week\(s\) without a projection$/);
  assert.ok(text(els.result).includes("D Deep · week 4 · Missing projection or current-team mismatch: D Deep"));
  assert.ok(/Nothing was scored/.test(text(els.result)), "never scored for his old team");
}

async function viewerFlow() {
  fresh(); statics = makeStatics(); routes = baseRoutes(); league = baseLeague; state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await until(() => els.status.textContent === GATE, "the anonymous gate");
  Session.view(3);
  await until(() => /teams loaded/.test(els.status.textContent), "the viewed team's columns");
  assert.equal(els.status.textContent, "2 teams loaded — Viewing Bo's Bunch");
  assert.equal(els.mine.parent.children[0].textContent, "Bo's Bunch gives");
  assert.equal(els.theirs.parent.children[0].textContent, "Bo's Bunch gets — from Max973");
  tickPlayer(els.mine, "b"); tickPlayer(els.theirs, "d");
  await clickCompare(els, () => analyzeCalls.length === 1 && !els.result.hidden, "the viewer's comparison");
  assert.deepEqual(analyzeCalls[0].rosterIds, [3, 9]);
  const summary = els.result.children[0].children.map(x => x.textContent);
  assert.ok(summary.every(l => !/^Your lineup/.test(l)), summary.join(" | "));
  // The owner identifies: the analysis switches to the owner's roster; the viewed team is dropped.
  await Session.identify("max973");
  await until(() => els.status.textContent === "2 teams loaded — you are Max973", "the owner's roster after identifying");
  assert.equal(els.result.hidden, true);
}

async function bestBall() {
  fresh(); statics = makeStatics({ lastWeek: 17 });   // ros_value needs every week through 17 routes = baseRoutes(); state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
  league = { ...baseLeague, settings: { ...baseLeague.settings, best_ball: 1 } };
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("max973");
  await until(() => !els.result.hidden, "the best-ball note");
  assert.equal(els.cols.hidden, true); assert.equal(els.controls.hidden, true);
  const lines = els.result.children.map(x => x.textContent);
  assert.equal(lines[0], BEST_BALL);
  assert.equal(lines[1], `Rest-of-season values. Horizon: ${HORIZON}. Totals: ${AGG}.`);
  assert.ok(lines.some(l => /^A Back · RB · \d+\.\d\d$/.test(l)), lines.join(" | "));
  assert.ok(els.context.children.some(x => x.textContent === "Best ball — not eligible for the format test"));
  assert.ok(els.context.children.some(x => x.textContent === SIM_OFF));
  assert.equal(analyzeCalls.length, 0, "no lineup comparison for best ball");
  assert.equal(els.status.textContent, "2 teams loaded — you are Max973");
}

async function unknownSlot() {
  fresh(); statics = makeStatics(); routes = baseRoutes(); state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
  league = { ...baseLeague, roster_positions: ["RB", "WR", "FLEX", "XFLEX", "BN", "BN"] };
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("max973");
  await until(() => !els.result.hidden, "the unsupported-slot note");
  assert.equal(els.result.children[0].textContent, "Unsupported lineup slot: XFLEX — no trade lineup comparison for this league; the rest-of-season values below still apply.");
  assert.equal(els.cols.hidden, true);
  assert.equal(analyzeCalls.length, 0);
}

async function week18() {
  fresh(); statics = makeStatics({ week: 18, noWeeks: true }); routes = baseRoutes(); league = baseLeague; catalog = baseCatalog();
  state = { season: "2026", season_type: "regular", week: 18 };
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("max973");
  await until(() => els.status.textContent === "No projected weeks remain.", "the week-18 end state");
  assert.equal(els.cols.hidden, true); assert.equal(els.controls.hidden, true);
  assert.equal(analyzeCalls.length, 0);
}

// ============================ Part 3: trade.html's mode resolution ============================
const html = fs.readFileSync(path.join(__dirname, "..", "site", "trade.html"), "utf8");
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]).find(s => /leagueNavigation/.test(s));
const GAB = FC.REGISTRY.find(r => r.slug === "gabagool").leagueId, FAMID = FC.REGISTRY.find(r => r.slug === "fam").leagueId;
async function runPage(href) {
  const dom = tradeDom(href);
  global.FC = FC; global.Session = Session; global.SeasonTradeMode = M; global.TradeMode = window.TradeMode; global.Sleeper = window.Sleeper;
  const run = new Function(`return ${inline.trim().replace(/;\s*$/, "")}`);
  await run();
  return dom;
}
const linkParams = dom => Object.fromEntries(dom.navLinks.map(a => { const u = new URL(a.href); return [u.pathname.split("/").pop(), u.searchParams.get("league")]; }));
const draftFetches = () => fetched.filter(p => /draft/.test(p));
async function pageInSeason() {
  fresh(); statics = makeStatics(); routes = { ...baseRoutes(), ...leagueRoutes(FAMID, () => ({ ...baseLeague, league_id: FAMID })) };
  league = baseLeague; state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
  const dom = await runPage(`https://example.test/Megatron/trade.html?league=fam`);
  await until(() => dom.$("season-status").textContent === GATE, "the in-season controller's gate");
  await until(() => /^data through /.test(dom.stamp.textContent), "the masthead stamp from the batch");
  assert.equal(dom.$("season-trade").hidden, false);
  for (const id of ["trade-eyebrow", "trade-note", "trade-connect", "trade-controls", "trade-cols"]) assert.equal(dom.$(id).hidden, true, id);
  assert.deepEqual(draftFetches(), [], "the in-season page never requests draft.json");
  assert.ok(!calls.some(c => /traded_picks/.test(c)));
  assert.equal(window.TradeMode.calls.length, 0);
  // Task 9: in-season trade is an id context -- its in-season links carry the league id.
  assert.deepEqual(linkParams(dom), { "index.html": "fam", "trade.html": FAMID, "weekly.html": FAMID, "about.html": "fam", "waivers.html": FAMID });
  // An unregistered league in season: the id everywhere, still no draft data.
  fresh(); routes = baseRoutes();
  const dx = await runPage(`https://example.test/Megatron/trade.html?league=${L}`);
  await until(() => dx.$("season-status").textContent === GATE, "the gate for an unregistered league");
  assert.equal(dx.$("season-trade").hidden, false);
  assert.deepEqual(draftFetches(), []);
  assert.deepEqual(Object.values(linkParams(dx)), [L, L, L, L, L]);
}
async function pagePreDraft() {
  // Gabagool pre-draft: the mode is read from the live league FIRST, then the board loads and TradeMode runs as today.
  fresh(); state = { season: "2026", season_type: "pre", week: 0 }; catalog = baseCatalog();
  const gabLeague = { ...baseLeague, league_id: GAB, name: "Gabagool (synthetic)", status: "pre_draft" };
  routes = { ...baseRoutes(), ...leagueRoutes(GAB, () => gabLeague) };
  const board = { league: { league_id: GAB, name: "Gabagool (synthetic)" }, data_through: "2025-wk18", generated_at: new Date().toISOString(), model: "transformer", players: [] };
  statics = { "data/draft.json": board };
  const dom = await runPage(`https://example.test/Megatron/trade.html`);
  assert.equal(window.TradeMode.calls.length, 1, "TradeMode runs for the registered Gabagool league");
  assert.deepEqual(window.TradeMode.calls[0].board, board);
  assert.deepEqual(draftFetches(), ["data/draft.json"]);
  assert.ok(events.indexOf(`sleeper /league/${GAB}`) >= 0 && events.indexOf(`sleeper /league/${GAB}`) < events.indexOf("fetch data/draft.json"), events.join(" | "));
  assert.equal(dom.$("season-trade").hidden, true);
  assert.match(dom.stamp.textContent, /^data through 2025-wk18/);
  // FAM pre-draft keeps today's message; an unregistered pre-draft league is the draft boundary; neither fetches draft data.
  for (const [href, id, expected] of [
    ["trade.html?league=fam", FAMID, "Trade advice is not available for this league yet. No Gabagool values are being loaded."],
    [`trade.html?league=${L}`, L, "The draft board is only built for registered leagues."],
  ]) {
    fresh(); state = { season: "2026", season_type: "pre", week: 0 };
    routes = { ...baseRoutes(), ...leagueRoutes(id, () => ({ ...baseLeague, league_id: id, status: "pre_draft" })) };
    const d = await runPage(`https://example.test/Megatron/${href}`);
    assert.equal(d.stamp.textContent, expected, href);
    assert.deepEqual(draftFetches(), [], href);
    assert.equal(window.TradeMode.calls.length, 0, href);
    assert.equal(d.$("trade-connect").hidden, true);
  }
  // Any other state keeps today's message.
  fresh(); state = { season: "2026", season_type: "post", week: 18 };
  routes = { ...baseRoutes(), ...leagueRoutes(L, () => ({ ...baseLeague, status: "complete" })) };
  const dc = await runPage(`https://example.test/Megatron/trade.html?league=${L}`);
  assert.equal(dc.stamp.textContent, "Trade tools are available before the draft and during the regular season; this league is complete.");
  assert.deepEqual(draftFetches(), []);
  assert.equal(dc.$("season-trade").hidden, true);
}

// I2 (spec 5.4/10): the mode is resolved WITHOUT the in-season season
// contract for a pre-draft league. Rollover: next season's (2027) league is
// pre_draft while /state/nfl still reports 2026.
async function pageRollover() {
  const ROLL = { season: "2026", season_type: "off", week: 0 };
  // Not awaited: on a regression the page waits forever for the chip's retry,
  // and a bare await would let node drain silently with exit 0. `until` fails loudly.
  const startPage = href => {
    const d = tradeDom(href);
    global.FC = FC; global.Session = Session; global.SeasonTradeMode = M; global.TradeMode = window.TradeMode; global.Sleeper = window.Sleeper;
    new Function(`return ${inline.trim().replace(/;\s*$/, "")}`)();
    return d;
  };
  // The registered Gabagool league reaches TradeMode exactly as before.
  fresh(); state = ROLL; catalog = baseCatalog();
  const gab27 = { ...baseLeague, league_id: GAB, name: "Gabagool (synthetic)", season: "2027", status: "pre_draft" };
  routes = { ...baseRoutes(), ...leagueRoutes(GAB, () => gab27) };
  const board = { league: { league_id: GAB, name: "Gabagool (synthetic)" }, data_through: "2026-wk18", generated_at: new Date().toISOString(), model: "transformer", players: [] };
  statics = { "data/draft.json": board };
  const dom = startPage(`https://example.test/Megatron/trade.html`);
  await until(() => window.TradeMode.calls.length === 1 || Session.error(), "the pre-draft mode");
  assert.equal(Session.error(), null);
  assert.equal(window.TradeMode.calls.length, 1, "the 2027 pre-draft Gabagool league reaches TradeMode under 2026 NFL state");
  assert.deepEqual(window.TradeMode.calls[0].board, board);
  assert.deepEqual(draftFetches(), ["data/draft.json"]);
  assert.equal(dom.$("season-trade").hidden, true);
  assert.doesNotMatch(dom.stamp.textContent, /season; projections are for/);
  // An unregistered pre-draft league keeps today's draft-boundary message.
  fresh(); state = ROLL;
  routes = { ...baseRoutes(), ...leagueRoutes(L, () => ({ ...baseLeague, season: "2027", status: "pre_draft" })) };
  const du = startPage(`https://example.test/Megatron/trade.html?league=${L}`);
  await until(() => du.stamp.textContent !== "", "the draft-boundary message");
  assert.equal(du.stamp.textContent, "The draft board is only built for registered leagues.");
  assert.deepEqual(draftFetches(), []); assert.equal(window.TradeMode.calls.length, 0);
  // The same league IN SEASON with a mismatched season is still refused by
  // name; the page never reaches either mode (it waits for the chip's retry).
  for (const [season, current] of [["2027", "2026"], ["2025", "2026"]]) {
    fresh(); state = { season: current, season_type: "regular", week: 3 };
    routes = { ...baseRoutes(), ...leagueRoutes(GAB, () => ({ ...gab27, season, status: "in_season" })) };
    const d = startPage(`https://example.test/Megatron/trade.html`);
    const msg = `This league is from the ${season} season; projections are for ${current}.`;
    await until(() => d.stamp.textContent === msg, `the ${season} in-season refusal`);
    assert.equal(Session.bundle(), null);
    assert.equal(d.$("season-trade").hidden, true, "no in-season trade surface");
    assert.equal(window.TradeMode.calls.length, 0);
    assert.deepEqual(draftFetches(), []);
    assert.equal(analyzeCalls.length, 0);
  }
}

(async () => {
  await sub("owner flow under the real Session, LeagueData and LiveWorld", ownerFlow);
  await sub("Review Focus 1: a player traded after the batch blocks the comparison by name", reviewFocus1);
  await sub("viewer flow: Viewing {team}, reworded columns, the viewer's comparison, then the owner identifies", viewerFlow);
  await sub("best ball: projections and rest-of-season values only, with the note", bestBall);
  await sub("an unknown starting slot: the note, no lineup comparison", unknownSlot);
  await sub("week 18: No projected weeks remain.", week18);
  await sub("trade.html in season: mode first, never draft.json, in-season links by id", pageInSeason);
  await sub("trade.html pre-draft: Gabagool loads draft.json after the mode; others keep today's messages", pagePreDraft);
  await sub("I2 rollover: a next-season pre-draft league reaches TradeMode; in season, another season is still refused", pageRollover);
  if (failed.length) { console.log(`FAILED (${failed.length}):\n  ` + failed.join("\n  ")); process.exit(1); }
  console.log(`seasontrademode_fixture: ${n} groups OK`);
  process.exit(0);
})().catch(e => { console.error(e); if (failed.length) console.log(`FAILED before the abort (${failed.length}): ` + failed.join(" | ")); process.exit(1); });
