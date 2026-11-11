"""Structure checks for the two bot workflows (token scope, push hardening, season-end gating)."""
from pathlib import Path

import yaml

WF = Path(".github/workflows")


def _load(name):
    return yaml.safe_load((WF / name).read_text(encoding="utf-8"))


def _steps(doc, job):
    return doc["jobs"][job]["steps"]


def _step(doc, job, key, value):
    return next(s for s in _steps(doc, job) if s.get(key) == value)


def test_weekly_update_token_is_minimal_and_not_persisted():
    doc = _load("weekly-update.yml")
    assert doc["jobs"]["regenerate"]["permissions"] == {"contents": "write"}
    assert "actions: write" not in (WF / "weekly-update.yml").read_text(encoding="utf-8")
    checkout = _steps(doc, "regenerate")[0]
    assert checkout["uses"].startswith("actions/checkout@")
    assert checkout["with"]["persist-credentials"] is False


def test_weekly_update_commit_step_retries_with_injected_token():
    doc = _load("weekly-update.yml")
    step = _step(doc, "regenerate", "id", "commit")
    assert "pull --rebase" in step["run"]
    assert "extraheader" in step["run"] and "::add-mask::" in step["run"]
    assert "${{" not in step["run"]
    assert "${{ github.token }}" in step["env"].values()
    # A dispatch from a branch pushes that branch, never main (the checkout is not pinned to main).
    assert step["env"]["BRANCH"] == "${{ github.ref_name }}"
    assert 'gitp push origin "HEAD:$BRANCH"' in step["run"] and "HEAD:main" not in step["run"]
    assert "git rebase --abort" in step["run"]


def _retry_loop(run):
    return run[run.index("for i in 1 2 3; do"):run.index("done")]


def test_bot_push_retries_pause_between_attempts():
    """Three attempts back to back would spend themselves in seconds on one transient GitHub error."""
    update = _step(_load("weekly-update.yml"), "regenerate", "id", "commit")["run"]
    accuracy = next(s for s in _steps(_load("weekly-accuracy.yml"), "accuracy")
                    if "git commit" in s.get("run", ""))["run"]
    for run in (update, accuracy):
        assert "sleep 5" in _retry_loop(run)


def test_weekly_update_optional_refreshes_gated_on_published_batch():
    doc = _load("weekly-update.yml")
    for sid in ("live_experts", "ros_experts"):
        cond = _step(doc, "regenerate", "id", sid)["if"]
        assert "steps.batch.outputs.state == 'published'" in cond
    batch = _step(doc, "regenerate", "id", "batch")["run"]
    assert "set +e" in batch and 'RC=$?' in batch
    for code, state in (("0", "published"), ("10", "season_over"), ("11", "stats_pending")):
        assert f'"$RC" -eq {code} ]' in batch and f"state={state}" in batch
    assert 'exit "$RC"' in batch
    assert _step(doc, "regenerate", "id", "live_accuracy")["if"] == "inputs.draft != true"


def test_weekly_accuracy_token_scoped_to_scoring_step_and_not_persisted():
    doc = _load("weekly-accuracy.yml")
    assert "GH_TOKEN" not in doc["jobs"]["accuracy"].get("env", {})
    scoring = next(s for s in _steps(doc, "accuracy") if "live_accuracy" in s.get("run", ""))
    assert "GH_TOKEN" in scoring["env"]
    assert _steps(doc, "accuracy")[0]["with"]["persist-credentials"] is False
    commit = next(s for s in _steps(doc, "accuracy") if "git commit" in s.get("run", ""))
    assert "pull --rebase" in commit["run"] and "extraheader" in commit["run"]
