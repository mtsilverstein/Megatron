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
    assert "advice_eligible" not in out
    assert out["evaluation"] is None
    row = out["players"][0]["weeks"][0]
    assert row["points"] == {"league": {"p50": 10}}
    assert "stat_quantiles" not in row
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


def test_only_league_lens_survives_slimming(monkeypatch):
    args, _ = setup(monkeypatch)
    def predict(f, model, season, week, through, **kwargs):
        return {"players":[dict(player_id="a",name="Player",position="RB",team="A",opponent="B",
                points={"ppr":{"p50":9},"league":{"p10":4,"p50":10,"p90":16}},
                stat_quantiles={"p50":{"rushing_yards":50}})]}
    monkeypatch.setattr(R,"build_weekly_projections",predict)
    row = R.build_remaining(**args)["players"][0]["weeks"][0]
    assert row["points"] == {"league": {"p10":4,"p50":10,"p90":16}}
    assert "stat_quantiles" not in row and "ppr" not in row["points"]


def test_missing_league_lens_fails_closed(monkeypatch):
    args, _ = setup(monkeypatch)
    monkeypatch.setattr(R,"build_weekly_projections", lambda *a, **k: {"players":[dict(
        player_id="a",name="Player",position="RB",team="A",opponent="B",points={"ppr":{"p50":9}},stat_quantiles={})]})
    with pytest.raises(ValueError, match="league lens"):
        R.build_remaining(**args)


def test_evaluation_passes_through(monkeypatch):
    args, _ = setup(monkeypatch)
    block = {"source": "x.json", "horizons": []}
    assert R.build_remaining(**args, evaluation=block)["evaluation"] == block


def _write_diagnostic(tmp_path, name="remaining_matrix_gabagool.json"):
    import json
    (tmp_path / name).write_text(json.dumps({
        "schema_version": 1, "diagnostic": "remaining_matrix", "advice_eligible": False,
        "seasons": [2023, 2024, 2025], "origins": [5, 9], "horizons": [1, 2],
        "limitation": "Dependent windows; descriptive only.",
        "summary": [
            {"horizon": 1, "position": "ALL", "model_mae": 4.6121, "baseline_mae": 4.8154, "paired_player_forecasts": 1817,
             "forecast_players": 3701, "missing_actuals": 1857},
            {"horizon": 1, "position": "QB", "model_mae": 7.9, "baseline_mae": 8.1, "paired_player_forecasts": 195,
             "forecast_players": 400, "missing_actuals": 200},
            {"horizon": 2, "position": "ALL", "model_mae": 4.4521, "baseline_mae": 4.7221, "paired_player_forecasts": 1791,
             "forecast_players": 3650, "missing_actuals": 1830},
        ]}))
    return tmp_path


def test_load_evaluation_reads_committed_diagnostic(tmp_path):
    d = _write_diagnostic(tmp_path)
    out = R.load_evaluation("gabagool", {"rec": 1}, diagnostics_dir=d)
    assert out["source"] == "models/diagnostics/remaining_matrix_gabagool.json"
    assert out["baseline"] == "mean league-scored production in the last four recorded pre-origin games"
    assert out["seasons"] == [2023, 2024, 2025] and out["origins"] == [5, 9]
    assert out["horizons"] == [
        {"horizon": 1, "model_mae": 4.612, "baseline_mae": 4.815, "paired_forecasts": 1817,
         "forecast_players": 3701, "missing_actuals": 1857},
        {"horizon": 2, "model_mae": 4.452, "baseline_mae": 4.722, "paired_forecasts": 1791,
         "forecast_players": 3650, "missing_actuals": 1830}]
    assert out["limitation"] == "Dependent windows; descriptive only."
    assert "scoring_scope" not in out


def test_load_evaluation_borrows_reference_only_when_scoring_matches(tmp_path):
    d = _write_diagnostic(tmp_path)
    same = R.load_evaluation("fam", {"rec": 1, "pass_td": 4}, diagnostics_dir=d,
                             reference_scoring={"pass_td": 4, "rec": 1})
    assert same["source"] == "models/diagnostics/remaining_matrix_gabagool.json"
    assert same["scoring_scope"] == "evaluated under gabagool scoring, which matches this league"
    # Unmodeled keys (kicker distance bands vs a flat fgm_yds field) must not
    # block the borrow: the diagnostic only scores modeled stat components.
    unmodeled_diff = R.load_evaluation(
        "fam", {"rec": 1, "pass_td": 4, "fgm_0_19": 3}, diagnostics_dir=d,
        reference_scoring={"rec": 1, "pass_td": 4, "fgm_yds": 0.1})
    assert unmodeled_diff["scoring_scope"] == "evaluated under gabagool scoring, which matches this league"
    # A difference on a MODELED key still blocks the borrow.
    assert R.load_evaluation("fam", {"rec": 0.5}, diagnostics_dir=d,
                             reference_scoring={"rec": 1}) is None
    assert R.load_evaluation("fam", {"rec": 1}, diagnostics_dir=d) is None  # no reference scoring given
    assert R.load_evaluation("gabagool", {"rec": 1}, diagnostics_dir=tmp_path / "nowhere") is None
