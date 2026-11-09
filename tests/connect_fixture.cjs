// tests/connect_fixture.cjs — run with: node tests/connect_fixture.cjs
//
// The connect page identifies through the shared session and lists the
// account's current-season leagues, each opening the in-season pages by its
// id -- no league is singled out (the site names none). A change or forget in
// the session clears the rendered list. The in-season pages' connect prompt
// (initPrompt) reuses the same flow in one field. All ids and names are synthetic.
const assert = require('node:assert/strict');
global.window = {};
const Session = require('../site/assets/session.js');
const {discover, parseLeagueInput, initPrompt} = require('../site/assets/connect.js');
const {init} = window.LeagueConnect;

const IDLE = 'Load leagues for this username.';
const LA = '100000000000000001';
const LB = '100000000000000002';

// Map-backed storage so the session never reaches for localStorage here.
function fakeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _map: m,
  };
}
const reset = () => { Session._storage(fakeStorage()); Session._get(null); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

// A minimal fake DOM, just enough for init()'s handlers: elements that
// remember children and an assigned href, ids wired to getElementById.
function makeEl() {
  const el = {children: []};
  el.append = (...items) => { el.children.push(...items); };
  el.appendChild = c => { el.children.push(c); return c; };
  el.replaceChildren = () => { el.children = []; };
  el.addEventListener = (type, fn) => { (el._listeners ||= {})[type] = fn; };
  return el;
}
function collectAnchors(el, out = []) {
  if (el.href !== undefined) out.push(el);
  for (const c of el.children) collectAnchors(c, out);
  return out;
}
function mountPage() {
  const ids = {};
  for (const id of ['connect-user', 'connect-status', 'connect-results', 'connect-form', 'connect-league', 'connect-league-form', 'connect-league-status'])
    ids[id] = makeEl();
  ids['connect-user'].value = '';
  ids['connect-league'].value = '';
  ids['connect-league-status'].textContent = '';
  ids['connect-status'].textContent = IDLE;   // connect.html's own idle line
  global.document = {getElementById: id => ids[id], createElement: () => makeEl()};
  return ids;
}
const submit = ids => ids['connect-form']._listeners.submit({preventDefault() {}});
const sleeperFor = routes => ({get: async path => routes(path)});
const maxRoutes = path => {
  if (path === '/state/nfl') return {season: '2026'};
  if (path === '/user/user_a') return {user_id: '123', username: 'User_A', display_name: 'User A'};
  if (path === '/user/other') return {user_id: '456', username: 'Other', display_name: 'Other'};
  if (path === '/user/123/leagues/nfl/2026') return [{league_id: LA, season: '2026', name: 'League A'}];
  if (path === '/user/456/leagues/nfl/2026') return [{league_id: LB, season: '2026', name: 'League B'}];
  throw new Error(`unrouted ${path}`);
};

async function leagueCardsLinkTheInSeasonPagesById() {
  reset();
  const ids = mountPage();
  window.Sleeper = sleeperFor(maxRoutes);
  init();
  assert.equal(ids['connect-user'].value, '', 'anonymous session leaves the form empty (the chip shows any migrated prefill)');
  ids['connect-user'].value = 'user_a';
  await submit(ids);
  const hrefs = collectAnchors(ids['connect-results']).map(a => a.href);
  assert.deepEqual(hrefs, [
    `weekly.html?league=${LA}`,
    `waivers.html?league=${LA}`,
    `trade.html?league=${LA}`,
  ], 'a league card links the in-season pages by league id, without touching other tabs -- and no draft board');
  assert.match(ids['connect-status'].textContent, /^1 leagues for User A · 2026\./);
  assert.equal(Session.identity()?.userId, '123', 'the form identifies through the shared session');
  assert.equal(Session.state(), 'identified');
  assert.equal(ids['connect-user'].value, 'User_A', 'the form reflects the canonical username the session resolved');
  return ids;
}

// Every current-season league gets in-season links by its Sleeper id (any-
// league spec 5.4), and the same card: no league is "registered" any more.
async function everyLeagueGetsTheSameInSeasonLinks() {
  reset();
  const ids = mountPage();
  const X = '700000000000000001';
  window.Sleeper = sleeperFor(path => path === '/user/123/leagues/nfl/2026'
    ? [{league_id: X, season: '2026', name: 'Synthetic Six', status: 'in_season'}, {league_id: LA, season: '2026', name: 'League A'}]
    : maxRoutes(path));
  init();
  ids['connect-user'].value = 'user_a';
  await submit(ids);
  const [first, second] = ids['connect-results'].children;
  assert.deepEqual(collectAnchors(first).map(a => [a.href, a.textContent]), [
    [`weekly.html?league=${X}`, 'Weekly / start-sit'],
    [`waivers.html?league=${X}`, 'Waiver research'],
    [`trade.html?league=${X}`, 'In-season trade scenarios'],
  ], 'a league links the in-season pages by id and no draft board');
  const texts = node => [node.textContent, ...node.children.flatMap(texts)];
  assert.ok(!texts(first).some(t => /draft board|registered/i.test(t || '')), 'no card mentions a registered league or a draft board');
  assert.ok(!texts(first).some(t => /not supported yet/.test(t || '')), 'discovery no longer refuses unregistered leagues');
  assert.deepEqual(collectAnchors(second).map(a => a.href), [
    `weekly.html?league=${LA}`, `waivers.html?league=${LA}`, `trade.html?league=${LA}`,
  ], 'every league gets the same links');
  assert.match(ids['connect-status'].textContent, /^2 leagues for User A · 2026\./);
}

// Spec 5.1: without a username, a pasted league link or id loads the league
// read-only. Bare digits or a sleeper.com URL containing /leagues/<digits>
// opens weekly.html?league=<id>; anything else says so and goes nowhere.
async function pastedLeagueLinkOpensTheLeagueWithoutIdentity() {
  reset();
  const ids = mountPage();
  const navigated = [];
  global.location = {assign: url => navigated.push(url)};
  window.Sleeper = sleeperFor(() => { throw new Error('opening a pasted league must make no Sleeper call here'); });
  init();
  const X = LA;
  const open = value => { ids['connect-league'].value = value; ids['connect-league-form']._listeners.submit({preventDefault() {}}); };
  const MSG = 'Enter a Sleeper league id or a sleeper.com league link.';
  open(` ${X} `);
  open(`https://sleeper.com/leagues/${X}`);
  open(`https://sleeper.com/leagues/${X}/team`);
  open(`sleeper.com/leagues/700000000000000001/matchup?week=3`);
  assert.deepEqual(navigated, [`weekly.html?league=${X}`, `weekly.html?league=${X}`, `weekly.html?league=${X}`, 'weekly.html?league=700000000000000001']);
  assert.equal(ids['connect-league-status'].textContent, '', 'a good link leaves no error');
  for (const bad of ['leaguea', '', '   ', 'https://example.com/leagues/123', 'https://sleeper.com/leagues/abc/team', '12a3', 'https://sleeper.com/users/123']) {
    ids['connect-league-status'].textContent = '';
    open(bad);
    assert.equal(ids['connect-league-status'].textContent, MSG, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(navigated.length, 4, 'an invalid entry never navigates');
  assert.equal(Session.identity(), null, 'no identity was needed or created');
  assert.equal(parseLeagueInput(X), X);
  assert.equal(parseLeagueInput(`https://sleeper.com/leagues/${X}/team`), X);
  assert.equal(parseLeagueInput('https://www.sleeper.com/leagues/42'), '42');
  assert.equal(parseLeagueInput('https://evilsleeper.com/leagues/42'), null);
  assert.equal(parseLeagueInput(null), null);
  delete global.location;
}

async function forgetClearsRenderedResults(ids) {
  Session.forget();
  assert.deepEqual(ids['connect-results'].children, [], 'forget clears the account-derived league list');
  assert.equal(ids['connect-status'].textContent, IDLE, 'forget resets the status to idle');
  assert.equal(ids['connect-user'].value, '', 'forget empties the username form');
}

async function chipIdentityChangeClearsResultsAndReflectsUser(ids) {
  ids['connect-user'].value = 'user_a';
  await submit(ids);
  assert.equal(collectAnchors(ids['connect-results']).length, 3, 'results rendered again for user_a');
  // The chip identifies another account: results clear BEFORE the lookup
  // resolves, and the form shows the new account without auto-discovering.
  const pending = Session.identify('other', {get: maxRoutes});
  assert.deepEqual(ids['connect-results'].children, [], 'results clear as soon as the identity lookup starts');
  assert.equal(ids['connect-status'].textContent, IDLE);
  await pending;
  assert.equal(ids['connect-user'].value, 'Other', 'the form reflects the account the chip identified');
  assert.deepEqual(ids['connect-results'].children, [], 'no auto-discovery for the new account');
}

async function inFlightDiscoveryForOldAccountNeverRenders(ids) {
  // Identify resolves, then the league fetch stalls; forget lands in between.
  const leagues = deferred();
  window.Sleeper = sleeperFor(path => path === '/user/123/leagues/nfl/2026' ? leagues.promise : maxRoutes(path));
  ids['connect-user'].value = 'user_a';
  const run = submit(ids);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(Session.identity()?.userId, '123');
  Session.forget();
  leagues.resolve([{league_id: LA, season: '2026', name: 'League A'}]);
  await run;
  assert.deepEqual(ids['connect-results'].children, [], 'a discovery for a forgotten account must not render');
  assert.equal(ids['connect-status'].textContent, IDLE);
  assert.equal(ids['connect-user'].value, '');

  // The chip supersedes the form's own identify mid-flight: the form drops
  // its request silently and idles instead of showing a superseded error.
  const user = deferred();
  window.Sleeper = sleeperFor(path => path === '/user/user_a' ? user.promise : maxRoutes(path));
  ids['connect-user'].value = 'user_a';
  const run2 = submit(ids);
  await Session.identify('other', {get: maxRoutes});
  user.resolve({user_id: '123', username: 'User_A', display_name: 'User A'});
  await run2;
  assert.deepEqual(ids['connect-results'].children, []);
  assert.equal(ids['connect-status'].textContent, IDLE, 'a superseded lookup is never displayed as an error');
  assert.equal(Session.identity()?.userId, '456', 'the chip\'s account stands');
  assert.equal(ids['connect-user'].value, 'Other');
}

// Typing while a submitted lookup is still in flight: the typed text is the
// visitor's newest intent for the FIELD, so the lookup's canonical username
// must not overwrite it when it lands, and no cards render for it. The
// submitted lookup itself still commits as the identity -- that is what the
// visitor asked for when they pressed the button; editing clears the results
// list, it does not cancel the submitted lookup.
async function typingDuringAPendingLookupKeepsTheTypedName() {
  reset();
  const ids = mountPage();
  const user = deferred();
  window.Sleeper = sleeperFor(path => path === '/user/aaa' ? user.promise : path === '/user/123/leagues/nfl/2026' ? [] : maxRoutes(path));
  init();
  ids['connect-user'].value = 'aaa';
  const run = submit(ids);
  assert.equal(Session.state(), 'identifying');
  ids['connect-user'].value = 'bbb';
  ids['connect-user']._listeners.input();
  assert.deepEqual(ids['connect-results'].children, []);
  assert.equal(ids['connect-status'].textContent, IDLE, 'editing clears the results list and idles the status');
  user.resolve({user_id: '123', username: 'Aaa', display_name: 'Aaa'});
  await run;
  assert.equal(ids['connect-user'].value, 'bbb', 'a lookup landing must not overwrite what the visitor typed since');
  assert.deepEqual(ids['connect-results'].children, [], 'a superseded lookup renders no cards');
  assert.equal(ids['connect-status'].textContent, IDLE);
  assert.equal(Session.identity()?.username, 'Aaa', 'the SUBMITTED username is still the identity: pressing the button was the intent');
  // Once the field is clean again (the visitor submits what they typed), the
  // session's canonical name may be written back as before.
  window.Sleeper = sleeperFor(path => path === '/user/bbb' ? {user_id: '456', username: 'Bbb', display_name: 'B'} : path === '/user/456/leagues/nfl/2026' ? [] : maxRoutes(path));
  await submit(ids);
  assert.equal(ids['connect-user'].value, 'Bbb', 'a clean field takes the canonical username');
  assert.equal(Session.identity()?.userId, '456');
  // Forget with a dirty field: the list clears, the typed text stays.
  ids['connect-user'].value = 'ccc';
  ids['connect-user']._listeners.input();
  Session.forget();
  assert.equal(ids['connect-user'].value, 'ccc', 'forget must not blank a name the visitor is typing');
  assert.equal(Session.identity(), null);
}

async function unknownUsernameSurfacesTheSessionError() {
  reset();
  const ids = mountPage();
  window.Sleeper = sleeperFor(path => path === '/state/nfl' ? {season: '2026'} : null);
  init();
  ids['connect-user'].value = 'nobody';
  await submit(ids);
  assert.equal(ids['connect-status'].textContent, 'Unable to load leagues: Sleeper username was not found.');
  assert.equal(Session.state(), 'error');
  assert.equal(ids['connect-user'].value, 'nobody', 'a failed lookup keeps the typed name for correction');
}

async function identifiedSessionPrefillsTheForm() {
  reset();
  Session._get(maxRoutes);
  await Session.identify('user_a');
  const ids = mountPage();
  window.Sleeper = sleeperFor(maxRoutes);
  init();
  assert.equal(ids['connect-user'].value, 'User_A', 'a remembered identity prefills the form');
}

// The in-season pages' connect prompt: one field, the connect page's two ways
// in, and the choice opens on THIS page (no league is ever substituted).
async function connectPromptOpensTheChoiceOnThisPage() {
  reset();
  const ids = {};
  for (const id of ['connect-prompt-form', 'connect-prompt-input', 'connect-prompt-status', 'connect-prompt-results']) ids[id] = makeEl();
  ids['connect-prompt-input'].value = '';
  ids['connect-prompt-status'].textContent = '';
  global.document = {getElementById: id => ids[id] || null, createElement: tag => Object.assign(makeEl(), {tagName: tag})};
  const navigated = [];
  global.location = {href: 'https://example.test/Megatron/waivers.html', assign: url => navigated.push(url)};
  window.Sleeper = sleeperFor(maxRoutes);
  initPrompt();
  const send = async value => { ids['connect-prompt-input'].value = value; await ids['connect-prompt-form']._listeners.submit({preventDefault() {}}); };
  // A pasted league link (or id) opens that league here, with no lookup and no identity.
  await send(`https://sleeper.com/leagues/${LB}/team`);
  assert.deepEqual(navigated, [`waivers.html?league=${LB}`], 'a league link opens that league on this page');
  assert.equal(Session.identity(), null, 'no identity was needed or created');
  // A link that is not a sleeper.com league link is refused, never looked up as a username.
  await send('https://example.com/leagues/12');
  assert.equal(ids['connect-prompt-status'].textContent, 'Enter a Sleeper league id or a sleeper.com league link.');
  await send('   ');
  assert.equal(ids['connect-prompt-status'].textContent, 'Enter your Sleeper username or paste a sleeper.com league link.');
  assert.equal(navigated.length, 1);
  // A username lists the account's current-season leagues as links to this page.
  await send('user_a');
  assert.equal(Session.identity()?.userId, '123', 'the prompt identifies through the shared session (the league panel follows)');
  assert.equal(ids['connect-prompt-status'].textContent, '1 league for User A · 2026. Choose one:');
  assert.deepEqual(collectAnchors(ids['connect-prompt-results']).map(a => [a.href, a.textContent]), [[`waivers.html?league=${LA}`, 'League A']]);
  // An account with no current-season league says so.
  window.Sleeper = sleeperFor(path => path === '/user/123/leagues/nfl/2026' ? [] : maxRoutes(path));
  await send('user_a');
  assert.equal(ids['connect-prompt-status'].textContent, 'No 2026 Sleeper leagues for User A.');
  assert.deepEqual(ids['connect-prompt-results'].children, []);
  // An unknown username names the session's error.
  window.Sleeper = sleeperFor(path => path === '/state/nfl' ? {season: '2026'} : null);
  await send('nobody');
  assert.equal(ids['connect-prompt-status'].textContent, 'Unable to load leagues: Sleeper username was not found.');
  // A remembered identity prefills the field.
  reset();
  Session._get(maxRoutes);
  await Session.identify('user_a');
  ids['connect-prompt-input'].value = '';
  initPrompt();
  assert.equal(ids['connect-prompt-input'].value, 'User_A');
  // A page without the prompt's markup is left alone.
  global.document = {getElementById: () => null};
  initPrompt();
  delete global.location;
}

(async () => {
  const ids = await leagueCardsLinkTheInSeasonPagesById();
  await forgetClearsRenderedResults(ids);
  await chipIdentityChangeClearsResultsAndReflectsUser(ids);
  await inFlightDiscoveryForOldAccountNeverRenders(ids);
  await typingDuringAPendingLookupKeepsTheTypedName();
  await unknownUsernameSurfacesTheSessionError();
  await identifiedSessionPrefillsTheForm();
  await everyLeagueGetsTheSameInSeasonLinks();
  await pastedLeagueLinkOpensTheLeagueWithoutIdentity();

  await connectPromptOpensTheChoiceOnThisPage();

  reset();
  const paths = [];
  const league = {league_id: LA, season: '2026'};
  const get = async path => {
    paths.push(path);
    if (path === '/state/nfl') return {season: '2026'};
    if (path.startsWith('/user/a%2Fb')) return {user_id: '123'};
    return [league, {league_id: '999', season: '2026', name: '<script>bad</script>'}];
  };
  const result = await discover(' a/b ', get, Session);
  assert.deepEqual(result.rows.map(r => Object.keys(r)), [['league'], ['league']], 'a row is the league alone: no registry slug');
  assert.equal(result.rows[0].league.league_id, LA);
  assert.equal(result.identity.userId, '123');
  assert(paths.includes('/user/a%2Fb'));
  assert(paths.includes('/user/123/leagues/nfl/2026'));
  assert.equal(Session.identity()?.userId, '123', 'discover persists the identity through the session');
  await assert.rejects(discover('', get, Session), /username/);
  await assert.rejects(discover('x', async () => null, Session), /not found/);
  for (const bad of [null, [{...league, season: '2025'}], [league, league], [{...league, league_id: '../x'}]]) {
    await assert.rejects(discover('x', async path => path === '/state/nfl' ? {season: '2026'} : path === '/user/x' ? {user_id: '123'} : bad, Session));
  }
  await assert.rejects(discover('x', async path => path === '/state/nfl' ? {} : {user_id: '123'}, Session), /season/);
  // The session is the default when no session argument is given.
  const viaDefault = await discover('a/b', get);
  assert.equal(viaDefault.rows[0].league.league_id, LA);
  Session._storage(undefined);
  console.log('Sleeper league discovery fixture passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
