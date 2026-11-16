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
// viewer flow, best ball, week 18, Review Focus 1. Part 2b pins draft picks in
// keeper leagues (spec 2026-11-13-trade-draft-picks): rows under the current
// owner, the controls (recompute with no read), picks-only (no engine call),
// player+pick, unavailable reads, dynasty/two-QB reasons, likely keepers and
// the no-pick regression pin, and the ladder rule's draft-history walk (two-year
// cap, keeper-pick conflict line). Part 3 runs trade.html's
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
const NO_EVIDENCE = "Your league's scoring is applied; its accuracy has not been measured.";
const NOT_MEASURED = "not measured for your league's scoring.";
const AGG = "sum of weekly medians through NFL week 17, not a season median";
const HORIZON = "through NFL week 17, regardless of your league's schedule";
const GATE = "Choose a team in the bar above to see trade scenarios.";

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
  const all = [t.subline, ...t.sides.flatMap(s => Object.values(s)), ...t.assumptions, c.headline, ...c.rows, ...M.contextLines({ format: { text: "Scored with your league's own settings. Accuracy for this exact format has not been measured." }, view: { disclosures: { banner: null, footnotes: [] } } })];
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
const sumCtx = { names: { 1: "Team 1", 2: "Team 2" }, firstWeek: 4, endWeek: 17 };
const herbertForKyler = mkResult({
  5: [null, { after: swap(BASE1, "d", HERBERT), delta: 7.87 }],
  8: [{ after: swap(BASE0, "h", KYLER), delta: -6.06 }, null],
});
check("lineupSummary: a one-week change on each side names who enters and leaves", () => {
  assert.deepEqual(M.lineupSummary(herbertForKyler, sumCtx), [
    "Your lineup: −6.1 pts over weeks 4–17. All of it is week 8: Kyler Murray starts instead of Justin Herbert.",
    "Team 2: +7.9 pts over weeks 4–17. All of it is week 5: Justin Herbert starts instead of Dak Prescott.",
  ]);
});
check("lineupSummary: a viewer's side is named by its team, never 'Your lineup'", () => {
  const lines = M.lineupSummary(herbertForKyler, { ...sumCtx, ownLabel: "Team 1" });
  assert.equal(lines[0], "Team 1: −6.1 pts over weeks 4–17. All of it is week 8: Kyler Murray starts instead of Justin Herbert.");
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
// Owner question 2026-10-22 (Parker Washington for Ollie Gordon II): a received
// player who never starts adds 0 to these starter-only totals, and is named.
const NAMES = { k: "Kyler Murray", h: "Justin Herbert", g: "Ollie Gordon II", x: "Rome Odunze" };
const recvCtx = received => ({ ...sumCtx, received, playerName: id => NAMES[id] || id });
check("lineupSummary: a received player who never starts is named, with 0 pts; one who starts is not", () => {
  assert.deepEqual(M.lineupSummary(herbertForKyler, recvCtx([["k"], ["h"]])), M.lineupSummary(herbertForKyler, sumCtx), "both received players start: no note");
  const lines = M.lineupSummary(herbertForKyler, recvCtx([["k", "g"], ["h"]]));
  assert.equal(lines[0], "Your lineup: −6.1 pts over weeks 4–17. All of it is week 8: Kyler Murray starts instead of Justin Herbert. Ollie Gordon II never starts in weeks 4–17, so adds 0 pts here.");
  assert.equal(lines[1], "Team 2: +7.9 pts over weeks 4–17. All of it is week 5: Justin Herbert starts instead of Dak Prescott.");
  assert.equal(M.lineupSummary(herbertForKyler, recvCtx([["g", "x"], []]))[0].split(". ").at(-1), "Ollie Gordon II and Rome Odunze never start in weeks 4–17, so add 0 pts here.", "plural");
});
check("lineupSummary: nothing changes -> one sentence, then each side's never-starting received players", () => {
  assert.deepEqual(M.lineupSummary(mkResult({}), recvCtx([["g"], ["x"]])), [
    "No change to either starting lineup in weeks 4–17 under these assumptions.",
    "Your lineup: Ollie Gordon II never starts in weeks 4–17, so adds 0 pts here.",
    "Team 2: Rome Odunze never starts in weeks 4–17, so adds 0 pts here.",
  ]);
  assert.match(M.STARTERS_ONLY, /^These totals count starting lineups only: a bench player adds points only in weeks he starts .* Cover for injuries you have not entered is not counted\.$/);
});
// 2026-11-13: a slot no player fills is the engine's empty row ({id: null, name: "nobody", empty: true}); the page names
// the slot, never a player called "nobody", and says slot codes in words.
check("slotName: readable lineup slot names; QB/RB/WR/TE stay as they are", () => {
  assert.deepEqual(["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX", "WRRB_FLEX", "REC_FLEX"].map(M.slotName),
    ["QB", "RB", "WR", "TE", "flex", "superflex", "RB/WR flex", "WR/TE flex"]);
});
check("caveatText: the engine's You/They and slot code become the team names and the readable slot", () => {
  const teams = { You: "Team 1", They: "Team 2" };
  assert.equal(M.caveatText("You has no SUPER_FLEX to start after this trade: assumes they add Q One (QB), the best free agent available for it. The roster spot this needs is not modeled.", teams),
    "Team 1 has no superflex to start after this trade: assumes they add Q One (QB), the best free agent available for it. The roster spot this needs is not modeled.");
  assert.equal(M.caveatText("They would have no REC_FLEX to start in week(s) 4, 5: counted as 0, and no free agent with a projection is available for it.", teams),
    "Team 2 would have no WR/TE flex to start in week(s) 4, 5: counted as 0, and no free agent with a projection is available for it.");
  assert.equal(M.caveatText("They has no QB to start now: assumes they add Q One (QB), the best free agent available for it. The roster spot this needs is not modeled.", teams),
    "Team 2 has no QB to start now: assumes they add Q One (QB), the best free agent available for it. The roster spot this needs is not modeled.");
  assert.equal(M.caveatText("No projection for D Deep in 3 week(s): counted as 0.", teams), "No projection for D Deep in 3 week(s): counted as 0.");
});
check("lineupSummary: an empty starting slot is named as a slot, never as a player called nobody", () => {
  const NOBODY = slot => ({ id: null, name: "nobody", position: null, points: 0, status: "empty", slot, empty: true });
  const A = P("a", "A Name", "QB"), T = P("t", "T Name", "TE"), E = P("e", "E Name", "QB"), D = P("d", "D Name", "WR"), F = P("f", "F Name", "FLEX");
  const move = (before, after) => M.lineupSummary({ weeks: [{ week: 4, sides: [{ rosterId: 1, before: { total: 20, lineup: before }, after: { total: 9, lineup: after }, delta: -11 },
    { rosterId: 2, before: { total: 0, lineup: [] }, after: { total: 0, lineup: [] }, delta: 0 }] }], sides: [{ rosterId: 1, delta: -11 }, { rosterId: 2, delta: 0 }] },
    { names: { 1: "Team 1", 2: "Team 2" }, firstWeek: 4, endWeek: 4 })[0].replace(/^Your lineup: −11\.0 pts over weeks 4–4\. All of it is week 4: /, "");
  assert.equal(move([A, T], [E, NOBODY("TE")]), "E Name starts and the TE slot stays empty, instead of A Name and T Name.");
  assert.equal(move([A, D, F], [E, NOBODY("WR"), NOBODY("FLEX")]), "E Name starts and the WR and flex slots stay empty, instead of A Name, D Name and F Name.");
  assert.equal(move([A, T], [NOBODY("QB"), T]), "the QB slot stays empty, instead of A Name.");
  assert.equal(move([NOBODY("QB"), T], [E, T]), "E Name starts instead of an empty QB slot.");
  // Empty rows are matched by slot, not by their shared null id: one empty slot swapped for another is still a change.
  assert.equal(move([NOBODY("QB"), T], [E, NOBODY("TE")]), "E Name starts and the TE slot stays empty, instead of T Name and an empty QB slot.");
  assert.equal(M.lineupSummary({ weeks: [{ week: 4, sides: [{ rosterId: 1, before: { total: 5, lineup: [A, NOBODY("TE")] }, after: { total: 5, lineup: [A, NOBODY("TE")] }, delta: 0 },
    { rosterId: 2, before: { total: 0, lineup: [] }, after: { total: 0, lineup: [] }, delta: 0 }] }], sides: [{ rosterId: 1, delta: 0 }, { rosterId: 2, delta: 0 }] },
    { names: {}, firstWeek: 4, endWeek: 4 })[0], "No change to either starting lineup in weeks 4–4 under these assumptions.", "the same empty slot before and after is no change");
});
check("blockedStatus: the status line carries why the comparison was blocked, not a bare 'comparison blocked'", () => {
  const issues = [{ id: "x", name: "X", week: 3, reason: "r" }, { id: "x", name: "X", week: 4, reason: "r" }];
  assert.equal(M.blockedStatus(Object.assign(new Error("Projection coverage blocked: 1 players, 2 player-weeks. r"), { coverageIssues: issues })),
    "Comparison blocked: 1 player(s), 2 player-week(s) without a projection");
  const traded = Object.assign(new Error("No projection for X in 2 week(s): a traded player cannot be counted as 0. Remove that player from the offer to compare the rest."),
    { coverageIssues: issues, tradedWithoutProjection: ["X"] });
  assert.equal(M.blockedStatus(traded), `Comparison blocked: ${traded.message}`, "a traded player: the engine's message, which says what to do");
  assert.equal(M.blockedStatus(new Error("Roster snapshot stale or invalid; reload")), "Comparison blocked: Roster snapshot stale or invalid; reload");
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
  assert.equal(M.COPY.notMeasured, NOT_MEASURED);
  assert.equal(M.COPY.noProjection, "No projection: can't be included in a comparison.");
  assert.equal(M.COPY.aggregation, AGG);
  assert.equal(M.COPY.horizon, HORIZON);
});
check("contextLines: format line, banner, footnotes, the aggregation label and the simulation note, in that order", () => {
  const view = { disclosures: { banner: "Your league also scores first downs, which these projections leave out; rankings may be off for your league.", footnotes: ["Pick-sixes use an average rate, not a forecast.", "Not projected: two-point conversions (rare events)."] } };
  assert.deepEqual(M.contextLines({ format: { text: "Scored with your league's own settings. Accuracy for this exact format has not been measured." }, view }), [
    "Scored with your league's own settings. Accuracy for this exact format has not been measured.", view.disclosures.banner, ...view.disclosures.footnotes,
    `Lineup totals. Horizon: ${HORIZON}. Totals: ${AGG}.`, SIM_OFF]);
  assert.deepEqual(M.contextLines({ format: { text: "Scored with your league's own settings. Best-ball leagues are not part of the accuracy measurement." }, view: { disclosures: { banner: null, footnotes: [] } } }),
    ["Scored with your league's own settings. Best-ball leagues are not part of the accuracy measurement.", `Lineup totals. Horizon: ${HORIZON}. Totals: ${AGG}.`, SIM_OFF]);
});
const EVAL_DOC = require("./fixtures/neutral_evaluation.json");
check("evidenceLines: the fallback unless a rest-of-season record binds to the live lens and the current method", () => {
  const lens = LL.classify({ rec: 1 });
  assert.deepEqual(M.evidenceLines(null, { lens, method: null }), [`Rest-of-season accuracy: ${NOT_MEASURED}`]);
  assert.deepEqual(M.evidenceLines(EVAL_DOC, { lens, method: null }), [`Rest-of-season accuracy: ${NOT_MEASURED}`], "a null method never binds");
  const rec = EVAL_DOC.records.find(r => r.metric === "rest_of_season_points_mae");
  assert.ok(rec, "the fixture carries a rest-of-season record");
  const method = { v: 2, model: "transformer", checkpoints: [{ path: "models/transformer/v1/through2025/model.pt", sha256: "b".repeat(64) }], artifacts: ["models/transformer/v1"], ensemble: "mean_of_seed_quantiles", band_construction: "sign_coherent_v1",
    calibration: [], prior: { method: "pooled", rate: 0.09, first_season: 2021, through_season: 2025 } };
  const bound = { records: [{ ...rec, method, effective_scoring: LL.evidenceIdentity(lens.weights), prediction_scoring: LL.evidenceIdentity(lens.weights) }] };
  const lines = M.evidenceLines(bound, { lens, method });
  assert.equal(lines[0], "Rest-of-season accuracy, measured under this league's scoring and this model:");
  assert.ok(lines.length > 1 && lines.slice(1).every(l => /weeks? ahead: model MAE/.test(l)), lines.join(" | "));
  assert.deepEqual(M.evidenceLines(bound, { lens: LL.classify({ rec: 0.5 }), method }), [`Rest-of-season accuracy: ${NOT_MEASURED}`], "other scoring: fallback");
  assert.deepEqual(M.evidenceLines(bound, { lens, method: { ...method, model: "xgboost" } }), [`Rest-of-season accuracy: ${NOT_MEASURED}`], "other method: fallback");
});
check("rosValueLines: each active skill player's rest-of-season value with the aggregation label; unknown is not zero", () => {
  const board = { players: [{ sleeper_id: "a", name: "A Back", position: "RB", ros_value: 41.25 }, { sleeper_id: "b", name: "B Wide", position: "WR", ros_value: null }] };
  const catalog = { a: { full_name: "A Back", position: "RB" }, b: { full_name: "B Wide", position: "WR" }, x: { full_name: "X Only", position: "TE" }, k: { full_name: "Kicker", position: "K" }, r: { full_name: "Res", position: "RB" } };
  const pass = { reason: null, of: id => ({ value: board.players.find(p => p.sleeper_id === id)?.ros_value ?? null, reason: null }) };
  assert.deepEqual(M.rosValueLines(board, { players: ["a", "b", "x", "k", "r"], reserve: ["r"] }, catalog, pass), [
    `Rest-of-season values. Horizon: ${HORIZON}. Totals: ${AGG}.`,
    "A Back · RB · 41.25", "B Wide · WR · no rest-of-season projection", "X Only · TE · no rest-of-season projection"]);
  // I1: every number goes through the gate; a withheld one keeps the player listed with the reason.
  const perPlayer = { reason: null, of: id => id === "a" ? { value: null, reason: "current team Z differs from the projection's X" } : { value: null, reason: null } };
  assert.deepEqual(M.rosValueLines(board, { players: ["a", "b"] }, catalog, perPlayer).slice(1),
    ["A Back · RB · withheld — current team Z differs from the projection's X", "B Wide · WR · no rest-of-season projection"]);
  const STALE = "remaining-season projections are stale (over 72 hours old)";
  const batchLevel = { reason: STALE, of: () => ({ value: null, reason: STALE }) };
  assert.deepEqual(M.rosValueLines(board, { players: ["a", "b"] }, catalog, batchLevel).slice(1),
    [`Rest-of-season values withheld: ${STALE}.`, "A Back · RB · withheld", "B Wide · WR · withheld"]);
  assert.throws(() => M.rosValueLines(board, { players: ["a"] }, catalog), /needs the rest-of-season gate/, "no ungated path");
});
// Draft picks (spec 2026-11-13-trade-draft-picks): traded_picks IS read now, but only for a keeper league (the
// behavioural flows below pin that); the pre-draft engine's pick code and the simulation stay out.
check("sources: no pre-draft pick code, gate file or simulation in the controller; trade.html loads the kernel, pickvalue and the adapter", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "site", "assets", "seasontrademode.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "site", "trade.html"), "utf8");
  for (const re of [/pickOwnership/, /DRAFT_ROUNDS/, /defaultPicks/, /trade_sim_eval/, /availability\.json/, /\.simulate\(/, /stratumInputs\(/, /picksUnknown/, /\/user\//, /\/players\/nfl/, /leagueDataPath/])
    assert.ok(!re.test(src), `seasontrademode.js must not contain ${re}`);
  assert.ok(src.includes('"assets/pick_curve.json?v=picks1"'), "the pick-value table is fetched with a cache key");
  const srcs = [...html.matchAll(/<script\b[^>]*src="assets\/([^"?]+)(?:\?[^"]*)?"/g)].map(x => x[1]);
  const ORDER = ["formats.js", "lineup.js", "leaguelens.js", "pickvalue.js", "leaguedata.js", "liveworld.js", "seasontrade.js", "seasontrademode.js"];
  for (const f of ORDER) assert.equal(srcs.filter(s => s === f).length, 1, `trade.html: exactly one ${f}`);
  const at = ORDER.map(f => srcs.indexOf(f));
  assert.deepEqual([...at].sort((a, b) => a - b), at, `trade.html: ${ORDER.join(" -> ")} in order`);
  assert.ok(srcs.indexOf("ros.js") < srcs.indexOf("seasontrade.js") && srcs.indexOf("rostersim.js") < srcs.indexOf("seasontrade.js"), "the frozen method's modules still load before the engine");
  assert.ok(!srcs.includes("waiverintel.js"), "the ROS market check left with the grade");
  // The ladder's draft-history walk is keepers.js's (Task 4): it loads before the controller, after sleeper.js.
  assert.ok(srcs.indexOf("sleeper.js") < srcs.indexOf("keepers.js") && srcs.indexOf("keepers.js") < srcs.indexOf("seasontrademode.js"), "keepers.js loads after sleeper.js, before the controller");
  assert.ok(/seasontrademode\.js\?v=kr1/.test(html) && /keepers\.js\?v=kr1/.test(html) && /keeperrules\.js\?v=kr1/.test(html) && /pickvalue\.js\?v=picks1/.test(html) && /style\.css\?v=cf1/.test(html)
    && /seasontrade\.js\?v=lf1/.test(html) && /lineup\.js\?v=3/.test(html), "cache keys bumped for the changed assets only");
  assert.ok(/id="season-context"/.test(html), "the context lines have a home on the page");
  // The pick groups sit in the columns under the players; the note and the controls come after the columns, before the result.
  for (const side of ["mine", "theirs"]) assert.match(html, new RegExp(`<ul class="trade-assets" id="season-${side}"></ul><div class="season-picks" id="season-${side}-picks" hidden></div>`));
  const pos = id => html.indexOf(`id="${id}"`);
  assert.ok(pos("season-cols") < pos("season-picks-note") && pos("season-picks-note") < pos("season-pick-controls") && pos("season-pick-controls") < pos("season-result"));
});
// ---- draft picks: the pure copy (spec §5.6, §5.7; controller ruling: whole points, one averages line) ----
const ENGINE_NOTE = "No keeper or future-pick value, bench insurance, or the other side's willingness to deal; a free agent is assumed only to fill a starting slot a roster cannot fill.";
const pickValues = K => `Pick values: what the player ranked at each draft spot by the preseason consensus actually scored in 2021–2025, above a waiver-level starter, in your league's scoring. This estimate assumes each team keeps its ${K} best-ranked player${K === 1 ? "" : "s"}. A player's value next season, as a keeper, is not counted.`;
const PICK_VALUES = pickValues(1);
const PICK_LADDER = "Under this keeper rule the best players often can't be kept, so early picks are likely worth more than shown.";
const LATER_TAIL = "Keeper value is not counted; draft picks are valued for future seasons only.";
const PICK_AVERAGES = "Pick values are 2021–2025 averages; any single pick can land far from them.";
check("draft-pick copy: signed whole points (symmetric), a pick line under either draft order, the engine note and the subline tail", () => {
  assert.deepEqual([52.4, -3.6, 0.4, -0.4, 1.5, -1.5, 0].map(M.signedWhole), ["+52", "−4", "0", "0", "+2", "−2", "0"]);
  const v = { value: 62.6, low: 57.4, high: 70.8, slot: null, first: 1, last: 12 };
  assert.equal(M.pickLine("2027 R1 (from Team 7)", v), "2027 R1 (from Team 7): worth about 63 (anywhere from pick 1 to 12: 57–71)");
  assert.equal(M.pickLine("2027 R3", { value: 40.2, low: 36.6, high: 43.7, slot: 29, first: 25, last: 36 }),
    "2027 R3: worth about 40 at pick 29 by current standings (round range 25–36: 37–44)");
  assert.equal(M.engineWarningText(ENGINE_NOTE, false), ENGINE_NOTE, "no pick in the offer: the engine's note as it is");
  assert.equal(M.engineWarningText(ENGINE_NOTE, true), "Draft picks are valued for next season above; keeper value, bench insurance and the other side's willingness to deal are not counted; a free agent is assumed only to fill a starting slot a roster cannot fill.");
  assert.equal(M.engineWarningText("Current-week games are excluded.", true), "Current-week games are excluded.");
  assert.equal(M.PICKS_SUBLINE_TAIL, "Keeper value is not counted; draft picks are valued for next season only.");
  assert.ok(M.ALLOWED_SENTENCES.includes(M.PICKS_SUBLINE_TAIL));
  const t = M.scenarioText(result, { ...ctx, picks: true });
  assert.equal(t.subline, `Sum of weekly central (p50) lineup scenarios for weeks 3–17; week 2 is excluded because trades may process after games start. ${M.PICKS_SUBLINE_TAIL}`);
  assert.equal(M.PICK_COPY.valuesNote(1), PICK_VALUES); assert.equal(M.PICK_COPY.valuesNote(2), pickValues(2)); assert.equal(M.PICK_COPY.averagesNote, PICK_AVERAGES);
  assert.equal(M.PICK_COPY.ladderNote, PICK_LADDER);
  // Two or more seasons ahead: "future seasons" in the subline tail and the engine note.
  assert.equal(M.PICKS_SUBLINE_TAIL_LATER, LATER_TAIL); assert.ok(M.ALLOWED_SENTENCES.includes(LATER_TAIL));
  assert.equal(M.scenarioText(result, { ...ctx, picks: true, picksLater: true }).subline.endsWith(LATER_TAIL), true);
  assert.equal(M.engineWarningText(ENGINE_NOTE, true, true), "Draft picks are valued for future seasons above; keeper value, bench insurance and the other side's willingness to deal are not counted; a free agent is assumed only to fill a starting slot a roster cannot fill.");
  assert.equal(M.PICK_COPY.help(), "How much a point next season counts: Win now ×0.5, Balanced ×0.8, Rebuild ×1.2.");
});
check("picksSummary: per side who gets and gives what, the next-season total, one line per pick, the combined line; then the two notes", () => {
  const pk = (season, label, value) => ({ season, label, v: { value, low: value - 2, high: value + 2, slot: null, first: 1, last: 12 } });
  const lines = M.picksSummary({ currentSeason: "2026", preset: "balanced", keepers: 1, sides: [
    { you: true, name: "Team 1", thisSeason: -38.2, gets: [pk(2027, "2027 R1 (from Team 7)", 63)], gives: [pk(2027, "2027 R3", 11)] },
    { you: false, name: "Team 7", thisSeason: 40.3, gets: [pk(2027, "2027 R3 (from Team 1)", 11)], gives: [pk(2027, "2027 R1", 63)] },
  ] });
  assert.deepEqual(lines.map(l => l.text), [
    "You get 2027 R1 (from Team 7) and give 2027 R3.",
    "Next season: +52 expected points from picks.",
    "2027 R1 (from Team 7): worth about 63 (anywhere from pick 1 to 12: 61–65)",
    "2027 R3: worth about 11 (anywhere from pick 1 to 12: 9–13)",
    "Combined at Balanced (next season ×0.8): +3",
    "Team 7 gets 2027 R3 (from Team 1) and gives 2027 R1.",
    "Next season: −52 expected points from picks.",
    "2027 R3 (from Team 1): worth about 11 (anywhere from pick 1 to 12: 9–13)",
    "2027 R1: worth about 63 (anywhere from pick 1 to 12: 61–65)",
    "Combined at Balanced (next season ×0.8): −1",
    PICK_VALUES, PICK_AVERAGES]);
  // One side only gets, the other only gives; a pick two seasons ahead: "Future seasons", weighted w^2.
  const later = M.picksSummary({ currentSeason: 2026, preset: "win_now", keepers: 1, sides: [
    { you: false, name: "Team 1", thisSeason: 0, gets: [pk(2028, "2028 R1 (from Team 7)", 40)], gives: [] },
    { you: false, name: "Team 7", thisSeason: 0, gets: [], gives: [pk(2028, "2028 R1", 40)] },
  ] }).map(l => l.text);
  assert.deepEqual(later.slice(0, 4), ["Team 1 gets 2028 R1 (from Team 7).", "Future seasons: +40 expected points from picks.",
    "2028 R1 (from Team 7): worth about 40 (anywhere from pick 1 to 12: 38–42)", "Combined at Win now (the season after ×0.25): +10"]);
  assert.deepEqual(later.slice(4, 6), ["Team 7 gives 2028 R1.", "Future seasons: −40 expected points from picks."]);
  const two = M.picksSummary({ currentSeason: 2026, preset: "balanced", keepers: 1, sides: [
    { you: true, name: "Team 1", thisSeason: 0, gets: [pk(2027, "2027 R1 (from Team 7)", 63)], gives: [pk(2027, "2027 R3", 11), pk(2027, "2027 R5", 5)] },
    { you: false, name: "Team 7", thisSeason: 0, gets: [pk(2027, "2027 R3 (from Team 1)", 11), pk(2027, "2027 R5 (from Team 1)", 5)], gives: [pk(2027, "2027 R1", 63)] },
  ] }).map(l => l.text);
  // A mixed 2027 + 2028 offer lists each factor applied; the ladder line follows the two notes, only under that rule.
  const mixed = ladder => M.picksSummary({ currentSeason: 2026, preset: "balanced", keepers: 2, keeperRule: ladder, sides: [
    { you: true, name: "Team 1", thisSeason: 0, gets: [pk(2027, "2027 R1", 63), pk(2028, "2028 R1", 40)], gives: [] },
    { you: false, name: "Team 7", thisSeason: 0, gets: [], gives: [pk(2027, "2027 R1", 63), pk(2028, "2028 R1", 40)] },
  ] }).map(l => l.text);
  const m = mixed("ladder");
  assert.ok(m.includes("Combined at Balanced (next season ×0.8, the season after ×0.64): +76"), m.join("\n"));
  assert.deepEqual(m.slice(-3), [pickValues(2), PICK_AVERAGES, PICK_LADDER]);
  assert.deepEqual(mixed("unknown").slice(-2), [pickValues(2), PICK_AVERAGES]);
  assert.ok(!mixed("unknown").includes(PICK_LADDER));
  assert.equal(two[0], "You get 2027 R1 (from Team 7), and give 2027 R3 and 2027 R5.");
  assert.equal(two[6], "Team 7 gets 2027 R3 (from Team 1) and 2027 R5 (from Team 1), and gives 2027 R1.");
});
check("likelyKeepers: the top max_keepers skill players of a roster by rest-of-season value (IR and taxi count; unknown values do not)", () => {
  const roster = { players: ["a", "b", "c", "k", "r", "t"], reserve: ["r"], taxi: ["t"] };
  const catalog = { a: { position: "RB" }, b: { position: "WR" }, c: { position: "TE" }, k: { position: "K" }, r: { position: "RB" }, t: { position: "QB" } };
  const ros = new Map([["a", 50], ["b", 80], ["c", null], ["k", 999], ["r", 60], ["t", 10]]);
  assert.deepEqual([...M.likelyKeepers({ roster, catalog, rosValue: ros, keepers: 2 })].sort(), ["b", "r"]);
  assert.deepEqual([...M.likelyKeepers({ roster, catalog, rosValue: ros, keepers: 1 })], ["b"]);
  assert.equal(M.likelyKeepers({ roster, catalog, rosValue: ros, keepers: 0 }).size, 0);
  assert.equal(M.likelyKeepers({ roster, catalog, rosValue: ros, keepers: undefined }).size, 0);
  // Under a keeper rule, only players that rule lets keep are ranked; the next one takes an excluded player's place.
  assert.deepEqual([...M.likelyKeepers({ roster, catalog, rosValue: ros, keepers: 1, eligible: id => id !== "b" })], ["r"]);
  assert.deepEqual([...M.likelyKeepers({ roster, catalog, rosValue: ros, keepers: 2, eligible: id => id !== "b" })], ["r", "a"]);
  assert.equal(M.likelyKeepers({ roster, catalog, rosValue: ros, keepers: 2, eligible: () => false }).size, 0);
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
  const mainStart = html.search(/<main\b[^>]*>/);
  assert.ok(mainStart >= 0, "trade page contains its main landmark");
  const body = html.slice(mainStart, html.indexOf("</main>"));
  let col = null;
  for (const m of body.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"([^>]*)>/g)) {
    const [, tag, id] = m;
    const x = element(tag); x.id = id; x.hidden = /\bhidden\b/.test(m[0]);
    if (["season-mine", "season-theirs", "trade-mine", "trade-theirs"].includes(id)) {
      col = element("div"); col.append(element("h2"), x); main.append(col);
    } else if (/^season-(mine|theirs)-picks$/.test(id) && col) col.append(x);   // the pick group sits under the column's list
    else main.append(x);
  }
  return { main, stamp, navLinks, $: id => document.getElementById(id) };
}
const els$ = $ => ({ eyebrow: $("season-eyebrow"), status: $("season-status"), controls: $("season-controls"), partner: $("season-partner"),
  compare: $("season-compare"), warn: $("season-warn"), cols: $("season-cols"), mine: $("season-mine"), theirs: $("season-theirs"),
  mineDrops: $("season-mine-drops"), theirsDrops: $("season-theirs-drops"), result: $("season-result"), provenance: $("season-provenance"),
  context: $("season-context"), minePicks: $("season-mine-picks"), theirsPicks: $("season-theirs-picks"),
  pickControls: $("season-pick-controls"), picksNote: $("season-picks-note") });

// ---- the engine, recorded; simulation calls are counted (must stay 0) ----
const analyzeCalls = [], analyzeErrors = [], analyzeResults = [];
let simCalls = 0;
window.SeasonTrade = {
  analyze(args) { analyzeCalls.push(args); try { const r = RealSeasonTrade.analyze(args); analyzeResults.push(r); return r; } catch (e) { analyzeErrors.push(e); throw e; } },
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
// As on trade.html, keepers.js loads after sleeper.js and reads window.Sleeper, so the ladder's draft-history walk
// (Keepers.buildOriginalByPlayerId) goes through the logged stub above.
const Keepers = require("../site/assets/keepers.js");
assert.equal(window.Keepers, Keepers);
let statics = {};
global.fetch = async p => {
  fetched.push(p); events.push(`fetch ${p}`);
  const doc = statics[p];
  return doc ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(doc)) } : { ok: false, status: 404, json: async () => ({}) };
};
const STATS = LL.STATS;
const METHOD = { v: 2, model: "transformer", checkpoints: [{ path: "models/transformer/v1/through2025/model.pt", sha256: "b".repeat(64) }], artifacts: ["models/transformer/v1"], ensemble: "mean_of_seed_quantiles",
  band_construction: "sign_coherent_v1", calibration: [], prior: { method: "pooled", rate: 0.09, first_season: 2021, through_season: 2025 } };
// [sleeper id, gsis, position, name, receptions, receiving yards]
const PEOPLE = [["a", "00-0000001", "RB", "A Back", 4, 60], ["d", "00-0000004", "WR", "D Deep", 2, 30], ["e", "00-0000005", "WR", "E Slot", 1, 20],
  ["b", "00-0000002", "WR", "B Wide", 6, 80], ["c", "00-0000003", "RB", "C Run", 3, 40], ["f", "00-0000006", "RB", "F Flex", 2, 10]];
const sqOf = (rec, yds) => { const o = f => Object.fromEntries(STATS.map(s => [s, s === "receptions" ? rec * f : s === "receiving_yards" ? yds * f : 0])); return { p10: o(0.5), p50: o(1), p90: o(1.5) }; };
const vecOf = (rec, yds, f) => STATS.map(s => s === "receptions" ? rec * f : s === "receiving_yards" ? yds * f : 0);
function makeStatics({ week = 3, noWeeks = false, lastWeek = 6, people = PEOPLE } = {}) {
  const HDR = { season: 2026, week, data_through: `2026-wk${week - 1}`, generated_at: new Date().toISOString(), batch_id: `b-w${week}` };
  const weeks = [];
  for (let w = week; w <= lastWeek; w++) weeks.push(w);
  return {
    "data/neutral/weekly.json": { ...HDR, schema_version: 1, kind: "neutral_weekly", model: "transformer", method: METHOD,
      players: people.map(([sid, pid, pos, name, rec, yds]) => ({ player_id: pid, name, team: "X", opponent: "Y", position: pos, is_home: true, stat_quantiles: sqOf(rec, yds), points: { ppr: null, half_ppr: null, standard: null } })) },
    "data/neutral/remaining.json": noWeeks
      ? { ...HDR, schema_version: 2, kind: "neutral_remaining", horizon: "remaining_season", status: "no_remaining_weeks", start_week: week, end_week: 17, model: "transformer", stat_order: STATS.slice(), players: [] }
      : { ...HDR, schema_version: 2, kind: "neutral_remaining", horizon: "remaining_season", status: "experimental", start_week: week, end_week: lastWeek, model: "transformer",
          stat_order: STATS.slice(), method: METHOD, pick_six_forecast: METHOD.prior,
          players: people.map(([sid, pid, pos, name, rec, yds]) => ({ player_id: pid, team: "X", position: pos, name,
            weeks: weeks.map(w => sid === "b" && w === 5 ? { week: w, status: "bye", points: null } : { week: w, status: "conditional_projection", opponent: "Y", stats: [vecOf(rec, yds, 0.5), vecOf(rec, yds, 1), vecOf(rec, yds, 1.5)] }) })) },
    "data/neutral/players.json": { ...HDR, schema_version: 1, kind: "neutral_players",
      players: people.map(([sid, pid, pos, name]) => ({ player_id: pid, sleeper_id: sid, name, team: "X", position: pos, bye: sid === "b" ? 5 : 9, ecr: null, identity_only: false, reason: null })) },
    "data/neutral/formats.json": { ...require("./fixtures/neutral_formats.json"), ...HDR },
    "data/neutral/evaluation.json": { ...require("./fixtures/neutral_evaluation.json"), ...HDR },
  };
}
const OWNER = Object.values(require("./fixtures/owner_league_settings.json")).find(l => l.total_rosters === 12);   // the 12-team owner settings
const L = "900000000000000777";                          // not in the registry
const users = [{ user_id: "u1", display_name: "User A" }, { user_id: "u2", display_name: "Bo", metadata: { team_name: "Bo's Bunch" } }];
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
    "/user/user_a": { user_id: "u1", username: "user_a", display_name: "User A" },
    ...leagueRoutes(L, () => league), "/state/nfl": () => state, "/players/nfl": () => catalog,
  };
}
function fresh(storage = new Map()) {
  Session._storage({ getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: k => { storage.delete(k); }, key: i => [...storage.keys()][i] ?? null, get length() { return storage.size; } });
  M._reset();
  analyzeCalls.length = 0; analyzeErrors.length = 0; analyzeResults.length = 0; calls.length = 0; fetched.length = 0; events.length = 0; window.TradeMode.calls.length = 0;
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

  await Session.identify("user_a");
  await until(() => /teams loaded/.test(els.status.textContent), "the owner's columns");
  assert.equal(els.status.textContent, "2 teams loaded — you are User A");
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
    assert.match(els.mine.parent.children[0].textContent, /^You give — User A$/);
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
    const summaryLines = els.result.children[0].children;
    assert.equal(summaryLines.at(-1).textContent, M.STARTERS_ONLY, "the starters-only caveat closes the summary");
    assert.equal(summaryLines.at(-1).className, "season-summary-note");
    assert.ok(!els.result.children.some(x => x.className === "season-grade"));
    const details = els.result.children.filter(x => x.tagName === "details");
    assert.deepEqual(details.map(d => d.children[0].textContent), ["Week-by-week lineup totals", "Assumptions", "Engine notes", "Measured evaluation"]);
    assert.equal(text(details[3]).split("\n").slice(1).join("\n"), `Rest-of-season accuracy: ${NOT_MEASURED}`);
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

// Over the roster limit: drops are marked inline in that team's own column; the roster is never listed twice.
async function dropFlow() {
  fresh(); statics = makeStatics(); routes = baseRoutes(); state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
  league = { ...baseLeague, roster_positions: ["RB", "WR", "FLEX", "K"] };       // capacity 4: User A's 4 players fill it
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els });
  FC.setLeague(L);
  await Session.identify("user_a");
  await until(() => /teams loaded/.test(els.status.textContent), "the owner's columns");
  const dropBtn = (ul, id) => ul.children.find(li => li.dataset.id === id).children.find(x => x.className === "season-drop-btn");
  for (const id of ["a", "d", "e", "k"]) assert.equal(dropBtn(els.mine, id).hidden, true, `no Drop on ${id} before any trade`);
  assert.equal(els.mineDrops.hidden, true);

  tickPlayer(els.theirs, "b");                                                  // get 1, give 0: one over
  assert.equal(els.mineDrops.hidden, false);
  assert.deepEqual(els.mineDrops.children.map(x => x.className), ["season-drop-prompt"], "a prompt line only, no second roster list");
  assert.equal(els.mineDrops.children[0].textContent, "User A would be 1 over the roster limit — mark one player to drop below (0 of 1 marked)");
  for (const id of ["a", "d", "e", "k"]) assert.equal(dropBtn(els.mine, id).hidden, false, `Drop offered on ${id}, kicker included`);
  for (const id of ["b", "c", "f"]) assert.equal(dropBtn(els.theirs, id).hidden, true, "the other side is not over");
  assert.equal(els.compare.disabled, true, "compare waits for the drop");

  dropBtn(els.mine, "e").dispatch("click");
  assert.equal(dropBtn(els.mine, "e").attrs["aria-pressed"], "true");
  assert.equal(dropBtn(els.mine, "e").textContent, "Dropping — undo");
  assert.match(els.mineDrops.children[0].textContent, /\(1 of 1 marked\)$/);
  assert.equal(els.compare.disabled, false, "one marked drop unlocks compare");
  await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 1, "the comparison with a drop");
  assert.deepEqual(analyzeCalls[0].drops, { 9: ["e"] }, "the marked drop reaches the engine");

  dropBtn(els.mine, "e").dispatch("click");                                     // undo
  assert.equal(dropBtn(els.mine, "e").attrs["aria-pressed"], "false");
  assert.equal(els.compare.disabled, true);

  tickPlayer(els.mine, "d");                                                     // give 1, get 1: fits again
  assert.equal(els.mineDrops.hidden, true);
  for (const id of ["a", "d", "e", "k"]) assert.equal(dropBtn(els.mine, id).hidden, true, `Drop withdrawn on ${id}`);

  // A marked drop that then becomes a trade asset leaves the drop set; an obligation that returns starts unmarked.
  tickPlayer(els.theirs, "c");                                                   // give 1, get 2: one over again
  dropBtn(els.mine, "a").dispatch("click");
  assert.match(els.mineDrops.children[0].textContent, /\(1 of 1 marked\)$/);
  tickPlayer(els.mine, "a");                                                     // give 2, get 2: fits
  assert.equal(els.mineDrops.hidden, true);
  assert.equal(dropBtn(els.mine, "a").hidden, true, "a traded player never shows Drop");
  tickPlayer(els.theirs, "f");                                                   // give 2, get 3: one over
  assert.match(els.mineDrops.children[0].textContent, /\(0 of 1 marked\)$/, "the earlier mark did not survive");
  assert.equal(dropBtn(els.mine, "a").hidden, true);
  assert.equal(dropBtn(els.mine, "e").attrs["aria-pressed"], "false");
  dropBtn(els.mine, "e").dispatch("click");
  await clickCompare(els, () => analyzeCalls.length === 2, "the comparison after the transitions");
  assert.deepEqual(analyzeCalls[1].give.slice().sort(), ["a", "d"]);
  assert.deepEqual(analyzeCalls[1].drops, { 9: ["e"] });
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
  await Session.identify("user_a");
  await until(() => /teams loaded/.test(els.status.textContent), "the owner's columns");
  // Audit A6-3: D Deep is not in the offer, so he counts as 0 and the comparison runs, naming him.
  tickPlayer(els.mine, "a"); tickPlayer(els.theirs, "c");
  await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 1, "the comparison with an unprojected bench player");
  assert.equal(analyzeErrors.length, 0);
  assert.equal(els.status.textContent, "lineups compared for weeks 4–6");
  const summary = els.result.children[0];
  assert.equal(summary.className, "season-summary");
  const notes = summary.children.filter(x => x.className === "season-summary-note").map(x => x.textContent);
  assert.deepEqual(notes, ["No projection for D Deep in 3 week(s): counted as 0.", M.STARTERS_ONLY], "the caveat is visible in the summary, before the starters-only note");
  // In the offer, he still blocks the comparison, by name: the status line and the result say only the engine's
  // message (it names him and says what to do), not one row per player-week.
  tickPlayer(els.mine, "d");
  await clickCompare(els, () => !els.result.hidden && analyzeErrors.length === 1, "the blocked comparison");
  const MSG = "No projection for D Deep in 3 week(s): a traded player cannot be counted as 0. Remove that player from the offer to compare the rest.";
  assert.equal(analyzeErrors[0].message, MSG, "never scored for his old team");
  assert.equal(els.status.textContent, `Comparison blocked: ${MSG}`);
  assert.equal(text(els.result.children[0]), "Comparison blocked");
  assert.deepEqual(els.result.children.slice(1).map(x => x.textContent), [MSG]);
  assert.ok(!els.result.children.some(x => x.tagName === "ul") && !/week 4 ·/.test(text(els.result)), text(els.result));
}

// The outcome of Compare lineups renders below both roster lists, so it is brought into view (no motion when the reader
// prefers less), and the status line says why a comparison was blocked. E Slot (not traded) is missing from the
// catalog, so the engine refuses the comparison with a coverage error.
async function blockedFlow() {
  fresh(); statics = makeStatics(); routes = baseRoutes(); league = baseLeague; state = { season: "2026", season_type: "regular", week: 3 };
  catalog = baseCatalog(); delete catalog.e;
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("user_a");
  await until(() => /teams loaded/.test(els.status.textContent), "the owner's columns");
  const scrolls = [];
  els.result.scrollIntoView = opts => scrolls.push(opts);
  let reduce = true;
  window.matchMedia = q => ({ matches: reduce && q === "(prefers-reduced-motion: reduce)" });
  try {
    tickPlayer(els.mine, "a"); tickPlayer(els.theirs, "c");
    await clickCompare(els, () => !els.result.hidden && analyzeErrors.length === 1, "the blocked comparison");
    assert.equal(els.status.textContent, "Comparison blocked: 1 player(s), 3 player-week(s) without a projection");
    assert.equal(text(els.result.children[0]), "Comparison blocked: 1 player(s), 3 player-week(s) without a projection");
    assert.ok(text(els.result).includes("e · week 4 · Catalog identity missing"), text(els.result));
    assert.deepEqual(scrolls, [{ block: "start", behavior: "auto" }], "reduced motion: no smooth scroll");
    reduce = false;
    await clickCompare(els, () => analyzeErrors.length === 2 && !els.result.hidden && scrolls.length === 2, "the second blocked comparison");
    assert.deepEqual(scrolls[1], { block: "start", behavior: "smooth" });
  } finally { delete window.matchMedia; }
}

// A skill player the comparison cannot price is listed but cannot be ticked: U is not in the view's scorable mapping,
// V's projection has no week-5 row. The engine would refuse any offer with either; off the offer they count as 0.
async function unpriceableFlow() {
  fresh(); statics = makeStatics({ people: [...PEOPLE, ["v", "00-0000008", "WR", "V Gap", 1, 10]] });
  const vRem = statics["data/neutral/remaining.json"].players.find(p => p.player_id === "00-0000008");
  vRem.weeks = vRem.weeks.filter(w => w.week !== 5);
  routes = baseRoutes();
  routes[`/league/${L}/rosters`] = () => rosters.map(r => (r.roster_id === 9 ? { ...r, players: [...r.players, "u", "v"] } : { ...r }));
  league = baseLeague; state = { season: "2026", season_type: "regular", week: 3 };
  catalog = baseCatalog();
  catalog.u = { position: "RB", full_name: "U Nmapped", team: "X" };
  catalog.v = { position: "WR", full_name: "V Gap", team: "X", gsis_id: "00-0000008" };
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("user_a");
  await until(() => /teams loaded/.test(els.status.textContent), "the owner's columns");
  for (const id of ["u", "v"]) {
    const li = els.mine.children.find(x => x.dataset.id === id);
    assert.ok(/season-disabled/.test(li.className), `${id}: ${li.className}`);
    assert.equal(li.children[0].children[0].disabled, true, `${id}: the checkbox is disabled`);
    assert.deepEqual(li.children.filter(x => x.className === "trade-why").map(x => x.textContent), [M.COPY.noProjection]);
    tickPlayer(els.mine, id);
  }
  assert.equal(els.compare.disabled, true, "nothing selectable was ticked");
  const k = els.mine.children.find(x => x.dataset.id === "k");
  assert.ok(/no modeled points/.test(text(k)) && !text(k).includes(M.COPY.noProjection), "a kicker keeps his own note");
  tickPlayer(els.mine, "a"); tickPlayer(els.theirs, "c");
  await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 1, "the comparison beside the unpriced players");
  assert.deepEqual(analyzeCalls[0].give, ["a"]);
  const notes = els.result.children[0].children.filter(x => x.className === "season-summary-note").map(x => x.textContent);
  for (const n of ["No projection for U Nmapped in 3 week(s): counted as 0.", "No projection for V Gap in 1 week(s): counted as 0."]) assert.ok(notes.includes(n), notes.join(" | "));
}

// A roster left with no player for a starting slot and no free agent for it: the slot is named in words ("flex", not
// FLEX), and the summary says the slot stays empty instead of naming a player "nobody". G Free is the only free agent.
async function emptySlotFlow() {
  fresh(); statics = makeStatics({ people: [...PEOPLE, ["g", "00-0000007", "RB", "G Free", 5, 70]] }); routes = baseRoutes(); league = baseLeague;
  state = { season: "2026", season_type: "regular", week: 3 };
  catalog = baseCatalog(); catalog.g = { position: "RB", full_name: "G Free", team: "X", gsis_id: "00-0000007" };
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("user_a");
  await until(() => /teams loaded/.test(els.status.textContent), "the owner's columns");
  const scrolls = [];
  els.result.scrollIntoView = opts => scrolls.push(opts);     // no matchMedia here: the guard reads it as no preference
  for (const id of ["a", "d", "e"]) tickPlayer(els.mine, id);  // User A gives every skill player and gets nobody
  await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 1, "the comparison that leaves slots empty");
  assert.equal(analyzeErrors.length, 0);
  const lines = els.result.children[0].children.map(x => x.textContent);
  assert.deepEqual(lines.filter((x, i) => els.result.children[0].children[i].className === "season-summary-note"), [
    "User A has no RB to start after this trade: assumes they add G Free (RB), the best free agent available for it. The roster spot this needs is not modeled.",
    "User A would have no WR to start in week(s) 4, 5, 6: counted as 0, and no free agent with a projection is available for it.",
    "User A would have no flex to start in week(s) 4, 5, 6: counted as 0, and no free agent with a projection is available for it.",
    M.STARTERS_ONLY]);
  assert.ok(lines[0].includes(": G Free starts and the WR and flex slots stay empty, instead of A Back, D Deep and E Slot"), lines[0]);
  assert.ok(!/\bnobody\b/.test(text(els.result)) && !/FLEX/.test(text(els.result)), text(els.result));
  assert.deepEqual(scrolls, [{ block: "start", behavior: "smooth" }], "a finished comparison is brought into view");
}

// A slot a roster cannot fill (owner decision 2026-11-13): the engine's free-agent caveats reach the summary with the
// two team names in place of its "You"/"They". G Free is a projected RB on no roster; nobody is a free-agent WR.
async function pickupFlow() {
  fresh(); statics = makeStatics({ people: [...PEOPLE, ["g", "00-0000007", "RB", "G Free", 5, 70]] }); routes = baseRoutes(); league = baseLeague;
  state = { season: "2026", season_type: "regular", week: 3 };
  catalog = baseCatalog(); catalog.g = { position: "RB", full_name: "G Free", team: "X", gsis_id: "00-0000007" };
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("user_a");
  await until(() => /teams loaded/.test(els.status.textContent), "the owner's columns");
  // User A gives its only RB for Bo's Bunch's only WR.
  tickPlayer(els.mine, "a"); tickPlayer(els.theirs, "b");
  await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 1, "the comparison with an unfillable slot on each side");
  assert.equal(analyzeErrors.length, 0, "never refused");
  assert.equal(els.status.textContent, "lineups compared for weeks 4–6");
  const notes = els.result.children[0].children.filter(x => x.className === "season-summary-note").map(x => x.textContent);
  assert.deepEqual(notes, [
    "User A has no RB to start after this trade: assumes they add G Free (RB), the best free agent available for it. The roster spot this needs is not modeled.",
    "Bo's Bunch would have no WR to start in week(s) 4, 5, 6: counted as 0, and no free agent with a projection is available for it.",
    M.STARTERS_ONLY]);
  assert.ok(!/\b(You|They) (has|would have) no /.test(text(els.result)), "no engine placeholder left on the page");
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
  assert.equal(els.theirs.parent.children[0].textContent, "Bo's Bunch gets — from User A");
  tickPlayer(els.mine, "b"); tickPlayer(els.theirs, "d");
  await clickCompare(els, () => analyzeCalls.length === 1 && !els.result.hidden, "the viewer's comparison");
  assert.deepEqual(analyzeCalls[0].rosterIds, [3, 9]);
  const summary = els.result.children[0].children.map(x => x.textContent);
  assert.ok(summary.every(l => !/^Your lineup/.test(l)), summary.join(" | "));
  // The owner identifies: the analysis switches to the owner's roster; the viewed team is dropped.
  await Session.identify("user_a");
  await until(() => els.status.textContent === "2 teams loaded — you are User A", "the owner's roster after identifying");
  assert.equal(els.result.hidden, true);
}

async function bestBall() {
  fresh(); statics = makeStatics({ lastWeek: 17 });   // ros_value needs every week through 17 routes = baseRoutes(); state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
  league = { ...baseLeague, settings: { ...baseLeague.settings, best_ball: 1 } };
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("user_a");
  await until(() => !els.result.hidden, "the best-ball note");
  assert.equal(els.cols.hidden, true); assert.equal(els.controls.hidden, true);
  const lines = els.result.children.map(x => x.textContent);
  assert.equal(lines[0], BEST_BALL);
  assert.equal(lines[1], `Rest-of-season values. Horizon: ${HORIZON}. Totals: ${AGG}.`);
  assert.ok(lines.some(l => /^A Back · RB · \d+\.\d\d$/.test(l)), lines.join(" | "));
  assert.ok(els.context.children.some(x => x.textContent === "Scored with your league's own settings. Best-ball leagues are not part of the accuracy measurement."));
  assert.ok(els.context.children.some(x => x.textContent === SIM_OFF));
  assert.equal(analyzeCalls.length, 0, "no lineup comparison for best ball");
  assert.equal(els.status.textContent, "2 teams loaded — you are User A");
}

async function unknownSlot() {
  fresh(); statics = makeStatics(); routes = baseRoutes(); state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
  league = { ...baseLeague, roster_positions: ["RB", "WR", "FLEX", "XFLEX", "BN", "BN"] };
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("user_a");
  await until(() => !els.result.hidden, "the unsupported-slot note");
  assert.equal(els.result.children[0].textContent, "Unsupported lineup slot: XFLEX — no trade lineup comparison for this league; the rest-of-season values below still apply.");
  assert.equal(els.cols.hidden, true);
  assert.equal(analyzeCalls.length, 0);
}

// I1: best ball and an unknown starting slot show rest-of-season values with
// no lineup analyzer -- each number still passes SeasonTrade's own checks
// (72 h, no future date, current team) or is withheld, the roster kept.
async function rosValidity() {
  const H = 3600000;
  const STALE = "remaining-season projections are stale (over 72 hours old)";
  const FUTURE = "remaining-season projections are future-dated or undated";
  const modes = [
    ["best ball", { ...baseLeague, settings: { ...baseLeague.settings, best_ball: 1 } }, BEST_BALL],
    ["unknown starting slot", { ...baseLeague, roster_positions: ["RB", "WR", "FLEX", "XFLEX", "BN", "BN"] },
      "Unsupported lineup slot: XFLEX — no trade lineup comparison for this league; the rest-of-season values below still apply."],
  ];
  const kinds = [["fresh", 0, "X"], ["stale (>72 h)", -96 * H, "X"], ["future-dated", 10 * 60000, "X"], ["changed team", 0, "Z"]];
  for (const [mode, lg, note] of modes) for (const [kind, shift, team] of kinds) {
    fresh(); statics = makeStatics({ lastWeek: 17 });
    const at = new Date(Date.now() + shift).toISOString();
    for (const doc of Object.values(statics)) doc.generated_at = at;   // one refresh: every header agrees
    routes = baseRoutes(); state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog(); catalog.a.team = team;
    league = lg;
    const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
    const els = els$($);
    M.init({ els }); FC.setLeague(L);
    await Session.identify("user_a");
    await until(() => !els.result.hidden, `${mode} / ${kind}`);
    const lines = els.result.children.map(x => x.textContent), what = `${mode} / ${kind}: ${lines.join(" | ")}`;
    assert.equal(lines[0], note, what);
    assert.equal(analyzeCalls.length, 0, "no lineup analyzer on this path");
    assert.equal(els.status.textContent, "2 teams loaded — you are User A", "roster identity kept");
    const player = name => lines.find(l => l.startsWith(name));
    for (const name of ["A Back · RB", "D Deep · WR", "E Slot · WR"]) assert.ok(player(name), `${what}: ${name} listed`);
    if (kind === "fresh") {
      assert.ok(lines.slice(2).every(l => /· \d+\.\d\d$/.test(l)), what);
      continue;
    }
    if (kind === "changed team") {
      assert.equal(player("A Back"), "A Back · RB · withheld — current team Z differs from the projection's X", what);
      assert.match(player("D Deep"), /· \d+\.\d\d$/, `${what}: an unmoved player keeps his value`);
      continue;
    }
    const reason = kind.startsWith("stale") ? STALE : FUTURE;
    assert.equal(lines[2], `Rest-of-season values withheld: ${reason}.`, what);
    assert.deepEqual(lines.slice(3), ["A Back · RB · withheld", "D Deep · WR · withheld", "E Slot · WR · withheld"], what);
    assert.ok(!lines.some(l => /\d+\.\d\d/.test(l)), `${what}: no number survives`);
  }
}

async function week18() {
  fresh(); statics = makeStatics({ week: 18, noWeeks: true }); routes = baseRoutes(); league = baseLeague; catalog = baseCatalog();
  state = { season: "2026", season_type: "regular", week: 18 };
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("user_a");
  await until(() => els.status.textContent === "No projected weeks remain.", "the week-18 end state");
  assert.equal(els.cols.hidden, true); assert.equal(els.controls.hidden, true);
  assert.equal(analyzeCalls.length, 0);
}

// ============ Part 2b: draft picks in keeper leagues (spec 2026-11-13-trade-draft-picks) ============
// A synthetic 2-team keeper league (type 1, one keeper) drafting 3 snake rounds. Bo's Bunch traded its 2027 R2 to
// User A. The 12-team owner scoring scores pick-sixes, so the page must pass the batch's prior rate (Review Focus 2).
const PV = require("../site/assets/pickvalue.js");
const PICK_CURVE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "site", "assets", "pick_curve.json"), "utf8"));
const CURVE_PATH = "assets/pick_curve.json?v=picks1";
const DRAFT_ID = "800000000000000001";
const KEEPER_POS = ["RB", "WR", "FLEX", "K"];                     // capacity 4: User A's four players fill it
const keeperLeague = (over = {}, settings = {}) => ({ ...baseLeague, draft_id: DRAFT_ID, roster_positions: KEEPER_POS, ...over,
  settings: { ...baseLeague.settings, type: 1, max_keepers: 1, ...settings } });
// Standings: User A (roster 9) has 1 win, Bo's Bunch (roster 3) 2, so User A picks first in odd rounds.
const STANDINGS = { 9: { wins: 1, losses: 2, fpts: 301, fpts_decimal: 50 }, 3: { wins: 2, losses: 1, fpts: 280 } };
const standingsRosters = () => rosters.map(r => ({ ...r, settings: { ...STANDINGS[r.roster_id] } }));
const TRADED = [{ season: "2027", round: 2, roster_id: 3, owner_id: 9, previous_owner_id: 3, league_id: L }];
const DRAFT = { draft_id: DRAFT_ID, league_id: L, season: "2026", type: "snake", status: "complete", settings: { rounds: 3, teams: 2 } };
const pickRoutes = ({ traded = TRADED, draft = DRAFT } = {}) => ({ ...baseRoutes(), [`/league/${L}/rosters`]: () => standingsRosters(),
  [`/league/${L}/traded_picks`]: traded, [`/draft/${DRAFT_ID}`]: draft });
const pickStatics = opts => ({ ...makeStatics(opts), [CURVE_PATH]: PICK_CURVE });
const memStorage = (map = new Map()) => ({ map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } });
const PREF_KEY = `megatron.trade.picks.v1|${L}`;
const pickGroup = box => box.children.find(x => x.tagName === "details");
const pickRows = box => all(pickGroup(box)).filter(x => x.tagName === "li");
const pickLabels = box => pickRows(box).map(li => text(li.children[0]).trim());
const tickPick = (box, key, on = true) => { const b = pickRows(box).find(li => li.dataset.pick === key).children[0].children[0]; b.checked = on; b.dispatch("change"); };
const presetBtn = (els, key) => all(els.pickControls).find(x => x.tagName === "button" && x.dataset.preset === key);
const pickSelects = els => all(els.pickControls).filter(x => x.tagName === "select");
const choose = (sel, value) => { sel.value = value; sel.dispatch("change"); };
const summaryOf = els => els.result.children[0];
const pickBlock = els => summaryOf(els).children.find(x => x.className === "season-picks-result");
const summaryWithoutPicks = els => summaryOf(els).children.filter(x => x.className !== "season-picks-result").map(x => x.textContent);
const curveOf = (lg, rule) => PV.buildCurve({ artifact: PICK_CURVE, weights: LL.effectiveWeights(lg.scoring_settings), slots: lg.roster_positions,
  teams: lg.total_rosters, keepers: lg.settings.max_keepers, rounds: 3, pickSixRate: METHOD.prior.rate, keeperRule: rule });
const valueOf = (lg, pick, rule, order) => PV.pickValue({ pick, curve: curveOf(lg, rule), order, rosters: standingsRosters(), teams: lg.total_rosters, rounds: 3, snake: true });
const detailsNamed = (els, title) => els.result.children.find(x => x.tagName === "details" && x.children[0].textContent === title);
// Lets every pending promise chain (a draft-history walk, a re-fill) run to the end.
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
// Every string the picks surfaces render, scrubbed of the allowed sentences, must avoid the page's forbidden words.
function assertNoForbidden(els) {
  const strings = [els.result, els.pickControls, els.minePicks, els.theirsPicks, els.picksNote].flatMap(n => all(n).map(x => x.textContent || ""));
  const scrubbed = strings.map(s => M.ALLOWED_SENTENCES.reduce((x, a) => x.split(a).join(""), s)).join("\n").toLowerCase();
  for (const w of M.FORBIDDEN) assert.ok(!scrubbed.includes(w), `forbidden word "${w}" in: ${scrubbed}`);
}
async function openKeeperPage({ lg = keeperLeague(), staticsOpts, routesOver = {}, storage } = {}) {
  fresh(); statics = pickStatics(staticsOpts); routes = { ...pickRoutes(), ...routesOver }; league = lg;
  state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
  window.localStorage = storage || memStorage();
  const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
  const els = els$($);
  M.init({ els }); FC.setLeague(L);
  await Session.identify("user_a");
  await until(() => /teams loaded/.test(els.status.textContent), "the keeper league's columns");
  return els;
}

async function picksFlow() {
  const store = memStorage();
  try {
    const els = await openKeeperPage({ storage: store });
    await sub("the picks data is read once, only for the keeper league: traded picks, the league's draft, the pick-value table", async () => {
      assert.deepEqual(calls.filter(c => /traded_picks|^\/draft\//.test(c)).sort(), [`/draft/${DRAFT_ID}`, `/league/${L}/traded_picks`]);
      assert.equal(fetched.filter(p => p === CURVE_PATH).length, 1);
    });
    await sub("each column lists its owned picks, collapsed, under the players; a traded pick sits under its current owner, named by its original team", async () => {
      for (const box of [els.minePicks, els.theirsPicks]) { assert.equal(box.hidden, false); assert.equal(pickGroup(box).open, false, "collapsed"); }
      assert.equal(els.minePicks.parent, els.mine.parent, "the group is in the column, under the list");
      assert.equal(pickGroup(els.minePicks).children[0].textContent, "Draft picks (4)");
      assert.deepEqual(pickLabels(els.minePicks), ["2027 R1", "2027 R2", "2027 R2 (from Bo's Bunch)", "2027 R3"]);
      assert.equal(pickGroup(els.theirsPicks).children[0].textContent, "Draft picks (2)");
      assert.deepEqual(pickLabels(els.theirsPicks), ["2027 R1", "2027 R3"]);
      assert.equal(els.picksNote.hidden, true);
      assert.ok(!els.mine.children.some(li => li.dataset.pick), "picks are not player rows");
    });
    await sub("the controls: weighting presets (Balanced pressed), the helper line, the draft order and the keeper rule, defaults first", async () => {
      assert.equal(els.pickControls.hidden, false);
      assert.deepEqual(["win_now", "balanced", "rebuild"].map(k => [presetBtn(els, k).textContent, presetBtn(els, k).attrs["aria-pressed"]]),
        [["Win now", "false"], ["Balanced", "true"], ["Rebuild", "false"]]);
      assert.ok(all(els.pickControls).some(x => x.textContent === "How much a point next season counts: Win now ×0.5, Balanced ×0.8, Rebuild ×1.2."));
      const [order, rule] = pickSelects(els);
      assert.equal(order.parent.children[0].textContent.trim(), "2027 draft order:");
      assert.deepEqual(order.children.map(o => [o.value, o.textContent]), [["unset", "Not set yet"], ["standings", "By this season's standings"]]);
      assert.equal(order.value, "unset");
      assert.equal(rule.parent.children[0].textContent.trim(), "Keeper rule:");
      assert.deepEqual(rule.children.map(o => [o.value, o.textContent]), [["unknown", "Unknown"], ["ladder", "Round drafted − 1 per year kept (waiver pickups: round 12; max 2 years)"]]);
      assert.equal(rule.value, "unknown");
    });

    // Picks only (Review Focus 3): User A gets Bo's Bunch's 2027 R1 and gives its own 2027 R3. Its roster is full.
    tickPick(els.theirsPicks, "2027|1|3"); tickPick(els.minePicks, "2027|3|9");
    await sub("a pick takes no roster spot: no drop prompt, Compare is open", async () => {
      assert.equal(els.mineDrops.hidden, true); assert.equal(els.theirsDrops.hidden, true); assert.equal(els.compare.disabled, false);
    });
    await clickCompare(els, () => !els.result.hidden, "the picks-only comparison");
    const R1 = { season: 2027, round: 1, originalRosterId: 3 }, R3 = { season: 2027, round: 3, originalRosterId: 9 };
    const expected = (rule, order, preset, now = [0, 0]) => {
      const v1 = valueOf(league, R1, rule, order), v3 = valueOf(league, R3, rule, order);
      const { label, w } = PV.PRESETS[preset], fut = v1.value - v3.value;
      return ["You get 2027 R1 (from Bo's Bunch) and give 2027 R3.", `Next season: ${M.signedWhole(fut)} expected points from picks.`,
        M.pickLine("2027 R1 (from Bo's Bunch)", v1), M.pickLine("2027 R3", v3), `Combined at ${label} (next season ×${w}): ${M.signedWhole(now[0] + w * fut)}`,
        "Bo's Bunch gets 2027 R3 (from User A) and gives 2027 R1.", `Next season: ${M.signedWhole(-fut)} expected points from picks.`,
        M.pickLine("2027 R3 (from User A)", v3), M.pickLine("2027 R1", v1), `Combined at ${label} (next season ×${w}): ${M.signedWhole(now[1] - w * fut)}`,
        PICK_VALUES, PICK_AVERAGES, ...(rule === "ladder" ? [PICK_LADDER] : [])];
    };
    await sub("a picks-only trade: this season 0 and no engine call, then each side's next-season and combined lines in whole points", async () => {
      assert.equal(analyzeCalls.length, 0, "no lineup engine call");
      assert.equal(summaryOf(els).children[0].textContent, "This season: 0 pts for both teams over weeks 4–6; no players move, so neither starting lineup changes.");
      const lines = pickBlock(els).children.map(x => x.textContent);
      assert.deepEqual(lines, expected("unknown", "unset", "balanced"));
      assert.match(lines[2], /^2027 R1 \(from Bo's Bunch\): worth about \d+ \(anywhere from pick 1 to 2: \d+–\d+\)$/);
      assert.match(lines[1], /^Next season: [+−]?\d+ expected points from picks\.$/, "whole points");
      assert.ok(!text(els.result).includes(M.STARTERS_ONLY), "no lineup totals, so no starters-only note");
      assert.ok(els.result.children.some(x => x.className === "season-subline" && x.textContent === M.PICKS_SUBLINE_TAIL));
      assert.equal(els.status.textContent, "draft picks compared; no players move");
      assertNoForbidden(els);
    });
    await sub("weighting, keeper rule and draft order recompute the result: no fetch, no engine call, and no Sleeper call beyond the ladder's one draft-history walk; remembered per league", async () => {
      const nCalls = calls.length, nFetched = fetched.length;
      presetBtn(els, "rebuild").dispatch("click");
      assert.equal(presetBtn(els, "rebuild").attrs["aria-pressed"], "true"); assert.equal(presetBtn(els, "balanced").attrs["aria-pressed"], "false");
      assert.deepEqual(pickBlock(els).children.map(x => x.textContent), expected("unknown", "unset", "rebuild"));
      assert.equal(calls.length, nCalls, "weighting: no Sleeper call");
      const [order, rule] = pickSelects(els);
      choose(rule, "ladder");
      assert.deepEqual(pickBlock(els).children.map(x => x.textContent), expected("ladder", "unset", "rebuild"));
      assert.notEqual(valueOf(league, R3, "ladder", "unset").value, valueOf(league, R3, "unknown", "unset").value, "the keeper rule moves a round-3 pick");
      // The first switch to the ladder walks this league's draft history once (Task 4). This league has no draft list
      // on Sleeper and no previous season, so the history is unavailable and the lines stay as they are.
      await settle();
      assert.deepEqual(calls.slice(nCalls), [`/league/${L}`, `/league/${L}/drafts`], "the ladder's one draft-history walk");
      assert.deepEqual(pickBlock(els).children.map(x => x.textContent), expected("ladder", "unset", "rebuild"));
      const nWalked = calls.length;
      choose(order, "standings");
      const lines = pickBlock(els).children.map(x => x.textContent);
      assert.deepEqual(lines, expected("ladder", "standings", "rebuild"));
      // Odd rounds: User A (fewest wins) picks first, so Bo's Bunch's R1 is pick 2 and User A's R3 is pick 5.
      assert.match(lines[2], /^2027 R1 \(from Bo's Bunch\): worth about \d+ at pick 2 by current standings \(round range 1–2: \d+–\d+\)$/);
      assert.match(lines[3], /^2027 R3: worth about \d+ at pick 5 by current standings \(round range 5–6: \d+–\d+\)$/);
      choose(rule, "unknown"); choose(rule, "ladder");
      await settle();
      assert.equal(calls.length, nWalked, "no Sleeper call after the walk"); assert.equal(fetched.length, nFetched, "no fetch");
      assert.equal(analyzeCalls.length, 0); assert.equal(els.result.hidden, false, "the result stays on screen");
      assert.deepEqual(JSON.parse(store.map.get(PREF_KEY)), { preset: "rebuild", order: "standings", keeperRule: "ladder" });
      assertNoForbidden(els);
    });

    // The same player trade without and with a pick: this season's numbers are the engine's either way.
    tickPick(els.theirsPicks, "2027|1|3", false); tickPick(els.minePicks, "2027|3|9", false);
    tickPlayer(els.mine, "d"); tickPlayer(els.theirs, "b");
    await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 1, "the players-only comparison");
    const plain = { summary: summaryWithoutPicks(els), sides: text(els.result.children.find(x => x.tagName === "table")),
      weeks: text(detailsNamed(els, "Week-by-week lineup totals")), assumptions: text(detailsNamed(els, "Assumptions")),
      subline: els.result.children.find(x => x.className === "season-subline").textContent, notes: text(detailsNamed(els, "Engine notes")) };
    await sub("no pick in the offer: no pick lines, today's subline tail and engine note", async () => {
      assert.equal(pickBlock(els), undefined);
      assert.ok(!/Next season|Combined at|Pick values/.test(text(els.result)));
      assert.ok(plain.subline.endsWith("Keeper value and draft picks are not valued, so no overall grade is shown."));
      assert.ok(plain.notes.includes(ENGINE_NOTE));
    });
    tickPick(els.theirsPicks, "2027|1|3");
    await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 2, "the same comparison with a pick");
    await sub("a player and a pick: this season identical to the trade without the pick, plus next-season and combined lines", async () => {
      for (const k of ["give", "receive", "drops", "excludeWeeks", "rosterIds", "currentWeek"]) assert.deepEqual(analyzeCalls[1][k], analyzeCalls[0][k], k);
      assert.deepEqual(summaryWithoutPicks(els), plain.summary, "the lineup lines, caveats and starters-only note are unchanged");
      assert.equal(text(els.result.children.find(x => x.tagName === "table")), plain.sides);
      assert.equal(text(detailsNamed(els, "Week-by-week lineup totals")), plain.weeks);
      assert.equal(text(detailsNamed(els, "Assumptions")), plain.assumptions);
      const d = analyzeResults[1].sides.map(s => s.delta), v1 = valueOf(league, R1, "ladder", "standings"), w = 1.2;
      assert.deepEqual(pickBlock(els).children.map(x => x.textContent), [
        "You get 2027 R1 (from Bo's Bunch).", `Next season: ${M.signedWhole(v1.value)} expected points from picks.`,
        M.pickLine("2027 R1 (from Bo's Bunch)", v1), `Combined at Rebuild (next season ×1.2): ${M.signedWhole(d[0] + w * v1.value)}`,
        "Bo's Bunch gives 2027 R1.", `Next season: ${M.signedWhole(-v1.value)} expected points from picks.`,
        M.pickLine("2027 R1", v1), `Combined at Rebuild (next season ×1.2): ${M.signedWhole(d[1] - w * v1.value)}`,
        PICK_VALUES, PICK_AVERAGES, PICK_LADDER]);
      const subline = els.result.children.find(x => x.className === "season-subline").textContent;
      assert.equal(subline, plain.subline.replace("Keeper value and draft picks are not valued, so no overall grade is shown.", M.PICKS_SUBLINE_TAIL));
      const notes = text(detailsNamed(els, "Engine notes"));
      assert.ok(notes.includes(M.engineWarningText(ENGINE_NOTE, true)) && !notes.includes("No keeper or future-pick value"), notes);
      assert.equal(notes, plain.notes.replace(ENGINE_NOTE, M.engineWarningText(ENGINE_NOTE, true)), "only that note changes");
      assertNoForbidden(els);
    });
    await sub("the choices are restored on the next visit to this league", async () => {
      const again = await openKeeperPage({ storage: store });
      assert.equal(presetBtn(again, "rebuild").attrs["aria-pressed"], "true");
      assert.deepEqual(pickSelects(again).map(s => s.value), ["standings", "ladder"]);
      store.map.set(PREF_KEY, "{not json");
      const broken = await openKeeperPage({ storage: store });
      assert.equal(presetBtn(broken, "balanced").attrs["aria-pressed"], "true", "unreadable storage: the defaults");
      const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
      const denied = await openKeeperPage({ storage: throwing });
      presetBtn(denied, "win_now").dispatch("click");
      assert.equal(presetBtn(denied, "win_now").attrs["aria-pressed"], "true", "storage that throws never breaks the controls");
    });
  } finally { delete window.localStorage; }
}

// No pick in the offer renders exactly as a redraft league with the same rosters, scoring and slots (regression pin).
async function picksRegressionPin() {
  const run = async lg => {
    const els = lg.settings.type === 1 ? await openKeeperPage({ lg }) : await (async () => {
      fresh(); statics = makeStatics(); routes = { ...baseRoutes(), [`/league/${L}/rosters`]: () => standingsRosters() }; league = lg;
      state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
      const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
      const e = els$($); M.init({ els: e }); FC.setLeague(L); await Session.identify("user_a");
      await until(() => /teams loaded/.test(e.status.textContent), "the redraft columns");
      return e;
    })();
    tickPlayer(els.mine, "a"); tickPlayer(els.theirs, "c");
    await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 1, "the comparison");
    return { result: text(els.result), status: els.status.textContent };
  };
  try {
    const redraft = await run({ ...baseLeague, roster_positions: KEEPER_POS });
    const keeper = await run(keeperLeague());
    assert.deepEqual(keeper, redraft);
  } finally { delete window.localStorage; }
}

// Review Focus 4: a failed traded_picks or draft read, a missing or malformed table, unknown rounds: no pick rows, one
// line saying why, and the page compares players exactly as before.
async function picksUnavailable() {
  const TIMEOUT = "Sleeper did not respond within 4 seconds. Check your connection and try again.";
  const cases = [
    ["traded_picks fails", { routesOver: { [`/league/${L}/traded_picks`]: new Error("HTTP 500") } },
      "Draft picks unavailable: Sleeper's list of traded picks did not load (HTTP 500)."],
    ["the draft read times out", { routesOver: { [`/draft/${DRAFT_ID}`]: new Error(TIMEOUT) } },
      "Draft picks unavailable: the league's draft settings did not load (Sleeper did not respond within 4 seconds. Check your connection and try again)."],
    ["no draft rounds anywhere", { routesOver: { [`/draft/${DRAFT_ID}`]: { ...DRAFT, settings: {} }, [`/league/${L}/traded_picks`]: [] } },
      "Draft picks unavailable: the number of draft rounds is unknown."],
    ["the league has no draft", { lg: keeperLeague({ draft_id: null }) }, "Draft picks unavailable: the league has no draft on Sleeper."],
    ["the pick-value table is missing", { tableMissing: true }, "Draft picks unavailable: the pick-value table did not load (HTTP 404)."],
    ["the pick-value table is malformed", { table: { ...PICK_CURVE, kind: "other" } }, "Draft picks unavailable: malformed pick curve: unknown kind or schema version."],
  ];
  try {
    for (const [what, opts, line] of cases) {
      const els = await (async () => {
        if (!opts.tableMissing && !opts.table) return openKeeperPage(opts);
        // The table is read once per document: these two cases change it before the page opens.
        fresh(); statics = pickStatics();
        if (opts.tableMissing) delete statics[CURVE_PATH]; else statics[CURVE_PATH] = opts.table;
        routes = pickRoutes(); league = keeperLeague(); state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
        window.localStorage = memStorage();
        const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
        const e = els$($); M.init({ els: e }); FC.setLeague(L); await Session.identify("user_a");
        await until(() => /teams loaded/.test(e.status.textContent), "the columns");
        return e;
      })();
      assert.equal(els.status.textContent, "2 teams loaded — you are User A", what);
      assert.equal(els.picksNote.hidden, false, what); assert.equal(els.picksNote.textContent, line, what);
      for (const box of [els.minePicks, els.theirsPicks]) { assert.equal(box.hidden, true, what); assert.equal(box.children.length, 0, what); }
      assert.equal(els.pickControls.hidden, true, what);
      tickPlayer(els.mine, "d"); tickPlayer(els.theirs, "b");
      await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 1, `${what}: the player comparison`);
      assert.equal(els.status.textContent, "lineups compared for weeks 4–6", what);
      assert.ok(!/Next season|Combined at|Pick values/.test(text(els.result)), what);
      assertNoForbidden(els);
    }
  } finally { delete window.localStorage; }
}

// Dynasty and two-quarterback keeper leagues: the reason line, no pick reads at all; redraft stays silent (ownerFlow).
async function picksGated() {
  try {
    for (const [what, lg, line] of [
      ["dynasty", keeperLeague({}, { type: 2 }), PV.REASONS.dynasty],
      ["superflex", keeperLeague({ roster_positions: ["RB", "WR", "SUPER_FLEX", "K"] }), PV.REASONS.two_qb],
      ["two QB slots", keeperLeague({ roster_positions: ["QB", "QB", "RB", "WR", "K"] }), PV.REASONS.two_qb],
    ]) {
      const els = await openKeeperPage({ lg });
      assert.equal(els.picksNote.hidden, false, what); assert.equal(els.picksNote.textContent, line, what);
      assert.ok(!calls.some(c => /traded_picks|^\/draft\//.test(c)), `${what}: ${calls.join(", ")}`);
      assert.ok(!fetched.includes(CURVE_PATH), what);
      assert.equal(els.minePicks.hidden, true, what); assert.equal(els.pickControls.hidden, true, what);
      assert.equal(els.cols.hidden, false, `${what}: the players are still listed`);
      assertNoForbidden(els);
    }
    // A best-ball keeper league has no lineup comparison, so no pick UI and no pick reads.
    const bb = await (async () => {
      fresh(); statics = pickStatics({ lastWeek: 17 }); routes = pickRoutes(); league = keeperLeague({}, { best_ball: 1 });
      state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog(); window.localStorage = memStorage();
      const { $ } = tradeDom(`https://example.test/Megatron/trade.html?league=${L}`);
      const e = els$($); M.init({ els: e }); FC.setLeague(L); await Session.identify("user_a");
      await until(() => !e.result.hidden, "the best-ball note");
      return e;
    })();
    assert.equal(bb.result.children[0].textContent, BEST_BALL);
    assert.ok(!calls.some(c => /traded_picks|^\/draft\//.test(c)) && !fetched.includes(CURVE_PATH), calls.join(", "));
    for (const n of [bb.minePicks, bb.pickControls, bb.picksNote]) assert.equal(n.hidden, true);
  } finally { delete window.localStorage; }
}

// A traded player in his team's top max_keepers by rest-of-season value is named once; one outside it is not.
async function picksLikelyKeeper() {
  try {
    const els = await openKeeperPage({ staticsOpts: { lastWeek: 17 } });   // ros_value needs every week through 17
    tickPlayer(els.mine, "a"); tickPlayer(els.mine, "d"); tickPlayer(els.theirs, "b"); tickPlayer(els.theirs, "c"); tickPick(els.theirsPicks, "2027|3|3");
    await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 1, "the comparison with likely keepers");
    const lines = pickBlock(els).children.map(x => x.textContent);
    assert.deepEqual(lines.slice(-2), ["A Back is likely one of User A's keepers; his value next season is not counted.",
      "B Wide is likely one of Bo's Bunch's keepers; his value next season is not counted."]);
    assert.deepEqual(lines.slice(-4, -2), [PICK_VALUES, PICK_AVERAGES], "after the two notes");
    assert.ok(!/D Deep is likely|C Run is likely/.test(text(els.result)));
    assertNoForbidden(els);
  } finally { delete window.localStorage; }
}

// A pick two seasons ahead: listed under its owner, valued at its round average (this season's standings say nothing
// about that draft) and weighted w^2; the copy says "future seasons" and the Combined label lists the factors applied.
async function picksFutureSeason() {
  try {
    const traded = [...TRADED, { season: "2028", round: 1, roster_id: 9, owner_id: 3, previous_owner_id: 9, league_id: L }];
    const els = await openKeeperPage({ routesOver: { [`/league/${L}/traded_picks`]: traded } });
    assert.equal(pickGroup(els.theirsPicks).children[0].textContent, "Draft picks (6)");
    assert.deepEqual(pickLabels(els.theirsPicks), ["2027 R1", "2027 R3", "2028 R1", "2028 R1 (from User A)", "2028 R2", "2028 R3"]);
    assert.equal(pickGroup(els.minePicks).children[0].textContent, "Draft picks (6)");
    tickPick(els.theirsPicks, "2028|1|9");
    await clickCompare(els, () => !els.result.hidden, "the future-season comparison");
    const v = valueOf(league, { season: 2028, round: 1, originalRosterId: 9 }, "unknown", "unset");
    assert.deepEqual(pickBlock(els).children.map(x => x.textContent).slice(0, 4), ["You get 2028 R1.",
      `Future seasons: ${M.signedWhole(v.value)} expected points from picks.`, M.pickLine("2028 R1", v),
      `Combined at Balanced (the season after ×0.64): ${M.signedWhole(0.64 * v.value)}`]);
    assert.ok(els.result.children.some(x => x.className === "season-subline" && x.textContent === M.PICKS_SUBLINE_TAIL_LATER));
    // Under the standings order a 2028 pick still takes the round average, with the range form of the line.
    choose(pickSelects(els)[0], "standings");
    const lines = pickBlock(els).children.map(x => x.textContent);
    assert.equal(lines[2], M.pickLine("2028 R1", v));
    assert.match(lines[2], /^2028 R1: worth about \d+ \(anywhere from pick 1 to 2: \d+–\d+\)$/);
    // A mixed 2027 + 2028 offer under Balanced lists both factors; the 2027 pick still follows the standings.
    tickPick(els.theirsPicks, "2027|1|3");
    await clickCompare(els, () => !els.result.hidden && /2027 R1/.test(text(els.result)), "the mixed comparison");
    const mixed = pickBlock(els).children.map(x => x.textContent);
    assert.ok(mixed.some(l => l.startsWith("Combined at Balanced (next season ×0.8, the season after ×0.64): ")), mixed.join("\n"));
    assert.match(mixed.find(l => /^2027 R1/.test(l)), /by current standings/);
    assertNoForbidden(els);
  } finally { delete window.localStorage; }
}

// An auction keeper draft has no picks to trade: the unavailable line, no pick rows, the players still compare.
async function picksAuction() {
  try {
    const els = await openKeeperPage({ routesOver: { [`/draft/${DRAFT_ID}`]: { ...DRAFT, type: "auction" } } });
    assert.equal(els.picksNote.hidden, false);
    assert.equal(els.picksNote.textContent, "Draft picks unavailable: this league's draft is an auction, which has no draft picks to trade.");
    for (const box of [els.minePicks, els.theirsPicks]) { assert.equal(box.hidden, true); assert.equal(box.children.length, 0); }
    assert.equal(els.pickControls.hidden, true);
    tickPlayer(els.mine, "d"); tickPlayer(els.theirs, "b");
    await clickCompare(els, () => !els.result.hidden && analyzeCalls.length === 1, "the auction league's player comparison");
    assert.ok(!/Next season|Combined at|Pick values/.test(text(els.result)));
    assertNoForbidden(els);
    const other = await openKeeperPage({ routesOver: { [`/draft/${DRAFT_ID}`]: { ...DRAFT, type: "salary" } } });
    assert.equal(other.picksNote.textContent, "Draft picks unavailable: this league's draft type has no draft picks to trade.");
  } finally { delete window.localStorage; }
}

// ---- the keeper ladder: two-year cap and the keeper-pick conflict (Task 4) ----
// A five-round draft, so a keeper's cost can be a real pick (R3 or later). The current league's 2026 draft is the
// newest anchor; two earlier seasons sit behind it through previous_league_id. Sleeper lists a kept player as a pick
// with is_keeper: true at the round he cost. All ids synthetic.
const PREV1 = "900000000000000776", PREV2 = "900000000000000775";
const D25 = "800000000000000002", D24 = "800000000000000003";
const DRAFT5 = { ...DRAFT, settings: { rounds: 5, teams: 2 } };
const draftPick = (player_id, round, keeper = false) => ({ player_id, round, is_keeper: keeper ? true : null });
// Fresh 2026 picks: A Back R4 (a 2027 R3 to keep), B Wide and D Deep R5 (a 2027 R4), C Run R1 (cost R0: not
// keepable). E Slot and F Flex were never drafted (waiver pickups, R12).
const FRESH_2026 = [draftPick("c", 1), draftPick("a", 4), draftPick("b", 5), draftPick("d", 5)];
const historyRoutes = ({ y2026 = FRESH_2026, y2025 = [], y2024 = [] } = {}) => ({
  [`/draft/${DRAFT_ID}`]: DRAFT5,
  [`/league/${L}/drafts`]: [{ draft_id: DRAFT_ID, status: "complete", season: "2026" }],
  [`/draft/${DRAFT_ID}/picks`]: y2026,
  [`/league/${PREV1}`]: { league_id: PREV1, previous_league_id: PREV2 },
  [`/league/${PREV1}/drafts`]: [{ draft_id: D25, status: "complete", season: "2025" }],
  [`/draft/${D25}/picks`]: y2025,
  [`/league/${PREV2}`]: { league_id: PREV2, previous_league_id: null },
  [`/league/${PREV2}/drafts`]: [{ draft_id: D24, status: "complete", season: "2024" }],
  [`/draft/${D24}/picks`]: y2024,
});
const ladderLeague = () => keeperLeague({ previous_league_id: PREV1 });
const HISTORY_CALLS = [`/league/${L}/drafts`, `/draft/${DRAFT_ID}/picks`, `/league/${PREV1}/drafts`, `/draft/${D25}/picks`, `/league/${PREV2}/drafts`, `/draft/${D24}/picks`];
const historyCalls = () => calls.filter(c => /\/drafts$|^\/draft\/[^/]+\/picks$/.test(c));
const ladderStore = () => memStorage(new Map([[PREF_KEY, JSON.stringify({ preset: "balanced", order: "unset", keeperRule: "ladder" })]]));
const blockLines = els => pickBlock(els).children.map(x => x.textContent);
const conflictLines = els => blockLines(els).filter(t => / would cost their /.test(t));
const keeperLinesOf = els => blockLines(els).filter(t => / is likely one of /.test(t));
const conflictLine = (team, player, label) => `${team}'s likely keeper ${player} would cost their ${label} — the pick in this offer.`;
const likelyLine = (player, team) => `${player} is likely one of ${team}'s keepers; his value next season is not counted.`;
// The offer from scratch: every ticked player and pick is unticked first.
function setOffer(els, { give = [], receive = [], givePicks = [], getPicks = [] }) {
  for (const ul of [els.mine, els.theirs]) for (const li of ul.children) {
    const box = li.children[0] && li.children[0].children[0];
    if (box && box.checked && !box.disabled) { box.checked = false; box.dispatch("change"); }
  }
  for (const box of [els.minePicks, els.theirsPicks]) for (const li of pickRows(box)) {
    const b = li.children[0].children[0];
    if (b.checked) { b.checked = false; b.dispatch("change"); }
  }
  for (const id of give) tickPlayer(els.mine, id);
  for (const id of receive) tickPlayer(els.theirs, id);
  for (const k of givePicks) tickPick(els.minePicks, k);
  for (const k of getPicks) tickPick(els.theirsPicks, k);
}
const compareOffer = async (els, offer, what) => { setOffer(els, offer); await clickCompare(els, () => !els.result.hidden, what); };
const dropBtnOf = (ul, id) => ul.children.find(li => li.dataset.id === id).children.find(x => x.className === "season-drop-btn");
// Picks only: User A gives its own 2027 R3 for Bo's Bunch's 2027 R1. A Back, User A's likely keeper, costs that R3.
const SWAP = { givePicks: ["2027|3|9"], getPicks: ["2027|1|3"] };
const ONE = conflictLine("User A", "A Back", "2027 R3");

async function picksKeeperConflict() {
  try {
    const els = await openKeeperPage({ lg: ladderLeague(), staticsOpts: { lastWeek: 17 }, routesOver: historyRoutes() });
    await settle();
    const atLoad = historyCalls().length;
    await compareOffer(els, SWAP, "the picks-only comparison, unknown rule");
    await settle();
    await sub("the unknown rule: the page as before, no conflict line, no draft-history request (at load or after)", async () => {
      assert.equal(atLoad, 0, "no draft-history request at load");
      assert.deepEqual(blockLines(els).slice(-2), [PICK_VALUES, PICK_AVERAGES]);
      assert.deepEqual(conflictLines(els), []);
      assert.deepEqual(historyCalls(), []);
      assert.ok(!calls.includes(`/league/${PREV1}`), calls.join(", "));
    });
    const [order, rule] = pickSelects(els);
    await sub("switched to the ladder with the result on screen: nothing while the history is pending, then one walk and the line", async () => {
      choose(rule, "ladder");
      assert.deepEqual(conflictLines(els), [], "while the history is pending: no conflict line");
      await until(() => conflictLines(els).length > 0, "the conflict line once the history arrives");
      const lines = pickBlock(els).children;
      assert.deepEqual(lines.slice(-4).map(x => x.textContent), [PICK_VALUES, PICK_AVERAGES, PICK_LADDER, ONE]);
      assert.equal(lines[lines.length - 1].className, "season-summary-note");
      assert.deepEqual(historyCalls(), HISTORY_CALLS, "the chain from this league back, once");
      assertNoForbidden(els);
    });
    await sub("afterwards the rule, weighting and order recompute in place with no Sleeper request", async () => {
      const n0 = calls.length;
      choose(rule, "unknown"); assert.deepEqual(conflictLines(els), []);
      choose(rule, "ladder"); assert.deepEqual(conflictLines(els), [ONE]);
      presetBtn(els, "rebuild").dispatch("click"); choose(order, "standings");
      assert.deepEqual(conflictLines(els), [ONE]);
      await settle();
      assert.equal(calls.length, n0);
    });
    // Further offers in this load: the history is not read again.
    const offers = [
      ["User A still holds a 2027 R3 afterwards (it gets Bo's Bunch's): no line", { givePicks: ["2027|3|9"], getPicks: ["2027|3|3"] }, []],
      ["both sides: Bo's Bunch gives the 2027 R4 its keeper B Wide would cost, named from its own side",
        { givePicks: ["2027|3|9"], getPicks: ["2027|4|3"] }, [ONE, conflictLine("Bo's Bunch", "B Wide", "2027 R4")]],
      ["the keeper costs a different round from the pick in the offer: no line", { givePicks: ["2027|4|9"], getPicks: ["2027|1|3"] }, []],
    ];
    for (const [what, offer, expected] of offers) {
      await sub(what, async () => {
        await compareOffer(els, offer, what);
        await settle();
        assert.deepEqual(conflictLines(els), expected);
        assertNoForbidden(els);
      });
    }
    await sub("players move: the check reads the roster after the trade, and the line follows the keeper lines", async () => {
      // User A gets B Wide (its best player after the trade, a 2027 R4 to keep) and gives D Deep and its own 2027 R4.
      await compareOffer(els, { give: ["d"], receive: ["b"], givePicks: ["2027|4|9"] }, "the player comparison");
      assert.equal(els.status.textContent, "lineups compared for weeks 4–17");
      assert.deepEqual(blockLines(els).slice(-2), [likelyLine("B Wide", "Bo's Bunch"), conflictLine("User A", "B Wide", "2027 R4")]);
      assert.deepEqual(conflictLines(els), [conflictLine("User A", "B Wide", "2027 R4")]);
      assertNoForbidden(els);
    });
    // Fix round 1, M1: a player a side marks to DROP leaves its post-trade roster, as in the lineup engine. User A gets
    // C Run (no one may keep him: cost R0) with nothing going back, so it is one over the roster limit and drops A Back;
    // its best keepable player after the trade is then D Deep, who costs a 2027 R4.
    for (const [what, givePicks, expected] of [
      ["a dropped likely keeper leaves the roster: the next keepable player's pick is named", ["2027|3|9", "2027|4|9"], [conflictLine("User A", "D Deep", "2027 R4")]],
      ["a dropped likely keeper leaves the roster: no line when the next one's pick is not in the offer", ["2027|3|9"], []],
    ]) {
      await sub(what, async () => {
        setOffer(els, { receive: ["c"], givePicks });
        dropBtnOf(els.mine, "a").dispatch("click");
        await clickCompare(els, () => !els.result.hidden, what);
        assert.equal(els.status.textContent, "lineups compared for weeks 4–17");
        assert.deepEqual(analyzeCalls[analyzeCalls.length - 1].drops, { 9: ["a"] }, "the drop reaches the engine too");
        assert.deepEqual(conflictLines(els), expected);
        assertNoForbidden(els);
      });
    }
    assert.deepEqual(historyCalls(), HISTORY_CALLS, "one walk for the whole load");
    await sub("a new league load discards the history; under the remembered ladder rule the new load walks again at once", async () => {
      await Session.refresh({ scope: "rosters" });
      await until(() => els.status.textContent === "2 teams loaded — you are User A", "the reload");
      await until(() => historyCalls().length === 2 * HISTORY_CALLS.length, "the second walk, at load");
      await settle();
      await compareOffer(els, SWAP, "the picks-only comparison after the reload");
      assert.deepEqual(conflictLines(els), [ONE]);
      assert.equal(historyCalls().length, 2 * HISTORY_CALLS.length);
    });
    // X's holdings count as well as the offer: with Bo's Bunch's 2027 R3 already User A's, giving its own R3 leaves
    // one, so no line; giving both leaves none, and the line names the first one given.
    const traded = [...TRADED, { season: "2027", round: 3, roster_id: 3, owner_id: 9, previous_owner_id: 3, league_id: L }];
    const more = await openKeeperPage({ lg: ladderLeague(), staticsOpts: { lastWeek: 17 }, routesOver: { ...historyRoutes(), [`/league/${L}/traded_picks`]: traded }, storage: ladderStore() });
    await sub("a 2027 R3 User A already holds from a past trade keeps the line away; giving both brings it", async () => {
      await until(() => historyCalls().length === HISTORY_CALLS.length, "the walk, started at load under the remembered ladder rule");
      await settle();
      await compareOffer(more, SWAP, "the picks-only comparison, two R3s held");
      assert.deepEqual(conflictLines(more), []);
      await compareOffer(more, { givePicks: ["2027|3|3", "2027|3|9"], getPicks: ["2027|1|3"] }, "giving both R3s");
      assert.deepEqual(conflictLines(more), [conflictLine("User A", "A Back", "2027 R3 (from Bo's Bunch)")]);
      assert.equal(historyCalls().length, HISTORY_CALLS.length);
    });
  } finally { delete window.localStorage; }
}

// A third-year keeper: drafted 2024 R6, kept 2025 (R5) and 2026 (R4). His 2027 cost is still R3, but he has been kept
// the most allowed years, so he is neither named as a likely keeper nor used for the conflict; D Deep (2026 R5, a 2027
// R4) is User A's next keepable player and takes his place.
async function picksKeeperCap() {
  try {
    const routesOver = historyRoutes({ y2026: [draftPick("c", 1), draftPick("a", 4, true), draftPick("b", 5), draftPick("d", 5)],
      y2025: [draftPick("a", 5, true)], y2024: [draftPick("a", 6)] });
    const els = await openKeeperPage({ lg: ladderLeague(), staticsOpts: { lastWeek: 17 }, routesOver });
    const rule = pickSelects(els)[1];
    choose(rule, "ladder");   // no result on screen: switching to the ladder starts the walk
    await until(() => historyCalls().length === HISTORY_CALLS.length, "the draft-history walk");
    await settle();
    await sub("the conflict skips the third-year keeper: the next keepable player's pick is named", async () => {
      await compareOffer(els, { givePicks: ["2027|3|9", "2027|4|9"], getPicks: ["2027|1|3"] }, "the picks-only comparison");
      assert.deepEqual(conflictLines(els), [conflictLine("User A", "D Deep", "2027 R4")]);
      assert.ok(!/A Back/.test(blockLines(els).join("\n")), blockLines(els).join("\n"));
    });
    await sub("the likely-keeper lines skip him too; under the unknown rule he is named, as before", async () => {
      await compareOffer(els, { give: ["a", "d"], receive: ["b", "c"], givePicks: ["2027|5|9"] }, "the player comparison");
      assert.deepEqual(keeperLinesOf(els), [likelyLine("D Deep", "User A"), likelyLine("B Wide", "Bo's Bunch")]);
      assert.deepEqual(conflictLines(els), []);
      choose(rule, "unknown");
      assert.deepEqual(keeperLinesOf(els), [likelyLine("A Back", "User A"), likelyLine("B Wide", "Bo's Bunch")]);
      choose(rule, "ladder");
      assert.deepEqual(keeperLinesOf(els), [likelyLine("D Deep", "User A"), likelyLine("B Wide", "Bo's Bunch")]);
      assert.deepEqual(historyCalls(), HISTORY_CALLS, "walked once");
      assertNoForbidden(els);
    });
    // Fix round 2: A Back was kept in 2024 (R7) and 2025 (R6), then dropped and picked back up -- no 2026 pick. He
    // keeps his original round (league rule), and his keeper run ended before the newest draft, so a 2027 keep is his
    // first: he is User A's likely keeper again, not skipped. Only that keep decays him -- the 2026 draft he missed was
    // not a keep (owner, 2026-11-16) -- so he costs a 2027 R5. (D Deep, 2026 R7, would cost a 2027 R6.)
    const repicked = await openKeeperPage({ lg: ladderLeague(), staticsOpts: { lastWeek: 17 }, storage: ladderStore(),
      routesOver: historyRoutes({ y2026: [draftPick("c", 1), draftPick("b", 5), draftPick("d", 7)],
        y2025: [draftPick("a", 6, true)], y2024: [draftPick("a", 7, true)] }) });
    await sub("a keeper dropped and picked back up keeps his round, and his kept run restarts", async () => {
      await until(() => historyCalls().length === HISTORY_CALLS.length, "the walk at load");
      await settle();
      await compareOffer(repicked, { givePicks: ["2027|5|9"], getPicks: ["2027|1|3"] }, "giving the 2027 R5");
      assert.deepEqual(conflictLines(repicked), [conflictLine("User A", "A Back", "2027 R5")]);
      await compareOffer(repicked, { give: ["a"], receive: ["c"], givePicks: ["2027|5|9"] }, "trading him");
      assert.deepEqual(keeperLinesOf(repicked), [likelyLine("A Back", "User A")]);
      assertNoForbidden(repicked);
    });
  } finally { delete window.localStorage; }
}

// The history cannot be read: the conflict line (and the ladder-aware ranking) drop out and nothing else changes.
async function picksKeeperHistoryFails() {
  const BIG = { give: ["a", "d"], receive: ["b", "c"], givePicks: ["2027|3|9"] };
  const same = async (els, what) => {
    await compareOffer(els, SWAP, `${what}: picks only`);
    await settle();
    assert.deepEqual(conflictLines(els), [], `${what}: no conflict line without the history`);
    assert.deepEqual(blockLines(els).slice(-3), [PICK_VALUES, PICK_AVERAGES, PICK_LADDER], what);
    await compareOffer(els, BIG, `${what}: players and a pick`);
    await settle();
    assert.equal(els.status.textContent, "lineups compared for weeks 4–17", what);
    // Today's ranking: A Back is User A's likely keeper again, and no line says what his pick would cost.
    assert.deepEqual(blockLines(els).slice(-5), [PICK_VALUES, PICK_AVERAGES, PICK_LADDER,
      likelyLine("A Back", "User A"), likelyLine("B Wide", "Bo's Bunch")], what);
    assert.ok(!/Draft picks unavailable/.test(text(els.result)), `${what}: no error line`);
    assertNoForbidden(els);
  };
  try {
    // The league's draft list fails and there is no earlier season: the walk returns nothing.
    const failedRead = await openKeeperPage({ lg: keeperLeague(), staticsOpts: { lastWeek: 17 },
      routesOver: { ...historyRoutes(), [`/league/${L}/drafts`]: new Error("HTTP 500") }, storage: ladderStore() });
    await sub("a failed draft-history read", async () => {
      await same(failedRead, "failed read");
      assert.deepEqual(historyCalls(), [`/league/${L}/drafts`], "tried once in this load, not retried");
    });
    // Fix round 1, I2: the current league's own draft list (or its picks) fails while the earlier seasons would load,
    // with picks that would re-rank the keepers (A Back's 2025 R3 alone would make him unkeepable). Without the newest
    // draft the history cannot be read: the walk stops there and returns nothing.
    const older = { y2025: [draftPick("a", 3), draftPick("b", 6), draftPick("d", 7)], y2024: [draftPick("a", 8)] };
    for (const [what, route, tried] of [
      ["the current league's draft list fails (earlier seasons would load)", `/league/${L}/drafts`, [`/league/${L}/drafts`]],
      ["the current league's draft picks fail (earlier seasons would load)", `/draft/${DRAFT_ID}/picks`, [`/league/${L}/drafts`, `/draft/${DRAFT_ID}/picks`]],
    ]) {
      const noNewest = await openKeeperPage({ lg: ladderLeague(), staticsOpts: { lastWeek: 17 },
        routesOver: { ...historyRoutes(older), [route]: new Error("HTTP 500") }, storage: ladderStore() });
      await sub(what, async () => {
        await same(noNewest, what);
        assert.deepEqual(historyCalls(), tried, "the walk stops at the missing newest draft");
      });
    }
    // The walk itself throws.
    const real = Keepers.buildOriginalByPlayerId;
    Keepers.buildOriginalByPlayerId = async () => { throw new Error("walk failed"); };
    try {
      const threw = await openKeeperPage({ lg: ladderLeague(), staticsOpts: { lastWeek: 17 }, routesOver: historyRoutes(), storage: ladderStore() });
      await sub("a draft-history walk that throws", async () => same(threw, "thrown walk"));
    } finally { Keepers.buildOriginalByPlayerId = real; }
  } finally { delete window.localStorage; }
}

// Fix round 1, M2: when this league's remembered keeper rule is already the ladder, the walk starts at the end of the
// load, so it is usually done before the first comparison. A remembered unknown rule still reads nothing.
async function picksKeeperWalkAtLoad() {
  try {
    const els = await openKeeperPage({ lg: ladderLeague(), staticsOpts: { lastWeek: 17 }, routesOver: historyRoutes(), storage: ladderStore() });
    await sub("a remembered ladder rule starts the draft-history walk at load, before any comparison", async () => {
      await until(() => historyCalls().length === HISTORY_CALLS.length, "the walk at load");
      assert.equal(els.result.hidden, true, "no result on screen yet");
      await settle();
      assert.deepEqual(historyCalls(), HISTORY_CALLS);
    });
    await sub("that walk is the only one: the first comparison has the line at once, and toggles read nothing more", async () => {
      await compareOffer(els, SWAP, "the first comparison");
      assert.deepEqual(conflictLines(els), [ONE], "the history was already in hand");
      const rule = pickSelects(els)[1];
      choose(rule, "unknown"); choose(rule, "ladder");
      await settle();
      assert.deepEqual(historyCalls(), HISTORY_CALLS);
    });
    await openKeeperPage({ lg: ladderLeague(), staticsOpts: { lastWeek: 17 }, routesOver: historyRoutes() });   // remembered: unknown (default)
    await settle();
    await sub("a remembered unknown rule reads no draft history at load", async () => { assert.deepEqual(historyCalls(), []); });
  } finally { delete window.localStorage; }
}

// ============================ Part 3: trade.html's mode resolution ============================
const html = fs.readFileSync(path.join(__dirname, "..", "site", "trade.html"), "utf8");
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]).find(s => /leagueNavigation/.test(s));
// Synthetic league ids: A is the published board's own league (its league
// block names it), B any other Sleeper league. The site's code names neither.
const A = "100000000000000001", B = "100000000000000002";
const boardFor = (over = {}) => ({ season: 2026, league: { slug: "leaguea", name: "League A", league_id: A, platform: "sleeper", keeper_rules: "ladder",
  teams: 12, sleeper_scoring: { rec: 1, pass_td: 6 }, ...over }, data_through: "2025-wk18", generated_at: new Date().toISOString(), model: "transformer", players: [] });
async function runPage(href) {
  const dom = tradeDom(href);
  global.FC = FC; global.Session = Session; global.SeasonTradeMode = M; global.TradeMode = window.TradeMode; global.Sleeper = window.Sleeper; global.KeeperRules = window.KeeperRules;
  const run = new Function(`return ${inline.trim().replace(/;\s*$/, "")}`);
  await run();
  return dom;
}
const linkParams = dom => Object.fromEntries(dom.navLinks.map(a => { const u = new URL(a.href); return [u.pathname.split("/").pop(), u.searchParams.get("league")]; }));
const draftFetches = () => fetched.filter(p => /draft/.test(p));
const PRE_DRAFT_BLOCKS = ["trade-eyebrow", "trade-note", "trade-connect", "trade-controls", "trade-warn", "trade-cols", "trade-grade", "trade-suggestions"];
// Owner decision 2026-11-07: no ?league= (and nothing remembered) is NO
// league -- the connect prompt takes the tool's place and nothing is loaded.
// An old link's league name is the same, plus the old-name notice; it is
// never resolved to a league.
async function pageNoLeague() {
  for (const href of ["trade.html", "trade.html?league=leaguea"]) {
    fresh(); statics = makeStatics(); routes = baseRoutes();
    FC.setLeague(null);                       // a fresh document: the chip has no league from an earlier page
    const d = await runPage(`https://example.test/Megatron/${href}`);
    assert.equal(d.$("connect-prompt").hidden, false, `${href}: the connect prompt is shown`);
    for (const id of PRE_DRAFT_BLOCKS) assert.equal(d.$(id).hidden, true, `${href}: ${id} hidden`);
    assert.equal(d.$("season-trade").hidden, true, `${href}: no in-season tool without a league`);
    assert.deepEqual(calls, [], `${href}: no Sleeper call`);
    assert.deepEqual(fetched, [], `${href}: no data read`);
    assert.equal(window.TradeMode.calls.length, 0);
    assert.equal(Session.bundle(), null);
    assert.equal(d.stamp.textContent, "Read-only Sleeper connection · no trades are submitted", "a plain stamp, no error");
    assert.deepEqual(Object.values(linkParams(d)), [null, null, null, null, null], `${href}: no masthead link names a league`);
    const notice = d.main.children.find(n => n.id === "league-recovery");
    if (href.includes("league=")) assert.ok(notice && /old league name/.test(notice.children[0].textContent), "the old-name notice");
    else assert.ok(!notice, "no notice when there is simply no league");
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "site", "trade.html"), "utf8");
  assert.match(html, /<p id="connect-prompt-lead">Connect your league in the bar above to see trade scenarios\.<\/p>/);
}
async function pageInSeason() {
  fresh(); statics = makeStatics(); routes = { ...baseRoutes(), ...leagueRoutes(B, () => ({ ...baseLeague, league_id: B })) };
  league = baseLeague; state = { season: "2026", season_type: "regular", week: 3 }; catalog = baseCatalog();
  const dom = await runPage(`https://example.test/Megatron/trade.html?league=${B}`);
  await until(() => dom.$("season-status").textContent === GATE, "the in-season controller's gate");
  await until(() => /^data through /.test(dom.stamp.textContent), "the masthead stamp from the batch");
  assert.equal(dom.$("season-trade").hidden, false);
  for (const id of ["trade-eyebrow", "trade-note", "trade-connect", "trade-controls", "trade-cols"]) assert.equal(dom.$(id).hidden, true, id);
  assert.equal(dom.$("connect-prompt").hidden, true, "a league is open: no connect prompt");
  assert.deepEqual(draftFetches(), [], "the in-season page never requests draft.json");
  assert.ok(!calls.some(c => /traded_picks/.test(c)));
  assert.equal(window.TradeMode.calls.length, 0);
  // In-season trade is an id context: every in-season and neutral link carries the id; the archived board's link none.
  assert.deepEqual(linkParams(dom), { "index.html": null, "trade.html": B, "weekly.html": B, "about.html": B, "waivers.html": B });
  // Another league in season: its id everywhere, still no draft data.
  fresh(); routes = baseRoutes();
  const dx = await runPage(`https://example.test/Megatron/trade.html?league=${L}`);
  await until(() => dx.$("season-status").textContent === GATE, "the gate for another league");
  assert.equal(dx.$("season-trade").hidden, false);
  assert.deepEqual(draftFetches(), []);
  assert.deepEqual(Object.values(linkParams(dx)), [null, L, L, L, L]);
}
async function pagePreDraft() {
  // The board's own league pre-draft: the mode is read from the live league FIRST, then the board loads and TradeMode runs.
  fresh(); state = { season: "2026", season_type: "pre", week: 0 }; catalog = baseCatalog();
  const leagueA = { ...baseLeague, league_id: A, name: "League A", status: "pre_draft" };
  routes = { ...baseRoutes(), ...leagueRoutes(A, () => leagueA) };
  const board = boardFor();
  statics = { "data/draft.json": board };   // no neutral weekly batch: the board is not archived
  const dom = await runPage(`https://example.test/Megatron/trade.html?league=${A}`);
  assert.equal(window.TradeMode.calls.length, 1, "TradeMode runs for the board's own league");
  assert.deepEqual(window.TradeMode.calls[0].board, board);
  assert.equal(dom.$("trade-note").textContent, window.KeeperRules.tradeNote(window.KeeperRules.fromBoard(board.league)), "the note comes from the board's rule");
  assert.deepEqual(draftFetches(), ["data/draft.json"]);
  assert.ok(events.indexOf(`sleeper /league/${A}`) >= 0 && events.indexOf(`sleeper /league/${A}`) < events.indexOf("fetch data/draft.json"), events.join(" | "));
  assert.equal(dom.$("season-trade").hidden, true);
  assert.match(dom.stamp.textContent, /^data through 2025-wk18/);
  // The board archived (its season is under way): pre-draft trade is not offered, even for its own league.
  fresh(); state = { season: "2026", season_type: "pre", week: 0 };
  routes = { ...baseRoutes(), ...leagueRoutes(A, () => leagueA) };
  statics = { "data/draft.json": boardFor(), "data/neutral/weekly.json": { season: 2026, week: 9 } };
  const da = await runPage(`https://example.test/Megatron/trade.html?league=${A}`);
  assert.equal(da.stamp.textContent, "Pre-draft trade values are not offered: the 2026 draft board is archived. In-season trade scenarios open when this league's season starts.");
  assert.equal(window.TradeMode.calls.length, 0, "no pre-draft grader while archived");
  assert.equal(da.$("trade-connect").hidden, true);
  // Another league pre-draft is the draft boundary; the board's league without keeper rules has no grader.
  for (const [id, over, expected] of [
    [B, {}, "The draft board is not built per league; the 2026 board is archived."],
    [A, { keeper_rules: undefined }, "Trade advice is not available for this league yet."],
    [A, { platform: "espn" }, "Trade advice is not available for this league yet."],
  ]) {
    fresh(); state = { season: "2026", season_type: "pre", week: 0 };
    routes = { ...baseRoutes(), ...leagueRoutes(id, () => ({ ...baseLeague, league_id: id, status: "pre_draft" })) };
    statics = { "data/draft.json": boardFor(over) };
    const d = await runPage(`https://example.test/Megatron/trade.html?league=${id}`);
    assert.equal(d.stamp.textContent, expected, `${id} ${JSON.stringify(over)}`);
    assert.equal(window.TradeMode.calls.length, 0);
    assert.equal(d.$("trade-connect").hidden, true);
    assert.equal(Session.bundle().registry.slug, null, "no board was registered for the chip");
  }
  // A board that will not load cannot be this league's: the draft boundary, not an HTTP error.
  fresh(); state = { season: "2026", season_type: "pre", week: 0 };
  routes = { ...baseRoutes(), ...leagueRoutes(B, () => ({ ...baseLeague, league_id: B, status: "pre_draft" })) };
  statics = {};
  const dn = await runPage(`https://example.test/Megatron/trade.html?league=${B}`);
  assert.equal(dn.stamp.textContent, "The draft board is not built per league; the 2026 board is archived.");
  assert.deepEqual(draftFetches(), ["data/draft.json"]);
  assert.equal(window.TradeMode.calls.length, 0);
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
    global.FC = FC; global.Session = Session; global.SeasonTradeMode = M; global.TradeMode = window.TradeMode; global.Sleeper = window.Sleeper; global.KeeperRules = window.KeeperRules;
    new Function(`return ${inline.trim().replace(/;\s*$/, "")}`)();
    return d;
  };
  // The board's own league, next season and pre-draft, reaches TradeMode when the board is not archived.
  fresh(); state = ROLL; catalog = baseCatalog();
  const a27 = { ...baseLeague, league_id: A, name: "League A", season: "2027", status: "pre_draft" };
  routes = { ...baseRoutes(), ...leagueRoutes(A, () => a27) };
  const board = { ...boardFor(), data_through: "2026-wk18" };
  statics = { "data/draft.json": board };
  const dom = startPage(`https://example.test/Megatron/trade.html?league=${A}`);
  await until(() => window.TradeMode.calls.length === 1 || Session.error(), "the pre-draft mode");
  assert.equal(Session.error(), null);
  assert.equal(window.TradeMode.calls.length, 1, "the 2027 pre-draft league reaches TradeMode under 2026 NFL state");
  assert.deepEqual(window.TradeMode.calls[0].board, board);
  assert.deepEqual(draftFetches(), ["data/draft.json"]);
  assert.equal(dom.$("season-trade").hidden, true);
  assert.doesNotMatch(dom.stamp.textContent, /season; projections are for/);
  // Another pre-draft league is the draft boundary.
  fresh(); state = ROLL;
  routes = { ...baseRoutes(), ...leagueRoutes(L, () => ({ ...baseLeague, season: "2027", status: "pre_draft" })) };
  statics = { "data/draft.json": boardFor() };
  const du = startPage(`https://example.test/Megatron/trade.html?league=${L}`);
  await until(() => du.stamp.textContent !== "", "the draft-boundary message");
  assert.equal(du.stamp.textContent, "The draft board is not built per league; the 2026 board is archived.");
  assert.equal(window.TradeMode.calls.length, 0);
  // The same league IN SEASON with a mismatched season is still refused by
  // name; the page never reaches either mode (it waits for the chip's retry).
  for (const [season, current] of [["2027", "2026"], ["2025", "2026"]]) {
    fresh(); state = { season: current, season_type: "regular", week: 3 };
    routes = { ...baseRoutes(), ...leagueRoutes(A, () => ({ ...a27, season, status: "in_season" })) };
    const d = startPage(`https://example.test/Megatron/trade.html?league=${A}`);
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
  await sub("over the roster limit: inline Drop buttons in the team's own column, no second roster list", dropFlow);
  await sub("Review Focus 1 / A6-3: a player traded after the batch counts as 0 off the offer (named caveat) and blocks the comparison by name in it", reviewFocus1);
  await sub("an unfillable starting slot: the free-agent pickup and the counted-as-0 slot are named on the page with the team names", pickupFlow);
  await sub("a blocked comparison: the status says why, the outcome is brought into view (reduced motion respected)", blockedFlow);
  await sub("a skill player without a usable projection is listed disabled with the note and cannot be ticked", unpriceableFlow);
  await sub("slots left empty: readable slot names, and the summary names the empty slot, not a player called nobody", emptySlotFlow);
  await sub("viewer flow: Viewing {team}, reworded columns, the viewer's comparison, then the owner identifies", viewerFlow);
  await sub("best ball: projections and rest-of-season values only, with the note", bestBall);
  await sub("an unknown starting slot: the note, no lineup comparison", unknownSlot);
  await sub("I1: best ball / unknown slot rest-of-season values pass the 72 h, future-date and current-team checks or are withheld", rosValidity);
  await sub("week 18: No projected weeks remain.", week18);
  await sub("draft picks in a keeper league: rows under the owner, controls, picks-only and player+pick comparisons", picksFlow);
  await sub("draft picks: a trade without a pick renders exactly as in a redraft league", picksRegressionPin);
  await sub("draft picks unavailable (Review Focus 4): one line why, the page compares players as before", picksUnavailable);
  await sub("draft picks not offered in dynasty and two-QB leagues: the reason line, no pick reads", picksGated);
  await sub("draft picks: a traded likely keeper is named", picksLikelyKeeper);
  await sub("draft picks: a pick two seasons ahead", picksFutureSeason);
  await sub("draft picks: an auction keeper draft offers none", picksAuction);
  await sub("keeper ladder: a traded pick a likely keeper would cost is named, under the ladder rule only, with one history walk per load", picksKeeperConflict);
  await sub("keeper ladder: a player kept the most allowed years is not a likely keeper", picksKeeperCap);
  await sub("keeper ladder: without the draft history only the conflict line and the ladder-aware ranking drop", picksKeeperHistoryFails);
  await sub("keeper ladder: a remembered ladder rule walks the history at load; a remembered unknown rule reads nothing", picksKeeperWalkAtLoad);
  await sub("trade.html with no league: the connect prompt, nothing loaded; an old league name: the same, never a substitute", pageNoLeague);
  await sub("trade.html in season: mode first, never draft.json, in-season links by id", pageInSeason);
  await sub("trade.html pre-draft: the board's own league reaches TradeMode after the mode; archived, other leagues and no keeper rules are refused", pagePreDraft);
  await sub("I2 rollover: a next-season pre-draft league reaches TradeMode; in season, another season is still refused", pageRollover);
  if (failed.length) { console.log(`FAILED (${failed.length}):\n  ` + failed.join("\n  ")); process.exit(1); }
  console.log(`seasontrademode_fixture: ${n} groups OK`);
  process.exit(0);
})().catch(e => { console.error(e); if (failed.length) console.log(`FAILED before the abort (${failed.length}): ` + failed.join(" | ")); process.exit(1); });
