/* Shared remaining-season helpers: ONE exact lineup solver for every page that
   values a roster week by week, and the evaluation-text helper the pages print
   beside any rest-of-season number. No DOM, no fetch. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ROS = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";
  const POSITIONS = ["QB", "RB", "WR", "TE"];
  const FLEX_POS = ["RB", "WR", "TE"];
  const SLOT_ELIGIBLE = Object.freeze({
    QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"],
    FLEX: FLEX_POS.slice(), SUPER_FLEX: POSITIONS.slice(),
  });

  // Exact for the supported laminar slot family: dedicated position sets are
  // disjoint, FLEX contains RB/WR/TE, and SUPER_FLEX contains all of them.
  // Taking the best mandatory players first cannot hurt a broader slot; the
  // remaining broader slots then take the best remaining eligible scores.
  // Players whose score is null are skipped -- unknown is not zero -- and a slot
  // nobody can fill makes the whole lineup -Infinity rather than a partial sum.
  function pools(players, scoreOf) {
    const byPos = { QB: [], RB: [], WR: [], TE: [] };
    for (const p of players || []) {
      if (!byPos[p.position]) continue;
      const v = scoreOf(p);
      if (v === null || v === undefined || Number.isNaN(v)) continue;
      byPos[p.position].push({ player: p, points: v });
    }
    for (const pos of POSITIONS) byPos[pos].sort((a, b) => b.points - a.points);
    return byPos;
  }
  function need(slots) {
    const n = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPER_FLEX: 0 };
    for (const s of slots) { if (!(s in n)) throw new Error(`unsupported lineup slot ${s}`); n[s]++; }
    return n;
  }
  // The assignment itself; both public functions read it. Returns null when a
  // slot cannot be filled, naming the slot so callers can report it.
  function assign(players, slots, scoreOf) {
    const byPos = pools(players, scoreOf), n = need(slots);
    const chosen = { QB: [], RB: [], WR: [], TE: [], FLEX: [], SUPER_FLEX: [] };
    for (const pos of POSITIONS) {
      if (byPos[pos].length < n[pos]) return { unfillable: pos };
      chosen[pos] = byPos[pos].splice(0, n[pos]);
    }
    const flex = FLEX_POS.flatMap(pos => byPos[pos]).sort((a, b) => b.points - a.points);
    if (flex.length < n.FLEX) return { unfillable: "FLEX" };
    chosen.FLEX = flex.splice(0, n.FLEX);
    const superFlex = byPos.QB.concat(flex).sort((a, b) => b.points - a.points);
    if (superFlex.length < n.SUPER_FLEX) return { unfillable: "SUPER_FLEX" };
    chosen.SUPER_FLEX = superFlex.splice(0, n.SUPER_FLEX);
    return { chosen };
  }
  function lineupScore(players, slots, scoreOf) {
    const r = assign(players, slots, scoreOf);
    if (r.unfillable) return -Infinity;
    let total = 0;
    for (const k in r.chosen) for (const c of r.chosen[k]) total += c.points;
    return total;
  }
  function bestLineup(players, slots, scoreOf) {
    const r = assign(players, slots, scoreOf);
    if (r.unfillable) return { total: -Infinity, starters: [], unfillable: r.unfillable };
    const queues = {}; for (const k in r.chosen) queues[k] = r.chosen[k].slice();
    const starters = slots.map(slot => { const c = queues[slot].shift(); return { player: c.player, slot, points: c.points }; });
    return { total: starters.reduce((a, s) => a + s.points, 0), starters };
  }

  // Descriptive evaluation of the remaining-season projections, built from the
  // payload's block and never typed in; null fields print n/a rather than throw.
  // Body copied verbatim from waivermode.js (commit a359c0e) rather than a
  // paraphrase -- the fixture strings are pinned to that exact wording.
  function evaluationText(evaluation) {
    if (!evaluation || !Array.isArray(evaluation.horizons)) return ["no measured evaluation for this league's scoring"];
    const seasons = (evaluation.seasons || []), origins = (evaluation.origins || []);
    const span = seasons.length ? `${seasons[0]}–${seasons[seasons.length - 1]}` : "the evaluation seasons";
    const originText = origins.length ? ` (origins week ${origins.join(" and ")})` : "";
    const lines = [`Measured on ${span}${originText} against ${evaluation.baseline}:`];
    const num = x => Number.isFinite(x) ? x.toFixed(2) : "n/a";
    const count = n => Number.isFinite(n) ? n.toLocaleString("en-US") : "n/a";
    for (const h of evaluation.horizons) lines.push(`${h.horizon} week${h.horizon === 1 ? "" : "s"} ahead: model MAE ${num(h.model_mae)} vs baseline ${num(h.baseline_mae)} (${count(h.paired_forecasts)} paired forecasts)`);
    // The desk prices every horizon out to the roster's remaining schedule,
    // but only these measured horizons have a checked error; the diagnostic's
    // MAE is also only over players who recorded a game, not every forecast.
    const maxHorizon = evaluation.horizons.reduce((m, h) => Number.isFinite(h.horizon) && h.horizon > m ? h.horizon : m, -Infinity);
    if (Number.isFinite(maxHorizon)) {
      const outcomeRow = evaluation.horizons.find(h => h.horizon === 1) || evaluation.horizons[0];
      let scope = `Horizons beyond ${maxHorizon} weeks are not measured; errors are over players who recorded a game`;
      if (outcomeRow && Number.isFinite(outcomeRow.forecast_players)) {
        scope += ` (${count(outcomeRow.paired_forecasts)} of ${count(outcomeRow.forecast_players)} forecasts at ${outcomeRow.horizon} week${outcomeRow.horizon === 1 ? "" : "s"} ahead had an outcome)`;
      }
      lines.push(`${scope}.`);
    }
    if (evaluation.scoring_scope) lines.push(evaluation.scoring_scope);
    if (evaluation.limitation) lines.push(evaluation.limitation);
    return lines;
  }

  return Object.freeze({ SLOT_ELIGIBLE, lineupScore, bestLineup, evaluationText });
});
