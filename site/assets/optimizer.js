// site/assets/optimizer.js
/* Pick-time draft optimizer — pure math only (no DOM, no network) so the node
   fixture can require it. Spec: docs/superpowers/specs/2026-07-26-draft-optimizer-design.md

   ===========================================================================
   v2 — LOOKAHEAD OBJECTIVE. This replaces v1.1's per-pick marginal score
   (`vona + W_STEAL*steal - byePenalty`). That score was measured against the
   real board and failed three ways at once; all three are gone because the
   objective changed, not because a constant was retuned.

     1. It forecast the field off OUR board. `survivor` dropped the top `gap`
        players by our VORP and called the next one the fallback -- so a player
        our model rated above consensus was assumed to be about to vanish, and
        the score manufactured urgency to grab him. Measured at pick #30 it got
        5 of the next 12 picks wrong, and mispriced the surviving TE by 23.5
        VORP points. Here the field drafts the MARKET (`fieldTakes`, by ADP),
        which is what the field actually does.

     2. It compared FLEX candidates on position-relative VORP. Replacement
        level differs by position (TE 110, WR 122 PPR points on the 2026
        board), so a TE beat a WR who outscored him:
            Tucker Kraft  TE  vorp 26.3  ->  136.5 projected points
            Rome Odunze   WR  vorp 16.4  ->  138.7 projected points
        In a flex slot you start whoever SCORES more, so this scores whole
        lineups in absolute points and VORP never enters the comparison.

     3. Its `steal` term carried no market information. `parVorp` reads a board
        that `board_rank.rank_board` sorts by VORP descending (its old comment
        claiming ECR order was simply wrong), so `steal` reduced to "more VORP
        than the Nth-best VORP" -- VORP re-added under another name. It paid a
        bonus for REACHING: Loveland, ADP 41, drew +5.34 at pick 30. Market
        mispricing is now an INDICATOR (`adpDelta`), never a score term.

   The objective
   -------------
   score(X) = the projected points of the best STARTING LINEUP you can still
   finish, if you take X now and then draft greedily to the end.

   Everything the old score needed a separate rule for now falls out of it:
     - roster completion: an unfilled QB slot contributes 0, so a roster with
       no quarterback scores strictly lower. v1.1 took 0 QBs in 96 simulated
       picks because a flat position never produced a "cliff"; it cannot
       happen here without the lineup total paying for it.
     - positional saturation: a 2nd TE only counts if he beats an RB/WR for a
       FLEX slot, on absolute points. A 3rd counts for nothing at all.
     - timing: taking X now vs. later is priced by simulating the rest of the
       draft, not by a one-round `gap` heuristic.
     - bye stacking: `lineupPoints` is summed WEEK BY WEEK, so three starters
       sharing a bye lose real points in that week and gain them back only to
       the extent the bench covers. No flat BYE_PEN constant.

   Deliberately NOT in the score
   -----------------------------
   Bands (p10/p90) and ADP mispricing are surfaced to the user as indicators
   instead of being folded in. v1.1 charged W_RISK * band width inside the
   score; measured, that charge ran 28-71% of a player's VORP, which is not
   the "discriminator, never a driver" its comment claimed. A number the user
   is asked to trust on the clock should be one quantity -- projected lineup
   points -- with the risk and market context shown beside it, not blended in
   at an un-tuned weight. */
(function (root, factory) {
  const O = factory();
  if (typeof window !== "undefined") window.Optimizer = O;
  if (typeof module !== "undefined" && module.exports) module.exports = O;
})(this, function () {
  // --- league contract -------------------------------------------------------
  const DEDICATED = { QB: 1, RB: 2, WR: 2, TE: 1 };
  const FLEX_SLOTS = 2;
  const FLEX_POS = ["RB", "WR", "TE"];
  const POSITIONS = ["QB", "RB", "WR", "TE"];
  const SHORTLIST_N = 5;
  const SHORTLIST_PER_POS = 2;   // display spread; see shortlistSpread
  const WEEKS = 18;              // NFL regular season, 2026
  // Picks of margin beyond the mandatory slots still unfilled. This was a flat
  // LATE_ROUNDS = 2, which put the warning on screen with exactly two picks
  // left for two mandatory starting slots -- no slack at all. Since the
  // shortlist can never contain a kicker or a defense (this board does not
  // project them), following the shortlist spent those two picks on skill
  // players and left both slots empty: measured on two mock drafts, 15 skill
  // players and no K or D/ST either time. The window now scales with what is
  // actually still missing, so one slot warns later than two.
  const LATE_SLACK = 2;

  // Slot weights. The lookahead does NOT use these -- it scores whole lineups,
  // so a bench player is priced by what he actually contributes. They remain
  // because keepers.js discounts a keeper by the slot he would occupy, a
  // separate decision made before any draft exists to simulate.
  const FLEX_WEIGHT = 0.5;
  const BENCH_WEIGHT = 0.2;

  // --- search bounds: cost control, not model choices ------------------------
  // Candidates are drawn PER POSITION, never as a flat top-N by points. A flat
  // cut is not position-neutral: replacement level differs by position (QB 190
  // PPR points vs TE 110 on the 2026 board), so raw season points rank almost
  // every startable QB above almost every TE. A flat top-40 at pick 19 came
  // back as five interchangeable quarterbacks, having never looked at a wide
  // receiver. Taking the best few at each position instead guarantees the
  // lookahead compares like with like and lets the LINEUP decide, which is the
  // whole point of scoring lineups. Both bounds are wide enough that doubling
  // them does not change the shortlist on the live board.
  const CANDIDATE_PER_POS = 10;  // scored at the live pick (<= 40 candidates)
  const ROLLOUT_PER_POS = 6;     // considered at each simulated pick
  const ROLLOUT_PICKS = 8;       // your own future picks simulated (= starters)

  // Season-point resolution below which two candidates are the SAME PICK.
  //
  // This was 0.05, chosen to keep float noise from ordering the shortlist. It
  // was about 150x too fine, and on 2026-08-31 it cost a real draft its first
  // pick: the rollout scored QB Joe Burrow 1311.1 and WR CeeDee Lamb 1310.3 --
  // 0.82 points apart on an 18-week, ~1308-point objective -- so the score
  // comparison resolved outright and the scarcity tiebreak below it never ran.
  // Lamb was worth 51 more VORP and would not have survived to the seat's next
  // pick; Burrow would have. The seat took a quarterback tenth overall in a
  // one-QB league. Ten of that draft's thirteen picks were decided by a gap
  // under two points.
  //
  // The objective cannot support anything like that resolution. Measured on
  // the same draft: of 780 same-position candidate pairs, 13.3% INVERT -- the
  // rollout scores a strictly worse player at the same position higher, which
  // with the lineup structure held fixed can only be instability in
  // finishRoster's greedy fill. p90 inversion magnitude 7.41 points, max
  // 10.15.
  //
  // 4.3247 is the transformer's pooled walk-forward PPR MAE over the 17,908
  // held-out player-weeks in models/backtests/bakeoff.json. It is the
  // smallest band anchored in something measured: the optimizer refuses to
  // split two rosters by less than the error its own projections are known to
  // carry. It is deliberately NOT scaled to a season -- multiplying by 18
  // would assume errors accumulate, dividing by sqrt(18) would assume they are
  // independent, and this repo has no covariance estimate to justify either.
  // The 7.41 inversion figure says the true resolution is coarser still, so
  // this is a floor rather than a ceiling.
  const TIE_POINTS = 4.3247;

  // Two scores are the same pick when they sit within `width` of each other.
  //
  // The band is RELATIVE, measured from the best candidate, because the old
  // absolute grid did not actually do what its name promised:
  // Math.round(points / 0.05) puts 100.02 in cell 2000 and 100.04 in cell
  // 2001, so two scores a fiftieth of a point apart resolve outright whenever
  // a cell boundary falls between them. Widening the grid does not fix that --
  // it only moves the boundaries. Anchoring to the best score does.
  function sameBand(a, b, width) {
    return Math.abs(a - b) < width;
  }

  // How many of a position can still be useful. Reached only in the late
  // rounds, where every remaining player leaves the projected lineup unchanged
  // and the objective is honestly indifferent -- this decides nothing that the
  // projection could have decided. You start one QB and one TE, so a second is
  // bye and injury cover and a third is a wasted pick; RB and WR fill the two
  // flex slots as well, so depth there keeps its value much longer.
  // This ONLY breaks ties. A player over the cap still wins outright whenever
  // he genuinely improves the lineup.
  const DEPTH_CAP = { QB: 2, RB: 6, WR: 6, TE: 2 };

  // Best `perPos` at each position, merged and left in value order.
  function topCandidates(ranked, perPos) {
    const seen = { QB: 0, RB: 0, WR: 0, TE: 0 }, out = [];
    for (const p of ranked) {
      if (seen[p.position] === undefined || seen[p.position] >= perPos) continue;
      seen[p.position]++;
      out.push(p);
    }
    return out;
  }

  // The scoring lens the board's value curve is built from. Must match
  // site.weekly.BOARD_RULESET: this project's league scores passing TDs at 6,
  // not 4, which moves the top 24 QBs by ~+48 points a season and reorders 4-8
  // of the top twelve. Reconstructing the curve from the wrong lens would rank
  // quarterbacks wrongly on any board published before `value_points` existed.
  // Ordered preference, not a single name. A board that carries the league
  // lens was built on it; a board that predates it was built on ppr, so ppr is
  // the CORRECT curve for that board rather than a degraded guess. Picking the
  // lens the board actually used keeps the reconstruction self-consistent
  // either way -- what would be wrong is reading a lens the curve was not
  // built from, which for QBs is a reordering, not a rescale.
  const VALUE_LENS_ORDER = ["league", "ppr"];
  function valueLens(players) {
    for (const lens of VALUE_LENS_ORDER) {
      if (players.some(p => p.season_points && p.season_points[lens])) return lens;
    }
    return VALUE_LENS_ORDER[VALUE_LENS_ORDER.length - 1];
  }

  // Absolute season points on the board's ECR-ordered value curve -- the SAME
  // curve `vorp` is measured from, before the position's replacement level is
  // subtracted off. Published as `value_points`; the fallback reconstructs it
  // exactly the way board_rank.order_and_value builds it (the position's
  // `ppr_p50` values sorted descending, laid onto ECR order) so a board
  // generated before this field existed still scores correctly.
  function seasonValue(player) {
    return Number.isFinite(player && player.value_points) ? player.value_points : NaN;
  }

  // Fill in `value_points` for a whole board when the payload predates it.
  // Mutates nothing: returns a new array of shallow copies.
  function withValuePoints(players) {
    if ((players || []).every(p => Number.isFinite(p.value_points))) return players;
    const curves = {};
    const lens = valueLens(players);
    for (const pos of POSITIONS) {
      curves[pos] = players
        .filter(p => p.position === pos && p.season_points && p.season_points[lens])
        .map(p => p.season_points[lens].p50)
        .filter(Number.isFinite)
        .sort((a, b) => b - a);
    }
    return players.map(p => {
      if (Number.isFinite(p.value_points)) return p;
      const curve = curves[p.position];
      const v = curve && Number.isFinite(p.position_rank) ? curve[p.position_rank - 1] : undefined;
      return Object.assign({}, p, { value_points: Number.isFinite(v) ? v : NaN });
    });
  }

  // Points a player contributes in each week he is active. His season value is
  // earned over the weeks he actually plays, so dividing by that count and
  // summing back over those weeks returns exactly his season value -- the
  // weekly view adds bye resolution without inventing or destroying points.
  function perWeek(player) {
    const v = seasonValue(player);
    if (!Number.isFinite(v)) return 0;
    return v / (player.bye ? WEEKS - 1 : WEEKS);
  }

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

  // The best starting lineup available from `roster`, valued by `value`.
  // Greedy is exact here: a dedicated slot can only be filled from its own
  // position, so taking the best at each position is optimal, and the flex
  // slots then take the best of what is left over.
  function bestLineup(roster, value) {
    const byPos = { QB: [], RB: [], WR: [], TE: [] };
    for (const p of roster || []) {
      if (byPos[p.position]) byPos[p.position].push(p);
    }
    const starters = [], leftovers = [];
    for (const pos of POSITIONS) {
      byPos[pos].sort((a, b) => value(b) - value(a));
      starters.push(...byPos[pos].slice(0, DEDICATED[pos]));
      if (FLEX_POS.includes(pos)) leftovers.push(...byPos[pos].slice(DEDICATED[pos]));
    }
    leftovers.sort((a, b) => value(b) - value(a));
    starters.push(...leftovers.slice(0, FLEX_SLOTS));
    return starters;
  }

  // Season points of the best startable lineup, ignoring byes. The rollout's
  // inner loop uses this because it runs thousands of times; the reported
  // score uses `lineupPoints` below, which resolves byes.
  function lineupTotal(roster) {
    let total = 0;
    for (const p of bestLineup(roster, seasonValue)) {
      const v = seasonValue(p);
      if (Number.isFinite(v)) total += v;
    }
    return total;
  }

  // THE OBJECTIVE. Best lineup re-picked every week, so a week that three of
  // your starters sit out is scored with whoever is actually left to play.
  // With no bye collisions this equals `lineupTotal`; each collision costs the
  // difference between the starter and his best available cover, which is
  // exactly what a stacked bye costs you -- and it is also what gives a bench
  // player a non-zero value, since covering a starter's bye is real points.
  //
  // Written out rather than calling `bestLineup` 18 times: this is the hot
  // path (the rollout evaluates it thousands of times per pick), and sorting
  // each position ONCE up front instead of once per week is the difference
  // between a responsive panel and a stalled one. The result is identical --
  // dropping players on bye preserves the sorted order of the rest.
  function lineupPoints(roster) {
    const byPos = { QB: [], RB: [], WR: [], TE: [] };
    for (const p of roster || []) {
      if (byPos[p.position]) byPos[p.position].push(p);
    }
    const w = new Map();
    for (const pos of POSITIONS) {
      for (const p of byPos[pos]) w.set(p, perWeek(p));
      byPos[pos].sort((a, b) => w.get(b) - w.get(a));
    }
    let total = 0;
    for (let week = 1; week <= WEEKS; week++) {
      const leftovers = [];
      for (const pos of POSITIONS) {
        let filled = 0;
        for (const p of byPos[pos]) {
          if (p.bye === week) continue;
          if (filled < DEDICATED[pos]) { total += w.get(p); filled++; }
          else if (FLEX_POS.includes(pos)) leftovers.push(p);
        }
      }
      leftovers.sort((a, b) => w.get(b) - w.get(a));
      for (const p of leftovers.slice(0, FLEX_SLOTS)) total += w.get(p);
    }
    return total;
  }

  // Who the field takes over the next `n` picks. The market drafts the market:
  // ADP order, not our board. Players with no ADP are not drafted here -- they
  // are the undrafted depth tail, and treating them as safe is correct.
  /* SELECTIONS between two pick numbers -- not the distance between them.
     In a keeper league those differ: this league pre-consumes 22 pick slots,
     so between pick 130 and pick 154 the raw distance is 23 but only 14
     drafters actually choose. Everything downstream that asks "who is gone by
     my next turn" was using the distance, and so believed 9 extra players
     came off the board in that one gap alone -- 22 phantom selections across
     the draft. That made the pool look scarcer than it is, which pulls picks
     earlier than they need to be.

     `used` is the set of pick NUMBERS already consumed (keepers, and picks
     already made). Without it this is the old arithmetic exactly, so a draft
     with no keepers is unaffected. */
  function openPicksBetween(fromPick, toPick, used) {
    if (!used || !used.size) return toPick - fromPick - 1;
    let k = 0;
    for (let p = fromPick + 1; p < toPick; p++) if (!used.has(p)) k++;
    return k;
  }

  function fieldTakes(pool, n) {
    if (n <= 0) return [];
    return (pool || []).filter(p => Number.isFinite(p.adp))
      .sort((a, b) => a.adp - b.adp).slice(0, n);
  }

  // Play the rest of your draft out: at each of your remaining picks, take
  // whoever most improves your startable lineup, with the field taking the
  // market's best available in between.
  function finishRoster(roster, pool, futurePicks, fromPick, used) {
    let current = (roster || []).slice();
    let available = (pool || []).slice()
      .sort((a, b) => (seasonValue(b) || 0) - (seasonValue(a) || 0));
    let prev = fromPick;
    for (const pick of (futurePicks || []).slice(0, ROLLOUT_PICKS)) {
      const gone = new Set(
        fieldTakes(available, openPicksBetween(prev, pick, used)).map(p => p.player_id));
      available = available.filter(p => !gone.has(p.player_id));
      // Gain is measured with THE OBJECTIVE, not a cheaper proxy. Scoring the
      // rollout on bye-blind season totals made every pick past a full lineup
      // worth exactly 0, and the resulting tie fell to the highest raw season
      // points -- which is always a quarterback, because QB replacement level
      // is the highest of any position. Rollouts were ending in four backup
      // QBs, and since that junk is what covers your starters' byes, it was
      // the junk that decided the shortlist. Bye coverage is precisely what
      // makes a bench player worth more than nothing, so measuring it here
      // both removes the tie and prices depth for the right reason.
      const base = lineupPoints(current);
      let best = null, bestGain = -Infinity;
      for (const cand of topCandidates(available, ROLLOUT_PER_POS)) {
        const gain = lineupPoints(current.concat([cand])) - base;
        if (gain > bestGain) { bestGain = gain; best = cand; }
      }
      // Once nothing on the board improves the projected lineup -- every slot
      // filled and every bye already covered -- the rest of your picks are
      // pure bench and cannot change the objective. Stop rather than draft
      // them: continuing would re-open the gain tie that stockpiled backup
      // QBs, and a rollout that ends in a plausible roster is one the user
      // can actually check against their own judgement.
      if (!best || bestGain <= 0) break;
      current.push(best);
      available = available.filter(p => p !== best);
      prev = pick;
    }
    return current;
  }

  // The starting slots you have not filled yet, named the way `lineupRole`
  // names them so the panel's two halves agree ("fills WR2" beside "still
  // need: WR2"). Counts alone do not answer this: QB 1 · RB 2 · WR 1 · TE 0
  // leaves a reader to work out that WR2, TE and both flex spots are open,
  // and on the clock that is the one arithmetic nobody should be doing.
  //
  // Surplus at a flex-eligible position fills flex, so a fourth running back
  // closes a FLEX slot rather than adding an unfillable RB one -- the same
  // rule `bestLineup` uses, kept in step by construction.
  function openSlots(myPlayers) {
    const counts = rosterSlots(myPlayers);
    const open = [];
    for (const pos of POSITIONS) {
      for (let i = counts[pos]; i < DEDICATED[pos]; i++) {
        open.push(DEDICATED[pos] > 1 ? `${pos}${i + 1}` : pos);
      }
    }
    const surplus = FLEX_POS.reduce(
      (n, q) => n + Math.max(0, counts[q] - DEDICATED[q]), 0);
    for (let i = Math.min(surplus, FLEX_SLOTS); i < FLEX_SLOTS; i++) open.push("FLEX");
    return open;
  }

  // Where a player lands in the lineup you would finish with -- the honest
  // answer to "what am I actually drafting him to do".
  function lineupRole(player, finished) {
    const starters = bestLineup(finished, seasonValue);
    if (!starters.includes(player)) return "bench";
    const samePos = starters.filter(p => p.position === player.position)
      .sort((a, b) => seasonValue(b) - seasonValue(a));
    const idx = samePos.indexOf(player);
    if (idx < DEDICATED[player.position]) {
      return DEDICATED[player.position] > 1 ? `${player.position}${idx + 1}` : player.position;
    }
    return "FLEX";
  }

  // Market mispricing, in picks. Positive = he has fallen past his ADP and is
  // a bargain here; negative = taking him now is a reach. An INDICATOR, never
  // part of the score.
  function adpDelta(player, pickNo) {
    return Number.isFinite(player && player.adp) ? pickNo - player.adp : null;
  }

  // Players you ALREADY OWN who sit out the same week as `player`. Surfaced,
  // not charged -- `lineupPoints` has already paid for the collision.
  // Deliberately counted against your real roster rather than the simulated
  // finish: a warning you cannot check against your own team is noise, and at
  // pick 6 the rollout's hypothetical roster produced "bye 11 with 1" about a
  // player the user had not drafted and never would.
  function byeClash(player, myPlayers) {
    if (!player.bye) return 0;
    return (myPlayers || []).filter(p => p !== player && p.bye === player.bye).length;
  }

  // Who the market leaves at this position by your NEXT pick. This is the
  // "should I wait?" answer in the form the question is actually asked: not a
  // cliff score, but the name of the player you would settle for. Returns null
  // when you have no pick left, or when the position is picked clean.
  function nextAtPosition(player, pool, futurePicks, pickNo, used) {
    const next = (futurePicks || [])[0];
    if (!Number.isFinite(next)) return null;
    const rest = (pool || []).filter(p => p !== player);
    const gone = new Set(fieldTakes(rest, openPicksBetween(pickNo, next, used))
      .map(p => p.player_id));
    return rest.filter(p => !gone.has(p.player_id) && p.position === player.position)
      .sort((a, b) => seasonValue(b) - seasonValue(a))[0] || null;
  }

  /* Will he still be there at your NEXT pick, if the field drafts the market?
     Uses fieldTakes -- the same model finishRoster's rollout uses -- so the
     shortlist and the rollout cannot disagree about who survives. The player
     stays IN the pool being tested, which is the whole point: we are asking
     whether the field takes HIM. With no next pick there is nothing to wait
     for, so everyone counts as surviving and the tiebreak below goes quiet. */
  function survivesToNextPick(player, pool, futurePicks, pickNo, used) {
    const next = (futurePicks || [])[0];
    if (!Number.isFinite(next)) return true;
    const gone = fieldTakes(pool || [], openPicksBetween(pickNo, next, used));
    return !gone.some(p => p.player_id === player.player_id);
  }

  /* Rank the live board.

     ctx = { available, myPlayers, pickNo, futurePicks }
       available   - board rows still undrafted (any order)
       myPlayers   - board rows you already own
       pickNo      - the overall pick on the clock (yours)
       futurePicks - overall pick numbers of your remaining turns, ascending

     Returns up to SHORTLIST_N entries, best first:
       { player, points, cost, role, nextBest, waitCost, adpDelta, byeClash,
         roster }
     `points` is the projected lineup total if you take him. `cost` is what
     taking him gives up against the best option (0 for the top pick) -- the
     one number the decision turns on. `nextBest` is who is left at his
     position at your next pick and `waitCost` is what settling for that player
     would cost your finished lineup, so "take him now or wait" is answerable
     on its face. `cost` and `waitCost` are the same kind of number, measured
     the same way, and are directly comparable: a player worth 3 less than the
     top pick but 20 more than his own replacement is a different decision from
     one worth 3 less and 1 more. */
  // At most `perPos` of a position in the displayed shortlist.
  //
  // A DISPLAY rule only: the objective, the ranking and every number are
  // untouched, and entry 1 is still exactly what the objective picked. What it
  // fixes is that the top five came back as five quarterbacks. Under this
  // league's 6-point passing TDs the top QBs project 240-249 against 183 for
  // the best receiver, so when QB is the right call the whole list is QBs --
  // and four of them are not alternatives to the first. They are the same
  // decision with a worse player, crowding out the comparison actually being
  // made: take the quarterback, or take the best receiver and give up this
  // much. (Measured in this league's own drafts, quarterbacks last 19 picks
  // past their market position while tight ends go 11 early, so "QB is the
  // call" is frequently correct here and this list is frequently all QBs.)
  //
  // Two, not one: the second-best at a position is a genuine fallback if the
  // first goes while you wait -- which is what `wait →` prices. A third is not
  // a distinct decision. Backfills past the cap when a position has genuinely
  // run out, so a board down to its last few names still fills the list.
  function shortlistSpread(scored, n, perPos) {
    const shown = {}, out = [], spare = [];
    for (const e of scored) {
      const pos = e.player.position;
      if ((shown[pos] || 0) < perPos) { shown[pos] = (shown[pos] || 0) + 1; out.push(e); }
      else spare.push(e);
      if (out.length === n) return out;
    }
    return out.concat(spare.slice(0, Math.max(0, n - out.length)));
  }

  function recommend(ctx) {
    const pool = (ctx.available || []).filter(
      p => POSITIONS.includes(p.position) && Number.isFinite(seasonValue(p)));
    const mine = ctx.myPlayers || [];
    const future = ctx.futurePicks || [];
    // Pick numbers already spent (keepers, picks made). Optional: without it
    // every helper below falls back to raw pick distance, which is correct
    // for a draft with no keepers and wrong for one with them.
    const used = ctx.usedPicks || null;
    const ranked = pool.slice().sort((a, b) => seasonValue(b) - seasonValue(a));
    const scored = topCandidates(ranked, CANDIDATE_PER_POS).map(player => {
      const rest = ranked.filter(p => p !== player);
      const finished = finishRoster(mine.concat([player]), rest, future, ctx.pickNo, used);
      return { player, points: lineupPoints(finished), roster: finished };
    });
    // Ties are real and they are common late: once your lineup is full and the
    // byes are covered, no available player changes the projection at all, so
    // every candidate scores identically. What breaks the tie then decides the
    // pick outright, and raw season points is the wrong answer -- it is not
    // position-neutral (QB replacement level is the highest of any position),
    // so it recommended backup quarterbacks for rounds 12-15. VORP is neutral
    // by construction: points over what you could otherwise get AT THAT
    // POSITION. It is the wrong yardstick for a lineup comparison, which is
    // why the score does not use it, and the right one for "the objective is
    // indifferent, so just take the best player left".
    // Points are compared on a TIE_POINTS grid so the ordering stays a valid
    // total order rather than an epsilon comparator that can sort unstably.
    const held = rosterSlots(mine);
    // Band 0 is every candidate within TIE_POINTS of the best score -- the set
    // the objective cannot honestly tell apart. Inside it the tiebreaks below
    // decide; outside it the objective still wins outright.
    const bestPoints = scored.reduce((m, e) => Math.max(m, e.points), -Infinity);
    const grade = e => -Math.floor((bestPoints - e.points) / TIE_POINTS);
    const over = e => (held[e.player.position] >= DEPTH_CAP[e.player.position] ? 1 : 0);
    // SCARCITY BREAKS TIES BEFORE VALUE DOES. When the objective is indifferent
    // -- which is most of the late rounds -- the old order fell straight to
    // VORP and ignored whether a man would still be there next time. On a real
    // board that recommended Juwan Johnson (ADP 187) at pick 130 over Hunter
    // Henry (ADP 139) when both projected identically and the wait cost was 0.0
    // for each: it spent the pick on the one player in the pair the field was
    // never going to take. Among equals, take the one you cannot get later;
    // VORP still decides within each group, so position-neutrality is intact.
    const survives = new Map(scored.map(e =>
      [e.player, survivesToNextPick(e.player, pool, future, ctx.pickNo, used) ? 1 : 0]));
    const safe = e => survives.get(e.player);
    scored.sort((a, b) => (grade(b) - grade(a))
                       || (over(a) - over(b))
                       || (safe(a) - safe(b))
                       || ((b.player.vorp || 0) - (a.player.vorp || 0)));
    // `top` comes from the full ranking, BEFORE the display spread, so `cost`
    // stays measured against the genuinely best pick even when the spread has
    // dropped the runner-up off the list.
    //
    // It must be the best RAW score, not scored[0]. Once the band above let a
    // lower-scoring scarcity winner take the top slot, reading scored[0] after
    // the sort charged every higher-scoring entry below it a NEGATIVE cost --
    // the panel telling you that ignoring its own recommendation gains points.
    const top = scored.length ? bestPoints : 0;
    return shortlistSpread(scored, SHORTLIST_N, SHORTLIST_PER_POS).map(entry => {
      const nextBest = nextAtPosition(entry.player, ranked, future, ctx.pickNo, used);
      // What waiting costs, measured THE SAME WAY as `cost`: finish the draft
      // with his positional survivor in his place and compare projected
      // lineups. The obvious shortcut -- subtracting the two players' season
      // values -- is a different question and gives a different answer,
      // because it ignores whether either man would actually start. On the
      // live board it produced a panel that charged 9.5 points for taking
      // Michael Pittman while telling you waiting for Godwin cost nothing:
      // two numbers side by side computed on different bases. Every number in
      // the shortlist now goes through the lineup objective.
      const alt = nextBest
        ? finishRoster(mine.concat([nextBest]), ranked.filter(p => p !== nextBest),
                       future, ctx.pickNo, used)
        : null;
      return {
        player: entry.player,
        points: entry.points,
        // Zero inside the band, because that is the honest number: the
        // objective cannot tell these apart, and printing "costs you 0.8" for
        // a difference the model has no power to resolve is false precision
        // presented to someone on the clock.
        cost: sameBand(top, entry.points, TIE_POINTS)
          ? 0 : Math.max(0, top - entry.points),
        role: lineupRole(entry.player, entry.roster),
        nextBest,
        waitCost: alt ? entry.points - lineupPoints(alt) : null,
        adpDelta: adpDelta(entry.player, ctx.pickNo),
        survivesToNext: survivesToNextPick(entry.player, pool, future, ctx.pickNo, used),
        byeClash: byeClash(entry.player, mine),
        roster: entry.roster,
      };
    });
  }

  // The value you'd "normally" get at this overall pick: the board row at that
  // rank. `board_rank.rank_board` sorts the board by VORP descending, so this
  // is a VORP-anchored yardstick -- read it as "the Nth-best player left by our
  // own valuation", not as a market price. Kept for keepers.js, which spends a
  // draft pick and needs to know what that pick would otherwise have bought.
  function parVorp(players, pickNo) {
    const row = players[pickNo - 1];
    return row && Number.isFinite(row.vorp) ? Math.max(0, row.vorp) : 0;
  }

  // Remind about K/DST while a mandatory slot is open and the picks to fill it
  // are running out. The window scales with the number of slots still missing:
  // two empty slots need two picks, so the warning has to arrive with more
  // room than one empty slot does.
  function lateSlotTrigger(roundsLeft, haveK, haveDst) {
    if (!Number.isFinite(roundsLeft)) return false;
    const needed = (haveK ? 0 : 1) + (haveDst ? 0 : 1);
    if (needed === 0) return false;
    return roundsLeft <= needed + LATE_SLACK;
  }

  return { seasonValue, withValuePoints, perWeek, rosterSlots, openSlot,
           bestLineup, lineupTotal, lineupPoints, fieldTakes, finishRoster,
           openSlots, lineupRole, adpDelta, byeClash, nextAtPosition, recommend,
           survivesToNextPick, openPicksBetween, sameBand,
           parVorp, shortlistSpread, SHORTLIST_PER_POS,
           valueLens, VALUE_LENS_ORDER,
           lateSlotTrigger,
           DEDICATED, FLEX_SLOTS, FLEX_POS, POSITIONS, SHORTLIST_N, WEEKS,
           LATE_SLACK, CANDIDATE_PER_POS, ROLLOUT_PER_POS, ROLLOUT_PICKS, TIE_POINTS, DEPTH_CAP, topCandidates,
           FLEX_WEIGHT, BENCH_WEIGHT };
});
