// tests/optimizer_fixture.cjs — run with: node tests/optimizer_fixture.cjs
const assert = require("assert");
const O = require("../site/assets/optimizer.js");

const P = (name, position, vorp, extra = {}) =>
  Object.assign({ name, position, vorp, bye: 7, ecr: 50 }, extra);

// --- rosterSlots / openSlot -------------------------------------------------
assert.deepStrictEqual(O.rosterSlots([]), { QB: 0, RB: 0, WR: 0, TE: 0 });
assert.deepStrictEqual(
  O.rosterSlots([P("a", "RB", 1), P("b", "RB", 1), P("c", "WR", 1)]),
  { QB: 0, RB: 2, WR: 1, TE: 0 });

// dedicated open while under the dedicated count
assert.strictEqual(O.openSlot("RB", { QB: 0, RB: 1, WR: 0, TE: 0 }), "dedicated");
// RB dedicated (2) full, flex still open -> flex
assert.strictEqual(O.openSlot("RB", { QB: 0, RB: 2, WR: 0, TE: 0 }), "flex");
// both flex slots consumed by surplus RB/WR/TE -> none
assert.strictEqual(O.openSlot("RB", { QB: 0, RB: 4, WR: 2, TE: 1 }), "none");
// QB is never flex-eligible: 1 dedicated, then straight to none
assert.strictEqual(O.openSlot("QB", { QB: 0, RB: 0, WR: 0, TE: 0 }), "dedicated");
assert.strictEqual(O.openSlot("QB", { QB: 1, RB: 0, WR: 0, TE: 0 }), "none");
// TE: dedicated 1, then flex-eligible
assert.strictEqual(O.openSlot("TE", { QB: 0, RB: 0, WR: 0, TE: 1 }), "flex");

// --- replacement ------------------------------------------------------------
// pool by vorp desc: RB100, WR90, RB80, WR70, RB60
const pool = [P("r1", "RB", 100), P("w1", "WR", 90), P("r2", "RB", 80),
              P("w2", "WR", 70), P("r3", "RB", 60)];
assert.strictEqual(O.replacement(pool, "RB", 0), 100);  // gap 0 -> current best
assert.strictEqual(O.replacement(pool, "RB", 2), 80);   // top 2 gone -> r2
assert.strictEqual(O.replacement(pool, "RB", 4), 60);   // top 4 gone -> r3
assert.strictEqual(O.replacement(pool, "RB", 5), 0);    // none survive -> replacement level
assert.strictEqual(O.replacement(pool, "TE", 0), 0);    // position absent -> 0

// --- vona -------------------------------------------------------------------
const empty = { QB: 0, RB: 0, WR: 0, TE: 0 };
// starts + cliff: best RB 100, survivor after 2 picks 80 -> 20
assert.strictEqual(O.vona(pool[0], empty, pool, 2), 20);
// starts, gap 0 -> 0 (you could just take him next pick too)
assert.strictEqual(O.vona(pool[0], empty, pool, 0), 0);
// would ride the bench (all RB slots + both flex full) -> BENCH_WEIGHT * vorp
const full = { QB: 1, RB: 4, WR: 2, TE: 1 };
assert.strictEqual(O.vona(pool[0], full, pool, 2), O.BENCH_WEIGHT * 100);

// --- parVorp / steal --------------------------------------------------------
// board (rank order = ECR order): ranks 1..5 by vorp desc
const board = [P("b1", "RB", 100), P("b2", "WR", 90), P("b3", "RB", 80),
               P("b4", "WR", 70), P("b5", "TE", 60)];
assert.strictEqual(O.parVorp(board, 3), 80);    // pick #3 -> 3rd board row
assert.strictEqual(O.parVorp(board, 99), 0);    // past the board -> 0
// an elite still available well past his rank is a steal
assert.strictEqual(O.steal(board[0], board, 3), 20);   // 100 - par 80
assert.strictEqual(O.steal(board[2], board, 3), 0);    // par pick -> no steal
assert.strictEqual(O.steal(board[4], board, 3), 0);    // below par -> floored at 0

// --- byePenalty -------------------------------------------------------------
// two starters already on bye 7; a third STARTER on bye 7 is penalized
const mine2 = [P("m1", "RB", 50, { bye: 7 }), P("m2", "WR", 50, { bye: 7 })];
assert.strictEqual(O.byePenalty(P("x", "TE", 40, { bye: 7 }), mine2, empty), O.BYE_PEN);
// different bye week -> no penalty
assert.strictEqual(O.byePenalty(P("x", "TE", 40, { bye: 9 }), mine2, empty), 0);
// only ONE existing starter on that bye -> the newcomer is only the 2nd -> no penalty
const mine1 = [P("m1", "RB", 50, { bye: 7 })];
assert.strictEqual(O.byePenalty(P("x", "TE", 40, { bye: 7 }), mine1, empty), 0);
// a bench pick is never penalized (would not start)
assert.strictEqual(O.byePenalty(P("x", "RB", 40, { bye: 7 }), mine2, full), 0);

// --- scorePlayer: the spec's worked check ----------------------------------
// WR2 open, gap 23: best WR 40, survivor WR 22 -> vona 18, no steal (par 45)
const wrPool = [P("eliteRB", "RB", 100), P("par", "RB", 45), P("wrNow", "WR", 40),
                P("wrLater", "WR", 22)];
const ctxWR = { counts: { QB: 0, RB: 2, WR: 1, TE: 1 }, available: wrPool, gap: 1,
                players: [P("x1", "RB", 100), P("x2", "RB", 60), P("x3", "RB", 45)],
                pickNo: 3, myPlayers: [] };
// gap 1 removes only eliteRB, so the WR survivor is still wrNow -> vona 0
assert.strictEqual(O.vona(wrPool[2], ctxWR.counts, wrPool, 1), 0);
// with a real gap of 3 the WR survivor is wrLater -> 40 - 22 = 18
assert.strictEqual(O.vona(wrPool[2], ctxWR.counts, wrPool, 3), 18);
// benched elite: vona 0.2*100 = 20, steal 0.5*(100-45) = 27.5 -> 47.5
const benchCtx = { counts: { QB: 1, RB: 4, WR: 2, TE: 1 }, available: wrPool, gap: 3,
                   players: [P("x1", "RB", 100), P("x2", "RB", 60), P("x3", "RB", 45)],
                   pickNo: 3, myPlayers: [] };
assert.strictEqual(O.scorePlayer(wrPool[0], benchCtx), 47.5);
// a PAR benched player sinks: vona 0.2*45 = 9, steal 0
assert.strictEqual(O.scorePlayer(wrPool[1], benchCtx), 9);

// --- rankShortlist ----------------------------------------------------------
const shortlist = O.rankShortlist({
  counts: { QB: 0, RB: 0, WR: 0, TE: 0 }, available: pool, gap: 2,
  players: board, pickNo: 3, myPlayers: [],
});
assert.ok(shortlist.length <= O.SHORTLIST_N);
assert.ok(shortlist.every(r => typeof r.why === "string" && r.why.length));
// sorted by score desc
const scores = shortlist.map(r => r.score);
assert.deepStrictEqual(scores, scores.slice().sort((a, b) => b - a));

// --- lateSlotTrigger --------------------------------------------------------
assert.strictEqual(O.lateSlotTrigger(2, false, false), true);   // in the window, both open
assert.strictEqual(O.lateSlotTrigger(2, true, true), false);    // both already filled
assert.strictEqual(O.lateSlotTrigger(5, false, false), false);  // too early
assert.strictEqual(O.lateSlotTrigger(1, true, false), true);    // DST still open

console.log("optimizer_fixture: OK");
