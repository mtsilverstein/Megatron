"""Pins the loss-rebalance experimental control: each weighted-arm config
mirrors its v1 counterpart byte-for-byte except run_name + loss_weighting,
and the earlier-fold baseline configs are pure v1 except val_season -- the
experiment isolates the LOSS WEIGHTING, not tuning (spec 2026-07-22)."""
from pathlib import Path

import yaml

CFG = Path("configs")


def _load(name):
    return yaml.safe_load((CFG / name).read_text())


def _v1_counterpart(weighted_name, run):
    return weighted_name.replace(f"transformer_{run}", "transformer_v1")


def test_weighted_arms_mirror_v1_except_run_name_and_loss_weighting():
    for run, scheme in (("stdw", "std"), ("ptsw", "points")):
        arm = sorted(CFG.glob(f"transformer_{run}*.yaml"))
        assert len(arm) == 4, f"{run}: expected 4 folds, got {len(arm)}"
        for path in arm:
            c = _load(path.name)
            v1 = _load(_v1_counterpart(path.name, run))
            assert c.pop("loss_weighting") == scheme, path.name
            assert c.pop("run_name") == run, path.name
            assert v1.pop("run_name") == "v1", path.name
            assert "loss_weighting" not in v1, path.name
            assert c == v1, f"{path.name} diverges from v1 beyond the allowed keys"


def test_every_v1_weighted_fold_has_both_arms():
    v1_folds = {p.stem.replace("transformer_v1", "")
                for p in CFG.glob("transformer_v1*.yaml")
                if p.stem.replace("transformer_v1", "") in
                ("", "_through2022", "_through2023", "_through2024")}
    for run in ("stdw", "ptsw"):
        got = {p.stem.replace(f"transformer_{run}", "")
               for p in CFG.glob(f"transformer_{run}*.yaml")}
        assert got == v1_folds, f"{run} folds {got} != v1 folds {v1_folds}"


def test_earlier_baseline_folds_are_pure_v1_except_val_season():
    base = _load("transformer_v1.yaml")
    for val in (2019, 2020, 2021):
        c = _load(f"transformer_v1_through{val}.yaml")
        assert c["val_season"] == val
        assert c.get("loss_weighting") is None      # pure v1, no weighting
        assert c["run_name"] == "v1"
        c2, b2 = dict(c), dict(base)
        c2.pop("val_season"); b2.pop("val_season")
        assert c2 == b2, f"through{val} diverges from v1 beyond val_season"
