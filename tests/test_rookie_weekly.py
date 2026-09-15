import pandas as pd
import pytest

from ffmodel.eval import rookie_weekly as R
from ffmodel.site.weekly import RULESETS
from tests.test_eval_rookies import _toy_world as _season_world


def _toy_world():
    weekly, picks = _season_world()
    weekly["position"] = "RB"
    return weekly, picks


def test_walk_forward_missingness_and_history_groups(monkeypatch):
    weekly, picks = _toy_world()
    fit = R.fit_rookie_cohorts
    calls = []
    def checked(history, draft, through, **kwargs):
        assert history.season.max() < 2022
        assert draft.season.max() < 2022
        calls.append(kwargs["min_n"])
        return fit(history, draft, through, **kwargs)
    monkeypatch.setattr(R, "fit_rookie_cohorts", checked)
    cells = R.evaluate(weekly, picks, season=2022, origins=[1, 2, 5],
                       horizons=[1], rules=RULESETS["ppr"])
    assert calls == [25, 10**9]
    first = next(c for c in cells if c["origin"] == 1)
    assert first["forecast_players"] == 60
    assert first["evaluated"] == 30
    assert first["missing_actuals"] == 30
    assert first["bucketed_mae"] == 0
    low = next(c for c in cells if c["history_group"] == "one_to_three_recorded_games")
    assert low["origin"] == 2 and low["evaluated"] == 30
    last = next(c for c in cells if c["origin"] == 5)
    assert last["evaluated"] == 0 and last["forecast_players"] == 30
    assert last["bucketed_mae"] is None
    assert R.summarize(cells)[0]["evaluated"] >= 0


def test_future_stats_cannot_change_earlier_evaluation():
    weekly, picks = _toy_world()
    kwargs = dict(season=2022, origins=[1], horizons=[1], rules=RULESETS["ppr"])
    before = R.evaluate(weekly, picks, **kwargs)
    weekly.loc[(weekly.season == 2022) & (weekly.week > 1), "rushing_yards"] = 99999
    assert R.evaluate(weekly, picks, **kwargs) == before


def test_invalid_inputs_fail():
    weekly, picks = _toy_world()
    kwargs = dict(season=2022, origins=[1], horizons=[1], rules=RULESETS["ppr"])
    with pytest.raises(ValueError, match="duplicate weekly"):
        R.evaluate(pd.concat([weekly, weekly.iloc[:1]]), picks, **kwargs)
    with pytest.raises(ValueError, match="draft identity"):
        R.evaluate(weekly, pd.concat([picks, picks.iloc[:1]]), **kwargs)
    with pytest.raises(ValueError, match="origins/horizons"):
        R.evaluate(weekly, picks, **(kwargs | {"origins": [18], "horizons": [2]}))
    weekly.loc[0, "rushing_yards"] = float("nan")
    with pytest.raises(ValueError, match="nonfinite"):
        R.evaluate(weekly, picks, **kwargs)


def test_unidentified_draftees_keep_distinct_coverage_identities():
    picks = pd.DataFrame([dict(season=2025, pick=10, gsis_id=None),
                          dict(season=2025, pick=11, gsis_id=None)])
    result = R.draft_identity_frame(picks)
    assert result.gsis_id.tolist() == ["unresolved_draft:2025:10", "unresolved_draft:2025:11"]
    assert picks.gsis_id.isna().all()


def test_decision_integration_preserves_error_diagnostic():
    weekly, picks = _toy_world()
    weekly["team"] = "A"
    kwargs = dict(season=2022, origins=[1], horizons=[1], rules=RULESETS["ppr"])
    original = R.evaluate(weekly, picks, **kwargs)
    with_decisions = R.evaluate(weekly, picks, **kwargs, decisions=True)
    assert with_decisions[0]["decisions"]["candidate_pairs"] > 0
    assert with_decisions[0]["decisions"]["unobserved_or_changed_pairs"] > 0
    for cell in with_decisions:
        cell.pop("decisions")
    assert with_decisions == original


def test_observed_update_is_pre_origin_and_keeps_original_comparison():
    weekly, picks = _toy_world()
    weekly["team"] = "A"
    weekly.loc[(weekly.season == 2022) & (weekly.week == 1), "rushing_yards"] = 20
    kwargs = dict(season=2022, origins=[2], horizons=[1], rules=RULESETS["ppr"], decisions=True)
    original = R.evaluate(weekly, picks, **kwargs)
    updated = R.evaluate(weekly, picks, **kwargs, observed_update=True)
    low = next(c for c in updated if c["history_group"] == "one_to_three_recorded_games")
    assert low["observed_update"]["observed_mae"] == 6
    assert low["observed_update"]["capital_mae"] == 0
    assert low["observed_update"]["evaluated"] == low["evaluated"] == 30
    zero = next(c for c in updated if c["history_group"] == "zero_history")
    assert "observed_update" not in zero
    weekly.loc[(weekly.season == 2022) & (weekly.week > 2), "rushing_yards"] = 99999
    assert R.evaluate(weekly, picks, **kwargs, observed_update=True) == updated
    for cell in updated:
        cell.pop("observed_update", None)
    assert updated == original


def test_observed_update_requires_decision_mode():
    weekly, picks = _toy_world()
    with pytest.raises(ValueError, match="requires decisions"):
        R.evaluate(weekly, picks, season=2022, origins=[1], horizons=[1],
                   rules=RULESETS["ppr"], observed_update=True)
