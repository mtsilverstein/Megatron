// The selected board must survive full-page navigation without a shared
// localStorage preference that could cross two simultaneously open drafts.
const assert = require("assert");
global.window = {};
require("../site/assets/app.js");
const FC = window.FC;

function page(href) {
  const names = ["Draft board", "Trade calculator", "Weekly", "About the model", "FAAB & waivers"];
  const links = ["index.html", "trade.html", "weekly.html", "about.html", "waivers.html"].map((path, i) => ({
    href: path, textContent: names[i], getAttribute() { return this.href; },
  }));
  const choices = ["fam", "gabagool", "espnfam"].map(slug => ({
    href: `index.html?league=${slug}`, current: null,
    getAttribute() { return this.href; },
    setAttribute(_, value) { this.current = value; },
    removeAttribute() { this.current = null; },
  }));
  global.location = new URL(href);
  global.document = { querySelectorAll: selector =>
    selector === ".masthead nav a" ? links : choices };
  return { slug: FC.leagueNavigation(), links, choices };
}

const base = "https://example.test/Megatron/";
const fam = page(`${base}index.html?league=fam`);
assert.strictEqual(fam.slug, "fam");
assert.strictEqual(fam.links[0].href, `${base}index.html?league=fam`,
  "clicking the current draft tab must not switch leagues");
assert.strictEqual(fam.choices[0].current, "page");
assert.strictEqual(fam.choices[1].current, null);
assert.match(fam.links[1].textContent, /Gabagool/);
assert.doesNotMatch(fam.links[2].textContent, /Gabagool/);
for (const link of fam.links.slice(1)) {
  const otherPage = page(link.href);
  assert.strictEqual(otherPage.links[0].href, `${base}index.html?league=fam`,
    "returning from another page must restore the FAM board");
}
const gab = page(`${base}index.html`);
assert.strictEqual(gab.slug, "gabagool");
assert.strictEqual(gab.choices[1].current, "page");
assert.strictEqual(gab.links[0].href, `${base}index.html?league=gabagool`);
assert.strictEqual(page(fam.links[0].href).slug, "fam",
  "opening Gabagool in another tab must not alter FAM's URL");

// The ESPN league is a third board with no live draft path. It must select and
// round-trip like any other, and -- because trade.html and weekly.html are
// built for Gabagool alone -- it must carry the same "· Gabagool" label FAM
// does. That label rule keys on "not Gabagool", not on "is FAM".
const espn = page(`${base}index.html?league=espnfam`);
assert.strictEqual(espn.slug, "espnfam");
assert.strictEqual(espn.links[0].href, `${base}index.html?league=espnfam`,
  "clicking the current draft tab must not switch leagues");
assert.strictEqual(espn.choices[2].current, "page");
assert.strictEqual(espn.choices[0].current, null);
assert.strictEqual(espn.choices[1].current, null);
assert.match(espn.links[1].textContent, /Gabagool/,
  "trade.html is Gabagool-only and must say so on the ESPN board");
assert.doesNotMatch(espn.links[2].textContent, /Gabagool/);
assert.doesNotMatch(espn.links[4].textContent, /Gabagool/);
for (const link of espn.links.slice(1)) {
  const otherPage = page(link.href);
  assert.strictEqual(otherPage.links[0].href, `${base}index.html?league=espnfam`,
    "returning from another page must restore the ESPN board");
}
// The Gabagool board must NOT pick up the label the other two carry.
const gabLabels = page(`${base}index.html?league=gabagool`);
assert.doesNotMatch(gabLabels.links[1].textContent, /Gabagool/,
  "Gabagool's own trade tab must not be labelled with its own name");
assert.doesNotMatch(gabLabels.links[2].textContent, /Gabagool/);

assert.throws(() => page(`${base}index.html?league=unknown`), /Unknown league/);
page(`${base}weekly.html?league=fam`);
assert.equal(FC.leagueDataPath("weekly"),"data/weekly-fam.json");
assert.equal(FC.leagueDataPath("draft"),"data/draft-fam.json");
page(`${base}weekly.html?league=gabagool`);
assert.equal(FC.leagueDataPath("weekly"),"data/weekly.json");
console.log("navigation_fixture: league selection and return paths OK");
