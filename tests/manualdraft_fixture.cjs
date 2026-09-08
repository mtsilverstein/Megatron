/* The typed-pick path that replaces Sleeper polling on a non-Sleeper board.

   Everything downstream of this module -- the shortlist, "your turn in N", the
   K/DST banner -- is already tested against the live path. What is NEW here is
   the arithmetic that Sleeper used to hand us for free: which seat makes each
   pick, and which of them are mine. An error there is silent and total: every
   recommendation would be computed for the wrong pick number. */
const assert = require("assert");
const MD = require("../site/assets/manualdraft.js");

/* ---- snake seat arithmetic ------------------------------------------- */
// 13 teams is the case that motivated this module, and an ODD league size is
// where an off-by-one in the reversal hides: with 12 the turn lands on a
// boundary that several wrong formulas also produce.
const T = 13;
assert.strictEqual(MD.snakeSlot(1, T, "snake"), 1);
assert.strictEqual(MD.snakeSlot(13, T, "snake"), 13, "end of round 1");
assert.strictEqual(MD.snakeSlot(14, T, "snake"), 13, "the turn: seat 13 picks back-to-back");
assert.strictEqual(MD.snakeSlot(26, T, "snake"), 1, "end of round 2 comes back to seat 1");
assert.strictEqual(MD.snakeSlot(27, T, "snake"), 1, "seat 1 also picks back-to-back");
assert.strictEqual(MD.snakeSlot(40, T, "snake"), 13, "pick 40 OPENS round 4, which runs backwards");
assert.strictEqual(MD.snakeSlot(41, T, "snake"), 12, "and then walks down");
// Round 15 is ODD, so it runs forwards and the final pick belongs to seat 13.
assert.strictEqual(MD.snakeSlot(183, T, "snake"), 1, "round 15 opens with seat 1");
assert.strictEqual(MD.snakeSlot(195, T, "snake"), 13, "and the draft ends on seat 13");

// Every seat appears exactly once per round, in both directions.
for (const round of [1, 2, 3, 8]) {
  const seats = [];
  for (let i = 0; i < T; i++) seats.push(MD.snakeSlot((round - 1) * T + i + 1, T, "snake"));
  assert.deepStrictEqual([...seats].sort((a, b) => a - b), Array.from({ length: T }, (_, i) => i + 1),
    `round ${round} must use every seat exactly once`);
  assert.deepStrictEqual(seats, round % 2 ? seats.slice().sort((a, b) => a - b)
                                          : seats.slice().sort((a, b) => b - a),
    `round ${round} must run in the correct direction`);
}

// A linear draft never reverses.
assert.strictEqual(MD.snakeSlot(14, T, "linear"), 1);
assert.strictEqual(MD.snakeSlot(26, T, "linear"), 13);

assert.strictEqual(MD.snakeSlot(0, T, "snake"), null);
assert.strictEqual(MD.snakeSlot(1, 0, "snake"), null);

/* ---- pick synthesis -------------------------------------------------- */
const entries = [
  { player_id: "s1", name: "Jahmyr Gibbs", position: "RB" },
  { player_id: "s2", name: "Ja'Marr Chase", position: "WR" },
  { player_id: null, position: "K" },                       // an unnameable pick
  { player_id: "s4", name: "A.J. Brown", position: "WR" },
];
const picks = MD.synthPicks(entries, { teams: T, type: "snake", mySlot: 3, userId: "ME" });

assert.deepStrictEqual(picks.map(p => p.pick_no), [1, 2, 3, 4], "pick numbers are the typing order");
assert.deepStrictEqual(picks.map(p => p.draft_slot), [1, 2, 3, 4]);
assert.deepStrictEqual(picks.map(p => p.round), [1, 1, 1, 1]);
assert.strictEqual(picks[2].picked_by, "ME", "seat 3 is mine, so pick 3 is mine");
assert.strictEqual(picks[0].picked_by, null);
assert.strictEqual(picks[2].player_id, "manual:3",
  "a pick the board cannot name still gets a unique id, so it can never collide");
assert.strictEqual(picks[2].metadata.position, "K",
  "position must survive: the K/DST banner reads it");
assert.deepStrictEqual(
  { first: picks[3].metadata.first_name, last: picks[3].metadata.last_name },
  { first: "A.J.", last: "Brown" }, "name splits into Sleeper's two parts");

// A one-word name must not produce an empty first_name; lateSlotTaken matches
// defences on EITHER part, so a blank one silently matches nothing.
const oneWord = MD.synthPicks([{ player_id: "d1", name: "Seattle", position: "DEF" }],
                              { teams: T, type: "snake", mySlot: 1, userId: "ME" });
assert.strictEqual(oneWord[0].metadata.first_name, "Seattle");

// The seat's picks must be exactly the ones the live path would call mine.
const long = MD.synthPicks(Array.from({ length: 40 }, (_, i) => ({ player_id: `p${i}`, name: `P ${i}` })),
                           { teams: T, type: "snake", mySlot: 13, userId: "ME" });
assert.deepStrictEqual(long.filter(p => p.picked_by === "ME").map(p => p.pick_no), [13, 14, 39, 40],
  "seat 13 picks at the turn, back-to-back");

/* ---- name resolution ------------------------------------------------- */
const board = [
  { name: "Ja'Marr Chase", position: "WR", sleeper_id: "1" },
  { name: "Justin Jefferson", position: "WR", sleeper_id: "2" },
  { name: "Jaxon Smith-Njigba", position: "WR", sleeper_id: "3" },
  { name: "Marvin Harrison Jr.", position: "WR", sleeper_id: "4" },
  { name: "A.J. Brown", position: "WR", sleeper_id: "5" },
  { name: "Chase Brown", position: "RB", sleeper_id: "6" },
  { name: "Jahmyr Gibbs", position: "RB", sleeper_id: "7" },
];
const r = (s) => MD.resolveName(s, board);

assert.strictEqual(r("Ja'Marr Chase").player.sleeper_id, "1", "exact match");
assert.strictEqual(r("jamarr chase").player.sleeper_id, "1", "punctuation and case are noise");
assert.strictEqual(r("AJ Brown").player.sleeper_id, "5", "people drop the periods");
assert.strictEqual(r("Marvin Harrison").player.sleeper_id, "4", "people drop the suffix");
assert.strictEqual(r("jefferson").player.sleeper_id, "2", "a surname alone is the common case");
assert.strictEqual(r("gibbs").player.sleeper_id, "7");

// "chase" is Ja'Marr Chase's FIRST name and Chase Brown's SURNAME. Guessing
// here would strike a player who is still on the board.
const chase = r("chase");
assert.strictEqual(chase.status, "ambiguous", "an ambiguous name must ask, never guess");
assert.ok(chase.candidates.length >= 2);

assert.strictEqual(r("smith").player.sleeper_id, "3", "unique substring still resolves");
assert.strictEqual(r("Nobody At All").status, "unknown");
assert.strictEqual(r("").status, "empty");
assert.strictEqual(r("   ").status, "empty");

/* ---- the log --------------------------------------------------------- */
const log = MD.createLog();
assert.strictEqual(log.size(), 0);
log.add({ player_id: "a", name: "One" });
log.add({ player_id: "b", name: "Two" });
assert.strictEqual(log.size(), 2);
assert.ok(log.has("a"));
assert.ok(!log.has("zz"));
assert.ok(!log.has(null), "an unnameable pick must never report as already drafted");
const popped = log.removeLast();
assert.strictEqual(popped.player_id, "b");
assert.strictEqual(log.size(), 1, "undo must free the pick number for the correct name");
assert.ok(!log.has("b"));
log.clear();
assert.strictEqual(log.size(), 0);
assert.strictEqual(log.removeLast(), null, "undo on an empty log is not an error");

console.log("manualdraft_fixture: seat arithmetic, pick synthesis, name resolution OK");

/* ---- unnameable picks keep their name ---------------------------------
   lateSlotTaken() matches drafted kickers and defences BY NAME. A "+ K"
   entry that dropped the typed name would still consume its pick number --
   the count stays right -- but the K/DST panel would go on recommending a
   kicker who is already gone, which is the one job that panel has. */
const kicker = MD.synthPicks(
  [{ player_id: null, name: "Brandon Aubrey", position: "K" },
   { player_id: null, name: "", position: "DEF" }],
  { teams: T, type: "snake", mySlot: 9, userId: "ME" });
assert.strictEqual(kicker[0].metadata.first_name, "Brandon");
assert.strictEqual(kicker[0].metadata.last_name, "Aubrey");
assert.strictEqual(kicker[0].metadata.position, "K");
assert.strictEqual(kicker[1].metadata.position, "DEF",
  "a nameless entry is still a real pick with a real position");
assert.notStrictEqual(kicker[0].player_id, kicker[1].player_id,
  "two unnameable picks must not collide into one drafted id");

console.log("manualdraft_fixture: unnameable picks retain name and position OK");
