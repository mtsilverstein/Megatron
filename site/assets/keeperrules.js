/* keeperrules.js -- the configurable keeper rule (keeper-rule-settings spec §3, §6).

   A rule is five settings plus an optional slot count:
     first_keep       rounds earlier than the drafted round the FIRST keep costs (0-5)
     per_year         further rounds earlier for each later year kept (0-5)
     max_years        most consecutive years a player can be kept (1-8, or null = no limit)
     undrafted_round  the round a never-drafted (waiver) player costs (1-30, or "last")
     earliest_round   the earliest round a keeper may cost; earlier means back in the pool (1-30)
     max_keepers      keepers per team (1-3)

   Pure and dependency-free. Nothing else consumes it until later tasks. */
(function (root, factory) {
  const K = factory();
  if (typeof window !== "undefined") window.KeeperRules = K;
  if (typeof module !== "undefined" && module.exports) module.exports = K;
})(this, function () {
  const LADDER = { first_keep: 1, per_year: 1, max_years: 2, undrafted_round: 12, earliest_round: 3 };
  const PRESETS = Object.freeze([
    { key: "ladder", label: "Round drafted − 1 per year kept (waiver pickups: round 12; max 2 years)", settings: LADDER },
    { key: "same_round", label: "Kept at the round drafted, every year (no limit)",
      settings: { first_keep: 0, per_year: 0, max_years: null, undrafted_round: "last", earliest_round: 1 } },
    { key: "one_earlier", label: "One round earlier each year kept, starting with the first (no limit)",
      settings: { first_keep: 1, per_year: 1, max_years: null, undrafted_round: "last", earliest_round: 1 } },
    { key: "after_first", label: "The round drafted the first year, one round earlier each year after (no limit)",
      settings: { first_keep: 0, per_year: 1, max_years: null, undrafted_round: "last", earliest_round: 1 } },
  ].map(p => Object.freeze({ key: p.key, label: p.label, settings: Object.freeze(p.settings) })));

  const KEYS = ["first_keep", "per_year", "max_years", "undrafted_round", "earliest_round", "max_keepers"];
  const LABELS = {
    first_keep: "First keep", per_year: "Each later year", max_years: "Most years in a row",
    undrafted_round: "Never-drafted cost", earliest_round: "Earliest round", max_keepers: "Keepers per team",
  };
  const isInt = v => typeof v === "number" && Number.isInteger(v);
  const posInt = v => isInt(v) && v > 0;
  const inRange = (v, lo, hi) => isInt(v) && v >= lo && v <= hi;

  function preset(key) {
    const p = PRESETS.find(x => x.key === key);
    return p ? { ...p.settings } : null;
  }

  function validate(raw, opts) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "Keeper rule must be an object";
    for (const k of Object.keys(raw)) if (!KEYS.includes(k)) return "Unknown keeper setting: " + k;
    const rounds = opts && opts.rounds;
    const capped = posInt(rounds);
    const bad = (k, what) => LABELS[k] + ": " + what;
    if (!inRange(raw.first_keep, 0, 5)) return bad("first_keep", "must be a whole number from 0 to 5");
    if (!inRange(raw.per_year, 0, 5)) return bad("per_year", "must be a whole number from 0 to 5");
    if (raw.max_years !== null && !inRange(raw.max_years, 1, 8)) return bad("max_years", "must be a whole number from 1 to 8, or no limit");
    const u = raw.undrafted_round;
    if (u !== "last" && !inRange(u, 1, 30)) return bad("undrafted_round", 'must be a whole number from 1 to 30, or "last"');
    if (capped && u !== "last" && u > rounds) return bad("undrafted_round", "the draft has only " + rounds + " rounds");
    if (!inRange(raw.earliest_round, 1, 30)) return bad("earliest_round", "must be a whole number from 1 to 30");
    if (capped && raw.earliest_round > rounds) return bad("earliest_round", "the draft has only " + rounds + " rounds");
    if ("max_keepers" in raw && !inRange(raw.max_keepers, 1, 3)) return bad("max_keepers", "must be a whole number from 1 to 3");
    return null;
  }

  function normalize(raw, opts) {
    const msg = validate(raw, opts);
    if (msg) throw new Error(msg);
    const rounds = opts && opts.rounds;
    let u = raw.undrafted_round;
    if (u === "last") {
      if (!posInt(rounds)) throw new Error("Never-drafted cost: the league's number of draft rounds is unknown");
      u = rounds;
    }
    const out = {
      first_keep: raw.first_keep, per_year: raw.per_year, max_years: raw.max_years,
      undrafted_round: u, earliest_round: raw.earliest_round,
    };
    if ("max_keepers" in raw) out.max_keepers = raw.max_keepers;
    return Object.freeze(out);
  }

  function isRule(x) {
    return !!x && typeof x === "object" && Object.isFrozen(x) && validate(x) === null && Number.isInteger(x.undrafted_round);
  }

  function fromBoard(league) {
    try {
      const kr = league && league.keeper_rules;
      if (kr === undefined || kr === null) return null;
      const rounds = league.rounds;
      if (typeof kr === "string") {
        if (kr !== "gabagool" && kr !== "ladder") return null;
        return normalize({ ...LADDER, max_keepers: 2 }, { rounds });
      }
      if (typeof kr !== "object" || Array.isArray(kr) || !("max_keepers" in kr)) return null;
      return normalize(kr, { rounds });
    } catch (e) {
      return null;
    }
  }

  function key(rule) {
    if (!rule) return "unknown";
    return [rule.first_keep, rule.per_year, rule.max_years === null ? "none" : rule.max_years,
      rule.undrafted_round, rule.earliest_round].join("|");
  }

  const n = k => (k === 1 ? "one round" : k + " rounds");

  function helpText(rule) {
    const f = rule.first_keep, p = rule.per_year, e = rule.earliest_round, u = rule.undrafted_round, m = rule.max_years;
    let cost;
    if (f === p && p > 0) cost = "cost drops " + n(p) + " for each year you keep him";
    else if (f === 0 && p === 0) cost = "he is kept at that round every year";
    else if (f === 0) cost = "the first year you keep him he costs that round, then " + n(p) + " earlier each year after";
    else if (p === 0) cost = "keeping him costs " + n(f) + " earlier than that round, every year";
    else cost = "the first year you keep him he costs " + n(f) + " earlier, then " + n(p) + " earlier each year after";
    const out = ["Add each keeper-eligible player with the round and year you ORIGINALLY drafted him (" + cost + ")."];
    if (f + p > 0) {
      if (e > 1 && f <= 1 && p <= 1) out.push("Once a keeper's cost would reach round " + (e - 1) + " he goes back into the draft pool.");
      else if (e > 1) out.push("Once a keeper's cost would be earlier than round " + e + " he goes back into the draft pool.");
      else out.push("Once a keeper's cost would fall below round 1 he goes back into the draft pool.");
    }
    out.push(m === null ? "There is no limit on how many years a player can be kept."
      : "A player can be kept at most " + m + " year" + (m === 1 ? "" : "s") + " in a row.");
    out.push("A player keeps his original draft round even if he was dropped and later picked back up — only players never drafted in this league cost R" + u + ".");
    out.push(p > 0 ? "A kept waiver player decays too — R" + u + " the first year you keep him, R" + (u - p) + " the next."
      : "A kept waiver player stays at R" + u + ".");
    out.push("Keeping is optional — the tool recommends only players worth more than their keeper cost.");
    return out.join(" ");
  }

  function tradeNote(rule) {
    const f = rule.first_keep, p = rule.per_year, e = rule.earliest_round;
    const slots = { 1: "your one slot", 2: "one of your two slots", 3: "one of your three slots" }[rule.max_keepers] || "one of your keeper slots";
    const out = [
      "Every number is season points in your best STARTING LINEUP, measured by playing the rest of your draft out from the post-trade roster.",
      "Keepers are worked out for both sides — a player you acquire competes for " + slots + ", he does not add one.",
    ];
    const tail = " goes back in the draft pool for everybody, so he is worth nothing to trade before the draft, however good he is.";
    if (e > 1) out.push("A player whose keeper cost would be round " + (e - 1) + " or lower" + tail);
    else if (f + p > 0) out.push("A player whose keeper cost would fall below round 1" + tail);
    return out.join(" ");
  }

  function neverDraftedKeepable(rule) {
    return rule.undrafted_round >= Math.max(rule.earliest_round, 1);
  }

  return Object.freeze({
    PRESETS, preset, validate, normalize, isRule, fromBoard, key, helpText, tradeNote, neverDraftedKeepable,
  });
});
