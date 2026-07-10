"""Encoder-only quantile transformer sized for ~100k samples (spec §5)."""
from __future__ import annotations

import warnings

import torch
from torch import nn


class QuantileTransformer(nn.Module):
    def __init__(self, n_seq_features: int, n_ctx_features: int, max_seq_len: int,
                 d_model: int = 96, n_heads: int = 4, n_layers: int = 3,
                 dropout: float = 0.1, n_stats: int = 11, n_quantiles: int = 3):
        super().__init__()
        self.n_stats, self.n_quantiles = n_stats, n_quantiles
        self.game_proj = nn.Linear(n_seq_features, d_model)
        self.ctx_proj = nn.Linear(n_ctx_features, d_model)
        self.pos_emb = nn.Parameter(torch.randn(max_seq_len + 1, d_model) * 0.02)
        layer = nn.TransformerEncoderLayer(
            d_model, n_heads, dim_feedforward=4 * d_model, dropout=dropout,
            batch_first=True, norm_first=True,
        )
        with warnings.catch_warnings():
            warnings.filterwarnings('ignore', message='.*enable_nested_tensor.*')
            self.encoder = nn.TransformerEncoder(layer, n_layers)
        self.head = nn.Sequential(nn.LayerNorm(d_model),
                                  nn.Linear(d_model, n_stats * n_quantiles))

    def forward(self, x_seq: torch.Tensor, x_ctx: torch.Tensor,
                pad_mask: torch.Tensor) -> torch.Tensor:
        batch, seq_len, _ = x_seq.shape
        tokens = torch.cat(
            [self.ctx_proj(x_ctx).unsqueeze(1), self.game_proj(x_seq)], dim=1
        ) + self.pos_emb[: seq_len + 1]
        # context token (position 0) is never masked, so a rookie with an
        # all-padding history still yields a finite prediction
        mask = torch.cat(
            [torch.zeros(batch, 1, dtype=torch.bool, device=x_seq.device), pad_mask],
            dim=1,
        )
        hidden = self.encoder(tokens, src_key_padding_mask=mask)
        return self.head(hidden[:, 0]).view(batch, self.n_stats, self.n_quantiles)


def pinball_loss(pred: torch.Tensor, target: torch.Tensor,
                 quantiles: tuple[float, ...]) -> torch.Tensor:
    diff = target.unsqueeze(-1) - pred
    q = torch.tensor(quantiles, device=pred.device, dtype=pred.dtype).view(1, 1, -1)
    return torch.maximum(q * diff, (q - 1) * diff).mean()


def monotone(pred: torch.Tensor) -> torch.Tensor:
    """Sort along the quantile dim so p10 <= p50 <= p90 always holds."""
    return torch.sort(pred, dim=-1).values
