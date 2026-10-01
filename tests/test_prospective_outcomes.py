"""Outcome builder (spec §7.6, final review I5): schema, predicted-stat scoring per format, refuses partial seasons."""
import datetime as dt
import json

import pandas as pd
import pytest

from ffmodel.prospective import freeze as F
from ffmodel.prospective import outcomes as O
from ffmodel.scoring import PREDICTED_STATS

TEAMS = ["AAA", "BBB"]
BUILT = dt.datetime(2027, 1, 12, 15, tzinfo=dt.timezone.utc)
SHA = "ab" * 32


def schedule(last=17, scores=True):
    rows = [dict(season=2026, week=w, home_team="AAA", away_team="BBB",
                 home_score=21.0 if scores else float("nan"), away_score=17.0) for w in range(1, last + 1)]
    return pd.DataFrame(rows)


def weekly(last=17, skip=None):
    rows = []
    for w in range(1, last + 1):
        for t, pid, pos in (("AAA", "p1", "RB"), ("BBB", "p2", "WR")):
            if skip == (w, t):
                continue
            r = {c: 0.0 for c in PREDICTED_STATS}
            r.update(season=2026, week=w, team=t, player_id=pid, player_display_name=pid.upper(), position=pos,
                     receptions=5.0, receiving_yards=50.0, rushing_yards=10.0)
            rows.append(r)
    return pd.DataFrame(rows)


def test_schema_weeks_and_per_format_scoring():
    out = O.build_outcomes(weekly(), schedule(), 2026, F.FORMATS, "2027-01-12", BUILT, snapshot_sha256=SHA)
    assert out["schema_version"] == 1 and out["season"] == 2026 and out["as_of"] == "2027-01-12"
    assert out["built_at"] == "2027-01-12T15:00:00+00:00"
    assert set(out["actual_weeks"]) == set(F.FORMATS)
    for label, players in out["actual_weeks"].items():
        assert set(players) == {"p1", "p2"}
        assert set(players["p1"]) == {str(w) for w in range(5, 18)}  # weeks 5..17 only
    # 5 rec + 50 rec yd + 10 rush yd: PPR 5*1 + 5 + 1 = 11.0; half-PPR 2.5 + 6 = 8.5
    assert out["actual_weeks"]["f12-1qb-ppr-6"]["p1"]["5"] == 11.0
    assert out["actual_weeks"]["f12-1qb-half-4"]["p1"]["5"] == 8.5
    json.dumps(out)


def test_refuses_when_a_week_5_to_17_team_is_missing():
    with pytest.raises(O.OutcomesError, match="missing"):
        O.build_outcomes(weekly(skip=(12, "BBB")), schedule(), 2026, F.FORMATS, "2027-01-12", BUILT, snapshot_sha256=SHA)
    with pytest.raises(O.OutcomesError, match="missing"):
        O.build_outcomes(weekly(last=15), schedule(), 2026, F.FORMATS, "2027-01-12", BUILT, snapshot_sha256=SHA)


def test_early_weeks_missing_does_not_matter_but_partial_schedule_does():
    w = weekly()
    w = w[w.week >= 5]
    O.build_outcomes(w, schedule(), 2026, ["f12-1qb-ppr-6"], "2027-01-12", BUILT, snapshot_sha256=SHA)
    with pytest.raises(O.OutcomesError, match="lacks weeks"):
        O.build_outcomes(weekly(), schedule(last=16), 2026, F.FORMATS, "2027-01-12", BUILT, snapshot_sha256=SHA)


def test_refuses_games_without_final_score():
    with pytest.raises(O.OutcomesError, match="final"):
        O.build_outcomes(weekly(), schedule(scores=False), 2026, F.FORMATS, "2027-01-12", BUILT, snapshot_sha256=SHA)


def test_artifact_carries_snapshot_sha():
    out = O.build_outcomes(weekly(), schedule(), 2026, ["f12-1qb-ppr-6"], "2027-01-13", BUILT, snapshot_sha256=SHA)
    assert out["snapshot_sha256"] == SHA and out["as_of"] == "2027-01-13"


# --- astra review I1: capture (window, once) and build (snapshot only, never the network) -----------------------------
def utc(day, hour=15):
    return dt.datetime(2027, 1, day, hour, tzinfo=dt.timezone.utc)


@pytest.fixture
def fetchers(monkeypatch):
    """Offline capture inputs: a raw parquet of the weekly frame, and a schedule. normalize_weekly is the identity."""
    import io
    import ffmodel.data.pull as P
    monkeypatch.setattr(P, "normalize_weekly", lambda df: df)
    buf = io.BytesIO()
    weekly().to_parquet(buf, index=False)
    return dict(fetch_stats=lambda: buf.getvalue(), fetch_schedule=lambda: schedule())


@pytest.mark.parametrize("day", [12, 13, 14])
def test_capture_allowed_in_window_records_as_of_and_hashes(tmp_path, fetchers, day):
    cap = O.capture(2026, tmp_path / "src", utc(day), **fetchers)
    assert cap["as_of"] == f"2027-01-{day}"
    saved = json.loads((tmp_path / "src" / "capture.json").read_text())
    assert saved["stats_sha256"] == F.sha256_file(tmp_path / "src" / O.stats_name(2026))
    assert saved["schedule_sha256"] == F.sha256_file(tmp_path / "src" / O.schedule_name(2026))


@pytest.mark.parametrize("when", [utc(11, 23), utc(15, 0), utc(20)])
def test_capture_refused_outside_window_and_writes_nothing(tmp_path, fetchers, when):
    with pytest.raises(O.OutcomesError, match="only allowed"):
        O.capture(2026, tmp_path / "src", when, **fetchers)
    assert not (tmp_path / "src").exists()


def test_capture_never_overwrites(tmp_path, fetchers):
    O.capture(2026, tmp_path / "src", utc(12), **fetchers)
    before = (tmp_path / "src" / "capture.json").read_bytes()
    with pytest.raises(O.OutcomesError, match="already exists"):
        O.capture(2026, tmp_path / "src", utc(13), **fetchers)
    assert (tmp_path / "src" / "capture.json").read_bytes() == before


def test_capture_of_incomplete_data_writes_nothing_so_a_retry_can_capture(tmp_path, monkeypatch):
    import io
    import ffmodel.data.pull as P
    monkeypatch.setattr(P, "normalize_weekly", lambda df: df)
    buf = io.BytesIO()
    weekly(last=15).to_parquet(buf, index=False)
    with pytest.raises(O.OutcomesError, match="missing"):
        O.capture(2026, tmp_path / "src", utc(12), fetch_stats=lambda: buf.getvalue(), fetch_schedule=lambda: schedule())
    assert not (tmp_path / "src").exists()


def _no_network(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("the build touched the network")
    import ffmodel.data.pull as P
    import urllib.request
    monkeypatch.setattr(O, "_download", boom)
    monkeypatch.setattr(O, "_fetch_schedule", boom)
    monkeypatch.setattr(P, "pull_weekly", boom)
    monkeypatch.setattr(P, "pull_schedules", boom)
    monkeypatch.setattr(urllib.request, "urlopen", boom)


def test_build_uses_only_the_snapshot_and_carries_its_as_of_and_sha(tmp_path, fetchers, monkeypatch):
    O.capture(2026, tmp_path / "src", utc(13), **fetchers)
    _no_network(monkeypatch)
    out = O.build_from_snapshot(2026, tmp_path / "src", utc(20))  # built a week later: as_of is still the capture's
    cap = json.loads((tmp_path / "src" / "capture.json").read_text())
    assert out["as_of"] == "2027-01-13" and out["snapshot_sha256"] == cap["stats_sha256"]
    assert out["built_at"] == "2027-01-20T15:00:00+00:00"
    assert out["actual_weeks"]["f12-1qb-ppr-6"]["p1"]["5"] == 11.0


def test_build_cli_from_snapshot_and_never_overwrites(tmp_path, fetchers, monkeypatch, capsys):
    O.capture(2026, tmp_path / "src", utc(12), **fetchers)
    _no_network(monkeypatch)
    out = tmp_path / "o.json"
    assert O.main(["build", "--season", "2026", "--source-dir", str(tmp_path / "src"), "--out", str(out),
                   "--now", "2027-01-30T00:00:00+00:00"]) == 0
    assert json.loads(out.read_text())["as_of"] == "2027-01-12"
    assert O.main(["build", "--season", "2026", "--source-dir", str(tmp_path / "src"), "--out", str(out)]) == 1
    assert "never overwritten" in capsys.readouterr().err


def test_late_fresh_build_cannot_produce_a_window_label(tmp_path, monkeypatch, capsys):
    # the January 12 job never ran; an operator runs capture+build on January 20: capture refuses, build has no
    # snapshot, nothing is written, and no 2027-01-12 label can appear.
    _no_network(monkeypatch)
    src, out = tmp_path / "src", tmp_path / "o.json"
    assert O.main(["capture", "--season", "2026", "--source-dir", str(src), "--now", "2027-01-20T15:00:00+00:00"]) == 1
    assert "only allowed" in capsys.readouterr().err
    assert O.main(["build", "--season", "2026", "--source-dir", str(src), "--out", str(out),
                   "--now", "2027-01-20T15:00:00+00:00"]) == 1
    assert "not evaluated" in capsys.readouterr().err
    assert not out.exists() and not src.exists()


def test_build_refuses_a_tampered_snapshot_or_out_of_window_as_of(tmp_path, fetchers, monkeypatch):
    O.capture(2026, tmp_path / "src", utc(12), **fetchers)
    _no_network(monkeypatch)
    f = tmp_path / "src" / O.stats_name(2026)
    f.write_bytes(f.read_bytes() + b"x")
    with pytest.raises(O.OutcomesError, match="does not match"):
        O.build_from_snapshot(2026, tmp_path / "src", utc(13))
    cp = tmp_path / "src" / "capture.json"
    cap = json.loads(cp.read_text()); cap["as_of"] = "2027-01-20"; cp.write_text(json.dumps(cap))
    with pytest.raises(O.OutcomesError, match="not a valid capture"):
        O.build_from_snapshot(2026, tmp_path / "src", utc(21))
