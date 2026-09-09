/* Read-only live league adapter and rendering for the FAAB desk. */
(function () {
  "use strict";
  const dep = (name, path) => typeof window !== "undefined" && window[name]
    ? window[name] : typeof require === "function" ? require(path) : null;
  const Sleeper = dep("Sleeper", "./sleeper.js");
  const LEAGUE_ID = "1376245373244301312";
  let catalogPromise = null;
  let catalogFetchedAt = null;

  function validateContract(board, league) {
    if (!board || board.league?.slug !== "gabagool" || String(league?.league_id) !== LEAGUE_ID
        || String(board.league.league_id) !== LEAGUE_ID) throw new Error("This desk supports Gabagool only; the loaded board/league does not match.");
    if (Number(league.season) !== board.season) throw new Error("League and projection seasons differ.");
    if (league.status !== "in_season") throw new Error("The draft must be complete before using waiver recommendations.");
    if (Number(league.total_rosters) !== board.league.teams) throw new Error("League size changed; the board needs a rebuild.");
    if (Number(league.settings?.waiver_type) !== 2) throw new Error("This desk requires a FAAB waiver league.");
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

  async function loadWorld({ username, board, week, get = path => Sleeper.get(path) }) {
    if (!String(username || "").trim()) throw new Error("Enter your Sleeper username.");
    if (!Number.isInteger(week) || week < 1 || week > 18) throw new Error("Week must be an integer from 1 to 18.");
    const [league, rosters, user, transactions] = await Promise.all([
      get(`/league/${LEAGUE_ID}`), get(`/league/${LEAGUE_ID}/rosters`),
      get(`/user/${encodeURIComponent(username.trim())}`), get(`/league/${LEAGUE_ID}/transactions/${week}`),
    ]);
    validateContract(board, league);
    if (!user?.user_id) throw new Error("Sleeper username was not found.");
    if (!Array.isArray(rosters) || !Array.isArray(transactions)) throw new Error("Sleeper returned incomplete roster/transaction data.");
    const mine = rosters.filter(r => r.owner_id === user.user_id || (r.co_owners || []).includes(user.user_id));
    if (mine.length !== 1) throw new Error("Could not uniquely match this account to a Gabagool roster.");
    return { league, rosters, rosterId: mine[0].roster_id, transactions, fetchedAt: new Date().toISOString() };
  }

  async function loadSignals(get = path => Sleeper.get(path)) {
    const [add, drop] = await Promise.all(["add", "drop"].map(type =>
      get(`/players/nfl/trending/${type}?lookback_hours=24&limit=100`).catch(() => null)));
    return { add, drop, fetchedAt:new Date().toISOString() };
  }

  function init() {
    const W = window.Waivers;
    const $ = id => document.getElementById(id);
    let world = null, board = null, weekly = null, roles = null, catalog = {}, result = null, signals = {}, intel = null;
    let requestId = 0, protectedIds = new Set();
    const node = (tag, text, cls) => {
      const el = document.createElement(tag);
      if (text !== undefined) el.textContent = text;
      if (cls) el.className = cls;
      return el;
    };
    const status = text => { $("waiver-status").textContent = text; };
    const playerName = id => catalog[id]?.full_name || board?.players.find(p => String(p.sleeper_id) === String(id))?.name || id;
    const activeRows = () => (result?.rows || []).filter(r => $("waiver-position").value === "ALL" || r.add.position === $("waiver-position").value).slice(0, 40);
    try { window.FC.leagueNavigation(); }
    catch (error) { status(error.message); return; }

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
      $("waiver-count").textContent = rows.length ? `${rows.length} independent add/drop alternatives. Each is evaluated against your current roster, not after other claims.`
        : "No positive modeled lineup swaps under the current protections. Do not spend simply because budget remains.";
      for (const r of rows) {
        const tr = node("tr");
        const add = node("td", r.add.name); add.append(node("span", r.add.position, "waiver-row-note"));
        const drop = node("td", r.drop?.name || "Open roster spot");
        const gain = node("td", `+${r.lineupGain.toFixed(2)} pts`);
        gain.append(node("span", r.scoring.label, "waiver-row-note"));
        const bid = node("td", r.bid.canAfford === false ? r.bid.status : `$${r.bid.low}–$${r.bid.high}`);
        bid.append(node("span", r.bid.label, "waiver-row-note"));
        const why = node("td", `${r.bid.tier} · ${r.valueEstimate.label}`);
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
      return rows.slice(0,24);
    }

    function renderIntel() {
      if (!intel) return;
      $("waiver-intel-source").textContent = `Sleeper trends requested ${intel.fetchedAt || "unknown time"}. ${intel.warnings.join(" ")}`;
      $("waiver-role-source").textContent = intel.roleStatus;
      $("waiver-byes").replaceChildren();
      for (const r of intel.byeRisks) $("waiver-byes").append(node("li", `Week ${r.week} ${r.position}: ${r.available} available for ${r.required} required — ${r.severity}. On bye: ${r.away.join(", ")}.`));
      if (!intel.byeRisks.length) $("waiver-byes").append(node("li", "No dedicated-position bye shortfall or no-spare week found in known bye data."));
      const body = $("waiver-radar").querySelector("tbody"); body.replaceChildren();
      for (const p of activeRadar()) {
        const reasons = [];
        if (p.sameTeam.length) reasons.push(`Shares RB room with ${p.sameTeam.join(", ")}; verify role`);
        if (p.byeCover.length) reasons.push(`Different bye in your thin ${p.position} weeks: ${p.byeCover.join(", ")}`);
        if (!reasons.length) reasons.push("Market activity; investigate the cause");
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
          node("td", `${p.ecr === null ? "No preseason ECR" : `Preseason ECR ${p.ecr}`}. ${p.projectionCovered ? "Verify snaps, role, health and the cost of your drop." : "Not on projection board; research only, no modeled price."}`));
        body.append(tr);
      }
      $("waiver-market").textContent = `Selected week ${$("waiver-week").value}: ${intel.bids.length} completed waiver transaction(s) with a disclosed bid; ${intel.freeAgentMoves} completed free-agent move(s). ` +
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
        if (!$("waiver-reserve").value.trim()) throw new Error("Enter the budget amount to keep in reserve.");
        const reserve = Number($("waiver-reserve").value);
        if (!Number.isInteger(reserve) || reserve < 0) throw new Error("Budget reserve must be a nonnegative whole dollar amount.");
        result = W.analyze({ board, ...world, weekly, week: Number($("waiver-week").value), protectedIds: [...protectedIds], budgetReserve: reserve });
        intel = window.WaiverIntel.analyze({ board, ...world, catalog, signals, roles, week:Number($("waiver-week").value) });
        const b = result.budget, mine = world.rosters.find(r => r.roster_id === world.rosterId);
        $("waiver-budget").replaceChildren();
        for (const [label, value] of [["Remaining", `$${b.remaining}`], ["Keep in reserve", `$${b.reserve}`], ["Spendable ceiling", `$${b.spendable}`], ["Tie priority", mine.settings?.waiver_position ?? "Unknown"]]) {
          const tile = node("div"); tile.append(node("strong", value), node("span", label)); $("waiver-budget").append(tile);
        }
        const warnings = [...result.warnings, "League eligibility and claim processing time must be checked in Sleeper. Pending bids are not visible through the public API.", `Injury tags are a session-cached catalog snapshot (${catalogFetchedAt || "unknown time"}), not live news. Verify current availability separately.`];
        $("waiver-warnings").replaceChildren(); const ul = node("ul");
        for (const warning of warnings) ul.append(node("li", warning));
        $("waiver-warnings").append(ul); $("waiver-warnings").hidden = false;
        $("waiver-source").textContent = `Roster snapshot ${world.fetchedAt}. Week ${$("waiver-week").value}. Weekly file: ${weekly?.generated_at || "unavailable"}, data through ${weekly?.data_through || "unknown"}. Preseason baseline: ${board.generated_at}. ${result.coverage.scoringLabel}`;
        $("waiver-results").hidden = false;
        status(`Connected read-only · roster ${world.rosterId} · refreshed ${new Date(world.fetchedAt).toLocaleTimeString()}. Refresh again before placing a claim.`);
        renderRows();
      } catch (error) { result = null; $("waiver-results").hidden = true; status(error.message); }
    }

    $("waiver-connect").addEventListener("submit", async event => {
      event.preventDefault(); const thisRequest = ++requestId;
      world = null; result = null;
      $("waiver-load").disabled = true; $("waiver-results").hidden = true; $("waiver-warnings").hidden = true;
      status("Reading current rosters, budget, scoring, and projections…");
      try {
        const [rawBoard, loadedWeekly, loadedRoles] = await Promise.all([
          window.FC.loadJSON("data/draft.json"),
          window.FC.loadJSON("data/weekly.json").catch(() => null),
          window.FC.loadJSON("data/roles.json").catch(() => null),
        ]);
        const [nextWorld, nextSignals] = await Promise.all([
          loadWorld({ username: $("waiver-user").value, board: rawBoard, week: Number($("waiver-week").value) }), loadSignals(),
        ]);
        // Sleeper asks clients to avoid frequent bulk-catalog requests. This is
        // session-cached, explicitly dated below, not a live injury-news feed.
        if (!catalogPromise) catalogPromise = Sleeper.get("/players/nfl")
          .then(data => { catalogFetchedAt = new Date().toISOString(); return data; })
          .catch(error => { catalogPromise = null; throw error; });
        const nextCatalog = await catalogPromise;
        if (thisRequest !== requestId) return;
        catalog = nextCatalog;
        board = { ...rawBoard, players: rawBoard.players.map(p => ({ ...p,
          injury_status: catalog[p.sleeper_id]?.injury_status || null,
        })) };
        weekly = loadedWeekly; roles = loadedRoles; world = nextWorld; signals = nextSignals;
        const own = world.rosters.find(r => r.roster_id === world.rosterId);
        protectedIds = new Set((own.starters || []).filter(id => id !== "0"));
        renderRoster(); recompute();
      } catch (error) {
        if (thisRequest !== requestId) return;
        world = null; result = null; status(`Could not load safe recommendations: ${error.message}`);
      } finally { if (thisRequest === requestId) $("waiver-load").disabled = false; }
    });
    $("waiver-user").addEventListener("input", () => { ++requestId; world = null; result = null; $("waiver-results").hidden = true; $("waiver-load").disabled = false; status("Account changed. Load the league again."); });
    $("waiver-week").addEventListener("change", () => { ++requestId; world = null; result = null; $("waiver-results").hidden = true; $("waiver-load").disabled = false; status("Week changed. Load the league again."); });
    $("waiver-reserve").addEventListener("change", recompute);
    $("waiver-position").addEventListener("change", () => { if (result) renderRows(); });
    $("waiver-radar-sort").addEventListener("change", () => { if (result) renderIntel(); });
    $("waiver-export").addEventListener("click", () => {
      if (!result) return;
      const lines = ["Gabagool FAAB shortlist — independent alternatives, not submitted claims", $("waiver-source").textContent,
        `Remaining $${result.budget.remaining}; reserve $${result.budget.reserve}; spendable $${result.budget.spendable}`,
        ...activeRows().map(r => `ADD ${r.add.name}; DROP ${r.drop?.name || "none"}; +${r.lineupGain.toFixed(2)} (${r.scoring.label}); ${r.bid.canAfford === false ? r.bid.status : `heuristic bid $${r.bid.low}–$${r.bid.high}`}`),
        "RESEARCH ONLY — not an add/drop plan or bid recommendation",
        $("waiver-intel-source").textContent,
        intel.roleStatus,
        ...activeRadar().filter(p => p.role).map(p => `USAGE ${p.name}: W${p.role.week}; ${p.roleFlags.join("; ") || "no threshold flags"}; observed ${JSON.stringify(p.role.latest)}; change ${JSON.stringify(p.role.delta)}; baseline weeks ${p.role.baseline_weeks.join(",")}`),
        ...activeRadar().map(p => `${p.name} (${p.position}); Sleeper 24h adds ${p.adds ?? "not listed"}, drops ${p.drops ?? "not listed"}; same-team RBs: ${p.sameTeam.join(", ") || "none"}; different bye in thin weeks: ${p.byeCover.join(", ") || "none"}; status ${p.status || "verify"}`),
        "Verify injury/role updates, claim deadline, total spend and drop conflicts in Sleeper."];
      $("waiver-backup").value = lines.join("\n");
      $("waiver-backup").closest("details").open = true;
      $("waiver-backup").focus();
    });
  }
  const api = { init, loadWorld, loadSignals, validateContract };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.WaiverMode = api;
})();
