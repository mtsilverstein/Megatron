from __future__ import annotations

import importlib.util
from pathlib import Path

import pandas as pd
import pytest


SCRIPT = Path(__file__).parents[1] / "tools" / "build_pick_six_prior.py"
SPEC = importlib.util.spec_from_file_location("build_pick_six_prior", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def _event(play_id: int, **overrides) -> dict:
    event = {
        "season": 2025,
        "season_type": "REG",
        "game_id": "2025_01_AAA_BBB",
        "play_id": play_id,
        "interception": 1,
        "return_touchdown": 0,
        "two_point_attempt": 0,
        "passer_player_id": "passer",
        "interception_player_id": "defender",
        "td_team": None,
        "defteam": "BBB",
    }
    event.update(overrides)
    return event


def _write(tmp_path: Path, rows: list[dict]) -> Path:
    path = tmp_path / "play_by_play_2025.parquet"
    pd.DataFrame(rows, columns=MODULE.READ_COLUMNS).to_parquet(path, index=False)
    return path


def test_source_filter_counts_only_credited_defensive_interception_tds(tmp_path):
    path = _write(
        tmp_path,
        [
            _event(1),
            _event(2, return_touchdown=1, td_team="BBB"),
            # An INT return fumbled into an offensive recovery TD is marked as
            # a return touchdown in nflverse, but it is not a pick-six.
            _event(3, return_touchdown=1, td_team="AAA"),
            _event(4, two_point_attempt=1, return_touchdown=1, td_team="BBB"),
            _event(5, season_type="POST", return_touchdown=1, td_team="BBB"),
            _event(6, passer_player_id=None, return_touchdown=1, td_team="BBB"),
            _event(7, interception_player_id=None, return_touchdown=1, td_team="BBB"),
        ],
    )

    assert MODULE._season_counts(path, 2025) == (3, 1)


def test_source_filter_rejects_duplicate_interception_events(tmp_path):
    event = _event(1, return_touchdown=1, td_team="BBB")
    path = _write(tmp_path, [event, event.copy()])

    with pytest.raises(ValueError, match="duplicate credited interception event"):
        MODULE._season_counts(path, 2025)


def test_source_filter_rejects_wrong_season_file(tmp_path):
    path = _write(tmp_path, [_event(1, season=2024)])

    with pytest.raises(ValueError, match=r"contains seasons \[2024\], expected 2025"):
        MODULE._season_counts(path, 2025)
