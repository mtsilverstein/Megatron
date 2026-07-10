# ff-model

NFL fantasy football projections: a small quantile transformer (trained on a
free SageMaker Studio Lab T4) versus classical baselines, evaluated honestly
with walk-forward backtests, published as a static site that updates itself
weekly during the season.

**Design spec:** `docs/superpowers/specs/2026-07-09-fantasy-football-model-design.md`

## Quickstart

```bash
python -m venv .venv                # Python >= 3.10
.venv/Scripts/python -m pip install -e ".[dev]"   # POSIX: .venv/bin/python
pytest                          # unit tests (offline)
pytest -m integration           # network tests against live nflverse data

python -m ffmodel.data.pull     # cache 2012-2025 data to data/raw/
python -m ffmodel.eval.run      # walk-forward backtest -> models/backtests/baselines.json
```

## Status

- [x] Plan 1: data pipeline, scoring, features, eval harness, baselines
- [ ] Plan 2: quantile transformer trained on Studio Lab (T4)
- [ ] Plan 3: draft board + weekly site, GitHub Actions automation
