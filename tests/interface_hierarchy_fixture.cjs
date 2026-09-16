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
const expectedNav = ["weekly.html", "waivers.html", "index.html", "trade.html", "about.html"];

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

const waivers = readPage("waivers.html");
const ids = [...waivers.matchAll(/\bid=["']([^"']+)["']/gi)].map((match) => match[1]);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
assert.deepEqual(duplicates, [], "waiver IDs are unique");

const countAt = waivers.indexOf('id="waiver-count"');
const tableAt = waivers.indexOf('id="waiver-table"');
const protectionAt = waivers.indexOf("Protect players from drop suggestions");
const radarAt = waivers.indexOf('id="waiver-radar"');
assert.ok(countAt >= 0 && tableAt >= 0 && protectionAt >= 0 && radarAt >= 0, "waiver hierarchy landmarks exist");
assert.ok(countAt < radarAt && tableAt < radarAt && protectionAt < radarAt, "shortlist and drop protection appear before the research radar");

const coverageAt = waivers.indexOf('id="waiver-coverage"');
const sourcesAt = waivers.indexOf("Data sources and timestamps");
const sourceAt = waivers.indexOf('id="waiver-source"');
assert.ok(sourcesAt >= 0 && sourceAt > sourcesAt, "source provenance is inside the data-sources disclosure");
assert.ok(coverageAt >= 0 && coverageAt < sourcesAt, "coverage remains visible outside the data-sources disclosure");
assert.doesNotMatch(waivers, /<details\b[^>]*\bopen\b[^>]*>\s*<summary>Available watchlist/i, "preseason watchlist starts collapsed");

console.log("interface hierarchy fixture passed");
