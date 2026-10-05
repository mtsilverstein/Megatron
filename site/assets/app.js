/* Megatron — shared utilities. No framework, no build. */
// UMD like the other shared modules: `window.FC` in the browser, `module.exports`
// under node so session.js (and fixtures) can read the registry without a
// `window` shim. DOM/location are only touched inside functions.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FC = api;
})(typeof window !== "undefined" ? window : null, () => {
  const POS_CLASS = { QB: "pos-qb", RB: "pos-rb", WR: "pos-wr", TE: "pos-te" };
  // The ONE supported-league table (design spec §3). Slugs, platform, live
  // league id, select label and which live tools each league connects to.
  // session.js, the nav-label rule and the league select all read from here;
  // an unknown slug never defaults (see leagueNavigation).
  const REGISTRY = Object.freeze([
    { slug: "gabagool", platform: "sleeper", leagueId: "1376245373244301312", label: "Gabagool · Sleeper",
      tools: { draft: true, keepers: true, trade: true, waivers: true, startsit: true } },
    { slug: "fam",      platform: "sleeper", leagueId: "1389736745205002240", label: "FAM · Sleeper",
      tools: { draft: true, keepers: false, trade: true, waivers: true, startsit: true } },
    { slug: "espnfam",  platform: "espn",    leagueId: "69827905",            label: "ESPN family · draft board only",
      tools: { draft: true, keepers: false, trade: false, waivers: false, startsit: false } },
  ].map(entry => Object.freeze({ ...entry, tools: Object.freeze(entry.tools) })));
  const LEAGUES = REGISTRY.map(r => [r.slug, r.label]);
  const LEAGUE_SLUGS = REGISTRY.map(r => r.slug);
  const registryFor = slug => REGISTRY.find(r => r.slug === slug) || null;
  // Which registry tool a nav destination needs. Pages absent here (index,
  // about, connect) are always connected.
  const TOOL_FOR_PAGE = { "trade.html": "trade", "weekly.html": "startsit", "waivers.html": "waivers" };

  // ---- league selection by Sleeper id (any-league spec 5.1, 5.4) ----------
  // In-season pages take ANY Sleeper league id; the registry slugs gabagool /
  // fam are legacy aliases of their ids. Draft-side pages (the board, its
  // keeper panel, pre-draft trade) stay registry-only: a registered id maps to
  // its slug, any other id is refused by name -- never a substituted league.
  // ESPN keeps its registry route.
  const DRAFT_ONLY = "The draft board is only built for registered leagues.";
  const ESPN_IN_SEASON = "ESPN in-season tools are not connected yet; use its draft board only.";
  const ID_TOOLS = Object.freeze({ startsit: true, waivers: true, trade: true });
  // Destinations whose league parameter is the id between in-season pages.
  const IN_SEASON_DEST = new Set(["weekly.html", "waivers.html", "trade.html"]);
  // Pages that are in-season whatever the parameter's spelling.
  const IN_SEASON_HOME = new Set(["weekly.html", "waivers.html"]);
  // Pages that exist only for a registered board.
  const DRAFT_HOME = new Set(["index.html", ""]);
  const isLeagueId = v => typeof v === "string" && /^\d+$/.test(v);
  const sleeperEntryForId = id => REGISTRY.find(r => r.platform === "sleeper" && r.leagueId === id) || null;
  const pageOf = href => new URL(href, "https://x.invalid/").pathname.split("/").pop();
  // The ONE reading of ?league= for every page. No parameter is Gabagool, as
  // before; a slug is its registry row; a numeric id is a Sleeper league,
  // registered or not; anything else is invalid and never defaults.
  function leagueParam(value) {
    const raw = value === undefined ? new URLSearchParams(location.search).get("league") : value;
    const v = raw === null || raw === undefined || raw === "" ? "gabagool" : String(raw);
    const bySlug = registryFor(v);
    if (bySlug) return { raw: v, slug: v, entry: bySlug, leagueId: bySlug.platform === "sleeper" ? bySlug.leagueId : null, isId: false, invalid: false };
    if (isLeagueId(v)) {
      const e = sleeperEntryForId(v);
      return { raw: v, slug: e ? e.slug : null, entry: e, leagueId: v, isId: true, invalid: false };
    }
    return { raw: v, slug: null, entry: null, leagueId: null, isId: false, invalid: true };
  }
  // The in-season pages' league: the Sleeper id, and the registry slug when
  // the league is registered (null otherwise) for the legacy data files.
  function inSeasonLeague() {
    const p = leagueParam();
    if (p.invalid) throw new Error(`Unknown league "${p.raw}".`);
    if (!p.leagueId) throw new Error(ESPN_IN_SEASON);
    return { leagueId: p.leagueId, legacySlug: p.slug };
  }

  async function loadJSON(path) {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  function leagueDataPath(kind) {
    const p = leagueParam();
    if (p.invalid) throw Error("Unknown league");
    if (!["draft", "weekly", "remaining"].includes(kind)) throw Error("Unknown league data kind");
    // Per-league files exist only for registered leagues (a registered id
    // reads its slug's files); an unregistered id has no board to read.
    if (p.slug === null) throw Error(kind === "draft" ? DRAFT_ONLY : "Unknown league");
    const slug = p.slug;
    // remaining-<slug>.json is named per league for every league, including
    // Gabagool; the bare-name convention applies to draft/weekly only.
    if (kind === "remaining") return `data/remaining-${slug}.json`;
    return `data/${kind}${slug === "gabagool" ? "" : `-${slug}`}.json`;
  }

  // ---- identity chip (design spec §6) -------------------------------------
  // The chip lives INSIDE #league-context and is the one place a visitor
  // identifies. It reads Session (site/assets/session.js) lazily so this file
  // still loads under node and in a page that has not included session.js
  // (then the panel renders without a chip, as before). Rendering is gated on
  // Session.bundle()/myRosterStatus/error(), never on state() === "error"
  // alone: a stale identity error can coexist with a valid committed bundle.
  // Superseded rejections (err.superseded) are swallowed, never displayed.
  let sessionOverride = null;
  const session = () => {
    if (sessionOverride) return sessionOverride;
    if (typeof Session !== "undefined" && Session) return Session;
    if (typeof window !== "undefined" && window && window.Session) return window.Session;
    return null;
  };
  const swallow = () => {};   // identify/ready failures surface via Session.error(); superseded ones never
  const chip = {
    slug: null, board: null, leagueId: null, leagueOpts: null, readyFor: null, els: null, unsub: null, ticker: null,
    lastName: "", changing: false, notice: "", prefill: "", controlsSig: null,
  };
  function chipEntry() { return registryFor(chip.slug); }
  function isEspn() { const e = chipEntry(); return !!e && e.platform !== "sleeper"; }
  // ready() only when a Sleeper board is set, an identity exists and no
  // bundle has been committed for THIS board yet. ESPN never calls ready
  // (Session would answer with zero calls, but the chip's UI does not rely on
  // that). Pages that never set a board (about, connect) only identify.
  // The in-season id path (FC.setLeague) loads at once: identity is optional
  // there (an anonymous visitor views any league read-only).
  function maybeReady() {
    const S = session();
    if (!S) return;
    if (chip.leagueId) {
      if (S.bundle() && chip.readyFor === chip.leagueId) return;
      const leagueId = chip.leagueId, extra = chip.leagueOpts || {};
      chip.readyFor = leagueId;
      Promise.resolve().then(() => S.ready({ ...extra, leagueId })).catch(swallow);
      return;
    }
    if (!chip.slug || !chip.board || isEspn()) return;
    if (!S.identity()) return;
    if (S.bundle() && chip.readyFor === chip.board) return;
    chip.readyFor = chip.board;
    const slug = chip.slug, board = chip.board;   // captured now: a later mount must not retarget this load
    Promise.resolve().then(() => S.ready({ slug, board })).catch(swallow);
  }
  function setBoard(board) {
    chip.board = board || null;
    chip.leagueId = null;            // a board page is the registry path
    chip.leagueOpts = null;
    chip.readyFor = null;
    maybeReady();
  }
  // In-season pages: load ANY Sleeper league by id (Session.ready({leagueId}))
  // immediately, with or without an identity. null clears. opts:
  // {preDraftAnySeason: true} is trade.html's mode resolution only (session.js
  // header): a pre-draft league is not held to the in-season season contract.
  function setLeague(leagueId, opts) {
    chip.leagueId = leagueId === null || leagueId === undefined || leagueId === "" ? null : String(leagueId);
    chip.leagueOpts = opts && opts.preDraftAnySeason === true ? { preDraftAnySeason: true } : null;
    chip.board = null;
    chip.readyFor = null;
    maybeReady();
  }
  function chipButton(id, text, onClick) {
    const b = document.createElement("button");
    b.type = "button"; b.id = id; b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }
  function chipIdentify(name) {
    const S = session();
    name = String(name || "").trim();
    if (!S || !name) return;
    chip.lastName = name; chip.changing = false; chip.notice = "";
    S.identify(name).then(() => maybeReady(), swallow);
  }
  // A failed refresh is not an error state (the committed bundle stays valid),
  // so its text is a notice beside the controls, cleared by the next action.
  function chipRefresh(opts) {
    const S = session();
    if (!S || !S.bundle() || isEspn()) return Promise.resolve(null);
    chip.notice = "";
    const p = S.refresh(Object.assign({ scope: "rosters" }, opts || {}));
    p.then(() => { chip.notice = ""; renderChip(); },
           e => { if (S.isSuperseded && S.isSuperseded(e)) return; chip.notice = `Refresh failed: ${(e && e.message) || e}`; renderChip(); });
    return p.catch(() => null);
  }
  // The page owns its refresh path. The chip's refresh button is the only
  // refresh control on waivers/weekly (spec §5), but the chip cannot know
  // what a page needs re-fetched atomically with the rosters -- the waiver
  // desk must re-read the week's transactions in the SAME generation, so a
  // transactions failure commits nothing and the age does not advance
  // (Session.refresh's `also` hook). A page registers ONE provider,
  // `FC.chip.onRefresh(() => ({ scope, also }))`, called at click time; its
  // return value is the options object handed to Session.refresh. Without a
  // provider the button refreshes rosters + state, as before. The returned
  // function unregisters the provider.
  let refreshProvider = null;
  function onRefresh(fn) {
    refreshProvider = typeof fn === "function" ? fn : null;
    return () => { if (refreshProvider === fn) refreshProvider = null; };
  }
  function chipRefreshClick() {
    let opts;
    try { opts = refreshProvider ? refreshProvider() : undefined; }
    catch (e) { chip.notice = `Refresh failed: ${(e && e.message) || e}`; renderChip(); return Promise.resolve(null); }
    return chipRefresh(opts);
  }
  // No identity + error = the identify failed (identify clears the account
  // first); identity + error = the league load failed.
  function chipRetry() {
    const S = session();
    if (!S) return;
    // The id path: a failed league load (no bundle) retries the load itself,
    // identity or not; otherwise the failure was the identify.
    if (chip.leagueId && !S.bundle()) { chip.readyFor = null; maybeReady(); return; }
    if (!S.identity()) { chipIdentify(chip.lastName); return; }
    if (chip.board && !isEspn()) { chip.readyFor = null; maybeReady(); }
  }
  function identifyForm(prefill) {
    const form = document.createElement("form");
    form.className = "session-form";
    const label = document.createElement("label");
    label.textContent = "Sleeper username ";
    const input = document.createElement("input");
    input.type = "text"; input.id = "session-user"; input.autocomplete = "off";   // not a login field
    input.setAttribute("spellcheck", "false"); input.placeholder = "Sleeper username";
    input.value = prefill || "";
    label.append(input);
    const use = document.createElement("button");
    use.type = "submit"; use.id = "session-use"; use.textContent = "Use this account";
    form.append(label, use);
    form.addEventListener("submit", e => { if (e && e.preventDefault) e.preventDefault(); chipIdentify(input.value); });
    chip.els.input = input;
    return form;
  }
  // The id path's bundle: a Sleeper league loaded for THIS page's league id.
  function idPathBundle(b) {
    return !!(chip.leagueId && b && b.registry && b.registry.platform === "sleeper"
      && String(b.registry.leagueId) === chip.leagueId && Array.isArray(b.rosters));
  }
  function pickerTeams(S, b) {
    return b.rosters.filter(r => r).map(r => [String(r.roster_id), S.teamName(b.users, r)]);
  }
  // A visitor who is not this league's owner (anonymous, or an account with
  // no unique roster here) chooses a team to VIEW, by the league's own names.
  // Session.view never sets myRoster.
  function teamPicker(S, b) {
    const label = document.createElement("label");
    label.textContent = "View team ";
    const select = document.createElement("select");
    select.id = "session-team";
    const none = document.createElement("option"); none.value = ""; none.textContent = "Choose a team";
    select.append(none);
    for (const [value, name] of pickerTeams(S, b)) {
      const o = document.createElement("option"); o.value = value; o.textContent = name; select.append(o);
    }
    select.value = b.viewedRosterId === null || b.viewedRosterId === undefined ? "" : String(b.viewedRosterId);
    select.addEventListener("change", () => {
      chip.notice = "";
      try { S.view(select.value === "" ? null : select.value); }
      catch (e) { chip.notice = String((e && e.message) || e); renderChip(); }
    });
    label.append(select);
    return label;
  }
  // Called on every Session.onChange fire, on every chip action AND by the
  // 1 s ticker. The line (Session.chipText, whose age moves) is rewritten on
  // every call; the controls are rebuilt only when the state they are built
  // from changes -- `controlsSig` names that state. A tick therefore never
  // replaces the username input the visitor is typing into after "change"
  // or "forget", and never steals keyboard focus from a chip button.
  function renderChip() {
    const S = session(), els = chip.els;
    if (!S || !els) return;
    const st = S.state(), err = S.error(), id = S.identity(), b = S.bundle(), entry = chipEntry();
    const now = Date.now();
    // The line is ALWAYS Session.chipText. Without a committed bundle the
    // identity still gets a bundle-shaped view so ESPN reads "name · label".
    const view = b || (id ? { identity: id, registry: entry } : null);
    const changeBtn = () => chipButton("session-change", "change", () => { chip.changing = true; renderChip(); });
    const forgetBtn = () => chipButton("session-forget", "forget", () => { chip.changing = false; chip.notice = ""; S.forget(); });
    const refreshBtn = refreshing => {
      const r = chipButton("session-refresh", "refresh", () => { chipRefreshClick(); });
      if (refreshing) r.disabled = true;
      return r;
    };
    // In-season id path: a non-owner gets the team picker (and, anonymous,
    // the refresh button the owner line carries). Its signature is the teams
    // and the choice, so a tick never rebuilds an open dropdown.
    const idPath = idPathBundle(b);
    const viewing = idPath && b.analysisRole !== "owner";
    const extras = () => (viewing ? [teamPicker(S, b)] : []);
    const extrasSig = viewing ? [pickerTeams(S, b), b.viewedRosterId === undefined ? null : b.viewedRosterId] : null;
    let line, build, sig;
    if (st === "identifying") {
      line = S.chipText(null, "identifying", now);
      build = () => []; sig = ["identifying"];
    } else if (chip.changing || (!id && !err)) {
      // The username form: anonymous, or "change" clicked from any state
      // (including error, where the previous attempt prefills the box).
      // On the id path an anonymous bundle is a real state (ready /
      // refreshing, a viewed team), so the line follows it.
      line = err ? S.chipText(view, "error", now, err) : S.chipText(view, id || idPath ? st : "anonymous", now);
      const prefill = id ? id.username : (chip.changing && chip.lastName) || chip.prefill;
      const cancel = !!(id || err);
      const anonRefresh = idPath && !id && !err;
      const refreshing = st === "refreshing";
      build = () => {
        const c = [identifyForm(prefill)];
        // Anonymous: the line already reads "Remembered on this device until
        // you choose forget." (chipText), so no second copy is added here.
        if (cancel) c.push(chipButton("session-cancel", "cancel", () => { chip.changing = false; renderChip(); }));
        c.push(...extras());
        if (anonRefresh) c.push(refreshBtn(refreshing));
        return c;
      };
      sig = ["form", prefill, cancel, extrasSig, anonRefresh && refreshing];
    } else if (err) {
      line = S.chipText(view, "error", now, err);
      build = () => [chipButton("session-retry", "retry", chipRetry), changeBtn()]; sig = ["error"];
    } else if (st === "loadingLeague") {
      line = S.chipText(view, "loadingLeague", now);
      build = () => [changeBtn()]; sig = ["loadingLeague"];
    } else if (isEspn()) {
      line = S.chipText(view, st, now);
      build = () => [changeBtn(), forgetBtn()]; sig = ["espn"];
    } else if (b && (b.myRosterStatus === "none" || b.myRosterStatus === "ambiguous")) {
      line = S.chipText(b, st, now);
      const refreshing = st === "refreshing";
      build = () => [changeBtn(), ...extras(), ...(idPath ? [refreshBtn(refreshing)] : [])];
      sig = ["noroster", extrasSig, idPath && refreshing];
    } else if (b && b.myRoster) {
      line = S.chipText(b, st, now);
      const refreshing = st === "refreshing";
      build = () => [refreshBtn(refreshing), changeBtn(), forgetBtn()];
      sig = ["ready", refreshing];
    } else {
      // Identified with no bundle on this page (no board set yet): the line is
      // the remembered sentence, so the account is named beside the controls.
      line = S.chipText(view, st, now);
      const whoText = id.displayName || id.username;
      build = () => {
        const who = document.createElement("span"); who.id = "session-who";
        who.textContent = whoText;
        return [who, changeBtn(), forgetBtn()];
      };
      sig = ["identified", whoText];
    }
    sig.push(chip.notice);
    els.line.textContent = line;
    // The live-settings stamp (spec 5.2) beside the line, from leagueFetchedAt.
    if (els.settings) {
      els.settings.textContent = b && b.registry && b.registry.platform === "sleeper" && typeof S.settingsText === "function"
        ? S.settingsText(b) : "";
    }
    const key = JSON.stringify(sig);
    if (key === chip.controlsSig) return;
    chip.controlsSig = key;
    els.input = null;
    const controls = build();
    if (chip.notice) {
      const n = document.createElement("span"); n.className = "session-notice"; n.textContent = chip.notice;
      controls.push(n);
    }
    els.controls.replaceChildren(...controls);
  }
  // The age in the line comes from bundle().rostersFetchedAt; re-render every
  // second while a bundle carries one (renderChip rewrites the line only --
  // the controls stay put unless their state changed). A re-mount clears the
  // old interval first; under node the timer is unref'd so it never holds the
  // process open.
  function startTicker() {
    if (chip.ticker) { clearInterval(chip.ticker); chip.ticker = null; }
    if (typeof setInterval !== "function") return;
    chip.ticker = setInterval(() => {
      const S = session(); const b = S && S.bundle();
      if (b && Number.isFinite(b.rostersFetchedAt)) renderChip();
    }, 1000);
    if (chip.ticker && typeof chip.ticker.unref === "function") chip.ticker.unref();
  }
  function mountChip(panel, slug) {
    const S = session();
    if (!S) return;
    chip.slug = slug; chip.changing = false; chip.notice = ""; chip.lastName = "";
    if (chip.unsub) { try { chip.unsub(); } catch (_) {} chip.unsub = null; }
    const wrap = document.createElement("div"); wrap.id = "session-chip"; wrap.className = "session-chip";
    const line = document.createElement("span"); line.id = "session-text"; line.className = "session-text";
    const settings = document.createElement("span"); settings.id = "session-settings"; settings.className = "session-settings";
    const controls = document.createElement("div"); controls.className = "session-controls";
    wrap.append(line, settings, controls);
    panel.append(wrap);
    chip.els = { wrap, line, settings, controls, input: null };
    chip.controlsSig = null;             // fresh controls node: nothing is built yet
    // Legacy key (spec §7): migrated once into a prefill, never auto-identified.
    // Session.identity() loads storage (and migrates) first; either source wins.
    let prefill = "";
    try {
      const had = S.identity();
      let pending = typeof S.pendingUsername === "function" ? S.pendingUsername() : null;
      if (!pending && typeof S.migrateLegacy === "function" && typeof localStorage !== "undefined") pending = S.migrateLegacy(localStorage);
      if (!had && pending) prefill = pending;
    } catch (_) {}
    chip.prefill = prefill;
    chip.unsub = S.onChange(() => renderChip());
    renderChip();
    startTicker();
    maybeReady();
  }

  // `league` is a registry slug or a Sleeper league id (leagueNavigation
  // passes the slug for a registered league, the id otherwise).
  function mountLeagueContext(league) {
    if (!document.createElement || document.getElementById("league-context")) return;
    const p = leagueParam(league);
    const slug = p.slug, current = slug !== null ? slug : p.raw;
    const panel=document.createElement("section"), label=document.createElement("label"), select=document.createElement("select");
    panel.id="league-context"; panel.className="league-links";
    label.textContent="League "; select.setAttribute("aria-label","Selected league");
    for(const [value,name] of LEAGUES) {
      const option=document.createElement("option"); option.value=value; option.textContent=name; select.append(option);
    }
    // An unregistered Sleeper league is offered by its id beside the registry.
    if (slug === null && p.leagueId) {
      const option=document.createElement("option"); option.value=p.leagueId; option.textContent=`Sleeper league ${p.leagueId}`; select.append(option);
    }
    select.value=current;
    select.addEventListener("change",()=>{const url=new URL(location.href);url.searchParams.set("league",select.value);location.assign(url.href);});
    label.append(select);panel.append(label);
    mountChip(panel, current);
    const note=document.createElement("p");
    note.textContent=slug==="espnfam"?"ESPN: draft board supported; live in-season tools are not connected yet."
      :slug===null?`In-season tools read this league's live Sleeper settings. ${DRAFT_ONLY}`
      :"Draft board, weekly/start-sit, waiver research and in-season trade scenarios use this league. Pre-draft trade values remain Gabagool only. No password needed.";
    panel.append(note);
    // The connect page already IS "Find my Sleeper leagues" -- a link back to
    // itself from its own league panel would be a dead, redundant nav entry.
    if (!/\/connect\.html$/.test(location.pathname)) {
      const connect=document.createElement("a");
      const connectUrl=new URL("connect.html", location.href);
      connectUrl.searchParams.set("league", current);
      connect.href=connectUrl.href; connect.textContent="Find my Sleeper leagues";
      panel.append(connect);
    }
    document.querySelector("main")?.prepend(panel);
  }

  // An invalid URL must never be treated as a request for the default league:
  // callers still get an error below and therefore cannot load league advice.
  // This panel only gives the visitor an explicit, safe way back to a supported
  // league while retaining the page (and any non-league query parameters).
  function mountInvalidLeagueRecovery(slug) {
    if (!document.createElement || document.getElementById("league-recovery")) return;
    const panel = document.createElement("section");
    const heading = document.createElement("h2");
    const note = document.createElement("p");
    const list = document.createElement("ul");
    panel.id = "league-recovery";
    panel.className = "league-links";
    heading.textContent = "Choose a supported league";
    note.textContent = `"${slug}" is not a supported league. No league data was loaded.`;
    panel.append(heading, note);
    for (const [value, name] of LEAGUES) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      const url = new URL(location.href);
      url.searchParams.set("league", value);
      link.href = url.href;
      link.textContent = name;
      item.append(link);
      list.append(item);
    }
    panel.append(list);
    const main = document.querySelector("main");
    if (main?.prepend) main.prepend(panel);
    else document.body?.append(panel);
  }

  // A draft-side page given an unregistered league id: say so by name and
  // offer THIS league's in-season pages -- never another league's board.
  function mountDraftBoundary(leagueId) {
    if (!document.createElement || document.getElementById("draft-boundary")) return;
    const panel = document.createElement("section");
    const note = document.createElement("p");
    const list = document.createElement("ul");
    panel.id = "draft-boundary";
    panel.className = "league-links";
    note.textContent = DRAFT_ONLY;
    panel.append(note);
    for (const [page, name] of [["weekly.html", "Weekly / start-sit"], ["waivers.html", "Waiver research"], ["trade.html", "In-season trade scenarios"]]) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      const url = new URL(page, location.href);
      url.searchParams.set("league", leagueId);
      link.href = url.href;
      link.textContent = name;
      item.append(link);
      list.append(item);
    }
    panel.append(list);
    const main = document.querySelector("main");
    if (main?.prepend) main.prepend(panel);
    else document.body?.append(panel);
  }

  // `opts.inSeason`: the page has resolved itself to in-season mode (trade.html
  // decides its mode from the live league, so it is not in IN_SEASON_HOME);
  // its in-season links then carry the league id like weekly/waivers. Calling
  // again only rewrites the masthead: the league panel mounts once.
  function leagueNavigation(opts) {
    // Keep the choice in each tab's URL, including the trip back from another
    // page. A shared stored preference would let one league change the other.
    const p = leagueParam();
    if (p.invalid) {
      mountInvalidLeagueRecovery(p.raw);
      throw new Error(`Unknown league "${p.raw}". Choose gabagool, fam or espnfam.`);
    }
    const here = pageOf(location.href);
    // Between in-season pages the canonical parameter is the league id: on
    // an in-season page, or wherever the URL already names the league by id.
    // Draft and neutral destinations keep the registry slug when there is one.
    const idContext = p.leagueId !== null && (p.isId || IN_SEASON_HOME.has(here) || !!(opts && opts.inSeason));
    const slug = p.slug;
    // The masthead is rewritten FIRST, even on a page about to refuse: a
    // bare href would resolve to the default league -- a substitution.
    rewriteMasthead(p, idContext);
    // The draft board exists only for registered leagues (spec 5.4).
    if (slug === null && DRAFT_HOME.has(here)) {
      mountDraftBoundary(p.leagueId);
      throw new Error(DRAFT_ONLY);
    }
    mountLeagueContext(slug !== null ? slug : p.leagueId);
    // The registry slug for a registered league (a registered id included),
    // null for any other Sleeper league.
    return slug;
  }

  function rewriteMasthead(p, idContext) {
    const slug = p.slug;
    // Suffixes are stripped before recompute so a second call against the
    // SAME <a> elements (repeated init) stays deterministic instead of
    // stacking " · not connected · not connected". " · Gabagool only" is the
    // retired trade label, still stripped so stale markup cannot keep it.
    const SUFFIXES = [" · Gabagool only", " · not connected"];
    const tools = p.entry ? p.entry.tools : ID_TOOLS;
    document.querySelectorAll(".masthead nav a").forEach(link => {
      const url = new URL(link.getAttribute("href"), location.href);
      const dest = url.pathname.split("/").pop();
      // The URL keeps THIS tab's league -- clicking trade or an ESPN
      // weekly/waivers link must never silently switch you to another
      // league just because that's the only one the destination supports.
      // An unregistered id keeps its id even toward the draft board, which
      // then refuses it by name.
      url.searchParams.set("league", IN_SEASON_DEST.has(dest) && idContext ? p.leagueId : slug !== null ? slug : p.leagueId);
      link.href = url.href;
      let label = link.textContent;
      for (const suf of SUFFIXES) if (label.endsWith(suf)) label = label.slice(0, -suf.length);
      // Trade, weekly and waivers are live Sleeper tools; the registry says
      // which league connects which (today: Gabagool and FAM both, ESPN
      // none). The href above still points at THIS league, so the label says
      // the tool is not connected rather than implying a click will switch
      // leagues.
      const tool = TOOL_FOR_PAGE[dest];
      if (tool && !tools[tool]) label += " · not connected";
      link.textContent = label;
    });
  }

  function stampHeader(payload) {
    const el = document.querySelector(".stamp");
    if (el) el.textContent =
      `data through ${payload.data_through} · generated ${payload.generated_at} · model: ${payload.model || payload.site_model || "—"}`;
    staleBanner(payload.generated_at);
  }

  function staleBanner(generatedAt) {
    const ageDays = (Date.now() - Date.parse(generatedAt)) / 86400000;
    if (!(ageDays > 8)) return;
    const div = document.createElement("div");
    div.className = "stale";
    div.textContent =
      `Heads up: this data was generated ${Math.floor(ageDays)} days ago and may be out of date.`;
    document.body.insertBefore(div, document.querySelector("main"));
  }

  function fmt(x, digits = 1) {
    return (x === null || x === undefined) ? "—" : x.toFixed(digits);
  }

  function makeSortable(table, rows, render) {
    // rows: array of data objects; render(rows) redraws tbody.
    // `keep` re-applies the CURRENT direction instead of toggling it -- used
    // when the scoring lens changes under a column that is already sorted.
    const sortBy = (th, keep) => {
      const key = th.dataset.key;
      const ariaSort = th.getAttribute("aria-sort");
      // Columns marked data-asc (lower-is-better: ECR, ADP, positional rank)
      // start ascending on their first click; everything else starts
      // descending, as before. Once a direction is set, clicks just toggle it.
      const ascFirst = th.hasAttribute("data-asc");
      const desc = keep ? ariaSort !== "ascending"
        : ariaSort === "descending" ? false
        : ariaSort === "ascending" ? true
        : !ascFirst;
      table.querySelectorAll("thead th").forEach(o => o.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", desc ? "descending" : "ascending");
      const get = o => key.split(".").reduce((x, k) => (x ?? {})[k], o);
      // Missing means "no data", not "worst possible" or "best possible" --
      // nulls/undefined always sink to the bottom, in BOTH sort directions.
      rows.sort((a, b) => {
        const av = get(a), bv = get(b);
        const an = av === null || av === undefined;
        const bn = bv === null || bv === undefined;
        if (an && bn) return 0;
        if (an) return 1;
        if (bn) return -1;
        return (av < bv ? -1 : av > bv ? 1 : 0) * (desc ? -1 : 1);
      });
      table.dataset.sortKey = key;
      table.dataset.sortDesc = String(desc);
      render(rows);
    };
    table.querySelectorAll("thead th[data-key]").forEach(th => {
      th.setAttribute("tabindex", "0");
      th.addEventListener("click", () => sortBy(th));
      th.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          sortBy(th);
        } else if (e.key === " ") {
          e.preventDefault();               // don't let the page scroll
          sortBy(th);
        }
      });
    });
    // Re-apply the active sort in place. Called when the scoring lens changes
    // under an already-sorted column.
    table._resort = () => {
      const th = table.querySelector("thead th[aria-sort]");
      if (th) sortBy(th, true);
    };
    // Honour a sort DECLARED in the markup. A <th aria-sort="descending"> is a
    // promise about the order; without applying it the rows keep whatever order
    // the payload happened to arrive in, which is a different ruleset's. The
    // weekly payload arrives PPR-sorted, so the page opened showing league
    // points in PPR order -- the same wrong-order bug as the lens toggle, just
    // at load rather than on click.
    table._resort();
  }

  /* Scoring-lens toggle, shared by the draft board and the weekly page.

     The lenses genuinely DISAGREE: this project's league scores passing TDs at
     six rather than four, which moves a quarterback's season by ~48 points. A
     table that displays one lens while sorting by another therefore shows a
     visibly wrong order, not a rounding difference -- so every lens-dependent
     column carries `data-key-lens` (e.g. "points.{lens}.p50") and is retargeted
     here, then the active sort is re-applied.

     Buttons are built from the lenses the PAYLOAD actually carries, so a file
     generated before a lens existed renders without a dead button. */
  const LENS_LABEL = { league: "MY LEAGUE", ppr: "PPR", half_ppr: "HALF-PPR",
                       standard: "STANDARD" };

  function scoringFilter(wrap, present, onChange) {
    const lenses = Object.keys(LENS_LABEL).filter(l => present.includes(l));
    const initial = lenses[0];
    const table = document.querySelector("table");
    const apply = lens => {
      document.querySelectorAll("thead th[data-key-lens]").forEach(th => {
        th.dataset.key = th.dataset.keyLens.replace("{lens}", lens);
      });
      onChange(lens);
      if (table && table._resort) table._resort();
    };
    lenses.forEach(lens => {
      const b = document.createElement("button");
      b.textContent = LENS_LABEL[lens];
      b.setAttribute("aria-pressed", lens === initial ? "true" : "false");
      b.addEventListener("click", () => {
        wrap.querySelectorAll("button").forEach(o => o.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        apply(lens);
      });
      wrap.appendChild(b);
    });
    // Point the columns at the default lens before the first render.
    document.querySelectorAll("thead th[data-key-lens]").forEach(th => {
      th.dataset.key = th.dataset.keyLens.replace("{lens}", initial);
    });
    return initial;
  }

  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ESC_MAP[c]);
  }

  function posFilter(container, onChange) {
    const positions = ["ALL", "QB", "RB", "WR", "TE"];
    positions.forEach(p => {
      const b = document.createElement("button");
      b.textContent = p;
      b.setAttribute("aria-pressed", p === "ALL" ? "true" : "false");
      b.addEventListener("click", () => {
        container.querySelectorAll("button").forEach(o => o.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        onChange(p);
      });
      container.appendChild(b);
    });
  }

  return { POS_CLASS, REGISTRY, registryFor, loadJSON, leagueDataPath, leagueNavigation, stampHeader, staleBanner,
           fmt, makeSortable, posFilter, esc, scoringFilter, LENS_LABEL,
           setBoard, setLeague, inSeasonLeague, mountLeagueContext, mountDraftBoundary, DRAFT_ONLY,
           chip: { refresh: chipRefresh, onRefresh, render: renderChip },
           _session: stub => { sessionOverride = stub || null; } };
});
