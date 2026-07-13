import json

import numpy as np
import pandas as pd
import pytest
import torch
import yaml

import ffmodel.model.train as train_mod
from ffmodel.data.features import build_features
from ffmodel.model.train import train_from_config

from tests.test_features import make_schedules, make_weekly


def _synthetic_features(n_players=12, seasons=(2020, 2021, 2022), extra_rows=None):
    rng = np.random.default_rng(0)
    rows = []
    for season in seasons:
        for week in range(1, 11):
            for p in range(n_players):
                rows.append({
                    "player_id": f"p{p}", "season": season, "week": week,
                    "position": ["QB", "RB", "WR", "TE"][p % 4],
                    "receiving_yards": float(rng.integers(0, 120)),
                    "receptions": float(rng.integers(0, 10)),
                })
    if extra_rows:
        rows.extend(extra_rows)
    sched = pd.concat([make_schedules(10, s) for s in seasons])
    return build_features(make_weekly(rows), sched)


def _cfg(tmp_path, epochs=2, dropout=0.0):
    return {
        "run_name": "testrun", "seed": 0, "seq_len": 8, "val_season": 2022,
        "first_season": 2020, "quantiles": [0.1, 0.5, 0.9],
        "model": {"d_model": 16, "n_heads": 2, "n_layers": 1, "dropout": dropout},
        "train": {"batch_size": 64, "lr": 1e-3, "weight_decay": 0.0,
                  "epochs": epochs, "patience": 10, "grad_clip": 1.0},
        "out_root": str(tmp_path / "artifacts"),
        "checkpoint_root": str(tmp_path / "ckpt"),
    }


def test_training_produces_artifact_contract(tmp_path):
    features = _synthetic_features()
    art = train_from_config(_cfg(tmp_path), features)
    assert art.name == "through2022"
    for f in ("model.pt", "config.yaml", "scaler.json", "metrics.json"):
        assert (art / f).exists(), f
    import json
    metrics = json.loads((art / "metrics.json").read_text())
    assert metrics["val_season"] == 2022
    assert np.isfinite(metrics["val_pinball"])


def _interrupt_after_epoch(monkeypatch, n_epochs_to_complete: int):
    """Monkeypatch train_mod._epoch so it raises partway through the epoch
    AFTER `n_epochs_to_complete` full epochs (train+val) have run — this
    mirrors a Studio Lab session getting killed mid-epoch: the checkpoint
    from the last completed epoch survives, but train_from_config never
    reaches its post-loop 'complete' write. Returns the monkeypatch context
    manager (caller uses it as a `with` block)."""
    orig_epoch = train_mod._epoch
    calls_per_epoch = 2  # one _epoch call for train, one for val
    boom_at = n_epochs_to_complete * calls_per_epoch + 1
    state = {"n": 0}

    def _flaky(*args, **kwargs):
        state["n"] += 1
        if state["n"] == boom_at:
            raise RuntimeError("simulated Studio Lab session cutoff")
        return orig_epoch(*args, **kwargs)

    monkeypatch.setattr(train_mod, "_epoch", _flaky)


def test_resume_continues_from_checkpoint(tmp_path, monkeypatch):
    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=2)

    with pytest.MonkeyPatch.context() as mp:
        _interrupt_after_epoch(mp, n_epochs_to_complete=1)
        with pytest.raises(RuntimeError, match="simulated Studio Lab session cutoff"):
            train_from_config(cfg, features)

    ckpt_dir = train_mod.Path(cfg["checkpoint_root"]) / f"{cfg['run_name']}_through{cfg['val_season']}"
    assert (ckpt_dir / "latest.pt").exists()
    art_dir = train_mod.Path(cfg["out_root"]) / cfg["run_name"] / "through2022"
    metrics_after_interrupt = json.loads((art_dir / "metrics.json").read_text())
    assert metrics_after_interrupt.get("complete") is not True  # not marked complete

    # No --resume passed: auto-resume must kick in by default.
    art = train_from_config(cfg, features)
    metrics = json.loads((art / "metrics.json").read_text())
    assert metrics["last_epoch"] == 2  # continued, not restarted
    assert metrics["complete"] is True


def test_seeded_determinism(tmp_path):
    features = _synthetic_features()
    import json
    m = []
    for sub in ("a", "b"):
        cfg = _cfg(tmp_path)
        cfg["out_root"] = str(tmp_path / sub)
        cfg["checkpoint_root"] = str(tmp_path / sub / "ckpt")
        art = train_from_config(cfg, features)
        m.append(json.loads((art / "metrics.json").read_text())["val_pinball"])
    assert m[0] == pytest.approx(m[1])


def test_resume_matches_uninterrupted_run(tmp_path, monkeypatch):
    """Pinned equivalence test for the resume path's global-RNG restore.
    dropout must be > 0 here: with dropout=0.0 the training forward pass
    never calls into torch's global RNG (verified: F.dropout(p=0) is a
    no-op on the RNG state), so a resumed run would match an uninterrupted
    one bit-for-bit even if the torch.set_rng_state/np.random.set_state
    restore lines in train.py's resume path were deleted. dropout=0.1 makes
    the forward pass consume global torch RNG every training step, so the
    restore is actually load-bearing for this assertion."""
    features = _synthetic_features()
    cfg_a = _cfg(tmp_path, epochs=2, dropout=0.1)
    cfg_a["out_root"] = str(tmp_path / "a")
    cfg_a["checkpoint_root"] = str(tmp_path / "a" / "ckpt")
    art_a = train_from_config(cfg_a, features)

    cfg_b = _cfg(tmp_path, epochs=2, dropout=0.1)
    cfg_b["out_root"] = str(tmp_path / "b")
    cfg_b["checkpoint_root"] = str(tmp_path / "b" / "ckpt")

    with pytest.MonkeyPatch.context() as mp:
        _interrupt_after_epoch(mp, n_epochs_to_complete=1)
        with pytest.raises(RuntimeError, match="simulated Studio Lab session cutoff"):
            train_from_config(cfg_b, features)

    # resume=True kept as an accepted (now no-op) flag for back-compat.
    art_b = train_from_config(cfg_b, features, resume=True)

    ma = json.loads((art_a / "metrics.json").read_text())
    mb = json.loads((art_b / "metrics.json").read_text())
    assert mb["val_pinball"] == pytest.approx(ma["val_pinball"])
    assert mb["best_epoch"] == ma["best_epoch"]

    # Belt-and-suspenders: exact tensor equality on the saved weights, not
    # just an approx on a scalar metric that could coincidentally match.
    state_a = torch.load(art_a / "model.pt", weights_only=True)
    state_b = torch.load(art_b / "model.pt", weights_only=True)
    for key in state_a:
        assert torch.equal(state_a[key], state_b[key]), key


def test_val_sequences_span_prior_seasons(tmp_path):
    from ffmodel.model.train import _prepare_data

    features = _synthetic_features()          # seasons 2020-2022
    train_data, val_data, scaler = _prepare_data(_cfg(tmp_path), features)
    assert (train_data.meta["season"] < 2022).all()
    assert (val_data.meta["season"] == 2022).all()
    # a week-1 val row must carry prior-season history, not all padding
    wk1 = (val_data.meta["week"] == 1).to_numpy()
    assert wk1.any()
    assert not val_data.pad_mask[wk1].all()


def test_completed_run_is_skipped_by_default(tmp_path, monkeypatch, capsys):
    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=1)
    art = train_from_config(cfg, features)
    metrics_before = json.loads((art / "metrics.json").read_text())
    assert metrics_before["complete"] is True
    before_text = (art / "metrics.json").read_text()

    def _boom_epoch(*args, **kwargs):
        raise AssertionError("training must not run for an already-complete artifact")

    def _boom_prepare(*args, **kwargs):
        raise AssertionError("data must not be prepared for an already-complete artifact")

    monkeypatch.setattr(train_mod, "_epoch", _boom_epoch)
    monkeypatch.setattr(train_mod, "_prepare_data", _boom_prepare)

    capsys.readouterr()  # drain output from the first run
    art2 = train_from_config(cfg, features)

    assert art2 == art
    assert (art / "metrics.json").read_text() == before_text  # untouched
    out = capsys.readouterr().out
    assert "already complete" in out
    assert "skipping" in out
    assert "--fresh" in out


def test_completed_run_with_changed_lr_retrains(tmp_path, monkeypatch, capsys):
    """A completed run whose config.yaml no longer matches the CURRENT cfg
    (e.g. train.lr was edited after this artifact was built) must retrain
    from scratch rather than silently skip -- skipping here would mean the
    new hyperparameter is never actually used."""
    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=1)
    art = train_from_config(cfg, features)
    metrics_before = json.loads((art / "metrics.json").read_text())
    assert metrics_before["complete"] is True

    calls = {"n": 0}
    orig_epoch = train_mod._epoch

    def _counting(*args, **kwargs):
        calls["n"] += 1
        return orig_epoch(*args, **kwargs)

    monkeypatch.setattr(train_mod, "_epoch", _counting)

    cfg2 = dict(cfg)
    cfg2["train"] = dict(cfg["train"])
    cfg2["train"]["lr"] = 5e-3  # changed since the completed artifact was built

    capsys.readouterr()
    art2 = train_from_config(cfg2, features)
    out = capsys.readouterr().out

    assert calls["n"] > 0  # training actually ran -- it was not skipped
    assert "config changed" in out
    assert art2 == art
    new_cfg = yaml.safe_load((art2 / "config.yaml").read_text())
    assert new_cfg["train"]["lr"] == 5e-3


def test_interrupted_run_with_changed_cfg_does_not_resume(tmp_path, monkeypatch, capsys):
    """An interrupted checkpoint whose saved config no longer matches the
    CURRENT cfg must not be resumed -- its optimizer/RNG state was built
    under the OLD hyperparameters. It must retrain from epoch 1 instead."""
    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=2)

    with pytest.MonkeyPatch.context() as mp:
        _interrupt_after_epoch(mp, n_epochs_to_complete=1)
        with pytest.raises(RuntimeError, match="simulated Studio Lab session cutoff"):
            train_from_config(cfg, features)

    ckpt_dir = train_mod.Path(cfg["checkpoint_root"]) / f"{cfg['run_name']}_through{cfg['val_season']}"
    assert (ckpt_dir / "latest.pt").exists()

    cfg2 = dict(cfg)
    cfg2["train"] = dict(cfg["train"])
    cfg2["train"]["lr"] = 5e-3  # changed since the interrupted checkpoint was built

    calls = {"n": 0}
    orig_epoch = train_mod._epoch

    def _counting(*args, **kwargs):
        calls["n"] += 1
        return orig_epoch(*args, **kwargs)

    monkeypatch.setattr(train_mod, "_epoch", _counting)
    capsys.readouterr()
    art2 = train_from_config(cfg2, features)
    out = capsys.readouterr().out

    assert "config changed" in out
    # 2 epochs * (train + val) = 4 _epoch calls: restarted at epoch 1, not
    # resumed at epoch 2 (which would be only 2 calls).
    assert calls["n"] == 4
    metrics = json.loads((art2 / "metrics.json").read_text())
    assert metrics["last_epoch"] == 2
    assert metrics["complete"] is True


def test_cfg_roundtrips_through_yaml_without_changing_floats(tmp_path):
    """Guards the config-match comparison against a false-mismatch loop: if
    yaml dump->load ever perturbed a float (e.g. 1.0e-3 becoming something
    that compares unequal), every invocation of train_from_config would see
    its own just-written config.yaml as a 'mismatch' and retrain forever."""
    cfg = _cfg(tmp_path)
    cfg["train"]["lr"] = 1.0e-3
    cfg["train"]["weight_decay"] = 0.01
    cfg["model"]["dropout"] = 0.1
    dumped = yaml.safe_dump(cfg)
    reloaded = yaml.safe_load(dumped)
    assert reloaded == cfg


def test_interrupted_run_is_not_skipped(tmp_path, monkeypatch):
    """A checkpoint without a completion marker must never be treated as
    complete — this is the guard against silently skipping a genuinely
    interrupted Studio Lab run."""
    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=2)

    with pytest.MonkeyPatch.context() as mp:
        _interrupt_after_epoch(mp, n_epochs_to_complete=1)
        with pytest.raises(RuntimeError, match="simulated Studio Lab session cutoff"):
            train_from_config(cfg, features)

    calls = {"n": 0}
    orig_epoch = train_mod._epoch

    def _counting(*args, **kwargs):
        calls["n"] += 1
        return orig_epoch(*args, **kwargs)

    monkeypatch.setattr(train_mod, "_epoch", _counting)
    train_from_config(cfg, features)
    assert calls["n"] > 0  # training actually ran — it was not skipped


def test_fresh_flag_forces_retrain_even_when_complete(tmp_path, monkeypatch, capsys):
    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=2)
    art = train_from_config(cfg, features)
    metrics_before = json.loads((art / "metrics.json").read_text())
    assert metrics_before["complete"] is True

    ckpt_dir = train_mod.Path(cfg["checkpoint_root"]) / f"{cfg['run_name']}_through2022"
    latest = ckpt_dir / "latest.pt"
    assert torch.load(latest, weights_only=False)["epoch"] == 2

    calls = {"n": 0}
    orig_epoch = train_mod._epoch

    def _counting(*args, **kwargs):
        calls["n"] += 1
        return orig_epoch(*args, **kwargs)

    monkeypatch.setattr(train_mod, "_epoch", _counting)
    capsys.readouterr()
    art2 = train_from_config(cfg, features, fresh=True)
    out = capsys.readouterr().out

    assert "already complete" not in out
    # 2 epochs * (train + val) = 4 _epoch calls: retrained from epoch 1, not skipped/resumed.
    assert calls["n"] == 4
    metrics_after = json.loads((art2 / "metrics.json").read_text())
    assert metrics_after["complete"] is True
    assert metrics_after["last_epoch"] == 2


def test_fresh_with_empty_run_name_raises_and_deletes_nothing(tmp_path):
    """--fresh's deletion block must refuse to act on a blank/garbage
    run_name instead of composing a bogus, possibly-escaping path and
    rmtree-ing it. Plant decoys in both roots and confirm they survive."""
    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=1)
    cfg["run_name"] = ""

    out_root = train_mod.Path(cfg["out_root"])
    ckpt_root = train_mod.Path(cfg["checkpoint_root"])
    out_root.mkdir(parents=True, exist_ok=True)
    ckpt_root.mkdir(parents=True, exist_ok=True)
    decoy_out = out_root / "decoy.txt"
    decoy_ckpt = ckpt_root / "decoy.txt"
    decoy_out.write_text("keep me")
    decoy_ckpt.write_text("keep me too")

    with pytest.raises(ValueError):
        train_from_config(cfg, features, fresh=True)

    assert decoy_out.exists() and decoy_out.read_text() == "keep me"
    assert decoy_ckpt.exists() and decoy_ckpt.read_text() == "keep me too"


def _force_early_stop(monkeypatch, worsening_after: int = 1):
    """Monkeypatch train_mod._epoch so validation loss (the calls with no
    optimizer) gets pinned to a value far worse than any real pinball loss
    after `worsening_after` val-epochs, forcing the patience counter to trip
    well before cfg['train']['epochs'] is reached — mirrors a real run that
    stops early because it's overfitting. Mirrors the monkeypatch approach
    used by _interrupt_after_epoch above."""
    orig_epoch = train_mod._epoch
    state = {"val_calls": 0}

    def _flaky(model, loader, quantiles, device, optimizer=None, *args, **kwargs):
        result = orig_epoch(model, loader, quantiles, device, optimizer, *args, **kwargs)
        if optimizer is None:  # a val-epoch call (train calls always pass optimizer)
            state["val_calls"] += 1
            if state["val_calls"] > worsening_after:
                return 1e6 + state["val_calls"]  # unbeatably worse than any real loss
        return result

    monkeypatch.setattr(train_mod, "_epoch", _flaky)


def test_apply_seed_override_noop_when_seed_none(tmp_path):
    from ffmodel.model.train import apply_seed_override

    cfg = _cfg(tmp_path)
    out = apply_seed_override(cfg, None)
    assert out is cfg  # true no-op: default (no --seed) path is byte-identical
    assert out["run_name"] == "testrun"
    assert out["seed"] == 0


def test_apply_seed_override_sets_seed_and_suffixes_run_name(tmp_path):
    from ffmodel.model.train import apply_seed_override

    cfg = _cfg(tmp_path)
    out = apply_seed_override(cfg, 43)
    assert out["seed"] == 43
    assert out["run_name"] == "testrun_s43"
    # input cfg must be untouched -- caller may reuse it for other combos
    assert cfg["seed"] == 0
    assert cfg["run_name"] == "testrun"


def test_apply_seed_override_different_seeds_give_sibling_run_names(tmp_path):
    from ffmodel.model.train import apply_seed_override

    cfg = _cfg(tmp_path)
    out43 = apply_seed_override(cfg, 43)
    out44 = apply_seed_override(cfg, 44)
    assert out43["run_name"] == "testrun_s43"
    assert out44["run_name"] == "testrun_s44"


def test_build_parser_accepts_seed_flag():
    from ffmodel.model.train import build_parser

    args = build_parser().parse_args(["--config", "configs/x.yaml", "--seed", "43"])
    assert args.seed == 43
    no_seed = build_parser().parse_args(["--config", "configs/x.yaml"])
    assert no_seed.seed is None


def test_seed_cli_override_lands_artifact_in_sibling_dir(tmp_path, monkeypatch):
    """End-to-end: --seed both overrides cfg['seed'] and routes the artifact
    into a sibling directory (v1_s43/through2022), leaving the unsuffixed
    default path (no --seed flag) untouched."""
    features = _synthetic_features()
    cfg_path = tmp_path / "cfg.yaml"
    cfg = _cfg(tmp_path, epochs=1)
    cfg["run_name"] = "v1"
    cfg_path.write_text(yaml.safe_dump(cfg))

    monkeypatch.setattr(
        "sys.argv",
        ["prog", "--config", str(cfg_path), "--seed", "43",
         "--features-parquet", "unused.parquet"],
    )
    monkeypatch.setattr(pd, "read_parquet", lambda *a, **k: features)

    from ffmodel.model.train import main

    main()

    art = train_mod.Path(cfg["out_root"]) / "v1_s43" / "through2022"
    assert art.exists()
    assert not (train_mod.Path(cfg["out_root"]) / "v1" / "through2022").exists()
    metrics = json.loads((art / "metrics.json").read_text())
    assert metrics["complete"] is True


def test_early_stop_completes_and_resume_is_skip(tmp_path, monkeypatch, capsys):
    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=10)
    cfg["train"]["patience"] = 2

    with pytest.MonkeyPatch.context() as mp:
        _force_early_stop(mp, worsening_after=1)
        art = train_from_config(cfg, features)

    metrics = json.loads((art / "metrics.json").read_text())
    assert metrics["last_epoch"] < cfg["train"]["epochs"]  # actually stopped early
    assert metrics["complete"] is True

    # Resuming a run that finished via early-stop must be a skip, not a
    # continuation: any _epoch call here is a bug.
    def _boom(*args, **kwargs):
        raise AssertionError("resume of an early-stopped run must be a skip")

    monkeypatch.setattr(train_mod, "_epoch", _boom)
    capsys.readouterr()
    art2 = train_from_config(cfg, features)
    out = capsys.readouterr().out

    assert art2 == art
    assert "already complete" in out
