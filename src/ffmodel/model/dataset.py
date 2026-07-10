"""Sequence tensors for the quantile transformer.

Each sample is a (player, week): the player's previous `seq_len` games
(left-padded, most recent last) plus a target-week context vector; the
target is that week's raw stat line. Same leak rules as features.py:
strictly pre-game information only.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.scoring import PREDICTED_STATS

SEQ_FEATURES = PREDICTED_STATS + [
    "target_share", "carry_share", "ppr_points", "is_home", "rest_days", "week",
]
CTX_FEATURES = [
    "is_home", "rest_days", "week", "games_prior",
    "opp_allowed_last4", "opp_allowed_season",
    "pos_QB", "pos_RB", "pos_WR", "pos_TE",
]


@dataclass
class SequenceData:
    x_seq: np.ndarray
    x_ctx: np.ndarray
    y: np.ndarray
    pad_mask: np.ndarray
    meta: pd.DataFrame


def build_sequences(
    features: pd.DataFrame, seq_len: int = 16, min_history: int = 1
) -> SequenceData:
    df = features.sort_values(["player_id", "season", "week"]).reset_index(names="row_id")
    seq_vals = df[SEQ_FEATURES].to_numpy(dtype=np.float32)
    n = len(df)
    x_seq = np.zeros((n, seq_len, len(SEQ_FEATURES)), dtype=np.float32)
    pad_mask = np.ones((n, seq_len), dtype=bool)
    for idx in df.groupby("player_id", sort=False).indices.values():
        for j, row in enumerate(idx):
            hist = idx[max(0, j - seq_len):j]  # strictly prior games
            if len(hist):
                x_seq[row, seq_len - len(hist):] = seq_vals[hist]
                pad_mask[row, seq_len - len(hist):] = False
    keep = df["games_prior"].to_numpy() >= min_history
    meta = df.loc[keep, ["row_id", "player_id", "season", "week", "position"]]
    return SequenceData(
        x_seq[keep], df[CTX_FEATURES].to_numpy(dtype=np.float32)[keep],
        df[PREDICTED_STATS].to_numpy(dtype=np.float32)[keep],
        pad_mask[keep], meta.reset_index(drop=True),
    )


@dataclass
class Scaler:
    seq_mean: np.ndarray
    seq_std: np.ndarray
    ctx_mean: np.ndarray
    ctx_std: np.ndarray

    def save(self, path: Path) -> None:
        payload = {k: getattr(self, k).tolist() for k in
                   ("seq_mean", "seq_std", "ctx_mean", "ctx_std")}
        Path(path).write_text(json.dumps(payload))

    @classmethod
    def load(cls, path: Path) -> "Scaler":
        payload = json.loads(Path(path).read_text())
        return cls(**{k: np.asarray(v, dtype=np.float32) for k, v in payload.items()})


def _safe_std(std: np.ndarray) -> np.ndarray:
    return np.where(std < 1e-6, 1.0, std).astype(np.float32)


def fit_scaler(data: SequenceData) -> Scaler:
    real = data.x_seq[~data.pad_mask]  # only non-padded game entries
    return Scaler(
        seq_mean=np.nanmean(real, axis=0).astype(np.float32),
        seq_std=_safe_std(np.nanstd(real, axis=0)),
        ctx_mean=np.nanmean(data.x_ctx, axis=0).astype(np.float32),
        ctx_std=_safe_std(np.nanstd(data.x_ctx, axis=0)),
    )


def apply_scaler(data: SequenceData, scaler: Scaler) -> SequenceData:
    x_seq = (data.x_seq - scaler.seq_mean) / scaler.seq_std
    x_seq = np.nan_to_num(x_seq, nan=0.0)
    x_seq[data.pad_mask] = 0.0
    x_ctx = np.nan_to_num((data.x_ctx - scaler.ctx_mean) / scaler.ctx_std, nan=0.0)
    return SequenceData(x_seq.astype(np.float32), x_ctx.astype(np.float32),
                        data.y, data.pad_mask, data.meta)
