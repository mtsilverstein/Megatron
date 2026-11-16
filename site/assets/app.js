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
  // The supported-league table (design spec §3), filled at RUNTIME only (owner
  // decision 2026-11-07: no visitor is given anyone's league by default). A
  // page that loads a draft board registers that board's own league block
  // (FC.setBoard): slug, platform, live league id, a scoring-format label --
  // never a league name -- and which tools it connects. So no league id or
  // league name lives in the site's code, and the table is empty on every
  // page that has not loaded a board. session.js reads the same live array.
  const REGISTRY = [];
  const registryFor = slug => REGISTRY.find(r => r.slug === slug) || null;

  // ---- league selection by Sleeper id (any-league spec 5.1, 5.4) ----------
  // In-season pages take ANY Sleeper league id. Draft-side pages (the board,
  // its keeper panel, pre-draft trade) read only a published board: an id
  // there is refused by name -- never a substituted league.
  const DRAFT_ONLY = "The draft board is not built per league; the 2026 board is archived.";
  const OLD_NAME = "This link uses an old league name. Connect your Sleeper league to continue.";
  const NOT_AN_ID = raw => `"${raw}" is not a Sleeper league id. Connect your Sleeper league to continue.`;
  const LAST_LEAGUE_KEY = "megatron:lastLeague";
  const FORGOT_KEY = "megatron:forgotLeague";   // sessionStorage: one-shot note after a remembered league was dropped
  const FORGOTTEN = "The league this browser remembered is no longer available. Connect your Sleeper league to continue.";
  // A load failure that says the league itself is gone or out of season (not
  // a network error, timeout or 5xx, where a retry may succeed).
  const DEFINITIVE_LOAD_FAILURE = /^HTTP 404$|^Sleeper has no league with id |^This league is from the .+ season; projections are for /;
  let openedFromMemory = null;   // the id pageLeague took from memory, if any
  // Destinations whose league parameter is the id between in-season pages.
  const IN_SEASON_DEST = new Set(["weekly.html", "waivers.html", "trade.html"]);
  // Pages that resolve a league for their tools: the URL's id, else the
  // remembered one, else none (pageLeague).
  const LEAGUE_PAGES = IN_SEASON_DEST;
  // Pages that exist only for a published board.
  const DRAFT_HOME = new Set(["index.html", ""]);
  const isLeagueId = v => typeof v === "string" && /^\d+$/.test(v);
  // A name-shaped value: what the site's old links put in ?league= (the
  // league's short name), and what a board file is named by.
  const isName = v => typeof v === "string" && /^[a-z][a-z0-9_-]{0,39}$/i.test(v);
  const pageOf = href => new URL(href, "https://x.invalid/").pathname.split("/").pop();
  // The ONE reading of ?league= (or of `value`). No parameter names no league;
  // a registered board's slug is its registry row; a numeric id is a Sleeper
  // league; a name-shaped value is an old link's league name (`legacy`);
  // anything else is `invalid`. Nothing here ever defaults to a league.
  function leagueParam(value) {
    const raw = value === undefined ? new URLSearchParams(location.search).get("league") : value;
    const base = { raw: "", none: false, slug: null, entry: null, leagueId: null, isId: false, legacy: false, invalid: false };
    if (raw === null || raw === undefined || raw === "") return { ...base, none: true };
    const v = String(raw);
    const bySlug = registryFor(v);
    if (bySlug) return { ...base, raw: v, slug: v, entry: bySlug, leagueId: bySlug.platform === "sleeper" ? bySlug.leagueId : null };
    if (isLeagueId(v)) return { ...base, raw: v, leagueId: v, isId: true };
    return { ...base, raw: v, legacy: isName(v), invalid: !isName(v) };
  }

  // The league this browser opened last (per-browser convenience; forget()
  // removes it). Only the id is stored. A missing or blocked store, or a
  // value that is not an id, is "no league"; nothing here throws.
  function rememberedLeague() {
    try {
      const v = typeof localStorage !== "undefined" && localStorage ? localStorage.getItem(LAST_LEAGUE_KEY) : null;
      return isLeagueId(v) ? v : null;
    } catch (_) { return null; }
  }
  function forgetRememberedLeague(id) {
    try { if (typeof localStorage !== "undefined" && localStorage && localStorage.getItem(LAST_LEAGUE_KEY) === id) localStorage.removeItem(LAST_LEAGUE_KEY); } catch (_) {}
    if (openedFromMemory !== id) return;
    // The page was opened from memory, not by a link: reopen it league-free
    // (its connect prompt) with a one-line note.
    try {
      if (typeof sessionStorage !== "undefined" && sessionStorage) sessionStorage.setItem(FORGOT_KEY, "1");
      const url = new URL(location.href);
      url.searchParams.delete("league");
      if (typeof location.replace === "function") location.replace(url.href);
    } catch (_) {}
  }
  function takeForgottenNote() {
    try {
      if (typeof sessionStorage === "undefined" || !sessionStorage || sessionStorage.getItem(FORGOT_KEY) === null) return false;
      sessionStorage.removeItem(FORGOT_KEY);
      return true;
    } catch (_) { return false; }
  }
  function rememberLeague(id) {
    try { if (isLeagueId(id) && typeof localStorage !== "undefined" && localStorage) localStorage.setItem(LAST_LEAGUE_KEY, id); } catch (_) {}
  }
  // The in-season pages' league, in order: the URL's ?league=<id>; else, with
  // NO parameter at all, the id this browser remembered -- written into the
  // URL with replaceState so the page is shareable and reloads identically;
  // else no league. An old link's league name (or any non-id) names no
  // league, and the remembered id is NOT used for it: that would substitute
  // a league for the one the link meant. Other pages read the URL only.
  function pageLeague() {
    const p = leagueParam();
    if (!LEAGUE_PAGES.has(pageOf(location.href))) return p;
    // On an in-season page a board slug is an old name too: no board is registered here.
    if (p.entry) return { ...p, slug: null, entry: null, leagueId: null, legacy: true };
    if (!p.none) return p;
    const id = rememberedLeague();
    if (!id) return p;
    try {
      const url = new URL(location.href);
      url.searchParams.set("league", id);
      if (typeof history !== "undefined" && history && typeof history.replaceState === "function") history.replaceState(history.state === undefined ? null : history.state, "", url.href);
    } catch (_) { /* the page still opens the league; only the URL is not rewritten */ }
    openedFromMemory = id;
    return { ...leagueParam(id), remembered: true };
  }
  // The in-season pages' league id, or null: no league (league-free pages).
  function inSeasonLeague() {
    const p = pageLeague();
    return p.isId ? { leagueId: p.leagueId } : null;
  }

  async function loadJSON(path) {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  // ---- published draft boards (the archive) ---------------------------------
  // A board's scoring-format label from its OWN league block, never its name:
  // "12-team PPR, 6-pt pass TD".
  function boardFormatLabel(league) {
    const lg = league && typeof league === "object" ? league : {};
    const w = lg.sleeper_scoring && typeof lg.sleeper_scoring === "object" ? lg.sleeper_scoring : {};
    const num = v => typeof v === "number" && Number.isFinite(v) ? v : null;
    const rec = num(w.rec), td = num(w.pass_td);
    const ppr = rec === null || rec === 0 ? "standard" : rec === 1 ? "PPR" : rec === 0.5 ? "half-PPR" : `${rec}-pt PPR`;
    const text = `${Number.isInteger(lg.teams) && lg.teams > 0 ? `${lg.teams}-team ` : ""}${ppr}${td === null ? "" : `, ${td}-pt pass TD`}`;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  // Spec 5.1, anonymous path: bare digits, or a sleeper.com URL containing
  // /leagues/<digits> (any trailing path or query), gives the league id;
  // anything else is null. The host must be sleeper.com or a subdomain of it.
  function parseLeagueInput(text) {
    const t = String(text === null || text === undefined ? "" : text).trim();
    if (/^\d+$/.test(t)) return t;
    let url;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`); } catch (_) { return null; }
    const host = url.hostname.toLowerCase();
    if (host !== "sleeper.com" && !host.endsWith(".sleeper.com")) return null;
    const m = /^\/leagues\/(\d+)(?:\/|$)/.exec(url.pathname);
    return m ? m[1] : null;
  }
  // Short format line for a live Sleeper league object; unknown parts are omitted.
  function leagueFormatLabel(league) {
    if (!league || typeof league !== "object") return "";
    const parts = [];
    const n = league.total_rosters;
    if (Number.isInteger(n) && n > 0) parts.push(`${n} teams`);
    const sc = league.scoring_settings && typeof league.scoring_settings === "object" ? league.scoring_settings : {};
    const rec = typeof sc.rec === "number" && Number.isFinite(sc.rec) ? sc.rec : 0;
    parts.push(rec === 1 ? "PPR" : rec === 0.5 ? "Half-PPR" : rec === 0 ? "Standard" : `${rec}-pt PPR`);
    if (Array.isArray(league.roster_positions) && league.roster_positions.includes("SUPER_FLEX")) parts.push("Superflex");
    const wt = league.settings && league.settings.waiver_type;
    if (wt === 2) parts.push("FAAB"); else if (wt === 0) parts.push("Rolling waivers");
    return parts.join(" · ");
  }
  // The registry row a published board stands for, built from the board
  // itself. A board built before `platform` existed is a Sleeper board.
  function boardEntry(board) {
    const lg = board && board.league;
    if (!lg || !isName(lg.slug)) return null;
    const platform = lg.platform || "sleeper", sleeper = platform === "sleeper";
    const keepers = typeof lg.keeper_rules === "string" && lg.keeper_rules !== "";
    const label = sleeper ? boardFormatLabel(lg) : `${boardFormatLabel(lg)} · ${String(platform).toUpperCase()} draft board only`;
    return Object.freeze({
      slug: lg.slug, platform, leagueId: lg.league_id === undefined || lg.league_id === null ? null : String(lg.league_id), label,
      tools: Object.freeze({ draft: true, keepers, trade: keepers && sleeper, waivers: sleeper, startsit: sleeper }),
    });
  }
  function registerBoard(board) {
    const e = boardEntry(board);
    if (!e) return null;
    const i = REGISTRY.findIndex(r => r.slug === e.slug);
    if (i >= 0) REGISTRY.splice(i, 1, e); else REGISTRY.push(e);
    return e;
  }
  // The board a draft-side page shows: no name is the default file; a name
  // (an old link's league name) is that board's file -- the default board
  // keeps its bare file name, so a name it answers to is found there too.
  const DEFAULT_BOARD = "data/draft.json";
  async function loadBoard(name, load) {
    load = load || loadJSON;
    if (name === null || name === undefined || name === "") return load(DEFAULT_BOARD);
    if (!isName(name)) throw new Error("This link names no published draft board.");
    let board;
    try { board = await load(`data/draft-${name}.json`); }
    catch (e) {
      if (!/HTTP 404/.test(String(e && e.message))) throw e;
      board = await load(DEFAULT_BOARD);
    }
    if (!board || !board.league || board.league.slug !== name) throw new Error("This link names no published draft board.");
    return board;
  }
  // The board is ARCHIVED once the season it was built for is under way: the
  // league-neutral weekly batch loads and is for the board's season. A failed
  // or malformed weekly load is "not archived" -- the board fails open to its
  // usual page, never to an error.
  async function boardArchived(board, load) {
    try {
      const weekly = await (load || loadJSON)("data/neutral/weekly.json");
      const season = Number(board && board.season);
      return Number.isFinite(season) && !!weekly && Number(weekly.season) === season;
    } catch (_) { return false; }
  }
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function archivedText(board) {
    const t = Date.parse(board && board.generated_at);
    const d = new Date(t);
    const date = Number.isFinite(t) ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}` : String(board && board.generated_at);
    return `Archived: the ${board && board.season} preseason board as published on ${date}. The drafts are over; it stays as a record of what the model projected before the season.`;
  }

  // ---- the league bar's chip (league connect flow spec §5) ----------------
  // The chip lives INSIDE #league-context and is the one place a visitor
  // connects: one box takes a Sleeper username or a league link. It reads
  // Session (site/assets/session.js) lazily so this file still loads under
  // node and in a page that has not included session.js (then the panel
  // renders without a chip, as before). Rendering is gated on
  // Session.bundle()/myRosterStatus/error(), never on state() === "error"
  // alone: a stale identity error can coexist with a valid committed bundle.
  // Superseded rejections (err.superseded) are swallowed, never displayed.
  // "Bar pages" are the in-season tools and About (the id path, or no league);
  // "registry pages" are the board and pre-draft trade (FC.setBoard).
  const BOX_EMPTY = "Enter your Sleeper username or paste a sleeper.com league link.";
  const BAD_LEAGUE = "Enter a Sleeper league id or a sleeper.com league link.";
  const NAME_ONLY = "Enter your Sleeper username.";
  let sessionOverride = null;
  const session = () => {
    if (sessionOverride) return sessionOverride;
    if (typeof Session !== "undefined" && Session) return Session;
    if (typeof window !== "undefined" && window && window.Session) return window.Session;
    return null;
  };
  const swallow = () => {};   // identify/ready failures surface via Session.error(); superseded ones never
  // `pageLeague`: the in-season page's league id from its URL, open before
  // FC.setLeague loads it. `changing`: the box is revealed in place ("Not
  // you?" and the anonymous find buttons). `autoOpen`: one-shot, set only by
  // a username submitted with no league open -- the account's only league
  // then opens; a page load never sets it.
  const chip = {
    slug: null, board: null, leagueId: null, leagueOpts: null, readyFor: null, els: null, unsub: null, ticker: null,
    lastName: "", changing: false, notice: "", prefill: "", controlsSig: null, pageLeague: null, autoOpen: false,
  };
  function chipEntry() { return registryFor(chip.slug); }
  function isEspn() { const e = chipEntry(); return !!e && e.platform !== "sleeper"; }
  const registryPage = () => !!chipEntry();
  const leagueOpen = () => !registryPage() && !!(chip.leagueId || chip.pageLeague);
  // Where a league opens: this page when it is an in-season tool, else Weekly.
  function leagueHref(id) {
    const url = LEAGUE_PAGES.has(pageOf(location.href)) ? new URL(location.href) : new URL("weekly.html", location.href);
    url.searchParams.set("league", id);
    return url.href;
  }
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
      // A league that loaded under the in-season season contract is the one
      // this browser remembers (pageLeague). A next-season pre-draft league
      // (trade.html's exempt mode resolution) is not: the in-season pages
      // would refuse it.
      Promise.resolve().then(() => S.ready({ ...extra, leagueId })).then(b => {
        if (b && b.league && b.state && String(b.league.league_id) === leagueId && String(b.league.season) === String(b.state.season)) rememberLeague(leagueId);
      }).catch(err => {
        if (err && !err.superseded && DEFINITIVE_LOAD_FAILURE.test(String(err.message || ""))) forgetRememberedLeague(leagueId);
      });
      return;
    }
    if (!chip.slug || !chip.board || isEspn()) return;
    if (!S.identity()) return;
    if (S.bundle() && chip.readyFor === chip.board) return;
    chip.readyFor = chip.board;
    const slug = chip.slug, board = chip.board;   // captured now: a later mount must not retarget this load
    Promise.resolve().then(() => S.ready({ slug, board })).catch(swallow);
  }
  // A board page (and trade.html's pre-draft mode) hands the chip its board:
  // the board's own league block is registered (registerBoard) and becomes
  // the chip's league, so the registry path loads THIS board's league.
  function setBoard(board) {
    const entry = board ? registerBoard(board) : null;
    if (entry) chip.slug = entry.slug;
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
  // `lastName` is the name being identified: Retry re-runs it, and while no
  // account is known it marks an error as the identify's own.
  function chipIdentify(name) {
    const S = session();
    name = String(name || "").trim();
    if (!S || !name) return;
    chip.lastName = name; chip.changing = false; chip.notice = "";
    S.identify(name).then(() => maybeReady(), e => {
      if (!(e && e.superseded)) chip.autoOpen = false;   // a newer identify owns the flag
    });
  }
  // The box's submit (spec §5.1). Bar pages take a league link or id (opens
  // it, no Sleeper call, the account kept) or a username (identified in
  // place); link-shaped text that is no Sleeper league is refused, never
  // looked up as a username. Registry pages take a username only.
  function submitBox(text) {
    const t = String(text || "").trim();
    const registry = registryPage();
    const refuse = msg => { chip.notice = msg; renderChip(); };
    if (!t) return refuse(registry ? NAME_ONLY : BOX_EMPTY);
    const id = registry ? null : parseLeagueInput(t);
    if (id) { location.assign(leagueHref(id)); return; }
    if (/[/.:]/.test(t)) return refuse(registry ? NAME_ONLY : BAD_LEAGUE);
    if (!registry && !leagueOpen()) chip.autoOpen = true;
    chipIdentify(t);
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
  // A control's caption read by assistive tech; the placeholder or the line
  // beside it already says the same on screen.
  function hiddenCaption(text) {
    const s = document.createElement("span");
    s.className = "visually-hidden"; s.textContent = text;
    return s;
  }
  // The one box: the page's only username / league-link input (spec §5.1).
  function identifyForm(prefill) {
    const text = registryPage() ? "Sleeper username" : "Sleeper username or league link";
    const form = document.createElement("form");
    form.className = "session-form";
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "text"; input.id = "session-user"; input.autocomplete = "off";   // not a login field
    input.setAttribute("spellcheck", "false"); input.placeholder = text;
    input.value = prefill || "";
    label.append(hiddenCaption(text), input);
    const use = document.createElement("button");
    use.type = "submit"; use.id = "session-use"; use.textContent = "Connect";
    form.append(label, use);
    form.addEventListener("submit", e => { if (e && e.preventDefault) e.preventDefault(); submitBox(input.value); });
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
    label.append(hiddenCaption("Team"));
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
  const leagueName = l => l.name || `League ${l.league_id}`;
  // The leagues box's own sentence (also what the live region announces).
  function leaguesSentence(who) {
    if (picker.status === "error") return `Unable to load your leagues: ${picker.error}`;
    if (picker.status === "ready" && !picker.leagues.length) return `No ${picker.season} Sleeper leagues for ${who}. Paste a league link instead.`;
    if (picker.status === "ready") return `Your ${picker.season} leagues: ${picker.leagues.length} found.`;
    return "Finding your leagues…";
  }
  // The account's current-season leagues, in the bar while no league is open
  // (spec §5.2): finding, the failure with Retry, none, or one row per league
  // (its name links to it on this page or Weekly; its format is one short line).
  function leaguesBox(who) {
    const box = document.createElement("div");
    box.id = "session-leagues"; box.className = "session-leagues";
    const para = text => { const p = document.createElement("p"); p.textContent = text; return p; };
    if (picker.status === "error") {
      box.append(para(leaguesSentence(who)),
        chipButton("session-leagues-retry", "Retry", () => { pickerLeagues(true); renderChip(); }));
    } else if (picker.status === "ready" && !picker.leagues.length) {
      box.append(para(leaguesSentence(who)));
    } else if (picker.status === "ready") {
      const list = document.createElement("ul");
      for (const l of picker.leagues) {
        const item = document.createElement("li"), link = document.createElement("a"), format = document.createElement("span");
        link.href = leagueHref(String(l.league_id)); link.textContent = leagueName(l);
        format.className = "league-format"; format.textContent = leagueFormatLabel(l);
        item.append(link, format);
        list.append(item);
      }
      box.append(para(`Your ${picker.season} leagues`), list);
    } else {
      box.append(para("Finding your leagues…"));
    }
    return box;
  }
  const leaguesSig = () => (picker.status === "ready" ? ["ready", picker.season, picker.leagues.map(l => [String(l.league_id), leagueName(l), leagueFormatLabel(l)])]
    : picker.status === "error" ? ["error", picker.error] : ["finding"]);
  // Called on every Session.onChange fire, on every chip action, on every
  // league-lookup result AND by the 1 s ticker. The line (Session.chipText,
  // whose age moves) and the notice are rewritten on every call; the controls
  // are rebuilt only when the state they are built from changes --
  // `controlsSig` names that state. A tick therefore never replaces the box
  // the visitor is typing into, and never steals keyboard focus from a button.
  // The states, in order, are the brief's table (league connect flow, task 3).
  function renderChip() {
    const S = session(), els = chip.els;
    if (!S || !els) return;
    const st = S.state(), err = S.error(), id = S.identity(), b = S.bundle(), entry = chipEntry();
    const now = Date.now(), refreshing = st === "refreshing";
    // Without a committed bundle the identity still gets a bundle-shaped view
    // so ESPN reads "name · label".
    const view = b || (id ? { identity: id, registry: entry } : null);
    const reveal = () => { chip.changing = true; chip.notice = ""; renderChip(); };
    const textButton = (btnId, text) => { const t = chipButton(btnId, text, reveal); t.className = "session-link"; return t; };
    const notYou = () => textButton("session-change", id ? "Not you?" : "Use my username");
    const forgetBtn = () => chipButton("session-forget", "Forget me on this device", () => {
      chip.changing = false; chip.notice = ""; chip.lastName = ""; chip.autoOpen = false; S.forget();
    });
    const refreshBtn = () => {
      const r = chipButton("session-refresh", "Refresh", () => { chipRefreshClick(); });
      if (refreshing) r.disabled = true;
      return r;
    };
    const heading = () => {
      const h = document.createElement("p"); h.id = "session-heading"; h.className = "session-heading";
      h.textContent = "Connect your Sleeper league"; return h;
    };
    const note = () => {
      const p = document.createElement("p"); p.id = "session-note"; p.className = "session-note";
      p.textContent = "No password. Read-only: nothing is changed in Sleeper."; return p;
    };
    // The team-to-view select's signature: the teams and the choice, so a
    // tick never rebuilds an open dropdown.
    const teamSig = () => [pickerTeams(S, b), b.viewedRosterId === undefined ? null : b.viewedRosterId];
    // `revealable`: the state offers "Not you?" or a find button, so the box
    // may open in place of its controls; a state that shows the box itself is not.
    let line, build, sig, revealable = true, leaguesLine = "";
    if (st === "identifying") {
      line = S.chipText(null, "identifying", now);
      build = () => []; sig = ["identifying"]; revealable = false;
    } else if (err && !id && !b && chip.lastName) {
      // The identify failed and no league is loaded: the box again, holding
      // the name that failed.
      line = S.chipText(null, "error", now, err);
      build = () => [identifyForm(chip.lastName)]; sig = ["failed", chip.lastName]; revealable = false;
    } else if (err) {
      line = S.chipText(view, "error", now, err);
      build = () => [chipButton("session-retry", "Retry", chipRetry), notYou()]; sig = ["error", !!id];
    } else if (registryPage()) {
      // The board and pre-draft trade (spec §5.6): a username only; no team
      // to view and no league list.
      if (st === "loadingLeague") {
        line = S.chipText(view, "loadingLeague", now);
        build = () => (id ? [notYou()] : []); sig = ["loading", !!id]; revealable = !!id;
      } else if (!id) {
        line = S.chipText(null, "anonymous", now);
        build = () => [identifyForm(chip.prefill)]; sig = ["registry", chip.prefill]; revealable = false;
      } else if (b && b.myRoster && !isEspn()) {
        line = S.chipText(b, st, now);
        build = () => [refreshBtn(), notYou()]; sig = ["owner", refreshing];
      } else {
        // ESPN (identity only), no unique roster here, or the league not read yet.
        line = S.chipText(b || { identity: id, registry: isEspn() ? entry : null }, st, now);
        build = () => [notYou()]; sig = ["account"];
      }
    } else if (leagueOpen()) {
      const idPath = idPathBundle(b);
      if (!idPath || st === "loadingLeague") {
        line = S.chipText(view, "loadingLeague", now);
        build = () => (id ? [notYou()] : []); sig = ["loading", !!id]; revealable = !!id;
      } else if (id && b.myRoster) {
        line = S.chipText(b, st, now);
        build = () => [refreshBtn(), notYou()]; sig = ["owner", refreshing];
      } else if (id) {
        line = S.chipText(b, st, now);
        build = () => [teamPicker(S, b), refreshBtn(), notYou()]; sig = ["noteam", teamSig(), refreshing];
      } else if (b.analysisRole === "viewer" && b.analysisRoster) {
        line = S.chipText(b, st, now);
        build = () => [teamPicker(S, b), refreshBtn(), textButton("session-find", "Use my username")]; sig = ["viewer", teamSig(), refreshing];
      } else {
        line = S.chipText(b, st, now);
        build = () => [teamPicker(S, b), textButton("session-find", "or find your team with your username")]; sig = ["choose", teamSig()];
      }
    } else if (!id) {
      line = "";
      build = () => [heading(), identifyForm(chip.prefill), note()]; sig = ["connect", chip.prefill]; revealable = false;
    } else {
      const who = id.displayName || id.username;
      line = S.chipText({ identity: id, registry: null }, st, now);
      if (picker.status === "ready" && !picker.leagues.length) {
        build = () => [leaguesBox(who), identifyForm(""), forgetBtn()]; sig = ["zero", leaguesSig(), who]; revealable = false;
      } else {
        build = () => [notYou(), leaguesBox(who)]; sig = ["leagues", leaguesSig(), who];
      }
      leaguesLine = leaguesSentence(who);
    }
    // The revealed box replaces the controls in place (the line stays): the
    // empty box, Cancel, and Forget when there is an account to forget.
    if (chip.changing && !revealable) chip.changing = false;
    if (chip.changing) {
      build = () => {
        const c = [identifyForm(""), chipButton("session-cancel", "Cancel", () => { chip.changing = false; chip.notice = ""; renderChip(); })];
        if (id) c.push(forgetBtn());
        return c;
      };
      sig = ["revealed", !!id];
      leaguesLine = "";
    }
    els.line.textContent = line;
    els.notice.textContent = chip.notice;
    const key = JSON.stringify(sig);
    const rebuilt = key !== chip.controlsSig;
    if (rebuilt) {
      // Focus: a rebuild that removes the control the visitor was on must not
      // drop them to <body>. Only when focus was inside the controls; a rebuild
      // the tools trigger while the visitor works elsewhere never moves it.
      const prior = typeof document !== "undefined" ? document.activeElement : null;
      const hadFocus = !!(prior && els.controls.contains && els.controls.contains(prior));
      chip.controlsSig = key;
      els.input = null;
      els.controls.replaceChildren(...build());
      if (els.panel && els.panel.setAttribute) {
        if (sig[0] === "connect") els.panel.setAttribute("aria-labelledby", "session-heading");
        else if (els.panel.removeAttribute) els.panel.removeAttribute("aria-labelledby");
      }
      if (hadFocus && !els.controls.contains(prior)) {
        const target = els.input || firstFocusable(els.controls) || els.line;
        if (target && typeof target.focus === "function") target.focus();
      }
    }
    // The one live region: written when the controls change or the notice
    // changes -- never by the 1 s ticker (the age in the line moves every second).
    if (rebuilt || chip.notice !== chip.statusNotice) {
      chip.statusNotice = chip.notice;
      if (els.status) els.status.textContent = chip.notice || [line, leaguesLine].filter(Boolean).join(" ");
    }
  }
  function firstFocusable(node) {
    for (const c of Array.from(node.children || [])) {
      const tag = String(c.tagName || "").toLowerCase();
      if ((tag === "button" || tag === "select" || tag === "a") && !c.disabled) return c;
      const inner = firstFocusable(c);
      if (inner) return inner;
    }
    return null;
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
  // `pageLeague`: the in-season page's league id from its URL (or null).
  // The notice (a refused box entry, a failed refresh) has its own node, so
  // showing it never rebuilds the controls -- the typed text survives.
  function mountChip(panel, slug, pageLeague) {
    const S = session();
    if (!S) return;
    chip.slug = slug; chip.pageLeague = pageLeague || null;
    chip.changing = false; chip.notice = ""; chip.lastName = ""; chip.autoOpen = false;
    if (chip.unsub) { try { chip.unsub(); } catch (_) {} chip.unsub = null; }
    const wrap = document.createElement("div"); wrap.id = "session-chip"; wrap.className = "session-chip";
    const line = document.createElement("span"); line.id = "session-text"; line.className = "session-text";
    line.setAttribute("tabindex", "-1");   // the last-resort focus target when a rebuild leaves no control
    const controls = document.createElement("div"); controls.className = "session-controls";
    const notice = document.createElement("span"); notice.className = "session-notice";
    wrap.append(line, controls, notice);
    const status = document.createElement("p"); status.id = "session-status"; status.className = "visually-hidden";
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    panel.append(wrap, status);
    chip.statusNotice = "";
    chip.els = { panel, wrap, line, controls, notice, status, input: null };
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
    chip.unsub = S.onChange(barSync);
    renderChip();
    startTicker();
    maybeReady();
  }

  // ---- the league picker and the account's leagues (owner decision 2026-11-07)
  // ONE lookup -- Session.leaguesFor for the visitor's own Sleeper identity,
  // re-read when the identity moves -- feeds both the League select (the open
  // league first, then the account's other current-season leagues) and, with
  // no league open, the bar's league list (spec §5.2). Never a hard-coded
  // list. Choosing one opens it on this page when this page is an in-season
  // tool, otherwise on Weekly. The select is rebuilt only when its options
  // change, so an open dropdown survives unrelated updates.
  const picker = { panel: null, select: null, label: null, name: null, current: null, currentText: "", forUser: null,
    leagues: null, season: "", status: "idle", error: "", gen: 0, sig: null, mode: null };
  function sleeperGet() {
    const Sl = typeof Sleeper !== "undefined" && Sleeper ? Sleeper : (typeof window !== "undefined" && window && window.Sleeper) || null;
    return Sl && typeof Sl.get === "function" ? path => Sl.get(path) : null;
  }
  // The league control: none with no league open; the League select once an
  // account is known; otherwise the open league's name as plain text. While
  // an identify is in flight the control stays as it was.
  function renderPicker() {
    const { panel, select, label, name } = picker;
    if (!select) return;
    const S = session(), b = S && S.bundle ? S.bundle() : null, id = S && S.identity ? S.identity() : null;
    const rows = (picker.leagues || []).map(l => [String(l.league_id), leagueName(l)]);
    const mine = rows.find(r => r[0] === picker.current);
    const loaded = picker.current && b && b.league && String(b.league.league_id) === picker.current && b.league.name ? b.league.name : null;
    const currentName = (mine && mine[1]) || loaded || picker.currentText;
    const identifying = !!(S && S.state && S.state() === "identifying");
    const mode = !picker.current ? null : identifying && picker.mode ? picker.mode : id ? "select" : "text";
    picker.mode = mode;
    label.hidden = mode !== "select";
    name.hidden = mode !== "text";
    name.textContent = mode === "text" ? currentName : "";
    panel.className = mode ? "league-links has-league" : "league-links";
    const opts = [];
    if (picker.current) opts.push([picker.current, currentName]);
    for (const r of rows) if (r[0] !== picker.current) opts.push(r);
    const sig = JSON.stringify(opts);
    if (sig === picker.sig) return;
    picker.sig = sig;
    select.replaceChildren(...opts.map(([value, text]) => {
      const o = document.createElement("option"); o.value = value; o.textContent = text; return o;
    }));
    select.value = picker.current || "";
  }
  // The visitor's current-season leagues, re-read when the identity moves
  // (`force`: the list's Retry). The season is the committed bundle's live
  // state, else the one this page read already, else /state/nfl. The result
  // or the failure is recorded for the list; a superseded lookup (another
  // account, a re-mount) records nothing. The one-shot autoOpen is spent on
  // the first result after the submit that set it.
  function pickerLeagues(force) {
    const S = session(), id = S && S.identity ? S.identity() : null, uid = id ? id.userId : null;
    if (!force && uid === picker.forUser) return;
    picker.forUser = uid; picker.leagues = null; picker.error = "";
    picker.status = uid && typeof S.leaguesFor === "function" ? "finding" : "idle";
    const gen = ++picker.gen;
    if (picker.status === "idle") return;
    const get = sleeperGet(), b = S.bundle ? S.bundle() : null;
    const known = b && b.state && b.state.season !== undefined && b.state.season !== null ? String(b.state.season) : picker.season;
    const seasonP = known ? Promise.resolve(known) : get ? get("/state/nfl").then(s => String((s && s.season) || "")) : Promise.resolve("");
    seasonP.then(season => {
      if (gen !== picker.gen) return null;
      if (!season) throw new Error("the NFL season could not be read.");
      picker.season = season;
      return S.leaguesFor(get ? { season, get } : { season });
    }).then(list => {
      if (gen !== picker.gen) return;
      if (!Array.isArray(list)) throw new Error("Sleeper returned a malformed league list.");
      const seen = new Set();
      picker.leagues = list.filter(l => {
        const lid = l && l.league_id !== undefined && l.league_id !== null ? String(l.league_id) : "";
        if (!isLeagueId(lid) || seen.has(lid)) return false;
        seen.add(lid); return true;
      });
      picker.status = "ready";
      const only = chip.autoOpen && picker.leagues.length === 1 && !leagueOpen() && !registryPage();
      chip.autoOpen = false;
      if (only) location.assign(leagueHref(String(picker.leagues[0].league_id)));
    }).catch(e => {
      if (gen !== picker.gen) return;
      picker.status = "error"; picker.error = String((e && e.message) || e);
      chip.autoOpen = false;
    }).then(() => { if (gen === picker.gen) { renderPicker(); renderChip(); } });
  }
  function barSync() { pickerLeagues(); renderPicker(); renderChip(); }

  // `league` is the open league: a Sleeper league id, a registered board's
  // slug (the board page), or nothing (a page with no league open). An id is
  // open only on an in-season page; About and the other pages show no league.
  function mountLeagueContext(league) {
    if (!document.createElement || document.getElementById("league-context")) return;
    const p = leagueParam(league === null || league === undefined ? "" : league);
    const entry = p.entry;
    const pageLeague = p.isId && LEAGUE_PAGES.has(pageOf(location.href)) ? p.leagueId : null;
    const current = entry ? entry.slug : pageLeague;
    const panel = document.createElement("section"), label = document.createElement("label"), select = document.createElement("select");
    const name = document.createElement("span");
    panel.id = "league-context"; panel.className = "league-links";
    select.setAttribute("aria-label", "Selected league");
    name.id = "league-name"; name.className = "league-name";
    Object.assign(picker, { panel, select, label, name, current, currentText: entry ? entry.label : current ? `Sleeper league ${current}` : "",
      forUser: undefined, leagues: null, season: "", status: "idle", error: "", sig: null, mode: null });
    picker.gen++;
    select.addEventListener("change", () => {
      const v = select.value;
      if (!v || v === picker.current) return;
      location.assign(leagueHref(v));
    });
    label.append(select);
    panel.append(label, name);
    renderPicker();
    mountChip(panel, current, pageLeague);
    barSync();
    // Registry pages keep their note (the board's; ESPN's "not connected").
    if (entry) {
      const note = document.createElement("p");
      note.textContent = entry.platform !== "sleeper"
        ? `${String(entry.platform).toUpperCase()}: draft board supported; live in-season tools are not connected yet.`
        : "This draft board's league. Live draft mode and keepers read your roster through your Sleeper username. No password needed.";
      panel.append(note);
    }
    document.querySelector("main")?.prepend(panel);
  }

  // An old link's league name (or any other non-id) on an in-season page
  // names no league: never a substituted one. The page opens with no league
  // (its connect prompt), and this note says why, with the way to connect.
  function mountLeagueNotice(p) {
    if (!document.createElement || document.getElementById("league-recovery")) return;
    const panel = document.createElement("section");
    const note = document.createElement("p");
    panel.id = "league-recovery";
    panel.className = "league-links";
    note.textContent = p.forgotten ? FORGOTTEN : p.legacy ? OLD_NAME : NOT_AN_ID(p.raw);
    panel.append(note);
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

  // Every page's league wiring: resolves the page's league (pageLeague),
  // rewrites the masthead, and mounts the league panel. Calling again only
  // rewrites the masthead: the panels mount once. Returns the registry slug
  // (null for a Sleeper id or no league) -- except on the board page, which
  // gets the board's name from the URL (null: the default board) and mounts
  // its league panel itself, once it knows whether the board is archived.
  function leagueNavigation() {
    const here = pageOf(location.href);
    const p = pageLeague();
    const onBoard = DRAFT_HOME.has(here);
    // The masthead is rewritten FIRST, even on a page about to refuse.
    rewriteMasthead(p, onBoard);
    if (onBoard) {
      // The board is not built per Sleeper league: an id is refused by name.
      if (p.isId) {
        mountDraftBoundary(p.leagueId);
        throw new Error(DRAFT_ONLY);
      }
      if (p.invalid) throw new Error("This link names no published draft board.");
      return p.entry ? p.slug : p.legacy ? p.raw : null;
    }
    mountLeagueContext(p.isId ? p.leagueId : null);
    if (LEAGUE_PAGES.has(here) && (p.legacy || p.invalid)) mountLeagueNotice(p);
    else if (LEAGUE_PAGES.has(here) && p.none && takeForgottenNote()) mountLeagueNotice({ ...p, forgotten: true });
    return p.slug;
  }

  // Masthead links keep THIS tab's league id between its pages, and name no
  // other: a page with no league links to pages with no league (each in-season
  // page then resolves its own: the remembered id, else none). The archived
  // board is not per league, so its link never carries an id -- only its own
  // link on the board page keeps the board shown there.
  function rewriteMasthead(p, onBoard) {
    const boardName = onBoard ? (p.entry ? p.slug : p.legacy ? p.raw : null) : null;
    document.querySelectorAll(".masthead nav a").forEach(link => {
      const url = new URL(link.getAttribute("href"), location.href);
      const dest = pageOf(url.href);
      url.searchParams.delete("league");
      if (DRAFT_HOME.has(dest)) { if (boardName) url.searchParams.set("league", boardName); }
      else if (p.isId) url.searchParams.set("league", p.leagueId);
      link.href = url.href;
    });
  }

  // `opts.archived`: the archived-board text, shown INSTEAD of the generic
  // stale banner (a finished preseason board is a record, not stale data).
  function stampHeader(payload, opts) {
    const el = document.querySelector(".stamp");
    if (el) el.textContent =
      `data through ${payload.data_through} · generated ${payload.generated_at} · model: ${payload.model || payload.site_model || "—"}`;
    if (opts && opts.archived) archivedBanner(opts.archived);
    else staleBanner(payload.generated_at);
  }

  function archivedBanner(text) {
    if (document.getElementById && document.getElementById("archived-banner")) return;
    const div = document.createElement("div");
    div.className = "archived";
    div.id = "archived-banner";
    div.textContent = text;
    document.body.insertBefore(div, document.querySelector("main"));
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

  function scoringFilter(wrap, present, onChange, leagueLabel) {
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
      b.textContent = lens === "league" && leagueLabel ? leagueLabel : LENS_LABEL[lens];
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

  // Test hook only (like _session): replace the runtime registry with
  // synthetic rows. No page calls it; pages register a board via setBoard.
  function _registry(entries) {
    REGISTRY.splice(0, REGISTRY.length,
      ...(entries || []).map(e => Object.freeze({ ...e, tools: Object.freeze({ ...(e.tools || {}) }) })));
  }

  return { POS_CLASS, REGISTRY, registryFor, loadJSON, leagueNavigation, stampHeader, staleBanner,
           fmt, makeSortable, posFilter, esc, scoringFilter, LENS_LABEL,
           setBoard, setLeague, inSeasonLeague, mountLeagueContext, mountDraftBoundary, DRAFT_ONLY, OLD_NAME, LAST_LEAGUE_KEY,
           boardFormatLabel, parseLeagueInput, leagueFormatLabel, boardEntry, loadBoard, boardArchived, archivedText,
           chip: { refresh: chipRefresh, onRefresh, render: renderChip },
           _session: stub => { sessionOverride = stub || null; }, _registry };
});
