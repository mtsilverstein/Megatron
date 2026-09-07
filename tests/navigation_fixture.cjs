// The selected board must survive full-page navigation without a shared
// localStorage preference that could cross two simultaneously open drafts.
const assert = require("assert");
global.window = {};
require("../site/assets/app.js");
const FC = window.FC;

function page(href) {
  const names = ["Draft board", "Trade calculator", "Weekly", "About the model"];
  const links = ["index.html", "trade.html", "weekly.html", "about.html"].map((path, i) => ({
    href: path, textContent: names[i], getAttribute() { return this.href; },
  }));
  const choices = ["fam", "gabagool"].map(slug => ({
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
assert.match(fam.links[2].textContent, /Gabagool/);
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
assert.throws(() => page(`${base}index.html?league=unknown`), /Unknown league/);
console.log("navigation_fixture: league selection and return paths OK");
