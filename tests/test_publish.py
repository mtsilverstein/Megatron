"""Stage validation and copy (`ffmodel.site.publish`, spec §3.5, plan Task 7)."""
import hashlib
import json
from pathlib import Path

import pytest

from ffmodel.site import publish
from ffmodel.site.leaguelens import STATS
from ffmodel.site.neutral import empty_remaining, make_batch_context

GEN = "2026-10-08T12:00:00+00:00"


def _ctx(week=6):
    return make_batch_context(2026, week, f"2026-wk{week - 1}", GEN)


def _projection(week, stats=None):
    return {"week": week, "status": "conditional_projection", "opponent": "BUF",
            "stats": stats if stats is not None else [[1.0] * 12, [2.5] * 12, [4.0] * 12]}


def stage_docs(week=6) -> dict:
    ctx = _ctx(week)
    h = ctx.header()
    weekly_n = {**h, "schema_version": 1, "kind": "neutral_weekly", "model": "transformer",
                "players": [{"player_id": "00-1", "name": "A"}, {"player_id": "00-2", "name": "B"}]}
    if week > 17:
        remaining_n = empty_remaining(ctx, "transformer")
    else:
        remaining_n = {**h, "schema_version": 2, "kind": "neutral_remaining",
                       "horizon": "remaining_season", "status": "experimental",
                       "start_week": week, "end_week": 17, "model": "transformer",
                       "stat_order": list(STATS),
                       "players": [
                           {"player_id": "00-1", "team": "KC",
                            "weeks": [_projection(w) for w in range(week, 18)]},
                           {"player_id": "00-3", "team": "KC",
                            "weeks": [{"week": w, "status": "bye", "points": None}
                                      if w == week else
                                      {"week": w, "status": "conditional_projection",
                                       "opponent": "NYJ", "stats": [None, [0.5] * 12, None]}
                                      for w in range(week, 18)]}]}
    players_n = {**h, "schema_version": 1, "kind": "neutral_players", "ecr_source": None,
                 "players": [
                     {"player_id": "00-1", "sleeper_id": "11", "identity_only": False, "reason": None},
                     {"player_id": "00-2", "sleeper_id": "12", "identity_only": False, "reason": None},
                     {"player_id": "00-3", "sleeper_id": None, "identity_only": True,
                      "reason": "no_catalog_match"}]}
    evaluation_n = {**h, "schema_version": 1, "kind": "neutral_evaluation", "records": []}
    formats_n = {**h, "schema_version": 1, "kind": "neutral_formats",
                 "formats": [{"label": "f12-1qb-ppr-6", "format_key": "abc", "compat": {"st_td": 6},
                              "description": "12-team 1QB PPR, 6-pt pass TD", "exploratory": False}]}
    end = max(week, 17)
    legacy_weekly = {"generated_at": GEN, "data_through": ctx.data_through, "season": 2026,
                     "week": week, "players": []}
    legacy_remaining = {"schema_version": 1, "season": 2026, "start_week": week, "end_week": end,
                        "generated_at": GEN, "data_through": ctx.data_through, "players": []}
    return {
        "weekly.json": legacy_weekly,
        "weekly-fam.json": dict(legacy_weekly),
        "remaining-gabagool.json": legacy_remaining,
        "remaining-fam.json": dict(legacy_remaining),
        "kickoffs.json": {"season": 2026, "week": week, "generated_at": GEN, "teams": [], "games": []},
        "roles.json": {"schema_version": 1, "season": 2026, "before_week": week, "players": []},
        "about.json": {"generated_at": GEN, "data_through": "2026-wk5", "reports": []},
        "neutral/weekly.json": weekly_n,
        "neutral/remaining.json": remaining_n,
        "neutral/players.json": players_n,
        "neutral/evaluation.json": evaluation_n,
        "neutral/formats.json": formats_n,
    }


def write_stage(root: Path, docs: dict, *, omit_from_manifest=(), header=None, week=6) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    files = []
    for rel, doc in docs.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        data = json.dumps(doc).encode("utf-8")  # allow_nan default: a NaN reaches the file
        path.write_bytes(data)
        if rel not in omit_from_manifest:
            files.append({"path": rel, "sha256": hashlib.sha256(data).hexdigest(),
                          "bytes": len(data)})
    if header is None:
        header = _ctx(week).header()
    manifest = {**header, "schema_version": 1, "kind": "batch_manifest", "files": files}
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def errors_for(tmp_path, docs, **kw):
    return publish.validate(write_stage(tmp_path / "stage", docs, **kw))


def test_complete_stage_is_valid_and_copied(tmp_path):
    stage = write_stage(tmp_path / "stage", stage_docs())
    assert publish.validate(stage) == []
    out = tmp_path / "out"
    assert publish.main(["--stage", str(stage), "--out", str(out)]) == 0
    for rel in stage_docs():
        assert (out / rel).read_bytes() == (stage / rel).read_bytes()


@pytest.mark.parametrize("missing", list(publish.REQUIRED))
def test_each_missing_required_file_is_named_and_out_untouched(tmp_path, capsys, missing):
    docs = stage_docs()
    del docs[missing]
    stage = write_stage(tmp_path / "stage", docs)
    out = tmp_path / "out"
    out.mkdir()
    (out / "weekly.json").write_text("last good", encoding="utf-8")
    errors = publish.validate(stage)
    assert any(missing in e for e in errors), errors
    assert publish.main(["--stage", str(stage), "--out", str(out)]) != 0
    assert missing in capsys.readouterr().err
    assert sorted(p.name for p in out.rglob("*")) == ["weekly.json"]
    assert (out / "weekly.json").read_text(encoding="utf-8") == "last good"


def test_missing_manifest_is_an_error(tmp_path):
    stage = write_stage(tmp_path / "stage", stage_docs())
    (stage / "manifest.json").unlink()
    assert any("manifest" in e for e in publish.validate(stage))


def test_stale_file_on_disk_but_absent_from_manifest(tmp_path):
    errors = errors_for(tmp_path, stage_docs(), omit_from_manifest=("remaining-fam.json",))
    assert any("remaining-fam.json" in e and "manifest" in e for e in errors), errors


def test_sha_mismatch(tmp_path):
    stage = write_stage(tmp_path / "stage", stage_docs())
    doc = json.loads((stage / "roles.json").read_text())
    doc["players"] = [{"player_id": "x"}]
    (stage / "roles.json").write_text(json.dumps(doc))
    assert any("roles.json" in e and "sha256" in e for e in publish.validate(stage))


def test_listed_file_missing_from_stage(tmp_path):
    stage = write_stage(tmp_path / "stage", stage_docs())
    (stage / "about.json").unlink()
    assert any("about.json" in e for e in publish.validate(stage))


def test_mixed_batch_id(tmp_path):
    docs = stage_docs()
    docs["neutral/players.json"]["batch_id"] = "other"
    assert any("batch fields disagree" in e for e in errors_for(tmp_path, docs))


def test_manifest_from_another_batch(tmp_path):
    header = {**_ctx().header(), "batch_id": "other"}
    errors = errors_for(tmp_path, stage_docs(), header=header)
    assert any("batch fields disagree" in e for e in errors), errors


def test_legacy_week_rollover(tmp_path):
    docs = stage_docs()
    docs["weekly-fam.json"]["week"] = 7
    assert any("weekly-fam.json" in e and "week" in e for e in errors_for(tmp_path, docs))


def test_legacy_data_through_disagrees(tmp_path):
    docs = stage_docs()
    docs["weekly.json"]["data_through"] = "2026-wk6"
    assert any("weekly.json" in e and "data_through" in e for e in errors_for(tmp_path, docs))


def test_legacy_remaining_from_another_week(tmp_path):
    docs = stage_docs()
    docs["remaining-gabagool.json"]["start_week"] = 5
    assert any("remaining-gabagool.json" in e for e in errors_for(tmp_path, docs))


def test_kickoffs_week_disagrees(tmp_path):
    docs = stage_docs()
    docs["kickoffs.json"]["week"] = 5
    assert any("kickoffs.json" in e for e in errors_for(tmp_path, docs))


def test_duplicate_players_json_ids(tmp_path):
    docs = stage_docs()
    docs["neutral/players.json"]["players"].append(
        {"player_id": "00-1", "sleeper_id": None, "identity_only": True, "reason": "x"})
    assert any("players.json" in e and "duplicate" in e for e in errors_for(tmp_path, docs))


def test_projection_player_absent_from_players_json(tmp_path):
    docs = stage_docs()
    docs["neutral/players.json"]["players"].pop(1)  # 00-2 is in weekly
    assert any("00-2" in e for e in errors_for(tmp_path, docs))


def test_eleven_stat_row(tmp_path):
    docs = stage_docs()
    docs["neutral/remaining.json"]["players"][0]["weeks"][2] = _projection(
        8, [[1.0] * 11, [2.0] * 11, [3.0] * 11])
    assert any("12" in e for e in errors_for(tmp_path, docs))


def test_oversize_is_an_error_not_a_truncation(tmp_path, monkeypatch):
    stage = write_stage(tmp_path / "stage", stage_docs())
    size = (stage / "neutral/remaining.json").stat().st_size
    monkeypatch.setattr(publish, "SIZE_CAP_BYTES", size - 1)
    errors = publish.validate(stage)
    assert any("oversize" in e for e in errors), errors
    assert (stage / "neutral/remaining.json").stat().st_size == size
    out = tmp_path / "out"
    assert publish.main(["--stage", str(stage), "--out", str(out)]) != 0
    assert not out.exists() or not any(out.iterdir())


def test_size_cap_until_task_15():
    assert publish.SIZE_CAP_BYTES == 4_000_000


def test_week_18_empty_remaining_is_valid(tmp_path):
    assert errors_for(tmp_path, stage_docs(week=18), week=18) == []


def test_no_remaining_weeks_in_week_6_is_an_error(tmp_path):
    docs = stage_docs()
    docs["neutral/remaining.json"] = empty_remaining(_ctx(), "transformer")
    assert any("no_remaining_weeks" in e for e in errors_for(tmp_path, docs))


def test_week_18_with_rows_is_an_error(tmp_path):
    docs = stage_docs(week=18)
    docs["neutral/remaining.json"]["status"] = "experimental"
    assert any("no_remaining_weeks" in e for e in errors_for(tmp_path, docs, week=18))


@pytest.mark.parametrize("name,field,value", [
    ("neutral/weekly.json", "kind", "neutral_remaining"),
    ("neutral/remaining.json", "schema_version", 1),
    ("neutral/players.json", "kind", "players"),
    ("neutral/evaluation.json", "schema_version", 2),
    ("neutral/formats.json", "kind", "formats"),
])
def test_wrong_kind_or_schema_version(tmp_path, name, field, value):
    docs = stage_docs()
    docs[name][field] = value
    assert any(name in e and field in e for e in errors_for(tmp_path, docs))


def test_duplicate_weekly_id(tmp_path):
    docs = stage_docs()
    docs["neutral/weekly.json"]["players"].append({"player_id": "00-1", "name": "A again"})
    assert any("weekly.json" in e and "duplicate" in e for e in errors_for(tmp_path, docs))


def test_duplicate_remaining_id(tmp_path):
    docs = stage_docs()
    docs["neutral/remaining.json"]["players"].append(
        dict(docs["neutral/remaining.json"]["players"][0]))
    assert any("remaining.json" in e and "duplicate" in e for e in errors_for(tmp_path, docs))


def test_duplicate_player_week_row(tmp_path):
    docs = stage_docs()
    weeks = docs["neutral/remaining.json"]["players"][0]["weeks"]
    weeks.append(dict(weeks[0]))
    assert any("duplicate" in e and "week" in e for e in errors_for(tmp_path, docs))


def test_duplicate_scorable_sleeper_id(tmp_path):
    docs = stage_docs()
    docs["neutral/players.json"]["players"][1]["sleeper_id"] = "11"
    assert any("sleeper_id" in e for e in errors_for(tmp_path, docs))


def test_duplicate_sleeper_id_on_identity_only_player_is_allowed(tmp_path):
    docs = stage_docs()
    docs["neutral/players.json"]["players"][2]["sleeper_id"] = "11"
    assert errors_for(tmp_path, docs) == []


def test_nan_stat(tmp_path):
    docs = stage_docs()
    stats = [[1.0] * 12, [2.0] * 11 + [float("nan")], [3.0] * 12]
    docs["neutral/remaining.json"]["players"][0]["weeks"][1] = _projection(7, stats)
    assert any("remaining.json" in e for e in errors_for(tmp_path, docs))


def test_non_numeric_stat(tmp_path):
    docs = stage_docs()
    stats = [[1.0] * 12, [2.0] * 11 + ["2"], [3.0] * 12]
    docs["neutral/remaining.json"]["players"][0]["weeks"][1] = _projection(7, stats)
    assert any("finite" in e for e in errors_for(tmp_path, docs))


def test_one_sided_null_band(tmp_path):
    docs = stage_docs()
    docs["neutral/remaining.json"]["players"][0]["weeks"][1] = _projection(
        7, [None, [2.0] * 12, [3.0] * 12])
    assert any("one-sided" in e for e in errors_for(tmp_path, docs))


def test_wrong_stat_order(tmp_path):
    docs = stage_docs()
    docs["neutral/remaining.json"]["stat_order"] = list(reversed(STATS))
    assert any("stat_order" in e for e in errors_for(tmp_path, docs))


def test_wrong_remaining_horizon(tmp_path):
    docs = stage_docs()
    docs["neutral/remaining.json"]["end_week"] = 18
    assert any("end_week" in e for e in errors_for(tmp_path, docs))


def test_formats_without_envelope(tmp_path):
    docs = stage_docs()
    docs["neutral/formats.json"] = docs["neutral/formats.json"]["formats"]
    errors = errors_for(tmp_path, docs)
    assert any("formats.json" in e for e in errors), errors


def test_invalid_json(tmp_path):
    stage = write_stage(tmp_path / "stage", stage_docs())
    data = b"{not json"
    (stage / "about.json").write_bytes(data)
    manifest = json.loads((stage / "manifest.json").read_text())
    for f in manifest["files"]:
        if f["path"] == "about.json":
            f["sha256"] = hashlib.sha256(data).hexdigest()
    (stage / "manifest.json").write_text(json.dumps(manifest))
    assert any("about.json" in e and "JSON" in e for e in publish.validate(stage))


@pytest.mark.parametrize("bad", ["../escape.json", "/abs.json", "neutral\\weekly.json"])
def test_unsafe_manifest_path(tmp_path, bad):
    stage = write_stage(tmp_path / "stage", stage_docs())
    manifest = json.loads((stage / "manifest.json").read_text())
    manifest["files"].append({"path": bad, "sha256": "0" * 64})
    (stage / "manifest.json").write_text(json.dumps(manifest))
    assert any("path" in e for e in publish.validate(stage))


def test_copy_refuses_an_invalid_stage(tmp_path):
    docs = stage_docs()
    del docs["about.json"]
    stage = write_stage(tmp_path / "stage", docs)
    with pytest.raises(ValueError, match="about.json"):
        publish.copy(stage, tmp_path / "out")
    assert not (tmp_path / "out").exists()
