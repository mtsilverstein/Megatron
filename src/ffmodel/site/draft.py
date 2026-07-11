"""Season-long draft values: weekly roll -> sums -> VORP -> tiers."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ffmodel.data.future import combined_future_features
from ffmodel.scoring import fantasy_points
from ffmodel.site.weekly import RULESETS

# 12-team league: points above the player at this positional rank define
# value over replacement (roughly the first waiver-tier player).
REPLACEMENT_RANK = {"QB": 13, "RB": 25, "WR": 25, "TE": 13}


def season_projection(weekly: pd.DataFrame, schedules: pd.DataFrame, predictor,
                      season: int, weeks=range(1, 19), prefit: bool = False) -> pd.DataFrame:
    """All weeks seeded from the same pre-season history (spec §7)."""
    if not prefit:
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
            week_pts = {rn: {q: fantasy_points(qs[q], rules) for q in ("p10", "p50", "p90")}
                        for rn, rules in RULESETS.items()}
        else:
            pred = predictor.predict(future)
            week_pts = {rn: {"p50": fantasy_points(pred, rules), "p10": None, "p90": None}
                        for rn, rules in RULESETS.items()}
        for idx, row in future.iterrows():
            entry = totals.setdefault(row["player_id"], {
                "player_id": row["player_id"], "name": row["player_display_name"],
                "team": row["team"], "position": row["position"],
                **{f"{rn}_{q}": 0.0 for rn in RULESETS for q in ("p10", "p50", "p90")},
                "games": 0,
            })
            entry["games"] += 1
            for rn in RULESETS:
                entry[f"{rn}_p50"] += float(week_pts[rn]["p50"].loc[idx])
                for q in ("p10", "p90"):
                    if week_pts[rn][q] is None:
                        entry[f"{rn}_{q}"] = np.nan
                    else:
                        entry[f"{rn}_{q}"] += float(week_pts[rn][q].loc[idx])
    columns = ["player_id", "name", "team", "position",
               *[f"{rn}_{q}" for rn in RULESETS for q in ("p10", "p50", "p90")],
               "games"]
    return pd.DataFrame(list(totals.values()), columns=columns)


def _fit_frame(weekly: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    from ffmodel.data.features import build_features

    return build_features(weekly, schedules)


def _assign_tiers(vorp_desc: pd.Series, replacement_rank: int) -> list[int]:
    values = vorp_desc.to_numpy(dtype=float)
    if len(values) == 0:
        return []
    n_draft = min(2 * replacement_rank, len(values))
    if n_draft < 2:
        return [1] * len(values)
    mean_gap = (values[0] - values[n_draft - 1]) / (n_draft - 1)
    threshold = max(2.0, 2.0 * mean_gap)
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
        group = group.sort_values("ppr_p50", ascending=False).reset_index(drop=True)
        rank = REPLACEMENT_RANK.get(pos, 20)
        replacement = group["ppr_p50"].iloc[min(rank, len(group)) - 1]
        group["vorp"] = (group["ppr_p50"] - replacement).round(2)
        group["position_rank"] = group.index + 1
        group["tier"] = _assign_tiers(group["vorp"], rank)
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
            "season_points": {rn: {"p50": round(float(row[f"{rn}_p50"]), 1),
                                   "p10": _band(row[f"{rn}_p10"]),
                                   "p90": _band(row[f"{rn}_p90"])}
                              for rn in ("ppr", "half_ppr", "standard")},
            "games": int(row["games"]),
            "bye": None if pd.isna(row["bye"]) else int(row["bye"]),
            "vorp": float(row["vorp"]),
            "position_rank": int(row["position_rank"]),
            "tier": int(row["tier"]),
        } for _, row in board.iterrows()],
    }


def build_draft_board(weekly: pd.DataFrame, schedules: pd.DataFrame, predictor,
                      season: int, data_through: str, weeks=range(1, 19),
                      prefit: bool = False) -> dict:
    players = season_projection(weekly, schedules, predictor, season, weeks, prefit=prefit)
    if players.empty:
        raise RuntimeError(
            f"no future games found for season {season} weeks {list(weeks)} — "
            f"refusing to build an empty draft board"
        )
    season_sched = schedules[schedules["season"] == season]
    weeks_list = list(weeks)
    team_weeks = pd.concat([
        season_sched.rename(columns={"home_team": "team"})[["team", "week"]],
        season_sched.rename(columns={"away_team": "team"})[["team", "week"]],
    ])

    def _bye(team: str):
        played = set(team_weeks[team_weeks["team"] == team]["week"])
        missing = [w for w in weeks_list if w not in played]
        return int(missing[0]) if len(missing) == 1 else None

    players["bye"] = players["team"].map(_bye)
    has_bands = hasattr(predictor, "predict_quantiles")
    return _finalize_board(players, predictor.name, season, data_through, has_bands)
