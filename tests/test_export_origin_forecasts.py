import math
from dataclasses import replace

import pandas as pd
import pytest

from ffmodel.eval import remaining as R
from ffmodel.eval.export_origin_forecasts import origin_forecasts
from ffmodel.league import load_league
from ffmodel.site.weekly import RULESETS

SEASON, ORIGIN, LAST = 2025, 8, 10


def _fixture(monkeypatch):
    """Stub-predictor setup copied from test_remaining_eval's origin test."""
    base = [dict(player_id="a", season=2024, week=18, team="A", position="RB"),
            dict(player_id="a", season=2025, week=6, team="A", position="RB"),
            dict(player_id="a", season=2025, week=7, team="A", position="RB"),
            dict(player_id="b", season=2025, week=7, team="B", position="WR"),
            dict(player_id="d", season=2025, week=7, team="A", position="TE"),
            # Last seen two seasons back: outside the origin cohort.
            dict(player_id="c", season=2023, week=17, team="C", position="QB"),
            # Target-week actuals, including a team change and missing
            # pick-six counts: none of this may move the forecasts.
            dict(player_id="a", season=2025, week=8, team="FUTURE", position="RB"),
            dict(player_id="b", season=2025, week=10, team="B", position="WR"),
            dict(player_id="e", season=2025, week=9, team="A", position="RB")]
    rows = pd.DataFrame(base)
    for c in R.PREDICTED_STATS:
        rows[c] = 0.
    rows["receptions"] = [1., 3., 5., 7., 2., 9., 40., 50., 60.]
    rows["passing_pick_sixes"] = 0.
    rows.loc[(rows.season == SEASON) & (rows.week >= ORIGIN), "passing_pick_sixes"] = float("nan")
    # Week 9: team B on bye. Weeks 8 and 10: A and B both play.
    schedules = pd.DataFrame(
        [dict(season=SEASON, week=w, game_type="REG", home_team=h, away_team=a,
              home_score=None, away_score=None)
         for w, h, a in [(8, "A", "B"), (9, "A", "X"), (10, "B", "A")]])
    seen = []

    def features(history, schedules):
        assert not ((history.season == SEASON) & (history.week >= ORIGIN)).any()
        return history

    class Model:
        name = "test"
        def fit(self, train):
            assert train.season.max() == SEASON - 1
        def attach_features(self, combined):
            # Only the stat-free future skeleton may sit at or after the origin.
            target = combined[(combined.season == SEASON) & (combined.week >= ORIGIN)]
            assert target[R.PREDICTED_STATS].isna().all().all()

    def future(history, schedules, season, week, teams):
        seen.append(("future", week, dict(teams)))
        assert not ((history.season == SEASON) & (history.week >= ORIGIN)).any()
        games = schedules[(schedules.season == season) & (schedules.week == week)]
        playing = set(games.home_team) | set(games.away_team)
        f = pd.DataFrame([dict(player_id=p, team=t, season=season, week=week,
                               position=history[history.player_id == p].position.iloc[-1],
                               **dict.fromkeys(R.PREDICTED_STATS, float("nan")))
                          for p, t in sorted(teams.items()) if t in playing])
        return f, f

    def projections(future, model, season, week, source, **kwargs):
        assert kwargs["pick_six_prior"] is None
        players = []
        for _, r in future.iterrows():
            if r.player_id == "d" and week == 10:
                continue  # coverage gap: scheduled but unprojected
            mid = 10. + week + (r.player_id == "b")
            players.append(dict(player_id=r.player_id, position=r.position, team=r.team,
                                points={"league": {"p10": mid - 4, "p50": mid, "p90": mid + 6}}))
        return {"players": players}

    monkeypatch.setattr(R, "build_features", features)
    monkeypatch.setattr(R, "combined_future_features", future)
    monkeypatch.setattr(R, "build_weekly_projections", projections)
    return rows, schedules, Model, seen


def _run(rows, schedules, Model):
    return origin_forecasts(rows, schedules, season=SEASON, origin=ORIGIN, last_week=LAST,
                            league=load_league("gabagool"), predictor_factory=lambda f: Model())


def test_origin_forecasts_contract(monkeypatch):
    rows, schedules, Model, seen = _fixture(monkeypatch)
    previous = RULESETS["league"]
    try:
        out = _run(rows, schedules, Model)
        assert RULESETS["league"] is previous
        league = load_league("gabagool")
        # (a) every remaining week, origin through last_week.
        assert out["weeks"] == list(range(ORIGIN, LAST + 1))
        assert out["schema_version"] == 1 and out["season"] == SEASON and out["origin"] == ORIGIN
        assert out["model"] == "test" and out["training_through"] == SEASON - 1
        assert out["scoring"] == league.rules.name
        players = out["players"]
        # (d) cohort is frozen at origin: last seen pre-origin, season >= S-1.
        cohort = {"a": "A", "b": "B", "d": "A"}
        assert set(players) == set(cohort)
        assert all(call[2] == cohort for call in seen)
        assert {p: v["team"] for p, v in players.items()} == cohort
        assert players["b"]["position"] == "WR"
        # (b) team with no game that week is a bye, not a zero.
        assert players["b"]["weeks"]["9"] == {"status": "bye"}
        assert players["a"]["weeks"]["9"]["status"] == "play"
        # Scheduled but unprojected: omitted (coverage gap), never zero.
        assert "10" not in players["d"]["weeks"] and "9" in players["d"]["weeks"]
        # (c) finite, ordered quantiles on every play row.
        for v in players.values():
            for row in v["weeks"].values():
                if row["status"] == "play":
                    q = [row["p10"], row["p50"], row["p90"]]
                    assert all(math.isfinite(x) for x in q) and q[0] <= q[1] <= q[2]
        assert players["b"]["weeks"]["10"] == {"status": "play", "p10": 17., "p50": 21., "p90": 27.}
        # (e) baseline is the naive four-game mean from pre-origin history.
        history = rows[(rows.season < SEASON) | ((rows.season == SEASON) & (rows.week < ORIGIN))]
        expected = R.recent_game_baseline(history, replace(league.rules, pass_int_td=0))
        for pid, v in players.items():
            assert v["baseline"] == pytest.approx(float(expected[pid]))
        assert players["a"]["baseline"] == pytest.approx(league.rules.reception * (1 + 3 + 5) / 3)
        # (f) target-week actuals are never read.
        truncated = rows[(rows.season < SEASON) | (rows.week < ORIGIN)]
        assert _run(truncated, schedules, Model) == out
    finally:
        R.set_league_rules(previous)


def test_origin_forecasts_rejects_escape_and_bad_bands(monkeypatch):
    rows, schedules, Model, _ = _fixture(monkeypatch)
    previous = RULESETS["league"]
    good = R.build_weekly_projections
    try:
        def escaped(future, model, season, week, source, **kwargs):
            out = good(future, model, season, week, source, **kwargs)
            out["players"].append(dict(player_id="c", position="QB", team="C",
                                       points={"league": {"p10": 1., "p50": 2., "p90": 3.}}))
            return out
        monkeypatch.setattr(R, "build_weekly_projections", escaped)
        with pytest.raises(ValueError, match="escaped frozen origin"):
            _run(rows, schedules, Model)
        assert RULESETS["league"] is previous

        def unbanded(future, model, season, week, source, **kwargs):
            out = good(future, model, season, week, source, **kwargs)
            out["players"][0]["points"]["league"]["p10"] = None
            return out
        monkeypatch.setattr(R, "build_weekly_projections", unbanded)
        with pytest.raises(ValueError, match="quantile"):
            _run(rows, schedules, Model)
        assert RULESETS["league"] is previous
    finally:
        R.set_league_rules(previous)


def test_origin_forecasts_validates_weeks_before_loading():
    for origin, last in [(0, 5), (9, 8), (5, 19)]:
        with pytest.raises(ValueError):
            origin_forecasts(None, None, season=2025, origin=origin, last_week=last,
                             league=None, predictor_factory=None)
