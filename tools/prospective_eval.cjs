// tools/prospective_eval.cjs — the evaluator and gate writer of the prospective 2026 test.
//
//   node tools/prospective_eval.cjs --freeze models/prospective/2026 \
//        --outcomes models/prospective/2026/outcomes_2026.json --rho models/prospective/2026/rho.json \
//        --out models/prospective/2026/eval.json --gates-out site/data/sim_gates.json
//        [--jobs N]                                   worker threads; results do not depend on it
//        [--shard i/n --cells-out <path>]             evaluate only cells whose index = i mod n, write them
//        [--merge <cells files...>]                   aggregate shard files (duplicate / missing cell -> error)
//        [--cells-out <path>]                         (unsharded) also write every cell's rows
//        [--sims N] [--generated-at <ISO>]            tests only: any sims != 2000 is not the predeclared run
//
// Spec 2026-09-30 §6 (predeclared). This file is FROZEN with the origin-5 manifest, before any 2026 outcome
// exists, and runs after the season (§7.6). Its verdict logic is §6.3 (trade) and §6.4 (waiver) verbatim; every
// constant is in RULES below and every place where the spec was silent is listed in CHOICES. It is not a tuning knob.
//
// Machinery is reused from tools/trade_backtest.cjs (required, never copied): runCell (the current / naive
// predictors, the shipped simulation through buildSimWorld, the realized no-hindsight replay, the waiver drop
// decisions), block / regretOf / waiverMetrics (v1 metric definitions), percentile (type 7), mulberry32 / hashStr,
// horizonsOf (the v1 schema-2 per-origin E and cutoff), readRho, runCells (the worker pool), roundDeep, isInside.
//
// Freeze layout read here (written by Task 5's materializer and Task 7's freeze workflow):
//   <freeze>/o<O>/decisions/cells.json            expected cell manifest [{format, k, origin, key}]
//   <freeze>/o<O>/decisions/<label>.json           materialized decisions (drafts with undrafted, trades with strata,
//                                                  waiver add sets and pools, replacement_by_week {k: {w: {pos}}},
//                                                  lopsided_cutoff, slots, primary, format_key, compat, excluded)
//   <freeze>/o<O>/forecasts_2026_o<O>_<label>.json frozen per-format forecasts (weeks O..17)
//   <freeze>/o<O>/tags_w<O-1>.json                 week O-1 injury tags {week, tags: {id: status}}
//   <freeze>/o<O>/inputs/availability.json         availability rates (site/data/availability.json bytes)
//   <freeze>/o<O>/inputs/rho.json                  the frozen rho table; --rho must be byte-identical
// Outcomes (§7.6, built after week 17 from stats as of 2027-01-12, hashed separately):
//   {schema_version: 1, season: 2026, as_of, actual_weeks: {<label>: {<player id>: {"<week>": points}}}}
//   points in that format's scoring over the predicted scope (§4.3); an entry means the player played that week.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const TB = require("./trade_backtest.cjs");
const RS = require(path.join(__dirname, "..", "site", "assets", "rostersim.js"));

const { BacktestError } = TB;
const LAST_WEEK = 17;
const byId = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const deepFreeze = o => { for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v); return Object.freeze(o); };

/* ============================================================================================================
   RULES — the predeclared protocol (spec 2026-09-30). Changing any value after the freeze changes the test.
   ============================================================================================================ */
const RULES = deepFreeze({
  season: 2026,                         // §6
  origins: [5, 9],                      // §6.1; the first one missing = the §7.5 contingency (exploratory only)
  drafts: 20,                           // §6.1: draft seeds 1000*2026 + k, k = 0..19
  trades_per_cell: 125,                 // §6.1: a population target; a short cell is reported, never a verdict input
  sims: 2000,                           // §6.2: v2 and rho = 0, same seeds
  bootstrap_B: 20000,                   // §6.3
  bootstrap_seed: "prospective-2026",   // resample indices generated ONCE and shared by every format and feature
  primary_M: 4,                         // §2.2 / §4.1: exactly four primary formats
  coverage_band: [0.70, 0.90],          // §6.3 rule 2 (inclusive)
  min_sides: 200,                       // §6.3 rule 1: trade sides per origin x stratum
  margin_current: 1.0,                  // §6.3 rules 4, 6, 7: declared engineering tolerance, points per trade side
  margin_naive: 0,                      // §6.3 rules 5, 6
  interval_penalty: 10,                 // §6.3 interval score U - L + 10(L - y)[y<L] + 10(y - U)[y>U] (2/alpha, 80%)
  stratum_interval: [0.025, 0.975],     // CHOICE 2: rule 7's interval = v1's two-sided 95% percentile interval
  strata: TB.STRATA.slice(),            // §6.1 / v1 §10.3: same_position, cross_position, depth_for_starter, lopsided
  sim_seed: "hashStr(`sim:${season}:${origin}:${k}`), shared by v2 and rho = 0 and by every format (v1 convention)",
  pooling: "equal-origin: pooled statistic = unweighted mean over origins of the per-origin statistic (CHOICE 1)",
  percentile: "linear interpolation (type 7)",
  upper_bound: "one-sided upper bound = the (1 - alpha) type-7 quantile of the resampled statistic",
  resampling: "whole draft seeds k with replacement; all origins, both sides, trade and waiver decisions of a draft move together",
});
const alphaTrade = M => 0.05 / (4 * M);     // §6.3: level 1 - 0.05/(4M)
const alphaWaiver = M => 0.05 / (2 * M);    // §6.4: level 1 - 0.05/(2M)

/* CHOICES — where spec §6 and the task brief are silent, the simplest reading consistent with §6.3 (reviewed
   by the controller before the freeze):
   1. Equal-origin weights: every pooled metric, pooled difference, pooled coverage and pooled interval score is
      the plain mean of the two per-origin values (each per-origin value is a mean over that origin's sides). The
      bootstrap applies the same recipe inside each resample. A stratum's pooled value is likewise the mean of its
      two origin x stratum values.
   2. Rule 7 ("no stratum's (v2 - current) MAE interval entirely above +1.0"): the interval is v1's two-sided 95%
      percentile interval [q 0.025, q 0.975] of the pooled (equal-origin) stratum difference over the same
      resamples; the rule fails iff q 0.025 > +1.0, or the interval is unknown (fail closed).
   3. Rule 1's strata are all four v1 strata at both origins (8 origin x stratum cells, each >= 200 sides).
   4. Status precedence: any rule-1 failure -> inconclusive (even if other rules also fail); otherwise any failure
      of rules 2-7 -> conditional_fail; otherwise conditional_pass. Non-primary formats and the §7.5 contingency
      -> "exploratory" (checks still computed and reported).
   5. Waiver (§6.4): inconclusive if any declared cell is missing or excluded, or an origin has no waiver
      decisions (unknown is not zero); conditional_pass iff both one-sided upper bounds of pooled (equal-origin)
      mean-regret differences (v2 - current, v2 - naive) are < 0 at level 1 - 0.05/(2M); else conditional_fail.
   6. Cell integrity: the frozen decisions are authoritative (trades, strata incl. lopsided, add sets). The cell
      is recomputed through trade_backtest.runCell; if runCell's own add set, waiver pool, trade replacement pool
      or non-lopsided strata differ from the frozen ones, or the v2 and rho = 0 runs disagree on anything but the
      simulation, the cell is EXCLUDED with the reason (-> inconclusive), never silently re-decided.
   7. A structurally broken freeze (missing decisions / forecast / tags / availability file, rho bytes differing
      from the frozen inputs/rho.json, drafts differing between origins, M != 4) aborts with no output (gate
      files untouched = closed). Cell-level gaps (a draft absent from decisions, a frozen exclusion, a missing
      outcome lens, a runCell exclusion) are published as missing / excluded cells -> inconclusive.
   8. Teammate/stack subset: a side whose given players or whose received players include two of one NFL team
      (team from the frozen forecast file). Concentration: exposure of a player = number of trade sides whose
      trade moves him (both origins together); the 10 highest (ties by id) are dropped with every side of every
      trade that moves any of them; teams likewise (a side counts once per team it moves). Point metrics only.
   9. The waiver sim arm uses v2 (rho table); the rho = 0 waiver regret is reported. The v1 availability-off
      diagnostic arm is not part of v2 (runCell is called with diagnosticSims 1 and its output discarded).
  10. Short cells (fewer than 125 trades) are reported and are not missing cells.
  11. A resampled statistic undefined in any resample (an origin, or an origin x stratum, with no sides among the
      drawn drafts) makes that bound / interval unknown, which fails its check (fail closed; v1 skipped such
      resamples for strata).
*/

const V1_CONTEXT = deepFreeze({       // spec §6.5, context only
  gabagool: { 2023: 0.716, 2024: 0.595, 2025: 0.640 },
  fam: { 2023: 0.733, 2024: 0.626, 2025: 0.637 },
  note: "v1 per-season 80% coverage from its frozen outputs: a misspecified model's spread, not a measurement of v2's season-shock false-failure rate (spec §6.5)",
});

/* ============================================================================================================
   Metrics (pure).
   A trade row = one trade side: {k, origin, trade_id, side, strata[], position, real,
                                  v2, v2_p10, v2_p90, rho0, rho0_p10, rho0_p90, current, naive,
                                  give[], receive[], give_teams[], receive_teams[]}.
   A waiver row = one drop decision: {k, origin, team, add, choice: {v2, rho0, current, naive}, regret: {...}}.
   ============================================================================================================ */
const fin = x => (typeof x === "number" && Number.isFinite(x) ? x : null);
const asV1 = (rows, arm) => rows.map(r => ({ origin: r.origin, strata: r.strata, position: r.position, real: r.real,
                                             sim: r[arm], sim_p10: r[arm + "_p10"], sim_p90: r[arm + "_p90"], current: r.current, naive: r.naive }));
function intervalStats(rows, arm) {
  let w = 0, lo = 0, hi = 0, is = 0;
  const P = RULES.interval_penalty;
  for (const r of rows) {
    const L = r[arm + "_p10"], U = r[arm + "_p90"], y = r.real;
    w += U - L;
    if (y < L) { lo++; is += U - L + P * (L - y); }
    else if (y > U) { hi++; is += U - L + P * (y - U); }
    else is += U - L;
  }
  const n = rows.length;
  return { width: w / n, lower_miss: lo / n, upper_miss: hi / n, interval_score: is / n };
}
function tradeBlock(rows) {
  const n = rows.length;
  if (!n) return { n: 0, mae: null, regret: null, sign_accuracy: null, coverage: null, width: null, lower_miss: null, upper_miss: null, interval_score: null };
  const b2 = TB.block(asV1(rows, "v2")), b0 = TB.block(asV1(rows, "rho0"));
  const i2 = intervalStats(rows, "v2"), i0 = intervalStats(rows, "rho0");
  const arms = key => ({ v2: b2[key].sim, rho0: b0[key].sim, current: b2[key].current, naive: b2[key].naive });
  return { n, mae: arms("mae"), regret: arms("regret"), sign_accuracy: arms("sign_accuracy"),
           coverage: { v2: b2.coverage, rho0: b0.coverage },
           width: { v2: i2.width, rho0: i0.width }, lower_miss: { v2: i2.lower_miss, rho0: i0.lower_miss },
           upper_miss: { v2: i2.upper_miss, rho0: i0.upper_miss }, interval_score: { v2: i2.interval_score, rho0: i0.interval_score } };
}
// CHOICE 1: the pooled value of every leaf is the plain mean over origins; unknown in any origin -> unknown.
function equalOrigin(blocks) {
  const avg = xs => {
    if (xs.some(x => x === null || x === undefined)) return null;
    if (typeof xs[0] === "number") return xs.every(Number.isFinite) ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const o = {};
    for (const key of Object.keys(xs[0])) o[key] = avg(xs.map(x => x[key]));
    return o;
  };
  if (!blocks.length) return null;
  const out = {};
  out.n = blocks.reduce((t, b) => t + (b ? b.n : 0), 0);
  for (const key of Object.keys(blocks[0]).filter(x => x !== "n")) out[key] = avg(blocks.map(b => b[key]));
  return out;
}
function diffsOf(b) {
  const d = (key, cmp) => (b && b[key] && fin(b[key].v2) !== null && fin(b[key][cmp]) !== null ? b[key].v2 - b[key][cmp] : null);
  return { mae_current: d("mae", "current"), regret_current: d("regret", "current"), mae_naive: d("mae", "naive"), regret_naive: d("regret", "naive") };
}
function tradeMetrics(rows, origins, strata = RULES.strata) {
  const by_origin = {}, by_origin_stratum = {};
  for (const O of origins) {
    const rs = rows.filter(r => r.origin === O);
    by_origin[O] = tradeBlock(rs);
    by_origin_stratum[O] = Object.fromEntries(strata.map(s => [s, tradeBlock(rs.filter(r => r.strata.includes(s)))]));
  }
  const pooled = equalOrigin(origins.map(O => by_origin[O]));
  const pooled_by_stratum = Object.fromEntries(strata.map(s => [s, equalOrigin(origins.map(O => by_origin_stratum[O][s]))]));
  return { pooled, by_origin, by_origin_stratum, pooled_by_stratum,
           differences: { pooled: diffsOf(pooled), by_origin: Object.fromEntries(origins.map(O => [O, diffsOf(by_origin[O])])) } };
}
function waiverBlock(rows) {
  const w2 = TB.waiverMetrics(rows.map(r => ({ regret: { sim: r.regret.v2, current: r.regret.current, naive: r.regret.naive } })));
  const w0 = TB.waiverMetrics(rows.map(r => ({ regret: { sim: r.regret.rho0, current: r.regret.current, naive: r.regret.naive } })));
  if (!rows.length) return { n: 0, mean_regret: null, zero_regret_share: null };
  const arms = (a, b) => ({ v2: a.sim, rho0: b.sim, current: a.current, naive: a.naive });
  return { n: rows.length, mean_regret: arms(w2.mean_regret, w0.mean_regret), zero_regret_share: arms(w2.zero_regret_share, w0.zero_regret_share) };
}
function waiverMetricsAll(rows, origins) {
  const by_origin = Object.fromEntries(origins.map(O => [O, waiverBlock(rows.filter(r => r.origin === O))]));
  const pooled = equalOrigin(origins.map(O => by_origin[O]));
  const d = b => (b && b.mean_regret ? { regret_current: b.mean_regret.v2 - b.mean_regret.current, regret_naive: b.mean_regret.v2 - b.mean_regret.naive } : null);
  return { pooled, by_origin, differences: { pooled: d(pooled), by_origin: Object.fromEntries(origins.map(O => [O, d(by_origin[O])])) } };
}

/* ============================================================================================================
   Inference: paired resampling of whole draft seeds (§6.3), indices generated once and shared.
   ============================================================================================================ */
function resampleIndices(C, B = RULES.bootstrap_B, seed = RULES.bootstrap_seed) {
  if (!Number.isInteger(C) || C < 1) throw new BacktestError(`resampleIndices: need at least one draft seed, got ${C}`);
  const rand = TB.mulberry32(TB.hashStr(seed));
  const idx = new Uint32Array(B * C);
  for (let i = 0; i < B * C; i++) idx[i] = Math.floor(rand() * C);
  return { B, C, seed, idx };
}
// A bound is computed only when the statistic is defined in EVERY resample; otherwise it is unknown (fails its check).
const quant = (vals, q, B) => { if (!vals.length || vals.length !== B) return null; const s = Float64Array.from(vals).sort(); return fin(TB.percentile(s, q)); };
/* Per resample b: for each origin, sum each draft's per-origin totals over the C drawn drafts, divide by the
   drawn side count, then average over origins (CHOICE 1). `fields` names per-row additive quantities. */
function resampleStat(R, ks, origins, rows, fields, stats) {
  const C = ks.length, O = origins.length, F = fields.length + 1;
  if (R.C !== C) throw new BacktestError(`resample indices are for ${R.C} draft seeds, the population has ${C}`);
  const kIx = new Map(ks.map((k, i) => [k, i]));
  const agg = new Float64Array(C * O * F);
  for (const r of rows) {
    const i = kIx.get(r.k), o = origins.indexOf(r.origin);
    if (i === undefined || o < 0) throw new BacktestError(`row of draft ${r.k} origin ${r.origin} is outside the declared population`);
    const base = (i * O + o) * F;
    agg[base] += 1;
    for (let f = 0; f < fields.length; f++) agg[base + 1 + f] += fields[f](r);
  }
  const out = stats.map(() => []);
  const sums = new Float64Array(O * F);
  for (let b = 0; b < R.B; b++) {
    sums.fill(0);
    for (let c = 0; c < C; c++) {
      const base = R.idx[b * C + c] * O * F;
      for (let x = 0; x < O * F; x++) sums[x] += agg[base + x];
    }
    stats.forEach((st, s) => { const v = st(sums, O, F); if (Number.isFinite(v)) out[s].push(v); });
  }
  return out;
}
// Equal-origin mean of (sum[a] - sum[b]) / sum[n] over origins; n at `nf`, a / b field indices (+1 for the count).
const eoDiff = (a, b, nf = 0) => (sums, O, F) => {
  let t = 0;
  for (let o = 0; o < O; o++) { const n = sums[o * F + nf]; if (!(n > 0)) return NaN; t += (sums[o * F + a] - sums[o * F + b]) / n; }
  return t / O;
};
function tradeBootstrap(rows, ks, origins, R, alpha, strata = RULES.strata) {
  const reg = TB.regretOf;
  const fields = [r => Math.abs(r.v2 - r.real), r => Math.abs(r.current - r.real), r => Math.abs(r.naive - r.real),
                  r => reg(r.v2, r.real), r => reg(r.current, r.real), r => reg(r.naive, r.real)];
  // per stratum: count, |v2 - y|, |current - y| restricted to the stratum
  for (const s of strata) fields.push(r => (r.strata.includes(s) ? 1 : 0), r => (r.strata.includes(s) ? Math.abs(r.v2 - r.real) : 0),
                                      r => (r.strata.includes(s) ? Math.abs(r.current - r.real) : 0));
  const stats = [eoDiff(1, 2), eoDiff(4, 5), eoDiff(1, 3), eoDiff(4, 6)];
  strata.forEach((s, i) => { const b = 7 + 3 * i; stats.push(eoDiff(b + 1, b + 2, b)); });
  const res = resampleStat(R, ks, origins, rows, fields, stats);
  const names = ["mae_current", "regret_current", "mae_naive", "regret_naive"];
  const [lo, hi] = RULES.stratum_interval;
  return {
    B: R.B, clusters: ks.length, level: 1 - alpha, alpha,
    upper: Object.fromEntries(names.map((nm, i) => [nm, quant(res[i], 1 - alpha, R.B)])),
    resamples_used: Object.fromEntries(names.map((nm, i) => [nm, res[i].length]).concat(strata.map((s, i) => [`stratum:${s}`, res[4 + i].length]))),
    stratum_interval: Object.fromEntries(strata.map((s, i) => {
      const a = quant(res[4 + i], lo, R.B), b = quant(res[4 + i], hi, R.B);
      return [s, a === null || b === null ? null : [a, b]];
    })),
  };
}
function waiverBootstrap(rows, ks, origins, R, alpha) {
  const fields = [r => r.regret.v2, r => r.regret.current, r => r.regret.naive];
  const res = resampleStat(R, ks, origins, rows, fields, [eoDiff(1, 2), eoDiff(1, 3)]);
  return { B: R.B, clusters: ks.length, level: 1 - alpha, alpha,
           upper: { regret_current: quant(res[0], 1 - alpha, R.B), regret_naive: quant(res[1], 1 - alpha, R.B) },
           resamples_used: { regret_current: res[0].length, regret_naive: res[1].length } };
}

/* ============================================================================================================
   §6.3 trade rules, one function per rule. ctx = {cells, m, boot, origins, strata}. Each returns its checks
   {rule, id, text, value, threshold, pass}; a missing or non-finite value fails its check (fail closed).
   ============================================================================================================ */
const inBand = v => fin(v) !== null && v >= RULES.coverage_band[0] && v <= RULES.coverage_band[1];
const nOf = b => (b && Number.isInteger(b.n) ? b.n : 0);
function rule1Complete(ctx) {        // every declared cell present and evaluated; >= 200 sides per origin x stratum
  const out = [
    { rule: 1, id: "cells:missing", text: "every declared cell present", value: ctx.cells.missing.length, threshold: 0, pass: ctx.cells.missing.length === 0 },
    { rule: 1, id: "cells:excluded", text: "every declared cell evaluated (none excluded)", value: ctx.cells.excluded.length, threshold: 0, pass: ctx.cells.excluded.length === 0 },
  ];
  for (const O of ctx.origins) for (const s of ctx.strata) {
    const v = nOf(ctx.m.by_origin_stratum[O] && ctx.m.by_origin_stratum[O][s]);
    out.push({ rule: 1, id: `sides:${O}:${s}`, text: `>= ${RULES.min_sides} trade sides at origin ${O}, stratum ${s}`, value: v, threshold: RULES.min_sides, pass: v >= RULES.min_sides });
  }
  return out;
}
function rule2Coverage(ctx) {        // observed 80% coverage in [0.70, 0.90] per origin, pooled, per origin x stratum
  const band = `[${RULES.coverage_band[0]}, ${RULES.coverage_band[1]}]`;
  const cov = b => (b && b.coverage ? b.coverage.v2 : null);
  const out = ctx.origins.map(O => ({ rule: 2, id: `coverage:${O}`, text: `v2 80% coverage at origin ${O} in ${band}`,
                                       value: cov(ctx.m.by_origin[O]), threshold: RULES.coverage_band, pass: inBand(cov(ctx.m.by_origin[O])) }));
  out.push({ rule: 2, id: "coverage:pooled", text: `v2 80% coverage pooled (equal-origin) in ${band}`, value: cov(ctx.m.pooled), threshold: RULES.coverage_band, pass: inBand(cov(ctx.m.pooled)) });
  for (const O of ctx.origins) for (const s of ctx.strata) {
    const v = cov(ctx.m.by_origin_stratum[O] && ctx.m.by_origin_stratum[O][s]);
    out.push({ rule: 2, id: `coverage:${O}:${s}`, text: `v2 80% coverage at origin ${O}, stratum ${s} in ${band}`, value: v, threshold: RULES.coverage_band, pass: inBand(v) });
  }
  return out;
}
function rule3IntervalScore(ctx) {   // pooled interval score of v2 below the rho = 0 arm's
  const is = ctx.m.pooled && ctx.m.pooled.interval_score;
  const a = is ? fin(is.v2) : null, b = is ? fin(is.rho0) : null;
  return [{ rule: 3, id: "interval_score:pooled", text: "pooled 80% interval score: v2 < rho = 0", value: [a, b], threshold: "v2 < rho0", pass: a !== null && b !== null && a < b }];
}
function rule4NonInferiority(ctx) {  // one-sided upper bounds of pooled (v2 - current) MAE and regret < +1.0
  return ["mae_current", "regret_current"].map(k => {
    const v = fin(ctx.boot.upper[k]);
    return { rule: 4, id: `upper:${k}`, text: `upper bound of pooled (v2 - current) ${k.split("_")[0]} < +${RULES.margin_current}`, value: v, threshold: RULES.margin_current, pass: v !== null && v < RULES.margin_current };
  });
}
function rule5SuperiorityNaive(ctx) { // the same bounds of (v2 - naive) MAE and regret < 0
  return ["mae_naive", "regret_naive"].map(k => {
    const v = fin(ctx.boot.upper[k]);
    return { rule: 5, id: `upper:${k}`, text: `upper bound of pooled (v2 - naive) ${k.split("_")[0]} < ${RULES.margin_naive}`, value: v, threshold: RULES.margin_naive, pass: v !== null && v < RULES.margin_naive };
  });
}
function rule6PerOrigin(ctx) {       // per origin: observed (v2 - current) <= +1.0, (v2 - naive) <= 0, MAE and regret
  const out = [];
  for (const O of ctx.origins) {
    const d = diffsOf(ctx.m.by_origin[O]);
    for (const [k, lim] of [["mae_current", RULES.margin_current], ["regret_current", RULES.margin_current], ["mae_naive", RULES.margin_naive], ["regret_naive", RULES.margin_naive]]) {
      const v = d[k];
      out.push({ rule: 6, id: `observed:${O}:${k}`, text: `observed (v2 - ${k.split("_")[1]}) ${k.split("_")[0]} at origin ${O} <= ${lim}`, value: v, threshold: lim, pass: v !== null && v <= lim });
    }
  }
  return out;
}
function rule7StratumHarm(ctx) {     // no stratum's (v2 - current) MAE interval entirely above +1.0
  return ctx.strata.map(s => {
    const iv = ctx.boot.stratum_interval[s];
    const ok = Array.isArray(iv) && iv.length === 2 && iv.every(x => fin(x) !== null);
    return { rule: 7, id: `stratum:${s}`, text: `stratum ${s}: (v2 - current) MAE interval not entirely above +${RULES.margin_current}`, value: iv || null, threshold: RULES.margin_current, pass: ok && !(iv[0] > RULES.margin_current) };
  });
}
const TRADE_RULES = [rule1Complete, rule2Coverage, rule3IntervalScore, rule4NonInferiority, rule5SuperiorityNaive, rule6PerOrigin, rule7StratumHarm];

/* §6.4 waiver rules. ctx = {cells, wm, wboot, origins}. */
function waiverRule1Complete(ctx) {
  const out = [
    { rule: 1, id: "cells:missing", text: "every declared cell present", value: ctx.cells.missing.length, threshold: 0, pass: ctx.cells.missing.length === 0 },
    { rule: 1, id: "cells:excluded", text: "every declared cell evaluated (none excluded)", value: ctx.cells.excluded.length, threshold: 0, pass: ctx.cells.excluded.length === 0 },
  ];
  for (const O of ctx.origins) {
    const v = nOf(ctx.wm.by_origin[O]);
    out.push({ rule: 1, id: `decisions:${O}`, text: `waiver decisions present at origin ${O}`, value: v, threshold: 1, pass: v > 0 });
  }
  return out;
}
const waiverBound = (rule, k, what) => ctx => {
  const v = fin(ctx.wboot.upper[k]);
  return [{ rule, id: `upper:${k}`, text: `upper bound of pooled (v2 - ${what}) drop regret < 0`, value: v, threshold: 0, pass: v !== null && v < 0 }];
};
const WAIVER_RULES = [waiverRule1Complete, waiverBound(2, "regret_current", "current"), waiverBound(3, "regret_naive", "naive")];

function statusOf(primary, contingency, checks) {
  if (primary !== true || contingency) return "exploratory";
  const failed = new Set(checks.filter(c => !c.pass).map(c => c.rule));
  if (failed.has(1)) return "inconclusive";
  return failed.size ? "conditional_fail" : "conditional_pass";
}
const failedRulesOf = checks => [...new Set(checks.filter(c => !c.pass).map(c => c.rule))].sort((a, b) => a - b);

/* ============================================================================================================
   Reporting (spec §6.5; never a verdict input).
   ============================================================================================================ */
const hasPair = teams => Array.isArray(teams) && teams.some((t, i) => t && teams.indexOf(t) !== i);
function concentration(rows, origins) {
  const moved = r => (r.give || []).concat(r.receive || []);
  const teamsOf = r => [...new Set((r.give_teams || []).concat(r.receive_teams || []).filter(Boolean))];
  const top = (countOf, keyOf) => {
    const exp = new Map();
    for (const r of rows) for (const x of keyOf(r)) exp.set(x, (exp.get(x) || 0) + countOf);
    return [...exp].sort((a, b) => b[1] - a[1] || byId(a[0], b[0])).slice(0, 10).map(([id, exposure]) => ({ id, exposure }));
  };
  const players = top(1, r => [...new Set(moved(r))]), teams = top(1, teamsOf);
  const pSet = new Set(players.map(p => p.id)), tSet = new Set(teams.map(t => t.id));
  const keepP = rows.filter(r => !moved(r).some(id => pSet.has(id))), keepT = rows.filter(r => !teamsOf(r).some(t => tSet.has(t)));
  const summary = rs => { const m = tradeMetrics(rs, origins); return { pooled: m.pooled, differences: m.differences.pooled }; };
  return { definition: "exposure = trade sides whose trade moves the player (team: moves a player of the team), both origins together; drop every side of every trade touching a top-10 id",
           drop_players: Object.assign({ dropped_players: players, sides_dropped: rows.length - keepP.length }, summary(keepP)),
           drop_teams: Object.assign({ dropped_teams: teams, sides_dropped: rows.length - keepT.length }, summary(keepT)) };
}

/* One format's two verdicts. Pure in its inputs. R = the shared resample indices. */
function evaluateFormat({ primary, contingency = false, rows, waiverRows, cells, origins, ks, R, M, strata = RULES.strata }) {
  if (M !== RULES.primary_M) throw new BacktestError(`M = ${M} primary formats; the protocol declares exactly ${RULES.primary_M}`);
  const aT = alphaTrade(M), aW = alphaWaiver(M);
  const m = tradeMetrics(rows, origins, strata);
  const boot = tradeBootstrap(rows, ks, origins, R, aT, strata);
  const checks = TRADE_RULES.flatMap(f => f({ cells, m, boot, origins, strata }));
  const stackRows = rows.filter(r => hasPair(r.give_teams) || hasPair(r.receive_teams));
  const stackM = tradeMetrics(stackRows, origins, strata);
  const trade = {
    status: statusOf(primary, contingency, checks), failed_rules: failedRulesOf(checks), checks, metrics: m, bootstrap: boot,
    reporting: {
      superiority_over_current: { mae_upper: boot.upper.mae_current, regret_upper: boot.upper.regret_current,
                                  superior_mae: fin(boot.upper.mae_current) !== null && boot.upper.mae_current < 0,
                                  superior_regret: fin(boot.upper.regret_current) !== null && boot.upper.regret_current < 0,
                                  note: "reported, not required (spec §6.3)" },
      stacks: { definition: "a side giving, or receiving, two players of one NFL team", n: stackRows.length, pooled: stackM.pooled, by_origin: stackM.by_origin, differences: stackM.differences },
      concentration: concentration(rows, origins),
    },
  };
  const wm = waiverMetricsAll(waiverRows, origins);
  const wboot = waiverBootstrap(waiverRows, ks, origins, R, aW);
  const wchecks = WAIVER_RULES.flatMap(f => f({ cells, wm, wboot, origins }));
  const waiver = { status: statusOf(primary, contingency, wchecks), failed_rules: failedRulesOf(wchecks), checks: wchecks, metrics: wm, bootstrap: wboot };
  return { trade, waiver };
}

/* ============================================================================================================
   Cells: one (format, origin, draft k), evaluated through trade_backtest.runCell twice (v2 and rho = 0).
   ============================================================================================================ */
const readJson = p => JSON.parse(fs.readFileSync(p, "utf8"));
const cache = new Map();
function cached(p) { if (!cache.has(p)) cache.set(p, readJson(p)); return cache.get(p); }
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Key-order-insensitive equality (compat maps written by different tools).
const canon = x => (Array.isArray(x) ? x.map(canon) : x && typeof x === "object" ? Object.keys(x).sort().map(k => [k, canon(x[k])]) : x);
const sameCanon = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const sortedCopy = xs => xs.slice().sort(byId);

function normalizedTags(file) {
  const t = cached(file);
  const out = {};
  for (const [id, v] of Object.entries(t.tags || {})) { const n = RS.normalizeTag(v); if (n) out[id] = n; }
  return out;
}
function evaluateCell(spec) {
  const { key, label, origin, k, season } = spec;
  const head = { key, label, origin, k };
  const gap = (status, reason) => Object.assign(head, { status, reason, rows: [], waiver_rows: [], n_trades: 0 });
  if (!spec.listed) return gap("missing", "not listed in decisions/cells.json");
  const dec = cached(spec.decisionsFile);
  const draft = dec.drafts.find(d => d.k === k);
  if (!draft) return gap("missing", `no draft ${k} in the frozen decisions`);
  const frozenEx = (dec.excluded || []).find(e => e.k === k);
  if (frozenEx) return gap("excluded", `freeze: ${frozenEx.reason}`);
  const outcomes = cached(spec.outcomesFile);
  const actualWeeks = outcomes.actual_weeks && outcomes.actual_weeks[label];
  if (!actualWeeks || typeof actualWeeks !== "object") return gap("excluded", `no outcomes for format ${label}`);
  const fc = cached(spec.forecastFile);
  const av = cached(spec.availabilityFile);
  const availability = { p_out: av.p_out, p_stay: av.p_stay, p_tag: av.p_tag };
  const tags = normalizedTags(spec.tagsFile);
  const trades = dec.trades.filter(t => t.k === k);
  const base = { season, origin, k, rosters: draft.rosters, undrafted: draft.undrafted, forecasts: fc, actualWeeks, availability, tags,
                 slots: dec.slots, nSims: spec.nSims, simSeed: TB.hashStr(`sim:${season}:${origin}:${k}`), trades, waiver: true, diagnosticSims: 1 };
  const r2 = TB.runCell(Object.assign({}, base, { rho: spec.rhoTable }));
  const r0 = TB.runCell(Object.assign({}, base, { rho: RS.ZERO_RHO }));
  if (r2.excluded || r0.excluded) return gap("excluded", r2.excluded || r0.excluded);

  // CHOICE 6: the frozen decisions are authoritative; any divergence excludes the cell.
  const fail = reason => gap("excluded", `freeze consistency: ${reason}`);
  const { curPool: pool } = TB.probeArms(draft.undrafted, fc, fc.weeks, dec.slots);     // runCell already proved it fillable
  if (!dec.replacement_by_week || !sameJson(dec.replacement_by_week[k], pool)) return fail("trade replacement pool differs from replacement_by_week");
  const frozenW = dec.waiver.filter(w => w.k === k);
  if (frozenW.length !== draft.rosters.length) return fail(`${frozenW.length} frozen waiver entries for ${draft.rosters.length} teams`);
  for (const w of frozenW) {
    if (!sameJson(sortedCopy(w.adds), sortedCopy(r2.waiver_adds))) return fail(`team ${w.team} add set differs`);
    const ids = new Set();
    for (const byPos of Object.values(w.pool_by_week || {})) for (const list of Object.values(byPos)) for (const id of list) ids.add(id);
    if (!sameJson([...ids].sort(byId), r2.waiver_pool)) return fail(`team ${w.team} waiver pool differs`);
  }
  if (r2.rows.length !== 2 * trades.length || r0.rows.length !== r2.rows.length) return fail(`${r2.rows.length} side rows for ${trades.length} trades`);
  const byTrade = new Map(trades.map(t => [t.id, t]));
  const teamOf = id => (fc.players[id] && fc.players[id].team) || null;
  const rows = [];
  for (let i = 0; i < r2.rows.length; i++) {
    const a = r2.rows[i], b = r0.rows[i], t = byTrade.get(a.trade_id);
    if (!t) return fail(`row for unknown trade ${a.trade_id}`);
    if (b.trade_id !== a.trade_id || b.side !== a.side || b.real !== a.real || b.current !== a.current || b.naive !== a.naive) return fail(`v2 and rho = 0 runs disagree outside the simulation (${a.trade_id})`);
    if (!Array.isArray(t.strata) || !sameJson(sortedCopy(t.strata.filter(s => s !== "lopsided")), sortedCopy(a.strata))) return fail(`strata of ${a.trade_id} differ from the frozen ones`);
    const give = a.side === "a" ? t.give_a : t.give_b, receive = a.side === "a" ? t.give_b : t.give_a;
    rows.push({ k, origin, trade_id: a.trade_id, side: a.side, team: a.team, position: a.position, strata: t.strata.slice(),
                real: a.real, v2: a.sim, v2_p10: a.sim_p10, v2_p90: a.sim_p90, rho0: b.sim, rho0_p10: b.sim_p10, rho0_p90: b.sim_p90,
                current: a.current, naive: a.naive, give: give.slice(), receive: receive.slice(),
                give_teams: give.map(teamOf), receive_teams: receive.map(teamOf) });
  }
  if (r0.waiver_rows.length !== r2.waiver_rows.length) return fail("waiver rows differ between the v2 and rho = 0 runs");
  const waiver_rows = r2.waiver_rows.map((a, i) => {
    const b = r0.waiver_rows[i];
    if (b.team !== a.team || b.add !== a.add || b.regret.current !== a.regret.current || b.regret.naive !== a.regret.naive) return null;
    return { k, origin, team: a.team, add: a.add,
             choice: { v2: a.choice.sim, rho0: b.choice.sim, current: a.choice.current, naive: a.choice.naive },
             regret: { v2: a.regret.sim, rho0: b.regret.sim, current: a.regret.current, naive: a.regret.naive } };
  });
  if (waiver_rows.some(x => x === null)) return fail("waiver decisions disagree between the v2 and rho = 0 runs outside the simulation");
  return Object.assign(head, { status: "evaluated", reason: null, rows, waiver_rows, n_trades: trades.length });
}

/* ============================================================================================================
   The freeze.
   ============================================================================================================ */
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
const need = (p, what) => { if (!fs.existsSync(p)) throw new BacktestError(`missing ${what}: ${p}`); return p; };
function loadFreeze(freezeDir, rhoFile, outcomesFile, nSims) {
  const rhoBytes = fs.readFileSync(rhoFile);
  const rhoSha = sha256(rhoBytes);
  const rhoTable = Object.assign({}, TB.readRho(rhoFile));
  const rhoJson = JSON.parse(rhoBytes.toString("utf8"));
  const outcomes = cached(path.resolve(outcomesFile));
  if (outcomes.season !== RULES.season) throw new BacktestError(`${outcomesFile}: season ${outcomes.season}, expected ${RULES.season}`);
  if (!outcomes.actual_weeks || typeof outcomes.actual_weeks !== "object") throw new BacktestError(`${outcomesFile}: no actual_weeks`);

  const origins = RULES.origins.filter(O => fs.existsSync(path.join(freezeDir, `o${O}`, "decisions", "cells.json")));
  if (!origins.length) throw new BacktestError(`${freezeDir}: no origin freeze (o<O>/decisions/cells.json) found for origins ${RULES.origins.join(", ")}`);
  const contingency = !origins.includes(RULES.origins[0]);
  const inputs = {};
  const rel = p => path.relative(freezeDir, p).split(path.sep).join("/");
  const hashIn = p => { inputs[rel(p)] = sha256(fs.readFileSync(p)); return p; };
  const formats = {}, listed = new Map(), kSet = new Set();
  const perOrigin = {};
  for (const O of origins) {
    const od = path.join(freezeDir, `o${O}`);
    const frozenRho = need(path.join(od, "inputs", "rho.json"), "frozen rho table");
    if (sha256(fs.readFileSync(frozenRho)) !== rhoSha) throw new BacktestError(`--rho ${rhoFile} is not byte-identical to the frozen ${frozenRho}`);
    hashIn(frozenRho);
    perOrigin[O] = { availabilityFile: hashIn(need(path.join(od, "inputs", "availability.json"), "availability rates")),
                     tagsFile: hashIn(need(path.join(od, `tags_w${O - 1}.json`), `week-${O - 1} tags`)) };
    const tg = cached(perOrigin[O].tagsFile);
    if (tg.week !== undefined && tg.week !== O - 1) throw new BacktestError(`${perOrigin[O].tagsFile}: tags for week ${tg.week}, origin ${O} needs week ${O - 1}`);
    const cellsFile = hashIn(path.join(od, "decisions", "cells.json"));
    const cells = cached(cellsFile);
    if (!Array.isArray(cells)) throw new BacktestError(`${cellsFile}: not a cell list`);
    for (const c of cells) {
      if (typeof c.format !== "string" || !Number.isInteger(c.k) || c.origin !== O) throw new BacktestError(`${cellsFile}: bad cell ${JSON.stringify(c)}`);
      const key = `${c.format}|${RULES.season}|${O}|${c.k}`;
      if (c.key !== undefined && c.key !== key) throw new BacktestError(`${cellsFile}: cell key ${c.key}, expected ${key}`);
      if (listed.has(key)) throw new BacktestError(`${cellsFile}: duplicate cell ${key}`);
      listed.set(key, true); kSet.add(c.k);
      if (!formats[c.format]) formats[c.format] = { origins: {} };
      formats[c.format].origins[O] = true;
    }
  }
  const labels = Object.keys(formats).sort(byId);
  for (const label of labels) {
    const f = formats[label];
    for (const O of origins) {
      if (!f.origins[O]) throw new BacktestError(`format ${label} has no cells at origin ${O}: every origin must declare the same formats`);
      const od = path.join(freezeDir, `o${O}`);
      const decFile = hashIn(need(path.join(od, "decisions", `${label}.json`), `decisions for ${label}`));
      const fcFile = hashIn(need(path.join(od, `forecasts_${RULES.season}_o${O}_${label}.json`), `forecasts for ${label}`));
      const dec = cached(decFile), fc = cached(fcFile);
      if (dec.label !== label || dec.origin !== O || dec.season !== RULES.season) throw new BacktestError(`${decFile}: holds ${dec.label} / origin ${dec.origin} / season ${dec.season}`);
      if (typeof dec.primary !== "boolean") throw new BacktestError(`${decFile}: primary must be true or false`);
      for (const k of ["slots", "drafts", "trades", "waiver", "excluded"]) if (!Array.isArray(dec[k])) throw new BacktestError(`${decFile}: ${k} must be a list`);
      if (typeof dec.format_key !== "string" || !dec.compat || typeof dec.compat !== "object") throw new BacktestError(`${decFile}: no format_key / compat`);
      TB.checkForecastFile(fc, RULES.season, O, fcFile);
      if (fc.format_key !== undefined && fc.format_key !== dec.format_key) throw new BacktestError(`${fcFile}: format_key differs from the decisions'`);
      if (fc.compat !== undefined && !sameCanon(fc.compat, dec.compat)) throw new BacktestError(`${fcFile}: compat differs from the decisions'`);
      if (!sameJson(dec.weeks, fc.weeks)) throw new BacktestError(`${decFile}: weeks differ from the forecast file's`);
      for (const d of dec.drafts) if (!Array.isArray(d.rosters) || !Array.isArray(d.undrafted)) throw new BacktestError(`${decFile}: draft ${d.k} lacks rosters / undrafted`);
      if (f.primary === undefined) Object.assign(f, { primary: dec.primary, format_key: dec.format_key, compat: dec.compat, drafts: new Map(), lopsided_cutoff: {}, weeks: {}, files: {} });
      else if (f.primary !== dec.primary || f.format_key !== dec.format_key || !sameCanon(f.compat, dec.compat)) throw new BacktestError(`${label}: primary / format_key / compat differ between origins`);
      for (const d of dec.drafts) {
        const prev = f.drafts.get(d.k);
        if (prev && !(sameJson(prev.rosters, d.rosters) && sameJson(prev.undrafted, d.undrafted))) throw new BacktestError(`${label}: draft ${d.k} differs between origins (origin 9 must reuse origin 5's drafted rosters, §7.4)`);
        f.drafts.set(d.k, d);
      }
      f.lopsided_cutoff[O] = dec.lopsided_cutoff === undefined ? null : dec.lopsided_cutoff;
      f.weeks[O] = dec.weeks;
      f.files[O] = { decisionsFile: decFile, forecastFile: fcFile };
    }
  }
  const M = labels.filter(l => formats[l].primary).length;
  if (M !== RULES.primary_M) throw new BacktestError(`${M} primary formats in the freeze; the protocol declares exactly ${RULES.primary_M} (M in the multiplicity correction)`);
  const ks = [...kSet].sort((a, b) => a - b);
  const specs = [];
  for (const label of labels) for (const O of origins) for (const k of ks) {
    const key = `${label}|${RULES.season}|${O}|${k}`;
    specs.push(Object.assign({ key, label, origin: O, k, season: RULES.season, listed: listed.has(key), nSims, rhoTable,
                               outcomesFile: path.resolve(outcomesFile) }, formats[label].files[O], perOrigin[O]));
  }
  specs.sort((a, b) => byId(a.key, b.key));
  return { freezeDir, origins, contingency, labels, formats, ks, specs, M, inputs,
           rho: { table: rhoTable, sha256: rhoSha, support_violations: rhoJson.support_violations === undefined ? null : rhoJson.support_violations },
           outcomes_sha256: sha256(fs.readFileSync(outcomesFile)) };
}
function configHash(fz, nSims) {
  const code = {};
  for (const p of [__filename, path.join(__dirname, "trade_backtest.cjs"), path.join(__dirname, "..", "site", "assets", "rostersim.js"),
                   path.join(__dirname, "..", "site", "assets", "ros.js")]) code[path.basename(p)] = sha256(fs.readFileSync(p));
  return sha256(JSON.stringify({ rules: RULES, sims: nSims, inputs: fz.inputs, outcomes: fz.outcomes_sha256, rho: fz.rho.sha256, code }));
}
const isPredeclared = (fz, nSims) => nSims === RULES.sims && sameJson(fz.ks, Array.from({ length: RULES.drafts }, (_, i) => i));

/* ============================================================================================================
   Aggregation: cell results -> eval.json and sim_gates.json. Pure in its inputs (cells sorted by key).
   ============================================================================================================ */
function aggregate(fz, results, { nSims, generatedAt, configHash: ch }) {
  const byKey = new Map(results.map(r => [r.key, r]));
  const R = resampleIndices(fz.ks.length);          // generated once, shared by every format and both features
  const origins = fz.origins;
  const formats = {}, records = [];
  for (const label of fz.labels) {
    const f = fz.formats[label];
    const mine = fz.specs.filter(s => s.label === label).map(s => byKey.get(s.key));
    const cells = { declared: mine.length, evaluated: mine.filter(r => r.status === "evaluated").length,
                    missing: mine.filter(r => r.status === "missing").map(r => ({ key: r.key, reason: r.reason })),
                    excluded: mine.filter(r => r.status === "excluded").map(r => ({ key: r.key, reason: r.reason })),
                    short: mine.filter(r => r.status === "evaluated" && r.n_trades < RULES.trades_per_cell).map(r => ({ key: r.key, trades: r.n_trades })) };
    const rows = mine.flatMap(r => r.rows), wrows = mine.flatMap(r => r.waiver_rows);
    const ev = evaluateFormat({ primary: f.primary, contingency: fz.contingency, rows, waiverRows: wrows, cells, origins, ks: fz.ks, R, M: fz.M });
    const horizons = TB.horizonsOf(asV1(rows, "v2"), Object.fromEntries(origins.map(O => [O, f.lopsided_cutoff[O]])));
    const wHorizons = origins.map(O => { const b = ev.waiver.metrics.by_origin[O]; return { origin: O, weeks: LAST_WEEK - O + 1, n: b.n, mean_regret: b.mean_regret }; });
    formats[label] = { primary: f.primary, format_key: f.format_key, compat: f.compat, lopsided_cutoff: f.lopsided_cutoff, cells, horizons, trade: ev.trade, waiver: ev.waiver };
    records.push({ label, format_key: f.format_key, compat: f.compat, feature: "trade_grade", status: ev.trade.status, horizons });
    records.push({ label, format_key: f.format_key, compat: f.compat, feature: "waiver_sim", status: ev.waiver.status, horizons: wHorizons });
  }
  const evalOut = {
    schema_version: 1, generated_at: generatedAt, engine: "rostersim-v2", evidence: "2026 prospective, synthetic leagues",
    predeclared: isPredeclared(fz, nSims), contingency: fz.contingency, config_hash: ch,
    rules: RULES, M: fz.M, alpha: { trade: alphaTrade(fz.M), waiver: alphaWaiver(fz.M) }, sims: nSims,
    bootstrap: { B: R.B, seed: R.seed, clusters: fz.ks }, origins,
    rho: fz.rho, inputs: fz.inputs, outcomes_sha256: fz.outcomes_sha256,
    formats,
    reporting: { v1_per_season_coverage: V1_CONTEXT, support_violations: fz.rho.support_violations,
                 scope: "one realized NFL season: every synthetic league shares the same 2026 outcomes; bounds describe the draft generator conditional on that season (spec §6.3, §6.5)" },
  };
  const gates = { schema_version: 3, generated_at: generatedAt, engine: "rostersim-v2", rho_sha256: fz.rho.sha256,
                  evidence: "2026 prospective, synthetic leagues", origins: RULES.origins.slice(), horizon_rule: "nearest origin, ties to shorter", records };
  return { evalOut: TB.roundDeep(evalOut), gates: TB.roundDeep(gates) };
}

/* ============================================================================================================
   CLI.
   ============================================================================================================ */
function parseArgs(argv) {
  const a = { freeze: null, outcomes: null, rho: null, out: null, gatesOut: null, jobs: 1, shard: null, cellsOut: null, merge: null, sims: RULES.sims, generatedAt: null };
  const names = { "--freeze": "freeze", "--outcomes": "outcomes", "--rho": "rho", "--out": "out", "--gates-out": "gatesOut", "--jobs": "jobs",
                  "--shard": "shard", "--cells-out": "cellsOut", "--sims": "sims", "--generated-at": "generatedAt" };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--merge") { a.merge = []; while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) a.merge.push(argv[++i]); if (!a.merge.length) throw new BacktestError("--merge needs cell files"); continue; }
    if (!(f in names)) throw new BacktestError(`unknown argument ${f}`);
    if (i + 1 >= argv.length) throw new BacktestError(`${f} needs a value`);
    a[names[f]] = argv[++i];
  }
  for (const k of ["freeze", "outcomes", "rho"]) if (a[k] === null) throw new BacktestError(`--${k} is required`);
  a.jobs = Number(a.jobs); a.sims = Number(a.sims);
  if (!Number.isInteger(a.jobs) || a.jobs < 1) throw new BacktestError("--jobs must be a positive integer");
  if (!Number.isInteger(a.sims) || a.sims < 1) throw new BacktestError("--sims must be a positive integer");
  if (a.shard !== null) {
    const m = /^(\d+)\/(\d+)$/.exec(a.shard);
    if (!m || Number(m[2]) < 1 || Number(m[1]) >= Number(m[2])) throw new BacktestError(`--shard must be i/n with 0 <= i < n, got ${a.shard}`);
    a.shard = { i: Number(m[1]), n: Number(m[2]) };
    if (a.merge) throw new BacktestError("--shard and --merge cannot be combined");
    if (!a.cellsOut) throw new BacktestError("--shard needs --cells-out");
  } else {
    if (!a.out || !a.gatesOut) throw new BacktestError("--out and --gates-out are required (except with --shard)");
  }
  if (a.generatedAt !== null && Number.isNaN(Date.parse(a.generatedAt))) throw new BacktestError(`--generated-at is not a date: ${a.generatedAt}`);
  return a;
}
async function evaluateSpecs(specs, jobs) {
  const out = new Array(specs.length);
  const land = (i, r) => { out[i] = JSON.parse(JSON.stringify(r)); };       // what a shard file round-trip would give
  if (jobs > 1 && specs.length > 1) await TB.runCells(specs, jobs, land, { workerFile: __filename });
  else specs.forEach((s, i) => land(i, evaluateCell(s)));
  return out;
}
const CELLS_SCHEMA = "prospective-eval-cells/1";
function writeJsonFile(p, obj, pretty = false) {
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  fs.writeFileSync(p, pretty ? JSON.stringify(obj, null, 1) + "\n" : JSON.stringify(obj));
}
async function main(argv) {
  const a = parseArgs(argv);
  const fz = loadFreeze(path.resolve(a.freeze), a.rho, a.outcomes, a.sims);
  const ch = configHash(fz, a.sims);
  const predeclared = isPredeclared(fz, a.sims);
  if (a.gatesOut && !predeclared && TB.isInside(path.resolve(__dirname, "..", "site"), a.gatesOut)) {
    throw new BacktestError(`this run is not the predeclared configuration (sims ${RULES.sims}, drafts 0..${RULES.drafts - 1}); refusing to write the gate file ${a.gatesOut} under site/`);
  }
  let results;
  if (a.shard) {
    const mine = fz.specs.filter((s, j) => j % a.shard.n === a.shard.i);
    const res = await evaluateSpecs(mine, a.jobs);
    writeJsonFile(a.cellsOut, { schema: CELLS_SCHEMA, config_hash: ch, shard: `${a.shard.i}/${a.shard.n}`, cells: mine.map((s, j) => ({ key: s.key, result: res[j] })) });
    console.log(`shard ${a.shard.i}/${a.shard.n}: ${mine.length} of ${fz.specs.length} cells -> ${a.cellsOut}`);
    return;
  }
  if (a.merge) {
    const got = new Map();
    for (const file of a.merge) {
      const c = readJson(file);
      if (c.schema !== CELLS_SCHEMA) throw new BacktestError(`${file}: not a ${CELLS_SCHEMA} file`);
      if (c.config_hash !== ch) throw new BacktestError(`${file}: written for a different configuration (freeze, outcomes, rho, sims or code differ)`);
      for (const { key, result } of c.cells) {
        if (got.has(key)) throw new BacktestError(`duplicate cell ${key} (in ${file})`);
        got.set(key, result);
      }
    }
    const declared = new Set(fz.specs.map(s => s.key));
    const extra = [...got.keys()].filter(k => !declared.has(k));
    if (extra.length) throw new BacktestError(`unknown cell(s) not in the freeze: ${extra.slice(0, 5).join(", ")}`);
    const missing = fz.specs.filter(s => !got.has(s.key)).map(s => s.key);
    if (missing.length) throw new BacktestError(`missing cell(s) in the shard files: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5})` : ""}`);
    results = fz.specs.map(s => got.get(s.key));
  } else {
    results = await evaluateSpecs(fz.specs, a.jobs);
    if (a.cellsOut) writeJsonFile(a.cellsOut, { schema: CELLS_SCHEMA, config_hash: ch, shard: "0/1", cells: fz.specs.map((s, j) => ({ key: s.key, result: results[j] })) });
  }
  const { evalOut, gates } = aggregate(fz, results, { nSims: a.sims, generatedAt: a.generatedAt || new Date().toISOString(), configHash: ch });
  writeJsonFile(a.out, evalOut);
  writeJsonFile(a.gatesOut, gates, true);
  for (const r of gates.records) console.log(`[${r.label}] ${r.feature}: ${r.status}`);
  console.log(`wrote ${a.out}\nwrote ${a.gatesOut}${predeclared ? "" : "\n(NOT the predeclared configuration)"}`);
}

module.exports = { RULES, TRADE_RULES, WAIVER_RULES, alphaTrade, alphaWaiver, resampleIndices, tradeBlock, tradeMetrics, equalOrigin,
                   tradeBootstrap, waiverBootstrap, evaluateFormat, statusOf, evaluateCell, loadFreeze, aggregate, parseArgs, V1_CONTEXT };

const { isMainThread, parentPort, workerData } = require("worker_threads");
if (!isMainThread && workerData && workerData.role === "cell-worker" && workerData.file === __filename) {
  parentPort.on("message", ({ i, spec }) => {
    try { parentPort.postMessage({ i, result: evaluateCell(spec) }); }
    catch (e) { parentPort.postMessage({ i, error: (e && e.stack) || String(e) }); }
  });
} else if (require.main === module) {
  main(process.argv.slice(2)).catch(e => { console.error(`prospective_eval: ${e instanceof BacktestError ? e.message : (e && e.stack) || e}`); process.exit(2); });
}
