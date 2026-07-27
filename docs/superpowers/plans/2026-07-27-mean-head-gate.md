# Mean-Head Gate Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pre-registered mean-head gate (`docs/superpowers/specs/2026-07-26-mean-head-design.md` §8) computable, then compute it and write the verdict to `models/diagnostics/mean_head_gate.json`.

**Architecture:** Three layers, bottom-up. (1) `predict_point` becomes usable without recomputing quantiles, and `run_backtest` learns an opt-in `point_arm`. (2) A new `src/ffmodel/eval/mean_head_gate.py` collects **row-level** predictions for the v1 and mean-head ensembles over the same walk-forward folds, computes weekly within-position Spearman, and runs a fold-clustered paired bootstrap — this covers the PRIMARY and guards 1/3/4. (3) Guard 2 refits conformal calibration per fold for the mean-head ensemble and checks p10–p90 coverage, then the CLI assembles the full report and prints the verdict.

**Tech Stack:** Python, pandas, numpy, scipy (`spearmanr`, already a dependency via `eval/weekly_rankings.py`), pytest.

## Global Constraints

Copied verbatim from the spec and CLAUDE.md. Every task's requirements implicitly include this section.

- **The gate is PRE-REGISTERED and BINDING.** Implement exactly what §8 says. Do **not** add a criterion, relax a threshold, soften a comparison, or introduce a tie-break the spec does not name. If the code as specified produces a failing verdict, that is the correct output.
- **Never tune anything against the result.** No knob in this plan may be chosen by looking at the outcome.
- **Walk-forward only.** All splits come from `ffmodel.eval.splits.walk_forward_splits`. Never construct a random split.
- **Existing behavior must not change.** `run_backtest` called without the new argument must produce byte-identical output to today. Prove it with a test.
- Test seasons for the gate: **2017–2025** (9 folds). Fold `test_season = Y` uses artifact `through{Y-1}`.
- v1 roots: `models/transformer/v1`, `v1_s43`, `v1_s44`. Mean-head roots: `models/transformer/mh`, `mh_s43`, `mh_s44`.
- PRIMARY metric: weekly within-position Spearman, **RB/WR/TE pooled**, **Arm A vs v1**. Pass = pooled delta **> 0** AND paired-bootstrap **95% CI excludes zero**.
- GUARDS, all must hold or there is no promotion regardless of the primary:
  1. **No QB harm** — QB weekly Spearman delta CI must **not lie entirely below zero**.
  2. **Bands intact** — after a **fresh per-position conformal refit**, p10–p90 coverage stays in **[0.75, 0.85]** for **every position-season**.
  3. **Points not worse** — pooled PPR MAE delta CI must **not lie entirely above zero**.
  4. **Monotonicity** — p10 ≤ p50 ≤ p90 everywhere.
- **Arm B** is reported alongside, promotable only if it passes the identical gate **and** beats Arm A on the primary; **ties go to Arm A**.
- Higher Spearman = better; **lower** MAE = better. Delta sign convention for this plan: `delta = mean_head − v1` for Spearman (positive is good) and `delta = mean_head − v1` for MAE (**negative** is good). Guard 3 therefore checks the MAE CI does not lie entirely **above** zero.
- Scoring is PPR (`ffmodel.scoring.PPR`). Points come from stat lines via `fantasy_points`; never predict points directly.
- On gate failure: write the negative to `models/diagnostics/mean_head_gate.json` with the rigor of `feature_pack_v2_gate.json`, leave `ARTIFACT_ROOT` on v1, and stop. **Do not retune λ and re-run.**
- Full test suite must be green under `-W error`.
- Run tests with `python -m pytest`. The repo root is the working directory for every command.

---

### Task 1: Reusable point estimates and an opt-in `point_arm` in the harness

Today `TransformerPredictor.predict_point` calls `self.predict_quantiles(test)` internally, and `predict_mean` independently re-runs `build_sequences` over the entire feature frame. A harness that wants both a band and an arm-A point estimate would rebuild sequences three times per fold per predictor. This task makes the quantiles injectable and wires the harness.

**Files:**
- Modify: `src/ffmodel/model/predictor.py` (`TransformerPredictor.predict_point`, around line 292)
- Modify: `src/ffmodel/eval/harness.py` (`Predictor` docstring, `run_backtest`)
- Test: `tests/test_predictor.py` (append), `tests/test_harness.py` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `TransformerPredictor.predict_point(self, test: pd.DataFrame, arm: str = "A", quantiles: dict[str, pd.DataFrame] | None = None) -> pd.DataFrame`
  - `run_backtest(features, predictors, test_seasons, rules=PPR, point_arm: str | None = None) -> pd.DataFrame`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_predictor.py`. Use the **existing** module-scoped `trained_mean` fixture (defined around line 607) — it yields `(root, features)` for a real `predict_mean: true` artifact. Do not invent a new fixture. Follow the setup pattern used by `test_has_mean_true_when_artifact_has_mean_head`.

```python
def test_predict_point_accepts_precomputed_quantiles(trained_mean, monkeypatch):
    """Passing `quantiles=` must give the identical result to letting
    predict_point compute them itself, and must not call predict_quantiles."""
    root, features = trained_mean
    p = TransformerPredictor(root, features)
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]
    p.fit(train)

    baseline = p.predict_point(test, arm="A")

    q = p.predict_quantiles(test)
    calls = []
    real = p.predict_quantiles
    monkeypatch.setattr(p, "predict_quantiles",
                        lambda t: (calls.append(1), real(t))[1])
    injected = p.predict_point(test, arm="A", quantiles=q)

    assert calls == [], "predict_point recomputed quantiles despite being given them"
    pd.testing.assert_frame_equal(baseline, injected)


def test_predict_point_rejects_misaligned_injected_quantiles(trained_mean):
    root, features = trained_mean
    p = TransformerPredictor(root, features)
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]
    p.fit(train)
    q = p.predict_quantiles(test)
    q["p50"] = q["p50"].iloc[::-1]  # same rows, wrong order
    with pytest.raises(ValueError, match="index"):
        p.predict_point(test, arm="A", quantiles=q)
```

Append to `tests/test_harness.py`. That file already builds its frames with the module-level `_toy_features()` helper and already imports `NaiveLast4`, `PREDICTED_STATS`, `run_backtest`, `pytest`, and `pandas as pd` — reuse all of them, add no new fixture and no new import.

```python
class _PointArmPredictor:
    """Quantile predictor that also exposes predict_point, so the harness's
    point_arm path can be exercised without a trained artifact."""
    name = "pointarm"

    def __init__(self, features):
        self.features = features
        self.point_calls = []

    def fit(self, train):
        pass

    def predict(self, test):
        return self.predict_quantiles(test)["p50"]

    def predict_quantiles(self, test):
        base = test[PREDICTED_STATS].astype(float)
        return {"p10": base * 0.5, "p50": base, "p90": base * 1.5}

    def predict_point(self, test, arm="A", quantiles=None):
        self.point_calls.append((arm, quantiles is not None))
        return self.predict_quantiles(test)["p50"] * 2.0


def test_run_backtest_default_is_unchanged_when_point_arm_is_none():
    """The existing p50 path must be byte-identical when point_arm is not passed."""
    features_fixture = _toy_features()
    p = _PointArmPredictor(features_fixture)
    results = run_backtest(features_fixture, [p], test_seasons=[2023])
    assert p.point_calls == [], "predict_point was used without point_arm being set"


def test_run_backtest_point_arm_uses_predict_point_and_reuses_quantiles():
    features_fixture = _toy_features()
    p = _PointArmPredictor(features_fixture)
    results = run_backtest(features_fixture, [p], test_seasons=[2023], point_arm="A")
    assert p.point_calls == [("A", True)], (
        "point_arm must call predict_point once with the already-computed quantiles"
    )
    # bands still come from predict_quantiles, unaffected by the arm
    assert {"p10", "p90"} <= set(results.columns)


def test_run_backtest_point_arm_ignored_for_predictors_without_predict_point():
    """Baselines have no mean head; they must still score through the normal
    path rather than erroring when point_arm is set."""
    features_fixture = _toy_features()
    results = run_backtest(features_fixture, [NaiveLast4()], test_seasons=[2023],
                           point_arm="A")
    assert not results.empty


def test_run_backtest_rejects_unknown_point_arm():
    features_fixture = _toy_features()
    with pytest.raises(ValueError, match="point_arm"):
        run_backtest(features_fixture, [NaiveLast4()], test_seasons=[2023],
                     point_arm="Z")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_harness.py tests/test_predictor.py -v`
Expected: FAIL — `TypeError: predict_point() got an unexpected keyword argument 'quantiles'` and `TypeError: run_backtest() got an unexpected keyword argument 'point_arm'`.

- [ ] **Step 3: Implement `quantiles=` on `predict_point`**

In `src/ffmodel/model/predictor.py`, replace the body of `predict_point`:

```python
    def predict_point(self, test: pd.DataFrame, arm: str = "A",
                      quantiles: dict[str, pd.DataFrame] | None = None) -> pd.DataFrame:
        """The stat line used for POINT estimates (never for bands).

        Arm A swaps in the conditional mean for the touchdown components only;
        arm B for all count components. Yardage always keeps p50 -- switching
        volume components to an expectation measurably hurt RB in prior testing.

        `quantiles`: an already-computed predict_quantiles() result for THIS
        `test` frame. Supplying it avoids a second full build_sequences pass
        over the feature frame, which is the dominant cost when a caller (the
        gate evaluator) needs both the band and the point line. Passing a
        result computed for different rows would silently mix players, so the
        index is validated rather than trusted.
        """
        if arm not in ("A", "B"):
            raise ValueError(f"unknown arm {arm!r} (known: 'A', 'B')")
        if quantiles is None:
            quantiles = self.predict_quantiles(test)
        else:
            for key in QUANTILE_KEYS:
                if key not in quantiles:
                    raise ValueError(f"predict_point: injected quantiles missing {key!r}")
                if not quantiles[key].index.equals(test.index):
                    raise ValueError(
                        f"predict_point: injected {key} index does not match `test`"
                    )
        point = quantiles["p50"].copy()
        if not self.has_mean:
            return point
        means = self.predict_mean(test)
        for stat in (TD_STATS if arm == "A" else COUNT_STATS):
            point[stat] = means[stat]
        return point
```

- [ ] **Step 4: Implement `point_arm` in the harness**

In `src/ffmodel/eval/harness.py`, update the `Predictor` docstring's second paragraph and `run_backtest`. The new signature and the changed block:

```python
def run_backtest(
    features: pd.DataFrame,
    predictors: list[Predictor],
    test_seasons: list[int],
    rules: ScoringRules = PPR,
    point_arm: str | None = None,
) -> pd.DataFrame:
    """`point_arm`: when None (the default) the point estimate is p50, exactly
    as before. When "A" or "B", any predictor exposing `predict_point` supplies
    the point line for that arm instead, and is handed the band's already-
    computed quantiles so nothing is recomputed. Predictors without
    `predict_point` (the baselines) are unaffected -- the arm is a property of
    the mean-head model, not of the backtest, so a baseline must still score.
    Bands always come from predict_quantiles and are never arm-dependent.
    """
    if point_arm not in (None, "A", "B"):
        raise ValueError(f"unknown point_arm {point_arm!r} (known: None, 'A', 'B')")
    tables = []
    for season, train_idx, test_idx in walk_forward_splits(features, test_seasons):
        train, test = features.loc[train_idx], features.loc[test_idx]
        actual = fantasy_points(test[PREDICTED_STATS], rules)
        for predictor in predictors:
            predictor.fit(train)
            if hasattr(predictor, "predict_quantiles"):
                quantile_stats = predictor.predict_quantiles(test)
                if point_arm is not None and hasattr(predictor, "predict_point"):
                    pred_stats = predictor.predict_point(
                        test, arm=point_arm, quantiles=quantile_stats
                    )
                else:
                    pred_stats = quantile_stats["p50"]
            else:
                quantile_stats = None
                pred_stats = predictor.predict(test)
            ...  # rest of the loop body UNCHANGED
```

Keep the remainder of the loop body exactly as it is.

- [ ] **Step 5: Run the tests**

Run: `python -m pytest tests/test_harness.py tests/test_predictor.py -v`
Expected: PASS.

- [ ] **Step 6: Run the full suite under `-W error`**

Run: `python -m pytest -W error -q`
Expected: all green, same count as before plus the new tests.

- [ ] **Step 7: Commit**

```bash
git add src/ffmodel/model/predictor.py src/ffmodel/eval/harness.py tests/test_predictor.py tests/test_harness.py
git commit -m "feat: opt-in point_arm in the backtest harness

predict_point now accepts precomputed quantiles so the gate evaluator can
get a band and an arm point line from one forward pass. run_backtest gains
point_arm, defaulting to None = the existing p50 path unchanged."
```

---

### Task 2: Row-level fold collector, weekly Spearman, and the paired bootstrap

The gate needs per-week within-position Spearman, which `run_backtest` cannot give — it returns per-season aggregates. This task builds the row-level collector and the statistics, covering the PRIMARY and guards 1, 3, and 4.

**Files:**
- Create: `src/ffmodel/eval/mean_head_gate.py`
- Test: `tests/test_mean_head_gate.py` (create)

**Interfaces:**
- Consumes: `TransformerPredictor.predict_point(test, arm, quantiles=...)` from Task 1.
- Produces, all importable from `ffmodel.eval.mean_head_gate`:
  - `collect_fold_predictions(features, v1_roots, mh_roots, test_seasons, rules=PPR) -> pd.DataFrame`
  - `weekly_spearman(rows: pd.DataFrame, pred_col: str, positions: list[str]) -> pd.DataFrame`
  - `paired_bootstrap(deltas, clusters, n_boot=10000, seed=20260727) -> dict`
  - `MH_ROOTS`, `V1_ROOTS`, `TEST_SEASONS`, `BOOTSTRAP_SEED`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_mean_head_gate.py`:

```python
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
        season=[2023] * 4, week=[1] * 4,
        position=["RB", "RB", "WR", "WR"],
        actual=[10.0, 20.0, 30.0, 40.0],
        pred=[1.0, 2.0, 4.0, 3.0],
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_mean_head_gate.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ffmodel.eval.mean_head_gate'`.

- [ ] **Step 3: Implement the module**

Create `src/ffmodel/eval/mean_head_gate.py`:

```python
"""Evaluates the PRE-REGISTERED mean-head gate.

Spec: docs/superpowers/specs/2026-07-26-mean-head-design.md section 8. The
criteria there are BINDING and were committed before any training run. This
module implements them literally; it does not choose thresholds, and nothing
here may be adjusted in response to the result it produces.

Why a separate module rather than run_backtest: the primary criterion is
weekly WITHIN-POSITION Spearman, which needs row-level predictions joined to
their week. run_backtest deliberately returns per-season aggregates, so it
cannot express the primary at all.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from ffmodel.eval.splits import walk_forward_splits
from ffmodel.scoring import PPR, PREDICTED_STATS, ScoringRules, fantasy_points

V1_ROOTS = [Path("models/transformer/v1"), Path("models/transformer/v1_s43"),
            Path("models/transformer/v1_s44")]
MH_ROOTS = [Path("models/transformer/mh"), Path("models/transformer/mh_s43"),
            Path("models/transformer/mh_s44")]
TEST_SEASONS = list(range(2017, 2026))
PRIMARY_POSITIONS = ["RB", "WR", "TE"]
# Fixed so the verdict is reproducible. Chosen as the plan's date before any
# result was seen; it is not a tunable.
BOOTSTRAP_SEED = 20260727
MIN_WEEK_ROWS = 3


def collect_fold_predictions(
    features: pd.DataFrame,
    v1_roots: list[Path],
    mh_roots: list[Path],
    test_seasons: list[int] = TEST_SEASONS,
    rules: ScoringRules = PPR,
) -> pd.DataFrame:
    """One row per test player-week, carrying every arm's PPR point estimate.

    Both ensembles are fitted and scored on the SAME test index inside the same
    walk-forward loop, so the paired comparison the gate depends on cannot drift
    apart through differing row filters.

    Columns: season, week, position, actual, v1, mh_a, mh_b,
             mono_ok (bool, guard 4), plus the mh p10/p90 needed by guard 2.
    """
    from ffmodel.model.predictor import TransformerPredictor

    v1 = TransformerPredictor(v1_roots, features)
    mh = TransformerPredictor(mh_roots, features)
    frames = []
    for season, train_idx, test_idx in walk_forward_splits(features, test_seasons):
        train, test = features.loc[train_idx], features.loc[test_idx]
        v1.fit(train)
        mh.fit(train)
        if not mh.has_mean:
            raise ValueError(
                f"season {season}: the mh ensemble reports no mean head -- "
                f"these are not mean-head artifacts, so the gate is not "
                f"evaluable against them"
            )
        v1_q = v1.predict_quantiles(test)
        mh_q = mh.predict_quantiles(test)
        mh_a = mh.predict_point(test, arm="A", quantiles=mh_q)
        mh_b = mh.predict_point(test, arm="B", quantiles=mh_q)

        # Guard 4: the invariant must hold on the arm that could deploy.
        mono = (
            (mh_q["p10"] <= mh_q["p50"] + 1e-6).all(axis=1)
            & (mh_q["p50"] <= mh_q["p90"] + 1e-6).all(axis=1)
        )
        frames.append(pd.DataFrame({
            "season": season,
            "week": test["week"].to_numpy(),
            "position": test["position"].to_numpy(),
            "actual": fantasy_points(test[PREDICTED_STATS], rules).to_numpy(),
            "v1": fantasy_points(v1_q["p50"], rules).to_numpy(),
            "mh_a": fantasy_points(mh_a, rules).to_numpy(),
            "mh_b": fantasy_points(mh_b, rules).to_numpy(),
            "mh_p10": fantasy_points(mh_q["p10"], rules).to_numpy(),
            "mh_p90": fantasy_points(mh_q["p90"], rules).to_numpy(),
            "mono_ok": mono.to_numpy(),
        }, index=test.index))
    return pd.concat(frames)


def weekly_spearman(rows: pd.DataFrame, pred_col: str,
                    positions: list[str]) -> pd.DataFrame:
    """Within-position Spearman for each (season, week, position) cell.

    Ranking is computed WITHIN a position, never across positions: a pooled
    cross-position ranking would mostly measure that RBs outscore TEs, which is
    not what the model is being judged on.

    Cells with fewer than MIN_WEEK_ROWS rows, or with no variance in `actual`
    or in the prediction, have no defined rank correlation and are DROPPED. They
    are not recorded as 0.0 -- that would be an invented result, and it would
    drag both arms toward zero equally while shrinking the measured effect.
    """
    out = []
    subset = rows[rows["position"].isin(positions)]
    for (season, week, position), cell in subset.groupby(
            ["season", "week", "position"], sort=True):
        if len(cell) < MIN_WEEK_ROWS:
            continue
        actual = cell["actual"].to_numpy()
        pred = cell[pred_col].to_numpy()
        if np.ptp(actual) == 0 or np.ptp(pred) == 0:
            continue
        r = spearmanr(pred, actual).correlation
        if not np.isfinite(r):
            continue
        out.append({"season": int(season), "week": int(week),
                    "position": position, "spearman": float(r), "n": len(cell)})
    return pd.DataFrame(out, columns=["season", "week", "position", "spearman", "n"])


def paired_bootstrap(deltas, clusters, n_boot: int = 10000,
                     seed: int = BOOTSTRAP_SEED) -> dict:
    """Cluster (fold) bootstrap of the mean paired delta.

    Weeks inside a season share a model fit, a data vintage, and a league
    environment, so their deltas are correlated. Resampling rows independently
    would understate the standard error and could turn one lucky fold into a
    significant result -- so whole FOLDS are resampled with replacement, which
    is the resampling unit the spec's "9 paired folds" power statement assumes.
    """
    deltas = np.asarray(deltas, dtype=float)
    clusters = np.asarray(clusters)
    if len(deltas) != len(clusters):
        raise ValueError(
            f"paired_bootstrap: deltas/clusters length mismatch "
            f"({len(deltas)} vs {len(clusters)})"
        )
    if len(deltas) == 0:
        raise ValueError("paired_bootstrap: no rows to bootstrap")
    uniq = np.unique(clusters)
    by_cluster = [deltas[clusters == c] for c in uniq]
    rng = np.random.default_rng(seed)
    means = np.empty(n_boot, dtype=float)
    for b in range(n_boot):
        pick = rng.integers(0, len(by_cluster), len(by_cluster))
        means[b] = np.concatenate([by_cluster[i] for i in pick]).mean()
    lo, hi = np.percentile(means, [2.5, 97.5])
    return {
        "mean": float(deltas.mean()),
        "ci95": [float(lo), float(hi)],
        "n": int(len(deltas)),
        "n_clusters": int(len(uniq)),
        "excludes_zero": bool(lo > 0 or hi < 0),
    }
```

- [ ] **Step 4: Run the tests**

Run: `python -m pytest tests/test_mean_head_gate.py -v`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the full suite under `-W error`**

Run: `python -m pytest -W error -q`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/ffmodel/eval/mean_head_gate.py tests/test_mean_head_gate.py
git commit -m "feat: mean-head gate statistics (weekly Spearman, fold bootstrap)

Row-level fold collector plus the two statistics the pre-registered gate
needs. Bootstrap resamples folds, not rows, matching the spec's 9-paired-fold
power statement."
```

---

### Task 3: Guard 2 conformal refit, verdict assembly, and the CLI

**Files:**
- Modify: `src/ffmodel/eval/mean_head_gate.py`
- Test: `tests/test_mean_head_gate.py` (append)

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces:
  - `refit_coverage(features, mh_roots, test_seasons) -> pd.DataFrame` with columns `season`, `position`, `coverage`, `in_band`
  - `evaluate_gate(rows: pd.DataFrame, coverage: pd.DataFrame) -> dict`
  - `build_parser()`, `main()`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_mean_head_gate.py`:

```python
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
                        "mh_p10": actual[i] - 8, "mh_p90": actual[i] + 8,
                        "mono_ok": mono_ok,
                    })
    return pd.DataFrame(recs)


def _all_good_coverage():
    return pd.DataFrame([
        {"season": s, "position": p, "coverage": 0.80, "in_band": True}
        for s in range(2017, 2026) for p in ("QB", "RB", "WR", "TE")
    ])


def test_gate_passes_when_primary_positive_and_all_guards_hold():
    result = evaluate_gate(_synthetic_rows(effect_a=0.6), _all_good_coverage())
    assert result["primary"]["passed"] is True
    assert all(g["passed"] for g in result["guards"].values())
    assert result["verdict"] == "PROMOTE ARM A"


def test_gate_fails_when_primary_ci_includes_zero():
    result = evaluate_gate(_synthetic_rows(effect_a=0.0), _all_good_coverage())
    assert result["primary"]["passed"] is False
    assert result["verdict"] == "NOT PROMOTED"


def test_guard_2_failure_blocks_promotion_even_with_a_strong_primary():
    """Band damage is the primary architectural risk; a coverage miss must veto
    a promotion the primary would otherwise earn."""
    cov = _all_good_coverage()
    cov.loc[0, ["coverage", "in_band"]] = [0.62, False]
    result = evaluate_gate(_synthetic_rows(effect_a=0.6), cov)
    assert result["primary"]["passed"] is True
    assert result["guards"]["bands_intact"]["passed"] is False
    assert result["verdict"] == "NOT PROMOTED"


def test_guard_4_monotonicity_violation_blocks_promotion():
    rows = _synthetic_rows(effect_a=0.6)
    rows.loc[0, "mono_ok"] = False
    result = evaluate_gate(rows, _all_good_coverage())
    assert result["guards"]["monotonicity"]["passed"] is False
    assert result["verdict"] == "NOT PROMOTED"


def test_guard_1_qb_harm_blocks_promotion():
    """A QB Spearman CI lying ENTIRELY below zero is the failure condition."""
    result = evaluate_gate(_synthetic_rows(effect_a=0.6, qb_effect=-1.2),
                           _all_good_coverage())
    assert result["guards"]["no_qb_harm"]["passed"] is False
    assert result["verdict"] == "NOT PROMOTED"


def test_arm_b_reported_but_loses_ties_to_arm_a():
    """Spec: ties go to Arm A. Equal arms must promote A, not B."""
    rows = _synthetic_rows(effect_a=0.6)
    rows["mh_b"] = rows["mh_a"]
    result = evaluate_gate(rows, _all_good_coverage())
    assert "arm_b" in result
    assert result["verdict"] == "PROMOTE ARM A"


def test_arm_b_promoted_only_when_it_passes_and_strictly_beats_arm_a():
    result = evaluate_gate(_synthetic_rows(effect_a=0.3, effect_b=1.2),
                           _all_good_coverage())
    assert result["verdict"] == "PROMOTE ARM B"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_mean_head_gate.py -v`
Expected: FAIL — `ImportError: cannot import name 'evaluate_gate'`.

- [ ] **Step 3: Implement `refit_coverage`**

Append to `src/ffmodel/eval/mean_head_gate.py`:

```python
COVERAGE_BAND = (0.75, 0.85)


def refit_coverage(features: pd.DataFrame, mh_roots: list[Path],
                   test_seasons: list[int] = TEST_SEASONS,
                   rules: ScoringRules = PPR) -> pd.DataFrame:
    """Guard 2: fresh per-position conformal refit, then held-out coverage.

    The factors are fit on the fold's VALIDATION season (the last training
    season, which is what the artifact was early-stopped on) and applied to the
    held-out test season. Fitting them on the test season would be circular --
    coverage would land in band by construction and the guard would be vacuous.

    `calibration=False` on the fitting predictor is required: fit_calibration
    must see the RAW band, not one an existing calibration.json already scaled.
    """
    from ffmodel.model.calibrate import fit_calibration
    from ffmodel.model.predictor import TransformerPredictor

    out = []
    for season, train_idx, test_idx in walk_forward_splits(features, test_seasons):
        train, test = features.loc[train_idx], features.loc[test_idx]
        val_season = int(train["season"].max())
        val = train[train["season"] == val_season]

        raw = TransformerPredictor(mh_roots, features, calibration=False)
        raw.fit(train)

        val_q = raw.predict_quantiles(val)
        factors = fit_calibration(
            val_q, fantasy_points(val[PREDICTED_STATS], rules),
            val["position"], rules,
        )["per_position"]

        test_q = raw.predict_quantiles(test)
        s_lo = test["position"].map(lambda p: factors[p]["s_lo"])
        s_hi = test["position"].map(lambda p: factors[p]["s_hi"])
        p10, p50, p90 = test_q["p10"], test_q["p50"], test_q["p90"]
        lo = p50 - (p50 - p10).mul(s_lo, axis=0)
        hi = p50 + (p90 - p50).mul(s_hi, axis=0)
        floor, ceil = fantasy_points_band(lo, hi, rules)
        actual = fantasy_points(test[PREDICTED_STATS], rules)

        covered = ((actual >= floor) & (actual <= ceil)).groupby(
            test["position"]).mean()
        for position, value in covered.items():
            out.append({
                "season": int(season), "position": position,
                "coverage": float(value),
                "in_band": bool(COVERAGE_BAND[0] <= value <= COVERAGE_BAND[1]),
            })
    return pd.DataFrame(out)
```

Add `fantasy_points_band` to the existing `from ffmodel.scoring import ...` line at the top of the module.

- [ ] **Step 4: Implement `evaluate_gate`**

Append to `src/ffmodel/eval/mean_head_gate.py`:

```python
def _spearman_delta(rows: pd.DataFrame, arm_col: str,
                    positions: list[str]) -> dict:
    """Paired per-cell Spearman delta (arm - v1), bootstrapped by fold.

    Both arms are scored on the SAME cells: a cell dropped as degenerate for
    one arm is dropped for both, via an inner join on (season, week, position).
    An outer join would compare different populations and quietly bias the
    delta toward whichever arm survived the marginal weeks.
    """
    key = ["season", "week", "position"]
    base = weekly_spearman(rows, "v1", positions)
    arm = weekly_spearman(rows, arm_col, positions)
    merged = base.merge(arm, on=key, suffixes=("_v1", "_arm"))
    delta = merged["spearman_arm"] - merged["spearman_v1"]
    stats = paired_bootstrap(delta.to_numpy(), merged["season"].to_numpy())
    stats["v1_mean"] = float(merged["spearman_v1"].mean())
    stats["arm_mean"] = float(merged["spearman_arm"].mean())
    stats["cells"] = int(len(merged))
    return stats


def _mae_delta(rows: pd.DataFrame, arm_col: str) -> dict:
    """Guard 3, pooled over all positions. Negative delta = the arm is better."""
    delta = (rows[arm_col] - rows["actual"]).abs() - (rows["v1"] - rows["actual"]).abs()
    stats = paired_bootstrap(delta.to_numpy(), rows["season"].to_numpy())
    stats["v1_mae"] = float((rows["v1"] - rows["actual"]).abs().mean())
    stats["arm_mae"] = float((rows[arm_col] - rows["actual"]).abs().mean())
    return stats


def _arm_result(rows: pd.DataFrame, coverage: pd.DataFrame, arm_col: str) -> dict:
    primary = _spearman_delta(rows, arm_col, PRIMARY_POSITIONS)
    # PRIMARY: pooled delta > 0 AND the 95% CI excludes zero.
    primary["passed"] = bool(primary["mean"] > 0 and primary["ci95"][0] > 0)

    qb = _spearman_delta(rows, arm_col, ["QB"])
    # Guard 1 FAILS only if the CI lies ENTIRELY below zero.
    qb_ok = not (qb["ci95"][1] < 0)

    bad_cov = coverage[~coverage["in_band"]]
    mae = _mae_delta(rows, arm_col)
    # Guard 3 FAILS only if the CI lies ENTIRELY above zero (significantly worse).
    mae_ok = not (mae["ci95"][0] > 0)
    mono_violations = int((~rows["mono_ok"]).sum())

    guards = {
        "no_qb_harm": {"passed": bool(qb_ok), **qb},
        "bands_intact": {
            "passed": bool(bad_cov.empty),
            "band": list(COVERAGE_BAND),
            "position_seasons_checked": int(len(coverage)),
            "out_of_band": bad_cov.to_dict(orient="records"),
        },
        "points_not_worse": {"passed": bool(mae_ok), **mae},
        "monotonicity": {"passed": mono_violations == 0,
                         "violations": mono_violations},
    }
    return {"primary": primary, "guards": guards,
            "passed": bool(primary["passed"] and all(g["passed"] for g in guards.values()))}


def evaluate_gate(rows: pd.DataFrame, coverage: pd.DataFrame) -> dict:
    """Apply the binding gate. Arm A is the candidate; Arm B is reported and is
    promotable only if it passes the identical gate AND strictly beats Arm A on
    the primary. Ties go to Arm A (spec section 8: fewer components changed)."""
    a = _arm_result(rows, coverage, "mh_a")
    b = _arm_result(rows, coverage, "mh_b")

    if b["passed"] and b["primary"]["mean"] > a["primary"]["mean"]:
        verdict = "PROMOTE ARM B"
    elif a["passed"]:
        verdict = "PROMOTE ARM A"
    else:
        verdict = "NOT PROMOTED"

    return {"verdict": verdict, "primary": a["primary"], "guards": a["guards"],
            "arm_a": a, "arm_b": b}
```

- [ ] **Step 5: Implement the CLI**

Append to `src/ffmodel/eval/mean_head_gate.py`:

```python
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Evaluate the PRE-REGISTERED mean-head gate (spec 2026-07-26 section 8).")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--last-season", type=int, default=2025)
    parser.add_argument("--out", type=Path,
                        default=Path("models/diagnostics/mean_head_gate.json"))
    return parser


def main() -> None:
    args = build_parser().parse_args()
    seasons = list(range(args.first_season, args.last_season + 1))
    features = build_features(pull_weekly(seasons, cache_dir=args.data_dir),
                              pull_schedules(seasons, cache_dir=args.data_dir))

    rows = collect_fold_predictions(features, V1_ROOTS, MH_ROOTS, TEST_SEASONS)
    coverage = refit_coverage(features, MH_ROOTS, TEST_SEASONS)
    result = evaluate_gate(rows, coverage)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "experiment": "mean-head",
        "spec": "docs/superpowers/specs/2026-07-26-mean-head-design.md",
        "verdict": result["verdict"],
        "pre_registered_rule": {
            "recorded_before_results": True,
            "primary": "weekly within-position Spearman, RB/WR/TE pooled, Arm A "
                       "vs v1: pooled delta > 0 with a paired-bootstrap 95% CI "
                       "excluding zero",
            "guards": ["no QB harm", "p10-p90 coverage in [0.75, 0.85] for every "
                       "position-season after a fresh conformal refit",
                       "pooled PPR MAE not significantly worse",
                       "p10 <= p50 <= p90 everywhere"],
            "mde": "SE ~0.007-0.010 over 9 paired folds resolves ~+0.02 Spearman "
                   "at 95%; a failure means 'no effect of ~0.02 or larger', not "
                   "'no effect'",
            "bootstrap_seed": BOOTSTRAP_SEED,
            "bootstrap_unit": "fold (season), not row",
        },
        "artifacts_evaluated": {
            "mh_roots": [p.as_posix() for p in MH_ROOTS],
            "v1_roots": [p.as_posix() for p in V1_ROOTS],
            "test_seasons": TEST_SEASONS,
        },
        "arm_a": result["arm_a"],
        "arm_b": result["arm_b"],
        "coverage_refit": coverage.to_dict(orient="records"),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))

    print(f"VERDICT: {result['verdict']}")
    p = result["primary"]
    print(f"primary  delta={p['mean']:+.4f}  ci95=[{p['ci95'][0]:+.4f}, "
          f"{p['ci95'][1]:+.4f}]  cells={p['cells']}")
    for name, g in result["guards"].items():
        print(f"guard {name:<18} {'PASS' if g['passed'] else 'FAIL'}")
    print(f"\nreport -> {args.out}")


if __name__ == "__main__":
    main()
```

Add these imports at the top of the module: `argparse`, `json`, `from datetime import datetime, timezone`, `from ffmodel.data.features import build_features`, `from ffmodel.data.pull import pull_schedules, pull_weekly`.

- [ ] **Step 6: Run the tests**

Run: `python -m pytest tests/test_mean_head_gate.py -v`
Expected: PASS, 15 tests.

- [ ] **Step 7: Run the full suite under `-W error`**

Run: `python -m pytest -W error -q`
Expected: green.

- [ ] **Step 8: Verify the CLI is wired**

Run: `python -m ffmodel.eval.mean_head_gate --help`
Expected: the argparse help text prints without an ImportError.

Do **not** run the full gate here — that is the controller's step after review.

- [ ] **Step 9: Commit**

```bash
git add src/ffmodel/eval/mean_head_gate.py tests/test_mean_head_gate.py
git commit -m "feat: mean-head gate guards, verdict assembly, and CLI

Guard 2 refits conformal factors on each fold's validation season and checks
held-out coverage, so the guard is not circular. Verdict follows spec section 8
literally, including arm-B ties going to arm A."
```

---

## Post-plan (controller, not a task)

After Task 3's review is clean, run the gate for real:

```bash
python -m ffmodel.eval.mean_head_gate
```

Then commit `models/diagnostics/mean_head_gate.json` and report the verdict honestly, whichever way it lands. If it fails, `ARTIFACT_ROOT` stays on v1 and the experiment stops — no λ retune, no re-run.
