const assert = require("node:assert/strict");
const M = require("../site/assets/waivermode.js");
const board = require("../site/data/draft.json");
const famBoard = require("../site/data/draft-fam.json");
const id = "1376245373244301312";
const league = { league_id: id, season: "2026", status: "in_season", total_rosters: 12, settings: { waiver_type: 2 },
  scoring_settings: { ...board.league.sleeper_scoring, fum: 0 },
  roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN"] };
assert.doesNotThrow(() => M.validateContract(board, league));
assert.throws(() => M.validateContract(board, { ...league, total_rosters: 13 }), /League size changed/);
assert.throws(() => M.validateContract(board, { ...league, settings: { waiver_type: 1 } }), /rolling-priority and FAAB/);
assert.throws(() => M.validateContract(board, { ...league, scoring_settings: { ...league.scoring_settings, pass_td: 4 } }), /Scoring changed/);
assert.throws(() => M.validateContract(board, { ...league, scoring_settings: { ...league.scoring_settings, rec_bonus: 1 } }), /Scoring changed/);
assert.throws(() => M.validateContract(board, { ...league, season: "2027" }), /seasons differ/);
assert.throws(() => M.validateContract(board, { ...league, status: "drafting" }), /draft must be complete/);
assert.throws(() => M.validateContract(board, { ...league, roster_positions: league.roster_positions.slice(1) }), /Roster settings changed/);
assert.throws(() => M.validateContract({ ...board, league: { ...board.league, slug: "espnfam" } }, league), /supported Sleeper league/);
const famId = String(famBoard.league.league_id);
const famLeague = { ...league, league_id:famId, total_rosters:famBoard.league.teams, settings:{waiver_type:0},
  scoring_settings:{...famBoard.league.sleeper_scoring}, roster_positions:["QB","RB","RB","WR","WR","TE","FLEX","FLEX","K","DEF","BN","BN","BN","BN","BN"] };
assert.doesNotThrow(() => M.validateContract(famBoard, famLeague));
assert.throws(() => M.validateContract(famBoard, famLeague, {requireFaab:true}), /requires a FAAB/);
assert.throws(() => M.validateContract(board, famLeague), /exactly match/);
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
  const famCalls=[];
  const famResult = await M.loadWorld({username:"Test User",board:famBoard,week:1,get:async path => {
    famCalls.push(path);
    if (path === `/league/${famId}`) return famLeague;
    if (path === `/league/${famId}/rosters`) return [{roster_id:3,owner_id:"owner",co_owners:["helper"],settings:{waiver_position:2}}];
    if (path === "/user/Test%20User") return {user_id:"helper"};
    if (path === `/league/${famId}/transactions/1`) return [];
    throw new Error("unexpected request " + path);
  }});
  assert.equal(famResult.rosterId,3);
  assert.ok(famCalls.every(path => !path.includes(id)), "FAM load must not query Gabagool");
  await assert.rejects(M.loadWorld({ username: "", board, week: 1, get }), /username/);
  await assert.rejects(M.loadWorld({ username: "Test User", board, week: 1.5, get }), /integer/);
  await assert.rejects(M.loadWorld({ username: "Test User", board, week: 1,
    get: async path => path.startsWith("/user/") ? { user_id: "outsider" } : get(path) }), /uniquely match/);
  console.log("waivermode_fixture: scoring, roster, season, ownership and read-only loading guards OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
