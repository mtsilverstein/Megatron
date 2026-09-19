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
     anonymous; nothing here ever throws because of storage. */
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
  const REMEMBERED = "Remembered on this device until you choose forget.";
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
  // EXACTLY one. Zero or two matches is a refusal, never a guess.
  function identifyRoster(rosters, userId) {
    const mine = (rosters || []).filter(r => r.owner_id === userId || (r.co_owners || []).includes(userId));
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
    const identity = bundle && bundle.identity;
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

  // ---- session state ------------------------------------------------------------
  let stateName = "anonymous";
  let errorReason = null;
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
  function setState(name, reason) {
    stateName = name;
    errorReason = name === "error" ? String(reason || "") : null;
  }
  function fire() {
    const snapshot = { state: stateName, bundle: committed, identity: identityRec, error: errorReason };
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
    if (identityRec && stateName === "anonymous") stateName = "identified";
  }
  function persistIdentity(rec) {
    try {
      const store = storage();
      if (store) store.setItem(IDENTITY_KEY, JSON.stringify({ ...rec, storedAt: new Date().toISOString() }));
    } catch (_) { /* memory-only identity for this document */ }
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
  function buildBundle(entry, parts, gen) {
    const identity = identityRec;
    const { league, users, rosters, state } = parts;
    const warnings = [];
    if (state && league && String(state.season) !== String(league.season)) warnings.push(`NFL state season ${state.season} differs from league season ${league.season}.`);
    if (state && state.season_type !== "regular") warnings.push(`NFL season type is ${state.season_type}, not regular.`);
    return freezeBundle({
      registry: entry, identity, league, users, rosters, state,
      rostersRequestedAt: parts.requestedAt, rostersFetchedAt: parts.fetchedAt,
      ...deriveRoster(entry, rosters, identity), warnings, generation: gen,
    });
  }
  function espnBundle(entry, gen) {
    return freezeBundle({
      registry: entry, identity: identityRec, league: null, users: null, rosters: null, state: null,
      rostersRequestedAt: null, rostersFetchedAt: null, myRoster: null, myRosterStatus: "anonymous",
      warnings: [], generation: gen,
    });
  }
  // Same league data, identity re-derived (identify/forget never refetch).
  function rederive(bundle) {
    if (!bundle) return null;
    return freezeBundle({ ...bundle, identity: identityRec, ...deriveRoster(bundle.registry, bundle.rosters, identityRec) });
  }

  // Fetch the live league. `requestedAt` is taken BEFORE the rosters request
  // is issued and `fetchedAt` the moment it resolves -- two timestamps because
  // the waiver/start-sit kickoff gate needs the former and the 60 s UI expiry
  // the latter (spec §4.2). Shapes are validated here; a malformed component
  // fails the whole load.
  async function fetchLeague(entry, get, scope, base) {
    const id = entry.leagueId;
    const full = scope === "league" || !base;
    const leagueP = full ? get(`/league/${id}`) : Promise.resolve(base.league);
    const usersP = full ? get(`/league/${id}/users`) : Promise.resolve(base.users);
    const requestedAt = Date.now();
    let fetchedAt = null;
    const rostersP = get(`/league/${id}/rosters`).then(r => { fetchedAt = Date.now(); return r; });
    const stateP = get("/state/nfl");
    const [league, users, rosters, state] = await Promise.all([leagueP, usersP, rostersP, stateP]);
    if (!league || typeof league !== "object" || league.league_id === undefined || league.league_id === null) throw new Error("Sleeper returned a malformed league.");
    if (!Array.isArray(users)) throw new Error("Sleeper returned malformed league users.");
    if (!Array.isArray(rosters)) throw new Error("Sleeper returned malformed rosters.");
    if (!state || typeof state !== "object" || state.season === undefined || state.season === null) throw new Error("Sleeper returned a malformed NFL state.");
    return { league, users, rosters, state, requestedAt, fetchedAt };
  }

  // ---- API ----------------------------------------------------------------------
  async function identify(username, opts) {
    ensureLoaded();
    const name = String(username || "").trim();
    const gen = ++identityGen;
    // Clear FIRST: the previous account's surfaces go dark before the lookup,
    // and a failure does not silently bring that account back.
    identityRec = null;
    pendingName = null;
    committed = rederive(committed);
    setState("identifying");
    fire();
    let user;
    try {
      if (!name) throw new Error("Enter a Sleeper username, not a password.");
      user = await resolveGet(opts)(`/user/${encodeURIComponent(name)}`);
      if (!user || typeof user !== "object" || !user.user_id) throw new Error(NOT_FOUND);
    } catch (e) {
      if (gen !== identityGen) throw superseded();
      setState("error", e.message);
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
    setState(committed ? "ready" : "identified");
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
    setState("anonymous");
    fire();
  }

  async function ready(opts) {
    ensureLoaded();
    const { slug, board } = opts || {};
    const gen = ++leagueGen;
    refreshPromise = null;       // an in-flight refresh belongs to the old league
    committed = null;            // no prior bundle stays usable while a new league loads
    setState("loadingLeague");
    fire();
    let bundle;
    try {
      const entry = registryFor(slug);
      if (!entry) throw new Error(`Unknown league "${slug}".`);
      if (entry.platform !== "sleeper") {
        bundle = espnBundle(entry, gen);   // ESPN never creates a Sleeper session
      } else {
        const get = resolveGet(opts);
        if (opts && typeof opts.get === "function") injectedGet = opts.get;
        const parts = await fetchLeague(entry, get, "league", null);
        const staticId = board && board.league ? board.league.league_id : undefined;
        if (staticId === undefined || staticId === null || String(parts.league.league_id) !== String(staticId)) throw new Error(ID_MISMATCH);
        if (gen !== leagueGen) throw superseded();
        bundle = buildBundle(entry, parts, gen);
      }
    } catch (e) {
      if (gen !== leagueGen) throw superseded();
      committed = null;
      setState("error", e.message);
      fire();
      throw e;
    }
    if (gen !== leagueGen) throw superseded();
    committed = bundle;
    setState("ready");
    fire();
    return bundle;
  }

  function refresh(opts) {
    ensureLoaded();
    if (refreshPromise) return refreshPromise;
    const scope = (opts && opts.scope) || "rosters";
    const base = committed;
    if (!base) return Promise.reject(new Error("No league is loaded to refresh."));
    if (base.registry.platform !== "sleeper") return Promise.resolve(base);
    let get;
    try { get = resolveGet(opts); } catch (e) { return Promise.reject(e); }
    const gen = ++leagueGen;
    setState("refreshing");
    fire();
    const p = (async () => {
      try {
        const parts = await fetchLeague(base.registry, get, scope, base);
        if (gen !== leagueGen) throw superseded();
        if (String(parts.league.league_id) !== String(base.league.league_id)) throw new Error(ID_MISMATCH);
        const bundle = buildBundle(base.registry, parts, gen);
        committed = bundle;
        setState("ready");
        fire();
        return bundle;
      } catch (e) {
        if (gen !== leagueGen) throw superseded();
        // The old bundle -- and its timestamps -- stay exactly as they were.
        setState("ready");
        fire();
        throw e;
      }
    })();
    refreshPromise = p;
    const release = () => { if (refreshPromise === p) refreshPromise = null; };
    p.then(release, release);
    return p;
  }

  function catalog(opts) {
    if (catalogPromise) return catalogPromise;
    let get;
    try { get = resolveGet(opts); } catch (e) { return Promise.reject(e); }
    const p = get("/players/nfl").then(players => {
      if (!players || typeof players !== "object") throw new Error("Sleeper returned a malformed player catalog.");
      catalogAt = Date.now();
      return players;
    }, e => { if (catalogPromise === p) catalogPromise = null; throw e; });
    catalogPromise = p;
    return p;
  }

  async function leaguesFor(opts) {
    ensureLoaded();
    const bundle = committed;
    if (!bundle || !bundle.state) throw new Error("Load a league first; the NFL season comes from its live state.");
    if (!identityRec) throw new Error("Enter a Sleeper username first.");
    return resolveGet(opts)(`/user/${encodeURIComponent(identityRec.userId)}/leagues/nfl/${encodeURIComponent(String(bundle.state.season))}`);
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
    stateName = "anonymous"; errorReason = null;
    identityRec = null; identityLoaded = false; pendingName = null;
    committed = null; identityGen++; leagueGen++;
    refreshPromise = null; catalogPromise = null; catalogAt = null;
    listeners.clear();
  }
  function _get(fn) { injectedGet = typeof fn === "function" ? fn : null; }

  return Object.freeze({
    STATES,
    identify, forget, ready, refresh, catalog, leaguesFor, onChange,
    state: () => { ensureLoaded(); return stateName; },
    error: () => errorReason,
    bundle: () => committed,
    identity: () => { ensureLoaded(); return identityRec ? { ...identityRec } : null; },
    pendingUsername: () => { ensureLoaded(); return pendingName; },
    catalogFetchedAt: () => catalogAt,
    identifyRoster, teamName, chipText, readIdentity, migrateLegacy, isSuperseded: e => !!(e && e.superseded),
    _storage, _get,
  });
});
