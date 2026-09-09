/* Research signals, not projections or bid prices. Pure and read-only. */
(function () {
  "use strict";
  const skill = new Set(["QB", "RB", "WR", "TE"]);
  const num = x => x === null || x === undefined || typeof x === "boolean" || String(x).trim() === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null;
  const ids = r => [...new Set([...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])].map(String))];
  function analyze({ board, league, rosters, rosterId, catalog = {}, week, signals = {}, transactions = [] }) {
    if (!Array.isArray(rosters) || rosters.length !== Number(league.total_rosters)) throw new Error("Research requires every league roster.");
    if (!Number.isInteger(week) || week < 1 || week > 18) throw new Error("Research week is invalid.");
    const mine = rosters.find(r => String(r.roster_id) === String(rosterId));
    if (!mine) throw new Error("Research roster is missing.");
    const owned = new Set(rosters.flatMap(ids));
    const players = new Map();
    for (const p of board.players) if (p.sleeper_id) players.set(String(p.sleeper_id), { ...p, id: String(p.sleeper_id) });
    // Add genuinely trending players absent from the projection board. Missing
    // projections must not hide new rookies; they remain research-only entries.
    const warnings = [], trends = {};
    for (const type of ["add", "drop"]) {
      trends[type] = new Map();
      if (!Array.isArray(signals[type])) { warnings.push(`Sleeper ${type} trend feed unavailable; counts are unknown.`); continue; }
      for (const row of signals[type]) {
        const count = num(row?.count), id = String(row?.player_id || "");
        if (!id || count === null || count < 0 || !Number.isInteger(count)) continue;
        trends[type].set(id, Math.max(count, trends[type].get(id) || 0));
        if (!players.has(id) && catalog[id]) players.set(id, { id, sleeper_id:id, name:catalog[id].full_name, position:catalog[id].position });
      }
    }
    for (const p of players.values()) {
      const c = catalog[p.id];
      if (c) {
        if (!c.team || (p.team && c.team !== p.team)) p.bye = null;
        p.team = c.team || null; p.injury_status = c.injury_status || null;
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
      if (!sameTeam.length && !byeCover.length && adds === null && drops === null) continue;
      if (num(p.ecr) === null && adds === null && drops === null) continue;
      radar.push({ id:p.id, name:p.name || p.id, position:p.position, team:p.team || "Unknown", status:p.injury_status || null,
        ecr:num(p.ecr), adds, drops, sameTeam, byeCover, projectionCovered:board.players.some(b => String(b.sleeper_id) === p.id) });
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
    return { radar, byeRisks, bids, freeAgentMoves, warnings, fetchedAt:signals.fetchedAt || null };
  }
  const api = Object.freeze({ analyze });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.WaiverIntel = api;
})();
