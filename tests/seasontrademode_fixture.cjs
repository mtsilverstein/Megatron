// tests/seasontrademode_fixture.cjs — run with: node tests/seasontrademode_fixture.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../site/assets/seasontrademode.js");
const Session = require("../site/assets/session.js");
let n = 0; const failed = [];
// FIXTURE_ALL=1 reports every failing group instead of stopping at the first (used to show new cases fail on old code).
function check(name, fn) { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; if (process.env.FIXTURE_ALL) { failed.push(e.message.split("\n")[0]); return; } throw e; } }
async function sub(name, fn) { try { await fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; if (process.env.FIXTURE_ALL) { failed.push(e.message.split("\n")[0]); return; } throw e; } }

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
  assert.throws(() => M.identifyRoster(rosters.concat([{ roster_id: 3, owner_id: "u1" }]), "u1"), /Could not uniquely match/);
});
check("capacity, active skill players and needed drops", () => {
  const league = { roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "IR", "TAXI"] };
  assert.equal(M.capacityOf(league), 15);
  const catalog = { a: { position: "RB" }, b: { position: "K" }, c: { position: "WR" }, d: { position: "DEF" }, e: { position: "TE" } };
  assert.deepEqual(M.activeSkill({ players: ["a", "b", "c", "d", "e"], reserve: ["e"], taxi: [] }, catalog), ["a", "c"]);
  assert.equal(M.neededDrops({ activeCount: 15, giveCount: 1, receiveCount: 2, capacity: 15 }), 1);
  assert.equal(M.neededDrops({ activeCount: 14, giveCount: 1, receiveCount: 2, capacity: 15 }), 0);
  assert.equal(M.neededDrops({ activeCount: 15, giveCount: 2, receiveCount: 1, capacity: 15 }), 0);
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
const ctx = { names: { 1: "Me", 2: "Them" }, currentWeek: 2, firstWeek: 3, endWeek: 17, picks: [{ label: "2027 R1 (Them)" }], excludeWeeks: { p9: [3, 4] }, playerNames: { p9: "A.J. Brown" }, drops: { 2: ["p7"] }, playerNamesAll: { p7: "Bench Guy" } };
check("scenarioText: headline, subline, sides and assumptions", () => {
  const t = M.scenarioText(result, ctx);
  assert.equal(t.headline, "Conditional lineup scenario — not a trade verdict.");
  assert.equal(t.subline, "Sum of weekly central (p50) lineup scenarios for weeks 3–17; week 2 is excluded because trades may process after games start. Keeper value and draft picks are not valued, so no overall grade is shown.");
  assert.deepEqual(t.sides, [{ name: "Me", before: "200.00", after: "212.00", delta: "+12.00" }, { name: "Them", before: "180.00", after: "164.00", delta: "−16.00" }]);
  assert.deepEqual(t.notValued, ["Not valued: picks — 2027 R1 (Them)"]);
  assert.deepEqual(t.assumptions, ["A.J. Brown assumed unavailable weeks 3, 4 (your assumption, not a return-date prediction)", "Them drops Bench Guy"]);
});
check("no forbidden word leaves the text builders outside the two allowed sentences", () => {
  const t = M.scenarioText(result, ctx);
  const c = M.coverageText(Object.assign(new Error("Projection coverage blocked: 1 players, 2 player-weeks."), { name: "ProjectionCoverageError", coverageIssues: [{ id: "x", name: "X", week: 3, reason: "unknown is not zero (no_observed_history)" }, { id: "x", name: "X", week: 4, reason: "unknown is not zero (no_observed_history)" }] }));
  const all = [t.subline, ...t.sides.flatMap(s => Object.values(s)), ...t.notValued, ...t.assumptions, c.headline, ...c.rows];
  const scrubbed = all.map(s => M.ALLOWED_SENTENCES.reduce((x, a) => x.split(a).join(""), s)).join("\n").toLowerCase();
  for (const w of M.FORBIDDEN) assert.ok(!scrubbed.includes(w), `forbidden word "${w}" in: ${scrubbed}`);
  assert.equal(c.headline, "Comparison blocked: 1 player(s), 2 player-week(s) without a projection");
  assert.deepEqual(c.rows, ["X · week 3 · unknown is not zero (no_observed_history)", "X · week 4 · unknown is not zero (no_observed_history)"]);
  const other = M.coverageText(new Error("Scoring mismatch"));
  assert.equal(other.headline, "Comparison blocked"); assert.deepEqual(other.rows, ["Scoring mismatch"]);
});
// --- plain-English lineup summary -----------------------------------------
// Built only from the engine's per-week before/after starting lineups.
const P = (id, name, slot) => ({ id, name, slot, points: 0, status: "conditional_projection" });
const BASE0 = [P("h", "Justin Herbert", "QB"), P("r1", "Bijan Robinson", "RB"), P("w1", "Chris Olave", "WR")];
const BASE1 = [P("d", "Dak Prescott", "QB"), P("r2", "Jaylen Warren", "RB"), P("w2", "Jalen Coker", "WR")];
const swap = (lineup, outId, inP) => lineup.map(p => (p.id === outId ? inP : p));
const KYLER = P("k", "Kyler Murray", "QB"), HERBERT = P("h", "Justin Herbert", "QB");
function mkResult(changes, first = 4, last = 17) {
  // changes: { [week]: [side0 {after, delta} | null, side1 ... | null] }
  const weeks = [];
  for (let w = first; w <= last; w++) {
    const c = changes[w] || [null, null];
    const sides = [BASE0, BASE1].map((base, i) => {
      const ch = c[i];
      return { rosterId: i + 1, before: { total: 100, lineup: base }, after: { total: 100 + (ch ? ch.delta : 0), lineup: ch ? ch.after : base }, delta: ch ? ch.delta : 0 };
    });
    weeks.push({ week: w, sides });
  }
  return { weeks, sides: [0, 1].map(i => ({ rosterId: i + 1, delta: weeks.reduce((n, wk) => n + wk.sides[i].delta, 0) })) };
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
const manyWeeks = mkResult({
  5: [{ after: swap(BASE0, "h", KYLER), delta: 1.0 }, null],
  6: [{ after: swap(BASE0, "h", KYLER), delta: 4.0 }, null],
  7: [{ after: swap(swap(BASE0, "h", KYLER), "w1", P("w9", "Rome Odunze", "WR")), delta: -3.5 }, null],
  9: [{ after: swap(BASE0, "h", KYLER), delta: 5.0 }, null],
  10: [{ after: swap(BASE0, "h", KYLER), delta: 0.5 }, null],
  11: [{ after: swap(BASE0, "h", KYLER), delta: 2.0 }, null],
});
check("lineupSummary: many changed weeks -> the 3 largest named, the rest summarised", () => {
  assert.deepEqual(M.lineupSummary(manyWeeks, sumCtx), [
    "Your lineup: +9.0 pts over weeks 4–17. Lineup changes in 6 weeks; the 3 largest: week 9 (+5.0): Kyler Murray starts instead of Justin Herbert; week 6 (+4.0): Kyler Murray starts instead of Justin Herbert; week 7 (−3.5): Kyler Murray and Rome Odunze start instead of Justin Herbert and Chris Olave; and smaller changes in 3 other weeks (+3.5 pts combined).",
    "Easy Breecey: 0.0 pts over weeks 4–17. No change to the starting lineup.",
  ]);
  const two = M.lineupSummary(mkResult({ 6: [{ after: swap(BASE0, "h", KYLER), delta: -1.0 }, null], 9: [{ after: swap(BASE0, "h", KYLER), delta: 2.25 }, null] }), sumCtx);
  assert.equal(two[0], "Your lineup: +1.3 pts over weeks 4–17. Lineup changes in 2 weeks: week 9 (+2.3): Kyler Murray starts instead of Justin Herbert; week 6 (−1.0): Kyler Murray starts instead of Justin Herbert.");
});
check("lineupSummary: nothing changes -> one sentence for both lineups", () => {
  assert.deepEqual(M.lineupSummary(mkResult({}), sumCtx), ["No change to either starting lineup in weeks 4–17 under these assumptions."]);
});
check("lineupSummary strings carry no forbidden or judging word", () => {
  const all = [herbertForKyler, manyWeeks, mkResult({})].flatMap(r => M.lineupSummary(r, sumCtx)).join("\n").toLowerCase();
  for (const w of [...M.FORBIDDEN, "better", "worse", "should"]) assert.ok(!all.includes(w), `"${w}" in summary: ${all}`);
});
// --- gated grade: pure helpers ---------------------------------------------
check("gradeLabel: boundaries at exactly E and 2E, and the negative mirror", () => {
  const E = 6;
  assert.equal(M.gradeLabel(0, E), "Too close to call");
  assert.equal(M.gradeLabel(5.99, E), "Too close to call");
  assert.equal(M.gradeLabel(6, E), "Small gain", "exactly E is small");
  assert.equal(M.gradeLabel(11.99, E), "Small gain");
  assert.equal(M.gradeLabel(12, E), "Clear gain", "exactly 2E is clear");
  assert.equal(M.gradeLabel(-5.99, E), "Too close to call");
  assert.equal(M.gradeLabel(-6, E), "Small loss");
  assert.equal(M.gradeLabel(-11.99, E), "Small loss");
  assert.equal(M.gradeLabel(-12, E), "Clear loss");
  assert.equal(M.gradeLabel(9, 3, 3), "Clear gain", "k is a parameter");
  assert.equal(M.gradeLabel(0, 0), "Too close to call", "no delta is never a gain");
  assert.equal(M.gradeLabel(0.1, 0), "Clear gain");
  for (const bad of [[NaN, 6], [1, NaN], [1, -1], [1, 6, 0.5]]) assert.throws(() => M.gradeLabel(...bad), /finite/);
  for (const d of [-20, -7, 0, 7, 20]) assert.ok(M.GRADE_LABELS.includes(M.gradeLabel(d, 6)));
});
const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"];
const LEAGUE = { slug: "gabagool", roster_positions: [...SLOTS, "K", "DEF", "BN", "BN", "IR"] };
const H5 = { origin: 5, weeks: 13, strata: { same_position: { E: 5.5, n: 900 }, cross_position: { E: 6.1, n: 700 }, depth_for_starter: { E: 4.2, n: 300 }, lopsided: { E: 9.0, n: 400 } }, lopsided_cutoff: 30 };
const H9 = { origin: 9, weeks: 9, strata: { same_position: { E: 4.0, n: 900 }, cross_position: { E: 4.5, n: 700 }, depth_for_starter: { E: 3.0, n: 300 }, lopsided: { E: 7.0, n: 400 } }, lopsided_cutoff: 22 };
const EVAL = { schema_version: 2, league: "gabagool", slots: SLOTS, verdict: "pass", waiver_verdict: "fail", k: 2, horizons: [H5, H9],
  seasons: [2023, 2024, 2025], origins: [5, 9], excluded_cells: 0, generated_at: "2026-09-30T00:00:00Z",
  secondary: { league: "fam", slots: ["QB", "RB", "WR", "TE", "FLEX", "FLEX"], verdict: "pass", waiver_verdict: "fail", excluded_cells: 0, horizons: [{ origin: 5, weeks: 13, strata: { same_position: { E: 3.3, n: 100 } }, lopsided_cutoff: 12 }] } };
check("gateOpen: true only for a passing file that matches this league and its starter slots", () => {
  assert.equal(M.gateOpen(EVAL, LEAGUE), true);
  assert.equal(M.gateOpen(EVAL, { ...LEAGUE, roster_positions: ["RB", "WR", "WR", "RB", "TE", "QB", "FLEX", "BN"] }), true, "slot order and non-starter slots do not matter");
  for (const [name, file] of [["missing", null], ["undefined", undefined], ["not an object", "pass"],
    ["verdict fail", { ...EVAL, verdict: "fail" }], ["verdict absent", { ...EVAL, verdict: undefined }], ["verdict PASS", { ...EVAL, verdict: "PASS" }],
    ["schema 1 (old contract)", { ...EVAL, schema_version: 1 }], ["schema 3", { ...EVAL, schema_version: 3 }], ["schema absent", { ...EVAL, schema_version: undefined }],
    ["other league slug", { ...EVAL, league: "fam" }], ["different slots", { ...EVAL, slots: ["QB", "RB", "WR", "TE"] }],
    ["slots missing", { ...EVAL, slots: undefined }], ["no horizons", { ...EVAL, horizons: [] }], ["horizons not an array", { ...EVAL, horizons: H5 }], ["horizon without strata", { ...EVAL, horizons: [{ origin: 5, weeks: 13, strata: {} }] }], ["horizon E not finite", { ...EVAL, horizons: [{ ...H5, strata: { same_position: { E: "6", n: 1 } } }] }], ["horizon weeks not finite", { ...EVAL, horizons: [{ ...H5, weeks: "13" }] }], ["file league empty", { ...EVAL, league: "" }]])
    assert.equal(M.gateOpen(file, LEAGUE), false, name);
  assert.equal(M.gateOpen(EVAL, { slug: "gabagool", roster_positions: ["QB", "RB", "WR", "TE", "FLEX", "FLEX"] }), false, "live slots differ from the file's");
  assert.equal(M.gateOpen(EVAL, { slug: "gabagool" }), false, "no live slots");
  assert.equal(M.gateOpen({ ...EVAL, league: undefined }, { roster_positions: LEAGUE.roster_positions }), false, "undefined === undefined must not open the gate");
  assert.equal(M.gateOpen({ ...EVAL, league: undefined }, { slug: undefined, roster_positions: LEAGUE.roster_positions }), false);
  assert.equal(M.gateOpen({ ...EVAL, league: "" }, { slug: "", roster_positions: LEAGUE.roster_positions }), false, "an empty slug never matches");
});
check("gateOpen: the secondary league opens on its own verdict, slots and strata", () => {
  const fam = { slug: "fam", roster_positions: ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "BN"] };
  assert.equal(M.gateOpen(EVAL, fam), true);
  assert.equal(M.evalView(EVAL, fam).horizons[0].strata.same_position.E, 3.3);
  assert.equal(M.evalView(EVAL, fam).horizons[0].lopsided_cutoff, 12, "the secondary carries its own cutoffs");
  assert.equal(M.gateOpen({ ...EVAL, secondary: { ...EVAL.secondary, verdict: "fail" } }, fam), false);
  assert.equal(M.gateOpen({ ...EVAL, verdict: "fail" }, fam), true, "the secondary's verdict is independent of the primary's");
  assert.equal(M.gateOpen({ ...EVAL, secondary: { ...EVAL.secondary, slots: SLOTS } }, fam), false);
});
check("pickHorizon: nearest remaining-week count, ties go to the shorter horizon", () => {
  const hs = [H5, H9];
  assert.equal(M.pickHorizon(hs, 13).origin, 5);
  assert.equal(M.pickHorizon(hs, 9).origin, 9);
  assert.equal(M.pickHorizon(hs, 11).origin, 9, "a tie -> the shorter horizon");
  assert.equal(M.pickHorizon(hs, 4).origin, 9);
  assert.equal(M.pickHorizon(hs, 16).origin, 5);
  assert.equal(M.pickHorizon([H9, H5], 11).origin, 9, "order in the file does not matter");
  assert.equal(M.pickHorizon([], 9), null);
  assert.equal(M.pickHorizon(null, 9), null);
  assert.equal(M.pickHorizon(hs, NaN), null);
});
// A side is {give: [before-lineup start share of each player it gives], receive: [after-lineup share of each it gets]}.
const S1 = (give, receive) => ({ give, receive });
check("stratumOf: position mix, depth for a starter (spec §10.2), and the lopsided cutoff", () => {
  const same = { positions: ["WR", "WR"], sides: [S1([1], [1]), S1([1], [1])] };
  assert.deepEqual(M.stratumOf(same, 5, H5), ["same_position"]);
  assert.deepEqual(M.stratumOf({ ...same, positions: ["WR", "RB"] }, 5, H5), ["cross_position"]);
  // depth: a side gives a starter (>= half the weeks) and receives nobody who starts (>= half)
  assert.deepEqual(M.stratumOf({ positions: ["WR", "WR"], sides: [S1([0.8], [0.49]), S1([0.2], [1])] }, 5, H5), ["same_position", "depth_for_starter"]);
  assert.deepEqual(M.stratumOf({ positions: ["WR", "WR"], sides: [S1([0.5], [0.5]), S1([0.2], [1])] }, 5, H5), ["same_position"], "a receiver starting exactly half the weeks is a starter");
  assert.deepEqual(M.stratumOf({ positions: ["WR", "WR"], sides: [S1([0.49], [0]), S1([0.3], [0])] }, 5, H5), ["same_position"], "giving only bench players is not depth-for-starter");
  assert.deepEqual(M.stratumOf({ positions: ["WR", "WR"], sides: [S1([1], [1]), S1([1], [0.2])] }, 5, H5), ["same_position", "depth_for_starter"], "either side can qualify");
  assert.deepEqual(M.stratumOf({ positions: ["WR", "WR", "RB"], sides: [S1([1, 0.9], [0.1]), S1([1], [0.7, 0.1])] }, 5, H5), ["cross_position", "depth_for_starter"], "a starter arriving in a 2-for-1 clears depth on that side only");
  assert.deepEqual(M.stratumOf(same, -30, H5), ["same_position", "lopsided"], "|Δ| at the cutoff is lopsided");
  assert.deepEqual(M.stratumOf(same, 29.9, H5), ["same_position"]);
  assert.deepEqual(M.stratumOf(same, 25, H9), ["same_position", "lopsided"], "the cutoff is the chosen horizon's");
  assert.deepEqual(M.stratumOf(same, 99, { strata: H5.strata }), ["same_position"], "no cutoff, no lopsided stratum");
});
check("errorFor: the largest E among the trade's strata in the chosen horizon; none measured -> null", () => {
  assert.equal(M.errorFor(["same_position"], H5), 5.5);
  assert.equal(M.errorFor(["same_position", "depth_for_starter", "lopsided"], H5), 9.0);
  assert.equal(M.errorFor(["cross_position", "depth_for_starter"], H9), 4.5);
  assert.equal(M.errorFor(["something_else"], H5), null);
});
// Review M11: a stratum the trade belongs to but that has no measured E (n = 0) is not skipped; the grade is unavailable.
check("errorFor: a stratum without a finite E makes the whole trade unmeasured (review M11)", () => {
  const partial = { strata: { same_position: { E: 5, n: 10 }, depth_for_starter: { E: null, n: 0 }, lopsided: { E: 9, n: 3 } } };
  assert.equal(M.errorFor(["same_position", "depth_for_starter"], partial), null, "one measured stratum does not stand in for an unmeasured one");
  assert.equal(M.errorFor(["same_position", "lopsided"], partial), 9);
  assert.equal(M.errorFor([], partial), null);
});
// Review I2: the lopsided measure is the LARGER side's |Δ|, as the backtest measured it (max over both sides).
check("lopsidedMeasure: max of both sides' |Δ|; stratumOf then flags a trade only the partner's side crosses", () => {
  assert.equal(M.lopsidedMeasure([{ delta: 6 }, { delta: -60 }]), 60);
  assert.equal(M.lopsidedMeasure([{ delta: -70 }, { delta: 6 }]), 70);
  assert.equal(M.lopsidedMeasure([{ delta: 0 }, { delta: 0 }]), 0);
  const same = { positions: ["WR", "WR"], sides: [S1([1], [1]), S1([1], [1])] };
  assert.deepEqual(M.stratumOf(same, M.lopsidedMeasure([{ delta: 6 }, { delta: -60 }]), { strata: H5.strata, lopsided_cutoff: 50 }), ["same_position", "lopsided"]);
});
const RANKS = new Map([
  ["gw1", { position: "WR", team: "A", ros_rank: 8 }], ["gw2", { position: "WR", team: "B", ros_rank: 40 }], ["gw3", { position: "WR", team: "C", ros_rank: 3 }],
  ["gr1", { position: "RB", team: "D", ros_rank: 12 }], ["gr2", { position: "RB", team: "E", ros_rank: 60 }],
]);
const mv = (delta, give, receive) => ({ delta, give, receive });
check("marketText: null when any moved player has no ROS rank, or when ranks and model agree", () => {
  assert.equal(M.marketText(mv(4, [{ gsis: "gw1", name: "Ann" }], [{ gsis: "unranked", name: "Bo" }]), RANKS), null, "a missing rank");
  assert.equal(M.marketText(mv(4, [{ gsis: "unranked", name: "Ann" }], [{ gsis: "gw3", name: "Bo" }]), RANKS), null, "a missing rank on the giving side");
  assert.equal(M.marketText(mv(4, [{ gsis: "gw2", name: "Ann" }], [{ gsis: "gw3", name: "Bo" }]), RANKS), null, "both say gain");
  assert.equal(M.marketText(mv(-4, [{ gsis: "gw3", name: "Ann" }], [{ gsis: "gw2", name: "Bo" }]), RANKS), null, "both say loss");
  assert.equal(M.marketText(mv(0, [{ gsis: "gw3", name: "Ann" }], [{ gsis: "gw2", name: "Bo" }]), RANKS), null, "a zero model delta has no direction");
  assert.equal(M.marketText(mv(4, [{ gsis: "gw1", name: "Ann" }], [{ gsis: "gw1x", name: "Bo" }]), null), null, "no ROS reference");
  assert.equal(M.marketText(mv(4, [{ gsis: "gw1", name: "Ann" }], [{ gsis: "gw2", name: "Bo" }]), new Map()), null, "empty reference");
  assert.equal(M.marketText(null, RANKS), null);
});
check("marketText: names players and ranks when the ranks disagree, plus a roster reason for a thin starter", () => {
  const t = M.marketText(mv(7.3, [{ gsis: "gw3", name: "Ann Aaron" }], [{ gsis: "gw2", name: "Bo Byrd", started: 5, of: 14 }, { gsis: "gr1", name: "Cy Cole", started: 14, of: 14 }]), RANKS);
  assert.equal(t, "Market check: the model shows a gain, but expert rest-of-season ranks rate what you give above what you get. You get Bo Byrd (WR3, overall 40) and Cy Cole (RB1, overall 12); you give Ann Aaron (WR1, overall 3). Roster reason: Bo Byrd would start in only 5 of 14 weeks in your lineup, so his rank counts for less here.");
  const t2 = M.marketText(mv(-3, [{ gsis: "gw2", name: "Bo Byrd" }], [{ gsis: "gw3", name: "Ann Aaron", started: 14, of: 14 }]), RANKS);
  assert.equal(t2, "Market check: the model shows a loss, but expert rest-of-season ranks rate what you get above what you give. You get Ann Aaron (WR1, overall 3); you give Bo Byrd (WR3, overall 40).", "no roster reason for a full-time starter");
});
check("gradeText: the sample line, and every panel string passes GRADE_FORBIDDEN", () => {
  const sim = { weeks: Array.from({ length: 14 }, (_, i) => i + 4), nSims: 2000, sides: [
    { rosterId: 1, mean: 11.4, p10: -3.0, p90: 24.9, pPositive: 0.8, perWeek: [] }, { rosterId: 2, mean: -11.4, p10: -25, p90: 3, pPositive: 0.2, perWeek: [] }] };
  const g = M.gradeText(sim, { names: { 1: "Me", 2: "Them" }, firstWeek: 4, endWeek: 17, E: 6.1, k: 2 });
  assert.equal(g.sides[0].name, "Your lineup");
  assert.equal(g.sides[0].label, "Small gain");
  assert.equal(g.sides[0].detail, "+11.4 pts over weeks 4–17 (about +0.8 a week); likely range −3.0 to +24.9; typical measured error on trades like this: 6.1 pts");
  assert.equal(g.sides[1].name, "Them"); assert.equal(g.sides[1].label, "Small loss");
  const market = M.marketText(mv(7, [{ gsis: "gw3", name: "Ann" }], [{ gsis: "gw2", name: "Bo", started: 1, of: 14 }]), RANKS);
  const graded = M.scenarioText(result, { ...ctx, graded: true });
  const all = [g.heading, g.footnote, ...g.limitations, ...g.sides.flatMap(s => [s.name, s.label, s.detail]), market, graded.headline, graded.subline, ...M.GRADE_LABELS].join("\n").toLowerCase();
  for (const w of M.GRADE_FORBIDDEN) assert.ok(!all.includes(w), `"${w}" in grade copy: ${all}`);
  assert.ok(!/no overall grade/.test(graded.subline), "the graded scenario no longer claims that no grade is shown");
  assert.match(graded.subline, /not valued/);
  assert.equal(M.scenarioText(result, ctx).headline, M.HEADLINE, "closed-gate scenario text is unchanged");
});
// Review I4 (spec §8): the limitations travel with every grade.
check("gradeText carries the spec §8 limitations as a short list, inside GRADE_FORBIDDEN", () => {
  const sim = { weeks: [4, 5, 6], nSims: 2000, sides: [{ rosterId: 1, mean: 3, p10: -1, p90: 6, pPositive: 0.8, perWeek: [] }, { rosterId: 2, mean: -3, p10: -6, p90: 1, pPositive: 0.2, perWeek: [] }] };
  const g = M.gradeText(sim, { names: {}, firstWeek: 4, endWeek: 6, E: 2, k: 2 });
  assert.ok(Array.isArray(g.limitations) && g.limitations.length >= 6 && g.limitations.length <= 8, "a short list");
  const t = g.limitations.join("\n");
  for (const re of [/independent/i, /stack|correlat/i, /position rates|position-level/i, /current tags/i, /not injury type|injury type/i, /latest Sleeper status/i, /synthetic/i, /2023.2025/, /not real rosters/i, /frozen/i, /picks/i, /keepers?/i, /after 17/i]) assert.match(t, re, String(re));
  for (const w of M.GRADE_FORBIDDEN) assert.ok(!t.toLowerCase().includes(w), `"${w}" in the limitations`);
});
check("startCounts reads each moved player's starting weeks off the lineups", () => {
  const r = { weeks: [0, 1, 2, 3].map(w => ({ week: w, sides: [
    { before: { lineup: [{ id: "out1" }] }, after: { lineup: [{ id: "in1" }, ...(w < 1 ? [{ id: "in2" }] : [])] } },
    { before: { lineup: w < 3 ? [{ id: "in1" }] : [] }, after: { lineup: w % 2 ? [{ id: "out1" }] : [] } }] })) };
  const c = M.startCounts(r, ["out1"], ["in1", "in2"]);
  assert.equal(c.of, 4);
  assert.deepEqual(c.receive, [{ id: "in1", started: 4 }, { id: "in2", started: 1 }]);
  assert.deepEqual(c.give, [{ id: "out1", started: 2 }]);
  assert.deepEqual(c.sides, [{ give: [1], receive: [1, 0.25] }, { give: [0.75, 0], receive: [0.5] }]);
});
check("requiring the module in node leaves window untouched and exports a callable init", () => {
  assert.equal(typeof global.window, "undefined", "the UMD wrapper must not create a global window in node");
  assert.equal(typeof M.init, "function");
  assert.ok(Object.isFrozen(M));
});
check("the controller reads identity, rosters and state from the session, never its own /user lookup", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "site", "assets", "seasontrademode.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "site", "trade.html"), "utf8");
  assert.ok(!/\/user\//.test(src), "no /user/<name> fetch remains in this controller");
  assert.ok(!/els\.user\b|els\.load\b/.test(src), "init no longer needs els.user / els.load");
  assert.ok(!/\/players\/nfl/.test(src), "the catalog comes from Session.catalog(), not a page-local cache");
  assert.ok(!/get\(`\/league\/\$\{lid\}\/(?:users|rosters)`\)|get\("\/state\/nfl"\)/.test(src), "users/rosters/state come from the bundle");
  // How compare() uses Session.refresh (scope, the refreshed bundle's
  // rostersFetchedAt as snapshotAt, moved players, superseded results) is
  // checked by RUNNING it in initSmoke below, not by grepping the source.
  assert.ok(!/season-user|season-load/.test(html), "trade.html has no in-season username input or load button");
  assert.ok(/seasontrademode\.js\?v=grade3/.test(html), "cache key bumped for the gated-grade controller");
  assert.ok(/seasontrade\.js\?v=grade3/.test(html) && /rostersim\.js\?v=1/.test(html), "simulate's engine loads before it");
  assert.ok(html.indexOf("rostersim.js") > html.indexOf("ros.js?v=1") && html.indexOf("rostersim.js") < html.indexOf("seasontrade.js"), "rostersim.js follows ros.js and precedes seasontrade.js");
  assert.ok(html.indexOf("waiverintel.js") < html.indexOf("seasontrademode.js"), "prepareRos is loaded before the controller");
  assert.ok(!/season-ack/.test(html) && !/els\.ack\b/.test(src), "no acknowledgment checkbox gates the compare");
  assert.ok(/id="season-steps"/.test(html), "the three-step guide is on the page");
});

// --- init() under a DOM stub and a scripted Session -------------------------
// Pins the controller's contract with the session: hidden until a bundle with
// a uniquely matched roster commits; a compare's own refresh is adopted (the
// compare finishes against the NEW bundle's rosters and rostersFetchedAt);
// a foreign bundle change during a compare invalidates it.
function stubDom() {
  const mk = () => {
    const node = { hidden: false, textContent: "", value: "", checked: false, disabled: false, className: "", dataset: {}, children: [], type: "", listeners: {}, parentElement: null };
    node.append = (...xs) => { for (const x of xs) if (x && typeof x === "object") { node.children.push(x); x.parentElement = node; } };
    node.replaceChildren = () => { node.children = []; };
    node.addEventListener = (ev, fn) => { (node.listeners[ev] = node.listeners[ev] || []).push(fn); };
    node.querySelector = () => null; node.setAttribute = () => {}; node.classList = { toggle() {} };
    return node;
  };
  const els = {};
  for (const k of ["eyebrow", "status", "controls", "partner", "compare", "warn", "cols", "mine", "theirs", "mineDrops", "theirsDrops", "result", "provenance"]) els[k] = mk();
  return { els, mk };
}
function scriptedSession() {
  const listeners = new Set();
  const s = { committed: null, err: null, id: null, refreshImpl: null, catalogAt: 1000 };
  const api = {
    bundle: () => s.committed, error: () => s.err, identity: () => s.id,
    chipText: (b) => b.myRosterStatus === "found" ? "found" : "Could not uniquely match this account to a roster in this league.",
    catalog: async () => ({ p1: { position: "RB", full_name: "A", team: "X" }, p2: { position: "WR", full_name: "B", team: "Y" }, p3: { position: "RB", full_name: "C", team: "Z", injury_status: "Questionable" } }),
    catalogFetchedAt: () => s.catalogAt,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    refresh: opts => s.refreshImpl(opts),
    isSuperseded: e => !!(e && e.superseded),
    identifyRoster: Session.identifyRoster,
    commit(b) { s.committed = b; for (const fn of [...listeners]) fn({ state: "ready", bundle: b }); },
  };
  return { api, s };
}
const tick = () => new Promise(r => setImmediate(r));
async function initSmoke() {
  const { els, mk } = stubDom();
  const { api: Sess, s } = scriptedSession();
  const league = { league_id: "L1", name: "Lg", season: 2026, status: "in_season", total_rosters: 2, roster_positions: ["RB", "WR", "BN", "BN"], settings: {} };
  const remaining = { schema_version: 1, horizon: "remaining_season", status: "experimental", evaluation: null, league: { league_id: "L1" }, season: 2026, start_week: 3, end_week: 17, generated_at: "g", data_through: "d", players: [] };
  const analyzed = [];
  global.window = {
    Session: Sess,
    Sleeper: { get: async path => { if (path.endsWith("/traded_picks")) return []; throw new Error(`unexpected fetch ${path}`); } },
    FC: { loadJSON: async () => remaining, leagueDataPath: k => k },
    Trade: { defaultPicks: () => new Map(), applyTradedPicks: () => {} }, Keepers: { DRAFT_ROUNDS: 1 },
    SeasonTrade: { analyze: args => { analyzed.push(args); return { weeks: [{ week: 4, sides: [{ before: { total: 1, lineup: [] }, after: { total: 1, lineup: [] }, delta: 0 }, { before: { total: 1, lineup: [] }, after: { total: 1, lineup: [] }, delta: 0 }] }], sides: [{ rosterId: 1, delta: 0 }, { rosterId: 2, delta: 0 }], warnings: [] }; } },
    ROS: { evaluationText: () => [] },
  };
  let footerWrites = 0;
  const closedFooter = { get textContent() { return "footer"; }, set textContent(v) { footerWrites++; } };
  global.document = { createElement: tag => Object.assign(mk(), { tagName: String(tag).toUpperCase() }), createTextNode: t => t, querySelector: sel => (sel === "footer" ? closedFooter : null) };
  try {
    const board = { league: { name: "Lg", league_id: "L1" } };
    M.init({ board, league, slug: "lg", els });
    // 1. no bundle, no identity: everything hidden, gate text shown
    assert.equal(els.controls.hidden, true); assert.equal(els.cols.hidden, true); assert.equal(els.result.hidden, true);
    assert.match(els.status.textContent, /league panel/);
    // 2. bundle without a unique roster: still hidden, the exact-matcher message
    s.id = { userId: "u1", username: "me" };
    const rosters = [{ roster_id: 1, owner_id: "u1", players: ["p1"], reserve: [], taxi: [] }, { roster_id: 2, owner_id: "u2", players: ["p2", "p3"], reserve: [], taxi: [] }];
    const users = [{ user_id: "u1", display_name: "Me" }, { user_id: "u2", display_name: "Them" }];
    const state = { week: 3, season: "2026", season_type: "regular" };
    const mkBundle = (extra) => Object.freeze({ registry: {}, identity: s.id, league, users, rosters, state, rostersRequestedAt: 10, rostersFetchedAt: 20, myRoster: rosters[0], myRosterStatus: "found", warnings: [], ...extra });
    Sess.commit(mkBundle({ myRoster: null, myRosterStatus: "none" }));
    await tick(); await tick();
    assert.equal(els.cols.hidden, true); assert.match(els.status.textContent, /Could not uniquely match/);
    // 3. found: columns drawn from the bundle's rosters, no Sleeper roster fetch
    Sess.commit(mkBundle({}));
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(els.cols.hidden, false); assert.equal(els.controls.hidden, false);
    assert.match(els.status.textContent, /2 teams loaded — you are Me/);
    assert.match(els.provenance.textContent, /Player catalog fetched 1970-01-01T00:00:01\.000Z/);
    // select p1 to give, then compare (no acknowledgment step): the refresh
    // commits a NEW bundle (adopted, not reloaded) and analyze gets its
    // rosters and rostersFetchedAt.
    const row = els.mine.children.find(li => li.dataset.id === "p1");
    const box = row.children[0].children[0];
    const part = (li, cls) => li.children.find(c => c.className === cls);
    assert.equal(part(row, "season-weeks").hidden, true, "no week field on an unticked, untagged player");
    assert.equal(part(row, "season-weeks-toggle").hidden, true, "no reveal link before the player is ticked");
    assert.equal(els.compare.disabled, true, "nothing ticked yet");
    box.checked = true; for (const fn of box.listeners.change) fn();
    assert.equal(els.compare.disabled, false, "compare enabled as soon as a player is ticked -- no acknowledgment gate");
    assert.equal(part(row, "season-weeks").hidden, true, "the week field stays hidden for a ticked, untagged player");
    const toggle = part(row, "season-weeks-toggle");
    assert.equal(toggle.hidden, false); assert.equal(toggle.textContent, "Out some weeks? (optional)");
    for (const fn of toggle.listeners.click) fn();
    assert.equal(part(row, "season-weeks").hidden, false, "the link reveals the field");
    assert.equal(toggle.hidden, true);
    assert.equal(part(row, "season-weeks").placeholder, "optional — leave blank if he plays, e.g. 3-5");
    const tagged = els.theirs.children.find(li => li.dataset.id === "p3");
    assert.equal(part(tagged, "season-weeks").hidden, false, "a tagged player's field is revealed automatically");
    assert.equal(part(tagged, "season-weeks-toggle").hidden, true);
    assert.equal(els.compare.disabled, false, "an empty week field is not an error");
    const fresh = mkBundle({ rostersRequestedAt: 100, rostersFetchedAt: Date.now() });
    let refreshOpts = null;
    s.refreshImpl = async opts => { refreshOpts = opts; Sess.commit(fresh); return fresh; };
    for (const fn of els.compare.listeners.click) await fn();
    assert.deepEqual(refreshOpts, { scope: "rosters" });
    assert.equal(analyzed.length, 1, "compare ran against the refreshed bundle");
    assert.equal(analyzed[0].snapshotAt, fresh.rostersFetchedAt, "snapshotAt is the NEW bundle's post-fetch time");
    assert.equal(analyzed[0].rosters, fresh.rosters);
    assert.equal(analyzed[0].assumeAvailable, true, "the engine still receives the availability assumption");
    assert.equal(footerWrites, 0, "gate closed: the footer node is never written");
    assert.equal(els.result.hidden, false);
    // summary first, then the headline; the detail sections are collapsible
    assert.equal(els.result.children[0].className, "season-summary", "closed gate: the summary is the first child, no grade panel");
    assert.ok(!els.result.children.some(c => c.className === "season-grade"));
    assert.equal(els.result.children[0].children[0].textContent, "No change to either starting lineup in weeks 4–4 under these assumptions.");
    const details = els.result.children.filter(c => c.tagName === "DETAILS");
    assert.deepEqual(details.map(d => d.children[0].textContent), ["Week-by-week lineup totals", "Assumptions", "Engine notes", "Measured evaluation"]);
    assert.ok(details.every(d => d.children[0].tagName === "SUMMARY"));
    // 3b. the refresh brings rosters in which a SELECTED player moved (p1 is
    // now on roster 2): no analyze, the CHANGED outcome, columns redrawn from
    // the fresh snapshot (p1 now listed under "you get").
    const movedRosters = [{ roster_id: 1, owner_id: "u1", players: [], reserve: [], taxi: [] }, { roster_id: 2, owner_id: "u2", players: ["p1", "p2", "p3"], reserve: [], taxi: [] }];
    const moved = mkBundle({ rosters: movedRosters, myRoster: movedRosters[0], rostersRequestedAt: 200, rostersFetchedAt: Date.now() });
    s.refreshImpl = async () => { Sess.commit(moved); return moved; };
    assert.equal(els.compare.disabled, false, "p1 is still selected after the first compare");
    const analyzedBefore = analyzed.length;
    for (const fn of els.compare.listeners.click) await fn();
    assert.equal(analyzed.length, analyzedBefore, "no analyze when a selected player moved rosters");
    assert.equal(els.status.textContent, "Rosters changed since they were loaded — the columns were redrawn from the fresh snapshot; choose again.");
    assert.equal(els.result.hidden, true, "no stale scenario stays on screen");
    assert.ok(!els.mine.children.some(li => li.dataset.id === "p1"), "p1 is no longer offered on my side");
    assert.ok(els.theirs.children.some(li => li.dataset.id === "p1"), "p1 is drawn on the partner's side from the fresh rosters");
    assert.equal(els.compare.disabled, true, "selections were cleared by the redraw");
    // 3c. a superseded refresh (the session moved on) is swallowed: no
    // "comparison blocked", no analyze, the button re-enabled.
    const box2 = els.theirs.children.find(li => li.dataset.id === "p2").children[0].children[0];
    box2.checked = true; for (const fn of box2.listeners.change) fn();
    assert.equal(els.compare.disabled, false);
    s.refreshImpl = async () => { const e = new Error("Superseded by a newer request."); e.superseded = true; throw e; };
    for (const fn of els.compare.listeners.click) await fn();
    assert.equal(analyzed.length, analyzedBefore, "no analyze after a superseded refresh");
    assert.doesNotMatch(els.status.textContent, /comparison blocked/, "a superseded refresh is not an error");
    assert.equal(els.result.hidden, true);
    assert.equal(els.compare.disabled, false, "busy was released");
    // 3d. the same outcome from the partner's side: p1 (selected on "you get")
    // is back on roster 1 in the refreshed rosters -> CHANGED, columns redrawn
    // to the original layout (which step 4 below relies on).
    const box1b = els.theirs.children.find(li => li.dataset.id === "p1").children[0].children[0];
    box1b.checked = true; for (const fn of box1b.listeners.change) fn();
    const restored = mkBundle({ rostersRequestedAt: 300, rostersFetchedAt: Date.now() });
    s.refreshImpl = async () => { Sess.commit(restored); return restored; };
    for (const fn of els.compare.listeners.click) await fn();
    assert.equal(analyzed.length, analyzedBefore, "no analyze when a player selected on the partner's side moved");
    assert.equal(els.status.textContent, "Rosters changed since they were loaded — the columns were redrawn from the fresh snapshot; choose again.");
    assert.ok(els.mine.children.some(li => li.dataset.id === "p1"), "p1 is back on my side");
    // 4. a foreign bundle (different account) arriving mid-compare invalidates it
    const other = mkBundle({ identity: { userId: "u2" }, myRoster: rosters[1], rostersFetchedAt: Date.now() });
    s.refreshImpl = async () => { s.id = { userId: "u2" }; Sess.commit(other); return other; };
    const box4 = els.mine.children.find(li => li.dataset.id === "p1").children[0].children[0];
    box4.checked = true; for (const fn of box4.listeners.change) fn();
    assert.equal(els.compare.disabled, false);
    const before = analyzed.length;
    for (const fn of els.compare.listeners.click) await fn();
    assert.equal(analyzed.length, before, "no analyze after the account changed under the compare");
    for (let i = 0; i < 5; i++) await tick();
    assert.match(els.status.textContent, /2 teams loaded — you are Them/, "the foreign bundle reloaded the columns for the new account");
    // 5. losing the roster hides everything again
    s.id = null;
    Sess.commit(mkBundle({ identity: null, myRoster: null, myRosterStatus: "anonymous" }));
    assert.equal(els.cols.hidden, true); assert.equal(els.result.hidden, true); assert.equal(els.controls.hidden, true);
    assert.match(els.status.textContent, /league panel/);
  } finally { delete global.window; delete global.document; }
}
// --- init() with the gate OPEN: hand-written eval object, mocked simulate ---
// The grade path is dormant in production (no trade_sim_eval.json), so this is
// the only place it runs. The lineup scenario always renders first; the panel
// above it is filled afterwards, or replaced by a one-line note.
async function gateSmoke() {
  const { els, mk } = stubDom();
  const { api: Sess, s } = scriptedSession();
  Sess.catalog = async () => ({ p1: { position: "RB", full_name: "Ann Aaron", team: "X", gsis_id: "g1" }, p2: { position: "WR", full_name: "Bo Byrd", team: "Y", gsis_id: "g2" }, p3: { position: "RB", full_name: "C", team: "Z", gsis_id: "g3" } });
  const league = { league_id: "L1", name: "Lg", season: 2026, status: "in_season", total_rosters: 2, roster_positions: ["RB", "WR", "BN", "BN"], settings: {} };
  const remaining = { schema_version: 1, horizon: "remaining_season", status: "experimental", evaluation: null, league: { league_id: "L1" }, season: 2026, start_week: 3, end_week: 17, generated_at: "g", data_through: "d", players: [] };
  const strata = (a, b) => ({ same_position: { E: a, n: 10 }, cross_position: { E: b, n: 10 }, depth_for_starter: { E: 4, n: 10 }, lopsided: { E: 9, n: 10 } });
  // The scenario compares 3 weeks; the 3-week horizon is nearest, the 13-week one (E 99) must not be used.
  const evalFile = { schema_version: 2, league: "lg", slots: ["RB", "WR"], verdict: "pass", waiver_verdict: "fail", k: 2, horizons: [{ origin: 5, weeks: 13, strata: strata(99, 99), lopsided_cutoff: 5 }, { origin: 14, weeks: 3, strata: strata(5, 5.5), lopsided_cutoff: 50 }], excluded_cells: 0 };
  const availability = { p_out: { QB: 0.05, RB: 0.05, WR: 0.05, TE: 0.05 }, p_stay: { QB: 0.4, RB: 0.4, WR: 0.4, TE: 0.4 }, p_tag: { Out: 0.9, Doubtful: 0.8, Questionable: 0.2, IR: 0.9 } };
  const rosSource = (snapshot_at) => ({ schema_version: 1, horizon: "ros", rank_scope: "overall", scoring_format: "ppr", season: 2026, source: "test", snapshot_at,
    players: [{ player_id: "g1", position: "RB", team: "X", ros_rank: 5 }, { player_id: "g2", position: "WR", team: "Y", ros_rank: 90 }] });
  const env = { availability, ros: rosSource(new Date().toISOString().slice(0, 10)), simThrows: null, simMean: 8 };
  const analyzed = [], simulated = [], loaded = [], stratumCalls = [];
  const lineup = ids => ids.map(id => ({ id, name: id }));
  // 3 weeks; the incoming p2 starts in one of them (a thin starter), p1 in all for the partner.
  // Both sides give a starter (before-lineups) by default; env.benchOnly makes the partner give only a non-starter.
  const mkResult = () => ({ weeks: (env.weeksList || [4, 5, 6]).map((w, i) => ({ week: w, sides: [
    { before: { total: 1, lineup: lineup(["p1"]) }, after: { total: 3, lineup: lineup(i === 0 ? ["p2"] : []) }, delta: 2 },
    { before: { total: 1, lineup: env.benchOnly ? [] : lineup(["p2"]) }, after: { total: 0, lineup: lineup(["p1"]) }, delta: -2 }] })), sides: [{ rosterId: 1, delta: env.d0 ?? 6 }, { rosterId: 2, delta: env.d1 ?? -6 }], warnings: [] });
  global.window = {
    Session: Sess,
    Sleeper: { get: async path => { if (path.endsWith("/traded_picks")) return []; throw new Error(`unexpected fetch ${path}`); } },
    FC: { leagueDataPath: k => k, loadJSON: async path => {
      loaded.push(path);
      if (path === "remaining") return remaining;
      if (path === "data/trade_sim_eval.json") return evalFile;
      if (path === "data/availability.json") { if (!env.availability) throw new Error("HTTP 404"); return env.availability; }
      if (path === "data/ros-ecr.json") { if (!env.ros) throw new Error("HTTP 404"); return env.ros; }
      throw new Error(`unexpected ${path}`);
    } },
    Trade: { defaultPicks: () => new Map(), applyTradedPicks: () => {} }, Keepers: { DRAFT_ROUNDS: 1 },
    WaiverIntel: require("../site/assets/waiverintel.js"),
    SeasonTrade: {
      analyze: args => { analyzed.push(args); return mkResult(); },
      // The controller takes population/strata inputs from stratumInputs (the backtest's lineup method), not from analyze's
      // lineups. By default the mock derives them from the same result; env.siDeltas / env.siGive override only the inputs.
      stratumInputs: args => {
        stratumCalls.push(args);
        const r = mkResult(), sc = M.startCounts(r, args.give, args.receive);
        return { sides: sc.sides.map((sd, i) => ({ ...sd, give: env.siGive ? env.siGive[i] : sd.give, delta: env.siDeltas ? env.siDeltas[i] : r.sides[i].delta })) };
      },
      simulate: args => {
        simulated.push(args);
        if (env.simThrows) throw Object.assign(new Error(env.simThrows), { name: "RosterSimError" });
        return { weeks: [4, 5, 6], nSims: 2000, sides: [{ rosterId: 1, mean: env.simMean, p10: -3, p90: 20, pPositive: 0.8, perWeek: [] }, { rosterId: 2, mean: -env.simMean, p10: -20, p90: 3, pPositive: 0.2, perWeek: [] }] };
      },
    },
    ROS: { evaluationText: () => [] },
  };
  const footer = { textContent: "Pre-draft: values players and draft picks before the draft. In season: conditional lineup scenarios only — no trade grades." };
  const footerBefore = footer.textContent;
  global.document = { createElement: tag => Object.assign(mk(), { tagName: String(tag).toUpperCase() }), createTextNode: t => t, querySelector: sel => (sel === "footer" ? footer : null) };
  const text = node => [node.textContent || "", ...(node.children || []).map(text)].filter(Boolean).join("\n");
  try {
    s.id = { userId: "u1", username: "me" };
    const rosters = [{ roster_id: 1, owner_id: "u1", players: ["p1"], reserve: [], taxi: [] }, { roster_id: 2, owner_id: "u2", players: ["p2", "p3"], reserve: [], taxi: [] }];
    const users = [{ user_id: "u1", display_name: "Me" }, { user_id: "u2", display_name: "Them" }];
    const state = { week: 3, season: "2026", season_type: "regular" };
    const mkBundle = () => Object.freeze({ registry: {}, identity: s.id, league, users, rosters, state, rostersRequestedAt: 10, rostersFetchedAt: Date.now(), myRoster: rosters[0], myRosterStatus: "found", warnings: [] });
    M.init({ board: { league: { name: "Lg", league_id: "L1" } }, league, slug: "lg", els });
    Sess.commit(mkBundle());
    for (let i = 0; i < 6; i++) await tick();
    assert.ok(loaded.includes("data/trade_sim_eval.json"), "the gate file is read on load");
    for (const [side, id] of [[els.mine, "p1"], [els.theirs, "p2"]]) { const b = side.children.find(li => li.dataset.id === id).children[0].children[0]; b.checked = true; for (const fn of b.listeners.change) fn(); }
    assert.equal(els.compare.disabled, false);
    const run = async () => { s.refreshImpl = async () => { const b = mkBundle(); Sess.commit(b); return b; }; for (const fn of els.compare.listeners.click) await fn(); };
    const panelLines = () => els.result.children[0].children.map(text);
    // 1. open gate, simulation ok: panel above the summary
    await run();
    assert.equal(els.result.hidden, false);
    assert.equal(els.result.children[0].className, "season-grade", "the grade panel is first");
    assert.equal(els.result.children[1].className, "season-summary", "the lineup summary stays underneath");
    assert.equal(simulated.length, 1);
    assert.equal(simulated[0].seed, 20260924, "fixed seed: re-clicking Compare gives the same numbers");
    assert.equal(simulated[0].availability, availability);
    assert.equal(simulated[0].now, analyzed[0].now, "simulate resolves the scenario at analyze's own clock");
    assert.equal(simulated[0].snapshotAt, analyzed[0].snapshotAt);
    assert.deepEqual(simulated[0].give, ["p1"]); assert.deepEqual(simulated[0].receive, ["p2"]);
    assert.ok(!/no trade grades/.test(footer.textContent) && /simulated grade/.test(footer.textContent), "the footer stops claiming there are no trade grades while a grade shows");
    let lines = panelLines();
    assert.equal(lines[0], "Simulated rest-of-season grade, weeks 4–6");
    // RB + WR is cross_position (5.5); p2 starts 1 of 3 weeks -> depth_for_starter (4); largest E = 5.5; mean 8 is in [5.5, 11)
    assert.equal(lines[1], "Your lineup: Small gain");
    assert.equal(lines[2], "+8.0 pts over weeks 4–6 (about +2.7 a week); likely range −3.0 to +20.0; typical measured error on trades like this: 5.5 pts");
    assert.equal(lines[3], "Them: Small loss");
    assert.match(lines[5], /^Market check: the model shows a gain, but expert rest-of-season ranks rate what you give above what you get\. You get Bo Byrd \(WR1, overall 90\); you give Ann Aaron \(RB1, overall 5\)\. Roster reason: Bo Byrd would start in only 1 of 3 weeks in your lineup/);
    assert.match(lines[6], /not valued/);
    await sub("live panel lists the spec §8 limitations after the footnote (review I4)", async () => {
      const tail = lines.slice(7).join("\n");
      for (const re of [/independent/i, /injury type/i, /synthetic 2023.2025/i, /frozen/i, /picks/i, /after 17/i, /latest Sleeper status/i]) assert.match(tail, re, `limitations in the live panel: ${tail}`);
    });
    const panelText = lines.join("\n").toLowerCase();
    for (const w of M.GRADE_FORBIDDEN) assert.ok(!panelText.includes(w), `"${w}" in the live panel: ${panelText}`);
    const all = text(els.result);
    assert.ok(all.includes("Lineup scenario from central (p50) projections") && !/not a trade verdict|no overall grade/.test(all), "closed-gate disclaimers are re-worded once a grade is shown");
    // 1b. tested population only: a side that gives no starter -> no grade, no simulation
    env.benchOnly = true;
    const simsBefore = simulated.length;
    await run();
    assert.deepEqual(panelLines(), ["grade unavailable: the grade is measured only for trades where each side gives a starter"]);
    assert.equal(simulated.length, simsBefore, "no simulation outside the tested population");
    assert.equal(els.result.children[1].className, "season-summary", "the lineup scenario stays");
    assert.equal(footer.textContent, footerBefore);
    env.benchOnly = false;
    await run();
    assert.equal(panelLines()[1], "Your lineup: Small gain", "starter for starter is graded");
    // 2. a sim failure: the lineup scenario stays, one line replaces the panel, no partial grade
    env.simThrows = "no replacement available for RB in week 4";
    await run();
    lines = panelLines();
    assert.deepEqual(lines, ["grade unavailable: no replacement available for RB in week 4"]);
    assert.equal(footer.textContent, footerBefore, "no grade on screen: the footer is as today");
    assert.equal(els.result.children[1].className, "season-summary", "the lineup scenario is still there");
    assert.ok(text(els.result).includes(M.HEADLINE) && text(els.result).includes(M.ALLOWED_SENTENCES[1]), "closed-gate wording when no grade is shown");
    // A new league load re-reads the cached inputs (availability, ROS) and clears the selections.
    const reload = async () => {
      Sess.commit(Object.freeze({ ...mkBundle(), rosters: rosters.map(r => ({ ...r })) }));
      for (let i = 0; i < 6; i++) await tick();
      for (const [side, id] of [[els.mine, "p1"], [els.theirs, "p2"]]) { const bx = side.children.find(li => li.dataset.id === id).children[0].children[0]; bx.checked = true; for (const fn of bx.listeners.change) fn(); }
    };
    // 3. availability.json missing: same fallback with its own reason, and it retries next time
    env.simThrows = null; env.availability = null;
    await reload();
    const sims = simulated.length;
    await run();
    assert.deepEqual(panelLines(), ["grade unavailable: availability data is not published"]);
    assert.equal(simulated.length, sims, "no simulation without the availability table");
    env.availability = availability;
    await run();
    assert.equal(panelLines()[1], "Your lineup: Small gain", "recovers once the file is there");
    // 4. stale ROS reference: the grade shows, the market check is withheld with the existing reason
    env.ros = rosSource("2026-01-01");
    await reload();
    await run();
    lines = panelLines();
    assert.equal(lines[1], "Your lineup: Small gain");
    assert.ok(lines.some(l => l === "ROS reference is stale, future-dated or empty. ROS ranks withheld."), `withheld reason in: ${lines.join(" | ")}`);
    assert.ok(!lines.some(l => l.startsWith("Market check")));
    // 5. no ROS file at all: also withheld, never faked
    env.ros = null;
    await reload();
    await run();
    assert.ok(panelLines().some(l => l === "ROS reference unavailable. ROS ranks withheld."));
    // 6. review I2: the lopsided stratum uses the larger side's |Δ| (the backtest's measure): only the partner's
    // side crosses the 50-point cutoff here, so the lopsided E (9.0) applies and +8.0 is too close to call.
    await sub("lopsided stratum uses the larger side (review I2)", async () => {
      env.ros = rosSource(new Date().toISOString().slice(0, 10)); env.d0 = 6; env.d1 = -60;
      await reload(); await run();
      assert.equal(panelLines()[1], "Your lineup: Too close to call");
      env.d0 = undefined; env.d1 = undefined;
    });
    // 6b. review M2: strata and population come from stratumInputs, not from the displayed lineups
    await sub("strata and population read stratumInputs, not analyze (review M2)", async () => {
      await reload();
      env.siDeltas = [6, -60];                       // analyze still says +-6; only the backtest-method inputs cross the cutoff
      const calls = stratumCalls.length;
      await run();
      assert.equal(stratumCalls.length, calls + 1, "the controller asked for stratum inputs");
      assert.equal(panelLines()[1], "Your lineup: Too close to call");
      env.siDeltas = undefined; env.siGive = [[0.2], [1]];   // the displayed lineups have starters; the inputs say side 0 gives a bench player
      const sims = simulated.length;
      await run();
      assert.deepEqual(panelLines(), ["grade unavailable: the grade is measured only for trades where each side gives a starter"]);
      assert.equal(simulated.length, sims);
      env.siGive = undefined;
    });
    // 7. review M7: weeks after 17 were never measured
    await sub("weeks after 17 are not graded (review M7)", async () => {
      await reload();
      env.weeksList = [16, 17, 18];
      const before = simulated.length;
      await run();
      assert.deepEqual(panelLines(), ["grade unavailable: weeks after 17 are not measured"]);
      assert.equal(simulated.length, before, "no simulation for an unmeasured horizon");
      env.weeksList = undefined;
    });
  } finally { delete global.window; delete global.document; }
}
initSmoke().then(gateSmoke).then(() => {
  n += 2;
  if (failed.length) { console.log(`FAILED (${failed.length}):\n  ` + failed.join("\n  ")); process.exit(1); }
  console.log(`seasontrademode_fixture: ${n} groups OK`);
},
  e => { e.message = `init under a scripted session: ${e.message}`; console.error(e); if (failed.length) console.log(`FAILED before the abort (${failed.length}): ` + failed.join(" | ")); process.exit(1); });
