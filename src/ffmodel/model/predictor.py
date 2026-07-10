"""Bridges trained artifacts into the Plan 1 backtest harness."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from ffmodel.model.dataset import (
    CTX_FEATURES, SEQ_FEATURES, Scaler, apply_scaler, build_sequences,
)
from ffmodel.model.net import QuantileTransformer, monotone
from ffmodel.scoring import PREDICTED_STATS

QUANTILE_KEYS = ("p10", "p50", "p90")


class TransformerPredictor:
    """Predictor + predict_quantiles over walk-forward artifacts.

    Constructed with the FULL feature frame: each test row's input sequence
    reaches back into earlier seasons, which the harness's test slice does
    not contain. Leak-freedom is preserved because sequences only ever use
    strictly-prior games and the artifact chosen by fit() was trained and
    validated on seasons <= max(train.season).
    """

    name = "transformer"

    def __init__(self, artifact_root: Path, features: pd.DataFrame, device: str = "cpu"):
        self.artifact_root = Path(artifact_root)
        self.features = features
        self.device = device
        self._model = None

    def fit(self, train: pd.DataFrame) -> None:
        through = int(train["season"].max())
        art = self.artifact_root / f"through{through}"
        if not art.exists():
            raise FileNotFoundError(
                f"no artifact at {art} — train one with "
                f"`python -m ffmodel.model.train` (val_season {through})"
            )
        metrics = json.loads((art / "metrics.json").read_text())
        self._seq_len = metrics["seq_len"]
        self._quantiles = metrics["quantiles"]
        self._scaler = Scaler.load(art / "scaler.json")
        self._model = QuantileTransformer(
            n_seq_features=metrics["n_seq_features"],
            n_ctx_features=metrics["n_ctx_features"],
            max_seq_len=self._seq_len, n_stats=len(PREDICTED_STATS),
            n_quantiles=len(self._quantiles), **metrics["model"],
        ).to(self.device)
        self._model.load_state_dict(
            torch.load(art / "model.pt", map_location=self.device, weights_only=True)
        )
        self._model.eval()
        self._pos_fallback = {
            q: train.groupby("position")[PREDICTED_STATS].quantile(q)
            for q in self._quantiles
        }

    def predict(self, test: pd.DataFrame) -> pd.DataFrame:
        return self.predict_quantiles(test)["p50"]

    def predict_quantiles(self, test: pd.DataFrame) -> dict[str, pd.DataFrame]:
        data = apply_scaler(
            build_sequences(self.features, self._seq_len, min_history=0), self._scaler
        )
        pos = pd.Index(data.meta["row_id"]).get_indexer(test.index)
        if (pos < 0).any():
            raise ValueError("test rows missing from the predictor's feature frame")
        with torch.no_grad():
            out = self._model(
                torch.from_numpy(data.x_seq[pos]).to(self.device),
                torch.from_numpy(data.x_ctx[pos]).to(self.device),
                torch.from_numpy(data.pad_mask[pos]).to(self.device),
            )
            out = monotone(out).cpu().numpy()  # [n, stats, 3]
        result = {}
        rookie = test["games_prior"].to_numpy() == 0
        for qi, (key, q) in enumerate(zip(QUANTILE_KEYS, self._quantiles)):
            frame = pd.DataFrame(out[:, :, qi], columns=PREDICTED_STATS,
                                 index=test.index)
            if rookie.any():
                fallback = test.loc[rookie, "position"].map(
                    lambda p: self._pos_fallback[q].loc[p]
                )
                frame.loc[rookie] = pd.DataFrame(
                    list(fallback), index=test.index[rookie],
                    columns=PREDICTED_STATS,
                ).astype(np.float32)
            result[key] = frame
        return result
