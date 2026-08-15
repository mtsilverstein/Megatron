"""About-the-model payload: honest backtest tables, straight from models/backtests."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

REQUIRED_KEYS = {"created", "test_seasons", "scoring", "results"}


# The nominal coverage of a p10-p90 band. Named because the page compares
# measured coverage against it in three places.
BAND_NOMINAL = 0.80


def season_band_summary(payload: dict) -> dict:
    """By-position season band coverage, from a draft-board backtest report.

    WHY THIS IS PUBLISHED RATHER THAN TYPED. The about page used to carry
    `const SEASON_COVERAGE = "0.73-0.77"` as a hand-written constant with no
    link to the artifact behind it, and it drifted: 0.73-0.77 is the range of
    the OVERALL row POOLED across positions, but the page called it a
    by-position range. Measured by position the real spread is 0.615-0.846 --
    a 19-point shortfall at QB 2023, wider than the pooled figure admits in
    both directions. Deriving it here means the page cannot disagree with the
    file again.

    `n` per cell is 26-50, so the spread is partly sampling noise. That is
    exactly why the cell counts ship alongside the range instead of a bare
    interval: a reader has to be able to see how thin the worst cell is.
    """
    rows = [r for r in payload.get("results", [])
            if r.get("model") == "transformer"
            and r.get("season_band_coverage") is not None]
    by_pos = [r for r in rows if r.get("position") != "OVERALL"]
    pooled = [r for r in rows if r.get("position") == "OVERALL"]
    if not by_pos:
        raise ValueError("board backtest has no by-position season coverage "
                         "rows — refusing to publish a coverage claim with "
                         "nothing behind it")
    cov = lambda r: r["season_band_coverage"]
    worst = min(by_pos, key=cov)
    return {
        "source": payload.get("_source"),
        "nominal": BAND_NOMINAL,
        "seasons": payload.get("board_seasons"),
        "by_position_min": cov(min(by_pos, key=cov)),
        "by_position_max": cov(max(by_pos, key=cov)),
        "pooled_min": min((cov(r) for r in pooled), default=None),
        "pooled_max": max((cov(r) for r in pooled), default=None),
        "worst_cell": {"season": worst.get("board_season"),
                       "position": worst.get("position"),
                       "n": worst.get("n"), "coverage": cov(worst)},
        "n_min": min(r["n"] for r in by_pos),
        "n_max": max(r["n"] for r in by_pos),
        # Every cell, so the page can show the grid rather than assert a range.
        "cells": [{"season": r.get("board_season"), "position": r.get("position"),
                   "n": r.get("n"), "coverage": cov(r)} for r in by_pos],
    }


def build_about(backtest_paths: list[Path], data_through: str, site_model: str) -> dict:
    reports = []
    season_bands = None
    for path in backtest_paths:
        payload = json.loads(Path(path).read_text())
        if "board_seasons" in payload:
            # A draft-board backtest report (ffmodel.eval.board) shares the
            # directory but not the schema, so it is not a weekly `report`.
            # Its season-band coverage IS published, though, as `season_bands`
            # -- the page states a season-coverage figure and must state the
            # one this file actually contains (see season_band_summary).
            #
            # Only summarised when the file actually carries coverage. A board
            # report without it is still a legal thing to find in the directory
            # (the metric postdates the report), and the long-standing contract
            # here is to skip what we cannot use rather than fail the whole
            # page. `season_bands` then stays None and the page says nothing --
            # no claim is the correct degradation, since the failure this
            # replaced was stating a number nothing supported.
            if any(r.get("season_band_coverage") is not None
                   for r in payload.get("results", [])):
                season_bands = season_band_summary({**payload,
                                                    "_source": Path(path).name})
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
        "season_bands": season_bands,
    }
