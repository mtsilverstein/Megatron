"""Backtest harness: every entrant (baseline or transformer) runs through here."""
from __future__ import annotations

from typing import Protocol

import pandas as pd

from ffmodel.eval.metrics import score_table
from ffmodel.eval.splits import walk_forward_splits
from ffmodel.scoring import PPR, PREDICTED_STATS, ScoringRules, fantasy_points


class Predictor(Protocol):
    name: str

    def fit(self, train: pd.DataFrame) -> None: ...
    def predict(self, test: pd.DataFrame) -> pd.DataFrame: ...


def run_backtest(
    features: pd.DataFrame,
    predictors: list[Predictor],
    test_seasons: list[int],
    rules: ScoringRules = PPR,
) -> pd.DataFrame:
    tables = []
    for season, train_idx, test_idx in walk_forward_splits(features, test_seasons):
        train, test = features.loc[train_idx], features.loc[test_idx]
        actual = fantasy_points(test[PREDICTED_STATS], rules)
        for predictor in predictors:
            predictor.fit(train)
            pred_points = fantasy_points(predictor.predict(test), rules)
            scored = pd.DataFrame({
                "position": test["position"].to_numpy(),
                "actual": actual.to_numpy(),
                "pred": pred_points.to_numpy(),
            })
            tables.append(
                score_table(scored).assign(model=predictor.name, test_season=season)
            )
    return pd.concat(tables, ignore_index=True)
