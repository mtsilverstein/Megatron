// Pure waiver/FAAB analysis. No DOM, network, or optimizer globals.
(function (root, factory) {
  const W = factory();
  if (typeof window !== "undefined") window.Waivers = W;
  if (typeof module !== "undefined" && module.exports) module.exports = W;
})(this, function () {
  "use strict";

  const SKILL = new Set(["QB", "RB", "WR", "TE"]);
  const SLOT_ELIGIBLE = {
    QB: new Set(["QB"]), RB: new Set(["RB"]), WR: new Set(["WR"]),
    TE: new Set(["TE"]), FLEX: new Set(["RB", "WR", "TE"]),
    SUPER_FLEX: new Set(["QB", "RB", "WR", "TE"]),
    K: new Set(["K"]), DEF: new Set(["DEF"])
  };
  const BENCH = new Set(["BN", "IR", "TAXI"]);
  const UNAVAILABLE = new Set(["OUT", "IR", "SUSPENDED", "PUP", "DOUBTFUL"]);
  const id = x => String(x);
  const finite = x => (x === null || x === undefined || x === "" || typeof x === "boolean")
    ? null : (Number.isFinite(Number(x)) ? Number(x) : null);
  const fail = msg => { throw new TypeError(`Waivers.analyze: ${msg}`); };

  function playerId(p) { return p && (p.sleeper_id ?? p.id); }
  function position(p) {
    const v = String(p && (p.position || p.pos) || "").toUpperCase();
    return v === "DST" ? "DEF" : v;
  }
  function boardPoints(p) {
    const vp = finite(p && p.value_points);
    if (vp !== null) return vp;
    const sp = p && p.season_points;
    if (sp && typeof sp === "object") {
      const lg = sp.league;
      const v = finite(lg && typeof lg === "object" ? lg.p50 : lg);
      if (v !== null) return v;
    }
    return null;
  }
  function slots(league) {
    const raw = league && league.roster_positions;
    if (!Array.isArray(raw) || !raw.length) fail("league.roster_positions is missing");
    const out = [];
    raw.forEach(s0 => {
      const s = String(s0).toUpperCase() === "SUPER_FLEX" ? "SUPER_FLEX" : String(s0).toUpperCase();
      if (BENCH.has(s) || s === "K" || s === "DEF") return;
      if (!SLOT_ELIGIBLE[s]) fail(`unsupported starting roster position ${s}`);
      out.push(s);
    });
    if (!out.length) fail("league has no supported starting positions");
    return out;
  }
  function lineupScore(players, starterSlots, scoreOf) {
    // Exact for the supported laminar slot family: dedicated position sets are
    // disjoint, FLEX contains RB/WR/TE, and SUPER_FLEX contains all of them.
    // Taking the best mandatory players first cannot hurt a broader slot; the
    // remaining broader slots then take the best remaining eligible scores.
    const need = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPER_FLEX: 0 };
    starterSlots.forEach(s => need[s]++);
    const pools = { QB: [], RB: [], WR: [], TE: [] };
    players.forEach(p => {
      const pos = position(p), value = scoreOf(p);
      if (pools[pos] && value !== null) pools[pos].push(value);
    });
    Object.values(pools).forEach(xs => xs.sort((a, b) => b - a));
    let total = 0;
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      if (pools[pos].length < need[pos]) return -Infinity;
      for (let i = 0; i < need[pos]; i++) total += pools[pos].shift();
    }
    let flex = pools.RB.concat(pools.WR, pools.TE).sort((a, b) => b - a);
    if (flex.length < need.FLEX) return -Infinity;
    for (let i = 0; i < need.FLEX; i++) total += flex.shift();
    // Remove FLEX selections from their positional pools by multiset value.
    const remainingFlex = flex.slice();
    const qb = pools.QB;
    const superFlex = qb.concat(remainingFlex).sort((a, b) => b - a);
    if (superFlex.length < need.SUPER_FLEX) return -Infinity;
    for (let i = 0; i < need.SUPER_FLEX; i++) total += superFlex[i];
    return total;
  }
  function validateIds(values, label) {
    const seen = new Set();
    (values || []).forEach(v => {
      if ((typeof v !== "string" && typeof v !== "number") || id(v).trim() === "") fail(`${label} contains an invalid player id`);
      seen.add(id(v));
    });
    return seen;
  }
  function weeklyMap(weekly, league, week, boardByGsis, warnings) {
    if (!weekly) return { fresh: false, map: new Map(), reason: "weekly projections unavailable" };
    const generated = Date.parse(weekly.generated_at);
    const age = Date.now() - generated;
    const season = finite(weekly.season), expectedSeason = finite(league.season);
    const gotWeek = finite(weekly.week), expectedWeek = finite(week);
    let reason = null;
    const weeklyLeague = weekly.league;
    const liveScoring = league.scoring_settings;
    const weeklyScoring = weeklyLeague && weeklyLeague.sleeper_scoring;
    const scoringMatches = liveScoring && weeklyScoring && typeof liveScoring === "object" && typeof weeklyScoring === "object" &&
      Object.keys(liveScoring).length > 0 && Object.keys(weeklyScoring).length > 0 &&
      [...new Set([...Object.keys(liveScoring), ...Object.keys(weeklyScoring)])].every(k => {
        const a = Object.hasOwn(liveScoring, k) ? finite(liveScoring[k]) : 0;
        const b = Object.hasOwn(weeklyScoring, k) ? finite(weeklyScoring[k]) : 0;
        return a !== null && b !== null && a === b;
      });
    if (!weeklyLeague || id(weeklyLeague.league_id) !== id(league.league_id)) reason = "weekly league id does not match live league";
    else if (!scoringMatches) reason = "weekly scoring contract is incomplete or does not match live league";
    else if (season === null || expectedSeason === null || season !== expectedSeason) reason = "weekly season does not match league season";
    else if (gotWeek === null || expectedWeek === null || gotWeek !== expectedWeek) reason = "weekly week does not match requested week";
    else if (!Number.isFinite(generated) || age < -3600000 || age > 72 * 3600000) reason = "weekly projections are stale (over 72 hours old)";
    else if (!Array.isArray(weekly.players)) reason = "weekly players are missing";
    if (reason) { warnings.push(`${reason}; using preseason proxy`); return { fresh: false, map: new Map(), reason }; }
    const map = new Map();
    weekly.players.forEach(w => {
      const bp = boardByGsis.get(id(w.player_id));
      const p50 = finite(w.points && w.points.league && w.points.league.p50);
      const pid = playerId(bp);
      if (bp && pid !== null && pid !== undefined && p50 !== null) map.set(id(pid), p50);
    });
    return { fresh: true, map, reason: null };
  }
  function bidGuide(gain, total, remaining, reserve, minBid) {
    let pct = [0, 0], tier = "no bid";
    if (gain > 0 && gain < 2) { pct = [0.01, 0.03]; tier = "small"; }
    else if (gain >= 2 && gain < 5) { pct = [0.04, 0.10]; tier = "useful"; }
    else if (gain >= 5) { pct = [0.11, 0.20]; tier = "impact"; }
    const affordable = Math.max(0, remaining - reserve);
    if (gain > 0 && affordable < minBid) {
      return { low: null, high: null, tier, affordable, canAfford: false, status: "minimum bid exceeds spendable budget", label: "heuristic, not calibrated and not a win probability" };
    }
    let low = Math.min(affordable, Math.ceil(total * pct[0]));
    let high = Math.min(affordable, Math.ceil(total * pct[1]));
    if (gain > 0) { low = Math.max(minBid, low); high = Math.max(low, high); }
    return { low, high, tier, affordable, canAfford: true, status: null, label: "heuristic, not calibrated and not a win probability" };
  }

  function analyze(args) {
    if (!args || typeof args !== "object") fail("expected an options object");
    const board = args.board, league = args.league, rosters = args.rosters;
    if (!board || !Array.isArray(board.players)) fail("board.players is missing");
    if (!league || !Array.isArray(rosters)) fail("league and rosters are required");
    const totalRosters = finite(league.total_rosters);
    if (totalRosters === null || rosters.length !== totalRosters) fail("rosters must contain every league roster");
    const rosterId = finite(args.rosterId);
    if (rosterId === null) fail("rosterId must be numeric");
    const mine = rosters.find(r => finite(r.roster_id) === rosterId);
    if (!mine) fail(`roster ${args.rosterId} was not found`);
    const starterSlots = slots(league);
    const waiverType = finite(league.settings && league.settings.waiver_type);
    const rolling = waiverType === 0;
    const budgetTotal = rolling ? null : finite(league.settings && league.settings.waiver_budget);
    if (!rolling && (budgetTotal === null || budgetTotal < 0)) fail("league.settings.waiver_budget is missing or invalid");
    const used = rolling ? null : finite(mine.settings && mine.settings.waiver_budget_used);
    if (!rolling && (used === null || used < 0)) fail("roster waiver_budget_used is missing or invalid");
    const remaining = rolling ? null : Math.max(0, budgetTotal - used);
    const reserve = rolling ? null : finite(args.budgetReserve === undefined ? 20 : args.budgetReserve);
    if (!rolling && (reserve === null || reserve < 0)) fail("budgetReserve must be non-negative");
    const minBid = rolling ? null : Math.max(0, finite(league.settings && league.settings.waiver_bid_min) || 0);
    const protectedIds = validateIds(args.protectedIds || [], "protectedIds");

    const warnings = [], boardById = new Map(), boardByGsis = new Map();
    let unmappedBoard = 0;
    board.players.forEach(p => {
      const pid = playerId(p);
      if (pid === null || pid === undefined || id(pid).trim() === "") unmappedBoard++;
      else {
        if (typeof pid !== "string" && typeof pid !== "number") fail("board contains an invalid Sleeper player id");
        if (boardById.has(id(pid))) fail(`board contains duplicate player id ${pid}`);
        boardById.set(id(pid), p);
      }
      // Generated boards use player_id for GSIS and sleeper_id for ownership.
      const gsis = p.gsis_id ?? p.player_id;
      if (gsis !== undefined && gsis !== null) boardByGsis.set(id(gsis), p);
    });
    if (unmappedBoard) warnings.push(`${unmappedBoard} board player(s) lack a Sleeper id and cannot be waiver candidates`);
    const owned = new Set(), ownActive = [], ownLocked = new Set(), unknownOwned = [];
    const rosterIds = new Set();
    rosters.forEach(r => {
      const rid = finite(r && r.roster_id);
      if (rid === null || rosterIds.has(rid)) fail("roster_id values must be present and unique");
      rosterIds.add(rid);
      if (!Array.isArray(r.players)) fail(`roster ${r.roster_id} players must be an array`);
      const active = validateIds(r.players || [], `roster ${r.roster_id} players`);
      const reserveSet = validateIds(r.reserve || [], `roster ${r.roster_id} reserve`);
      const taxiSet = validateIds(r.taxi || [], `roster ${r.roster_id} taxi`);
      new Set([...active, ...reserveSet, ...taxiSet]).forEach(pid => {
        if (owned.has(pid)) fail(`duplicate ownership for player ${pid}`);
        owned.add(pid);
      });
      if (finite(r.roster_id) === rosterId) {
        reserveSet.forEach(pid => ownLocked.add(pid)); taxiSet.forEach(pid => ownLocked.add(pid));
        active.forEach(pid => {
          if (ownLocked.has(pid)) return;
          const p = boardById.get(pid); if (p) ownActive.push(p); else unknownOwned.push(pid);
        });
      }
    });
    if (unknownOwned.length) warnings.push(`${unknownOwned.length} owned player(s) missing from board; excluded from drops and lineup analysis may be incomplete`);
    const weekly = weeklyMap(args.weekly, league, args.week, boardByGsis, warnings);
    if (!weekly.fresh && !warnings.some(w => /preseason proxy/.test(w))) warnings.push(`${weekly.reason}; using preseason proxy`);
    if (weekly.fresh && weekly.map.size < boardById.size) warnings.push(`${boardById.size - weekly.map.size} board player(s) lack a current weekly projection and are excluded from weekly comparisons`);
    const unavailable = p => UNAVAILABLE.has(String(p.injury_status || p.status || "").toUpperCase());
    const remainingWeeks = Math.max(1, 18 - (finite(args.week) || 1));
    const score = p => {
      const pid = id(playerId(p));
      if (weekly.fresh) {
        if (unavailable(p)) return 0;
        return weekly.map.has(pid) ? weekly.map.get(pid) : null;
      }
      const v = boardPoints(p);
      if (v === null) return null;
      const bye = finite(p.bye ?? p.bye_week);
      const playableWeeks = bye !== null && bye >= (finite(args.week) || 1) && bye <= 17
        ? remainingWeeks - 1 : remainingWeeks;
      return (v / 17) * Math.max(0, playableWeeks);
    };
    const baseline = lineupScore(ownActive, starterSlots, score);
    if (!Number.isFinite(baseline)) fail("owned roster cannot fill every required starting position with known finite scores");
    const mapped = p => playerId(p) !== null && playerId(p) !== undefined;
    const injuredFreeAgents = board.players.filter(p => mapped(p) && !owned.has(id(playerId(p))) && SKILL.has(position(p)) && unavailable(p));
    // An injury designation is not a ROS forecast. In a fresh upcoming-week
    // view it does, however, make the add non-actionable; stash analysis is a
    // separate user decision and must not masquerade as immediate improvement.
    const freeAgents = board.players.filter(p => mapped(p) && !owned.has(id(playerId(p))) && SKILL.has(position(p)) && score(p) !== null && !(weekly.fresh && unavailable(p)));
    if (weekly.fresh && injuredFreeAgents.length) warnings.push(`${injuredFreeAgents.length} unavailable free agent(s) excluded from immediate weekly recommendations; review separately for stash value`);
    const missingDropScores = ownActive.filter(p => SKILL.has(position(p)) && score(p) === null);
    if (weekly.fresh && missingDropScores.length) warnings.push(`${missingDropScores.length} owned player(s) lack a current weekly projection and are protected from drops`);
    const droppable = ownActive.filter(p => SKILL.has(position(p)) && score(p) !== null && !protectedIds.has(id(playerId(p))) && !ownLocked.has(id(playerId(p))));
    const rows = [];
    freeAgents.forEach(add => droppable.forEach(drop => {
      const next = ownActive.filter(p => id(playerId(p)) !== id(playerId(drop))).concat([add]);
      const result = lineupScore(next, starterSlots, score);
      if (!Number.isFinite(result)) return;
      const gain = Math.round((result - baseline) * 100) / 100;
      if (gain <= 0) return;
      const valueEstimate = boardPoints(add);
      rows.push({
        add: { id: id(playerId(add)), name: add.name || add.full_name || id(playerId(add)), position: position(add) },
        drop: { id: id(playerId(drop)), name: drop.name || drop.full_name || id(playerId(drop)), position: position(drop) },
        lineupGain: gain,
        scoring: { source: weekly.fresh ? "weekly" : "preseason_proxy", label: weekly.fresh ? `week ${args.week} projection` : "ROUGH REST-OF-SEASON PRESEASON PROXY — not a live projection" },
        availability: { status: String(add.injury_status || add.status || "").toUpperCase() || null, actionableNow: !unavailable(add), warning: unavailable(add) ? "injury designation: stash/review, not an immediate-week recommendation" : null },
        valueEstimate: { points: valueEstimate, label: "board value estimate; not a FAAB price" },
        bid: rolling ? null : bidGuide(weekly.fresh ? gain : gain / remainingWeeks, budgetTotal, remaining, reserve, minBid)
      });
    }));
    rows.sort((a, b) => b.lineupGain - a.lineupGain || (b.valueEstimate.points || -Infinity) - (a.valueEstimate.points || -Infinity));
    if (!rows.length) warnings.push("no positive legal skill-player swap found");
    return {
      waiver: { type: rolling ? "rolling" : "faab", priority: finite(mine.settings && mine.settings.waiver_position), guidance: rolling ? "Order claims by value and roster need; current priority is context, not a claim-success probability." : "Bid ranges are budgeting heuristics, not claim-success probabilities." },
      budget: rolling ? null : { total: budgetTotal, used, remaining, reserve, spendable: Math.max(0, remaining - reserve) },
      warnings, rows,
      roster: { rosterId, playerIds: [...validateIds(mine.players || [], "roster players")], protectedIds: [...protectedIds], lockedReserveTaxiIds: [...ownLocked], unknownOwnedIds: unknownOwned },
      coverage: { boardPlayers: board.players.length, ownedPlayers: owned.size, freeAgentsScored: freeAgents.length, dropCandidates: droppable.length, weeklyFresh: weekly.fresh, weeklyMatched: weekly.map.size, scoringLabel: weekly.fresh ? "fresh weekly projection" : "rough rest-of-season preseason proxy" }
    };
  }
  return Object.freeze({ analyze });
});
