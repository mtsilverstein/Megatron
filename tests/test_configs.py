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
# Pre-registered lambda candidates (spec 2026-07-26 section 3). The selected
# value is written into all nine mh configs before the main arm launches.
LAMBDA_CANDIDATES = {0.1, 0.3, 1.0, 3.0}


def _load_cfg(name):
    return yaml.safe_load((Path("configs") / name).read_text())


def test_mean_head_configs_exist_for_every_fold():
    for year in FOLDS:
        cfg = _load_cfg(f"transformer_mh_through{year}.yaml")
        assert cfg["val_season"] == year
        assert cfg["run_name"] == "mh"
        assert cfg["predict_mean"] is True
        # lambda is a pre-registered CANDIDATE, selected on the through2016
        # validation season and then frozen across all nine folds. Pinning the
        # placeholder value exactly would turn CI red the moment the selected
        # value is written in -- which is a REQUIRED step, not a mistake. So
        # assert what actually matters: it is one of the pre-registered
        # candidates, it is trainable (> 0), and all nine folds agree.
        assert cfg["mean_lambda"] in LAMBDA_CANDIDATES
        assert cfg["mean_lambda"] > 0
        assert cfg["quantiles"] == [0.1, 0.5, 0.9]

    lambdas = {_load_cfg(f"transformer_mh_through{y}.yaml")["mean_lambda"]
               for y in FOLDS}
    assert len(lambdas) == 1, f"all nine folds must share one lambda, got {lambdas}"


def test_baseline_backfill_configs_exist_and_are_pure_v1():
    for year in BACKFILL:
        cfg = _load_cfg(f"transformer_v1_through{year}.yaml")
        assert cfg["val_season"] == year
        assert cfg["run_name"] == "v1"
        # the baseline must NOT carry mean-head settings, or it is not a baseline
        assert "predict_mean" not in cfg
        assert "mean_lambda" not in cfg


def test_mean_head_configs_mirror_v1_exactly_apart_from_the_mean_keys():
    """Any other difference would confound the comparison the gate depends on.

    Compares the FULL config dicts (minus the three keys that are allowed to
    differ) rather than a named subset: a whole-dict equality catches a changed
    value, an added key, a DROPPED key, and any nested difference alike. A
    named-field version silently passed a typo'd `out_root`/`checkpoint_root`
    or a dropped `quantiles`, which is exactly the confound-by-typo this test
    exists to prevent -- and it would only surface 40 GPU runs later.
    """
    allowed_to_differ = {"run_name", "predict_mean", "mean_lambda"}
    for year in FOLDS:
        mh = _load_cfg(f"transformer_mh_through{year}.yaml")
        v1 = _load_cfg(f"transformer_v1_through{year}.yaml")
        mh_cmp = {k: v for k, v in mh.items() if k not in allowed_to_differ}
        v1_cmp = {k: v for k, v in v1.items() if k not in allowed_to_differ}
        assert mh_cmp == v1_cmp, f"through{year}: mh/v1 differ beyond the mean keys"
        # and the mean keys really are the only additions
        assert set(mh) - set(v1) == {"predict_mean", "mean_lambda"}
        assert set(v1) - set(mh) == set(), f"through{year}: mh dropped a v1 key"
        # the tuned hyperparameters are the confound that matters most; assert
        # them explicitly too so a failure names them rather than dumping dicts
        assert {k: mh["train"][k] for k in TUNED} == {k: v1["train"][k] for k in TUNED}
