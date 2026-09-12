const assert = require('node:assert/strict');
const {discover} = require('../site/assets/connect.js');
(async () => {
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
