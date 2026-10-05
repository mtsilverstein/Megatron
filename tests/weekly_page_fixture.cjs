// tests/weekly_page_fixture.cjs — run with: node tests/weekly_page_fixture.cjs
//
// weekly.html's own projection-table script (the inline block after
// StartSitMode.init()), run as written under a fake DOM with its
// collaborators stubbed. Pins the M1 invalidation contract on the page side
// (any-league spec §5.2): a cleared view from StartSitMode.onView drops the
// league title and the "Your league" lens until a replacement view is valid,
// and the user's own lens choice survives the clear. Synthetic data only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "site", "weekly.html"), "utf8");
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const source = inline.find(s => s.includes("StartSitMode.onView"));
assert.ok(source, "weekly.html's table script");

function element(tagName, text = "") {
  const el = {
    tagName, textContent: text, innerHTML: "", className: "", style: {}, dataset: {}, attrs: {}, listeners: {},
    children: tagName === "tr" ? Array.from({ length: 8 }, () => element("td")) : [],
    append(...n) { el.children.push(...n); }, appendChild(n) { el.children.push(n); return n; },
    replaceChildren(...n) { el.children = [...n]; },
    setAttribute(k, v) { el.attrs[k] = v; }, getAttribute(k) { return el.attrs[k]; },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); },
    click() { for (const fn of el.listeners.click || []) fn({}); },
  };
  return el;
}
const ids = {};
for (const [id, text] of [["weekly-title", "This week's slate"], ["week-eyebrow", ""], ["scoring-filters", ""], ["pos-filters", ""],
  ["slate", ""], ["pts-header", ""], ["expert-status", ""],
  ["lens-status", "Your league's scoring loads with the league; PPR, half-PPR and standard are shown until then."]]) ids[id] = element("div", text);
const tbody = element("tbody"), stamp = element("p");
const document = {
  getElementById: id => ids[id] || null,
  createElement: tag => element(tag),
  querySelector: sel => sel === "#slate tbody" ? tbody : sel === ".stamp" ? stamp : null,
  querySelectorAll: () => [],
};
let handler = null;
const weekly = { season: 2026, week: 3, model: "transformer", players: [
  { player_id: "p1", name: "A Back", team: "X", opponent: "Y", is_home: true, position: "RB",
    points: { ppr: { p10: 1, p50: 2, p90: 3 }, half_ppr: { p10: 1, p50: 2, p90: 3 }, standard: { p10: 1, p50: 2, p90: 3 } } }] };
const ctx = vm.createContext({
  document, console, Map, Set, Promise, Object, Array, String, Number,
  FC: { leagueNavigation() {}, setLeague() {}, inSeasonLeague: () => ({ leagueId: "900000000000000777" }), stampHeader() {},
    posFilter() {}, makeSortable() {}, fmt: x => String(x), esc: x => String(x), POS_CLASS: {},
    loadJSON: () => Promise.reject(new Error("no expert file in this fixture")) },
  Bands: { sharedDomain: () => null, quantileGeometry: () => ({ ok: false, med: null }) },
  WeeklyExperts: { prepare: () => new Map() },
  StartSitMode: { batch: async () => ({ weekly }), onView(fn) { handler = fn; return () => {}; } },
});

const leagueView = (name, p50) => ({ league: { name }, error: null,
  view: { weekly: { players: [{ player_id: "p1", points: { league: { p10: p50 - 1, p50, p90: p50 + 1 } } }] },
    disclosures: { banner: null, footnotes: [] } } });
const CLEARED = { league: null, view: null, error: null, cleared: true };
const buttons = () => ids["scoring-filters"].children.map(b => b.textContent);
const pressed = () => ids["scoring-filters"].children.find(b => b.attrs["aria-pressed"] === "true").textContent;
const title = () => ids["weekly-title"].textContent;
const DEFAULT_STATUS = ids["lens-status"].textContent;

(async () => {
  await vm.runInContext(source, ctx);
  assert.equal(typeof handler, "function", "the table subscribes to StartSitMode.onView");
  assert.equal(title(), "This week's slate");
  assert.deepEqual(buttons(), ["PPR", "HALF-PPR", "STANDARD"]);

  // A valid league view: title, the "Your league" lens, selected by default.
  handler(leagueView("League A", 10));
  assert.equal(title(), "League A — this week's slate");
  assert.deepEqual(buttons(), ["YOUR LEAGUE", "PPR", "HALF-PPR", "STANDARD"]);
  assert.equal(pressed(), "YOUR LEAGUE");
  assert.equal(ids["pts-header"].textContent, "Proj (p50, your league)");

  // Invalidation: title and lens drop until a replacement is valid.
  handler(CLEARED);
  assert.equal(title(), "This week's slate", "a cleared view must not keep the previous league's title");
  assert.deepEqual(buttons(), ["PPR", "HALF-PPR", "STANDARD"], "no 'Your league' lens while invalid");
  assert.equal(pressed(), "PPR");
  assert.equal(ids["lens-status"].textContent, DEFAULT_STATUS);
  assert.equal(ids["pts-header"].textContent, "Proj (p50, ppr)");

  // A successful switch: the replacement league's lens returns.
  handler(leagueView("League B", 20));
  assert.equal(title(), "League B — this week's slate");
  assert.equal(pressed(), "YOUR LEAGUE");

  // A failed replacement after a clear: the error view (no league view) keeps the lens off.
  handler(CLEARED);
  handler({ league: null, view: null, error: new Error("Sleeper has no league with id 9.") });
  assert.equal(title(), "This week's slate");
  assert.deepEqual(buttons(), ["PPR", "HALF-PPR", "STANDARD"]);
  assert.match(ids["lens-status"].textContent, /unavailable \(Sleeper has no league with id 9\.\)/);

  // The user's own choice survives a clear: PPR stays PPR; "Your league" comes back as "Your league".
  handler(leagueView("League B", 20));
  ids["scoring-filters"].children.find(b => b.textContent === "PPR").click();
  handler(CLEARED); handler(leagueView("League C", 30));
  assert.equal(pressed(), "PPR", "an explicit PPR pick is kept");
  ids["scoring-filters"].children.find(b => b.textContent === "YOUR LEAGUE").click();
  handler(CLEARED);
  assert.equal(pressed(), "PPR");
  handler(leagueView("League D", 40));
  assert.equal(pressed(), "YOUR LEAGUE", "an explicit 'Your league' pick returns with the replacement");
  console.log("weekly_page_fixture: cleared view drops title and league lens; replacement restores; picks survive OK");
})().catch(e => { console.error(e); process.exit(1); });
