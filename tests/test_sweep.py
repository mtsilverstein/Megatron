import json

import pandas as pd
import pytest
import yaml

from ffmodel.model.sweep import (
    apply_overrides,
    build_run_cfg,
    collect_results,
    combo_run_name,
    expand_grid,
    format_leaderboard,
    run_sweep,
    write_results,
)

from tests.test_train import _cfg, _synthetic_features

DEFAULT_GRID = {
    "seq_len": [8, 16],
    "model.d_model": [64, 96, 128],
    "model.n_layers": [2, 3],
    "train.lr": [3.0e-4, 1.0e-3],
}


def _base_cfg(tmp_path):
    return _cfg(tmp_path)


# --- grid expansion -----------------------------------------------------

def test_expand_grid_count_and_deterministic_order():
    grid = {"seq_len": [8, 16], "model.d_model": [64, 96]}
    combos = expand_grid(grid)
    assert len(combos) == 4
    assert combos[0] == {"seq_len": 8, "model.d_model": 64}
    assert combos[-1] == {"seq_len": 16, "model.d_model": 96}
    # re-expanding the same grid gives byte-identical order (resumability)
    assert expand_grid(grid) == combos


def test_expand_grid_default_v1_grid_has_24_combos():
    assert len(expand_grid(DEFAULT_GRID)) == 24


def test_expand_grid_actual_config_file_matches_default_grid():
    with open("configs/sweep_v1.yaml", encoding="utf-8") as f:
        grid_cfg = yaml.safe_load(f)
    combos = expand_grid(grid_cfg["grid"])
    assert len(combos) == 24
    assert grid_cfg["base"] == "configs/transformer_v1_through2022.yaml"


# --- run_name encoding ---------------------------------------------------

def test_combo_run_name_matches_spec_example():
    combo = {"seq_len": 8, "model.d_model": 64, "model.n_layers": 2, "train.lr": 3.0e-4}
    assert combo_run_name(combo) == "seq8_d64_l2_lr3e-04"


def test_combo_run_name_second_lr_value():
    combo = {"seq_len": 16, "model.d_model": 128, "model.n_layers": 3, "train.lr": 1.0e-3}
    assert combo_run_name(combo) == "seq16_d128_l3_lr1e-03"


def test_combo_run_names_all_unique_over_default_grid():
    names = [combo_run_name(c) for c in expand_grid(DEFAULT_GRID)]
    assert len(names) == len(set(names)) == 24


# --- override application -------------------------------------------------

def test_apply_overrides_sets_nested_and_toplevel_without_mutating_base(tmp_path):
    base = _base_cfg(tmp_path)
    base_copy_for_comparison = json.loads(json.dumps(base))
    combo = {"seq_len": 8, "model.d_model": 64, "model.n_layers": 2, "train.lr": 3.0e-4}
    out = apply_overrides(base, combo)
    assert out["seq_len"] == 8
    assert out["model"]["d_model"] == 64
    assert out["model"]["n_layers"] == 2
    assert out["train"]["lr"] == 3.0e-4
    # base config dict must be untouched
    assert base == base_copy_for_comparison


def test_apply_overrides_rejects_unknown_nested_path(tmp_path):
    base = _base_cfg(tmp_path)
    with pytest.raises(KeyError):
        apply_overrides(base, {"nope.nested": 1})


def test_build_run_cfg_points_paths_under_grid_out_root(tmp_path):
    base = _base_cfg(tmp_path)
    combo = {"seq_len": 8, "model.d_model": 64, "model.n_layers": 2, "train.lr": 3.0e-4}
    out_root = tmp_path / "sweeps" / "v1"
    cfg = build_run_cfg(base, combo, out_root)
    assert cfg["run_name"] == "seq8_d64_l2_lr3e-04"
    assert cfg["out_root"] == str(out_root)
    assert cfg["checkpoint_root"] == str(out_root / "checkpoints")
    assert cfg["seq_len"] == 8 and cfg["model"]["d_model"] == 64


# --- leaderboard / results.json -------------------------------------------

def _write_metrics(out_root, run_name, val_season, val_pinball, best_epoch, complete):
    art_dir = out_root / run_name / f"through{val_season}"
    art_dir.mkdir(parents=True, exist_ok=True)
    (art_dir / "metrics.json").write_text(json.dumps({
        "val_season": val_season, "val_pinball": val_pinball,
        "best_epoch": best_epoch, "complete": complete,
    }))


def test_collect_results_sorts_by_val_pinball_ascending(tmp_path):
    out_root = tmp_path / "sweeps" / "v1"
    combos = [
        {"seq_len": 8, "model.d_model": 64},
        {"seq_len": 16, "model.d_model": 64},
    ]
    name_a, name_b = (combo_run_name(c) for c in combos)
    _write_metrics(out_root, name_a, 2022, val_pinball=0.5, best_epoch=3, complete=True)
    _write_metrics(out_root, name_b, 2022, val_pinball=0.3, best_epoch=5, complete=True)

    results = collect_results(out_root, 2022, combos)
    assert [r["run_name"] for r in results] == [name_b, name_a]
    assert results[0]["val_pinball"] == pytest.approx(0.3)
    assert all(r["complete"] for r in results)


def test_collect_results_flags_incomplete_and_never_started(tmp_path):
    out_root = tmp_path / "sweeps" / "v1"
    combos = [
        {"seq_len": 8, "model.d_model": 64},   # never started: no dir at all
        {"seq_len": 16, "model.d_model": 64},  # interrupted mid-training
        {"seq_len": 8, "model.d_model": 96},   # finished
    ]
    name_never, name_interrupted, name_done = (combo_run_name(c) for c in combos)
    _write_metrics(out_root, name_interrupted, 2022, val_pinball=0.9, best_epoch=1, complete=False)
    _write_metrics(out_root, name_done, 2022, val_pinball=0.2, best_epoch=4, complete=True)

    results = collect_results(out_root, 2022, combos)
    by_name = {r["run_name"]: r for r in results}

    assert by_name[name_never]["val_pinball"] is None
    assert by_name[name_never]["complete"] is False
    assert by_name[name_interrupted]["val_pinball"] == pytest.approx(0.9)
    assert by_name[name_interrupted]["complete"] is False
    assert by_name[name_done]["complete"] is True
    # never-started (no metric at all) must sort after any run with a real number
    names_in_order = [r["run_name"] for r in results]
    assert names_in_order[-1] == name_never
    assert names_in_order[0] == name_done  # lowest val_pinball wins


def test_write_results_round_trips_schema(tmp_path):
    rows = [
        {"run_name": "seq8_d64_l2_lr3e-04", "params": {"seq_len": 8}, "val_pinball": 0.3,
         "best_epoch": 5, "complete": True},
        {"run_name": "seq16_d64_l2_lr3e-04", "params": {"seq_len": 16}, "val_pinball": None,
         "best_epoch": None, "complete": False},
    ]
    path = tmp_path / "results.json"
    write_results(path, rows)
    loaded = json.loads(path.read_text())
    assert loaded == rows


def test_format_leaderboard_contains_key_fields():
    rows = [
        {"run_name": "seq8_d64_l2_lr3e-04", "params": {}, "val_pinball": 0.314159,
         "best_epoch": 5, "complete": True},
        {"run_name": "seq16_d64_l2_lr3e-04", "params": {}, "val_pinball": None,
         "best_epoch": None, "complete": False},
    ]
    table = format_leaderboard(rows)
    assert "seq8_d64_l2_lr3e-04" in table
    assert "seq16_d64_l2_lr3e-04" in table
    assert "0.3142" in table
    assert "False" in table  # incomplete row flagged


def test_format_leaderboard_handles_empty():
    assert format_leaderboard([]) == "(no results)"


# --- protocol guard --------------------------------------------------------

def test_run_sweep_rejects_val_season_in_grid(tmp_path):
    base = _base_cfg(tmp_path)
    grid = {"val_season": [2023, 2024]}
    with pytest.raises(ValueError, match="val_season"):
        run_sweep(base, grid, tmp_path / "out", pd.DataFrame())


# --- end-to-end (tiny, real training, no eval harness import) -------------

def test_sweep_never_imports_eval_harness():
    """The tuning protocol forbids the sweep from touching held-out test
    seasons via the eval harness -- check actual import statements (not
    just any substring, since the module's own docstring legitimately
    mentions `ffmodel.eval` in prose)."""
    import re

    import ffmodel.model.sweep as sweep_mod
    with open(sweep_mod.__file__, encoding="utf-8") as f:
        src = f.read()
    import_lines = [line for line in src.splitlines()
                    if re.match(r"\s*(import|from)\s+ffmodel\.eval", line)]
    assert import_lines == []


def test_run_sweep_end_to_end_tiny_grid_writes_results_and_leaderboard(tmp_path, capsys):
    features = _synthetic_features()
    base = _cfg(tmp_path, epochs=1)
    out_root = tmp_path / "sweeps" / "v1"
    grid = {"model.n_layers": [1]}  # single combo, matches tiny fixture's own d_model=16

    results = run_sweep(base, grid, out_root, features)

    assert len(results) == 1
    assert results[0]["complete"] is True
    assert results[0]["val_pinball"] is not None

    on_disk = json.loads((out_root / "results.json").read_text())
    assert on_disk == results

    out = capsys.readouterr().out
    assert "val_season" in out or "2022" in out  # protocol banner printed
    assert results[0]["run_name"] in out  # leaderboard printed


def test_run_sweep_partial_failure_is_flagged_not_fatal(tmp_path, capsys):
    """A combo whose train_fn raises (e.g. an OOM on a big d_model) must not
    take down the rest of the sweep -- it should surface as an incomplete
    row in results.json instead."""
    features = _synthetic_features()
    base = _cfg(tmp_path, epochs=1)
    out_root = tmp_path / "sweeps" / "v1"
    grid = {"model.n_layers": [1, 2]}  # two combos

    calls = []

    def flaky_train(cfg, feats):
        calls.append(cfg["run_name"])
        if cfg["model"]["n_layers"] == 2:
            raise RuntimeError("simulated OOM")
        from ffmodel.model.train import train_from_config
        return train_from_config(cfg, feats)

    results = run_sweep(base, grid, out_root, features, train_fn=flaky_train)

    assert len(calls) == 2  # both attempted
    assert len(results) == 2
    by_layers = {r["params"]["model.n_layers"]: r for r in results}
    assert by_layers[1]["complete"] is True
    assert by_layers[2]["complete"] is False
    assert by_layers[2]["val_pinball"] is None
