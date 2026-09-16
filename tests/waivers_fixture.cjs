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
  assert.match(held.dropCost.label,/^drop cost unassessed: the dropped player's rest-of-season value is not priced/);
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
  assert.match(heldText.exportLine,/^ADD RB7; DROP WR8; \+23\.00 \(week 1 projection\); DROP COST UNASSESSED; no bid suggested: drop cost unassessed.*; dropping WR8 costs their rest-of-season value.*; drop cost unassessed: the dropped player's rest-of-season value is not priced/);
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

console.log(`waivers_fixture: ${n} groups OK`);
