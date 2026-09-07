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
    assert cfg.flex_slots == 20
    assert cfg.starters == 8
    assert cfg.total_picks == 150
    assert cfg.rules.pass_td == 6.0
    assert cfg.rules.interception == -2.0
    assert cfg.rules.pass_int_td == -3.0
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


@pytest.mark.parametrize("slug", ["fam", "gabagool"])
def test_locked_scoring_is_published_without_claiming_unprojected_events(slug):
    cfg = load_league(slug)
    payload = cfg.payload()
    mapping = {"pass_yd": "pass_yd", "pass_td": "pass_td", "pass_int": "interception",
               "pass_int_td": "pass_int_td", "rush_yd": "rush_yd", "rush_td": "rush_td",
               "rec_yd": "rec_yd", "rec_td": "rec_td", "rec": "reception",
               "fum_lost": "fumble_lost", "pass_2pt": "two_point",
               "rush_2pt": "two_point", "rec_2pt": "two_point", "st_td": "st_td"}
    for sleeper_key, rule_key in mapping.items():
        assert payload["sleeper_scoring"][sleeper_key] == getattr(cfg.rules, rule_key)
    assert payload["unprojected_scoring"]["pass_int_td"] == -3.0
    assert payload["scoring"]["pass_td"] == 6.0
    assert payload["scoring"]["interception"] == -2.0
    if slug == "fam":
        assert "pass_td_50p" not in payload["unprojected_scoring"]
    else:
        assert payload["unprojected_scoring"]["pass_td_50p"] == 2.0


def test_mismatched_model_and_sleeper_scoring_refuses_generation(tmp_path):
    import yaml
    from pathlib import Path

    data = yaml.safe_load(Path("configs/leagues/fam.yaml").read_text())
    data["scoring"]["pass_td"] = 4.0
    (tmp_path / "fam.yaml").write_text(yaml.safe_dump(data))
    with pytest.raises(ValueError, match="scoring.pass_td disagrees"):
        load_league("fam", tmp_path)
