"""Freeze guard + manifest tests (spec §7). Heavy steps are stubbed behind one injectable Steps object."""
import datetime as dt
import hashlib
import json
import shutil

import pandas as pd
import pytest

from ffmodel.prospective import freeze as F

UTC = dt.timezone.utc
# Week 5 earliest kickoff: Thu 2026-10-08 20:15 ET = 2026-10-09T00:15Z
SCHED_ROWS = [
    # week, gameday, gametime, home, away
    (1, "2026-09-10", "20:20", "AAA", "BBB"), (1, "2026-09-13", "13:00", "CCC", "DDD"),
    (2, "2026-09-17", "20:15", "BBB", "CCC"), (2, "2026-09-20", "13:00", "DDD", "AAA"),
    (3, "2026-09-24", "20:15", "AAA", "CCC"), (3, "2026-09-27", "13:00", "BBB", "DDD"),
    (4, "2026-10-01", "20:15", "AAA", "DDD"), (4, "2026-10-04", "13:00", "BBB", "CCC"),
    (5, "2026-10-08", "20:15", "AAA", "BBB"), (5, "2026-10-11", "13:00", "CCC", "DDD"),
]


def sched(rows=SCHED_ROWS):
    return pd.DataFrame([dict(season=2026, week=w, gameday=gd, gametime=gt, home_team=h, away_team=a)
                         for w, gd, gt, h, a in rows])


def all_teams(max_week):
    return pd.DataFrame([dict(week=w, team=t) for w in range(1, max_week + 1) for t in "AAA BBB CCC DDD".split()])


class StubSteps:
    def __init__(self, schedule=None, weekly=None, payload_text=None, pip="numpy==2.0.0\ntorch==2.9.0\n",
                 versions=None):
        self.pip, self._versions = pip, versions or {}
        self.reuse = []
        self._sched = sched() if schedule is None else schedule
        self._weekly = all_teams(4) if weekly is None else weekly
        self.payload_text = payload_text
        self.calls = []

    def prefetch(self, season, dest):
        self.calls.append(("prefetch", season))
        (dest / "weekly_stub.parquet").write_bytes(b"weekly-v1")
        self.dest = dest

    def schedule(self, season):
        return self._sched

    def weekly_teams(self, season, data_dir):
        self.guard_dir = data_dir
        return self._weekly

    def export_forecasts(self, season, origin, label, out, data_dir):
        self.calls.append(("export", label))
        self.data_dirs = getattr(self, "data_dirs", []) + [data_dir]
        if getattr(self, "mutate", None):
            self.mutate(data_dir)
        out.write_text(json.dumps({"label": label, "origin": origin}))

    def tags(self, season, week, out, data_dir):
        self.calls.append(("tags", week))
        self.data_dirs = getattr(self, "data_dirs", []) + [data_dir]
        out.write_text(json.dumps({"week": week}))

    def format_payloads(self, out):
        out.write_text(self.payload_text if self.payload_text is not None else "PAYLOADS\n")

    def pip_freeze(self):
        return self.pip

    def materialize(self, season, origin, *, worlds_dir, forecasts_dir, tags, payloads, out, reuse_drafts=None):
        self.calls.append(("materialize", origin))
        self.reuse.append(reuse_drafts)
        assert (forecasts_dir / f"forecasts_2026_o{origin}_f12-1qb-ppr-6.json").is_file()
        assert (worlds_dir / "world_2026_f12-sf-ppr-4.json").is_file()
        assert tags.is_file() and payloads.is_file()
        out.mkdir(parents=True)
        (out / "cells.json").write_text("[]")

    def versions(self):
        return {"node": "v20.0.0", "python": "3.12.0", "git_head": "abc123", "git_dirty": False, **self._versions}


def write(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    base = r / "models" / "prospective" / "2026"
    write(base / "rho.json", '{"rho": 1}')
    write(base / "format_payloads.json", "PAYLOADS\n")
    for label in F.FORMATS:
        write(base / f"world_2026_{label}.json", json.dumps({"label": label}))
        write(r / "configs" / "formats" / f"{label}.yaml", f"label: {label}\n")
    write(r / "site" / "data" / "availability.json", '{"a": 1}')
    write(r / F.MARKET_SNAPSHOT, "player,ecr\nx,1\n")
    for rel in F.REQUIRED_CODE + [F.EVALUATOR, "src/ffmodel/scoring.py", "src/ffmodel/eval/export_origin_forecasts.py",
                                  "src/ffmodel/prospective/outcomes.py"]:
        write(r / rel, f"// {rel}\n")
    for mr in F.MODEL_ROOTS:
        write(r / mr / "through2025" / "model.pt", mr)
    write(r / F.SPEC, "spec text\n")
    write(r / "pyproject.toml", "[project]\n")
    write(r / "requirements-dev.txt", "pytest\n")
    return r


BEFORE = dt.datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
CUTOFF = dt.datetime(2026, 10, 9, 0, 15, tzinfo=UTC)


def run(repo, origin=5, dry=False, now=BEFORE, steps=None):
    return F.run_freeze(2026, origin, dry_run=dry, now=now, steps=steps or StubSteps(), root=repo)


def tree(repo):
    return sorted(p.relative_to(repo).as_posix() for p in (repo / "models" / "prospective").rglob("*"))


def test_cutoff_is_earliest_week_kickoff_in_utc():
    assert F.cutoff_utc(sched(), 2026, 5) == CUTOFF


def test_exit3_at_and_after_cutoff_writes_nothing(repo):
    snap = tree(repo)
    for now in (CUTOFF, CUTOFF + dt.timedelta(hours=3)):
        with pytest.raises(F.FreezeError) as e:
            run(repo, now=now)
        assert e.value.code == 3
    assert tree(repo) == snap


def test_one_second_before_cutoff_passes(repo):
    run(repo, now=CUTOFF - dt.timedelta(seconds=1), steps=StubSteps(weekly=all_teams(4)))


def test_naive_clock_is_ambiguous_exit3(repo):
    with pytest.raises(F.FreezeError) as e:
        run(repo, now=dt.datetime(2026, 10, 7, 12, 0))
    assert e.value.code == 3


def test_exit2_when_origin_week_absent(repo):
    s = StubSteps(schedule=sched([r for r in SCHED_ROWS if r[0] != 5]))
    snap = tree(repo)
    with pytest.raises(F.FreezeError) as e:
        run(repo, steps=s)
    assert e.value.code == 2
    assert tree(repo) == snap


def test_exit4_when_prior_week_game_has_no_stats(repo):
    w = all_teams(4)
    w = w[~((w.week == 3) & (w.team == "DDD"))]
    snap = tree(repo)
    with pytest.raises(F.FreezeError) as e:
        run(repo, steps=StubSteps(weekly=w))
    assert e.value.code == 4
    assert tree(repo) == snap


def test_exit4_when_weekly_only_through_week3(repo):
    with pytest.raises(F.FreezeError) as e:
        run(repo, steps=StubSteps(weekly=all_teams(3)))
    assert e.value.code == 4


def test_dry_run_reports_passed_cutoff_but_runs(repo):
    # origin 4 cutoff = 2026-10-02T00:15Z; "now" after it must still run for a dry run
    now = dt.datetime(2026, 10, 3, tzinfo=UTC)
    with pytest.raises(F.FreezeError) as e:
        run(repo, origin=4, now=now, steps=StubSteps(weekly=all_teams(3)))
    assert e.value.code == 3  # the same clock is refused for a real run
    run(repo, origin=4, dry=True, now=now, steps=StubSteps(weekly=all_teams(3)))
    m = json.loads((repo / "models/prospective/2026/dryrun-o4/manifest.json").read_text())
    assert m["dry_run"] is True and m["cutoff_passed_at_now"] is True
    assert m["cutoff_utc"] == "2026-10-02T00:15:00+00:00"


def test_dry_run_allows_missing_evaluator_real_run_does_not(repo):
    (repo / F.EVALUATOR).unlink()
    with pytest.raises(F.FreezeError) as e:
        run(repo)
    assert e.value.code == 9
    assert not (repo / "models/prospective/2026/o5").exists()  # cleaned up
    run(repo, origin=4, dry=True, steps=StubSteps(weekly=all_teams(3)))
    m = json.loads((repo / "models/prospective/2026/dryrun-o4/manifest.json").read_text())
    assert m["code"][F.EVALUATOR] is None


def test_existing_target_refused_and_untouched(repo):
    run(repo)
    before = (repo / "models/prospective/2026/o5/manifest.json").read_bytes()
    with pytest.raises(F.FreezeError) as e:
        run(repo)
    assert e.value.code == 6
    assert (repo / "models/prospective/2026/o5/manifest.json").read_bytes() == before


def test_step_order_and_layout(repo):
    s = StubSteps()
    run(repo, steps=s)
    kinds = [c[0] for c in s.calls]
    assert kinds == ["prefetch"] + ["export"] * 5 + ["tags", "materialize"]
    assert [c[1] for c in s.calls if c[0] == "export"] == F.FORMATS
    assert ("tags", 4) in s.calls
    o5 = repo / "models/prospective/2026/o5"
    for rel in ["inputs/rho.json", "inputs/availability.json", "inputs/format_payloads.json",
                "inputs/configs/f12-1qb-ppr-6.yaml", "inputs/worlds/world_2026_f12-sf-ppr-4.json",
                "inputs/market/fantasypros_ecr_2026-09-08.csv", "decisions/cells.json", "tags_w4.json"]:
        assert (o5 / rel).is_file(), rel


def test_manifest_lists_every_file_with_correct_hashes(repo):
    digest = run(repo)
    o5 = repo / "models/prospective/2026/o5"
    body = (o5 / "manifest.json").read_bytes()
    assert hashlib.sha256(body).hexdigest() == digest
    m = json.loads(body)
    on_disk = {p.relative_to(o5).as_posix() for p in o5.rglob("*") if p.is_file() and p.name != "manifest.json"}
    assert set(m["files"]) == on_disk
    for rel, h in m["files"].items():
        assert h == F.sha256_norm(o5 / rel)
    for rel, h in {**m["code"], **m["models"], **m["dependencies"]}.items():
        assert h == F.sha256_norm(repo / rel)
    assert m["hash_rule"] == F.HASH_RULE and m["hash_rule"].startswith("sha256; CRLF->LF for .js")
    # the whole Python pipeline is hashed, not just the listed files
    assert {"src/ffmodel/scoring.py", "src/ffmodel/eval/export_origin_forecasts.py",
            "src/ffmodel/prospective/outcomes.py"} <= set(m["code"])
    assert "inputs/pip_freeze.txt" in m["files"] and "inputs/schedule_2026.csv" in m["files"]
    assert set(F.REQUIRED_CODE + [F.EVALUATOR]) <= set(m["code"])
    assert len(m["models"]) == 3 and "requirements-dev.txt" in m["dependencies"]
    assert m["spec"] == {"path": F.SPEC, "sha256": F.sha256_norm(repo / F.SPEC)}
    assert m["versions"]["git_head"] == "abc123" and m["versions"]["node"] == "v20.0.0"
    assert m["cutoff_utc"] == "2026-10-09T00:15:00+00:00" and m["cutoff_passed_at_now"] is False


def test_manifest_deterministic_apart_from_clock_fields(repo):
    run(repo, now=BEFORE)
    a = json.loads((repo / "models/prospective/2026/o5/manifest.json").read_text())
    shutil.rmtree(repo / "models/prospective/2026/o5")
    run(repo, now=BEFORE + dt.timedelta(hours=5))
    b = json.loads((repo / "models/prospective/2026/o5/manifest.json").read_text())
    assert a["started_at"] != b["started_at"] and a["built_at"] != b["built_at"]
    for k in ("started_at", "built_at"):
        a.pop(k), b.pop(k)
    assert a == b


def test_payload_drift_exit7_and_cleanup(repo):
    with pytest.raises(F.FreezeError) as e:
        run(repo, steps=StubSteps(payload_text="DRIFTED\n"))
    assert e.value.code == 7
    assert not (repo / "models/prospective/2026/o5").exists()


def test_missing_world_exit7(repo):
    (repo / "models/prospective/2026/world_2026_f12-sf-ppr-4.json").unlink()
    with pytest.raises(F.FreezeError) as e:
        run(repo)
    assert e.value.code == 7


def _origin9(repo):
    wk17 = pd.DataFrame([dict(season=2026, week=w, gameday=f"2026-11-{w:02d}", gametime="13:00",
                              home_team=h, away_team=a) for w in range(1, 10)
                         for h, a in (("AAA", "BBB"), ("CCC", "DDD"))])
    return StubSteps(schedule=wk17, weekly=pd.DataFrame(
        [dict(week=w, team=t) for w in range(1, 9) for t in ("AAA", "BBB", "CCC", "DDD")]))


O9_NOW = dt.datetime(2026, 10, 7, tzinfo=UTC)
O5DIR = "models/prospective/2026/o5"
O9DIR = "models/prospective/2026/o9"


def test_origin9_requires_origin5_and_identical_inputs(repo):
    with pytest.raises(F.FreezeError) as e:  # no o5 yet (and no contingency flag)
        run(repo, origin=9, now=O9_NOW, steps=_origin9(repo))
    assert e.value.code == 5
    run(repo, origin=5)
    run(repo, origin=9, now=O9_NOW, steps=_origin9(repo))  # identical inputs
    shutil.rmtree(repo / O9DIR)
    for changed in ("models/prospective/2026/rho.json",
                    "models/prospective/2026/world_2026_f12-1qb-ppr-6.json",
                    "configs/formats/f10-1qb-ppr-6.yaml"):
        orig = (repo / changed).read_text()
        write(repo / changed, orig + " ")
        with pytest.raises(F.FreezeError) as e:
            run(repo, origin=9, now=O9_NOW, steps=_origin9(repo))
        assert e.value.code == 5, changed
        write(repo / changed, orig)
        assert not (repo / O9DIR).exists()


def test_origin9_uses_o5_availability_bytes_and_never_refreshes(repo):
    run(repo, origin=5)
    write(repo / "site/data/availability.json", '{"a": 2}')  # refreshed live file must be ignored
    run(repo, origin=9, now=O9_NOW, steps=_origin9(repo))
    assert (repo / O9DIR / "inputs/availability.json").read_bytes() == (repo / O5DIR / "inputs/availability.json").read_bytes()
    assert (repo / O9DIR / "inputs/availability.json").read_text() == '{"a": 1}'


def test_origin9_refuses_if_o5_availability_tampered(repo):
    run(repo, origin=5)
    write(repo / O5DIR / "inputs/availability.json", '{"a": 99}')
    with pytest.raises(F.FreezeError) as e:
        run(repo, origin=9, now=O9_NOW, steps=_origin9(repo))
    assert e.value.code == 5
    assert not (repo / O9DIR).exists()


@pytest.mark.parametrize("changed", ["site/assets/rostersim.js", "tools/prospective_materialize.cjs",
                                     F.EVALUATOR, "models/transformer/v1_s43/through2025/model.pt",
                                     "src/ffmodel/scoring.py", "src/ffmodel/eval/export_origin_forecasts.py"])
def test_origin9_refuses_when_engine_code_or_model_changed_since_o5(repo, changed):
    run(repo, origin=5)
    write(repo / changed, "changed after o5\n")
    with pytest.raises(F.FreezeError) as e:
        run(repo, origin=9, now=O9_NOW, steps=_origin9(repo))
    assert e.value.code == 5
    assert not (repo / O9DIR).exists()  # nothing written


def test_origin9_refuses_when_o5_had_an_extra_input(repo):
    run(repo, origin=5)
    m = json.loads((repo / O5DIR / "manifest.json").read_text())
    m["files"]["inputs/extra.json"] = "0" * 64
    (repo / O5DIR / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(F.FreezeError) as e:
        run(repo, origin=9, now=O9_NOW, steps=_origin9(repo))
    assert e.value.code == 5


def test_contingency_allowed_without_o5_and_marked_exploratory(repo):
    F.run_freeze(2026, 9, dry_run=False, now=O9_NOW, steps=_origin9(repo), root=repo, contingency=True)
    m = json.loads((repo / O9DIR / "manifest.json").read_text())
    assert m["exploratory"] is True and m["reason"] == "origin-5 freeze missed"
    assert (repo / O9DIR / "inputs/availability.json").read_text() == '{"a": 1}'  # fresh from site
    # a later o5 can never be frozen
    with pytest.raises(F.FreezeError) as e:
        run(repo, origin=5)
    assert e.value.code == 5
    assert not (repo / O5DIR).exists()


def test_contingency_refused_when_o5_exists_or_wrong_origin(repo):
    run(repo, origin=5)
    with pytest.raises(F.FreezeError) as e:
        F.run_freeze(2026, 9, dry_run=False, now=O9_NOW, steps=_origin9(repo), root=repo, contingency=True)
    assert e.value.code == 5
    assert not (repo / O9DIR).exists()
    with pytest.raises(F.FreezeError) as e:
        F.run_freeze(2026, 5, dry_run=False, now=BEFORE, steps=StubSteps(), root=repo, contingency=True)
    assert e.value.code == 5


def test_normal_manifest_is_not_exploratory(repo):
    run(repo)
    assert json.loads((repo / O5DIR / "manifest.json").read_text())["exploratory"] is False


def test_post_build_cutoff_abort_writes_nothing(repo):
    times = iter([CUTOFF + dt.timedelta(minutes=1)])  # the build "took" until after the cutoff
    snap = tree(repo)
    with pytest.raises(F.FreezeError) as e:
        F.run_freeze(2026, 5, dry_run=False, now=BEFORE, steps=StubSteps(), root=repo, clock=lambda: next(times))
    assert e.value.code == 3
    assert tree(repo) == snap


def test_post_build_records_started_and_built_and_dry_run_tolerates_late_build(repo):
    built = BEFORE + dt.timedelta(minutes=7)
    F.run_freeze(2026, 5, dry_run=False, now=BEFORE, steps=StubSteps(), root=repo, clock=lambda: built)
    m = json.loads((repo / O5DIR / "manifest.json").read_text())
    assert m["started_at"] == BEFORE.isoformat() and m["built_at"] == built.isoformat()
    F.run_freeze(2026, 4, dry_run=True, now=BEFORE, steps=StubSteps(weekly=all_teams(3)), root=repo,
                 clock=lambda: CUTOFF + dt.timedelta(days=1))  # dry run reports, does not abort


def test_now_refused_on_real_run_unless_test_env(monkeypatch, capsys):
    called = []
    monkeypatch.setattr(F, "run_freeze", lambda *a, **k: called.append(k) or "beef")
    monkeypatch.delenv("FREEZE_ALLOW_NOW", raising=False)
    assert F.main(["--season", "2026", "--origin", "5", "--now", "2026-10-07T12:00:00Z"]) == 3
    assert not called and "--dry-run" in capsys.readouterr().err
    assert F.main(["--season", "2026", "--origin", "4", "--dry-run", "--now", "2026-10-07T12:00:00Z"]) == 0
    monkeypatch.setenv("FREEZE_ALLOW_NOW", "1")
    assert F.main(["--season", "2026", "--origin", "5", "--now", "2026-10-07T12:00:00Z"]) == 0


def test_cli_contingency_flag_is_passed_through(monkeypatch):
    seen = {}
    monkeypatch.setattr(F, "run_freeze", lambda *a, **k: seen.update(k) or "beef")
    assert F.main(["--season", "2026", "--origin", "9", "--contingency-origin9-only"]) == 0
    assert seen["contingency"] is True and seen["now"] is None


def test_cli_returns_exit_codes(monkeypatch, capsys):
    def boom(*a, **k):
        raise F.FreezeError(3, "nope")
    monkeypatch.setattr(F, "run_freeze", boom)
    assert F.main(["--season", "2026", "--origin", "5"]) == 3
    assert F.main(["--season", "2026", "--origin", "5", "--now", "not-a-date"]) == 3
    monkeypatch.setattr(F, "run_freeze", lambda *a, **k: "deadbeef")
    assert F.main(["--season", "2026", "--origin", "5"]) == 0
    assert "MANIFEST_SHA256=deadbeef" in capsys.readouterr().out


def test_prefetch_retries_transient_failures_then_succeeds(tmp_path, monkeypatch):
    import ffmodel.data.pull as P
    from ffmodel.prospective.freeze import Steps
    fails = {"n": 2}
    def flaky(*a, **k):
        if fails["n"]:
            fails["n"] -= 1
            raise ConnectionError("500 Server Error")
    monkeypatch.setattr(P, "pull_weekly", flaky)
    monkeypatch.setattr(P, "pull_schedules", lambda *a, **k: None)
    monkeypatch.setattr(P, "pull_injuries", lambda *a, **k: None)
    slept = []
    Steps(tmp_path).prefetch(2026, tmp_path / "snap", sleep=slept.append)
    assert slept == [30, 60]


def test_prefetch_gives_up_with_exit_8(tmp_path, monkeypatch):
    import ffmodel.data.pull as P
    from ffmodel.prospective.freeze import FreezeError, Steps
    def down(*a, **k):
        raise ConnectionError("500 Server Error")
    monkeypatch.setattr(P, "pull_weekly", down)
    with pytest.raises(FreezeError) as e:
        Steps(tmp_path).prefetch(2026, tmp_path / "snap", sleep=lambda s: None)
    assert e.value.code == 8 and "4 attempts" in str(e.value)


def test_hash_rule_crlf_lf_binary(tmp_path):
    lf, crlf = tmp_path / "a.js", tmp_path / "b.js"
    lf.write_bytes(b"line1\nline2\n")
    crlf.write_bytes(b"line1\r\nline2\r\n")
    assert F.sha256_norm(lf) == F.sha256_norm(crlf) == hashlib.sha256(b"line1\nline2\n").hexdigest()
    (tmp_path / "c.JSON").write_bytes(b"{}\r\n")  # extension match is case-insensitive
    assert F.sha256_norm(tmp_path / "c.JSON") == hashlib.sha256(b"{}\n").hexdigest()
    b1, b2 = tmp_path / "m.pt", tmp_path / "n.pt"
    b1.write_bytes(b"\x00\r\n\x01")
    b2.write_bytes(b"\x00\n\x01")
    assert F.sha256_norm(b1) == hashlib.sha256(b"\x00\r\n\x01").hexdigest()  # binary: raw bytes
    assert F.sha256_norm(b1) != F.sha256_norm(b2)


def test_pip_freeze_normalization_drops_own_line_only():
    raw = ("# Editable install with no version control (ffmodel==0.1.0)\n-e C:\\x\\Megatron\n"
           "numpy==2.0.0\n-e git+https://h/r@abc#egg=ffmodel\nffmodel @ file:///x\ntorch==2.9.0\n")
    assert F.normalize_pip_freeze(raw) == "-e C:\\x\\Megatron\nnumpy==2.0.0\ntorch==2.9.0\n"
    assert F.normalize_pip_freeze("ffmodel==0.1.0\nnumpy==2.0.0\n") == "numpy==2.0.0\n"


def test_o5_records_schedule_and_pip_freeze(repo):
    run(repo)
    o5 = repo / O5DIR
    assert (o5 / "inputs/pip_freeze.txt").read_text() == "numpy==2.0.0\ntorch==2.9.0\n"
    assert (o5 / "inputs/schedule_2026.csv").read_text().splitlines()[0] == "season,week,gameday,gametime,home_team,away_team"


def test_origin9_refuses_on_pip_drift(repo):
    run(repo, origin=5)
    s = _origin9(repo)
    s.pip = "numpy==2.0.1\ntorch==2.9.0\n"
    with pytest.raises(F.FreezeError) as e:
        run(repo, origin=9, now=O9_NOW, steps=s)
    assert e.value.code == 5 and "inputs" in e.value.msg and not (repo / O9DIR).exists()


@pytest.mark.parametrize("key,val", [("node", "v24.13.0"), ("python", "3.12.99")])
def test_origin9_refuses_on_toolchain_drift(repo, key, val):
    run(repo, origin=5)
    s = _origin9(repo)
    s._versions = {key: val}
    with pytest.raises(F.FreezeError) as e:
        run(repo, origin=9, now=O9_NOW, steps=s)
    assert e.value.code == 5 and key in e.value.msg and not (repo / O9DIR).exists()


def test_origin9_tolerates_schedule_difference_and_reuses_o5_drafts(repo):
    run(repo, origin=5)
    s = _origin9(repo)  # a different schedule than o5's
    run(repo, origin=9, now=O9_NOW, steps=s)
    assert s.reuse == [repo / O5DIR / "decisions"]
    m5 = json.loads((repo / O5DIR / "manifest.json").read_text())
    m9 = json.loads((repo / O9DIR / "manifest.json").read_text())
    assert m5["files"]["inputs/schedule_2026.csv"] != m9["files"]["inputs/schedule_2026.csv"]


def test_o5_and_contingency_do_not_pass_reuse_drafts(repo):
    s5 = StubSteps()
    run(repo, origin=5, steps=s5)
    assert s5.reuse == [None]
    sc = _origin9(repo)
    shutil.rmtree(repo / O5DIR)
    F.run_freeze(2026, 9, dry_run=False, now=O9_NOW, steps=sc, root=repo, contingency=True)
    assert sc.reuse == [None]


def test_real_steps_materialize_command_passes_reuse_flag(tmp_path, monkeypatch):
    seen = []
    st = F.Steps(tmp_path)
    monkeypatch.setattr(st, "_run", lambda cmd, what: seen.append(cmd) or "")
    kw = dict(worlds_dir=tmp_path, forecasts_dir=tmp_path, tags=tmp_path, payloads=tmp_path, out=tmp_path)
    st.materialize(2026, 5, **kw)
    st.materialize(2026, 9, reuse_drafts=tmp_path / "d", **kw)
    assert "--reuse-drafts" not in seen[0]
    assert seen[1][seen[1].index("--reuse-drafts") + 1] == str(tmp_path / "d")


# --- astra review I3 (rounds 1-2): the guard and every exporter consume ONE isolated, frozen per-run snapshot ------
def _real_pull_world(monkeypatch, *, snap_weeks, live_weeks):
    """Patch the three pulls with a TTL-less on-disk cache keyed like the real one; a miss 'downloads' `snap_weeks`
    (into whatever cache_dir is asked for). `live_weeks` is what a separate live source would return."""
    import ffmodel.data.pull as P

    def frame(n):
        d = all_teams(n)
        d["season"] = 2026
        return d
    calls = []

    def fake(seasons, cache_dir=None):
        calls.append(cache_dir)
        if cache_dir is None:
            return frame(live_weeks)
        p = cache_dir / f"{P._cache_name('weekly_v2', seasons)}.parquet"
        if p.exists():
            return pd.read_parquet(p)
        cache_dir.mkdir(parents=True, exist_ok=True)
        df = frame(snap_weeks)
        df.to_parquet(p, index=False)
        return df
    monkeypatch.setattr(P, "pull_weekly", fake)
    monkeypatch.setattr(P, "pull_schedules", lambda *a, **k: None)
    monkeypatch.setattr(P, "pull_injuries", lambda *a, **k: None)
    return calls


def test_prefetch_pulls_into_the_given_snapshot_dir_and_never_touches_shared_cache(tmp_path, monkeypatch):
    import ffmodel.data.pull as P
    root = tmp_path / "root"
    shared = root / "data" / "raw"
    shared.mkdir(parents=True)
    keep = shared / f"{P._cache_name('weekly_v2', list(range(F.HISTORY_FIRST_SEASON, 2027)))}.parquet"
    keep.write_bytes(b"another run file")
    _real_pull_world(monkeypatch, snap_weeks=4, live_weeks=4)
    snap = tmp_path / "snap"
    F.Steps(root).prefetch(2026, snap, sleep=lambda s: None)
    assert any(snap.iterdir())
    assert keep.read_bytes() == b"another run file" and [p.name for p in shared.iterdir()] == [keep.name]


def test_guard_validates_the_snapshot_frame_not_a_live_source(tmp_path, monkeypatch):
    # snapshot lacks week 4; a separate live source has it. The guard reads the snapshot, so it refuses.
    calls = _real_pull_world(monkeypatch, snap_weeks=3, live_weeks=4)
    snap = tmp_path / "snap"
    steps = F.Steps(tmp_path / "root")
    steps.prefetch(2026, snap, sleep=lambda s: None)
    with pytest.raises(F.FreezeError) as e:
        F.check_fresh(sched(), steps.weekly_teams(2026, snap), 2026, 5)
    assert e.value.code == 4
    assert all(cd is not None for cd in calls)


def test_run_freeze_refuses_when_snapshot_lacks_a_team_week_even_if_live_has_it(repo, monkeypatch):
    _real_pull_world(monkeypatch, snap_weeks=3, live_weeks=4)

    class RealGuard(StubSteps):  # real prefetch + weekly_teams (patched pulls), stubbed everything else
        def prefetch(self, season, dest):
            self.dest = dest
            F.Steps(repo).prefetch(season, dest, sleep=lambda s: None)

        def weekly_teams(self, season, data_dir):
            return F.Steps(repo).weekly_teams(season, data_dir)

    st = RealGuard()
    with pytest.raises(F.FreezeError) as e:
        run(repo, steps=st)
    assert e.value.code == 4
    assert not (repo / "models" / "prospective" / "2026" / "o5").exists()
    assert not st.dest.exists()


def test_freeze_passes_snapshot_dir_to_every_exporter_and_tags_and_guard(repo):
    st = StubSteps()
    run(repo, steps=st)
    assert len(st.data_dirs) == 6 and len(set(st.data_dirs)) == 1
    assert st.data_dirs[0] == st.dest == st.guard_dir
    assert st.dest != repo / "data" / "raw"


def test_real_steps_run_exporters_and_tags_with_data_dir_and_frozen_env(tmp_path, monkeypatch):
    seen = []
    st = F.Steps(tmp_path)
    monkeypatch.setattr(st, "_run", lambda cmd, what, env=None: seen.append((cmd, env)) or "")
    snap = tmp_path / "snap"
    st.export_forecasts(2026, 5, "f12-1qb-ppr-6", tmp_path / "o.json", snap)
    st.tags(2026, 4, tmp_path / "t.json", snap)
    assert len(seen) == 2
    for cmd, env in seen:
        assert cmd[cmd.index("--data-dir") + 1] == str(snap)
        assert env == {"FFMODEL_CACHE_FROZEN": "1"}


def test_run_helper_merges_frozen_env_into_the_subprocess_env(tmp_path, monkeypatch):
    got = {}

    def fake_run(cmd, **kw):
        got.update(kw)

        class R:
            returncode, stdout, stderr = 0, "", ""
        return R()
    monkeypatch.setattr(F.subprocess, "run", fake_run)
    F.Steps(tmp_path)._run(["x"], "x", env=F.FROZEN_ENV)
    assert got["env"]["FFMODEL_CACHE_FROZEN"] == "1"


@pytest.mark.parametrize("how", ["changed", "added", "removed"])
def test_snapshot_drift_during_build_exits_4_and_commits_nothing(repo, how):
    st = StubSteps()

    def mutate(d):
        if how == "changed":
            (d / "weekly_stub.parquet").write_bytes(b"weekly-v2")
        elif how == "added":
            (d / "extra.parquet").write_bytes(b"x")
        else:
            (d / "weekly_stub.parquet").unlink(missing_ok=True)
    st.mutate = mutate
    snap = tree(repo)
    with pytest.raises(F.FreezeError) as e:
        run(repo, steps=st)
    assert e.value.code == 4 and "drifted" in e.value.msg
    assert tree(repo) == snap
    assert not st.dest.exists()


def test_snapshot_dir_is_removed_after_success_and_failure_and_hashed_in_manifest(repo):
    st = StubSteps()
    run(repo, steps=st)
    assert not st.dest.exists()
    man = json.loads((repo / "models/prospective/2026/o5/manifest.json").read_text())
    assert man["inputs_snapshot"] == {"weekly_stub.parquet": hashlib.sha256(b"weekly-v1").hexdigest()}
    bad = StubSteps(weekly=all_teams(3))
    with pytest.raises(F.FreezeError):
        run(repo, origin=5, dry=True, steps=bad)
    assert not bad.dest.exists()


def test_freeze_never_writes_or_deletes_the_shared_data_raw(repo):
    shared = repo / "data" / "raw"
    shared.mkdir(parents=True)
    (shared / "weekly_v2_2012_2026.parquet").write_bytes(b"shared")
    before = {p.name: p.read_bytes() for p in shared.iterdir()}
    run(repo, steps=StubSteps())
    assert {p.name: p.read_bytes() for p in shared.iterdir()} == before
