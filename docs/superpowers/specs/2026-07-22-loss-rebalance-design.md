# Loss rebalance (fix the collapsed touchdown heads) — design

**Date:** 2026-07-22 · **Status:** approved
**Feature:** rebalance the multi-task pinball loss so the eleven stat heads
receive comparable learning capacity, instead of the 87% / 1.6% split
between yardage and touchdown heads that currently collapses the highest-
fantasy-value components to near-constants. Two weighting schemes are built
and trained as separate arms; a pre-registered walk-forward gate picks the
winner, or neither.

## Motivation (measured, not assumed)

The pinball loss is a single flat `.mean()` over `[batch, 11 stats, 3
quantiles]`, and the targets are raw stat lines (the scaler touches inputs
only — verified). So each head enters the mean at its own magnitude. Measured
per-head gradient share on the deployed v1 ensemble (2024 val rows):

| group | grad share | note |
|---|---|---|
| yardage (pass/rush/rec yards) | **86.9%** | receiving_yards alone 42.7% |
| carries + targets | 8.1% | score **0** fantasy points |
| all TD/INT/fumble heads | **1.6%** | worth 2–6 points each |

`receiving_yards` gets ~130× the gradient of `rushing_tds`, which is worth
60× more per event. Consequence, confirmed end-to-end: the p50 TD heads
collapse (predicted rushing_tds mean 0.0023 vs actual 0.0837; fumbles_lost
negative), ranking actual season rushing TDs at Spearman +0.13 while the p90
head — which gets the same starved gradient but isn't pinned at zero — still
ranks them at +0.75–0.82. Three independent analyses (preseason board QB
0.499 vs 0.748; weekly QB −0.040; the feature-pack-v2 QB-led regression)
localize the model's worst weakness to exactly this component.

## Scope

**In:** `src/ffmodel/model/net.py` (`pinball_loss` gains optional per-head
weights), `src/ffmodel/model/train.py` (resolve + apply weights, record them
in `metrics.json`), new configs under `configs/`, tests. All local, all
reviewable before any training.

**Out:** the model architecture, the predictor/inference path (the loss is
training-only — inference never sees it), the scoring functions, calibration,
the site, and `models/backtests/`. No architecture or hyperparameter change —
this isolates the loss weighting.

## Design

### Weighted pinball loss (`net.py`)

```python
def pinball_loss(pred, target, quantiles, head_weights=None):
    diff = target.unsqueeze(-1) - pred
    q = torch.tensor(quantiles, ...).view(1, 1, -1)
    loss = torch.maximum(q * diff, (q - 1) * diff)      # [n, n_stats, n_q]
    if head_weights is not None:
        loss = loss * head_weights.view(1, -1, 1)
    return loss.mean()
```

`head_weights=None` is byte-identical to today. Weights are **normalized to
mean 1** so the overall loss magnitude — and therefore the effective learning
rate — stays in the same regime as v1 (no LR retuning, preserving the
no-new-sweep discipline).

### Two schemes (`train.py`)

`cfg["loss_weighting"]` selects, default `"none"`:

- **`"none"`** — `head_weights=None`. v1, unchanged.
- **`"std"`** — `w_k = 1 / std_k`, where `std_k` is stat k's standard
  deviation over the **training** targets (a per-fold quantity, computed once
  in `train_from_config`, never from val/test). Degenerate `std_k < 1e-6`
  floors to 1 (matches the scaler's `_safe_std`). Equal capacity per stat in
  scale-free units; directly un-collapses every head. Preserves the "predict
  raw stats" invariant purely — no coupling to the scoring system.
- **`"points"`** — `w_k = |coef_k|` from `scoring.stat_weights(PPR)` (the
  existing single source of truth). `carries`/`targets` score 0 and are
  floored at the smallest nonzero coefficient (`passing_yards`, 0.04) so no
  head is fully starved. Capacity proportional to fantasy-points impact —
  aligned with the eval metric, at the cost of coupling the loss to PPR.

Both normalize to mean 1 after construction. The resolved scheme name **and
the explicit weight vector** are written to `metrics.json` for provenance and
so a reviewer can audit exactly what trained.

### Leak-freedom

`std` weights use only training-split targets, computed inside
`train_from_config` after the train/val split — identical discipline to
`fit_scaler` (train rows only). `points` weights are static constants. Neither
scheme can see val or test data. Inference is untouched, so all deployed v1
artifacts predict byte-identically (a `metrics.json` without `loss_weighting`
resolves to `"none"`).

## Training (user runs on Kaggle)

New configs mirror the v1 walk-forward configs byte-for-byte except
`run_name` and the added `loss_weighting` key:

- `stdw` arm: `transformer_stdw{,_through2022,_through2023,_through2024}.yaml`
  → roots `models/transformer/stdw{,_s43,_s44}`.
- `ptsw` arm: `transformer_ptsw{,_through...}.yaml` →
  `models/transformer/ptsw{,_s43,_s44}`.

4 folds × 2 arms × 3 seeds = **24 runs** (~2 GPU-hours). A committed test
pins the byte-for-byte mirror (the no-new-sweep invariant).

### Bundled: earlier folds for the RB out-of-sample test

The RB weekly edge (ours 0.7215 vs consensus 0.6958, 3/3 seasons, p=0.002)
was found on 2023–25 — the discovery set. A clean test needs 2020–22, which
needs baseline (`none`) artifacts at `through2019/2020/2021`. Three configs
`transformer_v1_through{2019,2020,2021}.yaml` (× 3 seeds = 9 runs) are added
so one Kaggle cycle enables both the loss gate and the RB test. These are
pure v1 configs (no loss_weighting) at earlier val seasons — the model is
unchanged, only the fold boundary moves.

## Promotion gate (pre-registered, binding)

An arm promotes to the site **only if**, on walk-forward held-out 2023–25
through the same harness as v1:

1. **Weekly PPR MAE** ≤ v1's (4.326) — not worse; **and**
2. **QB weekly within-position Spearman** (conditional on playing, vs the
   weekly-consensus harness built this session) strictly beats v1's, since
   repairing QB is the point; **and**
3. **Season board hit-rate** not worse than v1 (no regression on the primary
   product metric); **and**
4. **Calibration** — a fresh Phase-B conformal refit lands weekly coverage in
   0.75–0.85 for every position/tail (the un-collapsed heads change the raw
   band, so this must be re-verified, not assumed).

If both arms clear the gate, the higher QB-Spearman arm ships. If neither
clears it, honest negative to `models/diagnostics/`, site stays v1. Never
tuned against 2023–25. The RB out-of-sample test is reported separately and is
a **measurement, not a gate** — nothing promotes on it.

## Error handling

| Case | Behavior |
|---|---|
| Config without `loss_weighting` | resolves to `"none"` → v1 byte-identical |
| Unknown scheme name | `train_from_config` raises before any file write |
| Degenerate stat std (< 1e-6) | floors to 1.0 (matches `_safe_std`) |
| Deployed v1 artifact (no key in metrics) | inference unaffected; predicts identically |
| Gate fails both arms | no promotion, honest negative, site unchanged |

## Testing

`PYTHONPATH=src`, suite runs `-W error`.

- **Weighted loss:** `pinball_loss` with `head_weights=None` is byte-identical
  to the unweighted result (exact tensor equality); a nonzero weight vector
  scales the per-head contribution as specified; mean-1 normalization holds.
- **Scheme resolution:** `"std"` weights equal `1/train_std` normalized to
  mean 1 and use train rows only; `"points"` weights match
  `|stat_weights(PPR)|` with the carries/targets floor; `"none"`/absent →
  `None`; unknown → raises before touching artifacts.
- **Provenance:** `metrics.json` records `loss_weighting` and the weight
  vector; length equals `n_stats`.
- **v1 safety:** a config without the key trains byte-identically (loss curve
  and saved weights unchanged from before this change).
- **Config mirror:** each `stdw`/`ptsw` config equals its v1 counterpart on
  every key except `run_name` and `loss_weighting`.

## Sequencing

1. **Local half (now):** loss + resolution + configs + tests → review → merge.
   Mergeable; deploys nothing.
2. **Kaggle (user):** 24 arm runs + 9 earlier-fold runs.
3. **Eval / gate session:** run the weekly-consensus + board harnesses and the
   Phase-B refit against the real artifacts, apply the pre-registered gate,
   promote or record the negative; separately, the clean RB out-of-sample test.

## Out of scope

Architecture/LR/target-transform changes; a conditional-mean or Poisson TD
head (a heavier alternative fix, revisit only if reweighting fails);
component-specific expectation ranking (post-hoc, separate pre-registration);
K/DST/IDP.
