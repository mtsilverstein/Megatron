import copy
import json
from pathlib import Path

import pytest

from ffmodel.site.live_accuracy_site import extract, main, serialise


def _cell(n, mae=4.0, naive=4.5, cov=0.8, below=0.09, above=0.11):
    return {"n": n, "mae": mae, "naive_mae": naive, "coverage_p10_p90": cov, "below_p10": below, "above_p90": above,
            "pinball_p50": 2.0, "share_above_p50": 0.5}


def _art():
    return {
        "protocol_version": "live-accuracy-v1", "season": 2026, "weeks_scored": [1, 2], "weeks_skipped": [],
        "run": {"as_of_date": "2026-10-28", "run_at": "2026-10-28T19:09:00Z", "provisional_weeks": [2],
                "main_sha": "abc"},
        "points": {"overall": _cell(30, mae=4.2), "by_week": {"1": {**_cell(10), "last_game": "2026-09-14"},
                                                              "2": {**_cell(20), "last_game": "2026-09-21"}},
                   "by_position": {}},
        "caveats": ["Players who recorded a stat line only; DNPs are outside the estimand."],
        "ranking": {"primary": {"sp_ours": 0.6}}, "inputs": {"ledger": "x"},
    }


def test_extract_keeps_the_scored_weeks_totals_and_caveats_only():
    out = extract(_art())
    assert out["season"] == 2026 and out["scoring"] == "ppr" and out["kind"] == "live_accuracy"
    assert [w["week"] for w in out["weeks"]] == [1, 2]
    assert out["weeks"][1] == {"week": 2, "last_game": "2026-09-21", "n": 20, "mae": 4.0, "naive_mae": 4.5,
                               "coverage_p10_p90": 0.8, "below_p10": 0.09, "above_p90": 0.11, "provisional": True}
    assert out["weeks"][0]["provisional"] is False and out["provisional_weeks"] == [2]
    assert out["overall"]["mae"] == 4.2 and out["overall"]["n"] == 30
    assert out["caveats"] == _art()["caveats"]
    assert "ranking" not in out and "inputs" not in out and "pinball_p50" not in out["overall"]
    assert out["source"] == "models/diagnostics/live_2026_weekly.json"


@pytest.mark.parametrize("mutate, match", [
    (lambda a: a.update(protocol_version="other"), "scorecard"),
    (lambda a: a.update(season="2026"), "season"),
    (lambda a: a.update(weeks_scored=[]), "weeks_scored"),
    (lambda a: a["run"].update(provisional_weeks=[3]), "provisional"),
    (lambda a: a["points"]["by_week"].pop("2"), "by_week.2"),
    (lambda a: a["points"]["by_week"]["1"].update(mae=float("nan")), "by_week.1.mae"),
    (lambda a: a["points"]["by_week"]["1"].update(coverage_p10_p90=1.2), "outside"),
    (lambda a: a["points"]["by_week"]["1"].update(n=0), "positive integer"),
    (lambda a: a["points"]["overall"].update(n=31), "sum of the weekly n"),
    (lambda a: a["run"].pop("run_at"), "run_at"),
])
def test_extract_refuses_anything_unexpected(mutate, match):
    art = copy.deepcopy(_art())
    mutate(art)
    with pytest.raises(ValueError, match=match):
        extract(art)


def test_main_writes_once_and_skips_a_missing_scorecard(tmp_path, capsys):
    src, out = tmp_path / "live_2026_weekly.json", tmp_path / "site" / "live-accuracy.json"
    assert main(["--src", str(src), "--out", str(out)]) == 0
    assert not out.exists() and "nothing written" in capsys.readouterr().out
    src.write_text(json.dumps(_art()), encoding="utf-8")
    assert main(["--src", str(src), "--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8") == serialise(extract(_art()))
    assert main(["--src", str(src), "--out", str(out)]) == 0
    assert "unchanged" in capsys.readouterr().out


def test_main_refuses_a_malformed_scorecard_without_touching_the_published_file(tmp_path):
    src, out = tmp_path / "live.json", tmp_path / "live-accuracy.json"
    out.write_text("previous\n", encoding="utf-8")
    bad = _art()
    bad["points"]["overall"]["n"] = 99
    src.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValueError):
        main(["--src", str(src), "--out", str(out)])
    assert out.read_text(encoding="utf-8") == "previous\n"


def test_the_committed_scorecard_extracts():
    """The real artifact on main passes the checks (the site would otherwise publish nothing)."""
    art = json.loads(Path("models/diagnostics/live_2026_weekly.json").read_text(encoding="utf-8"))
    out = extract(art)
    assert out["weeks"] and out["overall"]["n"] == sum(w["n"] for w in out["weeks"])
