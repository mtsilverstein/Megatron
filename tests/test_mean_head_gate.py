"""The gate is pre-registered and binding, so its statistics are tested on
hand-computable cases -- a sign flip or a mis-clustered bootstrap would change
a promotion decision silently."""
import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.mean_head_gate import (
    BOOTSTRAP_SEED, collect_fold_predictions, paired_bootstrap, weekly_spearman,
)
from ffmodel.eval.splits import walk_forward_splits
from ffmodel.scoring import PREDICTED_STATS


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
    """A week with fewer than 3 rows, with zero variance in actuals, or with
    zero variance in the PREDICTION, has no defined ranking correlation and
    must be dropped rather than become NaN or an invented 0.0."""
    rows = _rows(
        season=[2023] * 8, week=[1, 1, 2, 2, 2, 3, 3, 3],
        position=["RB"] * 8,
        actual=[10.0, 20.0, 5.0, 5.0, 5.0, 10.0, 20.0, 30.0],
        pred=[1.0, 2.0, 1.0, 2.0, 3.0, 5.0, 5.0, 5.0],
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


def _fold_features() -> pd.DataFrame:
    """Three seasons x 2 weeks x 2 positions. Three seasons (not two) so that
    BOTH test seasons below get a non-empty train fold -- an empty train
    would make the leak assertion (train.season.max() < test season)
    vacuous for the first fold."""
    rows = []
    pid = 0
    for season in (2021, 2022, 2023):
        for week in (1, 2):
            for position in ("RB", "WR"):
                row = {"season": season, "week": week, "position": position,
                       "player_id": f"p{pid}"}
                row.update({s: 0.0 for s in PREDICTED_STATS})
                row["receptions"] = 3.0  # PPR reception weight is 1.0, so
                                          # fantasy_points recovers this exactly
                rows.append(row)
                pid += 1
    return pd.DataFrame(rows)


def _make_stub_predictor():
    """Factory for a stub standing in for
    ffmodel.model.predictor.TransformerPredictor. `roots[0]` carries the
    stub's identity ("v1", "mh", or "mh_no_mean") since collect_fold_predictions
    constructs one instance per arm from the same (patched) class. Every
    returned stat frame sets a *distinguishable* `receptions` count and
    zeroes every other column; PPR's reception weight is 1.0, so
    fantasy_points recovers that count exactly -- a swapped column
    assignment in collect_fold_predictions would then show up as a wrong
    literal rather than silently passing. Returns (StubPredictor, instances)
    where `instances` collects every constructed instance in order (v1 first,
    then mh) so a test can inspect what each arm was fit with.
    """
    instances = []

    class StubPredictor:
        def __init__(self, roots, features):
            self.label = roots[0]
            self.features = features
            self.fit_calls = []  # train frames passed to fit(), in fold order
            instances.append(self)

        @property
        def has_mean(self):
            return "no_mean" not in self.label

        def fit(self, train):
            self.fit_calls.append(train)

        def _frame(self, test, receptions):
            frame = pd.DataFrame({s: 0.0 for s in PREDICTED_STATS}, index=test.index)
            frame["receptions"] = receptions
            return frame

        def predict_quantiles(self, test):
            if self.label.startswith("v1"):
                return {"p10": self._frame(test, 1.0),
                        "p50": self._frame(test, 11.0),
                        "p90": self._frame(test, 21.0)}
            return {"p10": self._frame(test, 2.0),
                    "p50": self._frame(test, 12.0),
                    "p90": self._frame(test, 22.0)}

        def predict_point(self, test, arm="A", quantiles=None):
            return self._frame(test, 101.0 if arm == "A" else 102.0)

    return StubPredictor, instances


def test_collect_fold_predictions_index_sourcing_and_leak_safety(monkeypatch):
    """collect_fold_predictions establishes the paired comparison the whole
    gate verdict rests on, so its row identity, per-arm column sourcing, and
    train/test leak-safety all need direct coverage rather than relying on
    downstream tests to notice a mistake here."""
    features = _fold_features()
    test_seasons = [2022, 2023]
    StubPredictor, instances = _make_stub_predictor()
    monkeypatch.setattr("ffmodel.model.predictor.TransformerPredictor", StubPredictor)

    result = collect_fold_predictions(features, ["v1"], ["mh"], test_seasons=test_seasons)

    folds = list(walk_forward_splits(features, test_seasons))

    # (a) every test season's rows carry exactly that fold's test.index.
    for season, train_idx, test_idx in folds:
        season_rows = result[result["season"] == season]
        assert list(season_rows.index) == list(test_idx)

    # (b) v1/mh_a/mh_b derive from the correct sources: each is a distinct
    # literal in the stub, so a swapped assignment (e.g. mh_a reading arm B's
    # frame, or v1 reading the mh predictor) would fail one of these.
    assert (result["v1"] == 11.0).all()     # v1.predict_quantiles(test)["p50"]
    assert (result["mh_a"] == 101.0).all()  # mh.predict_point(test, arm="A")
    assert (result["mh_b"] == 102.0).all()  # mh.predict_point(test, arm="B")
    assert (result["actual"] == 3.0).all()  # scored from real feature data, untouched by the stub

    # fit() must only ever see strictly-prior seasons -- a leak would show up
    # as a fold's recorded train frame containing that fold's test season (or
    # later).
    assert len(instances) == 2  # one v1 instance, one mh instance
    for inst in instances:
        assert len(inst.fit_calls) == len(folds)
        for i, (season, train_idx, test_idx) in enumerate(folds):
            train_frame = inst.fit_calls[i]
            assert train_frame["season"].max() < season, (
                f"fit() saw season {train_frame['season'].max()} on the fold "
                f"testing season {season}"
            )


def test_collect_fold_predictions_rejects_mh_without_mean_head(monkeypatch):
    """A mean-head gate run against ensembles that don't all carry a mean
    head would silently be comparing the wrong thing, so this must raise
    rather than proceed."""
    features = _fold_features()
    StubPredictor, _ = _make_stub_predictor()
    monkeypatch.setattr("ffmodel.model.predictor.TransformerPredictor", StubPredictor)

    with pytest.raises(ValueError, match="no mean head"):
        collect_fold_predictions(features, ["v1"], ["mh_no_mean"], test_seasons=[2022, 2023])
