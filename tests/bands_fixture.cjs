// tests/bands_fixture.cjs — run with: node tests/bands_fixture.cjs
const assert = require("assert");
const B = require("../site/assets/bands.js");

let n = 0;
const check = (label, fn) => { fn(); n++; };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps,
  `expected ${b}, got ${a}`);

const D = { min: 0, max: 400 };

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

check("the ridge touches exactly the three known points", () => {
  const g = B.quantileGeometry(100, 200, 300, D);
  // baseline at lo, apex at med, baseline at hi -- no tails, no curvature.
  assert.strictEqual(g.path, "M 25 100 L 50 0 L 75 100 Z");
  assert.ok(!/[CSQTA]/.test(g.path), "path must be piecewise-linear: no curves");
});

// The apex must sit at the MEDIAN, not at the midpoint of the band. The
// symmetric check above cannot tell those apart -- with lo=.25 and hi=.75 the
// midpoint IS the median -- so a mutation moving the apex to (lo+hi)/2 passes
// it unchanged. These quantiles are deliberately lopsided: median at .375 of
// the domain against a band midpoint of .625.
check("the ridge apex sits at the median, not the band midpoint", () => {
  const g = B.quantileGeometry(100, 150, 400, { min: 0, max: 400 });
  const apexX = Number(g.path.split(" L ")[1].split(" ")[0]);
  const midX = ((g.lo + g.hi) / 2) * 100;
  near(apexX, g.med * 100);
  assert.ok(Math.abs(apexX - midX) > 20,
    `apex ${apexX} must be far from band midpoint ${midX}`);
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
