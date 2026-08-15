import pandas as pd
import pytest

from ffmodel.data.rosters import TEAM_ALIASES, normalize_current_teams


def _raw(rows):
    return pd.DataFrame(
        rows, columns=["gsis_id", "position", "team", "status"])


def test_maps_player_id_to_current_team():
    got = normalize_current_teams(_raw([
        ("00-1", "WR", "NE", "ACT"),
        ("00-2", "RB", "KC", "ACT"),
    ]))
    assert got == {"00-1": "NE", "00-2": "KC"}


def test_arizona_is_translated_to_the_weekly_feeds_code():
    # The roster feed says AZ, every other feed in the project says ARI. Left
    # untranslated, the schedule merge finds no matchup for AZ and silently
    # drops every Cardinal off the board.
    assert TEAM_ALIASES["AZ"] == "ARI"
    assert normalize_current_teams(_raw([("00-1", "WR", "AZ", "ACT")])) \
        == {"00-1": "ARI"}


def test_out_of_scope_positions_are_excluded():
    got = normalize_current_teams(_raw([
        ("00-1", "WR", "NE", "ACT"),
        ("00-2", "K", "NE", "ACT"),
        ("00-3", "DB", "NE", "ACT"),
    ]))
    assert got == {"00-1": "NE"}


def test_rows_without_a_join_key_are_dropped():
    # gsis_id is the join into weekly data; a row without one cannot override
    # anybody, and must not become a None key that matches a missing player_id.
    got = normalize_current_teams(_raw([
        (None, "WR", "NE", "ACT"),
        ("00-1", "RB", "KC", "ACT"),
    ]))
    assert got == {"00-1": "KC"}
    assert None not in got


def test_a_traded_player_resolves_to_his_active_roster():
    # Two rows, one team each. The ACT row must win regardless of frame order,
    # or a stale CUT row from the old team overwrites the real one.
    for rows in ([("00-1", "WR", "OLD", "CUT"), ("00-1", "WR", "NEW", "ACT")],
                 [("00-1", "WR", "NEW", "ACT"), ("00-1", "WR", "OLD", "CUT")]):
        assert normalize_current_teams(_raw(rows)) == {"00-1": "NEW"}


def test_an_unknown_status_still_yields_a_team():
    # Sorting unknown statuses LAST is the point: they lose to ACT but still
    # beat no override at all. `E14` is a real code in the 2026 feed.
    assert normalize_current_teams(_raw([("00-1", "WR", "NE", "E14")])) \
        == {"00-1": "NE"}
    assert normalize_current_teams(_raw([
        ("00-1", "WR", "NE", "E14"), ("00-1", "WR", "KC", "ACT"),
    ])) == {"00-1": "KC"}


def test_a_row_with_no_team_is_dropped_not_mapped_to_nan():
    got = normalize_current_teams(_raw([
        ("00-1", "WR", None, "ACT"), ("00-2", "WR", "NE", "ACT"),
    ]))
    assert got == {"00-2": "NE"}


def test_empty_input_gives_an_empty_map():
    assert normalize_current_teams(_raw([])) == {}
    assert normalize_current_teams(_raw([("00-1", "K", "NE", "ACT")])) == {}


def test_pull_current_teams_reads_the_cache_without_touching_the_network(
        tmp_path):
    # If the cache is honoured, no import of nflreadpy is needed. Writing the
    # parquet under the exact cache name the loader computes proves the wiring.
    from ffmodel.data.pull import _cache_name
    from ffmodel.data.rosters import pull_current_teams

    name = _cache_name("rosters_current", [2026])
    _raw([("00-9", "TE", "AZ", "ACT")]).to_parquet(
        tmp_path / f"{name}.parquet", index=False)
    assert pull_current_teams(2026, cache_dir=tmp_path) == {"00-9": "ARI"}
