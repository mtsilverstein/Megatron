// tests/optimizer_fixture.cjs — run with: node tests/optimizer_fixture.cjs
//
// Covers the v2 lookahead optimizer. The three defects that motivated v2 each
// get a regression test that FAILS against the old scoring path:
//   * the field drafts by ADP, not off our board   (see "field model")
//   * flex is decided on absolute points, not position-relative VORP
//   * reaching past ADP is never rewarded
const assert = require("assert");
const O = require("../site/assets/optimizer.js");

let n = 0;
const check = (label, fn) => { fn(); n++; };

// value_points is the absolute season projection; vorp is position-relative.
// Fixtures keep them independent on purpose -- the two disagree on the real
// board, and that disagreement is exactly what v1.1 got wrong.
const P = (name, position, value_points, extra = {}) =>
  Object.assign({ name, position, value_points, player_id: name,
                  vorp: value_points, bye: null, adp: null,
                  position_rank: 1, season_points: null }, extra);

// --- seasonValue / withValuePoints ------------------------------------------
check("seasonValue reads the published field", () => {
  assert.strictEqual(O.seasonValue(P("a", "RB", 150)), 150);
  assert.ok(Number.isNaN(O.seasonValue({ position: "RB" })));
});

check("withValuePoints reconstructs the ECR-ordered curve when absent", () => {
  // board_rank.order_and_value lays the position's ppr_p50 values, sorted
  // descending, onto ECR order -- so position_rank 1 takes the HIGHEST p50
  // even when that p50 belongs to a different player.
  const sp = v => ({ league: { p10: 0, p50: v, p90: 0 } });
  const raw = [
    { name: "a", position: "TE", position_rank: 1, season_points: sp(100) },
    { name: "b", position: "TE", position_rank: 2, season_points: sp(180) },
    { name: "c", position: "TE", position_rank: 3, season_points: sp(140) },
  ];
  const out = O.withValuePoints(raw);
  assert.strictEqual(out[0].value_points, 180);   // rank 1 <- highest p50
  assert.strictEqual(out[1].value_points, 140);
  assert.strictEqual(out[2].value_points, 100);
  assert.strictEqual(raw[0].value_points, undefined, "must not mutate input");
});

check("the value curve is rebuilt from the lens the board was built on", () => {
  // A board carrying the league lens was valued on it; a board predating it was
  // valued on ppr, so ppr is that board's CORRECT curve, not a degraded guess.
  // Reading the wrong lens reorders quarterbacks rather than merely rescaling.
  const withLeague = [{ position: "QB", season_points: { ppr: { p50: 1 }, league: { p50: 2 } } }];
  const ppromly = [{ position: "QB", season_points: { ppr: { p50: 1 } } }];
  assert.strictEqual(O.valueLens(withLeague), "league");
  assert.strictEqual(O.valueLens(ppromly), "ppr");
  assert.strictEqual(O.valueLens([]), "ppr");
});

check("withValuePoints leaves a payload that already has the field alone", () => {
  const rows = [P("a", "RB", 150)];
  assert.strictEqual(O.withValuePoints(rows), rows);
});

// --- bestLineup --------------------------------------------------------------
check("bestLineup fills dedicated slots first, then flex from the leftovers", () => {
  const roster = [P("qb", "QB", 200),
                  P("rb1", "RB", 180), P("rb2", "RB", 170), P("rb3", "RB", 160),
                  P("wr1", "WR", 150), P("wr2", "WR", 140), P("wr3", "WR", 130),
                  P("te1", "TE", 120), P("te2", "TE", 20)];
  const names = O.bestLineup(roster, O.seasonValue).map(p => p.name).sort();
  // QB + RB1/RB2 + WR1/WR2 + TE1 = 6 dedicated, then the two best leftovers
  // (rb3 160, wr3 130) take the flex slots. te2 misses out.
  assert.deepStrictEqual(names,
    ["qb", "rb1", "rb2", "rb3", "te1", "wr1", "wr2", "wr3"].sort());
});

check("bestLineup takes the BEST at each position, not draft order", () => {
  const starters = O.bestLineup([P("a", "RB", 50), P("b", "RB", 250),
                                 P("c", "RB", 100), P("d", "RB", 10),
                                 P("e", "RB", 5)], O.seasonValue);
  // 2 dedicated + 2 flex = 4 RBs start, and they must be the top four.
  assert.deepStrictEqual(starters.map(p => p.name).sort(), ["a", "b", "c", "d"]);
});

check("an unfilled slot contributes nothing — this is what forces a QB", () => {
  assert.strictEqual(O.lineupTotal([P("qb", "QB", 200), P("rb", "RB", 100)]), 300);
  assert.strictEqual(O.lineupTotal([P("rb", "RB", 100), P("rb2", "RB", 100)]), 200);
});

// --- lineupPoints: byes -------------------------------------------------------
check("with no byes, the weekly objective equals the season total", () => {
  const roster = [P("qb", "QB", 180), P("rb", "RB", 170)];
  assert.ok(Math.abs(O.lineupPoints(roster) - O.lineupTotal(roster)) < 1e-9);
});

check("a lone bye is not double-charged", () => {
  // A player's season projection already accounts for his bye, so summing his
  // weekly share back over the weeks he plays must return exactly that total.
  const solo = [P("rb1", "RB", 170, { bye: 7 })];
  assert.ok(Math.abs(O.lineupPoints(solo) - 170) < 1e-9);
});

check("byes are free until they change who actually starts", () => {
  // 3 RBs for 4 RB-eligible slots (2 dedicated + 2 flex): nobody is ever
  // benched, so every active player starts every week no matter how the byes
  // fall, and the total is just the sum of their seasons. This is not a
  // missing penalty -- there is genuinely nothing to lose.
  const shared = [P("a", "RB", 170, { bye: 7 }), P("b", "RB", 170, { bye: 7 }),
                  P("c", "RB", 60, { bye: 9 })];
  const spread = [P("a", "RB", 170, { bye: 7 }), P("b", "RB", 170, { bye: 9 }),
                  P("c", "RB", 60, { bye: 11 })];
  assert.ok(Math.abs(O.lineupPoints(shared) - 400) < 1e-9);
  assert.ok(Math.abs(O.lineupPoints(spread) - 400) < 1e-9);
});

check("stacked byes cost more than staggered ones, once you have a bench", () => {
  // 5 RBs for 4 slots, so `e` is the bench and only plays when a starter is
  // out. Same five players and same season totals in both rosters -- only the
  // bye WEEKS differ. Stacked byes waste him: in a week when two starters sit,
  // he can only fill one of the two open slots and the other scores nothing.
  const roster = byes => [P("a", "RB", 170, { bye: byes[0] }),
                          P("b", "RB", 170, { bye: byes[1] }),
                          P("c", "RB", 160, { bye: byes[2] }),
                          P("d", "RB", 150, { bye: byes[3] }),
                          P("e", "RB", 60, { bye: byes[4] })];
  const shared = roster([7, 7, 9, 9, 11]);
  const spread = roster([7, 9, 11, 13, 15]);
  assert.ok(O.lineupPoints(spread) > O.lineupPoints(shared),
    `staggered ${O.lineupPoints(spread)} should beat stacked ${O.lineupPoints(shared)}`);
});

// --- field model: ADP, not our board ------------------------------------------
check("fieldTakes drafts the market, and ignores players with no ADP", () => {
  const pool = [P("ourFave", "WR", 250, { adp: 90 }),
                P("marketFave", "WR", 100, { adp: 1 }),
                P("undrafted", "WR", 200)];
  assert.deepStrictEqual(O.fieldTakes(pool, 1).map(p => p.name), ["marketFave"]);
  assert.deepStrictEqual(O.fieldTakes(pool, 0), []);
  // The player OUR board loves is not assumed gone. Assuming it is the v1.1
  // bug that manufactured cliffs and over-drafted tight ends.
  assert.ok(!O.fieldTakes(pool, 1).some(p => p.name === "ourFave"));
});

check("nextAtPosition names who survives to your next pick, by ADP", () => {
  const target = P("target", "TE", 200, { adp: 5 });
  // Enough filler that the field's three picks are absorbed by the players the
  // market actually wants next -- with a pool this small, "best available by
  // ADP" would otherwise clear the whole board.
  const pool = [target, P("goneSoon", "TE", 190, { adp: 6 }),
                P("f1", "WR", 300, { adp: 7 }), P("f2", "WR", 290, { adp: 8 }),
                P("lasts", "TE", 150, { adp: 80 })];
  // On the clock at #10 with your next pick at #14: the field makes 11, 12, 13.
  assert.strictEqual(O.nextAtPosition(target, pool, [14], 10).name, "lasts");
  assert.strictEqual(O.nextAtPosition(target, pool, [], 10), null);
});

// --- topCandidates: position-fair ---------------------------------------------
check("candidates are drawn per position, so QBs cannot crowd the list", () => {
  // QB replacement level is the highest of any position, so raw season points
  // rank every QB above every TE. A flat top-N returned five quarterbacks and
  // never looked at a receiver.
  const ranked = [];
  for (let i = 0; i < 10; i++) ranked.push(P(`qb${i}`, "QB", 200 - i));
  for (let i = 0; i < 10; i++) ranked.push(P(`te${i}`, "TE", 120 - i));
  assert.deepStrictEqual(O.topCandidates(ranked, 2).map(p => p.name),
    ["qb0", "qb1", "te0", "te1"]);
});

// --- recommend -----------------------------------------------------------------
function flexBoard() {
  return [P("QB1", "QB", 200, { adp: 1, vorp: 10 }),
          P("RB1", "RB", 190, { adp: 2, vorp: 70 }),
          P("RB2", "RB", 185, { adp: 3, vorp: 65 }),
          P("WR1", "WR", 180, { adp: 4, vorp: 60 }),
          P("WR2", "WR", 175, { adp: 5, vorp: 55 }),
          P("TE1", "TE", 170, { adp: 6, vorp: 90 }),
          P("scarceTE", "TE", 140, { adp: 40, vorp: 60 }),
          P("richWR", "WR", 150, { adp: 41, vorp: 30 })];
}

check("recommend returns at most SHORTLIST_N, best first, cost 0 at the top", () => {
  const out = O.recommend({ available: flexBoard(), myPlayers: [],
                            pickNo: 1, futurePicks: [2, 3, 4] });
  assert.ok(out.length > 0 && out.length <= O.SHORTLIST_N);
  assert.strictEqual(out[0].cost, 0);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].points <= out[i - 1].points, "sorted by projection");
    assert.ok(out[i].cost >= 0, "cost is what you give up vs. the top pick");
  }
});

check("FLEX is decided on absolute points, never position-relative VORP", () => {
  // Dedicated slots are full, so the next RB/WR/TE can only take a FLEX spot.
  // `scarceTE` carries DOUBLE the VORP of `richWR` but scores 10 fewer points.
  // In a flex slot you start whoever scores more, so the receiver must win.
  // v1.1 compared riskValue(vorp) here and took the tight end.
  const mine = [P("m1", "QB", 200), P("m2", "RB", 190), P("m3", "RB", 185),
                P("m4", "WR", 180), P("m5", "WR", 175), P("m6", "TE", 170)];
  const scarceTE = P("scarceTE", "TE", 140, { adp: 40, vorp: 60 });
  const richWR = P("richWR", "WR", 150, { adp: 41, vorp: 30 });
  assert.ok(scarceTE.vorp > richWR.vorp, "fixture must set up the disagreement");
  const out = O.recommend({ available: [scarceTE, richWR], myPlayers: mine,
                            pickNo: 20, futurePicks: [] });
  assert.strictEqual(out[0].player.name, "richWR",
    "the flex slot must go to the higher SCORER, not the higher VORP");
});

check("an empty QB slot outranks a marginal bench upgrade", () => {
  // v1.1 drafted 0 quarterbacks in 96 simulated picks: a flat position never
  // produced a cliff, so it never became urgent. Here the empty slot is worth
  // its occupant's full points and cannot be ignored.
  const mine = [P("m2", "RB", 190), P("m3", "RB", 185),
                P("m4", "WR", 180), P("m5", "WR", 175), P("m6", "TE", 170)];
  const out = O.recommend({
    available: [P("theQB", "QB", 120, { adp: 30 }),
                P("benchWR", "WR", 118, { adp: 31 })],
    myPlayers: mine, pickNo: 40, futurePicks: [],
  });
  assert.strictEqual(out[0].player.name, "theQB");
});

check("reaching past ADP earns no bonus — it is reported, not rewarded", () => {
  // v1.1's `steal` term paid for a reach: Loveland, ADP 41, drew +5.34 at
  // pick 30. Two identical players must now score identically.
  const out = O.recommend({
    available: [P("reach", "WR", 150, { adp: 90 }), P("fair", "WR", 150, { adp: 10 })],
    myPlayers: [], pickNo: 30, futurePicks: [],
  });
  const by = Object.fromEntries(out.map(r => [r.player.name, r]));
  assert.strictEqual(by.reach.points, by.fair.points);
  assert.ok(by.reach.adpDelta < 0, "a reach reads as a negative delta");
  assert.ok(by.fair.adpDelta > 0, "falling past ADP reads as positive");
});

check("byeClash counts YOUR roster, not the simulated finish", () => {
  // A warning the user cannot check against their own team is noise.
  const mine = [P("m1", "RB", 190, { bye: 11 }), P("m2", "WR", 180, { bye: 11 }),
                P("m3", "WR", 170, { bye: 5 })];
  const cand = P("cand", "RB", 160, { bye: 11 });
  assert.strictEqual(O.byeClash(cand, mine), 2);
  assert.strictEqual(O.byeClash(P("x", "RB", 1, { bye: 9 }), mine), 0);
  assert.strictEqual(O.byeClash(P("nobye", "RB", 1), mine), 0);
  const out = O.recommend({ available: [cand], myPlayers: mine, pickNo: 40,
                            futurePicks: [] });
  assert.strictEqual(out[0].byeClash, 2);
});

check("role names the lineup slot he actually fills", () => {
  const out = O.recommend({ available: flexBoard(), myPlayers: [],
                            pickNo: 1, futurePicks: [2, 3, 4, 5, 6, 7, 8, 9] });
  for (const r of out) {
    assert.ok(/^(QB|TE|FLEX|bench|RB[12]|WR[12])$/.test(r.role), `bad role: ${r.role}`);
  }
});

check("degrades rather than throwing on thin or missing input", () => {
  assert.deepStrictEqual(
    O.recommend({ available: [], myPlayers: [], pickNo: 1, futurePicks: [] }), []);
  assert.ok(O.recommend({ available: flexBoard(), myPlayers: [], pickNo: 1 }).length > 0,
    "a missing futurePicks must degrade, not throw");
});

check("players the optimizer cannot value are skipped, not crashed on", () => {
  const out = O.recommend({
    available: [P("ok", "RB", 150), { name: "novalue", position: "RB" },
                P("kicker", "K", 300)],
    myPlayers: [], pickNo: 1, futurePicks: [2],
  });
  assert.deepStrictEqual(out.map(r => r.player.name), ["ok"]);
});

// --- depth cap: ties only -------------------------------------------------------
check("the depth cap breaks ties but never overrides a real gain", () => {
  const mine = [P("q1", "QB", 200), P("q2", "QB", 190)];   // QB cap is 2
  const out = O.recommend({
    available: [P("qb3", "QB", 195, { vorp: 999 }), P("rb", "RB", 80)],
    myPlayers: mine, pickNo: 50, futurePicks: [],
  });
  assert.strictEqual(out[0].player.name, "rb",
    "a real lineup gain must beat the tie-break, however high the loser's VORP");
});

check("when the objective is indifferent, the cap decides", () => {
  // Lineup already full and no bye coverage on offer, so neither candidate
  // changes the projection at all -- both are pure bench. The uncapped
  // position must win even though the capped one carries more VORP.
  const mine = [P("q1", "QB", 300), P("q2", "QB", 290),
                P("r1", "RB", 280), P("r2", "RB", 270), P("r3", "RB", 260),
                P("w1", "WR", 250), P("w2", "WR", 240), P("w3", "WR", 230),
                P("t1", "TE", 220)];
  const out = O.recommend({
    available: [P("qb3", "QB", 5, { vorp: 90 }), P("wr4", "WR", 5, { vorp: 10 })],
    myPlayers: mine, pickNo: 90, futurePicks: [],
  });
  assert.strictEqual(out[0].player.name, "wr4");
});

// --- lateSlotTrigger (unchanged from v1) ----------------------------------------
check("lateSlotTrigger fires only late, and only with a slot open", () => {
  assert.strictEqual(O.lateSlotTrigger(2, false, false), true);
  assert.strictEqual(O.lateSlotTrigger(2, true, true), false);
  assert.strictEqual(O.lateSlotTrigger(3, false, false), false);
  assert.strictEqual(O.lateSlotTrigger(NaN, false, false), false);
});

// --- parVorp: still used by keepers.js -------------------------------------------
check("parVorp reads the board row at that rank and floors at 0", () => {
  const board = [P("a", "RB", 1, { vorp: 50 }), P("b", "RB", 1, { vorp: 20 }),
                 P("c", "RB", 1, { vorp: -5 })];
  assert.strictEqual(O.parVorp(board, 1), 50);
  assert.strictEqual(O.parVorp(board, 2), 20);
  assert.strictEqual(O.parVorp(board, 3), 0);
  assert.strictEqual(O.parVorp(board, 99), 0);
});

check("keepers.js's imports are all still exported", () => {
  for (const k of ["FLEX_WEIGHT", "BENCH_WEIGHT", "parVorp", "rosterSlots",
                   "openSlot"]) {
    assert.ok(O[k] !== undefined, `keepers.js needs Optimizer.${k}`);
  }
});

console.log(`optimizer fixture: ${n} groups OK`);
