/* In-season trade page controller (any-league spec §7.1 trade, §7.2, §5.1,
   §5.2, §6.1, §6.2, §3.2). Any Sleeper league, by id. The pure helpers here
   are what the fixture tests; init() wires them to the DOM, to the shared
   Session bundle and to SeasonTrade.analyze.

   Statics, once per document (a failure retries on the next load): the
   league-neutral batch (LeagueData.loadBatch). No draft board, no per-league
   remaining file, no traded picks and no simulation inputs: future picks are
   not on the in-season page (spec §7.2) and simulation is off for everyone
   in phase 1 (spec §6.2).

   The live world comes from the committed Session bundle: the league (read
   from EACH committed bundle, never a closure copy), users, rosters, NFL
   state and the roster under analysis (the owner's own, or the team a viewer
   chose: analysisRoster / analysisRole), checked by LiveWorld.resolve. Every
   NEW bundle recomputes the league views (remaining + identity board) under
   the bundle's live scoring; bundles are compared by identity, never by
   generation. A compare's own roster refresh is adopted as data only when
   the league settings did not move; otherwise the page reloads and the
   compare is superseded (spec §5.2).

   Best ball or an unknown starting slot: rest-of-season values only, no
   lineup comparison. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SeasonTradeMode = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";
  // The browser has window.Session (session.js loads first); node requires it.
  // This file does not shadow `require` (seasontrade.js does), so the loader
  // is the real one here.
  const dep = (name, path) => typeof window !== "undefined" && window[name]
    ? window[name] : typeof require === "function" ? require(path) : null;
  const Session = dep("Session", "./session.js");
  // Lazy: resolved at call time so script order does not matter.
  const LD = () => dep("LeagueData", "./leaguedata.js");
  const LW = () => dep("LiveWorld", "./liveworld.js");
  const SKILL = new Set(["QB", "RB", "WR", "TE"]);
  const HEADLINE = "Conditional lineup scenario — not a trade verdict.";
  const SUBLINE_TAIL = "Keeper value and draft picks are not valued, so no overall grade is shown.";
  const FORBIDDEN = Object.freeze(["verdict", "win/win", "fair", "winner", "accept", "recommend", "grade"]);
  const ALLOWED_SENTENCES = Object.freeze([HEADLINE, SUBLINE_TAIL]);
  // The measured-method vocabulary (gradeText/marketText below). Dormant in
  // phase 1: no grade is shown to anyone (spec §6.2), but the pure helpers
  // stay pinned to the backtest by sim_parity_fixture.
  const GRADE_FORBIDDEN = Object.freeze(["verdict", "accept", "fair", "winner", "recommend", "win/win"]);
  const GRADE_LABELS = Object.freeze(["Clear gain", "Small gain", "Too close to call", "Small loss", "Clear loss"]);
  const GRADED_HEADLINE = "Lineup scenario from central (p50) projections, everyone assumed available.";
  const GRADED_SUBLINE_TAIL = "Keeper value and draft picks are not valued.";
  const COPY = Object.freeze({
    simulationOff: "Simulation is off: the 2025-season test failed (on synthetic 15-player rosters), and the per-format 2026 test reports in January 2027.",
    bestBall: "Best-ball scoring picks your top scorers after the games; lineup advice doesn't apply.",
    noEvidence: "No measured evaluation for your league's scoring and this model.",
    horizon: "through NFL week 17, regardless of your league's schedule",
    aggregation: "sum of weekly medians through NFL week 17, not a season median",
  });
  const ROS_METRIC = "rest_of_season_points_mae";

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
  // The exact roster matcher lives in session.js now (spec §4.3); re-exported
  // under the old name so callers and the fixture keep one import.
  const identifyRoster = Session.identifyRoster;
  // Every slot but IR/TAXI is a roster spot: K/DEF/IDP slots count too.
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
    const subline = `Sum of weekly central (p50) lineup scenarios for weeks ${ctx.firstWeek}–${ctx.endWeek}; week ${ctx.currentWeek} is excluded because trades may process after games start. ${ctx.graded ? GRADED_SUBLINE_TAIL : SUBLINE_TAIL}`;
    const assumptions = [];
    for (const [id, weeks] of Object.entries(ctx.excludeWeeks || {})) if (weeks.length) assumptions.push(`${pname(id)} assumed unavailable weeks ${weeks.join(", ")} (your assumption, not a return-date prediction)`);
    for (const [rid, ids] of Object.entries(ctx.drops || {})) for (const id of ids) assumptions.push(`${name(rid)} drops ${pname(id)}`);
    return { headline: ctx.graded ? GRADED_HEADLINE : HEADLINE, subline, sides, assumptions };
  }
  // Plain-English bottom line, one sentence group per side, read straight off
  // the engine's per-week before/after starting lineups (result.weeks[].sides[]
  // .before/.after.lineup). A week "changes" when the set of starters differs;
  // the lineup size is fixed by the slots, so who enters and who leaves always
  // pair up. States deltas and lineup moves only -- no judging words.
  // ctx.ownLabel names the analysed side for a viewer ("Your lineup" otherwise).
  const fmt1 = x => { const r = Math.round(x * 10) / 10; return r === 0 ? "0.0" : `${r < 0 ? "−" : "+"}${Math.abs(r).toFixed(1)}`; };
  const andList = xs => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  function lineupSummary(result, ctx) {
    const span = `weeks ${ctx.firstWeek}–${ctx.endWeek}`;
    const label = i => (i === 0 ? (ctx.ownLabel || "Your lineup") : (ctx.names && ctx.names[result.sides[i].rosterId]) || `roster ${result.sides[i].rosterId}`);
    const perSide = result.sides.map((s, i) => {
      const changes = [];
      for (const w of result.weeks) {
        const side = w.sides[i];
        const before = side.before.lineup || [], after = side.after.lineup || [];
        const bIds = new Set(before.map(p => String(p.id))), aIds = new Set(after.map(p => String(p.id)));
        const enter = after.filter(p => !bIds.has(String(p.id))).map(p => p.name);
        const leave = before.filter(p => !aIds.has(String(p.id))).map(p => p.name);
        if (enter.length || leave.length) changes.push({ week: w.week, delta: side.delta, move: `${andList(enter)} ${enter.length === 1 ? "starts" : "start"} instead of ${andList(leave)}` });
      }
      return { i, delta: s.delta, changes };
    });
    if (perSide.every(s => !s.changes.length)) return [`No change to either starting lineup in ${span} under these assumptions.`];
    return perSide.map(({ i, delta, changes }) => {
      const head = `${label(i)}: ${fmt1(delta)} pts over ${span}.`;
      if (!changes.length) return `${head} No change to the starting lineup.`;
      if (changes.length === 1) return `${head} All of it is week ${changes[0].week}: ${changes[0].move}.`;
      const ranked = changes.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.week - b.week);
      const item = c => `week ${c.week} (${fmt1(c.delta)}): ${c.move}`;
      if (ranked.length <= 3) return `${head} Lineup changes in ${ranked.length} weeks: ${ranked.map(item).join("; ")}.`;
      const top = ranked.slice(0, 3), rest = ranked.slice(3);
      const restSum = rest.reduce((a, c) => a + c.delta, 0);
      return `${head} Lineup changes in ${ranked.length} weeks; the 3 largest: ${top.map(item).join("; ")}; and smaller changes in ${rest.length} other week${rest.length === 1 ? "" : "s"} (${fmt1(restSum)} pts combined).`;
    });
  }
  function coverageText(error) {
    if (error && Array.isArray(error.coverageIssues)) {
      const players = new Set(error.coverageIssues.map(x => x.id)).size;
      return { headline: `Comparison blocked: ${players} player(s), ${error.coverageIssues.length} player-week(s) without a projection`,
               rows: error.coverageIssues.map(x => `${x.name} · week ${x.week} · ${x.reason}`) };
    }
    return { headline: "Comparison blocked", rows: [String(error && error.message || error)] };
  }

  // --- league context (spec §6.1, §4, §6.2, §7.2) --------------------------
  // The lines above the columns: the format line (eligibility wins for best
  // ball), the scoring banner and footnotes, the aggregation label beside the
  // lineup totals, and the simulation note.
  function contextLines({ format, view }) {
    const out = [];
    if (format && format.text) out.push(format.text);
    if (view && view.disclosures) {
      if (view.disclosures.banner) out.push(view.disclosures.banner);
      for (const f of view.disclosures.footnotes || []) out.push(f);
    }
    out.push(`Lineup totals. Horizon: ${COPY.horizon}. Totals: ${COPY.aggregation}.`);
    out.push(COPY.simulationOff);
    return out;
  }
  // The rest-of-season evaluation: a measured number only when a record binds
  // to the CURRENT output (LeagueData.evidenceFor: the league's effective
  // scoring and this model's method), else the fallback (spec §3.2).
  function evidenceLines(evaluation, view) {
    const records = evaluation && Array.isArray(evaluation.records) ? evaluation.records : [];
    for (const r of records) {
      if (!r || r.metric !== ROS_METRIC) continue;
      const rec = LD().evidenceFor(evaluation, r.id, view && view.lens, view && view.method);
      if (!rec || !Array.isArray(rec.values)) continue;
      const num = x => Number.isFinite(x) ? x.toFixed(2) : "n/a";
      const lines = ["Rest-of-season accuracy, measured under this league's scoring and this model:"];
      for (const h of rec.values.filter(v => v && v.position === "ALL"))
        lines.push(`${h.horizon} week${h.horizon === 1 ? "" : "s"} ahead: model MAE ${num(h.model_mae)} vs baseline ${num(h.baseline_mae)} (${h.paired_player_forecasts ?? "n/a"} paired forecasts)`);
      return lines;
    }
    return [`Rest-of-season accuracy: ${COPY.noEvidence}`];
  }
  // Best ball / an unknown slot: the analysed roster's rest-of-season values,
  // active skill players only. Unknown is not 0. Every number comes through
  // `gate` = LeagueData.rosValues(view, {..., policy: ROS_POLICY.trade}): the
  // same season/week/72 h/future-date and current-team checks the lineup
  // analyzer (SeasonTrade.analyze) applies; a failed check withholds the
  // number with its reason and keeps the player listed (astra I1).
  function rosValueLines(board, roster, catalog, gate) {
    if (!gate || typeof gate.of !== "function") throw new Error("rosValueLines needs the rest-of-season gate (LeagueData.rosValues)");
    const bySleeper = new Map(((board && board.players) || []).map(p => [String(p.sleeper_id), p]));
    const locked = new Set([...(roster.reserve || []), ...(roster.taxi || [])].map(String));
    const lines = [`Rest-of-season values. Horizon: ${COPY.horizon}. Totals: ${COPY.aggregation}.`];
    if (gate.reason) lines.push(`Rest-of-season values withheld: ${gate.reason}.`);
    for (const id of (roster.players || []).map(String)) {
      const c = (catalog && catalog[id]) || {}, b = bySleeper.get(id);
      if (locked.has(id) || !SKILL.has(c.position)) continue;
      const g = gate.of(id);
      const value = Number.isFinite(g.value) ? g.value.toFixed(2)
        : g.reason ? (gate.reason ? "withheld" : `withheld — ${g.reason}`) : "no rest-of-season projection";
      lines.push(`${c.full_name || (b && b.name) || id} · ${c.position} · ${value}`);
    }
    return lines;
  }

  // --- measured-method helpers (dormant: simulation is off, spec §6.2) --------
  // Pure; kept pinned to the backtest by sim_parity_fixture for the January
  // format-test gate. No page path calls them in phase 1.
  // |Δ| < E is too close to call; E <= |Δ| < kE small; |Δ| >= kE clear. Δ = 0
  // is always "too close" (even at E = 0). Pure.
  function gradeLabel(delta, E, k = 2) {
    if (![delta, E, k].every(Number.isFinite) || E < 0 || k < 1) throw new Error("gradeLabel needs finite delta, E >= 0 and k >= 1");
    const a = Math.abs(delta);
    if (a === 0 || a < E) return "Too close to call";
    return `${a >= k * E ? "Clear" : "Small"} ${delta > 0 ? "gain" : "loss"}`;
  }
  const usableHorizon = h => h && typeof h === "object" && Number.isFinite(h.weeks) && h.weeks > 0 && h.strata && typeof h.strata === "object"
    && Object.values(h.strata).some(s => s && Number.isFinite(s.E) && s.E >= 0);
  // The horizon whose remaining-week count is nearest to the live one; a tie
  // goes to the shorter horizon. Malformed or empty -> null.
  function pickHorizon(horizons, liveWeeks) {
    if (!Array.isArray(horizons) || !Number.isFinite(liveWeeks)) return null;
    let best = null;
    for (const h of horizons.filter(usableHorizon)) {
      const d = Math.abs(h.weeks - liveWeeks);
      if (!best || d < best.d || (d === best.d && h.weeks < best.h.weeks)) best = { d, h };
    }
    return best && best.h;
  }
  // trade = {positions: [position of every moved player], sides: [{give:[share of
  // weeks each player this side gives starts in its own current-method BEFORE
  // lineup], receive:[share for each it gets in its AFTER lineup]} x2]}.
  // depth_for_starter (spec §10.2): some side gives at least one starter (>= half
  // the weeks) and receives no player who starts in at least half the weeks.
  // `horizon` is the chosen horizon entry (strata, lopsided_cutoff).
  function stratumOf(trade, currentDelta, horizon) {
    const out = [];
    out.push(new Set(trade.positions).size <= 1 ? "same_position" : "cross_position");
    if ((trade.sides || []).some(s => s.give.some(x => x >= 0.5) && !s.receive.some(x => x >= 0.5))) out.push("depth_for_starter");
    const cut = horizon && horizon.lopsided_cutoff;
    if (Number.isFinite(cut) && Number.isFinite(currentDelta) && Math.abs(currentDelta) >= cut) out.push("lopsided");
    return out;
  }
  // The lopsided measure, as the backtest measured it (spec §10.3): the larger of the two sides' |Δ|, so a trade
  // is lopsided whichever side you view it from. `sides` = analyze's result.sides.
  function lopsidedMeasure(sides) {
    return Math.max(...(sides || []).map(s => Math.abs(s.delta)));
  }
  // Conservative error: the largest measured E among the trade's strata. A stratum the trade belongs to but that has
  // no measured E is not skipped -- unknown is not zero -- so the whole trade is unmeasured (null).
  function errorFor(strataNames, horizon) {
    const es = strataNames.map(n => horizon.strata[n]);
    if (!es.length || !es.every(s => s && Number.isFinite(s.E))) return null;
    return Math.max(...es.map(s => s.E));
  }
  // Spec §8: shown with every grade. The wording avoids GRADE_FORBIDDEN.
  const LIMITATIONS = Object.freeze([
    "Player outcomes are simulated as independent: there is no stack or game correlation.",
    "Injury timing comes from position-level rates and current tags, not injury type.",
    "Tags are the latest Sleeper status; the measurement used the report from the week before.",
    "The error was measured on synthetic 2023–2025 leagues, not real rosters.",
    "Rosters are frozen after the trade: no later adds, drops or trades are modeled.",
    "Draft picks and keeper value are not valued.",
    "Weeks after 17 are not modeled.",
  ]);
  function gradeText(sim, ctx) {
    const span = `weeks ${ctx.firstWeek}–${ctx.endWeek}`, n = sim.weeks.length;
    const sides = sim.sides.map((s, i) => ({
      name: i === 0 ? "Your lineup" : (ctx.names && ctx.names[s.rosterId]) || `roster ${s.rosterId}`,
      label: gradeLabel(s.mean, ctx.E, ctx.k),
      detail: `${fmt1(s.mean)} pts over ${span} (about ${fmt1(s.mean / n)} a week); likely range ${fmt1(s.p10)} to ${fmt1(s.p90)}; typical measured error on trades like this: ${ctx.E.toFixed(1)} pts`,
    }));
    return {
      heading: `Simulated rest-of-season grade, ${span}`,
      sides,
      footnote: "Simulated from projections, with injury risk measured in past seasons. Draft picks and keeper value are not valued.",
      limitations: LIMITATIONS.slice(),
    };
  }
  // Positional rank = rank of ros_rank within the player's position among the
  // file's players (1 = best).
  function positionalRanks(rosRanks) {
    const byPos = new Map();
    for (const [id, r] of rosRanks) { if (!byPos.has(r.position)) byPos.set(r.position, []); byPos.get(r.position).push([id, r.ros_rank]); }
    const out = new Map();
    for (const list of byPos.values()) { list.sort((a, b) => a[1] - b[1]); list.forEach(([id], i) => out.set(id, i + 1)); }
    return out;
  }
  // Market check, shown beside the grade and never blended into it. moves =
  // {delta, give:[{gsis, name}], receive:[{gsis, name, started, of}]} from the
  // user's side; delta is the model's mean Δ for that side. Returns null unless
  // every moved player has a ROS rank AND the rank-implied direction (sum of
  // 1/overall rank received minus given; lower rank = better) has the opposite
  // sign to the model's. Names the players and ranks, plus a roster reason for
  // any received player who would start in under half the weeks.
  function marketText(moves, rosRanks) {
    if (!moves || !(rosRanks instanceof Map) || !rosRanks.size) return null;
    const give = moves.give || [], receive = moves.receive || [], all = [...give, ...receive];
    if (!all.length || !Number.isFinite(moves.delta) || moves.delta === 0) return null;
    const info = p => rosRanks.get(p.gsis);
    if (!all.every(p => info(p) && Number.isFinite(info(p).ros_rank) && info(p).ros_rank > 0)) return null;
    const value = list => list.reduce((n, p) => n + 1 / info(p).ros_rank, 0);
    const implied = value(receive) - value(give);
    if (implied === 0 || Math.sign(implied) === Math.sign(moves.delta)) return null;
    const pos = positionalRanks(rosRanks);
    const rank = x => (Number.isInteger(x) ? String(x) : x.toFixed(1));
    const desc = p => `${p.name} (${info(p).position}${pos.get(p.gsis)}, overall ${rank(info(p).ros_rank)})`;
    const side = list => (list.length ? andList(list.map(desc)) : "nobody");
    let text = `Market check: the model shows a ${moves.delta > 0 ? "gain" : "loss"}, but expert rest-of-season ranks rate what you ${implied > 0 ? "get above what you give" : "give above what you get"}. You get ${side(receive)}; you give ${side(give)}.`;
    const thin = receive.filter(p => Number.isFinite(p.started) && Number.isFinite(p.of) && p.of > 0 && p.started / p.of < 0.5);
    if (thin.length) text += ` Roster reason: ${andList(thin.map(p => `${p.name} would start in only ${p.started} of ${p.of} weeks in your lineup`))}, so his rank counts for less here.`;
    return text;
  }
  // Weeks each moved player starts in a central lineup, read off analyze's
  // per-week lineups. `receive`/`give`: the started counts of my received
  // players (my after-lineup) and of the players I give (partner's after-lineup),
  // for the market check. `sides`: start shares for the depth stratum, per side
  // {give: before-lineup shares of its own outgoing players, receive: after-lineup
  // shares of its incoming players}.
  function startCounts(result, giveIds, receiveIds) {
    const of = result.weeks.length;
    const count = (side, key, id) => result.weeks.filter(w => (w.sides[side][key].lineup || []).some(p => String(p.id) === String(id))).length;
    return {
      of,
      receive: receiveIds.map(id => ({ id, started: count(0, "after", id) })),
      give: giveIds.map(id => ({ id, started: count(1, "after", id) })),
      sides: [
        { give: giveIds.map(id => count(0, "before", id) / of), receive: receiveIds.map(id => count(0, "after", id) / of) },
        { give: receiveIds.map(id => count(1, "before", id) / of), receive: giveIds.map(id => count(1, "after", id) / of) },
      ],
    };
  }

  // --- statics: once per document, a failure retries on the next call ----------
  let batchPromise = null;
  const batch = () => batchPromise || (batchPromise = LD().loadBatch().catch(e => { batchPromise = null; throw e; }));
  const _reset = () => { batchPromise = null; };   // test hook: a cold document

  // --- controller -----------------------------------------------------------
  // Everything below touches the DOM; the pure helpers above are what the
  // fixture pins. Nothing here calls Trade.* or TradeMode.*: the pre-draft
  // engine's numbers are not defined in season (spec §6.6). This controller
  // makes no Sleeper call of its own: the league, users, rosters and NFL state
  // come from the committed Session bundle, the ~5 MB player catalog from
  // Session.catalog() (once per document), and a compare re-reads rosters
  // (and, as every refresh does, the league settings) through Session.refresh.

  // Same rule as TradeMode.teamName / Session.teamName.
  const teamNameOf = (user, rosterId) => (user && user.metadata && user.metadata.team_name) || (user && user.display_name) || `Roster ${rosterId}`;
  const activeIds = roster => {
    const locked = new Set([...(roster.reserve || []), ...(roster.taxi || [])].map(String));
    return (roster.players || []).map(String).filter(id => !locked.has(id));
  };
  const weekMismatch = (startWeek, week) => `remaining-season projections are for week ${startWeek}, the league is in week ${week}; wait for the next refresh`;
  const CHANGED = "Rosters changed since they were loaded — the columns were redrawn from the fresh snapshot; choose again.";
  const statusWord = s => String(s || "").replace(/_/g, " ");
  // What a compare's own refresh must not move for its result to stand: the
  // league settings the views and the lineup slots were built from.
  // Waiver bookkeeping inside league.settings (daily_waivers_last_ran, leg, ...) moves
  // on every refresh, so only the settings that shape views and slots are keyed.
  const settingsKey = league => JSON.stringify(league ? [league.league_id, league.season, league.status, league.total_rosters, league.roster_positions, league.scoring_settings, league.settings && league.settings.type, league.settings && league.settings.best_ball] : null);
  const sameIdentity = (a, b) => (!a && !b) || (!!a && !!b && a.userId === b.userId);
  class PreflightError extends Error {}

  function init({ els }) {
    const W = typeof window !== "undefined" ? window : {};
    const SESSION = W.Session || Session;   // the page global (same object in the browser); node tests can script it
    const el = (tag, text, cls) => {
      const node = document.createElement(tag);
      if (text !== undefined && text !== null) node.textContent = text;
      if (cls) node.className = cls;
      return node;
    };
    const setStatus = t => { els.status.textContent = t; };
    let loadSeq = 0, busy = false, loading = false;
    // Bumped by every input change, every load and every bundle change the
    // controller did not ask for: a compare whose refresh was in flight when
    // it moved must not render under the new inputs.
    let compareSeq = 0;
    // The committed bundle the columns were drawn from (or adopted for a
    // compare). Session.onChange fires for every state move; only a
    // DIFFERENT committed bundle re-runs the load.
    let currentBundle = null;
    // Everything loaded for the current bundle. Reset wholesale on load. The
    // league is the committed bundle's own object (spec §5.2).
    const S = { bundle: null, league: null, rosters: [], users: new Map(), state: null, me: null, role: null, partner: null,
      batch: null, view: null, remaining: null, board: null, catalog: null, format: null, note: null, loadedProvenance: "" };
    const first = () => Math.max(Number(S.state.week), S.remaining.start_week) + 1;
    const last = () => S.remaining.end_week;
    const rosterName = rid => {
      const r = S.rosters.find(x => String(x.roster_id) === String(rid));
      return teamNameOf(r && S.users.get(r.owner_id), rid);
    };
    const viewer = () => S.role === "viewer";
    const who = () => viewer() ? `Viewing ${rosterName(S.me.roster_id)}` : `you are ${rosterName(S.me.roster_id)}`;
    const playerName = id => (S.catalog && S.catalog[id] && S.catalog[id].full_name) || `Sleeper #${id}`;
    // One object per column. `players` are the selected trade assets, `drops`
    // the explicit drop choices, `weeks` the raw "assume unavailable" text per
    // player id (parsed on input; `errors` holds the parse message for any
    // field that does not).
    const newSide = (ul, dropsEl) => ({ ul, dropsEl, roster: null, active: [], players: new Set(), drops: new Set(), weeks: new Map(), errors: new Map(), needed: 0 });
    const sides = { mine: newSide(els.mine, els.mineDrops), theirs: newSide(els.theirs, els.theirsDrops) };
    const sideName = s => s.roster ? rosterName(s.roster.roster_id) : "";

    function setEyebrow(week) {
      if (!S.league) { els.eyebrow.textContent = ""; return; }
      const name = S.league.name || `League ${S.league.league_id}`;
      els.eyebrow.textContent = `${name} · ${S.league.season}${week ? ` week ${week}` : ""} · conditional lineup scenario`;
    }

    // --- load ---------------------------------------------------------------
    // Kept checks (spec §5.3): in-season league, complete league data, the
    // regular season of the league's own season and a current NFL week.
    function preflightLeague({ league, users, rosters, state }) {
      const fail = msg => { throw new PreflightError(msg); };
      if (league.status !== "in_season") fail(`this league is ${league.status}, not in season`);
      if (!Array.isArray(users) || !Array.isArray(rosters)) fail("Sleeper returned incomplete league data");
      if (rosters.length !== league.total_rosters) fail(`Sleeper returned ${rosters.length} rosters for a ${league.total_rosters}-team league`);
      if (!state || String(state.season) !== String(league.season) || state.season_type !== "regular") fail(`Sleeper reports the ${state && state.season} ${state && state.season_type}; this tool needs the ${league.season} regular season`);
      const week = Number(state.week);
      if (!Number.isInteger(week)) fail("current NFL week unavailable");
      return week;
    }
    // The projections the views produced: present (or the end state named),
    // the league's season, aligned to the current week, with weeks left.
    function preflightProjections({ league, remaining, remainingReason, week, catalog }) {
      const fail = msg => { throw new PreflightError(msg); };
      if (!remaining) fail(remainingReason || LD().COPY.noRemaining);
      if (remaining.season !== Number(league.season)) fail(`remaining-season projections are for ${remaining.season}; the league is in ${league.season}`);
      if (remaining.start_week !== week) fail(weekMismatch(remaining.start_week, week));
      if (!Number.isInteger(remaining.end_week) || week + 1 > remaining.end_week) fail(`no remaining weeks to compare after week ${week}`);
      if (!catalog || typeof catalog !== "object") fail("player catalog unavailable");
    }

    // Account- and league-derived surfaces go dark together: columns,
    // controls, result, provenance, context (spec §4.4 rule 2 -- hidden, not
    // just labeled).
    function hideAll() {
      hideResult();
      els.provenance.textContent = "";
      els.controls.hidden = true; els.cols.hidden = true; els.compare.disabled = true; els.warn.hidden = true;
      if (els.context) { els.context.replaceChildren(); els.context.hidden = true; }
    }

    // Why the columns are not showing: the session's error, still loading, or
    // the live resolver's own refusal in its order (league status, league
    // type, no roster under analysis). Week 1 is a placeholder: the resolver
    // only range-checks it; the real week is checked when the columns load.
    function gateMessage(bundle) {
      const err = SESSION.error();
      if (err) return err;
      if (!bundle) return "loading league…";
      let msg;
      try { LW().resolve({ bundle, week: 1 }); return "loading league…"; } catch (e) { msg = e.message; }
      if (msg === LW().NO_ANALYSIS && (bundle.myRosterStatus === "none" || bundle.myRosterStatus === "ambiguous"))
        return `${SESSION.chipText(bundle, "ready", Date.now())} Choose a team to view in the league panel above.`;
      return msg;
    }

    // Copy the bundle's live data into the controller's snapshot. League,
    // users, rosters, state and the analysed roster never come from anywhere
    // else.
    function adopt(bundle) {
      currentBundle = bundle;
      S.bundle = bundle; S.league = bundle.league;
      S.rosters = bundle.rosters; S.users = new Map(bundle.users.map(u => [u.user_id, u]));
      S.state = bundle.state; S.me = bundle.analysisRoster; S.role = bundle.analysisRole;
      setEyebrow(Number(bundle.state.week));
    }

    // Rebuild both columns from S. Selections are cleared (a redraw is a new
    // roster snapshot, so the old picks may not exist any more).
    function redraw() {
      fillPartners();
      resetSide(sides.mine, S.me);
      onPartnerChange();
    }

    // The load body: everything downstream of a committed in-season bundle
    // with a roster under analysis. Fetches only the once-per-document batch
    // and catalog; the views are recomputed for THIS bundle's league.
    async function load(bundle) {
      const seq = ++loadSeq;
      compareSeq++;
      const stale = () => seq !== loadSeq;
      loading = true;
      currentBundle = bundle;
      try {
        hideAll();
        setStatus("reading projections, scoring and the player catalog…");
        const [b, catalog] = await Promise.all([batch(), SESSION.catalog()]);
        if (stale()) return;
        const { league, users, rosters, state } = bundle;
        const week = preflightLeague({ league, users, rosters, state });
        let view;
        try {
          LW().resolve({ bundle, week });
          view = LD().views(b, league, { week, catalog });
        } catch (e) { throw new PreflightError(e.message); }
        preflightProjections({ league, remaining: view.remaining, remainingReason: view.remainingReason, week, catalog });
        const format = await LD().formatLine(league, b.formats);
        if (stale()) return;
        adopt(bundle);
        Object.assign(S, { batch: b, view, remaining: view.remaining, board: view.board, catalog, format, week });
        const type = LD().leagueType(league), unknown = LD().slotSupport(league).unknown;
        S.note = type.bestBall ? COPY.bestBall
          : unknown.length ? `Unsupported lineup slot: ${unknown.join(", ")} — no trade lineup comparison for this league; the rest-of-season values below still apply.` : null;
        renderContext();
        renderWarn();
        S.loadedProvenance = provenanceText(null);
        els.provenance.textContent = S.loadedProvenance;
        if (S.note) renderNote();
        else {
          redraw();
          els.controls.hidden = false; els.cols.hidden = false;
        }
        setStatus(`${rosters.length} teams loaded — ${who()}`);
      } catch (e) {
        if (stale() || SESSION.isSuperseded(e)) return;
        setStatus(e instanceof PreflightError ? e.message : `load failed: ${e.message} — refresh from the league panel to retry`);
      } finally {
        if (!stale()) loading = false;
      }
    }

    // Session.onChange driver. Gated on the committed bundle and its roster
    // under analysis (owner or viewer), never on state() === "error" alone.
    // A bundle this controller did not ask for redraws the columns and
    // invalidates any compare in flight; the one exception is the bundle
    // compare() itself requested through Session.refresh -- same identity,
    // same analysed roster, same league settings, arriving while `busy` --
    // which is adopted as data so the compare can finish against it.
    function sync() {
      const bundle = SESSION.bundle();
      if (!bundle || !bundle.analysisRoster || !bundle.league || bundle.league.status !== "in_season") {
        ++loadSeq; compareSeq++; currentBundle = null; loading = false;
        hideAll(); setStatus(gateMessage(bundle));
        return;
      }
      if (bundle === currentBundle) return;
      const sameAnalysis = busy && currentBundle && S.me && S.league
        && bundle.analysisRole === S.role && sameIdentity(bundle.identity, currentBundle.identity)
        && String(bundle.analysisRoster.roster_id) === String(S.me.roster_id)
        && settingsKey(bundle.league) === settingsKey(S.league);
      if (sameAnalysis) { adopt(bundle); return; }
      load(bundle);
    }

    function renderContext() {
      if (!els.context) return;
      els.context.replaceChildren();
      for (const line of contextLines({ format: S.format, view: S.view })) els.context.append(el("p", line));
      els.context.hidden = false;
    }
    // Loud half of the load: what the page cannot claim, said once.
    function renderWarn() {
      const notes = [];
      const evidence = evidenceLines(S.batch.evaluation, S.view);
      if (evidence.length === 1) notes.push(COPY.noEvidence);
      els.warn.textContent = notes.join(" · ");
      els.warn.hidden = !notes.length;
    }
    // Best ball / unknown slot: the note and the analysed roster's
    // rest-of-season values; no lineup comparison.
    function renderNote() {
      const out = els.result;
      out.replaceChildren();
      out.append(el("p", S.note, "season-subline"));
      const gate = LD().rosValues(S.view, { league: S.league, week: S.week, now: Date.now(), catalog: S.catalog, policy: LD().ROS_POLICY.trade });
      for (const line of rosValueLines(S.board, S.me, S.catalog, gate)) out.append(el("p", line));
      out.hidden = false;
    }

    function fillPartners() {
      els.partner.replaceChildren();
      for (const r of S.rosters) {
        if (String(r.roster_id) === String(S.me.roster_id)) continue;
        const o = el("option", rosterName(r.roster_id));
        o.value = String(r.roster_id);
        els.partner.append(o);
      }
    }

    function resetSide(side, roster) {
      side.roster = roster; side.active = activeIds(roster);
      side.players.clear(); side.drops.clear(); side.weeks.clear(); side.errors.clear(); side.needed = 0;
    }

    function onPartnerChange() {
      const partner = S.rosters.find(r => String(r.roster_id) === els.partner.value)
        || S.rosters.find(r => String(r.roster_id) !== String(S.me.roster_id));
      if (!partner) { setStatus("this league has only one team — nobody to trade with"); return; }
      S.partner = partner;
      els.partner.value = String(partner.roster_id);
      resetSide(sides.theirs, partner);
      // My selections survive a partner change; my drop obligations do not,
      // because they depend on how many players the other side sends back.
      sides.mine.drops.clear();
      drawColumns();
      updateDrops();
      onInputChange();
    }

    // --- columns ------------------------------------------------------------
    // A viewer is never "you": the headings name the viewed team.
    function headingFor(side) {
      if (side === sides.mine) return viewer() ? `${sideName(side)} gives` : `You give — ${sideName(side)}`;
      return viewer() ? `${sideName(sides.mine)} gets — from ${sideName(side)}` : `You get — ${sideName(side)}`;
    }
    function drawColumns() {
      for (const side of [sides.mine, sides.theirs]) {
        side.ul.replaceChildren();
        const heading = side.ul.parentElement && side.ul.parentElement.querySelector("h2");
        if (heading) heading.textContent = headingFor(side);
        const skill = [], other = [], locked = [], missing = [];
        const lockedSet = new Set([...(side.roster.reserve || []), ...(side.roster.taxi || [])].map(String));
        for (const id of (side.roster.players || []).map(String)) {
          const pos = (S.catalog[id] || {}).position;
          (lockedSet.has(id) ? locked : !S.catalog[id] ? missing : SKILL.has(pos) ? skill : other).push(id);
        }
        const order = { QB: 0, RB: 1, WR: 2, TE: 3 };
        skill.sort((a, b) => (order[S.catalog[a].position] - order[S.catalog[b].position]) || playerName(a).localeCompare(playerName(b)));
        for (const id of skill) side.ul.append(playerRow(side, id));
        for (const id of other) side.ul.append(disabledRow(id, "no modeled points"));
        for (const id of missing) side.ul.append(disabledRow(id, "not in the player catalog — reload the page"));
        for (const id of locked) side.ul.append(disabledRow(id, "IR/taxi — not tradeable in this version"));
      }
    }

    const rowLabel = id => {
      const c = S.catalog[id] || {};
      return `${playerName(id)} · ${c.position || "?"} · ${c.team || "FA"}`;
    };

    function disabledRow(id, note) {
      const li = el("li", null, "season-row season-disabled");
      li.dataset.id = id;
      const label = el("label"), box = el("input");
      box.type = "checkbox"; box.disabled = true;
      label.append(box, document.createTextNode(` ${rowLabel(id)}`));
      li.append(label, el("span", note, "trade-why"));
      return li;
    }

    function playerRow(side, id) {
      const c = S.catalog[id] || {};
      const li = el("li", null, "season-row");
      li.dataset.id = id;
      const label = el("label"), box = el("input");
      box.type = "checkbox"; box.dataset.id = id; box.checked = side.players.has(id);
      label.append(box, document.createTextNode(` ${rowLabel(id)}`));
      li.append(label);
      const tagged = Boolean(c.injury_status);
      if (tagged) li.append(el("span", `reported tag: ${c.injury_status} — no return-date inference`, "trade-why"));
      // The user states the assumption; a tag never fills the field in (§6.3).
      // The field is optional: hidden behind a link on a ticked player, shown
      // outright only for a tagged player (or one that already has text).
      const weeks = el("input", null, "season-weeks");
      weeks.type = "text"; weeks.autocomplete = "off";
      weeks.placeholder = "optional — leave blank if he plays, e.g. 3-5";
      weeks.setAttribute("aria-label", `optional: weeks ${playerName(id)} is out`);
      weeks.value = side.weeks.get(id) || "";
      let revealed = Boolean(weeks.value);
      const toggle = el("button", "Out some weeks? (optional)", "season-weeks-toggle");
      toggle.type = "button";
      const showState = () => {
        weeks.hidden = !(tagged || (box.checked && revealed));
        toggle.hidden = !(box.checked && weeks.hidden);
      };
      showState();
      toggle.addEventListener("click", () => { revealed = true; showState(); if (typeof weeks.focus === "function") weeks.focus(); });
      const err = el("span", side.errors.get(id) || "", "season-weeks-error");
      err.hidden = !side.errors.has(id);
      const parse = () => {
        side.weeks.set(id, weeks.value);
        try { parseWeeks(weeks.value, first(), last()); side.errors.delete(id); err.textContent = ""; err.hidden = true; }
        catch (e) { side.errors.set(id, e.message); err.textContent = e.message; err.hidden = false; }
      };
      box.addEventListener("change", () => {
        if (box.checked) side.players.add(id); else side.players.delete(id);
        li.classList.toggle("picked", box.checked);
        // Unticking an untagged player hides and clears his field, as before
        // (a tagged player's field stays, since he is still on a roster in the
        // scenario); ticking again starts hidden behind the link.
        if (!box.checked) revealed = false;
        showState();
        if (weeks.hidden) { weeks.value = ""; side.weeks.delete(id); side.errors.delete(id); err.textContent = ""; err.hidden = true; }
        updateDrops();
        onInputChange();
      });
      weeks.addEventListener("input", () => { parse(); onInputChange(); });
      li.append(toggle, weeks, err);
      return li;
    }

    // --- drops --------------------------------------------------------------
    // Capacity counts every non-IR/TAXI slot, so K/DEF/IDP occupy spots and
    // count in `active` even though only skill players can be traded here.
    function updateDrops() {
      const capacity = capacityOf(S.league);
      for (const [which, other] of [["mine", "theirs"], ["theirs", "mine"]]) {
        const s = sides[which], o = sides[other];
        if (!s.roster) continue;
        s.needed = neededDrops({ activeCount: s.active.length, giveCount: s.players.size, receiveCount: o.players.size, capacity });
        for (const id of [...s.drops]) if (s.players.has(id)) s.drops.delete(id);
        s.dropsEl.replaceChildren();
        if (!s.needed) { s.drops.clear(); s.dropsEl.hidden = true; continue; }
        s.dropsEl.hidden = false;
        s.dropsEl.append(el("span", `${sideName(s)} must drop ${s.needed} player(s) to fit this trade`, "season-drop-prompt"));
        for (const id of s.active) {
          if (s.players.has(id)) continue;
          const label = el("label", null, "season-drop"), box = el("input");
          box.type = "checkbox"; box.checked = s.drops.has(id);
          label.append(box, document.createTextNode(` ${rowLabel(id)}`));
          box.addEventListener("change", () => {
            if (box.checked) s.drops.add(id); else s.drops.delete(id);
            onInputChange();
          });
          s.dropsEl.append(label);
        }
      }
    }

    // --- gate ---------------------------------------------------------------
    // The gate proper, independent of whether a compare is already running.
    function inputsValid() {
      // No acknowledgment step: the availability assumption is passed to the
      // engine as assumeAvailable and stated in the result's assumptions.
      if (!S.me || !S.partner || S.note) return false;
      if (sides.mine.players.size + sides.theirs.players.size === 0) return false;
      for (const s of [sides.mine, sides.theirs]) {
        if (s.errors.size) return false;
        if (s.drops.size < s.needed) return false;
      }
      return true;
    }
    const canCompare = () => !busy && inputsValid();
    const refreshCompare = () => { els.compare.disabled = !canCompare(); };
    // Any input change: the scenario on screen no longer describes the inputs.
    function onInputChange() { compareSeq++; hideResult(); refreshCompare(); }
    function hideResult() {
      els.result.hidden = true;
      els.result.replaceChildren();
      els.provenance.textContent = S.loadedProvenance;
    }

    // --- compare ------------------------------------------------------------
    async function compare() {
      if (!canCompare()) return;
      busy = true; refreshCompare();
      hideResult();
      setStatus("comparing lineups…");
      try {
        const seq = compareSeq;
        // Rosters, NFL state AND the league settings are re-read through the
        // session so the chip's age moves with them. The NEW bundle's
        // post-fetch time is the engine's snapshotAt (its <=60 s rule); sync()
        // adopts the same bundle as it commits when the settings did not
        // move, so S.rosters/S.state/S.league match `b`. Moved settings reload
        // the page instead and supersede this compare (spec §5.2).
        const b = await SESSION.refresh({ scope: "rosters" });
        if (seq !== compareSeq || !inputsValid() || b !== currentBundle) { if (!loading) setStatus("inputs changed during the comparison — compare again"); return; }
        const rosters = b.rosters, state = b.state;
        const snapshotAt = b.rostersFetchedAt;
        const week = Number(state && state.week);
        if (!Number.isInteger(week) || week !== S.remaining.start_week) { setStatus(weekMismatch(S.remaining.start_week, state && state.week)); return; }
        for (const s of [sides.mine, sides.theirs]) {
          const fresh = (rosters || []).find(r => String(r.roster_id) === String(s.roster.roster_id));
          const active = new Set(fresh ? activeIds(fresh) : []);
          // The fresh rosters are already adopted (sync); redraw the columns
          // from them so the user is not left pointing at players who moved.
          if (![...s.players, ...s.drops].every(id => active.has(id))) { redraw(); setStatus(CHANGED); return; }
        }
        const give = [...sides.mine.players], receive = [...sides.theirs.players];
        const drops = {};
        for (const s of [sides.mine, sides.theirs]) if (s.drops.size) drops[String(s.roster.roster_id)] = [...s.drops];
        const excludeWeeks = {};
        for (const s of [sides.mine, sides.theirs]) for (const [id, text] of s.weeks) {
          const ws = parseWeeks(text, first(), last());
          if (ws.length) excludeWeeks[id] = ws;
        }
        const result = W.SeasonTrade.analyze({
          remaining: S.remaining, board: S.board, league: b.league, rosters, catalog: S.catalog,
          rosterIds: [S.me.roster_id, S.partner.roster_id], give, receive, drops, excludeWeeks,
          currentWeek: week, assumeAvailable: true, now: Date.now(), snapshotAt,
        });
        render(result, { snapshotAt, week, give, receive, drops, excludeWeeks, rosters });
        setStatus(`lineups compared for weeks ${result.weeks[0].week}–${result.weeks[result.weeks.length - 1].week}`);
      } catch (e) {
        // A superseded refresh means the session moved on (new league load or
        // identity); sync() already owns the screen for that.
        if (SESSION.isSuperseded(e)) return;
        renderBlocked(e);
        setStatus("comparison blocked");
      } finally {
        busy = false; refreshCompare();
      }
    }

    // --- output (spec §4.5 order) -------------------------------------------
    function provenanceText(snapshotAt) {
      const r = S.remaining, deadline = S.league.settings && S.league.settings.trade_deadline;
      const catalogAt = SESSION.catalogFetchedAt();
      const settings = typeof SESSION.settingsText === "function" ? SESSION.settingsText(S.bundle) : "";
      return `Remaining-season projections generated ${r.generated_at}, data through ${r.data_through}.`
        + (snapshotAt ? ` Roster snapshot ${new Date(snapshotAt).toISOString()}.` : "")
        + ` Player catalog fetched ${Number.isFinite(catalogAt) ? new Date(catalogAt).toISOString() : "unknown time"}.`
        + (settings ? ` ${settings}.` : "")
        + (deadline ? ` Trade deadline: week ${deadline} (league setting).` : "");
    }

    function render(result, { snapshotAt, week, give, receive, drops, excludeWeeks, rosters }) {
      const names = {};
      for (const s of result.sides) names[s.rosterId] = rosterName(s.rosterId);
      const playerNamesAll = {};
      for (const r of rosters) for (const id of [...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])]) playerNamesAll[String(id)] = playerName(String(id));
      const weeks = result.weeks;
      const t = scenarioText(result, {
        names, playerNames: {}, playerNamesAll, excludeWeeks, drops,
        currentWeek: week, firstWeek: weeks[0].week, endWeek: weeks[weeks.length - 1].week,
      });
      const out = els.result;
      out.replaceChildren();
      // 0. plain-English summary: the bottom line before anything else
      const summary = el("div", null, "season-summary");
      const ownLabel = viewer() ? names[result.sides[0].rosterId] : undefined;
      for (const line of lineupSummary(result, { names, ownLabel, firstWeek: weeks[0].week, endWeek: weeks[weeks.length - 1].week })) summary.append(el("p", line));
      out.append(summary);
      // Everything after the totals is collapsible detail; nothing is removed.
      const section = (title, open) => {
        const d = el("details", null, "season-detail");
        d.open = Boolean(open);
        d.append(el("summary", title));
        out.append(d);
        return d;
      };
      // 1. headline + subline
      const h = el("p", null, "season-headline"); h.append(el("strong", t.headline)); out.append(h);
      out.append(el("p", t.subline, "season-subline"));
      // 2. sides
      const sidesTable = el("table", null, "season-table");
      sidesTable.append(headRow(["side", "before", "after", "Δ"]));
      const sb = el("tbody");
      for (const s of t.sides) sb.append(bodyRow([s.name, s.before, s.after, s.delta]));
      sidesTable.append(sb); out.append(sidesTable);
      // 3. week table; a moved player's excluded/bye week is named with the
      //    engine's status word when he sits in that week's lineup rows.
      const moved = new Set([...give, ...receive]);
      const weekTable = el("table", null, "season-table");
      const me = names[result.sides[0].rosterId], them = names[result.sides[1].rosterId];
      weekTable.append(headRow(["week", `${me} before`, `${me} after`, `${me} Δ`, `${them} before`, `${them} after`, `${them} Δ`]));
      const wb = el("tbody");
      for (const w of weeks) {
        const cells = [String(w.week)];
        for (const side of w.sides) {
          const flagged = [...(side.before.lineup || []), ...(side.after.lineup || [])]
            .filter(p => moved.has(String(p.id)) && p.status !== "conditional_projection")
            .map(p => `${p.name} ${statusWord(p.status)}`);
          const note = [...new Set(flagged)].join("; ");
          cells.push(fmt(side.before.total), fmt(side.after.total), fmtDelta(side.delta) + (note ? ` (${note})` : ""));
        }
        wb.append(bodyRow(cells));
      }
      weekTable.append(wb);
      section("Week-by-week lineup totals", false).append(weekTable);
      // 4. assumptions -- open by default: with the acknowledgment checkbox
      //    gone, this is where "everyone plays every week" is stated.
      section("Assumptions", true).append(list(t.assumptions.length ? t.assumptions : ["No unavailable weeks entered and no drops; every active player is assumed to play every remaining week."]));
      // 5. availability flags
      if ((result.availabilityFlags || []).length) {
        section("Reported availability tags", false).append(list(result.availabilityFlags.map(f => `${f.name}: ${f.status} — ${f.interpretation}`)));
      }
      // 6. engine warnings verbatim
      section("Engine notes", false).append(list(result.warnings || []));
      // 7. evaluation: only a record measured under this league's scoring and this model (spec §3.2)
      const ev = section("Measured evaluation", false);
      for (const line of evidenceLines(S.batch.evaluation, S.view)) ev.append(el("p", line, "season-eval"));
      // 8. provenance
      els.provenance.textContent = provenanceText(snapshotAt);
      out.hidden = false;
    }

    function renderBlocked(error) {
      const c = coverageText(error);
      const out = els.result;
      out.replaceChildren();
      const h = el("p", null, "season-headline"); h.append(el("strong", c.headline)); out.append(h);
      out.append(list(c.rows));
      out.append(el("p", Array.isArray(error && error.coverageIssues)
        ? "Nothing was scored. Unknown is not zero: a player-week without a projection blocks the whole comparison rather than counting as 0."
        : "Nothing was scored.", "season-subline"));
      out.hidden = false;
    }

    const headRow = cells => { const thead = el("thead"), tr = el("tr"); for (const c of cells) { const th = el("th", c); th.scope = "col"; tr.append(th); } thead.append(tr); return thead; };
    const bodyRow = cells => { const tr = el("tr"); cells.forEach((c, i) => tr.append(el("td", c, i ? "num" : ""))); return tr; };
    const list = items => { const ul = el("ul", null, "season-list"); for (const i of items) ul.append(el("li", i)); return ul; };

    // --- wiring -------------------------------------------------------------
    // No username input and no load button here: identity, the team a viewer
    // chooses and the league load belong to the chip in the league panel
    // (trade.html's FC.setLeague starts Session.ready({leagueId})). The chip's
    // refresh button re-reads the league, rosters and state; sync() redraws
    // from whatever bundle it commits.
    els.partner.addEventListener("change", onPartnerChange);
    els.compare.addEventListener("click", compare);
    refreshCompare();
    SESSION.onChange(sync);
    sync();
  }

  return Object.freeze({ parseWeeks, identifyRoster, capacityOf, activeSkill, neededDrops, fmtDelta, scenarioText, lineupSummary, coverageText,
    contextLines, evidenceLines, rosValueLines, COPY, FORBIDDEN, ALLOWED_SENTENCES, HEADLINE, init, batch, _reset,
    gradeLabel, pickHorizon, stratumOf, lopsidedMeasure, errorFor, gradeText, marketText, startCounts, positionalRanks, GRADE_FORBIDDEN, GRADE_LABELS });
});
