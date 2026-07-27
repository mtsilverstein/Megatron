"""The gate is pre-registered and binding, so its statistics are tested on
hand-computable cases -- a sign flip or a mis-clustered bootstrap would change
a promotion decision silently."""
import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.mean_head_gate import (
    BOOTSTRAP_SEED, _mae_ok, _primary_passed, _qb_ok, _validate_test_seasons,
    collect_fold_predictions, paired_bootstrap, refit_coverage, weekly_spearman,
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


def test_weekly_spearman_drops_degenerate_weeks(recwarn):
    """A week with fewer than 3 rows, with zero variance in actuals, or with
    zero variance in the PREDICTION, has no defined ranking correlation and
    must be dropped rather than become NaN or an invented 0.0.

    The zero-variance-in-PREDICTION week (week 3) must be caught by an
    explicit `np.ptp(pred) == 0` check BEFORE it reaches scipy. scipy's
    spearmanr on a constant array also returns nan (which weekly_spearman's
    `np.isfinite(r)` check would drop too), so under a plain `pytest` run
    len(out) == 0 would hold either way -- deleting the explicit guard only
    shows up as a test failure when scipy's ConstantInputWarning is promoted
    to an error, which happens under `-W error` but not by default. Recording
    warnings with `recwarn` (a stock pytest fixture, no external flag needed)
    and asserting none were raised gives this case teeth unconditionally.
    """
    rows = _rows(
        season=[2023] * 8, week=[1, 1, 2, 2, 2, 3, 3, 3],
        position=["RB"] * 8,
        actual=[10.0, 20.0, 5.0, 5.0, 5.0, 10.0, 20.0, 30.0],
        pred=[1.0, 2.0, 1.0, 2.0, 3.0, 5.0, 5.0, 5.0],
    )
    out = weekly_spearman(rows, "pred", ["RB"])
    assert len(out) == 0
    assert not out["spearman"].isna().any()
    assert len(recwarn) == 0


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

    `__init__` accepts an optional `calibration` kwarg (mirroring
    TransformerPredictor's real signature) purely so refit_coverage's
    `TransformerPredictor(mh_roots, features, calibration=False)` call has
    something to bind to; it is recorded on the instance as `.calibration`
    and otherwise has no effect on the stub's behavior.
    """
    instances = []

    class StubPredictor:
        def __init__(self, roots, features, calibration=True):
            self.label = roots[0]
            self.features = features
            self.calibration = calibration
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
            # 101.0 (arm A) sits OUTSIDE the mh band [2.0, 22.0] built from
            # predict_quantiles above; 12.0 (arm B) sits INSIDE it -- chosen
            # so a test can distinguish point_in_band_a from point_in_band_b
            # (both would otherwise be coincidentally equal).
            return self._frame(test, 101.0 if arm == "A" else 12.0)

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
    assert (result["mh_b"] == 12.0).all()   # mh.predict_point(test, arm="B")
    assert (result["actual"] == 3.0).all()  # scored from real feature data, untouched by the stub

    # point_in_band_{a,b} (Minor-1 fix) must each come from THEIR OWN arm's
    # point line against the shared (p10, p90) band [2.0, 22.0] receptions
    # -- arm A's line (101.0) sits outside it, arm B's (12.0) sits inside it.
    # Reusing arm A's column for arm B (the pre-fix bug) would make the
    # second assertion below fail.
    assert (result["point_in_band_a"] == False).all()  # noqa: E712
    assert (result["point_in_band_b"] == True).all()   # noqa: E712

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


def test_refit_coverage_fits_on_validation_season_scores_on_test_season(monkeypatch):
    """Guard 2's non-circularity rests on two invariants that previously had
    zero test coverage: (a) the raw predictor used to fit calibration factors
    must be constructed with calibration=False (otherwise fit_calibration
    would fit against a band an existing calibration.json already scaled),
    and (b)/(c) the factors must be fit on the fold's VALIDATION season (the
    last train season) and applied to the held-out TEST season -- fitting on
    the test season would be circular and make the guard vacuous by
    construction."""
    features = _fold_features()
    test_seasons = [2022, 2023]
    StubPredictor, instances = _make_stub_predictor()
    monkeypatch.setattr("ffmodel.model.predictor.TransformerPredictor", StubPredictor)

    fit_calibration_calls = []

    def _stub_fit_calibration(quantiles, actual, positions, rules):
        fit_calibration_calls.append({
            "index": positions.index,
            "seasons": set(features.loc[positions.index, "season"].unique()),
        })
        return {"per_position": {p: {"s_lo": 1.0, "s_hi": 1.0}
                                  for p in positions.unique()}}

    monkeypatch.setattr("ffmodel.model.calibrate.fit_calibration", _stub_fit_calibration)

    coverage = refit_coverage(features, ["mh"], test_seasons=test_seasons)

    folds = list(walk_forward_splits(features, test_seasons))

    # (a) the fitting predictor must be constructed with calibration=False.
    assert len(instances) == len(folds)  # one raw predictor per fold
    for inst in instances:
        assert inst.calibration is False

    # (b) fit_calibration must see ONLY the fold's validation season's rows
    # (the last train season), never a mix of seasons and never the test
    # season.
    assert len(fit_calibration_calls) == len(folds)
    for call, (season, train_idx, test_idx) in zip(fit_calibration_calls, folds):
        val_season = int(features.loc[train_idx, "season"].max())
        assert call["seasons"] == {val_season}
        assert val_season != season  # validation season is never the test season

    # (c) the coverage rows returned come only from the TEST season, never
    # the validation season the factors were fit on.
    assert set(coverage["season"]) == set(test_seasons)


from ffmodel.eval.mean_head_gate import evaluate_gate


def _synthetic_rows(effect_a: float, effect_b: float = 0.0, qb_effect: float = 0.0,
                    mae_penalty: float = 0.0, mono_ok: bool = True):
    """Nine folds x 17 weeks x 4 positions x 6 players, with a controllable
    ranking edge for each arm so the verdict logic can be driven directly."""
    rng = np.random.default_rng(7)
    recs = []
    for season in range(2017, 2026):
        for week in range(1, 18):
            for position in ("QB", "RB", "WR", "TE"):
                actual = rng.normal(12, 6, 6)
                base = actual + rng.normal(0, 4, 6)
                eff = qb_effect if position == "QB" else effect_a
                for i in range(6):
                    recs.append({
                        "season": season, "week": week, "position": position,
                        "actual": actual[i],
                        "v1": base[i],
                        "mh_a": base[i] + eff * (actual[i] - actual.mean()) + mae_penalty,
                        "mh_b": base[i] + effect_b * (actual[i] - actual.mean()),
                        "mono_ok": mono_ok,
                        "point_in_band_a": True,
                        "point_in_band_b": True,
                    })
    return pd.DataFrame(recs)


def _all_good_coverage():
    return pd.DataFrame([
        {"season": s, "position": p, "coverage": 0.80, "in_band": True}
        for s in range(2017, 2026) for p in ("QB", "RB", "WR", "TE")
    ])


def test_gate_passes_when_primary_positive_and_all_guards_hold():
    # NOTE: effect_a=0.03, not the plan's 0.6. _synthetic_rows adds
    # eff*(actual-mean) to a prediction that is otherwise pure noise around
    # `actual`; since that term is independent of the noise, ANY eff != 0
    # strictly inflates the error variance and therefore the pooled MAE, so
    # a large eff (0.6, or even 0.1) makes points_not_worse fail every time
    # -- it is not possible for this generator to produce "primary passes AND
    # all guards hold" at eff=0.6. 0.03 keeps the primary's CI clearly
    # excluding zero while keeping the MAE guard's CI straddling zero
    # (verified: primary mean 0.0092 ci95 [0.0055, 0.0128]; MAE-guard mean
    # 0.0026 ci95 [-0.0031, 0.0078]). No assertion below was changed.
    result = evaluate_gate(_synthetic_rows(effect_a=0.03), _all_good_coverage())
    assert result["primary"]["passed"] is True
    assert all(g["passed"] for g in result["guards"].values())
    assert result["verdict"] == "PROMOTE ARM A"


def test_gate_fails_when_primary_ci_includes_zero():
    result = evaluate_gate(_synthetic_rows(effect_a=0.0), _all_good_coverage())
    assert result["primary"]["passed"] is False
    assert result["verdict"] == "NOT PROMOTED"


def test_guard_2_failure_blocks_promotion_even_with_a_strong_primary():
    """Band damage is the primary architectural risk; a coverage miss must veto
    a promotion the primary would otherwise earn.

    effect_a=0.03, not 0.6: at 0.6, points_not_worse (guard 3) also fails
    unconditionally (see test_gate_passes_... above), which would make
    `verdict == "NOT PROMOTED"` forced by guard 3 rather than by the
    coverage miss this test claims to exercise -- deleting bands_intact from
    the `all(...)` conjunction in _arm_result would then leave this test
    green. 0.03 keeps every OTHER guard and the primary passing, so
    bands_intact is the only thing standing between arm A and promotion."""
    cov = _all_good_coverage()
    cov.loc[0, ["coverage", "in_band"]] = [0.62, False]
    result = evaluate_gate(_synthetic_rows(effect_a=0.03), cov)
    assert result["primary"]["passed"] is True
    assert result["guards"]["bands_intact"]["passed"] is False
    assert result["arm_a"]["passed"] is False
    assert result["verdict"] == "NOT PROMOTED"


def test_guard_4_monotonicity_violation_blocks_promotion():
    """effect_a=0.03, not 0.6 -- same over-determination as
    test_guard_2_failure_... above: 0.6 fails points_not_worse independently,
    so this needs the smaller magnitude to isolate monotonicity as the sole
    failing guard."""
    rows = _synthetic_rows(effect_a=0.03)
    rows.loc[0, "mono_ok"] = False
    result = evaluate_gate(rows, _all_good_coverage())
    assert result["guards"]["monotonicity"]["passed"] is False
    assert result["arm_a"]["passed"] is False
    assert result["verdict"] == "NOT PROMOTED"


def test_guard_1_qb_harm_blocks_promotion():
    """A QB Spearman CI lying ENTIRELY below zero is the failure condition.

    effect_a=0.03 and qb_effect=-0.05, not 0.6/-1.2 -- same over-determination
    as the guard-2 and guard-4 tests above: effect_a=0.6 fails points_not_worse
    independently of qb_effect, so this needs the smaller magnitude to isolate
    no_qb_harm as the sole failing guard."""
    result = evaluate_gate(_synthetic_rows(effect_a=0.03, qb_effect=-0.05),
                           _all_good_coverage())
    assert result["guards"]["no_qb_harm"]["passed"] is False
    assert result["arm_a"]["passed"] is False
    assert result["verdict"] == "NOT PROMOTED"


def test_arm_b_reported_but_loses_ties_to_arm_a():
    """Spec: ties go to Arm A. Equal arms must promote A, not B."""
    # effect_a=0.03 for the same reason as test_gate_passes_... above: arm A
    # must fully pass (including points_not_worse) for "PROMOTE ARM A" to be
    # reachable at all, and 0.6 makes points_not_worse fail unconditionally.
    rows = _synthetic_rows(effect_a=0.03)
    rows["mh_b"] = rows["mh_a"]
    result = evaluate_gate(rows, _all_good_coverage())
    assert "arm_b" in result
    assert result["verdict"] == "PROMOTE ARM A"


def test_arm_b_promoted_only_when_it_passes_and_strictly_beats_arm_a():
    # NOTE: effect_a=0.02, effect_b=0.05, not the plan's 0.3/1.2 -- see the
    # note in test_gate_passes_when_primary_positive_and_all_guards_hold:
    # any eff large enough to give a big Spearman edge also inflates pooled
    # MAE past the guard-3 boundary, so effect_b=1.2 makes arm B fail its own
    # points_not_worse guard and the verdict can never be "PROMOTE ARM B".
    # These magnitudes keep arm B's own gate passing (verified: guard-3 mean
    # 0.0072 ci95 [-0.0021, 0.0156]) while still giving it a strictly larger
    # primary mean than arm A's (0.0131 vs 0.0066).
    result = evaluate_gate(_synthetic_rows(effect_a=0.02, effect_b=0.05),
                           _all_good_coverage())
    assert result["verdict"] == "PROMOTE ARM B"


def test_arm_result_diagnostic_reads_its_own_arm_band_escape_not_arm_as():
    """Minor-1 regression: arm B's point_line_outside_band diagnostic must
    come from arm B's OWN spliced point line (point_in_band_b), never arm
    A's (point_in_band_a) -- the pre-fix bug read rows["point_in_band"]
    (arm A's only) for both arms, which would understate arm B's true
    band-escape rate in the permanent record. This is non-gating (it must
    not affect `passed` or the verdict), so both arms are made to otherwise
    pass identically and only the diagnostic count is compared."""
    rows = _synthetic_rows(effect_a=0.03)
    rows["point_in_band_a"] = True    # arm A never escapes its band
    rows["point_in_band_b"] = False   # arm B escapes its band on every row
    result = evaluate_gate(rows, _all_good_coverage())
    assert result["arm_a"]["diagnostics"]["point_line_outside_band"] == 0
    assert result["arm_b"]["diagnostics"]["point_line_outside_band"] == len(rows)
    # still non-gating: this must not have changed the verdict logic.
    assert result["arm_a"]["passed"] is True
    assert result["verdict"] == "PROMOTE ARM A"


# ---------------------------------------------------------------------------
# _primary_passed / _qb_ok / _mae_ok: the three asymmetric guard predicates,
# unit-tested directly against hand-built stats dicts. _synthetic_rows cannot
# reach a CI lying entirely ABOVE zero for the primary or entirely BELOW zero
# for points_not_worse without also tripping other guards, so these dicts are
# constructed by hand to hit every branch, including the exact-zero boundary.
# ---------------------------------------------------------------------------

def _stats(mean, lo, hi):
    return {"mean": mean, "ci95": [lo, hi],
            "excludes_zero": bool(lo > 0 or hi < 0)}


def test_primary_passed_requires_mean_positive_and_ci_entirely_above_zero():
    # CI entirely BELOW zero (arm significantly worse): must fail.
    assert _primary_passed(_stats(-1.0, -2.0, -0.5)) is False
    # CI straddling zero: must fail.
    assert _primary_passed(_stats(0.1, -0.5, 0.7)) is False
    # CI entirely ABOVE zero with a positive mean: must pass.
    assert _primary_passed(_stats(1.0, 0.5, 1.5)) is True
    # Boundary: ci95[0] exactly 0.0 -- not strictly > 0, must fail.
    assert _primary_passed(_stats(0.5, 0.0, 1.0)) is False
    # Boundary: mean exactly 0.0 with a positive-looking CI lower bound --
    # must fail on the `mean > 0` conjunct.
    assert _primary_passed(_stats(0.0, 0.1, 1.0)) is False
    # The conjunct this predicate exists to enforce: ci95[0] > 0 but mean is
    # NOT > 0 (only reachable via a hand-built dict; paired_bootstrap's own
    # mean always sits inside its own CI). Dropping the `mean > 0` conjunct
    # (one of the mutants this test must kill) would wrongly pass this.
    assert _primary_passed(_stats(-0.5, 0.1, 0.9)) is False


def test_qb_ok_fails_only_when_ci_lies_entirely_below_zero():
    # CI entirely BELOW zero: guard fails.
    assert _qb_ok(_stats(-1.0, -2.0, -0.5)) is False
    # CI straddling zero: guard passes.
    assert _qb_ok(_stats(0.0, -0.5, 0.5)) is True
    # CI entirely ABOVE zero (QB significantly helped): guard passes -- this
    # guard exists to catch harm, not to require QB improvement.
    assert _qb_ok(_stats(1.0, 0.5, 1.5)) is True
    # Boundary: hi exactly 0.0 -- not strictly < 0, so not "entirely below
    # zero" yet; guard passes.
    assert _qb_ok(_stats(-0.5, -1.0, 0.0)) is True


def test_mae_ok_fails_only_when_ci_lies_entirely_above_zero():
    # CI entirely BELOW zero (arm significantly BETTER on points): guard
    # passes -- this is the asymmetry a symmetric `not excludes_zero` check
    # would get wrong.
    assert _mae_ok(_stats(-1.0, -2.0, -0.5)) is True
    # CI straddling zero: guard passes.
    assert _mae_ok(_stats(0.0, -0.5, 0.5)) is True
    # CI entirely ABOVE zero (arm significantly WORSE on points): guard fails.
    assert _mae_ok(_stats(1.0, 0.5, 1.5)) is False
    # Boundary: lo exactly 0.0 -- not strictly > 0, so not "entirely above
    # zero" yet; guard passes.
    assert _mae_ok(_stats(0.5, 0.0, 1.0)) is True


def test_validate_test_seasons_raises_a_clear_error_naming_missing_seasons():
    """Minor-3: --last-season narrower than TEST_SEASONS must fail fast with
    a legible message naming the missing seasons, not a TypeError deep inside
    refit_coverage after a full inference pass."""
    features = pd.DataFrame({"season": [2017, 2018, 2019, 2020]})
    with pytest.raises(ValueError, match=r"2021, 2022"):
        _validate_test_seasons(features, [2017, 2018, 2019, 2020, 2021, 2022])


def test_validate_test_seasons_passes_when_every_season_is_present():
    features = pd.DataFrame({"season": [2017, 2018, 2019]})
    _validate_test_seasons(features, [2017, 2018, 2019])  # must not raise
