import copy
import json
from pathlib import Path

import pytest

from ffmodel import formats as F
from ffmodel.eval import export_origin_forecasts as X
from ffmodel.league import load_league

LABELS = ["f12-1qb-ppr-6", "f10-1qb-ppr-6", "f12-1qb-ppr-4", "f12-sf-ppr-4", "f12-1qb-half-4"]
PRIMARY = LABELS[:4]
FIX = json.loads((Path(__file__).parent / "fixtures" / "owner_league_settings.json").read_text())


def live(slug):
    return copy.deepcopy(FIX[slug])


def test_owner_leagues_match_their_formats():
    assert F.match(live("gabagool"), LABELS) == "f12-1qb-ppr-6"
    assert F.match(live("fam"), LABELS) == "f10-1qb-ppr-6"


def test_roster_size_from_live_positions():
    for slug in FIX:
        desc, _ = F.describe_sleeper(FIX[slug])
        assert desc["roster_size"] == 13
        assert [s[0] for s in desc["slots"]].count("FLEX") == 2
    assert all(F.load_format(label).roster_size == 13 for label in LABELS)


def test_five_keys_distinct():
    keys = [F.format_key(F.load_format(label)) for label in LABELS]
    assert len(set(keys)) == 5
    assert all(len(k) == 64 and int(k, 16) >= 0 for k in keys)


def test_same_key_different_compat_does_not_match():
    base = live("gabagool")
    key0, compat0 = F.from_sleeper(base)
    for edit in ({"pass_int_td": 0.0}, {"pass_td_50p": 0.0}, {"bonus_rec_te": 0.5}):
        lg = live("gabagool")
        lg["scoring_settings"].update(edit)
        key, cmp_ = F.from_sleeper(lg)
        assert key == key0 and cmp_ != compat0
        assert F.match(lg, LABELS) is None


def test_unknown_nonzero_offensive_key_fails_closed():
    lg = live("gabagool")
    lg["scoring_settings"]["mystery_off_bonus"] = 1.0
    assert F.match(lg, LABELS) is None
    lg["scoring_settings"]["mystery_off_bonus"] = 0.0     # zero is omitted
    assert F.match(lg, LABELS) == "f12-1qb-ppr-6"


def test_unknown_roster_slot_fails_closed():
    lg = live("gabagool")
    lg["roster_positions"].append("IDP_FLEX")
    assert F.match(lg, LABELS) is None


def test_k_def_idp_changes_do_not_move_either_part():
    base = F.from_sleeper(live("fam"))
    lg = live("fam")
    lg["scoring_settings"].update({"fgm_40_49": 9.0, "xpm": 3.0, "sack": 5.0, "int": 4.0,
                                  "pts_allow_0": 1.0, "def_td": 1.0, "idp_pass_def_3p": 2.0,
                                  "st_ff": 3.0, "ff": 2.0, "tkl": 1.0})
    assert F.from_sleeper(lg) == base


def test_ir_taxi_ignored_bn_counts():
    base_desc, base_compat = F.describe_sleeper(live("gabagool"))
    lg = live("gabagool")
    lg["roster_positions"] += ["IR", "IR", "TAXI"]
    assert F.describe_sleeper(lg) == (base_desc, base_compat)
    lg["roster_positions"].append("BN")
    desc, _ = F.describe_sleeper(lg)
    assert desc["roster_size"] == base_desc["roster_size"] + 1
    assert F.from_sleeper(lg)[0] != F.from_sleeper(live("gabagool"))[0]


def test_flex_variants_and_superflex_map():
    lg = live("gabagool")
    lg["roster_positions"] = ["QB", "RB", "WR", "TE", "SUPER_FLEX", "REC_FLEX", "WRRB_FLEX", "BN"]
    desc, _ = F.describe_sleeper(lg)
    assert ["SUPER_FLEX", ["QB", "RB", "TE", "WR"]] in desc["slots"]
    assert ["REC_FLEX", ["TE", "WR"]] in desc["slots"]
    assert ["WRRB_FLEX", ["RB", "WR"]] in desc["slots"]


def test_predicted_is_the_eleven_components():
    desc = F.describe(F.load_format("f12-1qb-ppr-4"))
    assert len(desc["predicted"]) == 11
    assert desc["predicted"]["passing_tds"] == 4.0 and desc["predicted"]["carries"] == 0.0


def test_canonical_normalizes_numbers():
    assert F.canonical({"b": -0.0, "a": 6.0, "c": 0.0400001}) == '{"a":6,"b":0,"c":0.04}'


def test_format_configs_require_roster_size():
    for label in LABELS:
        assert F.load_format(label).roster_size is not None


def test_exporter_accepts_league_dir():
    args = X.build_parser().parse_args(
        ["--season", "2025", "--origin", "5", "--out", "x.json",
         "--league-dir", "configs/formats", "--league", "f12-1qb-ppr-4"])
    cfg = load_league(args.league, root=args.league_dir)
    assert cfg.slug == "f12-1qb-ppr-4"
    meta = X.format_meta(cfg, args.league_dir)
    assert meta["format_key"] == F.format_key(cfg) and meta["compat"] == F.compat(cfg)
    assert X.format_meta(load_league("gabagool"), Path("configs/leagues")) == {}
