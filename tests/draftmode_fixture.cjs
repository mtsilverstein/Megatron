// tests/draftmode_fixture.cjs — run with: node tests/draftmode_fixture.cjs
// draftmode.js is a browser IIFE: shim the globals it touches at load time,
// then read the module off the fake window.
const assert = require("assert");
global.window = {};
global.document = { addEventListener() {}, getElementById: () => null,
                    querySelector: () => null, hidden: false };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.window.Optimizer = require("../site/assets/optimizer.js");
const O = global.window.Optimizer;
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


// --- keeper drafts -----------------------------------------------------------
// Sleeper loads keepers as picks BEFORE the draft opens, at the pick numbers
// they cost. This league's 22 keepers sit at #40..#142, so the pick log has 22
// rows while picks 1-39 have not happened. Every assertion below failed before
// the fix, and each names a different way that broke the shortlist.
const KEEPERS = [40, 42, 53, 55, 69, 71, 87, 91, 95, 120, 121, 123, 128, 131,
                 133, 134, 135, 136, 139, 140, 141, 142].map(pick_no => ({ pick_no }));
const made = n => Array.from({ length: n }, (_, i) => ({ pick_no: i + 1 }));

// pickCursor: how far the draft actually got, NOT how many rows the log has.
assert.strictEqual(D.pickCursor([]), 0);
assert.strictEqual(D.pickCursor(KEEPERS), 0,           // 22 rows, zero picks made
                   "keepers ahead of the cursor must not count as picks made");
assert.strictEqual(D.pickCursor(made(30).concat(KEEPERS)), 30);
// With no keepers it must agree exactly with the old picks.length behaviour.
assert.strictEqual(D.pickCursor(made(47)), 47);
// A keeper at an EARLY number IS consumed -- nobody selects there, so the
// cursor must run straight through it rather than stopping short.
assert.strictEqual(D.pickCursor(made(4).concat([{ pick_no: 5 }, { pick_no: 6 }])), 6);
// Rows without a usable pick_no cannot move the cursor.
assert.strictEqual(D.pickCursor([{ pick_no: null }, { pick_no: 0 }, {}]), 0);

// The headline failure: at the open, seat 10's next pick is #10, not #34.
const used = D.usedPickNumbers(KEEPERS);
assert.strictEqual(D.nextPickNumber(10, 12, 15, 0, 22, "snake"), 34);   // old, wrong
assert.strictEqual(D.nextPickNumber(10, 12, 15, 0, 0, "snake", used), 10);

// A pick already spent on a keeper is not yours to plan. Seat 10 keeps at #87
// and #135, so its own list must skip exactly those two and hold 13, not 15.
const seat10 = [];
for (let at = 0; ; ) {
  const nxt = D.nextPickNumber(10, 12, 15, 0, at, "snake", used);
  if (nxt === null) break;
  seat10.push(nxt); at = nxt;
}
assert.deepStrictEqual(seat10, [10, 15, 34, 39, 58, 63, 82, 106, 111, 130, 154, 159, 178]);
assert.strictEqual(seat10.length, 13, "15 rounds minus 2 keepers");
assert.ok(!seat10.includes(87) && !seat10.includes(135), "planned a forfeited pick");
// Another seat's keeper must not remove a pick from this seat.
assert.strictEqual(D.nextPickNumber(10, 12, 15, 0, 0,
                                    "snake", new Set([40])), 10);

// openPicksBetween counts SELECTIONS, not pick numbers: a keeper slot in the
// gap needs nobody to act, so counting it would overstate the wait.
assert.strictEqual(O.openPicksBetween(0, 10, new Set()), 9);
assert.strictEqual(O.openPicksBetween(0, 10, new Set([3, 7])), 7);
assert.strictEqual(O.openPicksBetween(5, 6, new Set()), 0);   // adjacent picks

// gapToNextPick honours the same set. Seat 10 on the clock at #82: its next
// own pick is #106, because #87 is its own keeper and gets skipped. Picks
// 83-105 is 23 numbers, but #87, #91 and #95 are keeper slots nobody selects
// at, so only 20 real selections stand between.
assert.strictEqual(D.gapToNextPick(10, 12, 15, 0, 81, "snake", used), 20);
// Without keepers the old contract is unchanged.
assert.strictEqual(D.gapToNextPick(3, 12, 15, 0, 2, "snake"), 18);

// usedPickNumbers is exported, so its contract is pinned directly: a row
// without a usable pick_no must not put junk in the set, where a future caller
// would meet null/undefined instead of numbers.
assert.deepStrictEqual([...D.usedPickNumbers([{ pick_no: 3 }, { pick_no: null },
                                              { pick_no: 0 }, {}, null])], [3]);
assert.deepStrictEqual([...D.usedPickNumbers([])], []);

// planFromPicks is the whole calculation the shortlist runs on. It is pure so
// that this -- the exact thing that was broken -- is reachable from a test;
// the render path around it needs a DOM and a live session.
const SEAT10 = { slot: 10, teams: 12, rounds: 15, reversalRound: 0 };
const atOpen = D.planFromPicks(KEEPERS, SEAT10, "snake");
assert.strictEqual(atOpen.cursor, 0, "22 keeper rows are not 22 picks made");
assert.strictEqual(atOpen.next, 10, "first pick of the draft, not #34");
assert.strictEqual(atOpen.until, 9, "nine selections before yours");
assert.deepStrictEqual(atOpen.future,
  [15, 34, 39, 58, 63, 82, 106, 111, 130, 154, 159, 178]);
assert.ok(!atOpen.future.includes(87) && !atOpen.future.includes(135),
          "rollout planned a pick spent on a keeper");

// Mid-draft: 30 selections made. Old math read 52 rows and said #58 -- a whole
// round late, so the shortlist priced a pick two turns further out than real.
const mid = D.planFromPicks(made(30).concat(KEEPERS), SEAT10, "snake");
assert.strictEqual(mid.cursor, 30);
assert.strictEqual(mid.next, 34);
assert.strictEqual(mid.until, 3);

// THE MOMENT THE FORFEITED PICK COMES UP. 82 selections made: slot 10 just
// picked at #82, and its snake turn says #87 next -- but #87 is the pick it
// spent on Skattebo, so the real next turn is #106. This is the only state
// that separates "skips your keeper pick" from "happens not to hit one", and
// it is the state the tool will actually be in during round 8.
const atForfeit = D.planFromPicks(made(82).concat(KEEPERS), SEAT10, "snake");
assert.strictEqual(atForfeit.cursor, 82);
assert.strictEqual(atForfeit.next, 106, "planned #87, a pick spent on a keeper");
// #83-#105 is 23 numbers, but #87, #91 and #95 are keeper slots nobody
// selects at -- so 20 real selections stand between, not 23.
assert.strictEqual(atForfeit.until, 20);
assert.ok(!atForfeit.future.includes(135), "still planning the R12 keeper pick");

// Every seat in this league keeps at least one, so the forfeit is per-seat,
// not global. Slot 8 keeps exactly one (#128) and must lose exactly that pick.
const seat8 = D.planFromPicks(KEEPERS, { slot: 8, teams: 12, rounds: 15, reversalRound: 0 },
                              "snake");
assert.strictEqual(seat8.next, 8);
assert.strictEqual(seat8.future.length, 13, "15 rounds minus its 1 keeper");
assert.ok(!seat8.future.includes(128), "slot 8 planned the pick it kept at");
// ...and it must NOT lose slot 10s keeper picks.
assert.ok(seat8.future.includes(89) && seat8.future.includes(137),
          "another seat's keepers removed picks from this one");

// A draft with no keepers at all must be untouched by any of this.
const plain = D.planFromPicks(made(9), SEAT10, "snake");
assert.strictEqual(plain.cursor, 9);
assert.strictEqual(plain.next, 10);
assert.strictEqual(plain.until, 0, "on the clock");
assert.strictEqual(plain.future.length, 14);

// Past your last pick there is nothing to plan.
assert.strictEqual(D.planFromPicks(made(180), SEAT10, "snake"), null);

// --- whose pick is it -------------------------------------------------------
// An autodrafted pick carries NO picked_by. In a measured mock of this league
// 145 of the 158 non-keeper picks looked like this, so a roster keyed off
// picked_by loses every player the clock took while you were away -- and then
// the shortlist recommends the slot that player already fills.
const AUTO = { draft_slot: 10, player_id: "a", picked_by: null,
               metadata: { position: "RB" } };
const BYHAND = { draft_slot: 10, player_id: "b", picked_by: "u1",
                 metadata: { position: "WR" } };
const KEEP10 = { draft_slot: 10, player_id: "c", picked_by: "u1", is_keeper: true,
                 metadata: { position: "TE" } };
const OTHER = { draft_slot: 3, player_id: "d", picked_by: "u2",
                metadata: { position: "QB" } };
const OTHERAUTO = { draft_slot: 3, player_id: "e", picked_by: null,
                    metadata: { position: "QB" } };
const MINE_LOG = [AUTO, BYHAND, KEEP10, OTHER, OTHERAUTO];

// With the seat known, an autodrafted pick is still yours.
assert.deepStrictEqual(D.myPicks(MINE_LOG, 10, "u1").map(p => p.player_id),
                       ["a", "b", "c"], "autodrafted pick was not counted as yours");
// ...and another seat is never yours, however it was picked.
assert.ok(!D.myPicks(MINE_LOG, 10, "u1").some(p => p.draft_slot !== 10));
assert.deepStrictEqual(D.myPicks(MINE_LOG, 3, "u1").map(p => p.player_id), ["d", "e"],
                       "seat wins over picked_by");
// Without a seat there is only picked_by, which is why it stays the fallback.
assert.deepStrictEqual(D.myPicks(MINE_LOG, null, "u1").map(p => p.player_id), ["b", "c"]);
assert.deepStrictEqual(D.myPicks(MINE_LOG, null, "u2").map(p => p.player_id), ["d"]);
// Neither seat nor user: nothing is knowably yours.
assert.deepStrictEqual(D.myPicks(MINE_LOG, null, null), []);
assert.deepStrictEqual(D.myPicks(null, 10, "u1"), []);
// Slot 0 / negative is not a seat and must not match a falsy draft_slot.
assert.deepStrictEqual(D.myPicks(MINE_LOG, 0, "u1").map(p => p.player_id), ["b", "c"]);

// rosterStateFromPicks: what the panel shows. An autodrafted pick must land
// in BOTH the "mine" set the optimizer reads and the roster counts on screen,
// or the tool advises you to fill a slot the clock already filled for you.
const rsAuto = D.rosterStateFromPicks(MINE_LOG, 10, "u1");
assert.deepStrictEqual([...rsAuto.mine].sort(), ["a", "b", "c"]);
assert.strictEqual(rsAuto.counts.RB, 1, "autodrafted RB missing from the roster count");
assert.strictEqual(rsAuto.counts.WR, 1);
assert.strictEqual(rsAuto.counts.TE, 1, "a keeper is on your roster too");
assert.strictEqual(rsAuto.counts.QB, 0, "another seat's QB was counted as yours");
assert.strictEqual(rsAuto.myPickCount, 3);
// Every pick in the log is struck from the board, whoever made it.
assert.strictEqual(rsAuto.drafted.size, 5);
// A position the board does not model falls to "other" rather than vanishing.
const rsK = D.rosterStateFromPicks(
  [{ draft_slot: 10, player_id: "k", metadata: { position: "K" } }], 10, "u1");
assert.strictEqual(rsK.counts.other, 1);
// Without a seat it degrades to picked_by, not to everything.
assert.deepStrictEqual([...D.rosterStateFromPicks(MINE_LOG, null, "u1").mine].sort(),
                       ["b", "c"]);
assert.deepStrictEqual([...D.rosterStateFromPicks(null, 10, "u1").mine], []);

// --- the K/DST slots the board cannot fill ----------------------------------
// This league starts 1 K and 1 D/ST, and the board models neither, so the
// shortlist can never suggest them. Two consecutive mock drafts ended with 15
// skill players and both slots empty -- eight of ten starters, all season.
const skill = (pos, slot = 10) => ({ draft_slot: slot, player_id: pos + Math.random(),
                                     metadata: { position: pos } });
const roster = (n, slot = 10) => Array.from({ length: n }, () => skill("RB", slot));
const LATE = { K: [{ name: "Brandon Aubrey" }, { name: "Jason Myers" }],
               DST: [{ name: "Seattle Defense" }] };

// 15-round league. With 11 picks held there are 4 left and both slots open,
// so the warning is due; with 10 held (5 left) it is not yet.
assert.ok(D.lateSlotNeed(roster(11), 10, 15, "u1", LATE), "no warning with 4 picks left");
assert.strictEqual(D.lateSlotNeed(roster(10), 10, 15, "u1", LATE), null);

// It names both slots, counts the picks left, and offers ADP-ranked names.
const need2 = D.lateSlotNeed(roster(12), 10, 15, "u1", LATE);
assert.deepStrictEqual(need2.need, ["K", "D/ST"]);
assert.strictEqual(need2.roundsLeft, 3);
assert.deepStrictEqual(need2.K, ["Brandon Aubrey", "Jason Myers"]);
assert.deepStrictEqual(need2.DST, ["Seattle Defense"]);

// A slot already filled drops out, and the names for it stop being offered.
const withK = roster(11).concat([skill("K")]);
const need1 = D.lateSlotNeed(withK, 10, 15, "u1", LATE);
assert.deepStrictEqual(need1.need, ["D/ST"]);
assert.deepStrictEqual(need1.K, [], "kept nagging about a slot already filled");
assert.deepStrictEqual(need1.DST, ["Seattle Defense"]);

// Both filled: silence.
assert.strictEqual(
  D.lateSlotNeed(roster(11).concat([skill("K"), skill("DEF")]), 10, 15, "u1", LATE), null);

// ANOTHER SEAT'S kicker is not yours. Keying this off the pick log without
// the seat filter would silence the warning as soon as anyone drafted one.
const theirs = roster(11).concat([skill("K", 3), skill("DEF", 3)]);
assert.ok(D.lateSlotNeed(theirs, 10, 15, "u1", LATE), "another seat filled your slots");

// An autodrafted kicker still counts as yours (no picked_by on it).
const autoK = roster(11).concat([{ draft_slot: 10, player_id: "k",
                                   picked_by: null, metadata: { position: "K" } }]);
assert.deepStrictEqual(D.lateSlotNeed(autoK, 10, 15, "u1", LATE).need, ["D/ST"]);

// Degrades rather than throwing when the board carries no late_slots block.
const bare = D.lateSlotNeed(roster(12), 10, 15, "u1", null);
assert.deepStrictEqual(bare.need, ["K", "D/ST"]);
assert.deepStrictEqual(bare.K, []);
assert.strictEqual(D.lateSlotNeed(roster(12), 10, NaN, "u1", LATE), null);

// --- the "these all project the same lineup" message -------------------------
// The optimizer now zeroes `cost` inside its resolution band (4.3247 points,
// the model's measured MAE). This message makes a much stronger claim than
// that -- "none of them changes your season total" -- so it must read the RAW
// deficit. Keyed off cost, it would fire for any slate that happened to fit in
// one band, including gaps this panel used to call meaningful.
{
  const DM = window.DraftMode;
  const row = (cost, rawCost) => ({ cost, rawCost });

  // A genuinely flat slate: nothing separates them even before banding.
  assert.strictEqual(DM.isFlatSlate([row(0, 0), row(0, 0.2)], 1), true);

  // THE REGRESSION. Costs are all zeroed by the band, but the real spread is
  // 1.98 points -- over the panel's own 1-point threshold.
  assert.strictEqual(DM.isFlatSlate([row(0, 0), row(0, 1.98)], 1), false,
                     "claimed a flat slate for a 1.98-point spread");

  // Falls back to cost for a shortlist built before rawCost existed.
  assert.strictEqual(DM.isFlatSlate([{ cost: 0 }, { cost: 3 }], 1), false);
  assert.strictEqual(DM.isFlatSlate([{ cost: 0 }, { cost: 0.1 }], 1), true);

  assert.strictEqual(DM.isFlatSlate([], 1), false, "an empty slate is not flat");
}

// --- the K/DST panel must not name players who are gone ----------------------
// Found by GPT-5.6-sol in the pre-draft audit, confirmed on the real mock: at
// pick #130 the panel offered Brandon Aubrey, Jason Myers and Ka'imi Fairbairn
// -- drafted at #78, #114 and #113 -- plus three defenses taken at #93, #108
// and #86. Six suggestions, none available, at the one moment the shortlist
// deliberately cannot help.
{
  const DM = window.DraftMode;
  const pick = (pos, first, last, pick_no) =>
    ({ pick_no, metadata: { position: pos, first_name: first, last_name: last } });

  const log = [pick("K", "Brandon", "Aubrey", 78),
               pick("DEF", "Seattle", "Seahawks", 93),
               pick("DEF", "Los Angeles", "Rams", 73)];
  const taken = DM.lateSlotTaken(log);

  const ks = ["Brandon Aubrey", "Jason Myers", "Cam Little"];
  assert.deepStrictEqual(DM.lateSlotAvailable(ks, "K", taken),
                         ["Jason Myers", "Cam Little"], "a drafted kicker survived the filter");

  const ds = ["Seattle Defense", "LA Rams Defense", "Denver Defense"];
  assert.deepStrictEqual(DM.lateSlotAvailable(ds, "DST", taken),
                         ["Denver Defense"], "a drafted defense survived the filter");

  // The two pairs that could collide are exactly the ones the board spells out.
  const laTaken = DM.lateSlotTaken([pick("DEF", "Los Angeles", "Rams", 1)]);
  assert.deepStrictEqual(
    DM.lateSlotAvailable(["LA Rams Defense", "LA Chargers Defense"], "DST", laTaken),
    ["LA Chargers Defense"], "taking the Rams removed the Chargers");
  const nyTaken = DM.lateSlotTaken([pick("DEF", "New York", "Jets", 1)]);
  assert.deepStrictEqual(
    DM.lateSlotAvailable(["NY Jets Defense", "NY Giants Defense"], "DST", nyTaken),
    ["NY Giants Defense"], "taking the Jets removed the Giants");

  // Filter BEFORE slicing to three, or the list empties exactly when the top of
  // the ADP board has gone.
  // 12 of his 15 picks made, so 3 left for 2 empty slots -- inside the window.
  const seat = [];
  for (let i = 0; i < 12; i++) {
    seat.push({ pick_no: 100 + i, draft_slot: 10, metadata: { position: "RB" } });
  }
  const gone = [pick("K", "A", "One", 2), pick("K", "B", "Two", 3), pick("K", "C", "Three", 4)];
  const need = DM.lateSlotNeed(seat.concat(gone), 10, 15, "u",
    { K: [{ name: "A One" }, { name: "B Two" }, { name: "C Three" },
          { name: "D Four" }, { name: "E Five" }], DST: [] });
  assert.ok(need, "the warning should be showing");
  assert.deepStrictEqual(need.K, ["D Four", "E Five"],
                         "sliced before filtering, so the list came back empty");
}

// --- the wait line must not manufacture urgency -------------------------------
// waitCost forces the candidate's positional successor into the lineup, which
// is the wrong question when the model expects him to LAST. At pick #10 the
// panel charged 23 points for waiting on Chase Brown while predicting he would
// survive -- and he did, going at #16.
{
  const DM = window.DraftMode;
  const entry = extra => Object.assign({
    player: { name: "Chase Brown", position: "RB", vorp: 40, adp: 20 },
    points: 100, cost: 0, rawCost: 0, role: "RB1",
    nextBest: { name: "Kenneth Walker III" }, waitCost: 23,
    adpDelta: 0, byeClash: false, survivesToNext: true,
  }, extra);

  const survives = DM.renderPick(entry(), 0);
  assert.ok(!/wait →/.test(survives),
            "printed a wait cost for a player it expects to last");
  assert.ok(/still there/.test(survives), "did not say he is expected to last");

  const doomed = DM.renderPick(entry({ survivesToNext: false }), 0);
  assert.ok(/wait →/.test(doomed), "dropped the wait cost for a player who will be gone");
  assert.ok(/Kenneth Walker III/.test(doomed), "lost the successor's name");
}

// --- an edited pick must not leave the panel stale ----------------------------
// Sleeper lets a commissioner edit or undo a pick, so the log is not
// append-only and a length check cannot see a swap.
{
  const DM = window.DraftMode;
  const a = [{ pick_no: 1, player_id: "x" }, { pick_no: 2, player_id: "y" }];
  const swapped = [{ pick_no: 1, player_id: "x" }, { pick_no: 2, player_id: "ZZZ" }];
  const appended = a.concat([{ pick_no: 3, player_id: "z" }]);
  assert.strictEqual(DM.pickSignature(a), DM.pickSignature(a.slice()),
                     "signature is not stable for identical input");
  assert.notStrictEqual(DM.pickSignature(a), DM.pickSignature(swapped),
                        "a same-length edit was invisible");
  assert.notStrictEqual(DM.pickSignature(a), DM.pickSignature(appended));
  assert.strictEqual(DM.pickSignature([]), DM.pickSignature([]));
}

// --- the flat message reads the widest gap, not the last row ------------------
{
  const DM = window.DraftMode;
  // Tiebreaks reorder within the top band, so rawCost is not monotonic: the
  // real pick #106 shortlist ended at 2.835 with a maximum of 3.894.
  // The real pick #106 shortlist ended at 2.835 with a maximum of 3.894 -- both
  // over the threshold, so that shape cannot tell the two readings apart. The
  // discriminating case is a LOW last row hiding a wide gap above it, which is
  // exactly what tie-breaking inside the top band produces.
  const hidden = [{ cost: 0, rawCost: 0 }, { cost: 0, rawCost: 3.894 },
                  { cost: 0, rawCost: 0.5 }];
  assert.strictEqual(DM.isFlatSlate(hidden, 1), false,
                     "read the last row and called a 3.894 spread flat");
  const genuinely = [{ cost: 0, rawCost: 0 }, { cost: 0, rawCost: 0.4 },
                     { cost: 0, rawCost: 0.2 }];
  assert.strictEqual(DM.isFlatSlate(genuinely, 1), true,
                     "a genuinely flat slate stopped being reported flat");
}
console.log("draftmode_fixture: OK");
