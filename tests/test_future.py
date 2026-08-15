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


def test_player_with_later_season_games_is_excluded():
    later = make_weekly([{"player_id": "future_guy", "season": 2024, "week": 1}])
    weekly = pd.concat([_history(), later], ignore_index=True)
    sk = future_skeleton(weekly, _sched_with_future(), season=2023, week=7)
    assert "future_guy" not in set(sk["player_id"])


def test_refuses_already_played_week():
    weekly = _history()          # weeks 1-6 played
    with pytest.raises(RuntimeError, match="played"):
        future_skeleton(weekly, _sched_with_future(), season=2023, week=6)


def test_future_week_inherits_team_pass_volume_and_roof():
    """The unplayed target week gets team_pass_att_last4 from prior weeks
    (shift-then-roll frontier, like opp_allowed) and is_indoor from the
    schedule; its own v2 source columns are NaN like every stat."""
    rows = []
    for week in range(1, 7):
        rows.append({"player_id": "p1", "week": week, "attempts": 30.0 + week})
        rows.append({"player_id": "p2", "week": week, "position": "RB",
                     "team": "BBB", "opponent_team": "AAA"})
    weekly = make_weekly(rows)
    sched = make_schedules(8, roof="dome")
    future = build_future_features(weekly, sched, season=2023, week=7)
    p1 = future[future["player_id"] == "p1"].iloc[0]
    # AAA attempts weeks 3-6: mean(33, 34, 35, 36) = 34.5; week 7 is unplayed
    assert p1["team_pass_att_last4"] == pytest.approx(34.5)
    assert p1["is_indoor"] == 1
    assert np.isnan(p1["attempts"])
    assert np.isnan(p1["receiving_air_yards"])


# --- current-team override -------------------------------------------------
# `team` on a skeleton row comes from the player's most recent PLAYED row. In
# the preseason that is last December, so without an override every offseason
# move is stale -- 16.2% of the 2026 board. And team is not cosmetic: it picks
# the opponent in the schedule merge, so it moves opp_allowed_last4, is_home,
# is_indoor and team_pass_att_last4.

def test_current_team_override_moves_the_player_and_his_opponent():
    weekly = _history()                      # p1 last played for AAA
    sk = future_skeleton(weekly, _sched_with_future(), season=2023, week=7,
                         current_teams={"p1": "BBB"})
    p1 = sk[sk["player_id"] == "p1"].iloc[0]
    assert p1["team"] == "BBB"
    # the mirror image of the stale matchup, not merely a relabelled row
    assert p1["opponent_team"] == "AAA"
    # everyone else is untouched
    assert sk[sk["player_id"] == "p2"].iloc[0]["team"] == "BBB"


def test_unmapped_players_keep_their_last_known_team():
    weekly = _history()
    sk = future_skeleton(weekly, _sched_with_future(), season=2023, week=7,
                         current_teams={"p2": "AAA"})
    assert sk[sk["player_id"] == "p1"].iloc[0]["team"] == "AAA"   # untouched
    assert sk[sk["player_id"] == "p2"].iloc[0]["team"] == "AAA"   # overridden
    assert len(sk) == 2                       # nobody dropped by the map


def test_no_override_argument_reproduces_the_stale_behaviour():
    weekly = _history()
    args = (weekly, _sched_with_future())
    a = future_skeleton(*args, season=2023, week=7)
    b = future_skeleton(*args, season=2023, week=7, current_teams={})
    c = future_skeleton(*args, season=2023, week=7, current_teams=None)
    pd.testing.assert_frame_equal(a, b)
    pd.testing.assert_frame_equal(a, c)


def test_override_to_a_bye_team_drops_the_player_like_any_other_bye():
    weekly = _history()
    sched = _sched_with_future()
    sched = sched[~((sched["week"] == 7) & (sched["home_team"] == "AAA"))]
    sk = future_skeleton(weekly, sched, season=2023, week=7,
                         current_teams={"p1": "CCC"})
    assert "p1" not in set(sk["player_id"])


def test_override_reaches_the_built_features_not_just_the_skeleton():
    weekly = _history()
    stale = build_future_features(weekly, _sched_with_future(),
                                  season=2023, week=7)
    moved = build_future_features(weekly, _sched_with_future(), season=2023,
                                  week=7, current_teams={"p1": "BBB"})
    s = stale[stale["player_id"] == "p1"].iloc[0]
    m = moved[moved["player_id"] == "p1"].iloc[0]
    assert (s["team"], s["opponent_team"]) == ("AAA", "BBB")
    assert (m["team"], m["opponent_team"]) == ("BBB", "AAA")
    # is_home is a live CTX feature and must flip with the move
    assert s["is_home"] != m["is_home"]
