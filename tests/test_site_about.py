import json
from pathlib import Path

import pytest

from ffmodel.site.about import build_about


def _report(tmp_path, name, created):
    payload = {"created": created, "seasons": [2012, 2025],
               "test_seasons": [2023], "scoring": "ppr",
               "results": [{"model": "naive_last4", "test_season": 2023,
                            "position": "OVERALL", "mae": 4.6, "rmse": 6.4, "n": 100}]}
    p = tmp_path / name
    p.write_text(json.dumps(payload))
    return p


def test_merges_and_sorts_newest_first(tmp_path):
    older = _report(tmp_path, "baselines.json", "2026-07-10T05:00:00+00:00")
    newer = _report(tmp_path, "bakeoff.json", "2026-07-12T05:00:00+00:00")
    about = build_about([older, newer], data_through="2025-01-05", site_model="test")
    assert [r["source"] for r in about["reports"]] == ["bakeoff.json", "baselines.json"]
    json.dumps(about)


def test_rejects_malformed_report(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"created": "x"}))
    with pytest.raises(ValueError, match="bad.json"):
        build_about([bad], data_through="2025-01-05", site_model="test")


def _board_report(tmp_path, name="board_backtest.json"):
    # The board backtest report schema (ffmodel.eval.board._board_report):
    # keyed by board_seasons, not test_seasons.
    payload = {"created": "2026-07-13T05:00:00+00:00", "board_seasons": [2023],
               "scoring": "ppr", "transformer_roots": None,
               "results": [{"model": "naive_last4", "board_season": 2023,
                            "position": "OVERALL", "n": 152,
                            "season_mae_topN": 93.0}]}
    p = tmp_path / name
    p.write_text(json.dumps(payload))
    return p


def test_skips_board_backtest_reports(tmp_path):
    # models/backtests holds BOTH weekly-harness reports and the board backtest;
    # generate.py globs the whole directory, so build_about must skip board
    # reports rather than crash on their schema (the about page shows weekly
    # tables only — a board table is a planned follow-up, see plan 4).
    weekly = _report(tmp_path, "bakeoff.json", "2026-07-12T05:00:00+00:00")
    board = _board_report(tmp_path)
    about = build_about([board, weekly], data_through="2025-01-05", site_model="test")
    assert [r["source"] for r in about["reports"]] == ["bakeoff.json"]
    json.dumps(about)


def test_all_board_reports_fails_loud(tmp_path):
    # Skipping must never produce an about page with zero tables.
    board = _board_report(tmp_path)
    with pytest.raises(ValueError, match="no weekly backtest reports"):
        build_about([board], data_through="2025-01-05", site_model="test")


def test_about_carries_site_model(tmp_path):
    report = _report(tmp_path, "baselines.json", "2026-07-10T05:00:00+00:00")
    about = build_about([report], data_through="2025-wk18", site_model="xgboost")
    assert about["site_model"] == "xgboost"
