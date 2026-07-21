"""Walk-forward rookie backtest.

For each held-out class S: fit cohorts on classes <= S-1, project class S
from draft capital alone, compare to actual rookie-season PPR totals
(players who never played count as 0.0 -- they were draftable and busted;
excluding them would flatter the prior). Output goes to models/diagnostics/
-- models/backtests/ is schema-locked to weekly/board reports.

Pre-registered gates (spec 2026-07-19-rookie-projections-design.md):
Gate 1: capital-bucketed prior beats a position-only baseline on pooled
Spearman vs actual rookie-season PPR. Gate 2: rookie band coverage is
measured and reported per position, whatever it is. STOP rule: Gate 1
failing means the board ships position-only priors (min_n=10**9), reported
honestly -- bucket boundaries are never tuned against the held-out classes.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from ffmodel.data.pull import pull_draft_picks, pull_weekly
from ffmodel.model.rookie import fit_rookie_cohorts, rookie_projection
from ffmodel.model.simulate import simulate_season
from ffmodel.scoring import fantasy_points_quantiles
from ffmodel.site.weekly import RULESETS

_POSITION_ONLY_MIN_N = 10**9
_SEASON_WEEKS = 17


def project_class(weekly: pd.DataFrame, draft_picks: pd.DataFrame,
                  class_season: int, *, min_n: int | None = None,
                  n_draws: int = 2000, seed: int = 0) -> list[dict]:
    kwargs = {} if min_n is None else {"min_n": min_n}
    cohorts = fit_rookie_cohorts(
        weekly[weekly["season"] < class_season],
        draft_picks[draft_picks["season"] < class_season],
        through_season=class_season - 1, **kwargs)
    rng = np.random.default_rng(seed)
    rows = []
    cls = draft_picks[draft_picks["season"] == class_season]
    for _, r in cls.iterrows():
        frames, games_probs = rookie_projection(
            cohorts, r["position"], int(r["round"]), int(r["pick"]))
        pts = fantasy_points_quantiles(frames, RULESETS["ppr"])
        triple = (float(pts["p10"].iloc[0]), float(pts["p50"].iloc[0]),
                  float(pts["p90"].iloc[0]))
        sim = simulate_season(np.array([triple] * _SEASON_WEEKS),
                              games_probs, n_draws, rng)
        rows.append({"player_id": r["gsis_id"], "player_name": r["player_name"],
                     "position": r["position"], "round": int(r["round"]),
                     "pick": int(r["pick"]),
                     "p10": sim["p10"], "p50": sim["p50"], "p90": sim["p90"]})
    return rows


def actual_rookie_points(weekly: pd.DataFrame, cls: pd.DataFrame,
                         class_season: int) -> pd.Series:
    season_weeks = weekly[weekly["season"] == class_season]
    totals = season_weeks.groupby("player_id")["fantasy_points_ppr"].sum()
    return totals.reindex(cls["gsis_id"], fill_value=0.0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Walk-forward rookie backtest.")
    parser.add_argument("--classes", nargs="+", type=int,
                        default=[2023, 2024, 2025])
    parser.add_argument("--out", type=Path,
                        default=Path("models/diagnostics/rookie_backtest.json"))
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--n-draws", type=int, default=2000)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    last = max(args.classes)
    weekly = pull_weekly(list(range(args.first_season, last + 1)),
                         cache_dir=args.data_dir)
    picks = pull_draft_picks(list(range(args.first_season, last + 1)),
                             cache_dir=args.data_dir)

    per_class, pred_b, pred_p, actual_all = [], [], [], []
    covered = {}
    for class_season in sorted(args.classes):
        cls = picks[picks["season"] == class_season]
        bucketed = project_class(weekly, picks, class_season,
                                 n_draws=args.n_draws)
        pos_only = project_class(weekly, picks, class_season,
                                 min_n=_POSITION_ONLY_MIN_N,
                                 n_draws=args.n_draws)
        actuals = actual_rookie_points(weekly, cls, class_season)
        for row_b, row_p, actual in zip(bucketed, pos_only, actuals):
            pred_b.append(row_b["p50"])
            pred_p.append(row_p["p50"])
            actual_all.append(float(actual))
            covered.setdefault(row_b["position"], []).append(
                row_b["p10"] <= float(actual) <= row_b["p90"])
        per_class.append({"class": class_season, "n": int(len(cls))})

    # A held-out set with zero variance in actual points (e.g. classes whose
    # seasons haven't been played yet, or a broken data pull that silently
    # returned empty weekly rows) makes Spearman correlation mathematically
    # undefined -- nothing to rank against. This must NOT be reported as a
    # passing gate: a gate that measured nothing is not a gate that passed
    # (fail-safe invariant -- see CLAUDE.md). Abort loudly before writing
    # anything. Any real backtest class (60+ rookies, some producing and
    # some not) has non-zero variance, so this never fires on a healthy run.
    if len(set(actual_all)) <= 1:
        raise RuntimeError(
            "all rookie actuals are identical — data pull broken or classes "
            "not yet played; refusing to write a gate report")

    rho_b = float(spearmanr(pred_b, actual_all).statistic)
    rho_p = float(spearmanr(pred_p, actual_all).statistic)
    gate1 = {"bucketed_spearman": round(rho_b, 4),
             "position_only_spearman": round(rho_p, 4),
             "passed": bool(rho_b > rho_p)}
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "classes": sorted(args.classes),
        "n_rookies": len(actual_all),
        "gate1": gate1,
        "coverage_p10_p90": {pos: round(float(np.mean(v)), 4)
                             for pos, v in sorted(covered.items())},
        "per_class": per_class,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False))
    print(f"{args.out}: gate1 passed={report['gate1']['passed']} "
          f"(bucketed {rho_b:.3f} vs position-only {rho_p:.3f})")


if __name__ == "__main__":
    main()
