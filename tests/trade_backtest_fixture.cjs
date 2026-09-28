// tests/trade_backtest_fixture.cjs — run: node tests/trade_backtest_fixture.cjs
//
// Pins the walk-forward trade backtest (tools/trade_backtest.cjs) on a hand-built
// mini season whose answers are worked out below by hand. The backtest's verdict
// file decides whether a trade grade ever reaches the public site, so its own
// arithmetic is the thing that must not be silently wrong.
const assert = require("node:assert/strict");
const T = require("../tools/trade_backtest.cjs");

let n = 0; const check = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: got ${a}, expected ${b}`);

/* ---------------------------------------------------------------------------
   The mini season. Weeks 5..7 (origin 5), slots QB / RB / FLEX, two teams.
   p50 is frozen (the same every week here); "actual" is league points; "—" =
   no actual_weeks entry that week (did not play).

   team A (roster 0)            p50        actual w5 w6 w7
     aQ  QB                     20                18 25 22
     aR1 RB                     15                10 20 12
     aR2 RB                      8                 5  9 14
     aW  WR                     10                12  3  8
   team B (roster 1)
     bQ  QB                     18                20  — 16     (misses week 6)
     bR  RB                     12 (no forecast row in week 7)  7 15 11
     bW1 WR                     14                16  6 21
     bW2 WR                      6 (bye week 6)    9  —  4
   undrafted
     uQ  QB                     11                13 12  9
     uR  RB                      7                 6  8  5
     uW  WR                      9                10  —  7
   ------------------------------------------------------------------------- */
const WEEKS = [5, 6, 7];
const SLOTS = ["QB", "RB", "FLEX"];
const play = p50 => ({ status: "play", p10: Math.max(0, p50 - 5), p50, p90: p50 + 8 });
const every = p50 => ({ 5: play(p50), 6: play(p50), 7: play(p50) });
const FC = { schema_version: 1, season: 2023, origin: 5, weeks: WEEKS, players: {
  aQ:  { position: "QB", baseline: 19, weeks: every(20) },
  aR1: { position: "RB", baseline: 13, weeks: every(15) },
  aR2: { position: "RB", baseline: 9,  weeks: every(8) },
  aW:  { position: "WR", baseline: 11, weeks: every(10) },
  bQ:  { position: "QB", baseline: 17, weeks: every(18) },
  bR:  { position: "RB", baseline: 12, weeks: { 5: play(12), 6: play(12) } },   // week 7 missing
  bW1: { position: "WR", baseline: 15, weeks: every(14) },
  bW2: { position: "WR", baseline: 5,  weeks: { 5: play(6), 6: { status: "bye" }, 7: play(6) } },
  uQ:  { position: "QB", baseline: 10, weeks: every(11) },
  uR:  { position: "RB", baseline: 6,  weeks: every(7) },
  uW:  { position: "WR", baseline: 8,  weeks: every(9) },
} };
const ACT = {
  aQ: { 5: 18, 6: 25, 7: 22 }, aR1: { 5: 10, 6: 20, 7: 12 }, aR2: { 5: 5, 6: 9, 7: 14 }, aW: { 5: 12, 6: 3, 7: 8 },
  bQ: { 5: 20, 7: 16 }, bR: { 5: 7, 6: 15, 7: 11 }, bW1: { 5: 16, 6: 6, 7: 21 }, bW2: { 5: 9, 7: 4 },
  uQ: { 5: 13, 6: 12, 7: 9 }, uR: { 5: 6, 6: 8, 7: 5 }, uW: { 5: 10, 7: 7 },
};
// String week keys, exactly like world_{S}.json's actual_weeks.
for (const id of Object.keys(ACT)) ACT[id] = Object.fromEntries(Object.entries(ACT[id]).map(([w, v]) => [String(w), v]));
const ROSTERS = [["aQ", "aR1", "aR2", "aW"], ["bQ", "bR", "bW1", "bW2"]];
const UNDRAFTED = ["uQ", "uR", "uW"];
// The hand trade: A sends aR2 (RB) to B for bW1 (WR). 1-for-1, no overflow.
const TRADE = { a: 0, b: 1, package: "1-1", give_a: ["aR2"], give_b: ["bW1"], drop_a: [], drop_b: [] };

/* (a) realized of the hand trade.
   Rule: each week, lineup by frozen p50 among roster players who have an actual
   entry AND a forecast play row that week; an unfilled slot takes the undrafted
   player with the best frozen p50 who has an actual entry; score = actual points.

   A before {aQ,aR1,aR2,aW}:
     w5 QB aQ 18 + RB aR1 10 + FLEX aW (p50 10 > aR2 8) 12 = 40
     w6 25 + 20 + aW 3 = 48
     w7 22 + 12 + aW 8 = 42                                  total 130
   A after {aQ,aR1,aW,bW1}:
     w5 18 + 10 + FLEX bW1 (14 > 10) 16 = 44
     w6 25 + 20 + bW1 6 = 51
     w7 22 + 12 + bW1 21 = 55                                total 150  => ΔA = +20
   B before {bQ,bR,bW1,bW2}:
     w5 QB bQ 20 + RB bR 7 + FLEX bW1 (14 > 6) 16 = 43
     w6 QB: bQ has no actual -> undrafted uQ 12; RB bR 15; FLEX bW1 6 (bW2 bye) = 33
     w7 QB bQ 16; RB: bR has an actual (11) but no forecast row -> cannot start;
        no other RB -> undrafted uR 5; FLEX bW1 21 = 42       total 118
   B after {bQ,bR,bW2,aR2}:
     w5 bQ 20 + RB bR (12 > 8) 7 + FLEX aR2 (8 > 6) 5 = 32
     w6 QB uQ 12 + RB bR 15 + FLEX aR2 9 (bW2 bye) = 36
     w7 bQ 16 + RB aR2 14 (bR no forecast) + FLEX bW2 4 = 34 total 102  => ΔB = -16 */
check("a_realized_hand_trade", () => {
  const r = T.realized(ROSTERS, TRADE, FC, ACT, UNDRAFTED, WEEKS, SLOTS);
  close(r.a.before, 130, "A before"); close(r.a.after, 150, "A after"); close(r.a.delta, 20, "ΔA");
  close(r.b.before, 118, "B before"); close(r.b.after, 102, "B after"); close(r.b.delta, -16, "ΔB");
});

/* (b) a player missing actual_weeks in week 2 (week 6) is benched and the
   replacement rule fires, picking the best-p50 undrafted player who PLAYED.
   Roster {bQ, bR} alone:
     w5 QB bQ 20; RB bR 7; FLEX: nobody left -> undrafted by p50: uW (9) over uR (7) -> 10     = 37
     w6 QB: bQ no actual -> uQ 12; RB bR 15; FLEX: uW (p50 9) has no actual -> uR (7) 8       = 35
     w7 QB bQ 16; RB: bR no forecast -> uR 5; FLEX uW 7                                       = 28
   total 100. bQ (p50 18) never starts in week 6 even though he out-projects uQ (11). */
check("b_benched_and_replacement", () => {
  const r = T.realizedRoster(["bQ", "bR"], FC, ACT, UNDRAFTED, WEEKS, SLOTS);
  assert.deepEqual(r.perWeek, [37, 35, 28]);
  close(r.total, 100, "total");
  // B before, week 6, from (a): QB filled by uQ at 12, not bQ.
  assert.deepEqual(T.realizedRoster(ROSTERS[1], FC, ACT, UNDRAFTED, WEEKS, SLOTS).perWeek, [43, 33, 42]);
});

/* (c) predictLineupOnly, everyone playing, p50 lineup totals.
   A before: each week QB aQ 20 + RB aR1 15 + FLEX max(aR2 8, aW 10) 10 = 45  -> 135
   A after : each week 20 + 15 + FLEX max(aW 10, bW1 14) 14 = 49            -> 147
   {bQ,bW2,aR2}: w5 QB bQ 18 + RB aR2 8 + FLEX bW2 6 = 32
                 w6 18 + 8 + FLEX: bW2 on bye -> replacement by p50 among undrafted
                    with a play row: uW 9 (a play ROW, whatever he later did) = 35
                 w7 32                                                        -> 99
   Starts (for depth_for_starter): aR2 starts 0 of 3 weeks in A-before; bW2 2 of 3. */
check("c_predict_lineup_only", () => {
  const projOf = (id, w) => { const r = FC.players[id].weeks[w]; return r && r.status === "play" ? r.p50 : null; };
  const replacementOf = w => UNDRAFTED.filter(id => projOf(id, w) !== null)
    .map(id => ({ id, position: FC.players[id].position, score: projOf(id, w) }));
  const out = T.predictLineupOnly([ROSTERS[0], ["aQ", "aR1", "aW", "bW1"], ["bQ", "bW2", "aR2"]],
                                  projOf, WEEKS, SLOTS, replacementOf, id => FC.players[id].position);
  assert.deepEqual(out.map(o => o.total), [135, 147, 99]);
  assert.deepEqual(out[2].perWeek, [32, 35, 32]);
  assert.equal(out[0].starts.aR2 || 0, 0);
  assert.equal(out[2].starts.bW2, 2);
});

/* (d) metrics on 4 hand rows.
        real  sim  cur  naive  p10  p90  strata                   pos
   r1    10    8    4    -2    -5   20   same_position, lopsided  QB
   r2    -6   -3    2     5   -10    0   same_position            QB
   r3     4   -1    6     1    -8    3   cross_position           WR
   r4    -2    1   -4    -1    -1    5   cross_position           RB
   MAE  sim   (2+3+5+3)/4  = 3.25   cur (6+8+2+2)/4 = 4.5   naive (12+11+3+1)/4 = 6.75
   sign ((pred>0) === (real>0)):  sim T T F F = 0.5   cur T F T T = 0.75   naive F F T T = 0.5
   regret = max(real,0) - (pred>0 ? real : 0):
        sim   0 + 0 + 4 + 2 = 6 -> 1.5     cur 0 + 6 + 0 + 0 = 6 -> 1.5     naive 10 + 6 + 0 + 0 -> 4
   coverage (real in [p10,p90]): r1 yes, r2 yes (edge p90 = 0 counts), r3 no, r4 no -> 0.5
   same_position: sim MAE (2+3)/2 = 2.5, cur (6+8)/2 = 7; QB = the same two rows.
   bootstrap with ONE cluster: every resample is the full set, so each interval
   collapses to the point estimate: MAE sim-cur = 3.25-4.5 = -1.25, sim-naive = -3.5,
   regret sim-cur = 0, sim-naive = -2.5; same_position sim-cur = -4.5. */
const ROWS = [
  { cluster: "2023:5:0", real: 10, sim: 8, current: 4, naive: -2, sim_p10: -5, sim_p90: 20, strata: ["same_position", "lopsided"], position: "QB" },
  { cluster: "2023:5:0", real: -6, sim: -3, current: 2, naive: 5, sim_p10: -10, sim_p90: 0, strata: ["same_position"], position: "QB" },
  { cluster: "2023:5:0", real: 4, sim: -1, current: 6, naive: 1, sim_p10: -8, sim_p90: 3, strata: ["cross_position"], position: "WR" },
  { cluster: "2023:5:0", real: -2, sim: 1, current: -4, naive: -1, sim_p10: -1, sim_p90: 5, strata: ["cross_position"], position: "RB" },
];
check("d_metrics", () => {
  const m = T.metrics(ROWS);
  assert.equal(m.pooled.n, 4);
  close(m.pooled.mae.sim, 3.25, "mae sim"); close(m.pooled.mae.current, 4.5, "mae cur"); close(m.pooled.mae.naive, 6.75, "mae naive");
  close(m.pooled.sign_accuracy.sim, 0.5, "sign sim"); close(m.pooled.sign_accuracy.current, 0.75, "sign cur"); close(m.pooled.sign_accuracy.naive, 0.5, "sign naive");
  close(m.pooled.regret.sim, 1.5, "regret sim"); close(m.pooled.regret.current, 1.5, "regret cur"); close(m.pooled.regret.naive, 4, "regret naive");
  close(m.pooled.coverage, 0.5, "coverage");
  close(m.by_stratum.same_position.mae.sim, 2.5, "same_position sim"); close(m.by_stratum.same_position.mae.current, 7, "same_position cur");
  assert.equal(m.by_stratum.lopsided.n, 1); assert.equal(m.by_stratum.depth_for_starter.n, 0);
  close(m.by_position.QB.mae.sim, 2.5, "QB sim"); assert.equal(m.by_position.WR.n, 1);
  const b = T.bootstrap(ROWS, 50, T.mulberry32(9));
  for (const [iv, v] of [[b.mae_diff.current, -1.25], [b.mae_diff.naive, -3.5], [b.regret_diff.current, 0],
                         [b.regret_diff.naive, -2.5], [b.strata_mae_diff_current.same_position, -4.5]]) {
    close(iv[0], v, "one-cluster lo"); close(iv[1], v, "one-cluster hi");
  }
});

/* (e) verdict: every error metric favours sim, but 80% coverage is 0.95 -> "fail".
   The same summary at 0.80 passes, so the fail is the coverage rule and nothing
   else; each other rule also fails on its own. */
check("e_verdict", () => {
  const good = () => ({ coverage: 0.95, bootstrap: {
    mae_diff: { current: [-2, -0.5], naive: [-4, -1] }, regret_diff: { current: [-1, -0.1], naive: [-3, -0.2] },
    strata_mae_diff_current: { same_position: [-1, -0.2], cross_position: [-3, -1], depth_for_starter: [-0.5, 0.4], lopsided: [-6, -2] } } });
  assert.equal(T.verdict(good()), "fail");
  const s = good(); s.coverage = 0.80; assert.equal(T.verdict(s), "pass");
  for (const cov of [0.70, 0.90]) { const x = good(); x.coverage = cov; assert.equal(T.verdict(x), "pass", `coverage ${cov} is inside`); }
  for (const cov of [0.699, 0.901]) { const x = good(); x.coverage = cov; assert.equal(T.verdict(x), "fail", `coverage ${cov} is outside`); }
  const touch = good(); touch.coverage = 0.8; touch.bootstrap.mae_diff.naive = [-3, 0]; assert.equal(T.verdict(touch), "fail", "interval touching 0 is not entirely below");
  const reg = good(); reg.coverage = 0.8; reg.bootstrap.regret_diff.current = [-1, 0.2]; assert.equal(T.verdict(reg), "fail");
  const str = good(); str.coverage = 0.8; str.bootstrap.strata_mae_diff_current.cross_position = [0.1, 2]; assert.equal(T.verdict(str), "fail", "a stratum worse than current");
  const miss = good(); miss.coverage = 0.8; delete miss.bootstrap.strata_mae_diff_current.lopsided; assert.equal(T.verdict(miss), "fail", "no evidence is not a pass");
  // Waiver: pass iff the (sim - current) mean-regret interval is entirely below 0.
  assert.equal(T.waiverVerdict({ regret_diff_current: [-2, -0.1] }), "pass");
  assert.equal(T.waiverVerdict({ regret_diff_current: [-2, 0] }), "fail");
  assert.equal(T.waiverVerdict({ regret_diff_current: null }), "fail");
});

/* (f) sampleTrades: same seed -> identical list; never includes a player lacking a
   play/bye row in every week (bR has no week-7 row); no duplicates; overflow drops
   the receiving side's lowest mean-p50 players NOT involved in the trade.
   Mean p50 over play rows: aQ 20, aR1 15, aR2 8, aW 10, bQ 18, bR 12, bW1 14, bW2 6.
   Distinct trades available: 1-1 4*3 + 2-1 6*3 + 1-2 4*3 + 2-2 6*3 = 60. */
check("f_sample_trades", () => {
  const one = T.sampleTrades(ROSTERS, FC, T.mulberry32(T.hashStr("2023:5:0")), 30);
  const two = T.sampleTrades(ROSTERS, FC, T.mulberry32(T.hashStr("2023:5:0")), 30);
  assert.deepEqual(one, two);
  assert.equal(one.length, 30);
  assert.notDeepEqual(T.sampleTrades(ROSTERS, FC, T.mulberry32(T.hashStr("2023:5:1")), 30), one);
  const MEAN = { aQ: 20, aR1: 15, aR2: 8, aW: 10, bQ: 18, bR: 12, bW1: 14, bW2: 6 };
  const keys = new Set(), kinds = new Set();
  for (const t of one) {
    const moved = t.give_a.concat(t.give_b);
    assert.ok(!moved.includes("bR"), "bR lacks a week-7 forecast row and must never be traded");
    for (const id of t.give_a) assert.ok(ROSTERS[t.a].includes(id));
    for (const id of t.give_b) assert.ok(ROSTERS[t.b].includes(id));
    assert.equal(`${t.give_a.length}-${t.give_b.length}`, t.package);
    kinds.add(t.package);
    const key = JSON.stringify([t.a, t.give_a.slice().sort(), t.b, t.give_b.slice().sort()]);
    assert.ok(!keys.has(key), "duplicate trade"); keys.add(key);
    for (const [side, roster, give, get, drop] of [["a", ROSTERS[t.a], t.give_a, t.give_b, t.drop_a], ["b", ROSTERS[t.b], t.give_b, t.give_a, t.drop_b]]) {
      const gain = Math.max(0, get.length - give.length);
      const expected = roster.filter(id => !give.includes(id)).sort((x, y) => MEAN[x] - MEAN[y] || (x < y ? -1 : 1)).slice(0, gain);
      assert.deepEqual(drop, expected, `side ${side} overflow drop`);
    }
  }
  assert.equal(kinds.size, 4, "all four package types occur");
  assert.equal(T.meanP50("bR", FC), 12);
});

/* (g) the sim side of the pipeline wires up on the mini season: the replacement
   pool is sized from the slots (QB 1, RB 1 + FLEX 1, WR FLEX 1, TE FLEX 1), the
   world builds, identical rosters give Δ exactly 0, and a cell run over the hand
   trade reproduces (a)'s realized deltas with finite predictions for every method. */
check("g_cell_pipeline", () => {
  const pool = T.replacementPool(UNDRAFTED, FC, WEEKS, SLOTS, (id, w) => { const r = FC.players[id].weeks[w]; return r && r.status === "play" ? r.p50 : null; });
  assert.deepEqual(pool[6], { QB: ["uQ"], RB: ["uR"], WR: ["uW"], TE: [] });
  const A = { p_out: { QB: 0.05, RB: 0.08, WR: 0.06, TE: 0.06 }, p_stay: { QB: 0.6, RB: 0.65, WR: 0.6, TE: 0.6 },
              p_tag: { Out: 0.7, Doubtful: 0.5, Questionable: 0.15, IR: 0.9 } };
  const cell = T.runCell({ season: 2023, origin: 5, k: 0, rosters: ROSTERS, undrafted: UNDRAFTED, forecasts: FC,
    actualWeeks: ACT, availability: A, tags: { bQ: "Questionable" }, slots: SLOTS, nSims: 300, simSeed: 11,
    trades: [Object.assign({ id: "t0" }, TRADE)], waiver: false });
  assert.equal(cell.excluded, null);
  assert.equal(cell.rows.length, 2);
  const [ra, rb] = cell.rows;
  close(ra.real, 20, "row a real"); close(rb.real, -16, "row b real");
  // current for side A = 147 - 135 = +12 from (c); bR is excluded from B's
  // prediction roster (no week-7 row), so B's current is computed without him.
  close(ra.current, 12, "row a current");
  for (const r of cell.rows) for (const k of ["sim", "sim_p10", "sim_p90", "current", "naive"]) assert.ok(Number.isFinite(r[k]), k);
  assert.equal(ra.position, "WR"); assert.equal(rb.position, "RB");
  assert.ok(ra.strata.includes("cross_position") && !ra.strata.includes("same_position"));
  assert.equal(cell.uncovered_rostered, 1, "bR counted as a coverage gap");
});

/* (h) output guards: rounding happens at output only, and a non-finite metric throws. */
check("h_output_guards", () => {
  assert.deepEqual(T.roundDeep({ a: 1.23456, b: [2.0004, { c: -0.0006 }], s: "x", n: null }), { a: 1.235, b: [2, { c: -0.001 }], s: "x", n: null });
  assert.throws(() => T.roundDeep({ a: [1, NaN] }), /non-finite/);
  assert.throws(() => T.roundDeep({ a: Infinity }), /non-finite/);
  close(T.percentile([1, 2, 3, 4, 5], 0.9), 4.6, "type-7 percentile");
});

console.log(`trade_backtest_fixture: ${n} groups OK`);
