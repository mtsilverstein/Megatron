# Fantasy Football Projection Model — Design

**Date:** 2026-07-09
**Status:** Approved
**Working name:** `ff-model` (GitHub repo may be renamed at creation; nothing in this spec depends on the name)

## 1. Purpose

A portfolio ML project that predicts NFL fantasy football performance, built deep-learning-first to make real use of Amazon SageMaker Studio Lab's free T4 GPU quota (4 h GPU/day; 8 h CPU/day in 4 h sessions). The centerpiece is a small PyTorch transformer trained on the GPU; an XGBoost baseline exists to make the evaluation credible, not as a co-star.

Two prediction products from one model:

1. **Weekly point projections** — each player's upcoming-week fantasy output, refreshed automatically all season.
2. **Season-long draft values** — 2026 season projections and a value-over-replacement draft board, live before draft season (~Aug 20, 2026).

The public face is a live static site (GitHub Pages) plus a well-documented repo. Default scoring display: **full PPR** (half-PPR and standard are derivable and can be offered as toggles).

## 2. Success criteria

- Draft board live by ~Aug 20, 2026; weekly projections live by NFL week 1 (~Sept 10, 2026).
- Weekly updates happen with zero manual steps (GitHub Actions cron).
- Transformer is trained on the Studio Lab T4 and beats the naive baseline in walk-forward backtests; its result vs. XGBoost is reported honestly whichever way it lands.
- Quantile projections are calibrated (p10–p90 band contains ~80% of actual outcomes in backtests).
- A reader of the repo/site can understand the methodology, reproduce training, and see the eval results.

## 3. Architecture: three environments, one repo

| Environment | Role | Why |
|---|---|---|
| Local (VS Code) | All code development, tests, static site | Fast iteration; logic lives in `src/` as importable, testable Python |
| SageMaker Studio Lab (T4 GPU) | Training only | The GPU quota; sessions are manual and capped at 4 h, so nothing scheduled lives here |
| GitHub Actions (free CPU) | Weekly inference + site deploy | Studio Lab has no scheduled jobs; Actions cron is the season-long heartbeat |

Notebooks are thin wrappers that import from `src/`; no logic lives only in a notebook.

### Repo layout

```
ff-model/
├── src/
│   ├── data/        # nfl_data_py pulls, caching, feature building
│   ├── model/       # PyTorch transformer, dataset, training loop
│   ├── baseline/    # naive average + XGBoost
│   ├── eval/        # walk-forward backtest harness, metrics
│   └── site/        # generates the site's JSON payloads
├── notebooks/       # thin Studio Lab wrappers (train.ipynb etc.)
├── models/          # committed artifacts: weights + config + eval metrics per run
├── site/            # static HTML/CSS/JS → GitHub Pages
├── tests/           # pytest
├── configs/         # YAML training/experiment configs
└── .github/workflows/  # weekly-update.yml (cron), pages deploy
```

## 4. Data

- **Source:** `nfl_data_py` (nflverse): weekly player stats, schedules, rosters, snap counts. Seasons ~2012–2025 for training history.
- **Positions:** QB, RB, WR, TE. Kickers and DST are out of scope for the model (the site may omit them entirely in v1).
- **Unit of prediction:** (player, week) → **raw stat line** for that week: pass yards, pass TD, INT, rush attempts, rush yards, rush TD, targets, receptions, receiving yards, receiving TD, fumbles lost. Fantasy points under any scoring rule are computed deterministically from the stat line; PPR is the display default.
- **Model input per sample:**
  - *Sequence:* the player's last 16 games played (spanning season boundaries), each as a per-game feature vector (raw stats, usage shares — target share, snap %, carry share — team context). Shorter histories are padded and masked.
  - *Target-week context:* opponent defense rolling allowed-stats by position, home/away, rest days, week number. Injected via a learned context token.
- **Scale honesty:** ~100–150k player-week samples total. This is small data and the model is sized accordingly (see §5).
- **Cold start:** rookies with no NFL games get position-level prior projections; players changing teams keep their personal sequence with updated team/opponent context. Both limitations are documented on the site.

## 5. Model

Small encoder-only transformer (PyTorch):

- ~2–4 layers, d_model 64–128, order of a few hundred thousand parameters — sized to the data, and framed that way in the writeup.
- Input: embedded game-log sequence + context token; masked self-attention over padding.
- **Output heads: quantile regression (p10 / p50 / p90) per stat component**, trained with pinball loss. This yields floor/ceiling bands for every projection — the project's differentiator — and calibration is a first-class eval metric.
- Training: mixed precision (fp16) on the T4; checkpoint every epoch so a 4 h session cutoff never loses work; seeded; every run driven by a YAML config committed with its artifact. A full training run is expected to take minutes to tens of minutes, so the GPU quota supports many experiments.

## 6. Evaluation

- **Protocol: walk-forward only.** Train on seasons ≤ S, test on season S+1; held-out test years 2023, 2024, 2025. No random splits (future-into-past leakage).
- **Entrants, same harness for all:**
  1. Naive last-4-games average (the floor),
  2. XGBoost on flattened rolling features (the credible tabular incumbent),
  3. The transformer.
- **Metrics:** MAE and RMSE on PPR points, reported by position; quantile calibration (empirical coverage of the p10–p90 band, pinball loss).
- **Reporting:** results published on the site's "About the model" page exactly as they land. A transformer loss to XGBoost is written up as a finding, not hidden.
- **Production model:** after backtest evaluation fixes the architecture and hyperparameters, the deployed model is retrained on all seasons through 2025 for 2026 inference.

## 7. Draft values (August deliverable)

- Roll the trained model over each player's full 2026 schedule (opponents known from the released schedule), seeding the input sequence with end-of-2025 form.
- Season projection = sum of weekly p50s; boom/bust bands from summed p10/p90.
- **Draft board ordering: value over replacement (VORP)** — projected points above the replacement-level player at the position (best presumed-waiver player, i.e., the player ranked at the position's typical last-drafted slot in a 12-team league). Positional scarcity, not raw points, orders the board.
- Offseason-move and rookie handling is v1-crude (per §4 cold start) and labeled as such on the site.

## 8. Site

Static HTML/CSS/JS on GitHub Pages, reading JSON generated by `src/site/`. No backend, no hosting cost.

1. **Draft board** — sortable by position / tier / VORP, with floor–ceiling range bands. Live ~Aug 20.
2. **Weekly projections** — the upcoming slate with floor/ceiling bars, sortable/filterable; refreshed by the weekly cron. Live by week 1.
3. **About the model** — methodology, the bake-off table, calibration plots, limitations. This page is the portfolio writeup.

Every page shows a "data as of \<date\>" stamp.

## 9. Automation & failure handling

- **`weekly-update.yml`:** GitHub Actions cron, Tuesday night ET during the season (post-MNF stat finalization): pull fresh nflverse data → build features → CPU inference with the committed model → regenerate site JSON → deploy Pages.
- **Fail-safe:** if the data pull fails or looks incomplete (row-count sanity checks), the workflow aborts without touching the published JSON — the site keeps serving last week's numbers with its honest date stamp. Never a broken page, never silently wrong numbers.
- **Retraining:** manual, on Studio Lab, at the developer's discretion (e.g., a mid-season refresh); new artifacts are committed and picked up by the next weekly run.

## 10. Testing

- Pytest, run locally and in CI, covering the leak-prone and correctness-critical pure functions:
  - feature building (rolling windows must use only past data),
  - scoring math (stat line → PPR/half/standard points),
  - walk-forward split logic,
  - site-JSON generation (schema stability for the frontend).
- Model quality is guarded by the eval harness (§6), not unit tests.

## 11. Out of scope (v1)

- Kickers, DST, IDP.
- DFS lineup optimization / salary constraints.
- Injury-report or news/NLP signals.
- In-week live updates (one refresh per week).
- Any paid infrastructure; everything runs on free tiers.

## 12. Sequencing against the calendar

1. **July:** data pipeline, feature building, scoring math, eval harness, baselines — all local/CPU, test-covered.
2. **Late July–mid August:** transformer development and training runs on Studio Lab; bake-off results.
3. **~Aug 20:** draft board + site live on Pages.
4. **By Sept 10 (week 1):** weekly Actions cron live; season-long autopilot.
