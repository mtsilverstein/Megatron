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

   WHAT THE RIDGE MAY ASSERT. Three quantiles do not determine a density, so
   the ridge cannot avoid an assumption -- it can only choose an honest one.
   This file used to draw a triangle: baseline at p10, apex at p50, baseline
   at p90, nothing beyond. That looked like the conservative choice and was
   not. It asserted two false things:

     1. ZERO DENSITY OUTSIDE THE BAND. 10% of seasons land below p10 and 10%
        above p90. The triangle drew that 20% as impossible.
     2. THE WRONG SPLIT OF MASS. p10..p50 and p50..p90 each hold exactly 40%,
        so the two halves must have EQUAL area. A triangle's area goes as its
        width, so the wider half always looked likelier. Measured over the 689
        banded rows of the live board, the median row read 8.9 percentage
        points off; the worst read 15/85 where the truth is 50/50.

   So the fit is a two-piece (split) normal joined at the median: a half
   normal of sd (p50-p10)/z on the left and (p90-p50)/z on the right, z =
   Phi^-1(0.9). Each half carries mass 0.5, so the total is 1, the split is
   50/50 by construction, and F(p10)=0.10, F(p50)=0.50, F(p90)=0.90 hold
   EXACTLY -- the fit reproduces the three numbers it was given and invents
   only the shape between and beyond them.

   WHAT IT STILL ASSUMES, stated so the caption can state it too: normality
   within each half. Two consequences visible on screen. (a) The density steps
   at the median, because equal mass over unequal spread means unequal height
   -- sd ratio 1.1x-1.3x across the top 60 rows, so the step is a notch, not a
   cliff; that vertical edge IS the median. (b) A normal has no floor at zero
   while fantasy points do, so the left tail is clipped at the domain edge --
   a mean 3.5% of mass over the top 60 rows. Clipping is the honest response;
   silently rescaling to hide it is not. */
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
  // 0.01 of the box is ~0.035px at the ridge's rendered width. Rounding finer
  // only lengthens the string.
  const rd = v => Math.round(v * 100) / 100;

  const Z90 = 1.2815515655446004;          // Phi^-1(0.90)
  const INV_SQRT_2PI = 0.3989422804014327;

  // How far the drawn tails run, in sd. Phi(3.5) = 0.99977, so 0.023% of each
  // tail is left off the page -- narrower than one screen pixel.
  const TAIL_SDS = 3.5;
  // Samples per half. 80 points across a ~350px ridge is a segment every 4px;
  // a Gaussian shoulder is straight at that scale.
  const STEPS = 40;

  /* The split-normal fit. Returns null rather than guessing when the three
     numbers cannot describe a distribution -- a median outside its own
     endpoints is an upstream bug, and drawing a shape for it would hide the
     defect the eval harness exists to catch.

     `pdfSide` takes the branch explicitly. At exactly the median the two
     halves disagree, and which one you get decides whether the step is drawn
     or averaged away, so the caller must say. `pdf` picks for you. */
  function splitNormal(p10, p50, p90) {
    if (!Number.isFinite(p10) || !Number.isFinite(p50) || !Number.isFinite(p90)) {
      return null;
    }
    const sdLo = (p50 - p10) / Z90;
    const sdHi = (p90 - p50) / Z90;
    if (sdLo < 0 || sdHi < 0 || sdLo + sdHi === 0) return null;

    // A zero-width half is a point mass at the median: no area to draw, so the
    // silhouette shows a vertical wall there. 6 of 695 live rows have p50 ==
    // p10 and this is what they get.
    const pdfSide = (x, hi) => {
      const sd = hi ? sdHi : sdLo;
      if (sd <= 0) return 0;
      const z = (x - p50) / sd;
      return INV_SQRT_2PI * Math.exp(-0.5 * z * z) / sd;
    };
    return {
      median: p50, sdLo, sdHi, pdfSide,
      pdf: x => pdfSide(x, x >= p50),
    };
  }

  /* The silhouette, clipped to the shared domain and normalised so this row's
     tallest point touches the top of the box. HEIGHT THEREFORE CARRIES NO
     CROSS-ROW MEANING; position and width do, and both are measured on the
     shared domain. Normalising by area instead would make every narrow band a
     hairline and every wide one invisible. */
  function densityPath(fit, dmin, dmax, norm) {
    const m = fit.median;
    const x0 = Math.max(dmin, m - TAIL_SDS * fit.sdLo);
    const x1 = Math.min(dmax, m + TAIL_SDS * fit.sdHi);
    if (!(x1 > x0)) return null;

    // Sampled uniformly in x so segments are even on screen, and each half
    // sampled up to ITS OWN edge of the median -- the median appears twice,
    // once per branch.
    const pts = [];
    if (m > x0) {
      for (let i = 0; i <= STEPS; i++) {
        const x = x0 + (m - x0) * (i / STEPS);
        pts.push([x, fit.pdfSide(x, false)]);
      }
    }
    if (x1 > m) {
      for (let i = 0; i <= STEPS; i++) {
        const x = m + (x1 - m) * (i / STEPS);
        pts.push([x, fit.pdfSide(x, true)]);
      }
    }
    let peak = 0;
    for (const p of pts) if (p[1] > peak) peak = p[1];
    if (!(peak > 0)) return null;

    const d = [`M ${rd(norm(x0) * VIEW)} ${VIEW}`];
    for (const p of pts) {
      d.push(`L ${rd(norm(p[0]) * VIEW)} ${rd(VIEW * (1 - p[1] / peak))}`);
    }
    d.push(`L ${rd(norm(x1) * VIEW)} ${VIEW}`, "Z");
    return d.join(" ");
  }

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

    // Zero width has no shape to draw, and a broken median has none worth
    // drawing; splitNormal reports both by returning null.
    const fit = (width > 0 && med !== null) ? splitNormal(p10, p50, p90) : null;
    const path = fit ? densityPath(fit, min, max, norm) : null;

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

  return { quantileGeometry, splitNormal, sharedDomain, boardDomain,
           RULER_LENSES };
});
