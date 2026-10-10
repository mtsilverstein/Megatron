"""The acceptance tool runs offline: explicit existing files only, frozen cache, no sockets (spec §7.5, astra P7)."""
import importlib.util
import socket
from pathlib import Path

import pandas as pd
import pytest

_spec = importlib.util.spec_from_file_location(
    "weekly_accuracy_acceptance", Path(__file__).resolve().parents[1] / "tools" / "weekly_accuracy_acceptance.py")
acc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(acc)


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*a, **k):
        raise AssertionError("acceptance tool attempted a network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setenv("FFMODEL_CACHE_FROZEN", "0")        # restored after the test; main() sets "1"


def _files(tmp_path, team="LAR"):
    raw = pd.DataFrame({"ecr_type": "wp", "page_type": "weekly-rb", "pos": "RB", "id": [1, 2], "player": ["a", "b"],
                        "team": [team, "JAC"], "ecr": [1.0, 2.0], "sd": 1.0, "mergename": ["a", "b"],
                        "scrape_date": ["2024-09-13", "2024-09-13"]})
    sched = pd.DataFrame({"season": [2024], "week": [2], "gameday": ["2024-09-15"], "home_team": ["LA"],
                          "away_team": ["JAX"]})
    rp, sp = tmp_path / "rank.parquet", tmp_path / "sched.parquet"
    raw.to_parquet(rp)
    sched.to_parquet(sp)
    return rp, sp


def test_team_codes_offline(tmp_path, no_network):
    rp, sp = _files(tmp_path)
    assert acc.team_code_failures(rp, sp) == []
    rp2, sp2 = _files(tmp_path, team="ZZZ")
    assert acc.team_code_failures(rp2, sp2) == [("2024-09-13", 1)]


def test_missing_cache_is_an_error_never_a_download(tmp_path, no_network):
    import os

    rp, _ = _files(tmp_path)
    with pytest.raises(FileNotFoundError):
        acc.main(["--rankings", str(rp), "--schedules", str(tmp_path / "absent.parquet")])
    assert os.environ["FFMODEL_CACHE_FROZEN"] == "1"
