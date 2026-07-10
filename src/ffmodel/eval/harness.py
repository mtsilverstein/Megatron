"""Backtest harness: every entrant (baseline or transformer) runs through here."""
from __future__ import annotations

from typing import Protocol

import pandas as pd

from ffmodel.eval.metrics import score_table
from ffmodel.eval.splits import walk_forward_splits
from ffmodel.scoring import PPR, PREDICTED_STATS, ScoringRules, fantasy_points


class Predictor(Protocol):
    """One entrant in the backtest.

    Plan 2 extension point: quantile models may additionally implement
    predict_quantiles(test) -> dict[str, pd.DataFrame] with keys
    "p10"/"p50"/"p90"; run_backtest scores p50 through the existing path and
    will grow pinball/coverage reporting without breaking point-only
    predictors.
    """
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
        # Actuals exclude SCORING_EXTRAS (2pt conversions, ST TDs): models are
        # compared on the predictable stat components only.
        actual = fantasy_points(test[PREDICTED_STATS], rules)
        for predictor in predictors:
            predictor.fit(train)
            pred_stats = predictor.predict(test)
            if not pred_stats.index.equals(test.index):
                raise ValueError(
                    f"{predictor.name}: prediction index misaligned with test frame"
                )
            scored = pd.DataFrame({
                "position": test["position"].to_numpy(),
                "actual": actual.to_numpy(),
                "pred": fantasy_points(pred_stats, rules).to_numpy(),
            })
            if hasattr(predictor, "predict_quantiles"):
                quantile_stats = predictor.predict_quantiles(test)
                for key in ("p10", "p90"):
                    frame = quantile_stats[key]
                    if not frame.index.equals(test.index):
                        raise ValueError(
                            f"{predictor.name}: {key} index misaligned with test frame"
                        )
                    scored[key] = fantasy_points(frame, rules).to_numpy()
            tables.append(
                score_table(scored).assign(model=predictor.name, test_season=season)
            )
    return pd.concat(tables, ignore_index=True)
