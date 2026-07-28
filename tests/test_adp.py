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
        {"name": "Some Kicker", "position": "PK", "adp": 200.0, "stdev": 3.0, "times_drafted": 5},
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
        {"name": "Late K", "position": "PK", "adp": 150.0},
        {"name": "Early K", "position": "PK", "adp": 140.5},
        {"name": "Alias K", "position": "K", "adp": 145.0},
        {"name": "A Defense", "position": "DEF", "adp": 138.0},
    ]}
    out = late_slot_adp(raw)
    assert list(out) == ["K", "DST"]
    assert out["K"] == [{"name": "Early K", "adp": 140.5},
                        {"name": "Alias K", "adp": 145.0},
                        {"name": "Late K", "adp": 150.0}]
    assert out["DST"] == [{"name": "A Defense", "adp": 138.0}]


def test_late_slot_adp_missing_positions_yield_empty_lists():
    from ffmodel.data.adp import late_slot_adp

    out = late_slot_adp({"players": [{"name": "RB", "position": "RB", "adp": 1.0}]})
    assert out == {"K": [], "DST": []}


# --- Sleeper snapshot loader -----------------------------------------------

_SNAPSHOT_HEADER = "Rank,Player (Bye),POS,ESPN,Sleeper,CBS,NFL,RTSports,Fantrax,AVG,Real-Time\n"


def _write_snapshot(tmp_path, rows: list[str], name="fantasypros_adp_2026-07-27.csv"):
    path = tmp_path / name
    path.write_text(_SNAPSHOT_HEADER + "".join(rows), encoding="utf-8")
    return path


def _snapshot_crosswalk():
    return pd.DataFrame({
        "gsis_id": ["00-1", "00-2", "00-3"],
        "merge_name": ["jahmyr gibbs", "stefon diggs", "marvin harrison"],
    })


def test_em_dash_rows_produce_no_row_never_zero_or_dash(tmp_path):
    """A player with no Sleeper ADP must be absent from the output, never
    present with adp=0 or adp="—" (the requirement: em-dash means missing,
    not a junk numeric/string value)."""
    from ffmodel.data.adp import parse_snapshot_csv

    path = _write_snapshot(tmp_path, [
        "1,Jahmyr Gibbs   DET (6),RB1,1,2,1,—,—,—,1.3,1\n",
        "2,No Sleeper Rank   KC (10),WR1,5,—,4,—,—,—,4.5,6\n",
    ])
    out = parse_snapshot_csv(path)
    assert list(out["name"]) == ["Jahmyr Gibbs"]     # the em-dash row is gone entirely
    assert 0 not in out["adp"].tolist()
    assert "—" not in out["adp"].astype(str).tolist()


def test_parse_player_bye_normal_case():
    from ffmodel.data.adp import parse_player_bye

    name, team, bye = parse_player_bye("Jahmyr Gibbs   DET (6)")
    assert (name, team, bye) == ("Jahmyr Gibbs", "DET", 6)


def test_parse_player_bye_free_agent_has_no_team_or_bye():
    """4 of the real snapshot's 245 Sleeper-ranked rows are unsigned free
    agents with no team/bye suffix at all -- the name must still parse."""
    from ffmodel.data.adp import parse_player_bye

    name, team, bye = parse_player_bye("Stefon Diggs")
    assert name == "Stefon Diggs"
    assert team is None
    assert bye is None


def test_normalize_snapshot_adp_match_rate_guard_has_teeth():
    """Prove the guard actually raises (not just exists): feed a crosswalk
    that only covers a fraction of the snapshot rows and confirm both the
    ValueError and the named unmatched players show up."""
    from ffmodel.data.adp import normalize_snapshot_adp

    raw = pd.DataFrame({
        "name": ["Jahmyr Gibbs", "Nobody One", "Nobody Two", "Nobody Three"],
        "position": ["RB", "WR", "WR", "TE"],
        "adp": [2.0, 50.0, 51.0, 52.0],
    })
    # Only 1/4 = 25% will match -- well under the 0.95 floor.
    crosswalk = pd.DataFrame({"gsis_id": ["00-1"], "merge_name": ["jahmyr gibbs"]})
    with pytest.raises(ValueError, match="25.0%") as exc_info:
        normalize_snapshot_adp(raw, crosswalk)
    msg = str(exc_info.value)
    assert "Nobody One" in msg
    assert "Nobody Two" in msg
    assert "Nobody Three" in msg


def test_normalize_snapshot_adp_passes_with_a_good_crosswalk():
    from ffmodel.data.adp import normalize_snapshot_adp

    raw = pd.DataFrame({
        "name": ["Jahmyr Gibbs", "Marvin Harrison Jr."],   # suffix case
        "position": ["RB", "WR"],
        "adp": [2.0, 70.0],
    })
    out = normalize_snapshot_adp(raw, _snapshot_crosswalk())
    assert set(out["player_id"]) == {"00-1", "00-3"}   # suffix stripped by norm()
    assert set(out.columns) == {"player_id", "name", "position", "adp",
                                "stdev", "times_drafted"}
    assert out["stdev"].isna().all() and out["times_drafted"].isna().all()


def test_snapshot_loader_scopes_out_k_and_dst_even_if_present(tmp_path):
    """K/DST are OUT of model scope (CLAUDE.md); prove the loader actually
    enforces it rather than merely happening to lack K/DST data today. If
    someone later repoints _late_slots() at this snapshot instead of
    FFCalculator, this is why they shouldn't: the loader will keep dropping
    K/DST even if a future export ever adds a Sleeper rank for them."""
    from ffmodel.data.adp import parse_snapshot_csv

    path = _write_snapshot(tmp_path, [
        "1,Jahmyr Gibbs   DET (6),RB1,1,2,1,—,—,—,1.3,1\n",
        # Hypothetical future export where K/DST DO carry a Sleeper rank:
        "2,Some Kicker   SF (8),K1,300,240,300,—,—,—,280.0,300\n",
        "3,Some Defense DST   (8),DST1,301,241,301,—,—,—,281.0,301\n",
    ])
    out = parse_snapshot_csv(path)
    assert set(out["position"]) == {"RB"}, (
        "K/DST rows leaked through parse_snapshot_csv -- the QB/RB/WR/TE scope "
        "filter regressed. _late_slots() in generate.py deliberately stays on "
        "FFCalculator for K/DST; if this loader ever starts yielding K/DST "
        "rows, someone may be tempted to repoint _late_slots() at it, which "
        "would break the moment the real snapshot goes back to having none."
    )


def test_real_snapshot_has_zero_k_or_dst_rows():
    """Pins the actual committed file's shape: today's real snapshot never
    ranks K/DST on Sleeper at all (245/245 Sleeper-ADP rows are QB/RB/WR/TE).
    This is WHY _late_slots()/late_slot_adp() in generate.py/adp.py stay
    pinned to FFCalculator -- repointing them at this snapshot would silently
    empty the site's K/DST late-round reminder."""
    from ffmodel.data.adp import SNAPSHOT_PATH, parse_snapshot_csv

    out = parse_snapshot_csv(SNAPSHOT_PATH)
    assert len(out) == 245, (
        f"expected 245 Sleeper-ranked QB/RB/WR/TE rows in the committed "
        f"snapshot, got {len(out)} -- the snapshot file changed; re-verify "
        f"before trusting the K/DST-emptiness guarantee below"
    )
    assert set(out["position"]) == {"QB", "RB", "WR", "TE"}, (
        "the committed Sleeper-ADP snapshot unexpectedly contains a K or DST "
        "row. late_slot_adp()/_late_slots() are pinned to FFCalculator "
        "specifically because this snapshot has never carried K/DST ADP -- "
        "if that's no longer true, the late-slot source decision needs "
        "revisiting, not a silent swap"
    )
