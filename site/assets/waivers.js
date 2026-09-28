// Pure waiver/FAAB analysis. No DOM, network, or optimizer globals.
(function (root, factory) {
  const W = factory();
  if (typeof window !== "undefined") window.Waivers = W;
  if (typeof module !== "undefined" && module.exports) module.exports = W;
})(this, function () {
  "use strict";
  const ROS = (typeof module !== "undefined" && module.exports) ? require("./ros.js") : window.ROS;
  // Season simulation (rostersim.js). Optional at load: a page that did not ship
  // it simply never opens the simulated drop cost.
  const ROSTERSIM = (typeof module !== "undefined" && module.exports) ? require("./rostersim.js") : (typeof window !== "undefined" ? window.RosterSim : undefined);

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
  function team(x) { return ({ LAR: "LA", WSH: "WAS" })[String(x || "").toUpperCase()] || String(x || "").toUpperCase(); }
  function playerTeam(p) { return team(p && Object.hasOwn(p, "current_team") ? p.current_team : p && p.team); }
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
  function activeRosterCapacity(league) {
    return league.roster_positions.reduce((n, s0) => {
      const s = String(s0).toUpperCase();
      return n + (s === "IR" || s === "TAXI" ? 0 : 1);
    }, 0);
  }
  // Lineup solver moved to ros.js (shared with seasontrade.js/waivermode.js).
  const lineupScore = ROS.lineupScore;
  function validateIds(values, label) {
    const seen = new Set();
    (values || []).forEach(v => {
      if ((typeof v !== "string" && typeof v !== "number") || id(v).trim() === "") fail(`${label} contains an invalid player id`);
      seen.add(id(v));
    });
    return seen;
  }
  function weeklyMap(weekly, league, week, boardByGsis, warnings, now) {
    if (!weekly) return { fresh: false, map: new Map(), invalidTeamIds: new Set(), reason: "weekly projections unavailable" };
    const generated = Date.parse(weekly.generated_at);
    const age = now - generated;
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
    if (reason) { return { fresh: false, map: new Map(), invalidTeamIds: new Set(), reason }; }
    const map = new Map(), invalidTeamIds = new Set();
    weekly.players.forEach(w => {
      const bp = boardByGsis.get(id(w.player_id));
      const p50 = finite(w.points && w.points.league && w.points.league.p50);
      const pid = playerId(bp), boardTeam = playerTeam(bp), projectionTeam = team(w.team);
      if (bp && pid !== null && pid !== undefined) {
        if (!boardTeam || !projectionTeam || projectionTeam !== boardTeam) invalidTeamIds.add(id(pid));
        else if (p50 !== null) map.set(id(pid), p50);
      }
    });
    return { fresh: true, map, invalidTeamIds, reason: null };
  }
  function kickoffMap(kickoffs, league, week, now) {
    let reason = null;
    const season = finite(kickoffs && kickoffs.season), expectedSeason = finite(league.season);
    const gotWeek = finite(kickoffs && kickoffs.week), expectedWeek = finite(week);
    const generated = Date.parse(kickoffs && kickoffs.generated_at);
    const age = now - generated;
    if (!kickoffs) reason = "kickoff coverage unavailable";
    else if (season === null || expectedSeason === null || season !== expectedSeason) reason = "kickoff season does not match league season";
    else if (gotWeek === null || expectedWeek === null || gotWeek !== expectedWeek) reason = "kickoff week does not match requested week";
    else if (!Number.isFinite(generated) || age < -3600000 || age > 72 * 3600000) reason = "kickoff coverage is stale (over 72 hours old)";
    else if (!Array.isArray(kickoffs.games) || !Array.isArray(kickoffs.teams)) reason = "kickoff coverage is incomplete";
    const starts = new Map(), covered = new Set();
    if (!reason) {
      kickoffs.teams.forEach(t => { const v = team(t); if (v) covered.add(v); });
      for (const g of kickoffs.games) for (const t0 of [g && g.home, g && g.away]) {
        const t = team(t0), at = Date.parse(g && g.kickoff);
        if (!t || !Number.isFinite(at) || starts.has(t) || !covered.has(t)) { reason = "kickoff coverage contains an invalid game"; break; }
        starts.set(t, at);
      }
    }
    return { fresh: !reason, starts, covered, reason };
  }
  // One projection week as the simulation wants it: {status:"bye"} or
  // {status:"play", p10, p50, p90} with finite ordered quantiles, else null.
  function simRow(row) {
    if (row.status === "bye") return { status: "bye" };
    if (row.status !== "conditional_projection") return null;
    const l = row.points && row.points.league;
    const p10 = finite(l && l.p10), p50 = finite(l && l.p50), p90 = finite(l && l.p90);
    return p10 !== null && p50 !== null && p90 !== null && p10 <= p50 && p50 <= p90 ? { status: "play", p10, p50, p90 } : null;
  }
  // Rest-of-season projections, guarded like weeklyMap: same league, same
  // scoring contract, same season, start week equal to the analysed week,
  // fresh within 72 hours. Returns per-player per-week points for the FUTURE
  // weeks only (week > analysed week): a bye is 0, an unmodeled or missing
  // week is null and marks the player unmodeled. Unknown is never zero.
  function remainingMap(remaining, league, week, boardByGsis, now) {
    const none = reason => ({ fresh:false, reason, endWeek:null, generatedAt:null, dataThrough:null, at:new Map(), unmodeled:new Set(), evaluation:null });
    if (!remaining) return none("remaining-season projections unavailable");
    const rl = remaining.league, live = league.scoring_settings, rs = rl && rl.sleeper_scoring;
    const scoringMatches = live && rs && typeof live === "object" && typeof rs === "object" &&
      Object.keys(live).length > 0 && Object.keys(rs).length > 0 &&
      [...new Set([...Object.keys(live), ...Object.keys(rs)])].every(k => {
        const a = Object.hasOwn(live, k) ? finite(live[k]) : 0, b = Object.hasOwn(rs, k) ? finite(rs[k]) : 0;
        return a !== null && b !== null && a === b;
      });
    const generated = Date.parse(remaining.generated_at), age = now - generated;
    const expectedWeek = finite(week), endWeek = finite(remaining.end_week);
    if (!rl || id(rl.league_id) !== id(league.league_id)) return none("remaining-season league id does not match live league");
    if (!scoringMatches) return none("remaining-season scoring contract is incomplete or does not match live league");
    if (finite(remaining.season) === null || finite(league.season) === null || finite(remaining.season) !== finite(league.season)) return none("remaining-season season does not match league season");
    if (finite(remaining.start_week) === null || expectedWeek === null || finite(remaining.start_week) !== expectedWeek) return none("remaining-season start week does not match requested week");
    if (!Number.isFinite(generated) || age < -3600000 || age > 72 * 3600000) return none("remaining-season projections are stale (over 72 hours old)");
    if (!Array.isArray(remaining.players) || endWeek === null || !Number.isInteger(endWeek) || endWeek < expectedWeek) return none("remaining-season payload is incomplete");
    const at = new Map(), unmodeled = new Set(), sim = new Map();
    remaining.players.forEach(r => {
      const bp = boardByGsis.get(id(r.player_id));
      const pid = playerId(bp);
      if (!bp || pid === null || pid === undefined) return;
      const rows = new Map(), simRows = new Map();
      const teamOk = playerTeam(bp) && team(r.team) === playerTeam(bp);
      for (let w = expectedWeek + 1; w <= endWeek; w++) {
        const row = (r.weeks || []).find(x => finite(x.week) === w);
        let v = null;
        // What the season simulation reads: the same rows, but with the p10/p90
        // band. null means this week cannot be simulated (unknown is never zero).
        simRows.set(w, teamOk && row ? simRow(row) : null);
        if (teamOk && row && row.status === "bye") v = 0;
        else if (teamOk && row && row.status === "conditional_projection") v = finite(row.points && row.points.league && row.points.league.p50);
        if (v === null) unmodeled.add(id(pid));
        rows.set(w, v);
      }
      at.set(id(pid), rows); sim.set(id(pid), simRows);
    });
    return { fresh:true, sim, reason:null, endWeek, generatedAt:remaining.generated_at, dataThrough:remaining.data_through ?? null, at, unmodeled,
             evaluation: remaining.evaluation === undefined ? null : remaining.evaluation };
  }
  // Gate for the simulated drop cost. Mirrors the trade page's evalView
  // semantics (schema_version 1; the league slug matches the primary entry or
  // the secondary entry, each with its OWN fields; the entry's slots equal the
  // live starter slots as a multiset) but the field that must read "pass" is
  // waiver_verdict. FAM's secondary entry is open only on its own
  // waiver_verdict; the primary's never opens another league. Anything missing,
  // malformed or mismatched is closed.
  const STARTER_SLOTS = new Set(["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX"]);
  const starterSlotList = positions => (Array.isArray(positions) ? positions : []).filter(s => STARTER_SLOTS.has(s));
  const sameSlots = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.slice().sort().join(",") === b.slice().sort().join(",");
  function waiverGateOpen(evalFile, league) {
    if (!evalFile || typeof evalFile !== "object" || evalFile.schema_version !== 1 || !league) return false;
    const live = starterSlotList(league.roster_positions);
    const secondary = evalFile.secondary && typeof evalFile.secondary === "object" ? evalFile.secondary : null;
    return [evalFile, secondary].some(c => !!c && c.league === league.slug && c.waiver_verdict === "pass" && sameSlots(c.slots, live));
  }
  // Simulation constants. Pass 1 (coarse) prices the rows a reader can see at
  // 200 sims for ranking; pass 2 recomputes the leading rows at 2000 sims with
  // the same seed. The row caps are the measured cost of the engine (about 20 ms
  // per roster variant per 200 sims over a 13-week season), not a modelling choice.
  const SIM = Object.freeze({ seed: 20260924, coarseSims: 200, fineSims: 2000, candidatesPerPosition: 15, coarseRows: 16, coarseRowsPerPosition: 8, fineRows: 3 });
  const isSimError = e => !!e && e.name === "RosterSimError";
  // Conservative product threshold, not a validated noise or confidence cutoff:
  // a modeled gain under one projected point per week stays visible for
  // research but never becomes a bid or a priority claim. Whether gains this
  // small are distinguishable from projection error has not been measured.
  const WEAK_SIGNAL_PTS = 1;
  const BID_LABEL = "heuristic, not calibrated and not a win probability";
  const r2 = x => Math.round(x * 100) / 100;
  const fmt = x => x.toFixed(2);
  // Three states, fixed key sets (the fixture asserts them). Pricing is the
  // roster-aware rest-of-season lineup change, split against R+A: what the add
  // contributes to the roster, and what the drop then forfeits given the add
  // is on it. A bench player who never starts forfeits ~0 whatever his total.
  function dropCostOf(drop, add, ros, withAdd) {
    const names = x => x.name || x.full_name || id(playerId(x));
    if (!ros || !ros.fresh) {
      if (!drop) return { status:"open_slot", label:"no drop required; future roster flexibility is not priced", addContributes:null, rosDelta:null, futureWeeks:null, endWeek:null };
      return { status:"unassessed", label:"drop cost unassessed: the rest-of-season change is not priced for this swap, so no spend guidance is offered", reason: ros ? ros.reason : "remaining-season projections unavailable" };
    }
    const missing = [add, drop].filter(x => x && ros.isUnmodeled(x));
    if (missing.length) {
      const reason = `${missing.map(names).join(" and ")} ${missing.length > 1 ? "have" : "has"} no rest-of-season projection`;
      if (!drop) return { status:"open_slot", label:"no drop required; future roster flexibility is not priced", addContributes:null, rosDelta:null, futureWeeks:ros.futureWeeks, endWeek:ros.endWeek };
      return { status:"unassessed", label:"drop cost unassessed: the rest-of-season change is not priced for this swap, so no spend guidance is offered", reason };
    }
    // withAdd (R+A) depends only on the add, not the drop — the caller computes
    // it once per add (§3.5) and every drop candidate for that add reuses it.
    const addContributes = withAdd - ros.baseline;
    if (!drop) {
      if (!Number.isFinite(addContributes)) return { status:"open_slot", label:"no drop required; future roster flexibility is not priced", addContributes:null, rosDelta:null, futureWeeks:ros.futureWeeks, endWeek:ros.endWeek };
      const open = { status:"open_slot", label:"no drop required; roster flexibility is not priced", addContributes:r2(addContributes), rosDelta:r2(addContributes), futureWeeks:ros.futureWeeks, endWeek:ros.endWeek };
      if (ros.simulated) open.simulation = { nSims: ros.simulated.nSims };
      return open;
    }
    const after = ros.value(ros.roster.filter(x => id(playerId(x)) !== id(playerId(drop))).concat([add]));
    const dropForfeits = withAdd - after, rosDelta = after - ros.baseline;
    if (![withAdd, after, ros.baseline].every(Number.isFinite))
      return { status:"unassessed", label:"drop cost unassessed: the rest-of-season change is not priced for this swap, so no spend guidance is offered", reason:"roster cannot field a full lineup from modeled players in every future week" };
    const weekSpan = ros.futureWeeks === 0 ? "no future weeks remain" : `weeks ${ros.firstWeek}–${ros.endWeek}`;
    const priced = { status:"priced", label:`priced: rest-of-season lineup change over ${weekSpan}, assuming participation`,
             addContributes:r2(addContributes), dropForfeits:r2(dropForfeits), rosDelta:r2(rosDelta), futureWeeks:ros.futureWeeks, endWeek:ros.endWeek };
    if (ros.simulated) {
      priced.label = `priced: simulated rest-of-season change over ${weekSpan}, including absences and byes`;
      priced.simulation = { nSims: ros.simulated.nSims };
    }
    return priced;
  }
  // `gain` is the per-week value the bands read (move value per week, or this
  // week's gain under the fallback). Precedence, first match wins: affordability,
  // net-negative (priced only), weak, unassessed, bands.
  function bidGuide(gain, total, remaining, reserve, minBid, weak, dropCost, move) {
    let pct = [0, 0], tier = "no bid";
    if (gain > 0 && gain < 2) { pct = [0.01, 0.03]; tier = "small"; }
    else if (gain >= 2 && gain < 5) { pct = [0.04, 0.10]; tier = "useful"; }
    else if (gain >= 5) { pct = [0.11, 0.20]; tier = "impact"; }
    const affordable = Math.max(0, remaining - reserve);
    if ((move ? move.lineupGain : gain) > 0 && affordable < minBid) {
      return { low: null, high: null, tier, affordable, canAfford: false, status: "minimum bid exceeds spendable budget", label: BID_LABEL };
    }
    if (dropCost && dropCost.status === "priced" && move && move.moveValue <= 0) {
      return { low: null, high: null, tier: "drop costs more than the add returns", affordable, canAfford: true,
               status: `no bid suggested: dropping ${move.dropName} forfeits ${fmt(dropCost.dropForfeits)} rest-of-season lineup points against ${fmt(dropCost.addContributes)} from ${move.addName}`, label: BID_LABEL };
    }
    if (weak) {
      return { low: null, high: null, tier: "weak signal", affordable, canAfford: true, status: `no bid suggested: modeled gain is under ${WEAK_SIGNAL_PTS.toFixed(1)} pt/week`, label: BID_LABEL };
    }
    if (dropCost && dropCost.status === "unassessed") {
      return { low: null, high: null, tier: "drop cost unassessed", affordable, canAfford: true, status: `no bid suggested: drop cost unassessed — ${dropCost.reason}`, label: BID_LABEL };
    }
    let low = Math.min(affordable, Math.ceil(total * pct[0]));
    let high = Math.min(affordable, Math.ceil(total * pct[1]));
    if (gain > 0) { low = Math.max(minBid, low); high = Math.max(low, high); }
    return { low, high, tier, affordable, canAfford: true, status: null, label: BID_LABEL };
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
    const fullStarterSlots = league.roster_positions.map(s => String(s).toUpperCase()).filter(s => !BENCH.has(s));
    const now = finite(args.now === undefined ? Date.now() : args.now);
    const snapshotAt = finite(args.snapshotAt === undefined ? now : args.snapshotAt);
    if (now === null || snapshotAt === null) fail("now and snapshotAt must be millisecond timestamps");
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
    let ownActiveCount = 0;
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
          ownActiveCount++;
          const p = boardById.get(pid); if (p) ownActive.push(p); else unknownOwned.push(pid);
        });
      }
    });
    const weekly = weeklyMap(args.weekly, league, args.week, boardByGsis, warnings, now);
    const activeSkills = ownActive.filter(p => SKILL.has(position(p)));
    const ownedCoverage = {
      activeOwnedSkills: activeSkills.length,
      projectedOwnedSkills: weekly.fresh ? activeSkills.filter(p => weekly.map.has(id(playerId(p)))).length : null,
      missingOwnedWeekly: weekly.fresh ? activeSkills.filter(p => !weekly.map.has(id(playerId(p))))
        .map(p => ({id:id(playerId(p)), name:p.name || p.full_name || id(playerId(p))})) : [],
      unmappedOwnedIds: [...unknownOwned]
    };
    const blocked = reason => ({
      recommendationBlock: reason, rows: [], warnings: [...warnings, reason],
      waiver: { type: rolling ? "rolling" : "faab", priority: finite(mine.settings && mine.settings.waiver_position), guidance: "Research only; immediate claim recommendations withheld." },
      budget: rolling ? null : { total: budgetTotal, used, remaining, reserve, spendable: Math.max(0, remaining - reserve) },
      roster: { rosterId, playerIds: [...validateIds(mine.players || [], "roster players")], protectedIds: [...protectedIds], lockedReserveTaxiIds: [...ownLocked], unknownOwnedIds: unknownOwned },
      coverage: { ...ownedCoverage, boardPlayers: board.players.length, ownedPlayers: owned.size, freeAgentsScored: 0, dropCandidates: 0, weeklyFresh: weekly.fresh, weeklyMatched: weekly.map.size, scoringLabel: "RESEARCH ONLY — immediate recommendations withheld",
        ros: { fresh:false, reason:"recommendations withheld", endWeek:null, futureWeeks:null, generatedAt:null, dataThrough:null, pricedOwned:null, unmodeledOwned:[], pricedFreeAgents:null, evaluation:null } }
    });
    if (!weekly.fresh && league.status === "in_season")
      return blocked(`${weekly.reason}; fresh aligned weekly data required for in-season recommendations. No preseason-based bids or lineup gains supplied.`);
    const kickoffs = weekly.fresh ? kickoffMap(args.kickoffs, league, args.week, now) : { fresh:false, starts:new Map(), covered:new Set(), reason:null };
    if (weekly.fresh && !kickoffs.fresh) fail(`${kickoffs.reason}; refresh required`);
    if (weekly.fresh && unknownOwned.length) fail(`${unknownOwned.length} owned player(s) missing from board; refresh player data`);
    if (weekly.fresh && ownActive.some(p => SKILL.has(position(p)) && (!playerTeam(p) || !kickoffs.covered.has(playerTeam(p))))) fail("unknown team/schedule for owned player; refresh player data");
    if (weekly.fresh && ownActive.some(p => SKILL.has(position(p)) && weekly.invalidTeamIds.has(id(playerId(p))))) fail("owned player projection team does not match current team; refresh projections");
    if (unknownOwned.length) warnings.push(`${unknownOwned.length} owned player(s) missing from board; excluded from drops and lineup analysis may be incomplete`);
    if (!weekly.fresh && !warnings.some(w => /preseason proxy/.test(w))) warnings.push(`${weekly.reason}; using preseason proxy`);
    const missingWeekly = [...boardById.values()].filter(p => SKILL.has(position(p)) && !weekly.map.has(id(playerId(p)))).length;
    if (weekly.fresh && missingWeekly) warnings.push(`${missingWeekly} skill player(s) lack a current weekly projection and are excluded from weekly comparisons`);
    const unavailable = p => UNAVAILABLE.has(String(p.injury_status || p.status || "").toUpperCase());
    const remainingWeeks = Math.max(1, 18 - (finite(args.week) || 1));
    const score = p => {
      const pid = id(playerId(p));
      if (weekly.fresh) {
        if (unavailable(p)) return 0;
        if (kickoffs.covered.has(playerTeam(p)) && !kickoffs.starts.has(playerTeam(p))) return 0;
        return weekly.map.has(pid) ? weekly.map.get(pid) : null;
      }
      const v = boardPoints(p);
      if (v === null) return null;
      const bye = finite(p.bye ?? p.bye_week);
      const playableWeeks = bye !== null && bye >= (finite(args.week) || 1) && bye <= 17
        ? remainingWeeks - 1 : remainingWeeks;
      return (v / 17) * Math.max(0, playableWeeks);
    };
    const started = new Set(), startedBench = new Set(), lockedStarterIds = new Set(), lockedModeledSlots = new Set();
    if (weekly.fresh) {
      if (!Array.isArray(mine.starters) || mine.starters.length !== fullStarterSlots.length) fail("current starters must align with every starting roster position");
      const starters = mine.starters.map(id);
      const realStarters = starters.filter(pid => pid !== "0");
      if (new Set(realStarters).size !== realStarters.length) fail("current starters contain duplicate player ids");
      if (realStarters.some(pid => !validateIds(mine.players || [], "roster players").has(pid) || ownLocked.has(pid))) fail("current starters must be owned active non-reserve players");
      ownActive.filter(p => SKILL.has(position(p))).forEach(p => {
        const pid = id(playerId(p)), t = playerTeam(p);
        if (!t || !kickoffs.covered.has(t)) fail(`unknown team/schedule for owned player ${p.name || pid}`);
        const at = kickoffs.starts.get(t);
        if (at === undefined || now < at) return; // no game is a covered bye
        if (snapshotAt < at) fail("a game started since the roster was loaded; refresh required");
        started.add(pid);
        const fullIndex = starters.indexOf(pid);
        if (fullIndex < 0) { startedBench.add(pid); return; }
        const slot = fullStarterSlots[fullIndex];
        if (!SLOT_ELIGIBLE[slot] || !SLOT_ELIGIBLE[slot].has(position(p))) fail(`started player ${p.name || pid} is in an incompatible lineup slot`);
        lockedStarterIds.add(pid);
        if (slot !== "K" && slot !== "DEF") {
          const modeledIndex = fullStarterSlots.slice(0, fullIndex + 1).filter(s => s !== "K" && s !== "DEF").length - 1;
          lockedModeledSlots.add(modeledIndex);
        }
      });
      if (lockedStarterIds.size) warnings.push(`${lockedStarterIds.size} started starter(s) locked to their exact lineup slots; their constant contribution cancels from transaction gains`);
    }
    const remainingStarterSlots = starterSlots.filter((s, i) => !lockedModeledSlots.has(i));
    const availableOwn = ownActive.filter(p => !startedBench.has(id(playerId(p))) && !lockedStarterIds.has(id(playerId(p))));
    const unknownContributors = weekly.fresh ? availableOwn.filter(p => SKILL.has(position(p)) && score(p) === null) : [];
    if (unknownContributors.length) return blocked(`Owned players lack a current weekly projection: ${unknownContributors.map(p => p.name || playerId(p)).join(", ")}. They are protected from drops; lineup gains withheld because their contribution is unknown.`);
    const baseline = lineupScore(availableOwn, remainingStarterSlots, score);
    if (!Number.isFinite(baseline)) fail("owned roster cannot fill every required starting position with known finite scores");
    const mapped = p => playerId(p) !== null && playerId(p) !== undefined;
    const injuredFreeAgents = board.players.filter(p => mapped(p) && !owned.has(id(playerId(p))) && SKILL.has(position(p)) && unavailable(p));
    // An injury designation is not a ROS forecast. In a fresh upcoming-week
    // view it does, however, make the add non-actionable; stash analysis is a
    // separate user decision and must not masquerade as immediate improvement.
    const freeAgents = board.players.filter(p => {
      if (!mapped(p) || owned.has(id(playerId(p))) || !SKILL.has(position(p)) || score(p) === null || (weekly.fresh && unavailable(p))) return false;
      if (!weekly.fresh) return true;
      const t = playerTeam(p), at = kickoffs.starts.get(t);
      return !!t && kickoffs.covered.has(t) && at !== undefined && now < at;
    });
    if (weekly.fresh && injuredFreeAgents.length) warnings.push(`${injuredFreeAgents.length} unavailable free agent(s) excluded from immediate weekly recommendations; review separately for stash value`);
    const missingDropScores = ownActive.filter(p => SKILL.has(position(p)) && score(p) === null);
    if (weekly.fresh && missingDropScores.length) warnings.push(`${missingDropScores.length} owned player(s) lack a current weekly projection and are protected from drops`);
    const droppable = ownActive.filter(p => SKILL.has(position(p)) && score(p) !== null && !started.has(id(playerId(p))) && !protectedIds.has(id(playerId(p))) && !ownLocked.has(id(playerId(p))));
    const hasOpenSlot = ownActiveCount < activeRosterCapacity(league);
    // Rest-of-season context. Future weeks have no locked starters, so the
    // future roster is every active skill player; a roster player unmodeled
    // in some week is excluded from that week's lineup (never zeroed) and
    // reported, not silently absorbed.
    const rosMap = weekly.fresh ? remainingMap(args.remaining, league, args.week, boardByGsis, now)
                                : { fresh:false, reason:"preseason proxy mode; rest-of-season pricing applies in season only", at:new Map(), unmodeled:new Set(), endWeek:null, generatedAt:null, dataThrough:null, evaluation:null };
    const futureRoster = ownActive.filter(p => SKILL.has(position(p)));
    const firstFuture = (finite(args.week) || 1) + 1;
    const pointsAt = (p, w) => { const rows = rosMap.at.get(id(playerId(p))); return rows && rows.has(w) ? rows.get(w) : null; };
    const rosValue = players => { let total = 0; for (let w = firstFuture; w <= rosMap.endWeek; w++) total += lineupScore(players, starterSlots, p => pointsAt(p, w)); return total; };
    // A player absent from the payload is unmodeled exactly like one whose
    // week rows are null: no entry, no price.
    const rosUnmodeled = p => rosMap.unmodeled.has(id(playerId(p))) || !rosMap.at.has(id(playerId(p)));
    const ros = rosMap.fresh ? { fresh:true, reason:null, roster:futureRoster, value:rosValue, baseline:rosValue(futureRoster), isUnmodeled:rosUnmodeled,
                                 firstWeek:firstFuture, endWeek:rosMap.endWeek, futureWeeks:rosMap.endWeek - (finite(args.week) || 1) } : { fresh:false, reason:rosMap.reason };
    const rosUnmodeledOwned = rosMap.fresh ? futureRoster.filter(rosUnmodeled).map(p => ({ id:id(playerId(p)), name:p.name || p.full_name || id(playerId(p)) })) : [];
    if (weekly.fresh && !rosMap.fresh) warnings.push(`${rosMap.reason}; drop costs unassessed, spend guidance limited to open-slot adds`);
    if (rosUnmodeledOwned.length) warnings.push(`${rosUnmodeledOwned.length} roster player(s) have no rest-of-season projection and are excluded from future lineups: ${rosUnmodeledOwned.map(x => x.name).join(", ")}`);
    // ---- gated simulation pass --------------------------------------------
    function simulateRows(pairs) {
      const nameOf = p => p.name || p.full_name || id(playerId(p));
      const noteOf = reason => `simulation unavailable: ${reason}`;
      const annotate = (pair, reason) => {
        const dc = pair.row.dropCost;
        if (dc.status !== "priced" && dc.status !== "open_slot") return;   // already unassessed with its own reason
        const note = noteOf(reason);
        pair.row = { ...pair.row, dropCost: { ...dc, simulationNote: note }, warnings: [...(pair.row.warnings || []), note] };
      };
      const summary = { gate: "open", coarseSims: SIM.coarseSims, fineSims: SIM.fineSims, rowsSimulated: 0, fallbackReason: null };
      const fallbackAll = reason => { summary.fallbackReason = reason; pairs.forEach(pr => annotate(pr, reason)); return summary; };
      if (!ROSTERSIM) return fallbackAll("the roster simulation is not loaded");
      const weeks = []; for (let w = firstFuture; w <= rosMap.endWeek; w++) weeks.push(w);
      const specOf = p => {
        const rowsByWeek = rosMap.sim.get(id(playerId(p)));
        if (!rowsByWeek) return null;
        const wk = {};
        for (const w of weeks) { const r = rowsByWeek.get(w); if (!r) return null; wk[w] = r; }
        return { position: position(p), tag: p.injury_status || null, weeks: wk };
      };
      const invalid = p => `${nameOf(p)} has no valid rest-of-season p10/p50/p90`;
      // Roster: a lineup-unmodeled member is excluded exactly as today's lineup
      // path excludes him; one that is modeled for the lineup but not simulatable
      // blocks the whole simulation (his absence from the sim would misprice everyone).
      const rosterPlayers = {}, excluded = new Set();
      for (const p of ros.roster) {
        if (rosUnmodeled(p)) { excluded.add(id(playerId(p))); continue; }
        const sp = specOf(p);
        if (!sp) return fallbackAll(invalid(p));
        rosterPlayers[id(playerId(p))] = sp;
      }
      // Candidate adds: the highest-gain adds per position that can be simulated.
      const hasRow = new Map();
      pairs.forEach(({ e }) => { const k = id(playerId(e.add)); hasRow.set(k, Math.max(hasRow.get(k) ?? -Infinity, e.gain)); });
      const byId = new Map(pairs.map(({ e }) => [id(playerId(e.add)), e.add]));
      const candidates = new Map(), perPos = {};
      [...hasRow].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).forEach(([k]) => {
        const add = byId.get(k), pos = position(add);
        if (rosUnmodeled(add) || !specOf(add)) return;
        perPos[pos] = (perPos[pos] || 0) + 1;
        if (perPos[pos] <= SIM.candidatesPerPosition) candidates.set(k, add);
      });
      // Replacement pool. Overlap decision: a candidate add is also a free agent,
      // so if he sat in the pool while also being a rostered player of the
      // roster being valued, he would fill his own slot twice. Every add that has
      // a row on the desk is therefore left out of the pool (one world for the
      // whole desk load, so common random numbers survive). Replacement level is
      // the best free agent who is not himself an add candidate.
      const need = {};
      for (const pos of ["QB", "RB", "WR", "TE"]) {
        const ded = starterSlots.filter(s => s === pos).length, flex = starterSlots.filter(s => s === "FLEX").length, sflex = starterSlots.filter(s => s === "SUPER_FLEX").length;
        need[pos] = pos === "QB" ? ded + sflex : ded + flex + sflex;
      }
      const poolPlayers = board.players.filter(p => mapped(p) && !owned.has(id(playerId(p))) && SKILL.has(position(p)) && !unavailable(p) && !hasRow.has(id(playerId(p))));
      const replacement = {};
      for (const w of weeks) {
        const by = { QB: [], RB: [], WR: [], TE: [] };
        for (const p of poolPlayers) {
          const r = (rosMap.sim.get(id(playerId(p))) || new Map()).get(w);
          if (r && r.status === "play") by[position(p)].push({ id: id(playerId(p)), p10: r.p10, p50: r.p50, p90: r.p90 });
        }
        for (const pos of Object.keys(by)) by[pos] = by[pos].sort((x, y) => y.p50 - x.p50 || (x.id < y.id ? -1 : 1)).slice(0, need[pos]).map(({ p10, p50, p90 }) => ({ p10, p50, p90 }));
        replacement[w] = by;
      }
      const world = (nSims, adds) => {
        const players = { ...rosterPlayers };
        adds.forEach(a => { players[id(playerId(a))] = specOf(a); });
        return ROSTERSIM.createWorld({ weeks, slots: starterSlots, players, availability: args.availability, replacement, nSims, seed: SIM.seed });
      };
      const simRosOf = (w, nSims) => {
        const value = ps => w.value(ps.map(x => id(playerId(x))).filter(k => !excluded.has(k))).mean;
        const memo = new Map();
        const sr = { ...ros, value, simulated: { nSims }, withAdd: add => { const k = id(playerId(add)); if (!memo.has(k)) memo.set(k, value(ros.roster.concat([add]))); return memo.get(k); } };
        sr.baseline = value(ros.roster);
        return sr;
      };
      const reprice = (pair, sr) => { pair.row = buildRow(pair.e, dropCostOf(pair.e.drop, pair.e.add, sr, sr.withAdd(pair.e.add))); };
      // Which rows are priced: the highest-gain rows overall and per position (the
      // views the desk can show), restricted to candidate adds. The rest keep the
      // lineup-only price and say why.
      const eligible = pairs.filter(pr => candidates.has(id(playerId(pr.e.add))));
      const priceSet = new Set(eligible.slice(0, SIM.coarseRows));
      const seenPos = {};
      eligible.forEach(pr => { const pos = position(pr.e.add); seenPos[pos] = (seenPos[pos] || 0) + 1; if (seenPos[pos] <= SIM.coarseRowsPerPosition) priceSet.add(pr); });
      const fineSet = eligible.filter(pr => priceSet.has(pr)).slice(0, SIM.fineRows);
      try {
        // Pass 1 (coarse): every row in the price set, one world holding the roster and every candidate add.
        const coarse = simRosOf(world(SIM.coarseSims, [...candidates.values()]), SIM.coarseSims);
        for (const pr of priceSet) reprice(pr, coarse);
        // Pass 2 (fine): the leading rows again at 2000 sims, same seed and same replacement pool.
        if (fineSet.length) {
          const fine = simRosOf(world(SIM.fineSims, [...new Map(fineSet.map(pr => [id(playerId(pr.e.add)), pr.e.add])).values()]), SIM.fineSims);
          for (const pr of fineSet) reprice(pr, fine);
        }
      } catch (e) {
        if (!isSimError(e)) throw e;
        return fallbackAll(e.message);
      }
      summary.rowsSimulated = priceSet.size;
      for (const pr of pairs) {
        if (priceSet.has(pr)) continue;
        const add = pr.e.add, k = id(playerId(add));
        if (rosUnmodeled(add)) continue;
        if (!specOf(add)) annotate(pr, invalid(add));
        else if (!candidates.has(k)) annotate(pr, `${nameOf(add)} is outside the ${SIM.candidatesPerPosition} highest-gain ${position(add)} candidates`);
        else annotate(pr, "row is outside the highest-gain rows priced by the simulation");
      }
      return summary;
    }
    const entries = [];
    const collect = (add, drop) => {
      const next = availableOwn.filter(p => !drop || id(playerId(p)) !== id(playerId(drop))).concat([add]);
      const result = lineupScore(next, remainingStarterSlots, score);
      if (!Number.isFinite(result)) return;
      const gain = Math.round((result - baseline) * 100) / 100;
      if (gain <= 0) return;
      entries.push({ add, drop, gain });
    };
    // R+A is the same roster value whichever drop is under consideration;
    // computed once per add (§3.5), lazily, and only for adds that have a row.
    const withAddMemo = new Map();
    const withAddOf = add => {
      const key = id(playerId(add));
      if (!withAddMemo.has(key)) withAddMemo.set(key, ros.fresh && !ros.isUnmodeled(add) ? ros.value(ros.roster.concat([add])) : null);
      return withAddMemo.get(key);
    };
    const buildRow = (entry, dropCost) => {
      const { add, drop, gain } = entry;
      const valueEstimate = boardPoints(add);
      const addName = add.name || add.full_name || id(playerId(add));
      const dropName = drop ? (drop.name || drop.full_name || id(playerId(drop))) : null;
      const priced = dropCost.rosDelta !== null && dropCost.rosDelta !== undefined;
      const moveValue = priced ? r2(gain + dropCost.rosDelta) : null;
      const basis = !weekly.fresh ? "proxy" : priced ? "move" : "this_week";
      const perWeekGain = basis === "proxy" ? Math.round((gain / remainingWeeks) * 100) / 100
        : basis === "move" ? r2(moveValue / (dropCost.futureWeeks + 1)) : gain;
      const netNegative = dropCost.status === "priced" && moveValue <= 0;
      const weak = !netNegative && perWeekGain < WEAK_SIGNAL_PTS;
      const unassessed = dropCost.status === "unassessed";
      const span = priced ? (dropCost.futureWeeks === 0 ? "no future weeks remain" : `weeks ${firstFuture}–${dropCost.endWeek}`) : null;
      const signal = {
        strength: weak ? "weak" : "modeled", perWeekGain, thresholdPerWeek: WEAK_SIGNAL_PTS, moveValue, basis,
        label: weak
          ? `weak signal: under ${WEAK_SIGNAL_PTS.toFixed(1)} projected pt/week, below the conservative product threshold — research only, not a bid or priority claim`
          : basis === "move"
            ? "modeled lineup gain this week plus rest-of-season lineup change; projection error is not quantified and no claim-success probability is implied"
            : "modeled lineup gain; projection error is not quantified and no claim-success probability is implied",
        guidance: netNegative
          ? (rolling ? `research only: no priority claim suggested; dropping ${dropName} forfeits ${fmt(dropCost.dropForfeits)} rest-of-season lineup points against ${fmt(dropCost.addContributes)} from ${addName}`
                     : `no bid suggested; dropping ${dropName} forfeits ${fmt(dropCost.dropForfeits)} rest-of-season lineup points against ${fmt(dropCost.addContributes)} from ${addName}`)
          : weak
            ? (rolling ? "research only: no priority claim suggested; assess the drop cost independently before any move" : "no bid suggested; assess the drop cost independently before any move")
            : unassessed
              ? (rolling ? "research only: no priority claim suggested; the dropped player's rest-of-season cost is not priced, so assess the drop cost independently before any move" : "no bid suggested; the dropped player's rest-of-season cost is not priced, so assess the drop cost independently before any move")
              : (rolling ? "rank by value and roster need" : "heuristic bid range")
      };
      const rosterCost = drop
        ? (dropCost.status === "priced"
            ? `dropping ${dropName} forfeits ${fmt(dropCost.dropForfeits)} projected lineup points over ${span}; ${addName} adds ${fmt(dropCost.addContributes)} in his place`
            : `dropping ${dropName} costs their rest-of-season value, which this desk does not price`)
        : (priced
            ? `uses an open roster spot; ${addName} adds ${fmt(dropCost.addContributes)} over ${span}; roster flexibility is not priced`
            : `uses an open roster spot; ${addName}'s rest-of-season contribution is not priced; roster flexibility is not priced`);
      return {
        add: { id: id(playerId(add)), name: addName, position: position(add) },
        drop: drop ? { id: id(playerId(drop)), name: dropName, position: position(drop) } : null,
        lineupGain: gain,
        scoring: { source: weekly.fresh ? "weekly" : "preseason_proxy", label: weekly.fresh ? `week ${args.week} projection` : "ROUGH REST-OF-SEASON PRESEASON PROXY — not a live projection" },
        availability: { status: String(add.injury_status || add.status || "").toUpperCase() || null, actionableNow: !unavailable(add), warning: unavailable(add) ? "injury designation: stash/review, not an immediate-week recommendation" : null },
        valueEstimate: { points: valueEstimate, label: "board value estimate; not a FAAB price" },
        signal, rosterCost, dropCost,
        bid: rolling ? null : bidGuide(perWeekGain, budgetTotal, remaining, reserve, minBid, weak, dropCost, { lineupGain: gain, moveValue, addName, dropName })
      };
    };
    freeAgents.forEach(add => {
      if (hasOpenSlot) collect(add, null);
      else droppable.forEach(drop => collect(add, drop));
    });
    const pairs = entries.map(e => ({ e, row: buildRow(e, dropCostOf(e.drop, e.add, ros, withAddOf(e.add))) }));
    pairs.sort((a, b) => b.row.lineupGain - a.row.lineupGain || (b.row.valueEstimate.points || -Infinity) - (a.row.valueEstimate.points || -Infinity));
    // Gate open: re-price the leading rows through the season simulation. Gate
    // closed, or no fresh rest-of-season payload: nothing below runs and every
    // row is exactly what the lineup-only path priced.
    const gateSlug = args.leagueSlug !== undefined ? args.leagueSlug : (board.league && board.league.slug);
    const simGate = ros.fresh && waiverGateOpen(args.evalFile, { slug: gateSlug, roster_positions: league.roster_positions });
    let simSummary = null;
    if (simGate) simSummary = simulateRows(pairs);
    const rows = pairs.map(x => x.row);
    if (!rows.length) warnings.push("no positive legal skill-player waiver transaction found");
    const weakRows = rows.filter(r => r.signal.strength === "weak").length;
    if (weakRows) warnings.push(`${weakRows} alternative(s) gain under ${WEAK_SIGNAL_PTS.toFixed(1)} projected pt/week and are shown for research only; no bid or priority spend is suggested for them`);
    const unassessedRows = rows.filter(r => r.signal.strength !== "weak" && r.dropCost.status === "unassessed").length;
    if (unassessedRows) warnings.push(`${unassessedRows} alternative(s) require a drop whose rest-of-season cost is not priced; the gain is shown for research but no bid or priority spend is suggested for them`);
    const negativeRows = rows.filter(r => r.dropCost.status === "priced" && r.signal.moveValue <= 0).length;
    if (negativeRows) warnings.push(`${negativeRows} alternative(s) would forfeit more rest-of-season lineup value than the add returns; the numbers are shown but no bid or priority spend is suggested for them`);
    const pricedRows = rows.filter(r => r.dropCost.status === "priced" && r.signal.moveValue > 0).length;
    if (pricedRows) warnings.push(`${pricedRows} required-drop alternative(s) priced on this week's gain plus the rest-of-season lineup change`);
    return {
      waiver: { type: rolling ? "rolling" : "faab", priority: finite(mine.settings && mine.settings.waiver_position), guidance: rolling ? "Order claims by value and roster need; current priority is context, not a claim-success probability." : "Bid ranges are budgeting heuristics, not claim-success probabilities." },
      budget: rolling ? null : { total: budgetTotal, used, remaining, reserve, spendable: Math.max(0, remaining - reserve) },
      warnings, rows,
      roster: { rosterId, playerIds: [...validateIds(mine.players || [], "roster players")], protectedIds: [...protectedIds], lockedReserveTaxiIds: [...ownLocked], unknownOwnedIds: unknownOwned },
      coverage: { ...ownedCoverage, boardPlayers: board.players.length, ownedPlayers: owned.size, freeAgentsScored: freeAgents.length, dropCandidates: droppable.length, weeklyFresh: weekly.fresh, weeklyMatched: weekly.map.size, scoringLabel: weekly.fresh ? "fresh weekly projection" : "rough rest-of-season preseason proxy",
        ros: { fresh: !!ros.fresh, reason: ros.fresh ? null : ros.reason, endWeek: ros.fresh ? ros.endWeek : null, futureWeeks: ros.fresh ? ros.futureWeeks : null,
               generatedAt: rosMap.generatedAt, dataThrough: rosMap.dataThrough,
               pricedOwned: ros.fresh ? futureRoster.length - rosUnmodeledOwned.length : null, unmodeledOwned: rosUnmodeledOwned,
               pricedFreeAgents: ros.fresh ? freeAgents.filter(p => !rosUnmodeled(p)).length : null,
               evaluation: rosMap.evaluation, ...(simSummary ? { simulation: simSummary } : {}) } }
    };
  }
  return Object.freeze({ analyze, waiverGateOpen, SIM });
});
