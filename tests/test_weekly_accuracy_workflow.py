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
    assert job["steps"][0]["with"]["fetch-depth"] == 0
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
    assert job["env"]["PRIVATE_DATA_TOKEN"] == "${{ secrets.PRIVATE_DATA_TOKEN }}"
    skip = job["steps"][0]
    assert skip["if"] == "env.PRIVATE_DATA_TOKEN == ''" and "::notice::" in skip["run"]
    assert all(s.get("if") in ("env.PRIVATE_DATA_TOKEN != ''", "failure()") for s in job["steps"][1:])
    public, private = job["steps"][1], job["steps"][2]
    assert public["with"]["persist-credentials"] is False
    assert private["with"]["repository"] == "mtsilverstein/megatron-private-data"
    assert private["with"]["token"] == "${{ secrets.PRIVATE_DATA_TOKEN }}" and private["with"]["path"] == "private"
    push = next(s for s in job["steps"] if s.get("working-directory") == "private")
    assert "git add reports/sleeper_*.json reports/sleeper_*.md" in push["run"]
    assert "--out private/reports" in _run_text(job)
    assert "::warning::" in job["steps"][-1]["run"] and job["steps"][-1]["if"] == "failure()"


def test_ledger_seed_shape():
    led = json.loads(LEDGER.read_text(encoding="utf-8"))
    assert led["coverage"] == [["-inf", "2026-10-06T19:02:01Z"]] and len(led["events"]) == 239
    ids = [e["id"] for e in led["events"]]
    assert len(ids) == len(set(ids))
    assert all(isinstance(e["actor"], (str, type(None))) for e in led["events"])
    kinds = [e["activity_type"] for e in led["events"]]
    assert kinds.count("push") == 235 and kinds.count("pr_merge") == 3 and kinds.count("branch_creation") == 1
    assert "force_push" not in kinds
