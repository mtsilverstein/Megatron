import pytest

from ffmodel.site.generate import validate_draftable_coverage


def board():
    return {"players": [{"player_id": "a", "name": "A", "ecr": 88.,
                         "adp": 99., "sleeper_id": "1"}]}


def test_complete_market_coverage_and_outside_draft_tail():
    assert validate_draftable_coverage(board(), {"a": 88, "tail": 300},
                                       {"a": 99}, 180) == {
        "bound": 180, "ecr": 1, "adp": 1, "union": 1,
        "represented": 1, "missing": 0}


def test_crosswalk_success_does_not_hide_missing_board_player():
    with pytest.raises(RuntimeError, match="absent"):
        validate_draftable_coverage(board(), {"a": 88, "missing": 106}, {}, 180)


def test_adp_only_missing_player_is_rejected():
    with pytest.raises(RuntimeError, match="absent"):
        validate_draftable_coverage(board(), {}, {"missing": 160}, 180)


def test_rookie_without_joined_market_rank_is_rejected():
    b = board()
    b["players"][0]["ecr"] = None
    with pytest.raises(RuntimeError, match="lost/changed ecr"):
        validate_draftable_coverage(b, {"a": 88}, {}, 180)


def test_missing_sleeper_mapping_is_rejected():
    b = board()
    b["players"][0]["sleeper_id"] = None
    with pytest.raises(RuntimeError, match="Sleeper id"):
        validate_draftable_coverage(b, {"a": 88}, {}, 180)


def test_duplicate_identity_is_rejected():
    b = board()
    b["players"].append(dict(b["players"][0]))
    with pytest.raises(RuntimeError, match="duplicate player ids"):
        validate_draftable_coverage(b, {"a": 88}, {}, 180)


def test_duplicate_sleeper_mapping_is_rejected():
    b = board()
    b["players"].append(dict(b["players"][0], player_id="b"))
    with pytest.raises(RuntimeError, match="Sleeper id"):
        validate_draftable_coverage(b, {"a": 88, "b": 88}, {}, 180)


def test_returning_player_display_name_collision_fails_closed(tmp_path):
    import pandas as pd
    from ffmodel.site.generate import _load_returning
    cfg = tmp_path / "returning.yaml"
    cfg.write_text("season: 2026\nplayers: [Same Name]\n")
    history = pd.DataFrame({"player_id": ["one", "two"],
        "player_display_name": ["Same Name", "Same Name"], "season": [2024, 2025]})
    with pytest.raises(ValueError, match="ambiguous returning-player"):
        _load_returning(cfg, history, 2026)
