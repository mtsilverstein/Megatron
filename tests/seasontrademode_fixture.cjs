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
// --- plain-English lineup summary -----------------------------------------
// Built only from the engine's per-week before/after starting lineups.
const P = (id, name, slot) => ({ id, name, slot, points: 0, status: "conditional_projection" });
const BASE0 = [P("h", "Justin Herbert", "QB"), P("r1", "Bijan Robinson", "RB"), P("w1", "Chris Olave", "WR")];
const BASE1 = [P("d", "Dak Prescott", "QB"), P("r2", "Jaylen Warren", "RB"), P("w2", "Jalen Coker", "WR")];
const swap = (lineup, outId, inP) => lineup.map(p => (p.id === outId ? inP : p));
const KYLER = P("k", "Kyler Murray", "QB"), HERBERT = P("h", "Justin Herbert", "QB");
function mkResult(changes, first = 4, last = 17) {
  // changes: { [week]: [side0 {after, delta} | null, side1 ... | null] }
  const weeks = [];
  for (let w = first; w <= last; w++) {
    const c = changes[w] || [null, null];
    const sides = [BASE0, BASE1].map((base, i) => {
      const ch = c[i];
      return { rosterId: i + 1, before: { total: 100, lineup: base }, after: { total: 100 + (ch ? ch.delta : 0), lineup: ch ? ch.after : base }, delta: ch ? ch.delta : 0 };
    });
    weeks.push({ week: w, sides });
  }
  return { weeks, sides: [0, 1].map(i => ({ rosterId: i + 1, delta: weeks.reduce((n, wk) => n + wk.sides[i].delta, 0) })) };
}
const sumCtx = { names: { 1: "Bake God", 2: "Easy Breecey" }, firstWeek: 4, endWeek: 17 };
const herbertForKyler = mkResult({
  5: [null, { after: swap(BASE1, "d", HERBERT), delta: 7.87 }],
  8: [{ after: swap(BASE0, "h", KYLER), delta: -6.06 }, null],
});
check("lineupSummary: a one-week change on each side names who enters and leaves", () => {
  assert.deepEqual(M.lineupSummary(herbertForKyler, sumCtx), [
    "Your lineup: −6.1 pts over weeks 4–17. All of it is week 8: Kyler Murray starts instead of Justin Herbert.",
    "Easy Breecey: +7.9 pts over weeks 4–17. All of it is week 5: Justin Herbert starts instead of Dak Prescott.",
  ]);
});
const manyWeeks = mkResult({
  5: [{ after: swap(BASE0, "h", KYLER), delta: 1.0 }, null],
  6: [{ after: swap(BASE0, "h", KYLER), delta: 4.0 }, null],
  7: [{ after: swap(swap(BASE0, "h", KYLER), "w1", P("w9", "Rome Odunze", "WR")), delta: -3.5 }, null],
  9: [{ after: swap(BASE0, "h", KYLER), delta: 5.0 }, null],
  10: [{ after: swap(BASE0, "h", KYLER), delta: 0.5 }, null],
  11: [{ after: swap(BASE0, "h", KYLER), delta: 2.0 }, null],
});
check("lineupSummary: many changed weeks -> the 3 largest named, the rest summarised", () => {
  assert.deepEqual(M.lineupSummary(manyWeeks, sumCtx), [
    "Your lineup: +9.0 pts over weeks 4–17. Lineup changes in 6 weeks; the 3 largest: week 9 (+5.0): Kyler Murray starts instead of Justin Herbert; week 6 (+4.0): Kyler Murray starts instead of Justin Herbert; week 7 (−3.5): Kyler Murray and Rome Odunze start instead of Justin Herbert and Chris Olave; and smaller changes in 3 other weeks (+3.5 pts combined).",
    "Easy Breecey: 0.0 pts over weeks 4–17. No change to the starting lineup.",
  ]);
  const two = M.lineupSummary(mkResult({ 6: [{ after: swap(BASE0, "h", KYLER), delta: -1.0 }, null], 9: [{ after: swap(BASE0, "h", KYLER), delta: 2.25 }, null] }), sumCtx);
  assert.equal(two[0], "Your lineup: +1.3 pts over weeks 4–17. Lineup changes in 2 weeks: week 9 (+2.3): Kyler Murray starts instead of Justin Herbert; week 6 (−1.0): Kyler Murray starts instead of Justin Herbert.");
});
check("lineupSummary: nothing changes -> one sentence for both lineups", () => {
  assert.deepEqual(M.lineupSummary(mkResult({}), sumCtx), ["No change to either starting lineup in weeks 4–17 under these assumptions."]);
});
check("lineupSummary strings carry no forbidden or judging word", () => {
  const all = [herbertForKyler, manyWeeks, mkResult({})].flatMap(r => M.lineupSummary(r, sumCtx)).join("\n").toLowerCase();
  for (const w of [...M.FORBIDDEN, "better", "worse", "should"]) assert.ok(!all.includes(w), `"${w}" in summary: ${all}`);
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
  // How compare() uses Session.refresh (scope, the refreshed bundle's
  // rostersFetchedAt as snapshotAt, moved players, superseded results) is
  // checked by RUNNING it in initSmoke below, not by grepping the source.
  assert.ok(!/season-user|season-load/.test(html), "trade.html has no in-season username input or load button");
  assert.ok(/seasontrademode\.js\?v=ux1/.test(html), "cache key bumped for the usability controller");
  assert.ok(!/season-ack/.test(html) && !/els\.ack\b/.test(src), "no acknowledgment checkbox gates the compare");
  assert.ok(/id="season-steps"/.test(html), "the three-step guide is on the page");
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
  for (const k of ["eyebrow", "status", "controls", "partner", "compare", "warn", "cols", "mine", "theirs", "mineDrops", "theirsDrops", "result", "provenance"]) els[k] = mk();
  return { els, mk };
}
function scriptedSession() {
  const listeners = new Set();
  const s = { committed: null, err: null, id: null, refreshImpl: null, catalogAt: 1000 };
  const api = {
    bundle: () => s.committed, error: () => s.err, identity: () => s.id,
    chipText: (b) => b.myRosterStatus === "found" ? "found" : "Could not uniquely match this account to a roster in this league.",
    catalog: async () => ({ p1: { position: "RB", full_name: "A", team: "X" }, p2: { position: "WR", full_name: "B", team: "Y" }, p3: { position: "RB", full_name: "C", team: "Z", injury_status: "Questionable" } }),
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
  global.document = { createElement: tag => Object.assign(mk(), { tagName: String(tag).toUpperCase() }), createTextNode: t => t };
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
    // select p1 to give, then compare (no acknowledgment step): the refresh
    // commits a NEW bundle (adopted, not reloaded) and analyze gets its
    // rosters and rostersFetchedAt.
    const row = els.mine.children.find(li => li.dataset.id === "p1");
    const box = row.children[0].children[0];
    const part = (li, cls) => li.children.find(c => c.className === cls);
    assert.equal(part(row, "season-weeks").hidden, true, "no week field on an unticked, untagged player");
    assert.equal(part(row, "season-weeks-toggle").hidden, true, "no reveal link before the player is ticked");
    assert.equal(els.compare.disabled, true, "nothing ticked yet");
    box.checked = true; for (const fn of box.listeners.change) fn();
    assert.equal(els.compare.disabled, false, "compare enabled as soon as a player is ticked -- no acknowledgment gate");
    assert.equal(part(row, "season-weeks").hidden, true, "the week field stays hidden for a ticked, untagged player");
    const toggle = part(row, "season-weeks-toggle");
    assert.equal(toggle.hidden, false); assert.equal(toggle.textContent, "Out some weeks? (optional)");
    for (const fn of toggle.listeners.click) fn();
    assert.equal(part(row, "season-weeks").hidden, false, "the link reveals the field");
    assert.equal(toggle.hidden, true);
    assert.equal(part(row, "season-weeks").placeholder, "optional — leave blank if he plays, e.g. 3-5");
    const tagged = els.theirs.children.find(li => li.dataset.id === "p3");
    assert.equal(part(tagged, "season-weeks").hidden, false, "a tagged player's field is revealed automatically");
    assert.equal(part(tagged, "season-weeks-toggle").hidden, true);
    assert.equal(els.compare.disabled, false, "an empty week field is not an error");
    const fresh = mkBundle({ rostersRequestedAt: 100, rostersFetchedAt: Date.now() });
    let refreshOpts = null;
    s.refreshImpl = async opts => { refreshOpts = opts; Sess.commit(fresh); return fresh; };
    for (const fn of els.compare.listeners.click) await fn();
    assert.deepEqual(refreshOpts, { scope: "rosters" });
    assert.equal(analyzed.length, 1, "compare ran against the refreshed bundle");
    assert.equal(analyzed[0].snapshotAt, fresh.rostersFetchedAt, "snapshotAt is the NEW bundle's post-fetch time");
    assert.equal(analyzed[0].rosters, fresh.rosters);
    assert.equal(analyzed[0].assumeAvailable, true, "the engine still receives the availability assumption");
    assert.equal(els.result.hidden, false);
    // summary first, then the headline; the detail sections are collapsible
    assert.equal(els.result.children[0].className, "season-summary");
    assert.equal(els.result.children[0].children[0].textContent, "No change to either starting lineup in weeks 4–4 under these assumptions.");
    const details = els.result.children.filter(c => c.tagName === "DETAILS");
    assert.deepEqual(details.map(d => d.children[0].textContent), ["Week-by-week lineup totals", "Assumptions", "Engine notes", "Measured evaluation"]);
    assert.ok(details.every(d => d.children[0].tagName === "SUMMARY"));
    // 3b. the refresh brings rosters in which a SELECTED player moved (p1 is
    // now on roster 2): no analyze, the CHANGED outcome, columns redrawn from
    // the fresh snapshot (p1 now listed under "you get").
    const movedRosters = [{ roster_id: 1, owner_id: "u1", players: [], reserve: [], taxi: [] }, { roster_id: 2, owner_id: "u2", players: ["p1", "p2", "p3"], reserve: [], taxi: [] }];
    const moved = mkBundle({ rosters: movedRosters, myRoster: movedRosters[0], rostersRequestedAt: 200, rostersFetchedAt: Date.now() });
    s.refreshImpl = async () => { Sess.commit(moved); return moved; };
    assert.equal(els.compare.disabled, false, "p1 is still selected after the first compare");
    const analyzedBefore = analyzed.length;
    for (const fn of els.compare.listeners.click) await fn();
    assert.equal(analyzed.length, analyzedBefore, "no analyze when a selected player moved rosters");
    assert.equal(els.status.textContent, "Rosters changed since they were loaded — the columns were redrawn from the fresh snapshot; choose again.");
    assert.equal(els.result.hidden, true, "no stale scenario stays on screen");
    assert.ok(!els.mine.children.some(li => li.dataset.id === "p1"), "p1 is no longer offered on my side");
    assert.ok(els.theirs.children.some(li => li.dataset.id === "p1"), "p1 is drawn on the partner's side from the fresh rosters");
    assert.equal(els.compare.disabled, true, "selections were cleared by the redraw");
    // 3c. a superseded refresh (the session moved on) is swallowed: no
    // "comparison blocked", no analyze, the button re-enabled.
    const box2 = els.theirs.children.find(li => li.dataset.id === "p2").children[0].children[0];
    box2.checked = true; for (const fn of box2.listeners.change) fn();
    assert.equal(els.compare.disabled, false);
    s.refreshImpl = async () => { const e = new Error("Superseded by a newer request."); e.superseded = true; throw e; };
    for (const fn of els.compare.listeners.click) await fn();
    assert.equal(analyzed.length, analyzedBefore, "no analyze after a superseded refresh");
    assert.doesNotMatch(els.status.textContent, /comparison blocked/, "a superseded refresh is not an error");
    assert.equal(els.result.hidden, true);
    assert.equal(els.compare.disabled, false, "busy was released");
    // 3d. the same outcome from the partner's side: p1 (selected on "you get")
    // is back on roster 1 in the refreshed rosters -> CHANGED, columns redrawn
    // to the original layout (which step 4 below relies on).
    const box1b = els.theirs.children.find(li => li.dataset.id === "p1").children[0].children[0];
    box1b.checked = true; for (const fn of box1b.listeners.change) fn();
    const restored = mkBundle({ rostersRequestedAt: 300, rostersFetchedAt: Date.now() });
    s.refreshImpl = async () => { Sess.commit(restored); return restored; };
    for (const fn of els.compare.listeners.click) await fn();
    assert.equal(analyzed.length, analyzedBefore, "no analyze when a player selected on the partner's side moved");
    assert.equal(els.status.textContent, "Rosters changed since they were loaded — the columns were redrawn from the fresh snapshot; choose again.");
    assert.ok(els.mine.children.some(li => li.dataset.id === "p1"), "p1 is back on my side");
    // 4. a foreign bundle (different account) arriving mid-compare invalidates it
    const other = mkBundle({ identity: { userId: "u2" }, myRoster: rosters[1], rostersFetchedAt: Date.now() });
    s.refreshImpl = async () => { s.id = { userId: "u2" }; Sess.commit(other); return other; };
    const box4 = els.mine.children.find(li => li.dataset.id === "p1").children[0].children[0];
    box4.checked = true; for (const fn of box4.listeners.change) fn();
    assert.equal(els.compare.disabled, false);
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
