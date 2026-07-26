// tests/draftmode_fixture.cjs — run with: node tests/draftmode_fixture.cjs
// draftmode.js is a browser IIFE: shim the globals it touches at load time,
// then read the module off the fake window.
const assert = require("assert");
global.window = {};
global.document = { addEventListener() {}, getElementById: () => null,
                    querySelector: () => null, hidden: false };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
require("../site/assets/draftmode.js");
const D = global.window.DraftMode;

// nextPickNumber: 12-team snake, slot 3 -> picks #3, #22, #27, #46, #51 ...
// (values below were verified against the shipped implementation)
assert.strictEqual(D.nextPickNumber(3, 12, 15, 0, 0, "snake"), 3);
assert.strictEqual(D.nextPickNumber(3, 12, 15, 0, 2, "snake"), 3);
assert.strictEqual(D.nextPickNumber(3, 12, 15, 0, 3, "snake"), 22);

// gapToNextPick: picks BETWEEN the selection on the clock and your next pick.
// On the clock at #3 (2 picks made): #22 is next -> 18 picks in between.
// NOTE this is nonzero ON THE CLOCK -- the whole point of the fix.
assert.strictEqual(D.gapToNextPick(3, 12, 15, 0, 2, "snake"), 18);
// On the clock at #22 (21 made): next is #27 -> 4 in between (turn-of-snake).
assert.strictEqual(D.gapToNextPick(3, 12, 15, 0, 21, "snake"), 4);
// Just past the turn, on the clock at #27 (22 made): next is #46 -> 18.
assert.strictEqual(D.gapToNextPick(3, 12, 15, 0, 22, "snake"), 18);
// A 1-round draft has no pick after your first -> null
assert.strictEqual(D.gapToNextPick(3, 12, 1, 0, 2, "snake"), null);
// Invalid inputs propagate null (same guard as nextPickNumber)
assert.strictEqual(D.gapToNextPick(0, 12, 15, 0, 2, "snake"), null);

console.log("draftmode_fixture: OK");
