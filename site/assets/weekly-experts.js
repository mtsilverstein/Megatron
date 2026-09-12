/* Optional expert reference. Never changes lineup scoring or substitutes data. */
(function () {
  "use strict";
  function prepare(source, weekly, now=Date.now()) {
    if (source?.schema_version!==2 || source.horizon!=="weekly" || source.rank_scope!=="position" || source.season!==weekly.season || source.week!==weekly.week)
      throw Error("Expert payload schema or week does not match the slate.");
    if (!["ppr","half_ppr","standard"].includes(source.scoring_format) || !source.source)
      throw Error("Expert scoring/source provenance is missing.");
    const age=now-Date.parse(source.snapshot_at);
    if (!Number.isFinite(age)||age<0||age>7*86400000) throw Error("Expert snapshot is stale or undated.");
    if (!Array.isArray(source.players)) throw Error("Expert players are missing.");
    const result=new Map();
    for (const p of source.players) {
      if (typeof p.player_id!=="string"||!p.player_id||result.has(p.player_id)) throw Error("Invalid or duplicate expert player identity.");
      if (!["QB","RB","WR","TE","K","DEF"].includes(p.position)) throw Error("Unknown expert position.");
      for (const k of ["ecr"])
        if (p[k]!==null && (typeof p[k]!=="number"||!Number.isFinite(p[k]))) throw Error(`Invalid expert ${k}.`);
      if (p.ecr!==null && p.ecr<=0) throw Error("Expert rank must be positive.");
      result.set(p.player_id,{player_id:p.player_id,position:p.position,ecr:p.ecr});
    }
    return result;
  }
  const api={prepare};
  if (typeof module!=="undefined"&&module.exports) module.exports=api;
  if (typeof window!=="undefined") window.WeeklyExperts=api;
})();
