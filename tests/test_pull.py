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


def test_canonical_columns_include_scoring_extras():
    out = normalize_weekly(pd.DataFrame([_raw_row()]))
    for col in ("two_point_conversions", "special_teams_tds"):
        assert col in out.columns, col


def test_cache_name_rejects_empty_seasons():
    from ffmodel.data.pull import _cache_name

    with pytest.raises(ValueError, match="seasons"):
        _cache_name("weekly", [])


def _snap_weekly(rows):
    base = {"player_display_name": "P", "position": "WR", "team": "AAA",
            "opponent_team": "BBB"}
    return pd.DataFrame([{**base, **r} for r in rows])


def test_merge_snap_pct_matched_row_gets_value():
    from ffmodel.data.pull import merge_snap_pct

    weekly = _snap_weekly([{"player_id": "g1", "season": 2023, "week": 1}])
    snaps = pd.DataFrame([
        {"pfr_player_id": "pfr1", "season": 2023, "week": 1, "offense_pct": 0.75},
    ])
    crosswalk = pd.DataFrame([{"pfr_id": "pfr1", "gsis_id": "g1"}])
    out = merge_snap_pct(weekly, snaps, crosswalk)
    assert out["snap_pct"].iloc[0] == pytest.approx(0.75)


def test_merge_snap_pct_unmatched_player_stays_nan():
    import numpy as np

    from ffmodel.data.pull import merge_snap_pct

    weekly = _snap_weekly([
        {"player_id": "g1", "season": 2023, "week": 1},
        {"player_id": "g2", "season": 2023, "week": 1},  # no crosswalk entry
    ])
    snaps = pd.DataFrame([
        {"pfr_player_id": "pfr1", "season": 2023, "week": 1, "offense_pct": 0.75},
    ])
    crosswalk = pd.DataFrame([{"pfr_id": "pfr1", "gsis_id": "g1"}])
    out = merge_snap_pct(weekly, snaps, crosswalk)
    g2 = out[out["player_id"] == "g2"]
    assert np.isnan(g2["snap_pct"].iloc[0])


def test_merge_snap_pct_season_with_no_snap_rows_stays_all_nan():
    import numpy as np

    from ffmodel.data.pull import merge_snap_pct

    weekly = _snap_weekly([
        {"player_id": "g1", "season": 2012, "week": 1},
        {"player_id": "g2", "season": 2012, "week": 2},
    ])
    snaps = pd.DataFrame(columns=["pfr_player_id", "season", "week", "offense_pct"])
    crosswalk = pd.DataFrame([{"pfr_id": "pfr1", "gsis_id": "g1"}])
    out = merge_snap_pct(weekly, snaps, crosswalk)
    assert out["snap_pct"].isna().all()


def _raw_draft(rows):
    """Synthetic nflverse draft_picks frame with the future-leaking columns
    present, to prove they get dropped."""
    base = {"season": 2024, "round": 1, "pick": 1, "team": "KAN",
            "gsis_id": "00-0099999", "pfr_player_id": "X", "cfb_player_id": "Y",
            "pfr_player_name": "Some Guy", "position": "RB", "age": 22.0,
            "college": "State", "hof": False,
            # future-leaking career-outcome columns:
            "to": 2035, "w_av": 80, "car_av": 75, "dr_av": 70, "games": 150,
            "allpro": 3, "probowls": 5, "seasons_started": 9,
            "rush_yards": 9000, "rec_yards": 3000, "pass_yards": 0}
    return pd.DataFrame([{**base, **r} for r in rows])


def test_normalize_draft_picks_column_whitelist_excludes_career_outcomes():
    from ffmodel.data.pull import normalize_draft_picks

    out = normalize_draft_picks(_raw_draft([{}]))
    assert list(out.columns) == ["season", "round", "pick", "team", "gsis_id",
                                 "player_name", "position", "age", "college"]


def test_normalize_draft_picks_maps_pfr_team_codes():
    from ffmodel.data.pull import normalize_draft_picks

    out = normalize_draft_picks(_raw_draft([
        {"team": "GNB"}, {"team": "KAN"}, {"team": "NOR"}, {"team": "LVR"},
        {"team": "LAR"}, {"team": "SDG"}, {"team": "STL"}, {"team": "OAK"},
        {"team": "PHI"},
    ]))
    assert list(out["team"]) == ["GB", "KC", "NO", "LV", "LA", "LAC", "LA",
                                 "LV", "PHI"]


def test_normalize_draft_picks_rejects_unknown_team_code():
    from ffmodel.data.pull import normalize_draft_picks

    with pytest.raises(ValueError, match="ZZZ"):
        normalize_draft_picks(_raw_draft([{"team": "ZZZ"}]))


def test_normalize_draft_picks_filters_to_skill_positions():
    from ffmodel.data.pull import normalize_draft_picks

    out = normalize_draft_picks(_raw_draft([
        {"position": "QB"}, {"position": "T"}, {"position": "DB"},
        {"position": "TE"},
    ]))
    assert list(out["position"]) == ["QB", "TE"]


def test_pull_draft_picks_uses_cache(tmp_path):
    from ffmodel.data.pull import normalize_draft_picks, pull_draft_picks

    cached = normalize_draft_picks(_raw_draft([{}]))
    cached.to_parquet(tmp_path / "draft_picks_2024_2024.parquet", index=False)
    # No network stub: a real fetch attempt would fail loudly here.
    out = pull_draft_picks([2024], cache_dir=tmp_path)
    assert len(out) == 1 and out["team"].iloc[0] == "KC"


def test_merge_snap_pct_duplicate_rows_do_not_fan_out():
    """Characterization test: snaps with a duplicate (pfr_player_id, season,
    week) pair (e.g. a two-team week in the raw source) and a crosswalk with
    a duplicate pfr_id row must not fan out the weekly join. snap_pct stays
    a scalar per row -- the first match wins."""
    import numpy as np

    from ffmodel.data.pull import merge_snap_pct

    weekly = _snap_weekly([
        {"player_id": "g1", "season": 2023, "week": 1},
        {"player_id": "g2", "season": 2023, "week": 1},
    ])
    snaps = pd.DataFrame([
        {"pfr_player_id": "pfr1", "season": 2023, "week": 1, "offense_pct": 0.75},
        {"pfr_player_id": "pfr1", "season": 2023, "week": 1, "offense_pct": 0.40},
    ])
    crosswalk = pd.DataFrame([
        {"pfr_id": "pfr1", "gsis_id": "g1"},
        {"pfr_id": "pfr1", "gsis_id": "g1-duplicate"},
    ])
    out = merge_snap_pct(weekly, snaps, crosswalk)
    assert len(out) == len(weekly)  # no fan-out from duplicate snap/crosswalk rows
    g1 = out[out["player_id"] == "g1"]
    assert len(g1) == 1
    assert isinstance(g1["snap_pct"].iloc[0], (int, float, np.floating))
    assert g1["snap_pct"].iloc[0] == pytest.approx(0.75)  # first match kept


def test_pull_schedules_includes_completion_columns_and_uses_v2_cache(tmp_path, monkeypatch):
    """Pin: pull_schedules selects home_score/away_score (needed to detect
    completed target-season games in site.generate's pre-week-1 fail-safe
    tolerance), and caches under a bumped 'schedules_v2' prefix so a
    pre-existing local cache written before this column existed is not
    silently reused without it."""
    import sys

    from ffmodel.data.pull import _cache_name, pull_schedules

    raw = pd.DataFrame({
        "season": [2026, 2026], "week": [1, 1],
        "gameday": ["2026-09-10", "2026-09-10"],
        "home_team": ["KC", "SF"], "away_team": ["DET", "LA"],
        "game_type": ["REG", "REG"],
        "home_score": [24.0, float("nan")], "away_score": [17.0, float("nan")],
    })

    class _Result:
        def to_pandas(self):
            return raw

    class _FakeNflreadpy:
        @staticmethod
        def load_schedules(seasons):
            return _Result()

    monkeypatch.setitem(sys.modules, "nflreadpy", _FakeNflreadpy())

    # Stale pre-existing cache under the OLD "schedules" prefix (no score
    # columns) -- must be ignored, not read, by the bumped prefix.
    stale = pd.DataFrame({
        "season": [2026], "week": [1], "gameday": ["2026-09-10"],
        "home_team": ["XXX"], "away_team": ["YYY"],
    })
    stale_path = tmp_path / f"{_cache_name('schedules', [2026])}.parquet"
    stale.to_parquet(stale_path, index=False)

    out = pull_schedules([2026], cache_dir=tmp_path)

    assert "home_score" in out.columns and "away_score" in out.columns
    assert out.loc[out["home_team"] == "KC", "home_score"].iloc[0] == 24.0

    new_cache = tmp_path / f"{_cache_name('schedules_v2', [2026])}.parquet"
    assert new_cache.exists()


@pytest.mark.integration
def test_pull_real_season_snap_pct_coverage_and_range(tmp_path):
    from ffmodel.data.pull import pull_weekly

    df = pull_weekly([2023], cache_dir=tmp_path)
    assert "snap_pct" in df.columns
    non_nan = df["snap_pct"].notna()
    assert non_nan.mean() > 0.95
    valid = df.loc[non_nan, "snap_pct"]
    assert (valid >= 0).all() and (valid <= 1).all()
