const assert=require('node:assert/strict');
const {prepare}=require('../site/assets/weekly-experts.js');
const now=Date.parse('2026-09-12T10:00:00Z'), weekly={season:2026,week:1};
const source={schema_version:1,...weekly,source:'FantasyPros export',scoring_format:'ppr',snapshot_at:'2026-09-10T10:00:00Z',players:[{player_id:'a',position:'RB',ecr:3,projected_fpts:12.3}]};
assert.equal(prepare(source,weekly,now).get('a').ecr,3);
for(const change of [{week:2},{season:2025},{scoring_format:'unknown'},{snapshot_at:'2026-09-01'},{players:[...source.players,...source.players]}])
  assert.throws(()=>prepare({...source,...change},weekly,now));
assert.throws(()=>prepare({...source,players:[{...source.players[0],ecr:0}]},weekly,now));
assert.equal(prepare({...source,players:[{...source.players[0],projected_fpts:null}]},weekly,now).get('a').projected_fpts,null);
console.log('Weekly experts provenance, identity and metric checks passed');
