// tests/waivers_fixture.cjs — run with: node tests/waivers_fixture.cjs
const assert = require("assert");
delete global.window;
const W = require("../site/assets/waivers.js");
assert.strictEqual(global.window, undefined, "CommonJS load must not require/mutate window");

const p = (id, pos, pts, extra = {}) => ({ sleeper_id: String(id), player_id: `g${id}`, name: `${pos}${id}`, position: pos, value_points: pts, ...extra });
const board = { players: [p(1,"QB",20),p(2,"RB",10),p(3,"WR",11),p(4,"TE",8),p(5,"K",7),p(6,"DEF",6),p(7,"RB",18),p(8,"WR",7),p(9,"QB",25),p(10,"TE",13),p(99,"RB",30)] };
const league = { league_id:"L1", season: 2026, total_rosters: 2, scoring_settings:{pass_td:4,rec:1}, roster_positions: ["QB","RB","WR","TE","FLEX","K","DEF","BN","IR","TAXI"], settings: { waiver_budget: 100, waiver_bid_min: 1 } };
const weeklyLeague={league_id:"L1",slug:"fixture",sleeper_scoring:{pass_td:4,rec:1}};
const rosters = [
  { roster_id: 1, players: ["1","2","3","4","5","6","8","404"], reserve: ["99"], taxi: [], settings: { waiver_budget_used: 40 } },
  { roster_id: 2, players: ["9"], reserve: [], taxi: ["10"], settings: { waiver_budget_used: 0 } }
];
const base = { board, league, rosters, rosterId: 1, weekly: null, week: 1, protectedIds: [], budgetReserve: 20, transactions: [] };
let n = 0;
function check(name, fn) { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }

check("ownership excludes all active reserve and taxi players", () => {
  const out = W.analyze(base);
  assert.ok(out.rows.every(r => !["1","2","3","4","5","6","8","9","10","99"].includes(r.add.id)));
  assert.ok(out.roster.lockedReserveTaxiIds.includes("99"));
});
check("budget is explicit and reserve caps guidance", () => {
  const out = W.analyze(base);
  assert.deepStrictEqual(out.budget, { total:100, used:40, remaining:60, reserve:20, spendable:40 });
  assert.ok(out.rows.every(r => r.bid.high <= 40 && /not calibrated/.test(r.bid.label)));
  assert.match(out.rows[0].valueEstimate.label, /not a FAAB price/);
});
check("missing budget never defaults to 100", () => {
  assert.throws(() => W.analyze({ ...base, league: { ...league, settings: {} } }), /waiver_budget/);
  assert.throws(() => W.analyze({ ...base, league: { ...league, settings: {waiver_budget:null} } }), /waiver_budget/);
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
check("complete league and unique ownership are mandatory", () => {
  assert.throws(() => W.analyze({ ...base, rosters: [rosters[0]] }), /every league roster/);
  const dup = [rosters[0], {...rosters[1], players:["2"]}];
  assert.throws(() => W.analyze({ ...base, rosters: dup }), /duplicate ownership/);
  assert.throws(() => W.analyze({ ...base, rosters: [{...rosters[0],players:null},rosters[1]] }), /players must be an array/);
  assert.throws(() => W.analyze({ ...base, rosters: [rosters[0],{...rosters[1],roster_id:1}] }), /roster_id.*unique/);
});
check("unsupported lineup shapes fail visibly", () => {
  assert.throws(() => W.analyze({ ...base, league: {...league, roster_positions:["QB","REC_FLEX"]} }), /unsupported/);
});
check("flex scoring finds marginal starter improvement and preserves lone QB TE K DEF", () => {
  const out = W.analyze(base);
  assert.ok(out.rows.some(r => r.add.id === "7" && r.drop.id === "8" && r.lineupGain > 0));
  assert.ok(out.rows.every(r => !["1","4","5","6"].includes(r.drop.id)));
});
check("fresh weekly joins GSIS and stale weekly labels proxy", () => {
  const fresh = { season:2026, week:1, generated_at:new Date().toISOString(), league:weeklyLeague, players: board.players.map(x => ({player_id:x.player_id,points:{league:{p50:x.sleeper_id === "7" ? 40 : x.value_points}}})) };
  let out = W.analyze({...base, weekly:fresh});
  assert.strictEqual(out.coverage.weeklyFresh, true); assert.strictEqual(out.rows[0].scoring.source, "weekly");
  out = W.analyze({...base, weekly:{...fresh,generated_at:"2026-01-01T00:00:00Z"}});
  assert.strictEqual(out.coverage.weeklyFresh, false); assert.match(out.warnings.join(" "), /stale.*preseason proxy/);
});
check("invalid ids and protected players", () => {
  assert.throws(() => W.analyze({...base,protectedIds:[null]}), /invalid player id/);
  const out = W.analyze({...base,protectedIds:["8"]});
  assert.ok(out.rows.every(r => r.drop.id !== "8"));
});
check("injured adds are not immediate weekly recommendations", () => {
  const hurtBoard = {...board,players:board.players.map(x => x.sleeper_id === "7" ? {...x,injury_status:"Out"} : x)};
  const fresh = { season:2026, week:1, generated_at:new Date().toISOString(), league:weeklyLeague, players: hurtBoard.players.map(x => ({player_id:x.player_id,points:{league:{p50:x.value_points}}})) };
  const out = W.analyze({...base,board:hurtBoard,weekly:fresh});
  assert.ok(out.rows.every(r => r.add.id !== "7")); assert.match(out.warnings.join(" "), /stash value/);
});
check("unknown owned players are retained loudly", () => {
  const out = W.analyze(base);
  assert.deepStrictEqual(out.roster.unknownOwnedIds,["404"]); assert.match(out.warnings.join(" "), /missing from board/);
});
check("real board ids, unmapped rows, weekly gaps, IR and byes stay honest", () => {
  const realBoard = {players: board.players.concat([{player_id:"gX",sleeper_id:null,name:"Unmapped",position:"RB",value_points:999},p(12,"RB",16)]).map(x => x.sleeper_id === "7" ? {...x,bye:1} : x)};
  const fresh = {season:2026,week:1,generated_at:new Date().toISOString(),league:weeklyLeague,players:realBoard.players.filter(x => x.sleeper_id !== "12").map(x => ({player_id:x.player_id,points:{league:{p50:x.value_points}}}))};
  const out = W.analyze({...base,board:realBoard,weekly:fresh});
  assert.strictEqual(out.coverage.weeklyMatched, board.players.length);
  assert.ok(out.rows.every(r => r.add.name !== "Unmapped" && r.drop.id !== "99"));
  assert.match(out.warnings.join(" "), /lack a Sleeper id/);
  assert.match(out.warnings.join(" "), /lack a current weekly projection/);
});
check("zero budgets and no improvements remain honest", () => {
  const zeroLeague = {...league,settings:{waiver_budget:0,waiver_bid_min:0}};
  let out = W.analyze({...base,league:zeroLeague,rosters:[{...rosters[0],settings:{waiver_budget_used:0}},rosters[1]]});
  assert.strictEqual(out.budget.spendable,0); assert.ok(out.rows.every(r => r.bid.high === 0));
  const weakBoard = {...board,players:board.players.map(x => x.sleeper_id === "7" ? {...x,value_points:1} : x)};
  out = W.analyze({...base,board:weakBoard}); assert.strictEqual(out.rows.length,0); assert.match(out.warnings.join(" "), /no positive/);
});

check("laminar scorer matches brute force on randomized lineup shapes", () => {
  // Observe the engine's chosen total through a single upgrade gain, and
  // compare it with an independent exhaustive assignment oracle.
  function brute(players, slots) {
    const eligible = {QB:["QB"],RB:["RB"],WR:["WR"],TE:["TE"],FLEX:["RB","WR","TE"],SUPER_FLEX:["QB","RB","WR","TE"]};
    let best = -Infinity;
    (function walk(si, used, sum) {
      if (si === slots.length) { best = Math.max(best, sum); return; }
      players.forEach((x,i) => { if (!used.has(i) && eligible[slots[si]].includes(x.position)) { used.add(i); walk(si+1,used,sum+x.value_points); used.delete(i); } });
    })(0,new Set(),0);
    return best;
  }
  let seed = 1729;
  const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let iteration=0; iteration<40; iteration++) {
    const shape = ["QB","RB","WR","TE"].filter(() => rand()>.3).concat(rand()>.3?["FLEX"]:[],rand()>.55?["SUPER_FLEX"]:[]);
    if (!shape.length) shape.push("RB");
    const ps=[]; let k=1000+iteration*20;
    ["QB","RB","WR","TE"].forEach(pos => { for(let j=0;j<3;j++) ps.push(p(k++,pos,1+Math.floor(rand()*30))); });
    const owned=ps.slice(), add=p(k++,["QB","RB","WR","TE"][Math.floor(rand()*4)],20+Math.floor(rand()*20));
    const lg={season:2026,total_rosters:2,roster_positions:shape.concat(["BN"]),settings:{waiver_budget:10,waiver_bid_min:0}};
    const rs=[{roster_id:1,players:owned.map(x=>x.sleeper_id),reserve:[],taxi:[],settings:{waiver_budget_used:0}},{roster_id:2,players:[],reserve:[],taxi:[],settings:{waiver_budget_used:0}}];
    const b={players:ps.concat(add)};
    let out;
    try { out=W.analyze({board:b,league:lg,rosters:rs,rosterId:1,weekly:null,week:1,budgetReserve:0}); } catch(e) { if (/cannot fill/.test(e.message)) continue; throw e; }
    const baseline=brute(owned,shape), row=out.rows.find(r=>r.add.id===add.sleeper_id);
    let expected=-Infinity;
    owned.forEach(drop=>{ expected=Math.max(expected,brute(owned.filter(x=>x!==drop).concat(add),shape)-baseline); });
    if (expected>0) assert.ok(row && Math.abs(row.lineupGain-expected)<0.02, `iteration ${iteration}: ${row&&row.lineupGain} != ${expected}`);
  }
});

check("large board analysis stays bounded", () => {
  const many=board.players.concat(Array.from({length:600},(_,i)=>p(2000+i,["QB","RB","WR","TE"][i%4],5+(i%25))));
  const start=Date.now(); W.analyze({...base,board:{players:many}});
  assert.ok(Date.now()-start<500, `large-board analysis took ${Date.now()-start}ms`);
});

check("fresh-week unavailable owned players score zero", () => {
  const hurtBoard={players:board.players.map(x=>x.sleeper_id==="8"?{...x,injury_status:"Out"}:x)};
  const fresh={season:2026,week:1,generated_at:new Date().toISOString(),league:weeklyLeague,players:hurtBoard.players.map(x=>({player_id:x.player_id,points:{league:{p50:x.value_points}}}))};
  const out=W.analyze({...base,board:hurtBoard,weekly:fresh});
  const upgrade=out.rows.find(r=>r.add.id==="7"&&r.drop.id==="8");
  assert.ok(upgrade && upgrade.lineupGain>=18, `unavailable owned player retained healthy points: ${upgrade&&upgrade.lineupGain}`);
});

check("missing weekly scores protect owned players from drops", () => {
  const fresh={season:2026,week:1,generated_at:new Date().toISOString(),league:weeklyLeague,players:board.players.filter(x=>x.sleeper_id!=="8").map(x=>({player_id:x.player_id,points:{league:{p50:x.value_points}}}))};
  // The other known skill players can fill the lineup only after adding, but
  // the unprojected owned player must never appear as a zero-cost drop.
  assert.throws(()=>W.analyze({...base,weekly:fresh}),/cannot fill every required/);
  const roomyLeague={...league,roster_positions:["QB","RB","WR","TE","K","DEF","BN"]};
  const out=W.analyze({...base,league:roomyLeague,weekly:fresh});
  assert.ok(out.rows.every(r=>r.drop.id!=="8"));
  assert.match(out.warnings.join(" "),/protected from drops/);
});

check("minimum bid above spendable returns no illegal range", () => {
  const costly={...league,settings:{waiver_budget:100,waiver_bid_min:25}};
  const out=W.analyze({...base,league:costly,budgetReserve:50}); // remaining 60, spendable 10
  assert.ok(out.rows.length>0);
  assert.ok(out.rows.every(r=>r.bid.low===null&&r.bid.high===null&&r.bid.canAfford===false));
  assert.match(out.rows[0].bid.status,/minimum bid/);
});

check("weekly league and scoring contracts prevent cross-league reuse", () => {
  const players=board.players.map(x=>({player_id:x.player_id,points:{league:{p50:x.value_points}}}));
  const common={season:2026,week:1,generated_at:new Date().toISOString(),players};
  let out=W.analyze({...base,weekly:{...common,league:{...weeklyLeague,league_id:"OTHER"}}});
  assert.strictEqual(out.coverage.weeklyFresh,false); assert.match(out.warnings.join(" "),/league id.*preseason proxy/);
  out=W.analyze({...base,weekly:{...common,league:{...weeklyLeague,sleeper_scoring:{pass_td:6,rec:1}}}});
  assert.strictEqual(out.coverage.weeklyFresh,false); assert.match(out.warnings.join(" "),/scoring contract.*preseason proxy/);
  out=W.analyze({...base,weekly:{...common,league:{...weeklyLeague,sleeper_scoring:{pass_td:4}}}});
  assert.strictEqual(out.coverage.weeklyFresh,false); assert.match(out.warnings.join(" "),/incomplete/);
});

check("zero-only scoring extras preserve the weekly contract", () => {
  const weekly = { season:2026, week:1, generated_at:new Date().toISOString(), league:weeklyLeague,
    players:board.players.map(x=>({player_id:x.player_id,points:{league:{p50:x.value_points}}})) };
  const live = {...league, scoring_settings:{...league.scoring_settings, extra_zero:0}};
  assert.equal(W.analyze({...base,league:live,weekly}).coverage.weeklyFresh,true);
  live.scoring_settings.extra_zero=1;
  assert.equal(W.analyze({...base,league:live,weekly}).coverage.weeklyFresh,false);
  live.scoring_settings.extra_zero=null;
  assert.equal(W.analyze({...base,league:live,weekly}).coverage.weeklyFresh,false);
});

check("affordable minimum exceeds heuristic band without illegal bids", () => {
  const costly={...league,settings:{waiver_budget:100,waiver_bid_min:25}};
  const out=W.analyze({...base,league:costly,budgetReserve:0});
  assert.ok(out.rows.length>0);
  assert.ok(out.rows.every(r=>r.bid.low>=25&&r.bid.high>=25&&r.bid.high<=60));
});

console.log(`waivers_fixture: ${n} groups OK`);
