import pandas as pd
import pytest
from ffmodel.eval import availability as av

def _sched(rows):  # (season, week, home, away)
    return pd.DataFrame([{"season": s, "week": w, "home_team": h, "away_team": a,
                          "home_score": 20, "away_score": 17} for s, w, h, a in rows])

def _weekly(rows):  # (season, week, player_id, team, position)
    return pd.DataFrame([{"season": s, "week": w, "player_id": p, "team": t, "position": pos}
                         for s, w, p, t, pos in rows])

def _rosters(rows):  # (season, week, gsis_id, team, position, status)
    return pd.DataFrame([{"season": s, "week": w, "gsis_id": p, "team": t, "position": pos,
                          "status": st, "game_type": "REG"} for s, w, p, t, pos, st in rows])

SCHED = _sched([(2020, w, "AAA", "BBB") for w in range(1, 6)])

def test_played_missed_and_not_established():
    weekly = _weekly([(2020, 1, "p1", "AAA", "RB"), (2020, 2, "p1", "AAA", "RB"),
                      (2020, 4, "p1", "AAA", "RB"), (2020, 3, "p2", "AAA", "WR")])
    rosters = _rosters([(2020, w, "p1", "AAA", "RB", "ACT") for w in range(1, 6)] +
                       [(2020, w, "p2", "AAA", "WR", "ACT") for w in range(1, 6)] +
                       [(2020, w, "p3", "AAA", "TE", "ACT") for w in range(1, 6)])
    part = av.participation(weekly, SCHED, rosters)
    p1 = part[part.player_id == "p1"].set_index("week").played.to_dict()
    assert p1 == {2: True, 3: False, 4: True, 5: False}   # week 1: nothing earlier -> not established
    assert set(part[part.player_id == "p2"].week) == {4, 5}  # established only after week 3
    assert "p3" not in set(part.player_id)                  # never recorded a stat row

def test_cut_player_is_not_counted_missing():
    weekly = _weekly([(2020, 1, "p1", "AAA", "RB")])
    rosters = _rosters([(2020, 1, "p1", "AAA", "RB", "ACT"), (2020, 2, "p1", "AAA", "RB", "CUT")])
    part = av.participation(weekly, SCHED, rosters)
    assert part.empty

def test_ir_player_stays_established_across_long_absence():
    weekly = _weekly([(2020, 1, "p1", "AAA", "RB")])
    rosters = _rosters([(2020, 1, "p1", "AAA", "RB", "ACT")] +
                       [(2020, w, "p1", "AAA", "RB", "RES") for w in range(2, 6)])
    part = av.participation(weekly, SCHED, rosters)
    assert part.set_index("week").played.to_dict() == {2: False, 3: False, 4: False, 5: False}

def test_transition_rates_counts():
    part = pd.DataFrame([
        {"season": 2020, "week": w, "team": "AAA", "player_id": "p1", "position": "RB", "played": pl, "status": "ACT"}
        for w, pl in [(2, True), (3, False), (4, False), (5, True)]])
    r = av.transition_rates(part, [2020])
    # pairs: T->F, F->F, F->T  => from_played 1 (1 out), from_out 2 (1 stay)
    assert r["counts"]["RB"] == {"from_played": 1, "from_out": 2}
    assert r["p_out"]["RB"] == pytest.approx(1.0)
    assert r["p_stay"]["RB"] == pytest.approx(0.5)

def test_walk_forward_excludes_test_season():
    part = pd.DataFrame([
        {"season": s, "week": w, "team": "AAA", "player_id": "p1", "position": "QB", "played": pl, "status": "ACT"}
        for s in (2021, 2022) for w, pl in [(2, True), (3, s == 2021)]])
    r = av.transition_rates(part, [2021])
    assert r["counts"]["QB"]["from_played"] == 1 and r["p_out"]["QB"] == 0.0

def test_tag_rate_uses_next_team_game():
    part = pd.DataFrame([
        {"season": 2020, "week": w, "team": "AAA", "player_id": "p1", "position": "WR", "played": pl, "status": "ACT"}
        for w, pl in [(2, False), (3, False), (4, True)]])
    injuries = pd.DataFrame([{"season": 2020, "week": 2, "gsis_id": "p1", "report_status": "Out", "game_type": "REG"},
                             {"season": 2020, "week": 3, "gsis_id": "p1", "report_status": "Questionable", "game_type": "REG"}])
    r = av.tag_rates(part, injuries, [2020], min_count=1)
    assert r["counts"]["Out"] == 1 and r["p_tag"]["Out"] == 1.0          # tagged wk2 -> missed wk3
    assert r["counts"]["Questionable"] == 1 and r["p_tag"]["Questionable"] == 0.0  # tagged wk3 -> played wk4
