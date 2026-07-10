"""Feature rows for weeks that have not been played yet.

A future row is a canonical weekly row with every stat NaN. Reusing
build_features on (history + skeleton) inherits leak-freedom: lag features
shift past the current row, so NaN stats contribute nothing anywhere.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ffmodel.data.features import build_features
from ffmodel.data.pull import CONTEXT_COLUMNS
from ffmodel.scoring import PREDICTED_STATS, SCORING_EXTRAS

_NAN_COLUMNS = PREDICTED_STATS + SCORING_EXTRAS + [
    "target_share", "snap_pct", "fantasy_points_ppr",
]


def future_skeleton(weekly: pd.DataFrame, schedules: pd.DataFrame,
                    season: int, week: int) -> pd.DataFrame:
    ordered = weekly.sort_values(["player_id", "season", "week"])
    latest = ordered.groupby("player_id").tail(1)
    active = latest[latest["season"] >= season - 1]

    games = schedules[(schedules["season"] == season) & (schedules["week"] == week)]
    home = games.rename(columns={"home_team": "team", "away_team": "opponent_team"})
    away = games.rename(columns={"away_team": "team", "home_team": "opponent_team"})
    matchups = pd.concat([home, away])[["team", "opponent_team"]]

    rows = active[["player_id", "player_display_name", "position", "team"]].merge(
        matchups, on="team", how="inner"          # bye teams drop out here
    )
    rows["season"] = season
    rows["week"] = week
    for col in _NAN_COLUMNS:
        rows[col] = np.nan
    return rows[CONTEXT_COLUMNS + _NAN_COLUMNS].reset_index(drop=True)


def combined_future_features(weekly: pd.DataFrame, schedules: pd.DataFrame,
                             season: int, week: int
                             ) -> tuple[pd.DataFrame, pd.DataFrame]:
    skeleton = future_skeleton(weekly, schedules, season, week)
    combined = pd.concat([weekly, skeleton], ignore_index=True)
    features = build_features(combined, schedules)
    mask = (features["season"] == season) & (features["week"] == week) \
        & features[PREDICTED_STATS[0]].isna()
    return features, features[mask]


def build_future_features(weekly: pd.DataFrame, schedules: pd.DataFrame,
                          season: int, week: int) -> pd.DataFrame:
    return combined_future_features(weekly, schedules, season, week)[1]
