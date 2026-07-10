import numpy as np
import pandas as pd
import pytest
import yaml

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


def _cfg(tmp_path, epochs=2):
    return {
        "run_name": "testrun", "seed": 0, "seq_len": 8, "val_season": 2022,
        "first_season": 2020, "quantiles": [0.1, 0.5, 0.9],
        "model": {"d_model": 16, "n_heads": 2, "n_layers": 1, "dropout": 0.0},
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


def test_resume_continues_from_checkpoint(tmp_path):
    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=1)
    train_from_config(cfg, features)
    cfg["train"]["epochs"] = 2
    art = train_from_config(cfg, features, resume=True)
    import json
    metrics = json.loads((art / "metrics.json").read_text())
    assert metrics["last_epoch"] == 2  # continued, not restarted


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


def test_resume_matches_uninterrupted_run(tmp_path):
    import json

    features = _synthetic_features()
    cfg_a = _cfg(tmp_path, epochs=2)
    cfg_a["out_root"] = str(tmp_path / "a")
    cfg_a["checkpoint_root"] = str(tmp_path / "a" / "ckpt")
    art_a = train_from_config(cfg_a, features)

    cfg_b = _cfg(tmp_path, epochs=1)
    cfg_b["out_root"] = str(tmp_path / "b")
    cfg_b["checkpoint_root"] = str(tmp_path / "b" / "ckpt")
    train_from_config(cfg_b, features)
    cfg_b["train"]["epochs"] = 2
    art_b = train_from_config(cfg_b, features, resume=True)

    ma = json.loads((art_a / "metrics.json").read_text())
    mb = json.loads((art_b / "metrics.json").read_text())
    assert mb["val_pinball"] == pytest.approx(ma["val_pinball"])
    assert mb["best_epoch"] == ma["best_epoch"]


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
