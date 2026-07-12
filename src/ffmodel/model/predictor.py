"""Bridges trained artifacts into the Plan 1 backtest harness."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from ffmodel.model.dataset import Scaler, apply_scaler, build_sequences
from ffmodel.model.net import QuantileTransformer, monotone
from ffmodel.scoring import PREDICTED_STATS

QUANTILE_KEYS = ("p10", "p50", "p90")


class _SingleRootTransformer:
    """One artifact root's fit/predict pipeline. This is the pre-ensemble
    TransformerPredictor body, factored out so TransformerPredictor can run
    N of these (one per seed root) and average their outputs -- see
    TransformerPredictor's docstring for the ensembling contract.

    Constructed with the FULL feature frame: each test row's input sequence
    reaches back into earlier seasons, which the harness's test slice does
    not contain. Leak-freedom is preserved because sequences only ever use
    strictly-prior games and the artifact chosen by fit() was trained and
    validated on seasons <= max(train.season).
    """

    def __init__(self, artifact_root: Path, features: pd.DataFrame, device: str = "cpu"):
        self.artifact_root = Path(artifact_root)
        self.features = features
        self.device = device
        self._model = None

    def attach_features(self, features: pd.DataFrame) -> None:
        """Repoint the stored feature frame (e.g. one extended with
        future-week rows). Sequences are always built from this frame, so
        test rows must exist in it by index."""
        self.features = features

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
        if len(self._quantiles) != 3 or list(self._quantiles) != sorted(self._quantiles):
            raise ValueError(f"artifact quantiles must be 3 ascending values, got {self._quantiles}")
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


class TransformerPredictor:
    """Predictor + predict_quantiles over walk-forward artifacts, with
    optional seed-ensemble averaging across multiple artifact roots.

    `artifact_root` accepts either a single path (str/Path — the original,
    single-model call style) or an iterable of paths (e.g. a list of
    `v1_s43`/`v1_s44` seed-run roots produced by `train.py --seed`). Each
    root gets its own `_SingleRootTransformer` running the full fit/predict
    pipeline (including its own rookie position-quantile fallback, which is
    computed purely from the `train` frame and so is identical across
    members regardless of model weights); `predict_quantiles` averages the
    per-root p10/p50/p90 frames element-wise and then re-applies the
    monotone (p10<=p50<=p90) sort as a final guard. With exactly one root
    this reduces to averaging-of-one (an exact no-op: dividing/adding by
    the identity element introduces no floating-point error) followed by
    re-sorting an already-sorted triple (also a no-op), so single-root
    callers get results byte-identical to the pre-ensemble implementation.
    """

    name = "transformer"

    def __init__(self, artifact_root, features: pd.DataFrame, device: str = "cpu"):
        roots = [artifact_root] if isinstance(artifact_root, (str, Path)) else list(artifact_root)
        if not roots:
            raise ValueError("artifact_root must be a path or a non-empty iterable of paths")
        self.artifact_roots = [Path(r) for r in roots]
        self.artifact_root = self.artifact_roots[0]  # back-compat single-root attribute
        self.features = features
        self.device = device
        self._members = [_SingleRootTransformer(r, features, device) for r in self.artifact_roots]

    def attach_features(self, features: pd.DataFrame) -> None:
        """Repoint the stored feature frame on this predictor and every
        ensemble member (see _SingleRootTransformer.attach_features)."""
        self.features = features
        for member in self._members:
            member.attach_features(features)

    def fit(self, train: pd.DataFrame) -> None:
        for member in self._members:
            member.fit(train)

    def predict(self, test: pd.DataFrame) -> pd.DataFrame:
        return self.predict_quantiles(test)["p50"]

    def predict_quantiles(self, test: pd.DataFrame) -> dict[str, pd.DataFrame]:
        per_member = [member.predict_quantiles(test) for member in self._members]
        n = len(per_member)
        avg = {key: sum(pm[key] for pm in per_member) / n for key in QUANTILE_KEYS}

        # Mean of N per-member sorted (p10<=p50<=p90) triples is always
        # itself sorted component-wise, so this re-sort can't actually fire
        # for any real input -- it's a belt-and-suspenders guard in case
        # the averaging logic above ever changes to something that isn't
        # order-preserving.
        stacked = np.stack([avg[key].to_numpy() for key in QUANTILE_KEYS], axis=-1)
        sorted_stacked = np.sort(stacked, axis=-1)
        return {
            key: pd.DataFrame(sorted_stacked[:, :, qi],
                              columns=avg[key].columns, index=avg[key].index)
            for qi, key in enumerate(QUANTILE_KEYS)
        }
