# Conditional-mean heads for zero-inflated scoring components — design

**Date:** 2026-07-26
**Status:** approved design, PRE-REGISTERED, pre-training
**Supersedes as the live lever:** `2026-07-22-loss-rebalance-design.md` (RETRACTED)

> **Pre-registration notice.** This document is written and committed **before
> any training run**. The gate in §8 is binding. If it fails, the result is an
> honest negative recorded in `models/diagnostics/` and the site keeps v1. The
> experiment is **not** re-run with adjusted knobs afterwards — that is
> p-hacking, and the FPv2 precedent (`2026-07-21`) explicitly forbids it.
>
> **Revised 2026-07-26, still pre-training** (no run has executed): the fold
> count was raised from 6 to **9** and a minimum-detectable-effect statement
> added (§8), after the GPU budget constraint was lifted. Power is the
> project's recurring failure mode — FPv2 died undecidable at SE 0.028 — so
> buying folds is the highest-value use of an unconstrained budget. Nothing
> else changed; no result informed this edit.

## 1. Context & the premise this replaces

The model's board ranking loses to expert consensus. A long-standing hypothesis
blamed the **QB** gap on collapsed touchdown heads. **That premise was measured
on 2026-07-26 and falsified** — recorded here because the falsification is what
justifies the present scope:

| | share of *positive expected points* in median-zero components | share of *between-player ranking variance* in median-zero components |
|---|---|---|
| **QB** | **5.3%** | **+8.5%** |
| RB | 22.2% | +25.3% |
| TE | 19.8% | +20.9% |
| WR | 18.6% | +19.7% |

QB passing TDs are zero in only 31.5% of games, so their median is ≥ 1 — never
collapsed. ~80% of QB ranking variance sits in `passing_tds` (+42.0%) and
`passing_yards` (+38.1%), both healthy. **A touchdown-head fix cannot move the
QB gap.** (QB's likely cause is *information*, not mechanism: QB season-to-season
points stability is the worst of the four positions, 0.510 vs RB 0.751 / WR
0.747 / TE 0.699 — consistent with the project's established through-line that
the ranking ceiling is set by information absent from the box score. Out of
scope here.)

What the same measurements **do** support is a real defect for **RB/WR/TE**,
where 20–25% of ranking variance lives in components whose median is zero.

## 2. The actual defect (mathematical, not empirical guesswork)

Fantasy points are **linear** in stat components: `points = Σ wᵢ·Xᵢ`. Therefore
`E[points] = Σ wᵢ·E[Xᵢ]` — but `median(Σ Xᵢ) ≠ Σ median(Xᵢ)`. We build the point
estimate by scoring the **p50 stat line**, which is the second (invalid) form.

For a zero-inflated component (a receiving TD occurs in ~18% of WR games), the
conditional median is **correctly 0** — the retracted spec's audit established
this is proper pinball behavior, not starvation. But a component pinned at 0
contributes **no ranking information**, discarding ~20–25% of the between-player
variance for RB/WR/TE.

This cannot be fixed by reweighting the loss (`argmin w·f = argmin f`, the
retraction's finding). It requires **estimating a different quantity**: the
conditional **mean**.

## 3. Decisions (locked)

- **Add a separate conditional-mean head**, leaving the existing quantile head's
  shape and weights untouched so **every committed v1/v2 artifact still loads
  byte-identically** (`predictor.py` loads state dicts by key).
- **Mean heads cover the 8 COUNT components only** — `passing_tds`,
  `passing_interceptions`, `carries`, `rushing_tds`, `targets`, `receptions`,
  `receiving_tds`, `fumbles_lost`. Trained with **Poisson NLL under a log link**,
  so the predicted mean is structurally **non-negative** (this also fixes the
  observed *negative* `fumbles_lost` prediction) and its variance scales with
  its mean, which is correct for counts.
- **Yardage is never touched.** `passing_yards`/`rushing_yards`/`receiving_yards`
  keep p50 for the point estimate. This is a deliberate guard: the crude post-hoc
  `E = 0.3·p10 + 0.4·p50 + 0.3·p90` blend previously **hurt RB** (−0.0027, CI
  clearing zero) precisely by injecting p90 noise into volume components. It also
  sidesteps the scale mismatch that MSE-on-yards would introduce into the loss.
- **Bands are unchanged.** p10/p90 continue to come from the quantile heads. The
  mean head is a *point-estimate* device only and must never enter band
  construction.
- **Two inference arms from ONE training run** (arm choice is inference-time, so
  it costs no extra GPU):
  - **Arm A (primary, targeted):** mean for the three touchdown components
    (`passing_tds`, `rushing_tds`, `receiving_tds`); p50 for all others.
  - **Arm B (secondary):** mean for all 8 count components; p50 for the 3 yardage.
- **λ (mean-loss weight) is selected strictly causally:** candidates
  `{0.1, 0.3, 1.0, 3.0}`, chosen on the **`through2016` fold's validation season
  (2016)** by validation-season PPR MAE computed from the Arm-A point estimate,
  seed 42 only — then **frozen** for every fold and seed. 2016 precedes *every*
  test season (2017–2025), so no fold is contaminated and no test data informs it.
- **9 walk-forward folds × 3 seeds.** Folds `through2016 … through2024`, testing
  **2017–2025**. Power is this project's recurring failure mode (FPv2 died
  undecidable at SE 0.028 on 3 seasons), and with the GPU budget unconstrained
  the cheapest fix is more paired folds. Data supports it: from 2013 on, every
  season carries ~5.5–6.1k rows with ~100% `snap_pct` coverage; the earliest
  fold still trains on 2012–2015. Earlier folds yield weaker models, but the
  comparison is **paired** — both arms train on identical data, so a weaker fold
  costs precision, never validity.
- **3 seeds, not more.** The committed v1 baseline is a 3-seed ensemble;
  matching it exactly keeps the comparison fair. Fairness beats extra power here.
- **Baseline is mostly free.** v1 is already committed for `through2019 …
  through2025` × 3 seeds; only `through2016/2017/2018` must be trained to
  complete the 9-fold baseline.

## 4. Non-goals / scope

- **Not** a QB fix (§1 — the mechanism does not apply there).
- **Not** a loss-reweighting scheme (retracted; `argmin w·f = argmin f`).
- **No** new features, no new data sources, no architecture scaling (capacity was
  settled as a non-lever: we are generalization-bound, not capacity-bound).
- **No** site/deployment change unless the gate passes.
  **Correction (2026-07-26, pre-training):** an earlier draft said promotion
  "follows the existing promote pattern (ARTIFACT_ROOT swap + regenerate)".
  That is **wrong** and would be actively harmful. `eval/harness.py` hardcodes
  `pred_stats = quantile_stats["p50"]`, and `site/weekly.py` / `site/draft.py`
  only ever call `predict_quantiles` — **nothing calls `predict_point`**. So a
  bare root swap would deploy the mean-head *weights* while still displaying
  p50 point estimates: all of the shared-trunk band risk, none of the benefit.
  Both **gate evaluation** and **promotion** therefore require wiring
  `predict_point(arm)` into the harness and the site builders first. That
  wiring is deliberately out of scope here (it is only worth building if the
  arm trains), but it is a prerequisite for §8's primary metric and must be
  done before any decision is read.
- **No** change to K/DST scope, walk-forward protocol, or free-tier constraints.

## 5. Architecture change

`src/ffmodel/model/net.py` — `QuantileTransformer` gains an **optional** second
head. The existing `self.head` is untouched:

```python
self.mean_head = (nn.Sequential(nn.LayerNorm(d_model), nn.Linear(d_model, n_counts))
                  if predict_mean else None)
```

`forward` returns the quantile tensor `[batch, n_stats, n_quantiles]` as today,
plus (when enabled) a log-rate tensor `[batch, n_counts]`. When `predict_mean`
is false the module is **structurally identical to v1**, so existing checkpoints
load with no `strict=False` shim.

`COUNT_STATS` (the 8 names above, in `PREDICTED_STATS` order) is defined once in
`scoring.py` beside `PREDICTED_STATS` and imported everywhere, so the head's
column order can never drift from the loss's.

## 6. Loss

```
total = pinball(quantile_pred, target, quantiles)          # UNCHANGED
      + λ · poisson_nll(log_rate, target[:, COUNT_IDX])
```

Poisson NLL under a log link, mean-reduced over `[batch, n_counts]`:
`exp(log_rate) − target · log_rate` (the `log(target!)` term is constant in the
parameters and omitted). Predicted mean at inference is `exp(log_rate)`.

The pinball term keeps its exact current form, so with `λ = 0` training is
**byte-identical to v1** — this is an assertable property and §9 requires it be
asserted in a test.

## 7. Training plan (Kaggle, free tier)

Configs `configs/transformer_mh_through{2016..2024}.yaml`, `run_name: mh`,
identical to their `v1` counterparts plus `predict_mean: true` and `mean_lambda`.
Artifacts land in `models/transformer/mh{,_s43,_s44}/through{Y}/`. Three new v1
configs (`transformer_v1_through{2016,2017,2018}.yaml`) complete the baseline.

| stage | runs | notes |
|---|---|---|
| λ selection | 4 | `through2016` only, seed 42, λ ∈ {0.1, 0.3, 1.0, 3.0} |
| baseline backfill | 9 | v1 `through2016/2017/2018` × 3 seeds |
| main arm | 27 | 9 folds × 3 seeds (42/43/44) at the frozen λ |
| deploy fold | 3 | `mh through2025` × 3 seeds — **only if the gate passes** |

**40 runs to a decision.** T4 ×2 (never P100 — `sm_60` is unsupported); training
is checkpointed every epoch and `train.py` is already config-aware
skip-if-complete, so a session cutoff loses nothing and "Run All" resumes. Order
matters: λ selection must finish before the main arm, since λ is frozen from it.

## 8. Pre-registered gate (BINDING)

Evaluated with the existing walk-forward harness on the **9 test seasons
2017–2025**, 3-seed ensemble vs the 3-seed v1 ensemble, on **identical rows**,
paired bootstrap over player-weeks (or player-seasons for board metrics).

**Minimum detectable effect (stated in advance so a null is interpretable).**
Prior walk-forward work put the per-season Spearman-delta SD at ~0.02–0.03; with
9 paired folds that is SE ≈ 0.007–0.010, so this design resolves a pooled effect
of **≈ +0.02 Spearman** at 95%. If the gate fails, the honest claim is therefore
"no effect of ≈0.02 or larger" — **not** "no effect". A real-but-smaller effect
would remain undetected, and per §10 that is accepted, not a reason to widen the
search afterwards.

**PRIMARY (must pass).** Weekly within-position Spearman, **RB/WR/TE pooled**,
Arm A vs v1: pooled delta **> 0** with a **paired-bootstrap 95% CI excluding
zero**. Weekly is primary because it has far more rows than 6 season-boards and
therefore the power to resolve the effect size in play.

**GUARDS (all must hold, else no promotion regardless of the primary).**
1. **No QB harm** — QB weekly Spearman delta CI must not lie entirely below zero.
2. **Bands intact** — after a fresh per-position conformal refit, p10–p90
   coverage stays in **[0.75, 0.85]** for every position-season, matching the
   Phase-B floor. The mean head shares the trunk, so band damage is the primary
   architectural risk.
3. **Points not worse** — pooled PPR MAE delta CI must not lie entirely above
   zero (i.e. not significantly worse).
4. **Monotonicity** — p10 ≤ p50 ≤ p90 still holds everywhere (existing invariant).

**Arm B** is reported alongside but only promotable if it passes the identical
gate **and** beats Arm A on the primary; ties go to Arm A (fewer components
changed, less disturbance).

**Outcome if the gate fails:** write the negative to
`models/diagnostics/mean_head_gate.json` with the same rigor as
`feature_pack_v2_gate.json`, leave `ARTIFACT_ROOT` on v1, and **stop**. Do not
retune λ and re-run.

## 9. Testing (local, before any GPU time)

- `λ = 0` (or `predict_mean: false`) reproduces v1 training **exactly** — assert
  loss equality against the unweighted pinball path.
- Existing v1/v2 checkpoints load unchanged through `predictor.py` (no shape or
  key drift).
- Poisson NLL: correct value on hand-computed cases; `exp(log_rate) > 0` always,
  so no negative count prediction is representable.
- `COUNT_STATS` indices line up with `PREDICTED_STATS` positions (a mis-ordered
  index would silently train the wrong head — assert by name, not position).
- Arm A/B point-estimate assembly: TD components take the mean, yardage always
  takes p50, and scoring the assembled line equals the expected points by hand.
- Full suite green under `-W error`.

## 10. Risks

| risk | mitigation |
|---|---|
| Mean head disturbs the shared trunk and breaks calibrated bands | Guard 2 is a hard gate; conformal is refit, not assumed |
| λ too large drowns the pinball objective | λ chosen causally on the through2016 fold's 2016 validation season; guards 2–3 catch damage |
| Arm A helps TDs but hurts volume-driven RB (the prior failure) | Yardage is never switched; primary is RB/WR/TE pooled so RB harm shows up directly |
| Effect is real but smaller than 6-fold resolution | Accepted: an unresolvable effect is not a shippable one — that is the FPv2 lesson, not a reason to widen the search |

## 11. What success would mean

If the gate passes, the board's point estimate stops discarding ~20–25% of
RB/WR/TE ranking variance, and the model gets a *principled* central estimate
(`E[points] = Σ wᵢ·E[Xᵢ]`) while keeping the calibrated quantile bands that are
its distinguishing product feature. If it fails, we will have converted a
long-standing hand-wave ("the TD heads are broken") into a measured, bounded,
honestly-reported negative — with the QB misattribution already corrected in §1.
