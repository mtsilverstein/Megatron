"""Season-long draft values: weekly roll -> sums -> VORP -> tiers."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ffmodel.data.future import combined_future_features
from ffmodel.scoring import PPR, fantasy_points

# 12-team league: points above the player at this positional rank define
# value over replacement (roughly the first waiver-tier player).
REPLACEMENT_RANK = {"QB": 13, "RB": 25, "WR": 25, "TE": 13}


def season_projection(weekly: pd.DataFrame, schedules: pd.DataFrame, predictor,
                      season: int, weeks=range(1, 19)) -> pd.DataFrame:
    """All weeks seeded from the same pre-season history (spec §7)."""
    predictor.fit(_fit_frame(weekly, schedules))
    totals: dict[str, dict] = {}
    for week in weeks:
        combined, future = combined_future_features(weekly, schedules, season, week)
        if future.empty:
            continue
        if hasattr(predictor, "attach_features"):
            predictor.attach_features(combined)   # future rows live in this frame
        if hasattr(predictor, "predict_quantiles"):
            qs = predictor.predict_quantiles(future)
            week_pts = {q: fantasy_points(qs[q], PPR) for q in ("p10", "p50", "p90")}
        else:
            week_pts = {"p50": fantasy_points(predictor.predict(future), PPR),
                        "p10": None, "p90": None}
        for idx, row in future.iterrows():
            entry = totals.setdefault(row["player_id"], {
                "player_id": row["player_id"], "name": row["player_display_name"],
                "team": row["team"], "position": row["position"],
                "season_p50": 0.0, "season_p10": 0.0, "season_p90": 0.0, "games": 0,
            })
            entry["season_p50"] += float(week_pts["p50"].loc[idx])
            entry["games"] += 1
            for q in ("p10", "p90"):
                if week_pts[q] is None:
                    entry[f"season_{q}"] = np.nan
                else:
                    entry[f"season_{q}"] += float(week_pts[q].loc[idx])
    return pd.DataFrame(list(totals.values()))


def _fit_frame(weekly: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    from ffmodel.data.features import build_features

    return build_features(weekly, schedules)


def _assign_tiers(vorp_desc: pd.Series) -> list[int]:
    values = vorp_desc.to_numpy(dtype=float)
    if len(values) == 0:
        return []
    span = float(values.max() - values.min())
    threshold = max(2.0, 0.15 * span)
    tiers, tier = [1], 1
    for prev, cur in zip(values, values[1:]):
        if prev - cur > threshold:
            tier += 1
        tiers.append(tier)
    return tiers


def _finalize_board(players: pd.DataFrame, model: str, season: int,
                    data_through: str, has_bands: bool) -> dict:
    frames = []
    for pos, group in players.groupby("position"):
        group = group.sort_values("season_p50", ascending=False).reset_index(drop=True)
        rank = REPLACEMENT_RANK.get(pos, 20)
        replacement = group["season_p50"].iloc[min(rank, len(group)) - 1]
        group["vorp"] = (group["season_p50"] - replacement).round(2)
        group["position_rank"] = group.index + 1
        group["tier"] = _assign_tiers(group["vorp"])
        frames.append(group)
    board = pd.concat(frames).sort_values("vorp", ascending=False)

    def _band(value) -> float | None:
        return None if pd.isna(value) else round(float(value), 1)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_through": data_through, "season": season, "model": model,
        "has_bands": has_bands,
        "methodology": {
            "seeding": "end-of-prior-season form",
            "bands": "sum of weekly quantiles (approximation)",
            "replacement_rank": REPLACEMENT_RANK,
        },
        "players": [{
            "player_id": row["player_id"], "name": row["name"], "team": row["team"],
            "position": row["position"],
            "season_points": {"ppr": {"p50": round(float(row["season_p50"]), 1),
                                      "p10": _band(row["season_p10"]),
                                      "p90": _band(row["season_p90"])}},
            "vorp": float(row["vorp"]),
            "position_rank": int(row["position_rank"]),
            "tier": int(row["tier"]),
        } for _, row in board.iterrows()],
    }


def build_draft_board(weekly: pd.DataFrame, schedules: pd.DataFrame, predictor,
                      season: int, data_through: str, weeks=range(1, 19)) -> dict:
    players = season_projection(weekly, schedules, predictor, season, weeks)
    has_bands = hasattr(predictor, "predict_quantiles")
    return _finalize_board(players, predictor.name, season, data_through, has_bands)
