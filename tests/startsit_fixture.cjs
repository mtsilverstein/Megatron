const assert=require('node:assert/strict'),S=require('../site/assets/startsit.js');
const now=Date.parse('2026-09-09T12:00:00Z');
const positions=['QB','RB','RB','WR','WR','TE','FLEX','FLEX','K','DEF'];
const ps=['QB','RB','RB','WR','WR','TE','WR','RB','K','DEF','QB','TE','RB'];
const values=[20,12,11,18,17,9,16,8,0,0,21,8,13];
const catalog=Object.fromEntries(ps.map((position,i)=>[String(i+1),{position,full_name:`P${i+1}`,team:'A'}]));
const board={players:ps.map((position,i)=>({sleeper_id:String(i+1),player_id:`g${i+1}`,position}))};
const weekly={league:{league_id:'L',sleeper_scoring:{pass_td:6}},season:2026,week:1,generated_at:new Date(now).toISOString(),players:values.map((v,i)=>({player_id:`g${i+1}`,team:'A',points:{league:{p50:v,p10:v-5,p90:v+5}}}))};
const league={league_id:'L',season:'2026',scoring_settings:{pass_td:6},roster_positions:[...positions,'BN','BN','BN']};
const roster={players:ps.map((_,i)=>String(i+1)),starters:ps.slice(0,10).map((_,i)=>String(i+1))};
const kickoffs={season:2026,week:1,generated_at:new Date(now).toISOString(),teams:['A','B'],games:[{home:'A',away:'B',kickoff:new Date(now+3600000).toISOString()}]};
const base={board,weekly,league,roster,catalog,kickoffs,now};
let r=S.analyze(base);
assert.equal(r.lineup[0].id,'11');assert.equal(r.lineup[8].id,'9');assert.equal(r.lineup[9].id,'10');
assert.ok(r.lineup.some(p=>p.id==='13'));assert.equal(new Set(r.lineup.map(p=>p.id)).size,10);
assert.equal(r.bench.find(p=>p.id==='1').close,true);assert.equal(r.bench.find(p=>p.id==='1').gap,1);
r=S.analyze({...base,now:now+7200000});assert.deepEqual(r.lineup.map(p=>p.id),roster.starters);
assert.ok(r.bench.every(p=>p.locked));
assert.throws(()=>S.analyze({...base,now:now+7200000,snapshotAt:now}),/game started since/);
r=S.analyze({...base,excludeIds:['11']});assert.equal(r.lineup[0].id,'1');
r=S.analyze({...base,catalog:{...catalog,11:{...catalog[11],injury_status:'Out'}}});assert.equal(r.lineup[0].id,'1');
assert.throws(()=>S.analyze({...base,weekly:{...weekly,players:weekly.players.filter(p=>p.player_id!=='g11')}}),/missing current-team/);
r=S.analyze({...base,weekly:{...weekly,players:weekly.players.filter(p=>p.player_id!=='g11')},excludeIds:['11']});assert.equal(r.lineup[0].id,'1');
assert.throws(()=>S.analyze({...base,league:{...league,scoring_settings:{pass_td:4}}}),/scoring changed/);
assert.throws(()=>S.analyze({...base,kickoffs:{...kickoffs,week:2}}),/week mismatch/);
assert.throws(()=>S.analyze({...base,now:now+8*86400000}),/seven days/);
assert.throws(()=>S.analyze({...base,kickoffs:{...kickoffs,games:[{home:'A',away:'B',kickoff:null}]}}),/Invalid kickoff/);
r=S.analyze({...base,roster:{...roster,reserve:['13']}});assert.ok(!r.lineup.some(p=>p.id==='13'));
// A locked FLEX cannot be moved into an RB slot to admit another receiver.
const mixed={...base,catalog:{...catalog,8:{...catalog[8],team:'C'}},weekly:{...weekly,players:weekly.players.map(p=>p.player_id==='g8'?{...p,team:'C'}:p)},
 kickoffs:{...kickoffs,teams:['A','B','C','D'],games:[...kickoffs.games,{home:'C',away:'D',kickoff:new Date(now-1000).toISOString()}]}};
r=S.analyze(mixed);assert.equal(r.lineup[7].id,'8');assert.ok(r.lineup[7].locked);
// Equivalent WR slots must not suggest gratuitous changes.
r=S.analyze({...base,roster:{...roster,starters:roster.starters.map((id,i)=>i===3?'5':i===4?'4':id)}});
assert.equal(r.lineup[3].id,'5');assert.equal(r.lineup[4].id,'4');assert.equal(r.lineup[3].changed,false);
assert.throws(()=>S.analyze({...base,weekly:{...weekly,league:{league_id:'L'}}}),/scoring contract is missing/);
// Randomized exact-sum oracle, including two FLEX slots, checks the greedy solver.
let seed=42;
for(let trial=0;trial<30;trial++) {
 const v=values.map(()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%300/10;});
 const w={...weekly,players:weekly.players.map((p,i)=>({...p,points:{league:{p50:v[i]}}}))};
 const result=S.analyze({...base,weekly:w});
 let best=-Infinity;
 function walk(i,used,sum) {
  if(i===8){best=Math.max(best,sum);return;}
  for(let j=0;j<ps.length;j++)if(!used.has(j)&&(ps[j]===positions[i]||positions[i]==='FLEX'&&['RB','WR','TE'].includes(ps[j]))) {
   used.add(j);walk(i+1,used,sum+v[j]);used.delete(j);
  }
 }
 walk(0,new Set(),0);
 assert.ok(Math.abs(result.lineup.reduce((s,p)=>s+(p.points?.p50||0),0)-best)<1e-8);
}
console.log('startsit_fixture: legal slots, close calls, locked starters/bench/FLEX, injuries, IR, missing data and stale contracts OK');
