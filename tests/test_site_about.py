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


def test_about_carries_site_model(tmp_path):
    report = _report(tmp_path, "baselines.json", "2026-07-10T05:00:00+00:00")
    about = build_about([report], data_through="2025-wk18", site_model="xgboost")
    assert about["site_model"] == "xgboost"
