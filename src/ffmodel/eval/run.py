"""Run the full walk-forward backtest and write the committed JSON report."""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from ffmodel.baseline.naive import NaiveLast4
from ffmodel.baseline.xgb import OBJECTIVES, XGBBaseline, XGBSeedAverage
from ffmodel.data.features import build_features
from ffmodel.data.pull import _cache_name, pull_schedules, pull_weekly
from ffmodel.eval.harness import run_backtest
from ffmodel.eval.paired import build_paired_report
from ffmodel.model.train import _run_is_complete
from ffmodel.scoring import BAND_CONSTRUCTION


def discover_ensemble_roots(base_root: Path) -> list[Path]:
    """Discover complete seed-ensemble siblings of `base_root` (e.g.
    `models/transformer/v1_s43`, `v1_s44` next to `models/transformer/v1`)
    so the bake-off always scores exactly what could deploy.

    Always returns `base_root` first -- it's assumed to exist and be
    usable; a missing base means there's nothing to evaluate at all, which
    is a config error, not a normal "no ensemble" case, so that raises
    rather than returning an empty/partial list.

    A sibling `{base_root.name}_s*` joins the list only if it has EXACTLY
    the same set of `through*` subdirs as the base AND every one of those
    has a `metrics.json` with `complete: true` (via `_run_is_complete`,
    reused from `ffmodel.model.train` rather than duplicated). A seed that's
    still training mid-Studio-Lab-session, or only covers some folds, must
    never silently join an eval and skew the ensemble average -- such
    siblings are excluded with a printed warning naming the root and the
    reason, not raised, since a partial seed is an expected, non-fatal
    state and Run All should keep working around it.
    """
    if not base_root.exists():
        raise ValueError(
            f"discover_ensemble_roots: base root does not exist: {base_root}"
        )

    def _through_dirs(root: Path) -> set[str]:
        return {p.name for p in root.iterdir() if p.is_dir() and p.name.startswith("through")}

    base_through = _through_dirs(base_root)
    roots = [base_root]

    siblings = sorted(
        (p for p in base_root.parent.glob(f"{base_root.name}_s*") if p.is_dir()),
        key=lambda p: p.name,
    )
    for sibling in siblings:
        sibling_through = _through_dirs(sibling)
        if sibling_through != base_through:
            missing = sorted(base_through - sibling_through)
            extra = sorted(sibling_through - base_through)
            print(
                f"discover_ensemble_roots: excluding {sibling} -- through-dirs "
                f"don't match {base_root.name} (missing={missing}, extra={extra})"
            )
            continue
        incomplete = sorted(
            d for d in sibling_through
            if not _run_is_complete(sibling / d / "metrics.json")
        )
        if incomplete:
            print(
                f"discover_ensemble_roots: excluding {sibling} -- incomplete "
                f"runs: {incomplete}"
            )
            continue
        roots.append(sibling)
    return roots


def source_data_files(data_dir: Path, seasons: list[int]) -> list[Path]:
    """The cached nflverse pulls this backtest reads, in read order.

    Names come from `pull`'s own `_cache_name` rather than being spelled out
    here, so a cache-prefix bump upstream (weekly_v2 -> weekly_v3, ...) can
    never leave this hashing a stale file that the run didn't actually use;
    a prefix this doesn't follow shows up as a null digest in the report,
    not as a silently wrong one.
    """
    names = [
        _cache_name("weekly_v2", seasons),
        _cache_name("snaps", seasons),
        "players",
        _cache_name("schedules_v3", seasons),
    ]
    return [Path(data_dir) / f"{name}.parquet" for name in names]


def data_vintage(data_dir: Path, seasons: list[int], feature_rows: int) -> dict:
    """Provenance for WHICH nflverse pull produced a report.

    Two reports generated months apart are not comparable, and nothing in
    the reports used to say so: `models/backtests/baselines.json` and
    `bakeoff.json` disagree by up to 0.021 OVERALL PPR MAE on the same
    model/season/test-set, an order of magnitude larger than any feature
    effect measured for the baseline, and the record had no field that
    could tell a reader the two ran on different inputs (see
    `models/diagnostics/xgb_feature_set_audit.json`).

    Recorded per source file: a sha256 of its bytes plus its size. Content
    hashing, not size+mtime: an nflverse re-pull rewrites mtime on every
    file whether or not a single row changed (false "incomparable"), and a
    revision that swaps values without changing the row count can leave the
    size alone (false "comparable"). `feature_rows` is the cheap
    human-readable companion -- the 2025 test fold lost 7 rows to an
    upstream revision between the two committed reports, which a row count
    surfaces immediately and a digest only says "differs" about.
    """
    sources = []
    for path in source_data_files(data_dir, seasons):
        if not path.exists():
            sources.append({"file": path.name, "bytes": None, "sha256": None})
            continue
        digest = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
        sources.append({
            "file": path.name,
            "bytes": path.stat().st_size,
            "sha256": digest.hexdigest(),
        })
    return {"feature_rows": feature_rows, "sources": sources}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Walk-forward backtest.")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--last-season", type=int, default=2025)
    parser.add_argument("--test-seasons", nargs="+", type=int,
                        default=[2023, 2024, 2025])
    parser.add_argument("--out", type=Path,
                        default=Path("models/backtests/baselines.json"))
    parser.add_argument("--transformer-root", type=Path, action="append", default=None,
                        help="e.g. models/transformer/v1 — adds the transformer entrant. "
                             "Repeatable: pass it more than once (e.g. "
                             "--transformer-root models/transformer/v1_s43 "
                             "--transformer-root models/transformer/v1_s44) to average "
                             "multiple seed artifacts as one ensembled entrant. A single "
                             "occurrence behaves exactly as before.")
    parser.add_argument("--xgb-median", action="store_true",
                        help="Also run the median-objective XGBoost entrant "
                             "(`xgboost_median`: pinball loss at q=0.5, the "
                             "transformer's p50 objective). The squared-error "
                             "`xgboost` entrant is unchanged and still runs.")
    parser.add_argument("--xgb-median-seeds", nargs="+", type=int, default=None,
                        help="Seeds the median entrant is fitted under (default: 0); "
                             "its stat lines are averaged across them (e.g. 0 1 2, "
                             "matching the transformer's 3-seed ensemble). Requires "
                             "--xgb-median. The `xgboost` entrant keeps xgb_seed 0 "
                             "so it stays comparable with the committed reports.")
    parser.add_argument("--paired-out", type=Path, default=None,
                        help="Also write a paired comparison of the transformer "
                             "against each XGBoost entrant, computed on the "
                             "identical harness rows (season-week cluster "
                             "bootstrap). Requires --transformer-root.")
    return parser


def xgb_provenance(entrant) -> dict:
    """What an XGBoost entrant's rows were trained with: its objective and
    the seed(s) behind it. Read off the entrant, so the record is what ran."""
    params = OBJECTIVES[entrant.objective]
    seeds = entrant.seeds if hasattr(entrant, "seeds") else [entrant.seed]
    return {
        "name": entrant.name,
        "objective": params["objective"],
        "quantile_alpha": params.get("quantile_alpha"),
        "seeds": list(seeds),
        "feature_set": entrant.feature_set,
    }


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.xgb_median_seeds is not None and not args.xgb_median:
        parser.error("--xgb-median-seeds sets the median entrant's seeds; "
                     "pass --xgb-median as well")
    if args.paired_out is not None:
        if args.transformer_root is None:
            parser.error("--paired-out compares the transformer with XGBoost; "
                         "pass --transformer-root as well")
        if args.paired_out.resolve() == args.out.resolve():
            parser.error("--paired-out must be a different file from --out")

    seasons = list(range(args.first_season, args.last_season + 1))
    weekly = pull_weekly(seasons, cache_dir=args.data_dir)
    schedules = pull_schedules(seasons, cache_dir=args.data_dir)
    features = build_features(weekly, schedules)

    xgb = XGBBaseline()
    xgb_entrants = [xgb]
    if args.xgb_median:
        xgb_entrants.append(XGBSeedAverage(args.xgb_median_seeds or [0], objective="median"))
    predictors = [NaiveLast4(), *xgb_entrants]
    if args.transformer_root is not None:
        from ffmodel.model.predictor import TransformerPredictor
        predictors.append(TransformerPredictor(args.transformer_root, features))
    if args.paired_out is not None:
        results, rows = run_backtest(features, predictors,
                                     test_seasons=args.test_seasons, return_rows=True)
    else:
        results = run_backtest(features, predictors, test_seasons=args.test_seasons)

    records = results.astype(object).where(pd.notna(results), None).to_dict(orient="records")
    provenance = {
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seasons": [args.first_season, args.last_season],
        "test_seasons": sorted(args.test_seasons),
        "scoring": "ppr",
        "band_construction": BAND_CONSTRUCTION,
        # provenance: which artifact roots the "transformer" rows scored —
        # a single root vs a seed ensemble is invisible from the metrics alone
        "transformer_roots": ([Path(r).as_posix() for r in args.transformer_root]
                              if args.transformer_root is not None else None),
        # provenance: which XGBoost feature set the "xgboost" rows consumed.
        # Read off the entrant rather than hardcoded, so the report records
        # what actually ran. This is exactly the thing that used to be
        # invisible -- feature resolution was implicit-on-presence, so a new
        # column joined the published baseline with no note in the record.
        "xgb_feature_set": xgb.feature_set,
        # provenance: XGBoost subsamples (subsample/colsample_bytree), so its
        # seed is part of the result, not an implementation detail. Measured:
        # seeds 0-3 on byte-identical data span ~0.012 OVERALL PPR MAE and up
        # to ~0.047 on the smallest per-position cell -- comparable to, or
        # larger than, every feature/vintage effect this project has chased.
        # Two reports are not comparable at that resolution unless the seed
        # matches, so it is recorded rather than assumed.
        "xgb_seed": xgb.seed,
        # provenance: the training objective and seed(s) behind every XGBoost
        # entrant's rows. The objective decides what the entrant predicts --
        # squared error is a MEAN predictor, which MAE scoring penalises
        # against the transformer's median (audit A2-1) -- and it used to be
        # recorded nowhere. `xgb_feature_set`/`xgb_seed` above stay as they
        # were and describe the `xgboost` entrant.
        "xgb_entrants": [xgb_provenance(e) for e in xgb_entrants],
        # provenance: which nflverse pull the whole report was computed from
        "data_vintage": data_vintage(args.data_dir, seasons, len(features)),
    }
    report = {**provenance, "results": records}
    report_text = json.dumps(report, indent=2)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(report_text)

    overall = results[results["position"] == "OVERALL"]
    print(overall.groupby("model")[["mae", "rmse"]].mean().round(3))
    print(f"\nfull report -> {args.out}")

    if args.paired_out is not None:
        # Hash of the in-memory report text (LF line endings), not of the bytes
        # read back from disk, so the digest does not depend on the platform's
        # newline translation.
        source = {"bakeoff_report": {
            "path": args.out.as_posix(),
            "sha256": hashlib.sha256(report_text.encode("utf-8")).hexdigest(),
        }}
        paired = build_paired_report(rows, "transformer",
                                     [e.name for e in reversed(xgb_entrants)],
                                     {**provenance, **source})
        args.paired_out.parent.mkdir(parents=True, exist_ok=True)
        args.paired_out.write_text(json.dumps(paired, indent=2, allow_nan=False))
        for comp in paired["comparisons"]:
            cell = comp["pooled"]
            print(f"{comp['challenger']} - {comp['baseline']}: "
                  f"{cell['mean_diff']:+.4f} {cell['ci95']} (n={cell['n']})")
        print(f"paired comparison -> {args.paired_out}")


if __name__ == "__main__":
    main()
