// tools/turn_scan.cjs -- does the greedy rollout misbehave at a TURN?
//
//   node tools/turn_scan.cjs [--board site/data/draft-espnfam.json]
//
// WHY. The rollout in optimizer.js is greedy on immediate lineup gain, and
// .review §3a records the consequence: at a seat with BACK-TO-BACK picks it can
// recommend a player its own simulated future self would refuse to take. That
// was unreachable in both Sleeper leagues -- seats 7 and 10 have no adjacent
// picks -- so it was documented and deliberately left alone. A 13-team board
// puts a turn at seats 1 and 13, and the draft order is randomised an hour
// before, so "unreachable" no longer holds and the question needs an answer
// rather than an assumption.
//
// WHAT THIS MEASURES. For every seat, at that seat's first pick with the field
// taking the best available by ECR: what the shipped optimizer recommends,
// against the highest-VORP player actually on the board. A recommendation that
// is not the VORP leader is not automatically wrong -- that is the whole point
// of the lineup rollout -- so the flag here is the §3a SIGNATURE specifically:
// a low-VORP quarterback taken over a far better skill player.
//
// WHAT IT CANNOT TELL YOU. Which choice actually scores more in a real season.
// Both branches are scored on the same board; only tools/draft_sim.cjs --worlds
// has an answer key. This locates the behaviour, it does not price it.
"use strict";
const fs = require("fs");
const path = require("path");

if (typeof global.window === "undefined") global.window = {};
if (typeof global.document === "undefined") {
  global.document = { addEventListener() {}, getElementById: () => null,
                      querySelector: () => null, hidden: false };
}
if (typeof global.localStorage === "undefined") {
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
}
const SITE = path.join(__dirname, "..", "site", "assets");
const O = require(path.join(SITE, "optimizer.js"));
global.window.Optimizer = O;                 // see replay_draft.cjs on why explicitly
require(path.join(SITE, "draftmode.js"));
const DM = global.window.DraftMode;
const MD = require(path.join(SITE, "manualdraft.js"));

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const boardPath = arg("--board", path.join(__dirname, "..", "site", "data", "draft-espnfam.json"));
const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
O.configure(board.league);

const teams = board.league.teams;
const rounds = board.league.rounds;
const ME = "manual-user";

const scored = O.withValuePoints(board.players)
  .filter(p => Number.isFinite(O.seasonValue(p)));
// The field's taste: best available by expert consensus, which is what
// draftmode's own rollout assumes the rest of the room is doing.
const byEcr = scored.slice().filter(p => Number.isFinite(p.ecr))
  .sort((a, b) => a.ecr - b.ecr);

function recommendAt(mySlot, throughPick) {
  // The field takes the top ECR board players for every pick before this one.
  const taken = byEcr.slice(0, throughPick - 1);
  const entries = taken.map(p => ({ player_id: p.sleeper_id, name: p.name, position: p.position }));
  const picks = MD.synthPicks(entries, { teams, type: "snake", mySlot, userId: ME });
  const rs = DM.rosterStateFromPicks(picks, mySlot, ME);
  const seat = { slot: mySlot, teams, rounds, reversalRound: 0, userId: ME };
  const plan = DM.planFromPicks(picks, seat, "snake");
  if (!plan) return null;
  const mine = board.players.filter(p => p.sleeper_id && rs.mine.has(p.sleeper_id));
  const available = scored.filter(p => !(p.sleeper_id && rs.drafted.has(p.sleeper_id)));
  const rec = O.recommend({
    available, myPlayers: mine, pickNo: plan.next,
    futurePicks: plan.future, usedPicks: plan.used,
  });
  const best = available.slice().sort((a, b) => (b.vorp || -1e9) - (a.vorp || -1e9))[0];
  return { plan, rec, best, available };
}

console.log(`board: ${board.league.name} -- ${teams} teams, ${rounds} rounds`);
console.log(`\nEach seat's FIRST pick, field on ECR. "gap" = picks until your next turn.\n`);
console.log("seat  pick  gap   recommended                    vorp    VORP leader                    vorp   flag");

let flagged = 0;
for (let slot = 1; slot <= teams; slot++) {
  const firstPick = MD.snakeSlot(1, teams, "snake") === slot ? 1
    : [...Array(teams).keys()].map(i => i + 1).find(n => MD.snakeSlot(n, teams, "snake") === slot);
  const r = recommendAt(slot, firstPick);
  if (!r) { console.log(`${String(slot).padStart(4)}  (no pick)`); continue; }
  const top = r.rec[0] && r.rec[0].player;
  if (!top) { console.log(`${String(slot).padStart(4)}  (no shortlist)`); continue; }
  // Picks between this one and the seat's next -- 0 means a TURN.
  const gap = r.plan.future.length ? r.plan.future[0] - r.plan.next - 1 : null;
  const isReach = top.position === "QB" && (r.best.vorp - top.vorp) > 30;
  if (isReach) flagged++;
  console.log(
    `${String(slot).padStart(4)}  ${String(r.plan.next).padStart(4)}  ${String(gap).padStart(3)}   `
    + `${(top.position + " " + top.name).padEnd(30)} ${String(top.vorp.toFixed(1)).padStart(6)}  `
    + `${(r.best.position + " " + r.best.name).padEnd(30)} ${String(r.best.vorp.toFixed(1)).padStart(6)}`
    + `   ${isReach ? "<-- QB REACH" : (top.name === r.best.name ? "" : "differs")}`);
}

// The turn itself: the seats whose picks are adjacent, at the pick where that
// first happens. This is the configuration §3a says is required.
console.log(`\nAt the TURN (gap 0) -- the configuration the artifact needs:\n`);
for (const slot of [1, teams]) {
  for (let n = 1; n <= teams * 4; n++) {
    if (MD.snakeSlot(n, teams, "snake") !== slot) continue;
    if (MD.snakeSlot(n + 1, teams, "snake") !== slot) continue;
    const r = recommendAt(slot, n);
    if (!r) break;
    const top = r.rec[0] && r.rec[0].player;
    if (!top) break;
    console.log(`seat ${slot}: picks ${n} and ${n + 1} are adjacent`);
    console.log(`  recommends   ${top.position} ${top.name} (vorp ${top.vorp.toFixed(1)})`);
    console.log(`  VORP leader  ${r.best.position} ${r.best.name} (vorp ${r.best.vorp.toFixed(1)})`);
    console.log(`  top 3        ${r.rec.slice(0, 3).map(x =>
      `${x.player.position} ${x.player.name}`).join("  |  ")}`);
    // The §3a asymmetry test: take the recommendation, then ask again at n+1.
    // If the tool would not itself take the VORP leader next, the two picks
    // disagree about the same two players.
    const takeIt = byEcr.slice(0, n - 1).concat([top]);
    const entries = takeIt.map(p => ({ player_id: p.sleeper_id, name: p.name, position: p.position }));
    const picks2 = MD.synthPicks(entries, { teams, type: "snake", mySlot: slot, userId: ME });
    const rs2 = DM.rosterStateFromPicks(picks2, slot, ME);
    const plan2 = DM.planFromPicks(picks2, { slot, teams, rounds, reversalRound: 0, userId: ME }, "snake");
    const mine2 = board.players.filter(p => p.sleeper_id && rs2.mine.has(p.sleeper_id));
    const avail2 = scored.filter(p => !(p.sleeper_id && rs2.drafted.has(p.sleeper_id)));
    const rec2 = O.recommend({ available: avail2, myPlayers: mine2, pickNo: plan2.next,
                               futurePicks: plan2.future, usedPicks: plan2.used });
    console.log(`  then at ${plan2.next}: ${rec2.slice(0, 3).map(x =>
      `${x.player.position} ${x.player.name}`).join("  |  ")}`);
    break;
  }
}
console.log(`\n${flagged} seat(s) showed the §3a QB-reach signature at their first pick.`);
