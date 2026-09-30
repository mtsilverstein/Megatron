// tests/waivers_fixture.cjs — run with: node tests/waivers_fixture.cjs
const assert = require("assert");
delete global.window;
const W = require("../site/assets/waivers.js");
assert.strictEqual(global.window, undefined, "CommonJS load must not require/mutate window");
const M = require("../site/assets/waivermode.js"); // pure rowText formatter shared by table and export

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
let n = 0; const failed = [];
// FIXTURE_ALL=1 reports every failing group instead of stopping at the first (used to show new cases fail on old code).
function check(name, fn) { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; if (process.env.FIXTURE_ALL) { failed.push(e.message.split("\n")[0]); return; } throw e; } }

check("ownership excludes all active reserve and taxi players", () => {
  const out = W.analyze(base);
  assert.ok(out.rows.every(r => !["1","2","3","4","5","6","8","9","10","99"].includes(r.add.id)));
  assert.ok(out.roster.lockedReserveTaxiIds.includes("99"));
});
check("budget is explicit and reserve caps guidance", () => {
  const out = W.analyze(base);
  assert.deepStrictEqual(out.budget, { total:100, used:40, remaining:60, reserve:20, spendable:40 });
  assert.ok(out.rows.every(r => (r.bid.high === null || r.bid.high <= 40) && /not calibrated/.test(r.bid.label)));
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
  assert.strictEqual(out.budget.spendable,0); assert.ok(out.rows.every(r => r.bid.high === 0 || (r.bid.high === null && (r.signal.strength === "weak" || r.dropCost.status === "unassessed"))));
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
  // Open-slot adds are the only rows that still carry a priced range.
  const costly={...league,roster_positions:["QB","RB","WR","TE","K","DEF","BN","IR","TAXI"],settings:{waiver_budget:100,waiver_bid_min:25}};
  const slotRosters=[{roster_id:1,players:["1","2","3","4","5","6","99"],reserve:["99"],taxi:[],settings:{waiver_budget_used:40}},rosters[1]];
  const strongBoard={players:board.players.map(x=>x.sleeper_id==="7"?{...x,value_points:60}:x)};
  const out=W.analyze({...base,league:costly,rosters:slotRosters,board:strongBoard,budgetReserve:0});
  const priced=out.rows.filter(r=>r.signal.strength==="modeled");
  assert.ok(priced.length>0 && priced.every(r=>r.drop===null));
  assert.ok(priced.every(r=>r.bid.low>=25&&r.bid.high>=25&&r.bid.high<=60));
});

check("weak signals stay visible but never become bids or priority spend", () => {
  // Fresh weekly: RB7 edges out WR8 in FLEX by 0.4 points this week.
  const weekly=freshWeekly(); weekly.players.find(x=>x.player_id==="g7").points.league.p50=7.4;
  let out=W.analyze({...base,rosters:freshRosters,weekly});
  const weak=out.rows.find(r=>r.add.id==="7"&&r.drop.id==="8");
  assert.ok(weak && weak.lineupGain===0.4, "weak row must remain researchable");
  assert.equal(weak.signal.strength,"weak"); assert.equal(weak.signal.perWeekGain,0.4); assert.equal(weak.signal.thresholdPerWeek,1);
  assert.match(weak.signal.label,/weak signal.*below the conservative product threshold.*not a bid or priority claim/);
  assert.doesNotMatch(weak.signal.label,/noise/, "cutoff is unvalidated; must not claim the gain is noise");
  assert.deepEqual([weak.bid.low,weak.bid.high,weak.bid.tier,weak.bid.canAfford],[null,null,"weak signal",true]);
  assert.match(weak.bid.status,/no bid suggested/); assert.match(weak.bid.label,/not calibrated/);
  assert.match(weak.signal.guidance,/no bid suggested.*drop cost independently/);
  assert.match(weak.rosterCost,/WR8.*rest-of-season value.*not price/);
  assert.match(out.warnings.join(" "),/weak|research only/);
  // Rendered/exported wording for the weak FAAB row: never dollars, never "$null".
  const weakText=M.rowText(weak,out);
  assert.equal(weakText.gain,"+0.40 pts · weak signal");
  assert.match(weakText.bid,/^no bid suggested/); assert.doesNotMatch(weakText.bid,/\$/);
  assert.match(weakText.bidNote,/not calibrated/);
  assert.match(weakText.why,/^weak signal · board value estimate/);
  assert.match(weakText.exportLine,/^ADD RB7; DROP WR8; \+0\.40 \(week 1 projection\); WEAK SIGNAL; no bid suggested.*; dropping WR8 costs their rest-of-season value/);
  assert.doesNotMatch(weakText.exportLine,/\$|null|heuristic bid/);
  // Above the cutoff the signal is modeled, but a required drop still withholds
  // the range (drop-cost gate); the priced path is exercised on open-slot adds.
  weekly.players.find(x=>x.player_id==="g7").points.league.p50=8.5;
  out=W.analyze({...base,rosters:freshRosters,weekly});
  const modeled=out.rows.find(r=>r.add.id==="7"&&r.drop.id==="8");
  assert.equal(modeled.signal.strength,"modeled"); assert.equal(modeled.bid.tier,"drop cost unassessed"); assert.equal(modeled.bid.low,null);
  assert.ok(!out.warnings.some(w=>/under 1\.0 projected pt\/week/.test(w)));
  const modeledText=M.rowText(modeled,out);
  assert.equal(modeledText.gain,"+1.50 pts · drop cost unassessed");
  assert.doesNotMatch(modeledText.bid,/\$/); assert.doesNotMatch(modeledText.exportLine,/\$|; modeled;/);
  // Preseason proxy uses per-week gain; rolling leagues get research-only guidance
  // that neither suggests priority spend nor an optional free-agent move.
  const rollingLeague={...league,settings:{waiver_type:0}};
  const rollingRosters=rosters.map(r=>({...r,settings:{waiver_position:r.roster_id}}));
  out=W.analyze({...base,league:rollingLeague,rosters:rollingRosters});
  const proxy=out.rows.find(r=>r.add.id==="7"&&r.drop.id==="8");
  assert.equal(proxy.signal.strength,"weak"); assert.equal(proxy.bid,null);
  assert.ok(Math.abs(proxy.signal.perWeekGain-proxy.lineupGain/17)<0.01);
  assert.match(proxy.signal.guidance,/^research only: no priority claim suggested; assess the drop cost independently/);
  assert.doesNotMatch(proxy.signal.guidance,/free-agent move|optional/);
  const proxyText=M.rowText(proxy,out);
  assert.equal(proxyText.bid,"No priority claim suggested"); assert.equal(proxyText.bidNote,proxy.signal.guidance);
  assert.match(proxyText.why,/^board value estimate/);
  assert.match(proxyText.exportLine,/; WEAK SIGNAL; research only: no priority claim suggested; assess the drop cost independently before any move; dropping WR8/);
  assert.doesNotMatch(proxyText.exportLine,/\$|null/);
  // Modeled rolling open-slot rows keep the league-level ordering guidance.
  const slotLeague={...league,roster_positions:["QB","RB","WR","TE","K","DEF","BN","IR","TAXI"]};
  const slotRosters=[{roster_id:1,players:["1","2","3","4","5","6","99"],reserve:["99"],taxi:[],settings:{waiver_budget_used:40}},rosters[1]];
  const strongRolling=W.analyze({...base,league:{...slotLeague,settings:{waiver_type:0}},rosters:slotRosters.map(r=>({...r,settings:{waiver_position:r.roster_id}})),board:{players:board.players.map(x=>x.sleeper_id==="7"?{...x,value_points:60}:x)}});
  const strongRow=strongRolling.rows.find(r=>r.add.id==="7");
  assert.equal(strongRow.drop,null); assert.equal(strongRow.signal.strength,"modeled");
  const strongText=M.rowText(strongRow,strongRolling);
  assert.equal(strongText.bid,"Set claim order in Sleeper"); assert.match(strongText.bidNote,/Order claims by value/);
  assert.match(strongText.exportLine,/; modeled; rank by value and roster need; uses an open roster spot/);
  // Open-slot adds still disclose the unpriced roster cost.
  out=W.analyze({...base,league:slotLeague,rosters:slotRosters,protectedIds:["1","2","3","4"]});
  assert.match(out.rows.find(r=>r.drop===null).rosterCost,/open roster spot/);
});

check("every required drop withholds spend guidance regardless of preseason board value", () => {
  // Fresh weekly: free agent RB7 is re-valued to preseason 60 and projects 30
  // this week; the bench drop WR8 stays at preseason 7 and projects 7. The add
  // beats the drop on every board number, yet preseason value is stale evidence
  // of today's rest-of-season cost, so no bid range or priority claim may be
  // suggested for any swap that requires a drop. The gain stays visible.
  const weekOf = (players, overrides) => { const w=freshWeekly(players); for (const [g,v] of Object.entries(overrides)) w.players.find(x=>x.player_id===g).points.league.p50=v; return w; };
  const richAddBoard={players:board.players.map(x=>x.sleeper_id==="7"?{...x,value_points:60}:x)};
  const weekly=weekOf(richAddBoard.players,{g7:30,g8:7});
  let out=W.analyze({...base,rosters:freshRosters,board:richAddBoard,weekly});
  const held=out.rows.find(r=>r.add.id==="7"&&r.drop.id==="8");
  assert.ok(held && held.lineupGain===23, "gated row must remain researchable with its modeled gain");
  assert.equal(held.signal.strength,"modeled"); assert.equal(held.valueEstimate.points,60);
  assert.deepEqual(Object.keys(held.dropCost).sort(),["label","reason","status"], "no preseason comparison fields may be exported");
  assert.equal(held.dropCost.status,"unassessed");
  assert.match(held.dropCost.label,/^drop cost unassessed: the rest-of-season change is not priced for this swap/);
  assert.doesNotMatch(held.dropCost.label,/wrong|noise|preseason|board value|\$/);
  assert.deepEqual([held.bid.low,held.bid.high,held.bid.tier,held.bid.canAfford],[null,null,"drop cost unassessed",true]);
  assert.match(held.bid.status,/^no bid suggested: drop cost unassessed/);
  assert.match(held.signal.guidance,/^no bid suggested; the dropped player's rest-of-season cost is not priced, so assess the drop cost independently/);
  assert.match(out.warnings.join(" "),/require a drop whose rest-of-season cost is not priced.*no bid or priority spend/);
  assert.ok(!out.warnings.concat(held.signal.guidance,held.bid.status,held.dropCost.label).some(s=>/preseason board|valued at least|consistent/.test(s)));
  const heldText=M.rowText(held,out);
  assert.equal(heldText.gain,"+23.00 pts · drop cost unassessed");
  assert.match(heldText.bid,/^no bid suggested: drop cost unassessed/); assert.doesNotMatch(heldText.bid,/\$/);
  assert.match(heldText.why,/^drop cost unassessed · board value estimate/);
  assert.match(heldText.dropCostNote,/^drop cost unassessed/);
  assert.match(heldText.exportLine,/^ADD RB7; DROP WR8; \+23\.00 \(week 1 projection\); DROP COST UNASSESSED; no bid suggested: drop cost unassessed.*; dropping WR8 costs their rest-of-season value.*; drop cost unassessed: the rest-of-season change is not priced for this swap/);
  assert.doesNotMatch(heldText.exportLine,/\$|null|heuristic bid|; modeled;|preseason/);
  // Every required-drop alternative on the roster is withheld, not just this one.
  const drops=out.rows.filter(r=>r.drop!==null);
  assert.ok(drops.length>1 && drops.every(r=>r.dropCost.status==="unassessed" && r.bid.low===null && r.bid.high===null));
  assert.ok(out.rows.every(r=>r.dropCost.status!=="consistent"));
  // Weak-signal wording keeps precedence; both withhold spend.
  const weakHeld=W.analyze({...base,rosters:freshRosters,board:richAddBoard,weekly:weekOf(richAddBoard.players,{g7:7.4,g8:7})}).rows.find(r=>r.add.id==="7"&&r.drop.id==="8");
  assert.equal(weakHeld.signal.strength,"weak"); assert.equal(weakHeld.bid.tier,"weak signal"); assert.equal(weakHeld.dropCost.status,"unassessed");
  assert.equal(M.rowText(weakHeld,out).gain,"+0.40 pts · weak signal");
  // Affordability keeps precedence over the gate: an unaffordable minimum is reported as such.
  const costly=W.analyze({...base,league:{...league,settings:{waiver_budget:100,waiver_bid_min:25}},budgetReserve:50,rosters:freshRosters,board:richAddBoard,weekly}).rows.find(r=>r.add.id==="7"&&r.drop.id==="8");
  assert.equal(costly.dropCost.status,"unassessed"); assert.equal(costly.bid.canAfford,false); assert.match(costly.bid.status,/minimum bid/);
  // Rolling leagues: the same rich add against the same cheap drop gets research-only guidance, not a claim order.
  const rollingLeague={...league,settings:{waiver_type:0}};
  const rollingRosters=freshRosters.map(r=>({...r,settings:{waiver_position:r.roster_id}}));
  out=W.analyze({...base,league:rollingLeague,rosters:rollingRosters,board:richAddBoard,weekly});
  const rollingHeld=out.rows.find(r=>r.add.id==="7"&&r.drop.id==="8");
  assert.equal(rollingHeld.bid,null); assert.equal(rollingHeld.dropCost.status,"unassessed");
  assert.match(rollingHeld.signal.guidance,/^research only: no priority claim suggested; the dropped player's rest-of-season cost is not priced/);
  const rollingText=M.rowText(rollingHeld,out);
  assert.equal(rollingText.bid,"No priority claim suggested"); assert.equal(rollingText.bidNote,rollingHeld.signal.guidance);
  assert.match(rollingText.exportLine,/; DROP COST UNASSESSED; research only: no priority claim suggested; the dropped player's rest-of-season cost is not priced/);
  assert.doesNotMatch(rollingText.exportLine,/\$|null|Set claim order|preseason/);
  assert.ok(out.rows.filter(r=>r.drop!==null).every(r=>/^research only: no priority claim suggested/.test(r.signal.guidance)));
  // Open-slot adds sacrifice no one: a strong add keeps its heuristic in FAAB
  // (range) and rolling (claim order), and stays distinguishable from drops.
  const slotLeague={...league,roster_positions:["QB","RB","WR","TE","K","DEF","BN","IR","TAXI"]};
  const slotRosters=[{roster_id:1,players:["1","2","3","4","5","6","99"],starters:["1","2","3","4","5","6"],reserve:["99"],taxi:[],settings:{waiver_budget_used:40}},rosters[1]];
  const openOut=W.analyze({...base,league:slotLeague,rosters:slotRosters,board:richAddBoard,weekly:weekOf(richAddBoard.players,{g7:30}),protectedIds:["1","2","3","4"]});
  const open=openOut.rows.find(r=>r.add.id==="7");
  assert.ok(open && open.drop===null && open.lineupGain>=5);
  assert.deepEqual(open.dropCost,{status:"open_slot",label:"no drop required; future roster flexibility is not priced",addContributes:null,rosDelta:null,futureWeeks:null,endWeek:null});
  assert.match(open.rosterCost,/open roster spot/);
  assert.equal(open.bid.tier,"impact"); assert.ok(open.bid.low>=1 && open.bid.high>=open.bid.low && open.bid.canAfford);
  const openText=M.rowText(open,openOut);
  assert.equal(openText.gain,`+${open.lineupGain.toFixed(2)} pts`); assert.equal(openText.bid,`$${open.bid.low}–$${open.bid.high}`);
  assert.equal(openText.dropCostNote,null); assert.match(openText.exportLine,/DROP none; .*; modeled; heuristic bid \$/);
  assert.ok(!openOut.warnings.some(w=>/require a drop/.test(w)));
  const openRolling=W.analyze({...base,league:{...slotLeague,settings:{waiver_type:0}},rosters:slotRosters.map(r=>({...r,settings:{waiver_position:r.roster_id}})),board:richAddBoard,weekly:weekOf(richAddBoard.players,{g7:30}),protectedIds:["1","2","3","4"]});
  const openRollingRow=openRolling.rows.find(r=>r.add.id==="7");
  assert.equal(openRollingRow.dropCost.status,"open_slot"); assert.equal(openRollingRow.signal.guidance,"rank by value and roster need");
  assert.equal(M.rowText(openRollingRow,openRolling).bid,"Set claim order in Sleeper");
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

// --- rest-of-season drop cost --------------------------------------------------
// Week 1 is the analysed week; weeks 2 and 3 are the priced future. Fixture
// roster 1 (fresh) starts QB1 RB2 WR3 TE4 and FLEX WR8; free agent RB7 is the add.
const remainingLeague = { league_id:"L1", slug:"fixture", sleeper_scoring:{pass_td:4,rec:1} };
const rosRow = (week, p50) => p50 === "bye" ? { week, status:"bye", points:null }
  : p50 === null ? { week, status:"unmodeled", points:null, reason:"no_observed_history" }
  : { week, status:"conditional_projection", opponent:"B", points:{ league:{ p10:p50-3, p50, p90:p50+3 } } };
const remainingFor = (future, overrides={}) => ({
  schema_version:1, horizon:"remaining_season", status:"experimental", season:2026, start_week:1, end_week:3,
  generated_at:new Date(TEST_NOW).toISOString(), data_through:"2026-wk00", league:remainingLeague, evaluation:null,
  players: Object.entries(future).map(([gsis, [w2, w3, team]]) => ({ player_id:gsis, team: team || "A", weeks:[rosRow(1, 1), rosRow(2, w2), rosRow(3, w3)] })),
  ...overrides,
});
// Everyone keeps their weekly number in weeks 2–3 unless overridden.
const steadyFuture = () => ({ g1:[20,20], g2:[10,10], g3:[11,11], g4:[8,8], g8:[5,5], g7:[12,12], g9:[25,25], g10:[13,13], g99:[30,30] });
const rosBase = () => ({ ...base, rosters:freshRosters, weekly:freshWeekly() });

check("priced swap: bench drop forfeits nothing, add's future contribution sets the band", () => {
  const out = W.analyze({ ...rosBase(), remaining: remainingFor(steadyFuture()) });
  const row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.lineupGain, 11);
  assert.deepEqual(Object.keys(row.dropCost).sort(), ["addContributes","dropForfeits","endWeek","futureWeeks","label","rosDelta","status"]);
  assert.equal(row.dropCost.status, "priced");
  // R per future week 54; R+RB7 per week 61 (RB7 takes FLEX over WR8); R+RB7−WR8 still 61.
  assert.equal(row.dropCost.addContributes, 14); assert.equal(row.dropCost.dropForfeits, 0); assert.equal(row.dropCost.rosDelta, 14);
  assert.deepEqual([row.dropCost.futureWeeks, row.dropCost.endWeek], [2, 3]);
  assert.equal(row.signal.moveValue, 25); assert.equal(row.signal.basis, "move");
  assert.ok(Math.abs(row.signal.perWeekGain - 25/3) < 0.01);
  assert.match(row.signal.label, /^modeled lineup gain this week plus rest-of-season lineup change; projection error is not quantified/);
  assert.equal(row.rosterCost, "dropping WR8 forfeits 0.00 projected lineup points over weeks 2–3; RB7 adds 14.00 in his place");
  assert.deepEqual([row.bid.tier, row.bid.low, row.bid.high, row.bid.status], ["impact", 11, 20, null]);
  assert.equal(row.bid.label, "heuristic, not calibrated and not a win probability");
  assert.ok(out.coverage.ros.fresh); assert.equal(out.coverage.ros.reason, null);
  assert.deepEqual([out.coverage.ros.endWeek, out.coverage.ros.futureWeeks, out.coverage.ros.dataThrough], [3, 2, "2026-wk00"]);
  assert.equal(out.coverage.ros.pricedOwned, 5); assert.deepEqual(out.coverage.ros.unmodeledOwned, []);
  assert.equal(out.coverage.ros.evaluation, null);
  assert.ok(!out.warnings.some(w => /rest-of-season cost is not priced/.test(w)));
});

check("final analysed week has no future weeks: pricing is zero and the span reads as such, not W+1–W", () => {
  const out = W.analyze({ ...rosBase(), remaining: remainingFor(steadyFuture(), { end_week: 1 }) });
  const row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.dropCost.status, "priced");
  assert.equal(row.dropCost.rosDelta, 0);
  assert.equal(row.signal.basis, "move");
  assert.equal(row.signal.perWeekGain, row.lineupGain); // moveValue / (futureWeeks + 1) === moveValue / 1
  assert.match(row.rosterCost, /no future weeks remain/);
  assert.doesNotMatch(row.rosterCost, /weeks 2–1/);
});

check("net-negative swap reports both numbers and withholds spend", () => {
  // Free agent RB12 scores 12 this week but ~1 afterwards; dropping RB2 (10 every week) loses the season.
  const richBoard = { players: board.players.concat([p(12,"RB",4)]) };
  const weekly = freshWeekly(richBoard.players); weekly.players.find(x => x.player_id==="g12").points.league.p50 = 12;
  const out = W.analyze({ ...rosBase(), board:richBoard, weekly, remaining: remainingFor({ ...steadyFuture(), g12:[1,1] }) });
  const row = out.rows.find(r => r.add.id==="12" && r.drop.id==="2");
  assert.equal(row.lineupGain, 2);
  // R+RB12 per week: RB slot 10, FLEX max(WR8 5, RB12 1) = 5 → 54, adds 0; without RB2: RB slot 1 → 45, forfeits 9/week.
  assert.deepEqual([row.dropCost.status, row.dropCost.addContributes, row.dropCost.dropForfeits, row.dropCost.rosDelta], ["priced", 0, 18, -18]);
  assert.equal(row.signal.moveValue, -16);
  assert.deepEqual([row.bid.low, row.bid.high, row.bid.tier, row.bid.canAfford], [null, null, "drop costs more than the add returns", true]);
  assert.equal(row.bid.status, "no bid suggested: dropping RB2 forfeits 18.00 rest-of-season lineup points against 0.00 from RB12");
  assert.match(row.signal.guidance, /^no bid suggested; dropping RB2 forfeits 18\.00/);
  assert.doesNotMatch(row.bid.status + row.signal.guidance + row.rosterCost, /wrong|right|\$/);
  // RB12 for RB2, WR3 or WR8 all lose the season: three net-negative rows.
  assert.match(out.warnings.join(" "), /3 alternative\(s\) would forfeit more rest-of-season lineup value than the add returns/);
});

check("unmodeled add or drop is unassessed with the player named, never priced at zero", () => {
  const future = steadyFuture();
  let out = W.analyze({ ...rosBase(), remaining: remainingFor({ ...future, g7:[null,12] }) });
  let row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.deepEqual(Object.keys(row.dropCost).sort(), ["label","reason","status"]);
  assert.equal(row.dropCost.status, "unassessed"); assert.equal(row.dropCost.reason, "RB7 has no rest-of-season projection");
  assert.equal(row.signal.basis, "this_week"); assert.equal(row.signal.perWeekGain, 11);
  assert.deepEqual([row.bid.low, row.bid.high, row.bid.tier], [null, null, "drop cost unassessed"]);
  assert.equal(row.bid.status, "no bid suggested: drop cost unassessed — RB7 has no rest-of-season projection");
  delete future.g8;
  out = W.analyze({ ...rosBase(), remaining: remainingFor(future) });
  row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.dropCost.reason, "WR8 has no rest-of-season projection");
  // Dropping RB2 instead leaves WR8 (unmodeled) as the roster's only other
  // FLEX-eligible player: with WR8 excluded from every future week's pools,
  // neither R+A nor R+A-D can fill FLEX, so this is unassessed for a
  // different reason than a named missing add/drop.
  const unfillable = out.rows.find(r => r.add.id==="7" && r.drop.id==="2");
  assert.equal(unfillable.dropCost.status, "unassessed");
  assert.equal(unfillable.dropCost.reason, "roster cannot field a full lineup from modeled players in every future week");
  out = W.analyze({ ...rosBase(), remaining: remainingFor({ ...future, g7:[null,null] }) });
  row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.dropCost.reason, "RB7 and WR8 have no rest-of-season projection");
  assert.deepEqual(out.coverage.ros.unmodeledOwned, [{ id:"8", name:"WR8" }]);
  assert.equal(out.coverage.ros.pricedOwned, 4);
  assert.match(out.warnings.join(" "), /1 roster player\(s\) have no rest-of-season projection and are excluded from future lineups: WR8/);
});

check("bye weeks count as zero, not unmodeled; a team mismatch is unmodeled", () => {
  let out = W.analyze({ ...rosBase(), remaining: remainingFor({ ...steadyFuture(), g7:["bye",12] }) });
  let row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  // Week 2: RB7 on bye → FLEX WR8 5 → 54; week 3: 61 → adds 7. Without WR8 the bye week's FLEX
  // is RB7's 0 → 49, so the drop forfeits 5 and the net is +2: byes are real weeks, not gaps.
  assert.deepEqual([row.dropCost.status, row.dropCost.addContributes, row.dropCost.dropForfeits, row.dropCost.rosDelta], ["priced", 7, 5, 2]);
  out = W.analyze({ ...rosBase(), remaining: remainingFor({ ...steadyFuture(), g7:[12,12,"Z"] }) });
  row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.dropCost.status, "unassessed"); assert.equal(row.dropCost.reason, "RB7 has no rest-of-season projection");
});

check("stale or misaligned remaining payload withholds drop pricing with the reason; open slots keep this week's basis", () => {
  const cases = [
    [undefined, "remaining-season projections unavailable"],
    [remainingFor(steadyFuture(), { league:{ ...remainingLeague, league_id:"L2" } }), "remaining-season league id does not match live league"],
    [remainingFor(steadyFuture(), { league:{ ...remainingLeague, sleeper_scoring:{ pass_td:6, rec:1 } } }), "remaining-season scoring contract is incomplete or does not match live league"],
    [remainingFor(steadyFuture(), { season:2025 }), "remaining-season season does not match league season"],
    [remainingFor(steadyFuture(), { start_week:2 }), "remaining-season start week does not match requested week"],
    [remainingFor(steadyFuture(), { generated_at:new Date(TEST_NOW - 73*3600000).toISOString() }), "remaining-season projections are stale (over 72 hours old)"],
    [remainingFor(steadyFuture(), { generated_at:new Date(TEST_NOW + 2*3600000).toISOString() }), "remaining-season projections are stale (over 72 hours old)"],
    [remainingFor(steadyFuture(), { players:null }), "remaining-season payload is incomplete"],
    [remainingFor(steadyFuture(), { end_week:0 }), "remaining-season payload is incomplete"],
  ];
  for (const [remaining, reason] of cases) {
    const out = W.analyze({ ...rosBase(), remaining });
    const row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
    assert.equal(out.coverage.ros.fresh, false, reason); assert.equal(out.coverage.ros.reason, reason);
    assert.equal(row.dropCost.status, "unassessed", reason); assert.equal(row.dropCost.reason, reason);
    assert.equal(row.bid.tier, "drop cost unassessed", reason);
    assert.match(out.warnings.join(" "), new RegExp(`${reason.replace(/[()]/g, "\\$&")}; drop costs unassessed, spend guidance limited to open-slot adds`));
  }
  // Open slot with no payload: unchanged behaviour, rosDelta null, this week's basis.
  const slotLeague = { ...league, roster_positions:["QB","RB","WR","TE","K","DEF","BN","IR","TAXI"] };
  const slotRosters = [{ roster_id:1, players:["1","2","3","4","5","6","99"], starters:["1","2","3","4","5","6"], reserve:["99"], taxi:[], settings:{ waiver_budget_used:40 } }, rosters[1]];
  const out = W.analyze({ ...base, league:slotLeague, rosters:slotRosters, weekly:freshWeekly(), protectedIds:["1","2","3","4"] });
  const open = out.rows.find(r => r.add.id==="7");
  assert.equal(open.drop, null);
  assert.deepEqual(Object.keys(open.dropCost).sort(), ["addContributes","endWeek","futureWeeks","label","rosDelta","status"]);
  assert.deepEqual([open.dropCost.status, open.dropCost.rosDelta, open.dropCost.addContributes], ["open_slot", null, null]);
  assert.equal(open.signal.basis, "this_week"); assert.equal(open.signal.perWeekGain, open.lineupGain);
  assert.match(open.rosterCost, /^uses an open roster spot; RB7's rest-of-season contribution is not priced/);
});

check("open-slot adds move to the total-value basis when priced; a one-week fill earns less than a season-long add", () => {
  const slotLeague = { ...league, roster_positions:["QB","RB","WR","TE","K","DEF","BN","IR","TAXI"] };
  const slotRosters = [{ roster_id:1, players:["1","2","3","4","5","6","99"], starters:["1","2","3","4","5","6"], reserve:["99"], taxi:[], settings:{ waiver_budget_used:40 } }, rosters[1]];
  const run = future => W.analyze({ ...base, league:slotLeague, rosters:slotRosters, weekly:freshWeekly(), protectedIds:["1","2","3","4"], remaining: remainingFor({ g1:[20,20], g2:[10,10], g3:[11,11], g4:[8,8], g7:future }) });
  const season = run([12,12]).rows.find(r => r.add.id==="7");
  const oneWeek = run([0,0]).rows.find(r => r.add.id==="7");
  // No FLEX: RB7 (18 this week) displaces RB2 (10) → gain 8; future RB slot 12 vs 10 → +2/week.
  assert.equal(season.lineupGain, 8); assert.deepEqual([season.dropCost.status, season.dropCost.addContributes, season.dropCost.rosDelta], ["open_slot", 4, 4]);
  assert.equal(season.signal.moveValue, 12); assert.ok(Math.abs(season.signal.perWeekGain - 4) < 0.01);
  assert.equal(oneWeek.lineupGain, 8); assert.equal(oneWeek.dropCost.rosDelta, 0);
  assert.ok(Math.abs(oneWeek.signal.perWeekGain - 8/3) < 0.01);
  assert.ok(season.signal.perWeekGain > oneWeek.signal.perWeekGain);
  assert.equal(season.rosterCost, "uses an open roster spot; RB7 adds 4.00 over weeks 2–3; roster flexibility is not priced");
  assert.deepEqual([season.bid.tier, oneWeek.bid.tier], ["useful", "useful"]);
});

check("guidance precedence: affordability, then net-negative, then weak, then unassessed, then bands", () => {
  const rich = { players: board.players.concat([p(12,"RB",4)]) };
  const weekly = freshWeekly(rich.players); weekly.players.find(x => x.player_id==="g12").points.league.p50 = 12;
  const remaining = remainingFor({ ...steadyFuture(), g12:[1,1] });
  // 1. affordability beats everything, including a net-negative swap.
  let out = W.analyze({ ...rosBase(), board:rich, weekly, remaining, league:{ ...league, settings:{ waiver_budget:100, waiver_bid_min:50 } } });
  let row = out.rows.find(r => r.add.id==="12" && r.drop.id==="2");
  assert.deepEqual([row.bid.canAfford, row.bid.status], [false, "minimum bid exceeds spendable budget"]);
  // 2. net-negative beats weak: perWeekValue is negative, but the row is not called weak.
  out = W.analyze({ ...rosBase(), board:rich, weekly, remaining });
  row = out.rows.find(r => r.add.id==="12" && r.drop.id==="2");
  assert.equal(row.signal.strength, "modeled"); assert.equal(row.bid.tier, "drop costs more than the add returns");
  // 3. weak beats unassessed: a tiny gain with no payload is still "weak signal", as shipped.
  const small = freshWeekly(); small.players.find(x => x.player_id==="g7").points.league.p50 = 7.4;
  out = W.analyze({ ...rosBase(), weekly:small });
  row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.signal.strength, "weak"); assert.equal(row.bid.tier, "weak signal"); assert.equal(row.dropCost.status, "unassessed");
  // 4. a priced move can be weak on the per-week number even when this week's gain is not.
  out = W.analyze({ ...rosBase(), weekly:(() => { const w = freshWeekly(); w.players.find(x => x.player_id==="g7").points.league.p50 = 9; return w; })(), remaining: remainingFor({ ...steadyFuture(), g7:[5,5] }) });
  row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.lineupGain, 2); assert.equal(row.dropCost.rosDelta, 0); assert.ok(Math.abs(row.signal.perWeekGain - 2/3) < 0.01);
  assert.equal(row.signal.strength, "weak");
});

check("rosValue decomposition identity and brute-force equivalence on random rosters", () => {
  let seed = 7; const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let trial = 0; trial < 40; trial++) {
    const future = {}; for (const k of Object.keys(steadyFuture())) future[k] = [Math.round(rand()*20), Math.round(rand()*20)];
    const out = W.analyze({ ...rosBase(), remaining: remainingFor(future) });
    for (const r of out.rows.filter(r => r.dropCost.status === "priced")) {
      assert.ok(Math.abs(r.dropCost.rosDelta - (r.dropCost.addContributes - r.dropCost.dropForfeits)) < 1e-6);
      assert.ok(r.dropCost.dropForfeits >= -1e-9 && r.dropCost.addContributes >= -1e-9);
    }
    // Brute force the headline row: RB7 for WR8.
    const row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
    if (!row) continue;
    const pts = (g, w) => future[g][w-2];
    const val = (ids, w) => { // QB, RB, WR, TE, FLEX(best remaining RB/WR/TE)
      const by = { QB:[], RB:[], WR:[], TE:[] }; for (const i of ids) by[board.players.find(x => x.sleeper_id===i).position].push(pts(`g${i}`, w));
      for (const k in by) by[k].sort((a,b)=>b-a);
      const flex = [...by.RB.slice(1), ...by.WR.slice(1), ...by.TE.slice(1)].sort((a,b)=>b-a);
      return by.QB[0] + by.RB[0] + by.WR[0] + by.TE[0] + (flex[0] ?? -Infinity);
    };
    const R = ["1","2","3","4","8"], RA = R.concat("7"), RAD = RA.filter(i => i !== "8");
    const ros = ids => val(ids,2) + val(ids,3);
    assert.ok(Math.abs(row.dropCost.addContributes - (ros(RA) - ros(R))) < 1e-6);
    assert.ok(Math.abs(row.dropCost.dropForfeits - (ros(RA) - ros(RAD))) < 1e-6);
  }
});

check("priced path stays inside the existing performance bound", () => {
  const bigBoard = { players: Array.from({ length: 700 }, (_, i) => p(1000 + i, ["QB","RB","WR","TE"][i % 4], 5 + (i % 30))) };
  const big = { league_id:"L1", season:2026, total_rosters:2, scoring_settings:{pass_td:4,rec:1}, roster_positions:["QB","RB","RB","WR","WR","TE","FLEX","FLEX","K","DEF","BN","BN","BN","BN","BN","IR"], settings:{ waiver_budget:100, waiver_bid_min:1 } };
  const mine = bigBoard.players.slice(0, 15).map(x => x.sleeper_id);
  const bigRosters = [{ roster_id:1, players:mine, starters:mine.slice(0, 8).concat(["0","0"]), reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }, { roster_id:2, players:[], reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }];
  const future = {}; for (const x of bigBoard.players) future[x.player_id] = Array.from({ length: 2 }, () => x.value_points);
  const remaining = remainingFor(future, { end_week: 17, players: bigBoard.players.map(x => ({ player_id:x.player_id, team:"A", weeks: Array.from({ length: 17 }, (_, i) => rosRow(i + 1, x.value_points)) })) });
  const t0 = Date.now();
  const out = W.analyze({ ...base, board:bigBoard, league:big, rosters:bigRosters, weekly:freshWeekly(bigBoard.players), remaining, protectedIds:[] });
  assert.ok(out.rows.length > 0 && out.rows.some(r => r.dropCost.status === "priced"));
  assert.ok(Date.now() - t0 < 4000, `priced analysis took ${Date.now() - t0} ms`);
});

// --- gated simulated drop cost (roster simulation; waiver_verdict gate) --------------
// Gabagool-style roster with two QBs: QB1 starts, QB13 is the healthy-starter
// backup. Lineup-only pricing says the backup is free to drop; the season
// simulation prices his coverage of QB1's absences.
const simBoard = { players: [p(1,"QB",20),p(13,"QB",8),p(2,"RB",10),p(3,"WR",11),p(4,"TE",8),p(5,"K",7),p(6,"DEF",6),p(8,"WR",7),p(7,"RB",18),
  p(9,"QB",25),p(10,"TE",13),p(14,"QB",5),p(15,"RB",3),p(16,"RB",2.5),p(17,"WR",3),p(18,"WR",2.5),p(19,"TE",3),p(20,"TE",2.5),
  // replacement-level free agents beyond the per-position quota (QB 2 / RB 3 / WR 3 / TE 2)
  p(22,"QB",4),p(23,"QB",3.5),p(24,"RB",2.2),p(25,"RB",2.1),p(26,"RB",2),p(27,"WR",2.2),p(28,"WR",2.1),p(29,"WR",2),p(30,"TE",2.2),p(31,"TE",2.1)] };
const simRosters = [{ roster_id:1, players:["1","13","2","3","4","8","5","6"], starters:["1","2","3","4","8","5","6"], reserve:[], taxi:[], settings:{ waiver_budget_used:40 } }, rosters[1]];
const simAvail = { p_out:{QB:.3,RB:.1,WR:.1,TE:.1}, p_stay:{QB:.5,RB:.5,WR:.5,TE:.5}, p_tag:{Out:1,Doubtful:.8,Questionable:.2,IR:1} };
const simSlots = ["QB","RB","WR","TE","FLEX"];
const simEval = (extra = {}) => ({ schema_version:2, league:"fixture", slots:simSlots, verdict:"pass", waiver_verdict:"pass", ...extra });
const simFuture = () => ({ ...steadyFuture(), g13:[8,8], g14:[5,5], g15:[3,3], g16:[2.5,2.5], g17:[3,3], g18:[2.5,2.5], g19:[3,3], g20:[2.5,2.5],
  g22:[4,4], g23:[3.5,3.5], g24:[2.2,2.2], g25:[2.1,2.1], g26:[2,2], g27:[2.2,2.2], g28:[2.1,2.1], g29:[2,2], g30:[2.2,2.2], g31:[2.1,2.1] });
const simArgs = (extra = {}) => ({ ...base, board:simBoard, rosters:simRosters, weekly:freshWeekly(simBoard.players), remaining:remainingFor(simFuture()),
  availability:simAvail, leagueSlug:"fixture", ...extra });
const rowOf = (out, add, drop) => out.rows.find(r => r.add.id === add && r.drop && r.drop.id === drop);

check("gate closed: availability and eval file change nothing, byte for byte", () => {
  const plain = W.analyze({ ...simArgs(), availability:undefined, leagueSlug:undefined });
  const qb = rowOf(plain, "7", "13");
  assert.equal(qb.dropCost.status, "priced"); assert.equal(qb.dropCost.dropForfeits, 0, "today's lineup-only cost: a healthy starter's backup is free");
  assert.match(qb.dropCost.label, /^priced: rest-of-season lineup change over weeks 2–3, assuming participation$/);
  assert.ok(!("pricing" in qb) && !("warnings" in qb), "closed rows keep today's shape");
  const closedJson = JSON.stringify(plain);
  for (const evalFile of [undefined, null, {}, simEval({ waiver_verdict:undefined }), simEval({ waiver_verdict:"fail" }),
      simEval({ schema_version:1 }), simEval({ schema_version:"2" }), simEval({ league:"" }), simEval({ league:null }), simEval({ league:"other" }), simEval({ slots:["QB","RB","WR","TE"] }), simEval({ waiver_verdict:"PASS" })]) {
    assert.ok(JSON.stringify(W.analyze(simArgs({ evalFile }))) === closedJson, `gate must stay closed for ${JSON.stringify(evalFile)}`);
  }
  assert.ok(JSON.stringify(W.analyze(simArgs({ evalFile:simEval(), leagueSlug:"other" }))) === closedJson, "another league's slug keeps the gate closed");
  assert.ok(JSON.stringify(W.analyze(simArgs({ evalFile:simEval({ verdict:"fail" }) }))) !== closedJson, "the trade verdict is a different gate: waiver_verdict alone opens this one");
});

check("gate open: a backup QB behind a healthy starter forfeits real points", () => {
  const out = W.analyze(simArgs({ evalFile:simEval() }));
  const qb = rowOf(out, "7", "13");
  // Whole adds are priced together: every drop row of RB7 shares one pricing class and one nSims.
  const rb7 = out.rows.filter(r => r.add.id === "7");
  assert.ok(rb7.length >= 4 && rb7.every(r => r.pricing === "simulated" && r.simulation.nSims === 2000), "all of an add's rows are priced at the same nSims");
  assert.equal(qb.dropCost.status, "priced");
  assert.ok(qb.dropCost.dropForfeits > 0.2 && qb.dropCost.dropForfeits < 6, `simulated QB2 drop forfeits ${qb.dropCost.dropForfeits}`);
  assert.equal(qb.dropCost.label, "simulated rest-of-season change (absences, byes, replacement) (2000 sims)");
  assert.equal(qb.dropCost.simulation.nSims, 2000, "a displayed row is recomputed at 2000 sims");
  assert.deepEqual([qb.pricing, qb.simulation, qb.warnings], ["simulated", { nSims:2000 }, []]);
  // Every row is explicit about its pricing; the summary counts them.
  assert.ok(out.rows.every(r => (r.pricing === "simulated" || r.pricing === "lineup") && Array.isArray(r.warnings) && (r.pricing !== "simulated" || Number.isInteger(r.simulation.nSims))));
  const sm = out.coverage.ros.simulation;
  assert.equal(sm.rowsSimulated + sm.rowsLineupOnly, out.rows.length);
  assert.equal(sm.rowsSimulated, out.rows.filter(r => r.pricing === "simulated").length);
  // The decision set is the backtest's per-position quota (QB 2 / RB 3 / WR 3 / TE 2, top by mean ROS p50);
  // the replacement pool is the free agents minus exactly that set.
  assert.deepEqual([...sm.quotaIds].sort(), ["14","15","16","17","18","19","20","22","27","7"].sort());
  assert.deepEqual([...sm.replacementIds].sort(), ["23","24","25","26","28","29","30","31"].sort());
  assert.ok(sm.quotaIds.every(k => !sm.replacementIds.includes(k)));
  assert.ok(Math.abs(qb.dropCost.rosDelta - (qb.dropCost.addContributes - qb.dropCost.dropForfeits)) < 0.011);
  assert.equal(out.coverage.ros.simulation.gate, "open");
  // Dropping a starter costs more than dropping the backup.
  assert.ok(rowOf(out, "7", "2").dropCost.dropForfeits > qb.dropCost.dropForfeits);
  // Deterministic: same seed, same numbers.
  assert.equal(JSON.stringify(W.analyze(simArgs({ evalFile:simEval() }))), JSON.stringify(out));
});

check("gate open on FAM's secondary entry reads the secondary's own waiver_verdict", () => {
  const primaryElsewhere = { schema_version:2, league:"gabagool", slots:["QB","RB","RB","WR","WR","TE","FLEX","FLEX"], verdict:"pass", waiver_verdict:"pass" };
  const open = W.analyze(simArgs({ evalFile:{ ...primaryElsewhere, secondary:{ league:"fixture", slots:simSlots, verdict:"pass", waiver_verdict:"pass" } } }));
  assert.ok(rowOf(open, "7", "13").dropCost.dropForfeits > 0.2);
  const noField = W.analyze(simArgs({ evalFile:{ ...primaryElsewhere, secondary:{ league:"fixture", slots:simSlots, verdict:"pass" } } }));
  assert.equal(rowOf(noField, "7", "13").dropCost.dropForfeits, 0, "secondary without waiver_verdict is closed");
  const secondaryFail = W.analyze(simArgs({ evalFile:{ ...primaryElsewhere, secondary:{ league:"fixture", slots:simSlots, verdict:"pass", waiver_verdict:"fail" } } }));
  assert.equal(rowOf(secondaryFail, "7", "13").dropCost.dropForfeits, 0, "the primary's pass must not open another league's gate");
});

check("RosterSimError falls back per row with the reason text", () => {
  const closed = W.analyze(simArgs());
  // No availability table: the world cannot be built.
  let out = W.analyze(simArgs({ evalFile:simEval(), availability:null }));
  let qb = rowOf(out, "7", "13");
  assert.equal(qb.dropCost.dropForfeits, 0);
  assert.match(qb.dropCost.simulationNote, /^simulation unavailable: availability rates missing for QB$/);
  assert.ok(out.rows.every(r => /^simulation unavailable: /.test(r.dropCost.simulationNote)));
  assert.equal(qb.dropCost.label, "lineup-only estimate (not simulated; assumes participation)");
  assert.equal(qb.pricing, "lineup");
  assert.ok(qb.warnings.includes(qb.dropCost.simulationNote), "the note reaches the row's displayed warnings");
  // No free-agent QB to replace anyone: the pool cannot fill a slot.
  const noQb = { ...simBoard, players: simBoard.players.filter(x => x.sleeper_id !== "14") };
  out = W.analyze(simArgs({ evalFile:simEval(), board:noQb, weekly:freshWeekly(noQb.players) }));
  qb = rowOf(out, "7", "13");
  assert.equal(qb.dropCost.simulationNote, "simulation unavailable: no replacement available for QB in week 2");
  assert.equal(qb.dropCost.dropForfeits, 0);
  // Numbers other than the note are today's, untouched.
  assert.deepEqual({ ...qb.dropCost, simulationNote:undefined, label:undefined }, { ...rowOf(closed, "7", "13").dropCost, simulationNote:undefined, label:undefined });
});

check("a player the simulation cannot use falls back on his own rows only", () => {
  const board2 = { players: simBoard.players.concat([p(21,"RB",12)]) };
  const future = { ...simFuture(), g21:[12,12] };
  const remaining = remainingFor(future);
  remaining.players.find(x => x.player_id === "g7").weeks[1].points.league = { p10:20, p50:12, p90:14 };   // p10 above p50
  const out = W.analyze(simArgs({ evalFile:simEval(), board:board2, weekly:freshWeekly(board2.players), remaining }));
  const bad = rowOf(out, "7", "13"), good = rowOf(out, "21", "13");
  assert.match(bad.dropCost.simulationNote, /^simulation unavailable: RB7 has no valid rest-of-season p10\/p50\/p90$/);
  assert.equal(bad.dropCost.dropForfeits, 0);
  assert.ok(good.dropCost.dropForfeits > 0.2 && !good.dropCost.simulationNote, "the other add is still simulated");
});

check("byes count as zero in the quota ranking: a player with a bye ranks below an equal player without one", () => {
  const extra = [p(32,"RB",14),p(33,"RB",13),p(34,"RB",12)];
  const board2 = { players: simBoard.players.concat(extra) };
  const remaining = remainingFor({ ...simFuture(), g32:[14,14], g33:[13,13], g34:[12,"bye"] });
  const out = W.analyze(simArgs({ evalFile:simEval(), board:board2, weekly:freshWeekly(board2.players), remaining }));
  const q = out.coverage.ros.simulation.quotaIds;
  assert.ok(q.includes("7") && !q.includes("34"), `RB7 (12, 12) must outrank RB34 (12, bye) although "34" sorts first: ${q}`);
});

check("open-slot rows: a simulated one says so, a lineup one keeps today's label", () => {
  const open = { ...simRosters[0], players:["1","2","3","4","8","5","6"] };
  const args = extra => simArgs({ rosters:[open, simRosters[1]], ...extra });
  const sim = W.analyze(args({ evalFile:simEval() })).rows.find(r => r.add.id === "7" && r.drop === null);
  assert.equal(sim.dropCost.status, "open_slot"); assert.equal(sim.pricing, "simulated");
  assert.equal(sim.dropCost.label, `no drop required; simulated rest-of-season add value (absences, byes, replacement) (${sim.simulation.nSims} sims)`);
  const lineup = W.analyze(args({})).rows.find(r => r.add.id === "7" && r.drop === null);
  assert.equal(lineup.dropCost.label, "no drop required; roster flexibility is not priced");
  assert.ok(!("pricing" in lineup));
});

check("gate: an eval file without a league never opens the gate, even with an undefined slug", () => {
  const noLeague = { schema_version:2, slots:simSlots, waiver_verdict:"pass" };
  const lg = { roster_positions:["QB","RB","WR","TE","FLEX","K","DEF","BN"] };
  assert.equal(W.waiverGateOpen(noLeague, { ...lg, slug:undefined }), false);
  assert.equal(W.waiverGateOpen({ ...noLeague, league:undefined }, { ...lg, slug:undefined }), false);
  assert.equal(W.waiverGateOpen({ ...noLeague, league:"x" }, { ...lg, slug:"x" }), true);
});

check("a non-quota add keeps the lineup-only price, explicitly labelled and without an engine-failure note", () => {
  const extra = [p(32,"RB",14),p(33,"RB",13),p(34,"RB",12)];
  const board2 = { players: simBoard.players.concat(extra) };
  const remaining = remainingFor({ ...simFuture(), g32:[14,14], g33:[13,13], g34:[11.5,11.5] });
  const out = W.analyze(simArgs({ evalFile:simEval(), board:board2, weekly:freshWeekly(board2.players), remaining }));
  assert.deepEqual([...out.coverage.ros.simulation.quotaIds].sort(), ["14","17","18","19","20","22","27","32","33","7"].sort(), "RB quota is the top three by mean ROS p50");
  const non = rowOf(out, "34", "13"), inq = rowOf(out, "33", "13");
  assert.ok(non && inq);
  assert.equal(non.pricing, "lineup"); assert.equal(non.dropCost.dropForfeits, 0);
  assert.equal(non.dropCost.label, "lineup-only estimate (not simulated; assumes participation)");
  assert.deepEqual(non.warnings, []); assert.ok(!("simulationNote" in non.dropCost) && !("simulation" in non));
  assert.equal(inq.pricing, "simulated"); assert.ok(inq.dropCost.dropForfeits > 0.2);
  assert.ok(out.coverage.ros.simulation.rowsLineupOnly > 0);
});

check("gate open: 13 roster players x 60 adds, both passes, under 3 s", () => {
  const slotsBig = ["QB","RB","RB","WR","WR","TE","FLEX","FLEX","K","DEF","BN","BN","BN","BN","BN","IR"];
  const pos = ["QB","RB","WR","TE"];
  let k = 3000; const mine = [], adds = [], filler = [];
  for (const [ps, pts] of [["QB",[20,8]],["RB",[15,12,9,6,4]],["WR",[15,12,9,6]],["TE",[10,5]]]) pts.forEach(v => mine.push(p(k++, ps, v)));
  for (const ps of pos) for (let i = 0; i < 15; i++) adds.push(p(k++, ps, 12 + i));      // 60 candidate adds that beat the bench
  for (const [ps, count] of [["QB",3],["RB",8],["WR",8],["TE",5]]) for (let i = 0; i < count; i++) filler.push(p(k++, ps, 1 + i * 0.1)); // replacement level
  const kdef = [p(k++,"K",5), p(k++,"DEF",5)];
  const bigBoard = { players: mine.concat(adds, filler, kdef) };
  assert.equal(mine.length, 13); assert.equal(adds.length, 60);
  const bigLeague = { league_id:"L1", season:2026, total_rosters:2, scoring_settings:{pass_td:4,rec:1}, roster_positions:slotsBig, settings:{ waiver_budget:100, waiver_bid_min:1 } };
  const ids = mine.concat(kdef).map(x => x.sleeper_id);
  const bigRosters = [{ roster_id:1, players:ids, starters:Array(10).fill("0"), reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }, { roster_id:2, players:[], reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }];
  // Week 1 is the analysed week; weeks 2-17 are priced (16 future weeks, the heaviest realistic desk).
  const remaining = remainingFor({}, { end_week:17, players: bigBoard.players.filter(x => pos.includes(x.position)).map(x => ({ player_id:x.player_id, team:"A",
    weeks:Array.from({ length:17 }, (_, i) => ({ week:i+1, status:"conditional_projection", opponent:"B", points:{ league:{ p10:x.value_points*0.4, p50:x.value_points, p90:x.value_points*1.6 } } })) })) });
  const args = { ...base, board:bigBoard, league:bigLeague, rosters:bigRosters, weekly:freshWeekly(bigBoard.players), remaining, protectedIds:[], availability:simAvail, leagueSlug:"fixture",
    evalFile:{ schema_version:2, league:"fixture", slots:["QB","RB","RB","WR","WR","TE","FLEX","FLEX"], verdict:"pass", waiver_verdict:"pass" } };
  const t0 = process.hrtime.bigint();
  const out = W.analyze(args);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`waivers_fixture: simulated desk load (13 roster x 60 adds x 16 weeks, gate open) took ${ms.toFixed(0)} ms`);
  assert.ok(out.rows.length > 60, "many add/drop rows exist");
  const sim = out.rows.filter(r => r.dropCost.simulation);
  assert.ok(sim.length > 0 && sim.every(r => r.dropCost.simulation.nSims === 200), "13 droppable rows per add: the 2000-sim work budget holds no whole add, so every priced add is at 200 sims");
  // Pricing is per ADD: rows of one add are all in the same class and at the same nSims.
  const byAdd = new Map();
  for (const r of out.rows) { const k = r.add.id; const v = r.pricing === "simulated" ? `simulated:${r.simulation.nSims}` : "lineup"; if (!byAdd.has(k)) byAdd.set(k, new Set()); byAdd.get(k).add(v); }
  assert.ok([...byAdd.values()].every(v => v.size === 1), "no add is split across pricing classes");
  assert.ok(out.rows.filter(r => r.pricing === "lineup" && r.dropCost.simulationNote).every(r => /^not simulated: outside the adds priced this load$/.test(r.dropCost.simulationNote)));
  assert.ok(out.rows.some(r => r.pricing === "lineup" && r.dropCost.simulationNote), "a quota add left out by the add budget says so");
  assert.ok(new Set(sim.map(r => r.add.id)).size < 10, "the add budget bit");
  assert.ok(ms < 3000, `simulated desk load took ${ms.toFixed(0)} ms`);
});

check("gate closed: no simulation fields leak into the output", () => {
  const out = W.analyze(simArgs());
  assert.ok(out.rows.every(r => !("simulation" in r.dropCost) && !("simulationNote" in r.dropCost) && !("warnings" in r)));
  assert.ok(!("simulation" in out.coverage.ros));
});

// --- review I3: what the desk says about the simulation must be what ran ---------------------------
const countAdds = out => { const by = new Map(); for (const r of out.rows) if (r.pricing === "simulated") by.set(r.add.id, r.simulation.nSims); const c = { 200: 0, 2000: 0 }; for (const v of by.values()) c[v]++; return c; };
check("coverage line: fine pass ran -- says how many adds at each sim count, no ranking claim (I3)", () => {
  const out = W.analyze(simArgs({ evalFile:simEval() }));
  const c = countAdds(out), sm = out.coverage.ros.simulation;
  assert.ok(c[2000] > 0, "sanity: this desk prices its leading add at 2000 sims");
  const text = W.simulationCoverageText(sm);
  assert.equal(text, `Drop costs for simulated rows come from a seeded season simulation that includes absences, byes and replacement-level pickups: ${c[200]} add${c[200] === 1 ? "" : "s"} simulated at 200 sims, ${c[2000]} at 2000; ${sm.rowsLineupOnly} row${sm.rowsLineupOnly === 1 ? "" : "s"} lineup-only.`);
  assert.doesNotMatch(text, /rank/i);
});
check("coverage line: fine pass skipped -- 0 adds at 2000, still no ranking claim (I3)", () => {
  // The heaviest desk (13 drop rows per add) holds no whole add inside the 2000-sim budget: everything priced is at 200.
  const slotsBig = ["QB","RB","RB","WR","WR","TE","FLEX","FLEX","K","DEF","BN","BN","BN","BN","BN","IR"];
  let k = 5000; const mine = [], adds = [], filler = [];
  for (const [ps, pts] of [["QB",[20,8]],["RB",[15,12,9,6,4]],["WR",[15,12,9,6]],["TE",[10,5]]]) pts.forEach(v => mine.push(p(k++, ps, v)));
  for (const ps of ["QB","RB","WR","TE"]) for (let i = 0; i < 6; i++) adds.push(p(k++, ps, 12 + i));
  for (const [ps, count] of [["QB",3],["RB",8],["WR",8],["TE",5]]) for (let i = 0; i < count; i++) filler.push(p(k++, ps, 1 + i * 0.1));
  const kdef = [p(k++,"K",5), p(k++,"DEF",5)];
  const bigBoard = { players: mine.concat(adds, filler, kdef) };
  const bigLeague = { league_id:"L1", season:2026, total_rosters:2, scoring_settings:{pass_td:4,rec:1}, roster_positions:slotsBig, settings:{ waiver_budget:100, waiver_bid_min:1 } };
  const ids = mine.concat(kdef).map(x => x.sleeper_id);
  const bigRosters = [{ roster_id:1, players:ids, starters:Array(10).fill("0"), reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }, { roster_id:2, players:[], reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }];
  const remaining = remainingFor({}, { end_week:17, players: bigBoard.players.filter(x => ["QB","RB","WR","TE"].includes(x.position)).map(x => ({ player_id:x.player_id, team:"A",
    weeks:Array.from({ length:17 }, (_, i) => ({ week:i+1, status:"conditional_projection", opponent:"B", points:{ league:{ p10:x.value_points*0.4, p50:x.value_points, p90:x.value_points*1.6 } } })) })) });
  const out = W.analyze({ ...base, board:bigBoard, league:bigLeague, rosters:bigRosters, weekly:freshWeekly(bigBoard.players), remaining, protectedIds:[], availability:simAvail, leagueSlug:"fixture",
    evalFile:{ schema_version:2, league:"fixture", slots:["QB","RB","RB","WR","WR","TE","FLEX","FLEX"], verdict:"pass", waiver_verdict:"pass" } });
  const c = countAdds(out), sm = out.coverage.ros.simulation;
  assert.ok(c[200] > 0 && c[2000] === 0, `all priced adds at 200 sims: ${JSON.stringify(c)}`);
  assert.equal(W.simulationCoverageText(sm), `Drop costs for simulated rows come from a seeded season simulation that includes absences, byes and replacement-level pickups: ${c[200]} adds simulated at 200 sims, 0 at 2000; ${sm.rowsLineupOnly} rows lineup-only.`);
  assert.doesNotMatch(W.simulationCoverageText(sm), /rank/i);
});
check("coverage line: a fallback never says the drop costs came from a simulation (I3)", () => {
  const out = W.analyze(simArgs({ evalFile:simEval(), availability:null }));
  const sm = out.coverage.ros.simulation;
  assert.equal(sm.rowsSimulated, 0);
  const text = W.simulationCoverageText(sm);
  assert.equal(text, "Simulation unavailable: availability rates missing for QB; lineup-only prices are shown.");
  assert.doesNotMatch(text, /seeded|come from|rank|sims/i);
});
check("every simulated row's label and export note carry its sim count (I3)", () => {
  const out = W.analyze(simArgs({ evalFile:simEval() }));
  const simRows = out.rows.filter(r => r.pricing === "simulated");
  assert.ok(simRows.length > 0);
  for (const r of simRows) assert.ok(r.dropCost.label.endsWith(`(${r.simulation.nSims} sims)`), r.dropCost.label);
  const open = { ...simRosters[0], players:["1","2","3","4","8","5","6"] };
  const o = W.analyze(simArgs({ rosters:[open, simRosters[1]], evalFile:simEval() })).rows.find(r => r.add.id === "7" && r.drop === null);
  assert.ok(o.dropCost.label.endsWith(`(${o.simulation.nSims} sims)`), o.dropCost.label);
  const lineup = out.rows.find(r => r.pricing === "lineup");
  if (lineup) assert.doesNotMatch(lineup.dropCost.label, /sims/);
  // The formatter puts the count in the table note and in the export line.
  const t = M.rowText(simRows[0], { waiver:{ type:"faab", guidance:"x" } });
  assert.match(t.dropCostNote, new RegExp(`\\(${simRows[0].simulation.nSims} sims\\)`));
  assert.match(t.exportLine, new RegExp(`\\(${simRows[0].simulation.nSims} sims\\)`));
});
check("weeks after 17 are not measured: lineup-only with that reason (review M7)", () => {
  const out = W.analyze(simArgs({ evalFile:simEval(), remaining:remainingFor(simFuture(), { end_week:18 }) }));
  const sm = out.coverage.ros.simulation;
  assert.equal(sm.rowsSimulated, 0);
  assert.equal(sm.fallbackReason, "weeks after 17 are not measured");
  assert.ok(out.rows.every(r => r.pricing !== "simulated"));
  assert.equal(W.simulationCoverageText(sm), "Simulation unavailable: weeks after 17 are not measured; lineup-only prices are shown.");
});

if (failed.length) { console.log(`FAILED (${failed.length}):\n  ` + failed.join("\n  ")); process.exit(1); }
console.log(`waivers_fixture: ${n} groups OK`);
