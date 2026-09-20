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
// Sleeper stub, installed BEFORE the require: draftmode.js captures
// window.Sleeper at load time. `SLEEPER` is mutated by the live-panel test at
// the bottom; every other test in this file goes nowhere near the network.
const SLEEPER = { picks: [], draft: null, league: null, user: null, calls: [] };
global.window.Sleeper = { get: async (path) => {
  SLEEPER.calls.push(path);
  if (/\/picks$/.test(path)) return SLEEPER.picks;
  // `userGate`: holds Session.identify() in its `identifying` state so a
  // fixture can look at the board DURING the lookup, not only after it.
  if (/^\/user\//.test(path)) { if (SLEEPER.userGate) await SLEEPER.userGate; return SLEEPER.user; }
  // Session.ready() reads these three beside /league/<id>; the controller
  // itself never asks for them.
  if (/^\/league\/[^/]+\/users$/.test(path)) return SLEEPER.users || [];
  if (/^\/league\/[^/]+\/rosters$/.test(path)) return SLEEPER.rosters || [];
  if (path === "/state/nfl") return SLEEPER.state || { season: "2026", season_type: "regular", week: 1 };
  if (/^\/league\//.test(path)) {
    if (SLEEPER.leagueError) throw new Error(SLEEPER.leagueError);
    return SLEEPER.league;
  }
  if (/^\/draft\//.test(path)) {
    // `draftGate`: a promise the draft fetch waits on, so a fixture can hold a
    // connect() in flight while something else happens (the identity moves).
    if (SLEEPER.draftGate) await SLEEPER.draftGate;
    if (SLEEPER.draftError) throw new Error(SLEEPER.draftError);
    // `draftFailAfter`: the first N draft fetches (counted from when it is
    // set) succeed and every later one fails -- a transient error on a
    // redundant connect, the way the identify-then-ready case needs it.
    if (SLEEPER.draftFailAfter != null && ++SLEEPER.draftFetches > SLEEPER.draftFailAfter) throw new Error("sleeper 503");
    return SLEEPER.draft;
  }
  throw new Error(`unstubbed sleeper path: ${path}`);
} };
require("../site/assets/draftmode.js");
const D = global.window.DraftMode;
// The shared session: draftmode.js reads identity from window.Session (lazily,
// so installing it after the require is fine). Its Sleeper calls go through
// the same stub, so `/user/<name>` resolves to SLEEPER.user.
const Session = require("../site/assets/session.js");
global.window.Session = Session;
Session._get(global.window.Sleeper.get);
// One storage object shared by the controller (global.localStorage) and the
// session (Session._storage), as in a browser: forget() deletes the draft
// restore record through the same store the controller rewrites it in.
const fakeStore = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null),
           setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k),
           key: i => [...m.keys()][i], get length() { return m.size; },
           has: k => m.has(k), get: k => m.get(k), set: (k, v) => m.set(k, v) };
};

const SCORING = { pass_yd: 0.04, pass_td: 6, pass_int: -2,
                  pass_int_td: -3, rec: 1 };
assert.strictEqual(D.leagueScoringError(
  { pass_yd: "0.04", pass_td: "6", pass_int: "-2",
    pass_int_td: "-3", rec: "1" }, SCORING), null);
assert.match(D.leagueScoringError({ ...SCORING, pass_td: 4 }, SCORING), /pass_td 4≠6/);
assert.match(D.leagueScoringError({ ...SCORING, pass_int_td: -2 }, SCORING),
  /pass_int_td -2≠-3/);
assert.match(D.leagueScoringError({ ...SCORING, bonus_rec_te: 0.5 }, SCORING),
  /bonus_rec_te 0.5≠0/);
assert.strictEqual(D.leagueScoringError({ ...SCORING, bonus_rec_te: 0 }, SCORING), null);
assert.strictEqual(D.leagueScoringError(SCORING, { ...SCORING, bonus_rec_te: 0 }), null);
assert.match(D.leagueScoringError(null, SCORING), /scoring_settings.*invalid/);

// Use both shipped board contracts, with the settings their real drafts
// publish. No network dependency: missing fields and standalone mocks are
// deliberate compatibility cases, not fabricated defaults.
for (const file of ["draft.json", "draft-fam.json"]) {
  const lg = require(`../site/data/${file}`).league;
  const settings = { teams: lg.teams, rounds: lg.rounds, slots_qb: 1,
    slots_rb: 2, slots_wr: 2, slots_te: 1, slots_flex: lg.flex,
    slots_k: 1, slots_def: 1, slots_bn: 5 };
  const draft = { type: "snake", league_id: lg.league_id, settings };
  assert.strictEqual(D.draftContractError(draft, lg), null);
  const strings = Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)]));
  assert.strictEqual(D.draftContractError({ ...draft, settings: strings }, lg), null);
  assert.strictEqual(D.draftContractError({ ...draft, league_id: null }, lg), null);
  assert.strictEqual(D.draftContractError({ type: "linear" }, lg), null);
  assert.strictEqual(D.draftContractError({ ...draft, settings: {} }, lg), null);
  assert.match(D.draftContractError({ ...draft, league_id: "another-league" }, lg), /different league/);
  assert.match(D.draftContractError({ ...draft, type: "auction" }, lg), /unsupported draft type: auction/);
  for (const key of ["slots_super_flex", "slots_wr_rb", "slots_wr_te", "slots_idp_flex",
                     "slots_dl", "slots_lb", "slots_db"]) {
    assert.match(D.draftContractError({ ...draft, settings: { ...settings, [key]: "1" } }, lg), /unsupported/);
    assert.strictEqual(D.draftContractError({ ...draft, settings: { ...settings, [key]: "0" } }, lg), null);
  }
  for (const key of ["slots_k", "slots_def"]) {
    for (const count of [0, 2]) {
      assert.match(D.draftContractError({ ...draft, settings: { ...settings, [key]: count } }, lg), /different lineup/);
    }
  }
}

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

/* `slack` is how many MORE picks can go to skill players before the remaining
   slots have to be filled. The banner fires with LATE_SLACK to spare, so it
   used to say "draft K + D/ST now" two picks before that was true: in a real
   FAM mock that spent picks 114 and 127 on K and D/ST and left Jakobi Meyers
   and Woody Marks (vorp -17, -18) as the last two picks, where waiting would
   have taken Wan'Dale Robinson and Rachaad White (-4, -6) instead. Same
   trigger, honest deadline. */
assert.strictEqual(D.lateSlotNeed(roster(11), 10, 15, "u1", LATE).slack, 2);
assert.strictEqual(D.lateSlotNeed(roster(12), 10, 15, "u1", LATE).slack, 1);
assert.strictEqual(D.lateSlotNeed(roster(13), 10, 15, "u1", LATE).slack, 0,
  "with exactly as many picks left as slots, there is no slack");
assert.strictEqual(
  D.lateSlotNeed(roster(11).concat([skill("K")]), 10, 15, "u1", LATE).slack, 2,
  "one slot filled frees a pick: 3 left, 1 needed");

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

// Wait on the OBSERVABLE, not on a guessed number of event-loop turns: a
// panel's render is however many async hops deep it happens to be today, and
// a fixture that encodes that depth breaks the next time a hop is added.
// Shared by every fake-DOM block below -- do not define a second copy.
const until = async (pred, what, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setImmediate(r));
  }
};

/* --- reconnecting to an UNCHANGED draft must rebuild the board -----------
   The panel renders only when the pick log's fingerprint changes. Disconnect
   clears the displayed state (state.drafted, roster, ticker); if it does not
   also clear the fingerprint, reconnecting to a log that has not moved is a
   no-op and the board sits blank -- struck players gone, roster hidden --
   under a status reading "live", until some later pick changes the log. In a
   60-second-clock draft that is a full minute of a board that is silently
   wrong, and it fires on the flow connect() documents: connect without a
   username, then Connect again WITH one to get your own picks highlighted. */
{
  const el = () => ({
    value: "", textContent: "", innerHTML: "", hidden: false, checked: false,
    open: false, addEventListener() {}, querySelectorAll: () => [],
  });
  const els = {
    connect: el(), connectId: el(), disconnect: el(), find: el(), hide: el(),
    idInput: el(), late: el(), list: el(), live: el(), note: el(),
    picksCount: el(), roster: el(), shortlist: el(), status: el(),
    ticker: el(),
  };
  const store = fakeStore();
  global.localStorage = store;
  Session._storage(store);          // cold session, no identity, listeners cleared
  // Capture the real click handlers: init() is the only thing that wires
  // connect/disconnect, and they are closure-private otherwise. Driving the
  // handlers IS driving the buttons.
  const handlers = {};
  for (const [name, node] of Object.entries(els)) {
    node.addEventListener = (ev, fn) => { if (ev === "click") handlers[name] = fn; };
  }
  const board = { players: [
    { player_id: "a", sleeper_id: "9509", name: "P1", position: "RB", adp: 1,
      bye: 5, value_points: 300, vorp: 90, position_rank: 1 },
    { player_id: "b", sleeper_id: "4034", name: "P2", position: "WR", adp: 2,
      bye: 7, value_points: 290, vorp: 85, position_rank: 1 },
  ] };
  let last = null;
  D.init({ board, els, onUpdate: (st) => { last = st; } });

  SLEEPER.draft = { draft_id: "D1", type: "snake", status: "in_progress",
                    settings: { rounds: 15, teams: 12, slots_qb: 1, slots_rb: 2,
                                  slots_wr: 2, slots_te: 1, slots_flex: 2 },
                      draft_order: {} };
  SLEEPER.picks = [
    { pick_no: 1, draft_slot: 1, player_id: "9509", picked_by: "them" },
    { pick_no: 2, draft_slot: 2, player_id: "4034", picked_by: "them" },
  ];

  // Exposed (via `var`, function-scoped in this CommonJS module) so the next
  // block can wait for this one to fully settle before it touches the SAME
  // module-singleton `cfg`/`session`/`SLEEPER` -- draftmode.js supports one
  // live session at a time by design, so two of these fixture blocks running
  // with overlapping in-flight async work would corrupt each other: the
  // second block's D.init() reassigns cfg out from under the first block's
  // still-pending connect() before it ever gets to read it back.
  var reconnectFixtureDone = (async () => {
    els.idInput.value = "D1234567";
    await handlers.connectId();
    await until(() => last && last.drafted.size === 2,
                "the first connect to strike the drafted players");

    handlers.disconnect();
    assert.strictEqual(last.drafted.size, 0, "disconnect left stale strikes");

    // Reconnect to the SAME, UNMOVED log. This is the regression.
    await handlers.connectId();
    await until(() => last.drafted.size === 2,
                "a reconnect to an unchanged draft to rebuild the board");

    /* The second entry into the same defect, and the one connect() names:
       Connect with no identity (picks strike, but none are yours), then
       identify in the league panel. There is no disconnect on this path, so
       only connect()'s own reset can clear the fingerprint -- without it the
       reconnect never re-renders and your roster never appears, which is the
       whole reason you reconnected.

       The identity now arrives through Session.onChange, and the reconnect
       must happen EXACTLY once: identify() fires twice (identity cleared,
       then resolved), and a controller that reconnected on both would run two
       full connects per identity change against a live 3-second clock. */
    assert.strictEqual(JSON.parse(store.get("fc-draft-mode:default")).userId, null,
      "an anonymous pasted-id connect stored an identity it did not have");
    assert.ok(!SLEEPER.calls.some(p => /^\/user\//.test(p)),
      "anonymous connect must not look a user up");
    SLEEPER.user = { user_id: "U1" };
    SLEEPER.draft = Object.assign({}, SLEEPER.draft, { draft_order: { U1: 2 } });
    const before = SLEEPER.calls.length;
    await Session.identify("me");
    await until(() => last.mine.size === 1,
                "identifying while connected to pick up your roster");
    const connects = SLEEPER.calls.slice(before).filter(p => p === "/draft/1234567");
    assert.strictEqual(connects.length, 1,
      `identity change reconnected ${connects.length} times, expected exactly once`);
    assert.strictEqual(last.connected, true);
    assert.deepStrictEqual(
      JSON.parse(store.get("fc-draft-mode:default")),
      { username: "me", userId: "U1", draftId: "1234567" },
      "the restore record was not rewritten with the session identity");

    /* forget() while live: the draft keeps streaming, nothing is "mine" any
       more, and the record is rewritten without an identity -- a reload must
       not resurrect the forgotten account's highlights. */
    const KEY = "fc-draft-mode:default";
    const beforeForget = SLEEPER.calls.length;
    Session.forget();
    await until(() => last.connected && last.mine.size === 0 && last.drafted.size === 2
                      && store.has(KEY),
                "forget to keep the draft live with no seat highlighted");
    const after = SLEEPER.calls.slice(beforeForget);
    assert.strictEqual(after.filter(p => p === "/draft/1234567").length, 1,
      "forget must reconnect anonymously exactly once");
    assert.ok(after.some(p => p === "/draft/1234567/picks"),
      "the pick log was not polled after forget");
    assert.strictEqual(JSON.parse(store.get(KEY)).userId, null,
      "forget left the forgotten account in the restore record");
    assert.ok(/live · synced/.test(els.status.textContent), els.status.textContent);
    // Nothing further to reconcile: a state move with the SAME identity is a no-op.
    const idle = SLEEPER.calls.length;
    Session.forget();
    await new Promise(r => setImmediate(r));
    assert.strictEqual(SLEEPER.calls.slice(idle).filter(p => p === "/draft/1234567").length, 0,
      "an unchanged identity triggered a reconnect");

    /* forget() while live, and the reconnect FAILS on the network. connect()'s
       catch puts the surviving session -- the forgotten account's -- back on
       the wire, and the heartbeat would paint "live" over "connect failed"
       within a second: chip anonymous, record gone, board still marking that
       account's picks as "mine" for the rest of the draft. The controller must
       degrade the live session to anonymous instead, say so in a note that a
       good poll does not erase, and write an anonymous record. */
    await Session.identify("me");
    await until(() => last.mine.size === 1, "re-identifying to restore a seat");
    assert.strictEqual(JSON.parse(store.get(KEY)).userId, "U1");
    SLEEPER.draftError = "sleeper 503";           // /draft/<id> fails; /picks still answers
    const beforeFail = SLEEPER.calls.length;
    Session.forget();
    await until(() => last.mine.size === 0 && store.has(KEY),
                "a failed anonymous reconnect to degrade the seat anyway");
    assert.strictEqual(last.connected, true, "degrading disconnected the draft");
    assert.deepStrictEqual(JSON.parse(store.get(KEY)),
      { username: null, userId: null, draftId: "1234567" },
      "a failed reconnect left the forgotten account in the record");
    assert.match(els.status.textContent, /reconnect failed — showing the draft anonymously/);
    assert.ok(els.roster.hidden, "the forgotten account's roster panel stayed up");
    // Polling resumed, a poll SUCCEEDED, and the note survived it: the status
    // must not read "live" while the draft object could not be re-read.
    const pollsBefore = SLEEPER.calls.filter(p => p === "/draft/1234567/picks").length;
    await until(() => SLEEPER.calls.filter(p => p === "/draft/1234567/picks").length > pollsBefore
                      && /last synced/.test(els.status.textContent),
                "a good poll after the degrade", 5000);
    assert.match(els.status.textContent, /reconnect failed — showing the draft anonymously · last synced/);
    assert.ok(!/^live/.test(els.status.textContent), els.status.textContent);
    assert.strictEqual(last.mine.size, 0, "a good poll re-highlighted the forgotten seat");
    assert.strictEqual(SLEEPER.calls.slice(beforeFail).filter(p => p === "/draft/1234567").length, 1,
      "the same failed identity was retried");
    delete SLEEPER.draftError;
    // The note clears only on the next SUCCESSFUL connect.
    await Session.identify("me");
    await until(() => last.mine.size === 1 && /live · synced/.test(els.status.textContent),
                "a successful reconnect to clear the degraded note");
    assert.ok(!/reconnect failed/.test(els.status.textContent));
    assert.ok(!els.roster.hidden);

    /* The forget -> identify race. forget() starts an anonymous connect; while
       its draft fetch is in flight, identify() resolves. That identified fire
       sees the OLD session still matching (connect has not committed yet) and
       rightly does nothing -- so the in-flight reconcile must re-check against
       the identity as it stands AFTER its await and reconnect once more. The
       session must end on the new identity, connected for it exactly once. */
    let release;
    SLEEPER.draftGate = new Promise(r => { release = r; });
    const beforeRace = SLEEPER.calls.length;
    Session.forget();                              // anonymous connect now waiting on the gate
    await new Promise(r => setImmediate(r));
    assert.strictEqual(last.mine.size, 1, "the seat was dropped before the anonymous connect landed");
    await Session.identify("me");                  // resolves while that connect is pending
    assert.strictEqual(Session.identity().userId, "U1");
    release();
    await until(() => last.mine.size === 1 && store.has(KEY) && JSON.parse(store.get(KEY)).userId === "U1",
                "the race to end on the new identity");
    const raced = SLEEPER.calls.slice(beforeRace);
    assert.strictEqual(raced.filter(p => p === "/draft/1234567").length, 2,
      "expected exactly one anonymous connect then one for the new identity");
    assert.strictEqual(last.connected, true);
    delete SLEEPER.draftGate;

    /* The real page flow: anonymous and live, then the chip identifies and,
       on success, calls Session.ready() (app.js maybeReady). ready() fires
       twice more -- loadingLeague, then the commit -- while the identified
       fire's connect() still has its /draft/ fetch in flight, so the session
       still carries the OLD identity at each fire. reconcile must recognise
       the in-flight target and issue ONE connect for U1, not three: with three,
       the first two are superseded mid-fetch and a transient failure on the
       third degrades the seat that was just claimed (the review's I-1). */
    Session.forget();
    await until(() => last.mine.size === 0 && JSON.parse(store.get(KEY)).userId === null,
                "an anonymous session before the identify-then-ready flow");
    SLEEPER.league = { league_id: "1376245373244301312", name: "Gabagool Fools", season: "2026" };
    SLEEPER.rosters = [{ roster_id: 2, owner_id: "U1", players: [] }];
    SLEEPER.users = [{ user_id: "U1", display_name: "me" }];
    SLEEPER.draftFetches = 0; SLEEPER.draftFailAfter = 1;   // only ONE draft fetch may succeed
    SLEEPER.draftGate = new Promise(r => { release = r; });
    const beforeReady = SLEEPER.calls.length;
    const gabBoard = { league: { league_id: "1376245373244301312" } };
    const readyDone = Session.identify("me").then(() => Session.ready({ slug: "gabagool", board: gabBoard }));
    await until(() => Session.state() === "ready", "the league load to commit while the draft connect is in flight");
    assert.strictEqual(Session.bundle().myRosterStatus, "found");
    release();
    await readyDone;
    // Settles either way: on U1's seat, or degraded with the note up.
    await until(() => JSON.parse(store.get(KEY)).userId === "U1" || /reconnect .*failed/.test(els.status.textContent),
                "identify-then-ready to settle");
    const identifyReady = SLEEPER.calls.slice(beforeReady);
    assert.strictEqual(identifyReady.filter(p => p === "/draft/1234567").length, 1,
      `identify then ready() reconnected ${identifyReady.filter(p => p === "/draft/1234567").length} times, expected exactly once`);
    assert.ok(!/reconnect .*failed/.test(els.status.textContent),
      `a redundant reconnect degraded the seat just claimed: ${els.status.textContent}`);
    await until(() => last.mine.size === 1 && JSON.parse(store.get(KEY)).userId === "U1",
                "identify-then-ready to end on the new identity's seat");
    assert.strictEqual(last.connected, true);
    assert.ok(!els.roster.hidden, "your roster must be up after identifying");
    delete SLEEPER.draftGate; delete SLEEPER.draftFailAfter; delete SLEEPER.draftFetches;
    SLEEPER.league = null; delete SLEEPER.rosters; delete SLEEPER.users;

    /* The identifying INTERVAL (spec §4.1/§4.4). Session.identify() clears the
       account and fires `identifying` BEFORE the lookup; the board must go
       dark for that account at that instant -- no seat marked "mine", no
       "Your roster" panel, no seat-derived shortlist -- and stay dark through
       every poll until the lookup resolves. It must do so WITHOUT reconnecting
       (a reconnect per fire was the bug the previous wave fixed): the same
       account resolving unmasks on the existing chain with zero /draft/
       fetches; a different account reconnects exactly once. */
    assert.strictEqual(last.mine.size, 1, "precondition: U1's seat is highlighted");
    assert.ok(!els.roster.hidden, "precondition: the roster panel is up");
    let releaseUser;
    SLEEPER.userGate = new Promise(r => { releaseUser = r; });
    const beforeMask = SLEEPER.calls.length;
    const sameAccount = Session.identify("me");          // same account, held in `identifying`
    assert.strictEqual(Session.state(), "identifying");
    assert.strictEqual(last.mine.size, 0, "the seat must be masked the instant identifying begins");
    assert.ok(els.roster.hidden, "the roster panel must hide the instant identifying begins");
    assert.ok(els.shortlist.hidden, "the seat-derived shortlist must hide the instant identifying begins");
    assert.strictEqual(last.connected, true, "masking must not disconnect the draft");
    // A poll lands while the lookup is still out: the new pick strikes, but
    // the masked seat is NOT repopulated.
    SLEEPER.picks = SLEEPER.picks.concat([{ pick_no: 3, draft_slot: 3, player_id: "x3", picked_by: "them" }]);
    await until(() => last.drafted.size === 3, "a poll during identifying to strike the new pick", 5000);
    assert.strictEqual(last.mine.size, 0, "a poll during identifying repopulated the seat");
    assert.ok(els.roster.hidden, "a poll during identifying re-showed the roster panel");
    assert.strictEqual(SLEEPER.calls.slice(beforeMask).filter(p => p === "/draft/1234567").length, 0,
      "identifying must not start a reconnect");
    releaseUser(); await sameAccount; delete SLEEPER.userGate;
    await until(() => last.mine.size === 1 && !els.roster.hidden,
                "the same account resolving to unmask the seat on the existing chain");
    assert.strictEqual(SLEEPER.calls.slice(beforeMask).filter(p => p === "/draft/1234567").length, 0,
      "the same account resolving must not reconnect");
    assert.strictEqual(last.connected, true);
    // A DIFFERENT account: masked during the lookup, then ONE reconnect and
    // the new account's seat.
    SLEEPER.user = { user_id: "U3" };
    SLEEPER.draft = Object.assign({}, SLEEPER.draft, { draft_order: { U1: 2, U3: 3 } });
    SLEEPER.userGate = new Promise(r => { releaseUser = r; });
    const beforeSwitch = SLEEPER.calls.length;
    const otherAccount = Session.identify("third");
    assert.strictEqual(last.mine.size, 0, "the OLD seat must be masked while another account is looked up");
    assert.ok(els.roster.hidden);
    releaseUser(); await otherAccount; delete SLEEPER.userGate;
    await until(() => last.mine.has("x3") && !last.mine.has("4034") && !els.roster.hidden,
                "the new account to take its own seat after one reconnect", 5000);
    assert.strictEqual(SLEEPER.calls.slice(beforeSwitch).filter(p => p === "/draft/1234567").length, 1,
      "a changed account must reconnect exactly once");
    assert.strictEqual(JSON.parse(store.get(KEY)).userId, "U3");
    SLEEPER.user = { user_id: "U1" };

    handlers.disconnect();   // stops the poll chain + heartbeat so node exits
  })();
  reconnectFixtureDone.catch(e => { console.error(e.message); process.exit(1); });
}

/* --- one browser, two leagues --------------------------------------------
   The stored session lived under a single global key with no league in it, so
   connecting to one league's draft left the OTHER league's page auto-restoring
   it on load -- a FAM draft resurrected on the Gabagool board on draft night.
   And a draft id pasted into the wrong board was accepted silently, optimizing
   a 10-team draft against 12-team VORP with nothing on screen to say so. */
{
  var twoLeaguesFixtureDone = (async () => {
    // Must not start touching cfg/session/SLEEPER until the previous block's
    // async chain has fully settled -- see the comment on reconnectFixtureDone.
    await reconnectFixtureDone;
    SLEEPER.calls.length = 0;         // the previous block's identify() is not this block's

    const store = fakeStore();
    global.localStorage = store;
    Session._storage(store);          // cold session again; the old init's listener is gone
    const GAB = { slug: "gabagool", name: "Gabagool Fools", league_id: "1376245373244301312", teams: 12, rounds: 15,
                  roster: { QB: 1, RB: 2, WR: 2, TE: 1 }, flex: 2,
                  flex_positions: ["RB", "WR", "TE"], starters: 8,
                  total_picks: 180, depth_cap: { QB: 2, RB: 6, WR: 6, TE: 2 },
                  keeper_rules: "gabagool", sleeper_scoring: SCORING };

    const el = () => ({
      value: "", textContent: "", innerHTML: "", hidden: false, checked: false,
      open: false, addEventListener() {}, querySelectorAll: () => [],
    });
    const els = {
      connect: el(), connectId: el(), disconnect: el(), find: el(), hide: el(),
      idInput: el(), late: el(), list: el(), live: el(), note: el(),
      picksCount: el(), roster: el(), shortlist: el(), status: el(),
      ticker: el(),
    };
    const handlers = {};
    for (const [name, node] of Object.entries(els)) {
      node.addEventListener = (ev, fn) => { if (ev === "click") handlers[name] = fn; };
    }
    const board = {
      league: GAB,
      players: [
        { player_id: "a", sleeper_id: "9509", name: "P1", position: "RB", adp: 1,
          bye: 5, value_points: 300, vorp: 90, position_rank: 1 },
        { player_id: "b", sleeper_id: "4034", name: "P2", position: "WR", adp: 2,
          bye: 7, value_points: 290, vorp: 85, position_rank: 1 },
      ],
    };
    let last = null;
    D.init({ board, els, onUpdate: (st) => { last = st; } });

    // A session belonging to the OTHER league, already in storage.
    store.set("fc-draft-mode:fam", JSON.stringify({ draftId: "FAM1" }));

    SLEEPER.picks = [
      { pick_no: 1, draft_slot: 1, player_id: "9509", picked_by: "them" },
      { pick_no: 2, draft_slot: 2, player_id: "4034", picked_by: "them" },
    ];

    // 1. A draft with a different TEAM COUNT is REFUSED: replacement level,
    //    and so every VORP on this board, was computed for 12 seats.
    SLEEPER.draft = { draft_id: "D1", type: "snake", status: "in_progress",
                      settings: { rounds: 14, teams: 10 }, draft_order: {} };
    els.idInput.value = "D1234567";
    await handlers.connectId();
    await until(() => /10 teams/.test(els.status.textContent),
                "the mismatched draft to be refused by name");
    assert.strictEqual(last && last.connected, false,
      "a 10-team draft was accepted on a 12-team board");
    assert.ok(/Gabagool Fools/.test(els.status.textContent),
      "the refusal did not name the board's own league");

    // 1a. A different STARTING LINEUP is refused even when the team count
    //     matches. A standalone Sleeper mock takes defaults rather than a
    //     league's settings, so a 10-team mock for a 1-flex league comes back
    //     with slots_flex 2 -- measured on a real mock, 2026-09-07. The
    //     optimizer builds every lineup against the board's roster shape, so
    //     connecting there optimized a 7-man lineup for a draft starting 8
    //     and produced three QBs in a one-QB league.
    SLEEPER.draft = { draft_id: "D1", type: "snake", status: "in_progress",
                      settings: { rounds: 15, teams: 12, slots_qb: 1, slots_rb: 2,
                                  slots_wr: 2, slots_te: 1, slots_flex: 3 },
                      draft_order: {} };
    await handlers.connectId();
    await until(() => /different lineup/.test(els.status.textContent),
                "a mismatched starting lineup to be refused");
    assert.ok(/FLEX 3/.test(els.status.textContent),
      "the refusal did not name which slot disagreed");
    assert.strictEqual(last && last.connected, false,
      "a 3-flex draft was accepted on a 2-flex board");

    // 1b. A ROUNDS-only difference must CONNECT, with a note. The panel reads
    //     `rounds` off the Sleeper draft object, so its pick math stays right;
    //     only the board's "inside the draft" display bound goes stale.
    //     Refusing here would lock the tool out of a live draft because a
    //     commissioner added a round the week of the draft -- and this
    //     league's commissioner has already moved the date once.
    SLEEPER.draft = { draft_id: "D1", type: "snake", status: "in_progress",
                      settings: { rounds: 16, teams: 12, slots_qb: 1, slots_rb: 2,
                                  slots_wr: 2, slots_te: 1, slots_flex: 2 },
                      draft_order: {} };
    await handlers.connectId();
    await until(() => last && last.connected === true,
                "a rounds-only mismatch to connect rather than be refused");
    assert.ok(/16 rounds/.test(els.note.textContent),
      "connected on a different round count without saying so");
    assert.ok(/scoring not verified/.test(els.note.textContent),
      "standalone draft did not disclose that league scoring was unverified");
    assert.ok(!els.note.hidden, "the round-count note was left hidden");
    handlers.disconnect();

    // 2. A matching draft connects, and stores under a LEAGUE-SCOPED key.
    SLEEPER.draft = { draft_id: "D1", type: "snake", status: "in_progress",
                      settings: { rounds: 15, teams: 12, slots_qb: 1, slots_rb: 2,
                                  slots_wr: 2, slots_te: 1, slots_flex: 2 },
                      draft_order: {} };
    await handlers.connectId();
    await until(() => last && last.drafted.size === 2, "the matching draft to connect");
    assert.ok(store.has("fc-draft-mode:gabagool"),
      "the session was not stored under a league-scoped key");
    assert.ok(!store.has("fc-draft-mode"),
      "still writing the un-scoped global session key");
    // Anonymous pasted-id mode, exactly as before the shared session: no
    // identity, no user lookup, userId null in the record, nothing "mine".
    assert.strictEqual(Session.identity(), null);
    assert.strictEqual(JSON.parse(store.get("fc-draft-mode:gabagool")).userId, null,
      "an anonymous connect recorded a userId");
    assert.strictEqual(last.mine.size, 0, "anonymous connect highlighted a seat");
    assert.ok(!SLEEPER.calls.some(p => /^\/user\//.test(p)),
      "anonymous connect must not look a user up");

    // 3. The other league's stored session is untouched, and would not be
    //    restored onto this board.
    assert.strictEqual(JSON.parse(store.get("fc-draft-mode:fam")).draftId, "FAM1",
      "connecting on one board clobbered the other league's saved session");

    handlers.disconnect();
    assert.ok(!store.has("fc-draft-mode:gabagool"), "disconnect left the session stored");
    assert.ok(store.has("fc-draft-mode:fam"),
      "disconnecting one league removed the OTHER league's session");

    // Advance the actual poll chain deterministically, without a 30s wait.
    // Numeric-string settings must normalize for pick math as well as guards.
    const realSetTimeout = global.setTimeout;
    let pendingPoll;
    global.setTimeout = fn => { pendingPoll = fn; return 0; };
    try {
      SLEEPER.league = { league_id: GAB.league_id,
                         scoring_settings: { ...SCORING } };
      SLEEPER.calls.length = 0;
      SLEEPER.draft = { draft_id: "D1", type: "snake", status: "in_progress",
        league_id: GAB.league_id, draft_order: { U1: "2" },
        settings: { teams: "12", rounds: "15", reversal_round: "0", slots_flex: "2" } };
      SLEEPER.user = { user_id: "U1" };
      await Session.identify("me");    // not connected: identifying here connects nothing
      assert.ok(!SLEEPER.calls.some(p => /^\/draft\//.test(p)),
        "identifying while disconnected must not connect anything");
      await handlers.connectId();
      await until(() => pendingPoll && last.connected, "numeric-string draft to connect");
      assert.ok(!/No pick left|doesn&#39;t report its size/.test(els.shortlist.innerHTML),
        "numeric-string settings passed the guard but broke pick timing");
      assert.match(els.roster.innerHTML, /still need/,
        "the live panel must show unfilled starting slots");
      assert.ok(SLEEPER.calls.includes(`/league/${GAB.league_id}`),
        "a league-backed draft did not verify its scoring snapshot");

      SLEEPER.draft.settings.rounds = "16";
      for (let i = 0; i < 9; i++) await pendingPoll();
      assert.match(els.note.textContent, /16 rounds/,
        "commissioner round edit was not refreshed");
      SLEEPER.draft.settings.rounds = "15";
      for (let i = 0; i < 10; i++) await pendingPoll();
      assert.ok(els.note.hidden, "restoring rounds left a stale round warning");

      SLEEPER.draftError = "temporary metadata failure";
      for (let i = 0; i < 10; i++) await pendingPoll();
      assert.strictEqual(last.connected, true, "transient metadata failure disconnected the draft");
      assert.match(els.status.textContent, /reconnecting.*temporary metadata failure/);
      delete SLEEPER.draftError;

      SLEEPER.leagueError = "temporary scoring lookup failure";
      for (let i = 0; i < 10; i++) await pendingPoll();
      assert.strictEqual(last.connected, true, "scoring lookup failure disconnected the draft");
      assert.match(els.status.textContent,
        /reconnecting.*league scoring verification failed.*temporary scoring lookup failure/);
      delete SLEEPER.leagueError;

      SLEEPER.draft.settings.slots_super_flex = 1;
      for (let i = 0; i < 10; i++) await pendingPoll();
      assert.strictEqual(last.connected, false, "incompatible commissioner edit kept driving the draft");
      assert.match(els.status.textContent, /draft settings changed.*slots_super_flex/);
      assert.ok(els.shortlist.hidden, "incompatible settings left recommendations visible");
      assert.ok(!store.has("fc-draft-mode:gabagool"), "invalidated draft kept auto-restore state");

      // Rejecting a second connection must retire the original heartbeat and
      // visible recommendations, rather than reverting to a misleading live label.
      delete SLEEPER.draft.settings.slots_super_flex;
      SLEEPER.draft.settings.rounds = "1";
      await handlers.connectId();
      await until(() => last.connected, "reconnect after restoring compatible shape");
      // A round added since connect must not be mistaken for draft completion
      // when the pick log first reaches the old length.
      SLEEPER.draft.settings.rounds = "2";
      SLEEPER.picks = Array.from({ length: 12 }, (_, i) => ({
        pick_no: i + 1, draft_slot: i + 1, player_id: `picked-${i}`, picked_by: "them",
      }));
      await pendingPoll();
      assert.match(els.note.textContent, /2 rounds/);
      assert.ok(!/draft complete/.test(els.status.textContent), "added round was ignored at old completion boundary");
      SLEEPER.draft.type = "auction";
      await handlers.connectId();
      assert.strictEqual(last.connected, false);
      assert.match(els.status.textContent, /unsupported draft type: auction/);

      // Live scoring is part of the same immutable board contract: exact
      // values connect, while either a changed known rule or a new nonzero
      // bonus refuses/clears recommendations. Extra zero categories are benign
      // because Sleeper commonly omits zero-valued fields.
      SLEEPER.draft.type = "snake";
      SLEEPER.draft.settings.rounds = "15";
      SLEEPER.picks = [];
      SLEEPER.league.scoring_settings.pass_td = 4;
      await handlers.connectId();
      assert.strictEqual(last.connected, false, "changed passing TD scoring connected");
      assert.match(els.status.textContent, /pass_td 4≠6/);

      SLEEPER.league.scoring_settings.pass_td = 6;
      SLEEPER.league.scoring_settings.pass_int_td = -2;
      await handlers.connectId();
      assert.strictEqual(last.connected, false, "changed pick-six scoring connected");
      assert.match(els.status.textContent, /pass_int_td -2≠-3/);

      SLEEPER.league.scoring_settings.pass_int_td = -3;
      SLEEPER.league.scoring_settings.bonus_rec_te = 0.5;
      await handlers.connectId();
      assert.strictEqual(last.connected, false, "unexpected nonzero bonus connected");
      assert.match(els.status.textContent, /bonus_rec_te 0.5≠0/);

      SLEEPER.league.scoring_settings.bonus_rec_te = 0;
      pendingPoll = null;
      await handlers.connectId();
      await until(() => pendingPoll && last.connected,
        "an optional zero scoring field to connect");
      SLEEPER.league.scoring_settings.pass_td = 4;
      for (let i = 0; i < 9; i++) await pendingPoll();
      assert.strictEqual(last.connected, false,
        "a live scoring contract change left the draft connected");
      assert.match(els.status.textContent, /draft settings changed.*pass_td 4≠6/);
      assert.ok(els.shortlist.hidden,
        "a live scoring contract change left recommendations visible");
      SLEEPER.league.scoring_settings.pass_td = 6;

      SLEEPER.leagueError = "league endpoint unavailable";
      await handlers.connectId();
      assert.strictEqual(last.connected, false, "unverified scoring connected after network failure");
      assert.match(els.status.textContent,
        /connect failed.*league scoring verification failed.*league endpoint unavailable/);
    } finally {
      delete SLEEPER.draftError;
      delete SLEEPER.leagueError;
      handlers.disconnect();
      global.setTimeout = realSetTimeout;
    }
  })();
  twoLeaguesFixtureDone.catch(e => { console.error(e.message); process.exit(1); });
}

/* --- restore: a saved session that is not YOUR account -------------------
   The restore record `fc-draft-mode:<slug>` carries the userId it was
   connected under. The shared session now says who you are, and the two can
   disagree: someone else identified on this device, or you changed account
   in the league panel since draft night. Auto-restoring the record would
   highlight THEIR seat as "mine" under a status reading "live" -- so it must
   not connect at all until you choose: reconnect as the session's account,
   or view the draft anonymously. Every other combination restores exactly as
   before (same account, an anonymous record, or no session identity). */
{
  var restoreFixtureDone = (async () => {
    await twoLeaguesFixtureDone;
    SLEEPER.calls.length = 0;

    const GAB = require("../site/data/draft.json").league;
    const league = { ...GAB, sleeper_scoring: SCORING };
    const el = () => ({
      value: "", textContent: "", innerHTML: "", hidden: false, checked: false,
      open: false, className: "", children: [],
      addEventListener() {}, querySelectorAll: () => [],
      appendChild(n) { this.children.push(n); },
    });
    // offerRestoreChoice builds its note and buttons with createElement; the
    // restore path opens #draft-panel. Neither exists in the module-level stub.
    const panel = { open: false };
    global.document.getElementById = id => (id === "draft-panel" ? panel : null);
    global.document.createElement = tag => {
      const n = el();
      n.tag = tag;
      n.addEventListener = (ev, fn) => { if (ev === "click") n.click = fn; };
      return n;
    };
    const board = { league, players: [
      { player_id: "a", sleeper_id: "9509", name: "P1", position: "RB", adp: 1,
        bye: 5, value_points: 300, vorp: 90, position_rank: 1 },
      { player_id: "b", sleeper_id: "4034", name: "P2", position: "WR", adp: 2,
        bye: 7, value_points: 290, vorp: 85, position_rank: 1 },
    ] };
    SLEEPER.league = { league_id: league.league_id, scoring_settings: { ...SCORING } };
    SLEEPER.draft = { draft_id: "D1", type: "snake", status: "in_progress",
      league_id: league.league_id, draft_order: { U1: 2, U2: 1 },
      settings: { rounds: 15, teams: 12, slots_qb: 1, slots_rb: 2,
                  slots_wr: 2, slots_te: 1, slots_flex: 2 } };
    SLEEPER.picks = [
      { pick_no: 1, draft_slot: 1, player_id: "9509", picked_by: "U2" },
      { pick_no: 2, draft_slot: 2, player_id: "4034", picked_by: "U1" },
    ];
    SLEEPER.user = { user_id: "U1", display_name: "Me" };
    const KEY = "fc-draft-mode:gabagool";
    const connects = () => SLEEPER.calls.filter(p => p === "/draft/D1").length;
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

    // Fresh controller + fresh session per scenario. `record` is what the
    // previous visit left in storage; `identity` is whether this visitor has
    // identified in the league panel.
    // `spy` sees every emit, so a case can assert a seat NEVER appeared, not
    // just that the last render was right.
    async function visit(record, identity, spy) {
      const store = fakeStore();
      global.localStorage = store;
      Session._storage(store);
      if (identity) await Session.identify(identity);
      if (record) store.set(KEY, JSON.stringify(record));
      panel.open = false;
      SLEEPER.calls.length = 0;
      const els = {
        connect: el(), connectId: el(), disconnect: el(), find: el(), hide: el(),
        idInput: el(), late: el(), list: el(), live: el(), note: el(),
        picksCount: el(), roster: el(), shortlist: el(), status: el(), ticker: el(),
      };
      const handlers = {};
      for (const [name, node] of Object.entries(els)) {
        node.addEventListener = (ev, fn) => { if (ev === "click") handlers[name] = fn; };
      }
      let last = null;
      D.init({ board, els, onUpdate: st => { last = st; if (spy) spy(st); } });
      return { store, els, handlers, state: () => last };
    }

    // 1. MISMATCH: the record is U2's, the session is U1. No connect, two choices.
    let v = await visit({ username: "stranger", userId: "U2", draftId: "D1" }, "me");
    await settle();
    assert.strictEqual(connects(), 0, "a mismatched restore record auto-connected");
    assert.strictEqual(v.state(), null, "a mismatched restore emitted state");
    assert.ok(panel.open, "the draft panel was not opened to show the choice");
    const kids = v.els.list.children;
    assert.strictEqual(kids.length, 3, `expected note + two buttons, got ${kids.length}`);
    assert.match(kids[0].textContent, /different account \(stranger\)/);
    assert.strictEqual(kids[1].tag, "button");
    assert.strictEqual(kids[1].textContent, "Reconnect as Me");
    assert.strictEqual(kids[2].tag, "button");
    assert.strictEqual(kids[2].textContent, "View anonymously");
    assert.match(v.els.status.textContent, /another account/);
    assert.strictEqual(v.store.get(KEY),
      JSON.stringify({ username: "stranger", userId: "U2", draftId: "D1" }),
      "the record was rewritten before the visitor chose");

    // 1a. "View anonymously": connects with no seat; record loses its identity.
    kids[2].click();
    await until(() => v.state() && v.state().connected && v.state().drafted.size === 2,
                "the anonymous view to connect");
    assert.strictEqual(connects(), 1);
    assert.strictEqual(v.state().mine.size, 0, "anonymous view highlighted a seat");
    assert.deepStrictEqual(JSON.parse(v.store.get(KEY)),
      { username: null, userId: null, draftId: "D1" });
    assert.strictEqual(Session.identity().userId, "U1",
      "viewing anonymously must not forget the session identity");
    v.handlers.disconnect();

    // 1b. "Reconnect as Me": connects as the SESSION's account, never the record's.
    v = await visit({ username: "stranger", userId: "U2", draftId: "D1" }, "me");
    await settle();
    assert.strictEqual(connects(), 0);
    v.els.list.children[1].click();
    await until(() => v.state() && v.state().connected && v.state().mine.size === 1,
                "reconnecting as the session identity to pick up its seat");
    assert.ok(v.state().mine.has("4034") && !v.state().mine.has("9509"),
      "highlighted the stored account's pick instead of the session's");
    assert.deepStrictEqual(JSON.parse(v.store.get(KEY)),
      { username: "me", userId: "U1", draftId: "D1" });
    v.handlers.disconnect();

    // 2. SAME account: restores as before, no choice offered.
    v = await visit({ username: "me", userId: "U1", draftId: "D1" }, "me");
    await until(() => v.state() && v.state().connected && v.state().mine.size === 1,
                "a matching record to auto-restore");
    assert.strictEqual(connects(), 1);
    assert.strictEqual(v.els.list.children.length, 0, "a matching restore offered a choice");
    v.handlers.disconnect();

    // 3. ANONYMOUS record with a session identity: restores as before (anonymously).
    v = await visit({ draftId: "D1" }, "me");
    await until(() => v.state() && v.state().connected && v.state().drafted.size === 2,
                "an anonymous record to auto-restore");
    assert.strictEqual(v.state().mine.size, 0);
    assert.strictEqual(v.els.list.children.length, 0);
    v.handlers.disconnect();

    // 4. NO session identity: nothing to compare against, restores as before.
    v = await visit({ username: "stranger", userId: "U2", draftId: "D1" }, null);
    await until(() => v.state() && v.state().connected && v.state().mine.size === 1,
                "a record to auto-restore when the session has no identity");
    assert.ok(v.state().mine.has("9509"));
    assert.strictEqual(v.els.list.children.length, 0);
    // ...and identifying now as U1 reconciles the live draft to the session, once.
    SLEEPER.calls.length = 0;
    await Session.identify("me");
    await until(() => v.state().mine.has("4034") && !v.state().mine.has("9509"),
                "identifying to move the seat to the session's account");
    assert.strictEqual(connects(), 1, "identity change reconnected more than once");
    assert.strictEqual(JSON.parse(v.store.get(KEY)).userId, "U1");
    v.handlers.disconnect();

    /* 5. The identity moves WHILE the restore is still connecting (the I-2
       ordering the re-review found). init() calls connect() with the stored
       record before any session exists; connect() commits the session only
       after the draft and scoring round trips. Session.identify() fired in
       that window used to hit syncIdentity's `if (!session) return` and record
       nothing -- so when the restore committed, startPolling ran unmasked and
       applyPicks lit the STORED account's seat while the chip said another
       account was being looked up. The pending mask must be recorded with no
       session too: the restore renders seatless until the lookup answers,
       then the resolved account takes its seat through exactly one reconnect. */
    let releaseDraft, releaseUser, exposed = false;
    SLEEPER.draftGate = new Promise(r => { releaseDraft = r; });
    v = await visit({ username: "stranger", userId: "U2", draftId: "D1" }, null,
                    st => { if (st.mine.has("9509")) exposed = true; });
    await settle();
    assert.strictEqual(connects(), 1, "the restore connect is in flight");
    assert.ok(!v.state() || !v.state().connected, "precondition: the restore has not committed");
    SLEEPER.userGate = new Promise(r => { releaseUser = r; });
    const duringRestore = Session.identify("me");        // held in `identifying`
    assert.strictEqual(Session.state(), "identifying");
    releaseDraft(); delete SLEEPER.draftGate;
    await until(() => v.state() && v.state().connected && v.state().drafted.size === 2,
                "the held restore to commit and poll once");
    assert.strictEqual(Session.state(), "identifying", "precondition: the lookup is still out");
    assert.strictEqual(v.state().mine.size, 0,
      "the restored account's seat was marked mine while another account was being looked up");
    assert.ok(v.els.roster.hidden, "the roster panel showed during the lookup");
    assert.ok(v.els.shortlist.hidden, "the seat-derived shortlist showed during the lookup");
    assert.strictEqual(connects(), 1, "identifying must not reconnect");
    // A poll during the lookup strikes the new pick and still shows no seat.
    SLEEPER.picks = SLEEPER.picks.concat([{ pick_no: 3, draft_slot: 3, player_id: "x3", picked_by: "U3" }]);
    await until(() => v.state().drafted.size === 3, "a poll during the lookup to strike the new pick", 5000);
    assert.strictEqual(v.state().mine.size, 0, "a poll during the lookup repopulated the stored seat");
    releaseUser(); await duringRestore; delete SLEEPER.userGate;
    await until(() => v.state().mine.has("4034") && !v.state().mine.has("9509") && !v.els.roster.hidden,
                "the resolved account to take its seat", 5000);
    assert.strictEqual(connects(), 2,
      `expected the restore plus exactly one reconnect, saw ${connects()} /draft/ fetches`);
    assert.strictEqual(JSON.parse(v.store.get(KEY)).userId, "U1");
    assert.ok(!exposed, "the stored account's seat was emitted as mine at some point");
    assert.strictEqual(v.state().connected, true);
    v.handlers.disconnect();
    SLEEPER.picks = SLEEPER.picks.slice(0, 2);

    /* 6. The mirror: the identity RESOLVES while the restore is still held.
       Both fires land with no session, so nothing could reconcile them at the
       time; the resolved identity must not be lost when the restore commits.
       The commit reconciles to it once -- one reconnect on top of the restore,
       never two pollers, and the stored account's seat never shows. */
    exposed = false;
    SLEEPER.draftGate = new Promise(r => { releaseDraft = r; });
    v = await visit({ username: "stranger", userId: "U2", draftId: "D1" }, null,
                    st => { if (st.mine.has("9509")) exposed = true; });
    await settle();
    assert.strictEqual(connects(), 1);
    await Session.identify("me");                        // resolves with no session yet
    assert.strictEqual(Session.identity().userId, "U1");
    assert.ok(!v.state() || !v.state().connected, "precondition: the restore has not committed");
    releaseDraft(); delete SLEEPER.draftGate;
    await until(() => v.state() && v.state().connected && v.state().mine.has("4034") && !v.state().mine.has("9509"),
                "the restore to commit and reconcile to the identity that resolved during it", 5000);
    await settle();
    assert.ok(connects() <= 2, `expected at most the restore plus one reconnect, saw ${connects()} /draft/ fetches`);
    assert.strictEqual(connects(), 2, "the resolved identity must reconcile through one reconnect");
    assert.ok(!exposed, "the stored account's seat was emitted as mine before the reconcile");
    assert.ok(!v.els.roster.hidden, "your roster must be up once your seat is known");
    assert.deepStrictEqual(JSON.parse(v.store.get(KEY)),
      { username: "me", userId: "U1", draftId: "D1" });
    v.handlers.disconnect();
  })();
  restoreFixtureDone.catch(e => { console.error(e.stack || e.message); process.exit(1); });
}

/* --- storage unavailable: the draft still works, anonymously if need be ---
   Private mode, blocked site data, a locked-down kiosk: every localStorage
   call throws. session.js already degrades to a memory-only identity; the
   draft controller must too -- a throw out of init() would take the whole
   panel down, one out of connect() would abort a connect that had already
   succeeded on the wire, and one out of the degrade path would leave the
   old seat live. A failed read is "no restore record"; failed writes and
   removals leave the in-memory draft usable. Nothing here may throw. */
{
  (async () => {
    await restoreFixtureDone;
    SLEEPER.calls.length = 0;
    const boom = () => { throw new Error("SecurityError: storage disabled"); };
    const throwing = { getItem: boom, setItem: boom, removeItem: boom, key: boom, get length() { return boom(); } };
    global.localStorage = throwing;
    Session._storage(throwing);
    const GAB = require("../site/data/draft.json").league;
    const league = { ...GAB, sleeper_scoring: SCORING };
    const el = () => ({
      value: "", textContent: "", innerHTML: "", hidden: false, checked: false,
      open: false, className: "", children: [],
      addEventListener() {}, querySelectorAll: () => [],
      appendChild(n) { this.children.push(n); },
    });
    const els = {
      connect: el(), connectId: el(), disconnect: el(), find: el(), hide: el(),
      idInput: el(), late: el(), list: el(), live: el(), note: el(),
      picksCount: el(), roster: el(), shortlist: el(), status: el(), ticker: el(),
    };
    const handlers = {};
    for (const [name, node] of Object.entries(els)) {
      node.addEventListener = (ev, fn) => { if (ev === "click") handlers[name] = fn; };
    }
    const board = { league, players: [
      { player_id: "a", sleeper_id: "9509", name: "P1", position: "RB", adp: 1,
        bye: 5, value_points: 300, vorp: 90, position_rank: 1 },
      { player_id: "b", sleeper_id: "4034", name: "P2", position: "WR", adp: 2,
        bye: 7, value_points: 290, vorp: 85, position_rank: 1 },
    ] };
    SLEEPER.league = { league_id: league.league_id, scoring_settings: { ...SCORING } };
    SLEEPER.draft = { draft_id: "D1", type: "snake", status: "in_progress",
      league_id: league.league_id, draft_order: { U1: 2, U2: 1 },
      settings: { rounds: 15, teams: 12, slots_qb: 1, slots_rb: 2,
                  slots_wr: 2, slots_te: 1, slots_flex: 2 } };
    SLEEPER.picks = [
      { pick_no: 1, draft_slot: 1, player_id: "9509", picked_by: "U2" },
      { pick_no: 2, draft_slot: 2, player_id: "4034", picked_by: "U1" },
    ];
    SLEEPER.user = { user_id: "U1", display_name: "Me" };
    let last = null;
    // 1. init: the restore read throws -> no record, no throw, nothing connected.
    assert.doesNotThrow(() => D.init({ board, els, onUpdate: st => { last = st; } }),
      "init() must not throw when storage throws");
    await new Promise(r => setImmediate(r));
    assert.strictEqual(last, null, "a throwing restore read must connect nothing");
    assert.ok(!SLEEPER.calls.some(p => /^\/draft\//.test(p)));
    // 2. connect: the record write throws AFTER the draft answered -> still live.
    els.idInput.value = "D1234567";
    await handlers.connectId();
    await until(() => last && last.connected && last.drafted.size === 2,
                "connect to go live although the restore record cannot be written");
    assert.ok(!/connect failed/.test(els.status.textContent), els.status.textContent);
    // 3. identity reconnect: same again, with a seat this time.
    await Session.identify("me");
    await until(() => last.mine.size === 1, "an identity reconnect with throwing storage");
    assert.strictEqual(last.connected, true);
    // 4. forget + a failing reconnect: the degrade path writes an anonymous
    //    record -- that write throws -- and must still degrade the seat and
    //    say so.
    SLEEPER.draftError = "sleeper 503";
    assert.doesNotThrow(() => Session.forget());
    await until(() => last.mine.size === 0 && /reconnect failed — showing the draft anonymously/.test(els.status.textContent),
                "the degrade path to complete with throwing storage", 3000);
    assert.strictEqual(last.connected, true, "degrading must keep the draft live");
    assert.ok(els.roster.hidden);
    delete SLEEPER.draftError;
    // 5. disconnect: the record removal throws -> the panel still tears down.
    assert.doesNotThrow(() => handlers.disconnect(), "disconnect() must not throw when storage throws");
    assert.strictEqual(last.connected, false);
    assert.strictEqual(last.drafted.size, 0);
    assert.strictEqual(els.status.textContent, "— off");

    console.log("draftmode_fixture: OK");
  })().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
