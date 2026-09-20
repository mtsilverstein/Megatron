/* Start/sit controller: reads the shared Sleeper session (spec §5). The
   roster, league and NFL state come from the committed Session bundle; the
   catalog is Session.catalog(); the only fetch of its own goes through
   WaiverMode.loadWorld (the week's transactions, unused here but part of the
   shared adapter's contract). Two timestamps, two jobs: snapshotAt =
   bundle.rostersRequestedAt (PRE-request, so a kickoff during retrieval locks
   the slot) and the 60 s UI expiry against bundle.rostersFetchedAt
   (POST-fetch). The 15 s tick only re-renders; nothing here polls. */
(function () {
  "use strict";
  function init() {
    const $=id=>document.getElementById(id), el=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
    let snapshot=null, sequence=0, staticsPromise=null, currentBundle=null, refreshing=false;
    const S=window.Session;
    const status=text=>{$("ss-status").textContent=text;};
    const slug=new URLSearchParams(location.search).get("league")||"gabagool";
    const entry=FC.registryFor(slug);
    if(!entry){status("Choose a supported league to load a start/sit plan.");return;}
    if(entry.platform!=="sleeper"||!entry.tools.startsit){status("ESPN weekly advice is not connected yet; use its draft board only.");return;}
    const clear=()=>{snapshot=null;$("ss-output").replaceChildren();$("ss-exclude").replaceChildren();};
    function render() {
      $("ss-output").replaceChildren();
      if(!snapshot)return;
      if(Date.now()-snapshot.bundle.rostersFetchedAt>60000){status("Roster snapshot expired. Refresh from the league panel before using these decisions.");return;}
      try {
        const excluded=[...$("ss-exclude").querySelectorAll("input:checked")].map(e=>e.value);
        const s=snapshot, roster=s.world.rosters.find(r=>r.roster_id===s.world.rosterId);
        const r=StartSit.analyze({...s,league:s.world.league,roster,excludeIds:excluded});
        status(`Read-only roster ${s.world.rosterId}; week ${s.weekly.week}; rosters requested ${new Date(s.world.requestedAt).toISOString()}, received ${s.world.fetchedAt}. Projections ${s.weekly.generated_at}, history through ${s.weekly.data_through}. Injury catalog cached ${s.catalogTime||"unknown time"}; not live injury news.`);
        $("ss-output").append(el("p",r.label));
        for(const w of r.warnings)$("ss-output").append(el("p",w));
        const table=document.createElement("table"), head=el("tr","");
        for(const h of ["Slot","Suggested starter","Projection","State"])head.append(el("th",h));
        table.append(head);
        for(const p of r.lineup){const tr=document.createElement("tr");for(const t of [p.slot,p.name,p.points?.p50?.toFixed(2)??"Not modeled",p.unmodeled?"Unchanged K/DST":p.locked?"Game started — locked":p.changed?"Model lean — review close calls":"Keep"] )tr.append(el("td",t));table.append(tr);}
        $("ss-output").append(table,el("h3","Bench and close calls"));
        for(const p of r.bench)$("ss-output").append(el("p",`${p.name}: ${p.locked?"game started; cannot enter lineup":p.bye?"bye":!p.eligible?"excluded / unavailable":p.alternative?`${p.alternative} projects ${p.gap.toFixed(2)} points higher${p.close?" — close call (≤3 points; not a confidence estimate)":""}${p.overlap?"; uncertainty bands overlap":""}`:"no modeled swap"}.`));
      }catch(e){status(`No safe full-lineup recommendation: ${e.message}`);}
    }
    // Why no lineup is shown: the session's error, no identity, still
    // loading, or the exact-matcher refusal (chipText's own wording).
    function gateMessage(bundle){
      const err=S.error(); if(err)return err;
      if(!S.identity())return "Enter your Sleeper username in the league panel above; the plan reads your roster from there.";
      if(bundle&&(bundle.myRosterStatus==="none"||bundle.myRosterStatus==="ambiguous"))return S.chipText(bundle,"ready",Date.now());
      return "Loading league…";
    }
    // Static payloads load once per document; every bundle re-runs only the
    // live part (loadWorld + catalog).
    const statics=()=>staticsPromise||(staticsPromise=Promise.all([FC.leagueDataPath("draft"),FC.leagueDataPath("weekly"),"data/kickoffs.json"].map(f=>FC.loadJSON(f)))
      .catch(e=>{staticsPromise=null;throw e;}));
    async function load(bundle){
      const request=++sequence;currentBundle=bundle;clear();status("Reading roster, scoring, projections and kickoff times…");
      try {
        const [board,weekly,kickoffs]=await statics();
        const state=bundle.state;
        if(Number(state.season)!==weekly.season||Number(state.week)!==weekly.week||state.season_type!=="regular")throw Error("Published slate is not the current NFL regular-season week.");
        const [world,catalog]=await Promise.all([WaiverMode.loadWorld({bundle,board,week:weekly.week}),S.catalog()]);
        if(request!==sequence)return;
        const catalogTime=Number.isFinite(S.catalogFetchedAt())?new Date(S.catalogFetchedAt()).toISOString():null;
        // Conservative: the PRE-request time, so a kickoff during retrieval needs another read.
        snapshot={board,weekly,kickoffs,world,catalog,catalogTime,bundle,snapshotAt:bundle.rostersRequestedAt};
        const mine=world.rosters.find(r=>r.roster_id===world.rosterId);
        for(const id of mine.players||[]){if(!["QB","RB","WR","TE"].includes(catalog[id]?.position))continue;const label=document.createElement("label"),box=document.createElement("input");box.type="checkbox";box.value=id;box.addEventListener("change",render);label.append(box,el("span",catalog[id].full_name||id));$("ss-exclude").append(label);}
        render();
      }catch(error){
        if(request!==sequence||S.isSuperseded(error))return;
        clear();status(`Could not load lineup: ${error.message}`);
      }
    }
    // Gated on bundle()/myRosterStatus/error(), never on state()==="error".
    // Only a DIFFERENT committed bundle re-runs the load; a refresh that
    // commits nothing leaves the previous snapshot and its timestamps alone.
    function sync(snap){
      const bundle=S.bundle(), flow=snap&&snap.state;
      if(!bundle||bundle.myRosterStatus!=="found"||!bundle.myRoster){++sequence;currentBundle=null;refreshing=false;clear();status(gateMessage(bundle));return;}
      if(bundle===currentBundle){
        if(flow==="refreshing"){refreshing=true;status("Refreshing rosters…");return;}
        if(refreshing&&flow==="ready"){refreshing=false;if(snapshot)status(`Refresh did not complete; the roster snapshot received ${snapshot.world.fetchedAt} is still shown. See the league panel for the reason.`);}
        return;
      }
      refreshing=false;load(bundle);
    }
    S.onChange(sync);
    sync({state:S.state()});
    setInterval(()=>{if(snapshot)render();},15000);
  }
  if(typeof window!=="undefined")window.StartSitMode={init};
})();
