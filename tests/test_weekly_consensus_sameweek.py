"""(B) driver orchestration on synthetic raw tables with a fake model (spec §3.9, §5, §6.6)."""
import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.eval import sameweek as sw
from ffmodel.eval import weekly_consensus_sameweek as drv
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

TEAMS = ["AAA", "BBB", "CCC", "DDD"]


def _world(season=2024, weeks=4, duplicate=None, weekly_edit=None, extra_games=()):
    """Raw weekly rows (as pull_weekly returns) + schedule; Thursday AAA-BBB, Sunday CCC-DDD; Friday scrapes.
    `weekly_edit(weekly) -> weekly` and `extra_games` alter the raw tables before sw.prepare."""
    sched, ranks, weekly = [], [], []
    rng = np.random.default_rng(1)
    for w in range(1, weeks + 1):
        thu = pd.Timestamp(f"{season}-09-05") + pd.Timedelta(days=7 * (w - 1))
        sched += [(season, w, str(thu.date()), "AAA", "BBB"), (season, w, str((thu + pd.Timedelta(days=3)).date()), "CCC", "DDD")]
        for t in TEAMS:
            for pos in sw.POSITIONS:
                for i in range(4):
                    pid = f"{t}{pos}{i}"
                    ranks.append({"fp_id": pid, "player": pid, "pos": pos, "team": t, "ecr": float(i + 1), "sd": 1.0,
                                  "mergename": pid.lower(), "scrape_date": thu + pd.Timedelta(days=1)})
                    row = {"player_id": f"g-{pid}", "player_display_name": pid, "position": pos, "team": t,
                           "opponent_team": {"AAA": "BBB", "BBB": "AAA", "CCC": "DDD", "DDD": "CCC"}[t],
                           "season": season, "week": w, "target_share": np.nan, "snap_pct": np.nan,
                           "two_point_conversions": 0, "special_teams_tds": 0}
                    row.update({s: float(rng.poisson(3)) for s in PREDICTED_STATS})
                    weekly.append(row)
    weekly = pd.DataFrame(weekly)
    if duplicate is not None:
        weekly = pd.concat([weekly, weekly.iloc[[duplicate]]], ignore_index=True)
    if weekly_edit is not None:
        weekly = weekly_edit(weekly)
    sched = pd.DataFrame([*sched, *extra_games], columns=["season", "week", "gameday", "home_team", "away_team"])
    ranks = pd.DataFrame(ranks)
    first = ranks.drop_duplicates("fp_id")
    cw = pd.DataFrame({"gsis_id": "g-" + first["fp_id"], "fantasypros_id": first["fp_id"],
                       "merge_name": first["fp_id"].str.lower(), "position": first["pos"]})
    return sw.prepare(weekly, sched), ranks, cw


def _good(season, train, test):
    return fantasy_points(test[PREDICTED_STATS], PPR)          # positively correlated, indexed like test


def _anti(season, train, test):
    return -fantasy_points(test[PREDICTED_STATS], PPR)


def test_run_sample_scores_sunday_players_only_and_records_audit():
    prep, ranks, cw = _world()
    res = drv.run_sample(prep, ranks, cw, [2024], _good)
    scored = [w for w in res["weeks"] if w["status"] == "scored"]
    assert scored and all(w["retention"]["excluded_early_game"] == 32 for w in scored)   # AAA/BBB on Thursday
    assert set(res["cells"]["gate_state"]) <= {"bye_consistent", "unverified"}
    assert len(res["audit"]) == 4 and res["target_weeks"] == {2024: [1, 2, 3, 4]}
    assert all("pages" in c for w in scored for c in w["selection"]["candidates"])
    assert all(w["selection"]["label"] == "inferred_by_window" for w in scored)        # no byes: unverified
    assert all(set(c) == {"position", "n", "sp_ours", "sp_con", "delta"} for w in scored for c in w["cells"])


def test_driver_path_collapses_raw_duplicate_before_model_inputs():
    prep, ranks, cw = _world(duplicate=0)                       # an exact duplicate raw row for week 1
    assert prep.exact_by_week == {(2024, 1): 1}
    assert len(prep.features) == 4 * 4 * 4 * 4
    wk1 = [w for w in drv.run_sample(prep, ranks, cw, [2024], _good)["weeks"] if w["week"] == 1][0]
    assert wk1["input_validation"]["actuals"]["exact_duplicates"] == 1


def _mixed_group(weekly):
    # astra S7-I2: player g-CCCRB0 carries 10 | 20, 20, 25 | 30 in weeks 1-3; week 2 is one conflicting key
    pid = weekly["player_id"] == "g-CCCRB0"
    for w, c in ((1, 10.0), (2, 20.0), (3, 30.0)):
        weekly.loc[pid & (weekly["week"] == w), "carries"] = c
    wk2 = weekly[pid & (weekly["week"] == 2)]
    return pd.concat([weekly, wk2, wk2.assign(carries=25.0)], ignore_index=True)


def test_driver_path_keeps_mixed_conflicting_group_in_model_inputs():
    prep, ranks, cw = _world(weekly_edit=_mixed_group)
    seen = {}

    def spy(season, train, test):
        row = test[(test["player_id"] == "g-CCCRB0") & (test["week"] == 3)]
        seen["lag4_carries"] = float(row["lag4_carries"].iloc[0])
        seen["week2_rows"] = int(((test["player_id"] == "g-CCCRB0") & (test["week"] == 2)).sum())
        return _good(season, train, test)

    res = drv.run_sample(prep, ranks, cw, [2024], spy)
    assert seen == {"lag4_carries": pytest.approx(18.75), "week2_rows": 3}           # 10, 20, 20, 25 -> 18.75
    by_week = {w["week"]: w for w in res["weeks"]}
    assert by_week[2]["reason"] == "validation_failed"                               # 1 of 64 keys > 1%
    v2 = by_week[2]["validation"]["actuals"]
    assert v2["invalid_by_reason"] == {"conflicting_duplicates": 1} and v2["exact_duplicates"] == 0
    assert by_week[3]["status"] == "scored"                                          # week 3 scored on those inputs


def test_driver_path_failed_prior_week_schedule_is_a_dependency_failure():
    # astra S7-I3 through the (B) driver: week 1's CCC-DDD game is also listed on Monday (conflicting)
    prep, ranks, cw = _world(extra_games=[(2024, 1, "2024-09-09", "CCC", "DDD")])
    res = drv.run_sample(prep, ranks, cw, [2024], _good)
    by_week = {w["week"]: w for w in res["weeks"]}
    assert by_week[1]["reason"] == "validation_failed" and by_week[1]["detail"] == "schedule_dependency_failed"
    assert by_week[2]["status"] == "skipped" and by_week[2]["reason"] == "validation_failed"
    assert by_week[2]["detail"] == "schedule_dependency_failed" and by_week[2]["cells"] == []
    assert by_week[3]["status"] == "scored"                                          # weeks 2 and 3 both pass
    assert drv.aggregate_validation(res["weeks"])["schedule"]["failed_weeks"] == 1


def test_schedule_duplicate_count_reaches_the_artifact():
    prep, ranks, cw = _world(extra_games=[(2024, 2, "2024-09-15", "CCC", "DDD")])    # exact duplicate game
    disc = drv.run_sample(prep, ranks, cw, [2024], _good)
    report = drv.build_report(disc, disc, {"inputs": {}})
    assert report["discovery"]["validation"]["schedule"]["exact_duplicates"] == 1


def test_evaluator_version_uses_the_sameweek_protocol():
    class _Checkout:
        def tree_id(self, path="src/ffmodel"):
            return "tree0"

        def dirty(self, path="src/ffmodel"):
            return False

    ev = drv.evaluator(_Checkout())
    assert ev["protocol_version"] == "sameweek-v1" and ev["id"] == "sameweek-v1+tree0"


def test_alarm_blocks_verdicts_until_a_no_defect_audit():
    prep, ranks, cw = _world()
    disc = drv.run_sample(prep, ranks, cw, [2024], _anti)
    report = drv.build_report(disc, disc, {"inputs": {}})
    assert disc["alarm"] is True and report["status"] == "alarm_negative_correlation" and report["verdicts"] is None
    cells = report["alarm_audit_cells"]["discovery"]
    assert len(cells) == 1 and cells[0]["season"] == 2024
    record = {"fixtures": {"command": drv.AUDIT_FIXTURES, "result": "passed"}, "conclusion": "no_defect",
              "hand_checks": [{**c, "sp_ours_hand": c["sp_ours_driver"], "sp_con_hand": c["sp_con_driver"]}
                              for c in cells]}
    audited = drv.build_report(disc, disc, {"inputs": {}}, alarm_audit=record)
    assert audited["status"] == "alarm_negative_correlation" and audited["verdicts"]["rule_1"]["value"]
    assert "limited sample" in audited["warning"] and audited["alarm_audit"] == record
    with pytest.raises(ValueError):
        drv.build_report(disc, disc, {"inputs": {}}, alarm_audit={**record, "conclusion": "defect_found"})
    with pytest.raises(ValueError):
        drv.build_report(disc, disc, {"inputs": {}}, alarm_audit={**record, "hand_checks": []})


def test_build_report_verdicts_and_audit_block():
    prep, ranks, cw = _world()
    disc = drv.run_sample(prep, ranks, cw, [2024], _good)
    report = drv.build_report(disc, disc, {"inputs": {}, "evaluator_version": {"id": "x"}})
    assert report["status"] == "ok"
    assert report["verdicts"]["rule_1"]["value"] in {"insufficient", "behind", "ahead", "not_established"}
    assert report["verdicts"]["rule_2"]["value"] in {"insufficient", "established", "not_established"}
    audit = report["old_protocol_staleness_audit"]
    assert len(audit["weeks"]) == 8 and audit["definition"] and "protocol" in report
    assert report["discovery"]["validation"]["actuals"]["failed_weeks"] == 0
    json.dumps(report, allow_nan=False)


def test_model_artifact_hashes_name_every_fold_file(tmp_path):
    root = tmp_path / "v1"
    (root / "through2022").mkdir(parents=True)
    (root / "through2022" / "model.pt").write_bytes(b"w")
    h = drv.model_artifact_hashes([root], [2023])
    assert len(h) == len(drv.FOLD_FILES) and h[(root / "through2022" / "model.pt").as_posix()]
    assert h[(root / "through2022" / "config.yaml").as_posix()] is None        # a missing file shows as None
