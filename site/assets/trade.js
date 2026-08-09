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
  // Third level: THE WHOLE PICK LIST, current season and future. Wave 5 keyed
  // on the current season alone because future picks "never reach a keeper
  // decision". They do now -- the selection maximises the state's full value,
  // and `pickLadder` turns the future picks into rungs the selection scores
  // against -- so a state's future holdings change who it keeps and must be in
  // the key. Encoded as sorted "season.round" strings joined with "," --
  // order-independent, so two states holding the same picks in a different
  // order share one entry, and DUPLICATE-PRESERVING, because a team can hold
  // two of a round and "2026.3,2026.3" is a different complement from
  // "2026.3". The separators are what stop "2026.1" plus "2026.2" colliding
  // with "2026.12".
  //
  // The key got bigger and the hit rate did NOT drop, because the thing that
  // used to vary per call is gone: `futurePicksValue` no longer walks 30
  // augmented pick lists, it evaluates 2 extra ladder rungs inside one
  // selection. Measured: 4 / 2 / 102 selections for cold gradeTrade / warm
  // gradeTrade / one-opponent suggestTrades, the same counts as wave 5.
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
  const picksKey = picks =>
    (picks || []).map(p => `${p.season}.${p.round}`).sort().join(",");

  // --- the pick ladder -------------------------------------------------------

  // A state's picks as a WEIGHTED LADDER of current-season pick lists, which is
  // the whole of wave 6 in one function.
  //
  // A future pick has no slot in this draft, so it is valued by asking what the
  // equivalent current-year pick would add, then discounting per season ahead.
  // Wave 5 did that as a cumulative CHAIN: one rollout per future pick, each
  // marginal clamped at 0 and multiplied by its own season's discount, credited
  // ROUND-ASCENDING across seasons (`sort((a,b) => a.round - b.round ||
  // a.season - b.season)`) -- wave 5 argued for that order on its own terms.
  // Drop the clamp and a chain telescopes -- the intermediate values cancel and
  // only the segment endpoints survive -- but ONLY if it is credited
  // SEASON-GROUPED, nearest season first, all of that season's rounds added
  // together before moving to the next:
  //
  //   value = (1-d^o1)*V(X0) + (d^o1-d^o2)*V(X1) + ... + d^ok*V(Xk)
  //
  // where X0 is the current-season picks the state holds, Xi adds season i's
  // rounds as simulated current-year picks, and oi is that season's offset.
  // Wave 6 changed BOTH the clamp and the crediting order, and the record
  // (final-fixes-wave6-report.md) said this identity was "verified byte-
  // identical" against wave 5's chain -- that is false. Measured directly, at
  // a fixed keeper set (so only the ordering differs), max |ladder value -
  // wave-5-order chain value| across 12 live-board rosters:
  //
  //   full complement    6.06     no R1-R4   14.10     R9-R15   28.28
  //
  // against 2.3e-13 (floating-point noise) for a season-grouped chain. The
  // shipped formula is still correct -- it is a convex combination of a
  // monotone function, exact against the season-grouped chain -- but "IS wave
  // 5's chain without the clamp" overstated what changed. Of the +56.28 that
  // R9-R15 future picks gained wave 5 -> wave 6 (final-fixes-wave6-report.md
  // section 5), **22.80 is the reordering alone**, holding the keeper set
  // fixed at wave 6's own choice; the wave-6 report attributed the whole
  // +56.28 to the keeper set seeing the full ladder, and that attribution is
  // wrong for the same reason.
  //
  // SEASON-GROUPING IS NOT A STYLE CHOICE, it is what the algebra above
  // requires: the discount below is `Math.pow(ctx.futureDiscount, season -
  // ctx.season)` -- a function of SEASON, not of round. Every pick folded into
  // one rung must share that rung's single scalar weight, which is only true
  // if a rung holds one season's picks. Round-ascending mixes picks from
  // different seasons -- and therefore different discounts -- into one step,
  // so it has no single weight to assign it; the telescoping identity, the
  // convex-combination monotonicity argument below, and the 30 -> 2 rollout
  // count all depend on the rungs being season-grouped. Wave 6 did not choose
  // this order for the identity's convenience -- the identity does not exist
  // in the other order.
  //
  // TWO THINGS FALL OUT, and they are the reason for the rewrite.
  //
  // COST. One rollout per future SEASON instead of one per future PICK: 30 ->
  // 2 at the shipped horizon (trademode.PICK_SEASONS_AHEAD = 2). That is what
  // makes an exact keeper selection affordable at all.
  //
  // MONOTONICITY. The weights are non-negative for 0 <= d <= 1 and sum to 1 --
  // it is a CONVEX COMBINATION. So `stateValue = max over keeper sets S of
  // Sum wi*f(S,Xi)` is a maximum of a weighted sum of functions each of which
  // is monotone in the roster and in the pick list, and every keeper set open
  // to a smaller roster was already open to a larger one. Removing an asset
  // therefore cannot raise it, by construction rather than by tuning.
  //
  // That is precisely what wave 5 could NOT say. There the selection maximised
  // f(S,X0) alone while the value also weighted f(S,X1) and f(S,X2) -- which
  // carry 80% of the weight at d = 0.8 -- so removing an asset could shift the
  // chosen set to one that was better at X1/X2 by more than it was worse at X0.
  // Measured then: 31 of 540 roster removals raised `stateValue`, worst +66.41,
  // and a team holding R9-R15 could still give a player away for nothing and
  // read +64.56 through gradeTrade. With ctx.maxKeepers = 0 every one of those
  // went to zero, which is what identified the cause.
  //
  // THE CLAMP IS GONE, and that is a change to what the page PRINTS as well as
  // to how it computes: a negative marginal is now credited as itself instead
  // of as 0, so a state whose keepers cost more than its picks are worth can
  // price a future haul lower than wave 5 did. Quantified on real trades in
  // final-fixes-wave6-report.md. It is not optional -- the clamp is exactly
  // what stopped the chain telescoping, and without the telescoping there is
  // neither the 30 -> 2 saving nor the convex-combination argument.
  //
  // Returns [{picks, weight}] with at least one rung, so a state with no future
  // picks is [{picks: X0, weight: 1}] and `stateValue` collapses to exactly the
  // current-season draft value with no special case.
  function pickLadder(picks, ctx) {
    const bySeason = new Map();
    for (const p of picks || []) {
      if (p.season <= ctx.season) continue;
      if (!bySeason.has(p.season)) bySeason.set(p.season, []);
      bySeason.get(p.season).push(p);
    }
    const rungs = [];
    let acc = currentPicks(picks, ctx);
    let carried = 1;
    for (const season of Array.from(bySeason.keys()).sort((a, b) => a - b)) {
      const d = Math.pow(ctx.futureDiscount, season - ctx.season);
      rungs.push({ picks: acc, weight: carried - d });
      // ROUND is all that survives the translation: a future pick is priced as
      // the current-year pick of the same round (Keepers.pickForRound at that
      // round's mid-slot), which is the same proxy wave 1 established.
      acc = acc.concat(bySeason.get(season).map(p => ({ season: ctx.season, round: p.round })));
      carried = d;
    }
    rungs.push({ picks: acc, weight: carried });
    return rungs;
  }

  // One keeper set, scored against every rung. `kept` carries `.cost`, which is
  // what `unspentPicks` reads, so this works on both a raw candidate subset
  // (inside the selection) and a chosen set (inside stateValue).
  function ladderValue(kept, rungs, pool, ctx) {
    const players = kept.map(k => k.player);
    let total = 0;
    for (const r of rungs) {
      if (r.weight === 0) continue;           // a zero-weight rung cannot move it
      const nums = unspentPicks(kept, r.picks)
        .map(p => Keepers.pickForRound(p.round, ctx.teams))
        .sort((a, b) => a - b);
      total += r.weight * Optimizer.lineupPoints(
        Optimizer.finishRoster(players, pool, nums, 0));
    }
    return total;
  }

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
    // of (roster, picks, ctx) and therefore memoizable on them:
    //
    //   PICKS: THE WHOLE PICK LIST THE STATE ACTUALLY HOLDS, scored through
    //   `pickLadder` -- so the objective maximised here is EXACTLY the objective
    //   `stateValue` reports, future picks and all. That identity is the fix:
    //   `stateValue = max over S of Sum wi*f(S,Xi)` is a maximum over a
    //   candidate set that only grows with the roster, so it cannot rise when an
    //   asset is removed. See pickLadder's own note for what wave 5 could say
    //   instead and what that cost (31 of 540 roster removals raising the value,
    //   worst +66.41).
    //
    //   Wave 5 scored against the current-season picks alone. Wave 2 scored
    //   against a full 1..15 complement whatever the state held, which is how a
    //   team on R9-R15 could give a player away for nothing and read +81.74.
    //   Each step widened what the selection is allowed to see; this is the last
    //   one, because it is now the whole thing.
    //
    //   POOL: the board minus ctx.keptElsewhere only. It cannot also exclude
    //   the OTHER side's keepers the way `draftPool` does, because those are
    //   chosen by this same function -- that is circular. On a single state
    //   (which is what the monotonicity sweep measures) the two agree exactly;
    //   inside gradeTrade each side's keepers are chosen against a pool very
    //   slightly richer than the one its value is finally computed on.
    const rungs = pickLadder(picks, ctx);
    const goneElsewhere = new Set(ctx.keptElsewhere);
    const basePool = ctx.board.filter(p => !goneElsewhere.has(p.player_id));
    const scoreSet = set => {
      const ids = new Set(set.map(c => c.player.player_id));
      return ladderValue(set, rungs, basePool.filter(p => !ids.has(p.player_id)), ctx);
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
    const k = picksKey(picks);
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
  // DEFINED AS `stateValue` OF THE SAME STATE WITH ITS FUTURE PICKS DROPPED,
  // rather than as "stateValue's first rung". The difference matters and it is
  // the reason this is not one line shorter: on the restricted state the ladder
  // has a single rung of weight 1, so this is again a MAXIMUM over keeper sets
  // and therefore exactly monotone in its own right. Read as a component of the
  // full state's value it would not be -- the keepers a team designates are
  // chosen for the whole ladder, and f(S*, X0) alone is not maximised by S*.
  // That is wave 5's defect in miniature, and defining the function this way is
  // what keeps it out.
  //
  // The cost is a SECOND keeper selection on any state that holds future picks,
  // because the restricted pick list is a different memo key. Nothing on the
  // page pays it: trademode.js never calls this, `stateValue` no longer calls
  // it, and `draftPool` uses the state's real (full-ladder) keepers. It is paid
  // by `futurePicksValue` and by the fixture, both of which want the decomposed
  // number.
  function currentDraftValue(state, pool, ctx) {
    requireCtx(ctx);
    return stateValue({ roster: state.roster, picks: currentPicks(state.picks, ctx) },
                      pool, ctx);
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

  // WHAT THE FUTURE PICKS ARE WORTH: the state's value minus the value of the
  // same state holding only this season's picks. Both halves are maxima over
  // keeper sets (see currentDraftValue), so this is a difference of two exact
  // numbers rather than a sum of marginals, and it is >= 0 by construction --
  // every rung's pick list contains X0, and the set that maximises the
  // restricted problem is available to the full one.
  //
  // THE 30-ROLLOUT CHAIN THIS REPLACES IS IN `pickLadder`, and so is the
  // telescoping identity that makes the two the same computation. What used to
  // live here -- the round-ascending ordering, the deliberate absence of an
  // early exit, the per-pick clamp -- is gone with it: there are no per-pick
  // marginals left to order, to exit early from, or to clamp. The ordering
  // question that survives is which SEASON is credited first, and pickLadder
  // credits nearest-first so the largest marginals carry the smallest discount.
  //
  // Wave 1's finding still holds and is what the ladder preserves: pricing
  // every future pick INDEPENDENTLY against the same base state inverted the
  // sign of the headline number, because at the shipped horizon every state
  // holds 30 future picks and removing a current-season pick lifted all 30 at
  // once. Measured then, one team giving away its 2026 R2 FOR NOTHING --
  //   independent-and-summed:  0 future picks -66.6, 15 picks -13.0, 30 +29.9
  //   cumulative:              0 future picks -66.6, 15 picks -48.6, 30 -35.6
  // The ladder is cumulative in exactly the same sense: rung i contains every
  // pick credited before it, so a large haul shows diminishing returns instead
  // of N full-freight valuations.
  //
  // NOT USED BY `stateValue`, which computes the whole ladder in one pass. This
  // is the decomposition, for the fixture and for anyone who wants the two
  // halves separately, and it costs a second keeper selection to get them.
  function futurePicksValue(state, pool, ctx) {
    requireCtx(ctx);
    if (!(state.picks || []).some(p => p.season > ctx.season)) return 0;
    return stateValue(state, pool, ctx) - currentDraftValue(state, pool, ctx);
  }

  // THE NUMBER THE PAGE PRINTS DIFFERENCES OF. One keeper selection, one ladder,
  // and the identity that makes the whole file monotone:
  //
  //   stateValue(state) = max over keeper sets S of  Sum wi * f(S, Xi)
  //
  // The selection maximises exactly this (selectKeepers scores candidates with
  // the same `ladderValue` against the same rungs), so the equality is not an
  // approximation -- it is the same expression evaluated twice, once to choose
  // S and once to report the value at the caller's pool.
  //
  // Both properties the tool needs follow, without tuning:
  //   - REMOVING A ROSTER PLAYER cannot raise it: every keeper set open to the
  //     smaller roster was already open to the larger one, so the larger one's
  //     maximum is at least the smaller one's.
  //   - REMOVING A PICK cannot raise it: it can only shrink some rung's pick
  //     list, `unspentPicks` returns no better a set from a smaller one, and
  //     the weights are non-negative.
  // Verified rather than asserted -- final-fixes-wave6-report.md sweeps 12
  // live-board rosters x 45 picks x 3 pick complements. Current-season picks
  // 0 of 540, roster players 0 of 540, and the same for currentDraftValue.
  //
  // THE ONE RESIDUE, AND IT IS NOT IN THIS FILE. Future-pick removals are 8 of
  // 1080, worst +4.61 on a ~1557-point state value (0.3%), every one of them
  // under MIN_GAIN. The cause is `Optimizer.finishRoster`, one layer down:
  // its rollout is GREEDY, taking whoever most improves the lineup at each of
  // your picks, so two pick lists with the same number of selections and the
  // same number of field-takes between them can still end in different
  // lineups depending on how the two INTERLEAVE. Reduced to a minimal case on
  // the live board, same roster and same pool, keepers frozen:
  //
  //   picks [6,6,6,18,18,18,30,30] -> 1595.16
  //   picks [6,6,6,18,18,30,30,30] -> 1602.36
  //
  // The first list is a strict superset of the second in value (three R2-slot
  // picks against two, everything else equal), 8 selections and 27 field-takes
  // either way, and it scores 7.20 LOWER. Nothing about keepers, the ladder or
  // the discount is involved -- proved by re-running the sweep with the keeper
  // set frozen, which leaves the violations exactly where they were.
  //
  // It only surfaces on FUTURE-pick removals because that is the only place
  // the ladder produces duplicate pick NUMBERS: rung X2 holds the same round
  // once per season, so dropping one changes the interleaving without changing
  // the count. Left alone deliberately -- fixing it means replacing the greedy
  // rollout, which the draft board also runs, so it would move every number on
  // the other page for 0.3% here.
  function stateValue(state, pool, ctx) {
    requireCtx(ctx);
    const kept = chooseKeepers(state.roster, state.picks, ctx);
    // Idempotent against the caller's pool: a keeper must not also be
    // draftable. This guards THIS state's keepers only -- the caller still owns
    // excluding every other side's, which is what draftPool is for.
    const keptIds = new Set(kept.map(k => k.player.player_id));
    const usable = (pool || []).filter(p => !keptIds.has(p.player_id));
    return ladderValue(kept, pickLadder(state.picks, ctx), usable, ctx);
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
  // SUBSTANCE = players (by id) + picks that are not padding. A pick is PADDING
  // only when it is worth ~nothing in BOTH currencies, and the two currencies
  // disagree constantly once a state has traded picks away:
  //
  //   MARKET half (already here): marketValue == 0. parVorp clamps to 0 once
  //   the board row at that pick sits at or below positional replacement, which
  //   on the live board is true of every pick from round 9 down.
  //
  //   LINEUP half (added in wave 5): the pick must also be past the HOLDER'S
  //   OWN rollout horizon -- more than Optimizer.ROLLOUT_PICKS selections into
  //   the picks he actually holds that season. Round number alone is the wrong
  //   test, because on a pick-depleted state an R9 is the team's FIRST
  //   selection. Demonstrated on the live board: a state holding R9-R15, two
  //   offers differing only by whether 2026 R9 or 2026 R12 rides along -- both
  //   market 0.00, so both keyed to the same bucket, while sitting 12.90 points
  //   of myGain apart. Three distinct offers collapsed into one.
  //
  //   AND a pick in a round the draft never reaches is padding whatever its
  //   rank, because it produces no player at all. `applyTradedPicks` already
  //   refuses to place such a row for the same reason; Sleeper really does
  //   carry them.
  //
  // Deliberately CONSERVATIVE on the lineup half: keepers are not deducted from
  // the holder's list before ranking, even though they will consume picks. Both
  // errors are not equal. Calling substance what is really padding leaves a
  // near-duplicate row on the panel, which the manager can see and ignore;
  // calling padding what is really substance hides a 12.90-point difference he
  // cannot see at all.
  //
  // HOLDINGS is therefore required, and dedupOffers THROWS without it rather
  // than defaulting: with no holder list every zero-market pick ranks as
  // "not held" and nothing collapses, which would silently undo wave 4 (108
  // suggestions where 8 are real) while looking like it worked.
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
  // How many selections into that season's holdings this pick is: 1 for the
  // holder's first, 2 for his second, and 0 when he does not hold it at all --
  // which `assertHolds` makes unreachable through applyTrade, and which a
  // hand-built offer should get SUBSTANCE for rather than a silent collapse.
  function pickRankInHolding(pick, holding) {
    const rounds = (holding || [])
      .filter(p => p.season === pick.season)
      .map(p => p.round).sort((a, b) => a - b);
    return rounds.indexOf(pick.round) + 1;
  }
  function isPaddingPick(pick, holding, ctx) {
    const rounds = ctx.rounds != null ? ctx.rounds : Keepers.DRAFT_ROUNDS;
    if (pick.round > rounds) return true;          // a round the draft never reaches
    if (marketValue(pick, ctx) > 0) return false;  // the market prices it
    const rank = pickRankInHolding(pick, holding);
    return rank > Optimizer.ROLLOUT_PICKS;         // rank 0 (not held) => substance
  }
  function offerSideKey(side, ctx, holding) {
    const players = (side.players || []).map(p => p.player_id).sort();
    const substancePicks = (side.picks || [])
      .filter(p => !isPaddingPick(p, holding, ctx))
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
  //
  // `holdings` is {mine, theirs}: MY pick list (the `toThem` side is drawn from
  // it) and a Map from teamId to that opponent's pick list (the `toMe` side is
  // drawn from theirs). Required -- see the padding note above for why this
  // throws instead of defaulting.
  function dedupOffers(offers, ctx, holdings) {
    requireCtx(ctx);
    if (holdings == null || holdings.mine == null || holdings.theirs == null) {
      throw new Error("trade.js: dedupOffers requires holdings {mine, theirs} "
        + "-- the picks each side holds decide which of them are padding");
    }
    const best = new Map();
    for (const o of offers) {
      const key = `${o.teamId}::${offerSideKey(o.toThem, ctx, holdings.mine)}`
        + `=>${offerSideKey(o.toMe, ctx, holdings.theirs.get(o.teamId))}`;
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
    const deduped = dedupOffers(out, ctx,
      { mine: me.picks, theirs: new Map(others.map(o => [o.teamId, o.state.picks])) });
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
