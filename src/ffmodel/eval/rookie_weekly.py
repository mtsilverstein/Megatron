"""Held-out weekly rookie-prior diagnostic; no live forecast promotion."""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np

from ffmodel.model.rookie import fit_rookie_cohorts, rookie_projection
from ffmodel.scoring import PREDICTED_STATS, fantasy_points


def draft_identity_frame(picks):
    """Keep unidentified draftees in coverage counts without a name-based join."""
    picks = picks.copy()
    missing = picks.gsis_id.isna()
    picks.loc[missing, "gsis_id"] = picks.loc[missing].apply(
        lambda r: f"unresolved_draft:{int(r.season)}:{int(r.pick)}", axis=1)
    return picks


def evaluate(weekly, picks, *, season, origins, horizons, rules, decisions=False,
             schedules=None, predictor_factory=None):
    if predictor_factory is not None and (not decisions or schedules is None):
        raise ValueError("transformer probe requires decisions and schedules")
    if (not origins or not horizons or len(set(origins)) != len(origins)
            or len(set(horizons)) != len(horizons)
            or any(type(o) is not int or o < 1 for o in origins)
            or any(type(h) is not int or h < 1 for h in horizons)
            or max(origins) + max(horizons) - 1 > 18):
        raise ValueError("invalid origins/horizons")
    if weekly.duplicated(["player_id", "season", "week"]).any():
        raise ValueError("duplicate weekly identity")
    if picks.gsis_id.isna().any() or picks.gsis_id.duplicated().any():
        raise ValueError("missing/duplicate draft identity")
    if not np.isfinite(weekly[PREDICTED_STATS].to_numpy()).all():
        raise ValueError("missing/nonfinite stat components")
    # Identical supported stat scoring for both predictions and actuals.
    # No pick-six approximation is compared against absent observed counts.
    rules = replace(rules, pass_int_td=0)
    train = weekly[weekly.season < season]
    prior_picks = picks[picks.season < season]
    models = [fit_rookie_cohorts(train, prior_picks, season - 1, min_n=n)
              for n in (25, 10**9)]
    cls = picks[(picks.season == season) & picks.position.isin(["QB", "RB", "WR", "TE"])]
    if cls.empty or not (weekly.season == season).any():
        raise ValueError("held-out class/observations missing")
    forecasts = {}
    for r in cls.itertuples():
        values = []
        for model in models:
            frames, _ = rookie_projection(model, r.position, r.round, r.pick)
            values.append(float(fantasy_points(frames["p50"], rules).iloc[0]))
        forecasts[r.gsis_id] = values
    cells = []
    for origin in sorted(origins):
        history = weekly[(weekly.season < season) |
                         ((weekly.season == season) & (weekly.week < origin))]
        counts = history.groupby("player_id").size()
        if decisions:
            from ffmodel.eval.rookie_decisions import veteran_pool, compare
            veterans = veteran_pool(history, set(cls.gsis_id), season, rules)
            if predictor_factory is not None:
                from ffmodel.eval.rookie_veteran_model import forecaster
                predict_veterans = forecaster(history, schedules, season, rules, predictor_factory)
        for horizon in sorted(horizons):
            week = origin + horizon - 1
            if decisions:
                target_veterans = (predict_veterans(veterans, week)
                                   if predictor_factory is not None else veterans)
            actual = weekly[(weekly.season == season) & (weekly.week == week)].copy()
            actual["actual"] = fantasy_points(actual[PREDICTED_STATS], rules)
            actual = actual.set_index("player_id")
            groups = {}
            for r in cls.itertuples():
                games = int(counts.get(r.gsis_id, 0))
                if games > 3:
                    continue
                history_group = "zero_history" if games == 0 else "one_to_three_recorded_games"
                key = (r.position, history_group)
                g = groups.setdefault(key, {"forecast_players": 0, "missing_actuals": 0,
                                            "position_mismatch": 0, "errors": [], "rookies": []})
                g["forecast_players"] += 1
                g["rookies"].append(dict(player_id=r.gsis_id, position=r.position,
                    bucketed=forecasts[r.gsis_id][0], baseline=forecasts[r.gsis_id][1]))
                if r.gsis_id not in actual.index:
                    g["missing_actuals"] += 1
                    continue
                row = actual.loc[r.gsis_id]
                if row.position != r.position:
                    g["position_mismatch"] += 1
                    continue
                bucketed, baseline = forecasts[r.gsis_id]
                g["errors"].append((abs(bucketed-row.actual), abs(baseline-row.actual)))
            for (position, history_group), g in sorted(groups.items()):
                errors = g.pop("errors")
                rookies = g.pop("rookies")
                if decisions:
                    g["decisions"] = compare(rookies, target_veterans[target_veterans.position == position], actual)
                n = len(errors)
                cells.append(dict(season=season, origin=origin, horizon=horizon,
                    target_week=week, position=position, history_group=history_group,
                    **g, evaluated=n,
                    bucketed_mae=float(np.mean([e[0] for e in errors])) if n else None,
                    baseline_mae=float(np.mean([e[1] for e in errors])) if n else None))
    return cells


def summarize(cells):
    groups = {}
    for c in cells:
        groups.setdefault((c["position"], c["history_group"]), []).append(c)
    rows = []
    for (position, history_group), group in sorted(groups.items()):
        n = sum(c["evaluated"] for c in group)
        def weighted(field):
            return sum(c[field]*c["evaluated"] for c in group if c["evaluated"]) / n if n else None
        b, p = weighted("bucketed_mae"), weighted("baseline_mae")
        rows.append(dict(position=position, history_group=history_group, evaluated=n,
                         missing_actuals=sum(c["missing_actuals"] for c in group),
                         bucketed_mae=b, baseline_mae=p, paired_mae_delta=b-p if n else None))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seasons", nargs="+", type=int, default=[2023, 2024, 2025])
    parser.add_argument("--origins", nargs="+", type=int, default=[1, 5, 9])
    parser.add_argument("--horizons", nargs="+", type=int, default=[1, 2, 4, 8])
    parser.add_argument("--league", default="gabagool")
    parser.add_argument("--decisions", action="store_true", help="Compare rookies with pre-origin veteran pools")
    parser.add_argument("--veteran-model", choices=["last4", "transformer"], default="last4")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    if args.veteran_model == "transformer" and not args.decisions:
        parser.error("--veteran-model transformer requires --decisions")
    if len(set(args.seasons)) != len(args.seasons):
        parser.error("duplicate seasons")
    from ffmodel.data.pull import pull_weekly, pull_draft_picks
    from ffmodel.league import load_league
    from ffmodel.site.live_experts import atomic_write
    span = list(range(2012, max(args.seasons)+1))
    weekly = pull_weekly(span, cache_dir=args.data_dir)
    raw_picks = pull_draft_picks(span, cache_dir=args.data_dir)
    unidentified = raw_picks[raw_picks.gsis_id.isna()]
    picks = draft_identity_frame(raw_picks)
    rules = load_league(args.league).rules
    schedules = None
    factory = None
    roots = [Path("models/transformer/v1"), Path("models/transformer/v1_s43"), Path("models/transformer/v1_s44")]
    if args.veteran_model == "transformer":
        from ffmodel.data.pull import pull_schedules
        from ffmodel.model.predictor import TransformerPredictor
        schedules = pull_schedules(span, cache_dir=args.data_dir)
        factory = lambda f: TransformerPredictor(roots, f)
    cells = []
    for season in args.seasons:
        cells.extend(evaluate(weekly, picks, season=season, origins=args.origins,
                              horizons=args.horizons, rules=rules, decisions=args.decisions,
                              schedules=schedules, predictor_factory=factory))
    report = dict(schema_version=1, diagnostic="rookie_weekly", advice_eligible=False,
                  league=args.league, seasons=args.seasons, origins=args.origins,
                  scoring_rules=asdict(replace(rules, pass_int_td=0)),
                  horizons=args.horizons, summary=summarize(cells), cells=cells,
                  unresolved_draft_identities=[dict(season=int(r.season), pick=int(r.pick),
                      name=r.player_name) for r in unidentified.itertuples()],
                  limitations=["Recorded target weeks only; missing rows are unknown, not zero. Participation is not modeled.",
                               "Unresolved draft identities retain synthetic draft-slot keys and missing coverage; no name-based matching or assumed zero output.",
                               "Drafted rookies only; not a returning-veteran or undrafted-player fallback.",
                               "Prior is unchanged across horizons and ignores early rookie performance; low-history results are a diagnostic only.",
                               "Component-stat medians scored with the same supported-stat league rules; pick-six cost excluded on both sides.",
                               "Repeated players/windows are dependent. Descriptive comparison, not a promotion gate or calibrated uncertainty."])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.decisions:
        from ffmodel.eval.rookie_decisions import summarize as summarize_decisions, POOL_SIZE
        report["decision_summary"] = summarize_decisions(cells)
        report["decision_summary_by_season"] = {str(s): summarize_decisions(
            [c for c in cells if c["season"] == s]) for s in args.seasons}
        report["veteran_pool_sizes"] = POOL_SIZE
        report["veteran_model"] = args.veteran_model
        if factory is not None:
            report["artifact_roots"] = [str(r) for r in roots]
            report["limitations"].append("Transformer artifacts selected through season S-1; frozen pre-origin observations at every horizon. Schedules are retrospective, not reconstructed as-of snapshots. Unprojected veterans remain explicit excluded pairs, never zero or last-four fallback.")
        report["limitations"].append("Same-position rookie/veteran pairs, not real rosters or a FLEX optimizer. Veteran pools use frozen last-four-game means; veteran forecasts use the declared veteran_model identically in both rookie methods. Veteran team/position changes are excluded; rookie position must match.")
    atomic_write(args.out, json.dumps(report, indent=2, allow_nan=False))
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
