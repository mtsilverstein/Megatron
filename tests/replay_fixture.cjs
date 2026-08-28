// tests/replay_fixture.cjs — run with: node tests/replay_fixture.cjs
//
// Guards the draft replay. A replay is only worth running if its
// reconstruction of the board is right; a wrong one does not error, it just
// reports a confident number about a draft that never existed. The first run
// of this replay treated keepers as available until their pick number came up
// and reported 3/13 agreement with 504 VORP left on the table. The truth was
// 12/13 and 9. That failure is the first test below.
const assert = require("assert");
const R = require("../tools/replay_draft.cjs");
const O = require("../site/assets/optimizer.js");

let n = 0;
const check = (label, fn) => { fn(); n++; };

// A toy board: strictly decreasing value, so "best available" is unambiguous.
function toyBoard() {
  const pos = ["RB", "WR", "RB", "WR", "TE", "QB"];
  const players = [];
  for (let i = 1; i <= 120; i++) {
    players.push({
      player_id: `g${i}`, sleeper_id: String(i), name: `P${i}`,
      position: pos[i % pos.length], adp: i, bye: (i % 14) + 1,
      value_points: 400 - i, vorp: 200 - i, position_rank: i,
      season_points: null,
    });
  }
  return O.withValuePoints(players).filter(p => Number.isFinite(O.seasonValue(p)));
}

// 12-team snake pick numbers.
const pickNo = (round, slot) =>
  round % 2 === 0 ? round * 12 - slot + 1 : (round - 1) * 12 + slot;

// A pick log where every seat takes the next player off the board in order,
// except that `keepers` are pre-assigned at the pick numbers they cost.
function toyLog(keepers = [], rounds = 4) {
  const kept = new Map(keepers.map(k => [`${k.round}:${k.slot}`, k]));
  const out = [];
  let next = 1;
  const takenIds = new Set(keepers.map(k => String(k.sleeper_id)));
  for (const k of keepers) {
    out.push({ round: k.round, draft_slot: k.slot, pick_no: pickNo(k.round, k.slot),
               player_id: String(k.sleeper_id), is_keeper: true, picked_by: "u" + k.slot,
               metadata: { position: "RB" } });
  }
  for (let round = 1; round <= rounds; round++) {
    for (let slot = 1; slot <= 12; slot++) {
      if (kept.has(`${round}:${slot}`)) continue;
      while (takenIds.has(String(next))) next++;
      out.push({ round, draft_slot: slot, pick_no: pickNo(round, slot),
                 player_id: String(next), is_keeper: false, picked_by: "u" + slot,
                 metadata: { position: "RB" } });
      takenIds.add(String(next));
    }
  }
  return out.sort((a, b) => a.pick_no - b.pick_no);
}

const replay = (log, slot, rounds = 4) => R.replaySeat({
  players: toyBoard(), picks: log, slot, teams: 12, rounds, reversalRound: 0,
  type: "snake",
});

// --- stateBefore: the rule the whole replay rests on -------------------------

check("a keeper is gone from pick 1, not from the pick number he cost", () => {
  // P1 is the best player on the board and is kept at #40 (round 4, slot 9).
  const log = toyLog([{ round: 4, slot: 9, sleeper_id: 1 }]);
  const before = R.stateBefore(log, 10);          // reconstructing pick #10
  assert.ok(before.some(x => x.player_id === "1" && x.is_keeper),
            "the keeper was treated as still on the board at pick #10");
});

check("a non-keeper is gone only once his pick has passed", () => {
  const log = toyLog();
  const at30 = R.stateBefore(log, 30).map(x => x.pick_no);
  assert.ok(at30.every(p => p < 30), "a later pick leaked into the past");
  assert.ok(at30.includes(29) && at30.includes(1), "an earlier pick went missing");
  assert.strictEqual(at30.length, 29);
});

check("stateBefore at pick 1 is only the keepers", () => {
  const log = toyLog([{ round: 4, slot: 9, sleeper_id: 1 },
                      { round: 3, slot: 2, sleeper_id: 2 }]);
  const before = R.stateBefore(log, 1);
  assert.strictEqual(before.length, 2);
  assert.ok(before.every(x => x.is_keeper));
});

// --- replaySeat --------------------------------------------------------------

check("the tool is never offered a kept player", () => {
  // THE ORIGINAL BUG. P1 is the best player alive and is kept by slot 9 at a
  // pick number far in the future. Slot 1 picks first overall; if keepers were
  // filtered by pick_no the tool would recommend P1 to a seat that could never
  // have had him.
  const log = toyLog([{ round: 4, slot: 9, sleeper_id: 1 }]);
  const rows = replay(log, 1);
  assert.ok(rows.length > 0);
  assert.notStrictEqual(rows[0].tool.name, "P1",
                        "recommended a player another team keeps");
});

check("only this seat's own non-keeper picks are replayed", () => {
  const log = toyLog([{ round: 2, slot: 5, sleeper_id: 3 }]);
  const rows = replay(log, 5);
  assert.strictEqual(rows.length, 3, "4 rounds minus the round spent on a keeper");
  assert.ok(!rows.some(r => r.round === 2), "replayed a round spent on a keeper");
  const mine = new Set(log.filter(x => x.draft_slot === 5).map(x => x.pick_no));
  assert.ok(rows.every(r => mine.has(r.pick_no)), "replayed another seat's pick");
});

check("the reconstruction's pick math is reported, not assumed", () => {
  const log = toyLog([{ round: 2, slot: 5, sleeper_id: 3 }]);
  const rows = replay(log, 5);
  assert.ok(rows.every(r => r.plan_matches_reality),
            "planFromPicks disagreed with the real pick numbers");
  assert.ok(rows.every(r => r.planned_next === r.pick_no));
});

check("agreed is true only when the tool names the same player", () => {
  const log = toyLog();
  const rows = replay(log, 1);
  for (const r of rows) {
    if (r.agreed) assert.strictEqual(r.tool.name, r.took.name);
    else if (r.tool) assert.notStrictEqual(r.tool.name, r.took.name);
  }
});

check("a pick of someone not on the board is reported, not dropped", () => {
  // K and DST are real picks this board does not model. Losing them silently
  // would understate how many picks a seat actually made.
  const log = toyLog();
  const mine = log.find(x => x.draft_slot === 1 && x.round === 3);
  mine.player_id = "not-on-our-board";
  const rows = replay(log, 1);
  const row = rows.find(r => r.round === 3);
  assert.ok(row, "the pick vanished from the replay");
  assert.strictEqual(row.took.name, null);
  assert.strictEqual(row.took.off_board, true);
  assert.strictEqual(row.took.vorp, 0);
});

check("the roster the tool reasoned from is this seat's, and grows", () => {
  // held feeds myPlayers into recommend, so a recommendation only means
  // anything against the right roster. An empty held would still produce
  // plausible-looking output, which is why this is asserted directly.
  const rows = replay(toyLog(), 1);
  assert.deepStrictEqual(rows[0].held, [], "nothing is held before your first pick");
  assert.strictEqual(rows[1].held.length, 1);
  assert.strictEqual(rows[2].held.length, 2);
  assert.ok(rows[1].held[0].endsWith(rows[0].took.name),
            "the player you just took was not on the roster at your next pick");
});

check("a seat keeps its keepers on the roster from its first pick", () => {
  const rows = replay(toyLog([{ round: 4, slot: 1, sleeper_id: 7 }]), 1);
  assert.strictEqual(rows[0].held.length, 1, "your own keeper was missing at pick 1");
  assert.ok(rows[0].held[0].endsWith(" P7"), "the wrong player was held");
});

check("a pick the tool would not have made is flagged as disagreement", () => {
  // Every seat in toyLog takes best-available, so the tool agrees with
  // everything and a broken `agreed` would look fine. Force one real
  // divergence: slot 1 reaches for a much worse player in round 2.
  const log = toyLog();
  const r2 = log.find(x => x.draft_slot === 1 && x.round === 2 && !x.is_keeper);
  r2.player_id = "110";
  const rows = replay(log, 1);
  const row = rows.find(r => r.round === 2);
  assert.strictEqual(row.took.name, "P110");
  assert.strictEqual(row.agreed, false, "a clearly worse pick was called agreement");
  assert.ok(row.tool && row.tool.vorp > row.took.vorp,
            "the tool did not prefer a better player");
  assert.ok(rows.some(r => r.agreed), "nothing agreed, so the test proves nothing");
});

check("a pick made at an impossible number voids the replay", () => {
  // If the reconstruction picks at numbers the real draft never used, it was
  // not looking at the board the drafter saw -- so it must say so.
  const log = toyLog();
  const mine = log.find(x => x.draft_slot === 1 && x.round === 3);
  mine.pick_no = mine.pick_no + 1;               // a number this seat never had
  const rows = replay(log, 1);
  const row = rows.find(r => r.round === 3);
  assert.strictEqual(row.plan_matches_reality, false);
  assert.notStrictEqual(row.planned_next, row.pick_no);
  assert.strictEqual(R.summarize(rows).pick_math_matches_reality, false);
});

// --- summarize ---------------------------------------------------------------

check("summarize counts agreement and the value forgone", () => {
  const rows = [
    { agreed: true, took: { vorp: 10 }, tool: { vorp: 10 }, plan_matches_reality: true },
    { agreed: false, took: { vorp: 3 }, tool: { vorp: 12 }, plan_matches_reality: true },
    { agreed: false, took: { vorp: 5 }, tool: { vorp: 8 }, plan_matches_reality: true },
  ];
  const s = R.summarize(rows);
  assert.strictEqual(s.picks, 3);
  assert.strictEqual(s.agreed, 1);
  assert.strictEqual(s.agreement_rate, 0.333);
  assert.strictEqual(s.vorp_left_on_table, 12);   // (12-3) + (8-5)
  assert.strictEqual(s.pick_math_matches_reality, true);
});

check("one bad pick number voids the whole replay", () => {
  const rows = [
    { agreed: true, took: { vorp: 1 }, tool: { vorp: 1 }, plan_matches_reality: true },
    { agreed: true, took: { vorp: 1 }, tool: { vorp: 1 }, plan_matches_reality: false },
  ];
  assert.strictEqual(R.summarize(rows).pick_math_matches_reality, false);
});

check("an empty replay does not claim its pick math checked out", () => {
  // Vacuous truth here would read as "verified" on a replay that ran nothing.
  const s = R.summarize([]);
  assert.strictEqual(s.picks, 0);
  assert.strictEqual(s.agreement_rate, null);
  assert.strictEqual(s.pick_math_matches_reality, false);
});

check("a pick with no recommendation still counts against the total", () => {
  const s = R.summarize([{ agreed: false, took: { vorp: 4 }, tool: null,
                           plan_matches_reality: true }]);
  assert.strictEqual(s.picks, 1);
  assert.strictEqual(s.agreed, 0);
  assert.strictEqual(s.vorp_left_on_table, -4);
});

console.log(`replay fixture: ${n} groups OK`);
