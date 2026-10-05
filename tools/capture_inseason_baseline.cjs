// Capture today's in-season analyzer outputs on the synthetic, manager-free baseline world.
//
// SYNTHETIC ANALYZER PARITY: this ledger pins what today's start/sit, waiver and in-season
// trade analyzers return on a fictional league built from the published projections
// (tools/build_inseason_snapshot.py).  It is NOT a historical forecast reproduction.
//
// Usage: node tools/capture_inseason_baseline.cjs     (rewrites scenarios.json and outputs_<slug>.json)
// Module: run(legacy, scenario) is the exact analyzer preparation shared with
// tests/inseason_baseline_fixture.cjs, which replays it from the committed JSON.
"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const DIR = path.join(__dirname, "..", "tests", "fixtures", "inseason_baseline");
const ASSETS = path.join(__dirname, "..", "site", "assets");
const SLUGS = ["gabagool", "fam"];

const clone = x => JSON.parse(JSON.stringify(x));
// Infinity does not survive JSON; the ledger spells it "Infinity" / "-Infinity".
const sortKeys = x => Array.isArray(x) ? x.map(sortKeys) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sortKeys(x[k])])) : x;
const ser = x => JSON.parse(JSON.stringify(x, (k, v) => v === Infinity ? "Infinity" : v === -Infinity ? "-Infinity" : v));

// Every timestamp an analyzer reads is pinned to the snapshot's generated_at.
function normalize(legacy, generatedAt) {
  const l = clone(legacy);
  l.weekly.generated_at = generatedAt;
  l.remaining.generated_at = generatedAt;
  l.kickoffs.generated_at = generatedAt;
  return l;
}

function run(legacyRaw, scenario) {
  const StartSit = require(path.join(ASSETS, "startsit.js"));
  const Waivers = require(path.join(ASSETS, "waivers.js"));
  const SeasonTrade = require(path.join(ASSETS, "seasontrade.js"));
  const WaiverMode = require(path.join(ASSETS, "waivermode.js"));
  const l = normalize(legacyRaw, legacyRaw.weekly.generated_at);
  const own = l.rosters.find(r => r.roster_id === scenario.waivers.rosterId);
  const startsit = StartSit.analyze({
    board: l.board, weekly: l.weekly, league: l.league, roster: own, catalog: l.catalog, kickoffs: l.kickoffs,
    excludeIds: scenario.startsit.excludeIds, now: scenario.startsit.now, snapshotAt: scenario.startsit.snapshotAt,
  });
  // Controller preparation: the board is hydrated with catalog injury/team and the identity of
  // every roster occupant it does not price (K/DEF here) first.
  const hydrated = WaiverMode.hydrateBoard(l.board, l.catalog, l.rosters);
  const w = scenario.waivers;
  const waivers = Waivers.analyze({
    board: hydrated, league: l.league, rosters: l.rosters, rosterId: w.rosterId, transactions: l.transactions,
    weekly: l.weekly, kickoffs: l.kickoffs, snapshotAt: w.snapshotAt, now: w.now, remaining: l.remaining,
    week: w.week, protectedIds: w.protectedIds, budgetReserve: w.budgetReserve,
  });
  const t = scenario.trade;
  const trade = SeasonTrade.analyze({
    remaining: l.remaining, league: l.league, catalog: l.catalog, rosters: l.rosters, rosterIds: t.rosterIds,
    give: t.give, receive: t.receive, drops: t.drops, excludeWeeks: t.excludeWeeks, assumeAvailable: t.assumeAvailable,
    currentWeek: t.currentWeek, now: t.now, snapshotAt: t.snapshotAt,
  });
  return ser({ startsit, waivers, trade });
}

// Step 4: success, not errors.  Throws (no try/catch) when the baseline world is not a real success.
function assertSuccess(slug, out, legacy, scenario) {
  const where = `[${slug}]`;
  const skillSlots = legacy.league.roster_positions.filter(s => !["BN", "IR", "TAXI"].includes(s));
  assert.equal(out.startsit.lineup.length, skillSlots.length, `${where} start/sit lineup length`);
  for (const [i, p] of out.startsit.lineup.entries()) {
    if (p.unmodeled) continue; // K/DEF slots carry identity only
    assert.ok(p.id && p.points && Number.isFinite(p.points.p50), `${where} start/sit slot ${i} (${skillSlots[i]}) unfilled`);
  }
  assert.ok(!out.waivers.recommendationBlock, `${where} waivers blocked: ${out.waivers.recommendationBlock}`);
  assert.ok(Array.isArray(out.waivers.rows) && out.waivers.rows.length >= 5, `${where} waivers rows ${out.waivers.rows && out.waivers.rows.length} < 5`);
  const weeks = [];
  for (let wk = scenario.trade.currentWeek + 1; wk <= legacy.remaining.end_week; wk++) weeks.push(wk);
  assert.deepEqual(out.trade.weeks.map(x => x.week), weeks, `${where} trade weeks`);
  for (const wk of out.trade.weeks) for (const side of wk.sides) {
    assert.ok(Number.isFinite(side.before.total) && Number.isFinite(side.after.total), `${where} trade week ${wk.week} totals not finite`);
  }
  assert.ok(out.trade.sides.every(s => Number.isFinite(s.delta)), `${where} trade deltas`);
}

function buildScenario(legacy) {
  const generatedAt = legacy.weekly.generated_at;
  const now = Date.parse(generatedAt) + 60_000, snapshotAt = now - 30_000;
  const week = legacy.weekly.week;
  const value = new Map(legacy.board.players.map(p => [p.sleeper_id, p.value_points]));
  const [mine, other] = [1, 2].map(id => legacy.rosters.find(r => r.roster_id === id));
  const benchBy = (roster, pos) => roster.players
    .filter(id => !roster.starters.includes(id) && legacy.catalog[id].position === pos)
    .sort((a, b) => value.get(b) - value.get(a) || (a < b ? -1 : 1))[0];
  const give = benchBy(mine, "WR"), receive = benchBy(other, "RB");
  assert.ok(give && receive, "trade needs a bench WR on roster 1 and a bench RB on roster 2");
  return {
    startsit: { rosterId: 1, excludeIds: [], now, snapshotAt },
    waivers: { rosterId: 1, week, now, snapshotAt, budgetReserve: 20, protectedIds: mine.starters.filter(id => id !== "0") },
    trade: { rosterIds: [1, 2], give: [give], receive: [receive], drops: {}, excludeWeeks: {}, assumeAvailable: true, currentWeek: week, now, snapshotAt },
  };
}

function main() {
  const scenarios = {
    _header: "SYNTHETIC ANALYZER PARITY: fictional manager-free league, not historical forecast reproduction. now = generated_at + 60s; snapshotAt = now - 30s.",
  };
  const outputs = {};
  for (const slug of SLUGS) {
    const legacy = JSON.parse(fs.readFileSync(path.join(DIR, `legacy_${slug}.json`), "utf8"));
    scenarios[slug] = buildScenario(legacy);
    outputs[slug] = run(legacy, scenarios[slug]);
    assertSuccess(slug, outputs[slug], legacy, scenarios[slug]);
  }
  fs.writeFileSync(path.join(DIR, "scenarios.json"), JSON.stringify(scenarios, null, 1) + "\n");
  for (const slug of SLUGS) {
    fs.writeFileSync(path.join(DIR, `outputs_${slug}.json`), JSON.stringify({ _header: scenarios._header, ...outputs[slug] }) + "\n");
    console.log(`${slug}: startsit changed=${outputs[slug].startsit.lineup.filter(p => p.changed).length}, waiver rows=${outputs[slug].waivers.rows.length}, trade deltas=${outputs[slug].trade.sides.map(s => s.delta.toFixed(2))}`);
  }
}

module.exports = { run, buildScenario, assertSuccess, ser, normalize, SLUGS, DIR };
if (require.main === module) main();
