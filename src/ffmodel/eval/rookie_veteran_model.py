"""Frozen-origin transformer adapter for conditional rookie decision probes."""
import numpy as np
import pandas as pd

from ffmodel.data.features import build_features
from ffmodel.data.future import combined_future_features
from ffmodel.scoring import PREDICTED_STATS
from ffmodel.site.weekly import RULESETS, set_league_rules, build_weekly_projections


def forecaster(history, schedules, season, rules, predictor_factory):
    features = build_features(history, schedules)
    predictor = predictor_factory(features)
    training = features[features.season < season]
    if training.empty or training.season.max() != season-1:
        raise ValueError("previous-season model training history required")
    predictor.fit(training)

    def forecast(veterans, week):
        teams = veterans.set_index("player_id").team.to_dict()
        combined, future = combined_future_features(history, schedules, season, week, teams)
        future = future[future.player_id.isin(teams)].copy()
        if (future.player_id.duplicated().any() or
                not future[PREDICTED_STATS].isna().all().all() or
                not ((future.season == season) & (future.week == week)).all()):
            raise ValueError("invalid veteran future rows")
        result = veterans.copy()
        # Byes/missing predictions stay unknown; never reuse the last-four
        # score as an unnoticed fallback in transformer mode.
        result["predicted"] = np.nan
        if future.empty:
            return result
        predictor.attach_features(combined)
        previous = RULESETS["league"]
        try:
            set_league_rules(rules)
            payload = build_weekly_projections(future, predictor, season, week,
                                               "frozen pre-origin history")
        finally:
            set_league_rules(previous)
        rows = pd.DataFrame(payload["players"])
        if rows.player_id.duplicated().any() or not set(rows.player_id) <= set(teams):
            raise ValueError("invalid veteran forecast identity")
        points = {}
        for row in rows.itertuples():
            expected = veterans[veterans.player_id == row.player_id].iloc[0]
            value = row.points["league"]["p50"]
            if row.team != expected.team or row.position != expected.position or not np.isfinite(value):
                raise ValueError("invalid veteran forecast contract")
            points[row.player_id] = value
        result["predicted"] = result.player_id.map(points)
        return result
    return forecast
