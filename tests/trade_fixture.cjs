// tests/trade_fixture.cjs — run with: node tests/trade_fixture.cjs
const assert = require("assert");
const T = require("../site/assets/trade.js");

let n = 0;
const check = (label, fn) => { fn(); n++; };
const key = p => `${p.season}R${p.round}`;
const keys = list => list.map(key).sort().join(",");

check("every team starts with every round of every season", () => {
  const owned = T.defaultPicks([1, 2], [2026, 2027], 3);
  assert.strictEqual(owned.size, 2);
  assert.strictEqual(keys(owned.get(1)),
    "2026R1,2026R2,2026R3,2027R1,2027R2,2027R3");
});

check("a traded pick moves from its original owner to its holder", () => {
  const owned = T.defaultPicks([1, 2], [2026], 3);
  // Sleeper's shape: roster_id is who it ORIGINALLY belonged to, owner_id who
  // holds it now. season arrives as a string.
  T.applyTradedPicks(owned, [{ round: 2, season: "2026", roster_id: 1, owner_id: 2 }]);
  assert.strictEqual(keys(owned.get(1)), "2026R1,2026R3");
  assert.strictEqual(keys(owned.get(2)), "2026R1,2026R2,2026R2,2026R3",
    "team 2 now holds its own R2 AND team 1's");
});

check("a pick traded twice ends with the final holder only", () => {
  const owned = T.defaultPicks([1, 2, 3], [2026], 2);
  // Sleeper collapses a chain to ONE row per pick, carrying the final owner.
  T.applyTradedPicks(owned, [
    { round: 1, season: "2026", roster_id: 1, owner_id: 3, previous_owner_id: 2 },
  ]);
  assert.strictEqual(keys(owned.get(1)), "2026R2");
  assert.strictEqual(keys(owned.get(2)), "2026R1,2026R2");
  assert.strictEqual(keys(owned.get(3)), "2026R1,2026R1,2026R2");
});

check("a traded pick for an unknown season or roster is ignored, not crashed", () => {
  const owned = T.defaultPicks([1, 2], [2026], 2);
  T.applyTradedPicks(owned, [
    { round: 1, season: "2099", roster_id: 1, owner_id: 2 },   // season we don't model
    { round: 1, season: "2026", roster_id: 9, owner_id: 2 },   // roster not in the league
    { round: 9, season: "2026", roster_id: 1, owner_id: 2 },   // round beyond the draft
  ]);
  assert.strictEqual(keys(owned.get(1)), "2026R1,2026R2", "nothing should have moved");
});

// --- state value ------------------------------------------------------------
const O = require("../site/assets/optimizer.js");

// A board row the optimizer will accept. value_points is the absolute season
// projection the lineup objective reads; vorp is position-relative and only
// feeds the keeper selection.
let _id = 0;
const P = (name, position, value_points, extra = {}) =>
  Object.assign({ name, position, value_points, player_id: `p${++_id}`,
                  vorp: value_points, bye: null, adp: null, adp_round: null,
                  position_rank: 1, season_points: null }, extra);

// A realistic filler board: 240 players, all four positions interleaved, value
// descending 250 -> ~47, every row carrying an ADP. All three properties are
// load-bearing. DESCENDING because Optimizer.parVorp reads "the board row at
// this rank" and a shuffled board makes every keeper cost meaningless.
// REALISTIC SCALE because if the filler is far weaker than the test players, a
// draft pick buys nothing and the cost of keeping someone vanishes -- which
// would let a broken implementation pass.
//
// ADP because it is the ONLY thing that makes an early pick differ from a late
// one. Optimizer.finishRoster depletes the pool between your picks via
// fieldTakes, which drafts strictly in ADP order and explicitly skips players
// with no ADP ("the undrafted depth tail"). On an ADP-less board fieldTakes is
// a permanent no-op: the pool never shrinks, every pick returns the same best
// available, and the keeper ladder -- the entire thesis of this file -- moves
// the objective by exactly 0.00. Five of the tests below measured precisely
// that before this was added, and passed or tied without testing anything.
const filler = [];
for (let i = 0; i < 240; i++) {
  filler.push(P(`${["QB", "RB", "WR", "TE"][i % 4]}f${i}`,
                ["QB", "RB", "WR", "TE"][i % 4], 250 - i * 0.85,
                { adp: i + 1, adp_round: Math.ceil((i + 1) / 12) }));
}

const CTX = (over = {}) => Object.assign({
  season: 2026, teams: 12, rounds: 15, maxKeepers: 2, futureDiscount: 0.8,
  board: filler, originalByPlayerId: new Map(), keptElsewhere: new Set(),
}, over);

// Drafted in `round` of `season` -> keeper cost decays one round per year.
const withHistory = (ctx, player, round, season = 2025) => {
  ctx.originalByPlayerId.set(player.player_id, { round, season });
  return player;
};
const state = (roster, picks) => ({ roster, picks });
const allPicks = (season = 2026, rounds = 15) =>
  Array.from({ length: rounds }, (_, i) => ({ season, round: i + 1 }));

check("an ineligible player is worth exactly zero pre-draft", () => {
  // Cost = originalRound - yearsKept. A round-1 pick from last season computes
  // to R0, so he returns to the draft pool for EVERYBODY and owning him first
  // buys nothing. This is the counterintuitive one: your best player is often
  // the one worth nothing to trade.
  const ctx = CTX();
  const star = withHistory(ctx, P("Star", "RB", 300), 1);
  ctx.board = filler.concat([star]);
  const picks = allPicks();
  const empty = state([], picks);
  const withStar = state([star], picks);
  const pool = T.draftPool(ctx, withStar);
  assert.strictEqual(T.chooseKeepers(withStar.roster, ctx).length, 0,
    "an R1 keeper cost is R0 -> ineligible");
  assert.ok(Math.abs(T.currentDraftValue(withStar, pool, ctx)
                   - T.currentDraftValue(empty, T.draftPool(ctx, empty), ctx)) < 1e-6,
    "holding an ineligible player must change nothing");
});

check("a cheap ladder outvalues a strictly better player", () => {
  // The inversion the whole pre-draft market misses. `good` is strictly the
  // better player but costs an early pick; `cheap` is worse and costs a late
  // one. The cheap ladder must win.
  const ctxA = CTX(), ctxB = CTX();
  const good = withHistory(ctxA, P("Good", "WR", 220), 4);    // cost R3
  const cheap = withHistory(ctxB, P("Cheap", "WR", 180), 12); // cost R11
  ctxA.board = filler.concat([good]);
  ctxB.board = filler.concat([cheap]);
  const a = state([good], allPicks()), b = state([cheap], allPicks());
  const va = T.currentDraftValue(a, T.draftPool(ctxA, a), ctxA);
  const vb = T.currentDraftValue(b, T.draftPool(ctxB, b), ctxB);
  assert.ok(vb > va,
    `cheap ladder ${vb.toFixed(1)} must beat better-but-expensive ${va.toFixed(1)}`);
});

check("an acquired player competes for a slot, he does not add one", () => {
  // Both keeper slots already hold better players, so a third star gains
  // ~nothing. A design treating him as an extra keeper would overvalue every
  // incoming star.
  //
  // All three are stronger than any filler row and their cost rounds are
  // distinct, so the ~0 below cannot be an artifact of a player too weak to
  // matter -- the cap=3 counterfactual at the bottom proves the same roster
  // DOES move by 47.6 points the moment a third slot exists.
  const ctx = CTX();
  const k1 = withHistory(ctx, P("K1", "WR", 300), 10);      // cost R9
  const k2 = withHistory(ctx, P("K2", "RB", 290), 11);      // cost R10
  const third = withHistory(ctx, P("Third", "WR", 260), 12); // cost R11
  ctx.board = filler.concat([k1, k2, third]);
  const before = state([k1, k2], allPicks());
  const after = state([k1, k2, third], allPicks());
  assert.strictEqual(T.chooseKeepers(after.roster, ctx).length, 2, "cap is 2");
  const value = (s, c) => T.currentDraftValue(s, T.draftPool(c, s), c);
  const gain = value(after, ctx) - value(before, ctx);
  assert.ok(Math.abs(gain) < 5,
    `a third keeper behind two better ones should gain ~0, got ${gain.toFixed(1)}`);
  // TEETH. Same rosters, same board, one more keeper slot. If this did not
  // move, the assertion above would be measuring a fixture that cannot move
  // rather than the cap actually binding.
  const ctx3 = Object.assign({}, ctx, { maxKeepers: 3 });
  assert.strictEqual(T.chooseKeepers(after.roster, ctx3).length, 3);
  const gain3 = value(after, ctx3) - value(before, ctx3);
  assert.ok(gain3 > 20,
    `with a third slot the same player must be worth real points, got ${gain3.toFixed(1)}`);
});

check("keeping a player spends the pick at his cost round", () => {
  const ctx = CTX();
  const k = withHistory(ctx, P("Keep", "RB", 200), 8);        // cost R7
  ctx.board = filler.concat([k]);
  const s = state([k], allPicks());
  const kept = T.chooseKeepers(s.roster, ctx);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].cost, 7, "8 drafted in 2025 -> R7 in 2026");
});

check("the draft pool excludes every kept player", () => {
  const ctx = CTX();
  const mine = withHistory(ctx, P("Mine", "RB", 200), 8);
  const theirs = withHistory(ctx, P("Theirs", "WR", 200), 8);
  ctx.board = filler.concat([mine, theirs]);
  const pool = T.draftPool(ctx, state([mine], []), state([theirs], []));
  const ids = new Set(pool.map(p => p.player_id));
  assert.ok(!ids.has(mine.player_id) && !ids.has(theirs.player_id),
    "a kept player is off the board for everyone");
  // keptElsewhere is the ten uninvolved teams' keepers. Without this the
  // parameter could be dropped entirely and every test would still pass.
  const elsewhere = filler[0];
  const ctx2 = CTX({ board: ctx.board, originalByPlayerId: ctx.originalByPlayerId,
                     keptElsewhere: new Set([elsewhere.player_id]) });
  const pool2 = T.draftPool(ctx2, state([mine], []), state([theirs], []));
  assert.ok(!pool2.some(p => p.player_id === elsewhere.player_id),
    "a player kept by an uninvolved team is off the board too");
});

check("a player with no draft history is on the waiver ladder", () => {
  // Never drafted in this league -> R12 the first year he's kept.
  const ctx = CTX();
  const w = P("Waiver", "TE", 200);
  ctx.board = filler.concat([w]);
  const kept = T.chooseKeepers([w], ctx);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].cost, 12);
});

check("two keepers at the same cost round cannot share one pick", () => {
  // A team holds ONE pick per round. Two waiver pickups both cost R12 and
  // multi-year ladders converge, so this collides in real rosters -- and a
  // Set of cost rounds priced both against a single pick, worth 40.8 points
  // of draft capital the team does not have.
  const ctx = CTX();
  const a = withHistory(ctx, P("Col1", "RB", 240), 4);   // cost R3
  const b = withHistory(ctx, P("Col2", "RB", 239), 4);   // cost R3 too
  const c = withHistory(ctx, P("Dis1", "RB", 240), 4);   // cost R3
  const d = withHistory(ctx, P("Dis2", "RB", 239), 5);   // cost R4
  ctx.board = filler.concat([a, b, c, d]);
  const collide = state([a, b], allPicks());
  const distinct = state([c, d], allPicks());
  assert.strictEqual(T.chooseKeepers(collide.roster, ctx).length, 2);
  const vc = T.currentDraftValue(collide, T.draftPool(ctx, collide), ctx);
  const vd = T.currentDraftValue(distinct, T.draftPool(ctx, distinct), ctx);
  assert.ok(Math.abs(vc - vd) < 1e-6,
    `a colliding pair must cost the same two picks as a distinct pair; ` +
    `got ${vc.toFixed(2)} vs ${vd.toFixed(2)}`);
  // A colliding pair must still RESPOND to losing a pick -- an implementation
  // that quietly charged nothing would sit flat here.
  //
  // This does NOT pin which direction the collision bumps (up to R4, or down
  // to R2). That was tried and does not work: Optimizer.finishRoster simulates
  // only its first ROLLOUT_PICKS (8) picks, so removing R4 costs the team one
  // pick inside that window either way, and the assertion holds under a
  // downward bump too -- verified by flipping the search and watching the
  // suite stay green. Direction is a league rule nobody has written down, and
  // both directions spend two real picks, so no value is invented either way.
  // Saying so here beats an assertion whose message claims a guarantee it
  // does not provide.
  const noR4 = state([a, b], allPicks().filter(p => p.round !== 4));
  assert.ok(T.currentDraftValue(noR4, T.draftPool(ctx, noR4), ctx) < vc - 1e-6,
    `a colliding pair must still lose value when a pick is taken away; got ${
      T.currentDraftValue(noR4, T.draftPool(ctx, noR4), ctx).toFixed(2)} vs ${vc.toFixed(2)}`);
});

check("a keeper must be paid for with a pick the team actually holds", () => {
  // Trading away the exact round your keeper costs used to be free: the cost
  // was charged against an abstract 1..15 range rather than the picks in hand.
  // That is the same error as the collision -- a keeper not charged a real
  // pick -- and it is worse here, because Task 2 exists precisely to make
  // traded picks matter and the suggester would price "send them the R3 I was
  // surrendering anyway" as pure profit.
  const ctx = CTX();
  const k = withHistory(ctx, P("Payer", "RB", 240), 4);   // cost R3
  ctx.board = filler.concat([k]);
  const all = state([k], allPicks());
  const noR3 = state([k], allPicks().filter(p => p.round !== 3));
  const vAll = T.currentDraftValue(all, T.draftPool(ctx, all), ctx);
  const vNo = T.currentDraftValue(noR3, T.draftPool(ctx, noR3), ctx);
  assert.ok(vNo < vAll - 1e-6,
    `giving up the R3 must still cost a real pick; got ${vNo.toFixed(2)} vs ${vAll.toFixed(2)}`);
});

check("two picks of the same round are not both consumed by one keeper", () => {
  // Sleeper lets a team hold two picks of the same round -- a traded pick
  // keeps its original round -- and filtering by round number took both.
  const ctx = CTX();
  const k = withHistory(ctx, P("Dup", "RB", 240), 4);     // cost R3
  ctx.board = filler.concat([k]);
  const one = state([k], allPicks());
  const two = state([k], allPicks().concat([{ season: 2026, round: 3 }]));
  const vOne = T.currentDraftValue(one, T.draftPool(ctx, one), ctx);
  const vTwo = T.currentDraftValue(two, T.draftPool(ctx, two), ctx);
  assert.ok(vTwo > vOne + 1e-6,
    `the second R3 must survive the keeper; got ${vTwo.toFixed(2)} vs ${vOne.toFixed(2)}`);
});

console.log(`trade_fixture: ${n} groups OK`);
