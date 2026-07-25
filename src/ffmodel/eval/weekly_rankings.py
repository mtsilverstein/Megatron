"""Weekly expert-consensus benchmark: our weekly projection vs weekly ECR.

The preseason board loses to expert consensus (see eval/consensus.py) largely
on season-long AVAILABILITY forecasting. Over a one-week horizon, with the
injury report already public, that edge evaporates -- so this asks the cleaner
question: conditional on a player suiting up, do we rank a week's players as
well as the weekly expert consensus? Measured result (v1, 2023-25): a
statistical tie overall, with a real running-back edge.

Two invariants this module exists to enforce, because both were violated in
the throwaway scratchpad version this replaces:

1. **Sign safety.** Scores are always "higher = better". `goodness_spearman`
   takes such a score; `ecr_goodness` is the ONE place a rank (lower=better)
   becomes a goodness score. Callers never negate anything themselves, so the
   scratchpad bug -- negating our POINTS with the pattern meant for a RANK --
   cannot recur. `assert_model_sane` is a belt-and-suspenders tripwire: a
   trained model cannot be negatively rank-correlated with reality across a
   season, so a negative mean is a sign bug, not a finding.
2. **Leak safety.** `weekly_snapshot` returns the latest consensus scrape
   STRICTLY before that week's kickoff and within `max_stale_days`; a week
   whose only scrape is post-kickoff or too old yields None (skipped), never a
   stale/leaky ranking handed to consensus that we would then beat unfairly.
"""
from __future__ import annotations

import pandas as pd
from scipy.stats import spearmanr

from ffmodel.data.pull import POSITIONS

WEEKLY_ECR_TYPE = "wp"
WEEKLY_PAGES = tuple(f"weekly-{p.lower()}" for p in POSITIONS)
RANKING_COLUMNS = ["fp_id", "player", "pos", "team", "ecr", "sd",
                   "mergename", "scrape_date"]
MAX_STALE_DAYS = 7


def normalize_weekly_rankings(raw: pd.DataFrame) -> pd.DataFrame:
    """Raw `load_ff_rankings("all")` -> weekly positional consensus for
    in-scope positions, whitelisted columns. Mirrors
    `ffmodel.data.rankings.normalize_rankings` but for the weekly pages."""
    df = raw[(raw["ecr_type"] == WEEKLY_ECR_TYPE)
             & (raw["page_type"].isin(WEEKLY_PAGES))
             & (raw["pos"].isin(POSITIONS))].copy()
    df["scrape_date"] = pd.to_datetime(df["scrape_date"])
    df["fp_id"] = df["id"].astype(str).str.strip()
    df["mergename"] = df["mergename"].astype(str)
    return df[RANKING_COLUMNS].reset_index(drop=True)


def weekly_snapshot(rankings: pd.DataFrame, kickoff: pd.Timestamp,
                    max_stale_days: int = MAX_STALE_DAYS) -> pd.DataFrame | None:
    """Latest consensus scrape in [kickoff - max_stale_days, kickoff).

    Returns None (caller skips the week) when no scrape falls in that window:
    a post-kickoff scrape would leak the week's results, and a scrape older
    than the window is not a ranking FOR this week -- using either would make
    the comparison dishonest.
    """
    lo = kickoff - pd.Timedelta(days=max_stale_days)
    window = rankings[(rankings["scrape_date"] < kickoff)
                      & (rankings["scrape_date"] >= lo)]
    if window.empty:
        return None
    latest = window["scrape_date"].max()
    return window[window["scrape_date"] == latest].reset_index(drop=True)


def ecr_goodness(ecr) -> "pd.Series":
    """Convert an expert-consensus RANK (lower = better) into a goodness score
    (higher = better). The single, tested place this conversion happens."""
    return -pd.Series(ecr).to_numpy()


def goodness_spearman(goodness, actual) -> float:
    """Spearman between a HIGHER-IS-BETTER score and realized points. A good
    predictor yields a POSITIVE value; a caller who passes an inverted score
    gets a negative one, which `assert_model_sane` will catch downstream."""
    import numpy as np

    if len(goodness) < 2:
        return float("nan")
    r = spearmanr(goodness, actual).correlation
    return float(r) if r is not None and np.isfinite(r) else float("nan")


def score_week(cell_frame: pd.DataFrame, season: int, week: int,
               replacement_rank: dict[str, int], min_cell: int = 5) -> list[dict]:
    """Per-position within-week ranking metrics for one week.

    `cell_frame` columns: player_id, position, our_pts (higher=better points),
    ecr (rank, lower=better), actual (realized points). Positions with fewer
    than `min_cell` players are skipped (a Spearman on 3 players is noise).
    """
    out = []
    for pos in POSITIONS:
        g = cell_frame[cell_frame["position"] == pos]
        if len(g) < min_cell:
            continue
        rank = replacement_rank[pos]
        slots = min(rank, len(g))
        truth_top = set(g.nlargest(slots, "actual")["player_id"])
        out.append({
            "season": season, "week": int(week), "position": pos, "n": len(g),
            "sp_ours": goodness_spearman(g["our_pts"].to_numpy(), g["actual"].to_numpy()),
            "sp_con": goodness_spearman(ecr_goodness(g["ecr"]), g["actual"].to_numpy()),
            # start/sit agreement: our top-`slots` by points vs consensus top-`slots`
            # by rank, each against the realized top-`slots`.
            "hit_ours": len(set(g.nlargest(slots, "our_pts")["player_id"]) & truth_top),
            "hit_con": len(set(g.nsmallest(slots, "ecr")["player_id"]) & truth_top),
            "slots": slots,
        })
    return out


def assert_model_sane(scored: pd.DataFrame) -> None:
    """Tripwire: a trained model cannot be negatively rank-correlated with
    realized points across a full slate. A negative mean `sp_ours` means a
    sign error upstream, not a result -- fail loudly so it can never ship."""
    mean_ours = scored["sp_ours"].mean()
    if mean_ours < 0:
        raise AssertionError(
            f"model mean weekly Spearman is {mean_ours:.3f} -- a trained model "
            f"cannot be negatively correlated with reality; this is a sign bug, "
            f"not a result"
        )
