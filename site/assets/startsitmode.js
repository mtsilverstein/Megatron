(function () {
  "use strict";
  function init() {
    const $=id=>document.getElementById(id), el=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
    let snapshot=null, sequence=0, catalogPromise=null, catalogTime=null;
    const status=text=>{$("ss-status").textContent=text;};
    function render() {
      $("ss-output").replaceChildren();
      if(!snapshot)return;
      if(Date.now()-Date.parse(snapshot.world.fetchedAt)>60000){status("Roster snapshot expired. Refresh before using these decisions.");return;}
      try {
        const excluded=[...$("ss-exclude").querySelectorAll("input:checked")].map(e=>e.value);
        const s=snapshot, roster=s.world.rosters.find(r=>r.roster_id===s.world.rosterId);
        const r=StartSit.analyze({...s,league:s.world.league,roster,excludeIds:excluded});
        status(`Read-only roster ${s.world.rosterId}; week ${s.weekly.week}; roster snapshot ${s.world.fetchedAt}. Projections ${s.weekly.generated_at}, history through ${s.weekly.data_through}. Injury catalog cached ${catalogTime}; not live injury news.`);
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
    $("ss-form").addEventListener("submit",async e=>{
      e.preventDefault();const request=++sequence;snapshot=null;$("ss-output").replaceChildren();$("ss-exclude").replaceChildren();status("Reading roster, scoring, projections and kickoff times…");
      try {
        const [board,weekly,kickoffs]=await Promise.all(["draft.json","weekly.json","kickoffs.json"].map(f=>FC.loadJSON(`data/${f}`)));
        if(!catalogPromise)catalogPromise=Sleeper.get("/players/nfl").then(c=>{catalogTime=new Date().toISOString();return c;}).catch(e=>{catalogPromise=null;throw e;});
        const snapshotAt=Date.now(); // Conservative: a kickoff during retrieval needs another read.
        const [world,catalog,state]=await Promise.all([WaiverMode.loadWorld({username:$("ss-user").value,board,week:weekly.week}),catalogPromise,Sleeper.get("/state/nfl")]);
        if(request!==sequence)return;
        if(Number(state.season)!==weekly.season||Number(state.week)!==weekly.week||state.season_type!=="regular")throw Error("Published slate is not the current NFL regular-season week.");
        snapshot={board,weekly,kickoffs,world,catalog,snapshotAt};
        const mine=world.rosters.find(r=>r.roster_id===world.rosterId);
        for(const id of mine.players){if(!["QB","RB","WR","TE"].includes(catalog[id]?.position))continue;const label=document.createElement("label"),box=document.createElement("input");box.type="checkbox";box.value=id;box.addEventListener("change",render);label.append(box,el("span",catalog[id].full_name||id));$("ss-exclude").append(label);}
        render();
      }catch(error){if(request===sequence)status(`Could not load lineup: ${error.message}`);}
    });
    $("ss-user").addEventListener("input",()=>{++sequence;snapshot=null;$("ss-output").replaceChildren();$("ss-exclude").replaceChildren();status("Account changed; reload roster.");});
    setInterval(()=>{if(snapshot)render();},15000);
  }
  if(typeof window!=="undefined")window.StartSitMode={init};
})();
