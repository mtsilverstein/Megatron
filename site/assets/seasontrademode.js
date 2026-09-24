/* In-season trade page controller. The pure helpers here are what the fixture
   tests; init() wires them to the DOM, to the shared Session bundle (identity,
   users, rosters, NFL state, catalog) and to SeasonTrade.analyze. */
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
  // The exact roster matcher lives in session.js now (spec §4.3); re-exported
  // under the old name so callers and the fixture keep one import.
  const identifyRoster = Session.identifyRoster;
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
  // Plain-English bottom line, one sentence group per side, read straight off
  // the engine's per-week before/after starting lineups (result.weeks[].sides[]
  // .before/.after.lineup). A week "changes" when the set of starters differs;
  // the lineup size is fixed by the slots, so who enters and who leaves always
  // pair up. States deltas and lineup moves only -- no judging words.
  const fmt1 = x => { const r = Math.round(x * 10) / 10; return r === 0 ? "0.0" : `${r < 0 ? "−" : "+"}${Math.abs(r).toFixed(1)}`; };
  const andList = xs => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  function lineupSummary(result, ctx) {
    const span = `weeks ${ctx.firstWeek}–${ctx.endWeek}`;
    const label = i => (i === 0 ? "Your lineup" : (ctx.names && ctx.names[result.sides[i].rosterId]) || `roster ${result.sides[i].rosterId}`);
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

  // --- controller -----------------------------------------------------------
  // Everything below touches the DOM and the live Sleeper API; the pure
  // helpers above are what the fixture pins. Nothing here calls Trade.* except
  // defaultPicks/applyTradedPicks (pick ownership only) and never TradeMode.*:
  // the pre-draft engine's numbers are not defined in season (spec §6.6).
  //
  // Who you are, which roster is yours, the league's users/rosters and the
  // NFL state all come from the committed Session bundle (spec §5); the
  // ~5 MB player catalog is Session.catalog(), fetched once per document.
  // This controller's only Sleeper calls of its own are traded_picks on load
  // and, through Session.refresh, the roster re-read before a compare.

  // Same rule as TradeMode.teamName, restated here rather than imported so
  // this controller never reaches into the pre-draft module.
  const teamNameOf = (user, rosterId) => (user && user.metadata && user.metadata.team_name) || (user && user.display_name) || `Roster ${rosterId}`;
  const activeIds = roster => {
    const locked = new Set([...(roster.reserve || []), ...(roster.taxi || [])].map(String));
    return (roster.players || []).map(String).filter(id => !locked.has(id));
  };
  const weekMismatch = (startWeek, week) => `remaining-season projections are for week ${startWeek}, the league is in week ${week}; wait for the next refresh`;
  const CHANGED = "Rosters changed since they were loaded — the columns were redrawn from the fresh snapshot; choose again.";
  const NO_IDENTITY = "Enter your Sleeper username in the league panel above; the trade columns read your roster from there.";
  const statusWord = s => String(s || "").replace(/_/g, " ");
  class PreflightError extends Error {}

  function init({ board, league, slug, els }) {
    const W = window;
    const SESSION = W.Session || Session;   // the page global (same object in the browser); node tests can script it
    const get = path => W.Sleeper.get(path);
    const lid = String(league.league_id);
    const el = (tag, text, cls) => {
      const node = document.createElement(tag);
      if (text !== undefined && text !== null) node.textContent = text;
      if (cls) node.className = cls;
      return node;
    };
    const setStatus = t => { els.status.textContent = t; };
    const leagueName = (board.league && board.league.name) || league.name || slug;
    let loadSeq = 0, busy = false, loading = false;
    // Bumped by every input change, every load and every bundle change the
    // controller did not ask for: a compare whose refresh was in flight when
    // it moved must not render under the new inputs.
    let compareSeq = 0;
    // The committed bundle the columns were drawn from (or adopted for a
    // compare). Session.onChange fires for every state move; only a
    // DIFFERENT committed bundle re-runs the load.
    let currentBundle = null;
    // Everything loaded for the current league snapshot. Reset wholesale on load.
    const S = { rosters: [], users: new Map(), state: null, remaining: null, catalog: null, owned: null, picksUnknown: false, me: null, partner: null, loadedProvenance: "" };
    const first = () => Math.max(Number(S.state.week), S.remaining.start_week) + 1;
    const last = () => S.remaining.end_week;
    const rosterName = rid => {
      const r = S.rosters.find(x => String(x.roster_id) === String(rid));
      return teamNameOf(r && S.users.get(r.owner_id), rid);
    };
    const playerName = id => (S.catalog && S.catalog[id] && S.catalog[id].full_name) || `Sleeper #${id}`;
    // One object per column. `players` are the selected trade assets, `picks`
    // the selected pick keys -> labels, `drops` the explicit drop choices,
    // `weeks` the raw "assume unavailable" text per player id (parsed on
    // input; `errors` holds the parse message for any field that does not).
    const newSide = (ul, dropsEl) => ({ ul, dropsEl, roster: null, active: [], players: new Set(), picks: new Map(), drops: new Set(), weeks: new Map(), errors: new Map(), needed: 0 });
    const sides = { mine: newSide(els.mine, els.mineDrops), theirs: newSide(els.theirs, els.theirsDrops) };
    const sideName = s => s.roster ? rosterName(s.roster.roster_id) : "";

    setEyebrow(league.settings && Number.isInteger(league.settings.leg) ? league.settings.leg : null);
    function setEyebrow(week) {
      els.eyebrow.textContent = `${leagueName} · ${league.season}${week ? ` week ${week}` : ""} · conditional lineup scenario`;
    }

    // --- load ---------------------------------------------------------------
    function preflight({ users, rosters, state, remaining, catalog }) {
      const fail = msg => { throw new PreflightError(msg); };
      if (league.status !== "in_season") fail(`this league is ${league.status}, not in season`);
      if (!Array.isArray(users) || !Array.isArray(rosters)) fail("Sleeper returned incomplete league data");
      if (rosters.length !== league.total_rosters) fail(`Sleeper returned ${rosters.length} rosters for a ${league.total_rosters}-team league`);
      if (!remaining) fail(`remaining-season projections are not published for ${slug} yet`);
      if (String(remaining.league && remaining.league.league_id) !== lid) fail(`remaining-season projections are for league ${remaining.league && remaining.league.league_id}, not this league`);
      if (remaining.season !== Number(league.season)) fail(`remaining-season projections are for ${remaining.season}; the league is in ${league.season}`);
      if (!state || String(state.season) !== String(league.season) || state.season_type !== "regular") fail(`Sleeper reports the ${state && state.season} ${state && state.season_type}; this tool needs the ${league.season} regular season`);
      const week = Number(state.week);
      if (!Number.isInteger(week)) fail("current NFL week unavailable");
      if (remaining.start_week !== week) fail(weekMismatch(remaining.start_week, week));
      if (!Number.isInteger(remaining.end_week) || week + 1 > remaining.end_week) fail(`no remaining weeks to compare after week ${week}`);
      if (!catalog || typeof catalog !== "object") fail("player catalog unavailable");
    }

    // Account-derived surfaces go dark together: columns, controls, result,
    // provenance (spec §4.4 rule 2 -- hidden, not just labeled).
    function hideAll() {
      hideResult();
      els.provenance.textContent = "";
      els.controls.hidden = true; els.cols.hidden = true; els.compare.disabled = true; els.warn.hidden = true;
    }

    // Why the columns are not showing: the session's error, no identity yet,
    // still loading, or the exact matcher's refusal (the chip's own wording).
    function gateMessage(bundle) {
      const err = SESSION.error();
      if (err) return err;
      if (!SESSION.identity()) return NO_IDENTITY;
      if (!bundle) return "loading league…";
      if (bundle.myRosterStatus === "none" || bundle.myRosterStatus === "ambiguous") return SESSION.chipText(bundle, "ready", Date.now());
      if (bundle.league && bundle.league.status !== "in_season") return `this league is ${bundle.league.status}, not in season`;
      return "loading league…";
    }

    // Copy the bundle's league data into the controller's snapshot. Users,
    // rosters, state and my roster never come from anywhere else.
    function adopt(bundle) {
      currentBundle = bundle;
      S.rosters = bundle.rosters; S.users = new Map(bundle.users.map(u => [u.user_id, u]));
      S.state = bundle.state; S.me = bundle.myRoster;
      setEyebrow(Number(bundle.state.week));
    }

    // Rebuild both columns from S. Selections are cleared (a redraw is a new
    // roster snapshot, so the old picks may not exist any more).
    function redraw() {
      fillPartners();
      resetSide(sides.mine, S.me);
      onPartnerChange();
    }

    // The load body: everything downstream of a committed bundle with a
    // uniquely matched roster. The bundle supplies users/rosters/state/me;
    // this fetches only traded_picks, the remaining-season file and the
    // session's once-per-document catalog.
    async function load(bundle) {
      const seq = ++loadSeq;
      compareSeq++;
      const stale = () => seq !== loadSeq;
      loading = true;
      currentBundle = bundle;
      try {
        hideAll();
        setStatus("reading traded picks, projections and the player catalog…");
        let picksUnknown = false;
        const [tradedPicks, remaining, catalog] = await Promise.all([
          get(`/league/${lid}/traded_picks`).catch(() => { picksUnknown = true; return null; }),
          W.FC.loadJSON(W.FC.leagueDataPath("remaining")).catch(() => null),
          SESSION.catalog(),
        ]);
        if (stale()) return;
        const { users, rosters, state, myRoster: me } = bundle;
        preflight({ users, rosters, state, remaining, catalog });
        if (!me) throw new PreflightError(SESSION.chipText(bundle, "ready", Date.now()));
        adopt(bundle);
        S.remaining = remaining; S.catalog = catalog; S.picksUnknown = picksUnknown;
        S.owned = pickOwnership(rosters, tradedPicks);
        S.loadedProvenance = provenanceText(null);
        redraw();
        els.controls.hidden = false; els.cols.hidden = false;
        els.provenance.textContent = S.loadedProvenance;
        renderWarn();
        setStatus(`${rosters.length} teams loaded — you are ${rosterName(me.roster_id)}`);
      } catch (e) {
        if (stale() || SESSION.isSuperseded(e)) return;
        setStatus(e instanceof PreflightError ? e.message : `load failed: ${e.message} — refresh from the league panel to retry`);
      } finally {
        if (!stale()) loading = false;
      }
    }

    // Session.onChange driver. Gated on bundle()/myRosterStatus/error(),
    // never on state() === "error" (a stale identity error can coexist with
    // a valid bundle). A bundle this controller did not ask for redraws the
    // columns and invalidates any compare in flight; the one exception is the
    // bundle compare() itself requested through Session.refresh -- same
    // account, same roster, arriving while `busy` -- which is adopted as data
    // so the compare it belongs to can finish against it.
    function sync() {
      const bundle = SESSION.bundle();
      if (!bundle || bundle.myRosterStatus !== "found" || !bundle.myRoster || !bundle.league || bundle.league.status !== "in_season") {
        ++loadSeq; compareSeq++; currentBundle = null; loading = false;
        hideAll(); setStatus(gateMessage(bundle));
        return;
      }
      if (bundle === currentBundle) return;
      const sameAccount = busy && currentBundle && S.me
        && bundle.identity && currentBundle.identity && bundle.identity.userId === currentBundle.identity.userId
        && String(bundle.myRoster.roster_id) === String(S.me.roster_id);
      if (sameAccount) { adopt(bundle); return; }
      load(bundle);
    }

    // Loud half of the load: what the page could not read, said once.
    function renderWarn() {
      const notes = [];
      if (S.picksUnknown) notes.push("couldn't read traded picks — pick ownership is unknown, so picks are listed as unknown ownership");
      if (!S.remaining.evaluation) notes.push("no measured evaluation for this league's scoring");
      els.warn.textContent = notes.join(" · ");
      els.warn.hidden = !notes.length;
    }

    // Future-season picks, ownership only. defaultPicks says "everyone holds
    // their own"; applyTradedPicks moves the pick OBJECTS between rosters, so
    // tagging each with its original roster before the move is what lets a
    // row say "(via <team>)". traded_picks unavailable -> null, shown as unknown.
    function pickOwnership(rosters, tradedPicks) {
      if (S.picksUnknown) return null;
      const season = Number(league.season);
      const owned = W.Trade.defaultPicks(rosters.map(r => r.roster_id), [season + 1, season + 2], W.Keepers.DRAFT_ROUNDS);
      for (const [rid, list] of owned) for (const p of list) p.original = rid;
      W.Trade.applyTradedPicks(owned, tradedPicks || []);
      return owned;
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
    function drawColumns() {
      for (const side of [sides.mine, sides.theirs]) {
        side.ul.replaceChildren();
        const heading = side.ul.parentElement && side.ul.parentElement.querySelector("h2");
        if (heading) heading.textContent = `${side === sides.mine ? "You give" : "You get"} — ${sideName(side)}`;
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
        for (const li of pickRows(side)) side.ul.append(li);
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

    function pickRows(side) {
      if (!S.owned) {
        const li = el("li", null, "season-row season-disabled");
        const label = el("label"), box = el("input");
        box.type = "checkbox"; box.disabled = true;
        label.append(box, document.createTextNode(" picks: unknown ownership (traded_picks unavailable)"));
        li.append(label);
        return [li];
      }
      const mine = String(side.roster.roster_id);
      const list = (S.owned.get(side.roster.roster_id) || []).slice().sort((a, b) => a.season - b.season || a.round - b.round);
      return list.map(p => {
        const key = `${p.season}-${p.round}-${p.original}`;
        const text = `${p.season} R${p.round}${String(p.original) !== mine ? ` (via ${rosterName(p.original)})` : ""}`;
        const li = el("li", null, "season-row season-pick");
        const label = el("label"), box = el("input");
        box.type = "checkbox"; box.checked = side.picks.has(key);
        label.append(box, document.createTextNode(` ${text}`));
        box.addEventListener("change", () => {
          if (box.checked) side.picks.set(key, text); else side.picks.delete(key);
          li.classList.toggle("picked", box.checked);
          onInputChange();
        });
        li.append(label, el("span", "not valued in season", "trade-why"));
        return li;
      });
    }

    // --- drops --------------------------------------------------------------
    // Capacity counts every non-IR/TAXI slot, so K/DEF occupy spots and count
    // in `active` even though only skill players can be traded here.
    function updateDrops() {
      const capacity = capacityOf(league);
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
      if (!S.me || !S.partner) return false;
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
        // Rosters + NFL state re-read through the session so the chip's age
        // moves with them. The NEW bundle's post-fetch time is the engine's
        // snapshotAt (its <=60 s rule, seasontrade.js:21-25); sync() adopts
        // the same bundle as it commits, so S.rosters/S.state match `b`.
        const b = await SESSION.refresh({ scope: "rosters" });
        const rosters = b.rosters, state = b.state;
        // Inputs stayed live during the await; anything that moved (a
        // checkbox, a week field, partner, a reload, a bundle from elsewhere) invalidates
        // this run outright.
        if (seq !== compareSeq || !inputsValid()) { if (!loading) setStatus("inputs changed during the comparison — compare again"); return; }
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
          remaining: S.remaining, league, rosters, catalog: S.catalog, board,
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
      const r = S.remaining, deadline = league.settings && league.settings.trade_deadline;
      const catalogAt = SESSION.catalogFetchedAt();
      return `Remaining-season projections generated ${r.generated_at}, data through ${r.data_through}.`
        + (snapshotAt ? ` Roster snapshot ${new Date(snapshotAt).toISOString()}.` : "")
        + ` Player catalog fetched ${Number.isFinite(catalogAt) ? new Date(catalogAt).toISOString() : "unknown time"}.`
        + (deadline ? ` Trade deadline: week ${deadline} (league setting).` : "");
    }

    function render(result, { snapshotAt, week, give, receive, drops, excludeWeeks, rosters }) {
      const names = {};
      for (const s of result.sides) names[s.rosterId] = rosterName(s.rosterId);
      const playerNamesAll = {};
      for (const r of rosters) for (const id of [...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])]) playerNamesAll[String(id)] = playerName(String(id));
      const picks = [];
      for (const s of [sides.mine, sides.theirs]) for (const text of s.picks.values()) picks.push({ label: `${sideName(s)} gives ${text}` });
      const weeks = result.weeks;
      const t = scenarioText(result, {
        names, playerNames: {}, playerNamesAll, picks, excludeWeeks, drops,
        currentWeek: week, firstWeek: weeks[0].week, endWeek: weeks[weeks.length - 1].week,
      });
      const out = els.result;
      out.replaceChildren();
      // 0. plain-English summary: the bottom line before anything else
      const summary = el("div", null, "season-summary");
      for (const line of lineupSummary(result, { names, firstWeek: weeks[0].week, endWeek: weeks[weeks.length - 1].week })) summary.append(el("p", line));
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
      const assumptions = [...t.assumptions, ...t.notValued];
      section("Assumptions", true).append(list(assumptions.length ? assumptions : ["No unavailable weeks entered and no drops; every active player is assumed to play every remaining week."]));
      // 5. availability flags
      if ((result.availabilityFlags || []).length) {
        section("Reported availability tags", false).append(list(result.availabilityFlags.map(f => `${f.name}: ${f.status} — ${f.interpretation}`)));
      }
      // 6. engine warnings verbatim
      section("Engine notes", false).append(list(result.warnings || []));
      // 7. evaluation
      const ev = section("Measured evaluation", false);
      for (const line of W.ROS.evaluationText(S.remaining.evaluation)) ev.append(el("p", line, "season-eval"));
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
    // No username input and no load button here: identity and the league
    // load belong to the chip in the league panel (FC.setBoard in the page
    // shell starts Session.ready). The chip's refresh button re-reads rosters
    // + state; sync() redraws from whatever bundle it commits.
    els.partner.addEventListener("change", onPartnerChange);
    els.compare.addEventListener("click", compare);
    refreshCompare();
    SESSION.onChange(sync);
    sync();
  }

  return Object.freeze({ parseWeeks, identifyRoster, capacityOf, activeSkill, neededDrops, fmtDelta, scenarioText, lineupSummary, coverageText, FORBIDDEN, ALLOWED_SENTENCES, HEADLINE, init });
});
