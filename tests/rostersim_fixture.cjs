// tests/rostersim_fixture.cjs — run: node tests/rostersim_fixture.cjs
const assert = require("node:assert/strict");
const S = require("../site/assets/rostersim.js");

const A = { p_out: { QB: 0.05, RB: 0.08, WR: 0.06, TE: 0.06 },
            p_stay: { QB: 0.6, RB: 0.65, WR: 0.6, TE: 0.6 },
            p_tag: { Out: 0.7, Doubtful: 0.5, Questionable: 0.15, IR: 0.9 } };
const WEEKS = [4, 5, 6, 7, 8];
const SLOTS = ["QB", "RB", "WR", "FLEX"];
const q = (p50, spread = 6) => ({ status: "play", p10: Math.max(0, p50 - spread), p50, p90: p50 + spread * 1.5 });
const pl = (position, p50, extra = {}) => ({ position, weeks: Object.fromEntries(WEEKS.map(w => [w, q(p50)])), ...extra });
const repl = Object.fromEntries(WEEKS.map(w => [w, { QB: [q(10)], RB: [q(6), q(5)], WR: [q(6), q(5)], TE: [q(4)] }]));
const base = over => mk({ weeks: WEEKS, slots: SLOTS, availability: A, replacement: repl, nSims: 2000, seed: 7,
  players: { qb1: pl("QB", 20), qb2: pl("QB", 16), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) }, ...over });
// v2: every world needs a copula table and real replacement ids. mk() adds rho = 0 and a stable id per
// (position, rank) to replacement entries that lack one; the v2 groups below call S.createWorld directly.
const mk = cfg => S.createWorld({ copula: { rho: S.ZERO_RHO }, ...cfg,
  replacement: Object.fromEntries(Object.entries(cfg.replacement || {}).map(([w, byPos]) => [w,
    Object.fromEntries(Object.entries(byPos).map(([pos, l]) => [pos, l.map((r, k) => ({ id: `R${pos}${k}`, ...r }))]))])) });
let n = 0; const check = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };

check("quantiles", () => {
  const Q = { p10: 3, p50: 12, p90: 30 }, xs = [];
  for (let i = 1; i < 20000; i++) xs.push(S.drawPoints(Q, i / 20000));
  xs.sort((a, b) => a - b);
  assert.ok(Math.abs(xs[1999] - 3) < 0.05 && Math.abs(xs[9999] - 12) < 0.05 && Math.abs(xs[17999] - 30) < 0.05);
  assert.ok(S.drawPoints({ p10: 2, p50: 10, p90: 20 }, 1e-9) >= 0, "floor at min(0, p10)");

  // Fix round 1 item 6: u=0 must not produce NaN. invNorm(0) = -Infinity, and when
  // p10 === p50 the spread s is 0, so -Infinity * 0 = NaN unless drawPoints clamps u.
  assert.ok(Number.isFinite(S.drawPoints({ p10: 5, p50: 5, p90: 9 }, 0)), "u=0 must be finite, not NaN");

  // Floor = min(0, 2*p10): continuous at p10 = 0 (a 0.01 change in p10 must not
  // move the mean by more than a few hundredths), and never above p10, so p10 is
  // exact. `floor = p10`, `min(0, p10)` and the old `p10>=0 ? 0 : 2*p10-p50` all fail.
  const Qneg = { p10: -2, p50: 5, p90: 15 };
  const floorExpected = 2 * Qneg.p10; // -4
  assert.ok(Math.abs(S.drawPoints(Qneg, 1e-9) - floorExpected) < 1e-6,
    `floor should be ${floorExpected} (min(0, 2*p10)), not p10 (${Qneg.p10})`);
  const xsNeg = []; for (let i = 1; i < 20000; i++) xsNeg.push(S.drawPoints(Qneg, i / 20000));
  const meanAt = p10 => { let t = 0; for (let i = 1; i < 20000; i++) t += S.drawPoints({ p10, p50: 10, p90: 20 }, i / 20000); return t / 19999; };
  assert.ok(Math.abs(meanAt(0) - meanAt(-0.01)) < 0.02, `floor must be continuous at p10 = 0: ${meanAt(0)} vs ${meanAt(-0.01)}`);
  xsNeg.sort((a, b) => a - b);
  assert.ok(Math.abs(xsNeg[1999] - Qneg.p10) < 0.05, `empirical p10 should stay near ${Qneg.p10}, got ${xsNeg[1999]}`);
});
check("determinism", () => {
  const a = base().value(["qb1", "rb1", "wr1", "wr2"]), b = base().value(["qb1", "rb1", "wr1", "wr2"]);
  assert.equal(a.mean, b.mean); assert.deepEqual([...a.totals.slice(0, 20)], [...b.totals.slice(0, 20)]);
});

// Fix round 1 item 1: value() must not depend on the caller's id order when two
// players tie on score. A single WR slot forces a genuine contest between w1/w2.
const tieSlots = ["QB", "WR"];
const tieWorld = () => mk({ weeks: WEEKS, slots: tieSlots, availability: A, replacement: repl, nSims: 2000, seed: 11,
  players: { qb: pl("QB", 20), w1: pl("WR", 13), w2: pl("WR", 13), te: pl("TE", 50) } });
check("tieOrder", () => {
  // (a) two FRESH worlds so the cache can't mask an order-dependence bug: each
  // world's value() call is the only computation that ever happens for its ids.
  const worldA = tieWorld(), worldB = tieWorld();
  const vA = worldA.value(["qb", "w1", "w2"]).mean;
  const vB = worldB.value(["qb", "w2", "w1"]).mean;
  assert.equal(vA, vB, "value() must not depend on the caller's id order when scores tie");

  // (b) in one world, reordering w1/w2 and adding a never-starting TE (no TE or
  // FLEX slot exists in tieSlots) must be an exact no-op.
  const worldC = tieWorld();
  const d = S.compare(worldC, ["qb", "w1", "w2"], ["te", "w2", "qb", "w1"]);
  assert.equal(d.mean, 0); assert.equal(d.p10, 0); assert.equal(d.p90, 0);
});

// Fix round 1 item 2: crn rewritten so it can't pass through the cache. The
// original version compared two permutations of the SAME id set, which hash to
// the same cache key, so compare() only ever ran ONE computation and diffed it
// against itself -- it could never fail no matter how buggy value() was.
// This version compares different id sets (3 ids vs 4), so both value() calls
// really run, and confirms a player who can never start (no TE/FLEX slot here)
// is an exact no-op.
const crnSlots = ["QB", "RB", "WR"];
const crnWorld = () => mk({ weeks: WEEKS, slots: crnSlots, availability: A, replacement: repl, nSims: 2000, seed: 7,
  players: { qb1: pl("QB", 20), rb1: pl("RB", 14), wr1: pl("WR", 13), te1: pl("TE", 999) } });
check("crn", () => {
  const w = crnWorld();
  const d = S.compare(w, ["qb1", "rb1", "wr1"], ["qb1", "rb1", "wr1", "te1"]);
  assert.equal(d.mean, 0, "a player who can never start must be an exact no-op");
  assert.equal(d.p10, 0); assert.equal(d.p90, 0);
});

check("backupHasPositiveBoundedValue", () => {
  const w = base();
  const d = S.compare(w, ["qb1", "rb1", "wr1", "wr2"], ["qb1", "qb2", "rb1", "wr1", "wr2"]);
  assert.ok(d.mean > 0, "a backup QB must be worth something when the starter can miss games");
  // Fix round 1 item 10: the loose 30-point upper bound is dropped. The exact
  // analytic bound now lives in the "chain" group below (degenerate p10=p50=p90
  // quantiles let perWeek be derived from first principles instead of eyeballed).
});
check("noAbsenceNoBackupValue", () => {
  const zero = { p_out: { QB: 0, RB: 0, WR: 0, TE: 0 }, p_stay: { QB: 0, RB: 0, WR: 0, TE: 0 }, p_tag: A.p_tag };
  const w = base({ availability: zero });
  const d = S.compare(w, ["qb1", "rb1", "wr1", "wr2"], ["qb1", "qb2", "rb1", "wr1", "wr2"]);
  assert.equal(d.mean, 0, "a QB who never starts adds nothing when nobody misses games");
});
check("forcedOutAndBye", () => {
  const byeWeeks = Object.fromEntries(WEEKS.map(w => [w, w === 6 ? { status: "bye" } : q(20)]));
  const w = base({ players: { qb1: { position: "QB", weeks: byeWeeks }, rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) },
                   forcedOut: { rb1: [4, 5, 6, 7, 8] } });
  const v = w.value(["qb1", "rb1", "wr1", "wr2"]);
  assert.ok(Number.isFinite(v.mean), "bye and forced-out weeks fall back to replacement, never NaN or zero lineups");
  assert.ok(v.perWeek[2] < v.perWeek[1], "the bye week scores less (replacement QB)");
});

// Fix round 1 items 3 and 4: degenerate quantiles (p10 = p50 = p90) make points
// deterministic, so perWeek[i] = 20 - 10*P(out_i) exactly (up to Monte Carlo
// noise), letting us pin the availability chain analytically.
check("chain", () => {
  const CW = [101, 102, 103, 104];
  const deg = v => ({ status: "play", p10: v, p50: v, p90: v });
  const replDeg = Object.fromEntries(CW.map(w => [w, { QB: [deg(10)] }]));
  const N = 20000, SEED = 42;
  const mkWorld = (tag, over) => mk({ weeks: CW, slots: ["QB"], availability: A, replacement: replDeg, nSims: N, seed: SEED,
    players: { qb: { position: "QB", tag, weeks: Object.fromEntries(CW.map(w => [w, deg(20)])) } }, ...over });

  const wPlain = mkWorld(undefined);
  const pw = wPlain.value(["qb"]).perWeek;
  const p1 = A.p_out.QB;
  assert.ok(Math.abs(pw[0] - (20 - 10 * p1)) < 0.15, `week1 untagged uses p_out: got ${pw[0]}`);
  const p2 = p1 * A.p_stay.QB + (1 - p1) * A.p_out.QB;
  assert.ok(Math.abs(pw[1] - (20 - 10 * p2)) < 0.15, `week2 transition formula: got ${pw[1]}`);

  const wTagged = mkWorld("Out");
  const pwT = wTagged.value(["qb"]).perWeek;
  assert.ok(Math.abs(pwT[0] - (20 - 10 * A.p_tag.Out)) < 0.15, `week1 tagged Out uses p_tag.Out: got ${pwT[0]}`);

  const wForced = mkWorld(undefined, { forcedOut: { qb: [CW[1]] } });
  const pwF = wForced.value(["qb"]).perWeek;
  assert.ok(Math.abs(pwF[1] - 10) < 1e-9, "a forced-out week is exactly the replacement value");

  const byePlayers = { qb: { position: "QB", weeks: Object.fromEntries(CW.map((w, i) => [w, i === 1 ? { status: "bye" } : deg(20)])) } };
  const wBye = mk({ weeks: CW, slots: ["QB"], availability: A, replacement: replDeg, nSims: N, seed: SEED, players: byePlayers });
  const pwB = wBye.value(["qb"]).perWeek;
  assert.ok(Math.abs(pwB[1] - 10) < 1e-9, "a bye week is exactly the replacement value");

  // Controller decision (item 4): forced-out weeks don't feed the chain -- the
  // week itself is out, but the availability state carries through unchanged,
  // exactly like a bye. wForced and wBye share the same seed and player id, so
  // week 1 is bit-identical between them and week 3 (index 2) must match too,
  // not just be statistically close.
  assert.ok(Math.abs(pwF[2] - pwB[2]) < 1e-6,
    `week3 P(out) must match the bye-equivalent world: forced=${pwF[2]} bye=${pwB[2]}`);
});

check("coverage", () => {
  const bad = pl("WR", 9); delete bad.weeks[7];
  assert.throws(() => base({ players: { qb1: pl("QB", 20), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: bad } }), /wr2.*week 7/);
});
// Fix round 1 item 5: the replacement pool is now checked upfront in createWorld
// (replacement candidates ALONE must fill every slot, every week), so this now
// throws at createWorld instead of at value().
check("noReplacement", () => {
  const thin = Object.fromEntries(WEEKS.map(w => [w, { QB: [], RB: [q(6)], WR: [q(6)], TE: [] }]));
  assert.throws(() => base({ replacement: thin, forcedOut: { qb1: [5] } }), /no replacement/);
});
check("tagMapping", () => {
  assert.equal(S.normalizeTag("Out"), "Out"); assert.equal(S.normalizeTag("Sus"), "Out");
  assert.equal(S.normalizeTag("IR"), "IR"); assert.equal(S.normalizeTag("PUP"), "IR");
  assert.equal(S.normalizeTag("questionable"), "Questionable");
  for (const x of ["NA", "COV", null, undefined, ""]) assert.equal(S.normalizeTag(x), null);
  const w = base({ players: { qb1: pl("QB", 20, { tag: "NA" }), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) } });
  assert.ok(Number.isFinite(w.value(["qb1", "rb1", "wr1", "wr2"]).mean));
});
check("tagRaisesFirstWeekMiss", () => {
  const out = base({ players: { qb1: pl("QB", 20, { tag: "Out" }), qb2: pl("QB", 16), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) } });
  const clean = base();
  const withBackup = w => S.compare(w, ["qb1", "rb1", "wr1", "wr2"], ["qb1", "qb2", "rb1", "wr1", "wr2"]).mean;
  assert.ok(withBackup(out) > withBackup(clean), "a starter tagged Out makes his backup worth more");
});
check("validation", () => {
  const w = base();
  assert.throws(() => w.value(["qb1", "qb1"]), /duplicate/);
  assert.throws(() => w.value(["nobody"]), /unknown player/);
  assert.throws(() => mk({ weeks: WEEKS, slots: SLOTS, availability: A, replacement: repl,
    players: { x: { position: "QB", weeks: Object.fromEntries(WEEKS.map(w2 => [w2, { status: "play", p10: 9, p50: 5, p90: 20 }])) } } }), /quantiles/);

  // Fix round 1 item 8: validate at createWorld.
  const noQuestionable = { p_out: A.p_out, p_stay: A.p_stay, p_tag: { Out: 0.7, Doubtful: 0.5, IR: 0.9 } };
  assert.throws(() => mk({ weeks: WEEKS, slots: SLOTS, availability: noQuestionable, replacement: repl, players: {} }),
    /p_tag/i, "all four p_tag keys must be present and finite");
  assert.throws(() => mk({ weeks: WEEKS, slots: ["QB", "BN"], availability: A, replacement: repl, players: {} }),
    /slot/i, "BN is not a starter slot -- callers must pass starter slots only");
  assert.throws(() => mk({ weeks: WEEKS, slots: SLOTS, availability: A, replacement: repl, players: {}, nSims: 0 }),
    /nSims/i, "nSims must be a positive integer");
});
check("timing", () => {
  const players = {}; const ids = [];
  for (let i = 0; i < 32; i++) { const pos = ["QB", "RB", "WR", "TE"][i % 4]; players[`p${i}`] = pl(pos, 5 + (i % 11)); ids.push(`p${i}`); }
  const WK = Array.from({ length: 14 }, (_, i) => i + 4);
  // Fix round 1 item 5: with the upfront "replacement alone fills every slot"
  // invariant, RB/WR need a 3rd bench candidate each so 2 FLEX slots stay
  // fillable after the 2 dedicated RB and 2 dedicated WR slots are taken.
  const r14 = Object.fromEntries(WK.map(w => [w, { QB: [q(10)], RB: [q(6), q(5), q(4)], WR: [q(6), q(5), q(4)], TE: [q(4)] }]));
  for (const id of ids) players[id].weeks = Object.fromEntries(WK.map(w => [w, q(5 + (Number(id.slice(1)) % 11))]));
  const t0 = Date.now();
  const w = mk({ weeks: WK, slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX"], availability: A,
                            replacement: r14, players, nSims: 2000, seed: 3 });
  S.compare(w, ids.slice(0, 16), ids.slice(0, 15).concat(ids[20]));
  S.compare(w, ids.slice(16), ids.slice(17).concat(ids[0]));
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `trade comparison took ${ms} ms (budget 1500 ms in node)`);
});

// ---- v2 groups: Gaussian copula season factor, keyed streams, replacement identity ----------------------------
const one = (w = [1], qq = { p10: 4, p50: 10, p90: 20 }) => ({ position: "WR", weeks: Object.fromEntries(w.map(x => [x, { status: "play", ...qq }])) });
const NOABS = { p_out: { QB: 0, RB: 0, WR: 0, TE: 0 }, p_stay: { QB: 0, RB: 0, WR: 0, TE: 0 }, p_tag: A.p_tag };
const rep1 = ws => Object.fromEntries(ws.map(w => [w, { QB: [{ id: "rq", ...q(1) }], RB: [{ id: "rr", ...q(1) }], WR: [{ id: "rw", ...q(1) }], TE: [{ id: "rt", ...q(1) }] }]));
const rhoAll = r => ({ QB: r, RB: r, WR: r, TE: r });
const w1 = (weeks, rho, players, over = {}) => S.createWorld({ weeks, slots: ["WR"], availability: NOABS, replacement: rep1(weeks), nSims: 20000, seed: 5,
  copula: { rho: rhoAll(rho) }, players, ...over });
check("v2a weekly marginal", () => {
  const Q = { p10: 4, p50: 10, p90: 20 }, z = { p10: 0, p50: 0, p90: 0 }, WK = Array.from({ length: 12 }, (_, i) => i + 1);
  const rep0 = Object.fromEntries(WK.map(w => [w, { QB: [{ id: "rq", ...z }], RB: [{ id: "rr", ...z }], WR: [{ id: "rw", ...z }], TE: [{ id: "rt", ...z }] }]));
  for (const rho of [0, 0.2, 0.5]) {
    const tol = 0.02 * (Q.p90 - Q.p10);
    for (const wk of WK) {     // every week: zero the other weeks' quantiles so totals are that week's points alone
      const pl1 = { position: "WR", weeks: Object.fromEntries(WK.map(x => [x, { status: "play", ...(x === wk ? Q : z) }])) };
      const t = Array.from(w1(WK, rho, { a: pl1 }, { replacement: rep0, nSims: 8000 }).value(["a"]).totals).sort((x, y) => x - y), N = t.length;
      for (const [lvl, want] of [[0.1, Q.p10], [0.5, Q.p50], [0.9, Q.p90]]) assert.ok(Math.abs(t[Math.floor(lvl * (N - 1))] - want) <= tol, `rho ${rho} week ${wk} p${lvl * 100}: ${t[Math.floor(lvl * (N - 1))]} vs ${want}`);
    }
  }
});
const variance = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length; };
check("v2b season variance", () => {
  const WK = Array.from({ length: 12 }, (_, i) => i + 1), Q = { p10: 4, p50: 10, p90: 16 };   // symmetric
  const v = rho => variance(Array.from(w1(WK, rho, { a: one(WK, Q) }).value(["a"]).totals));
  const ratio = v(0.25) / v(0), want = 1 + 11 * 0.25;
  assert.ok(Math.abs(ratio / want - 1) < 0.10, `variance ratio ${ratio} vs ${want}`);
});
check("v2c availability identical across rho", () => {
  const WK = [1, 2, 3, 4, 5, 6], c = { p10: 7, p50: 7, p90: 7 }, z = { p10: 0, p50: 0, p90: 0 };
  const real = { p_out: { QB: 0.2, RB: 0.2, WR: 0.3, TE: 0.2 }, p_stay: { QB: 0.5, RB: 0.5, WR: 0.5, TE: 0.5 }, p_tag: A.p_tag };
  // constant points: a week scores 7 when he is available and 0 (zero-point replacement) otherwise, so perWeek and
  // totals expose the availability pattern exactly; it must not move with rho.
  const rep0 = Object.fromEntries(WK.map(w => [w, { QB: [{ id: "rq", ...z }], RB: [{ id: "rr", ...z }], WR: [{ id: "rw", ...z }], TE: [{ id: "rt", ...z }] }]));
  const val = rho => w1(WK, rho, { a: one(WK, c) }, { availability: real, replacement: rep0, nSims: 5000 }).value(["a"]);
  const x = val(0), y = val(0.4);
  assert.ok(x.perWeek.some(v => v > 0 && v < 7), "availability is actually exercised");
  assert.deepEqual(Array.from(x.perWeek), Array.from(y.perWeek));
  assert.deepEqual(Array.from(x.totals), Array.from(y.totals));
});
check("v2d identical rosters delta zero", () => {
  const w = S.createWorld({ weeks: WEEKS, slots: SLOTS, availability: A, copula: { rho: rhoAll(0.3) }, nSims: 2000, seed: 7,
    replacement: Object.fromEntries(WEEKS.map(k => [k, { QB: [{ id: "x1", ...q(10) }], RB: [{ id: "x2", ...q(6) }, { id: "x3", ...q(5) }], WR: [{ id: "x4", ...q(6) }, { id: "x5", ...q(5) }], TE: [{ id: "x6", ...q(4) }] }])),
    players: { qb1: pl("QB", 20), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) } });
  const ids = ["qb1", "rb1", "wr1", "wr2"], d = S.compare(w, ids, ids.slice().reverse());
  assert.equal(d.mean, 0); assert.equal(d.p10, 0); assert.equal(d.p90, 0);
  // compare() goes through one cached world, so also check two FRESH worlds agree draw for draw, and that a genuinely
  // different pair does NOT collapse to zero (a broken pairing or a dead compare would show here).
  const fresh = () => S.createWorld({ weeks: WEEKS, slots: SLOTS, availability: A, copula: { rho: rhoAll(0.3) }, nSims: 2000, seed: 7,
    replacement: Object.fromEntries(WEEKS.map(k => [k, { QB: [{ id: "x1", ...q(10) }], RB: [{ id: "x2", ...q(6) }, { id: "x3", ...q(5) }], WR: [{ id: "x4", ...q(6) }, { id: "x5", ...q(5) }], TE: [{ id: "x6", ...q(4) }] }])),
    players: { qb1: pl("QB", 20), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) } });
  assert.deepEqual(Array.from(fresh().value(ids).totals), Array.from(fresh().value(ids.slice().reverse()).totals));
  const e = S.compare(w, ids, ids.slice(0, 3));
  assert.ok(e.mean < -1, `dropping wr2 must cost points, got mean ${e.mean}`); assert.ok(e.p90 - e.p10 > 0, "non-identical pair has nonzero spread");
});
check("v2e order invariance", () => {
  const rp = Object.fromEntries(WEEKS.map(k => [k, { QB: [{ id: "x1", ...q(10) }], RB: [{ id: "x2", ...q(6) }, { id: "x3", ...q(6) }], WR: [{ id: "x4", ...q(6) }, { id: "x5", ...q(6) }], TE: [{ id: "x6", ...q(4) }] }]));
  const rev = Object.fromEntries(WEEKS.map(k => [k, Object.fromEntries(Object.entries(rp[k]).map(([pos, l]) => [pos, l.slice().reverse()]).reverse())]));
  const P = { qb1: pl("QB", 20), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) }, Pr = Object.fromEntries(Object.entries(P).reverse());
  const mkw = (players, replacement) => S.createWorld({ weeks: WEEKS, slots: SLOTS, availability: A, copula: { rho: rhoAll(0.3) }, nSims: 1000, seed: 9, players, replacement });
  const a = mkw(P, rp).value(["qb1", "rb1"]).totals, b = mkw(Pr, rev).value(["rb1", "qb1"]).totals;
  assert.deepEqual(Array.from(a), Array.from(b));
});
check("v2f replacement identity", () => {
  const WK = [1, 2], Q = { p10: 4, p50: 10, p90: 16 }, z = { p10: 0, p50: 0, p90: 0 };
  // The lone WR slot is always filled by replacement r1. Zeroing one week's quantiles isolates the other week's
  // draw, so the two totals are r1's week-1 and week-2 points under one shared factor.
  const corr = rho => {
    const mkW = rows => S.createWorld({ weeks: WK, slots: ["WR"], availability: NOABS, copula: { rho: rhoAll(rho) }, nSims: 20000, seed: 5, players: {},
      replacement: Object.fromEntries(WK.map(k => [k, { QB: [], RB: [], WR: [{ id: "r1", ...rows[k] }], TE: [] }])) });
    const a = Array.from(mkW({ 1: Q, 2: z }).value([]).totals), b = Array.from(mkW({ 1: z, 2: Q }).value([]).totals);
    const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb);
  };
  const r5 = corr(0.5), r0 = corr(0);
  assert.ok(r5 > 0.3, `rho 0.5 cross-week correlation ${r5}`);
  assert.ok(Math.abs(r0) < 0.03, `rho 0 cross-week correlation ${r0}`);
  const base2 = { weeks: WK, slots: ["WR"], availability: NOABS, copula: { rho: rhoAll(0) }, nSims: 10, seed: 5 };
  const okWeek2 = { QB: [], RB: [], WR: [{ id: "d", ...Q }], TE: [] };
  assert.throws(() => S.createWorld({ ...base2, players: {}, replacement: { 1: { QB: [], RB: [], WR: [{ id: "d", ...Q }, { id: "d", ...Q }], TE: [] }, 2: okWeek2 } }), /repeated/);
  assert.throws(() => S.createWorld({ ...base2, players: {}, replacement: { 1: { QB: [], RB: [], WR: [{ id: "d", ...Q }], TE: [{ id: "d", ...Q }] }, 2: okWeek2 } }), /repeated/, "any position");
  assert.throws(() => S.createWorld({ ...base2, players: { d: one(WK, Q) }, replacement: { 1: okWeek2, 2: okWeek2 } }), /rostered/);
  assert.throws(() => S.createWorld({ ...base2, players: {}, replacement: { 1: { QB: [], RB: [], WR: [{ ...Q }], TE: [] }, 2: okWeek2 } }), /string id/);
});
check("v2g copula validation", () => {
  const cfg = over => ({ weeks: [1], slots: ["WR"], availability: NOABS, nSims: 10, seed: 1, players: {}, replacement: rep1([1]), ...over });
  assert.throws(() => S.createWorld(cfg({})), S.RosterSimError);
  assert.throws(() => S.createWorld(cfg({ copula: { rho: rhoAll(0.6) } })), /copula rho/);
  assert.throws(() => S.createWorld(cfg({ copula: { rho: rhoAll(-0.1) } })), /copula rho/);
  assert.throws(() => S.createWorld(cfg({ copula: { rho: rhoAll(NaN) } })), /copula rho/);
  assert.throws(() => S.createWorld(cfg({ copula: { rho: { QB: 0, RB: 0, WR: 0 } } })), /copula rho TE/);
  assert.ok(S.createWorld(cfg({ copula: { rho: S.ZERO_RHO } })));
});
console.log(`rostersim_fixture: ${n} groups OK`);
