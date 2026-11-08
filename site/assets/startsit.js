/* Pure start/sit engine for any Sleeper league (any-league spec §7.1). No
   transactions, ECR or season-point fallback. `board`/`weekly` are the
   league-neutral views (LeagueData.views): `points.league` is this league's
   scoring of the published stat quantiles; a player the view excludes (e.g. a
   live position change) is absent from the board and therefore missing. The
   lineup is the exact kernel's (Lineup.solve); every per-player rule is
   today's, except (audit 2026-11-07, A6-2/A6-3) that one player never
   refuses the plan: an available player with no NFL team or no current-team
   projection is treated as unavailable and named in `notes`, and a slot no
   available, projected player can fill is left empty (0 points) with a note
   on that slot. Comparisons use raw (unrounded) medians (spec §3.3). */
(function () {
  "use strict";
  const NODE = typeof module!=="undefined" && !!module.exports;
  // Lazy: resolved at call time so script order does not matter.
  const LU = () => NODE ? require("./lineup.js") : window.Lineup;
  const ELIG = () => (NODE ? require("./formats.js") : window.Formats).AUDIT.slot_eligible;
  const skill = new Set(["QB","RB","WR","TE"]);
  const team = x => ({LAR:"LA",WSH:"WAS"}[x] || x);
  const finite = x => typeof x === "number" && Number.isFinite(x);
  const unavailable = x => ["OUT","IR","SUSPENDED","PUP","DOUBTFUL"].includes(String(x||"").toUpperCase());
  function analyze({board,weekly,league,roster,catalog,kickoffs,excludeIds=[],now=Date.now(),snapshotAt=now}) {
    function require(ok,msg) { if (!ok) throw Error(msg); }
    const Lineup = LU(), eligibleSlots = ELIG();
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
    for (const p of slots) require(Lineup.MODELED.includes(p)||Lineup.UNMODELED.includes(p),`Unsupported lineup slot: ${p}`);
    require(Array.isArray(roster.players) && Array.isArray(roster.starters) && roster.starters.length===slots.length,"Incomplete current starter slots.");
    const starters = roster.starters.map(String), active = roster.players.map(String);
    require(new Set(active).size===active.length && new Set(starters.filter(x=>x!=="0")).size===starters.filter(x=>x!=="0").length,"Duplicate roster/starter identity.");
    require(starters.every(id=>id==="0"||active.includes(id)),"Starter missing from roster.");
    const lockedReserve = new Set([...(roster.reserve||[]),...(roster.taxi||[])].map(String));
    const excluded = new Set(excludeIds.map(String));
    const byId = new Map(board.players.filter(p=>p.sleeper_id).map(p=>[String(p.sleeper_id),p]));
    const projections = new Map(weekly.players.map(p=>[p.player_id,p]));
    const players = [], unprojectedNames = [], warnings = [];
    const scheduled = new Set(kickoffs.teams.map(team));
    for (const id of active) {
      if (lockedReserve.has(id)) continue;
      const b = byId.get(id), c = catalog[id];
      require(c,"Player catalog identity missing; reload.");
      if (!skill.has(c.position)) continue;
      // No NFL team (a released player) is unavailable, not an error. A team
      // the schedule does not know is broken coverage and refuses, unless the
      // user excluded the player (exclusions apply first, audit A6-3).
      const t = c.team ? team(c.team) : null, known = t !== null && scheduled.has(t);
      require(known || t === null || excluded.has(id),`Unknown team/schedule for ${c.full_name || id}.`);
      const kickoff = known ? starts.get(t) : undefined;
      const bye = known && kickoff === undefined, locked = known && !bye && now>=kickoff;
      require(!locked || snapshotAt>=kickoff,"A game started since the roster was loaded. Refresh to capture actual locked slots.");
      const p = b && projections.get(b.player_id), pts=p?.points?.league;
      // A board entry whose scoring position is not the live one (a position
      // change the view would exclude) is missing, like a wrong-team projection.
      const missing = !known || !pts || !finite(pts.p50) || team(p.team)!==t || b.position!==c.position;
      const status = c.injury_status;
      const available = !bye && !unavailable(status) && !excluded.has(id);
      // An available, unlocked player with no NFL team or no current-team
      // projection is treated as unavailable (not a candidate, 0 points) and
      // named once in the notes; owner and viewer alike (audit A6-3).
      const unprojected = missing && available && !locked;
      if (unprojected) unprojectedNames.push(c.full_name || id);
      if (status) warnings.push(`${c.full_name || id}: ${status} — verify current report`);
      players.push({id,name:c.full_name || b?.name || id,position:c.position,team:t,points:missing?null:pts,
        locked,bye,status,eligible:available && !unprojected,unprojected,kickoff:kickoff===undefined?null:new Date(kickoff).toISOString(),currentSlot:starters.indexOf(id)});
    }
    const lookup = new Map(players.map(p=>[p.id,p]));
    const eligibleFor = (p,s) => (eligibleSlots[s] || []).includes(p.position);
    // One exact kernel call (spec §7.1). Fixed: game-started players in their
    // current slot, and every unmodeled (K/DEF/IDP) slot's occupant, which
    // reserves that player and the slot. Candidates: unlocked, eligible,
    // projected players at their raw p50.
    const fixed = {};
    slots.forEach((slot,i)=>{
      if (Lineup.UNMODELED.includes(slot)) { if (starters[i]!=="0") fixed[i]={id:starters[i]}; return; }
      const p=lookup.get(starters[i]);
      if (p?.locked) fixed[i]={id:p.id,position:p.position,score:p.points?p.points.p50:null};
    });
    const candidates = players.filter(p=>!p.locked&&p.eligible&&p.points).map(p=>({id:p.id,position:p.position,score:p.points.p50}));
    // allowEmpty (audit A6-2): every slot that can be filled is planned; a slot
    // no available, projected player can fill is left empty and scores 0. A
    // kernel refusal (a locked player in an incompatible slot, malformed
    // occupancy) keeps the kernel's reason.
    const solved = Lineup.solve({slots,candidates,fixed,current:starters,allowEmpty:true});
    if (!solved.ok) throw Error(solved.reason);
    // Sleeper sends "0" for an empty starter slot: an empty K/DEF/IDP slot reads "Empty" (audit A6-7).
    const assigned = solved.assignment.map(a=>a.unmodeled
      ? {id:starters[a.index],name:starters[a.index]==="0"?"Empty":catalog[starters[a.index]]?.full_name||starters[a.index],unmodeled:true}
      : a.empty ? {id:null,name:"Empty",empty:true,points:null,note:`No available ${a.slot} this week — add one from waivers.`}
      : lookup.get(a.id));
    const empty = assigned.filter(a=>a.empty).length;
    const notes = [];
    if (unprojectedNames.length) notes.push(`Not projected this week: ${unprojectedNames.join(", ")} — treated as unavailable.`);
    // No lineup total is reported (spec §7.1); the note says what the plan's sum leaves out.
    if (empty) notes.push(`${empty} empty slot${empty===1?" scores":"s score"} 0 in this plan.`);
    // Every slot occupant, unmodeled-slot occupants included (they are reserved there).
    const used = new Set(assigned.filter(p=>p && p.id && p.id!=="0").map(p=>p.id));
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
    return {lineup:assigned.map((p,i)=>({...p,slot:slots[i],changed:p.empty?starters[i]!=="0":p.id!==starters[i]})),bench:decisions,warnings,notes,
      label:"Maximizes sum of marginal p50 projections, not proven expected score or win probability."};
  }
  const api={analyze}; if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(typeof window!=="undefined")window.StartSit=api;
})();
