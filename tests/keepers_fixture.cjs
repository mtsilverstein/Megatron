// tests/keepers_fixture.cjs  — run with: node tests/keepers_fixture.cjs
const assert = require("assert");
const K = require("../site/assets/keepers.js");

// cost: one round earlier; waiver flat 12
assert.strictEqual(K.costRound(8, false), 7);
assert.strictEqual(K.costRound(15, false), 14);
assert.strictEqual(K.costRound(4, true), 12);

// eligibility: drafted R1-2 ineligible; waiver always eligible
assert.strictEqual(K.eligible(2, false), false);
assert.strictEqual(K.eligible(3, false), true);
assert.strictEqual(K.eligible(1, true), true);

// value round: adp round if present, else board rank -> round
assert.strictEqual(K.valueRound(3, 99), 3);
assert.strictEqual(K.valueRound(null, 30), 3);   // ceil(30/12)
assert.strictEqual(K.valueRound(null, 25), 3);   // ceil(25/12)

// surplus = cost - value; keep a now-R3 player for a R7 pick -> +4
assert.strictEqual(K.surplus({ draftedRound: 8, isWaiver: false, adpRound: 3, overallRank: 30 }), 4);

// rankKeepers filters ineligible and sorts by surplus desc
const ranked = K.rankKeepers([
  { name: "A", draftedRound: 2, isWaiver: false, adpRound: 1, overallRank: 1 },  // ineligible
  { name: "B", draftedRound: 10, isWaiver: false, adpRound: 4, overallRank: 44 }, // +5
  { name: "C", draftedRound: 6, isWaiver: false, adpRound: 3, overallRank: 30 },  // +2
]);
assert.deepStrictEqual(ranked.map(r => r.name), ["B", "C"]);
assert.strictEqual(ranked[0].surplus, 5);

// recommendKeepers: only POSITIVE-surplus players, best up to 2
const rec = K.recommendKeepers([
  { name: "Best", draftedRound: 12, isWaiver: false, adpRound: 3, overallRank: 30 },  // +8
  { name: "Good", draftedRound: 10, isWaiver: false, adpRound: 4, overallRank: 44 },  // +5
  { name: "Neutral", draftedRound: 6, isWaiver: false, adpRound: 5, overallRank: 55 }, // 0 -> not kept
  { name: "Bad", draftedRound: 4, isWaiver: false, adpRound: 8, overallRank: 90 },     // -5 -> not kept
]);
assert.deepStrictEqual(rec.map(r => r.name), ["Best", "Good"]);   // top-2 positive only

// keep NONE when nothing beats its cost (surplus <= 0)
const none = K.recommendKeepers([
  { name: "Zero", draftedRound: 6, isWaiver: false, adpRound: 5, overallRank: 55 },  // 0
  { name: "Neg", draftedRound: 3, isWaiver: false, adpRound: 6, overallRank: 70 },   // -4
]);
assert.deepStrictEqual(none, []);

console.log("keepers_fixture: OK");
