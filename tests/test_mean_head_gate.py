"""The gate is pre-registered and binding, so its statistics are tested on
hand-computable cases -- a sign flip or a mis-clustered bootstrap would change
a promotion decision silently."""
import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.mean_head_gate import (
    BOOTSTRAP_SEED, paired_bootstrap, weekly_spearman,
)


def _rows(**cols):
    return pd.DataFrame(cols)


def test_weekly_spearman_perfect_and_inverted_ranking():
    """Higher predicted points must mean better, so a perfectly ordered week
    scores +1 and a perfectly reversed week scores -1."""
    rows = _rows(
        season=[2023] * 8,
        week=[1] * 4 + [2] * 4,
        position=["RB"] * 8,
        actual=[10.0, 20.0, 30.0, 40.0, 10.0, 20.0, 30.0, 40.0],
        pred_good=[1.0, 2.0, 3.0, 4.0, 1.0, 2.0, 3.0, 4.0],
        pred_bad=[4.0, 3.0, 2.0, 1.0, 4.0, 3.0, 2.0, 1.0],
    )
    good = weekly_spearman(rows, "pred_good", ["RB"])
    bad = weekly_spearman(rows, "pred_bad", ["RB"])
    assert list(good["spearman"]) == pytest.approx([1.0, 1.0])
    assert list(bad["spearman"]) == pytest.approx([-1.0, -1.0])
    # one row per (season, week, position)
    assert len(good) == 2
    assert set(good.columns) >= {"season", "week", "position", "spearman", "n"}


def test_weekly_spearman_pools_requested_positions_into_one_cell_per_week():
    """RB/WR/TE pooled means ranking WITHIN each position separately, then one
    row per position per week -- not one ranking across mixed positions, which
    would measure position scarcity rather than player skill."""
    rows = _rows(
        season=[2023] * 6, week=[1] * 6,
        position=["RB", "RB", "RB", "WR", "WR", "WR"],
        actual=[10.0, 20.0, 30.0, 10.0, 20.0, 30.0],
        pred=[1.0, 2.0, 3.0, 3.0, 2.0, 1.0],
    )
    out = weekly_spearman(rows, "pred", ["RB", "WR"])
    assert len(out) == 2
    assert set(out["position"]) == {"RB", "WR"}
    assert float(out.loc[out["position"] == "RB", "spearman"].iloc[0]) == pytest.approx(1.0)
    assert float(out.loc[out["position"] == "WR", "spearman"].iloc[0]) == pytest.approx(-1.0)


def test_weekly_spearman_drops_degenerate_weeks():
    """A week with fewer than 3 rows, or with zero variance in actuals, has no
    defined ranking correlation and must be dropped rather than become NaN."""
    rows = _rows(
        season=[2023] * 5, week=[1, 1, 2, 2, 2],
        position=["RB"] * 5,
        actual=[10.0, 20.0, 5.0, 5.0, 5.0],
        pred=[1.0, 2.0, 1.0, 2.0, 3.0],
    )
    out = weekly_spearman(rows, "pred", ["RB"])
    assert len(out) == 0
    assert not out["spearman"].isna().any()


def test_paired_bootstrap_ci_excludes_zero_for_a_clear_effect():
    deltas = np.full(400, 0.05)
    clusters = np.repeat(np.arange(2017, 2026), [45, 45, 45, 45, 44, 44, 44, 44, 44])
    out = paired_bootstrap(deltas, clusters)
    assert out["mean"] == pytest.approx(0.05)
    assert out["ci95"][0] > 0
    assert out["excludes_zero"] is True


def test_paired_bootstrap_ci_includes_zero_for_pure_noise():
    rng = np.random.default_rng(0)
    deltas = rng.normal(0.0, 1.0, 900)
    clusters = np.repeat(np.arange(2017, 2026), 100)
    out = paired_bootstrap(deltas, clusters)
    assert out["ci95"][0] < 0 < out["ci95"][1]
    assert out["excludes_zero"] is False


def test_paired_bootstrap_is_deterministic_under_the_fixed_seed():
    """The gate's verdict must not change between runs of the same data."""
    rng = np.random.default_rng(1)
    deltas = rng.normal(0.01, 0.5, 500)
    clusters = np.repeat(np.arange(2017, 2026), [56] * 8 + [52])
    a = paired_bootstrap(deltas, clusters, seed=BOOTSTRAP_SEED)
    b = paired_bootstrap(deltas, clusters, seed=BOOTSTRAP_SEED)
    assert a["ci95"] == b["ci95"]


def test_paired_bootstrap_resamples_clusters_not_rows():
    """Weeks within a season are correlated. Resampling rows independently
    would understate the SE and manufacture a significant result out of a
    single lucky fold, so the bootstrap must resample whole folds."""
    # One fold carries a large effect, eight are exactly zero. Row-resampling
    # would call this significant; cluster-resampling must not.
    deltas = np.concatenate([np.full(100, 1.0), np.zeros(800)])
    clusters = np.repeat(np.arange(2017, 2026), 100)
    out = paired_bootstrap(deltas, clusters)
    assert out["excludes_zero"] is False


def test_paired_bootstrap_rejects_length_mismatch():
    with pytest.raises(ValueError, match="length"):
        paired_bootstrap(np.zeros(5), np.zeros(4))
