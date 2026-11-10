# ff-model

NFL fantasy football projections: a small quantile transformer (trained on a
free Kaggle T4) versus classical baselines, evaluated honestly with
walk-forward backtests, published as a static site that updates itself weekly
during the season.

The site is six static pages, no backend and no framework: **weekly
projections** with p10/p50/p90 bands and start/sit advice, a **waivers** desk,
a **trade calculator**, a **connect** page that finds a visitor's Sleeper
leagues, the 2026 **draft board** (kept as an archived record once the season
began, with its pick-time optimizer and keeper tools hidden), and an **about**
page carrying the backtest and live-accuracy numbers. No page defaults to a
particular league: the in-season pages work for any Sleeper league a visitor
connects. Models predict raw stat lines; fantasy points are computed from
those by pure scoring functions, so PPR, half-PPR, standard and any league's
custom rules all derive from one set of predictions.

**Start here:** [`docs/case-study.md`](docs/case-study.md), a two-page overview of what was built, how the numbers
are kept honest and what they say. The full record is [`docs/methodology.md`](docs/methodology.md).

**Live site:** [megatron-ff.vercel.app](https://megatron-ff.vercel.app) ·
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

## Draft board (2026, archived)

The 2026 draft boards were built per registered league, each from its YAML
file in `configs/leagues/`. The Sleeper leagues' files record **every nonzero
Sleeper scoring category**, checked against the live leagues on 2026-09-07.
Once the season began
the board became an archived record of what the model projected before it.
Building the board per scoring format, with keeper rules read from the league
a visitor connects, is a 2027 item (`docs/2027-offseason-plan.md` §4.4). The
in-season pages (Weekly, Waivers, Trade) are not tied to any registered league:
they read the connected league's own settings and apply them to the
league-neutral data (see `docs/remaining-season-projections.md`).

Before a draft, run this read-only check from the repository root:

```powershell
.\.venv\Scripts\python.exe tools/check_draft_readiness.py
```

It compares each registered board with its config and the live Sleeper league
and draft settings, then runs the production JavaScript contract and optimizer
checks. The live panel also rechecks settings during the draft and refuses a known
scoring or roster mismatch. Standalone mocks must be set up to match the league;
Sleeper's mock defaults can differ, and mock scoring cannot be verified through
a league ID.

Projection limits are shown on each board. QB forecasts include an approximate
pick-six expected-cost adjustment, using the observed NFL pick-six/interception
rate from completed seasons in `data_snapshots/pick_six_rates.json`. Interception
volume is estimated by integrating a nonnegative, piecewise-linear curve through
the model's interception quantiles (point-only models use their point estimate).
The expected penalty shifts all weekly band endpoints equally before the normal
games-played simulation, including rookie QBs. It is not a trained pick-six head
and does not add discrete pick-six uncertainty or player-specific return rates.
Historical scoring is unchanged: an observed pick-six still costs the ordinary
interception penalty plus the extra penalty; missing actual counts remain zero.
50+ yard TD bonuses, two-point conversions, and return/recovery TDs remain
unprojected. K/DST reminders use ADP, not model point projections.

The manual draft refresh workflow rebuilds the registered Sleeper leagues'
boards. The scheduled refresh writes the league-neutral batch the in-season
pages read, plus a legacy weekly file for each registered Sleeper league (the
2026 live scorecard reads one of them). To regenerate a board locally, use
`ffmodel.site.generate --draft --league <slug>`, where `<slug>` names a file in
`configs/leagues/`, with the normal model/artifact arguments.

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

The main workflows in `.github/workflows/`:

- **`ci.yml`** runs the Python suite (`pytest -W error`) and every Node fixture on each push to `main` and on every
  pull request.
- **`weekly-update.yml`** regenerates the site JSON in season. It runs twice daily (`23 5,17 * 9-12,1 *`, September
  through January) so that 72-hour consumers stay fresh, and it can also be triggered manually; once every
  regular-season game is final it exits cleanly without publishing a slate. The site is served from `site/` by
  Vercel, which redeploys on every push to `main`.
- **`weekly-accuracy.yml`** scores the projections committed before each week's first kickoff (proven by GitHub push
  records) against what happened, for players who recorded a stat line, every Tuesday and Wednesday. It publishes the
  scorecard in `models/diagnostics/live_<season>_weekly.json`.
- **`market-snapshots.yml`** runs after each site update. It archives third-party market data (projections, game
  lines, player props) into a **private** repository, for future pre-registered tests. Nothing it captures is
  committed here.
- **`prospective-freeze.yml` / `prospective-outcomes.yml`** freeze a pre-registered 2026 forecast, then capture its
  outcomes after the season.

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
held-out seasons (`models/backtests/bakeoff.json`; the median-objective entrant
is in `models/backtests/xgb_median/bakeoff_xgb_median.json`; n = 17,908
player-weeks):

| model | MAE | QB | RB | WR | TE |
|---|---|---|---|---|---|
| naive last-4 average | 4.612 | 6.57 | 4.44 | 4.62 | 3.75 |
| XGBoost, squared error (a mean predictor, single seed) | 4.448 | 6.34 | 4.33 | 4.47 | 3.54 |
| XGBoost, median objective (3-seed ensemble) | 4.326 | 6.29 | 4.31 | 4.26 | 3.42 |
| transformer (3-seed ensemble) | 4.325 | 6.24 | 4.33 | 4.25 | 3.45 |

The committed XGBoost baseline uses XGBoost's default squared-error
objective: it predicts means and is scored on MAE, which rewards a median, so
nearly all of its 0.12-point deficit is the objective. Given the transformer's
median objective (pinball loss at 0.5) and nothing else changed, XGBoost ties
it: a paired difference of −0.001 points per player-week, 95% interval
[−0.021, +0.019] (season-week cluster bootstrap,
`models/backtests/xgb_median/paired_xgb_median.json`). The squared-error row is
a single seed and the median row a 3-seed ensemble; a single-seed median
entrant also ties (see the methodology, §3). No held-out season
separates them. By position only TE does, and it favours XGBoost
(+0.035, [+0.003, +0.069]), one of seven uncorrected sub-group cells. The
baselines run through the identical eval harness. The transformer's distinct
contribution is the calibrated p10–p90 band, which XGBoost does not publish.

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
- **conditional-mean head** — 9 walk-forward folds × 3 seeds, 40 Kaggle runs
  in all (27 mean-head fits, 9 baseline fits that completed the v1 folds and 4
  λ-selection runs; the two arms are two read-outs of the same fits). This one
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
- [x] Plan 3: draft board + weekly site, GitHub Actions automation, site live
      (first on GitHub Pages, now on Vercel)
- [x] Draft tool: pick-time optimizer, live Sleeper draft mode, keeper
      handling, trade calculator
- [x] In season: automated twice-daily refresh, any-Sleeper-league weekly, waiver and trade tools
- [x] Live accuracy scorecard and a pre-registered same-week re-measurement against expert consensus (model behind;
      see the methodology)
- [x] Betting-lines feature screen, run once, pre-registered: fail / inconclusive (gain 0.039 against a 0.05 bar),
      on the squared-error XGBoost baseline; not re-run with the median objective
- [x] Median-objective XGBoost bake-off: ties the transformer on point MAE (difference −0.001, [−0.021, +0.019])
- [ ] Season end: the private blend comparison is read once after week 18

Scope guards (v1), deliberately: QB/RB/WR/TE only — no K/DST/IDP projections,
no DFS optimization, no injury or news signals.
