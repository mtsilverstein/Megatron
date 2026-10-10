"""Spec §3.7 two-stage validation, masking and identity-collision handling. Synthetic data only."""
import numpy as np
import pandas as pd
import pytest

from ffmodel.data.features import build_features
from ffmodel.eval import sameweek as sw
from ffmodel.scoring import PREDICTED_STATS


def _cons(rows):
    return pd.DataFrame(rows, columns=["fp_id", "player", "pos", "team", "ecr", "sd", "mergename", "scrape_date"])


def _weekly(rows):
    """Canonical weekly rows as pull_weekly returns them; unspecified stats are zero."""
    base = {"player_id": "p1", "player_display_name": "P One", "position": "RB", "team": "AAA",
            "opponent_team": "BBB", "season": 2023, "week": 1, "target_share": np.nan, "snap_pct": np.nan,
            "fantasy_points_ppr": 0.0, "two_point_conversions": 0, "special_teams_tds": 0, "attempts": 0.0,
            "receiving_air_yards": 0.0, "passing_air_yards": 0.0, **{s: 0.0 for s in PREDICTED_STATS}}
    return pd.DataFrame([{**base, **r} for r in rows])


def _games(weeks=4, season=2023):
    days = pd.date_range(f"{season}-09-10", periods=weeks, freq="7D")
    return pd.DataFrame({"season": season, "week": range(1, weeks + 1), "gameday": days.strftime("%Y-%m-%d"),
                         "home_team": "AAA", "away_team": "BBB"})


def test_exact_duplicates_collapse_and_conflicts_invalidate_group():
    d = pd.Timestamp("2022-12-30")
    snap = _cons([
        ("1", "A", "RB", "AAA", 1.0, 1.0, "a", d), ("1", "A", "RB", "AAA", 1.0, 1.0, "a", d),       # exact dup
        ("2", "Felton", "RB", "BBB", 113.2, 1.0, "felton", d), ("2", "Felton", "WR", "BBB", 163.6, 1.0, "felton", d),
        ("3", "C", "WR", "CCC", 5.0, 1.0, "c", d),
    ])
    v = sw.validate_consensus(snap)
    assert v.exact_duplicates == 1
    assert v.invalid["conflicting_duplicates"] == {("2",)}
    assert sorted(v.valid["fp_id"]) == ["1", "3"]
    assert v.n_keys == 3 and v.excluded_fraction() == pytest.approx(1 / 3)
    assert v.report()["invalid_by_reason_position"] == {"conflicting_duplicates": {"RB": 1}}


def test_threshold_exactly_one_percent_passes_just_above_fails():
    d = pd.Timestamp("2024-09-20")
    rows = [(str(i), f"p{i}", "WR", "AAA", float(i), 1.0, f"p{i}", d) for i in range(100)]
    rows[0] = ("0", "p0", "WR", "AAA", float("nan"), 1.0, "p0", d)                      # 1 of 100 invalid
    v = sw.validate_consensus(_cons(rows))
    assert v.excluded_fraction() == 0.01 and not v.fails()
    rows[1] = ("1", "p1", "WR", "AAA", float("inf"), 1.0, "p1", d)
    assert sw.validate_consensus(_cons(rows)).fails()
    assert sw.validate_consensus(_cons([])).excluded_fraction() == 0.0                # empty table: fraction 0


def test_key_failing_several_rules_counted_once():
    d = pd.Timestamp("2024-09-20")
    snap = _cons([("1", "A", "RB", "AAA", np.nan, 1.0, "a", d), ("1", "A", "RB", "AAA", 2.0, 1.0, "a", d),
                  ("2", "B", "RB", "AAA", 3.0, 1.0, "b", d)])
    v = sw.validate_consensus(snap)
    assert v.invalid_keys() == {("1",)} and v.excluded_fraction() == pytest.approx(0.5)


def test_nonfinite_only_in_evaluated_fields():
    d = pd.Timestamp("2024-09-20")
    snap = _cons([("1", "A", "RB", "AAA", 1.0, np.nan, "a", d)])                       # sd is not evaluated
    assert sw.validate_consensus(snap).invalid == {}


def test_projection_quantile_order():
    df = pd.DataFrame({"player_id": ["a", "b"], "team": ["AAA", "AAA"], "position": ["WR", "WR"],
                       "p10": [1.0, 5.0], "p50": [2.0, 4.0], "p90": [3.0, 6.0]})
    assert sw.validate_projections(df).invalid["quantile_order"] == {("b",)}


def test_stage1_exact_duplicate_collapses_before_features():
    # astra P3: carries 10, 20, 20(duplicate of week 2), 30 -> week-3 lag4_carries must be 15.0, not 16.67
    rows = [{"week": 1, "carries": 10.0}, {"week": 2, "carries": 20.0}, {"week": 2, "carries": 20.0},
            {"week": 3, "carries": 30.0}]
    weekly = _weekly(rows)
    assert build_features(weekly, _games())[lambda f: f["week"] == 3]["lag4_carries"].iloc[0] == pytest.approx(50 / 3)
    prep = sw.prepare(weekly, _games())
    wk3 = prep.features[prep.features["week"] == 3]
    assert len(wk3) == 1 and wk3["lag4_carries"].iloc[0] == pytest.approx(15.0)
    v2 = sw.week_actuals(prep, 2023, 2)
    assert v2.exact_duplicates == 1 and v2.invalid == {} and len(v2.valid) == 1


def test_stage1_mixed_exact_and_conflicting_group_keeps_whole_multiset():
    # astra S7-I2: week 2 carries 20, 20, 25 is ONE conflicting key; conflicts are found first, so its repeated 20
    # is not collapsed. Week-3 lag4_carries over 10, 20, 20, 25 = 18.75 (collapsing first would give 18.33).
    rows = [{"week": 1, "carries": 10.0}, {"week": 2, "carries": 20.0}, {"week": 2, "carries": 20.0},
            {"week": 2, "carries": 25.0}, {"week": 3, "carries": 30.0}]
    weekly = _weekly(rows)
    assert build_features(weekly, _games())[lambda f: f["week"] == 3]["lag4_carries"].iloc[0] == pytest.approx(18.75)
    prep = sw.prepare(weekly, _games())
    assert len(prep.features[prep.features["week"] == 2]) == 3                         # whole multiset kept
    assert prep.features[prep.features["week"] == 3]["lag4_carries"].iloc[0] == pytest.approx(18.75)
    assert prep.exact_by_week == {} and prep.actuals.exact_duplicates == 0             # nothing was collapsed
    v2 = sw.week_actuals(prep, 2023, 2)
    assert v2.invalid == {"conflicting_duplicates": {(2023, 2, "p1")}} and v2.exact_duplicates == 0
    v3 = sw.week_actuals(prep, 2023, 3)
    assert v3.invalid == {} and len(v3.valid) == 1                                     # week 3 is scorable


def test_stage1_conflicting_actuals_stay_in_features_and_are_masked():
    rows = [{"week": 1, "carries": 10.0}, {"week": 2, "carries": 20.0}, {"week": 2, "carries": 25.0},
            {"week": 3, "carries": 30.0}]
    prep = sw.prepare(_weekly(rows), _games())
    assert len(prep.features[prep.features["week"] == 2]) == 2                         # both rows kept as inputs
    wk3 = prep.features[prep.features["week"] == 3]
    assert wk3["lag4_carries"].iloc[0] == pytest.approx(55 / 3)                       # model inputs unchanged
    assert prep.actuals.invalid["conflicting_duplicates"] == {(2023, 2, "p1")}
    v2 = sw.week_actuals(prep, 2023, 2)
    assert v2.invalid_keys() == {(2023, 2, "p1")} and v2.valid.empty and v2.fails()
    assert not sw.week_actuals(prep, 2023, 3).invalid                                  # mask is per week only


def test_stage1_nonfinite_actual_masked_but_kept():
    rows = [{"week": 1, "carries": 10.0}, {"week": 2, "carries": np.nan}, {"week": 3, "carries": 30.0}]
    prep = sw.prepare(_weekly(rows), _games())
    assert len(prep.features) == 3
    assert sw.week_actuals(prep, 2023, 2).invalid == {"nonfinite": {(2023, 2, "p1")}}


def test_exact_duplicate_schedule_game_collapses_without_error():
    games = pd.concat([_games(), _games().iloc[[1]]], ignore_index=True)              # week 2 listed twice
    rows = [{"week": w, "carries": 5.0} for w in (1, 2, 3)]
    prep = sw.prepare(_weekly(rows), games)
    assert prep.schedule.duplicate_games == 1 and len(prep.features) == 3             # no row doubled
    assert prep.schedule.duplicates_by_week == {(2023, 2): 1}
    assert prep.schedule.game_date(2023, 2)["AAA"] == pd.Timestamp("2023-09-17")
    wi = sw.week_inputs(prep, 2023, 2)
    assert not wi["failed"] and wi["actuals"].invalid == {}
    assert wi["report"]["schedule"]["exact_duplicates"] == 1                           # the count reaches the report
    assert sw.week_inputs(prep, 2023, 1)["report"]["schedule"]["exact_duplicates"] == 0


def test_conflicting_schedule_side_keeps_its_repeated_rows_uncounted():
    g = _games()
    games = pd.concat([g, g.iloc[[1]], g.iloc[[1]].assign(gameday="2023-09-18")], ignore_index=True)
    sc = sw.validate_schedule(games)                                                  # conflicts found first
    assert len(sc.games) == 6 and sc.duplicate_games == 0 and sc.duplicates_by_week == {}
    assert sc.week_validation(2023, 2).invalid_keys() == {(2023, 2, "AAA"), (2023, 2, "BBB")}


def test_conflicting_schedule_side_invalidates_side_and_masks_players():
    games = pd.concat([_games(), _games().iloc[[1]].assign(gameday="2023-09-18")], ignore_index=True)
    rows = [{"week": w, "carries": 5.0} for w in (1, 2, 3)]
    prep = sw.prepare(_weekly(rows), games)
    assert "AAA" not in prep.schedule.game_date(2023, 2)
    wi = sw.week_inputs(prep, 2023, 2)
    assert wi["schedule"].invalid["conflicting_duplicates"] == {(2023, 2, "AAA"), (2023, 2, "BBB")}
    assert wi["actuals"].invalid["schedule_join"] == {(2023, 2, "p1")} and wi["failed"]
    assert 2 not in sw.week_dates(prep.schedule.valid_games, 2023)
    assert sorted(prep.schedule.dates(2023)) == [1, 3, 4]                              # K_2/Z_2 undefined


def test_match_consensus_flags_identity_collision():
    d = pd.Timestamp("2024-09-20")
    snap = _cons([("10", "Same Guy", "RB", "AAA", 5.0, 1.0, "same guy", d),
                  ("11", "Same Guy", "RB", "AAA", 5.0, 1.0, "same guy", d)])          # two keys, one player
    cw = pd.DataFrame({"gsis_id": ["00-1", "00-1"], "fantasypros_id": ["10", "11"],
                       "merge_name": ["same guy", "same guy"], "position": ["RB", "RB"]})
    m = sw.match_consensus(snap, cw)
    assert m.matched is None and m.reason == "identity_collision" and m.stats["gsis_collisions"] == 1


def test_match_consensus_ok():
    d = pd.Timestamp("2024-09-20")
    snap = _cons([("10", "A", "RB", "AAA", 1.0, 1.0, "a", d), ("11", "B", "RB", "AAA", 2.0, 1.0, "b", d)])
    cw = pd.DataFrame({"gsis_id": ["00-1", "00-2"], "fantasypros_id": ["10", "11"],
                       "merge_name": ["a", "b"], "position": ["RB", "RB"]})
    m = sw.match_consensus(snap, cw)
    assert m.reason is None and sorted(m.matched["player_id"]) == ["00-1", "00-2"]


def test_stage1_rows_differing_only_in_other_column_conflict():
    rows = [{"week": 1, "carries": 10.0}, {"week": 2, "carries": 20.0, "target_share": 0.15},
            {"week": 2, "carries": 20.0, "target_share": 0.25}, {"week": 3, "carries": 30.0}]
    prep = sw.prepare(_weekly(rows), _games())
    assert len(prep.features[prep.features["week"] == 2]) == 2                         # both rows reach build_features
    assert prep.exact_by_week == {} and prep.actuals.exact_duplicates == 0
    assert prep.actuals.invalid["conflicting_duplicates"] == {(2023, 2, "p1")}
    assert sw.week_actuals(prep, 2023, 2).invalid_keys() == {(2023, 2, "p1")}


def test_game_rows_differing_only_in_roof_conflict():
    g = _games().assign(roof="dome")
    games = pd.concat([g, g.iloc[[1]].assign(roof="outdoors")], ignore_index=True)
    sc = sw.validate_schedule(games)
    assert len(sc.games) == 5 and sc.duplicate_games == 0
    v = sc.week_validation(2023, 2)
    assert v.invalid_keys() == {(2023, 2, "AAA"), (2023, 2, "BBB")} and v.fails()


def test_home_away_swapped_listing_conflicts_and_is_not_collapsed():
    g = _games()
    swapped = g.iloc[[1]].rename(columns={"home_team": "away_team", "away_team": "home_team"})
    games = pd.concat([g, swapped], ignore_index=True)
    rows = [{"week": w, "carries": 5.0} for w in (1, 2, 3)]
    prep = sw.prepare(_weekly(rows), games)
    assert prep.schedule.duplicate_games == 0 and len(prep.schedule.games) == 5   # nothing collapsed
    wi = sw.week_inputs(prep, 2023, 2)
    assert wi["schedule"].invalid_keys() == {(2023, 2, "AAA"), (2023, 2, "BBB")}
    assert wi["schedule"].exact_duplicates == 0 and wi["failed"]
