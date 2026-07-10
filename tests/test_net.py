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
