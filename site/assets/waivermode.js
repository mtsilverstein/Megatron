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
    expired: "Roster snapshot expired. Refresh from the league panel before using waiver recommendations.",
  });
  const ROS_METRIC = "rest_of_season_points_mae";

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
    return {
      gain: `+${r.lineupGain.toFixed(2)} pts${rosPart}${tag}`,
      bid, bidNote,
      why: `${r.bid && !ownerOnly ? `${r.bid.tier} · ` : ""}${r.valueEstimate.label}`,
      dropCostNote: held ? `${dc.label}${dc.reason ? ` — ${dc.reason}` : ""}` : dc.status === "priced" ? dc.label : null,
      exportLine: `ADD ${r.add.name}; DROP ${r.drop?.name || "none"}; +${r.lineupGain.toFixed(2)} (${r.scoring.label})${exportRos}; ${exportTag}; ${exportBid}; ${r.rosterCost}${held ? `; ${dc.label}${dc.reason ? ` — ${dc.reason}` : ""}` : ""}`,
    };
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

  function watchlistText(p) {
    const ros = Number.isFinite(p.ros_value) ? ` · rest-of-season ${p.ros_value.toFixed(2)} (${COPY.aggregation})` : "";
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
    const status = text => { $("waiver-status").textContent = text; };
    let leagueRef;
    try { FC.leagueNavigation(); leagueRef = FC.inSeasonLeague(); }
    catch (error) {
      $("waiver-controls").hidden = true;
      $("waiver-results").hidden = true;
      status(error.message);
      return;
    }

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
    // FAAB reserve: the default follows the league and its budget until the
    // user types a value (an emptied box hands control back to the default).
    let reserveKey = null, userTyped = false;
    const viewer = () => !!snap && snap.world.role === "viewer";
    const playerName = id => snap?.catalog[id]?.full_name || snap?.board.players.find(p => String(p.sleeper_id) === String(id))?.name || id;
    const activeRows = () => (result?.rows || []).filter(r => $("waiver-position").value === "ALL" || r.add.position === $("waiver-position").value).slice(0, 40);
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

    function renderRoster() {
      const own = snap.world.rosters.find(r => r.roster_id === snap.world.rosterId);
      $("waiver-roster").replaceChildren();
      if (viewer()) {
        $("waiver-roster").append(node("p", "Drop protections are the team owner's choice; this view protects the current starters."));
        return;
      }
      const locked = new Set([...(own.reserve || []), ...(own.taxi || [])]);
      for (const id of own.players || []) {
        const label = node("label"), box = document.createElement("input");
        box.type = "checkbox"; box.checked = protectedIds.has(id) || locked.has(id); box.disabled = locked.has(id);
        label.append(box, node("span", `${playerName(id)}${locked.has(id) ? " · IR/taxi" : ""}`));
        box.addEventListener("change", () => {
          if (box.checked) protectedIds.add(id); else protectedIds.delete(id);
          recompute();
        });
        $("waiver-roster").append(label);
      }
    }

    function renderRows() {
      const body = $("waiver-table").querySelector("tbody"); body.replaceChildren();
      const rows = activeRows();
      const whose = viewer() ? "this team's" : "your";
      const weakCount = rows.filter(r => r.signal.strength === "weak").length;
      const heldCount = rows.filter(r => r.signal.strength !== "weak" && r.dropCost?.status === "unassessed").length;
      const negativeCount = rows.filter(r => r.dropCost?.status === "priced" && r.signal.moveValue <= 0).length;
      const pricedCount = rows.filter(r => r.dropCost?.status === "priced" && r.signal.moveValue > 0).length;
      $("waiver-count").textContent = snap.note ? snap.note
        : rows.length ? `${rows.length} independent add/drop alternatives. Each is evaluated against ${whose} current roster, not after other claims.${weakCount ? ` ${weakCount} are weak signals: under 1 point per week — ${COPY.heuristic(rows[0].signal.thresholdPerWeek)} — kept for research; no bid or priority spend is suggested for them.` : ""}${heldCount ? ` ${heldCount} require a drop whose rest-of-season cost is not priced; the gain is shown for research but no bid or priority spend is suggested for them.` : ""}${pricedCount ? ` ${pricedCount} required-drop alternatives are priced on this week's gain plus the rest-of-season lineup change.` : ""}${negativeCount ? ` ${negativeCount} would forfeit more rest-of-season lineup value than the add returns; no bid or priority spend is suggested for them.` : ""}`
        : result?.recommendationBlock || "No positive modeled lineup swaps under the current protections. Do not spend simply because budget remains.";
      for (const r of rows) {
        const text = rowText(r, result, { ownerOnly: viewer() });
        const tr = node("tr");
        const add = node("td", r.add.name); add.append(node("span", r.add.position, "waiver-row-note"));
        const drop = node("td", r.drop?.name || "Open roster spot");
        const gain = node("td", text.gain);
        gain.append(node("span", r.scoring.label, "waiver-row-note"));
        gain.append(node("span", r.signal.label, "waiver-row-note"));
        const bid = node("td", text.bid);
        if (text.bidNote) bid.append(node("span", text.bidNote, "waiver-row-note"));
        const why = node("td", text.why);
        why.append(node("span", r.rosterCost, "waiver-row-note"));
        if (text.dropCostNote) why.append(node("span", text.dropCostNote, "waiver-row-note"));
        if (r.availability?.warning) why.append(node("span", r.availability.warning, "waiver-row-note"));
        tr.append(add, drop, gain, bid, why); body.append(tr);
      }
      renderWatchlist();
      renderIntel();
    }

    function activeRadar() {
      const position = $("waiver-position").value;
      const rows = (intel?.radar || []).filter(p => position === "ALL" || p.position === position);
      if ($("waiver-radar-sort").value === "adds") rows.sort((a,b) => (b.adds ?? -1)-(a.adds ?? -1));
      if ($("waiver-radar-sort").value === "usage") rows.sort((a,b) => b.roleFlags.length-a.roleFlags.length || (b.role?.week || 0)-(a.role?.week || 0));
      if ($("waiver-radar-sort").value === "ros") rows.sort((a,b) => (a.rosRank ?? Infinity)-(b.rosRank ?? Infinity));
      return rows.slice(0,24);
    }

    function renderIntel() {
      if (!intel) return;
      $("waiver-intel-source").textContent = `Sleeper trends requested ${intel.fetchedAt || "unknown time"}. ${intel.rosStatus} ${intel.warnings.join(" ")}`;
      $("waiver-role-source").textContent = intel.roleStatus;
      $("waiver-byes").replaceChildren();
      for (const r of intel.byeRisks) $("waiver-byes").append(node("li", `Week ${r.week} ${r.position}: ${r.available} available for ${r.required} required — ${r.severity}. On bye: ${r.away.join(", ")}.`));
      if (!intel.byeRisks.length) $("waiver-byes").append(node("li", "No dedicated-position bye shortfall or no-spare week found in known bye data."));
      const body = $("waiver-radar").querySelector("tbody"); body.replaceChildren();
      for (const p of activeRadar()) {
        const reasons = [];
        if (p.sameTeam.length) reasons.push(`Shares RB room with ${p.sameTeam.join(", ")}; verify role`);
        if (p.byeCover.length) reasons.push(`Different bye in ${viewer() ? "this team's" : "your"} thin ${p.position} weeks: ${p.byeCover.join(", ")}`);
        if (!reasons.length) reasons.push(p.adds !== null || p.drops !== null ? "Market activity; investigate the cause" : "Consensus watchlist; verify role and availability");
        if (p.roleFlags.length) reasons.push(...p.roleFlags);
        const tr = node("tr");
        const pct = v => typeof v === "number" && Number.isFinite(v) ? `${(v*100).toFixed(1)}%` : "unknown";
        const change = v => typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${(v*100).toFixed(1)} pp` : "not comparable";
        const r = p.role;
        const roleText = r ? `Observed W${r.week}: targets ${r.latest.targets ?? "unknown"}; carries ${r.latest.carries ?? "unknown"}; snap share ${pct(r.latest.snap_pct)}; target share ${pct(r.latest.target_share)}; carry share ${pct(r.latest.carry_share)}. Versus mean of prior observed weeks ${r.baseline_weeks.join(", ") || "none"}: snaps ${change(r.delta.snap_pct)}, target share ${change(r.delta.target_share)}, carry share ${change(r.delta.carry_share)}.` : "No comparable current-team usage row. Not zero opportunity.";
        tr.append(node("td", `${p.name} · ${p.position} · ${p.team}${p.status ? ` · ${p.status}` : ""}`),
          node("td", reasons.join(". ")),
          node("td", roleText),
          node("td", `${p.adds ?? "Not listed"} / ${p.drops ?? "Not listed"}`),
          node("td", `${p.rosRank === null ? "No matching live ROS rank" : `ROS overall rank ${p.rosRank} (${COPY.ecr})`}. ${p.ecr === null ? "No preseason ECR" : `Preseason ECR ${p.ecr} (${COPY.ecr})`}. ${p.projectionCovered ? "Verify snaps, role, health and the cost of your drop." : "Not on projection board; research only, no modeled price."}`));
        body.append(tr);
      }
      const wt = waiverType(), week = $("waiver-week").value;
      $("waiver-market").textContent = wt === 0
        ? `Selected week ${week}: rolling priority is ${result?.waiver.priority ?? snap.world.rosters.find(r => r.roster_id === snap.world.rosterId)?.settings?.waiver_position ?? "unknown"}. Research and rank claims by value; this desk does not estimate claim success.`
        : wt === 1
          ? `Selected week ${week}: reverse-standings waivers. Research and rank claims by value; this desk does not model reverse-standings priority or estimate claim success.`
          : `Selected week ${week}: ${intel.bids.length} completed waiver transaction(s) with a disclosed bid; ${intel.freeAgentMoves} completed free-agent move(s). ` +
            (intel.bids.length ? `Observed winning bids: ${intel.bids.slice(0,15).map(b => `${b.players.join(" + ") || "unknown player"} $${b.amount}`).join("; ")}. These are not minimum winning prices; losing bids are unknown.` : "No observed winning-bid sample to calibrate prices. Free-agent moves are not $0 waiver bids.");
    }

    function renderWatchlist() {
      const owned = new Set(snap.world.rosters.flatMap(r => [...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])]));
      const pos = $("waiver-position").value;
      const pool = snap.board.players.filter(p => p.sleeper_id && !owned.has(p.sleeper_id) && !p.identity_only
        && Number.isFinite(p.ecr) && (pos === "ALL" || p.position === pos))
        .sort((a, b) => a.ecr - b.ecr).slice(0, 24);
      const list = $("waiver-watchlist"); list.replaceChildren();
      for (const p of pool) list.append(node("li", watchlistText(p)));
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
      try {
        // UI expiry: 60 s from the POST-fetch time (bundle.rostersFetchedAt).
        // The engine's kickoff gate uses snapshotAt = the PRE-request time.
        if (Date.now() - s.bundle.rostersFetchedAt > 60000) throw new Error(COPY.expired);
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
        result = s.note ? null : W.analyze({ board: s.board, ...s.world, weekly: s.view.weekly, kickoffs: s.kickoffs, snapshotAt: s.bundle.rostersRequestedAt,
          remaining: s.view.remaining, remainingReason, week: s.week, protectedIds: [...protectedIds], budgetReserve: reserve });
        intel = I.analyze({ board: s.board, ...s.world, catalog: s.catalog, signals: s.signals, roles: s.roles, ros: s.rosEcr, week: s.week });
        const mine = s.world.rosters.find(r => r.roster_id === s.world.rosterId);
        $("waiver-budget").replaceChildren();
        const b = result?.budget;
        const tiles = wt === 0 ? [["Rolling priority", mine.settings?.waiver_position ?? "Unknown"], ["Guidance", "Rank claims"]]
          : wt === 1 ? [["Reverse-standings waivers", "Priority not modeled"], ["Guidance", "Rank claims"]]
          : !b ? []
          : isViewer ? [["Remaining", `$${b.remaining}`], ["Tie priority", mine.settings?.waiver_position ?? "Unknown"]]
          : [["Remaining", `$${b.remaining}`], ["Keep in reserve", `$${b.reserve}`], ["Spendable ceiling", `$${b.spendable}`], ["Tie priority", mine.settings?.waiver_position ?? "Unknown"]];
        for (const [label, value] of tiles) {
          const tile = node("div"); tile.append(node("strong", String(value)), node("span", label)); $("waiver-budget").append(tile);
        }
        const warnings = [...(result ? result.warnings : []), "League eligibility and claim processing time must be checked in Sleeper. Pending bids are not visible through the public API.", `Injury tags are a session-cached catalog snapshot (${s.catalogTime || "unknown time"}), not live news. Verify current availability separately.`];
        $("waiver-warnings").replaceChildren(); const ul = node("ul");
        for (const warning of warnings) ul.append(node("li", warning));
        $("waiver-warnings").append(ul); $("waiver-warnings").hidden = false;
        const settings = S.settingsText(s.bundle);
        $("waiver-source").textContent = `Roster snapshot requested ${new Date(s.world.requestedAt).toISOString()} (kickoff gate), received ${s.world.fetchedAt} (60 s expiry). Week ${s.week}. Weekly projections: ${s.view.weekly.generated_at}, data through ${s.view.weekly.data_through || "unknown"}.${settings ? ` ${settings}.` : ""}${result ? ` ${result.coverage.scoringLabel}` : ""}`;
        const coverage = result?.coverage;
        const whose = isViewer ? "This team's" : "Your";
        $("waiver-coverage").textContent = !coverage ? ""
          : coverage.weeklyFresh
            ? `${whose} active skill roster: ${coverage.projectedOwnedSkills}/${coverage.activeOwnedSkills} have matching weekly projections. ${coverage.missingOwnedWeekly.length ? `No matching projection: ${coverage.missingOwnedWeekly.map(p => p.name).join(", ")}. ` : ""}IR/taxi and K/DEF/IDP are excluded from this count; byes and unavailable players may not need a score. ${coverage.unmappedOwnedIds.length ? `Unmapped owned IDs: ${coverage.unmappedOwnedIds.join(", ")}. ` : ""}${result.recommendationBlock || "Coverage alone does not establish forecast accuracy or player availability."}`
            : `${whose} roster projection coverage cannot be assessed until fresh, aligned weekly data is available. Research is not bid advice.`;
        $("waiver-ros").textContent = rosText(coverage ? coverage.ros : null, { remainingReason: s.view.remainingReason, activeOwnedSkills: coverage?.activeOwnedSkills, owner: !isViewer });
        const ev = $("waiver-evaluation"); ev.replaceChildren();
        for (const line of evidenceLines(s.batch.evaluation, s.view)) ev.append(node("p", line));
        $("waiver-results").hidden = false;
        const who = isViewer ? `Viewing ${S.teamName(s.world.users, mine)}` : `Connected read-only · roster ${s.world.rosterId}`;
        status(`${who} · rosters received ${new Date(s.world.fetchedAt).toLocaleTimeString()}. Refresh from the league panel before placing a claim.`);
        renderRows();
      } catch (error) { result = null; $("waiver-results").hidden = true; status(error.message); }
    }

    // The 15 s tick re-evaluates the committed snapshot (age, expiry); it
    // never fetches. No polling: new data arrives only through the chip's
    // refresh (Session.refresh) or a page reload.
    setInterval(() => { if (snap && !$("waiver-results").hidden) recompute(); }, 15000);

    const hideResults = () => { snap = null; result = null; intel = null; $("waiver-results").hidden = true; $("waiver-warnings").hidden = true; };
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
      hideResults();
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
        protectedIds = new Set((own.starters || []).filter(id => id !== "0"));
        applyReserveDefault(world.league);
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
    FC.chip.onRefresh(() => ({
      scope: "league",
      also: async (parts, get) => {
        try { return await transactionsAlso(parts, get, requestedWeek(autoWeek ? "" : $("waiver-week").value, parts.state, parts.league.season)); }
        catch (error) { refreshError = error.message; throw error; }
      },
    }));
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
    $("waiver-export").addEventListener("click", () => {
      recompute();
      if (!snap || $("waiver-results").hidden) return;
      const wt = waiverType(), isViewer = viewer(), league = snap.world.league;
      const budgetLine = isViewer ? COPY.ownerOnly
        : wt === 0 ? `Current rolling priority ${result?.waiver.priority ?? "unknown"}; rank claims in Sleeper`
        : wt === 1 ? "Reverse-standings waivers; rank claims in Sleeper"
        : result ? `Remaining $${result.budget.remaining}; reserve $${result.budget.reserve}; spendable $${result.budget.spendable}` : "";
      const lines = [`${league.name || `League ${league.league_id}`} waiver shortlist — independent alternatives, not submitted claims`, $("waiver-source").textContent,
        budgetLine,
        ...(snap.note ? [snap.note] : activeRows().map(r => rowText(r, result, { ownerOnly: isViewer }).exportLine)),
        "RESEARCH ONLY — not an add/drop plan or bid recommendation",
        $("waiver-intel-source").textContent,
        intel.roleStatus,
        ...activeRadar().filter(p => p.role).map(p => `USAGE ${p.name}: W${p.role.week}; ${p.roleFlags.join("; ") || "no threshold flags"}; observed ${JSON.stringify(p.role.latest)}; change ${JSON.stringify(p.role.delta)}; baseline weeks ${p.role.baseline_weeks.join(",")}`),
        ...activeRadar().map(p => `${p.name} (${p.position}); ROS overall rank (${COPY.ecr}) ${p.rosRank ?? "unavailable"}; Sleeper 24h adds ${p.adds ?? "not listed"}, drops ${p.drops ?? "not listed"}; same-team RBs: ${p.sameTeam.join(", ") || "none"}; different bye in thin weeks: ${p.byeCover.join(", ") || "none"}; status ${p.status || "verify"}`),
        "Verify injury/role updates, claim deadline, total spend and drop conflicts in Sleeper."];
      $("waiver-backup").value = lines.join("\n");
      $("waiver-backup").closest("details").open = true;
      $("waiver-backup").focus();
    });
  }
  const api = { init, loadWorld, transactionsAlso, loadSignals, hydrateBoard, requestedWeek, rowText, defaultReserve,
    contextLines, rosText, evidenceLines, watchlistText, COPY };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.WaiverMode = api;
})();
