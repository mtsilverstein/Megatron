// Reproducibility fixture for the in-season baseline ledger (any-league phase 1, Task 1).
// Re-runs tools/capture_inseason_baseline.cjs's analyzer preparation from the committed
// legacy_<slug>.json + scenarios.json and deep-equals outputs_<slug>.json.
// SYNTHETIC ANALYZER PARITY: fictional league, not historical forecast reproduction.
// Run with: node tests/inseason_baseline_fixture.cjs
// Tasks 11-13 remove their analyzer's section here (never the captured JSON).
// Task 11 removed start/sit: it now runs on the neutral views and the exact kernel
// (tests/startsit_fixture.cjs); the run still exercises it through assertSuccess.
// Task 12 removed waivers: they now run on the neutral views and the kernel
// (tests/waivers_fixture.cjs); the run still exercises them through assertSuccess.
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { run, assertSuccess, SLUGS, DIR } = require("../tools/capture_inseason_baseline.cjs");
const read = f => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
const scenarios = read("scenarios.json");
for (const slug of SLUGS) {
  const legacy = read(`legacy_${slug}.json`);
  const { _header, ...expected } = read(`outputs_${slug}.json`);
  assert.match(_header, /SYNTHETIC ANALYZER PARITY/);
  const actual = run(legacy, scenarios[slug]);
  assertSuccess(slug, actual, legacy, scenarios[slug]);
  for (const section of ["trade"]) assert.deepStrictEqual(actual[section], expected[section], `${slug} ${section}`);
}
console.log("inseason_baseline_fixture: trade reproduces the committed baseline for gabagool and fam OK");
