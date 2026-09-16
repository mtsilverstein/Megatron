const assert = require("node:assert/strict");
const M = require("../site/assets/waivermode.js");
assert.equal(M.requestedWeek("",{season:"2026",season_type:"regular",week:2},2026),2);
assert.equal(M.requestedWeek("3",null,2026),3);
assert.equal(M.requestedWeek("",{season:"2026",season_type:"regular",week:3},2026),3);
assert.throws(()=>M.requestedWeek("",{season:"2025",season_type:"regular",week:2},2026),/Current NFL week/);
assert.throws(()=>M.requestedWeek("",null,2026),/Current NFL week/);
assert.throws(()=>M.requestedWeek("2.5",null,2026),/integer/);
const board = require("../site/data/draft.json");
const famBoard = require("../site/data/draft-fam.json");
const hydrated = M.hydrateBoard({players:[{sleeper_id:"1",team:"DEN",position:"RB"}]}, {
  "1":{position:"RB",team:"NYJ"}, "2":{position:"K",full_name:"Kicker",team:"DEN"},
  MIN:{position:"DEF",team:"MIN"}, "3":{position:"RB",team:"DEN"},
});
assert.equal(hydrated.players[0].team,"DEN", "retain projection provenance team");
assert.equal(hydrated.players[0].current_team,"NYJ");
assert.deepEqual(hydrated.players.map(p=>p.sleeper_id),["1","2","MIN"]);
assert.ok(hydrated.players.slice(1).every(p=>p.value_points===undefined && p.season_points===undefined), "identity-only K/DEF must not invent scores");
// rowText: a withheld bid (low/high null) must never print dollars in the table or export.
const rowBase = { add:{name:"A"}, drop:{name:"B"}, lineupGain:0.4, scoring:{label:"week 2 projection"}, valueEstimate:{label:"board value estimate; not a FAAB price"}, rosterCost:"dropping B costs their rest-of-season value, which this desk does not price" };
const faab = { waiver:{type:"faab",guidance:"Bid ranges are budgeting heuristics, not claim-success probabilities."} };
const rolling = { waiver:{type:"rolling",guidance:"Order claims by value and roster need; current priority is context, not a claim-success probability."} };
for (const [name, row] of [
  ["weak", { ...rowBase, signal:{strength:"weak",guidance:"no bid suggested; assess the drop cost independently before any move"}, bid:{low:null,high:null,tier:"weak signal",canAfford:true,status:"no bid suggested: modeled gain is under 1.0 pt/week",label:"heuristic, not calibrated and not a win probability"} }],
  ["unaffordable", { ...rowBase, lineupGain:3, signal:{strength:"modeled",guidance:"heuristic bid range"}, bid:{low:null,high:null,tier:"useful",canAfford:false,status:"minimum bid exceeds spendable budget",label:"heuristic, not calibrated and not a win probability"} }],
]) {
  const t = M.rowText(row, faab);
  for (const s of [t.gain, t.bid, t.bidNote, t.why, t.exportLine]) assert.doesNotMatch(s, /\$|null|undefined/, `${name}: ${s}`);
  assert.equal(t.bid, row.bid.status);
  assert.match(t.exportLine, new RegExp(`; ${row.bid.status.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; dropping B`));
}
const priced = M.rowText({ ...rowBase, lineupGain:3, signal:{strength:"modeled",guidance:"heuristic bid range"}, bid:{low:2,high:5,tier:"useful",canAfford:true,status:null,label:"heuristic, not calibrated and not a win probability"} }, faab);
assert.equal(priced.bid, "$2–$5"); assert.match(priced.exportLine, /; modeled; heuristic bid \$2–\$5; dropping B/);
const weakRolling = M.rowText({ ...rowBase, bid:null, signal:{strength:"weak",guidance:"research only: no priority claim suggested; assess the drop cost independently before any move"} }, rolling);
assert.equal(weakRolling.bid, "No priority claim suggested"); assert.doesNotMatch(weakRolling.exportLine, /\$|null|free-agent/);
assert.match(weakRolling.exportLine, /^ADD A; DROP B; \+0\.40 \(week 2 projection\); WEAK SIGNAL; research only: no priority claim suggested; assess the drop cost independently before any move; dropping B/);
const openSlot = M.rowText({ ...rowBase, drop:null, rosterCost:"uses an open roster spot; future roster flexibility is not priced", bid:null, signal:{strength:"modeled",guidance:"rank by value and roster need"} }, rolling);
assert.equal(openSlot.bid, "Set claim order in Sleeper"); assert.match(openSlot.exportLine, /DROP none; .*; modeled; rank by value and roster need; uses an open roster spot/);
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
