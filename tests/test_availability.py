import pandas as pd
import pytest
from ffmodel.eval import availability as av

def _sched(rows):  # (season, week, home, away)
    return pd.DataFrame([{"season": s, "week": w, "home_team": h, "away_team": a,
                          "home_score": 20, "away_score": 17} for s, w, h, a in rows])

def _weekly(rows):  # (season, week, player_id, team, position[, fantasy_points_ppr])
    out = []
    for row in rows:
        if len(row) == 6:
            s, w, p, t, pos, pts = row
        else:
            s, w, p, t, pos = row
            pts = 0.0
        out.append({"season": s, "week": w, "player_id": p, "team": t, "position": pos,
                    "fantasy_points_ppr": pts})
    return pd.DataFrame(out)

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
        {"season": 2020, "week": w, "team": "AAA", "player_id": "p1", "position": "RB", "played": pl,
         "status": "ACT", "relevant": True}
        for w, pl in [(2, True), (3, False), (4, False), (5, True)]])
    r = av.transition_rates(part, [2020])
    # pairs: T->F, F->F, F->T  => from_played 1 (1 out), from_out 2 (1 stay)
    assert r["counts"]["RB"] == {"from_played": 1, "from_out": 2}
    assert r["p_out"]["RB"] == pytest.approx(1.0)
    assert r["p_stay"]["RB"] == pytest.approx(0.5)

def test_walk_forward_excludes_test_season():
    part = pd.DataFrame([
        {"season": s, "week": w, "team": "AAA", "player_id": "p1", "position": "QB", "played": pl,
         "status": "ACT", "relevant": True}
        for s in (2021, 2022) for w, pl in [(2, True), (3, s == 2021)]])
    r = av.transition_rates(part, [2021])
    assert r["counts"]["QB"]["from_played"] == 1 and r["p_out"]["QB"] == 0.0

def test_relevance_filter_excludes_bench_backup(monkeypatch):
    monkeypatch.setattr(av, "RELEVANT_N", {**av.RELEVANT_N, "QB": 1})
    weekly = _weekly([(2020, w, "starter", "AAA", "QB", 20.0) for w in range(1, 6)] +
                     [(2020, 1, "backup", "AAA", "QB", 1.0)])
    rosters = _rosters([(2020, w, "starter", "AAA", "QB", "ACT") for w in range(1, 6)] +
                       [(2020, w, "backup", "AAA", "QB", "ACT") for w in range(1, 6)])
    part = av.participation(weekly, SCHED, rosters)
    # backup recorded one stat row (week 1) then never played again, but his
    # trailing role score never exceeds the starter's, so with QB N=1 he never
    # cracks the RELEVANT population -- even though (fix round 2) he still shows
    # up in the raw established frame, just flagged relevant=False.
    assert "backup" in set(part.player_id)
    assert not part[part.player_id == "backup"]["relevant"].any()
    assert "backup" not in set(part[part.relevant].player_id)


def test_relevance_filter_uses_only_games_before_the_week(monkeypatch):
    monkeypatch.setattr(av, "RELEVANT_N", {**av.RELEVANT_N, "QB": 1})
    weekly = _weekly([(2020, w, "steady", "AAA", "QB", 10.0) for w in range(1, 6)] +
                     [(2020, w, "riser", "AAA", "QB", 1.0) for w in range(1, 5)] +
                     [(2020, 5, "riser", "AAA", "QB", 50.0)])
    rosters = _rosters([(2020, w, "steady", "AAA", "QB", "ACT") for w in range(1, 6)] +
                       [(2020, w, "riser", "AAA", "QB", "ACT") for w in range(1, 6)])
    part = av.participation(weekly, SCHED, rosters)
    # riser's week-5 explosion must not count toward his own week-5 relevance
    # rank -- only games strictly before week 5 (all 1.0s) are visible then --
    # so with QB N=1 he stays excluded from the RELEVANT population at week 5
    # despite outscoring steady that week. He still appears in the raw frame
    # (fix round 2: relevance no longer removes rows).
    relevant = part[part.relevant]
    assert relevant[(relevant.week == 5) & (relevant.player_id == "riser")].empty
    assert not relevant[(relevant.week == 5) & (relevant.player_id == "steady")].empty
    assert not part[(part.week == 5) & (part.player_id == "riser")].empty


def test_pairs_use_literal_next_team_game_not_next_relevant_row(monkeypatch):
    # Fix round 2 (a): p is relevant at week 3, then knocked out of the top-N at
    # week 4 by "blocker" (established only that one week, huge trailing score),
    # then relevant again at week 5 (blocker gone, p is the sole established QB).
    # The pair recorded FROM week 3 must be week 3 -> week 4 (p's literal next
    # team game, played=True that week), never skipping ahead to week 5 the way
    # the old relevant-rows-only pairing would have.
    monkeypatch.setattr(av, "RELEVANT_N", {**av.RELEVANT_N, "QB": 1})
    weekly = _weekly([(2020, 1, "p", "AAA", "QB", 5.0), (2020, 2, "p", "AAA", "QB", 5.0),
                      (2020, 3, "p", "AAA", "QB", 5.0), (2020, 4, "p", "AAA", "QB", 1.0),
                      (2020, 1, "blocker", "AAA", "QB", 1000.0)])
    rosters = _rosters([(2020, w, "p", "AAA", "QB", "ACT") for w in range(1, 6)] +
                       [(2020, 4, "blocker", "AAA", "QB", "ACT")])
    part = av.participation(weekly, SCHED, rosters)
    p_rows = part[part.player_id == "p"].set_index("week")
    assert p_rows.loc[4, "relevant"] == False   # blocker outranks p at week 4 only
    assert p_rows.loc[3, "relevant"] == True
    pairs = av._pairs(part)
    p_pairs = pairs[pairs.player_id == "p"].set_index("week")
    assert 3 in p_pairs.index and p_pairs.loc[3, "next_played"] == True   # 3 -> 4 (played)
    assert 4 not in p_pairs.index                                        # week 4 not relevant: no pair FROM it


def test_pair_excluded_when_from_week_not_relevant_even_if_to_week_is(monkeypatch):
    # Fix round 2 (b): "solo" is knocked out of the top-N at week 2 by "big"
    # (established only that week, huge trailing score), then trivially relevant
    # again at week 3 (sole established QB). The week2 -> week3 pair must be
    # excluded because its FROM row (week 2) is not relevant, even though its
    # TO row (week 3) is.
    monkeypatch.setattr(av, "RELEVANT_N", {**av.RELEVANT_N, "QB": 1})
    weekly = _weekly([(2020, 1, "solo", "AAA", "QB", 2.0), (2020, 2, "solo", "AAA", "QB", 2.0),
                      (2020, 3, "solo", "AAA", "QB", 2.0), (2020, 1, "big", "AAA", "QB", 500.0)])
    rosters = _rosters([(2020, w, "solo", "AAA", "QB", "ACT") for w in range(1, 4)] +
                       [(2020, 2, "big", "AAA", "QB", "ACT")])
    part = av.participation(weekly, SCHED, rosters)
    solo_rows = part[part.player_id == "solo"].set_index("week")
    assert solo_rows.loc[2, "relevant"] == False
    assert solo_rows.loc[3, "relevant"] == True
    pairs = av._pairs(part)
    assert 2 not in pairs[pairs.player_id == "solo"].set_index("week").index


def test_ties_at_cutoff_all_kept_relevant(monkeypatch):
    monkeypatch.setattr(av, "RELEVANT_N", {**av.RELEVANT_N, "QB": 2})
    weekly = _weekly([(2020, 1, f"qb{i}", "AAA", "QB", 10.0) for i in range(4)] +
                     [(2020, 2, f"qb{i}", "AAA", "QB", 10.0) for i in range(4)])
    rosters = _rosters([(2020, w, f"qb{i}", "AAA", "QB", "ACT")
                        for i in range(4) for w in range(1, 3)])
    part = av.participation(weekly, SCHED, rosters)
    week2 = part[part.week == 2]
    # all 4 QBs are tied on trailing score (same week-1 score) -- with N=2, every
    # player tied at the cutoff must be kept, not an arbitrary 2 of the 4.
    assert set(week2.player_id) == {"qb0", "qb1", "qb2", "qb3"}
    assert week2["relevant"].all()


def test_tag_rate_uses_next_team_game():
    part = pd.DataFrame([
        {"season": 2020, "week": w, "team": "AAA", "player_id": "p1", "position": "WR", "played": pl,
         "status": "ACT", "relevant": True}
        for w, pl in [(2, False), (3, False), (4, True)]])
    injuries = pd.DataFrame([{"season": 2020, "week": 2, "gsis_id": "p1", "report_status": "Out", "game_type": "REG"},
                             {"season": 2020, "week": 3, "gsis_id": "p1", "report_status": "Questionable", "game_type": "REG"}])
    r = av.tag_rates(part, injuries, [2020], min_count=1)
    assert r["counts"]["Out"] == 1 and r["p_tag"]["Out"] == 1.0          # tagged wk2 -> missed wk3
    assert r["counts"]["Questionable"] == 1 and r["p_tag"]["Questionable"] == 0.0  # tagged wk3 -> played wk4


def test_tag_rate_excludes_pair_when_from_week_not_relevant():
    part = pd.DataFrame([
        {"season": 2020, "week": w, "team": "AAA", "player_id": "p1", "position": "WR", "played": pl,
         "status": "ACT", "relevant": rel}
        for w, pl, rel in [(2, False, False), (3, False, True), (4, True, True)]])
    injuries = pd.DataFrame([{"season": 2020, "week": 2, "gsis_id": "p1", "report_status": "Out", "game_type": "REG"}])
    r = av.tag_rates(part, injuries, [2020], min_count=1)
    # week 2 is tagged Out, but week 2 is not relevant -- the FROM row's
    # relevance gates the tag-rate population exactly like transition_rates.
    assert r["counts"]["Out"] == 0


def test_tag_rates_has_no_rosters_kwarg():
    import inspect
    assert "rosters" not in inspect.signature(av.tag_rates).parameters
