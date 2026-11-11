// League selection and return paths (owner decision 2026-11-07: no league is
// the default; the site works for anyone on Sleeper). The page's league is the
// URL's id, else the id this browser remembered, else none -- and an old
// link's league name names none. The site's code carries no league: every id
// and name here is synthetic.
const assert = require("assert");
global.window = {};
require("../site/assets/app.js");
const FC = window.FC;

const NAMES = ["Weekly", "FAAB & waivers", "Trade calculator", "About the model", "2026 draft board (archived)"];
const PAGES = ["weekly.html", "waivers.html", "trade.html", "about.html", "index.html"];
// A Map-backed localStorage and a history stub that, like the browser's,
// moves location on replaceState.
const lsMap = new Map();
const store = { getItem: k => (lsMap.has(k) ? lsMap.get(k) : null), setItem: (k, v) => { lsMap.set(k, String(v)); }, removeItem: k => { lsMap.delete(k); } };
const replaced = [];
global.history = { state: null, replaceState(_s, _t, url) { replaced.push(url); global.location = new URL(url); } };
function page(href) {
  const links = PAGES.map((p, i) => ({ href: p, textContent: NAMES[i], getAttribute() { return this.href; } }));
  global.location = new URL(href);
  // No createElement: the league panels no-op, only the masthead is rewritten.
  global.document = { querySelectorAll: selector => selector === ".masthead nav a" ? links : [] };
  return { slug: FC.leagueNavigation(), links };
}
const params = p => Object.fromEntries(p.links.map(l => {
  const u = new URL(l.href);
  return [u.pathname.split("/").pop(), u.searchParams.get("league")];
}));
const base = "https://example.test/Megatron/";
const X = "100000000000000001", Y = "100000000000000002";
const KEY = "megatron:lastLeague";
assert.strictEqual(FC.LAST_LEAGUE_KEY, KEY);
assert.strictEqual(FC.REGISTRY.length, 0, "the site's code registers no league");

// 1. No ?league= and nothing remembered: NO league -- not a default one.
global.localStorage = store;
{
  const w = page(`${base}weekly.html`);
  assert.strictEqual(FC.inSeasonLeague(), null, "no parameter and nothing remembered is no league");
  assert.strictEqual(w.slug, null);
  assert.deepStrictEqual(params(w), Object.fromEntries(PAGES.map(p => [p, null])), "no masthead link names a league");
  assert.deepStrictEqual(w.links.map(l => l.textContent), NAMES, "labels are left alone");
  assert.deepStrictEqual(replaced, [], "nothing to write into the URL");
  for (const p of ["waivers.html", "trade.html", "about.html", "connect.html"]) {
    page(`${base}${p}`);
    assert.strictEqual(FC.inSeasonLeague(), null, `${p}: no league`);
  }
}

// 2. A league id in the URL is THE league; its id rides every in-season link
//    and the neutral pages, never the archived board's link.
{
  const w = page(`${base}waivers.html?league=${X}&week=2`);
  assert.deepStrictEqual(FC.inSeasonLeague(), { leagueId: X });
  assert.deepStrictEqual(params(w), { "weekly.html": X, "waivers.html": X, "trade.html": X, "about.html": X, "index.html": null });
  assert.strictEqual(new URL(w.links[0].href).pathname, "/Megatron/weekly.html");
  // Returning from a neutral page keeps the league in-season.
  assert.deepStrictEqual(params(page(w.links[3].href))["weekly.html"], X);
  assert.strictEqual(lsMap.size, 0, "reading a URL stores nothing (a league is remembered only once it loads)");
}

// 3. The remembered id: used only when there is NO parameter, on an in-season
//    page, and written into the URL with replaceState so the page is
//    shareable and reloads identically.
{
  lsMap.set(KEY, Y);
  const w = page(`${base}weekly.html?week=4`);
  assert.deepStrictEqual(FC.inSeasonLeague(), { leagueId: Y }, "the remembered id opens the league");
  assert.deepStrictEqual(replaced, [`${base}weekly.html?week=4&league=${Y}`], "the URL now names the league, other parameters kept");
  assert.strictEqual(new URL(global.location.href).searchParams.get("league"), Y);
  assert.deepStrictEqual(params(w), { "weekly.html": Y, "waivers.html": Y, "trade.html": Y, "about.html": Y, "index.html": null });
  // The URL already carries it: a second read does not rewrite again.
  FC.inSeasonLeague();
  assert.strictEqual(replaced.length, 1);
  // An explicit id wins over the remembered one.
  page(`${base}trade.html?league=${X}`);
  assert.deepStrictEqual(FC.inSeasonLeague(), { leagueId: X });
  assert.strictEqual(replaced.length, 1);
  // A neutral page never picks the remembered league up on its own.
  const a = page(`${base}about.html`);
  assert.strictEqual(FC.inSeasonLeague(), null);
  assert.strictEqual(params(a)["weekly.html"], null, "about's links leave the in-season pages to resolve their own league");
  assert.strictEqual(replaced.length, 1);
  // A remembered value that is not an id is no league.
  lsMap.set(KEY, "not-an-id");
  page(`${base}weekly.html`);
  assert.strictEqual(FC.inSeasonLeague(), null);
  // A blocked store is no league, and nothing throws.
  lsMap.set(KEY, Y);
  global.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  page(`${base}weekly.html`);
  assert.strictEqual(FC.inSeasonLeague(), null, "a blocked store means no league");
  global.localStorage = undefined;
  page(`${base}weekly.html`);
  assert.strictEqual(FC.inSeasonLeague(), null, "no store at all means no league");
  global.localStorage = store;
  replaced.length = 0;
}

// 4. An old link's league name on an in-season page: no league, the
//    old-name message with a way to connect -- and the remembered league is
//    NOT substituted for it.
{
  function element(tagName) {
    return {
      tagName, children: [], textContent: "", className: "", id: "", href: "", value: "", attrs: {}, listeners: {},
      append(...nodes) { this.children.push(...nodes); },
      prepend(...nodes) { this.children.unshift(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    };
  }
  const all = node => [node, ...node.children.flatMap(all)];
  function domPage(href) {
    const main = element("main");
    const links = PAGES.map((p, i) => ({ href: p, textContent: NAMES[i], getAttribute() { return this.href; } }));
    global.location = new URL(href);
    global.document = {
      createElement: element,
      querySelector(selector) { return selector === "main" ? main : null; },
      querySelectorAll(selector) { return selector === ".masthead nav a" ? links : []; },
      getElementById(id) { return all(main).find(n => n.id === id) || null; },
    };
    return { main, links };
  }
  lsMap.set(KEY, Y);
  for (const name of ["leaguea", "oldname"]) {
    const { main, links } = domPage(`${base}weekly.html?league=${name}`);
    assert.strictEqual(FC.leagueNavigation(), null, "an old name loads no league and does not throw");
    assert.strictEqual(FC.inSeasonLeague(), null, `${name}: no league, and never the remembered one`);
    assert.deepStrictEqual(replaced, [], "the old link's URL is not rewritten to another league");
    const notice = all(main).find(n => n.id === "league-recovery");
    assert.ok(notice, "the old-name notice is shown");
    assert.ok(all(notice).some(n => n.textContent === "This link uses an old league name. Connect your Sleeper league to continue."));
    const connect = all(notice).find(n => n.tagName === "a");
    assert.strictEqual(connect.href, `${base}connect.html`, "the notice links to the connect page");
    assert.strictEqual(main.children[0], notice, "the notice sits above the league panel");
    assert.ok(all(main).some(n => n.id === "league-context"), "the league panel still mounts, league-free");
    assert.deepStrictEqual(links.map(l => new URL(l.href).searchParams.get("league")), [null, null, null, null, null],
      "no masthead link carries the old name onward");
    FC.leagueNavigation();
    assert.strictEqual(main.children.filter(n => n.id === "league-recovery").length, 1, "repeated init does not duplicate the notice");
  }
  // Not even name-shaped: says what it is, same way forward.
  {
    const { main } = domPage(`${base}trade.html?league=12ab!`);
    FC.leagueNavigation();
    assert.strictEqual(FC.inSeasonLeague(), null);
    assert.ok(all(main).some(n => n.textContent === `"12ab!" is not a Sleeper league id. Connect your Sleeper league to continue.`));
  }
  // A neutral page ignores an old name quietly (nothing there needs a league).
  {
    const { main } = domPage(`${base}about.html?league=leaguea`);
    FC.leagueNavigation();
    assert.ok(!all(main).some(n => n.id === "league-recovery"));
  }
  // A registered board's slug is still an old name on an in-season page: no
  // board is loaded there, and no league is substituted for it.
  FC._registry([{ slug: "leaguea", platform: "sleeper", leagueId: X, label: "12-team PPR, 6-pt pass TD", tools: {} }]);
  domPage(`${base}waivers.html?league=leaguea`);
  FC.leagueNavigation();
  assert.strictEqual(FC.inSeasonLeague(), null, "a board slug never resolves to its league id on an in-season page");
  FC._registry([]);

  // 5. The board page: no name is the default board; a name is that board's
  //    file (old links keep working); its own link keeps it, every other link
  //    is league-free. An id is refused by name and loads nothing.
  {
    const { links } = domPage(`${base}index.html?league=leagueb`);
    assert.strictEqual(FC.leagueNavigation(), "leagueb", "the board page returns the board's name from its URL");
    assert.deepStrictEqual(links.map(l => new URL(l.href).searchParams.get("league")), [null, null, null, null, "leagueb"]);
    const d = domPage(`${base}index.html`);
    assert.strictEqual(FC.leagueNavigation(), null, "no parameter: the default board");
    assert.ok(!all(d.main).some(n => n.id === "league-context"), "the board page mounts its league panel itself");
    assert.throws(() => { domPage(`${base}index.html?league=bad!`); FC.leagueNavigation(); }, /names no published draft board/);
  }
  {
    const { main, links } = domPage(`${base}index.html?league=${X}`);
    assert.throws(() => FC.leagueNavigation(), { message: "The draft board is not built per league; the 2026 board is archived." });
    assert.deepStrictEqual(links.map(l => new URL(l.href).searchParams.get("league")), [X, X, X, X, null],
      "the masthead is rewritten BEFORE the refusal: this league's pages keep its id, the board link names none");
    const panel = main.children[0];
    assert.strictEqual(panel.id, "draft-boundary");
    assert.deepStrictEqual(all(panel).filter(n => n.tagName === "a").map(a => a.href),
      [`${base}weekly.html?league=${X}`, `${base}waivers.html?league=${X}`, `${base}trade.html?league=${X}`],
      "the way forward is this league's in-season pages, never another league's board");
    assert.ok(!all(main).some(n => n.id === "league-context"), "no league panel for a board that does not exist");
    assert.throws(() => FC.leagueNavigation(), /not built per league/);
    assert.strictEqual(main.children.length, 1, "repeated init must not duplicate the panel");
  }
  lsMap.clear();
}

// 6. The archived board: format labels from a board's own league block,
//    the archive rule, and the board file a name selects.
{
  assert.strictEqual(FC.boardFormatLabel({ teams: 12, sleeper_scoring: { rec: 1, pass_td: 6 }, name: "League A" }), "12-team PPR, 6-pt pass TD");
  assert.strictEqual(FC.boardFormatLabel({ teams: 10, sleeper_scoring: { rec: 0.5, pass_td: 4 } }), "10-team half-PPR, 4-pt pass TD");
  assert.strictEqual(FC.boardFormatLabel({ teams: 8, sleeper_scoring: { pass_td: 4 } }), "8-team standard, 4-pt pass TD");
  assert.strictEqual(FC.boardFormatLabel({ teams: 14, sleeper_scoring: { rec: 0.25, pass_td: 6 } }), "14-team 0.25-pt PPR, 6-pt pass TD");
  assert.strictEqual(FC.boardFormatLabel({ sleeper_scoring: { rec: 1 } }), "PPR");
  assert.strictEqual(FC.boardFormatLabel(null), "Standard");
  const espn = FC.boardEntry({ league: { slug: "leaguec", name: "League C", platform: "espn", league_id: "100000000000000003", teams: 13, sleeper_scoring: { rec: 1, pass_td: 6 } } });
  assert.strictEqual(espn.label, "13-team PPR, 6-pt pass TD · ESPN draft board only");
  assert.strictEqual(espn.tools.startsit, false);
  assert.strictEqual(FC.boardEntry({ league: { name: "no slug" } }), null);
}

(async () => {
  const board = { season: 2026, generated_at: "2026-09-08T17:50:14+00:00", league: { slug: "leaguea" } };
  const loader = files => async path => {
    if (files[path] instanceof Error) throw files[path];
    if (!(path in files)) throw new Error(`${path}: HTTP 404`);
    return files[path];
  };
  assert.strictEqual(await FC.boardArchived(board, loader({ "data/neutral/weekly.json": { season: 2026, week: 9 } })), true,
    "the season the board was built for is under way: archived");
  assert.strictEqual(await FC.boardArchived(board, loader({ "data/neutral/weekly.json": { season: 2025, week: 18 } })), false,
    "a weekly batch for another season: not archived");
  assert.strictEqual(await FC.boardArchived(board, loader({})), false, "weekly.json missing: fail open to the board");
  assert.strictEqual(await FC.boardArchived(board, loader({ "data/neutral/weekly.json": new Error("network down") })), false,
    "weekly.json failing to load: fail open to the board");
  assert.strictEqual(await FC.boardArchived(board, loader({ "data/neutral/weekly.json": null })), false);
  assert.strictEqual(await FC.boardArchived({ ...board, season: undefined }, loader({ "data/neutral/weekly.json": { season: 2026 } })), false);
  assert.strictEqual(FC.archivedText(board),
    "Archived: the 2026 preseason board as published on September 8, 2026. The drafts are over; it stays as a record of what the model projected before the season.");
  const files = { "data/draft.json": board, "data/draft-leagueb.json": { season: 2026, league: { slug: "leagueb" } } };
  assert.strictEqual(await FC.loadBoard(null, loader(files)), board, "no name: the default board");
  assert.strictEqual((await FC.loadBoard("leagueb", loader(files))).league.slug, "leagueb", "a name: that board's file");
  assert.strictEqual(await FC.loadBoard("leaguea", loader(files)), board, "the default board answers to its own name from its bare file");
  await assert.rejects(FC.loadBoard("leaguez", loader(files)), /names no published draft board/, "a name no board has is refused, never substituted");
  await assert.rejects(FC.loadBoard("leagueb", loader({ "data/draft-leagueb.json": new Error("data/draft-leagueb.json: HTTP 500") })), /HTTP 500/);
})().catch(e => { console.error(e); process.exit(1); });

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
      chipText: Session.chipText, teamName: Session.teamName, settingsText: Session.settingsText,
      set(next) { ({ st = st, err = err, id = id, bundle = bundle } = next); fire(); },
      identify(name) {
        S.calls.push(["identify", name]);
        const e = new Error("Superseded by a newer request."); e.superseded = true;
        return Promise.reject(e);
      },
      ready(opts) { S.calls.push(["ready", opts.leagueId !== undefined ? { leagueId: opts.leagueId } : opts.slug]); return Promise.resolve(bundle); },
      refresh(opts) { S.calls.push(["refresh", opts && opts.scope, typeof (opts && opts.also) === "function"]); return Promise.resolve(bundle); },
      // Like the real module, forget() re-derives the committed bundle for
      // "no account" (identity null, no roster) and keeps its timestamps.
      forget() {
        S.calls.push(["forget"]); id = null; st = "anonymous"; err = null;
        if (bundle) bundle = { ...bundle, identity: null, myRoster: null, myRosterStatus: "anonymous" };
        fire();
      },
    };
    return S;
  }
  const Session = require("../site/assets/session.js");
  const REMEMBERED = "Remembered on this device until you choose forget.";
  const A = "100000000000000001", C = "100000000000000003";
  // A board page registers its board's own league block (FC.setBoard); the
  // hook stands in for that here with synthetic rows.
  FC._registry([
    { slug: "leaguea", platform: "sleeper", leagueId: A, label: "12-team PPR, 6-pt pass TD", tools: { draft: true, keepers: true, trade: true, waivers: true, startsit: true } },
    { slug: "leaguec", platform: "espn", leagueId: C, label: "13-team PPR, 6-pt pass TD · ESPN draft board only", tools: { draft: true, keepers: false, trade: false, waivers: false, startsit: false } },
  ]);

  // Anonymous, on a page with no league open: the chip mounts inside the
  // panel, offers the username input + button and the remembered sentence;
  // the league picker has nothing to offer yet, so it is hidden.
  const AN = stubSession(); FC._session(AN);
  const anonMain = dom(`${base}about.html`);
  FC.mountLeagueContext(null);
  const anonPanel = anonMain.children[0];
  assert.strictEqual(anonPanel.id, "league-context");
  const chipEl = byId(anonPanel, "session-chip");
  assert.ok(chipEl, "chip must be mounted inside #league-context");
  assert.ok(byId(anonPanel, "session-user"), "anonymous state shows the username input");
  assert.strictEqual(byId(anonPanel, "session-use").textContent, "Use this account");
  assert.strictEqual(byId(anonPanel, "session-text").textContent, REMEMBERED,
    "anonymous state carries the remembered-on-this-device sentence");
  assert.strictEqual(all(chipEl).filter(n => n.textContent === REMEMBERED).length, 1, "the sentence appears once");
  assert.strictEqual(AN.calls.length, 0, "anonymous mount makes no Session calls");
  const anonSelect = all(anonPanel).find(n => n.tagName === "select");
  assert.deepStrictEqual(anonSelect.children, [], "no hard-coded leagues: an anonymous visitor's picker is empty");
  assert.strictEqual(all(anonPanel).find(n => n.tagName === "label" && n.children.includes(anonSelect)).hidden, true, "an empty picker is hidden");
  assert.ok(anonPanel.children.some(n => /^No league is open\./.test(n.textContent)), "the panel says no league is open");
  assert.strictEqual(all(anonPanel).find(n => n.tagName === "a").href, `${base}connect.html`, "the connect link names no league");
  // Submitting the form identifies once; the stub's superseded rejection must
  // not be rendered (checked after the microtask settles, below).
  byId(anonPanel, "session-user").value = "user_a";
  all(chipEl).find(n => n.tagName === "form").dispatch("submit");
  assert.deepStrictEqual(AN.calls, [["identify", "user_a"]]);

  // A league-free page with its connect prompt showing asks for the username
  // once: the chip's own form is not built while the prompt is visible.
  {
    const PS = stubSession(); FC._session(PS);
    const pm = dom(`${base}weekly.html`);
    const promptEl = element("section"); promptEl.id = "connect-prompt"; promptEl.hidden = false;
    pm.append(promptEl);
    FC.mountLeagueContext(null);
    const pPanel = pm.children[0];
    assert.strictEqual(byId(pPanel, "session-user"), null, "the prompt is the page's one username form");
    assert.strictEqual(byId(pPanel, "session-use"), null);
    promptEl.hidden = true;
    FC.chip.render();
    assert.ok(byId(pPanel, "session-user"), "with no prompt showing, the chip offers its own form");
  }
  // Waivers and Trade mount the panel FIRST and show the prompt after; the
  // real LeagueConnect.initPrompt re-renders the chip, so those pages also ask
  // once, and the line does not promise a forget control that is not there.
  {
    const { initPrompt } = require("../site/assets/connect.js");
    for (const pageName of ["waivers.html", "trade.html"]) {
      const PS = stubSession(); FC._session(PS);
      const pm = dom(`${base}${pageName}`);
      const promptEl = element("section"); promptEl.id = "connect-prompt"; promptEl.hidden = true;
      for (const [tag, id] of [["form", "connect-prompt-form"], ["input", "connect-prompt-input"], ["p", "connect-prompt-status"], ["ul", "connect-prompt-results"]]) {
        const n = element(tag); n.id = id; promptEl.append(n);
      }
      pm.append(promptEl);
      FC.mountLeagueContext(null);
      const pPanel = pm.children.find(n => n.id === "league-context");
      assert.ok(byId(pPanel, "session-user"), `${pageName}: before the prompt shows, the chip has its form`);
      promptEl.hidden = false;
      initPrompt();
      assert.strictEqual(byId(pPanel, "session-user"), null, `${pageName}: the prompt is the page's one username form`);
      assert.strictEqual(all(pm).filter(n => n.id === "session-user" || n.id === "connect-prompt-input").length, 1);
      assert.ok(!all(pm).some(n => /until you choose forget/.test(n.textContent)), `${pageName}: no forget promise with no league open`);
      assert.strictEqual(byId(pPanel, "session-text").textContent, "");
    }
  }
  // A ready bundle renders exactly chipText's line plus refresh/change/forget.
  const R = stubSession(); FC._session(R);
  const rostersFetchedAt = Date.now() - 14000;
  const bundle = {
    registry: FC.registryFor("leaguea"), identity: { username: "user_a", userId: "1", displayName: "User A" },
    league: { name: "League A", league_id: A }, users: [], rosters: [], state: {},
    rostersRequestedAt: rostersFetchedAt - 5, rostersFetchedAt,
    myRoster: { roster_id: 9 }, myRosterStatus: "found", warnings: [], extra: null, generation: 1,
  };
  const readyMain = dom(`${base}index.html?league=leaguea`);
  FC.mountLeagueContext("leaguea");
  const panel = readyMain.children[0];
  R.set({ st: "ready", id: bundle.identity, bundle });
  const text = byId(panel, "session-text").textContent;
  assert.strictEqual(text, Session.chipText(bundle, "ready", Date.now()));
  assert.match(text, /^User A · League A · your roster: 9 · rosters 1[45] s ago$/);
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
  // The 1 s ticker calls FC.chip.render() to move the age in the line. It must
  // update ONLY the line: the controls are rebuilt when the state they were
  // built from changes, never on a tick -- or "change" + typing loses the
  // typed name within a second, and keyboard focus on a chip button is lost.
  {
    const refreshNode = byId(panel, "session-refresh"), changeNode = byId(panel, "session-change");
    FC.chip.render();
    assert.strictEqual(byId(panel, "session-refresh"), refreshNode, "a tick must not rebuild the refresh button");
    assert.strictEqual(byId(panel, "session-change"), changeNode, "a tick must not rebuild the change button");
    changeNode.dispatch("click");
    const input = byId(panel, "session-user");
    assert.ok(input, "change shows the username input");
    assert.strictEqual(input.value, "user_a", "the input is prefilled with the current username");
    input.value = "newname-typed";
    FC.chip.render();
    assert.strictEqual(byId(panel, "session-user"), input, "a tick must not rebuild the username input");
    assert.strictEqual(byId(panel, "session-user").value, "newname-typed", "a tick must not revert what was typed");
    assert.match(byId(panel, "session-text").textContent, /^User A · League A · your roster: 9 · rosters 1[45] s ago$/,
      "the line still updates on a tick");
    byId(panel, "session-cancel").dispatch("click");
    assert.ok(byId(panel, "session-refresh") && !byId(panel, "session-user"), "cancel returns to the ready controls");
    // forget keeps the (re-derived, anonymous) bundle, so the ticker keeps
    // running; the anonymous form must survive its ticks the same way.
    byId(panel, "session-forget").dispatch("click");
    assert.deepStrictEqual(R.calls[3], ["forget"]);
    const anonInput = byId(panel, "session-user");
    assert.ok(anonInput, "forget offers the username input");
    assert.strictEqual(anonInput.value, "", "the anonymous form is empty");
    assert.strictEqual(byId(panel, "session-text").textContent, REMEMBERED);
    anonInput.value = "other-typed";
    FC.chip.render();
    assert.strictEqual(byId(panel, "session-user"), anonInput, "a tick after forget must not rebuild the anonymous input");
    assert.strictEqual(byId(panel, "session-user").value, "other-typed", "a tick after forget must not empty the input");
    // Back to the ready state for the checks below; a state move DOES rebuild.
    R.set({ st: "ready", id: bundle.identity, bundle });
    assert.ok(byId(panel, "session-refresh") && !byId(panel, "session-user"), "a state change rebuilds the controls");
  }
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
  FC.setBoard({ league: { league_id: A } });
  FC.setBoard(null);

  // ESPN: identity only -- the name and registry label, no refresh button,
  // and no ready() even when a board is set.
  const E = stubSession(); FC._session(E);
  const espnMain = dom(`${base}index.html?league=leaguec`);
  FC.mountLeagueContext("leaguec");
  const espnPanel = espnMain.children[0];
  E.set({ st: "identified", id: { username: "user_a", userId: "1", displayName: "User A" } });
  FC.setBoard({ league: { league_id: C } });
  assert.strictEqual(byId(espnPanel, "session-text").textContent, "User A · 13-team PPR, 6-pt pass TD · ESPN draft board only",
    "the ESPN line names the board by its format, never by a league name");
  assert.ok(!byId(espnPanel, "session-refresh"), "ESPN has nothing to refresh");
  assert.ok(byId(espnPanel, "session-change") && byId(espnPanel, "session-forget"));
  assert.ok(espnPanel.children.some(n => /not connected yet/.test(n.textContent)), "the ESPN note stays");
  FC.setBoard(null);

  // Legacy username (spec §7): prefilled, never auto-identified.
  const L = stubSession(); L.pendingUsername = () => "OldName"; FC._session(L);
  const legacyMain = dom(`${base}weekly.html?league=${A}`);
  FC.mountLeagueContext(A);
  assert.strictEqual(byId(legacyMain.children[0], "session-user").value, "OldName");
  assert.strictEqual(L.calls.length, 0, "a migrated username is offered, not auto-identified");

  // Every page mounts the chip, with or without a board.
  for (const pageName of ["index", "weekly", "waivers", "trade", "about", "connect"]) {
    FC._session(stubSession());
    const m = dom(`${base}${pageName}.html`);
    FC.mountLeagueContext(null);
    assert.ok(byId(m.children[0], "session-chip"), `${pageName}: chip present in #league-context`);
  }

  // In-season pages by Sleeper id (any-league spec 5.1): FC.setLeague loads
  // the league at once -- identity optional -- and a non-owner chooses a team
  // to VIEW from the league's own team names.
  const X = "700000000000000001";
  let pickerChecks = null;
  const V = stubSession(); FC._session(V);
  V.view = rosterId => {
    V.calls.push(["view", rosterId]);
    const b = V.bundle();
    const hit = rosterId === null ? null : b.rosters.find(r => String(r.roster_id) === String(rosterId));
    V.set({ bundle: { ...b, viewedRosterId: hit ? hit.roster_id : null, analysisRoster: hit, analysisRole: hit ? "viewer" : null } });
    return V.bundle();
  };
  const idMain = dom(`${base}weekly.html?league=${X}`);
  FC.mountLeagueContext(X);
  const idPanel = idMain.children[0];
  const leagueSelect = all(idPanel).find(n => n.tagName === "select" && n.attrs["aria-label"] === "Selected league");
  assert.strictEqual(leagueSelect.value, X, "the panel's league select names this league by id");
  assert.ok(leagueSelect.children.some(o => o.value === X && o.textContent === `Sleeper league ${X}`));
  assert.ok(idPanel.children.some(n => n.textContent === "In-season tools read this league's live Sleeper settings. No password needed."));
  assert.deepStrictEqual(leagueSelect.children.map(o => [o.value, o.textContent]), [[X, `Sleeper league ${X}`]],
    "anonymous: the picker offers only the league that is open");
  FC.setLeague(X);
  const usersX = [{ user_id: "s1", display_name: "Alpha", metadata: { team_name: "Alpha Squad" } }, { user_id: "s2", display_name: "Beta" }, { user_id: "s3", display_name: "Gamma", metadata: { team_name: "Gamma Rays" } }];
  const rostersX = [{ roster_id: 1, owner_id: "s1" }, { roster_id: 2, owner_id: "s2" }, { roster_id: 3, owner_id: "s3" }];
  const fetchedAt = Date.now() - 2000;
  const vb = {
    registry: { slug: null, platform: "sleeper", leagueId: X, tools: { startsit: true, waivers: true, trade: true } },
    identity: null, league: { name: "Synthetic Six", league_id: X }, users: usersX, rosters: rostersX, state: {},
    leagueFetchedAt: fetchedAt, rostersRequestedAt: fetchedAt - 5, rostersFetchedAt: fetchedAt,
    myRoster: null, myRosterStatus: "anonymous", viewedRosterId: null, analysisRoster: null, analysisRole: null,
    warnings: [], extra: null, generation: 1,
  };
  V.set({ st: "ready", bundle: vb });
  const teamSel = byId(idPanel, "session-team");
  assert.ok(teamSel, "an anonymous viewer is offered the league's teams");
  assert.deepStrictEqual(teamSel.children.map(o => [o.value, o.textContent]),
    [["", "Choose a team"], ["1", "Alpha Squad"], ["2", "Beta"], ["3", "Gamma Rays"]]);
  assert.strictEqual(teamSel.value, "");
  assert.ok(byId(idPanel, "session-user"), "identity stays optional: the username form is still offered");
  assert.ok(byId(idPanel, "session-refresh"), "an anonymous viewer can refresh the league");
  assert.strictEqual(byId(idPanel, "session-settings").textContent, Session.settingsText(vb));
  assert.match(byId(idPanel, "session-settings").textContent, /^League settings read \S/);
  teamSel.value = "2";
  teamSel.dispatch("change");
  assert.deepStrictEqual(V.calls.filter(c => c[0] === "view"), [["view", "2"]]);
  assert.match(byId(idPanel, "session-text").textContent, /^Viewing Beta · rosters [23] s ago$/);
  assert.strictEqual(byId(idPanel, "session-team").value, "2", "the picker shows the viewed team");
  // The ticker must not rebuild the picker (focus / open dropdown survive).
  const pickerNode = byId(idPanel, "session-team");
  FC.chip.render();
  assert.strictEqual(byId(idPanel, "session-team"), pickerNode);
  // Identified as the owner of roster 3: the owner line, no picker.
  const gamma = { username: "gamma", userId: "s3", displayName: "Gamma" };
  V.set({ id: gamma, bundle: { ...vb, identity: gamma, myRoster: rostersX[2], myRosterStatus: "found", analysisRoster: rostersX[2], analysisRole: "owner" } });
  assert.match(byId(idPanel, "session-text").textContent, /^Gamma · Synthetic Six · your roster: 3 · rosters [23] s ago$/);
  assert.ok(!byId(idPanel, "session-team"), "an owner is not offered other teams");
  assert.ok(byId(idPanel, "session-refresh") && byId(idPanel, "session-forget"));
  // Identified but not in this league: still a viewer's picker.
  const out = { username: "outsider", userId: "s9", displayName: "Outsider" };
  V.set({ id: out, bundle: { ...vb, identity: out, myRosterStatus: "none" } });
  assert.ok(byId(idPanel, "session-team"), "a non-owner can choose a team to view");
  assert.strictEqual(byId(idPanel, "session-text").textContent, "Could not uniquely match this account to a roster in this league.");
  // A failed league load (no bundle): retry re-runs ready by id, identity or not.
  V.set({ st: "error", err: `Sleeper has no league with id ${X}.`, id: null, bundle: null });
  assert.strictEqual(byId(idPanel, "session-text").textContent, `Sleeper has no league with id ${X}.`);
  byId(idPanel, "session-retry").dispatch("click");
  const idCalls = V.calls;
  FC.setLeague(null);

  // The league picker lists ONLY the visitor's own current-season leagues
  // (Session.leaguesFor, as connect.js does) plus the league that is open --
  // never a hard-coded list. Choosing one opens it on this in-season page, or
  // on Weekly from a page that is not an in-season tool.
  const Y = "100000000000000002", Z = "100000000000000009";
  async function pickerOn(href, open) {
    const P = stubSession(); FC._session(P);
    const seasons = [];
    P.leaguesFor = async opts => { seasons.push(opts.season); return [
      { league_id: Y, name: "League B" }, { league_id: X, name: "League X" }, { league_id: Y, name: "League B" }, { league_id: "../x", name: "bad" }] };
    P.set({ st: "identified", id: { username: "user_a", userId: "ua", displayName: "User A" },
      bundle: open ? { ...vb, identity: null, league: { name: "Synthetic Six", league_id: open }, state: { season: "2026" } } : null });
    const main = dom(href);
    const assigned = [];
    global.location.assign = url => assigned.push(url);
    FC.mountLeagueContext(open);
    await new Promise(r => setTimeout(r, 0));
    const sel = all(main.children[0]).find(n => n.tagName === "select" && n.attrs["aria-label"] === "Selected league");
    return { sel, assigned, seasons, P };
  }
  pickerChecks = (async () => {
    const w = await pickerOn(`${base}waivers.html?league=${X}&week=2`, X);
    assert.deepStrictEqual(w.seasons, ["2026"], "the season comes from the live state");
    assert.deepStrictEqual(w.sel.children.map(o => [o.value, o.textContent]), [[X, "League X"], [Y, "League B"]],
      "the open league first (by its name), then the account's other leagues, deduplicated, malformed ids dropped");
    assert.strictEqual(w.sel.value, X);
    w.sel.value = Y; w.sel.dispatch("change");
    assert.deepStrictEqual(w.assigned, [`${base}waivers.html?league=${Y}&week=2`], "choosing a league opens it on this page");
    // A page with no league open: the season is read from /state/nfl, then a
    // prompt option and the account's leagues; choosing opens Weekly.
    const stateCalls = [];
    window.Sleeper = { get: async path => { stateCalls.push(path); return { season: "2026" }; } };
    const a = await pickerOn(`${base}about.html`, null);
    delete window.Sleeper;
    assert.deepStrictEqual(stateCalls, ["/state/nfl"]);
    assert.deepStrictEqual(a.seasons, ["2026"]);
    assert.deepStrictEqual(a.sel.children.map(o => [o.value, o.textContent]), [["", "Choose one of your leagues"], [Y, "League B"], [X, "League X"]]);
    a.sel.value = X; a.sel.dispatch("change");
    assert.deepStrictEqual(a.assigned, [`${base}weekly.html?league=${X}`], "from a neutral page the choice opens Weekly");
    // The identity going away clears the account's leagues from the picker.
    a.P.set({ st: "anonymous", id: null });
    assert.deepStrictEqual(a.sel.children, [], "forget leaves no account leagues behind");
    // A failed lookup leaves the open league only.
    const f = stubSession(); FC._session(f);
    f.leaguesFor = async () => { throw new Error("HTTP 503"); };
    f.set({ st: "identified", id: { username: "user_a", userId: "ub", displayName: "User A" }, bundle: { ...vb, state: { season: "2026" } } });
    const fm = dom(`${base}weekly.html?league=${Z}`);
    FC.mountLeagueContext(Z);
    await new Promise(r => setTimeout(r, 0));
    const fs = all(fm.children[0]).find(n => n.tagName === "select");
    assert.deepStrictEqual(fs.children.map(o => o.value), [Z]);
  })();

  setTimeout(() => {
    // Async settlements: the superseded identify rejection left the anonymous
    // chip untouched (no error text, input still offered) and the identified
    // board triggered exactly one ready() for its slug.
    assert.strictEqual(byId(anonPanel, "session-text").textContent, REMEMBERED,
      "a superseded rejection must never be rendered");
    assert.ok(byId(anonPanel, "session-user"));
    assert.deepStrictEqual(R.calls, [["refresh", "rosters", false], ["refresh", "league", true], ["refresh", "rosters", false], ["forget"], ["ready", "leaguea"]], "identified + board loads the league once");
    assert.strictEqual(E.calls.length, 0, "ESPN never calls ready()");
    assert.deepStrictEqual(idCalls.filter(c => c[0] === "ready"), [["ready", { leagueId: X }], ["ready", { leagueId: X }]],
      "setLeague loads by id without an identity, and retry re-runs that load");
    pickerChecks.then(() => {
      FC._session(null);
      FC._registry([]);
      console.log("navigation_fixture: no default league, remembered league, old names, archived board, league picker and identity chip OK");
    }).catch(e => { console.error(e); process.exit(1); });
  }, 0);
}
