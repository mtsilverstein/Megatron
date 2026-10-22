/* Waiver desk controller (any-league spec §7.1, §7.2, §5.1, §5.2, §6.1,
   §6.2, §3.2, §3.3). Any Sleeper league, by id, read-only.

   Statics, once per document (a failure retries on the next load): the
   league-neutral batch (LeagueData.loadBatch) and the optional reference
   files data/roles.json, data/kickoffs.json, data/ros-ecr.json. No draft
   board, no per-league remaining file, no simulation inputs: simulation is
   off for everyone in phase 1 (spec §6.2).

   The live world (league, rosters, the roster under analysis: the owner's
   own or the team a viewer chose, plus the week's transactions) comes from
   loadWorld = LiveWorld.resolve over the committed Session bundle. Every NEW
   bundle (a load, a refresh that re-read the league settings, an identity
   change, a view choice) recomputes the league views and the desk; bundles
   are compared by identity, never by generation.

   Two timestamps, two jobs: the engine's kickoff gate gets
   snapshotAt = bundle.rostersRequestedAt (PRE-request) and the 60 s UI
   expiry reads bundle.rostersFetchedAt (POST-fetch). The 15 s tick only
   re-evaluates the committed snapshot; nothing here polls.

   Best ball or an unknown starting slot: projections and rest-of-season
   values only, no shortlist. Viewers see "Viewing {team}"; drop
   protections and bid/claim guidance are the owner's. */
(function () {
  "use strict";
  const dep = (name, path) => typeof window !== "undefined" && window[name]
    ? window[name] : typeof require === "function" ? require(path) : null;
  const Sleeper = dep("Sleeper", "./sleeper.js");
  const LiveWorld = dep("LiveWorld", "./liveworld.js");
  const LeagueData = dep("LeagueData", "./leaguedata.js");

  const COPY = Object.freeze({
    simulationOff: "Simulation is off: the 2025-season test failed (on synthetic 15-player rosters), and the per-format 2026 test reports in January 2027.",
    bestBall: "Best-ball scoring picks your top scorers after the games; lineup advice doesn't apply.",
    noEvidence: "No measured evaluation for your league's scoring and this model.",
    horizon: "through NFL week 17, regardless of your league's schedule",
    aggregation: "sum of weekly medians through NFL week 17, not a season median",
    heuristic: n => `${n}-point threshold in your league's points (a heuristic)`,
    ecr: "PPR reference ranking",
    ownerOnly: "Claim guidance is for the team's owner.",
  });
  const ROS_METRIC = "rest_of_season_points_mae";
  // Rosters older than this (from the post-fetch time) are marked stale.
  const STALE_MS = 60000;

  function requestedWeek(value, state, season) {
    const automatic = !String(value ?? "").trim();
    if (automatic && (String(state?.season) !== String(season) || state?.season_type !== "regular"))
      throw new Error("Current NFL week unavailable for this season. Choose a week explicitly for research.");
    const week = Number(automatic ? state?.week : value);
    if (!Number.isInteger(week) || week < 1 || week > 18) throw new Error("Week must be an integer from 1 to 18.");
    return week;
  }

  // Live world for the desk: the shared resolver (LiveWorld.resolve -- league,
  // rosters and the roster under analysis, owner or viewer, from the session
  // bundle; it never fetches) plus the week's transactions and the waiver-type
  // check. The league id is the LIVE bundle's. The only network call is the
  // week's transactions, unless the caller already fetched them atomically
  // with the rosters through Session.refresh({ also }) and they ride on
  // `bundle.extra` as { week, transactions } for THIS week. Two timestamps
  // pass through untouched: `requestedAt` (pre-request number, the engine's
  // kickoff gate) and `fetchedAt` (post-fetch ISO string, the 60 s UI expiry);
  // nothing here reads a clock. No board and no published contract: the
  // league is scored by its own live settings (spec §5.3).
  const WAIVER_TYPES = [0, 1, 2];  // rolling priority, reverse standings, FAAB
  async function loadWorld({ bundle, week, get = path => Sleeper.get(path) }) {
    const world = LiveWorld.resolve({ bundle, week });
    const waiverType = world.league.settings?.waiver_type;
    if (!WAIVER_TYPES.includes(waiverType))  // strict, like LeagueData.leagueType: Sleeper sends numbers
      throw new Error("Only rolling-priority, reverse-standings and FAAB waiver leagues are supported.");
    const leagueId = String(world.league.league_id || "");
    if (!leagueId) throw new Error("Sleeper returned incomplete league data.");
    const cached = bundle.extra;
    const transactions = cached && Number(cached.week) === week && Array.isArray(cached.transactions)
      ? cached.transactions : await get(`/league/${leagueId}/transactions/${week}`);
    if (!Array.isArray(transactions)) throw new Error("Sleeper returned incomplete transaction data.");
    return { ...world, transactions };
  }

  // The `also` hook for Session.refresh on the waiver desk: the week's
  // transactions, fetched in the refresh's generation BEFORE the new bundle
  // commits. Its value lands on bundle.extra and loadWorld reads it back for
  // the same week instead of fetching again.
  async function transactionsAlso(parts, get, week) {
    const transactions = await get(`/league/${parts.league.league_id}/transactions/${week}`);
    if (!Array.isArray(transactions)) throw new Error("Sleeper returned incomplete transaction data.");
    return { week, transactions };
  }

  async function loadSignals(get = path => Sleeper.get(path)) {
    const [add, drop] = await Promise.all(["add", "drop"].map(type =>
      get(`/players/nfl/trending/${type}?lookback_hours=24&limit=100`).catch(() => null)));
    return { add, drop, fetchedAt:new Date().toISOString() };
  }

  // The league view's board, hydrated with the catalog's injury tag and
  // current team (the projection team stays as `team`, so the engine's
  // wrong-team guard still fires), plus every live roster/reserve/taxi
  // occupant the board does not price (K, DEF, IDP, teamless, identity-only)
  // from LeagueData.rosterIdentities: identity only, never a score, so
  // ownership and roster capacity are never erased (spec §3.4). An id the
  // catalog does not know stays off the board: the engine refuses it by name.
  function hydrateBoard(board, catalog, rosters, view) {
    const cat = catalog || {};
    const players = board.players.map(p => ({ ...p,
      injury_status: cat[p.sleeper_id]?.injury_status || null,
      current_team: cat[p.sleeper_id]?.team || null,
    }));
    const mapped = new Set(players.map(p => String(p.sleeper_id)));
    for (const who of LeagueData.rosterIdentities(rosters, cat, view).values()) {
      if (who.unknown || mapped.has(who.sleeper_id)) continue;
      mapped.add(who.sleeper_id);
      players.push({ sleeper_id: who.sleeper_id, name: who.name, position: who.position,
        team: who.team, current_team: who.team, injury_status: cat[who.sleeper_id]?.injury_status || null,
        identity_only: true, reason: who.reason ?? null });
    }
    return { ...board, players };
  }

  // FAAB reserve default (spec §7.2): 20% of the league's budget, whole
  // dollars. null for rolling / reverse-standings leagues or a missing budget.
  function defaultReserve(league) {
    const s = league && league.settings;
    if (!s || Number(s.waiver_type) !== 2) return null;
    const budget = Number(s.waiver_budget);
    if (s.waiver_budget === null || s.waiver_budget === undefined || !Number.isFinite(budget) || budget < 0) return null;
    return Math.round(0.2 * budget);
  }

  // Pure row wording shared by the table and the text export so fixtures can pin
  // the exact strings. A withheld bid (low/high null) must never print as dollars.
  // opts.ownerOnly (a viewer): no bid or claim guidance at all.
  function rowText(r, result, opts) {
    const ownerOnly = !!(opts && opts.ownerOnly);
    const weak = r.signal.strength === "weak";
    const dc = r.dropCost || {};
    const priced = Number.isFinite(dc.rosDelta);
    const negative = dc.status === "priced" && Number.isFinite(r.signal.moveValue) && r.signal.moveValue <= 0;
    const held = !weak && !negative && dc.status === "unassessed";
    const sign = x => `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(2)}`;
    const dollars = r.bid && Number.isFinite(r.bid.low) && Number.isFinite(r.bid.high) ? `$${r.bid.low}–$${r.bid.high}` : null;
    const withheld = weak || held || negative;
    const bid = ownerOnly ? COPY.ownerOnly : r.bid ? (dollars ?? r.bid.status ?? "No bid suggested") : (withheld ? "No priority claim suggested" : "Set claim order in Sleeper");
    const bidNote = ownerOnly ? "" : r.bid ? r.bid.label : (withheld ? r.signal.guidance : result.waiver.guidance);
    const exportBid = ownerOnly ? COPY.ownerOnly : r.bid ? (dollars ? `heuristic bid ${dollars}` : bid) : r.signal.guidance;
    const rosPart = priced ? ` this week · ROS ${sign(dc.rosDelta)}` : "";
    const tag = weak ? " · weak signal" : held ? " · drop cost unassessed" : negative ? " · drop costs more than the add returns" : "";
    const exportRos = priced ? `; ROS ${sign(dc.rosDelta)} (wk ${(dc.endWeek - dc.futureWeeks) + 1}–${dc.endWeek})` : "";
    const exportTag = weak ? "WEAK SIGNAL" : held ? "DROP COST UNASSESSED" : negative ? "DROP COSTS MORE THAN ADD RETURNS" : "modeled";
    // Compact forms for the grouped table and the best-move card: the same
    // values and the same withheld states, shorter words. Never dollars for
    // a withheld bid; a viewer gets no bid or claim guidance at all.
    const tagText = weak ? "weak signal" : held ? "drop cost unassessed" : negative ? "drop costs more than the add returns" : "";
    const claim = ownerOnly ? "Owner's call"
      : r.bid ? (dollars ? `${dollars} · ${r.bid.tier} tier` : r.bid.canAfford === false ? `None: minimum bid exceeds spendable budget (${r.bid.tier} tier, not suggested)` : `None suggested (${r.bid.tier})`)
      : withheld ? `No priority claim (${tagText})` : "Claim: set order in Sleeper";
    const value = r.valueEstimate && r.valueEstimate.points;
    return {
      gain: `+${r.lineupGain.toFixed(2)} pts${rosPart}${tag}`,
      bid, bidNote,
      why: `${r.bid && !ownerOnly ? `${r.bid.tier} · ` : ""}${r.valueEstimate.label}`,
      dropCostNote: held ? `${dc.label}${dc.reason ? ` — ${dc.reason}` : ""}` : dc.status === "priced" ? dc.label : null,
      exportLine: `ADD ${r.add.name}; DROP ${r.drop?.name || "none"}; +${r.lineupGain.toFixed(2)} (${r.scoring.label})${exportRos}; ${exportTag}; ${exportBid}; ${r.rosterCost}${held ? `; ${dc.label}${dc.reason ? ` — ${dc.reason}` : ""}` : ""}`,
      gainShort: `+${r.lineupGain.toFixed(2)} / ${priced ? sign(dc.rosDelta) : "ROS not priced"}`,
      tagText, claim,
      rosShort: priced ? `ROS ${sign(dc.rosDelta)}` : "ROS not priced",
      whyShort: Number.isFinite(value) ? `Add's ROS value ${value.toFixed(2)}` : "Add's ROS value unknown (not zero)",
      withheld,
      // The engine's actual reason a spend suggestion is withheld (affordability
      // first, as the engine ranks it), or "" when one is attached.
      // A viewer's reason is the signal state only (the budget is the owner's).
      withheldReason: !ownerOnly && r.bid && r.bid.canAfford === false ? "minimum bid exceeds spendable budget" : tagText,
      // The engine attached a spend suggestion to this row: a dollar range
      // (FAAB) or a priority claim (rolling / reverse standings).
      suggested: r.bid ? !!dollars && r.bid.canAfford !== false : !withheld,
    };
  }

  // The claim table shows one row per added player: the engine's ranked rows
  // regrouped by add id, in the order each add first appears (its best-ranked
  // drop); that add's other drops ride along in rank order. Regrouping only:
  // no row is created, dropped, re-valued or re-ranked.
  function groupByAdd(rows) {
    const groups = [], byAdd = new Map();
    for (const r of rows || []) {
      const key = String(r.add && (r.add.id ?? r.add.name));
      const g = byAdd.get(key);
      if (g) g.others.push(r);
      else { const fresh = { add: r.add, best: r, others: [] }; byAdd.set(key, fresh); groups.push(fresh); }
    }
    return groups;
  }

  // The claim table's display limit, made explicit: the COMPLETE
  // position-filtered result is grouped first, then the top `maxAdds` adds
  // (engine order) are shown, each with every one of its drop options. The
  // card's selected add is always shown, appended if it ranks below the
  // limit. Selection and slicing only; nothing is re-valued or re-ranked.
  const MAX_ADDS = 15;
  function claimDisplay(rows, { maxAdds = MAX_ADDS, selectedAddId = null } = {}) {
    const all = groupByAdd(rows);
    const groups = all.slice(0, maxAdds);
    let appended = false;
    if (selectedAddId !== null && selectedAddId !== undefined) {
      const at = all.findIndex(g => String(g.add.id) === String(selectedAddId));
      if (at >= maxAdds) { groups.push(all[at]); appended = true; }
    }
    return { groups, totalAdds: all.length, hiddenAdds: all.length - groups.length, appended,
      rows: groups.flatMap(g => [g.best, ...g.others]) };
  }

  const NO_MOVE = "No claim recommended this week — no positive modeled lineup swap under the current protections. Do not spend simply because budget remains.";
  // The drop options for one add, as information, not a pick (owner ruling
  // 2026-10-11: no "best drop" claim). Ordered by each move's existing
  // rest-of-season lineup change (dropCost.rosDelta), highest first; an
  // unpriced move goes last; ties keep the engine's order. Sorting only.
  function orderDrops(rows) {
    const key = r => (Number.isFinite(r && r.dropCost && r.dropCost.rosDelta) ? r.dropCost.rosDelta : -Infinity);
    return (rows || []).map((r, i) => ({ r, i })).sort((a, b) => (key(b.r) - key(a.r)) || (a.i - b.i)).map(x => x.r);
  }

  // The "modeled top option" card, over the COMPLETE position-filtered
  // result: the highest-ranked ADD with a drop option that carries a spend
  // suggestion. When none does, the card says so for the selected position
  // only, with the engine's actual withheld reasons, and names the closest
  // (top-ranked) add. Wording only; every value is rowText's.
  function bestMove({ rows, result, note = null, ownerOnly = false, position = "ALL" }) {
    if (note) return { empty: true, text: note, claim: "" };
    if (!rows || !rows.length) {
      const filtered = position !== "ALL" && result && Array.isArray(result.rows) && result.rows.length;
      const text = result && result.recommendationBlock ? result.recommendationBlock
        : filtered ? `No claim option at ${position} this week under the current protections. Choose "All skill positions" to see the other options.`
        : NO_MOVE;
      return { empty: true, text, claim: "" };
    }
    // The card names the ADD only, never a single drop. An add qualifies when
    // any of its drop options carries a suggestion; a viewer's card reads the
    // signal state only (the spend guardrails are the owner's).
    const groups = groupByAdd(rows).map(g => {
      const options = orderDrops([g.best, ...g.others]);
      return { add: g.add, options, texts: options.map(r => rowText(r, result, { ownerOnly })) };
    });
    const qualifies = t => (ownerOnly ? !t.withheld : t.suggested);
    const at = groups.findIndex(g => g.texts.some(qualifies));
    const g = groups[at < 0 ? 0 : at];
    const gains = g.options.map(r => r.lineupGain);
    const lo = Math.min(...gains).toFixed(2), hi = Math.max(...gains).toFixed(2);
    const week = lo === hi ? `+${hi} pts this week` : `+${lo} to +${hi} pts this week, depending on the drop`;
    const drops = g.options.some(r => r.drop)
      ? `${g.options.length} drop option${g.options.length === 1 ? "" : "s"} — see the claim table.`
      : "No drop needed (open roster spot).";
    const move = `add ${g.add.name} (${g.add.position}) — ${week}. ${drops}`;
    const threshold = Number(rows[0].signal && rows[0].signal.thresholdPerWeek) || 1;
    // The weak-signal test is the engine's per-week MOVE value: this week's
    // gain plus the priced rest-of-season change, averaged over this week and
    // every remaining week through NFL week 17 (this week's gain alone when
    // the rest of season is not priced) -- not this week's gain by itself.
    const basis = `the ${threshold}-point-per-week heuristic for the move's value (this week's gain plus the priced rest-of-season change, averaged per week through NFL week 17; this week's gain alone where the rest of season is not priced)`;
    const scope = `the modeled ${position === "ALL" ? "" : `${position} `}options this week`;
    const reasons = [...new Set(rows.map(x => rowText(x, result, { ownerOnly }).withheldReason).filter(Boolean))]
      .map(x => (x === "weak signal" ? `weak signal: below ${basis}` : x));
    const lead = at >= 0 ? (ownerOnly ? "Top-ranked option: " : "")
      : rows.every(x => x.signal.strength === "weak")
        ? `No spend guidance for ${scope}: all are below ${basis}. Closest option: `
        : ownerOnly ? `None of ${scope} carries a modeled spend signal: each is withheld (${reasons.join("; ")}). Closest option: `
        : `No spend guidance for ${scope}: each option is withheld (${reasons.join("; ")}). Closest option: `;
    const text = `${lead}${move}`;
    // The claim line repeats only what the table row shows without a fold:
    // one status when every drop option shares it, else a pointer.
    const type = result && result.waiver && result.waiver.type;
    let claim;
    if (ownerOnly) claim = COPY.ownerOnly;
    else {
      const r = g.options[0], t = g.texts[0];
      const dollars = r.bid && Number.isFinite(r.bid.low) && Number.isFinite(r.bid.high) ? `$${r.bid.low}–$${r.bid.high}` : null;
      if (new Set(g.texts.map(x => x.claim)).size > 1) claim = "Bid or claim depends on the drop option — see the claim table.";
      else if (r.bid) claim = dollars && r.bid.canAfford !== false ? `Bid: ${dollars} (${r.bid.tier} tier; ${r.bid.label}).`
        : r.bid.canAfford === false ? `Bid: none — minimum bid exceeds spendable budget (${r.bid.tier} tier, not suggested).`
        : `Bid: none suggested (${r.bid.tier}).`;
      else claim = t.suggested ? "Claim: suggested — rank it by value and roster need when you set claim order in Sleeper." : `Claim: none suggested (${t.tagText}).`;
      if (!r.bid && type === "rolling") claim += ` Current waiver priority: ${result.waiver.priority ?? "unknown"} (context, not a claim-success probability).`;
      if (!r.bid && type === "reverse_standings") claim += " Reverse-standings priority is not modeled.";
    }
    return { empty: false, add: g.add, options: g.options, text: `${text.charAt(0).toUpperCase()}${text.slice(1)}`, claim };
  }

  // Signal badges for a claim row, read from the research radar's entry for
  // the same player (WaiverIntel.analyze). Nothing is computed here: each
  // badge is a field the radar already derived; its full text rides in title.
  function signalBadges(p, availabilityStatus) {
    const out = [];
    const status = (p && p.status) || availabilityStatus || null;
    if (p) for (const flag of p.roleFlags || []) {
      const short = /increased/.test(flag) ? "Usage rising" : /targets/.test(flag) ? "Target volume" : /carries/.test(flag) ? "Carry volume" : "Usage flag";
      out.push({ text: short, title: `Observed usage: ${flag}` });
    }
    if (p && p.adds !== null && p.adds !== undefined)
      out.push({ text: "Trending add", title: `Sleeper 24h adds ${p.adds} / drops ${p.drops ?? "Not listed"} (platform-wide, not this league)` });
    if (p && p.sameTeam && p.sameTeam.length) out.push({ text: "Same-team RB", title: `Shares RB room with ${p.sameTeam.join(", ")}; verify role` });
    if (p && p.byeCover && p.byeCover.length) out.push({ text: "Bye cover", title: `Different bye in thin ${p.position} weeks: ${p.byeCover.join(", ")}` });
    if (status) out.push({ text: status, title: "Injury tag from the session-cached Sleeper catalog, not live news", warn: true });
    return out;
  }

  // The lines above the shortlist: the format line (eligibility wins for best
  // ball), the scoring banner and footnotes, the heuristic thresholds in the
  // league's own points, and the simulation note.
  function contextLines({ format, view, waiverType }) {
    const out = [];
    if (format && format.text) out.push(format.text);
    if (view && view.disclosures) {
      if (view.disclosures.banner) out.push(view.disclosures.banner);
      for (const f of view.disclosures.footnotes || []) out.push(f);
    }
    out.push(`Weak signal: ${COPY.heuristic(1)}; a gain under it gets no bid or priority claim.`);
    if (Number(waiverType) === 2) out.push(`FAAB bid bands: ${COPY.heuristic(2)} and ${COPY.heuristic(5)}; not calibrated and not a win probability.`);
    out.push(COPY.simulationOff);
    return out;
  }

  // The rest-of-season line. The end state (no projected weeks) says so in
  // the exact copy; otherwise the horizon and the aggregation label sit
  // beside the values.
  function rosText(ros, { remainingReason, activeOwnedSkills, owner = true } = {}) {
    if (remainingReason === LeagueData.COPY.noWeeks)
      return `${LeagueData.COPY.noWeeks} Rest-of-season values and drop-cost pricing are off.`;
    const label = `Rest-of-season values. Horizon: ${COPY.horizon}. Totals: ${COPY.aggregation}.`;
    if (!ros) return label;
    if (ros.fresh) {
      return `Rest-of-season projections: weeks ${ros.endWeek - ros.futureWeeks + 1}–${ros.endWeek}; generated ${ros.generatedAt}, data through ${ros.dataThrough || "unknown"}; ${ros.pricedOwned}/${activeOwnedSkills} ${owner ? "roster" : "of this team's"} players priced.${ros.unmodeledOwned.length ? ` No rest-of-season projection: ${ros.unmodeledOwned.map(p => p.name).join(", ")}.` : ""} ${label} Values assume participation; injuries and returns are not forecast.`;
    }
    return `Rest-of-season projections unavailable${ros.reason ? ` (${ros.reason})` : ""}; drop costs are unassessed and spend guidance is limited to open-slot adds. ${label}`;
  }

  // The rest-of-season evaluation line: a measured number only when a record
  // binds to the CURRENT output (LeagueData.evidenceFor: the league's
  // effective scoring and this model's method), else the fallback (spec §3.2).
  function evidenceLines(evaluation, view) {
    const records = evaluation && Array.isArray(evaluation.records) ? evaluation.records : [];
    for (const r of records) {
      if (!r || r.metric !== ROS_METRIC) continue;
      const rec = LeagueData.evidenceFor(evaluation, r.id, view && view.lens, view && view.method);
      if (!rec || !Array.isArray(rec.values)) continue;
      const num = x => Number.isFinite(x) ? x.toFixed(2) : "n/a";
      const lines = ["Rest-of-season accuracy, measured under this league's scoring and this model:"];
      for (const h of rec.values.filter(v => v && v.position === "ALL"))
        lines.push(`${h.horizon} week${h.horizon === 1 ? "" : "s"} ahead: model MAE ${num(h.model_mae)} vs baseline ${num(h.baseline_mae)} (${h.paired_player_forecasts ?? "n/a"} paired forecasts)`);
      return lines;
    }
    return [`Rest-of-season accuracy: ${COPY.noEvidence}`];
  }

  // The board as the desk may use it: every finite `ros_value` passed through
  // `gate` = LeagueData.rosValues(view, {..., policy: ROS_POLICY.waivers}) --
  // the waiver engine's own season/week/72 h/future-date and current-team
  // checks. A withheld value becomes null (so the engine's why-value and
  // tie-break fall back exactly as for an unknown value) and carries its
  // reason as `ros_withheld`; the player and his identity stay (astra I1).
  function gateRos(board, gate) {
    if (!gate || typeof gate.of !== "function") throw new Error("gateRos needs the rest-of-season gate (LeagueData.rosValues)");
    return { ...board, players: board.players.map(p => {
      if (!Number.isFinite(p.ros_value)) return p;
      const g = gate.of(p.sleeper_id);
      return g.reason ? { ...p, ros_value: null, ros_withheld: g.reason } : p;
    }) };
  }

  function watchlistText(p) {
    const ros = Number.isFinite(p.ros_value) ? ` · rest-of-season ${p.ros_value.toFixed(2)} (${COPY.aggregation})`
      : p.ros_withheld ? ` · rest-of-season withheld (${p.ros_withheld})` : "";
    return `${p.name} · ${p.position} · preseason ECR ${p.ecr} (${COPY.ecr})${ros}${p.injury_status ? ` · ${p.injury_status}` : ""}`;
  }

  function init() {
    const W = window.Waivers, I = window.WaiverIntel, S = window.Session, FC = window.FC;
    const $ = id => document.getElementById(id);
    const node = (tag, text, cls) => {
      const el = document.createElement(tag);
      if (text !== undefined) el.textContent = text;
      if (cls) el.className = cls;
      return el;
    };
    // The live region. A quiet status (the loaded desk's "who and when" line,
    // which the summary line repeats visually) stays announced but is visually
    // hidden; loading, refresh and error messages are always visible.
    // Writes only on a change: rewriting identical text into the live region
    // can re-announce it, and the 15 s tick re-runs this every time.
    const status = (text, quiet = false) => {
      const el = $("waiver-status"), cls = quiet ? "visually-hidden" : "";
      if (el.textContent !== text) el.textContent = text;
      if (el.className !== cls) el.className = cls;
    };
    // Results and everything derived from them (the summary line, the data
    // part of the method fold, the protection control) show and hide together.
    const showResults = on => {
      for (const id of ["waiver-results", "waiver-summary", "waiver-data"]) $(id).hidden = !on;
      $("waiver-protect-toggle").hidden = !snap;
      if (!snap) { $("waiver-protect").hidden = true; $("waiver-protect-toggle").setAttribute("aria-expanded", "false"); }
    };
    // Open/closed state of rebuilt fold-outs (row details, watch entries)
    // survives the 15 s re-render.
    const openKeys = new Set();
    const keepOpen = (details, key) => {
      details.open = openKeys.has(key);
      details.addEventListener("toggle", () => { if (details.open) openKeys.add(key); else openKeys.delete(key); });
      return details;
    };
    const fold = (summary, key) => { const d = keepOpen(node("details"), key); d.append(node("summary", summary)); return d; };
    let leagueRef;
    try { FC.leagueNavigation(); leagueRef = FC.inSeasonLeague(); }
    catch (error) {
      $("waiver-controls").hidden = true;
      $("waiver-results").hidden = true;
      status(error.message);
      return;
    }
    $("waiver-warning-link").addEventListener("click", () => { $("waiver-method").open = true; });
    $("waiver-show-all").addEventListener("click", () => { showAll = !showAll; if (snap && !$("waiver-results").hidden) renderRows(); });
    $("waiver-protect-clear").addEventListener("click", () => {
      if (!snap || viewer()) return;
      protectedIds.clear(); saveProtected(); renderRoster(); recompute();
      // The button hides itself; keep keyboard focus in the panel.
      // (an IR/taxi box is disabled and cannot take focus)
      const first = [...$("waiver-roster").querySelectorAll("input")].find(b => !b.disabled);
      if (first) first.focus(); else $("waiver-protect-toggle").focus();
    });
    $("waiver-protect-toggle").addEventListener("click", () => {
      const open = $("waiver-protect").hidden;
      $("waiver-protect").hidden = !open;
      $("waiver-protect-toggle").setAttribute("aria-expanded", String(open));
    });

    // ---- statics: once per document, a failure retries on the next load ----
    let batchP = null, sideP = null;
    const batch = () => batchP || (batchP = LeagueData.loadBatch().catch(e => { batchP = null; throw e; }));
    const optional = path => FC.loadJSON(path).catch(() => null);
    const side = () => sideP || (sideP = Promise.all([optional("data/roles.json"), optional("data/kickoffs.json"), optional("data/ros-ecr.json")]));

    // snap: everything one committed bundle produced (views, hydrated board,
    // world, statics). result/intel: the last engine runs over it.
    let snap = null, result = null, intel = null;
    let requestId = 0, protectedIds = new Set(), autoWeek = true;
    let currentBundle, refreshing = false, refreshError = null;
    // The next clock threshold of the committed snapshot (clockBoundary).
    let nextBoundary = Infinity;
    // FAAB reserve: the default follows the league and its budget until the
    // user types a value (an emptied box hands control back to the default).
    let reserveKey = null, userTyped = false;
    const viewer = () => !!snap && snap.world.role === "viewer";
    const playerName = id => snap?.catalog[id]?.full_name || snap?.board.players.find(p => String(p.sleeper_id) === String(id))?.name || id;
    // The COMPLETE position-filtered engine result. The display limit is
    // applied per add (claimDisplay), never by cutting an add's drop options;
    // `shownRows` are the pairs of the adds the table actually shows.
    const activeRows = () => (result?.rows || []).filter(r => $("waiver-position").value === "ALL" || r.add.position === $("waiver-position").value);
    let shownRows = [], lastView = null;
    // "Show all adds": this tab only (no storage), off on load.
    let showAll = false;
    const waiverType = () => Number(snap?.world.league.settings?.waiver_type);

    function setLink(league) {
      const link = $("waiver-league-link");
      if (!link || !league || league.league_id === undefined || league.league_id === null) return;
      link.href = `https://sleeper.com/leagues/${encodeURIComponent(String(league.league_id))}/team`;
      link.textContent = `Open ${league.name || `league ${league.league_id}`} in Sleeper`;
    }

    function applyReserveDefault(league) {
      const key = `${league.league_id}|${league.settings?.waiver_budget}`;
      if (key === reserveKey) return;
      reserveKey = key;
      if (userTyped) return;
      const d = defaultReserve(league);
      $("waiver-reserve").value = d === null ? "" : String(d);
    }

    // Drop protections are the owner's own choice: none by default (every
    // drop option already shows its rest-of-season cost), kept per league
    // and team in this browser so a refresh, a week change or a reload never
    // resets them. Nothing is sent anywhere. The viewer mode protects the
    // viewed team's starters (that owner's choice is not visible).
    const protectKey = world => `megatron.waivers.protected.v1|${world.league.league_id}|${world.rosterId}`;
    const onRoster = own => new Set((own.players || []).map(String));
    // The owner's protections for a load: the in-memory set for the same team
    // (so a browser that cannot save still keeps them across a refresh or a
    // week change), else the saved set; pruned to the roster either way, and
    // the saved copy pruned too (a player who left and returns is not
    // silently protected again).
    function ownerProtections(world, own, keep) {
      const ids = onRoster(own);
      let base = keep;
      if (!base) {
        base = [];
        try { const v = JSON.parse(localStorage.getItem(protectKey(world)) || "[]"); if (Array.isArray(v)) base = v.map(String); } catch (_) {}
      }
      const kept = new Set([...base].filter(id => ids.has(id)));
      if (kept.size !== [...base].length) writeProtected(world, kept);
      return kept;
    }
    function writeProtected(world, ids) {
      try { if (ids.size) localStorage.setItem(protectKey(world), JSON.stringify([...ids])); else localStorage.removeItem(protectKey(world)); } catch (_) {}
    }
    function saveProtected() {
      if (snap && !viewer()) writeProtected(snap.world, protectedIds);
    }

    function renderRoster() {
      const own = snap.world.rosters.find(r => r.roster_id === snap.world.rosterId);
      const locked = new Set([...(own.reserve || []), ...(own.taxi || [])]);
      // The count and Clear all cover the owner's own ticks; IR/taxi players
      // are always excluded from drops and shown ticked, but are not counted.
      const chosen = () => (own.players || []).filter(id => protectedIds.has(id) && !locked.has(id)).length;
      const setCount = () => {
        const n = viewer() ? protectedIds.size : chosen();
        $("waiver-protect-toggle").textContent = viewer() ? `Protected: ${n} starter${n === 1 ? "" : "s"} (owner's choice)` : `Protected: ${n} player${n === 1 ? "" : "s"}`;
        $("waiver-protect-clear").hidden = viewer() || !chosen();
      };
      $("waiver-roster").replaceChildren();
      setCount();
      if (viewer()) {
        $("waiver-roster").append(node("p", "Drop protections are the team owner's choice; this view protects the current starters."));
        return;
      }
      for (const id of own.players || []) {
        const label = node("label"), box = document.createElement("input");
        box.type = "checkbox"; box.checked = protectedIds.has(id) || locked.has(id); box.disabled = locked.has(id);
        label.append(box, node("span", `${playerName(id)}${locked.has(id) ? " · IR/taxi" : ""}`));
        box.addEventListener("change", () => {
          if (box.checked) protectedIds.add(id); else protectedIds.delete(id);
          saveProtected();
          setCount();
          recompute();
        });
        $("waiver-roster").append(label);
      }
    }

    // Notes identical for every row of a kind (the signal definitions, the
    // priced-on label, the bid-label caveat, the rest-of-season aggregation):
    // stated once, in How this works ("Reading the claim table"), not per
    // row. The owner-only line is the best-move card's alone (viewer mode).
    function sharedRowNotes(rows, isViewer) {
      const notes = new Set();
      const capital = s => { const t = String(s).trim(); return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`; };
      for (const r of rows) {
        notes.add(capital(`gain is the ${r.scoring.label} lineup change`));
        notes.add(capital(r.signal.label));
        if (r.dropCost?.status === "priced") notes.add(capital(`drop costs are ${r.dropCost.label}`));
        if (!isViewer && r.bid) notes.add(capital(`bid ranges: ${r.bid.label}`));
        if (!isViewer && !r.bid && rowText(r, result).bidNote === result.waiver.guidance) notes.add(capital(result.waiver.guidance));
      }
      if (rows.length) {
        notes.add("Drop options are listed with each move's rest-of-season lineup change, highest first; the order is information, not a validated best-drop pick.");
        notes.add(`Add's ROS value: ${COPY.aggregation}; not a FAAB price.`);
      }
      return [...notes];
    }

    // The long per-row text, behind the row's own fold-out.
    function rowDetailItems(r, text, shared, isViewer) {
      const items = [];
      if (!isViewer) items.push(`Claim guidance: ${text.bid}${text.bidNote && !shared.has(text.bidNote) && text.bidNote !== r.bid?.label ? ` — ${text.bidNote}` : ""}`);
      items.push(r.rosterCost);
      if (text.dropCostNote && r.dropCost?.status !== "priced") items.push(text.dropCostNote);
      if (r.availability?.warning) items.push(r.availability.warning);
      return items;
    }

    const pct = v => typeof v === "number" && Number.isFinite(v) ? `${(v*100).toFixed(1)}%` : "unknown";
    const change = v => typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${(v*100).toFixed(1)} pp` : "not comparable";
    // A radar entry's research lines (formerly the research radar's columns).
    function radarReasons(p) {
      const reasons = [];
      if (p.sameTeam.length) reasons.push(`Shares RB room with ${p.sameTeam.join(", ")}; verify role`);
      if (p.byeCover.length) reasons.push(`Different bye in ${viewer() ? "this team's" : "your"} thin ${p.position} weeks: ${p.byeCover.join(", ")}`);
      if (!reasons.length) reasons.push(p.adds !== null || p.drops !== null ? "Market activity; investigate the cause" : "Consensus watchlist; verify role and availability");
      if (p.roleFlags.length) reasons.push(...p.roleFlags);
      return reasons;
    }
    function radarDetail(p) {
      const r = p.role;
      const roleText = r ? `Observed W${r.week}: targets ${r.latest.targets ?? "unknown"}; carries ${r.latest.carries ?? "unknown"}; snap share ${pct(r.latest.snap_pct)}; target share ${pct(r.latest.target_share)}; carry share ${pct(r.latest.carry_share)}. Versus mean of prior observed weeks ${r.baseline_weeks.join(", ") || "none"}: snaps ${change(r.delta.snap_pct)}, target share ${change(r.delta.target_share)}, carry share ${change(r.delta.carry_share)}.` : "No comparable current-team usage row. Not zero opportunity.";
      return [roleText,
        `Sleeper 24h adds / drops: ${p.adds ?? "Not listed"} / ${p.drops ?? "Not listed"}`,
        `${p.rosRank === null ? "No matching live ROS rank" : `ROS overall rank ${p.rosRank} (${COPY.ecr})`}. ${p.ecr === null ? "No preseason ECR" : `Preseason ECR ${p.ecr} (${COPY.ecr})`}. ${p.projectionCovered ? "Verify snaps, role, health and the cost of your drop." : "Not on projection board; research only, no modeled price."}`];
    }
    const list = items => { const ul = node("ul", undefined, "waiver-detail-list"); for (const t of items) ul.append(node("li", t)); return ul; };

    function renderBest(rows) {
      const best = bestMove({ rows, result, note: snap.note, ownerOnly: viewer(), position: $("waiver-position").value });
      $("waiver-best-text").textContent = best.text;
      $("waiver-best-claim").textContent = best.claim;
      $("waiver-best-claim").hidden = !best.claim;
      return best;
    }

    function renderRows() {
      const body = $("waiver-table").querySelector("tbody"); body.replaceChildren();
      const rows = activeRows();
      const isViewer = viewer();
      const whose = isViewer ? "this team's" : "your";
      const weakCount = rows.filter(r => r.signal.strength === "weak").length;
      const heldCount = rows.filter(r => r.signal.strength !== "weak" && r.dropCost?.status === "unassessed").length;
      const negativeCount = rows.filter(r => r.dropCost?.status === "priced" && r.signal.moveValue <= 0).length;
      const pricedCount = rows.filter(r => r.dropCost?.status === "priced" && r.signal.moveValue > 0).length;
      // The full count sentence lives in the method fold; the table gets one line.
      $("waiver-count-detail").textContent = snap.note ? snap.note
        : rows.length ? `${rows.length} independent add/drop alternatives. Each is evaluated against ${whose} current roster, not after other claims.${weakCount ? ` ${weakCount} are weak signals: the move's value averages under ${rows[0].signal.thresholdPerWeek} point per week through NFL week 17 (this week's gain plus the priced rest-of-season change; this week's gain alone where the rest of season is not priced) — ${COPY.heuristic(rows[0].signal.thresholdPerWeek)} — kept for research; no bid or priority spend is suggested for them.` : ""}${heldCount ? ` ${heldCount} require a drop whose rest-of-season cost is not priced; the gain is shown for research but no bid or priority spend is suggested for them.` : ""}${pricedCount ? ` ${pricedCount} required-drop alternatives are priced on this week's gain plus the rest-of-season lineup change.` : ""}${negativeCount ? ` ${negativeCount} would forfeit more rest-of-season lineup value than the add returns; no bid or priority spend is suggested for them.` : ""}`
        : result?.recommendationBlock || "No positive modeled lineup swaps under the current protections. Do not spend simply because budget remains.";
      // The card reads the complete filtered result; the table shows the top
      // adds (plus the card's add) with every drop option each.
      const best = renderBest(rows);
      const view = claimDisplay(rows, { maxAdds: showAll ? Infinity : MAX_ADDS, selectedAddId: best.add ? best.add.id : null });
      const groups = view.groups;
      shownRows = view.rows; lastView = view;
      $("waiver-claims").hidden = !rows.length;
      // Above the table: two short lines, plus the display limit and its toggle when it applies.
      $("waiver-count").textContent = rows.length ? "Each row is a separate option — make one claim at a time." : "";
      const limited = view.totalAdds > MAX_ADDS;
      $("waiver-limit").hidden = !rows.length || !limited;
      $("waiver-limit-text").textContent = !limited ? ""
        : showAll ? `Showing all ${view.totalAdds} adds by this week's gain, each with every drop option.`
        : `Showing the top ${MAX_ADDS} of ${view.totalAdds} adds by this week's gain${view.appended ? ", plus the modeled top option" : ""}, each with every drop option; ${view.hiddenAdds} more ${view.hiddenAdds === 1 ? "is" : "are"} hidden.`;
      $("waiver-show-all").textContent = showAll ? `Show top ${MAX_ADDS}` : `Show all ${view.totalAdds} adds`;
      $("waiver-show-all").setAttribute("aria-pressed", String(showAll));
      $("waiver-row-notes").textContent = rows.length
        ? `Gain = this week's projected lineup change; drop options show each move's rest-of-season change (information, not a pick). Weak signal = the move's value (this week plus the priced rest of season) averages under ${rows[0].signal.thresholdPerWeek ?? 1} pt/week through week 17.`
        : "";
      const notes = sharedRowNotes(shownRows, isViewer), shared = new Set(notes);
      $("waiver-table-notes").textContent = rows.length
        ? [`${view.totalAdds} player${view.totalAdds === 1 ? "" : "s"}, ${rows.length} add/drop option${rows.length === 1 ? "" : "s"} in total, each evaluated against ${whose} current roster; showing ${groups.length} player${groups.length === 1 ? "" : "s"} and ${shownRows.length} option${shownRows.length === 1 ? "" : "s"}.`, ...notes].join(" ")
        : "";
      // The gated board (same 72 h / team / week checks as Worth watching):
      // a claim add keeps its preseason watchlist entry, withheld reasons included.
      const gatedBoard = new Map(rosBoard(snap).players.map(p => [String(p.sleeper_id), p]));
      const radarById = new Map((intel?.radar || []).map(p => [String(p.id), p]));
      for (const g of groups) {
        // Every drop option for this add, each with its own rest-of-season
        // figure; what all options share is said once in the row, what
        // differs is said with each option. No option is singled out.
        const opts = orderDrops([g.best, ...g.others]);
        const texts = opts.map(o => rowText(o, result, { ownerOnly: isViewer }));
        const one = vals => new Set(vals).size === 1;
        const sameWeek = one(opts.map(o => o.lineupGain.toFixed(2))), sameTag = one(texts.map(t => t.tagText)), sameClaim = one(texts.map(t => t.claim));
        const r = opts[0], addId = String(r.add.id);
        const tr = node("tr");
        const add = node("td"); add.append(node("strong", r.add.name), node("span", r.add.position, "waiver-row-note"));
        const drop = node("td"), dropList = node("ul", undefined, "waiver-drops");
        opts.forEach((o, i) => {
          const t = texts[i];
          dropList.append(node("li", `${o.drop ? o.drop.name : "Open roster spot (no drop)"} — ${t.rosShort}`
            + `${sameWeek ? "" : ` · this week +${o.lineupGain.toFixed(2)}`}${sameTag || !t.tagText ? "" : ` · ${t.tagText}`}${sameClaim ? "" : ` · ${t.claim}`}`));
        });
        drop.append(dropList);
        const gains = opts.map(o => o.lineupGain), lo = Math.min(...gains).toFixed(2), hi = Math.max(...gains).toFixed(2);
        const gain = node("td"); gain.append(node("span", sameWeek ? `+${hi}` : `+${lo} to +${hi}`, "waiver-num"));
        if (!sameWeek) gain.append(node("span", "varies by drop", "waiver-row-note"));
        if (sameTag && texts[0].tagText) gain.append(node("span", texts[0].tagText, "waiver-row-note"));
        const bid = node("td", sameClaim ? texts[0].claim : "Varies by drop option (listed with each drop)");
        if (isViewer) bid.title = COPY.ownerOnly;
        const radar = radarById.get(addId);
        const signals = node("td");
        const badges = signalBadges(radar, r.availability?.status);
        for (const b of badges) { const el = node("span", b.text, `waiver-badge${b.warn ? " warn" : ""}`); el.title = b.title; signals.append(el); }
        if (!badges.length) signals.append(node("span", "—", "waiver-row-note"));
        const why = node("td", texts[0].whyShort);
        why.title = r.valueEstimate.label;
        tr.append(add, drop, gain, bid, signals, why); body.append(tr);
        // The row's fold-out: each drop option's long limitation text, then
        // the research detail for the add.
        const detail = node("tr", undefined, "waiver-detail-row"), cell = node("td");
        cell.colSpan = 6; cell.setAttribute("colspan", "6");
        const d = fold("Details", `claim:${addId}`);
        opts.forEach((o, i) => {
          d.append(node("p", o.drop ? `Drop ${o.drop.name}` : "Open roster spot (no drop)", "waiver-detail-head"));
          d.append(list(rowDetailItems(o, texts[i], shared, isViewer)));
        });
        d.append(node("p", `Why: ${r.valueEstimate.label}`, "waiver-source"));
        const boardPlayer = gatedBoard.get(addId);
        if (boardPlayer && !boardPlayer.identity_only && Number.isFinite(boardPlayer.ecr))
          d.append(node("p", `Preseason watchlist: ${watchlistText(boardPlayer)}`, "waiver-source"));
        if (radar) {
          d.append(node("p", `Research (${radar.name} · ${radar.position} · ${radar.team}${radar.status ? ` · ${radar.status}` : ""}): ${radarReasons(radar).join(". ")}.`, "waiver-source"));
          d.append(list(radarDetail(radar)));
        }
        cell.append(d); detail.append(cell); body.append(detail);
      }
      renderIntel(new Set((result?.rows || []).map(r => String(r.add.id))));
    }

    // The research radar, filtered by position and sorted by the chosen
    // order. `exclude`: players already in the claim table (their research
    // detail is in their row there). The copy export reads the full radar.
    function activeRadar(exclude) {
      const position = $("waiver-position").value;
      const rows = (intel?.radar || []).filter(p => (position === "ALL" || p.position === position) && !(exclude && exclude.has(String(p.id))));
      if ($("waiver-radar-sort").value === "adds") rows.sort((a,b) => (b.adds ?? -1)-(a.adds ?? -1));
      if ($("waiver-radar-sort").value === "usage") rows.sort((a,b) => b.roleFlags.length-a.roleFlags.length || (b.role?.week || 0)-(a.role?.week || 0));
      if ($("waiver-radar-sort").value === "ros") rows.sort((a,b) => (a.rosRank ?? Infinity)-(b.rosRank ?? Infinity));
      return rows.slice(0,24);
    }

    // "Worth watching": the research radar (in the chosen order, #waiver-radar)
    // then, as an ordered list in preseason-ECR order (#waiver-watchlist), the
    // watchlist players the radar does not already list. Each entry is one
    // line; the usage numbers sit in its fold-out.
    let claimIds = new Set();
    function renderIntel(exclude) {
      if (!intel) return;
      if (exclude) claimIds = exclude;
      $("waiver-intel-source").textContent = `Sleeper trends requested ${intel.fetchedAt || "unknown time"}. ${intel.rosStatus} ${intel.warnings.join(" ")}`;
      $("waiver-role-source").textContent = intel.roleStatus;
      $("waiver-byes").replaceChildren();
      for (const r of intel.byeRisks) $("waiver-byes").append(node("li", `Week ${r.week} ${r.position}: ${r.available} available for ${r.required} required — ${r.severity}. On bye: ${r.away.join(", ")}.`));
      if (!intel.byeRisks.length) $("waiver-byes").append(node("li", "No dedicated-position bye shortfall or no-spare week found in known bye data."));
      const pool = watchPool(claimIds);
      const poolById = new Map(pool.map(p => [String(p.sleeper_id), p]));
      const out = $("waiver-radar"); out.replaceChildren();
      const ecr = $("waiver-watchlist"); ecr.replaceChildren();
      const radar = activeRadar(claimIds);
      for (const p of radar) {
        const li = node("li");
        li.append(node("span", `${p.name} · ${p.position} · ${p.team}${p.status ? ` · ${p.status}` : ""}`, "waiver-watch-name"),
          node("span", radarReasons(p).join(". "), "waiver-watch-why"));
        const d = fold("Usage and market detail", `watch:${p.id}`);
        const lines = radarDetail(p);
        const board = poolById.get(String(p.id));
        if (board) { lines.push(watchlistText(board)); poolById.delete(String(p.id)); }
        d.append(list(lines)); li.append(d); out.append(li);
      }
      for (const p of poolById.values()) ecr.append(node("li", watchlistText(p)));
      $("waiver-watchlist-head").hidden = !poolById.size;
      const n = radar.length + poolById.size;
      $("waiver-watching-count").textContent = `· ${n} available player${n === 1 ? "" : "s"}`;
      const wt = waiverType(), week = $("waiver-week").value;
      $("waiver-market").textContent = wt === 0
        ? `Selected week ${week}: rolling priority is ${result?.waiver.priority ?? snap.world.rosters.find(r => r.roster_id === snap.world.rosterId)?.settings?.waiver_position ?? "unknown"}. Research and rank claims by value; this desk does not estimate claim success.`
        : wt === 1
          ? `Selected week ${week}: reverse-standings waivers. Research and rank claims by value; this desk does not model reverse-standings priority or estimate claim success.`
          : `Selected week ${week}: ${intel.bids.length} completed waiver transaction(s) with a disclosed bid; ${intel.freeAgentMoves} completed free-agent move(s). ` +
            (intel.bids.length ? `Observed winning bids: ${intel.bids.slice(0,15).map(b => `${b.players.join(" + ") || "unknown player"} $${b.amount}`).join("; ")}. These are not minimum winning prices; losing bids are unknown.` : "No observed winning-bid sample to calibrate prices. Free-agent moves are not $0 waiver bids.");
    }

    // The gated board for THIS moment (the 72 h limit moves with the clock).
    const rosBoard = s => gateRos(s.board, LeagueData.rosValues(s.view, { league: s.world.league, week: s.week, now: Date.now(),
      catalog: s.catalog, policy: LeagueData.ROS_POLICY.waivers }));

    // The preseason watchlist pool: unrostered board players with an ECR, in
    // ECR order, minus the claim table's adds.
    function watchPool(exclude) {
      const owned = new Set(snap.world.rosters.flatMap(r => [...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])]));
      const pos = $("waiver-position").value;
      return rosBoard(snap).players.filter(p => p.sleeper_id && !owned.has(p.sleeper_id) && !p.identity_only
        && Number.isFinite(p.ecr) && (pos === "ALL" || p.position === pos) && !(exclude && exclude.has(String(p.sleeper_id))))
        .sort((a, b) => a.ecr - b.ecr).slice(0, 24);
    }

    function renderContext(s) {
      const box = $("waiver-context");
      if (!box) return;
      box.replaceChildren();
      for (const line of contextLines({ format: s.format, view: s.view, waiverType: waiverType() })) box.append(node("p", line));
    }

    function recompute() {
      if (!snap) return;
      const s = snap;
      nextBoundary = clockBoundary(s, Date.now());
      try {
        // Roster age from the POST-fetch time (bundle.rostersFetchedAt): past
        // 60 s the desk stays on screen, marked stale (claims may have
        // processed). The hard stop is the engine's kickoff gate (snapshotAt =
        // the PRE-request time): a game started since the rosters were read
        // withholds every recommendation until a refresh.
        const age = Date.now() - s.bundle.rostersFetchedAt;
        const league = s.world.league, wt = waiverType(), faab = wt === 2, isViewer = viewer();
        let reserve;
        if (faab) {
          if (!isViewer && !$("waiver-reserve").value.trim()) {
          // An emptied box hands control back to the default.
          userTyped = false;
          const d = defaultReserve(league);
          if (d !== null) $("waiver-reserve").value = String(d);
        }
        const raw = isViewer ? String(defaultReserve(league) ?? "") : $("waiver-reserve").value;
          reserve = Number(raw);
          if (!String(raw).trim() || !Number.isInteger(reserve) || reserve < 0) throw new Error("Budget reserve must be a nonnegative whole dollar amount.");
        }
        $("waiver-reserve").closest("label").hidden = !faab || isViewer;
        renderContext(s);
        const remainingReason = s.view.remainingReason === LeagueData.COPY.noWeeks ? "no projected weeks remain" : s.view.remainingReason;
        result = s.note ? null : W.analyze({ board: rosBoard(s), ...s.world, weekly: s.view.weekly, kickoffs: s.kickoffs, snapshotAt: s.bundle.rostersRequestedAt,
          remaining: s.view.remaining, remainingReason, week: s.week, protectedIds: [...protectedIds], budgetReserve: reserve });
        intel = I.analyze({ board: s.board, ...s.world, catalog: s.catalog, signals: s.signals, roles: s.roles, ros: s.rosEcr, week: s.week });
        const mine = s.world.rosters.find(r => r.roster_id === s.world.rosterId);
        // The summary line: league · week · budget or priority · data as of · whose team.
        const b = result?.budget, tie = mine.settings?.waiver_position ?? "unknown";
        const teamName = S.teamName(s.world.users, mine);
        $("waiver-summary-league").textContent = `${league.name || `League ${league.league_id}`} · Week ${s.week}`;
        $("waiver-budget").textContent = wt === 0 ? `Waiver priority ${tie} (rolling) · rank claims`
          : wt === 1 ? "Reverse-standings waivers · priority not modeled · rank claims"
          : b ? `$${b.remaining} FAAB remaining · tie priority ${tie}` : "";
        // The visible "data as of" stamp: live rosters and the projection batch.
        const generated = Date.parse(s.view.weekly?.generated_at);
        const projections = `projections through ${s.view.weekly?.data_through || "unknown"}, generated ${Number.isFinite(generated) ? new Date(generated).toLocaleDateString([], { month: "short", day: "numeric" }) : "unknown"}`;
        $("waiver-summary-data").textContent = `rosters as of ${new Date(s.world.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${projections} · ${isViewer ? `Viewing ${teamName}` : `Your team: ${teamName}`}`;
        // Signpost to the engine's warnings in the method fold.
        const nWarn = result ? result.warnings.length : 0;
        $("waiver-warning-link").hidden = !nWarn;
        $("waiver-warning-link").textContent = nWarn ? `${nWarn} data warning${nWarn === 1 ? "" : "s"} — see How this works` : "";
        $("waiver-spendable").textContent = faab && b && !isViewer ? `Keep in reserve $${b.reserve} · spendable ceiling $${b.spendable}` : "";
        const warnings = [...(result ? result.warnings : []), "League eligibility and claim processing time must be checked in Sleeper. Pending bids are not visible through the public API.", `Injury tags are a session-cached catalog snapshot (${s.catalogTime || "unknown time"}), not live news. Verify current availability separately.`];
        $("waiver-warnings").replaceChildren(); const ul = node("ul");
        for (const warning of warnings) ul.append(node("li", warning));
        $("waiver-warnings").append(ul);
        const settings = S.settingsText(s.bundle);
        $("waiver-source").textContent = `Roster snapshot requested ${new Date(s.world.requestedAt).toISOString()} (kickoff gate), received ${s.world.fetchedAt} (marked stale after 60 s). Week ${s.week}. Weekly projections: ${s.view.weekly.generated_at}, data through ${s.view.weekly.data_through || "unknown"}.${settings ? ` ${settings}.` : ""}${result ? ` ${result.coverage.scoringLabel}` : ""}`;
        const coverage = result?.coverage;
        const whose = isViewer ? "This team's" : "Your";
        $("waiver-coverage").textContent = !coverage ? ""
          : coverage.weeklyFresh
            ? `${whose} active skill roster: ${coverage.projectedOwnedSkills}/${coverage.activeOwnedSkills} have matching weekly projections. ${coverage.missingOwnedWeekly.length ? `No matching projection: ${coverage.missingOwnedWeekly.map(p => p.name).join(", ")}. ` : ""}IR/taxi and K/DEF/IDP are excluded from this count; byes and unavailable players may not need a score. ${coverage.unmappedOwnedIds.length ? `Unmapped owned IDs: ${coverage.unmappedOwnedIds.join(", ")}. ` : ""}${result.recommendationBlock || "Coverage alone does not establish forecast accuracy or player availability."}`
            : `${whose} roster projection coverage cannot be assessed until fresh, aligned weekly data is available. Research is not bid advice.`;
        $("waiver-ros").textContent = rosText(coverage ? coverage.ros : null, { remainingReason: s.view.remainingReason, activeOwnedSkills: coverage?.activeOwnedSkills, owner: !isViewer });
        const ev = $("waiver-evaluation"); ev.replaceChildren();
        for (const line of evidenceLines(s.batch.evaluation, s.view)) ev.append(node("p", line));
        showResults(true);
        const who = isViewer ? `Viewing ${teamName}` : `Connected read-only · roster ${s.world.rosterId}`;
        // The live status announces the fresh-to-stale change once: its stale
        // text is constant (no age), so the 15 s tick does not re-announce it.
        const stale = staleText(age);
        status(`${who} · rosters received ${new Date(s.world.fetchedAt).toLocaleTimeString()}. ${stale
          ? "Rosters are over a minute old and claims may have processed since; use Refresh rosters above the recommendations before placing a claim."
          : "Refresh from the league panel before placing a claim."}`, true);
        $("waiver-stale").hidden = !stale;
        if (stale) $("waiver-stale-text").textContent = stale;
        renderRows();
      } catch (error) { result = null; showResults(false); status(error.message); }
    }

    // The stale notice: past STALE_MS the rosters may be out of date, so the
    // notice (and a copied shortlist) says how old they are; the notice
    // carries its own refresh button (the chip's, with this page's options)
    // -- no trip back up the page. Null while the rosters are fresh.
    function staleText(age) {
      if (!(age > STALE_MS)) return null;
      const min = Math.floor(age / 60000);
      const ago = min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
      return `Rosters loaded ${ago} — claims may have processed since. Refresh before placing a claim.`;
    }
    $("waiver-stale-refresh").addEventListener("click", () => {
      const btn = $("waiver-stale-refresh");
      btn.disabled = true;
      FC.chip.refresh(refreshOptions()).then(() => { btn.disabled = false; });
    });

    // Clock thresholds of the committed snapshot: the engine's and the
    // research radar's answers depend on the clock only through these, so
    // between two of them a re-run would reproduce the same result. Each is
    // the first instant the outcome differs: the roster stale mark (age >
    // 60 s), a kickoff (now >= kickoff), a data file's freshness window
    // (72 h: weekly, kickoffs, remaining, roles; 7 days: the ROS ranking;
    // and the one-hour future-dated tolerance).
    function clockBoundary(s, from) {
      const H = 3600000, t = [s.bundle.rostersFetchedAt + STALE_MS + 1];
      for (const d of [s.view.weekly, s.kickoffs, s.view.remaining, s.roles]) {
        const g = Date.parse(d && d.generated_at);
        if (Number.isFinite(g)) t.push(g - H, g + 72 * H + 1);
      }
      const r = Date.parse(s.rosEcr && s.rosEcr.snapshot_at);
      if (Number.isFinite(r)) t.push(r, r + 7 * 24 * H + 1);
      for (const g of (s.kickoffs && Array.isArray(s.kickoffs.games) ? s.kickoffs.games : [])) {
        const k = Date.parse(g && g.kickoff);
        if (Number.isFinite(k)) t.push(k);
      }
      return t.reduce((m, x) => (x > from && x < m ? x : m), Infinity);
    }

    // The 15 s tick never fetches (no polling: new data arrives only through a
    // refresh or a page reload) and re-runs the engine only once a clock
    // threshold has passed; otherwise it just updates the stale notice's age.
    // The full run on every tick cost ~0.2-0.35 s of main thread on a 12-team
    // league (Opus review, 2026-10-22).
    setInterval(() => {
      if (!snap || $("waiver-results").hidden) return;
      if (Date.now() >= nextBoundary) { recompute(); return; }
      const text = staleText(Date.now() - snap.bundle.rostersFetchedAt);
      if (text && $("waiver-stale-text").textContent !== text) $("waiver-stale-text").textContent = text;
    }, 15000);

    const hideResults = () => {
      snap = null; result = null; intel = null; showResults(false);
      $("waiver-copy-status").textContent = ""; $("waiver-backup-wrap").hidden = true;
    };
    const currentWeek = bundle => requestedWeek(autoWeek ? "" : $("waiver-week").value, bundle.state, bundle.league?.season);
    // Why the desk is not showing rows: the session's error, still loading,
    // or the live resolver's own refusal in its order (league status, league
    // type, no roster under analysis). Week 1 is a placeholder: the resolver
    // only range-checks it; the real week is checked when the desk loads.
    function gateMessage(bundle) {
      const err = S.error();
      if (err) return err;
      if (!bundle) return "Loading league…";
      let msg;
      try { LiveWorld.resolve({ bundle, week: 1 }); return "Loading league…"; } catch (e) { msg = e.message; }
      if (msg === LiveWorld.NO_ANALYSIS && (bundle.myRosterStatus === "none" || bundle.myRosterStatus === "ambiguous"))
        return `${S.chipText(bundle, "ready", Date.now())} Choose a team to view in the league panel above.`;
      return msg;
    }

    // The load body: everything downstream of a committed bundle with a
    // roster under analysis. The catalog is the session's once-per-document
    // copy; views are recomputed for every bundle (live settings, spec §5.2).
    async function load(bundle) {
      const thisRequest = ++requestId;
      // A new bundle for the SAME team (a refresh, a week change) keeps the
      // current desk on screen until the new one renders: no collapse, no
      // scroll jump. Any other team, role or league clears it at once.
      const sameTeam = !!snap && !!bundle.analysisRoster && snap.bundle.analysisRole === bundle.analysisRole
        && String(snap.bundle.league?.league_id) === String(bundle.league?.league_id)
        && snap.bundle.analysisRoster?.roster_id === bundle.analysisRoster.roster_id;
      if (!sameTeam) hideResults();
      setLink(bundle.league);
      if (!bundle.analysisRoster) { status(gateMessage(bundle)); return; }
      status("Reading current rosters, waiver settings, scoring, and projections…");
      try {
        const week = currentWeek(bundle);
        const [b, [roles, kickoffs, rosEcr], world, signals, catalog] = await Promise.all([
          batch(), side(), loadWorld({ bundle, week }), loadSignals(), S.catalog(),
        ]);
        if (thisRequest !== requestId) return;
        const view = LeagueData.views(b, world.league, { week, catalog });
        const type = LeagueData.leagueType(world.league), unknown = LeagueData.slotSupport(world.league).unknown;
        const note = type.bestBall ? COPY.bestBall
          : unknown.length ? `Unsupported lineup slot: ${unknown.join(", ")} — no waiver lineup gains for this league; the projections below still apply.` : null;
        const format = await LeagueData.formatLine(world.league, b.formats);
        if (thisRequest !== requestId) return;
        // Sleeper asks clients to avoid frequent bulk-catalog requests; the
        // session fetches it once per document, dated below, not live news.
        const catalogTime = Number.isFinite(S.catalogFetchedAt()) ? new Date(S.catalogFetchedAt()).toISOString() : null;
        $("waiver-week").value = String(week);
        const board = hydrateBoard(view.board, catalog, world.rosters, view);
        const own = world.rosters.find(r => r.roster_id === world.rosterId);
        protectedIds = world.role === "viewer" ? new Set((own.starters || []).filter(id => id !== "0"))
          : ownerProtections(world, own, sameTeam ? protectedIds : null);
        applyReserveDefault(world.league);
        // A copied shortlist describes the snapshot it came from: adopting a
        // new one (even for the same team) clears it and its status.
        $("waiver-copy-status").textContent = ""; $("waiver-backup").value = ""; $("waiver-backup-wrap").hidden = true;
        snap = { bundle, world, view, board, catalog, catalogTime, roles, kickoffs, rosEcr, signals, format, note, batch: b, week };
        renderRoster(); recompute();
      } catch (error) {
        if (thisRequest !== requestId) return;
        if (S.isSuperseded(error)) return;
        hideResults(); status(`Could not load safe recommendations: ${error.message}`);
      }
    }

    // Session.onChange driver. Gated on the committed bundle and its roster
    // under analysis, never on state() === "error" alone. Only a DIFFERENT
    // committed bundle re-runs the load; a refresh that commits nothing (same
    // bundle back) says so and leaves the previous snapshot -- and snapshotAt
    // -- exactly as they were.
    function sync(snapshot) {
      const bundle = S.bundle();
      const flow = snapshot && snapshot.state;
      if (bundle !== currentBundle) {
        currentBundle = bundle; refreshing = false;
        if (!bundle) { ++requestId; hideResults(); status(gateMessage(null)); return; }
        load(bundle);
        return;
      }
      if (!bundle || !bundle.analysisRoster) { status(gateMessage(bundle)); return; }
      if (flow === "refreshing") { refreshing = true; refreshError = null; status("Refreshing rosters and this week's transactions…"); return; }
      if (refreshing && flow === "ready") {
        refreshing = false;
        if (snap) status(`Refresh did not complete${refreshError ? ` (${refreshError})` : "; see the league panel for the reason"}. The roster snapshot received ${new Date(snap.world.fetchedAt).toLocaleTimeString()} is still shown.`);
      }
    }

    // The chip's refresh on this page re-fetches the week's transactions
    // atomically with the rosters (and the league settings): if either fails,
    // nothing commits and the chip's age does not advance. The week is
    // resolved from the FRESH state inside the hook, so "auto" follows the
    // live NFL week.
    function refreshOptions() {
      return {
        scope: "league",
        also: async (parts, get) => {
          try { return await transactionsAlso(parts, get, requestedWeek(autoWeek ? "" : $("waiver-week").value, parts.state, parts.league.season)); }
          catch (error) { refreshError = error.message; throw error; }
        },
      };
    }
    FC.chip.onRefresh(refreshOptions);
    S.onChange(sync);
    // Any Sleeper league by id (spec §5.1): loaded at once, identity optional.
    FC.setLeague(leagueRef.leagueId);
    sync({ state: S.state() });

    $("waiver-week").addEventListener("change", () => {
      autoWeek = !$("waiver-week").value.trim();
      const bundle = S.bundle();
      if (bundle && bundle.analysisRoster) load(bundle);
      else { ++requestId; hideResults(); status(gateMessage(bundle)); }
    });
    $("waiver-reserve").addEventListener("input", () => { userTyped = $("waiver-reserve").value.trim() !== ""; });
    $("waiver-reserve").addEventListener("change", recompute);
    $("waiver-position").addEventListener("change", () => { if (snap && !$("waiver-results").hidden) renderRows(); });
    $("waiver-radar-sort").addEventListener("change", () => { if (intel) renderIntel(); });
    // Copy shortlist: one button. The text goes to the clipboard when the
    // browser allows it; otherwise (no clipboard API, or a refusal) the same
    // text appears in a read-only box to copy by hand. Nothing is sent anywhere.
    function shortlistText() {
      const wt = waiverType(), isViewer = viewer(), league = snap.world.league;
      const budgetLine = isViewer ? COPY.ownerOnly
        : wt === 0 ? `Current rolling priority ${result?.waiver.priority ?? "unknown"}; rank claims in Sleeper`
        : wt === 1 ? "Reverse-standings waivers; rank claims in Sleeper"
        : result ? `Remaining $${result.budget.remaining}; reserve $${result.budget.reserve}; spendable $${result.budget.spendable}` : "";
      const stale = staleText(Date.now() - snap.bundle.rostersFetchedAt);
      return [`${league.name || `League ${league.league_id}`} waiver shortlist — independent alternatives, not submitted claims`, $("waiver-source").textContent,
        ...(stale ? [`STALE: ${stale}`] : []),
        budgetLine,
        ...(!snap.note && lastView && lastView.hiddenAdds ? [`Showing the top ${MAX_ADDS} of ${lastView.totalAdds} adds; ${lastView.hiddenAdds} more not included — use Show all adds on the page.`] : []),
        ...(snap.note ? [snap.note] : shownRows.map(r => rowText(r, result, { ownerOnly: isViewer }).exportLine)),
        "RESEARCH ONLY — not an add/drop plan or bid recommendation",
        $("waiver-intel-source").textContent,
        intel.roleStatus,
        ...activeRadar().filter(p => p.role).map(p => `USAGE ${p.name}: W${p.role.week}; ${p.roleFlags.join("; ") || "no threshold flags"}; observed ${JSON.stringify(p.role.latest)}; change ${JSON.stringify(p.role.delta)}; baseline weeks ${p.role.baseline_weeks.join(",")}`),
        ...activeRadar().map(p => `${p.name} (${p.position}); ROS overall rank (${COPY.ecr}) ${p.rosRank ?? "unavailable"}; Sleeper 24h adds ${p.adds ?? "not listed"}, drops ${p.drops ?? "not listed"}; same-team RBs: ${p.sameTeam.join(", ") || "none"}; different bye in thin weeks: ${p.byeCover.join(", ") || "none"}; status ${p.status || "verify"}`),
        "Verify injury/role updates, claim deadline, total spend and drop conflicts in Sleeper."].join("\n");
    }
    $("waiver-copy").addEventListener("click", async () => {
      recompute();
      if (!snap || $("waiver-results").hidden) return;
      const text = shortlistText();
      $("waiver-backup").value = text;
      const clip = typeof navigator !== "undefined" && navigator && navigator.clipboard
        && typeof navigator.clipboard.writeText === "function" ? navigator.clipboard : null;
      if (clip) {
        try {
          await clip.writeText(text);
          $("waiver-backup-wrap").hidden = true;
          $("waiver-copy-status").textContent = "Shortlist copied to the clipboard. Nothing was sent anywhere.";
          return;
        } catch (_) { /* refused: fall back to the text box */ }
      }
      $("waiver-backup-wrap").hidden = false;
      $("waiver-copy-status").textContent = "Clipboard unavailable: copy the text below instead.";
      $("waiver-backup").focus();
      if (typeof $("waiver-backup").select === "function") $("waiver-backup").select();
    });
  }
  const api = { init, loadWorld, transactionsAlso, loadSignals, hydrateBoard, gateRos, requestedWeek, rowText, defaultReserve,
    contextLines, rosText, evidenceLines, watchlistText, groupByAdd, orderDrops, claimDisplay, bestMove, signalBadges, MAX_ADDS, COPY };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.WaiverMode = api;
})();
