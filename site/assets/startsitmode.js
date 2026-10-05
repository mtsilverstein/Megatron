/* Start/sit controller (any-league spec §7.1, §7.2, §5.1, §5.2, §6.1, §3.2).
   Any Sleeper league, by id. Statics: the league-neutral batch
   (LeagueData.loadBatch) and data/kickoffs.json, loaded once per document.
   The live world (league, rosters, the roster under analysis: the owner's
   own or the team a viewer chose) comes from LiveWorld.resolve over the
   committed Session bundle; the catalog is Session.catalog(). Every NEW
   bundle (a load, a refresh that re-read the league settings, an identity
   change, a view choice) recomputes the league views and the plan;
   bundles are compared by identity, never by generation.

   Two timestamps, two jobs: snapshotAt = bundle.rostersRequestedAt
   (PRE-request, so a kickoff during retrieval locks the slot) and the 60 s
   UI expiry against bundle.rostersFetchedAt (POST-fetch). The 15 s tick only
   re-renders; nothing here polls.

   Best ball, an unknown starting slot: projections only, no plan. The views
   are published to onView listeners (the projection table's league lens)
   whether or not a roster is under analysis. */
(function () {
  "use strict";
  const BEST_BALL = "Best-ball scoring picks your top scorers after the games; lineup advice doesn't apply.";
  const NO_EVIDENCE = "No measured evaluation for your league's scoring and this model.";
  const HEURISTIC = n => `${n}-point threshold in your league's points (a heuristic)`;
  const EXPIRED = "Roster snapshot expired. Refresh from the league panel before using these decisions.";
  const SKILL = ["QB", "RB", "WR", "TE"];

  // ---- statics: once per document, a failure retries on the next call ----
  let batchPromise = null, kickoffsPromise = null;
  const batch = () => batchPromise || (batchPromise = LeagueData.loadBatch().catch(e => { batchPromise = null; throw e; }));
  const kickoffs = () => kickoffsPromise || (kickoffsPromise = FC.loadJSON("data/kickoffs.json").catch(e => { kickoffsPromise = null; throw e; }));

  // ---- league views for other surfaces (the projection table) -------------
  const viewListeners = new Set();
  let lastView;   // undefined until the first bundle's views are computed
  function onView(fn) {
    viewListeners.add(fn);
    if (lastView !== undefined) fn(lastView);
    return () => { viewListeners.delete(fn); };
  }
  function emitView(v) {
    lastView = v;
    for (const fn of [...viewListeners]) {
      try { fn(v); } catch (e) { if (typeof console !== "undefined" && console.error) console.error(e); }
    }
  }

  function init() {
    const $=id=>document.getElementById(id), el=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
    let snapshot=null, sequence=0, currentBundle, refreshing=false;
    const S=window.Session;
    const status=text=>{$("ss-status").textContent=text;};
    try { FC.inSeasonLeague(); } catch (e) { status(e.message); return; }
    const showExclusions=on=>{const d=$("ss-exclude-panel");if(d)d.hidden=!on;};
    const clear=()=>{snapshot=null;$("ss-output").replaceChildren();$("ss-exclude").replaceChildren();showExclusions(false);};

    // The close-call and calibration lines are claims about the CURRENT
    // output only when evidenceFor binds a record (spec §3.2); otherwise the
    // fallback copy (today: always -- no record matches the live method).
    function renderEvidence(b, view){
      const rec=id=>b&&view?LeagueData.evidenceFor(b.evaluation,id,view.lens,view.method):null;
      const close=$("ss-evidence"), band=$("band-evidence");
      if(close){
        const r=rec("start_sit_close_calls"), acc=r&&r.values&&r.values.overall&&r.values.overall.choice_accuracy;
        close.textContent=Number.isFinite(acc)
          ? `Close calls: ${(acc*100).toFixed(1)}% correct on same-position, played-player pairs within 3 projected points (both projected ≥5), measured under this league's scoring and this model. Not a roster, cross-position FLEX or expert-comparison backtest. Tiny differences are weak leans.`
          : `Close calls: ${NO_EVIDENCE} Tiny differences are weak leans.`;
      }
      if(band){
        const r=rec("band_calibration"), cov=r&&r.values&&r.values.coverage_p10_p90;
        band.textContent=Number.isFinite(cov)
          ? `about ${Math.round(cov*100)}% of held-out player-weeks landed inside the band, measured under this league's scoring and this model.`
          : NO_EVIDENCE;
      }
    }
    const who=s=>s.world.role==="viewer"?`Viewing ${S.teamName(s.world.users,s.roster)}`:`Read-only roster ${s.world.rosterId}`;
    function stamps(s){
      const settings=S.settingsText(s.bundle);
      return `week ${s.view.weekly.week}; rosters requested ${new Date(s.world.requestedAt).toISOString()}, received ${s.world.fetchedAt}. Projections ${s.view.weekly.generated_at}, history through ${s.view.weekly.data_through}.${settings?` ${settings}.`:""} Injury catalog cached ${s.catalogTime||"unknown time"}; not live injury news.`;
    }
    // Format line (eligibility wins for best ball), scoring banner, footnotes.
    function context(s){
      const out=[el("p",s.format.text)];
      if(s.view.disclosures.banner)out.push(el("p",s.view.disclosures.banner));
      for(const f of s.view.disclosures.footnotes)out.push(el("p",f));
      return out;
    }
    function render() {
      $("ss-output").replaceChildren();
      if(!snapshot)return;
      const s=snapshot, out=$("ss-output");
      if(s.note){status(`${who(s)}; ${stamps(s)}`);out.append(...context(s),el("p",s.note));return;}
      if(Date.now()-s.bundle.rostersFetchedAt>60000){status(EXPIRED);return;}
      out.append(...context(s));
      try {
        const excluded=s.world.role==="owner"?[...$("ss-exclude").querySelectorAll("input:checked")].map(e=>e.value):[];
        const r=StartSit.analyze({board:s.view.board,weekly:s.view.weekly,league:s.world.league,roster:s.roster,catalog:s.catalog,
          kickoffs:s.kickoffs,excludeIds:excluded,snapshotAt:s.snapshotAt});
        status(`${who(s)}; ${stamps(s)}`);
        out.append(el("p",r.label));
        for(const w of r.warnings)out.append(el("p",w));
        const table=document.createElement("table"), head=el("tr","");
        for(const h of ["Slot","Suggested starter","Projection","State"])head.append(el("th",h));
        table.append(head);
        for(const p of r.lineup){const tr=document.createElement("tr");for(const t of [p.slot,p.name,p.points?.p50?.toFixed(2)??"Not modeled",p.unmodeled?"Not projected; current starter kept":p.locked?"Game started — locked":p.changed?"Model lean — review close calls":"Keep"] )tr.append(el("td",t));table.append(tr);}
        out.append(table,el("h3","Bench and close calls"),el("p",`Close call: ${HEURISTIC(3)}; not a confidence estimate.`));
        for(const p of r.bench)out.append(el("p",`${p.name}: ${p.locked?"game started; cannot enter lineup":p.bye?"bye":!p.eligible?"excluded / unavailable":p.alternative?`${p.alternative} projects ${p.gap.toFixed(2)} points higher${p.close?" — close call":""}${p.overlap?"; uncertainty bands overlap":""}`:"no modeled swap"}.`));
      }catch(e){status(`No safe full-lineup recommendation: ${e.message}`);}
    }
    // Why no plan is shown: the session's error, still loading, or the live
    // resolver's own refusal in its order (league status, league type, no
    // roster under analysis). Week 1 is a placeholder: the resolver only
    // range-checks it, and the real week is checked when a plan loads.
    function gateMessage(bundle){
      const err=S.error(); if(err)return err;
      if(!bundle)return "Loading league…";
      let msg;
      try{LiveWorld.resolve({bundle,week:1});return "Loading league…";}catch(e){msg=e.message;}
      if(msg===LiveWorld.NO_ANALYSIS&&(bundle.myRosterStatus==="none"||bundle.myRosterStatus==="ambiguous"))
        return `${S.chipText(bundle,"ready",Date.now())} Choose a team to view in the league panel above.`;
      return msg;
    }
    async function load(bundle){
      const request=++sequence, analysing=!!bundle.analysisRoster;
      clear();
      status(analysing?"Reading roster, scoring, projections and kickoff times…":gateMessage(bundle));
      try {
        const b=await batch();
        if(request!==sequence)return;
        const catalog=await S.catalog();
        if(request!==sequence)return;
        let view=null, viewError=null;
        try{view=LeagueData.views(b,bundle.league,{week:b.weekly.week,catalog});}catch(e){viewError=e;}
        emitView({league:bundle.league,view,error:viewError});
        renderEvidence(b,view);
        if(!analysing)return;
        const state=bundle.state, weekly=b.weekly;
        if(Number(state.season)!==weekly.season||Number(state.week)!==weekly.week||state.season_type!=="regular")throw Error("Published slate is not the current NFL regular-season week.");
        const world=LiveWorld.resolve({bundle,week:weekly.week});
        if(viewError)throw viewError;
        const type=LeagueData.leagueType(world.league), unknown=LeagueData.slotSupport(world.league).unknown;
        const note=type.bestBall?BEST_BALL:unknown.length?`Unsupported lineup slot: ${unknown.join(", ")} — no start/sit plan for this league; the projections below still apply.`:null;
        const [format,ko]=await Promise.all([LeagueData.formatLine(world.league,b.formats),note?null:kickoffs()]);
        if(request!==sequence)return;
        const catalogTime=Number.isFinite(S.catalogFetchedAt())?new Date(S.catalogFetchedAt()).toISOString():null;
        const roster=world.rosters.find(r=>r.roster_id===world.rosterId);
        // Conservative: the PRE-request time, so a kickoff during retrieval needs another read.
        snapshot={view,kickoffs:ko,world,roster,catalog,catalogTime,bundle,format,note,snapshotAt:bundle.rostersRequestedAt};
        if(!note&&world.role==="owner"){
          for(const id of roster.players||[]){if(!SKILL.includes(catalog[id]?.position))continue;const label=document.createElement("label"),box=document.createElement("input");box.type="checkbox";box.value=id;box.addEventListener("change",render);label.append(box,el("span",catalog[id].full_name||id));$("ss-exclude").append(label);}
          showExclusions(true);
        }
        render();
      }catch(error){
        if(request!==sequence||S.isSuperseded(error))return;
        clear();status(`Could not load lineup: ${error.message}`);
      }
    }
    // Gated on the committed bundle and its roster under analysis, never on
    // state()==="error" alone. Only a DIFFERENT committed bundle re-runs the
    // load; a refresh that commits nothing leaves the previous snapshot and
    // its timestamps alone.
    function sync(snap){
      const bundle=S.bundle(), flow=snap&&snap.state;
      if(bundle!==currentBundle){
        currentBundle=bundle;refreshing=false;
        if(!bundle){++sequence;clear();status(gateMessage(null));return;}
        load(bundle);return;
      }
      if(!bundle||!bundle.analysisRoster){status(gateMessage(bundle));return;}
      if(flow==="refreshing"){refreshing=true;status("Refreshing rosters…");return;}
      if(refreshing&&flow==="ready"){refreshing=false;if(snapshot)status(`Refresh did not complete; the roster snapshot received ${snapshot.world.fetchedAt} is still shown. See the league panel for the reason.`);}
    }
    S.onChange(sync);
    sync({state:S.state()});
    setInterval(()=>{if(snapshot)render();},15000);
  }
  if(typeof window!=="undefined")window.StartSitMode={init,batch,onView};
})();
