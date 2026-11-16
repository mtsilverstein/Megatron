// tests/keeperrules_fixture.cjs — run with: node tests/keeperrules_fixture.cjs
// The configurable keeper rule module (keeper-rule-settings spec §3, §6). Synthetic data only.
const assert = require("node:assert/strict");
const KR = require("../site/assets/keeperrules.js");
let failed = 0, passed = 0;
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error("FAIL " + name + "\n  " + e.message); }
}
const ladder = () => KR.preset("ladder");
const GAB_HELP = "Add each keeper-eligible player with the round and year you ORIGINALLY drafted him (cost drops one round for each year you keep him). Once a keeper's cost would reach round 2 he goes back into the draft pool. A player can be kept at most 2 years in a row. A player keeps his original draft round even if he was dropped and later picked back up — only players never drafted in this league cost R12. A kept waiver player decays too — R12 the first year you keep him, R11 the next. Keeping is optional — the tool recommends only players worth more than their keeper cost.";
const GAB_NOTE = "Every number is season points in your best STARTING LINEUP, measured by playing the rest of your draft out from the post-trade roster. Keepers are worked out for both sides — a player you acquire competes for one of your two slots, he does not add one. A player whose keeper cost would be round 2 or lower goes back in the draft pool for everybody, so he is worth nothing to trade before the draft, however good he is.";
const rule = o => KR.fromBoard({ keeper_rules: { ...ladder(), max_keepers: 2, ...o }, rounds: 15 });

check("presets order, labels, frozen", () => {
  assert.deepEqual(KR.PRESETS.map(p => p.key), ["ladder", "same_round", "one_earlier", "after_first"]);
  assert.equal(KR.PRESETS[0].label, "Round drafted − 1 per year kept (waiver pickups: round 12; max 2 years)");
  assert.equal(KR.PRESETS[1].label, "Kept at the round drafted, every year (no limit)");
  assert.equal(KR.PRESETS[2].label, "One round earlier each year kept, starting with the first (no limit)");
  assert.equal(KR.PRESETS[3].label, "The round drafted the first year, one round earlier each year after (no limit)");
  assert.ok(Object.isFrozen(KR) && Object.isFrozen(KR.PRESETS));
  assert.deepEqual(ladder(), { first_keep: 1, per_year: 1, max_years: 2, undrafted_round: 12, earliest_round: 3 });
  assert.ok(!Object.isFrozen(ladder()));
  assert.equal(KR.preset("nope"), null);
});
check("every preset validates", () => {
  for (const p of KR.PRESETS) assert.equal(KR.validate(KR.preset(p.key)), null, p.key);
});
check("invalid inputs name their label", () => {
  const bad = (o, re) => assert.match(KR.validate({ ...ladder(), ...o }), re);
  bad({ first_keep: -1 }, /^First keep/);
  bad({ first_keep: 6 }, /^First keep/);
  bad({ first_keep: 1.5 }, /^First keep/);
  bad({ first_keep: true }, /^First keep/);
  bad({ per_year: 9 }, /^Each later year/);
  bad({ max_years: 0 }, /^Most years in a row/);
  bad({ max_years: 9 }, /^Most years in a row/);
  bad({ undrafted_round: "first" }, /^Never-drafted cost/);
  bad({ earliest_round: 31 }, /^Earliest round/);
  bad({ max_keepers: 0 }, /^Keepers per team/);
  bad({ max_keepers: 4 }, /^Keepers per team/);
  bad({ extra: 1 }, /^Unknown keeper setting: extra/);
  const l = ladder(); delete l.per_year;
  assert.match(KR.validate(l), /^Each later year/);
  assert.equal(KR.validate(null), "Keeper rule must be an object");
  assert.equal(KR.validate([]), "Keeper rule must be an object");
  assert.equal(KR.validate({ ...ladder(), max_years: null }), null);
  assert.equal(KR.validate({ ...ladder(), undrafted_round: "last" }), null);
});
check("rounds bound", () => {
  assert.match(KR.validate({ ...ladder(), undrafted_round: 16 }, { rounds: 15 }), /^Never-drafted cost.*only 15 rounds/);
  assert.match(KR.validate({ ...ladder(), earliest_round: 16 }, { rounds: 15 }), /^Earliest round/);
  assert.equal(KR.validate({ ...ladder(), undrafted_round: 16 }), null);
  assert.equal(KR.validate({ ...ladder(), earliest_round: 16 }), null);
});
check("normalize", () => {
  assert.equal(KR.normalize(KR.preset("same_round"), { rounds: 15 }).undrafted_round, 15);
  assert.throws(() => KR.normalize(KR.preset("same_round"), { rounds: null }), /draft rounds is unknown/);
  assert.throws(() => KR.normalize({ ...ladder(), first_keep: 9 }, {}), /First keep/);
  const r = KR.normalize({ ...ladder(), max_keepers: 2 }, {});
  assert.ok(Object.isFrozen(r)); assert.equal(r.max_keepers, 2);
  assert.ok(!("max_keepers" in KR.normalize(ladder(), {})));
});
check("isRule", () => {
  assert.equal(KR.isRule(KR.normalize(KR.preset("ladder"), {})), true);
  assert.equal(KR.isRule(KR.preset("ladder")), false);
  assert.equal(KR.isRule(Object.freeze(KR.preset("same_round"))), false);
  assert.equal(KR.isRule(null), false);
});
check("fromBoard", () => {
  const want = { ...ladder(), max_keepers: 2 };
  assert.deepEqual(KR.fromBoard({ keeper_rules: "gabagool" }), want);
  assert.deepEqual(KR.fromBoard({ keeper_rules: "ladder" }), want);
  assert.deepEqual(KR.fromBoard({ keeper_rules: "other" }), want);
  assert.equal(KR.fromBoard({ keeper_rules: "" }), null);
  assert.equal(KR.fromBoard({}), null);
  assert.equal(KR.fromBoard({ keeper_rules: {} }), null);
  assert.equal(KR.fromBoard({ keeper_rules: KR.preset("ladder") }), null);
  assert.equal(KR.fromBoard({ keeper_rules: { ...KR.preset("same_round"), max_keepers: 1 }, rounds: 16 }).undrafted_round, 16);
  assert.equal(KR.fromBoard({ keeper_rules: { first_keep: 9 } }), null);
  assert.ok(KR.isRule(KR.fromBoard({ keeper_rules: "gabagool" })));
});
check("key", () => {
  const a = KR.normalize(ladder(), {}), b = KR.normalize(ladder(), {});
  assert.equal(KR.key(a), KR.key(b));
  for (const o of [{ first_keep: 0 }, { per_year: 0 }, { max_years: null }, { undrafted_round: 11 }, { earliest_round: 4 }])
    assert.notEqual(KR.key(KR.normalize({ ...ladder(), ...o }, {})), KR.key(a), JSON.stringify(o));
  assert.equal(KR.key(null), "unknown");
});
check("helpText", () => {
  assert.equal(KR.helpText(KR.fromBoard({ keeper_rules: "gabagool" })), GAB_HELP);
  const h = o => KR.helpText(rule(o));
  assert.ok(h({ first_keep: 0, per_year: 0 }).includes("(he is kept at that round every year)"));
  assert.ok(h({ first_keep: 0, per_year: 1 }).includes("(the first year you keep him he costs that round, then one round earlier each year after)"));
  assert.ok(h({ first_keep: 1, per_year: 0 }).includes("(keeping him costs one round earlier than that round, every year)"));
  assert.ok(h({ first_keep: 2, per_year: 1 }).includes("(the first year you keep him he costs 2 rounds earlier, then one round earlier each year after)"));
  assert.ok(h({ per_year: 2, first_keep: 2 }).includes("Once a keeper's cost would be earlier than round 3 he goes back into the draft pool."));
  assert.ok(h({ max_years: null }).includes("There is no limit on how many years a player can be kept."));
  assert.ok(h({ earliest_round: 1 }).includes("would fall below round 1"));
  assert.ok(!h({ first_keep: 0, per_year: 0 }).includes("goes back into the draft pool"));
  assert.ok(h({ first_keep: 0, per_year: 0 }).includes("A kept waiver player stays at R12."));
  assert.ok(h({ max_years: 1 }).includes("at most 1 year in a row"));
});
check("tradeNote", () => {
  assert.equal(KR.tradeNote(KR.fromBoard({ keeper_rules: "gabagool" })), GAB_NOTE);
  assert.ok(KR.tradeNote(rule({ max_keepers: 1 })).includes("competes for your one slot, he"));
  assert.ok(KR.tradeNote(rule({ max_keepers: 3 })).includes("competes for one of your three slots, he"));
  assert.ok(KR.tradeNote(rule({ earliest_round: 1 })).includes("would fall below round 1 goes back"));
  assert.ok(!KR.tradeNote(rule({ earliest_round: 1, first_keep: 0, per_year: 0 })).includes("goes back in the draft pool"));
});
check("neverDraftedKeepable", () => {
  assert.equal(KR.neverDraftedKeepable(KR.normalize(ladder(), {})), true);
  assert.equal(KR.neverDraftedKeepable(KR.normalize({ ...ladder(), undrafted_round: 2 }, {})), false);
});
console.log(`keeperrules_fixture: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
