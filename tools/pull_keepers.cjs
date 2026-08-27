// tools/pull_keepers.cjs — snapshot a Sleeper keeper league's locked keepers.
//
//   node tools/pull_keepers.cjs --league 1376245373244301312 \
//        --board site/data/draft.json --out data_snapshots/keepers_2026-08-27.json
//
// WHY THIS EXISTS. tools/draft_sim.cjs drafts from an empty roster against the
// full player pool. In a keeper league that is the wrong draft: some of the
// best players never reach the board, every team starts with players already
// on it, and the picks those keepers cost are gone from the order. Simulating
// the wrong pool produces confident numbers about a draft that will not happen.
//
// Keepers are recorded in Sleeper as ordinary draft picks carrying
// `is_keeper: true`, present on the draft BEFORE it starts. That is a public
// read-only endpoint, so this needs no auth and modifies nothing.
//
// The snapshot is written to disk rather than fetched at simulation time so a
// reported result is reproducible from a file, and so the sim itself stays
// offline and deterministic.
"use strict";
const fs = require("fs");
const path = require("path");

const API = "https://api.sleeper.app/v1";

// Sleeper sends no Cache-Control and sits behind a CDN; a repeated URL can be
// served from a shared entry hours old. Same defence as site/assets/sleeper.js.
let seq = 0;
async function get(p) {
  const sep = p.includes("?") ? "&" : "?";
  const res = await fetch(`${API}${p}${sep}_=${Date.now()}-${++seq}`,
                          { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${p} -> HTTP ${res.status}`);
  return res.json();
}

function parseArgs(argv) {
  const a = { league: null, board: "site/data/draft.json", out: null, draft: null };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, ""), v = argv[i + 1];
    if (k in a) a[k] = v;
  }
  return a;
}

/* Reduce raw Sleeper responses to the snapshot shape. Pure, so the mapping
   rules are testable without the network -- the same split rosters.py uses.

   `draft.draft_order` is {user_id: slot} and `slot_to_roster_id` is
   {slot: roster_id}; both are needed to say WHOSE keeper a pick is in terms a
   human can check against the league page. */
function buildSnapshot({ league, draft, picks, users, boardPlayers }) {
  const bySleeper = {};
  for (const p of boardPlayers) if (p.sleeper_id) bySleeper[String(p.sleeper_id)] = p;
  const nameOf = {};
  for (const u of users || []) nameOf[u.user_id] = u.display_name;
  const teamAt = {};
  for (const [uid, slot] of Object.entries(draft.draft_order || {})) {
    teamAt[slot] = nameOf[uid] || uid;
  }

  const keepers = [], unmapped = [];
  for (const pk of picks) {
    if (!pk.is_keeper) continue;
    const board = bySleeper[String(pk.player_id)];
    const row = {
      round: pk.round, slot: pk.draft_slot, pick_no: pk.pick_no,
      sleeper_id: String(pk.player_id),
      team: teamAt[pk.draft_slot] || null,
    };
    if (!board) {
      row.name = (pk.metadata && `${pk.metadata.first_name} ${pk.metadata.last_name}`.trim()) || null;
      row.position = (pk.metadata && pk.metadata.position) || null;
      unmapped.push(row);
      continue;
    }
    row.player_id = board.player_id;
    row.name = board.name;
    row.position = board.position;
    keepers.push(row);
  }
  keepers.sort((a, b) => a.pick_no - b.pick_no);
  return {
    league_id: league.league_id,
    league_name: league.name,
    draft_id: draft.draft_id,
    season: league.season,
    teams: (draft.settings && draft.settings.teams) || league.total_rosters,
    rounds: (draft.settings && draft.settings.rounds) || null,
    reversal_round: (draft.settings && draft.settings.reversal_round) || 0,
    start_time: draft.start_time || null,
    slot_to_team: teamAt,
    keepers,
    unmapped,
  };
}

/* A keeper we cannot place on the board is not a cosmetic gap: the sim would
   leave him in the draftable pool and let someone spend a real pick on a
   player who is already rostered, while the team that keeps him drafts with a
   pick he does not have. Both errors point the same way -- they inflate the
   pool. Refuse rather than publish a snapshot that silently does that. */
function assertAllMapped(snap) {
  if (!snap.unmapped.length) return;
  const lines = snap.unmapped.map(u =>
    `    R${u.round} pick ${u.pick_no} (${u.team}): ${u.name || "?"} `
    + `${u.position || "?"} sleeper_id=${u.sleeper_id}`).join("\n");
  throw new Error(
    `${snap.unmapped.length} of ${snap.keepers.length + snap.unmapped.length} keepers `
    + `are not on the board, so they cannot be removed from the draft pool:\n${lines}\n`
    + `  Every one of them would stay draftable in the simulation while their owner `
    + `drafts without the pick they cost. Fix the board's sleeper_id crosswalk or `
    + `drop these players before simulating.`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.league) {
    console.error("usage: node tools/pull_keepers.cjs --league <league_id> "
      + "[--board site/data/draft.json] [--out <path>]");
    process.exit(1);
  }
  const board = JSON.parse(fs.readFileSync(args.board, "utf8"));
  const league = await get(`/league/${args.league}`);
  let draftId = args.draft;
  if (!draftId) {
    const drafts = await get(`/league/${args.league}/drafts`);
    if (!drafts.length) throw new Error(`league ${args.league} has no drafts`);
    draftId = drafts[0].draft_id;
  }
  const [draft, picks, users] = await Promise.all([
    get(`/draft/${draftId}`), get(`/draft/${draftId}/picks`),
    get(`/league/${args.league}/users`),
  ]);

  const snap = buildSnapshot({ league, draft, picks, users,
                               boardPlayers: board.players });
  const nonKeeper = picks.filter(p => !p.is_keeper).length;
  if (nonKeeper) {
    console.warn(`WARNING: ${nonKeeper} non-keeper picks are already recorded — `
      + `this draft is under way, not pre-draft.`);
  }
  assertAllMapped(snap);

  const out = args.out
    || path.join("data_snapshots", `keepers_${snap.league_id}_`
        + `${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snap, null, 1));

  console.log(`${snap.league_name} (${snap.season}) — ${snap.keepers.length} keepers, `
    + `${snap.teams} teams x ${snap.rounds} rounds`);
  const perTeam = {};
  for (const k of snap.keepers) perTeam[k.team] = (perTeam[k.team] || 0) + 1;
  for (const k of snap.keepers) {
    console.log(`  R${String(k.round).padStart(2)} pick ${String(k.pick_no).padStart(3)} `
      + `slot ${String(k.slot).padStart(2)}  ${String(k.team).padEnd(15)} `
      + `${k.position} ${k.name}`);
  }
  const light = Object.entries(perTeam).filter(([, n]) => n < 2);
  if (light.length) {
    console.log(`\n  NOTE: ${light.map(([t, n]) => `${t} has ${n}`).join(", ")} — `
      + `fewer than the 2 this league allows. Either a real choice or not yet submitted.`);
  }
  console.log(`\nwrote ${out}`);
}

module.exports = { buildSnapshot, assertAllMapped };
if (require.main === module) main().catch(e => { console.error(String(e.message || e)); process.exit(1); });
