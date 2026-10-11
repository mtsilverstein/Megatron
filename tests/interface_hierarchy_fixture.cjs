const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pages = [
  ["index.html", "index.html"],
  ["weekly.html", "weekly.html"],
  ["waivers.html", "waivers.html"],
  ["trade.html", "trade.html"],
  ["about.html", "about.html"],
  ["connect.html", null],
];
const expectedNav = ["weekly.html", "waivers.html", "trade.html", "index.html", "about.html"];

function readPage(name) {
  return fs.readFileSync(path.join(root, "site", name), "utf8");
}

function mastheadNav(html) {
  const header = html.match(/<header\b[^>]*class=["'][^"']*\bmasthead\b[^"']*["'][^>]*>([\s\S]*?)<\/header>/i);
  assert.ok(header, "masthead header is present");
  const nav = header[1].match(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/i);
  assert.ok(nav, "masthead navigation is present");
  return nav;
}

for (const [page, current] of pages) {
  const html = readPage(page);
  const nav = mastheadNav(html);
  assert.match(nav[1], /aria-label=["']Main navigation["']/i, `${page} labels its main navigation`);
  const links = [...nav[2].matchAll(/<a\b([^>]*)href=["']([^"']+)["'][^>]*>/gi)];
  assert.deepEqual(links.map((link) => link[2]), expectedNav, `${page} uses the shared navigation order`);
  const currentLinks = links.filter((link) => /aria-current=["']page["']/i.test(link[0]));
  assert.equal(currentLinks.length, current ? 1 : 0, `${page} keeps its current-page marker`);
  if (current) assert.equal(currentLinks[0][2], current, `${page} marks its own destination current`);
}

// Every text-entry control needs an accessible name that survives typing. A
// placeholder alone disappears the moment the shared username auto-fill puts
// a value in the box, so an input must carry aria-label, sit inside a <label>,
// or be referenced by label[for].
for (const [page] of pages) {
  const html = readPage(page);
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    if (/\btype=["'](checkbox|radio|hidden|submit)["']/i.test(tag)) continue;
    if (/\baria-label=["'][^"']+["']/i.test(tag)) continue;
    const id = (tag.match(/\bid=["']([^"']+)["']/i) || [])[1];
    if (id && new RegExp(`<label\\b[^>]*for=["']${id}["']`, "i").test(html)) continue;
    const before = html.slice(0, match.index);
    const openLabel = before.lastIndexOf("<label");
    const closeLabel = before.lastIndexOf("</label>");
    assert.ok(openLabel > closeLabel, `${page}: input lacks an accessible name beyond its placeholder: ${tag}`);
  }
}

// The compact mobile masthead tightens spacing; it must not hide the nav or
// the "data as of" stamp, which are load-bearing for support disclosure.
{
  const css = fs.readFileSync(path.join(root, "site", "assets", "style.css"), "utf8");
  const mobile = css.match(/@media \(max-width: 560px\) \{[\s\S]*?\.masthead nav \{[^}]*\}[\s\S]*?\n\}/);
  assert.ok(mobile, "mobile masthead rules live in the 560px block");
  assert.doesNotMatch(mobile[0], /\.masthead nav[^{]*\{[^}]*(display:\s*none|overflow(-x)?:\s*(auto|scroll|hidden))/,
    "mobile nav must wrap, not hide or scroll links out of view");
  assert.doesNotMatch(mobile[0], /\.stamp[^{]*\{[^}]*display:\s*none/, "mobile stamp stays visible");
}

const waivers = readPage("waivers.html");
const ids = [...waivers.matchAll(/\bid=["']([^"']+)["']/gi)].map((match) => match[1]);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
assert.deepEqual(duplicates, [], "waiver IDs are unique");

// The waiver page answers "who do I claim" top to bottom: summary line ->
// settings (week, budget to keep, position, protections) -> best move ->
// claim table -> worth watching -> copy shortlist -> how this works.
const at = id => waivers.indexOf(`id="${id}"`);
const ORDER = ["waiver-summary", "waiver-controls", "waiver-best", "waiver-table", "waiver-watching", "waiver-copy", "waiver-method"];
for (const id of ORDER) assert.ok(at(id) >= 0, `waiver landmark #${id} exists`);
assert.deepEqual([...ORDER].sort((a, b) => at(a) - at(b)), ORDER, "waiver sections appear in the approved order");
// Every setting sits in the settings row, above the results.
const controlsHtml = waivers.slice(at("waiver-controls"), waivers.indexOf("</div>", at("waiver-controls")));
for (const id of ["waiver-week", "waiver-reserve", "waiver-position", "waiver-protect-toggle"])
  assert.ok(controlsHtml.includes(`id="${id}"`), `#${id} is in the settings row`);
assert.match(controlsHtml, /<button type="button" id="waiver-protect-toggle"[^>]*aria-controls="waiver-protect"/, "the protection control is a real button that opens the editor");
assert.ok(at("waiver-protect") < at("waiver-best") && at("waiver-roster") > at("waiver-protect"), "the protection editor opens under the settings, before the results");
// Wording ruled in the astra review: a modeled label, and drop options compared, not picked.
assert.match(waivers, /<h2 id="waiver-best-heading">Modeled top option<\/h2>/);
assert.match(waivers, /compare drop options/); assert.doesNotMatch(waivers, /who to drop|Best move/);
// The display limit's toggle is a real button inside the claim section.
assert.match(waivers, /<p id="waiver-limit"[^>]*hidden><span id="waiver-limit-text"><\/span> <button type="button" id="waiver-show-all" aria-pressed="false"/);
assert.ok(at("waiver-show-all") > at("waiver-best") && at("waiver-show-all") < at("waiver-table"));
// The method's weak-signal item names the per-week move-value basis, like the engine's labels.
assert.ok(waivers.includes("Weak signals: an alternative whose move value (this week's gain plus the priced rest-of-season change, averaged per week through NFL week 17; this week's gain alone where the rest of season is not priced) is under 1.0 projected point per week stays listed"));
assert.ok(!waivers.includes("gaining under 1.0 projected point per week"));
// The live region for loading and errors is kept.
assert.match(waivers, /<p id="waiver-status" role="status" aria-live="polite">/);
// Fold-outs: Worth watching and How this works start collapsed; Worth watching
// holds the one merged research list and the bye bullets.
assert.match(waivers, /<details id="waiver-watching"(?![^>]*\bopen\b)[^>]*>\s*<summary>Worth watching/, "Worth watching starts collapsed");
assert.match(waivers, /<details id="waiver-method"(?![^>]*\bopen\b)[^>]*>\s*<summary>How this works · data and limits<\/summary>/, "the method fold starts collapsed");
const watchingHtml = waivers.slice(at("waiver-watching"), at("waiver-copy"));
for (const id of ["waiver-radar-sort", "waiver-radar", "waiver-watchlist", "waiver-byes"]) assert.ok(watchingHtml.includes(`id="${id}"`), `#${id} is inside Worth watching`);
assert.ok(!/<table id="waiver-radar"/.test(waivers), "the research radar is a list, not a dense table");
assert.match(waivers, /<ol id="waiver-watchlist"/, "the preseason part keeps its ECR order as an ordered list");
// Restored semantics: live regions on the role status, coverage and ROS lines.
assert.match(waivers, /<p id="waiver-role-source"[^>]*role="status"/);
assert.match(waivers, /<p id="waiver-coverage"[^>]*aria-live="polite"/);
assert.match(waivers, /<p id="waiver-ros"[^>]*aria-live="polite"/);
// The warnings signpost in the summary line points at the warnings in the method fold.
assert.match(waivers, /<a id="waiver-warning-link"[^>]*href="#waiver-warnings-heading"[^>]*hidden>/);
assert.ok(at("waiver-warning-link") < at("waiver-controls") && at("waiver-warnings-heading") > at("waiver-method"));
// Copy shortlist: one button; the text box is only the hidden fallback.
assert.match(waivers, /<button type="button" id="waiver-copy">Copy shortlist<\/button>/);
assert.match(waivers, /<div id="waiver-backup-wrap" hidden>/);
assert.ok(!waivers.includes('id="waiver-export"'), "the separate export button is gone");
// Data, timestamps, coverage, format lines, market sample and warnings live in the method fold.
const methodHtml = waivers.slice(at("waiver-method"));
for (const id of ["waiver-warnings", "waiver-count-detail", "waiver-table-notes", "waiver-context", "waiver-coverage", "waiver-ros", "waiver-source", "waiver-evaluation",
  "waiver-intel-source", "waiver-role-source", "waiver-market", "waiver-league-link"]) assert.ok(methodHtml.includes(`id="${id}"`), `#${id} is in How this works`);
assert.ok(methodHtml.includes("Data sources and timestamps"), "the data-sources heading the method list refers to is there");
// The claim table keeps real column headers.
assert.match(waivers, /<thead><tr><th scope="col">Add<\/th><th scope="col">Drop options \(rest of season\)<\/th><th scope="col">This week<\/th><th scope="col">Bid or priority<\/th><th scope="col">Signals<\/th><th scope="col">Why<\/th><\/tr><\/thead>/);

// The in-season branch must stamp the masthead from the remaining-season
// payload, not the draft board's -- a `FC.stampHeader(board)` call outside
// the pre_draft branch would show the wrong league's "data as of" and could
// trigger a false stale banner over live in-season numbers.
{
  const trade = readPage("trade.html");
  const stampCalls = [...trade.matchAll(/FC\.stampHeader\(board\)/g)];
  assert.equal(stampCalls.length, 1, "trade.html: FC.stampHeader(board) must be called exactly once");
  const preDraftAt = trade.indexOf("pre_draft");
  assert.ok(preDraftAt >= 0, "trade.html: pre_draft branch is present");
  assert.ok(stampCalls[0].index > preDraftAt,
    "trade.html: FC.stampHeader(board) must only run in the pre_draft branch, not in_season");
}

console.log("interface hierarchy fixture passed");
