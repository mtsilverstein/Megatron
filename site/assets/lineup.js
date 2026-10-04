/* Exact lineup kernel (spec §7.1). Objective, lexicographic: (1) the exact sum
   of the binary64 scores in the open modeled slots, (2) the number of open
   slots keeping their current starter, (3) the smallest id vector in slot
   order. Scores become exact BigInt integers at a common power-of-two scale;
   the keep count is folded in with a multiplier larger than any keep total,
   so no epsilon is involved. rostersim.js keeps ROS.bestLineup (frozen). */
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

  function decompose(x) {               // x = m * 2^e exactly, m a signed BigInt
    if (x === 0) return [0n, 0];
    const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, x);
    const hi = dv.getUint32(0), lo = dv.getUint32(4), eb = (hi >>> 20) & 0x7ff;
    let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    if (eb) m |= 1n << 52n;
    return [hi >>> 31 ? -m : m, eb ? eb - 1075 : -1074];
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
  function solve({ slots, candidates, fixed = {}, current = [] }) {
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
    if (pool.length < open.length) return unfillable();
    const parts = pool.map(c => decompose(c.score));
    const minE = Math.min(...parts.filter(([m]) => m !== 0n).map(([, e]) => e), 0);
    const ints = parts.map(([m, e]) => m << BigInt(e - minE));
    const K = BigInt(open.length + 1);
    const base = open.map(i => pool.map((c, j) => ELIG[slots[i]].includes(c.position)
      ? -(ints[j] * K + (current[i] === c.id ? 1n : 0n)) : null));
    const best = hungarian(base, open.length, pool.length);
    if (!best) return unfillable();
    const cost = base.map(r => r.slice());
    for (let r = 0; r < open.length; r++) {
      const order = pool.map((c, j) => j).filter(j => cost[r][j] !== null)
        .sort((a, b) => (pool[a].id < pool[b].id ? -1 : pool[a].id > pool[b].id ? 1 : 0));
      for (const j of order) {
        const trial = cost.map((row, rr) => row.map((x, jj) => (rr === r ? (jj === j ? x : null) : (jj === j ? null : x))));
        const res = hungarian(trial, open.length, pool.length);
        if (res && res.total === best.total) { for (let i = 0; i < cost.length; i++) cost[i] = trial[i]; break; }
      }
    }
    const final = hungarian(cost, open.length, pool.length);
    let total = 0;
    open.forEach((slotIndex, r) => {
      const c = pool[final.col[r]];
      Object.assign(assignment[slotIndex], { id: c.id, score: c.score });
      total += c.score;
    });
    return { ok: true, total, assignment };
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
  // Stage-1 only (no keep term, no id fixing): the optimal total cannot depend on tie-breaks.
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
    let total = 0;
    for (let r = 0; r < slots.length; r++) total += pool[res.col[r]].score;
    return total;
  }
  return Object.freeze({ MODELED, UNMODELED, NON_STARTING, UNMODELED_POSITIONS, solve, bestLineup, lineupScore });
});
