/* Strict, linear skill-player scoring. Not yet a general-league advice adapter. */
(function () {
  "use strict";
  const stats = Object.freeze({pass_yd:"passing_yards", pass_td:"passing_tds",
    pass_int:"passing_interceptions", pass_int_td:"passing_pick_sixes",
    rush_yd:"rushing_yards", rush_td:"rushing_tds", rush_att:"carries",
    rec:"receptions", rec_yd:"receiving_yards", rec_td:"receiving_tds", fum_lost:"fumbles_lost"});
  function score(quantiles, scoring) {
    if (!scoring || typeof scoring !== "object" || Array.isArray(scoring)) throw Error("Missing scoring settings.");
    if (!quantiles?.p50 || (quantiles.p10 == null) !== (quantiles.p90 == null)) throw Error("Incomplete stat quantiles.");
    const bands = quantiles.p10 != null;
    let scored = false;
    const out = {p10:bands ? 0 : null,p50:0,p90:bands ? 0 : null};
    for (const [key, weight] of Object.entries(scoring)) {
      if (typeof weight !== "number" || !Number.isFinite(weight)) throw Error(`Invalid scoring weight: ${key}`);
      if (weight === 0) continue;
      if (!Object.hasOwn(stats, key)) throw Error(`Unsupported scoring category: ${key}`);
      scored = true;
      const stat = stats[key];
      const value = q => {
        const v = quantiles[q]?.[stat];
        if (typeof v !== "number" || !Number.isFinite(v)) throw Error(`Missing or invalid ${q} stat: ${stat}`);
        return v * weight;
      };
      out.p50 += value("p50");
      if (bands) { const lo=value("p10"), hi=value("p90"); out.p10+=Math.min(lo,hi); out.p90+=Math.max(lo,hi); }
    }
    if (!scored) throw Error("Missing active supported scoring categories.");
    if (Object.values(out).some(v => v !== null && !Number.isFinite(v))) throw Error("Scoring overflow.");
    return out;
  }
  const api = {score, stats, bandLabel:"Sign-coherent component bands; not calibrated coverage for custom scoring."};
  if (typeof module !== "undefined" && module.exports) module.exports=api;
  if (typeof window !== "undefined") window.LeagueScoring=api;
})();
