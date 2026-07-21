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
from ffmodel.scoring import BAND_CONSTRUCTION, PREDICTED_STATS

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
        # Feature lists are resolved from the ARTIFACT, not module globals:
        # pre-v2 artifacts lack the keys and get the frozen v1 constants,
        # so their predictions are byte-identical to before this existed.
        self._seq_features = metrics.get("seq_features", SEQ_FEATURES)
        self._ctx_features = metrics.get("ctx_features", CTX_FEATURES)
        if (len(self._seq_features) != metrics["n_seq_features"]
                or len(self._ctx_features) != metrics["n_ctx_features"]):
            raise ValueError(
                f"{art}: feature lists in metrics.json disagree with the "
                f"recorded n_seq_features/n_ctx_features — artifact is "
                f"inconsistent"
            )
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
            build_sequences(self.features, self._seq_len, min_history=0,
                            seq_features=self._seq_features,
                            ctx_features=self._ctx_features),
            self._scaler,
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

    `calibration` (default True): after fitting, look for
    `<artifact_roots[0]>/through{through}/calibration.json` (written by
    `ffmodel.model.calibrate.write_calibration`) and, if present, validate
    and apply its per-position (s_lo, s_hi) point-band scale factors in
    `predict_quantiles` (see `_apply_calibration`). No file -> behavior is
    byte-identical to calibration not existing at all. Pass
    `calibration=False` to skip looking for/applying it even when the file
    is on disk (e.g. the calibration-fitting CLI itself needs the raw,
    uncalibrated band to fit against).
    """

    name = "transformer"

    def __init__(self, artifact_root, features: pd.DataFrame, device: str = "cpu", *,
                 calibration: bool = True):
        roots = [artifact_root] if isinstance(artifact_root, (str, Path)) else list(artifact_root)
        if not roots:
            raise ValueError("artifact_root must be a path or a non-empty iterable of paths")
        self.artifact_roots = [Path(r) for r in roots]
        self.artifact_root = self.artifact_roots[0]  # back-compat single-root attribute
        self.features = features
        self.device = device
        self.calibration = calibration
        self._calibration = None  # loaded/validated per-position factors, or None
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
        self._calibration = None
        if self.calibration:
            through = int(train["season"].max())
            path = self.artifact_roots[0] / f"through{through}" / "calibration.json"
            if path.exists():
                self._calibration = self._load_calibration(path, through)

    def _load_calibration(self, path: Path, through: int) -> dict:
        data = json.loads(path.read_text())
        if data.get("band_construction") != BAND_CONSTRUCTION:
            raise ValueError(
                f"{path}: band_construction mismatch -- this artifact scores "
                f"under {BAND_CONSTRUCTION!r}, but calibration.json was fit "
                f"under {data.get('band_construction')!r}"
            )
        # Compare resolved (absolute) paths, not literal spellings: the
        # identity we care about is "same artifact on disk", not "same
        # string". write_calibration persists repo-relative roots on
        # purpose (portable across machines/checkouts), while a predictor
        # may legitimately be constructed with absolute paths to those same
        # artifacts. A relative string in calibration.json only ever means
        # repo-root-relative (every CLI here runs from the repo root), so
        # resolving it against cwd is the correct interpretation.
        expected_roots = sorted(Path(r).resolve().as_posix() for r in self.artifact_roots)
        got_roots = sorted(Path(r).resolve().as_posix() for r in data.get("member_roots", []))
        if got_roots != expected_roots:
            raise ValueError(
                f"{path}: member_roots mismatch -- predictor was constructed "
                f"with {expected_roots}, but calibration.json lists {got_roots}"
            )
        if data.get("fit_season") != through:
            raise ValueError(
                f"{path}: fit_season mismatch -- this fold validates season "
                f"{through}, but calibration.json was fit for season "
                f"{data.get('fit_season')}"
            )
        return data

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
        result = {
            key: pd.DataFrame(sorted_stacked[:, :, qi],
                              columns=avg[key].columns, index=avg[key].index)
            for qi, key in enumerate(QUANTILE_KEYS)
        }
        if self._calibration is not None:
            result = self._apply_calibration(result, test)
        return result

    def _apply_calibration(self, quantiles: dict[str, pd.DataFrame],
                            test: pd.DataFrame) -> dict[str, pd.DataFrame]:
        """Shrink/expand p10 and p90 per row by that row's position's
        (s_lo, s_hi) factors -- vectorized across all rows/stats at once, no
        Python row loop. p50 is untouched; monotonicity holds for s >= 0 by
        construction (each side moves toward, never past, p50), so no
        re-sort is needed after this."""
        per_position = self._calibration["per_position"]
        positions = test["position"]
        unknown = sorted(set(positions.unique()) - set(per_position))
        if unknown:
            raise ValueError(
                f"predict_quantiles: no calibration factors for position(s) "
                f"{unknown} (calibration covers {sorted(per_position)})"
            )
        s_lo = positions.map(lambda p: per_position[p]["s_lo"])
        s_hi = positions.map(lambda p: per_position[p]["s_hi"])
        p10, p50, p90 = quantiles["p10"], quantiles["p50"], quantiles["p90"]
        p10c = p50 - (p50 - p10).mul(s_lo, axis=0)
        p90c = p50 + (p90 - p50).mul(s_hi, axis=0)
        return {"p10": p10c, "p50": p50, "p90": p90c}
