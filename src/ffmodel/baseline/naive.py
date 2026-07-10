"""Floor baseline: a player's last-4-games average, position mean as fallback."""
from __future__ import annotations

import pandas as pd

from ffmodel.scoring import PREDICTED_STATS


class NaiveLast4:
    name = "naive_last4"

    def fit(self, train: pd.DataFrame) -> None:
        self._pos_means = train.groupby("position")[PREDICTED_STATS].mean()

    def predict(self, test: pd.DataFrame) -> pd.DataFrame:
        pred = test[[f"lag4_{s}" for s in PREDICTED_STATS]].copy()
        pred.columns = PREDICTED_STATS
        for stat in PREDICTED_STATS:
            fallback = test["position"].map(self._pos_means[stat])
            pred[stat] = pred[stat].fillna(fallback)
        return pred
