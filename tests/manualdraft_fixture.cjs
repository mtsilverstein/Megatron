/* The typed-pick path that replaces Sleeper polling on a non-Sleeper board.

   Everything downstream of this module -- the shortlist, "your turn in N", the
   K/DST banner -- is already tested against the live path. What is NEW here is
   the arithmetic that Sleeper used to hand us for free: which seat makes each
   pick, and which of them are mine. An error there is silent and total: every
   recommendation would be computed for the wrong pick number. */
const assert = require("assert");
const MD = require("../site/assets/manualdraft.js");

/* ---- snake seat arithmetic ------------------------------------------- */
// 13 teams is the case that motivated this module, and an ODD league size is
// where an off-by-one in the reversal hides: with 12 the turn lands on a
// boundary that several wrong formulas also produce.
const T = 13;
assert.strictEqual(MD.snakeSlot(1, T, "snake"), 1);
assert.strictEqual(MD.snakeSlot(13, T, "snake"), 13, "end of round 1");
assert.strictEqual(MD.snakeSlot(14, T, "snake"), 13, "the turn: seat 13 picks back-to-back");
assert.strictEqual(MD.snakeSlot(26, T, "snake"), 1, "end of round 2 comes back to seat 1");
assert.strictEqual(MD.snakeSlot(27, T, "snake"), 1, "seat 1 also picks back-to-back");
assert.strictEqual(MD.snakeSlot(40, T, "snake"), 13, "pick 40 OPENS round 4, which runs backwards");
assert.strictEqual(MD.snakeSlot(41, T, "snake"), 12, "and then walks down");
// Round 15 is ODD, so it runs forwards; the new round 16 runs backwards.
assert.strictEqual(MD.snakeSlot(183, T, "snake"), 1, "round 15 opens with seat 1");
assert.strictEqual(MD.snakeSlot(195, T, "snake"), 13, "round 15 ends on seat 13");
assert.strictEqual(MD.snakeSlot(196, T, "snake"), 13, "round 16 starts at the turn");
assert.strictEqual(MD.snakeSlot(208, T, "snake"), 1, "16-round draft ends on seat 1");

// Every seat appears exactly once per round, in both directions.
for (const round of [1, 2, 3, 8]) {
  const seats = [];
  for (let i = 0; i < T; i++) seats.push(MD.snakeSlot((round - 1) * T + i + 1, T, "snake"));
  assert.deepStrictEqual([...seats].sort((a, b) => a - b), Array.from({ length: T }, (_, i) => i + 1),
    `round ${round} must use every seat exactly once`);
  assert.deepStrictEqual(seats, round % 2 ? seats.slice().sort((a, b) => a - b)
                                          : seats.slice().sort((a, b) => b - a),
    `round ${round} must run in the correct direction`);
}

// A linear draft never reverses.
assert.strictEqual(MD.snakeSlot(14, T, "linear"), 1);
assert.strictEqual(MD.snakeSlot(26, T, "linear"), 13);

assert.strictEqual(MD.snakeSlot(0, T, "snake"), null);
assert.strictEqual(MD.snakeSlot(1, 0, "snake"), null);

/* ---- pick synthesis -------------------------------------------------- */
const entries = [
  { player_id: "s1", name: "Jahmyr Gibbs", position: "RB" },
  { player_id: "s2", name: "Ja'Marr Chase", position: "WR" },
  { player_id: null, position: "K" },                       // an unnameable pick
  { player_id: "s4", name: "A.J. Brown", position: "WR" },
];
const picks = MD.synthPicks(entries, { teams: T, type: "snake", mySlot: 3, userId: "ME" });

assert.deepStrictEqual(picks.map(p => p.pick_no), [1, 2, 3, 4], "pick numbers are the typing order");
assert.deepStrictEqual(picks.map(p => p.draft_slot), [1, 2, 3, 4]);
assert.deepStrictEqual(picks.map(p => p.round), [1, 1, 1, 1]);
assert.strictEqual(picks[2].picked_by, "ME", "seat 3 is mine, so pick 3 is mine");
assert.strictEqual(picks[0].picked_by, null);
assert.strictEqual(picks[2].player_id, "manual:3",
  "a pick the board cannot name still gets a unique id, so it can never collide");
assert.strictEqual(picks[2].metadata.position, "K",
  "position must survive: the K/DST banner reads it");
assert.deepStrictEqual(
  { first: picks[3].metadata.first_name, last: picks[3].metadata.last_name },
  { first: "A.J.", last: "Brown" }, "name splits into Sleeper's two parts");

// A one-word name must not produce an empty first_name; lateSlotTaken matches
// defences on EITHER part, so a blank one silently matches nothing.
const oneWord = MD.synthPicks([{ player_id: "d1", name: "Seattle", position: "DEF" }],
                              { teams: T, type: "snake", mySlot: 1, userId: "ME" });
assert.strictEqual(oneWord[0].metadata.first_name, "Seattle");

// The seat's picks must be exactly the ones the live path would call mine.
const long = MD.synthPicks(Array.from({ length: 40 }, (_, i) => ({ player_id: `p${i}`, name: `P ${i}` })),
                           { teams: T, type: "snake", mySlot: 13, userId: "ME" });
assert.deepStrictEqual(long.filter(p => p.picked_by === "ME").map(p => p.pick_no), [13, 14, 39, 40],
  "seat 13 picks at the turn, back-to-back");

/* ---- name resolution ------------------------------------------------- */
const board = [
  { name: "Ja'Marr Chase", position: "WR", sleeper_id: "1" },
  { name: "Justin Jefferson", position: "WR", sleeper_id: "2" },
  { name: "Jaxon Smith-Njigba", position: "WR", sleeper_id: "3" },
  { name: "Marvin Harrison Jr.", position: "WR", sleeper_id: "4" },
  { name: "A.J. Brown", position: "WR", sleeper_id: "5" },
  { name: "Chase Brown", position: "RB", sleeper_id: "6" },
  { name: "Jahmyr Gibbs", position: "RB", sleeper_id: "7" },
];
const r = (s) => MD.resolveName(s, board);

assert.strictEqual(r("Ja'Marr Chase").player.sleeper_id, "1", "exact match");
assert.strictEqual(r("jamarr chase").player.sleeper_id, "1", "punctuation and case are noise");
assert.strictEqual(r("AJ Brown").player.sleeper_id, "5", "people drop the periods");
assert.strictEqual(r("Marvin Harrison").player.sleeper_id, "4", "people drop the suffix");
assert.strictEqual(r("jefferson").player.sleeper_id, "2", "a surname alone is the common case");
assert.strictEqual(r("gibbs").player.sleeper_id, "7");

// "chase" is Ja'Marr Chase's FIRST name and Chase Brown's SURNAME. Guessing
// here would strike a player who is still on the board.
const chase = r("chase");
assert.strictEqual(chase.status, "ambiguous", "an ambiguous name must ask, never guess");
assert.ok(chase.candidates.length >= 2);

assert.strictEqual(r("smith").player.sleeper_id, "3", "unique substring still resolves");
assert.strictEqual(r("Nobody At All").status, "unknown");
assert.strictEqual(r("").status, "empty");
assert.strictEqual(r("   ").status, "empty");

/* ---- the log --------------------------------------------------------- */
const log = MD.createLog();
assert.strictEqual(log.size(), 0);
log.add({ player_id: "a", name: "One" });
log.add({ player_id: "b", name: "Two" });
assert.strictEqual(log.size(), 2);
assert.ok(log.has("a"));
assert.ok(!log.has("zz"));
assert.ok(!log.has(null), "an unnameable pick must never report as already drafted");
const popped = log.removeLast();
assert.strictEqual(popped.player_id, "b");
assert.strictEqual(log.size(), 1, "undo must free the pick number for the correct name");
assert.ok(!log.has("b"));
log.clear();
assert.strictEqual(log.size(), 0);
assert.strictEqual(log.removeLast(), null, "undo on an empty log is not an error");

console.log("manualdraft_fixture: seat arithmetic, pick synthesis, name resolution OK");

/* ---- unnameable picks keep their name ---------------------------------
   lateSlotTaken() matches drafted kickers and defences BY NAME. A "+ K"
   entry that dropped the typed name would still consume its pick number --
   the count stays right -- but the K/DST panel would go on recommending a
   kicker who is already gone, which is the one job that panel has. */
const kicker = MD.synthPicks(
  [{ player_id: null, name: "Brandon Aubrey", position: "K" },
   { player_id: null, name: "", position: "DEF" }],
  { teams: T, type: "snake", mySlot: 9, userId: "ME" });
assert.strictEqual(kicker[0].metadata.first_name, "Brandon");
assert.strictEqual(kicker[0].metadata.last_name, "Aubrey");
assert.strictEqual(kicker[0].metadata.position, "K");
assert.strictEqual(kicker[1].metadata.position, "DEF",
  "a nameless entry is still a real pick with a real position");
assert.notStrictEqual(kicker[0].player_id, kicker[1].player_id,
  "two unnameable picks must not collide into one drafted id");

console.log("manualdraft_fixture: unnameable picks retain name and position OK");

/* ---- ESPN identities and save validation ----------------------------- */
const prepared = MD.prepareBoard({ season: 2026, league: { league_id: "69827905" }, players: [
  { player_id: "espn-7", name: "Mapped Only Locally" },
  { player_id: "espn-8", sleeper_id: "sleep-8", name: "Already Mapped" },
] });
assert.strictEqual(prepared.players[0].sleeper_id, "board:espn-7");
assert.strictEqual(prepared.players[1].sleeper_id, "sleep-8");
assert.strictEqual(MD.storageKey(prepared), "megatron:manualdraft:69827905:2026");
assert.strictEqual(MD.parseSave("not json", 13, 195).status, "corrupt");

/* ---- panel persistence, edit, bulk, and conflict --------------------- */
class El {
  constructor(value = "") { this.value = value; this.hidden = false; this.textContent = ""; this.innerHTML = ""; this.handlers = {}; }
  addEventListener(kind, fn) { (this.handlers[kind] ||= []).push(fn); }
  fire(kind, extra = {}) { for (const fn of this.handlers[kind] || []) fn(Object.assign({ preventDefault() {}, target: this }, extra)); }
  focus() {}
}
function elements() {
  const names = ["panel", "status", "seat", "start", "entry", "name", "add", "addK", "addDef",
    "addOther", "undo", "resolve", "roster", "late", "shortlist", "history", "bulk", "applyBulk",
    "saveNote", "editAt", "editMode", "exportLog", "importLog", "backup"];
  return Object.fromEntries(names.map(n => [n, new El()]));
}
const mem = new Map();
global.localStorage = { getItem: k => mem.has(k) ? mem.get(k) : null,
  setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
global.confirm = () => true;
global.window = {
  DraftMode: {
    rosterStateFromPicks(picks, slot) {
      const drafted = new Set(picks.map(p => p.player_id));
      const mine = new Set(picks.filter(p => p.draft_slot === slot).map(p => p.player_id));
      return { drafted, mine, counts: { QB: 0, RB: 0, WR: 0, TE: 0, other: 0 } };
    },
    shortlistBlocker: () => "fixture stop", planFromPicks: () => null,
  },
  Optimizer: { withValuePoints: x => x, seasonValue: () => 1, openSlots: () => [] },
};
const panelBoard = MD.prepareBoard({ season: 2026, league: { league_id: "69827905", teams: 2, rounds: 3 }, players: [
  { player_id: "1", name: "Alpha Runner", position: "RB" },
  { player_id: "2", name: "Beta Catcher", position: "WR" },
  { player_id: "3", name: "Gamma Thrower", position: "QB" },
] });
let last;
const e1 = elements();
MD.initPanel({ board: panelBoard, els: e1, onUpdate: x => { last = x; } });
e1.seat.value = "1"; e1.start.fire("click");
e1.name.value = "Alpha Runner"; e1.add.fire("click");
assert.strictEqual(last.drafted.size, 1, "successful entry renders and saves");
let saved = JSON.parse(mem.get(MD.storageKey(panelBoard)));
assert.strictEqual(saved.entries[0].player_id, "board:1", "unmapped ESPN identity survives the panel");

e1.editMode.value = "insert"; e1.editAt.value = "1";
e1.name.value = "Beta Catcher"; e1.add.fire("click");
saved = JSON.parse(mem.get(MD.storageKey(panelBoard)));
assert.deepStrictEqual(saved.entries.map(x => x.name), ["Beta Catcher", "Alpha Runner"], "numbered insertion works");
e1.undo.fire("click");
saved = JSON.parse(mem.get(MD.storageKey(panelBoard)));
assert.deepStrictEqual(saved.entries.map(x => x.name), ["Alpha Runner"], "undo reverses the last insertion snapshot");

e1.editMode.value = "append"; e1.editAt.value = "";
e1.bulk.value = "Gamma Thrower\nUnknown Person"; e1.applyBulk.fire("click");
assert.strictEqual(JSON.parse(mem.get(MD.storageKey(panelBoard))).entries.length, 1,
  "an invalid bulk batch commits nothing");
e1.bulk.value = "Gamma Thrower\nK: Brandon Aubrey\nDEF: Seattle"; e1.applyBulk.fire("click");
saved = JSON.parse(mem.get(MD.storageKey(panelBoard)));
assert.strictEqual(saved.entries.length, 4);
assert.deepStrictEqual(saved.entries.slice(2).map(x => x.position), ["K", "DEF"]);

const e2 = elements(); let restoredState;
MD.initPanel({ board: panelBoard, els: e2, onUpdate: x => { restoredState = x; } });
assert.strictEqual(restoredState.drafted.size, 4, "reload restores the league-season log before rendering");
assert.strictEqual(e2.seat.value, "1");

// A second tab advances the raw revision. This stale panel must not overwrite it.
const beforeConflict = mem.get(MD.storageKey(panelBoard));
const external = JSON.parse(beforeConflict); external.revision += 1;
mem.set(MD.storageKey(panelBoard), JSON.stringify(external));
e1.name.value = "Beta Catcher"; e1.add.fire("click");
assert.strictEqual(mem.get(MD.storageKey(panelBoard)), JSON.stringify(external));
assert.match(e1.saveNote.innerHTML, /another tab|Reload/i);

// Corrupt storage is preserved byte-for-byte instead of being silently reset.
const corruptBoard = MD.prepareBoard({ season: 2027, league: { league_id: "69827905", teams: 2, rounds: 2 }, players: [] });
const corruptKey = MD.storageKey(corruptBoard); mem.set(corruptKey, "{broken");
const ec = elements(); MD.initPanel({ board: corruptBoard, els: ec, onUpdate() {} });
ec.seat.value = "1"; ec.start.fire("click");
assert.strictEqual(mem.get(corruptKey), "{broken", "corrupt save is never silently overwritten");

console.log("manualdraft_fixture: panel restore, edits, bulk atomicity, conflicts, ESPN ids OK");

/* Recovery regressions: exercise actual panel event handlers. */
const panelKey = MD.storageKey(panelBoard);
const workingStorage = global.localStorage;
const alpha = { player_id: "board:1", name: "Alpha Runner", position: "RB" };
const beta = { player_id: "board:2", name: "Beta Catcher", position: "WR" };
const backup = (seat, entries, revision = 1) => JSON.stringify({ schema: 1, revision, seat, entries });
function mount() {
  const els = elements(); let state;
  MD.initPanel({ board: panelBoard, els, onUpdate: x => { state = x; } });
  return { els, state: () => state };
}
mem.set(panelKey, backup(1, [alpha, beta]));
const recovery = mount();
recovery.els.backup.value = backup(2, [beta, alpha]);
recovery.els.importLog.fire("click");
assert.deepStrictEqual([...recovery.state().mine], ["board:1"]);
recovery.els.undo.fire("click");
assert.strictEqual(recovery.els.seat.value, "1", "Undo restores the imported seat and log together");
assert.deepStrictEqual(JSON.parse(mem.get(panelKey)).entries, [alpha, beta]);
assert.strictEqual(JSON.parse(mem.get(panelKey)).seat, 1);
assert.deepStrictEqual([...mount().state().mine], ["board:1"], "restored ownership survives reload");
recovery.els.seat.value = "2"; recovery.els.start.fire("click");
assert.deepStrictEqual([...recovery.state().mine], ["board:2"]);
recovery.els.undo.fire("click");
assert.strictEqual(recovery.els.seat.value, "1", "seat-only changes also undo atomically");

for (const detectFirst of [false, true]) {
  const stale = mount();
  const newer = backup(2, [beta], 100 + Number(detectFirst));
  mem.set(panelKey, newer);
  if (detectFirst) { stale.els.name.value = "Gamma Thrower"; stale.els.add.fire("click"); }
  stale.els.backup.value = backup(1, [alpha]); stale.els.importLog.fire("click");
  assert.strictEqual(mem.get(panelKey), newer, "Restore cannot bypass either new or established conflicts");
  assert.match(stale.els.saveNote.innerHTML, /another tab/i);
  stale.els.seat.value = "1"; stale.els.start.fire("click");
  assert.strictEqual(mem.get(panelKey), newer, "seat changes cannot bypass conflicts");
}

ec.exportLog.fire("click");
assert.strictEqual(ec.backup.value, "{broken", "corrupt original remains exportable");
ec.backup.value = backup(1, []); ec.importLog.fire("click");
assert.strictEqual(JSON.parse(mem.get(corruptKey)).seat, 1, "explicit recovery of unchanged corrupt save works");
mem.set(panelKey, "{broken");
const corruptStale = mount();
const repairedElsewhere = backup(2, [beta]); mem.set(panelKey, repairedElsewhere);
corruptStale.els.backup.value = backup(1, [alpha]); corruptStale.els.importLog.fire("click");
assert.strictEqual(mem.get(panelKey), repairedElsewhere, "corrupt recovery cannot overwrite another tab's repair");

mem.clear();
const safeText = mount(); safeText.els.seat.value = "1"; safeText.els.start.fire("click");
safeText.els.bulk.value = '<img src=x onerror="alert(1)">'; safeText.els.applyBulk.fire("click");
assert.match(safeText.els.resolve.innerHTML, /&lt;img/);
assert.ok(!safeText.els.resolve.innerHTML.includes("<img"), "bulk errors never create user-supplied markup");
assert.strictEqual(safeText.state().drafted.size, 0);

function assertSessionOnly() {
  const session = mount();
  session.els.seat.value = "1"; session.els.start.fire("click");
  session.els.name.value = "Alpha Runner"; session.els.add.fire("click");
  assert.ok(session.state().drafted.has("board:1"), "storage failure does not stop the working board");
  session.els.exportLog.fire("click");
  assert.deepStrictEqual(JSON.parse(session.els.backup.value).entries, [alpha]);
  assert.match(session.els.saveNote.innerHTML, /session-only.*export/i);
}
global.localStorage = { getItem() { throw new Error("read denied"); }, setItem() { assert.fail("must not overwrite unreadable storage"); } };
assertSessionOnly();
Object.defineProperty(global, "localStorage", { configurable: true, get() { throw new Error("access denied"); } });
assertSessionOnly();
Object.defineProperty(global, "localStorage", { configurable: true, writable: true, value: workingStorage });
mem.set(panelKey, backup(1, []));
const beforeQuota = mem.get(panelKey);
let writes = 0;
global.localStorage = { getItem: workingStorage.getItem, setItem() { writes++; throw new Error("quota exceeded"); } };
const quota = mount();
quota.els.name.value = "Alpha Runner"; quota.els.add.fire("click");
quota.els.name.value = "Beta Catcher"; quota.els.add.fire("click");
assert.strictEqual(quota.state().drafted.size, 2, "failed saves still render all session picks");
assert.strictEqual(mem.get(panelKey), beforeQuota, "failed save preserves the previous backup");
assert.strictEqual(writes, 1, "unavailable storage stays disabled for this session");
quota.els.exportLog.fire("click");
assert.deepStrictEqual(JSON.parse(quota.els.backup.value).entries, [alpha, beta]);
assert.match(quota.els.saveNote.innerHTML, /session-only/);
global.localStorage = workingStorage;
let readFails = false;
global.localStorage = { getItem(k) { if (readFails) throw new Error("storage revoked"); return workingStorage.getItem(k); },
  setItem() { assert.fail("must not save after a failed conflict check"); } };
const revoked = mount(); readFails = true;
revoked.els.name.value = "Alpha Runner"; revoked.els.add.fire("click");
assert.ok(revoked.state().drafted.has("board:1"));
assert.match(revoked.els.saveNote.innerHTML, /session-only/);
assert.strictEqual(mem.get(panelKey), beforeQuota);
global.localStorage = workingStorage;
console.log("manualdraft_fixture: atomic recovery undo, stale restore, storage failures, escaped bulk errors OK");
