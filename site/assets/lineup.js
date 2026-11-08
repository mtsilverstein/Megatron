/* Exact lineup kernel (spec §7.1). Objective, lexicographic: (1) the exact sum
   of the binary64 scores in the open modeled slots, (2) the number of open
   slots keeping their current starter, (3) the smallest id vector in slot
   order. Scores become exact BigInt integers at a common power-of-two scale;
   the keep count is folded in with a multiplier larger than any keep total,
   so no epsilon is involved. rostersim.js keeps ROS.bestLineup (frozen).
   solve({allowEmpty: true}) (start/sit, audit A6-2) never refuses an
   infeasible lineup: stage (0), before (1), fills as many open slots as
   possible; an unfillable slot is left empty, scores 0, and sorts after every
   player id in (3). Without it an infeasible lineup refuses, as before. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.Lineup = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";
  const Formats = (typeof module !== "undefined" && module.exports) ? require("./formats.js") : root.Formats;
  const ELIG = Formats.AUDIT.slot_eligible;
  const MODELED = Object.freeze(["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX", "WRRB_FLEX", "REC_FLEX"]);
  const UNMODELED = Object.freeze(["K", "DEF", "DL", "LB", "DB", "IDP_FLEX"]);
  const NON_STARTING = Object.freeze(["BN", "IR", "TAXI"]);
  const UNMODELED_POSITIONS = Object.freeze(["K", "DEF", "DL", "LB", "DB"]);
  const SKILL = Object.freeze(["QB", "RB", "WR", "TE"]);
  // A rostered player's modeled position, or null for an unmodeled occupant
  // (audit A6-4). One classifier by Sleeper's catalog `position`, the same rule
  // start/sit and waivers use: QB/RB/WR/TE are modeled; FB, K, DEF and every
  // granular IDP code (DE, DT, CB, SS, ILB, ...) are not. `fantasy_positions`
  // is deliberately not consulted, so all three pages agree on who is modeled.
  function modeledPosition(c) {
    return c && SKILL.includes(c.position) ? c.position : null;
  }

  function decompose(x) {               // x = m * 2^e exactly, m a signed BigInt
    if (x === 0) return [0n, 0];
    const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, x);
    const hi = dv.getUint32(0), lo = dv.getUint32(4), eb = (hi >>> 20) & 0x7ff;
    let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    if (eb) m |= 1n << 52n;
    return [hi >>> 31 ? -m : m, eb ? eb - 1075 : -1074];
  }
  // Exact value S * 2^e (S a BigInt, e >= -1074) rounded once, to nearest-even, to a Number.
  function toNumber(S, e) {
    if (S === 0n) return 0;
    const neg = S < 0n, a = neg ? -S : S;
    const L = a.toString(2).length;
    const lsb = Math.max(L - 1 + e - 52, -1074);
    let out;
    if (lsb <= e) out = Number(a) * 2 ** e;                      // a < 2^53: exact
    else {
      const sh = BigInt(lsb - e), half = 1n << (sh - 1n);
      let q = a >> sh; const rem = a & ((1n << sh) - 1n);
      if (rem > half || (rem === half && (q & 1n))) q += 1n;
      out = lsb > 1023 ? Infinity : Number(q) * 2 ** lsb;          // q <= 2^53: exact; overflow rounds to Infinity
    }
    return neg ? -out : out;
  }
  // Rectangular Hungarian (n rows <= m cols), BigInt costs, null = forbidden. Minimises.
  function hungarian(cost, n, m) {
    const u = new Array(n + 1).fill(0n), v = new Array(m + 1).fill(0n), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0;
      const minv = new Array(m + 1).fill(null), used = new Array(m + 1).fill(false);
      do {
        used[j0] = true; const i0 = p[j0]; let delta = null, j1 = -1;
        for (let j = 1; j <= m; j++) if (!used[j]) {
          const c = cost[i0 - 1][j - 1];
          if (c !== null) { const cur = c - u[i0] - v[j]; if (minv[j] === null || cur < minv[j]) { minv[j] = cur; way[j] = j0; } }
          if (minv[j] !== null && (delta === null || minv[j] < delta)) { delta = minv[j]; j1 = j; }
        }
        if (delta === null) return null;
        for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else if (minv[j] !== null) minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const col = new Array(n).fill(-1);
    for (let j = 1; j <= m; j++) if (p[j]) col[p[j] - 1] = j - 1;
    let total = 0n;
    for (let i = 0; i < n; i++) total += cost[i][col[i]];
    return { col, total };
  }
  function fail(reason, slot) { return { ok: false, reason, slot }; }
  function solve({ slots, candidates, fixed = {}, current = [], allowEmpty = false }) {
    if (!Array.isArray(slots)) throw new Error("slots must be an array");
    for (const s of slots) if (!MODELED.includes(s) && !UNMODELED.includes(s)) throw new Error(`Unsupported lineup slot: ${s}`);
    const ids = new Set();
    for (const c of candidates || []) {
      if (typeof c.id !== "string" || ids.has(c.id)) throw new Error(`Duplicate or invalid candidate id: ${c.id}`);
      if (typeof c.score !== "number" || !Number.isFinite(c.score)) throw new Error(`Invalid score for ${c.id}`);
      ids.add(c.id);
    }
    const assignment = slots.map((slot, index) => ({ index, slot, id: null, score: null, fixed: false, unmodeled: UNMODELED.includes(slot) }));
    const fixedIds = new Set();
    for (const [k, f] of Object.entries(fixed)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || i >= slots.length || !f || typeof f.id !== "string") return fail("Invalid fixed slot.", slots[i]);
      if (fixedIds.has(f.id)) return fail(`Player ${f.id} occupies two slots.`, slots[i]);
      if (MODELED.includes(slots[i]) && !(f.position && ELIG[slots[i]].includes(f.position))) return fail("Locked player is in an incompatible slot.", slots[i]);
      fixedIds.add(f.id);
      Object.assign(assignment[i], { id: f.id, score: f.score ?? null, fixed: true });
    }
    const open = assignment.filter(a => !a.fixed && !a.unmodeled).map(a => a.index);
    if (!open.length) return { ok: true, total: 0, assignment };
    const pool = (candidates || []).filter(c => !fixedIds.has(c.id));
    const unfillable = () => { const i = open.find(i => !pool.some(c => ELIG[slots[i]].includes(c.position))) ?? open[open.length - 1];
      return fail(`Cannot fill ${slots[i]} with available, projected players.`, slots[i]); };
    if (!allowEmpty && pool.length < open.length) return unfillable();
    const parts = pool.map(c => decompose(c.score));
    const minE = Math.min(...parts.filter(([m]) => m !== 0n).map(([, e]) => e), 0);
    const ints = parts.map(([m, e]) => m << BigInt(e - minE));
    const K = BigInt(open.length + 1);
    const base = open.map(i => pool.map((c, j) => ELIG[slots[i]].includes(c.position)
      ? -(ints[j] * K + (current[i] === c.id ? 1n : 0n)) : null));
    // allowEmpty: one "empty" column per open slot, usable by that slot only.
    // Its cost D exceeds twice the largest possible scored part, so one more
    // filled slot always beats any score difference (stage 0).
    let width = pool.length;
    if (allowEmpty) {
      let A = 1n;
      for (const row of base) for (const c of row) if (c !== null && (c < 0n ? -c : c) > A) A = c < 0n ? -c : c;
      const D = 2n * BigInt(open.length) * A + 1n;
      base.forEach((row, r) => { for (let e = 0; e < open.length; e++) row.push(e === r ? D : null); });
      width += open.length;
    }
    const best = hungarian(base, open.length, width);
    if (!best) return unfillable();
    const idOf = j => (j < pool.length ? pool[j].id : null);            // null = empty, after every id
    const byId = (a, b) => { const x = idOf(a), y = idOf(b);
      return x === null || y === null ? (x === null) - (y === null) : x < y ? -1 : x > y ? 1 : 0; };
    const cost = base.map(r => r.slice());
    for (let r = 0; r < open.length; r++) {
      const order = cost[r].map((x, j) => j).filter(j => cost[r][j] !== null).sort(byId);
      for (const j of order) {
        const trial = cost.map((row, rr) => row.map((x, jj) => (rr === r ? (jj === j ? x : null) : (jj === j ? null : x))));
        const res = hungarian(trial, open.length, width);
        if (res && res.total === best.total) { for (let i = 0; i < cost.length; i++) cost[i] = trial[i]; break; }
      }
    }
    const final = hungarian(cost, open.length, width);
    let exactSum = 0n;
    open.forEach((slotIndex, r) => {
      if (final.col[r] >= pool.length) { assignment[slotIndex].empty = true; return; }   // scores 0
      const c = pool[final.col[r]];
      Object.assign(assignment[slotIndex], { id: c.id, score: c.score });
      exactSum += ints[final.col[r]];
    });
    // A fillable dedicated slot is never left empty: if a flex-type slot holds a
    // player who also fits an empty, narrower slot, swap him in (same points).
    if (allowEmpty) {
      const posOf = new Map(pool.map(c => [c.id, c.position]));
      for (const i of open) {
        if (!assignment[i].empty) continue;
        const j = open.find(j => assignment[j].id !== null && !assignment[j].fixed && ELIG[slots[i]].length < ELIG[slots[j]].length
          && ELIG[slots[i]].includes(posOf.get(assignment[j].id)));
        if (j === undefined) continue;
        Object.assign(assignment[i], { id: assignment[j].id, score: assignment[j].score });
        delete assignment[i].empty;
        Object.assign(assignment[j], { id: null, score: null, empty: true });
      }
    }
    return { ok: true, total: toNumber(exactSum, minE), assignment };
  }
  const pid = p => String(p.sleeper_id ?? p.id);
  function bestLineup(players, slots, scoreOf) {
    for (const s of slots) if (!MODELED.includes(s)) throw new Error(`bestLineup accepts modeled slots only, got ${s}`);
    const cands = [], byId = new Map();
    for (const p of players || []) {
      if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
      const v = scoreOf(p);
      if (v === null || v === undefined || Number.isNaN(v)) continue;
      cands.push({ id: pid(p), position: p.position, score: v }); byId.set(pid(p), p);
    }
    const r = solve({ slots, candidates: cands });
    if (!r.ok) return { total: -Infinity, starters: [], unfillable: r.slot };
    return { total: r.total, starters: r.assignment.map(a => ({ player: byId.get(a.id), slot: a.slot, points: a.score })) };
  }
  // Stage-1 only (no keep term, no id fixing): the optimal total cannot depend on tie-breaks,
  // and both APIs report it as the exact BigInt sum rounded once (identical in either assignment order).
  function lineupScore(players, slots, scoreOf) {
    for (const s of slots) if (!MODELED.includes(s)) throw new Error(`bestLineup accepts modeled slots only, got ${s}`);
    const pool = [], seen = new Set();
    for (const p of players || []) {
      if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
      const v = scoreOf(p);
      if (v === null || v === undefined || Number.isNaN(v)) continue;
      const id = pid(p);
      if (seen.has(id)) throw new Error(`Duplicate or invalid candidate id: ${id}`);
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Invalid score for ${id}`);
      seen.add(id); pool.push({ position: p.position, score: v });
    }
    if (!slots.length) return 0;
    if (pool.length < slots.length) return -Infinity;
    const parts = pool.map(c => decompose(c.score));
    const minE = Math.min(...parts.filter(([m]) => m !== 0n).map(([, e]) => e), 0);
    const ints = parts.map(([m, e]) => m << BigInt(e - minE));
    const cost = slots.map(sl => pool.map((c, j) => ELIG[sl].includes(c.position) ? -ints[j] : null));
    const res = hungarian(cost, slots.length, pool.length);
    if (!res) return -Infinity;
    return toNumber(-res.total, minE);                              // exact sum of the chosen scores, rounded once
  }
  return Object.freeze({ MODELED, UNMODELED, NON_STARTING, UNMODELED_POSITIONS, modeledPosition, solve, bestLineup, lineupScore });
});
