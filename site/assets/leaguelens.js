/* League lens (spec §4, §3.2): classify a Sleeper league's scoring_settings and
   combine weights per (scoring position, stat). Tables are duplicated in
   src/ffmodel/site/leaguelens.py; tests/test_leaguelens.py asserts equality. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LeagueLens = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";
  const Formats = (typeof module !== "undefined" && module.exports) ? require("./formats.js") : root.Formats;
  const POSITIONS = Object.freeze(["QB", "RB", "WR", "TE"]);
  const STATS = Object.freeze(["passing_yards", "passing_tds", "passing_interceptions", "carries", "rushing_yards",
    "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds", "fumbles_lost", "passing_pick_sixes"]);
  const KEYS = Object.freeze({
    pass_yd: ["passing_yards", null], pass_td: ["passing_tds", null], pass_int: ["passing_interceptions", null],
    pass_int_td: ["passing_pick_sixes", null], rush_yd: ["rushing_yards", null], rush_td: ["rushing_tds", null],
    rush_att: ["carries", null], rec: ["receptions", null], rec_yd: ["receiving_yards", null],
    rec_td: ["receiving_tds", null], fum_lost: ["fumbles_lost", null],
    bonus_rec_te: ["receptions", ["TE"]], bonus_rec_rb: ["receptions", ["RB"]], bonus_rec_wr: ["receptions", ["WR"]],
  });
  const APPROX = Object.freeze(["pass_int_td"]);
  const RARE = Object.freeze({
    pass_2pt: 2, rush_2pt: 2, rec_2pt: 2,
    pass_td_40p: 3, pass_td_50p: 3, rush_td_40p: 3, rush_td_50p: 3, rec_td_40p: 3, rec_td_50p: 3,
    st_td: 6, fum_rec_td: 6,
  });
  const RECURRING = Object.freeze(["fum", "bonus_fd_qb", "bonus_fd_rb", "bonus_fd_te", "bonus_fd_wr", "pass_fd",
    "rush_fd", "rec_fd", "pass_cmp", "pass_inc", "pass_att", "pass_cmp_40p", "pass_sack", "rec_0_4", "rec_5_9",
    "rec_10_19", "rec_20_29", "rec_30_39", "rec_40p", "rush_40p", "bonus_pass_cmp_25", "bonus_pass_yd_300",
    "bonus_pass_yd_400", "bonus_rec_yd_100", "bonus_rec_yd_200", "bonus_rush_att_20", "bonus_rush_rec_yd_100",
    "bonus_rush_rec_yd_200", "bonus_rush_yd_100", "bonus_rush_yd_200", "kr_yd", "pr_yd", "bonus_rush_td_qb"]);
  const IGNORE_EXACT = new Set(Formats.AUDIT.ignore_exact);
  const IGNORE_RES = Formats.AUDIT.ignore_patterns.map(p => new RegExp("^(?:" + p + ")$"));
  const ignored = k => IGNORE_EXACT.has(k) || IGNORE_RES.some(re => re.test(k));
  const weightOf = (k, v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Invalid scoring weight: ${k}`);
    return v;
  };
  function effectiveWeights(scoring) {
    if (!scoring || typeof scoring !== "object" || Array.isArray(scoring)) throw new Error("Missing scoring settings.");
    const out = { QB: {}, RB: {}, WR: {}, TE: {} };
    for (const [k, raw] of Object.entries(scoring)) {
      if (!Object.hasOwn(KEYS, k)) continue;
      const v = weightOf(k, raw);
      if (v === 0) continue;
      const [stat, positions] = KEYS[k];
      for (const pos of positions || POSITIONS) out[pos][stat] = (out[pos][stat] || 0) + v;
    }
    for (const pos of POSITIONS) for (const s of Object.keys(out[pos])) {
      if (!Number.isFinite(out[pos][s])) throw new Error("Scoring overflow.");
      if (out[pos][s] === 0) delete out[pos][s];
    }
    return out;
  }
  function classify(scoring) {
    const weights = effectiveWeights(scoring);
    const res = { weights, approx: [], rare: [], recurring: [], ignored: [], unknown: [], refused: false };
    for (const [k, raw] of Object.entries(scoring)) {
      const v = weightOf(k, raw);
      if (v === 0) continue;
      if (Object.hasOwn(KEYS, k)) { if (APPROX.includes(k)) res.approx.push(k); continue; }
      if (Object.hasOwn(RARE, k)) { (Math.abs(v) <= RARE[k] ? res.rare : res.recurring).push(k); continue; }
      if (RECURRING.includes(k)) { res.recurring.push(k); continue; }
      if (ignored(k)) { res.ignored.push(k); continue; }
      res.unknown.push(k); res.recurring.push(k);
    }
    res.refused = POSITIONS.every(p => Object.keys(weights[p]).length === 0);
    return res;
  }
  // Exact exponent-free decimal of a finite double (shortest round-trip digits).
  function plain(x) {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error("weight must be a finite number");
    if (x === 0) return "0";
    const s = String(Math.abs(x));
    let m = s, e = 0;
    const k = s.indexOf("e");
    if (k >= 0) { m = s.slice(0, k); e = Number(s.slice(k + 1)); }
    const [ip, fp = ""] = m.split(".");
    let digits = ip + fp, point = ip.length + e;
    while (digits.length > 1 && digits[0] === "0") { digits = digits.slice(1); point--; }
    let out;
    if (point <= 0) out = "0." + "0".repeat(-point) + digits;
    else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
    else out = digits.slice(0, point) + "." + digits.slice(point);
    if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
    return (x < 0 ? "-" : "") + out;
  }
  function evidenceIdentity(weights) {
    const parts = POSITIONS.map(pos => {
      const ks = Object.keys(weights[pos] || {}).sort();
      return JSON.stringify(pos) + ":{" + ks.map(s => JSON.stringify(s) + ":" + JSON.stringify(plain(weights[pos][s]))).join(",") + "}";
    });
    return '{"v":1,"w":{' + parts.join(",") + "}}";
  }
  const isNum = v => typeof v === "number" && Number.isFinite(v);
  function score(sq, position, weights) {
    if (!POSITIONS.includes(position)) throw new Error(`Unsupported scoring position: ${position}`);
    const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
    if (!isObj(sq) || !isObj(sq.p50)) throw new Error("Incomplete stat quantiles.");
    const lowNull = sq.p10 == null, highNull = sq.p90 == null;
    if (lowNull !== highNull) throw new Error("Incomplete stat quantiles.");
    const bands = !lowNull;
    if (bands && !(isObj(sq.p10) && isObj(sq.p90))) throw new Error("Incomplete stat quantiles.");
    const out = { p10: bands ? 0 : null, p50: 0, p90: bands ? 0 : null };
    for (const [stat, w] of Object.entries(weights[position] || {})) {
      const mid = sq.p50[stat];
      if (!isNum(mid)) throw new Error(`Missing or invalid p50 stat: ${stat}`);
      out.p50 += w * mid;
      if (bands) {
        const lo = sq.p10[stat], hi = sq.p90[stat];
        if (!isNum(lo)) throw new Error(`Missing or invalid p10 stat: ${stat}`);
        if (!isNum(hi)) throw new Error(`Missing or invalid p90 stat: ${stat}`);
        if (!(lo <= mid && mid <= hi)) throw new Error(`Malformed band for ${stat}`);
        const a = w * lo, b = w * hi;
        out.p10 += Math.min(a, b); out.p90 += Math.max(a, b);
      }
    }
    if (Object.values(out).some(v => v !== null && !Number.isFinite(v))) throw new Error("Scoring overflow.");
    return out;
  }
  function disclosures(c) {
    const footnotes = [];
    if (c.approx.includes("pass_int_td")) footnotes.push("Pick-sixes use an average rate, not a forecast.");
    if (c.rare.length) footnotes.push(`Not projected: ${c.rare.join(", ")} (rare events).`);
    const banner = c.recurring.length
      ? `Your league also scores ${c.recurring.join(", ")}, which these projections leave out; rankings may be off for your league.`
      : null;
    return { banner, footnotes };
  }
  return Object.freeze({ POSITIONS, STATS, KEYS, APPROX, RARE, RECURRING, effectiveWeights, classify, plain, evidenceIdentity, score, disclosures });
});
