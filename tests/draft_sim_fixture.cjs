// tests/draft_sim_fixture.cjs — run with: node tests/draft_sim_fixture.cjs
//
// Guards the draft-strategy backtest harness. The harness produces the numbers
// that decide whether the optimizer is worth trusting, so its own arithmetic
// has to be pinned -- a silently wrong scorer would produce a confident,
// meaningless answer. The first run of this harness did exactly that: with no
// market column the field drafted nobody and it reported a +2470 point edge
// and a 100% win rate. `assertWorldUsable` exists because of that, and is
// tested here.
const assert = require("assert");
const S = require("../tools/draft_sim.cjs");

let n = 0;
const check = (label, fn) => { fn(); n++; };

const P = (id, position, adp) => ({ player_id: id, name: id, position, adp,
                                    value_points: 100, vorp: 10 });

// --- actualPoints: best legal lineup, re-picked every week ------------------
check("scores the best legal lineup each week", () => {
  const roster = [P("qb", "QB"), P("rb1", "RB"), P("rb2", "RB"),
                  P("wr1", "WR"), P("wr2", "WR"), P("te", "TE")];
  const weeks = { qb: { 1: 20 }, rb1: { 1: 10 }, rb2: { 1: 9 },
                  wr1: { 1: 8 }, wr2: { 1: 7 }, te: { 1: 6 } };
  // 6 starters, no flex-eligible leftovers -> straight sum
  assert.strictEqual(S.actualPoints(roster, weeks, 1), 60);
});

check("flex takes the best leftovers, not the first ones", () => {
  const roster = [P("rb1", "RB"), P("rb2", "RB"), P("rb3", "RB"), P("rb4", "RB"),
                  P("rb5", "RB")];
  const weeks = { rb1: { 1: 1 }, rb2: { 1: 2 }, rb3: { 1: 30 },
                  rb4: { 1: 40 }, rb5: { 1: 3 } };
  // 2 dedicated RB + 2 flex = the top FOUR score: 40+30+3+2 = 75
  assert.strictEqual(S.actualPoints(roster, weeks, 1), 75);
});

check("a week a player did not play is a hole, not a scored zero", () => {
  const roster = [P("rb1", "RB"), P("rb2", "RB")];
  // rb2 has no week-2 row at all (bye/injury/inactive)
  const weeks = { rb1: { 1: 10, 2: 10 }, rb2: { 1: 5 } };
  assert.strictEqual(S.actualPoints(roster, weeks, 2), 25);
  // and an explicit 0 IS scored -- he played and did nothing
  const weeks0 = { rb1: { 1: 10, 2: 10 }, rb2: { 1: 5, 2: 0 } };
  assert.strictEqual(S.actualPoints(roster, weeks0, 2), 25);
});

check("only weeks up to the window are counted", () => {
  const roster = [P("rb1", "RB")];
  const weeks = { rb1: { 1: 10, 2: 10, 15: 100 } };
  assert.strictEqual(S.actualPoints(roster, weeks, 14), 20);
  assert.strictEqual(S.actualPoints(roster, weeks, 17), 120);
});

check("an unfilled slot simply scores nothing", () => {
  assert.strictEqual(S.actualPoints([], {}, 14), 0);
});

// --- the field --------------------------------------------------------------
check("marketPick respects the position cap, then falls back", () => {
  const order = [P("q1", "QB", 1), P("q2", "QB", 2), P("q3", "QB", 3),
                 P("r1", "RB", 4)];
  const taken = new Set();
  // QB cap is 2: with two already rostered, the third is skipped for the RB
  const roster = [P("a", "QB"), P("b", "QB")];
  assert.strictEqual(S.marketPick(order, taken, roster).player_id, "r1");
  // with nothing rostered he just takes the top of his board
  assert.strictEqual(S.marketPick(order, taken, []).player_id, "q1");
  // everything capped -> falls back to best available rather than returning null
  const capped = [P("a", "QB"), P("b", "QB")];
  const onlyQb = [P("q1", "QB", 1)];
  assert.strictEqual(S.marketPick(onlyQb, taken, capped).player_id, "q1");
});

check("marketPick never returns an already-drafted player", () => {
  const order = [P("q1", "QB", 1), P("r1", "RB", 2)];
  assert.strictEqual(S.marketPick(order, new Set(["q1"]), []).player_id, "r1");
});

check("marketOrder jitters the market but keeps it recognisable", () => {
  const players = [];
  for (let i = 1; i <= 100; i++) players.push(P(`p${i}`, "RB", i));
  const a = S.marketOrder(players, S.rng(1));
  const b = S.marketOrder(players, S.rng(1));
  assert.deepStrictEqual(a.map(p => p.player_id), b.map(p => p.player_id),
    "same seed must give the same field, or nothing is reproducible");
  const c = S.marketOrder(players, S.rng(2));
  assert.notDeepStrictEqual(a.map(p => p.player_id), c.map(p => p.player_id),
    "a different seed must give a different field");
  // the top of the jittered board still comes from the top of the market
  const topTen = new Set(a.slice(0, 10).map(p => Number(p.player_id.slice(1))));
  const fromTop30 = [...topTen].filter(i => i <= 30).length;
  assert.ok(fromTop30 >= 8, `jitter should not scramble the board: ${fromTop30}/10`);
});

check("players with no market position are never drafted by the field", () => {
  const players = [P("ranked", "RB", 1), P("unranked", "RB", null)];
  assert.deepStrictEqual(S.marketOrder(players, S.rng(1)).map(p => p.player_id),
                         ["ranked"]);
});

// --- the human field ---------------------------------------------------------
// Symmetric jitter is unexploitable by construction: zero-mean deviation from
// the consensus leaves the field drafting the consensus on average, and the
// board IS the consensus. These behaviours are the asymmetric part.
const always = { rand: () => 0, panic: 1 };     // always acts on the impulse
const never = { rand: () => 1, panic: 0 };      // never does

check("a drafter with no QB panics once it gets late", () => {
  const order = [P("wr1", "WR", 1), P("wr2", "WR", 2), P("qb1", "QB", 40)];
  const taken = new Set();
  // early: still takes the best player on his board
  assert.strictEqual(
    S.humanPick(order, taken, [], { round: 3, recent: [], ...always }).player_id, "wr1");
  // at the panic round with the slot empty: reaches for the quarterback
  assert.strictEqual(
    S.humanPick(order, taken, [], { round: S.PANIC_ROUND.QB, recent: [], ...always })
      .player_id, "qb1");
});

check("panic does not fire once the slot is filled", () => {
  const order = [P("wr1", "WR", 1), P("qb1", "QB", 40)];
  const roster = [P("myqb", "QB", 5), P("myte", "TE", 6)];
  assert.strictEqual(
    S.humanPick(order, new Set(), roster,
                { round: 14, recent: [], ...always }).player_id, "wr1");
});

check("a disciplined drafter never panics", () => {
  const order = [P("wr1", "WR", 1), P("qb1", "QB", 40)];
  assert.strictEqual(
    S.humanPick(order, new Set(), [], { round: 14, recent: [], ...never }).player_id,
    "wr1");
});

check("a run on a position pulls drafters into it", () => {
  const order = [P("wr1", "WR", 1), P("rb1", "RB", 30)];
  const run = Array(S.RUN_TRIGGER).fill("RB");
  assert.strictEqual(
    S.humanPick(order, new Set(), [], { round: 3, recent: run, ...always }).player_id,
    "rb1");
  // one short of the trigger is not a run
  const notYet = Array(S.RUN_TRIGGER - 1).fill("RB");
  assert.strictEqual(
    S.humanPick(order, new Set(), [], { round: 3, recent: notYet, ...always }).player_id,
    "wr1");
});

check("only the last RUN_WINDOW picks count as a run", () => {
  const order = [P("wr1", "WR", 1), P("rb1", "RB", 30)];
  // enough RBs, but all of them pushed out of the window by newer picks
  const stale = Array(S.RUN_TRIGGER).fill("RB").concat(Array(S.RUN_WINDOW).fill("WR"));
  assert.strictEqual(
    S.humanPick(order, new Set(), [], { round: 3, recent: stale, ...always }).player_id,
    "wr1");
});

check("a run never pushes a drafter past his position cap", () => {
  const order = [P("wr1", "WR", 1), P("qb9", "QB", 30)];
  const full = [P("q1", "QB", 1), P("q2", "QB", 2)];       // QB cap is 2
  const run = Array(S.RUN_TRIGGER).fill("QB");
  assert.strictEqual(
    S.humanPick(order, new Set(), full, { round: 3, recent: run, ...always }).player_id,
    "wr1");
});

check("the human field still drafts a legal, complete roster", () => {
  const w = toyWorld();
  const rosters = S.runDraft(w.players, 6, 3, "human");
  for (let t = 1; t <= 12; t++) assert.strictEqual(rosters[t].length, 15);
  const ids = rosters.slice(1).flat().map(p => p.player_id);
  assert.strictEqual(new Set(ids).size, ids.length, "a player was drafted twice");
});

check("the human field is reproducible, and differs from the consensus field", () => {
  const w = toyWorld();
  const a = S.runDraft(w.players, 6, 3, "human").slice(1).flat().map(p => p.player_id);
  const b = S.runDraft(w.players, 6, 3, "human").slice(1).flat().map(p => p.player_id);
  assert.deepStrictEqual(a, b);
  const c = S.runDraft(w.players, 6, 3, "consensus").slice(1).flat().map(p => p.player_id);
  assert.notDeepStrictEqual(a, c, "the two field modes must actually behave differently");
});

// --- snake math -------------------------------------------------------------
check("snake turns at the end of each round", () => {
  assert.strictEqual(S.pickForRoundSlot(1, 1), 1);
  assert.strictEqual(S.pickForRoundSlot(1, 12), 12);
  assert.strictEqual(S.pickForRoundSlot(2, 12), 13);   // turn
  assert.strictEqual(S.pickForRoundSlot(2, 1), 24);
  assert.strictEqual(S.pickForRoundSlot(3, 1), 25);
});

check("futurePicks lists your remaining turns, ascending", () => {
  const f = S.futurePicks(1, 6);
  assert.strictEqual(f[0], S.pickForRoundSlot(2, 6));
  for (let i = 1; i < f.length; i++) assert.ok(f[i] > f[i - 1]);
  assert.strictEqual(S.futurePicks(15, 6).length, 0);
});

// --- the guard that exists because of a fake +2470 edge ----------------------
check("a world with no market column is refused, not silently scored", () => {
  const players = [];
  for (let i = 1; i <= 300; i++) players.push(P(`p${i}`, "RB", null));
  const world = { season: 2023, actual_weeks: {} };
  assert.throws(() => S.assertWorldUsable(world, players), /market position/,
    "missing adp must throw — the field would draft nobody and the edge would be fake");
});

check("the market must be deep enough to fill the draft, not just present", () => {
  // 12 teams x 15 rounds = 180 picks. A board with 179 ranked players leaves
  // drafters passing, and the hero inherits a board no real opponent left him.
  const nearly = [], plenty = [];
  for (let i = 1; i <= 179; i++) nearly.push(P(`p${i}`, "RB", i));
  for (let i = 1; i <= 181; i++) plenty.push(P(`p${i}`, "RB", i));
  assert.throws(() => S.assertMarketDepth("t", nearly), /180 picks/);
  assert.strictEqual(S.assertMarketDepth("t", plenty), 181);
});

check("a world with no answer key is refused", () => {
  const players = [];
  for (let i = 1; i <= 300; i++) players.push(P(`p${i}`, "RB", i));
  assert.throws(() => S.assertWorldUsable({ season: 2023, actual_weeks: {} }, players),
    /actual weekly scoring/);
});

check("a healthy world passes", () => {
  const players = [], actual_weeks = {};
  for (let i = 1; i <= 300; i++) {
    players.push(P(`p${i}`, "RB", i));
    actual_weeks[`p${i}`] = { 1: 10 };
  }
  assert.doesNotThrow(() => S.assertWorldUsable({ season: 2023, actual_weeks }, players));
});

// --- end to end --------------------------------------------------------------
function toyWorld() {
  const players = [], actual_weeks = {};
  const positions = ["QB", "RB", "RB", "WR", "WR", "TE"];
  for (let i = 1; i <= 260; i++) {
    const pos = positions[i % positions.length];
    players.push({ player_id: `p${i}`, name: `p${i}`, position: pos, adp: i,
                   bye: (i % 14) + 1, value_points: 300 - i, vorp: 150 - i / 2,
                   position_rank: i, season_points: null });
    actual_weeks[`p${i}`] = {};
    for (let w = 1; w <= 14; w++) actual_weeks[`p${i}`][w] = Math.max(0, 30 - i / 10);
  }
  return { season: 2023, players, actual_weeks, model: "toy", market_source: "test" };
}

check("a full draft fills every seat with a legal roster", () => {
  const w = toyWorld();
  const rosters = S.runDraft(w.players, 6, 1);
  for (let t = 1; t <= 12; t++) {
    assert.strictEqual(rosters[t].length, 15, `seat ${t} drafted ${rosters[t].length}`);
  }
  const ids = rosters.slice(1).flat().map(p => p.player_id);
  assert.strictEqual(new Set(ids).size, ids.length, "a player was drafted twice");
});

check("the draft is reproducible from its seed", () => {
  const w = toyWorld();
  const a = S.runDraft(w.players, 6, 7).slice(1).flat().map(p => p.player_id);
  const b = S.runDraft(w.players, 6, 7).slice(1).flat().map(p => p.player_id);
  assert.deepStrictEqual(a, b);
});

check("evaluateSeason reports both windows and a same-seat counterfactual", () => {
  const rows = S.evaluateSeason(toyWorld(), 1);
  assert.strictEqual(rows.length, 12 * 2, "12 slots x 2 scoring windows");
  for (const r of rows) {
    assert.ok(r.rank >= 1 && r.rank <= 12);
    assert.ok(Number.isFinite(r.hero) && Number.isFinite(r.counterfactual));
    assert.strictEqual(+(r.hero - r.counterfactual).toFixed(6), +r.edge.toFixed(6));
  }
  assert.ok(rows.some(r => r.window === "reg") && rows.some(r => r.window === "full"));
  const summary = S.summarize(rows, "reg");
  assert.strictEqual(summary.n, 12);
  assert.ok(summary.mean_rank_of_12 >= 1 && summary.mean_rank_of_12 <= 12);
});


// --- keepers -----------------------------------------------------------------
// A keeper league changes the pool, the rosters AND the pick order. Each of
// these pins one of those three, because getting any one wrong inflates the
// simulated field in a way that reads as a bigger edge for our tool.
function keeperSnap(entries, over = {}) {
  return Object.assign({ league_id: "L", league_name: "toy", draft_id: "D",
                         season: 2023, teams: 12, rounds: 15, reversal_round: 0,
                         keepers: entries }, over);
}
const KEEP = (round, slot, player_id) =>
  ({ round, slot, pick_no: 0, player_id, name: player_id, position: "RB" });

check("no snapshot means no keepers, and nothing else changes", () => {
  assert.strictEqual(S.loadKeepers(null, toyWorld().players), null);
});

check("a keeper who is not on the board is refused, not skipped", () => {
  // Skipping him would leave him draftable while his owner drafts without the
  // pick he cost -- both errors enlarge the pool, so this must throw.
  const w = toyWorld();
  assert.throws(() => S.loadKeepers(keeperSnap([KEEP(8, 10, "nobody")]), w.players),
                /not on this board/);
});

check("a snapshot whose draft shape differs from the harness is refused", () => {
  const w = toyWorld();
  const one = [KEEP(8, 10, "p5")];
  assert.throws(() => S.loadKeepers(keeperSnap(one, { rounds: 16 }), w.players),
                /16-round/);
  assert.throws(() => S.loadKeepers(keeperSnap(one, { teams: 10 }), w.players),
                /10 teams/);
  // Third-round reversal renumbers every pick, so keeper cells would land on
  // the wrong teams under this harness's plain snake.
  assert.throws(() => S.loadKeepers(keeperSnap(one, { reversal_round: 3 }), w.players),
                /reversal_round/);
});

check("nobody can draft a kept player", () => {
  const w = toyWorld();
  const snap = keeperSnap([KEEP(8, 10, "p5"), KEEP(12, 10, "p6"), KEEP(4, 3, "p7")]);
  const k = S.loadKeepers(snap, w.players);
  const rosters = S.runDraft(w.players, 6, 1, "consensus", k);
  const drafted = rosters.slice(1).flat().filter(p => !p._keeper).map(p => p.player_id);
  for (const id of ["p5", "p6", "p7"]) {
    assert.ok(!drafted.includes(id), `${id} was kept but someone drafted him`);
  }
  assert.strictEqual(new Set(drafted).size, drafted.length, "a player was drafted twice");
});

check("a keeper costs its team that exact pick, and no other team's", () => {
  const w = toyWorld();
  const snap = keeperSnap([KEEP(8, 10, "p5"), KEEP(12, 10, "p6"), KEEP(4, 3, "p7")]);
  const k = S.loadKeepers(snap, w.players);
  const rosters = S.runDraft(w.players, 6, 1, "consensus", k);
  for (let t = 1; t <= 12; t++) {
    const kept = rosters[t].filter(p => p._keeper).length;
    const drafted = rosters[t].filter(p => !p._keeper);
    assert.strictEqual(rosters[t].length, 15,
      `seat ${t} ended with ${rosters[t].length}, not 15`);
    assert.strictEqual(drafted.length, 15 - kept,
      `seat ${t} kept ${kept} but made ${drafted.length} picks`);
    // the forfeited ROUND is the keeper's own round, not just "one fewer pick"
    const keptRounds = rosters[t].filter(p => p._keeper).map(p => p._round).sort();
    const draftedRounds = drafted.map(p => p._round);
    for (const r of keptRounds) {
      assert.ok(!draftedRounds.includes(r),
        `seat ${t} kept a player in round ${r} but also drafted in round ${r}`);
    }
  }
});

check("every drafted player records the round he was actually taken in", () => {
  // `_round` is what the dry run reports as "first TE round" / "first QB
  // round". Nothing else checks it, so a constant here would silently make
  // every timing number in the report wrong while the suite stayed green.
  const w = toyWorld();
  const snap = keeperSnap([KEEP(8, 10, "p5"), KEEP(12, 10, "p6"), KEEP(4, 3, "p7")]);
  const rosters = S.runDraft(w.players, 6, 1, "consensus", S.loadKeepers(snap, w.players));
  for (let t = 1; t <= 12; t++) {
    const kept = rosters[t].filter(p => p._keeper).map(p => p._round);
    const drafted = rosters[t].filter(p => !p._keeper).map(p => p._round)
      .sort((a, b) => a - b);
    const expected = [];
    for (let r = 1; r <= 15; r++) if (!kept.includes(r)) expected.push(r);
    assert.deepStrictEqual(drafted, expected,
      `seat ${t} drafted in rounds ${drafted.join(",")}, expected ${expected.join(",")}`);
  }
});

check("futurePicks omits a pick already spent on a keeper", () => {
  const forfeited = new Set(["8:10", "12:10"]);
  const all = S.futurePicks(1, 10);
  const left = S.futurePicks(1, 10, forfeited);
  assert.strictEqual(left.length, all.length - 2);
  assert.ok(!left.includes(S.pickForRoundSlot(8, 10)), "round 8 pick still offered");
  assert.ok(!left.includes(S.pickForRoundSlot(12, 10)), "round 12 pick still offered");
  // another seat's forfeits must not shrink this seat's list
  assert.deepStrictEqual(S.futurePicks(1, 10, new Set(["8:3"])), all);
});

check("a keeper is on the roster from pick 1, not merely absent from the pool", () => {
  // The distinction that matters: the optimizer must SEE its own keepers while
  // making every pick, or it drafts a position it already has. Holding p6 (QB)
  // and p5 (TE) -- the two single-starter slots -- must change what it drafts,
  // compared with a world where those two players simply do not exist.
  const w = toyWorld();
  const snap = keeperSnap([KEEP(8, 6, "p6"), KEEP(12, 6, "p5")]);
  const withKeepers = S.runDraft(w.players, 6, 1, "consensus",
                                 S.loadKeepers(snap, w.players))[6]
    .filter(p => !p._keeper).map(p => p.player_id);
  const merelyAbsent = S.runDraft(w.players.filter(p => !["p5", "p6"].includes(p.player_id)),
                                  6, 1, "consensus")[6].map(p => p.player_id);
  assert.notDeepStrictEqual(withKeepers, merelyAbsent,
    "rostering a keeper made no difference to what the tool drafted");
});

check("the market-depth floor drops with the picks keepers remove", () => {
  const w = toyWorld();
  assert.strictEqual(S.marketFloor(null), 180);
  // Board where only the first n players carry a market position.
  const boardWith = n => w.players.map((p, i) =>
    Object.assign({}, p, { adp: i < n ? i + 1 : NaN }));

  const b180 = boardWith(180), b179 = boardWith(179);
  const k180 = S.loadKeepers(keeperSnap([KEEP(8, 10, "p5"), KEEP(4, 3, "p7")]), b180);
  const k179 = S.loadKeepers(keeperSnap([KEEP(8, 10, "p5"), KEEP(4, 3, "p7")]), b179);
  assert.strictEqual(S.marketFloor(k180), 178);

  // A keeper who carries an ADP removes a pick the field must make AND a
  // player who could have made it, so the guard is exactly as tight as it was
  // without keepers: 180 passes either way, 179 fails either way. If the floor
  // moved without the supply, one of these four would flip.
  assert.doesNotThrow(() => S.assertMarketDepth("180", b180, k180));
  assert.doesNotThrow(() => S.assertMarketDepth("180", b180, null));
  assert.throws(() => S.assertMarketDepth("179", b179, k179), /market position/);
  assert.throws(() => S.assertMarketDepth("179", b179, null), /market position/);

  // A kept player with NO ADP was never part of the market supply. He removes
  // a pick without removing anyone's option, so the guard gets looser by
  // exactly one -- charging him to both sides would double-count him and
  // reject a board that can in fact fill the draft.
  const kNoAdp = S.loadKeepers(keeperSnap([KEEP(8, 10, "p200")]), b179);
  assert.ok(!Number.isFinite(kNoAdp.entries[0].player.adp), "p200 should have no adp");
  assert.strictEqual(S.marketFloor(kNoAdp), 179);
  assert.doesNotThrow(() => S.assertMarketDepth("179 + adp-less keeper", b179, kNoAdp));
});

check("a keeper draft is still reproducible from its seed", () => {
  const w = toyWorld();
  const snap = keeperSnap([KEEP(8, 10, "p5"), KEEP(4, 3, "p7")]);
  const run = () => S.runDraft(w.players, 6, 7, "consensus",
                               S.loadKeepers(snap, w.players))
    .slice(1).flat().map(p => p.player_id);
  assert.deepStrictEqual(run(), run());
});

check("keeper cells are handed to the optimizer as pick NUMBERS", () => {
  // forfeited is keyed "round:slot" for the draft loop; the optimizer works in
  // overall pick numbers. Without the translation it counts every keeper cell
  // in the league as a live selection between the hero's turns and believes
  // the board empties faster than this simulation actually empties it.
  const w = toyWorld();
  const snap = keeperSnap([KEEP(4, 9, "p5"), KEEP(8, 10, "p6")]);
  const k = S.loadKeepers(snap, w.players);
  // 12-team snake: R4 slot 9 is pick 40, R8 slot 10 is pick 87.
  assert.deepStrictEqual([...k.usedPicks].sort((a, b) => a - b), [40, 87]);
  for (const e of k.entries) {
    assert.ok(k.usedPicks.has(S.pickForRoundSlot(e.round, e.slot)));
  }
  assert.strictEqual(k.usedPicks.size, k.entries.length);
});

check("no keepers means no used-pick set to thread", () => {
  assert.strictEqual(S.loadKeepers(null, toyWorld().players), null);
});
console.log(`draft_sim fixture: ${n} groups OK`);
