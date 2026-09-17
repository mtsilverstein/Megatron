/* In-season trade page controller. The pure helpers here are what the fixture
   tests; init() (Task 4) wires them to the DOM and to SeasonTrade.analyze. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SeasonTradeMode = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";
  const SKILL = new Set(["QB", "RB", "WR", "TE"]);
  const HEADLINE = "Conditional lineup scenario — not a trade verdict.";
  const SUBLINE_TAIL = "Keeper value and draft picks are not valued, so no overall grade is shown.";
  const FORBIDDEN = Object.freeze(["verdict", "win/win", "fair", "winner", "accept", "recommend", "grade"]);
  const ALLOWED_SENTENCES = Object.freeze([HEADLINE, SUBLINE_TAIL]);

  // "3-5, 8" -> [3,4,5,8]. Anything else is an error the user sees; an
  // unparseable exclusion must never silently mean "no exclusion".
  function parseWeeks(text, first, last) {
    const fail = () => { throw new Error(`weeks must look like 3-5, 8 and fall within ${first}–${last}`); };
    const out = new Set();
    for (const part of String(text || "").split(",").map(s => s.trim()).filter(Boolean)) {
      const m = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/.exec(part);
      if (!m) fail();
      let a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
      if (a > b) [a, b] = [b, a];
      if (a < first || b > last) fail();
      for (let w = a; w <= b; w++) out.add(w);
    }
    return [...out].sort((x, y) => x - y);
  }
  function identifyRoster(rosters, userId) {
    const mine = (rosters || []).filter(r => r.owner_id === userId || (r.co_owners || []).includes(userId));
    if (mine.length !== 1) throw new Error("Could not uniquely match this account to a roster in this league.");
    return mine[0];
  }
  const capacityOf = league => (league.roster_positions || []).filter(s => !["IR", "TAXI"].includes(String(s).toUpperCase())).length;
  function activeSkill(roster, catalog) {
    const locked = new Set([...(roster.reserve || []), ...(roster.taxi || [])].map(String));
    return (roster.players || []).map(String).filter(id => !locked.has(id) && SKILL.has((catalog[id] || {}).position));
  }
  const neededDrops = ({ activeCount, giveCount, receiveCount, capacity }) => Math.max(0, activeCount - giveCount + receiveCount - capacity);
  const fmtDelta = x => (x === 0 ? "0.00" : `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(2)}`);
  const fmt = x => Number(x).toFixed(2);

  function scenarioText(result, ctx) {
    const name = id => ctx.names[id] || `roster ${id}`;
    const pname = id => (ctx.playerNames && ctx.playerNames[id]) || (ctx.playerNamesAll && ctx.playerNamesAll[id]) || String(id);
    const sides = result.sides.map((s, i) => {
      const before = result.weeks.reduce((a, w) => a + w.sides[i].before.total, 0);
      const after = result.weeks.reduce((a, w) => a + w.sides[i].after.total, 0);
      return { name: name(s.rosterId), before: fmt(before), after: fmt(after), delta: fmtDelta(s.delta) };
    });
    const subline = `Sum of weekly central (p50) lineup scenarios for weeks ${ctx.firstWeek}–${ctx.endWeek}; week ${ctx.currentWeek} is excluded because trades may process after games start. ${SUBLINE_TAIL}`;
    const notValued = (ctx.picks || []).length ? [`Not valued: picks — ${ctx.picks.map(p => p.label).join(", ")}`] : [];
    const assumptions = [];
    for (const [id, weeks] of Object.entries(ctx.excludeWeeks || {})) if (weeks.length) assumptions.push(`${pname(id)} assumed unavailable weeks ${weeks.join(", ")} (your assumption, not a return-date prediction)`);
    for (const [rid, ids] of Object.entries(ctx.drops || {})) for (const id of ids) assumptions.push(`${name(rid)} drops ${pname(id)}`);
    return { headline: HEADLINE, subline, sides, notValued, assumptions };
  }
  function coverageText(error) {
    if (error && Array.isArray(error.coverageIssues)) {
      const players = new Set(error.coverageIssues.map(x => x.id)).size;
      return { headline: `Comparison blocked: ${players} player(s), ${error.coverageIssues.length} player-week(s) without a projection`,
               rows: error.coverageIssues.map(x => `${x.name} · week ${x.week} · ${x.reason}`) };
    }
    return { headline: "Comparison blocked", rows: [String(error && error.message || error)] };
  }

  function init() { throw new Error("SeasonTradeMode.init is wired in the next task"); }

  return Object.freeze({ parseWeeks, identifyRoster, capacityOf, activeSkill, neededDrops, fmtDelta, scenarioText, coverageText, FORBIDDEN, ALLOWED_SENTENCES, HEADLINE, init });
});
