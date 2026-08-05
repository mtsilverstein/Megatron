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

  // A board player + his league draft history, in the shape Keepers'
  // cost/eligibility functions expect. No draft row in the chain means he was
  // never drafted here, which is the waiver ladder (R12 on the first keep).
  function candidate(player, ctx) {
    const orig = ctx.originalByPlayerId.get(player.player_id);
    const c = { name: player.name, position: player.position,
                vorp: player.vorp, adpRound: player.adp_round,
                overallRank: player.position_rank, player };
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
    const gone = new Set(ctx.keptElsewhere);
    for (const s of states) {
      for (const k of chooseKeepers(s.roster, ctx)) gone.add(k.player.player_id);
    }
    return ctx.board.filter(p => !gone.has(p.player_id));
  }

  // The best starting lineup this state could still finish, from THIS year's
  // picks. Keepers occupy their cost rounds, so those picks are spent.
  //
  // Draft order is unset pre-draft, so each pick is valued at its round's
  // MID-slot (Keepers.pickForRound) -- pretending to know the exact overall
  // pick would be false precision. fromPick is 0: nothing has been drafted.
  function currentDraftValue(state, pool, ctx) {
    const kept = chooseKeepers(state.roster, ctx);
    const spent = new Set(kept.map(k => k.cost));
    const picks = (state.picks || [])
      .filter(p => p.season === ctx.season && !spent.has(p.round))
      .map(p => Keepers.pickForRound(p.round, ctx.teams))
      .sort((a, b) => a - b);
    return Optimizer.lineupPoints(
      Optimizer.finishRoster(kept.map(k => k.player), pool, picks, 0));
  }

  return { defaultPicks, applyTradedPicks, candidate, chooseKeepers,
           draftPool, currentDraftValue };
});
