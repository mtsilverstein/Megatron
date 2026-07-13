"""Config-driven, resumable training. Checkpoints every epoch (Studio Lab
sessions die at 4h; a cutoff must lose nothing)."""
from __future__ import annotations

import argparse
import json
import random
import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import yaml
from torch.utils.data import DataLoader, TensorDataset

from ffmodel.model.dataset import (
    CTX_FEATURES, SEQ_FEATURES, apply_scaler, build_sequences, fit_scaler, subset,
)
from ffmodel.model.net import QuantileTransformer, pinball_loss
from ffmodel.scoring import PREDICTED_STATS


def _seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def _loader(data, batch_size: int, shuffle: bool, seed: int) -> DataLoader:
    ds = TensorDataset(torch.from_numpy(data.x_seq), torch.from_numpy(data.x_ctx),
                       torch.from_numpy(data.pad_mask), torch.from_numpy(data.y))
    gen = torch.Generator().manual_seed(seed)
    return DataLoader(ds, batch_size=batch_size, shuffle=shuffle, generator=gen)


def _epoch(model, loader, quantiles, device, optimizer=None, grad_clip=1.0,
           amp_scaler=None):
    training = optimizer is not None
    use_amp = amp_scaler is not None and device == "cuda"  # fp16 on the T4 (spec §5)
    model.train(training)
    total, count = 0.0, 0
    with torch.set_grad_enabled(training):
        for x_seq, x_ctx, pad, y in loader:
            x_seq, x_ctx = x_seq.to(device), x_ctx.to(device)
            pad, y = pad.to(device), y.to(device)
            with torch.autocast(device_type="cuda", enabled=use_amp):
                pred = model(x_seq, x_ctx, pad)
                loss = pinball_loss(pred, y, quantiles)
            if training:
                optimizer.zero_grad()
                if use_amp:
                    amp_scaler.scale(loss).backward()
                    amp_scaler.unscale_(optimizer)
                    torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
                    amp_scaler.step(optimizer)
                    amp_scaler.update()
                else:
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
                    optimizer.step()
            total += loss.item() * len(y)
            count += len(y)
    return total / count


def _prepare_data(cfg: dict, features: pd.DataFrame):
    """Build sequences over the whole window so val histories span prior
    seasons (matching inference); split by target-row season afterwards.
    Leak-free: a train row's history is strictly prior to its own week,
    hence entirely earlier than val_season."""
    val_season = cfg["val_season"]
    window = features[(features["season"] >= cfg["first_season"])
                      & (features["season"] <= val_season)]
    raw = build_sequences(window, cfg["seq_len"])
    train_mask = (raw.meta["season"] < val_season).to_numpy()
    val_mask = (raw.meta["season"] == val_season).to_numpy()
    raw_train, raw_val = subset(raw, train_mask), subset(raw, val_mask)
    scaler = fit_scaler(raw_train)          # train rows only — leak-freedom
    return apply_scaler(raw_train, scaler), apply_scaler(raw_val, scaler), scaler


def _assert_safe_to_delete(target: Path, root: Path, run_name) -> None:
    """Guard for --fresh's destructive deletes (rmtree of art_dir, unlink
    under ckpt_dir): both paths are composed from cfg['run_name'], so a
    blank, whitespace, or path-traversing/absolute run_name could otherwise
    collapse the composed path onto — or escape entirely outside — the
    configured root before we recursively delete it. Refuse instead of
    risking that."""
    if not isinstance(run_name, str) or not run_name.strip():
        raise ValueError(
            f"refusing to delete under {root}: cfg['run_name'] must be a "
            f"non-empty string, got {run_name!r}"
        )
    root_r, target_r = root.resolve(), target.resolve()
    if target_r == root_r or not target_r.is_relative_to(root_r):
        raise ValueError(
            f"refusing to delete {target_r}: not a strict descendant of "
            f"{root_r} (check cfg['run_name']={run_name!r})"
        )


def _run_is_complete(metrics_path: Path) -> bool:
    """True only for an explicit {"complete": true} marker — never inferred
    from epoch counts, so a process killed mid-run (Studio Lab session
    cutoff) is never mistaken for a finished one, even if metrics.json was
    left mid-write."""
    if not metrics_path.exists():
        return False
    try:
        return json.loads(metrics_path.read_text()).get("complete") is True
    except (json.JSONDecodeError, OSError):
        return False


def _cfg_matches_saved(cfg: dict, art_dir: Path) -> bool:
    """True iff `art_dir/config.yaml` exists, parses, and matches `cfg`
    exactly. Both sides are compared AFTER an identical yaml dump/load
    round-trip: the saved file was itself produced by `yaml.safe_dump(cfg)`
    (see the post-epoch artifact write below), so re-parsing the current
    cfg through the same dump/load keeps the comparison well-defined even
    for values (e.g. floats) that yaml's loader could in principle
    normalize differently than Python's native equality would expect.
    Returns False (never raises) when the file is missing or fails to
    parse -- a missing/corrupt saved config is treated as 'config changed'
    rather than silently trusted, since there is nothing safe to resume
    onto."""
    saved_path = art_dir / "config.yaml"
    if not saved_path.exists():
        return False
    try:
        saved_cfg = yaml.safe_load(saved_path.read_text())
    except yaml.YAMLError:
        return False
    current_cfg = yaml.safe_load(yaml.safe_dump(cfg))
    return saved_cfg == current_cfg


def train_from_config(cfg: dict, features: pd.DataFrame, resume: bool = False,
                       fresh: bool = False) -> Path:
    """`resume` is accepted only for backward compatibility: resuming from an
    incomplete checkpoint now happens automatically whenever one exists, so
    `resume` is a no-op alias of that default. Pass `fresh=True` to discard
    any existing checkpoint/artifact for this run and train from scratch."""
    val_season = cfg["val_season"]
    ckpt_dir = Path(cfg["checkpoint_root"]) / f"{cfg['run_name']}_through{val_season}"
    latest = ckpt_dir / "latest.pt"
    art_dir = Path(cfg["out_root"]) / cfg["run_name"] / f"through{val_season}"
    metrics_path = art_dir / "metrics.json"
    run_id = art_dir.name

    is_complete = _run_is_complete(metrics_path)
    # A checkpoint's optimizer/RNG state (and a completed run's weights) are
    # only resumable/valid under the SAME cfg that produced them. Only ask
    # the question when there IS a prior run to compare against (a
    # completed marker or a checkpoint) -- a brand-new run has no saved
    # config to mismatch against and must not print a "config changed"
    # notice about a run that never existed.
    has_prior_run = is_complete or latest.exists()
    config_stale = has_prior_run and not _cfg_matches_saved(cfg, art_dir)
    if config_stale and not fresh:
        print(f"{run_id}: config changed since artifact was built — retraining fresh")
    fresh = fresh or config_stale  # same deletion path as an explicit --fresh; see below

    if fresh:
        _assert_safe_to_delete(ckpt_dir, Path(cfg["checkpoint_root"]), cfg.get("run_name"))
        _assert_safe_to_delete(art_dir, Path(cfg["out_root"]), cfg.get("run_name"))
        if latest.exists():
            latest.unlink()
        if art_dir.exists():
            shutil.rmtree(art_dir)
    elif is_complete:
        print(f"{run_id}: already complete — skipping (use --fresh to retrain)")
        return art_dir

    _seed_everything(cfg["seed"])
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda":
        try:  # preflight: modern torch wheels drop old GPU archs (e.g. Kaggle's
            # P100 is sm_60 Pascal) and only fail at the first kernel launch
            (torch.zeros(1, device=device) + 1).item()
        except RuntimeError as exc:
            raise RuntimeError(
                f"CUDA preflight failed on {torch.cuda.get_device_name(0)}: this "
                "PyTorch build has no kernels for the GPU's architecture. On "
                "Kaggle, pick a T4 accelerator instead of the P100."
            ) from exc
    quantiles = tuple(cfg["quantiles"])

    train_data, val_data, scaler = _prepare_data(cfg, features)

    model = QuantileTransformer(
        n_seq_features=len(SEQ_FEATURES), n_ctx_features=len(CTX_FEATURES),
        max_seq_len=cfg["seq_len"], n_stats=len(PREDICTED_STATS),
        n_quantiles=len(quantiles), **cfg["model"],
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=cfg["train"]["lr"],
                                  weight_decay=cfg["train"]["weight_decay"])
    amp_scaler = (torch.amp.GradScaler("cuda")
                  if device == "cuda" and cfg["train"].get("amp", True) else None)
    # amp_scaler state is intentionally not checkpointed: after a resume it
    # re-warms within a few steps, which costs less than it complicates.

    ckpt_dir.mkdir(parents=True, exist_ok=True)

    start_epoch, best_val, bad = 1, float("inf"), 0
    if (not fresh) and latest.exists():
        state = torch.load(latest, map_location=device, weights_only=False)
        model.load_state_dict(state["model_state"])
        optimizer.load_state_dict(state["optimizer_state"])
        start_epoch = state["epoch"] + 1
        best_val, bad = state["best_val"], state["bad_epochs"]
        torch.set_rng_state(state["torch_rng"].cpu())  # set_rng_state needs CPU; map_location relocates it
        np.random.set_state(state["numpy_rng"])
        # resume is bit-lossless on CPU; on CUDA it is deterministic modulo nondeterministic kernels.
        if state.get("cuda_rng") is not None and torch.cuda.is_available():
            torch.cuda.set_rng_state_all([t.cpu() for t in state["cuda_rng"]])
        print(f"{run_id}: resuming from checkpoint {latest} at epoch {state['epoch']}")

    val_loader = _loader(val_data, cfg["train"]["batch_size"], False, cfg["seed"])

    last_epoch = start_epoch - 1
    for epoch in range(start_epoch, cfg["train"]["epochs"] + 1):
        last_epoch = epoch
        train_loader = _loader(train_data, cfg["train"]["batch_size"], True,
                               cfg["seed"] + epoch)  # per-epoch seed: resume-stable order
        train_loss = _epoch(model, train_loader, quantiles, device,
                            optimizer, cfg["train"]["grad_clip"], amp_scaler)
        val_loss = _epoch(model, val_loader, quantiles, device)
        print(f"epoch {epoch}: train {train_loss:.4f}  val {val_loss:.4f}")
        if val_loss < best_val:
            best_val, bad = val_loss, 0
            art_dir.mkdir(parents=True, exist_ok=True)
            torch.save(model.state_dict(), art_dir / "model.pt")
            scaler.save(art_dir / "scaler.json")
            (art_dir / "config.yaml").write_text(yaml.safe_dump(cfg))
            (art_dir / "metrics.json").write_text(json.dumps({
                "val_season": val_season, "best_epoch": epoch,
                "last_epoch": epoch, "val_pinball": val_loss,
                "quantiles": list(quantiles), "seq_len": cfg["seq_len"],
                "n_seq_features": len(SEQ_FEATURES),
                "n_ctx_features": len(CTX_FEATURES), "model": cfg["model"],
                "complete": False,  # only the post-loop write below marks completion
            }, indent=2))
        else:
            bad += 1
        torch.save({
            "epoch": epoch, "model_state": model.state_dict(),
            "optimizer_state": optimizer.state_dict(), "best_val": best_val,
            "bad_epochs": bad, "torch_rng": torch.get_rng_state(),
            "numpy_rng": np.random.get_state(),
            "cuda_rng": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None,
        }, latest)
        if bad >= cfg["train"]["patience"]:
            print(f"early stop at epoch {epoch}")
            break
    # keep last_epoch current even when the best artifact is older; this is
    # the FINAL metrics.json write for the run, so it alone sets complete.
    if metrics_path.exists():
        metrics = json.loads(metrics_path.read_text())
        metrics["last_epoch"] = last_epoch
        metrics["complete"] = True
        metrics_path.write_text(json.dumps(metrics, indent=2))
    return art_dir


def apply_seed_override(cfg: dict, seed: int | None) -> dict:
    """Pure helper for the CLI's --seed flag: overrides cfg['seed'] and
    appends '_s{seed}' to run_name so a seed-ensemble member lands in a
    sibling artifact directory (e.g. v1_s43/through2025) instead of
    colliding with the unsuffixed default run. Returns `cfg` unchanged
    (same object, true no-op) when `seed` is None, so the default (no
    --seed flag) path and its existing artifact layout are byte-identical
    to before this flag existed. Never mutates its input when seed is not
    None -- returns a shallow copy instead, since only top-level keys
    change."""
    if seed is None:
        return cfg
    cfg = dict(cfg)
    cfg["seed"] = seed
    cfg["run_name"] = f"{cfg['run_name']}_s{seed}"
    return cfg


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Train the quantile transformer.")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--resume", action="store_true",
                         help="Accepted for backward compatibility; resuming from an "
                              "incomplete checkpoint now happens automatically, so this "
                              "flag is a no-op.")
    parser.add_argument("--fresh", action="store_true",
                         help="Discard any existing checkpoint/artifact for this run "
                              "and train from scratch, even if it was already complete.")
    parser.add_argument("--features-parquet", type=Path, default=None)
    parser.add_argument("--seed", type=int, default=None,
                         help="Override cfg['seed'] and suffix run_name with '_s{seed}' "
                              "(e.g. v1_s43) so a seed-ensemble member's artifacts land "
                              "in a sibling directory instead of overwriting the default "
                              "run. Omit for the default (unsuffixed) artifact path -- "
                              "existing layouts are unaffected.")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    cfg = yaml.safe_load(args.config.read_text())
    cfg = apply_seed_override(cfg, args.seed)
    if args.features_parquet:
        features = pd.read_parquet(args.features_parquet)
    else:
        from ffmodel.data.features import build_features
        from ffmodel.data.pull import pull_schedules, pull_weekly
        seasons = list(range(cfg["first_season"], cfg["val_season"] + 1))
        features = build_features(pull_weekly(seasons, Path("data/raw")),
                                  pull_schedules(seasons, Path("data/raw")))
    art = train_from_config(cfg, features, resume=args.resume, fresh=args.fresh)
    print(f"artifact -> {art}")


if __name__ == "__main__":
    main()
