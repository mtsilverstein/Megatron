"""Rookie draft-capital cohort prior.

Walk-forward empirical prior for drafted rookies with no NFL history
(spec: docs/superpowers/specs/2026-07-19-rookie-projections-design.md).
Cohorts are position x capital bucket; each yields per-stat weekly
quantiles across the cohort's PLAYING weeks plus a games-played
distribution over 0..18 that keeps the zero-games outcome (the ~10% of
drafted skill players who never record a week) -- that zero inflation is
what makes rookie floors honest. v1 simplification (documented on the
site): games-played and per-week quality are independent within a cohort.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ffmodel.scoring import PREDICTED_STATS

_MIN_PLAYERS = 25
_MAX_GAMES = 18
BUCKET_ORDER = ["top12", "r1", "r2", "r3", "day3"]


def assign_bucket(round_: int, pick: int) -> str:
    if round_ == 1:
        return "top12" if pick <= 12 else "r1"
    if round_ == 2:
        return "r2"
    if round_ == 3:
        return "r3"
    return "day3"


def merge_buckets(counts: dict[str, int], min_n: int = _MIN_PLAYERS) -> dict[str, str]:
    """Deterministic thin-bucket merging, walking top12 -> day3.

    Buckets accumulate until the running count reaches min_n, then a group
    closes. A thin tail joins the last-formed group. min_n=10**9 collapses
    everything to one cohort per position -- the pre-registered STOP-rule
    fallback shape (position-only prior).
    """
    groups: list[list[str]] = []
    current: list[str] = []
    total = 0
    for bucket in BUCKET_ORDER:
        current.append(bucket)
        total += counts.get(bucket, 0)
        if total >= min_n:
            groups.append(current)
            current, total = [], 0
    if current:
        if groups:
            groups[-1].extend(current)
        else:
            groups.append(current)
    return {b: "+".join(g) for g in groups for b in g}


def fit_rookie_cohorts(weekly: pd.DataFrame, draft_picks: pd.DataFrame,
                       through_season: int, *, min_n: int = _MIN_PLAYERS) -> dict:
    dp = draft_picks[draft_picks["season"] <= through_season]
    if dp.empty:
        raise ValueError(f"no draft classes at or before {through_season} — "
                         "cannot fit rookie cohorts")
    rookie_weeks = weekly.merge(
        dp[["season", "gsis_id"]].rename(
            columns={"season": "draft_season", "gsis_id": "player_id"}),
        on="player_id")
    # rookie SEASON only: a sophomore-year week must not leak into the prior
    rookie_weeks = rookie_weeks[rookie_weeks["season"] == rookie_weeks["draft_season"]]

    positions: dict = {}
    for pos, group in dp.groupby("position"):
        buckets = group.apply(
            lambda r: assign_bucket(int(r["round"]), int(r["pick"])), axis=1)
        merge_map = merge_buckets(buckets.value_counts().to_dict(), min_n=min_n)
        cohorts: dict = {}
        for label in sorted(set(merge_map.values())):
            members = group[buckets.map(merge_map) == label]
            weeks = rookie_weeks[rookie_weeks["player_id"].isin(members["gsis_id"])]
            games = (weeks.groupby("player_id").size()
                     .reindex(members["gsis_id"], fill_value=0)
                     .clip(upper=_MAX_GAMES))
            probs = np.zeros(_MAX_GAMES + 1, dtype=float)
            for g in games:
                probs[int(g)] += 1.0
            probs /= probs.sum()
            stats: dict = {}
            for q, qv in (("p10", 0.1), ("p50", 0.5), ("p90", 0.9)):
                if weeks.empty:
                    stats[q] = {s: 0.0 for s in PREDICTED_STATS}
                else:
                    stats[q] = {s: float(np.quantile(weeks[s].to_numpy(), qv))
                                for s in PREDICTED_STATS}
            cohorts[label] = {"n_players": int(len(members)),
                              "n_weeks": int(len(weeks)),
                              "stats": stats, "games_probs": probs}
        positions[pos] = {"merge_map": merge_map, "cohorts": cohorts}
    return {"through": int(through_season), "min_n": int(min_n),
            "positions": positions}


def rookie_projection(cohorts: dict, position: str, round_: int,
                      pick: int) -> tuple[dict, np.ndarray]:
    if position not in cohorts["positions"]:
        raise ValueError(f"no rookie cohorts for position {position!r} "
                         f"(through {cohorts['through']})")
    pos = cohorts["positions"][position]
    label = pos["merge_map"][assign_bucket(int(round_), int(pick))]
    cohort = pos["cohorts"][label]
    frames = {q: pd.DataFrame([cohort["stats"][q]], columns=PREDICTED_STATS)
              for q in ("p10", "p50", "p90")}
    return frames, cohort["games_probs"]
