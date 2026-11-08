"""Paired, row-level comparison of two bake-off entrants.

Why this exists (audit A2-1, 2026-11-07): the bake-off table reports each
entrant's MAE per season, which says nothing about whether a gap between two
entrants is larger than its noise. Both entrants are scored on the identical
harness rows, so the honest test is paired: the mean, over those rows, of
|error of the challenger| - |error of the baseline|, with an interval.

The interval is a cluster bootstrap over SEASON-WEEKS. Rows in one week share
a slate, game environments and injuries, so their error differences are
correlated; resampling rows one at a time would understate the uncertainty.
Whole season-weeks are resampled with replacement, through the project's one
cluster-bootstrap loop (`ffmodel.eval.mean_head_gate.paired_bootstrap`), and
the mean is player-week weighted (concatenate, then average).
"""
from __future__ import annotations

import hashlib

import numpy as np
import pandas as pd

from ffmodel.eval.mean_head_gate import paired_bootstrap

KEYS = ["season", "week", "player_id"]
POSITIONS = ["QB", "RB", "WR", "TE"]
# Fixed before any comparison was run (the date the comparison was
# commissioned); it is not a tunable.
BOOTSTRAP_SEED = 20261107
N_BOOT = 10000


def pair_rows(rows: pd.DataFrame, challenger: str, baseline: str) -> pd.DataFrame:
    """One row per harness row scored by BOTH entrants: keys, position,
    actual, and each entrant's point prediction.

    `rows` is `run_backtest(..., return_rows=True)[1]`. Refuses anything that
    is not genuinely paired: a missing entrant, a duplicated key, a row only
    one entrant scored, or the same row carrying two different actuals or
    positions.
    """
    cols = KEYS + ["position", "actual", "pred"]
    parts = {}
    for name in (challenger, baseline):
        part = rows.loc[rows["model"] == name, cols]
        if part.empty:
            raise ValueError(f"pair_rows: no rows for entrant {name!r}")
        if part.duplicated(KEYS).any():
            raise ValueError(f"pair_rows: {name!r} has duplicate "
                             f"(season, week, player_id) rows")
        parts[name] = part
    merged = parts[challenger].merge(
        parts[baseline], on=KEYS, how="outer", suffixes=("_c", "_b"),
        indicator=True,
    )
    unpaired = int((merged["_merge"] != "both").sum())
    if unpaired:
        raise ValueError(f"pair_rows: {unpaired} rows were scored by only one "
                         f"of {challenger!r} and {baseline!r}")
    if not np.array_equal(merged["actual_c"].to_numpy(float),
                          merged["actual_b"].to_numpy(float)):
        raise ValueError("pair_rows: the two entrants disagree on an actual")
    if not (merged["position_c"] == merged["position_b"]).all():
        raise ValueError("pair_rows: the two entrants disagree on a position")
    return pd.DataFrame({
        **{k: merged[k] for k in KEYS},
        "position": merged["position_c"],
        "actual": merged["actual_c"].astype(float),
        "pred_challenger": merged["pred_c"].astype(float),
        "pred_baseline": merged["pred_b"].astype(float),
    }).sort_values(KEYS, ignore_index=True)


def _clusters(frame: pd.DataFrame) -> np.ndarray:
    return (frame["season"].astype(int).astype(str) + "-"
            + frame["week"].astype(int).astype(str).str.zfill(2)).to_numpy()


def _cell(frame: pd.DataFrame, n_boot: int, seed: int) -> dict:
    err_c = (frame["actual"] - frame["pred_challenger"]).abs().to_numpy()
    err_b = (frame["actual"] - frame["pred_baseline"]).abs().to_numpy()
    boot = paired_bootstrap(err_c - err_b, _clusters(frame), n_boot=n_boot, seed=seed)
    return {
        "n": boot["n"],
        "n_clusters": boot["n_clusters"],
        "mae_challenger": float(err_c.mean()),
        "mae_baseline": float(err_b.mean()),
        "mean_diff": boot["mean"],
        "ci95": boot["ci95"],
        "excludes_zero": boot["excludes_zero"],
    }


def paired_comparison(rows: pd.DataFrame, challenger: str, baseline: str, *,
                      n_boot: int = N_BOOT, seed: int = BOOTSTRAP_SEED) -> dict:
    """Pooled, by-test-season and by-position paired MAE difference.

    `mean_diff` is MAE(challenger) - MAE(baseline) on the same rows, so a
    negative value means the challenger is more accurate. `ci95` is the
    percentile interval of the season-week cluster bootstrap; every cell uses
    the same seed.
    """
    paired = pair_rows(rows, challenger, baseline)
    positions = [p for p in POSITIONS if (paired["position"] == p).any()]
    positions += sorted(set(paired["position"]) - set(POSITIONS))
    return {
        "challenger": challenger,
        "baseline": baseline,
        "pooled": _cell(paired, n_boot, seed),
        "by_season": {str(int(s)): _cell(g, n_boot, seed)
                      for s, g in paired.groupby("season", sort=True)},
        "by_position": {p: _cell(paired[paired["position"] == p], n_boot, seed)
                        for p in positions},
    }


def rows_sha256(rows: pd.DataFrame) -> str:
    """Content hash of the per-row predictions a comparison was computed from,
    so a rerun can show it scored the same rows with the same predictions."""
    ordered = rows.sort_values(["model"] + KEYS, ignore_index=True)
    return hashlib.sha256(
        pd.util.hash_pandas_object(ordered, index=False).values.tobytes()
    ).hexdigest()


def build_paired_report(rows: pd.DataFrame, challenger: str,
                        baselines: list[str], provenance: dict, *,
                        n_boot: int = N_BOOT, seed: int = BOOTSTRAP_SEED) -> dict:
    """The committed paired-comparison artifact: `challenger` against each of
    `baselines`, plus the provenance of the run that produced the rows."""
    return {
        **provenance,
        "difference": "MAE(challenger) - MAE(baseline) on identical harness "
                      "rows; negative means the challenger is more accurate",
        "bootstrap": {
            "cluster": "season-week",
            "weighting": "player-week (concatenate, then mean)",
            "interval": "percentile, 2.5-97.5",
            "n_boot": int(n_boot),
            "seed": int(seed),
        },
        "rows_sha256": rows_sha256(rows),
        "comparisons": [paired_comparison(rows, challenger, b, n_boot=n_boot, seed=seed)
                        for b in baselines],
    }
