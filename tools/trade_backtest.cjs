// tools/trade_backtest.cjs — walk-forward trade backtest for the roster simulation.
//
//   node tools/trade_backtest.cjs --seasons 2023,2024,2025 --origins 5,9 --leagues 20 \
//        --trades 125 --sims 2000 --league site/data/draft.json \
//        [--secondary site/data/draft-fam.json] \
//        --out models/diagnostics/trade_sim_eval.json --site-out site/data/trade_sim_eval.json
//   optional: --jobs N (worker threads; results do not depend on it)
//             --forecasts-dir, --worlds-dir, --availability-dir (input locations)
//
// Spec 2026-09-24 §6 (predeclared). For each test season S, origin O and synthetic
// league k: draft the league with the shipped tools/draft_sim.cjs, sample a frozen
// set of trades BEFORE anything is predicted, then predict every trade side three
// ways -- the shipped simulation (site/assets/rostersim.js), today's p50 lineup-only
// method (site/assets/ros.js) and a naive four-game-mean lineup -- and score each
// against what actually happened, replayed without hindsight. The pass rule in
// `verdict` is spec §6.5 / plan refinement 5 verbatim; it is not a tuning knob.
//
// The shipped modules are `require`d, never copied: a port would test the copy.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const ROS = require(path.join(__dirname, "..", "site", "assets", "ros.js"));
const RS = require(path.join(__dirname, "..", "site", "assets", "rostersim.js"));

const POS = ["QB", "RB", "WR", "TE"];
const STRATA = ["same_position", "cross_position", "depth_for_starter", "lopsided"];
const PACKAGES = [[1, 1], [2, 1], [1, 2], [2, 2]];     // [a gives, b gives]
const METHODS = ["sim", "current", "naive"];
const LAST_WEEK = 17;
const WAIVER_ADDS = 10;
const BOOTSTRAP_B = 2000;
const LABEL_K = 2;                                      // plan refinement 5: k = 2, fixed
const COVERAGE_BAND = [0.70, 0.90];
const PREDECLARED = { seasons: [2023, 2024, 2025], origins: [5, 9], leagues: 20, trades: 125, sims: 2000, bootstrap: BOOTSTRAP_B };
const REPL_OFFSET = 1e9;   // replacement candidates rank below every rostered player (as rostersim.js does)

class BacktestError extends Error { constructor(m) { super(m); this.name = "BacktestError"; } }

// --- deterministic randomness -------------------------------------------------
// The same generator and string hash rostersim.js uses internally (it does not
// export them). These only drive trade sampling and the bootstrap; every
// simulated draw comes from the shipped engine itself.
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }

// --- forecast access ----------------------------------------------------------
const byId = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
function rowOf(forecasts, id, w) { const p = forecasts.players[id]; return p && p.weeks ? p.weeks[w] : undefined; }
function validPlay(r) {
  return r && r.status === "play" && [r.p10, r.p50, r.p90].every(Number.isFinite) && r.p10 <= r.p50 && r.p50 <= r.p90;
}
// Frozen p50 when the player has a usable `play` row that week; null otherwise
// (bye, no row, bad row): null means "cannot start", never "starts for 0".
function p50Of(forecasts, id, w) { const r = rowOf(forecasts, id, w); return validPlay(r) ? r.p50 : null; }
function positionOf(forecasts, id) { const p = forecasts.players[id]; return p ? p.position : undefined; }
// A player the simulation can value: a skill position and a play/bye row for
// every week origin..17 (the engine throws on anything less -- unknown is not zero).
function isCovered(id, forecasts, weeks = forecasts.weeks) {
  const p = forecasts.players[id];
  if (!p || !POS.includes(p.position) || !p.weeks) return false;
  return weeks.every(w => { const r = p.weeks[w]; return r && (r.status === "bye" || validPlay(r)); });
}
function meanP50(id, forecasts, weeks = forecasts.weeks) {
  let s = 0, n = 0;
  for (const w of weeks) { const v = p50Of(forecasts, id, w); if (v !== null) { s += v; n++; } }
  return n ? s / n : -Infinity;
}

// --- trades -------------------------------------------------------------------
function afterRoster(roster, give, get, drop) {
  return roster.filter(id => !give.includes(id) && !drop.includes(id)).concat(get);
}
// Overflow: a side that gains n players drops its n lowest mean-p50 players who
// are not involved in the trade (ties by id, so the rule is deterministic).
function overflowDrop(roster, give, gain, forecasts) {
  if (gain <= 0) return [];
  return roster.filter(id => !give.includes(id))
    .map(id => ({ id, m: meanP50(id, forecasts) }))
    .sort((x, y) => x.m - y.m || byId(x.id, y.id))
    .slice(0, gain).map(x => x.id);
}
function drawK(list, k, rand) {
  const a = list.slice();
  for (let i = 0; i < k; i++) { const j = i + Math.floor(rand() * (a.length - i)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a.slice(0, k);
}
/* Rule 3. `forecasts` is a forecast file ({weeks, players}); only its rows are
   read -- never an outcome, never a prediction -- so the sample cannot depend on
   anything a method later says. Tradable players have a play/bye row for every
   week origin..17. Stops at `count` distinct trades (or after a bounded number
   of attempts if the league cannot supply that many). */
function sampleTrades(rosters, forecasts, rand, count) {
  if (!Array.isArray(rosters) || rosters.length < 2) throw new BacktestError("sampleTrades needs at least two rosters");
  const T = rosters.length;
  const eligible = rosters.map(r => r.filter(id => isCovered(id, forecasts)).sort(byId));
  const out = [], seen = new Set();
  const maxAttempts = 200 * count + 1000;
  for (let attempts = 0; out.length < count && attempts < maxAttempts; attempts++) {
    const a = Math.floor(rand() * T);
    let b = Math.floor(rand() * (T - 1)); if (b >= a) b++;
    const [na, nb] = PACKAGES[Math.floor(rand() * PACKAGES.length)];
    if (eligible[a].length < na || eligible[b].length < nb) continue;
    const giveA = drawK(eligible[a], na, rand), giveB = drawK(eligible[b], nb, rand);
    const sa = giveA.slice().sort(byId), sb = giveB.slice().sort(byId);
    const key = JSON.stringify(a < b ? [a, sa, b, sb] : [b, sb, a, sa]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b, package: `${na}-${nb}`, give_a: giveA, give_b: giveB,
               drop_a: overflowDrop(rosters[a], giveA, nb - na, forecasts),
               drop_b: overflowDrop(rosters[b], giveB, na - nb, forecasts) });
  }
  return out;
}

// --- lineup-only prediction (today's ros.js method, and the naive comparator) --
/* For each roster (an array of ids): each week, the best legal lineup by
   projOf(id, w) among rostered players whose projection is known (null = bye /
   cannot start); a slot the roster cannot fill takes the best replacementOf(w)
   candidate ({id, position, score}). Returns [{total, perWeek, starts}]; starts
   counts each rostered player's weeks in the lineup (depth_for_starter). */
function predictLineupOnly(rosters, projOf, weeks, slots, replacementOf, posOf) {
  return rosters.map(roster => {
    const ids = roster.slice().sort(byId);
    const perWeek = [], starts = {};
    let total = 0;
    for (const w of weeks) {
      const cands = [];
      for (const id of ids) { const v = projOf(id, w); if (v !== null && v !== undefined && Number.isFinite(v)) cands.push({ id, position: posOf(id), score: v, pts: v }); }
      for (const r of replacementOf(w) || []) cands.push({ id: r.id, position: r.position, score: r.score - REPL_OFFSET, pts: r.score, repl: true });
      const lu = ROS.bestLineup(cands, slots, c => c.score);
      if (!lu.starters.length) throw new BacktestError(`no replacement available for ${lu.unfillable} in week ${w}`);
      let t = 0;
      for (const st of lu.starters) { t += st.player.pts; if (!st.player.repl) starts[st.player.id] = (starts[st.player.id] || 0) + 1; }
      perWeek.push(t); total += t;
    }
    return { total, perWeek, starts };
  });
}
// The slot-sized replacement pool (controller note): per week and position, the
// top (dedicated + FLEX [+ SUPER_FLEX]) undrafted players by scoreOf among those
// with a `play` row that week. Bye-week players are never candidates.
function poolSizes(slots) {
  const n = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPER_FLEX: 0 };
  for (const s of slots) { if (!(s in n)) throw new BacktestError(`unsupported slot ${s}`); n[s]++; }
  const flexEligible = ROS.SLOT_ELIGIBLE.FLEX;
  const size = {};
  for (const pos of POS) size[pos] = n[pos] + (flexEligible.includes(pos) ? n.FLEX : 0) + n.SUPER_FLEX;
  return size;
}
function replacementPool(undrafted, forecasts, weeks, slots, scoreOf) {
  const size = poolSizes(slots), pool = {};
  const ids = undrafted.slice().sort(byId);
  for (const w of weeks) {
    pool[w] = {};
    for (const pos of POS) {
      pool[w][pos] = ids.filter(id => positionOf(forecasts, id) === pos && validPlay(rowOf(forecasts, id, w)))
        .map(id => ({ id, s: scoreOf(id, w) }))
        .filter(x => x.s !== null && x.s !== undefined && Number.isFinite(x.s))
        .sort((x, y) => y.s - x.s || byId(x.id, y.id))
        .slice(0, size[pos]).map(x => x.id);
    }
  }
  return pool;
}

// --- realized (rule 6) ----------------------------------------------------------
const actualOf = (actualWeeks, id, w) => { const a = actualWeeks[id]; const v = a ? a[String(w)] : undefined; return Number.isFinite(v) ? v : null; };
/* Each week: the lineup is chosen by FROZEN p50 among roster players who have an
   actual_weeks entry that week and a forecast play row that week (a player
   without a forecast that week cannot start); an unfilled slot takes the
   undrafted player with the best frozen p50 who has an actual entry. Score =
   actual points. The choice never looks at the outcome: no hindsight. */
function realizedRoster(roster, forecasts, actualWeeks, undrafted, weeks, slots) {
  const ids = roster.slice().sort(byId), und = undrafted.slice().sort(byId);
  const perWeek = []; let total = 0;
  for (const w of weeks) {
    const cands = [];
    for (const id of ids) {
      const p = p50Of(forecasts, id, w), a = actualOf(actualWeeks, id, w);
      if (p !== null && a !== null) cands.push({ id, position: positionOf(forecasts, id), score: p, pts: a });
    }
    for (const id of und) {
      const p = p50Of(forecasts, id, w), a = actualOf(actualWeeks, id, w);
      if (p !== null && a !== null) cands.push({ id, position: positionOf(forecasts, id), score: p - REPL_OFFSET, pts: a });
    }
    const lu = ROS.bestLineup(cands, slots, c => c.score);
    if (!lu.starters.length) throw new BacktestError(`realized: no undrafted replacement played at ${lu.unfillable} in week ${w}`);
    let t = 0; for (const st of lu.starters) t += st.player.pts;
    perWeek.push(t); total += t;
  }
  return { total, perWeek };
}
function tradeSides(rosters, trade) {
  return {
    a: { before: rosters[trade.a], after: afterRoster(rosters[trade.a], trade.give_a, trade.give_b, trade.drop_a), received: trade.give_b },
    b: { before: rosters[trade.b], after: afterRoster(rosters[trade.b], trade.give_b, trade.give_a, trade.drop_b), received: trade.give_a },
  };
}
function realized(rosters, trade, forecasts, actualWeeks, undrafted, weeks, slots) {
  const sides = tradeSides(rosters, trade), out = {};
  for (const s of ["a", "b"]) {
    const before = realizedRoster(sides[s].before, forecasts, actualWeeks, undrafted, weeks, slots).total;
    const after = realizedRoster(sides[s].after, forecasts, actualWeeks, undrafted, weeks, slots).total;
    out[s] = { before, after, delta: after - before };
  }
  return out;
}

// --- simulation (the shipped engine) --------------------------------------------
function buildSimWorld({ forecasts, ids, undrafted, weeks, slots, availability, tags, nSims, seed }) {
  const players = {};
  for (const id of ids) {
    const p = forecasts.players[id];
    players[id] = { position: p.position, weeks: p.weeks };
    const tag = tags && tags[id];
    if (tag) players[id].tag = tag;
  }
  const pool = replacementPool(undrafted, forecasts, weeks, slots, (id, w) => p50Of(forecasts, id, w));
  const replacement = {};
  for (const w of weeks) {
    replacement[w] = {};
    for (const pos of POS) replacement[w][pos] = pool[w][pos].map(id => { const r = rowOf(forecasts, id, w); return { p10: r.p10, p50: r.p50, p90: r.p90 }; });
  }
  const A = { p_out: availability.p_out, p_stay: availability.p_stay, p_tag: availability.p_tag };
  return RS.createWorld({ weeks, slots, players, availability: A, replacement, nSims, seed });
}
function predictSim(world, beforeIds, afterIds) { return RS.compare(world, beforeIds, afterIds); }

// --- one (season, origin, league) cell ------------------------------------------
/* Everything for one synthetic league at one origin, given trades sampled
   beforehand. One simulation world holds every covered drafted player plus the
   waiver adds, so the value() cache is shared and all variants use common
   random numbers. A week that no replacement pool can fill excludes the whole
   cell (recorded), rather than crashing the run or silently shortening it. */
function runCell(opts) {
  const { season, origin, k, rosters, undrafted, forecasts, actualWeeks, availability, tags, slots, nSims, simSeed,
          trades, waiver = false, waiverAdds = WAIVER_ADDS } = opts;
  const weeks = forecasts.weeks, W = weeks.length;
  const cluster = `${season}:${origin}:${k}`;
  const t0 = Date.now();
  const drafted = rosters.flat();
  const covered = new Set(drafted.filter(id => isCovered(id, forecasts)));
  const anyRow = id => weeks.some(w => rowOf(forecasts, id, w));
  const result = { season, origin, k, cluster, excluded: null, rows: [], waiver_rows: [],
                   uncovered_rostered: drafted.filter(id => !covered.has(id)).length,
                   partial_rostered: drafted.filter(id => !covered.has(id) && anyRow(id)).length,
                   null_baseline_rostered: drafted.filter(id => covered.has(id) && !Number.isFinite(forecasts.players[id].baseline)).length };
  const posOf = id => positionOf(forecasts, id);
  const curProj = (id, w) => p50Of(forecasts, id, w);
  const naiveProj = (id, w) => { if (p50Of(forecasts, id, w) === null) return null; const b = forecasts.players[id].baseline; return Number.isFinite(b) ? b : null; };
  const curPool = replacementPool(undrafted, forecasts, weeks, slots, curProj);
  const naivePool = replacementPool(undrafted, forecasts, weeks, slots, naiveProj);
  const replOf = (pool, proj, exclude) => w => {
    const list = [];
    for (const pos of POS) for (const id of pool[w][pos]) if (id !== exclude) list.push({ id, position: pos, score: proj(id, w) });
    return list;
  };
  const cov = r => r.filter(id => covered.has(id));
  const lineup = (roster, proj, pool, exclude) => predictLineupOnly([cov(roster)], proj, weeks, slots, replOf(pool, proj, exclude), posOf)[0];

  // Waiver adds: the undrafted players with the highest mean frozen p50 who the
  // simulation can value (full coverage).
  const adds = waiver ? undrafted.filter(id => isCovered(id, forecasts)).sort((x, y) => meanP50(y, forecasts) - meanP50(x, forecasts) || byId(x, y)).slice(0, waiverAdds) : [];

  let world;
  try {
    // Upfront fill checks for every method, so no roster can hit an unfillable week later.
    for (const w of weeks) {
      for (const [label, pool] of [["current", curPool], ["naive", naivePool]]) {
        const probe = POS.flatMap(pos => pool[w][pos].map(id => ({ position: pos })));
        const lu = ROS.bestLineup(probe, slots, () => 0);
        if (!lu.starters.length) throw new BacktestError(`${label}: no replacement available for ${lu.unfillable} in week ${w}`);
      }
    }
    world = buildSimWorld({ forecasts, ids: [...covered].sort(byId).concat(adds), undrafted, weeks, slots, availability, tags, nSims, seed: simSeed });
  } catch (e) {
    if (!(e instanceof BacktestError || e instanceof RS.RosterSimError)) throw e;
    result.excluded = e.message;
    result.runtime_s = (Date.now() - t0) / 1000;
    return result;
  }

  try {
    tradeAndWaiverRows();
  } catch (e) {
    if (!(e instanceof BacktestError || e instanceof RS.RosterSimError)) throw e;
    // e.g. realized: no undrafted player at a position played that week. The
    // cell is excluded whole (recorded), never scored on a partial set.
    result.excluded = e.message; result.rows = []; result.waiver_rows = [];
  }
  result.runtime_s = (Date.now() - t0) / 1000;
  return result;

  function tradeAndWaiverRows() {
  for (const trade of trades) {
    const sides = tradeSides(rosters, trade);
    const real = realized(rosters, trade, forecasts, actualWeeks, undrafted, weeks, slots);
    const moved = trade.give_a.concat(trade.give_b);
    const samePos = moved.every(id => posOf(id) === posOf(moved[0]));
    const pred = {};
    let depth = false;
    for (const s of ["a", "b"]) {
      const before = cov(sides[s].before), after = cov(sides[s].after);
      const sim = predictSim(world, before, after);
      const cb = lineup(sides[s].before, curProj, curPool), ca = lineup(sides[s].after, curProj, curPool);
      const nb = lineup(sides[s].before, naiveProj, naivePool), na = lineup(sides[s].after, naiveProj, naivePool);
      for (const id of sides[s].received) if (2 * (ca.starts[id] || 0) < W) depth = true;
      pred[s] = { sim, current: ca.total - cb.total, naive: na.total - nb.total };
    }
    const strata = [samePos ? "same_position" : "cross_position"];
    if (depth) strata.push("depth_for_starter");
    for (const s of ["a", "b"]) {
      result.rows.push({ cluster, trade_id: trade.id, side: s, team: s === "a" ? trade.a : trade.b,
                         position: posOf(sides[s].received[0]), strata: strata.slice(),
                         real: real[s].delta, sim: pred[s].sim.mean, sim_p10: pred[s].sim.p10, sim_p90: pred[s].sim.p90,
                         sim_p_positive: pred[s].sim.pPositive, current: pred[s].current, naive: pred[s].naive });
    }
  }

  // Waiver drop decisions (rule 9, second part). Candidates to drop: the roster's
  // covered players (the ones every method can value). The added player is kept
  // out of the lineup-only and realized replacement pools; the simulation world's
  // replacement pool is shared per cell and cannot exclude him (recorded limitation).
  const undraftedSet = undrafted;
  for (let team = 0; team < rosters.length && waiver; team++) {
    const full = rosters[team], drops = cov(full).sort(byId);
    for (const add of adds) {
      const und = undraftedSet.filter(id => id !== add);
      const cand = drops.map(d => {
        const afterFull = full.filter(id => id !== d).concat([add]);
        const afterCov = cov(full).filter(id => id !== d).concat([add]);
        return { d, m: meanP50(d, forecasts),
                 sim: world.value(afterCov).mean,
                 current: predictLineupOnly([afterCov], curProj, weeks, slots, replOf(curPool, curProj, add), posOf)[0].total,
                 naive: predictLineupOnly([afterCov], naiveProj, weeks, slots, replOf(naivePool, naiveProj, add), posOf)[0].total,
                 real: realizedRoster(afterFull, forecasts, actualWeeks, und, weeks, slots).total };
      });
      if (!cand.length) continue;
      const best = Math.max(...cand.map(c => c.real));
      const choice = {}, regret = {};
      for (const m of METHODS) {
        // argmax of the method's predicted total; ties (common for lineup-only:
        // any never-starting bench player is an equal drop) go to the lowest
        // mean frozen p50, then id -- the same neutral rule for every method.
        const pick = cand.slice().sort((x, y) => (y[m] - x[m]) || (x.m - y.m) || byId(x.d, y.d))[0];
        choice[m] = pick.d; regret[m] = best - pick.real;
      }
      result.waiver_rows.push({ cluster, team, add, choice, regret });
    }
  }
  }
}

// --- metrics, bootstrap, verdict --------------------------------------------------
const regretOf = (pred, real) => Math.max(real, 0) - (pred > 0 ? real : 0);
function block(rows) {
  const n = rows.length;
  if (!n) return { n: 0, mae: null, sign_accuracy: null, regret: null, coverage: null };
  const mae = {}, sign = {}, reg = {};
  for (const m of METHODS) {
    let a = 0, s = 0, g = 0;
    for (const r of rows) { a += Math.abs(r[m] - r.real); if ((r[m] > 0) === (r.real > 0)) s++; g += regretOf(r[m], r.real); }
    mae[m] = a / n; sign[m] = s / n; reg[m] = g / n;
  }
  const covered = rows.filter(r => r.sim_p10 <= r.real && r.real <= r.sim_p90).length;
  return { n, mae, sign_accuracy: sign, regret: reg, coverage: covered / n };
}
// Rule 7. rows = one per trade side: {real, sim, current, naive, sim_p10, sim_p90, strata[], position}.
function metrics(rows) {
  const by_stratum = {};
  for (const s of STRATA) by_stratum[s] = block(rows.filter(r => r.strata.includes(s)));
  const by_position = {};
  for (const p of POS) { const rs = rows.filter(r => r.position === p); if (rs.length) by_position[p] = block(rs); }
  return { pooled: block(rows), by_stratum, by_position };
}
function percentile(sorted, q) {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * q, lo = Math.floor(h), hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
const interval = xs => { const s = xs.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? [percentile(s, 0.025), percentile(s, 0.975)] : null; };
function clusters(rows) {
  const map = new Map();
  for (const r of rows) { if (!map.has(r.cluster)) map.set(r.cluster, []); map.get(r.cluster).push(r); }
  return [...map.keys()].sort(byId).map(k => map.get(k));
}
/* Rule 8. Resample (season, origin, league) clusters with replacement B times;
   per resample, the pooled MAE and regret differences (sim - current, sim - naive)
   and each stratum's (sim - current) MAE difference. Returns the 2.5/97.5
   percentiles. A stratum empty in a resample contributes no value to that
   stratum's interval (its count is reported). */
function bootstrap(rows, B, rand) {
  const cs = clusters(rows).map(rs => {
    const agg = { n: rs.length, abs: {}, reg: {}, st: {} };
    for (const m of METHODS) { agg.abs[m] = 0; agg.reg[m] = 0; }
    for (const s of STRATA) agg.st[s] = { n: 0, sim: 0, current: 0 };
    for (const r of rs) {
      for (const m of METHODS) { agg.abs[m] += Math.abs(r[m] - r.real); agg.reg[m] += regretOf(r[m], r.real); }
      for (const s of r.strata) if (agg.st[s]) { agg.st[s].n++; agg.st[s].sim += Math.abs(r.sim - r.real); agg.st[s].current += Math.abs(r.current - r.real); }
    }
    return agg;
  });
  const C = cs.length;
  const out = { mae_cur: [], mae_naive: [], reg_cur: [], reg_naive: [], st: Object.fromEntries(STRATA.map(s => [s, []])) };
  for (let b = 0; b < B && C; b++) {
    let n = 0; const abs = { sim: 0, current: 0, naive: 0 }, reg = { sim: 0, current: 0, naive: 0 };
    const st = Object.fromEntries(STRATA.map(s => [s, { n: 0, sim: 0, current: 0 }]));
    for (let i = 0; i < C; i++) {
      const c = cs[Math.floor(rand() * C)];
      n += c.n;
      for (const m of METHODS) { abs[m] += c.abs[m]; reg[m] += c.reg[m]; }
      for (const s of STRATA) { st[s].n += c.st[s].n; st[s].sim += c.st[s].sim; st[s].current += c.st[s].current; }
    }
    out.mae_cur.push((abs.sim - abs.current) / n); out.mae_naive.push((abs.sim - abs.naive) / n);
    out.reg_cur.push((reg.sim - reg.current) / n); out.reg_naive.push((reg.sim - reg.naive) / n);
    for (const s of STRATA) if (st[s].n) out.st[s].push((st[s].sim - st[s].current) / st[s].n);
  }
  return {
    B, n_clusters: C,
    mae_diff: { current: interval(out.mae_cur), naive: interval(out.mae_naive) },
    regret_diff: { current: interval(out.reg_cur), naive: interval(out.reg_naive) },
    strata_mae_diff_current: Object.fromEntries(STRATA.map(s => [s, interval(out.st[s])])),
    strata_resamples_used: Object.fromEntries(STRATA.map(s => [s, out.st[s].length])),
  };
}
// Waiver: resample the same clusters; mean regret difference (sim - current) and (sim - naive).
function bootstrapWaiver(rows, B, rand) {
  const cs = clusters(rows).map(rs => {
    const a = { n: rs.length, sim: 0, current: 0, naive: 0 };
    for (const r of rs) for (const m of METHODS) a[m] += r.regret[m];
    return a;
  });
  const C = cs.length, cur = [], nai = [];
  for (let b = 0; b < B && C; b++) {
    let n = 0, s = 0, c = 0, v = 0;
    for (let i = 0; i < C; i++) { const x = cs[Math.floor(rand() * C)]; n += x.n; s += x.sim; c += x.current; v += x.naive; }
    cur.push((s - c) / n); nai.push((s - v) / n);
  }
  return { B, n_clusters: C, regret_diff_current: interval(cur), regret_diff_naive: interval(nai) };
}
function waiverMetrics(rows) {
  const n = rows.length, out = { n, mean_regret: null, zero_regret_share: null };
  if (!n) return out;
  out.mean_regret = {}; out.zero_regret_share = {};
  for (const m of METHODS) {
    out.mean_regret[m] = rows.reduce((t, r) => t + r.regret[m], 0) / n;
    out.zero_regret_share[m] = rows.filter(r => r.regret[m] === 0).length / n;
  }
  return out;
}
const finiteIv = iv => Array.isArray(iv) && iv.length === 2 && iv.every(Number.isFinite);
/* Rule 9 (spec §6.5, plan refinement 5), not tuned: pass iff
   - pooled MAE and regret intervals vs BOTH comparators lie entirely below 0;
   - no stratum's (sim - current) MAE interval lies entirely above 0;
   - 80% coverage in [0.70, 0.90].
   A missing or non-finite interval is not evidence of anything, so it fails
   the check it belongs to (fail closed). */
function verdictChecks(summary) {
  const b = (summary && summary.bootstrap) || {}, checks = [];
  for (const [key, label] of [["mae_diff", "MAE"], ["regret_diff", "regret"]]) {
    for (const m of ["current", "naive"]) {
      const iv = b[key] && b[key][m];
      checks.push({ rule: `pooled ${label} (sim - ${m}) interval entirely below 0`, interval: iv || null, pass: finiteIv(iv) && iv[1] < 0 });
    }
  }
  for (const s of STRATA) {
    const iv = b.strata_mae_diff_current && b.strata_mae_diff_current[s];
    checks.push({ rule: `stratum ${s}: (sim - current) MAE interval not entirely above 0`, interval: iv || null, pass: finiteIv(iv) && !(iv[0] > 0) });
  }
  const cov = summary && summary.coverage;
  checks.push({ rule: `80% interval coverage in [${COVERAGE_BAND[0]}, ${COVERAGE_BAND[1]}]`, value: Number.isFinite(cov) ? cov : null,
                pass: Number.isFinite(cov) && cov >= COVERAGE_BAND[0] && cov <= COVERAGE_BAND[1] });
  return checks;
}
function verdict(summary) { return verdictChecks(summary).every(c => c.pass) ? "pass" : "fail"; }
function waiverVerdict(b) { const iv = b && b.regret_diff_current; return finiteIv(iv) && iv[1] < 0 ? "pass" : "fail"; }

// --- output -------------------------------------------------------------------------
// Rounding happens here and only here; any non-finite number is an error
// (the JSON equivalent of allow_nan=False), never a silent null.
function roundDeep(x, where = "$") {
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new BacktestError(`non-finite value at ${where}`);
    if (Number.isInteger(x)) return x;
    const r = Math.round(x * 1000) / 1000;
    return r === 0 ? 0 : r;
  }
  if (Array.isArray(x)) return x.map((v, i) => roundDeep(v, `${where}[${i}]`));
  if (x && typeof x === "object") { const o = {}; for (const [k, v] of Object.entries(x)) o[k] = roundDeep(v, `${where}.${k}`); return o; }
  return x;
}

// --- CLI ------------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { seasons: null, origins: null, leagues: null, trades: null, sims: null, league: null, secondary: null,
              out: null, "site-out": null, jobs: null, "forecasts-dir": "models/backtests/origin_forecasts",
              "worlds-dir": "models/backtests/worlds_tf", "availability-dir": "models/backtests/availability" };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, "");
    if (!(k in a)) throw new BacktestError(`unknown option --${k}`);
    if (argv[i + 1] === undefined) throw new BacktestError(`--${k} needs a value`);
    a[k] = argv[i + 1];
  }
  const ints = s => s.split(",").map(x => { const v = Number(x); if (!Number.isInteger(v)) throw new BacktestError(`not an integer: ${x}`); return v; });
  for (const k of ["seasons", "origins", "leagues", "trades", "sims", "league", "out", "site-out"]) if (a[k] === null) throw new BacktestError(`--${k} is required`);
  const cfg = { seasons: ints(a.seasons), origins: ints(a.origins), leagues: Number(a.leagues), trades: Number(a.trades), sims: Number(a.sims),
                league: a.league, secondary: a.secondary, out: a.out, siteOut: a["site-out"],
                jobs: a.jobs === null ? Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))) : Number(a.jobs),
                forecastsDir: a["forecasts-dir"], worldsDir: a["worlds-dir"], availabilityDir: a["availability-dir"], bootstrap: BOOTSTRAP_B };
  for (const k of ["leagues", "trades", "sims", "jobs"]) if (!Number.isInteger(cfg[k]) || cfg[k] < 1) throw new BacktestError(`--${k} must be a positive integer`);
  for (const o of cfg.origins) if (o < 2 || o > LAST_WEEK) throw new BacktestError(`origin ${o} outside 2..${LAST_WEEK}`);
  return cfg;
}
const forecastPath = (cfg, S, O) => path.join(cfg.forecastsDir, `forecasts_${S}_o${O}.json`);
const worldPath = (cfg, S) => path.join(cfg.worldsDir, `world_${S}.json`);
const availPath = (cfg, S) => path.join(cfg.availabilityDir, `availability_${S}.json`);
const readJson = p => JSON.parse(fs.readFileSync(p, "utf8"));
function slotsOf(league) {
  const slots = [];
  for (const pos of POS) for (let i = 0; i < ((league.roster || {})[pos] || 0); i++) slots.push(pos);
  const flex = (league.flex_positions || []).includes("QB") ? "SUPER_FLEX" : "FLEX";
  for (let i = 0; i < (league.flex || 0); i++) slots.push(flex);
  return slots;
}
function checkForecastFile(fc, S, O, file) {
  const want = Array.from({ length: LAST_WEEK - O + 1 }, (_, i) => O + i);
  if (fc.schema_version !== 1) throw new BacktestError(`${file}: schema_version ${fc.schema_version}, expected 1`);
  if (fc.season !== S || fc.origin !== O) throw new BacktestError(`${file}: holds season ${fc.season} origin ${fc.origin}, expected ${S} / ${O}`);
  if (JSON.stringify(fc.weeks) !== JSON.stringify(want)) throw new BacktestError(`${file}: weeks ${JSON.stringify(fc.weeks)}, expected ${O}..${LAST_WEEK}`);
  if (!fc.players || typeof fc.players !== "object") throw new BacktestError(`${file}: no players`);
}
// Worker-side cache: each worker loads an input file once.
const cache = new Map();
function cached(p) { if (!cache.has(p)) cache.set(p, readJson(p)); return cache.get(p); }
function executeCell(spec) {
  const fc = cached(spec.forecastFile), world = cached(spec.worldFile), av = cached(spec.availabilityFile);
  return runCell({ season: spec.season, origin: spec.origin, k: spec.k, rosters: spec.rosters, undrafted: spec.undrafted,
                   forecasts: fc, actualWeeks: world.actual_weeks, availability: av, tags: (av.tags || {})[String(spec.origin - 1)] || {},
                   slots: spec.slots, nSims: spec.nSims, simSeed: spec.simSeed, trades: spec.trades, waiver: spec.waiver });
}
async function runCells(specs, jobs, onDone) {
  const results = new Array(specs.length);
  if (jobs <= 1) {
    specs.forEach((s, i) => { results[i] = executeCell(s); onDone(results[i]); });
    return results;
  }
  const { Worker } = require("worker_threads");
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, specs.length) }, () => new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { role: "cell-worker" } });
    const feed = () => { if (next >= specs.length) { w.terminate().then(resolve, reject); return; } const i = next++; w.postMessage({ i, spec: specs[i] }); };
    w.on("message", m => { if (m.error) { w.terminate(); reject(new Error(m.error)); return; } results[m.i] = m.result; onDone(m.result); feed(); });
    w.on("error", reject);
    feed();
  })));
  return results;
}

async function runLeague(cfg, boardPath, inputs, { waiver }) {
  const D = require(path.join(__dirname, "draft_sim.cjs"));
  const O = require(path.join(__dirname, "..", "site", "assets", "optimizer.js"));
  const board = readJson(boardPath);
  const league = board.league;
  if (!league || !league.slug) throw new BacktestError(`${boardPath} has no league block with a slug`);
  const slots = slotsOf(league);
  // Phase 1 -- drafts and trade samples for every cell, before any prediction.
  D.applyLeague(league);
  D.setNoise(D.MEASURED.noiseRanks);     // the measured field's noise, as draft_sim's CLI sets it for --field measured
  const cells = [], trades = [];
  for (const S of cfg.seasons) {
    const world = inputs.worlds[S];
    const players = O.withValuePoints(world.players);
    D.assertWorldUsable(world, players);
    for (let k = 0; k < cfg.leagues; k++) {
      const draftSeed = 1000 * S + k;
      const drafted = D.runDraft(players, 0, draftSeed, "measured").slice(1).map(r => r.map(p => p.player_id));
      const taken = new Set(drafted.flat());
      const undrafted = world.players.map(p => p.player_id).filter(id => !taken.has(id));
      for (const Or of cfg.origins) {
        const fc = inputs.forecasts[`${S}:${Or}`];
        const tradeSeed = hashStr(`${S}:${Or}:${k}`);
        const sampled = sampleTrades(drafted, fc, mulberry32(tradeSeed), cfg.trades)
          .map((t, i) => Object.assign({ id: `${S}:${Or}:${k}:${i}`, season: S, origin: Or, k }, t));
        trades.push(...sampled);
        cells.push({ season: S, origin: Or, k, draftSeed, tradeSeed, simSeed: hashStr(`sim:${S}:${Or}:${k}`),
                     roster_sizes: drafted.map(r => r.length), rosters: drafted, undrafted, trades: sampled,
                     forecastFile: forecastPath(cfg, S, Or), worldFile: worldPath(cfg, S), availabilityFile: availPath(cfg, S),
                     slots, nSims: cfg.sims, waiver });
      }
    }
  }
  const shortCells = cells.filter(c => c.trades.length < cfg.trades).map(c => `${c.season}:${c.origin}:${c.k} (${c.trades.length})`);
  console.log(`[${league.slug}] ${cells.length} cells, ${trades.length} trades sampled` + (shortCells.length ? `; short cells: ${shortCells.join(", ")}` : ""));
  // Phase 2 -- predictions and realized outcomes.
  const t0 = Date.now(); let done = 0;
  const results = await runCells(cells, cfg.jobs, r => {
    done++;
    console.log(`[${league.slug}] cell ${r.cluster} ${r.excluded ? "EXCLUDED: " + r.excluded : `${r.rows.length / 2} trades`} in ${r.runtime_s.toFixed(1)}s (${done}/${cells.length}, ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`);
  });
  // Phase 3 -- lopsided stratum, metrics, bootstrap, verdicts.
  const rows = results.flatMap(r => r.rows);
  const byTrade = new Map();
  for (const r of rows) { if (!byTrade.has(r.trade_id)) byTrade.set(r.trade_id, []); byTrade.get(r.trade_id).push(r); }
  const measure = [...byTrade.values()].map(rs => Math.max(...rs.map(r => Math.abs(r.current))));
  const cutoff = measure.length ? percentile(measure.slice().sort((x, y) => x - y), 0.9) : null;
  for (const rs of byTrade.values()) if (Math.max(...rs.map(r => Math.abs(r.current))) >= cutoff) for (const r of rs) r.strata.push("lopsided");
  const tradeStrata = new Map([...byTrade].map(([id, rs]) => [id, rs[0].strata]));
  for (const t of trades) t.strata = tradeStrata.get(t.id) || null;     // null = cell excluded
  const m = metrics(rows);
  const boot = bootstrap(rows, cfg.bootstrap, mulberry32(hashStr(`bootstrap:${league.slug}`)));
  const summary = { coverage: m.pooled.coverage, bootstrap: boot };
  const out = {
    league: league.slug, name: league.name, teams: league.teams, rounds: league.rounds, slots,
    cells: results.map((r, i) => ({ season: r.season, origin: r.origin, k: r.k, draft_seed: cells[i].draftSeed, trade_seed: cells[i].tradeSeed,
                                     sim_seed: cells[i].simSeed, roster_sizes: cells[i].roster_sizes, undrafted: cells[i].undrafted.length,
                                     trades: cells[i].trades.length, excluded: r.excluded, uncovered_rostered: r.uncovered_rostered,
                                     partial_rostered: r.partial_rostered, null_baseline_rostered: r.null_baseline_rostered })),
    lopsided_cutoff: cutoff,
    lopsided_measure: "max over the trade's two sides of |current-method side delta| (points, weeks origin..17)",
    metrics: m, bootstrap: boot, verdict: verdict(summary), verdict_checks: verdictChecks(summary),
    trades, rows: rows.map(({ cluster, ...r }) => r),
    timings: { cells_s: results.map(r => r.runtime_s), phase2_wall_s: (Date.now() - t0) / 1000 },
  };
  if (waiver) {
    const wrows = results.flatMap(r => r.waiver_rows);
    const wb = bootstrapWaiver(wrows, cfg.bootstrap, mulberry32(hashStr(`waiver-bootstrap:${league.slug}`)));
    out.waiver = { adds_per_roster: WAIVER_ADDS, metrics: waiverMetrics(wrows), bootstrap: wb, verdict: waiverVerdict(wb),
                   rows: wrows.map(({ cluster, ...r }) => r) };
  }
  return out;
}
function isPredeclared(cfg) {
  return JSON.stringify(cfg.seasons) === JSON.stringify(PREDECLARED.seasons) && JSON.stringify(cfg.origins) === JSON.stringify(PREDECLARED.origins)
    && cfg.leagues === PREDECLARED.leagues && cfg.trades === PREDECLARED.trades && cfg.sims === PREDECLARED.sims && cfg.bootstrap === PREDECLARED.bootstrap;
}
function stratumE(r) { return Object.fromEntries(STRATA.map(s => [s, { E: r.metrics.by_stratum[s].mae ? r.metrics.by_stratum[s].mae.sim : null, n: r.metrics.by_stratum[s].n }])); }

async function main() {
  const cfg = parseArgs(process.argv);
  const predeclared = isPredeclared(cfg);
  // A reduced run must never open the public gate: refuse a site-out inside site/.
  const siteDir = path.resolve(__dirname, "..", "site");
  if (!predeclared && path.resolve(cfg.siteOut).startsWith(siteDir + path.sep)) {
    throw new BacktestError(`this run is not the predeclared configuration (${JSON.stringify(PREDECLARED)}); refusing to write the gate file ${cfg.siteOut} under site/`);
  }
  // Pre-flight: every input exists before any work starts.
  const missing = [];
  for (const S of cfg.seasons) {
    for (const p of [worldPath(cfg, S), availPath(cfg, S)].concat(cfg.origins.map(O => forecastPath(cfg, S, O)))) if (!fs.existsSync(p)) missing.push(p);
  }
  for (const p of [cfg.league, cfg.secondary].filter(Boolean)) if (!fs.existsSync(p)) missing.push(p);
  if (missing.length) {
    throw new BacktestError(`missing input file(s):\n  ${missing.join("\n  ")}\nForecast files come from Task 2's export `
      + `(python -m ffmodel.eval.export_origin_forecasts --season S --origin O --last-week 17 --out ...); worlds from `
      + `python -m ffmodel.eval.draft_world; availability tables from Task 1.`);
  }
  const inputs = { worlds: {}, forecasts: {} };
  for (const S of cfg.seasons) {
    inputs.worlds[S] = readJson(worldPath(cfg, S));
    if (inputs.worlds[S].season !== S) throw new BacktestError(`${worldPath(cfg, S)} holds season ${inputs.worlds[S].season}`);
    const av = readJson(availPath(cfg, S));
    if (av.test_season !== S) throw new BacktestError(`${availPath(cfg, S)} is for test season ${av.test_season}, not ${S}`);
    for (const O of cfg.origins) {
      const f = forecastPath(cfg, S, O), fc = readJson(f);
      checkForecastFile(fc, S, O, f);
      inputs.forecasts[`${S}:${O}`] = fc;
    }
  }
  const t0 = Date.now();
  const primary = await runLeague(cfg, cfg.league, inputs, { waiver: true });
  const secondary = cfg.secondary ? await runLeague(cfg, cfg.secondary, inputs, { waiver: false }) : null;
  const generated_at = new Date().toISOString();
  const forecastMeta = Object.fromEntries(Object.entries(inputs.forecasts).map(([k, f]) => [k, { model: f.model || null, training_through: f.training_through ?? null, scoring: f.scoring || null, players: Object.keys(f.players).length }]));
  const full = {
    schema_version: 1, generated_at,
    config: { seasons: cfg.seasons, origins: cfg.origins, leagues: cfg.leagues, trades: cfg.trades, sims: cfg.sims, bootstrap: cfg.bootstrap,
              predeclared, label_k: LABEL_K, coverage_band: COVERAGE_BAND, last_week: LAST_WEEK, waiver_adds: WAIVER_ADDS,
              inputs: { league: cfg.league, secondary: cfg.secondary, forecasts_dir: cfg.forecastsDir, worlds_dir: cfg.worldsDir, availability_dir: cfg.availabilityDir, forecasts: forecastMeta },
              seeds: { draft: "1000*S + k (tools/draft_sim.cjs runDraft, heroSlot 0, field 'measured', noise MEASURED.noiseRanks)",
                       trades: "mulberry32(hashStr(`${S}:${O}:${k}`))", sim: "hashStr(`sim:${S}:${O}:${k}`)",
                       bootstrap: "mulberry32(hashStr(`bootstrap:${slug}`)); waiver: mulberry32(hashStr(`waiver-bootstrap:${slug}`))" },
              rules: {
                replacement_pool: "per week and position, the top (dedicated + FLEX [+ SUPER_FLEX]) undrafted world players by the method's score among those with a play row that week",
                prediction_roster: "a side's players with a play/bye row for every week origin..17; others are excluded from all three predictions",
                realized: "weekly lineup by frozen p50 among roster players with an actual entry and a forecast play row that week; unfilled slots take the best-p50 undrafted player who played",
                sign: "(pred > 0) === (real > 0)", regret: "max(real,0) - (pred > 0 ? real : 0)", coverage: "sim p10 <= real <= p90 (side delta)",
                percentile: "linear interpolation (type 7)",
              } },
    primary, secondary,
    verdict: primary.verdict, waiver_verdict: primary.waiver.verdict,
    runtime_s: (Date.now() - t0) / 1000,
  };
  const slim = {
    schema_version: 1, league: primary.league, slots: primary.slots, verdict: primary.verdict, waiver_verdict: primary.waiver.verdict,
    k: LABEL_K, strata: stratumE(primary), lopsided_cutoff: primary.lopsided_cutoff, seasons: cfg.seasons, origins: cfg.origins, generated_at,
    secondary: secondary ? { league: secondary.league, slots: secondary.slots, verdict: secondary.verdict, strata: stratumE(secondary), lopsided_cutoff: secondary.lopsided_cutoff } : null,
  };
  const fullOut = roundDeep(full), slimOut = roundDeep(slim);     // throws on any non-finite number
  fs.mkdirSync(path.dirname(path.resolve(cfg.out)), { recursive: true });
  fs.writeFileSync(cfg.out, JSON.stringify(fullOut));
  fs.mkdirSync(path.dirname(path.resolve(cfg.siteOut)), { recursive: true });
  fs.writeFileSync(cfg.siteOut, JSON.stringify(slimOut, null, 1) + "\n");
  const p = primary.metrics.pooled;
  console.log(`\n[${primary.league}] n=${p.n} sides  MAE sim ${p.mae.sim.toFixed(2)} / current ${p.mae.current.toFixed(2)} / naive ${p.mae.naive.toFixed(2)}  coverage ${p.coverage.toFixed(3)}  verdict ${primary.verdict}  waiver_verdict ${primary.waiver.verdict}`);
  if (secondary) console.log(`[${secondary.league}] verdict ${secondary.verdict}`);
  console.log(`wrote ${cfg.out}\nwrote ${cfg.siteOut}${predeclared ? "" : "\n(NOT the predeclared configuration: exploratory numbers only)"}`);
}

const { isMainThread, parentPort, workerData } = (() => { try { return require("worker_threads"); } catch (e) { return { isMainThread: true }; } })();
if (!isMainThread && workerData && workerData.role === "cell-worker") {
  parentPort.on("message", ({ i, spec }) => {
    try { parentPort.postMessage({ i, result: executeCell(spec) }); }
    catch (e) { parentPort.postMessage({ i, error: e && e.stack || String(e) }); }
  });
} else if (require.main === module) {
  main().catch(e => { console.error(`trade_backtest: ${e instanceof BacktestError ? e.message : (e && e.stack) || e}`); process.exit(2); });
}

module.exports = { sampleTrades, predictSim, predictLineupOnly, realized, realizedRoster, metrics, bootstrap, bootstrapWaiver,
                   verdict, verdictChecks, waiverVerdict, waiverMetrics, runCell, buildSimWorld, replacementPool, poolSizes,
                   isCovered, meanP50, afterRoster, overflowDrop, roundDeep, percentile, mulberry32, hashStr, slotsOf,
                   BacktestError, STRATA, PREDECLARED };
