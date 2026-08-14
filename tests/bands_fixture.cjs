// tests/bands_fixture.cjs — run with: node tests/bands_fixture.cjs
const assert = require("assert");
const B = require("../site/assets/bands.js");

let n = 0;
const check = (label, fn) => { fn(); n++; };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps,
  `expected ${b}, got ${a}`);

const D = { min: 0, max: 400 };

// --- independent checks on the drawn shape ---------------------------------
// Deliberately NOT reusing anything from bands.js beyond the pdf it exposes.
// The point of these is to measure the density and the emitted polygon from
// the outside, the way a reader of the chart would.

// Midpoint rule, not trapezoid: the density is genuinely discontinuous at the
// median, so a rule that samples the endpoints would pick the wrong branch
// there and report a 5e-4 mass error that is the integrator's, not the fit's.
// Midpoints never land on a limit of integration.
function integrate(f, a, b, steps = 40000) {
  const h = (b - a) / steps;
  let s = 0;
  for (let i = 0; i < steps; i++) s += f(a + (i + 0.5) * h);
  return s * h;
}

// ...and no cell may straddle the median either: one that did would average
// across the jump and charge the integrator's smearing to the fit.
const mass = (f, a, b, m) => (a < m && b > m)
  ? integrate(f, a, m) + integrate(f, m, b)
  : integrate(f, a, b);

// "M x y L x y ... L x y Z" -> [[x,y], ...]
function pathPoints(d) {
  return d.replace(/[MLZ]/g, " ").trim().split(/\s+/).map(Number)
    .reduce((acc, v, i) => {
      if (i % 2 === 0) acc.push([v]); else acc[acc.length - 1].push(v);
      return acc;
    }, []);
}

// Area under the emitted silhouette between two x fractions of the box.
// Height is (VIEW - y) because y=0 is the top.
function drawnArea(pts, xFrom, xTo) {
  let a = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (x0 < xFrom - 1e-9 || x1 > xTo + 1e-9) continue;
    a += (x1 - x0) * ((100 - y0) + (100 - y1)) / 2;
  }
  return a;
}

check("positions are the value's fraction of the domain", () => {
  const g = B.quantileGeometry(100, 200, 300, D);
  near(g.lo, 0.25); near(g.med, 0.50); near(g.hi, 0.75);
  assert.strictEqual(g.ok, true);
});

check("width is hi - lo, not a per-row rescale", () => {
  const g = B.quantileGeometry(100, 200, 300, D);
  near(g.width, 0.5);
});

// THE regression guard. A per-row domain would stretch every player to full
// width and make these two identical -- exactly the bug that destroys the
// comparison the component exists to make. A test checking one row in
// isolation could never catch it.
check("two different players on ONE shared domain differ", () => {
  const gibbs = B.quantileGeometry(63.5, 219.0, 409.3, { min: 0, max: 409.3 });
  const chase = B.quantileGeometry(100.3, 204.3, 315.1, { min: 0, max: 409.3 });
  assert.ok(gibbs.width > chase.width,
    "Gibbs' band must be wider than Chase's on a shared domain");
  assert.ok(gibbs.lo < chase.lo, "Gibbs' floor must sit lower");
});

check("median position reflects real skew, not the midpoint", () => {
  // Bijan, PPR: (226.4-67.8)/(401.0-67.8) = 0.4760...
  const g = B.quantileGeometry(67.8, 226.4, 401.0, { min: 0, max: 401.0 });
  const withinBand = (g.med - g.lo) / (g.hi - g.lo);
  assert.ok(Math.abs(withinBand - 0.476) < 0.001,
    `median should sit at 47.6% of the band, got ${(withinBand * 100).toFixed(1)}%`);
});

// ---------------------------------------------------------------------------
// The fit. These are the properties the old triangle got wrong, so they are
// asserted on the density itself, by integration, before anything is drawn.
// ---------------------------------------------------------------------------

// Lopsided on purpose: the upper half is 5x the width of the lower one.
const SKEW = [100, 150, 400];

check("the fit reproduces all three predicted quantiles exactly", () => {
  const f = B.splitNormal(...SKEW);
  const F = x => mass(f.pdf, -5000, x, 150);
  near(F(100), 0.10, 1e-6);
  near(F(150), 0.50, 1e-6);
  near(F(400), 0.90, 1e-6);
});

check("the fit is a distribution: total mass 1", () => {
  const f = B.splitNormal(...SKEW);
  near(mass(f.pdf, -5000, 5000, 150), 1, 1e-6);
});

// THE regression this shape exists for. p10..p50 and p50..p90 each hold 40%,
// so the halves must have EQUAL mass however unequal their widths. A triangle
// gives area in proportion to width -- here 16.7% / 83.3% against a truth of
// 50/50, an error of 33 points. Anything width-proportional fails this.
check("equal mass each side of the median, at a 5x width difference", () => {
  const f = B.splitNormal(...SKEW);
  const left = integrate(f.pdf, -5000, 150);
  const right = integrate(f.pdf, 150, 5000);
  assert.ok((f.sdHi / f.sdLo) > 4.9, "the halves must be lopsided for this to bite");
  near(left, 0.5, 1e-4);
  near(right, 0.5, 1e-4);
});

// Equal mass over unequal spread means unequal height. The step at the median
// is that, and it is exactly the sd ratio -- a property, not an artefact.
check("the density steps at the median by the ratio of the two sds", () => {
  const f = B.splitNormal(...SKEW);
  near(f.pdfSide(150, false) / f.pdfSide(150, true), f.sdHi / f.sdLo, 1e-12);
});

// p10 == p50 says the lower half of the outcomes are all the same number: a
// point mass, which has no width and therefore no density. The lower branch
// must report exactly nothing rather than substitute a spike, or `pdf` starts
// handing consumers a number with no units behind it.
check("a zero-width half has no density, and the other half keeps its mass", () => {
  const f = B.splitNormal(120, 120, 300);
  assert.strictEqual(f.sdLo, 0);
  assert.strictEqual(f.pdfSide(120, false), 0);
  assert.strictEqual(f.pdfSide(90, false), 0);
  near(integrate(f.pdf, 120, 5000), 0.5, 1e-6);
  near(integrate(f.pdf, -5000, 120), 0, 1e-12);
});

check("a median outside its own endpoints is refused, not drawn", () => {
  assert.strictEqual(B.splitNormal(100, 50, 300), null);   // below its floor
  assert.strictEqual(B.splitNormal(100, 350, 300), null);  // above its ceiling
  assert.strictEqual(B.splitNormal(200, 200, 200), null);  // no width at all
});

// ---------------------------------------------------------------------------
// The drawing. Measured off the emitted path string.
// ---------------------------------------------------------------------------

// Wide enough that neither tail is clipped, so the drawn polygon can be held
// to the same 50/50 the density is.
const WIDE = { min: 0, max: 1000 };

check("the ridge is piecewise-linear and stays inside the box", () => {
  const g = B.quantileGeometry(...SKEW, WIDE);
  assert.ok(!/[CSQTA]/.test(g.path), "path must be piecewise-linear: no curves");
  for (const [x, y] of pathPoints(g.path)) {
    assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 100,
      `point ${x},${y} escapes the 0..100 box`);
  }
});

check("the ridge starts and ends on the baseline and touches the top", () => {
  const pts = pathPoints(B.quantileGeometry(...SKEW, WIDE).path);
  near(pts[0][1], 100);
  near(pts[pts.length - 1][1], 100);
  assert.ok(pts.some(p => p[1] === 0), "the peak must reach the top of the box");
});

// The triangle asserted zero density outside p10..p90 -- 20% of every season
// drawn as impossible. The fill must now run past both endpoints.
check("the ridge has tails: it extends past p10 and past p90", () => {
  const g = B.quantileGeometry(...SKEW, WIDE);
  const xs = pathPoints(g.path).map(p => p[0]);
  assert.ok(Math.min(...xs) < g.lo * 100 - 1,
    "fill must continue below the floor");
  assert.ok(Math.max(...xs) > g.hi * 100 + 1,
    "fill must continue above the ceiling");
});

// Same claim as the density test above, re-made against the pixels: whatever
// normalisation and sampling do, they must not reintroduce the width bias.
check("the DRAWN areas either side of the median are equal", () => {
  const g = B.quantileGeometry(...SKEW, WIDE);
  const pts = pathPoints(g.path);
  const medX = g.med * 100;
  const share = drawnArea(pts, 0, medX)
              / (drawnArea(pts, 0, medX) + drawnArea(pts, medX, 100));
  assert.ok(Math.abs(share - 0.5) < 0.02,
    `median must split the ink 50/50, got ${(share * 100).toFixed(1)}%`);
});

// The median is sampled once per branch, so the path carries a vertical edge
// there. Sampling it once instead would silently average the two halves
// together -- no test above would notice, and the median would stop being
// visible in the shape at all.
check("the path holds a vertical step at the median, sized by the sds", () => {
  const g = B.quantileGeometry(...SKEW, WIDE);
  const f = B.splitNormal(...SKEW);
  const pts = pathPoints(g.path);
  const medX = g.med * 100;
  const i = pts.findIndex((p, k) => k > 0
    && Math.abs(p[0] - medX) < 0.02 && Math.abs(pts[k - 1][0] - medX) < 0.02);
  assert.ok(i > 0, "two consecutive points must share the median's x");
  const hLeft = 100 - pts[i - 1][1], hRight = 100 - pts[i][1];
  assert.ok(hLeft > hRight, "the taller half must be the narrower one");
  near(hLeft / hRight, f.sdHi / f.sdLo, 0.02);
});

// A shared domain narrower than the tails must cut the shape, never rescale
// it: the ruler is what makes rows comparable.
check("tails are clipped by the domain, not squeezed into it", () => {
  const wide = B.quantileGeometry(...SKEW, WIDE);
  const tight = B.quantileGeometry(...SKEW, { min: 0, max: 400 });
  const xw = pathPoints(wide.path).map(p => p[0]);
  const xt = pathPoints(tight.path).map(p => p[0]);
  assert.ok(Math.max(...xt) <= 100, "clipped fill must stop at the box edge");
  near(Math.max(...xt), 100, 0.01);              // cut off, flush with the edge
  assert.ok(Math.max(...xw) < 90, "the wide domain must NOT be clipped");
  // Read back to points: the fill starts at the same REAL value under both
  // rulers, at 3.5 lower sds below the median. Only the ruler changed.
  const start = 150 - 3.5 * (150 - 100) / 1.2815515655446004;
  near(xw[0] / 100 * WIDE.max, start, 0.05);
  near(xt[0] / 100 * 400, start, 0.05);
});

// 6 of 695 live rows have p50 == p10. The lower half is then a point mass with
// no area, and the honest picture is a wall at the median rather than a shape
// invented to fill the gap.
check("a zero-width lower half draws a wall at the median, not a hump", () => {
  const g = B.quantileGeometry(120, 120, 300, D);
  const pts = pathPoints(g.path);
  const medX = g.med * 100;
  assert.ok(pts.every(p => p[0] >= medX - 0.01),
    "nothing may be drawn below the median when p10 == p50");
  near(pts[0][0], medX, 0.01);
  near(pts[0][1], 100);        // starts on the baseline...
  near(pts[1][0], medX, 0.01); // ...and rises vertically at the same x
  assert.ok(pts[1][1] < 1, "the wall must go straight to the peak");
});

check("zero-width band renders a tick and no fill", () => {
  const g = B.quantileGeometry(200, 200, 200, D);
  near(g.width, 0);
  assert.strictEqual(g.path, null);
  assert.strictEqual(g.ok, true);
  near(g.med, 0.5);
});

check("a median outside its endpoints is reported, never clamped", () => {
  const g = B.quantileGeometry(100, 50, 300, D);   // upstream bug
  assert.strictEqual(g.medianOutside, true);
  near(g.med, 0.125);            // where it ACTUALLY falls
  assert.ok(g.med < g.lo, "must not be clamped into the band");
});

check("missing quantiles give a tick only", () => {
  const g = B.quantileGeometry(null, 200, null, D);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.path, null);
  assert.strictEqual(g.lo, null);
  near(g.med, 0.5);
});

check("a bad domain throws instead of dividing by zero", () => {
  assert.throws(() => B.quantileGeometry(1, 2, 3, { min: 0, max: 0 }), /domain/);
  assert.throws(() => B.quantileGeometry(1, 2, 3, null), /domain/);
});

check("sharedDomain takes one max over ALL rows", () => {
  const rows = [{ q: { p90: 100 } }, { q: { p90: 350 } }, { q: { p90: 200 } }];
  const d = B.sharedDomain(rows, r => r.q);
  assert.strictEqual(d.max, 350);
  assert.strictEqual(d.min, 0);
});

check("sharedDomain falls back to p50 when p90 is absent", () => {
  const rows = [{ q: { p50: 120 } }, { q: { p90: 90 } }];
  assert.strictEqual(B.sharedDomain(rows, r => r.q).max, 120);
});

// The pinned-lens guard. index.html deliberately measures the ruler against
// ONE lens so bars don't rescale when the user toggles PPR/half/standard.
check("boardDomain pins to the league lens, ignoring other lenses", () => {
  const players = [
    { season_points: { league: { p90: 300 }, ppr: { p90: 999 },
                       half_ppr: { p90: 10 } } },
    { season_points: { league: { p90: 250 }, ppr: { p90: 998 },
                       half_ppr: { p90: 20 } } },
  ];
  assert.strictEqual(B.boardDomain(players).max, 300);
});

// `league` deliberately NOT first: object insertion order must not be what
// makes this pass, or the RULER_LENSES pinning could be silently dropped.
check("boardDomain pins to league even when ppr is listed first", () => {
  const players = [{ season_points: { ppr: { p90: 999 }, league: { p90: 300 } } }];
  assert.strictEqual(B.boardDomain(players).max, 300);
});

check("boardDomain falls back to ppr when there is no league lens", () => {
  const players = [{ season_points: { ppr: { p90: 275 } } }];
  assert.strictEqual(B.boardDomain(players).max, 275);
});

// weekly.html holds its quantiles under `points`, not `season_points`, and
// pins its own ruler the same way (weekly.html:66). Without this parameter a
// caller would have to reach for sharedDomain and hardcode a lens, silently
// dropping the pinning on that page.
check("boardDomain reads an alternate key and still pins the lens", () => {
  const players = [
    { points: { league: { p90: 40 }, ppr: { p90: 900 } } },
    { points: { league: { p90: 55 }, ppr: { p90: 800 } } },
  ];
  assert.strictEqual(B.boardDomain(players, "points").max, 55);
});

console.log(`bands_fixture: ${n} groups OK`);
