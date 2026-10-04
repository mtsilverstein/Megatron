"""Regenerate tests/fixtures/leaguelens_parity.json: Python reference lens scores that the JS lens must match.

    python tools/make_leaguelens_parity.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from ffmodel.site import leaguelens as L  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "leaguelens_parity.json"
EXTRA = {
    "custom_a": {"pass_yd": 0.05, "rec": 0.5, "bonus_rec_te": 0.5, "rush_att": 0.1, "pass_int_td": -2},
    "custom_b": {"rec": -1, "bonus_rec_te": 2, "pass_td": 4},
}
# NaN is omitted: it is not representable in JSON.
MALFORMED = [
    ("p10 null, p90 present", {"p10": None, "p50": {"receptions": 5}, "p90": {"receptions": 8}}, "Incomplete"),
    ("string stat", {"p10": None, "p50": {"receptions": "5"}, "p90": None}, "invalid"),
    ("bool stat", {"p10": None, "p50": {"receptions": True}, "p90": None}, "invalid"),
    ("inverted band", {"p10": {"receptions": 8}, "p50": {"receptions": 5}, "p90": {"receptions": 2}}, "Malformed band"),
    ("list-valued band", {"p10": [2], "p50": {"receptions": 5}, "p90": [8]}, "Incomplete"),
    ("list-valued p50", {"p10": None, "p50": [5], "p90": None}, "Incomplete"),
]


def main() -> None:
    weekly = json.loads((ROOT / "site/data/weekly.json").read_text())
    fam = json.loads((ROOT / "site/data/weekly-fam.json").read_text())
    scorings = {"gabagool": weekly["league"]["sleeper_scoring"], "fam": fam["league"]["sleeper_scoring"], **EXTRA}
    cases = []
    for p in weekly["players"][:40]:
        for sname, scoring in scorings.items():
            cases.append({"name": f"{p['name']}|{sname}", "position": p["position"], "scoring": scoring,
                          "stat_quantiles": p["stat_quantiles"],
                          "expected": L.reference_score(p["stat_quantiles"], p["position"], L.effective_weights(scoring))})
    for name, sq, err in MALFORMED:
        cases.append({"name": f"malformed: {name}", "position": "WR", "scoring": {"rec": 1},
                      "stat_quantiles": sq, "expected_error": err})
    OUT.write_text(json.dumps({"cases": cases}, indent=1) + "\n")
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
