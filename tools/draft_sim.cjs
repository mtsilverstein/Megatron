// tools/draft_sim.cjs — draft-strategy backtest.
//
//   node tools/draft_sim.cjs --worlds models/backtests/worlds --seeds 8
//   node tools/draft_sim.cjs --board site/data/draft.json --seeds 20   (2026, no answer key)
//
// Runs the REAL shipped optimizer (site/assets/optimizer.js) as one team in a
// 12-team snake draft against 11 teams drafting the market, then scores every
// roster on what the players ACTUALLY did, week by week. Loading the shipped
// module rather than reimplementing its logic is the point: a port would test
// a copy, and the copy is exactly where a backtest stops being evidence.
//
// WHAT THIS MEASURES, AND WHAT IT CANNOT
// The field is modelled as "best available on the market board, with noise".
// Real leagues have humans who reach for their own guys, run on positions,
// and chase names. Noise stands in for that and is deliberately coarse. So
// this answers "does acting on our numbers beat drafting straight off the
// consensus board", which is the claim the tool actually makes. It does not
// simulate a specific opponent, and it cannot tell you about in-season
// management (waivers, trades, start/sit), which is where a large share of
// real fantasy outcomes are decided.
"use strict";
const fs = require("fs");
const path = require("path");
const O = require(path.join(__dirname, "..", "site", "assets", "optimizer.js"));

const TEAMS = 12, ROUNDS = 15;
const DEDICATED = O.DEDICATED, FLEX_POS = O.FLEX_POS, FLEX_SLOTS = O.FLEX_SLOTS;
const REGULAR_WEEKS = 14;          // fantasy regular season
const FULL_WEEKS = 17;

// --- deterministic RNG so every reported number is reproducible from a seed --
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
// Box-Muller, for the field's deviation from the market board.
function gauss(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --- the field -----------------------------------------------------------
// Real drafters follow the consensus loosely, not exactly. Each drafter draws
// a private ordering by jittering market rank; ADP_NOISE_RANKS is the standard
// deviation of that jitter in ranks. This is a coarse stand-in for human
// behaviour, not a fitted parameter -- results are reported across seeds so a
// single lucky ordering cannot carry a conclusion.
const ADP_NOISE_RANKS = 8;
// Overridable so the conclusion can be checked against the assumption: if the
// edge only survives at one noise level it is an artifact of the field model,
// not a property of the tool. `--noise` sweeps it.
let adpNoise = ADP_NOISE_RANKS;
function setNoise(sd) { adpNoise = Number.isFinite(sd) ? sd : ADP_NOISE_RANKS; }

function marketOrder(players, rand) {
  return players
    .filter(p => Number.isFinite(p.adp))
    .map(p => ({ p, key: p.adp + gauss(rand) * adpNoise }))
    .sort((a, b) => a.key - b.key)
    .map(x => x.p);
}

const CAP = { QB: 2, RB: 6, WR: 6, TE: 2 };

// A market drafter still has to field a legal lineup, so he takes the best
// player on his own board who is not at an already-saturated position.
function marketPick(order, taken, roster) {
  const counts = O.rosterSlots(roster);
  let fallback = null;
  for (const p of order) {
    if (taken.has(p.player_id)) continue;
    if (!fallback) fallback = p;
    if ((counts[p.position] || 0) < CAP[p.position]) return p;
  }
  return fallback;
}

/* --- the human field -------------------------------------------------------

   Gaussian jitter around ADP is UNEXPLOITABLE BY CONSTRUCTION. It is zero-mean,
   so the field still drafts the consensus on average, and the board IS the
   consensus -- there is nothing for a disciplined drafter to feed on. That may
   be the whole reason the first backtest measured no edge.

   Human draft error is not symmetric. Two behaviours below are systematic,
   well-documented, need no data this project does not already have, and both
   push good players DOWN the board where someone can pick them up:

     * PANIC. A drafter with no starting quarterback or tight end late does not
       keep taking best-available; he reaches. This is the single-slot positions
       specifically, which is where real drafts visibly break.
     * RUNS. When several players at a position go in quick succession, drafters
       jump the position for fear of missing it.

   Each drafter draws a `panic` propensity from the seed, so a league contains
   both disciplined and jumpy managers rather than twelve identical ones.

   HONEST FRAMING, up front: making the field worse MECHANICALLY raises our
   measured edge. This does not show the tool is good. It sizes how much of the
   tool's value comes from other people's mistakes, which is the thing a real
   league actually contains. Read the two field modes side by side, never the
   human number alone.
*/
// Round by which a drafter insists on filling a single-starter slot. UN-TUNED:
// chosen from how real drafts look, not fitted to any result.
const PANIC_ROUND = { QB: 9, TE: 10 };
const RUN_WINDOW = 6;      // picks of recent history a drafter reacts to
const RUN_TRIGGER = 3;     // that many at one position reads as a run

function bestAt(order, taken, position) {
  for (const p of order) {
    if (!taken.has(p.player_id) && p.position === position) return p;
  }
  return null;
}

function humanPick(order, taken, roster, ctx) {
  const counts = O.rosterSlots(roster);
  const rand = ctx.rand;
  // Panic: a mandatory single slot still empty, and it is getting late.
  for (const pos of ["QB", "TE"]) {
    if (counts[pos] === 0 && ctx.round >= PANIC_ROUND[pos] && rand() < ctx.panic) {
      const pick = bestAt(order, taken, pos);
      if (pick) return pick;
    }
  }
  // Runs: react to what just happened, not to the board.
  const recent = ctx.recent.slice(-RUN_WINDOW);
  for (const pos of O.POSITIONS) {
    const hot = recent.filter(r => r === pos).length;
    if (hot >= RUN_TRIGGER && (counts[pos] || 0) < CAP[pos] && rand() < ctx.panic) {
      const pick = bestAt(order, taken, pos);
      if (pick) return pick;
    }
  }
  return marketPick(order, taken, roster);
}

// --- snake math ----------------------------------------------------------
const pickForRoundSlot = (r, slot) =>
  r % 2 === 0 ? r * TEAMS - slot + 1 : (r - 1) * TEAMS + slot;
function futurePicks(round, slot) {
  const out = [];
  for (let r = round + 1; r <= ROUNDS; r++) out.push(pickForRoundSlot(r, slot));
  return out;
}

// --- scoring: what the roster actually banked ----------------------------
// Best legal lineup re-picked EVERY week from actual weekly points. A player
// with no row that week did not play (bye, injury, inactive) and is not
// startable -- he is absent, not a scored zero, which is the difference
// between a hole in your lineup and a zero you chose to start.
function actualPoints(roster, weeks, lastWeek) {
  let total = 0;
  for (let w = 1; w <= lastWeek; w++) {
    const active = [];
    for (const p of roster) {
      const pts = weeks[p.player_id] && weeks[p.player_id][String(w)];
      if (Number.isFinite(pts)) active.push({ p, pts });
    }
    const byPos = { QB: [], RB: [], WR: [], TE: [] };
    for (const a of active) if (byPos[a.p.position]) byPos[a.p.position].push(a);
    const leftovers = [];
    for (const pos of Object.keys(byPos)) {
      byPos[pos].sort((x, y) => y.pts - x.pts);
      for (let i = 0; i < byPos[pos].length; i++) {
        if (i < DEDICATED[pos]) total += byPos[pos][i].pts;
        else if (FLEX_POS.includes(pos)) leftovers.push(byPos[pos][i]);
      }
    }
    leftovers.sort((x, y) => y.pts - x.pts);
    for (const l of leftovers.slice(0, FLEX_SLOTS)) total += l.pts;
  }
  return total;
}

// --- one draft -----------------------------------------------------------
// `heroSlot` is the seat our optimizer occupies; every other seat drafts the
// market. Returns every roster so the hero can be ranked against the field it
// actually played.
function runDraft(players, heroSlot, seed, field = "consensus") {
  const rand = rng(seed);
  const orders = [];
  // Each drafter's private board AND his temperament come from the same seed,
  // so a league is reproducible and contains a mix of disciplined and jumpy
  // managers rather than twelve copies of one behaviour.
  const panic = [];
  for (let t = 1; t <= TEAMS; t++) {
    orders.push(marketOrder(players, rand));
    panic.push(rand());
  }
  const rosters = Array.from({ length: TEAMS + 1 }, () => []);
  const taken = new Set();
  const recent = [];
  const scoreable = players.filter(p => Number.isFinite(O.seasonValue(p)));

  for (let round = 1; round <= ROUNDS; round++) {
    for (let slot = 1; slot <= TEAMS; slot++) {
      const pickNo = pickForRoundSlot(round, slot);
      let choice;
      if (slot === heroSlot) {
        const available = scoreable.filter(p => !taken.has(p.player_id));
        const rec = O.recommend({
          available, myPlayers: rosters[slot], pickNo,
          futurePicks: futurePicks(round, slot),
        });
        choice = rec.length ? rec[0].player
                            : marketPick(orders[slot - 1], taken, rosters[slot]);
      } else if (field === "human") {
        choice = humanPick(orders[slot - 1], taken, rosters[slot],
                           { round, recent, panic: panic[slot - 1], rand });
      } else {
        choice = marketPick(orders[slot - 1], taken, rosters[slot]);
      }
      if (!choice) continue;
      taken.add(choice.player_id);
      rosters[slot].push(choice);
      recent.push(choice.position);
    }
  }
  return rosters;
}

// --- experiment ----------------------------------------------------------
// A world missing its market column does not fail -- it DEGENERATES, which is
// worse. With no `adp` the field drafts nobody, our optimizer believes every
// player survives to its next pick, and it drafts unopposed: the first run of
// this harness reported a +2470 point "edge" and a 100% win rate from exactly
// that. Same for the answer key: no `actual_weeks` overlap scores every roster
// at zero. Both are checked loudly before a single number is produced.
// The bar is not a share of the board -- real ADP only ever covers the players
// people actually draft (the 2026 snapshot lists 235 of 695). The bar is
// whether the field can fill the draft: TEAMS * ROUNDS picks must come off a
// market board, or drafters start passing and the hero inherits a board no
// real opponent left him.
const MARKET_FLOOR = TEAMS * ROUNDS;

function assertMarketDepth(label, players) {
  const withAdp = players.filter(p => Number.isFinite(p.adp)).length;
  if (withAdp < MARKET_FLOOR) {
    throw new Error(
      `${label}: only ${withAdp} players carry a market position (adp), but the `
      + `field must make ${MARKET_FLOOR} picks. Drafters would run out and start `
      + `passing, and the result would be meaningless rather than wrong-looking.`);
  }
  return withAdp;
}

function assertWorldUsable(world, players) {
  assertMarketDepth(`season ${world.season}`, players);
  const scored = players.filter(p => world.actual_weeks[p.player_id]).length;
  if (scored < 0.25 * players.length) {
    throw new Error(
      `season ${world.season}: only ${scored}/${players.length} board players have any `
      + `actual weekly scoring — every roster would score ~0.`);
  }
}

function evaluateSeason(world, seeds, field = "consensus") {
  const players = O.withValuePoints(world.players);
  assertWorldUsable(world, players);
  const weeks = world.actual_weeks;
  const rows = [];
  for (let seed = 1; seed <= seeds; seed++) {
    for (let heroSlot = 1; heroSlot <= TEAMS; heroSlot++) {
      // Same seed, same slot, run twice: once with our optimizer in the seat,
      // once with a market drafter in it. Identical field, identical draft
      // order, identical noise -- so the only difference is the strategy, and
      // the comparison is not contaminated by draft position or luck of order.
      const withHero = runDraft(players, heroSlot, seed, field);
      const allMarket = runDraft(players, 0, seed, field);
      for (const [lastWeek, label] of [[REGULAR_WEEKS, "reg"], [FULL_WEEKS, "full"]]) {
        const hero = actualPoints(withHero[heroSlot], weeks, lastWeek);
        const field = [];
        for (let t = 1; t <= TEAMS; t++) {
          if (t !== heroSlot) field.push(actualPoints(withHero[t], weeks, lastWeek));
        }
        const counterfactual = actualPoints(allMarket[heroSlot], weeks, lastWeek);
        field.sort((a, b) => b - a);
        rows.push({
          season: world.season, seed, slot: heroSlot, window: label,
          hero, counterfactual,
          edge: hero - counterfactual,
          fieldMean: field.reduce((a, b) => a + b, 0) / field.length,
          rank: field.filter(f => f > hero).length + 1,
        });
      }
    }
  }
  return rows;
}

function summarize(rows, window) {
  const r = rows.filter(x => x.window === window);
  if (!r.length) return null;
  const mean = k => r.reduce((a, b) => a + b[k], 0) / r.length;
  const edges = r.map(x => x.edge).sort((a, b) => a - b);
  const q = f => edges[Math.min(edges.length - 1, Math.floor(f * edges.length))];
  return {
    n: r.length,
    hero_mean: +mean("hero").toFixed(1),
    market_same_seat_mean: +mean("counterfactual").toFixed(1),
    field_mean: +mean("fieldMean").toFixed(1),
    edge_mean: +mean("edge").toFixed(1),
    edge_median: +q(0.5).toFixed(1),
    edge_p10: +q(0.1).toFixed(1),
    edge_p90: +q(0.9).toFixed(1),
    win_rate_vs_same_seat: +(r.filter(x => x.edge > 0).length / r.length).toFixed(3),
    mean_rank_of_12: +mean("rank").toFixed(2),
    top3_rate: +(r.filter(x => x.rank <= 3).length / r.length).toFixed(3),
  };
}

// --- current-season dry run ------------------------------------------------
// 2026 has not happened, so there is no answer key and this is NOT a backtest.
// It answers the question you can actually ask before a draft: from each seat,
// what does the tool DO, and does the roster it builds project higher than the
// one you would get drafting straight off the market? Both sides are measured
// with the same projections, so this can only show internal consistency --
// never whether the projections are right. Only `--worlds` can show that.
function dryRun(board, seeds, field = "consensus") {
  const players = O.withValuePoints(board.players)
    .filter(p => Number.isFinite(O.seasonValue(p)));
  assertMarketDepth(`${board.season} board`, players);
  const rows = [];
  for (let seed = 1; seed <= seeds; seed++) {
    for (let slot = 1; slot <= TEAMS; slot++) {
      const hero = runDraft(players, slot, seed, field)[slot];
      const market = runDraft(players, 0, seed, field)[slot];
      const counts = O.rosterSlots(hero);
      rows.push({
        seed, slot,
        shape: `QB${counts.QB} RB${counts.RB} WR${counts.WR} TE${counts.TE}`,
        projected: +O.lineupPoints(hero).toFixed(1),
        market_projected: +O.lineupPoints(market).toFixed(1),
        firstTeRound: hero.findIndex(p => p.position === "TE") + 1 || null,
        firstQbRound: hero.findIndex(p => p.position === "QB") + 1 || null,
        picks: hero.map(p => `${p.position} ${p.name}`),
      });
    }
  }
  const mean = k => rows.reduce((a, b) => a + b[k], 0) / rows.length;
  const shapes = {};
  for (const r of rows) shapes[r.shape] = (shapes[r.shape] || 0) + 1;
  const teRounds = rows.map(r => r.firstTeRound).filter(Boolean).sort((a, b) => a - b);
  return {
    rows,
    summary: {
      n: rows.length,
      projected_mean: +mean("projected").toFixed(1),
      market_projected_mean: +mean("market_projected").toFixed(1),
      projected_edge: +(mean("projected") - mean("market_projected")).toFixed(1),
      roster_shapes: shapes,
      median_first_te_round: teRounds.length ? teRounds[Math.floor(teRounds.length / 2)] : null,
      never_drafts_a_qb: rows.filter(r => !r.firstQbRound).length,
      never_drafts_a_te: rows.filter(r => !r.firstTeRound).length,
    },
  };
}

function parseArgs(argv) {
  const a = { worlds: null, board: null, seeds: 8, out: null, noise: null, field: "consensus" };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, ""), v = argv[i + 1];
    if (k in a) a[k] = (k === "seeds" || k === "noise") ? Number(v) : v;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.noise !== null) setNoise(args.noise);

  if (args.board) {
    const board = JSON.parse(fs.readFileSync(args.board, "utf8"));
    const { rows, summary } = dryRun(board, args.seeds, args.field);
    console.log(`DRY RUN — ${board.season} board, ${summary.n} simulated drafts`);
    console.log(`  (no answer key: this season has not happened. Shows what the tool `
      + `DOES, not whether it is right.)\n`);
    console.log(`  projected lineup   ${summary.projected_mean} pts`);
    console.log(`  same seat, market  ${summary.market_projected_mean} pts`);
    console.log(`  difference         ${summary.projected_edge >= 0 ? "+" : ""}`
      + `${summary.projected_edge} pts  (on OUR projections, both sides)`);
    console.log(`  median first TE    round ${summary.median_first_te_round}`);
    console.log(`  rosters with no QB ${summary.never_drafts_a_qb}   no TE ${summary.never_drafts_a_te}`);
    console.log(`  roster shapes:`);
    for (const [shape, k] of Object.entries(summary.roster_shapes).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${shape}  ${k}`);
    }
    const out = args.out || "models/backtests/draft_dryrun.json";
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ created: new Date().toISOString(),
      season: board.season, data_through: board.data_through,
      method: { teams: TEAMS, rounds: ROUNDS, seeds: args.seeds,
                field: `market ADP jittered by N(0, ${adpNoise}) ranks`,
                note: "projections on both sides — internal consistency only" },
      summary, rows }, null, 1));
    console.log(`\nwrote ${out}`);
    return;
  }

  const worlds = [];
  if (args.worlds) {
    for (const f of fs.readdirSync(args.worlds).filter(f => /^world_\d+\.json$/.test(f))) {
      worlds.push(JSON.parse(fs.readFileSync(path.join(args.worlds, f), "utf8")));
    }
  }
  if (!worlds.length) {
    console.error("no worlds found — run: python -m ffmodel.eval.draft_world");
    process.exit(1);
  }
  worlds.sort((a, b) => a.season - b.season);

  const all = [];
  const perSeason = {};
  for (const w of worlds) {
    const t0 = Date.now();
    const rows = evaluateSeason(w, args.seeds, args.field);
    all.push(...rows);
    perSeason[w.season] = { reg: summarize(rows, "reg"), full: summarize(rows, "full"),
                            model: w.model, market_source: w.market_source };
    const s = perSeason[w.season].reg;
    console.log(`${w.season} (${w.model}): edge ${s.edge_mean >= 0 ? "+" : ""}${s.edge_mean} pts `
      + `over the same seat drafting the market · wins ${(s.win_rate_vs_same_seat * 100).toFixed(0)}% `
      + `· mean finish ${s.mean_rank_of_12}/12 · ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  const report = {
    created: new Date().toISOString(),
    method: {
      teams: TEAMS, rounds: ROUNDS, seeds: args.seeds,
      scoring: "ppr, best legal lineup re-picked from ACTUAL weekly points",
      regular_weeks: REGULAR_WEEKS, full_weeks: FULL_WEEKS,
      field_mode: args.field,
      field: args.field === "human"
        ? `market board jittered by N(0, ${adpNoise}) ranks, plus panic at unfilled `
          + `QB/TE (rounds ${PANIC_ROUND.QB}/${PANIC_ROUND.TE}) and position runs `
          + `(${RUN_TRIGGER} of the last ${RUN_WINDOW}), per-drafter propensity`
        : `market board jittered by N(0, ${adpNoise}) ranks per drafter`,
      counterfactual: "the SAME seat, same seed, same field, drafting the market instead",
      caveat: "no in-season management (waivers/trades/start-sit); field is a "
            + "market-follower with noise, not a model of specific humans",
    },
    per_season: perSeason,
    overall: { reg: summarize(all, "reg"), full: summarize(all, "full") },
    rows: all,
  };
  const out = args.out || "models/backtests/draft_sim.json";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  const o = report.overall.reg;
  console.log(`\nOVERALL (weeks 1-${REGULAR_WEEKS}, n=${o.n} drafts):`);
  console.log(`  our tool        ${o.hero_mean} pts`);
  console.log(`  same seat, market ${o.market_same_seat_mean} pts`);
  console.log(`  edge            ${o.edge_mean >= 0 ? "+" : ""}${o.edge_mean} pts  `
    + `(median ${o.edge_median}, p10 ${o.edge_p10}, p90 ${o.edge_p90})`);
  console.log(`  beats that seat ${(o.win_rate_vs_same_seat * 100).toFixed(1)}% of the time`);
  console.log(`  mean finish     ${o.mean_rank_of_12} of 12   (top-3 ${(o.top3_rate * 100).toFixed(0)}%)`);
  console.log(`\nwrote ${out}`);
}

module.exports = { runDraft, actualPoints, marketOrder, marketPick, evaluateSeason, dryRun, assertMarketDepth,
                   assertWorldUsable,
                   summarize, pickForRoundSlot, futurePicks, rng, ADP_NOISE_RANKS, setNoise,
                   humanPick, bestAt, PANIC_ROUND, RUN_WINDOW, RUN_TRIGGER, CAP };
if (require.main === module) main();
