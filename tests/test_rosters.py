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

    from ffmodel.data.rosters import MIN_PLAYERS_PER_POSITION

    name = _cache_name("rosters_current", [2026])
    # Padded to a feed the truncation guard accepts; the AZ->ARI row is still
    # the one the assertion is about.
    n = MIN_PLAYERS_PER_POSITION
    rows = [("00-9", "TE", "AZ", "ACT")]
    rows += [(f"00-{pos}{i}", pos, "NE", "ACT")
             for pos in ("QB", "RB", "WR", "TE") for i in range(n)]
    _raw(rows).to_parquet(tmp_path / f"{name}.parquet", index=False)
    assert pull_current_teams(2026, cache_dir=tmp_path)["00-9"] == "ARI"


# --- coverage guard ----------------------------------------------------------
# An empty roster map is indistinguishable downstream from "no override was
# asked for": future_skeleton tests `if current_teams:`, so a feed that
# downloads fine and comes back empty publishes last-played teams instead of
# aborting. That is the incomplete-pull case the fail-safe rule covers.

SCHEDULED = {"AAA", "BBB", "CCC"}


def _map_over(teams, per_team=None):
    """{player_id: team} with enough players per team to clear the floor."""
    from ffmodel.data.rosters import MIN_PLAYERS_PER_TEAM
    n = MIN_PLAYERS_PER_TEAM if per_team is None else per_team
    return {f"{t}-{i}": t for t in teams for i in range(n)}


def test_a_map_covering_every_scheduled_team_is_accepted():
    from ffmodel.data.rosters import assert_roster_coverage
    assert_roster_coverage(_map_over(SCHEDULED), SCHEDULED)


def test_an_empty_map_is_refused():
    from ffmodel.data.rosters import assert_roster_coverage
    with pytest.raises(RuntimeError, match="refusing to publish"):
        assert_roster_coverage({}, SCHEDULED)


def test_a_scheduled_team_with_no_rostered_player_is_refused_and_named():
    from ffmodel.data.rosters import assert_roster_coverage
    with pytest.raises(RuntimeError, match="CCC"):
        assert_roster_coverage(_map_over({"AAA", "BBB"}), SCHEDULED)


def test_a_team_the_schedule_has_never_heard_of_is_refused():
    # The AZ/ARI failure mode. future_skeleton merges players onto matchups BY
    # TEAM, so a spelling the schedule does not use drops that whole roster as
    # though the team were on bye -- silently, since a dropped player is
    # simply absent from the payload. Coverage in the other direction is
    # complete here, so only the unknown spelling can fail this.
    from ffmodel.data.rosters import assert_roster_coverage
    with pytest.raises(RuntimeError, match="TEAM_ALIASES"):
        assert_roster_coverage(_map_over(SCHEDULED | {"AZ"}), SCHEDULED)


def test_a_token_row_per_franchise_is_refused():
    # The truncation a team-name check cannot see: every scheduled team is
    # present, both set differences are empty, and almost every player is
    # still sitting on last season's team.
    from ffmodel.data.rosters import MIN_PLAYERS_PER_TEAM, assert_roster_coverage
    token = _map_over(SCHEDULED, per_team=1)
    assert set(token.values()) == SCHEDULED     # both set differences empty
    with pytest.raises(RuntimeError, match="truncated"):
        assert_roster_coverage(token, SCHEDULED)
    with pytest.raises(RuntimeError, match="truncated"):
        assert_roster_coverage(_map_over(SCHEDULED, MIN_PLAYERS_PER_TEAM - 1),
                               SCHEDULED)


def test_a_healthy_per_team_count_is_accepted():
    from ffmodel.data.rosters import MIN_PLAYERS_PER_TEAM, assert_roster_coverage
    assert_roster_coverage(_map_over(SCHEDULED, MIN_PLAYERS_PER_TEAM), SCHEDULED)


def _roster_frame(counts: dict[str, int]) -> pd.DataFrame:
    rows = [{"gsis_id": f"00-{pos}{i}", "position": pos, "team": "NE",
             "status": "ACT"}
            for pos, n in counts.items() for i in range(n)]
    return pd.DataFrame(rows, columns=["gsis_id", "position", "team", "status"])


def test_a_feed_that_renamed_a_position_is_refused():
    # 32 teams, healthy per-team counts, and every wide receiver silently
    # keeping the team he last played for -- neither other guard sees it.
    from ffmodel.data.rosters import MIN_PLAYERS_PER_POSITION, assert_positions_present
    n = MIN_PLAYERS_PER_POSITION
    ok = {"QB": n, "RB": n, "WR": n, "TE": n}
    assert_positions_present(_roster_frame(ok))
    renamed = dict(ok, WR=0)
    renamed["REC"] = n
    with pytest.raises(RuntimeError, match="renamed a position"):
        assert_positions_present(_roster_frame(renamed))


def test_a_position_thinned_below_one_per_franchise_is_refused():
    from ffmodel.data.rosters import MIN_PLAYERS_PER_POSITION, assert_positions_present
    n = MIN_PLAYERS_PER_POSITION
    with pytest.raises(RuntimeError, match="TE"):
        assert_positions_present(_roster_frame({"QB": n, "RB": n, "WR": n,
                                                "TE": n - 1}))


def test_rows_without_a_join_key_do_not_count_toward_a_position():
    # A player with no gsis id cannot be joined to weekly data, so he is not
    # coverage -- counting him would let a feed of unjoinable rows pass.
    from ffmodel.data.rosters import MIN_PLAYERS_PER_POSITION, assert_positions_present
    n = MIN_PLAYERS_PER_POSITION
    frame = _roster_frame({"QB": n, "RB": n, "WR": n, "TE": n})
    frame.loc[frame["position"] == "TE", "gsis_id"] = pd.NA
    with pytest.raises(RuntimeError, match="TE"):
        assert_positions_present(frame)


def test_pull_current_teams_refuses_a_truncated_feed(tmp_path):
    # The position guard is only worth having if the pull actually runs it;
    # without this, deleting the call from pull_current_teams passes every
    # other test in this file.
    from ffmodel.data.pull import _cache_name
    from ffmodel.data.rosters import MIN_PLAYERS_PER_POSITION, pull_current_teams

    n = MIN_PLAYERS_PER_POSITION
    rows = [(f"00-{pos}{i}", pos, "NE", "ACT")
            for pos in ("QB", "RB", "WR") for i in range(n)]   # no TE at all
    name = _cache_name("rosters_current", [2026])
    _raw(rows).to_parquet(tmp_path / f"{name}.parquet", index=False)
    with pytest.raises(RuntimeError, match="TE"):
        pull_current_teams(2026, cache_dir=tmp_path)


def test_a_position_with_no_team_on_any_row_is_refused():
    # The feed can populate gsis_id and position while blanking `team` --
    # normalize_current_teams then drops every one of those rows, so counting
    # raw rows would clear the floor on players the mapping never contains.
    # The guard has to count what survives normalization, not what arrived.
    from ffmodel.data.rosters import (MIN_PLAYERS_PER_POSITION,
                                      assert_positions_present,
                                      normalize_current_teams)
    n = MIN_PLAYERS_PER_POSITION
    frame = _roster_frame({"QB": n, "RB": n, "WR": n, "TE": n})
    frame.loc[frame["position"] == "TE", "team"] = pd.NA
    assert not any(p.startswith("00-TE") for p in normalize_current_teams(frame))
    with pytest.raises(RuntimeError, match="TE"):
        assert_positions_present(frame)
