"""Encoder-only quantile transformer sized for ~100k samples (spec §5)."""
from __future__ import annotations

import torch
from torch import nn
import torch.nn.functional as F


class QuantileTransformer(nn.Module):
    def __init__(self, n_seq_features: int, n_ctx_features: int, max_seq_len: int,
                 d_model: int = 96, n_heads: int = 4, n_layers: int = 3,
                 dropout: float = 0.1, n_stats: int = 11, n_quantiles: int = 3,
                 n_counts: int = 0):
        super().__init__()
        self.n_stats, self.n_quantiles = n_stats, n_quantiles
        self.game_proj = nn.Linear(n_seq_features, d_model)
        self.ctx_proj = nn.Linear(n_ctx_features, d_model)
        self.pos_emb = nn.Parameter(torch.randn(max_seq_len + 1, d_model) * 0.02)
        layer = nn.TransformerEncoderLayer(
            d_model, n_heads, dim_feedforward=4 * d_model, dropout=dropout,
            batch_first=True, norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, n_layers, enable_nested_tensor=False)
        self.head = nn.Sequential(nn.LayerNorm(d_model),
                                  nn.Linear(d_model, n_stats * n_quantiles))
        # Optional conditional-mean head. n_counts=0 leaves the module (and so
        # the state_dict) structurally identical to v1, which is what lets every
        # committed artifact keep loading with strict=True.
        self.n_counts = n_counts
        self.mean_head = (
            nn.Sequential(nn.LayerNorm(d_model), nn.Linear(d_model, n_counts))
            if n_counts else None
        )

    def _encode(self, x_seq: torch.Tensor, x_ctx: torch.Tensor,
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
        return hidden[:, 0]

    def forward(self, x_seq: torch.Tensor, x_ctx: torch.Tensor,
                pad_mask: torch.Tensor) -> torch.Tensor:
        return (self.head(self._encode(x_seq, x_ctx, pad_mask))
                .view(x_seq.shape[0], self.n_stats, self.n_quantiles))

    def forward_all(self, x_seq: torch.Tensor, x_ctx: torch.Tensor,
                    pad_mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor | None]:
        """Quantiles plus the mean head's LOG-RATE, sharing one trunk pass.

        Returns `(quantiles, None)` when no mean head is configured.
        """
        hidden = self._encode(x_seq, x_ctx, pad_mask)
        quantiles = self.head(hidden).view(
            x_seq.shape[0], self.n_stats, self.n_quantiles)
        log_rate = self.mean_head(hidden) if self.mean_head is not None else None
        return quantiles, log_rate


def pinball_loss(pred: torch.Tensor, target: torch.Tensor,
                 quantiles: tuple[float, ...],
                 head_weights: torch.Tensor | None = None) -> torch.Tensor:
    """Mean pinball loss over [batch, n_stats, n_quantiles].

    `head_weights` (shape [n_stats], normalized to mean 1 by the caller)
    rescales each stat head's contribution before the mean, to counter the
    scale domination of large-magnitude heads (yardage) over small-magnitude
    high-value heads (touchdowns). `None` is byte-identical to the unweighted
    loss, so every pre-existing caller and artifact is unaffected.
    """
    diff = target.unsqueeze(-1) - pred
    q = torch.tensor(quantiles, device=pred.device, dtype=pred.dtype).view(1, 1, -1)
    loss = torch.maximum(q * diff, (q - 1) * diff)      # [n, n_stats, n_q]
    if head_weights is not None:
        loss = loss * head_weights.to(loss.dtype).view(1, -1, 1)
    return loss.mean()


def poisson_mean_loss(log_rate: torch.Tensor,
                      target_counts: torch.Tensor) -> torch.Tensor:
    """Poisson NLL under a log link, mean-reduced over [batch, n_counts].

    Estimates the conditional MEAN of a count component -- the quantity fantasy
    points actually need, since points are linear in components
    (`E[points] = sum_i w_i E[X_i]`) while `median(sum) != sum(medians)`. The log
    link makes a negative predicted count unrepresentable.
    """
    return F.poisson_nll_loss(log_rate, target_counts, log_input=True,
                              full=False, reduction="mean")


def monotone(pred: torch.Tensor) -> torch.Tensor:
    """Sort along the quantile dim so p10 <= p50 <= p90 always holds."""
    return torch.sort(pred, dim=-1).values
