import json
import os
import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.harness import run_backtest
from ffmodel.model.calibrate import write_calibration
from ffmodel.model.predictor import TransformerPredictor
from ffmodel.model.train import train_from_config
from ffmodel.scoring import BAND_CONSTRUCTION, PREDICTED_STATS

from tests.test_train import _cfg, _synthetic_features


@pytest.fixture(scope="module")
def trained(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("artifact")
    features = _synthetic_features(seasons=(2020, 2021, 2022))
    cfg = _cfg(tmp)          # val_season 2022 -> artifact through2022
    art = train_from_config(cfg, features)
    # test frame: add a 2023 season the artifact has never seen
    test_features = _synthetic_features(seasons=(2020, 2021, 2022, 2023))
    return art.parent, test_features  # art = <out_root>/testrun/through2022 -> root is its parent


@pytest.fixture(scope="module")
def trained_two_seeds(tmp_path_factory):
    """Two artifacts trained on identical data/config but different seeds
    (cfg["seed"] drives _seed_everything in train.py, so their weights --
    and thus predictions -- genuinely differ), for ensemble-averaging
    tests."""
    tmp = tmp_path_factory.mktemp("ensemble")
    features = _synthetic_features(seasons=(2020, 2021, 2022))
    roots = []
    for seed, sub in ((0, "a"), (1, "b")):
        cfg = _cfg(tmp / sub)
        cfg["seed"] = seed
        art = train_from_config(cfg, features)
        roots.append(art.parent)
    test_features = _synthetic_features(seasons=(2020, 2021, 2022, 2023))
    return roots, test_features


def test_predict_quantiles_aligned_and_monotone(trained):
    root, features = trained
    p = TransformerPredictor(root, features)
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]
    p.fit(train)
    qs = p.predict_quantiles(test)
    for key in ("p10", "p50", "p90"):
        assert list(qs[key].columns) == PREDICTED_STATS
        assert qs[key].index.equals(test.index)
    assert (qs["p10"].to_numpy() <= qs["p50"].to_numpy() + 1e-6).all()
    assert (qs["p50"].to_numpy() <= qs["p90"].to_numpy() + 1e-6).all()


def test_fit_rejects_missing_artifact(trained):
    root, features = trained
    p = TransformerPredictor(root, features)
    with pytest.raises(FileNotFoundError, match="through2023"):
        p.fit(features[features["season"] <= 2023])


def test_runs_through_backtest(trained):
    root, features = trained
    results = run_backtest(features, [TransformerPredictor(root, features)],
                           test_seasons=[2023])
    overall = results[results["position"] == "OVERALL"].iloc[0]
    assert np.isfinite(overall["mae"])
    assert np.isfinite(overall["coverage_p10_p90"])


def test_rookie_rows_use_position_fallback(trained):
    root, _ = trained
    rookie_rows = [
        {"player_id": "rookie", "season": 2023, "week": w, "position": "WR",
         "receiving_yards": 30.0, "receptions": 2.0}
        for w in range(1, 11)
    ]
    features = _synthetic_features(seasons=(2020, 2021, 2022, 2023),
                                   extra_rows=rookie_rows)
    p = TransformerPredictor(root, features)
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]
    p.fit(train)
    qs = p.predict_quantiles(test)
    debut = (test["player_id"] == "rookie") & (test["week"] == 1)
    assert test.loc[debut, "games_prior"].iloc[0] == 0  # fixture sanity
    expected_p50 = train.groupby("position")[PREDICTED_STATS].quantile(0.5).loc["WR"]
    got = qs["p50"].loc[debut].iloc[0]
    np.testing.assert_allclose(got.to_numpy(dtype=float),
                               expected_p50.to_numpy(dtype=float), rtol=1e-5)
    # week 2 is no longer a debut -> must NOT be the fallback row for every quantile
    wk2 = (test["player_id"] == "rookie") & (test["week"] == 2)
    assert not np.allclose(qs["p10"].loc[wk2].iloc[0].to_numpy(dtype=float),
                           train.groupby("position")[PREDICTED_STATS]
                           .quantile(0.1).loc["WR"].to_numpy(dtype=float))


def test_fit_rejects_non_ascending_quantiles(trained, tmp_path):
    root, features = trained
    doctored_root = tmp_path / "doctored"
    shutil.copytree(root, doctored_root)
    metrics_path = doctored_root / "through2022" / "metrics.json"
    metrics = json.loads(metrics_path.read_text())
    metrics["quantiles"] = [0.9, 0.5, 0.1]
    metrics_path.write_text(json.dumps(metrics))

    p = TransformerPredictor(doctored_root, features)
    train = features[features["season"] <= 2022]
    with pytest.raises(ValueError, match="ascending"):
        p.fit(train)


def test_single_root_string_and_singleton_list_are_byte_identical(trained):
    """Back-compat guarantee: constructing with a bare string/Path root (the
    pre-ensemble call style) must give exactly the same predictions as
    wrapping that one root in a list -- the multi-root code path must not
    perturb the single-root case at all."""
    root, features = trained
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]

    p_str = TransformerPredictor(root, features)
    p_str.fit(train)
    qs_str = p_str.predict_quantiles(test)

    p_list = TransformerPredictor([root], features)
    p_list.fit(train)
    qs_list = p_list.predict_quantiles(test)

    for key in ("p10", "p50", "p90"):
        pd.testing.assert_frame_equal(qs_str[key], qs_list[key], check_exact=True)


def test_multi_root_predict_quantiles_matches_hand_computed_mean(trained_two_seeds):
    roots, features = trained_two_seeds
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]

    ensemble = TransformerPredictor(roots, features)
    ensemble.fit(train)
    qs = ensemble.predict_quantiles(test)

    singles = []
    for root in roots:
        sp = TransformerPredictor(root, features)
        sp.fit(train)
        singles.append(sp.predict_quantiles(test))

    # sanity: the two seeds must actually differ, or this test proves nothing
    assert not np.allclose(singles[0]["p50"].to_numpy(), singles[1]["p50"].to_numpy())

    for key in ("p10", "p50", "p90"):
        expected = (singles[0][key].to_numpy() + singles[1][key].to_numpy()) / 2
        np.testing.assert_allclose(qs[key].to_numpy(), expected, rtol=1e-5, atol=1e-6)


def test_multi_root_predict_quantiles_stays_monotone(trained_two_seeds):
    """Mean-of-two-sorted-triples is mathematically always sorted (averaging
    is monotone-preserving componentwise), so this can't construct a case
    where the guard is actually load-bearing -- it's belt-and-suspenders,
    kept as the final step in case the averaging logic ever changes. This
    test just pins that the output is (still) monotone after ensembling."""
    roots, features = trained_two_seeds
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]

    p = TransformerPredictor(roots, features)
    p.fit(train)
    qs = p.predict_quantiles(test)

    assert (qs["p10"].to_numpy() <= qs["p50"].to_numpy() + 1e-6).all()
    assert (qs["p50"].to_numpy() <= qs["p90"].to_numpy() + 1e-6).all()


def test_multi_root_attach_features_propagates_to_all_members(trained_two_seeds):
    roots, features = trained_two_seeds
    p = TransformerPredictor(roots, features.iloc[0:0])  # constructed with empty frame
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]
    p.fit(train)
    with pytest.raises(ValueError, match="missing"):
        p.predict_quantiles(test)
    p.attach_features(features)
    qs = p.predict_quantiles(test)
    assert qs["p50"].index.equals(test.index)


def test_multi_root_predict_returns_p50(trained_two_seeds):
    roots, features = trained_two_seeds
    p = TransformerPredictor(roots, features)
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]
    p.fit(train)
    pd.testing.assert_frame_equal(p.predict(test), p.predict_quantiles(test)["p50"])


def test_attach_features_enables_prediction_on_extended_frame(trained):
    root, features = trained
    p = TransformerPredictor(root, features.iloc[0:0])  # constructed with empty frame
    p.fit(features[features["season"] <= 2022])
    test = features[features["season"] == 2023]
    with pytest.raises(ValueError, match="missing"):
        p.predict_quantiles(test)
    p.attach_features(features)
    qs = p.predict_quantiles(test)
    assert qs["p50"].index.equals(test.index)


# ---- calibration (Contract 3) --------------------------------------------

_CALIB_FACTORS = {
    "QB": {"s_lo": 0.4, "s_hi": 0.6},
    "RB": {"s_lo": 0.5, "s_hi": 0.5},
    "WR": {"s_lo": 0.6, "s_hi": 0.4},
    "TE": {"s_lo": 0.3, "s_hi": 0.8},
}
_CALIB_TAILS = {pos: [0.1, 0.1] for pos in _CALIB_FACTORS}


def _write_test_calibration(dest_root, through=2022, per_position=None,
                            member_roots=None, fit_season=None,
                            band_construction=None):
    """Write a calibration.json into `dest_root` via the real writer, then
    optionally doctor individual fields to construct a mismatch."""
    fitted = {"per_position": per_position or _CALIB_FACTORS,
              "achieved_val_tails": _CALIB_TAILS}
    path = write_calibration(dest_root, through,
                             member_roots if member_roots is not None else [dest_root],
                             fitted)
    if fit_season is not None or band_construction is not None:
        payload = json.loads(path.read_text())
        if fit_season is not None:
            payload["fit_season"] = fit_season
        if band_construction is not None:
            payload["band_construction"] = band_construction
        path.write_text(json.dumps(payload))
    return path


def test_predict_quantiles_absent_calibration_is_byte_identical_to_disabled(trained):
    """No calibration.json on disk: the default (calibration=True) path
    must produce output byte-identical to explicitly disabling it -- i.e.
    predictions are unaffected by the feature's mere existence."""
    root, features = trained
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]

    p_default = TransformerPredictor(root, features)
    p_default.fit(train)
    qs_default = p_default.predict_quantiles(test)

    p_disabled = TransformerPredictor(root, features, calibration=False)
    p_disabled.fit(train)
    qs_disabled = p_disabled.predict_quantiles(test)

    for key in ("p10", "p50", "p90"):
        pd.testing.assert_frame_equal(qs_default[key], qs_disabled[key], check_exact=True)


def test_predict_quantiles_applies_valid_calibration(trained, tmp_path):
    root, features = trained
    calibrated_root = tmp_path / "calibrated"
    shutil.copytree(root, calibrated_root)
    _write_test_calibration(calibrated_root)

    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]

    raw = TransformerPredictor(calibrated_root, features, calibration=False)
    raw.fit(train)
    qs_raw = raw.predict_quantiles(test)

    calibrated = TransformerPredictor(calibrated_root, features)
    calibrated.fit(train)
    qs_cal = calibrated.predict_quantiles(test)

    # p50 untouched
    pd.testing.assert_frame_equal(qs_cal["p50"], qs_raw["p50"], check_exact=True)

    positions = test["position"]
    s_lo = positions.map(lambda p: _CALIB_FACTORS[p]["s_lo"])
    s_hi = positions.map(lambda p: _CALIB_FACTORS[p]["s_hi"])
    expected_p10 = qs_raw["p50"] - (qs_raw["p50"] - qs_raw["p10"]).mul(s_lo, axis=0)
    expected_p90 = qs_raw["p50"] + (qs_raw["p90"] - qs_raw["p50"]).mul(s_hi, axis=0)
    pd.testing.assert_frame_equal(qs_cal["p10"], expected_p10, check_exact=False)
    pd.testing.assert_frame_equal(qs_cal["p90"], expected_p90, check_exact=False)

    # sanity: at least one position's factors actually moved the band
    assert not qs_cal["p10"].equals(qs_raw["p10"])

    # A single known row, computed fully by hand: pick the first test row,
    # read its position and that position's (s_lo, s_hi), and re-derive one
    # stat column's calibrated p10/p90 with plain arithmetic.
    row = test.index[0]
    pos = test.loc[row, "position"]
    s_lo_row, s_hi_row = _CALIB_FACTORS[pos]["s_lo"], _CALIB_FACTORS[pos]["s_hi"]
    raw_p10 = qs_raw["p10"].loc[row, "receiving_yards"]
    raw_p50 = qs_raw["p50"].loc[row, "receiving_yards"]
    raw_p90 = qs_raw["p90"].loc[row, "receiving_yards"]
    hand_p10 = raw_p50 - s_lo_row * (raw_p50 - raw_p10)
    hand_p90 = raw_p50 + s_hi_row * (raw_p90 - raw_p50)
    assert qs_cal["p10"].loc[row, "receiving_yards"] == pytest.approx(hand_p10)
    assert qs_cal["p90"].loc[row, "receiving_yards"] == pytest.approx(hand_p90)


def test_fit_rejects_band_construction_mismatch(trained, tmp_path):
    root, features = trained
    calibrated_root = tmp_path / "calibrated"
    shutil.copytree(root, calibrated_root)
    _write_test_calibration(calibrated_root, band_construction="some_other_v0")

    p = TransformerPredictor(calibrated_root, features)
    train = features[features["season"] <= 2022]
    with pytest.raises(ValueError, match="calibration.json"):
        p.fit(train)


def test_fit_rejects_member_roots_mismatch(trained, tmp_path):
    root, features = trained
    calibrated_root = tmp_path / "calibrated"
    shutil.copytree(root, calibrated_root)
    other_root = tmp_path / "not_the_root"
    _write_test_calibration(calibrated_root, member_roots=[other_root])

    p = TransformerPredictor(calibrated_root, features)
    train = features[features["season"] <= 2022]
    with pytest.raises(ValueError, match="calibration.json"):
        p.fit(train)


def test_fit_accepts_member_roots_with_different_but_equivalent_spelling(trained, tmp_path):
    """member_roots identity check must compare resolved paths, not literal
    spellings -- calibration.json legitimately stores repo-relative roots
    (write_calibration's contract, kept portable across machines), but a
    predictor may be constructed with absolute paths to those exact same
    artifacts. That must load and apply calibration, not raise."""
    root, features = trained
    calibrated_root = tmp_path / "calibrated"
    shutil.copytree(root, calibrated_root)
    relative_root = Path(os.path.relpath(calibrated_root, Path.cwd()))
    _write_test_calibration(calibrated_root, member_roots=[relative_root])
    assert relative_root.as_posix() != calibrated_root.resolve().as_posix()  # spellings differ

    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]

    p = TransformerPredictor(calibrated_root.resolve(), features)
    p.fit(train)  # must not raise ValueError: member_roots mismatch
    qs = p.predict_quantiles(test)

    raw = TransformerPredictor(calibrated_root.resolve(), features, calibration=False)
    raw.fit(train)
    qs_raw = raw.predict_quantiles(test)
    assert not qs["p10"].equals(qs_raw["p10"])  # calibration actually applied


def test_fit_rejects_fit_season_mismatch(trained, tmp_path):
    root, features = trained
    calibrated_root = tmp_path / "calibrated"
    shutil.copytree(root, calibrated_root)
    _write_test_calibration(calibrated_root, fit_season=2021)

    p = TransformerPredictor(calibrated_root, features)
    train = features[features["season"] <= 2022]
    with pytest.raises(ValueError, match="calibration.json"):
        p.fit(train)


def test_calibration_false_skips_loading_even_when_file_exists(trained, tmp_path):
    root, features = trained
    calibrated_root = tmp_path / "calibrated"
    shutil.copytree(root, calibrated_root)
    _write_test_calibration(calibrated_root)

    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]

    p_off = TransformerPredictor(calibrated_root, features, calibration=False)
    p_off.fit(train)  # must not raise, must not load the file
    qs_off = p_off.predict_quantiles(test)

    # Same root, calibration explicitly disabled again -> must match (both
    # skip loading, so both are the raw band).
    p_raw = TransformerPredictor(calibrated_root, features, calibration=False)
    p_raw.fit(train)
    qs_raw = p_raw.predict_quantiles(test)
    for key in ("p10", "p50", "p90"):
        pd.testing.assert_frame_equal(qs_off[key], qs_raw[key], check_exact=True)

    # The file really is valid and would change p10/p90 if loaded -- proves
    # calibration=False actually skipped it rather than the file being inert.
    p_on = TransformerPredictor(calibrated_root, features)
    p_on.fit(train)
    qs_on = p_on.predict_quantiles(test)
    assert not qs_off["p10"].equals(qs_on["p10"])


def test_pre_v2_artifact_without_feature_lists_defaults_to_v1(tmp_path):
    """Deployed v1 artifacts predate the metrics.json feature lists.
    Stripping the new keys must reproduce EXACTLY the same predictions --
    the default path is the frozen v1 constants."""
    features = _synthetic_features(seasons=(2020, 2021, 2022))
    test_features = _synthetic_features(seasons=(2020, 2021, 2022, 2023))
    art = train_from_config(_cfg(tmp_path, epochs=1), features)
    train = test_features[test_features["season"] <= 2022]
    test = test_features[test_features["season"] == 2023]

    p = TransformerPredictor(art.parent, test_features, calibration=False)
    p.fit(train)
    baseline = p.predict_quantiles(test)

    metrics = json.loads((art / "metrics.json").read_text())
    for key in ("feature_set", "seq_features", "ctx_features"):
        metrics.pop(key, None)
    (art / "metrics.json").write_text(json.dumps(metrics))

    p2 = TransformerPredictor(art.parent, test_features, calibration=False)
    p2.fit(train)
    stripped = p2.predict_quantiles(test)
    for key in ("p10", "p50", "p90"):
        pd.testing.assert_frame_equal(baseline[key], stripped[key])


def test_v2_artifact_predicts_with_v2_inputs(tmp_path):
    features = _synthetic_features(seasons=(2020, 2021, 2022))
    test_features = _synthetic_features(seasons=(2020, 2021, 2022, 2023))
    cfg = _cfg(tmp_path, epochs=1)
    cfg["feature_set"] = "v2"
    art = train_from_config(cfg, features)

    p = TransformerPredictor(art.parent, test_features, calibration=False)
    train = test_features[test_features["season"] <= 2022]
    test = test_features[test_features["season"] == 2023]
    p.fit(train)
    qs = p.predict_quantiles(test)
    assert list(qs["p50"].columns) == PREDICTED_STATS
    assert np.isfinite(qs["p50"].to_numpy()).all()


def test_inconsistent_artifact_feature_lists_raise(tmp_path):
    features = _synthetic_features(seasons=(2020, 2021, 2022))
    art = train_from_config(_cfg(tmp_path, epochs=1), features)
    metrics = json.loads((art / "metrics.json").read_text())
    metrics["seq_features"] = metrics["seq_features"][:-1]  # disagrees with n_seq_features
    (art / "metrics.json").write_text(json.dumps(metrics))

    p = TransformerPredictor(art.parent, features, calibration=False)
    with pytest.raises(ValueError, match="disagree"):
        p.fit(features[features["season"] <= 2022])
