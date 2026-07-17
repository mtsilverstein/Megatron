"""About-the-model payload: honest backtest tables, straight from models/backtests."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

REQUIRED_KEYS = {"created", "test_seasons", "scoring", "results"}


def build_about(backtest_paths: list[Path], data_through: str, site_model: str) -> dict:
    reports = []
    for path in backtest_paths:
        payload = json.loads(Path(path).read_text())
        if "board_seasons" in payload:
            # A draft-board backtest report (ffmodel.eval.board) shares the
            # directory but not the schema; the about page renders weekly
            # tables only, so skip it. (A board table is a planned follow-up —
            # plan 4 "out of scope". Anything else malformed still fails loud.)
            continue
        missing = REQUIRED_KEYS - payload.keys()
        if missing:
            raise ValueError(f"{Path(path).name}: missing keys {sorted(missing)}")
        reports.append({"source": Path(path).name, **{k: payload[k] for k in
                        ("created", "test_seasons", "scoring", "results")}})
    if not reports:
        raise ValueError("no weekly backtest reports among "
                         f"{[Path(p).name for p in backtest_paths]} — refusing to "
                         "build an empty about page")
    reports.sort(key=lambda r: r["created"], reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_through": data_through,
        "site_model": site_model,
        "reports": reports,
    }
