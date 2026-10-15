# Megatron: an NFL fantasy football projection system

**Live site:** [megatron-ff.vercel.app](https://megatron-ff.vercel.app) · **Code:** this repository ·
**Full methodology and every result:** [`docs/methodology.md`](methodology.md)

## Overview

Megatron is an NFL fantasy-football projection system I built end to end on free infrastructure. It has four parts:

- **Model:** a small PyTorch quantile transformer, trained on a free NVIDIA T4 GPU through Kaggle. It predicts each player's weekly stat
  line with a floor (p10), median (p50) and ceiling (p90).
- **Automation:** GitHub Actions retrains nothing. It pulls fresh data, runs CPU inference, regenerates the site's JSON
  and redeploys a static site twice a day during the season.
- **Site:** a draft board with a live pick-time optimizer, weekly projections, a waiver tool and a trade calculator.
  Each works with any Sleeper league's own scoring.
- **Evaluation:** every claim is measured walk-forward on seasons the model never saw, with its pass/fail rule written
  down before the result is known, and is independently reviewed. Results are reported whether they are good or bad.

Several results are losses, and they are reported on the site.

## What I built

| Layer | What it does | Stack |
|---|---|---|
| Data | Pulls 2012–present play-level and weekly stats, schedules, rosters and betting lines. It normalizes team codes and caches everything. | Python, `nflreadpy`, pandas |
| Features | Rolling usage and efficiency features with strict "only what was known before kickoff" construction. These are the leak-prone functions, so they carry the heaviest tests. | pandas, pytest |
| Models | A quantile transformer (≈343K parameters, pinball loss, 3 seeds averaged). Two baselines run through the same harness: a naive last-4-game average and XGBoost. | PyTorch, XGBoost |
| Scoring | Points are computed from predicted stats by pure functions. PPR, half-PPR and any league's custom rules all come from one set of predictions. | Python |
| Evaluation | Walk-forward splits only (train ≤ S, test S+1; held out 2023–25), paired bootstrap intervals, calibration of the p10–p90 bands. | NumPy, custom harness |
| Automation | Twice-daily data refresh and publish during the season, fail-safe: a bad pull aborts without touching published data. Plus a weekly accuracy scorecard and a private snapshot collector for third-party market data. | GitHub Actions |
| Site | Static HTML/CSS/JS with no framework or backend. It reads any Sleeper league through Sleeper's public API in the browser. | vanilla JS, 42 Node fixture tests |

The codebase has over 1,400 Python tests and 42 JavaScript fixture suites, and CI runs them with warnings treated as
errors.

## Evaluation process

Two common problems in sports modelling are leakage (using information that wasn't available at
prediction time) and forking paths (trying many things and reporting the one that worked). I built guards against both
into the process:

- **Walk-forward only.** There are no random train/test splits anywhere, because rolling features would leak the future
  into the past.
- **Pre-registration.** Each experiment's pass/fail rule is written down and committed before the result exists. The
  verdict is then read off that rule. For the 2026 betting-lines experiment, the run's manifest was committed before any
  model was fitted.
- **Adversarial review.** A second model (OpenAI's Codex, which I call "astra") reviews every spec, plan and build with
  the job of breaking the claim. It has caught real bugs:
  - a sign error that produced an impossible −0.59 correlation;
  - a consensus benchmark that silently used the previous week's expert rankings, in 36 of 38 checkable weeks;
  - a workflow step that would have dropped captured data;
  - a redirect path that could have leaked an API key.
- **Negative results are reported.** They go on the site and in the methodology, with the reason each one failed.

## Results

**It beats its own baselines.** Weekly PPR mean absolute error, walk-forward over 2023–25 (17,908 player-weeks):

| Model | MAE |
|---|---|
| Naive last-4 average | 4.61 |
| XGBoost | 4.45 |
| **Quantile transformer** | **4.33** |

**Live 2026 results.** In weeks 1–4, scored from the projections actually published before kickoff, the MAE was
4.36 against 4.67 for the naive baseline. About 80% of outcomes landed inside the p10–p90 band, against a target of 80%.

**It does not beat expert consensus.**
- **Preseason ranking:** FantasyPros expert consensus wins every position-season. About 60% of that edge is
  availability (knowing who will actually play), not per-game production, which is information that isn't in box
  scores.
- **Same-week rankings:** a pre-registered re-measurement finds the model behind consensus (rank correlation 0.597 vs
  0.634, difference −0.037, 95% interval [−0.047, −0.028]). This re-measurement also *retracted* an earlier
  "running-back edge" that came from the stale-week bug above.

**Experiments that didn't make it**, each pre-registered:
- **Feature pack v2:** passed its stated gate, but the gain was inside noise and quarterbacks got worse, so it was not
  shipped.
- **Conditional-mean head:** failed its primary test across 9 folds and 40 GPU runs.
- **Per-player availability:** a large, real signal that moved the board not at all.
- **Betting lines as features (2026):** cut error by 0.039 points per player-week, consistently across seasons and
  seeds. That fell short of the 0.05 bar set in advance, so it was labelled inconclusive and not adopted.

## Where to look

- **The betting-lines screen** covers the full process in one place:
  - spec: [`docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md`](superpowers/specs/2026-10-11-lines-feature-screen-design.md);
  - frozen manifest committed before fitting: `models/diagnostics/lines_screen_manifest.json`;
  - result: `models/diagnostics/lines_screen.json`.
- **The weekly-accuracy system** reproduces "what did the site actually publish before kickoff" from git push events
  rather than trusting timestamps: [`src/ffmodel/eval/live_accuracy.py`](../src/ffmodel/eval/live_accuracy.py).
- **The stale-benchmark correction** in [`docs/methodology.md`](methodology.md) §3, which retracts an earlier favourable
  result.

## What I learned

- **Most "improvements" are noise.** With three held-out seasons, the standard error on a season-level accuracy change
  is about 0.03. Writing the bar down before looking killed several ideas that would otherwise have shipped.
- **The ceiling is set by information, not architecture.** The gap to the experts is mostly availability and news. A
  better box-score model cannot close it, which is why the next real gain is data, not a bigger network.
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
