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

// ===========================================================================
// v1.1 — Gap A (bands priced) and Gap B (flex worth less than dedicated)
// ===========================================================================
// Board shape for bands, as published by src/ffmodel/site/draft.py:
//   season_points: { ppr: {p10,p50,p90}, half_ppr: {...}, standard: {...} }
const band = (p10, p50, p90) => ({ season_points: { ppr: { p10, p50, p90 } } });

// --- bandGaps: only trust a well-formed PPR band ----------------------------
assert.strictEqual(O.bandGaps(P("nb", "RB", 50)), null);          // no season_points
assert.strictEqual(O.bandGaps(P("nb", "RB", 50, { season_points: {} })), null);
// has_bands:false publishes p10/p90 as null -> treated as absent
assert.strictEqual(O.bandGaps(P("nb", "RB", 50, band(null, 240, null))), null);
// crossed quantiles are a data bug, not a signal
assert.strictEqual(O.bandGaps(P("nb", "RB", 50, band(300, 240, 200))), null);
assert.strictEqual(O.bandGaps(P("nb", "RB", 50, band("200", 240, 300))), null);
assert.deepStrictEqual(O.bandGaps(P("b", "RB", 50, band(200, 240, 300))),
                       { p10: 200, p50: 240, p90: 300, down: 40, up: 60 });
// the ruleset is pinned to the one the value curve is built from
assert.strictEqual(O.BAND_RULESET, "ppr");

// --- riskValue: same appetite, opposite sign --------------------------------
// no band -> vorp, byte-identical, in BOTH roles
assert.strictEqual(O.riskValue(P("p", "RB", 50), true), 50);
assert.strictEqual(O.riskValue(P("p", "RB", 50), false), 50);
// must-start: downside room (p50-p10 = 40) is charged
assert.strictEqual(O.riskValue(P("p", "RB", 60, band(200, 240, 300)), true),
                   60 - O.W_RISK * 40);
// benched: upside room (p90-p50 = 60) is credited
assert.strictEqual(O.riskValue(P("p", "RB", 60, band(200, 240, 300)), false),
                   60 + O.W_RISK * 60);

// --- Gap A, starter side: the level shift CANCELS ---------------------------
// Two starters with equally wide bands must score exactly as they do today --
// the penalty is applied to the player AND to the survivor he is measured
// against, so only the *differential* spread can move the score.
const symX = P("symX", "RB", 60, band(200, 240, 300));   // down 40
const symS = P("symS", "RB", 50, band(160, 200, 260));   // down 40
const symPool = [symX, symS];
const plainPool = [P("symX", "RB", 60), P("symS", "RB", 50)];
assert.strictEqual(O.vona(symX, empty, symPool, 1), 10);
assert.strictEqual(O.vona(symX, empty, symPool, 1),
                   O.vona(plainPool[0], empty, plainPool, 1));   // no level shift

// ...but a differential DOES move it: same player, fallback is now boom/bust
const bustS = P("bustS", "RB", 50, band(120, 200, 260));  // down 80, not 40
assert.strictEqual(O.vona(symX, empty, [symX, bustS], 1), 20);
// the whole move is exactly W_RISK * (extra downside room on the fallback)
assert.strictEqual(O.vona(symX, empty, [symX, bustS], 1)
                   - O.vona(symX, empty, symPool, 1),
                   O.W_RISK * (80 - 40));

// --- Gap A: the SAME player is treated oppositely by slot -------------------
// Starter slot: his own downside is a cost, so he scores BELOW his no-band twin.
const twoWay = P("twoWay", "RB", 60, band(200, 240, 300));
const twoWayPool = [twoWay, P("fallback", "RB", 50)];        // fallback unbanded
const twoWayPlain = [P("twoWay", "RB", 60), P("fallback", "RB", 50)];
assert.strictEqual(O.vona(twoWay, empty, twoWayPool, 1), 0);
assert.strictEqual(O.vona(twoWayPlain[0], empty, twoWayPlain, 1), 10);
assert.ok(O.vona(twoWay, empty, twoWayPool, 1)
          < O.vona(twoWayPlain[0], empty, twoWayPlain, 1));
// Bench slot: the same band is now a credit, so he scores ABOVE his twin.
assert.strictEqual(O.vona(twoWay, full, twoWayPool, 1),
                   O.BENCH_WEIGHT * (60 + O.W_RISK * 60));
assert.ok(O.vona(twoWay, full, twoWayPool, 1)
          > O.vona(twoWayPlain[0], full, twoWayPlain, 1));

// --- Gap A, bench side: ceiling breaks the tie between equal medians --------
const dartHi = P("dartHi", "WR", 50, band(180, 200, 260));   // up 60
const dartLo = P("dartLo", "WR", 50, band(180, 200, 220));   // up 20
assert.strictEqual(O.vona(dartHi, full, [dartHi, dartLo], 1),
                   O.BENCH_WEIGHT * (50 + O.W_RISK * 60));
assert.strictEqual(O.vona(dartLo, full, [dartHi, dartLo], 1),
                   O.BENCH_WEIGHT * (50 + O.W_RISK * 20));
assert.ok(O.vona(dartHi, full, [dartHi, dartLo], 1)
          > O.vona(dartLo, full, [dartHi, dartLo], 1));

// --- Gap A: steal is deliberately NOT risk-adjusted -------------------------
// trade value is a different currency; one band must not move a score twice
assert.strictEqual(O.steal(P("s", "RB", 100, band(10, 50, 400)), board, 3),
                   O.steal(P("s", "RB", 100), board, 3));

// --- BACKWARD COMPATIBILITY: no bands => byte-identical to v1.0 -------------
// (the §6 worked-check asserts above — 47.5 and 9 — are unbanded and unchanged)
const bcPool = [P("bc1", "RB", 100), P("bc2", "WR", 90), P("bc3", "RB", 80)];
const bcCtx = { counts: { QB: 0, RB: 0, WR: 0, TE: 0 }, available: bcPool, gap: 2,
                players: [P("z1", "RB", 120), P("z2", "RB", 60)], pickNo: 2,
                myPlayers: [] };
// the v1.0 formula, rebuilt from primitives whose contract did not change
const legacyScore = Math.max(0, bcPool[0].vorp - O.replacement(bcPool, "RB", 2))
  + O.W_STEAL * O.steal(bcPool[0], bcCtx.players, bcCtx.pickNo)
  - O.byePenalty(bcPool[0], bcCtx.myPlayers, bcCtx.counts);
assert.strictEqual(O.scorePlayer(bcPool[0], bcCtx), legacyScore);
assert.strictEqual(O.scorePlayer(bcPool[0], bcCtx), 40);
// a player carrying a null band (has_bands:false) scores exactly like one
// carrying no band block at all -- pool differs only in that element
const nulledPool = [P("bc1", "RB", 100, band(null, 240, null)), bcPool[1], bcPool[2]];
assert.strictEqual(
  O.scorePlayer(nulledPool[0], Object.assign({}, bcCtx, { available: nulledPool })),
  O.scorePlayer(bcPool[0], bcCtx));
// callers pass no new ctx fields: the v1.0 ctx shape still scores identically
assert.deepStrictEqual(Object.keys(bcCtx).sort(),
  ["available", "counts", "gap", "myPlayers", "pickNo", "players"]);

// ===========================================================================
// Gap B — a flex opening is worth less than a dedicated one
// ===========================================================================
// the slot ladder: bench < flex < dedicated(1.0)
assert.ok(O.BENCH_WEIGHT < O.FLEX_WEIGHT && O.FLEX_WEIGHT < 1);

// --- B.1 the flex fallback spans ALL flex positions, not just his own -------
// pool desc: rbA 70, wrA 58, rbB 40. gap 1 -> RB survivor 40, WR survivor 58.
const flexPool = [P("rbA", "RB", 70), P("wrA", "WR", 58), P("rbB", "RB", 40)];
assert.strictEqual(O.fallbackValue(flexPool, "RB", 1, "dedicated"), 40);
assert.strictEqual(O.fallbackValue(flexPool, "RB", 1, "flex"), 58);  // the WR wins
// a flex fallback is never worse than the same-position one -- the inequality
// that makes "flex <= dedicated" structural rather than a hardcoded ordering
assert.ok(O.fallbackValue(flexPool, "RB", 1, "flex")
          >= O.fallbackValue(flexPool, "RB", 1, "dedicated"));
// same player, same pool, same gap: dedicated 30 vs flex 6
const flexCounts = { QB: 0, RB: 2, WR: 2, TE: 0 };   // RB -> flex, flex slots free
assert.strictEqual(O.openSlot("RB", flexCounts), "flex");
assert.strictEqual(O.vona(flexPool[0], empty, flexPool, 1), 30);        // dedicated
assert.strictEqual(O.vona(flexPool[0], flexCounts, flexPool, 1),
                   O.FLEX_WEIGHT * (70 - 58));                          // = 6
assert.strictEqual(O.vona(flexPool[0], flexCounts, flexPool, 1), 6);
// teeth for the cross-position term specifically: per-position would give 15
assert.notStrictEqual(O.vona(flexPool[0], flexCounts, flexPool, 1),
                      O.FLEX_WEIGHT * (70 - 40));
assert.ok(O.vona(flexPool[0], flexCounts, flexPool, 1)
          < O.vona(flexPool[0], empty, flexPool, 1));

// --- B.2 REGRESSION: greedy must not spend both flex slots on RBs -----------
// RB2 already filled, WR wide open. Both positions cliff after the gap, RB just
// slightly richer -- so v1.0, which prices a flex opening exactly like a
// dedicated one, takes RB3 then RB4 and never reaches WR1.
const gPool = [P("rb3", "RB", 72), P("rb4", "RB", 70), P("wr1", "WR", 68),
               P("wr2", "WR", 66), P("rb5", "RB", 40), P("wr3", "WR", 39),
               P("rb6", "RB", 38), P("wr4", "WR", 37)];
const gBoard = [P("par", "RB", 1000)];   // par >= every vorp -> steal 0 for all
const gCounts = { QB: 0, RB: 2, WR: 0, TE: 0 };
const gGap = 4;
assert.strictEqual(O.openSlot("RB", gCounts), "flex");
assert.strictEqual(O.openSlot("WR", gCounts), "dedicated");

// the v1.0 defect, reproduced from primitives that still exist: an undiscounted
// flex edge (32) beat the mandatory WR opening (29), which is why RBs won both.
const v10FlexRb3 = Math.max(0, gPool[0].vorp - O.replacement(gPool, "RB", gGap));
const v10DedWr1 = Math.max(0, gPool[2].vorp - O.replacement(gPool, "WR", gGap));
assert.strictEqual(v10FlexRb3, 32);
assert.strictEqual(v10DedWr1, 29);
assert.ok(v10FlexRb3 > v10DedWr1, "v1.0 defect: flex outbid a mandatory slot");

// v1.1: the cross-position max is the RB himself here (40 > 39), so this case
// isolates FLEX_WEIGHT -- 0.5 * 32 = 16, now below the WR's 29.
assert.strictEqual(O.fallbackValue(gPool, "RB", gGap, "flex"), 40);
assert.strictEqual(O.vona(gPool[0], gCounts, gPool, gGap), O.FLEX_WEIGHT * 32);
assert.strictEqual(O.vona(gPool[0], gCounts, gPool, gGap), 16);
assert.strictEqual(O.vona(gPool[2], gCounts, gPool, gGap), 29);
assert.ok(O.vona(gPool[2], gCounts, gPool, gGap)
          > O.vona(gPool[0], gCounts, gPool, gGap));

// run the greedy the way draft night actually runs it: take the top row, add
// him to the roster, remove him from the pool, re-rank.
function greedy(pool, counts, gap, boardRows, picks) {
  let avail = pool.slice();
  const c = Object.assign({}, counts);
  const taken = [];
  for (let i = 0; i < picks; i++) {
    const row = O.rankShortlist({ counts: c, available: avail, gap,
                                  players: boardRows, pickNo: 1, myPlayers: [] })[0];
    if (!row) break;
    taken.push(row.player);
    c[row.player.position]++;
    avail = avail.filter(p => p !== row.player);
  }
  return { taken, counts: c };
}
const g2 = greedy(gPool, gCounts, gGap, gBoard, 2);
assert.deepStrictEqual(g2.taken.map(p => p.position), ["WR", "WR"]);
assert.deepStrictEqual(g2.taken.map(p => p.name), ["wr1", "wr2"]);
assert.strictEqual(g2.counts.WR, 2);          // both mandatory WR slots filled
assert.strictEqual(g2.counts.RB, 2);          // zero flex slots burned on RBs
// and once the obligations are discharged the flex correctly takes the best
// player left, so this is a re-ordering, not a blanket ban on flex RBs
const g3 = greedy(gPool, gCounts, gGap, gBoard, 3);
assert.deepStrictEqual(g3.taken.map(p => p.position), ["WR", "WR", "RB"]);
assert.strictEqual(g3.taken[2].name, "rb3");

// --- whyLabel ---------------------------------------------------------------
const whyCtx = { counts: gCounts, available: gPool, gap: gGap, players: gBoard,
                 pickNo: 1, myPlayers: [] };
assert.ok(O.whyLabel(gPool[0], whyCtx).startsWith("fills flex"));
assert.ok(O.whyLabel(gPool[2], whyCtx).startsWith("fills WR1"));
// the cliff shown is the number that was actually scored (post-discount edge)
assert.ok(O.whyLabel(gPool[0], whyCtx).includes("−32.0"));
// starters surface p10 (the quantile that priced them)
const floorCtx = { counts: empty, available: [twoWay, P("fallback", "RB", 50)],
                   gap: 1, players: gBoard, pickNo: 1, myPlayers: [] };
assert.ok(O.whyLabel(twoWay, floorCtx).includes("floor 200"));
// bench darts surface p90; a flat bench player keeps the v1.0 wording
const dartCtx = { counts: full, available: [dartHi, dartLo], gap: 1,
                  players: gBoard, pickNo: 1, myPlayers: [] };
assert.ok(O.whyLabel(dartHi, dartCtx).includes("upside dart"));
assert.ok(O.whyLabel(dartHi, dartCtx).includes("ceiling 260"));
assert.strictEqual(O.whyLabel(P("flat", "RB", 50), dartCtx), "depth · safe to wait");
assert.strictEqual(O.whyLabel(P("flat", "RB", 50, band(198, 200, 205)), dartCtx),
                   "depth · safe to wait");   // sub-CLIFF_MIN upside is noise

console.log("optimizer_fixture: OK");
