// tools/queue_cost.cjs
/* What does being absent cost? ANALYSIS HARNESS, not shipped site code.
   Sleeper's autopick "will select players based on the owner's queue", so an
   absent manager with a queue is not the same as one without. This measures
   the difference in projected starting-lineup points over identical drafts.

     present   the live tool at every pick -- Optimizer.recommend()
     queue     absent; autopick consumes a queue you pasted BEFORE the draft
     noQueue   absent; autopick uses Sleeper's own rankings

   THREE LEAKS THIS FILE EXISTS TO AVOID. Each one produced a published
   number that was wrong, and each was found only by looking for it:

     1. A FROZEN QUEUE. The first version rebuilt the queue inside every
        perturbed trial, from that trial's own realized order. The "static"
        queue therefore knew in advance the exact deviation it was supposed
        to survive, which is the whole thing being measured. It reported the
        queue costing 1.7 points; frozen, the same construction costs ~30 and
        is WORSE than having no queue at all. A queue is pasted once, before
        the draft, from the board as it stands then -- so it is built once,
        from the base board, and never rebuilt.

     2. PUBLISHED ORDER vs REALIZED ORDER. Perturbation models how the field
        actually drafts, not what the rankings said. A static policy (your
        queue, Sleeper's rankings) can only ever see the PUBLISHED board. So
        `fieldOrder` is perturbed and drives removals, while every policy
        reads base `adp` and base value. Letting a policy sort on perturbed
        adp is leak 1 wearing a different hat.

     3. A STRAWMAN "PRESENT" ARM. Scoring the present manager with an
        immediate one-ply greedy understates the tool and so flatters every
        absent arm. `present` calls the real Optimizer.recommend(), the same
        eight-pick rollout the live panel runs.

   Field noise is bootstrapped from observed draft-vs-ADP residuals and
   carries the usual caveat: the correlation unit of a draft is the DRAFT, so
   one observed draft is n=1 however many picks it holds, and per-player
   independent resampling cannot reproduce positional runs. Spread is a
   sensitivity range, never a probability.

   Usage:
     node tools/queue_cost.cjs --picks <draft-picks.json> [--residuals <completed.json>]
       [--mycells 87,135] [--mykeepers "Cam Skattebo,Harold Fannin"]
       [--slot 10] [--teams 12] [--rounds 15] [--trials 150] [--seed 1] [--depth 75]
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
const TRIALS = Number(args.trials || 150), SEED = Number(args.seed || 1);
const QUEUE_DEPTH = Number(args.depth || 75);
const MODES = ["vorp", "plan", "backups", "value"];

const board = JSON.parse(fs.readFileSync(path.join(repo, args.board || "site/data/draft.json"), "utf8")).players;
const picks = JSON.parse(fs.readFileSync(path.resolve(args.picks), "utf8"));
const find = K.indexBoard(board);
const leagueKeepers = picks.filter(p => p.is_keeper);
const used = new Set(leagueKeepers.map(p => p.pick_no));
const keptNames = new Set(leagueKeepers.map(p => find(K.pickName(p))).filter(Boolean).map(r => r.name));

const myKeeperCells = (args.mycells || "").split(",").filter(Boolean).map(Number);
const myKeepers = (args.mykeepers || "").split(",").filter(Boolean).map(n => find(n.trim())).filter(Boolean);
const mine = K.seatPicks(SLOT, TEAMS, ROUNDS).filter(p => !myKeeperCells.includes(p));

const basePool = board.filter(b => !keptNames.has(b.name) &&
  ["QB", "RB", "WR", "TE"].includes(b.position) && Number.isFinite(O.seasonValue(b)));
const byId = new Map(basePool.map(p => [p.player_id, p]));

const resid = args.residuals
  ? K.residuals(JSON.parse(fs.readFileSync(path.resolve(args.residuals), "utf8")), find, TEAMS)
  : null;

/* The order the field ACTUALLY drafts in, as ids. Perturbation lives here and
   nowhere else -- policies never see it (leak 2). */
function fieldOrder(seed) {
  const scored = basePool.filter(p => Number.isFinite(p.adp)).map(p => {
    if (seed == null || !resid) return { id: p.player_id, k: p.adp };
    const bank = (resid.byPos && resid.byPos[p.position]) || resid.pooled;
    return { id: p.player_id, k: p.adp + bank[Math.floor(K.playerDraw(p.player_id || p.name, seed) * bank.length)] };
  });
  scored.sort((a, b) => a.k - b.k);
  return scored.map(s => s.id);
}

function buildQueue(depth, mode) {
  const byValue = list => list.slice().sort((a, b) => (O.seasonValue(b) || 0) - (O.seasonValue(a) || 0));
  const q = [], seen = new Set();
  const push = p => { if (p && !seen.has(p.player_id)) { seen.add(p.player_id); q.push(p); } };
  if (mode === "value") { byValue(basePool).forEach(push); return q.slice(0, depth); }

  /* A static policy wants a RANKING, not a PLAN. A plan encodes one path
     through the draft, so when the field blocks it the queue marches on
     regardless; a ranking encodes preferences, which degrade gracefully.
     That is why ADP order beats every plan-shaped queue here.
     The ranking has to be POSITION-NEUTRAL, though, which raw seasonValue is
     not: QB replacement level is the highest of any position, so ordering by
     it front-loads eight quarterbacks (see the "value" arm). VORP is neutral
     by construction -- points above what you could otherwise get AT THAT
     POSITION -- which is exactly optimizer.js's own reason for using it to
     break lineup-indifferent ties. */
  if (mode === "vorp") {
    basePool.slice().sort((a, b) => (b.vorp || 0) - (a.vorp || 0)).forEach(push);
    return q.slice(0, depth);
  }

  const plan = O.finishRoster(myKeepers.slice(), basePool, mine, 0, used)
    .filter(p => !myKeepers.some(k => k.player_id === p.player_id));

  if (mode === "backups") {
    // MEASURED FAILURE, kept as a comparison arm. A queue cannot tell "a
    // substitute for THIS slot" from "the pick for the NEXT slot", so once the
    // planned QB is gone it spends the next turn on a second quarterback.
    for (const p of plan) {
      push(p);
      byValue(basePool.filter(c => c.position === p.position && !seen.has(c.player_id))).slice(0, 2).forEach(push);
    }
  } else {
    plan.forEach(push);                     // "plan": the rollout, in order
  }
  byValue(basePool).forEach(push);          // tail, so the queue is never exhausted
  return q.slice(0, depth);
}

const capped = (roster, pos) => {
  const cap = O.DEPTH_CAP[pos];
  return cap != null && roster.filter(p => p.position === pos).length >= cap;
};

const strategies = {
  present: (roster, avail, q, at, future) => {
    const r = O.recommend({ available: avail, myPlayers: roster, futurePicks: future,
                            usedPicks: used, pickNo: at });
    return r && r.length ? r[0].player : null;
  },
  queue: (roster, avail, q) => {
    const live = new Set(avail.map(p => p.player_id));
    for (const e of q) if (live.has(e.player_id) && !capped(roster, e.position)) return byId.get(e.player_id);
    return strategies.noQueue(roster, avail);
  },
  // Sleeper's private ranking, proxied by PUBLISHED adp -- never the realized order.
  noQueue: (roster, avail) => avail.filter(p => Number.isFinite(p.adp) && !capped(roster, p.position))
    .sort((a, b) => a.adp - b.adp)[0] || null,
};

function runDraft(pick, queue, order) {
  let roster = myKeepers.slice();
  const availIds = new Set(basePool.map(p => p.player_id));
  let cursor = 0, prev = 0;
  for (let i = 0; i < mine.length; i++) {
    const at = mine[i];
    let n = O.openPicksBetween(prev, at, used);
    while (n > 0 && cursor < order.length) {
      const id = order[cursor++];
      if (availIds.has(id)) { availIds.delete(id); n--; }
    }
    const avail = [];
    for (const id of availIds) avail.push(byId.get(id));
    const taken = pick(roster, avail, queue, at, mine.slice(i + 1));
    if (taken) { roster = roster.concat([taken]); availIds.delete(taken.player_id); }
    prev = at;
  }
  return O.lineupPoints(roster);
}

const stat = a => {
  const s = a.slice().sort((x, y) => x - y), q = t => s[Math.min(s.length - 1, Math.floor(t * s.length))];
  return { mean: a.reduce((x, c) => x + c, 0) / a.length, p10: q(0.1), p50: q(0.5), p90: q(0.9) };
};

console.log(`seat slot ${SLOT}/${TEAMS}, ${mine.length} picks; keepers ${myKeepers.map(k => k.name).join(", ") || "none"}`);
const queues = {};
for (const m of MODES) queues[m] = buildQueue(QUEUE_DEPTH, m);
console.log(`queues FROZEN from the base board (never rebuilt per trial):`);
for (const m of MODES) {
  console.log(`  ${m.padEnd(8)} ${queues[m].slice(0, 8).map(p => `${p.position} ${p.name.split(" ").slice(-1)[0]}`).join(" | ")} …`);
}

const baseOrder = fieldOrder(null);
const detPresent = runDraft(strategies.present, null, baseOrder);
console.log(`\ndeterministic (field drafts published ADP order):`);
console.log(`  present            ${detPresent.toFixed(1)}`);
for (const m of MODES) {
  const v = runDraft(strategies.queue, queues[m], baseOrder);
  console.log(`  queue[${m.padEnd(8)}]  ${v.toFixed(1)}   ${(v - detPresent).toFixed(1).padStart(7)} vs present`);
}
const dn = runDraft(strategies.noQueue, null, baseOrder);
console.log(`  no queue (ADP)     ${dn.toFixed(1)}   ${(dn - detPresent).toFixed(1).padStart(7)} vs present`);

if (resid) {
  const gaps = { noQueue: [] }, pres = [];
  for (const m of MODES) gaps["queue:" + m] = [];
  for (let t = 0; t < TRIALS; t++) {
    const order = fieldOrder((SEED + t * 7919) >>> 0);
    const p = runDraft(strategies.present, null, order);
    pres.push(p);
    gaps.noQueue.push(runDraft(strategies.noQueue, null, order) - p);
    for (const m of MODES) gaps["queue:" + m].push(runDraft(strategies.queue, queues[m], order) - p);
  }
  const ps = stat(pres);
  console.log(`\nover ${TRIALS} realized field orders (sensitivity range, NOT a probability):`);
  console.log(`  present  mean ${ps.mean.toFixed(1)}  p10 ${ps.p10.toFixed(1)}  p90 ${ps.p90.toFixed(1)}`);
  console.log(`\n  cost of being absent, points vs being present:`);
  for (const k of Object.keys(gaps)) {
    const g = stat(gaps[k]);
    console.log(`    ${k.padEnd(15)} mean ${g.mean.toFixed(1).padStart(7)}  p10 ${g.p10.toFixed(1).padStart(7)}  p90 ${g.p90.toFixed(1).padStart(7)}`);
  }
}
