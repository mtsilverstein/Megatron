"""Offline tests for the same-week primitives: team mapping, dates, bye gate (spec §3.1, §3.4, §3.5)."""
import pandas as pd
import pytest

from ffmodel.data.pull import normalize_schedule_teams
from ffmodel.eval import sameweek as sw


def _sched(rows):
    return pd.DataFrame(rows, columns=["season", "week", "gameday", "home_team", "away_team"])


def _season():
    # wk1: all play. wk2: EEE/FFF bye. wk3: CCC/DDD bye. wk4: none bye.
    return _sched([
        (2024, 1, "2024-09-05", "AAA", "BBB"), (2024, 1, "2024-09-08", "CCC", "DDD"), (2024, 1, "2024-09-09", "EEE", "FFF"),
        (2024, 2, "2024-09-12", "AAA", "BBB"), (2024, 2, "2024-09-15", "CCC", "DDD"),
        (2024, 3, "2024-09-19", "AAA", "BBB"), (2024, 3, "2024-09-22", "EEE", "FFF"),
        (2024, 4, "2024-09-26", "AAA", "CCC"), (2024, 4, "2024-09-29", "BBB", "DDD"), (2024, 4, "2024-09-30", "EEE", "FFF"),
    ])


def _snap(teams_by_pos):
    rows = []
    for pos, teams in teams_by_pos.items():
        for i, t in enumerate(teams):
            rows.append({"fp_id": f"{pos}{i}{t}", "player": f"p{pos}{i}{t}", "pos": pos, "team": t,
                         "ecr": float(i + 1), "sd": 1.0, "mergename": f"p{pos}{i}{t}",
                         "scrape_date": pd.Timestamp("2024-09-20")})
    return pd.DataFrame(rows)


def test_team_mapping_targets_are_schedule_codes():
    legacy = pd.DataFrame({"home_team": ["STL", "SD", "OAK"], "away_team": ["LA", "LAC", "LV"]})
    normalized = normalize_schedule_teams(legacy)
    assert set(normalized["home_team"]) == {"LA", "LAC", "LV"}          # the schedule side of the mapping
    schedule_codes = {
        "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
        "LA", "LAC", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS"}
    assert set(sw.TEAM_TO_SCHEDULE.values()) <= schedule_codes
    assert sw.map_team("LAR") == "LA" and sw.map_team("JAC") == "JAX"
    assert sw.map_team("FA") is None and sw.map_team("") is None and sw.map_team(None) is None
    assert sw.map_team("buf") == "BUF"


def test_unknown_code_counted_and_contributes_no_presence():
    s = _season()
    snap = _snap({p: ["AAA", "BBB", "EEE", "FFF"] for p in sw.POSITIONS})
    junk = snap.head(1).assign(team="ZZZ", fp_id="junk")
    g = sw.gate(pd.concat([snap, junk], ignore_index=True), s, 2024, 3)
    assert g.unknown_team_codes == 1


def test_week_dates_and_byes():
    s = _season()
    d = sw.week_dates(s, 2024)
    assert d[1] == (pd.Timestamp("2024-09-05"), pd.Timestamp("2024-09-09"))
    assert sw.bye_teams(s, 2024, 2) == {"EEE", "FFF"}
    assert sw.bye_teams(s, 2024, 0) == set()
    assert sw.week_teams(s, 2024, 2) == {"AAA", "BBB", "CCC", "DDD"}


@pytest.mark.parametrize("R,A,B,expected", [
    ({"AAA", "BBB", "EEE", "FFF"}, {"CCC", "DDD"}, {"EEE", "FFF"}, "bye_consistent"),   # current on both counts
    ({"AAA", "BBB", "CCC", "DDD"}, {"CCC", "DDD"}, {"EEE", "FFF"}, "contradicted"),     # stale on both counts
    ({"CCC", "DDD"}, {"CCC", "DDD"}, set(), "contradicted"),                            # stale a, B empty
    ({"AAA"}, set(), set(), "unverified"),                                              # no byes
    ({"CCC", "EEE"}, {"CCC", "DDD"}, set(), "unverified"),                              # exact half
    ({"CCC"}, {"CCC"}, set(), "contradicted"),                                          # single mis-teamed row, one bye team
    ({"AAA", "BBB", "EEE"}, set(), {"EEE", "FFF", "GGG", "HHH"}, "contradicted"),       # b = 1/4 < 0.5
])
def test_page_state(R, A, B, expected):
    assert sw.page_state(R, A, B) == expected


def test_one_of_four_previous_bye_teams_missing_still_consistent():
    assert sw.page_state({"EEE", "FFF", "GGG"}, set(), {"EEE", "FFF", "GGG", "HHH"}) == "bye_consistent"


def test_week_identity_gate_states():
    s = _season()
    fresh = {p: ["AAA", "BBB", "EEE", "FFF"] for p in sw.POSITIONS}            # week 3: CCC/DDD bye, EEE/FFF back
    assert sw.gate(_snap(fresh), s, 2024, 3).state == "bye_consistent"
    mixed = dict(fresh, RB=["AAA", "BBB", "CCC", "DDD"])                       # RB page stale, WR page fresh
    g = sw.gate(_snap(mixed), s, 2024, 3)
    assert g.state == "contradicted" and g.pages["RB"] == "contradicted" and g.pages["WR"] == "bye_consistent"
    absent = {p: t for p, t in fresh.items() if p != "TE"}
    assert sw.gate(_snap(absent), s, 2024, 3).state == "unverified"           # absent page with B != empty
    assert sw.gate(_snap({}), s, 2024, 3).state == "unverified"               # all absent


def test_gate_unknown_codes_downgrade_but_never_erase_contradiction():
    s = _season()
    fresh = {p: ["AAA", "BBB", "EEE", "FFF"] for p in sw.POSITIONS}
    snap = _snap(fresh)
    junk = snap.head(1).assign(team="ZZZ", fp_id="junk")                       # 1 of 17 rows unknown (> 2%)
    g = sw.gate(pd.concat([snap, junk], ignore_index=True), s, 2024, 3)
    assert g.unknown_team_codes == 1 and g.state == "unverified"
    stale = _snap({p: ["AAA", "BBB", "CCC", "DDD"] for p in sw.POSITIONS})
    g2 = sw.gate(pd.concat([stale, junk], ignore_index=True), s, 2024, 3)
    assert g2.state == "contradicted"


def test_gate_documents_non_proof_when_no_current_byes():
    # week 4 has no byes (A empty); a page listing the week-3 returners (EEE/FFF) still passes
    s = _season()
    other_week = _snap({p: ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"] for p in sw.POSITIONS})
    assert sw.gate(other_week, s, 2024, 4).state == "bye_consistent"
