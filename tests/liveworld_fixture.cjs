// tests/liveworld_fixture.cjs — run with: node tests/liveworld_fixture.cjs
//
// The shared live-world resolver (LiveWorld.resolve) every in-season page
// reads: league, rosters and the roster under analysis (owner or viewer) from
// the committed Session bundle, with NO registry, board, scoring, waiver-type
// or team-count checks. WaiverMode.loadWorld is a thin wrapper: resolve + the
// week's transactions (bundle.extra reuse) + the waiver-type check.
// All league data here is synthetic (fictional owners and ids).
const assert = require("node:assert/strict");

global.window = {};
const LiveWorld = require("../site/assets/liveworld.js");
assert.equal(window.LiveWorld, LiveWorld, "the browser global is set");
const WaiverMode = require("../site/assets/waivermode.js");

const NO_ANALYSIS = "Enter your Sleeper username, or choose a team to view.";
const UNSUPPORTED = "This league type isn't supported yet.";
const ID = "900000000000000123";            // not in the registry
const users = [{ user_id: "u1", display_name: "Owner One" }, { user_id: "u2", display_name: "Owner Two" }];
const rosters = [
  { roster_id: 1, owner_id: "u1", players: ["p1"], starters: ["p1"] },
  { roster_id: 2, owner_id: "u2", players: ["p2"], starters: ["p2"] },
];
const league = { league_id: ID, name: "Synthetic League", season: "2026", status: "in_season", total_rosters: 14,
  settings: { type: 0, waiver_type: 2, best_ball: 0 }, scoring_settings: { rec: 0.5, pass_td: 6 },
  roster_positions: ["QB", "RB", "WR", "TE", "SUPER_FLEX", "BN"] };
const state = { season: "2026", season_type: "regular", week: 5 };
function bundleOf(over = {}) {
  return Object.freeze({
    registry: { slug: null, platform: "sleeper", leagueId: ID, label: "Sleeper league" },
    identity: { username: "one", userId: "u1", displayName: "Owner One" },
    league, users, rosters, state,
    leagueFetchedAt: 1700000000100, rostersRequestedAt: 1700000000000, rostersFetchedAt: 1700000000750,
    myRoster: rosters[0], myRosterStatus: "found",
    viewedRosterId: null, analysisRoster: rosters[0], analysisRole: "owner",
    warnings: [], extra: null, generation: 3,
    ...over,
  });
}
const viewer = bundleOf({ identity: null, myRoster: null, myRosterStatus: "anonymous", viewedRosterId: 2, analysisRoster: rosters[1], analysisRole: "viewer" });
const withLeague = patch => bundleOf({ league: { ...league, ...patch, settings: { ...league.settings, ...(patch.settings || {}) } } });

// 1. Owner and viewer both resolve, with their role.
const owner = LiveWorld.resolve({ bundle: bundleOf(), week: 5 });
assert.equal(owner.role, "owner"); assert.equal(owner.rosterId, 1);
assert.equal(owner.league, league); assert.equal(owner.rosters, rosters); assert.equal(owner.users, users); assert.equal(owner.state, state);
assert.equal(owner.requestedAt, 1700000000000, "requestedAt: the PRE-request number (kickoff gate)");
assert.equal(owner.fetchedAt, new Date(1700000000750).toISOString(), "fetchedAt: the POST-fetch ISO string (60 s expiry)");
assert.equal(owner.leagueFetchedAt, 1700000000100);
assert.deepEqual(Object.keys(owner).sort(), ["fetchedAt", "league", "leagueFetchedAt", "requestedAt", "role", "rosterId", "rosters", "state", "users"]);
const view = LiveWorld.resolve({ bundle: viewer, week: 5 });
assert.equal(view.role, "viewer"); assert.equal(view.rosterId, 2, "a viewer resolves the team they chose");

// 2. No roster under analysis -> the one message (anonymous, none, ambiguous, role without roster).
for (const b of [
  bundleOf({ identity: null, myRoster: null, myRosterStatus: "anonymous", analysisRoster: null, analysisRole: null }),
  bundleOf({ myRoster: null, myRosterStatus: "none", analysisRoster: null, analysisRole: null }),
  bundleOf({ myRoster: null, myRosterStatus: "ambiguous", analysisRoster: null, analysisRole: null }),
  bundleOf({ analysisRole: null }),
  bundleOf({ analysisRoster: undefined }),
]) assert.throws(() => LiveWorld.resolve({ bundle: b, week: 5 }), e => e.message === NO_ANALYSIS);
// The analysis roster must be one of the bundle's rosters.
assert.throws(() => LiveWorld.resolve({ bundle: bundleOf({ analysisRoster: { roster_id: 99 } }), week: 5 }), /incomplete roster data/);

// 3. Not in season -> `This league is {status}, not in season.`
for (const status of ["pre_draft", "drafting", "complete"])
  assert.throws(() => LiveWorld.resolve({ bundle: withLeague({ status }), week: 5 }), e => e.message === `This league is ${status}, not in season.`);

// 4. League types: 0/1/2 supported (best ball too), anything else -> LeagueData's message.
for (const type of [0, 1, 2]) assert.equal(LiveWorld.resolve({ bundle: withLeague({ settings: { type } }), week: 5 }).rosterId, 1);
assert.equal(LiveWorld.resolve({ bundle: withLeague({ settings: { best_ball: 1 } }), week: 5 }).role, "owner", "best ball resolves; pages decide what to show");
for (const type of [9, 3, undefined, "0"])
  assert.throws(() => LiveWorld.resolve({ bundle: withLeague({ settings: { type } }), week: 5 }), e => e.message === UNSUPPORTED);

// 5. No registry, board, scoring, waiver-type or team-count checks.
assert.equal(LiveWorld.resolve({ bundle: bundleOf({ registry: null }), week: 5 }).rosterId, 1, "an unregistered id works without a registry");
assert.equal(LiveWorld.resolve({ bundle: bundleOf({ registry: { slug: "gabagool", platform: "sleeper", leagueId: "1" } }), week: 5 }).rosterId, 1, "a registry row for another league is not consulted");
assert.equal(LiveWorld.resolve({ bundle: withLeague({ total_rosters: 3, scoring_settings: { bonus_rec_te: 1, idp_tkl: 2 } }), week: 5 }).rosterId, 1);
assert.equal(LiveWorld.resolve({ bundle: withLeague({ settings: { waiver_type: 3 } }), week: 5 }).rosterId, 1, "resolve accepts waiver_type 3");

// 6. Input and snapshot guards.
for (const week of [0, 19, 1.5, "5", null, undefined, NaN])
  assert.throws(() => LiveWorld.resolve({ bundle: bundleOf(), week }), /Week must be an integer from 1 to 18\./);
for (const w of [1, 18]) assert.equal(LiveWorld.resolve({ bundle: bundleOf(), week: w }).rosterId, 1);
assert.throws(() => LiveWorld.resolve({ bundle: null, week: 5 }), /No league session is loaded/);
assert.throws(() => LiveWorld.resolve({ week: 5 }), /No league session is loaded/);
assert.throws(() => LiveWorld.resolve({ bundle: bundleOf({ league: null }), week: 5 }), /incomplete league data/);
assert.throws(() => LiveWorld.resolve({ bundle: bundleOf({ rosters: null }), week: 5 }), /incomplete roster data/);
assert.throws(() => LiveWorld.resolve({ bundle: bundleOf({ rostersRequestedAt: null }), week: 5 }), /timestamps are missing/);
assert.throws(() => LiveWorld.resolve({ bundle: bundleOf({ rostersFetchedAt: NaN }), week: 5 }), /timestamps are missing/);
assert.throws(() => LiveWorld.resolve({ bundle: bundleOf({ rostersFetchedAt: "1700000000750" }), week: 5 }), /timestamps are missing/);

// 7. WaiverMode.loadWorld: resolve + transactions + waiver type {0,1,2}.
(async () => {
  const calls = [];
  const get = async p => { calls.push(p); if (p === `/league/${ID}/transactions/5`) return [{ type: "waiver" }]; throw new Error(`unexpected ${p}`); };
  const w = await WaiverMode.loadWorld({ bundle: bundleOf({ registry: null }), week: 5, get });
  assert.deepEqual(calls, [`/league/${ID}/transactions/5`], "the league id comes from the live bundle");
  assert.deepEqual(w.transactions, [{ type: "waiver" }]);
  assert.equal(w.rosterId, 1); assert.equal(w.role, "owner");
  assert.equal(w.fetchedAt, new Date(1700000000750).toISOString()); assert.equal(w.requestedAt, 1700000000000);
  const wv = await WaiverMode.loadWorld({ bundle: viewer, week: 5, get });
  assert.equal(wv.role, "viewer"); assert.equal(wv.rosterId, 2);
  for (const waiver_type of [0, 1, 2]) assert.equal((await WaiverMode.loadWorld({ bundle: withLeague({ settings: { waiver_type } }), week: 5, get })).rosterId, 1);
  // bundle.extra for THIS week is reused; another week's is ignored.
  calls.length = 0;
  const cached = await WaiverMode.loadWorld({ bundle: bundleOf({ extra: { week: 5, transactions: [{ type: "cached" }] } }), week: 5, get });
  assert.deepEqual(cached.transactions, [{ type: "cached" }]); assert.equal(calls.length, 0);
  const stale = await WaiverMode.loadWorld({ bundle: bundleOf({ extra: { week: 4, transactions: [{ type: "stale" }] } }), week: 5, get });
  assert.deepEqual(stale.transactions, [{ type: "waiver" }]);
  // Refusals before any fetch: waiver type 3 (resolve accepts it), and resolve's own refusals.
  calls.length = 0;
  for (const waiver_type of [3, undefined, null, "2"])
    await assert.rejects(WaiverMode.loadWorld({ bundle: withLeague({ settings: { waiver_type } }), week: 5, get }), /waiver/i);
  await assert.rejects(WaiverMode.loadWorld({ bundle: bundleOf({ analysisRoster: null, analysisRole: null }), week: 5, get }), e => e.message === NO_ANALYSIS);
  await assert.rejects(WaiverMode.loadWorld({ bundle: withLeague({ status: "drafting" }), week: 5, get }), e => e.message === "This league is drafting, not in season.");
  await assert.rejects(WaiverMode.loadWorld({ bundle: withLeague({ settings: { type: 9 } }), week: 5, get }), e => e.message === UNSUPPORTED);
  assert.equal(calls.length, 0, "every refusal happens before the transactions fetch");
  await assert.rejects(WaiverMode.loadWorld({ bundle: bundleOf(), week: 5, get: async () => ({}) }), /incomplete transaction/);
  console.log("liveworld_fixture: owner/viewer resolve, analysis-roster/in-season/type refusals, no registry/board/scoring/team-count checks, waiver wrapper OK");
})().catch(e => { console.error(e); process.exit(1); });
