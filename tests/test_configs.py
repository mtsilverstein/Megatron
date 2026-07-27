"""Pins the feature-pack-v2 experimental control: every v2 config mirrors
its v1 counterpart byte-for-byte except run_name and feature_set -- the
experiment isolates FEATURES, not tuning (spec 2026-07-21, 'no new sweep')."""
from pathlib import Path

import yaml


def _by_stem(pattern):
    return {p.stem: p for p in Path("configs").glob(pattern)}


# v2 mirrors these four canonical walk-forward folds. v1 has additional
# earlier folds (through2019-2021, added for the RB out-of-sample test) that
# v2 deliberately does not mirror, so pin the canonical set explicitly rather
# than globbing every transformer_v1* config.
CANONICAL_FOLDS = {"transformer_v2", "transformer_v2_through2022",
                   "transformer_v2_through2023", "transformer_v2_through2024"}


def test_v2_config_exists_for_every_canonical_fold():
    assert set(_by_stem("transformer_v2*.yaml")) == CANONICAL_FOLDS
    # every v2 fold has a v1 counterpart on disk
    for name in CANONICAL_FOLDS:
        assert (Path("configs") / f"{name.replace('v2', 'v1')}.yaml").exists()


def test_v2_mirrors_v1_except_run_name_and_feature_set():
    v1 = _by_stem("transformer_v1*.yaml")
    for name, path in _by_stem("transformer_v2*.yaml").items():
        cfg2 = yaml.safe_load(path.read_text())
        cfg1 = yaml.safe_load(v1[name.replace("v2", "v1")].read_text())
        assert cfg2.pop("feature_set") == "v2", name
        assert cfg2.pop("run_name") == "v2", name
        assert cfg1.pop("run_name") == "v1", name
        assert "feature_set" not in cfg1, name  # v1 configs stay pre-v2
        assert cfg2 == cfg1, name  # every remaining key equal, incl. val_season


# --- mean-head experiment (spec 2026-07-26) -------------------------------
# These configs are inputs to 40 GPU runs; a typo only surfaces hours later,
# so they are asserted rather than eyeballed.

FOLDS = list(range(2016, 2025))          # through2016 .. through2024
BACKFILL = [2016, 2017, 2018]            # v1 folds that do not exist yet
TUNED = {"batch_size", "lr", "weight_decay", "epochs", "patience", "grad_clip", "amp"}


def _load_cfg(name):
    return yaml.safe_load((Path("configs") / name).read_text())


def test_mean_head_configs_exist_for_every_fold():
    for year in FOLDS:
        cfg = _load_cfg(f"transformer_mh_through{year}.yaml")
        assert cfg["val_season"] == year
        assert cfg["run_name"] == "mh"
        assert cfg["predict_mean"] is True
        assert cfg["mean_lambda"] == 1.0        # frozen placeholder, see below
        assert cfg["quantiles"] == [0.1, 0.5, 0.9]


def test_baseline_backfill_configs_exist_and_are_pure_v1():
    for year in BACKFILL:
        cfg = _load_cfg(f"transformer_v1_through{year}.yaml")
        assert cfg["val_season"] == year
        assert cfg["run_name"] == "v1"
        # the baseline must NOT carry mean-head settings, or it is not a baseline
        assert "predict_mean" not in cfg
        assert "mean_lambda" not in cfg


def test_mean_head_configs_mirror_v1_exactly_apart_from_the_mean_keys():
    """Any other difference would confound the comparison the gate depends on."""
    for year in FOLDS:
        mh = _load_cfg(f"transformer_mh_through{year}.yaml")
        v1 = _load_cfg(f"transformer_v1_through{year}.yaml")
        assert mh["seed"] == v1["seed"]
        assert mh["seq_len"] == v1["seq_len"]
        assert mh["first_season"] == v1["first_season"]
        assert mh["model"] == v1["model"]
        assert {k: mh["train"][k] for k in TUNED} == {k: v1["train"][k] for k in TUNED}
        extra = set(mh) - set(v1)
        assert extra == {"predict_mean", "mean_lambda"}, extra
