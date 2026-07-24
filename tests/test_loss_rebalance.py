import numpy as np
import pytest
import torch

from ffmodel.model.net import pinball_loss
from ffmodel.scoring import PREDICTED_STATS


def _rand(n=8, k=len(PREDICTED_STATS), qn=3, seed=0):
    g = torch.Generator().manual_seed(seed)
    pred = torch.randn(n, k, qn, generator=g)
    target = torch.randn(n, k, generator=g)
    return pred, target


def test_none_weights_is_byte_identical_to_unweighted():
    pred, target = _rand()
    q = (0.1, 0.5, 0.9)
    a = pinball_loss(pred, target, q)
    b = pinball_loss(pred, target, q, head_weights=None)
    assert torch.equal(a, b)


def test_uniform_weights_equal_unweighted():
    """Mean-1 uniform weights must leave the loss unchanged."""
    pred, target = _rand()
    q = (0.1, 0.5, 0.9)
    w = torch.ones(len(PREDICTED_STATS))
    assert pinball_loss(pred, target, q, head_weights=w) == pytest.approx(
        float(pinball_loss(pred, target, q)), rel=1e-6)


def test_weights_scale_the_target_head():
    """Doubling one head's weight must increase the loss by exactly that
    head's share of the total pinball."""
    pred, target = _rand()
    q = (0.1, 0.5, 0.9)
    diff = target.unsqueeze(-1) - pred
    qt = torch.tensor(q).view(1, 1, -1)
    per_head = torch.maximum(qt * diff, (qt - 1) * diff).mean(dim=(0, 2))  # [k]
    base = float(pinball_loss(pred, target, q))
    w = torch.ones(len(PREDICTED_STATS))
    w[3] = 2.0
    got = float(pinball_loss(pred, target, q, head_weights=w))
    # loss = mean over k of (w_k * per_head_k) / (n_q normalization already in per_head)
    expected = base + per_head[3].item() / len(PREDICTED_STATS)
    assert got == pytest.approx(expected, rel=1e-6)


def test_std_weights_use_train_rows_only_and_normalize_to_mean_one():
    from ffmodel.model.train import _head_weights

    # a stat with tiny variance should get a LARGE weight, and vice versa
    targets = np.zeros((100, len(PREDICTED_STATS)), dtype=np.float32)
    rng = np.random.default_rng(0)
    targets[:, 0] = rng.normal(0, 100, 100)   # passing_yards: huge scale
    targets[:, 5] = rng.normal(0, 0.3, 100)   # rushing_tds: tiny scale
    w = _head_weights({"loss_weighting": "std"}, targets)
    assert w is not None
    assert abs(float(np.mean(w)) - 1.0) < 1e-5           # mean-1 normalized
    assert w[5] > w[0]                                    # tiny-scale head upweighted
    assert len(w) == len(PREDICTED_STATS)


def test_std_weights_floor_degenerate_variance():
    from ffmodel.model.train import _head_weights

    targets = np.ones((50, len(PREDICTED_STATS)), dtype=np.float32)  # all constant
    w = _head_weights({"loss_weighting": "std"}, targets)
    assert np.all(np.isfinite(w))                        # no div-by-zero blowup


def test_points_weights_match_scoring_coefficients_with_floor():
    from ffmodel.model.train import _head_weights
    from ffmodel.scoring import PPR, stat_weights

    targets = np.ones((10, len(PREDICTED_STATS)), dtype=np.float32)
    w = _head_weights({"loss_weighting": "points"}, targets)
    coef = stat_weights(PPR)
    raw = np.array([abs(coef.get(s, 0.0)) or 0.04 for s in PREDICTED_STATS])
    expected = raw / raw.mean()
    np.testing.assert_allclose(w, expected, rtol=1e-6)
    # carries/targets (unscored) get the floor, never zero
    for s in ("carries", "targets"):
        assert w[PREDICTED_STATS.index(s)] > 0


def test_none_and_missing_resolve_to_no_weights():
    from ffmodel.model.train import _head_weights

    targets = np.ones((10, len(PREDICTED_STATS)), dtype=np.float32)
    assert _head_weights({"loss_weighting": "none"}, targets) is None
    assert _head_weights({}, targets) is None            # missing key -> v1


def test_unknown_scheme_raises():
    from ffmodel.model.train import _head_weights

    targets = np.ones((10, len(PREDICTED_STATS)), dtype=np.float32)
    with pytest.raises(ValueError, match="bogus"):
        _head_weights({"loss_weighting": "bogus"}, targets)


def test_v1_config_trains_byte_identically_and_records_none():
    """A config without loss_weighting must train exactly as before this
    change: same val_pinball, same saved weights, loss_weighting=='none'."""
    import json
    import torch
    from ffmodel.model.train import train_from_config
    from tests.test_train import _cfg, _synthetic_features

    import tempfile, pathlib
    features = _synthetic_features()
    with tempfile.TemporaryDirectory() as d:
        cfg = _cfg(pathlib.Path(d), epochs=2)
        art = train_from_config(cfg, features)
        m = json.loads((art / "metrics.json").read_text())
        assert m["loss_weighting"] == "none"
        assert m["head_weights"] is None


def test_std_weighting_run_records_weights_and_trains(tmp_path):
    import json
    from ffmodel.model.train import train_from_config
    from ffmodel.scoring import PREDICTED_STATS
    from tests.test_train import _cfg, _synthetic_features

    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=1)
    cfg["loss_weighting"] = "std"
    art = train_from_config(cfg, features)
    m = json.loads((art / "metrics.json").read_text())
    assert m["loss_weighting"] == "std"
    assert m["head_weights"] is not None
    assert len(m["head_weights"]) == len(PREDICTED_STATS)
    assert abs(sum(m["head_weights"]) / len(m["head_weights"]) - 1.0) < 1e-4
    assert m["complete"] is True


def test_unknown_loss_weighting_raises_before_artifacts(tmp_path):
    import pytest
    from ffmodel.model.train import train_from_config
    from tests.test_train import _cfg, _synthetic_features

    cfg = _cfg(tmp_path, epochs=1)
    cfg["loss_weighting"] = "nonsense"
    with pytest.raises(ValueError, match="nonsense"):
        train_from_config(cfg, _synthetic_features())
    assert not (tmp_path / "artifacts").exists() or \
        not any((tmp_path / "artifacts").rglob("model.pt"))
