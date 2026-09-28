/* Seeded Monte Carlo of the rest of a fantasy season (spec 2026-09-24 §3).
   Pure: no DOM, no fetch. One world holds every player a comparison touches, so
   all roster variants share the same draws (common random numbers) and a paired
   delta carries only the effect of the move. Unknown is never zero: a missing
   week throws; a bye or an absence is "out", and an empty slot is filled from the
   supplied replacement pool or the call throws. */
(function (root, factory) {
  const node = typeof module !== "undefined" && module.exports;
  const api = factory(node ? require("./ros.js") : root.ROS);
  if (node) module.exports = api;
  if (root) root.RosterSim = api;
})(typeof window !== "undefined" ? window : null, function (ROS) {
  "use strict";
  const Z90 = 1.2815515655446004;
  const POS = ["QB", "RB", "WR", "TE"];
  class RosterSimError extends Error { constructor(m) { super(m); this.name = "RosterSimError"; } }
  const fail = m => { throw new RosterSimError(m); };

  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
  // Acklam's inverse normal CDF (|error| < 1.2e-9).
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  function invNorm(p) {
    if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
    const lo = 0.02425, hi = 1 - lo;
    if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
  // Two-piece normal through (p10, p50, p90). Floor is 0 when p10 >= 0; otherwise
  // it's the reflection of p50 about p10 (2*p10 - p50), which keeps p10 exact
  // without piling the whole bottom decile onto one clamped value the way a
  // floor of exactly p10 would. u is clamped away from {0,1}: invNorm(0) is
  // -Infinity, and -Infinity * 0 is NaN whenever the spread on that side is 0
  // (e.g. degenerate p10 === p50 quantiles), so an unclamped u=0 can produce NaN.
  function drawPoints(q, u) {
    const uc = u < 1e-12 ? 1e-12 : (u > 1 - 1e-12 ? 1 - 1e-12 : u);
    const z = invNorm(uc);
    const s = z < 0 ? (q.p50 - q.p10) / Z90 : (q.p90 - q.p50) / Z90;
    // Floor min(0, 2*p10): continuous across p10 = 0 (fringe players sit there) and
    // always <= p10, so p10 stays exact.
    const x = q.p50 + z * s, floor = Math.min(0, 2 * q.p10);
    return x < floor ? floor : x;
  }
  function checkQ(q, where) {
    if (!q || ![q.p10, q.p50, q.p90].every(Number.isFinite) || !(q.p10 <= q.p50 && q.p50 <= q.p90))
      fail(`invalid quantiles for ${where}`);
  }
  const TAGS = { out: "Out", sus: "Out", doubtful: "Doubtful", questionable: "Questionable", ir: "IR", pup: "IR" };
  function normalizeTag(s) { return typeof s === "string" && TAGS[s.trim().toLowerCase()] || null; }
  const ALLOWED_SLOTS = new Set(["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX"]);
  const TAG_KEYS = ["Out", "Doubtful", "Questionable", "IR"];

  function createWorld(cfg) {
    const { weeks, slots, players, availability: A, replacement, forcedOut = {}, nSims = 2000, seed = 1 } = cfg || {};
    if (!Array.isArray(weeks) || !weeks.length || !weeks.every(Number.isInteger)) fail("weeks required");
    if (!Array.isArray(slots) || !slots.length) fail("slots required");
    for (const s of slots) if (!ALLOWED_SLOTS.has(s)) fail(`unsupported lineup slot ${s}; callers must pass starter slots only`);
    for (const pos of POS) if (!(A && Number.isFinite(A.p_out?.[pos]) && Number.isFinite(A.p_stay?.[pos]))) fail(`availability rates missing for ${pos}`);
    for (const t of TAG_KEYS) if (!Number.isFinite(A?.p_tag?.[t])) fail(`availability p_tag.${t} missing or not finite`);
    if (!Number.isInteger(nSims) || nSims < 1) fail("nSims must be a positive integer");
    const W = weeks.length, N = nSims;
    const sims = new Map();
    for (const [id, p] of Object.entries(players || {})) {
      if (!POS.includes(p.position)) fail(`unknown position for ${id}`);
      const rows = weeks.map(w => {
        const r = p.weeks && p.weeks[w];
        if (!r || (r.status !== "play" && r.status !== "bye")) fail(`${id} has no projection for week ${w}; unknown is not zero`);
        if (r.status === "play") checkQ(r, `${id} week ${w}`);
        return r;
      });
      const tag = normalizeTag(p.tag), forced = new Set(forcedOut[id] || []);
      const firstOut = tag && Number.isFinite(A.p_tag?.[tag]) ? A.p_tag[tag] : A.p_out[p.position];
      const avail = new Uint8Array(N * W), pts = new Float64Array(N * W);
      const rand = mulberry32((seed ^ hash(id)) >>> 0);
      for (let s = 0; s < N; s++) {
        let out = false, started = false;
        for (let i = 0; i < W; i++) {
          const u1 = rand(), u2 = rand(), r = rows[i];
          if (r.status === "bye") continue;                 // state carries across a bye
          // Controller decision: a forced-out week doesn't feed the chain either --
          // the week itself is out (never available), but it's not evidence the
          // player is actually hurt, so it must not seed next week's transition.
          // Skip the state update exactly like a bye, after still marking the week
          // unavailable (avail stays 0, its default) and still consuming u1/u2 so
          // every later week's draw stays aligned regardless of forcedOut config.
          if (forced.has(weeks[i])) continue;
          const pOut = started ? (out ? A.p_stay[p.position] : A.p_out[p.position]) : firstOut;
          out = u1 < pOut; started = true;
          if (!out) { avail[s * W + i] = 1; pts[s * W + i] = drawPoints(r, u2); }
        }
      }
      sims.set(id, { id, position: p.position, rows, avail, pts });
    }
    // Replacement players: always available (you pick up someone who is playing),
    // ranked below every rostered player so they only fill otherwise-empty slots.
    const repl = weeks.map((w, i) => {
      const byPos = (replacement && replacement[w]) || {};
      const list = [];
      for (const pos of POS) (byPos[pos] || []).forEach((q, k) => {
        checkQ(q, `replacement ${pos} week ${w}`);
        const id = `~R:${pos}:${k}:${w}`;
        const rand = mulberry32((seed ^ hash(id)) >>> 0);
        const draws = new Float64Array(N); for (let s = 0; s < N; s++) { rand(); draws[s] = drawPoints(q, rand()); }
        list.push({ id, position: pos, p50: q.p50, draws, replacement: true });
      });
      return list;
    });
    // Controller decision (item 5): check every week's replacement pool up front --
    // replacement candidates ALONE must fill every slot. Rostered players only ever
    // add candidates on top (never remove replacement ones), so this guarantees
    // value() can never throw "no replacement" for any roster once the world builds.
    weeks.forEach((w, i) => {
      const probe = repl[i].map(r => ({ position: r.position, score: r.p50 }));
      const lu = ROS.bestLineup(probe, slots, c => c.score);
      if (!lu.starters.length) fail(`no replacement available for ${lu.unfillable} in week ${w}`);
    });
    const cache = new Map();
    function value(ids) {
      if (!Array.isArray(ids)) fail("ids must be an array");
      if (new Set(ids).size !== ids.length) fail("duplicate player in roster");
      const sortedIds = ids.slice().sort();
      const members = sortedIds.map(id => sims.get(id) || fail(`unknown player ${id}`));
      const key = JSON.stringify(sortedIds);
      if (cache.has(key)) return cache.get(key);
      const totals = new Float64Array(N), perWeek = new Array(W).fill(0);
      // Tie-break deterministically on (score desc, id asc) so which of two tied
      // players starts never depends on the caller's id order or on push order --
      // ros.js's internal sort is merely stable, it does not itself break ties.
      for (let s = 0; s < N; s++) {
        for (let i = 0; i < W; i++) {
          const cands = [];
          for (const m of members) if (m.avail[s * W + i]) cands.push({ id: m.id, position: m.position, score: m.rows[i].p50, pts: m.pts[s * W + i] });
          for (const r of repl[i]) cands.push({ id: r.id, position: r.position, score: r.p50 - 1e9, pts: r.draws[s] });
          const lu = ROS.bestLineup(cands, slots, c => c.score);
          // Guaranteed fillable by the upfront replacement check above; kept as a
          // defensive fallback rather than an expected path.
          if (!lu.starters.length) fail(`no replacement available for ${lu.unfillable} in week ${weeks[i]}`);
          let t = 0; for (const st of lu.starters) t += st.player.pts;
          totals[s] += t; perWeek[i] += t / N;
        }
      }
      const sorted = Float64Array.from(totals).sort();
      const out = { mean: totals.reduce((x, y) => x + y, 0) / N, p10: sorted[Math.floor(0.1 * (N - 1))],
                    p90: sorted[Math.floor(0.9 * (N - 1))], perWeek, totals };
      // perWeek and the result object are frozen against mutation. totals is a
      // Float64Array: Object.freeze() throws on a non-empty typed array (it can't
      // make integer-indexed elements non-writable), so it is documented
      // read-only instead -- callers must not write through it.
      Object.freeze(perWeek);
      Object.freeze(out);
      cache.set(key, out);
      return out;
    }
    return { value, weeks: weeks.slice(), nSims: N };
  }
  function compare(world, beforeIds, afterIds) {
    const b = world.value(beforeIds).totals, a = world.value(afterIds).totals, N = a.length;
    const diff = new Float64Array(N); let sum = 0, pos = 0;
    for (let s = 0; s < N; s++) { diff[s] = a[s] - b[s]; sum += diff[s]; if (diff[s] > 0) pos++; }
    diff.sort();
    return { mean: sum / N, p10: diff[Math.floor(0.1 * (N - 1))], p90: diff[Math.floor(0.9 * (N - 1))], pPositive: pos / N };
  }
  return Object.freeze({ createWorld, compare, drawPoints, normalizeTag, RosterSimError });
});
