import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ffmodel.model.select_lambda import (
    VAL_SEASON, _load_val_lambda, build_parser, ppr_mae,
)
from ffmodel.scoring import HALF_PPR, PPR, PREDICTED_STATS


def _frame(index, **overrides) -> pd.DataFrame:
    """A PREDICTED_STATS-columned frame, all zero except `overrides` (each
    value either a scalar or an array-like of len(index))."""
    data = {col: np.zeros(len(index)) for col in PREDICTED_STATS}
    for col, val in overrides.items():
        data[col] = np.broadcast_to(val, len(index)).astype(float)
    return pd.DataFrame(data, index=index)


# --- ppr_mae (pure) --------------------------------------------------------

def test_ppr_mae_zero_when_predictions_match_actuals():
    idx = pd.RangeIndex(5)
    stats = _frame(idx, receptions=[1, 2, 3, 4, 5],
                   receiving_yards=[10, 20, 30, 40, 50])
    assert ppr_mae(stats, stats) == pytest.approx(0.0)


def test_ppr_mae_known_value():
    idx = pd.RangeIndex(2)
    predicted = _frame(idx, receptions=[5, 3], receiving_yards=[50, 30])
    actual = _frame(idx, receptions=[6, 2], receiving_yards=[60, 20])
    # PPR points: predicted row0 = 5*1 + 50*.1 = 10.0, row1 = 3*1 + 30*.1 = 6.0
    #             actual    row0 = 6*1 + 60*.1 = 12.0, row1 = 2*1 + 20*.1 = 4.0
    # abs errors: 2.0, 2.0 -> mean 2.0
    assert ppr_mae(predicted, actual) == pytest.approx(2.0)


def test_ppr_mae_respects_scoring_rules():
    idx = pd.RangeIndex(1)
    predicted = _frame(idx, receptions=5)
    actual = _frame(idx, receptions=0)
    assert ppr_mae(predicted, actual, PPR) == pytest.approx(5.0)      # |5*1 - 0|
    assert ppr_mae(predicted, actual, HALF_PPR) == pytest.approx(2.5)  # |5*.5 - 0|


def test_ppr_mae_ignores_columns_outside_the_scoring_contract():
    """actual_stats may be a full features frame carrying extra non-scoring
    columns (season, week, position, ...) -- fantasy_points reads only the
    named scored columns, so unrelated extras must not move the result."""
    idx = pd.RangeIndex(2)
    predicted = _frame(idx, receptions=[1, 2])
    actual = _frame(idx, receptions=[1, 2])
    actual["season"] = 2016
    actual["position"] = "WR"
    assert ppr_mae(predicted, actual) == pytest.approx(0.0)


def test_ppr_mae_index_mismatch_raises():
    idx = pd.RangeIndex(3)
    predicted = _frame(idx)
    actual = _frame(idx)
    actual.index = actual.index + 100  # disjoint index
    with pytest.raises(ValueError, match="index"):
        ppr_mae(predicted, actual)


def test_ppr_mae_nonnegative_and_symmetric_in_sign():
    """MAE is a distance: swapping predicted/actual gives the same value,
    and it is never negative."""
    idx = pd.RangeIndex(4)
    a = _frame(idx, rushing_yards=[10, 20, 30, 40], rushing_tds=[0, 1, 0, 2])
    b = _frame(idx, rushing_yards=[15, 18, 40, 35], rushing_tds=[1, 1, 1, 1])
    assert ppr_mae(a, b) == pytest.approx(ppr_mae(b, a))
    assert ppr_mae(a, b) >= 0.0


# --- _load_val_lambda (I/O helper, no trained model required) -------------

def _write_metrics(root: Path, dir_season: int, **overrides) -> Path:
    """Write root/through{dir_season}/metrics.json. `dir_season` picks the
    ARTIFACT DIRECTORY (where `_load_val_lambda` looks); the recorded
    `val_season` field defaults to the same value but can be overridden
    independently to simulate a directory/content mismatch."""
    art_dir = root / f"through{dir_season}"
    art_dir.mkdir(parents=True, exist_ok=True)
    payload = {"val_season": dir_season, "predict_mean": True, "mean_lambda": 0.3}
    payload.update(overrides)
    path = art_dir / "metrics.json"
    path.write_text(json.dumps(payload))
    return path


def test_load_val_lambda_reads_mean_lambda_from_metrics(tmp_path):
    root = tmp_path / "mh_l03"
    _write_metrics(root, VAL_SEASON, mean_lambda=0.3)
    lam, metrics = _load_val_lambda(root, VAL_SEASON)
    assert lam == pytest.approx(0.3)
    assert metrics["mean_lambda"] == 0.3


def test_load_val_lambda_missing_artifact_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        _load_val_lambda(tmp_path / "nope", VAL_SEASON)


def test_load_val_lambda_wrong_val_season_raises(tmp_path):
    root = tmp_path / "mh_l03"
    # File lives at through2016 (so it's found), but its own recorded
    # val_season field says 2017 -- an inconsistent artifact.
    _write_metrics(root, VAL_SEASON, val_season=2017)
    with pytest.raises(ValueError, match="val_season"):
        _load_val_lambda(root, VAL_SEASON)


def test_load_val_lambda_non_mean_head_artifact_raises(tmp_path):
    root = tmp_path / "v1"
    _write_metrics(root, VAL_SEASON, predict_mean=False)
    with pytest.raises(ValueError, match="predict_mean"):
        _load_val_lambda(root, VAL_SEASON)


# --- CLI --------------------------------------------------------------------

def test_build_parser_defaults_and_repeatable_root():
    parser = build_parser()
    args = parser.parse_args([
        "--root", "models/transformer/mh_l01",
        "--root", "models/transformer/mh_l03",
    ])
    assert args.root == [
        Path("models/transformer/mh_l01"),
        Path("models/transformer/mh_l03"),
    ]
    assert args.val_season == VAL_SEASON
    assert args.data_dir == Path("data")
    assert args.first_season == 2012


def test_build_parser_requires_at_least_one_root():
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args([])
