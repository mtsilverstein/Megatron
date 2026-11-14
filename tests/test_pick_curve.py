import json
import subprocess
import sys
from datetime import datetime

import pandas as pd
import pytest


STATS = [
    "passing_yards", "passing_tds", "passing_interceptions", "carries",
    "rushing_yards", "rushing_tds", "targets", "receptions",
    "receiving_yards", "receiving_tds", "fumbles_lost",
]
STAMP = "2026-11-13T12:00:00+00:00"


@pytest.fixture
def build():
    from ffmodel.site.pick_curve import build_pick_curve

    return build_pick_curve


def player(player_id, position="RB", ecr=None):
    return {"player_id": player_id, "position": position, "ecr": ecr,
            "name": "Synthetic Name " + player_id}


def weekly(*rows):
    return pd.DataFrame([
        {"player_id": "synthetic-a", "position": "RB", "season": 2021,
         "week": 1, **dict.fromkeys(STATS, 0), **row}
        for row in rows
    ], columns=["player_id", "position", "season", "week", *STATS])


def test_rank_order_and_schema(build):
    worlds = {2021: {"players": [player("synthetic-a", "RB", 3.1),
                                player("synthetic-b", "QB", 1.2),
                                player("synthetic-c", "WR", 2.0)]}}
    out = build(worlds, weekly(), generated_at=STAMP)
    assert out == {
        "kind": "pick_curve", "schema_version": 1, "generated_at": STAMP,
        "weeks": [1, 17], "stat_order": STATS,
        "market_source": "preseason consensus rank (draft worlds)",
        "seasons": [{"season": 2021, "players": [
            [1, "QB", *([0] * 11)], [2, "WR", *([0] * 11)],
            [3, "RB", *([0] * 11)],
        ]}],
    }


def test_totals_sum_weeks_1_to_17_only(build):
    frame = weekly(*[
        {"week": week, **dict.fromkeys(STATS, value)}
        for week, value in [(0, 999), (1, 2), (17, 3), (18, 999)]
    ])
    out = build({2021: {"players": [player("synthetic-a", ecr=1)]}},
                frame, generated_at=STAMP)
    assert out["seasons"][0]["players"] == [[1, "RB", *([5] * 11)]]


def test_ranked_player_without_rows_is_zeros(build):
    out = build({2021: {"players": [player("synthetic-bust", ecr=1)]}},
                weekly(), generated_at=STAMP)
    assert out["seasons"][0]["players"] == [[1, "RB", *([0] * 11)]]


def test_unranked_scorer_included_with_null_rank(build):
    frame = weekly({"rushing_yards": 10},
                   {"player_id": "synthetic-missing", "rushing_yards": 20},
                   {"player_id": "synthetic-zero"})
    out = build({2021: {"players": [player("synthetic-a")]}}, frame,
                generated_at=STAMP)
    assert out["seasons"][0]["players"] == [
        [None, "RB", 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0],
        [None, "RB", 0, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0],
    ]


def test_no_ids_names_or_ecr_in_output(build):
    players = [player("private-alpha", ecr=123.456),
               player("private-beta", ecr=234.567)]
    out = build({2021: {"players": players}}, weekly(), generated_at=STAMP)
    encoded = json.dumps(out, allow_nan=False)
    for p in players:
        for key in ("player_id", "name", "ecr"):
            assert str(p[key]) not in encoded
    assert all(key not in encoded for key in ('"player_id"', '"name"', '"ecr"'))


def test_non_skill_positions_dropped(build):
    worlds = {2021: {"players": [player("synthetic-k", "K", 1),
                                player("synthetic-a", ecr=2)]}}
    out = build(worlds, weekly({"player_id": "synthetic-k", "position": "K",
                                "rushing_yards": 20}), generated_at=STAMP)
    assert out["seasons"][0]["players"] == [[1, "RB", *([0] * 11)]]


def test_ties_and_unranked_order_are_deterministic(build):
    players = [player("synthetic-b", "WR", 2), player("synthetic-a", "QB", 2)]
    frame = weekly({"player_id": "synthetic-z", "position": "TE", "targets": 2},
                   {"player_id": "synthetic-y", "rushing_yards": 9},
                   {"player_id": "synthetic-x", "rushing_yards": 4})
    out = build({2021: {"players": players}}, frame, generated_at=STAMP)
    assert out == build({2021: {"players": players[::-1]}}, frame.iloc[::-1],
                        generated_at=STAMP)
    rows = out["seasons"][0]["players"]
    assert [r[:2] for r in rows] == [[1, "QB"], [2, "WR"], [None, "RB"],
                                           [None, "RB"], [None, "TE"]]
    assert [r[6] for r in rows[2:4]] == [4, 9]


def test_round_after_summing_and_keep_nonzero_weekly_players(build):
    frame = weekly({"rushing_yards": 0.4}, {"week": 2, "rushing_yards": 0.4},
                   {"player_id": "synthetic-cancel", "rushing_yards": 1},
                   {"player_id": "synthetic-cancel", "week": 2, "rushing_yards": -1})
    out = build({2021: {"players": []}}, frame, generated_at=STAMP)
    rows = out["seasons"][0]["players"]
    assert len(rows) == 2
    assert [r[6] for r in rows] == [0, 1]
    assert all(type(value) is int for row in rows for value in row[2:])


def test_seasons_are_sorted_and_totals_are_isolated(build):
    worlds = {2022: {"players": [player("synthetic-a", ecr=1)]},
              2021: {"players": [player("synthetic-a", ecr=1)]}}
    frame = weekly({"season": 2021, "rushing_yards": 10},
                   {"season": 2022, "rushing_yards": 20},
                   {"season": 2020, "rushing_yards": 999})
    out = build(worlds, frame, generated_at=STAMP)
    assert [s["season"] for s in out["seasons"]] == [2021, 2022]
    assert [s["players"][0][6] for s in out["seasons"]] == [10, 20]


@pytest.mark.parametrize("selected", [None, [2023]])
def test_cli_writes_file(tmp_path, selected):
    worlds_dir = tmp_path / "worlds"
    worlds_dir.mkdir()
    for season in range(2021, 2026):
        (worlds_dir / f"world_{season}.json").write_text(
            json.dumps({"players": [player("synthetic-a", ecr=1)]}), encoding="utf-8")
    parquet = tmp_path / "weekly.parquet"
    weekly({"rushing_yards": 10}).to_parquet(parquet)
    destination = tmp_path / "assets" / "pick_curve.json"
    command = [sys.executable, "-W", "error", "-m", "ffmodel.site.pick_curve",
               "--worlds-dir", str(worlds_dir), "--weekly", str(parquet),
               "--out", str(destination)]
    if selected:
        command.extend(["--seasons", *map(str, selected)])
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    out = json.loads(destination.read_text(encoding="utf-8"))
    assert [s["season"] for s in out["seasons"]] == (selected or list(range(2021, 2026)))
    assert datetime.fromisoformat(out["generated_at"]).utcoffset().total_seconds() == 0
    assert out["stat_order"] == STATS
    assert out["seasons"][0]["players"][0][6] == (0 if selected else 10)
