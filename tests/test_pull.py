import pandas as pd
import pytest

from ffmodel.data.pull import POSITIONS, normalize_weekly
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points


def _raw_row(**overrides):
    row = {
        "player_id": "00-001", "player_display_name": "Test Player",
        "position": "WR", "position_group": "WR",
        "season": 2023, "week": 1, "season_type": "REG",
        "team": "KC", "opponent_team": "DET",
        "completions": 0, "attempts": 0, "passing_yards": 0.0, "passing_tds": 0,
        "passing_interceptions": 0, "sack_fumbles_lost": 0,
        "passing_2pt_conversions": 0,
        "carries": 0, "rushing_yards": 0.0, "rushing_tds": 0,
        "rushing_fumbles_lost": 0, "rushing_2pt_conversions": 0,
        "receptions": 0, "targets": 0, "receiving_yards": 0.0, "receiving_tds": 0,
        "receiving_fumbles_lost": 0, "receiving_2pt_conversions": 0,
        "special_teams_tds": 0, "target_share": 0.1,
        "fantasy_points_ppr": 0.0,
    }
    row.update(overrides)
    return row


def test_filters_positions_and_season_type():
    raw = pd.DataFrame([
        _raw_row(position_group="WR"),
        _raw_row(position_group="K"),
        _raw_row(position_group="WR", season_type="POST"),
    ])
    out = normalize_weekly(raw)
    assert len(out) == 1
    assert set(out["position"]).issubset(set(POSITIONS))


def test_sums_fumbles_and_two_point_conversions():
    raw = pd.DataFrame([_raw_row(
        rushing_fumbles_lost=1, receiving_fumbles_lost=1, sack_fumbles_lost=1,
        passing_2pt_conversions=1, receiving_2pt_conversions=1,
    )])
    out = normalize_weekly(raw)
    assert out["fumbles_lost"].iloc[0] == 3
    assert out["two_point_conversions"].iloc[0] == 2


def test_canonical_columns_present():
    out = normalize_weekly(pd.DataFrame([_raw_row()]))
    for col in PREDICTED_STATS + ["player_id", "position", "team", "opponent_team",
                                  "season", "week", "target_share", "fantasy_points_ppr"]:
        assert col in out.columns, col


def test_cache_name_distinguishes_same_span_lists():
    from ffmodel.data.pull import _cache_name

    contiguous = _cache_name("weekly", [2012, 2013, 2014, 2015])
    assert contiguous == "weekly_2012_2015"
    a = _cache_name("weekly", [2012, 2015])
    b = _cache_name("weekly", [2012, 2013, 2015])
    assert a != b
    assert a != contiguous
    assert _cache_name("weekly", [2015, 2012]) == a  # order-insensitive


def test_target_share_nan_passes_through():
    import numpy as np

    raw = pd.DataFrame([_raw_row(target_share=np.nan)])
    out = normalize_weekly(raw)
    assert np.isnan(out["target_share"].iloc[0])


def test_schedule_team_codes_normalized_to_current():
    from ffmodel.data.pull import normalize_schedule_teams

    sched = pd.DataFrame({
        "season": [2014, 2014, 2023], "week": [1, 1, 1],
        "gameday": ["2014-09-07", "2014-09-07", "2023-09-10"],
        "home_team": ["STL", "SD", "KC"],
        "away_team": ["OAK", "LA", "DET"],
    })
    out = normalize_schedule_teams(sched)
    assert list(out["home_team"]) == ["LA", "LAC", "KC"]
    assert list(out["away_team"]) == ["LV", "LA", "DET"]
    # input frame not mutated
    assert list(sched["home_team"]) == ["STL", "SD", "KC"]


@pytest.mark.integration
def test_pull_real_season_and_scoring_matches_nflverse(tmp_path):
    from ffmodel.data.pull import pull_weekly

    df = pull_weekly([2023], cache_dir=tmp_path)
    assert len(df) > 4000          # ~5-6k QB/RB/WR/TE player-weeks per season
    assert df["week"].nunique() >= 17
    # Our PPR scoring must reproduce nflverse's official fantasy_points_ppr.
    diff = (fantasy_points(df, PPR) - df["fantasy_points_ppr"]).abs()
    assert (diff < 0.01).mean() > 0.98
    # Cache round-trip: second call must not hit the network (delete nflreadpy
    # from sys.modules is overkill; just assert the parquet file now exists).
    assert any(tmp_path.glob("*.parquet"))
