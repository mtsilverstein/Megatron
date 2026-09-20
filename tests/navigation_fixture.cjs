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
// FAM has the in-season trade page (conditional lineup scenarios), so its
// trade link carries NO restriction suffix -- neither the retired "Gabagool
// only" nor "not connected".
assert.doesNotMatch(fam.links[1].textContent, /Gabagool/,
  "FAM's trade link must not claim the tool is Gabagool-only any more");
assert.doesNotMatch(fam.links[1].textContent, /not connected/);
assert.doesNotMatch(fam.links[2].textContent, /Gabagool/);
// The trade href must still carry FAM, not silently jump to Gabagool -- the
// URL never switches leagues for you.
assert.strictEqual(fam.links[1].href, `${base}trade.html?league=fam`,
  "trade's href must not switch leagues");
assert.strictEqual(fam.links[1].textContent, "Trade calculator");
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
// and round-trip like any other, and -- because no live Sleeper tool is
// connected for it -- its trade link carries the same " · not connected"
// suffix its weekly/waivers links do. The label rule keys on "is ESPN", not
// on "not Gabagool": FAM is a Sleeper league and gets no suffix.
const espn = page(`${base}index.html?league=espnfam`);
assert.strictEqual(espn.slug, "espnfam");
assert.strictEqual(espn.links[0].href, `${base}index.html?league=espnfam`,
  "clicking the current draft tab must not switch leagues");
assert.doesNotMatch(espn.links[1].textContent, /Gabagool/,
  "ESPN's trade label must not imply a click opens Gabagool");
assert.strictEqual(espn.links[1].textContent, "Trade calculator · not connected",
  "trade.html is not connected for ESPN and must say so");
assert.strictEqual(espn.links[1].href, `${base}trade.html?league=espnfam`,
  "the trade link must still carry the ESPN league, not switch it");
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
// The Gabagool board must NOT pick up any restriction label.
const gabLabels = page(`${base}index.html?league=gabagool`);
assert.doesNotMatch(gabLabels.links[1].textContent, /Gabagool/,
  "Gabagool's own trade tab must not be labelled with its own name");
assert.strictEqual(gabLabels.links[1].textContent, "Trade calculator");
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
assert.equal(FC.leagueDataPath("remaining"),"data/remaining-fam.json");
page(`${base}weekly.html?league=gabagool`);
assert.equal(FC.leagueDataPath("weekly"),"data/weekly.json");
assert.equal(FC.leagueDataPath("remaining"),"data/remaining-gabagool.json");

// leagueNavigation running twice against the SAME <a> elements (a defensive
// re-init) must not stack suffixes -- "· not connected · not connected" would
// be the tell that the label mutation isn't idempotent. A link that arrives
// already carrying the retired "· Gabagool only" label must lose it.
{
  const names = ["Draft board", "Trade calculator", "Weekly", "About the model", "FAAB & waivers"];
  const repeatedLinks = ["index.html", "trade.html", "weekly.html", "about.html", "waivers.html"]
    .map((path, i) => ({ href: path, textContent: names[i], getAttribute() { return this.href; } }));
  repeatedLinks[1].textContent += " · Gabagool only";
  global.location = new URL(`${base}index.html?league=espnfam`);
  global.document = { querySelectorAll: selector =>
    selector === ".masthead nav a" ? repeatedLinks : [] };
  FC.leagueNavigation();
  FC.leagueNavigation();
  assert.strictEqual(repeatedLinks[1].textContent, "Trade calculator · not connected",
    "repeated init must not stack the not-connected suffix, and must strip the retired Gabagool-only label");
  assert.strictEqual(repeatedLinks[2].textContent, "Weekly · not connected",
    "repeated init must not stack the not-connected suffix");
  assert.strictEqual(repeatedLinks[1].href, `${base}trade.html?league=espnfam`,
    "repeated init must keep preserving the URL's league context");
}

// One identity input for the whole site (spec §6/§8): the chip's #session-user
// and the connect page's #connect-user are the only username inputs left.
// Every retired per-page input id must be gone from the static site, or a
// page would carry a second, unsynchronised account.
{
  const fs = require("node:fs"), path = require("node:path");
  const site = path.join(__dirname, "..", "site");
  const files = [
    ...fs.readdirSync(site).filter(f => f.endsWith(".html")).map(f => path.join(site, f)),
    ...fs.readdirSync(path.join(site, "assets")).filter(f => /\.(js|css)$/.test(f)).map(f => path.join(site, "assets", f)),
  ];
  const legacy = /draft-username|keeper-user|trade-user|season-user|waiver-user|ss-user/;
  const legacyKey = /megatron:sleeper-username/;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    assert.ok(!legacy.test(src), `${path.basename(file)}: retired username input id still present`);
    if (path.basename(file) !== "session.js")
      assert.ok(!legacyKey.test(src), `${path.basename(file)}: only session.js may name the legacy storage key (it migrates and deletes it)`);
  }
}

// The identity chip (spec §6) lives inside #league-context. A fake DOM with
// createElement/append/addEventListener/replaceChildren lets mountLeagueContext
// render for real against a stubbed Session, so the checks below hold the
// chip to the spec's states and strings without a browser.
{
  function element(tagName) {
    return {
      tagName, children: [], listeners: {}, textContent: "", className: "", id: "", value: "", attrs: {},
      append(...nodes) { this.children.push(...nodes); },
      prepend(...nodes) { this.children.unshift(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      setAttribute(k, v) { this.attrs[k] = v; },
      dispatch(type) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {} }); },
    };
  }
  const all = node => [node, ...node.children.flatMap(all)];
  const byId = (root, id) => all(root).find(n => n.id === id) || null;
  function dom(href) {
    const main = element("main");
    global.location = new URL(href);
    global.document = {
      createElement: element,
      querySelector(selector) { return selector === "main" ? main : null; },
      querySelectorAll() { return []; },
      getElementById(id) { return byId(main, id); },
    };
    return main;
  }
  // A stub with the Session surface the chip reads. `set(...)` moves it
  // between states and fires onChange like the real module does. identify()
  // always rejects SUPERSEDED, which the chip must swallow, not display.
  function stubSession() {
    let st = "anonymous", err = null, id = null, bundle = null;
    const listeners = new Set();
    const fire = () => { for (const fn of listeners) fn(); };
    const S = {
      calls: [],
      state: () => st, error: () => err, identity: () => (id ? { ...id } : null), bundle: () => bundle,
      pendingUsername: () => null, migrateLegacy: () => null,
      isSuperseded: e => !!(e && e.superseded),
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      chipText: Session.chipText,
      set(next) { ({ st = st, err = err, id = id, bundle = bundle } = next); fire(); },
      identify(name) {
        S.calls.push(["identify", name]);
        const e = new Error("Superseded by a newer request."); e.superseded = true;
        return Promise.reject(e);
      },
      ready(opts) { S.calls.push(["ready", opts.slug]); return Promise.resolve(bundle); },
      refresh(opts) { S.calls.push(["refresh", opts && opts.scope, typeof (opts && opts.also) === "function"]); return Promise.resolve(bundle); },
      forget() { S.calls.push(["forget"]); id = null; st = "anonymous"; err = null; fire(); },
    };
    return S;
  }
  const Session = require("../site/assets/session.js");
  const REMEMBERED = "Remembered on this device until you choose forget.";

  // Anonymous, on a page without a board: the chip mounts inside the panel,
  // offers the username input + button and the remembered sentence.
  const A = stubSession(); FC._session(A);
  const anonMain = dom(`${base}about.html?league=fam`);
  FC.mountLeagueContext("fam");
  const anonPanel = anonMain.children[0];
  assert.strictEqual(anonPanel.id, "league-context");
  const chipEl = byId(anonPanel, "session-chip");
  assert.ok(chipEl, "chip must be mounted inside #league-context");
  assert.ok(byId(anonPanel, "session-user"), "anonymous state shows the username input");
  assert.strictEqual(byId(anonPanel, "session-use").textContent, "Use this account");
  assert.strictEqual(byId(anonPanel, "session-text").textContent, REMEMBERED,
    "anonymous state carries the remembered-on-this-device sentence");
  assert.strictEqual(all(chipEl).filter(n => n.textContent === REMEMBERED).length, 1, "the sentence appears once");
  assert.strictEqual(A.calls.length, 0, "anonymous mount makes no Session calls");
  // Submitting the form identifies once; the stub's superseded rejection must
  // not be rendered (checked after the microtask settles, below).
  byId(anonPanel, "session-user").value = "Max973";
  all(chipEl).find(n => n.tagName === "form").dispatch("submit");
  assert.deepStrictEqual(A.calls, [["identify", "Max973"]]);

  // A ready bundle renders exactly chipText's line plus refresh/change/forget.
  const R = stubSession(); FC._session(R);
  const rostersFetchedAt = Date.now() - 14000;
  const bundle = {
    registry: FC.registryFor("gabagool"), identity: { username: "Max973", userId: "1", displayName: "Max973" },
    league: { name: "Gabagool Fools", league_id: "1376245373244301312" }, users: [], rosters: [], state: {},
    rostersRequestedAt: rostersFetchedAt - 5, rostersFetchedAt,
    myRoster: { roster_id: 9 }, myRosterStatus: "found", warnings: [], extra: null, generation: 1,
  };
  const readyMain = dom(`${base}index.html?league=gabagool`);
  FC.mountLeagueContext("gabagool");
  const panel = readyMain.children[0];
  R.set({ st: "ready", id: bundle.identity, bundle });
  const text = byId(panel, "session-text").textContent;
  assert.strictEqual(text, Session.chipText(bundle, "ready", Date.now()));
  assert.match(text, /^Max973 · Gabagool Fools · your roster: 9 · rosters 1[45] s ago$/);
  assert.ok(byId(panel, "session-refresh") && byId(panel, "session-change") && byId(panel, "session-forget"),
    "ready state offers refresh, change and forget");
  assert.ok(!byId(panel, "session-user"), "ready state shows no username input");
  byId(panel, "session-refresh").dispatch("click");
  assert.deepStrictEqual(R.calls, [["refresh", "rosters", false]], "the refresh button refreshes rosters + state by default");
  // A page that must re-fetch more atomically with the rosters (the waiver
  // desk's week transactions) owns the refresh path: its onRefresh provider
  // supplies the options -- scope and the `also` hook -- to the chip's button.
  const also = async () => [];
  const offRefresh = FC.chip.onRefresh(() => ({ scope: "league", also }));
  byId(panel, "session-refresh").dispatch("click");
  assert.deepStrictEqual(R.calls[1], ["refresh", "league", true], "the page's provider reaches Session.refresh");
  offRefresh();
  byId(panel, "session-refresh").dispatch("click");
  assert.deepStrictEqual(R.calls[2], ["refresh", "rosters", false], "unregistering restores the default");
  // none/ambiguous: the §4.4 message plus change only.
  R.set({ bundle: { ...bundle, myRoster: null, myRosterStatus: "none" } });
  assert.strictEqual(byId(panel, "session-text").textContent,
    "Could not uniquely match this account to a roster in this league.");
  assert.ok(byId(panel, "session-change") && !byId(panel, "session-refresh") && !byId(panel, "session-forget"));
  // error: the reason plus retry and change. The gate is error(), not
  // state(): a bundle may still be committed beside a stale identity error.
  R.set({ st: "error", err: "Sleeper username was not found.", id: null, bundle: { ...bundle, identity: null, myRoster: null, myRosterStatus: "anonymous" } });
  assert.strictEqual(byId(panel, "session-text").textContent, "Sleeper username was not found.");
  assert.ok(byId(panel, "session-retry") && byId(panel, "session-change") && !byId(panel, "session-refresh"));
  // "change" from the error state must offer the input (the way out of a typo).
  byId(panel, "session-change").dispatch("click");
  assert.ok(byId(panel, "session-user"), "change from error shows the username input");
  byId(panel, "session-cancel").dispatch("click");
  assert.ok(byId(panel, "session-retry"), "cancel returns to the error controls");
  // A board set while identified triggers ready for THIS slug, once.
  R.set({ st: "identified", err: null, id: bundle.identity, bundle: null });
  FC.setBoard({ league: { league_id: "1376245373244301312" } });
  FC.setBoard(null);

  // ESPN: identity only -- the name and registry label, no refresh button,
  // and no ready() even when a board is set.
  const E = stubSession(); FC._session(E);
  const espnMain = dom(`${base}index.html?league=espnfam`);
  FC.mountLeagueContext("espnfam");
  const espnPanel = espnMain.children[0];
  E.set({ st: "identified", id: { username: "Max973", userId: "1", displayName: "Max973" } });
  FC.setBoard({ league: { league_id: "69827905" } });
  assert.strictEqual(byId(espnPanel, "session-text").textContent, "Max973 · ESPN family · draft board only");
  assert.ok(!byId(espnPanel, "session-refresh"), "ESPN has nothing to refresh");
  assert.ok(byId(espnPanel, "session-change") && byId(espnPanel, "session-forget"));
  assert.ok(espnPanel.children.some(n => /not connected yet/.test(n.textContent)), "the ESPN note stays");
  FC.setBoard(null);

  // Legacy username (spec §7): prefilled, never auto-identified.
  const L = stubSession(); L.pendingUsername = () => "OldName"; FC._session(L);
  const legacyMain = dom(`${base}weekly.html?league=fam`);
  FC.mountLeagueContext("fam");
  assert.strictEqual(byId(legacyMain.children[0], "session-user").value, "OldName");
  assert.strictEqual(L.calls.length, 0, "a migrated username is offered, not auto-identified");

  // Every page mounts the chip, with or without a board.
  for (const pageName of ["index", "weekly", "waivers", "trade", "about", "connect"]) {
    FC._session(stubSession());
    const m = dom(`${base}${pageName}.html?league=gabagool`);
    FC.mountLeagueContext("gabagool");
    assert.ok(byId(m.children[0], "session-chip"), `${pageName}: chip present in #league-context`);
  }

  setTimeout(() => {
    // Async settlements: the superseded identify rejection left the anonymous
    // chip untouched (no error text, input still offered) and the identified
    // board triggered exactly one ready() for its slug.
    assert.strictEqual(byId(anonPanel, "session-text").textContent, REMEMBERED,
      "a superseded rejection must never be rendered");
    assert.ok(byId(anonPanel, "session-user"));
    assert.deepStrictEqual(R.calls, [["refresh", "rosters", false], ["refresh", "league", true], ["refresh", "rosters", false], ["ready", "gabagool"]], "identified + board loads the league once");
    assert.strictEqual(E.calls.length, 0, "ESPN never calls ready()");
    FC._session(null);
    console.log("navigation_fixture: league selection, return paths and identity chip OK");
  }, 0);
}
