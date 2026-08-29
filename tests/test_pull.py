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
        "completions": 0, "attempts": 0,
        "passing_air_yards": 0.0, "receiving_air_yards": 0.0,
        "passing_yards": 0.0, "passing_tds": 0,
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
    assert list(out.columns) == ["season", "round", "pick", "team", "gsis_id", "pfr_player_id",
                                 "player_name", "position", "age", "college"]


def test_normalize_draft_picks_maps_pfr_team_codes():
    from ffmodel.data.pull import normalize_draft_picks

    out = normalize_draft_picks(_raw_draft([
        {"team": "GNB"}, {"team": "KAN"}, {"team": "NOR"}, {"team": "NWE"},
        {"team": "SFO"}, {"team": "TAM"}, {"team": "LVR"}, {"team": "LAR"},
        {"team": "SDG"}, {"team": "STL"}, {"team": "OAK"}, {"team": "PHI"},
    ]))
    assert list(out["team"]) == ["GB", "KC", "NO", "NE", "SF", "TB", "LV",
                                 "LA", "LAC", "LA", "LV", "PHI"]


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
    from ffmodel.data.pull import pull_draft_picks

    # Pre-write a RAW-style frame (not normalized) to cache.
    raw = _raw_draft([{}])
    raw.to_parquet(tmp_path / "draft_picks_raw_2024_2024.parquet", index=False)
    # No network stub: a real fetch attempt would fail loudly here.
    out = pull_draft_picks([2024], cache_dir=tmp_path)
    # Normalization must have run on cache hit: team code mapped, columns whitelisted.
    assert len(out) == 1
    assert out["team"].iloc[0] == "KC"
    assert list(out.columns) == ["season", "round", "pick", "team", "gsis_id", "pfr_player_id",
                                 "player_name", "position", "age", "college"]


def test_pull_draft_picks_stale_cache_cannot_bypass_validation(tmp_path):
    from ffmodel.data.pull import pull_draft_picks

    # Pre-write a RAW cache with an invalid team code.
    raw = _raw_draft([{"team": "ZZZ"}])
    raw.to_parquet(tmp_path / "draft_picks_raw_2024_2024.parquet", index=False)
    # Even cached, normalization validation must run and reject the bad code.
    with pytest.raises(ValueError, match="ZZZ"):
        pull_draft_picks([2024], cache_dir=tmp_path)


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


def test_normalize_weekly_retains_v2_source_columns():
    from ffmodel.data.pull import V2_SOURCE_COLUMNS

    assert V2_SOURCE_COLUMNS == ["attempts", "receiving_air_yards",
                                 "passing_air_yards"]
    raw = pd.DataFrame([_raw_row(attempts=34, receiving_air_yards=88.0,
                                 passing_air_yards=310.0)])
    out = normalize_weekly(raw)
    assert out["attempts"].iloc[0] == 34
    assert out["receiving_air_yards"].iloc[0] == pytest.approx(88.0)
    assert out["passing_air_yards"].iloc[0] == pytest.approx(310.0)


def test_normalize_weekly_v2_columns_nan_filled_to_zero():
    import numpy as np

    raw = pd.DataFrame([_raw_row(attempts=np.nan, receiving_air_yards=np.nan,
                                 passing_air_yards=np.nan)])
    out = normalize_weekly(raw)
    for col in ("attempts", "receiving_air_yards", "passing_air_yards"):
        assert out[col].iloc[0] == 0, col


def test_pull_weekly_uses_v2_prefix_and_ignores_stale_v1_cache(tmp_path, monkeypatch):
    """Pin: pull_weekly caches under 'weekly_v2' so a pre-v2 local cache
    (no air-yards/attempts columns) is never silently reused."""
    import sys

    from ffmodel.data.pull import V2_SOURCE_COLUMNS, _cache_name, pull_weekly

    raw = pd.DataFrame([_raw_row()])

    class _Result:
        def __init__(self, frame):
            self._frame = frame

        def to_pandas(self):
            return self._frame

    class _FakeNflreadpy:
        @staticmethod
        def load_player_stats(seasons):
            return _Result(raw)

        @staticmethod
        def load_snap_counts(seasons):
            return _Result(pd.DataFrame(columns=[
                "pfr_player_id", "season", "week", "offense_pct", "game_type"]))

        @staticmethod
        def load_players():
            return _Result(pd.DataFrame([{"pfr_id": "x", "gsis_id": "y"}]))

    monkeypatch.setitem(sys.modules, "nflreadpy", _FakeNflreadpy())

    # Stale cache under the OLD "weekly" prefix: must be ignored, not read.
    stale = normalize_weekly(pd.DataFrame([_raw_row()])).drop(
        columns=V2_SOURCE_COLUMNS)
    stale.to_parquet(tmp_path / f"{_cache_name('weekly', [2023])}.parquet",
                     index=False)

    out = pull_weekly([2023], cache_dir=tmp_path)
    for col in V2_SOURCE_COLUMNS:
        assert col in out.columns, col
    assert (tmp_path / f"{_cache_name('weekly_v2', [2023])}.parquet").exists()


def test_pull_weekly_rejects_cache_missing_v2_columns(tmp_path):
    """The v2-column guard runs on EVERY read path: a weekly_v2 cache that
    somehow lacks the columns (hand-written, corrupt) fails loudly instead
    of silently producing v1-only features. No network stub on purpose --
    the guard must fire on the cached frame before any other loader runs."""
    from ffmodel.data.pull import V2_SOURCE_COLUMNS, _cache_name, pull_weekly

    bad = normalize_weekly(pd.DataFrame([_raw_row()])).drop(
        columns=V2_SOURCE_COLUMNS)
    bad.to_parquet(tmp_path / f"{_cache_name('weekly_v2', [2023])}.parquet",
                   index=False)
    with pytest.raises(ValueError, match="receiving_air_yards"):
        pull_weekly([2023], cache_dir=tmp_path)


def test_pull_schedules_includes_roof_and_uses_v3_cache(tmp_path, monkeypatch):
    """Pin: pull_schedules selects home_score/away_score (needed to detect
    completed target-season games in site.generate's pre-week-1 fail-safe
    tolerance) and roof (feature-pack v2 is_indoor), and caches under a
    bumped 'schedules_v3' prefix so a pre-existing local cache written
    before this column existed is not silently reused without it."""
    import sys

    from ffmodel.data.pull import _cache_name, pull_schedules

    raw = pd.DataFrame({
        "season": [2026, 2026], "week": [1, 1],
        "gameday": ["2026-09-10", "2026-09-10"],
        "home_team": ["KC", "SF"], "away_team": ["DET", "LA"],
        "game_type": ["REG", "REG"],
        "home_score": [24.0, float("nan")], "away_score": [17.0, float("nan")],
        "roof": ["dome", "outdoors"],
    })

    class _Result:
        def to_pandas(self):
            return raw

    class _FakeNflreadpy:
        @staticmethod
        def load_schedules(seasons):
            return _Result()

    monkeypatch.setitem(sys.modules, "nflreadpy", _FakeNflreadpy())

    # Stale pre-existing cache under the OLD "schedules_v2" prefix (no roof
    # column) -- must be ignored, not read, by the bumped prefix.
    stale = pd.DataFrame({
        "season": [2026], "week": [1], "gameday": ["2026-09-10"],
        "home_team": ["XXX"], "away_team": ["YYY"],
    })
    stale_path = tmp_path / f"{_cache_name('schedules_v2', [2026])}.parquet"
    stale.to_parquet(stale_path, index=False)

    out = pull_schedules([2026], cache_dir=tmp_path)

    assert "home_score" in out.columns and "away_score" in out.columns
    assert out.loc[out["home_team"] == "KC", "home_score"].iloc[0] == 24.0
    assert "roof" in out.columns
    assert out.loc[out["home_team"] == "KC", "roof"].iloc[0] == "dome"

    new_cache = tmp_path / f"{_cache_name('schedules_v3', [2026])}.parquet"
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


# --- cache expiry ------------------------------------------------------------
# Until this existed, a parquet written once was returned unchanged for the
# life of the checkout. The failure has no symptom: the run succeeds, on data
# from whenever the file happened to be written. The ECR spine that orders the
# whole draft board is one of these feeds.

def _stub(frame, calls):
    def load():
        calls.append(1)
        return frame
    return load


def _age(path, hours):
    import os
    import time
    old = time.time() - hours * 3600
    os.utime(path, (old, old))


def test_an_immutable_cache_is_never_re_pulled(tmp_path):
    from ffmodel.data.pull import _cached

    frame = pd.DataFrame({"a": [1]})
    calls = []
    _cached(tmp_path, "hist", _stub(frame, calls))
    _age(tmp_path / "hist.parquet", 24 * 365)          # a year old
    _cached(tmp_path, "hist", _stub(frame, calls))
    assert len(calls) == 1, "a finished-season cache was re-pulled"


def test_a_live_cache_inside_its_window_is_reused(tmp_path):
    from ffmodel.data.pull import LIVE_MAX_AGE_HOURS, _cached

    calls = []
    _cached(tmp_path, "live", _stub(pd.DataFrame({"a": [1]}), calls),
            LIVE_MAX_AGE_HOURS)
    _age(tmp_path / "live.parquet", LIVE_MAX_AGE_HOURS - 1)
    _cached(tmp_path, "live", _stub(pd.DataFrame({"a": [1]}), calls),
            LIVE_MAX_AGE_HOURS)
    assert len(calls) == 1, "a fresh cache was needlessly re-pulled"


def test_a_stale_live_cache_is_re_pulled_and_overwritten(tmp_path):
    from ffmodel.data.pull import LIVE_MAX_AGE_HOURS, _cached

    calls = []
    _cached(tmp_path, "live", _stub(pd.DataFrame({"a": [1]}), calls),
            LIVE_MAX_AGE_HOURS)
    _age(tmp_path / "live.parquet", LIVE_MAX_AGE_HOURS + 1)
    got = _cached(tmp_path, "live", _stub(pd.DataFrame({"a": [2]}), calls),
                  LIVE_MAX_AGE_HOURS)
    assert len(calls) == 2, "a stale live cache was served anyway"
    assert got["a"].tolist() == [2], "the re-pull was not returned"
    # and the refreshed copy is what the NEXT run reads
    assert pd.read_parquet(tmp_path / "live.parquet")["a"].tolist() == [2]


def test_current_nfl_season_turns_over_in_march():
    from datetime import date

    from ffmodel.data.pull import current_nfl_season

    assert current_nfl_season(date(2026, 3, 1)) == 2026    # league year opens
    assert current_nfl_season(date(2026, 2, 28)) == 2025   # still last season
    assert current_nfl_season(date(2026, 8, 28)) == 2026
    assert current_nfl_season(date(2027, 1, 15)) == 2026   # playoffs


def test_a_historical_pull_never_reaches_the_network(tmp_path):
    """The expiry must not turn offline-safe historical pulls into network
    calls: a cache of finished seasons stays valid however old it is."""
    import os
    import time
    from datetime import date

    from ffmodel.data.pull import _cached

    seasons = [2012, 2019]
    calls = []
    _cached(tmp_path, "hist", _stub(pd.DataFrame({"a": [1]}), calls),
            covers_seasons=seasons)
    # Written years ago AND after 2019 ended, so it holds complete seasons.
    old = time.mktime(date(2020, 4, 1).timetuple())
    os.utime(tmp_path / "hist.parquet", (old, old))

    def boom():
        raise AssertionError("a finished-season cache went back to the network")
    _cached(tmp_path, "hist", boom, covers_seasons=seasons)
    assert len(calls) == 1


def test_a_range_ending_in_a_live_season_keeps_expiring(tmp_path):
    from ffmodel.data.pull import LIVE_MAX_AGE_HOURS, _cached, current_nfl_season

    seasons = [2012, current_nfl_season()]
    calls = []
    _cached(tmp_path, "live", _stub(pd.DataFrame({"a": [1]}), calls),
            covers_seasons=seasons)
    _age(tmp_path / "live.parquet", LIVE_MAX_AGE_HOURS + 1)
    _cached(tmp_path, "live", _stub(pd.DataFrame({"a": [2]}), calls),
            covers_seasons=seasons)
    assert len(calls) == 2, "an in-progress season was served from a stale cache"


def test_a_partial_season_cached_before_rollover_does_not_become_immutable(
        tmp_path):
    """THE TWELVE-MONTH FUSE. A range ending in season S, cached during S,
    holds a partial season. Judge immutability by today's calendar alone and
    the moment the year rolls over that partial file is "finished" and frozen
    forever -- the next season's rolling features would be built from whatever
    week the file was written in, with no error anywhere. Immutability has to
    be judged from WHEN THE FILE WAS WRITTEN.
    """
    import os
    import time
    from datetime import date

    from ffmodel.data.pull import _cached, current_nfl_season

    now = date.today()
    last = current_nfl_season() - 1          # a season that is over today
    seasons = [2012, last]
    calls = []
    _cached(tmp_path, "roll", _stub(pd.DataFrame({"a": [1]}), calls),
            covers_seasons=seasons)

    # Backdate the file into the middle of season `last` -- i.e. written while
    # that season was still being played, so it holds a partial season.
    mid = time.mktime(date(last, 11, 1).timetuple())
    os.utime(tmp_path / "roll.parquet", (mid, mid))
    assert date(last, 11, 1) < now           # the rollover has happened

    _cached(tmp_path, "roll", _stub(pd.DataFrame({"a": [2]}), calls),
            covers_seasons=seasons)
    assert len(calls) == 2, ("a partial season captured mid-season was frozen "
                             "as immutable once the calendar rolled over")


def test_current_nfl_season_decides_immutability_from_the_write_date(tmp_path):
    # The same file, written after its newest season ended, IS immutable.
    import os
    import time
    from datetime import date

    from ffmodel.data.pull import _cached, current_nfl_season

    last = current_nfl_season() - 1
    calls = []
    _cached(tmp_path, "done", _stub(pd.DataFrame({"a": [1]}), calls),
            covers_seasons=[2012, last])
    after = time.mktime(date(last + 1, 4, 1).timetuple())   # league year of S+1
    os.utime(tmp_path / "done.parquet", (after, after))

    def boom():
        raise AssertionError("a cache written after the season ended re-pulled")
    _cached(tmp_path, "done", boom, covers_seasons=[2012, last])


def test_a_fully_cached_historical_pull_weekly_is_offline_safe(tmp_path):
    """pull_weekly reads three caches, and the player master is one of them.

    Giving that one an unconditional TTL while the other two follow the season
    range makes a fully cached historical pull reach the network after twelve
    hours -- so offline training and evaluation break, on data that cannot
    have changed. All three must follow the range.
    """
    import os
    import time
    from datetime import date

    import nflreadpy

    from ffmodel.data.pull import _cache_name, pull_weekly

    seasons = [2018, 2019]
    weekly = pd.DataFrame({
        "player_id": ["00-1"], "season": [2019], "week": [1],
        "attempts": [0.0], "receiving_air_yards": [0.0],
        "passing_air_yards": [0.0],
    })
    snaps = pd.DataFrame({"pfr_player_id": ["P1"], "season": [2019],
                          "week": [1], "offense_pct": [0.5]})
    players = pd.DataFrame({"pfr_id": ["P1"], "gsis_id": ["00-1"]})
    for name, frame in [(_cache_name("weekly_v2", seasons), weekly),
                        (_cache_name("snaps", seasons), snaps),
                        ("players", players)]:
        path = tmp_path / f"{name}.parquet"
        frame.to_parquet(path, index=False)
        old = time.mktime(date(2020, 4, 1).timetuple())   # ancient, post-2019
        os.utime(path, (old, old))

    real = nflreadpy.load_players
    nflreadpy.load_players = lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("a fully cached historical pull hit the network"))
    try:
        out = pull_weekly(seasons, cache_dir=tmp_path)
    finally:
        nflreadpy.load_players = real
    assert out["snap_pct"].tolist() == [0.5]


def test_a_cache_refresh_is_written_atomically(tmp_path):
    """The cache is usually the only copy. A refresh that dies mid-write must
    not leave a truncated parquet carrying a fresh mtime, because every later
    call would then read the corruption instead of re-pulling past it."""
    from ffmodel.data.pull import LIVE_MAX_AGE_HOURS, _cached

    calls = []
    _cached(tmp_path, "live", _stub(pd.DataFrame({"a": [1]}), calls),
            LIVE_MAX_AGE_HOURS)
    path = tmp_path / "live.parquet"
    before = path.read_bytes()
    _age(path, LIVE_MAX_AGE_HOURS + 1)

    class _Boom:
        """Writes garbage, THEN fails -- the only shape that distinguishes an
        atomic write from a direct one. A mock that raises before touching the
        file leaves the original intact either way and proves nothing."""
        def to_parquet(self, target, *a, **k):
            with open(target, "wb") as fh:
                fh.write(b"TRUNCATED")
            raise OSError("disk full halfway through")

    with pytest.raises(OSError):
        _cached(tmp_path, "live", lambda: _Boom(), LIVE_MAX_AGE_HOURS)

    assert path.read_bytes() == before, "a failed write clobbered the cache"
    assert not list(tmp_path.glob("*.tmp")), "a temp file was left behind"


def test_an_empty_player_master_is_never_cached(tmp_path):
    """snap_pct joins through this crosswalk, so an empty-but-schema-correct
    response caches silently and leaves every snap_pct NaN -- which reads
    downstream as 'no snap data', not 'the pull came back empty'."""
    import nflreadpy

    from ffmodel.data.pull import _cache_name, pull_weekly, current_nfl_season

    seasons = [current_nfl_season()]
    weekly = pd.DataFrame({
        "player_id": ["00-1"], "season": seasons, "week": [1],
        "attempts": [0.0], "receiving_air_yards": [0.0],
        "passing_air_yards": [0.0],
    })
    snaps = pd.DataFrame({"pfr_player_id": ["P1"], "season": seasons,
                          "week": [1], "offense_pct": [0.5]})
    weekly.to_parquet(tmp_path / f"{_cache_name('weekly_v2', seasons)}.parquet",
                      index=False)
    snaps.to_parquet(tmp_path / f"{_cache_name('snaps', seasons)}.parquet",
                     index=False)

    class _Empty:
        def to_pandas(self):
            return pd.DataFrame(columns=["pfr_id", "gsis_id"])

    real = nflreadpy.load_players
    nflreadpy.load_players = lambda *a, **k: _Empty()
    try:
        with pytest.raises(RuntimeError, match="empty"):
            pull_weekly(seasons, cache_dir=tmp_path)
    finally:
        nflreadpy.load_players = real
    assert not (tmp_path / "players.parquet").exists(), "cached an empty master"
