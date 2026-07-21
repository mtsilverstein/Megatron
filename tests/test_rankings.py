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
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([
        {"id": "9999", "mergename": "name only"},
    ]))
    xwalk = _crosswalk([{"fantasypros_id": "1001", "gsis_id": "00-0022222",
                         "merge_name": "name only"}])
    matched, stats = attach_gsis(snap, xwalk)
    assert matched["player_id"].iloc[0] == "00-0022222"
    assert stats["matched_by_name"] == 1


def test_attach_gsis_drops_unmatched_and_counts_them():
    """A silent drop would bias the consensus pool; unmatched must be
    reported, not swallowed."""
    from ffmodel.data.rankings import attach_gsis, normalize_rankings

    snap = normalize_rankings(_raw_rankings([
        {"id": "1001", "player": "Known"},
        {"id": "7777", "player": "Fringe FA", "mergename": "fringe fa"},
    ]))
    matched, stats = attach_gsis(snap, _crosswalk([{}]))
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
    matched, stats = attach_gsis(snap, xwalk)
    assert len(matched) == 0
    assert stats["unmatched"] == 1
