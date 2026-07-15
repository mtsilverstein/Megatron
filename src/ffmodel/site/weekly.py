"""Weekly projections payload for the static site."""
from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from ffmodel.scoring import (
    HALF_PPR,
    PPR,
    PREDICTED_STATS,
    STANDARD,
    fantasy_points_quantiles,
)

RULESETS = {"ppr": PPR, "half_ppr": HALF_PPR, "standard": STANDARD}


def _quantile_frames(future: pd.DataFrame, predictor) -> dict[str, pd.DataFrame | None]:
    if hasattr(predictor, "predict_quantiles"):
        qs = predictor.predict_quantiles(future)
        return {"p10": qs["p10"], "p50": qs["p50"], "p90": qs["p90"]}
    return {"p10": None, "p50": predictor.predict(future), "p90": None}


def build_weekly_projections(future: pd.DataFrame, predictor, season: int,
                             week: int, data_through: str) -> dict:
    if future.empty:
        raise RuntimeError(
            f"no future rows for season {season} week {week} — "
            f"refusing to publish an empty weekly page"
        )
    frames = _quantile_frames(future, predictor)
    # p10/p90 are sign-coherent floor/ceiling (fantasy_points_quantiles), so a
    # passer's ceiling isn't dragged down by his worst-case interceptions.
    points = {
        rules_name: fantasy_points_quantiles(frames, rules)
        for rules_name, rules in RULESETS.items()
    }
    p50_stats = frames["p50"]

    players = []
    for idx, row in future.iterrows():
        players.append({
            "player_id": row["player_id"],
            "name": row["player_display_name"],
            "team": row["team"],
            "opponent": row["opponent_team"],
            "position": row["position"],
            "is_home": bool(row["is_home"]),
            "points": {
                rules_name: {
                    q: (None if series is None else round(float(series.loc[idx]), 2))
                    for q, series in by_q.items()
                }
                for rules_name, by_q in points.items()
            },
            "stats_p50": {s: round(float(p50_stats.loc[idx, s]), 2)
                          for s in PREDICTED_STATS},
        })
    players.sort(key=lambda p: p["points"]["ppr"]["p50"], reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_through": data_through,
        "season": season, "week": week,
        "model": predictor.name,
        "has_bands": frames["p10"] is not None,
        "players": players,
    }
