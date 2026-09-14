import pandas as pd
import pytest

from ffmodel.site import remaining as R


def setup(monkeypatch):
    history = pd.DataFrame([dict(player_id="a", season=2025, week=18),
                            dict(player_id="a", season=2026, week=2)])
    schedule = pd.DataFrame([dict(season=2026, week=w, home_team=h, away_team=a)
                             for w,h,a in [(1,"A","B"),(2,"A","C")]+
                             [(w,f"D{i}",f"D{i+1}") for w in (1,2) for i in range(0,18,2)]])
    seen = []

    def future(hist, sched, season, week, teams):
        seen.append(hist.copy())
        assert not ((hist.season == 2026) & (hist.week >= 1)).any()
        f = pd.DataFrame([dict(player_id="a",team="A",season=season,week=week,
                               **dict.fromkeys(R.PREDICTED_STATS, float("nan")))])
        return f, f

    def predict(f, model, season, week, through, **kwargs):
        return {"players":[dict(player_id="a",name="Player",position="RB",team="A",
                opponent="B" if week==1 else "C",points={"league":{"p50":10}},stat_quantiles={})]}

    monkeypatch.setattr(R,"combined_future_features",future)
    monkeypatch.setattr(R,"build_weekly_projections",predict)
    class Model:
        name="fixture"
        def attach_features(self, rows):
            pass
    args = dict(weekly=history,schedules=schedule,predictor=Model(),season=2026,start_week=1,end_week=2,
                current_teams={"a":"A","rookie":"B"},league={"league_id":"L","sleeper_scoring":{"rec":1}})
    return args, seen


def test_frozen_history_missing_and_bye_distinct(monkeypatch):
    args, seen = setup(monkeypatch)
    out=R.build_remaining(**args)
    assert len(seen)==2 and seen[0].equals(seen[1])
    assert out["data_through"]=="2025-wk18"
    assert out["advice_eligible"] is False
    assert out["players"][0]["weeks"][1]["opponent"]=="C"
    unknown=out["players"][1]
    assert [w["status"] for w in unknown["weeks"]]==["unmodeled","bye"]
    assert all(w["points"] is None for w in unknown["weeks"])
    assert unknown["history_status"] == "no_observed_history"
    assert unknown["last_observed_season"] is None
    assert unknown["weeks"][0]["reason"] == "no_observed_history"
    assert "season_points" not in out["players"][0]


def test_missing_history_reasons_use_only_pre_origin_rows(monkeypatch):
    args, _ = setup(monkeypatch)
    args["weekly"] = pd.concat([args["weekly"], pd.DataFrame([
        dict(player_id="old", season=2023, week=4),
        dict(player_id="recent", season=2025, week=4),
        dict(player_id="future", season=2026, week=2),
    ])], ignore_index=True)
    args["current_teams"].update({pid: "A" for pid in ("old", "recent", "future")})
    players = {p["player_id"]: p for p in R.build_remaining(**args)["players"]}
    assert players["old"]["weeks"][0]["reason"] == "outside_recent_history_window"
    assert players["recent"]["weeks"][0]["reason"] == "missing_model_output"
    assert players["future"]["weeks"][0]["reason"] == "no_observed_history"
    assert players["old"]["last_observed_season"] == 2023


@pytest.mark.parametrize("change", [{"end_week":19},{"start_week":3},{"current_teams":{}},
                                    {"current_teams":{"a":"BAD"}},{"league":{}}])
def test_bad_contracts_fail(monkeypatch, change):
    args,_=setup(monkeypatch)
    with pytest.raises(ValueError):
        R.build_remaining(**(args|change))


def test_missing_and_duplicate_schedule_fail(monkeypatch):
    args,_=setup(monkeypatch)
    for schedule in [args["schedules"].iloc[:1],pd.concat([args["schedules"],args["schedules"].iloc[:1]])]:
        with pytest.raises(ValueError,match="schedule"):
            R.build_remaining(**(args|{"schedules":schedule}))
