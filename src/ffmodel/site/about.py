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
        missing = REQUIRED_KEYS - payload.keys()
        if missing:
            raise ValueError(f"{Path(path).name}: missing keys {sorted(missing)}")
        reports.append({"source": Path(path).name, **{k: payload[k] for k in
                        ("created", "test_seasons", "scoring", "results")}})
    reports.sort(key=lambda r: r["created"], reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_through": data_through,
        "site_model": site_model,
        "reports": reports,
    }
