/* Pure Gabagool skill-lineup solver. No transactions, ECR or season-point fallback. */
(function () {
  "use strict";
  const skill = new Set(["QB","RB","WR","TE"]);
  const team = x => ({LAR:"LA",WSH:"WAS"}[x] || x);
  const finite = x => typeof x === "number" && Number.isFinite(x);
  const unavailable = x => ["OUT","IR","SUSPENDED","PUP","DOUBTFUL"].includes(String(x||"").toUpperCase());
  function analyze({board,weekly,league,roster,catalog,kickoffs,excludeIds=[],now=Date.now(),snapshotAt=now}) {
    function require(ok,msg) { if (!ok) throw Error(msg); }
    require(weekly?.league?.league_id === league.league_id,"Weekly league contract does not match.");
    require(league.scoring_settings && weekly.league.sleeper_scoring,"Weekly scoring contract is missing.");
    for (const k of new Set([...Object.keys(league.scoring_settings),...Object.keys(weekly.league.sleeper_scoring || {})]))
      require(Number(league.scoring_settings[k] || 0) === Number(weekly.league.sleeper_scoring[k] || 0),"Weekly scoring changed; refresh the projections.");
    for (const data of [weekly,kickoffs]) {
      require(Number(data?.season) === Number(league.season) && data.week === weekly.week,"Schedule/projection season or week mismatch.");
      const age = now-Date.parse(data.generated_at);
      require(Number.isFinite(age) && age>=-3600000 && age<=7*86400000,"Projection or schedule snapshot is over seven days old; refresh required.");
    }
    require(Array.isArray(kickoffs.games) && Array.isArray(kickoffs.teams),"Kickoff coverage unavailable.");
    const starts = new Map();
    for (const g of kickoffs.games) for (const t of [g.home,g.away]) {
      require(Number.isFinite(Date.parse(g.kickoff)) && !starts.has(team(t)),"Invalid kickoff coverage."); starts.set(team(t),Date.parse(g.kickoff));
    }
    const slots = league.roster_positions.filter(p=>p!=="BN" && p!=="IR" && p!=="TAXI");
    require(slots.every(p=>skill.has(p)||["FLEX","K","DEF"].includes(p)),"Unsupported lineup slot.");
    require(Array.isArray(roster.players) && Array.isArray(roster.starters) && roster.starters.length===slots.length,"Incomplete current starter slots.");
    const starters = roster.starters.map(String), active = roster.players.map(String);
    require(new Set(active).size===active.length && new Set(starters.filter(x=>x!=="0")).size===starters.filter(x=>x!=="0").length,"Duplicate roster/starter identity.");
    require(starters.every(id=>id==="0"||active.includes(id)),"Starter missing from roster.");
    const lockedReserve = new Set([...(roster.reserve||[]),...(roster.taxi||[])].map(String));
    const excluded = new Set(excludeIds.map(String));
    const byId = new Map(board.players.filter(p=>p.sleeper_id).map(p=>[String(p.sleeper_id),p]));
    const projections = new Map(weekly.players.map(p=>[p.player_id,p]));
    const players = [], issues = [], warnings = [];
    for (const id of active) {
      if (lockedReserve.has(id)) continue;
      const b = byId.get(id), c = catalog[id];
      require(c,"Player catalog identity missing; reload.");
      if (!skill.has(c.position)) continue;
      const t = team(c.team), kickoff = starts.get(t);
      require(kickoffs.teams.map(team).includes(t),`Unknown team/schedule for ${c.full_name || id}.`);
      const bye = kickoff === undefined, locked = !bye && now>=kickoff;
      require(!locked || snapshotAt>=kickoff,"A game started since the roster was loaded. Refresh to capture actual locked slots.");
      const p = b && projections.get(b.player_id), pts=p?.points?.league;
      const missing = !pts || !finite(pts.p50) || team(p.team)!==t;
      const status = c.injury_status;
      const eligible = !bye && !unavailable(status) && !excluded.has(id);
      if (missing && eligible && !locked) issues.push(`${c.full_name || id}: missing current-team weekly projection`);
      if (status) warnings.push(`${c.full_name || id}: ${status} — verify current report`);
      players.push({id,name:c.full_name || b?.name || id,position:c.position,team:t,points:missing?null:pts,
        locked,bye,status,eligible,kickoff:bye?null:new Date(kickoff).toISOString(),currentSlot:starters.indexOf(id)});
    }
    require(!issues.length,issues.join("; "));
    const lookup = new Map(players.map(p=>[p.id,p]));
    const eligibleFor = (p,s) => s===p.position || s==="FLEX" && ["RB","WR","TE"].includes(p.position);
    const assigned = Array(slots.length).fill(null), used = new Set();
    slots.forEach((slot,i)=>{
      const p=lookup.get(starters[i]);
      if (!skill.has(slot)&&slot!=="FLEX") { assigned[i]={id:starters[i],name:catalog[starters[i]]?.full_name||starters[i],unmodeled:true}; return; }
      if (p?.locked) { require(eligibleFor(p,slot),"Locked player is in an incompatible slot."); assigned[i]=p;used.add(p.id); }
    });
    // Dedicated positions first, then FLEX: exact for this nested eligibility family.
    const order=slots.map((s,i)=>i).filter(i=>!assigned[i]).sort((a,b)=>Number(slots[a]==="FLEX")-Number(slots[b]==="FLEX"));
    for (const i of order) {
      const pool=players.filter(p=>!used.has(p.id)&&!p.locked&&p.eligible&&p.points&&eligibleFor(p,slots[i]));
      pool.sort((a,b)=>b.points.p50-a.points.p50 || Number(b.currentSlot>=0)-Number(a.currentSlot>=0) || a.id.localeCompare(b.id));
      require(pool.length,`Cannot fill ${slots[i]} with available, projected players. Review injuries/exclusions.`);
      assigned[i]=pool[0];used.add(pool[0].id);
    }
    // Keep equivalent dedicated/FLEX slot assignments stable; no cosmetic swaps.
    for (let i=0;i<slots.length;i++) {
      if (assigned[i].locked || assigned[i].unmodeled || assigned[i].id===starters[i]) continue;
      const j=assigned.findIndex((p,j)=>j!==i && slots[j]===slots[i] && !p.locked && p.id===starters[i]);
      if(j>=0) [assigned[i],assigned[j]]=[assigned[j],assigned[i]];
    }
    const decisions = [];
    for (const p of players.filter(p=>!used.has(p.id))) {
      const comparisons=assigned.map((a,i)=>({a,i})).filter(({a,i})=>!a.unmodeled&&!a.locked&&p.points&&a.points&&p.eligible&&!p.locked&&eligibleFor(p,slots[i]));
      comparisons.sort((x,y)=>x.a.points.p50-y.a.points.p50);
      const best=comparisons[0];
      const gap=best?best.a.points.p50-p.points.p50:null;
      const overlap=best && finite(p.points.p90)&&finite(best.a.points.p10) && finite(p.points.p10)&&finite(best.a.points.p90)
        ? p.points.p90>=best.a.points.p10 && best.a.points.p90>=p.points.p10 : null;
      decisions.push({...p,alternative:best?.a.name||null,gap,overlap,close:gap!==null && gap<=3});
    }
    return {lineup:assigned.map((p,i)=>({...p,slot:slots[i],changed:p.id!==starters[i]})),bench:decisions,warnings,
      label:"Maximizes sum of marginal p50 projections, not proven expected score or win probability."};
  }
  const api={analyze}; if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(typeof window!=="undefined")window.StartSit=api;
})();
