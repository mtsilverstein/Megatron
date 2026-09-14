"""Predeclared multi-season/origin horizon diagnostic; no model tuning."""
import argparse
import json
from pathlib import Path

from ffmodel.eval.remaining import evaluate_origin
from ffmodel.eval.starter_decisions import summarize_decisions
from ffmodel.site.live_experts import atomic_write


def summarize(reports):
    groups = {}
    for report in reports:
        for cell in report["reports"]:
            for position, values in {"ALL":cell["overall"], **cell["by_position"]}.items():
                key=(cell["horizon"],position)
                groups.setdefault(key,[]).append(values)
    results=[]
    for (horizon,position), cells in sorted(groups.items()):
        n=sum(c["paired_players"] for c in cells)
        def weighted(field):
            return sum(c[field]*c["paired_players"] for c in cells if c["paired_players"]) / n if n else None
        results.append(dict(horizon=horizon,position=position,cells=len(cells),paired_player_forecasts=n,
                            model_mae=weighted("mae"),baseline_mae=weighted("baseline_mae"),
                            paired_mae_delta=weighted("paired_mae_delta"),
                            forecast_players=sum(c["forecast_players"] for c in cells),
                            missing_actuals=sum(c["missing_actuals"] for c in cells)))
    return results


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seasons",nargs="+",type=int,default=[2023,2024,2025])
    parser.add_argument("--origins",nargs="+",type=int,default=[5,9])
    parser.add_argument("--horizons",nargs="+",type=int,default=[1,2,4,8])
    parser.add_argument("--league",default="gabagool")
    parser.add_argument("--data-dir",type=Path,default=Path("data/raw"))
    parser.add_argument("--out",type=Path,required=True)
    args=parser.parse_args()
    if len(set(args.seasons))!=len(args.seasons) or len(set(args.origins))!=len(args.origins):
        parser.error("duplicate seasons/origins")
    from ffmodel.data.pull import pull_weekly,pull_schedules
    from ffmodel.league import load_league
    from ffmodel.model.predictor import TransformerPredictor
    roots=[Path("models/transformer/v1"),Path("models/transformer/v1_s43"),Path("models/transformer/v1_s44")]
    span=list(range(2012,max(args.seasons)+1))
    weekly=pull_weekly(span,cache_dir=args.data_dir)
    schedules=pull_schedules(span,cache_dir=args.data_dir)
    reports=[]
    for season in args.seasons:
        for origin in args.origins:
            print(f"Evaluating {season} origin W{origin}",flush=True)
            reports.append(evaluate_origin(weekly,schedules,season=season,origin=origin,horizons=args.horizons,
                league=load_league(args.league),predictor_factory=lambda f:TransformerPredictor(roots,f)))
    payload=dict(schema_version=1,diagnostic="remaining_matrix",advice_eligible=False,
                 seasons=args.seasons,origins=args.origins,horizons=args.horizons,
                 artifact_roots=[str(r) for r in roots],summary=summarize(reports),reports=reports,
                 starter_summary=summarize_decisions(reports),
                 limitation="Repeated players and overlapping forecast windows are dependent. Weighted descriptive errors, not independent trials, causal estimates or a promotion gate.")
    args.out.parent.mkdir(parents=True,exist_ok=True)
    atomic_write(args.out,json.dumps(payload,indent=2,allow_nan=False))
    print(json.dumps(payload["summary"],indent=2))


if __name__=="__main__":
    main()
