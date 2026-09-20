/* Read-only live league adapter and rendering for the FAAB desk. */
(function () {
  "use strict";
  const ROS = (typeof module !== "undefined" && module.exports) ? require("./ros.js") : window.ROS;
  const dep = (name, path) => typeof window !== "undefined" && window[name]
    ? window[name] : typeof require === "function" ? require(path) : null;
  const Sleeper = dep("Sleeper", "./sleeper.js");
  const FC = dep("FC", "./app.js");
  const NO_UNIQUE_ROSTER = "Could not uniquely match this account to a roster in this league.";
  // The supported-league table is FC.REGISTRY (spec §3); a board is for a
  // supported Sleeper league only when its slug's entry is a Sleeper entry
  // whose live league id equals the board's.
  function supportedEntry(board) {
    const entry = FC && typeof FC.registryFor === "function" ? FC.registryFor(board?.league?.slug) : null;
    if (!entry || entry.platform !== "sleeper") return null;
    return String(entry.leagueId) === String(board?.league?.league_id || "") ? entry : null;
  }

  function requestedWeek(value, state, season) {
    const automatic = !String(value ?? "").trim();
    if (automatic && (String(state?.season) !== String(season) || state?.season_type !== "regular"))
      throw new Error("Current NFL week unavailable for this season. Choose a week explicitly for research.");
    const week = Number(automatic ? state?.week : value);
    if (!Number.isInteger(week) || week < 1 || week > 18) throw new Error("Week must be an integer from 1 to 18.");
    return week;
  }

  function validateContract(board, league, { requireFaab = false } = {}) {
    const boardId = String(board?.league?.league_id || ""), liveId = String(league?.league_id || "");
    if (!supportedEntry(board) || liveId !== boardId)
      throw new Error("The loaded board and live league must exactly match a supported Sleeper league.");
    if (Number(league.season) !== board.season) throw new Error("League and projection seasons differ.");
    if (league.status !== "in_season") throw new Error("The draft must be complete before using waiver recommendations.");
    if (Number(league.total_rosters) !== board.league.teams) throw new Error("League size changed; the board needs a rebuild.");
    const waiverType = Number(league.settings?.waiver_type);
    if (requireFaab && waiverType !== 2) throw new Error("This feature requires a FAAB waiver league.");
    if (waiverType !== 0 && waiverType !== 2) throw new Error("Only rolling-priority and FAAB waiver leagues are supported.");
    const expected = board.league.sleeper_scoring;
    const live = league.scoring_settings;
    if (!expected || !live) throw new Error("Scoring contract is missing; cannot value claims safely.");
    for (const key of new Set([...Object.keys(expected), ...Object.keys(live)])) {
      if (Number(expected[key] || 0) !== Number(live[key] || 0)) throw new Error(`Scoring changed (${key}); refresh the league-specific projections before using this desk.`);
    }
    if (!Array.isArray(league.roster_positions)) throw new Error("Live roster slots are unavailable.");
    const counts = {};
    for (const pos of league.roster_positions) counts[pos] = (counts[pos] || 0) + 1;
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      if ((counts[pos] || 0) !== board.league.roster[pos]) throw new Error(`Roster settings changed (${pos}); the board needs a rebuild.`);
    }
    if ((counts.FLEX || 0) !== board.league.flex || league.roster_positions.length !== board.league.rounds)
      throw new Error("Roster size or FLEX settings changed; the board needs a rebuild.");
  }

  // Live world for the desk, read from the shared session bundle (spec §5).
  // League, rosters and identity come from the bundle -- this never fetches
  // them -- and the only network call is the week's transactions, unless the
  // caller already fetched them atomically with the rosters through
  // Session.refresh({ also }) and they ride on `bundle.extra` as
  // { week, transactions } for THIS week. Two timestamps pass through
  // untouched: `requestedAt` (pre-request, the engine's kickoff gate) and
  // `fetchedAt` (post-fetch, the 60 s UI expiry); nothing here reads a clock.
  async function loadWorld({ bundle, board, week, get = path => Sleeper.get(path) }) {
    if (!bundle || typeof bundle !== "object") throw new Error("No league session is loaded.");
    if (!Number.isInteger(week) || week < 1 || week > 18) throw new Error("Week must be an integer from 1 to 18.");
    const leagueId = String(board?.league?.league_id || "");
    const entry = bundle.registry;
    if (!supportedEntry(board) || !entry || entry.platform !== "sleeper" || String(entry.leagueId) !== leagueId || entry.slug !== board.league.slug)
      throw new Error("The projection board is not for a supported Sleeper league.");
    if (bundle.myRosterStatus === "anonymous" || !bundle.identity) throw new Error("Enter your Sleeper username in the league panel.");
    if (bundle.myRosterStatus !== "found" || !bundle.myRoster) throw new Error(NO_UNIQUE_ROSTER);
    validateContract(board, bundle.league);
    if (!Array.isArray(bundle.rosters)) throw new Error("Sleeper returned incomplete roster data.");
    if (!Number.isFinite(bundle.rostersRequestedAt) || !Number.isFinite(bundle.rostersFetchedAt)) throw new Error("Roster snapshot timestamps are missing.");
    const cached = bundle.extra;
    const transactions = cached && Number(cached.week) === week && Array.isArray(cached.transactions)
      ? cached.transactions : await get(`/league/${leagueId}/transactions/${week}`);
    if (!Array.isArray(transactions)) throw new Error("Sleeper returned incomplete transaction data.");
    return { league: bundle.league, rosters: bundle.rosters, rosterId: bundle.myRoster.roster_id, transactions,
      fetchedAt: new Date(bundle.rostersFetchedAt).toISOString(), requestedAt: bundle.rostersRequestedAt };
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

  function hydrateBoard(rawBoard, catalog) {
    const players = rawBoard.players.map(p => ({ ...p,
      injury_status: catalog[p.sleeper_id]?.injury_status || null,
      current_team: catalog[p.sleeper_id]?.team || null,
    }));
    const mapped = new Set(players.map(p => String(p.sleeper_id)));
    // K/DEF still occupy roster slots even though the skill-player board does
    // not project them. Carry identity only; never invent a score for them.
    for (const [sid, p] of Object.entries(catalog)) {
      if (!mapped.has(sid) && ["K", "DEF"].includes(p?.position)) players.push({
        sleeper_id: sid, name: p.full_name || sid, position: p.position,
        team: p.team || null, current_team: p.team || null,
        injury_status: p.injury_status || null,
      });
    }
    return { ...rawBoard, players };
  }

  // Pure row wording shared by the table and the text export so fixtures can pin
  // the exact strings. A withheld bid (low/high null) must never print as dollars.
  function rowText(r, result) {
    const weak = r.signal.strength === "weak";
    const dc = r.dropCost || {};
    const priced = Number.isFinite(dc.rosDelta);
    const negative = dc.status === "priced" && Number.isFinite(r.signal.moveValue) && r.signal.moveValue <= 0;
    const held = !weak && !negative && dc.status === "unassessed";
    const sign = x => `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(2)}`;
    const dollars = r.bid && Number.isFinite(r.bid.low) && Number.isFinite(r.bid.high) ? `$${r.bid.low}–$${r.bid.high}` : null;
    const withheld = weak || held || negative;
    const bid = r.bid ? (dollars ?? r.bid.status ?? "No bid suggested") : (withheld ? "No priority claim suggested" : "Set claim order in Sleeper");
    const bidNote = r.bid ? r.bid.label : (withheld ? r.signal.guidance : result.waiver.guidance);
    const exportBid = r.bid ? (dollars ? `heuristic bid ${dollars}` : bid) : r.signal.guidance;
    const rosPart = priced ? ` this week · ROS ${sign(dc.rosDelta)}` : "";
    const tag = weak ? " · weak signal" : held ? " · drop cost unassessed" : negative ? " · drop costs more than the add returns" : "";
    const exportRos = priced ? `; ROS ${sign(dc.rosDelta)} (wk ${(dc.endWeek - dc.futureWeeks) + 1}–${dc.endWeek})` : "";
    const exportTag = weak ? "WEAK SIGNAL" : held ? "DROP COST UNASSESSED" : negative ? "DROP COSTS MORE THAN ADD RETURNS" : "modeled";
    return {
      gain: `+${r.lineupGain.toFixed(2)} pts${rosPart}${tag}`,
      bid, bidNote,
      why: `${r.bid ? `${r.bid.tier} · ` : ""}${r.valueEstimate.label}`,
      dropCostNote: held ? `${dc.label}${dc.reason ? ` — ${dc.reason}` : ""}` : dc.status === "priced" ? dc.label : null,
      exportLine: `ADD ${r.add.name}; DROP ${r.drop?.name || "none"}; +${r.lineupGain.toFixed(2)} (${r.scoring.label})${exportRos}; ${exportTag}; ${exportBid}; ${r.rosterCost}${held ? `; ${dc.label}${dc.reason ? ` — ${dc.reason}` : ""}` : ""}`,
    };
  }

  // Moved to ros.js (shared with waivers.js/seasontrade.js); kept under this
  // name so window.WaiverMode.evaluationText and every call in init() below
  // keep working unchanged.
  const evaluationText = ROS.evaluationText;

  function init() {
    const W = window.Waivers;
    const $ = id => document.getElementById(id);
    let world = null, board = null, weekly = null, roles = null, catalog = {}, result = null, signals = {}, intel = null;
    let kickoffs = null, snapshotAt = null, ros = null, remaining = null, rawBoard = null, catalogFetchedAt = null;
    let requestId = 0, protectedIds = new Set(), autoWeek = true;
    // The session bundle the desk is loading/loaded from. Session.onChange
    // fires for every state move (refresh start, failed refresh, identity
    // re-derive); only a DIFFERENT committed bundle re-runs the load.
    let currentBundle = null, refreshing = false, refreshError = null;
    const S = window.Session;
    const node = (tag, text, cls) => {
      const el = document.createElement(tag);
      if (text !== undefined) el.textContent = text;
      if (cls) el.className = cls;
      return el;
    };
    const status = text => { $("waiver-status").textContent = text; };
    const playerName = id => catalog[id]?.full_name || board?.players.find(p => String(p.sleeper_id) === String(id))?.name || id;
    const activeRows = () => (result?.rows || []).filter(r => $("waiver-position").value === "ALL" || r.add.position === $("waiver-position").value).slice(0, 40);
    let selectedLeague;
    try { selectedLeague = window.FC.leagueNavigation(); }
    catch (error) { status(error.message); return; }
    const entry = window.FC.registryFor(selectedLeague);
    if (!entry || entry.platform !== "sleeper" || !entry.tools.waivers) {
      $("waiver-controls").hidden = true;
      $("waiver-results").hidden = true;
      status("ESPN family waivers are not connected. Choose Gabagool or FAM to use this read-only Sleeper desk.");
      return;
    }

    function renderRoster() {
      const own = world.rosters.find(r => r.roster_id === world.rosterId);
      const locked = new Set([...(own.reserve || []), ...(own.taxi || [])]);
      $("waiver-roster").replaceChildren();
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
      const weakCount = rows.filter(r => r.signal.strength === "weak").length;
      const heldCount = rows.filter(r => r.signal.strength !== "weak" && r.dropCost?.status === "unassessed").length;
      const negativeCount = rows.filter(r => r.dropCost?.status === "priced" && r.signal.moveValue <= 0).length;
      const pricedCount = rows.filter(r => r.dropCost?.status === "priced" && r.signal.moveValue > 0).length;
      $("waiver-count").textContent = rows.length ? `${rows.length} independent add/drop alternatives. Each is evaluated against your current roster, not after other claims.${weakCount ? ` ${weakCount} are weak signals (under ${rows[0].signal.thresholdPerWeek.toFixed(1)} projected pt/week) kept for research; no bid or priority spend is suggested for them.` : ""}${heldCount ? ` ${heldCount} require a drop whose rest-of-season cost is not priced; the gain is shown for research but no bid or priority spend is suggested for them.` : ""}${pricedCount ? ` ${pricedCount} required-drop alternatives are priced on this week's gain plus the rest-of-season lineup change.` : ""}${negativeCount ? ` ${negativeCount} would forfeit more rest-of-season lineup value than the add returns; no bid or priority spend is suggested for them.` : ""}`
        : result.recommendationBlock || "No positive modeled lineup swaps under the current protections. Do not spend simply because budget remains.";
      for (const r of rows) {
        const text = rowText(r, result);
        const tr = node("tr");
        const add = node("td", r.add.name); add.append(node("span", r.add.position, "waiver-row-note"));
        const drop = node("td", r.drop?.name || "Open roster spot");
        const gain = node("td", text.gain);
        gain.append(node("span", r.scoring.label, "waiver-row-note"));
        gain.append(node("span", r.signal.label, "waiver-row-note"));
        const bid = node("td", text.bid);
        bid.append(node("span", text.bidNote, "waiver-row-note"));
        const why = node("td", text.why);
        why.append(node("span", r.rosterCost, "waiver-row-note"));
        if (text.dropCostNote) why.append(node("span", text.dropCostNote, "waiver-row-note"));
        if (r.availability?.warning) why.append(node("span", r.availability.warning, "waiver-row-note"));
        if (r.warning) why.append(node("span", r.warning, "waiver-row-note"));
        if (r.warnings) for (const warning of r.warnings) why.append(node("span", warning, "waiver-row-note"));
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
        if (p.byeCover.length) reasons.push(`Different bye in your thin ${p.position} weeks: ${p.byeCover.join(", ")}`);
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
          node("td", `${p.rosRank === null ? "No matching live ROS rank" : `ROS PPR overall ${p.rosRank}`}. ${p.ecr === null ? "No preseason ECR" : `Preseason ECR ${p.ecr}`}. ${p.projectionCovered ? "Verify snaps, role, health and the cost of your drop." : "Not on projection board; research only, no modeled price."}`));
        body.append(tr);
      }
      $("waiver-market").textContent = result?.waiver.type === "rolling"
        ? `Selected week ${$("waiver-week").value}: rolling priority is ${result.waiver.priority ?? "unknown"}. Research and rank claims by value; this desk does not estimate claim success.`
        : `Selected week ${$("waiver-week").value}: ${intel.bids.length} completed waiver transaction(s) with a disclosed bid; ${intel.freeAgentMoves} completed free-agent move(s). ` +
          (intel.bids.length ? `Observed winning bids: ${intel.bids.slice(0,15).map(b => `${b.players.join(" + ") || "unknown player"} $${b.amount}`).join("; ")}. These are not minimum winning prices; losing bids are unknown.` : "No observed winning-bid sample to calibrate prices. Free-agent moves are not $0 waiver bids.");
    }

    function renderWatchlist() {
      const owned = new Set(world.rosters.flatMap(r => [...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])]));
      const pos = $("waiver-position").value;
      const pool = board.players.filter(p => p.sleeper_id && !owned.has(p.sleeper_id)
        && Number.isFinite(p.ecr) && (pos === "ALL" || p.position === pos))
        .sort((a, b) => a.ecr - b.ecr).slice(0, 24);
      const list = $("waiver-watchlist"); list.replaceChildren();
      for (const p of pool) list.append(node("li", `${p.name} · ${p.position} · preseason ECR ${p.ecr}${p.injury_status ? ` · ${p.injury_status}` : ""}`));
    }

    function recompute() {
      if (!world) return;
      try {
        // UI expiry: 60 s from the POST-fetch time (bundle.rostersFetchedAt).
        // The engine's kickoff gate uses snapshotAt = the PRE-request time.
        if (Date.now() - currentBundle.rostersFetchedAt > 60000) throw new Error("Roster snapshot expired. Refresh from the league panel before using waiver recommendations.");
        const rolling = Number(world.league.settings?.waiver_type) === 0;
        const reserve = rolling ? undefined : Number($("waiver-reserve").value);
        if (!rolling && (!$("waiver-reserve").value.trim() || !Number.isInteger(reserve) || reserve < 0)) throw new Error("Budget reserve must be a nonnegative whole dollar amount.");
        result = W.analyze({ board, ...world, weekly, kickoffs, snapshotAt, remaining, week: Number($("waiver-week").value), protectedIds: [...protectedIds], budgetReserve: reserve });
        intel = window.WaiverIntel.analyze({ board, ...world, catalog, signals, roles, ros, week:Number($("waiver-week").value) });
        const b = result.budget, mine = world.rosters.find(r => r.roster_id === world.rosterId);
        $("waiver-reserve").closest("label").hidden = rolling;
        $("waiver-budget").replaceChildren();
        const tiles = rolling ? [["Rolling priority", mine.settings?.waiver_position ?? "Unknown"], ["Guidance", "Rank claims"]]
          : [["Remaining", `$${b.remaining}`], ["Keep in reserve", `$${b.reserve}`], ["Spendable ceiling", `$${b.spendable}`], ["Tie priority", mine.settings?.waiver_position ?? "Unknown"]];
        for (const [label, value] of tiles) {
          const tile = node("div"); tile.append(node("strong", value), node("span", label)); $("waiver-budget").append(tile);
        }
        const warnings = [...result.warnings, "League eligibility and claim processing time must be checked in Sleeper. Pending bids are not visible through the public API.", `Injury tags are a session-cached catalog snapshot (${catalogFetchedAt || "unknown time"}), not live news. Verify current availability separately.`];
        $("waiver-warnings").replaceChildren(); const ul = node("ul");
        for (const warning of warnings) ul.append(node("li", warning));
        $("waiver-warnings").append(ul); $("waiver-warnings").hidden = false;
        $("waiver-source").textContent = `Roster snapshot requested ${new Date(world.requestedAt).toISOString()} (kickoff gate), received ${world.fetchedAt} (60 s expiry). Week ${$("waiver-week").value}. Weekly file: ${weekly?.generated_at || "unavailable"}, data through ${weekly?.data_through || "unknown"}. Preseason baseline: ${board.generated_at}. ${result.coverage.scoringLabel}`;
        const coverage = result.coverage;
        $("waiver-coverage").textContent = coverage.weeklyFresh
          ? `Your active skill roster: ${coverage.projectedOwnedSkills}/${coverage.activeOwnedSkills} have matching weekly projections. ${coverage.missingOwnedWeekly.length ? `No matching projection: ${coverage.missingOwnedWeekly.map(p => p.name).join(", ")}. ` : ""}IR/taxi and K/DEF are excluded from this count; byes and unavailable players may not need a score. ${coverage.unmappedOwnedIds.length ? `Unmapped owned IDs: ${coverage.unmappedOwnedIds.join(", ")}. ` : ""}${result.recommendationBlock || "Coverage alone does not establish forecast accuracy or player availability."}`
          : "Your roster projection coverage cannot be assessed until fresh, aligned weekly data is available. Research is not bid advice.";
        // Named rosCoverage, not `ros`: the outer `ros` closure var (ROS-ECR
        // watchlist data) is already referenced earlier in this function, and a
        // same-scope `const ros` here would TDZ-break that reference.
        const rosCoverage = coverage.ros || {};
        $("waiver-ros").textContent = rosCoverage.fresh
          ? `Rest-of-season projections: weeks ${rosCoverage.endWeek - rosCoverage.futureWeeks + 1}–${rosCoverage.endWeek}, generated ${rosCoverage.generatedAt}, data through ${rosCoverage.dataThrough || "unknown"}; ${rosCoverage.pricedOwned}/${coverage.activeOwnedSkills} roster players priced.${rosCoverage.unmodeledOwned.length ? ` No rest-of-season projection: ${rosCoverage.unmodeledOwned.map(p => p.name).join(", ")}.` : ""} Values assume participation; injuries and returns are not forecast.`
          : `Rest-of-season projections unavailable${rosCoverage.reason ? ` (${rosCoverage.reason})` : ""}; drop costs are unassessed and spend guidance is limited to open-slot adds.`;
        const ev = $("waiver-evaluation"); ev.replaceChildren();
        for (const line of evaluationText(rosCoverage.evaluation)) ev.append(node("p", line));
        $("waiver-results").hidden = false;
        status(`Connected read-only · roster ${world.rosterId} · rosters received ${new Date(world.fetchedAt).toLocaleTimeString()}. Refresh from the league panel before placing a claim.`);
        renderRows();
      } catch (error) { result = null; $("waiver-results").hidden = true; status(error.message); }
    }

    // The 15 s tick re-evaluates the committed snapshot (age, expiry); it
    // never fetches. No polling: new data arrives only through the chip's
    // refresh (Session.refresh) or a page reload.
    setInterval(() => { if (world && result) recompute(); }, 15000);

    const hideResults = () => { world = null; result = null; $("waiver-results").hidden = true; $("waiver-warnings").hidden = true; };
    const currentWeek = state => requestedWeek(autoWeek ? "" : $("waiver-week").value, state, rawBoard.season);
    // Why the desk is not showing rows: the session's error, no identity yet,
    // still loading, or the exact-matcher refusal (chipText's own wording).
    function gateMessage(bundle) {
      const err = S.error();
      if (err) return err;
      if (!S.identity()) return "Enter your Sleeper username in the league panel above; the desk reads your roster from there.";
      if (!bundle) return "Loading league…";
      if (bundle.myRosterStatus === "none" || bundle.myRosterStatus === "ambiguous") return S.chipText(bundle, "ready", Date.now());
      return "Loading league…";
    }

    // The load body: everything downstream of a committed bundle with a
    // uniquely matched roster. snapshotAt is the bundle's PRE-request time so
    // a kickoff during retrieval still blocks; the catalog is the session's
    // once-per-document copy.
    async function load(bundle) {
      const thisRequest = ++requestId;
      currentBundle = bundle;
      hideResults();
      status("Reading current rosters, waiver settings, scoring, and projections…");
      try {
        const week = currentWeek(bundle.state);
        const [nextWorld, nextSignals, nextCatalog] = await Promise.all([
          loadWorld({ bundle, board: rawBoard, week }), loadSignals(), S.catalog(),
        ]);
        if (thisRequest !== requestId) return;
        // Sleeper asks clients to avoid frequent bulk-catalog requests; the
        // session fetches it once per document, dated below, not live news.
        catalogFetchedAt = Number.isFinite(S.catalogFetchedAt()) ? new Date(S.catalogFetchedAt()).toISOString() : null;
        $("waiver-week").value = String(week);
        catalog = nextCatalog;
        board = hydrateBoard(rawBoard, catalog);
        world = nextWorld; signals = nextSignals; snapshotAt = bundle.rostersRequestedAt;
        const own = world.rosters.find(r => r.roster_id === world.rosterId);
        protectedIds = new Set((own.starters || []).filter(id => id !== "0"));
        renderRoster(); recompute();
      } catch (error) {
        if (thisRequest !== requestId) return;
        if (S.isSuperseded(error)) return;
        hideResults(); status(`Could not load safe recommendations: ${error.message}`);
      }
    }

    // Session.onChange driver. Gated on bundle()/myRosterStatus/error(),
    // never on state() === "error" (a stale identity error can coexist with
    // a valid bundle). A refresh in flight keeps the results visible; a
    // refresh that commits nothing (same bundle back) says so and leaves the
    // previous snapshot -- and snapshotAt -- exactly as they were.
    function sync(snapshot) {
      const bundle = S.bundle();
      const flow = snapshot && snapshot.state;
      if (!bundle || bundle.myRosterStatus !== "found" || !bundle.myRoster) {
        ++requestId; currentBundle = null; refreshing = false;
        hideResults(); status(gateMessage(bundle));
        return;
      }
      if (bundle === currentBundle) {
        if (flow === "refreshing") { refreshing = true; refreshError = null; status("Refreshing rosters and this week's transactions…"); return; }
        if (refreshing && flow === "ready") {
          refreshing = false;
          if (world) status(`Refresh did not complete${refreshError ? ` (${refreshError})` : "; see the league panel for the reason"}. The roster snapshot received ${new Date(world.fetchedAt).toLocaleTimeString()} is still shown.`);
        }
        return;
      }
      refreshing = false;
      load(bundle);
    }

    (async () => {
      status("Reading projections and league data…");
      try {
        const dataPath = kind => window.FC.leagueDataPath(kind);
        const [loadedBoard, loadedWeekly, loadedRoles, loadedKickoffs, loadedRos, loadedRemaining] = await Promise.all([
          window.FC.loadJSON(dataPath("draft")),
          window.FC.loadJSON(dataPath("weekly")).catch(() => null),
          window.FC.loadJSON("data/roles.json").catch(() => null),
          window.FC.loadJSON("data/kickoffs.json").catch(() => null),
          window.FC.loadJSON("data/ros-ecr.json").catch(() => null),
          window.FC.loadJSON(dataPath("remaining")).catch(() => null),
        ]);
        if (loadedBoard.league?.slug !== selectedLeague) throw new Error("Projection board does not match the selected league; reload before using advice.");
        rawBoard = loadedBoard; weekly = loadedWeekly; roles = loadedRoles; kickoffs = loadedKickoffs; ros = loadedRos; remaining = loadedRemaining;
        const leagueLink = $("waiver-league-link");
        leagueLink.href = `https://sleeper.com/leagues/${encodeURIComponent(rawBoard.league.league_id)}/team`;
        leagueLink.textContent = `Open ${rawBoard.league.slug.toUpperCase()} in Sleeper`;
        // The chip's refresh on this page re-fetches the week's transactions
        // atomically with the rosters: if either fails, nothing commits and
        // the chip's age does not advance. The week is resolved from the
        // FRESH state inside the hook, so "auto" follows the live NFL week.
        window.FC.chip.onRefresh(() => ({
          scope: "league",
          also: async (parts, get) => {
            try { return await transactionsAlso(parts, get, currentWeek(parts.state)); }
            catch (error) { refreshError = error.message; throw error; }
          },
        }));
        S.onChange(sync);
        // The chip auto-runs Session.ready once a board is set and an identity exists.
        window.FC.setBoard(rawBoard);
        sync({ state: S.state() });
      } catch (error) {
        hideResults(); status(`Could not load safe recommendations: ${error.message}`);
      }
    })();
    $("waiver-week").addEventListener("change", () => {
      autoWeek = !$("waiver-week").value.trim();
      const bundle = S.bundle();
      if (rawBoard && bundle && bundle.myRosterStatus === "found" && bundle.myRoster) load(bundle);
      else { ++requestId; hideResults(); status(rawBoard ? gateMessage(bundle) : "Week changed. Clear the week to follow the current NFL week automatically."); }
    });
    $("waiver-reserve").addEventListener("change", recompute);
    $("waiver-position").addEventListener("change", () => { if (result) renderRows(); });
    $("waiver-radar-sort").addEventListener("change", () => { if (result) renderIntel(); });
    $("waiver-export").addEventListener("click", () => {
      recompute();
      if (!result) return;
      const rolling = result.waiver.type === "rolling";
      const lines = [`${board.league.slug.toUpperCase()} waiver shortlist — independent alternatives, not submitted claims`, $("waiver-source").textContent,
        rolling ? `Current rolling priority ${result.waiver.priority ?? "unknown"}; rank claims in Sleeper` : `Remaining $${result.budget.remaining}; reserve $${result.budget.reserve}; spendable $${result.budget.spendable}`,
        ...activeRows().map(r => rowText(r, result).exportLine),
        "RESEARCH ONLY — not an add/drop plan or bid recommendation",
        $("waiver-intel-source").textContent,
        intel.roleStatus,
        ...activeRadar().filter(p => p.role).map(p => `USAGE ${p.name}: W${p.role.week}; ${p.roleFlags.join("; ") || "no threshold flags"}; observed ${JSON.stringify(p.role.latest)}; change ${JSON.stringify(p.role.delta)}; baseline weeks ${p.role.baseline_weeks.join(",")}`),
        ...activeRadar().map(p => `${p.name} (${p.position}); ROS PPR overall ${p.rosRank ?? "unavailable"}; Sleeper 24h adds ${p.adds ?? "not listed"}, drops ${p.drops ?? "not listed"}; same-team RBs: ${p.sameTeam.join(", ") || "none"}; different bye in thin weeks: ${p.byeCover.join(", ") || "none"}; status ${p.status || "verify"}`),
        "Verify injury/role updates, claim deadline, total spend and drop conflicts in Sleeper."];
      $("waiver-backup").value = lines.join("\n");
      $("waiver-backup").closest("details").open = true;
      $("waiver-backup").focus();
    });
  }
  const api = { init, loadWorld, transactionsAlso, loadSignals, validateContract, hydrateBoard, requestedWeek, rowText, evaluationText };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.WaiverMode = api;
})();
