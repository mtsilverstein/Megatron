// tests/session_fixture.cjs — run with: node tests/session_fixture.cjs
//
// The shared Sleeper session: one identity, one immutable league bundle per
// document, two roster timestamps, generation-guarded async, fail-closed.
// Every Sleeper call goes through an injected `get` here; the module must
// never touch `window` or `Sleeper` at load time (this file requires it with
// neither defined).
const assert = require("node:assert/strict");
const Session = require("../site/assets/session.js");
const FC = require("../site/assets/app.js");

let n = 0;
async function check(name, fn) {
  try { await fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
}
const pause = ms => new Promise(r => setTimeout(r, ms));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---- fakes -----------------------------------------------------------------
const L = "1376245373244301312"; // gabagool's registry id
const LF = "1389736745205002240"; // fam's
const user = { user_id: "u1", username: "max973", display_name: "Max973" };
const league = { league_id: L, name: "Gabagool Fools", season: "2026", status: "in_season", roster_positions: ["QB", "RB", "BN"] };
const leagueFam = { league_id: LF, name: "FAM FOOTBALL", season: "2026", status: "in_season" };
const users = [{ user_id: "u1", display_name: "Max973", metadata: { team_name: "Meat Sweats" } }, { user_id: "u2", display_name: "Bo" }];
const rosters = [{ roster_id: 9, owner_id: "u1", co_owners: null, players: ["a"] }, { roster_id: 3, owner_id: "u2", co_owners: ["u5"], players: ["b"] }];
const state = { season: "2026", season_type: "regular", week: 3 };
const board = { league: { league_id: L }, season: 2026 };
const boardFam = { league: { league_id: LF }, season: 2026 };

// path -> canned value | Error (rejects) | function(path) -> value|promise.
function fakeGet(routes) {
  const calls = [];
  const get = path => {
    calls.push(path);
    const hit = routes[path];
    if (hit === undefined) return Promise.reject(new Error(`unrouted ${path}`));
    if (hit instanceof Error) return Promise.reject(hit);
    if (typeof hit === "function") return Promise.resolve().then(() => hit(path));
    return Promise.resolve(hit);
  };
  return { get, calls, reset() { calls.length = 0; } };
}
const routesFor = (id, lg) => ({
  "/user/max973": user, "/user/max": user, [`/league/${id}`]: lg, [`/league/${id}/users`]: users,
  [`/league/${id}/rosters`]: rosters, "/state/nfl": state,
});
const routes = () => routesFor(L, league);

// Map-backed storage with the Storage surface the module may use.
function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _map: m,
  };
}
function throwingStorage() {
  const boom = () => { throw new Error("SecurityError: storage disabled"); };
  return { getItem: boom, setItem: boom, removeItem: boom, key: boom, get length() { return boom(); } };
}
const IDENTITY_KEY = "megatron:session:identity";
const LEGACY_KEY = "megatron:sleeper-username";
const sorted = a => a.slice().sort();

(async () => {
  await check("1. identify resolves, persists and sets identified; a miss rejects and persists nothing", async () => {
    const store = fakeStorage();
    Session._storage(store);
    const { get, calls } = fakeGet(routes());
    Session._get(get);
    assert.equal(Session.state(), "anonymous");
    const id = await Session.identify("max");
    assert.deepEqual(id, { username: "max973", userId: "u1", displayName: "Max973" });
    assert.deepEqual(Session.identity(), id);
    assert.deepEqual(calls, ["/user/max"]);
    assert.equal(Session.state(), "identified");
    const persisted = JSON.parse(store.getItem(IDENTITY_KEY));
    assert.equal(persisted.userId, "u1"); assert.equal(persisted.username, "max973");
    assert.ok(typeof persisted.storedAt === "string" && persisted.storedAt.length > 0);

    // A miss: Sleeper answers with a body that carries no user_id.
    const store2 = fakeStorage();
    Session._storage(store2);
    Session._get(fakeGet({ "/user/nobody": null }).get);
    await assert.rejects(Session.identify("nobody"), /was not found/);
    assert.equal(Session.state(), "error");
    assert.match(Session.error(), /was not found/);
    assert.equal(Session.identity(), null);
    assert.equal(store2.getItem(IDENTITY_KEY), null, "a failed lookup must persist nothing");
  });

  await check("2. ready fetches league/users/rosters/state exactly once each and derives my roster", async () => {
    Session._storage(fakeStorage());
    const { get, calls } = fakeGet(routes());
    Session._get(get);
    await Session.identify("max973");
    calls.length = 0;
    const b = await Session.ready({ slug: "gabagool", board });
    assert.deepEqual(sorted(calls), sorted([`/league/${L}`, `/league/${L}/users`, `/league/${L}/rosters`, "/state/nfl"]));
    assert.equal(b.registry.leagueId, L);
    assert.equal(b.registry.slug, "gabagool");
    assert.equal(b.myRosterStatus, "found");
    assert.equal(b.myRoster.roster_id, 9);
    assert.equal(b.identity.userId, "u1");
    assert.equal(b.league, league); assert.equal(b.users, users); assert.equal(b.rosters, rosters); assert.equal(b.state, state);
    assert.ok(Number.isFinite(b.rostersRequestedAt) && Number.isFinite(b.rostersFetchedAt));
    assert.ok(b.rostersRequestedAt <= b.rostersFetchedAt, "requested-at is taken before the request, fetched-at after");
    assert.deepEqual(b.warnings, []);
    assert.equal(Session.state(), "ready");
    assert.equal(Session.bundle(), b);
    assert.ok(Object.isFrozen(b), "the committed bundle is immutable");
    assert.equal(Session.teamName(b.users, b.rosters[0]), "Meat Sweats");
    assert.equal(Session.teamName(b.users, b.rosters[1]), "Bo");
    assert.equal(Session.teamName(b.users, { roster_id: 7, owner_id: "zz" }), "Roster 7");
  });

  await check("3. ready without identity resolves anonymous with no roster", async () => {
    Session._storage(fakeStorage());
    const { get } = fakeGet(routes());
    const b = await Session.ready({ slug: "gabagool", board, get });
    assert.equal(b.identity, null);
    assert.equal(b.myRosterStatus, "anonymous");
    assert.equal(b.myRoster, null);
    assert.equal(Session.state(), "ready");
    // With an identity that matches zero or two rosters the bundle still
    // commits (league data is usable) but says so, and the chip refuses.
    Session._get(fakeGet({ ...routes(), "/user/ghost": { user_id: "u9", username: "ghost", display_name: "Ghost" } }).get);
    await Session.identify("ghost");
    const none = await Session.ready({ slug: "gabagool", board });
    assert.equal(none.myRosterStatus, "none"); assert.equal(none.myRoster, null);
    assert.equal(Session.chipText(none, "ready", Date.now()), "Could not uniquely match this account to a roster in this league.");
    const r = routes(); r[`/league/${L}/rosters`] = rosters.concat([{ roster_id: 4, owner_id: "u1" }]);
    Session._get(fakeGet(r).get);
    await Session.identify("max973");
    const two = await Session.ready({ slug: "gabagool", board });
    assert.equal(two.myRosterStatus, "ambiguous"); assert.equal(two.myRoster, null);
    assert.equal(Session.chipText(two, "ready", Date.now()), "Could not uniquely match this account to a roster in this league.");
  });

  await check("4. live/static league id mismatch rejects and leaves no bundle", async () => {
    Session._storage(fakeStorage());
    const { get } = fakeGet(routes());
    Session._get(get);
    await Session.ready({ slug: "gabagool", board }); // a prior good bundle...
    assert.ok(Session.bundle());
    await assert.rejects(Session.ready({ slug: "gabagool", board: { league: { league_id: "999" } } }), /does not match this board/);
    assert.equal(Session.bundle(), null, "...must not remain usable after a failed load");
    assert.equal(Session.state(), "error");
    assert.match(Session.error(), /does not match this board/);
    // A board with no league id at all is equally unverifiable.
    await assert.rejects(Session.ready({ slug: "gabagool", board: {} }), /does not match this board/);
    assert.equal(Session.bundle(), null);
    // Malformed live data and a failed required fetch fail ready() the same way.
    const r = routes(); r[`/league/${L}/users`] = { not: "an array" };
    Session._get(fakeGet(r).get);
    await assert.rejects(Session.ready({ slug: "gabagool", board }), /malformed/i);
    assert.equal(Session.bundle(), null);
    r[`/league/${L}/users`] = users; r["/state/nfl"] = new Error("HTTP 504");
    await assert.rejects(Session.ready({ slug: "gabagool", board }), /HTTP 504/);
    assert.equal(Session.bundle(), null);
    assert.equal(Session.state(), "error");
  });

  await check("5. identifyRoster: owner, co-owner, none, two", () => {
    assert.equal(Session.identifyRoster(rosters, "u1").roster_id, 9);
    assert.equal(Session.identifyRoster(rosters, "u5").roster_id, 3);
    assert.throws(() => Session.identifyRoster(rosters, "u9"), { message: "Could not uniquely match this account to a roster in this league." });
    assert.throws(() => Session.identifyRoster(rosters.concat([{ roster_id: 4, owner_id: "u1" }]), "u1"), /Could not uniquely match/);
    assert.throws(() => Session.identifyRoster(null, "u1"), /Could not uniquely match/);
  });

  await check("6. refresh scopes: rosters re-fetches rosters+state only; league re-fetches all four", async () => {
    Session._storage(fakeStorage());
    const { get, calls } = fakeGet(routes());
    Session._get(get);
    await Session.identify("max973");
    const b1 = await Session.ready({ slug: "gabagool", board });
    await pause(5);
    calls.length = 0;
    const b2 = await Session.refresh({ scope: "rosters" });
    assert.deepEqual(sorted(calls), sorted([`/league/${L}/rosters`, "/state/nfl"]));
    assert.notEqual(b2, b1, "refresh swaps in a NEW bundle");
    assert.equal(Session.bundle(), b2);
    assert.ok(b2.rostersFetchedAt > b1.rostersFetchedAt, "a successful refresh advances rostersFetchedAt");
    assert.ok(b2.rostersRequestedAt >= b1.rostersFetchedAt);
    assert.equal(b2.users, b1.users, "users object identity is unchanged on a rosters-scope refresh");
    assert.equal(b2.league, b1.league);
    assert.equal(b2.myRoster.roster_id, 9);
    assert.ok(b2.generation > b1.generation);
    assert.equal(Session.state(), "ready");
    calls.length = 0;
    const b3 = await Session.refresh({ scope: "league" });
    assert.deepEqual(sorted(calls), sorted([`/league/${L}`, `/league/${L}/users`, `/league/${L}/rosters`, "/state/nfl"]));
    assert.ok(b3.rostersFetchedAt >= b2.rostersFetchedAt);
    // Default scope is rosters; and refresh is single-flight.
    calls.length = 0;
    const p1 = Session.refresh(), p2 = Session.refresh();
    assert.equal(p1, p2, "a second refresh while one is in flight returns the same promise");
    await p1;
    assert.deepEqual(sorted(calls), sorted([`/league/${L}/rosters`, "/state/nfl"]));
  });

  await check("7. a failed refresh keeps the old bundle and its timestamps; state returns to ready", async () => {
    Session._storage(fakeStorage());
    const r = routes();
    const { get } = fakeGet(r);
    Session._get(get);
    await Session.identify("max973");
    const b1 = await Session.ready({ slug: "gabagool", board });
    await pause(5);
    r[`/league/${L}/rosters`] = new Error("HTTP 503");
    await assert.rejects(Session.refresh({ scope: "rosters" }), /HTTP 503/);
    assert.equal(Session.bundle(), b1, "the old bundle stays committed");
    assert.equal(Session.bundle().rostersFetchedAt, b1.rostersFetchedAt);
    assert.equal(Session.bundle().rostersRequestedAt, b1.rostersRequestedAt);
    assert.equal(Session.state(), "ready");
    // A partial success (state ok, rosters malformed) is a failure too.
    r[`/league/${L}/rosters`] = { not: "an array" };
    await assert.rejects(Session.refresh({ scope: "rosters" }), /malformed/i);
    assert.equal(Session.bundle(), b1);
    assert.equal(Session.state(), "ready");
    // And a fresh refresh can be attempted afterwards (single-flight slot released).
    r[`/league/${L}/rosters`] = rosters;
    const b2 = await Session.refresh();
    assert.notEqual(b2, b1);
  });

  await check("8. generation: an older ready resolving after a newer one commits nothing and fires nothing", async () => {
    Session._storage(fakeStorage());
    const dA = deferred(), dB = deferred();
    const r = { ...routesFor(L, league), ...routesFor(LF, leagueFam) };
    r[`/league/${L}/rosters`] = () => dA.promise;
    r[`/league/${LF}/rosters`] = () => dB.promise;
    const { get } = fakeGet(r);
    Session._get(get);
    await Session.identify("max973");
    const fired = [];
    const off = Session.onChange(() => fired.push({ state: Session.state(), slug: Session.bundle() && Session.bundle().registry.slug }));
    const pA = Session.ready({ slug: "gabagool", board });
    const pB = Session.ready({ slug: "fam", board: boardFam });
    dB.resolve(rosters);
    const bB = await pB;
    assert.equal(bB.registry.slug, "fam");
    const firedBeforeA = fired.length;
    assert.ok(fired.some(f => f.state === "ready" && f.slug === "fam"), "B's commit fired onChange");
    dA.resolve(rosters);
    await assert.rejects(pA, e => e.superseded === true && /superseded/i.test(e.message));
    await pause(2);
    assert.equal(Session.bundle().registry.slug, "fam", "the stale A result must not overwrite B");
    assert.equal(Session.bundle(), bB);
    assert.equal(fired.length, firedBeforeA, "A's late result fired nothing");
    assert.equal(Session.state(), "ready");
    off();
    // A stale refresh is discarded the same way, and cannot touch the bundle
    // or its timestamps.
    const dR = deferred();
    r[`/league/${LF}/rosters`] = () => dR.promise;
    const pR = Session.refresh();
    r[`/league/${LF}/rosters`] = rosters;
    const bNew = await Session.ready({ slug: "fam", board: boardFam });
    dR.resolve(rosters);
    await assert.rejects(pR, e => e.superseded === true);
    await pause(2);
    assert.equal(Session.bundle(), bNew);
    // A stale identify is discarded too: the second lookup wins.
    const dI = deferred();
    r["/user/slow"] = () => dI.promise;
    const pI = Session.identify("slow");
    await Session.identify("max973");
    dI.resolve({ user_id: "u2", username: "slow", display_name: "Slow" });
    await assert.rejects(pI, e => e.superseded === true);
    await pause(2);
    assert.equal(Session.identity().userId, "u1");
  });

  await check("9. entering identify clears myRoster and fires onChange synchronously, before the network", async () => {
    Session._storage(fakeStorage());
    const d = deferred();
    const r = routes(); r["/user/other"] = () => d.promise;
    const { get } = fakeGet(r);
    Session._get(get);
    await Session.identify("max973");
    const b1 = await Session.ready({ slug: "gabagool", board });
    assert.equal(b1.myRoster.roster_id, 9);
    const seen = [];
    const off = Session.onChange(() => seen.push({ state: Session.state(), myRoster: Session.bundle().myRoster, status: Session.bundle().myRosterStatus }));
    const p = Session.identify("other");
    assert.equal(seen.length, 1, "fires synchronously on entering identifying");
    assert.equal(seen[0].state, "identifying");
    assert.equal(seen[0].myRoster, null);
    assert.equal(seen[0].status, "anonymous");
    assert.equal(Session.identity(), null, "the previous identity is not kept while a new one is looked up");
    assert.ok(Session.bundle().league, "league data is retained");
    // Failure does NOT silently restore the previous identity.
    d.reject(new Error("HTTP 500"));
    await assert.rejects(p, /HTTP 500/);
    assert.equal(Session.state(), "error");
    assert.equal(Session.identity(), null);
    assert.equal(Session.bundle().myRoster, null);
    // Success re-derives my roster on the committed bundle.
    r["/user/max973"] = user;
    const id = await Session.identify("max973");
    assert.equal(id.userId, "u1");
    assert.equal(Session.bundle().myRoster.roster_id, 9);
    assert.equal(Session.bundle().myRosterStatus, "found");
    assert.equal(Session.state(), "ready");
    off();
  });

  await check("10. catalog fetches /players/nfl once per document; a rejection propagates and the next call retries", async () => {
    Session._storage(fakeStorage());
    const r = { "/players/nfl": new Error("HTTP 502") };
    const { get, calls } = fakeGet(r);
    Session._get(get);
    await assert.rejects(Session.catalog(), /HTTP 502/);
    assert.equal(Session.catalogFetchedAt(), null);
    r["/players/nfl"] = { a: { position: "RB" } };
    const c1 = await Session.catalog();
    const c2 = await Session.catalog();
    assert.equal(c1, c2);
    assert.deepEqual(calls, ["/players/nfl", "/players/nfl"], "one failed attempt, one successful; the success is cached");
    assert.ok(Number.isFinite(Session.catalogFetchedAt()));
    // Two concurrent calls share one in-flight request.
    Session._storage(fakeStorage());
    calls.length = 0;
    const [x, y] = await Promise.all([Session.catalog(), Session.catalog()]);
    assert.equal(x, y);
    assert.deepEqual(calls, ["/players/nfl"]);
  });

  await check("11. ESPN: ready resolves an identity-only bundle with zero Sleeper calls", async () => {
    Session._storage(fakeStorage());
    const { get, calls } = fakeGet(routes());
    Session._get(get);
    const b = await Session.ready({ slug: "espnfam", board: { league: { league_id: "69827905" } } });
    assert.equal(b.registry.platform, "espn");
    assert.equal(b.registry.slug, "espnfam");
    assert.equal(b.league, null); assert.equal(b.users, null); assert.equal(b.rosters, null); assert.equal(b.state, null);
    assert.equal(b.myRoster, null);
    assert.equal(b.myRosterStatus, "anonymous");
    assert.equal(b.rostersFetchedAt, null);
    assert.deepEqual(calls, [], "ESPN never creates a Sleeper session");
    assert.equal(Session.state(), "ready");
    // refresh on an ESPN bundle is a no-op resolving the same bundle; still no calls.
    assert.equal(await Session.refresh(), b);
    assert.deepEqual(calls, []);
  });

  await check("12. storage: corrupt JSON -> anonymous; throwing storage -> memory-only identity; legacy key migrates", async () => {
    Session._storage(fakeStorage({ [IDENTITY_KEY]: "{not json" }));
    assert.equal(Session.identity(), null);
    assert.equal(Session.state(), "anonymous");
    // Wrong shape is corrupt too.
    Session._storage(fakeStorage({ [IDENTITY_KEY]: JSON.stringify({ username: "x" }) }));
    assert.equal(Session.identity(), null);
    // A well-formed record is restored on first use.
    Session._storage(fakeStorage({ [IDENTITY_KEY]: JSON.stringify({ username: "max973", userId: "u1", displayName: "Max973", storedAt: "2026-09-18T00:00:00Z" }) }));
    assert.deepEqual(Session.identity(), { username: "max973", userId: "u1", displayName: "Max973" });
    assert.equal(Session.state(), "identified");
    // Pure reader never throws.
    assert.equal(Session.readIdentity(fakeStorage({ [IDENTITY_KEY]: "[1,2" })), null);
    assert.equal(Session.readIdentity(throwingStorage()), null);
    assert.equal(Session.readIdentity(null), null);
    // Throwing storage: identify still resolves, state identified, identity in memory.
    Session._storage(throwingStorage());
    Session._get(fakeGet(routes()).get);
    const id = await Session.identify("max973");
    assert.equal(id.userId, "u1");
    assert.equal(Session.state(), "identified");
    assert.deepEqual(Session.identity(), id);
    assert.doesNotThrow(() => Session.forget());
    assert.equal(Session.identity(), null);
    // Legacy migration: the old username key becomes a pending username and is deleted.
    const legacy = fakeStorage({ [LEGACY_KEY]: " max973 " });
    assert.equal(Session.migrateLegacy(legacy), "max973");
    assert.equal(legacy.getItem(LEGACY_KEY), null, "the legacy key is deleted once read");
    assert.equal(Session.migrateLegacy(legacy), null, "a second migration finds nothing");
    assert.equal(Session.migrateLegacy(throwingStorage()), null);
    const legacy2 = fakeStorage({ [LEGACY_KEY]: "max973" });
    Session._storage(legacy2);
    assert.equal(Session.pendingUsername(), "max973", "the session surfaces the migrated username for the chip");
    assert.equal(Session.identity(), null, "a username alone is not an identity (no user id yet)");
    assert.equal(legacy2.getItem(LEGACY_KEY), null);
  });

  await check("13. forget deletes identity, legacy and every draft-restore record; keeps league data and unrelated keys", async () => {
    const store = fakeStorage({ [LEGACY_KEY]: "old", "fc-draft-mode:gabagool": "{}", "fc-draft-mode:fam": "{}", "unrelated": "keep", "fc-draft-mode:zzz": "{}" });
    Session._storage(store);
    const { get } = fakeGet(routes());
    Session._get(get);
    await Session.identify("max973");
    assert.ok(store.getItem(IDENTITY_KEY));
    const b1 = await Session.ready({ slug: "gabagool", board });
    assert.equal(b1.myRoster.roster_id, 9);
    const seen = [];
    const off = Session.onChange(() => seen.push(Session.state()));
    Session.forget();
    assert.deepEqual(seen, ["anonymous"], "forget fires onChange synchronously");
    assert.equal(store.getItem(IDENTITY_KEY), null);
    assert.equal(store.getItem(LEGACY_KEY), null);
    assert.equal(store.getItem("fc-draft-mode:gabagool"), null);
    assert.equal(store.getItem("fc-draft-mode:fam"), null);
    assert.equal(store.getItem("fc-draft-mode:zzz"), null, "every fc-draft-mode:* key goes, not just registry slugs");
    assert.equal(store.getItem("unrelated"), "keep");
    assert.equal(Session.identity(), null);
    assert.equal(Session.pendingUsername(), null, "forget also drops a migrated pending username");
    const b2 = Session.bundle();
    assert.ok(b2, "league bundle is kept");
    assert.equal(b2.myRoster, null);
    assert.equal(b2.myRosterStatus, "anonymous");
    assert.equal(b2.identity, null);
    assert.equal(b2.league, league); assert.equal(b2.rosters, rosters);
    assert.equal(b2.rostersFetchedAt, b1.rostersFetchedAt, "forget is not a refresh");
    assert.equal(Session.state(), "anonymous");
    off();
  });

  await check("14. chipText: the exact strings for every chip state", () => {
    const t0 = 1_700_000_000_000;
    const ready = { registry: FC.registryFor("gabagool"), identity: { username: "max973", userId: "u1", displayName: "Max973" }, league, users, rosters, state, rostersRequestedAt: t0 - 100, rostersFetchedAt: t0, myRoster: rosters[0], myRosterStatus: "found", warnings: [], generation: 1 };
    assert.equal(Session.chipText(null, "anonymous"), "Remembered on this device until you choose forget.");
    assert.equal(Session.chipText(ready, "ready", t0 + 14000), "Max973 · Gabagool Fools · your roster: 9 · rosters 14 s ago");
    assert.equal(Session.chipText(ready, "ready", t0 + 125000), "Max973 · Gabagool Fools · your roster: 9 · rosters 2 min ago");
    assert.equal(Session.chipText(ready, "refreshing", t0 + 14000), "Max973 · Gabagool Fools · your roster: 9 · rosters 14 s ago · refreshing…");
    const none = { ...ready, myRoster: null, myRosterStatus: "none" };
    const ambiguous = { ...ready, myRoster: null, myRosterStatus: "ambiguous" };
    assert.equal(Session.chipText(none, "ready", t0), "Could not uniquely match this account to a roster in this league.");
    assert.equal(Session.chipText(ambiguous, "ready", t0), "Could not uniquely match this account to a roster in this league.");
    assert.equal(Session.chipText(ready, "error", t0, "Sleeper username was not found."), "Sleeper username was not found.");
    assert.equal(Session.chipText(null, "error", t0, "HTTP 503"), "HTTP 503");
    const espn = { registry: FC.registryFor("espnfam"), identity: ready.identity, league: null, users: null, rosters: null, state: null, rostersRequestedAt: null, rostersFetchedAt: null, myRoster: null, myRosterStatus: "anonymous", warnings: [], generation: 1 };
    assert.equal(Session.chipText(espn, "ready", t0), "Max973 · ESPN family · draft board only");
    assert.equal(Session.chipText({ ...espn, identity: null }, "ready", t0), "Remembered on this device until you choose forget.");
    // An anonymous bundle (no identity) in the ready state still asks for a name.
    assert.equal(Session.chipText({ ...ready, identity: null, myRoster: null, myRosterStatus: "anonymous" }, "ready", t0), "Remembered on this device until you choose forget.");
    assert.equal(Session.chipText(null, "identifying", t0), "Looking up Sleeper account…");
    assert.equal(Session.chipText(null, "loadingLeague", t0), "Loading league…");
  });

  await check("15. unknown slug: ready rejects with no Sleeper call", async () => {
    Session._storage(fakeStorage());
    const { get, calls } = fakeGet(routes());
    Session._get(get);
    await assert.rejects(Session.ready({ slug: "nope", board }), /Unknown league/);
    await assert.rejects(Session.ready({ board }), /Unknown league/);
    assert.deepEqual(calls, []);
    assert.equal(Session.bundle(), null);
    assert.equal(Session.state(), "error");
    assert.equal(FC.registryFor("nope"), null);
    assert.equal(FC.registryFor("fam").leagueId, LF);
  });

  await check("16. leaguesFor needs a committed bundle and asks for the bundle's season", async () => {
    Session._storage(fakeStorage());
    const r = routes(); r["/user/u1/leagues/nfl/2026"] = [{ league_id: L }, { league_id: LF }];
    const { get, calls } = fakeGet(r);
    Session._get(get);
    await Session.identify("max973");
    await assert.rejects(Session.leaguesFor(), /league/i);
    await Session.ready({ slug: "gabagool", board });
    calls.length = 0;
    const leagues = await Session.leaguesFor();
    assert.deepEqual(calls, ["/user/u1/leagues/nfl/2026"]);
    assert.equal(leagues.length, 2);
    // Anonymous with a bundle: nothing to ask for.
    Session.forget();
    await assert.rejects(Session.leaguesFor(), /username|identify/i);
  });

  await check("registry and module hygiene", () => {
    assert.equal(typeof global.window, "undefined", "session.js must not create a global window in node");
    assert.ok(Object.isFrozen(Session));
    assert.deepEqual(FC.REGISTRY.map(r => r.slug), ["gabagool", "fam", "espnfam"]);
    assert.deepEqual(FC.REGISTRY.map(r => r.platform), ["sleeper", "sleeper", "espn"]);
    assert.deepEqual(FC.REGISTRY.map(r => r.leagueId), [L, LF, "69827905"]);
    assert.deepEqual(FC.REGISTRY.map(r => r.label), ["Gabagool · Sleeper", "FAM · Sleeper", "ESPN family · draft board only"]);
    assert.deepEqual(FC.registryFor("gabagool").tools, { draft: true, keepers: true, trade: true, waivers: true, startsit: true });
    assert.deepEqual(FC.registryFor("fam").tools, { draft: true, keepers: false, trade: true, waivers: true, startsit: true });
    assert.deepEqual(FC.registryFor("espnfam").tools, { draft: true, keepers: false, trade: false, waivers: false, startsit: false });
    assert.ok(Object.isFrozen(FC.REGISTRY));
    assert.equal(Session.REGISTRY, undefined, "the registry has one home: FC");
  });

  console.log(`session_fixture: ${n} groups OK`);
})().catch(e => { console.error(e); process.exit(1); });
