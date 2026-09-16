const assert = require('node:assert/strict');
global.window = {};
const {discover} = require('../site/assets/connect.js');
const {init} = window.LeagueConnect;

// A minimal fake DOM, just enough for init()'s submit handler: elements that
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

async function configuredLeagueCardsLinkDraftWeeklyWaivers() {
  const ids = {};
  for (const id of ['connect-user', 'connect-status', 'connect-results', 'connect-form'])
    ids[id] = makeEl();
  ids['connect-user'].value = 'max973';
  global.document = {
    getElementById: id => ids[id],
    createElement: () => makeEl(),
  };
  window.Sleeper = {
    get: async path => {
      if (path === '/state/nfl') return {season: '2026'};
      if (path.startsWith('/user/max973')) return {user_id: '123', display_name: 'Max'};
      return [{league_id: '1376245373244301312', season: '2026', name: 'Gabagool'}];
    },
  };
  init();
  await ids['connect-form']._listeners.submit({preventDefault() {}});
  const anchors = collectAnchors(ids['connect-results']);
  const hrefs = anchors.map(a => a.href);
  assert.deepEqual(hrefs, [
    'index.html?league=gabagool',
    'weekly.html?league=gabagool',
    'waivers.html?league=gabagool',
  ], 'a configured league card must link draft, weekly and waivers, in that order, without touching other tabs');
}

(async () => {
  await configuredLeagueCardsLinkDraftWeeklyWaivers();
  const paths = [];
  const league = {league_id:'1376245373244301312', season:'2026'};
  const get = async path => {
    paths.push(path);
    if (path === '/state/nfl') return {season:'2026'};
    if (path.startsWith('/user/a%2Fb')) return {user_id:'123'};
    return [league, {league_id:'999',season:'2026',name:'<script>bad</script>'}];
  };
  const result = await discover(' a/b ', get);
  assert.equal(result.rows[0].slug, 'gabagool');
  assert.equal(result.rows[1].slug, null);
  assert(paths.includes('/user/123/leagues/nfl/2026'));
  await assert.rejects(discover('', get), /username/);
  await assert.rejects(discover('x', async () => null), /not found/);
  for (const bad of [null, [{...league,season:'2025'}], [league,league], [{...league,league_id:'../x'}]]) {
    await assert.rejects(discover('x', async path => path === '/state/nfl' ? {season:'2026'} : path === '/user/x' ? {user_id:'123'} : bad));
  }
  await assert.rejects(discover('x', async path => path === '/state/nfl' ? {} : {user_id:'123'}), /season/);
  console.log('Sleeper league discovery fixture passed');
})().catch(error => {console.error(error); process.exitCode=1;});
