// tests/trade_backtest_fixture.cjs — run: node tests/trade_backtest_fixture.cjs
//
// Pins the walk-forward trade backtest (tools/trade_backtest.cjs) on a hand-built
// mini season whose answers are worked out below by hand. The backtest's verdict
// file decides whether a trade grade ever reaches the public site, so its own
// arithmetic is the thing that must not be silently wrong.
const assert = require("node:assert/strict");
const T = require("../tools/trade_backtest.cjs");

let n = 0; const failed = [];
// FIXTURE_ALL=1 reports every failing group instead of stopping at the first (used to show new cases fail on old code).
const check = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; if (process.env.FIXTURE_ALL) { failed.push(e.message.split("\n")[0]); return; } throw e; } };
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
// FC2: the mini season with bR's week-7 row filled in (every rostered player fully covered),
// plus a second undrafted QB and RB so a waiver pool survives excluding the add set.
const FC2 = JSON.parse(JSON.stringify(FC));
FC2.players.bR.weeks[7] = play(12);
FC2.players.uQ2 = { position: "QB", baseline: 5, weeks: every(5) };
FC2.players.uR2 = { position: "RB", baseline: 4, weeks: every(4) };
const ACT = {
  uQ2: { 5: 4, 6: 5, 7: 6 }, uR2: { 5: 3, 6: 4, 7: 5 },
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
  const good = () => ({ coverage: 0.95, excluded_cells: 0, bootstrap: {
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
  assert.equal(T.waiverVerdict({ regret_diff_current: [-2, -0.1] }, 0), "pass");
  assert.equal(T.waiverVerdict({ regret_diff_current: [-2, 0] }, 0), "fail");
  assert.equal(T.waiverVerdict({ regret_diff_current: null }, 0), "fail");
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
  // Review M1: bR has no week-7 row, so a rostered player lacks full coverage: the cell is
  // excluded and recorded, never silently thinned.
  assert.match(String(cell.excluded), /lack full forecast coverage/);
  assert.equal(cell.rows.length, 0);
  assert.equal(cell.uncovered_rostered, 1, "bR counted as a coverage gap");
  // With bR's week-7 row filled in the same cell runs.
  const ok = T.runCell({ season: 2023, origin: 5, k: 0, rosters: ROSTERS, undrafted: UNDRAFTED, forecasts: FC2,
    actualWeeks: ACT, availability: A, tags: { bQ: "Questionable" }, slots: SLOTS, nSims: 300, simSeed: 11,
    trades: [Object.assign({ id: "t0" }, TRADE)], waiver: false });
  assert.equal(ok.excluded, null);
  assert.equal(ok.rows.length, 2);
  const [ra, rb] = ok.rows;
  assert.equal(ra.origin, 5);
  for (const r of ok.rows) for (const k of ["real", "sim", "sim_p10", "sim_p90", "current", "naive", "sim_noavail", "sim_noavail_p10", "sim_noavail_p90"]) assert.ok(Number.isFinite(r[k]), k);
  assert.equal(ra.position, "WR"); assert.equal(rb.position, "RB");
  assert.ok(ra.strata.includes("cross_position") && !ra.strata.includes("same_position"));
  close(ra.current, 12, "row a current");   // 147 - 135 from (c)
});

/* (h) output guards: rounding happens at output only, and a non-finite metric throws. */
check("h_output_guards", () => {
  assert.deepEqual(T.roundDeep({ a: 1.23456, b: [2.0004, { c: -0.0006 }], s: "x", n: null }), { a: 1.235, b: [2, { c: -0.001 }], s: "x", n: null });
  assert.throws(() => T.roundDeep({ a: [1, NaN] }), /non-finite/);
  assert.throws(() => T.roundDeep({ a: Infinity }), /non-finite/);
  close(T.percentile([1, 2, 3, 4, 5], 0.9), 4.6, "type-7 percentile");
});

/* ---- Fix round 1 (spec §10 amendments and review items) ------------------------------ */
const AV = () => ({ p_out: { QB: 0.05, RB: 0.08, WR: 0.06, TE: 0.06 }, p_stay: { QB: 0.6, RB: 0.65, WR: 0.6, TE: 0.6 },
                    p_tag: { Out: 0.7, Doubtful: 0.5, Questionable: 0.15, IR: 0.9 } });

/* (i) sign accuracy excludes real === 0 rows (review M6). Extra row real 0, sim 1, cur -1, naive 0:
   sim was counted wrong before (1 > 0 but 0 > 0 is false) -> 2/5 = 0.4; excluded: sim T T F F = 2/4 = 0.5,
   cur 3/4 = 0.75 (unchanged), naive 2/4 = 0.5. MAE etc. still use all 5 rows (n = 5). */
check("i_sign_excludes_zero_real", () => {
  const m = T.metrics(ROWS.concat([{ cluster: "2023:5:0", real: 0, sim: 1, current: -1, naive: 0, sim_p10: -1, sim_p90: 1, strata: ["cross_position"], position: "WR" }]));
  assert.equal(m.pooled.n, 5);
  close(m.pooled.sign_accuracy.sim, 0.5, "sign sim"); close(m.pooled.sign_accuracy.current, 0.75, "sign cur"); close(m.pooled.sign_accuracy.naive, 0.5, "sign naive");
});

/* (j) §10.1 waiver set: per-position quota QB 2 / RB 3 / WR 3 / TE 2 by mean frozen p50.
   6 QBs (p50 30..25, all above every other position), 4 RB, 4 WR, 1 TE. Expected: QB q0,q1;
   RB r0,r1,r2 (r3 out); WR w0,w1,w2; TE t0 only (fewer than the quota exist, so all of them). */
check("j_waiver_quota", () => {
  const players = {}, ids = [];
  const add = (pos, n, top) => { for (let i = 0; i < n; i++) { const id = pos.toLowerCase() + i; ids.push(id); players[id] = { position: pos, baseline: 1, weeks: every(top - i) }; } };
  add("QB", 6, 30); add("RB", 4, 20); add("WR", 4, 18); add("TE", 1, 10);
  const set = T.waiverAdds(ids, { weeks: WEEKS, players }, WEEKS);
  assert.deepEqual(set.slice().sort(), ["qb0", "qb1", "rb0", "rb1", "rb2", "te0", "wr0", "wr1", "wr2"]);
  assert.ok(set.filter(i => i.startsWith("qb")).length === 2, "not all QBs");
  // A player without a play/bye row for every week cannot be an add (unknown is not zero).
  players.qb0.weeks = { 5: play(30) };
  assert.ok(!T.waiverAdds(ids, { weeks: WEEKS, players }, WEEKS).includes("qb0"));
});

/* (k) §10.1 / review I1 (controller decision): the waiver replacement pool excludes the WHOLE add
   set in every arm (sim, current, naive, realized), matching the live desk. Quota QB 1 / RB 1: adds
   are uQ (bye in week 6) and uR. The pool the waiver decisions see must not contain uQ or uR (no
   "replaced by his own copy"), but does contain uQ2 / uR2 / uW. */
check("k_waiver_pool_excludes_adds", () => {
  const FC3 = JSON.parse(JSON.stringify(FC2));
  FC3.players.uQ.weeks[6] = { status: "bye" };
  const cell = T.runCell({ season: 2023, origin: 5, k: 0, rosters: ROSTERS, undrafted: ["uQ", "uR", "uW", "uQ2", "uR2"], forecasts: FC3,
    actualWeeks: ACT, availability: AV(), tags: {}, slots: SLOTS, nSims: 200, simSeed: 3, trades: [Object.assign({ id: "t0" }, TRADE)],
    waiver: true, waiverQuota: { QB: 1, RB: 1, WR: 0, TE: 0 } });
  assert.equal(cell.excluded, null);
  assert.deepEqual(cell.waiver_adds.slice().sort(), ["uQ", "uR"]);
  for (const id of ["uQ", "uR"]) assert.ok(!cell.waiver_pool.includes(id), `${id} must not be in the waiver replacement pool`);
  for (const id of ["uQ2", "uR2", "uW"]) assert.ok(cell.waiver_pool.includes(id), `${id} is a legal replacement`);
  assert.equal(cell.waiver_rows.length, 4);   // 2 teams x 2 adds
  assert.equal(cell.rows.length, 2);          // the trade arm is unaffected
});

/* (l) §10.2 trade population. Slots QB/RB/FLEX, frozen p50 before-lineups (FC2):
   A: aQ, aR1, FLEX aW (10 > aR2 8) start all 3 weeks; aR2 starts 0.
   B: bQ, bR (12), FLEX bW1 (14) start all 3 weeks; bW2 starts 0 (p50 6, bye wk 6).
   A trade is kept only if each side gives >= 1 player who starts in >= half the weeks (2 of 3):
   never {aR2} for {bW2} alone; each side's give must contain a starter. */
check("l_trade_population", () => {
  const out = T.sampleTrades(ROSTERS, FC2, T.mulberry32(T.hashStr("2023:5:0")), 25, { slots: SLOTS });
  assert.equal(out.length, 25);
  const START = [new Set(["aQ", "aR1", "aW"]), new Set(["bQ", "bR", "bW1"])];   // indexed by roster
  for (const t of out) {
    assert.ok(t.give_a.some(id => START[t.a].has(id)), `side a gives only bench: ${t.give_a}`);
    assert.ok(t.give_b.some(id => START[t.b].has(id)), `side b gives only bench: ${t.give_b}`);
  }
  assert.ok(out.stats.attempts > out.stats.accepted, "some draws were rejected");
  assert.equal(out.stats.accepted, 25);
  assert.deepEqual(out, T.sampleTrades(ROSTERS, FC2, T.mulberry32(T.hashStr("2023:5:0")), 25, { slots: SLOTS }));
  assert.deepEqual([...T.frozenStarters(ROSTERS[0], FC2, SLOTS)].sort(), ["aQ", "aR1", "aW"]);
  assert.deepEqual([...T.frozenStarters(ROSTERS[1], FC2, SLOTS)].sort(), ["bQ", "bR", "bW1"]);
});

/* (m) §10.2 depth_for_starter (per side): the side gives >= 1 before-lineup starter (starts
   >= half of W = 3 weeks, i.e. >= 2) AND receives no player starting >= half of the after-lineup weeks. */
check("m_depth_for_starter", () => {
  const W = 3;
  const base = { beforeStarts: { g1: 3, g2: 0 }, afterStarts: { r1: 1, r2: 0 }, give: ["g1"], receive: ["r1", "r2"], W };
  assert.equal(T.depthForStarter(base), true, "gives a starter, receives only bench (1 of 3 < half)");
  assert.equal(T.depthForStarter(Object.assign({}, base, { afterStarts: { r1: 2, r2: 0 } })), false, "r1 starts 2 of 3 = half or more");
  assert.equal(T.depthForStarter(Object.assign({}, base, { give: ["g2"] })), false, "gives only a bench player");
  assert.equal(T.depthForStarter(Object.assign({}, base, { beforeStarts: { g1: 1 } })), false, "1 of 3 is not a starter");
});

/* (n) §10.3 lopsided cutoff per origin. Origin 5: ten trades with max|current| 1..10 -> type-7 90th
   percentile 9.1 -> only the 10 is lopsided. Origin 9: measures 101..110 -> 109.1 -> only 110.
   Pooled, origin 5 would have none flagged (cutoff ~ 105). Then E per stratum and the schema-2 slim file. */
check("n_horizons_and_slim_schema", () => {
  const rows = [];
  for (const [origin, base] of [[5, 0], [9, 100]]) {
    for (let i = 1; i <= 10; i++) for (const side of ["a", "b"]) {
      rows.push({ cluster: `2023:${origin}:0`, trade_id: `t${origin}_${i}`, origin, side, position: "RB", strata: ["same_position"],
                  real: side === "a" ? 1 : -1, sim: 0, current: (side === "a" ? 1 : -1) * (base + i), naive: 0, sim_p10: -5, sim_p90: 5 });
    }
  }
  const cut = T.markLopsided(rows);
  close(cut[5], 9.1, "origin 5 cutoff"); close(cut[9], 109.1, "origin 9 cutoff");
  assert.equal(rows.filter(r => r.strata.includes("lopsided")).length, 4);   // 2 trades x 2 sides
  assert.ok(rows.filter(r => r.origin === 5 && r.strata.includes("lopsided")).every(r => r.trade_id === "t5_10"));
  const hz = T.horizonsOf(rows, cut);
  assert.deepEqual(hz.map(h => [h.origin, h.weeks]), [[5, 13], [9, 9]]);
  // E = the simulation's MAE in the stratum: |0 - real| = 1 for every row.
  close(hz[0].strata.same_position.E, 1, "E"); assert.equal(hz[0].strata.same_position.n, 20);
  assert.equal(hz[0].strata.lopsided.n, 2); close(hz[0].lopsided_cutoff, 9.1, "cutoff in horizon");
  const league = { league: "gabagool", slots: SLOTS, verdict: "pass", waiver_verdict: "pass", horizons: hz, excluded_cells: 0 };
  const sec = { league: "fam", slots: SLOTS, verdict: "fail", waiver_verdict: "not_evaluated", horizons: hz, excluded_cells: 2 };
  const slim = T.buildSlim(league, sec, { seasons: [2023], origins: [5, 9] }, "2026-09-28T00:00:00Z");
  assert.deepEqual(Object.keys(slim), ["schema_version", "league", "slots", "verdict", "waiver_verdict", "k", "horizons", "seasons", "origins", "excluded_cells", "generated_at", "secondary"]);
  assert.equal(slim.schema_version, 2); assert.equal(slim.k, 2);
  assert.deepEqual(Object.keys(slim.horizons[0]), ["origin", "weeks", "strata", "lopsided_cutoff"]);
  assert.deepEqual(Object.keys(slim.secondary), ["league", "slots", "verdict", "waiver_verdict", "horizons", "excluded_cells"]);
  assert.equal(slim.secondary.excluded_cells, 2);
});

/* (o) §10.4 fail closed: any excluded primary cell forces both verdicts to "fail", even when every
   interval and the coverage would pass. */
check("o_excluded_cells_fail_closed", () => {
  const s = { coverage: 0.8, excluded_cells: 0, bootstrap: {
    mae_diff: { current: [-2, -0.5], naive: [-4, -1] }, regret_diff: { current: [-1, -0.1], naive: [-3, -0.2] },
    strata_mae_diff_current: { same_position: [-1, -0.2], cross_position: [-3, -1], depth_for_starter: [-0.5, 0.4], lopsided: [-6, -2] } } };
  assert.equal(T.verdict(s), "pass");
  assert.equal(T.verdict(Object.assign({}, s, { excluded_cells: 1 })), "fail");
  assert.equal(T.waiverVerdict({ regret_diff_current: [-2, -0.1] }, 0), "pass");
  assert.equal(T.waiverVerdict({ regret_diff_current: [-2, -0.1] }, 3), "fail");
});

/* (p) review M3: walk-forward input guards. */
check("p_input_guards", () => {
  const av = { test_season: 2024, seasons: [2012, 2023], tags: { 4: { x: "Out" } } };
  assert.doesNotThrow(() => T.checkAvailability(av, 2024, 5));
  assert.throws(() => T.checkAvailability(av, 2024, 9), /tags/, "no tags[8]");
  assert.throws(() => T.checkAvailability(Object.assign({}, av, { seasons: [2012, 2024] }), 2024, 5), /walk-forward|seasons/);
  const fc = { schema_version: 1, season: 2024, origin: 5, weeks: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], players: {}, training_through: 2023 };
  assert.doesNotThrow(() => T.checkForecastFile(fc, 2024, 5, "f"));
  assert.throws(() => T.checkForecastFile(Object.assign({}, fc, { training_through: 2024 }), 2024, 5, "f"), /training_through/);
  assert.throws(() => T.checkForecastFile(Object.assign({}, fc, { training_through: undefined }), 2024, 5, "f"), /training_through/);
});

/* (q) review M4: the site-output gate refusal is case-insensitive on win32. */
check("q_inside_dir", () => {
  assert.equal(T.isInside("/repo/site", "/repo/site/data/x.json"), true);
  assert.equal(T.isInside("/repo/site", "/repo/other/x.json"), false);
  assert.equal(T.isInside("/repo/site", "/repo/site2/x.json"), false);
  if (process.platform === "win32") assert.equal(T.isInside("C:\\repo\\site", "c:\\REPO\\Site\\data\\x.json"), true);
});

/* (r) diagnostic: the availability-off arm is the same engine with p_out = p_stay = p_tag = 0. */
check("r_availability_off", () => {
  const off = T.availabilityOff(AV());
  for (const pos of ["QB", "RB", "WR", "TE"]) { assert.equal(off.p_out[pos], 0); assert.equal(off.p_stay[pos], 0); }
  for (const t of ["Out", "Doubtful", "Questionable", "IR"]) assert.equal(off.p_tag[t], 0);
});

/* (s) controller decision: the waiver set ranks by the mean over ALL weeks origin..17 of frozen p50,
   a bye week counting as 0 (matches the live desk); ties by id ascending. Two QBs, both p50 10 in
   their play weeks; "a_bye" has a bye in week 6: mean (10 + 0 + 10)/3 = 6.67 vs "b_full" 10.
   Play-weeks-only averaging ties them (both 10) and id order would pick a_bye; bye-as-0 picks b_full.
   Also an incomplete row skips that player and takes the next. */
check("s_waiver_rank_bye_is_zero", () => {
  const players = {
    a_bye: { position: "QB", baseline: 1, weeks: { 5: play(10), 6: { status: "bye" }, 7: play(10) } },
    b_full: { position: "QB", baseline: 1, weeks: every(10) },
    c_gap: { position: "QB", baseline: 1, weeks: { 5: play(40), 6: play(40) } },
  };
  const fc = { weeks: WEEKS, players };
  assert.deepEqual(T.waiverAdds(["a_bye", "b_full", "c_gap"], fc, WEEKS, { QB: 1, RB: 0, WR: 0, TE: 0 }), ["b_full"]);
  assert.deepEqual(T.waiverAdds(["a_bye", "b_full", "c_gap"], fc, WEEKS, { QB: 2, RB: 0, WR: 0, TE: 0 }), ["b_full", "a_bye"], "c_gap skipped, next taken");
  players.a_bye2 = { position: "QB", baseline: 1, weeks: every(10) };   // exact tie with b_full: id ascending
  assert.deepEqual(T.waiverAdds(["b_full", "a_bye2"], fc, WEEKS, { QB: 1, RB: 0, WR: 0, TE: 0 }), ["a_bye2"]);
  close(T.meanP50ByeZero("a_bye", fc, WEEKS), 20 / 3, "bye counts as 0");
});

if (failed.length) { console.log(`FAILED (${failed.length}):\n  ` + failed.join("\n  ")); process.exit(1); }
console.log(`trade_backtest_fixture: ${n} groups OK`);
