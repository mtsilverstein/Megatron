// tests/waivers_fixture.cjs — run with: node tests/waivers_fixture.cjs
const assert = require("assert");
delete global.window;
const W = require("../site/assets/waivers.js");
assert.strictEqual(global.window, undefined, "CommonJS load must not require/mutate window");

const TEST_NOW = Date.parse("2026-09-10T12:00:00Z");
const p = (id, pos, pts, extra = {}) => ({ sleeper_id: String(id), player_id: `g${id}`, name: `${pos}${id}`, position: pos, team:"A", value_points: pts, ...extra });
const board = { players: [p(1,"QB",20),p(2,"RB",10),p(3,"WR",11),p(4,"TE",8),p(5,"K",7),p(6,"DEF",6),p(7,"RB",18),p(8,"WR",7),p(9,"QB",25),p(10,"TE",13),p(11,"K",1),p(99,"RB",30)] };
const league = { league_id:"L1", season: 2026, total_rosters: 2, scoring_settings:{pass_td:4,rec:1}, roster_positions: ["QB","RB","WR","TE","FLEX","K","DEF","BN","IR","TAXI"], settings: { waiver_budget: 100, waiver_bid_min: 1 } };
const weeklyLeague={league_id:"L1",slug:"fixture",sleeper_scoring:{pass_td:4,rec:1}};
const futureKickoffs = {season:2026,week:1,generated_at:new Date(TEST_NOW).toISOString(),teams:["A","B"],games:[{home:"A",away:"B",kickoff:new Date(TEST_NOW+3600000).toISOString()}]};
const freshWeekly = (players=board.players) => ({season:2026,week:1,generated_at:new Date(TEST_NOW).toISOString(),league:weeklyLeague,players:players.map(x=>({player_id:x.player_id,team:Object.hasOwn(x,"current_team")?x.current_team:x.team,points:{league:{p50:x.value_points}}}))});
const rosters = [
  { roster_id: 1, players: ["1","2","3","4","5","6","8","404"], starters:["1","2","3","4","8","5","6"], reserve: ["99"], taxi: [], settings: { waiver_budget_used: 40 } },
  { roster_id: 2, players: ["9"], reserve: [], taxi: ["10"], settings: { waiver_budget_used: 0 } }
];
const freshRosters = [{...rosters[0],players:rosters[0].players.map(x=>x==="404"?"11":x)},rosters[1]];
const base = { board, league, rosters, rosterId: 1, weekly: null, kickoffs:futureKickoffs, snapshotAt:TEST_NOW, now:TEST_NOW, week: 1, protectedIds: [], budgetReserve: 20, transactions: [] };
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
  const fresh = freshWeekly().valueOf(); fresh.players.find(x=>x.player_id==="g7").points.league.p50=40;
  let out = W.analyze({...base, rosters:freshRosters, weekly:fresh});
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
  const fresh = freshWeekly(hurtBoard.players);
  const out = W.analyze({...base,rosters:freshRosters,board:hurtBoard,weekly:fresh});
  assert.ok(out.rows.every(r => r.add.id !== "7")); assert.match(out.warnings.join(" "), /stash value/);
});
check("unknown owned players are retained loudly", () => {
  const out = W.analyze(base);
  assert.deepStrictEqual(out.roster.unknownOwnedIds,["404"]); assert.match(out.warnings.join(" "), /missing from board/);
});
check("real board ids, unmapped rows, weekly gaps, IR and byes stay honest", () => {
  const realBoard = {players: board.players.concat([{player_id:"gX",sleeper_id:null,name:"Unmapped",position:"RB",value_points:999},p(12,"RB",16)]).map(x => x.sleeper_id === "7" ? {...x,bye:1} : x)};
  const fresh = freshWeekly(realBoard.players.filter(x => x.sleeper_id !== "12"));
  const out = W.analyze({...base,rosters:freshRosters,board:realBoard,weekly:fresh});
  assert.strictEqual(out.coverage.weeklyMatched, board.players.length);
  assert.ok(out.rows.every(r => r.add.name !== "Unmapped" && r.drop?.id !== "99"));
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
  const fresh=freshWeekly(hurtBoard.players);
  const out=W.analyze({...base,rosters:freshRosters,board:hurtBoard,weekly:fresh});
  const upgrade=out.rows.find(r=>r.add.id==="7"&&r.drop.id==="8");
  assert.ok(upgrade && upgrade.lineupGain>=18, `unavailable owned player retained healthy points: ${upgrade&&upgrade.lineupGain}`);
});

check("missing weekly scores protect owned players from drops", () => {
  const fresh=freshWeekly(board.players.filter(x=>x.sleeper_id!=="8"));
  // The other known skill players can fill the lineup only after adding, but
  // the unprojected owned player must never appear as a zero-cost drop.
  const blocked=W.analyze({...base,rosters:freshRosters,weekly:fresh});
  assert.equal(blocked.rows.length,0);
  assert.match(blocked.recommendationBlock,/contribution is unknown/);
  assert.equal(blocked.coverage.activeOwnedSkills,5);
  assert.equal(blocked.coverage.projectedOwnedSkills,4);
  assert.deepEqual(blocked.coverage.missingOwnedWeekly,[{id:"8",name:"WR8"}]);
  const roomyLeague={...league,roster_positions:["QB","RB","WR","TE","K","DEF","BN"]};
  const roomyRosters=[{...freshRosters[0],starters:["1","2","3","4","5","6"]},freshRosters[1]];
  const out=W.analyze({...base,rosters:roomyRosters,league:roomyLeague,weekly:fresh});
  assert.ok(out.rows.every(r=>r.drop.id!=="8"));
  assert.equal(out.rows.length,0,"unknown bench value must not inflate an apparent upgrade");
  assert.match(out.warnings.join(" "),/protected from drops/);
});

check("in-season stale or missing weekly data is research-only, never preseason bids", () => {
  for (const weekly of [null, {...freshWeekly(),generated_at:"2026-01-01"}, {...freshWeekly(),week:2}]) {
    const out=W.analyze({...base,league:{...league,status:"in_season"},weekly});
    assert.equal(out.rows.length,0);
    assert.match(out.recommendationBlock,/fresh aligned weekly data required/);
    assert.match(out.coverage.scoringLabel,/RESEARCH ONLY/);
    assert.equal(out.coverage.projectedOwnedSkills,null);
    assert.ok(!out.warnings.some(w=>w.includes("using preseason proxy")));
    assert.equal(out.budget.remaining,60);
    assert.ok(out.roster.playerIds.length);
  }
});

check("open active roster slots allow adds without forced drops", () => {
  const slotLeague={...league,roster_positions:["QB","RB","WR","TE","K","DEF","BN","IR","TAXI"]};
  const slotRosters=[
    {roster_id:1,players:["1","2","3","4","5","6","99"],reserve:["99"],taxi:[],settings:{waiver_budget_used:40}},
    {roster_id:2,players:["9"],reserve:[],taxi:["10"],settings:{waiver_budget_used:0}}
  ];
  const out=W.analyze({...base,league:slotLeague,rosters:slotRosters,protectedIds:["1","2","3","4"]});
  assert.ok(out.rows.some(r=>r.add.id==="7"&&r.drop===null),"open active slot should not force a drop");
  assert.ok(out.rows.every(r=>r.drop===null||!["1","2","3","4"].includes(r.drop.id)));
});

check("full active rosters still require a legal drop", () => {
  const fullLeague={...league,roster_positions:["QB","RB","WR","TE","K","DEF","BN"]};
  const fullRosters=[
    {roster_id:1,players:["1","2","3","4","5","6","8"],reserve:[],taxi:[],settings:{waiver_budget_used:40}},
    {roster_id:2,players:["9"],reserve:[],taxi:["10"],settings:{waiver_budget_used:0}}
  ];
  const out=W.analyze({...base,league:fullLeague,rosters:fullRosters,protectedIds:["1","2","3","4","8"]});
  assert.ok(out.rows.every(r=>r.drop!==null),"full roster emitted an add-only claim");
});

check("minimum bid above spendable returns no illegal range", () => {
  const costly={...league,settings:{waiver_budget:100,waiver_bid_min:25}};
  const out=W.analyze({...base,league:costly,budgetReserve:50}); // remaining 60, spendable 10
  assert.ok(out.rows.length>0);
  assert.ok(out.rows.every(r=>r.bid.low===null&&r.bid.high===null&&r.bid.canAfford===false));
  assert.match(out.rows[0].bid.status,/minimum bid/);
});

check("weekly league and scoring contracts prevent cross-league reuse", () => {
  const players=freshWeekly().players;
  const common={season:2026,week:1,generated_at:new Date(TEST_NOW).toISOString(),players};
  let out=W.analyze({...base,weekly:{...common,league:{...weeklyLeague,league_id:"OTHER"}}});
  assert.strictEqual(out.coverage.weeklyFresh,false); assert.match(out.warnings.join(" "),/league id.*preseason proxy/);
  out=W.analyze({...base,weekly:{...common,league:{...weeklyLeague,sleeper_scoring:{pass_td:6,rec:1}}}});
  assert.strictEqual(out.coverage.weeklyFresh,false); assert.match(out.warnings.join(" "),/scoring contract.*preseason proxy/);
  out=W.analyze({...base,weekly:{...common,league:{...weeklyLeague,sleeper_scoring:{pass_td:4}}}});
  assert.strictEqual(out.coverage.weeklyFresh,false); assert.match(out.warnings.join(" "),/incomplete/);
});

check("zero-only scoring extras preserve the weekly contract", () => {
  const weekly = freshWeekly();
  const live = {...league, scoring_settings:{...league.scoring_settings, extra_zero:0}};
  assert.equal(W.analyze({...base,rosters:freshRosters,league:live,weekly}).coverage.weeklyFresh,true);
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

check("started starters lock their exact full-lineup slot and cancel without a projection", () => {
  const timedBoard={players:board.players.map(x=>({...x,current_team:x.sleeper_id==="8"?"A":"C"}))};
  const timedKickoffs={season:2026,week:1,generated_at:new Date(TEST_NOW).toISOString(),teams:["A","B","C","D"],games:[
    {home:"A",away:"B",kickoff:new Date(TEST_NOW-3600000).toISOString()},
    {home:"C",away:"D",kickoff:new Date(TEST_NOW+3600000).toISOString()}]};
  const weekly=freshWeekly(timedBoard.players).valueOf();
  weekly.players=weekly.players.filter(x=>x.player_id!=="g8");
  const out=W.analyze({...base,board:timedBoard,rosters:freshRosters,weekly,kickoffs:timedKickoffs});
  assert.ok(out.rows.some(r=>r.add.id==="7" && r.lineupGain===8),"expected legal RB upgrade while FLEX remains locked");
  assert.ok(out.rows.filter(r=>r.add.id==="7").every(r=>r.lineupGain<=8),"an unlocked add incorrectly replaced the locked FLEX starter");
  assert.ok(out.rows.every(r=>r.drop?.id!=="8"),"started starter was droppable");
});

check("kickoff after roster snapshot requires refresh", () => {
  const started={...futureKickoffs,games:[{home:"A",away:"B",kickoff:new Date(TEST_NOW-1000).toISOString()}]};
  assert.throws(()=>W.analyze({...base,rosters:freshRosters,weekly:freshWeekly(),kickoffs:started,snapshotAt:TEST_NOW-2000}),/started since.*refresh/);
});

check("started bench players and free agents cannot enter weekly transactions", () => {
  const timedBoard={players:board.players.map(x=>({...x,current_team:["7","11"].includes(x.sleeper_id)?"A":"C",position:x.sleeper_id==="11"?"RB":x.position}))};
  const timedKickoffs={season:2026,week:1,generated_at:new Date(TEST_NOW).toISOString(),teams:["A","B","C","D"],games:[
    {home:"A",away:"B",kickoff:new Date(TEST_NOW-1000).toISOString()},
    {home:"C",away:"D",kickoff:new Date(TEST_NOW+3600000).toISOString()}]};
  const out=W.analyze({...base,board:timedBoard,rosters:freshRosters,weekly:freshWeekly(timedBoard.players),kickoffs:timedKickoffs});
  assert.ok(out.rows.every(r=>r.add.id!=="7"),"started free agent was addable");
  assert.ok(out.rows.every(r=>r.drop?.id!=="11"),"started bench player was droppable");
});

check("weekly team identity fails closed for owned players and excludes unknown free agents", () => {
  const unknownOwn={players:board.players.map(x=>x.sleeper_id==="8"?{...x,current_team:null}:{...x,current_team:"A"})};
  assert.throws(()=>W.analyze({...base,board:unknownOwn,rosters:freshRosters,weekly:freshWeekly(unknownOwn.players)}),/unknown team\/schedule/);
  const unknownFree={players:board.players.map(x=>x.sleeper_id==="7"?{...x,current_team:null}:{...x,current_team:"A"})};
  let out=W.analyze({...base,board:unknownFree,rosters:freshRosters,weekly:freshWeekly(unknownFree.players)});
  assert.ok(out.rows.every(r=>r.add.id!=="7"));
  const tradedWeekly=freshWeekly(); tradedWeekly.players.find(x=>x.player_id==="g7").team="B";
  out=W.analyze({...base,rosters:freshRosters,weekly:tradedWeekly});
  assert.ok(out.rows.every(r=>r.add.id!=="7"),"stale prior-team projection was used");
});

check("invalid kickoff contracts fail closed for otherwise-fresh weekly scoring", () => {
  assert.throws(()=>W.analyze({...base,weekly:freshWeekly(),kickoffs:{...futureKickoffs,week:2}}),/kickoff week.*refresh required/);
  assert.throws(()=>W.analyze({...base,weekly:freshWeekly(),kickoffs:{...futureKickoffs,generated_at:"2026-01-01T00:00:00Z"}}),/kickoff coverage is stale.*refresh required/);
});

check("covered bye free agents cannot be immediate weekly upgrades", () => {
  const byeBoard={players:board.players.map(x=>x.sleeper_id==="7"?{...x,current_team:"BYE"}:x)};
  const out=W.analyze({...base,board:byeBoard,rosters:freshRosters,weekly:freshWeekly(byeBoard.players),kickoffs:{...futureKickoffs,teams:[...futureKickoffs.teams,"BYE"]}});
  assert.ok(out.rows.every(r=>r.add.id!=="7"));
});

check("malformed live starters cannot establish legal kickoff locks", () => {
  for (const starters of [
    ["1","2","3","4","3","5","6"],
    ["1","2","3","4","10","5","6"],
    ["1","2","3","4","99","5","6"],
  ]) {
    assert.throws(()=>W.analyze({...base,weekly:freshWeekly(),rosters:[{...freshRosters[0],starters},freshRosters[1]]}),/current starters/);
  }
});

console.log(`waivers_fixture: ${n} groups OK`);
