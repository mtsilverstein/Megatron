import json, random, subprocess
from pathlib import Path
import pytest
from ffmodel.site import leaguelens as L

NODE_TABLES = ("const L=require('./site/assets/leaguelens.js');"
               "console.log(JSON.stringify({KEYS:L.KEYS,APPROX:L.APPROX,RARE:L.RARE,RECURRING:L.RECURRING,STATS:L.STATS}))")

def _node(script, *args):
    return json.loads(subprocess.run(["node", "-e", script, *args], capture_output=True, text=True, check=True).stdout)

def test_tables_identical_to_js():
    js = _node(NODE_TABLES)
    assert {k: [s, None if p is None else list(p)] for k, (s, p) in L.KEYS.items()} == js["KEYS"]
    assert list(L.APPROX) == js["APPROX"] and L.RARE == js["RARE"]
    assert list(L.RECURRING) == js["RECURRING"] and list(L.STATS) == js["STATS"]

def test_plain_matches_js_on_random_doubles():
    rng = random.Random(7)
    xs = [0.04, 0.0400001, 6.0, -2.5, 1e-7, 1e21, 5e-324, 1.7976931348623157e308]
    xs += [rng.uniform(-50, 50) for _ in range(300)] + [10 ** rng.uniform(-30, 30) for _ in range(300)]
    script = ("const L=require('./site/assets/leaguelens.js');"
              "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(L.plain)))")
    assert _node(script, json.dumps(xs)) == [L.plain(x) for x in xs]
    for bad in (float("nan"), float("inf"), "1", True):
        with pytest.raises(ValueError):
            L.plain(bad)

def test_identity_byte_equal_to_js():
    cases = [{"pass_yd": 0.04, "rec": -1, "bonus_rec_te": 2}, {"pass_yd": 0.0400001},
             {"rush_att": 0.1, "pass_int_td": -3}, {"rec": 1, "bonus_rec_wr": -1}, {"pass_yd": 1e-12, "rec": 2e7}]
    script = ("const L=require('./site/assets/leaguelens.js');"
              "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(c=>L.evidenceIdentity(L.effectiveWeights(c)))))")
    assert _node(script, json.dumps(cases)) == [L.evidence_identity(L.effective_weights(c)) for c in cases]

def test_classify_owner_league():
    gab = json.loads(Path("tests/fixtures/owner_league_settings.json").read_text())["gabagool"]["scoring_settings"]
    c = L.classify(gab)
    assert c["recurring"] == [] and "pass_int_td" in c["approx"] and not c["refused"]

def test_parity_fixture_reproducible():
    data = json.loads(Path("tests/fixtures/leaguelens_parity.json").read_text())
    for c in data["cases"]:
        w = L.effective_weights(c["scoring"])
        if c.get("expected_error"):
            with pytest.raises(ValueError, match=c["expected_error"]):
                L.reference_score(c["stat_quantiles"], c["position"], w)
        else:
            assert L.reference_score(c["stat_quantiles"], c["position"], w) == c["expected"], c["name"]

def test_reference_matches_published_league_points():
    w = json.loads(Path("site/data/weekly.json").read_text())
    weights = L.effective_weights(w["league"]["sleeper_scoring"])
    for p in w["players"]:
        got = L.reference_score(p["stat_quantiles"], p["position"], weights)
        for k in ("p10", "p50", "p90"):
            assert abs(got[k] - p["points"]["league"][k]) <= 0.005 + 1e-9, (p["name"], k)

@pytest.mark.parametrize("sq,err", [
    ({"p10": None, "p50": {"receptions": 5}, "p90": {"receptions": 8}}, "Incomplete"),
    ({"p10": None, "p50": {"receptions": "5"}, "p90": None}, "invalid"),
    ({"p10": None, "p50": {"receptions": True}, "p90": None}, "invalid"),
    ({"p10": None, "p50": {"receptions": float("nan")}, "p90": None}, "invalid"),
    ({"p10": {"receptions": 8}, "p50": {"receptions": 5}, "p90": {"receptions": 2}}, "Malformed band"),
    ({"p10": [2], "p50": {"receptions": 5}, "p90": [8]}, "Incomplete"),
    ({"p10": None, "p50": [5], "p90": None}, "Incomplete"),
])
def test_reference_validation(sq, err):
    with pytest.raises(ValueError, match=err):
        L.reference_score(sq, "WR", L.effective_weights({"rec": 1}))
