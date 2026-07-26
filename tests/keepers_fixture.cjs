// tests/keepers_fixture.cjs  — run with: node tests/keepers_fixture.cjs
const assert = require("assert");
const K = require("../site/assets/keepers.js");

const S = 2026;  // currentSeason
const drafted = (originalRound, originalYear, extra = {}) =>
  Object.assign({ name: "x", position: "RB", originalRound, originalYear,
                  isWaiver: false, adpRound: null, overallRank: 100 }, extra);
const waiver = (extra = {}) =>
  Object.assign({ name: "w", position: "RB", isWaiver: true,
                  adpRound: null, overallRank: 100 }, extra);

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

// surplus = cost - value; drafted R10 in 2024 (cost 8), now going R3 -> +5
assert.strictEqual(K.surplus(drafted(10, 2024, { adpRound: 3 }), S), 5);

// recommendKeepers: positive-surplus only, best up to 2
const rec = K.recommendKeepers([
  drafted(12, 2024, { name: "Best", adpRound: 3 }),     // cost 10, value 3 -> +7
  drafted(10, 2025, { name: "Good", adpRound: 4 }),     // cost 9,  value 4 -> +5
  drafted(6, 2025, { name: "Neutral", adpRound: 5 }),   // cost 5,  value 5 -> 0 -> not kept
  drafted(2, 2025, { name: "Elite", adpRound: 1 }),     // original R2 -> ineligible
], S);
assert.deepStrictEqual(rec.map(r => r.name), ["Best", "Good"]);

// keep NONE when nothing beats its cost
const none = K.recommendKeepers([
  drafted(6, 2025, { name: "Zero", adpRound: 5 }),   // 0
  drafted(3, 2025, { name: "Neg", adpRound: 6 }),    // cost 2, value 6 -> -4
], S);
assert.deepStrictEqual(none, []);

console.log("keepers_fixture: OK");
