// site/assets/formats.js
/* League format fingerprint: the JS twin of src/ffmodel/formats.py.

   A live Sleeper league matches a format only when BOTH its format_key (teams,
   offensive starter slots, roster size, weights of the predicted stat
   components) and its compat signature (every non-predicted offensive scoring
   key, omitted -> 0) are equal. Unknown nonzero offensive keys land in compat
   under their own name, so they can equal nothing a format declares: fail
   closed, no nearest-format fallback.

   The AUDIT table below is duplicated in formats.py; tests/formats_fixture.cjs
   asserts the two are identical. Hashing is async (crypto.subtle). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Formats = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PREDICTED_STATS = ["passing_yards", "passing_tds", "passing_interceptions",
    "carries", "rushing_yards", "rushing_tds", "targets", "receptions",
    "receiving_yards", "receiving_tds", "fumbles_lost"];
  const PREDICTED_KEYS = {
    pass_yd: "passing_yards", pass_td: "passing_tds", pass_int: "passing_interceptions",
    rush_yd: "rushing_yards", rush_td: "rushing_tds", rec_yd: "receiving_yards",
    rec_td: "receiving_tds", rec: "receptions", fum_lost: "fumbles_lost",
  };
  const COMPAT_KEYS = [
    "pass_int_td", "pass_td_50p", "pass_td_40p", "rush_td_50p", "rush_td_40p",
    "rec_td_50p", "rec_td_40p", "pass_2pt", "rush_2pt", "rec_2pt", "st_td",
    "fum_rec_td", "bonus_rec_te", "bonus_rec_rb", "bonus_rec_wr",
    "bonus_fd_qb", "bonus_fd_rb", "bonus_fd_te", "bonus_fd_wr",
    "pass_cmp", "pass_inc", "pass_att", "pass_cmp_40p", "pass_fd", "pass_sack",
    "rush_att", "rush_40p", "rush_fd", "rec_fd", "rec_0_4", "rec_5_9",
    "rec_10_19", "rec_20_29", "rec_30_39", "rec_40p", "fum", "kr_yd", "pr_yd",
    "bonus_pass_cmp_25", "bonus_pass_yd_300", "bonus_pass_yd_400",
    "bonus_rec_yd_100", "bonus_rec_yd_200", "bonus_rush_att_20",
    "bonus_rush_rec_yd_100", "bonus_rush_rec_yd_200", "bonus_rush_td_qb",
    "bonus_rush_yd_100", "bonus_rush_yd_200",
  ].sort();
  const IGNORE_EXACT = [
    "int", "ff", "fum_rec", "safe", "blk_kick", "st_ff", "st_fum_rec", "xpm", "xpmiss",
    "fgm_yds", "fgm_yds_over_30", "sack", "sack_yd", "qb_hit", "tkl", "tkl_solo",
    "tkl_ast", "tkl_loss", "int_ret_yd", "fum_ret_yd", "fg_ret_yd", "blk_kick_ret_yd",
    "st_tkl_solo", "bonus_def_int_td_50p", "bonus_def_fum_td_50p", "bonus_sack_2p",
    "bonus_tkl_10p", "def_td", "def_st_td", "def_st_ff", "def_st_fum_rec",
    "def_st_tkl_solo", "def_kr_yd", "def_pr_yd", "def_2pt", "def_4_and_stop",
    "def_3_and_out", "def_forced_punts", "def_pass_def", "def_int", "def_sack",
    "def_safe", "def_fum_rec", "def_blk_kick",
  ].sort();
  // Anchored full-match patterns only (no bare prefixes): an unrecognised
  // offensive-looking key stays "unknown" and fails closed.
  const IGNORE_PATTERNS = [
    "(fgm|fgmiss|pts_allow|yds_allow)(_\\d+(_\\d+|p)?)?",
    "idp_[a-z0-9_]+",
  ].sort();
  const IGNORE_RES = IGNORE_PATTERNS.map(p => new RegExp("^(?:" + p + ")$"));
  const DROP_SLOTS = ["K", "DEF", "IR", "TAXI"];
  const SLOT_ELIGIBLE = {
    QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"],
    FLEX: ["RB", "TE", "WR"], WRRB_FLEX: ["RB", "WR"],
    REC_FLEX: ["TE", "WR"], SUPER_FLEX: ["QB", "RB", "TE", "WR"],
  };
  const AUDIT = {
    predicted_keys: PREDICTED_KEYS, predicted_stats: PREDICTED_STATS.slice(),
    compat_keys: COMPAT_KEYS, ignore_exact: IGNORE_EXACT, ignore_patterns: IGNORE_PATTERNS,
    drop_slots: DROP_SLOTS.slice().sort(), slot_eligible: SLOT_ELIGIBLE,
  };

  /* 6 decimals via toFixed (exact binary value, ties away from zero), trailing
     zeros trimmed, -0 -> 0. Python's _fixed produces the identical text. */
  function fixed(x) {
    let t = Number(x).toFixed(6);
    if (t.indexOf(".") >= 0) t = t.replace(/0+$/, "").replace(/\.$/, "");
    return (t === "" || t === "-0") ? "0" : t;
  }

  function num(x) { return Number(fixed(x)); }

  /* A required weight: finite number or non-blank numeric string, else throw. */
  function weight(v) {
    const ok = typeof v === "number" || (typeof v === "string" && v.trim() !== "");
    const f = ok ? Number(v) : NaN;
    if (!Number.isFinite(f)) throw new Error("non-finite or non-numeric weight " + String(v));
    return f;
  }

  function canonical(o) {
    if (Array.isArray(o)) return "[" + o.map(canonical).join(",") + "]";
    if (o !== null && typeof o === "object") {
      return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
    }
    if (typeof o === "number") return fixed(o);
    return JSON.stringify(o);
  }

  function sortedSlots(slots) {
    return slots.map(([n, e]) => [n, e.slice().sort()]).sort((a, b) => {
      const ka = a[0], kb = b[0];
      if (ka !== kb) return ka < kb ? -1 : 1;
      const ea = a[1].join(","), eb = b[1].join(",");
      return ea < eb ? -1 : ea > eb ? 1 : 0;
    });
  }

  function classify(key) {
    if (Object.prototype.hasOwnProperty.call(PREDICTED_KEYS, key)) return "predicted";
    if (COMPAT_KEYS.includes(key)) return "compat";
    if (IGNORE_EXACT.includes(key) || IGNORE_RES.some(r => r.test(key))) return "ignore";
    return "unknown";
  }

  function splitScoring(scoring) {
    const predicted = {};
    PREDICTED_STATS.forEach(c => { predicted[c] = 0; });
    const compatMap = {};
    COMPAT_KEYS.forEach(k => { compatMap[k] = 0; });
    Object.keys(scoring).forEach(key => {
      const kind = classify(key);
      if (kind === "ignore") return;
      const v = weight(scoring[key]);
      if (kind === "predicted") predicted[PREDICTED_KEYS[key]] = v;
      else if (kind === "compat") compatMap[key] = v;
      else if (v !== 0) compatMap[key] = v;   // fails closed
    });
    const out = {};
    Object.keys(compatMap).sort().forEach(k => { out[k] = num(compatMap[k]); });
    return { predicted, compat: out };
  }

  /* Format-key content + compat from a Sleeper /league/<id> payload. Throws on
     a roster slot it cannot classify (fail closed). */
  function describeSleeper(league) {
    const slots = [];
    let size = 0;
    league.roster_positions.forEach(pos => {
      if (DROP_SLOTS.includes(pos)) return;
      size += 1;
      if (pos === "BN") return;
      if (!Object.prototype.hasOwnProperty.call(SLOT_ELIGIBLE, pos)) throw new Error("unknown roster slot " + pos);
      slots.push([pos, SLOT_ELIGIBLE[pos]]);
    });
    const s = splitScoring(league.scoring_settings);
    return {
      desc: { teams: Number(league.total_rosters), slots: sortedSlots(slots), roster_size: size, predicted: s.predicted },
      compat: s.compat,
    };
  }

  function subtle() {
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto.subtle;
    return require("crypto").webcrypto.subtle;
  }

  async function formatKey(desc) {
    const bytes = new TextEncoder().encode(canonical(desc));
    const buf = await subtle().digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function compat(desc) {
    if (desc && desc.scoring_settings) return splitScoring(desc.scoring_settings).compat;
    if (desc && desc.compat) return desc.compat;
    throw new Error("compat needs scoring_settings or a compat map");
  }

  async function fromSleeper(league) {
    const d = describeSleeper(league);
    return { format_key: await formatKey(d.desc), compat: d.compat };
  }

  /* table: [{label, format_key, compat}]. Exactly one exact hit or null. */
  async function match(league, table) {
    let got;
    try { got = await fromSleeper(league); } catch (e) { return null; }
    const cs = canonical(got.compat);
    const hits = table.filter(t => t.format_key === got.format_key && canonical(t.compat) === cs);
    return hits.length === 1 ? hits[0].label : null;
  }

  return { formatKey, compat, fromSleeper, match, canonical, describeSleeper, AUDIT };
});
