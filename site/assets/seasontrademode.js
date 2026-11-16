/* In-season trade page controller (any-league spec §7.1 trade, §7.2, §5.1,
   §5.2, §6.1, §6.2, §3.2). Any Sleeper league, by id. The pure helpers here
   are what the fixture tests; init() wires them to the DOM, to the shared
   Session bundle and to SeasonTrade.analyze.

   Statics, once per document (a failure retries on the next load): the
   league-neutral batch (LeagueData.loadBatch) and, for a keeper league only,
   the pick-value table (assets/pick_curve.json). No draft board, no
   per-league remaining file and no simulation inputs: simulation is off for
   everyone in phase 1 (spec §6.2).

   Draft picks (spec 2026-11-13-trade-draft-picks §5.5-5.7): only when
   PickValue.eligibility(league) passes (keeper league, in season, one QB),
   each load reads Sleeper's traded_picks and the league's draft through
   window.Sleeper.get; any failure shows one "Draft picks unavailable" line
   and the page works as it does without picks. Picks change nothing this
   season and take no roster spot: a picks-only offer never calls the
   lineup engine. The weighting, draft-order and keeper-rule controls
   recompute the pick lines in place, with no new read -- except that under
   any keeper rule but Unknown (a preset of keeperrules.js, or the Custom…
   settings; keeper-rule-settings spec §5.3) the league's draft history
   (Keepers.buildOriginalByPlayerId) is walked once per load: at the end of
   the load when this league's remembered rule is not Unknown, else the first
   time a rule applies to a result on screen or is chosen. That history makes
   the likely-keeper lines rule-aware (a player the rule's cost floor or year
   limit would not let keep is skipped) and adds one line when an offer gives
   away the pick a side's likely keeper would cost. Pending or unavailable,
   both drop out and nothing else changes.

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
  const PV = () => dep("PickValue", "./pickvalue.js");
  const LLens = () => dep("LeagueLens", "./leaguelens.js");
  const KP = () => dep("Keepers", "./keepers.js");
  const KR = () => dep("KeeperRules", "./keeperrules.js");
  const SKILL = new Set(["QB", "RB", "WR", "TE"]);
  const HEADLINE = "Conditional lineup scenario — not a trade verdict.";
  const SUBLINE_TAIL = "Keeper value and draft picks are not valued, so no overall grade is shown.";
  // An offer with a draft pick: the two sentences that would otherwise be false (spec §5.7).
  const PICKS_SUBLINE_TAIL = "Keeper value is not counted; draft picks are valued for next season only.";
  const PICKS_SUBLINE_TAIL_LATER = "Keeper value is not counted; draft picks are valued for future seasons only.";
  const FORBIDDEN = Object.freeze(["verdict", "win/win", "fair", "winner", "accept", "recommend", "grade"]);
  const ALLOWED_SENTENCES = Object.freeze([HEADLINE, SUBLINE_TAIL, PICKS_SUBLINE_TAIL, PICKS_SUBLINE_TAIL_LATER]);
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
    // The evidence fallback (spec §3.2): the standalone sentence, and the short form after a label ("Rest-of-season
    // accuracy: ..."). Either way the league's own scoring IS applied; only its accuracy is unmeasured.
    noEvidence: "Your league's scoring is applied; its accuracy has not been measured.",
    notMeasured: "not measured for your league's scoring.",
    horizon: "through NFL week 17, regardless of your league's schedule",
    aggregation: "sum of weekly medians through NFL week 17, not a season median",
    // A skill player the comparison cannot price (2026-11-13): listed, but he cannot be ticked.
    noProjection: "No projection: can't be included in a comparison.",
  });
  const ROS_METRIC = "rest_of_season_points_mae";
  // Lineup slots in words for every sentence the page writes; result.pickups[].slot keeps the code.
  const SLOT_NAMES = Object.freeze({ FLEX: "flex", SUPER_FLEX: "superflex", WRRB_FLEX: "RB/WR flex", REC_FLEX: "WR/TE flex" });
  const slotName = s => (Object.prototype.hasOwnProperty.call(SLOT_NAMES, s) ? SLOT_NAMES[s] : String(s));
  // An engine caveat as the page says it: the engine calls the first team "You" and the second "They" and names a slot
  // by its code ("You has no SUPER_FLEX to start ..."); the page names the teams and the slot. Other caveats pass as they are.
  const caveatText = (c, teamOf) => String(c).replace(/^(You|They) (has|would have) no (\S+) to start /,
    (m, who, verb, slot) => `${teamOf[who]} ${verb} no ${slotName(slot)} to start `);

  // --- draft picks: copy and pure helpers (spec 2026-11-13-trade-draft-picks §5.6, §5.7) ---------------------
  // Values are shown in whole points: a pick's value is a 2021–2025 average, and a middle round's range can be
  // about 2 points wide, which must not read as precision (controller ruling 2026-11-13).
  const PICK_CURVE_PATH = "assets/pick_curve.json?v=picks1";
  const PICK_ORDERS = Object.freeze([["unset", "Not set yet"], ["standings", "By this season's standings"]]);
  // The keeper-rule menu (keeper-rule-settings §5.3): Unknown, keeperrules.js's presets (the ladder's key and label
  // unchanged, so saved choices still load), Custom…. Read at first use, like every other dependency here.
  const pickRules = () => Object.freeze([["unknown", "Unknown"], ...KR().PRESETS.map(p => [p.key, p.label]), ["custom", "Custom…"]]);
  // The Custom… settings, in keeperrules.js's order: [setting, label, lowest, highest]. A blank "most years" is no
  // limit (null); a blank never-drafted round is the draft's last round ("last"). The two round settings go no higher
  // than this league's draft.
  const CUSTOM_FIELDS = Object.freeze([
    ["first_keep", "First keep: rounds earlier than drafted", 0, 5],
    ["per_year", "Each later year: rounds earlier", 0, 5],
    ["max_years", "Most years in a row (blank = no limit)", 1, 8],
    ["undrafted_round", "Never-drafted player costs round (blank = last round)", 1, 30],
    ["earliest_round", "Earliest round a keeper can cost", 1, 30],
  ].map(f => Object.freeze(f)));
  const CUSTOM_BLANK = Object.freeze({ max_years: null, undrafted_round: "last" });
  const ENGINE_PICK_NOTE = "No keeper or future-pick value, bench insurance, or the other side's willingness to deal";
  const PICK_COPY = Object.freeze({
    weighting: "Weighting:",
    help: () => `How much a point next season counts: ${Object.values(PV().PRESETS).map(p => `${p.label} ×${p.w}`).join(", ")}.`,
    order: next => `${next} draft order:`,
    keeperRule: "Keeper rule:",
    customGroup: "Custom keeper rule",
    // A remembered custom rule this league's draft cannot have (e.g. a round past its last): shown under Custom….
    customUnfit: msg => `${msg}. Until this is changed, the keeper rule counts as Unknown.`,
    valuesNote: K => `Pick values: what the player ranked at each draft spot by the preseason consensus actually scored in 2021–2025, above a waiver-level starter, in your league's scoring. This estimate assumes each team keeps its ${K} best-ranked player${K === 1 ? "" : "s"}. A player's value next season, as a keeper, is not counted.`,
    ladderNote: "Under this keeper rule the best players often can't be kept, so early picks are likely worth more than shown.",
    averagesNote: "Pick values are 2021–2025 averages; any single pick can land far from them.",
    // The engine's note, when the offer has a pick: the pick values sit in the summary, above the engine notes.
    engineNote: later => `Draft picks are valued for ${later ? "future seasons" : "next season"} above; keeper value, bench insurance and the other side's willingness to deal are not counted`,
    unavailable: reason => `Draft picks unavailable: ${reason}`,
  });
  // Whole points, rounded half away from zero so the two sides of one trade read as mirror images; 0 has no sign.
  const whole = x => Math.sign(x) * Math.round(Math.abs(x));
  function signedWhole(x) {
    const r = whole(x);
    return r === 0 ? "0" : `${r < 0 ? "−" : "+"}${Math.abs(r)}`;
  }
  // One pick's line. v = PickValue.pickValue's {value, low, high, slot, first, last}; slot is null when the order is
  // not set (the round's average) and the estimated overall pick under this season's standings.
  function pickLine(label, v) {
    const n = x => String(whole(x));
    return v.slot == null
      ? `${label}: worth about ${n(v.value)} (anywhere from pick ${v.first} to ${v.last}: ${n(v.low)}–${n(v.high)})`
      : `${label}: worth about ${n(v.value)} at pick ${v.slot} by current standings (round range ${v.first}–${v.last}: ${n(v.low)}–${n(v.high)})`;
  }
  // The engine's warnings as the page shows them: with a pick in the offer the "no future-pick value" clause would be
  // false, so it is reworded; the rest of that note (the free-agent assumption) stays. Without a pick: unchanged.
  function engineWarningText(w, hasPicks, later = false) {
    const s = String(w);
    return hasPicks && s.startsWith(ENGINE_PICK_NOTE) ? PICK_COPY.engineNote(later) + s.slice(ENGINE_PICK_NOTE.length) : s;
  }
  // sides: [{you, name, thisSeason, gets: [{season, label, v}], gives: [...]}], side 0 first. Returns [{text, cls}]:
  // per side who gets and gives which pick, the picks' total, one line per pick, the combined number; then the
  // two notes, once. "Future seasons" replaces "Next season" when any pick in the offer is two or more seasons ahead.
  // keeperRule: the active rule (a KeeperRules rule) or null for Unknown; the early-picks note follows its earliest
  // round, never its name.
  function picksSummary({ sides, preset, currentSeason, keepers, keeperRule }) {
    const P = PV().PRESETS[preset];
    if (!P) throw new Error(`Unknown weighting preset: ${preset}`);
    if (keeperRule != null && !KR().isRule(keeperRule)) throw new Error("picksSummary: keeperRule must be a keeper rule or null");
    const now = Number(currentSeason);
    const later = sides.some(s => [...s.gets, ...s.gives].some(p => Number(p.season) - now >= 2));
    // The factors actually applied, one per distinct number of seasons ahead among the picks in the offer.
    const ahead = [...new Set(sides.flatMap(s => [...s.gets, ...s.gives]).map(p => Number(p.season) - now))].sort((a, b) => a - b);
    const factorWord = n => (n <= 1 ? "next season" : n === 2 ? "the season after" : `${n} seasons ahead`);
    const factors = ahead.map(n => `${factorWord(n)} ×${Number((P.w ** n).toFixed(2))}`).join(", ");
    const lines = [];
    for (const s of sides) {
      const gets = s.gets.map(p => p.label), gives = s.gives.map(p => p.label);
      const verbs = s.you ? ["get", "give"] : ["gets", "gives"];
      const parts = [gets.length ? `${verbs[0]} ${andList(gets)}` : "", gives.length ? `${verbs[1]} ${andList(gives)}` : ""].filter(Boolean);
      // "gets A and gives B"; with a list on either side, "gets A and B, and gives C".
      const glue = gets.length > 1 || gives.length > 1 ? ", and " : " and ";
      lines.push({ text: `${s.you ? "You" : s.name} ${parts.join(glue)}.`, cls: "season-picks-side" });
      const c = PV().combine({ thisSeason: s.thisSeason, preset, currentSeason,
        receive: s.gets.map(p => ({ season: p.season, value: p.v.value })), give: s.gives.map(p => ({ season: p.season, value: p.v.value })) });
      lines.push({ text: `${later ? "Future seasons" : "Next season"}: ${signedWhole(c.future)} expected points from picks.`, cls: "" });
      for (const p of [...s.gets, ...s.gives]) lines.push({ text: pickLine(p.label, p.v), cls: "season-pick-line" });
      lines.push({ text: `Combined at ${P.label} (${ahead.length ? factors : `next season ×${c.w}`}): ${signedWhole(c.combined)}`, cls: "season-picks-combined" });
    }
    lines.push({ text: PICK_COPY.valuesNote(Number(keepers)), cls: "season-summary-note" });
    lines.push({ text: PICK_COPY.averagesNote, cls: "season-summary-note" });
    if (keeperRule && keeperRule.earliest_round > 1) lines.push({ text: PICK_COPY.ladderNote, cls: "season-summary-note" });
    return lines;
  }
  // The roster's top `keepers` skill players by rest-of-season value (rosValue: Map sleeper id -> ros_value). Every
  // player on the roster counts, IR and taxi included (a keeper can be injured now); one without a value is not
  // ranked. Ties go to the lower id, so the answer is stable. `eligible` (optional, id -> boolean) restricts the
  // ranking to players a keeper rule lets keep; the next player takes an excluded one's place.
  function likelyKeepers({ roster, catalog, rosValue, keepers, eligible }) {
    const K = Number(keepers);
    if (!Number.isInteger(K) || K <= 0) return new Set();
    const ranked = ((roster && roster.players) || []).map(String)
      .filter(id => SKILL.has(((catalog && catalog[id]) || {}).position) && Number.isFinite(rosValue.get(id)))
      .filter(id => !eligible || eligible(id))
      .sort((a, b) => rosValue.get(b) - rosValue.get(a) || (a < b ? -1 : a > b ? 1 : 0));
    return new Set(ranked.slice(0, K));
  }
  // The five Custom… settings of a raw object, in a fresh object (anything else it carries is dropped).
  const customOf = raw => Object.fromEntries(CUSTOM_FIELDS.map(([k]) => [k, raw[k]]));
  // The rule in force for a remembered choice (keeper-rule-settings §5.3): {rule, error}. Unknown is {rule: null}. A
  // preset is a fixed definition: the draft's round count only resolves its "last" never-drafted round, so the ladder's
  // round 12 stands in a shorter draft as it always has (the pick curve clips its span to the draft). Custom settings
  // must fit this draft; when they do not, {rule: null, error}: the page counts them as Unknown and says why.
  function ruleOf(pref, rounds) {
    if (!pref || pref.keeperRule === "unknown") return { rule: null, error: null };
    try {
      const R = KR();
      if (pref.keeperRule === "custom") return { rule: R.normalize(pref.keeperCustom, { rounds }), error: null };
      const s = R.preset(pref.keeperRule);
      return s ? { rule: R.normalize(s, s.undrafted_round === "last" ? { rounds } : {}), error: null } : { rule: null, error: null };
    } catch (e) {
      return { rule: null, error: String((e && e.message) || e) };
    }
  }
  // A reason as the second half of "Draft picks unavailable: ...": lower-case start (Sleeper stays capitalized), a
  // closing period.
  const reasonText = msg => {
    const s = String(msg || "unknown error").trim();
    const t = /^Sleeper\b/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
    return /[.!?]$/.test(t) ? t : `${t}.`;
  };
  const failedRead = (what, e) => new Error(`${what} did not load (${String((e && e.message) || e).replace(/\.$/, "")})`);

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
    const subline = `Sum of weekly central (p50) lineup scenarios for weeks ${ctx.firstWeek}–${ctx.endWeek}; week ${ctx.currentWeek} is excluded because trades may process after games start. ${ctx.graded ? GRADED_SUBLINE_TAIL : ctx.picks ? (ctx.picksLater ? PICKS_SUBLINE_TAIL_LATER : PICKS_SUBLINE_TAIL) : SUBLINE_TAIL}`;
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
  // ctx.received[i] (optional) lists the ids side i receives and ctx.playerName
  // names them: a received player who never starts in the compared weeks is
  // named, because the totals count starters only and he adds 0 there.
  const fmt1 = x => { const r = Math.round(x * 10) / 10; return r === 0 ? "0.0" : `${r < 0 ? "−" : "+"}${Math.abs(r).toFixed(1)}`; };
  const andList = xs => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  // A slot nobody fills is the engine's empty row (id null, name "nobody"): it is keyed and named by its slot, so the
  // sentence reads "E Name starts and the TE slot stays empty, instead of A Name and T Name".
  const rowKey = p => (p.empty ? `empty:${p.slot}` : String(p.id));
  const minus = (xs, ys) => {                 // xs not in ys, as multisets (two empty RB slots are two rows)
    const left = new Map();
    for (const p of ys) left.set(rowKey(p), (left.get(rowKey(p)) || 0) + 1);
    return xs.filter(p => { const n = left.get(rowKey(p)) || 0; if (n) left.set(rowKey(p), n - 1); return !n; });
  };
  function moveText(enter, leave) {
    const names = xs => xs.filter(p => !p.empty).map(p => p.name), slots = xs => xs.filter(p => p.empty).map(p => slotName(p.slot));
    const ins = names(enter), emptied = slots(enter), outs = [...names(leave), ...slots(leave).map(s => `an empty ${s} slot`)];
    const starts = ins.length ? `${andList(ins)} ${ins.length === 1 ? "starts" : "start"}` : "";
    if (!emptied.length) return `${starts} instead of ${andList(outs)}`;
    const empty = `the ${andList(emptied)} ${emptied.length === 1 ? "slot stays" : "slots stay"} empty`;
    return `${starts ? `${starts} and ${empty}` : empty}, instead of ${andList(outs)}`;
  }
  function lineupSummary(result, ctx) {
    const span = `weeks ${ctx.firstWeek}–${ctx.endWeek}`;
    const label = i => (i === 0 ? (ctx.ownLabel || "Your lineup") : (ctx.names && ctx.names[result.sides[i].rosterId]) || `roster ${result.sides[i].rosterId}`);
    const benchNote = i => {
      const got = ((ctx.received && ctx.received[i]) || []).map(String);
      if (!got.length) return "";
      const started = new Set();
      for (const w of result.weeks) for (const p of (w.sides[i].after.lineup || [])) started.add(String(p.id));
      const idle = got.filter(id => !started.has(id)).map(id => (ctx.playerName ? ctx.playerName(id) : id));
      if (!idle.length) return "";
      return ` ${andList(idle)} ${idle.length === 1 ? "never starts" : "never start"} in ${span}, so ${idle.length === 1 ? "adds" : "add"} 0 pts here.`;
    };
    const perSide = result.sides.map((s, i) => {
      const changes = [];
      for (const w of result.weeks) {
        const side = w.sides[i];
        const before = side.before.lineup || [], after = side.after.lineup || [];
        const enter = minus(after, before), leave = minus(before, after);
        if (enter.length || leave.length) changes.push({ week: w.week, delta: side.delta, move: moveText(enter, leave) });
      }
      return { i, delta: s.delta, changes };
    });
    if (perSide.every(s => !s.changes.length)) {
      const notes = perSide.map(({ i }) => [i, benchNote(i)]).filter(([, t]) => t).map(([i, t]) => `${label(i)}:${t}`);
      return [`No change to either starting lineup in ${span} under these assumptions.`, ...notes];
    }
    const body = ({ i, delta, changes }) => {
      const head = `${label(i)}: ${fmt1(delta)} pts over ${span}.`;
      if (!changes.length) return `${head} No change to the starting lineup.`;
      if (changes.length === 1) return `${head} All of it is week ${changes[0].week}: ${changes[0].move}.`;
      const ranked = changes.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.week - b.week);
      const item = c => `week ${c.week} (${fmt1(c.delta)}): ${c.move}`;
      if (ranked.length <= 3) return `${head} Lineup changes in ${ranked.length} weeks: ${ranked.map(item).join("; ")}.`;
      const top = ranked.slice(0, 3), rest = ranked.slice(3);
      const restSum = rest.reduce((a, c) => a + c.delta, 0);
      return `${head} Lineup changes in ${ranked.length} weeks; the 3 largest: ${top.map(item).join("; ")}; and smaller changes in ${rest.length} other week${rest.length === 1 ? "" : "s"} (${fmt1(restSum)} pts combined).`;
    };
    return perSide.map(s => body(s) + benchNote(s.i));
  }
  // What the totals leave out, stated once under the summary (owner question 2026-10-22: a backup's value).
  // A bench player DOES count in weeks he starts (a bye, or a week marked out in "Out some weeks?"); what is
  // missing is cover for injuries nobody has entered (Opus maint review P3).
  const STARTERS_ONLY = "These totals count starting lineups only: a bench player adds points only in weeks he starts (a bye, or a week you marked a player out). Cover for injuries you have not entered is not counted.";
  function coverageText(error) {
    if (error && Array.isArray(error.coverageIssues)) {
      const players = new Set(error.coverageIssues.map(x => x.id)).size;
      return { headline: `Comparison blocked: ${players} player(s), ${error.coverageIssues.length} player-week(s) without a projection`,
               rows: error.coverageIssues.map(x => `${x.name} · week ${x.week} · ${x.reason}`) };
    }
    return { headline: "Comparison blocked", rows: [String(error && error.message || error)] };
  }
  // The status line after a refused comparison carries the outcome, not a bare "comparison blocked": the headline, or
  // for a traded player without a projection the engine's message, which names him and says what to do.
  function blockedStatus(error) {
    if (error && Array.isArray(error.tradedWithoutProjection)) return `Comparison blocked: ${error.message}`;
    const { headline, rows } = coverageText(error);
    return headline.startsWith("Comparison blocked: ") ? headline : `Comparison blocked: ${rows[0]}`;
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
    return [`Rest-of-season accuracy: ${COPY.notMeasured}`];
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
  // The pick-value table (Task 1 artifact): fetched only for a keeper league, once per document.
  let curvePromise = null;
  const pickCurve = () => curvePromise || (curvePromise = (async () => {
    const res = await fetch(PICK_CURVE_PATH);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })().catch(e => { curvePromise = null; throw e; }));
  const _reset = () => { batchPromise = null; curvePromise = null; };   // test hook: a cold document

  // --- controller -----------------------------------------------------------
  // Everything below touches the DOM; the pure helpers above are what the
  // fixture pins. Nothing here calls Trade.* or TradeMode.*: the pre-draft
  // engine's numbers are not defined in season (spec §6.6). The league,
  // users, rosters and NFL state come from the committed Session bundle, the
  // ~5 MB player catalog from Session.catalog() (once per document), and a
  // compare re-reads rosters (and, as every refresh does, the league
  // settings) through Session.refresh. Its only Sleeper calls of its own are
  // a keeper league's traded_picks and draft, once per load (readPicks), and,
  // under a keeper rule other than Unknown only, one draft-history walk per
  // load (keeperHistory, through keepers.js).

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
  // The keeper count and the draft id shape the pick values, so they are keyed too.
  const settingsKey = league => JSON.stringify(league ? [league.league_id, league.season, league.status, league.total_rosters, league.roster_positions, league.scoring_settings, league.settings && league.settings.type, league.settings && league.settings.best_ball,
    league.settings && league.settings.max_keepers, league.draft_id] : null);
  // A pick as a checkbox key and back: season|round|original roster id.
  const pickKey = p => `${p.season}|${p.round}|${p.originalRosterId}`;
  const PREF_KEY = leagueId => `megatron.trade.picks.v1|${leagueId}`;
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
    // `dropBtns` maps a rendered row's id to its inline Drop button: a side over the roster limit marks its drops in
    // its own column, so the roster is never listed twice.
    // `picks` maps a ticked draft pick's key to the pick; `picksEl` is the column's pick group (keeper leagues).
    const newSide = (ul, dropsEl, picksEl) => ({ ul, dropsEl, picksEl, roster: null, active: [], players: new Set(), picks: new Map(), drops: new Set(), weeks: new Map(), errors: new Map(), needed: 0, dropBtns: new Map() });
    const sides = { mine: newSide(els.mine, els.mineDrops, els.minePicks), theirs: newSide(els.theirs, els.theirsDrops, els.theirsPicks) };
    const sideName = s => s.roster ? rosterName(s.roster.roster_id) : "";
    // Draft picks for the current load: off (not a keeper league, or the page lacks the pick elements), a reason line
    // (dynasty, two QBs, or a failed read), or ok with the owned picks, the pick curves (one per keeper rule used,
    // built on first use), the user's choices and the rule in force. `lastPicks` is the result on screen whose pick
    // lines the controls recompute in place.
    const picksUI = Boolean(els.minePicks && els.theirsPicks && els.pickControls && els.picksNote);
    const PICKS_OFF = Object.freeze({ ok: false, line: null });
    let PK = PICKS_OFF, lastPicks = null;

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
      if (picksUI) for (const n of [els.minePicks, els.theirsPicks, els.pickControls, els.picksNote]) { n.replaceChildren(); n.hidden = true; }
    }

    // --- draft picks: reads (keeper leagues only) -----------------------------
    // Never rejects: {ok:false, line} for a league that gets a reason line or a failed read, {ok:false, line:null}
    // for one that gets nothing (redraft, or no pick elements on the page), else the raw reads.
    async function readPicks(league) {
      if (!picksUI) return PICKS_OFF;
      let gate;
      try { gate = PV().eligibility(league); } catch (e) { return PICKS_OFF; }
      if (!gate.ok) return gate.reason ? { ok: false, line: gate.reason } : PICKS_OFF;
      const sleeper = (p, what) => (W.Sleeper && typeof W.Sleeper.get === "function"
        ? Promise.resolve().then(() => W.Sleeper.get(p)) : Promise.reject(new Error("the Sleeper client is not loaded"))).catch(e => { throw failedRead(what, e); });
      try {
        if (league.draft_id === null || league.draft_id === undefined || league.draft_id === "") throw new Error("the league has no draft on Sleeper");
        const [tradedPicks, draft, artifact] = await Promise.all([
          sleeper(`/league/${encodeURIComponent(league.league_id)}/traded_picks`, "Sleeper's list of traded picks"),
          sleeper(`/draft/${encodeURIComponent(league.draft_id)}`, "the league's draft settings"),
          pickCurve().catch(e => { throw failedRead("the pick-value table", e); }),
        ]);
        if (!Array.isArray(tradedPicks)) throw new Error("Sleeper's list of traded picks is malformed");
        if (!draft || typeof draft !== "object") throw new Error("the league's draft settings are malformed");
        return { ok: true, tradedPicks, draft, artifact };
      } catch (e) {
        return { ok: false, line: PICK_COPY.unavailable(reasonText(e.message)) };
      }
    }
    // The reads, made usable for this league: ownership, rounds, the remembered choices and the rule they put in
    // force, and the pick curves. Curves are built on first use and cached by the rule's settings
    // (KeeperRules.key), so two custom rules never share one; the remembered rule's curve is built here, so a table
    // or a league the curve cannot use fails now, as the unavailable line. Any error becomes that line.
    function preparePicks(read, { league, rosters, batch: b }) {
      if (!read.ok) return read;
      try {
        const P = PV(), { tradedPicks, draft, artifact } = read;
        // An auction (or any other non-snake, non-linear) draft has no picks to trade; the draft board refuses it too.
        if (draft.type && draft.type !== "snake" && draft.type !== "linear") {
          throw new Error(`this league's draft ${draft.type === "auction" ? "is an auction, which has" : "type has"} no draft picks to trade`);
        }
        const rounds = P.draftRounds({ draft, tradedPicks });
        if (rounds == null) throw new Error("the number of draft rounds is unknown");
        const seasons = P.pickSeasons({ league, tradedPicks });
        const owned = P.ownedPicks({ rosters, tradedPicks, seasons, rounds });
        const prior = b && b.weekly && b.weekly.method && b.weekly.method.prior;
        const rate = prior && Number.isFinite(prior.rate) ? prior.rate : undefined;
        const base = { artifact, weights: LLens().effectiveWeights(league.scoring_settings), slots: league.roster_positions,
          teams: league.total_rosters, keepers: league.settings && league.settings.max_keepers, rounds, pickSixRate: rate };
        const curves = new Map();
        const curve = rule => {
          const k = KR().key(rule);
          if (!curves.has(k)) curves.set(k, P.buildCurve({ ...base, keeperRule: rule }));
          return curves.get(k);
        };
        const pref = loadPref(league.league_id), active = ruleOf(pref, rounds);
        curve(active.rule);
        const current = Number(league.season);
        return { ok: true, line: null, owned, rounds, curve, teams: league.total_rosters, current, next: current + 1,
          snake: draft.type === "snake", reversalRound: draft.settings && draft.settings.reversal_round, pref, active, presetBtns: new Map() };
      } catch (e) {
        return { ok: false, line: PICK_COPY.unavailable(reasonText(e.message)) };
      }
    }
    // The user's choices, per league, in this browser: {preset, order, keeperRule, keeperCustom?}. keeperRule is
    // "unknown", a preset key or "custom"; keeperCustom (the five Custom… settings) is there only with "custom".
    // Unreadable or unknown values fall back to the defaults: an unknown rule key, or "custom" whose settings fail
    // KeeperRules.validate, is Unknown. (Whether valid settings fit THIS draft is ruleOf's question.)
    function storage() { try { return W.localStorage || null; } catch (_) { return null; } }
    function loadPref(leagueId) {
      const P = PV(), out = { preset: P.DEFAULT_PRESET, order: "unset", keeperRule: "unknown" };
      try {
        const s = storage(), raw = s && s.getItem(PREF_KEY(leagueId)), v = raw ? JSON.parse(raw) : null;
        if (v && typeof v === "object") {
          if (Object.prototype.hasOwnProperty.call(P.PRESETS, v.preset)) out.preset = v.preset;
          if (PICK_ORDERS.some(([k]) => k === v.order)) out.order = v.order;
          const R = KR();
          if (v.keeperRule === "custom") {
            if (R.validate(v.keeperCustom) === null) { out.keeperRule = "custom"; out.keeperCustom = customOf(v.keeperCustom); }
          } else if (R.PRESETS.some(p => p.key === v.keeperRule)) out.keeperRule = v.keeperRule;
        }
      } catch (_) { /* defaults */ }
      return out;
    }
    function savePref(leagueId, pref) {
      try { const s = storage(); if (s) s.setItem(PREF_KEY(leagueId), JSON.stringify(pref)); } catch (_) { /* not remembered */ }
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
      if (msg === LW().NO_ANALYSIS) {
        const lead = (bundle.myRosterStatus === "none" || bundle.myRosterStatus === "ambiguous") ? `${SESSION.chipText(bundle, "ready", Date.now())} ` : "";
        return `${lead}Choose a team in the bar above to see trade scenarios.`;
      }
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
        PK = PICKS_OFF;
        setStatus("reading projections, scoring and the player catalog…");
        // A keeper league's pick reads run beside the statics; readPicks never rejects. Best ball and an unknown
        // starting slot get no comparison at all, so no pick reads either.
        let noComparison = false;
        try { noComparison = LD().leagueType(bundle.league).bestBall || LD().slotSupport(bundle.league).unknown.length > 0; } catch (_) { /* read; load decides */ }
        const picksRead = noComparison ? Promise.resolve(PICKS_OFF) : readPicks(bundle.league);
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
        const read = await picksRead;
        if (stale()) return;
        adopt(bundle);
        Object.assign(S, { batch: b, view, remaining: view.remaining, board: view.board, catalog, format, week });
        const type = LD().leagueType(league), unknown = LD().slotSupport(league).unknown;
        S.note = type.bestBall ? COPY.bestBall
          : unknown.length ? `Unsupported lineup slot: ${unknown.join(", ")} — no trade lineup comparison for this league; the rest-of-season values below still apply.` : null;
        PK = S.note ? PICKS_OFF : preparePicks(read, { league, rosters, batch: b });
        renderContext();
        renderWarn();
        S.loadedProvenance = provenanceText(null);
        els.provenance.textContent = S.loadedProvenance;
        if (S.note) renderNote();
        else {
          renderPicksNote();
          drawPickControls();
          redraw();
          els.controls.hidden = false; els.cols.hidden = false;
        }
        setStatus(`${rosters.length} teams loaded — ${who()}`);
        // This league's remembered rule is not Unknown: start the draft-history walk now, so it is usually done before
        // the first comparison (under Unknown, or a remembered custom rule that does not fit, nothing is read).
        if (activeRule()) keeperHistory();
      } catch (e) {
        if (stale() || SESSION.isSuperseded(e)) return;
        setStatus(e instanceof PreflightError ? e.message : `load failed: ${e.message} — refresh from the league bar to retry`);
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
      side.players.clear(); side.picks.clear(); side.drops.clear(); side.weeks.clear(); side.errors.clear(); side.needed = 0;
    }

    // --- draft picks: the note, the controls, the column groups ------------------
    function renderPicksNote() {
      if (!picksUI) return;
      els.picksNote.textContent = PK.line || "";
      els.picksNote.hidden = !PK.line;
    }
    // Weighting presets, the draft-order and keeper-rule selects. Each change recomputes the pick lines of the result
    // on screen (no Sleeper read, no engine call) and is remembered for this league.
    function drawPickControls() {
      if (!picksUI) return;
      const box = els.pickControls;
      box.replaceChildren();
      box.hidden = !PK.ok;
      if (!PK.ok) return;
      const group = el("div", null, "season-pick-weight");
      const label = el("span", PICK_COPY.weighting, "season-pick-label");
      label.id = "season-weight-label";
      group.setAttribute("role", "group");
      group.setAttribute("aria-labelledby", label.id);
      group.append(label);
      PK.presetBtns.clear();
      for (const [key, p] of Object.entries(PV().PRESETS)) {
        const btn = el("button", p.label, "season-preset");
        btn.type = "button"; btn.dataset.preset = key;
        btn.addEventListener("click", () => setPref({ preset: key }));
        PK.presetBtns.set(key, btn);
        group.append(btn);
      }
      box.append(group, el("p", PICK_COPY.help(), "season-pick-help"));
      const select = (text, options, onChoose) => {
        const wrap = el("label", null, "season-pick-select"), s = el("select");
        for (const [value, t] of options) { const o = el("option", t); o.value = value; s.append(o); }
        s.addEventListener("change", () => { if (options.some(([v]) => v === s.value)) onChoose(s.value); });
        wrap.append(el("span", text), s);
        box.append(wrap);
        return s;
      };
      PK.orderSel = select(PICK_COPY.order(PK.next), PICK_ORDERS, v => setPref({ order: v }));
      PK.ruleSel = select(PICK_COPY.keeperRule, pickRules(), chooseRule);
      drawCustomRow(box);
      syncPickControls();
    }
    // The Custom… settings under the menu: five number inputs and one inline message (role="status"), shown while
    // Custom… is chosen. A remembered custom rule fills them in; one that does not fit this draft says so here.
    function drawCustomRow(box) {
      const row = el("div", null, "season-pick-custom");
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", PICK_COPY.customGroup);
      PK.customInputs = new Map();
      for (const [key, text, lo, hi] of CUSTOM_FIELDS) {
        const wrap = el("label", null, "season-pick-select"), input = el("input");
        input.type = "number";
        input.setAttribute("min", String(lo));
        input.setAttribute("max", String(key === "undrafted_round" || key === "earliest_round" ? Math.min(hi, PK.rounds) : hi));
        input.setAttribute("step", "1");
        input.setAttribute("inputmode", "numeric");
        for (const type of ["input", "change"]) input.addEventListener(type, applyCustom);
        wrap.append(el("span", text), input);
        row.append(wrap);
        PK.customInputs.set(key, input);
      }
      PK.customStatus = el("p", "", "season-pick-status");
      PK.customStatus.setAttribute("role", "status");
      row.append(PK.customStatus);
      PK.customRow = row;
      box.append(row);
      PK.customOpen = PK.pref.keeperRule === "custom";
      if (PK.customOpen) {
        fillCustom(PK.pref.keeperCustom);
        PK.customStatus.textContent = PK.active.error ? PICK_COPY.customUnfit(PK.active.error) : "";
      }
    }
    // Settings into the inputs: no limit and the last round show as blanks.
    function fillCustom(settings) {
      for (const [key, input] of PK.customInputs) {
        const v = settings[key];
        input.value = v === null || v === undefined || v === "last" ? "" : String(v);
      }
    }
    // The inputs as raw settings for KeeperRules.validate: a blank is null (most years), "last" (never-drafted round)
    // or "" (the rest, which validate names); a number reads as one; anything else stays text, which validate refuses.
    function readCustom() {
      const out = {};
      for (const [key, input] of PK.customInputs) {
        const t = String(input.value == null ? "" : input.value).trim(), n = Number(t);
        out[key] = t === "" ? (key in CUSTOM_BLANK ? CUSTOM_BLANK[key] : "") : Number.isFinite(n) ? n : t;
      }
      return out;
    }
    // Every input and change event: valid settings become the rule in force (saved, recomputed); anything else only
    // shows the message, and the rule in force, the storage and the result on screen stay as they are. (While a
    // remembered custom rule that does not fit is what is stored, the message still says the rule counts as Unknown.)
    function applyCustom() {
      if (!PK.ok || !PK.customOpen) return;
      const settings = readCustom(), msg = KR().validate(settings, { rounds: PK.rounds });
      PK.customStatus.textContent = !msg ? "" : PK.active.error ? PICK_COPY.customUnfit(msg) : msg;
      if (msg) return;
      const same = PK.pref.keeperRule === "custom" && CUSTOM_FIELDS.every(([k]) => PK.pref.keeperCustom[k] === settings[k]);
      if (!same) setPref({ keeperRule: "custom", keeperCustom: settings });
    }
    // The keeper-rule menu. Custom… opens the settings prefilled from the rule that was showing (the ladder's under
    // Unknown) and applies them at once when they are valid for this draft; otherwise the message shows and the
    // previous rule stays in force. Unknown or a preset closes the settings.
    function chooseRule(value) {
      if (!PK.ok) return;
      if (value === "custom") {
        if (!PK.customOpen) {
          const showing = PK.pref.keeperRule;
          fillCustom(showing === "custom" ? PK.pref.keeperCustom : KR().preset(showing === "unknown" ? "ladder" : showing));
          PK.customOpen = true;
          syncPickControls();
        }
        applyCustom();
        return;
      }
      PK.customOpen = false;
      PK.customStatus.textContent = "";
      setPref({ keeperRule: value });
    }
    function syncPickControls() {
      for (const [key, btn] of PK.presetBtns) btn.setAttribute("aria-pressed", key === PK.pref.preset ? "true" : "false");
      if (PK.orderSel) PK.orderSel.value = PK.pref.order;
      // While the Custom… settings are open the menu says so, even before they are valid (the previous rule in force).
      if (PK.ruleSel) PK.ruleSel.value = PK.customOpen ? "custom" : PK.pref.keeperRule;
      if (PK.customRow) PK.customRow.hidden = !PK.customOpen;
    }
    function setPref(change) {
      if (!PK.ok) return;
      const pref = { ...PK.pref, ...change };
      if (pref.keeperRule !== "custom") delete pref.keeperCustom;
      PK.pref = pref;
      PK.active = ruleOf(pref, PK.rounds);
      savePref(S.league.league_id, pref);
      syncPickControls();
      // Choosing a rule other than Unknown starts the draft-history walk even with no result on screen (once per load).
      if ("keeperRule" in change && PK.active.rule) keeperHistory();
      if (lastPicks && !els.result.hidden) fillPicksBlock();
    }
    // The rule in force for this load's choices (ruleOf, kept current by preparePicks and setPref): null for Unknown,
    // for a remembered custom rule that does not fit this draft, and when picks are off.
    function activeRule() { return PK.ok && PK.active ? PK.active.rule : null; }
    // A pick's name in one team's view: its own pick, or the original team's.
    const pickLabel = (p, rosterId) => `${p.season} R${p.round}${String(p.originalRosterId) === String(rosterId) ? "" : ` (from ${rosterName(p.originalRosterId)})`}`;
    // The column's collapsed "Draft picks (N)" group, one checkbox per pick the team owns now. A ticked pick joins the
    // offer like a player but takes no roster spot, so it never changes the drop count.
    function drawPicks(side) {
      if (!picksUI || !side.picksEl) return;
      const box = side.picksEl;
      box.replaceChildren();
      box.hidden = !PK.ok;
      if (!PK.ok) return;
      // By season and round; within a round the team's own pick first, then acquired ones.
      const rid = Number(side.roster.roster_id), own = p => (Number(p.originalRosterId) === rid ? 0 : 1);
      const owned = (PK.owned.get(rid) || []).slice()
        .sort((a, b) => a.season - b.season || a.round - b.round || own(a) - own(b) || a.originalRosterId - b.originalRosterId);
      for (const key of [...side.picks.keys()]) if (!owned.some(p => pickKey(p) === key)) side.picks.delete(key);
      const group = el("details", null, "season-detail season-picks-group");
      group.open = side.picks.size > 0;
      group.append(el("summary", `Draft picks (${owned.length})`));
      const ul = el("ul", null, "trade-assets season-pick-list");
      for (const p of owned) ul.append(pickRow(side, p));
      group.append(ul);
      box.append(group);
    }
    function pickRow(side, p) {
      const key = pickKey(p);
      const li = el("li", null, "season-row season-pick");
      li.dataset.pick = key;
      const label = el("label"), box = el("input");
      box.type = "checkbox"; box.dataset.pick = key; box.checked = side.picks.has(key);
      label.append(box, document.createTextNode(` ${pickLabel(p, side.roster.roster_id)}`));
      li.append(label);
      li.classList.toggle("picked", box.checked);
      box.addEventListener("change", () => {
        if (box.checked) side.picks.set(key, p); else side.picks.delete(key);
        li.classList.toggle("picked", box.checked);
        onInputChange();
      });
      return li;
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
    // A skill player the comparison can price: in the view's scorable mapping, with one usable row (a finite league
    // p50, or a bye) for every compared week. SeasonTrade.analyze refuses an offer with any other (the most common
    // block), so such a player is listed but cannot be ticked; off the offer he still counts as 0 there.
    function priceable(id, remById) {
      const gsis = S.view && S.view.scorableBySleeper ? S.view.scorableBySleeper.get(String(id)) : undefined;
      const p = gsis === undefined ? null : remById.get(String(gsis));
      if (!p || !Array.isArray(p.weeks)) return false;
      for (let w = first(); w <= last(); w++) {
        const rows = p.weeks.filter(r => r && r.week === w), r = rows[0];
        if (rows.length !== 1) return false;
        if (r.status !== "bye" && !(r.status === "conditional_projection" && r.points && r.points.league && Number.isFinite(r.points.league.p50))) return false;
      }
      return true;
    }
    function drawColumns() {
      const remById = new Map(((S.remaining && S.remaining.players) || []).map(p => [String(p.player_id), p]));
      for (const side of [sides.mine, sides.theirs]) {
        side.ul.replaceChildren();
        side.dropBtns.clear();
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
        for (const id of skill) side.ul.append(priceable(id, remById) ? playerRow(side, id) : disabledRow(side, id, COPY.noProjection));
        for (const id of other) side.ul.append(disabledRow(side, id, "no modeled points"));
        for (const id of missing) side.ul.append(disabledRow(side, id, "not in the player catalog — reload the page"));
        for (const id of locked) side.ul.append(disabledRow(side, id, "IR/taxi — not tradeable in this version"));
        drawPicks(side);
      }
      updateDrops();
    }

    const rowLabel = id => {
      const c = S.catalog[id] || {};
      return `${playerName(id)} · ${c.position || "?"} · ${c.team || "FA"}`;
    };

    function disabledRow(side, id, note) {
      const li = el("li", null, "season-row season-disabled");
      li.dataset.id = id;
      const label = el("label"), box = el("input");
      box.type = "checkbox"; box.disabled = true;
      label.append(box, document.createTextNode(` ${rowLabel(id)}`));
      li.append(label, el("span", note, "trade-why"));
      dropButton(side, li, id);
      return li;
    }

    // Shown only while this side is over the roster limit, on rows that can be dropped (active, not being traded).
    function dropButton(side, li, id) {
      const btn = el("button", "Drop", "season-drop-btn");
      btn.type = "button"; btn.hidden = true;
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", `drop ${playerName(id)} to make room`);
      btn.addEventListener("click", () => {
        if (side.drops.has(id)) side.drops.delete(id); else side.drops.add(id);
        updateDrops();
        onInputChange();
      });
      side.dropBtns.set(id, { btn, li });
      li.append(btn);
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
      dropButton(side, li, id);
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
        if (!s.needed) { s.drops.clear(); s.dropsEl.hidden = true; }
        else {
          s.dropsEl.hidden = false;
          const n = s.needed, what = n === 1 ? "one player" : `${n} players`;
          s.dropsEl.append(el("span", `${sideName(s)} would be ${n} over the roster limit — mark ${what} to drop below `
            + `(${s.drops.size} of ${n} marked)`, "season-drop-prompt"));
        }
        const droppable = new Set(s.active.map(String));
        for (const [id, { btn, li }] of s.dropBtns) {
          const can = s.needed > 0 && droppable.has(id) && !s.players.has(id);
          const on = can && s.drops.has(id);
          btn.hidden = !can;
          btn.textContent = on ? "Dropping — undo" : "Drop";
          btn.setAttribute("aria-pressed", on ? "true" : "false");
          li.classList.toggle("season-dropping", on);
        }
      }
    }

    // --- gate ---------------------------------------------------------------
    // The gate proper, independent of whether a compare is already running.
    function inputsValid() {
      // No acknowledgment step: the availability assumption is passed to the
      // engine as assumeAvailable and stated in the result's assumptions.
      if (!S.me || !S.partner || S.note) return false;
      if (sides.mine.players.size + sides.theirs.players.size + sides.mine.picks.size + sides.theirs.picks.size === 0) return false;
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
      lastPicks = null;
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
        // Picks change nothing this season: they never reach the lineup engine.
        const byDraft = (a, b) => a.season - b.season || a.round - b.round || a.originalRosterId - b.originalRosterId;
        const givePicks = [...sides.mine.picks.values()].sort(byDraft), receivePicks = [...sides.theirs.picks.values()].sort(byDraft);
        if (!give.length && !receive.length) {
          // Picks only (Review Focus 3): this season is 0 for both teams and the engine is not called.
          renderPicksOnly({ snapshotAt, givePicks, receivePicks, rosters });
          setStatus("draft picks compared; no players move");
          showResult();
          return;
        }
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
        render(result, { snapshotAt, week, give, receive, drops, excludeWeeks, rosters, givePicks, receivePicks });
        setStatus(`lineups compared for weeks ${result.weeks[0].week}–${result.weeks[result.weeks.length - 1].week}`);
        showResult();
      } catch (e) {
        // A superseded refresh means the session moved on (new league load or
        // identity); sync() already owns the screen for that.
        if (SESSION.isSuperseded(e)) return;
        renderBlocked(e);
        setStatus(blockedStatus(e));
        showResult();
      } finally {
        busy = false; refreshCompare();
      }
    }

    // --- output (spec §4.5 order) -------------------------------------------
    // A finished comparison (compared or blocked) renders below both roster lists, off a phone's screen: bring it into
    // view, without motion when the reader prefers less. Guarded for environments without either API.
    function showResult() {
      if (typeof els.result.scrollIntoView !== "function") return;
      const reduce = typeof W.matchMedia === "function" && W.matchMedia("(prefers-reduced-motion: reduce)").matches;
      els.result.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    }

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

    // --- draft picks in the result ----------------------------------------------
    // The pick lines of the result on screen, recomputed in place under the current choices and the rule in force. A
    // failure here (it should not happen: the curve's inputs were checked at load) says so in one line and leaves the
    // rest of the result.
    function fillPicksBlock() {
      const c = lastPicks;
      if (!c || !PK.ok) return;
      let lines;
      try {
        const rule = activeRule(), curve = PK.curve(rule);
        const value = p => PV().pickValue({ pick: p, curve, order: p.season === PK.next ? PK.pref.order : "unset", rosters: c.rosters, teams: PK.teams, rounds: PK.rounds,
          snake: PK.snake, reversalRound: PK.reversalRound });
        const side = i => {
          const rid = c.rosterIds[i], mk = p => ({ season: p.season, label: pickLabel(p, rid), v: value(p) });
          return { you: i === 0 && !viewer(), name: rosterName(rid), thisSeason: c.thisSeason[i],
            gets: (i === 0 ? c.receivePicks : c.givePicks).map(mk), gives: (i === 0 ? c.givePicks : c.receivePicks).map(mk) };
        };
        lines = picksSummary({ sides: [side(0), side(1)], preset: PK.pref.preset, currentSeason: PK.current,
          keepers: S.league.settings && S.league.settings.max_keepers, keeperRule: rule });
        const rk = ruleKeepers(rule);
        for (const t of keeperLines(c, rk)) lines.push({ text: t, cls: "season-summary-note" });
        for (const t of keeperPickLines(c, rk)) lines.push({ text: t, cls: "season-summary-note" });
      } catch (e) {
        lines = [{ text: PICK_COPY.unavailable(reasonText(e.message)), cls: "season-summary-note" }];
      }
      c.block.replaceChildren();
      for (const l of lines) c.block.append(el("p", l.text, l.cls || undefined));
    }
    // --- the keeper rule's draft history ---------------------------------------------------------------------------
    // The league's draft history (Sleeper id -> {round, season, keptYears, lastDraft}), walked from THIS league -- its
    // completed draft is the newest -- at most once per league load, whatever rules are chosen in it (the history does
    // not depend on the rule): PK is replaced by every load, which discards it, and an in-flight walk is reused. {map}
    // is null while pending and when unavailable (the walk threw or found nothing). When it settles, the result on
    // screen for the same load is recomputed.
    function keeperHistory() {
      const pk = PK;
      if (!pk.ok) return null;
      if (!pk.history) {
        const h = pk.history = { map: null, promise: null };
        const leagueId = S.league.league_id;
        h.promise = (async () => {
          const K = KP();
          if (!K || typeof K.buildOriginalByPlayerId !== "function") throw new Error("keepers.js is not loaded");
          return K.buildOriginalByPlayerId(leagueId);
        })().then(map => { h.map = map instanceof Map && map.size ? map : null; }, () => { h.map = null; })
          .then(() => { if (PK === pk && lastPicks && !els.result.hidden) fillPicksBlock(); });
      }
      return pk.history;
    }
    // Under a rule (the one in force, passed in) with the history in hand: next season's keeper test and cost for a
    // Sleeper id, with that rule's math; else null (Unknown, or the history pending or unavailable: today's ranking
    // and no conflict line). Asking under a rule starts the walk.
    function ruleKeepers(rule) {
      if (!rule) return null;
      const h = keeperHistory(), K = KP();
      if (!h || !h.map || !K) return null;
      const N = PK.next;
      const cand = id => {
        const o = h.map.get(String(id));
        return o ? { originalRound: o.round, originalYear: o.season, keptYears: o.keptYears, lastDraft: o.lastDraft, isWaiver: false }
          : { isWaiver: true };
      };
      return { eligible: id => K.eligible(cand(id), N, rule), cost: id => K.keeperCost(cand(id), N, rule) };
    }
    const rosValueMap = () => new Map(((S.board && S.board.players) || []).map(p => [String(p.sleeper_id), p.ros_value]));
    // A traded player in his current team's top max_keepers skill players by rest-of-season value (spec §5.7); under
    // a keeper rule with the history (rk = ruleKeepers), only among players the rule lets keep next season.
    function keeperLines(c, rk) {
      const K = S.league.settings && S.league.settings.max_keepers;
      const ros = rosValueMap();
      const out = [];
      for (const [ids, rid] of [[c.give, c.rosterIds[0]], [c.receive, c.rosterIds[1]]]) {
        const roster = c.rosters.find(r => String(r.roster_id) === String(rid));
        const top = likelyKeepers({ roster, catalog: S.catalog, rosValue: ros, keepers: K, eligible: rk && rk.eligible });
        for (const id of ids) if (top.has(String(id))) out.push(`${playerName(id)} is likely one of ${rosterName(rid)}'s keepers; his value next season is not counted.`);
      }
      return out;
    }
    // Under a keeper rule with the history only (rk = ruleKeepers): per side, its likely keepers AFTER the trade (its
    // players, minus those it gives and those it marks to drop, as in the lineup engine, plus those it gets); for each,
    // the round r he would cost next season under that rule. A side that gives a next-season round-r pick in this
    // offer and would hold none after it (its picks, minus those it gives, plus those it gets) gets one line, naming
    // the first such pick it gives. Picks-only offers run the same check with no players moving.
    function keeperPickLines(c, rk) {
      if (!rk) return [];
      const K = S.league.settings && S.league.settings.max_keepers;
      const ros = rosValueMap(), N = PK.next, out = [];
      const inRound = r => p => Number(p.season) === N && Number(p.round) === r;
      for (const i of [0, 1]) {
        const rid = c.rosterIds[i];
        const givesPicks = i === 0 ? c.givePicks : c.receivePicks, getsPicks = i === 0 ? c.receivePicks : c.givePicks;
        const gives = new Set([...(i === 0 ? c.give : c.receive), ...(c.drops[String(rid)] || [])].map(String));
        const gets = (i === 0 ? c.receive : c.give).map(String);
        const roster = c.rosters.find(r => String(r.roster_id) === String(rid));
        const after = { players: [...((roster && roster.players) || []).map(String).filter(id => !gives.has(id)), ...gets] };
        const given = new Set(givesPicks.map(pickKey));
        const held = [...(PK.owned.get(Number(rid)) || []).filter(p => !given.has(pickKey(p))), ...getsPicks];
        for (const id of likelyKeepers({ roster: after, catalog: S.catalog, rosValue: ros, keepers: K, eligible: rk.eligible })) {
          const r = rk.cost(id), pick = givesPicks.find(inRound(r));
          if (pick && !held.some(inRound(r))) out.push(`${rosterName(rid)}'s likely keeper ${playerName(id)} would cost their ${pickLabel(pick, rid)} — the pick in this offer.`);
        }
      }
      return out;
    }
    // Any pick in the offer two or more seasons ahead of the current season (the copy then says "future seasons").
    const picksLater = (...lists) => lists.some(l => l.some(p => Number(p.season) - PK.current >= 2));
    // Inside the summary, after the lineup lines: the block the controls (and the keeper rule's draft history) recompute. The
    // offer's players and each side's drops ({roster id: [Sleeper ids]}; none in a picks-only offer) are kept so the
    // keeper lines are recomputed with it.
    function picksBlock(summary, { rosterIds, thisSeason, givePicks, receivePicks, rosters, give, receive, drops = {} }) {
      const block = el("div", null, "season-picks-result");
      summary.append(block);
      lastPicks = { block, rosterIds, thisSeason, givePicks, receivePicks, rosters, give: give.map(String), receive: receive.map(String), drops };
      fillPicksBlock();
    }
    function renderPicksOnly({ snapshotAt, givePicks, receivePicks, rosters }) {
      const out = els.result;
      out.replaceChildren();
      const summary = el("div", null, "season-summary");
      summary.append(el("p", `This season: 0 pts for both teams over weeks ${first()}–${last()}; no players move, so neither starting lineup changes.`));
      picksBlock(summary, { rosterIds: [S.me.roster_id, S.partner.roster_id], thisSeason: [0, 0], givePicks, receivePicks, rosters, give: [], receive: [] });
      out.append(summary);
      out.append(el("p", picksLater(givePicks, receivePicks) ? PICKS_SUBLINE_TAIL_LATER : PICKS_SUBLINE_TAIL, "season-subline"));
      els.provenance.textContent = provenanceText(snapshotAt);
      out.hidden = false;
    }

    function render(result, { snapshotAt, week, give, receive, drops, excludeWeeks, rosters, givePicks = [], receivePicks = [] }) {
      const hasPicks = givePicks.length + receivePicks.length > 0;
      const later = picksLater(givePicks, receivePicks);
      const names = {};
      for (const s of result.sides) names[s.rosterId] = rosterName(s.rosterId);
      const playerNamesAll = {};
      for (const r of rosters) for (const id of [...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])]) playerNamesAll[String(id)] = playerName(String(id));
      const weeks = result.weeks;
      const t = scenarioText(result, {
        names, playerNames: {}, playerNamesAll, excludeWeeks, drops, picks: hasPicks, picksLater: later,
        currentWeek: week, firstWeek: weeks[0].week, endWeek: weeks[weeks.length - 1].week,
      });
      const out = els.result;
      out.replaceChildren();
      // 0. plain-English summary: the bottom line before anything else
      const summary = el("div", null, "season-summary");
      const ownLabel = viewer() ? names[result.sides[0].rosterId] : undefined;
      const received = [receive.map(String), give.map(String)];   // side 0 is the analysed roster: it gets `receive`
      const playerNameOf = id => playerNamesAll[String(id)] || String(id);
      for (const line of lineupSummary(result, { names, ownLabel, firstWeek: weeks[0].week, endWeek: weeks[weeks.length - 1].week, received, playerName: playerNameOf })) summary.append(el("p", line));
      // Draft picks: next season and the combined number, after this season's lines (an offer without a pick: nothing).
      if (hasPicks) picksBlock(summary, { rosterIds: result.sides.map(s => s.rosterId), thisSeason: result.sides.map(s => s.delta),
        givePicks, receivePicks, rosters, give, receive, drops });
      // Engine caveats: rostered players without a projection, counted as 0 (audit A6-3), and a starting slot a roster
      // cannot fill, taken by a free agent (result.pickups) or left at 0. The engine calls the first team "You" and the
      // second "They" and names the slot by its code; the page names both (caveatText).
      const teamOf = { You: names[result.sides[0].rosterId], They: names[result.sides[1].rosterId] };
      for (const c of result.caveats || []) summary.append(el("p", caveatText(c, teamOf), "season-summary-note"));
      summary.append(el("p", STARTERS_ONLY, "season-summary-note"));
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
      // 6. engine warnings verbatim (with a pick in the offer, the future-pick clause is reworded: it would be false)
      section("Engine notes", false).append(list((result.warnings || []).map(w => engineWarningText(w, hasPicks, later))));
      // 7. evaluation: only a record measured under this league's scoring and this model (spec §3.2)
      const ev = section("Measured evaluation", false);
      for (const line of evidenceLines(S.batch.evaluation, S.view)) ev.append(el("p", line, "season-eval"));
      // 8. provenance
      els.provenance.textContent = provenanceText(snapshotAt);
      out.hidden = false;
    }

    function renderBlocked(error) {
      const out = els.result;
      out.replaceChildren();
      const h = el("p", null, "season-headline"); out.append(h);
      // A traded player without a projection: only the engine's message, which names him and says what to do -- not
      // one row per player-week. Other players' gaps never reach here (they count as 0).
      if (Array.isArray(error && error.tradedWithoutProjection)) {
        h.append(el("strong", "Comparison blocked"));
        out.append(el("p", error.message, "season-subline"));
      } else {
        const c = coverageText(error);
        h.append(el("strong", c.headline));
        out.append(list(c.rows));
        out.append(el("p", "Nothing was scored.", "season-subline"));
      }
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

  return Object.freeze({ parseWeeks, identifyRoster, capacityOf, activeSkill, neededDrops, fmtDelta, scenarioText, lineupSummary, STARTERS_ONLY, coverageText,
    blockedStatus, slotName, caveatText,
    PICKS_SUBLINE_TAIL, PICKS_SUBLINE_TAIL_LATER, PICK_COPY, signedWhole, pickLine, engineWarningText, picksSummary, likelyKeepers,
    contextLines, evidenceLines, rosValueLines, COPY, FORBIDDEN, ALLOWED_SENTENCES, HEADLINE, init, batch, _reset,
    gradeLabel, pickHorizon, stratumOf, lopsidedMeasure, errorFor, gradeText, marketText, startCounts, positionalRanks, GRADE_FORBIDDEN, GRADE_LABELS });
});
