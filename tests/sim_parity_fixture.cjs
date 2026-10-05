// tests/sim_parity_fixture.cjs — run: node tests/sim_parity_fixture.cjs
//
// Several rules exist twice: once in tools/trade_backtest.cjs (which measured the error bands) and once in the
// pages that apply those bands (seasontrade.js / seasontrademode.js). A band measured under one
// rule and applied under another is not the measured band. This fixture feeds the SAME hand-built inputs to
// both implementations and asserts they agree. Where a rule legitimately differs, the difference is pinned
// below with a comment naming the review item, so a change to either side shows up here.
const assert = require("node:assert/strict");
const T = require("../tools/trade_backtest.cjs");
const ST = require("../site/assets/seasontrade.js");
const STM = require("../site/assets/seasontrademode.js");
// The waiver desk no longer simulates (any-league spec §6.2): its quota/pool parity cases were removed with
// its simulation code; the backtest's own waiver arm is covered by trade_backtest_fixture.

let n = 0; const failed = [];
const check = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; if (process.env.FIXTURE_ALL) { failed.push(e.message.split("\n")[0]); return; } throw e; } };

/* ------------------------------------------------------------------------------------------------
   The mini season (weeks 5..7, slots QB / RB / FLEX), the same one tests/trade_backtest_fixture.cjs works by hand.
   bW2 has a bye in week 6; every rostered player has a play/bye row every week. */
const WEEKS = [5, 6, 7];
const SLOTS = ["QB", "RB", "FLEX"];
const play = p50 => ({ status: "play", p10: p50 - 3, p50, p90: p50 + 3 });
const every = p50 => ({ 5: play(p50), 6: play(p50), 7: play(p50) });
const FC = { schema_version: 1, season: 2023, origin: 5, weeks: WEEKS, players: {
  aQ: { position: "QB", baseline: 19, weeks: every(20) }, aR1: { position: "RB", baseline: 13, weeks: every(15) },
  aR2: { position: "RB", baseline: 9, weeks: every(8) }, aW: { position: "WR", baseline: 11, weeks: every(10) },
  bQ: { position: "QB", baseline: 17, weeks: every(18) }, bR: { position: "RB", baseline: 12, weeks: every(12) },
  bW1: { position: "WR", baseline: 15, weeks: every(14) }, bW2: { position: "WR", baseline: 5, weeks: { 5: play(6), 6: { status: "bye" }, 7: play(6) } },
  uQ: { position: "QB", baseline: 10, weeks: every(11) }, uQ2: { position: "QB", baseline: 5, weeks: every(5) },
  uR: { position: "RB", baseline: 6, weeks: every(7) }, uR2: { position: "RB", baseline: 4, weeks: every(4) },
  uW: { position: "WR", baseline: 8, weeks: every(9) },
} };
const ROSTERS = [["aQ", "aR1", "aR2", "aW"], ["bQ", "bR", "bW1", "bW2"]];
const UNDRAFTED = ["uQ", "uQ2", "uR", "uR2", "uW"];
const ACT = Object.fromEntries(Object.entries(FC.players).map(([id, p]) => [id, Object.fromEntries(WEEKS.filter(w => p.weeks[w].status === "play").map(w => [String(w), p.weeks[w].p50]))]));
const AV = { p_out: { QB: 0.05, RB: 0.08, WR: 0.06, TE: 0.06 }, p_stay: { QB: 0.6, RB: 0.65, WR: 0.6, TE: 0.6 }, p_tag: { Out: 0.7, Doubtful: 0.5, Questionable: 0.15, IR: 0.9 } };

// --- the page's view of the same league --------------------------------------------------------------------
const NOW = Date.parse("2026-09-14T12:00:00Z");
const catalog = Object.fromEntries(Object.entries(FC.players).map(([id, p]) => [id, { gsis_id: "g" + id, position: p.position, team: "A", full_name: id }]));
const pageRow = (w, r) => r.status === "bye" ? { week: w, status: "bye" } : { week: w, status: "conditional_projection", points: { league: { p10: r.p10, p50: r.p50, p90: r.p90 } } };
const remaining = { schema_version: 1, horizon: "remaining_season", status: "experimental", evaluation: null, season: 2026, start_week: 4, end_week: 7,
  generated_at: new Date(NOW).toISOString(), league: { league_id: "L", sleeper_scoring: { rec: 1 } },
  players: Object.entries(FC.players).map(([id, p]) => ({ player_id: "g" + id, team: "A", position: p.position, weeks: WEEKS.map(w => pageRow(w, p.weeks[w])) })) };
const league = { league_id: "L", season: "2026", status: "in_season", total_rosters: 2, roster_positions: ["QB", "RB", "FLEX", "BN", "BN", "BN", "BN"], scoring_settings: { rec: 1 } };
const pageRosters = ROSTERS.map((r, i) => ({ roster_id: i + 1, players: r.slice() }));
// The page prices players through the league view's board (sleeper_id -> player_id), never the catalog's GSIS.
const board = { season: 2026, players: Object.entries(catalog).map(([id, c]) => ({ sleeper_id: id, player_id: c.gsis_id, position: c.position })) };
const pageArgs = t => {
  const drops = {};
  if (t.drop_a.length) drops[t.a + 1] = t.drop_a;
  if (t.drop_b.length) drops[t.b + 1] = t.drop_b;
  return { remaining, league, catalog, board, rosters: pageRosters, rosterIds: [t.a + 1, t.b + 1], give: t.give_a, receive: t.give_b, currentWeek: 4, assumeAvailable: true, now: NOW, snapshotAt: NOW, drops };
};
const trades = T.sampleTrades(ROSTERS, FC, T.mulberry32(11), 60).map((t, i) => Object.assign({ id: `2023:5:0:${i}`, season: 2023, origin: 5, k: 0 }, t));
// What the pages compute for a trade (null when the page cannot analyze it, e.g. a side left without a QB).
const pageView = t => {
  let si;
  try { si = ST.stratumInputs(pageArgs(t)); } catch (e) { return null; }
  return { si, starts: { sides: si.sides }, population: si.sides.every(s => s.give.some(x => x >= 0.5)), measure: STM.lopsidedMeasure(si.sides) };
};
const views = new Map(trades.map(t => [t.id, pageView(t)]));
const comparable = trades.filter(t => views.get(t.id));

check("sanity: the page can analyze most of the mini season's trades", () => {
  assert.equal(trades.length, 60);
  // stratumInputs fills empty slots from the free-agent pool exactly as the backtest does, so every trade is comparable.
  assert.equal(comparable.length, 60, `page evaluated ${comparable.length} of 60`);
});

/* Tested population (spec §10.2): a trade is in the tested population when each side gives a player who starts in
   at least half the weeks of its own current-method before-lineup. The backtest decides it from frozen p50 with a
   replacement fill (frozenStarters); the page reads the same shares off analyze's lineups (gradeStep). */
check("tested-population membership agrees between frozenStarters and the page", () => {
  const starters = ROSTERS.map(r => T.frozenStarters(r, FC, SLOTS, WEEKS, UNDRAFTED));
  let inPop = 0;
  for (const t of comparable) {
    const backtest = t.give_a.some(id => starters[t.a].has(id)) && t.give_b.some(id => starters[t.b].has(id));
    assert.equal(views.get(t.id).population, backtest, `trade ${t.id} give ${t.give_a}/${t.give_b}`);
    if (backtest) inPop++;
  }
  assert.ok(inPop > 5 && inPop < comparable.length, `the population rule bites both ways (${inPop} of ${comparable.length})`);
});

// One run of the backtest's own cell code over those trades gives its strata and current-method deltas.
const cell = T.runCell({ season: 2023, origin: 5, k: 0, rosters: ROSTERS, undrafted: UNDRAFTED, forecasts: FC, actualWeeks: ACT, availability: AV, tags: {},
  slots: SLOTS, nSims: 40, simSeed: 1, trades, waiver: false });
const rowsOf = t => cell.rows.filter(r => r.trade_id === t.id);

check("depth_for_starter and the position strata agree between the backtest and the page", () => {
  assert.equal(cell.excluded, null);
  const horizon = { strata: {}, lopsided_cutoff: null };
  let depth = 0;
  for (const t of comparable) {
    const rows = rowsOf(t);
    assert.equal(rows.length, 2);
    const backtest = rows[0].strata.filter(s => s !== "lopsided");
    const page = STM.stratumOf({ positions: [...t.give_a, ...t.give_b].map(id => catalog[id].position), sides: views.get(t.id).starts.sides }, views.get(t.id).measure, horizon);
    assert.deepEqual(page, backtest, `trade ${t.id} give ${t.give_a}/${t.give_b}`);
    if (backtest.includes("depth_for_starter")) depth++;
  }
  assert.ok(depth > 0, "the depth stratum occurs in the sample");
});

/* Review M2 (now aligned): for stratum assignment and the population check the page computes start shares and Δ with
   the backtest's method -- byes out, empty slots filled from the replacement pool. A sole RB on bye in week 6 starts 2 of
   3 weeks in both. The displayed lineup scenario (analyze) is unchanged: it still shows the bye-week RB at 0 points. */
check("M2 aligned: a bye-week player does not start in the stratum inputs, as in the backtest; the displayed lineup is unchanged", () => {
  const fc = JSON.parse(JSON.stringify(FC));
  fc.players.aR1.weeks[6] = { status: "bye" };
  const solo = ["aQ", "aR1", "aW"];
  const p50 = (id, w) => (fc.players[id].weeks[w].status === "play" ? fc.players[id].weeks[w].p50 : null);
  const pool = T.replacementPool(UNDRAFTED, fc, WEEKS, SLOTS, p50);
  const backtestStarts = T.predictLineupOnly([solo], p50, WEEKS, SLOTS, T.replOf(pool, p50), id => fc.players[id].position)[0].starts;
  assert.equal(backtestStarts.aR1, 2);
  const remaining2 = { ...remaining, players: Object.entries(fc.players).map(([id, pl]) => ({ player_id: "g" + id, team: "A", position: pl.position, weeks: WEEKS.map(w => pageRow(w, pl.weeks[w])) })) };
  const args = { ...pageArgs({ a: 0, b: 1, give_a: ["aR1"], give_b: ["bW1"], drop_a: [], drop_b: [] }), remaining: remaining2,
    rosters: [{ roster_id: 1, players: solo }, { roster_id: 2, players: ROSTERS[1] }] };
  assert.ok(Math.abs(ST.stratumInputs(args).sides[0].give[0] - 2 / 3) < 1e-12, "page stratum inputs: aR1 starts 2 of 3 weeks");
  const week6 = ST.analyze({ ...args, give: ["aW"] }).weeks.find(w => w.week === 6).sides[0].before.lineup;
  assert.ok(week6.some(pl => pl.id === "aR1" && pl.status === "bye" && pl.points === 0), "displayed scenario keeps the bye-week RB at 0 points");
});

/* Lopsided stratum (spec §10.3): the measure is the larger side's |current-method Δ|; the cutoff is the 90th
   percentile per origin; a trade is lopsided at or above the cutoff. The page computes the measure from analyze's
   lineups (lopsidedMeasure) and applies stratumOf; the backtest from its rows (markLopsided). */
check("lopsided measure and membership agree between markLopsided and the page", () => {
  const rows = comparable.flatMap(rowsOf).map(r => Object.assign({}, r, { strata: r.strata.slice() }));
  const cutoff = T.markLopsided(rows)[5];
  assert.ok(Number.isFinite(cutoff) && cutoff > 0);
  let flagged = 0;
  for (const t of comparable) {
    const flaggedByBacktest = rows.find(r => r.trade_id === t.id).strata.includes("lopsided");
    const measureBacktest = Math.max(...rowsOf(t).map(r => Math.abs(r.current)));
    const v = views.get(t.id);
    assert.ok(Math.abs(v.measure - measureBacktest) < 1e-9, `trade ${t.id}: page measure ${v.measure} vs backtest ${measureBacktest}`);
    const page = STM.stratumOf({ positions: [catalog[t.give_a[0]].position], sides: v.starts.sides }, v.measure, { strata: {}, lopsided_cutoff: cutoff });
    assert.equal(page.includes("lopsided"), flaggedByBacktest, `trade ${t.id} measure ${v.measure} cutoff ${cutoff}`);
    if (flaggedByBacktest) flagged++;
  }
  assert.ok(flagged >= 1 && flagged < comparable.length, `some but not all trades are lopsided (${flagged})`);
});

/* Replacement pool sizing (dedicated + FLEX [+ SUPER_FLEX] per position): one rule in the backtest and the
   trade page. (The waiver desk's copy left with its simulation, spec §6.2.) */
check("replacement pool sizing agrees between the backtest and the trade page, SUPER_FLEX included", () => {
  for (const slots of [["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX"], ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "SUPER_FLEX"], ["QB", "SUPER_FLEX"], ["QB", "RB", "WR", "TE", "FLEX"]]) {
    assert.deepEqual(ST.replacementNeeds(slots), T.poolSizes(slots), `trade page ${slots}`);
  }
});

if (failed.length) { console.log(`FAILED (${failed.length}):\n  ` + failed.join("\n  ")); process.exit(1); }
console.log(`sim_parity_fixture: ${n} groups OK`);
