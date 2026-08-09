// site/assets/trade.js
/* Pre-draft trade valuation. Pure math -- no DOM, no network -- so the node
   fixture can require it. Spec:
   docs/superpowers/specs/2026-08-04-trade-calculator-design.md

   THE MODEL. A trade is a different draft. A team's pre-draft state is the
   roster it holds and the picks it holds; its value is the best starting
   lineup it could still finish from there, which is exactly
   Optimizer.finishRoster -> Optimizer.lineupPoints. Everything else falls out.

   TWO ASSET CLASSES, PLAYERS AND PICKS. A keeper is NOT a tradeable thing.
   Pre-draft a player is just a player; keeper designation happens afterwards
   and whoever owns him then sets their own keepers. So keeper status is
   DERIVED from the roster on both sides of every trade, never moved as an
   asset. Two consequences the whole valuation turns on:
     - an acquired player COMPETES for a keeper slot, he does not add one;
     - a keeper-ineligible player (cost <= R2) is worth exactly ZERO pre-draft,
       because he returns to the draft pool for everybody. Last year's first-
       and second-round picks are therefore not tradeable assets at all.

   WHAT IS DELIBERATELY NOT HERE. No additive "trade value chart". Additive
   asset value prices a fifth running back at full freight when he cannot
   start; that defect has been removed from this codebase twice already (v1's
   VORP scoring, and waitCost before 48795d2). It survives here only as a
   search heuristic inside the suggester and never reaches a displayed
   verdict. */
(function (root, factory) {
  const T = factory();
  if (typeof window !== "undefined") window.Trade = T;
  if (typeof module !== "undefined" && module.exports) module.exports = T;
})(this, function () {
  const Optimizer = (typeof window !== "undefined" && window.Optimizer)
    ? window.Optimizer
    : (typeof require !== "undefined" ? require("./optimizer.js") : null);
  const Keepers = (typeof window !== "undefined" && window.Keepers)
    ? window.Keepers
    : (typeof require !== "undefined" ? require("./keepers.js") : null);
  if (!Optimizer || !Keepers) {
    throw new Error("trade.js requires optimizer.js and keepers.js to be loaded first");
  }

  // Every field here fails SILENTLY rather than loudly if it is missing, so it
  // is checked at the door. ctx.season is the worst of them: without it
  // Keepers.keeperCost returns NaN so no player is ever keepable, AND the
  // current-season pick filter matches nothing, so every state values at
  // exactly 0.00 and every trade grades "even" with no error anywhere.
  // keptElsewhere is the quiet one -- `new Set(undefined)` is an empty set,
  // which silently asserts that the other ten teams keep nobody. futureDiscount
  // is the same failure shape one level up: without it, every future-pick
  // Math.pow(...) is NaN, so gradeTrade returns {myGain: NaN, theirGain: NaN,
  // marketDelta: NaN} for any trade touching a future pick -- no throw, just a
  // verdict of NaN.
  //
  // ctx.teams and ctx.maxKeepers are deliberately NOT required: Keepers
  // defaults them to this league's own 12 and 2, so omitting them is correct
  // rather than broken. That default is only free where ctx.teams flows into
  // a function with its own `teams = TEAMS` parameter default -- marketValue's
  // no-ADP fallback divides by it directly, so it carries an explicit local
  // default of its own to keep this promise true rather than reaching NaN.
  // ctx.board throws loudly on its own.
  const CTX_REQUIRED = ["season", "board", "originalByPlayerId", "keptElsewhere", "futureDiscount"];
  function requireCtx(ctx) {
    for (const k of CTX_REQUIRED) {
      if (ctx == null || ctx[k] == null) throw new Error(`trade.js: ctx.${k} is required`);
    }
  }

  // --- pick ownership --------------------------------------------------------

  // Every team starts holding every round of every modelled season; traded
  // picks then move them. Picks are plain {season, round} -- the overall pick
  // NUMBER is not known pre-draft (draft order is unset), so it is derived
  // only when a pick is valued, at its round's mid-slot.
  function defaultPicks(rosterIds, seasons, rounds) {
    const owned = new Map();
    for (const rid of rosterIds) {
      const list = [];
      for (const season of seasons) {
        for (let round = 1; round <= rounds; round++) list.push({ season, round });
      }
      owned.set(rid, list);
    }
    return owned;
  }

  // Sleeper's traded_picks: roster_id is the pick's ORIGINAL owner, owner_id
  // is who holds it now, and `season` is a STRING. Sleeper collapses a chain
  // of trades to one row per pick carrying the final owner, so this is a move,
  // never a replay. Mutates and returns `owned`.
  //
  // Rows we cannot place -- a season we do not model, a roster not in this
  // league, a round beyond the draft -- are IGNORED rather than crashing or
  // inventing a pick: they are real (Sleeper keeps picks for seasons past our
  // horizon) and dropping one costs nothing, while fabricating one would
  // silently hand a team an asset it does not own.
  function applyTradedPicks(owned, tradedPicks) {
    for (const t of tradedPicks || []) {
      const season = Number(t.season), round = Number(t.round);
      const from = owned.get(t.roster_id), to = owned.get(t.owner_id);
      if (!from || !to || !Number.isFinite(season) || !Number.isFinite(round)) continue;
      const i = from.findIndex(p => p.season === season && p.round === round);
      if (i === -1) continue;
      to.push(from.splice(i, 1)[0]);
    }
    return owned;
  }

  // --- derived keepers -------------------------------------------------------

  // `overallRank` means rank across the WHOLE board: keepers.js builds it as
  // the board index in both places it produces one (`overallRank: i + 1`), and
  // Keepers.valueRound divides it by the league size to get a round. It is NOT
  // position_rank -- WR24 has position_rank 24 and a board index near 90, which
  // would price him as a round-2 asset. Cached per board array because the
  // suggester builds candidates thousands of times. Callers must REPLACE
  // ctx.board with a new array rather than mutate it in place -- the cache is
  // keyed on array identity, so an in-place edit serves stale ranks silently.
  const rankCache = new WeakMap();
  function boardRank(board, player) {
    let byId = rankCache.get(board);
    if (!byId) {
      byId = new Map(board.map((p, i) => [p.player_id, i + 1]));
      rankCache.set(board, byId);
    }
    const r = byId.get(player.player_id);
    return r != null ? r : board.length + 1;   // off the board: past the last row
  }

  // A board player + his league draft history, in the shape Keepers'
  // cost/eligibility functions expect. No draft row in the chain means he was
  // never drafted here, which is the waiver ladder (R12 on the first keep).
  function candidate(player, ctx) {
    const orig = ctx.originalByPlayerId.get(player.player_id);
    const c = { name: player.name, position: player.position,
                vorp: player.vorp, adpRound: player.adp_round,
                overallRank: boardRank(ctx.board, player), player };
    if (orig) {
      c.originalRound = orig.round;
      c.originalYear = orig.season;
      c.isWaiver = false;
    } else {
      c.isWaiver = true;
    }
    return c;
  }

  // Which players a team would actually keep. DERIVED on both sides of every
  // trade -- never an input, because pre-draft the keeper tag is moot and a
  // manager may even designate one BECAUSE they intend to shop him.
  //
  // CHOSEN BY THE OBJECTIVE THIS FILE DISPLAYS, not by the keeper panel's
  // ranking. This used to delegate the choice to Keepers.recommendKeepers,
  // which ranks by `slotWeight * vorp - parVorp`; this branch's currency is
  // projected starting-lineup points. Where the two disagree, the delegated
  // choice is not the best set BY THE NUMBER THE PAGE PRINTS -- and that made
  // the value function NON-MONOTONE IN THE ROSTER: giving a player away for
  // nothing could force the better keeper set and leave the team worth MORE.
  // Measured on the live board before this change, 12 of 120 single-player
  // removals raised their own team's value, worst +51.45 (the review's own
  // scan: 12 of 120, worst +46.52; the worst single case it traced was a team
  // whose recommendKeepers preferred a 10.3-impact receiver over a 9.0-impact
  // quarterback -- a 1.3-point margin in ITS currency that cost 151.7 points
  // in lineup points).
  //
  // Maximising the displayed objective removes that by construction, not by
  // tuning: every keeper set available to a smaller roster was already
  // available to the larger one, so the larger roster's maximum is at least
  // the smaller one's. No approximation gives that guarantee, so every
  // eligible subset of size 0..maxKeepers is enumerated (see KEEPER_TOPK).
  //
  // Keepers.keeperCost and Keepers.eligible stay AUTHORITATIVE -- the cost
  // ladder and who is even keepable are unchanged, and both arrive here via
  // Keepers.rankKeepers. Only the choice among eligible candidates moved.
  //
  // The keeper PANEL (keepers.js) still ranks by `slotWeight * vorp - parVorp`,
  // so the two tools can still name different keepers. That divergence is the
  // remaining follow-up -- see the spec's section 10.

  // Enumerate EVERY eligible subset. The top-K variants (restrict the
  // enumeration to the K best by Keepers.rankKeepers) are cheaper but NOT
  // guaranteed monotone -- removing a player can reshuffle which candidates
  // are in the top K -- so they are measured in
  // .superpowers/sdd/final-fixes-wave2-report.md rather than shipped.
  // Infinity is the exact setting and the one that ships.
  const KEEPER_TOPK = Infinity;

  // Index combinations of size 0..max over 0..n-1, size-ascending then
  // lexicographic. Deterministic, which is what makes the tie-break below a
  // rule rather than an accident of enumeration order.
  function indexSubsets(n, max) {
    const out = [[]];
    let level = [[]];
    for (let size = 1; size <= max; size++) {
      const next = [];
      for (const c of level) {
        for (let i = (c.length ? c[c.length - 1] + 1 : 0); i < n; i++) next.push(c.concat([i]));
      }
      for (const c of next) out.push(c);
      level = next;
    }
    return out;
  }

  // MEMOIZED, and that is what makes an exact selection affordable at all --
  // NOT a micro-optimisation. COUNTED, not assumed, on a live-board 15-man
  // roster at the shipped horizon (trademode.PICK_SEASONS_AHEAD = 2, so 30
  // future picks): `chooseKeepers` runs 33 times per `stateValue` and 132 times
  // per `gradeTrade` -- the plan said 23 and ~92, which undercounts, because
  // `futurePicksValue` calls `currentDraftValue` once per future pick and
  // `draftPool` calls it once per state on top. Every one of those calls is on
  // the SAME roster array reference (`futurePicksValue` rebuilds its states
  // with `Object.assign({}, state, {picks})`, so `roster` is identity-stable),
  // so the memo collapses them to 1 selection per `stateValue` and 3 per
  // `gradeTrade` -- measured.
  //
  // That collapse is the whole budget. A selection is now 1 + n + C(n,2)
  // finishRoster rollouts for n eligible candidates -- 106 on a 14-eligible
  // roster, against ONE cheap ranking before. Measured end to end on the live
  // board, `suggestTrades` for one opponent: 18.1 s memoized against 338.6 s
  // unmemoized, byte-identical output. Do not remove this as pointless: wave 1
  // measured the OLD implementation at 0.03 ms against `currentDraftValue`'s
  // 2.55 ms, so memoizing THAT saved ~1% and the whole-branch review's claim
  // that memoization would "fund" this fix was wrong about the old code. It
  // funds the NEW code, by 18.7x.
  //
  // Keyed per ctx AND on the ctx fields the answer depends on, not per ctx
  // alone: trademode.js REASSIGNS `world.ctx.keptElsewhere` on every partner
  // change and `world.ctx.futureDiscount` on every discount edit, on the same
  // ctx object. keptElsewhere changes the pool a candidate set is valued
  // against, so a cache keyed on ctx identity alone would serve the previous
  // partner's answers silently. A nested WeakMap<ctx, WeakMap<roster>> plus an
  // explicit generation check on those fields is the cheap way to say so; a
  // changed field drops that ctx's roster cache rather than returning stale.
  // (futureDiscount is deliberately NOT in the signature -- it only prices
  // FUTURE picks, which never reach a keeper decision.)
  //
  // Third level: the CURRENT-SEASON PICK LIST, because the selection now sees
  // it (see selectKeepers' PICKS note). Encoded as the sorted round numbers
  // joined with "," -- order-independent, so two states holding the same rounds
  // in different orders share one entry, and DUPLICATE-PRESERVING, because a
  // team can hold two of a round and "3,3" is a different complement from "3".
  // Comma-joined rather than concatenated so "1,2" cannot collide with "12".
  // Future picks are excluded outright: they never reach a keeper decision, and
  // including them would give `futurePicksValue`'s 31 augmented lists 31 keys,
  // which is precisely the cost the fourth argument to `currentDraftValue`
  // exists to avoid.
  const keeperCache = new WeakMap();
  const keeperSig = ctx => [ctx.season, ctx.board, ctx.originalByPlayerId,
                            ctx.keptElsewhere, ctx.teams, ctx.maxKeepers, ctx.rounds];
  function keeperCacheFor(ctx) {
    const sig = keeperSig(ctx);
    let e = keeperCache.get(ctx);
    if (!e || e.sig.some((v, i) => v !== sig[i])) {
      e = { sig, byRoster: new WeakMap() };
      keeperCache.set(ctx, e);
    }
    return e.byRoster;
  }
  const currentPicks = (picks, ctx) => (picks || []).filter(p => p.season === ctx.season);
  const picksKey = (picks, ctx) =>
    currentPicks(picks, ctx).map(p => p.round).sort((a, b) => a - b).join(",");

  function selectKeepers(roster, picks, ctx) {
    const cands = (roster || []).map(p => candidate(p, ctx))
      .filter(c => Number.isFinite(c.vorp));
    const opts = { teams: ctx.teams, maxKeepers: ctx.maxKeepers };
    // rankKeepers is the single source of eligibility (Keepers.eligible), cost
    // (Keepers.keeperCost) and the panel's ordering, all three at once.
    const ranked = Keepers.rankKeepers(cands, ctx.season, ctx.board, opts);
    if (!ranked.length) return [];
    const maxKeepers = ctx.maxKeepers != null ? ctx.maxKeepers : Keepers.MAX_KEEPERS;

    // A candidate set is valued exactly the way currentDraftValue values the
    // state it produces: the set is the roster, the rest of the draft is played
    // out from the picks the set leaves UNSPENT, and the pool is the board
    // minus everyone already off it. So a set that costs more than it is worth
    // scores below the empty set on its own -- the cost is not counted twice,
    // and "keep nobody" needs no special case beyond being in the enumeration.
    //
    // Two deliberate reference choices, both of which keep this a pure function
    // of (roster, ctx) and therefore memoizable on the roster:
    //
    //   PICKS: the CURRENT-SEASON PICKS THE STATE ACTUALLY HOLDS. This used to
    //   be a full 1..15 complement regardless, on the argument that
    //   `futurePicksValue` values 31 pick lists against one identity-stable
    //   roster so keying the cache on picks would drop the hit rate to zero.
    //   That argument confused two different pick lists. Keepers are chosen
    //   ONCE, in reality, against the picks the team holds; the future-pick loop
    //   is a valuation proxy, and appending a simulated current-year pick to
    //   measure a 2027 pick's marginal must not change who the team keeps. So
    //   the loop keeps passing the ORIGINAL picks here (currentDraftValue's
    //   fourth argument) and only the valuation sees the augmented list -- which
    //   leaves ~1 selection per distinct state, exactly as before.
    //
    //   Threading them matters because `currentDraftValue` then evaluates the
    //   chosen set against `state.picks`. While the two lists differed, wave 2's
    //   "monotone by construction" argument established only that the
    //   FULL-COMPLEMENT objective's maximum is monotone, and said nothing about
    //   the objective the page prints -- and every trade involving a pick
    //   produces a state where they differ. Measured on the live board before
    //   this change, a team holding only R9-R15 could give a player away for
    //   nothing and gain (worst +41.38 here, +81.74 in the re-review's own
    //   scan); after it, 0 of 180 across all three complements.
    //
    //   POOL: the board minus ctx.keptElsewhere only. It cannot also exclude
    //   the OTHER side's keepers the way `draftPool` does, because those are
    //   chosen by this same function -- that is circular. On a single state
    //   (which is what the monotonicity sweep measures) the two agree exactly;
    //   inside gradeTrade each side's keepers are chosen against a pool very
    //   slightly richer than the one its value is finally computed on.
    const spend = currentPicks(picks, ctx);
    const goneElsewhere = new Set(ctx.keptElsewhere);
    const basePool = ctx.board.filter(p => !goneElsewhere.has(p.player_id));
    const scoreSet = set => {
      const ids = new Set(set.map(c => c.player.player_id));
      const picks = unspentPicks(set, spend)
        .map(p => Keepers.pickForRound(p.round, ctx.teams))
        .sort((a, b) => a - b);
      return Optimizer.lineupPoints(Optimizer.finishRoster(
        set.map(c => c.player), basePool.filter(p => !ids.has(p.player_id)), picks, 0));
    };

    // TIE-BREAK: wherever the objective is INDIFFERENT, keep what the keeper
    // panel would have said, so the two tools still agree everywhere the change
    // does not actually matter. Implemented by making recommendKeepers' own
    // answer the incumbent and replacing it only on a STRICT improvement; every
    // other tie then falls to indexSubsets' fixed order. This cannot affect the
    // VALUE -- ties are equal by definition -- only which of two equal sets is
    // named.
    const recIds = new Set(Keepers.recommendKeepers(cands, ctx.season, ctx.board, opts)
      .map(r => r.player.player_id));
    const setKey = set => set.map(c => c.player.player_id).sort().join("|");
    let best = ranked.filter(c => recIds.has(c.player.player_id));
    let bestVal = scoreSet(best);
    const bestKey = setKey(best);
    const pool = ranked.slice(0, KEEPER_TOPK);
    for (const combo of indexSubsets(pool.length, maxKeepers)) {
      const set = combo.map(i => pool[i]);
      if (setKey(set) === bestKey) continue;      // the incumbent, already scored
      const v = scoreSet(set);
      if (v > bestVal) { bestVal = v; best = set; }
    }
    return best.map(c => ({ player: c.player, cost: c.cost }));
  }

  // The returned array is SHARED with every other caller holding the same
  // roster reference AND the same current-season pick complement (see the memo
  // above) -- read it, never mutate it. `unspentPicks` already copies before
  // sorting, which is why it is safe.
  //
  // `picks` is the state's FULL pick list, not a pre-filtered one: the key and
  // the selection both filter to ctx.season themselves, so a caller can hand
  // over `state.picks` and be right. ctx moved to the third position rather
  // than gaining an optional fourth, deliberately: a call site left on the old
  // two-argument form passes ctx as `picks` and undefined as `ctx`, which
  // `requireCtx` throws on immediately instead of silently selecting keepers
  // against an empty complement.
  function chooseKeepers(roster, picks, ctx) {
    requireCtx(ctx);
    if (roster == null || typeof roster !== "object") return selectKeepers(roster, picks, ctx);
    const byRoster = keeperCacheFor(ctx);
    let byPicks = byRoster.get(roster);
    if (!byPicks) { byPicks = new Map(); byRoster.set(roster, byPicks); }
    const k = picksKey(picks, ctx);
    let hit = byPicks.get(k);
    if (!hit) { hit = selectKeepers(roster, picks, ctx); byPicks.set(k, hit); }
    return hit;
  }

  // --- state value -----------------------------------------------------------

  // The board minus every keeper anyone has chosen. Players on a roster who
  // are NOT kept go back into the draft, which is why this takes the states
  // rather than the rosters.
  function draftPool(ctx, ...states) {
    requireCtx(ctx);
    const gone = new Set(ctx.keptElsewhere);
    for (const s of states) {
      for (const k of chooseKeepers(s.roster, s.picks, ctx)) gone.add(k.player.player_id);
    }
    return ctx.board.filter(p => !gone.has(p.player_id));
  }

  // Which of this season's picks are left after the keepers are paid for.
  //
  // A keeper is paid for with a pick the team ACTUALLY HOLDS, and each keeper
  // consumes exactly one. Three things go wrong the moment that is relaxed
  // into "a set of cost rounds", and all three are the same error:
  //
  //   - Two keepers can compute to the SAME cost round -- two waiver pickups
  //     are both R12, and multi-year ladders converge as they walk down one
  //     round a year -- and a team holds one pick per round, so pricing both
  //     against it handed the team a free extra selection. Measured at 40.8
  //     points of phantom draft capital for a colliding pair.
  //   - A round the team traded away charged nothing, so trading away the very
  //     pick your keeper costs came out free.
  //   - A team holding two of the same round (Sleeper allows it; a traded pick
  //     keeps its original round) lost both to one keeper.
  //
  // Every number this tool displays is a difference of two state values, so a
  // keeper that is free on one side of a trade and not the other reads as pure
  // gain -- and the suggester will hunt for exactly that. Hence: real picks.
  //
  // Most expensive keeper first -- the LOWEST round number, the one giving up
  // the earliest pick -- each taking the LATEST held pick at or before his
  // cost. Downward is this league's actual rule, confirmed by the commissioner:
  // two keepers that both decay to R5 cost R5 and R4, not R5 and R6. It is also
  // the dearer of the two readings, worth 20.4 points on an early collision,
  // and it is the safe one to be wrong about -- upward would quietly discount
  // every pair of keepers that happens to land on the same round, and the
  // suggester would learn to stack them there.
  //
  // The result depends only on the multiset of costs, not on the order
  // chooseKeepers returned them in, because the function sorts its own input --
  // which is also why `selectKeepers` can call it on a raw candidate subset.
  // If the ladder has run below every pick the team holds he takes the
  // EARLIEST one instead -- which is the DEAREST pick it holds, not the
  // cheapest: `left` is sorted ascending by round and the fallback takes
  // `left[0]`. That is the intent the next clause states -- a keeper the team
  // can barely pay for must never come out cheaper than one it can pay for
  // comfortably -- and this comment said "cheapest", which is the opposite
  // reading of the same line. A team holding no picks at all is charged
  // nothing -- there is nothing left to charge.
  function unspentPicks(kept, picks) {
    const left = picks.slice().sort((a, b) => a.round - b.round);
    for (const k of kept.slice().sort((a, b) => a.cost - b.cost)) {
      if (!left.length) break;
      // The LATEST held pick at or before his cost round. `left` is sorted
      // ascending, so the last index that still qualifies is the one.
      let i = -1;
      for (let j = 0; j < left.length && left[j].round <= k.cost; j++) i = j;
      if (i === -1) i = 0;   // nothing at or below: the EARLIEST (dearest) pick he holds
      left.splice(i, 1);
    }
    return left;
  }

  // The best starting lineup this state could still finish, from THIS year's
  // picks. Keepers occupy their cost rounds, so those picks are spent.
  //
  // Draft order is unset pre-draft, so each pick is valued at its round's
  // MID-slot (Keepers.pickForRound) -- pretending to know the exact overall
  // pick would be false precision. fromPick is 0: nothing has been drafted.
  //
  // `keeperPicks` is the pick list the KEEPER SELECTION sees, and it defaults to
  // the state's own -- which is the only thing any real caller wants, and is
  // what makes the selection and this valuation agree exactly on a single
  // state. `futurePicksValue` is the one exception and passes the ORIGINAL
  // state's picks while `state.picks` carries a simulated extra current-year
  // pick: that loop is measuring what a FUTURE pick is worth, and a hypothetical
  // pick appended to price it must not be allowed to change who the team keeps.
  // Keeping it out also holds the selection to one memo entry per state instead
  // of one per iteration, which is the whole cost of this fix.
  function currentDraftValue(state, pool, ctx, keeperPicks) {
    requireCtx(ctx);
    const kept = chooseKeepers(state.roster,
      keeperPicks !== undefined ? keeperPicks : state.picks, ctx);
    const mine = (state.picks || []).filter(p => p.season === ctx.season);
    const picks = unspentPicks(kept, mine)
      .map(p => Keepers.pickForRound(p.round, ctx.teams))
      .sort((a, b) => a - b);
    // Idempotent against the caller's pool: a keeper must not also be
    // draftable. This guards THIS state's keepers only -- the caller still
    // owns excluding every other side's, which is what draftPool is for.
    const keptIds = new Set(kept.map(k => k.player.player_id));
    const usable = (pool || []).filter(p => !keptIds.has(p.player_id));
    return Optimizer.lineupPoints(
      Optimizer.finishRoster(kept.map(k => k.player), usable, picks, 0));
  }

  // --- future picks ----------------------------------------------------------

  // Season points below which a trade gain is not worth acting on -- same
  // reasoning as Keepers.MARGINAL_POINTS: ~5 season points is ~0.3/week,
  // comfortably inside this model's own per-week MAE, so a gain that small
  // cannot be told apart from projection noise. Documented in the plan's
  // Global Constraints (`MIN_GAIN = 5` season points) and spec section 5.2
  // ("default 5 season points, ~0.3/week"). Defined here, not in the
  // suggester (Task 5), because the roster-shape regression test below
  // already needs it as a noise floor -- Task 5 should reuse this constant
  // rather than redeclare it.
  const MIN_GAIN = 5;

  // A 2027 pick has no slot in THIS draft, so finishRoster cannot place it. It
  // is valued in the same currency by asking what the equivalent current-year
  // pick would add, then discounting per season ahead.
  //
  // CUMULATIVE, not independent-and-summed. Each pick's marginal is measured
  // against a state that ALREADY CONTAINS the picks credited before it, so a
  // large haul shows diminishing returns instead of N independent full-freight
  // valuations. Pricing every future pick against the same base state was a
  // sign inversion in the headline number, not a small overstatement: at the
  // shipped horizon (trademode.PICK_SEASONS_AHEAD = 2) every state holds 30
  // future picks, so removing a current-season pick lifted all 30 marginals at
  // once and 30x that lift swamped what the surrendered pick was worth.
  // Measured on the live board, one team giving away its 2026 R2 FOR NOTHING,
  // varying only how many future picks both sides hold --
  //   independent-and-summed:  0 future picks -66.6, 15 picks -13.0, 30 +29.9
  //   cumulative (this code):   0 future picks -66.6, 15 picks -48.6, 30 -35.6
  // -- so at the horizon the page actually ships, the old pricing displayed
  // surrendering a pick for nothing as a GAIN. On a state whose keepers cost
  // early rounds it read as high as +129.7 for the 2026 R2 and +249.4 for the
  // 2026 R5. The old comment here claimed the error was "small for the handful
  // of picks a real trade moves": that is true of the picks that MOVE and
  // irrelevant, because the error is driven by the picks each side already
  // HOLDS.
  //
  // Cumulative also restores the telescoping that makes the sum meaningful:
  // undiscounted and unclamped the marginals sum to (state + all future picks
  // credited) - (state), so the total can never exceed what those picks are
  // jointly worth.
  function futurePicksValue(state, pool, ctx) {
    requireCtx(ctx);
    const future = (state.picks || []).filter(p => p.season > ctx.season);
    if (!future.length) return 0;
    // ROUND ascending, then SEASON ascending. The rollout keys on pick NUMBER,
    // which derives from the round (Keepers.pickForRound at the round's
    // mid-slot), so crediting the best rounds first prices the picks a team
    // would actually use at their full worth and pushes the diminishing tail
    // onto the late ones. Season is only the tie-break among equal rounds, and
    // it runs NEAREST-FIRST: the earlier a copy is credited the larger its
    // marginal tends to be, and the nearest season carries the smallest
    // discount, so pairing them that way is the reading that does not
    // systematically under-price two same-round picks in consecutive years.
    const sorted = future.slice().sort((a, b) => a.round - b.round || a.season - b.season);
    // NO EARLY EXIT, AND THAT IS DELIBERATE. The round-counting skip this
    // replaces ("the state already holds ROLLOUT_PICKS unspent picks earlier
    // than this one, so it cannot enter the rollout") cannot survive cumulative
    // pricing: that count moves every iteration. The obvious replacement --
    // stop at the first non-positive marginal, since with rounds ascending they
    // should be non-increasing -- was TESTED THE WAY THE OLD SKIP WAS, by
    // recomputing the full 30-entry contribution vector with the exit removed,
    // and it is NOT exact. Counterexample, measured on the live board and
    // reproduced on the synthetic one: a state whose keepers cost more than any
    // pick it holds (here, no current-season picks at all) spends the first
    // credited picks paying for those keepers, so the marginal vector opens
    // 0.00, 0.00, 248.90, 206.50, ... -- an exit on the leading zero returned
    // 0.00 against a true 863.34. Marginals are not monotone in general, so
    // every future pick is priced. See final-fixes-wave1-report.md for the cost.
    //
    // `acc` carries this state's OTHER picks too, including the future ones:
    // currentDraftValue filters to `p.season === ctx.season`, so a future pick
    // sitting in the list is inert there, and starting from the full list keeps
    // `prev` and `next` computed from exactly the same shape.
    let acc = (state.picks || []).slice();
    let prev = currentDraftValue(state, pool, ctx);
    let total = 0;
    for (const p of sorted) {
      acc = acc.concat([{ season: ctx.season, round: p.round }]);
      const next = currentDraftValue(Object.assign({}, state, { picks: acc }), pool, ctx,
                                     state.picks);
      const marginal = next - prev;
      total += Math.max(0, marginal) * Math.pow(ctx.futureDiscount, p.season - ctx.season);
      prev = next;
    }
    return total;
  }

  function stateValue(state, pool, ctx) {
    requireCtx(ctx);
    return currentDraftValue(state, pool, ctx) + futurePicksValue(state, pool, ctx);
  }

  // --- market value: what the OTHER manager sees -----------------------------

  // Used ONLY for the acceptability filter, never as a verdict. The
  // counterparty will judge an offer on the market's numbers, not ours, and
  // the edge lives in that gap.
  //
  // A player with no ADP falls back to his board rank. 460 of 695 players on
  // the live board have no ADP, so the fallback is the common case and the UI
  // must LABEL which one it used -- a model opinion reading as a market fact
  // is the bug Keepers.valueLabel was added to fix.
  //
  // The fallback reads `boardRank`, NOT `position_rank`: position_rank is
  // rank WITHIN a position (WR24 has position_rank 24 and a board index near
  // 90), so using it here would price most of the board as first-round
  // assets. Measured on a no-ADP row whose true board position is 241st: a
  // position_rank-based fallback yields round 1, boardRank yields round 21.
  //
  // ZERO IS A REAL, COMMON ANSWER, not a bug: parVorp clamps to 0 once the
  // board row at that pick sits at or below positional replacement, which is
  // true for 599 of the 695 live rows -- every no-ADP player (parVorp's fallback
  // prices him off a board rank that deep too) and every pick from round 9 on.
  // A caller that prints that 0 as if it were a price is showing an empty
  // currency as a real one; the honest label is "no market value (replacement
  // level)", the same rule Keepers.valueLabel exists to enforce for the
  // keeper panel's own round numbers. Task 6 must not render this bare.
  function marketValue(asset, ctx) {
    requireCtx(ctx);
    // ctx.teams is documented above as safe to omit, and IS safe everywhere it
    // passes through Keepers.pickForRound's own `teams = TEAMS` default -- but
    // the no-ADP fallback below divides by it directly, and undefined/12 is
    // NaN, not 12. Default it locally so the omission stays safe throughout
    // this function rather than by accident at three of four call sites.
    const teams = ctx.teams != null ? ctx.teams : Keepers.TEAMS;
    if (asset && asset.season && asset.round) {
      const v = Optimizer.parVorp(ctx.board, Keepers.pickForRound(asset.round, teams));
      return v * Math.pow(ctx.futureDiscount, Math.max(0, asset.season - ctx.season));
    }
    const round = asset.adp_round != null
      ? asset.adp_round
      : Math.ceil(boardRank(ctx.board, asset) / teams);
    return Optimizer.parVorp(ctx.board, Keepers.pickForRound(round, teams));
  }

  const sideMarket = (side, ctx) =>
    (side.players || []).reduce((n, p) => n + marketValue(p, ctx), 0)
    + (side.picks || []).reduce((n, p) => n + marketValue(p, ctx), 0);

  // Positive = they receive more market value than they give, i.e. the offer
  // looks fair-or-better on the numbers they will actually use.
  function marketDelta(toThem, toMe, ctx) {
    requireCtx(ctx);
    return sideMarket(toThem, ctx) - sideMarket(toMe, ctx);
  }

  // --- grading ---------------------------------------------------------------

  const without = (list, gone) => {
    const ids = new Set(gone.map(p => p.player_id));
    return list.filter(p => !ids.has(p.player_id));
  };
  // One removal per COPY GIVEN, not one per distinct key. `new Set(gone.map(...))`
  // collapsed two identical `season R round` keys into a single entry, so a team
  // giving away both of its two R3s lost one and kept the other -- the giver
  // keeps a pick it gave away, and the receiver is credited both. Same
  // Set-collapse shape as the 40.8-point keeper collision `unspentPicks`
  // documents, and reachable from the UI (a team holding two of a round shows
  // two clickable rows) as well as from the suggester's `packages()`, which
  // enumerates pairs. Counted rather than spliced so this stays O(n);
  // `assertHolds` below states the same one-per-copy rule with an array.
  const withoutPicks = (list, gone) => {
    const owed = new Map();
    for (const p of gone || []) {
      const k = `${p.season}R${p.round}`;
      owed.set(k, (owed.get(k) || 0) + 1);
    }
    const out = [];
    for (const p of list || []) {
      const k = `${p.season}R${p.round}`;
      const c = owed.get(k) || 0;
      if (c > 0) { owed.set(k, c - 1); continue; }
      out.push(p);
    }
    return out;
  };

  // A trade may only move what the two sides actually hold. Without this, a
  // caller that names a player nobody owns gets a fully-formed verdict computed
  // from a fictional roster -- measured at +68.0 points for a 300-point ghost.
  // Same rule applyTradedPicks already states: fabricating an asset silently
  // hands a team something it does not own. Task 5 enumerates moves in a loop,
  // which is exactly where a typo becomes a recommendation.
  function assertHolds(state, side, who) {
    for (const p of side.players || []) {
      if (!(state.roster || []).some(r => r.player_id === p.player_id)) {
        throw new Error(`trade.js: ${who} does not hold player ${p.name || p.player_id}`);
      }
    }
    const held = (state.picks || []).map(p => `${p.season}R${p.round}`);
    for (const p of side.picks || []) {
      const i = held.indexOf(`${p.season}R${p.round}`);
      if (i === -1) throw new Error(`trade.js: ${who} does not hold pick ${p.season}R${p.round}`);
      held.splice(i, 1);   // one per held copy, so two of a round need two held
    }
  }

  function applyTrade(me, them, toMe, toThem) {
    assertHolds(me, toThem, "you");
    assertHolds(them, toMe, "they");
    return {
      me: { roster: without(me.roster, toThem.players || []).concat(toMe.players || []),
            picks: withoutPicks(me.picks, toThem.picks || []).concat(toMe.picks || []) },
      them: { roster: without(them.roster, toMe.players || []).concat(toThem.players || []),
              picks: withoutPicks(them.picks, toMe.picks || []).concat(toThem.picks || []) },
    };
  }

  // The three numbers of the spec's section 4, all displayed together:
  // myGain/theirGain in OUR currency (projected lineup points), marketDelta in
  // THEIRS. A trade is worth offering when myGain is real AND marketDelta >= 0.
  function gradeTrade(before, moves, ctx) {
    requireCtx(ctx);
    const after = applyTrade(before.me, before.them, moves.toMe, moves.toThem);
    const poolB = draftPool(ctx, before.me, before.them);
    const poolA = draftPool(ctx, after.me, after.them);
    return {
      myGain: stateValue(after.me, poolA, ctx) - stateValue(before.me, poolB, ctx),
      theirGain: stateValue(after.them, poolA, ctx) - stateValue(before.them, poolB, ctx),
      marketDelta: marketDelta(moves.toThem, moves.toMe, ctx),
      myAfter: after.me, themAfter: after.them,
    };
  }

  // --- the suggester ---------------------------------------------------------

  // MIN_GAIN is declared above (next to futurePicksValue) and reused here --
  // it is NOT redeclared: a second `const MIN_GAIN` in this module scope is a
  // SyntaxError, and Task 4's own comment already anticipates this ("Task 5
  // should reuse this constant rather than redeclare it").
  const SUGGEST_PER_TEAM = 40;   // scored honestly per opponent, after prefilter
  const FUTURE_DISCOUNT = 0.8;
  const MAX_PER_SIDE = 2;        // 1-for-1, 2-for-1, 1-for-2, 2-for-2

  // What each side should even consider moving. Mine: players I can lose for
  // less than MIN_GAIN (surplus), plus my picks. Theirs: players who would
  // gain me at least MIN_GAIN, plus their picks. A player I need is not an
  // asset I am shopping, and a player who does not help me is not one I want.
  //
  // An INELIGIBLE player is excluded from both sides: his keeper cost is R2 or
  // lower so he returns to the draft pool for everybody, and acquiring him
  // pre-draft buys literally nothing.
  function offerable(me, them, ctx) {
    requireCtx(ctx);
    const poolMe = draftPool(ctx, me, them);
    const base = stateValue(me, poolMe, ctx);
    const keepable = p => {
      const c = candidate(p, ctx);
      return Number.isFinite(c.vorp) && Keepers.eligible(c, ctx.season);
    };
    const mine = (me.roster || []).filter(keepable).filter(p => {
      const s = { roster: without(me.roster, [p]), picks: me.picks };
      return base - stateValue(s, draftPool(ctx, s, them), ctx) < MIN_GAIN;
    });
    const theirs = (them.roster || []).filter(keepable).filter(p => {
      const s = { roster: (me.roster || []).concat([p]), picks: me.picks };
      return stateValue(s, draftPool(ctx, s, them), ctx) - base >= MIN_GAIN;
    });
    return { mine: mine.concat(me.picks || []),
             theirs: theirs.concat(them.picks || []) };
  }

  const packages = (assets, max) => {
    const out = assets.map(a => [a]);
    if (max >= 2) {
      for (let i = 0; i < assets.length; i++) {
        for (let j = i + 1; j < assets.length; j++) out.push([assets[i], assets[j]]);
      }
    }
    return out;
  };
  const split = list => ({
    players: list.filter(a => a.player_id !== undefined),
    picks: list.filter(a => a.player_id === undefined),
  });

  // THE CHEAP HALF. The additive prefilter is a SEARCH heuristic and its
  // numbers are never shown: it exists so the honest lineup objective only has
  // to run on plausible packages, the same topCandidates -> finishRoster
  // pattern the draft optimizer uses.
  //
  // Split out from suggestTrades so a caller can drive the EXPENSIVE half
  // (scoreCandidate, one honest gradeTrade apiece at ~0.55-0.8 s) one candidate
  // at a time, yielding the main thread between them -- see trademode.js's
  // batched scorer. This function returns exactly the list the old inline loop
  // consumed: already sorted least-overpay-first, already truncated to perTeam.
  // Array#sort is stable in V8 and in the spec since ES2019, so the order is
  // the same order the single-call version produced.
  function suggestCandidates(me, them, ctx, opts = {}) {
    requireCtx(ctx);
    const perTeam = opts.perTeam != null ? opts.perTeam : SUGGEST_PER_TEAM;
    const { mine, theirs } = offerable(me, them, ctx);
    if (!mine.length || !theirs.length) return [];
    const cands = [];
    for (const give of packages(mine, MAX_PER_SIDE)) {
      for (const get of packages(theirs, MAX_PER_SIDE)) {
        const toThem = split(give), toMe = split(get);
        // Prefilter: keep packages that look fair-or-generous to them, since
        // anything else will simply be declined.
        const md = marketDelta(toThem, toMe, ctx);
        if (md < 0) continue;
        cands.push({ toMe, toThem, md });
      }
    }
    cands.sort((a, b) => a.md - b.md);        // least overpay first
    return cands.slice(0, perTeam);
  }

  // The "before" half of every candidate's grade, memoized per (me, them, ctx).
  //
  // PERFORMANCE, and EXACT rather than approximate -- it is the identical pure
  // computation gradeTrade would otherwise redo from scratch for every
  // candidate. Measured on the live 695-row board with a realistic 12-team
  // setup: suggestTrades cost 144.25s as gradeTrade gives it
  // (SUGGEST_PER_TEAM=40 x 11 opponents honest gradeTrade calls), 14x the
  // plan's ~10s budget. gradeTrade recomputes, on EVERY one of those calls,
  // `poolB = draftPool(ctx, before.me, before.them)` and `stateValue(before.me,
  // poolB, ctx)` / `stateValue(before.them, poolB, ctx)` -- but
  // before.me/before.them are `me`/`them`, fixed for the whole opponent, for
  // every one of the (up to perTeam) candidates scored. Only `moves` (and
  // therefore `after`/`poolA`) varies per candidate.
  //
  // This used to be three plain hoisted locals inside suggestTrades' loop. It
  // became a memo when the scoring loop moved out to the caller: a standalone
  // scoreCandidate has nowhere to hoist to, and recomputing the before half per
  // candidate would have doubled the runtime the split exists to make bearable.
  // Keyed the way chooseKeepers' memo is -- on ctx, plus a generation signature
  // over every field the answer depends on -- because trademode.js REASSIGNS
  // ctx.keptElsewhere on every partner change and ctx.futureDiscount on every
  // discount edit, on the same ctx object. futureDiscount IS in this signature
  // (unlike the keeper memo's), because stateValue prices future picks with it.
  const beforeCache = new WeakMap();
  const beforeSig = (me, them, ctx) => [me, them, ctx.season, ctx.board,
    ctx.originalByPlayerId, ctx.keptElsewhere, ctx.teams, ctx.maxKeepers,
    ctx.rounds, ctx.futureDiscount];
  function tradeBefore(me, them, ctx) {
    const sig = beforeSig(me, them, ctx);
    let e = beforeCache.get(ctx);
    if (!e || e.sig.some((v, i) => v !== sig[i])) {
      const poolB = draftPool(ctx, me, them);
      e = { sig, myValue: stateValue(me, poolB, ctx),
            themValue: stateValue(them, poolB, ctx) };
      beforeCache.set(ctx, e);
    }
    return e;
  }

  // THE EXPENSIVE HALF: one honest gradeTrade for one candidate, returning null
  // when it fails either bar -- exactly what the old inline loop body did with
  // `continue`. `cand.md` is reused rather than recomputed: the prefilter
  // already called marketDelta(toThem, toMe, ctx) once for this candidate, and
  // gradeTrade would make the identical call a second time.
  function scoreCandidate(me, them, cand, ctx, opts = {}) {
    requireCtx(ctx);
    const minGain = opts.minGain != null ? opts.minGain : MIN_GAIN;
    const before = tradeBefore(me, them, ctx);
    const after = applyTrade(me, them, cand.toMe, cand.toThem);
    const poolA = draftPool(ctx, after.me, after.them);
    const myGain = stateValue(after.me, poolA, ctx) - before.myValue;
    const theirGain = stateValue(after.them, poolA, ctx) - before.themValue;
    if (myGain < minGain || cand.md < 0) return null;
    return { toMe: cand.toMe, toThem: cand.toThem,
             myGain, theirGain, marketDelta: cand.md };
  }

  // --- dedup: collapse offers that differ only by a worthless pick -----------
  //
  // packages() enumerates every 1- and 2-asset combination, so one real move
  // appears once alone and once again for every worthless pick that can ride
  // along -- a pick past the rollout horizon prices at marketValue 0 (see
  // marketValue's own comment: parVorp clamps to 0 at or below replacement,
  // true of most of the live board and every pick from round 9 down), so
  // adding one changes myGain and marketDelta by ~nothing. Those padded
  // variants grade almost identically, which is exactly why a manager reading
  // the panel cannot tell them apart -- measured on the live board, 108
  // suggestions across six opponents are 8 real ones (final-fixes-wave4.md).
  //
  // SUBSTANCE = players (by id) + picks whose marketValue is nonzero. A pick
  // priced at 0 is padding by definition.
  //
  // Runs on the FULL, already-honestly-scored list, never before scoring: the
  // prefilter (suggestCandidates' marketDelta check) is a SEARCH heuristic and
  // must not be allowed to discard a package before gradeTrade has judged it.
  // This only ever drops an offer that has an ALREADY-SCORED duplicate sitting
  // next to it with an equal-or-better myGain.
  //
  // GROUPING KEY includes teamId: an identical asset list offered to a
  // DIFFERENT opponent is a different trade (their roster, their gain), not a
  // duplicate, so two opponents never collapse into each other.
  //
  // THE ALL-PADDING CASE. If every asset on a side prices at 0 (a pick-only
  // side where every pick is worthless), that side's substance list is empty,
  // and two UNRELATED all-padding offers would otherwise both key to "" and
  // wrongly collapse into one. Fallback: an empty substance list keys on the
  // side's full raw pick list instead (still sorted), so it only collapses
  // with another offer built from the exact same picks, never an unrelated
  // one -- the "~" prefix keeps this fallback bucket disjoint from the normal
  // "players|picks" key space (a real key never starts with "~" because a
  // sorted player-id list never begins with the character "~").
  function offerSideKey(side, ctx) {
    const players = (side.players || []).map(p => p.player_id).sort();
    const substancePicks = (side.picks || [])
      .filter(p => marketValue(p, ctx) > 0)
      .map(p => `${p.season}R${p.round}`).sort();
    if (!players.length && !substancePicks.length) {
      const raw = (side.picks || []).map(p => `${p.season}R${p.round}`).sort();
      return `~${raw.join(",")}`;
    }
    return `${players.join(",")}|${substancePicks.join(",")}`;
  }

  function offerAssetCount(o) {
    return (o.toThem.players || []).length + (o.toThem.picks || []).length
         + (o.toMe.players || []).length + (o.toMe.picks || []).length;
  }

  // Keeps the best myGain per (teamId, give-substance, get-substance) group.
  // On an exact tie, keeps the offer with fewer total assets -- a clean 1-for-1
  // is a better offer to SEND than the same trade with a late-rounder stapled
  // on, even when the padding is free in both currencies.
  function dedupOffers(offers, ctx) {
    requireCtx(ctx);
    const best = new Map();
    for (const o of offers) {
      const key = `${o.teamId}::${offerSideKey(o.toThem, ctx)}=>${offerSideKey(o.toMe, ctx)}`;
      const assets = offerAssetCount(o);
      const prior = best.get(key);
      if (!prior || o.myGain > prior.offer.myGain
          || (o.myGain === prior.offer.myGain && assets < prior.assets)) {
        best.set(key, { offer: o, assets });
      }
    }
    return Array.from(best.values(), e => e.offer);
  }

  // Two-team trades only. A thin wrapper over the two halves above, with the
  // signature and return value it has always had -- for the node fixture and
  // for any caller that does not need to yield. Proven byte-identical to the
  // single-function version on the live board, all eleven opponents (see
  // final-fixes-wave3-report.md), MODULO dedup (final-fixes-wave4.md): the raw
  // scored list is now deduped before the sort, so the return shape and sort
  // order are unchanged but padded duplicates are gone.
  function suggestTrades(me, others, ctx, opts = {}) {
    requireCtx(ctx);
    const out = [];
    for (const other of others) {
      const them = other.state;
      for (const c of suggestCandidates(me, them, ctx, opts)) {
        const s = scoreCandidate(me, them, c, ctx, opts);
        if (s) out.push(Object.assign({ teamId: other.teamId }, s));
      }
    }
    const deduped = dedupOffers(out, ctx);
    deduped.sort((a, b) => b.myGain - a.myGain);
    return deduped;
  }

  return { defaultPicks, applyTradedPicks, candidate, chooseKeepers,
           draftPool, currentDraftValue, boardRank,
           futurePicksValue, stateValue, marketValue, marketDelta,
           applyTrade, gradeTrade, offerable,
           suggestCandidates, scoreCandidate, suggestTrades, dedupOffers,
           MIN_GAIN, SUGGEST_PER_TEAM, FUTURE_DISCOUNT, MAX_PER_SIDE };
});
