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
   adding one would double-count it. */
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

  // Best VORP at `pos` expected to survive `gap` picks, assuming the drafters
  // between now and your next pick take the best available by VORP. Floored at
  // 0: no survivor means replacement level, which is VORP 0 by construction.
  function replacement(available, pos, gap) {
    const after = available.slice(gap);
    const survivor = after.find(p => p.position === pos);
    return survivor ? Math.max(0, survivor.vorp) : 0;
  }

  function vona(player, counts, available, gap) {
    const starts = openSlot(player.position, counts) !== "none";
    if (!starts) return BENCH_WEIGHT * player.vorp;
    return Math.max(0, player.vorp - replacement(available, player.position, gap));
  }

  // The value you'd "normally" get at this overall pick: the board row at that
  // rank. Board rank encodes ECR order, so this is an ECR-anchored yardstick.
  function parVorp(players, pickNo) {
    const row = players[pickNo - 1];
    return row && Number.isFinite(row.vorp) ? Math.max(0, row.vorp) : 0;
  }

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

  // One-line "why", from whichever term dominates.
  function whyLabel(player, ctx) {
    const slot = openSlot(player.position, ctx.counts);
    const v = vona(player, ctx.counts, ctx.available, ctx.gap);
    const s = W_STEAL * steal(player, ctx.players, ctx.pickNo);
    const bye = byePenalty(player, ctx.myPlayers, ctx.counts);
    const parts = [];
    if (s > v && s > 0) {
      parts.push(`steal: ECR ${Math.round(player.ecr)}, here at ${ctx.pickNo}`);
    } else if (slot !== "none") {
      const cliff = player.vorp - replacement(ctx.available, player.position, ctx.gap);
      const where = slot === "flex" ? "flex" : `${player.position}${ctx.counts[player.position] + 1}`;
      parts.push(cliff > 0
        ? `fills ${where} · cliff −${cliff.toFixed(1)} before your next pick`
        : `fills ${where}`);
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

  return { rosterSlots, openSlot, replacement, vona, parVorp, steal, byePenalty,
           scorePlayer, whyLabel, rankShortlist, lateSlotTrigger,
           W_STEAL, BENCH_WEIGHT, BYE_PEN, LATE_ROUNDS, SHORTLIST_N,
           DEDICATED, FLEX_SLOTS };
});
