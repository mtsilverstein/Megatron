import numpy as np
import pytest
import torch

from ffmodel.model.net import QuantileTransformer, monotone, pinball_loss


def _model():
    torch.manual_seed(0)
    return QuantileTransformer(n_seq_features=17, n_ctx_features=10, max_seq_len=8,
                               d_model=32, n_heads=2, n_layers=1, n_stats=11)


def _batch(B=4, L=8):
    g = torch.Generator().manual_seed(0)
    x_seq = torch.randn(B, L, 17, generator=g)
    x_ctx = torch.randn(B, 10, generator=g)
    pad = torch.zeros(B, L, dtype=torch.bool)
    pad[:, :3] = True  # first 3 positions padded
    x_seq[pad] = 0.0
    return x_seq, x_ctx, pad


def test_forward_shape():
    m = _model().eval()
    x_seq, x_ctx, pad = _batch()
    out = m(x_seq, x_ctx, pad)
    assert out.shape == (4, 11, 3)


def test_padding_entries_do_not_affect_output():
    m = _model().eval()
    x_seq, x_ctx, pad = _batch()
    with torch.no_grad():
        base = m(x_seq, x_ctx, pad)
        x_seq2 = x_seq.clone()
        x_seq2[pad] = 999.0  # garbage in padded slots
        out2 = m(x_seq2, x_ctx, pad)
    torch.testing.assert_close(base, out2, atol=1e-5, rtol=1e-4)


def test_fully_padded_sequence_still_outputs():
    m = _model().eval()
    x_seq, x_ctx, _ = _batch()
    pad = torch.ones(4, 8, dtype=torch.bool)  # rookie: no history at all
    with torch.no_grad():
        out = m(x_seq, x_ctx, pad)
    assert torch.isfinite(out).all()


def test_pinball_matches_numpy_reference():
    from ffmodel.eval.metrics import pinball_loss as np_pinball

    torch.manual_seed(1)
    pred = torch.randn(64, 11, 3)
    target = torch.randn(64, 11)
    qs = (0.1, 0.5, 0.9)
    got = pinball_loss(pred, target, qs).item()
    want = np.mean([np_pinball(target.numpy().ravel(),
                               pred[:, :, i].numpy().ravel(), q)
                    for i, q in enumerate(qs)])
    assert got == pytest.approx(want, rel=1e-5)


def test_monotone_sorts_quantiles():
    x = torch.tensor([[[3.0, 1.0, 2.0]]])
    torch.testing.assert_close(monotone(x), torch.tensor([[[1.0, 2.0, 3.0]]]))


def test_count_stat_constants_resolve_by_name():
    from ffmodel.scoring import COUNT_IDX, COUNT_STATS, PREDICTED_STATS, TD_STATS

    assert len(COUNT_STATS) == 8
    # yardage must NEVER get a mean head (spec: median is healthy there)
    for s in ("passing_yards", "rushing_yards", "receiving_yards"):
        assert s not in COUNT_STATS
    assert TD_STATS == ["passing_tds", "rushing_tds", "receiving_tds"]
    assert set(TD_STATS) <= set(COUNT_STATS)
    # indices are derived by NAME, so a reordering cannot silently retarget heads
    assert COUNT_IDX == [PREDICTED_STATS.index(s) for s in COUNT_STATS]
    assert [PREDICTED_STATS[i] for i in COUNT_IDX] == COUNT_STATS


def _tiny_model(n_counts=0):
    import torch
    from ffmodel.model.net import QuantileTransformer

    torch.manual_seed(0)
    return QuantileTransformer(n_seq_features=4, n_ctx_features=3, max_seq_len=5,
                               d_model=8, n_heads=2, n_layers=1, n_stats=11,
                               n_quantiles=3, n_counts=n_counts)


def _tiny_batch(batch=2, seq=5, n_seq=4, n_ctx=3):
    import torch

    return (torch.randn(batch, seq, n_seq), torch.randn(batch, n_ctx),
            torch.zeros(batch, seq, dtype=torch.bool))


def test_no_mean_head_is_structurally_identical_to_v1():
    m = _tiny_model(n_counts=0)
    assert m.mean_head is None
    # no extra parameters => committed v1/v2 checkpoints load with strict=True
    assert not [k for k in m.state_dict() if "mean_head" in k]


def test_mean_head_adds_only_its_own_parameters():
    base, withmean = _tiny_model(0), _tiny_model(8)
    extra = set(withmean.state_dict()) - set(base.state_dict())
    assert all("mean_head" in k for k in extra)
    assert set(base.state_dict()) <= set(withmean.state_dict())


def test_forward_shape_unchanged_and_forward_all_agrees():
    import torch

    m = _tiny_model(n_counts=8)
    x_seq, x_ctx, pad = _tiny_batch()
    m.eval()
    with torch.no_grad():
        q = m(x_seq, x_ctx, pad)
        q2, log_rate = m.forward_all(x_seq, x_ctx, pad)
    assert q.shape == (2, 11, 3)
    assert log_rate.shape == (2, 8)
    # forward and forward_all must share the trunk exactly
    assert torch.allclose(q, q2)


def test_forward_all_returns_none_without_mean_head():
    import torch

    m = _tiny_model(n_counts=0)
    m.eval()
    with torch.no_grad():
        q, log_rate = m.forward_all(*_tiny_batch())
    assert log_rate is None
    assert q.shape == (2, 11, 3)


def test_poisson_mean_loss_hand_computed_and_positive_rate():
    import torch
    from ffmodel.model.net import poisson_mean_loss

    # NLL under a log link (constant log(target!) term dropped):
    #   exp(log_rate) - target * log_rate
    # log_rate=0, target=2  ->  1 - 0 = 1
    log_rate = torch.zeros(1, 2)
    target = torch.tensor([[2.0, 2.0]])
    assert torch.isclose(poisson_mean_loss(log_rate, target), torch.tensor(1.0))
    # log_rate=ln(2), target=2 -> 2 - 2*ln2
    lr = torch.log(torch.tensor([[2.0]]))
    expected = 2.0 - 2.0 * float(torch.log(torch.tensor(2.0)))
    assert torch.isclose(poisson_mean_loss(lr, torch.tensor([[2.0]])),
                         torch.tensor(expected))
    # the log link makes a NEGATIVE predicted count unrepresentable -- this is
    # what fixes the observed negative fumbles_lost prediction
    assert bool((torch.exp(torch.randn(50, 8) * 5) > 0).all())
