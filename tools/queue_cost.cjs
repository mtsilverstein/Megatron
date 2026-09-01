// tools/queue_cost.cjs
/* What does being absent cost? ANALYSIS HARNESS, not shipped site code.
   Sleeper's autopick "will select players based on the owner's queue"
   (confirmed by the user against Sleeper's own docs), so an absent manager
   with a good queue is not the same as an absent manager without one. This
   measures the difference in the only currency that matters -- projected
   starting-lineup points -- over identical field draws.

     arm 1  present    the live tool at every pick (optimizer's own greedy)
     arm 2  queue      absent; autopick consumes our queue top-down
     arm 3  no queue   absent; autopick uses Sleeper's rankings

   ARM 3 IS A PROXY AND MUST BE READ AS ONE. Sleeper's internal autopick
   ranking is not public, so ADP order stands in for it. ADP is a decent
   ranking, so this most likely FLATTERS arm 3 -- which makes arm 2's margin
   over it a conservative estimate. The comparison the user actually asked
   about, 1 vs 2, does not depend on the proxy at all.

   Field noise reuses the keeper harness's bootstrap of observed draft-vs-ADP
   residuals, and carries the same caveat: the correlation unit of a draft is
   the DRAFT, so one observed draft is n=1 and per-player independent
   resampling cannot reproduce positional runs. Spread is reported as a
   sensitivity range, never as a probability.
*/
const fs = require("fs");
const path = require("path");
const K = require("./keeper_subsets.cjs");

const repo = path.resolve(__dirname, "..");
global.window = undefined;
const O = require(path.join(repo, "site/assets/optimizer.js"));

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[++i];
}
const SLOT = Number(args.slot || 10), TEAMS = Number(args.teams || 12), ROUNDS = Number(args.rounds || 15);
const TRIALS = Number(args.trials || 300), SEED = Number(args.seed || 1);
const QUEUE_DEPTH = Number(args.depth || 75);

const board = JSON.parse(fs.readFileSync(path.join(repo, args.board || "site/data/draft.json"), "utf8")).players;
const picks = JSON.parse(fs.readFileSync(path.resolve(args.picks), "utf8"));
const find = K.indexBoard(board);
const leagueKeepers = picks.filter(p => p.is_keeper);
const used = new Set(leagueKeepers.map(p => p.pick_no));
const keptNames = new Set(leagueKeepers.map(p => find(K.pickName(p))).filter(Boolean).map(r => r.name));

// The seat's own keepers come off its pick list; everyone's come off the pool.
const myKeeperCells = (args.mycells || "").split(",").filter(Boolean).map(Number);
const myKeepers = (args.mykeepers || "").split(",").filter(Boolean).map(n => find(n.trim())).filter(Boolean);
const mine = K.seatPicks(SLOT, TEAMS, ROUNDS).filter(p => !myKeeperCells.includes(p));

const basePool = board.filter(b => !keptNames.has(b.name) &&
  ["QB", "RB", "WR", "TE"].includes(b.position) && Number.isFinite(O.seasonValue(b)));

const resid = args.residuals
  ? K.residuals(JSON.parse(fs.readFileSync(path.resolve(args.residuals), "utf8")), find, TEAMS)
  : null;

const perturb = (pool, seed) => !resid ? pool : pool.map(p => {
  if (!Number.isFinite(p.adp)) return p;
  const bank = (resid.byPos && resid.byPos[p.position]) || resid.pooled;
  return Object.assign({}, p, { adp: p.adp + bank[Math.floor(K.playerDraw(p.player_id || p.name, seed) * bank.length)] });
});

/* The queue, construction B: walk the optimizer's own deterministic rollout
   and, at each of its picks, emit the player it chose plus the next few at
   the SAME position. The backups are the whole point -- a queue entry is
   consumed only when everything above it is gone, so each slot has to be a
   good pick CONDITIONAL on that, which for a positional plan means "someone
   else at this position". A flat value ordering fails here: its top is
   RB/WR-heavy, so a run of them leaves the queue with no QB or TE at the
   depth where one is needed. */
function buildQueue(pool, depth, mode) {
  const byValue = list => list.slice().sort((a, b) => (O.seasonValue(b) || 0) - (O.seasonValue(a) || 0));
  const q = [], seen = new Set();
  const push = p => { if (p && !seen.has(p.name)) { seen.add(p.name); q.push(p); } };

  if (mode === "value") {
    byValue(pool).forEach(push);                       // naive baseline
    return q.slice(0, depth);
  }

  const plan = O.finishRoster(myKeepers.slice(), pool, mine, 0, used);
  const chosen = plan.filter(p => !myKeepers.some(k => k.name === p.name));

  /* MEASURED FAILURE, kept as a comparison arm so the fix stays honest.
     Emitting each rollout pick followed by same-position backups reads well
     and drafts terribly: the queue cannot tell "a substitute for THIS slot"
     from "the pick for the NEXT slot". Once the rollout's QB is taken at your
     first turn, the queue advances into his backups and spends your second
     turn on a second quarterback. Measured at -92.4 points vs being present,
     against -20.8 for having no queue at all -- i.e. actively harmful. */
  if (mode === "backups") {
    for (const p of chosen) {
      push(p);
      byValue(pool.filter(c => c.position === p.position && !seen.has(c.name))).slice(0, 2).forEach(push);
    }
    byValue(pool).forEach(push);
    return q.slice(0, depth);
  }

  /* The fix ("plan"): emit the rollout's picks IN ORDER and nothing else.
     A queue advances only when an entry is gone, so if the planned QB is
     taken the next entry is the plan's NEXT SLOT -- a different position,
     which is exactly the substitution you want. Robustness comes from the
     value-ordered tail, which is reached only once the whole plan is
     exhausted. This is what makes every prefix a sensible roster. */
  chosen.forEach(push);
  byValue(pool).forEach(push);
  return q.slice(0, depth);
}

const capped = (roster, pos) => {
  const cap = O.DEPTH_CAP[pos];
  return cap != null && roster.filter(p => p.position === pos).length >= cap;
};

/* One draft for one strategy. The field takes ADP-best between your turns;
   `used` keeps keeper cells from being counted as field selections. */
function runDraft(pick, pool, queue) {
  let roster = myKeepers.slice();
  let avail = pool.slice().sort((a, b) => (O.seasonValue(b) || 0) - (O.seasonValue(a) || 0));
  let prev = 0;
  for (const at of mine) {
    const gone = new Set(O.fieldTakes(avail, O.openPicksBetween(prev, at, used)).map(p => p.player_id));
    avail = avail.filter(p => !gone.has(p.player_id));
    const taken = pick(roster, avail, queue);
    if (taken) { roster = roster.concat([taken]); avail = avail.filter(p => p !== taken); }
    prev = at;
  }
  return O.lineupPoints(roster);
}

const strategies = {
  present: (roster, avail) => {
    const base = O.lineupPoints(roster);
    let best = null, bestGain = -Infinity;
    for (const c of O.topCandidates(avail, O.ROLLOUT_PER_POS)) {
      if (capped(roster, c.position)) continue;
      const g = O.lineupPoints(roster.concat([c])) - base;
      if (g > bestGain) { bestGain = g; best = c; }
    }
    return best;
  },
  queue: (roster, avail, queue) => {
    const live = new Set(avail.map(p => p.name));
    for (const q of queue) if (live.has(q.name) && !capped(roster, q.position)) {
      return avail.find(p => p.name === q.name);
    }
    return strategies.noQueue(roster, avail);
  },
  noQueue: (roster, avail) => avail.slice()
    .filter(p => Number.isFinite(p.adp) && !capped(roster, p.position))
    .sort((a, b) => a.adp - b.adp)[0] || null,
};

const stat = a => {
  const s = a.slice().sort((x, y) => x - y), q = t => s[Math.min(s.length - 1, Math.floor(t * s.length))];
  return { mean: a.reduce((x, c) => x + c, 0) / a.length, p10: q(0.1), p50: q(0.5), p90: q(0.9) };
};

console.log(`seat slot ${SLOT}/${TEAMS}, ${mine.length} picks; keepers ${myKeepers.map(k => k.name).join(", ") || "none"}`);
const MODES = ["plan", "backups", "value"];
const detQueue = buildQueue(basePool, QUEUE_DEPTH, "plan");
console.log(`queue built: ${detQueue.length} deep — first 12: ${detQueue.slice(0, 12).map(p => `${p.position} ${p.name}`).join(" | ")}`);

const det = {};
for (const k of Object.keys(strategies)) det[k] = runDraft(strategies[k], basePool, detQueue);
console.log(`\ndeterministic (field drafts strict ADP order):`);
console.log(`  present  ${det.present.toFixed(1)}`);
console.log(`  queue    ${det.queue.toFixed(1)}   ${(det.queue - det.present).toFixed(1)} vs present`);
console.log(`  no queue ${det.noQueue.toFixed(1)}   ${(det.noQueue - det.present).toFixed(1)} vs present`);

if (resid) {
  const runs = { present: [], queue: [], noQueue: [] }, gapQ = [], gapN = [];
  for (let t = 0; t < TRIALS; t++) {
    const pool = perturb(basePool, (SEED + t * 7919) >>> 0);
    const q = buildQueue(pool, QUEUE_DEPTH);
    const r = {};
    for (const k of Object.keys(strategies)) r[k] = runDraft(strategies[k], pool, q);
    for (const k of Object.keys(r)) runs[k].push(r[k]);
    gapQ.push(r.queue - r.present); gapN.push(r.noQueue - r.present);
  }
  console.log(`\nover ${TRIALS} perturbed field draws (sensitivity range, NOT a probability):`);
  for (const k of ["present", "queue", "noQueue"]) {
    const s = stat(runs[k]);
    console.log(`  ${k.padEnd(9)} mean ${s.mean.toFixed(1)}  p10 ${s.p10.toFixed(1)}  p90 ${s.p90.toFixed(1)}`);
  }
  const gq = stat(gapQ), gn = stat(gapN);
  console.log(`\n  cost of being absent WITH our queue:  mean ${gq.mean.toFixed(1)}  p10 ${gq.p10.toFixed(1)}  p90 ${gq.p90.toFixed(1)}`);
  console.log(`  cost of being absent WITHOUT it:      mean ${gn.mean.toFixed(1)}  p10 ${gn.p10.toFixed(1)}  p90 ${gn.p90.toFixed(1)}`);
  console.log(`  queue recovers ${(100 * (1 - gq.mean / gn.mean)).toFixed(0)}% of what being absent costs`);
}
