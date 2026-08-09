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
  assert.strictEqual(T.chooseKeepers(withStar.roster, withStar.picks, ctx).length, 0,
    "an R1 keeper cost is R0 -> ineligible");
  assert.ok(Math.abs(T.currentDraftValue(withStar, pool, ctx)
                   - T.currentDraftValue(empty, T.draftPool(ctx, empty), ctx)) < 1e-6,
    "holding an ineligible player must change nothing");
});

check("a cheap ladder outvalues a strictly better player", () => {
  // The inversion the whole pre-draft market misses. `good` is strictly the
  // better player but costs an early pick; `cheap` is worse and costs a late
  // one. The cheap ladder must win.
  //
  // Both must actually BE KEPT, or this measures "a cheap keeper vs no keeper"
  // instead of the ladder -- the same defect task-4 Resolution 3 found in "THE
  // PREMISE" below. At 220/180 it did not: wave 2 made chooseKeepers choose by
  // the lineup objective, which is STRICTER than the `slotWeight * vorp -
  // parVorp` ranking it replaced (measured on this board, a constant ~20.4
  // points stricter -- a 200-point player at cost R6 ranks +25.65 there and is
  // worth +5.25 here), so `good` at 220 was declined and the comparison
  // collapsed to two DIFFERENT boards with no keeper on either: 1683.55 vs
  // 1680.95, i.e. reversed, for the wrong reason. Values raised by 20 apiece,
  // which is the whole change: both sides keep, `good` is still strictly the
  // better player, and the gap comes back to the SAME 11.00 wave 1 measured.
  const ctxA = CTX(), ctxB = CTX();
  const good = withHistory(ctxA, P("Good", "WR", 240), 4);    // cost R3
  const cheap = withHistory(ctxB, P("Cheap", "WR", 200), 12); // cost R11
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
  assert.strictEqual(T.chooseKeepers(after.roster, after.picks, ctx).length, 2, "cap is 2");
  const value = (s, c) => T.currentDraftValue(s, T.draftPool(c, s), c);
  const gain = value(after, ctx) - value(before, ctx);
  assert.ok(Math.abs(gain) < 5,
    `a third keeper behind two better ones should gain ~0, got ${gain.toFixed(1)}`);
  // TEETH. Same rosters, same board, one more keeper slot. If this did not
  // move, the assertion above would be measuring a fixture that cannot move
  // rather than the cap actually binding.
  const ctx3 = Object.assign({}, ctx, { maxKeepers: 3 });
  assert.strictEqual(T.chooseKeepers(after.roster, after.picks, ctx3).length, 3);
  const gain3 = value(after, ctx3) - value(before, ctx3);
  assert.ok(gain3 > 20,
    `with a third slot the same player must be worth real points, got ${gain3.toFixed(1)}`);
});

check("keeping a player spends the pick at his cost round", () => {
  const ctx = CTX();
  const k = withHistory(ctx, P("Keep", "RB", 200), 8);        // cost R7
  ctx.board = filler.concat([k]);
  const s = state([k], allPicks());
  const kept = T.chooseKeepers(s.roster, s.picks, ctx);
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
  const kept = T.chooseKeepers([w], allPicks(), ctx);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].cost, 12);
});

check("two keepers at the same cost round cannot share one pick", () => {
  // A team holds ONE pick per round. Two waiver pickups both cost R12 and
  // multi-year ladders converge, so this collides in real rosters -- and a
  // Set of cost rounds priced both against a single pick, worth 40.8 points
  // of draft capital the team does not have.
  // SEPARATE ctx and board per scenario, like the cheap-ladder group above.
  // With one shared board, each scenario's draftPool excludes only its OWN
  // keepers, so the other scenario's players stay in the pool -- and they
  // carry no ADP, so Optimizer.fieldTakes never removes them and both rollouts
  // draft an equivalent free bonus RB. That ties the two states for ANY
  // implementation, including a broken one, and makes the assertion below
  // measure nothing. Measured: shared board 1720.80 vs 1720.80; isolated
  // 1692.55 vs 1712.95, the 20.4-point gap the rule is actually worth.
  //
  // Values are 260/259, not the 240/239 this started with, for the reason the
  // cheap-ladder group above documents: wave 2's objective-based chooseKeepers
  // is ~20.4 points stricter than the ranking it replaced, and at 240/239 the
  // COLLIDING pair (which pays R3 + R2) stopped keeping both -- measured,
  // chooseKeepers(collide) returned 0 keepers while the distinct pair returned
  // 2, so the two sides were no longer comparable at all. At 260/259 both sides
  // keep two, and the gap is the SAME 20.40 this comment already quotes.
  const ctxC = CTX(), ctxD = CTX();
  const a = withHistory(ctxC, P("Col1", "RB", 260), 4);   // cost R3
  const b = withHistory(ctxC, P("Col2", "RB", 259), 4);   // cost R3 too
  const c = withHistory(ctxD, P("Dis1", "RB", 260), 4);   // cost R3
  const d = withHistory(ctxD, P("Dis2", "RB", 259), 5);   // cost R4
  ctxC.board = filler.concat([a, b]);
  ctxD.board = filler.concat([c, d]);
  const collide = state([a, b], allPicks());
  const distinct = state([c, d], allPicks());
  assert.strictEqual(T.chooseKeepers(collide.roster, collide.picks, ctxC).length, 2);
  const vc = T.currentDraftValue(collide, T.draftPool(ctxC, collide), ctxC);
  const vd = T.currentDraftValue(distinct, T.draftPool(ctxD, distinct), ctxD);
  // One assertion, three implementations told apart. Two keepers at the same
  // cost round consume TWO picks, and in this league the second bumps DOWN --
  // R5 and R4, not R5 and R6 -- so the colliding pair pays R2 where the
  // distinct pair pays R4 and must come out strictly DEARER.
  //   - the original bug charged one pick for both, so collide was worth MORE
  //     than distinct and this inequality is reversed;
  //   - an upward bump makes the two exactly equal;
  //   - only a downward bump spending two real picks passes.
  assert.ok(vc < vd - 1e-6,
    `a colliding pair bumps DOWN and must cost more than a distinct pair; ` +
    `got ${vc.toFixed(2)} vs ${vd.toFixed(2)}`);
  // A weaker companion check: the value function must respond to state.picks at
  // all. Nearly any implementation that reads them does, so this is close to a
  // tautology -- the assertion above is the one with teeth.
  //
  // This does NOT pin which direction the collision bumps (up to R4, or down
  // to R2). That was tried and does not work: Optimizer.finishRoster simulates
  // only its first ROLLOUT_PICKS (8) picks, so removing R4 costs the team one
  // pick inside that window either way, and the assertion holds under a
  // downward bump too -- verified by flipping the search and watching the
  // suite stay green. Direction is pinned now, by the `vc < vd` assertion
  // above rather than this one, and recorded in the spec's rules table (§1);
  // both directions here still spend two real picks, so this weaker check
  // alone invents no value either way. Saying so here beats an assertion
  // whose message claims a guarantee it does not provide.
  const noR4 = state([a, b], allPicks().filter(p => p.round !== 4));
  assert.ok(T.currentDraftValue(noR4, T.draftPool(ctxC, noR4), ctxC) < vc - 1e-6,
    `a colliding pair must still lose value when a pick is taken away; got ${
      T.currentDraftValue(noR4, T.draftPool(ctxC, noR4), ctxC).toFixed(2)} vs ${vc.toFixed(2)}`);
});

check("a keeper whose ladder ran below every held pick pays the EARLIEST one", () => {
  // `unspentPicks`' fallback: when the team holds nothing at or before the
  // keeper's cost round, he takes `left[0]` -- and `left` is sorted ASCENDING
  // by round, so that is the team's EARLIEST, dearest pick. Unpinned, changing
  // `i = 0` to `i = left.length - 1` (the cheapest pick, which is what the
  // comment used to claim) survived the whole suite.
  //
  // The discriminator is a state holding one early and one late pick. Correct,
  // the keeper eats the R5 and the team is left with an R15; reversed, he eats
  // the R15 and the team keeps the R5, which is worth far more. Comparing
  // against a state holding TWO R15s makes that an EQUALITY rather than an
  // inequality: two R15s leave an R15 under either reading, so the two states
  // tie only when the fallback takes the earliest pick.
  //
  // Same roster on both sides of every comparison, so `draftPool` excludes the
  // same keeper each time and no player leaks into the other state's pool.
  const ctx = CTX();
  const k = withHistory(ctx, P("Broke", "RB", 240, { adp: 9.5, adp_round: 1 }), 4); // cost R3
  ctx.board = filler.concat([k]);
  assert.strictEqual(T.chooseKeepers([k], allPicks(), ctx).length, 1, "he must actually be kept");
  const v = s => T.currentDraftValue(s, T.draftPool(ctx, s), ctx);
  const early = () => ({ season: 2026, round: 5 });
  const late = () => ({ season: 2026, round: 15 });
  const mixed = state([k], [early(), late()]);
  const twoLate = state([k], [late(), late()]);
  const twoEarly = state([k], [early(), early()]);
  // TEETH: the surviving pick's round has to matter at all, or the equality
  // below is satisfied by any implementation.
  assert.ok(v(twoEarly) > v(twoLate) + 1e-6,
    `an R5 must outvalue an R15 on this board; got ${v(twoEarly).toFixed(2)} vs ${v(twoLate).toFixed(2)}`);
  assert.ok(Math.abs(v(mixed) - v(twoLate)) < 1e-6,
    `the fallback must spend the EARLIEST pick, leaving the R15: got ${
      v(mixed).toFixed(2)}, expected the two-R15 value ${v(twoLate).toFixed(2)} ` +
    `(spending the cheapest instead leaves the R5 and reads ${v(twoEarly).toFixed(2)})`);
});

check("currentDraftValue reads THIS season's picks and no others", () => {
  // The module header names this as a silent-failure surface, and it was
  // unpinned: replacing `state.picks.filter(p => p.season === ctx.season)` with
  // `state.picks` survived all 40 groups while inflating a live-board state by
  // +236 points -- it feeds the rollout duplicated pick NUMBERS (6,6,6 /
  // 18,18,18), because every season's round 1 prices at the same mid-slot.
  //
  // Pinned on currentDraftValue SPECIFICALLY, not stateValue: stateValue adds
  // futurePicksValue, which is supposed to price those future picks, so the
  // same assertion there would be false by design.
  const ctx = CTX();
  ctx.board = filler;
  const now = state([], allPicks());
  const alsoFuture = state([], allPicks()
    .concat(allPicks(2027, 15)).concat(allPicks(2028, 15)));
  const pool = T.draftPool(ctx, now);
  const vNow = T.currentDraftValue(now, pool, ctx);
  const vFuture = T.currentDraftValue(alsoFuture, pool, ctx);
  assert.strictEqual(alsoFuture.picks.length, 45, "the future picks must really be there");
  assert.ok(vNow > 0, "a full complement of picks must be worth something");
  assert.ok(Math.abs(vFuture - vNow) < 1e-9,
    `future picks must not enter THIS draft; got ${vFuture.toFixed(2)} vs ${vNow.toFixed(2)}`);
  // TEETH: currentDraftValue does respond to the current-season pick list, so
  // the equality above is not the equality of two constants.
  const fewer = state([], allPicks().filter(p => p.round !== 1));
  assert.ok(T.currentDraftValue(fewer, pool, ctx) < vNow - 1e-6,
    "removing this season's R1 must lower the value");
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

check("a ctx missing a silent-failure field throws instead of valuing zero", () => {
  // Without ctx.season every state values at exactly 0.00 and every trade
  // grades "even" -- no keeper is eligible and no pick matches the season
  // filter. A tool that reports "even" for everything, with no error, is worse
  // than one that stops.
  const ctx = CTX();
  ctx.board = filler;
  const s = state([], allPicks());
  for (const field of ["season", "board", "originalByPlayerId", "keptElsewhere", "futureDiscount"]) {
    const broken = Object.assign({}, ctx);
    delete broken[field];
    assert.throws(() => T.currentDraftValue(s, filler, broken), /ctx\./, field);
    assert.throws(() => T.chooseKeepers([], [], broken), /ctx\./, field);
    // Task 4's entry points have the same quiet failure mode: an empty
    // future-picks list or an empty trade side returns 0/no-op without ever
    // reading ctx downstream, so each validates its OWN ctx up front rather
    // than trusting a callee to do it first.
    assert.throws(() => T.futurePicksValue(
      state([], allPicks().concat([{ season: 2027, round: 3 }])), filler, broken), /ctx\./, field);
    assert.throws(() => T.stateValue(s, filler, broken), /ctx\./, field);
    assert.throws(() => T.marketValue(filler[0], broken), /ctx\./, field);
    assert.throws(() => T.marketDelta(
      { players: [filler[0]], picks: [] }, { players: [], picks: [] }, broken), /ctx\./, field);
    assert.throws(() => T.gradeTrade({ me: s, them: s },
      { toMe: { players: [], picks: [] }, toThem: { players: [], picks: [] } }, broken), /ctx\./, field);
    // Task 5's two entry points have the same quiet-failure shape one level
    // up. offerable() calls draftPool as its very first line regardless of
    // input, so it already throws here without any extra guard -- but
    // suggestTrades(me, [], ctx) does NOT: an empty `others` list makes the
    // whole loop body (the only place ctx is ever touched) a no-op, so it
    // would silently return [] instead of throwing. Both get an explicit
    // requireCtx(ctx) as their first line, matching every other entry point
    // in this file, and this asserts the fix rather than just the (already
    // ctx-safe-by-construction) happy path of offerable.
    assert.throws(() => T.offerable(s, s, broken), /ctx\./, field);
    assert.throws(() => T.suggestTrades(s, [], broken), /ctx\./, field);
  }
});

// --- future picks, market value, grading ------------------------------------

check("the future discount compounds per season and is a no-op at zero", () => {
  const ctx = CTX();
  ctx.board = filler;
  const base = state([], allPicks());
  const pool = T.draftPool(ctx, base);
  const now = T.futurePicksValue(state([], [{ season: 2026, round: 3 }]), pool, ctx);
  assert.strictEqual(now, 0, "a CURRENT-year pick is not a future pick");
  const one = T.futurePicksValue(state([], [{ season: 2027, round: 3 }]), pool, ctx);
  const two = T.futurePicksValue(state([], [{ season: 2028, round: 3 }]), pool, ctx);
  assert.ok(one > 0, "a future 3rd must be worth something");
  assert.ok(Math.abs(two - one * ctx.futureDiscount) < 1e-6,
    `0.8 per season: expected ${(one * 0.8).toFixed(3)}, got ${two.toFixed(3)}`);
});

check("a pick past the rollout horizon grades ~0 on lineup, and ~0 on market too", () => {
  // Documented and intended (spec section 3.3): a 15th-rounder will not change
  // a starting lineup, and saying so is the honest answer. Past round 8 the
  // market column is ~0 too (measured below) -- the tradeable edge this model
  // surfaces lives in players whose ADP sits well adrift of our board, not in
  // late picks.
  //
  // The state must hold its normal complement of current-year picks (task-4-
  // resolutions.md Resolution 2). Measured against a state holding ONLY the
  // future R15 -- the brief's original test -- the same pick grades 82.36:
  // correctly, because then it is the team's one and only selection. What is
  // worthless is a 15th-rounder ON TOP OF a full draft, which is the case the
  // spec is talking about.
  const ctx = CTX();
  ctx.board = filler;
  const base = state([], allPicks());
  const pool = T.draftPool(ctx, base);
  const late = T.futurePicksValue(
    state([], allPicks().concat([{ season: 2027, round: 15 }])), pool, ctx);
  assert.ok(late < 1, `a future R15 should be ~0 on lineup, got ${late.toFixed(2)}`);
  // Teeth: the same full state with an EARLY future pick moves materially, so
  // the ~0 above is the rollout horizon and not a state that cannot move.
  const early = T.futurePicksValue(
    state([], allPicks().concat([{ season: 2027, round: 3 }])), pool, ctx);
  assert.ok(early > 20,
    `an early future pick must still be worth real points, got ${early.toFixed(2)}`);
  // On the LIVE board this is 0.00, and that is the honest answer rather than a
  // gap in the model: Optimizer.parVorp is points above positional replacement,
  // every board row past rank 96 is at or below replacement, and a 15th-round
  // pick buys exactly such a player. The synthetic filler board here has
  // positive VORP all the way down (250 - i*0.85), so it CANNOT reproduce the
  // clamp -- which is why this asserts the ordering that holds on both boards
  // rather than a magnitude that holds on neither.
  const earlyMkt = T.marketValue({ season: 2027, round: 1 }, ctx);
  const lateMkt = T.marketValue({ season: 2027, round: 15 }, ctx);
  assert.ok(Number.isFinite(lateMkt) && lateMkt >= 0);
  assert.ok(earlyMkt > lateMkt,
    `an early pick must out-price a late one on the market; got ${earlyMkt.toFixed(2)} vs ${lateMkt.toFixed(2)}`);
});

check("market value uses ADP when present and the board rank when not", () => {
  const ctx = CTX();
  ctx.board = filler;
  const withAdp = P("HasAdp", "WR", 100, { adp: 12, adp_round: 1 });
  const noAdp = P("NoAdp", "WR", 100);
  assert.ok(T.marketValue(withAdp, ctx) > 0);
  assert.ok(T.marketValue(noAdp, ctx) >= 0, "no ADP must not produce NaN");
  assert.ok(Number.isFinite(T.marketValue({ season: 2026, round: 5 }, ctx)));
  // The three assertions above pin nothing: `noAdp` is never put ON `ctx.board`,
  // so boardRank falls off the end (board.length + 1) and BOTH the boardRank
  // branch and the position_rank branch this replaced satisfy `>= 0` -- the
  // regression Resolution 1 fixed passes here either way.
  //
  // ON the board, at a known index, so the two branches give different answers.
  // Board rank 201 -> round ceil(201/12) = 17 -> pickForRound(17,12) = 198 ->
  // filler[197] = 82.55. The position_rank branch this replaced would divide
  // position_rank (1) by 12 -> round 1 -> pick 6 -> 245.75. Asserting the value
  // pins WHICH quantity is being divided; asserting `>= 0`, as this did before,
  // is satisfied by both and pins nothing.
  const onBoard = P("NoAdpOnBoard", "WR", 100);
  const ctxR = CTX({ board: filler.slice(0, 200).concat([onBoard]).concat(filler.slice(200)) });
  const got = T.marketValue(onBoard, ctxR);
  assert.ok(Math.abs(got - 82.55) < 0.5,
    `a no-ADP player must be priced at his BOARD rank, not his position rank; ` +
    `got ${got.toFixed(2)} (position_rank would give ~245.75)`);
});

check("marketValue's no-ADP fallback still works when ctx.teams is omitted", () => {
  // ctx.teams is documented as safe to omit (Keepers defaults it), and that
  // is true almost everywhere -- but Resolution 1's boardRank fallback
  // divides by it directly, so Math.ceil(boardRank(...) / undefined) is NaN,
  // not a graceful fallback to the league's real team count. NaN then flows
  // into pickForRound and parVorp quietly returns 0.00 for what should be a
  // real, positive price. Reusing the same rank-201 setup as the boardRank
  // regression above, just with ctx.teams deleted instead of set to 12.
  const onBoard = P("NoAdpNoTeams", "WR", 100);
  const board = filler.slice(0, 200).concat([onBoard]).concat(filler.slice(200));
  const withTeams = CTX({ board });
  const omitted = Object.assign({}, withTeams);
  delete omitted.teams;
  const got = T.marketValue(onBoard, omitted);
  const expected = T.marketValue(onBoard, withTeams);
  assert.ok(Number.isFinite(got) && got > 0,
    `omitting ctx.teams must not produce NaN or 0; got ${got}`);
  assert.ok(Math.abs(got - expected) < 1e-9,
    `omitting ctx.teams must default to the same answer as teams=12 explicitly; ` +
    `got ${got} vs ${expected}`);
});

check("a straight swap of equals grades near zero for both sides", () => {
  const ctx = CTX();
  const a = withHistory(ctx, P("A", "WR", 200), 10);
  const b = withHistory(ctx, P("B", "WR", 200), 10);
  ctx.board = filler.concat([a, b]);
  const me = state([a], allPicks()), them = state([b], allPicks());
  const g = T.gradeTrade({ me, them },
    { toMe: { players: [b], picks: [] }, toThem: { players: [a], picks: [] } }, ctx);
  assert.ok(Math.abs(g.myGain) < 5, `expected ~0, got ${g.myGain.toFixed(1)}`);
  assert.ok(Math.abs(g.theirGain) < 5, `expected ~0, got ${g.theirGain.toFixed(1)}`);
});

check("an asymmetric trade moves both sides' value in opposite directions", () => {
  // The only group that pins the verdict function -- gradeTrade/applyTrade are
  // otherwise untested by anything that isn't symmetric. Everything here is
  // deliberately lopsided: a cheap-ladder star for a dud, plus a future first
  // going the other way, so myGain, theirGain and marketDelta all have to be
  // non-zero and to disagree with each other.
  //
  // SpareWeak/SpareB stay on my roster through the whole trade -- neither
  // moves. Two things had to be true simultaneously to give `poolA = poolB`
  // something real to break, and both were measured, not guessed:
  //
  //   1. The pool must actually DIFFER before/after. With only Star/Dud
  //      swapping (each side holding exactly one roster player), a lone
  //      player's keeper status never depends on which team holds him, so
  //      the excluded set is IDENTICAL before and after by construction --
  //      measured, poolA and poolB were the same set (both excluded exactly
  //      Star) and the mutation was a silent no-op. SpareWeak+SpareB already
  //      fill my 2 keeper slots before the trade, so Star's arrival forces a
  //      real bump: SpareWeak (the weaker of the two BY IMPACT) is pushed
  //      back into the pool.
  //   2. The freed player must be good enough to actually get DRAFTED once
  //      back in the pool, or his presence there is academic. This is the
  //      one that cost the most measurement: with SpareWeak's vorp in the
  //      150-225 range, chooseKeepers bumped him exactly as designed but
  //      currentDraftValue came out byte-identical with or without him in the
  //      pool, because the 240-player filler board always had a same-or-
  //      better filler candidate at every one of the 8 rollout picks --
  //      being freed is not the same as being chosen. SpareWeak's vorp (250)
  //      is set to comfortably beat the filler board's best same-position
  //      alternative actually selected in this rollout (measured: RBf5,
  //      245.75), and SpareB's cost (R14) is set deep enough that his own
  //      impact ceiling stays far above SpareWeak's, so it is SpareWeak who
  //      is always the one bumped, not SpareB.
  //
  // `them` holds TWO 2027 R1 picks (an earlier, separate acquisition) and
  // this trade moves only one. A correct withoutPicks leaves them holding the
  // other; a "remove every matching key" bug strips both.
  //
  // A no-op applyTrade, a shared pool, a theirGain computed from my own
  // states, or a withoutPicks that removes every matching key instead of one
  // each break at least one assertion below (verified by mutation --
  // task-4-report.md's "Review fixes" section has the results).
  //
  // Measured against the real filler board: myGain 96.5, theirGain -118.8,
  // marketDelta -339.4. Every threshold below keeps better than 2x margin off
  // the measured value -- tight enough to mean something, loose enough not to
  // be noise-flaky.
  const ctx = CTX();
  const spareWeak = withHistory(ctx, P("SpareWeak", "RB", 250), 4);   // cost R3
  const spareB = withHistory(ctx, P("SpareB", "WR", 200), 15);        // cost R14
  const star = withHistory(ctx, P("Star", "RB", 260, { adp: 8, adp_round: 1 }), 13);  // cost R12
  const dud = withHistory(ctx, P("Dud", "WR", 60, { adp: 200, adp_round: 15 }), 13);  // cost R12
  ctx.board = filler.concat([spareWeak, spareB, star, dud]);
  const me = state([dud, spareWeak, spareB], allPicks());
  const them = state([star],
    allPicks().concat([{ season: 2027, round: 1 }, { season: 2027, round: 1 }]));
  const g = T.gradeTrade({ me, them },
    { toMe:   { players: [star], picks: [{ season: 2027, round: 1 }] },
      toThem: { players: [dud],  picks: [] } }, ctx);
  assert.ok(g.myGain > 40, `I must gain materially; got ${g.myGain.toFixed(1)}`);
  assert.ok(g.theirGain < -40, `they must lose materially; got ${g.theirGain.toFixed(1)}`);
  assert.ok(g.marketDelta < -100,
    `taking their star AND their first must look bad to them; got ${g.marketDelta.toFixed(1)}`);
  // A tight, EXACT pin on top of the loose thresholds above: recompute both
  // gains from the public draftPool/stateValue building blocks (each pinned
  // independently elsewhere in this file) and require gradeTrade's numbers to
  // match to the cent. This is what actually catches `poolA = poolB` --
  // SpareWeak returning to the pool is worth only ~6-9 points here (measured),
  // real but far smaller than any myGain/theirGain threshold loose enough to
  // not be flaky on its own. An exact-recompute check has no such floor.
  const poolBCheck = T.draftPool(ctx, me, them);
  const poolACheck = T.draftPool(ctx, g.myAfter, g.themAfter);
  const expectMyGain = T.stateValue(g.myAfter, poolACheck, ctx) - T.stateValue(me, poolBCheck, ctx);
  const expectTheirGain = T.stateValue(g.themAfter, poolACheck, ctx) - T.stateValue(them, poolBCheck, ctx);
  assert.ok(Math.abs(g.myGain - expectMyGain) < 0.01,
    `myGain must match the same formula recomputed independently; got ${g.myGain.toFixed(2)} vs expected ${expectMyGain.toFixed(2)}`);
  assert.ok(Math.abs(g.theirGain - expectTheirGain) < 0.01,
    `theirGain must match the same formula recomputed independently; got ${g.theirGain.toFixed(2)} vs expected ${expectTheirGain.toFixed(2)}`);
  // The post-trade states are part of the contract -- Task 6 renders them.
  assert.ok(g.myAfter.roster.some(p => p.name === "Star"), "the star must land on my roster");
  assert.ok(!g.myAfter.roster.some(p => p.name === "Dud"), "the dud must leave my roster");
  assert.ok(g.themAfter.roster.some(p => p.name === "Dud"));
  const myR1 = g.myAfter.picks.filter(p => p.season === 2027 && p.round === 1).length;
  const themR1 = g.themAfter.picks.filter(p => p.season === 2027 && p.round === 1).length;
  assert.strictEqual(myR1, 1, "exactly one future first must move to me");
  assert.strictEqual(themR1, 1,
    "they held TWO 2027 R1s and gave up only one -- withoutPicks removing every " +
    "matching key instead of one would leave zero");
});

check("a trade can only move what each side actually holds", () => {
  // Measured: without this, a team with an empty roster "giving" me a
  // 300-point player produces a fully-formed +68.0 verdict computed from a
  // fictional roster -- the same failure mode applyTradedPicks already
  // guards against for traded picks. applyTrade takes no ctx, so nothing
  // here needs a board.
  const ghost = P("Ghost", "RB", 300);
  const me = state([], []), them = state([], []);
  assert.throws(
    () => T.applyTrade(me, them, { players: [ghost], picks: [] }, { players: [], picks: [] }),
    /does not hold player/, "they cannot give a player their roster doesn't hold");
  assert.throws(
    () => T.applyTrade(me, them,
      { players: [], picks: [] }, { players: [], picks: [{ season: 2029, round: 1 }] }),
    /does not hold pick/, "you cannot give a pick you don't hold");
  // assertHolds matches ONE HELD COPY PER PICK GIVEN -- `held.splice(i, 1)`.
  // Deleting that splice left only the empty-holdings case covered, so a team
  // holding ONE R3 could "give" TWO and the trade went through. This is the
  // reachable half of the same defect withoutPicks had.
  const oneR3 = state([], [{ season: 2026, round: 3 }]);
  assert.doesNotThrow(() => T.applyTrade(oneR3, them,
    { players: [], picks: [] }, { players: [], picks: [{ season: 2026, round: 3 }] }),
    "giving the one R3 it holds is legal");
  assert.throws(() => T.applyTrade(oneR3, them,
    { players: [], picks: [] },
    { players: [], picks: [{ season: 2026, round: 3 }, { season: 2026, round: 3 }] }),
    /does not hold pick 2026R3/,
    "holding ONE of a round and giving TWO must be rejected, not silently allowed");
});

check("giving away two picks of the same round moves both, not one", () => {
  // withoutPicks used `new Set(gone.map(...))`, which collapses two identical
  // `season R round` keys into one entry: the giver lost ONE of its two R3s and
  // kept the other while the receiver was credited both, so a pick was
  // FABRICATED. Same Set-collapse shape as the 40.8-point keeper collision, one
  // function away, and reachable from the UI (two clickable rows) and from the
  // suggester's packages(), which enumerates exactly these pairs.
  const me = state([], allPicks().concat([{ season: 2026, round: 3 }]));   // two R3s
  const them = state([], allPicks());
  const both = [{ season: 2026, round: 3 }, { season: 2026, round: 3 }];
  const after = T.applyTrade(me, them, { players: [], picks: [] }, { players: [], picks: both });
  const count = (s, r) => s.picks.filter(p => p.season === 2026 && p.round === r).length;
  assert.strictEqual(count(me, 3), 2, "I started with two R3s");
  assert.strictEqual(count(after.me, 3), 0,
    "both R3s must leave; a Set of keys removes only one and I keep a pick I gave away");
  assert.strictEqual(count(after.them, 3), 3, "they started with one and receive two");
  assert.strictEqual(after.me.picks.length, me.picks.length - 2,
    "my pick count must drop by exactly two");
  assert.strictEqual(after.them.picks.length, them.picks.length + 2,
    "their pick count must rise by exactly two");
});

check("THE PREMISE: trading up the keeper ladder is what pays", () => {
  // Pre-draft a roster is at most two keepers and finishRoster drafts all the
  // rest, so ROSTER SHAPE is worth ~0.8 points and the LADDER is worth ~51.
  // (An earlier draft of this plan asserted the shape version. Measured
  //  against the shipped optimizer it moved 0.8 points -- it would have pinned
  //  nothing. See the spec's section 4.1(2).)
  //
  // Same player on both sides. All that differs is what keeping him costs.
  // Rounds are 5/13 (cost R4/R12), not 4/12 (cost R3/R11) -- task-4-
  // resolutions.md Resolution 3: at cost R3 the keeper's impact is negative,
  // so recommendKeepers drops him and the "dear" side keeps NOBODY, which
  // measures "a cheap keeper vs no keeper" rather than the ladder. Measured:
  // rounds 4/12 give 25.65 with chooseKeepers(a) empty (passes, wrong reason);
  // rounds 5/13 give 40.80 with both sides actually keeping.
  //
  // Wave 2 hit the SAME wall one notch further along: choosing keepers by the
  // lineup objective is ~20.4 points stricter than the `slotWeight * vorp -
  // parVorp` ranking it replaced, so at 200 points the dear side stopped
  // keeping and the TEETH assertion below caught it -- exactly as designed.
  // Measured at 200: keeping at cost R4 or R5 is declined, R6 keeps and the gap
  // falls to 20.40, R7 to 10.20. Raising both players to 240 restores a keeper
  // on the dear side at the ORIGINAL rounds 5/13, and the gap comes back to the
  // SAME 40.80. So the fixture moved and the measurement did not.
  const ctx = CTX();
  const dear = withHistory(ctx, P("Dear", "RB", 240), 5);        // cost R4
  const cheapGuy = withHistory(ctx, P("Cheap", "RB", 240), 13);  // cost R12
  ctx.board = filler.concat([dear, cheapGuy]);
  const a = state([dear], allPicks()), b = state([cheapGuy], allPicks());
  assert.strictEqual(T.chooseKeepers(a.roster, a.picks, ctx).length, 1,
    "the expensive side must actually keep him -- otherwise this measures " +
    "'a cheap keeper vs no keeper', not the ladder");
  assert.strictEqual(T.chooseKeepers(b.roster, b.picks, ctx).length, 1);
  const va = T.currentDraftValue(a, T.draftPool(ctx, a), ctx);
  const vb = T.currentDraftValue(b, T.draftPool(ctx, b), ctx);
  assert.ok(vb - va > 25,
    `the cheap ladder must pay a large, obvious premium; got ${(vb - va).toFixed(1)}`);
});

check("roster shape barely moves a PRE-DRAFT state, and that is correct", () => {
  // Pinned so nobody 'fixes' it later by reintroducing an additive shape term:
  // with two keepers there is almost no shape to have.
  //
  // SEPARATE ctx/board per state (task-4-resolutions.md Resolution 5):
  // [rb1,rb2] and [rb1,wr1] are DIFFERENT rosters, so one shared board would
  // leak each state's extra player into the other's pool as a free, ADP-less
  // bonus starter -- Optimizer.fieldTakes only removes players who carry an
  // ADP, so a leaked player never gets drafted away on the "wrong" side, and
  // that cancels the very difference this test measures. Measured: shared
  // board delta 6.25; isolated (below) delta 0.85, which is the 0.8 the spec
  // quotes from the live 695-row board (section 4.1(2)), arrived at
  // independently -- so the isolated fixture and the live board agree and
  // only the shared-board fixture was wrong (Resolution 4, withdrawn).
  //
  // Bound is MIN_GAIN, deliberately: MIN_GAIN is the noise floor for a TRADE
  // GAIN and was never measured as a bound on THIS quantity, but it is ~6x
  // the real 0.85 and what this test exists to catch -- someone reintroducing
  // an additive roster-shape term -- would move this by a starter's worth
  // (100+ points in this fixture), so the bound has enormous headroom either
  // way.
  const ctxA = CTX(), ctxB = CTX();
  const rb1a = withHistory(ctxA, P("RB1", "RB", 220), 10);
  const rb2a = withHistory(ctxA, P("RB2", "RB", 218), 10);
  const rb1b = withHistory(ctxB, P("RB1", "RB", 220), 10);
  const wr1b = withHistory(ctxB, P("WR1", "WR", 218), 10);
  ctxA.board = filler.concat([rb1a, rb2a]);
  ctxB.board = filler.concat([rb1b, wr1b]);
  const twoRb = state([rb1a, rb2a], allPicks());
  const mixed = state([rb1b, wr1b], allPicks());
  const d = Math.abs(T.currentDraftValue(mixed, T.draftPool(ctxB, mixed), ctxB)
                   - T.currentDraftValue(twoRb, T.draftPool(ctxA, twoRb), ctxA));
  assert.ok(d < T.MIN_GAIN,
    `pre-draft shape must sit inside the noise floor; got ${d.toFixed(1)}`);
});

check("marketDelta is positive when they receive more market value", () => {
  const ctx = CTX();
  const mine = P("Mine", "WR", 200, { adp: 10, adp_round: 1 });
  const theirs = P("Theirs", "WR", 100, { adp: 120, adp_round: 10 });
  ctx.board = filler.concat([mine, theirs]);
  const d = T.marketDelta({ players: [mine], picks: [] },
                          { players: [theirs], picks: [] }, ctx);
  assert.ok(d > 0, "giving up the earlier-ADP player looks generous to them");
});

// --- the suggester ----------------------------------------------------------

// FIXTURE DEFECT FOUND AND FIXED (all four groups below): the brief's Step 1
// code built every new test player with `P(name, pos, value)` -- no adp. That
// is the SAME "every board row needs an adp" trap the controller's notes
// name for `fieldTakes`, but it bites here through a different mechanism:
// `offerable()`'s per-player check removes a player from a roster copy while
// he stays on `ctx.board`, and with no adp `fieldTakes` can never sweep him
// out of the pool -- `finishRoster` just drafts him right back for free, so
// EVERY "without X" delta measured exactly 0.00 regardless of which player X
// was, including the roster's best player. Measured directly on "only offers
// players I do not need..." below, brief's literal numbers (RB1..RB4 =
// 210-i*2, no adp): losing RB1 cost 0.00, same as losing RB4 -- an exact tie
// across four differently-valued removals, the same "itself a strong signal
// something structural is going on" smell task-3-report.md flagged for the
// identical symptom. Fix: give every new board row a real adp (as the rest of
// this file already does for `filler`), AND -- separately, discovered while
// verifying the fix -- give RB1 a real margin over RB2-4, not just a distinct
// number: with adp added but still only a 2-point RB1/RB2 gap, RB1's measured
// loss was 4.00, under MIN_GAIN(5), because RB3 (204) is nearly as good and
// simply replaces him in the keeper slot. Calibrated numbers (RB1 clear of a
// 202-206 fungible tier): RB1 lost=26.00, RB2=2.00, RB3=0.00, RB4=0.00, WR1
// gain=8.80 -- all with comfortable margin around MIN_GAIN=5, verified with a
// standalone script against the real offerable()/suggestTrades before being
// written here, not guessed.
check("never proposes a trade that lowers my own lineup", () => {
  const ctx = CTX();
  const mVals = [230, 206, 204], mAdps = [10, 24, 28];
  const mine = [1, 2, 3].map(i => withHistory(ctx,
    P(`M${i}`, "RB", mVals[i - 1], { adp: mAdps[i - 1], adp_round: Math.ceil(mAdps[i - 1] / 12) }),
    10));
  const tVals = [240, 150], tAdps = [5, 150];
  const theirs = [1, 2].map(i => withHistory(ctx,
    P(`T${i}`, "WR", tVals[i - 1], { adp: tAdps[i - 1], adp_round: Math.ceil(tAdps[i - 1] / 12) }),
    10));
  ctx.board = filler.concat(mine).concat(theirs);
  const me = state(mine, allPicks());
  const out = T.suggestTrades(me, [{ teamId: 2, state: state(theirs, allPicks()) }], ctx);
  // TEETH: with the brief's literal (no-adp) numbers this scenario produces
  // ZERO suggestions and the loop below passes vacuously, checking nothing.
  // Calibrated, it produces 24 real suggestions to check the invariant against.
  assert.ok(out.length > 0, "a real scenario should actually produce suggestions to check");
  for (const s of out) {
    assert.ok(s.myGain > 0, `suggested a losing trade: ${s.myGain}`);
    assert.ok(s.myGain >= T.MIN_GAIN, `below the noise floor: ${s.myGain}`);
  }
});

check("only offers players I do not need, and asks for ones I do", () => {
  const ctx = CTX();
  // Four RBs -- RB1 clearly the best, RB2-4 a fungible surplus tier -- and no
  // WR at all. RB1 needs both a real adp (see the group above this one) AND a
  // real margin over RB2-4 (see the same note) to register as genuinely
  // costly to lose.
  const rbVals = [230, 206, 204, 202], rbAdps = [10, 24, 28, 32];
  const rbs = [1, 2, 3, 4].map(i => withHistory(ctx,
    P(`RB${i}`, "RB", rbVals[i - 1], { adp: rbAdps[i - 1], adp_round: Math.ceil(rbAdps[i - 1] / 12) }),
    10));
  const theirWr = withHistory(ctx, P("WR1", "WR", 208, { adp: 20, adp_round: 2 }), 10);
  ctx.board = filler.concat(rbs).concat([theirWr]);
  const me = state(rbs, allPicks()), them = state([theirWr], allPicks());
  const { mine, theirs } = T.offerable(me, them, ctx);
  const names = a => a.filter(x => x.name).map(x => x.name);
  assert.ok(names(mine).includes("RB4"), "my surplus RB must be offerable");
  assert.ok(!names(mine).includes("RB1"), "my best RB is not surplus");
  assert.ok(names(theirs).includes("WR1"), "the WR I need must be sought");
});

check("suggestions are ranked by my gain and carry all three numbers", () => {
  const ctx = CTX();
  // Same RB calibration as "only offers..." above -- with the brief's literal
  // no-adp/210-i*2 numbers this scenario produced ZERO suggestions (offerable()
  // found no real surplus/need on either side), which fails `out.length > 0`
  // outright rather than exercising "ranked and complete".
  const rbVals = [230, 206, 204, 202], rbAdps = [10, 24, 28, 32];
  const rbs = [1, 2, 3, 4].map(i => withHistory(ctx,
    P(`RB${i}`, "RB", rbVals[i - 1], { adp: rbAdps[i - 1], adp_round: Math.ceil(rbAdps[i - 1] / 12) }),
    10));
  const theirs = [
    withHistory(ctx, P("BigWR", "WR", 240, { adp: 5, adp_round: 1 }), 10),
    withHistory(ctx, P("SmallWR", "WR", 150, { adp: 150, adp_round: 13 }), 10),
  ];
  ctx.board = filler.concat(rbs).concat(theirs);
  const out = T.suggestTrades(state(rbs, allPicks()),
    [{ teamId: 7, state: state(theirs, allPicks()) }], ctx);
  assert.ok(out.length > 0, "an obvious shape mismatch must produce a suggestion");
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].myGain >= out[i].myGain, "must be sorted by my gain");
  }
  for (const s of out) {
    for (const k of ["teamId", "toMe", "toThem", "myGain", "theirGain", "marketDelta"]) {
      assert.ok(k in s, `suggestion missing ${k}`);
    }
  }
});

check("an ineligible player is never suggested as an asset, on EITHER side", () => {
  // He returns to the draft pool for everybody, so trading FOR him is worth 0
  // and shopping him is worth 0 -- `offerable`'s `keepable` predicate excludes
  // ineligible players from BOTH sides for that reason.
  //
  // THE OLD VERSION OF THIS GROUP ASSERTED NOTHING. Its scenario (one RB
  // against one ineligible star) produced zero suggestions, so the
  // `for (const s of out)` body never ran and deleting
  // `Keepers.eligible(c, ctx.season)` from `keepable` survived the whole suite.
  // Two things were missing: the explicit `out.length > 0` TEETH line the two
  // neighbouring groups already carry, and a scenario that actually produces
  // suggestions.
  //
  // MY side is the half with real teeth. An ineligible player THEY hold is
  // already screened out by offerable's own MIN_GAIN test -- acquiring him
  // gains nothing, because he sits in the draft pool either way -- so the
  // eligibility check is belt-and-braces there. An ineligible player on MY
  // roster is the opposite case: losing him costs 0, and costing < MIN_GAIN is
  // precisely what marks a player as surplus, so without `eligible` he becomes
  // the tool's favourite thing to offer -- a 300-point name that is worth
  // literally nothing to the manager receiving it.
  //
  // Scenario is the calibrated "suggestions are ranked" one (which does produce
  // suggestions) plus an ineligible star on each roster.
  const ctx = CTX();
  const rbVals = [230, 206, 204, 202], rbAdps = [10, 24, 28, 32];
  const rbs = [1, 2, 3, 4].map(i => withHistory(ctx,
    P(`RB${i}`, "RB", rbVals[i - 1], { adp: rbAdps[i - 1], adp_round: Math.ceil(rbAdps[i - 1] / 12) }),
    10));
  const myStar = withHistory(ctx, P("MyR1Star", "TE", 300, { adp: 2, adp_round: 1 }), 1);   // cost R0
  const theirStar = withHistory(ctx, P("R1Star", "WR", 300, { adp: 1, adp_round: 1 }), 1);  // cost R0
  const theirs = [
    withHistory(ctx, P("BigWR", "WR", 240, { adp: 5, adp_round: 1 }), 10),
    withHistory(ctx, P("SmallWR", "WR", 150, { adp: 150, adp_round: 13 }), 10),
    theirStar,
  ];
  ctx.board = filler.concat(rbs).concat([myStar]).concat(theirs);
  assert.strictEqual(T.chooseKeepers([myStar], allPicks(), ctx).length, 0, "an R1 keeper cost is R0");
  assert.strictEqual(T.chooseKeepers([theirStar], allPicks(), ctx).length, 0);
  const me = state(rbs.concat([myStar]), allPicks());
  const them = state(theirs, allPicks());
  // `offerable` is the function actually under test, so check it directly as
  // well as through the suggestions -- a scenario that later stops producing
  // trades then cannot quietly turn this group vacuous a second time.
  const { mine, theirs: sought } = T.offerable(me, them, ctx);
  const names = a => a.filter(x => x.name).map(x => x.name);
  assert.ok(names(mine).length > 0, "TEETH: I must have something to offer at all");
  assert.ok(names(sought).length > 0, "TEETH: and something to want");
  assert.ok(!names(mine).includes("MyR1Star"),
    "an ineligible player of mine is worth 0 to a partner and must not be shopped");
  assert.ok(!names(sought).includes("R1Star"),
    "an ineligible player of theirs is worth 0 to me and must not be sought");
  const out = T.suggestTrades(me, [{ teamId: 3, state: them }], ctx);
  assert.ok(out.length > 0, "TEETH: the scenario must produce suggestions to check");
  for (const s of out) {
    assert.ok(!(s.toMe.players || []).some(p => p.name === "R1Star"),
      "an ineligible player has no pre-draft value and must not be sought");
    assert.ok(!(s.toThem.players || []).some(p => p.name === "MyR1Star"),
      "an ineligible player has no pre-draft value and must not be offered");
  }
});

// --- dedup: one offer per real offer -----------------------------------------

// Wave 4 (final-fixes-wave4.md): packages() enumerates every 1- and 2-asset
// combination, so a real move appears once alone and once again for every
// worthless pick that can ride along -- measured on the live board, 108
// suggestions across six opponents were 8 real ones. Both groups below share
// one scenario (same ctx/board -- there is only ONE roster pairing here, not
// two states being compared, so the "separate ctx.board per state" rule does
// not apply) because it is what naturally produces BOTH shapes at once: some
// padded-duplicate groups to collapse, and -- at the SAME myGain, so a dedup
// that keys on myGain instead of substance cannot pass by accident -- a
// second real trade that must NOT collapse with the first.
function dedupScenario() {
  const ctx = CTX();
  const rbVals = [230, 206, 204, 202], rbAdps = [10, 24, 28, 32];
  const rbs = [1, 2, 3, 4].map(i => withHistory(ctx,
    P(`RB${i}`, "RB", rbVals[i - 1], { adp: rbAdps[i - 1], adp_round: Math.ceil(rbAdps[i - 1] / 12) }),
    10));
  const theirs = [
    withHistory(ctx, P("BigWR", "WR", 240, { adp: 5, adp_round: 1 }), 10),
    withHistory(ctx, P("SmallWR", "WR", 150, { adp: 150, adp_round: 13 }), 10),
  ];
  ctx.board = filler.concat(rbs).concat(theirs);
  // worthless1/2: pickForRound(30/31, 12) is 354/366, past the end of this
  // 246-row board, so Optimizer.parVorp indexes off the end and marketValue
  // is exactly 0 -- padding by the brief's own definition. realPick (R3) is
  // squarely on the board and prices well above 0, so a package built with it
  // is a genuinely different offer, not a padded copy of a smaller one.
  const worthless1 = { season: 2026, round: 30 };
  const worthless2 = { season: 2026, round: 31 };
  const realPick = { season: 2026, round: 3 };
  assert.strictEqual(T.marketValue(worthless1, ctx), 0);
  assert.strictEqual(T.marketValue(worthless2, ctx), 0);
  assert.ok(T.marketValue(realPick, ctx) > 0,
    "the pick used for the negative case below must carry real market value");
  const me = state(rbs, [worthless1, worthless2, realPick]);
  const them = state(theirs, allPicks());
  return { ctx, rbs, theirs, me, them };
}
const giveNames = o => (o.toThem.players || []).map(p => p.name).sort().join(",");
const givePicks = o => (o.toThem.picks || []).map(p => `${p.season}R${p.round}`).sort().join(",");
const getNames = o => (o.toMe.players || []).map(p => p.name).sort().join(",");
const getPicks = o => (o.toMe.picks || []).map(p => `${p.season}R${p.round}`).sort().join(",");

check("suggestTrades collapses offers that differ only by a worthless pick, keeping the best myGain", () => {
  const { ctx, me, them } = dedupScenario();

  // Reconstruct the RAW pre-dedup scored list the same way suggestTrades
  // computes it internally (suggestCandidates -> scoreCandidate, the "thin
  // wrapper" the comment above suggestTrades describes), so this test checks
  // against the real distribution rather than a hardcoded number.
  const raw = [];
  for (const c of T.suggestCandidates(me, them, ctx)) {
    const s = T.scoreCandidate(me, them, c, ctx);
    if (s) raw.push(s);
  }
  const group = raw.filter(o =>
    giveNames(o) === "RB3" && getNames(o) === "" && getPicks(o) === "2026R14,2026R15");
  // TEETH: if this is not >= 2, the scenario does not actually exercise
  // padding and the assertions below pass vacuously.
  assert.ok(group.length >= 2,
    `scenario must produce padded duplicates to dedup, got ${group.length}`);
  assert.ok(group.some(o => givePicks(o) === ""),
    "the un-padded 1-for-2 offer must be among the raw candidates");
  assert.ok(group.some(o => givePicks(o) === "2026R30" || givePicks(o) === "2026R31"),
    "a padded variant (worthless pick riding along) must be among the raw candidates");
  const bestRaw = Math.max(...group.map(o => o.myGain));

  const out = T.suggestTrades(me, [{ teamId: 7, state: them }], ctx);
  const deduped = out.filter(o =>
    giveNames(o) === "RB3" && getNames(o) === "" && getPicks(o) === "2026R14,2026R15");
  assert.strictEqual(deduped.length, 1,
    `padded duplicates must collapse to one offer, got ${deduped.length}`);
  assert.strictEqual(deduped[0].myGain, bestRaw,
    "the surviving offer must carry the best myGain seen in the group");
  assert.strictEqual(givePicks(deduped[0]), "",
    "on an exact tie the fewer-assets offer (no padding pick attached) must survive");
});

check("offers that differ by a pick carrying real market value do not collapse", () => {
  // Direct construction via scoreCandidate + dedupOffers, rather than fishing
  // two offers out of suggestTrades' full package search: candA and candB
  // differ ONLY by whether my real 2026 R3 (confirmed nonzero market value
  // below) rides along -- the exact "same trade, one extra asset" shape
  // padding produces, but with a SUBSTANTIVE asset instead of a worthless
  // one. The group above (worthless picks) cannot catch a dedup that treats
  // EVERY pick as padding regardless of value: it never puts a priced pick in
  // the key at all. This one does, and it caught exactly that bug when tried
  // (a `.filter(p => false)` mutation of the substance check passed the group
  // above and collapsed this one to a single offer).
  const ctx = CTX();
  const rbVals = [230, 206, 204, 202], rbAdps = [10, 24, 28, 32];
  const rbs = [1, 2, 3, 4].map(i => withHistory(ctx,
    P(`RB${i}`, "RB", rbVals[i - 1], { adp: rbAdps[i - 1], adp_round: Math.ceil(rbAdps[i - 1] / 12) }),
    10));
  const theirs = [
    withHistory(ctx, P("BigWR", "WR", 240, { adp: 5, adp_round: 1 }), 10),
    withHistory(ctx, P("SmallWR", "WR", 150, { adp: 150, adp_round: 13 }), 10),
  ];
  ctx.board = filler.concat(rbs).concat(theirs);
  const realPick = { season: 2026, round: 3 };
  assert.ok(T.marketValue(realPick, ctx) > 0, "the pick used here must carry real market value");

  const me = state(rbs, [realPick]);
  const them = state(theirs, allPicks());
  const RB3 = rbs[2], SmallWR = theirs[1];

  // minGain is lowered to -Infinity: this pair's shared myGain (measured
  // below, not assumed) sits under the suggester's own MIN_GAIN=5 noise
  // floor, which is irrelevant to what this group tests (dedup's substance
  // key, not the gain bar) -- scoreCandidate's opts.minGain exists precisely
  // to let a caller move that bar.
  const opts = { minGain: -Infinity };
  const candA = { toThem: { players: [RB3], picks: [] }, toMe: { players: [SmallWR], picks: [] } };
  candA.md = T.marketDelta(candA.toThem, candA.toMe, ctx);
  const candB = { toThem: { players: [RB3], picks: [realPick] }, toMe: { players: [SmallWR], picks: [] } };
  candB.md = T.marketDelta(candB.toThem, candB.toMe, ctx);
  const sA = T.scoreCandidate(me, them, candA, ctx, opts);
  const sB = T.scoreCandidate(me, them, candB, ctx, opts);
  assert.ok(sA && sB, "TEETH: both candidates must score to compare them");
  // TEETH for the "dedup keys on myGain" failure mode specifically: giving
  // away the extra pick does not cost me anything in THIS scenario, so a
  // dedup that used myGain as (part of) its identity would see no difference
  // between these two offers at all.
  assert.strictEqual(sA.myGain, sB.myGain,
    "the scenario must tie on myGain, or this test does not exercise the risk it targets");

  const offerA = Object.assign({ teamId: 7 }, sA);
  const offerB = Object.assign({ teamId: 7 }, sB);
  const holdings = { mine: me.picks, theirs: new Map([[7, them.picks]]) };
  const deduped = T.dedupOffers([offerA, offerB], ctx, holdings);
  assert.strictEqual(deduped.length, 2,
    "a real, non-zero-priced pick makes this a DIFFERENT offer, not padding -- both must survive");
});

// A board shaped like the LIVE one rather than like `filler`: value_points keep
// descending all the way down, but `vorp` is 0 from row 96 on. That is the only
// property that makes marketValue clamp to 0 -- Optimizer.parVorp is
// max(0, board[pick-1].vorp) -- and on the live board it is true of 599 of the
// 695 rows and of every pick from round 9 down. `filler` cannot reproduce it
// (its vorp descends 250 -> 47 and never reaches 0), which is precisely why the
// wave-4 dedup tests had to reach for fictional rounds 30 and 31 to get a
// zero-priced pick at all, and why the defect below survived them.
const clampedFiller = filler.map((p, i) =>
  Object.assign({}, p, { vorp: i < 96 ? p.vorp : 0 }));

check("on a pick-depleted state, R9 and R12 are different offers, not padding", () => {
  // THE DEFECT: the substance key called a pick padding when marketValue == 0.
  // parVorp clamps to 0 from about R9 down, so on a state holding ONLY R9-R15
  // every pick it owns priced at 0 -- including its FIRST selection. Measured
  // on the live board, two offers differing only by whether 2026 R9 or 2026 R12
  // rode along keyed to the same bucket while sitting 12.90 points of myGain
  // apart, and three distinct offers collapsed into one.
  const ctx = CTX({ board: clampedFiller });
  // Keeper costs R14, so the pair consumes R14 and R13 (downward on a
  // collision) and leaves the EARLY picks unspent -- which is what makes R9 and
  // R12 differ in the lineup currency at all.
  const mine = [1, 2].map(i => withHistory(ctx,
    P(`DepRB${i}`, "RB", 210 - i * 4, { adp: 20 + i * 6, adp_round: 2 }), 15));
  // Late ADP, high value: the board-vs-market gap this whole tool exists
  // to trade on, and the only way the prefilter's marketDelta >= 0 bar lets
  // a zero-priced pick buy him at all.
  const star = withHistory(ctx, P("DepStar", "WR", 250, { adp: 150, adp_round: 13 }), 10);
  ctx.board = clampedFiller.concat(mine).concat([star]);

  // R9-R15 only: the pick-depleted regime every trade involving a pick lands in.
  const depleted = allPicks().filter(p => p.round >= 9);
  const me = state(mine, depleted);
  const them = state([star], allPicks());
  const r9 = { season: 2026, round: 9 }, r12 = { season: 2026, round: 12 };

  // TEETH 1: both picks really are market-worthless, so the OLD key put them in
  // the same bucket. Without this the group could pass on a board where R9
  // simply prices above 0 and the fix is never exercised.
  assert.strictEqual(T.marketValue(r9, ctx), 0);
  assert.strictEqual(T.marketValue(r12, ctx), 0);

  // A PLAYER RIDES ALONG ON THE GIVE SIDE, and that is load-bearing rather than
  // scenery. With a pick-only give side both offers fall into the ALL-PADDING
  // fallback branch, which keys on the raw pick list and so keeps them apart
  // whatever the padding rule says -- the group would pass identically against
  // the broken code. With a player present the substance key is exercised for
  // real: the old rule keyed both to "DepRB1|" and collapsed them into one.
  const opts = { minGain: -Infinity };
  const spare = mine[0];
  const mk = pick => {
    const c = { toThem: { players: [spare], picks: [pick] },
                toMe: { players: [star], picks: [] } };
    c.md = T.marketDelta(c.toThem, c.toMe, ctx);
    return Object.assign({ teamId: 7 }, T.scoreCandidate(me, them, c, ctx, opts));
  };
  const a = mk(r9), b = mk(r12);
  // TEETH 2: the two offers must actually differ in the currency the page
  // prints, or "they must not collapse" is a claim about nothing.
  assert.ok(Math.abs(a.myGain - b.myGain) > 1,
    `giving up R9 must cost measurably more than giving up R12; got `
    + `${a.myGain.toFixed(2)} vs ${b.myGain.toFixed(2)}`);

  const holdings = { mine: me.picks, theirs: new Map([[7, them.picks]]) };
  assert.strictEqual(T.dedupOffers([a, b], ctx, holdings).length, 2,
    "on a state holding R9-R15 the R9 is the team's FIRST selection: these are "
    + "two different offers, whatever the market prices them at");
});

check("on a FULL complement the late rounds are still padding and still collapse", () => {
  // The other side of the same rule, and the reason the fix is a narrowing
  // rather than a repeal: a pick past the holder's rollout horizon really is
  // padding, and wave 4's collapsing must survive. Same board and the same two
  // currencies as the group above -- only the holder's pick list changes.
  const ctx = CTX({ board: clampedFiller });
  // Keeper costs R14, so the pair consumes R14 and R13 (downward on a
  // collision) and leaves the EARLY picks unspent -- which is what makes R9 and
  // R12 differ in the lineup currency at all.
  const mine = [1, 2].map(i => withHistory(ctx,
    P(`FullRB${i}`, "RB", 210 - i * 4, { adp: 20 + i * 6, adp_round: 2 }), 15));
  // Late ADP, high value: the board-vs-market gap this whole tool exists
  // to trade on, and the only way the prefilter's marketDelta >= 0 bar lets
  // a zero-priced pick buy him at all.
  const star = withHistory(ctx, P("FullStar", "WR", 250, { adp: 150, adp_round: 13 }), 10);
  ctx.board = clampedFiller.concat(mine).concat([star]);

  const me = state(mine, allPicks());
  const them = state([star], allPicks());
  const r14 = { season: 2026, round: 14 }, r15 = { season: 2026, round: 15 };
  assert.strictEqual(T.marketValue(r14, ctx), 0);
  assert.strictEqual(T.marketValue(r15, ctx), 0);

  // Same give-side shape as the group above (a player plus the pick under test),
  // so the two groups differ in exactly ONE thing -- the holder's complement --
  // and neither can hide in the all-padding fallback.
  const opts = { minGain: -Infinity };
  const spare = mine[0];
  const mk = pick => {
    const c = { toThem: { players: [spare], picks: [pick] },
                toMe: { players: [star], picks: [] } };
    c.md = T.marketDelta(c.toThem, c.toMe, ctx);
    return Object.assign({ teamId: 7 }, T.scoreCandidate(me, them, c, ctx, opts));
  };
  const holdings = { mine: me.picks, theirs: new Map([[7, them.picks]]) };
  assert.strictEqual(T.dedupOffers([mk(r14), mk(r15)], ctx, holdings).length, 1,
    "R14 and R15 of a full complement are both past the rollout horizon and "
    + "worthless on the market: one offer, not two");
});

check("dedupOffers refuses to guess what each side holds", () => {
  // Without the holder's pick list every zero-market pick ranks as "not held"
  // and therefore as substance, so nothing would collapse -- wave 4 silently
  // undone while the call still returned a plausible list. Loud instead.
  const ctx = CTX();
  ctx.board = filler;
  const o = { teamId: 7, myGain: 1, toThem: { players: [], picks: [] },
              toMe: { players: [], picks: [] } };
  assert.throws(() => T.dedupOffers([o], ctx), /holdings/);
  assert.throws(() => T.dedupOffers([o], ctx, { mine: [] }), /holdings/);
});

check("dedupOffers folded one offer at a time equals dedupOffers on the whole list", () => {
  // The premise trademode.js's panel now relies on. It used to keep the RAW
  // accumulator and dedup only at render time, so `finishRun` and the progress
  // line counted the raw list while the renderer and its empty-state branch
  // counted the deduped one -- observed live in Chrome as "40 offer(s) cleared
  // both bars with Team 3" printed above two rows. It now dedups as each offer
  // is accepted, which is only equivalent because dedupOffers keeps a running
  // MAXIMUM per key and a maximum does not care how it is bracketed. If that
  // ever stops being true, the panel's one number silently becomes the wrong
  // one, and this is the group that says so.
  const { ctx, me, them } = dedupScenario();
  const raw = [];
  for (const c of T.suggestCandidates(me, them, ctx)) {
    const s = T.scoreCandidate(me, them, c, ctx);
    if (s) raw.push(Object.assign({ teamId: 7 }, s));
  }
  // TEETH: the list must contain something to collapse, or both sides of the
  // comparison are the same untouched list.
  const holdings = { mine: me.picks, theirs: new Map([[7, them.picks]]) };
  const oneShot = T.dedupOffers(raw, ctx, holdings);
  assert.ok(raw.length > oneShot.length,
    `the scenario must produce duplicates: ${raw.length} raw, ${oneShot.length} deduped`);

  let folded = [];
  for (const o of raw) {
    folded.push(o);
    folded = T.dedupOffers(folded, ctx, holdings);
  }
  const idOf = list => list.map(o =>
    `${o.teamId}|${giveNames(o)}|${givePicks(o)}|${getNames(o)}|${getPicks(o)}|${o.myGain}`)
    .sort();
  assert.deepStrictEqual(idOf(folded), idOf(oneShot),
    "folding dedup in as offers arrive must give the same set as one pass at the end");
});

// --- monotonicity: a state is never worth more WITHOUT an asset -------------

// The invariant nothing else in this file states. Every other group compares
// two constructed scenarios; these two assert a property of THE VALUE FUNCTION
// ITSELF -- removing any single asset must not RAISE Trade.stateValue. Four
// rounds of increasingly sharp scenario tests all missed a sign inversion that
// made surrendering a 2026 R2 for nothing read as a +183.4 GAIN.
//
// One roster, built once and read (never mutated) by both groups: every removal
// below constructs a fresh state object off the same arrays. Eight roster
// players with a spread of keeper costs -- two of them ineligible (cost <= R2,
// so they return to the pool for everybody) -- swept against each of the three
// COMPLEMENTS below plus two further seasons of 15, which is what trademode.js
// hands the page (PICK_SEASONS_AHEAD = 2, so 30 future picks).
//
// WHAT THESE TWO GROUPS DO AND DO NOT COVER. They hold future picks, so they
// measure `stateValue`, which is `currentDraftValue` PLUS `futurePicksValue`.
// The first half is exactly monotone (see the shape sweep below). The second is
// not, and the residue is not a rounding artifact: `futurePicksValue` prices
// future picks with the keeper set chosen to maximise the BASE state, and that
// set does not maximise the augmented ones. Measured on the live board across
// all three complements: 30 of 540 current-season pick removals raise
// `stateValue` (worst +8.55), 6 of 1080 future-pick removals (worst +2.82,
// under the tool's own MIN_GAIN of 5) and 31 of 540 roster removals (worst
// +66.41). With ctx.maxKeepers = 0 every one of those goes to zero, which is
// what identifies the cause. This state is a REGRESSION GUARD on a specific
// scenario, then, not a proof of a universal property -- the shape sweep below
// is the universal one, and it is deliberately kept free of future picks so it
// can be.
//
// Every row carries an `adp`, for the reason `filler` documents above:
// Optimizer.fieldTakes skips players without one, so on an ADP-less board the
// pool never depletes, a removed player is simply re-drafted back for free,
// and every delta in this sweep would measure exactly 0.00 while passing.
// The adps are fractional so they interleave with filler's 1..240 rather than
// tying with them.
const monoCtx = CTX();
const monoRoster = [
  ["MonoA", "RB", 262, 6.5, 1],     // cost R0  -- ineligible
  ["MonoB", "WR", 244, 14.5, 3],    // cost R2  -- ineligible
  ["MonoC", "QB", 236, 26.5, 5],    // cost R4
  ["MonoD", "TE", 228, 38.5, 7],    // cost R6
  ["MonoE", "RB", 214, 54.5, 9],    // cost R8
  ["MonoF", "WR", 202, 78.5, 11],   // cost R10
  ["MonoG", "RB", 188, 110.5, 13],  // cost R12
  ["MonoH", "WR", 176, 150.5, 15],  // cost R14
].map(([name, pos, val, adp, round]) => withHistory(monoCtx,
  P(name, pos, val, { adp, adp_round: Math.ceil(adp / 12) }), round));
monoCtx.board = filler.concat(monoRoster);

// THE PICK COMPLEMENTS EVERY SWEEP BELOW RUNS AGAINST.
//
// Wave 2's monotonicity groups reported "0 of 180 violations" and it was true
// -- of states holding all fifteen current-season picks, which is the ONE
// complement the fixture ever built (`shapeState` hardcoded `picks:
// allPicks()`). Every trade that moves a pick produces a state holding fewer,
// and in that regime the defect was intact: measured on the live board, 14 of
// 180 single-player removals RAISED their own team's value on an R9-R15
// complement, worst +88.67, and through the public `gradeTrade` a team holding
// R9-R15 could give a player away for nothing and read +81.74. The guard could
// not see any of it, because the fixture guaranteed the assertion it made --
// the sixth time this branch has been bitten by that exact shape.
//
// So: three complements, not one. FULL; EARLY-DEPLETED (no R1-R4, what a team
// that has spent its early capital holds); and LATE-ONLY (R9-R15, the extreme a
// two-pick trade reaches, and the one the re-review found worst). Each is swept
// in full, and every group below reports which complement failed.
const COMPLEMENTS = [
  ["full", allPicks()],
  ["no R1-R4", allPicks().filter(p => p.round > 4)],
  ["R9-R15", allPicks().filter(p => p.round >= 9)],
];

// Two further seasons of 15, which is exactly what trademode.js hands the page
// (PICK_SEASONS_AHEAD = 2, so 30 future picks).
const monoFuture = allPicks(2027, 15).concat(allPicks(2028, 15));
const monoValue = (roster, picks) => {
  const st = state(roster, picks);
  return T.stateValue(st, T.draftPool(monoCtx, st), monoCtx);
};
// Drops ONE COPY of a pick, so a complement holding two of a round keeps one.
const dropPick = (picks, season, round) => {
  let done = false;
  return picks.filter(p => {
    if (!done && p.season === season && p.round === round) { done = true; return false; }
    return true;
  });
};
const worse = (label, v, base) =>
  `  ${label}: without ${v.toFixed(2)} > with ${base.toFixed(2)}  (+${(v - base).toFixed(2)})`;

check("MONOTONICITY (picks): no pick is worth less than nothing", () => {
  // Every current-season pick the complement actually holds, plus rounds 1, 2,
  // 3, 8 and 15 of each future season. The future half is SAMPLED, not
  // exhaustive, and the sample is deliberate: rounds 1-3 are the ones a trade
  // actually moves AND where the discount alternation this wave fixed lived
  // (the live-board violations were 2027 R2, 2028 R2 and 2028 R3), 8 is
  // Optimizer.ROLLOUT_PICKS -- the horizon past which a pick stops changing the
  // simulated lineup -- and 15 is the far tail. Saying so because a silent cap
  // reads as full coverage.
  const bad = [];
  let swept = 0;
  for (const [cname, cur] of COMPLEMENTS) {
    const picks = cur.concat(monoFuture);
    const base = monoValue(monoRoster, picks);
    const removals = cur.map(p => [`${cname} / 2026 R${p.round}`, dropPick(picks, 2026, p.round)]);
    for (const season of [2027, 2028]) {
      for (const r of [1, 2, 3, 8, 15]) {
        removals.push([`${cname} / ${season} R${r}`, dropPick(picks, season, r)]);
      }
    }
    for (const [label, rest] of removals) {
      swept++;
      const v = monoValue(monoRoster, rest);
      if (v > base + 1e-6) bad.push(worse(label, v, base));
    }
  }
  // TEETH on the sweep itself: 15 + 11 + 7 current-season picks and 10 future
  // samples per complement. A complement list that silently stopped producing
  // states would make this group pass while checking nothing, which is the
  // exact failure mode it exists to close.
  assert.strictEqual(swept, 63, `the sweep must actually sweep: ${swept} removals`);
  assert.strictEqual(bad.length, 0,
    `giving these picks away for NOTHING raised the state's value:\n${bad.join("\n")}`);
});

// --- the widened roster sweep ----------------------------------------------

// Wave 1 left the roster group covering ONE state, with a comment saying so:
// after its fix a live-board scan (12 ten-man rosters, 120 single-player
// removals) still found 12 removals that RAISED their own team's value, worst
// +51.45, and this state did not reach any of them. That residue was
// `chooseKeepers` delegating the CHOICE to `Keepers.recommendKeepers`, which
// ranks by `slotWeight * vorp - parVorp` while this file's currency is lineup
// points. Wave 2 made the choice maximise the lineup objective, and this is the
// coverage that keeps it that way.
//
// Each shape gets its OWN ctx and board -- two states with different rosters
// must never share one, because `draftPool(ctx, s)` excludes only THAT state's
// keepers, so the other shape's players stay in the pool as free ADP-carrying
// extras and cancel the very effect under test (the same trap the collision and
// roster-shape groups above document).
function shapeState(label, rows) {
  const ctx = CTX();
  const roster = rows.map(([name, pos, val, adp, round]) => withHistory(ctx,
    P(name, pos, val, { adp, adp_round: Math.ceil(adp / 12) }), round));
  ctx.board = filler.concat(roster);
  // NO PICK LIST HERE, and that is the wave-5 change: `shapeSweep` runs every
  // shape against all three COMPLEMENTS instead. Hardcoding `picks: allPicks()`
  // was what let item 1 survive a full wave -- see the COMPLEMENTS note above.
  return { label, ctx, roster };
}
// CURRENT-SEASON PICKS ONLY, and that is a deliberate boundary rather than a
// convenience. On a state holding only this season's picks, `stateValue` IS
// `currentDraftValue`, which is EXACTLY monotone in the roster once keepers are
// chosen by the objective AND against the picks the state actually holds: every
// keeper set open to the smaller roster was already open to the larger one, so
// its maximum cannot be beaten. Wave 2 established the first half of that and
// wave 5 the second -- while the selection scored against a full complement and
// the valuation against `state.picks`, the argument covered only the complement
// the old fixture happened to build. Measured on the live board, 12 rosters x
// 15 players x these same three complements: 0 of 540 removals raise
// `currentDraftValue`, against 0 / 9 / 14 of 180 before wave 5.
//
// `futurePicksValue` is swept by the `monoState` groups above, which hold all
// 30 future picks; keeping it out here is what makes THIS sweep an exact
// statement about keeper selection rather than a mixed one.
function shapeSweep(s) {
  const KK = require("../site/assets/keepers.js");
  const bad = [];
  let swept = 0;
  for (const [cname, picks] of COMPLEMENTS) {
    const value = r => {
      const st = state(r, picks);
      return T.stateValue(st, T.draftPool(s.ctx, st), s.ctx);
    };
    const base = value(s.roster);
    for (const p of s.roster) {
      swept++;
      const v = value(s.roster.filter(x => x !== p));
      if (v > base + 1e-6) {
        bad.push(`  ${s.label} [${cname}] without ${p.name} `
          + `(cost R${KK.keeperCost(T.candidate(p, s.ctx), s.ctx.season)}): `
          + `${v.toFixed(2)} > ${base.toFixed(2)}  (+${(v - base).toFixed(2)})`);
      }
    }
  }
  return { bad, swept };
}

// THREE REAL COUNTEREXAMPLES, not invented ones: found by sweeping randomly
// generated shapes against the PRE-wave-2 code and written out longhand,
// smallest first. Each line records what the old selection did, so a
// regression is recognisable rather than just red. All three are outside the
// generated sweep's seed range below, which contains 13 more of its own.
const NAMED_SHAPES = [
  // Old: keeps S73_0@R4 + S73_5@R12. Giving S73_5 away for nothing read
  // +25.20, and giving S73_0 away read +13.65. The objective keeps
  // S73_0@R4 + S73_3@R6 and is worth 1801.25 from the FULL roster.
  shapeState("shape 73", [
    ["S73_0", "TE", 289, 178.3, 5],   // cost R4
    ["S73_1", "QB", 189, 192.6, 4],   // cost R3
    ["S73_2", "RB", 176, 92.1, 9],    // cost R8
    ["S73_3", "RB", 239, 12.5, 7],    // cost R6
    ["S73_4", "RB", 168, 187.8, 5],   // cost R4
    ["S73_5", "RB", 197, 117.6, 13],  // cost R12
    ["S73_6", "TE", 169, 106.3, 13],  // cost R12
  ]),
  // Old: keeps S62_1@R13 + S62_5@R3 for 1860.30; dropping S62_5 for nothing
  // read +30.60. The objective keeps S62_1@R13 + S62_3@R8 and reads 1901.10
  // from the same roster -- 40.80 points the old choice left on the table.
  shapeState("shape 62", [
    ["S62_0", "QB", 183, 11.2, 8],    // cost R7
    ["S62_1", "RB", 266, 167.3, 14],  // cost R13
    ["S62_2", "RB", 240, 57.4, 7],    // cost R6
    ["S62_3", "QB", 215, 124.4, 9],   // cost R8
    ["S62_4", "TE", 201, 44.6, 5],    // cost R4
    ["S62_5", "TE", 278, 151.6, 4],   // cost R3
    ["S62_6", "QB", 265, 198.2, 3],   // cost R2
  ]),
  // The worst of the three, and the closest to the review's own example: old
  // keeps S119_3@R11 + S119_0@R13, and giving S119_0 (a 200-point WR) away for
  // NOTHING read +35.70, because losing him forced the better set
  // S119_3@R11 + S119_1@R7 -- exactly "the team gets richer by getting
  // smaller". The objective picks that better set from the full roster.
  shapeState("shape 119", [
    ["S119_0", "WR", 200, 76.2, 14],  // cost R13
    ["S119_1", "TE", 251, 106.3, 8],  // cost R7
    ["S119_2", "RB", 194, 102.2, 7],  // cost R6
    ["S119_3", "QB", 241, 171.1, 12], // cost R11
    ["S119_4", "TE", 171, 18.6, 12],  // cost R11
    ["S119_5", "RB", 163, 117.6, 12], // cost R11
    ["S119_6", "RB", 260, 146.9, 3],  // cost R2
  ]),
];

// BREADTH on top of those three. Deterministic (a seeded mulberry32, no
// Math.random -- a flaky monotonicity test is worse than none), 40 shapes of
// 5-7 players spanning positions, values 160-290, keeper costs R2-R13 and a
// spread of ADPs. TEETH, measured rather than assumed: against the pre-wave-2
// selection this group reported 18 of 260 removals across 16 of the 43 shapes;
// against the pre-wave-5 one, now that all three COMPLEMENTS are swept, 60 of
// 780 across 31 shapes, worst +166.90. Under the shipped selection all 43 are
// clean on all three. 40 seeds rather than 120 is a runtime call: 40 costs ~21s
// against 120's ~63s now that each shape is swept three times.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const GENERATED_SHAPES = [];
for (let seed = 1; seed <= 40; seed++) {
  const rnd = mulberry32(seed);
  const rows = [];
  const n = 5 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    // Draw order is load-bearing: it is what makes these the same 40 shapes
    // the pre-wave-2 sweep found 13 failures in.
    const pos = ["QB", "RB", "WR", "TE"][Math.floor(rnd() * 4)];
    const val = Math.round(160 + rnd() * 130);
    const round = 3 + Math.floor(rnd() * 12);          // cost R2..R13
    const adp = +(2 + rnd() * 200).toFixed(1);
    rows.push([`G${seed}_${i}`, pos, val, adp, round]);
  }
  GENERATED_SHAPES.push(shapeState(`shape g${seed}`, rows));
}

check("MONOTONICITY (roster): no player is worth less than nothing", () => {
  // Removing a player leaves him ON ctx.board, which is the model: a player
  // nobody keeps returns to the draft pool. So a non-kept roster player is a
  // no-op by construction and only the keeper slots can move this.
  //
  // Wave 1's version of this group tested ONE state and said in a comment that
  // it was not coverage. Wave 2 added 43 shapes. Wave 5 added the thing both
  // were missing: EVERY state here is swept against all three COMPLEMENTS, not
  // just a full one. That is where the defect lived, and it is why "0 of 180"
  // was true and useless.
  //
  // TEETH, measured rather than assumed: run against the pre-wave-5 modules the
  // shape sweep reports 60 of 780 removals across 31 of the 43 shapes -- and
  // NOT ONE OF THEM ON THE FULL COMPLEMENT. 32 are on "no R1-R4" and 28 on
  // "R9-R15", worst +166.90. That distribution is the whole lesson: the old
  // fixture swept the one complement where the defect does not appear.
  const K = require("../site/assets/keepers.js");
  const bad = [];
  let monoSwept = 0;
  for (const [cname, cur] of COMPLEMENTS) {
    const picks = cur.concat(monoFuture);
    const base = monoValue(monoRoster, picks);
    for (const p of monoRoster) {
      monoSwept++;
      const v = monoValue(monoRoster.filter(x => x !== p), picks);
      if (v > base + 1e-6) {
        bad.push(worse(`${cname} / ${p.name} `
          + `(cost R${K.keeperCost(T.candidate(p, monoCtx), monoCtx.season)})`, v, base));
      }
    }
  }
  assert.strictEqual(monoSwept, 24, `the sweep must actually sweep: ${monoSwept} removals`);
  assert.strictEqual(bad.length, 0,
    `giving these players away for NOTHING raised the state's value:\n${bad.join("\n")}`);

  const shapes = NAMED_SHAPES.concat(GENERATED_SHAPES);
  let swept = 0;
  const wide = [];
  for (const s of shapes) {
    const r = shapeSweep(s);
    swept += r.swept;
    wide.push(...r.bad);
  }
  // TEETH on the sweep itself: a shape family that silently stopped producing
  // rosters -- or a COMPLEMENTS list that stopped producing complements -- would
  // make this group pass while checking nothing, which is the exact failure mode
  // wave 1's suggester groups were rebuilt to close and the one wave 5 caught
  // here.
  assert.ok(shapes.length === 43 && COMPLEMENTS.length === 3 && swept > 750,
    `the sweep must actually sweep: ${shapes.length} shapes, ${COMPLEMENTS.length} `
    + `complements, ${swept} removals`);
  assert.strictEqual(wide.length, 0,
    `keeper selection made a team richer by making it SMALLER `
    + `(${wide.length} of ${swept} removals):\n${wide.join("\n")}`);
});

console.log(`trade_fixture: ${n} groups OK`);
