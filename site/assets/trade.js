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
  // Selection reuses Keepers.recommendKeepers so the trade tool and the keeper
  // panel agree on WHO to keep. (They still differ on what a keeper is WORTH:
  // keepers.js scores `slotWeight * vorp - parVorp`, this file scores lineup
  // points. Unifying them is a recorded follow-up, deliberately not done here
  // -- see the spec's section 10.)
  function chooseKeepers(roster, ctx) {
    requireCtx(ctx);
    const cands = (roster || []).map(p => candidate(p, ctx))
      .filter(c => Number.isFinite(c.vorp));
    const rec = Keepers.recommendKeepers(cands, ctx.season, ctx.board,
      { teams: ctx.teams, maxKeepers: ctx.maxKeepers });
    return rec.map(r => ({ player: r.player, cost: r.cost }));
  }

  // --- state value -----------------------------------------------------------

  // The board minus every keeper anyone has chosen. Players on a roster who
  // are NOT kept go back into the draft, which is why this takes the states
  // rather than the rosters.
  function draftPool(ctx, ...states) {
    requireCtx(ctx);
    const gone = new Set(ctx.keptElsewhere);
    for (const s of states) {
      for (const k of chooseKeepers(s.roster, ctx)) gone.add(k.player.player_id);
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
  // recommendKeepers returned them in, because the function sorts its own
  // input. If the ladder has run below every pick the team holds he takes the
  // cheapest one instead: a keeper the team can barely pay for must never come
  // out cheaper than one it can pay for comfortably. A team holding no picks at
  // all is charged nothing -- there is nothing left to charge.
  function unspentPicks(kept, picks) {
    const left = picks.slice().sort((a, b) => a.round - b.round);
    for (const k of kept.slice().sort((a, b) => a.cost - b.cost)) {
      if (!left.length) break;
      // The LATEST held pick at or before his cost round. `left` is sorted
      // ascending, so the last index that still qualifies is the one.
      let i = -1;
      for (let j = 0; j < left.length && left[j].round <= k.cost; j++) i = j;
      if (i === -1) i = 0;   // nothing at or below: the cheapest pick he can pay with
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
  function currentDraftValue(state, pool, ctx) {
    requireCtx(ctx);
    const kept = chooseKeepers(state.roster, ctx);
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
  // Picks are valued MARGINALLY and summed, which slightly overstates a large
  // haul (each is measured against the state without any of them, so
  // diminishing returns are not compounded). With the handful of picks a real
  // trade moves the error is small, and the alternative -- inserting them all
  // and re-solving -- would hide which pick contributed what.
  function futurePicksValue(state, pool, ctx) {
    requireCtx(ctx);
    const future = (state.picks || []).filter(p => p.season > ctx.season);
    if (!future.length) return 0;
    const base = currentDraftValue(state, pool, ctx);
    // Hoisted out of the loop: neither depends on which future pick is being
    // priced, only on this state's roster and its CURRENT-season picks.
    const kept = chooseKeepers(state.roster, ctx);
    const mine = (state.picks || []).filter(p => p.season === ctx.season);
    const unspentRounds = unspentPicks(kept, mine).map(p => p.round);
    let total = 0;
    for (const p of future) {
      // Exact skip, not an approximation: currentDraftValue simulates only the
      // first Optimizer.ROLLOUT_PICKS picks in pick-number order, so if the state
      // already holds that many unspent picks EARLIER than this one, inserting it
      // cannot change the rollout and its marginal value is exactly 0. Measured:
      // on a full 15-pick complement every future pick of round 8 or later is
      // 0.0000 anyway, so this computes the same answer for less work: measured
      // on the live board, one gradeTrade drops from 307ms to 208ms (-32%).
      // The skipped rollouts are ~45% of them; the rest of the cost is the
      // four currentDraftValue calls the skip cannot avoid.
      // A pick-poor team still values its late future picks, and still gets them
      // priced, because the count is taken from the picks it actually holds.
      const earlier = unspentRounds.reduce((n, r) => n + (r < p.round ? 1 : 0), 0);
      if (earlier >= Optimizer.ROLLOUT_PICKS) continue;
      const asCurrent = Object.assign({}, state, {
        picks: (state.picks || []).concat([{ season: ctx.season, round: p.round }]),
      });
      const marginal = currentDraftValue(asCurrent, pool, ctx) - base;
      total += Math.max(0, marginal) * Math.pow(ctx.futureDiscount, p.season - ctx.season);
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
  const withoutPicks = (list, gone) => {
    const keys = new Set(gone.map(p => `${p.season}R${p.round}`));
    const out = [];
    for (const p of list) {
      const k = `${p.season}R${p.round}`;
      if (keys.has(k)) { keys.delete(k); continue; }   // remove ONE per matching key
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

  // Two-team trades only. The additive prefilter is a SEARCH heuristic and its
  // numbers are never shown: it exists so the honest lineup objective only has
  // to run on plausible packages, the same topCandidates -> finishRoster
  // pattern the draft optimizer uses.
  function suggestTrades(me, others, ctx, opts = {}) {
    requireCtx(ctx);
    const minGain = opts.minGain != null ? opts.minGain : MIN_GAIN;
    const perTeam = opts.perTeam != null ? opts.perTeam : SUGGEST_PER_TEAM;
    const out = [];
    for (const other of others) {
      const them = other.state;
      const { mine, theirs } = offerable(me, them, ctx);
      if (!mine.length || !theirs.length) continue;
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
      // PERFORMANCE: hoisted out of the per-candidate loop below, not part of
      // the brief's given code. Measured on the live 695-row board with a
      // realistic 12-team setup: suggestTrades cost 144.25s as gradeTrade
      // gives it (SUGGEST_PER_TEAM=40 x 11 opponents honest gradeTrade calls),
      // 14x the plan's ~10s budget. gradeTrade recomputes, on EVERY one of
      // those calls, `poolB = draftPool(ctx, before.me, before.them)` and
      // `stateValue(before.me, poolB, ctx)` / `stateValue(before.them, poolB,
      // ctx)` -- but before.me/before.them are `me`/`them`, fixed for this
      // whole opponent, for every one of the (up to perTeam) candidates
      // scored below. Only `moves` (and therefore `after`/`poolA`) varies per
      // candidate. Computing the "before" half once per opponent instead of
      // once per candidate is EXACT, not approximate: it is the identical
      // pure computation gradeTrade would otherwise redo from scratch each
      // time, proven byte-identical against calling gradeTrade in a loop, on
      // the same live-board input, before this change shipped (see the task
      // report). `c.md` is reused the same way immediately below --
      // `marketDelta(toThem, toMe, ctx)` was already computed once per
      // candidate by the prefilter above; gradeTrade would have computed the
      // exact same call a second time.
      const poolB = draftPool(ctx, me, them);
      const beforeMe = stateValue(me, poolB, ctx);
      const beforeThem = stateValue(them, poolB, ctx);
      for (const c of cands.slice(0, perTeam)) {
        const after = applyTrade(me, them, c.toMe, c.toThem);
        const poolA = draftPool(ctx, after.me, after.them);
        const myGain = stateValue(after.me, poolA, ctx) - beforeMe;
        const theirGain = stateValue(after.them, poolA, ctx) - beforeThem;
        if (myGain < minGain || c.md < 0) continue;
        out.push({ teamId: other.teamId, toMe: c.toMe, toThem: c.toThem,
                   myGain, theirGain, marketDelta: c.md });
      }
    }
    out.sort((a, b) => b.myGain - a.myGain);
    return out;
  }

  return { defaultPicks, applyTradedPicks, candidate, chooseKeepers,
           draftPool, currentDraftValue, boardRank,
           futurePicksValue, stateValue, marketValue, marketDelta,
           applyTrade, gradeTrade, offerable, suggestTrades,
           MIN_GAIN, SUGGEST_PER_TEAM, FUTURE_DISCOUNT, MAX_PER_SIDE };
});
