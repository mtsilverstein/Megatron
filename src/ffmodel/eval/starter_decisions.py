"""Frozen-origin starter-pool comparisons; not a real-roster backtest."""
from itertools import combinations

# Fixed before running this diagnostic. Broad starter/depth pools for 12 teams.
POOL_SIZE = {"QB":24, "RB":60, "WR":72, "TE":24}


def starter_pool(latest, baseline):
    ranked=latest[["player_id","position"]].copy()
    ranked["baseline"]=ranked.player_id.map(baseline)
    ranked=ranked[ranked.position.isin(POOL_SIZE) & ranked.baseline.notna()]
    ranked=ranked.sort_values(["baseline","player_id"],ascending=[False,True])
    return set(pid for pos,n in POOL_SIZE.items() for pid in ranked[ranked.position==pos].head(n).player_id)


def decision_pairs(predictions, actuals, pool):
    p=predictions[predictions.player_id.isin(pool)]
    rows=p.merge(actuals[["player_id","position","team","actual"]],on="player_id",how="left",suffixes=("","_actual"))
    results={}
    for pos,group in rows.groupby("position"):
        valid=group.actual.notna() & group.team.eq(group.team_actual) & group.position.eq(group.position_actual)
        evaluated=group[valid]
        total=0; tied_forecast=0; actual_ties=0; model_correct=0; baseline_correct=0
        model_regret=0.; baseline_regret=0.
        for a,b in combinations(evaluated.to_dict("records"),2):
            model_gap=a["predicted"]-b["predicted"]
            baseline_gap=a["baseline"]-b["baseline"]
            if model_gap==0 or baseline_gap==0:
                tied_forecast+=1
                continue  # identical decisive-pair denominator for both methods
            actual_gap=a["actual"]-b["actual"]
            total+=1
            actual_ties+=int(actual_gap==0)
            model_correct+=int(model_gap*actual_gap>0)
            baseline_correct+=int(baseline_gap*actual_gap>0)
            model_regret+=max(0.,-actual_gap if model_gap>0 else actual_gap)
            baseline_regret+=max(0.,-actual_gap if baseline_gap>0 else actual_gap)
        results[pos]={"forecast_players":len(group),"evaluated_players":len(evaluated),
                      "unobserved_or_changed_players":int((~valid).sum()),
                      "decisive_forecast_pairs":total,"forecast_tie_pairs_excluded":tied_forecast,
                      "actual_ties":actual_ties,"model_correct":model_correct,"baseline_correct":baseline_correct,
                      "model_regret_total":model_regret,"baseline_regret_total":baseline_regret}
    return results


def summarize_decisions(reports):
    sums={}
    for report in reports:
        for cell in report["reports"]:
            for pos,counts in cell["starter_decisions"].items():
                for key in [(cell["horizon"],pos),(cell["horizon"],"ALL")]:
                    acc=sums.setdefault(key,{k:0 for k in counts})
                    for k,v in counts.items(): acc[k]+=v
    result=[]
    for (horizon,pos),counts in sorted(sums.items()):
        n=counts["decisive_forecast_pairs"]
        decisions=n-counts["actual_ties"]
        result.append(dict(horizon=horizon,position=pos,**counts,
            model_accuracy=counts["model_correct"]/decisions if decisions else None,
            baseline_accuracy=counts["baseline_correct"]/decisions if decisions else None,
            model_mean_regret=counts["model_regret_total"]/n if n else None,
            baseline_mean_regret=counts["baseline_regret_total"]/n if n else None))
    return result
