const assert = require("node:assert/strict");
const M = require("../site/assets/waivermode.js");
const board = require("../site/data/draft.json");
const id = "1376245373244301312";
const league = { league_id: id, season: "2026", status: "in_season", total_rosters: 12, settings: { waiver_type: 2 },
  scoring_settings: { ...board.league.sleeper_scoring, fum: 0 },
  roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN"] };
assert.doesNotThrow(() => M.validateContract(board, league));
assert.throws(() => M.validateContract(board, { ...league, total_rosters: 13 }), /League size changed/);
assert.throws(() => M.validateContract(board, { ...league, settings: { waiver_type: 1 } }), /FAAB/);
assert.throws(() => M.validateContract(board, { ...league, scoring_settings: { ...league.scoring_settings, pass_td: 4 } }), /Scoring changed/);
assert.throws(() => M.validateContract(board, { ...league, scoring_settings: { ...league.scoring_settings, rec_bonus: 1 } }), /Scoring changed/);
assert.throws(() => M.validateContract(board, { ...league, season: "2027" }), /seasons differ/);
assert.throws(() => M.validateContract(board, { ...league, status: "drafting" }), /draft must be complete/);
assert.throws(() => M.validateContract(board, { ...league, roster_positions: league.roster_positions.slice(1) }), /Roster settings changed/);
assert.throws(() => M.validateContract({ ...board, league: { ...board.league, slug: "espnfam" } }, league), /Gabagool only/);
(async () => {
  const calls = [];
  const get = async path => {
    calls.push(path);
    if (path === `/league/${id}`) return league;
    if (path === `/league/${id}/rosters`) return [{ roster_id: 9, owner_id: "owner", co_owners: ["helper"] }];
    if (path === "/user/Test%20User") return { user_id: "helper" };
    if (path === `/league/${id}/transactions/1`) return [];
    throw new Error("unexpected request " + path);
  };
  const result = await M.loadWorld({ username: "Test User", board, week: 1, get });
  assert.equal(result.rosterId, 9);
  assert.equal(calls.length, 4);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  await assert.rejects(M.loadWorld({ username: "", board, week: 1, get }), /username/);
  await assert.rejects(M.loadWorld({ username: "Test User", board, week: 1.5, get }), /integer/);
  await assert.rejects(M.loadWorld({ username: "Test User", board, week: 1,
    get: async path => path.startsWith("/user/") ? { user_id: "outsider" } : get(path) }), /uniquely match/);
  console.log("waivermode_fixture: scoring, roster, season, ownership and read-only loading guards OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
