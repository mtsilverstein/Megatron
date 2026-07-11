import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.site.draft import (
    REPLACEMENT_RANK, _assign_tiers, build_draft_board, season_projection,
)
from ffmodel.scoring import PREDICTED_STATS

from tests.test_future import _history, _sched_with_future
from tests.test_site_weekly import _QuantileStub


def test_season_projection_sums_weeks():
    weekly = _history()
    sched = _sched_with_future()          # 8 scheduled weeks
    proj = season_projection(weekly, sched, _QuantileStub(), 2023,
                             weeks=range(7, 9))   # two future weeks
    p1 = proj[proj["player_id"] == "p1"].iloc[0]
    # stub: 13.0 PPR per week x 2 weeks
    assert p1["season_p50"] == pytest.approx(26.0)
    assert p1["season_p10"] == pytest.approx(13.0)
    assert p1["games"] == 2


def test_bye_week_reduces_games():
    weekly = _history()
    sched = _sched_with_future()
    sched = sched[sched["week"] != 8]     # week 8 becomes a universal bye
    proj = season_projection(weekly, sched, _QuantileStub(), 2023, weeks=range(7, 9))
    assert (proj["games"] == 1).all()


def test_vorp_and_ordering():
    players = pd.DataFrame({
        "player_id": [f"wr{i}" for i in range(30)] + [f"rb{i}" for i in range(30)],
        "name": "x", "team": "AAA",
        "position": ["WR"] * 30 + ["RB"] * 30,
        "season_p50": list(range(300, 270, -1)) + list(range(400, 370, -1)),
        "season_p10": np.nan, "season_p90": np.nan, "games": 17,
    })
    from ffmodel.site.draft import _finalize_board

    payload = _finalize_board(players, model="m", season=2026,
                              data_through="2025-01-05", has_bands=False)
    vorps = [p["vorp"] for p in payload["players"]]
    assert vorps == sorted(vorps, reverse=True)
    top = payload["players"][0]
    assert top["position"] == "RB" and top["position_rank"] == 1
    # replacement: RB rank 25 has p50 400-24=376 -> top RB vorp = 400-376 = 24
    assert top["vorp"] == pytest.approx(24.0)
    json.dumps(payload)


def test_tier_breaks_on_gaps():
    vorp = pd.Series([50.0, 49.0, 48.0, 30.0, 29.0, 5.0])
    tiers = _assign_tiers(vorp)
    assert tiers == [1, 1, 1, 2, 2, 3]


def test_end_to_end_board():
    weekly = _history()
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9))
    assert board["has_bands"] is True
    assert board["methodology"]["replacement_rank"] == REPLACEMENT_RANK
    assert len(board["players"]) == 2
    json.dumps(board)
