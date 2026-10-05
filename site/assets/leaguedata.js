/* League data adapter (spec §3, §4, §5.3, §6.1, §3.2, §11).

   Loads the league-neutral batch (`data/neutral/*.json`) as one consistent
   refresh and turns it into league-scored *views* in the shapes the in-season
   analyzers already read:

   - one scorable mapping for every view: players.json entries with
     `identity_only === false`, revalidated against the live Sleeper catalog
     (ambiguous / changed GSIS, changed position, missing catalog entry ->
     excluded with a reason). A live TEAM change keeps the player with the
     projection team, so each analyzer's existing team guard still fires.
   - weekly: `points.league` from LeagueLens.score; reference lenses copied;
     a scoring error moves the player to `unscored`, never to 0.
   - remaining: today's legacy `schema_version 1` payload rebuilt from the
     compact `stats` arrays in the published `stat_order`.
   - board: identity + ECR + `ros_value` (sum of league p50 over weeks
     week+1..17, a declared bye counting 0; null when any week is unknown).

   Plus roster identities (every occupant, projection or not), league types,
   projection-UI slot support, the format line and the evidence binding.
   No DOM: `loadBatch` uses fetch (or an injected loader). */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LeagueData = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";
  const NODE = typeof module !== "undefined" && !!module.exports;
  // Lazy dependencies: resolved at call time so script order does not matter.
  const LL = () => NODE ? require("./leaguelens.js") : root.LeagueLens;
  const FMT = () => NODE ? require("./formats.js") : root.Formats;
  const LU = () => NODE ? require("./lineup.js") : root.Lineup;

  const LAST_WEEK = 17;
  const HEADER = Object.freeze(["season", "week", "data_through", "generated_at", "batch_id"]);
  const REF_LENSES = Object.freeze(["ppr", "half_ppr", "standard"]);
  // name -> [kind, schema_version, required]
  const DOCS = Object.freeze({
    weekly: ["neutral_weekly", 1, true],
    remaining: ["neutral_remaining", 2, false],
    players: ["neutral_players", 1, true],
    evaluation: ["neutral_evaluation", 1, false],
    formats: ["neutral_formats", 1, true],
  });
  const METHOD_FIELDS = Object.freeze(["v", "model", "artifacts", "ensemble", "band_construction", "calibration", "prior"]);
  const PRIOR_FIELDS = Object.freeze(["method", "rate", "first_season", "through_season"]);
  const COPY = Object.freeze({
    mixed: "Projection files are from different refreshes; reload.",
    noWeeks: "No projected weeks remain.",
    noRemaining: "remaining-season projections unavailable",
    unsupportedType: "This league type isn't supported yet.",
    bestBall: "Best ball — not eligible for the format test",
    notInTest: "Format: not in the format test",
    inTest: d => `Format: ${d} — in the 2026 format test (results January 2027)`,
  });

  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // ---- loading -----------------------------------------------------------------
  async function fetchDoc(path) {
    const res = await fetch(path, { cache: "no-cache" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }
  // Single flight per document: concurrent loads share one request; a settled
  // document is fetched again by the next load (a refresh sees new data).
  const inflight = new WeakMap();
  function once(load, path) {
    let m = inflight.get(load);
    if (!m) inflight.set(load, m = new Map());
    if (!m.has(path)) m.set(path, Promise.resolve().then(() => load(path)).finally(() => m.delete(path)));
    return m.get(path);
  }
  function statOrderOk(order) {
    return Array.isArray(order) && order.every(s => typeof s === "string") && new Set(order).size === order.length
      && LL().STATS.every(s => order.includes(s));
  }
  const SHAPE = {
    weekly: d => Array.isArray(d.players) && d.players.every(isObj),
    remaining: d => Number.isInteger(d.start_week) && Number.isInteger(d.end_week) && typeof d.status === "string"
      && statOrderOk(d.stat_order) && Array.isArray(d.players)
      && d.players.every(p => isObj(p) && Array.isArray(p.weeks) && p.weeks.every(isObj)),
    players: d => Array.isArray(d.players) && d.players.every(isObj),
    evaluation: d => Array.isArray(d.records),
    formats: d => Array.isArray(d.formats) && d.formats.length > 0 && d.formats.every(isObj),
  };
  const headerOk = d => Number.isInteger(d.season) && Number.isInteger(d.week)
    && ["data_through", "generated_at", "batch_id"].every(k => typeof d[k] === "string" && d[k] !== "");

  /* {weekly, remaining, players, evaluation, formats}. `remaining` and
     `evaluation` may be absent (404 -> null); any PRESENT document must be
     recognised, well formed and from the same refresh. `formats` is unwrapped.
     opts.load(path) -> Promise<json|null> replaces fetch (tests). */
  async function loadBatch(opts) {
    const load = (opts && opts.load) || fetchDoc;
    const base = (opts && opts.base) || "data/neutral/";
    const names = Object.keys(DOCS);
    const docs = await Promise.all(names.map(n => once(load, `${base}${n}.json`)));
    const out = {};
    names.forEach((name, i) => {
      const doc = docs[i] === undefined ? null : docs[i];
      const [kind, version, required] = DOCS[name];
      if (doc === null) {
        if (required) throw new Error(`Projection file ${name}.json is missing; reload.`);
        out[name] = null;
        return;
      }
      if (!isObj(doc) || doc.kind !== kind || doc.schema_version !== version)
        throw new Error(`Projection file ${name}.json has an unrecognized format; reload.`);
      if (!headerOk(doc) || !SHAPE[name](doc)) throw new Error(`Projection file ${name}.json is malformed; reload.`);
      out[name] = doc;
    });
    const present = names.filter(n => out[n] !== null);
    for (const f of HEADER) if (new Set(present.map(n => out[n][f])).size > 1) throw new Error(COPY.mixed);
    out.formats = out.formats.formats;
    return out;
  }

  // ---- views ---------------------------------------------------------------------
  const gsisOf = c => isObj(c) && c.gsis_id !== null && c.gsis_id !== undefined ? String(c.gsis_id).trim() : "";

  /* The one scorable mapping, revalidated live. Returns the kept players.json
     entries by GSIS id, the reverse map, the exclusions and every not-priced
     identity (published identity-only + live exclusions) by Sleeper id. */
  function resolveScorable(playersDoc, catalog) {
    const byGsis = new Map();
    for (const [sid, c] of Object.entries(catalog)) {
      const g = gsisOf(c);
      if (!g) continue;
      if (!byGsis.has(g)) byGsis.set(g, []);
      byGsis.get(g).push(String(sid));
    }
    const identityOnly = new Map(), mapped = [], sidCount = new Map(), pidCount = new Map();
    for (const p of playersDoc.players) {
      const sid = typeof p.sleeper_id === "string" && p.sleeper_id ? p.sleeper_id : null;
      if (p.identity_only !== false) {
        if (sid && !identityOnly.has(sid)) identityOnly.set(sid, p.reason || "identity_only");
        continue;
      }
      if (!sid || typeof p.player_id !== "string" || !p.player_id) continue;
      mapped.push(p);
      sidCount.set(sid, (sidCount.get(sid) || 0) + 1);
      pidCount.set(p.player_id, (pidCount.get(p.player_id) || 0) + 1);
    }
    const reasonFor = p => {
      const pid = p.player_id, sid = p.sleeper_id;
      if (sidCount.get(sid) > 1 || pidCount.get(pid) > 1) return "mapping_duplicate";
      const claims = byGsis.get(pid) || [];
      if (claims.length > 1) return "gsis_ambiguous";        // spec §3.4; seasontrade.js gsisOwners
      const c = has(catalog, sid) ? catalog[sid] : null;
      if (!isObj(c)) return "not_in_catalog";                 // cannot be revalidated
      const g = gsisOf(c);
      if (g && g !== pid) return "gsis_changed";
      if (claims.length === 1 && claims[0] !== sid) return "gsis_changed";   // GSIS now on another Sleeper id
      if (c.position !== p.position) return "position_changed";
      return null;                                            // a team change is kept (analyzer guards refuse)
    };
    const kept = new Map(), bySleeper = new Map(), excluded = [];
    for (const p of mapped) {
      const reason = reasonFor(p);
      if (reason) {
        excluded.push({ player_id: p.player_id, sleeper_id: p.sleeper_id, name: p.name, reason });
        if (!identityOnly.has(p.sleeper_id)) identityOnly.set(p.sleeper_id, reason);
        continue;
      }
      kept.set(p.player_id, p);
      bySleeper.set(p.sleeper_id, p.player_id);
    }
    return { kept, bySleeper, excluded, identityOnly };
  }

  function weeklyView(doc, kept, Lens, weights) {
    const players = [], unscored = [];
    for (const p of doc.players) {
      const pid = String(p.player_id), entry = kept.get(pid);
      if (!entry) continue;
      let league;
      try {
        if (p.position !== entry.position) throw new Error("projection position disagrees with the player universe");
        league = Lens.score(p.stat_quantiles, p.position, weights);
      } catch (e) {
        unscored.push({ player_id: pid, name: p.name, team: p.team, position: p.position, reason: e.message });
        continue;
      }
      const pts = isObj(p.points) ? p.points : {};
      const points = { league };
      for (const lens of REF_LENSES) points[lens] = isObj(pts[lens]) ? clone(pts[lens]) : null;
      players.push({ player_id: pid, name: p.name, team: p.team, opponent: p.opponent, position: p.position, points });
    }
    return { season: doc.season, week: doc.week, generated_at: doc.generated_at, data_through: doc.data_through, players, unscored };
  }

  // Neutral-only fields that are not part of today's legacy remaining payload.
  const NEUTRAL_ONLY = new Set(["kind", "batch_id", "week", "stat_order", "method", "pick_six_forecast", "players"]);
  function remainingView(doc, kept, Lens, weights) {
    const order = doc.stat_order;
    const block = a => {
      if (a === null) return null;
      if (!Array.isArray(a) || a.length !== order.length) throw new Error("Malformed stat vector.");
      return Object.fromEntries(order.map((s, i) => [s, a[i]]));
    };
    const row = (r, position) => {
      if (r.status !== "conditional_projection") return clone(r);
      try {
        if (!Array.isArray(r.stats) || r.stats.length !== 3) throw new Error("Malformed stat block.");
        const league = Lens.score({ p10: block(r.stats[0]), p50: block(r.stats[1]), p90: block(r.stats[2]) }, position, weights);
        return { week: r.week, status: r.status, opponent: r.opponent, points: { league } };
      } catch (e) {
        // Unknown, never zero: analyzers already treat `unmodeled` as missing coverage.
        return { week: r.week, status: "unmodeled", points: null, reason: `unscored: ${e.message}` };
      }
    };
    const out = { schema_version: 1, horizon: "remaining_season", status: "experimental", evaluation: null,
      season: doc.season, start_week: doc.start_week, end_week: doc.end_week,
      generated_at: doc.generated_at, data_through: doc.data_through };
    for (const [k, v] of Object.entries(doc)) if (!NEUTRAL_ONLY.has(k) && !has(out, k)) out[k] = clone(v);
    out.players = [];
    for (const p of doc.players) {
      const entry = kept.get(String(p.player_id));
      if (!entry) continue;
      const rec = {};
      for (const [k, v] of Object.entries(p)) rec[k] = k === "weeks" ? p.weeks.map(r => row(r, entry.position)) : clone(v);
      out.players.push(rec);
    }
    return out;
  }

  function rosValue(rec, week) {
    if (!rec || week + 1 > LAST_WEEK) return null;
    let sum = 0;
    for (let w = week + 1; w <= LAST_WEEK; w++) {
      const rows = rec.weeks.filter(r => r.week === w);
      if (rows.length !== 1) return null;
      const r = rows[0];
      if (r.status === "bye") continue;
      const p50 = r.status === "conditional_projection" && r.points && r.points.league && r.points.league.p50;
      if (!finite(p50)) return null;
      sum += p50;
    }
    return sum;
  }

  /* League-scored views of one batch for one live league.
     opts: {week (current NFL week; default the batch week), catalog (live
     Sleeper players by id; required)}. Throws on invalid scoring weights and
     on a league whose scoring uses no projected stat (spec §4 refusal). */
  function views(batch, league, opts) {
    const Lens = LL();
    if (!batch || !isObj(batch.weekly) || !isObj(batch.players)) throw new Error("Projection data unavailable; reload.");
    const catalog = opts && opts.catalog;
    if (!isObj(catalog)) throw new Error("Live player catalog unavailable; reload.");
    const lens = Lens.classify(league && league.scoring_settings);
    if (lens.refused) throw new Error("Your league's scoring uses none of the projected stats; projections can't be scored for it.");
    const week = opts.week === undefined || opts.week === null ? batch.weekly.week : opts.week;
    if (!Number.isInteger(week)) throw new Error("Invalid current week.");
    const { kept, bySleeper, excluded, identityOnly } = resolveScorable(batch.players, catalog);
    const weekly = weeklyView(batch.weekly, kept, Lens, lens.weights);
    let remaining = null, remainingReason = null;
    if (!batch.remaining) remainingReason = COPY.noRemaining;
    else if (batch.remaining.status === "no_remaining_weeks") remainingReason = COPY.noWeeks;
    else remaining = remainingView(batch.remaining, kept, Lens, lens.weights);
    const remById = new Map(remaining ? remaining.players.map(p => [String(p.player_id), p]) : []);
    const board = { season: batch.players.season, players: [] };
    for (const e of kept.values()) {
      board.players.push({ player_id: e.player_id, sleeper_id: e.sleeper_id, name: e.name, position: e.position, team: e.team,
        bye: e.bye === undefined ? null : e.bye, ecr: e.ecr === undefined ? null : e.ecr,
        ros_value: rosValue(remById.get(e.player_id), week) });
    }
    return { lens, disclosures: Lens.disclosures(lens), weekly, remaining, remainingReason, board,
      method: batch.weekly.method === undefined ? null : batch.weekly.method,
      excluded, scorableBySleeper: bySleeper, identityOnly };
  }

  // ---- standalone rest-of-season values (spec §5.3; astra I1) -------------------------
  /* A board `ros_value` shown or used OUTSIDE a lineup analyzer (best ball,
     an unknown starting slot, the waiver watchlist and why-value/tie-break)
     passes the same checks that analyzer applies, or it is withheld with a
     reason: the league's season, the analysed week, the caller's age limit
     and future-date tolerance, and the player's current team (projection team
     vs live catalog team, under the caller's own team normalization). The
     view keeps changed-team players on purpose (the analyzers refuse them),
     so this is where a standalone number refuses them too. Each preset is
     its analyzer's policy, verbatim: seasontrade.js (age 0..72 h; LAR/JAC/WSH)
     and waivers.js (age -1 h..72 h; LAR/WSH, case-folded). */
  const HOUR = 3600000;
  const ROS_POLICY = Object.freeze({
    trade: Object.freeze({ maxAgeMs: 72 * HOUR, futureToleranceMs: 0,
      team: t => ({ LAR: "LA", JAC: "JAX", WSH: "WAS" })[t] || t }),
    waivers: Object.freeze({ maxAgeMs: 72 * HOUR, futureToleranceMs: HOUR,
      team: x => { const t = String(x || "").toUpperCase(); return ({ LAR: "LA", WSH: "WAS" })[t] || t; } }),
  });
  const ROS_COPY = Object.freeze({
    season: (got, league) => `remaining-season projections are for ${got}; the league is in ${league}`,
    week: (start, week) => `remaining-season projections start at week ${start}, not week ${week}`,
    future: "remaining-season projections are future-dated or undated",
    stale: "remaining-season projections are stale (over 72 hours old)",
    team: (proj, live) => `current team ${live || "unknown"} differs from the projection's ${proj || "unknown"}`,
  });
  /* -> {reason, of(sleeperId) -> {value, reason}}. `reason` (batch level) is
     null when the payload passes; `of` returns value null with a reason when
     withheld, and value null / reason null for a player simply without a
     complete projection (unknown, never 0). opts: {league, week, now,
     catalog, policy: ROS_POLICY.trade | ROS_POLICY.waivers}. */
  function rosValues(view, opts) {
    const { league, week, catalog, policy } = opts || {};
    const now = opts && opts.now !== undefined ? opts.now : Date.now();
    if (!policy || typeof policy.team !== "function") throw new Error("rosValues needs a caller policy");
    const rem = view && view.remaining;
    let reason = null;
    if (!rem) reason = (view && view.remainingReason) || COPY.noRemaining;
    else if (!finite(rem.season) || rem.season !== Number(league && league.season)) reason = ROS_COPY.season(rem.season, league && league.season);
    else if (!Number.isInteger(week) || rem.start_week !== week) reason = ROS_COPY.week(rem.start_week, week);
    else {
      const age = now - Date.parse(rem.generated_at);
      if (!Number.isFinite(age) || age < -policy.futureToleranceMs) reason = ROS_COPY.future;
      else if (age > policy.maxAgeMs) reason = ROS_COPY.stale;
    }
    const board = new Map(((view && view.board && view.board.players) || []).map(p => [String(p.sleeper_id), p]));
    const projTeam = new Map(rem && !reason ? rem.players.map(p => [String(p.player_id), p.team]) : []);
    const of = sid => {
      if (reason) return { value: null, reason };
      const b = board.get(String(sid));
      if (!b || !finite(b.ros_value)) return { value: null, reason: null };
      const c = isObj(catalog) && has(catalog, String(sid)) && isObj(catalog[String(sid)]) ? catalog[String(sid)] : null;
      const proj = projTeam.get(String(b.player_id)), live = c ? c.team : null;
      if (!policy.team(proj) || policy.team(proj) !== policy.team(live)) return { value: null, reason: ROS_COPY.team(proj, live) };
      return { value: b.ros_value, reason: null };
    };
    return { reason, of };
  }

  // ---- roster identities -------------------------------------------------------------
  const nameOf = (c, sid) => c.full_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || sid;
  /* Every roster / reserve / taxi occupant by Sleeper id (K, DEF, IDP,
     teamless, unknown included); independent of players.json. With a view,
     each identity says whether it is priced and why not. */
  function rosterIdentities(rosters, catalog, view) {
    const out = new Map();
    const add = id => {
      if (id === null || id === undefined) return;
      const sid = String(id);
      if (!sid || sid === "0" || out.has(sid)) return;
      const c = isObj(catalog) && has(catalog, sid) && isObj(catalog[sid]) ? catalog[sid] : null;
      const scorable = !!(view && view.scorableBySleeper && view.scorableBySleeper.has(sid));
      const reason = view && view.identityOnly && view.identityOnly.has(sid) ? view.identityOnly.get(sid) : null;
      out.set(sid, c
        ? { sleeper_id: sid, name: nameOf(c, sid), position: c.position == null ? null : c.position, team: c.team == null ? null : c.team, unknown: false, scorable, reason }
        : { sleeper_id: sid, name: sid, position: null, team: null, unknown: true, scorable, reason });
    };
    for (const r of Array.isArray(rosters) ? rosters : []) {
      if (!isObj(r)) continue;
      for (const list of [r.players, r.starters, r.reserve, r.taxi]) if (Array.isArray(list)) list.forEach(add);
    }
    return out;
  }

  // ---- league type, slots, format line ------------------------------------------------
  function leagueType(league) {
    const s = league && isObj(league.settings) ? league.settings : {};
    const supported = [0, 1, 2].includes(s.type);
    return { supported, bestBall: s.best_ball === 1, message: supported ? null : COPY.unsupportedType };
  }

  function slotSupport(league) {
    const L = LU(), out = { modeled: [], unmodeled: [], nonStarting: [], unknown: [] };
    const slots = league && Array.isArray(league.roster_positions) ? league.roster_positions : [];
    for (const s of slots) {
      const bucket = L.MODELED.includes(s) ? out.modeled : L.UNMODELED.includes(s) ? out.unmodeled
        : L.NON_STARTING.includes(s) ? out.nonStarting : out.unknown;
      if (!bucket.includes(s)) bucket.push(s);
    }
    return out;
  }

  /* One line (spec §6.1): type support, then best-ball eligibility (which wins
     over a matching fingerprint), then the frozen fingerprint match. */
  async function formatLine(league, formats) {
    const t = leagueType(league);
    if (!t.supported) return { text: t.message, inTest: false, eligible: false };
    if (t.bestBall) return { text: COPY.bestBall, inTest: false, eligible: false };
    const F = FMT(), slots = league && Array.isArray(league.roster_positions) ? league.roster_positions : [];
    const recognised = new Set([...Object.keys(F.AUDIT.slot_eligible), "BN", ...F.AUDIT.drop_slots]);
    const eligible = slots.length > 0 && slots.every(s => recognised.has(s));
    if (slotSupport(league).unknown.length || !Array.isArray(formats)) return { text: COPY.notInTest, inTest: false, eligible };
    const label = await F.match(league, formats);
    const hits = label === null ? [] : formats.filter(f => f.label === label);
    if (hits.length !== 1 || typeof hits[0].description !== "string") return { text: COPY.notInTest, inTest: false, eligible };
    return { text: COPY.inTest(hits[0].description), inTest: true, eligible };
  }

  // ---- evidence binding ------------------------------------------------------------------
  function deepEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    }
    if (!isObj(a) || !isObj(b)) return false;
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
  }
  const nonEmptyStr = v => typeof v === "string" && v !== "";
  const exactKeys = (o, fields) => isObj(o) && Object.keys(o).length === fields.length && fields.every(k => has(o, k));
  /* The supported method-descriptor schema (src/ffmodel/site/method.py,
     METHOD_VERSION 1). Anything else -- another version, a null or mistyped
     required field, an unknown field -- is an unknown method and never
     matches, even when both sides carry the same unknowns (spec §3.2). */
  function methodSupported(m) {
    if (!exactKeys(m, METHOD_FIELDS) || m.v !== 1) return false;
    if (!nonEmptyStr(m.model) || !nonEmptyStr(m.ensemble) || !nonEmptyStr(m.band_construction)) return false;
    if (!Array.isArray(m.artifacts) || !m.artifacts.length || !m.artifacts.every(nonEmptyStr)) return false;
    if (m.calibration !== null && !(Array.isArray(m.calibration)
      && m.calibration.every(c => exactKeys(c, ["path", "sha256"]) && nonEmptyStr(c.path) && nonEmptyStr(c.sha256)))) return false;
    const p = m.prior;
    return exactKeys(p, PRIOR_FIELDS) && nonEmptyStr(p.method) && finite(p.rate) && p.rate >= 0 && p.rate <= 1
      && Number.isInteger(p.first_season) && Number.isInteger(p.through_season);
  }

  /* The record `id` as a claim about the CURRENT output, else null (spec
     §3.2): a supported (schema-valid) record method deep-equal to the current
     method, and realized == prediction scoring == the live lens identity. */
  function evidenceFor(evaluation, id, lens, method) {
    if (!isObj(evaluation) || !Array.isArray(evaluation.records)) return null;
    const hits = evaluation.records.filter(r => isObj(r) && r.id === id);
    if (hits.length !== 1) return null;
    const rec = hits[0];
    if (!methodSupported(method) || !methodSupported(rec.method) || !deepEqual(rec.method, method)) return null;
    if (!lens || !isObj(lens.weights)) return null;
    let identity;
    try { identity = LL().evidenceIdentity(lens.weights); } catch (e) { return null; }
    if (typeof rec.effective_scoring !== "string" || rec.effective_scoring !== identity || rec.prediction_scoring !== identity) return null;
    return rec;
  }

  return Object.freeze({ COPY, DOCS, LAST_WEEK, ROS_POLICY, ROS_COPY, loadBatch, views, rosValues, rosterIdentities, leagueType, slotSupport, formatLine, evidenceFor });
});
