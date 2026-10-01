"""Outcome-workflow tag selection (astra review I2): normal o5, verified exploratory o9 contingency, refusals."""
import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

from ffmodel.prospective import freeze as F

_spec = importlib.util.spec_from_file_location("select_outcome_tag", Path(__file__).resolve().parents[1] / "tools" / "select_outcome_tag.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)


def mf(o, exploratory, **kw):
    d = {"season": 2026, "origin": o, "dry_run": False, "exploratory": exploratory}
    if exploratory:
        d["reason"] = F.CONTINGENCY_REASON
    d.update(kw)
    return d


def sel(tags, manifests):
    """tags: set of tag names; manifests: {origin: dict}"""
    return S.select(2026, lambda t: t in tags,
                    lambda tag, path: manifests[int(path.split("/o")[1].split("/")[0])])


O5, O9 = "prospective-2026-o5", "prospective-2026-o9"


def test_constant_matches_freeze():
    assert S.CONTINGENCY_REASON == F.CONTINGENCY_REASON


def test_o5_is_the_normal_source():
    r = sel({O5}, {5: mf(5, False)})
    assert r == {"tag": O5, "origin": 5, "exploratory": False, "pip_freeze": "models/prospective/2026/o5/inputs/pip_freeze.txt"}


def test_o5_with_a_normal_o9_still_uses_o5():
    assert sel({O5, O9}, {5: mf(5, False), 9: mf(9, False)})["tag"] == O5


def test_o9_contingency_when_o5_absent_and_manifest_verifies():
    r = sel({O9}, {9: mf(9, True)})
    assert r == {"tag": O9, "origin": 9, "exploratory": True, "pip_freeze": "models/prospective/2026/o9/inputs/pip_freeze.txt"}


def test_refuses_no_tags():
    with pytest.raises(S.SelectionError, match="nothing was frozen"):
        sel(set(), {})


@pytest.mark.parametrize("m", [mf(9, False), mf(9, True, reason="other"), mf(9, True, dry_run=True),
                               mf(9, True, season=2025), mf(9, True, origin=5)])
def test_refuses_o9_only_when_not_a_verified_contingency(m):
    with pytest.raises(S.SelectionError):
        sel({O9}, {9: m})


def test_refuses_both_present_with_exploratory_o9():
    with pytest.raises(S.SelectionError, match="ambiguous"):
        sel({O5, O9}, {5: mf(5, False), 9: mf(9, True)})


def test_refuses_exploratory_o5_and_unreadable_manifest():
    with pytest.raises(S.SelectionError, match="exploratory"):
        sel({O5}, {5: mf(5, True)})
    def bad(tag, path):
        raise RuntimeError("no such path")
    with pytest.raises(S.SelectionError, match="cannot read"):
        S.select(2026, lambda t: t == O9, bad)


def test_cli_against_a_real_git_repo(tmp_path, monkeypatch, capsys):
    def git(*a):
        subprocess.run(["git", *a], cwd=tmp_path, check=True, capture_output=True)
    git("init", "-q")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "t")
    p = tmp_path / "models" / "prospective" / "2026" / "o9"
    p.mkdir(parents=True)
    (p / "manifest.json").write_text(json.dumps(mf(9, True)))
    git("add", "-A")
    git("commit", "-q", "-m", "x")
    git("tag", O9)
    monkeypatch.chdir(tmp_path)
    assert S.main(["--season", "2026"]) == 0
    assert json.loads(capsys.readouterr().out)["tag"] == O9
    git("tag", O5)  # now both exist, o9 exploratory, and o5 has no manifest: refused
    assert S.main(["--season", "2026"]) == 1
    assert "OUTCOME TAG REFUSED" in capsys.readouterr().err
