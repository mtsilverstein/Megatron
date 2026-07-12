"""Hyperparameter sweep runner for the quantile transformer.

TUNING PROTOCOL (binding): every combo in the grid trains and validates
ONLY on the base config's single walk-forward fold (train <= val_season-1,
val = val_season -- val_season 2022 for the default
configs/transformer_v1_through2022.yaml base). Held-out test seasons
2023-2025 are NEVER touched by model selection: this module does not
import or invoke anything under `ffmodel.eval` -- not the harness, not the
bake-off runner. Once a winner is picked from
models/sweeps/<version>/results.json, copy its params into
configs/transformer_v1*.yaml (all four walk-forward configs) and run it
through the normal 4-config bake-off separately (see the notebook).

RESUMABILITY (free, by construction): combos are expanded and iterated in
a fixed, deterministic order derived from the grid YAML's own key/value
order. Each combo trains via ffmodel.model.train.train_from_config, which
already (a) skips a combo whose metrics.json has {"complete": true} and
(b) auto-resumes a combo that was interrupted mid-training from its last
epoch checkpoint. So if a Kaggle/Colab/Studio Lab session is killed
mid-sweep, simply re-running the identical
`python -m ffmodel.model.sweep --grid ...` command continues exactly where
it left off -- no flags, no manual bookkeeping, no re-running of
already-finished combos.

A single combo's training failing outright (e.g. an out-of-memory error on
a large d_model) is caught and logged rather than aborting the whole sweep:
the remaining combos still run, and the failed one shows up in
results.json as an incomplete row so it's visible in the leaderboard
without losing every other combo's results. A killed *process* (the
Kaggle/Colab/session-cutoff case) is unaffected by this -- there is no
Python exception to catch -- and is handled purely by the resumability
above.

CLI: python -m ffmodel.model.sweep --grid configs/sweep_v1.yaml
     --features-parquet data/features_2012_2025.parquet
"""
from __future__ import annotations

import argparse
import copy
import gc
import itertools
import json
from pathlib import Path

import pandas as pd
import torch
import yaml

from ffmodel.model.train import train_from_config

_FORBIDDEN_GRID_KEYS = {"val_season", "first_season", "run_name", "out_root", "checkpoint_root"}

_NAME_ALIASES = {
    "seq_len": "seq",
    "model.d_model": "d",
    "model.n_layers": "l",
    "train.lr": "lr",
}

_BANNER = """\
=== hyperparameter sweep: {n} combo(s) ===
tuning protocol: train/val on val_season={val_season} ONLY (the base
config's single walk-forward fold). Held-out test seasons 2023-2025 are
never touched here -- this sweep does not import or run the eval harness.
Pick a winner from results.json, then bake it off separately.
resumable: combo order is deterministic -- rerun this exact command to
skip finished combos and auto-resume any interrupted one.
"""


def _validate_grid_keys(grid: dict) -> None:
    bad = _FORBIDDEN_GRID_KEYS & set(grid)
    if bad:
        raise ValueError(
            f"grid must not override {sorted(bad)}: the tuning protocol trains/"
            "validates on the base config's fold ONLY, and held-out test seasons "
            "are never touched by selection -- sweeping these keys would violate "
            "that (see this module's docstring)."
        )


def expand_grid(grid: dict) -> list[dict]:
    """Cartesian product over grid.values(), in the exact key order the grid
    dict declares (dict/YAML-mapping order preserved by yaml.safe_load), so
    repeated invocations over the same grid file always produce the same
    combo order -- this determinism is what makes a killed sweep
    resumable-for-free (train_from_config's own skip/auto-resume does the
    rest)."""
    keys = list(grid)
    value_lists = [grid[k] for k in keys]
    return [dict(zip(keys, values)) for values in itertools.product(*value_lists)]


def _short_key(key: str) -> str:
    return _NAME_ALIASES.get(key, key.rsplit(".", 1)[-1])


def _format_value(key: str, value) -> str:
    if isinstance(value, float):
        if "lr" in key.lower():
            return f"{value:.0e}"
        return str(value).replace(".", "p")
    return str(value)


def combo_run_name(combo: dict) -> str:
    """Deterministic, filesystem-safe name encoding a combo's params, e.g.
    {'seq_len': 8, 'model.d_model': 64, 'model.n_layers': 2,
    'train.lr': 3e-4} -> 'seq8_d64_l2_lr3e-04'. Component order follows the
    combo dict's own key order (the grid YAML's declared key order), so it
    is stable across runs of the same grid."""
    return "_".join(f"{_short_key(k)}{_format_value(k, v)}" for k, v in combo.items())


def apply_overrides(cfg: dict, combo: dict) -> dict:
    """Deep-copies `cfg` and applies each dotted-path override from `combo`
    (e.g. 'model.d_model' -> cfg['model']['d_model']). The input config is
    never mutated -- each combo gets its own independent dict, so combos
    can be built from the same base cfg without cross-contamination."""
    out = copy.deepcopy(cfg)
    for dotted_key, value in combo.items():
        *parents, leaf = dotted_key.split(".")
        node = out
        for p in parents:
            if not isinstance(node.get(p), dict):
                raise KeyError(
                    f"grid key {dotted_key!r} expects cfg[{p!r}] to already be "
                    f"a dict in the base config"
                )
            node = node[p]
        if leaf not in node:
            raise KeyError(
                f"grid key {dotted_key!r}: {leaf!r} not found in base cfg"
                f"[{'.'.join(parents) or '<root>'}] — a typo here would "
                f"silently sweep nothing for this parameter"
            )
        node[leaf] = value
    return out


def build_run_cfg(base_cfg: dict, combo: dict, out_root: Path) -> dict:
    """One combo's full training config: overrides applied, then run_name/
    out_root/checkpoint_root repointed under the grid's out_root so every
    combo's artifacts land at out_root/<run_name>/through<val_season>, with
    checkpoints at out_root/checkpoints/<run_name>_through<val_season> --
    never touching the base config's own out_root/checkpoint_root (which
    hold the committed production/bake-off artifacts)."""
    out_root = Path(out_root)
    cfg = apply_overrides(base_cfg, combo)
    cfg["run_name"] = combo_run_name(combo)
    cfg["out_root"] = str(out_root)
    cfg["checkpoint_root"] = str(out_root / "checkpoints")
    return cfg


def collect_results(out_root: Path, val_season: int, combos: list[dict]) -> list[dict]:
    """Reads each combo's metrics.json (if any) off disk and returns
    leaderboard rows sorted by val_pinball ascending (lower pinball loss is
    better). A combo that never started (no metrics.json at all) or was
    interrupted mid-training (metrics.json present but complete=False) is
    still included, with complete=False -- a partial sweep still produces a
    full accounting of what exists on disk, which is exactly what's needed
    after a killed session."""
    out_root = Path(out_root)
    rows = []
    for combo in combos:
        run_name = combo_run_name(combo)
        metrics_path = out_root / run_name / f"through{val_season}" / "metrics.json"
        val_pinball, best_epoch, complete = None, None, False
        if metrics_path.exists():
            try:
                metrics = json.loads(metrics_path.read_text())
            except (json.JSONDecodeError, OSError):
                metrics = {}
            val_pinball = metrics.get("val_pinball")
            best_epoch = metrics.get("best_epoch")
            complete = metrics.get("complete") is True
        rows.append({
            "run_name": run_name, "params": combo, "val_pinball": val_pinball,
            "best_epoch": best_epoch, "complete": complete,
        })
    rows.sort(key=lambda r: (
        r["val_pinball"] is None,
        r["val_pinball"] if r["val_pinball"] is not None else 0.0,
        r["run_name"],
    ))
    return rows


def write_results(path: Path, results: list[dict]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(results, indent=2))


def format_leaderboard(results: list[dict]) -> str:
    if not results:
        return "(no results)"
    header = f"{'rank':>4}  {'run_name':<28} {'val_pinball':>12} {'best_epoch':>10} {'complete':>8}"
    lines = [header, "-" * len(header)]
    for i, r in enumerate(results, 1):
        vp = f"{r['val_pinball']:.4f}" if r["val_pinball"] is not None else "—"
        be = str(r["best_epoch"]) if r["best_epoch"] is not None else "—"
        lines.append(f"{i:>4}  {r['run_name']:<28} {vp:>12} {be:>10} {str(r['complete']):>8}")
    return "\n".join(lines)


def _free_gpu_memory() -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def run_sweep(base_cfg: dict, grid: dict, out_root: Path, features: pd.DataFrame,
              *, train_fn=train_from_config) -> list[dict]:
    """Expand `grid` against `base_cfg`, train each combo in-process (via
    `train_fn`, defaulting to the real `train_from_config`), then write and
    return the leaderboard. See the module docstring for the binding tuning
    protocol and the resumability contract."""
    _validate_grid_keys(grid)
    val_season = base_cfg["val_season"]
    combos = expand_grid(grid)
    out_root = Path(out_root)
    print(_BANNER.format(n=len(combos), val_season=val_season))

    for combo in combos:
        cfg = build_run_cfg(base_cfg, combo, out_root)
        print(f"--- {cfg['run_name']} ---")
        try:
            train_fn(cfg, features)
        except Exception as exc:  # noqa: BLE001 -- one combo's failure must not sink the sweep
            print(f"WARNING: {cfg['run_name']} failed ({exc!r}) -- "
                  "continuing with remaining combos; rerun this command "
                  "later to retry it.")
        finally:
            _free_gpu_memory()

    results = collect_results(out_root, val_season, combos)
    write_results(out_root / "results.json", results)
    print(format_leaderboard(results))
    return results


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Hyperparameter sweep over the quantile transformer "
                     "(trains/validates on the base config's single fold "
                     "only -- see module docstring for the tuning protocol)."
    )
    parser.add_argument("--grid", type=Path, required=True,
                         help="Grid YAML: {base, out_root, grid: {dotted.key: [values]}}")
    parser.add_argument("--features-parquet", type=Path, default=None)
    args = parser.parse_args()

    grid_cfg = yaml.safe_load(args.grid.read_text())
    base_cfg = yaml.safe_load(Path(grid_cfg["base"]).read_text())
    out_root = Path(grid_cfg["out_root"])
    grid = grid_cfg["grid"]

    if args.features_parquet:
        features = pd.read_parquet(args.features_parquet)
    else:
        from ffmodel.data.features import build_features
        from ffmodel.data.pull import pull_schedules, pull_weekly
        seasons = list(range(base_cfg["first_season"], base_cfg["val_season"] + 1))
        features = build_features(pull_weekly(seasons, Path("data/raw")),
                                  pull_schedules(seasons, Path("data/raw")))

    run_sweep(base_cfg, grid, out_root, features)


if __name__ == "__main__":
    main()
