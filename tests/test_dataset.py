import numpy as np
import pandas as pd

from ffmodel.data.features import build_features
from ffmodel.model.dataset import (
    CTX_FEATURES, SEQ_FEATURES, Scaler, apply_scaler, build_sequences, fit_scaler, subset,
)
from ffmodel.scoring import PREDICTED_STATS

from tests.test_features import make_schedules, make_weekly


def _features(n_weeks=6):
    rows = [{"week": w, "receiving_yards": 10.0 * w} for w in range(1, n_weeks + 1)]
    return build_features(make_weekly(rows), make_schedules(n_weeks))


def test_shapes_and_padding():
    data = build_sequences(_features(), seq_len=4, min_history=1)
    assert data.x_seq.shape == (5, 4, len(SEQ_FEATURES))   # weeks 2-6 (week 1 dropped)
    assert data.x_ctx.shape == (5, len(CTX_FEATURES))
    assert data.y.shape == (5, len(PREDICTED_STATS))
    # week-2 sample has exactly one real game (left-padded)
    wk2 = data.meta.index[data.meta["week"] == 2][0]
    assert data.pad_mask[wk2].tolist() == [True, True, True, False]


def test_sequence_excludes_current_week_and_orders_recent_last():
    features = _features()
    data = build_sequences(features, seq_len=4, min_history=1)
    ry = SEQ_FEATURES.index("receiving_yards")
    wk6 = data.meta.index[data.meta["week"] == 6][0]
    # weeks 2,3,4,5 -> 20,30,40,50; current week (60) must NOT appear
    assert data.x_seq[wk6, :, ry].tolist() == [20.0, 30.0, 40.0, 50.0]


def test_min_history_zero_keeps_rookie_rows():
    data = build_sequences(_features(), seq_len=4, min_history=0)
    assert len(data.meta) == 6
    wk1 = data.meta.index[data.meta["week"] == 1][0]
    assert data.pad_mask[wk1].all()


def test_meta_row_id_maps_back_to_frame():
    features = _features()
    data = build_sequences(features, seq_len=4, min_history=1)
    for i in range(len(data.meta)):
        row = features.loc[data.meta["row_id"].iloc[i]]
        assert row["week"] == data.meta["week"].iloc[i]


def test_scaler_train_only_and_zero_fills(tmp_path):
    data = build_sequences(_features(), seq_len=4, min_history=1)
    scaler = fit_scaler(data)
    scaled = apply_scaler(data, scaler)
    assert not np.isnan(scaled.x_seq).any()
    assert not np.isnan(scaled.x_ctx).any()
    assert (scaled.x_seq[scaled.pad_mask] == 0).all()
    np.testing.assert_array_equal(scaled.y, data.y)  # targets never scaled
    # round-trip
    scaler.save(tmp_path / "scaler.json")
    loaded = Scaler.load(tmp_path / "scaler.json")
    np.testing.assert_allclose(loaded.seq_mean, scaler.seq_mean)


def test_scaler_handles_all_nan_columns_without_warnings():
    import warnings

    data = build_sequences(_features(), seq_len=4, min_history=1)
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # any warning fails the test
        scaler = fit_scaler(data)
        scaled = apply_scaler(data, scaler)
    ts = SEQ_FEATURES.index("target_share")  # all-NaN in the fixture
    assert scaler.seq_mean[ts] == 0.0
    assert scaler.seq_std[ts] == 1.0
    assert not np.isnan(scaled.x_seq).any()


def test_subset_keeps_rows_aligned():
    data = build_sequences(_features(), seq_len=4, min_history=0)
    mask = (data.meta["week"] >= 4).to_numpy()
    sub = subset(data, mask)
    assert len(sub.meta) == mask.sum()
    np.testing.assert_array_equal(sub.y, data.y[mask])
    assert (sub.meta["week"] >= 4).all()
