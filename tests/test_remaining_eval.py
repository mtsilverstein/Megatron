import pandas as pd
import pytest
from ffmodel.eval.remaining import score_horizon, evaluate_origin


def test_missing_and_traded_rows_are_not_zero_points():
    predictions=pd.DataFrame([dict(player_id=p,position="RB",team="A",predicted=10.) for p in ["a","b","c"]])
    actuals=pd.DataFrame([dict(player_id="a",position="RB",team="A",actual=6.),
                         dict(player_id="c",position="RB",team="B",actual=20.)])
    out=score_horizon(predictions,actuals,season=2025,origin=8,week=11)
    assert out["horizon"]==4
    assert out["overall"]==dict(forecast_players=3,observed_actuals=2,missing_actuals=1,
                                team_or_position_changed=1,evaluated=1,mae=4.,bias=4.)
    with pytest.raises(ValueError,match="duplicate"):
        score_horizon(pd.concat([predictions,predictions]),actuals,season=2025,origin=8,week=11)


def test_empty_comparable_cohort_has_null_metrics():
    predictions=pd.DataFrame([dict(player_id="a",position="RB",team="A",predicted=10.)])
    actuals=pd.DataFrame(columns=["player_id","position","team","actual"]).astype({"actual":float})
    out=score_horizon(predictions,actuals,season=2025,origin=8,week=8)
    assert out["overall"]["mae"] is None
    assert out["overall"]["missing_actuals"]==1


def test_horizon_validation_precedes_model_loading():
    for origin,horizons in [(18,[1]),(16,[4]),(1,[1,1]),(1,[])]:
        with pytest.raises(ValueError):
            evaluate_origin(None,None,season=2025,origin=origin,horizons=horizons,league=None,predictor_factory=None)


def test_origin_history_and_fit_never_include_future(monkeypatch):
    from ffmodel.eval import remaining as R
    from ffmodel.league import load_league
    rows=pd.DataFrame([dict(player_id="a",season=2024,week=18,team="A",position="RB"),
                       dict(player_id="a",season=2025,week=7,team="A",position="RB"),
                       dict(player_id="a",season=2025,week=8,team="FUTURE",position="RB")])
    for c in R.PREDICTED_STATS:
        rows[c]=0.
    schedules=pd.DataFrame([dict(season=2025,week=8,home_team="A" if i==0 else f"T{i}",away_team=f"T{i+1}",home_score=1,away_score=0) for i in range(0,20,2)])
    fillers=pd.DataFrame([dict(player_id=f"f-{t}",season=2025,week=8,team=t,position="RB",
                              **dict.fromkeys(R.PREDICTED_STATS,0.))
                         for t in list(schedules.home_team)+list(schedules.away_team)])
    rows=pd.concat([rows,fillers],ignore_index=True)
    def features(history,schedules):
        assert "FUTURE" not in set(history.team)
        return history
    class Model:
        name="test"
        def fit(self,train):
            assert train.season.max()==2024
    def future(history,schedules,season,week,teams):
        assert teams=={"a":"A"}
        f=rows.iloc[:1].copy().assign(season=2025,week=8)
        f[R.PREDICTED_STATS]=float("nan")
        return f,f
    def projections(*args,**kwargs):
        assert kwargs["pick_six_prior"] is None
        return {"players":[dict(player_id="a",position="RB",team="A",points={"league":{"p50":10.}})]}
    monkeypatch.setattr(R,"build_features",features)
    monkeypatch.setattr(R,"combined_future_features",future)
    monkeypatch.setattr(R,"build_weekly_projections",projections)
    # Restore process-global scoring after the diagnostic test.
    from ffmodel.site.weekly import RULESETS
    previous=RULESETS["league"]
    try:
        out=evaluate_origin(rows,schedules,season=2025,origin=8,horizons=[1],league=load_league("gabagool"),predictor_factory=lambda f:Model())
        assert out["reports"][0]["overall"]["team_or_position_changed"]==1
        assert out["reports"][0]["pick_six_evaluated"] is False
        assert RULESETS["league"] is previous
        with pytest.raises(ValueError,match="missing actual stat coverage"):
            evaluate_origin(rows[rows.team != "T19"],schedules,season=2025,origin=8,horizons=[1],
                            league=load_league("gabagool"),predictor_factory=lambda f:Model())
        assert RULESETS["league"] is previous
    finally:
        R.set_league_rules(previous)
