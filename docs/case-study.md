# Megatron: an NFL fantasy football projection system

**Live site:** [megatron-ff.vercel.app](https://megatron-ff.vercel.app) · **Code:** this repository ·
**Full methodology and every result:** [`docs/methodology.md`](methodology.md)

## Overview

Megatron is an NFL fantasy-football projection system I built end to end on free infrastructure. It has four parts:

- **Model:** a small PyTorch quantile transformer, trained on a free NVIDIA T4 GPU through Kaggle. It predicts each player's weekly stat
  line with a floor (p10), median (p50) and ceiling (p90).
- **Automation:** GitHub Actions retrains nothing. It pulls fresh data, runs CPU inference, regenerates the site's JSON
  and redeploys a static site twice a day during the season.
- **Site:** weekly projections with start/sit advice, a waiver tool and a trade calculator that work with any Sleeper
  league a visitor connects, scored with that league's own settings. No page defaults to a particular league. The 2026
  draft board, which carried a live pick-time optimizer during the draft, stays up as an archived record with its
  draft tools hidden.
- **Evaluation:** model results are measured walk-forward on seasons the model never trained on. Experiments that could
  change the product get a pass/fail rule written down before the result is known; diagnostics, which change
  nothing, are labelled as diagnostics. Work is reviewed by an independent model whose job is to break the claim.
  Results are reported whether they are good or bad.

Several results are losses, and they are reported on the site.

## What I built

| Layer | What it does | Stack |
|---|---|---|
| Data | Pulls 2012–present play-level and weekly stats, schedules, rosters and betting lines. It normalizes team codes and caches everything. | Python, `nflreadpy`, pandas |
| Features | Rolling usage and efficiency features with strict "only what was known before kickoff" construction. These are the leak-prone functions, so they carry the heaviest tests. | pandas, pytest |
| Models | A quantile transformer (≈343K parameters, pinball loss, 3 seeds averaged). Baselines run through the same harness: a naive last-4-game average and XGBoost, with a squared-error and a median objective. | PyTorch, XGBoost |
| Scoring | Points are computed from predicted stats by pure functions. PPR, half-PPR and any league's custom rules all come from one set of predictions. | Python |
| Evaluation | Walk-forward splits only (train ≤ S, test S+1; held out 2023–25), paired bootstrap intervals, calibration of the p10–p90 bands. | NumPy, custom harness |
| Automation | Twice-daily data refresh and publish during the season, fail-safe: a bad pull aborts without touching published data. Plus a weekly accuracy scorecard and a private snapshot collector for third-party market data. | GitHub Actions |
| Site | Static HTML/CSS/JS with no framework or backend. It reads any Sleeper league through Sleeper's public API in the browser. | vanilla JS, 43 Node fixture tests |

The codebase has over 1,500 Python tests and 43 JavaScript fixture suites, and CI runs them with warnings treated as
errors.

## Evaluation process

Two common problems in sports modelling are leakage (using information that wasn't available at
prediction time) and forking paths (trying many things and reporting the one that worked). I built guards against both
into the process:

- **Walk-forward only.** There are no random train/test splits anywhere, because rolling features would leak the future
  into the past.
- **Pre-registration.** Each gated experiment's pass/fail rule is written down and committed before the result
  exists. The verdict is then read off that rule. For the 2026 betting-lines experiment, the run's manifest was
  committed before any model was fitted. Diagnostics that gate nothing, such as the outcome-selected cut below, carry
  no rule and are labelled as diagnostics.
- **Adversarial review.** A second model (OpenAI's Codex, which I call "astra") reviews specs, plans and builds with
  the job of breaking the claim. It has caught real bugs:
  - a sign error that produced an impossible −0.59 correlation;
  - a consensus benchmark that silently used the previous week's expert rankings, in 36 of 38 checkable weeks;
  - a workflow step that would have dropped captured data;
  - a redirect path that could have leaked an API key.
- **Negative results are reported.** They go on the site and in the methodology, with the reason each one failed.

## Results

**It beats the naive baseline and ties a properly specified XGBoost.** Weekly PPR mean absolute error, walk-forward
over 2023–25 (17,908 player-weeks):

| Model | MAE |
|---|---|
| Naive last-4 average | 4.612 |
| XGBoost, squared-error objective (a mean predictor, single seed) | 4.448 |
| XGBoost, median objective (3-seed ensemble) | 4.326 |
| Quantile transformer (3-seed ensemble) | 4.325 |

The committed XGBoost baseline uses XGBoost's default squared-error objective, which predicts means; scored on MAE,
which rewards medians, it trails by 0.12. With a median objective and nothing else changed, it ties the transformer
(paired difference −0.001, 95% interval [−0.021, +0.019]; `models/backtests/xgb_median/paired_xgb_median.json`). What
the transformer adds is calibrated floor and ceiling bands, which XGBoost does not produce.

**Live 2026 results.** Through week 8, for players who recorded a stat line, scored from the projections committed
before each kickoff, the MAE was 4.33 against 4.63 for the naive baseline (2,629 player-weeks), and 79.7% of outcomes
landed inside the p10–p90 band, against a target of 80% (as of 4 November 2026; week 8 was still provisional, pending
stat corrections). The model beat the baseline in seven of the eight weeks. The stat-line population leaves out players
who did not play and players who played without recording a stat; the methodology gives the sensitivity. The site's
[about page](https://megatron-ff.vercel.app/about.html) shows the week-by-week table, recomputed every week.

**It does not beat expert consensus.**
- **Preseason ranking:** FantasyPros expert consensus wins every position-season. Restricting to players who went on
  to play at least 8 games narrows the gap mainly at running back, and consensus still wins every position-season;
  because that cut selects on the outcome, it says nothing causal about availability.
- **Same-week rankings:** a pre-registered re-measurement finds the model behind consensus (rank correlation 0.597 vs
  0.634, difference −0.037, 95% interval [−0.047, −0.028]). This re-measurement also *retracted* an earlier
  "running-back edge" that came from the stale-week bug above.

**Experiments that didn't make it**, each pre-registered:
- **Feature pack v2:** passed its stated gate, but the gain was inside noise and quarterbacks got worse, so it was not
  shipped.
- **Conditional-mean head:** failed its primary test across 9 folds × 3 seeds (40 GPU runs in all, counting λ
  selection and the baseline folds it needed).
- **Per-player availability:** a large, real signal that moved the board not at all.
- **Betting lines as features (2026):** cut error by 0.039 points per player-week, consistently across seasons and
  seeds. That fell short of the 0.05 bar set in advance, so it was labelled inconclusive and not adopted. The screen
  was run on the squared-error XGBoost baseline and was not re-run with the median objective.

## Where to look

- **The betting-lines screen** covers the full process in one place:
  - spec: [`docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md`](superpowers/specs/2026-10-11-lines-feature-screen-design.md);
  - frozen manifest committed before fitting: `models/diagnostics/lines_screen_manifest.json`;
  - result: `models/diagnostics/lines_screen.json`.
- **The weekly-accuracy system** reproduces "what was committed before kickoff" from GitHub push events rather than
  trusting timestamps (it does not verify the Vercel deploy):
  [`src/ffmodel/eval/live_accuracy.py`](../src/ffmodel/eval/live_accuracy.py).
- **The stale-benchmark correction** in [`docs/methodology.md`](methodology.md) §3, which retracts an earlier favourable
  result.

## What I learned

- **Most "improvements" are noise.** With three held-out seasons, the standard error on a season-level accuracy change
  is about 0.03. Writing the bar down before looking killed several ideas that would otherwise have shipped.
- **Architecture was not the lever.** A median-objective XGBoost ties the transformer on point accuracy, and a
  conditional-mean head improved points but not ranking. The experts' edge holds among players who played, so the
  evidence does not show the edge is mainly about who plays. My working hypothesis is that it is information the
  model never sees (depth charts, role changes). The 2027 plan's first step, an ADP benchmark, measures how much preseason context is worth before
  anything is built for it.
- **Infrastructure constraints shape design.** Free GPU sessions that end without warning mean every training loop
  checkpoints every epoch. No scheduled jobs on the training platform means all recurring work lives in GitHub Actions.
- **Independent review finds real defects.** The reviewer found something to fix in almost every round.

## What's next

- **Accumulate seasons.** Each season adds training data; the 2026 live record and market snapshots are being archived
  for future pre-registered tests.
- **A blend test.** A private, pre-registered comparison against a commercial projection reads once after week 18. Its
  consequences were fixed before any result existed.
- **Model architecture:** try different architectures once there is enough new data to test them properly.

*Scope: QB/RB/WR/TE only; no kickers, defenses or DFS; no injury/news signals in the model.*
