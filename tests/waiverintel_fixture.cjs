const assert = require("node:assert/strict");
const I = require("../site/assets/waiverintel.js");
const M = require("../site/assets/waivermode.js");
const p = (id, team, bye, position="RB") => ({sleeper_id:String(id),name:`Player ${id}`,team,bye,position,ecr:Number(id)});
const base = {board:{players:[p(1,"NO",8),p(2,"NYG",8),p(3,"TB",7),p(4,"MIN",6),p(5,"NO",8),p(6,"CLE",9),p(7,"GB",5),p(8,"NYJ",9)]},
  league:{total_rosters:2,roster_positions:["RB","RB","FLEX","FLEX"]},week:1,rosterId:1,
  rosters:[{roster_id:1,players:["1","2","3","4"],reserve:[]},{roster_id:2,players:["7"],reserve:["8"]}],
  signals:{add:[{player_id:"6",count:120},{player_id:"7",count:500},{player_id:"90",count:20}],drop:[{player_id:"5",count:5}],fetchedAt:"now"},
  catalog:{90:{full_name:"New rookie",position:"WR",team:"DEN"}}, transactions:[]};
let out=I.analyze(base);
assert.deepEqual(out.byeRisks,[{week:8,position:"RB",required:2,available:2,away:["Player 1","Player 2"],severity:"no spare"}]);
assert.ok(out.radar.every(x=>!["1","2","3","4","7","8"].includes(x.id)));
assert.deepEqual(out.radar.find(x=>x.id==="5").sameTeam,["Player 1"]);
assert.deepEqual(out.radar.find(x=>x.id==="5").byeCover,[]); // same bye is not coverage
assert.deepEqual(out.radar.find(x=>x.id==="6").byeCover,[8]);
assert.equal(out.radar.find(x=>x.id==="5").adds,null); // absent is not zero
assert.equal(out.radar.find(x=>x.id==="90").projectionCovered,false);
assert.equal(out.radar.find(x=>x.id==="90").ecr,null);
out=I.analyze({...base,catalog:{5:{team:"CLE",injury_status:"IR"},6:{team:"NYJ"}}});
assert.equal(out.radar.find(x=>x.id==="5").sameTeam.length,0);
assert.equal(out.radar.find(x=>x.id==="6").byeCover.length,0); // changed team invalidates old bye
out=I.analyze({...base,signals:{add:null,drop:[]}});
assert.match(out.warnings.join(" "),/add trend feed unavailable/);
assert.ok(out.radar.some(x=>x.id==="5")); // research survives optional outage
out=I.analyze({...base,transactions:[
  {transaction_id:"a",type:"waiver",status:"complete",settings:{waiver_bid:0},adds:{6:1}},
  {transaction_id:"a",type:"waiver",status:"complete",settings:{waiver_bid:0},adds:{6:1}},
  {transaction_id:"b",type:"free_agent",status:"complete",settings:{waiver_bid:0}},
  {transaction_id:"c",type:"waiver",status:"pending",settings:{waiver_bid:90}},
  {transaction_id:"d",type:"waiver",status:"complete",settings:{waiver_bid:null}},
]});
assert.deepEqual(out.bids,[{amount:0,players:["Player 6"]}]);
assert.equal(out.freeAgentMoves,1);
assert.throws(()=>I.analyze({...base,rosters:[base.rosters[0]]}),/every league roster/);
assert.throws(()=>I.analyze({...base,week:0}),/week is invalid/);
(async()=>{
  const calls=[];
  const signals=await M.loadSignals(async path=>{calls.push(path);if(path.includes('/drop?'))throw Error('offline');return [];});
  assert.equal(calls.length,2);assert.ok(calls.every(p=>p.includes('lookback_hours=24&limit=100')));
  assert.deepEqual(signals.add,[]);assert.equal(signals.drop,null);
  console.log('waiverintel_fixture: bye coverage, ownership, rookie discovery, unknown counts, bid evidence and optional outages OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
