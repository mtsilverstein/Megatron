// tests/liveaccuracy_fixture.cjs — run with: node tests/liveaccuracy_fixture.cjs
//
// The about page's "This season, scored live" section and the weekly footer line
// (site/assets/liveaccuracy.js) over site/data/live-accuracy.json: the text says
// exactly what the scorecard measured (PPR, players who recorded a stat line,
// projections committed before kickoff), provisional weeks are marked, and a missing or unexpected file
// shows nothing at all.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../site/assets/liveaccuracy.js");

const cell = (n, mae, naive, cov, below, above) => ({ n, mae, naive_mae: naive, coverage_p10_p90: cov, below_p10: below, above_p90: above });
const DATA = {
  schema_version: 1, kind: "live_accuracy", protocol_version: "live-accuracy-v1", season: 2026, scoring: "ppr",
  as_of_date: "2026-10-28", run_at: "2026-10-28T19:09:00Z", source: "models/diagnostics/live_2026_weekly.json",
  overall: cell(620, 4.0956, 4.4129, 0.8081, 0.0839, 0.1080),
  weeks: [{ week: 6, last_game: "2026-10-19", provisional: false, ...cell(315, 3.98, 4.36, 0.816, 0.076, 0.108) },
          { week: 7, last_game: "2026-10-26", provisional: true, ...cell(305, 4.207, 4.4698, 0.80, 0.0918, 0.1082) }],
  provisional_weeks: [7], weeks_skipped: [], caveats: [],
};
const clone = x => JSON.parse(JSON.stringify(x));

// ---- text --------------------------------------------------------------------
assert.equal(L.valid(DATA), true);
assert.equal(L.lead(DATA), "2026 season, weeks 6–7 (week 7 provisional): mean absolute error 4.10 PPR points per player-week for players who recorded a stat line, against 4.41 for the naive last-four-games average, over 620 player-weeks. 80.8% of outcomes landed inside the floor–ceiling (p10–p90) band; the target is 80%.");
assert.deepEqual(L.rows(DATA), [
  ["6", "315", "3.98", "4.36", "81.6%", "7.6% / 10.8%"],
  ["7 (provisional)", "305", "4.21", "4.47", "80.0%", "9.2% / 10.8%"],
  ["Season", "620", "4.10", "4.41", "80.8%", "8.4% / 10.8%"],
]);
assert.equal(L.footerLine(DATA), "Live 2026 accuracy (PPR, players who recorded a stat line, weeks 6–7): average error 4.10 vs 4.41 for the naive last-four-games average; 80.8% of outcomes inside the band. Details on the about page.");
{ const one = clone(DATA); one.weeks = [one.weeks[0]]; one.provisional_weeks = []; one.overall.n = 315;
  assert.equal(L.valid(one), true);
  assert.match(L.lead(one), /^2026 season, week 6: mean absolute error/, "one week, nothing provisional"); }
// Opus review P2: a week the scorecard could not score is named, never silently left out.
{ const gap = clone(DATA);
  gap.weeks = [{ week: 4, provisional: false, ...cell(355, 4.26, 4.24, 0.82, 0.073, 0.107) }, ...gap.weeks];
  gap.overall.n = 975; gap.weeks_skipped = [{ week: 5, reason: "validation_failed" }];
  assert.equal(L.valid(gap), true);
  assert.equal(L.span(gap), "weeks 4 and 6–7");
  assert.match(L.lead(gap), /^2026 season, weeks 4 and 6–7 \(week 7 provisional\): .* Not scored: week 5 \(validation failed\)\.$/);
  assert.match(L.footerLine(gap), /weeks 4 and 6–7\): .* Not scored: week 5 \(validation failed\)\. Details on the about page\.$/);
  assert.equal(L.span({ weeks: [1, 2, 3, 5, 7, 8].map(week => ({ week })) }), "weeks 1–3, 5 and 7–8"); }
assert.match(L.NOTE, /^Scored in PPR from the projections committed to this site's repository before each week's first game \(proven by GitHub push records\)/);
assert.match(L.NOTE, /fewer if they have played fewer; a position average for a debut/);

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
  "rate above 1": d => { d.weeks[0].below_p10 = 1.2; return d; },
  "negative error": d => { d.overall.mae = -1; return d; },
  "season n is not the weekly sum": d => { d.overall.n = 2326; return d; },
  "weeks out of order": d => { d.weeks.reverse(); return d; },
  "duplicate week": d => { d.weeks[1].week = 6; return d; },
  "provisional flag disagrees": d => { d.weeks[1].provisional = false; return d; },
  "provisional week not scored": d => { d.provisional_weeks = [9]; return d; },
  "no as_of_date": d => { delete d.as_of_date; return d; },
  "skipped week is also scored": d => { d.weeks_skipped = [{ week: 6, reason: "x" }]; return d; },
  "skipped entry without reason": d => { d.weeks_skipped = [{ week: 5 }]; return d; },
})) assert.equal(L.valid(mutate(clone(DATA))), false, name);

// ---- DOM: the section fills and unhides; a bad file leaves it hidden ---------------
function element(tagName) {
  const el = { tagName, children: [], textContent: "", className: "", hidden: false, href: "", ownerDocument: null, attrs: {},
    append(...n) { el.children.push(...n); }, replaceChildren(...n) { el.children = [...n]; }, setAttribute(k, v) { el.attrs[k] = v; } };
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
  const [caption, thead, tbody] = table.children;
  assert.equal(caption.tagName, "caption"); assert.equal(caption.textContent, "2026 weekly accuracy, PPR"); assert.equal(caption.className, "visually-hidden");
  assert.deepEqual(thead.children[0].children.map(th => th.textContent), L.HEAD);
  assert.deepEqual(thead.children[0].children.map(th => th.className), ["", "num", "num", "num", "num", "num"], "numeric headers align with their numbers");
  assert.ok(thead.children[0].children.every(th => th.tagName === "th" && th.attrs.scope === "col"), "column headers are scoped");
  assert.deepEqual(tbody.children.map(tr => tr.children.map(td => td.textContent)), L.rows(DATA));
  assert.equal(tbody.children.at(-1).className, "overall", "the season row is marked");
  assert.ok(tbody.children.every(tr => tr.children[0].tagName === "th" && tr.children[0].attrs.scope === "row"), "each row is headed by its week");
  assert.ok(tbody.children[0].children.slice(1).every(td => td.tagName === "td" && td.className === "num"));
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
