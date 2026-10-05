const assert=require('node:assert/strict');
const {analyze}=require('../site/assets/seasontrade.js');
const LD=require('../site/assets/leaguedata.js');
const LL=require('../site/assets/leaguelens.js');
const now=Date.parse('2026-09-14T12:00:00Z');
// Synthetic league (fictional rosters and ids). Identity comes from the league view's board
// (sleeper_id -> player_id); the published remaining and board carry no league contract.
const catalog=Object.fromEntries(['a','b','c','d'].map(id=>[id,{gsis_id:'g'+id,position:'RB',team:'A',full_name:id}]));
const value={a:10,b:5,c:20,d:2};
const league={league_id:'L',season:'2026',status:'in_season',total_rosters:2,roster_positions:['RB','BN'],scoring_settings:{rec:1}};
const remaining={schema_version:1,horizon:'remaining_season',status:'experimental',evaluation:null,season:2026,start_week:1,end_week:3,
  generated_at:new Date(now).toISOString(),players:Object.keys(catalog).map(id=>({player_id:'g'+id,team:'A',position:'RB',weeks:[2,3].map(week=>({week,status:'conditional_projection',points:{league:{p50:value[id]}}}))}))};
const identityBoard={season:2026,players:Object.keys(catalog).map(id=>({sleeper_id:id,player_id:catalog[id].gsis_id,position:'RB'}))};
const base={remaining,league,catalog,board:identityBoard,rosters:[{roster_id:1,players:['a','b']},{roster_id:2,players:['c','d']}],rosterIds:[1,2],give:['a'],receive:['c'],currentWeek:1,assumeAvailable:true,now,snapshotAt:now};
const clone=x=>JSON.parse(JSON.stringify(x));
const original=clone(base);
// --- policy groups (any-league phase 1, spec §7.1 trade, §5.3, §8) ----------------
// FIXTURE_ALL=1 reports every failing group instead of stopping at the first.
const groupFails=[];
const group=(name,fn)=>{try{fn();}catch(e){e.message=`${name}: ${e.message}`;if(process.env.FIXTURE_ALL){groupFails.push(e.message.split('\n')[0]);return;}throw e;}};
const withPos=(src,pos)=>{const x=clone(src);for(const [id,p] of Object.entries(pos)){x.catalog[id].position=p;x.remaining.players.find(q=>q.player_id==='g'+id).position=p;x.board.players.find(q=>q.sleeper_id===id).position=p;}return x;};
const deltas=args=>analyze(args).sides.map(s=>s.delta);
group('independent failures, each alone against a passing base (kept checks, spec §5.3)',()=>{
  assert.deepEqual(deltas(base),[20,-20]);
  for(const [name,change,re] of [
    ['week 0',{currentWeek:0},{message:'Current NFL week required'}],
    ['week 19',{currentWeek:19},{message:'Current NFL week required'}],
    ['week 2.5',{currentWeek:2.5},{message:'Current NFL week required'}],
    ['wrong season',{remaining:{...remaining,season:2025}},{message:'Projection season mismatch'}],
    ['future-dated remaining',{remaining:{...remaining,generated_at:new Date(now+1000).toISOString()}},{message:'Remaining projections stale or future-dated'}],
    ['remaining older than 72 h',{remaining:{...remaining,generated_at:new Date(now-72*3600000-1000).toISOString()}},{message:'Remaining projections stale or future-dated'}],
    ['roster snapshot older than 60 s',{snapshotAt:now-60001},{message:'Roster snapshot stale or invalid; reload'}],
    ['roster snapshot after now',{snapshotAt:now+1},{message:'Roster snapshot stale or invalid; reload'}],
  ]) assert.throws(()=>analyze({...base,...change}),re,name);
  assert.deepEqual(deltas({...base,remaining:{...remaining,generated_at:new Date(now-72*3600000).toISOString()}}),[20,-20],'exactly 72 h passes');
  assert.deepEqual(deltas({...base,snapshotAt:now-60000}),[20,-20],'exactly 60 s passes');
});
group('no published league contract: a contract-free view passes; another league id or scoring is rescored, never refused (§8.7)',()=>{
  assert.ok(!('league' in remaining)&&!('league' in identityBoard),'the fixture view carries no league contract');
  assert.deepEqual(deltas({...base,league:{...league,scoring_settings:{rec:.5,pass_td:6}}}),[20,-20]);
  assert.deepEqual(deltas({...base,league:{...league,league_id:'999'}}),[20,-20]);
  assert.deepEqual(deltas({...base,remaining:{...remaining,league:{league_id:'OTHER',sleeper_scoring:{rec:0}}},board:{...identityBoard,league:{league_id:'OTHER'}}}),[20,-20],'a stale legacy contract is ignored');
});
group('WRRB_FLEX and REC_FLEX eligibility through the exact kernel',()=>{
  const wrrb=withPos(base,{b:'TE',d:'TE'});wrrb.league.roster_positions=['WRRB_FLEX','BN'];
  assert.deepEqual(deltas(wrrb),[20,-20],'RB for RB in WRRB_FLEX');
  assert.throws(()=>analyze({...wrrb,receive:['d']}),/cannot fill required WRRB_FLEX slot/,'a TE never fills WRRB_FLEX');
  const rec=withPos(base,{a:'WR',c:'TE'});rec.league.roster_positions=['REC_FLEX','BN'];
  const out=analyze(rec);
  assert.deepEqual(out.weeks[0].sides.map(s=>[s.before.total,s.after.total]),[[10,20],[20,10]],'RBs b and d never start in REC_FLEX');
  assert.deepEqual(out.sides.map(s=>s.delta),[20,-20]);
  assert.deepEqual(deltas({...rec,give:['b'],receive:['d']}),[0,0],'moving bench RBs changes no REC_FLEX lineup');
});
group('IDP: a rostered LB/DL/DB returns null (no lineup candidate), never "Unknown roster player position"; IDP slots count toward capacity',()=>{
  const idp=clone(base);
  idp.league.roster_positions=['RB','LB','DL','DB','IDP_FLEX','K','DEF','BN'];
  Object.assign(idp.catalog,{lb1:{position:'LB',team:'A',full_name:'lb1'},dl1:{position:'DL',team:'A',full_name:'dl1'},db1:{position:'DB',team:'B',full_name:'db1'},k1:{position:'K',team:'A',full_name:'k1'},def1:{position:'DEF',team:'A'}});
  idp.rosters=[{roster_id:1,players:['a','b','lb1','dl1','db1','k1']},{roster_id:2,players:['c','d','def1']}];
  const out=analyze(idp);
  assert.deepEqual(out.sides.map(s=>s.delta),[20,-20]);
  assert.deepEqual(out.weeks[0].sides[0].before.lineup.map(p=>p.id),['a'],'only the modeled RB slot is solved');
  const lbOnly={...base,catalog:{...catalog,lb1:{position:'LB',team:'A',full_name:'lb1'}},rosters:[{roster_id:1,players:['a','b','lb1']},base.rosters[1]],league:{...league,roster_positions:['RB','BN','BN']}};
  assert.deepEqual(deltas(lbOnly),[20,-20],'a rostered LB in a league without IDP slots is also null');
  assert.throws(()=>analyze({...lbOnly,league:{...lbOnly.league,roster_positions:['RB','BN']}}),/capacity/,'the LB still occupies a roster spot');
  assert.throws(()=>analyze({...lbOnly,catalog:{...lbOnly.catalog,lb1:{position:'OL',team:'A',full_name:'lb1'}}}),/Unknown roster player position/,'an unknown position still refuses');
});
group('an unknown starting slot refuses: Unsupported roster slots',()=>{
  for(const slot of ['OL','XFLEX','BN_FLEX']) assert.throws(()=>analyze({...base,league:{...league,roster_positions:['RB',slot,'BN']}}),{message:'Unsupported roster slots'},slot);
  for(const slots of [['RB','K','DEF','BN','IR','TAXI'],['RB','DL','LB','DB','IDP_FLEX','BN']]) assert.deepEqual(deltas({...base,league:{...league,roster_positions:slots}}),[20,-20],slots.join());
});
group('trade policy: current week skipped; declared bye and user-excluded week are 0; an OUT tag only warns; a p50 of exactly 0 stays 0',()=>{
  const wk1=clone(base);
  for(const p of wk1.remaining.players) p.weeks.unshift({week:1,status:'unmodeled',points:null,reason:'current week'});
  assert.deepEqual(analyze(wk1).weeks.map(w=>w.week),[2,3],'the current week is never read');
  assert.deepEqual(analyze({...base,currentWeek:2}).weeks.map(w=>w.week),[3]);
  const two=clone(base);two.league.roster_positions=['RB','RB','BN'];
  two.remaining.players.find(p=>p.player_id==='ga').weeks[0]={week:2,status:'bye',points:null};
  let out=analyze({...two,excludeWeeks:{b:[3]}});
  const a2=out.weeks[0].sides[0].before.lineup.find(p=>p.id==='a'),b3=out.weeks[1].sides[0].before.lineup.find(p=>p.id==='b');
  assert.deepEqual([a2.points,a2.status],[0,'bye']);
  assert.deepEqual([b3.points,b3.status],[0,'assumed_unavailable']);
  const tagged=analyze({...base,catalog:{...catalog,c:{...catalog.c,injury_status:'OUT'}}});
  assert.deepEqual(tagged.availabilityFlags.map(f=>[f.id,f.status]),[['c','OUT']]);
  assert.deepEqual(tagged.sides.map(s=>s.delta),[20,-20],'an OUT tag is a warning: the player is still scored');
  const zero=clone(base);zero.league.roster_positions=['RB','RB','BN'];
  for(const w of zero.remaining.players.find(p=>p.player_id==='ga').weeks) w.points.league.p50=0;
  out=analyze(zero);
  const a0=out.weeks[0].sides[0].before.lineup.find(p=>p.id==='a');
  assert.deepEqual([a0.points,a0.status],[0,'conditional_projection']);
  assert.equal(out.weeks[0].sides[0].before.total,5);
});
group('missing projection coverage refuses; a missing week row refuses',()=>{
  const gone=clone(base);gone.remaining.players=gone.remaining.players.filter(p=>p.player_id!=='gd');
  assert.throws(()=>analyze(gone),e=>e.name==='ProjectionCoverageError'&&e.coverageIssues.every(x=>x.id==='d'&&/Missing projection or current-team mismatch: d/.test(x.reason)));
  const hole=clone(base);hole.remaining.players.find(p=>p.player_id==='gb').weeks.pop();
  assert.throws(()=>analyze(hole),/Missing\/duplicate projection week/);
});
group('exact kernel tie rule (§8.1): equal scores start the smallest id, whatever the roster order',()=>{
  const tie=clone(base);
  for(const w of tie.remaining.players.find(p=>p.player_id==='gb').weeks) w.points.league.p50=10;
  tie.rosters[0].players=['b','a'];tie.league.roster_positions=['RB','BN','BN'];
  const out=analyze({...tie,give:[],receive:['d'],drops:{}});
  assert.deepEqual(out.weeks[0].sides[0].before.lineup.map(p=>p.id),['a']);
  assert.equal(out.weeks[0].sides[0].before.total,10,'totals are unchanged by the tie rule');
});
// --- adapter-to-trade through the REAL LeagueData.views (astra R2, Review Focus 1) -------------
const STATS=LL.STATS;
const vec=rec=>STATS.map(s=>s==='receptions'?rec:0);
const HDR={season:2026,week:1,data_through:'2026-wk0',generated_at:new Date(now).toISOString(),batch_id:'b1'};
const PEOPLE=[['a','ga',10],['b','gb',5],['c','gc',20],['d','gd',2],['x','gx',30]];
const nbatch={formats:[],evaluation:null,
  weekly:{...HDR,kind:'neutral_weekly',schema_version:1,players:[]},
  remaining:{...HDR,kind:'neutral_remaining',schema_version:2,horizon:'remaining_season',status:'experimental',start_week:1,end_week:3,stat_order:STATS.slice(),
    players:PEOPLE.map(([sid,pid,rec])=>({player_id:pid,team:'A',position:'RB',name:sid,weeks:[2,3].map(week=>({week,status:'conditional_projection',opponent:'Z',stats:[vec(rec*.5),vec(rec),vec(rec*1.5)]}))}))},
  players:{...HDR,kind:'neutral_players',schema_version:1,players:PEOPLE.map(([sid,pid])=>({player_id:pid,sleeper_id:sid,name:sid,team:'A',position:'RB',bye:null,ecr:null,identity_only:sid==='x',reason:sid==='x'?'projection_identity_conflict':null}))}};
const liveCat={...catalog,x:{gsis_id:'gx',position:'RB',team:'A',full_name:'x'}};
const viewOf=cat=>LD.views(nbatch,league,{week:1,catalog:cat});
const viaView=(cat,extra={})=>{const v=viewOf(cat);return analyze({...base,remaining:v.remaining,board:v.board,catalog:cat,...extra});};
const refusedOnly=(id,name)=>e=>{
  assert.equal(e.name,'ProjectionCoverageError');
  assert.deepEqual([...new Set(e.coverageIssues.map(x=>x.id))],[id]);
  assert.ok(e.coverageIssues.every(x=>x.reason===`Missing projection or current-team mismatch: ${name}`),JSON.stringify(e.coverageIssues));
  return true;
};
group('through LeagueData.views: the view prices the same scenario',()=>{
  const v=viewOf(liveCat);
  assert.ok(!('league' in v.remaining)&&!('league' in v.board),'views carry no league contract');
  assert.deepEqual(analyze({...base,remaining:v.remaining,board:v.board,catalog:liveCat}).sides.map(s=>s.delta),[20,-20]);
});
group('through LeagueData.views: an identity-only player whose live catalog carries the matching GSIS is still refused',()=>{
  assert.equal(liveCat.x.gsis_id,nbatch.players.players.find(p=>p.sleeper_id==='x').player_id,'the catalog "repairs" x');
  assert.ok(nbatch.remaining.players.some(p=>p.player_id==='gx'),'and the batch has a projection for that GSIS');
  assert.ok(!viewOf(liveCat).board.players.some(p=>p.sleeper_id==='x'),'x is not on the scorable board');
  const lg={...league,roster_positions:['RB','BN','BN']};
  assert.throws(()=>viaView(liveCat,{league:lg,rosters:[{roster_id:1,players:['a','b','x']},base.rosters[1]]}),refusedOnly('x','x'));
});
group('through LeagueData.views: a published player whose GSIS a second live Sleeper id also claims is refused (gsis_ambiguous)',()=>{
  const twin={...liveCat,other:{...catalog.a,full_name:'other'}};
  assert.deepEqual(viewOf(twin).excluded.map(x=>[x.sleeper_id,x.reason]),[['a','gsis_ambiguous']]);
  assert.throws(()=>viaView(twin),refusedOnly('a','a'));
});
group('Review Focus 1 through LeagueData.views: a player traded after the batch is refused, never scored for his old team',()=>{
  const moved={...liveCat,a:{...catalog.a,team:'B'}};
  const v=viewOf(moved);
  assert.equal(v.board.players.find(p=>p.sleeper_id==='a').team,'A','the view keeps the projection team');
  assert.throws(()=>viaView(moved),refusedOnly('a','a'));
});
if(groupFails.length){console.log(`FAILED (${groupFails.length}):\n  `+groupFails.join('\n  '));process.exit(1);}
// --- legacy cases, kept ------------------------------------------------------------
let out=analyze(base);
assert.deepEqual(out.sides.map(s=>s.delta),[20,-20]);
assert.equal(out.advice_eligible,false);
assert.deepEqual(out.weeks.map(w=>w.week),[2,3]);
assert.deepEqual(base,original);
assert.deepEqual(analyze({...base,catalog:{...catalog,a:{...catalog.a,gsis_id:' ga '}}}).sides,out.sides);
// The view's board is the identity: a catalog without GSIS ids prices the same players.
assert.deepEqual(analyze({...base,catalog:Object.fromEntries(Object.entries(catalog).map(([id,c])=>[id,{...c,gsis_id:null}]))}).sides,out.sides);
out=analyze({...base,excludeWeeks:{c:[2]}});
assert.deepEqual(out.sides.map(s=>s.delta),[5,-2]); // unavailable c also changes partner's baseline
for(const change of [{assumeAvailable:false},{snapshotAt:now-60001},{currentWeek:3},{give:['d']},{give:['a','a']},
  {receive:['c','d']},{remaining:{...remaining,season:2025}},
  {remaining:{...remaining,generated_at:'2026-01-01'}},{drops:{1:['c']}},{drops:{3:['b']}}]) assert.throws(()=>analyze({...base,...change}));
out=analyze({...base,give:['a','b'],drops:{2:['d']}});
assert.equal(out.weeks.length,2);
assert.throws(()=>analyze({...base,give:['a','b']}),/capacity/);
const bad=clone(base);bad.remaining.players[0].weeks[0].status='unmodeled';
assert.throws(()=>analyze(bad),/unknown is not zero/);
bad.remaining.players[0].weeks[0].status='bye';
assert.doesNotThrow(()=>analyze(bad));
assert.throws(()=>analyze({...base,catalog:{...catalog,a:{...catalog.a,team:'B'}}}),/Missing projection or current-team mismatch: a/);
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
  superflex.board.players.find(p=>p.sleeper_id===id).position='QB';
}
out=analyze(superflex);
assert.equal(out.weeks[0].sides[0].before.total,15);
assert.equal(out.weeks[0].sides[0].after.total,25);
assert.equal(out.weeks[0].sides[0].before.lineup[1].position,'QB');
assert.deepEqual(analyze({...base,currentWeek:2}).weeks.map(w=>w.week),[3]);
assert.throws(()=>analyze({...base,board:{...identityBoard,season:2025}}),/Identity board season mismatch/);
assert.throws(()=>analyze({...base,catalog:{...catalog,a:{...catalog.a,gsis_id:'different'}}}),/identity disagreement/);
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
// Explicit exclusions can cover an unmodeled week but never repair identity: a player the
// view's board does not map stays refused even with every week excluded.
assert.doesNotThrow(()=>analyze({...gaps,excludeWeeks:{a:[2,3],d:[2,3]}}));
assert.throws(()=>analyze({...gaps,board:{...identityBoard,players:identityBoard.players.filter(p=>p.sleeper_id!=='a')},excludeWeeks:{a:[2,3],d:[2,3]}}),/Missing projection or current-team mismatch: a/);
// --- consensus cases ---------------------------------------------------------
// 2-for-1 with the explicit drop on the RECEIVING side: roster 2 takes a and b for c,
// must drop d to fit, and d's contribution counts against the trade for roster 2.
{
  const two = clone(base);
  two.league.roster_positions = ['RB', 'RB', 'BN'];            // capacity 3, two starters
  two.rosters = [{ roster_id: 1, players: ['a', 'b', 'e'] }, { roster_id: 2, players: ['c', 'd', 'f'] }];
  two.catalog = { ...catalog, e: { gsis_id: 'ge', position: 'RB', team: 'A', full_name: 'e' }, f: { gsis_id: 'gf', position: 'RB', team: 'A', full_name: 'f' } };
  const v2 = { ...value, e: 1, f: 3 };
  two.board.players.push(...['e', 'f'].map(id => ({ sleeper_id: id, player_id: 'g' + id, position: 'RB' })));
  two.remaining.players = Object.keys(two.catalog).map(id => ({ player_id: 'g' + id, team: 'A', position: 'RB', weeks: [2, 3].map(week => ({ week, status: 'conditional_projection', points: { league: { p50: v2[id] } } })) }));
  two.give = ['a', 'b']; two.receive = ['c'];
  assert.throws(() => analyze(two), /capacity/, 'roster 2 would hold four with a three-man capacity');
  const out2 = analyze({ ...two, drops: { 2: ['d'] } });
  // roster 1 before: a10+b5=15 → after: c20+e1=21 (+6/wk); roster 2 before: c20+f3=23 → after: a10+b5=15 (−8/wk), d gone.
  assert.deepEqual(out2.weeks.map(w => w.sides.map(s => s.delta)), [[6, -8], [6, -8]]);
  assert.deepEqual(out2.sides.map(s => s.delta), [12, -16]);
  assert.throws(() => analyze({ ...two, drops: { 2: ['c'] } }), /retained owned player, not trade asset/);
}
// Scarce position: the only TE on a roster cannot be traded away without a replacement.
{
  const te = clone(base);
  te.league.roster_positions = ['RB', 'TE', 'BN'];
  te.catalog = { ...catalog, t: { gsis_id: 'gt', position: 'TE', team: 'A', full_name: 't' } };
  te.board.players.push({ sleeper_id: 't', player_id: 'gt', position: 'TE' });
  te.rosters = [{ roster_id: 1, players: ['a', 't'] }, { roster_id: 2, players: ['c', 'd'] }];
  te.remaining.players.push({ player_id: 'gt', team: 'A', position: 'TE', weeks: [2, 3].map(week => ({ week, status: 'conditional_projection', points: { league: { p50: 7 } } })) });
  te.give = ['t']; te.receive = ['d'];
  assert.throws(() => analyze(te), /cannot fill required TE slot/);
}
// A bye and an exclusion in the same week are both zero, labeled differently.
// Corrected from the brief's draft: with only one RB slot (the base league) the
// solver benches whichever player scores less, so a 0-point bye/excluded player
// never surfaces in `lineup`, and roster 2's own pre-trade total also drops --
// excluding c zeroes it on BOTH sides that reference it (already established
// above: "unavailable c also changes partner's baseline"). Two RB slots, matching
// each side's exact headcount, forces every player into the lineup so both
// statuses are directly observable instead of one being silently benched.
{
  const bye = clone(base);
  bye.league.roster_positions = ['RB', 'RB', 'BN'];
  bye.remaining.players.find(p => p.player_id === 'ga').weeks[0] = { week: 2, status: 'bye', points: null };
  const outBye = analyze({ ...bye, excludeWeeks: { c: [2] } });
  const wk2 = outBye.weeks[0];
  assert.equal(wk2.week, 2);
  // roster 1 before: a(bye,0)+b5=5 → after: b5+c(excluded,0)=5, delta 0.
  // roster 2 before: c(excluded,0)+d2=2 → after: d2+a(bye,0)=2, delta 0.
  assert.deepEqual(wk2.sides.map(s => s.delta), [0, 0]);
  assert.equal(wk2.sides[0].after.lineup.find(p => p.id === 'c').status, 'assumed_unavailable');
  assert.equal(wk2.sides[1].after.lineup.find(p => p.id === 'a').status, 'bye');
}
// Duplicate week rows are a contract violation, not a silent double count.
{
  const dup = clone(base);
  const p = dup.remaining.players.find(p => p.player_id === 'ga');
  p.weeks.push({ ...p.weeks[0] });
  assert.throws(() => analyze(dup), /Missing\/duplicate projection week/);
}
// --- simulate: same resolution as analyze, seeded season simulation ------------
{
  const {simulate}=require('../site/assets/seasontrade.js');
  const A={p_out:{QB:.05,RB:.08,WR:.07,TE:.06},p_stay:{QB:.4,RB:.5,WR:.45,TE:.4},p_tag:{Out:.95,Doubtful:.8,Questionable:.2,IR:.98}};
  const q=v=>({p50:v,p10:v*.6,p90:v*1.5});
  const withFA=clone(base);
  // Two free agents (in the catalog and the projections, on no roster); the pool
  // alone must fill the single RB slot every week.
  for(const [id,v] of [['e',3],['f',1]]) {
    withFA.catalog[id]={gsis_id:'g'+id,position:'RB',team:'A',full_name:id};
    withFA.remaining.players.push({player_id:'g'+id,team:'A',position:'RB',weeks:[2,3].map(week=>({week,status:'conditional_projection',points:{league:q(v)}}))});
  }
  for(const p of withFA.remaining.players) if(['ga','gb','gc','gd'].includes(p.player_id)) for(const w of p.weeks) w.points={league:q(w.points.league.p50)};
  const args={...withFA,availability:A,seed:7,nSims:400};
  const s1=simulate(args);
  assert.deepEqual(s1.weeks,[2,3]);
  assert.equal(s1.nSims,400);
  assert.equal(s1.sides.length,2);
  for(const s of s1.sides) {
    for(const k of ['mean','p10','p90','pPositive']) assert.ok(Number.isFinite(s[k]),k);
    assert.equal(s.perWeek.length,2);assert.ok(s.perWeek.every(Number.isFinite));
    assert.ok(s.p10<=s.mean&&s.mean<=s.p90);
  }
  assert.deepEqual(s1.sides.map(s=>s.rosterId),[1,2]);
  assert.ok(s1.sides[0].mean>0&&s1.sides[1].mean<0,'a for c: gain for roster 1, the reverse for roster 2');
  assert.ok(Math.abs(s1.sides[0].perWeek.reduce((x,y)=>x+y,0)-s1.sides[0].mean)<1e-6,'per-week means add up to the mean');
  assert.deepEqual(simulate(args),s1,'same seed and inputs, same numbers');
  assert.notEqual(simulate({...args,seed:8}).sides[0].mean,s1.sides[0].mean);
  // the analyze contract is untouched by the shared resolution
  assert.deepEqual(analyze(withFA).sides.map(s=>s.delta),[20,-20]);
  // explicit free-agent ids override the derived pool; an empty pool cannot fill the slot
  assert.deepEqual(simulate({...args,freeAgents:['ge','gf']}),s1,'derived pool = e and f');
  assert.throws(()=>simulate({...args,freeAgents:[]}),e=>e.name==='RosterSimError'&&/no replacement/.test(e.message));
  // a rostered player's id in freeAgents is excluded, never admitted as a second copy of himself
  assert.throws(()=>simulate({...args,freeAgents:['ga']}),e=>e.name==='RosterSimError'&&/no replacement/.test(e.message));
  assert.deepEqual(simulate({...args,freeAgents:['ga','ge','gf']}),s1,'rostered ga dropped from the override');
  // rostered players are never free agents: with nobody else projected, no replacement
  const noFA=clone(base);
  for(const p of noFA.remaining.players) for(const w of p.weeks) w.points={league:q(w.points.league.p50)};
  assert.throws(()=>simulate({...noFA,availability:A}),e=>e.name==='RosterSimError'&&/no replacement/.test(e.message));
  // coverage gaps block exactly as analyze does, before any simulation
  const gap=clone(args);gap.remaining.players.find(p=>p.player_id==='ga').weeks[0].status='unmodeled';
  assert.throws(()=>simulate(gap),e=>e.name==='ProjectionCoverageError');
  // identity failures are analyze's, verbatim: a rostered player the board does not map is refused
  assert.throws(()=>simulate({...args,board:{...args.board,players:args.board.players.filter(p=>p.sleeper_id!=='a')}}),e=>e.name==='ProjectionCoverageError'&&/Missing projection or current-team mismatch: a/.test(e.message));
  assert.throws(()=>simulate({...args,assumeAvailable:false}),/conditional-availability/);
  // a missing availability table is a loud RosterSimError, never a default
  assert.throws(()=>simulate({...args,availability:undefined}),e=>e.name==='RosterSimError'&&/availability/.test(e.message));
  // user-marked weeks feed forcedOut: c out both weeks removes his gain
  const forced=simulate({...args,excludeWeeks:{c:[2,3]}});
  assert.ok(forced.sides[0].mean<s1.sides[0].mean-5,'an excluded incoming player adds far less');
  // reported tags reach the simulation: an IR-tagged c is mostly out early
  const tagged=simulate({...args,catalog:{...args.catalog,c:{...args.catalog.c,injury_status:'IR'}}});
  assert.ok(tagged.sides[0].mean<s1.sides[0].mean-3,'IR tag lowers first-week availability');
}
// Review M4: the replacement pool is sized like the waiver desk's and the backtest's, SUPER_FLEX included.
// Review M6: a status other than a forced week, bye or conditional_projection is an error, never a bye.
{
  const ST=require('../site/assets/seasontrade.js');
  const RS=require('../site/assets/rostersim.js');
  const fails=[];
  const nc=(name,fn)=>{try{fn();}catch(e){e.message=`${name}: ${e.message}`;if(process.env.FIXTURE_ALL){fails.push(e.message.split('\n')[0]);return;}throw e;}};
  nc('replacementNeeds sizes the pool from the slots, SUPER_FLEX included (M4)',()=>{
    assert.equal(typeof ST.replacementNeeds,'function');
    assert.deepEqual(ST.replacementNeeds(['QB','RB','RB','WR','WR','TE','FLEX','FLEX']),{QB:1,RB:4,WR:4,TE:3});
    assert.deepEqual(ST.replacementNeeds(['QB','RB','RB','WR','WR','TE','FLEX','FLEX','SUPER_FLEX']),{QB:2,RB:5,WR:5,TE:4});
    assert.deepEqual(ST.replacementNeeds(['RB','SUPER_FLEX']),{QB:1,RB:2,WR:1,TE:1});
  });
  nc('simRow: forced weeks and byes are byes, a projection plays, anything else throws (M6)',()=>{
    assert.equal(typeof ST.simRow,'function');
    assert.deepEqual(ST.simRow({week:2,status:'bye'},false),{status:'bye'});
    assert.deepEqual(ST.simRow({week:2,status:'conditional_projection',points:{league:{p10:1,p50:2,p90:3}}},true),{status:'bye'},'a forced week is a bye');
    assert.deepEqual(ST.simRow({week:2,status:'conditional_projection',points:{league:{p10:1,p50:2,p90:3}}},false),{status:'play',p10:1,p50:2,p90:3});
    assert.throws(()=>ST.simRow({week:2,status:'unmodeled'},false),e=>e instanceof RS.RosterSimError||e.name==='RosterSimError');
    assert.deepEqual(ST.simRow({week:2,status:'unmodeled'},true),{status:'bye'},'a forced-out week never needed the row');
  });
  if(fails.length){console.log(`FAILED (${fails.length}):\n  `+fails.join('\n  '));process.exit(1);}
}
console.log('seasontrade_fixture: OK');
