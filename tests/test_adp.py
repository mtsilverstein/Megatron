import pandas as pd
import pytest

from ffmodel.data.adp import normalize_adp


def _crosswalk():
    # merge_name is lowercase in ff_playerids (matches rankings._merge_key)
    return pd.DataFrame({
        "gsis_id": ["00-1", "00-2", "00-3", "00-4"],
        "merge_name": ["marquise brown", "kenneth gainwell", "aj brown", "patrick mahomes"],
    })


def _raw():
    # FFCalculator /adp JSON shape
    return {"players": [
        {"name": "Hollywood Brown", "position": "WR", "adp": 95.4, "stdev": 12.0, "times_drafted": 40},
        {"name": "Kenny Gainwell", "position": "RB", "adp": 140.1, "stdev": 9.0, "times_drafted": 22},
        {"name": "A.J. Brown", "position": "WR", "adp": 12.3, "stdev": 4.0, "times_drafted": 88},
        {"name": "Patrick Mahomes II", "position": "QB", "adp": 40.0, "stdev": 6.0, "times_drafted": 70},
        {"name": "Some Kicker", "position": "K", "adp": 200.0, "stdev": 3.0, "times_drafted": 5},
    ]}


def test_normalize_adp_crosswalks_nicknames_suffixes_and_drops_out_of_scope():
    out = normalize_adp(_raw(), _crosswalk())
    # K is out of scope -> dropped; the other four crosswalk via nickname/suffix norm
    assert set(out["position"]) == {"WR", "RB", "QB"}
    by_id = dict(zip(out["player_id"], out["adp"]))
    assert by_id["00-1"] == pytest.approx(95.4)   # Hollywood -> marquise brown
    assert by_id["00-2"] == pytest.approx(140.1)  # Kenny -> kenneth gainwell
    assert by_id["00-3"] == pytest.approx(12.3)   # A.J. -> aj brown (punct stripped)
    assert by_id["00-4"] == pytest.approx(40.0)   # Mahomes II -> suffix stripped
    assert set(out.columns) >= {"player_id", "name", "position", "adp", "stdev", "times_drafted"}


def test_normalize_adp_drops_unmatched_without_crashing():
    raw = {"players": [{"name": "Nobody Atall", "position": "WR", "adp": 5.0,
                        "stdev": 1.0, "times_drafted": 3}]}
    out = normalize_adp(raw, _crosswalk())
    assert out.empty


def test_late_slot_adp_keeps_only_k_and_dst_sorted_by_adp():
    from ffmodel.data.adp import late_slot_adp

    raw = {"players": [
        {"name": "Some RB", "position": "RB", "adp": 1.2},
        {"name": "Late K", "position": "K", "adp": 150.0},
        {"name": "Early K", "position": "K", "adp": 140.5},
        {"name": "A Defense", "position": "DEF", "adp": 138.0},
    ]}
    out = late_slot_adp(raw)
    assert list(out) == ["K", "DST"]
    assert out["K"] == [{"name": "Early K", "adp": 140.5},
                        {"name": "Late K", "adp": 150.0}]
    assert out["DST"] == [{"name": "A Defense", "adp": 138.0}]


def test_late_slot_adp_missing_positions_yield_empty_lists():
    from ffmodel.data.adp import late_slot_adp

    out = late_slot_adp({"players": [{"name": "RB", "position": "RB", "adp": 1.0}]})
    assert out == {"K": [], "DST": []}
