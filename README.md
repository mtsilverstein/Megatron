# ff-model

NFL fantasy football projections: a small quantile transformer (trained on a
free Kaggle T4) versus classical baselines, evaluated honestly with
walk-forward backtests, published as a static site that updates itself weekly
during the season.

The site is four pages, no backend and no framework: a **draft board** with a
pick-time optimizer that reads a live Sleeper draft, a **trade calculator**,
**weekly projections** with p10/p50/p90 bands, and an **about** page carrying
the backtest numbers. Models predict raw stat lines; fantasy points are
computed from those by pure scoring functions, so PPR, half-PPR, standard and
this league's custom rules all derive from one set of predictions.

**Design spec:** `docs/superpowers/specs/2026-07-09-fantasy-football-model-design.md`

## Quickstart

```bash
python -m venv .venv                # Python >= 3.10
source .venv/Scripts/activate       # POSIX: source .venv/bin/activate
.venv/Scripts/python.exe -m pip install -e ".[dev]"   # POSIX: .venv/bin/python
pytest                          # unit tests (offline)
pytest -m integration           # network tests against live nflverse data

python -m ffmodel.data.pull     # cache 2012-2025 data to data/raw/
python -m ffmodel.eval.run      # walk-forward backtest -> models/backtests/baselines.json
```

## Training (Kaggle)

Training runs on Kaggle's free GPU tier (~30 h/week). The four
`notebooks/*_kaggle.ipynb` notebooks are thin wrappers — every line of logic
lives in `src/ffmodel/`, so the same commands run locally on CPU, slower.

1. Session options → Accelerator **GPU T4 ×2**, Internet **ON**.
   Not the P100: it is sm_60 and unsupported by this project's torch build.
2. Open a `*_kaggle.ipynb` and **Run All**, then walk away (~1 hour for a
   12-run sweep). The first cell clones or pulls the repo and installs it.
3. Come back to either a push confirmation or a zip of artifacts to commit
   locally — Kaggle usually cannot push with your git credentials.

Sessions can be cut off at any time, so every training loop checkpoints each
epoch: re-running the notebook skips completed runs and resumes an interrupted
one from its checkpoint. Nothing is scheduled here — all recurring work runs in
GitHub Actions (below).

`notebooks/train_studio_lab.ipynb` is the original SageMaker Studio Lab
notebook, kept because it still runs. Studio Lab closed to new customers in
July 2026; new work should use the Kaggle notebooks.

Fairness note carried over from the bake-off: the transformer reserves the
season right before each test year as an early-stopping validation set, while
the baselines are fit through that season with no holdout — a small handicap
for the transformer, called out here rather than hidden.

## Automation (GitHub Actions)

Three workflows live in `.github/workflows/`:

- **`ci.yml`** — runs the test suite (`pytest -W error`) on every push to `main`
  and on every pull request.
- **`weekly-update.yml`** — regenerates the site JSON in-season. Runs on a
  cron of `23 5 * 9-12,1 3` (Wednesdays 05:23 UTC — overnight after
  Tuesday's stat finalization, ET — September through January), and can
  also be triggered manually (`workflow_dispatch`).
- **`pages.yml`** — deploys `site/` to GitHub Pages whenever a push to
  `main` touches `site/**`, can be triggered manually, and is explicitly
  dispatched by `weekly-update.yml` after it pushes fresh data (bot-token
  pushes don't fire `on: push` workflows, so the weekly job calls
  `gh workflow run pages.yml` itself).

**Fail-safe contract:** `weekly-update.yml` generates the site JSON before it
commits anything. If the data pull or generation step fails for any
reason, the job fails before the commit step runs, so nothing is committed
and nothing deploys — the site keeps serving last week's data, with its
"data as of" stamp still honestly showing when that data was generated.

**Deployed model:** the `env:` block at the top of `weekly-update.yml`
selects the model. It is set to `MODEL: transformer` with `ARTIFACT_ROOT:
models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44` —
three *run roots*, not `through<year>` directories; the predictor appends
`through{last-trained-season}` to each and averages the quantiles. A single
root deploys a single model; the comma-separated list is what makes it a
3-seed ensemble.

**Preseason draft-board refresh:** before week 1, run `weekly-update.yml`
manually with the `draft` input checked. This regenerates only the draft
board (`--draft`, no `--week`), since the target season has no games yet
and requesting its weekly stats would fail; the weekly slate resumes once
the season starts (cron or plain dispatch, which use `--week auto`).

## Results

Walk-forward only: train on seasons ≤ S, test on S+1, held-out years
2023-2025. There are no random splits anywhere — rolling features make them
leak the future into the past. Weekly PPR points, pooled over the three
held-out seasons (`models/backtests/bakeoff.json`, n = 17,908 player-weeks):

| model | MAE | QB | RB | WR | TE |
|---|---|---|---|---|---|
| naive last-4 average | 4.612 | 6.57 | 4.44 | 4.62 | 3.75 |
| XGBoost | 4.448 | 6.34 | 4.33 | 4.47 | 3.54 |
| **transformer** (3-seed ensemble) | **4.325** | **6.24** | **4.33** | **4.25** | **3.45** |

The transformer is ahead everywhere, but read the size before the ranking:
0.12 points per player-week overall, and RB is 4.3253 against 4.3294 — a win
in the fourth decimal, which is a tie. WR and QB are where the gap is real.
The baselines run through the identical eval harness, and the deployed model
is whichever one actually won.

Two later experiments were pre-registered, and neither was promoted. Both
verdicts are committed under `models/diagnostics/` next to the criteria, which
record `recorded_before_results: true`. The two failed differently, and the
difference is the point:

- **feature-pack v2** (`air_share`, `team_pass_att_last4`, `is_indoor`)
  **passed both declared criteria** — MAE below the committed 4.3263 bar,
  calibration inside [0.75, 0.85] for every position-season. It was withheld
  anyway, on checks that were explicitly **post-hoc**: a paired test over the
  17,908 identical held-out rows puts the gain inside noise, the sign flips
  across seasons, and QB regresses significantly (+0.082 MAE, CI excluding
  zero). Passing the letter of a gate is not the same as having an effect.
- **conditional-mean head** — 9 walk-forward folds, 40 Kaggle runs. This one
  **failed its pre-registered primary** outright: within-position weekly
  Spearman pooled over RB/WR/TE — the registered population, with QB held out
  as a separate guard — delta −0.0005, 95% CI [−0.0015, +0.0004], plus a
  failing band guard. The second arm failed its own gate too.

The site still serves v1. A negative result that is cheap to run and honestly
recorded is worth more than a promotion that would not have replicated.

## Status

- [x] Plan 1: data pipeline, scoring, features, eval harness, baselines
- [x] Plan 2: quantile transformer trained (Kaggle T4), 3-seed walk-forward
      ensemble deployed as the site model
- [x] Plan 3: draft board + weekly site, GitHub Actions automation, Pages live
- [x] Draft tool: pick-time optimizer, live Sleeper draft mode, keeper
      handling, trade calculator
- [ ] In-season: the weekly cron takes over from week 1

Scope guards (v1), deliberately: QB/RB/WR/TE only — no K/DST/IDP projections,
no DFS optimization, no injury or news signals.
