"""Neutral batch builders: batch context, neutral weekly/remaining, scorable identity universe."""
import copy
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import pytest

from ffmodel.site import remaining as R
from ffmodel.site import weekly as W
from ffmodel.site.leaguelens import STATS
from ffmodel.site.neutral import (BatchContext, build_players, empty_remaining, make_batch_context,
                                  neutral_weekly, normalize_team)
from tests.test_remaining import setup as legacy_setup

FIXTURE = Path(__file__).parent / "fixtures" / "remaining_legacy_expected.json"
GEN = "2026-10-06T00:00:00+00:00"
METHOD = {"v": 1, "model": "transformer", "artifacts": ["a"]}
PRIOR = {"method": "pooled", "rate": 0.0876, "first_season": 2021, "through_season": 2025}


class _Fixed(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 10, 6, tzinfo=timezone.utc)


def _fix_clock(monkeypatch):
    monkeypatch.setattr(R, "datetime", _Fixed)
    monkeypatch.setattr(W, "datetime", _Fixed)


def _ser(payload):
    return json.dumps(payload, separators=(",", ":"), allow_nan=False)


def test_batch_context_id_and_header():
    ctx = make_batch_context(2026, 5, "2026-wk4", GEN)
    assert ctx == BatchContext(2026, 5, "2026-wk4", GEN, f"{GEN}|2026-wk4|w5")
    assert ctx.header() == {"season": 2026, "week": 5, "data_through": "2026-wk4",
                            "generated_at": GEN, "batch_id": f"{GEN}|2026-wk4|w5"}
    with pytest.raises(Exception):
        ctx.week = 6  # frozen


# --- legacy bytes -------------------------------------------------------------

def test_legacy_bytes_unchanged(monkeypatch):
    _fix_clock(monkeypatch)
    expected = FIXTURE.read_text(encoding="utf-8")
    args, _ = legacy_setup(monkeypatch)
    assert _ser(R.build_remaining(**args)) == expected
    args, _ = legacy_setup(monkeypatch)
    assert _ser(R.build_remaining(**args, emit="league")) == expected


def test_legacy_generated_at_overrides_clock(monkeypatch):
    args, _ = legacy_setup(monkeypatch)
    out = R.build_remaining(**args, generated_at="2030-01-01T00:00:00+00:00")
    assert out["generated_at"] == "2030-01-01T00:00:00+00:00"


def test_league_mode_still_requires_league(monkeypatch):
    args, _ = legacy_setup(monkeypatch)
    args.pop("league")
    with pytest.raises(ValueError, match="league scoring"):
        R.build_remaining(**args)


def test_weekly_generated_at_override():
    class P:
        name = "stub"

        def predict(self, f):
            return pd.DataFrame({s: [1.0] for s in W.PREDICTED_STATS}, index=f.index)
    future = pd.DataFrame([dict(player_id="a", player_display_name="A", team="A",
                                opponent_team="B", position="RB", is_home=True)])
    out = W.build_weekly_projections(future, P(), 2026, 5, "2026-wk4", generated_at=GEN)
    assert out["generated_at"] == GEN


# --- neutral remaining --------------------------------------------------------

def _quantiles(base):
    return {q: {s: base + k + i / 7 + 1e-6 for i, s in enumerate(STATS)}
            for k, q in ((0.0, "p10"), (1.0, "p50"), (2.0, "p90"))}


def _neutral_setup(monkeypatch, quantiles=None):
    args, _ = legacy_setup(monkeypatch)

    def predict(f, model, season, week, through, **kwargs):
        sq = quantiles if quantiles is not None else _quantiles(week)
        return {"players": [dict(player_id="a", name="Player", position="RB", team="A",
                                 opponent="B" if week == 1 else "C",
                                 points={"ppr": {"p50": 3}}, stat_quantiles=copy.deepcopy(sq))]}
    monkeypatch.setattr(R, "build_weekly_projections", predict)
    args["league"] = None
    ctx = make_batch_context(2026, 1, "2025-wk18", GEN)
    return args, ctx


def test_neutral_remaining_rows(monkeypatch):
    args, ctx = _neutral_setup(monkeypatch)
    full = {}
    out = R.build_remaining(**(args | {"pick_six_prior": PRIOR}), emit="neutral", ctx=ctx,
                            method=METHOD, full_precision_out=full)
    assert out["kind"] == "neutral_remaining" and out["schema_version"] == 2
    assert out["stat_order"] == list(STATS)
    assert "league" not in out and "evaluation" not in out
    assert {k: out[k] for k in ctx.header()} == ctx.header()
    assert out["method"] == METHOD and out["pick_six_forecast"] == PRIOR
    assert out["start_week"] == 1 and out["end_week"] == 2 and out["status"] == "experimental"
    player = out["players"][0]
    assert player["position"] == "RB" and player["name"] == "Player"
    for row in player["weeks"]:
        assert set(row) == {"week", "status", "opponent", "stats"}
        assert row["status"] == "conditional_projection"
        assert len(row["stats"]) == 3
        for vec in row["stats"]:
            assert len(vec) == 12 and all(isinstance(v, float) for v in vec)
            assert all(v == round(v, 4) for v in vec)
        for qi, q in enumerate(("p10", "p50", "p90")):
            unrounded = full["a"][row["week"]][q]
            assert list(unrounded) == list(STATS)
            assert [round(unrounded[s], 4) for s in STATS] == row["stats"][qi]
            assert unrounded["passing_yards"] != row["stats"][qi][0]  # truly unrounded
    rookie = out["players"][1]
    assert [w["status"] for w in rookie["weeks"]] == ["unmodeled", "bye"]
    assert rookie["weeks"][0] == {"week": 1, "status": "unmodeled", "points": None,
                                  "reason": "no_observed_history"}
    assert "position" not in rookie
    json.dumps(out, allow_nan=False)


def test_neutral_remaining_point_only_predictor(monkeypatch):
    sq = _quantiles(1)
    sq["p10"] = sq["p90"] = None
    args, ctx = _neutral_setup(monkeypatch, quantiles=sq)
    out = R.build_remaining(**args, emit="neutral", ctx=ctx, method=METHOD)
    stats = out["players"][0]["weeks"][0]["stats"]
    assert stats[0] is None and stats[2] is None and len(stats[1]) == 12
    assert out["pick_six_forecast"] is None


@pytest.mark.parametrize("bad", ["one_sided", "missing_stat", "nan"])
def test_neutral_remaining_bad_stat_blocks_fail(monkeypatch, bad):
    sq = _quantiles(1)
    if bad == "one_sided":
        sq["p90"] = None
    elif bad == "missing_stat":
        del sq["p50"]["passing_pick_sixes"]
    else:
        sq["p50"]["carries"] = float("nan")
    args, ctx = _neutral_setup(monkeypatch, quantiles=sq)
    with pytest.raises(ValueError):
        R.build_remaining(**args, emit="neutral", ctx=ctx, method=METHOD)


@pytest.mark.parametrize("change", [
    {"ctx": make_batch_context(2025, 1, "2025-wk18", GEN)},
    {"ctx": make_batch_context(2026, 2, "2025-wk18", GEN)},
    {"ctx": make_batch_context(2026, 1, "2025-wk17", GEN)},
    {"ctx": None}, {"method": None},
    {"generated_at": "2030-01-01T00:00:00+00:00"},
    {"evaluation": {"source": "x"}},
    {"emit": "bogus"},
])
def test_neutral_remaining_contract_fails(monkeypatch, change):
    args, ctx = _neutral_setup(monkeypatch)
    kw = {"emit": "neutral", "ctx": ctx, "method": METHOD} | change
    with pytest.raises(ValueError):
        R.build_remaining(**args, **kw)


@pytest.mark.parametrize("change", [{"current_teams": {}}, {"end_week": 19},
                                    {"current_teams": {"a": "BAD"}}])
def test_neutral_keeps_non_league_checks(monkeypatch, change):
    args, ctx = _neutral_setup(monkeypatch)
    with pytest.raises(ValueError):
        R.build_remaining(**(args | change), emit="neutral", ctx=ctx, method=METHOD)


def test_neutral_skips_league_scoring_validation(monkeypatch):
    args, ctx = _neutral_setup(monkeypatch)
    # A league whose scoring disagrees with the active rules is irrelevant in neutral mode.
    args["league"] = {"league_id": "L", "sleeper_scoring": {"rec": 7}}
    out = R.build_remaining(**args, emit="neutral", ctx=ctx, method=METHOD)
    assert "league" not in out


# --- neutral weekly -----------------------------------------------------------

def _weekly_payload(prior=PRIOR):
    def player(pid, base):
        return {"player_id": pid, "name": pid.upper(), "team": "A", "opponent": "B",
                "position": "WR", "is_home": True,
                "points": {r: {"p10": base - 1, "p50": base, "p90": base + 1}
                           for r in ("ppr", "half_ppr", "standard", "league")},
                "stat_quantiles": _quantiles(base),
                "stats_p50": {s: 1.0 for s in STATS}}
    out = {"generated_at": "2026-10-06T09:09:09+00:00", "data_through": "2026-wk4",
           "season": 2026, "week": 5, "model": "transformer", "has_bands": True,
           "stat_projection_schema": {"version": 1, "band_method": "x"},
           "players": [player("b", 20.0), player("a", 10.0)]}
    if prior is not None:
        out["pick_six_forecast"] = dict(prior)
    return out


def test_neutral_weekly():
    ctx = make_batch_context(2026, 5, "2026-wk4", GEN)
    src = _weekly_payload()
    before = copy.deepcopy(src)
    out = neutral_weekly(src, ctx, PRIOR, METHOD)
    assert src == before  # input untouched
    assert out["kind"] == "neutral_weekly" and out["schema_version"] == 1
    assert {k: out[k] for k in ctx.header()} == ctx.header()
    assert out["generated_at"] == GEN
    assert out["pick_six_forecast"] == PRIOR and out["method"] == METHOD
    assert out["model"] == "transformer" and out["has_bands"] is True
    assert out["stat_projection_schema"] == {"version": 1, "band_method": "x"}
    assert [p["player_id"] for p in out["players"]] == ["b", "a"]
    p = out["players"][0]
    assert set(p["points"]) == {"ppr", "half_ppr", "standard"}
    assert "stats_p50" not in p
    assert p["stat_quantiles"] == src["players"][0]["stat_quantiles"]  # full precision
    assert "league" not in out


def test_neutral_weekly_without_prior():
    ctx = make_batch_context(2026, 5, "2026-wk4", GEN)
    out = neutral_weekly(_weekly_payload(prior=None), ctx, None, METHOD)
    assert out["pick_six_forecast"] is None


@pytest.mark.parametrize("ctx,prior", [
    (make_batch_context(2026, 6, "2026-wk4", GEN), PRIOR),
    (make_batch_context(2026, 5, "2026-wk3", GEN), PRIOR),
    (make_batch_context(2025, 5, "2026-wk4", GEN), PRIOR),
    (make_batch_context(2026, 5, "2026-wk4", GEN), None),
])
def test_neutral_weekly_mismatch_fails(ctx, prior):
    with pytest.raises(ValueError):
        neutral_weekly(_weekly_payload(), ctx, prior, METHOD)


def test_neutral_weekly_duplicate_player_fails():
    src = _weekly_payload()
    src["players"].append(copy.deepcopy(src["players"][0]))
    with pytest.raises(ValueError, match="duplicate"):
        neutral_weekly(src, make_batch_context(2026, 5, "2026-wk4", GEN), PRIOR, METHOD)


# --- empty remaining ----------------------------------------------------------

def test_empty_remaining_state():
    ctx = make_batch_context(2026, 18, "2026-wk17", GEN)
    out = empty_remaining(ctx, "transformer")
    assert out["status"] == "no_remaining_weeks"
    assert out["kind"] == "neutral_remaining" and out["schema_version"] == 2
    assert out["start_week"] == 18 and out["players"] == []
    assert {k: out[k] for k in ctx.header()} == ctx.header()
    assert out["model"] == "transformer" and out["stat_order"] == list(STATS)


# --- identity universe --------------------------------------------------------

def test_normalize_team_aliases():
    assert normalize_team("LAR") == "LA"
    assert normalize_team("WSH") == "WAS"
    assert normalize_team("JAC") == "JAX"
    assert normalize_team("KC") == "KC"
    assert normalize_team(None) is None


CTX = make_batch_context(2026, 5, "2026-wk4", GEN)


def _wk(*players):
    return {**CTX.header(), "kind": "neutral_weekly", "players": [
        {"player_id": pid, "name": name, "team": team, "position": pos} for pid, name, team, pos in players]}


def _rem(*players):
    rows = []
    for pid, team, pos, name in players:
        r = {"player_id": pid, "team": team, "weeks": []}
        if pos is not None:
            r.update(position=pos, name=name)
        rows.append(r)
    return {**CTX.header(), "kind": "neutral_remaining", "players": rows}


def _schedule():
    rows = []
    for week in range(1, 19):
        # KC byes in week 7, LA in week 9; BUF/MIA play every week; NYJ fills in.
        rows.append(dict(season=2026, week=week, game_type="REG", home_team="BUF", away_team="MIA"))
        if week not in (7, 9):
            rows.append(dict(season=2026, week=week, game_type="REG", home_team="KC", away_team="LA"))
    rows.append(dict(season=2026, week=7, game_type="REG", home_team="LA", away_team="NYJ"))
    rows.append(dict(season=2026, week=9, game_type="REG", home_team="KC", away_team="NYJ"))
    rows.append(dict(season=2026, week=19, game_type="WC", home_team="KC", away_team="LA"))
    return pd.DataFrame(rows)


def _by_id(out):
    return {p["player_id"]: p for p in out["players"]}


def test_identity_one_to_one_and_catalog_name():
    catalog = {"4046": {"gsis_id": " 00-1 ", "full_name": "Patrick Mahomes II", "team": "KC",
                        "position": "QB"}}
    out = build_players(CTX, _wk(("00-1", "P. Mahomes", "KC", "QB")), _rem(("00-1", "KC", "QB", "P. Mahomes")),
                        catalog, None, _schedule())
    assert out["kind"] == "neutral_players" and out["schema_version"] == 1
    assert {k: out[k] for k in CTX.header()} == CTX.header()
    assert out["ecr_source"] is None
    assert out["players"] == [{"player_id": "00-1", "sleeper_id": "4046", "name": "Patrick Mahomes II",
                               "team": "KC", "position": "QB", "bye": 7, "ecr": None,
                               "identity_only": False, "reason": None, "match": "gsis"}]
    assert out["crosswalk"] == {"matched_gsis": 1, "matched_name": 0, "unmatched": 0}


def test_identity_duplicate_gsis_no_name_fallback():
    catalog = {"1": {"gsis_id": "00-1", "full_name": "Same Name", "team": "KC", "position": "WR"},
               "2": {"gsis_id": "00-1", "full_name": "Same Name", "team": "KC", "position": "WR"},
               "3": {"gsis_id": None, "full_name": "Same Name", "team": "KC", "position": "WR"}}
    p = _by_id(build_players(CTX, _wk(("00-1", "Same Name", "KC", "WR")), _rem(), catalog, None,
                             _schedule()))["00-1"]
    assert p["identity_only"] is True and p["reason"] == "duplicate_gsis_in_catalog"
    assert p["sleeper_id"] is None and p["name"] == "Same Name" and p["match"] is None



# --- name+position fallback when the catalog lacks the GSIS (Ruling 16) ----------

def test_identity_name_fallback_priced():
    catalog = {"9509": {"gsis_id": None, "first_name": "Bijan", "last_name": "Robinson", "team": "ATL",
                        "position": "RB"},
               "8144": {"gsis_id": "", "full_name": "Chris Olave", "team": "NO", "position": "WR"}}
    out = build_players(CTX, _wk(("00-b", "Bijan Robinson Jr.", "ATL", "RB"), ("00-o", "Chris Olave", "NO", "WR")),
                        _rem(), catalog, None, _schedule())
    by = _by_id(out)
    assert by["00-b"] == {"player_id": "00-b", "sleeper_id": "9509", "name": "Bijan Robinson Jr.",
                               "team": "ATL", "position": "RB", "bye": None, "ecr": None,
                               "identity_only": False, "reason": None, "match": "name"}
    assert (by["00-o"]["sleeper_id"], by["00-o"]["name"], by["00-o"]["match"]) == ("8144", "Chris Olave", "name")
    assert by["00-o"]["identity_only"] is False
    assert out["crosswalk"] == {"matched_gsis": 0, "matched_name": 2, "unmatched": 0}


def test_identity_name_ambiguous_in_catalog():
    catalog = {"1": {"gsis_id": None, "full_name": "Mike Williams", "team": "NYJ", "position": "WR"},
               "2": {"gsis_id": None, "full_name": "Mike Williams", "team": "PIT", "position": "WR"}}
    p = _by_id(build_players(CTX, _wk(("00-1", "Mike Williams", "NYJ", "WR")), _rem(), catalog, None,
                             _schedule()))["00-1"]
    assert (p["identity_only"], p["reason"], p["sleeper_id"], p["match"]) == (
        True, "ambiguous_name_match", None, None)


def test_identity_name_ambiguous_among_projections():
    catalog = {"1": {"gsis_id": None, "full_name": "Mike Williams", "team": "NYJ", "position": "WR"}}
    out = build_players(CTX, _wk(("00-1", "Mike Williams", "NYJ", "WR")),
                        _rem(("00-2", "PIT", "WR", "Mike Williams")), catalog, None, _schedule())
    by = _by_id(out)
    for pid in ("00-1", "00-2"):
        assert (by[pid]["reason"], by[pid]["sleeper_id"], by[pid]["match"]) == ("ambiguous_name_match", None, None)
    assert out["crosswalk"] == {"matched_gsis": 0, "matched_name": 0, "unmatched": 2}


def test_identity_name_match_team_disagreement():
    catalog = {"7": {"gsis_id": None, "full_name": "Traded Guy", "team": "BUF", "position": "WR"}}
    p = _by_id(build_players(CTX, _wk(("00-1", "Traded Guy", "KC", "WR")), _rem(), catalog, None,
                             _schedule()))["00-1"]
    assert (p["identity_only"], p["reason"], p["sleeper_id"], p["match"]) == (True, "team_disagrees", "7", "name")


def test_identity_name_match_with_different_gsis():
    catalog = {"7": {"gsis_id": "00-9", "full_name": "Josh Allen", "team": "BUF", "position": "QB"}}
    out = build_players(CTX, _wk(("00-1", "Josh Allen", "BUF", "QB")), _rem(), catalog, None, _schedule())
    p = _by_id(out)["00-1"]
    assert (p["identity_only"], p["reason"], p["sleeper_id"], p["match"]) == (True, "gsis_disagrees", None, None)
    assert out["crosswalk"] == {"matched_gsis": 0, "matched_name": 0, "unmatched": 1}


def test_identity_crosswalk_header_counts():
    catalog = {"1": {"gsis_id": "00-1", "full_name": "A", "team": "KC", "position": "QB"},
               "2": {"gsis_id": None, "full_name": "Bee Bee", "team": "KC", "position": "WR"},
               "3": {"gsis_id": "00-9", "full_name": "Never Proj", "team": "LA", "position": "WR"}}
    out = build_players(CTX, _wk(("00-1", "A", "KC", "QB"), ("00-2", "Bee Bee", "KC", "WR"),
                                 ("00-3", "Nobody", "KC", "TE")),
                        _rem(("00-9", "LA", None, None)), catalog, None, _schedule())
    # 00-9 is never projected (no position): it keeps its gsis link but is not counted.
    assert out["crosswalk"] == {"matched_gsis": 1, "matched_name": 1, "unmatched": 1}
    assert _by_id(out)["00-9"]["match"] == "gsis" and _by_id(out)["00-9"]["reason"] == "no_projection"
    assert list(out)[-2:] == ["crosswalk", "players"]

def test_identity_team_alias_equivalence():
    catalog = {"9": {"gsis_id": "00-2", "full_name": "Puka Nacua", "team": "LAR", "position": "WR"}}
    p = _by_id(build_players(CTX, _wk(("00-2", "Puka Nacua", "LA", "WR")), _rem(), catalog, None,
                             _schedule()))["00-2"]
    assert p["identity_only"] is False and p["sleeper_id"] == "9" and p["team"] == "LA" and p["bye"] == 9


def test_identity_team_disagreement():
    catalog = {"9": {"gsis_id": "00-2", "full_name": "X", "team": "BUF", "position": "WR"},
               "8": {"gsis_id": "00-3", "full_name": "Y", "team": None, "position": "WR"}}
    out = _by_id(build_players(CTX, _wk(("00-2", "X", "LA", "WR"), ("00-3", "Y", "KC", "WR")), _rem(),
                               catalog, None, _schedule()))
    assert (out["00-2"]["identity_only"], out["00-2"]["reason"]) == (True, "team_disagrees")
    assert out["00-2"]["team"] == "LA"  # projection team wins
    assert out["00-3"]["reason"] == "team_disagrees"


def test_identity_position_disagreement():
    catalog = {"7": {"gsis_id": "00-4", "full_name": "Taysom Hill", "team": "KC", "position": "TE"}}
    p = _by_id(build_players(CTX, _wk(("00-4", "Taysom Hill", "KC", "QB")), _rem(), catalog, None,
                             _schedule()))["00-4"]
    assert (p["identity_only"], p["reason"], p["position"]) == (True, "position_disagrees", "QB")
    assert p["sleeper_id"] == "7"


@pytest.mark.parametrize("rem_team,rem_pos", [("BUF", "WR"), ("KC", "RB")])
def test_identity_weekly_vs_remaining_conflict(rem_team, rem_pos):
    catalog = {"5": {"gsis_id": "00-5", "full_name": "Z", "team": "KC", "position": "WR"}}
    p = _by_id(build_players(CTX, _wk(("00-5", "Z", "KC", "WR")), _rem(("00-5", rem_team, rem_pos, "Z")),
                             catalog, None, _schedule()))["00-5"]
    assert (p["identity_only"], p["reason"]) == (True, "projection_identity_conflict")


def test_identity_no_catalog_match():
    p = _by_id(build_players(CTX, _wk(("00-6", "Rookie", "MIA", "RB")), _rem(), {}, None,
                             _schedule()))["00-6"]
    assert p == {"player_id": "00-6", "sleeper_id": None, "name": "Rookie", "team": "MIA",
                 "position": "RB", "bye": None, "ecr": None, "identity_only": True,
                 "reason": "no_catalog_match", "match": None}


def test_identity_remaining_only_and_never_projected():
    catalog = {"5": {"gsis_id": "00-7", "full_name": "Ros Guy", "team": "KC", "position": "TE"},
               "6": {"gsis_id": "00-8", "full_name": "Never Proj", "team": "LA", "position": "WR"}}
    out = _by_id(build_players(CTX, _wk(), _rem(("00-7", "KC", "TE", "R. Guy"), ("00-8", "LA", None, None)),
                               catalog, None, _schedule()))
    assert out["00-7"]["identity_only"] is False and out["00-7"]["position"] == "TE"
    never = out["00-8"]
    assert never["position"] is None and never["identity_only"] is True
    assert never["reason"] == "no_projection" and never["sleeper_id"] == "6"
    assert never["name"] == "Never Proj" and never["team"] == "LA" and never["bye"] == 9


def test_players_union_sorted_and_unique():
    out = build_players(CTX, _wk(("00-b", "B", "KC", "WR"), ("00-a", "A", "KC", "WR")),
                        _rem(("00-a", "KC", "WR", "A"), ("00-c", "KC", None, None)), {}, None, _schedule())
    assert [p["player_id"] for p in out["players"]] == ["00-a", "00-b", "00-c"]


def test_players_ecr_source_and_values():
    ecr = pd.DataFrame({"player_id": ["00-1", "00-9"], "ecr": [3, 40],
                        "scrape_date": pd.Timestamp("2026-09-08"),
                        "fp_page": "snapshot:fantasypros-draft-all-rankings"})
    catalog = {"4046": {"gsis_id": "00-1", "full_name": "PM", "team": "KC", "position": "QB"}}
    out = build_players(CTX, _wk(("00-1", "PM", "KC", "QB"), ("00-2", "Q", "KC", "QB")), _rem(), catalog, ecr,
                        _schedule())
    assert out["ecr_source"] == {"source": "snapshot:fantasypros-draft-all-rankings", "date": "2026-09-08",
                                 "scoring": "PPR"}
    by = _by_id(out)
    assert by["00-1"]["ecr"] == 3 and by["00-2"]["ecr"] is None


def test_players_ecr_mixed_sources_fail():
    ecr = pd.DataFrame({"player_id": ["00-1", "00-9"], "ecr": [3, 40],
                        "scrape_date": [pd.Timestamp("2026-09-08"), pd.Timestamp("2026-09-07")],
                        "fp_page": "p"})
    with pytest.raises(ValueError, match="ECR"):
        build_players(CTX, _wk(("00-1", "PM", "KC", "QB")), _rem(), {}, ecr, _schedule())


def test_players_mixed_batch_fails():
    rem = _rem()
    rem["batch_id"] = "other"
    with pytest.raises(ValueError, match="batch"):
        build_players(CTX, _wk(), rem, {}, None, _schedule())


def test_players_accept_empty_remaining():
    ctx18 = make_batch_context(2026, 18, "2026-wk17", GEN)
    wk = {**ctx18.header(), "players": [{"player_id": "00-1", "name": "A", "team": "KC", "position": "QB"}]}
    out = build_players(ctx18, wk, empty_remaining(ctx18, "m"), {}, None, _schedule())
    assert [p["player_id"] for p in out["players"]] == ["00-1"]
