from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.metrics import coverage, mae, pinball_loss, rmse, score_table
from ffmodel.eval.splits import walk_forward_splits


def test_walk_forward_train_strictly_earlier():
    df = pd.DataFrame({"season": [2021, 2022, 2023, 2024, 2025]})
    splits = list(walk_forward_splits(df, test_seasons=[2023, 2024]))
    assert [s for s, _, _ in splits] == [2023, 2024]
    for test_season, train_idx, test_idx in splits:
        assert (df.loc[train_idx, "season"] < test_season).all()
        assert (df.loc[test_idx, "season"] == test_season).all()
        assert set(train_idx).isdisjoint(test_idx)


def test_mae_rmse():
    y, p = np.array([0.0, 10.0]), np.array([2.0, 6.0])
    assert mae(y, p) == pytest.approx(3.0)
    assert rmse(y, p) == pytest.approx(np.sqrt((4 + 16) / 2))


def test_pinball_loss_asymmetry():
    y, p = np.array([10.0]), np.array([8.0])   # under-prediction by 2
    assert pinball_loss(y, p, q=0.9) == pytest.approx(1.8)  # 0.9 * 2
    assert pinball_loss(y, p, q=0.1) == pytest.approx(0.2)  # 0.1 * 2


def test_coverage():
    y = np.array([1.0, 5.0, 9.0, 20.0])
    lo, hi = np.zeros(4), np.full(4, 10.0)
    assert coverage(y, lo, hi) == pytest.approx(0.75)


def test_score_table_per_position_and_overall():
    frame = pd.DataFrame({
        "position": ["WR", "WR", "RB"],
        "actual": [10.0, 20.0, 5.0],
        "pred": [12.0, 20.0, 9.0],
    })
    table = score_table(frame).set_index("position")
    assert table.loc["WR", "mae"] == pytest.approx(1.0)
    assert table.loc["RB", "n"] == 1
    assert table.loc["OVERALL", "mae"] == pytest.approx(2.0)


def test_walk_forward_sorts_unsorted_test_seasons():
    df = pd.DataFrame({"season": [2022, 2023, 2024]})
    seasons = [s for s, _, _ in walk_forward_splits(df, test_seasons=[2024, 2023])]
    assert seasons == [2023, 2024]


def test_score_table_rejects_empty_frame():
    frame = pd.DataFrame({"position": [], "actual": [], "pred": []})
    with pytest.raises(ValueError, match="empty"):
        score_table(frame)


def test_run_cli_parses_transformer_root():
    """--transformer-root is repeatable (action="append"): a single flag
    still adds exactly one entrant, now expressed as a one-element list
    (see test_run_cli_parses_repeated_transformer_root for the ensemble
    case) -- --transformer-root's downstream behavior for a single root is
    unchanged, it's just carried in a list now."""
    from ffmodel.eval.run import build_parser

    args = build_parser().parse_args(["--transformer-root", "models/transformer/v1"])
    assert [str(p) for p in args.transformer_root] == [str(Path("models/transformer/v1"))]
    assert build_parser().parse_args([]).transformer_root is None


def test_run_cli_parses_repeated_transformer_root():
    """Repeating the flag collects multiple roots in order, e.g. to average
    seed-ensemble artifacts (v1_s43, v1_s44, ...) at eval time."""
    from ffmodel.eval.run import build_parser

    args = build_parser().parse_args([
        "--transformer-root", "models/transformer/v1_s43",
        "--transformer-root", "models/transformer/v1_s44",
    ])
    assert [str(p) for p in args.transformer_root] == [
        str(Path("models/transformer/v1_s43")), str(Path("models/transformer/v1_s44")),
    ]


def test_mixed_entrant_records_serialize_to_valid_json():
    import json

    results = pd.DataFrame({
        "position": ["OVERALL", "OVERALL"],
        "mae": [4.5, 4.4],
        "pinball_p10": [np.nan, 1.2],   # baseline row lacks quantile metrics
    })
    records = results.astype(object).where(pd.notna(results), None).to_dict(orient="records")
    payload = json.dumps({"results": records})
    parsed = json.loads(payload)        # strict parse must succeed
    assert parsed["results"][0]["pinball_p10"] is None
    assert parsed["results"][1]["pinball_p10"] == 1.2
