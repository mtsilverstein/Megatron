// tools/keeper_subsets.cjs
/* Keeper-subset evaluator. ANALYSIS HARNESS, not shipped site code.
   Answers "which keeper set should I lock?" by enumerating every feasible
   subset and scoring each through the optimizer's own objective, rather than
   pricing a forfeited pick with a context-free scalar.

   Why enumeration and not a per-pick price: the value of surrendering pick
   #34 depends on the other keeper, the roster it lands on, and the rest of
   your pick complement. There is no context-free number for "#34" that can
   be subtracted inside a greedy ranking loop. Comparing whole states is the
   only framing that stays honest, and it is the pattern trade.js already
   uses for trade verdicts.

   Three modelling traps this harness exists to avoid, all of which produced
   wrong answers during its development:

     1. `Optimizer.openPicksBetween` tests `used.size`. Passing an ARRAY of
        pick numbers silently disables keeper-awareness -- no throw, no
        warning, just a quietly different answer (measured: a +10.1 margin
        that was really +1.8). `used` is built as a Set here and asserted.

     2. A keeper you DECLINE returns to the draft pool. Leaving every league
        keeper off the board regardless of the subject state overstates the
        subsets that release a good player, because it deletes a player the
        field would really have had to spend a pick on.

     3. `finishRoster` does not finish a roster: it simulates at most
        ROLLOUT_PICKS (8) of your selections, and breaks early once nothing
        improves the lineup -- the early break survives any horizon. A FIXED
        horizon is also unfair across states: keeping nobody leaves 15 picks
        and keeping two leaves 13, so capping all of them at 13 discards two
        of the no-keeper state's picks and flatters the states that keep.
        `--horizon full` gives each state `rounds - |keepers|`.

   Field noise is calibrated from an OBSERVED draft, never a made-up band.
   `fieldTakes` drafts strictly ADP-best; real fields do not (measured on a
   completed 12-team keeper mock, phase-centred sd by position: QB 9.1,
   RB 4.8, WR 4.9, TE 6.3). Bootstrapping observed residuals carries the real
   distribution's shape instead of a gaussian reality does not have.

   NOTE ON WHAT THE NOISE OUTPUT IS FOR. The correlation unit of a draft is
   the DRAFT, not the pick, so one completed draft is n=1 however many picks
   it contains -- and per-player independent resampling cannot reproduce
   positional runs. The stochastic block is a SENSITIVITY TOOL. Do not quote
   its win-rates as probabilities; that needs whole-draft resampling over
   many comparable drafts. The deterministic table is the shippable claim.

   Usage:
     node tools/keeper_subsets.cjs --picks <draft-picks.json> \
       [--board site/data/draft.json] [--slot 10] [--teams 12] [--rounds 15] \
       [--keeper "Name:cell" ...] [--residuals <completed-picks.json>] \
       [--trials 400] [--seed 1] [--horizon 8,13]
*/
const fs = require("fs");
const path = require("path");

// ---- args ------------------------------------------------------------------
function parseArgs(argv) {
  const out = { keeper: [], horizon: [8], trials: 400, seed: 1,
                board: "site/data/draft.json", slot: 10, teams: 12, rounds: 15 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    if (a === "--keeper") out.keeper.push(take());
    else if (a === "--horizon") {
      const v = take();
      out.horizon = v === "full" ? "full" : v.split(",").map(Number);
    }
    else if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = take();
      out[k] = /^\d+$/.test(v) ? Number(v) : v;
    }
  }
  return out;
}

// ---- deterministic RNG (explicit state so arms can share a draw) -----------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ---- board / picks ---------------------------------------------------------
const norm = s => String(s == null ? "" : s).toLowerCase().replace(/[^a-z ]/g, "").replace(/ +/g, " ").trim();

function indexBoard(players) {
  const byName = new Map();
  for (const p of players) byName.set(norm(p.name), p);
  return name => {
    const n = norm(name);
    if (byName.has(n)) return byName.get(n);
    for (const [k, v] of byName) if (k.startsWith(n.slice(0, 14)) && n.length >= 6) return v;
    return null;
  };
}

const pickName = p => {
  const m = (p && p.metadata) || {};
  return `${m.first_name || ""} ${m.last_name || ""}`.trim();
};

// Snake pick numbers for one seat.
function seatPicks(slot, teams, rounds) {
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    out.push(r % 2 === 1 ? (r - 1) * teams + slot : (r - 1) * teams + (teams - slot + 1));
  }
  return out;
}

/* Field-vs-ADP residuals from a COMPLETED draft, centred within phase so the
   bootstrap carries dispersion and skew but not the league-wide level shift.
   The level shift is already reproduced by drafting from a keeper-depleted
   pool, so injecting it again would double-count.

   Phase-CENTRED and position-STRATIFIED -- note those are different axes:
   observations are de-meaned within (position x 3-round phase) buckets, then
   pooled into ONE bank per position, and the fallback triggers on a
   position's TOTAL n. Draws are not taken from position x phase strata.
   Stratifying by position matters because pooling is not innocuous: on the
   measured draft the phase-centred sd is QB 11.0, TE 8.5, RB 5.5, WR 4.9.
   A single pooled sd of 6.8 hands quarterbacks too little noise and wide
   receivers too much, which biases exactly the positional-scarcity
   comparisons this harness exists to make. `pooled` remains as the fallback
   for a position with too few observations to stratify. */
function residuals(picks, find, teams) {
  const phase = pk => Math.floor((pk - 1) / (teams * 3));   // 3-round buckets
  const buckets = new Map();                                // (pos, phase) -> []
  for (const p of picks) {
    if (p.is_keeper) continue;
    const b = find(pickName(p));
    if (!b || b.adp == null) continue;
    const key = `${b.position}|${phase(p.pick_no)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p.pick_no - b.adp);
  }
  const byPos = {}, pooled = [];
  for (const [key, arr] of buckets) {
    const pos = key.split("|")[0];
    const mean = arr.reduce((a, c) => a + c, 0) / arr.length;
    for (const v of arr) {
      const c = v - mean;
      (byPos[pos] || (byPos[pos] = [])).push(c);
      pooled.push(c);
    }
  }
  const MIN_PER_POS = 12;
  for (const pos of Object.keys(byPos)) if (byPos[pos].length < MIN_PER_POS) delete byPos[pos];
  return { byPos, pooled };
}

/* Draws keyed by PLAYER, not by iteration order. Restarting one RNG per state
   is not pairing: each state filters the pool differently, so the nth draw
   lands on a different player and the "common random numbers" are common in
   name only. Hashing (trial seed, player_id) gives a player the same
   perturbation in every state of a trial, which is what pairing requires. */
function playerDraw(playerId, seed) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  const s = String(playerId);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// ---- evaluation ------------------------------------------------------------
/* `used` is STATE-SPECIFIC and must be rebuilt per subset. Building it once
   from the observed draft and reusing it is the phantom-selection error in a
   new costume: in a state that keeps Nabers, cell #34 leaves `mine` but never
   enters `used`, so the rollout counts it as a FIELD selection and hands the
   field a pick that nobody made. Symmetrically, a state that declines Fannin
   must release #135 back into the live picks. So:

       used(state) = other teams' keeper cells
                   + cells of the candidates THIS state keeps

   Other teams' cells are the observed keeper cells minus every cell belonging
   to a candidate under test, since those are exactly the ones the state
   decides. */
function usedForState(observedCells, candidates, keepers) {
  const candidateCells = new Set(candidates.map(c => c.cell));
  const out = new Set();
  for (const c of observedCells) if (!candidateCells.has(c)) out.add(c);
  for (const k of keepers) out.add(k.cell);
  return out;
}

function evaluate(O, opts) {
  const { keepers, board, leagueKeeperNames, allMine, observedCells,
          candidates, seed, resid } = opts;
  const keepNames = new Set(keepers.map(k => k.row.name));
  const cells = keepers.map(k => k.cell);
  const mine = allMine.filter(p => !cells.includes(p));
  const used = usedForState(observedCells, candidates, keepers);

  // Candidates this state DECLINES go back into the pool (trap 2).
  const declined = new Set(candidates.filter(c => !keepNames.has(c.row.name)).map(c => c.row.name));
  const pool = board.filter(b =>
    (!leagueKeeperNames.has(b.name) || declined.has(b.name)) &&
    !keepNames.has(b.name) &&
    ["QB", "RB", "WR", "TE"].includes(b.position) &&
    Number.isFinite(O.seasonValue(b)));

  const perturbed = resid
    ? pool.map(p => {
        if (!Number.isFinite(p.adp)) return p;
        const bank = (resid.byPos && resid.byPos[p.position]) || resid.pooled;
        const u = playerDraw(p.player_id || p.name, seed);
        return Object.assign({}, p, { adp: p.adp + bank[Math.floor(u * bank.length)] });
      })
    : pool;

  const finished = O.finishRoster(keepers.map(k => k.row), perturbed, mine, 0, used);
  return { pts: O.lineupPoints(finished), roster: finished, picks: mine, used };
}

function subsetsUpTo(list, max) {
  const out = [[]];
  for (let i = 0; i < list.length; i++) {
    out.push([list[i]]);
    if (max >= 2) for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
  }
  return out.filter(s => s.length <= max);
}

// ---- main ------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv);
  const repo = path.resolve(__dirname, "..");
  const board = JSON.parse(fs.readFileSync(path.resolve(repo, args.board), "utf8")).players;
  const picks = JSON.parse(fs.readFileSync(path.resolve(args.picks), "utf8"));
  const find = indexBoard(board);

  const leagueKeepers = picks.filter(p => p.is_keeper);
  const observedCells = new Set(leagueKeepers.map(p => p.pick_no));
  if (!(observedCells instanceof Set)) throw new Error("used must be a Set (trap 1)");
  const leagueKeeperNames = new Set(
    leagueKeepers.map(p => find(pickName(p))).filter(Boolean).map(r => r.name));

  const candidates = args.keeper.map(spec => {
    const i = spec.lastIndexOf(":");
    const name = spec.slice(0, i), cell = Number(spec.slice(i + 1));
    const row = find(name);
    if (!row) throw new Error(`no board row for keeper candidate "${name}"`);
    if (!Number.isFinite(cell)) throw new Error(`bad cell for "${name}"`);
    return { name: row.name, row, cell };
  });
  if (!candidates.length) throw new Error("pass at least one --keeper Name:cell");

  const allMine = seatPicks(args.slot, args.teams, args.rounds);
  const maxKeepers = Math.min(2, candidates.length);
  const states = subsetsUpTo(candidates, maxKeepers);

  const resid = args.residuals
    ? residuals(JSON.parse(fs.readFileSync(path.resolve(args.residuals), "utf8")), find, args.teams)
    : null;

  console.log(`board ${args.board} (${board.length} rows) | seat slot ${args.slot} of ${args.teams}, ${args.rounds} rounds`);
  console.log(`league keepers ${leagueKeepers.length} (cells ${[...observedCells].sort((a, b) => a - b).join(",")})`);
  if (resid) {
    const line = (n, a) => `${n} n=${a.length} sd=${Math.sqrt(a.reduce((x, c) => x + c * c, 0) / a.length).toFixed(1)}`;
    console.log(`field residuals from ${path.basename(args.residuals)}, phase-centred then pooled per position:`);
    console.log(`  ${["QB", "RB", "WR", "TE"].filter(p => resid.byPos[p])
      .map(p => line(p, resid.byPos[p])).join("  |  ")}  |  ${line("pooled-fallback", resid.pooled)}`);
  }

  /* ROLLOUT_PICKS is a module constant, so a horizon is a separately loaded
     copy of the optimizer. Memoised: loading it per state would be O(states). */
  const optCache = new Map();
  const loadOptimizer = H => {
    if (optCache.has(H)) return optCache.get(H);
    const src = fs.readFileSync(path.join(repo, "site/assets/optimizer.js"), "utf8");
    const patched = src.replace(/const ROLLOUT_PICKS = \d+;/, `const ROLLOUT_PICKS = ${H};`);
    if (patched === src && !/const ROLLOUT_PICKS = 8;/.test(src)) throw new Error("could not patch ROLLOUT_PICKS");
    const tmp = path.join(require("os").tmpdir(), `opt_h${H}_${process.pid}.cjs`);
    fs.writeFileSync(tmp, patched);
    const prev = global.window;
    global.window = undefined;
    const O = require(tmp);
    global.window = prev;
    optCache.set(H, O);
    return O;
  };

  /* A FIXED horizon truncates smaller subsets asymmetrically: keeping nobody
     leaves 15 picks to simulate, keeping two leaves 13. Capping all of them
     at 13 silently discards two of the no-keeper state's picks and flatters
     the states that keep players. "full" gives each state its own real pick
     count; finishRoster still breaks early when nothing improves the lineup. */
  const horizonFor = state => args.horizon === "full"
    ? args.rounds - state.length
    : null;

  const base = { board, leagueKeeperNames, allMine, observedCells, candidates };
  const label = s => s.length ? s.map(c => c.name).join(" + ") : "(keep nobody)";
  const horizons = args.horizon === "full" ? ["full"] : args.horizon;

  for (const H of horizons) {
    const forState = s => loadOptimizer(H === "full" ? horizonFor(s) : H);
    console.log(`\n===== horizon ${H === "full" ? "full (rounds - keepers, per state)" : H} =====`);

    const point = states.map(s => ({
      s, pts: evaluate(forState(s), Object.assign({ keepers: s, seed: args.seed, resid: null }, base)).pts }));
    point.sort((a, b) => b.pts - a.pts);
    const top = point[0].pts;
    console.log("  deterministic (field drafts strict ADP order):");
    for (const r of point) {
      console.log(`    ${label(r.s).padEnd(24)} ${r.pts.toFixed(1).padStart(8)}  ${(r.pts - top).toFixed(1).padStart(7)}`);
    }

    if (resid) {
      console.log(`  bootstrapped field noise, ${args.trials} paired trials (player-keyed draws):`);
      const wins = new Map(states.map(s => [label(s), 0]));
      const runs = new Map(states.map(s => [label(s), []]));
      for (let t = 0; t < args.trials; t++) {
        const seed = (args.seed + t * 7919) >>> 0;
        let bestName = null, bestPts = -Infinity;
        for (const s of states) {
          const pts = evaluate(forState(s), Object.assign({ keepers: s, seed, resid }, base)).pts;
          runs.get(label(s)).push(pts);
          if (pts > bestPts) { bestPts = pts; bestName = label(s); }
        }
        wins.set(bestName, wins.get(bestName) + 1);
      }
      const ranked = [...runs.entries()].map(([k, v]) => ({
        k, mean: v.reduce((a, c) => a + c, 0) / v.length, win: wins.get(k) / args.trials
      })).sort((a, b) => b.mean - a.mean);
      const bestMean = ranked[0].mean;
      for (const r of ranked) {
        console.log(`    ${r.k.padEnd(24)} mean ${r.mean.toFixed(1).padStart(8)}  ${(r.mean - bestMean).toFixed(1).padStart(7)}` +
                    `   best in ${(100 * r.win).toFixed(0).padStart(3)}% of trials`);
      }
    }
  }
}

if (require.main === module) main();
module.exports = { seatPicks, residuals, subsetsUpTo, indexBoard, rng, playerDraw, pickName, usedForState };
