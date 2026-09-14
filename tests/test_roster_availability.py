import pandas as pd

from ffmodel.eval.roster_availability import (audit_roster_availability,
                                               classify_roster_rows)


def _rosters(rows):
    return pd.DataFrame(rows, columns=["season", "week", "game_type", "gsis_id",
                                      "team", "position", "status"])


def test_exact_duplicates_collapse_but_conflicting_player_week_is_ambiguous():
    rows = [
        (2024, 1, "REG", "p1", "NE", "WR", "ACT"),
        (2024, 1, "REG", "p1", "NE", "WR", "ACT"),
        (2024, 2, "REG", "p1", "NE", "WR", "ACT"),
        (2024, 2, "REG", "p1", "NYJ", "WR", "CUT"),
    ]
    got = classify_roster_rows(_rosters(rows))
    assert list(got["availability_status"]) == ["ACT", "AMBIGUOUS"]


def test_scope_filters_regular_season_position_season_and_week():
    rows = [
        (2023, 1, "REG", "old", "NE", "QB", "ACT"),
        (2024, 1, "REG", "keep", "NE", "RB", "ACT"),
        (2024, 2, "REG", "other-week", "NE", "WR", "ACT"),
        (2024, 1, "POST", "post", "NE", "TE", "ACT"),
        (2024, 1, "REG", "kicker", "NE", "K", "ACT"),
    ]
    got = classify_roster_rows(_rosters(rows), seasons=[2024], weeks=[1])
    assert got["gsis_id"].tolist() == ["keep"]


def test_missing_id_or_status_is_unknown_and_counted():
    frame = _rosters([
        (2024, 1, "REG", None, "NE", "WR", "ACT"),
        (2024, 1, "REG", "p2", "NE", "TE", None),
    ])
    report = audit_roster_availability(frame)
    assert report["seasons"] == [{
        "season": 2024, "records": 2, "statuses": {"UNKNOWN": 2},
        "ambiguous_player_weeks": 0, "missing_player_id": 1,
        "unknown_records": 2,
    }]


def test_missing_ids_are_preserved_when_another_player_week_conflicts():
    frame = _rosters([
        (2024, 1, "REG", None, "NE", "WR", "ACT"),
        (2024, 1, "REG", None, "NE", "WR", "ACT"),
        (2024, 1, "REG", "p1", "NE", "RB", "ACT"),
        (2024, 1, "REG", "p1", "NYJ", "RB", "CUT"),
    ])
    got = classify_roster_rows(frame)
    assert got["availability_status"].tolist().count("UNKNOWN") == 2
    ambiguous = got[got["availability_status"].eq("AMBIGUOUS")].iloc[0]
    assert pd.isna(ambiguous["team"])
    assert pd.isna(ambiguous["position"])
    assert pd.isna(ambiguous["status"])


def test_weekly_coverage_matches_rows_without_imputing_absent_stats():
    rosters = _rosters([(2024, 1, "REG", "p1", "NE", "QB", "ACT")])
    weekly = pd.DataFrame([
        (2024, 1, "REG", "p1", "QB", 10.0),
        (2024, 1, "REG", "p2", "RB", 0.0),
    ], columns=["season", "week", "season_type", "player_id", "position", "points"])
    coverage = audit_roster_availability(rosters, weekly)["weekly_stat_coverage"]
    assert coverage == {"stat_rows": 2, "uniquely_matched_roster_row": 1,
                        "ambiguous_roster_match": 0,
                        "unmatched_roster_row": 1, "unique_match_rate": .5,
                        "by_season": [{"season": 2024, "stat_rows": 2,
                                       "uniquely_matched_roster_row": 1,
                                       "ambiguous_roster_match": 0,
                                       "unmatched_roster_row": 1,
                                       "unique_match_rate": .5}]}


def test_weekly_coverage_separates_ambiguous_identity_matches():
    rosters = _rosters([
        (2024, 1, "REG", "p1", "NE", "QB", "ACT"),
        (2024, 1, "REG", "p1", "NYJ", "QB", "CUT"),
    ])
    weekly = pd.DataFrame([(2024, 1, "p1", "QB")],
                          columns=["season", "week", "player_id", "position"])
    coverage = audit_roster_availability(rosters, weekly)["weekly_stat_coverage"]
    assert coverage["uniquely_matched_roster_row"] == 0
    assert coverage["ambiguous_roster_match"] == 1
    assert coverage["unmatched_roster_row"] == 0
