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

check("cost and waitCost are the same kind of number", () => {
  // Both must go through the lineup objective. The tempting shortcut for
  // waitCost -- subtracting the two players' season values -- answers a
  // different question and disagrees: it ignores whether either man would
  // START. On the live board that shipped a panel charging 9.5 points for
  // Michael Pittman while reporting that waiting for Godwin cost nothing.
  // Here every lineup slot is already filled, so the next receiver is pure
  // bench depth and waiting can cost only what bye cover is worth -- far less
  // than the 50-point raw gap between him and his replacement.
  const mine = [P("qb", "QB", 300, { bye: 2 }),
                P("rb1", "RB", 290, { bye: 3 }), P("rb2", "RB", 285, { bye: 4 }),
                P("rb3", "RB", 280, { bye: 5 }), P("rb4", "RB", 275, { bye: 6 }),
                P("wr1", "WR", 270, { bye: 7 }), P("wr2", "WR", 265, { bye: 8 }),
                P("te", "TE", 260, { bye: 9 })];
  const good = P("goodWR", "WR", 150, { adp: 50, bye: 10 });
  const worse = P("worseWR", "WR", 100, { adp: 90, bye: 11 });
  const filler = [];
  for (let i = 0; i < 20; i++) filler.push(P(`f${i}`, "RB", 90 - i, { adp: 51 + i }));
  const out = O.recommend({ available: [good, worse, ...filler], myPlayers: mine,
                            pickNo: 60, futurePicks: [70] });
  const g = out.find(r => r.player.name === "goodWR");
  assert.ok(g, "the candidate must be scored");
  const naive = O.seasonValue(good) - O.seasonValue(worse);
  assert.strictEqual(naive, 50, "fixture must set up a large raw gap");
  assert.ok(Math.abs(g.waitCost) < naive / 2,
    `waitCost ${g.waitCost} must reflect the LINEUP, not the ${naive}-point raw gap`);
  // and it must stay in the same units as cost: both are lineup points
  for (const r of out) {
    if (r.waitCost !== null) assert.ok(Number.isFinite(r.waitCost));
  }
});

check("openSlots names what is still EMPTY, in lineupRole's vocabulary", () => {
  // The counts line already says what you hold. This is the arithmetic nobody
  // should be doing on the clock: QB 1 / RB 2 / WR 1 / TE 0 means WR2, TE and
  // both flex spots are open.
  assert.deepStrictEqual(O.openSlots([]),
    ["QB", "RB1", "RB2", "WR1", "WR2", "TE", "FLEX", "FLEX"]);
  assert.deepStrictEqual(
    O.openSlots([P("q", "QB", 1), P("r1", "RB", 1), P("r2", "RB", 1),
                 P("w1", "WR", 1)]),
    ["WR2", "TE", "FLEX", "FLEX"]);
});

check("surplus at a flex position closes a FLEX slot, not an unfillable one", () => {
  // A third running back cannot open an RB3 slot -- there isn't one. He fills
  // flex, exactly as bestLineup would use him, so one flex spot closes.
  const three = [P("a", "RB", 4), P("b", "RB", 3), P("c", "RB", 2)];
  assert.deepStrictEqual(O.openSlots(three), ["QB", "WR1", "WR2", "TE", "FLEX"]);
  // a fourth closes the other one
  const four = three.concat([P("d", "RB", 1)]);
  assert.deepStrictEqual(O.openSlots(four), ["QB", "WR1", "WR2", "TE"]);
  // and the labels must be the ones lineupRole hands the panel, or the two
  // halves of the UI disagree about the same slot
  const roster = [P("q", "QB", 9), P("r1", "RB", 8), P("r2", "RB", 7),
                  P("w1", "WR", 6), P("w2", "WR", 5), P("t", "TE", 4)];
  assert.deepStrictEqual(O.openSlots(roster), ["FLEX", "FLEX"]);
  assert.ok(O.bestLineup(roster, O.seasonValue).length === 6,
    "six dedicated starters, two flex spots still to fill");
});

check("a full lineup reports nothing open", () => {
  const full = [P("q", "QB", 9), P("r1", "RB", 8), P("r2", "RB", 7), P("r3", "RB", 6),
                P("w1", "WR", 5), P("w2", "WR", 4), P("w3", "WR", 3), P("t", "TE", 2)];
  assert.deepStrictEqual(O.openSlots(full), []);
  // extra depth beyond a full lineup must not resurrect a slot
  assert.deepStrictEqual(O.openSlots(full.concat([P("x", "RB", 1)])), []);
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

// --- scarcity breaks ties before value does --------------------------------------
check("survivesToNextPick asks whether the field takes HIM", () => {
  // The player under test must stay in the pool being drafted from -- the
  // question is whether the market reaches him, not who is left beside him.
  const cheap = P("cheap", "WR", 100, { adp: 200 });
  const dear  = P("dear",  "WR", 100, { adp: 1 });
  // The pool must outlast the gap, or the field simply takes everyone and the
  // test proves nothing about ordering.
  const between = [2, 3, 4, 5].map(a => P("f" + a, "WR", 100, { adp: a }));
  const pool  = [cheap, dear, ...between];
  // 4 picks pass before your next turn: the field takes the lowest ADP first.
  assert.strictEqual(O.survivesToNextPick(dear,  pool, [50], 45), false);
  assert.strictEqual(O.survivesToNextPick(cheap, pool, [50], 45), true);
  // No next pick: nothing to wait for, so everyone "survives" and the
  // tiebreak this drives goes quiet rather than guessing.
  assert.strictEqual(O.survivesToNextPick(dear, pool, [], 45), true);
  // Back-to-back picks: no one is taken in between.
  assert.strictEqual(O.survivesToNextPick(dear, pool, [46], 45), true);
});

check("among equals, take the one you cannot get later", () => {
  // Lineup full and byes covered, so neither candidate changes the projection
  // -- exactly the late-round tie. `scarce` carries LESS vorp, so the old
  // vorp-only tiebreak took `plentiful`, spending the pick on the one man the
  // field was never going to take. Measured on the real board at pick 130:
  // Juwan Johnson (ADP 187) over Hunter Henry (ADP 139), both projecting the
  // same lineup.
  const mine = [P("q1", "QB", 300), P("q2", "QB", 290),
                P("r1", "RB", 280), P("r2", "RB", 270), P("r3", "RB", 260),
                P("w1", "WR", 250), P("w2", "WR", 240), P("w3", "WR", 230),
                P("t1", "TE", 220)];
  const scarce    = P("scarce",    "TE", 5, { vorp: 1,  adp: 131 });
  const plentiful = P("plentiful", "TE", 5, { vorp: 40, adp: 400 });
  // Filler the field will actually spend its picks on, so the gap is real.
  const filler = [];
  for (let i = 0; i < 40; i++) filler.push(P("f" + i, "WR", 4, { vorp: 0, adp: 132 + i }));
  const out = O.recommend({ available: [plentiful, scarce, ...filler],
                            myPlayers: mine, pickNo: 130, futurePicks: [154] });
  assert.strictEqual(out[0].player.name, "scarce",
    "took the player who would still have been there next turn");
  const byName = Object.fromEntries(out.map(r => [r.player.name, r]));
  assert.strictEqual(byName.scarce.survivesToNext, false);
  assert.ok(!byName.plentiful || byName.plentiful.survivesToNext === true);
});

check("scarcity never overrides a real lineup gain", () => {
  // The tiebreak sits BELOW the objective, and showing that needs a case where
  // the objective genuinely differs. With a future pick it usually does NOT:
  // taking the scarce man now and the starter later ends on the same roster,
  // which is exactly why the tiebreak is allowed to decide there.
  //
  // Here it differs. Two good WRs survive to the next pick and only one pick
  // remains, so:
  //   take realStarter now -> the rollout adds goodTwo   -> WR200 + WR190
  //   take scarceBench now -> the rollout adds realStarter -> QB10  + WR200
  // A second QB cannot start (QB has one slot and cannot flex), so the first
  // line is worth ~190 more. Scarcity must not touch that.
  const mine = [P("q1", "QB", 300), P("r1", "RB", 280), P("r2", "RB", 270)];
  const scarceBench = P("scarceBench", "QB", 10,  { vorp: 5, adp: 1 });
  const realStarter = P("realStarter", "WR", 200, { vorp: 5, adp: 400 });
  const goodTwo     = P("goodTwo",     "WR", 190, { vorp: 5, adp: 401 });
  const soaks = [];
  for (let i = 2; i <= 26; i++) soaks.push(P("s" + i, "TE", 1, { vorp: 0, adp: i }));
  const pool = [scarceBench, realStarter, goodTwo, ...soaks];
  // Precondition: the candidates really do differ on survival.
  assert.strictEqual(O.survivesToNextPick(scarceBench, pool, [120], 100), false);
  assert.strictEqual(O.survivesToNextPick(realStarter, pool, [120], 100), true);
  const out = O.recommend({ available: pool, myPlayers: mine,
                            pickNo: 100, futurePicks: [120] });
  assert.strictEqual(out[0].player.name, "realStarter",
    "scarcity outranked a real lineup gain");
});
// --- the keeper pick horizon -----------------------------------------------------
// A keeper league pre-consumes pick slots, so the DISTANCE between two of your
// turns is not the number of selections that happen in between. Everything that
// asks "who is gone by my next pick" used the distance. In this league that is
// 22 phantom selections across the draft -- 9 in the gap from #130 to #154
// alone -- which makes the pool look scarcer than it is and pulls picks early.

check("openPicksBetween counts selections, not distance", () => {
  assert.strictEqual(O.openPicksBetween(10, 20, null), 9);
  assert.strictEqual(O.openPicksBetween(10, 20, new Set()), 9,
    "an empty used-set must behave exactly like no keepers at all");
  assert.strictEqual(O.openPicksBetween(10, 20, new Set([12, 14, 16])), 6);
  // Only the numbers strictly between the two picks count.
  assert.strictEqual(O.openPicksBetween(10, 20, new Set([10, 20])), 9);
  assert.strictEqual(O.openPicksBetween(10, 11, new Set()), 0);
});

// 20 players across the four positions, ADP 1..20, so "the field takes n" is
// exactly "ADP 1..n" and the shortlist spans several positions.
const HPOS = ["RB", "WR", "TE", "QB"];
const horizonPool = () => Array.from({ length: 20 }, (_, i) =>
  P("a" + (i + 1), HPOS[i % 4], 100 - i, { vorp: 100 - i, adp: i + 1 }));
// Seven of the nine slots between pick 10 and pick 20 are keepers, so only
// two selections actually happen.
const HKEPT = new Set([12, 13, 14, 15, 16, 17, 18]);

check("survival is judged on real selections, not the pick gap", () => {
  const pool = horizonPool();
  const at3 = pool.find(p => p.adp === 3);
  // Distance 9 -> the field reaches ADP 9, so he is long gone.
  assert.strictEqual(O.survivesToNextPick(at3, pool, [20], 10), false);
  // Really only 2 selections happen, so he is still there.
  assert.strictEqual(O.survivesToNextPick(at3, pool, [20], 10, HKEPT), true);
});

check("the wait answer is judged the same way", () => {
  const pool = horizonPool();
  const mine = pool.find(p => p.adp === 1);
  const raw = O.nextAtPosition(mine, pool, [20], 10);
  const kept = O.nextAtPosition(mine, pool, [20], 10, HKEPT);
  assert.ok(raw && kept);
  // Fewer selections means a better man is still there when you come back.
  assert.ok(O.seasonValue(kept) > O.seasonValue(raw),
    "keeper slots were counted as live picks in the wait answer");
});

check("the rollout does not draft players nobody selected", () => {
  const pool = horizonPool();
  const raw  = O.finishRoster([], pool, [20], 10);
  const kept = O.finishRoster([], pool, [20], 10, HKEPT);
  // You make the same number of picks either way; what changes is WHO is left
  // for them. Blind, the rollout believes ADP 1-9 are gone and settles for
  // a10; knowing only two selections happen, it takes a3. A >= here would
  // have passed on equality and let the whole fix be reverted unnoticed.
  assert.strictEqual(raw.length, kept.length);
  assert.deepStrictEqual(raw.map(p => p.name), ["a10"]);
  assert.deepStrictEqual(kept.map(p => p.name), ["a3"]);
  assert.ok(O.lineupPoints(kept) > O.lineupPoints(raw));
});

check("recommend threads usedPicks through to the field model", () => {
  const pool = horizonPool();
  const blind = O.recommend({ available: pool, myPlayers: [], pickNo: 10,
                              futurePicks: [20] });
  const aware = O.recommend({ available: pool, myPlayers: [], pickNo: 10,
                              futurePicks: [20], usedPicks: HKEPT });
  const survivors = out => out.filter(r => r.survivesToNext).length;
  assert.strictEqual(survivors(blind), 0, "nine phantom picks bury everyone");
  assert.ok(survivors(aware) > 0,
    "usedPicks never reached the field model");
  // An empty set must leave a keeper-free draft byte-for-byte as it was.
  const empty = O.recommend({ available: pool, myPlayers: [], pickNo: 10,
                              futurePicks: [20], usedPicks: new Set() });
  assert.deepStrictEqual(empty.map(r => `${r.player.name}:${r.survivesToNext}`),
                         blind.map(r => `${r.player.name}:${r.survivesToNext}`));
});
// --- lateSlotTrigger -------------------------------------------------------------
// The window scales with how many mandatory slots are still empty. It used to be
// a flat two rounds, which meant two empty starting slots got a warning with
// exactly two picks left to fill them -- and since the shortlist can never
// contain a K or a D/ST, following the shortlist spent both. Two mock drafts
// ended with 15 skill players and neither slot filled.
check("the warning arrives with room to act, scaled to what is missing", () => {
  // Two slots missing: needs two picks, so it must warn with slack for both.
  assert.strictEqual(O.lateSlotTrigger(4, false, false), true);
  assert.strictEqual(O.lateSlotTrigger(5, false, false), false);
  // One slot missing: one pick to spend, so it can wait a round longer.
  assert.strictEqual(O.lateSlotTrigger(3, true, false), true);
  assert.strictEqual(O.lateSlotTrigger(4, true, false), false);
  assert.strictEqual(O.lateSlotTrigger(3, false, true), true);
  // Two empty slots must ALWAYS warn at least as early as one empty slot;
  // a window that ignored `needed` would make these two agree.
  assert.strictEqual(O.lateSlotTrigger(4, false, false), true);
  assert.strictEqual(O.lateSlotTrigger(4, true, false), false);
});

check("lateSlotTrigger stays quiet when there is nothing to fill", () => {
  assert.strictEqual(O.lateSlotTrigger(1, true, true), false);
  assert.strictEqual(O.lateSlotTrigger(0, true, true), false);
  assert.strictEqual(O.lateSlotTrigger(NaN, false, false), false);
  // Still fires on the very last pick when a slot is open -- late is not never.
  assert.strictEqual(O.lateSlotTrigger(1, true, false), true);
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

// --- shortlistSpread: five quarterbacks is not five choices ----------------
// Display-only. Measured in this league, QBs last 19 picks past their market
// position, so "take the QB" is often right -- and the shortlist then came
// back as five QBs, four of which are the same decision with a worse player.
const ent = (name, position) => ({ player: { name, position } });
const names = list => list.map(e => e.player.name).join(",");
check("caps a position at two and lets the other choices through", () => {
  // The reported panel: four QBs ahead of every other position.
  const scored = [ent("qb1", "QB"), ent("qb2", "QB"), ent("qb3", "QB"),
                  ent("qb4", "QB"), ent("wr1", "WR"), ent("wr2", "WR"),
                  ent("rb1", "RB"), ent("te1", "TE")];
  assert.strictEqual(names(O.shortlistSpread(scored, 5, 2)),
                     "qb1,qb2,wr1,wr2,rb1");
});

check("backfill only fires when there is genuinely nothing else to show", () => {
  // One WR and one RB on the whole board: a third QB is then the honest
  // fifth entry, not a presentation failure. Capped entries return in their
  // original cost order, after the uncapped ones.
  const scored = [ent("qb1", "QB"), ent("qb2", "QB"), ent("qb3", "QB"),
                  ent("qb4", "QB"), ent("wr1", "WR"), ent("rb1", "RB")];
  assert.strictEqual(names(O.shortlistSpread(scored, 5, 2)),
                     "qb1,qb2,wr1,rb1,qb3");
});

check("the objective's top pick is always entry 1", () => {
  const scored = [ent("te1", "TE"), ent("te2", "TE"), ent("te3", "TE"),
                  ent("wr1", "WR")];
  assert.strictEqual(O.shortlistSpread(scored, 5, 2)[0].player.name, "te1");
});

check("order within the list is untouched -- it is still cost order", () => {
  const scored = [ent("qb1", "QB"), ent("wr1", "WR"), ent("qb2", "QB"),
                  ent("rb1", "RB"), ent("qb3", "QB"), ent("te1", "TE")];
  assert.strictEqual(names(O.shortlistSpread(scored, 5, 2)),
                     "qb1,wr1,qb2,rb1,te1");
});

check("backfills past the cap when a position has genuinely run out", () => {
  // Only quarterbacks left on the board: five QBs is then the honest list,
  // not a presentation failure.
  const scored = ["a", "b", "c", "d", "e", "f"].map(x => ent(x, "QB"));
  assert.strictEqual(names(O.shortlistSpread(scored, 5, 2)), "a,b,c,d,e");
});

check("backfill preserves cost order and never duplicates an entry", () => {
  const scored = [ent("qb1", "QB"), ent("qb2", "QB"), ent("qb3", "QB"),
                  ent("wr1", "WR"), ent("qb4", "QB")];
  const out = O.shortlistSpread(scored, 5, 2);
  assert.strictEqual(names(out), "qb1,qb2,wr1,qb3,qb4");
  assert.strictEqual(new Set(out).size, out.length);
});

check("a short list is returned whole, and an empty one stays empty", () => {
  assert.strictEqual(names(O.shortlistSpread([ent("a", "QB")], 5, 2)), "a");
  assert.deepStrictEqual(O.shortlistSpread([], 5, 2), []);
});

check("recommend spans at least three positions on the real board shape", () => {
  // Regression for the reported panel: QB-heavy scoring must not fill the
  // shortlist with one position when other positions are available.
  const mk = (nm, pos, pts, adp) => P(nm, pos, pts, { adp });
  const pool = [];
  for (let i = 0; i < 6; i++) pool.push(mk(`q${i}`, "QB", 250 - i, 50 + i));
  for (let i = 0; i < 6; i++) pool.push(mk(`w${i}`, "WR", 180 - i, 20 + i));
  for (let i = 0; i < 6; i++) pool.push(mk(`r${i}`, "RB", 150 - i, 25 + i));
  for (let i = 0; i < 6; i++) pool.push(mk(`t${i}`, "TE", 140 - i, 40 + i));
  const sl = O.recommend({ available: pool, myPlayers: [], pickNo: 10,
                           futurePicks: [20, 30, 40] });
  const posns = new Set(sl.map(e => e.player.position));
  assert.ok(sl.length === 5, `expected 5 entries, got ${sl.length}`);
  assert.ok(posns.size >= 3, `shortlist spans only ${[...posns].join(",")}`);
  for (const pos of posns) {
    assert.ok(sl.filter(e => e.player.position === pos).length <= 2,
              `more than two ${pos} in the shortlist`);
  }
});

console.log(`optimizer fixture: ${n} groups OK`);
