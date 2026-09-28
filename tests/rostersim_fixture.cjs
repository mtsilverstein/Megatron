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
});
check("determinism", () => {
  const a = base().value(["qb1", "rb1", "wr1", "wr2"]), b = base().value(["qb1", "rb1", "wr1", "wr2"]);
  assert.equal(a.mean, b.mean); assert.deepEqual([...a.totals.slice(0, 20)], [...b.totals.slice(0, 20)]);
});
check("crn", () => {
  const w = base(); const d = S.compare(w, ["qb1", "rb1", "wr1", "wr2"], ["wr2", "wr1", "rb1", "qb1"]);
  assert.equal(d.mean, 0); assert.equal(d.p10, 0); assert.equal(d.p90, 0);
});
check("backupHasPositiveBoundedValue", () => {
  const w = base();
  const d = S.compare(w, ["qb1", "rb1", "wr1", "wr2"], ["qb1", "qb2", "rb1", "wr1", "wr2"]);
  assert.ok(d.mean > 0, "a backup QB must be worth something when the starter can miss games");
  // bounded above by his margin over replacement, summed over the weeks he could start
  assert.ok(d.mean < WEEKS.length * (16 - 10) + 1e-9);
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
check("coverage", () => {
  const bad = pl("WR", 9); delete bad.weeks[7];
  assert.throws(() => base({ players: { qb1: pl("QB", 20), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: bad } }), /wr2.*week 7/);
});
check("noReplacement", () => {
  const thin = Object.fromEntries(WEEKS.map(w => [w, { QB: [], RB: [q(6)], WR: [q(6)], TE: [] }]));
  const w = base({ replacement: thin, forcedOut: { qb1: [5] } });
  assert.throws(() => w.value(["qb1", "rb1", "wr1", "wr2"]), /no replacement/);
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
});
check("timing", () => {
  const players = {}; const ids = [];
  for (let i = 0; i < 32; i++) { const pos = ["QB", "RB", "WR", "TE"][i % 4]; players[`p${i}`] = pl(pos, 5 + (i % 11)); ids.push(`p${i}`); }
  const WK = Array.from({ length: 14 }, (_, i) => i + 4);
  const r14 = Object.fromEntries(WK.map(w => [w, { QB: [q(10)], RB: [q(6), q(5)], WR: [q(6), q(5)], TE: [q(4)] }]));
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
