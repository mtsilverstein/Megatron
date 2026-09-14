import pandas as pd
from ffmodel.eval.starter_decisions import starter_pool,decision_pairs,summarize_decisions


def test_pool_uses_only_preorigin_baseline_and_stable_ties():
    players=pd.DataFrame([{"player_id":f"p{i:02}","position":"QB"} for i in range(30)])
    baseline=pd.Series({p:10. for p in players.player_id})
    assert starter_pool(players,baseline)==set(players.player_id[:24])
    assert starter_pool(players.sample(frac=1,random_state=3),baseline)==set(players.player_id[:24])


def test_decisions_missingness_ties_and_regret():
    predictions=pd.DataFrame([dict(player_id=p,position="RB",team="A",predicted=m,baseline=b)
        for p,m,b in [("a",10.,5.),("b",5.,10.),("missing",99.,99.),("traded",20.,20.)]])
    actuals=pd.DataFrame([dict(player_id=p,position="RB",team=t,actual=y)
        for p,t,y in [("a","A",12.),("b","A",2.),("traded","B",30.)]])
    result=decision_pairs(predictions,actuals,set(predictions.player_id))["RB"]
    assert result["decisive_forecast_pairs"]==1
    assert result["unobserved_or_changed_players"]==2
    assert result["model_regret_total"]==0 and result["baseline_regret_total"]==10
    report={"reports":[{"horizon":1,"starter_decisions":{"RB":result}}]}
    summary=summarize_decisions([report])[0]
    assert summary["model_accuracy"]==1 and summary["baseline_accuracy"]==0
    predictions.loc[predictions.player_id=="b","predicted"]=10.
    tied=decision_pairs(predictions,actuals,set(predictions.player_id))["RB"]
    assert tied["decisive_forecast_pairs"]==0 and tied["forecast_tie_pairs_excluded"]==1


def test_actual_ties_have_zero_regret_without_inflating_accuracy():
    predictions=pd.DataFrame([dict(player_id=p,position="QB",team="A",predicted=m,baseline=b)
        for p,m,b in [("a",10.,5.),("b",5.,10.)]])
    actuals=pd.DataFrame([dict(player_id=p,position="QB",team="A",actual=7.) for p in ("a","b")])
    counts=decision_pairs(predictions,actuals,{"a","b"})
    summary=summarize_decisions([{"reports":[{"horizon":1,"starter_decisions":counts}]}])[0]
    assert summary["decisive_forecast_pairs"]==1 and summary["actual_ties"]==1
    assert summary["model_accuracy"] is None and summary["baseline_accuracy"] is None
    assert summary["model_mean_regret"]==0 and summary["baseline_mean_regret"]==0
