// tests/ros_fixture.cjs — run with: node tests/ros_fixture.cjs
const assert = require("node:assert/strict");
const ROS = require("../site/assets/ros.js");

let n = 0;
function check(name, fn) { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }

// Exhaustive assignment: every injective map of players onto slots that respects
// eligibility; the best total is the ground truth both solvers must match.
function bruteForce(players, slots, scoreOf) {
  let best = -Infinity;
  const used = new Array(players.length).fill(false);
  (function rec(i, total) {
    if (i === slots.length) { best = Math.max(best, total); return; }
    for (let j = 0; j < players.length; j++) {
      if (used[j]) continue;
      const v = scoreOf(players[j]);
      if (v === null || !ROS.SLOT_ELIGIBLE[slots[i]].includes(players[j].position)) continue;
      used[j] = true; rec(i + 1, total + v); used[j] = false;
    }
  })(0, 0);
  return best;
}

let seed = 11; const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const POS = ["QB", "RB", "WR", "TE"];
const SHAPES = [["QB","RB","WR","TE","FLEX"], ["QB","RB","RB","WR","WR","TE","FLEX","FLEX"], ["RB","SUPER_FLEX"], ["QB","RB","WR","TE","FLEX","SUPER_FLEX"], ["RB","FLEX"], ["QB"]];

check("lineupScore and bestLineup match exhaustive search on random rosters", () => {
  for (let t = 0; t < 300; t++) {
    const slots = SHAPES[t % SHAPES.length];
    const size = slots.length + Math.floor(rand() * 3);
    const players = Array.from({ length: size }, (_, i) => ({ id: `p${i}`, position: POS[Math.floor(rand() * 4)], pts: rand() < 0.15 ? null : Math.round(rand() * 250) / 10 }));
    const scoreOf = p => p.pts;
    const truth = bruteForce(players, slots, scoreOf);
    const score = ROS.lineupScore(players, slots, scoreOf);
    const best = ROS.bestLineup(players, slots, scoreOf);
    assert.ok(Math.abs(score - truth) < 1e-9 || (score === -Infinity && truth === -Infinity), `lineupScore ${score} vs brute ${truth} for ${slots}`);
    assert.ok(Math.abs(best.total - truth) < 1e-9 || (best.total === -Infinity && truth === -Infinity), `bestLineup ${best.total} vs brute ${truth}`);
    if (Number.isFinite(truth)) {
      assert.equal(best.starters.length, slots.length);
      assert.deepEqual(best.starters.map(s => s.slot), slots, "starters come back in slot order");
      assert.ok(best.starters.every(s => ROS.SLOT_ELIGIBLE[s.slot].includes(s.player.position)), "every starter is eligible for its slot");
      assert.equal(new Set(best.starters.map(s => s.player.id)).size, slots.length, "no player starts twice");
      assert.ok(Math.abs(best.starters.reduce((a, s) => a + s.points, 0) - best.total) < 1e-9);
    } else {
      assert.deepEqual(best.starters, []);
    }
  }
});

check("null scores are skipped, never zero", () => {
  const players = [{ id: "a", position: "RB", pts: null }, { id: "b", position: "RB", pts: 4 }];
  assert.equal(ROS.lineupScore(players, ["RB"], p => p.pts), 4);
  assert.equal(ROS.bestLineup(players, ["RB"], p => p.pts).starters[0].player.id, "b");
  assert.equal(ROS.lineupScore(players, ["RB", "RB"], p => p.pts), -Infinity);
});

check("evaluationText builds from the payload block and never throws on null fields", () => {
  assert.deepEqual(ROS.evaluationText(null), ["no measured evaluation for this league's scoring"]);
  const block = { source: "x", baseline: "mean league-scored production in the last four recorded pre-origin games", seasons: [2023, 2024, 2025], origins: [5, 9],
    horizons: [{ horizon: 1, model_mae: 4.612, baseline_mae: 4.815, paired_forecasts: 1817, forecast_players: 3701, missing_actuals: 1857 },
               { horizon: 8, model_mae: null, baseline_mae: 4.987, paired_forecasts: 1834 }], limitation: "Dependent windows.", scoring_scope: "evaluated under gabagool scoring, which matches this league" };
  const lines = ROS.evaluationText(block);
  assert.equal(lines[0], "Measured on 2023–2025 (origins week 5 and 9) against mean league-scored production in the last four recorded pre-origin games:");
  assert.equal(lines[1], "1 week ahead: model MAE 4.61 vs baseline 4.82 (1,817 paired forecasts)");
  assert.match(lines[2], /^8 weeks ahead: model MAE n\/a vs baseline 4\.99/);
  assert.match(lines[3], /^Horizons beyond 8 weeks are not measured; errors are over players who recorded a game \(1,817 of 3,701 forecasts at 1 week ahead had an outcome\)\.$/);
  assert.equal(lines[4], "evaluated under gabagool scoring, which matches this league");
  assert.equal(lines[5], "Dependent windows.");
});

console.log(`ros_fixture: ${n} groups OK`);
