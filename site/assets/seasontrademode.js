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

  // --- controller -----------------------------------------------------------
  // Everything below touches the DOM and the live Sleeper API; the pure
  // helpers above are what the fixture pins. Nothing here calls Trade.* except
  // defaultPicks/applyTradedPicks (pick ownership only) and never TradeMode.*:
  // the pre-draft engine's numbers are not defined in season (spec §6.6).

  // The Sleeper player catalog is ~5 MB; fetched once per session like the
  // waiver desk does, with its fetch time carried into the provenance line.
  let catalogPromise = null, catalogFetchedAt = null;
  function loadCatalog(get) {
    if (!catalogPromise) catalogPromise = get("/players/nfl")
      .then(data => { catalogFetchedAt = new Date().toISOString(); return data; })
      .catch(error => { catalogPromise = null; throw error; });
    return catalogPromise;
  }

  // Same rule as TradeMode.teamName, restated here rather than imported so
  // this controller never reaches into the pre-draft module.
  const teamNameOf = (user, rosterId) => (user && user.metadata && user.metadata.team_name) || (user && user.display_name) || `Roster ${rosterId}`;
  const activeIds = roster => {
    const locked = new Set([...(roster.reserve || []), ...(roster.taxi || [])].map(String));
    return (roster.players || []).map(String).filter(id => !locked.has(id));
  };
  const weekMismatch = (startWeek, week) => `remaining-season projections are for week ${startWeek}, the league is in week ${week}; wait for the next refresh`;
  const CHANGED = "Rosters changed since they were loaded — reload the league.";
  const statusWord = s => String(s || "").replace(/_/g, " ");
  class PreflightError extends Error {}

  function init({ board, league, slug, els }) {
    const W = window;
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
    // Bumped by every input change and every load: a compare whose fetches
    // were in flight when it moved must not render under the new inputs.
    let compareSeq = 0;
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

    async function load() {
      const username = els.user.value.trim();
      if (!username) { setStatus("enter your Sleeper username"); return; }
      const seq = ++loadSeq;
      compareSeq++;
      const stale = () => seq !== loadSeq;
      loading = true;
      try {
        hideResult();
        els.controls.hidden = true; els.cols.hidden = true; els.compare.disabled = true; els.warn.hidden = true;
        setStatus("looking up user…");
        const user = await get(`/user/${encodeURIComponent(username)}`);
        if (stale()) return;
        if (!user || !user.user_id) { setStatus("user not found"); return; }
        setStatus("reading rosters, projections and the player catalog…");
        let picksUnknown = false;
        const [users, rosters, tradedPicks, state, remaining, catalog] = await Promise.all([
          get(`/league/${lid}/users`),
          get(`/league/${lid}/rosters`),
          get(`/league/${lid}/traded_picks`).catch(() => { picksUnknown = true; return null; }),
          get("/state/nfl"),
          W.FC.loadJSON(W.FC.leagueDataPath("remaining")).catch(() => null),
          loadCatalog(get),
        ]);
        if (stale()) return;
        preflight({ users, rosters, state, remaining, catalog });
        let me;
        try { me = identifyRoster(rosters, user.user_id); } catch (e) { throw new PreflightError(e.message); }
        S.rosters = rosters; S.users = new Map(users.map(u => [u.user_id, u]));
        S.state = state; S.remaining = remaining; S.catalog = catalog; S.picksUnknown = picksUnknown;
        S.owned = pickOwnership(rosters, tradedPicks);
        S.me = me;
        S.loadedProvenance = provenanceText(null);
        setEyebrow(Number(state.week));
        fillPartners();
        resetSide(sides.mine, me);
        onPartnerChange();
        els.controls.hidden = false; els.cols.hidden = false;
        els.provenance.textContent = S.loadedProvenance;
        renderWarn();
        setStatus(`${rosters.length} teams loaded — you are ${rosterName(me.roster_id)}`);
      } catch (e) {
        setStatus(e instanceof PreflightError ? e.message : `load failed: ${e.message}`);
      } finally {
        if (!stale()) loading = false;
      }
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
      const weeks = el("input", null, "season-weeks");
      weeks.type = "text"; weeks.autocomplete = "off";
      weeks.placeholder = "unavailable weeks e.g. 3-5, 8";
      weeks.setAttribute("aria-label", `assume unavailable weeks for ${playerName(id)}`);
      weeks.value = side.weeks.get(id) || "";
      weeks.hidden = !(box.checked || tagged);
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
        weeks.hidden = !(box.checked || tagged);
        if (weeks.hidden) { weeks.value = ""; side.weeks.delete(id); side.errors.delete(id); err.hidden = true; }
        updateDrops();
        onInputChange();
      });
      weeks.addEventListener("input", () => { parse(); onInputChange(); });
      li.append(weeks, err);
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
      if (!S.me || !S.partner) return false;
      if (!els.ack.checked) return false;
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
        const [rosters, state] = await Promise.all([get(`/league/${lid}/rosters`), get("/state/nfl")]);
        // Inputs stayed live during the await; anything that moved (ack, a
        // checkbox, partner, a reload) invalidates this run outright.
        if (seq !== compareSeq || !inputsValid()) { if (!loading) setStatus("inputs changed during the comparison — compare again"); return; }
        const snapshotAt = Date.now();
        const week = Number(state && state.week);
        if (!Number.isInteger(week) || week !== S.remaining.start_week) { setStatus(weekMismatch(S.remaining.start_week, state && state.week)); return; }
        for (const s of [sides.mine, sides.theirs]) {
          const fresh = (rosters || []).find(r => String(r.roster_id) === String(s.roster.roster_id));
          const active = new Set(fresh ? activeIds(fresh) : []);
          if (![...s.players, ...s.drops].every(id => active.has(id))) { setStatus(CHANGED); return; }
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
        renderBlocked(e);
        setStatus("comparison blocked");
      } finally {
        busy = false; refreshCompare();
      }
    }

    // --- output (spec §4.5 order) -------------------------------------------
    function provenanceText(snapshotAt) {
      const r = S.remaining, deadline = league.settings && league.settings.trade_deadline;
      return `Remaining-season projections generated ${r.generated_at}, data through ${r.data_through}.`
        + (snapshotAt ? ` Roster snapshot ${new Date(snapshotAt).toISOString()}.` : "")
        + ` Player catalog fetched ${catalogFetchedAt || "unknown time"}.`
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
      weekTable.append(wb); out.append(weekTable);
      // 4. assumptions
      out.append(el("h3", "Assumptions"));
      const assumptions = [...t.assumptions, ...t.notValued];
      out.append(list(assumptions.length ? assumptions : ["No unavailable weeks entered and no drops; every active player is assumed to play every remaining week."]));
      // 5. availability flags
      if ((result.availabilityFlags || []).length) {
        out.append(el("h3", "Reported availability tags"));
        out.append(list(result.availabilityFlags.map(f => `${f.name}: ${f.status} — ${f.interpretation}`)));
      }
      // 6. engine warnings verbatim
      out.append(el("h3", "Engine notes"));
      out.append(list(result.warnings || []));
      // 7. evaluation
      out.append(el("h3", "Measured evaluation"));
      for (const line of W.ROS.evaluationText(S.remaining.evaluation)) out.append(el("p", line, "season-eval"));
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
    els.load.addEventListener("click", load);
    els.user.addEventListener("keydown", e => { if (e.key === "Enter") load(); });
    els.partner.addEventListener("change", onPartnerChange);
    els.ack.addEventListener("change", onInputChange);
    els.compare.addEventListener("click", compare);
    refreshCompare();
  }

  return Object.freeze({ parseWeeks, identifyRoster, capacityOf, activeSkill, neededDrops, fmtDelta, scenarioText, coverageText, FORBIDDEN, ALLOWED_SENTENCES, HEADLINE, init });
});
