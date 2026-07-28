"""Tabular incumbent: one gradient-boosted regressor per stat component."""
from __future__ import annotations

import pandas as pd
from xgboost import XGBRegressor

from ffmodel.data.features import (
    BASELINE_FEATURE_SETS,
    DEFAULT_BASELINE_FEATURE_SET,
    feature_columns,
)
from ffmodel.scoring import PREDICTED_STATS


class XGBBaseline:
    """The baseline every other entrant is measured against.

    `feature_set` is explicit and defaults to the frozen "v1" set, so the
    baseline cannot drift when `build_features` grows a column -- see
    `ffmodel.data.features.feature_columns` and
    `models/diagnostics/xgb_feature_set_audit.json`.
    """

    name = "xgboost"

    def __init__(self, n_estimators: int = 300, seed: int = 0,
                 feature_set: str = DEFAULT_BASELINE_FEATURE_SET):
        if feature_set not in BASELINE_FEATURE_SETS:
            raise ValueError(f"unknown feature_set {feature_set!r} "
                             f"(known: {sorted(BASELINE_FEATURE_SETS)})")
        self.n_estimators = n_estimators
        self.seed = seed
        self.feature_set = feature_set
        # The default set keeps the entrant name that every committed report
        # already uses; a non-default set renames itself so a backtest row can
        # never be mistaken for the reported baseline (and so both variants
        # can run side by side in one harness call).
        if feature_set != DEFAULT_BASELINE_FEATURE_SET:
            self.name = f"xgboost_{feature_set}"
        self._models: dict[str, XGBRegressor] = {}

    def _matrix(self, df: pd.DataFrame) -> pd.DataFrame:
        return df[feature_columns(df, self.feature_set)].astype(float)

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
