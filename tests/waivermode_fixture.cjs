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
// loadWorld reads the shared session bundle (spec §5): league, rosters and
// identity come from it, the only fetch is the week's transactions, and the
// two roster timestamps pass through untouched.
const FC = require("../site/assets/app.js");
const NO_UNIQUE = "Could not uniquely match this account to a roster in this league.";
function bundleOf({ board: b = board, league: lg = league, rosters, userId = "helper", status = "found", extra = null,
  requestedAt = 1700000000000, fetchedAt = 1700000000750, state = { season: "2026", season_type: "regular", week: 1 }, registry } = {}) {
  const mine = (rosters || []).filter(r => r.owner_id === userId || (r.co_owners || []).includes(userId));
  return Object.freeze({
    registry: registry || FC.registryFor(b.league.slug),
    identity: status === "anonymous" ? null : { username: "Test User", userId, displayName: "Test User" },
    league: lg, users: [], rosters, state,
    rostersRequestedAt: requestedAt, rostersFetchedAt: fetchedAt,
    myRoster: status === "found" ? mine[0] : null, myRosterStatus: status,
    warnings: Object.freeze([]), extra, generation: 1,
  });
}
(async () => {
  const rosters = [{ roster_id: 9, owner_id: "owner", co_owners: ["helper"] }];
  const calls = [];
  const get = async path => {
    calls.push(path);
    if (path === `/league/${id}/transactions/1`) return [{ type: "waiver" }];
    throw new Error("unexpected request " + path);
  };
  const found = bundleOf({ rosters });
  const result = await M.loadWorld({ bundle: found, board, week: 1, get });
  assert.equal(result.rosterId, 9);
  assert.deepEqual(calls, [`/league/${id}/transactions/1`], "only the week's transactions are fetched; league/rosters/user come from the bundle");
  assert.equal(result.league, found.league); assert.equal(result.rosters, found.rosters);
  assert.deepEqual(result.transactions, [{ type: "waiver" }]);
  assert.equal(result.requestedAt, 1700000000000, "requestedAt is the bundle's PRE-request time (engine kickoff gate)");
  assert.equal(result.fetchedAt, new Date(1700000000750).toISOString(), "fetchedAt is the bundle's POST-fetch time (60 s UI expiry)");
  // Transactions already fetched atomically with the rosters (Session.refresh
  // `also`) ride on bundle.extra and are used for the SAME week only.
  calls.length = 0;
  const cached = await M.loadWorld({ bundle: bundleOf({ rosters, extra: { week: 1, transactions: [{ type: "cached" }] } }), board, week: 1, get });
  assert.deepEqual(cached.transactions, [{ type: "cached" }]); assert.equal(calls.length, 0, "cached transactions: no fetch");
  const otherWeek = bundleOf({ rosters, extra: { week: 2, transactions: [{ type: "stale" }] } });
  const refetched = await M.loadWorld({ bundle: otherWeek, board, week: 1, get });
  assert.deepEqual(refetched.transactions, [{ type: "waiver" }]); assert.deepEqual(calls, [`/league/${id}/transactions/1`], "extra for another week is ignored");
  // The `also` hook: fetches this week's transactions in the refresh generation and tags the week.
  const alsoCalls = [];
  const also = await M.transactionsAlso({ league: { league_id: id } }, async path => { alsoCalls.push(path); return []; }, 3);
  assert.deepEqual(also, { week: 3, transactions: [] }); assert.deepEqual(alsoCalls, [`/league/${id}/transactions/3`]);
  await assert.rejects(M.transactionsAlso({ league: { league_id: id } }, async () => null, 3), /incomplete transaction/);
  // FAM: its own registry entry, its own league id, never Gabagool's.
  const famCalls = [];
  const famRosters = [{ roster_id: 3, owner_id: "owner", co_owners: ["helper"], settings: { waiver_position: 2 } }];
  const famResult = await M.loadWorld({ bundle: bundleOf({ board: famBoard, league: famLeague, rosters: famRosters }), board: famBoard, week: 1, get: async path => {
    famCalls.push(path);
    if (path === `/league/${famId}/transactions/1`) return [];
    throw new Error("unexpected request " + path);
  } });
  assert.equal(famResult.rosterId, 3);
  assert.ok(famCalls.every(path => !path.includes(id)), "FAM load must not query Gabagool");
  // Refusals, each before any fetch.
  const refuse = async (args, re) => { calls.length = 0; await assert.rejects(M.loadWorld({ board, week: 1, get, ...args }), re); assert.equal(calls.length, 0, `${re}: refused before fetching`); };
  await refuse({ bundle: found, week: 1.5 }, /integer/);
  await refuse({ bundle: null }, /No league session/);
  await refuse({ bundle: bundleOf({ rosters, status: "anonymous" }) }, /username/);
  const ambiguous = bundleOf({ rosters: [...rosters, { roster_id: 10, owner_id: "helper" }], status: "ambiguous" });
  await assert.rejects(M.loadWorld({ bundle: ambiguous, board, week: 1, get }), e => e.message === NO_UNIQUE);
  await assert.rejects(M.loadWorld({ bundle: bundleOf({ rosters, userId: "outsider", status: "none" }), board, week: 1, get }), e => e.message === NO_UNIQUE);
  assert.equal(calls.length, 0, "ambiguous/none: refused before fetching");
  // Registry mismatch: a FAM bundle can never feed the Gabagool board, and a
  // board whose slug maps to another league id is not supported.
  await refuse({ bundle: bundleOf({ rosters, registry: FC.registryFor("fam") }) }, /supported Sleeper league/);
  await refuse({ bundle: bundleOf({ rosters, board: famBoard, league: famLeague }), board: { ...board, league: { ...board.league, slug: "fam" } } }, /supported Sleeper league/);
  // Contract checks still run on the bundle's league.
  await refuse({ bundle: bundleOf({ rosters, league: { ...league, status: "drafting" } }) }, /draft must be complete/);
  await refuse({ bundle: bundleOf({ rosters, fetchedAt: null }) }, /timestamps/);
  await assert.rejects(M.loadWorld({ bundle: found, board, week: 1, get: async () => ({}) }), /incomplete transaction/);
  console.log("waivermode_fixture: scoring, roster, season, ownership and session-bundle loading guards OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
