import pandas as pd
import pytest

from ffmodel.eval import rookie_veteran_model as M
from ffmodel.eval.rookie_decisions import compare


def test_frozen_training_horizons_missing_and_rule_restore(monkeypatch):
    history = pd.DataFrame([dict(player_id="v", season=2025, week=18),
                            dict(player_id="v", season=2026, week=1)])
    veterans = pd.DataFrame([dict(player_id="v", position="RB", team="A", predicted=8),
                             dict(player_id="bye", position="RB", team="B", predicted=9)])
    monkeypatch.setattr(M, "build_features", lambda h, s: h.copy())
    seen = []
    def future(h, schedules, season, week, teams):
        assert h.equals(history)
        seen.append(week)
        f = pd.DataFrame([dict(player_id="v", position="RB", team="A", season=season,
                              week=week, **dict.fromkeys(M.PREDICTED_STATS, float("nan")))])
        return f, f
    monkeypatch.setattr(M, "combined_future_features", future)
    class Model:
        def fit(self, train):
            assert train.season.tolist() == [2025]
        def attach_features(self, f):
            assert f.week.iloc[0] in [2, 4]
    monkeypatch.setattr(M, "build_weekly_projections", lambda *a: {"players": [
        dict(player_id="v", position="RB", team="A", points={"league": {"p50": 12}})]})
    previous = M.RULESETS["league"]
    forecast = M.forecaster(history, pd.DataFrame(), 2026, M.RULESETS["ppr"], lambda f: Model())
    for week in [2, 4]:
        out = forecast(veterans, week)
        assert out.predicted.iloc[0] == 12
        assert pd.isna(out.predicted.iloc[1])
    assert seen == [2, 4]
    assert M.RULESETS["league"] == previous
    assert veterans.predicted.tolist() == [8, 9]
    rookies = [dict(player_id="r", position="RB", bucketed=10, baseline=3)]
    counts = compare(rookies, out.iloc[1:], pd.DataFrame())
    assert counts["unprojected_pairs"] == 1 and counts["decisive_pairs"] == 0
    def broken(*args):
        raise ValueError("broken forecast")
    monkeypatch.setattr(M, "build_weekly_projections", broken)
    with pytest.raises(ValueError, match="broken"):
        forecast(veterans, 2)
    assert M.RULESETS["league"] == previous
