"""Tabular incumbent: one gradient-boosted regressor per stat component."""
from __future__ import annotations

from collections.abc import Sequence

import pandas as pd
from xgboost import XGBRegressor

from ffmodel.data.features import (
    BASELINE_FEATURE_SETS,
    DEFAULT_BASELINE_FEATURE_SET,
    feature_columns,
)
from ffmodel.scoring import PREDICTED_STATS

# Training objective, by name -> the XGBRegressor arguments it sets.
#
# "squared_error" is XGBRegressor's own default (reg:squarederror): it predicts
# the conditional MEAN of each stat, and it is what every committed report's
# `xgboost` rows were trained with, so it stays the default.
#
# "median" is pinball loss at q = 0.5 -- the objective the transformer's p50
# head is trained on. The bake-off scores MAE, which a median predictor
# minimises, so only this variant is a like-for-like point comparison with the
# transformer; against the mean predictor the transformer's MAE edge is mostly
# the objective, not the model (audit A2-1, 2026-11-07).
OBJECTIVES: dict[str, dict] = {
    "squared_error": {"objective": "reg:squarederror"},
    "median": {"objective": "reg:quantileerror", "quantile_alpha": 0.5},
}
DEFAULT_OBJECTIVE = "squared_error"


class XGBBaseline:
    """The baseline every other entrant is measured against.

    `feature_set` is explicit and defaults to the frozen "v1" set, so the
    baseline cannot drift when `build_features` grows a column -- see
    `ffmodel.data.features.feature_columns` and
    `models/diagnostics/xgb_feature_set_audit.json`.

    `objective` names an entry of `OBJECTIVES`; every other hyperparameter,
    the feature set and the seed handling are the same for each objective.
    """

    name = "xgboost"

    def __init__(self, n_estimators: int = 300, seed: int = 0,
                 feature_set: str = DEFAULT_BASELINE_FEATURE_SET,
                 objective: str = DEFAULT_OBJECTIVE):
        if feature_set not in BASELINE_FEATURE_SETS:
            raise ValueError(f"unknown feature_set {feature_set!r} "
                             f"(known: {sorted(BASELINE_FEATURE_SETS)})")
        if objective not in OBJECTIVES:
            raise ValueError(f"unknown objective {objective!r} "
                             f"(known: {sorted(OBJECTIVES)})")
        self.n_estimators = n_estimators
        self.seed = seed
        self.feature_set = feature_set
        self.objective = objective
        # The default set and objective keep the entrant name that every
        # committed report already uses; anything else renames itself so a
        # backtest row can never be mistaken for the reported baseline (and so
        # the variants can run side by side in one harness call).
        if feature_set != DEFAULT_BASELINE_FEATURE_SET:
            self.name = f"xgboost_{feature_set}"
        if objective != DEFAULT_OBJECTIVE:
            self.name = f"{self.name}_{objective}"
        self._models: dict[str, XGBRegressor] = {}

    def _matrix(self, df: pd.DataFrame) -> pd.DataFrame:
        return df[feature_columns(df, self.feature_set)].astype(float)

    def _regressor(self) -> XGBRegressor:
        """One unfitted per-stat regressor, exactly as `fit` trains it."""
        return XGBRegressor(
            n_estimators=self.n_estimators, max_depth=5, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8, tree_method="hist",
            random_state=self.seed, n_jobs=-1, **OBJECTIVES[self.objective],
        )

    def fit(self, train: pd.DataFrame) -> None:
        X = self._matrix(train)
        for stat in PREDICTED_STATS:
            model = self._regressor()
            model.fit(X, train[stat])
            self._models[stat] = model

    def predict(self, test: pd.DataFrame) -> pd.DataFrame:
        X = self._matrix(test)
        return pd.DataFrame(
            {stat: model.predict(X) for stat, model in self._models.items()},
            index=test.index,
        )[PREDICTED_STATS]


class XGBSeedAverage:
    """One XGBoost entrant fitted once per seed, its stat lines averaged.

    The transformer entrant is a 3-seed ensemble, and XGBoost's subsampling
    makes its seed part of the result (`xgb_seed` in `ffmodel.eval.run`), so a
    like-for-like comparison averages XGBoost over seeds too. Each member is an
    `XGBBaseline` built with the same arguments except `seed`; a single seed is
    exactly that one `XGBBaseline`. The entrant keeps the members' name, so the
    seeds belong in the report's provenance, as the transformer's roots do.
    """

    def __init__(self, seeds: Sequence[int], **kwargs):
        seeds = [int(s) for s in seeds]
        if not seeds:
            raise ValueError("XGBSeedAverage needs at least one seed")
        if len(set(seeds)) != len(seeds):
            raise ValueError(f"XGBSeedAverage: duplicate seeds {seeds}")
        if "seed" in kwargs:
            raise ValueError("XGBSeedAverage takes `seeds`, not `seed`")
        self.seeds = seeds
        self.members = [XGBBaseline(seed=s, **kwargs) for s in seeds]
        first = self.members[0]
        self.name = first.name
        self.feature_set = first.feature_set
        self.objective = first.objective

    def fit(self, train: pd.DataFrame) -> None:
        for member in self.members:
            member.fit(train)

    def predict(self, test: pd.DataFrame) -> pd.DataFrame:
        total = self.members[0].predict(test)
        for member in self.members[1:]:
            total = total + member.predict(test)
        return total / len(self.members)
