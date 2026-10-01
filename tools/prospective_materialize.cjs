// tools/prospective_materialize.cjs — the decision population of the prospective test, at one origin.
//
//   node tools/prospective_materialize.cjs --season 2026 --origin 5 \
//        --formats f12-1qb-ppr-6,f10-1qb-ppr-6,f12-1qb-ppr-4,f12-1qb-half-4 --exploratory f12-sf-ppr-4 \
//        --worlds-dir models/prospective/2026 --forecasts-dir models/prospective/2026/o5 \
//        --tags models/prospective/2026/o5/tags_w4.json --leagues 20 --trades 125 \
//        --out models/prospective/2026/o5/decisions \
//        [--format-payloads models/prospective/2026/format_payloads.json]
//
// Spec 2026-09-30 §6.1. Everything here is decided BEFORE any outcome exists: the world has no
// actual_weeks and this tool never reads one. The drafts, trade sampling (with the v1 §10.2 starter
// filter), waiver add sets and pools (§10.7) and the lopsided cutoff are the functions
// tools/trade_backtest.cjs already uses for historical worlds -- required, never copied.
//
// Worlds: one per format, <worlds-dir>/world_<season>_<label>.json, already valued under that format's own
// config (its `league` lens) and recording label / format_key / compat. A missing world, or a recorded
// key/compat that differs from the format payload's, is refused. The per-label ruleset map (-6 league,
// -4 ppr, half half_ppr) is kept ONLY as a fallback for a world with no `league` lens.
//
// Format configs: Node has no YAML parser here, so tools/export_format_payloads.py writes each
// format's board-league payload (LeagueConfig.payload()) + format_key + compat to one JSON, which
// this tool reads (--format-payloads). The key and compat are carried through verbatim.
//
// Output: <out>/<label>.json per format and <out>/cells.json, the expected cell manifest
// [{format, k, origin, key}] with key "<label>|<season>|<origin>|<k>". A cell whose rostered player
// lacks a full forecast row set for origin..17 (or whose weeks cannot be filled) is recorded in
// `excluded` -- it gets no trades/waiver rows, is never dropped silently, and stays in cells.json.
// `replacement_by_week` is keyed by draft k (the undrafted pool differs per draft): {k: {w: {pos: [ids]}}}.
"use strict";
const fs = require("fs");
const path = require("path");
const BT = require("./trade_backtest.cjs");
const D = require("./draft_sim.cjs");
const O = require(path.join(__dirname, "..", "site", "assets", "optimizer.js"));
const RS = require(path.join(__dirname, "..", "site", "assets", "rostersim.js"));

const POS = ["QB", "RB", "WR", "TE"];
const LAST_WEEK = 17;
const { BacktestError } = BT;
const byId = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/* Fallback world ruleset key per format label (brief): -6 -> the world's `league` lens, -4 -> ppr, half -> half_ppr. */
function rulesetKey(label) {
  if (/half/.test(label)) return "half_ppr";
  if (/-6$/.test(label)) return "league";
  if (/-4$/.test(label)) return "ppr";
  throw new BacktestError(`cannot infer a world ruleset from format label ${label}`);
}

/* The world's board players scored under `key`. "league" is the world as shipped (what historical runs
   draft). Any other lens is re-expressed as the `league` lens, value_points and vorp are recomputed from
   its own position curve (vorp = value - value at the world's replacement_rank, as the board builds it) and
   the pool is re-sorted by vorp, so the draft sees that format's scoring and nothing else. */
function playersUnder(world, label) {
  const hasLeague = world.players.some(p => p.season_points && p.season_points.league);
  const key = hasLeague ? "league" : rulesetKey(label);
  if (key === "league") return O.withValuePoints(world.players);
  const repl = world.replacement_rank || {};
  const base = world.players.map(p => {
    const sp = p.season_points && p.season_points[key];
    if (!sp) throw new BacktestError(`player ${p.player_id} has no season_points.${key}`);
    const q = Object.assign({}, p, { season_points: { league: sp } });
    delete q.value_points; delete q.vorp;
    return q;
  });
  const scored = O.withValuePoints(base);
  const at = {};
  for (const pos of POS) {
    const curve = scored.filter(p => p.position === pos && Number.isFinite(p.value_points)).map(p => p.value_points).sort((a, b) => b - a);
    const r = repl[pos];
    at[pos] = Number.isInteger(r) && r >= 1 && curve.length ? curve[Math.min(r, curve.length) - 1] : 0;
  }
  const vorpOf = p => (Number.isFinite(p.vorp) ? p.vorp : -1e9);
  return scored.map(p => Object.assign({}, p, { vorp: Number.isFinite(p.value_points) ? +(p.value_points - at[p.position]).toFixed(2) : p.vorp }))
    .sort((a, b) => (vorpOf(b) - vorpOf(a)) || byId(a.player_id, b.player_id));
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function parseArgs(argv) {
  const a = { season: null, origin: null, formats: null, exploratory: "", worldsDir: null, forecastsDir: null, tags: null, leagues: 20, trades: 125, out: null,
              formatPayloads: path.join(__dirname, "..", "models", "prospective", "2026", "format_payloads.json") };
  const num = (s, n) => { const v = Number(s); if (!Number.isInteger(v)) throw new BacktestError(`--${n} must be an integer`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i], v = () => { if (i + 1 >= argv.length) throw new BacktestError(`${f} needs a value`); return argv[++i]; };
    if (f === "--season") a.season = num(v(), "season");
    else if (f === "--origin") a.origin = num(v(), "origin");
    else if (f === "--formats") a.formats = v();
    else if (f === "--exploratory") a.exploratory = v();
    else if (f === "--worlds-dir") a.worldsDir = v();
    else if (f === "--forecasts-dir") a.forecastsDir = v();
    else if (f === "--tags") a.tags = v();
    else if (f === "--leagues") a.leagues = num(v(), "leagues");
    else if (f === "--trades") a.trades = num(v(), "trades");
    else if (f === "--out") a.out = v();
    else if (f === "--format-payloads") a.formatPayloads = v();
    else throw new BacktestError(`unknown argument ${f}`);
  }
  for (const k of ["season", "origin", "formats", "worldsDir", "forecastsDir", "tags", "out"]) if (a[k] === null) throw new BacktestError(`--${k.replace(/[A-Z]/g, c => "-" + c.toLowerCase())} is required`);
  if (a.origin < 2 || a.origin > LAST_WEEK) throw new BacktestError(`origin ${a.origin} outside 2..${LAST_WEEK}`);
  if (a.leagues < 1 || a.trades < 1) throw new BacktestError("--leagues and --trades must be positive");
  return a;
}
const labelsOf = s => s.split(",").map(x => x.trim()).filter(Boolean);

function readTags(file, origin) {
  const t = readJson(file);
  if (!t || typeof t.tags !== "object" || t.tags === null) throw new BacktestError(`${file}: no tags object`);
  if (t.week !== undefined && t.week !== origin - 1) throw new BacktestError(`${file}: tags are for week ${t.week}, origin ${origin} needs week ${origin - 1}`);
  return t.tags;
}

/* Decisions for ONE format at ONE origin. Pure in its inputs. */
function materializeFormat({ label, primary, payload, world, forecasts, tags, season, origin, leagues, trades: nTrades }) {
  const league = payload.league;
  const slots = BT.slotsOf(league);
  const weeks = forecasts.weeks;
  const W = weeks.length;
  D.applyLeague(league);
  D.setNoise(D.MEASURED.noiseRanks);
  const players = playersUnder(world, label);
  D.assertMarketDepth(`season ${world.season} (${label})`, players);
  const worldIds = world.players.map(p => p.player_id);
  const curProj = (id, w) => BT.p50Of(forecasts, id, w);
  const posOf = id => BT.positionOf(forecasts, id);
  const heavy = id => BT.HEAVY_TAGS.has(RS.normalizeTag(tags[id]));

  const out = { format_key: payload.format_key, compat: payload.compat, label, primary, season, origin, weeks, slots,
                drafts: [], trades: [], waiver: [], replacement_by_week: {}, lopsided_cutoff: null,
                population: { attempts: 0, accepted: 0, rejected_not_starter: 0 }, excluded: [] };
  const rows = [];                         // {trade_id, origin, current, strata} per trade side, for markLopsided
  for (let k = 0; k < leagues; k++) {
    const draftSeed = 1000 * season + k;
    const rosters = D.runDraft(players, 0, draftSeed, "measured").slice(1).map(r => r.map(p => p.player_id));
    const taken = new Set(rosters.flat());
    const undrafted = worldIds.filter(id => !taken.has(id));
    out.drafts.push({ k, draft_seed: draftSeed, rosters, undrafted });
    const uncovered = rosters.flat().filter(id => !BT.isCovered(id, forecasts)).sort(byId);
    if (uncovered.length) {
      out.excluded.push({ k, reason: `${uncovered.length} rostered player(s) lack full forecast coverage for weeks ${origin}..${LAST_WEEK}`, players: uncovered });
      continue;
    }
    const kRows = [];
    try {
      // Upfront fill probe, as runCell: an unfillable week excludes the cell at freeze time, not at evaluation.
      const { curPool: pool } = BT.probeArms(undrafted, forecasts, weeks, slots);
      const sampled = BT.sampleTrades(rosters, forecasts, BT.mulberry32(BT.hashStr(`${season}:${origin}:${k}`)), nTrades, { slots, undrafted });
      const lineupOf = roster => BT.predictLineupOnly([roster], curProj, weeks, slots, BT.replOf(pool, curProj), posOf)[0];
      const made = [];
      sampled.forEach((t, i) => {
        const id = `${season}:${origin}:${k}:${i}`;
        const sides = BT.tradeSides(rosters, t);
        const ts = BT.tradeStrata({ trade: t, sides, posOf, W, lineupOf });
        made.push({ id, k, a: t.a, b: t.b, package: t.package, give_a: t.give_a, give_b: t.give_b, drop_a: t.drop_a, drop_b: t.drop_b, strata: ts.a.strata });
        for (const s of ["a", "b"]) kRows.push({ trade_id: id, origin, current: ts[s].current, strata: ts[s].strata });
      });
      // Waiver add set and pools (§10.1, §10.7): free agents tagged Out/IR at week O-1 are neither adds nor replacements.
      const fa = undrafted.filter(id => !heavy(id));
      const adds = BT.waiverAdds(fa, forecasts, weeks, BT.WAIVER_QUOTA);
      const addSet = new Set(adds);
      const { curPool: wpool } = BT.probeArms(fa.filter(id => !addSet.has(id)), forecasts, weeks, slots);
      out.replacement_by_week[k] = pool;
      out.population.attempts += sampled.stats.attempts; out.population.accepted += sampled.stats.accepted;
      out.population.rejected_not_starter += sampled.stats.rejected_not_starter;
      out.trades.push(...made);
      rosters.forEach((_, team) => out.waiver.push({ k, team, adds, pool_by_week: wpool }));
      rows.push(...kRows);
    } catch (e) {
      if (!(e instanceof BacktestError || e instanceof RS.RosterSimError)) throw e;
      out.excluded.push({ k, reason: e.message, players: [] });     // excluded whole: nothing this cell produced survives
    }
  }
  // §6.1 lopsided: 90th percentile (type 7) of max-side |current Δ| over this origin's trade set -- predictions only.
  if (rows.length) {
    const cutoffs = BT.markLopsided(rows);
    out.lopsided_cutoff = cutoffs[origin];
    const strata = new Map(rows.map(r => [r.trade_id, r.strata]));   // first side's array; each side pushed its own "lopsided"
    for (const t of out.trades) t.strata = strata.get(t.id);
  }
  return out;
}

function main(argv) {
  const a = parseArgs(argv);
  const primary = labelsOf(a.formats), exploratory = labelsOf(a.exploratory);
  const dup = primary.filter(l => exploratory.includes(l));
  if (dup.length) throw new BacktestError(`formats listed as both primary and exploratory: ${dup.join(", ")}`);
  const payloads = readJson(a.formatPayloads);
  const tags = readTags(a.tags, a.origin);
  fs.mkdirSync(a.out, { recursive: true });
  const cells = [];
  for (const [label, isPrimary] of [...primary.map(l => [l, true]), ...exploratory.map(l => [l, false])]) {
    if (!payloads[label]) throw new BacktestError(`no payload for format ${label} in ${a.formatPayloads}`);
    const worldFile = path.join(a.worldsDir, `world_${a.season}_${label}.json`);
    if (!fs.existsSync(worldFile)) throw new BacktestError(`missing world for format ${label}: ${worldFile}`);
    const world = readJson(worldFile);
    if (world.season !== a.season) throw new BacktestError(`${worldFile}: season ${world.season}, expected ${a.season}`);
    const pl = payloads[label];
    // The world builder (draft_world.py) records the format as `format`; compat is compared key-order-free.
    const canon = o => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
    if (world.format !== label || world.format_key !== pl.format_key || canon(world.compat) !== canon(pl.compat)) {
      throw new BacktestError(`${worldFile}: recorded label/format_key/compat do not match format ${label}'s config`);
    }
    const file = path.join(a.forecastsDir, `forecasts_${a.season}_o${a.origin}_${label}.json`);
    const forecasts = readJson(file);
    BT.checkForecastFile(forecasts, a.season, a.origin, file);
    const res = materializeFormat({ label, primary: isPrimary, payload: payloads[label], world, forecasts, tags, season: a.season, origin: a.origin, leagues: a.leagues, trades: a.trades });
    fs.writeFileSync(path.join(a.out, `${label}.json`), JSON.stringify(res) + "\n");
    for (let k = 0; k < a.leagues; k++) cells.push({ format: label, k, origin: a.origin, key: `${label}|${a.season}|${a.origin}|${k}`, primary: isPrimary });
    console.log(`[${label}] ${res.trades.length} trades, ${res.waiver.length} waiver rows, lopsided cutoff ${res.lopsided_cutoff}, excluded cells ${res.excluded.length}`);
  }
  fs.writeFileSync(path.join(a.out, "cells.json"), JSON.stringify(cells) + "\n");
  console.log(`wrote ${cells.length} cells to ${a.out}`);
}

module.exports = { materializeFormat, playersUnder, rulesetKey, parseArgs, main };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`prospective_materialize: ${e instanceof BacktestError ? e.message : (e && e.stack) || e}`); process.exit(2); }
}
