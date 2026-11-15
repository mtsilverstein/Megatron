// tests/league_input_fixture.cjs — run with: node tests/league_input_fixture.cjs
// The one box's pure helpers (connect-flow spec §5.1, §5.3). Synthetic ids only.
const assert = require("node:assert/strict");
const FC = require("../site/assets/app.js");
const P = FC.parseLeagueInput;
const X = "123456789012345678";
assert.equal(P(X), X);
assert.equal(P(` https://sleeper.com/leagues/${X}/team?x=1 `), X);
assert.equal(P(`https://sleeper.com/leagues/${X}/team`), X);
assert.equal(P(`sleeper.com/leagues/${X}`), X);
assert.equal(P(`https://m.sleeper.com/leagues/${X}/matchup`), X);
assert.equal(P("https://www.sleeper.com/leagues/42"), "42");
assert.equal(P("https://evilsleeper.com/leagues/42"), null);
assert.equal(P(`https://sleeper.com.evil.example/leagues/${X}`), null);
assert.equal(P("https://sleeper.com/users/abc"), null);
assert.equal(P("user_a"), null);
assert.equal(P(""), null);
assert.equal(P(null), null);
const F = FC.leagueFormatLabel;
const lg = o => ({ total_rosters: 12, scoring_settings: { rec: 1 }, roster_positions: ["QB", "RB", "WR", "TE", "FLEX", "BN"], settings: { waiver_type: 2 }, ...o });
assert.equal(F(lg()), "12 teams · PPR · FAAB");
assert.equal(F(lg({ total_rosters: 10, scoring_settings: { rec: 0.5 }, roster_positions: ["QB", "SUPER_FLEX", "BN"], settings: { waiver_type: 0 } })),
  "10 teams · Half-PPR · Superflex · Rolling waivers");
assert.equal(F(lg({ scoring_settings: {} })), "12 teams · Standard · FAAB");
assert.equal(F(lg({ scoring_settings: { rec: 0 } })), "12 teams · Standard · FAAB");
assert.equal(F(lg({ scoring_settings: { rec: 0.25 } })), "12 teams · 0.25-pt PPR · FAAB");
assert.equal(F(lg({ settings: { waiver_type: 1 } })), "12 teams · PPR");
assert.equal(F(lg({ total_rosters: undefined, settings: {} })), "PPR");
assert.equal(F(null), "");
console.log("league_input_fixture: OK");
