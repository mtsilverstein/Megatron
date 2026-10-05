// League data adapter (spec §3, §4, §5.3, §6.1, §3.2, §11): batch loading,
// league-scored views, live identity revalidation, roster identities, league
// types, slot support, format line and evidence binding. Synthetic leagues and
// a synthetic 4-player batch (fictional Sleeper ids; GSIS-shaped ids invented).
const assert = require("assert");
const LD = require("../site/assets/leaguedata.js");
const LL = require("../site/assets/leaguelens.js");
const LEAGUES = require("./fixtures/leagues_synthetic.json");
const FORMATS_DOC = require("./fixtures/neutral_formats.json");
const EVAL_DOC = require("./fixtures/neutral_evaluation.json");
const STATS = LL.STATS;
const clone = x => JSON.parse(JSON.stringify(x));

// ---- synthetic batch: 4 players, remaining weeks 15..17 ---------------------
const HDR = { season: 2026, week: 15, data_through: "2026-wk14", generated_at: "2026-12-15T12:00:00+00:00",
  batch_id: "2026-12-15T12:00:00+00:00|2026-wk14|w15" };
const METHOD = { v: 1, model: "transformer", artifacts: ["models/transformer/v1", "models/transformer/v1_s43"],
  ensemble: "mean_of_seed_quantiles", band_construction: "sign_coherent_v1",
  calibration: [{ path: "models/transformer/v1/through2025/calibration.json", sha256: "a".repeat(64) }],
  prior: { method: "pooled_return_rate_expected_cost_v1", rate: 0.08759124087591241, first_season: 2021, through_season: 2025 } };
const P50 = {
  QB: [251.123456789, 1.71, 0.83, 3.2, 15.5, 0.11, 0, 0, 0, 0, 0.21, 0.07],
  WR: [0, 0, 0, 0.4, 2.2, 0.01, 8.1, 5.6, 71.3, 0.45, 0.06, 0],
  TE: [0, 0, 0, 0, 0, 0, 6.2, 4.4, 47.9, 0.33, 0.04, 0],
  RB: [0, 0, 0, 15.2, 66.6, 0.52, 3.1, 2.4, 18.8, 0.09, 0.11, 0],
};
const vec = (pos, f) => P50[pos].map(v => +(v * f).toFixed(4));
const obj = arr => Object.fromEntries(STATS.map((s, i) => [s, arr[i]]));
const sq = (pos, f = 1) => ({ p10: obj(vec(pos, 0.5 * f)), p50: obj(vec(pos, f)), p90: obj(vec(pos, 1.6 * f)) });
const ref = (a, b, c) => ({ ppr: { p10: a, p50: b, p90: c }, half_ppr: { p10: a - 1, p50: b - 1, p90: c - 1 },
  standard: { p10: a - 2, p50: b - 2, p90: c - 2 } });
const cp = (week, opponent, pos, f, bands = true) => ({ week, status: "conditional_projection", opponent,
  stats: [bands ? vec(pos, 0.5 * f) : null, vec(pos, f), bands ? vec(pos, 1.6 * f) : null] });

function batch() {
  const weekly = { ...HDR, schema_version: 1, kind: "neutral_weekly", model: "transformer", has_bands: true,
    stat_projection_schema: { version: 1 }, pick_six_forecast: clone(METHOD.prior), method: clone(METHOD),
    players: [
      { player_id: "00-0000001", name: "Synthetic Passer", team: "KC", opponent: "DEN", position: "QB", is_home: true, stat_quantiles: sq("QB"), points: ref(8, 18, 30) },
      { player_id: "00-0000002", name: "Synthetic Wideout", team: "BUF", opponent: "MIA", position: "WR", is_home: false, stat_quantiles: sq("WR"), points: ref(5, 13, 24) },
      { player_id: "00-0000003", name: "Synthetic Tight End", team: "LA", opponent: "SF", position: "TE", is_home: true, stat_quantiles: sq("TE"), points: ref(3, 9, 17) },
      { player_id: "00-0000004", name: "Synthetic Conflict", team: "NYG", opponent: "DAL", position: "RB", is_home: false, stat_quantiles: sq("RB"), points: ref(4, 11, 20) },
    ] };
  const remaining = { ...HDR, schema_version: 2, kind: "neutral_remaining", horizon: "remaining_season",
    status: "experimental", start_week: 15, end_week: 17, model: "transformer", forecast_cutoff: "before 2026 week 15",
    scoring_scope: "Existing weekly-model stat subset with league weights; not every platform scoring event is forecast.",
    limitations: ["Synthetic limitation."], stat_order: STATS.slice(), pick_six_forecast: clone(METHOD.prior), method: clone(METHOD),
    players: [
      { player_id: "00-0000001", team: "KC", weeks: [cp(15, "DEN", "QB", 1), cp(16, "LV", "QB", 1.1), cp(17, "LAC", "QB", 0.9)],
        history_status: "recent_observed_history", last_observed_season: 2026, name: "Synthetic Passer", position: "QB" },
      { player_id: "00-0000002", team: "BUF", weeks: [cp(15, "MIA", "WR", 1), { week: 16, status: "bye", points: null },
        { week: 17, status: "unmodeled", points: null, reason: "missing_model_output" }],
        history_status: "recent_observed_history", last_observed_season: 2026, name: "Synthetic Wideout", position: "WR" },
      { player_id: "00-0000003", team: "LA", weeks: [cp(15, "SF", "TE", 1, false), cp(16, "ARI", "TE", 0.8, false), cp(17, "SEA", "TE", 1.2, false)],
        history_status: "recent_observed_history", last_observed_season: 2026, name: "Synthetic Tight End", position: "TE" },
      { player_id: "00-0000004", team: "NYJ", weeks: [cp(15, "NE", "RB", 1)],
        history_status: "recent_observed_history", last_observed_season: 2026, name: "Synthetic Conflict", position: "RB" },
    ] };
  const players = { ...HDR, schema_version: 1, kind: "neutral_players",
    ecr_source: { source: "synthetic", date: "2026-08-20", scoring: "PPR" },
    players: [
      { player_id: "00-0000001", sleeper_id: "9001", name: "Synthetic Passer", team: "KC", position: "QB", bye: 10, ecr: 12, identity_only: false, reason: null },
      { player_id: "00-0000002", sleeper_id: "9002", name: "Synthetic Wideout", team: "BUF", position: "WR", bye: 16, ecr: 40.5, identity_only: false, reason: null },
      { player_id: "00-0000003", sleeper_id: "9003", name: "Synthetic Tight End", team: "LA", position: "TE", bye: 8, ecr: null, identity_only: false, reason: null },
      { player_id: "00-0000004", sleeper_id: "9004", name: "Synthetic Conflict", team: "NYG", position: "RB", bye: null, ecr: 80, identity_only: true, reason: "projection_identity_conflict" },
    ] };
  const evaluation = { ...HDR, schema_version: 1, kind: "neutral_evaluation", records: clone(EVAL_DOC.records) };
  const formats = { ...HDR, schema_version: 1, kind: "neutral_formats", formats: clone(FORMATS_DOC.formats) };
  return { weekly, remaining, players, evaluation, formats };
}
const viewBatch = (b = batch()) => ({ ...b, formats: b.formats.formats });
function catalog() {
  return {
    "9001": { player_id: "9001", full_name: "Synthetic Passer", position: "QB", team: "KC", gsis_id: "00-0000001" },
    "9002": { player_id: "9002", full_name: "Synthetic Wideout", position: "WR", team: "BUF", gsis_id: " 00-0000002 " },
    "9003": { player_id: "9003", full_name: "Synthetic Tight End", position: "TE", team: "LAR", gsis_id: "00-0000003" },
    "9004": { player_id: "9004", full_name: "Synthetic Conflict", position: "RB", team: "NYG", gsis_id: "00-0000004" },
    "4001": { player_id: "4001", full_name: "Synthetic Kicker", position: "K", team: "KC", gsis_id: null },
    "KC": { player_id: "KC", first_name: "Kansas City", last_name: "Chiefs", position: "DEF", team: "KC" },
    "5001": { player_id: "5001", full_name: "Synthetic Linebacker", position: "LB", team: "DEN", gsis_id: "00-0005001" },
    "6001": { player_id: "6001", full_name: "Synthetic Free Agent", position: "WR", team: null, gsis_id: "" },
  };
}
const GAB = LEAGUES.gabagool_like;
const lensOf = league => LL.classify(league.scoring_settings);
const ids = arr => arr.map(p => p.player_id).sort();
const sqFrom = (stats, order = STATS) => {
  const o = a => a === null ? null : Object.fromEntries(order.map((s, i) => [s, a[i]]));
  return { p10: o(stats[0]), p50: o(stats[1]), p90: o(stats[2]) };
};

(async () => {
  // ---- views: weekly scoring and reference lenses -----------------------------
  {
    const b = viewBatch(), v = LD.views(b, GAB, { week: 15, catalog: catalog() });
    const w = LL.effectiveWeights(GAB.scoring_settings);
    assert.deepStrictEqual(v.lens, lensOf(GAB));
    assert.deepStrictEqual(v.disclosures, LL.disclosures(lensOf(GAB)));
    assert.deepStrictEqual(v.method, b.weekly.method);
    assert.deepStrictEqual(Object.keys(v.weekly).sort(), ["data_through", "generated_at", "players", "season", "unscored", "week"]);
    assert.strictEqual(v.weekly.season, 2026); assert.strictEqual(v.weekly.week, 15);
    assert.strictEqual(v.weekly.generated_at, HDR.generated_at); assert.strictEqual(v.weekly.data_through, HDR.data_through);
    assert.deepStrictEqual(ids(v.weekly.players), ["00-0000001", "00-0000002", "00-0000003"], "identity-only player is never priced");
    assert.deepStrictEqual(v.weekly.unscored, []);
    for (const p of v.weekly.players) {
      const src = b.weekly.players.find(x => x.player_id === p.player_id);
      assert.deepStrictEqual(Object.keys(p).sort(), ["name", "opponent", "player_id", "points", "position", "team"]);
      assert.deepStrictEqual(p.points.league, LL.score(src.stat_quantiles, src.position, w), `league lens = LeagueLens.score for ${p.player_id}`);
      for (const lens of ["ppr", "half_ppr", "standard"]) {
        assert.deepStrictEqual(p.points[lens], src.points[lens], `${lens} reference lens copied`);
        assert.notStrictEqual(p.points[lens], src.points[lens], `${lens} is a copy`);
      }
      assert.strictEqual(p.team, src.team); assert.strictEqual(p.opponent, src.opponent); assert.strictEqual(p.name, src.name);
    }
    // a different league rescales the same batch
    const v2 = LD.views(b, LEAGUES.superflex_half, { week: 15, catalog: catalog() });
    const qb = v2.weekly.players.find(p => p.position === "QB");
    assert.deepStrictEqual(qb.points.league, LL.score(b.weekly.players[0].stat_quantiles, "QB", LL.effectiveWeights(LEAGUES.superflex_half.scoring_settings)));
    assert.notDeepStrictEqual(qb.points.league, v.weekly.players.find(p => p.position === "QB").points.league);
  }
  // ---- views: a scoring error moves the player to unscored ----------------------
  {
    const b = viewBatch(); b.weekly.players[2].stat_quantiles.p50.receptions = "x";
    const v = LD.views(b, GAB, { week: 15, catalog: catalog() });
    assert.deepStrictEqual(ids(v.weekly.players), ["00-0000001", "00-0000002"]);
    assert.strictEqual(v.weekly.unscored.length, 1);
    assert.strictEqual(v.weekly.unscored[0].player_id, "00-0000003");
    assert.match(v.weekly.unscored[0].reason, /receptions/);
  }
  // ---- views: remaining rebuilds today's legacy shape exactly -------------------
  {
    const b = viewBatch(), v = LD.views(b, GAB, { week: 15, catalog: catalog() });
    const w = LL.effectiveWeights(GAB.scoring_settings);
    const r = v.remaining;
    assert.strictEqual(v.remainingReason, null);
    assert.strictEqual(r.schema_version, 1); assert.strictEqual(r.horizon, "remaining_season");
    assert.strictEqual(r.status, "experimental"); assert.strictEqual(r.evaluation, null);
    assert.strictEqual(r.season, 2026); assert.strictEqual(r.start_week, 15); assert.strictEqual(r.end_week, 17);
    assert.strictEqual(r.generated_at, HDR.generated_at); assert.strictEqual(r.data_through, HDR.data_through);
    assert.strictEqual(r.scoring_scope, b.remaining.scoring_scope, "provenance kept");
    for (const k of ["kind", "batch_id", "stat_order", "week", "method"]) assert.ok(!(k in r), `${k} is not part of the legacy shape`);
    assert.deepStrictEqual(ids(r.players), ["00-0000001", "00-0000002", "00-0000003"]);
    const league = (pos, row) => LL.score(sqFrom(row.stats), pos, w);
    const src = id => b.remaining.players.find(p => p.player_id === id);
    const expectRows = (id, pos) => src(id).weeks.map(row => row.status === "conditional_projection"
      ? { week: row.week, status: row.status, opponent: row.opponent, points: { league: league(pos, row) } }
      : clone(row));
    const A = r.players.find(p => p.player_id === "00-0000001");
    assert.deepStrictEqual(A, { player_id: "00-0000001", team: "KC", weeks: expectRows("00-0000001", "QB"),
      history_status: "recent_observed_history", last_observed_season: 2026, name: "Synthetic Passer", position: "QB" });
    const B = r.players.find(p => p.player_id === "00-0000002");
    assert.deepStrictEqual(B.weeks[1], { week: 16, status: "bye", points: null });
    assert.deepStrictEqual(B.weeks[2], { week: 17, status: "unmodeled", points: null, reason: "missing_model_output" });
    assert.deepStrictEqual(B.weeks, expectRows("00-0000002", "WR"));
    const C = r.players.find(p => p.player_id === "00-0000003");
    assert.deepStrictEqual(C.weeks, expectRows("00-0000003", "TE"));
    assert.strictEqual(C.weeks[0].points.league.p10, null); assert.strictEqual(C.weeks[0].points.league.p90, null);
    assert.ok(Number.isFinite(C.weeks[0].points.league.p50));
    // the published stat_order, not a hardcoded order, maps the arrays
    const b2 = viewBatch(); b2.remaining.stat_order = STATS.slice().reverse();
    for (const p of b2.remaining.players) for (const row of p.weeks) if (row.stats) row.stats = row.stats.map(a => a && a.slice().reverse());
    assert.deepStrictEqual(LD.views(b2, GAB, { week: 15, catalog: catalog() }).remaining, r, "stat_order honoured");
  }
  // ---- views: board and ros_value ----------------------------------------------
  {
    const v = LD.views(viewBatch(), GAB, { week: 15, catalog: catalog() });
    assert.strictEqual(v.board.season, 2026);
    assert.deepStrictEqual(ids(v.board.players), ["00-0000001", "00-0000002", "00-0000003"]);
    const row = (id, week) => v.remaining.players.find(p => p.player_id === id).weeks.find(x => x.week === week);
    const A = v.board.players.find(p => p.player_id === "00-0000001");
    assert.deepStrictEqual(A, { player_id: "00-0000001", sleeper_id: "9001", name: "Synthetic Passer", position: "QB", team: "KC",
      bye: 10, ecr: 12, ros_value: row("00-0000001", 16).points.league.p50 + row("00-0000001", 17).points.league.p50 });
    assert.strictEqual(v.board.players.find(p => p.player_id === "00-0000002").ros_value, null, "a null future week nulls ros_value");
    assert.strictEqual(v.board.players.find(p => p.player_id === "00-0000002").ecr, 40.5);
    const C = v.board.players.find(p => p.player_id === "00-0000003");
    assert.strictEqual(C.ros_value, row("00-0000003", 16).points.league.p50 + row("00-0000003", 17).points.league.p50);
    assert.strictEqual(C.ecr, null);
    // week 14 would need week 15..17: all present for A
    const v14 = LD.views(viewBatch(), GAB, { week: 14, catalog: catalog() });
    assert.strictEqual(v14.board.players.find(p => p.player_id === "00-0000001").ros_value,
      row("00-0000001", 15).points.league.p50 + row("00-0000001", 16).points.league.p50 + row("00-0000001", 17).points.league.p50);
    // a declared bye counts 0, not unknown
    const bb = viewBatch(); bb.remaining.players[1].weeks[2] = cp(17, "NE", "WR", 1);
    const vb = LD.views(bb, GAB, { week: 15, catalog: catalog() });
    const wr17 = vb.remaining.players.find(p => p.player_id === "00-0000002").weeks[2].points.league.p50;
    assert.strictEqual(vb.board.players.find(p => p.player_id === "00-0000002").ros_value, 0 + wr17, "bye week contributes 0");
    // week 17: nothing remains after the current week
    const v17 = LD.views(viewBatch(), GAB, { week: 17, catalog: catalog() });
    assert.ok(v17.board.players.every(p => p.ros_value === null));
    assert.deepStrictEqual([...v.scorableBySleeper.entries()].sort(), [["9001", "00-0000001"], ["9002", "00-0000002"], ["9003", "00-0000003"]]);
    assert.deepStrictEqual(v.excluded, []);
  }
  // ---- standalone rest-of-season values (astra I1) -------------------------------
  {
    const v = LD.views(viewBatch(), GAB, { week: 15, catalog: catalog() });
    const GEN = Date.parse(HDR.generated_at), H = 3600000;
    const A = v.board.players.find(p => p.sleeper_id === "9001").ros_value;
    assert.ok(Number.isFinite(A));
    assert.throws(() => LD.rosValues(v, { league: GAB, week: 15, catalog: catalog() }), /needs a caller policy/);
    for (const [name, policy, tol] of [["trade", LD.ROS_POLICY.trade, 0], ["waivers", LD.ROS_POLICY.waivers, H]]) {
      const at = (now, cat = catalog(), extra = {}) => LD.rosValues(v, { league: GAB, week: 15, now, catalog: cat, policy, ...extra });
      let g = at(GEN + 60000);
      assert.strictEqual(g.reason, null, name);
      assert.deepStrictEqual(g.of("9001"), { value: A, reason: null }, name);
      assert.ok(Number.isFinite(g.of("9003").value), `${name}: LAR (live) == LA (projection) under the analyzer's normalization`);
      assert.deepStrictEqual(g.of("9002"), { value: null, reason: null }, `${name}: an incomplete projection is unknown, not withheld`);
      assert.deepStrictEqual(g.of("777"), { value: null, reason: null }, `${name}: off the board`);
      // age: 72 h is the limit, inclusive; one ms more is stale
      assert.strictEqual(at(GEN + 72 * H).reason, null, `${name}: exactly 72 h`);
      g = at(GEN + 72 * H + 1);
      assert.strictEqual(g.reason, LD.ROS_COPY.stale, name);
      assert.deepStrictEqual(g.of("9001"), { value: null, reason: LD.ROS_COPY.stale }, name);
      // future-dated: the caller's own tolerance (trade 0, waivers 1 h)
      assert.strictEqual(at(GEN - tol).reason, null, `${name}: at the tolerance`);
      assert.strictEqual(at(GEN - tol - 1).reason, LD.ROS_COPY.future, `${name}: beyond the tolerance`);
      const undated = { ...v, remaining: { ...v.remaining, generated_at: "not a date" } };
      assert.strictEqual(LD.rosValues(undated, { league: GAB, week: 15, now: GEN, catalog: catalog(), policy }).reason, LD.ROS_COPY.future);
      // season and week
      assert.strictEqual(at(GEN, catalog(), { league: { ...GAB, season: "2027" } }).reason, "remaining-season projections are for 2026; the league is in 2027");
      assert.strictEqual(at(GEN, catalog(), { week: 14 }).reason, "remaining-season projections start at week 15, not week 14");
      // absent payload: the view's own reason
      assert.strictEqual(LD.rosValues({ ...v, remaining: null, remainingReason: LD.COPY.noWeeks }, { league: GAB, week: 15, now: GEN, catalog: catalog(), policy }).reason, LD.COPY.noWeeks);
      assert.strictEqual(LD.rosValues({ ...v, remaining: null, remainingReason: null }, { league: GAB, week: 15, now: GEN, catalog: catalog(), policy }).reason, LD.COPY.noRemaining);
      // current team: changed, missing, absent from the catalog
      const moved = catalog(); moved["9001"].team = "DEN";
      g = at(GEN, moved);
      assert.deepStrictEqual(g.of("9001"), { value: null, reason: "current team DEN differs from the projection's KC" }, name);
      assert.ok(Number.isFinite(g.of("9003").value), `${name}: other players unaffected`);
      const teamless = catalog(); teamless["9001"].team = null;
      assert.deepStrictEqual(at(GEN, teamless).of("9001"), { value: null, reason: "current team unknown differs from the projection's KC" });
      const gone = catalog(); delete gone["9001"];
      assert.strictEqual(at(GEN, gone).of("9001").value, null);
    }
    // Each preset is its analyzer's normalization, not a union of the two.
    const jax = { ...v, remaining: { ...v.remaining, players: v.remaining.players.map(p => p.player_id === "00-0000001" ? { ...p, team: "JAX" } : p) } };
    const jac = catalog(); jac["9001"].team = "JAC";
    const lower = catalog(); lower["9001"].team = "kc";
    const run = (view, cat, policy) => LD.rosValues(view, { league: GAB, week: 15, now: GEN, catalog: cat, policy }).of("9001");
    assert.strictEqual(run(jax, jac, LD.ROS_POLICY.trade).value, A, "trade (seasontrade.js): JAC == JAX");
    assert.strictEqual(run(jax, jac, LD.ROS_POLICY.waivers).value, null, "waivers (waivers.js): JAC != JAX");
    assert.strictEqual(run(v, lower, LD.ROS_POLICY.waivers).value, A, "waivers case-folds");
    assert.strictEqual(run(v, lower, LD.ROS_POLICY.trade).value, null, "trade does not case-fold");
    // Drift guard: the presets restate the analyzers' own rules; if an engine changes, this fails.
    const fs = require("fs"), path = require("path");
    const src = f => fs.readFileSync(path.join(__dirname, "..", "site", "assets", f), "utf8");
    const st = src("seasontrade.js"), wv = src("waivers.js");
    assert.ok(st.includes('const team = t => ({LAR:"LA",JAC:"JAX",WSH:"WAS"}[t] || t);'), "seasontrade.js team normalization");
    assert.ok(st.includes("age>=0&&age<=72*3600000"), "seasontrade.js remaining-season age rule");
    assert.ok(wv.includes('function team(x) { return ({ LAR: "LA", WSH: "WAS" })[String(x || "").toUpperCase()] || String(x || "").toUpperCase(); }'), "waivers.js team normalization");
    assert.ok(wv.includes("age < -3600000 || age > 72 * 3600000) return none(\"remaining-season projections are stale"), "waivers.js remaining-season age rule");
  }

  // ---- views: empty state vs missing remaining ----------------------------------
  {
    const b = viewBatch();
    b.remaining = { ...HDR, week: 18, schema_version: 2, kind: "neutral_remaining", horizon: "remaining_season",
      status: "no_remaining_weeks", start_week: 18, end_week: 17, model: "transformer", stat_order: STATS.slice(), players: [] };
    const empty = LD.views(b, GAB, { week: 15, catalog: catalog() });
    assert.strictEqual(empty.remaining, null);
    assert.strictEqual(empty.remainingReason, "No projected weeks remain.");
    assert.ok(empty.board.players.every(p => p.ros_value === null));
    const b2 = viewBatch(); b2.remaining = null;
    const missing = LD.views(b2, GAB, { week: 15, catalog: catalog() });
    assert.strictEqual(missing.remaining, null);
    assert.strictEqual(missing.remainingReason, "remaining-season projections unavailable");
    assert.notStrictEqual(empty.remainingReason, missing.remainingReason);
    assert.strictEqual(missing.weekly.players.length, 3, "weekly survives a missing remaining file");
  }
  // ---- live revalidation --------------------------------------------------------
  const priced = v => ({ weekly: ids(v.weekly.players), remaining: ids(v.remaining.players), board: ids(v.board.players) });
  {
    const cat = catalog(); cat["9001"].position = "TE";
    const v = LD.views(viewBatch(), GAB, { week: 15, catalog: cat });
    const all = ["00-0000002", "00-0000003"];
    assert.deepStrictEqual(priced(v), { weekly: all, remaining: all, board: all }, "position change removes everywhere");
    assert.deepStrictEqual(v.excluded, [{ player_id: "00-0000001", sleeper_id: "9001", name: "Synthetic Passer", reason: "position_changed" }]);
    assert.ok(!v.scorableBySleeper.has("9001"));
  }
  {
    const cat = catalog(); cat["9002"].team = "MIA";
    const v = LD.views(viewBatch(), GAB, { week: 15, catalog: cat });
    assert.deepStrictEqual(v.excluded, []);
    assert.strictEqual(v.weekly.players.find(p => p.player_id === "00-0000002").team, "BUF", "team change keeps the projection team");
    assert.strictEqual(v.remaining.players.find(p => p.player_id === "00-0000002").team, "BUF");
    assert.strictEqual(v.board.players.find(p => p.player_id === "00-0000002").team, "BUF");
    assert.strictEqual(v.scorableBySleeper.get("9002"), "00-0000002");
  }
  {
    const cat = catalog(); cat["9003"].gsis_id = "00-0009999";
    const v = LD.views(viewBatch(), GAB, { week: 15, catalog: cat });
    const all = ["00-0000001", "00-0000002"];
    assert.deepStrictEqual(priced(v), { weekly: all, remaining: all, board: all });
    assert.deepStrictEqual(v.excluded, [{ player_id: "00-0000003", sleeper_id: "9003", name: "Synthetic Tight End", reason: "gsis_changed" }]);
  }
  {
    const cat = catalog(); cat["9999"] = { player_id: "9999", full_name: "Synthetic Duplicate", position: "QB", team: "KC", gsis_id: "00-0000001" };
    const v = LD.views(viewBatch(), GAB, { week: 15, catalog: cat });
    const all = ["00-0000002", "00-0000003"];
    assert.deepStrictEqual(priced(v), { weekly: all, remaining: all, board: all }, "ambiguous GSIS never priced");
    assert.deepStrictEqual(v.excluded, [{ player_id: "00-0000001", sleeper_id: "9001", name: "Synthetic Passer", reason: "gsis_ambiguous" }]);
    assert.ok(!v.scorableBySleeper.has("9001") && !v.scorableBySleeper.has("9999"));
    const roster = [{ roster_id: 1, owner_id: "owner-a", players: ["9001", "9002"], starters: ["9001"], reserve: null, taxi: null }];
    const idents = LD.rosterIdentities(roster, cat, v);
    assert.deepStrictEqual(idents.get("9001"), { sleeper_id: "9001", name: "Synthetic Passer", position: "QB", team: "KC", unknown: false, scorable: false, reason: "gsis_ambiguous" });
    assert.strictEqual(idents.get("9002").scorable, true);
  }
  {
    // identity-only (projection_identity_conflict) whose live GSIS would match: absent from every priced view
    const v = LD.views(viewBatch(), GAB, { week: 15, catalog: catalog() });
    for (const [name, list] of Object.entries(priced(v))) assert.ok(!list.includes("00-0000004"), `identity-only absent from ${name}`);
    assert.ok(!v.scorableBySleeper.has("9004"));
    assert.strictEqual(v.identityOnly.get("9004"), "projection_identity_conflict");
    const idents = LD.rosterIdentities([{ roster_id: 1, players: ["9004"] }], catalog(), v);
    assert.strictEqual(idents.get("9004").reason, "projection_identity_conflict");
    assert.strictEqual(idents.get("9004").scorable, false);
  }
  {
    // a mapped player missing from the live catalog cannot be revalidated
    const cat = catalog(); delete cat["9002"];
    const v = LD.views(viewBatch(), GAB, { week: 15, catalog: cat });
    assert.deepStrictEqual(v.excluded.map(e => [e.player_id, e.reason]), [["00-0000002", "not_in_catalog"]]);
  }
  {
    // two scorable entries sharing one Sleeper id: neither is priced
    const b = viewBatch(); b.players.players[2].sleeper_id = "9002";
    const v = LD.views(b, GAB, { week: 15, catalog: catalog() });
    assert.deepStrictEqual(v.excluded.map(e => [e.player_id, e.reason]), [["00-0000002", "mapping_duplicate"], ["00-0000003", "mapping_duplicate"]]);
    assert.deepStrictEqual(ids(v.weekly.players), ["00-0000001"]);
  }
  assert.throws(() => LD.views(viewBatch(), GAB, { week: 15, catalog: null }), /catalog/i);
  assert.throws(() => LD.views(viewBatch(), { ...GAB, scoring_settings: { fgm_yds: 0.1, def_td: 6 } }, { week: 15, catalog: catalog() }), /scor/i);
  // ---- roster identities --------------------------------------------------------
  {
    const rosters = [
      { roster_id: 1, owner_id: "owner-a", players: ["9001", "4001", "KC", "5001", "6001", "7777", "9002"], starters: ["9001", "4001", "0"], reserve: ["9002"], taxi: ["9003"] },
      { roster_id: 2, owner_id: null, players: null, starters: [], reserve: null, taxi: null },
    ];
    const m = LD.rosterIdentities(rosters, catalog());
    assert.ok(m instanceof Map);
    assert.deepStrictEqual([...m.keys()].sort(), ["4001", "5001", "6001", "7777", "9001", "9002", "9003", "KC"]);
    assert.strictEqual(m.get("4001").position, "K");
    assert.deepStrictEqual(m.get("KC"), { sleeper_id: "KC", name: "Kansas City Chiefs", position: "DEF", team: "KC", unknown: false, scorable: false, reason: null });
    assert.strictEqual(m.get("5001").position, "LB");
    assert.strictEqual(m.get("6001").team, null); assert.strictEqual(m.get("6001").unknown, false);
    assert.deepStrictEqual(m.get("7777"), { sleeper_id: "7777", name: "7777", position: null, team: null, unknown: true, scorable: false, reason: null });
    assert.strictEqual(m.get("9003").name, "Synthetic Tight End", "taxi occupant kept");
  }
  // ---- league types and slot support -------------------------------------------
  assert.deepStrictEqual(LD.leagueType(GAB), { supported: true, bestBall: false, message: null });
  assert.deepStrictEqual(LD.leagueType(LEAGUES.fam_like), { supported: true, bestBall: false, message: null });
  assert.deepStrictEqual(LD.leagueType(LEAGUES.best_ball), { supported: true, bestBall: true, message: null });
  assert.deepStrictEqual(LD.leagueType(LEAGUES.type_9), { supported: false, bestBall: false, message: "This league type isn't supported yet." });
  assert.strictEqual(LD.leagueType({ settings: {} }).supported, false);
  assert.deepStrictEqual(LD.slotSupport(GAB), { modeled: ["QB", "RB", "WR", "TE", "FLEX"], unmodeled: ["K", "DEF"], nonStarting: ["BN"], unknown: [] });
  assert.deepStrictEqual(LD.slotSupport(LEAGUES.idp).unmodeled, ["K", "DEF", "DL", "LB", "IDP_FLEX"]);
  assert.deepStrictEqual(LD.slotSupport(LEAGUES.weird_slot).unknown, ["XFLEX"]);
  assert.ok(LD.slotSupport(LEAGUES.superflex_half).modeled.includes("SUPER_FLEX"));
  // ---- format line ---------------------------------------------------------------
  {
    const F = FORMATS_DOC.formats;
    const NOT = "Format: not in the format test";
    assert.deepStrictEqual(await LD.formatLine(GAB, F),
      { text: "Format: 12-team 1QB PPR, 6-pt pass TD — in the 2026 format test (results January 2027)", inTest: true, eligible: true });
    assert.deepStrictEqual(await LD.formatLine(LEAGUES.fam_like, F),
      { text: "Format: 10-team 1QB PPR, 6-pt pass TD — in the 2026 format test (results January 2027)", inTest: true, eligible: true });
    assert.deepStrictEqual(await LD.formatLine(LEAGUES.te_premium, F), { text: NOT, inTest: false, eligible: true });
    assert.deepStrictEqual(await LD.formatLine(LEAGUES.best_ball, F), { text: "Best ball — not eligible for the format test", inTest: false, eligible: false });
    assert.deepStrictEqual(await LD.formatLine(LEAGUES.idp, F), { text: NOT, inTest: false, eligible: false });
    assert.deepStrictEqual(await LD.formatLine(LEAGUES.weird_slot, F), { text: NOT, inTest: false, eligible: false });
    assert.deepStrictEqual(await LD.formatLine(LEAGUES.type_9, F), { text: "This league type isn't supported yet.", inTest: false, eligible: false });
    for (const k of ["two_team", "thirty_two_team", "fd_league", "superflex_half"])
      assert.strictEqual((await LD.formatLine(LEAGUES[k], F)).text, NOT, k);
    // best ball overrides a matching fingerprint
    const Formats = require("../site/assets/formats.js");
    assert.strictEqual(await Formats.match(LEAGUES.best_ball, F), "f12-1qb-ppr-6");
  }
  // ---- evidence binding ------------------------------------------------------------
  {
    const lens = lensOf(GAB), idn = LL.evidenceIdentity(lens.weights);
    const ev = recs => ({ ...HDR, schema_version: 1, kind: "neutral_evaluation", records: recs });
    const synthetic = { id: "synthetic_claim", metric: "m", effective_scoring: idn, prediction_scoring: idn, method: clone(METHOD), values: { x: 1 } };
    const e1 = ev([synthetic]);
    assert.strictEqual(LD.evidenceFor(e1, "synthetic_claim", lens, clone(METHOD)), e1.records[0], "full match returned");
    assert.strictEqual(LD.evidenceFor(e1, "other", lens, METHOD), null);
    assert.strictEqual(LD.evidenceFor(null, "synthetic_claim", lens, METHOD), null);
    assert.strictEqual(LD.evidenceFor(e1, "synthetic_claim", lens, null), null, "current method null");
    assert.strictEqual(LD.evidenceFor(ev([{ ...synthetic, method: null }]), "synthetic_claim", lens, METHOD), null, "record method null");
    const partial = clone(METHOD); delete partial.calibration;
    assert.strictEqual(LD.evidenceFor(ev([{ ...synthetic, method: partial }]), "synthetic_claim", lens, METHOD), null, "partial record method");
    assert.strictEqual(LD.evidenceFor(e1, "synthetic_claim", lens, partial), null, "partial current method");
    const partialPrior = clone(METHOD); delete partialPrior.prior.rate;
    assert.strictEqual(LD.evidenceFor(ev([{ ...synthetic, method: partialPrior }]), "synthetic_claim", lens, partialPrior), null, "partial prior");
    assert.strictEqual(LD.evidenceFor(ev([{ ...synthetic, method: { ...clone(METHOD), extra: 1 } }]), "synthetic_claim", lens, METHOD), null, "unknown method field");
    assert.strictEqual(LD.evidenceFor(ev([{ ...synthetic, method: { ...clone(METHOD), band_construction: "other" } }]), "synthetic_claim", lens, METHOD), null);
    // M4: equal-but-unknown descriptors never match (both sides carry the same unknowns).
    const unknowns = {
      "v 999": m => { m.v = 999; },
      "null artifacts": m => { m.artifacts = null; },
      "empty artifacts": m => { m.artifacts = []; },
      "null ensemble": m => { m.ensemble = null; },
      "null band construction": m => { m.band_construction = null; },
      "null model": m => { m.model = null; },
      "numeric model": m => { m.model = 7; },
      "null prior method": m => { m.prior.method = null; },
      "null prior rate": m => { m.prior.rate = null; },
      "prior rate above 1": m => { m.prior.rate = 1.5; },
      "string first season": m => { m.prior.first_season = "2021"; },
      "null through season": m => { m.prior.through_season = null; },
      "extra prior field": m => { m.prior.extra = 1; },
      "extra top-level field": m => { m.extra = 1; },
      "calibration entry missing sha": m => { m.calibration = [{ path: "x" }]; },
      "calibration not a list": m => { m.calibration = { path: "x", sha256: "y" }; },
      "all unknown at once": m => { m.v = 999; m.artifacts = null; m.ensemble = null; m.band_construction = null; m.prior.rate = null; m.extra = "x"; },
    };
    for (const [name, mutate] of Object.entries(unknowns)) {
      const m = clone(METHOD); mutate(m);
      assert.strictEqual(LD.evidenceFor(ev([{ ...synthetic, method: clone(m) }]), "synthetic_claim", lens, clone(m)), null, `equal but unknown: ${name}`);
    }
    { const okDoc = ev([{ ...synthetic, method: clone(METHOD) }]);
      assert.strictEqual(LD.evidenceFor(okDoc, "synthetic_claim", lens, clone(METHOD)), okDoc.records[0], "valid equal descriptor returns the record"); }
    const nullCal = { ...clone(METHOD), calibration: null };
    assert.ok(LD.evidenceFor(ev([{ ...synthetic, method: nullCal }]), "synthetic_claim", lens, clone(nullCal)), "null calibration is a present field");
    assert.strictEqual(LD.evidenceFor(ev([{ ...synthetic, prediction_scoring: null }]), "synthetic_claim", lens, METHOD), null);
    assert.strictEqual(LD.evidenceFor(ev([synthetic, clone(synthetic)]), "synthetic_claim", lens, METHOD), null, "duplicate ids fail closed");
    // real records (generated by evidence_records.build_evaluation)
    assert.strictEqual(LD.evidenceFor(EVAL_DOC, "ros_mae_gabagool", lens, METHOD), null, "real ROS record (method null) under the Gabagool lens");
    assert.strictEqual(LD.evidenceFor(EVAL_DOC, "start_sit_close_calls", lens, METHOD), null);
    const ros = clone(EVAL_DOC.records.find(r => r.id === "ros_mae_gabagool")); ros.method = clone(METHOD);
    assert.strictEqual(LD.evidenceFor(ev([ros]), "ros_mae_gabagool", lens, METHOD), null, "pick-six-free measurement is not the live Gabagool lens");
    const noPick = lensOf({ scoring_settings: { ...GAB.scoring_settings, pass_int_td: 0 } });
    assert.ok(LD.evidenceFor(ev([ros]), "ros_mae_gabagool", noPick, METHOD), "same record matches the scoring it was measured under");
  }
  // ---- loadBatch -----------------------------------------------------------------------
  {
    const NAMES = ["weekly", "remaining", "players", "evaluation", "formats"];
    const loaderFor = (docs, calls = []) => path => {
      calls.push(path);
      const name = NAMES.find(n => path === `data/neutral/${n}.json`);
      assert.ok(name, `unexpected path ${path}`);
      return new Promise(resolve => setTimeout(() => resolve(docs[name] === undefined ? null : clone(docs[name])), 5));
    };
    const calls = [];
    const load = loaderFor(batch(), calls);
    const [x, y] = await Promise.all([LD.loadBatch({ load }), LD.loadBatch({ load })]);
    assert.deepStrictEqual(calls.slice().sort(), NAMES.map(n => `data/neutral/${n}.json`).sort(), "single flight per document");
    assert.deepStrictEqual(x, y);
    assert.ok(Array.isArray(x.formats) && x.formats.length === 5, "formats unwrapped");
    assert.strictEqual(x.weekly.kind, "neutral_weekly"); assert.strictEqual(x.remaining.kind, "neutral_remaining");
    await LD.loadBatch({ load });
    assert.strictEqual(calls.length, 10, "settled documents are refetched on the next load");
    const rejects = async (mutate, re, msg) => {
      const docs = batch(); mutate(docs);
      await assert.rejects(LD.loadBatch({ load: loaderFor(docs) }), re, msg);
    };
    const MIXED = /^Error: Projection files are from different refreshes; reload\.$/;
    await rejects(d => { d.players.batch_id = "other"; }, e => MIXED.test(String(e)), "mixed batch_id");
    await rejects(d => { d.evaluation.batch_id = "other"; }, e => MIXED.test(String(e)), "mixed optional document");
    await rejects(d => { d.remaining.generated_at = "2026-12-16T00:00:00+00:00"; }, e => MIXED.test(String(e)), "mixed header field");
    await rejects(d => { d.weekly.kind = "neutral_weekly_v9"; }, /weekly/, "unknown kind");
    await rejects(d => { d.formats.schema_version = 2; }, /formats/, "unknown schema_version");
    await rejects(d => { d.evaluation.kind = "something"; }, /evaluation/, "present optional with unknown kind");
    await rejects(d => { d.remaining.schema_version = 1; }, /remaining/, "legacy remaining schema");
    await rejects(d => { d.remaining.players = {}; }, /remaining/, "malformed remaining");
    await rejects(d => { d.remaining.stat_order = ["passing_yards"]; }, /remaining/, "malformed stat_order");
    await rejects(d => { d.remaining.players[0].weeks = null; }, /remaining/, "malformed remaining row list");
    await rejects(d => { d.weekly = undefined; }, /weekly/, "weekly required");
    await rejects(d => { d.players = undefined; }, /players/, "players required");
    await rejects(d => { d.formats = undefined; }, /formats/, "formats required");
    await rejects(d => { d.formats.formats = []; }, /formats/, "empty formats");
    const docs = batch(); delete docs.remaining; delete docs.evaluation;
    const partial = await LD.loadBatch({ load: loaderFor(docs) });
    assert.strictEqual(partial.remaining, null, "absent remaining -> null");
    assert.strictEqual(partial.evaluation, null, "absent evaluation -> null");
    await assert.rejects(LD.loadBatch({ load: () => Promise.reject(new Error("network down")) }), /network down/);
    // default loader: fetch, 404 -> null, other HTTP errors reject
    const seen = [];
    global.fetch = async (path, opts) => {
      seen.push([path, opts]);
      const name = NAMES.find(n => path.endsWith(`/${n}.json`));
      if (name === "evaluation") return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => clone(batch()[name]) };
    };
    const viaFetch = await LD.loadBatch();
    assert.strictEqual(viaFetch.evaluation, null);
    assert.ok(seen.every(([p, o]) => p.startsWith("data/neutral/") && o && o.cache === "no-cache"));
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(LD.loadBatch(), /500/);
    delete global.fetch;
    // views over a loaded batch
    assert.strictEqual(LD.views(x, GAB, { week: 15, catalog: catalog() }).weekly.players.length, 3);
  }
  console.log("leaguedata fixture OK");
})().catch(e => { console.error(e); process.exit(1); });
