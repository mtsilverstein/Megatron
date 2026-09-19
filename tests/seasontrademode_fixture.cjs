// tests/seasontrademode_fixture.cjs — run with: node tests/seasontrademode_fixture.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../site/assets/seasontrademode.js");
const Session = require("../site/assets/session.js");
let n = 0;
function check(name, fn) { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }

check("parseWeeks accepts ranges and singles inside the horizon", () => {
  assert.deepEqual(M.parseWeeks("3-5, 8", 2, 17), [3, 4, 5, 8]);
  assert.deepEqual(M.parseWeeks(" 9 ", 2, 17), [9]);
  assert.deepEqual(M.parseWeeks("", 2, 17), []);
  assert.deepEqual(M.parseWeeks("5-3", 2, 17), [3, 4, 5], "a reversed range is still a range");
  assert.deepEqual(M.parseWeeks("4,4,4", 2, 17), [4]);
  for (const bad of ["1", "18", "3-19", "abc", "3;4", "2-", "0"]) assert.throws(() => M.parseWeeks(bad, 2, 17), /weeks must look like 3-5, 8 and fall within 2–17/, bad);
});
check("identifyRoster is Session's exact matcher, re-exported unchanged", () => {
  assert.equal(M.identifyRoster, Session.identifyRoster, "one matcher for every page, not a local copy");
  const rosters = [{ roster_id: 1, owner_id: "u1", co_owners: null }, { roster_id: 2, owner_id: "u2", co_owners: ["u3"] }];
  assert.equal(M.identifyRoster(rosters, "u1").roster_id, 1);
  assert.equal(M.identifyRoster(rosters, "u3").roster_id, 2);
  assert.throws(() => M.identifyRoster(rosters, "u9"), /Could not uniquely match this account to a roster in this league\./);
  assert.throws(() => M.identifyRoster(rosters.concat([{ roster_id: 3, owner_id: "u1" }]), "u1"), /Could not uniquely match/);
});
check("capacity, active skill players and needed drops", () => {
  const league = { roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "IR", "TAXI"] };
  assert.equal(M.capacityOf(league), 15);
  const catalog = { a: { position: "RB" }, b: { position: "K" }, c: { position: "WR" }, d: { position: "DEF" }, e: { position: "TE" } };
  assert.deepEqual(M.activeSkill({ players: ["a", "b", "c", "d", "e"], reserve: ["e"], taxi: [] }, catalog), ["a", "c"]);
  assert.equal(M.neededDrops({ activeCount: 15, giveCount: 1, receiveCount: 2, capacity: 15 }), 1);
  assert.equal(M.neededDrops({ activeCount: 14, giveCount: 1, receiveCount: 2, capacity: 15 }), 0);
  assert.equal(M.neededDrops({ activeCount: 15, giveCount: 2, receiveCount: 1, capacity: 15 }), 0);
});
check("fmtDelta uses a leading sign and a real minus", () => {
  assert.equal(M.fmtDelta(12.4), "+12.40"); assert.equal(M.fmtDelta(-3.1), "−3.10"); assert.equal(M.fmtDelta(0), "0.00");
});
const result = {
  weeks: [{ week: 3, sides: [{ rosterId: 1, before: { total: 100 }, after: { total: 106 }, delta: 6 }, { rosterId: 2, before: { total: 90 }, after: { total: 82 }, delta: -8 }] },
          { week: 4, sides: [{ rosterId: 1, before: { total: 100 }, after: { total: 106 }, delta: 6 }, { rosterId: 2, before: { total: 90 }, after: { total: 82 }, delta: -8 }] }],
  sides: [{ rosterId: 1, delta: 12 }, { rosterId: 2, delta: -16 }],
  warnings: ["All non-excluded active players are assumed available, including reported injuries; availability is not predicted."],
};
const ctx = { names: { 1: "Me", 2: "Them" }, currentWeek: 2, firstWeek: 3, endWeek: 17, picks: [{ label: "2027 R1 (Them)" }], excludeWeeks: { p9: [3, 4] }, playerNames: { p9: "A.J. Brown" }, drops: { 2: ["p7"] }, playerNamesAll: { p7: "Bench Guy" } };
check("scenarioText: headline, subline, sides and assumptions", () => {
  const t = M.scenarioText(result, ctx);
  assert.equal(t.headline, "Conditional lineup scenario — not a trade verdict.");
  assert.equal(t.subline, "Sum of weekly central (p50) lineup scenarios for weeks 3–17; week 2 is excluded because trades may process after games start. Keeper value and draft picks are not valued, so no overall grade is shown.");
  assert.deepEqual(t.sides, [{ name: "Me", before: "200.00", after: "212.00", delta: "+12.00" }, { name: "Them", before: "180.00", after: "164.00", delta: "−16.00" }]);
  assert.deepEqual(t.notValued, ["Not valued: picks — 2027 R1 (Them)"]);
  assert.deepEqual(t.assumptions, ["A.J. Brown assumed unavailable weeks 3, 4 (your assumption, not a return-date prediction)", "Them drops Bench Guy"]);
});
check("no forbidden word leaves the text builders outside the two allowed sentences", () => {
  const t = M.scenarioText(result, ctx);
  const c = M.coverageText(Object.assign(new Error("Projection coverage blocked: 1 players, 2 player-weeks."), { name: "ProjectionCoverageError", coverageIssues: [{ id: "x", name: "X", week: 3, reason: "unknown is not zero (no_observed_history)" }, { id: "x", name: "X", week: 4, reason: "unknown is not zero (no_observed_history)" }] }));
  const all = [t.subline, ...t.sides.flatMap(s => Object.values(s)), ...t.notValued, ...t.assumptions, c.headline, ...c.rows];
  const scrubbed = all.map(s => M.ALLOWED_SENTENCES.reduce((x, a) => x.split(a).join(""), s)).join("\n").toLowerCase();
  for (const w of M.FORBIDDEN) assert.ok(!scrubbed.includes(w), `forbidden word "${w}" in: ${scrubbed}`);
  assert.equal(c.headline, "Comparison blocked: 1 player(s), 2 player-week(s) without a projection");
  assert.deepEqual(c.rows, ["X · week 3 · unknown is not zero (no_observed_history)", "X · week 4 · unknown is not zero (no_observed_history)"]);
  const other = M.coverageText(new Error("Scoring mismatch"));
  assert.equal(other.headline, "Comparison blocked"); assert.deepEqual(other.rows, ["Scoring mismatch"]);
});
check("requiring the module in node leaves window untouched and exports a callable init", () => {
  assert.equal(typeof global.window, "undefined", "the UMD wrapper must not create a global window in node");
  assert.equal(typeof M.init, "function");
  assert.ok(Object.isFrozen(M));
});
check("the controller reads identity, rosters and state from the session, never its own /user lookup", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "site", "assets", "seasontrademode.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "site", "trade.html"), "utf8");
  assert.ok(!/\/user\//.test(src), "no /user/<name> fetch remains in this controller");
  assert.ok(!/els\.user\b|els\.load\b/.test(src), "init no longer needs els.user / els.load");
  assert.ok(!/\/players\/nfl/.test(src), "the catalog comes from Session.catalog(), not a page-local cache");
  assert.ok(!/get\(`\/league\/\$\{lid\}\/(?:users|rosters)`\)|get\("\/state\/nfl"\)/.test(src), "users/rosters/state come from the bundle");
  assert.ok(/refresh\(\{ scope: "rosters" \}\)/.test(src), "compare re-reads rosters through Session.refresh");
  assert.ok(/snapshotAt = b\.rostersFetchedAt/.test(src), "snapshotAt is the refreshed bundle's post-fetch time (spec §5)");
  assert.ok(/isSuperseded\(e\)/.test(src), "superseded session results are swallowed");
  assert.ok(!/season-user|season-load/.test(html), "trade.html has no in-season username input or load button");
  assert.ok(/seasontrademode\.js\?v=session1/.test(html), "cache key bumped for the session controller");
});

// --- init() under a DOM stub and a scripted Session -------------------------
// Pins the controller's contract with the session: hidden until a bundle with
// a uniquely matched roster commits; a compare's own refresh is adopted (the
// compare finishes against the NEW bundle's rosters and rostersFetchedAt);
// a foreign bundle change during a compare invalidates it.
function stubDom() {
  const mk = () => {
    const node = { hidden: false, textContent: "", value: "", checked: false, disabled: false, className: "", dataset: {}, children: [], type: "", listeners: {}, parentElement: null };
    node.append = (...xs) => { for (const x of xs) if (x && typeof x === "object") { node.children.push(x); x.parentElement = node; } };
    node.replaceChildren = () => { node.children = []; };
    node.addEventListener = (ev, fn) => { (node.listeners[ev] = node.listeners[ev] || []).push(fn); };
    node.querySelector = () => null; node.setAttribute = () => {}; node.classList = { toggle() {} };
    return node;
  };
  const els = {};
  for (const k of ["eyebrow", "status", "controls", "partner", "ack", "compare", "warn", "cols", "mine", "theirs", "mineDrops", "theirsDrops", "result", "provenance"]) els[k] = mk();
  return { els, mk };
}
function scriptedSession() {
  const listeners = new Set();
  const s = { committed: null, err: null, id: null, refreshImpl: null, catalogAt: 1000 };
  const api = {
    bundle: () => s.committed, error: () => s.err, identity: () => s.id,
    chipText: (b) => b.myRosterStatus === "found" ? "found" : "Could not uniquely match this account to a roster in this league.",
    catalog: async () => ({ p1: { position: "RB", full_name: "A", team: "X" }, p2: { position: "WR", full_name: "B", team: "Y" }, p3: { position: "RB", full_name: "C", team: "Z" } }),
    catalogFetchedAt: () => s.catalogAt,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    refresh: opts => s.refreshImpl(opts),
    isSuperseded: e => !!(e && e.superseded),
    identifyRoster: Session.identifyRoster,
    commit(b) { s.committed = b; for (const fn of [...listeners]) fn({ state: "ready", bundle: b }); },
  };
  return { api, s };
}
const tick = () => new Promise(r => setImmediate(r));
async function initSmoke() {
  const { els, mk } = stubDom();
  const { api: Sess, s } = scriptedSession();
  const league = { league_id: "L1", name: "Lg", season: 2026, status: "in_season", total_rosters: 2, roster_positions: ["RB", "WR", "BN", "BN"], settings: {} };
  const remaining = { schema_version: 1, horizon: "remaining_season", status: "experimental", evaluation: null, league: { league_id: "L1" }, season: 2026, start_week: 3, end_week: 17, generated_at: "g", data_through: "d", players: [] };
  const analyzed = [];
  global.window = {
    Session: Sess,
    Sleeper: { get: async path => { if (path.endsWith("/traded_picks")) return []; throw new Error(`unexpected fetch ${path}`); } },
    FC: { loadJSON: async () => remaining, leagueDataPath: k => k },
    Trade: { defaultPicks: () => new Map(), applyTradedPicks: () => {} }, Keepers: { DRAFT_ROUNDS: 1 },
    SeasonTrade: { analyze: args => { analyzed.push(args); return { weeks: [{ week: 4, sides: [{ before: { total: 1, lineup: [] }, after: { total: 1, lineup: [] }, delta: 0 }, { before: { total: 1, lineup: [] }, after: { total: 1, lineup: [] }, delta: 0 }] }], sides: [{ rosterId: 1, delta: 0 }, { rosterId: 2, delta: 0 }], warnings: [] }; } },
    ROS: { evaluationText: () => [] },
  };
  global.document = { createElement: () => mk(), createTextNode: t => t };
  try {
    const board = { league: { name: "Lg", league_id: "L1" } };
    M.init({ board, league, slug: "lg", els });
    // 1. no bundle, no identity: everything hidden, gate text shown
    assert.equal(els.controls.hidden, true); assert.equal(els.cols.hidden, true); assert.equal(els.result.hidden, true);
    assert.match(els.status.textContent, /league panel/);
    // 2. bundle without a unique roster: still hidden, the exact-matcher message
    s.id = { userId: "u1", username: "me" };
    const rosters = [{ roster_id: 1, owner_id: "u1", players: ["p1"], reserve: [], taxi: [] }, { roster_id: 2, owner_id: "u2", players: ["p2", "p3"], reserve: [], taxi: [] }];
    const users = [{ user_id: "u1", display_name: "Me" }, { user_id: "u2", display_name: "Them" }];
    const state = { week: 3, season: "2026", season_type: "regular" };
    const mkBundle = (extra) => Object.freeze({ registry: {}, identity: s.id, league, users, rosters, state, rostersRequestedAt: 10, rostersFetchedAt: 20, myRoster: rosters[0], myRosterStatus: "found", warnings: [], ...extra });
    Sess.commit(mkBundle({ myRoster: null, myRosterStatus: "none" }));
    await tick(); await tick();
    assert.equal(els.cols.hidden, true); assert.match(els.status.textContent, /Could not uniquely match/);
    // 3. found: columns drawn from the bundle's rosters, no Sleeper roster fetch
    Sess.commit(mkBundle({}));
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(els.cols.hidden, false); assert.equal(els.controls.hidden, false);
    assert.match(els.status.textContent, /2 teams loaded — you are Me/);
    assert.match(els.provenance.textContent, /Player catalog fetched 1970-01-01T00:00:01\.000Z/);
    // select p1 to give, ack, then compare: the refresh commits a NEW bundle
    // (adopted, not reloaded) and analyze gets its rosters and rostersFetchedAt.
    const row = els.mine.children.find(li => li.dataset.id === "p1");
    const box = row.children[0].children[0];
    box.checked = true; for (const fn of box.listeners.change) fn();
    els.ack.checked = true; for (const fn of els.ack.listeners.change) fn();
    assert.equal(els.compare.disabled, false, "compare enabled once inputs are valid");
    const fresh = mkBundle({ rostersRequestedAt: 100, rostersFetchedAt: Date.now() });
    let refreshOpts = null;
    s.refreshImpl = async opts => { refreshOpts = opts; Sess.commit(fresh); return fresh; };
    for (const fn of els.compare.listeners.click) await fn();
    assert.deepEqual(refreshOpts, { scope: "rosters" });
    assert.equal(analyzed.length, 1, "compare ran against the refreshed bundle");
    assert.equal(analyzed[0].snapshotAt, fresh.rostersFetchedAt, "snapshotAt is the NEW bundle's post-fetch time");
    assert.equal(analyzed[0].rosters, fresh.rosters);
    assert.equal(els.result.hidden, false);
    // 4. a foreign bundle (different account) arriving mid-compare invalidates it
    const other = mkBundle({ identity: { userId: "u2" }, myRoster: rosters[1], rostersFetchedAt: Date.now() });
    s.refreshImpl = async () => { s.id = { userId: "u2" }; Sess.commit(other); return other; };
    box.checked = true; for (const fn of box.listeners.change) fn();
    const before = analyzed.length;
    for (const fn of els.compare.listeners.click) await fn();
    assert.equal(analyzed.length, before, "no analyze after the account changed under the compare");
    for (let i = 0; i < 5; i++) await tick();
    assert.match(els.status.textContent, /2 teams loaded — you are Them/, "the foreign bundle reloaded the columns for the new account");
    // 5. losing the roster hides everything again
    s.id = null;
    Sess.commit(mkBundle({ identity: null, myRoster: null, myRosterStatus: "anonymous" }));
    assert.equal(els.cols.hidden, true); assert.equal(els.result.hidden, true); assert.equal(els.controls.hidden, true);
    assert.match(els.status.textContent, /league panel/);
  } finally { delete global.window; delete global.document; }
}
initSmoke().then(() => { n++; console.log(`seasontrademode_fixture: ${n} groups OK`); },
  e => { e.message = `init under a scripted session: ${e.message}`; console.error(e); process.exit(1); });
