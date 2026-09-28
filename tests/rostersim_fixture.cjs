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
const base = over => S.createWorld({ weeks: WEEKS, slots: SLOTS, availability: A, replacement: repl, nSims: 2000, seed: 7,
  players: { qb1: pl("QB", 20), qb2: pl("QB", 16), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) }, ...over });
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

  // Fix round 1 item 7: with a negative p10, the floor must be 2*p10 - p50 (a
  // reflection of p50 about p10), not p10 itself -- a `floor = p10` (or
  // `floor = min(0, p10)`) mutant fails the exact-value check below because it
  // would put a probability spike exactly at p10, and the pileup share would be
  // far above 2%.
  const Qneg = { p10: -2, p50: 5, p90: 15 };
  const floorExpected = 2 * Qneg.p10 - Qneg.p50; // -9
  assert.ok(Math.abs(S.drawPoints(Qneg, 1e-9) - floorExpected) < 1e-6,
    `floor should be ${floorExpected} (2*p10-p50), not p10 (${Qneg.p10}) or 0`);
  const xsNeg = []; for (let i = 1; i < 20000; i++) xsNeg.push(S.drawPoints(Qneg, i / 20000));
  const atFloor = xsNeg.filter(v => Math.abs(v - floorExpected) < 1e-9).length / xsNeg.length;
  assert.ok(atFloor < 0.02, `floor pileup too high: ${atFloor}`);
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
const tieWorld = () => S.createWorld({ weeks: WEEKS, slots: tieSlots, availability: A, replacement: repl, nSims: 2000, seed: 11,
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
const crnWorld = () => S.createWorld({ weeks: WEEKS, slots: crnSlots, availability: A, replacement: repl, nSims: 2000, seed: 7,
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
  const mkWorld = (tag, over) => S.createWorld({ weeks: CW, slots: ["QB"], availability: A, replacement: replDeg, nSims: N, seed: SEED,
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
  const wBye = S.createWorld({ weeks: CW, slots: ["QB"], availability: A, replacement: replDeg, nSims: N, seed: SEED, players: byePlayers });
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
  assert.throws(() => S.createWorld({ weeks: WEEKS, slots: SLOTS, availability: A, replacement: repl,
    players: { x: { position: "QB", weeks: Object.fromEntries(WEEKS.map(w2 => [w2, { status: "play", p10: 9, p50: 5, p90: 20 }])) } } }), /quantiles/);

  // Fix round 1 item 8: validate at createWorld.
  const noQuestionable = { p_out: A.p_out, p_stay: A.p_stay, p_tag: { Out: 0.7, Doubtful: 0.5, IR: 0.9 } };
  assert.throws(() => S.createWorld({ weeks: WEEKS, slots: SLOTS, availability: noQuestionable, replacement: repl, players: {} }),
    /p_tag/i, "all four p_tag keys must be present and finite");
  assert.throws(() => S.createWorld({ weeks: WEEKS, slots: ["QB", "BN"], availability: A, replacement: repl, players: {} }),
    /slot/i, "BN is not a starter slot -- callers must pass starter slots only");
  assert.throws(() => S.createWorld({ weeks: WEEKS, slots: SLOTS, availability: A, replacement: repl, players: {}, nSims: 0 }),
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
  const w = S.createWorld({ weeks: WK, slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX"], availability: A,
                            replacement: r14, players, nSims: 2000, seed: 3 });
  S.compare(w, ids.slice(0, 16), ids.slice(0, 15).concat(ids[20]));
  S.compare(w, ids.slice(16), ids.slice(17).concat(ids[0]));
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `trade comparison took ${ms} ms (budget 1500 ms in node)`);
});
console.log(`rostersim_fixture: ${n} groups OK`);
