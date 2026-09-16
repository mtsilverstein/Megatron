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
    // Still-enabled links must not be marked aria-disabled -- catches a link
    // that reads as clickable but is silently inert to assistive tech.
    setAttribute(name) { if (name === "aria-disabled") this.disabledAttrSet = true; },
  }));
  global.location = new URL(href);
  // The shared league selector is a <select>, not a list of <a> chips, so
  // leagueNavigation has nothing else to query -- mountLeagueContext itself
  // no-ops here because this fake `document` has no createElement.
  global.document = { querySelectorAll: selector =>
    selector === ".masthead nav a" ? links : [] };
  return { slug: FC.leagueNavigation(), links };
}

const base = "https://example.test/Megatron/";
const fam = page(`${base}index.html?league=fam`);
assert.strictEqual(fam.slug, "fam");
assert.strictEqual(fam.links[0].href, `${base}index.html?league=fam`,
  "clicking the current draft tab must not switch leagues");
assert.match(fam.links[1].textContent, /Gabagool/);
assert.doesNotMatch(fam.links[2].textContent, /Gabagool/);
// The trade href must still carry FAM, not silently jump to Gabagool -- the
// label says the tool is restricted, the URL never switches leagues for you.
assert.strictEqual(fam.links[1].href, `${base}trade.html?league=fam`,
  "trade's label may say Gabagool only, but its href must not switch leagues");
assert.strictEqual(fam.links[1].textContent, "Trade calculator · Gabagool only");
assert.ok(!fam.links[1].disabledAttrSet,
  "trade must stay a real, enabled link -- not one dressed up as disabled");
for (const link of fam.links.slice(1)) {
  const otherPage = page(link.href);
  assert.strictEqual(otherPage.links[0].href, `${base}index.html?league=fam`,
    "returning from another page must restore the FAM board");
}
const gab = page(`${base}index.html`);
assert.strictEqual(gab.slug, "gabagool");
assert.strictEqual(gab.links[0].href, `${base}index.html?league=gabagool`);
assert.strictEqual(page(fam.links[0].href).slug, "fam",
  "opening Gabagool in another tab must not alter FAM's URL");

// The ESPN league is a third board with no live draft path. It must select
// and round-trip like any other, and -- because trade.html is Gabagool-only
// -- it must carry the same "Gabagool only" label FAM does. That label rule
// keys on "not Gabagool", not on "is FAM".
const espn = page(`${base}index.html?league=espnfam`);
assert.strictEqual(espn.slug, "espnfam");
assert.strictEqual(espn.links[0].href, `${base}index.html?league=espnfam`,
  "clicking the current draft tab must not switch leagues");
assert.match(espn.links[1].textContent, /Gabagool/,
  "trade.html is Gabagool-only and must say so on the ESPN board");
assert.doesNotMatch(espn.links[2].textContent, /Gabagool/);
assert.doesNotMatch(espn.links[4].textContent, /Gabagool/);
// ESPN's live weekly/waivers aren't connected -- say so plainly, and don't
// claim they'd open Gabagool (they wouldn't; nothing is connected for ESPN).
assert.strictEqual(espn.links[2].textContent, "Weekly · not connected");
assert.strictEqual(espn.links[4].textContent, "FAAB & waivers · not connected");
assert.strictEqual(espn.links[2].href, `${base}weekly.html?league=espnfam`,
  "the link must still carry the ESPN league, not switch it");
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

// Invalid URLs remain hard failures so no advice can accidentally be loaded
// for the default league, but they also render explicit recovery links for the
// same page. The fake DOM records enough structure to exercise that panel.
{
  function element(tagName) {
    return {
      tagName, children: [], textContent: "", className: "", id: "",
      append(...nodes) { this.children.push(...nodes); },
      prepend(...nodes) { this.children.unshift(...nodes); },
    };
  }
  const main = element("main");
  global.location = new URL(`${base}weekly.html?league=unknown&week=2`);
  global.document = {
    createElement: element,
    querySelector(selector) { return selector === "main" ? main : null; },
    querySelectorAll() { return []; },
    getElementById(id) {
      const find = node => node.id === id ? node : node.children.map(find).find(Boolean);
      return find(main);
    },
  };
  assert.throws(() => FC.leagueNavigation(), /Unknown league/,
    "unknown league must still block page initialization");
  assert.throws(() => FC.leagueDataPath("weekly"), /Unknown league/,
    "unknown league must not resolve to Gabagool's advice data");
  assert.strictEqual(main.children.length, 1, "recovery panel must be visible in the page main area");
  const recovery = main.children[0];
  assert.strictEqual(recovery.id, "league-recovery");
  assert.match(recovery.children[1].textContent, /No league data was loaded/);
  const links = recovery.children[2].children.map(item => item.children[0]);
  assert.deepStrictEqual(links.map(link => link.href), [
    `${base}weekly.html?league=gabagool&week=2`,
    `${base}weekly.html?league=fam&week=2`,
    `${base}weekly.html?league=espnfam&week=2`,
  ], "recovery links must preserve this page and its other query parameters");
  assert.deepStrictEqual(links.map(link => link.textContent), [
    "Gabagool · Sleeper", "FAM · Sleeper", "ESPN family · draft board only",
  ]);
  assert.throws(() => FC.leagueNavigation(), /Unknown league/);
  assert.strictEqual(main.children.length, 1, "repeated init must not duplicate recovery panels");
}
page(`${base}weekly.html?league=fam`);
assert.equal(FC.leagueDataPath("weekly"),"data/weekly-fam.json");
assert.equal(FC.leagueDataPath("draft"),"data/draft-fam.json");
page(`${base}weekly.html?league=gabagool`);
assert.equal(FC.leagueDataPath("weekly"),"data/weekly.json");

// leagueNavigation running twice against the SAME <a> elements (a defensive
// re-init) must not stack suffixes -- "· Gabagool only · Gabagool only" would
// be the tell that the label mutation isn't idempotent.
{
  const names = ["Draft board", "Trade calculator", "Weekly", "About the model", "FAAB & waivers"];
  const repeatedLinks = ["index.html", "trade.html", "weekly.html", "about.html", "waivers.html"]
    .map((path, i) => ({ href: path, textContent: names[i], getAttribute() { return this.href; } }));
  global.location = new URL(`${base}index.html?league=espnfam`);
  global.document = { querySelectorAll: selector =>
    selector === ".masthead nav a" ? repeatedLinks : [] };
  FC.leagueNavigation();
  FC.leagueNavigation();
  assert.strictEqual(repeatedLinks[1].textContent, "Trade calculator · Gabagool only",
    "repeated init must not stack the Gabagool-only suffix");
  assert.strictEqual(repeatedLinks[2].textContent, "Weekly · not connected",
    "repeated init must not stack the not-connected suffix");
  assert.strictEqual(repeatedLinks[1].href, `${base}trade.html?league=espnfam`,
    "repeated init must keep preserving the URL's league context");
}
console.log("navigation_fixture: league selection and return paths OK");
