/* Research signals, not projections or bid prices. Pure and read-only. */
(function () {
  "use strict";
  const skill = new Set(["QB", "RB", "WR", "TE"]);
  const teamCode = t => ({LAR:"LA", JAC:"JAX", WSH:"WAS"}[t] || t || null);
  const num = x => x === null || x === undefined || typeof x === "boolean" || String(x).trim() === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null;
  const ids = r => [...new Set([...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])].map(String))];
  function prepareRos(source, season, now=Date.now()) {
    if (source?.schema_version !== 1 || source.horizon !== "ros" || source.rank_scope !== "overall"
        || source.scoring_format !== "ppr" || source.season !== Number(season) || !source.source)
      throw new Error("ROS source contract does not match this season/PPR horizon.");
    const age = now - Date.parse(source.snapshot_at);
    if (!Number.isFinite(age) || age < 0 || age > 7*86400000 || !Array.isArray(source.players) || !source.players.length)
      throw new Error("ROS reference is stale, future-dated or empty.");
    const result = new Map();
    for (const p of source.players) {
      if (typeof p.player_id !== "string" || !p.player_id.trim() || result.has(p.player_id)
          || !skill.has(p.position) || typeof p.ros_rank !== "number" || !Number.isFinite(p.ros_rank) || p.ros_rank <= 0)
        throw new Error("Invalid or duplicate ROS player identity/rank.");
      result.set(p.player_id, {position:p.position, team:teamCode(p.team), ros_rank:p.ros_rank});
    }
    return result;
  }
  function analyze({ board, league, rosters, rosterId, catalog = {}, week, signals = {}, transactions = [], roles = null, ros = null }) {
    if (!Array.isArray(rosters) || rosters.length !== Number(league.total_rosters)) throw new Error("Research requires every league roster.");
    if (!Number.isInteger(week) || week < 1 || week > 18) throw new Error("Research week is invalid.");
    const mine = rosters.find(r => String(r.roster_id) === String(rosterId));
    if (!mine) throw new Error("Research roster is missing.");
    const owned = new Set(rosters.flatMap(ids));
    const players = new Map();
    for (const p of board.players) if (p.sleeper_id) players.set(String(p.sleeper_id), { ...p, id: String(p.sleeper_id) });
    // Add genuinely trending players absent from the projection board. Missing
    // projections must not hide new rookies; they remain research-only entries.
    const warnings = [], trends = {}, usage = new Map();
    let rosRanks = new Map(), rosStatus = "Live ROS reference unavailable; preseason ECR remains separately labeled.";
    if (ros) {
      try {
        rosRanks = prepareRos(ros, league.season);
        rosStatus = `ROS reference: ${ros.source}, PPR overall, snapshot ${ros.snapshot_at} (date only). Independent consensus ranks—not league-specific points, trade prices or bid amounts.`;
      } catch (error) { rosStatus = `${error.message} ROS ranks withheld.`; }
    }
    let roleStatus = "Observed usage unavailable; no role-growth claims.";
    const age = roles ? Date.now() - Date.parse(roles.generated_at) : Infinity;
    if (roles && roles.schema_version === 1 && Number(roles.season) === Number(league.season)
        && roles.before_week === week && age >= -3600000 && age <= 72*3600000 && Array.isArray(roles.players)) {
      for (const r of roles.players) if (r.current_for_team === true && Number.isInteger(r.week) && r.week > 0 && r.week < week
          && r.latest && r.delta && Array.isArray(r.baseline_weeks) && Array.isArray(r.flags)) usage.set(String(r.player_id), r);
      roleStatus = roles.status === "awaiting_observations"
        ? `No observed ${roles.season} regular-season usage before week ${week}. Waiting for games and source publication—not zero opportunity.`
        : roles.status === "source_gap" ? "Completed games exist but usage observations are missing; no role-growth claims."
        : `Observed ${roles.season} usage through week ${roles.through_week}; ${roles.covered_team_games}/${roles.completed_team_games} completed team-games represented. Built ${roles.generated_at}. Missing rows are not zero usage.`;
    } else if (roles) roleStatus = "Usage file is stale or does not match this season/week; role-growth flags withheld.";
    const catalogGsisOwners = new Map();
    for (const [sid, c] of Object.entries(catalog)) {
      if (typeof c?.gsis_id !== "string" || !c.gsis_id.trim()) continue;
      const gsis = c.gsis_id.trim();
      catalogGsisOwners.set(gsis, catalogGsisOwners.has(gsis) ? null : sid);
    }
    for (const type of ["add", "drop"]) {
      trends[type] = new Map();
      if (!Array.isArray(signals[type])) { warnings.push(`Sleeper ${type} trend feed unavailable; counts are unknown.`); continue; }
      for (const row of signals[type]) {
        const count = num(row?.count), id = String(row?.player_id || "");
        if (!id || count === null || count < 0 || !Number.isInteger(count)) continue;
        trends[type].set(id, Math.max(count, trends[type].get(id) || 0));
        if (!players.has(id) && catalog[id]) {
          const c = catalog[id], gsis = typeof c.gsis_id === "string" ? c.gsis_id.trim() : null;
          players.set(id, { id, sleeper_id:id, name:c.full_name, position:c.position,
            player_id:gsis && catalogGsisOwners.get(gsis) === id ? gsis : null });
        }
      }
    }
    for (const p of players.values()) {
      p.team = teamCode(p.team);
      const c = catalog[p.id];
      if (c) {
        const team = teamCode(c.team);
        if (!team || (p.team && team !== p.team)) p.bye = null;
        p.team = team; p.injury_status = c.injury_status || null;
      }
    }
    const locked = new Set([...(mine.reserve || []), ...(mine.taxi || [])].map(String));
    const active = (mine.players || []).map(String).filter(id => !locked.has(id)).map(id => players.get(id)).filter(p => p && skill.has(p.position));
    const missing = (mine.players || []).map(String).filter(id => !locked.has(id) && !players.has(id) && skill.has(catalog[id]?.position));
    if (missing.length) warnings.push(`${missing.length} owned skill player(s) missing from the board; depth counts may be understated.`);
    const unknownByes = active.filter(p => num(p.bye) === null);
    if (unknownByes.length) warnings.push(`${unknownByes.length} owned player(s) have unknown byes; coverage is incomplete.`);
    const needs = {};
    for (const pos of league.roster_positions) if (skill.has(pos)) needs[pos] = (needs[pos] || 0) + 1;
    const byeRisks = [];
    for (let w = week; w <= 17; w++) for (const [position, required] of Object.entries(needs)) {
      const group = active.filter(p => p.position === position);
      const off = group.filter(p => num(p.bye) === w);
      if (!off.length) continue;
      const available = group.filter(p => num(p.bye) !== null && num(p.bye) !== w).length;
      if (available <= required) byeRisks.push({ week:w, position, required, available, away:off.map(p => p.name), severity:available < required ? "shortfall" : "no spare" });
    }
    const radar = [];
    for (const p of players.values()) {
      if (owned.has(p.id) || !skill.has(p.position)) continue;
      const sameTeam = p.position === "RB" && p.team ? active.filter(o => o.position === "RB" && o.team === p.team).map(o => o.name) : [];
      const byeCover = byeRisks.filter(r => r.position === p.position && num(p.bye) !== null && num(p.bye) !== r.week).map(r => r.week);
      const adds = trends.add.get(p.id) ?? null, drops = trends.drop.get(p.id) ?? null;
      const observed = usage.get(String(p.player_id));
      const role = observed && teamCode(observed.team) === p.team ? observed : null;
      const roleFlags = role && Array.isArray(role.flags) ? role.flags : [];
      const reference = rosRanks.get(String(p.player_id));
      const rosRank = reference && reference.position === p.position && reference.team && reference.team === p.team ? reference.ros_rank : null;
      if (!sameTeam.length && !byeCover.length && adds === null && drops === null && !roleFlags.length && rosRank === null) continue;
      if (num(p.ecr) === null && adds === null && drops === null && !roleFlags.length && rosRank === null) continue;
      radar.push({ id:p.id, name:p.name || p.id, position:p.position, team:p.team || "Unknown", status:p.injury_status || null,
        ecr:num(p.ecr), rosRank, adds, drops, sameTeam, byeCover, role, roleFlags, projectionCovered:board.players.some(b => String(b.sleeper_id) === p.id) });
    }
    const unavailable = p => ["IR", "OUT", "SUSPENDED", "PUP", "DOUBTFUL"].includes(String(p.status || "").toUpperCase());
    radar.sort((a,b) => Number(unavailable(a))-Number(unavailable(b)) || Number(!!b.sameTeam.length)-Number(!!a.sameTeam.length) || (a.ecr ?? Infinity)-(b.ecr ?? Infinity) || b.byeCover.length-a.byeCover.length || (b.adds ?? -1)-(a.adds ?? -1) || a.id.localeCompare(b.id));
    const bids = [], seen = new Set();
    let freeAgentMoves = 0;
    for (const t of transactions) {
      if (t.status !== "complete" || !t.transaction_id || seen.has(String(t.transaction_id))) continue;
      seen.add(String(t.transaction_id));
      if (t.type === "free_agent") freeAgentMoves++;
      const amount = num(t.settings?.waiver_bid);
      if (t.type !== "waiver" || amount === null || amount < 0 || !Number.isInteger(amount)) continue;
      bids.push({ amount, players:Object.keys(t.adds || {}).map(id => catalog[id]?.full_name || players.get(id)?.name || id) });
    }
    return { radar, byeRisks, bids, freeAgentMoves, warnings, roleStatus, rosStatus, fetchedAt:signals.fetchedAt || null };
  }
  const api = Object.freeze({ analyze, prepareRos });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.WaiverIntel = api;
})();
