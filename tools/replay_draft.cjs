// tools/replay_draft.cjs — replay a real Sleeper draft through the shipped tool.
//
//   node tools/replay_draft.cjs --draft <draft_id> --slot 10
//   node tools/replay_draft.cjs --picks saved.json --slot 10 --board site/data/draft.json
//
// WHY THIS EXISTS. Draft mode renders a shortlist in a browser and then the
// draft moves on, leaving nothing to check it against. This reconstructs the
// board exactly as it stood at each of your picks and asks the SHIPPED
// optimizer what it would have said, so a completed draft becomes a test of
// the tool rather than an anecdote about it.
//
// It loads site/assets/{optimizer,draftmode}.js rather than reimplementing
// them, for the same reason tools/draft_sim.cjs does: a reimplementation
// verifies a copy, and the copy is where a check stops being evidence. The
// pick arithmetic in particular comes from draftmode's own planFromPicks, so a
// replay that agrees with reality is evidence about the code the browser ran.
//
// WHAT IT CANNOT TELL YOU. Nothing about whether the projections are right --
// both sides are scored on the same board. It measures whether the tool was
// followed, and what following it cost or saved on our own numbers. Only
// tools/draft_sim.cjs --worlds has an answer key.
"use strict";
const fs = require("fs");
const path = require("path");

// draftmode.js is a browser IIFE; shim the globals it touches at load time,
// exactly as tests/draftmode_fixture.cjs does.
if (typeof global.window === "undefined") global.window = {};
if (typeof global.document === "undefined") {
  global.document = { addEventListener() {}, getElementById: () => null,
                      querySelector: () => null, hidden: false };
}
if (typeof global.localStorage === "undefined") {
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
}
const SITE = path.join(__dirname, "..", "site", "assets");
const O = require(path.join(SITE, "optimizer.js"));
// Wire it onto the shim EXPLICITLY rather than trusting optimizer.js's own
// UMD side effect. That side effect runs once, at first require: anything
// that loaded optimizer.js before the `window` above existed leaves
// window.Optimizer undefined, and require's cache means loading it again
// here does not set it. draftmode.js's openPicksBetween now delegates
// through window.Optimizer, so the miss surfaces as a TypeError inside
// planFromPicks -- on the first pick of the replay, not at load.
global.window.Optimizer = O;
require(path.join(SITE, "draftmode.js"));
const DM = global.window.DraftMode;

const API = "https://api.sleeper.app/v1";
let seq = 0;
async function get(p) {
  const sep = p.includes("?") ? "&" : "?";
  const res = await fetch(`${API}${p}${sep}_=${Date.now()}-${++seq}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${p} -> HTTP ${res.status}`);
  return res.json();
}

/* THE ONE THING THIS FILE MUST GET RIGHT. A keeper is off the board from pick
   1, whatever pick NUMBER he cost -- this league's keepers sit at #40..#142.
   Filtering the log by pick_no alone leaves every keeper apparently draftable,
   so the replay cheerfully "recommends" a kept player in round 1 to a seat
   that could never have had him. The first run of this replay did exactly
   that and reported 3/13 agreement with 504 VORP left on the table; the truth
   was 12/13 and 9. Keepers are gone always; everyone else is gone once their
   pick number has passed. */
function stateBefore(ordered, pickNo) {
  return ordered.filter(x => x.is_keeper || x.pick_no < pickNo);
}

/* Replay one seat. Pure: no IO and no network, so the reconstruction rules are
   testable offline. `players` must already carry value_points. */
function replaySeat({ players, picks, slot, teams, rounds, reversalRound = 0,
                      type = "snake" }) {
  const bySleeper = {};
  for (const p of players) if (p.sleeper_id) bySleeper[String(p.sleeper_id)] = p;
  const ordered = (picks || []).slice().sort((a, b) => a.pick_no - b.pick_no);
  const seat = { slot, teams, rounds, reversalRound };
  const look = pk => bySleeper[String(pk.player_id)] || null;

  const rows = [];
  for (const pk of ordered) {
    if (pk.draft_slot !== slot || pk.is_keeper) continue;
    const before = stateBefore(ordered, pk.pick_no);
    const gone = new Set(before.map(x => String(x.player_id)));
    const available = players.filter(p => !gone.has(String(p.sleeper_id)));
    const held = before.filter(x => x.draft_slot === slot).map(look).filter(Boolean);
    const plan = DM.planFromPicks(before, seat, type);
    const shortlist = O.recommend({
      available, myPlayers: held, pickNo: pk.pick_no,
      futurePicks: plan ? plan.future : [],
      // The pick NUMBERS between your turns are not all selections: keepers
      // sit on 22 of them in this league. Without `usedPicks` the replay
      // reasons over the phantom horizon the browser was fixed to stop
      // using, so it would grade the shipped tool against arithmetic the
      // shipped tool no longer does.
      usedPicks: plan ? plan.used : null,
    });
    const took = look(pk);
    const top = shortlist.length ? shortlist[0].player : null;
    rows.push({
      round: pk.round, pick_no: pk.pick_no,
      planned_next: plan ? plan.next : null,
      // A replay whose own pick arithmetic disagrees with the real draft is
      // not evidence about anything, so this is reported rather than assumed.
      plan_matches_reality: plan ? plan.next === pk.pick_no : false,
      // What the seat already held going into this pick. Reported because it
      // is what the optimizer was reasoning from -- a recommendation only
      // makes sense against the roster it was made for.
      held: held.map(p => `${p.position} ${p.name}`),
      took: took
        ? { name: took.name, position: took.position, vorp: took.vorp || 0 }
        : { name: null, position: null, vorp: 0, off_board: true },
      tool: top ? { name: top.name, position: top.position, vorp: top.vorp || 0 } : null,
      agreed: !!(top && took && top.player_id === took.player_id),
      alternatives: shortlist.slice(1, 4).map(r => `${r.player.position} ${r.player.name}`),
    });
  }
  return rows;
}

function summarize(rows) {
  const n = rows.length;
  const agreed = rows.filter(r => r.agreed).length;
  const gap = rows.reduce((a, r) => a + ((r.tool ? r.tool.vorp : 0) - r.took.vorp), 0);
  return {
    picks: n, agreed,
    agreement_rate: n ? +(agreed / n).toFixed(3) : null,
    vorp_left_on_table: +gap.toFixed(1),
    // Loud, because a false value voids the whole replay.
    pick_math_matches_reality: n > 0 && rows.every(r => r.plan_matches_reality),
  };
}

function parseArgs(argv) {
  const a = { draft: null, picks: null, board: "site/data/draft.json",
              slot: null, out: null, teams: 12, rounds: 15, reversal: 0 };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, ""), v = argv[i + 1];
    if (k in a) a[k] = ["slot", "teams", "rounds", "reversal"].includes(k) ? Number(v) : v;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.draft && !args.picks) {
    console.error("usage: node tools/replay_draft.cjs (--draft <id> | --picks <file>) "
      + "--slot <n> [--board site/data/draft.json] [--out <file>]");
    process.exit(1);
  }
  if (!Number.isInteger(args.slot)) throw new Error("--slot is required");
  const board = JSON.parse(fs.readFileSync(args.board, "utf8"));
  let picks, teams = args.teams, rounds = args.rounds;
  let reversal = args.reversal, type = "snake";
  if (args.draft) {
    const [d, p] = await Promise.all([get(`/draft/${args.draft}`),
                                      get(`/draft/${args.draft}/picks`)]);
    picks = p;
    type = d.type || "snake";
    if (d.settings) {
      teams = d.settings.teams || teams;
      rounds = d.settings.rounds || rounds;
      reversal = d.settings.reversal_round || 0;
    }
  } else {
    picks = JSON.parse(fs.readFileSync(args.picks, "utf8"));
  }

  const players = O.withValuePoints(board.players)
    .filter(p => Number.isFinite(O.seasonValue(p)));
  const rows = replaySeat({ players, picks, slot: args.slot, teams, rounds,
                            reversalRound: reversal, type });
  if (!rows.length) throw new Error(`no non-keeper picks found for slot ${args.slot}`);
  const s = summarize(rows);

  console.log(`REPLAY — slot ${args.slot}, ${s.picks} picks, ${teams}x${rounds} `
    + `${type}${reversal ? ` (reversal R${reversal})` : ""}\n`);
  for (const r of rows) {
    const t = r.took;
    console.log(`R${String(r.round).padStart(2)} pk${String(r.pick_no).padStart(3)}  `
      + `TOOK ${((t.position || "?") + " " + (t.name || "(not on board)")).padEnd(26)} `
      + `vorp ${String(t.vorp.toFixed(0)).padStart(5)}`);
    if (r.agreed) {
      console.log(`${" ".repeat(20)}^ the tool would have said the same`);
    } else if (r.tool) {
      const d = r.tool.vorp - t.vorp;
      console.log(`${" ".repeat(20)}TOOL ${(r.tool.position + " " + r.tool.name).padEnd(26)} `
        + `vorp ${String(r.tool.vorp.toFixed(0)).padStart(5)}   (${d >= 0 ? "+" : ""}${d.toFixed(0)})`);
      if (r.alternatives.length) {
        console.log(`${" ".repeat(20)}     then: ${r.alternatives.join(", ")}`);
      }
    }
    if (!r.plan_matches_reality) {
      console.log(`${" ".repeat(20)}!! pick math said #${r.planned_next}, reality #${r.pick_no}`);
    }
  }
  console.log(`\nagreed on ${s.agreed}/${s.picks} (${(s.agreement_rate * 100).toFixed(0)}%)`);
  console.log(`VORP left on the table: ${s.vorp_left_on_table}`);
  console.log(`pick math matched the real draft everywhere: ${s.pick_math_matches_reality}`);
  if (!s.pick_math_matches_reality) {
    console.log("  ^ THIS VOIDS THE REPLAY: a reconstruction that picks at the wrong"
      + "\n    numbers was not looking at the board you saw.");
  }
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify({ slot: args.slot, summary: s, rows }, null, 1));
    console.log(`\nwrote ${args.out}`);
  }
}

module.exports = { replaySeat, summarize, stateBefore };
if (require.main === module) {
  main().catch(e => { console.error(String(e.message || e)); process.exit(1); });
}
