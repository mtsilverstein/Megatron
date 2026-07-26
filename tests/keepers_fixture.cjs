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

console.log("keepers_fixture: OK");
