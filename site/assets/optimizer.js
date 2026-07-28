// site/assets/optimizer.js
/* Pick-time draft optimizer — pure math only (no DOM, no network) so the node
   fixture can require it. Spec: docs/superpowers/specs/2026-07-26-draft-optimizer-design.md

   Objective: maximize expected STARTING-LINEUP VORP. A player's score is his
   marginal contribution to that objective:

     score = vona(X) + W_STEAL * steal(X) - byePenalty(X)

   vona = roster-aware Value Over Next Available. It unifies value, need and
   timing in one term: a player who fills a slot is worth what he beats the
   survivor-at-his-position by (so a deep position scores ~0 = "wait", and a
   cliff scores high = "take him now"); a player who'd ride the bench is worth
   a fraction of his standalone value. There is deliberately no separate `need`
   multiplier or urgency weight -- VORP already prices positional scarcity, so
   adding one would double-count it.

   ---------------------------------------------------------------------------
   v1.1 closes the two gaps the design doc flagged in §11, both INSIDE `vona`.
   Neither adds a scarcity signal: `vona` remains the single term that prices
   value, need and timing, and both refinements only change how that one term
   reads the slot and the player.

   (A) Bands are priced, with the sign set by the slot (§11 "bands unused").
       A player you must START is unhedgeable: you eat his whole distribution
       every week, so his downside room (p50-p10) is a real cost. A player who
       rides the BENCH is an option: you only promote him if he hits, and in a
       keeper league a late hit becomes a cheap keeper and a trade asset, so his
       upside room (p90-p50) is a real credit. Same appetite, opposite sign --
       one constant, W_RISK.
       Crucially the penalty is applied to BOTH sides of the starter comparison
       (the player and the survivor he is measured against), so a uniform level
       shift cancels and only the *differential* spread survives. Two starters
       with equally wide bands score exactly as they do today; a safe starter
       measured against a boom/bust fallback correctly gains.
       Only band WIDTHS are used, never band LEVELS: `vorp` comes from the
       ECR-ordered value curve (board_rank.order_and_value) while p10/p50/p90
       are the player's own model distribution. The levels are not
       interchangeable; the widths are, since both are PPR season points.

   (B) A flex opening is worth less than a dedicated one (§11 "flex replacement
       is per-position"). Two independent reasons, both position-agnostic:
         1. A dedicated slot can only ever be refilled from its own position; a
            flex slot can be refilled from any flex-eligible position. So the
            flex fallback is the best survivor ACROSS FLEX_POS, which is >= the
            single-position survivor by construction. No position ordering is
            hardcoded -- the max is taken over the live board.
         2. A dedicated opening is an obligation (you must field 2 WRs); a flex
            opening is discretionary and, with 2 flex slots and ~11 picks left,
            gets filled by surplus you accumulate anyway. FLEX_WEIGHT scales the
            edge accordingly, completing the ladder
              bench BENCH_WEIGHT(0.2) < flex FLEX_WEIGHT(0.5) < dedicated (1.0).
       Together these stop a greedy run from spending both flex slots on the
       deepest position while a mandatory WR slot sits empty.

   Backward compatibility: with no bands present (`has_bands: false`, or any
   player whose p10/p90 are null) `riskValue` returns `vorp` unchanged, so the
   dedicated and bench branches are byte-identical to v1.0. No caller change is
   required -- the bands are read off the board rows `draftmode.js` already
   passes. The flex branch changes on purpose; that is (B). */
(function (root, factory) {
  const O = factory();
  if (typeof window !== "undefined") window.Optimizer = O;
  if (typeof module !== "undefined" && module.exports) module.exports = O;
})(this, function () {
  const W_STEAL = 0.5;        // steal is a different currency (trade value)
  const BENCH_WEIGHT = 0.2;   // a benched player's share of standalone value
  const BYE_PEN = 3.0;        // VORP points, marginal by design
  const LATE_ROUNDS = 2;      // K/DST nudge window, in rounds remaining
  const SHORTLIST_N = 5;
  const DEDICATED = { QB: 1, RB: 2, WR: 2, TE: 1 };
  const FLEX_SLOTS = 2;
  const FLEX_POS = ["RB", "WR", "TE"];
  const POSITIONS = ["QB", "RB", "WR", "TE"];
  const BYE_STACK_LIMIT = 3;  // penalize the 3rd+ starter sharing a bye
  const CLIFF_MIN = 1.0;      // VORP points below which a "cliff" is just noise

  // --- v1.1 constants: UN-TUNED DEFAULTS -------------------------------------
  // Like W_STEAL / BENCH_WEIGHT / BYE_PEN these encode priorities, not fitted
  // parameters. They were chosen by inspection and are deliberately NOT tuned
  // against the held-out 2023-25 seasons (that would violate the walk-forward
  // eval rule). Revise only by forward observation.

  // Share of a band half-width that is priced in. One constant, applied with
  // opposite signs (floor cost when he must start, ceiling credit when he sits)
  // because there is no evidence to justify two different appetites. 0.25 keeps
  // the term a discriminator, never a driver: on the starter side only the
  // DIFFERENCE in downside room against the fallback survives, so a player
  // whose floor room is 20 points tighter than his fallback's gains 5 VORP
  // points -- enough to break a tie, not enough to invent a cliff.
  const W_RISK = 0.25;

  // A flex opening's share of a dedicated one. 0.5 sits between the bench share
  // (0.2, a player who does not start at all) and a dedicated opening (1.0, a
  // slot you are obligated to field), reflecting that a flex slot is real
  // starting value but discretionary and usually filled from surplus.
  const FLEX_WEIGHT = 0.5;

  // The band ruleset must match the ruleset the value curve was built from:
  // board_rank.order_and_value lays sorted `ppr_p50` onto ECR order, so `vorp`
  // is in PPR season points and the PPR band is the only unit-compatible one.
  const BAND_RULESET = "ppr";

  function rosterSlots(myPlayers) {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const p of myPlayers || []) {
      if (counts[p.position] !== undefined) counts[p.position]++;
    }
    return counts;
  }

  // Which lineup slot this position would fill next: its dedicated starter
  // slot, else a shared flex slot, else nothing (he'd ride the bench).
  function openSlot(pos, counts) {
    const ded = DEDICATED[pos];
    if (ded === undefined) return "none";
    if (counts[pos] < ded) return "dedicated";
    if (!FLEX_POS.includes(pos)) return "none";
    const flexUsed = FLEX_POS.reduce(
      (n, q) => n + Math.max(0, counts[q] - DEDICATED[q]), 0);
    return flexUsed < FLEX_SLOTS ? "flex" : "none";
  }

  // The player's calibrated band, as ROOM either side of the median. Returns
  // null whenever the band is absent or untrustworthy, which is the signal to
  // fall back to v1.0 median-only behavior.
  function bandGaps(player) {
    const points = player && player.season_points;
    const band = points && points[BAND_RULESET];
    if (!band) return null;
    const p10 = band.p10, p50 = band.p50, p90 = band.p90;
    if (!Number.isFinite(p10) || !Number.isFinite(p50) || !Number.isFinite(p90)) {
      return null;                       // has_bands: false publishes nulls here
    }
    if (!(p10 <= p50 && p50 <= p90)) return null;   // crossed quantiles: distrust
    return { p10, p50, p90, down: p50 - p10, up: p90 - p50 };
  }

  // Certainty-equivalent value, in the SAME units as `vorp` (PPR season points
  // over replacement). `starts` picks the sign: a starter is unhedgeable so his
  // downside room is charged; a bench player is an option so his upside room is
  // credited. No band -> `vorp` unchanged, which is exactly v1.0.
  function riskValue(player, starts) {
    const gaps = bandGaps(player);
    if (!gaps) return player.vorp;
    return starts ? player.vorp - W_RISK * gaps.down
                  : player.vorp + W_RISK * gaps.up;
  }

  // Best player at `pos` expected to survive `gap` picks, assuming the drafters
  // between now and your next pick take the best available by VORP.
  function survivor(available, pos, gap) {
    return (available || []).slice(gap).find(p => p.position === pos) || null;
  }

  // Best VORP at `pos` expected to survive `gap` picks. Floored at 0: no
  // survivor means replacement level, which is VORP 0 by construction.
  function replacement(available, pos, gap) {
    const found = survivor(available, pos, gap);
    return found ? Math.max(0, found.vorp) : 0;
  }

  // The risk-adjusted value of whoever would take this slot if you pass on it.
  // A dedicated slot can only be refilled from its own position; a FLEX slot
  // can be refilled from any flex-eligible position, so its fallback is the
  // best of those survivors -- necessarily >= the single-position one, which is
  // why a flex opening is never more urgent than a dedicated one. The fallback
  // is valued as a STARTER (it would occupy a starting slot) and floored at 0
  // (replacement level), matching `replacement`.
  function fallbackValue(available, pos, gap, slot) {
    const sources = slot === "flex" ? FLEX_POS : [pos];
    let best = 0;
    for (const q of sources) {
      const found = survivor(available, q, gap);
      if (found) best = Math.max(best, riskValue(found, true));
    }
    return best;
  }

  // The raw starting-slot edge before the flex discount: what this player beats
  // his own fallback by. Shared by `vona` and the "why" label so the number the
  // user reads is the number that was scored.
  function slotEdge(player, available, gap, slot) {
    return Math.max(0, riskValue(player, true)
                       - fallbackValue(available, player.position, gap, slot));
  }

  function vona(player, counts, available, gap) {
    const slot = openSlot(player.position, counts);
    if (slot === "none") return BENCH_WEIGHT * riskValue(player, false);
    const edge = slotEdge(player, available, gap, slot);
    return slot === "flex" ? FLEX_WEIGHT * edge : edge;
  }

  // The value you'd "normally" get at this overall pick: the board row at that
  // rank. Board rank encodes ECR order, so this is an ECR-anchored yardstick.
  function parVorp(players, pickNo) {
    const row = players[pickNo - 1];
    return row && Number.isFinite(row.vorp) ? Math.max(0, row.vorp) : 0;
  }

  // Deliberately NOT risk-adjusted. `steal` is trade/price value, a different
  // currency from expected starting points: the market pays for the consensus
  // median, not for your lineup's risk posture. Risk-adjusting it would also
  // let one band move the same score twice.
  function steal(player, players, pickNo) {
    return Math.max(0, player.vorp - parVorp(players, pickNo));
  }

  // Only starters are penalized: a bench stash on a crowded bye costs nothing.
  function byePenalty(player, myPlayers, counts) {
    if (openSlot(player.position, counts) === "none") return 0;
    if (!player.bye) return 0;
    const shared = (myPlayers || []).filter(p => p.bye === player.bye).length;
    return shared + 1 >= BYE_STACK_LIMIT ? BYE_PEN : 0;
  }

  function scorePlayer(player, ctx) {
    return vona(player, ctx.counts, ctx.available, ctx.gap)
      + W_STEAL * steal(player, ctx.players, ctx.pickNo)
      - byePenalty(player, ctx.myPlayers, ctx.counts);
  }

  // One-line "why", from whichever term dominates. p10 is surfaced where p10
  // priced him (a starting slot) and p90 where p90 priced him (the bench).
  function whyLabel(player, ctx) {
    const slot = openSlot(player.position, ctx.counts);
    const v = vona(player, ctx.counts, ctx.available, ctx.gap);
    const s = W_STEAL * steal(player, ctx.players, ctx.pickNo);
    const bye = byePenalty(player, ctx.myPlayers, ctx.counts);
    const gaps = bandGaps(player);
    const parts = [];
    if (s > v && s > 0) {
      parts.push(`steal: ECR ${Math.round(player.ecr)}, here at ${ctx.pickNo}`);
    } else if (slot !== "none") {
      const cliff = slotEdge(player, ctx.available, ctx.gap, slot);
      const where = slot === "flex" ? "flex" : `${player.position}${ctx.counts[player.position] + 1}`;
      // Only call it a cliff when the drop is worth acting on -- a sub-point
      // gap is noise, and reads as a false alarm.
      parts.push(cliff >= CLIFF_MIN
        ? `fills ${where} · cliff −${cliff.toFixed(1)} before your next pick`
        : `fills ${where}`);
      if (gaps) parts.push(`floor ${Math.round(gaps.p10)}`);
    } else if (gaps && BENCH_WEIGHT * W_RISK * gaps.up >= CLIFF_MIN) {
      parts.push(`upside dart · ceiling ${Math.round(gaps.p90)}`);
    } else {
      parts.push("depth · safe to wait");
    }
    if (bye) parts.push(`bye ${player.bye} stacked`);
    return parts.join(" · ");
  }

  function rankShortlist(ctx) {
    return (ctx.available || [])
      .filter(p => POSITIONS.includes(p.position) && Number.isFinite(p.vorp))
      .map(p => ({ player: p, score: scorePlayer(p, ctx), why: whyLabel(p, ctx) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, SHORTLIST_N);
  }

  // Remind about K/DST only in the last rounds, and only while a slot is open.
  function lateSlotTrigger(roundsLeft, haveK, haveDst) {
    if (!Number.isFinite(roundsLeft) || roundsLeft > LATE_ROUNDS) return false;
    return !haveK || !haveDst;
  }

  return { rosterSlots, openSlot, bandGaps, riskValue, survivor, replacement,
           fallbackValue, slotEdge, vona, parVorp, steal, byePenalty,
           scorePlayer, whyLabel, rankShortlist, lateSlotTrigger,
           W_STEAL, BENCH_WEIGHT, BYE_PEN, LATE_ROUNDS, SHORTLIST_N,
           DEDICATED, FLEX_SLOTS, W_RISK, FLEX_WEIGHT, BAND_RULESET };
});
