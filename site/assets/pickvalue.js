/* Draft-pick values for the in-season trade comparison (spec 2026-11-13-trade-draft-picks §5.1–5.4).
   Pure, no DOM: which picks exist and who owns them (Sleeper traded_picks), where a pick falls in next season's
   draft, what a draft slot is worth in the league's own scoring (from the pick_curve artifact: realized stat
   totals of the players the market ranked at each spot, 2021–2025), and the weighted this-season + next-season
   sum. Points always come from stat lines scored with the league's weights (LeagueLens.score).
   Tests: tests/pickvalue_fixture.cjs. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PickValue = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";
  const LeagueLens = (typeof module !== "undefined" && module.exports) ? require("./leaguelens.js") : root.LeagueLens;

  const PRESETS = Object.freeze({
    win_now: Object.freeze({ label: "Win now", w: 0.5 }),
    balanced: Object.freeze({ label: "Balanced", w: 0.8 }),
    rebuild: Object.freeze({ label: "Rebuild", w: 1.2 }),
  });
  const DEFAULT_PRESET = "balanced";
  const REASONS = Object.freeze({
    dynasty: "Rookie-draft picks in dynasty leagues aren't valued: the pick values come from full drafts.",
    two_qb: "Draft picks aren't valued in leagues that start two quarterbacks: the pick values come from one-quarterback drafts.",
  });
  const KEEPER_RULES = Object.freeze(["unknown", "ladder"]);
  const POSITIONS = Object.freeze(["QB", "RB", "WR", "TE"]);
  const FLEX_POS = Object.freeze(["RB", "WR", "TE"]);
  const FLEX_ELIGIBLE = Object.freeze({ FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"] });
  // Every nonempty subset of the flex positions: Hall's condition over position groups (players of one position
  // share their eligible slots, so these are the only subsets that can bind).
  const FLEX_SUBSETS = Object.freeze([1, 2, 3, 4, 5, 6, 7].map(m => FLEX_POS.filter((_, i) => m & (1 << i))));
  // Keeper ladder (owner-confirmed 2026-11-13): no keeper can cost round 1 or 2; a waiver pickup costs round 12.
  const LADDER_FIRST_ROUND = 3, LADDER_LAST_ROUND = 12;

  const num = v => (typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN));
  const isPosInt = v => Number.isInteger(v) && v > 0;
  const isFiniteNum = v => typeof v === "number" && Number.isFinite(v);
  const slotName = s => String(s).toUpperCase();
  const oneQb = slots => !slots.includes("SUPER_FLEX") && slots.filter(s => s === "QB").length <= 1;

  // ---- which leagues get picks ------------------------------------------------------------------------------
  function eligibility(league) {
    const silent = { ok: false, reason: null };
    if (!league || league.status !== "in_season") return silent;
    const type = league.settings && league.settings.type;
    if (type === 2) return { ok: false, reason: REASONS.dynasty };
    if (type !== 1) return silent;
    if (!oneQb((league.roster_positions || []).map(slotName))) return { ok: false, reason: REASONS.two_qb };
    return { ok: true, reason: null };
  }

  function draftRounds({ draft, tradedPicks } = {}) {
    const r = num(draft && draft.settings && draft.settings.rounds);
    if (isPosInt(r)) return r;
    const seen = (tradedPicks || []).map(p => num(p && p.round)).filter(isPosInt);
    return seen.length ? Math.max(...seen) : null;
  }

  function pickSeasons({ league, tradedPicks } = {}) {
    const current = num(league && league.season);
    if (!Number.isInteger(current)) throw new Error("League season is missing.");
    const out = new Set([current + 1]);
    for (const p of tradedPicks || []) {
      const s = num(p && p.season);
      if (Number.isInteger(s) && s > current + 1) out.add(s);
    }
    return [...out].sort((a, b) => a - b);
  }

  // ---- who owns which pick ----------------------------------------------------------------------------------
  // Sleeper keeps one traded_picks row per pick (roster_id = original owner, owner_id = current owner). Should a
  // payload carry several rows for one pick, follow previous_owner_id -> owner_id from the original owner; if the
  // rows do not chain, the last row stands.
  function currentOwner(original, rows) {
    if (rows.length === 1) return num(rows[0].owner_id);
    let owner = original;
    const used = new Set();
    for (;;) {
      const i = rows.findIndex((r, j) => !used.has(j) && num(r.previous_owner_id) === owner);
      if (i < 0) break;
      used.add(i);
      owner = num(rows[i].owner_id);
    }
    return used.size === rows.length ? owner : num(rows[rows.length - 1].owner_id);
  }

  function ownedPicks({ rosters, tradedPicks, seasons, rounds }) {
    if (!isPosInt(rounds)) throw new Error("Draft rounds are unknown.");
    const ids = (rosters || []).map(r => num(r && r.roster_id));
    if (ids.some(id => !Number.isInteger(id))) throw new Error("A roster has no roster id.");
    const years = (seasons || []).map(num);
    if (years.some(s => !Number.isInteger(s))) throw new Error("Invalid pick season.");
    const key = (s, r, o) => `${s}|${r}|${o}`;
    const rowsByPick = new Map();
    for (const p of tradedPicks || []) {
      if (!p) continue;
      const k = key(num(p.season), num(p.round), num(p.roster_id));
      if (!rowsByPick.has(k)) rowsByPick.set(k, []);
      rowsByPick.get(k).push(p);
    }
    const out = new Map(ids.map(id => [id, []]));
    for (const season of years) for (let round = 1; round <= rounds; round++) for (const orig of ids) {
      const rows = rowsByPick.get(key(season, round, orig));
      const owner = rows ? currentOwner(orig, rows) : orig;
      if (!Number.isInteger(owner)) continue;        // an unreadable owner: shown under nobody rather than the wrong team
      if (!out.has(owner)) out.set(owner, []);
      out.get(owner).push({ season, round, originalRosterId: orig });
    }
    for (const list of out.values()) {
      list.sort((a, b) => a.season - b.season || a.round - b.round || a.originalRosterId - b.originalRosterId);
    }
    return out;
  }

  // ---- where a pick falls -----------------------------------------------------------------------------------
  function standingsOrder(rosters) {
    const s = r => (r && r.settings) || {};
    const wins = r => num(s(r).wins) || 0;
    const pointsFor = r => (num(s(r).fpts) || 0) + (num(s(r).fpts_decimal) || 0) / 100;
    return (rosters || []).map(r => ({ id: num(r.roster_id), w: wins(r), p: pointsFor(r) }))
      .sort((a, b) => a.w - b.w || a.p - b.p || a.id - b.id)
      .map(x => x.id);
  }

  function roundSlots({ round, teams }) {
    if (!isPosInt(round) || !isPosInt(teams)) throw new Error("Invalid round or team count.");
    return { first: (round - 1) * teams + 1, last: round * teams };
  }

  // Snake drafts reverse even rounds; a reversal round (Sleeper's "third-round reversal") flips every round from
  // it on once more. Linear drafts keep round 1's order throughout.
  function reversedRound(round, snake, reversalRound) {
    if (!snake) return false;
    const even = round % 2 === 0;
    return reversalRound > 0 && round >= reversalRound ? !even : even;
  }

  function slotInRound({ originalRosterId, round, order, teams, snake, reversalRound }) {
    const { first } = roundSlots({ round, teams });
    const i = (order || []).map(num).indexOf(num(originalRosterId));
    if (i < 0 || i >= teams) throw new Error(`Roster ${originalRosterId} is not in the draft order.`);
    return first + (reversedRound(round, Boolean(snake), num(reversalRound) || 0) ? teams - 1 - i : i);
  }

  // ---- what a slot is worth ---------------------------------------------------------------------------------
  function slotCounts(slots) {
    const dedicated = { QB: 0, RB: 0, WR: 0, TE: 0 }, flex = { FLEX: 0, WRRB_FLEX: 0, REC_FLEX: 0 };
    for (const s of slots || []) {
      const k = slotName(s);
      if (Object.hasOwn(dedicated, k)) dedicated[k]++;
      else if (Object.hasOwn(flex, k)) flex[k]++;
    }
    return { dedicated, flex };
  }

  // Port of board_rank.flex_replacement_ranks with market rank in place of ECR, generalized to FLEX / WRRB_FLEX /
  // REC_FLEX: dedicated starters league-wide first; the flex spots go to the best leftovers by market rank that
  // can all be seated at once (greedy on a matching, so a WR never blocks an RB a REC_FLEX could have freed);
  // replacement rank = started + 1. Unranked players never start. Returns {QB, RB, WR, TE}.
  function replacementRanks({ players, slots, teams }) {
    if (!isPosInt(teams)) throw new Error("Invalid team count.");
    const { dedicated, flex } = slotCounts(slots);
    const cap = {};
    for (const k of Object.keys(flex)) cap[k] = flex[k] * teams;
    const total = Object.values(cap).reduce((a, b) => a + b, 0);
    const subsetCap = FLEX_SUBSETS.map(S => [S,
      Object.keys(cap).reduce((t, k) => t + (FLEX_ELIGIBLE[k].some(p => S.includes(p)) ? cap[k] : 0), 0)]);
    const leftovers = [];
    for (const pos of FLEX_POS) {
      const ranked = (players || []).filter(p => p.position === pos && p.rank != null).sort((a, b) => a.rank - b.rank);
      leftovers.push(...ranked.slice(dedicated[pos] * teams));
    }
    leftovers.sort((a, b) => a.rank - b.rank);
    const taken = { RB: 0, WR: 0, TE: 0 };
    let started = 0;
    for (const p of leftovers) {
      if (started === total) break;
      taken[p.position]++;
      if (subsetCap.every(([S, c]) => S.reduce((t, q) => t + taken[q], 0) <= c)) started++;
      else taken[p.position]--;
    }
    const out = {};
    for (const pos of POSITIONS) out[pos] = dedicated[pos] * teams + (taken[pos] || 0) + 1;
    return out;
  }

  // Validates the Task-1 artifact; returns per season [{rank|null, position, stats}].
  function parseArtifact(a) {
    const bad = m => { throw new Error(`Malformed pick curve: ${m}.`); };
    if (!a || a.kind !== "pick_curve" || a.schema_version !== 1) bad("unknown kind or schema version");
    const order = a.stat_order;
    if (!Array.isArray(order) || !order.length || new Set(order).size !== order.length
      || order.some(s => !LeagueLens.STATS.includes(s) || s === "passing_pick_sixes")) bad("stat_order");
    if (!Array.isArray(a.seasons) || !a.seasons.length) bad("no seasons");
    return a.seasons.map(season => {
      if (!season || !Array.isArray(season.players)) bad("a season has no players");
      const ranks = [];
      const rows = season.players.map(p => {
        if (!Array.isArray(p) || p.length !== order.length + 2) bad("row length");
        const [rank, position] = p;
        if (rank !== null && !isPosInt(rank)) bad("rank");
        if (!POSITIONS.includes(position)) bad(`position ${position}`);
        const stats = {};
        order.forEach((k, i) => { if (!isFiniteNum(p[i + 2])) bad("stat value"); stats[k] = p[i + 2]; });
        if (rank !== null) ranks.push(rank);
        return { rank, position, stats };
      });
      ranks.sort((x, y) => x - y);
      if (ranks.some((r, i) => r !== i + 1)) bad(`ranks in season ${season.season} are not 1..n`);
      return rows;
    });
  }

  // Centered moving average, the window shrinking symmetrically at the ends so the top ranks are not dragged
  // down by a one-sided window. It maps a non-increasing sequence to a non-increasing one: each step either
  // slides the window (a smaller value in, a larger out), grows it at the head (two values no larger than any
  // in it) or shrinks it at the tail (the two largest out).
  function smooth(xs, half) {
    return xs.map((_, i) => {
      const k = Math.min(half, i, xs.length - 1 - i);
      let s = 0;
      for (let j = i - k; j <= i + k; j++) s += xs[j];
      return s / (2 * k + 1);
    });
  }

  // Pool-adjacent-violators: the closest non-increasing sequence (equal weights).
  function nonIncreasing(xs) {
    const blocks = [];
    for (const x of xs) {
      blocks.push({ sum: x, n: 1 });
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
        if (a.sum / a.n >= b.sum / b.n) break;
        a.sum += b.sum; a.n += b.n; blocks.pop();
      }
    }
    const out = [];
    for (const b of blocks) for (let i = 0; i < b.n; i++) out.push(b.sum / b.n);
    return out;
  }

  // slots: the league's roster_positions (bench, IR, taxi and unmodeled slots are ignored). weights:
  // LeagueLens.effectiveWeights(scoring_settings). keepers: league.settings.max_keepers. pickSixRate: the
  // batch's published pick-six rate, required only when the league scores pick-sixes.
  function buildCurve({ artifact, weights, slots, teams, keepers, rounds, pickSixRate, keeperRule }) {
    if (!isPosInt(teams)) throw new Error("Invalid team count.");
    const K = keepers == null ? 0 : keepers;
    if (!Number.isInteger(K) || K < 0) throw new Error("Invalid keeper count.");
    const rule = keeperRule == null ? "unknown" : keeperRule;
    if (!KEEPER_RULES.includes(rule)) throw new Error(`Unknown keeper rule: ${keeperRule}`);
    if (rounds != null && !isPosInt(rounds)) throw new Error("Invalid draft rounds.");
    if (!weights || typeof weights !== "object") throw new Error("Missing scoring weights.");
    const slotList = (slots || []).map(slotName);
    if (!oneQb(slotList)) throw new Error("Pick values assume a one-quarterback league.");
    const seasons = parseArtifact(artifact);
    const scoresPickSixes = POSITIONS.some(p => weights[p] && Object.hasOwn(weights[p], "passing_pick_sixes"));
    if (scoresPickSixes && !(isFiniteNum(pickSixRate) && pickSixRate >= 0)) {
      throw new Error("This league scores pick-sixes: a pick-six rate is required.");
    }

    const sums = [], counts = [];
    for (const rows of seasons) {
      const scored = rows.map(r => {
        const stats = { ...r.stats };
        // No interceptions column -> NaN, which LeagueLens.score rejects for a league that scores pick-sixes.
        if (isFiniteNum(pickSixRate)) stats.passing_pick_sixes = stats.passing_interceptions * pickSixRate;
        return { rank: r.rank, position: r.position, points: LeagueLens.score({ p50: stats, p10: null, p90: null }, r.position, weights).p50 };
      });
      // Replacement: the Nth-best actual scorer at the position that season, among every row.
      const ranks = replacementRanks({ players: scored, slots: slotList, teams });
      const repl = {};
      for (const pos of POSITIONS) {
        const pts = scored.filter(r => r.position === pos).map(r => r.points).sort((a, b) => b - a);
        repl[pos] = pts.length ? pts[Math.min(ranks[pos], pts.length) - 1] : 0;
      }
      for (const r of scored) if (r.rank !== null) {
        sums[r.rank - 1] = (sums[r.rank - 1] || 0) + Math.max(0, r.points - repl[r.position]);
        counts[r.rank - 1] = (counts[r.rank - 1] || 0) + 1;
      }
    }
    // Mean over the seasons that ranked that deep (every season ranks 1..n, so no rank is empty). One player
    // per rank per season is noisy, so: smooth over about two rounds, force non-increasing, then smooth the
    // result again so the pooled blocks do not leave a staircase (flat runs and cliffs would make a round's
    // range and a single slot's value artifacts of where a cliff fell). The second pass keeps the curve
    // non-increasing (see smooth); the last nonIncreasing only absorbs floating-point dust. One team: no
    // smoothing at all.
    const raw = sums.map((s, i) => s / counts[i]);
    const half = teams - 1;
    const values = Object.freeze(nonIncreasing(smooth(nonIncreasing(smooth(raw, half)), half)));
    const maxRank = values.length;

    // Market rank of the player available at a live slot: the top keepers*teams never reach the draft.
    // "unknown": every pick is live. "ladder": rounds 1-2 are all live; the keepers*teams keeper picks are an
    // estimate, spread evenly over rounds 3-12 (3..rounds in a shorter draft).
    const lastKeeperRound = Math.min(LADDER_LAST_ROUND, rounds || LADDER_LAST_ROUND);
    const keeperSpan = Math.max(0, lastKeeperRound - LADDER_FIRST_ROUND + 1) * teams;
    const perSlot = keeperSpan > 0 ? Math.min(1, (K * teams) / keeperSpan) : 0;
    function rankAtSlot(slot) {
      if (!isPosInt(slot)) throw new Error(`Invalid draft slot: ${slot}`);
      let live = slot - 1;
      if (rule === "ladder") {
        const keeperSlotsBefore = Math.min(Math.max(slot - 1 - (LADDER_FIRST_ROUND - 1) * teams, 0), keeperSpan);
        live -= perSlot * keeperSlotsBefore;
      }
      return K * teams + live + 1;
    }
    // Linear between whole ranks (ladder ranks are fractional); beyond the artifact's deepest rank: 0.
    function valueAtRank(rank) {
      if (!isFiniteNum(rank) || rank < 1) throw new Error(`Invalid market rank: ${rank}`);
      if (rank > maxRank) return 0;
      const lo = Math.floor(rank), hi = Math.ceil(rank);
      const a = values[lo - 1], b = values[hi - 1];
      return a + (b - a) * (rank - lo);
    }
    return Object.freeze({ valueAtSlot: slot => valueAtRank(rankAtSlot(slot)), valueAtRank, rankAtSlot, maxRank, values });
  }

  // order: "unset" (the round's average slot) or "standings" (this season's standings, worst first). The range is
  // always the whole round: low = its last slot, high = its first.
  function pickValue({ pick, curve, order, rosters, teams, rounds, snake, reversalRound }) {
    if (!pick || !curve) throw new Error("Missing pick or curve.");
    const round = num(pick.round);
    if (isPosInt(rounds) && round > rounds) throw new Error("Pick round is beyond the draft.");
    const { first, last } = roundSlots({ round, teams });
    const high = curve.valueAtSlot(first), low = curve.valueAtSlot(last);
    if (order === "unset") {
      let sum = 0;
      for (let s = first; s <= last; s++) sum += curve.valueAtSlot(s);
      return { value: Math.min(high, Math.max(low, sum / teams)), low, high, slot: null, first, last };
    }
    if (order === "standings") {
      const slot = slotInRound({ originalRosterId: pick.originalRosterId, round, order: standingsOrder(rosters), teams, snake, reversalRound });
      return { value: curve.valueAtSlot(slot), low, high, slot, first, last };
    }
    throw new Error(`Unknown draft order: ${order}`);
  }

  // future: next-season points received minus given, unweighted. combined: this season + each pick's value
  // weighted w^n, n = seasons ahead (a next-season pick has n = 1).
  function combine({ thisSeason, give, receive, preset, currentSeason }) {
    if (!Object.hasOwn(PRESETS, preset)) throw new Error(`Unknown weighting preset: ${preset}`);
    const w = PRESETS[preset].w;
    const now = num(currentSeason);
    if (!Number.isInteger(now)) throw new Error("Current season is missing.");
    if (!isFiniteNum(thisSeason)) throw new Error("This season's change is missing.");
    const side = picks => (picks || []).reduce((acc, p) => {
      const season = num(p && p.season), value = p && p.value;
      if (!Number.isInteger(season) || season <= now) throw new Error("A pick must be for a later season.");
      if (!isFiniteNum(value)) throw new Error("A pick has no value.");
      acc.raw += value;
      acc.weighted += value * Math.pow(w, season - now);
      return acc;
    }, { raw: 0, weighted: 0 });
    const got = side(receive), gave = side(give);
    return { future: got.raw - gave.raw, combined: thisSeason + got.weighted - gave.weighted, w };
  }

  return Object.freeze({
    PRESETS, DEFAULT_PRESET, REASONS, KEEPER_RULES,
    eligibility, draftRounds, pickSeasons, ownedPicks, standingsOrder, roundSlots, slotInRound,
    replacementRanks, buildCurve, pickValue, combine,
  });
});
