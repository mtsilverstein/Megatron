"""Leak-free feature building.

Every feature attached to a (player, week) row is computed from games
strictly before that week. Same-week stat columns remain in the frame as
labels only; `feature_columns` is the single source of truth for what a
model may consume.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

LAG_STATS = PREDICTED_STATS + ["target_share", "carry_share", "ppr_points"]
LAG_WINDOWS = (4, 8)
CONTEXT_FEATURES = ["games_prior", "is_home", "rest_days", "week"]


def build_features(weekly: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    df = weekly.sort_values(["player_id", "season", "week"]).reset_index(drop=True).copy()
    df["ppr_points"] = fantasy_points(df, PPR)
    df = _add_carry_share(df)
    df = _add_player_lags(df)
    df = _add_schedule_context(df, schedules)
    df = _add_position_dummies(df)
    return df


def feature_columns(df: pd.DataFrame) -> list[str]:
    lag_cols = [c for c in df.columns if c.startswith(("lag4_", "lag8_"))]
    pos_cols = [c for c in df.columns if c.startswith("pos_")]
    extra = [c for c in ("opp_allowed_last4", "opp_allowed_season") if c in df.columns]
    return lag_cols + CONTEXT_FEATURES + extra + pos_cols


def _add_carry_share(df: pd.DataFrame) -> pd.DataFrame:
    team_carries = df.groupby(["team", "season", "week"])["carries"].transform("sum")
    df["carry_share"] = df["carries"] / team_carries.replace(0, np.nan)
    return df


def _add_player_lags(df: pd.DataFrame) -> pd.DataFrame:
    # df is sorted by (player_id, season, week); "last N games played"
    # deliberately spans season boundaries (spec §4).
    grouped = df.groupby("player_id", sort=False)
    for stat in LAG_STATS:
        shifted = grouped[stat].shift(1)  # exclude the current game
        for window in LAG_WINDOWS:
            df[f"lag{window}_{stat}"] = (
                shifted.groupby(df["player_id"])
                .rolling(window, min_periods=1)
                .mean()
                .reset_index(level=0, drop=True)
            )
    df["games_prior"] = grouped.cumcount()
    return df


def _add_schedule_context(df: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    sched = schedules.copy()
    sched["gameday"] = pd.to_datetime(sched["gameday"])
    sides = []
    for side, flag in (("home_team", 1), ("away_team", 0)):
        part = sched.rename(columns={side: "team"})[["season", "week", "team", "gameday"]]
        sides.append(part.assign(is_home=flag))
    team_games = pd.concat(sides, ignore_index=True).sort_values(["team", "gameday"])
    team_games["rest_days"] = (
        team_games.groupby("team")["gameday"].diff().dt.days
        .clip(4, 14)          # season gaps collapse to "long rest"
        .fillna(7)
        .astype(int)
    )
    merged = df.merge(
        team_games[["season", "week", "team", "is_home", "rest_days"]],
        on=["season", "week", "team"], how="left",
    )
    merged["rest_days"] = merged["rest_days"].fillna(7).astype(int)
    merged["is_home"] = merged["is_home"].fillna(0).astype(int)
    return merged


def _add_position_dummies(df: pd.DataFrame) -> pd.DataFrame:
    for pos in ("QB", "RB", "WR", "TE"):
        df[f"pos_{pos}"] = (df["position"] == pos).astype(int)
    return df
