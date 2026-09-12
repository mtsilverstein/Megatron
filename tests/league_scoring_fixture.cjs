const assert=require('node:assert/strict');
const {score}=require('../site/assets/league-scoring.js');
const q={p10:{passing_yards:200,passing_interceptions:0,passing_pick_sixes:0.123456789},
  p50:{passing_yards:250,passing_interceptions:1,passing_pick_sixes:0.123456789},
  p90:{passing_yards:300,passing_interceptions:3,passing_pick_sixes:0.123456789}};
const weights={pass_yd:.04,pass_int:-2,pass_int_td:-3};
const result=score(q,weights), cost=3*.123456789;
assert(Math.abs(result.p50-(8-cost))<1e-12);
assert(Math.abs(result.p10-(2-cost))<1e-12);
assert(Math.abs(result.p90-(12-cost))<1e-12);
assert.deepEqual(score({...q,p10:null,p90:null},weights),{p10:null,p50:result.p50,p90:null});
assert.throws(()=>score({...q,p10:null},weights),/Incomplete/);
for (const bad of [NaN,Infinity,null,'6']) assert.throws(()=>score(q,{pass_td:bad}),/Invalid/);
assert.throws(()=>score(q,{pass_td:6}),/Missing/);
assert.throws(()=>score(q,{bonus_pass_yd_300:3}),/Unsupported/);
assert.throws(()=>score(q,{toString:3}),/Unsupported/);
for (const empty of [{},{unknown:0},{pass_yd:0}]) assert.throws(()=>score(q,empty),/Missing active/);
assert.deepEqual(score(q,{...weights,unknown:0}),result);
assert.throws(()=>score({p50:{passing_yards:Number.MAX_VALUE},p10:null,p90:null},{pass_yd:2}),/overflow/);
console.log('Custom league scoring fixture passed');
