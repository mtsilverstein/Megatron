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

Python (PyTorch, `nflreadpy` — not the deprecated `nfl_data_py`, XGBoost, pytest) under `src/ffmodel/` with tests in `tests/`; static HTML/CSS/JS under `site/` (GitHub Pages, no backend, no framework). See the spec §3 for the full directory contract. Tests concentrate on the leak-prone pure functions: feature building, scoring math, walk-forward splits, and site-JSON schema.

## How work gets executed

- **Implementation plans are always executed subagent-driven** (fresh implementer per task → task review → final whole-branch review). Don't ask which mode; announce it and go.
- **Match the model to the task — never default to the most capable one.** Always pass `model` explicitly when dispatching:
  - *Transcription-style implementers* (the plan/brief already contains the code; the job is apply-and-test) → `sonnet`. Single-file mechanical fixes → `sonnet`.
  - *Task reviewers* → `sonnet`, scaled up only for genuinely subtle diffs (concurrency, numerics, leak surfaces).
  - *Final whole-branch review* and *architecture/design work* → `opus`.
  - Turn count beats token price: a model that needs 3× the turns costs more than the tier it saved. Don't reach below `sonnet` for anything multi-step.
- **Dispatch in parallel only when the work is genuinely independent** (non-overlapping files); anything sharing a file or an interface runs sequentially.
- Hand subagents artifacts as **files** (task brief, report path, review package), not pasted text — pasted context stays resident for the whole session.
- **Verify a plan's factual premises before writing them down.** Two real failures to learn from: a plan asserted an external API's field label without checking it (would have shipped a permanently-empty list), and a plan told an implementer to append to a test file that didn't exist. Check the API, the file, and the function signature first.
