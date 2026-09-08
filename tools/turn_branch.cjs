// tools/turn_branch.cjs -- the §3a asymmetry test, at a genuine TURN.
//
//   node tools/turn_branch.cjs --slot 13 [--board site/data/draft-espnfam.json]
//
// AT A TURN NOTHING IS TAKEN BETWEEN YOUR TWO PICKS, so the ORDER you take
// them in cannot change WHO you get -- only which PAIR you end up holding can
// matter. That makes the turn the cleanest possible test of the greedy
// rollout: if the tool's first pick leads it to a pair worth less than the
// pair it would have reached by starting elsewhere, the greediness cost
// something real, and it cost it in the one configuration .review §3a says is
// required. If both branches converge on the same pair, the ordering is
// cosmetic and there is nothing to fix.
//
// Both branches are scored with the SHIPPED objective -- finishRoster then
// lineupTotal, exactly what recommend() optimises -- so this measures internal
// consistency, NOT whether the projections are right. A branch that wins here
// wins on our own numbers; only tools/draft_sim.cjs --worlds has an answer key.
"use strict";
const fs = require("fs");
const path = require("path");

if (typeof global.window === "undefined") global.window = {};
global.document = { addEventListener() {}, getElementById: () => null,
                    querySelector: () => null, hidden: false };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const SITE = path.join(__dirname, "..", "site", "assets");
const O = require(path.join(SITE, "optimizer.js"));
global.window.Optimizer = O;
require(path.join(SITE, "draftmode.js"));
const DM = global.window.DraftMode;
const MD = require(path.join(SITE, "manualdraft.js"));

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const board = JSON.parse(fs.readFileSync(
  arg("--board", path.join(__dirname, "..", "site", "data", "draft-espnfam.json")), "utf8"));
O.configure(board.league);
const teams = board.league.teams, rounds = board.league.rounds, ME = "manual-user";
const slot = parseInt(arg("--slot", String(teams)), 10);

const scored = O.withValuePoints(board.players).filter(p => Number.isFinite(O.seasonValue(p)));
const RANKED = scored.filter(p => Number.isFinite(p.ecr));

// A field that drafts the ECR list in exact order is ONE draw, and a single
// draw cannot tell a real effect from a coincidence of this particular order.
// Jitter perturbs each player's consensus rank by a seeded normal deviate, so
// each trial faces a plausibly different room. sd is in RANKS: 6 is about the
// spread real drafters show around consensus inside the first few rounds.
let SEED = 1;
function rnd() { SEED = (SEED * 1103515245 + 12345) & 0x7fffffff; return SEED / 0x7fffffff; }
function normal() {
  return Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
}
function makeField(sd) {
  if (!sd) return RANKED.slice().sort((a, b) => a.ecr - b.ecr);
  return RANKED.map(p => ({ p, k: p.ecr + normal() * sd }))
    .sort((a, b) => a.k - b.k).map(x => x.p);
}
let byEcr = makeField(0);

// The seat's first adjacent pair.
let turn = null;
for (let n = 1; n < teams * rounds; n++) {
  if (MD.snakeSlot(n, teams, "snake") === slot && MD.snakeSlot(n + 1, teams, "snake") === slot) {
    turn = n; break;
  }
}
if (turn === null) { console.log(`seat ${slot} has no turn in a ${teams}-team snake`); process.exit(0); }

function stateAfter(takenByMe, throughPick) {
  const field = byEcr.filter(p => !takenByMe.includes(p)).slice(0, throughPick - 1 - takenByMe.length);
  // Order matters only for pick numbering; the field fills every non-my slot.
  const all = [];
  let fi = 0, mi = 0;
  for (let n = 1; n < throughPick; n++) {
    const s = MD.snakeSlot(n, teams, "snake");
    if (s === slot && mi < takenByMe.length) all.push(takenByMe[mi++]);
    else all.push(field[fi++]);
  }
  const entries = all.filter(Boolean).map(p => ({
    player_id: p.sleeper_id, name: p.name, position: p.position }));
  const picks = MD.synthPicks(entries, { teams, type: "snake", mySlot: slot, userId: ME });
  const rs = DM.rosterStateFromPicks(picks, slot, ME);
  const plan = DM.planFromPicks(picks, { slot, teams, rounds, reversalRound: 0, userId: ME }, "snake");
  const mine = board.players.filter(p => p.sleeper_id && rs.mine.has(p.sleeper_id));
  const available = scored.filter(p => !(p.sleeper_id && rs.drafted.has(p.sleeper_id)));
  return { picks, rs, plan, mine, available };
}

// Value of a completed roster under the SHIPPED objective.
function branchValue(mineScored, available, plan) {
  const finished = O.finishRoster(mineScored, available, plan.future, plan.next, plan.used);
  return O.lineupTotal(finished);
}

const TRIALS = parseInt(arg("--trials", "0"), 10) || 0;
const SD = parseFloat(arg("--sd", "6"));
if (TRIALS > 0) {
  let differed = 0, toolBetter = 0, sum = 0;
  const diffs = [];
  for (let i = 0; i < TRIALS; i++) {
    SEED = 1000 + i * 7919;
    byEcr = makeField(SD);
    const st = stateAfter([], turn);
    const rc = O.recommend({ available: st.available, myPlayers: st.mine, pickNo: st.plan.next,
                             futurePicks: st.plan.future, usedPicks: st.plan.used });
    if (!rc.length) continue;
    const leader = st.available.slice().sort((a, b) => (b.vorp || -1e9) - (a.vorp || -1e9))[0];
    const vals = [];
    for (const first of [rc[0].player, leader]) {
      const sA = stateAfter([first], turn + 1);
      const rA = O.recommend({ available: sA.available, myPlayers: sA.mine, pickNo: sA.plan.next,
                               futurePicks: sA.plan.future, usedPicks: sA.plan.used });
      const second = rA[0] && rA[0].player;
      const sB = stateAfter([first, second].filter(Boolean), turn + 2);
      const ms = scored.filter(x => sB.rs.mine.has(x.sleeper_id));
      vals.push({ pair: [first, second], v: O.lineupTotal(
        O.finishRoster(ms, sB.available, sB.plan.future, sB.plan.next, sB.plan.used)) });
    }
    const same = vals[0].pair.map(x => x && x.name).sort().join("|")
               === vals[1].pair.map(x => x && x.name).sort().join("|");
    if (!same) {
      differed++;
      const d = vals[0].v - vals[1].v;
      diffs.push(d); sum += d;
      if (d >= 0) toolBetter++;
    }
  }
  diffs.sort((a, b) => a - b);
  console.log(`${board.league.name} -- seat ${slot}, turn at picks ${turn}/${turn + 1}`);
  console.log(`${TRIALS} jittered fields (sd ${SD} ranks), branch A = follow the tool,`);
  console.log(`branch B = start from the VORP leader. Scored on the SHIPPED objective.\n`);
  console.log(`  branches produced a different pair: ${differed}/${TRIALS}`);
  if (differed) {
    console.log(`  of those, following the tool was better: ${toolBetter}/${differed}`);
    console.log(`  mean advantage to the tool: ${(sum / differed).toFixed(2)} pts`);
    console.log(`  worst case for the tool:    ${diffs[0].toFixed(2)} pts`);
    console.log(`  best case for the tool:     ${diffs[diffs.length - 1].toFixed(2)} pts`);
    console.log(`\n  A negative WORST CASE is the §3a signature: the greedy first`);
    console.log(`  pick leading to a pair the tool's own objective ranks lower.`);
  }
  process.exit(0);
}

const s0 = stateAfter([], turn);
const rec0 = O.recommend({ available: s0.available, myPlayers: s0.mine, pickNo: s0.plan.next,
                           futurePicks: s0.plan.future, usedPicks: s0.plan.used });
const vorpLeader = s0.available.slice().sort((a, b) => (b.vorp || -1e9) - (a.vorp || -1e9))[0];

console.log(`${board.league.name} -- seat ${slot}, turn at picks ${turn} and ${turn + 1}`);
console.log(`TIE_POINTS = ${O.TIE_POINTS}\n`);
console.log(`shortlist at pick ${turn}:`);
for (const r of rec0.slice(0, 6)) {
  console.log(`  ${(r.player.position + " " + r.player.name).padEnd(28)}`
    + ` vorp ${String((r.player.vorp || 0).toFixed(1)).padStart(6)}`
    + `  cost ${String((r.cost != null ? r.cost : 0).toFixed(2)).padStart(6)}`
    + `  raw ${String((r.rawCost != null ? r.rawCost : 0).toFixed(2)).padStart(6)}`);
}

// Branch A: follow the tool. Branch B: start from the VORP leader instead.
const heads = [
  { label: "A follow the tool", first: rec0[0].player },
  { label: "B take VORP leader", first: vorpLeader },
];
console.log();
const results = [];
for (const h of heads) {
  if (!h.first) continue;
  const sA = stateAfter([h.first], turn + 1);
  const recA = O.recommend({ available: sA.available, myPlayers: sA.mine, pickNo: sA.plan.next,
                             futurePicks: sA.plan.future, usedPicks: sA.plan.used });
  const second = recA[0] && recA[0].player;
  const sB = stateAfter([h.first, second].filter(Boolean), turn + 2);
  const mineScored = scored.filter(p => sB.rs.mine.has(p.sleeper_id));
  const value = branchValue(mineScored, sB.available, sB.plan);
  results.push({ label: h.label, pair: [h.first, second], value });
  console.log(`${h.label}`);
  console.log(`  pick ${turn}:   ${h.first.position} ${h.first.name} (vorp ${(h.first.vorp||0).toFixed(1)})`);
  console.log(`  pick ${turn + 1}: ${second ? second.position + " " + second.name
    + " (vorp " + (second.vorp||0).toFixed(1) + ")" : "(none)"}`);
  console.log(`  projected best lineup after finishing the draft: ${value.toFixed(1)}\n`);
}

if (results.length === 2) {
  const d = results[0].value - results[1].value;
  const same = results[0].pair.map(p => p && p.name).sort().join("|")
             === results[1].pair.map(p => p && p.name).sort().join("|");
  console.log(same
    ? "SAME PAIR -- the two branches converge, so the ordering at the turn is cosmetic."
    : `DIFFERENT PAIRS. Following the tool is ${d >= 0 ? "+" : ""}${d.toFixed(2)} points`
      + ` against starting from the VORP leader, on the tool's own objective`
      + ` (TIE_POINTS ${O.TIE_POINTS}).`);
}
