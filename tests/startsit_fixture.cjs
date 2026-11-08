// Start/sit engine (StartSit.analyze): any-league phase 1 (spec §7.1 start/sit
// policy, §6.1 projection-UI slots, §8.2 / §8.12). The lineup comes from the
// exact kernel (Lineup.solve); every per-player rule is today's. Contract
// comparisons with a published league are gone (spec §5.3, §8.7). League and
// roster data are synthetic (fictional ids); real NFL teams are not used.
const assert=require('node:assert/strict'),S=require('../site/assets/startsit.js');
const Lineup=require('../site/assets/lineup.js'),LD=require('../site/assets/leaguedata.js'),LL=require('../site/assets/leaguelens.js');
const now=Date.parse('2026-09-09T12:00:00Z');
const positions=['QB','RB','RB','WR','WR','TE','FLEX','FLEX','K','DEF'];
const ps=['QB','RB','RB','WR','WR','TE','WR','RB','K','DEF','QB','TE','RB'];
const values=[20,12,11,18,17,9,16,8,0,0,21,8,13];
const catalog=Object.fromEntries(ps.map((position,i)=>[String(i+1),{position,full_name:`P${i+1}`,team:'A'}]));
const board={players:ps.map((position,i)=>({sleeper_id:String(i+1),player_id:`g${i+1}`,position}))};
// Contract-free weekly view: no `league` block (spec §5.3).
const weekly={season:2026,week:1,generated_at:new Date(now).toISOString(),players:values.map((v,i)=>({player_id:`g${i+1}`,team:'A',points:{league:{p50:v,p10:v-5,p90:v+5}}}))};
const league={league_id:'L',season:'2026',scoring_settings:{pass_td:6},roster_positions:[...positions,'BN','BN','BN']};
const roster={players:ps.map((_,i)=>String(i+1)),starters:ps.slice(0,10).map((_,i)=>String(i+1))};
const kickoffs={season:2026,week:1,generated_at:new Date(now).toISOString(),teams:['A','B'],games:[{home:'A',away:'B',kickoff:new Date(now+3600000).toISOString()}]};
const base={board,weekly,league,roster,catalog,kickoffs,now};
const ids=r=>r.lineup.map(p=>p.id);
let r=S.analyze(base);
assert.equal(r.lineup[0].id,'11');assert.equal(r.lineup[8].id,'9');assert.equal(r.lineup[9].id,'10');
assert.ok(r.lineup.some(p=>p.id==='13'));assert.equal(new Set(ids(r)).size,10);
assert.equal(r.bench.find(p=>p.id==='1').close,true);assert.equal(r.bench.find(p=>p.id==='1').gap,1);
assert.equal(r.lineup[8].unmodeled,true);assert.equal(r.lineup[8].name,'P9');assert.equal(r.lineup[8].changed,false);
assert.ok(!('total' in r),'start/sit reports no lineup total');
r=S.analyze({...base,now:now+7200000});assert.deepEqual(ids(r),roster.starters);
assert.ok(r.bench.every(p=>p.locked));
assert.throws(()=>S.analyze({...base,now:now+7200000,snapshotAt:now}),/A game started since the roster was loaded\. Refresh to capture actual locked slots\./);
r=S.analyze({...base,excludeIds:['11']});assert.equal(r.lineup[0].id,'1');
// Injury tags: OUT/IR/SUSPENDED/PUP/DOUBTFUL (any case) sit; anything else plays with a warning.
for (const tag of ['Out','IR','Suspended','PUP','Doubtful']) {
  r=S.analyze({...base,catalog:{...catalog,11:{...catalog[11],injury_status:tag}}});
  assert.equal(r.lineup[0].id,'1',tag);assert.ok(r.warnings.includes(`P11: ${tag} — verify current report`));
  assert.equal(r.bench.find(p=>p.id==='11').eligible,false);
}
r=S.analyze({...base,catalog:{...catalog,11:{...catalog[11],injury_status:'Questionable'}}});
assert.equal(r.lineup[0].id,'11');assert.ok(r.warnings.includes('P11: Questionable — verify current report'));
// Audit A6-3: an unlocked, available player without a projection no longer
// refuses the plan. He is treated as unavailable (not a candidate, 0 points)
// and named in one note. The engine takes no role: a viewer passes no
// exclusions (excludeIds []), so owner and viewer get the same plan.
const UNPROJECTED = n => `Not projected this week: ${n} — treated as unavailable.`;
const noG = (...pids) => ({...weekly,players:weekly.players.filter(p=>!pids.includes(p.player_id))});
r=S.analyze({...base,weekly:noG('g11')});
assert.equal(r.lineup[0].id,'1','the projected QB starts instead');
assert.deepEqual(r.notes,[UNPROJECTED('P11')]);
assert.deepEqual((({eligible,unprojected,points})=>({eligible,unprojected,points}))(r.bench.find(p=>p.id==='11')),{eligible:false,unprojected:true,points:null});
// ...an unprojected BENCH player, unexcluded (the owner did not tick him; a
// viewer cannot): same plan as with him projected, plus the note.
// startsitmode_session_fixture pins that both roles render the notes.
r=S.analyze({...base,weekly:noG('g12'),excludeIds:[]});
assert.deepEqual(ids(r),ids(S.analyze(base)));
assert.deepEqual(r.notes,[UNPROJECTED('P12')]);
// Several are named once, in roster order.
assert.deepEqual(S.analyze({...base,weekly:noG('g13','g12')}).notes,[UNPROJECTED('P12, P13')]);
// Excluded / unavailable / bye players without projections are not news: no note.
r=S.analyze({...base,weekly:noG('g11'),excludeIds:['11']});assert.equal(r.lineup[0].id,'1');assert.deepEqual(r.notes,[]);
r=S.analyze({...base,weekly:noG('g11'),catalog:{...catalog,11:{...catalog[11],injury_status:'IR'}}});assert.equal(r.lineup[0].id,'1');assert.deepEqual(r.notes,[]);
assert.deepEqual(S.analyze(base).notes,[],'a fully projected roster has no notes');
// Wrong-team projection (traded after the batch, Review Focus 1): counts as missing -> unavailable, named; never scored for his old team.
const traded={...base,catalog:{...catalog,11:{...catalog[11],team:'B'}}};
r=S.analyze(traded);assert.ok(!ids(r).includes('11'));assert.deepEqual(r.notes,[UNPROJECTED('P11')]);
r=S.analyze({...traded,excludeIds:['11']});assert.ok(!ids(r).includes('11'));assert.deepEqual(r.notes,[]);
// A position-changed board entry (catalog now says RB, projection is a QB's) counts as missing.
r=S.analyze({...base,catalog:{...catalog,11:{...catalog[11],position:'RB'}}});assert.ok(!ids(r).includes('11'));assert.deepEqual(r.notes,[UNPROJECTED('P11')]);
// No NFL team (a released player, catalog team null): unavailable and named, never "Unknown team/schedule" (A6-3).
const teamless={...base,catalog:{...catalog,13:{...catalog[13],team:null}}};
r=S.analyze(teamless);assert.ok(!ids(r).includes('13'));assert.deepEqual(r.notes,[UNPROJECTED('P13')]);
assert.deepEqual((({bye,kickoff,eligible})=>({bye,kickoff,eligible}))(r.bench.find(p=>p.id==='13')),{bye:false,kickoff:null,eligible:false},'teamless is not a bye');
// ...and ticking him as excluded clears the note too (exclusions apply before the team check).
r=S.analyze({...teamless,excludeIds:['13']});assert.ok(!ids(r).includes('13'));assert.deepEqual(r.notes,[]);
// A team the schedule does not know is broken coverage: still refused by name, unless the user excluded him.
const offSchedule={...base,catalog:{...catalog,13:{...catalog[13],team:'Q'}}};
assert.throws(()=>S.analyze(offSchedule),/^Error: Unknown team\/schedule for P13\.$/);
r=S.analyze({...offSchedule,excludeIds:['13']});assert.ok(!ids(r).includes('13'));
// No contract checks: a scoring the batch never saw and a weekly without `league` both pass (spec §8.7).
r=S.analyze({...base,league:{...league,scoring_settings:{pass_td:4,rec:0.5,bonus_fd_wr:0.5}}});assert.equal(r.lineup[0].id,'11');
// Season/week and age checks: verbatim.
assert.throws(()=>S.analyze({...base,kickoffs:{...kickoffs,week:2}}),/Schedule\/projection season or week mismatch\./);
assert.throws(()=>S.analyze({...base,weekly:{...weekly,season:2025}}),/season or week mismatch/);
assert.throws(()=>S.analyze({...base,now:now+8*86400000}),/seven days/);
assert.doesNotThrow(()=>S.analyze({...base,now:now+7*86400000-3600000,snapshotAt:now+7*86400000-3600000}));
assert.throws(()=>S.analyze({...base,kickoffs:{...kickoffs,generated_at:new Date(now-7*86400000-1).toISOString()}}),/Projection or schedule snapshot is over seven days old; refresh required\./);
assert.throws(()=>S.analyze({...base,weekly:{...weekly,generated_at:new Date(now-7*86400000-1).toISOString()}}),/over seven days old/);
assert.throws(()=>S.analyze({...base,weekly:{...weekly,generated_at:new Date(now+3600001).toISOString()}}),/over seven days old/,'more than an hour in the future');
assert.throws(()=>S.analyze({...base,kickoffs:{...kickoffs,games:[{home:'A',away:'B',kickoff:null}]}}),/Invalid kickoff/);
r=S.analyze({...base,roster:{...roster,reserve:['13']}});assert.ok(!ids(r).includes('13'));
r=S.analyze({...base,roster:{...roster,taxi:['13']}});assert.ok(!ids(r).includes('13'));
// A locked FLEX cannot be moved into an RB slot to admit another receiver.
const mixed={...base,catalog:{...catalog,8:{...catalog[8],team:'C'}},weekly:{...weekly,players:weekly.players.map(p=>p.player_id==='g8'?{...p,team:'C'}:p)},
 kickoffs:{...kickoffs,teams:['A','B','C','D'],games:[...kickoffs.games,{home:'C',away:'D',kickoff:new Date(now-1000).toISOString()}]}};
r=S.analyze(mixed);assert.equal(r.lineup[7].id,'8');assert.ok(r.lineup[7].locked);
// A locked starter without a projection stays fixed in his slot (no refusal, no score).
r=S.analyze({...mixed,weekly:{...mixed.weekly,players:mixed.weekly.players.filter(p=>p.player_id!=='g8')}});
assert.equal(r.lineup[7].id,'8');assert.ok(r.lineup[7].locked);assert.equal(r.lineup[7].points,null);
// A locked player in a slot he is not eligible for refuses.
assert.throws(()=>S.analyze({...mixed,roster:{...roster,starters:roster.starters.map((id,i)=>i===0?'8':i===7?'1':id)}}),/^Error: Locked player is in an incompatible slot\.$/);
// Equivalent WR slots must not suggest gratuitous changes.
r=S.analyze({...base,roster:{...roster,starters:roster.starters.map((id,i)=>i===3?'5':i===4?'4':id)}});
assert.equal(r.lineup[3].id,'5');assert.equal(r.lineup[4].id,'4');assert.equal(r.lineup[3].changed,false);
// ---- audit A6-2: an unfillable slot is left empty; the rest of the plan stands ----------
const EMPTY = slot => `No available ${slot} this week — add one from waivers.`;
const emptySlot = (r,i) => (({id,name,empty,points,note})=>({id,name,empty,points,note}))(r.lineup[i]);
// No eligible, projected player left for the QB slot (both excluded): QB empty, every other slot planned.
r=S.analyze({...base,excludeIds:['1','11']});
assert.deepEqual(emptySlot(r,0),{id:null,name:'Empty',empty:true,points:null,note:EMPTY('QB')});
assert.equal(r.lineup[0].changed,true,'the current QB leaves the slot');
assert.deepEqual(ids(r).slice(1),ids(S.analyze(base)).slice(1),'RB/WR/TE/FLEX advice is unchanged');
assert.deepEqual(r.notes,['1 empty slot scores 0 in this plan.']);
assert.ok(!('total' in r),'still no lineup total (spec §7.1)');
// Sole QB tagged Out (the only QB on the roster).
{
  const players=roster.players.filter(id=>id!=='1'), starters=['11',...roster.starters.slice(1)];
  r=S.analyze({...base,roster:{players,starters},catalog:{...catalog,11:{...catalog[11],injury_status:'Out'}}});
  assert.deepEqual(emptySlot(r,0),{id:null,name:'Empty',empty:true,points:null,note:EMPTY('QB')});
  assert.ok(r.lineup.slice(1,8).every(p=>!p.empty&&p.points),'every RB/WR/TE/FLEX slot is planned');
  assert.equal(r.bench.find(p=>p.id==='11').eligible,false);
  assert.deepEqual(r.notes,['1 empty slot scores 0 in this plan.']);
}
// Sole TE on bye (team C has no game): TE empty; the two FLEX slots are filled from the remaining RB/WR, as before.
{
  const players=roster.players.filter(id=>id!=='12');
  const cat={...catalog,6:{...catalog[6],team:'C'}};
  const ko={...kickoffs,teams:['A','B','C']};
  r=S.analyze({...base,roster:{...roster,players},catalog:cat,kickoffs:ko});
  assert.deepEqual(emptySlot(r,5),{id:null,name:'Empty',empty:true,points:null,note:EMPTY('TE')});
  assert.deepEqual(r.lineup.slice(6,8).map(p=>[p.slot,p.empty||false,!!p.points]),[['FLEX',false,true],['FLEX',false,true]]);
  assert.equal(r.bench.find(p=>p.id==='6').bye,true);
  assert.deepEqual(r.notes,['1 empty slot scores 0 in this plan.']);
  // The plan's sum: the empty slot contributes 0.
  const sum=r.lineup.reduce((s,p)=>s+(p.points?.p50||0),0);
  const solved=Lineup.solve({slots:positions,candidates:players.filter(id=>!['6','9','10'].includes(id)).map(id=>({id,position:catalog[id].position,score:values[Number(id)-1]})),
    fixed:{8:{id:'9'},9:{id:'10'}},current:roster.starters,allowEmpty:true});
  assert.equal(sum,solved.total);
}
// A FLEX goes empty only when NO eligible player remains: one RB, nothing else, for RB + FLEX -> the RB slot is filled, FLEX empty.
{
  const lg={...league,roster_positions:['RB','FLEX','BN']};
  r=S.analyze({...base,league:lg,roster:{players:['2'],starters:['2','0']}});
  assert.deepEqual(r.lineup.map(p=>[p.slot,p.id]),[['RB','2'],['FLEX',null]]);
  assert.equal(r.lineup[1].note,EMPTY('FLEX'));assert.equal(r.lineup[1].changed,false,'an already-empty slot that stays empty is unchanged');
  r=S.analyze({...base,league:lg,roster:{players:[],starters:['0','0']}});
  assert.deepEqual(r.notes,['2 empty slots score 0 in this plan.']);
}
// ---- audit A6-7: an empty K/DEF starter slot ("0" from Sleeper) reads "Empty" ----------
r=S.analyze({...base,roster:{...roster,starters:roster.starters.map((id,i)=>i===8?'0':id)}});
assert.deepEqual([r.lineup[8].slot,r.lineup[8].id,r.lineup[8].name,r.lineup[8].unmodeled],['K','0','Empty',true]);

// ---- projection-UI slots (spec §6.1) ----------------------------------------------
assert.throws(()=>S.analyze({...base,league:{...league,roster_positions:['QB','XFLEX','BN']}}),/^Error: Unsupported lineup slot: XFLEX$/);
r=S.analyze({...base,league:{...league,roster_positions:[...positions,'BN','BN','BN','BN','BN','IR','TAXI']}});
assert.equal(r.lineup.length,10,'BN x5, IR and TAXI are accepted and never lineup slots');
// IDP pass-through: occupants kept, capacity counted, never projected; an empty IDP slot stays empty.
{
  const idpPos=['QB','RB','WR','TE','FLEX','DL','LB','DB','IDP_FLEX','K'];
  const cat={...catalog,d1:{position:'DL',full_name:'Line One',team:'A'},l1:{position:'LB',full_name:'Backer One',team:'A'},b1:{position:'DB',full_name:'Corner One',team:'A'}};
  const ro={players:['1','2','4','6','13','d1','l1','b1','9'],starters:['1','2','4','6','13','d1','l1','b1','0','9']};
  r=S.analyze({...base,catalog:cat,roster:ro,league:{...league,roster_positions:[...idpPos,'BN']}});
  assert.deepEqual(r.lineup.slice(5).map(p=>[p.slot,p.id,p.unmodeled,p.changed]),[['DL','d1',true,false],['LB','l1',true,false],['DB','b1',true,false],['IDP_FLEX','0',true,false],['K','9',true,false]]);
  assert.equal(r.lineup[5].name,'Line One');
  assert.equal(r.lineup[4].id,'13');
}

// ---- kernel equivalence: SUPER_FLEX / WRRB_FLEX / REC_FLEX (spec §7.1) -------------
{
  const slotsX=['QB','RB','WR','TE','SUPER_FLEX','WRRB_FLEX','REC_FLEX','FLEX','K'];
  const pool=['QB','QB','QB','RB','RB','RB','RB','WR','WR','WR','WR','TE','TE','TE','K'];
  const cat=Object.fromEntries(pool.map((position,i)=>[`x${i}`,{position,full_name:`X${i}`,team:'A'}]));
  const brd={players:pool.map((position,i)=>({sleeper_id:`x${i}`,player_id:`gx${i}`,position}))};
  let seed=7;
  const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%3000/100;};
  for(let trial=0;trial<40;trial++){
    const v=pool.map(()=>rnd());
    const wk={...weekly,players:pool.map((_,i)=>({player_id:`gx${i}`,team:'A',points:{league:{p50:v[i],p10:v[i]-3,p90:v[i]+3}}}))};
    const starters=['x0','x3','x7','x11','x1','x4','x8','x5','x14'];
    const res=S.analyze({...base,board:brd,weekly:wk,catalog:cat,roster:{players:pool.map((_,i)=>`x${i}`),starters},league:{...league,roster_positions:[...slotsX,'BN','BN']}});
    const solved=Lineup.solve({slots:slotsX,candidates:pool.map((position,i)=>({id:`x${i}`,position,score:v[i]})).filter(c=>c.position!=='K'),fixed:{8:{id:'x14'}},current:starters});
    assert.ok(solved.ok);
    assert.deepEqual(ids(res),solved.assignment.map(a=>a.id),`trial ${trial}: lineup equals Lineup.solve`);
    assert.deepEqual(res.lineup.map(p=>p.changed),solved.assignment.map((a,i)=>a.id!==starters[i]));
  }
}

// ---- §8.12 duplicate occupants --------------------------------------------------------
assert.throws(()=>S.analyze({...base,roster:{...roster,starters:roster.starters.map((id,i)=>i===4?'4':id)}}),/Duplicate roster\/starter identity\./);
// A skill player sitting in an unmodeled slot is reserved there: today's code
// could also start him at WR (one player in two slots); the kernel never does.
{
  const ro={...roster,starters:['1','2','3','5','7','6','13','8','4','10']};
  r=S.analyze({...base,roster:ro});
  assert.equal(ids(r).filter(id=>id==='4').length,1,'never placed in two slots');
  assert.equal(r.lineup[8].id,'4');assert.equal(r.lineup[8].unmodeled,true);
  assert.ok(!r.bench.some(p=>p.id==='4'),'a reserved unmodeled-slot occupant is not a bench candidate');
  // Same in an IDP slot: a WR worth 18 in a DB slot is never listed with a negative gap.
  r=S.analyze({...base,roster:{...roster,starters:['1','2','3','5','7','6','13','8','4','10']},league:{...league,roster_positions:['QB','RB','RB','WR','WR','TE','FLEX','FLEX','DB','DEF','BN','BN','BN']}});
  assert.ok(!r.bench.some(p=>p.id==='4'));assert.ok(r.bench.every(p=>p.gap===null||p.gap>=0));
  // With no other WR-eligible player left, the WR slots stay empty (A6-2) instead of double-placing him;
  // the one remaining RB fills one FLEX, the other FLEX is empty too.
  const thin={...base,roster:{players:['1','2','3','4','6','8','9','10'],starters:['1','2','3','0','0','6','0','0','4','10']},league:{...league,roster_positions:['QB','RB','RB','WR','WR','TE','FLEX','FLEX','K','DEF']}};
  r=S.analyze(thin);
  assert.equal(ids(r).filter(id=>id==='4').length,1,'never placed in two slots');
  assert.deepEqual(r.lineup.map(p=>p.empty?`${p.slot}:empty`:`${p.slot}:${p.id}`),['QB:1','RB:2','RB:3','WR:empty','WR:empty','TE:6','FLEX:8','FLEX:empty','K:4','DEF:10']);
  assert.deepEqual(r.notes,['3 empty slots score 0 in this plan.']);
}

// ---- §8.2 raw comparisons -------------------------------------------------------------
// 9.17528 vs 9.17795: both published as 9.18 (a tie today, the current starter
// kept); compared raw, the higher median starts and the gap is the raw gap.
{
  const tie=values.slice();tie[3]=9.17528;tie[6]=9.17795;tie[4]=30;tie[12]=30;tie[1]=30;tie[2]=30;tie[7]=30;
  const wk={...weekly,players:tie.map((v,i)=>({player_id:`g${i+1}`,team:'A',points:{league:{p50:v,p10:v-5,p90:v+5}}}))};
  r=S.analyze({...base,weekly:wk});
  assert.ok(ids(r).includes('7'),'the 9.17795 receiver starts');assert.ok(!ids(r).includes('4'));
  const d=r.bench.find(p=>p.id==='4');
  assert.equal(d.alternative,'P7');assert.ok(Math.abs(d.gap-(9.17795-9.17528))<1e-12);assert.equal(d.close,true);
}

// ---- through the real league views (spec §3.4, Review Focus 1) --------------------------
{
  const HDR={season:2026,week:1,data_through:'2025-wk18',generated_at:new Date(now).toISOString(),batch_id:'b'};
  const sq=yds=>{const o=f=>Object.fromEntries(LL.STATS.map(s=>[s,s==='receiving_yards'?yds*f:0]));return {p10:o(0.5),p50:o(1),p90:o(1.5)};};
  const people=[['v1','00-0000101','QB',200],['v2','00-0000102','WR',150],['v3','00-0000103','WR',120],['v4','00-0000104','RB',90],['v5','00-0000105','TE',60]];
  const batch={formats:[],remaining:null,evaluation:null,
    weekly:{...HDR,kind:'neutral_weekly',schema_version:1,players:people.map(([sid,pid,pos,y])=>({player_id:pid,name:`N${sid}`,team:'A',opponent:'B',position:pos,is_home:true,stat_quantiles:sq(y),points:{ppr:null,half_ppr:null,standard:null}}))},
    players:{...HDR,kind:'neutral_players',schema_version:1,players:people.map(([sid,pid,pos])=>({player_id:pid,sleeper_id:sid,name:`N${sid}`,team:'A',position:pos,bye:null,ecr:null,identity_only:false,reason:null}))}};
  const cat=Object.fromEntries(people.map(([sid,pid,pos])=>[sid,{full_name:`N${sid}`,position:pos,team:'A',gsis_id:pid}]));
  const lg={league_id:'V',season:'2026',status:'in_season',settings:{type:0},scoring_settings:{rec_yd:0.1},roster_positions:['QB','WR','FLEX','BN','BN']};
  const ro={players:['v1','v2','v3','v4','v5'],starters:['v1','v4','v3']};
  const run=c=>{const v=LD.views(batch,lg,{week:1,catalog:c});return S.analyze({board:v.board,weekly:v.weekly,league:lg,roster:ro,catalog:c,kickoffs,now});};
  r=run(cat);
  assert.deepEqual(ids(r),['v1','v2','v3']);assert.equal(r.lineup[1].points.p50,15);assert.equal(r.lineup[1].changed,true);
  // Traded after the batch: the view keeps the projection team, start/sit treats him as unavailable, naming him.
  r=run({...cat,v2:{...cat.v2,team:'B'}});
  assert.ok(!ids(r).includes('v2'),'never scored for his old team');assert.deepEqual(r.notes,['Not projected this week: Nv2 — treated as unavailable.']);
  // Position changed live (WR -> RB): excluded from the view, so missing -> unavailable, named.
  const moved={...cat,v3:{...cat.v3,position:'RB'}};
  assert.equal(LD.views(batch,lg,{week:1,catalog:moved}).excluded[0].reason,'position_changed');
  r=run(moved);assert.ok(!ids(r).includes('v3'));assert.deepEqual(r.notes,['Not projected this week: Nv3 — treated as unavailable.']);
  // ...unless he is locked: a game-started starter stays fixed whether or not he has a projection.
  const lockedK={...kickoffs,teams:['A','B','C','D'],games:[...kickoffs.games,{home:'C',away:'D',kickoff:new Date(now-1000).toISOString()}]};
  const v=LD.views(batch,lg,{week:1,catalog:{...moved,v3:{...moved.v3,team:'C'}}});
  r=S.analyze({board:v.board,weekly:v.weekly,league:lg,roster:{...ro,starters:['v1','v2','v3']},catalog:{...moved,v3:{...moved.v3,team:'C'}},kickoffs:lockedK,now});
  assert.equal(r.lineup[2].id,'v3');assert.ok(r.lineup[2].locked);assert.equal(r.lineup[2].points,null);
}

// Randomized exact-sum oracle, including two FLEX slots.
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
console.log('startsit_fixture: kernel lineups (FLEX/SUPER_FLEX/WRRB_FLEX/REC_FLEX/IDP), unsupported slots, start/sit policies (injuries, exclusions, unprojected/teamless/wrong-team/position-changed players as unavailable, empty slots, empty K, locks, kickoffs, 7-day limits), duplicate occupants and raw near ties OK');
