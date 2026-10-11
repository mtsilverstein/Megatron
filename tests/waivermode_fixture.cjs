// tests/waivermode_fixture.cjs — run with: node tests/waivermode_fixture.cjs
//
// The waiver desk controller's PURE pieces (any-league spec §7.2, §6.1, §6.2,
// §3.2, §3.4): week resolution, hydration of the league view's board with
// every roster identity, the FAAB reserve default, the row wording (owner and
// viewer), the format/banner/footnote/heuristic/simulation lines, the
// rest-of-season line (horizon, aggregation, week-18 end state), the
// evidence binding and its fallback, the ECR label, and loadWorld (no board,
// no contract). All leagues, rosters and owners are synthetic.
const assert = require("node:assert/strict");
const M = require("../site/assets/waivermode.js");
const LD = require("../site/assets/leaguedata.js");
const LL = require("../site/assets/leaguelens.js");

// ---- week resolution --------------------------------------------------------------
assert.equal(M.requestedWeek("",{season:"2026",season_type:"regular",week:2},2026),2);
assert.equal(M.requestedWeek("3",null,2026),3);
assert.equal(M.requestedWeek("",{season:"2026",season_type:"regular",week:3},"2026"),3);
assert.throws(()=>M.requestedWeek("",{season:"2025",season_type:"regular",week:2},2026),/Current NFL week/);
assert.throws(()=>M.requestedWeek("",null,2026),/Current NFL week/);
assert.throws(()=>M.requestedWeek("2.5",null,2026),/integer/);
assert.ok(!("validateContract" in M), "no published league contract any more (spec §5.3)");

// ---- hydration: the view's board plus every roster identity --------------------------
{
  const view = { scorableBySleeper: new Map([["1", "g1"]]), identityOnly: new Map([["3", "position_changed"]]) };
  const catalog = { "1":{position:"RB",team:"NYJ",injury_status:"Questionable"}, "2":{position:"K",full_name:"Kicker",team:"DEN"},
    MIN:{position:"DEF",team:"MIN"}, "3":{position:"RB",full_name:"Moved Back",team:"DEN"}, "4":{position:"LB",full_name:"Line Backer",team:null},
    "5":{position:"WR",full_name:"Free Agent",team:"DEN"} };
  const rosters = [{ roster_id:1, players:["1","2","3","404"], starters:["1","2"], reserve:["4"], taxi:[] }, { roster_id:2, players:["MIN"], starters:["MIN"] }];
  const hydrated = M.hydrateBoard({ season:2026, players:[{ sleeper_id:"1", player_id:"g1", team:"DEN", position:"RB", ros_value:40 }] }, catalog, rosters, view);
  assert.equal(hydrated.season, 2026);
  assert.equal(hydrated.players[0].team, "DEN", "retain projection provenance team (the engine's wrong-team guard reads it)");
  assert.equal(hydrated.players[0].current_team, "NYJ");
  assert.equal(hydrated.players[0].injury_status, "Questionable");
  assert.deepEqual(hydrated.players.map(p => p.sleeper_id), ["1", "2", "3", "4", "MIN"], "every roster/reserve occupant; catalog-unknown 404 and the free agent 5 are not hydrated");
  const byId = Object.fromEntries(hydrated.players.map(p => [p.sleeper_id, p]));
  assert.deepEqual([byId["3"].position, byId["3"].identity_only, byId["3"].reason, byId["3"].name], ["RB", true, "position_changed", "Moved Back"], "a position-changed player is identity-only");
  assert.deepEqual([byId["4"].position, byId["4"].team, byId["4"].identity_only], ["LB", null, true], "IDP and teamless keep ownership");
  assert.ok(hydrated.players.slice(1).every(p => p.ros_value === undefined && p.points === undefined), "identity-only rows never invent scores");
}

// ---- FAAB reserve default: 20% of the league budget, whole dollars ------------------------
const faab = budget => ({ league_id:"X", settings:{ waiver_type:2, waiver_budget:budget } });
assert.equal(M.defaultReserve(faab(0)), 0);
assert.equal(M.defaultReserve(faab(10)), 2);
assert.equal(M.defaultReserve(faab(100)), 20, "a $100 league keeps today's $20");
assert.equal(M.defaultReserve(faab(1000)), 200);
assert.equal(M.defaultReserve(faab(13)), 3, "rounded to whole dollars");
assert.equal(M.defaultReserve({ settings:{ waiver_type:0, waiver_budget:100 } }), null, "rolling: no dollars");
assert.equal(M.defaultReserve({ settings:{ waiver_type:1, waiver_budget:100 } }), null, "reverse standings: no dollars");
assert.equal(M.defaultReserve({ settings:{ waiver_type:2 } }), null, "missing budget is never assumed");
// Exhausted budget: the default is still budget-relative; remaining/spendable clamp in the engine (waivers_fixture).
assert.equal(M.defaultReserve(faab(100)), 20);

// ---- rowText: a withheld bid (low/high null) never prints dollars --------------------------
const LABEL = "rest-of-season value 40.00 (sum of weekly medians through NFL week 17, not a season median); not a FAAB price";
const rowBase = { add:{name:"A"}, drop:{name:"B"}, lineupGain:0.4, scoring:{label:"week 2 projection"}, valueEstimate:{points:40,label:LABEL}, rosterCost:"dropping B costs their rest-of-season value, which this desk does not price" };
const faabResult = { waiver:{type:"faab",guidance:"Bid ranges are budgeting heuristics, not claim-success probabilities."} };
const rolling = { waiver:{type:"rolling",guidance:"Order claims by value and roster need; current priority is context, not a claim-success probability."} };
for (const [name, row] of [
  ["weak", { ...rowBase, signal:{strength:"weak",guidance:"no bid suggested; assess the drop cost independently before any move"}, bid:{low:null,high:null,tier:"weak signal",canAfford:true,status:"no bid suggested: modeled gain is under 1.0 pt/week",label:"heuristic, not calibrated and not a win probability"} }],
  ["unaffordable", { ...rowBase, lineupGain:3, signal:{strength:"modeled",guidance:"heuristic bid range"}, bid:{low:null,high:null,tier:"useful",canAfford:false,status:"minimum bid exceeds spendable budget",label:"heuristic, not calibrated and not a win probability"} }],
  ["drop cost unassessed", { ...rowBase, lineupGain:3, signal:{strength:"modeled",guidance:"no bid suggested; the dropped player's rest-of-season cost is not priced, so assess the drop cost independently before any move"}, dropCost:{status:"unassessed",label:"drop cost unassessed: the rest-of-season change is not priced for this swap, so no spend guidance is offered"}, bid:{low:null,high:null,tier:"drop cost unassessed",canAfford:true,status:"no bid suggested: drop cost unassessed, rest-of-season value is not priced",label:"heuristic, not calibrated and not a win probability"} }],
]) {
  const t = M.rowText(row, faabResult);
  for (const s of [t.gain, t.bid, t.bidNote, t.why, t.exportLine]) assert.doesNotMatch(s, /\$|null|undefined/, `${name}: ${s}`);
  assert.equal(t.bid, row.bid.status);
  assert.match(t.exportLine, new RegExp(`; ${row.bid.status.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; dropping B`));
}
const priced = M.rowText({ ...rowBase, drop:null, rosterCost:"uses an open roster spot; future roster flexibility is not priced", dropCost:{status:"open_slot",label:"no drop required; future roster flexibility is not priced"}, lineupGain:3, signal:{strength:"modeled",guidance:"heuristic bid range"}, bid:{low:2,high:5,tier:"useful",canAfford:true,status:null,label:"heuristic, not calibrated and not a win probability"} }, faabResult);
assert.equal(priced.bid, "$2–$5"); assert.equal(priced.gain, "+3.00 pts"); assert.match(priced.exportLine, /DROP none; .*; modeled; heuristic bid \$2–\$5; uses an open roster spot/);
assert.equal(priced.why, `useful · ${LABEL}`, "the 'why' value carries the aggregation label");
const weakRolling = M.rowText({ ...rowBase, bid:null, signal:{strength:"weak",guidance:"research only: no priority claim suggested; assess the drop cost independently before any move"} }, rolling);
assert.equal(weakRolling.bid, "No priority claim suggested"); assert.doesNotMatch(weakRolling.exportLine, /\$|null|free-agent/);
assert.match(weakRolling.exportLine, /^ADD A; DROP B; \+0\.40 \(week 2 projection\); WEAK SIGNAL; research only: no priority claim suggested; assess the drop cost independently before any move; dropping B/);
const openSlot = M.rowText({ ...rowBase, drop:null, rosterCost:"uses an open roster spot; future roster flexibility is not priced", dropCost:{status:"open_slot",label:"no drop required; future roster flexibility is not priced"}, bid:null, signal:{strength:"modeled",guidance:"rank by value and roster need"} }, rolling);
assert.equal(openSlot.bid, "Set claim order in Sleeper"); assert.match(openSlot.exportLine, /DROP none; .*; modeled; rank by value and roster need; uses an open roster spot/);
const pricedDrop = M.rowText({ ...rowBase, lineupGain:11, rosterCost:"dropping B forfeits 0.00 projected lineup points over weeks 2–3; A adds 14.00 in his place",
  dropCost:{status:"priced",label:"priced: rest-of-season lineup change over weeks 2–3, assuming participation",addContributes:14,dropForfeits:0,rosDelta:14,futureWeeks:2,endWeek:3},
  signal:{strength:"modeled",guidance:"heuristic bid range",moveValue:25,basis:"move",perWeekGain:8.33},
  bid:{low:11,high:20,tier:"impact",canAfford:true,status:null,label:"heuristic, not calibrated and not a win probability"} }, faabResult);
assert.equal(pricedDrop.gain, "+11.00 pts this week · ROS +14.00");
assert.equal(pricedDrop.bid, "$11–$20");
assert.equal(pricedDrop.dropCostNote, "priced: rest-of-season lineup change over weeks 2–3, assuming participation");
assert.match(pricedDrop.exportLine, /^ADD A; DROP B; \+11\.00 \(week 2 projection\); ROS \+14\.00 \(wk 2–3\); modeled; heuristic bid \$11–\$20; dropping B forfeits 0\.00/);
const negative = M.rowText({ ...rowBase, lineupGain:2, rosterCost:"dropping B forfeits 18.00 projected lineup points over weeks 2–3; A adds 0.00 in his place",
  dropCost:{status:"priced",label:"priced: rest-of-season lineup change over weeks 2–3, assuming participation",addContributes:0,dropForfeits:18,rosDelta:-18,futureWeeks:2,endWeek:3},
  signal:{strength:"modeled",guidance:"no bid suggested; dropping B forfeits 18.00 rest-of-season lineup points against 0.00 from A",moveValue:-16,basis:"move",perWeekGain:-5.33},
  bid:{low:null,high:null,tier:"drop costs more than the add returns",canAfford:true,status:"no bid suggested: dropping B forfeits 18.00 rest-of-season lineup points against 0.00 from A",label:"heuristic, not calibrated and not a win probability"} }, faabResult);
assert.equal(negative.gain, "+2.00 pts this week · ROS −18.00 · drop costs more than the add returns");
for (const s of [negative.gain, negative.bid, negative.bidNote, negative.why, negative.exportLine]) assert.doesNotMatch(s, /\$|null|undefined|wrong/);
// Raw values, display rounding: a raw 0.0060000000000002274 gain prints as +0.01.
assert.equal(M.rowText({ ...rowBase, lineupGain:7.006 - 7, bid:null, signal:{strength:"weak",guidance:"g"} }, rolling).gain, "+0.01 pts · weak signal");
// A viewer: no bid, no claim guidance, no tier -- the owner's call.
const viewerText = M.rowText({ ...rowBase, drop:null, lineupGain:3, rosterCost:"uses an open roster spot", dropCost:{status:"open_slot"}, signal:{strength:"modeled",guidance:"heuristic bid range"}, bid:{low:2,high:5,tier:"useful",canAfford:true,status:null,label:"heuristic"} }, faabResult, { ownerOnly:true });
assert.equal(viewerText.bid, "Claim guidance is for the team's owner."); assert.equal(viewerText.bidNote, "");
assert.equal(viewerText.why, LABEL);
assert.doesNotMatch(viewerText.exportLine, /\$|heuristic bid/);
// No simulation wording anywhere (spec §6.2).
assert.doesNotMatch(JSON.stringify(pricedDrop), /sims|simulat/);

// ---- compact forms for the grouped table and the best-move card ----------------------------
assert.deepEqual([pricedDrop.gainShort, pricedDrop.tagText, pricedDrop.claim, pricedDrop.whyShort, pricedDrop.suggested],
  ["+11.00 / +14.00", "", "$11–$20 · impact tier", "ROS value 40.00", true]);
assert.deepEqual([negative.gainShort, negative.tagText, negative.claim, negative.suggested],
  ["+2.00 / −18.00", "drop costs more than the add returns", "None suggested (drop costs more than the add returns)", false]);
{
  const weakFaab = M.rowText({ ...rowBase, signal:{strength:"weak",guidance:"g"}, bid:{low:null,high:null,tier:"weak signal",canAfford:true,status:"no bid suggested: modeled gain is under 1.0 pt/week",label:"heuristic"} }, faabResult);
  assert.deepEqual([weakFaab.gainShort, weakFaab.tagText, weakFaab.claim, weakFaab.suggested], ["+0.40 / ROS not priced", "weak signal", "None suggested (weak signal)", false]);
  const broke = M.rowText({ ...rowBase, lineupGain:3, signal:{strength:"modeled",guidance:"heuristic bid range"}, bid:{low:null,high:null,tier:"useful",canAfford:false,status:"minimum bid exceeds spendable budget",label:"heuristic"} }, faabResult);
  assert.deepEqual([broke.claim, broke.suggested], ["None: minimum bid exceeds spendable budget", false], "affordability first, as the engine ranks it");
  assert.deepEqual([weakRolling.claim, weakRolling.suggested], ["No priority claim (weak signal)", false]);
  assert.deepEqual([openSlot.claim, openSlot.suggested], ["Claim: set order in Sleeper", true]);
  assert.deepEqual([viewerText.claim, viewerText.suggested], ["Owner's call", true], "a viewer sees no guidance; the suggestion flag is the engine's");
  assert.equal(M.rowText({ ...rowBase, valueEstimate:{ points:null, label:"no rest-of-season value" }, bid:null, signal:{strength:"weak",guidance:"g"} }, rolling).whyShort, "ROS value unknown (not zero)");
  for (const t of [weakFaab, broke, weakRolling, negative]) assert.doesNotMatch(t.claim, /\$/, "a withheld bid never prints dollars");
}

// ---- grouping by add: regroup only, rank order kept -------------------------------------------
{
  const r = (add, drop, gain) => ({ add:{ id:add, name:add }, drop:drop ? { id:drop, name:drop } : null, lineupGain:gain });
  const rows = [r("T", "d1", 0.4), r("T", "d2", 0.3), r("U", "d1", 0.25), r("T", "d3", 0.2), r("V", null, 0.1)];
  const groups = M.groupByAdd(rows);
  assert.deepEqual(groups.map(g => g.add.id), ["T", "U", "V"], "one group per add, in the order the add first ranks");
  assert.equal(groups[0].best, rows[0], "the best-ranked drop leads its group");
  assert.deepEqual(groups[0].others, [rows[1], rows[3]], "the other drops, in rank order");
  assert.deepEqual(groups.flatMap(g => [g.best, ...g.others]).sort((a, b) => b.lineupGain - a.lineupGain), rows, "no row created, dropped or changed");
  assert.deepEqual(M.groupByAdd([]), []);
}

// ---- best move: the top-ranked row carrying a suggestion, in one sentence -----------------------
{
  const BL = "heuristic, not calibrated and not a win probability";
  const base = { add:{ id:"t", name:"Tee End", position:"TE" }, drop:{ id:"w", name:"Wide Out", position:"WR" }, scoring:{label:"week 5 projection"},
    valueEstimate:{ points:70, label:"rest-of-season value 70.00" }, rosterCost:"r", availability:{ status:null } };
  const weakRow = { ...base, lineupGain:0.36, dropCost:{ status:"priced", label:"priced", rosDelta:5.59, dropForfeits:1.55, addContributes:7.14, futureWeeks:12, endWeek:17 },
    signal:{ strength:"weak", thresholdPerWeek:1, moveValue:5.95, guidance:"no bid suggested; assess the drop cost independently before any move" },
    bid:{ low:null, high:null, tier:"weak signal", canAfford:true, status:"no bid suggested: modeled gain is under 1.0 pt/week", label:BL } };
  const goodRow = { ...base, add:{ id:"q", name:"Quinn Back", position:"RB" }, drop:null, lineupGain:0.2,
    dropCost:{ status:"open_slot", label:"no drop required", rosDelta:30, addContributes:30, futureWeeks:12, endWeek:17 },
    signal:{ strength:"modeled", thresholdPerWeek:1, moveValue:30.2, guidance:"heuristic bid range" },
    bid:{ low:4, high:10, tier:"useful", canAfford:true, status:null, label:BL } };
  // FAAB: every option weak -> the plain no-claim lead, then the closest option.
  const allWeak = M.bestMove({ rows:[weakRow], result:faabResult });
  assert.equal(allWeak.text, "No claim recommended this week — no available player improves your lineup by 1+ pt/week. Closest option: Add Tee End (TE), drop Wide Out — +0.36 pts this week, +5.59 rest of season.");
  assert.equal(allWeak.claim, "Bid: none suggested (weak signal).");
  // FAAB: a lower-ranked row carries a bid -> it is the best move, no lead.
  const faabBest = M.bestMove({ rows:[weakRow, goodRow], result:faabResult });
  assert.equal(faabBest.row, goodRow);
  assert.equal(faabBest.text, "Add Quinn Back (RB), no drop needed (open roster spot) — +0.20 pts this week, +30.00 rest of season.");
  assert.equal(faabBest.claim, `Bid: $4–$10 (useful tier; ${BL}).`);
  // Viewer: no bid or claim guidance; "this team's", never "your".
  const viewing = M.bestMove({ rows:[weakRow], result:faabResult, ownerOnly:true });
  assert.equal(viewing.claim, "Claim guidance is for the team's owner.");
  assert.match(viewing.text, /improves this team's lineup/);
  // Rolling: claim vs. don't, and the current priority.
  const rollingResult = { waiver:{ type:"rolling", priority:2, guidance:"Order claims by value and roster need; current priority is context, not a claim-success probability." } };
  const strip = row => ({ ...row, bid:null });
  assert.equal(M.bestMove({ rows:[strip(weakRow), strip(goodRow)], result:rollingResult }).claim,
    "Claim: suggested — rank it by value and roster need when you set claim order in Sleeper. Current waiver priority: 2 (context, not a claim-success probability).");
  assert.equal(M.bestMove({ rows:[strip(weakRow)], result:rollingResult }).claim, "Claim: none suggested (weak signal). Current waiver priority: 2 (context, not a claim-success probability).");
  assert.equal(M.bestMove({ rows:[strip(goodRow)], result:{ waiver:{ type:"reverse_standings", priority:null } } }).claim,
    "Claim: suggested — rank it by value and roster need when you set claim order in Sleeper. Reverse-standings priority is not modeled.");
  // Withheld for another reason than weakness: the guardrail lead.
  const heldRow = { ...weakRow, signal:{ ...weakRow.signal, strength:"modeled" }, dropCost:{ status:"unassessed", label:"u", reason:"x" },
    bid:{ ...weakRow.bid, tier:"drop cost unassessed" } };
  assert.match(M.bestMove({ rows:[heldRow], result:faabResult }).text, /^No claim recommended this week — no option clears the spend guardrails\. Closest option: Add Tee End/);
  // No positive move, a withheld desk, a filtered-out position, a note.
  assert.deepEqual(M.bestMove({ rows:[], result:{ ...faabResult, rows:[] } }),
    { empty:true, text:"No claim recommended this week — no positive modeled lineup swap under the current protections. Do not spend simply because budget remains.", claim:"" });
  assert.equal(M.bestMove({ rows:[], result:{ ...faabResult, rows:[], recommendationBlock:"withheld: stale data" } }).text, "withheld: stale data");
  assert.match(M.bestMove({ rows:[], result:{ ...faabResult, rows:[goodRow] }, position:"QB" }).text, /^No claim option at QB this week/);
  assert.equal(M.bestMove({ rows:[goodRow], result:null, note:"Best ball" }).text, "Best ball");
  for (const b of [allWeak, faabBest, viewing]) assert.doesNotMatch(b.text + b.claim, /null|undefined|NaN/);
}

// ---- signal badges: only what the research radar already derived ------------------------------
{
  const radar = { position:"RB", roleFlags:["snap share and opportunity share both increased", "8+ carries and 40%+ of tracked team carries"], adds:149590, drops:16205,
    sameTeam:["Lead Back"], byeCover:[13], status:"Questionable" };
  assert.deepEqual(M.signalBadges(radar).map(b => b.text), ["Usage rising", "Carry volume", "Trending add", "Same-team RB", "Bye cover", "Questionable"]);
  assert.equal(M.signalBadges(radar)[2].title, "Sleeper 24h adds 149590 / drops 16205 (platform-wide, not this league)", "raw counts move to the title");
  assert.deepEqual(M.signalBadges(null, "OUT").map(b => [b.text, !!b.warn]), [["OUT", true]], "no radar entry: only the engine's own injury tag");
  assert.deepEqual(M.signalBadges(null, null), []);
  assert.deepEqual(M.signalBadges({ roleFlags:[], adds:null, drops:5, sameTeam:[], byeCover:[] }), [], "not listed among adds is not a trending add");
}

// ---- context lines: format line, banner, footnotes, heuristics, simulation note ------------
const SIM_OFF = "Simulation is off: the 2025-season test failed (on synthetic 15-player rosters), and the per-format 2026 test reports in January 2027.";
{
  const lens = LL.classify({ rec:1, pass_td:4, pass_int_td:-2, bonus_fd_wr:0.5, pass_2pt:2 });
  const view = { lens, disclosures: LL.disclosures(lens) };
  const format = { text:"Format: 12-team 1QB PPR, 6-pt pass TD — in the 2026 format test (results January 2027)" };
  const lines = M.contextLines({ format, view, waiverType:2 });
  assert.deepEqual(lines, [
    format.text,
    "Your league also scores bonus_fd_wr, which these projections leave out; rankings may be off for your league.",
    "Pick-sixes use an average rate, not a forecast.",
    "Not projected: pass_2pt (rare events).",
    "Weak signal: 1-point threshold in your league's points (a heuristic); a gain under it gets no bid or priority claim.",
    "FAAB bid bands: 2-point threshold in your league's points (a heuristic) and 5-point threshold in your league's points (a heuristic); not calibrated and not a win probability.",
    SIM_OFF,
  ]);
  const rollingLines = M.contextLines({ format:{ text:"Format: not in the format test" }, view:{ disclosures:{ banner:null, footnotes:[] } }, waiverType:0 });
  assert.deepEqual(rollingLines, ["Format: not in the format test", "Weak signal: 1-point threshold in your league's points (a heuristic); a gain under it gets no bid or priority claim.", SIM_OFF], "no FAAB bands without FAAB");
  assert.equal(M.COPY.simulationOff, SIM_OFF);
  assert.equal(M.COPY.bestBall, "Best-ball scoring picks your top scorers after the games; lineup advice doesn't apply.");
}

// ---- rest-of-season line: horizon, aggregation, week-18 end state ------------------------
{
  const AGG = "sum of weekly medians through NFL week 17, not a season median", HOR = "through NFL week 17, regardless of your league's schedule";
  const fresh = { fresh:true, endWeek:17, futureWeeks:14, generatedAt:"2026-09-16T00:00:00Z", dataThrough:"2026-wk2", pricedOwned:5, unmodeledOwned:[{ id:"8", name:"WR8" }] };
  const t = M.rosText(fresh, { activeOwnedSkills:6 });
  assert.equal(t, `Rest-of-season projections: weeks 4–17; generated 2026-09-16T00:00:00Z, data through 2026-wk2; 5/6 roster players priced. No rest-of-season projection: WR8. Rest-of-season values. Horizon: ${HOR}. Totals: ${AGG}. Values assume participation; injuries and returns are not forecast.`);
  assert.match(M.rosText({ fresh:false, reason:"remaining-season projections unavailable" }, {}), new RegExp(`^Rest-of-season projections unavailable \\(remaining-season projections unavailable\\); drop costs are unassessed.*${AGG}`));
  assert.equal(M.rosText(null, {}), `Rest-of-season values. Horizon: ${HOR}. Totals: ${AGG}.`, "best ball / unknown slot: the label alone");
  const end = M.rosText({ fresh:false, reason:"no projected weeks remain" }, { remainingReason: LD.COPY.noWeeks });
  assert.equal(end, "No projected weeks remain. Rest-of-season values and drop-cost pricing are off.");
  assert.ok(end.startsWith("No projected weeks remain."), "the exact end-state copy");
}

// ---- evidence: a number only under the league's effective scoring + this model -------------
{
  const METHOD = { v:1, model:"transformer", artifacts:["models/transformer/v1"], ensemble:"mean_of_seed_quantiles", band_construction:"sign_coherent_v1", calibration:[], prior:{ method:"pooled", rate:0.09, first_season:2021, through_season:2025 } };
  const lens = LL.classify({ rec:1, pass_td:4 });
  const view = { lens, method:METHOD };
  const identity = LL.evidenceIdentity(lens.weights);
  const record = { id:"ros_mae_x", metric:"rest_of_season_points_mae", method:METHOD, effective_scoring:identity, prediction_scoring:identity,
    values:[{ horizon:1, position:"ALL", model_mae:4.6121, baseline_mae:4.8154, paired_player_forecasts:1817 }, { horizon:1, position:"QB", model_mae:7.9 }, { horizon:2, position:"ALL", model_mae:5, baseline_mae:5.5, paired_player_forecasts:900 }] };
  const FALLBACK = ["Rest-of-season accuracy: No measured evaluation for your league's scoring and this model."];
  assert.deepEqual(M.evidenceLines({ records:[record] }, view), [
    "Rest-of-season accuracy, measured under this league's scoring and this model:",
    "1 week ahead: model MAE 4.61 vs baseline 4.82 (1817 paired forecasts)",
    "2 weeks ahead: model MAE 5.00 vs baseline 5.50 (900 paired forecasts)"]);
  assert.deepEqual(M.evidenceLines({ records:[{ ...record, method:null }] }, view), FALLBACK, "today's records carry method null: fallback");
  assert.deepEqual(M.evidenceLines({ records:[record] }, { lens:LL.classify({ rec:0.5, pass_td:4 }), method:METHOD }), FALLBACK, "different scoring: fallback");
  assert.deepEqual(M.evidenceLines({ records:[record] }, { lens, method:{ ...METHOD, band_construction:"other" } }), FALLBACK, "different method: fallback");
  assert.deepEqual(M.evidenceLines({ records:[{ ...record, metric:"close_start_sit_choice_accuracy" }] }, view), FALLBACK);
  assert.deepEqual(M.evidenceLines(null, view), FALLBACK);
  assert.deepEqual(M.evidenceLines(require("./fixtures/neutral_evaluation.json"), view), FALLBACK, "the published records bind to nothing today (spec §8.9)");
}

// ---- ECR labels -------------------------------------------------------------------------------
assert.equal(M.watchlistText({ name:"N", position:"WR", ecr:41, ros_value:55.5, injury_status:"Questionable" }),
  "N · WR · preseason ECR 41 (PPR reference ranking) · rest-of-season 55.50 (sum of weekly medians through NFL week 17, not a season median) · Questionable");
assert.equal(M.watchlistText({ name:"N", position:"WR", ecr:41, ros_value:null }), "N · WR · preseason ECR 41 (PPR reference ranking)");
assert.equal(M.watchlistText({ name:"N", position:"WR", ecr:41, ros_value:null, ros_withheld:"remaining-season projections are stale (over 72 hours old)" }),
  "N · WR · preseason ECR 41 (PPR reference ranking) · rest-of-season withheld (remaining-season projections are stale (over 72 hours old))", "I1: a withheld value names its reason");

// ---- loadWorld: LiveWorld.resolve + the week's transactions + waiver type; no board ----------
const id = "900000000000000123";
const league = { league_id: id, name:"Synthetic", season: "2026", status: "in_season", total_rosters: 12, settings: { type: 0, waiver_type: 2 },
  scoring_settings: { rec: 1, pass_td: 4 }, roster_positions: ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF", "BN"] };
const NO_ANALYSIS = "Enter your Sleeper username, or choose a team to view.";
function bundleOf({ league: lg = league, rosters, userId = "helper", status = "found", extra = null,
  requestedAt = 1700000000000, fetchedAt = 1700000000750, state = { season: "2026", season_type: "regular", week: 1 } } = {}) {
  const mine = (rosters || []).filter(r => r.owner_id === userId || (r.co_owners || []).includes(userId));
  return Object.freeze({
    registry: null,
    identity: status === "anonymous" ? null : { username: "Test User", userId, displayName: "Test User" },
    league: lg, users: [], rosters, state,
    rostersRequestedAt: requestedAt, rostersFetchedAt: fetchedAt,
    myRoster: status === "found" ? mine[0] : null, myRosterStatus: status,
    viewedRosterId: null, analysisRoster: status === "found" ? mine[0] : null, analysisRole: status === "found" ? "owner" : null,
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
  const result = await M.loadWorld({ bundle: found, week: 1, get });
  assert.equal(result.rosterId, 9);
  assert.deepEqual(calls, [`/league/${id}/transactions/1`], "only the week's transactions are fetched; league/rosters/user come from the bundle");
  assert.equal(result.league, found.league); assert.equal(result.rosters, found.rosters);
  assert.deepEqual(result.transactions, [{ type: "waiver" }]);
  assert.equal(result.requestedAt, 1700000000000, "requestedAt is the bundle's PRE-request time (engine kickoff gate)");
  assert.equal(result.fetchedAt, new Date(1700000000750).toISOString(), "fetchedAt is the bundle's POST-fetch time (60 s UI expiry)");
  // A changed scoring, team count or roster shape is no refusal any more: the league is rescored (spec §8.7).
  for (const changed of [{ scoring_settings:{ rec:0.5, bonus_fd_wr:0.5 } }, { total_rosters:32 }, { roster_positions:["QB","RB","WRRB_FLEX","DL","BN"] }]) {
    calls.length = 0;
    assert.equal((await M.loadWorld({ bundle: bundleOf({ rosters, league:{ ...league, ...changed } }), week: 1, get })).rosterId, 9);
  }
  calls.length = 0;
  const cached = await M.loadWorld({ bundle: bundleOf({ rosters, extra: { week: 1, transactions: [{ type: "cached" }] } }), week: 1, get });
  assert.deepEqual(cached.transactions, [{ type: "cached" }]); assert.equal(calls.length, 0, "cached transactions: no fetch");
  const refetched = await M.loadWorld({ bundle: bundleOf({ rosters, extra: { week: 2, transactions: [{ type: "stale" }] } }), week: 1, get });
  assert.deepEqual(refetched.transactions, [{ type: "waiver" }]); assert.deepEqual(calls, [`/league/${id}/transactions/1`], "extra for another week is ignored");
  const alsoCalls = [];
  const also = await M.transactionsAlso({ league: { league_id: id } }, async path => { alsoCalls.push(path); return []; }, 3);
  assert.deepEqual(also, { week: 3, transactions: [] }); assert.deepEqual(alsoCalls, [`/league/${id}/transactions/3`]);
  await assert.rejects(M.transactionsAlso({ league: { league_id: id } }, async () => null, 3), /incomplete transaction/);
  // Reverse standings is supported now; other waiver types are refused.
  for (const waiver_type of [0, 1, 2]) assert.equal((await M.loadWorld({ bundle: bundleOf({ rosters, league:{ ...league, settings:{ type:0, waiver_type } } }), week: 1, get })).rosterId, 9);
  // Refusals, each before any fetch.
  const refuse = async (args, re) => { calls.length = 0; await assert.rejects(M.loadWorld({ week: 1, get, ...args }), re); assert.equal(calls.length, 0, `${re}: refused before fetching`); };
  await refuse({ bundle: found, week: 1.5 }, /integer/);
  await refuse({ bundle: null }, /No league session/);
  await refuse({ bundle: bundleOf({ rosters, status: "anonymous" }) }, e => e.message === NO_ANALYSIS);
  await refuse({ bundle: bundleOf({ rosters, league: { ...league, status: "drafting" } }) }, /^Error: This league is drafting, not in season\.$/);
  await refuse({ bundle: bundleOf({ rosters, league: { ...league, settings: { type: 0, waiver_type: 3 } } }) }, /rolling-priority, reverse-standings and FAAB/);
  await refuse({ bundle: bundleOf({ rosters, league: { ...league, settings: { type: 7, waiver_type: 2 } } }) }, /This league type isn't supported yet\./);
  await refuse({ bundle: bundleOf({ rosters, fetchedAt: null }) }, /timestamps/);
  await assert.rejects(M.loadWorld({ bundle: found, week: 1, get: async () => ({}) }), /incomplete transaction/);
  console.log("waivermode_fixture: week, hydration, reserve default, row wording (full and compact), grouping by add, best move, signal badges, context/ROS/evidence/ECR lines and session-bundle loading OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
