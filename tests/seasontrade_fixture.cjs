const assert=require('node:assert/strict');
const {analyze}=require('../site/assets/seasontrade.js');
const now=Date.parse('2026-09-14T12:00:00Z');
const catalog=Object.fromEntries(['a','b','c','d'].map(id=>[id,{gsis_id:'g'+id,position:'RB',team:'A',full_name:id}]));
const value={a:10,b:5,c:20,d:2};
const league={league_id:'L',season:'2026',status:'in_season',total_rosters:2,roster_positions:['RB','BN'],scoring_settings:{rec:1}};
const remaining={schema_version:1,horizon:'remaining_season',status:'experimental',advice_eligible:false,season:2026,start_week:1,end_week:3,
  generated_at:new Date(now).toISOString(),league:{league_id:'L',sleeper_scoring:{rec:1}},players:Object.keys(catalog).map(id=>({player_id:'g'+id,team:'A',position:'RB',weeks:[2,3].map(week=>({week,status:'conditional_projection',points:{league:{p50:value[id]}}}))}))};
const base={remaining,league,catalog,rosters:[{roster_id:1,players:['a','b']},{roster_id:2,players:['c','d']}],rosterIds:[1,2],give:['a'],receive:['c'],currentWeek:1,assumeAvailable:true,now,snapshotAt:now};
const clone=x=>JSON.parse(JSON.stringify(x));
const original=clone(base);
let out=analyze(base);
assert.deepEqual(out.sides.map(s=>s.delta),[20,-20]);
assert.equal(out.advice_eligible,false);
assert.deepEqual(out.weeks.map(w=>w.week),[2,3]);
assert.deepEqual(base,original);
assert.deepEqual(analyze({...base,catalog:{...catalog,a:{...catalog.a,gsis_id:' ga '}}}).sides,out.sides);
const identityBoard={season:2026,league:{league_id:'L'},players:Object.keys(catalog).map(id=>({sleeper_id:id,player_id:catalog[id].gsis_id,position:'RB'}))};
assert.deepEqual(analyze({...base,board:identityBoard,catalog:Object.fromEntries(Object.entries(catalog).map(([id,c])=>[id,{...c,gsis_id:null}]))}).sides,out.sides);
out=analyze({...base,excludeWeeks:{c:[2]}});
assert.deepEqual(out.sides.map(s=>s.delta),[5,-2]); // unavailable c also changes partner's baseline
for(const change of [{assumeAvailable:false},{snapshotAt:now-60001},{currentWeek:3},{give:['d']},{give:['a','a']},
  {receive:['c','d']},{league:{...league,scoring_settings:{rec:.5}}},{remaining:{...remaining,season:2025}},
  {remaining:{...remaining,generated_at:'2026-01-01'}},{drops:{1:['c']}},{drops:{3:['b']}}]) assert.throws(()=>analyze({...base,...change}));
out=analyze({...base,give:['a','b'],drops:{2:['d']}});
assert.equal(out.weeks.length,2);
assert.throws(()=>analyze({...base,give:['a','b']}),/capacity/);
const bad=clone(base);bad.remaining.players[0].weeks[0].status='unmodeled';
assert.throws(()=>analyze(bad),/unknown is not zero/);
bad.remaining.players[0].weeks[0].status='bye';
assert.doesNotThrow(()=>analyze(bad));
assert.throws(()=>analyze({...base,catalog:{...catalog,a:{...catalog.a,team:'B'}}}),/team mismatch/);
assert.throws(()=>analyze({...base,catalog:{...catalog,other:{...catalog.a}}}),/ambiguous GSIS/);
assert.throws(()=>analyze({...base,rosters:[{...base.rosters[0],reserve:['a']},base.rosters[1]]}),/non-reserve/);
assert.throws(()=>analyze({...base,league:{...league,roster_positions:['QB','BN']}}),/cannot fill/);
const flex=clone(base);
flex.league.roster_positions=['RB','FLEX'];
out=analyze(flex);
assert.equal(out.weeks[0].sides[0].before.total,15);
assert.equal(out.weeks[0].sides[0].after.total,25);
const injury=analyze({...base,catalog:{...catalog,b:{...catalog.b,injury_status:'Out'}}});
assert.equal(injury.availabilityFlags[0].id,'b');
assert.deepEqual(injury.sides,out.sides);
const superflex=clone(base);
superflex.league.roster_positions=['RB','SUPER_FLEX'];
for(const id of ['b','d']) {
  superflex.catalog[id].position='QB';
  superflex.remaining.players.find(p=>p.player_id==='g'+id).position='QB';
}
out=analyze(superflex);
assert.equal(out.weeks[0].sides[0].before.total,15);
assert.equal(out.weeks[0].sides[0].after.total,25);
assert.equal(out.weeks[0].sides[0].before.lineup[1].position,'QB');
assert.deepEqual(analyze({...base,currentWeek:2}).weeks.map(w=>w.week),[3]);
assert.throws(()=>analyze({...base,board:{...identityBoard,season:2025}}),/board league\/season/);
assert.throws(()=>analyze({...base,board:identityBoard,catalog:{...catalog,a:{...catalog.a,gsis_id:'different'}}}),/identity disagreement/);
assert.throws(()=>analyze({...base,league:{...league,scoring_settings:{rec:1,pass_td:6}}}),/Scoring mismatch/);
const gaps=clone(base);
for(const p of gaps.remaining.players.filter(p=>['ga','gd'].includes(p.player_id))) {
  for(const w of p.weeks) { w.status='unmodeled';w.points=null;w.reason='no_observed_history'; }
}
assert.throws(()=>analyze(gaps),error=>{
  assert.equal(error.name,'ProjectionCoverageError');
  assert.deepEqual(error.coverageIssues.map(x=>[x.id,x.week]),[['a',2],['d',2],['a',3],['d',3]]);
  assert.ok(error.coverageIssues.every(x=>x.reason.includes('no_observed_history')));
  return true;
});
// Explicit exclusions can cover an unmodeled week but never repair identity.
assert.doesNotThrow(()=>analyze({...gaps,excludeWeeks:{a:[2,3],d:[2,3]}}));
assert.throws(()=>analyze({...gaps,catalog:{...catalog,a:{...catalog.a,gsis_id:null}},excludeWeeks:{a:[2,3],d:[2,3]}}),/GSIS/);
console.log('seasontrade_fixture: ownership, capacity, scoring, freshness, exclusions, missingness and symmetric lineup changes OK');
