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
