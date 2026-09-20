// tests/connect_fixture.cjs — run with: node tests/connect_fixture.cjs
//
// The connect page identifies through the shared session and lists the
// account's current-season leagues. Configured-league detection reads
// FC.REGISTRY; a change or forget in the session clears the rendered list.
const assert = require('node:assert/strict');
global.window = {};
const Session = require('../site/assets/session.js');
const {discover, slugForLeague} = require('../site/assets/connect.js');
const {init} = window.LeagueConnect;

const IDLE = 'Load leagues for this username.';
const GABAGOOL = '1376245373244301312';
const FAM = '1389736745205002240';

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
  for (const id of ['connect-user', 'connect-status', 'connect-results', 'connect-form'])
    ids[id] = makeEl();
  ids['connect-user'].value = '';
  ids['connect-status'].textContent = 'Gabagool and FAM use the same account: Max973.';
  global.document = {getElementById: id => ids[id], createElement: () => makeEl()};
  return ids;
}
const submit = ids => ids['connect-form']._listeners.submit({preventDefault() {}});
const sleeperFor = routes => ({get: async path => routes(path)});
const maxRoutes = path => {
  if (path === '/state/nfl') return {season: '2026'};
  if (path === '/user/max973') return {user_id: '123', username: 'Max973', display_name: 'Max'};
  if (path === '/user/other') return {user_id: '456', username: 'Other', display_name: 'Other'};
  if (path === '/user/123/leagues/nfl/2026') return [{league_id: GABAGOOL, season: '2026', name: 'Gabagool'}];
  if (path === '/user/456/leagues/nfl/2026') return [{league_id: FAM, season: '2026', name: 'FAM'}];
  throw new Error(`unrouted ${path}`);
};

async function configuredLeagueCardsLinkDraftWeeklyWaivers() {
  reset();
  const ids = mountPage();
  window.Sleeper = sleeperFor(maxRoutes);
  init();
  assert.equal(ids['connect-user'].value, '', 'anonymous session leaves the form empty (the chip shows any migrated prefill)');
  ids['connect-user'].value = 'max973';
  await submit(ids);
  const hrefs = collectAnchors(ids['connect-results']).map(a => a.href);
  assert.deepEqual(hrefs, [
    'index.html?league=gabagool',
    'weekly.html?league=gabagool',
    'waivers.html?league=gabagool',
  ], 'a configured league card must link draft, weekly and waivers, in that order, without touching other tabs');
  assert.match(ids['connect-status'].textContent, /^1 leagues for Max · 2026\./);
  assert.equal(Session.identity()?.userId, '123', 'the form identifies through the shared session');
  assert.equal(Session.state(), 'identified');
  assert.equal(ids['connect-user'].value, 'Max973', 'the form reflects the canonical username the session resolved');
  return ids;
}

async function forgetClearsRenderedResults(ids) {
  Session.forget();
  assert.deepEqual(ids['connect-results'].children, [], 'forget clears the account-derived league list');
  assert.equal(ids['connect-status'].textContent, IDLE, 'forget resets the status to idle');
  assert.equal(ids['connect-user'].value, '', 'forget empties the username form');
}

async function chipIdentityChangeClearsResultsAndReflectsUser(ids) {
  ids['connect-user'].value = 'max973';
  await submit(ids);
  assert.equal(collectAnchors(ids['connect-results']).length, 3, 'results rendered again for max973');
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
  ids['connect-user'].value = 'max973';
  const run = submit(ids);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(Session.identity()?.userId, '123');
  Session.forget();
  leagues.resolve([{league_id: GABAGOOL, season: '2026', name: 'Gabagool'}]);
  await run;
  assert.deepEqual(ids['connect-results'].children, [], 'a discovery for a forgotten account must not render');
  assert.equal(ids['connect-status'].textContent, IDLE);
  assert.equal(ids['connect-user'].value, '');

  // The chip supersedes the form's own identify mid-flight: the form drops
  // its request silently and idles instead of showing a superseded error.
  const user = deferred();
  window.Sleeper = sleeperFor(path => path === '/user/max973' ? user.promise : maxRoutes(path));
  ids['connect-user'].value = 'max973';
  const run2 = submit(ids);
  await Session.identify('other', {get: maxRoutes});
  user.resolve({user_id: '123', username: 'Max973', display_name: 'Max'});
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
  await Session.identify('max973');
  const ids = mountPage();
  window.Sleeper = sleeperFor(maxRoutes);
  init();
  assert.equal(ids['connect-user'].value, 'Max973', 'a remembered identity prefills the form');
}

(async () => {
  const ids = await configuredLeagueCardsLinkDraftWeeklyWaivers();
  await forgetClearsRenderedResults(ids);
  await chipIdentityChangeClearsResultsAndReflectsUser(ids);
  await inFlightDiscoveryForOldAccountNeverRenders(ids);
  await typingDuringAPendingLookupKeepsTheTypedName();
  await unknownUsernameSurfacesTheSessionError();
  await identifiedSessionPrefillsTheForm();

  // Configured-league detection comes from FC.REGISTRY, never a local map.
  assert.equal(slugForLeague(GABAGOOL), 'gabagool');
  assert.equal(slugForLeague(FAM), 'fam');
  assert.equal(slugForLeague('69827905'), null, 'the ESPN entry is not a Sleeper league');
  assert.equal(slugForLeague('999'), null);

  reset();
  const paths = [];
  const league = {league_id: GABAGOOL, season: '2026'};
  const get = async path => {
    paths.push(path);
    if (path === '/state/nfl') return {season: '2026'};
    if (path.startsWith('/user/a%2Fb')) return {user_id: '123'};
    return [league, {league_id: '999', season: '2026', name: '<script>bad</script>'}];
  };
  const result = await discover(' a/b ', get, Session);
  assert.equal(result.rows[0].slug, 'gabagool');
  assert.equal(result.rows[1].slug, null);
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
  assert.equal(viaDefault.rows[0].slug, 'gabagool');
  Session._storage(undefined);
  console.log('Sleeper league discovery fixture passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
