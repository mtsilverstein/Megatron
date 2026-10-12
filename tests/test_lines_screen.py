"""Lines-screen driver: frozen frame, collector, manifest and run
(spec 2026-10-11 §4, §8, §11). Synthetic world + stand-in predictors."""
import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.data.features import LINE_FEATURE_COLUMNS
from ffmodel.data.lines import build_line_table, file_sha256, join_line_features
from ffmodel.eval import lines_screen
from ffmodel.eval.lines_screen import (
    ARM_FEATURE_SETS,
    ESTIMATOR_CONFIG,
    KEY_COLUMNS,
    TIMING_LABEL,
    arm_feature_lists,
    assert_arms_paired,
    build_model_frame,
    collect_paired_predictions,
    freeze_screen,
    read_frozen_frame,
    run_screen,
    write_frozen_frame,
)
from ffmodel.eval.lines_stats import RNG_SEED, ScreenInvalid, evaluate, pred_col
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

from tests.lines_world import FakePredictor, world_features

SEASONS = list(range(2012, 2026))
TEST_SEASONS = (2023, 2024, 2025)
SEEDS = (0, 1, 2)


@pytest.fixture(scope="module")
def joined() -> pd.DataFrame:
    features, raw = world_features()
    table, _ = build_line_table(raw, SEASONS)
    out, _ = join_line_features(features, table)
    return out


@pytest.fixture(scope="module")
def frame(joined) -> pd.DataFrame:
    return build_model_frame(joined)


def fake(bad=None):
    return lambda arm, seed: FakePredictor(arm, seed, bad=bad)


def strict_json(path):
    def reject(token):
        raise ValueError(f"non-JSON constant {token}")
    return json.loads(path.read_text(encoding="utf-8"), parse_constant=reject)


# --- frozen modeling frame ------------------------------------------------------

def test_model_frame_holds_exactly_keys_features_and_targets(frame):
    a_cols, b_cols = arm_feature_lists(frame)
    assert len(a_cols) == 40 and b_cols == a_cols + LINE_FEATURE_COLUMNS
    lead = ["player_id", "season", "week", "position", "team"]
    assert list(frame.columns) == lead + [c for c in b_cols if c not in lead] + PREDICTED_STATS
    for absent in ("two_point_conversions", "special_teams_tds", "ppr_points", "fantasy_points_ppr"):
        assert absent not in frame.columns
    assert frame.index.equals(pd.RangeIndex(len(frame)))
    order = frame[["season", "week", "player_id"]].apply(tuple, axis=1).tolist()
    assert order == sorted(order)


@pytest.mark.parametrize("breakage,match", [
    (lambda f: pd.concat([f, f.iloc[[0]]], ignore_index=True), "duplicate row key"),
    (lambda f: f.assign(player_id=[None] + list(f["player_id"].iloc[1:])), "null row key"),
    (lambda f: f.assign(position=["K"] + list(f["position"].iloc[1:])), "positions outside"),
    (lambda f: f.assign(season=f["season"].replace(2022, 2011)), "seasons outside"),
])
def test_model_frame_rejects_bad_population(joined, breakage, match):
    with pytest.raises(ScreenInvalid, match=match):
        build_model_frame(breakage(joined))


def test_arm_lists_require_the_line_columns_and_forty_a_columns(joined):
    with pytest.raises(ValueError, match="needs line column"):
        arm_feature_lists(joined.drop(columns=["team_expected_margin"]))
    with pytest.raises(ScreenInvalid, match="expected 40"):
        arm_feature_lists(joined.drop(columns=["lag4_carries"]))


def test_arms_paired_on_the_frozen_frame(frame):
    assert_arms_paired(frame)       # does not raise


def test_frozen_frame_hash_schema_and_no_overwrite(frame, tmp_path):
    info = write_frozen_frame(frame, tmp_path / "frame.parquet")
    assert info["sha256"] == file_sha256(tmp_path / "frame.parquet")
    assert info["schema"][0] == {"name": "player_id", "dtype": str(frame["player_id"].dtype)}
    assert [c["name"] for c in info["schema"]] == list(frame.columns)
    back = read_frozen_frame(info["path"], info["sha256"], info["schema"])
    pd.testing.assert_frame_equal(back, frame)
    again = write_frozen_frame(frame, tmp_path / "again.parquet")
    assert again["sha256"] == info["sha256"]                      # deterministic bytes
    with pytest.raises(FileExistsError):
        write_frozen_frame(frame, tmp_path / "frame.parquet")


def test_changed_frame_changes_hash_and_is_refused(frame, tmp_path):
    info = write_frozen_frame(frame, tmp_path / "frame.parquet")
    changed = frame.assign(team_implied_total=frame["team_implied_total"] + 0.5)
    other = write_frozen_frame(changed, tmp_path / "changed.parquet")
    assert other["sha256"] != info["sha256"]
    with pytest.raises(ScreenInvalid, match="sha256"):
        read_frozen_frame(other["path"], info["sha256"], info["schema"])
    with pytest.raises(ScreenInvalid, match="schema"):
        read_frozen_frame(info["path"], info["sha256"], info["schema"][:-1])


# --- collector ----------------------------------------------------------------------

def test_collector_scores_common_components_only(joined, frame):
    assert (joined["two_point_conversions"] == 1).all()          # extras are in the frame...
    from_joined = collect_paired_predictions(joined, SEEDS, TEST_SEASONS, make_predictor=fake())
    test = joined[joined["season"].isin(TEST_SEASONS)]
    expected = fantasy_points(test[PREDICTED_STATS], PPR)
    np.testing.assert_allclose(from_joined.loc[test.index, "actual"], expected)
    with_extras = fantasy_points(test, PPR)
    np.testing.assert_allclose(with_extras - expected, 8.0)     # ...but never enter actual
    from_frame = collect_paired_predictions(frame, SEEDS, TEST_SEASONS, make_predictor=fake())
    assert sorted(from_frame["actual"]) == pytest.approx(sorted(from_joined["actual"]))


def test_collector_shape_keys_and_pairing(frame):
    paired = collect_paired_predictions(frame, SEEDS, TEST_SEASONS, make_predictor=fake())
    test = frame[frame["season"].isin(TEST_SEASONS)]
    assert paired.index.equals(test.index)
    assert list(paired.columns[:5]) == ["player_id", "season", "week", "position", "actual"]
    assert [c for c in paired.columns[5:]] == [pred_col(a, s) for a in ("A", "B") for s in SEEDS]
    assert not paired[KEY_COLUMNS].duplicated().any()
    assert not np.allclose(paired[pred_col("A", 0)], paired[pred_col("B", 0)])


@pytest.mark.parametrize("bad,match", [("nan", "non-finite predicted component"),
                                       ("misaligned", "misaligned"),
                                       ("missing_column", "missing predicted component")])
def test_collector_invalid_predictions(frame, bad, match):
    with pytest.raises(ScreenInvalid, match=match):
        collect_paired_predictions(frame, SEEDS, TEST_SEASONS, make_predictor=fake(bad))


def test_collector_with_real_xgb_arms(frame):
    make = lambda arm, seed: XGBBaseline(n_estimators=5, seed=seed,
                                         feature_set=ARM_FEATURE_SETS[arm])
    paired = collect_paired_predictions(frame, (0,), (2025,), make_predictor=make)
    assert len(paired) == int((frame["season"] == 2025).sum())
    assert np.isfinite(paired[[pred_col("A", 0), pred_col("B", 0)]].to_numpy()).all()


def test_estimator_config_matches_xgb_baseline(frame):
    model = XGBBaseline(seed=0)
    model.fit(frame[frame["season"] == 2022])
    params = model._models[PREDICTED_STATS[0]].get_params()
    for key, value in ESTIMATOR_CONFIG.items():
        assert params[key] == value, key


# --- freeze + run ---------------------------------------------------------------------

def paths(tmp_path):
    return {"frame_path": tmp_path / "data" / "frame.parquet",
            "manifest_path": tmp_path / "manifest.json",
            "artifact_path": tmp_path / "lines_screen.json"}


PROVENANCE = {"spec": {"path": "spec.md", "git_blob": "abc"}, "implementation_commit": "def",
              "schedule_snapshot": {"sha256": "0" * 64}, "source_data_vintage": {"sources": []}}


def frozen(tmp_path):
    features, raw = world_features()
    p = paths(tmp_path)
    manifest = freeze_screen(raw, features, provenance=PROVENANCE, **p)
    return manifest, p


def test_freeze_writes_frame_and_complete_manifest(tmp_path):
    manifest, p = frozen(tmp_path)
    on_disk = strict_json(p["manifest_path"])
    assert on_disk["model_frame"]["sha256"] == file_sha256(p["frame_path"])
    for key in ("spec", "implementation_commit", "schedule_snapshot", "source_data_vintage",
                "lines_validation", "line_join_by_season", "model_frame", "feature_lists",
                "estimator", "scoring", "software", "rows", "train_test_ranges", "seeds",
                "test_seasons", "rng", "thresholds", "timing_label"):
        assert key in on_disk, key
    assert len(on_disk["feature_lists"]["A"]) == 40 and len(on_disk["feature_lists"]["B"]) == 42
    assert on_disk["rng"]["seed"] == 20261007 and on_disk["rng"]["percentile_method"] == "linear"
    assert on_disk["train_test_ranges"]["2023"] == {"train": [2022, 2022], "test": 2023}
    assert on_disk["rows"]["test_rows"]["2023"] == {"rows": 112, "expected": 5893}
    assert on_disk["rows"]["test_rows_match_expected"] is False     # recorded, not fatal
    assert on_disk["scoring"]["pass_td"] == 4.0
    assert on_disk["timing_label"] == TIMING_LABEL
    assert not p["artifact_path"].exists()                           # nothing fitted yet


def unmatched(raw: pd.DataFrame) -> pd.DataFrame:
    """Drop one game, so its players' team-week is unmatched (a fatal join error)."""
    return raw[~((raw["season"] == 2024) & (raw["week"] == 3) & (raw["home_team"] == "MIA"))]


def test_freeze_on_unmatched_join_writes_invalid_and_no_frame(tmp_path):
    features, raw = world_features()
    raw = unmatched(raw)
    p = paths(tmp_path)
    out = freeze_screen(raw, features, provenance=PROVENANCE, **p)
    assert out["decision"]["disposition"] == "invalid"
    assert "unmatched player team-week" in out["decision"]["invalid_reasons"][0]
    assert strict_json(p["artifact_path"])["decision"]["disposition"] == "invalid"
    assert not p["frame_path"].exists() and not p["manifest_path"].exists()


# --- evidence files are written once (R1) ------------------------------------------------

ORIGINAL = {"manifest_path": b'{"original": "manifest"}\n',
            "artifact_path": b'{"original": "result"}\n'}


@pytest.mark.parametrize("scenario", ["would_succeed", "fatal_join"])
@pytest.mark.parametrize("existing", ["manifest_path", "artifact_path"])
def test_freeze_never_replaces_an_existing_manifest_or_result(tmp_path, existing, scenario):
    features, raw = world_features()
    if scenario == "fatal_join":
        raw = unmatched(raw)          # would write an `invalid` artifact
    p = paths(tmp_path)               # a fresh frame path: only the one record exists
    p[existing].write_bytes(ORIGINAL[existing])
    with pytest.raises(FileExistsError, match="never replaced"):
        freeze_screen(raw, features, provenance=PROVENANCE, **p)
    assert p[existing].read_bytes() == ORIGINAL[existing]
    assert [k for k in p if p[k].exists()] == [existing]        # nothing else written


@pytest.mark.parametrize("existing", ["manifest_path", "artifact_path", "frame_path"])
def test_freeze_refuses_before_any_validation(tmp_path, monkeypatch, existing):
    def boom(*args, **kwargs):
        raise AssertionError("validation must not start when a destination exists")

    monkeypatch.setattr(lines_screen, "build_line_table", boom)
    features, raw = world_features()
    p = paths(tmp_path)
    p[existing].parent.mkdir(parents=True, exist_ok=True)
    p[existing].write_bytes(b"original")
    with pytest.raises(FileExistsError):
        freeze_screen(raw, features, provenance=PROVENANCE, **p)
    assert p[existing].read_bytes() == b"original"


def test_second_failing_freeze_preserves_the_first_invalid_result(tmp_path):
    features, raw = world_features()
    raw = unmatched(raw)
    p = paths(tmp_path)
    assert freeze_screen(raw, features, provenance=PROVENANCE, **p)["decision"]["disposition"] == "invalid"
    original = p["artifact_path"].read_bytes()
    retry = {**p, "frame_path": tmp_path / "data" / "frame_v2.parquet",
             "manifest_path": tmp_path / "manifest_v2.json"}
    with pytest.raises(FileExistsError):        # the replacement would also be `invalid`
        freeze_screen(raw, features, provenance={**PROVENANCE, "implementation_commit": "fix"}, **retry)
    assert p["artifact_path"].read_bytes() == original
    # A rerun under a new result path is allowed and keeps both records.
    retry["artifact_path"] = tmp_path / "lines_screen_v2.json"
    assert freeze_screen(raw, features, provenance=PROVENANCE, **retry)["decision"]["disposition"] == "invalid"
    assert p["artifact_path"].read_bytes() == original and retry["artifact_path"].exists()


def test_second_freeze_with_a_new_frame_path_cannot_replace_the_manifest(tmp_path):
    _, p = frozen(tmp_path)
    original = p["manifest_path"].read_bytes()
    features, raw = world_features()
    new_frame = tmp_path / "data" / "frame_v2.parquet"
    with pytest.raises(FileExistsError):
        freeze_screen(raw, features, provenance=PROVENANCE, **{**p, "frame_path": new_frame})
    assert p["manifest_path"].read_bytes() == original
    assert not new_frame.exists() and not p["artifact_path"].exists()


def test_write_json_refuses_replacement_and_leaves_no_partial_file(tmp_path):
    path = tmp_path / "evidence.json"
    path.write_bytes(b"original")
    with pytest.raises(FileExistsError):
        lines_screen.write_json({"a": 1}, path)
    assert path.read_bytes() == b"original"
    fresh = tmp_path / "fresh.json"
    with pytest.raises(TypeError):
        lines_screen.write_json({"a": object()}, fresh)       # serialised before opening
    assert not fresh.exists()


def test_run_reads_frozen_frame_and_writes_strict_artifact(tmp_path):
    manifest, p = frozen(tmp_path)
    paired_path = tmp_path / "data" / "paired.parquet"
    out = run_screen(p["manifest_path"], p["artifact_path"], paired_path,
                     make_predictor=fake(), n_accept=200, max_attempts=2000)
    art = strict_json(p["artifact_path"])
    assert art["decision"]["disposition"] in {"pass", "fail"}
    assert art["paired_rows"]["sha256"] == file_sha256(paired_path)
    assert art["paired_rows"]["rows"] == 336
    assert art["manifest"]["model_frame"]["sha256"] == manifest["model_frame"]["sha256"]
    assert art["ranking"]["status"] in {"ranking_ok", "ranking_veto", "ranking_not_evaluable"}
    assert set(art["consequences"]) >= {"buys_forward_shadow_test", "ranking_recommendation_forbidden",
                                        "carry_into_forward_preregistration"}
    assert art["bootstrap"]["accepted"] == 200
    saved = pd.read_parquet(paired_path)
    assert {"d", "d_0", "d_1", "d_2"} <= set(saved.columns)
    assert out["point"]["G"] == pytest.approx(saved.groupby("season")["d"].mean().mean())
    with pytest.raises(FileExistsError):
        run_screen(p["manifest_path"], p["artifact_path"], tmp_path / "other.parquet",
                   make_predictor=fake(), n_accept=200, max_attempts=2000)


def _tamper_frame(p) -> None:
    frame = pd.read_parquet(p["frame_path"])
    frame.assign(team_implied_total=0.0).to_parquet(p["frame_path"], index=False)


def _tamper_manifest(edit):
    def apply(p) -> None:
        manifest = json.loads(p["manifest_path"].read_text(encoding="utf-8"))
        edit(manifest)
        p["manifest_path"].write_text(json.dumps(manifest), encoding="utf-8")
    return apply


def _set_dtype(m) -> None:
    m["model_frame"]["schema"][5]["dtype"] = "int8"


def _swap_b_line_columns(m) -> None:
    b = m["feature_lists"]["B"]
    b[-2], b[-1] = b[-1], b[-2]


def _drop_a_column(m) -> None:
    m["feature_lists"]["A"] = m["feature_lists"]["A"][:-1]


@pytest.mark.parametrize("tamper,match", [
    (_tamper_frame, "sha256"),                                    # frame bytes changed
    (_tamper_manifest(_set_dtype), "schema differs"),             # schema mismatch
    (_tamper_manifest(_swap_b_line_columns), "feature lists differ"),   # B list mismatch
    (_tamper_manifest(_drop_a_column), "feature lists differ"),         # A list mismatch
], ids=["hash", "schema", "feature_list_B", "feature_list_A"])
def test_run_integrity_mismatch_is_invalid_without_fitting(tmp_path, tamper, match):
    _, p = frozen(tmp_path)
    tamper(p)
    calls = []

    def recording(arm, seed):
        calls.append((arm, seed))
        raise AssertionError("must not fit when the frozen inputs do not match the manifest")

    paired_path = tmp_path / "paired.parquet"
    out = run_screen(p["manifest_path"], p["artifact_path"], paired_path, make_predictor=recording)
    assert calls == []                                            # factory never called
    assert out["decision"]["disposition"] == "invalid"
    assert match in out["decision"]["invalid_reasons"][0]
    assert not paired_path.exists()
    art = strict_json(p["artifact_path"])
    assert art["stage"] == "run" and art["decision"]["disposition"] == "invalid"
    assert art["consequences"]["buys_forward_shadow_test"] is False
    assert "tracked_changes_uncommitted" in art["run"]


def test_run_with_non_finite_prediction_is_invalid(tmp_path):
    _, p = frozen(tmp_path)
    out = run_screen(p["manifest_path"], p["artifact_path"], tmp_path / "paired.parquet",
                     make_predictor=fake("nan"), n_accept=50, max_attempts=500)
    assert out["decision"]["disposition"] == "invalid"
    assert "non-finite" in out["decision"]["invalid_reasons"][0]


def test_abandon_records_invalid(tmp_path):
    artifact = tmp_path / "lines_screen.json"
    code = lines_screen.main(["abandon", "--reason", "effort cap reached", "--artifact", str(artifact)])
    assert code == 2
    art = strict_json(artifact)
    assert art["decision"]["invalid_reasons"] == ["effort cap reached"]
    assert art["stage"] == "abandon"
    assert art["manifest"] is None


def test_abandon_with_a_manifest_that_does_not_exist_writes_nothing(tmp_path):
    artifact = tmp_path / "lines_screen.json"
    with pytest.raises(SystemExit, match="omit --manifest"):
        lines_screen.main(["abandon", "--reason", "effort cap reached",
                           "--manifest", str(tmp_path / "no_manifest.json"), "--artifact", str(artifact)])
    assert not artifact.exists()


def test_abandon_never_replaces_an_existing_artifact(tmp_path):
    artifact = tmp_path / "lines_screen.json"
    artifact.write_bytes(ORIGINAL["artifact_path"])
    with pytest.raises(SystemExit, match="preserve and report"):
        lines_screen.main(["abandon", "--reason", "effort cap reached", "--artifact", str(artifact)])
    assert artifact.read_bytes() == ORIGINAL["artifact_path"]


def test_abandon_after_a_successful_freeze_carries_the_manifest(tmp_path):
    manifest, p = frozen(tmp_path)
    code = lines_screen.main(["abandon", "--reason", "effort cap reached",
                              "--manifest", str(p["manifest_path"]), "--artifact", str(p["artifact_path"])])
    assert code == 2
    art = strict_json(p["artifact_path"])
    assert art["manifest"]["model_frame"]["sha256"] == manifest["model_frame"]["sha256"]
    assert art["decision"]["invalid_reasons"] == ["effort cap reached"]


def test_run_takes_seeds_seasons_and_bootstrap_protocol_from_the_manifest(tmp_path):
    _, p = frozen(tmp_path)
    manifest = json.loads(p["manifest_path"].read_text(encoding="utf-8"))
    manifest["seeds"] = [0, 2]
    manifest["test_seasons"] = [2024, 2025]
    manifest["rng"].update(seed=7, n_accept=120, max_attempts=4_000)   # small, so the test stays fast
    p["manifest_path"].write_text(json.dumps(manifest), encoding="utf-8")
    calls = []

    def recording(arm, seed):
        calls.append((arm, seed))
        return FakePredictor(arm, seed)

    paired_path = tmp_path / "paired.parquet"
    out = run_screen(p["manifest_path"], p["artifact_path"], paired_path, make_predictor=recording)
    # Seeds and test seasons: 2 arms x seeds {0, 2} x folds {2024, 2025}; no seed 1, no 2023.
    assert sorted(calls) == sorted([(a, s) for a in ("A", "B") for s in (0, 2)] * 2)
    saved = pd.read_parquet(paired_path)
    assert set(saved["season"]) == {2024, 2025}
    assert [c for c in saved.columns if c.startswith("pred_")] == [
        pred_col(a, s) for a in ("A", "B") for s in (0, 2)]
    assert set(out["point"]["G_S"]) == {2024, 2025} and set(out["point"]["G_seed"]) == {0, 2}
    # Bootstrap protocol: accepted count, attempt limit and generator seed.
    assert out["bootstrap"]["accepted"] == 120
    assert out["run"]["n_accept"] == 120 and out["run"]["max_attempts"] == 4_000
    paired = saved.drop(columns=["d", "d_0", "d_2"])
    kwargs = {"n_accept": 120, "max_attempts": 4_000}
    with_manifest_seed = evaluate(paired, (0, 2), (2024, 2025), rng_seed=7, **kwargs)
    with_code_default = evaluate(paired, (0, 2), (2024, 2025), rng_seed=RNG_SEED, **kwargs)
    assert out["point"]["G_interval"] == with_manifest_seed["point"]["G_interval"]
    assert out["point"]["G_interval"] != with_code_default["point"]["G_interval"]


def test_run_records_head_and_dirty_status(tmp_path, monkeypatch):
    _, p = frozen(tmp_path)
    monkeypatch.setattr(lines_screen, "git_provenance", lambda *a, **k: {
        "spec": None, "implementation_commit": "abc123", "tracked_changes_uncommitted": True})
    run_screen(p["manifest_path"], p["artifact_path"], tmp_path / "paired.parquet",
               make_predictor=fake(), n_accept=50, max_attempts=500)
    run = strict_json(p["artifact_path"])["run"]
    assert run["run_commit"] == "abc123"
    assert run["tracked_changes_uncommitted"] is True             # recorded, not discarded
