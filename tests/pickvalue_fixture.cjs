// tests/pickvalue_fixture.cjs — run with: node tests/pickvalue_fixture.cjs
// Pure pick-value module (spec 2026-11-13-trade-draft-picks §5.1–5.4). Synthetic artifact and Sleeper
// payloads only: no real league ids, team names or usernames.
const assert = require("node:assert/strict");
const LL = require("../site/assets/leaguelens.js");
const PV = require("../site/assets/pickvalue.js");

let n = 0;
function check(name, fn) { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }
const close = (a, b, msg, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// ---- synthetic artifact in the Task-1 schema ---------------------------------------------------------------
const STAT_ORDER = ["passing_yards", "passing_tds", "passing_interceptions", "carries", "rushing_yards",
  "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds", "fumbles_lost"];
const artifactOf = seasons => ({ kind: "pick_curve", schema_version: 1, generated_at: "2026-11-13T00:00:00Z",
  weeks: [1, 17], stat_order: STAT_ORDER.slice(), market_source: "preseason consensus rank (draft worlds)", seasons });
const row = (rank, pos, s) => [rank, pos, ...STAT_ORDER.map(k => s[k] || 0)];

// Hand-checkable artifact: one-team league, yardage-only scoring, so every number below is worked by hand.
const HAND = artifactOf([
  { season: 2021, players: [
    row(1, "RB", { rushing_yards: 1500 }), row(2, "WR", { receiving_yards: 1200 }),
    row(3, "QB", { passing_yards: 4000, passing_interceptions: 10 }), row(4, "RB", { rushing_yards: 800 }),
    row(5, "TE", { receiving_yards: 600 }), row(6, "WR", { receiving_yards: 900 }),
    row(null, "RB", { rushing_yards: 300 }), row(null, "WR", { receiving_yards: 200 }),
    row(null, "QB", { passing_yards: 1000, passing_interceptions: 5 }), row(null, "TE", { receiving_yards: 100 }),
  ] },
  { season: 2022, players: [
    row(1, "WR", { receiving_yards: 1400 }), row(2, "RB", { rushing_yards: 1000 }), row(3, "RB", { rushing_yards: 200 }),
    row(4, "QB", { passing_yards: 4500, passing_interceptions: 12 }), row(5, "TE", { receiving_yards: 700 }),
    row(6, "WR", { receiving_yards: 500 }), row(7, "RB", { rushing_yards: 600 }),
    row(null, "WR", { receiving_yards: 1000 }), row(null, "QB", { passing_yards: 1500, passing_interceptions: 4 }),
    row(null, "TE", { receiving_yards: 50 }),
  ] },
]);
const HAND_SCORING = { pass_yd: 0.04, rush_yd: 0.1, rec_yd: 0.1 };
const ONE_TEAM_SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "BN", "BN"];

// Generated artifact: 2 seasons x 40 rows (36 ranked: 6 QB, 12 RB, 12 WR, 6 TE; one unranked per position).
function synthSeason(season, seed) {
  let s = seed; const rand = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const R = Math.round;
  const statsFor = (pos, q) => {
    if (pos === "QB") return { passing_yards: R(2000 + 2800 * q), passing_tds: R(8 + 30 * q), passing_interceptions: R(6 + 8 * rand()),
      carries: R(20 + 60 * q), rushing_yards: R(50 + 500 * q), rushing_tds: R(4 * q), fumbles_lost: R(2 * rand()) };
    if (pos === "RB") { const t = R(10 + 70 * q * (0.5 + rand())), rec = R(0.8 * t);
      return { carries: R(40 + 260 * q), rushing_yards: R(150 + 1350 * q), rushing_tds: R(1 + 12 * q), targets: t,
        receptions: rec, receiving_yards: R(7.5 * rec), receiving_tds: R(3 * q), fumbles_lost: R(2 * rand()) }; }
    if (pos === "WR") { const t = R(30 + 130 * q), rec = R((0.55 + 0.2 * rand()) * t);
      return { targets: t, receptions: rec, receiving_yards: R(13 * rec), receiving_tds: R(1 + 10 * q), carries: R(5 * q), rushing_yards: R(30 * q) }; }
    const t = R(20 + 110 * q), rec = R(0.7 * t);
    return { targets: t, receptions: rec, receiving_yards: R(10.5 * rec), receiving_tds: R(1 + 9 * q) };
  };
  const BIAS = { QB: -0.35, RB: 0, WR: 0, TE: -0.3 };
  const ranked = [], unranked = [];
  for (const [pos, k] of [["QB", 6], ["RB", 12], ["WR", 12], ["TE", 6]]) for (let i = 0; i <= k; i++) {
    const q = 1 - i / (k + 1);
    const realized = rand() < 0.15 ? 0.1 : Math.max(0, q + (rand() - 0.5) * 0.4);   // busts are real outcomes
    const p = { pos, market: q + BIAS[pos] + (rand() - 0.5) * 0.2, stats: statsFor(pos, realized) };
    (i < k ? ranked : unranked).push(p);
  }
  ranked.sort((a, b) => b.market - a.market);
  return { season, players: [...ranked.map((p, i) => row(i + 1, p.pos, p.stats)), ...unranked.map(p => row(null, p.pos, p.stats))] };
}
const SYNTH = artifactOf([synthSeason(2021, 11), synthSeason(2022, 29)]);
const SYNTH_DEEPEST = 36;
const STD = { pass_yd: 0.04, pass_td: 4, pass_int: -1, rush_yd: 0.1, rush_td: 6, rec_yd: 0.1, rec_td: 6, fum_lost: -2 };
const PPR = { ...STD, rec: 1 };
const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN", "BN", "BN", "BN", "IR"];
const PICK_SIX_RATE = 0.0876;

// ---- synthetic Sleeper payloads -------------------------------------------------------------------------
const leagueOf = over => ({ league_id: "L-TEST", season: "2026", status: "in_season", total_rosters: 4,
  roster_positions: SLOTS.slice(), scoring_settings: { ...PPR }, ...over,
  settings: { type: 1, max_keepers: 1, ...(over && over.settings) } });
const rosterOf = (id, wins, fpts, dec) => ({ roster_id: id, owner_id: `u${id}`, settings: { wins, losses: 10 - wins, ties: 0, fpts, fpts_decimal: dec } });
const ROSTERS = [rosterOf(1, 5, 1000, 50), rosterOf(2, 3, 1200, 0), rosterOf(3, 5, 1000, 20), rosterOf(4, 3, 1200, 0)];

// =============================================================================================================
check("presets are exact and frozen; Balanced is the default", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(PV.PRESETS)), {
    win_now: { label: "Win now", w: 0.5 }, balanced: { label: "Balanced", w: 0.8 }, rebuild: { label: "Rebuild", w: 1.2 } });
  assert.equal(PV.DEFAULT_PRESET, "balanced");
  assert.ok(Object.isFrozen(PV.PRESETS) && Object.values(PV.PRESETS).every(Object.isFrozen));
});

check("eligibility: keeper in season only; dynasty and two-quarterback leagues say why; the rest is silent", () => {
  const DYN = "Rookie-draft picks in dynasty leagues aren't valued: the pick values come from full drafts.";
  const TWO_QB = "Draft picks aren't valued in leagues that start two quarterbacks: the pick values come from one-quarterback drafts.";
  assert.deepEqual(PV.eligibility(leagueOf({ settings: { type: 1 } })), { ok: true, reason: null });
  assert.deepEqual(PV.eligibility(leagueOf({ settings: { type: 0 } })), { ok: false, reason: null });
  assert.deepEqual(PV.eligibility(leagueOf({ settings: { type: 2 } })), { ok: false, reason: DYN });
  assert.deepEqual(PV.eligibility(leagueOf({ roster_positions: ["QB", "RB", "WR", "TE", "SUPER_FLEX", "BN"] })), { ok: false, reason: TWO_QB });
  assert.deepEqual(PV.eligibility(leagueOf({ roster_positions: ["QB", "QB", "RB", "WR", "TE", "FLEX", "BN"] })), { ok: false, reason: TWO_QB });
  assert.deepEqual(PV.eligibility(leagueOf({ status: "pre_draft" })), { ok: false, reason: null });
  assert.deepEqual(PV.eligibility(leagueOf({ status: "complete", settings: { type: 2 } })), { ok: false, reason: null });
  assert.deepEqual(PV.eligibility(null), { ok: false, reason: null });
  for (const r of [DYN, TWO_QB]) for (const w of ["verdict", "win/win", "fair", "winner", "accept", "recommend", "grade"]) {
    assert.ok(!r.toLowerCase().includes(w), `reason copy uses "${w}"`);
  }
});

check("draftRounds: the draft's rounds, else the deepest traded round, else null", () => {
  assert.equal(PV.draftRounds({ draft: { type: "snake", settings: { rounds: 15 } }, tradedPicks: [{ round: 3 }] }), 15);
  assert.equal(PV.draftRounds({ draft: null, tradedPicks: [{ round: 1 }, { round: 6 }, { round: 3 }] }), 6);
  assert.equal(PV.draftRounds({ draft: { settings: { rounds: 0 } }, tradedPicks: [{ round: 4 }] }), 4);
  assert.equal(PV.draftRounds({ draft: null, tradedPicks: [] }), null);
  assert.equal(PV.draftRounds({}), null);
});

check("pickSeasons: next season always, plus later traded seasons, ascending numbers", () => {
  assert.deepEqual(PV.pickSeasons({ league: leagueOf(), tradedPicks: [] }), [2027]);
  assert.deepEqual(PV.pickSeasons({ league: leagueOf(), tradedPicks: [{ season: "2028" }, { season: "2027" }, { season: "2026" }, { season: "2028" }] }), [2027, 2028]);
  assert.deepEqual(PV.pickSeasons({ league: leagueOf(), tradedPicks: null }), [2027]);
});

check("ownedPicks: untouched, traded, re-traded (one row or a chain), traded back; season as a string", () => {
  const traded = [
    { season: "2027", round: 1, roster_id: 3, owner_id: 1, previous_owner_id: 3 },     // 3 -> 1
    { season: "2027", round: 2, roster_id: 2, owner_id: 4, previous_owner_id: 1 },     // 2 -> 1 -> 4, Sleeper's one row
    { season: "2028", round: 3, roster_id: 4, owner_id: 2, previous_owner_id: 3 },     // 4 -> 3 -> 2, as two rows,
    { season: "2028", round: 3, roster_id: 4, owner_id: 3, previous_owner_id: 4 },     //   listed out of order
    { season: "2027", round: 3, roster_id: 1, owner_id: 1, previous_owner_id: 2 },     // traded away and back
    { season: "2026", round: 1, roster_id: 1, owner_id: 2, previous_owner_id: 1 },     // past draft: ignored
    { season: "2027", round: 9, roster_id: 1, owner_id: 2, previous_owner_id: 1 },     // beyond the draft: ignored
  ];
  const owned = PV.ownedPicks({ rosters: ROSTERS, tradedPicks: traded, seasons: [2027, 2028], rounds: 3 });
  const view = id => owned.get(id).map(p => `${p.season} R${p.round}/${p.originalRosterId}`);
  assert.deepEqual(view(1), ["2027 R1/1", "2027 R1/3", "2027 R2/1", "2027 R3/1", "2028 R1/1", "2028 R2/1", "2028 R3/1"]);
  assert.deepEqual(view(2), ["2027 R1/2", "2027 R3/2", "2028 R1/2", "2028 R2/2", "2028 R3/2", "2028 R3/4"]);
  assert.deepEqual(view(3), ["2027 R2/3", "2027 R3/3", "2028 R1/3", "2028 R2/3", "2028 R3/3"]);
  assert.deepEqual(view(4), ["2027 R1/4", "2027 R2/2", "2027 R2/4", "2027 R3/4", "2028 R1/4", "2028 R2/4"]);
  // Every pick has exactly one current owner (Review Focus 1): 4 rosters x 2 seasons x 3 rounds.
  const all = [...owned.values()].flat().map(p => `${p.season}|${p.round}|${p.originalRosterId}`);
  assert.equal(all.length, 24); assert.equal(new Set(all).size, 24);
  assert.ok([...owned.keys()].every(k => typeof k === "number"));
  const first = owned.get(1)[0];
  assert.deepEqual(first, { season: 2027, round: 1, originalRosterId: 1 });
});

check("standingsOrder: fewer wins first, then fewer points for (with decimals), then roster id", () => {
  assert.deepEqual(PV.standingsOrder(ROSTERS), [2, 4, 3, 1]);
  assert.deepEqual(PV.standingsOrder([{ roster_id: 9 }, rosterOf(5, 0, 0, 0)]), [5, 9]);   // missing settings count as 0
});

check("roundSlots and slotInRound: snake, linear and third-round reversal", () => {
  assert.deepEqual(PV.roundSlots({ round: 1, teams: 12 }), { first: 1, last: 12 });
  assert.deepEqual(PV.roundSlots({ round: 3, teams: 12, snake: true, reversalRound: 3 }), { first: 25, last: 36 });
  const order = PV.standingsOrder(ROSTERS);   // [2, 4, 3, 1]
  const at = (round, opts) => PV.slotInRound({ originalRosterId: 4, round, order, teams: 4, ...opts });
  assert.deepEqual([1, 2, 3].map(r => at(r, { snake: true, reversalRound: 0 })), [2, 7, 10]);
  assert.deepEqual([1, 2, 3, 4, 5].map(r => at(r, { snake: true, reversalRound: 3 })), [2, 7, 11, 14, 19]);
  assert.deepEqual([1, 2, 3].map(r => at(r, { snake: false, reversalRound: 0 })), [2, 6, 10]);
  assert.equal(PV.slotInRound({ originalRosterId: 2, round: 2, order, teams: 4, snake: true, reversalRound: 0 }), 8);
  assert.equal(PV.slotInRound({ originalRosterId: 1, round: 2, order, teams: 4, snake: true, reversalRound: 0 }), 5);
  assert.throws(() => PV.slotInRound({ originalRosterId: 99, round: 1, order, teams: 4, snake: true }), /not in the draft order/);
});

check("replacementRanks ports flex_replacement_ranks (board_rank.py tests) and generalizes the flex types", () => {
  // test_flex_replacement_derives_split_from_ecr, as one team with the league-wide counts.
  const py1 = [[1, "QB"], [2, "QB"], [3, "QB"], [5, "RB"], [6, "RB"], [7, "RB"], [8, "RB"], [20, "RB"], [21, "RB"],
    [4, "WR"], [9, "WR"], [10, "WR"], [11, "WR"], [12, "WR"], [13, "WR"], [30, "TE"], [31, "TE"], [32, "TE"]]
    .map(([rank, position]) => ({ rank, position }));
  const slots1 = ["QB", "QB", "RB", "RB", "RB", "RB", "WR", "WR", "WR", "WR", "TE", "TE", "FLEX", "FLEX", "FLEX", "BN"];
  assert.deepEqual(PV.replacementRanks({ players: py1, slots: slots1, teams: 1 }), { QB: 3, RB: 6, WR: 7, TE: 3 });
  // test_flex_replacement_small_pool_falls_back_to_dedicated_plus_one (12 teams, 2 flex each).
  const py2 = [{ rank: 1, position: "RB" }, { rank: 2, position: "WR" }, { rank: null, position: "TE" }];
  assert.deepEqual(PV.replacementRanks({ players: py2, slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"], teams: 12 }),
    { QB: 13, RB: 25, WR: 25, TE: 13 });
  // WRRB_FLEX + REC_FLEX: the second TE leftover cannot start (one REC_FLEX), the RB behind him does.
  const mixed = [[1, "RB"], [2, "WR"], [3, "TE"], [4, "TE"], [5, "TE"], [6, "RB"], [7, "WR"]].map(([rank, position]) => ({ rank, position }));
  assert.deepEqual(PV.replacementRanks({ players: mixed, slots: ["RB", "WR", "TE", "WRRB_FLEX", "REC_FLEX"], teams: 1 }), { QB: 1, RB: 3, WR: 2, TE: 3 });
  // A WR leftover must not block the RB behind him: WR -> REC_FLEX, RB -> WRRB_FLEX (a matching, not first-fit).
  const blocker = [[1, "RB"], [2, "WR"], [3, "TE"], [4, "WR"], [5, "RB"], [6, "TE"]].map(([rank, position]) => ({ rank, position }));
  assert.deepEqual(PV.replacementRanks({ players: blocker, slots: ["RB", "WR", "TE", "WRRB_FLEX", "REC_FLEX"], teams: 1 }), { QB: 1, RB: 3, WR: 3, TE: 2 });
});

const curveOf = (artifact, scoring, opts) => PV.buildCurve({ artifact, weights: LL.effectiveWeights(scoring), slots: SLOTS,
  teams: 4, keepers: 0, rounds: 10, keeperRule: "unknown", ...opts });

check("buildCurve: hand-worked values (replacement = Nth-best scorer, flex split by market rank, season mean, PAV)", () => {
  // Per-season values by rank: 2021 [120, 30, 120, 50, 50, 0]; 2022 [40, 80, 0, 120, 65, 0, 40].
  // Mean [80, 55, 60, 85, 57.5, 0, 40]; one team -> no smoothing; PAV -> [80, 200/3 x3, 57.5, 20, 20].
  const c = curveOf(HAND, HAND_SCORING, { slots: ONE_TEAM_SLOTS, teams: 1, rounds: 7 });
  assert.equal(c.maxRank, 7);
  const want = [80, 200 / 3, 200 / 3, 200 / 3, 57.5, 20, 20];
  want.forEach((v, i) => close(c.valueAtRank(i + 1), v, `rank ${i + 1}`));
  want.forEach((v, i) => close(c.valueAtSlot(i + 1), v, `slot ${i + 1}`));
  assert.equal(c.valueAtSlot(8), 0);
  close(c.valueAtRank(5.5), 38.75, "linear between ranks 5 and 6");
  // One keeper per team: slot s takes market rank 1 + s.
  const k = curveOf(HAND, HAND_SCORING, { slots: ONE_TEAM_SLOTS, teams: 1, rounds: 7, keepers: 1 });
  close(k.valueAtSlot(1), 200 / 3, "keeper shift slot 1"); close(k.valueAtSlot(6), 20, "keeper shift slot 6");
  assert.equal(k.valueAtSlot(7), 0);
});

check("buildCurve: a league scoring pick-sixes uses passing_interceptions x rate and does not throw (Review Focus 2)", () => {
  const scoring = { ...HAND_SCORING, pass_int_td: -4 };
  // rate 0.1: 2021 QB 156 vs replacement 38 -> 118; 2022 QB 175.2 vs 58.4 -> 116.8.
  // Mean [80, 55, 59, 83.4, 57.5, 0, 40]; PAV -> [80, 65.8 x3, 57.5, 20, 20].
  const c = curveOf(HAND, scoring, { slots: ONE_TEAM_SLOTS, teams: 1, rounds: 7, pickSixRate: 0.1 });
  [80, 65.8, 65.8, 65.8, 57.5, 20, 20].forEach((v, i) => close(c.valueAtRank(i + 1), v, `rank ${i + 1}`));
  const zero = curveOf(HAND, scoring, { slots: ONE_TEAM_SLOTS, teams: 1, rounds: 7, pickSixRate: 0 });
  const none = curveOf(HAND, HAND_SCORING, { slots: ONE_TEAM_SLOTS, teams: 1, rounds: 7 });
  for (let r = 1; r <= 7; r++) close(zero.valueAtRank(r), none.valueAtRank(r), `rate 0 rank ${r}`);
  assert.throws(() => curveOf(HAND, scoring, { slots: ONE_TEAM_SLOTS, teams: 1, rounds: 7 }), /pick-six rate/);
  // An artifact without interceptions cannot estimate pick-sixes: it fails loudly, never as zero.
  const noInt = { ...HAND, stat_order: STAT_ORDER.filter(s => s !== "passing_interceptions"),
    seasons: HAND.seasons.map(s => ({ ...s, players: s.players.map(r => r.filter((_, i) => i !== 4)) })) };
  assert.throws(() => curveOf(noInt, scoring, { slots: ONE_TEAM_SLOTS, teams: 1, rounds: 7, pickSixRate: 0.1 }), /passing_pick_sixes/);
  curveOf(noInt, HAND_SCORING, { slots: ONE_TEAM_SLOTS, teams: 1, rounds: 7, pickSixRate: 0.1 });   // not scored: fine
  // The real-shaped league too: PPR plus pick-sixes, the batch's published prior rate.
  const real = curveOf(SYNTH, { ...PPR, pass_int_td: -4 }, { pickSixRate: PICK_SIX_RATE });
  for (let s = 1; s <= 40; s++) assert.ok(Number.isFinite(real.valueAtSlot(s)));
});

check("buildCurve: non-increasing in rank and in slot, finite and >= 0, for several leagues and both keeper rules", () => {
  for (const scoring of [STD, PPR]) for (const teams of [4, 10, 12, 14]) for (const keeperRule of ["unknown", "ladder"]) {
    const c = curveOf(SYNTH, scoring, { teams, keepers: 1, rounds: 15, keeperRule });
    assert.equal(c.maxRank, SYNTH_DEEPEST);
    for (let r = 1; r <= SYNTH_DEEPEST; r++) {
      const v = c.valueAtRank(r);
      assert.ok(Number.isFinite(v) && v >= 0, `rank ${r} = ${v}`);
      if (r > 1) assert.ok(v <= c.valueAtRank(r - 1), `rank ${r} rises (teams ${teams})`);
    }
    let prev = Infinity;
    for (let s = 1; s <= teams * 15; s++) { const v = c.valueAtSlot(s); assert.ok(v <= prev, `slot ${s} rises`); prev = v; }
    assert.ok(c.valueAtRank(1) > 0);
  }
});

check("buildCurve: PPR and standard scoring give different values", () => {
  const ppr = curveOf(SYNTH, PPR), std = curveOf(SYNTH, STD);
  let differ = 0;
  for (let s = 1; s <= SYNTH_DEEPEST; s++) if (Math.abs(ppr.valueAtSlot(s) - std.valueAtSlot(s)) > 1) differ++;
  assert.ok(differ >= 5, `only ${differ} slots differ`);
});

check("buildCurve: ladder keeper rule keeps rounds 1-2 live and moves later rounds to earlier market ranks", () => {
  const teams = 12, keepers = 1, rounds = 15;
  const unknown = curveOf(SYNTH, PPR, { teams, keepers, rounds, keeperRule: "unknown" });
  const ladder = curveOf(SYNTH, PPR, { teams, keepers, rounds, keeperRule: "ladder" });
  for (let s = 1; s <= 2 * teams + 1; s++) {
    assert.equal(ladder.rankAtSlot(s), unknown.rankAtSlot(s), `slot ${s}`);
    assert.equal(unknown.rankAtSlot(s), teams * keepers + s);
  }
  for (let s = 2 * teams + 2; s <= rounds * teams; s++) {
    assert.ok(ladder.rankAtSlot(s) < unknown.rankAtSlot(s), `slot ${s}`);
    assert.ok(ladder.valueAtSlot(s) >= unknown.valueAtSlot(s), `slot ${s} value`);
  }
  // 12 keeper picks spread over rounds 3-12 (120 slots): 0.1 of a keeper pick per slot.
  close(ladder.rankAtSlot(36), 12 + 36 - 0.1 * 11, "end of round 3");
  close(ladder.rankAtSlot(144), 12 + 144 - 0.1 * 119, "end of round 12");
  close(ladder.rankAtSlot(145), 145, "after the keeper rounds every keeper pick is spent");
  assert.equal(unknown.rankAtSlot(145), 157);
});

check("buildCurve: 14 teams, 16 rounds, 2 keepers: ranks beyond the artifact are 0, never NaN (Review Focus 5)", () => {
  const teams = 14, rounds = 16, keepers = 2;
  for (const keeperRule of ["unknown", "ladder"]) {
    const c = curveOf(SYNTH, PPR, { teams, keepers, rounds, keeperRule });
    for (let s = 1; s <= teams * rounds; s++) {
      const v = c.valueAtSlot(s);
      assert.ok(typeof v === "number" && Number.isFinite(v) && v >= 0, `${keeperRule} slot ${s} = ${v}`);
      if (c.rankAtSlot(s) > SYNTH_DEEPEST) assert.equal(v, 0, `${keeperRule} slot ${s}`);
    }
    assert.equal(c.valueAtSlot(teams * rounds), 0);
    for (const order of ["unset", "standings"]) {
      const r = PV.pickValue({ pick: { season: 2027, round: 16, originalRosterId: 3 }, curve: c, order, rosters: ROSTERS,
        teams, rounds, snake: true, reversalRound: 0 });
      assert.deepEqual([r.value, r.low, r.high], [0, 0, 0], `${keeperRule} ${order}`);
    }
  }
});

check("pickValue: unset = mean over the round, bounded by the round's last and first slot; standings = that slot", () => {
  const c = curveOf(SYNTH, PPR, { teams: 4, keepers: 1, rounds: 10 });
  for (let round = 1; round <= 10; round++) {
    const pick = { season: 2027, round, originalRosterId: 4 };
    const u = PV.pickValue({ pick, curve: c, order: "unset", rosters: ROSTERS, teams: 4, rounds: 10, snake: true, reversalRound: 0 });
    const { first, last } = PV.roundSlots({ round, teams: 4 });
    let mean = 0; for (let s = first; s <= last; s++) mean += c.valueAtSlot(s) / 4;
    close(u.value, mean, `round ${round} mean`);
    assert.equal(u.slot, null);
    assert.equal(u.high, c.valueAtSlot(first)); assert.equal(u.low, c.valueAtSlot(last));
    assert.ok(u.low <= u.value && u.value <= u.high, `round ${round}: ${u.low} <= ${u.value} <= ${u.high}`);
    assert.deepEqual([u.first, u.last], [first, last]);
    const st = PV.pickValue({ pick, curve: c, order: "standings", rosters: ROSTERS, teams: 4, rounds: 10, snake: true, reversalRound: 0 });
    const slot = PV.slotInRound({ originalRosterId: 4, round, order: [2, 4, 3, 1], teams: 4, snake: true, reversalRound: 0 });
    assert.equal(st.slot, slot);
    assert.equal(st.value, c.valueAtSlot(slot));
    assert.deepEqual([st.low, st.high], [u.low, u.high], "the range is always the whole round");
  }
  const r1 = PV.pickValue({ pick: { season: 2027, round: 1, originalRosterId: 4 }, curve: c, order: "unset", rosters: ROSTERS, teams: 4, rounds: 10, snake: true });
  assert.ok(r1.high > r1.low, "round 1 has a real range");
  assert.throws(() => PV.pickValue({ pick: { season: 2027, round: 1, originalRosterId: 4 }, curve: c, order: "random", rosters: ROSTERS, teams: 4, rounds: 10 }));
});

check("combine: unweighted next-season total, weighted overall w^n, every preset, picks only", () => {
  const give = [{ season: 2027, value: 30 }];
  const receive = [{ season: 2027, value: 50 }, { season: 2028, value: 20 }];
  const want = { win_now: [0.5, -10 + 25 + 5 - 15], balanced: [0.8, -10 + 40 + 12.8 - 24], rebuild: [1.2, -10 + 60 + 28.8 - 36] };
  for (const [preset, [w, combined]] of Object.entries(want)) {
    const r = PV.combine({ thisSeason: -10, give, receive, preset, currentSeason: 2026 });
    assert.equal(r.w, w); close(r.future, 40, `${preset} future`); close(r.combined, combined, `${preset} combined`);
  }
  // A two-seasons-ahead pick is weighted w^2.
  const two = PV.combine({ thisSeason: 0, give: [], receive: [{ season: 2028, value: 100 }], preset: "balanced", currentSeason: "2026" });
  close(two.combined, 64, "w^2"); close(two.future, 100, "future");
  // Picks only: this season is 0.
  const only = PV.combine({ thisSeason: 0, give: [{ season: 2027, value: 10 }], receive: [{ season: 2027, value: 40 }], preset: "rebuild", currentSeason: 2026 });
  close(only.future, 30, "picks-only future"); close(only.combined, 36, "picks-only combined");
  const none = PV.combine({ thisSeason: 12.5, give: [], receive: [], preset: "win_now", currentSeason: 2026 });
  assert.deepEqual(none, { future: 0, combined: 12.5, w: 0.5 });
  assert.throws(() => PV.combine({ thisSeason: 0, give: [], receive: [], preset: "yolo", currentSeason: 2026 }), /preset/);
});

check("real artifact: values decline smoothly, with no staircase of flat blocks and cliffs", () => {
  // The committed Task-1 artifact. After the second smoothing pass a single-slot drop is an average of the pooled
  // curve's drops over about two rounds, so it stays within about twice the mean drop over the surrounding two
  // rounds whatever the data. A staircase puts a whole block's drop on one slot (9-20x here before the fix).
  const real = require("../site/assets/pick_curve.json");
  const HALF = { ...STD, rec: 0.5 };
  const lineups = [SLOTS, ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "BN", "BN"]];
  for (const scoring of [STD, HALF, PPR]) for (const slots of lineups) for (const teams of [8, 10, 12, 14])
  for (const [keepers, keeperRule] of [[1, "unknown"], [2, "ladder"]]) {
    const c = PV.buildCurve({ artifact: real, weights: LL.effectiveWeights(scoring), slots, teams, keepers, rounds: 16, keeperRule });
    const tag = `${teams} teams, ${keepers} keepers, ${keeperRule}`;
    for (let s = 1; s < 10 * teams; s++) {
      const a = Math.max(1, s - teams), b = s + teams;
      const step = c.valueAtSlot(s) - c.valueAtSlot(s + 1), local = (c.valueAtSlot(a) - c.valueAtSlot(b)) / (b - a);
      assert.ok(step <= 3 * local + 1e-9, `${tag}: slot ${s} drops ${step} against a local mean drop of ${local}`);
    }
    let prev = Infinity;
    for (let round = 1; round <= 10; round++) {
      const p = PV.pickValue({ pick: { season: 2027, round, originalRosterId: 1 }, curve: c, order: "unset", rosters: [], teams, rounds: 16, snake: true });
      assert.ok(p.value < prev, `${tag}: R${round} is worth ${p.value} on average, not below the round before`);
      if (round <= 6) assert.ok(p.high > p.low, `${tag}: R${round} has no range (${p.high} to ${p.low})`);
      prev = p.value;
    }
  }
});

check("buildCurve rejects a malformed artifact", () => {
  const w = LL.effectiveWeights(PPR);
  const base = { weights: w, slots: SLOTS, teams: 4, keepers: 0, rounds: 10, keeperRule: "unknown" };
  assert.throws(() => PV.buildCurve({ ...base, artifact: { ...SYNTH, kind: "other" } }), /Malformed pick curve/);
  assert.throws(() => PV.buildCurve({ ...base, artifact: artifactOf([{ season: 2021, players: [row(1, "RB", {}), row(3, "WR", {})] }]) }), /Malformed pick curve/);
  assert.throws(() => PV.buildCurve({ ...base, artifact: artifactOf([{ season: 2021, players: [row(1, "K", {})] }]) }), /Malformed pick curve/);
  assert.throws(() => PV.buildCurve({ ...base, artifact: SYNTH, keeperRule: "maybe" }), /keeper rule/);
});

console.log(`pickvalue_fixture: ${n} groups OK`);
