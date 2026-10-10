"""Build models/diagnostics/main_push_ledger.json from the 2026-10-06 raw activity capture (spec §4.1 seed).

Usage: .venv/Scripts/python.exe tools/build_push_ledger_seed.py .review/evidence-seed/activity-main-2026-10-06T190201Z.json
The capture paginated to the end of history and its oldest event is main's branch_creation, so its coverage
interval is ["-inf", capture time].
"""
import json
import sys
from pathlib import Path

from ffmodel.eval.live_accuracy import LEDGER_PATH, merge_collection, save_ledger

CAPTURED_AT = "2026-10-06T19:02:01Z"


def main(path: str) -> None:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    ledger = merge_collection({"events": [], "coverage": []}, raw, t_end=CAPTURED_AT)
    save_ledger(ledger, LEDGER_PATH)
    print(f"{len(ledger['events'])} events; coverage {ledger['coverage']}")


if __name__ == "__main__":
    main(sys.argv[1])
