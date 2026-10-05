// tests/waivers_fixture.cjs — run with: node tests/waivers_fixture.cjs
//
// The waiver ENGINE (Waivers.analyze) on the league-neutral inputs (any-league
// spec §7.1 both waiver bullets, §7.2, §3.3, §6.2, §8): weekly `points.league`,
// the legacy-shaped remaining payload, the board with `ros_value`. No
// contract checks, no preseason proxy, no simulation. Every league, roster and
// owner here is synthetic; the board's `wk` field is only this fixture's knob
// for the weekly p50 it publishes (the engine never reads it).
const assert = require("assert");
delete global.window;
const W = require("../site/assets/waivers.js");
assert.strictEqual(global.window, undefined, "CommonJS load must not require/mutate window");
const M = require("../site/assets/waivermode.js"); // pure rowText formatter shared by table and export
const Lineup = require("../site/assets/lineup.js");
const LD = require("../site/assets/leaguedata.js");
const LL = require("../site/assets/leaguelens.js");

const TEST_NOW = Date.parse("2026-09-10T12:00:00Z");
const H = 3600000;
const p = (id, pos, wk, extra = {}) => ({ sleeper_id: String(id), player_id: `g${id}`, name: `${pos}${id}`, position: pos, team:"A", wk, ros_value: null, ...extra });
const board = { players: [p(1,"QB",20),p(2,"RB",10),p(3,"WR",11),p(4,"TE",8),p(5,"K",7),p(6,"DEF",6),p(7,"RB",18),p(8,"WR",7),p(9,"QB",25),p(10,"TE",13),p(11,"K",1),p(99,"RB",30)] };
const league = { league_id:"L1", season: 2026, status:"in_season", total_rosters: 2, scoring_settings:{pass_td:4,rec:1}, roster_positions: ["QB","RB","WR","TE","FLEX","K","DEF","BN","IR","TAXI"], settings: { waiver_type:2, waiver_budget: 100, waiver_bid_min: 1 } };
const futureKickoffs = (week = 1) => ({season:2026,week,generated_at:new Date(TEST_NOW).toISOString(),teams:["A","B"],games:[{home:"A",away:"B",kickoff:new Date(TEST_NOW+H).toISOString()}]});
// The view's weekly shape: player_id (GSIS), projection team, points.league (no `league` contract field).
const freshWeekly = (players=board.players, week = 1) => ({season:2026,week,generated_at:new Date(TEST_NOW).toISOString(),data_through:"2026-wk00",players:players.filter(x=>Number.isFinite(x.wk)).map(x=>({player_id:x.player_id,team:Object.hasOwn(x,"current_team")?x.current_team:x.team,points:{league:{p50:x.wk}}}))});
const rosters = [
  { roster_id: 1, players: ["1","2","3","4","5","6","8","11"], starters:["1","2","3","4","8","5","6"], reserve: ["99"], taxi: [], settings: { waiver_budget_used: 40 } },
  { roster_id: 2, players: ["9"], starters:["9"], reserve: [], taxi: ["10"], settings: { waiver_budget_used: 0 } }
];
const base = { board, league, rosters, rosterId: 1, weekly: freshWeekly(), kickoffs:futureKickoffs(), snapshotAt:TEST_NOW, now:TEST_NOW, week: 1, protectedIds: [], budgetReserve: 20, transactions: [] };
const weekOf = (players, overrides) => { const w=freshWeekly(players); for (const [g,v] of Object.entries(overrides)) w.players.find(x=>x.player_id===g).points.league.p50=v; return w; };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const rowOf = (out, add, drop) => out.rows.find(r => r.add.id === add && (drop === null ? r.drop === null : r.drop && r.drop.id === drop));
let n = 0; const failed = [];
// FIXTURE_ALL=1 reports every failing group instead of stopping at the first (used to show new cases fail on old code).
function check(name, fn) { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; if (process.env.FIXTURE_ALL) { failed.push(e.message.split("\n")[0]); return; } throw e; } }

check("the lineup kernel's stage-1 path is the engine's lineup scorer", () => {
  assert.strictEqual(W.__lineupScore, Lineup.lineupScore);
  for (const gone of ["waiverGateOpen", "SIM", "simulationCoverageText", "poolNeeds"]) assert.ok(!(gone in W), `${gone} is gone (spec §6.2)`);
});
check("ownership excludes all active reserve and taxi players", () => {
  const out = W.analyze(base);
  assert.ok(out.rows.length > 0);
  assert.ok(out.rows.every(r => !["1","2","3","4","5","6","8","9","10","11","99"].includes(r.add.id)));
  assert.ok(out.roster.lockedReserveTaxiIds.includes("99"));
});
check("budget is explicit and reserve caps guidance", () => {
  const out = W.analyze(base);
  assert.deepStrictEqual(out.budget, { total:100, used:40, remaining:60, reserve:20, spendable:40 });
  assert.ok(out.rows.every(r => (r.bid.high === null || r.bid.high <= 40) && /not calibrated/.test(r.bid.label)));
  assert.match(out.rows[0].valueEstimate.label, /not a FAAB price/);
});
check("missing budget never defaults to 100", () => {
  assert.throws(() => W.analyze({ ...base, league: { ...league, settings: {waiver_type:2} } }), /waiver_budget/);
  assert.throws(() => W.analyze({ ...base, league: { ...league, settings: {waiver_type:2,waiver_budget:null} } }), /waiver_budget/);
  assert.throws(() => W.analyze({ ...base, rosters: [{...rosters[0],settings:{}},rosters[1]] }), /waiver_budget_used/);
});
check("rolling waivers allow missing budgets and never fabricate dollar bids", () => {
  const rollingLeague = {...league, settings:{waiver_type:0}};
  const rollingRosters = rosters.map(r => ({...r, settings:{waiver_position:r.roster_id}}));
  const out = W.analyze({...base, league:rollingLeague, rosters:rollingRosters});
  assert.equal(out.budget, null);
  assert.deepStrictEqual(out.waiver, {type:"rolling", priority:1, guidance:"Order claims by value and roster need; current priority is context, not a claim-success probability."});
  assert.ok(out.rows.length > 0 && out.rows.every(r => r.bid === null));
});
check("reverse standings: ranked like rolling, no bids, labeled, no priority claim", () => {
  const rsLeague = {...league, settings:{waiver_type:1}};
  const rsRosters = rosters.map(r => ({...r, settings:{waiver_position:r.roster_id}}));
  const out = W.analyze({...base, league:rsLeague, rosters:rsRosters});
  assert.equal(out.budget, null);
  assert.equal(out.waiver.type, "reverse_standings");
  assert.equal(out.waiver.priority, null, "no priority number is claimed for reverse standings");
  assert.match(out.waiver.guidance, /^Reverse-standings waivers: order claims by value and roster need\. This desk does not model reverse-standings priority or claim success\.$/);
  assert.ok(out.rows.length > 1 && out.rows.every(r => r.bid === null));
  for (let i = 1; i < out.rows.length; i++) assert.ok(out.rows[i-1].lineupGain >= out.rows[i].lineupGain, "ranked by this week's gain");
  // The same rows as a rolling league: shared non-dollar mechanics.
  const rolling = W.analyze({...base, league:{...league, settings:{waiver_type:0}}, rosters:rsRosters});
  assert.deepStrictEqual(out.rows, rolling.rows);
  assert.equal(M.rowText(out.rows.find(r => r.drop === null) || out.rows[0], out).bid.includes("$"), false);
  // Blocked results carry the same label.
  const blocked = W.analyze({...base, league:rsLeague, rosters:rsRosters, weekly:null});
  assert.equal(blocked.waiver.type, "reverse_standings"); assert.equal(blocked.budget, null);
});
check("complete league and unique ownership are mandatory", () => {
  assert.throws(() => W.analyze({ ...base, rosters: [rosters[0]] }), /every league roster/);
  const dup = [rosters[0], {...rosters[1], players:["2"]}];
  assert.throws(() => W.analyze({ ...base, rosters: dup }), /duplicate ownership/);
  assert.throws(() => W.analyze({ ...base, rosters: [{...rosters[0],players:null},rosters[1]] }), /players must be an array/);
  assert.throws(() => W.analyze({ ...base, rosters: [rosters[0],{...rosters[1],roster_id:1}] }), /roster_id.*unique/);
});
check("an unknown starting slot fails visibly; projection-UI slots are accepted", () => {
  assert.throws(() => W.analyze({ ...base, league: {...league, roster_positions:["QB","XFLEX","BN"]} }), /unsupported starting roster position XFLEX/);
  const rs = [{...rosters[0], starters:["1","3"]}, rosters[1]];
  for (const slot of ["REC_FLEX", "WRRB_FLEX", "SUPER_FLEX"]) {
    assert.doesNotThrow(() => W.analyze({ ...base, rosters: rs, league: {...league, roster_positions:["QB",slot,"BN","BN","BN","BN","BN","BN","BN"]} }), slot);
  }
});
check("flex scoring finds marginal starter improvement and preserves lone QB TE K DEF", () => {
  const out = W.analyze(base);
  assert.ok(out.rows.some(r => r.add.id === "7" && r.drop.id === "8" && r.lineupGain > 0));
  assert.ok(out.rows.every(r => !["1","4","5","6","11"].includes(r.drop.id)));
});
check("WRRB_FLEX and REC_FLEX eligibility: a TE never fills WRRB_FLEX, an RB never fills REC_FLEX", () => {
  const b2 = { players: [p(1,"QB",20),p(2,"RB",10),p(3,"WR",11),p(4,"TE",8),p(8,"WR",7),p(12,"RB",6),p(20,"TE",30),p(21,"RB",30),p(22,"WR",30)] };
  const rs = sl => [{ roster_id:1, players:["1","2","3","4","8","12"], starters:sl.map((_, i) => ["1","2","3","4","8"][i] ?? "0"), reserve:[], taxi:[], settings:{waiver_budget_used:0} }, { roster_id:2, players:[], starters:[], reserve:[], taxi:[], settings:{waiver_budget_used:0} }];
  const run = (slots, extra) => W.analyze({ ...base, board:b2, weekly:freshWeekly(b2.players), league:{...league, roster_positions:slots.concat(["BN"])}, rosters:rs(slots), ...extra });
  // WRRB_FLEX (RB/WR): WR8 7 sits there. TE20 can only take the TE slot: +22 over TE4.
  let out = run(["QB","RB","WR","TE","WRRB_FLEX"]);
  assert.ok(close(rowOf(out, "20", "12").lineupGain, 22), "TE20 replaces TE4 (TE slot)");
  assert.ok(close(rowOf(out, "21", "12").lineupGain, 23), "RB21 takes WRRB_FLEX over WR8 (7) -> +23");
  assert.ok(close(rowOf(out, "22", "12").lineupGain, 23), "WR22 takes WR/WRRB_FLEX -> +23");
  // REC_FLEX (WR/TE): RB21 can only take the RB slot: +20 over RB2.
  out = run(["QB","RB","WR","TE","REC_FLEX"]);
  assert.ok(close(rowOf(out, "21", "12").lineupGain, 20), "RB21 replaces RB2 (RB slot), never REC_FLEX");
  assert.ok(close(rowOf(out, "20", "12").lineupGain, 23), "TE20 takes TE, TE4 moves to REC_FLEX over WR8 (8 > 7) -> 30+8 vs 8+7 = +23");
  assert.ok(close(rowOf(out, "22", "12").lineupGain, 23), "WR22 -> +23");
});
check("a started RB after a DL slot cancels the right modeled slot", () => {
  // Full starting slots: QB, DL, RB, WR, TE, FLEX. RB2's game (team S) has
  // started, so the RB slot (modeled index 1) is locked -- not WR (index 2),
  // which the old K/DEF-only index arithmetic would have locked.
  const b2 = { players: [p(1,"QB",20),p(2,"RB",10,{team:"S"}),p(3,"WR",11),p(4,"TE",8),p(8,"WR",7),{sleeper_id:"50",name:"DL50",position:"DL",team:"A",identity_only:true},p(7,"RB",18)] };
  const ko = {season:2026,week:1,generated_at:new Date(TEST_NOW).toISOString(),teams:["A","B","S","T"],games:[
    {home:"A",away:"B",kickoff:new Date(TEST_NOW+H).toISOString()},{home:"S",away:"T",kickoff:new Date(TEST_NOW-H).toISOString()}]};
  const lg = {...league, roster_positions:["QB","DL","RB","WR","TE","FLEX","BN","BN"]};
  const rs = [{ roster_id:1, players:["1","50","2","3","4","8"], starters:["1","50","2","3","4","8"], reserve:[], taxi:[], settings:{waiver_budget_used:0} }, { roster_id:2, players:[], starters:[], reserve:[], taxi:[], settings:{waiver_budget_used:0} }];
  const out = W.analyze({ ...base, board:b2, weekly:freshWeekly(b2.players), kickoffs:ko, league:lg, rosters:rs });
  // Open slots QB/WR/TE/FLEX (an open roster spot, so no drop): RB7 (18) can
  // only take FLEX from WR8 (7): +11. Locking WR instead would leave no RB
  // for the RB slot and the baseline could not be filled.
  assert.deepEqual(out.rows.map(r => [r.add.id, r.drop]), [["7", null]]);
  assert.equal(rowOf(out, "7", null).lineupGain, 11);
  assert.match(out.warnings.join(" "), /1 started starter\(s\) locked/);
  // Full roster: the started RB is never a drop.
  const fullOut = W.analyze({ ...base, board:b2, weekly:freshWeekly(b2.players), kickoffs:ko, league:{ ...lg, roster_positions:["QB","DL","RB","WR","TE","FLEX"] }, rosters:rs });
  assert.ok(fullOut.rows.length > 0 && fullOut.rows.every(r => r.drop && r.drop.id !== "2"));
  assert.equal(rowOf(fullOut, "7", "8").lineupGain, 11);
});
check("a started REC_FLEX occupant is locked in place; an RB there is an incompatible slot", () => {
  const b2 = { players: [p(1,"QB",20),p(2,"RB",10),p(3,"WR",11),p(4,"TE",8),p(8,"WR",7,{team:"S"}),p(12,"RB",3),p(22,"WR",15)] };
  const ko = {season:2026,week:1,generated_at:new Date(TEST_NOW).toISOString(),teams:["A","B","S","T"],games:[
    {home:"A",away:"B",kickoff:new Date(TEST_NOW+H).toISOString()},{home:"S",away:"T",kickoff:new Date(TEST_NOW-H).toISOString()}]};
  const lg = {...league, roster_positions:["QB","RB","WR","TE","REC_FLEX","BN"]};   // full: every add needs a drop
  const rs = st => [{ roster_id:1, players:["1","2","3","4","8","12"], starters:st, reserve:[], taxi:[], settings:{waiver_budget_used:0} }, { roster_id:2, players:[], starters:[], reserve:[], taxi:[], settings:{waiver_budget_used:0} }];
  const out = W.analyze({ ...base, board:b2, weekly:freshWeekly(b2.players), kickoffs:ko, league:lg, rosters:rs(["1","2","3","4","8"]) });
  // WR22 (15) can only replace WR3 (11) in the WR slot: REC_FLEX stays WR8's. +4.
  assert.ok(close(rowOf(out, "22", "12").lineupGain, 4));
  assert.ok(out.rows.every(r => r.drop.id !== "8"));
  // An RB occupying REC_FLEX whose game started is refused.
  const b3 = { players: b2.players.map(x => x.sleeper_id === "12" ? {...x, team:"S"} : x) };
  assert.throws(() => W.analyze({ ...base, board:b3, weekly:freshWeekly(b3.players), kickoffs:ko, league:lg, rosters:rs(["1","2","3","4","12"]) }), /started player RB12 is in an incompatible lineup slot/);
});
check("roster capacity: K/DEF/IDP occupants count as occupied, their slots as roster spots", () => {
  const b2 = { players: [p(1,"QB",20),p(2,"RB",10),p(3,"WR",11),p(4,"TE",8),p(7,"RB",18),{sleeper_id:"50",name:"DL50",position:"DL",team:"A",identity_only:true},{sleeper_id:"51",name:"LB51",position:"LB",team:"A",identity_only:true}] };
  const rs = players => [{ roster_id:1, players, starters:["1","2","3","4",players.includes("50")?"50":"0"], reserve:[], taxi:[], settings:{waiver_budget_used:0} }, { roster_id:2, players:[], starters:[], reserve:[], taxi:[], settings:{waiver_budget_used:0} }];
  const lg = {...league, roster_positions:["QB","RB","WR","TE","DL","BN","IR"]};   // 6 active spots
  const full = W.analyze({ ...base, board:b2, weekly:freshWeekly(b2.players), league:lg, rosters:rs(["1","2","3","4","50","51"]) });
  assert.ok(full.rows.length > 0 && full.rows.every(r => r.drop !== null), "six occupants (two IDP) fill six spots: every add needs a drop");
  assert.ok(full.rows.every(r => !["50","51"].includes(r.drop.id)), "IDP occupants are never skill drops");
  const open = W.analyze({ ...base, board:b2, weekly:freshWeekly(b2.players), league:lg, rosters:rs(["1","2","3","4","50"]) });
  assert.ok(open.rows.some(r => r.drop === null), "an empty spot (even next to an IDP slot) allows an add without a drop");
});
check("stale weekly is blocked (no preseason proxy)", () => {
  let out = W.analyze(base);
  assert.strictEqual(out.coverage.weeklyFresh, true); assert.strictEqual(out.rows[0].scoring.source, "weekly");
  assert.equal(out.rows[0].scoring.label, "week 1 projection");
  out = W.analyze({...base, weekly:{...freshWeekly(),generated_at:"2026-01-01T00:00:00Z"}});
  assert.strictEqual(out.coverage.weeklyFresh, false); assert.equal(out.rows.length, 0);
  assert.match(out.recommendationBlock, /stale.*fresh aligned weekly data required/);
  assert.ok(!out.warnings.some(w => /preseason proxy/.test(w)));
  // Whatever the league's status: there is no proxy path any more.
  out = W.analyze({...base, league:{...league, status:"drafting"}, weekly:null});
  assert.equal(out.rows.length, 0); assert.match(out.recommendationBlock, /weekly projections unavailable/);
});
check("no league/scoring contract: a weekly or remaining payload carrying another league's contract is still used", () => {
  const w = { ...freshWeekly(), league:{ league_id:"OTHER", sleeper_scoring:{ pass_td:6 } } };
  const out = W.analyze({ ...base, weekly:w, league:{ ...league, scoring_settings:{ pass_td:6, bonus_fd_wr:0.5 } } });
  assert.equal(out.coverage.weeklyFresh, true); assert.ok(out.rows.length > 0);
});
check("72-hour limits: weekly, kickoffs and remaining", () => {
  const at = ms => new Date(TEST_NOW - ms).toISOString();
  assert.equal(W.analyze({...base, weekly:{...freshWeekly(), generated_at:at(72*H - 1000)}}).coverage.weeklyFresh, true);
  const stale = W.analyze({...base, weekly:{...freshWeekly(), generated_at:at(72*H + 1000)}});
  assert.equal(stale.coverage.weeklyFresh, false); assert.match(stale.recommendationBlock, /weekly projections are stale \(over 72 hours old\)/);
  assert.match(W.analyze({...base, weekly:{...freshWeekly(), generated_at:at(-2*H)}}).recommendationBlock, /stale/, "future-dated beyond 1 h");
  assert.doesNotThrow(() => W.analyze({...base, kickoffs:{...futureKickoffs(), generated_at:at(72*H - 1000)}}));
  assert.throws(() => W.analyze({...base, kickoffs:{...futureKickoffs(), generated_at:at(72*H + 1000)}}), /kickoff coverage is stale \(over 72 hours old\); refresh required/);
});
check("96-hour weekly with a fresh remaining payload: weekly gains stay blocked", () => {
  const out = W.analyze({ ...base, weekly:{...freshWeekly(), generated_at:new Date(TEST_NOW - 96*H).toISOString()}, remaining: remainingFor(steadyFuture()) });
  assert.equal(out.rows.length, 0);
  assert.match(out.recommendationBlock, /^weekly projections are stale \(over 72 hours old\); fresh aligned weekly data required/);
  assert.equal(out.coverage.ros.fresh, false);
});
check("invalid ids and protected players", () => {
  assert.throws(() => W.analyze({...base,protectedIds:[null]}), /invalid player id/);
  const out = W.analyze({...base,protectedIds:["8"]});
  assert.ok(out.rows.every(r => r.drop.id !== "8"));
});
check("injured adds are not immediate weekly recommendations", () => {
  const hurtBoard = {...board,players:board.players.map(x => x.sleeper_id === "7" ? {...x,injury_status:"Out"} : x)};
  const out = W.analyze({...base,board:hurtBoard,weekly:freshWeekly(hurtBoard.players)});
  assert.ok(out.rows.every(r => r.add.id !== "7")); assert.match(out.warnings.join(" "), /stash value/);
});
check("an owned player missing from the board refuses by count (catalog-unknown ids are never hydrated)", () => {
  assert.throws(() => W.analyze({...base, rosters:[{...rosters[0], players:[...rosters[0].players, "404"]}, rosters[1]]}), /1 owned player\(s\) missing from board; refresh player data/);
});
check("real board ids, unmapped rows, weekly gaps, IR and byes stay honest", () => {
  const realBoard = {players: board.players.concat([{player_id:"gX",sleeper_id:null,name:"Unmapped",position:"RB",wk:999},p(12,"RB",16)]).map(x => x.sleeper_id === "7" ? {...x,bye:1} : x)};
  const fresh = freshWeekly(realBoard.players.filter(x => x.sleeper_id !== "12"));
  const out = W.analyze({...base,board:realBoard,weekly:fresh});
  assert.strictEqual(out.coverage.weeklyMatched, board.players.length);
  assert.ok(out.rows.every(r => r.add.name !== "Unmapped" && r.drop?.id !== "99"));
  assert.match(out.warnings.join(" "), /lack a Sleeper id/);
  assert.match(out.warnings.join(" "), /lack a current weekly projection/);
});
check("zero budgets and no improvements remain honest", () => {
  const zeroLeague = {...league,settings:{waiver_type:2,waiver_budget:0,waiver_bid_min:0}};
  let out = W.analyze({...base,league:zeroLeague,rosters:[{...rosters[0],settings:{waiver_budget_used:0}},rosters[1]]});
  assert.strictEqual(out.budget.spendable,0); assert.ok(out.rows.every(r => r.bid.high === 0 || (r.bid.high === null && (r.signal.strength === "weak" || r.dropCost.status === "unassessed"))));
  const weakBoard = {...board,players:board.players.map(x => x.sleeper_id === "7" ? {...x,wk:1} : x)};
  out = W.analyze({...base,board:weakBoard,weekly:freshWeekly(weakBoard.players)}); assert.strictEqual(out.rows.length,0); assert.match(out.warnings.join(" "), /no positive/);
});
check("exhausted budget: remaining and spendable clamp at zero", () => {
  const out = W.analyze({...base, rosters:[{...rosters[0], settings:{waiver_budget_used:100}}, rosters[1]]});
  assert.deepStrictEqual(out.budget, { total:100, used:100, remaining:0, reserve:20, spendable:0 });
  assert.ok(out.rows.every(r => r.bid.low === null || r.bid.high === 0));
  const over = W.analyze({...base, rosters:[{...rosters[0], settings:{waiver_budget_used:130}}, rosters[1]]});
  assert.equal(over.budget.remaining, 0); assert.equal(over.budget.spendable, 0);
});

check("exact scorer matches brute force on randomized lineup shapes, WRRB_FLEX and REC_FLEX included", () => {
  const eligible = {QB:["QB"],RB:["RB"],WR:["WR"],TE:["TE"],FLEX:["RB","WR","TE"],SUPER_FLEX:["QB","RB","WR","TE"],WRRB_FLEX:["RB","WR"],REC_FLEX:["WR","TE"]};
  function brute(players, slots) {
    let best = -Infinity;
    (function walk(si, used, sum) {
      if (si === slots.length) { best = Math.max(best, sum); return; }
      players.forEach((x,i) => { if (!used.has(i) && eligible[slots[si]].includes(x.position)) { used.add(i); walk(si+1,used,sum+x.wk); used.delete(i); } });
    })(0,new Set(),0);
    return best;
  }
  let seed = 1729;
  const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  let compared = 0;
  for (let iteration=0; iteration<40; iteration++) {
    const shape = ["QB","RB","WR","TE"].filter(() => rand()>.3).concat(rand()>.3?["FLEX"]:[],rand()>.55?["SUPER_FLEX"]:[],rand()>.5?["WRRB_FLEX"]:[],rand()>.5?["REC_FLEX"]:[]);
    if (!shape.length) shape.push("RB");
    const ps=[]; let k=1000+iteration*20;
    ["QB","RB","WR","TE"].forEach(pos => { for(let j=0;j<3;j++) ps.push(p(k++,pos,1+Math.floor(rand()*30))); });
    const owned=ps.slice(), add=p(k++,["QB","RB","WR","TE"][Math.floor(rand()*4)],20+Math.floor(rand()*20));
    const lg={season:2026,status:"in_season",total_rosters:2,roster_positions:shape.concat(["BN"]),settings:{waiver_type:2,waiver_budget:10,waiver_bid_min:0}};
    const rs=[{roster_id:1,players:owned.map(x=>x.sleeper_id),starters:shape.map(()=>"0"),reserve:[],taxi:[],settings:{waiver_budget_used:0}},{roster_id:2,players:[],starters:[],reserve:[],taxi:[],settings:{waiver_budget_used:0}}];
    const b={players:ps.concat(add)};
    let out;
    try { out=W.analyze({board:b,league:lg,rosters:rs,rosterId:1,weekly:freshWeekly(b.players),kickoffs:futureKickoffs(),now:TEST_NOW,snapshotAt:TEST_NOW,week:1,budgetReserve:0}); } catch(e) { if (/cannot fill/.test(e.message)) continue; throw e; }
    const baseline=brute(owned,shape), row=out.rows.filter(r=>r.add.id===add.sleeper_id).sort((a,b)=>b.lineupGain-a.lineupGain)[0];
    let expected=-Infinity;
    owned.forEach(drop=>{ expected=Math.max(expected,brute(owned.filter(x=>x!==drop).concat(add),shape)-baseline); });
    if (expected>=0.005) { assert.ok(row && close(row.lineupGain, expected), `iteration ${iteration}: ${row&&row.lineupGain} != ${expected}`); compared++; }
  }
  assert.ok(compared >= 10, `compared ${compared}`);
});

check("large board analysis stays bounded", () => {
  const many=board.players.concat(Array.from({length:600},(_,i)=>p(2000+i,["QB","RB","WR","TE"][i%4],5+(i%25))));
  const start=Date.now(); W.analyze({...base,board:{players:many},weekly:freshWeekly(many)});
  assert.ok(Date.now()-start<1000, `large-board analysis took ${Date.now()-start}ms`);
});

check("fresh-week unavailable owned players score zero", () => {
  const hurtBoard={players:board.players.map(x=>x.sleeper_id==="8"?{...x,injury_status:"Out"}:x)};
  const out=W.analyze({...base,board:hurtBoard,weekly:freshWeekly(hurtBoard.players)});
  const upgrade=rowOf(out,"7","8");
  assert.ok(upgrade && upgrade.lineupGain>=18, `unavailable owned player retained healthy points: ${upgrade&&upgrade.lineupGain}`);
});

check("weekly unknown contributor: blocked, protected from drops, gains withheld (caller policy)", () => {
  const fresh=freshWeekly(board.players.filter(x=>x.sleeper_id!=="8"));
  const blocked=W.analyze({...base,weekly:fresh});
  assert.equal(blocked.rows.length,0);
  assert.equal(blocked.recommendationBlock,"Owned players lack a current weekly projection: WR8. They are protected from drops; lineup gains withheld because their contribution is unknown.");
  assert.equal(blocked.coverage.activeOwnedSkills,5);
  assert.equal(blocked.coverage.projectedOwnedSkills,4);
  assert.deepEqual(blocked.coverage.missingOwnedWeekly,[{id:"8",name:"WR8"}]);
  const roomyLeague={...league,roster_positions:["QB","RB","WR","TE","K","DEF","BN"]};
  const roomyRosters=[{...rosters[0],starters:["1","2","3","4","5","6"]},rosters[1]];
  const out=W.analyze({...base,rosters:roomyRosters,league:roomyLeague,weekly:fresh});
  assert.equal(out.rows.length,0,"unknown bench value must not inflate an apparent upgrade");
  assert.match(out.recommendationBlock,/contribution is unknown/);
});

check("in-season stale or missing weekly data is research-only, never preseason bids", () => {
  for (const weekly of [null, {...freshWeekly(),generated_at:"2026-01-01"}, {...freshWeekly(),week:2}]) {
    const out=W.analyze({...base,weekly});
    assert.equal(out.rows.length,0);
    assert.match(out.recommendationBlock,/fresh aligned weekly data required/);
    assert.match(out.coverage.scoringLabel,/RESEARCH ONLY/);
    assert.equal(out.coverage.projectedOwnedSkills,null);
    assert.ok(!out.warnings.some(w=>w.includes("preseason proxy")));
    assert.equal(out.budget.remaining,60);
    assert.ok(out.roster.playerIds.length);
  }
});

const slotLeague={...league,roster_positions:["QB","RB","WR","TE","K","DEF","BN","IR","TAXI"]};
const slotRosters=[{roster_id:1,players:["1","2","3","4","5","6","99"],starters:["1","2","3","4","5","6"],reserve:["99"],taxi:[],settings:{waiver_budget_used:40}},rosters[1]];
check("open active roster slots allow adds without forced drops", () => {
  const out=W.analyze({...base,league:slotLeague,rosters:slotRosters,protectedIds:["1","2","3","4"]});
  assert.ok(out.rows.some(r=>r.add.id==="7"&&r.drop===null),"open active slot should not force a drop");
  assert.ok(out.rows.every(r=>r.drop===null||!["1","2","3","4"].includes(r.drop.id)));
});

check("full active rosters still require a legal drop", () => {
  const fullLeague={...league,roster_positions:["QB","RB","WR","TE","K","DEF","BN"]};
  const fullRosters=[
    {roster_id:1,players:["1","2","3","4","5","6","8"],starters:["1","2","3","4","5","6"],reserve:[],taxi:[],settings:{waiver_budget_used:40}},
    {roster_id:2,players:["9"],starters:["9"],reserve:[],taxi:["10"],settings:{waiver_budget_used:0}}
  ];
  const out=W.analyze({...base,league:fullLeague,rosters:fullRosters,protectedIds:["1","2","3","4","8"]});
  assert.ok(out.rows.every(r=>r.drop!==null),"full roster emitted an add-only claim");
});

check("minimum bid above spendable returns no illegal range", () => {
  const costly={...league,settings:{waiver_type:2,waiver_budget:100,waiver_bid_min:25}};
  const out=W.analyze({...base,league:costly,budgetReserve:50}); // remaining 60, spendable 10
  assert.ok(out.rows.length>0);
  assert.ok(out.rows.every(r=>r.bid.low===null&&r.bid.high===null&&r.bid.canAfford===false));
  assert.match(out.rows[0].bid.status,/minimum bid/);
});

check("affordable minimum exceeds heuristic band without illegal bids", () => {
  const costly={...slotLeague,settings:{waiver_type:2,waiver_budget:100,waiver_bid_min:25}};
  const out=W.analyze({...base,league:costly,rosters:slotRosters,weekly:weekOf(board.players,{g7:60}),budgetReserve:0});
  const priced=out.rows.filter(r=>r.signal.strength==="modeled");
  assert.ok(priced.length>0 && priced.every(r=>r.drop===null));
  assert.ok(priced.every(r=>r.bid.low>=25&&r.bid.high>=25&&r.bid.high<=60));
});

check("raw admission: a 0.004 weekly gain is out, 0.006 is in (spec §3.3)", () => {
  const at = v => W.analyze({...base, weekly:weekOf(board.players,{g7:7+v})});
  assert.equal(rowOf(at(0.004),"7","8"), undefined, "0.004 is under half a cent");
  const row = rowOf(at(0.006),"7","8");
  assert.ok(row && close(row.lineupGain, (7+0.006)-7), "0.006 is admitted with its raw gain");
  assert.equal(W.MIN_GAIN, 0.005);
  assert.equal(M.rowText(row, at(0.006)).gain, "+0.01 pts · weak signal", "rounded only for display");
});

check("ros_value is the 'why' value and the tie-break after the raw weekly gain", () => {
  // RB12 and RB13 both project 18 this week (same raw gain over WR8): the higher ros_value ranks first.
  const b2 = { players: board.players.concat([p(12,"RB",18,{ros_value:40}), p(13,"RB",18,{ros_value:90}), p(14,"RB",18)]) };
  const out = W.analyze({...base, board:b2, weekly:freshWeekly(b2.players)});
  const top = out.rows.filter(r => r.drop.id === "8" && ["7","12","13","14"].includes(r.add.id)).map(r => r.add.id);
  assert.deepEqual(top, ["13","12","7","14"].filter(x => top.includes(x)), `order ${top}`);
  assert.deepEqual(top.slice(0,2), ["13","12"]);
  const r13 = rowOf(out,"13","8");
  assert.equal(r13.valueEstimate.points, 90);
  assert.equal(r13.valueEstimate.label, "rest-of-season value 90.00 (sum of weekly medians through NFL week 17, not a season median); not a FAAB price");
  assert.equal(rowOf(out,"14","8").valueEstimate.points, null, "unknown is never 0");
  assert.match(rowOf(out,"14","8").valueEstimate.label, /^no rest-of-season value \(unknown, not zero/);
  assert.match(M.rowText(r13, out).why, /^drop cost unassessed · rest-of-season value 90\.00 \(sum of weekly medians through NFL week 17, not a season median\)/);
});

check("thresholds either side of 1, 2 and 5 points compare raw values (spec §3.3, §8.2)", () => {
  // Open-slot add, no remaining payload: the per-week number is this week's raw gain.
  const tierAt = g => {
    const out = W.analyze({...base, league:slotLeague, rosters:slotRosters, weekly:weekOf(board.players,{g7:10+g}), protectedIds:["1","2","3","4"]});
    const r = rowOf(out,"7",null);
    return [r.signal.strength, r.bid.tier];
  };
  assert.deepEqual(tierAt(0.999), ["weak","weak signal"], "0.999 is under 1 (rounded it would have read 1.00)");
  assert.deepEqual(tierAt(1.001), ["modeled","small"]);
  assert.deepEqual(tierAt(1.999), ["modeled","small"], "1.999 is under 2 (rounded it would have read 2.00)");
  assert.deepEqual(tierAt(2.001), ["modeled","useful"]);
  assert.deepEqual(tierAt(4.999), ["modeled","useful"], "4.999 is under 5");
  assert.deepEqual(tierAt(5.001), ["modeled","impact"]);
  assert.equal(W.COPY.heuristic(5), "5-point threshold in your league's points (a heuristic)");
});

check("weak signals stay visible but never become bids or priority spend", () => {
  // Fresh weekly: RB7 edges out WR8 in FLEX by 0.4 points this week.
  let out=W.analyze({...base,weekly:weekOf(board.players,{g7:7.4})});
  const weak=rowOf(out,"7","8");
  assert.ok(weak && close(weak.lineupGain,0.4,1e-12), "weak row must remain researchable");
  assert.equal(weak.signal.strength,"weak"); assert.ok(close(weak.signal.perWeekGain,0.4,1e-12)); assert.equal(weak.signal.thresholdPerWeek,1);
  assert.match(weak.signal.label,/weak signal.*below the conservative product threshold.*not a bid or priority claim/);
  assert.doesNotMatch(weak.signal.label,/noise/, "cutoff is unvalidated; must not claim the gain is noise");
  assert.deepEqual([weak.bid.low,weak.bid.high,weak.bid.tier,weak.bid.canAfford],[null,null,"weak signal",true]);
  assert.match(weak.bid.status,/no bid suggested/); assert.match(weak.bid.label,/not calibrated/);
  assert.match(weak.signal.guidance,/no bid suggested.*drop cost independently/);
  assert.match(weak.rosterCost,/WR8.*rest-of-season value.*not price/);
  assert.match(out.warnings.join(" "),/weak|research only/);
  const weakText=M.rowText(weak,out);
  assert.equal(weakText.gain,"+0.40 pts · weak signal");
  assert.match(weakText.bid,/^no bid suggested/); assert.doesNotMatch(weakText.bid,/\$/);
  assert.match(weakText.bidNote,/not calibrated/);
  assert.match(weakText.why,/^weak signal · no rest-of-season value/);
  assert.match(weakText.exportLine,/^ADD RB7; DROP WR8; \+0\.40 \(week 1 projection\); WEAK SIGNAL; no bid suggested.*; dropping WR8 costs their rest-of-season value/);
  assert.doesNotMatch(weakText.exportLine,/\$|null|heuristic bid/);
  // Above the cutoff the signal is modeled, but a required drop still withholds the range.
  out=W.analyze({...base,weekly:weekOf(board.players,{g7:8.5})});
  const modeled=rowOf(out,"7","8");
  assert.equal(modeled.signal.strength,"modeled"); assert.equal(modeled.bid.tier,"drop cost unassessed"); assert.equal(modeled.bid.low,null);
  assert.ok(!out.warnings.some(w=>/under 1\.0 projected pt\/week/.test(w)));
  const modeledText=M.rowText(modeled,out);
  assert.equal(modeledText.gain,"+1.50 pts · drop cost unassessed");
  assert.doesNotMatch(modeledText.bid,/\$/); assert.doesNotMatch(modeledText.exportLine,/\$|; modeled;/);
  // Rolling: research-only guidance, never priority spend.
  const rollingLeague={...league,settings:{waiver_type:0}};
  const rollingRosters=rosters.map(r=>({...r,settings:{waiver_position:r.roster_id}}));
  out=W.analyze({...base,league:rollingLeague,rosters:rollingRosters,weekly:weekOf(board.players,{g7:7.4})});
  const rweak=rowOf(out,"7","8");
  assert.equal(rweak.signal.strength,"weak"); assert.equal(rweak.bid,null);
  assert.match(rweak.signal.guidance,/^research only: no priority claim suggested; assess the drop cost independently/);
  const rText=M.rowText(rweak,out);
  assert.equal(rText.bid,"No priority claim suggested"); assert.equal(rText.bidNote,rweak.signal.guidance);
  assert.match(rText.exportLine,/; WEAK SIGNAL; research only: no priority claim suggested; assess the drop cost independently before any move; dropping WR8/);
  // Modeled rolling open-slot rows keep the league-level ordering guidance.
  const strongRolling=W.analyze({...base,league:{...slotLeague,settings:{waiver_type:0}},rosters:slotRosters.map(r=>({...r,settings:{waiver_position:r.roster_id}})),weekly:weekOf(board.players,{g7:60})});
  const strongRow=rowOf(strongRolling,"7",null);
  assert.equal(strongRow.signal.strength,"modeled");
  const strongText=M.rowText(strongRow,strongRolling);
  assert.equal(strongText.bid,"Set claim order in Sleeper"); assert.match(strongText.bidNote,/Order claims by value/);
  assert.match(strongText.exportLine,/; modeled; rank by value and roster need; uses an open roster spot/);
});

check("every required drop withholds spend guidance when the drop cost is not priced", () => {
  const richAddBoard={players:board.players.map(x=>x.sleeper_id==="7"?{...x,ros_value:60}:x)};
  const weekly=weekOf(richAddBoard.players,{g7:30,g8:7});
  let out=W.analyze({...base,board:richAddBoard,weekly});
  const held=rowOf(out,"7","8");
  assert.ok(held && held.lineupGain===23, "gated row must remain researchable with its modeled gain");
  assert.equal(held.signal.strength,"modeled"); assert.equal(held.valueEstimate.points,60);
  assert.deepEqual(Object.keys(held.dropCost).sort(),["label","reason","status"]);
  assert.equal(held.dropCost.status,"unassessed");
  assert.match(held.dropCost.label,/^drop cost unassessed: the rest-of-season change is not priced for this swap/);
  assert.deepEqual([held.bid.low,held.bid.high,held.bid.tier,held.bid.canAfford],[null,null,"drop cost unassessed",true]);
  assert.match(held.bid.status,/^no bid suggested: drop cost unassessed/);
  assert.match(out.warnings.join(" "),/require a drop whose rest-of-season cost is not priced.*no bid or priority spend/);
  const heldText=M.rowText(held,out);
  assert.equal(heldText.gain,"+23.00 pts · drop cost unassessed");
  assert.match(heldText.dropCostNote,/^drop cost unassessed/);
  assert.match(heldText.exportLine,/^ADD RB7; DROP WR8; \+23\.00 \(week 1 projection\); DROP COST UNASSESSED; no bid suggested: drop cost unassessed.*; dropping WR8 costs their rest-of-season value.*; drop cost unassessed: the rest-of-season change is not priced for this swap/);
  const drops=out.rows.filter(r=>r.drop!==null);
  assert.ok(drops.length>1 && drops.every(r=>r.dropCost.status==="unassessed" && r.bid.low===null && r.bid.high===null));
  // Affordability keeps precedence over the gate.
  const costly=rowOf(W.analyze({...base,league:{...league,settings:{waiver_type:2,waiver_budget:100,waiver_bid_min:25}},budgetReserve:50,board:richAddBoard,weekly}),"7","8");
  assert.equal(costly.dropCost.status,"unassessed"); assert.equal(costly.bid.canAfford,false); assert.match(costly.bid.status,/minimum bid/);
  // Open-slot adds sacrifice no one: a strong add keeps its heuristic range.
  const openOut=W.analyze({...base,league:slotLeague,rosters:slotRosters,board:richAddBoard,weekly:weekOf(richAddBoard.players,{g7:30}),protectedIds:["1","2","3","4"]});
  const open=rowOf(openOut,"7",null);
  assert.ok(open && open.lineupGain>=5);
  assert.deepEqual(open.dropCost,{status:"open_slot",label:"no drop required; future roster flexibility is not priced",addContributes:null,rosDelta:null,futureWeeks:null,endWeek:null});
  assert.equal(open.bid.tier,"impact"); assert.ok(open.bid.low>=1 && open.bid.high>=open.bid.low && open.bid.canAfford);
  const openText=M.rowText(open,openOut);
  assert.equal(openText.bid,`$${open.bid.low}–$${open.bid.high}`);
  assert.equal(openText.dropCostNote,null); assert.match(openText.exportLine,/DROP none; .*; modeled; heuristic bid \$/);
});

check("started starters lock their exact full-lineup slot and cancel without a projection", () => {
  const timedBoard={players:board.players.map(x=>({...x,current_team:x.sleeper_id==="8"?"A":"C"}))};
  const timedKickoffs={season:2026,week:1,generated_at:new Date(TEST_NOW).toISOString(),teams:["A","B","C","D"],games:[
    {home:"A",away:"B",kickoff:new Date(TEST_NOW-H).toISOString()},
    {home:"C",away:"D",kickoff:new Date(TEST_NOW+H).toISOString()}]};
  const weekly=freshWeekly(timedBoard.players);
  weekly.players=weekly.players.filter(x=>x.player_id!=="g8");
  const out=W.analyze({...base,board:timedBoard,weekly,kickoffs:timedKickoffs});
  assert.ok(out.rows.some(r=>r.add.id==="7" && r.lineupGain===8),"expected legal RB upgrade while FLEX remains locked");
  assert.ok(out.rows.filter(r=>r.add.id==="7").every(r=>r.lineupGain<=8),"an unlocked add incorrectly replaced the locked FLEX starter");
  assert.ok(out.rows.every(r=>r.drop?.id!=="8"),"started starter was droppable");
});

check("kickoff after roster snapshot requires refresh", () => {
  const started={...futureKickoffs(),games:[{home:"A",away:"B",kickoff:new Date(TEST_NOW-1000).toISOString()}]};
  assert.throws(()=>W.analyze({...base,kickoffs:started,snapshotAt:TEST_NOW-2000}),/started since.*refresh/);
});

check("started bench players and free agents cannot enter weekly transactions", () => {
  const timedBoard={players:board.players.map(x=>({...x,current_team:["7","11"].includes(x.sleeper_id)?"A":"C",position:x.sleeper_id==="11"?"RB":x.position}))};
  const timedKickoffs={season:2026,week:1,generated_at:new Date(TEST_NOW).toISOString(),teams:["A","B","C","D"],games:[
    {home:"A",away:"B",kickoff:new Date(TEST_NOW-1000).toISOString()},
    {home:"C",away:"D",kickoff:new Date(TEST_NOW+H).toISOString()}]};
  const out=W.analyze({...base,board:timedBoard,weekly:freshWeekly(timedBoard.players),kickoffs:timedKickoffs});
  assert.ok(out.rows.every(r=>r.add.id!=="7"),"started free agent was addable");
  assert.ok(out.rows.every(r=>r.drop?.id!=="11"),"started bench player was droppable");
});

check("Review Focus 1: an owned player traded after the batch -> today's throw, never scored for the old team", () => {
  const traded=freshWeekly(); traded.players.find(x=>x.player_id==="g2").team="B";
  assert.throws(()=>W.analyze({...base,weekly:traded}),/^TypeError: Waivers\.analyze: owned player projection team does not match current team; refresh projections$/);
  // A traded FREE AGENT is excluded, not thrown on.
  const tradedFa=freshWeekly(); tradedFa.players.find(x=>x.player_id==="g7").team="B";
  assert.ok(W.analyze({...base,weekly:tradedFa}).rows.every(r=>r.add.id!=="7"),"stale prior-team projection was used");
  const unknownOwn={players:board.players.map(x=>x.sleeper_id==="8"?{...x,current_team:null}:{...x,current_team:"A"})};
  assert.throws(()=>W.analyze({...base,board:unknownOwn,weekly:freshWeekly(unknownOwn.players)}),/unknown team\/schedule/);
});

check("invalid kickoff contracts fail closed for otherwise-fresh weekly scoring", () => {
  assert.throws(()=>W.analyze({...base,kickoffs:{...futureKickoffs(),week:2}}),/kickoff week.*refresh required/);
  assert.throws(()=>W.analyze({...base,kickoffs:{...futureKickoffs(),generated_at:"2026-01-01T00:00:00Z"}}),/kickoff coverage is stale.*refresh required/);
});

check("covered bye free agents cannot be immediate weekly upgrades", () => {
  const byeBoard={players:board.players.map(x=>x.sleeper_id==="7"?{...x,current_team:"BYE"}:x)};
  const out=W.analyze({...base,board:byeBoard,weekly:freshWeekly(byeBoard.players),kickoffs:{...futureKickoffs(),teams:["A","B","BYE"]}});
  assert.ok(out.rows.every(r=>r.add.id!=="7"));
});

check("malformed live starters cannot establish legal kickoff locks", () => {
  for (const starters of [
    ["1","2","3","4","3","5","6"],
    ["1","2","3","4","10","5","6"],
    ["1","2","3","4","99","5","6"],
  ]) {
    assert.throws(()=>W.analyze({...base,rosters:[{...rosters[0],starters},rosters[1]]}),/current starters/);
  }
});

// --- Review Focus 3: nothing assumes 10 or 12 teams --------------------------------------
check("2-, 4-, 20- and 32-team leagues with complete synthetic rosters", () => {
  for (const teams of [2, 4, 20, 32]) {
    const slots = ["QB","RB","WR","TE","FLEX","K","BN","BN"];
    const players = [], rs = [];
    let k = 10000 * teams;
    for (let t = 1; t <= teams; t++) {
      const mine = [["QB",15],["RB",10],["WR",10],["TE",6],["WR",8],["K",5],["RB",4],["WR",3]].map(([pos, v]) => {
        const x = pos === "K" ? { sleeper_id:String(k), name:`K${k}`, position:"K", team:"A", identity_only:true } : p(k, pos, v + (t % 3));
        k++; players.push(x); return x.sleeper_id;
      });
      rs.push({ roster_id:t, players:mine, starters:mine.slice(0,6), reserve:[], taxi:[], settings:{ waiver_budget_used:t } });
    }
    const fas = ["QB","RB","WR","TE"].map((pos, i) => p(k + i, pos, 30));
    const b2 = { players: players.concat(fas) };
    const lg = { ...league, total_rosters:teams, roster_positions:slots, settings:{ waiver_type:2, waiver_budget:1000, waiver_bid_min:0 } };
    for (const rosterId of [1, teams]) {
      const out = W.analyze({ ...base, board:b2, weekly:freshWeekly(b2.players), league:lg, rosters:rs, rosterId, budgetReserve:Math.round(0.2 * 1000) });
      assert.ok(out.rows.length > 0, `${teams} teams, roster ${rosterId}: rows`);
      assert.ok(out.rows.every(r => fas.some(f => f.sleeper_id === r.add.id)), `${teams} teams: only true free agents are adds`);
      assert.equal(out.coverage.ownedPlayers, teams * 8, `${teams} teams: every rostered player is owned`);
      assert.deepEqual(out.budget, { total:1000, used:rosterId, remaining:1000 - rosterId, reserve:200, spendable:800 - rosterId });
    }
    assert.throws(() => W.analyze({ ...base, board:b2, weekly:freshWeekly(b2.players), league:{ ...lg, total_rosters:teams + 1 }, rosters:rs }), /every league roster/);
  }
});

// --- rest-of-season drop cost --------------------------------------------------
// Week 1 is the analysed week; weeks 2 and 3 are the priced future. Fixture
// roster 1 starts QB1 RB2 WR3 TE4 and FLEX WR8; free agent RB7 is the add.
function rosRow(week, p50) {
  return p50 === "bye" ? { week, status:"bye", points:null }
    : p50 === null ? { week, status:"unmodeled", points:null, reason:"no_observed_history" }
    : { week, status:"conditional_projection", opponent:"B", points:{ league:{ p10:p50-3, p50, p90:p50+3 } } };
}
// The view's remaining shape (LeagueData.views: schema_version 1, no `league` contract).
function remainingFor(future, overrides={}, startWeek = 1) {
  const endWeek = overrides.end_week ?? startWeek + 2;
  return {
    schema_version:1, horizon:"remaining_season", status:"experimental", season:2026, start_week:startWeek, end_week:endWeek,
    generated_at:new Date(TEST_NOW).toISOString(), data_through:"2026-wk00", evaluation:null,
    players: Object.entries(future).map(([gsis, [w2, w3, team]]) => ({ player_id:gsis, team: team || "A", weeks:[rosRow(startWeek, 1), rosRow(startWeek+1, w2), rosRow(startWeek+2, w3)] })),
    ...overrides,
  };
}
// Everyone keeps their weekly number in weeks 2–3 unless overridden.
function steadyFuture() { return { g1:[20,20], g2:[10,10], g3:[11,11], g4:[8,8], g8:[5,5], g7:[12,12], g9:[25,25], g10:[13,13], g99:[30,30] }; }

check("priced swap: bench drop forfeits nothing, add's future contribution sets the band", () => {
  const out = W.analyze({ ...base, remaining: remainingFor(steadyFuture()) });
  const row = rowOf(out,"7","8");
  assert.equal(row.lineupGain, 11);
  assert.deepEqual(Object.keys(row.dropCost).sort(), ["addContributes","dropForfeits","endWeek","futureWeeks","label","rosDelta","status"]);
  assert.equal(row.dropCost.status, "priced");
  assert.equal(row.dropCost.addContributes, 14); assert.equal(row.dropCost.dropForfeits, 0); assert.equal(row.dropCost.rosDelta, 14);
  assert.deepEqual([row.dropCost.futureWeeks, row.dropCost.endWeek], [2, 3]);
  assert.equal(row.signal.moveValue, 25); assert.equal(row.signal.basis, "move");
  assert.ok(close(row.signal.perWeekGain, 25/3));
  assert.match(row.signal.label, /^modeled lineup gain this week plus rest-of-season lineup change; projection error is not quantified/);
  assert.equal(row.rosterCost, "dropping WR8 forfeits 0.00 projected lineup points over weeks 2–3; RB7 adds 14.00 in his place");
  assert.deepEqual([row.bid.tier, row.bid.low, row.bid.high, row.bid.status], ["impact", 11, 20, null]);
  assert.ok(out.coverage.ros.fresh); assert.equal(out.coverage.ros.reason, null);
  assert.deepEqual([out.coverage.ros.endWeek, out.coverage.ros.futureWeeks, out.coverage.ros.dataThrough], [3, 2, "2026-wk00"]);
  assert.equal(out.coverage.ros.pricedOwned, 5); assert.deepEqual(out.coverage.ros.unmodeledOwned, []);
  assert.ok(!("simulation" in out.coverage.ros), "no simulation summary (spec §6.2)");
  assert.ok(out.rows.every(r => !("pricing" in r) && !("simulation" in r.dropCost)));
});

check("week 16 and 17 horizons; week 18 end state", () => {
  const atWeek = (week, remaining, extra = {}) => W.analyze({ ...base, week, weekly:freshWeekly(board.players, week), kickoffs:futureKickoffs(week), remaining, ...extra });
  // Week 16: one future week (17).
  let out = atWeek(16, remainingFor(steadyFuture(), { end_week:17 }, 16));
  let row = rowOf(out,"7","8");
  assert.equal(row.dropCost.status, "priced"); assert.deepEqual([row.dropCost.futureWeeks, row.dropCost.endWeek], [1, 17]);
  assert.equal(row.rosterCost, "dropping WR8 forfeits 0.00 projected lineup points over weeks 17–17; RB7 adds 7.00 in his place");
  assert.ok(close(row.signal.perWeekGain, (11 + 7) / 2));
  // Week 17: no future weeks; the price is this week alone.
  out = atWeek(17, remainingFor(steadyFuture(), { end_week:17 }, 17));
  row = rowOf(out,"7","8");
  assert.equal(row.dropCost.rosDelta, 0); assert.match(row.rosterCost, /no future weeks remain/);
  assert.equal(row.signal.perWeekGain, row.lineupGain);
  assert.equal(row.valueEstimate.points, null);
  // Week 18: no remaining payload (status no_remaining_weeks), the reason is named.
  out = atWeek(18, null, { remainingReason:"no projected weeks remain" });
  row = rowOf(out,"7","8");
  assert.equal(out.coverage.ros.fresh, false); assert.equal(out.coverage.ros.reason, "no projected weeks remain");
  assert.equal(row.dropCost.status, "unassessed"); assert.equal(row.dropCost.reason, "no projected weeks remain");
  assert.ok(out.rows.length > 0 && out.coverage.weeklyFresh, "this week's gains still work in week 18");
});

check("net-negative swap reports both numbers and withholds spend", () => {
  const richBoard = { players: board.players.concat([p(12,"RB",12)]) };
  const out = W.analyze({ ...base, board:richBoard, weekly:freshWeekly(richBoard.players), remaining: remainingFor({ ...steadyFuture(), g12:[1,1] }) });
  const row = rowOf(out,"12","2");
  assert.equal(row.lineupGain, 2);
  assert.deepEqual([row.dropCost.status, row.dropCost.addContributes, row.dropCost.dropForfeits, row.dropCost.rosDelta], ["priced", 0, 18, -18]);
  assert.equal(row.signal.moveValue, -16);
  assert.deepEqual([row.bid.low, row.bid.high, row.bid.tier, row.bid.canAfford], [null, null, "drop costs more than the add returns", true]);
  assert.equal(row.bid.status, "no bid suggested: dropping RB2 forfeits 18.00 rest-of-season lineup points against 0.00 from RB12");
  assert.match(out.warnings.join(" "), /3 alternative\(s\) would forfeit more rest-of-season lineup value than the add returns/);
});

check("unmodeled add or drop is unassessed with the player named, never priced at zero", () => {
  const future = steadyFuture();
  let out = W.analyze({ ...base, remaining: remainingFor({ ...future, g7:[null,12] }) });
  let row = rowOf(out,"7","8");
  assert.deepEqual(Object.keys(row.dropCost).sort(), ["label","reason","status"]);
  assert.equal(row.dropCost.status, "unassessed"); assert.equal(row.dropCost.reason, "RB7 has no rest-of-season projection");
  assert.equal(row.signal.basis, "this_week"); assert.equal(row.signal.perWeekGain, 11);
  delete future.g8;
  out = W.analyze({ ...base, remaining: remainingFor(future) });
  assert.equal(rowOf(out,"7","8").dropCost.reason, "WR8 has no rest-of-season projection");
  const unfillable = rowOf(out,"7","2");
  assert.equal(unfillable.dropCost.status, "unassessed");
  assert.equal(unfillable.dropCost.reason, "roster cannot field a full lineup from modeled players in every future week");
  out = W.analyze({ ...base, remaining: remainingFor({ ...future, g7:[null,null] }) });
  assert.equal(rowOf(out,"7","8").dropCost.reason, "RB7 and WR8 have no rest-of-season projection");
  assert.deepEqual(out.coverage.ros.unmodeledOwned, [{ id:"8", name:"WR8" }]);
  assert.equal(out.coverage.ros.pricedOwned, 4);
  assert.match(out.warnings.join(" "), /1 roster player\(s\) have no rest-of-season projection and are excluded from future lineups: WR8/);
});

check("ROS unknown member: a warning, and his known weeks still count (caller policy)", () => {
  // Bench RB12 is unknown in week 2 and projects 30 in week 3.
  const b2 = { players: board.players.concat([p(12,"RB",4)]) };
  const rs = [{ ...rosters[0], players:[...rosters[0].players, "12"] }, rosters[1]];
  const out = W.analyze({ ...base, board:b2, weekly:freshWeekly(b2.players), rosters:rs, remaining: remainingFor({ ...steadyFuture(), g12:[null,30] }) });
  assert.deepEqual(out.coverage.ros.unmodeledOwned, [{ id:"12", name:"RB12" }]);
  assert.match(out.warnings.join(" "), /1 roster player\(s\) have no rest-of-season projection and are excluded from future lineups: RB12/);
  const row = rowOf(out,"7","8");
  // R: wk2 54; wk3 RB12 30 in RB, RB2 10 in FLEX -> 79. R+RB7: wk2 61; wk3 FLEX RB7 12 -> 81.
  // His week-3 30 counts: addContributes 9 (it would be 14 were he dropped from every week).
  assert.equal(row.dropCost.status, "priced");
  assert.equal(row.dropCost.addContributes, 9); assert.equal(row.dropCost.dropForfeits, 0);
  assert.equal(rowOf(out,"7","12").dropCost.status, "unassessed", "he is never a priced drop");
});

check("bye weeks count as zero, not unmodeled; a team mismatch is unmodeled", () => {
  let out = W.analyze({ ...base, remaining: remainingFor({ ...steadyFuture(), g7:["bye",12] }) });
  let row = rowOf(out,"7","8");
  assert.deepEqual([row.dropCost.status, row.dropCost.addContributes, row.dropCost.dropForfeits, row.dropCost.rosDelta], ["priced", 7, 5, 2]);
  out = W.analyze({ ...base, remaining: remainingFor({ ...steadyFuture(), g7:[12,12,"Z"] }) });
  row = rowOf(out,"7","8");
  assert.equal(row.dropCost.status, "unassessed"); assert.equal(row.dropCost.reason, "RB7 has no rest-of-season projection");
});

check("stale or misaligned remaining payload withholds drop pricing with the reason; open slots keep this week's basis", () => {
  const cases = [
    [undefined, "remaining-season projections unavailable"],
    [remainingFor(steadyFuture(), { season:2025 }), "remaining-season season does not match league season"],
    [remainingFor(steadyFuture(), { start_week:2 }), "remaining-season start week does not match requested week"],
    [remainingFor(steadyFuture(), { generated_at:new Date(TEST_NOW - 73*H).toISOString() }), "remaining-season projections are stale (over 72 hours old)"],
    [remainingFor(steadyFuture(), { generated_at:new Date(TEST_NOW + 2*H).toISOString() }), "remaining-season projections are stale (over 72 hours old)"],
    [remainingFor(steadyFuture(), { players:null }), "remaining-season payload is incomplete"],
    [remainingFor(steadyFuture(), { end_week:0 }), "remaining-season payload is incomplete"],
  ];
  for (const [remaining, reason] of cases) {
    const out = W.analyze({ ...base, remaining });
    const row = rowOf(out,"7","8");
    assert.equal(out.coverage.ros.fresh, false, reason); assert.equal(out.coverage.ros.reason, reason);
    assert.equal(row.dropCost.status, "unassessed", reason); assert.equal(row.dropCost.reason, reason);
    assert.match(out.warnings.join(" "), new RegExp(`${reason.replace(/[()]/g, "\\$&")}; drop costs unassessed, spend guidance limited to open-slot adds`));
  }
  // A remaining payload carrying another league's contract is used (no contract any more).
  assert.equal(W.analyze({ ...base, remaining:remainingFor(steadyFuture(), { league:{ league_id:"L2", sleeper_scoring:{ pass_td:6 } } }) }).coverage.ros.fresh, true);
  assert.equal(W.analyze({ ...base, remaining:remainingFor(steadyFuture(), { generated_at:new Date(TEST_NOW - 72*H + 1000).toISOString() }) }).coverage.ros.fresh, true);
  const out = W.analyze({ ...base, league:slotLeague, rosters:slotRosters, protectedIds:["1","2","3","4"] });
  const open = rowOf(out,"7",null);
  assert.deepEqual(Object.keys(open.dropCost).sort(), ["addContributes","endWeek","futureWeeks","label","rosDelta","status"]);
  assert.deepEqual([open.dropCost.status, open.dropCost.rosDelta, open.dropCost.addContributes], ["open_slot", null, null]);
  assert.equal(open.signal.basis, "this_week"); assert.equal(open.signal.perWeekGain, open.lineupGain);
  assert.match(open.rosterCost, /^uses an open roster spot; RB7's rest-of-season contribution is not priced/);
});

check("open-slot adds move to the total-value basis when priced; a one-week fill earns less than a season-long add", () => {
  const run = future => W.analyze({ ...base, league:slotLeague, rosters:slotRosters, protectedIds:["1","2","3","4"], remaining: remainingFor({ g1:[20,20], g2:[10,10], g3:[11,11], g4:[8,8], g7:future }) });
  const season = rowOf(run([12,12]),"7",null);
  const oneWeek = rowOf(run([0,0]),"7",null);
  assert.equal(season.lineupGain, 8); assert.deepEqual([season.dropCost.status, season.dropCost.addContributes, season.dropCost.rosDelta], ["open_slot", 4, 4]);
  assert.equal(season.signal.moveValue, 12); assert.ok(close(season.signal.perWeekGain, 4));
  assert.equal(oneWeek.lineupGain, 8); assert.equal(oneWeek.dropCost.rosDelta, 0);
  assert.ok(close(oneWeek.signal.perWeekGain, 8/3));
  assert.equal(season.rosterCost, "uses an open roster spot; RB7 adds 4.00 over weeks 2–3; roster flexibility is not priced");
  assert.deepEqual([season.bid.tier, oneWeek.bid.tier], ["useful", "useful"]);
});

check("guidance precedence: affordability, then net-negative, then weak, then unassessed, then bands", () => {
  const rich = { players: board.players.concat([p(12,"RB",12)]) };
  const weekly = freshWeekly(rich.players);
  const remaining = remainingFor({ ...steadyFuture(), g12:[1,1] });
  let out = W.analyze({ ...base, board:rich, weekly, remaining, league:{ ...league, settings:{ waiver_type:2, waiver_budget:100, waiver_bid_min:50 } } });
  let row = rowOf(out,"12","2");
  assert.deepEqual([row.bid.canAfford, row.bid.status], [false, "minimum bid exceeds spendable budget"]);
  out = W.analyze({ ...base, board:rich, weekly, remaining });
  row = rowOf(out,"12","2");
  assert.equal(row.signal.strength, "modeled"); assert.equal(row.bid.tier, "drop costs more than the add returns");
  out = W.analyze({ ...base, weekly:weekOf(board.players,{g7:7.4}) });
  row = rowOf(out,"7","8");
  assert.equal(row.signal.strength, "weak"); assert.equal(row.bid.tier, "weak signal"); assert.equal(row.dropCost.status, "unassessed");
  out = W.analyze({ ...base, weekly:weekOf(board.players,{g7:9}), remaining: remainingFor({ ...steadyFuture(), g7:[5,5] }) });
  row = rowOf(out,"7","8");
  assert.equal(row.lineupGain, 2); assert.equal(row.dropCost.rosDelta, 0); assert.ok(close(row.signal.perWeekGain, 2/3));
  assert.equal(row.signal.strength, "weak");
});

check("rosValue decomposition identity and brute-force equivalence on random rosters", () => {
  let seed = 7; const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let trial = 0; trial < 40; trial++) {
    const future = {}; for (const k of Object.keys(steadyFuture())) future[k] = [Math.round(rand()*20), Math.round(rand()*20)];
    const out = W.analyze({ ...base, remaining: remainingFor(future) });
    for (const r of out.rows.filter(r => r.dropCost.status === "priced")) {
      assert.ok(Math.abs(r.dropCost.rosDelta - (r.dropCost.addContributes - r.dropCost.dropForfeits)) < 1e-9);
      assert.ok(r.dropCost.dropForfeits >= -1e-9 && r.dropCost.addContributes >= -1e-9);
    }
    const row = rowOf(out,"7","8");
    if (!row) continue;
    const pts = (g, w) => future[g][w-2];
    const val = (ids, w) => {
      const by = { QB:[], RB:[], WR:[], TE:[] }; for (const i of ids) by[board.players.find(x => x.sleeper_id===i).position].push(pts(`g${i}`, w));
      for (const k in by) by[k].sort((a,b)=>b-a);
      const flex = [...by.RB.slice(1), ...by.WR.slice(1), ...by.TE.slice(1)].sort((a,b)=>b-a);
      return by.QB[0] + by.RB[0] + by.WR[0] + by.TE[0] + (flex[0] ?? -Infinity);
    };
    const R = ["1","2","3","4","8"], RA = R.concat("7"), RAD = RA.filter(i => i !== "8");
    const ros = ids => val(ids,2) + val(ids,3);
    assert.ok(Math.abs(row.dropCost.addContributes - (ros(RA) - ros(R))) < 1e-9);
    assert.ok(Math.abs(row.dropCost.dropForfeits - (ros(RA) - ros(RAD))) < 1e-9);
  }
});

check("priced path stays inside the existing performance bound", () => {
  const bigBoard = { players: Array.from({ length: 700 }, (_, i) => p(1000 + i, ["QB","RB","WR","TE"][i % 4], 5 + (i % 30))) };
  const big = { league_id:"L1", season:2026, status:"in_season", total_rosters:2, scoring_settings:{pass_td:4,rec:1}, roster_positions:["QB","RB","RB","WR","WR","TE","FLEX","FLEX","K","DEF","BN","BN","BN","BN","BN","IR"], settings:{ waiver_type:2, waiver_budget:100, waiver_bid_min:1 } };
  const mine = bigBoard.players.slice(0, 15).map(x => x.sleeper_id);
  const bigRosters = [{ roster_id:1, players:mine, starters:mine.slice(0, 8).concat(["0","0"]), reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }, { roster_id:2, players:[], starters:[], reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }];
  const remaining = remainingFor({}, { end_week: 17, players: bigBoard.players.map(x => ({ player_id:x.player_id, team:"A", weeks: Array.from({ length: 17 }, (_, i) => rosRow(i + 1, x.wk)) })) });
  const t0 = Date.now();
  const out = W.analyze({ ...base, board:bigBoard, league:big, rosters:bigRosters, weekly:freshWeekly(bigBoard.players), remaining, protectedIds:[] });
  assert.ok(out.rows.length > 0 && out.rows.some(r => r.dropCost.status === "priced"));
  assert.ok(Date.now() - t0 < 4000, `priced analysis took ${Date.now() - t0} ms`);
});

// --- through the real league views and the controller's hydration (spec §3.4, Review Focus 1) ----
check("through LeagueData.views + WaiverMode.hydrateBoard: traded owned player throws; position-changed owned player is identity-only and blocks", () => {
  const HDR = { season:2026, week:1, data_through:"2026-wk00", generated_at:new Date(TEST_NOW).toISOString(), batch_id:"b" };
  const sq = yds => { const o = f => Object.fromEntries(LL.STATS.map(s => [s, s === "receiving_yards" ? yds * f : 0])); return { p10:o(0.5), p50:o(1), p90:o(1.5) }; };
  const people = [["v1","00-0000101","QB",200],["v2","00-0000102","WR",150],["v3","00-0000103","WR",120],["v4","00-0000104","RB",90],["v5","00-0000105","TE",60],["v6","00-0000106","WR",170]];
  const batch = { formats:[], remaining:null, evaluation:null,
    weekly:{ ...HDR, kind:"neutral_weekly", schema_version:1, players:people.map(([sid,pid,pos,y]) => ({ player_id:pid, name:`N${sid}`, team:"A", opponent:"B", position:pos, is_home:true, stat_quantiles:sq(y), points:{ ppr:null, half_ppr:null, standard:null } })) },
    players:{ ...HDR, kind:"neutral_players", schema_version:1, players:people.map(([sid,pid,pos]) => ({ player_id:pid, sleeper_id:sid, name:`N${sid}`, team:"A", position:pos, bye:null, ecr:null, identity_only:false, reason:null })) } };
  const cat = { ...Object.fromEntries(people.map(([sid,pid,pos]) => [sid, { full_name:`N${sid}`, position:pos, team:"A", gsis_id:pid }])), k1:{ full_name:"Kicker", position:"K", team:"A" } };
  const lg = { league_id:"V", season:"2026", status:"in_season", total_rosters:2, settings:{ type:0, waiver_type:2, waiver_budget:100 }, scoring_settings:{ rec_yd:0.1 }, roster_positions:["QB","WR","FLEX","K","BN","BN"] };
  const rs = [{ roster_id:1, players:["v1","v2","v3","v4","v5","k1"], starters:["v1","v2","v3","k1"], reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }, { roster_id:2, players:[], starters:[], reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }];
  const run = c => { const v = LD.views(batch, lg, { week:1, catalog:c }); const b = M.hydrateBoard(v.board, c, rs, v);
    return W.analyze({ board:b, weekly:v.weekly, league:lg, rosters:rs, rosterId:1, kickoffs:futureKickoffs(), now:TEST_NOW, snapshotAt:TEST_NOW, week:1, budgetReserve:20 }); };
  const ok = run(cat);
  const top = rowOf(ok, "v6", "v5") || ok.rows[0];
  assert.ok(ok.rows.length > 0 && top, "the K occupant is hydrated as identity: no 'missing from board' refusal");
  assert.ok(close(rowOf(ok, "v6", "v4").lineupGain, 17 - 12), "WR v6 (17) takes FLEX from WR v3 (12)");
  // Traded after the batch: the view keeps the projection team; today's throw.
  assert.throws(() => run({ ...cat, v2:{ ...cat.v2, team:"B" } }), /owned player projection team does not match current team; refresh projections/);
  // Position changed live (WR -> RB): excluded from the view, hydrated as identity-only, so his
  // weekly contribution is unknown -> blocked, naming him.
  const moved = { ...cat, v3:{ ...cat.v3, position:"RB" } };
  const v = LD.views(batch, lg, { week:1, catalog:moved });
  assert.equal(v.excluded[0].reason, "position_changed");
  const hydrated = M.hydrateBoard(v.board, moved, rs, v).players.find(x => x.sleeper_id === "v3");
  assert.deepEqual([hydrated.position, hydrated.identity_only, hydrated.reason], ["RB", true, "position_changed"]);
  const blocked = run(moved);
  assert.equal(blocked.rows.length, 0);
  assert.match(blocked.recommendationBlock, /^Owned players lack a current weekly projection: Nv3\./);
});

if (failed.length) { console.log(`FAILED (${failed.length}):\n  ` + failed.join("\n  ")); process.exit(1); }
console.log(`waivers_fixture: ${n} groups OK`);
