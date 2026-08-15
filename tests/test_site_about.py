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


# --- season band coverage --------------------------------------------------
# This block exists because the page used to carry the figure as a hand-typed
# constant and it drifted: "0.73-0.77 by position" was actually the OVERALL
# row POOLED across positions. Measured by position the spread is 0.615-0.846.
# These tests pin the distinction the prose got wrong.

def _board_payload():
    return {
        "created": "2026-01-01", "board_seasons": [2023, 2024],
        "scoring": "ppr", "results": [
            {"model": "transformer", "board_season": 2023, "position": "QB",
             "n": 26, "season_band_coverage": 0.60},
            {"model": "transformer", "board_season": 2023, "position": "WR",
             "n": 50, "season_band_coverage": 0.86},
            {"model": "transformer", "board_season": 2023, "position": "OVERALL",
             "n": 76, "season_band_coverage": 0.75},
            # a baseline's row must not widen the transformer's claim
            {"model": "naive_last4", "board_season": 2023, "position": "QB",
             "n": 26, "season_band_coverage": 0.20},
            # a row with no coverage at all must not become a zero
            {"model": "transformer", "board_season": 2024, "position": "TE",
             "n": 26, "season_band_coverage": None},
        ],
    }


def test_by_position_range_is_not_the_pooled_range():
    from ffmodel.site.about import season_band_summary
    s = season_band_summary(_board_payload())
    assert (s["by_position_min"], s["by_position_max"]) == (0.60, 0.86)
    assert (s["pooled_min"], s["pooled_max"]) == (0.75, 0.75)
    # the exact confusion that shipped: the two must not be reported as one
    assert s["by_position_min"] < s["pooled_min"]
    assert s["by_position_max"] > s["pooled_max"]


def test_summary_ignores_baseline_models():
    from ffmodel.site.about import season_band_summary
    assert season_band_summary(_board_payload())["by_position_min"] == 0.60


def test_summary_names_the_worst_cell_with_its_sample_size():
    from ffmodel.site.about import season_band_summary
    w = season_band_summary(_board_payload())["worst_cell"]
    assert (w["position"], w["season"], w["coverage"], w["n"]) \
        == ("QB", 2023, 0.60, 26)


def test_missing_coverage_is_skipped_not_counted_as_zero():
    from ffmodel.site.about import season_band_summary
    s = season_band_summary(_board_payload())
    assert s["by_position_min"] == 0.60
    assert len(s["cells"]) == 2


def test_a_board_report_with_no_coverage_refuses_to_publish_a_claim():
    from ffmodel.site.about import season_band_summary
    with pytest.raises(ValueError, match="nothing behind it"):
        season_band_summary({"board_seasons": [2023], "results": []})


def test_build_about_publishes_season_bands_from_the_board_report(tmp_path):
    import json as _json
    from ffmodel.site.about import build_about
    board = tmp_path / "board_backtest.json"
    board.write_text(_json.dumps(_board_payload()))
    weekly = tmp_path / "bakeoff.json"
    weekly.write_text(_json.dumps({
        "created": "2026-01-02", "test_seasons": [2023], "scoring": "ppr",
        "results": [{"model": "transformer", "position": "OVERALL", "mae": 1.0}]}))
    out = build_about([board, weekly], "2025-wk18", "transformer")
    assert out["season_bands"]["by_position_max"] == 0.86
    # the board report must still be kept OUT of the weekly tables
    assert [r["source"] for r in out["reports"]] == ["bakeoff.json"]


def test_board_report_without_coverage_degrades_to_no_claim(tmp_path):
    # No claim beats a wrong claim, and beats no page. A board report that
    # predates the season-coverage metric must not take the about page down.
    board = _board_report(tmp_path)
    weekly = _report(tmp_path, "bakeoff.json", "2026-07-12T05:00:00+00:00")
    about = build_about([board, weekly], data_through="2025-01-05",
                        site_model="test")
    assert about["season_bands"] is None
    assert [r["source"] for r in about["reports"]] == ["bakeoff.json"]
