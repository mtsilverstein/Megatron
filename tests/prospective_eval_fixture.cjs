// tests/prospective_eval_fixture.cjs — run: node tests/prospective_eval_fixture.cjs
//
// Pins tools/prospective_eval.cjs, the evaluator of the prospective 2026 test (spec 2026-09-30 §6).
// Its code is frozen before any 2026 outcome exists and runs after the season, so the verdict logic
// must be exactly the predeclared rules. Two layers:
//
//  1. The verdict layer (pure): synthetic per-side rows built here, with known coverage / MAE / regret
//     structure, go through evaluateFormat. (a) ~80% coverage -> conditional_pass; (b) too-narrow v2
//     intervals -> conditional_fail citing the coverage rule; (d) a stratum < 200 sides -> inconclusive;
//     (e) for each of the seven trade rules a variant violating ONLY that rule flips the status, and the
//     fixture asserts the failed-rule set is exactly {that rule}; (f) exploratory never passes;
//     (h) the waiver verdict is independent of the trade verdict.
//  2. The pipeline (CLI): a tiny synthetic freeze + outcomes written here, evaluated with the real
//     engine through trade_backtest.runCell: (c) a missing expected cell -> inconclusive; a rostered
//     player losing a forecast row -> the cell excluded -> inconclusive; (g) 3 shards merged ==
//     unsharded byte for byte, duplicate / missing shard cells -> error; --jobs 2 == --jobs 1;
//     sim_gates.json schema 3; M != 4 refused; a non-predeclared run cannot write under site/.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const TOOL = process.env.PE_MODULE || path.join(__dirname, "..", "tools", "prospective_eval.cjs");
const PE = require(TOOL);
const TB = require("../tools/trade_backtest.cjs");

let n = 0;
const failed = [];
const check = (name, fn) => {
  try { fn(); n++; }
  catch (e) { e.message = `${name}: ${e.message}`; if (process.env.FIXTURE_ALL) { failed.push(e.message.split("\n")[0]); return; } throw e; }
};

/* ===========================================================================
   Layer 1 — synthetic rows.
   Per origin (5, 9) x draft k (0..19) x trade t (0..29) x side (a, b): 60 sides per cell,
   1,200 per origin. Strata: t even -> same_position, odd -> cross_position; t % 3 == 0 ->
   depth_for_starter (400 sides / origin); t % 5 == 0 -> lopsided (240 sides / origin).
   Row types (j = 2t + side index):
     small ((7t + 3*side + k) % 5 == 1, 20%): y = +-6, v2 error +-8 (inside the +-10 interval), current the same;
                         naive's error has the opposite sign, so naive picks the wrong side (regret 6).
     normal:             y = +-(20..60); covered with prob 0.75 -> |v2 error| 5, else 15.
   v2 interval = mean +- 10 (coverage 0.2 + 0.8*0.75 = 0.80), rho0 interval = mean +- 4
   (interval score 44 vs v2's 30). current's |error| = v2's (tiny noise) - dCur; naive's = v2's + D.
   Every knob is a function so a variant changes exactly one thing.
   =========================================================================== */
function makeRows(o = {}) {
  const h = o.h || (() => 10);                       // v2 half-width
  const h0 = o.h0 || (() => 4);                      // rho0 half-width
  const dCur = o.dCur || (() => 0);                  // current |error| smaller than v2's by this
  const D = o.D || (() => 3);                        // naive |error| larger than v2's by this
  const v2Flip = o.v2Flip || (() => false);          // small row: v2 on the wrong side (current right)
  const naiveFlip = o.naiveFlip || (() => true);     // small row: naive on the wrong side
  const lopsided = o.lopsided || ((origin, k, t) => t % 5 === 0);
  const rand = TB.mulberry32(20260930);
  const rows = [];
  for (const origin of [5, 9]) for (let k = 0; k < 20; k++) {
    let smallIx = 0;
    for (let t = 0; t < 30; t++) {
      const strata = [t % 2 ? "cross_position" : "same_position"];
      if (t % 3 === 0) strata.push("depth_for_starter");
      if (lopsided(origin, k, t)) strata.push("lopsided");
      for (const side of ["a", "b"]) {
        const j = 2 * t + (side === "b" ? 1 : 0);
        const uS = rand(), uY = rand(), uC = rand(), uL = rand(), uN = rand();   // fixed draw order
        const s = uS < 0.5 ? -1 : 1;
        const ctx = { origin, k, t, j, side, strata };
        const small = (7 * t + (side === "b" ? 3 : 0) + k) % 5 === 1;     // 12 per cell, spread over every stratum
        let y, ev, ec, en;
        if (small) {
          const i = smallIx++;
          y = 6 * s;
          const vf = v2Flip(ctx, i);
          ev = (vf ? -8 : 8) * s;
          ec = 8 * s;
          const d = D(ctx);
          en = (naiveFlip(ctx, i) ? -1 : 1) * (8 + d) * s;
        } else {
          y = s * (20 + 40 * uY);
          const mag = uC < 0.75 ? 5 : 15;
          ev = (uL < 0.5 ? -1 : 1) * mag;
          const cm = mag * (1 + 0.02 * (uN - 0.5)) - dCur(ctx);
          ec = Math.sign(ev) * cm;
          en = Math.sign(ev) * (mag + D(ctx));
        }
        if (small && dCur(ctx)) ec = Math.sign(ec) * (8 - dCur(ctx));
        const m = y + ev, hv = h(ctx), h0v = h0(ctx);
        rows.push({ k, origin, trade_id: `${origin}:${k}:${t}`, side, strata: strata.slice(), position: "RB",
                    real: y, v2: m, v2_p10: m - hv, v2_p90: m + hv, rho0: m, rho0_p10: m - h0v, rho0_p90: m + h0v,
                    current: y + ec, naive: y + en,
                    give: [`g${t}${side}1`, `g${t}${side}2`], receive: [`r${t}${side}`],
                    give_teams: t % 7 === 0 ? ["KC", "KC"] : ["KC", "BUF"], receive_teams: ["DAL"] });
      }
    }
  }
  return rows;
}
// Waiver rows: 10 decisions per (origin, k); regret v2 1 / rho0 1 / current 2 / naive 3 (+ noise) by default.
function makeWaiver(o = {}) {
  const cur = o.cur || (() => 2), nai = o.nai || (() => 3);
  const rand = TB.mulberry32(7);
  const rows = [];
  for (const origin of [5, 9]) for (let k = 0; k < 20; k++) for (let i = 0; i < 10; i++) {
    const e = rand();
    rows.push({ k, origin, team: i % 4, add: `add${i}`, choice: { v2: "d", rho0: "d", current: "d", naive: "d" },
                regret: { v2: 1 + e, rho0: 1 + e, current: cur({ origin, k }) + e, naive: nai({ origin, k }) + e } });
  }
  return rows;
}
const KS = Array.from({ length: 20 }, (_, i) => i);
const R = PE.resampleIndices(KS.length);
const complete = () => ({ missing: [], excluded: [] });
function evalFmt(rows, o = {}) {
  return PE.evaluateFormat({ primary: o.primary !== undefined ? o.primary : true, contingency: !!o.contingency,
                             rows, waiverRows: o.waiverRows || makeWaiver(), cells: o.cells || complete(),
                             origins: [5, 9], ks: KS, R, M: 4 });
}
const failedRules = res => res.failed_rules.slice().sort((a, b) => a - b);
function expectOnly(name, rows, rule, status = "conditional_fail", extra = {}) {
  check(name, () => {
    const res = evalFmt(rows, extra).trade;
    assert.deepEqual(failedRules(res), [rule], `failed rules ${JSON.stringify(failedRules(res))}; checks failing: ${JSON.stringify(res.checks.filter(c => !c.pass).map(c => c.id))}`);
    assert.equal(res.status, status);
  });
}

check("rules block: the predeclared constants are exactly the spec's", () => {
  const Rl = PE.RULES;
  assert.equal(Rl.season, 2026);
  assert.deepEqual(Rl.origins, [5, 9]);
  assert.equal(Rl.drafts, 20);
  assert.equal(Rl.sims, 2000);
  assert.equal(Rl.bootstrap_B, 20000);
  assert.equal(Rl.bootstrap_seed, "prospective-2026");
  assert.equal(Rl.primary_M, 4);
  assert.deepEqual(Rl.coverage_band, [0.70, 0.90]);
  assert.equal(Rl.min_sides, 200);
  assert.equal(Rl.margin_current, 1.0);
  assert.equal(Rl.margin_naive, 0);
  assert.equal(Rl.interval_penalty, 10);
  assert.deepEqual(Rl.strata, ["same_position", "cross_position", "depth_for_starter", "lopsided"]);
  assert.equal(PE.alphaTrade(4), 0.05 / 16);
  assert.equal(PE.alphaWaiver(4), 0.05 / 8);
  assert.equal(PE.TRADE_RULES.length, 7);
});

check("resample indices: generated once from mulberry32(hashStr('prospective-2026')), B x C", () => {
  assert.equal(R.B, 20000); assert.equal(R.C, 20); assert.equal(R.idx.length, 20000 * 20);
  const rand = TB.mulberry32(TB.hashStr("prospective-2026"));
  for (let i = 0; i < 50; i++) assert.equal(R.idx[i], Math.floor(rand() * 20));
  assert.ok(R.idx.every(v => v >= 0 && v < 20));
});

check("interval score and interval metrics on a hand-worked block", () => {
  // y=0 in [-1,1] -> 2; y=5 above [0,2] -> 2 + 10*3 = 32; y=-3 below [-1,1] -> 2 + 10*2 = 22
  const mk = (real, lo, hi) => ({ k: 0, origin: 5, strata: ["same_position"], position: "RB", real, v2: 0, v2_p10: lo, v2_p90: hi,
                                  rho0: 0, rho0_p10: lo, rho0_p90: hi, current: 0, naive: 0 });
  const b = PE.tradeBlock([mk(0, -1, 1), mk(5, 0, 2), mk(-3, -1, 1)]);
  assert.equal(b.n, 3);
  assert.ok(Math.abs(b.interval_score.v2 - (2 + 32 + 22) / 3) < 1e-12);
  assert.ok(Math.abs(b.width.v2 - 2) < 1e-12);
  assert.ok(Math.abs(b.lower_miss.v2 - 1 / 3) < 1e-12);
  assert.ok(Math.abs(b.upper_miss.v2 - 1 / 3) < 1e-12);
  assert.ok(Math.abs(b.coverage.v2 - 1 / 3) < 1e-12);
  assert.ok(Math.abs(b.mae.v2 - (0 + 5 + 3) / 3) < 1e-12);
  // regret: pred 0 is "decline"; real 5 > 0 missed -> 5; real -3 declined -> 0
  assert.ok(Math.abs(b.regret.v2 - 5 / 3) < 1e-12);
});

check("equal-origin pooling: the pooled statistic is the mean of the two origins' statistics", () => {
  const rows = makeRows();
  const res = evalFmt(rows).trade;
  const m = res.metrics;
  for (const key of ["coverage", "interval_score", "mae", "regret"]) {
    assert.ok(Math.abs(m.pooled[key].v2 - (m.by_origin[5][key].v2 + m.by_origin[9][key].v2) / 2) < 1e-12, key);
  }
  // unequal origin sizes: drop half of origin 9 -> pooled still the plain mean of the two origin values
  const lop = rows.filter(r => r.origin === 5 || r.k < 10);
  const m2 = evalFmt(lop).trade.metrics;
  assert.ok(Math.abs(m2.pooled.mae.current - (m2.by_origin[5].mae.current + m2.by_origin[9].mae.current) / 2) < 1e-12);
});

check("bootstrap arithmetic: an identity resample reproduces the observed equal-origin differences", () => {
  const rows = makeRows({ dCur: c => (c.k % 3) * 0.4, v2Flip: c => c.k % 4 === 0 });
  const m = PE.tradeMetrics(rows, [5, 9]);
  const Rid = { B: 1, C: 20, seed: "identity", idx: Uint32Array.from(KS) };
  const b = PE.tradeBootstrap(rows, KS, [5, 9], Rid, 0.05);
  for (const key of ["mae_current", "regret_current", "mae_naive", "regret_naive"]) {
    assert.ok(Math.abs(b.upper[key] - m.differences.pooled[key]) < 1e-9, `${key}: ${b.upper[key]} vs ${m.differences.pooled[key]}`);
  }
  for (const s of PE.RULES.strata) {
    const ps = m.pooled_by_stratum[s];
    const want = ps.mae.v2 - ps.mae.current;
    assert.ok(Math.abs(b.stratum_interval[s][0] - want) < 1e-9 && Math.abs(b.stratum_interval[s][1] - want) < 1e-9, s);
  }
  const w = makeWaiver({ cur: c => 1.5 + c.k / 20 });
  const wm = PE.evaluateFormat({ primary: true, rows, waiverRows: w, cells: complete(), origins: [5, 9], ks: KS, R, M: 4 }).waiver.metrics;
  const wb = PE.waiverBootstrap(w, KS, [5, 9], Rid, 0.05);
  assert.ok(Math.abs(wb.upper.regret_current - wm.differences.pooled.regret_current) < 1e-9);
  assert.ok(Math.abs(wb.upper.regret_naive - wm.differences.pooled.regret_naive) < 1e-9);
});

// (a) the constructed world passes every rule.
const BASE = makeRows();
check("(a) ~80% coverage world -> conditional_pass", () => {
  const r = evalFmt(BASE);
  assert.deepEqual(r.trade.failed_rules, [], JSON.stringify(r.trade.checks.filter(c => !c.pass)));
  assert.equal(r.trade.status, "conditional_pass");
  const cov = r.trade.metrics.pooled.coverage.v2;
  assert.ok(cov > 0.76 && cov < 0.84, `coverage ${cov}`);
  assert.equal(r.waiver.status, "conditional_pass");
  // every rule contributed checks, and every origin x stratum cell was checked for count and coverage
  for (let rule = 1; rule <= 7; rule++) assert.ok(r.trade.checks.some(c => c.rule === rule), `rule ${rule} has checks`);
  for (const o of [5, 9]) for (const s of PE.RULES.strata) {
    assert.ok(r.trade.checks.some(c => c.rule === 1 && c.id === `sides:${o}:${s}`));
    assert.ok(r.trade.checks.some(c => c.rule === 2 && c.id === `coverage:${o}:${s}`));
  }
});

check("(b) v2 intervals deliberately too narrow -> conditional_fail citing the coverage rule", () => {
  const r = evalFmt(makeRows({ h: () => 4 })).trade;
  assert.equal(r.status, "conditional_fail");
  assert.ok(r.failed_rules.includes(2));
  assert.ok(r.checks.some(c => c.rule === 2 && !c.pass && /coverage/.test(c.text)));
});
check("(b') v2 intervals far too wide (coverage > 0.90) also fails rule 2", () => {
  const r = evalFmt(makeRows({ h: () => 20 })).trade;
  assert.equal(r.status, "conditional_fail");
  assert.ok(r.failed_rules.includes(2));
});

// (d) + rule 1 variants
expectOnly("(d) rule 1: origin-9 lopsided stratum with 120 < 200 sides (spread over every draft) -> inconclusive",
  makeRows({ lopsided: (origin, k, t) => (origin === 5 ? t % 5 === 0 : t % 10 === 0) }), 1, "inconclusive");
check("(d') a thin stratum concentrated in 4 drafts: inconclusive (rule 1 precedes the unknown rule-7 interval)", () => {
  const r = evalFmt(makeRows({ lopsided: (origin, k, t) => t % 5 === 0 && (origin === 5 || k < 4) })).trade;
  assert.equal(r.status, "inconclusive");
  assert.ok(r.failed_rules.includes(1));
  assert.equal(r.bootstrap.stratum_interval.lopsided, null);     // undefined in some resamples -> unknown, never skipped
});
expectOnly("rule 1: one expected cell missing -> inconclusive", BASE, 1, "inconclusive",
  { cells: { missing: [{ key: "x|2026|9|3", reason: "no draft" }], excluded: [] } });
expectOnly("rule 1: one cell excluded -> inconclusive", BASE, 1, "inconclusive",
  { cells: { missing: [], excluded: [{ key: "x|2026|5|0", reason: "uncovered" }] } });

// (e) mutation checks: each variant violates ONLY its rule.
// 4 of the 12 origin-9 lopsided sides per draft (two same-, two cross-position) get +-4 intervals: that
// cell's coverage ~0.53, every other cell / origin / pooled coverage stays >= ~0.75.
const narrowR2 = c => c.origin === 9 && c.strata.includes("lopsided") && (((c.t === 5 || c.t === 10 || c.t === 15) && c.side === "a") || (c.t === 20 && c.side === "b"));
expectOnly("(e) rule 2: a third of the origin-9 lopsided sides get narrow v2 intervals (cell coverage ~0.53, origin still in band)",
  makeRows({ h: c => (narrowR2(c) ? 4 : 10) }), 2);
expectOnly("(e) rule 3: rho0 intervals identical to v2's -> pooled interval score not lower",
  makeRows({ h0: () => 10 }), 3);
expectOnly("(e) rule 4 (MAE): v2 - current MAE 0.875 observed, upper bound > +1.0",
  makeRows({ dCur: c => (c.k < 14 ? 1.25 : 0) }), 4);
expectOnly("(e) rule 4 (regret): v2 - current regret 0.84 observed, upper bound > +1.0",
  makeRows({ v2Flip: c => c.k < 14 }), 4);
expectOnly("(e) rule 5 (MAE): v2 - naive MAE -0.16 observed, upper bound >= 0",
  makeRows({ D: c => (c.k >= 14 ? 1.0 : -0.2) }), 5);
expectOnly("(e) rule 5 (regret): naive's wrong-side picks only in drafts 0-1 -> upper bound = 0, not < 0",
  makeRows({ naiveFlip: c => c.k < 2 }), 5);
expectOnly("(e) rule 6 (current MAE): origin 5 observed +1.3 > +1.0, pooled bound < +1.0",
  makeRows({ dCur: c => (c.origin === 5 ? 1.3 : 0.3) }), 6);
expectOnly("(e) rule 6 (naive MAE): origin 5 observed +0.5 > 0, pooled bound < 0",
  makeRows({ D: c => (c.origin === 5 ? -0.5 : 6) }), 6);
expectOnly("(e) rule 6 (current regret): origin 5 observed +1.2 > +1.0, pooled bound < +1.0",
  makeRows({ v2Flip: c => c.origin === 5 }), 6);
expectOnly("(e) rule 6 (naive regret): origin 5 observed v2 - naive regret +0.3 > 0, pooled bound < 0",
  makeRows({ v2Flip: (c, i) => c.origin === 5 && i < 3, naiveFlip: c => c.origin === 9 }), 6);
expectOnly("(e) rule 7: lopsided stratum v2 - current MAE +3 (interval entirely above +1.0), pooled fine",
  makeRows({ dCur: c => (c.strata.includes("lopsided") ? 3 : 0) }), 7);

check("(e) boundary: rule 6 uses <= (observed exactly +1.0 passes), rule 4 uses a strict < on the bound", () => {
  const ck = PE.TRADE_RULES[5]({ m: { by_origin: { 5: fakeBlock(1.0, 0), 9: fakeBlock(1.0, 0) } }, origins: [5, 9] });
  assert.ok(ck.filter(c => /current/.test(c.id)).every(c => c.pass), JSON.stringify(ck));
  const ck4 = PE.TRADE_RULES[3]({ boot: { upper: { mae_current: 1.0, regret_current: 0.5 } } });
  assert.equal(ck4.find(c => c.id === "upper:mae_current").pass, false);
  assert.equal(ck4.find(c => c.id === "upper:regret_current").pass, true);
  const ck2 = PE.TRADE_RULES[1]({ m: { pooled: { coverage: { v2: 0.70 } }, by_origin: { 5: { coverage: { v2: 0.90 } }, 9: { coverage: { v2: 0.7 } } },
                                        by_origin_stratum: {} }, origins: [5, 9], strata: [] });
  assert.ok(ck2.every(c => c.pass), JSON.stringify(ck2));
  const ck7 = PE.TRADE_RULES[6]({ boot: { stratum_interval: { lopsided: [1.0, 3] } }, strata: ["lopsided"] });
  assert.equal(ck7[0].pass, true);      // lower end exactly +1.0 is not "entirely above"
  const ck7b = PE.TRADE_RULES[6]({ boot: { stratum_interval: { lopsided: null } }, strata: ["lopsided"] });
  assert.equal(ck7b[0].pass, false);    // unknown interval fails closed
});
function fakeBlock(dc, dn) {
  return { n: 1, mae: { v2: 10 + dc, current: 10, naive: 10 - dn }, regret: { v2: 5 + dc, current: 5, naive: 5 - dn } };
}

// (f) exploratory never passes
check("(f) exploratory format: the passing world reports status 'exploratory', never a pass", () => {
  const r = evalFmt(BASE, { primary: false });
  assert.equal(r.trade.status, "exploratory");
  assert.equal(r.waiver.status, "exploratory");
  assert.deepEqual(r.trade.failed_rules, []);     // metrics and checks are still computed and reported
  const c = evalFmt(BASE, { contingency: true });
  assert.equal(c.trade.status, "exploratory");     // spec §7.5: origin-9-only run cannot pass
  assert.equal(c.waiver.status, "exploratory");
});

// (h) waiver verdict independent of the trade verdict; waiver rule variants
check("(h) trade pass + waiver fail, and trade fail + waiver pass", () => {
  const w = makeWaiver({ cur: c => (c.k < 10 ? 0.5 : 2) });    // v2 worse than current in half the drafts: bound > 0
  const a = evalFmt(BASE, { waiverRows: w });
  assert.equal(a.trade.status, "conditional_pass");
  assert.equal(a.waiver.status, "conditional_fail");
  const b = evalFmt(makeRows({ h: () => 4 }));
  assert.equal(b.trade.status, "conditional_fail");
  assert.equal(b.waiver.status, "conditional_pass");
});
check("waiver rules: current-only and naive-only failures; missing cell -> inconclusive", () => {
  const onlyCur = evalFmt(BASE, { waiverRows: makeWaiver({ cur: c => (c.k < 3 ? 2 : 1) }) }).waiver;
  assert.deepEqual(onlyCur.failed_rules, [2]); assert.equal(onlyCur.status, "conditional_fail");
  const onlyNai = evalFmt(BASE, { waiverRows: makeWaiver({ nai: c => (c.k < 3 ? 3 : 1) }) }).waiver;
  assert.deepEqual(onlyNai.failed_rules, [3]); assert.equal(onlyNai.status, "conditional_fail");
  const miss = evalFmt(BASE, { cells: { missing: [{ key: "x", reason: "r" }], excluded: [] } }).waiver;
  assert.equal(miss.status, "inconclusive");
  const empty = evalFmt(BASE, { waiverRows: makeWaiver().filter(r => r.origin === 5) }).waiver;
  assert.equal(empty.status, "inconclusive");     // no waiver decisions at origin 9 is unknown, not zero
});

check("C1 (verdict layer): rows of origin 5 only, expected origins [5, 9] -> inconclusive for both features (never a pass on o5 alone)", () => {
  const r = evalFmt(BASE.filter(x => x.origin === 5), { waiverRows: makeWaiver().filter(x => x.origin === 5) });
  assert.equal(r.trade.status, "inconclusive"); assert.ok(r.trade.failed_rules.includes(1));
  assert.equal(r.waiver.status, "inconclusive");
});

check("reporting (not verdict inputs): superiority over current, stacks, concentration", () => {
  const r = evalFmt(BASE).trade;
  const rep = r.reporting;
  assert.equal(typeof rep.superiority_over_current.mae_upper, "number");
  assert.ok(rep.stacks.n > 0 && rep.stacks.n < BASE.length);
  assert.ok(rep.concentration.drop_players.dropped_players.length === 10);
  assert.ok(rep.concentration.drop_teams.dropped_teams.length <= 10);
  assert.ok(rep.concentration.drop_players.pooled.n < BASE.length);
});

/* ===========================================================================
   Layer 2 — the pipeline on a tiny synthetic freeze (real engine, few sims).
   Five formats (four primary + one exploratory) share the same synthetic players; two teams;
   drafts k = 0, 1; origins 5 and 9; three trades per cell.
   =========================================================================== */
const SLOTS = ["QB", "RB", "WR", "TE", "FLEX"];
const LABELS = [["f12-1qb-ppr-6", true], ["f10-1qb-ppr-6", true], ["f12-1qb-ppr-4", true], ["f12-1qb-half-4", true], ["f12-sf-ppr-4", false]];
const PLAYERS = {};
const posList = { QB: 6, RB: 9, WR: 9, TE: 5 };   // 2 rostered teams x (1 QB, 2 RB, 2 WR, 1 TE) + undrafted
const TEAMS = ["KC", "BUF", "DAL", "SF"];
{
  const rnd = TB.mulberry32(99);
  for (const [pos, cnt] of Object.entries(posList)) for (let i = 0; i < cnt; i++) {
    const base = { QB: 20, RB: 13, WR: 12, TE: 9 }[pos] - i * 1.1;
    PLAYERS[`${pos}${i}`] = { position: pos, team: TEAMS[i % 4], base: base + rnd() };
  }
}
const ids = pos => Object.keys(PLAYERS).filter(id => PLAYERS[id].position === pos);
function draftRosters(k) {
  // k shifts who goes where so the two drafts differ
  const q = ids("QB"), r = ids("RB"), w = ids("WR"), t = ids("TE");
  const sw = k % 2;
  const t0 = [q[sw], r[0], r[3], w[1], w[2], t[sw]];
  const t1 = [q[1 - sw], r[1], r[2], w[0], w[3], t[1 - sw]];
  return [t0, t1];
}
function forecastsFor(origin, label) {
  const weeks = []; for (let w = origin; w <= 17; w++) weeks.push(w);
  const players = {};
  for (const [id, p] of Object.entries(PLAYERS)) {
    const wk = {};
    for (const w of weeks) {
      const p50 = +(p.base + ((w * 7 + id.length) % 5) * 0.3).toFixed(2);
      wk[w] = { status: "play", p10: +(p50 * 0.45).toFixed(2), p50, p90: +(p50 * 1.6).toFixed(2) };
    }
    players[id] = { position: p.position, team: p.team, baseline: +(p.base * 0.9).toFixed(2), weeks: wk };
  }
  return { schema_version: 1, season: 2026, origin, weeks, training_through: 2025, format_key: `fk-${label}`, compat: {}, players };
}
const TAGS = { QB4: "OUT" };      // raw spelling: normalized to Out -> not an add, not a waiver replacement
function materialize(origin, label, primary, fc) {
  // Mirrors tools/prospective_materialize.cjs (Task 5) on this tiny world with the same trade_backtest functions.
  const weeks = fc.weeks, W = weeks.length;
  const RS = require("../site/assets/rostersim.js");
  const curProj = (id, w) => TB.p50Of(fc, id, w), posOf = id => TB.positionOf(fc, id);
  const out = { format_key: `fk-${label}`, compat: {}, label, primary, season: 2026, origin, weeks, slots: SLOTS,
                drafts: [], trades: [], waiver: [], replacement_by_week: {}, lopsided_cutoff: null,
                population: { attempts: 0, accepted: 0, rejected_not_starter: 0 }, excluded: [] };
  const rows = [];
  for (const k of [0, 1]) {
    const rosters = draftRosters(k);
    const taken = new Set(rosters.flat());
    const undrafted = Object.keys(PLAYERS).filter(id => !taken.has(id));
    out.drafts.push({ k, draft_seed: 1000 * 2026 + k, rosters, undrafted });
    const { curPool: pool } = TB.probeArms(undrafted, fc, weeks, SLOTS);
    const lineupOf = roster => TB.predictLineupOnly([roster], curProj, weeks, SLOTS, TB.replOf(pool, curProj), posOf)[0];
    const specs = [
      { give_a: [rosters[0][1]], give_b: [rosters[1][1]] },                    // RB for RB
      { give_a: [rosters[0][3]], give_b: [rosters[1][2]] },                    // WR for RB
      { give_a: [rosters[0][0], rosters[0][4]], give_b: [rosters[1][0]] },     // QB+WR for QB (b drops one)
    ];
    specs.forEach((sp, i) => {
      const t = { a: 0, b: 1, package: `${sp.give_a.length}-${sp.give_b.length}`, give_a: sp.give_a, give_b: sp.give_b,
                  drop_a: TB.overflowDrop(rosters[0], sp.give_a, sp.give_b.length - sp.give_a.length, fc),
                  drop_b: TB.overflowDrop(rosters[1], sp.give_b, sp.give_a.length - sp.give_b.length, fc) };
      const id = `2026:${origin}:${k}:${i}`;
      const ts = TB.tradeStrata({ trade: t, sides: TB.tradeSides(rosters, t), posOf, W, lineupOf });
      out.trades.push(Object.assign({ id, k }, t, { strata: ts.a.strata }));
      for (const s of ["a", "b"]) rows.push({ trade_id: id, origin, current: ts[s].current, strata: ts[s].strata });
    });
    const heavy = id => TB.HEAVY_TAGS.has(RS.normalizeTag(TAGS[id]));
    const fa = undrafted.filter(id => !heavy(id));
    const adds = TB.waiverAdds(fa, fc, weeks, TB.WAIVER_QUOTA);
    const { curPool: wpool } = TB.probeArms(fa.filter(id => !adds.includes(id)), fc, weeks, SLOTS);
    out.replacement_by_week[k] = pool;
    rosters.forEach((_, team) => out.waiver.push({ k, team, adds, pool_by_week: wpool }));
  }
  out.lopsided_cutoff = TB.markLopsided(rows)[origin];
  const st = new Map(rows.map(r => [r.trade_id, r.strata]));
  for (const t of out.trades) t.strata = st.get(t.id);
  return out;
}
const RHO_JSON = JSON.stringify({ table: { QB: 0.25, RB: 0.26, WR: 0.24, TE: 0.16 }, support_violations: { QB: 5, RB: 4, WR: 3, TE: 1 } });
const AVAIL = { schema_version: 1, p_out: { QB: 0.08, RB: 0.09, WR: 0.09, TE: 0.09 }, p_stay: { QB: 0.8, RB: 0.68, WR: 0.63, TE: 0.63 },
                p_tag: { Out: 0.7, Doubtful: 0.58, Questionable: 0.22, IR: 0.95 } };
function writeJson(p, x) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(x)); }
function buildFreeze(dir) {
  const dryRun = false;
  for (const origin of [5, 9]) {
    const od = path.join(dir, `o${origin}`);
    const cells = [];
    for (const [label, primary] of LABELS) {
      const fc = forecastsFor(origin, label);
      writeJson(path.join(od, `forecasts_2026_o${origin}_${label}.json`), fc);
      writeJson(path.join(od, "decisions", `${label}.json`), materialize(origin, label, primary, fc));
      for (const k of [0, 1]) cells.push({ format: label, k, origin, key: `${label}|2026|${origin}|${k}`, primary });
    }
    writeJson(path.join(od, "decisions", "cells.json"), cells);
    writeJson(path.join(od, "manifest.json"), { season: 2026, origin, dry_run: dryRun, exploratory: false });
    writeJson(path.join(od, `tags_w${origin - 1}.json`), { season: 2026, week: origin - 1, source: "fixture", tags: TAGS });
    writeJson(path.join(od, "inputs", "availability.json"), AVAIL);
    fs.mkdirSync(path.join(od, "inputs"), { recursive: true });
    fs.writeFileSync(path.join(od, "inputs", "rho.json"), RHO_JSON);
  }
  // outcomes: one lens per format (points in that format's scoring), weeks 5..17
  const rnd = TB.mulberry32(4242);
  const ROSTERED = new Set([0, 1].flatMap(k => draftRosters(k).flat()));
  const aw = {};
  for (const [id, p] of Object.entries(PLAYERS)) {
    aw[id] = {};
    // rostered players miss ~8% of weeks; free agents always play (so the realized replay can always fill a slot)
    for (let w = 5; w <= 17; w++) if (rnd() > 0.08 || !ROSTERED.has(id)) aw[id][String(w)] = +(Math.max(0, p.base + (rnd() - 0.5) * p.base * 1.2)).toFixed(2);
  }
  const outcomes = { schema_version: 1, season: 2026, as_of: "2027-01-12", actual_weeks: Object.fromEntries(LABELS.map(([l]) => [l, aw])) };
  writeJson(path.join(dir, "outcomes_2026.json"), outcomes);
  fs.writeFileSync(path.join(dir, "rho.json"), RHO_JSON);
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pe-fixture-"));
const FREEZE = path.join(ROOT, "freeze");
buildFreeze(FREEZE);
const GEN = "2027-01-20T00:00:00.000Z";
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: Object.assign({}, process.env, env) });
  return r;
}
function evalArgs(freeze, out, gates, extra = []) {
  return ["--freeze", freeze, "--outcomes", path.join(freeze, "outcomes_2026.json"), "--rho", path.join(freeze, "rho.json"),
          "--out", out, "--gates-out", gates, "--sims", "16", "--generated-at", GEN, ...extra];
}
const ok = (r, what) => assert.equal(r.status, 0, `${what}: exit ${r.status}\n${r.stderr}\n${r.stdout}`);

const OUT = path.join(ROOT, "eval.json"), GATES = path.join(ROOT, "gates.json");
check("pipeline: unsharded run writes eval.json and sim_gates.json (schema 3)", () => {
  ok(run(evalArgs(FREEZE, OUT, GATES)), "unsharded");
  const ev = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const g = JSON.parse(fs.readFileSync(GATES, "utf8"));
  assert.equal(ev.predeclared, false);                      // 16 sims, 2 drafts: never the predeclared run
  assert.equal(g.schema_version, 3);
  assert.equal(g.engine, "rostersim-v2");
  assert.equal(g.evidence, "2026 prospective, synthetic leagues");
  assert.deepEqual(g.origins, [5, 9]);
  assert.equal(g.horizon_rule, "nearest origin, ties to shorter");
  assert.equal(g.rho_sha256, crypto.createHash("sha256").update(RHO_JSON).digest("hex"));
  assert.equal(g.generated_at, GEN);
  assert.equal(g.records.length, 10);
  for (const [label, primary] of LABELS) for (const feature of ["trade_grade", "waiver_sim"]) {
    const rec = g.records.find(x => x.label === label && x.feature === feature);
    assert.ok(rec, `${label} ${feature}`);
    assert.equal(rec.format_key, `fk-${label}`);
    assert.deepEqual(rec.compat, {});
    assert.ok(Array.isArray(rec.horizons) && rec.horizons.length === 2);
    if (!primary) assert.equal(rec.status, "exploratory");
    else if (feature === "trade_grade") assert.equal(rec.status, "inconclusive");     // 6 sides per stratum < 200
    else assert.ok(["conditional_pass", "conditional_fail"].includes(rec.status), rec.status);
    assert.notEqual(rec.status, "pass");
  }
  const tg = g.records.find(x => x.label === "f12-1qb-ppr-6" && x.feature === "trade_grade");
  assert.deepEqual(tg.horizons.map(h => h.origin), [5, 9]);
  assert.ok(Number.isFinite(tg.horizons[0].lopsided_cutoff));
  assert.ok("E" in tg.horizons[0].strata.same_position);
  // eval.json: every cell evaluated, both arms present, support violations and v1 context carried
  const fa = ev.formats["f12-1qb-ppr-6"];
  assert.equal(fa.cells.declared, 4); assert.equal(fa.cells.evaluated, 4);
  assert.deepEqual(fa.cells.missing, []); assert.deepEqual(fa.cells.excluded, []);
  assert.equal(fa.trade.metrics.pooled.n, 24);      // 3 trades x 2 sides x 2 drafts x 2 origins
  assert.equal(fa.trade.metrics.by_origin[5].n, 12);
  assert.ok(Number.isFinite(fa.trade.metrics.pooled.interval_score.rho0));
  assert.deepEqual(ev.rho.support_violations, { QB: 5, RB: 4, WR: 3, TE: 1 });
  assert.ok(ev.reporting.v1_per_season_coverage.gabagool["2023"] === 0.716);
  assert.ok(fa.trade.failed_rules.includes(1));
});

check("pipeline: v2 and rho0 arms share seeds but differ; expected values nearly equal", () => {
  const ev = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const p = ev.formats["f12-1qb-ppr-6"].trade.metrics.pooled;
  assert.ok(p.width.v2 !== p.width.rho0, "rho changes intervals");
});

check("(g) three shards merged == unsharded, byte for byte", () => {
  const cellFiles = [0, 1, 2].map(i => path.join(ROOT, `shard${i}.json`));
  cellFiles.forEach((f, i) => ok(run(["--freeze", FREEZE, "--outcomes", path.join(FREEZE, "outcomes_2026.json"), "--rho", path.join(FREEZE, "rho.json"),
                                      "--sims", "16", "--shard", `${i}/3`, "--cells-out", f]), `shard ${i}`));
  const sizes = cellFiles.map(f => JSON.parse(fs.readFileSync(f, "utf8")).cells.length);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 20);
  assert.ok(sizes.every(s => s > 0));
  const mo = path.join(ROOT, "merged.json"), mg = path.join(ROOT, "merged_gates.json");
  ok(run(evalArgs(FREEZE, mo, mg, ["--merge", ...cellFiles])), "merge");
  assert.ok(fs.readFileSync(mo).equals(fs.readFileSync(OUT)), "eval.json differs");
  assert.ok(fs.readFileSync(mg).equals(fs.readFileSync(GATES)), "sim_gates.json differs");
  const dup = run(evalArgs(FREEZE, mo, mg, ["--merge", cellFiles[0], cellFiles[0], cellFiles[1], cellFiles[2]]));
  assert.notEqual(dup.status, 0); assert.match(dup.stderr, /duplicate/);
  const miss = run(evalArgs(FREEZE, mo, mg, ["--merge", cellFiles[0], cellFiles[1]]));
  assert.notEqual(miss.status, 0); assert.match(miss.stderr, /missing/);
});

check("--jobs 2 (worker threads) == --jobs 1", () => {
  const o2 = path.join(ROOT, "eval_j2.json"), g2 = path.join(ROOT, "gates_j2.json");
  ok(run(evalArgs(FREEZE, o2, g2, ["--jobs", "2"])), "jobs 2");
  assert.ok(fs.readFileSync(o2).equals(fs.readFileSync(OUT)));
});

check("(c) one expected cell missing (draft absent from the freeze) -> that format inconclusive, others unaffected", () => {
  const F2 = path.join(ROOT, "freeze_missing");
  fs.cpSync(FREEZE, F2, { recursive: true });
  const dp = path.join(F2, "o9", "decisions", "f10-1qb-ppr-6.json");
  const dec = JSON.parse(fs.readFileSync(dp, "utf8"));
  dec.drafts = dec.drafts.filter(d => d.k !== 1);
  dec.trades = dec.trades.filter(t => t.k !== 1); dec.waiver = dec.waiver.filter(w => w.k !== 1);
  fs.writeFileSync(dp, JSON.stringify(dec));
  const o = path.join(ROOT, "eval_missing.json"), g = path.join(ROOT, "gates_missing.json");
  ok(run(evalArgs(F2, o, g)), "missing");
  const ev = JSON.parse(fs.readFileSync(o, "utf8"));
  const fb = ev.formats["f10-1qb-ppr-6"];
  assert.equal(fb.cells.missing.length, 1);
  assert.equal(fb.cells.missing[0].key, "f10-1qb-ppr-6|2026|9|1");
  assert.equal(fb.trade.status, "inconclusive");
  assert.equal(fb.waiver.status, "inconclusive");
  assert.ok(fb.trade.checks.some(c => c.id === "cells:missing" && !c.pass));
  assert.deepEqual(ev.formats["f12-1qb-ppr-6"].cells.missing, []);
  assert.notEqual(ev.formats["f12-1qb-ppr-6"].waiver.status, "inconclusive");
});

check("review focus 5: a rostered player without a forecast row -> cell excluded -> inconclusive (never dropped)", () => {
  const F3 = path.join(ROOT, "freeze_uncovered");
  fs.cpSync(FREEZE, F3, { recursive: true });
  const fp = path.join(F3, "o5", "forecasts_2026_o5_f12-1qb-ppr-4.json");
  const fc = JSON.parse(fs.readFileSync(fp, "utf8"));
  const rostered = draftRosters(0)[0][2];
  delete fc.players[rostered].weeks[10];
  fs.writeFileSync(fp, JSON.stringify(fc));
  const o = path.join(ROOT, "eval_unc.json"), g = path.join(ROOT, "gates_unc.json");
  ok(run(evalArgs(F3, o, g)), "uncovered");
  const fcx = JSON.parse(fs.readFileSync(o, "utf8")).formats["f12-1qb-ppr-4"];
  assert.ok(fcx.cells.excluded.some(e => e.key.startsWith("f12-1qb-ppr-4|2026|5|") && /coverage/.test(e.reason)), JSON.stringify(fcx.cells));
  assert.equal(fcx.trade.status, "inconclusive");
  assert.equal(fcx.waiver.status, "inconclusive");
});

check("frozen exclusion (decisions.excluded) -> inconclusive", () => {
  const F4 = path.join(ROOT, "freeze_ex");
  fs.cpSync(FREEZE, F4, { recursive: true });
  const dp = path.join(F4, "o5", "decisions", "f12-1qb-half-4.json");
  const dec = JSON.parse(fs.readFileSync(dp, "utf8"));
  dec.excluded.push({ k: 0, reason: "1 rostered player(s) lack full forecast coverage", players: ["RB0"] });
  dec.trades = dec.trades.filter(t => t.k !== 0);
  fs.writeFileSync(dp, JSON.stringify(dec));
  const o = path.join(ROOT, "eval_ex.json"), g = path.join(ROOT, "gates_ex.json");
  ok(run(evalArgs(F4, o, g)), "excluded");
  const ev = JSON.parse(fs.readFileSync(o, "utf8"));
  assert.ok(ev.formats["f12-1qb-half-4"].cells.excluded.some(e => e.key === "f12-1qb-half-4|2026|5|0"));
  assert.equal(ev.formats["f12-1qb-half-4"].trade.status, "inconclusive");
});

check("M != 4 primary formats is refused; non-predeclared run cannot write under site/", () => {
  const F5 = path.join(ROOT, "freeze_m3");
  fs.cpSync(FREEZE, F5, { recursive: true });
  for (const O of [5, 9]) {
    const dp = path.join(F5, `o${O}`, "decisions", "f12-1qb-half-4.json");
    const dec = JSON.parse(fs.readFileSync(dp, "utf8")); dec.primary = false; fs.writeFileSync(dp, JSON.stringify(dec));
  }
  const r = run(evalArgs(F5, path.join(ROOT, "m3.json"), path.join(ROOT, "m3g.json")));
  assert.notEqual(r.status, 0); assert.match(r.stderr, /primary/);
  const siteGate = path.join(__dirname, "..", "site", "data", "sim_gates_fixture_should_not_exist.json");
  const s = run(evalArgs(FREEZE, path.join(ROOT, "s.json"), siteGate));
  assert.notEqual(s.status, 0); assert.match(s.stderr, /predeclared/);
  assert.ok(!fs.existsSync(siteGate));
});

check("freeze integrity: --rho must be byte-identical to the frozen inputs/rho.json", () => {
  const other = path.join(ROOT, "rho_other.json");
  fs.writeFileSync(other, JSON.stringify({ table: { QB: 0.2, RB: 0.2, WR: 0.2, TE: 0.2 } }));
  const r = run(["--freeze", FREEZE, "--outcomes", path.join(FREEZE, "outcomes_2026.json"), "--rho", other,
                 "--out", path.join(ROOT, "r.json"), "--gates-out", path.join(ROOT, "rg.json"), "--sims", "16", "--generated-at", GEN]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /rho/);
});

check("contingency (spec §7.5): origin-5 freeze absent -> every record exploratory", () => {
  const F6 = path.join(ROOT, "freeze_o9only");
  fs.cpSync(FREEZE, F6, { recursive: true });
  fs.rmSync(path.join(F6, "o5"), { recursive: true });
  writeJson(path.join(F6, "o9", "manifest.json"), { season: 2026, origin: 9, dry_run: false, exploratory: true });
  const o = path.join(ROOT, "eval_c.json"), g = path.join(ROOT, "gates_c.json");
  ok(run(evalArgs(F6, o, g)), "contingency");
  const gates = JSON.parse(fs.readFileSync(g, "utf8"));
  assert.ok(gates.records.every(r => r.status === "exploratory"), JSON.stringify(gates.records.map(r => r.status)));
  assert.equal(JSON.parse(fs.readFileSync(o, "utf8")).contingency, true);
  assert.deepEqual(gates.origins, [9]);
  // contingency must agree with the manifest: an o9 manifest that is NOT exploratory with o5 absent aborts
  writeJson(path.join(F6, "o9", "manifest.json"), { season: 2026, origin: 9, dry_run: false, exploratory: false });
  const g2 = path.join(ROOT, "gates_c2.json");
  const bad = run(evalArgs(F6, path.join(ROOT, "eval_c2.json"), g2));
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /exploratory/); assert.ok(!fs.existsSync(g2));
});

// C1: both origins are required outside the §7.5 contingency
check("C1: origin-9 freeze absent (o5 present, no contingency) -> every primary record inconclusive, origins evaluated = [5]", () => {
  const F7 = path.join(ROOT, "freeze_no9");
  fs.cpSync(FREEZE, F7, { recursive: true });
  fs.rmSync(path.join(F7, "o9"), { recursive: true });
  const o = path.join(ROOT, "eval_no9.json"), g = path.join(ROOT, "gates_no9.json");
  ok(run(evalArgs(F7, o, g)), "no o9");
  const gates = JSON.parse(fs.readFileSync(g, "utf8")), ev = JSON.parse(fs.readFileSync(o, "utf8"));
  assert.deepEqual(gates.origins, [5]); assert.deepEqual(ev.origins, [5]); assert.deepEqual(ev.expected_origins, [5, 9]);
  assert.equal(ev.contingency, false);
  for (const [label, primary] of LABELS) for (const feature of ["trade_grade", "waiver_sim"]) {
    const rec = gates.records.find(x => x.label === label && x.feature === feature);
    assert.equal(rec.status, primary ? "inconclusive" : "exploratory", `${label} ${feature}`);
    assert.deepEqual(rec.horizons.map(h => h.origin), [5]);
  }
  assert.equal(ev.formats["f12-1qb-ppr-6"].cells.missing.length, 2);       // both o9 cells of the format
  assert.ok(ev.formats["f12-1qb-ppr-6"].trade.checks.some(c => c.id === "cells:missing" && !c.pass));
});

// M1: the outcome artifact is validated fail-closed; nothing is written on failure
check("M1: outcome artifact validation (as_of, season, lens, weeks) aborts with no gate output", () => {
  const variants = {
    as_of: oc => { oc.as_of = "2027-01-05"; }, season: oc => { oc.season = 2025; },
    lens: oc => { delete oc.actual_weeks["f12-1qb-ppr-4"]; },
    week: oc => { for (const byW of Object.values(oc.actual_weeks["f10-1qb-ppr-6"])) delete byW["12"]; },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const F = path.join(ROOT, `freeze_oc_${name}`);
    fs.cpSync(FREEZE, F, { recursive: true });
    const op = path.join(F, "outcomes_2026.json");
    const oc = JSON.parse(fs.readFileSync(op, "utf8")); mutate(oc); fs.writeFileSync(op, JSON.stringify(oc));
    const g = path.join(ROOT, `gates_oc_${name}.json`);
    const r = run(evalArgs(F, path.join(ROOT, `eval_oc_${name}.json`), g));
    assert.notEqual(r.status, 0, name); assert.ok(!fs.existsSync(g), name);
    assert.match(r.stderr, name === "as_of" ? /as_of/ : name === "season" ? /season/ : name === "lens" ? /lens/ : /week 12/, `${name}: ${r.stderr}`);
  }
});

// M2: pinned labels
check("M2: primary labels are pinned in RULES; a decisions file that disagrees aborts", () => {
  assert.deepEqual(PE.RULES.primary_labels, ["f12-1qb-ppr-6", "f10-1qb-ppr-6", "f12-1qb-ppr-4", "f12-1qb-half-4"]);
  assert.deepEqual(PE.RULES.exploratory_labels, ["f12-sf-ppr-4"]);
  const F = path.join(ROOT, "freeze_pin");
  fs.cpSync(FREEZE, F, { recursive: true });
  for (const O of [5, 9]) {                     // swap which format is primary, keeping M = 4: only the pin can catch it
    for (const [l, p] of [["f12-1qb-half-4", false], ["f12-sf-ppr-4", true]]) {
      const dp = path.join(F, `o${O}`, "decisions", `${l}.json`);
      const dec = JSON.parse(fs.readFileSync(dp, "utf8")); dec.primary = p; fs.writeFileSync(dp, JSON.stringify(dec));
    }
  }
  const g = path.join(ROOT, "gates_pin.json");
  const r = run(evalArgs(F, path.join(ROOT, "eval_pin.json"), g));
  assert.notEqual(r.status, 0); assert.match(r.stderr, /pins/); assert.ok(!fs.existsSync(g));
});

// M3: lopsided marks are recomputed
check("M3: a frozen lopsided mark that disagrees with the recomputed cutoff excludes the cell", () => {
  const F = path.join(ROOT, "freeze_lop");
  fs.cpSync(FREEZE, F, { recursive: true });
  const dp = path.join(F, "o5", "decisions", "f10-1qb-ppr-6.json");
  const dec = JSON.parse(fs.readFileSync(dp, "utf8"));
  const t = dec.trades.find(x => x.k === 0 && !x.strata.includes("lopsided"));
  assert.ok(t, "fixture has a non-lopsided trade");
  t.strata.push("lopsided"); fs.writeFileSync(dp, JSON.stringify(dec));
  const o = path.join(ROOT, "eval_lop.json");
  ok(run(evalArgs(F, o, path.join(ROOT, "gates_lop.json"))), "lopsided");
  const fb = JSON.parse(fs.readFileSync(o, "utf8")).formats["f10-1qb-ppr-6"];
  assert.ok(fb.cells.excluded.some(e => e.key === "f10-1qb-ppr-6|2026|5|0" && /lopsided/.test(e.reason)), JSON.stringify(fb.cells));
  assert.equal(fb.trade.status, "inconclusive");
});

// M4: manifests
check("M4: manifest dry_run / exploratory disagreements abort", () => {
  for (const [name, mf, re] of [["dry", { season: 2026, origin: 5, dry_run: true, exploratory: false }, /dry_run/],
                                ["expl", { season: 2026, origin: 5, dry_run: false, exploratory: true }, /exploratory/],
                                ["origin", { season: 2026, origin: 9, dry_run: false, exploratory: false }, /manifest/]]) {
    const F = path.join(ROOT, `freeze_mf_${name}`);
    fs.cpSync(FREEZE, F, { recursive: true });
    writeJson(path.join(F, "o5", "manifest.json"), mf);
    const g = path.join(ROOT, `gates_mf_${name}.json`);
    const r = run(evalArgs(F, path.join(ROOT, `eval_mf_${name}.json`), g));
    assert.notEqual(r.status, 0, name); assert.match(r.stderr, re, name); assert.ok(!fs.existsSync(g), name);
  }
  const F = path.join(ROOT, "freeze_mf_none");
  fs.cpSync(FREEZE, F, { recursive: true }); fs.rmSync(path.join(F, "o9", "manifest.json"));
  const r = run(evalArgs(F, path.join(ROOT, "eval_mf_none.json"), path.join(ROOT, "gates_mf_none.json")));
  assert.notEqual(r.status, 0); assert.match(r.stderr, /manifest/);
});

// M6: dry-run evaluation
check("M6: --dry-run-origin evaluates only dryrun-o<O>, never writes a gate file, reports consistency exclusions", () => {
  const D = path.join(ROOT, "freeze_dry");
  fs.mkdirSync(D);
  fs.cpSync(path.join(FREEZE, "o5"), path.join(D, "dryrun-o5"), { recursive: true });
  writeJson(path.join(D, "dryrun-o5", "manifest.json"), { season: 2026, origin: 5, dry_run: true, exploratory: false });
  fs.copyFileSync(path.join(FREEZE, "rho.json"), path.join(D, "rho.json"));
  const oc = JSON.parse(fs.readFileSync(path.join(FREEZE, "outcomes_2026.json"), "utf8")); oc.as_of = "synthetic";
  for (const lens of Object.values(oc.actual_weeks)) { delete lens.TE0["17"]; delete lens.WR3["16"]; }     // partial outcomes are fine
  writeJson(path.join(D, "outcomes_2026.json"), oc);
  const out = path.join(ROOT, "eval_dry.json");
  const args = ["--freeze", D, "--outcomes", path.join(D, "outcomes_2026.json"), "--rho", path.join(D, "rho.json"), "--sims", "16", "--dry-run-origin", "5", "--out", out];
  const r = run(args);
  ok(r, "dry run");
  assert.match(r.stdout, /0 freeze-consistency exclusion/);
  const ev = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.deepEqual(ev.origins, [5]); assert.equal(ev.dry_run.freeze_consistency_exclusions, 0); assert.equal(ev.predeclared, false);
  assert.equal(ev.formats["f12-1qb-ppr-6"].cells.evaluated, 2);
  assert.ok(Object.values(ev.formats).every(f => f.trade.status === "exploratory"));
  // --gates-out is refused; a real (dry_run:false) manifest is refused in dry-run mode
  const g = path.join(ROOT, "gates_dry.json");
  const rg = run(args.concat(["--gates-out", g]));
  assert.notEqual(rg.status, 0); assert.match(rg.stderr, /gate/); assert.ok(!fs.existsSync(g));
  writeJson(path.join(D, "dryrun-o5", "manifest.json"), { season: 2026, origin: 5, dry_run: false, exploratory: false });
  assert.notEqual(run(args).status, 0);
  writeJson(path.join(D, "dryrun-o5", "manifest.json"), { season: 2026, origin: 5, dry_run: true, exploratory: false });
  // a materializer / evaluator disagreement is counted
  const dp = path.join(D, "dryrun-o5", "decisions", "f12-1qb-ppr-6.json");
  const dec = JSON.parse(fs.readFileSync(dp, "utf8"));
  dec.trades.find(x => x.k === 0 && !x.strata.includes("lopsided")).strata.push("lopsided"); fs.writeFileSync(dp, JSON.stringify(dec));
  const r2 = run(args);
  ok(r2, "dry run, disagreeing");
  assert.match(r2.stdout, /[1-9]\d* freeze-consistency exclusion/); assert.match(r2.stdout, /DISAGREE/);
  assert.ok(JSON.parse(fs.readFileSync(out, "utf8")).dry_run.freeze_consistency_exclusions >= 1);
  // the normal mode never sees dryrun-o<O>
  assert.notEqual(run(evalArgs(D, path.join(ROOT, "x.json"), path.join(ROOT, "xg.json"))).status, 0);
});

if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true }); else console.log(ROOT);
if (failed.length) { console.error(`FAILED ${failed.length}:\n  ${failed.join("\n  ")}`); process.exit(1); }
console.log(`prospective_eval_fixture: ${n} checks ok`);
