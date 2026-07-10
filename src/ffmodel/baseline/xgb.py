"""Tabular incumbent: one gradient-boosted regressor per stat component."""
from __future__ import annotations

import pandas as pd
from xgboost import XGBRegressor

from ffmodel.data.features import feature_columns
from ffmodel.scoring import PREDICTED_STATS


class XGBBaseline:
    name = "xgboost"

    def __init__(self, n_estimators: int = 300, seed: int = 0):
        self.n_estimators = n_estimators
        self.seed = seed
        self._models: dict[str, XGBRegressor] = {}

    def _matrix(self, df: pd.DataFrame) -> pd.DataFrame:
        return df[feature_columns(df)].astype(float)

    def fit(self, train: pd.DataFrame) -> None:
        X = self._matrix(train)
        for stat in PREDICTED_STATS:
            model = XGBRegressor(
                n_estimators=self.n_estimators, max_depth=5, learning_rate=0.05,
                subsample=0.8, colsample_bytree=0.8, tree_method="hist",
                random_state=self.seed, n_jobs=-1,
            )
            model.fit(X, train[stat])
            self._models[stat] = model

    def predict(self, test: pd.DataFrame) -> pd.DataFrame:
        X = self._matrix(test)
        return pd.DataFrame(
            {stat: model.predict(X) for stat, model in self._models.items()},
            index=test.index,
        )[PREDICTED_STATS]
