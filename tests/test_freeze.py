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
    def __init__(self, schedule=None, weekly=None, payload_text=None):
        self._sched = sched() if schedule is None else schedule
        self._weekly = all_teams(4) if weekly is None else weekly
        self.payload_text = payload_text
        self.calls = []

    def schedule(self, season):
        return self._sched

    def weekly_teams(self, season):
        return self._weekly

    def export_forecasts(self, season, origin, label, out):
        self.calls.append(("export", label))
        out.write_text(json.dumps({"label": label, "origin": origin}))

    def tags(self, season, week, out):
        self.calls.append(("tags", week))
        out.write_text(json.dumps({"week": week}))

    def format_payloads(self, out):
        out.write_text(self.payload_text if self.payload_text is not None else "PAYLOADS\n")

    def materialize(self, season, origin, *, worlds_dir, forecasts_dir, tags, payloads, out):
        self.calls.append(("materialize", origin))
        assert (forecasts_dir / f"forecasts_2026_o{origin}_f12-1qb-ppr-6.json").is_file()
        assert (worlds_dir / "world_2026_f12-sf-ppr-4.json").is_file()
        assert tags.is_file() and payloads.is_file()
        out.mkdir(parents=True)
        (out / "cells.json").write_text("[]")

    def versions(self):
        return {"node": "v20.0.0", "python": "3.12.0", "git_head": "abc123", "git_dirty": False}


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
    for rel in F.REQUIRED_CODE + [F.EVALUATOR]:
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
    assert kinds == ["export"] * 5 + ["tags", "materialize"]
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
        assert h == hashlib.sha256((o5 / rel).read_bytes()).hexdigest()
    for rel, h in {**m["code"], **m["models"], **m["dependencies"]}.items():
        assert h == hashlib.sha256((repo / rel).read_bytes()).hexdigest()
    assert set(F.REQUIRED_CODE + [F.EVALUATOR]) <= set(m["code"])
    assert len(m["models"]) == 3 and "requirements-dev.txt" in m["dependencies"]
    assert m["spec"] == {"path": F.SPEC, "sha256": hashlib.sha256((repo / F.SPEC).read_bytes()).hexdigest()}
    assert m["versions"]["git_head"] == "abc123" and m["versions"]["node"] == "v20.0.0"
    assert m["cutoff_utc"] == "2026-10-09T00:15:00+00:00" and m["cutoff_passed_at_now"] is False


def test_manifest_deterministic_apart_from_now(repo):
    run(repo, now=BEFORE)
    a = json.loads((repo / "models/prospective/2026/o5/manifest.json").read_text())
    shutil.rmtree(repo / "models/prospective/2026/o5")
    run(repo, now=BEFORE + dt.timedelta(hours=5))
    b = json.loads((repo / "models/prospective/2026/o5/manifest.json").read_text())
    assert a["now"] != b["now"]
    a.pop("now"), b.pop("now")
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


def test_origin9_requires_origin5_and_identical_inputs(repo):
    now = dt.datetime(2026, 10, 7, tzinfo=UTC)
    with pytest.raises(F.FreezeError) as e:  # no o5 yet
        run(repo, origin=9, now=now, steps=_origin9(repo))
    assert e.value.code == 5
    run(repo, origin=5)
    run(repo, origin=9, now=now, steps=_origin9(repo))  # identical inputs; availability.json may refresh
    shutil.rmtree(repo / "models/prospective/2026/o9")
    write(repo / "site/data/availability.json", '{"a": 2}')
    run(repo, origin=9, now=now, steps=_origin9(repo))
    shutil.rmtree(repo / "models/prospective/2026/o9")
    for changed in ("models/prospective/2026/rho.json",
                    "models/prospective/2026/world_2026_f12-1qb-ppr-6.json",
                    "configs/formats/f10-1qb-ppr-6.yaml"):
        orig = (repo / changed).read_text()
        write(repo / changed, orig + " ")
        with pytest.raises(F.FreezeError) as e:
            run(repo, origin=9, now=now, steps=_origin9(repo))
        assert e.value.code == 5, changed
        write(repo / changed, orig)
        assert not (repo / "models/prospective/2026/o9").exists()


def test_cli_returns_exit_codes(monkeypatch, capsys):
    def boom(*a, **k):
        raise F.FreezeError(3, "nope")
    monkeypatch.setattr(F, "run_freeze", boom)
    assert F.main(["--season", "2026", "--origin", "5"]) == 3
    assert F.main(["--season", "2026", "--origin", "5", "--now", "not-a-date"]) == 3
    monkeypatch.setattr(F, "run_freeze", lambda *a, **k: "deadbeef")
    assert F.main(["--season", "2026", "--origin", "5"]) == 0
    assert "MANIFEST_SHA256=deadbeef" in capsys.readouterr().out
