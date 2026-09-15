# Rookie research protocol v1

Status: research only. No promotion or production changes authorized by results
from this protocol alone. No new inference sweep is part of establishing it.

## Data roles

- Training for each evaluated class S: draft classes and stat observations through
  S-1 only. Features for each forecast origin must stop before that origin.
- Development targets: classes 2017–2020. Candidate selection and debugging belong
  here, using existing prior-season transformer artifacts. These are development
  years, not evidence of untouched generalization.
- Retrospective validation targets: 2021–2022. Freeze the candidate specification
  before running it on these classes. They may have been used by other project
  work; we have not established that they are untouched. Use results as a
  chronological stability check, not an independent final holdout.
- Previously inspected diagnostics: 2023–2025. Preserve the existing comparisons.
  Do not use these years to choose blend weights, features, bucket boundaries,
position exceptions, or thresholds and then claim held-out performance.
- Prospective evidence: forecasts captured before their target games after the
  candidate is frozen. No already-played or uncaptured 2026 games qualify.
  A forecast must retain its capture time, origin, league rules, identities,
  code/artifact versions, predictions and exclusions before outcomes are joined.
This protocol does not itself create or schedule such captures.

## Candidate and comparison rules

Freeze the veteran ensemble roots to `models/transformer/v1`,
`models/transformer/v1_s43`, and `models/transformer/v1_s44`, selecting
`through<S-1>` per target class. Before validation, record the source commit and
SHA-256 hashes of every selected model.pt, scaler.json, metrics.json, config.yaml,
and calibration.json where present (including explicit absence). Paths alone
do not protect against a replaced checkpoint. Record the input-data hashes and
league scoring rules with the candidate's exact command and output path.

The existing comparator-only CLI invocations for these phases are:

```powershell
python -m ffmodel.eval.rookie_weekly --decisions --veteran-model transformer --seasons 2017 2018 2019 2020 --origins 5 9 --horizons 1 4 --out models/diagnostics/rookie_development_control_v1.json
python -m ffmodel.eval.rookie_weekly --decisions --veteran-model transformer --seasons 2021 2022 --origins 5 9 --horizons 1 4 --out models/diagnostics/rookie_retrospective_control_v1.json
```

These document reproducible controls, not a newly implemented candidate; they
were not executed while establishing this protocol. A candidate must record its
own exact invocation and version before retrospective validation. Do not run
the retrospective phase as a convenient development debugging loop.

Before validation, record a versioned candidate description and development
results. Fix stat inputs, priors, update formula, hyperparameters, position
coverage, missing-data behavior, origins and horizons. Do not tune a fresh blend
against the already-inspected 2023–2025 results. Raw observed means were rejected
as a universal replacement; that is not proof that every update is harmful.

Use origins 5/9 and horizons 1/4 for continuity with the latest diagnostic.
Keep zero-history and one-to-three-recorded-game rookies separate. Do not assume
that a rule for recorded games solves zero-history or returning-veteran coverage.
Use identical frozen veteran forecasts, scoring rules and candidate pools for
the candidate and comparator; exclude ties from both on the same pair set.
Missing participation or actual rows remain unknown, never zero. Keep all
coverage exclusions and report results by season, position, origin and horizon.

The primary descriptive outcome is paired decision regret, with accuracy,
forecast coverage, number of changed decisions and distinct affected rookies
reported alongside it. Repeated pairs involving the same players are dependent;
do not treat them as independent samples or real fantasy-roster point gains.

## Stop and release rules

Validation failure or mixed results means no automatic rollout. A revised
candidate returns to development with a new version; the viewed validation
results are recorded as exposed. Repeatedly choosing candidates by validation
performance turns that set into development data.

No live advice promotion from a small aggregate regret improvement alone.
Require a separate release review covering prospective evidence, league scoring,
identity/roster correctness, availability assumptions, missing forecasts, and
calibration limits. Numerical promotion thresholds have not been established;
set them before prospective evaluation, not after seeing its results.

Current priority: settle the candidate design on development data, then run one
frozen retrospective validation. No paid data, external FPTS, or unbounded
parameter search is needed. Keep .claude/ read-only and preserve user snapshots.
