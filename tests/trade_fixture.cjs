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
  // SEPARATE ctx and board per scenario, like the cheap-ladder group above.
  // With one shared board, each scenario's draftPool excludes only its OWN
  // keepers, so the other scenario's players stay in the pool -- and they
  // carry no ADP, so Optimizer.fieldTakes never removes them and both rollouts
  // draft an equivalent free bonus RB. That ties the two states for ANY
  // implementation, including a broken one, and makes the assertion below
  // measure nothing. Measured: shared board 1720.80 vs 1720.80; isolated
  // 1692.55 vs 1712.95, the 20.4-point gap the rule is actually worth.
  const ctxC = CTX(), ctxD = CTX();
  const a = withHistory(ctxC, P("Col1", "RB", 240), 4);   // cost R3
  const b = withHistory(ctxC, P("Col2", "RB", 239), 4);   // cost R3 too
  const c = withHistory(ctxD, P("Dis1", "RB", 240), 4);   // cost R3
  const d = withHistory(ctxD, P("Dis2", "RB", 239), 5);   // cost R4
  ctxC.board = filler.concat([a, b]);
  ctxD.board = filler.concat([c, d]);
  const collide = state([a, b], allPicks());
  const distinct = state([c, d], allPicks());
  assert.strictEqual(T.chooseKeepers(collide.roster, ctxC).length, 2);
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
    assert.throws(() => T.chooseKeepers([], broken), /ctx\./, field);
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
  const ctx = CTX();
  const dear = withHistory(ctx, P("Dear", "RB", 200), 5);        // cost R4
  const cheapGuy = withHistory(ctx, P("Cheap", "RB", 200), 13);  // cost R12
  ctx.board = filler.concat([dear, cheapGuy]);
  const a = state([dear], allPicks()), b = state([cheapGuy], allPicks());
  assert.strictEqual(T.chooseKeepers(a.roster, ctx).length, 1,
    "the expensive side must actually keep him -- otherwise this measures " +
    "'a cheap keeper vs no keeper', not the ladder");
  assert.strictEqual(T.chooseKeepers(b.roster, ctx).length, 1);
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

console.log(`trade_fixture: ${n} groups OK`);
