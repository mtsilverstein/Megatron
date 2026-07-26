"""Consensus-anchored board ranking (spec 2026-07-25).

ECR sets the intra-position order; the model's points, sorted descending and
laid onto that order, set the value curve; VORP/tiers follow. Pure functions,
no I/O. With no ECR this reduces exactly to ordering by the model's p50 (the
pre-consensus behavior), so callers that pass no consensus are unchanged."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd


def adp_round(adp: float | None, teams: int = 12) -> int | None:
    """Overall ADP pick -> draft round in a `teams`-team league."""
    if adp is None or (isinstance(adp, float) and math.isnan(adp)):
        return None
    return math.ceil(float(adp) / teams)


def order_and_value(group: pd.DataFrame) -> pd.DataFrame:
    """Order one position and assign a monotone value curve.

    Players with a finite `ecr` sort by it ascending; the ECR-less tail sorts
    by `ppr_p50` descending and falls below them. `value_points` is the group's
    `ppr_p50` values sorted descending, laid onto that order -- so value falls
    monotonically while the ORDER is ECR's, not the model's."""
    has_ecr = group["ecr"].notna()
    ranked = group[has_ecr].sort_values("ecr", kind="mergesort")
    tail = group[~has_ecr].sort_values("ppr_p50", ascending=False, kind="mergesort")
    ordered = pd.concat([ranked, tail]).reset_index(drop=True)
    ordered["value_points"] = np.sort(group["ppr_p50"].to_numpy())[::-1]
    return ordered


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


def flex_replacement_ranks(players: pd.DataFrame, dedicated: dict[str, int],
                           flex_slots: int,
                           flex_positions=("RB", "WR", "TE")) -> dict[str, int]:
    """Per-position replacement rank, deriving the flex split from ECR.

    Every team fills its dedicated slots first (`dedicated` = league-wide counts,
    e.g. {"QB":12,"RB":24,"WR":24,"TE":12}); the `flex_slots` remaining lineup
    spots go to the best players by ECR across `flex_positions`, regardless of
    position -- so the split falls out of the rankings instead of a guess.
    Replacement rank = (dedicated + flex started) + 1. Non-flex positions get
    dedicated + 1. Players without an ECR never start and are ignored."""
    ranked = players[players["ecr"].notna()]
    leftovers = []                       # (ecr, position) beyond dedicated
    for pos in flex_positions:
        grp = ranked[ranked["position"] == pos].sort_values("ecr", kind="mergesort")
        for ecr in grp["ecr"].to_numpy()[dedicated.get(pos, 0):]:
            leftovers.append((float(ecr), pos))
    leftovers.sort(key=lambda t: t[0])
    flex_taken = [pos for _ecr, pos in leftovers[:flex_slots]]
    repl = {pos: dedicated.get(pos, 0) + flex_taken.count(pos) + 1
            for pos in flex_positions}
    for pos, ded in dedicated.items():
        if pos not in flex_positions:
            repl[pos] = ded + 1
    return repl


def rank_board(players: pd.DataFrame,
               replacement_rank: dict[str, int]) -> pd.DataFrame:
    """Per-position order_and_value -> VORP -> position_rank -> tier, then the
    whole board sorted by VORP descending, with adp_round attached."""
    frames = []
    for _pos, group in players.groupby("position"):
        pos = group["position"].iloc[0]
        ordered = order_and_value(group)
        rank = replacement_rank.get(pos, 20)
        repl = ordered["value_points"].iloc[min(rank, len(ordered)) - 1]
        ordered["vorp"] = (ordered["value_points"] - repl).round(2)
        ordered["position_rank"] = ordered.index + 1
        # Tiers mark value cliffs within the RANKED (ECR'd) pool; they must not
        # extend into the no-ECR depth tail (spec §6.7), or a depth player would
        # render a spurious tier shelf. `order_and_value` puts the ECR'd players
        # first, so the head n_ecr rows are the ranked pool. When there is no ECR
        # at all (pure-model fallback) or every player is ranked, tier the whole
        # group as before -- backward-compat with the model-only board + backtest.
        n_ecr = int(group["ecr"].notna().sum())
        if 0 < n_ecr < len(ordered):
            head = _assign_tiers(ordered["vorp"].iloc[:n_ecr], rank)
            tail_tier = (head[-1] + 1) if head else 1
            ordered["tier"] = head + [tail_tier] * (len(ordered) - n_ecr)
        else:
            ordered["tier"] = _assign_tiers(ordered["vorp"], rank)
        frames.append(ordered)
    board = pd.concat(frames).sort_values("vorp", ascending=False, kind="mergesort")
    # Map adp_round values, then convert to object dtype to preserve None
    board["adp_round"] = pd.Series([adp_round(a) for a in board["adp"]],
                                    index=board.index, dtype=object)
    return board.reset_index(drop=True)
