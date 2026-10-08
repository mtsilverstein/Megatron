"""Spec §5.2 same-week selection (metadata only), population filter, cells, audit and coverage."""
import numpy as np
import pandas as pd
import pytest

from ffmodel.eval import sameweek as sw
from ffmodel.eval.weekly_rankings import weekly_snapshot

POS = sw.POSITIONS


def _sched(extra=()):
    # 2024. wk1 Thu 09-05 .. Mon 09-09; wk2 Thu 09-12 .. Sun 09-15 (EEE/FFF bye); wk3 Sat 09-21 .. Sun 09-22 (CCC/DDD bye)
    rows = [(2024, 1, "2024-09-05", "AAA", "BBB"), (2024, 1, "2024-09-08", "CCC", "DDD"), (2024, 1, "2024-09-09", "EEE", "FFF"),
            (2024, 2, "2024-09-12", "AAA", "BBB"), (2024, 2, "2024-09-15", "CCC", "DDD"),
            (2024, 3, "2024-09-21", "AAA", "BBB"), (2024, 3, "2024-09-22", "EEE", "FFF"), *extra]
    return pd.DataFrame(rows, columns=["season", "week", "gameday", "home_team", "away_team"])


def _sc(extra=()):
    return sw.validate_schedule(_sched(extra))


def _rank_rows(date, teams, n_per_team=3):
    rows = []
    for pos in POS:
        for t in teams:
            for i in range(n_per_team):
                pid = f"{t}{pos}{i}"
                rows.append({"fp_id": pid, "player": pid, "pos": pos, "team": t, "ecr": float(i + 1), "sd": 1.0,
                             "mergename": pid.lower(), "scrape_date": pd.Timestamp(date)})
    return rows


def _rankings():
    wk1_list = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]
    wk2_list = ["AAA", "BBB", "CCC", "DDD"]                 # EEE/FFF on bye in week 2
    wk3_list = ["AAA", "BBB", "EEE", "FFF"]                 # CCC/DDD on bye in week 3
    rows = (_rank_rows("2024-09-06", wk1_list) + _rank_rows("2024-09-13", wk2_list)
            + _rank_rows("2024-09-20", wk3_list))
    return pd.DataFrame(rows)


def _crosswalk(rankings):
    first = rankings.drop_duplicates("fp_id")
    return pd.DataFrame({"gsis_id": "g-" + first["fp_id"], "fantasypros_id": first["fp_id"],
                         "merge_name": first["fp_id"].str.lower(), "position": first["pos"]})


def _played(teams, seed=0):
    rng = np.random.default_rng(seed)
    rows = [{"player_id": f"g-{t}{pos}{i}", "position": pos, "team": t, "our_pts": float(rng.normal()),
             "actual": float(rng.normal())} for t in teams for pos in POS for i in range(3)]
    return pd.DataFrame(rows)


def test_window_and_overlap():
    d = sw.week_dates(_sched(), 2024)
    assert sw.sameweek_window(d, 1) == (pd.Timestamp("2024-08-29"), pd.Timestamp("2024-09-09"))   # L_1 = K_1 - 7
    assert sw.sameweek_window(d, 2) == (pd.Timestamp("2024-09-10"), pd.Timestamp("2024-09-15"))
    assert sw.sameweek_window(d, 3) == (pd.Timestamp("2024-09-16"), pd.Timestamp("2024-09-22"))  # Sat-first week admits Fri
    assert not sw.overlapping(d, 2)
    late = dict(d)
    late[1] = (d[1][0], pd.Timestamp("2024-09-12"))
    assert sw.overlapping(late, 2)


def _prior_week_conflict():
    # astra S7-I3: week 1 = a valid Thursday 09-10 game plus CCC-DDD listed on Monday 09-14 AND Tuesday 09-15
    # (conflicting); week 2 = Thursday 09-17 and Sunday 09-20, valid. One Friday 09-11 scrape.
    rows = [(2026, 1, "2026-09-10", "AAA", "BBB"), (2026, 1, "2026-09-14", "CCC", "DDD"),
            (2026, 1, "2026-09-15", "CCC", "DDD"), (2026, 2, "2026-09-17", "AAA", "BBB"),
            (2026, 2, "2026-09-20", "CCC", "DDD")]
    sc = sw.validate_schedule(pd.DataFrame(rows, columns=["season", "week", "gameday", "home_team", "away_team"]))
    return sc, pd.DataFrame(_rank_rows("2026-09-11", ["AAA", "BBB", "CCC", "DDD"]))


def test_failed_prior_week_schedule_blocks_window_and_overlap_guard():
    sc, r = _prior_week_conflict()
    assert sc.week_validation(2026, 1).fails() and not sc.week_validation(2026, 2).fails()
    surviving = sw.week_dates(sc.valid_games, 2026)
    assert surviving[1] == (pd.Timestamp("2026-09-10"), pd.Timestamp("2026-09-10"))   # what the defect used as Z_1
    d = sc.dates(2026)
    assert sorted(d) == [2]                                                    # K_1/Z_1 undefined, not "Thursday"
    with pytest.raises(ValueError, match="schedule_dependency_failed"):
        sw.sameweek_window(d, 2)                                               # never the K_2 - 7 days fallback
    with pytest.raises(ValueError, match="schedule_dependency_failed"):
        sw.overlapping(d, 2)
    assert not sw.window_dates_ok(d, 2) and not sw.window_dates_ok(d, 1)
    played = _played(["AAA", "BBB", "CCC", "DDD"])
    defect = sw.sameweek_week(played, sc, r, _crosswalk(r), 2026, 2, surviving)  # the reproduction's input
    assert defect["status"] == "scored" and len(defect["cells"]) == 4           # 09-11 admitted: why dates() gates
    res = sw.sameweek_week(played, sc, r, _crosswalk(r), 2026, 2, d)
    assert res["status"] == "skipped" and res["reason"] == "validation_failed"
    assert res["detail"] == "schedule_dependency_failed" and res["cells"] == []


def test_final_week_window_is_bounded():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    after = pd.DataFrame(_rank_rows("2024-09-27", ["AAA", "BBB", "EEE", "FFF"]))      # a later (next-season-like) scrape
    sel = sw.select_sameweek_scrape(pd.concat([r, after], ignore_index=True), s, 2024, 3, d)
    assert pd.Timestamp("2024-09-27") not in {c["date"] for c in sel["candidates"]}


def test_selection_is_latest_noncontradicted_and_old_protocol_is_stale():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    sel = sw.select_sameweek_scrape(r, s, 2024, 3, d)
    assert sel["scrape_date"] == pd.Timestamp("2024-09-20") and sel["gate"].state == "bye_consistent"
    old2 = weekly_snapshot(r, pd.Timestamp(d[2][0]))          # regression record: old protocol picks week 1's list
    assert old2["scrape_date"].iloc[0] == pd.Timestamp("2024-09-06")
    audit = sw.staleness_audit_week(r, s, 2024, 2, d)
    assert audit["state"] == "contradicted" and audit["discriminating"] is False  # week-1 byes empty


def test_contradicted_latest_is_passed_over_by_metadata():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    stale_late = pd.DataFrame(_rank_rows("2024-09-14", ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]))  # lists wk2 byes
    sel = sw.select_sameweek_scrape(pd.concat([r, stale_late], ignore_index=True), s, 2024, 2, d)
    states = {c["date"]: c["state"] for c in sel["candidates"]}
    assert states[pd.Timestamp("2024-09-14")] == "contradicted"
    assert sel["scrape_date"] == pd.Timestamp("2024-09-13")
    assert all("pages" in c and "unknown_team_codes" in c for c in sel["candidates"])   # every candidate recorded


def test_population_filter_and_no_fallback():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    cw = _crosswalk(r)
    played = _played(["AAA", "BBB", "CCC", "DDD"])
    res = sw.sameweek_week(played, s, r, cw, 2024, 2, d)
    # scrape 09-13 (Fri): AAA/BBB played Thu 09-12 -> excluded; CCC/DDD Sun 09-15 kept
    assert res["status"] == "scored" and res["retention"]["excluded_early_game"] == 24
    assert res["retention"]["pool"] == 24 and res["selection"]["label"] is None
    thu_only = played[played["team"].isin(["AAA", "BBB"])]
    res2 = sw.sameweek_week(thu_only, s, r, cw, 2024, 2, d)
    assert res2["status"] == "skipped" and res2["reason"] == "no_scorable_cell"
    assert res2["selection"]["scrape_date"] == "2024-09-13"                    # no fallback to an earlier scrape


def test_saturday_game_excluded_with_saturday_scrape_kept_with_friday():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    cw = _crosswalk(r)
    played = _played(["AAA", "BBB", "EEE", "FFF"])
    fri = sw.sameweek_week(played, s, r, cw, 2024, 3, d)                       # Friday 09-20 scrape
    assert fri["retention"]["excluded_early_game"] == 0
    sat = pd.DataFrame(_rank_rows("2024-09-21", ["AAA", "BBB", "EEE", "FFF"]))
    res = sw.sameweek_week(played, s, pd.concat([r, sat], ignore_index=True), _crosswalk(pd.concat([r, sat])),
                           2024, 3, d)
    assert res["selection"]["scrape_date"] == "2024-09-21" and res["retention"]["excluded_early_game"] == 24


def test_postponed_game_date_is_honoured():
    moved = _sched()
    moved.loc[moved["gameday"] == "2024-09-12", "gameday"] = "2024-09-16"     # AAA-BBB postponed to Monday
    s = sw.validate_schedule(moved)
    d = s.dates(2024)
    r = _rankings()
    res = sw.sameweek_week(_played(["AAA", "BBB", "CCC", "DDD"]), s, r, _crosswalk(r), 2024, 2, d)
    assert res["retention"]["excluded_early_game"] == 0


def test_sign_of_both_spearmans_is_higher_is_better():
    # our_pts is higher-is-better and ecr lower-is-better: perfect forecasts on both sides score +1, never -1
    pool = pd.DataFrame({"player_id": [f"p{i}" for i in range(6)], "position": ["WR"] * 6,
                         "our_pts": [6, 5, 4, 3, 2, 1], "ecr": [1, 2, 3, 4, 5, 6], "actual": [60, 50, 40, 30, 20, 10]})
    cells, _ = sw.build_cells(pool, 2024, 2, "unverified")
    assert cells[0]["sp_ours"] == 1.0 and cells[0]["sp_con"] == 1.0


def test_build_cells_flags_and_degenerate():
    pool = pd.DataFrame({"player_id": [f"p{i}" for i in range(6)], "position": ["TE"] * 6,
                         "our_pts": [1, 2, 3, 4, 5, 6], "ecr": [1, 2, 3, 4, 5, 6], "actual": [6, 5, 4, 3, 2, 1]})
    cells, degenerate = sw.build_cells(pool, 2024, 2, "bye_consistent")
    assert len(cells) == 1 and cells[0]["n_le_slots"] is True and cells[0]["gate_state"] == "bye_consistent"
    assert sw.cell_summary(cells)[0]["delta"] == cells[0]["sp_ours"] - cells[0]["sp_con"]
    cells2, degenerate2 = sw.build_cells(pool.assign(actual=1.0), 2024, 2, "unverified")
    assert cells2 == [] and degenerate2 == 1
    assert sw.build_cells(pool.head(0), 2024, 2, "unverified") == ([], 0)


def test_secondary_path_above_threshold_skips_never_runs_on_subset():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    bad = r.copy()
    hit = bad.index[bad["scrape_date"] == pd.Timestamp("2024-09-13")][:2]
    bad.loc[hit, "ecr"] = np.nan                                              # 2 of 48 keys invalid > 1%
    res = sw.sameweek_week(_played(["AAA", "BBB", "CCC", "DDD"]), s, bad, _crosswalk(r), 2024, 2, d)
    assert res["status"] == "skipped" and res["reason"] == "validation_failed" and res["cells"] == []


def test_audit_read_obeys_threshold():
    s, r = _sc(), _rankings()
    d = s.dates(2024)
    bad = r.copy()
    hit = bad.index[bad["scrape_date"] == pd.Timestamp("2024-09-06")][:2]
    bad.loc[hit, "ecr"] = np.nan
    audit = sw.staleness_audit_week(bad, s, 2024, 2, d)
    assert audit["state"] is None and audit["reason"] == "validation_failed"


def test_ranking_coverage_counts_legacy_and_weekdays():
    raw = pd.DataFrame({"ecr_type": ["wp"] * 3, "pos": ["RB"] * 3, "page_type": ["weekly-offense", "weekly-rb", "weekly-rb"],
                        "scrape_date": ["2020-09-10", "2020-10-16", "2020-10-16"]})
    acc = pd.DataFrame({"scrape_date": pd.to_datetime(["2020-10-16", "2020-10-16"])})
    cov = sw.ranking_coverage(raw, acc, [2020])["2020"]
    assert cov["raw_rows"] == 3 and cov["accepted_rows"] == 2 and cov["excluded_legacy_schema"] == 1
    assert cov["scrape_dates"] == [{"date": "2020-10-16", "weekday": "Friday"}]
