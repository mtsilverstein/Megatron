"""Spec §4.8 private Sleeper comparator on synthetic snapshots (no real Sleeper data in this public repo)."""
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ffmodel.eval import live_accuracy as la
from ffmodel.eval import sameweek as sw
from ffmodel.eval import sleeper_compare as sc
from tests.test_live_accuracy_evidence import FakeGit, _c
from tests.test_live_accuracy_metrics import POS, TEAMS, _legacy, _raw_world

AVAIL, CUT = "2026-09-09T10:00:00Z", "2026-09-10T00:00:00Z"


def _cap(t, kind="scheduled", status=200, season=2026, week=1):
    return {"retrieved_at": t, "season": season, "week": week, "capture_kind": kind, "http_status": status,
            "path": f"sleeper/{season}/w{week:02d}/{t.replace(':', '-')}.json.gz", "sha256": "x"}


def test_snapshot_choice_paired_latest_and_none():
    m = [_cap("2026-09-09T08:00:00Z"), _cap("2026-09-09T12:00:00Z"), _cap("2026-09-09T22:00:00Z"),
         _cap("2026-09-10T00:00:01Z"), _cap("2026-09-09T10:30:00Z", status=500)]
    ch = sc.choose_snapshots(m, 2026, 1, AVAIL, CUT)
    assert ch["paired"]["retrieved_at"] == "2026-09-09T08:00:00Z"          # 2 h each side: ties to the earlier
    assert ch["latest"]["retrieved_at"] == "2026-09-09T22:00:00Z" and ch["latest_gap_hours"] == pytest.approx(12.0)
    far = sc.choose_snapshots([_cap("2026-09-07T09:00:00Z")], 2026, 1, AVAIL, CUT)
    assert far["paired"] is None and far["latest"] is not None                # outside 24 h: latest only
    none = sc.choose_snapshots([_cap("2026-09-10T01:00:00Z")], 2026, 1, AVAIL, CUT)
    assert none == {"paired": None, "latest": None, "latest_gap_hours": None}
    manual = sc.choose_snapshots([_cap("2026-09-09T11:00:00Z", kind="manual", status=None)], 2026, 1, AVAIL, CUT)
    assert manual["paired"] is not None


def _rec(pid, pos="WR", stats=None, season="2026", week=1, category="proj"):
    return {"player_id": pid, "category": category, "season": season, "week": week,
            "player": {"position": pos}, "stats": stats if stats is not None else {"rec": 3.0, "rec_yd": 40.0,
                                                                                   "pts_ppr": 7.0}}


def test_scoring_absent_key_zero_present_null_invalid_missing_pts_invalid():
    recs = [_rec("1"), _rec("2", stats={"rec": None, "pts_ppr": 1.0}), _rec("3", stats={"rec": 2.0}),
            _rec("4", pos="K"), _rec("5", season="2025"), _rec("6", category="stat")]
    frame = sc.sleeper_frame(recs, 2026, 1)
    assert list(frame["sleeper_id"]) == ["1", "2", "3"]
    assert frame.loc[0, "rushing_yards"] == 0.0                               # absent mapped key = 0
    cw = pd.DataFrame({"sleeper_id": [1.0, 2.0, 3.0], "gsis_id": ["g1", "g2", "g3"]})
    vs = sc.validate_sleeper(frame, cw)
    assert vs["validation"].invalid_keys() == {("2",), ("3",)}                 # present null; missing pts_ppr
    assert vs["rows"]["sleeper_pts"].tolist() == pytest.approx([3.0 + 4.0])  # hand re-score: 3 rec + 40 yd PPR


@pytest.mark.parametrize("pos,stats,expected", [
    ("QB", {"pass_yd": 250.0, "pass_td": 2.0, "pass_int": 1.0, "rush_yd": 20.0, "pts_ppr": 1.0}, 10 + 8 - 2 + 2),
    ("RB", {"rush_att": 15.0, "rush_yd": 70.0, "rush_td": 1.0, "rec": 2.0, "rec_yd": 15.0, "fum_lost": 1.0,
            "pts_ppr": 1.0}, 7 + 6 + 2 + 1.5 - 2),
    ("TE", {"rec_tgt": 6.0, "rec": 4.0, "rec_yd": 45.0, "rec_td": 1.0, "rec_2pt": 1.0, "pts_ppr": 1.0}, 4 + 4.5 + 6),
])
def test_hand_computed_rescore_per_position(pos, stats, expected):
    vs = sc.validate_sleeper(sc.sleeper_frame([_rec("1", pos=pos, stats=stats)], 2026, 1),
                             pd.DataFrame({"sleeper_id": ["1"], "gsis_id": ["g1"]}))
    assert vs["rows"]["sleeper_pts"].iloc[0] == pytest.approx(expected)       # rec_2pt is not a common component


def test_crosswalk_collisions_invalidate_every_row_involved():
    frame = sc.sleeper_frame([_rec(str(i)) for i in range(1, 6)], 2026, 1)
    cw = pd.DataFrame({"sleeper_id": [1.0, 1.0, 2.0, 3.0, 4.0], "gsis_id": ["g1", "gX", "g2", "g2", "g4"]})
    vs = sc.validate_sleeper(frame, cw)
    assert vs["validation"].invalid["crosswalk_collision"] == {("1",), ("2",), ("3",)}   # one-to-many, many-to-one
    assert vs["unmapped"] == 1 and vs["rows"]["player_id"].tolist() == ["g4"]


def _rows(n=12):
    rng = np.random.default_rng(3)
    df = pd.DataFrame({"player_id": [f"p{i}" for i in range(n)], "position": ["WR"] * n, "team": ["AAA"] * n,
                       "week": [5] * n, "actual": rng.uniform(0, 20, n), "ours": rng.uniform(0, 20, n),
                       "sleeper": rng.uniform(0, 20, n)})
    return df.assign(blend=0.5 * df["ours"] + 0.5 * df["sleeper"])


def test_relevant_union_uses_projections_only_and_blend_is_half_half():
    played = pd.DataFrame({"player_id": ["a", "b", "c"], "position": "WR", "team": "AAA", "week": 5,
                           "actual": [30.0, 0.0, 0.0]})
    ours = pd.DataFrame({"player_id": ["a", "b", "c"], "p50": [2.0, 9.0, 3.0]})
    slp = pd.DataFrame({"player_id": ["a", "b", "c"], "sleeper_pts": [3.0, 1.0, 8.0]})
    rows = sc.compare_rows(played, ours, slp)
    assert rows["blend"].tolist() == [2.5, 5.0, 5.5]
    assert sc.relevant(rows)["player_id"].tolist() == ["b", "c"]               # a scored 30 but projected < 8


def test_view_metrics_three_paired_deltas():
    rows = _rows()
    m = sc.view_metrics(rows)
    assert set(m["deltas"]) == {"ours_minus_sleeper", "blend_minus_sleeper", "blend_minus_ours"}
    expected = np.mean(np.abs(rows.actual - rows.ours) - np.abs(rows.actual - rows.sleeper))
    assert m["deltas"]["ours_minus_sleeper"]["mean"] == pytest.approx(expected)
    assert len(m["deltas"]["ours_minus_sleeper"]["ci95_player"]) == 2 and m["spearman_cells"]
    assert sc.view_metrics(rows.head(0))["n"] == 0


def test_missingness_per_side():
    played = pd.DataFrame({"player_id": ["a", "b", "c"], "position": ["WR", "WR", "RB"]})
    assert sc.missingness(played, {"a"}, {"a", "c"}) == {
        "RB": {"played": 1, "ours_missing": 1, "sleeper_missing": 0, "both_missing": 0},
        "WR": {"played": 2, "ours_missing": 1, "sleeper_missing": 1, "both_missing": 1}}


def test_season_end_holm():
    rows = _rows(40).assign(sleeper=lambda d: d["actual"] + 5.0)              # Sleeper always 5 off
    rows = rows.assign(ours=rows["actual"] + 0.1, blend=0.5 * (rows["actual"] + 0.1) + 0.5 * rows["sleeper"])
    r = sc.season_end(rows)
    assert [c["outcome"] for c in r["claims"]] == ["ours_lower_error", "blend_lower_error"]
    tie = _rows(40)
    tie = tie.assign(sleeper=tie["ours"], blend=tie["ours"])
    assert all(c["outcome"] == "inconclusive" for c in sc.season_end(tie)["claims"])


# --- end to end: run() + write_report, privacy ---------------------------------------------------------------------
def _store(root: Path, week, retrieved_at, records):
    raw = json.dumps(records).encode()
    rel = f"sleeper/2026/w{week:02d}/{retrieved_at.replace(':', '-')}.json.gz"
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_bytes(gzip.compress(raw))
    line = {"retrieved_at": retrieved_at, "sha256": hashlib.sha256(raw).hexdigest(), "season": 2026, "week": week,
            "path": rel, "request_url": "https://example.invalid/x", "http_status": 200, "records": len(records),
            "source_updated_at_min": None, "source_updated_at_max": None, "source_updated_at_count": 0,
            "published_commit": "pub", "published_batch_id": "b1", "capture_kind": "scheduled"}
    with (root / "sleeper" / "manifest.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(line) + "\n")


def _world(tmp_path, first_week=1):
    ids = [f"{t}{p}{i}" for t in TEAMS for p in POS for i in range(5)]
    payload = _legacy(gen="g1", week=1, players=[(i, i[3:5], i[:3], 6.0, 9.0 + k % 3, 14.0) for k, i in enumerate(ids)])
    git = FakeGit({"pub": _c([], la.BOT, {la.WEEKLY_FILES[0]}, {la.WEEKLY_FILES[0]: json.dumps(payload).encode()})})
    artifact = {"season": 2026, "protocol_version": "live-accuracy-v1", "weeks_scored": [1],
                "weeks": {"1": {"cutoff": CUT, "publication": {"commit": "pub", "available_by": AVAIL}}}}
    store = tmp_path / "private"
    recs = [_rec(str(k), pos=i[3:5], stats={"rec": 4.0, "rec_yd": 50.0 + k, "pts_ppr": 9.0}) for k, i in enumerate(ids)]
    _store(store, 1, "2026-09-09T11:00:00Z", recs)
    cw = pd.DataFrame({"sleeper_id": [float(k) for k in range(len(ids))], "gsis_id": ids})
    weekly, sched = _raw_world()
    old = dict(sc.FIRST_COMPARABLE_WEEK)
    sc.FIRST_COMPARABLE_WEEK[2026] = first_week
    return store, artifact, sw.prepare(weekly, sched), cw, git, old


def test_run_end_to_end_and_writes_only_under_out(tmp_path):
    store, artifact, prep, cw, git, old = _world(tmp_path)
    try:
        before = {p for p in tmp_path.rglob("*")}
        report = sc.run(store, artifact, prep, cw, git, season_end_read=True)
        written = sc.write_report(report, tmp_path / "out" / "reports")
    finally:
        sc.FIRST_COMPARABLE_WEEK.clear()
        sc.FIRST_COMPARABLE_WEEK.update(old)
    new = {p for p in tmp_path.rglob("*")} - before
    assert all(str(p).startswith(str(tmp_path / "out")) for p in new)
    assert sorted(p.name for p in written) == ["sleeper_2026.json", "sleeper_2026.md"]
    wk = report["by_week"]["1"]
    assert wk["paired"]["status"] == "scored" and wk["paired"]["diagnostic"]["n"] == 20
    assert report["season_end"]["status"] == "read"
    cap = sc.load_manifest(store)[0]
    assert report["provenance"]["selected_captures"] == [{"path": cap["path"], "sha256": cap["sha256"]}]
    assert report["provenance"]["evaluator_version"]["protocol_version"] == "sleeper-compare-v1"
    json.dumps(report, allow_nan=False)


def test_private_vintage_missing_team_is_private_inputs_incomplete_with_provenance(tmp_path):
    # astra S7-I5: the public artifact scored 2026 week 1, but the private job's own fresh pull has only team AAA's
    # rows for the AAA-BBB game. The public completeness decision is not borrowed; the week is skipped.
    store, artifact, _, cw, git, old = _world(tmp_path)
    weekly, sched = _raw_world(missing_team_week=(2026, 1, "BBB"))
    assert not la.week_complete(sw.prepare(weekly, sched), 2026, 1)
    art_path = tmp_path / "live_2026_weekly.json"
    art_bytes = json.dumps(artifact).encode()
    art_path.write_bytes(art_bytes)
    out = tmp_path / "out" / "reports"
    try:
        rc = sc.main(["--snapshots", str(store), "--live-artifact", str(art_path), "--out", str(out),
                      "--data-dir", str(tmp_path / "cache")],
                     load_inputs=lambda season, data_dir: (weekly, sched, cw), git=git)
    finally:
        sc.FIRST_COMPARABLE_WEEK.clear()
        sc.FIRST_COMPARABLE_WEEK.update(old)
    report = json.loads((out / "sleeper_2026.json").read_text(encoding="utf-8"))
    assert rc == 0 and report["by_week"]["1"] == {"status": "skipped", "reason": "private_inputs_incomplete"}
    assert report["cumulative"]["paired"] == {"status": "no_data"}
    inputs = report["provenance"]["inputs"]
    assert inputs["actuals"] == la.frame_sha256(weekly) and inputs["schedules"] == la.frame_sha256(sched)
    assert inputs["crosswalk"] == la.frame_sha256(cw)
    assert inputs["live_artifact"] == hashlib.sha256(art_bytes).hexdigest()
    assert inputs["manifest"] == hashlib.sha256((store / "sleeper" / "manifest.jsonl").read_bytes()).hexdigest()
    assert report["provenance"]["evaluator_version"]["id"] == "sleeper-compare-v1+tree0"
    assert report["provenance"]["run_at"] and report["provenance"]["selected_captures"] == []


def test_sleeper_table_above_threshold_skips_never_runs_on_subset(tmp_path):
    store, artifact, prep, cw, git, old = _world(tmp_path)
    try:
        cap = sc.load_manifest(store)[0]
        recs = sc.read_capture(store, cap)
        recs[0]["stats"]["rec"] = None                                        # 1 of 20 keys = 5% > 1%
        raw = json.dumps(recs).encode()
        (store / cap["path"]).write_bytes(gzip.compress(raw))
        line = {**cap, "sha256": hashlib.sha256(raw).hexdigest()}
        (store / "sleeper" / "manifest.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
        report = sc.run(store, artifact, prep, cw, git)
    finally:
        sc.FIRST_COMPARABLE_WEEK.clear()
        sc.FIRST_COMPARABLE_WEEK.update(old)
    paired = report["by_week"]["1"]["paired"]
    assert paired["status"] == "skipped" and paired["reason"] == "validation_failed" and "primary" not in paired
    assert report["cumulative"]["paired"] == {"status": "no_data"}


def test_exploratory_weeks_never_pooled_and_tampered_snapshot_skipped(tmp_path):
    store, artifact, prep, cw, git, old = _world(tmp_path, first_week=5)
    try:
        report = sc.run(store, artifact, prep, cw, git)
        assert report["by_week"]["1"] == {"status": "skipped", "reason": "exploratory_weeks_excluded"}
        sc.FIRST_COMPARABLE_WEEK[2026] = 1
        gz = next(store.rglob("*.json.gz"))
        gz.write_bytes(gzip.compress(b"[]"))
        report2 = sc.run(store, artifact, prep, cw, git)
        assert report2["by_week"]["1"]["paired"]["reason"] == "snapshot_integrity_failed"
    finally:
        sc.FIRST_COMPARABLE_WEEK.clear()
        sc.FIRST_COMPARABLE_WEEK.update(old)


def _rewrite_capture(store, raw_gz: bytes, sha=None):
    cap = sc.load_manifest(store)[0]
    (store / cap["path"]).write_bytes(raw_gz)
    if sha is not None:
        (store / "sleeper" / "manifest.jsonl").write_text(json.dumps({**cap, "sha256": sha}) + "\n", encoding="utf-8")


def test_truncated_and_non_gzip_capture_skipped_run_continues(tmp_path):
    store, artifact, prep, cw, git, old = _world(tmp_path)
    try:
        cap = sc.load_manifest(store)[0]
        good = (store / cap["path"]).read_bytes()
        for bad in (good[: len(good) // 2], b"not gzip at all"):
            (store / cap["path"]).write_bytes(bad)
            with pytest.raises(sc.SnapshotIntegrityError):
                sc.read_capture(store, cap)
            report = sc.run(store, artifact, prep, cw, git)
            assert report["by_week"]["1"]["paired"]["reason"] == "snapshot_integrity_failed"
    finally:
        sc.FIRST_COMPARABLE_WEEK.clear()
        sc.FIRST_COMPARABLE_WEEK.update(old)


def test_empty_sleeper_table_is_validation_failed_not_scored(tmp_path):
    store, artifact, prep, cw, git, old = _world(tmp_path)
    try:
        raw = b"[]"
        _rewrite_capture(store, gzip.compress(raw), hashlib.sha256(raw).hexdigest())
        report = sc.run(store, artifact, prep, cw, git)
    finally:
        sc.FIRST_COMPARABLE_WEEK.clear()
        sc.FIRST_COMPARABLE_WEEK.update(old)
    paired = report["by_week"]["1"]["paired"]
    assert paired["status"] == "skipped" and paired["reason"] == "validation_failed"
    assert paired["detail"] == "empty_sleeper_table"
    assert report["cumulative"]["paired"] == {"status": "no_data"}


def test_week_given_as_string_is_still_eligible():
    frame = sc.sleeper_frame([_rec("1", week="1"), _rec("2", week=1.0), _rec("3", week="x"), _rec("4", week=2)],
                             2026, 1)
    assert list(frame["sleeper_id"]) == ["1", "2"]
