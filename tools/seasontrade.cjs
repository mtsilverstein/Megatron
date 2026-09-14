/* Read-only local prototype. Never sends a trade or changes a roster. */
const fs=require('node:fs');
const {analyze}=require('../site/assets/seasontrade.js');
async function main(){
  const path=process.argv[2];
  if(!path) throw Error('Usage: node tools/seasontrade.cjs scenario.json (see docs/trade-scenarios.md)');
  const request=JSON.parse(fs.readFileSync(path,'utf8'));
  const remaining=JSON.parse(fs.readFileSync(request.remainingPath,'utf8'));
  const slug=remaining.league?.slug;
  if(!['fam','gabagool'].includes(slug))throw Error('Prototype supports Gabagool and FAM identity boards');
  const board=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../site/data',slug==='fam'?'draft-fam.json':'draft.json'),'utf8'));
  const leagueId=remaining.league?.league_id;
  if(!/^\d+$/.test(String(leagueId))) throw Error('Expected a numeric Sleeper league ID');
  const get=async path=>{
    const response=await fetch('https://api.sleeper.app/v1'+path,{signal:AbortSignal.timeout(30000)});
    if(!response.ok) throw Error(`Sleeper request failed: ${response.status}`);
    return response.json();
  };
  const snapshotAt=Date.now();
  const [league,rosters,catalog,state]=await Promise.all([
    get(`/league/${leagueId}`),get(`/league/${leagueId}/rosters`),get('/players/nfl'),get('/state/nfl')]);
  if(String(state.season)!==String(league.season)||state.season_type!=='regular') throw Error('NFL state does not match regular-season league');
  const result=analyze({...request,remaining,board,league,rosters,catalog,currentWeek:Number(state.week),snapshotAt,now:Date.now()});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
main().catch(error=>{
  const report=error.coverageIssues ? JSON.stringify({advice_eligible:false,error:error.message,coverageIssues:error.coverageIssues},null,2) : error.message;
  process.stderr.write(report+'\n');process.exitCode=1;
});
