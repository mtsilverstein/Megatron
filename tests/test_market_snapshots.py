"""Market-snapshot collector: synthetic, network-free tests."""
from __future__ import annotations

import gzip
import hashlib
import json
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest
import yaml

from ffmodel.collect import market_snapshots as ms

T0 = datetime(2026, 10, 14, 21, 5, 9, tzinfo=timezone.utc)
ROOT = Path(__file__).resolve().parent.parent


def _weekly(tmp_path: Path, **over) -> Path:
    d = {"season": 2026, "week": 5, "batch_id": "b|x"}
    d.update(over)
    p = tmp_path / "weekly.json"
    p.write_text(json.dumps(d), encoding="utf-8")
    return p


# 1. published_target
def test_published_target_ok(tmp_path):
    assert ms.published_target(_weekly(tmp_path)) == {"season": 2026, "week": 5, "batch_id": "b|x"}


@pytest.mark.parametrize("over", [{"week": 0}, {"week": 23}, {"week": "5"}, {"batch_id": ""}])
def test_published_target_rejects(tmp_path, over):
    with pytest.raises(ValueError):
        ms.published_target(_weekly(tmp_path, **over))


def test_published_target_missing_batch(tmp_path):
    p = tmp_path / "w.json"
    p.write_text(json.dumps({"season": 2026, "week": 5}), encoding="utf-8")
    with pytest.raises(ValueError):
        ms.published_target(p)


# 2. sleeper_source_times
def test_sleeper_source_times():
    raw = json.dumps([{"updated_at": 1789444813187}, {"updated_at": 1789444813638}, {"x": 1}]).encode()
    r = ms.sleeper_source_times(raw)
    assert r["records"] == 3 and r["source_updated_at_count"] == 2
    assert r["source_updated_at_min"] == "2026-09-15T04:00:13.187Z"
    assert r["source_updated_at_max"] == "2026-09-15T04:00:13.638Z"


def test_sleeper_source_times_all_missing():
    r = ms.sleeper_source_times(b'[{"a": 1}, {"b": 2}]')
    assert r["source_updated_at_count"] == 0
    assert r["source_updated_at_min"] is None and r["source_updated_at_max"] is None


def test_sleeper_source_times_not_list():
    with pytest.raises(ValueError):
        ms.sleeper_source_times(b'{"a": 1}')


# 3. write_capture
def test_write_capture(tmp_path):
    raw = b'[{"a": 1}]'
    d1, d2 = tmp_path / "d1", tmp_path / "d2"
    line = ms.write_capture(d1, "sleeper", 2026, 5, T0, raw, {"k": "v"})
    ms.write_capture(d2, "sleeper", 2026, 5, T0, raw, {"k": "v"})
    rel = "sleeper/2026/w05/2026-10-14T21-05-09Z.json.gz"
    assert line["path"] == rel
    assert gzip.decompress((d1 / rel).read_bytes()) == raw
    assert (d1 / rel).read_bytes() == (d2 / rel).read_bytes()
    lines = (d1 / "sleeper" / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    m = json.loads(lines[0])
    assert m["retrieved_at"] == "2026-10-14T21:05:09Z"
    assert m["sha256"] == hashlib.sha256(raw).hexdigest()
    assert (m["season"], m["week"], m["path"], m["k"]) == (2026, 5, rel, "v")

    ms.write_capture(d1, "sleeper", 2026, 5, T0.replace(second=10), raw, {})
    assert len((d1 / "sleeper" / "manifest.jsonl").read_text(encoding="utf-8").splitlines()) == 2

    with pytest.raises(FileExistsError):
        ms.write_capture(d1, "sleeper", 2026, 5, T0, raw, {})
    assert len((d1 / "sleeper" / "manifest.jsonl").read_text(encoding="utf-8").splitlines()) == 2


# 4. main
LINES_PAYLOAD = json.dumps([{"game_id": "a"}, {"game_id": "b"}, {"game_id": "c"}]).encode()


@pytest.fixture
def env(tmp_path, monkeypatch):
    weekly = _weekly(tmp_path)
    dest = tmp_path / "dest"
    dest.mkdir()
    monkeypatch.setitem(sys.modules, "nflreadpy", types.SimpleNamespace(__version__="0.0-test"))
    monkeypatch.setattr(ms, "http_get", lambda url, timeout=60: (200, json.dumps([{"updated_at": 1789444813187}]).encode()))
    monkeypatch.setattr(ms, "lines_snapshot", lambda season, week: LINES_PAYLOAD)
    return tmp_path, weekly, dest


def _run(weekly, dest):
    return ms.main(["--dest", str(dest), "--weekly", str(weekly), "--published-commit", "abc123"])


def _manifest(dest, kind):
    return [json.loads(x) for x in (dest / kind / "manifest.jsonl").read_text(encoding="utf-8").splitlines()]


def test_main_happy(env):
    tmp, weekly, dest = env
    assert _run(weekly, dest) == 0
    assert len(list(dest.rglob("*.json.gz"))) == 2
    assert len(list((dest / "sleeper" / "2026" / "w05").glob("*.json.gz"))) == 1
    assert len(list((dest / "lines" / "2026" / "w05").glob("*.json.gz"))) == 1
    for kind in ("sleeper", "lines"):
        (m,) = _manifest(dest, kind)
        assert m["published_commit"] == "abc123"
        assert m["published_batch_id"] == "b|x"
        assert m["capture_kind"] == "scheduled"
    (s,) = _manifest(dest, "sleeper")
    assert s["http_status"] == 200 and "/projections/nfl/2026/5?" in s["request_url"]
    (ln,) = _manifest(dest, "lines")
    assert ln["games"] == 3


def test_main_sleeper_503(env, monkeypatch):
    tmp, weekly, dest = env
    monkeypatch.setattr(ms, "http_get", lambda url, timeout=60: (503, b"x"))
    assert _run(weekly, dest) == 1
    assert len(list((dest / "lines").rglob("*.json.gz"))) == 1
    assert not list(dest.rglob("sleeper/**/*.json.gz"))


def test_main_lines_failure(env, monkeypatch):
    tmp, weekly, dest = env

    def boom(season, week):
        raise RuntimeError("nope")

    monkeypatch.setattr(ms, "lines_snapshot", boom)
    assert _run(weekly, dest) == 1
    assert len(list((dest / "sleeper").rglob("*.json.gz"))) == 1
    assert not list(dest.rglob("lines/**/*.json.gz"))


def test_main_writes_only_under_dest(env):
    tmp, weekly, dest = env
    before = {p for p in tmp.rglob("*") if p.is_file()}
    assert _run(weekly, dest) == 0
    created = {p for p in tmp.rglob("*") if p.is_file()} - before
    assert created and all(dest in p.parents for p in created)
    assert weekly in before


# 5. workflow text
def _wf(name: str) -> dict:
    return yaml.safe_load((ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8"))


def test_workflow_structure():
    wf = _wf("market-snapshots.yml")
    on = wf[True]
    assert on["workflow_run"] == {"workflows": ["weekly site update"], "types": ["completed"]}
    assert "workflow_dispatch" in on
    assert wf["permissions"] == {"contents": "read"}
    steps = wf["jobs"]["snapshot"]["steps"]
    (priv,) = [s for s in steps if s.get("with", {}).get("repository") == "mtsilverstein/megatron-private-data"]
    assert priv["with"]["path"] == "private-data"
    assert "secrets.PRIVATE_DATA_TOKEN" in priv["with"]["token"]
    pushers = [s for s in steps if "git push" in s.get("run", "")]
    assert len(pushers) == 1 and pushers[0]["working-directory"] == "private-data"
    assert "workflow_run.conclusion == 'success'" in wf["jobs"]["snapshot"]["if"]


# 6. the listened-to workflow exists
def test_listened_workflow_exists():
    assert _wf("weekly-update.yml")["name"] == "weekly site update"
