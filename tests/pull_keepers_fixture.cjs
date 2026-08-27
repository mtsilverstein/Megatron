// tests/pull_keepers_fixture.cjs — run with: node tests/pull_keepers_fixture.cjs
//
// Guards the keeper snapshot builder. The snapshot decides which players the
// draft simulation removes from the pool, so a quiet mistake here does not
// produce an error -- it produces a confident simulation of a draft that
// cannot happen. The network call is not tested; the mapping rules are, which
// is where the failures live.
const assert = require("assert");
const K = require("../tools/pull_keepers.cjs");

let n = 0;
const check = (label, fn) => { fn(); n++; };

const LEAGUE = { league_id: "L", name: "toy league", season: "2026", total_rosters: 12 };
const DRAFT = { draft_id: "D", draft_order: { u1: 10, u2: 3 },
                settings: { teams: 12, rounds: 15, reversal_round: 0 },
                start_time: 123 };
const USERS = [{ user_id: "u1", display_name: "Max973" },
               { user_id: "u2", display_name: "someone" }];
const BOARD = [{ player_id: "00-1", name: "Real Guy", position: "TE", sleeper_id: "111" },
               { player_id: "00-2", name: "Other Guy", position: "RB", sleeper_id: "222" }];
const keep = (slot, sleeperId, over = {}) => Object.assign(
  { is_keeper: true, round: 8, draft_slot: slot, pick_no: 87,
    player_id: sleeperId, metadata: {} }, over);
const build = picks => K.buildSnapshot({ league: LEAGUE, draft: DRAFT, picks,
                                         users: USERS, boardPlayers: BOARD });

check("a keeper is mapped onto the board's own player_id", () => {
  // The sim matches on player_id, not sleeper_id; an unmapped keeper is one
  // the sim cannot remove from the pool.
  const snap = build([keep(10, "111")]);
  assert.strictEqual(snap.keepers.length, 1);
  assert.strictEqual(snap.keepers[0].player_id, "00-1");
  assert.strictEqual(snap.keepers[0].name, "Real Guy");
  assert.strictEqual(snap.keepers[0].position, "TE");
  assert.strictEqual(snap.unmapped.length, 0);
});

check("the keeper is attributed to the team that actually holds the slot", () => {
  // draft_order is {user_id: slot}; getting this backwards would hand every
  // keeper to the wrong roster and the error would be invisible in aggregate.
  const snap = build([keep(10, "111"), keep(3, "222")]);
  const bySlot = Object.fromEntries(snap.keepers.map(k => [k.slot, k.team]));
  assert.strictEqual(bySlot[10], "Max973");
  assert.strictEqual(bySlot[3], "someone");
});

check("non-keeper picks are not treated as keepers", () => {
  // Once a draft is under way its ordinary picks appear on the same endpoint.
  // Folding those in would hold real draft results out of the pool.
  const snap = build([keep(10, "111"), keep(3, "222", { is_keeper: false })]);
  assert.strictEqual(snap.keepers.length, 1);
  assert.strictEqual(snap.keepers[0].player_id, "00-1");
});

check("keepers come back in pick order", () => {
  const snap = build([keep(10, "111", { pick_no: 135, round: 12 }),
                      keep(3, "222", { pick_no: 40, round: 4 })]);
  assert.deepStrictEqual(snap.keepers.map(k => k.pick_no), [40, 135]);
});

check("a keeper not on the board is recorded as unmapped, never dropped", () => {
  const snap = build([keep(10, "111"),
                      keep(3, "999", { metadata: { first_name: "Ghost",
                                                   last_name: "Player",
                                                   position: "WR" } })]);
  assert.strictEqual(snap.keepers.length, 1);
  assert.strictEqual(snap.unmapped.length, 1);
  assert.strictEqual(snap.unmapped[0].sleeper_id, "999");
  assert.strictEqual(snap.unmapped[0].name, "Ghost Player");
});

check("an unmapped keeper refuses the whole snapshot", () => {
  // Publishing it would leave that player draftable while his owner drafts
  // without the pick he cost -- two errors that both enlarge the pool.
  const snap = build([keep(10, "111"), keep(3, "999")]);
  assert.throws(() => K.assertAllMapped(snap), /not on the board/);
  // and the error must name the player, or it cannot be acted on
  assert.throws(() => K.assertAllMapped(snap), /999/);
});

check("a fully mapped snapshot passes", () => {
  assert.doesNotThrow(() => K.assertAllMapped(build([keep(10, "111"),
                                                     keep(3, "222")])));
});

check("draft shape is carried through for the sim to check", () => {
  // draft_sim.loadKeepers refuses a snapshot whose shape differs from what it
  // simulates; it can only do that if these fields survive the build.
  const snap = build([keep(10, "111")]);
  assert.strictEqual(snap.teams, 12);
  assert.strictEqual(snap.rounds, 15);
  assert.strictEqual(snap.reversal_round, 0);
});

console.log(`pull_keepers fixture: ${n} groups OK`);
