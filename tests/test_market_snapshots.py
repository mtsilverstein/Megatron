"""Market-snapshot collector: synthetic, network-free tests."""
from __future__ import annotations

import gzip
import hashlib
import json
import sys
import types
from datetime import datetime, timedelta, timezone
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
    monkeypatch.delenv("SHARPAPI_KEY", raising=False)   # never let a developer's real key reach the network here
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


# 4b. SharpAPI props (synthetic: invented teams, players and prices; no real odds in this public repo)
NOW = datetime(2026, 10, 15, 17, 30, tzinfo=timezone.utc)


def _event(eid, home, away, start, books=("draftkings", "fanduel"), etype="fixture", status="upcoming", markets=50):
    return {"id": eid, "home_team": home, "away_team": away, "start_time": start, "event_type": etype,
            "status": status, "books": list(books), "market_count": markets, "league": "nfl"}


def _prop(market, book="draftkings", segment=None, player="Test Player"):
    return {"market_type": market, "sportsbook": book, "market_segment": segment, "player_name": player,
            "selection": "Over", "line": 10.5, "odds_american": -110, "is_alternate_line": False}


def test_select_games_window_dedupe_and_books():
    events = [
        _event("a_b3", "Home A", "Away A", "2026-10-16T00:15:00Z", markets=900),          # in window
        _event("a_b0", "Home A", "Away A", "2026-10-16T00:15:00Z", books=("onexbet",)),  # no free book
        _event("a_dup", "Home A", "Away A", "2026-10-16T00:15:00Z", markets=40),         # duplicate feed
        _event("late", "Home B", "Away B", "2026-10-18T18:00:00Z"),                       # 72.5 h out
        _event("edge", "Home C", "Away C", "2026-10-18T17:30:00Z"),                       # exactly 72 h: in
        _event("past", "Home D", "Away D", "2026-10-15T17:00:00Z"),                       # started
        _event("fut", "AFC Winner", "", "2026-10-16T00:15:00Z", etype="outright"),
        _event("live", "Home E", "Away E", "2026-10-15T18:00:00Z", status="live"),
    ]
    got = ms.select_prop_games(events, NOW, window_hours=72)
    assert [e["id"] for e in got] == ["a_b3", "edge"]


def test_filter_props_keeps_full_game_offensive_markets_only():
    rows = [_prop("player_receiving_yards"), _prop("anytime_touchdown_scorer", "fanduel"),
            _prop("player_receiving_yards", segment="1st_half"), _prop("player_tackles"),
            _prop("point_spread"), _prop("player_passing_attempts", "fanduel")]
    raw = json.dumps({"data": rows, "updated_at": "x"}).encode()
    kept, counts = ms.filter_props(raw)
    assert [r["market_type"] for r in json.loads(kept)] == ["player_receiving_yards", "anytime_touchdown_scorer",
                                                           "player_passing_attempts"]
    assert counts == {"rows_total": 6, "rows_kept": 3,
                      "kept_by_market_book": {"anytime_touchdown_scorer|fanduel": 1,
                                              "player_passing_attempts|fanduel": 1,
                                              "player_receiving_yards|draftkings": 1}}


def test_filter_props_rejects_bad_payload():
    with pytest.raises(ValueError):
        ms.filter_props(b'{"nope": 1}')


def test_write_capture_name_suffix(tmp_path):
    a = ms.write_capture(tmp_path, "props", 2026, 6, T0, b"[]", {}, name="game_one")
    b = ms.write_capture(tmp_path, "props", 2026, 6, T0, b"[]", {}, name="game_two")
    assert a["path"] == "props/2026/w06/2026-10-14T21-05-09Z_game_one.json.gz"
    assert b["path"].endswith("_game_two.json.gz")
    with pytest.raises(ValueError):
        ms.write_capture(tmp_path, "props", 2026, 6, T0, b"[]", {}, name="../escape")


class FakeSharp:
    """Records every request; serves a two-page events list and per-event odds."""

    def __init__(self, events, odds_status=200, status_by_event=None):
        self.calls, self.events, self.odds_status = [], events, odds_status
        self.status_by_event = status_by_event or {}

    def __call__(self, path, params, key, timeout=60):
        self.calls.append((path, dict(params)))
        assert key == "k-test"
        if path == "/events":
            off = int(params.get("offset", 0))
            page = self.events[off:off + 2]
            more = off + 2 < len(self.events)
            body = {"data": page, "pagination": {"has_more": more, "next_offset": off + 2}}
            return 200, json.dumps(body).encode()
        rows = [_prop("player_rushing_yards"), _prop("player_tackles")]
        eid = path.split("/")[2]
        return self.status_by_event.get(eid, self.odds_status), json.dumps({"data": rows}).encode()


@pytest.fixture
def props_env(env, monkeypatch):
    tmp, weekly, dest = env
    weekly.write_text(json.dumps({"season": 2026, "week": 6, "batch_id": "b|y"}), encoding="utf-8")
    events = [_event("g1", "Home A", "Away A", "2026-10-16T00:15:00Z"),
              _event("fut", "AFC Winner", "", "2026-10-16T00:15:00Z", etype="outright"),
              _event("g2", "Home B", "Away B", "2026-10-18T17:00:00Z")]
    fake = FakeSharp(events)
    monkeypatch.setattr(ms, "sharp_get", fake)
    monkeypatch.setattr(ms, "_now", lambda: NOW)
    monkeypatch.setattr(ms, "_pause", lambda s: None)
    monkeypatch.setenv("SHARPAPI_KEY", "k-test")
    return tmp, weekly, dest, fake


def test_main_props_happy(props_env):
    tmp, weekly, dest, fake = props_env
    assert _run(weekly, dest) == 0
    files = sorted(p.name for p in (dest / "props" / "2026" / "w06").glob("*.json.gz"))
    assert files == ["2026-10-15T17-30-00Z_g1.json.gz", "2026-10-15T17-30-00Z_g2.json.gz"]
    m = _manifest(dest, "props")
    assert [x["event_id"] for x in m] == ["g1", "g2"]
    g1 = m[0]
    assert g1["rows_total"] == 2 and g1["rows_kept"] == 1
    assert g1["request_url"] == "https://api.sharpapi.io/api/v1/events/g1/odds"
    assert "k-test" not in json.dumps(m)
    assert g1["published_commit"] == "abc123" and g1["capture_kind"] == "scheduled"
    assert g1["response_sha256"] != g1["sha256"]
    kept = json.loads(gzip.decompress((dest / g1["path"]).read_bytes()))
    assert [r["market_type"] for r in kept] == ["player_rushing_yards"]
    assert [c[0] for c in fake.calls] == ["/events", "/events", "/events/g1/odds", "/events/g2/odds"]


def test_main_props_without_key_is_a_skip_not_a_failure(props_env, monkeypatch, capsys):
    tmp, weekly, dest, fake = props_env
    monkeypatch.delenv("SHARPAPI_KEY")
    assert _run(weekly, dest) == 0
    assert not (dest / "props").exists() and fake.calls == []
    assert "SHARPAPI_KEY" in capsys.readouterr().out


def test_main_props_failure_is_independent(props_env, monkeypatch):
    tmp, weekly, dest, fake = props_env
    fake.odds_status = 429
    assert _run(weekly, dest) == 1
    assert len(list((dest / "sleeper").rglob("*.json.gz"))) == 1
    assert len(list((dest / "lines").rglob("*.json.gz"))) == 1
    assert not list(dest.rglob("props/**/*.json.gz"))


def test_props_never_logs_the_key(props_env, capsys):
    tmp, weekly, dest, fake = props_env
    _run(weekly, dest)
    out = capsys.readouterr()
    assert "k-test" not in out.out + out.err


def _batches(dest):
    return [json.loads(x) for x in (dest / "props" / "batches.jsonl").read_text(encoding="utf-8").splitlines()]


def test_one_failed_game_does_not_stop_the_others(props_env, monkeypatch):
    tmp, weekly, dest, fake = props_env
    fake.events = [_event("gA", "Home A", "Away A", "2026-10-16T00:15:00Z"),
                   _event("gB", "Home B", "Away B", "2026-10-16T17:00:00Z"),
                   _event("gC", "Home C", "Away C", "2026-10-17T17:00:00Z")]
    fake.status_by_event = {"gB": 503}
    assert _run(weekly, dest) == 1
    assert [x["event_id"] for x in _manifest(dest, "props")] == ["gA", "gC"]
    (b,) = _batches(dest)
    assert b["selected"] == ["gA", "gB", "gC"] and b["captured"] == ["gA", "gC"]
    assert b["failed"] == {"gB": "HTTP 503"} and b["not_attempted"] == [] and b["status"] == "incomplete"
    assert b["published_commit"] == "abc123"


def test_rate_limit_stops_the_batch_and_records_the_rest(props_env):
    tmp, weekly, dest, fake = props_env
    fake.events = [_event("gA", "Home A", "Away A", "2026-10-16T00:15:00Z"),
                   _event("gB", "Home B", "Away B", "2026-10-16T17:00:00Z"),
                   _event("gC", "Home C", "Away C", "2026-10-17T17:00:00Z")]
    fake.status_by_event = {"gA": 429}
    assert _run(weekly, dest) == 1
    (b,) = _batches(dest)
    assert b["captured"] == [] and b["failed"] == {"gA": "HTTP 429"} and b["not_attempted"] == ["gB", "gC"]
    assert [c[0] for c in fake.calls].count("/events/gB/odds") == 0


def test_complete_batch_is_recorded(props_env):
    tmp, weekly, dest, fake = props_env
    assert _run(weekly, dest) == 0
    (b,) = _batches(dest)
    assert b["status"] == "complete" and b["captured"] == ["g1", "g2"] and b["batch_started_at"] == "2026-10-15T17:30:00Z"


def test_game_that_kicks_off_while_queued_is_skipped(props_env, monkeypatch):
    tmp, weekly, dest, fake = props_env
    fake.events = [_event("soon", "Home A", "Away A", "2026-10-15T17:30:05Z"),
                   _event("later", "Home B", "Away B", "2026-10-16T17:00:00Z")]
    clock = iter([NOW, NOW + timedelta(seconds=10), NOW + timedelta(seconds=20), NOW + timedelta(seconds=21)])
    monkeypatch.setattr(ms, "_now", lambda: next(clock))
    assert _run(weekly, dest) == 0
    (b,) = _batches(dest)
    assert b["skipped_started"] == ["soon"] and b["captured"] == ["later"]
    assert "/events/soon/odds" not in [c[0] for c in fake.calls]


@pytest.mark.parametrize("body", [{}, {"error": "x"}, {"data": []}, {"data": [], "pagination": {}},
                                  {"data": [], "pagination": {"has_more": True}},
                                  {"data": [], "pagination": {"has_more": True, "next_offset": 0}},
                                  {"data": [], "pagination": {"has_more": True, "next_offset": True}}])
def test_malformed_events_envelope_is_an_error_not_zero_games(body, monkeypatch):
    monkeypatch.setattr(ms, "sharp_get", lambda path, params, key, timeout=60: (200, json.dumps(body).encode()))
    monkeypatch.setattr(ms, "_pause", lambda s: None)
    with pytest.raises(ValueError):
        ms.list_nfl_events("k-test")


def test_events_failure_is_recorded_and_isolated(props_env, monkeypatch):
    tmp, weekly, dest, fake = props_env
    monkeypatch.setattr(ms, "sharp_get", lambda path, params, key, timeout=60: (200, b"{}"))
    assert _run(weekly, dest) == 1
    (b,) = _batches(dest)
    assert b["status"] == "events_failed" and "data list" in b["error"]
    assert len(list((dest / "sleeper").rglob("*.json.gz"))) == 1


def test_filter_keeps_absent_or_null_segment_and_free_books_only():
    """Live full-game rows omit market_segment entirely; a non-null segment is never kept."""
    absent = {k: v for k, v in _prop("player_receptions").items() if k != "market_segment"}
    rows = [_prop("player_receiving_yards"), absent, _prop("player_rushing_yards", segment="1st_half"),
            _prop("player_rushing_yards", book="betmgm")]
    kept, counts = ms.filter_props(json.dumps({"data": rows}).encode())
    assert [r["market_type"] for r in json.loads(kept)] == ["player_receiving_yards", "player_receptions"]


def test_offset_free_timestamp_is_rejected():
    with pytest.raises(ValueError):
        ms.select_prop_games([_event("x", "H", "A", "2026-10-16T00:15:00")], NOW)


def test_sharp_get_never_follows_a_redirect_with_the_key(monkeypatch):
    """A 302 from the API origin to another server must not be followed: the second server never sees the key."""
    import http.server
    import threading

    seen = []

    class Target(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.headers.get("X-API-Key"))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *a):
            pass

    target = http.server.HTTPServer(("127.0.0.1", 0), Target)

    class Origin(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{target.server_port}/stolen")
            self.end_headers()

        def log_message(self, *a):
            pass

    origin = http.server.HTTPServer(("127.0.0.1", 0), Origin)
    for srv in (target, origin):
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        monkeypatch.setattr(ms, "SHARP_BASE", f"http://127.0.0.1:{origin.server_port}/api/v1")
        status, _ = ms.sharp_get("/events", {}, "k-secret")
        assert status == 302
        assert seen == []
    finally:
        for srv in (target, origin):
            srv.shutdown()
            srv.server_close()


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
    pushers = [s for s in steps if "gitp push" in s.get("run", "")]
    assert len(pushers) == 1 and pushers[0]["working-directory"] == "private-data"
    assert "workflow_run.conclusion == 'success'" in wf["jobs"]["snapshot"]["if"]


def test_workflow_token_hardening():
    """Same credential hardening as the comparator job: the token is never job-level env, no checkout persists a
    credential, the private checkout follows the install, and only the push step's own env carries the token."""
    wf = _wf("market-snapshots.yml")
    job = wf["jobs"]["snapshot"]
    assert "PRIVATE_DATA_TOKEN" not in job.get("env", {})
    steps = job["steps"]
    checkouts = [s for s in steps if str(s.get("uses", "")).startswith("actions/checkout")]
    assert checkouts and all(s["with"]["persist-credentials"] is False for s in checkouts)
    install = next(i for i, s in enumerate(steps) if "pip install" in s.get("run", ""))
    private = next(i for i, s in enumerate(steps) if s.get("with", {}).get("repository"))
    assert install < private
    with_token = [s for s in steps if "PRIVATE_DATA_TOKEN" in s.get("env", {})]
    assert len(with_token) == 1 and "gitp push" in with_token[0]["run"]
    with_key = [s for s in steps if "SHARPAPI_KEY" in s.get("env", {})]
    assert len(with_key) == 1 and "ffmodel.collect.market_snapshots" in with_key[0]["run"]
    assert "secrets.SHARPAPI_KEY" in with_key[0]["env"]["SHARPAPI_KEY"]
    assert "SHARPAPI_KEY" not in job.get("env", {})


def test_workflow_commits_props():
    steps = _wf("market-snapshots.yml")["jobs"]["snapshot"]["steps"]
    (commit,) = [s for s in steps if "gitp push" in s.get("run", "")]
    assert "for d in sleeper lines props" in commit["run"] and 'if [ -d "$d" ]; then git add -- "$d"; fi' in commit["run"]
    assert "2>/dev/null || true" not in commit["run"]


# 6. the listened-to workflow exists
def test_listened_workflow_exists():
    assert _wf("weekly-update.yml")["name"] == "weekly site update"
