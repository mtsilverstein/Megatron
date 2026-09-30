// tests/formats_fixture.cjs — run with: node tests/formats_fixture.cjs
// Local-only (spawns the project venv's python), like the other node fixtures.
const assert = require("assert");
const path = require("path");
const { execFileSync } = require("child_process");
const F = require("../site/assets/formats.js");

const ROOT = path.join(__dirname, "..");
const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");
const FIX = require("./fixtures/owner_league_settings.json");
const LABELS = ["f12-1qb-ppr-6", "f10-1qb-ppr-6", "f12-1qb-ppr-4", "f12-sf-ppr-4", "f12-1qb-half-4"];
const clone = o => JSON.parse(JSON.stringify(o));
const live = slug => clone(FIX[slug]);

function py(code) {
  return JSON.parse(execFileSync(PY, ["-c", code], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(ROOT, "src") } }));
}

// Synthesize a Sleeper payload from a format config so fromSleeper is exercised
// on the config path too (K/DEF/IR/TAXI added, BN sized from roster_size).
const PYDUMP = `
import json
from ffmodel import formats as F
out = {"audit": F.AUDIT, "formats": {}, "owners": {}}
for l in ${JSON.stringify(LABELS)}:
    c = F.load_format(l)
    starters = [p for p, n in c.roster.items() for _ in range(n)] + [("SUPER_FLEX" if "QB" in c.flex_positions else "FLEX")] * c.flex
    out["formats"][l] = {"desc": F.describe(c), "key": F.format_key(c), "compat": F.compat(c),
        "teams": c.teams, "starters": starters, "roster_size": c.roster_size, "scoring": c.sleeper_scoring}
fix = json.load(open("tests/fixtures/owner_league_settings.json"))
for s, v in fix.items():
    k, cm = F.from_sleeper(v)
    out["owners"][s] = {"key": k, "compat": cm}
print(json.dumps(out))
`;

(async () => {
  const P = py(PYDUMP);

  // The audit table is identical in both implementations.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(F.AUDIT)), P.audit);

  // Python <-> JS equality of both parts on all five configs.
  const table = [];
  for (const l of LABELS) {
    const f = P.formats[l];
    assert.strictEqual(await F.formatKey(f.desc), f.key, l + " key from desc");
    assert.deepStrictEqual(F.compat({ scoring_settings: f.scoring }), f.compat, l + " compat");
    const bn = f.roster_size - f.starters.length;
    const league = {
      total_rosters: f.teams,
      roster_positions: [...f.starters, "K", "DEF", ...Array(bn).fill("BN"), "IR", "TAXI"],
      scoring_settings: { ...f.scoring, fgm_40_49: 4, xpm: 1, sack: 1 },
    };
    const got = await F.fromSleeper(league);
    assert.strictEqual(got.format_key, f.key, l + " key from synthesized sleeper payload");
    assert.deepStrictEqual(got.compat, f.compat);
    table.push({ label: l, format_key: f.key, compat: f.compat });
  }
  assert.strictEqual(new Set(table.map(t => t.format_key)).size, 5);

  // Both owner leagues: parity and match.
  for (const [slug, label] of [["gabagool", "f12-1qb-ppr-6"], ["fam", "f10-1qb-ppr-6"]]) {
    const got = await F.fromSleeper(live(slug));
    assert.strictEqual(got.format_key, P.owners[slug].key);
    assert.deepStrictEqual(got.compat, P.owners[slug].compat);
    assert.strictEqual(await F.match(live(slug), table), label);
  }

  // Same key, different compat -> no match.
  const base = await F.fromSleeper(live("gabagool"));
  for (const edit of [{ pass_int_td: 0 }, { pass_td_50p: 0 }, { bonus_rec_te: 0.5 }]) {
    const lg = live("gabagool");
    Object.assign(lg.scoring_settings, edit);
    const got = await F.fromSleeper(lg);
    assert.strictEqual(got.format_key, base.format_key);
    assert.notDeepStrictEqual(got.compat, base.compat);
    assert.strictEqual(await F.match(lg, table), null);
  }

  // Unknown nonzero offensive key fails closed; zero is omitted.
  let lg = live("gabagool");
  lg.scoring_settings.mystery_off_bonus = 1;
  assert.strictEqual(await F.match(lg, table), null);
  lg.scoring_settings.mystery_off_bonus = 0;
  assert.strictEqual(await F.match(lg, table), "f12-1qb-ppr-6");

  // Unknown roster slot fails closed.
  lg = live("gabagool");
  lg.roster_positions.push("IDP_FLEX");
  assert.strictEqual(await F.match(lg, table), null);

  // K/DEF/IDP changes move nothing.
  lg = live("fam");
  Object.assign(lg.scoring_settings, { fgm_40_49: 9, xpm: 3, sack: 5, int: 4, pts_allow_0: 1, def_td: 1, idp_pass_def_3p: 2, tkl: 1 });
  assert.deepStrictEqual(await F.fromSleeper(lg), await F.fromSleeper(live("fam")));

  // IR/TAXI change nothing; BN changes roster_size (and so the key).
  lg = live("gabagool");
  lg.roster_positions.push("IR", "IR", "TAXI");
  assert.strictEqual((await F.fromSleeper(lg)).format_key, base.format_key);
  lg.roster_positions.push("BN");
  assert.notStrictEqual((await F.fromSleeper(lg)).format_key, base.format_key);

  // Canonical number handling: -0 -> 0, integral floats print as ints.
  assert.strictEqual(F.canonical({ b: -0, a: 6, c: 0.0400001 }), '{"a":6,"b":0,"c":0.04}');

  // Small magnitudes: fixed-point text identical to Python, no exponent, ties away from zero.
  const small = { a: 1e-5, b: 5e-7, c: -1.5e-6, d: 1e-6, e: 0.0078125, f: 1e-7 };
  assert.strictEqual(F.canonical(small), '{"a":0.00001,"b":0,"c":-0.000002,"d":0.000001,"e":0.007813,"f":0}');
  assert.strictEqual(F.canonical(small), py("import json; from ffmodel import formats as F; print(json.dumps(F.canonical(" + JSON.stringify(small) + ")))"));

  // Null / undefined / non-finite / blank required weights fail closed (never read as 0).
  for (const bad of [null, undefined, NaN, Infinity, "", "abc"]) {
    lg = live("gabagool");
    lg.scoring_settings.pass_td = bad;
    assert.strictEqual(await F.match(lg, table), null, "pass_td=" + String(bad));
    lg = live("gabagool");
    lg.scoring_settings.mystery_off_bonus = bad;
    assert.strictEqual(await F.match(lg, table), null, "unknown=" + String(bad));
  }

  // Offensive-looking keys that begin with a defensive/K prefix are NOT ignored.
  for (const key of ["xp_bonus_rec", "sack_bonus_qb", "def_rec_bonus", "tkl_rec_bonus", "fgm_rush_bonus"]) {
    lg = live("gabagool");
    lg.scoring_settings[key] = 0.5;
    assert.strictEqual(await F.match(lg, table), null, key);
  }

  // A default-Sleeper 4-pt league (ST / fumble-return TDs 6) matches the -4 format.
  const f4 = P.formats["f12-1qb-ppr-4"];
  assert.strictEqual(f4.compat.st_td, 6);
  assert.strictEqual(f4.compat.fum_rec_td, 6);

  console.log("formats_fixture: ok");
})().catch(e => { console.error(e); process.exit(1); });
