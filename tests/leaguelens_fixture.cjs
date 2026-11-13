const assert = require("assert");
const L = require("../site/assets/leaguelens.js");
const owner = require("./fixtures/owner_league_settings.json");
const gab = Object.values(owner).find(l => l.total_rosters === 12).scoring_settings;   // the 12-team owner settings
assert.strictEqual(L.plain(0.04), "0.04");
assert.strictEqual(L.plain(0.0400001), "0.0400001");
assert.strictEqual(L.plain(6), "6");
assert.strictEqual(L.plain(-0), "0");
assert.strictEqual(L.plain(1e-7), "0.0000001");
assert.strictEqual(L.plain(-2.5), "-2.5");
assert.strictEqual(L.plain(1e21), "1000000000000000000000");
assert.strictEqual(L.plain(5e-324).length, 326);
assert.throws(() => L.plain(NaN)); assert.throws(() => L.plain(Infinity)); assert.throws(() => L.plain("1"));
const w = L.effectiveWeights({ rec: -1, bonus_rec_te: 2, pass_yd: 0.04 });
assert.deepStrictEqual(w.TE, { receptions: 1, passing_yards: 0.04 });
assert.deepStrictEqual(w.WR, { receptions: -1, passing_yards: 0.04 });
assert.deepStrictEqual(w.QB, { receptions: -1, passing_yards: 0.04 });
const z = L.effectiveWeights({ rec: 1, bonus_rec_wr: -1 });
assert.ok(!("receptions" in z.WR) && z.RB.receptions === 1, "cancelled weight omitted");
assert.notStrictEqual(L.evidenceIdentity(L.effectiveWeights({ pass_yd: 0.04 })), L.evidenceIdentity(L.effectiveWeights({ pass_yd: 0.0400001 })));
assert.doesNotThrow(() => L.evidenceIdentity(L.effectiveWeights({ pass_yd: 1e-12, rec: 2e7 })), "identity total over accepted weights");
const c = L.classify(gab);
assert.deepStrictEqual(c.recurring, []);
assert.deepStrictEqual(c.rare.slice().sort(), ["fum_rec_td", "pass_2pt", "pass_td_50p", "rec_2pt", "rec_td_50p", "rush_2pt", "rush_td_50p", "st_td"]);
assert.ok(c.approx.includes("pass_int_td") && c.refused === false);
assert.ok(L.classify({ pass_yd: 0.04, rec_2pt: 3 }).recurring.includes("rec_2pt"), "rare above bound banners");
assert.deepStrictEqual(L.classify({ rec: 1, bonus_fd_wr: 0.5, fum: -1, zzz_new: 1 }).recurring.slice().sort(), ["bonus_fd_wr", "fum", "zzz_new"]);
assert.ok(L.classify({ fgm_yds: 0.1, def_td: 6 }).refused);
assert.ok(L.classify({ bonus_rush_td_qb: 2, pass_yd: 0.04 }).recurring.includes("bonus_rush_td_qb"));
assert.throws(() => L.classify({ pass_yd: "x" })); assert.throws(() => L.classify({ pass_yd: NaN }));
const q = { p10: { receptions: 2 }, p50: { receptions: 5 }, p90: { receptions: 8 } };
assert.deepStrictEqual(L.score(q, "TE", L.effectiveWeights({ rec: -1, bonus_rec_te: 2 })), { p10: 2, p50: 5, p90: 8 });
assert.deepStrictEqual(L.score(q, "WR", L.effectiveWeights({ rec: -1, bonus_rec_te: 2 })), { p10: -8, p50: -5, p90: -2 });
assert.deepStrictEqual(L.score({ p10: null, p50: { receptions: 5 }, p90: null }, "WR", L.effectiveWeights({ rec: 1 })), { p10: null, p50: 5, p90: null });
assert.deepStrictEqual(L.score(q, "QB", L.effectiveWeights({ bonus_rec_te: 1 })), { p10: 0, p50: 0, p90: 0 });
assert.throws(() => L.score({ p10: {}, p50: {}, p90: {} }, "WR", L.effectiveWeights({ rec: 1 })), /receptions/);
assert.throws(() => L.score(q, "K", L.effectiveWeights({ rec: 1 })), /Unsupported scoring position/);
assert.throws(() => L.score({ p10: null, p50: { receptions: 5 }, p90: { receptions: 8 } }, "WR", L.effectiveWeights({ rec: 1 })), /Incomplete/);
assert.throws(() => L.score({ p10: { receptions: 8 }, p50: { receptions: 5 }, p90: { receptions: 2 } }, "WR", L.effectiveWeights({ rec: 1 })), /Malformed band/);
assert.throws(() => L.score({ p10: { receptions: 2 }, p50: { receptions: 100 }, p90: { receptions: 8 } }, "WR", L.effectiveWeights({ rec: 1 })), /Malformed band/);
assert.throws(() => L.score({ p10: null, p50: { receptions: "5" }, p90: null }, "WR", L.effectiveWeights({ rec: 1 })), /invalid/);
assert.throws(() => L.score({ p10: null, p50: { receptions: 1e308 }, p90: null }, "WR", L.effectiveWeights({ rec: 1e10 })), /overflow/);
assert.throws(() => L.score({ p10: [2], p50: { receptions: 5 }, p90: [8] }, "WR", L.effectiveWeights({ rec: 1 })), /Incomplete/);
assert.throws(() => L.score({ p10: [2], p50: { receptions: 5 }, p90: [8] }, "QB", L.effectiveWeights({ bonus_rec_te: 1 })), /Incomplete/, "containers checked even with no weights");
const odd = L.classify({ pass_yd: 0.05, rec: 0.25, bonus_fd_wr: 0.5 });
assert.strictEqual(odd.refused, false);
assert.strictEqual(L.disclosures(odd).banner, "Your league also scores first downs, which these projections leave out; rankings may be off for your league.");
const gabD = L.disclosures(L.classify(gab));
assert.strictEqual(gabD.banner, null);
assert.ok(gabD.footnotes.includes("Pick-sixes use an average rate, not a forecast."));
assert.ok(gabD.footnotes.some(f => f.startsWith("Not projected: ") && f.endsWith(" (rare events).")));
// Readable names, not raw Sleeper keys (2026-11-13): de-duplicated, in the order first seen; an unlabelled key shows raw.
assert.ok(!gabD.footnotes.some(f => /\b(pass_2pt|st_td|fum_rec_td|rec_td_50p)\b/.test(f)), gabD.footnotes.join(" | "));
assert.strictEqual(L.disclosures(L.classify({ rec: 1, pass_2pt: 2, st_td: 6, rush_2pt: 2, rec_td_50p: 3 })).footnotes.at(-1),
  "Not projected: two-point conversions, special-teams touchdowns, long-touchdown bonuses (rare events).");
assert.strictEqual(L.disclosures(L.classify({ rec: 1, bonus_fd_wr: 0.5, zzz_new: 1, pass_fd: 1, pass_cmp: 0.1, bonus_rec_yd_100: 3, constructor: 1 })).banner,
  "Your league also scores first downs, zzz_new, completions, 100-yard receiving bonuses, constructor, which these projections leave out; rankings may be off for your league.");
assert.ok(Object.isFrozen(L.LABELS), "LABELS is frozen");
// Every key the classifier can disclose has a label, so a future table entry cannot silently show raw.
for (const k of [...Object.keys(L.RARE), ...L.RECURRING])
  assert.ok(Object.hasOwn(L.LABELS, k) && typeof L.LABELS[k] === "string" && L.LABELS[k] && !L.LABELS[k].includes("_"), `label for ${k}`);
const P = require("./fixtures/leaguelens_parity.json");
for (const cs of P.cases) {
  if (cs.expected_error) { assert.throws(() => L.score(cs.stat_quantiles, cs.position, L.effectiveWeights(cs.scoring)), new RegExp(cs.expected_error)); continue; }
  const got = L.score(cs.stat_quantiles, cs.position, L.effectiveWeights(cs.scoring));
  for (const k of ["p10", "p50", "p90"]) {
    if (cs.expected[k] === null) assert.strictEqual(got[k], null);
    else assert.ok(Math.abs(got[k] - cs.expected[k]) <= 1e-9, `${cs.name} ${k}`);
  }
}
console.log("leaguelens_fixture: ok");
