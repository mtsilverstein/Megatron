// Exercise the actual CLI in isolated processes, with tiny in-memory inputs.
const assert = require("assert");
const path = require("path");
const { execFileSync } = require("child_process");
const root = path.resolve(__dirname, "..");

function runQueue({ root, league, overrides }) {
  const fs = require("fs"), path = require("path");
  const boardPath = path.join(root, "queue-fixture-board.json");
  const picksPath = path.join(root, "queue-fixture-picks.json");
  const players = ["QB", "RB", "WR", "TE"].map((position, i) => ({
    player_id: String(i), name: "Player " + i, position,
    value_points: 100 - i, vorp: 10 - i, adp: i + 1,
  }));
  const read = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    if (file === boardPath) return JSON.stringify({ players, league });
    if (file === picksPath) return "[]";
    return read.call(this, file, ...args);
  };
  const O = require(path.join(root, "site/assets/optimizer.js"));
  const recommend = O.recommend;
  const turns = [];
  O.recommend = ctx => {
    turns.push({ at: ctx.pickNo, future: ctx.futurePicks });
    return recommend(ctx);
  };
  process.argv = [process.execPath, path.join(root, "tools/queue_cost.cjs"),
    "--board", boardPath, "--picks", picksPath, "--slot", "1", ...overrides];
  require(process.argv[1]);
  console.log("FIXTURE " + JSON.stringify({ config: O.leagueConfig(), turns }));
}

function run(league, overrides = []) {
  const script = `(${runQueue.toString()})(${JSON.stringify({ root, league, overrides })})`;
  const output = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", cwd: root });
  return JSON.parse(output.split(/\r?\n/).find(line => line.startsWith("FIXTURE ")).slice(8));
}

const fam = { teams: 10, rounds: 14, roster: { QB: 1, RB: 2, WR: 2, TE: 1 },
  flex: 1, flex_positions: ["RB", "WR", "TE"], starters: 7,
  depth_cap: { QB: 2, RB: 5, WR: 5, TE: 2 } };
const configured = run(fam);
assert.strictEqual(configured.config.FLEX_SLOTS, 1);
assert.strictEqual(configured.config.ROLLOUT_PICKS, 7);
assert.strictEqual(configured.config.DEPTH_CAP.RB, 5);
assert.strictEqual(configured.turns.length, 14);
assert.strictEqual(configured.turns[0].future[0], 20);
assert.strictEqual(configured.turns.at(-1).at, 140);

const legacy = run(undefined);
assert.strictEqual(legacy.config.FLEX_SLOTS, 2);
assert.strictEqual(legacy.config.DEPTH_CAP.RB, 6);
assert.strictEqual(legacy.turns.length, 15);
assert.strictEqual(legacy.turns[0].future[0], 24);

const overridden = run(fam, ["--teams", "8", "--rounds", "3"]);
assert.strictEqual(overridden.config.FLEX_SLOTS, 1);
assert.strictEqual(overridden.turns.length, 3);
assert.strictEqual(overridden.turns[0].future[0], 16);
assert.strictEqual(overridden.turns.at(-1).at, 17);
console.log("queue_cost fixture: 3 groups OK");
