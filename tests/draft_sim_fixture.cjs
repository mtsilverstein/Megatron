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

console.log(`draft_sim fixture: ${n} groups OK`);
