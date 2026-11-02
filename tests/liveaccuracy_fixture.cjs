// tests/liveaccuracy_fixture.cjs — run with: node tests/liveaccuracy_fixture.cjs
//
// The about page's "This season, scored live" section and the weekly footer line
// (site/assets/liveaccuracy.js) over site/data/live-accuracy.json: the text says
// exactly what the scorecard measured (PPR, played players, published-before
// projections), provisional weeks are marked, and a missing or unexpected file
// shows nothing at all.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../site/assets/liveaccuracy.js");

const cell = (n, mae, naive, cov, below, above) => ({ n, mae, naive_mae: naive, coverage_p10_p90: cov, below_p10: below, above_p90: above });
const DATA = {
  schema_version: 1, kind: "live_accuracy", protocol_version: "live-accuracy-v1", season: 2026, scoring: "ppr",
  as_of_date: "2026-10-28", run_at: "2026-10-28T19:09:00Z", source: "models/diagnostics/live_2026_weekly.json",
  overall: cell(2326, 4.3074, 4.6270, 0.7979, 0.0886, 0.1135),
  weeks: [{ week: 1, last_game: "2026-09-14", provisional: false, ...cell(309, 4.81, 5.08, 0.764, 0.10, 0.136) },
          { week: 7, last_game: "2026-10-26", provisional: true, ...cell(305, 4.207, 4.4698, 0.80, 0.0918, 0.1082) }],
  provisional_weeks: [7], weeks_skipped: [], caveats: [],
};
const clone = x => JSON.parse(JSON.stringify(x));

// ---- text --------------------------------------------------------------------
assert.equal(L.valid(DATA), true);
assert.equal(L.lead(DATA), "2026 season, weeks 1–7 (week 7 provisional): mean absolute error 4.31 PPR points per player-week, against 4.63 for the naive last-four-games average, over 2,326 player-weeks. 79.8% of outcomes landed inside the floor–ceiling (p10–p90) band; the target is 80%.");
assert.deepEqual(L.rows(DATA), [
  ["1", "309", "4.81", "5.08", "76.4%", "10.0% / 13.6%"],
  ["7 (provisional)", "305", "4.21", "4.47", "80.0%", "9.2% / 10.8%"],
  ["Season", "2,326", "4.31", "4.63", "79.8%", "8.9% / 11.3%"],
]);
assert.equal(L.footerLine(DATA), "Live 2026 (PPR, through week 7): average error 4.31 vs 4.63 for the naive last-four-games average; 79.8% of outcomes inside the band. Details on the about page.");
{ const one = clone(DATA); one.weeks = [one.weeks[0]]; one.provisional_weeks = [];
  assert.match(L.lead(one), /^2026 season, week 1: mean absolute error/, "one week, nothing provisional"); }
assert.match(L.NOTE, /^Scored in PPR from the projections this site published before each week's first game/);

// ---- anything unexpected shows nothing ------------------------------------------
for (const [name, mutate] of Object.entries({
  "null": () => null,
  "wrong kind": d => { d.kind = "other"; return d; },
  "wrong schema": d => { d.schema_version = 2; return d; },
  "not PPR": d => { d.scoring = "half_ppr"; return d; },
  "no weeks": d => { d.weeks = []; return d; },
  "NaN error": d => { d.weeks[0].mae = NaN; return d; },
  "string n": d => { d.overall.n = "2326"; return d; },
  "missing coverage": d => { delete d.overall.coverage_p10_p90; return d; },
})) assert.equal(L.valid(mutate(clone(DATA))), false, name);

// ---- DOM: the section fills and unhides; a bad file leaves it hidden ---------------
function element(tagName) {
  const el = { tagName, children: [], textContent: "", className: "", hidden: false, href: "", ownerDocument: null,
    append(...n) { el.children.push(...n); }, replaceChildren(...n) { el.children = [...n]; } };
  return el;
}
const doc = { createElement: tag => { const e = element(tag); e.ownerDocument = doc; return e; } };
const mkEls = () => { const els = { section: doc.createElement("section"), lead: doc.createElement("p"), table: doc.createElement("div"), note: doc.createElement("p") }; els.section.hidden = true; return els; };
const all = n => [n, ...n.children.flatMap(all)];
(async () => {
  const els = mkEls();
  assert.equal(await L.load(els, async () => clone(DATA)), true);
  assert.equal(els.section.hidden, false);
  assert.equal(els.lead.textContent, L.lead(DATA));
  const table = els.table.children[0];
  assert.equal(table.tagName, "table");
  const [thead, tbody] = table.children;
  assert.deepEqual(thead.children[0].children.map(th => th.textContent), L.HEAD);
  assert.deepEqual(thead.children[0].children.map(th => th.className), ["", "num", "num", "num", "num", "num"], "numeric headers align with their numbers");
  assert.deepEqual(tbody.children.map(tr => tr.children.map(td => td.textContent)), L.rows(DATA));
  assert.equal(tbody.children.at(-1).className, "overall", "the season row is marked");
  assert.ok(tbody.children[0].children.slice(1).every(td => td.className === "num") && tbody.children[0].children[0].className === "");
  assert.ok(els.note.textContent.startsWith(L.NOTE) && els.note.textContent.includes("Updated 2026-10-28."));
  const link = all(els.note).find(n => n.tagName === "a");
  assert.equal(link.href, "https://github.com/mtsilverstein/Megatron/blob/main/models/diagnostics/live_2026_weekly.md");
  // Missing file (a fetch error) or a bad one: the section stays hidden, nothing is written.
  for (const loader of [async () => { throw new Error("HTTP 404"); }, async () => ({ kind: "other" })]) {
    const e2 = mkEls();
    assert.equal(await L.load(e2, loader), false);
    assert.equal(e2.section.hidden, true); assert.equal(e2.lead.textContent, ""); assert.equal(e2.table.children.length, 0);
  }
  // The footer line.
  const line = element("span");
  assert.equal(await L.loadLine(line, async () => clone(DATA)), true);
  assert.equal(line.textContent, L.footerLine(DATA));
  const empty = element("span");
  assert.equal(await L.loadLine(empty, async () => { throw new Error("HTTP 404"); }), false);
  assert.equal(empty.textContent, "");
  // The committed site file (generated from the real scorecard) passes the page's checks.
  const real = path.join(__dirname, "..", "site", "data", "live-accuracy.json");
  if (fs.existsSync(real)) assert.equal(L.valid(JSON.parse(fs.readFileSync(real, "utf8"))), true, "site/data/live-accuracy.json");
  console.log("liveaccuracy_fixture: lead, table rows, footer line, provisional marking, validation, hidden-on-missing OK");
})().catch(e => { console.error(e); process.exit(1); });
