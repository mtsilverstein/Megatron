import json

import pytest

from ffmodel.site.sleeper import _normalize_name, build_crosswalk, pull_sleeper_players


# --- name normalization -------------------------------------------------------

def test_normalize_lowercases_and_strips_punctuation():
    assert _normalize_name("Ja'Marr Chase") == "jamarr chase"
    assert _normalize_name("A.J. Brown") == "aj brown"
    assert _normalize_name("Clyde Edwards-Helaire") == "clyde edwardshelaire"


def test_normalize_strips_generation_suffixes():
    assert _normalize_name("Odell Beckham Jr.") == "odell beckham"
    assert _normalize_name("Marvin Harrison Jr") == "marvin harrison"
    assert _normalize_name("Patrick Surtain II") == "patrick surtain"
    assert _normalize_name("Will Fuller V") == "will fuller v"   # V not stripped (real-name risk)


def test_normalize_collapses_whitespace():
    assert _normalize_name("  Kenneth   Walker  III ") == "kenneth walker"


# --- crosswalk ----------------------------------------------------------------

def _board(*players):
    return [{"player_id": pid, "name": name, "position": pos}
            for pid, name, pos in players]


def test_gsis_exact_match_including_whitespace_quirk():
    # Sleeper's gsis_id field is known to carry stray whitespace.
    sleeper = {"4046": {"gsis_id": " 00-0033873", "full_name": "Patrick Mahomes",
                        "position": "QB"}}
    mapping, stats = build_crosswalk(_board(("00-0033873", "Patrick Mahomes", "QB")), sleeper)
    assert mapping == {"00-0033873": "4046"}
    assert stats == {"matched_gsis": 1, "matched_name": 0, "unmatched": 0,
                     "unmatched_names": []}


def test_name_position_fallback_when_gsis_missing():
    sleeper = {"9999": {"gsis_id": None, "full_name": "Rookie Guy Jr.",
                        "position": "WR"}}
    mapping, stats = build_crosswalk(_board(("00-0099999", "Rookie Guy", "WR")), sleeper)
    assert mapping == {"00-0099999": "9999"}
    assert stats["matched_name"] == 1 and stats["matched_gsis"] == 0


def test_name_fallback_requires_position_match():
    sleeper = {"9999": {"gsis_id": None, "full_name": "Taysom Hill", "position": "TE"}}
    mapping, stats = build_crosswalk(_board(("00-0099998", "Taysom Hill", "QB")), sleeper)
    assert mapping == {}
    assert stats["unmatched"] == 1 and stats["unmatched_names"] == ["Taysom Hill"]


def test_ambiguous_sleeper_side_is_unmatched_never_guessed():
    # Two Sleeper entries normalize to the same (name, position): no gsis on
    # either -> the board player must be UNMATCHED, not assigned arbitrarily.
    sleeper = {
        "1001": {"gsis_id": None, "full_name": "Mike Williams", "position": "WR"},
        "1002": {"gsis_id": None, "full_name": "Mike Williams", "position": "WR"},
    }
    mapping, stats = build_crosswalk(_board(("00-0011111", "Mike Williams", "WR")), sleeper)
    assert mapping == {}
    assert stats["unmatched"] == 1


def test_ambiguous_board_side_is_unmatched_never_guessed():
    # Two BOARD players share a normalized (name, position); only one Sleeper
    # candidate exists. Neither may claim it via the name path.
    sleeper = {"1001": {"gsis_id": None, "full_name": "Mike Williams", "position": "WR"}}
    board = _board(("00-0011111", "Mike Williams", "WR"),
                   ("00-0022222", "Mike Williams", "WR"))
    mapping, stats = build_crosswalk(board, sleeper)
    assert mapping == {}
    assert stats["unmatched"] == 2


def test_duplicate_gsis_in_sleeper_dump_falls_back_to_name():
    # Data error in the dump: two entries claim the same gsis_id. The gsis
    # path must not pick one arbitrarily; the name path may still resolve it
    # if unambiguous.
    sleeper = {
        "1001": {"gsis_id": "00-0033873", "full_name": "Patrick Mahomes", "position": "QB"},
        "1002": {"gsis_id": "00-0033873", "full_name": "Someone Else", "position": "QB"},
    }
    mapping, stats = build_crosswalk(_board(("00-0033873", "Patrick Mahomes", "QB")), sleeper)
    assert mapping == {"00-0033873": "1001"}
    assert stats["matched_name"] == 1 and stats["matched_gsis"] == 0


def test_unmatched_rookie_listed_by_name():
    mapping, stats = build_crosswalk(_board(("00-0099997", "Unknown Rookie", "RB")), {})
    assert mapping == {}
    assert stats == {"matched_gsis": 0, "matched_name": 0, "unmatched": 1,
                     "unmatched_names": ["Unknown Rookie"]}


def test_stats_counts_add_up_across_paths():
    sleeper = {
        "1": {"gsis_id": "00-0000001", "full_name": "Vet One", "position": "QB"},
        "2": {"gsis_id": None, "full_name": "Name Match", "position": "RB"},
    }
    board = _board(("00-0000001", "Vet One", "QB"),
                   ("00-0000002", "Name Match", "RB"),
                   ("00-0000003", "No Match", "WR"))
    mapping, stats = build_crosswalk(board, sleeper)
    assert len(mapping) == 2
    assert stats["matched_gsis"] + stats["matched_name"] + stats["unmatched"] == len(board)


def test_sleeper_entries_without_name_or_position_are_skipped():
    # Team-defense entries ("KC": {"position": "DEF", no full_name}) and other
    # malformed rows must not crash the index build.
    sleeper = {"KC": {"position": "DEF"}, "X": {}, "1": None}
    mapping, stats = build_crosswalk(_board(("00-0000001", "Some Guy", "QB")), sleeper)
    assert mapping == {} and stats["unmatched"] == 1


# --- pull_sleeper_players -------------------------------------------------------


def _fake_dump(n: int = 1200, with_gsis: int = 200) -> dict:
    dump = {}
    for i in range(n):
        gsis = f"00-{i:07d}" if i < with_gsis else None
        dump[str(i)] = {"gsis_id": gsis, "full_name": f"Player {i}", "position": "WR"}
    return dump


def test_pull_uses_cache_when_present(tmp_path):
    (tmp_path / "sleeper_players.json").write_text(json.dumps(_fake_dump()))
    # No network stub installed: a fetch attempt would blow up loudly.
    data = pull_sleeper_players(cache_dir=tmp_path)
    assert len(data) == 1200


def test_pull_fetches_validates_and_writes_cache(tmp_path, monkeypatch):
    import ffmodel.site.sleeper as sleeper_mod

    monkeypatch.setattr(sleeper_mod, "_fetch_players", lambda: _fake_dump())
    data = pull_sleeper_players(cache_dir=tmp_path)
    assert len(data) == 1200
    cached = json.loads((tmp_path / "sleeper_players.json").read_text())
    assert cached == data


def test_pull_rejects_tiny_dump(tmp_path, monkeypatch):
    import ffmodel.site.sleeper as sleeper_mod

    monkeypatch.setattr(sleeper_mod, "_fetch_players", lambda: _fake_dump(n=50))
    with pytest.raises(RuntimeError, match="suspicious"):
        pull_sleeper_players(cache_dir=tmp_path)
    assert not (tmp_path / "sleeper_players.json").exists()   # nothing cached


def test_pull_rejects_dump_without_gsis_ids(tmp_path, monkeypatch):
    import ffmodel.site.sleeper as sleeper_mod

    monkeypatch.setattr(sleeper_mod, "_fetch_players",
                        lambda: _fake_dump(with_gsis=0))
    with pytest.raises(RuntimeError, match="gsis"):
        pull_sleeper_players(cache_dir=tmp_path)


def test_pull_revalidates_cached_copy(tmp_path):
    (tmp_path / "sleeper_players.json").write_text(json.dumps({"1": {}}))
    with pytest.raises(RuntimeError, match="suspicious"):
        pull_sleeper_players(cache_dir=tmp_path)


def test_pull_propagates_fetch_failure(tmp_path, monkeypatch):
    import ffmodel.site.sleeper as sleeper_mod

    def boom():
        raise OSError("connection refused")
    monkeypatch.setattr(sleeper_mod, "_fetch_players", boom)
    with pytest.raises(OSError):
        pull_sleeper_players(cache_dir=tmp_path)
