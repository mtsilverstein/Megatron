/* Shared Sleeper session (design spec docs/superpowers/specs/2026-09-18-shared-
   sleeper-session-design.md §4). ONE place that owns who you are (a public
   Sleeper username -> user id), which supported league this document is on,
   and the committed league bundle every page reads from.

   Not a login: Sleeper's API is public and read-only; nothing here is a
   credential. Identity persists in localStorage; league/roster/catalog data
   are memory-only for this document and always fetched fresh.

   Invariants the fixture holds this file to:
   - the committed bundle is immutable; refresh() builds a NEW bundle and swaps
     it atomically or leaves the old one untouched (its timestamps included);
   - every async operation carries a generation token; a superseded result is
     discarded and fires nothing;
   - entering `identifying`/`loadingLeague` clears `myRoster` FIRST and fires
     onChange so account-derived surfaces disable before the network trip;
   - every Sleeper call goes through Sleeper.get (cache-busted, no-store, 4 s
     abort); `Sleeper` is resolved lazily so this module loads under node;
   - storage that throws degrades to a memory-only identity; corrupt JSON is
     anonymous; nothing here ever throws because of storage.

   Two ways in (any-league spec 5.1). ready({slug, board}) is the draft
   pages' registry path, unchanged: a registry entry and a static board whose
   league id the live league must match. ready({leagueId}) is the in-season
   path for ANY Sleeper league: a synthetic entry {slug: null, platform:
   "sleeper", leagueId, tools: {startsit, waivers, trade}}, no board, no
   identity required (an anonymous visitor may load any league read-only). It
   refuses a league Sleeper does not know (`Sleeper has no league with id
   {id}.`) and a league from another season than live /state/nfl (`This league
   is from the {season} season; projections are for {current}.`), on load and
   on every refresh. One opt-in exception (spec 5.4): ready({leagueId,
   preDraftAnySeason: true}) -- trade.html resolving its mode -- exempts a
   league whose live status is `pre_draft` from the season check (the
   registered pre-draft route validates its own board/league afterwards);
   every other status, and every page that does not opt in, keeps it.

   Live settings (spec 5.2): every ready() AND every refresh() re-reads
   /league/<id>, whatever the scope -- scoring, slots, status and season are
   never reused from an earlier fetch. `leagueFetchedAt` is the moment that
   read resolved. Users are re-read on a "league"-scope refresh only.

   Whose roster is analysed. `myRoster` is ONLY ever the exact owner/co-owner
   match for the identity -- never set from a view. `viewedRosterId` is the
   team an anonymous or non-member visitor chose with view(); `analysisRoster`
   and `analysisRole` are derived on every bundle: "owner" = myRoster when
   found, else "viewer" = the roster with viewedRosterId, else null. An owner's
   bundle never carries a viewed team: an identify (or any bundle build) that
   finds an owned roster drops viewedRosterId -- dropped, not merged. view()
   is synchronous and fetches nothing: it re-derives the committed bundle
   under the SAME generation, and an in-flight refresh commits with the
   newest viewedRosterId and identity rather than the ones it started from.
   Superseded results stay discarded whatever view()/identify() did meanwhile.

   Errors live in TWO slots. `identityError` is set by a failed identify() and
   cleared only by identify()/forget(); `leagueError` is set by a failed
   ready() and cleared only by ready()/forget(). state() reports "error"
   while EITHER slot is set (identity first), otherwise the flow state
   (anonymous / identifying / identified / loadingLeague / ready /
   refreshing) -- so a league load that completes after a bad username keeps
   the chip on "username was not found" until the user acts. A failed
   refresh() is NOT an error state: the committed bundle stays valid and
   the rejection goes to the caller. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.Session = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const IDENTITY_KEY = "megatron:session:identity";
  const LEGACY_KEY = "megatron:sleeper-username";
  const DRAFT_RESTORE_PREFIX = "fc-draft-mode:";
  const NOT_FOUND = "Sleeper username was not found.";
  const NO_UNIQUE_ROSTER = "Could not uniquely match this account to a roster in this league.";
  const ID_MISMATCH = "live league does not match this board; refusing to load advice";
  const NO_BOARD = "No static board is loaded for this page.";
  const REMEMBERED = "Remembered on this device until you choose forget.";
  const NO_LEAGUE = id => `Sleeper has no league with id ${id}.`;
  const WRONG_SEASON = (season, current) => `This league is from the ${season} season; projections are for ${current}.`;
  const NOT_LOADED = "No Sleeper league is loaded.";
  const OWNER_VIEW = "This account owns a roster in this league; that roster is the one analysed.";
  const ID_TOOLS = Object.freeze({ startsit: true, waivers: true, trade: true });
  const STATES = Object.freeze(["anonymous", "identifying", "identified", "loadingLeague", "ready", "refreshing", "error"]);

  // ---- lazy dependencies ----------------------------------------------------
  // Resolved inside functions, never at load: the browser has window.FC and
  // window.Sleeper as globals; node has neither and requires app.js instead.
  function registryTable() {
    if (typeof FC !== "undefined" && FC && FC.REGISTRY) return FC.REGISTRY;
    if (typeof require === "function") return require("./app.js").REGISTRY;
    throw new Error("League registry unavailable.");
  }
  const registryFor = slug => registryTable().find(r => r.slug === slug) || null;

  let injectedGet = null;
  function resolveGet(opts) {
    if (opts && typeof opts.get === "function") return opts.get;
    if (injectedGet) return injectedGet;
    if (typeof Sleeper !== "undefined" && Sleeper && typeof Sleeper.get === "function") return Sleeper.get;
    throw new Error("Sleeper client unavailable.");
  }

  let injectedStorage; // undefined = use localStorage when present
  function storage() {
    if (injectedStorage !== undefined) return injectedStorage;
    try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (_) { return null; }
  }

  // ---- pure helpers -----------------------------------------------------------
  // The exact matcher (moved from seasontrademode.js): owner or co-owner,
  // EXACTLY one. Zero or two matches is a refusal, never a guess. A malformed
  // element (null) is skipped like deriveRoster does, never dereferenced.
  function identifyRoster(rosters, userId) {
    const mine = (Array.isArray(rosters) ? rosters : []).filter(r => r && (r.owner_id === userId || (r.co_owners || []).includes(userId)));
    if (mine.length !== 1) throw new Error(NO_UNIQUE_ROSTER);
    return mine[0];
  }
  // Same rule as TradeMode.teamName: team name, else display name, else the id.
  function teamName(users, roster) {
    const user = (users || []).find(u => u && u.user_id === (roster || {}).owner_id);
    const meta = user && user.metadata;
    return (meta && meta.team_name) || (user && user.display_name) || `Roster ${(roster || {}).roster_id}`;
  }
  // Never throws: corrupt JSON, wrong shape, or a storage that throws all read
  // as "no identity".
  function readIdentity(store) {
    try {
      if (!store) return null;
      const raw = store.getItem(IDENTITY_KEY);
      if (typeof raw !== "string" || !raw) return null;
      const rec = JSON.parse(raw);
      if (!rec || typeof rec !== "object") return null;
      if (typeof rec.username !== "string" || !rec.username || typeof rec.userId !== "string" || !rec.userId) return null;
      return { username: rec.username, userId: rec.userId, displayName: typeof rec.displayName === "string" && rec.displayName ? rec.displayName : rec.username };
    } catch (_) { return null; }
  }
  // The legacy key held only a username (no user id), so it cannot become an
  // identity without a lookup. Read once, delete, hand the name back for the
  // chip to prefill. Never throws.
  function migrateLegacy(store) {
    try {
      if (!store) return null;
      const raw = store.getItem(LEGACY_KEY);
      if (raw !== null && raw !== undefined) { try { store.removeItem(LEGACY_KEY); } catch (_) {} }
      const name = typeof raw === "string" ? raw.trim() : "";
      return name || null;
    } catch (_) { return null; }
  }
  // The in-season pages' entry for any Sleeper league id (no registry row).
  function idEntry(leagueId, preDraftAnySeason) {
    const entry = { slug: null, platform: "sleeper", leagueId, tools: ID_TOOLS };
    if (preDraftAnySeason) entry.preDraftAnySeason = true;   // only trade.html's mode resolution
    return Object.freeze(entry);
  }
  const isIdEntry = entry => !!entry && entry.slug === null && entry.platform === "sleeper";
  // Whose roster the in-season analysis reads (header). The owner match wins
  // and clears any viewed team; a viewed id that is no longer in the rosters
  // analyses nothing rather than guessing.
  function analysisFor(rosters, myRoster, viewedRosterId) {
    if (myRoster) return { viewedRosterId: null, analysisRoster: myRoster, analysisRole: "owner" };
    const v = viewedRosterId === undefined ? null : viewedRosterId;
    if (v === null || !Array.isArray(rosters)) return { viewedRosterId: v, analysisRoster: null, analysisRole: null };
    const hit = rosters.find(r => r && r.roster_id === v) || null;
    return { viewedRosterId: v, analysisRoster: hit, analysisRole: hit ? "viewer" : null };
  }
  function ageText(fetchedAt, nowMs) {
    const s = Math.max(0, Math.floor(((Number.isFinite(nowMs) ? nowMs : Date.now()) - fetchedAt) / 1000));
    return s < 60 ? `rosters ${s} s ago` : `rosters ${Math.floor(s / 60)} min ago`;
  }
  // The chip's one line for every state (spec §6). `reason` carries the error
  // text in the error state.
  function chipText(bundle, stateName, nowMs, reason) {
    if (stateName === "error") return String(reason || "Something went wrong.");
    if (stateName === "identifying") return "Looking up Sleeper account…";
    if (stateName === "loadingLeague") return "Loading league…";
    // A viewer is never "your roster": the line names the viewed team.
    if (bundle && bundle.analysisRole === "viewer" && bundle.analysisRoster) {
      let text = `Viewing ${teamName(bundle.users, bundle.analysisRoster)}`;
      if (Number.isFinite(bundle.rostersFetchedAt)) text += ` · ${ageText(bundle.rostersFetchedAt, nowMs)}`;
      if (stateName === "refreshing") text += " · refreshing…";
      return text;
    }
    const identity = bundle && bundle.identity;
    // Anonymous on the id path with no team chosen: what to do next, not
    // the storage sentence.
    if (!identity && isIdEntry(bundle && bundle.registry) && bundle.league) {
      const name = bundle.league.name || `League ${bundle.league.league_id}`;
      return `${name} · choose a team to view, or enter your Sleeper username${stateName === "refreshing" ? " · refreshing…" : ""}`;
    }
    if (!identity) return REMEMBERED;
    const name = identity.displayName || identity.username;
    if (!bundle.registry || bundle.registry.platform !== "sleeper") return `${name} · ${bundle.registry ? bundle.registry.label : "no league"}`;
    if (bundle.myRosterStatus === "none" || bundle.myRosterStatus === "ambiguous") return NO_UNIQUE_ROSTER;
    if (!bundle.league || !bundle.myRoster) return REMEMBERED;
    let text = `${name} · ${bundle.league.name} · your roster: ${bundle.myRoster.roster_id}`;
    if (Number.isFinite(bundle.rostersFetchedAt)) text += ` · ${ageText(bundle.rostersFetchedAt, nowMs)}`;
    if (stateName === "refreshing") text += " · refreshing…";
    return text;
  }

  // The live-settings stamp shown beside the data timestamps (spec 5.2).
  function settingsText(bundle) {
    if (!bundle || !Number.isFinite(bundle.leagueFetchedAt)) return "";
    const clock = new Date(bundle.leagueFetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    return `League settings read ${clock}`;
  }

  // ---- session state ------------------------------------------------------------
  let flow = "anonymous";      // the state-machine position, before error slots
  let identityError = null;    // failed identify(); cleared by identify()/forget()
  let leagueError = null;      // failed ready(); cleared by ready()/forget()
  let identityRec = null;      // { username, userId, displayName }
  let identityLoaded = false;  // storage read lazily on first use
  let pendingName = null;      // migrated legacy username awaiting identify()
  let committed = null;        // the immutable bundle, or null
  let identityGen = 0;         // identify()/forget()
  let leagueGen = 0;           // ready()/refresh()
  let refreshPromise = null;   // single-flight
  let catalogPromise = null;
  let catalogAt = null;
  const listeners = new Set();

  function superseded() {
    const e = new Error("Superseded by a newer request.");
    e.superseded = true;
    return e;
  }
  const currentError = () => identityError || leagueError;
  const currentState = () => (currentError() ? "error" : flow);
  // The flow position after an identity change: a committed bundle is
  // usable, otherwise identified/anonymous by whether an account is known.
  const restingFlow = () => (committed ? "ready" : identityRec ? "identified" : "anonymous");
  function fire() {
    const snapshot = { state: currentState(), bundle: committed, identity: identityRec, error: currentError() };
    for (const fn of [...listeners]) {
      try { fn(snapshot); } catch (e) { if (typeof console !== "undefined" && console.error) console.error(e); }
    }
  }
  function ensureLoaded() {
    if (identityLoaded) return;
    identityLoaded = true;
    const store = storage();
    identityRec = readIdentity(store);
    const legacy = migrateLegacy(store);
    if (!identityRec && legacy) pendingName = legacy;
    if (identityRec && flow === "anonymous") flow = "identified";
  }
  function persistIdentity(rec) {
    try {
      const store = storage();
      if (store) store.setItem(IDENTITY_KEY, JSON.stringify({ ...rec, storedAt: new Date().toISOString() }));
    } catch (_) { /* memory-only identity for this document */ }
  }
  // Best-effort, never throws. identify() calls this the moment it clears the
  // in-memory identity: a change of account that then FAILS must not leave the
  // previous account on disk to be silently restored by the next page load.
  // Draft restore records are forget()'s business, not identify()'s.
  function deleteIdentityKey() {
    try { const store = storage(); if (store) store.removeItem(IDENTITY_KEY); } catch (_) {}
  }
  function deleteKeys() {
    const store = storage();
    if (!store) return;
    const doomed = new Set([IDENTITY_KEY, LEGACY_KEY]);
    try {
      for (let i = store.length - 1; i >= 0; i--) {
        const k = store.key(i);
        if (typeof k === "string" && k.startsWith(DRAFT_RESTORE_PREFIX)) doomed.add(k);
      }
    } catch (_) {}
    // Storages without a working key() still lose the known slugs' records.
    try { for (const r of registryTable()) doomed.add(DRAFT_RESTORE_PREFIX + r.slug); } catch (_) {}
    for (const k of doomed) { try { store.removeItem(k); } catch (_) {} }
  }

  function deriveRoster(entry, rosters, identity) {
    if (!identity || !entry || entry.platform !== "sleeper" || !Array.isArray(rosters)) return { myRoster: null, myRosterStatus: "anonymous" };
    const uid = identity.userId;
    const mine = rosters.filter(r => r && (r.owner_id === uid || (r.co_owners || []).includes(uid)));
    if (mine.length === 1) return { myRoster: mine[0], myRosterStatus: "found" };
    return { myRoster: null, myRosterStatus: mine.length === 0 ? "none" : "ambiguous" };
  }
  function freezeBundle(b) {
    b.warnings = Object.freeze((b.warnings || []).slice());
    return Object.freeze(b);
  }
  function buildBundle(entry, parts, gen, extra, viewedRosterId) {
    const identity = identityRec;
    const { league, users, rosters, state } = parts;
    const warnings = [];
    if (state && league && String(state.season) !== String(league.season)) warnings.push(`NFL state season ${state.season} differs from league season ${league.season}.`);
    if (state && state.season_type !== "regular") warnings.push(`NFL season type is ${state.season_type}, not regular.`);
    const mine = deriveRoster(entry, rosters, identity);
    return freezeBundle({
      registry: entry, identity, league, users, rosters, state,
      leagueFetchedAt: parts.leagueFetchedAt,
      rostersRequestedAt: parts.rostersRequestedAt, rostersFetchedAt: parts.rostersFetchedAt,
      ...mine, ...analysisFor(rosters, mine.myRoster, viewedRosterId),
      warnings, extra: extra === undefined ? null : extra, generation: gen,
    });
  }
  function espnBundle(entry, gen) {
    return freezeBundle({
      registry: entry, identity: identityRec, league: null, users: null, rosters: null, state: null,
      leagueFetchedAt: null, rostersRequestedAt: null, rostersFetchedAt: null, myRoster: null, myRosterStatus: "anonymous",
      viewedRosterId: null, analysisRoster: null, analysisRole: null,
      warnings: [], extra: null, generation: gen,
    });
  }
  // Same league data, identity re-derived (identify/forget/view never
  // refetch, and keep the bundle's generation). `viewedRosterId` undefined
  // keeps the bundle's own choice.
  function rederive(bundle, viewedRosterId) {
    if (!bundle) return null;
    const mine = deriveRoster(bundle.registry, bundle.rosters, identityRec);
    const v = viewedRosterId === undefined ? (bundle.viewedRosterId === undefined ? null : bundle.viewedRosterId) : viewedRosterId;
    return freezeBundle({ ...bundle, identity: identityRec, ...mine, ...analysisFor(bundle.rosters, mine.myRoster, v) });
  }

  // Fetch the live league. `requestedAt` is taken BEFORE the rosters request
  // is issued and `fetchedAt` the moment it resolves -- two timestamps because
  // the waiver/start-sit kickoff gate needs the former and the 60 s UI expiry
  // the latter (spec §4.2). The league object is re-read on EVERY call (any-
  // league spec 5.2); users only for a full load. Shapes are validated here;
  // a malformed component fails the whole load. On the id path a null league
  // is Sleeper's "no such league" and is named so even when a sibling
  // request failed too (all four settle before anything is judged).
  async function fetchLeague(entry, get, scope, base) {
    const id = entry.leagueId;
    const full = scope === "league" || !base;
    let leagueFetchedAt = null;
    const leagueP = get(`/league/${id}`).then(l => { leagueFetchedAt = Date.now(); return l; });
    const usersP = full ? get(`/league/${id}/users`) : Promise.resolve(base.users);
    const rostersRequestedAt = Date.now();
    let rostersFetchedAt = null;
    const rostersP = get(`/league/${id}/rosters`).then(r => { rostersFetchedAt = Date.now(); return r; });
    const stateP = get("/state/nfl");
    const settled = await Promise.allSettled([leagueP, usersP, rostersP, stateP]);
    if (isIdEntry(entry) && settled[0].status === "fulfilled" && (settled[0].value === null || settled[0].value === undefined)) throw new Error(NO_LEAGUE(id));
    for (const r of settled) if (r.status === "rejected") throw r.reason;
    const [league, users, rosters, state] = settled.map(r => r.value);
    if (!league || typeof league !== "object" || league.league_id === undefined || league.league_id === null) throw new Error("Sleeper returned a malformed league.");
    if (!Array.isArray(users)) throw new Error("Sleeper returned malformed league users.");
    if (!Array.isArray(rosters)) throw new Error("Sleeper returned malformed rosters.");
    if (!state || typeof state !== "object" || state.season === undefined || state.season === null) throw new Error("Sleeper returned a malformed NFL state.");
    return { league, users, rosters, state, leagueFetchedAt, rostersRequestedAt, rostersFetchedAt };
  }
  // The id path's own refusals, on load and on every refresh: the league
  // Sleeper answered with must be the one asked for, and of the live season.
  function checkIdLeague(entry, parts) {
    if (!isIdEntry(entry)) return;
    if (String(parts.league.league_id) !== String(entry.leagueId)) throw new Error(`Sleeper answered for league ${parts.league.league_id}, not ${entry.leagueId}.`);
    // The in-season projection-season contract. A pre-draft league is exempt
    // only on the opted-in mode-resolution path (header): it is the next
    // season's league during the rollover, and no projection is priced for it.
    if (entry.preDraftAnySeason && parts.league.status === "pre_draft") return;
    if (String(parts.league.season) !== String(parts.state.season)) throw new Error(WRONG_SEASON(parts.league.season, parts.state.season));
  }

  // ---- API ----------------------------------------------------------------------
  async function identify(username, opts) {
    ensureLoaded();
    const name = String(username || "").trim();
    const gen = ++identityGen;
    // Clear FIRST -- memory AND storage: the previous account's surfaces go
    // dark before the lookup, and a failure does not silently bring that
    // account back, in this document or on the next load.
    identityRec = null;
    pendingName = null;
    deleteIdentityKey();
    identityError = null;        // only the identity slot; a league error is not ours to clear
    committed = rederive(committed);
    flow = "identifying";
    fire();
    let user;
    try {
      if (!name) throw new Error("Enter a Sleeper username.");
      user = await resolveGet(opts)(`/user/${encodeURIComponent(name)}`);
      if (!user || typeof user !== "object" || !user.user_id) throw new Error(NOT_FOUND);
    } catch (e) {
      if (gen !== identityGen) throw superseded();
      identityError = String(e.message || e);
      flow = restingFlow();
      fire();
      throw e;
    }
    if (gen !== identityGen) throw superseded();
    identityRec = {
      username: typeof user.username === "string" && user.username ? user.username : name,
      userId: String(user.user_id),
      displayName: typeof user.display_name === "string" && user.display_name ? user.display_name : name,
    };
    persistIdentity(identityRec);
    committed = rederive(committed);
    flow = restingFlow();
    fire();
    return { ...identityRec };
  }

  function forget() {
    ensureLoaded();
    identityGen++;               // an in-flight identify() must not resurrect the account
    identityRec = null;
    pendingName = null;
    deleteKeys();
    committed = rederive(committed);
    identityError = null;
    leagueError = null;
    flow = "anonymous";
    fire();
  }

  async function ready(opts) {
    ensureLoaded();
    const { slug, board, leagueId, preDraftAnySeason } = opts || {};
    const byId = leagueId !== undefined && leagueId !== null;
    const gen = ++leagueGen;
    refreshPromise = null;       // an in-flight refresh belongs to the old league
    committed = null;            // no prior bundle stays usable while a new league loads
    leagueError = null;          // only the league slot; an identity error outlives us
    flow = "loadingLeague";
    fire();
    let bundle;
    try {
      if (byId) {
        // Any Sleeper league, no board, identity optional (header).
        const id = String(leagueId).trim();
        if (!/^\d+$/.test(id)) throw new Error(NO_LEAGUE(id));
        const entry = idEntry(id, preDraftAnySeason === true);
        const get = resolveGet(opts);   // per-call only: never installed document-wide
        const parts = await fetchLeague(entry, get, "league", null);
        if (gen !== leagueGen) throw superseded();
        checkIdLeague(entry, parts);
        bundle = buildBundle(entry, parts, gen);
      } else {
        const entry = registryFor(slug);
        if (!entry) throw new Error(`Unknown league "${slug}".`);
        if (entry.platform !== "sleeper") {
          bundle = espnBundle(entry, gen);   // ESPN never creates a Sleeper session
        } else {
          // No board id is an integration fault of the page, not a mismatch:
          // say so by name, before any Sleeper call is spent on it.
          const staticId = board && board.league ? board.league.league_id : undefined;
          if (staticId === undefined || staticId === null) throw new Error(NO_BOARD);
          const get = resolveGet(opts);   // per-call only: never installed document-wide
          const parts = await fetchLeague(entry, get, "league", null);
          if (String(parts.league.league_id) !== String(staticId)) throw new Error(ID_MISMATCH);
          if (gen !== leagueGen) throw superseded();
          bundle = buildBundle(entry, parts, gen);
        }
      }
    } catch (e) {
      if (gen !== leagueGen) throw superseded();
      committed = null;
      leagueError = String(e.message || e);
      flow = restingFlow();
      fire();
      throw e;
    }
    if (gen !== leagueGen) throw superseded();
    committed = bundle;
    flow = "ready";
    fire();
    return bundle;
  }

  function refresh(opts) {
    ensureLoaded();
    if (refreshPromise) return refreshPromise;
    const scope = (opts && opts.scope) || "rosters";
    const also = opts && typeof opts.also === "function" ? opts.also : null;
    const base = committed;
    if (!base) return Promise.reject(new Error("No league is loaded to refresh."));
    if (base.registry.platform !== "sleeper") return Promise.resolve(base);
    let get;
    try { get = resolveGet(opts); } catch (e) { return Promise.reject(e); }
    const gen = ++leagueGen;
    flow = "refreshing";
    fire();
    const p = (async () => {
      try {
        const parts = await fetchLeague(base.registry, get, scope, base);
        if (gen !== leagueGen) throw superseded();
        // The id path names its own refusals; "does not match this board"
        // is the registry (draft) path's message only.
        if (isIdEntry(base.registry)) checkIdLeague(base.registry, parts);
        else if (String(parts.league.league_id) !== String(base.league.league_id)) throw new Error(ID_MISMATCH);
        // The controller's extra fetch (e.g. the waiver desk's week
        // transactions) runs in THIS generation, BEFORE the commit: if it
        // rejects, nothing is committed and rostersFetchedAt does not move;
        // if it resolves, its value rides along as bundle.extra.
        let extra = null;
        if (also) {
          extra = await also(Object.freeze({ ...parts }), get);
          if (gen !== leagueGen) throw superseded();
        }
        // The NEWEST view and identity, not the ones this refresh started
        // under: a view()/identify() made meanwhile is not undone (header).
        const viewed = committed && committed.viewedRosterId !== undefined ? committed.viewedRosterId : null;
        const bundle = buildBundle(base.registry, parts, gen, extra, viewed);
        committed = bundle;
        flow = "ready";
        fire();
        return bundle;
      } catch (e) {
        if (gen !== leagueGen) throw superseded();
        // The old bundle -- and its timestamps -- stay exactly as they were.
        // Not an error state: the committed bundle is still valid.
        flow = "ready";
        fire();
        throw e;
      }
    })();
    refreshPromise = p;
    const release = () => { if (refreshPromise === p) refreshPromise = null; };
    p.then(release, release);
    return p;
  }

  // Choose the team an anonymous or non-member visitor views (null clears).
  // Synchronous, fetches nothing, keeps the generation; never sets myRoster.
  function view(rosterId) {
    ensureLoaded();
    const base = committed;
    if (!base || !base.registry || base.registry.platform !== "sleeper" || !Array.isArray(base.rosters)) throw new Error(NOT_LOADED);
    let v = null;
    if (rosterId !== null && rosterId !== undefined && rosterId !== "") {
      const hit = base.rosters.find(r => r && String(r.roster_id) === String(rosterId));
      if (!hit) throw new Error(`No team with roster id ${rosterId} in this league.`);
      v = hit.roster_id;
    }
    if (v !== null && base.myRoster) throw new Error(OWNER_VIEW);
    committed = rederive(base, v);
    fire();
    return committed;
  }

  function catalog(opts) {
    if (catalogPromise) return catalogPromise;
    let get;
    try { get = resolveGet(opts); } catch (e) { return Promise.reject(e); }
    // The catalog is an id-keyed object; anything else (null, a string, an
    // array) is malformed and rejects. EVERY rejection -- the getter's or the
    // validation's -- releases the single-flight slot, so the next call
    // re-fetches instead of replaying a cached failure for the whole document.
    const p = get("/players/nfl").then(players => {
      if (!players || typeof players !== "object" || Array.isArray(players)) throw new Error("Sleeper returned a malformed player catalog.");
      catalogAt = Date.now();
      return players;
    });
    catalogPromise = p;
    p.catch(() => { if (catalogPromise === p) catalogPromise = null; });
    return p;
  }

  // `season` may be passed by a caller with no board (connect.js fetches
  // /state/nfl itself); otherwise it comes from the committed bundle's state.
  async function leaguesFor(opts) {
    ensureLoaded();
    if (!identityRec) throw new Error("Enter a Sleeper username first.");
    const given = opts && opts.season !== undefined && opts.season !== null ? String(opts.season).trim() : "";
    const bundle = committed;
    const season = given || (bundle && bundle.state && bundle.state.season !== undefined && bundle.state.season !== null ? String(bundle.state.season) : "");
    if (!season) throw new Error("Load a league first or pass a season; the NFL season comes from live state.");
    return resolveGet(opts)(`/user/${encodeURIComponent(identityRec.userId)}/leagues/nfl/${encodeURIComponent(season)}`);
  }

  // The keeper panel's roster is LAST season's, not `myRoster`: follow the
  // committed league's previous_league_id, read that league's rosters and
  // apply the exact matcher with the shared user id (spec §5, keepers row).
  // Commits nothing, so no generation is claimed -- but a result belongs to
  // the bundle and identity it was asked under: if either moves before the
  // rosters arrive, the answer is superseded rather than handed to a panel
  // that now shows another league or another account.
  async function previousLeagueRoster(opts) {
    ensureLoaded();
    if (!identityRec) throw new Error("Enter a Sleeper username first.");
    const bundle = committed;
    if (!bundle || !bundle.league) throw new Error("No Sleeper league is loaded.");
    const prev = bundle.league.previous_league_id;
    if (prev === undefined || prev === null || prev === "") throw new Error("no prior season found — enter keepers manually");
    const get = resolveGet(opts);
    const gen = bundle.generation, userId = identityRec.userId;
    const rosters = await get(`/league/${encodeURIComponent(prev)}/rosters`);
    if (!committed || committed.generation !== gen || !identityRec || identityRec.userId !== userId) throw superseded();
    if (!Array.isArray(rosters)) throw new Error("Sleeper returned malformed rosters.");
    return { previousLeagueId: String(prev), roster: identifyRoster(rosters, userId) };
  }

  function onChange(fn) {
    if (typeof fn !== "function") throw new TypeError("onChange expects a function");
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  // ---- test hooks ---------------------------------------------------------------
  // Inject a storage object and reset the document's session to a cold start.
  function _storage(obj) {
    injectedStorage = obj === undefined ? null : obj;
    flow = "anonymous"; identityError = null; leagueError = null;
    identityRec = null; identityLoaded = false; pendingName = null;
    committed = null; identityGen++; leagueGen++;
    refreshPromise = null; catalogPromise = null; catalogAt = null;
    listeners.clear();
  }
  function _get(fn) { injectedGet = typeof fn === "function" ? fn : null; }

  return Object.freeze({
    STATES,
    identify, forget, ready, refresh, view, catalog, leaguesFor, previousLeagueRoster, onChange,
    state: () => { ensureLoaded(); return currentState(); },
    error: () => currentError(),
    bundle: () => committed,
    identity: () => { ensureLoaded(); return identityRec ? { ...identityRec } : null; },
    pendingUsername: () => { ensureLoaded(); return pendingName; },
    catalogFetchedAt: () => catalogAt,
    identifyRoster, teamName, chipText, settingsText, readIdentity, migrateLegacy, isSuperseded: e => !!(e && e.superseded),
    _storage, _get,
  });
});
