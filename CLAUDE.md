# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A fantasy football (NFL) projection model built as a portfolio piece: a small PyTorch quantile transformer trained on a free SageMaker Studio Lab T4, published as a static GitHub Pages site with a draft board and self-updating weekly projections. The full approved design lives in `docs/superpowers/specs/2026-07-09-fantasy-football-model-design.md` — read it before making design-level changes; it is the source of truth for scope and architecture.

Hard deadlines: draft board live ~Aug 20 2026, weekly automation live by Sept 10 2026 (NFL week 1).

## Three-environment split (do not blur these)

- **Local:** all code development, tests, and the static site. All logic lives in `src/` as importable Python; notebooks in `notebooks/` are thin wrappers and must never be the only home of any logic.
- **SageMaker Studio Lab:** training only. Free-tier limits shape the code: 4 h GPU/day (T4, ~16 GB), 8 h CPU/day in 4 h sessions, sessions started manually, **no scheduled jobs**. Training loops must checkpoint at least every epoch so a session cutoff loses nothing.
- **GitHub Actions:** all scheduled work (weekly data pull → CPU inference → regenerate `site/` JSON → deploy Pages). Never design automation that assumes Studio Lab can run it.

Everything must run on free tiers; do not introduce paid infrastructure.

## Design invariants

- Models predict **raw stat lines** (yards, TDs, receptions, …), never fantasy points directly. Points are computed from stat lines by pure scoring functions; PPR is the display default, half-PPR/standard derive for free.
- The transformer outputs **quantiles (p10/p50/p90) per stat component** via pinball loss — floor/ceiling bands are a core product feature, and quantile calibration is a first-class eval metric.
- **Evaluation is walk-forward only** (train ≤ season S, test S+1; held-out years 2023–2025). Never introduce random train/test splits — rolling features make them leak future into past.
- Every model artifact in `models/` is committed together with the YAML config and eval metrics that produced it; training runs are seeded and config-driven from `configs/`.
- Baselines (naive last-4-average, XGBoost) run through the same eval harness as the transformer, and results are reported honestly whichever model wins.
- The weekly Actions run must fail safe: on a failed or incomplete data pull, abort without touching published JSON. The site always shows a "data as of <date>" stamp.
- Scope guards (v1): QB/RB/WR/TE only — no K/DST/IDP, no DFS optimization, no injury/news signals.

## Stack and layout

Python (PyTorch, `nfl_data_py`, XGBoost, pytest) under `src/` with tests in `tests/`; static HTML/CSS/JS under `site/` (GitHub Pages, no backend, no framework). See the spec §3 for the full directory contract. Tests concentrate on the leak-prone pure functions: feature building, scoring math, walk-forward splits, and site-JSON schema.
