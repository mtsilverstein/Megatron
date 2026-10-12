"""Betting-lines feature screen driver: freeze, collect, evaluate, report.

Spec: docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md.

Three steps, each a CLI subcommand, run in order by the controller:

1. `snapshot` -- pull the raw nflverse schedule payload once into a private
   local parquet (never overwritten).
2. `freeze`   -- validate lines, build features from the frozen weekly and
   schedule caches, join the two line columns, write the complete ordered
   2012-2025 modeling frame to `data/` and its sha256 + the full run manifest
   to a committed JSON. No model is fitted.
3. `run`      -- read ONLY the frozen frame (hash- and schema-checked), fit
   2 arms x 3 seeds x 3 walk-forward folds, write paired row-level
   predictions/losses to `data/` and the result artifact (allow_nan=False).

`abandon` writes an `invalid` artifact for the effort cap (spec §10).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.data.features import LINE_FEATURE_COLUMNS, feature_columns
from ffmodel.data.lines import (
    LinesDataError,
    build_line_table,
    file_sha256,
    join_line_features,
    package_version,
    read_snapshot,
    snapshot_meta_path,
    snapshot_schedules,
)
from ffmodel.data.pull import POSITIONS
from ffmodel.eval.lines_stats import (
    ARMS,
    MATERIALITY,
    MAX_ATTEMPTS,
    MAX_DETERIORATION,
    MIN_CELL_PLAYERS,
    N_ACCEPT,
    PERCENTILE_METHOD,
    PERCENTILES,
    RANKING_VETO_BELOW,
    RELEVANT_MIN_PPR,
    RNG_SEED,
    SEASON_FLOOR,
    SEEDS,
    TEST_SEASONS,
    ScreenInvalid,
    evaluate,
    loss_differences,
    pred_col,
)
from ffmodel.eval.splits import walk_forward_splits
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

SPEC_PATH = "docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md"
FIRST_SEASON, LAST_SEASON = 2012, 2025
ARM_FEATURE_SETS = {"A": "v1", "B": "v1_lines"}
N_A_COLUMNS = 40
KEY_COLUMNS = ["player_id", "season", "week"]
META_COLUMNS = ["position", "team"]
# Spec §4: expected test rows (recorded; a mismatch is reported, not tuned away).
EXPECTED_TEST_ROWS = {2023: 5893, 2024: 5920, 2025: 6095}
# Must equal the regressor configuration hard-coded in XGBBaseline.fit
# (pinned by a test); random_state is the arm/seed's seed.
ESTIMATOR_CONFIG = {
    "n_estimators": 300, "max_depth": 5, "learning_rate": 0.05, "subsample": 0.8,
    "colsample_bytree": 0.8, "tree_method": "hist", "n_jobs": -1,
}
SCORING_CONFIG = {
    "construction": "common-component PPR",
    "actual": "fantasy_points(test[PREDICTED_STATS], PPR)",
    "pred": "fantasy_points(pred_stats[PREDICTED_STATS], PPR)",
    "components": PREDICTED_STATS,
    "pass_td": PPR.pass_td, "reception": PPR.reception,
    "excluded": ["two_point_conversions", "special_teams_tds", "passing_pick_sixes"],
    "predictions": "unclipped stat components; a non-finite component makes the run invalid",
}
TIMING_LABEL = (
    "Optimistic historical information screen. These are historical schedule lines, treated as "
    "closing-time context based on nflfastR's documentation of the related fields; their book and "
    "quote time are not recorded in the feed and their availability at our mid-week deadline is "
    "unverified. The screen admits information later than our publication deadline (injuries, "
    "lineup decisions, weather and market moves up to the close). A pass shows the information is "
    "worth chasing, not that a mid-week deployment would gain the same; it is never deployable "
    "performance. 'Optimistic' is a description, not a mathematical bound."
)


# --- frozen modeling frame (spec §8) --------------------------------------------

def arm_feature_lists(frame: pd.DataFrame) -> tuple[list[str], list[str]]:
    """(A, B) column lists; B must be exactly A + the two line columns."""
    a_cols = feature_columns(frame, ARM_FEATURE_SETS["A"])
    b_cols = feature_columns(frame, ARM_FEATURE_SETS["B"])
    if len(a_cols) != N_A_COLUMNS:
        raise ScreenInvalid(f"arm A resolved {len(a_cols)} columns, expected {N_A_COLUMNS}")
    if b_cols != a_cols + LINE_FEATURE_COLUMNS:
        raise ScreenInvalid("arm B list is not arm A + the two line columns in order")
    return a_cols, b_cols


def build_model_frame(joined: pd.DataFrame) -> pd.DataFrame:
    """The complete ordered modeling frame: keys, position, team, every A/B
    feature and every PREDICTED_STATS target -- nothing else. Rows sorted by
    (season, week, player_id); RangeIndex."""
    a_cols, b_cols = arm_feature_lists(joined)
    if joined[KEY_COLUMNS].isna().to_numpy().any():
        raise ScreenInvalid("null row key (player_id, season, week)")
    if joined.duplicated(KEY_COLUMNS).any():
        raise ScreenInvalid("duplicate row key (player_id, season, week)")
    if not set(joined["position"]) <= set(POSITIONS):
        raise ScreenInvalid(f"positions outside {POSITIONS}")
    seasons = joined["season"]
    if seasons.min() < FIRST_SEASON or seasons.max() > LAST_SEASON:
        raise ScreenInvalid(f"seasons outside {FIRST_SEASON}-{LAST_SEASON}")
    lead = KEY_COLUMNS + META_COLUMNS
    columns = lead + [c for c in b_cols if c not in lead] + PREDICTED_STATS
    frame = (joined[columns]
             .sort_values(["season", "week", "player_id"], kind="mergesort")
             .reset_index(drop=True))
    if feature_columns(frame, "v1") != a_cols or feature_columns(frame, "v1_lines") != b_cols:
        raise ScreenInvalid("feature lists changed when the frame was assembled")
    return frame


def frame_schema(frame: pd.DataFrame) -> list[dict]:
    return [{"name": c, "dtype": str(frame[c].dtype)} for c in frame.columns]


def write_frozen_frame(frame: pd.DataFrame, path: Path | str) -> dict:
    """Write once (never overwrite) and return {path, sha256, rows, schema}."""
    path = Path(path)
    if path.exists():
        raise FileExistsError(f"{path} exists; a frozen modeling frame is never overwritten")
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(path, index=False)
    return {"path": path.as_posix(), "sha256": file_sha256(path), "rows": int(len(frame)),
            "schema": frame_schema(frame)}


def read_frozen_frame(path: Path | str, expected_sha256: str, expected_schema: list[dict]) -> pd.DataFrame:
    actual = file_sha256(path)
    if actual != expected_sha256:
        raise ScreenInvalid(f"frozen frame {path} sha256 {actual} != manifest {expected_sha256}")
    frame = pd.read_parquet(path)
    if frame_schema(frame) != expected_schema:
        raise ScreenInvalid("frozen frame schema differs from the manifest")
    return frame


def assert_arms_paired(frame: pd.DataFrame) -> None:
    """Both arms see identical rows/indices/targets; B's matrix minus the two
    line columns is A's matrix exactly."""
    a = XGBBaseline(feature_set=ARM_FEATURE_SETS["A"])._matrix(frame)
    b = XGBBaseline(feature_set=ARM_FEATURE_SETS["B"])._matrix(frame)
    if list(b.columns) != list(a.columns) + LINE_FEATURE_COLUMNS:
        raise ScreenInvalid("arm matrices are not paired (column lists)")
    if not b.index.equals(a.index) or not b[list(a.columns)].equals(a):
        raise ScreenInvalid("arm matrices are not paired (non-line values)")


# --- row-level collector (spec §4) -----------------------------------------------

def make_xgb_predictor(arm: str, seed: int) -> XGBBaseline:
    return XGBBaseline(n_estimators=ESTIMATOR_CONFIG["n_estimators"], seed=seed,
                       feature_set=ARM_FEATURE_SETS[arm])


def collect_paired_predictions(frame: pd.DataFrame, seeds, test_seasons,
                               make_predictor=make_xgb_predictor) -> pd.DataFrame:
    """Per test row: keys, position, actual and one PPR point prediction per
    arm/seed (`pred_col`). Same walk-forward split and scoring contract as
    harness.run_backtest, including its prediction-index check."""
    parts = []
    for season, train_idx, test_idx in walk_forward_splits(frame, list(test_seasons)):
        train, test = frame.loc[train_idx], frame.loc[test_idx]
        if len(test) == 0 or len(train) == 0:
            raise ScreenInvalid(f"test season {season} has an empty train or test set")
        out = pd.DataFrame({
            "player_id": test["player_id"].to_numpy(), "season": test["season"].to_numpy(),
            "week": test["week"].to_numpy(), "position": test["position"].to_numpy(),
            "actual": fantasy_points(test[PREDICTED_STATS], PPR).to_numpy(),
        }, index=test.index)
        for arm in ARMS:
            for seed in seeds:
                predictor = make_predictor(arm, seed)
                predictor.fit(train)
                pred_stats = predictor.predict(test)
                if not pred_stats.index.equals(test.index):
                    raise ScreenInvalid(
                        f"{arm}/seed{seed}: prediction index misaligned with test frame")
                missing = [c for c in PREDICTED_STATS if c not in pred_stats.columns]
                if missing:
                    raise ScreenInvalid(f"{arm}/seed{seed}: missing predicted component(s) {missing}")
                values = pred_stats[PREDICTED_STATS].to_numpy(dtype=float)
                if not np.isfinite(values).all():
                    raise ScreenInvalid(
                        f"{arm}/seed{seed}: non-finite predicted component in season {season}")
                out[pred_col(arm, seed)] = fantasy_points(pred_stats[PREDICTED_STATS], PPR).to_numpy()
        parts.append(out)
    return pd.concat(parts)


# --- manifest / artifact -----------------------------------------------------------

def software_versions() -> dict:
    return {"python": platform.python_version(),
            **{name: package_version(name)
               for name in ("xgboost", "numpy", "pandas", "scipy", "pyarrow", "nflreadpy")}}


def resolved_estimator_params(seed: int = 0) -> dict:
    from xgboost import XGBRegressor

    params = XGBRegressor(**ESTIMATOR_CONFIG, random_state=seed).get_params()
    return {k: v for k, v in sorted(params.items())
            if v is not None and isinstance(v, (bool, int, float, str))}


def row_counts(frame: pd.DataFrame, test_seasons) -> dict:
    per_season = {int(s): int(n) for s, n in frame.groupby("season").size().items()}
    test = {int(s): {"rows": per_season.get(int(s), 0), "expected": EXPECTED_TEST_ROWS.get(int(s))}
            for s in test_seasons}
    total_test = sum(v["rows"] for v in test.values())
    return {
        "per_season": per_season,
        "test_rows": test,
        "test_rows_match_expected": all(v["rows"] == v["expected"] for v in test.values()),
        "per_arm_test_rows": {arm: total_test for arm in ARMS},
    }


def git_provenance(spec_path: str = SPEC_PATH) -> dict:
    def git(*args: str) -> str | None:
        try:
            return subprocess.run(["git", *args], capture_output=True, text=True,
                                  check=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return None

    status = git("status", "--porcelain", "--untracked-files=no")
    return {"spec": {"path": spec_path, "git_blob": git("rev-parse", f"HEAD:{spec_path}")},
            "implementation_commit": git("rev-parse", "HEAD"),
            "tracked_changes_uncommitted": None if status is None else bool(status)}


def _jsonable(obj):
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        return float(obj) if math.isfinite(obj) else None
    return obj


def refuse_existing(*paths: Path | str) -> None:
    """Raise FileExistsError naming every evidence path that already exists.

    A manifest, frozen frame, result artifact or paired-row file is written
    once. A defect rerun uses NEW manifest, frame, result and paired-row paths
    and keeps the earlier files (spec §7) -- even an earlier `invalid` result."""
    existing = [Path(p).as_posix() for p in paths if Path(p).exists()]
    if existing:
        raise FileExistsError(
            f"{existing} already exist(s); evidence files are never replaced -- "
            f"a rerun uses new manifest, frame, result and paired-row paths")


def write_json(payload: dict, path: Path | str) -> None:
    """Write an evidence JSON once: exclusive create ("x"), so an existing
    file raises FileExistsError and its bytes are untouched. Serialised
    before the file is opened, so a serialisation error leaves no file."""
    path = Path(path)
    text = json.dumps(_jsonable(payload), indent=2, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as fh:
        fh.write(text)


def invalid_artifact(reasons: list[str], manifest: dict | None, stage: str) -> dict:
    return {
        "screen": "lines_feature_screen",
        "timing_label": TIMING_LABEL,
        "manifest": manifest,
        "stage": stage,
        "point": None, "bootstrap": None, "relevant": None, "ranking": None,
        "decision": {"disposition": "invalid", "failure_label": None, "conditions": None,
                     "failed_conditions": None, "invalid_reasons": reasons},
        "consequences": {"buys_forward_shadow_test": False, "ranking_status": None,
                         "ranking_recommendation_forbidden": True,
                         "carry_into_forward_preregistration": None,
                         "site_change_authorized": False},
    }


def freeze_screen(raw_schedules: pd.DataFrame, features: pd.DataFrame, *,
                  frame_path: Path | str, manifest_path: Path | str,
                  artifact_path: Path | str, provenance: dict,
                  seasons=tuple(range(FIRST_SEASON, LAST_SEASON + 1)),
                  test_seasons=TEST_SEASONS, seeds=SEEDS) -> dict:
    """Validate + join lines, write the frozen frame and the manifest. On a
    fatal data error writes an `invalid` artifact instead and returns it.

    Refuses (FileExistsError) BEFORE any validation or write if the manifest,
    the artifact or the frame path already exists, so neither a successful nor
    a failing freeze can replace an earlier manifest or result."""
    refuse_existing(manifest_path, artifact_path, frame_path)
    try:
        team_lines, lines_report = build_line_table(raw_schedules, list(seasons))
        joined, join_report = join_line_features(features, team_lines)
        frame = build_model_frame(joined)
        a_cols, b_cols = arm_feature_lists(frame)
        assert_arms_paired(frame)
    except (LinesDataError, ScreenInvalid) as exc:
        artifact = invalid_artifact([str(exc)], provenance, stage="freeze")
        write_json(artifact, artifact_path)
        return artifact
    frozen = write_frozen_frame(frame, frame_path)
    try:    # the run reads the frame back from parquet: prove that round trip BEFORE the manifest
        read_frozen_frame(frozen["path"], frozen["sha256"], frozen["schema"])
    except ScreenInvalid as exc:
        raise RuntimeError(f"frozen frame parquet round trip failed; no manifest written: {exc}") from exc
    first = int(frame["season"].min())
    manifest = {
        "screen": "lines_feature_screen",
        "frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        **provenance,
        "lines_validation": lines_report,
        "line_join_by_season": join_report,
        "model_frame": frozen,
        "feature_lists": {"A": a_cols, "B": b_cols},
        "arms": {arm: {"feature_set": fs} for arm, fs in ARM_FEATURE_SETS.items()},
        "estimator": {"config": ESTIMATOR_CONFIG, "resolved_params": resolved_estimator_params(),
                      "per_component": PREDICTED_STATS},
        "scoring": SCORING_CONFIG,
        "software": software_versions(),
        "rows": row_counts(frame, test_seasons),
        "train_test_ranges": {int(s): {"train": [first, int(s) - 1], "test": int(s)}
                              for s in test_seasons},
        "seeds": [int(s) for s in seeds],
        "test_seasons": [int(s) for s in test_seasons],
        "rng": {"bit_generator": "numpy.random.PCG64", "seed": RNG_SEED,
                "draws": "integers(0, P, size=P) for players, then integers(0, k_S, size=k_S) "
                         "per season ascending",
                "n_accept": N_ACCEPT, "max_attempts": MAX_ATTEMPTS,
                "percentiles": list(PERCENTILES), "percentile_method": PERCENTILE_METHOD},
        "thresholds": {"materiality": MATERIALITY, "season_floor": SEASON_FLOOR,
                       "max_deterioration": MAX_DETERIORATION,
                       "relevant_min_ppr": RELEVANT_MIN_PPR,
                       "ranking_veto_below": RANKING_VETO_BELOW,
                       "min_cell_players": MIN_CELL_PLAYERS},
        "timing_label": TIMING_LABEL,
    }
    write_json(manifest, manifest_path)
    return manifest


def run_screen(manifest_path: Path | str, artifact_path: Path | str, paired_path: Path | str, *,
               make_predictor=make_xgb_predictor, n_accept: int | None = None,
               max_attempts: int | None = None) -> dict:
    """Fit/evaluate from the frozen frame only and write the artifact once.

    Seeds, test seasons and the bootstrap protocol come from the manifest;
    `n_accept`/`max_attempts` overrides exist for tests only (the CLI never
    passes them) and are recorded in the artifact when used."""
    artifact_path, paired_path = Path(artifact_path), Path(paired_path)
    refuse_existing(artifact_path, paired_path)
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    n_accept = manifest["rng"]["n_accept"] if n_accept is None else n_accept
    max_attempts = manifest["rng"]["max_attempts"] if max_attempts is None else max_attempts
    started = time.perf_counter()
    prov = git_provenance()
    run_info = {"started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                # HEAD at run time (the manifest commit, one after implementation_commit)
                # and whether tracked files were dirty -- recorded, never discarded.
                "run_commit": prov["implementation_commit"],
                "tracked_changes_uncommitted": prov["tracked_changes_uncommitted"],
                "software": software_versions()}
    try:
        mf = manifest["model_frame"]
        frame = read_frozen_frame(mf["path"], mf["sha256"], mf["schema"])
        a_cols, b_cols = arm_feature_lists(frame)
        if [a_cols, b_cols] != [manifest["feature_lists"]["A"], manifest["feature_lists"]["B"]]:
            raise ScreenInvalid("feature lists differ from the manifest")
        assert_arms_paired(frame)
        paired = collect_paired_predictions(frame, manifest["seeds"], manifest["test_seasons"],
                                            make_predictor=make_predictor)
    except ScreenInvalid as exc:
        artifact = invalid_artifact([str(exc)], manifest, stage="run")
        artifact["run"] = {**run_info, "runtime_seconds": time.perf_counter() - started}
        write_json(artifact, artifact_path)
        return artifact
    losses = loss_differences(paired, manifest["seeds"])
    paired_path.parent.mkdir(parents=True, exist_ok=True)
    pd.concat([paired, losses], axis=1).to_parquet(paired_path, index=True)
    result = evaluate(paired, manifest["seeds"], manifest["test_seasons"], n_accept=n_accept,
                      max_attempts=max_attempts, rng_seed=manifest["rng"]["seed"])
    artifact = {
        "screen": "lines_feature_screen",
        "timing_label": TIMING_LABEL,
        "manifest": manifest,
        "stage": "run",
        "run": {**run_info, "runtime_seconds": time.perf_counter() - started,
                "n_accept": n_accept, "max_attempts": max_attempts},
        "paired_rows": {"path": paired_path.as_posix(), "sha256": file_sha256(paired_path),
                        "rows": int(len(paired))},
        **result,
    }
    write_json(artifact, artifact_path)
    return artifact


# --- CLI ----------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Betting-lines feature screen (spec 2026-10-11).")
    sub = parser.add_subparsers(dest="command", required=True)
    snap = sub.add_parser("snapshot", help="pull + freeze the raw schedule payload (network)")
    snap.add_argument("--out", type=Path, default=Path("data/lines/schedules_raw_2012_2025.parquet"))
    freeze = sub.add_parser("freeze", help="validate, build and freeze the modeling frame")
    freeze.add_argument("--snapshot", type=Path, default=Path("data/lines/schedules_raw_2012_2025.parquet"))
    freeze.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    freeze.add_argument("--frame", type=Path, default=Path("data/lines/model_frame_2012_2025.parquet"))
    freeze.add_argument("--manifest", type=Path,
                        default=Path("models/diagnostics/lines_screen_manifest.json"))
    freeze.add_argument("--artifact", type=Path, default=Path("models/diagnostics/lines_screen.json"))
    run = sub.add_parser("run", help="fit both arms from the frozen frame and evaluate")
    run.add_argument("--manifest", type=Path,
                     default=Path("models/diagnostics/lines_screen_manifest.json"))
    run.add_argument("--artifact", type=Path, default=Path("models/diagnostics/lines_screen.json"))
    run.add_argument("--paired", type=Path, default=Path("data/lines/paired_rows.parquet"))
    abandon = sub.add_parser("abandon", help="record an invalid run (e.g. effort cap reached)")
    abandon.add_argument("--reason", required=True)
    abandon.add_argument("--manifest", type=Path, default=None)
    abandon.add_argument("--artifact", type=Path, default=Path("models/diagnostics/lines_screen.json"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    seasons = list(range(FIRST_SEASON, LAST_SEASON + 1))
    if args.command == "snapshot":
        meta = snapshot_schedules(seasons, args.out)
        print(json.dumps(meta, indent=2))
        return 0
    if args.command == "freeze":
        from ffmodel.data.features import build_features
        from ffmodel.data.pull import pull_schedules, pull_weekly
        from ffmodel.eval.run import data_vintage

        if os.environ.get("FFMODEL_CACHE_FROZEN") != "1":
            raise SystemExit("set FFMODEL_CACHE_FROZEN=1: freeze must read existing caches only")
        refuse_existing(args.manifest, args.artifact, args.frame)   # before reading any input
        meta = json.loads(snapshot_meta_path(args.snapshot).read_text(encoding="utf-8"))
        raw = read_snapshot(args.snapshot, meta["sha256"])
        weekly = pull_weekly(seasons, cache_dir=args.data_dir)
        schedules = pull_schedules(seasons, cache_dir=args.data_dir)
        features = build_features(weekly, schedules)
        provenance = {**git_provenance(), "schedule_snapshot": meta,
                      "source_data_vintage": data_vintage(args.data_dir, seasons, len(features))}
        out = freeze_screen(raw, features, frame_path=args.frame, manifest_path=args.manifest,
                            artifact_path=args.artifact, provenance=provenance)
        if out.get("decision", {}).get("disposition") == "invalid":
            print(f"INVALID at freeze: {out['decision']['invalid_reasons']} -> {args.artifact}")
            return 2
        print(f"frozen: {out['model_frame']['path']} sha256={out['model_frame']['sha256']} "
              f"rows={out['rows']['test_rows']} -> {args.manifest}")
        return 0
    if args.command == "run":
        out = run_screen(args.manifest, args.artifact, args.paired)
        d = out["decision"]
        print(f"disposition={d['disposition']} label={d['failure_label']} "
              f"failed={d['failed_conditions']} reasons={d['invalid_reasons']} "
              f"ranking={out['consequences']['ranking_status']} -> {args.artifact}")
        return 0 if d["disposition"] != "invalid" else 2
    # abandon: an existing artifact is the record -- preserve and report it.
    if args.artifact.exists():
        raise SystemExit(f"{args.artifact} exists; not overwriting -- preserve and report it")
    if args.manifest is not None and not args.manifest.exists():
        raise SystemExit(f"{args.manifest} does not exist; omit --manifest before a successful freeze")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8")) if args.manifest else None
    write_json(invalid_artifact([args.reason], manifest, stage="abandon"), args.artifact)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
