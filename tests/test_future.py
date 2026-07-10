import numpy as np
import pandas as pd
import pytest

from ffmodel.data.features import feature_columns
from ffmodel.data.future import build_future_features, future_skeleton
from ffmodel.scoring import PREDICTED_STATS

from tests.test_features import make_schedules, make_weekly


def _history():
    rows = []
    for week in range(1, 7):
        rows.append({"player_id": "p1", "week": week, "receiving_yards": 50.0 + week})
        rows.append({"player_id": "p2", "week": week, "position": "RB",
                     "team": "BBB", "opponent_team": "AAA", "rushing_yards": 40.0})
    return make_weekly(rows)


def _sched_with_future():
    sched = make_schedules(8)          # weeks 1-8, AAA hosts BBB
    return sched


def test_skeleton_rows_only_for_scheduled_teams():
    weekly = _history()
    sk = future_skeleton(weekly, _sched_with_future(), season=2023, week=7)
    assert set(sk["player_id"]) == {"p1", "p2"}
    assert (sk["season"] == 2023).all() and (sk["week"] == 7).all()
    p1 = sk[sk["player_id"] == "p1"].iloc[0]
    assert p1["team"] == "AAA" and p1["opponent_team"] == "BBB"
    assert np.isnan(sk[PREDICTED_STATS].to_numpy()).all()


def test_skeleton_excludes_bye_teams():
    weekly = _history()
    sched = _sched_with_future()
    sched = sched[sched["week"] != 7]  # nobody plays week 7
    sk = future_skeleton(weekly, sched, season=2023, week=7)
    assert len(sk) == 0


def test_future_features_lags_from_history_only():
    weekly = _history()
    future = build_future_features(weekly, _sched_with_future(), season=2023, week=7)
    p1 = future[future["player_id"] == "p1"].iloc[0]
    # lag4 over weeks 3-6: mean(53, 54, 55, 56) = 54.5
    assert p1["lag4_receiving_yards"] == pytest.approx(54.5)
    assert p1["games_prior"] == 6
    assert p1["is_home"] == 1
    # future rows only, labels are NaN
    assert (future["week"] == 7).all()
    assert np.isnan(future[PREDICTED_STATS].to_numpy()).all()


def test_future_rows_do_not_pollute_history_features():
    weekly = _history()
    future = build_future_features(weekly, _sched_with_future(), season=2023, week=7)
    assert set(feature_columns(future)) == set(feature_columns(
        build_future_features(weekly, _sched_with_future(), season=2023, week=8)))
    # opponent-allowed for the future week must come from real prior weeks
    p1 = future[future["player_id"] == "p1"].iloc[0]
    assert np.isfinite(p1["opp_allowed_last4"])


def test_player_last_seen_two_seasons_ago_is_excluded():
    old = make_weekly([{"player_id": "old", "season": 2021, "week": 1}])
    recent = _history()
    weekly = pd.concat([old, recent], ignore_index=True)
    sk = future_skeleton(weekly, _sched_with_future(), season=2023, week=7)
    assert "old" not in set(sk["player_id"])


def test_combined_contains_future_rows_by_index():
    weekly = _history()
    combined, future = __import__("ffmodel.data.future", fromlist=["x"]) \
        .combined_future_features(weekly, _sched_with_future(), 2023, 7)
    assert future.index.isin(combined.index).all()
    assert len(combined) == len(future) + 12  # 2 players x 6 real weeks
