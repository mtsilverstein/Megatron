// site/assets/bands.js
/* Quantile band geometry. Pure -- no DOM, no network -- so the node fixture
   can require it. Spec: docs/superpowers/specs/2026-08-09-ui-redesign-design.md

   WHY THIS IS NOT PAGE CODE. Two properties are what make bands comparable
   between rows, and both used to live inline in index.html where no test
   could see them:

     1. THE DOMAIN IS SHARED across every row on screen. A per-row domain
        stretches every player to full width, so a safe player and a volatile
        one look identical -- destroying the only thing the band is for.
     2. THE DOMAIN IS PINNED to one scoring lens, not the active one, so bars
        do not rescale when the user toggles PPR / half-PPR / standard.

   WHAT THE RIDGE MAY ASSERT. Three quantiles do not determine a density. A
   smooth curve drawn through p10/p50/p90 invents mass the model never
   estimated -- the same dishonesty as a flat rectangle, pointed the other
   way. So the path is a piecewise-linear silhouette through exactly the three
   known points: baseline at p10, apex at p50, baseline at p90, nothing
   beyond. Its asymmetry comes only from where the median really sits. */
(function (root, factory) {
  const B = factory();
  if (typeof window !== "undefined") window.Bands = B;
  if (typeof module !== "undefined" && module.exports) module.exports = B;
})(this, function () {

  // First lens present wins. `league` is the owner's actual scoring, which is
  // also the order the board arrives in, so the ruler and the ranking agree.
  const RULER_LENSES = ["league", "ppr"];

  // The path is emitted in a 0..100 box; callers set
  // viewBox="0 0 100 100" preserveAspectRatio="none" and scale with CSS.
  const VIEW = 100;
  const r2 = x => Math.round(x * VIEW * 1000) / 1000;

  function quantileGeometry(p10, p50, p90, domain) {
    const min = domain && Number.isFinite(domain.min) ? domain.min : 0;
    const max = domain && domain.max;
    if (!Number.isFinite(max) || max <= min) {
      throw new Error("bands.js: domain.max must be finite and greater than domain.min");
    }
    const span = max - min;
    const norm = v => (v - min) / span;

    const med = Number.isFinite(p50) ? norm(p50) : null;
    const hasBand = Number.isFinite(p10) && Number.isFinite(p90);

    if (!hasBand) {
      // Preserves bandBar's existing behaviour: tick only, no fill.
      return { ok: false, lo: null, med, hi: null, width: 0,
               medianOutside: false, path: null };
    }

    const lo = norm(p10), hi = norm(p90);
    const width = hi - lo;
    // Reported, never corrected. A median outside its own endpoints is an
    // upstream bug and must stay visible -- clamping it into range would hide
    // exactly the defect the eval harness exists to catch.
    const medianOutside = med !== null && (med < lo || med > hi);

    // Zero width has no shape to draw, and no apex to place.
    const path = (width > 0 && med !== null)
      ? `M ${r2(lo)} ${VIEW} L ${r2(med)} 0 L ${r2(hi)} ${VIEW} Z`
      : null;

    return { ok: true, lo, med, hi, width, medianOutside, path };
  }

  // rows: any array. pick(row) -> {p10,p50,p90}. ONE max over all of them.
  function sharedDomain(rows, pick) {
    let max = 0;
    for (const row of rows) {
      const q = pick(row) || {};
      const top = Number.isFinite(q.p90) ? q.p90 : q.p50;
      if (Number.isFinite(top) && top > max) max = top;
    }
    return { min: 0, max };
  }

  // The page's ruler. Pinned lens, chosen once from the data -- NOT the
  // user's active scoring toggle. `key` exists because the draft board nests
  // quantiles under `season_points` and the weekly page under `points`; both
  // must keep their pinning, so neither caller hardcodes a lens.
  function boardDomain(players, key = "season_points") {
    const first = players && players[0] && players[0][key];
    const lens = RULER_LENSES.find(k => first && first[k]) || "ppr";
    return sharedDomain(players, p => p[key][lens]);
  }

  return { quantileGeometry, sharedDomain, boardDomain, RULER_LENSES };
});
