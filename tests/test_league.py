import pytest

from ffmodel.league import load_league


def test_gabagool_matches_todays_hardcoded_constants():
    cfg = load_league("gabagool")
    # These are the values generate.py hardcoded as LEAGUE_DEDICATED /
    # LEAGUE_FLEX_SLOTS. If the YAML disagrees, the byte-identity gate in
    # Task 4 will fail -- catch it here, where the message is legible.
    assert cfg.dedicated == {"QB": 12, "RB": 24, "WR": 24, "TE": 12}
    assert cfg.flex_slots == 24
    assert cfg.starters == 8
    assert cfg.total_picks == 180
    assert cfg.rules.pass_td == 6.0
    assert cfg.rules.interception == -2.0
    assert cfg.keeper_rules == "gabagool"


def test_fam_derives_a_ten_team_contract():
    cfg = load_league("fam")
    assert cfg.dedicated == {"QB": 10, "RB": 20, "WR": 20, "TE": 10}
    assert cfg.flex_slots == 10
    assert cfg.starters == 7          # one fewer flex than Gabagool
    assert cfg.total_picks == 140
    assert cfg.rules.pass_td == 4.0
    assert cfg.rules.interception == -1.0
    assert cfg.keeper_rules is None   # FAM's keeper rule is not implemented


def test_board_ruleset_key_is_league_for_every_league():
    # season_points.league is a published payload key and optimizer.js's
    # VALUE_LENS_ORDER reads it. The key is constant; the YAML decides what
    # it means. Renaming it per league breaks both boards' value lens.
    assert load_league("gabagool").rules.name == "league"
    assert load_league("fam").rules.name == "league"


def test_per_team_and_league_wide_flex_are_not_the_same_number():
    cfg = load_league("gabagool")
    assert cfg.flex == 2           # per team, what the browser wants
    assert cfg.flex_slots == 24    # league-wide, what replacement wants


def test_unknown_slug_raises_rather_than_falling_back():
    with pytest.raises(FileNotFoundError, match="no league config"):
        load_league("no_such_league")


def test_payload_omits_keeper_rules_when_absent():
    assert "keeper_rules" not in load_league("fam").payload()
    assert load_league("gabagool").payload()["keeper_rules"] == "gabagool"


def test_board_file_keeps_gabagool_at_the_existing_name():
    assert load_league("gabagool").board_file == "draft.json"
    assert load_league("fam").board_file == "draft-fam.json"
