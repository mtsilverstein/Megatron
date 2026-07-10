# ff-model

NFL fantasy football projections: a small quantile transformer (trained on a
free SageMaker Studio Lab T4) versus classical baselines, evaluated honestly
with walk-forward backtests, published as a static site that updates itself
weekly during the season.

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

## Training on SageMaker Studio Lab

1. Start a **GPU** runtime (T4; 4h/day quota) and open a terminal.
2. Once: `git clone <repo-url> && cd <repo> && pip install -e .`, then set your
   git identity (`git config --global user.name "..."` and `user.email "..."`)
   and authenticate for pushing — a fresh Studio Lab runtime has neither
   configured. Use a GitHub personal access token as the clone/push credential,
   or run `gh auth login` if the `gh` CLI is available.
3. Open `notebooks/train_studio_lab.ipynb` and run the cells top to bottom.
   Each config trains one walk-forward artifact (`models/transformer/v1/through<year>/`);
   training checkpoints every epoch, so if the session dies, restart the runtime
   and rerun the same cell adding `--resume`.
4. The last cell runs the full bake-off and commits artifacts + results.
   Note on fairness: the transformer reserves the season right before each
   test year as an early-stopping validation set, while the baselines are
   fit through that season with no holdout — a small handicap for the
   transformer that we call out honestly in the results rather than hide.

Local CPU training works identically (slower): same commands, no notebook needed.

## Status

- [x] Plan 1: data pipeline, scoring, features, eval harness, baselines
- [x] Plan 2: quantile transformer code complete (CPU smoke-tested end-to-end on real data)
  - Transformer walk-forward artifacts: pending GPU training (see Training on SageMaker Studio Lab)
- [ ] Plan 3: draft board + weekly site, GitHub Actions automation
