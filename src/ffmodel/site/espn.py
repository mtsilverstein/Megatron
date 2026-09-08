"""Narrow ESPN draft input repair; does not change Sleeper draft inputs."""
from __future__ import annotations

import pandas as pd

from ffmodel.data.pull import normalize_weekly
from ffmodel.scoring import PPR, fantasy_points

HUNTER_ID = "00-0040718"


def restore_hunter_history(weekly: pd.DataFrame, raw: pd.DataFrame) -> pd.DataFrame:
    """Restore observed 2025 offense that nflverse classifies as CB/DB.

    Hunter is a WR in the ESPN/ECR draft pool. Never add defensive-only players,
    postseason rows, synthetic games, or duplicate existing player-weeks.
    """
    source = raw.loc[(raw.player_id == HUNTER_ID) & (raw.season == 2025)
                     & (raw.season_type == "REG")].copy()
    if source.empty:
        raise RuntimeError("Travis Hunter offensive history unavailable")
    source["position_group"] = "WR"
    source["position"] = "WR"
    added = normalize_weekly(source)
    # The raw fantasy total can include his defense; model offense only.
    added["fantasy_points_ppr"] = fantasy_points(added, PPR)
    keys = ["player_id", "season", "week"]
    existing = pd.MultiIndex.from_frame(weekly[keys])
    added = added.loc[~pd.MultiIndex.from_frame(added[keys]).isin(existing)]
    # Append to preserve the ordering of all pre-existing player histories.
    return pd.concat([weekly, added], ignore_index=True)


def espn_weekly_history(weekly: pd.DataFrame, season: int) -> pd.DataFrame:
    if season != 2026 or weekly.player_id.eq(HUNTER_ID).any():
        return weekly
    import nflreadpy

    return restore_hunter_history(weekly, nflreadpy.load_player_stats([2025]).to_pandas())
