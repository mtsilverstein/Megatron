"""Historical evaluation of close, within-position start/sit decisions.

This is a player-week decision diagnostic, not a roster backtest.  It forms
all unordered pairs within a (season, week, position) cell and retains pairs
whose projected fantasy points are close enough to represent a real choice.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import replace
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from ffmodel.scoring import LEAGUE, PREDICTED_STATS, ScoringRules, fantasy_points
from ffmodel.site.pick_sixes import add_pick_six_expectation, load_pick_six_prior

DEFAULT_ROOTS = [Path("models/transformer/v1"), Path("models/transformer/v1_s43"),
                 Path("models/transformer/v1_s44")]
DEFAULT_SEASONS = [2023, 2024, 2025]
PAIR_COLUMNS = ["season", "week", "position", "chosen_player_id",
                "other_player_id", "predicted_gap", "actual_gap", "correct",
                "regret"]


def rules_from_league_config(path: Path) -> ScoringRules:
    """Load the scoring overrides used by a league config.

    LEAGUE supplies the complete Gabagool defaults; the checked-in config is
    still authoritative for its explicit overrides. Unknown keys fail loudly
    instead of being silently ignored.
    """
    raw = yaml.safe_load(Path(path).read_text()) or {}
    overrides = raw.get("scoring", {})
    known = set(ScoringRules.__dataclass_fields__) - {"name"}
    unknown = set(overrides) - known
    if unknown:
        raise ValueError(f"unknown scoring keys in {path}: {sorted(unknown)}")
    return replace(LEAGUE, name=str(raw.get("name", LEAGUE.name)), **overrides)


def deployed_projected_points(frames: dict, positions: pd.Series,
                              rules: ScoringRules, pick_six_rate: float) -> pd.Series:
    """Score p50 after the same pick-six expectation used by the weekly site."""
    enriched = add_pick_six_expectation(frames, positions, pick_six_rate)
    return fantasy_points(enriched["p50"], rules)


def close_pairs(frame: pd.DataFrame, max_projected_gap: float = 3.0,
                min_projection: float = 5.0) -> pd.DataFrame:
    """Return close pair decisions from scored player-week rows.

    Required columns are season, week, position, player_id, predicted, actual.
    The higher projection is the choice. Exact projection ties are excluded
    because the model made no choice; exact actual ties remain in regret but
    have ``correct`` missing and therefore do not enter choice accuracy.
    """
    if max_projected_gap <= 0:
        raise ValueError("max_projected_gap must be positive")
    required = {"season", "week", "position", "player_id", "predicted", "actual"}
    missing = required - set(frame)
    if missing:
        raise ValueError(f"missing columns: {sorted(missing)}")
    rows = []
    for (season, week, position), group in frame.groupby(
            ["season", "week", "position"], sort=True):
        clean = group.dropna(subset=["player_id", "predicted", "actual"])
        clean = clean[clean["predicted"] >= min_projection]
        if clean["player_id"].duplicated().any():
            raise ValueError(f"duplicate player in {season} week {week} {position}")
        for (_, a), (_, b) in combinations(clean.iterrows(), 2):
            gap = float(a["predicted"] - b["predicted"])
            if gap == 0 or abs(gap) > max_projected_gap:
                continue
            chosen, other = (a, b) if gap > 0 else (b, a)
            actual_gap = float(chosen["actual"] - other["actual"])
            rows.append({
                "season": int(season), "week": int(week), "position": position,
                "chosen_player_id": chosen["player_id"],
                "other_player_id": other["player_id"],
                "predicted_gap": abs(gap), "actual_gap": actual_gap,
                "correct": (np.nan if actual_gap == 0 else actual_gap > 0),
                "regret": max(0.0, -actual_gap),
            })
    return pd.DataFrame(rows, columns=PAIR_COLUMNS)


def summarize(pairs: pd.DataFrame, max_projected_gap: float,
              min_projection: float = 5.0) -> dict:
    """Summarize decision accuracy and point regret, overall and by position."""
    def one(g: pd.DataFrame) -> dict:
        decided = g["correct"].notna()
        regret = g["regret"].astype(float)
        return {
            "pairs": int(len(g)), "decided_pairs": int(decided.sum()),
            "actual_ties": int((~decided).sum()),
            "choice_accuracy": (round(float(g.loc[decided, "correct"].mean()), 4)
                                if decided.any() else None),
            "mean_regret_points": (round(float(regret.mean()), 4) if len(g) else None),
            "total_regret_points": round(float(regret.sum()), 2),
            "p90_regret_points": (round(float(regret.quantile(.9)), 4) if len(g) else None),
            "max_regret_points": (round(float(regret.max()), 4) if len(g) else None),
        }
    return {
        "conditioning": {
            "pair_rule": "all unordered pairs in the same season/week/position",
            "projected_gap_points_lte": max_projected_gap,
            "each_player_projected_points_gte": min_projection,
            "cutoff_rationale": "fixed plausible-starter screen; ECR was unavailable",
            "projection_ties": "excluded (the model expressed no preference)",
            "actual_ties": "excluded from accuracy; zero regret",
            "population": "player-weeks with realized stat lines; not actual rosters",
            "dependence": "pairs reuse players within cells; no naive binomial CI is reported",
        },
        "overall": one(pairs),
        "by_position": {str(pos): one(g) for pos, g in pairs.groupby("position")},
        "week_1": one(pairs[pairs["week"] == 1]),
    }


def compare_baselines(pairs: pd.DataFrame, baseline: pd.DataFrame) -> dict:
    """Compare experts on the SAME model-selected pairs, never a new cohort.

    Canonical input must carry exact GSIS identity and pre-kickoff provenance.
    kickoff_at is the FIRST regular-season kickoff of that NFL week, not an
    individual player's kickoff. Date-only snapshot times are not sufficient.
    ECR is ascending and never converted to league points. External projected
    FPTS is ignored. Regret uses the diagnostic's realized league-score gaps.
    """
    keys = ["season", "week", "position", "player_id"]
    required = set(keys + ["snapshot_at", "kickoff_at", "ecr"])
    if required - set(baseline):
        raise ValueError(f"missing baseline columns: {sorted(required - set(baseline))}")
    if baseline[keys].isna().any().any() or baseline.duplicated(keys).any():
        raise ValueError("missing or duplicate baseline identity")
    source = baseline.copy()
    snapshot = pd.to_datetime(source["snapshot_at"], utc=True, errors="coerce", format="ISO8601")
    kickoff = pd.to_datetime(source["kickoff_at"], utc=True, errors="coerce", format="ISO8601")
    valid_time = snapshot.notna() & kickoff.notna() & (snapshot < kickoff)
    for column in ["snapshot_at", "kickoff_at"]:
        valid_time &= source[column].astype(str).str.contains(
            r"T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$", regex=True)
    if (source.groupby(["season", "week"])["kickoff_at"].nunique() > 1).any():
        raise ValueError("baseline must use one first-week kickoff cutoff per season/week")
    # Match the existing weekly consensus freshness policy (seven days).
    from ffmodel.eval.weekly_rankings import MAX_STALE_DAYS
    valid_time &= (kickoff - snapshot) <= pd.Timedelta(days=MAX_STALE_DAYS)
    source = source.loc[valid_time]
    joined = pairs.copy()
    for side, player in [("chosen", "chosen_player_id"), ("other", "other_player_id")]:
        renamed = source.rename(columns={"player_id": player,
                                        "ecr": f"{side}_ecr"})
        joined = joined.merge(renamed[["season", "week", "position", player,
                                      f"{side}_ecr"]],
                              how="left", on=["season", "week", "position", player],
                              validate="many_to_one")
    results = {}
    for metric, direction in [("ecr", -1)]:
        a = pd.to_numeric(joined[f"chosen_{metric}"], errors="coerce")
        b = pd.to_numeric(joined[f"other_{metric}"], errors="coerce")
        covered = np.isfinite(a) & np.isfinite(b)
        if metric == "ecr":
            covered &= (a > 0) & (b > 0)
        tied = covered & (a == b)
        comparable = covered & ~tied
        actual = joined.loc[comparable, "actual_gap"].astype(float)
        preference = np.sign((a[comparable] - b[comparable]) * direction)
        expert_gap = actual * preference
        decisive = actual != 0
        results[metric] = {
            "covered_pairs": int(covered.sum()),
            "missing_pairs": int((~covered).sum()),
            "baseline_ties": int(tied.sum()),
            "comparable_pairs": int(comparable.sum()),
            "actual_ties": int((~decisive).sum()),
            "model_accuracy_same_pairs": float((actual[decisive] > 0).mean()) if decisive.any() else None,
            "baseline_accuracy": float((expert_gap[decisive] > 0).mean()) if decisive.any() else None,
            "model_mean_regret_same_pairs": float((-actual).clip(lower=0).mean()) if len(actual) else None,
            "baseline_mean_regret": float((-expert_gap).clip(lower=0).mean()) if len(actual) else None,
        }
    return {"pair_universe": int(len(pairs)),
            "rejected_snapshot_rows": int((~valid_time).sum()),
            "scope": "Same model-selected close pairs; source scoring is not league-rescored. "
                     "Baseline ties excluded from both entrants' comparison. "
                     "Pairs are dependent; no naive confidence interval.",
            "baselines": results}


def evaluate(features: pd.DataFrame, seasons: list[int], roots: list[Path],
             rules: ScoringRules, max_projected_gap: float = 3.0,
             min_projection: float = 5.0, *,
             baseline: pd.DataFrame | None = None) -> tuple[pd.DataFrame, dict]:
    """Run committed walk-forward artifacts; never trains or tunes a model."""
    from ffmodel.eval.splits import walk_forward_splits
    from ffmodel.model.predictor import TransformerPredictor

    predictor = TransformerPredictor(roots, features)
    frames = []
    pick_six_priors = {}
    for season, train_idx, test_idx in walk_forward_splits(features, seasons):
        train, test = features.loc[train_idx], features.loc[test_idx]
        predictor.fit(train)
        quantiles = predictor.predict_quantiles(test)
        prior = load_pick_six_prior(season)
        pick_six_priors[str(season)] = prior
        actual_cols = [c for c in test.columns if c in PREDICTED_STATS or
                       c in ("two_point_conversions", "special_teams_tds",
                             "passing_pick_sixes")]
        frames.append(pd.DataFrame({
            "season": test["season"].astype(int), "week": test["week"].astype(int),
            "position": test["position"], "player_id": test["player_id"],
            "predicted": deployed_projected_points(
                quantiles, test["position"], rules, prior["rate"]),
            "actual": fantasy_points(test[actual_cols], rules),
        }))
    scored = pd.concat(frames, ignore_index=True)
    pairs = close_pairs(scored, max_projected_gap, min_projection)
    report = summarize(pairs, max_projected_gap, min_projection)
    eligible = scored[scored["predicted"] >= min_projection]
    report["pair_universe"] = {
        "played_player_weeks_before_projection_screen": int(len(scored)),
        "eligible_player_weeks_after_projection_screen": int(len(eligible)),
        "eligible_week_position_cells": int(eligible.groupby(
            ["season", "week", "position"]).ngroups),
        "warning": "The projection screen narrows the broad tail but is only a "
                   "plausible-starter proxy; eligible players were not observed "
                   "on the same fantasy roster.",
    }
    report.update({
        "schema_version": 1,
        "experiment": "close-start-sit-decisions", "seasons": sorted(seasons),
        "run_parameters": {"max_projected_gap": max_projected_gap,
                           "min_projection": min_projection,
                           "feature_rows": int(len(features))},
        "scoring": rules.__dict__,
        "artifacts": {"roots": [p.as_posix() for p in roots],
                      "folds": [f"through{s - 1}" for s in sorted(seasons)]},
        "pick_six_forecast_priors": pick_six_priors,
        "scoring_coverage": {
            "label": "modeled Gabagool scoring subset, not complete Sleeper scoring",
            "prediction_pick_sixes": "deployed pooled expected-cost method using "
                                     "only completed seasons before each test season",
            "actual_pick_sixes": "unavailable in normalized historical weekly caches; "
                                 "therefore realized pick-six penalties are zero here",
            "omitted": ["50+ yard passing TD bonus", "50+ yard rushing TD bonus",
                        "50+ yard receiving TD bonus"],
        },
        "scope_note": "This measures pairwise choices among players who recorded a "
                      "historical stat line. It does not reconstruct any fantasy roster.",
        "ecr_note": "No ECR baseline is included; this run evaluates model choices only.",
    })
    if baseline is not None:
        report["baseline_comparison"] = compare_baselines(pairs, baseline)
        report["ecr_note"] = "Baseline comparison included with explicit coverage and snapshot exclusions."
    return pairs, report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seasons", nargs="+", type=int, default=DEFAULT_SEASONS)
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--league-config", type=Path,
                        default=Path("configs/leagues/gabagool.yaml"))
    parser.add_argument("--root", action="append", type=Path)
    parser.add_argument("--max-gap", type=float, default=3.0)
    parser.add_argument("--min-projection", type=float, default=5.0)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--baseline-json", type=Path,
                        help="Canonical expert rows with exact player IDs and pre-week-kickoff timestamps")
    args = parser.parse_args()
    from ffmodel.data.features import build_features
    from ffmodel.data.pull import pull_schedules, pull_weekly

    seasons = sorted(args.seasons)
    span = list(range(args.first_season, max(seasons) + 1))
    features = build_features(pull_weekly(span, cache_dir=args.data_dir),
                              pull_schedules(span, cache_dir=args.data_dir))
    _, report = evaluate(features, seasons, args.root or DEFAULT_ROOTS,
                         rules_from_league_config(args.league_config), args.max_gap,
                         args.min_projection,
                         baseline=(pd.DataFrame(json.loads(args.baseline_json.read_text()))
                                   if args.baseline_json else None))
    rendered = json.dumps(report, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered)
    print(rendered)


if __name__ == "__main__":
    main()
