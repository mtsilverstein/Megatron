// tests/trademode_fixture.cjs — run with: node tests/trademode_fixture.cjs
//
// trademode.js is DOM + network, so only its assembly step is testable here:
// leagueWorld() turns a Sleeper league into the {teams, ctx} world every Trade
// function takes, and keptElsewhere() derives the other teams' keepers. Both
// are pure apart from Sleeper.get, which is stubbed below.
//
// Nothing in this file measures lineup points, so the "every synthetic board
// row needs an adp" trap does not bite here -- but every row carries one
// anyway, so a later test added to this file cannot inherit a silent zero.
const assert = require("assert");
const Sleeper = require("../site/assets/sleeper.js");
const Keepers = require("../site/assets/keepers.js");
const Trade = require("../site/assets/trade.js");
const TM = require("../site/assets/trademode.js");

let n = 0;

// --- a stubbed Sleeper ------------------------------------------------------
// Sleeper.get is read at CALL time by both trademode.js and keepers.js, so
// replacing the property here stubs the network for both.
let routes = {}, calls = [];
Sleeper.get = async function (path) {
  calls.push(path);
  if (!(path in routes)) throw new Error(`HTTP 404 (${path})`);
  const v = routes[path];
  if (v instanceof Error) throw v;
  return v;
};

// --- a small board ----------------------------------------------------------
let _id = 0;
const P = (name, position, value_points, extra) =>
  Object.assign({ name, position, value_points, vorp: value_points,
                  player_id: `b${++_id}`, sleeper_id: `s${_id}`,
                  bye: null, adp: 40 + _id, adp_round: Math.ceil((40 + _id) / 12),
                  position_rank: 1, season_points: null }, extra || {});

function board() {
  _id = 0;
  const players = [];
  for (let i = 0; i < 40; i++) {
    players.push(P(`F${i}`, ["QB", "RB", "WR", "TE"][i % 4], 200 - i * 2,
                   { adp: i + 1, adp_round: Math.ceil((i + 1) / 12) }));
  }
  return { season: 2026, players };
}

// A league whose endpoints all resolve. `rosters` is an array of
// {roster_id, owner_id, players:[sleeper ids]}.
function league(opts) {
  const o = Object.assign({ id: "L1", prev: null, rosters: [], users: [],
                            traded: [], drafted: [] }, opts || {});
  routes = {};
  calls = [];
  routes[`/league/${o.id}/users`] = o.users;
  routes[`/league/${o.id}/rosters`] = o.rosters;
  routes[`/league/${o.id}/traded_picks`] = o.traded;
  if (o.prev) {
    routes[`/league/${o.prev}`] = { league_id: o.prev, previous_league_id: null };
    routes[`/league/${o.prev}/drafts`] = [{ draft_id: "D1", status: "complete", season: "2025" }];
    routes["/draft/D1/picks"] = o.drafted;
  }
  return { league_id: o.id, name: "Test league", previous_league_id: o.prev };
}

const teamsOf = (rosterIds, players) => rosterIds.map((rid, i) => ({
  roster_id: rid, owner_id: `u${rid}`, players: players[i] || [],
}));

// Every check below is async. They are QUEUED and run one at a time, never
// started eagerly: `routes` is a single shared stub, so two checks in flight
// at once would answer each other's fetches. (Run concurrently, the first
// version of this file read another test's draft picks and asserted R12 where
// it had set up R1 -- a green-looking test measuring the wrong league.)
const queued = [];
const acheck = (label, fn) => queued.push({ label, fn });
async function runAll() {
  for (const t of queued) {
    try { await t.fn(); n++; } catch (e) {
      console.error(`${t.label}: ${e.stack || e.message}`);
      process.exit(1);
    }
  }
  console.log(`trademode_fixture: ${n} groups OK`);
}

// --- the id translation, which is the thing most worth a test ---------------

acheck("draft history is re-keyed from Sleeper ids to BOARD player ids", async () => {
  const b = board();
  const star = b.players[0];                       // player_id b1, sleeper_id s1
  const lg = league({ prev: "L0",
    rosters: teamsOf([1, 2], [[star.sleeper_id], []]),
    drafted: [{ player_id: star.sleeper_id, round: 1 }] });
  const w = await TM.leagueWorld(lg, b);

  assert.ok(w.ctx.originalByPlayerId.has(star.player_id),
    "ctx must be keyed on the board's player_id — Trade.candidate looks that up");
  assert.ok(!w.ctx.originalByPlayerId.has(star.sleeper_id),
    "a Sleeper-keyed entry would never be found by Trade.candidate");
  assert.deepStrictEqual(w.ctx.originalByPlayerId.get(star.player_id),
    { round: 1, season: 2025 });

  // The consequence, which is what actually breaks: a round-1 pick from last
  // season decays to R0 and returns to the draft pool, so he is worth nothing
  // to trade. Keyed wrongly he looks like an undrafted waiver pickup instead:
  // cost R12, keepable, and the page reads plausible while being wrong.
  const c = Trade.candidate(star, w.ctx);
  assert.strictEqual(c.isWaiver, false);
  assert.strictEqual(Keepers.keeperCost(c, 2026), 0);
  assert.strictEqual(Keepers.eligible(c, 2026), false, "he must be ineligible");

  const wrong = Object.assign({}, w.ctx, {
    originalByPlayerId: new Map([[star.sleeper_id, { round: 1, season: 2025 }]]),
  });
  assert.strictEqual(Keepers.eligible(Trade.candidate(star, wrong), 2026), true,
    "pinning the failure mode: the sleeper-keyed map makes him look keepable");
});

// --- what leagueWorld builds ------------------------------------------------

acheck("teams carry board rows, their own picks, and unmatched ids", async () => {
  const b = board();
  const a = b.players[0], c = b.players[1];
  const lg = league({ rosters: teamsOf([1, 2], [[a.sleeper_id, "ghost"], [c.sleeper_id]]) });
  const w = await TM.leagueWorld(lg, b);

  assert.strictEqual(w.teams.length, 2);
  const t1 = w.teams[0];
  assert.deepStrictEqual(t1.state.roster.map(p => p.player_id), [a.player_id]);
  assert.deepStrictEqual(t1.unmatched, ["ghost"],
    "a roster player the board can't price is kept, not silently dropped");
  // Three seasons of picks (this one plus PICK_SEASONS_AHEAD), 15 rounds each.
  assert.strictEqual(t1.state.picks.length, (TM.PICK_SEASONS_AHEAD + 1) * Keepers.DRAFT_ROUNDS);
  assert.deepStrictEqual(
    Array.from(new Set(t1.state.picks.map(p => p.season))).sort(),
    [2026, 2027, 2028]);
  // ctx satisfies Trade's five required fields (requireCtx throws otherwise).
  Trade.stateValue(t1.state, w.ctx.board, w.ctx);
  assert.strictEqual(w.ctx.season, 2026);
  assert.strictEqual(w.ctx.teams, Keepers.TEAMS);
  assert.strictEqual(w.ctx.maxKeepers, Keepers.MAX_KEEPERS);
  assert.strictEqual(w.ctx.futureDiscount, Trade.FUTURE_DISCOUNT);
});

acheck("Sleeper's `keepers` field is never read", async () => {
  const b = board();
  const a = b.players[0];
  const rosters = teamsOf([1], [[a.sleeper_id]]);
  // Pre-draft a keeper tag is meaningless -- a manager may set one BECAUSE he
  // intends to shop the player -- so this must not reach ctx in any form.
  rosters[0].keepers = [a.sleeper_id];
  const w = await TM.leagueWorld(league({ rosters }), b);
  assert.strictEqual(JSON.stringify(w.teams[0]).indexOf("keepers"), -1);
  assert.ok(!("keepers" in w.ctx));
});

acheck("a traded pick moves; the seller no longer holds it", async () => {
  const b = board();
  const lg = league({ rosters: teamsOf([1, 2], [[], []]),
    traded: [{ season: "2027", round: 3, roster_id: 1, owner_id: 2 }] });
  const w = await TM.leagueWorld(lg, b);
  const has = (t, s, r) => t.state.picks.some(p => p.season === s && p.round === r);
  assert.ok(!has(w.teams[0], 2027, 3), "team 1 sold its 2027 R3");
  assert.strictEqual(w.teams[1].state.picks.filter(
    p => p.season === 2027 && p.round === 3).length, 2, "team 2 now holds two");
  assert.ok(!w.warnings.some(x => x.indexOf("traded picks") !== -1),
    "a successful traded_picks fetch must not warn about ownership");
});

acheck("a failed traded_picks fetch warns and falls back to default ownership", async () => {
  const b = board();
  const lg = league({ rosters: teamsOf([1, 2], [[], []]) });
  routes["/league/L1/traded_picks"] = new Error("HTTP 500");
  const w = await TM.leagueWorld(lg, b);
  assert.ok(w.warnings.some(x => x.indexOf("couldn't read traded picks") === 0),
    `expected a traded-picks warning, got ${JSON.stringify(w.warnings)}`);
  // Never guess ownership: everyone holds exactly their own.
  for (const t of w.teams) {
    assert.strictEqual(t.state.picks.length,
      (TM.PICK_SEASONS_AHEAD + 1) * Keepers.DRAFT_ROUNDS);
  }
});

acheck("a failed rosters fetch is fatal, not a quiet empty league", async () => {
  const b = board();
  const lg = league({ rosters: teamsOf([1], [[]]) });
  routes["/league/L1/rosters"] = new Error("HTTP 500");
  await assert.rejects(() => TM.leagueWorld(lg, b), /HTTP 500/);
});

acheck("no prior season is announced, not absorbed", async () => {
  const b = board();
  const w = await TM.leagueWorld(league({ rosters: teamsOf([1], [[]]) }), b);
  assert.strictEqual(w.ctx.originalByPlayerId.size, 0);
  assert.ok(w.warnings.some(x => x.indexOf("no prior season") === 0),
    `expected a no-prior-season warning, got ${JSON.stringify(w.warnings)}`);
});

acheck("an empty draft chain is announced too — an empty map is not neutral", async () => {
  // With no history every player is a first-time R12 keeper and NOBODY is
  // ineligible, which is a strong claim to make silently.
  const b = board();
  const lg = league({ prev: "L0", rosters: teamsOf([1], [[]]), drafted: [] });
  const w = await TM.leagueWorld(lg, b);
  assert.ok(w.warnings.some(x => x.indexOf("no draft history") === 0),
    `expected an empty-history warning, got ${JSON.stringify(w.warnings)}`);
});

acheck("a league that is not 12 teams says so", async () => {
  const b = board();
  const rosterIds = [];
  for (let i = 1; i <= 10; i++) rosterIds.push(i);
  const w = await TM.leagueWorld(
    league({ rosters: teamsOf(rosterIds, rosterIds.map(() => [])) }), b);
  assert.ok(w.warnings.some(x => x.indexOf("this league has 10 teams") === 0),
    `expected a league-size warning, got ${JSON.stringify(w.warnings)}`);
  assert.strictEqual(w.ctx.teams, Keepers.TEAMS,
    "pick pricing still states the league rule explicitly");
});

acheck("team names come from the team name, then the display name, then the id", async () => {
  const b = board();
  const rosters = teamsOf([1, 2, 3], [[], [], []]);
  const users = [
    { user_id: "u1", display_name: "andy", metadata: { team_name: "The Team Name" } },
    { user_id: "u2", display_name: "beth", metadata: {} },
  ];
  const w = await TM.leagueWorld(league({ rosters, users }), b);
  assert.deepStrictEqual(w.teams.map(t => t.name),
    ["The Team Name", "beth", "Roster 3"]);
});

// --- keptElsewhere ----------------------------------------------------------

// Both groups below give the non-excluded team THREE players on a DEPLETED
// current-season complement (2026 R1-R8 traded away, R9-R15 held), not one --
// a one-player roster keeps that player for any pick list at all, which is
// the seventh instance on this branch of a fixture that cannot fail
// regardless of what the code under test does (see final-fixes-wave7.md item
// 3). Anchor (cost R10) is kept on both complements; the second slot is a
// genuine decision the pick list resolves: Decoy (cost R3, value 160) beats
// Never (cost R14, value 40) on a full complement, where his cost round costs
// only a mid-round pick -- but on the depleted one, his cost round has been
// traded away, so `unspentPicks` charges him the team's single dearest
// remaining pick (R9) instead, and that premium flips the decision to Never.
// Confirmed by direct computation before being pinned here, and by mutation:
// reverting trademode.js:226 to score a complement that ignores the traded
// picks keeps Decoy on BOTH worlds, same as the pre-fix code did.
acheck("keptElsewhere holds every OTHER team's keepers and neither trader's", async () => {
  const b = board();
  const mineP = b.players[0], theirP = b.players[1];
  const anchor = P("Anchor", "RB", 200), decoy = P("Decoy", "WR", 160), never = P("Never", "TE", 40);
  b.players.push(anchor, decoy, never);
  const lg = league({ prev: "L0",
    rosters: teamsOf([1, 2, 3, 4],
      [[mineP.sleeper_id], [theirP.sleeper_id],
       [anchor.sleeper_id, decoy.sleeper_id, never.sleeper_id], []]),
    drafted: [
      { player_id: mineP.sleeper_id, round: 12 },
      { player_id: theirP.sleeper_id, round: 12 },
      { player_id: anchor.sleeper_id, round: 11 },   // cost R10
      { player_id: decoy.sleeper_id, round: 4 },     // cost R3 -- in the traded-away range
      { player_id: never.sleeper_id, round: 15 },    // cost R14 -- untouched by the trade
    ],
    // Team 3's 2026 R1-R8 move to team 4, leaving it R9-R15 only this season.
    traded: Array.from({ length: 8 }, (_, i) =>
      ({ season: "2026", round: i + 1, roster_id: 3, owner_id: 4 })) });
  const w = await TM.leagueWorld(lg, b);

  const gone = TM.keptElsewhere(w.teams, w.ctx, [1, 2]);
  assert.ok(gone.has(anchor.player_id), "team 3 keeps its anchor regardless of the complement");
  assert.ok(gone.has(never.player_id) && !gone.has(decoy.player_id),
    "on the depleted complement Decoy's early cost round eats the team's best " +
    "remaining pick and loses to the nearly-free Never -- this is the decision " +
    "trademode.js:226 must make against the picks the state ACTUALLY holds");
  assert.ok(!gone.has(mineP.player_id), "my keepers are derived inside the trade");
  assert.ok(!gone.has(theirP.player_id), "so are the partner's");
  // ...and it really is a function of the exclusion list, i.e. it MUST be
  // recomputed when the partner changes.
  const swapped = TM.keptElsewhere(w.teams, w.ctx, [1, 3]);
  assert.ok(swapped.has(theirP.player_id) && !swapped.has(anchor.player_id)
    && !swapped.has(decoy.player_id) && !swapped.has(never.player_id),
    "changing the partner changes who is off the pool");
});

acheck("keptElsewhere does not depend on what ctx.keptElsewhere already held", async () => {
  const b = board();
  const p1 = b.players[0];
  const anchor = P("Anchor", "RB", 200), decoy = P("Decoy", "WR", 160), never = P("Never", "TE", 40);
  b.players.push(anchor, decoy, never);
  const lg = league({ prev: "L0",
    rosters: teamsOf([1, 2, 3],
      [[p1.sleeper_id], [anchor.sleeper_id, decoy.sleeper_id, never.sleeper_id], []]),
    drafted: [
      { player_id: p1.sleeper_id, round: 12 },
      { player_id: anchor.sleeper_id, round: 11 },
      { player_id: decoy.sleeper_id, round: 4 },
      { player_id: never.sleeper_id, round: 15 },
    ],
    traded: Array.from({ length: 8 }, (_, i) =>
      ({ season: "2026", round: i + 1, roster_id: 2, owner_id: 3 })) });
  const w = await TM.leagueWorld(lg, b);
  const clean = TM.keptElsewhere(w.teams, w.ctx, [1]);
  // Pinned, not just "unchanged" -- otherwise this measures idempotence in a
  // value nobody checked, the same defect as the one-player version.
  assert.deepStrictEqual(Array.from(clean).sort(), [anchor.player_id, never.player_id].sort());
  w.ctx.keptElsewhere = new Set([decoy.player_id]);
  const after = TM.keptElsewhere(w.teams, w.ctx, [1]);
  assert.deepStrictEqual(Array.from(after).sort(), Array.from(clean).sort());
});

runAll();
