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
  ["drop cost unassessed", { ...rowBase, lineupGain:3, signal:{strength:"modeled",guidance:"no bid suggested; the dropped player's rest-of-season cost is not priced, so assess the drop cost independently before any move"}, dropCost:{status:"unassessed",label:"drop cost unassessed: the rest-of-season change is not priced for this swap, so no spend guidance is offered"}, bid:{low:null,high:null,tier:"drop cost unassessed",canAfford:true,status:"no bid suggested: drop cost unassessed, rest-of-season value is not priced",label:"heuristic, not calibrated and not a win probability"} }],
]) {
  const t = M.rowText(row, faab);
  for (const s of [t.gain, t.bid, t.bidNote, t.why, t.exportLine]) assert.doesNotMatch(s, /\$|null|undefined/, `${name}: ${s}`);
  assert.equal(t.bid, row.bid.status);
  assert.match(t.exportLine, new RegExp(`; ${row.bid.status.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; dropping B`));
}
// Only open-slot adds carry a priced range; the analyzer never prices a required drop.
const priced = M.rowText({ ...rowBase, drop:null, rosterCost:"uses an open roster spot; future roster flexibility is not priced", dropCost:{status:"open_slot",label:"no drop required; future roster flexibility is not priced"}, lineupGain:3, signal:{strength:"modeled",guidance:"heuristic bid range"}, bid:{low:2,high:5,tier:"useful",canAfford:true,status:null,label:"heuristic, not calibrated and not a win probability"} }, faab);
assert.equal(priced.bid, "$2–$5"); assert.equal(priced.gain, "+3.00 pts"); assert.match(priced.exportLine, /DROP none; .*; modeled; heuristic bid \$2–\$5; uses an open roster spot/);
const weakRolling = M.rowText({ ...rowBase, bid:null, signal:{strength:"weak",guidance:"research only: no priority claim suggested; assess the drop cost independently before any move"} }, rolling);
assert.equal(weakRolling.bid, "No priority claim suggested"); assert.doesNotMatch(weakRolling.exportLine, /\$|null|free-agent/);
assert.match(weakRolling.exportLine, /^ADD A; DROP B; \+0\.40 \(week 2 projection\); WEAK SIGNAL; research only: no priority claim suggested; assess the drop cost independently before any move; dropping B/);
const heldRolling = M.rowText({ ...rowBase, lineupGain:3, bid:null, dropCost:{status:"unassessed",label:"drop cost unassessed: the rest-of-season change is not priced for this swap, so no spend guidance is offered"}, signal:{strength:"modeled",guidance:"research only: no priority claim suggested; the dropped player's rest-of-season cost is not priced, so assess the drop cost independently before any move"} }, rolling);
assert.equal(heldRolling.bid, "No priority claim suggested"); assert.equal(heldRolling.gain, "+3.00 pts · drop cost unassessed");
assert.match(heldRolling.exportLine, /; DROP COST UNASSESSED; research only: no priority claim suggested; .*; dropping B .*; drop cost unassessed: the rest-of-season change is not priced for this swap/);
assert.doesNotMatch(heldRolling.exportLine, /\$|null|Set claim order|; modeled;|preseason/);
const openSlot = M.rowText({ ...rowBase, drop:null, rosterCost:"uses an open roster spot; future roster flexibility is not priced", dropCost:{status:"open_slot",label:"no drop required; future roster flexibility is not priced"}, bid:null, signal:{strength:"modeled",guidance:"rank by value and roster need"} }, rolling);
assert.equal(openSlot.bid, "Set claim order in Sleeper"); assert.match(openSlot.exportLine, /DROP none; .*; modeled; rank by value and roster need; uses an open roster spot/);
// Priced rows print the split; net-negative rows print both numbers and never a dollar.
const pricedDrop = M.rowText({ ...rowBase, lineupGain:11, rosterCost:"dropping B forfeits 0.00 projected lineup points over weeks 2–3; A adds 14.00 in his place",
  dropCost:{status:"priced",label:"priced: rest-of-season lineup change over weeks 2–3, assuming participation",addContributes:14,dropForfeits:0,rosDelta:14,futureWeeks:2,endWeek:3},
  signal:{strength:"modeled",guidance:"heuristic bid range",moveValue:25,basis:"move",perWeekGain:8.33},
  bid:{low:11,high:20,tier:"impact",canAfford:true,status:null,label:"heuristic, not calibrated and not a win probability"} }, faab);
assert.equal(pricedDrop.gain, "+11.00 pts this week · ROS +14.00");
assert.equal(pricedDrop.bid, "$11–$20");
assert.equal(pricedDrop.why, "impact · board value estimate; not a FAAB price");
assert.equal(pricedDrop.dropCostNote, "priced: rest-of-season lineup change over weeks 2–3, assuming participation");
assert.match(pricedDrop.exportLine, /^ADD A; DROP B; \+11\.00 \(week 2 projection\); ROS \+14\.00 \(wk 2–3\); modeled; heuristic bid \$11–\$20; dropping B forfeits 0\.00/);
const negative = M.rowText({ ...rowBase, lineupGain:2, rosterCost:"dropping B forfeits 18.00 projected lineup points over weeks 2–3; A adds 0.00 in his place",
  dropCost:{status:"priced",label:"priced: rest-of-season lineup change over weeks 2–3, assuming participation",addContributes:0,dropForfeits:18,rosDelta:-18,futureWeeks:2,endWeek:3},
  signal:{strength:"modeled",guidance:"no bid suggested; dropping B forfeits 18.00 rest-of-season lineup points against 0.00 from A",moveValue:-16,basis:"move",perWeekGain:-5.33},
  bid:{low:null,high:null,tier:"drop costs more than the add returns",canAfford:true,status:"no bid suggested: dropping B forfeits 18.00 rest-of-season lineup points against 0.00 from A",label:"heuristic, not calibrated and not a win probability"} }, faab);
assert.equal(negative.gain, "+2.00 pts this week · ROS −18.00 · drop costs more than the add returns");
assert.equal(negative.bid, "no bid suggested: dropping B forfeits 18.00 rest-of-season lineup points against 0.00 from A");
for (const s of [negative.gain, negative.bid, negative.bidNote, negative.why, negative.exportLine]) assert.doesNotMatch(s, /\$|null|undefined|wrong/);
assert.match(negative.exportLine, /; ROS −18\.00 \(wk 2–3\); DROP COSTS MORE THAN ADD RETURNS; no bid suggested: dropping B/);
const negativeRolling = M.rowText({ ...rowBase, lineupGain:2, bid:null, dropCost:{status:"priced",label:"x",addContributes:0,dropForfeits:18,rosDelta:-18,futureWeeks:2,endWeek:3},
  signal:{strength:"modeled",guidance:"research only: no priority claim suggested; dropping B forfeits 18.00 rest-of-season lineup points against 0.00 from A",moveValue:-16,basis:"move",perWeekGain:-5.33} }, rolling);
assert.equal(negativeRolling.bid, "No priority claim suggested"); assert.doesNotMatch(negativeRolling.exportLine, /Set claim order/);
// Unassessed rows with a reason keep the reason visible.
const reasoned = M.rowText({ ...rowBase, lineupGain:3, signal:{strength:"modeled",guidance:"no bid suggested; the dropped player's rest-of-season cost is not priced, so assess the drop cost independently before any move",basis:"this_week",perWeekGain:3,moveValue:null},
  dropCost:{status:"unassessed",label:"drop cost unassessed: the rest-of-season change is not priced for this swap, so no spend guidance is offered",reason:"A has no rest-of-season projection"},
  bid:{low:null,high:null,tier:"drop cost unassessed",canAfford:true,status:"no bid suggested: drop cost unassessed — A has no rest-of-season projection",label:"heuristic, not calibrated and not a win probability"} }, faab);
assert.equal(reasoned.gain, "+3.00 pts · drop cost unassessed");
assert.equal(reasoned.dropCostNote, "drop cost unassessed: the rest-of-season change is not priced for this swap, so no spend guidance is offered — A has no rest-of-season projection");
assert.doesNotMatch(reasoned.exportLine, /ROS/);
// Open slot with a priced add shows the ROS contribution; without one, nothing extra.
const openPriced = M.rowText({ ...rowBase, drop:null, lineupGain:8, rosterCost:"uses an open roster spot; A adds 4.00 over weeks 2–3; roster flexibility is not priced",
  dropCost:{status:"open_slot",label:"no drop required; roster flexibility is not priced",addContributes:4,rosDelta:4,futureWeeks:2,endWeek:3},
  signal:{strength:"modeled",guidance:"heuristic bid range",basis:"move",moveValue:12,perWeekGain:4}, bid:{low:4,high:10,tier:"useful",canAfford:true,status:null,label:"heuristic, not calibrated and not a win probability"} }, faab);
assert.equal(openPriced.gain, "+8.00 pts this week · ROS +4.00");
assert.match(openPriced.exportLine, /DROP none; \+8\.00 \(week 2 projection\); ROS \+4\.00 \(wk 2–3\); modeled; heuristic bid \$4–\$10; uses an open roster spot/);
// Evaluation text is built from the payload block, never typed.
assert.deepEqual(M.evaluationText(null), ["no measured evaluation for this league's scoring"]);
assert.deepEqual(M.evaluationText({ source:"models/diagnostics/remaining_matrix_gabagool.json", baseline:"mean league-scored production in the last four recorded pre-origin games", seasons:[2023,2024,2025], origins:[5,9],
  horizons:[{horizon:1,model_mae:4.612,baseline_mae:4.815,paired_forecasts:1817},{horizon:8,model_mae:4.8,baseline_mae:4.987,paired_forecasts:1834}], limitation:"Dependent windows.", scoring_scope:"evaluated under gabagool scoring, which matches this league" }), [
  "Measured on 2023–2025 (origins week 5 and 9) against mean league-scored production in the last four recorded pre-origin games:",
  "1 week ahead: model MAE 4.61 vs baseline 4.82 (1,817 paired forecasts)",
  "8 weeks ahead: model MAE 4.80 vs baseline 4.99 (1,834 paired forecasts)",
  "Horizons beyond 8 weeks are not measured; errors are over players who recorded a game.",
  "evaluated under gabagool scoring, which matches this league",
  "Dependent windows.",
]);
// Older payloads without forecast_players/missing_actuals omit the parenthetical
// (asserted above); a current payload with those fields includes it, keyed to
// the horizon-1 row, and a malformed numeric field renders "n/a" without throwing.
assert.deepEqual(M.evaluationText({ baseline:"x", seasons:[], origins:[],
  horizons:[{horizon:1,model_mae:null,baseline_mae:4.815,paired_forecasts:1817,forecast_players:3701,missing_actuals:1857},
            {horizon:2,model_mae:4.452,baseline_mae:4.722,paired_forecasts:1791,forecast_players:3650,missing_actuals:1830}] }), [
  "Measured on the evaluation seasons against x:",
  "1 week ahead: model MAE n/a vs baseline 4.82 (1,817 paired forecasts)",
  "2 weeks ahead: model MAE 4.45 vs baseline 4.72 (1,791 paired forecasts)",
  "Horizons beyond 2 weeks are not measured; errors are over players who recorded a game (1,817 of 3,701 forecasts at 1 week ahead had an outcome).",
]);
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
