// tests/keepers_fixture.cjs  — run with: node tests/keepers_fixture.cjs
const assert = require("assert");
const K = require("../site/assets/keepers.js");
const O = require("../site/assets/optimizer.js");   // cross-check K's par against the real module

const S = 2026;  // currentSeason
const drafted = (originalRound, originalYear, extra = {}) =>
  Object.assign({ name: "x", position: "RB", originalRound, originalYear,
                  isWaiver: false, adpRound: null, overallRank: 100 }, extra);
const waiver = (extra = {}) =>
  Object.assign({ name: "w", position: "RB", isWaiver: true,
                  adpRound: null, overallRank: 100 }, extra);

// Synthetic board for parVorp lookups: row i (0-indexed, pick i+1) carries
// vorp = max(0, 90 - i) -- a clean, integer, monotonically non-increasing
// curve with a hard dead zone once pick > 90, mirroring (not matching
// exactly -- this is a fixture) the live board's round-1-rich/round-10-dead
// shape described in the keeper-vorp-impact brief.
const boardRows = Array.from({ length: 250 }, (_, i) =>
  ({ name: `b${i + 1}`, position: "RB", vorp: Math.max(0, 90 - i) }));

// cost escalates one round per year kept, from the original round, floored at R1
assert.strictEqual(K.keeperCost(drafted(10, 2025), S), 9);   // 1 year kept
assert.strictEqual(K.keeperCost(drafted(10, 2024), S), 8);   // 2 years kept
assert.strictEqual(K.keeperCost(drafted(3, 2021), S), 1);    // floored at R1 (3-5<1)
assert.strictEqual(K.keeperCost(waiver(), S), 12);           // waiver flat, any year

// eligibility judged on the ORIGINAL round; waiver always eligible
assert.strictEqual(K.eligible(drafted(2, 2025)), false);     // original R2 -> never keepable
assert.strictEqual(K.eligible(drafted(3, 2025)), true);
assert.strictEqual(K.eligible(waiver()), true);

// value round: adp round if present, else board rank -> round
assert.strictEqual(K.valueRound(3, 99), 3);
assert.strictEqual(K.valueRound(null, 30), 3);   // ceil(30/12)

// surplus (ROUND currency) is kept for display/diagnostic purposes only --
// it must never again drive ranking or recommendation (see below).
assert.strictEqual(K.surplus(drafted(10, 2024, { adpRound: 3 }), S), 5);

// pickForRound: cost round R maps to that round's mid-pick, teams=12 default
assert.strictEqual(K.pickForRound(1), 6);     // (1-1)*12 + ceil(12/2)
assert.strictEqual(K.pickForRound(3), 30);
assert.strictEqual(K.pickForRound(12), 138);
assert.strictEqual(K.pickForRound(3, 10), 25);   // teams overridable

// ===========================================================================
// 1. THE REAL INVERSION, BY NAME -- the bug this task fixes.
// A McBride-like keeper (high VORP, cheap cost R3) must outrank a
// Kincaid-like one (VORP ~0, cost deep at R12) even though the Kincaid-like
// candidate has the LARGER round surplus. If this assertion is satisfied by
// an implementation that still ranks on rounds, the round-surplus check
// below would fail -- so both must hold together.
// ===========================================================================
const mcbride = drafted(3, S, { name: "McBride", position: "RB", adpRound: 2, overallRank: 20, vorp: 85 });
const kincaid = drafted(12, S, { name: "Kincaid", position: "RB", adpRound: 8, overallRank: 90, vorp: 0 });

const mcbrideRoundSurplus = K.surplus(mcbride, S);   // cost 3 - value 2 = +1
const kincaidRoundSurplus = K.surplus(kincaid, S);   // cost 12 - value 8 = +4
assert.strictEqual(mcbrideRoundSurplus, 1);
assert.strictEqual(kincaidRoundSurplus, 4);
assert.ok(kincaidRoundSurplus > mcbrideRoundSurplus,
  "test is only meaningful if the round-surplus 'loser' really has the bigger round number");

const inversion = K.rankKeepers([mcbride, kincaid], S, boardRows);
assert.deepStrictEqual(inversion.map(c => c.name), ["McBride", "Kincaid"]);
assert.ok(inversion[0].impact > inversion[1].impact);
// pin the actual numbers so a regression can't silently reorder them back
assert.strictEqual(inversion[0].par, O.parVorp(boardRows, inversion[0].effectivePick));
assert.strictEqual(inversion[0].par, 37);    // effectivePick 54 -> row 53 -> 90-53
assert.strictEqual(inversion[0].impact, 48); // 85 - 37
assert.strictEqual(inversion[1].par, 0);     // effectivePick 162 -> deep in the dead zone
assert.strictEqual(inversion[1].impact, 0);  // 0 - 0: a genuinely replacement-level keeper

// ===========================================================================
// 2. Rounds are never subtracted as value: identical round surplus, very
// different VORP -> very different impact.
// ===========================================================================
const sameSurplusHigh = drafted(5, S, { name: "HighVorp", position: "RB", adpRound: 3, overallRank: 40, vorp: 80 });
const sameSurplusLow = drafted(5, S, { name: "LowVorp", position: "WR", adpRound: 3, overallRank: 41, vorp: 5 });
assert.strictEqual(K.surplus(sameSurplusHigh, S), K.surplus(sameSurplusLow, S));   // identical round surplus (2)
const sameSurplusRanked = K.rankKeepers([sameSurplusHigh, sameSurplusLow], S, boardRows);
const byNameSS = Object.fromEntries(sameSurplusRanked.map(c => [c.name, c]));
assert.strictEqual(byNameSS.HighVorp.par, byNameSS.LowVorp.par);   // same cost round -> same par
assert.ok(byNameSS.HighVorp.impact - byNameSS.LowVorp.impact > 50,
  "equal round surplus must not imply comparable impact");
assert.deepStrictEqual(sameSurplusRanked.map(c => c.name), ["HighVorp", "LowVorp"]);

// ===========================================================================
// 3. Depletion offset changes par in the expected direction, and is a no-op
// once par is already floored at 0.
// ===========================================================================
const midCost = drafted(5, S, { name: "Mid", position: "RB", adpRound: 4, overallRank: 50, vorp: 20 });
const withDepletion = K.rankKeepers([midCost], S, boardRows, { depletion: true })[0];
const withoutDepletion = K.rankKeepers([midCost], S, boardRows, { depletion: false })[0];
assert.strictEqual(withoutDepletion.par, 37);   // pick 54 -> row 53 -> 90-53
assert.strictEqual(withDepletion.par, 13);      // pick 78 (54+24) -> row 77 -> 90-77
assert.ok(withDepletion.par < withoutDepletion.par, "depletion must lower par, never raise it");
assert.ok(withDepletion.impact > withoutDepletion.impact, "lower par raises impact");

const deepCost = drafted(15, S, { name: "Deep", position: "RB", adpRound: 12, overallRank: 200, vorp: 10 });
const deepWith = K.rankKeepers([deepCost], S, boardRows, { depletion: true })[0];
const deepWithout = K.rankKeepers([deepCost], S, boardRows, { depletion: false })[0];
assert.strictEqual(deepWithout.par, 0);   // already in the dead zone before depletion
assert.strictEqual(deepWith.par, 0);      // depletion changes nothing once floored
assert.strictEqual(deepWith.impact, deepWithout.impact);

// ===========================================================================
// 4. Slot awareness -- openSlot's ACTUAL return values ("dedicated" /
// "flex" / "none", read from site/assets/optimizer.js) drive the discount.
// ===========================================================================
// two TEs: the higher-impact one gets the dedicated TE slot, the second is
// pushed to flex (TE is flex-eligible) and discounted at FLEX_WEIGHT.
const teA = drafted(6, S, { name: "TeA", position: "TE", adpRound: 5, overallRank: 55, vorp: 60 });
const teB = drafted(6, S, { name: "TeB", position: "TE", adpRound: 5, overallRank: 56, vorp: 50 });
const teRanked = K.rankKeepers([teA, teB], S, boardRows);
const teByName = Object.fromEntries(teRanked.map(c => [c.name, c]));
assert.strictEqual(teByName.TeA.slot, "dedicated");
assert.strictEqual(teByName.TeA.discounted, false);
assert.strictEqual(teByName.TeB.slot, "flex");
assert.strictEqual(teByName.TeB.weight, O.FLEX_WEIGHT);
assert.strictEqual(teByName.TeB.discounted, true);
assert.strictEqual(teByName.TeB.impact, O.FLEX_WEIGHT * teB.vorp - teByName.TeB.par);

// two QBs: QB is never flex-eligible (confirmed in optimizer.js), so the
// second QB falls straight to "none" -> BENCH_WEIGHT.
const qbA = drafted(6, S, { name: "QbA", position: "QB", adpRound: 5, overallRank: 57, vorp: 40 });
const qbB = drafted(6, S, { name: "QbB", position: "QB", adpRound: 5, overallRank: 58, vorp: 30 });
const qbRanked = K.rankKeepers([qbA, qbB], S, boardRows);
const qbByName = Object.fromEntries(qbRanked.map(c => [c.name, c]));
assert.strictEqual(qbByName.QbA.slot, "dedicated");
assert.strictEqual(qbByName.QbB.slot, "none");
assert.strictEqual(qbByName.QbB.weight, O.BENCH_WEIGHT);
assert.strictEqual(qbByName.QbB.discounted, true);

// RB + WR: two different DEDICATED pools (2 each), so neither is discounted.
const rb = drafted(6, S, { name: "Rb", position: "RB", adpRound: 5, overallRank: 59, vorp: 45 });
const wr = drafted(6, S, { name: "Wr", position: "WR", adpRound: 5, overallRank: 60, vorp: 35 });
const rbWrRanked = K.rankKeepers([rb, wr], S, boardRows);
assert.ok(rbWrRanked.every(c => c.slot === "dedicated" && c.discounted === false));

// ===========================================================================
// 5. Missing vorp -> surfaced as unvalued, excluded from ranking/recommendation,
// no exception, no silent 0.
// ===========================================================================
const noProj = drafted(6, S, { name: "NoProj", position: "RB", adpRound: 5, overallRank: 61 });  // no vorp key
const nullProj = drafted(6, S, { name: "NullProj", position: "WR", adpRound: 5, overallRank: 62, vorp: null });
assert.strictEqual(noProj.vorp, undefined);
const unvalued = K.unvaluedKeepers([noProj, nullProj]);
assert.deepStrictEqual(unvalued.map(c => c.name).sort(), ["NoProj", "NullProj"]);
assert.deepStrictEqual(K.rankKeepers([noProj, nullProj], S, boardRows), []);
assert.deepStrictEqual(K.recommendKeepers([noProj, nullProj], S, boardRows), []);

// ===========================================================================
// 6. parVorp's zero floor is respected -- a keeper cost deep in the dead
// zone yields par 0, never a negative par that would inflate impact.
// ===========================================================================
const zoned = drafted(20, S, { name: "DeadZone", position: "RB", adpRound: 15, overallRank: 210, vorp: 10 });
const zonedRanked = K.rankKeepers([zoned], S, boardRows)[0];
assert.strictEqual(zonedRanked.par, 0);
assert.strictEqual(zonedRanked.par, O.parVorp(boardRows, zonedRanked.effectivePick));
assert.strictEqual(zonedRanked.impact, zonedRanked.vorp);   // weight(1)*10 - 0, not vorp - (negative par)

// ===========================================================================
// recommendKeepers: positive-impact only, best up to MAX_KEEPERS -- rebuilt
// on the points contract (same cost/year inputs as before Task 1, now with
// vorp attached and impact, not round surplus, deciding the outcome).
// ===========================================================================
const rec = K.recommendKeepers([
  drafted(12, 2024, { name: "Best", position: "RB", adpRound: 3, vorp: 15 }),     // cost 10 -> par 0 -> impact 15
  drafted(10, 2025, { name: "Good", position: "WR", adpRound: 4, vorp: 8 }),      // cost 9  -> par 0 -> impact 8
  drafted(6, 2025, { name: "Neutral", position: "TE", adpRound: 5, vorp: 13 }),   // cost 5  -> par 13 -> impact 0 -> not kept
  drafted(2, 2025, { name: "Elite", adpRound: 1, vorp: 999 }),                    // original R2 -> ineligible regardless of vorp
], S, boardRows);
assert.deepStrictEqual(rec.map(r => r.name), ["Best", "Good"]);

// keep NONE when nothing beats its cost
const none = K.recommendKeepers([
  drafted(6, 2025, { name: "Zero", position: "RB", adpRound: 5, vorp: 13 }),   // cost 5 -> par 13 -> impact 0
  drafted(3, 2025, { name: "Neg", position: "WR", adpRound: 6, vorp: 10 }),    // cost 2 -> par 49 -> impact -39
], S, boardRows);
assert.deepStrictEqual(none, []);

// buildKeeperCandidates: map roster + draft history + board -> candidates
// (board rows now carry vorp; both construction paths must forward it)
const board = new Map([
  ["s_bijan", { name: "Bijan", position: "RB", adpRound: 1, overallRank: 2, vorp: 87.1 }],
  ["s_puka",  { name: "Puka",  position: "WR", adpRound: 1, overallRank: 5, vorp: 75.0 }],
  ["s_waiverguy", { name: "WaiverGuy", position: "WR", adpRound: 9, overallRank: 110, vorp: 3.2 }],
]);
// Bijan's earliest pick is 2024 (kept, so he ALSO appears escalated in 2025 —
// earliest season must win); WaiverGuy is on no draft; s_kicker is off-board.
const original = new Map([
  ["s_bijan", { round: 4, season: 2024 }],
  ["s_puka",  { round: 6, season: 2025 }],
]);
const { candidates, skipped } = K.buildKeeperCandidates(
  ["s_bijan", "s_puka", "s_waiverguy", "s_kicker"], original, board);
assert.deepStrictEqual(skipped, ["s_kicker"]);               // off-board, dropped
const byName = Object.fromEntries(candidates.map(c => [c.name, c]));
assert.deepStrictEqual(
  { r: byName.Bijan.originalRound, y: byName.Bijan.originalYear, w: byName.Bijan.isWaiver },
  { r: 4, y: 2024, w: false });
assert.strictEqual(byName.WaiverGuy.isWaiver, true);          // not in any draft
assert.strictEqual(byName.Puka.adpRound, 1);                  // board fields carried
assert.strictEqual(byName.Bijan.vorp, 87.1);                  // vorp carried too (Task 5)
assert.strictEqual(byName.WaiverGuy.vorp, 3.2);
// escalation end-to-end via Task 1: Bijan cost = 4 - (2026-2024) = 2, value R1 -> +1
assert.strictEqual(K.surplus(byName.Bijan, 2026), 1);

console.log("keepers_fixture: OK");
