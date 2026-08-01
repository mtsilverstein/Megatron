import pandas as pd
import pytest


def _raw_rankings(rows):
    """Synthetic nflreadpy load_ff_rankings frame with the noise columns present."""
    base = {
        "player": "Some Guy", "id": "1001", "pos": "WR", "team": "KC",
        "ecr": 10.0, "sd": 2.0, "best": 5.0, "worst": 20.0,
        "mergename": "some guy", "ecr_type": "ro", "page_type": "redraft-overall",
        "scrape_date": "2024-08-30",
        # noise columns that must not survive normalization:
        "player_image_url": "http://x", "rank_delta": 1.0, "fp_page": "p",
    }
    return pd.DataFrame([{**base, **r} for r in rows])


def test_normalize_keeps_only_redraft_overall_consensus_and_skill_positions():
    from ffmodel.data.rankings import normalize_rankings

    raw = _raw_rankings([
        {"id": "1", "pos": "WR"},
        {"id": "2", "pos": "K"},                          # out of scope
        {"id": "3", "pos": "DST"},                        # out of scope
        {"id": "4", "pos": "QB", "ecr_type": "do"},       # dynasty, not redraft
        {"id": "5", "pos": "RB", "page_type": "redraft-idp"},  # wrong page
        {"id": "6", "pos": "TE"},
    ])
    out = normalize_rankings(raw)
    assert sorted(out["fp_id"]) == ["1", "6"]
    assert set(out["pos"]) <= {"QB", "RB", "WR", "TE"}
    assert "player_image_url" not in out.columns
    assert "rank_delta" not in out.columns


def test_normalize_parses_scrape_date_and_stringifies_id():
    from ffmodel.data.rankings import normalize_rankings

    out = normalize_rankings(_raw_rankings([{"id": 1001, "scrape_date": "2024-08-30"}]))
    assert out["fp_id"].iloc[0] == "1001"          # int id -> clean string
    assert out["scrape_date"].iloc[0] == pd.Timestamp("2024-08-30")


def test_preseason_snapshot_is_strictly_before_kickoff():
    """The 2023 trap: the latest August/September scrape (2023-09-08) lands
    AFTER week-1 kickoff (2023-09-07). Selecting it would leak week-1
    results into a 'preseason' ranking."""
    from ffmodel.data.rankings import normalize_rankings, preseason_snapshot

    rankings = normalize_rankings(_raw_rankings([
        {"id": "1", "scrape_date": "2023-08-25", "ecr": 3.0},
        {"id": "2", "scrape_date": "2023-09-01", "ecr": 1.0},   # latest pre-kickoff
        {"id": "3", "scrape_date": "2023-09-08", "ecr": 2.0},   # POST kickoff
    ]))
    snap = preseason_snapshot(rankings, pd.Timestamp("2023-09-07"))
    assert list(snap["fp_id"]) == ["2"]
    assert (snap["scrape_date"] < pd.Timestamp("2023-09-07")).all()


def test_preseason_snapshot_excludes_exact_kickoff_tie():
    """The leak boundary is STRICTLY before kickoff (`<`, not `<=`). A
    scrape timestamped exactly at kickoff is not a preseason opinion; the
    existing before/after test never exercises an exact tie, so a `<` -> `<=`
    regression would leave the suite green while letting a kickoff-instant
    scrape silently enter the preseason consensus."""
    from ffmodel.data.rankings import normalize_rankings, preseason_snapshot

    rankings = normalize_rankings(_raw_rankings([
        {"id": "1", "scrape_date": "2023-08-25", "ecr": 3.0},   # latest pre-kickoff
        {"id": "2", "scrape_date": "2023-09-07", "ecr": 1.0},   # exact kickoff tie
    ]))
    snap = preseason_snapshot(rankings, pd.Timestamp("2023-09-07"))
    assert list(snap["fp_id"]) == ["1"]
    assert (snap["scrape_date"] < pd.Timestamp("2023-09-07")).all()


def test_preseason_snapshot_raises_when_no_pre_kickoff_scrape():
    """Must never silently fall back to a post-kickoff scrape."""
    from ffmodel.data.rankings import normalize_rankings, preseason_snapshot

    rankings = normalize_rankings(_raw_rankings([
        {"id": "1", "scrape_date": "2023-09-08"},
    ]))
    with pytest.raises(ValueError, match="before kickoff"):
        preseason_snapshot(rankings, pd.Timestamp("2023-09-07"))


def test_season_kickoff_is_first_regular_season_game():
    from ffmodel.data.rankings import season_kickoff

    sched = pd.DataFrame({
        "season": [2024, 2024, 2024, 2025],
        "week": [1, 1, 2, 1],
        "game_type": ["REG", "REG", "REG", "REG"],
        "gameday": ["2024-09-08", "2024-09-05", "2024-09-15", "2025-09-04"],
    })
    assert season_kickoff(sched, 2024) == pd.Timestamp("2024-09-05")


def test_season_kickoff_ignores_preseason_games():
    from ffmodel.data.rankings import season_kickoff

    sched = pd.DataFrame({
        "season": [2024, 2024],
        "week": [1, 1],
        "game_type": ["PRE", "REG"],
        "gameday": ["2024-08-08", "2024-09-05"],
    })
    assert season_kickoff(sched, 2024) == pd.Timestamp("2024-09-05")


def test_season_kickoff_works_on_the_production_schedule_shape():
    """Regression: pull_schedules filters to REG and DROPS game_type, so the
    real frame has no such column. Requiring it crashed the benchmark on the
    first live run while every synthetic-fixture test passed."""
    from ffmodel.data.pull import pull_schedules
    from ffmodel.data.rankings import season_kickoff

    import inspect
    assert "game_type" not in inspect.getsource(pull_schedules).split("keep = ")[1].split("]")[0]

    sched = pd.DataFrame({                       # exactly pull_schedules' columns
        "season": [2024, 2024], "week": [1, 2],
        "gameday": ["2024-09-05", "2024-09-12"],
        "home_team": ["KC", "SF"], "away_team": ["DET", "LA"],
        "home_score": [27.0, 20.0], "away_score": [20.0, 17.0], "roof": ["outdoors"] * 2,
    })
    assert season_kickoff(sched, 2024) == pd.Timestamp("2024-09-05")


def test_season_kickoff_raises_for_missing_season():
    from ffmodel.data.rankings import season_kickoff

    sched = pd.DataFrame({"season": [2024], "week": [1], "game_type": ["REG"],
                          "gameday": ["2024-09-05"]})
    with pytest.raises(ValueError, match="2030"):
        season_kickoff(sched, 2030)


def _crosswalk(rows):
    base = {"fantasypros_id": "1001", "gsis_id": "00-0011111",
            "merge_name": "some guy", "position": "WR"}
    return pd.DataFrame([{**base, **r} for r in rows])


def test_attach_gsis_matches_by_fantasypros_id():
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([{"id": "1001"}]))
    matched, stats = attach_gsis(snap, _crosswalk([{}]))
    assert matched["player_id"].iloc[0] == "00-0011111"
    assert stats["matched_by_id"] == 1
    assert stats["unmatched"] == 0


def test_attach_gsis_falls_back_to_merge_name():
    """The most-travelled fallback path in production (58 of 447 rows on a
    live snapshot): a row with a PRESENT, numeric fp_id that finds no match
    in the crosswalk's id map, occurring alongside another row that DOES
    match by id, correctly falls through to name matching. A second,
    id-matching pair is included so the id-join guard (which fires only when
    ids are present on both sides and NOTHING matched) does not trip."""
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([
        {"id": "1001", "player": "Id Match", "mergename": "id match"},
        {"id": "9999", "player": "Name Only", "mergename": "name only"},
    ]))
    xwalk = _crosswalk([
        {},  # default fantasypros_id "1001" -> matches "Id Match" row by id
        {"fantasypros_id": "5555", "gsis_id": "00-0022222",
         "merge_name": "name only"},  # present, numeric, NON-matching id
    ])
    matched, stats = attach_gsis(snap, xwalk)
    id_row = matched[matched["player"] == "Id Match"].iloc[0]
    name_row = matched[matched["player"] == "Name Only"].iloc[0]
    assert id_row["player_id"] == "00-0011111"
    assert name_row["player_id"] == "00-0022222"
    assert stats["matched_by_id"] == 1
    assert stats["matched_by_name"] == 1


def test_attach_gsis_drops_unmatched_and_counts_them():
    """A silent drop would bias the consensus pool; unmatched must be
    reported, not swallowed."""
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([
        {"id": "1001", "player": "Known"},
        {"id": "7777", "player": "Fringe FA", "mergename": "fringe fa"},
    ]))
    matched, stats = attach_gsis(snap, _crosswalk([{}]), min_match_rate=0.0)
    assert len(matched) == 1
    assert stats["unmatched"] == 1
    assert stats["unmatched_players"] == ["Fringe FA"]
    assert stats["ranked"] == 2


def test_attach_gsis_does_not_fan_out_on_duplicate_crosswalk_rows():
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([{"id": "1001"}]))
    xwalk = _crosswalk([
        {"gsis_id": "00-0011111"},
        {"gsis_id": "00-0033333"},      # duplicate fantasypros_id
    ])
    matched, _ = attach_gsis(snap, xwalk)
    assert len(matched) == 1


def test_attach_gsis_ignores_crosswalk_rows_missing_gsis():
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([{"id": "1001"}]))
    xwalk = pd.DataFrame([{"fantasypros_id": "1001", "gsis_id": None,
                           "merge_name": "some guy", "position": "WR"}])
    matched, stats = attach_gsis(snap, xwalk, min_match_rate=0.0)
    assert len(matched) == 0
    assert stats["unmatched"] == 1


def test_attach_gsis_float_crosswalk_id_joins_to_string_snapshot_id():
    """The core bug: ff_playerids' fantasypros_id arrives as float64
    (22953.0) while the rankings snapshot's fp_id is a clean string
    ("22953"). A naive `.astype(str)` join produced "22953.0" != "22953"
    and matched zero rows; the id join must resolve after normalization."""
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([{"id": "22953"}]))
    xwalk = _crosswalk([{"fantasypros_id": 22953.0, "gsis_id": "00-0036322"}])
    matched, stats = attach_gsis(snap, xwalk)
    assert matched["player_id"].iloc[0] == "00-0036322"
    assert stats["matched_by_id"] == 1


def test_attach_gsis_id_match_beats_name_collision_both_directions():
    """Regression: the real Justin Jefferson (MIN, gsis 00-0036322) shares a
    normalized name with a namesake (gsis 00-0041075). With the id join dead,
    every ECR row resolved by name only, and because the namesake happens to
    appear first in the crosswalk, name-based dedupe silently picked the
    WRONG player -- the real Justin Jefferson was left with ecr=None on the
    published board. The id join must win, and must resolve to the correct
    id: asserting only "some id matched" would pass even if the id join
    silently died again and the name join happened to cover for it, so this
    asserts BOTH that the correct id was chosen AND that the namesake's id
    was not."""
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([
        {"id": "22953", "mergename": "justin jefferson"},
    ]))
    xwalk = pd.DataFrame([
        # a namesake sharing the normalized name key, listed FIRST so a
        # broken id join (falling through to name-based dedupe) would pick
        # this row via drop_duplicates(keep="first")
        {"fantasypros_id": 99999.0, "gsis_id": "00-0041075",
         "merge_name": "justin jefferson", "position": "WR"},
        # the real Justin Jefferson: correct id, correct gsis
        {"fantasypros_id": 22953.0, "gsis_id": "00-0036322",
         "merge_name": "justin jefferson", "position": "WR"},
    ])
    matched, stats = attach_gsis(snap, xwalk)
    assert matched["player_id"].iloc[0] == "00-0036322"      # id-matched, correct
    assert matched["player_id"].iloc[0] != "00-0041075"      # not the name-matched namesake
    assert stats["matched_by_id"] == 1
    assert stats["matched_by_name"] == 0


def test_attach_gsis_null_ids_do_not_collide():
    """Nulls on both sides of the id join must never collapse into a shared
    key (e.g. a literal "nan" string) that lets unrelated rows match each
    other; a null/non-numeric fp_id must fall through to name matching."""
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([
        {"id": "", "mergename": "some guy"},   # empty/non-numeric fp_id
    ]))
    xwalk = _crosswalk([
        {"fantasypros_id": None, "gsis_id": "00-0055555", "merge_name": "wrong guy"},
        {"fantasypros_id": None, "gsis_id": "00-0066666", "merge_name": "some guy"},
    ])
    matched, stats = attach_gsis(snap, xwalk)
    assert stats["matched_by_id"] == 0
    assert matched["player_id"].iloc[0] == "00-0066666"   # resolved by name, not id
    assert stats["matched_by_name"] == 1


def test_attach_gsis_non_numeric_id_coerces_to_null_not_raise():
    """A malformed FantasyPros id (non-numeric) must coerce to null and fall
    through to name matching, exactly like an absent id -- pd.to_numeric
    must not raise. A second, well-formed row keeps the id join alive
    overall so this exercises the per-row fallback, not the id-join guard."""
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([
        {"id": "1001", "player": "Known", "mergename": "known guy"},
        {"id": "ABC123", "player": "Bad Id", "mergename": "bad id guy"},
    ]))
    xwalk = pd.DataFrame([
        {"fantasypros_id": "1001", "gsis_id": "00-0011111",
         "merge_name": "known guy", "position": "WR"},
        {"fantasypros_id": "2002", "gsis_id": "00-0022222",
         "merge_name": "bad id guy", "position": "WR"},
    ])
    matched, stats = attach_gsis(snap, xwalk)
    assert stats["matched_by_id"] == 1
    assert stats["matched_by_name"] == 1
    bad = matched[matched["player"] == "Bad Id"].iloc[0]
    assert bad["player_id"] == "00-0022222"


def test_attach_gsis_id_join_guard_raises_when_ids_present_but_zero_overlap():
    """The id join has been silently dead before (matched_by_id stuck at 0
    while nothing looked at it -- the exact bug this whole fix repairs). If
    both the snapshot and the crosswalk carry FantasyPros ids and none
    overlap, that is a structural key-format bug, not missing data: fail
    loudly instead of quietly falling through to name matching."""
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([{"id": "11111", "mergename": "some guy"}]))
    xwalk = _crosswalk([{"fantasypros_id": "99999", "gsis_id": "00-0011111",
                         "merge_name": "some guy"}])
    with pytest.raises(ValueError, match="key-format mismatch"):
        attach_gsis(snap, xwalk)


def test_attach_gsis_id_join_guard_does_not_fire_when_crosswalk_has_no_ids():
    """A crosswalk that legitimately carries no FantasyPros ids at all (pure
    name-only matching) must not trip the id-join guard."""
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([{"id": "1001", "mergename": "some guy"}]))
    xwalk = _crosswalk([{"fantasypros_id": None, "gsis_id": "00-0011111",
                         "merge_name": "some guy"}])
    matched, stats = attach_gsis(snap, xwalk)
    assert matched["player_id"].iloc[0] == "00-0011111"
    assert stats["matched_by_id"] == 0
    assert stats["matched_by_name"] == 1


def test_backfill_draft_gsis_restores_only_blank_ids_by_exact_pfr_id():
    """The rookie identity repair must not overwrite a live player-id row
    or rely on a fuzzy player-name match."""
    from ffmodel.data.rankings import _backfill_draft_gsis

    crosswalk = pd.DataFrame([
        {"pfr_id": "Rookie00", "gsis_id": None},
        {"pfr_id": "Veteran00", "gsis_id": "00-0001"},
    ])
    picks = pd.DataFrame([
        {"pfr_player_id": "Rookie00", "gsis_id": "ROO123456"},
        {"pfr_player_id": "Veteran00", "gsis_id": "WRONG0000"},
    ])

    out, restored = _backfill_draft_gsis(crosswalk, picks)
    assert restored == 1
    assert list(out["gsis_id"]) == ["ROO123456", "00-0001"]


def test_canonicalize_draft_gsis_rewrites_a_placeholder():
    """A draft-picks id absent from the identity crosswalk, whose PFR id
    bridges to a canonical id there, is rewritten."""
    from ffmodel.data.rankings import canonicalize_draft_gsis

    crosswalk = pd.DataFrame([
        {"pfr_id": "LoveJe00", "gsis_id": "00-0041027"},
    ])
    draft_picks = pd.DataFrame([
        {"pfr_player_id": "LoveJe00", "gsis_id": "LOV121782"},
    ])

    out, rewritten = canonicalize_draft_gsis(draft_picks, crosswalk)
    assert rewritten == 1
    assert list(out["gsis_id"]) == ["00-0041027"]


def test_canonicalize_draft_gsis_leaves_an_already_canonical_row_alone():
    """The historical-cohort no-op guarantee: a draft-picks id already
    present in the crosswalk's known-id set must not be touched, even if a
    PFR bridge to some other id also exists."""
    from ffmodel.data.rankings import canonicalize_draft_gsis

    crosswalk = pd.DataFrame([
        {"pfr_id": "VetXx00", "gsis_id": "00-0011111"},
    ])
    draft_picks = pd.DataFrame([
        {"pfr_player_id": "VetXx00", "gsis_id": "00-0011111"},
    ])

    out, rewritten = canonicalize_draft_gsis(draft_picks, crosswalk)
    assert rewritten == 0
    assert list(out["gsis_id"]) == ["00-0011111"]


def test_canonicalize_draft_gsis_leaves_a_row_with_no_pfr_bridge_alone():
    """Placeholder id absent from the crosswalk, but its PFR id maps to
    nothing there -> left untouched (not silently dropped or guessed)."""
    from ffmodel.data.rankings import canonicalize_draft_gsis

    crosswalk = pd.DataFrame([
        {"pfr_id": "SomeoneElse00", "gsis_id": "00-0099999"},
    ])
    draft_picks = pd.DataFrame([
        {"pfr_player_id": "Unbridged00", "gsis_id": "PLACEHOLDER1"},
    ])

    out, rewritten = canonicalize_draft_gsis(draft_picks, crosswalk)
    assert rewritten == 0
    assert list(out["gsis_id"]) == ["PLACEHOLDER1"]


def test_canonicalize_draft_gsis_leaves_a_null_gsis_id_alone():
    from ffmodel.data.rankings import canonicalize_draft_gsis

    crosswalk = pd.DataFrame([
        {"pfr_id": "Nully00", "gsis_id": "00-0055555"},
    ])
    draft_picks = pd.DataFrame([
        {"pfr_player_id": "Nully00", "gsis_id": None},
    ])

    out, rewritten = canonicalize_draft_gsis(draft_picks, crosswalk)
    assert rewritten == 0
    assert out["gsis_id"].iloc[0] is None or pd.isna(out["gsis_id"].iloc[0])


def test_canonicalize_draft_gsis_raises_on_conflicting_pfr_mapping():
    """Mirrors `_backfill_draft_gsis`'s conflict discipline: a single PFR id
    that maps to more than one canonical gsis id in the crosswalk must raise,
    never guess."""
    from ffmodel.data.rankings import canonicalize_draft_gsis

    crosswalk = pd.DataFrame([
        {"pfr_id": "Ambig00", "gsis_id": "00-0011111"},
        {"pfr_id": "Ambig00", "gsis_id": "00-0022222"},
    ])
    draft_picks = pd.DataFrame([
        {"pfr_player_id": "Ambig00", "gsis_id": "PLACEHOLDER1"},
    ])

    with pytest.raises(ValueError, match="Ambig00"):
        canonicalize_draft_gsis(draft_picks, crosswalk)


def test_canonicalize_draft_gsis_does_not_mutate_the_callers_frame():
    from ffmodel.data.rankings import canonicalize_draft_gsis

    crosswalk = pd.DataFrame([
        {"pfr_id": "LoveJe00", "gsis_id": "00-0041027"},
    ])
    draft_picks = pd.DataFrame([
        {"pfr_player_id": "LoveJe00", "gsis_id": "LOV121782"},
    ])
    original = draft_picks.copy()

    canonicalize_draft_gsis(draft_picks, crosswalk)
    pd.testing.assert_frame_equal(draft_picks, original)


def test_canonicalize_draft_gsis_missing_required_columns_raises():
    from ffmodel.data.rankings import canonicalize_draft_gsis

    with pytest.raises(ValueError, match="pfr_player_id"):
        canonicalize_draft_gsis(pd.DataFrame({"gsis_id": ["x"]}),
                                pd.DataFrame({"pfr_id": ["y"], "gsis_id": ["z"]}))
    with pytest.raises(ValueError, match="pfr_id"):
        canonicalize_draft_gsis(pd.DataFrame({"pfr_player_id": ["y"], "gsis_id": ["z"]}),
                                pd.DataFrame({"gsis_id": ["z"]}))


def test_merge_name_fallback_survives_case_mismatch_between_feeds():
    """Regression (dead-code class): ff_rankings' `mergename` is Title-Case
    since 2022 while ff_playerids' `merge_name` is lowercase, so a raw
    equality join matched 0% and the advertised fallback could never fire.
    The original test compared two identical literals and passed vacuously.

    The case-mismatch row carries a PRESENT, numeric, NON-matching fp_id (the
    production shape of this fallback) alongside a second row that DOES
    match by id, so the id-join guard does not trip."""
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([
        {"id": "1001", "player": "Id Match", "mergename": "id match"},
        {"id": "9999", "player": "Case Mismatch",
         "mergename": "Christian McCaffrey"},   # feed casing
    ]))
    xwalk = _crosswalk([
        {},  # default fantasypros_id "1001" -> matches "Id Match" row by id
        {"fantasypros_id": "5555", "gsis_id": "00-0044444",
         "merge_name": "christian mccaffrey"},  # crosswalk casing, non-matching id
    ])
    matched, stats = attach_gsis(snap, xwalk)
    id_row = matched[matched["player"] == "Id Match"].iloc[0]
    cmc_row = matched[matched["player"] == "Case Mismatch"].iloc[0]
    assert id_row["player_id"] == "00-0011111"
    assert cmc_row["player_id"] == "00-0044444"
    assert stats["matched_by_id"] == 1
    assert stats["matched_by_name"] == 1


def test_attach_gsis_raises_below_match_rate_floor():
    """A partial crosswalk degradation must fail loudly, not silently
    benchmark against a thinned consensus pool."""
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([
        {"id": str(i), "player": f"P{i}", "mergename": f"p{i}"} for i in range(10)
    ]))
    xwalk = _crosswalk([{"fantasypros_id": "0", "gsis_id": "00-0001",
                         "merge_name": "p0"}])          # 1/10 = 10%
    with pytest.raises(ValueError, match="refusing to benchmark"):
        attach_gsis(snap, xwalk)


def test_attach_gsis_counts_gsis_collisions():
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([
        {"id": "1", "player": "Dup A", "ecr": 5.0},
        {"id": "2", "player": "Dup B", "ecr": 9.0},
    ]))
    xwalk = pd.DataFrame([
        {"fantasypros_id": "1", "gsis_id": "00-0001", "merge_name": "a", "position": "WR"},
        {"fantasypros_id": "2", "gsis_id": "00-0001", "merge_name": "b", "position": "WR"},
    ])
    matched, stats = attach_gsis(snap, xwalk)
    assert len(matched) == 1
    assert stats["gsis_collisions"] == 1
    assert matched["ecr"].iloc[0] == pytest.approx(5.0)   # better rank kept


def test_rest_of_season_pages_are_filtered_out():
    """The (ro, redraft-overall) slice also contains in-season ROS pages; an
    ROS scrape landing before a future kickoff would otherwise silently
    become the 'preseason' consensus."""
    from ffmodel.data.rankings import normalize_rankings

    raw = _raw_rankings([
        {"id": "1", "fp_page": "https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php"},
        {"id": "2", "fp_page": "https://www.fantasypros.com/nfl/rankings/ros-ppr-overall.php"},
    ])
    out = normalize_rankings(raw)
    assert list(out["fp_id"]) == ["1"]


def test_snapshot_spanning_two_source_pages_raises():
    """Two pages sharing a date must never be merged: the ecr-ascending
    dedupe would silently cherry-pick the friendlier of two rankings."""
    from ffmodel.data.rankings import normalize_rankings, preseason_snapshot

    raw = _raw_rankings([
        {"id": "1", "fp_page": "page-a", "scrape_date": "2024-08-30"},
        {"id": "2", "fp_page": "page-b", "scrape_date": "2024-08-30"},
    ])
    with pytest.raises(ValueError, match="multiple source pages"):
        preseason_snapshot(normalize_rankings(raw), pd.Timestamp("2024-09-05"))
