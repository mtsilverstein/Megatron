const assert = require("assert");
const Lx = require("../site/assets/lineup.js");
const ELIG = require("../site/assets/formats.js").AUDIT.slot_eligible;
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
// Independent exact oracle: every double is an integer multiple of 2^-1074.
function exact(x) {
  if (x === 0) return 0n;
  const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, x);
  const hi = dv.getUint32(0), lo = dv.getUint32(4), eb = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (eb) m |= 1n << 52n;
  const sh = BigInt((eb ? eb - 1075 : -1074) + 1074);
  return (hi >>> 31 ? -m : m) << sh;
}
function brute({ slots, candidates, current = [], fixed = {} }) {
  const fixedIds = new Set(Object.values(fixed).map(f => f.id));
  const open = slots.map((s, i) => i).filter(i => !(i in fixed) && Lx.MODELED.includes(slots[i]));
  const pool = candidates.filter(c => !fixedIds.has(c.id));
  let best = null; const used = new Set(), pick = [];
  (function rec(k) {
    if (k === open.length) {
      const total = pick.reduce((a, c) => a + exact(c.score), 0n);
      const keep = pick.filter((c, j) => current[open[j]] === c.id).length;
      const ids = pick.map(c => c.id);
      const better = !best || total > best.total || (total === best.total && (keep > best.keep ||
        (keep === best.keep && ids.join("\u0000") < best.ids.join("\u0000"))));
      if (better) best = { total, keep, ids };
      return;
    }
    for (const c of pool) {
      if (used.has(c.id) || !ELIG[slots[open[k]]].includes(c.position)) continue;
      used.add(c.id); pick.push(c); rec(k + 1); pick.pop(); used.delete(c.id);
    }
  })(0);
  return best && { ...best, open };
}
const rand = mulberry32(7), POS = ["QB", "RB", "WR", "TE"];
const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX", "WRRB_FLEX", "REC_FLEX", "K", "DL"];
const scoreOf = () => { const r = rand();
  return r < 0.15 ? 1 + Math.floor(rand() * 3) * 1e-7 : r < 0.3 ? Math.round(rand() * 4) : (rand() * 33 - 3); };
for (let t = 0; t < 600; t++) {
  const slots = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => SLOTS[Math.floor(rand() * SLOTS.length)]);
  const candidates = Array.from({ length: 3 + Math.floor(rand() * 5) }, (_, i) => ({
    id: String(100 + Math.floor(rand() * 900)) + "_" + i, position: POS[Math.floor(rand() * 4)], score: scoreOf() }));
  const current = slots.map(() => rand() < 0.5 ? candidates[Math.floor(rand() * candidates.length)].id : null);
  const fixed = {};
  slots.forEach((s, i) => { if (Lx.UNMODELED.includes(s) && rand() < 0.5) fixed[i] = { id: "u" + i, score: null }; });
  const ms = slots.filter(s => Lx.MODELED.includes(s));
  const pl = candidates.map(c => ({ id: c.id, position: c.position, s: c.score }));
  assert.strictEqual(Lx.lineupScore(pl, ms, p => p.s), Lx.bestLineup(pl, ms, p => p.s).total, `trial ${t} lineupScore parity`);
  const want = brute({ slots, candidates, current, fixed });
  const got = Lx.solve({ slots, candidates, current, fixed });
  if (!want) { assert.strictEqual(got.ok, false, `trial ${t} should be infeasible`); continue; }
  assert.ok(got.ok, `trial ${t}: ${got.reason}`);
  assert.deepStrictEqual(want.open.map(i => got.assignment[i].id), want.ids, `trial ${t}`);
}
let r = Lx.solve({ slots: ["RB"], candidates: [{ id: "a", position: "RB", score: 1.0000001 }, { id: "b", position: "RB", score: 1.0000002 }], current: ["a"] });
assert.strictEqual(r.assignment[0].id, "b", "sub-micro difference decides");
r = Lx.solve({ slots: ["RB"], candidates: [{ id: "a", position: "RB", score: 0 }, { id: "b", position: "RB", score: 4e-7 }], current: ["a"] });
assert.strictEqual(r.assignment[0].id, "b", "zero vs tiny decides");
r = Lx.solve({ slots: ["RB", "FLEX"], candidates: [{ id: "A", position: "RB", score: 20 }, { id: "B", position: "RB", score: 10 }], current: ["B", "A"] });
assert.deepStrictEqual(r.assignment.map(a => a.id), ["B", "A"], "equal totals keep both exact slots");
r = Lx.solve({ slots: ["RB", "RB"], candidates: [{ id: "A", position: "RB", score: 10 }, { id: "B", position: "RB", score: 10 }], current: [null, null] });
assert.deepStrictEqual(r.assignment.map(a => a.id), ["A", "B"], "no current: smallest id vector");
r = Lx.solve({ slots: ["QB"], candidates: [{ id: "q", position: "QB", score: 5000 }, { id: "p", position: "QB", score: -5000 }] });
assert.strictEqual(r.assignment[0].id, "q", "no score ceiling");
r = Lx.solve({ slots: ["RB", "K"], candidates: [{ id: "A", position: "RB", score: 20 }, { id: "B", position: "RB", score: 10 }], fixed: { 1: { id: "A", score: null } } });
assert.ok(r.ok); assert.deepStrictEqual(r.assignment.map(a => a.id), ["B", "A"]); assert.strictEqual(r.total, 10);
assert.strictEqual(Lx.solve({ slots: ["RB", "K"], candidates: [], fixed: { 0: { id: "A", score: 1, position: "RB" }, 1: { id: "A", score: null } } }).ok, false);
assert.strictEqual(Lx.solve({ slots: ["RB"], candidates: [], fixed: { 0: { id: "Q", score: 1, position: "QB" } } }).reason, "Locked player is in an incompatible slot.");
r = Lx.solve({ slots: ["QB", "K"], candidates: [{ id: "Q", position: "QB", score: 15 }] });
assert.ok(r.ok); assert.strictEqual(r.assignment[1].id, null);
r = Lx.solve({ slots: ["QB", "TE"], candidates: [{ id: "Q", position: "QB", score: 15 }] });
assert.deepStrictEqual([r.ok, r.slot], [false, "TE"]);
r = Lx.solve({ slots: ["TE"], candidates: [{ id: "T", position: "TE", score: -2 }] });
assert.deepStrictEqual([r.ok, r.total], [true, -2]);
assert.throws(() => Lx.solve({ slots: ["XYZ"], candidates: [] }), /Unsupported lineup slot/);
assert.throws(() => Lx.solve({ slots: ["QB"], candidates: [{ id: "a", position: "QB", score: 1 }, { id: "a", position: "QB", score: 2 }] }), /Duplicate/);
const players = [{ sleeper_id: "z", position: "RB" }, { sleeper_id: "a", position: "RB" }];
assert.strictEqual(Lx.bestLineup(players, ["RB"], () => 5).starters[0].player.sleeper_id, "a");
assert.strictEqual(Lx.lineupScore(players, ["RB", "RB", "RB"], () => 5), -Infinity);
assert.strictEqual(Lx.lineupScore(players, ["RB"], p => p.sleeper_id === "z" ? null : 3), 3);
assert.throws(() => Lx.bestLineup(players, ["RB", "K"], () => 1), /modeled/);
{
  const pos = ["QB", "QB", "RB", "RB", "RB", "RB", "WR", "WR", "WR", "WR", "WR", "TE", "TE", "RB", "WR"];
  const roster = pos.map((position, i) => ({ sleeper_id: "p" + i, position, s: 5 + ((i * 7) % 11) + i / 10 }));
  const sl = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX"];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 2000; i++) Lx.lineupScore(roster, sl, p => p.s);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log("lineupScore 2000 calls: " + ms.toFixed(1) + " ms");
  assert.ok(ms < 300, "lineupScore too slow: " + ms);
}
console.log("lineup_fixture: ok");
