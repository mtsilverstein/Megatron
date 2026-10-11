"""Static checks on the weekly-accuracy workflow and the committed ledger seed (spec §4.1, §4.7, §4.8.5)."""
import json
from pathlib import Path

import yaml

WF = Path(".github/workflows/weekly-accuracy.yml")
LEDGER = Path("models/diagnostics/main_push_ledger.json")


def _wf():
    return yaml.safe_load(WF.read_text(encoding="utf-8"))


def _run_text(job):
    return "\n".join(s.get("run", "") for s in job["steps"])


def test_public_job_contract():
    wf = _wf()
    on = wf.get("on", wf.get(True))
    assert sorted(s["cron"] for s in on["schedule"]) == ["47 13 * 9-12,1 3", "47 16 * 9-12,1 2"]
    assert "workflow_dispatch" in on
    assert wf["concurrency"] == {"group": "weekly-site-refresh", "cancel-in-progress": False}
    job = wf["jobs"]["accuracy"]
    assert job["permissions"] == {"contents": "write"} and job["env"]["GH_TOKEN"] == "${{ github.token }}"
    assert job["steps"][0]["with"] == {"ref": "main", "fetch-depth": 0}   # a dispatch from a branch must not push it
    assert "for i in 1 2 3; do" in _run_text(job) and _run_text(job).rstrip().endswith("exit 1")
    run = _run_text(job)
    assert 'git config user.name "weekly-accuracy-bot"' in run and "python -m ffmodel.eval.live_accuracy" in run
    assert ("git add models/diagnostics/live_*_weekly.json models/diagnostics/live_*_weekly.md "
            "models/diagnostics/main_push_ledger.json") in run
    assert "git pull --rebase origin main && git push origin HEAD:main" in run          # rebase, then push
    assert "--force" not in run and " -f " not in run


def test_workflow_never_writes_site():
    text = WF.read_text(encoding="utf-8")
    assert "site/" not in text


def test_private_job_is_fail_soft_and_cannot_write_public_repo():
    job = _wf()["jobs"]["sleeper"]
    assert job["needs"] == "accuracy" and job["continue-on-error"] is True
    assert job["permissions"] == {"contents": "read"}
    assert "env" not in job and "PRIVATE_DATA_TOKEN" not in str({k: v for k, v in job.items() if k != "steps"})
    gate = job["steps"][0]
    assert gate["id"] == "gate" and gate["env"] == {"HAVE_TOKEN": "${{ secrets.PRIVATE_DATA_TOKEN != '' }}"}
    assert "::notice::" in gate["run"] and "GITHUB_OUTPUT" in gate["run"]
    ok = "steps.gate.outputs.run == 'true'"
    assert all(s.get("if") in (ok, "failure()") for s in job["steps"][1:])
    public, setup, install, private = job["steps"][1:5]
    assert public["with"] == {"ref": "main", "fetch-depth": 0, "persist-credentials": False}
    assert "path" not in public["with"]
    # build and install run BEFORE the private checkout, and the checkout leaves no credential on disk
    assert setup["uses"].startswith("actions/setup-python@") and install["run"] == "pip install -e ."
    assert private["uses"].startswith("actions/checkout@")
    assert private["with"]["repository"] == "mtsilverstein/megatron-private-data"
    assert private["with"]["token"] == "${{ secrets.PRIVATE_DATA_TOKEN }}" and private["with"]["path"] == "private"
    assert private["with"]["persist-credentials"] is False
    # the secret appears in exactly three steps, each in one place: the gate's boolean expression, the private
    # checkout's token, and the push step's env -- no other step, job-level key or workflow-level key
    wf = _wf()
    secret = "secrets.PRIVATE_DATA_TOKEN"
    assert secret not in str({k: v for k, v in wf.items() if k != "jobs"})
    for name, j in wf["jobs"].items():
        assert secret not in str({k: v for k, v in j.items() if k != "steps"}), name
    push = next(s for s in job["steps"] if s.get("working-directory") == "private")
    allowed = {"Decide whether the private-data secret is available": ("env", "HAVE_TOKEN"),
               "Check out the private data repository": ("with", "token"),
               push["name"]: ("env", "PRIVATE_DATA_TOKEN")}
    for jname, j in wf["jobs"].items():
        for s in j["steps"]:
            holders = [(k, sub) for k, v in s.items() if isinstance(v, dict) for sub, x in v.items() if secret in str(x)]
            rest = {k: v for k, v in s.items() if not isinstance(v, dict)}
            assert secret not in str(rest), (jname, s.get("name"))             # not in run/if/name/uses
            if holders:
                assert jname == "sleeper" and allowed.get(s.get("name")) is not None, (jname, s.get("name"))
                assert holders == [allowed[s["name"]]], (jname, s.get("name"), holders)
    # the push step authenticates explicitly (the checkout persisted nothing) without echoing the token
    assert push["env"] == {"PRIVATE_DATA_TOKEN": "${{ secrets.PRIVATE_DATA_TOKEN }}"}
    assert "extraheader" in push["run"] and "::add-mask::" in push["run"] and "echo \"$PRIVATE" not in push["run"]
    assert "set -x" not in push["run"] and "git remote set-url" not in push["run"]
    compare = next(s for s in job["steps"] if "sleeper_compare" in s.get("run", ""))
    assert "working-directory" not in compare
    assert "git add reports/sleeper_*.json reports/sleeper_*.md" in push["run"]
    assert "--out private/reports" in _run_text(job)
    assert "::warning::" in job["steps"][-1]["run"] and job["steps"][-1]["if"] == "failure()"


def test_ledger_seed_shape():
    # The committed ledger is append-only and grows with every weekly-accuracy run, so pin the seed it started
    # from (the first collection and every event up to its end), not the whole file.
    led = json.loads(LEDGER.read_text(encoding="utf-8"))
    assert led["coverage"][0] == ["-inf", "2026-10-06T19:02:01Z"]
    ids = [e["id"] for e in led["events"]]
    assert len(ids) == len(set(ids))
    assert all(isinstance(e["actor"], (str, type(None))) for e in led["events"])
    seed = [e for e in led["events"] if e["timestamp"] <= "2026-10-06T19:02:01Z"]
    assert len(seed) == 239
    kinds = [e["activity_type"] for e in seed]
    assert kinds.count("push") == 235 and kinds.count("pr_merge") == 3 and kinds.count("branch_creation") == 1
    assert "force_push" not in kinds
