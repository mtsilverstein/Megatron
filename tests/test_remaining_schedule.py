"""Remaining-season features must see the same all-seasons schedule as the weekly path."""
import pandas as pd

from ffmodel.data import future as future_mod
from ffmodel.scoring import PREDICTED_STATS
from ffmodel.site import remaining as R
from ffmodel.site.weekly import build_weekly_projections

from tests.test_features import make_weekly


def _schedules():
    rows = []
    for season in (2025, 2026):
        for week in range(1, 4):
            day = pd.Timestamp(f"{season}-09-10") + pd.Timedelta(days=7 * (week - 1))
            rows.append(dict(season=season, week=week, gameday=day.strftime("%Y-%m-%d"),
                             home_team="AAA", away_team="BBB"))
            rows += [dict(season=season, week=week, gameday=day.strftime("%Y-%m-%d"),
                          home_team=f"H{i}", away_team=f"V{i}") for i in range(9)]
    return pd.DataFrame(rows)


def _weekly():
    rows = [dict(player_id="p1", season=s, week=w, receiving_yards=50.0 + w)
            for s, w in [(2025, 1), (2025, 2), (2025, 3), (2026, 1)]]
    return make_weekly(rows)


class IsHomePredictor:
    """p50 of every stat is the mean is_home over the player's prior input rows."""
    name = "is-home-stub"

    def attach_features(self, combined):
        self.combined = combined

    def predict(self, future):
        out = {}
        for idx, row in future.iterrows():
            c = self.combined
            prior = c[(c.player_id == row.player_id) &
                      ((c.season < row.season) | ((c.season == row.season) & (c.week < row.week)))]
            prior = prior.sort_values(["season", "week"]).tail(16)
            out[idx] = 100.0 * prior.is_home.mean()
        return pd.DataFrame({s: pd.Series(out) for s in PREDICTED_STATS})


def _args():
    return dict(weekly=_weekly(), schedules=_schedules(), predictor=IsHomePredictor(),
                season=2026, start_week=2, end_week=2, current_teams={"p1": "AAA"},
                league={"league_id": "L", "sleeper_scoring": {"rec": 1}})


def test_feature_builder_receives_prior_season_schedule(monkeypatch):
    seen = []
    real = R.combined_future_features

    def spy(history, schedule, *rest, **kw):
        seen.append(schedule.copy())
        return real(history, schedule, *rest, **kw)

    monkeypatch.setattr(R, "combined_future_features", spy)
    R.build_remaining(**_args())
    assert seen and all((s.season == 2025).any() for s in seen)


def test_remaining_horizon_one_matches_current_week_path():
    args = _args()
    out = R.build_remaining(**args)
    got = out["players"][0]["weeks"][0]["points"]["league"]["p50"]

    history = args["weekly"]
    history = history[(history.season < 2026) | (history.week < 2)]
    combined, fut = future_mod.combined_future_features(
        history, args["schedules"], 2026, 2, args["current_teams"])
    predictor = IsHomePredictor()
    predictor.attach_features(combined)
    payload = build_weekly_projections(fut, predictor, 2026, 2, "2026-wk1")
    want = payload["players"][0]["points"]["league"]["p50"]
    assert want > 0
    assert abs(got - want) < 1e-9
