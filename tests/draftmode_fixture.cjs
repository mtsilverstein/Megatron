// tests/draftmode_fixture.cjs — run with: node tests/draftmode_fixture.cjs
// draftmode.js is a browser IIFE: shim the globals it touches at load time,
// then read the module off the fake window.
const assert = require("assert");
global.window = {};
global.document = { addEventListener() {}, getElementById: () => null,
                    querySelector: () => null, hidden: false };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
require("../site/assets/draftmode.js");
const D = global.window.DraftMode;

// nextPickNumber: 12-team snake, slot 3 -> picks #3, #22, #27, #46, #51 ...
// (values below were verified against the shipped implementation)
assert.strictEqual(D.nextPickNumber(3, 12, 15, 0, 0, "snake"), 3);
assert.strictEqual(D.nextPickNumber(3, 12, 15, 0, 2, "snake"), 3);
assert.strictEqual(D.nextPickNumber(3, 12, 15, 0, 3, "snake"), 22);

// gapToNextPick: picks BETWEEN the selection on the clock and your next pick.
// On the clock at #3 (2 picks made): #22 is next -> 18 picks in between.
// NOTE this is nonzero ON THE CLOCK -- the whole point of the fix.
assert.strictEqual(D.gapToNextPick(3, 12, 15, 0, 2, "snake"), 18);
// On the clock at #22 (21 made): next is #27 -> 4 in between (turn-of-snake).
assert.strictEqual(D.gapToNextPick(3, 12, 15, 0, 21, "snake"), 4);
// Just past the turn, on the clock at #27 (22 made): next is #46 -> 18.
assert.strictEqual(D.gapToNextPick(3, 12, 15, 0, 22, "snake"), 18);
// A 1-round draft has no pick after your first -> null
assert.strictEqual(D.gapToNextPick(3, 12, 1, 0, 2, "snake"), null);
// Invalid inputs propagate null (same guard as nextPickNumber)
assert.strictEqual(D.gapToNextPick(0, 12, 15, 0, 2, "snake"), null);

// --- seatFromPicks: your seat read off the pick log ----------------------
// Mock drafts have no league behind them and can publish no `draft_order`,
// but Sleeper stamps every pick with `draft_slot` -- so one pick of yours is
// enough. This is what kept the shortlist blank through a whole mock.
const LOG = [
  { pick_no: 1, draft_slot: 1, picked_by: "them" },
  { pick_no: 2, draft_slot: 2, picked_by: "me" },
  { pick_no: 3, draft_slot: 3, picked_by: "other" },
];
assert.strictEqual(D.seatFromPicks(LOG, "me"), 2);
assert.strictEqual(D.seatFromPicks(LOG, "nobody"), null);   // hasn't picked yet
assert.strictEqual(D.seatFromPicks([], "me"), null);
assert.strictEqual(D.seatFromPicks(LOG, null), null);       // no username given
assert.strictEqual(D.seatFromPicks(null, "me"), null);
// A malformed slot must not be mistaken for a seat -- slot 0 is not a seat,
// and a string would sail through nextPickNumber's Number.isInteger guard as
// null, silently blanking the panel again.
assert.strictEqual(D.seatFromPicks([{ draft_slot: 0, picked_by: "me" }], "me"), null);
assert.strictEqual(D.seatFromPicks([{ draft_slot: "4", picked_by: "me" }], "me"), null);
assert.strictEqual(D.seatFromPicks([{ picked_by: "me" }], "me"), null);

// --- shortlistBlocker: never fail silently -------------------------------
// Each blocked state must name the ONE thing that unblocks it. A null return
// is the only case where the panel is allowed to render a shortlist.
const seat = (o) => Object.assign(
  { userId: "me", slot: 4, teams: 12, rounds: 15, reversalRound: 0 }, o);
assert.strictEqual(D.shortlistBlocker(seat(), []), null);           // all known
const noUser = D.shortlistBlocker(seat({ userId: null }), []);
assert.ok(/username/i.test(noUser), noUser);
// Seat unknown reads differently before and after the draft is under way:
// before, you wait; after, one pick of your own fixes it.
const preDraft = D.shortlistBlocker(seat({ slot: null }), []);
const midDraft = D.shortlistBlocker(seat({ slot: null }), LOG);
assert.ok(/first pick/i.test(preDraft), preDraft);
assert.ok(/first pick/i.test(midDraft), midDraft);
assert.notStrictEqual(preDraft, midDraft);
for (const missing of [{ teams: 0 }, { rounds: 0 }]) {
  const msg = D.shortlistBlocker(seat(missing), LOG);
  assert.ok(/teams \/ rounds/.test(msg), msg);
}
// Precedence: with nothing known, the username is the first thing to fix.
assert.strictEqual(
  D.shortlistBlocker(seat({ userId: null, slot: null, teams: 0 }), []), noUser);

// --- syncLabel: "live" has to be a claim the tool can back up -------------
// Sleeper sends no Cache-Control and sits behind a CDN that served a repeat
// request from a shared cache entry (Age: 22072). A board can therefore be
// several picks behind while calling itself live, so the label carries the
// age and turns loud once the poll chain has plainly stopped delivering.
const T = 1_000_000;
assert.strictEqual(D.syncLabel(T, 0, ""), "connecting…");     // nothing yet
assert.strictEqual(D.syncLabel(T, 0, "boom"), "boom");        // error before first sync
assert.strictEqual(D.syncLabel(T, T, ""), "live · synced 0s ago");
assert.strictEqual(D.syncLabel(T + 3000, T, ""), "live · synced 3s ago");
// 12s = four missed polls: the threshold, and it must fire ON it, not past it.
assert.strictEqual(D.syncLabel(T + 11_000, T, ""), "live · synced 11s ago");
assert.ok(/NOT UPDATING/.test(D.syncLabel(T + 12_000, T, "")));
assert.ok(/60s ago/.test(D.syncLabel(T + 60_000, T, "")));
// An error keeps the age visible rather than replacing it -- "reconnecting"
// alone doesn't say whether the board is 3s or 5min out of date.
assert.strictEqual(D.syncLabel(T + 9000, T, "reconnecting… (HTTP 500)"),
                   "reconnecting… (HTTP 500) · last synced 9s ago");
// A clock that jumps backwards (NTP, sleep/wake) must not print a negative age.
assert.strictEqual(D.syncLabel(T - 5000, T, ""), "live · synced 0s ago");

console.log("draftmode_fixture: OK");
