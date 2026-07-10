import numpy as np
import pandas as pd
import pytest
import yaml

from ffmodel.data.features import build_features
from ffmodel.model.train import train_from_config

from tests.test_features import make_schedules, make_weekly


def _synthetic_features(n_players=12, seasons=(2020, 2021, 2022)):
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
