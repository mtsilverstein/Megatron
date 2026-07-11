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
    assert p1["ppr_p50"] == pytest.approx(26.0)
    assert p1["ppr_p10"] == pytest.approx(13.0)
    assert p1["games"] == 2


def test_bye_week_reduces_games():
    weekly = _history()
    sched = _sched_with_future()
    sched = sched[sched["week"] != 8]     # week 8 becomes a universal bye
    proj = season_projection(weekly, sched, _QuantileStub(), 2023, weeks=range(7, 9))
    assert (proj["games"] == 1).all()


def test_vorp_and_ordering():
    ppr_p50 = list(range(300, 270, -1)) + list(range(400, 370, -1))
    players = pd.DataFrame({
        "player_id": [f"wr{i}" for i in range(30)] + [f"rb{i}" for i in range(30)],
        "name": "x", "team": "AAA",
        "position": ["WR"] * 30 + ["RB"] * 30,
        "ppr_p50": ppr_p50, "ppr_p10": np.nan, "ppr_p90": np.nan,
        "half_ppr_p50": ppr_p50, "half_ppr_p10": np.nan, "half_ppr_p90": np.nan,
        "standard_p50": ppr_p50, "standard_p10": np.nan, "standard_p90": np.nan,
        "games": 17, "bye": None,
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
    # 12 players, replacement_rank=5 -> draftable pool is the top 10.
    # Pool steps are a steady 2.0 except one real cliff (94 -> 60) inside the
    # pool; two "waiver tail" players sit far below with huge gaps that must
    # NOT be allowed to inflate the threshold (that's the bug being fixed:
    # the old span-based formula used the full range including this tail,
    # which raised the threshold past 34 and hid the real cliff).
    vorp = pd.Series([
        100.0, 98.0, 96.0, 94.0,             # tier 1 (steady 2.0 steps)
        60.0, 58.0, 56.0, 54.0, 52.0, 50.0,   # tier 2 (steady 2.0 steps; end of pool)
        -200.0,                               # tier 3 (waiver tail)
        -250.0,                               # tier 4 (waiver tail)
    ])
    # pool = first 10 values; mean_gap = (100 - 50) / 9 = 5.555..
    # threshold = max(2.0, 2 * 5.555..) = 11.111..
    tiers = _assign_tiers(vorp, replacement_rank=5)
    assert tiers == [1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 4]


def test_tier_single_player_pool_too_small_for_gap_stats():
    # n_draft = min(2*rank, len) < 2 -> no gap statistics possible.
    vorp = pd.Series([42.0])
    assert _assign_tiers(vorp, replacement_rank=5) == [1]


def test_tier_all_equal_vorp_collapses_to_one_tier():
    # Zero mean gap within the pool -> threshold floors at 2.0; with no
    # diffs exceeding it, every player lands in a single tier.
    vorp = pd.Series([10.0] * 8)
    assert _assign_tiers(vorp, replacement_rank=3) == [1] * 8


def test_end_to_end_board():
    weekly = _history()
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9))
    assert board["has_bands"] is True
    assert board["methodology"]["replacement_rank"] == REPLACEMENT_RANK
    assert len(board["players"]) == 2
    json.dumps(board)


def test_empty_weeks_range_fails_loud():
    weekly = _history()
    sched = _sched_with_future()          # weeks 1-8 scheduled; 9-10 do not exist
    with pytest.raises(RuntimeError, match="empty draft board"):
        build_draft_board(weekly, sched, _QuantileStub(), 2023,
                          "2023-10-15", weeks=range(9, 11))


def test_board_carries_games_bye_and_all_rulesets():
    weekly = _history()
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9))
    top = board["players"][0]
    assert top["games"] == 2
    assert top["bye"] is None            # toy schedule has no bye in weeks 7-8
    assert set(top["season_points"]) == {"ppr", "half_ppr", "standard"}
    assert top["season_points"]["standard"]["p50"] <= top["season_points"]["ppr"]["p50"]


def test_prefit_skips_internal_fit():
    weekly = _history()

    class CountingStub(_QuantileStub):
        fits = 0

        def fit(self, train):
            type(self).fits += 1

    stub = CountingStub()
    stub.fit(None)                       # simulate generate.py's own fit
    build_draft_board(weekly, _sched_with_future(), stub, 2023,
                      "2023-10-15", weeks=range(7, 9), prefit=True)
    assert CountingStub.fits == 1


def test_bye_values_are_json_safe():
    from tests.test_features import make_weekly, make_schedules

    weekly = make_weekly([
        {"player_id": "p1", "week": w, "receiving_yards": 50.0} for w in range(1, 7)
    ] + [
        {"player_id": "p3", "team": "CCC", "opponent_team": "DDD", "position": "RB",
         "week": w, "rushing_yards": 40.0} for w in range(1, 7)
    ])
    sched = make_schedules(8)                     # AAA/BBB play weeks 7-8
    extra = pd.DataFrame({                        # CCC/DDD play ONLY week 7 -> week 8 bye
        "season": 2023, "week": [7],
        "gameday": ["2023-10-22"], "home_team": "CCC", "away_team": "DDD",
    })
    sched = pd.concat([sched, extra], ignore_index=True)
    board = build_draft_board(weekly, sched, _QuantileStub(), 2023,
                              "2023-10-15", weeks=range(7, 9))
    byes = {p["player_id"]: p["bye"] for p in board["players"]}
    assert byes["p3"] == 8                        # genuine bye, plain int
    assert byes["p1"] is None                     # plays both weeks
    payload = json.dumps(board, allow_nan=False)  # must not raise
    assert '"bye": 8' in payload
