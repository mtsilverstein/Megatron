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
