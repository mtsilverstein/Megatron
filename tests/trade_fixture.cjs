// tests/trade_fixture.cjs — run with: node tests/trade_fixture.cjs
const assert = require("assert");
const T = require("../site/assets/trade.js");

let n = 0;
const check = (label, fn) => { fn(); n++; };
const key = p => `${p.season}R${p.round}`;
const keys = list => list.map(key).sort().join(",");

check("every team starts with every round of every season", () => {
  const owned = T.defaultPicks([1, 2], [2026, 2027], 3);
  assert.strictEqual(owned.size, 2);
  assert.strictEqual(keys(owned.get(1)),
    "2026R1,2026R2,2026R3,2027R1,2027R2,2027R3");
});

check("a traded pick moves from its original owner to its holder", () => {
  const owned = T.defaultPicks([1, 2], [2026], 3);
  // Sleeper's shape: roster_id is who it ORIGINALLY belonged to, owner_id who
  // holds it now. season arrives as a string.
  T.applyTradedPicks(owned, [{ round: 2, season: "2026", roster_id: 1, owner_id: 2 }]);
  assert.strictEqual(keys(owned.get(1)), "2026R1,2026R3");
  assert.strictEqual(keys(owned.get(2)), "2026R1,2026R2,2026R2,2026R3",
    "team 2 now holds its own R2 AND team 1's");
});

check("a pick traded twice ends with the final holder only", () => {
  const owned = T.defaultPicks([1, 2, 3], [2026], 2);
  // Sleeper collapses a chain to ONE row per pick, carrying the final owner.
  T.applyTradedPicks(owned, [
    { round: 1, season: "2026", roster_id: 1, owner_id: 3, previous_owner_id: 2 },
  ]);
  assert.strictEqual(keys(owned.get(1)), "2026R2");
  assert.strictEqual(keys(owned.get(2)), "2026R1,2026R2");
  assert.strictEqual(keys(owned.get(3)), "2026R1,2026R1,2026R2");
});

check("a traded pick for an unknown season or roster is ignored, not crashed", () => {
  const owned = T.defaultPicks([1, 2], [2026], 2);
  T.applyTradedPicks(owned, [
    { round: 1, season: "2099", roster_id: 1, owner_id: 2 },   // season we don't model
    { round: 1, season: "2026", roster_id: 9, owner_id: 2 },   // roster not in the league
    { round: 9, season: "2026", roster_id: 1, owner_id: 2 },   // round beyond the draft
  ]);
  assert.strictEqual(keys(owned.get(1)), "2026R1,2026R2", "nothing should have moved");
});

console.log(`trade_fixture: ${n} groups OK`);
