/* Conditional in-season trade scenarios. No API writes, prices or verdicts. */
(function () {
  "use strict";
  const skill = new Set(["QB","RB","WR","TE"]);
  const eligible = {QB:["QB"],RB:["RB"],WR:["WR"],TE:["TE"],FLEX:["RB","WR","TE"],SUPER_FLEX:["QB","RB","WR","TE"]};
  const team = t => ({LAR:"LA",JAC:"JAX",WSH:"WAS"}[t] || t);
  const require = (ok,msg) => { if (!ok) throw Error(msg); };
  function ids(values,label) {
    require(Array.isArray(values),`${label} must be an array`);
    require(values.every(v => (typeof v==="string" && v.trim()) || (typeof v==="number" && Number.isFinite(v))),`${label} contains invalid identity`);
    const out=values.map(String);
    require(new Set(out).size===out.length,`${label} contains duplicate identity`);
    return out;
  }
  function lineup(players,slots) {
    const available=players.slice().sort((a,b)=>b.points-a.points || a.id.localeCompare(b.id));
    const order=slots.map((slot,i)=>({slot,i})).sort((a,b)=>eligible[a.slot].length-eligible[b.slot].length);
    const chosen=Array(slots.length);
    for (const {slot,i} of order) {
      const index=available.findIndex(p=>eligible[slot].includes(p.position));
      require(index>=0,`Roster cannot fill required ${slot} slot; no replacement score assumed`);
      chosen[i]={...available.splice(index,1)[0],slot};
    }
    return {total:chosen.reduce((n,p)=>n+p.points,0),lineup:chosen};
  }
  function analyze({remaining,league,rosters,catalog,board,rosterIds,give=[],receive=[],drops={},excludeWeeks={},currentWeek,assumeAvailable,now=Date.now(),snapshotAt}) {
    catalog=Object.fromEntries(Object.entries(catalog||{}).map(([id,c])=>[id,{...c,gsis_id:typeof c.gsis_id==="string"?c.gsis_id.trim():null}]));
    require(assumeAvailable===true,"Explicit conditional-availability assumption required");
    require(Number.isFinite(now)&&Number.isFinite(snapshotAt)&&now>=snapshotAt&&now-snapshotAt<=60000,"Roster snapshot stale or invalid; reload");
    require(league?.status==="in_season","In-season league required");
    require(remaining?.schema_version===1&&remaining.horizon==="remaining_season"&&remaining.status==="experimental"&&remaining.evaluation!==undefined,"Experimental remaining-season contract required");
    require(Number.isInteger(currentWeek)&&currentWeek>=1&&currentWeek<=18,"Current NFL week required");
    require(Number.isInteger(remaining.start_week)&&Number.isInteger(remaining.end_week)&&remaining.start_week>=1&&remaining.end_week<=18&&remaining.start_week<=remaining.end_week,"Invalid projection horizon");
    require(String(remaining.league?.league_id)===String(league.league_id)&&league.league_id&&remaining.season===Number(league.season),"Projection league or season mismatch");
    if(board) {
      require(String(board.league?.league_id)===String(league.league_id)&&board.season===remaining.season&&Array.isArray(board.players),"Identity board league/season mismatch");
      require(Array.isArray(rosters)&&Array.isArray(rosterIds),"Roster identities required");
      const identityScope=new Set(rosters.filter(r=>rosterIds.map(String).includes(String(r.roster_id))).flatMap(r=>r.players||[]).map(String));
      catalog={...catalog};
      const sids=new Set(),gsis=new Set();
      for(const p of board.players) if(p.sleeper_id&&p.player_id) {
        const sid=String(p.sleeper_id);
        require(!sids.has(sid)&&!gsis.has(p.player_id),"Duplicate identity board mapping");
        sids.add(sid);gsis.add(p.player_id);
        const c=catalog[sid];
        if(!c||!identityScope.has(sid))continue;
        require(c.position===p.position&&(!c.gsis_id||c.gsis_id===p.player_id),"Catalog/board identity disagreement");
        catalog[sid]={...c,gsis_id:p.player_id};
      }
    }
    const age=now-Date.parse(remaining.generated_at);
    require(Number.isFinite(age)&&age>=0&&age<=72*3600000,"Remaining projections stale or future-dated");
    const expected=remaining.league?.sleeper_scoring,live=league.scoring_settings;
    require(expected&&live&&Object.keys(expected).length&&Object.keys(live).length,"Scoring contract missing");
    for (const k of new Set([...Object.keys(expected),...Object.keys(live)])) {
      const a=Object.hasOwn(expected,k)?expected[k]:0,b=Object.hasOwn(live,k)?live[k]:0;
      require(typeof a==="number"&&Number.isFinite(a)&&typeof b==="number"&&Number.isFinite(b)&&a===b,"Scoring mismatch");
    }
    require(Array.isArray(league.roster_positions)&&league.roster_positions.length,"Roster slots missing");
    require(league.roster_positions.every(s=>eligible[s]||["BN","IR","TAXI","K","DEF"].includes(s)),"Unsupported roster slots");
    const slots=league.roster_positions.filter(s=>eligible[s]);
    require(slots.length,"No skill lineup slots");
    const capacity=league.roster_positions.filter(s=>s!=="IR"&&s!=="TAXI").length;
    require(Array.isArray(rosters)&&Number.isInteger(league.total_rosters)&&rosters.length===league.total_rosters,"Every league roster required");
    const selected=ids(rosterIds,"selected rosters");
    require(selected.length===2,"Two different rosters required");
    const rosterMap=new Map(),owner=new Map(),active=new Map();
    for (const r of rosters) {
      const rid=String(r.roster_id);
      require(r.roster_id!==undefined&&!rosterMap.has(rid),"Duplicate/invalid roster identity");
      rosterMap.set(rid,r);
      const players=ids(r.players,"roster players"),reserve=new Set([...ids(r.reserve||[],"reserve"),...ids(r.taxi||[],"taxi")]);
      for (const id of new Set([...players,...reserve])) {
        require(!owner.has(id),"Player owned by multiple rosters");owner.set(id,rid);
      }
      active.set(rid,players.filter(id=>!reserve.has(id)));
    }
    require(selected.every(r=>rosterMap.has(r)),"Selected roster missing");
    const outgoing=ids(give,"give"),incoming=ids(receive,"receive");
    require(outgoing.length+incoming.length>0,"Select trade players");
    const assets=new Set([...outgoing,...incoming]);
    require(assets.size===outgoing.length+incoming.length,"Overlapping trade assets");
    [outgoing,incoming].forEach((list,i)=>list.forEach(id=>{
      require(active.get(selected[i]).includes(id),"Trade asset must be owned active non-reserve player");
      require(skill.has(catalog?.[id]?.position),"Only skill-player trades supported; no picks or K/DEF values");
    }));
    require(Object.keys(drops).every(r=>selected.includes(r)),"Drop roster outside scenario");
    const before=selected.map(r=>active.get(r));
    const after=before.map((list,i)=>list.filter(id=>![outgoing,incoming][i].includes(id)).concat([incoming,outgoing][i]));
    after.forEach((list,i)=>{
      const dropped=ids(drops[selected[i]]||[],"drops");
      for (const id of dropped) require(list.includes(id)&&!assets.has(id),"Drop must be retained owned player, not trade asset");
      after[i]=list.filter(id=>!dropped.includes(id));
      require(before[i].length<=capacity&&after[i].length<=capacity,"Roster capacity exceeded; explicit drops required");
    });
    require(Array.isArray(remaining.players),"Projection players missing");
    const projections=new Map();
    for (const p of remaining.players) {
      require(typeof p.player_id==="string"&&p.player_id&&!projections.has(p.player_id),"Duplicate/invalid projection identity");
      projections.set(p.player_id,p);
    }
    const relevant=new Set(before.flat().concat(after.flat()));
    const gsisOwners=new Map();
    for (const [id,c] of Object.entries(catalog||{})) if(c.gsis_id) {
      const key=String(c.gsis_id);gsisOwners.set(key,gsisOwners.has(key)?null:id);
    }
    for (const [id,ws] of Object.entries(excludeWeeks)) require(relevant.has(id)&&Array.isArray(ws)&&new Set(ws).size===ws.length&&ws.every(w=>Number.isInteger(w)&&w>=1&&w<=18),"Invalid excluded-week assumption");
    const first=Math.max(currentWeek,remaining.start_week)+1;
    require(first<=remaining.end_week,"No future weeks after current slate");
    const resolve=(id,week)=>{
      const c=catalog?.[id];require(c,"Catalog identity missing");
      if (["K","DEF"].includes(c.position)) return null;
      require(skill.has(c.position),"Unknown roster player position");
      require(typeof c.gsis_id==="string"&&gsisOwners.get(c.gsis_id)===id,"Missing/ambiguous GSIS identity");
      const p=projections.get(c.gsis_id);
      require(p&&team(p.team)&&team(p.team)===team(c.team),`Missing projection or current-team mismatch: ${c.full_name||id}`);
      require(!p.position||p.position===c.position,"Projection position mismatch");
      require(Array.isArray(p.weeks),"Player week coverage missing");
      const rows=p.weeks.filter(w=>w.week===week);require(rows.length===1,"Missing/duplicate projection week");
      const row=rows[0],excluded=(excludeWeeks[id]||[]).includes(week);
      let points=0,status=excluded?"assumed_unavailable":row.status;
      if (!excluded&&row.status!=="bye") {
        require(row.status==="conditional_projection"&&typeof row.points?.league?.p50==="number"&&Number.isFinite(row.points.league.p50),`Missing finite projection; unknown is not zero (${row.reason||row.status})`);
        points=row.points.league.p50;
      }
      return {id,name:c.full_name||id,position:c.position,points,status,reportedInjury:c.injury_status||null};
    };
    // Audit the entire selected roster horizon before optimizing. Report every
    // gap together; never drop an unknown bench player or turn it into zero.
    const resolved=new Map(),coverageIssues=[];
    for(let week=first;week<=remaining.end_week;week++) {
      const players=new Map();
      for(const id of relevant) {
        try { players.set(id,resolve(id,week)); }
        catch(error) { coverageIssues.push({id,name:catalog[id]?.full_name||id,week,reason:error.message}); }
      }
      resolved.set(week,players);
    }
    if(coverageIssues.length) {
      const error=new Error(`Projection coverage blocked: ${new Set(coverageIssues.map(x=>x.id)).size} players, ${coverageIssues.length} player-weeks. ${coverageIssues[0].reason}`);
      error.name="ProjectionCoverageError";
      error.coverageIssues=coverageIssues;
      throw error;
    }
    const weeks=[];
    for(let week=first;week<=remaining.end_week;week++) {
      const sides=selected.map((rid,i)=>{
        const b=lineup(before[i].map(id=>resolved.get(week).get(id)).filter(Boolean),slots);
        const a=lineup(after[i].map(id=>resolved.get(week).get(id)).filter(Boolean),slots);
        return {rosterId:rosterMap.get(rid).roster_id,before:b,after:a,delta:a.total-b.total};
      });
      weeks.push({week,sides});
    }
    return {advice_eligible:false,scenario:"Conditional starting-lineup comparison; not expected realized gain or a trade verdict",
      weeks,sides:selected.map((r,i)=>({rosterId:rosterMap.get(r).roster_id,delta:weeks.reduce((n,w)=>n+w.sides[i].delta,0)})),
      assumptions:{assumeAvailable:true,excludeWeeks,currentWeekSkipped:currentWeek,scoringScope:remaining.scoring_scope||"Supported model stat subset only"},
      availabilityFlags:[...relevant].filter(id=>catalog[id]?.injury_status).map(id=>({id,name:catalog[id].full_name||id,status:catalog[id].injury_status,interpretation:"Reported catalog tag; no return-date inference"})),
      warnings:["All non-excluded active players are assumed available, including reported injuries; availability is not predicted.","No keeper, future-pick, waiver-replacement, bench insurance or opponent acceptance value.","Sum of weekly lineup central scenarios, not a season median or calibrated uncertainty interval.","Current-week games are excluded. Verify processing time, platform eligibility and future roster constraints."]};
  }
  const api=Object.freeze({analyze});
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(typeof window!=="undefined")window.SeasonTrade=api;
})();
