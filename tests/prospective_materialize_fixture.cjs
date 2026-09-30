// tests/prospective_materialize_fixture.cjs — run: node tests/prospective_materialize_fixture.cjs
//
// Pins tools/prospective_materialize.cjs on a tiny synthetic world (40 players, two 4-team formats, weeks 5-17).
// The world has NO actual_weeks: the materializer must never need an outcome.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const M = require("../tools/prospective_materialize.cjs");
const T = require("../tools/trade_backtest.cjs");

let n = 0;
const check = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };

const SEASON = 2026, ORIGIN = 5, WEEKS = Array.from({ length: 13 }, (_, i) => 5 + i), LEAGUES = 2, TRADES = 5;
const FORMATS = {
  "f4-1qb-ppr-4": { key: "key-1qb", league: { slug: "f4-1qb-ppr-4", name: "f4-1qb-ppr-4", league_id: "format", teams: 4, rounds: 8, starters: 7, total_picks: 32,
    roster: { QB: 1, RB: 2, WR: 2, TE: 1 }, flex: 1, flex_positions: ["RB", "WR", "TE"], depth_cap: { QB: 2, RB: 6, WR: 6, TE: 2 }, board_ruleset: "league", platform: "sleeper" } },
  "f4-sf-ppr-4": { key: "key-sf", league: { slug: "f4-sf-ppr-4", name: "f4-sf-ppr-4", league_id: "format", teams: 4, rounds: 8, starters: 6, total_picks: 32,
    roster: { QB: 1, RB: 1, WR: 2, TE: 1 }, flex: 1, flex_positions: ["QB", "RB", "WR", "TE"], depth_cap: { QB: 4, RB: 6, WR: 6, TE: 2 }, board_ruleset: "league", platform: "sleeper" } },
};
const LABELS = Object.keys(FORMATS);
const compatOf = l => ({ pick_six: 0, tag: l });

// 8 QB / 12 RB / 14 WR / 6 TE, adp = overall rank; superflex prices QBs far above the rest.
function buildWorld(label) {
  const sf = /sf/.test(label);
  const spec = [["QB", 8, sf ? 420 : 300, 12], ["RB", 12, 260, 9], ["WR", 14, 250, 6], ["TE", 6, 160, 8]];
  const raw = [];
  for (const [pos, cnt, top, step] of spec) for (let i = 0; i < cnt; i++) raw.push({ player_id: `${pos}${i + 1}`, position: pos, pts: top - i * step, rank: i + 1 });
  raw.sort((a, b) => b.pts - a.pts || (a.player_id < b.player_id ? -1 : 1));
  const repl = { QB: 4, RB: 8, WR: 10, TE: 4 };
  const players = raw.map((r, i) => ({ player_id: r.player_id, name: r.player_id, team: "T", position: r.position, season_points: { league: { p50: r.pts, p10: null, p90: null } },
    games: 17, bye: r.rank <= 3 ? 5 + (i % 4) * 2 : 99, position_rank: r.rank, adp: i + 1, rookie: false }));
  const curve = {};
  for (const p of players) (curve[p.position] = curve[p.position] || []).push(p.season_points.league.p50);
  for (const p of players) { p.value_points = curve[p.position][p.position_rank - 1]; p.vorp = p.value_points - curve[p.position][repl[p.position] - 1]; }
  return { season: SEASON, label, format_key: FORMATS[label].key, compat: compatOf(label), model: "synthetic", replacement_rank: repl, players };
}
function buildForecast(label, drop) {
  const w = buildWorld(label), players = {};
  for (const p of w.players) {
    const base = p.season_points.league.p50 / 17, weeks = {};
    for (const wk of WEEKS) {
      if (p.bye === wk) { weeks[wk] = { status: "bye" }; continue; }
      const wobble = ((p.player_id.charCodeAt(1) + wk) % 5) - 2;
      const p50 = Math.max(1, base + wobble);
      weeks[wk] = { status: "play", p10: Math.max(0, p50 - 6), p50, p90: p50 + 9 };
    }
    players[p.player_id] = { position: p.position, baseline: base, weeks };
  }
  if (drop) delete players[drop.id].weeks[drop.week];
  return { schema_version: 1, season: SEASON, origin: ORIGIN, weeks: WEEKS, training_through: 2025, players };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prosp-mat-"));
const worldsDir = path.join(tmp, "worlds"), fcDir = path.join(tmp, "fc");
fs.mkdirSync(worldsDir); fs.mkdirSync(fcDir);
const payloadsFile = path.join(tmp, "payloads.json");
fs.writeFileSync(payloadsFile, JSON.stringify(Object.fromEntries(LABELS.map(l => [l, { league: FORMATS[l].league, format_key: FORMATS[l].key, compat: compatOf(l) }]))));
fs.writeFileSync(path.join(tmp, "tags.json"), JSON.stringify({ season: SEASON, week: ORIGIN - 1, tags: {} }));
for (const l of LABELS) {
  fs.writeFileSync(path.join(worldsDir, `world_${SEASON}_${l}.json`), JSON.stringify(buildWorld(l)));
  fs.writeFileSync(path.join(fcDir, `forecasts_${SEASON}_o${ORIGIN}_${l}.json`), JSON.stringify(buildForecast(l)));
}
const args = out => ["--season", String(SEASON), "--origin", String(ORIGIN), "--formats", LABELS[0], "--exploratory", LABELS[1], "--worlds-dir", worldsDir,
  "--forecasts-dir", fcDir, "--tags", path.join(tmp, "tags.json"), "--leagues", String(LEAGUES), "--trades", String(TRADES), "--out", out, "--format-payloads", payloadsFile];
const run = out => { const log = console.log; console.log = () => {}; try { M.main(args(out)); } finally { console.log = log; } };
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

const outA = path.join(tmp, "a"), outB = path.join(tmp, "b");
run(outA); run(outB);
const D1 = read(outA, `${LABELS[0]}.json`), D2 = read(outA, `${LABELS[1]}.json`);

check("deterministic: two runs are byte-identical", () => {
  for (const f of fs.readdirSync(outA)) assert.equal(fs.readFileSync(path.join(outA, f), "utf8"), fs.readFileSync(path.join(outB, f), "utf8"), f);
  assert.deepEqual(fs.readdirSync(outA).sort(), [...LABELS.map(l => `${l}.json`), "cells.json"].sort());
});
check("per-format header: key, compat, primary flag, seeds", () => {
  assert.equal(D1.format_key, FORMATS[LABELS[0]].key); assert.deepEqual(D1.compat, compatOf(LABELS[0]));
  assert.equal(D1.primary, true); assert.equal(D2.primary, false);
  assert.deepEqual(D1.drafts.map(d => d.draft_seed), [1000 * SEASON, 1000 * SEASON + 1]);
  assert.deepEqual(D1.weeks, WEEKS);
  for (const d of D1.drafts) { assert.equal(d.rosters.length, 4); for (const r of d.rosters) assert.equal(r.length, 8); assert.equal(new Set(d.rosters.flat()).size, 32); }
});
check("cells manifest is complete with deterministic keys", () => {
  const cells = read(outA, "cells.json");
  assert.equal(cells.length, LABELS.length * LEAGUES);
  for (const l of LABELS) for (let k = 0; k < LEAGUES; k++) assert.ok(cells.some(c => c.format === l && c.k === k && c.origin === ORIGIN && c.key === `${l}|${SEASON}|${ORIGIN}|${k}`), `${l} ${k}`);
});
check("superflex drafts carry at least 2 QBs on some team", () => {
  const two = D2.drafts.some(d => d.rosters.some(r => r.filter(id => id.startsWith("QB")).length >= 2));
  assert.ok(two);
});
check("every cell produced trades; every trade satisfies the §10.2 starter filter", () => {
  for (const D of [D1, D2]) {
    assert.equal(D.excluded.length, 0, JSON.stringify(D.excluded));
    assert.ok(D.trades.length >= LEAGUES, `${D.label}: ${D.trades.length} trades`);
    const fc = buildForecast(D.label), slots = T.slotsOf(FORMATS[D.label].league);
    for (const t of D.trades) {
      const dr = D.drafts[t.k];
      for (const [team, give] of [[t.a, t.give_a], [t.b, t.give_b]]) {
        const st = T.frozenStarters(dr.rosters[team], fc, slots, WEEKS, dr.undrafted);
        assert.ok(give.some(id => st.has(id)), `${t.id}: team ${team} gives no starter`);
      }
    }
  }
});
check("lopsided cutoff = type-7 90th percentile of max-side |current delta|", () => {
  for (const D of [D1, D2]) {
    const fc = buildForecast(D.label), slots = T.slotsOf(FORMATS[D.label].league);
    const proj = (id, w) => T.p50Of(fc, id, w), pos = id => T.positionOf(fc, id);
    const measures = D.trades.map(t => {
      const r = D.drafts[t.k].rosters, pool = T.replacementPool(D.drafts[t.k].undrafted, fc, WEEKS, slots, proj);
      const tot = ros => T.predictLineupOnly([ros], proj, WEEKS, slots, T.replOf(pool, proj), pos)[0].total;
      const da = tot(T.afterRoster(r[t.a], t.give_a, t.give_b, t.drop_a)) - tot(r[t.a]);
      const db = tot(T.afterRoster(r[t.b], t.give_b, t.give_a, t.drop_b)) - tot(r[t.b]);
      return Math.max(Math.abs(da), Math.abs(db));
    });
    const want = T.percentile(measures.slice().sort((x, y) => x - y), 0.9);
    assert.ok(Math.abs(D.lopsided_cutoff - want) < 1e-9, `${D.label}: ${D.lopsided_cutoff} vs ${want}`);
    D.trades.forEach((t, i) => assert.equal(t.strata.includes("lopsided"), measures[i] >= want - 1e-12));
  }
});
check("waiver sets honour the quota and exclude injured free agents", () => {
  const W = D1.waiver.filter(x => x.k === 0);
  assert.equal(W.length, 4);
  const adds = W[0].adds, und = new Set(D1.drafts[0].undrafted);
  for (const id of adds) assert.ok(und.has(id));
  for (const [pos, q] of Object.entries(T.WAIVER_QUOTA)) assert.ok(adds.filter(id => id.startsWith(pos)).length <= q);
  // tag one add as Out at week O-1: it must leave the add set and every pool
  const tagged = path.join(tmp, "tags_out.json");
  fs.writeFileSync(tagged, JSON.stringify({ week: ORIGIN - 1, tags: { [adds[0]]: "Out" } }));
  const out = path.join(tmp, "c"); const a = args(out); a[a.indexOf("--tags") + 1] = tagged;
  const log = console.log; console.log = () => {}; try { M.main(a); } finally { console.log = log; }
  const C = read(out, `${LABELS[0]}.json`).waiver.find(x => x.k === 0);
  assert.ok(!C.adds.includes(adds[0]));
  for (const w of WEEKS) for (const pos of ["QB", "RB", "WR", "TE"]) assert.ok(!C.pool_by_week[w][pos].includes(adds[0]));
});
check("a rostered player lacking week 6 puts that cell in excluded (never dropped)", () => {
  const victim = D1.drafts[0].rosters[0][0];
  fs.writeFileSync(path.join(fcDir, `forecasts_${SEASON}_o${ORIGIN}_${LABELS[0]}.json`), JSON.stringify(buildForecast(LABELS[0], { id: victim, week: 6 })));
  const out = path.join(tmp, "d");
  run(out);
  const E = read(out, `${LABELS[0]}.json`);
  const ex = E.excluded.find(e => e.k === 0);
  assert.ok(ex && ex.players.includes(victim), JSON.stringify(E.excluded));
  assert.ok(!E.trades.some(t => t.k === 0) && !E.waiver.some(x => x.k === 0));
  assert.equal(read(out, "cells.json").length, LABELS.length * LEAGUES);
  fs.writeFileSync(path.join(fcDir, `forecasts_${SEASON}_o${ORIGIN}_${LABELS[0]}.json`), JSON.stringify(buildForecast(LABELS[0])));
});
check("refuses a missing world and a mismatched format_key/compat", () => {
  const f = path.join(worldsDir, `world_${SEASON}_${LABELS[0]}.json`), good = fs.readFileSync(f, "utf8");
  const quiet = () => { const log = console.log; console.log = () => {}; try { M.main(args(path.join(tmp, "e"))); } finally { console.log = log; } };
  fs.unlinkSync(f); assert.throws(quiet, /missing world/);
  const bad = JSON.parse(good); bad.format_key = "other"; fs.writeFileSync(f, JSON.stringify(bad)); assert.throws(quiet, /do not match/);
  const bad2 = JSON.parse(good); bad2.compat = { pick_six: 1 }; fs.writeFileSync(f, JSON.stringify(bad2)); assert.throws(quiet, /do not match/);
  fs.writeFileSync(f, good);
});
check("no outcome data required or read", () => {
  assert.equal(buildWorld(LABELS[0]).actual_weeks, undefined);
  const src = fs.readFileSync(path.join(__dirname, "..", "tools", "prospective_materialize.cjs"), "utf8");
  assert.ok(!/actual_weeks|actualWeeks|realized/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`prospective_materialize_fixture: ${n} checks ok`);
