# Betting-lines feature screen — design (pre-registration)

**Status:** draft 1 (2026-10-11). Owner decisions: published betting lines are allowed as market context (design spec
§11 amendment, 2026-10-07); this batch is **lines only** (the 9-vs-11-season history screen is not run); the batch is
capped at **two working days** of effort. Design follows astra's roadmap consult
(`.review/astra-roadmap-consult-response.md` §3, §6), adapted to a single primary claim.

## 1. Question

Does adding the betting market's view of each game — the team's **implied points** and **expected margin** — to the
XGBoost baseline reduce weekly PPR point error by a material amount on held-out seasons?

This is a decision test, not a product change. A pass buys exactly one forward test with mid-week lines (§7). A fail
ends active model work for this season (roadmap 2026-10-07: maintenance by default).

**Information-timing label (stated in the artifact and anywhere the result is quoted):** the historical lines in
nflverse schedules are **closing** lines (nflfastR documents `spread_line`/`total_line` as closing lines, sourced
from Pro-Football-Reference); our site publishes mid-week. A historical result is therefore an **optimistic
historical information screen**: it can show the information is worth chasing, not that a mid-week deployment would
gain the same. It is never described as deployable performance.

## 2. Data

- **Source:** `nflreadpy.load_schedules(seasons)` raw rows (not `ffmodel.data.pull.pull_schedules`, which keeps only
  eight columns and is not edited). New module `src/ffmodel/data/lines.py` loads, caches and validates them.
- **Columns used:** `season`, `week`, `game_type`, `game_id`, `home_team`, `away_team`, `spread_line`, `total_line`.
  Never `result`, `total`, `home_score`, `away_score` or any outcome column (allow-list, enforced by a test).
- **Coverage (verified 2026-10-11):** 3,663 REG games 2012–25, zero missing `spread_line`/`total_line`.
- **Sign convention (verified):** positive `spread_line` = home team favoured (corr. with home margin +0.44; e.g.
  2012 W1 NYG −DAL 3.5).
- **Team codes:** raw rows carry `OAK`, `SD`, `STL`; map to the schedule codes the features use (`OAK→LV`, `SD→LAC`,
  `STL→LA`) with the same rule as `normalize_schedule_teams`. Unknown codes are an error.
- **Validation:** REG rows only; exactly one row per `game_id`; each (season, week, team) appears at most once; finite
  `spread_line` and `total_line`; a game failing validation leaves both teams' features missing for that week (never
  imputed from another game).

## 3. Features

For a team in a game with total `T` and home margin `m = spread_line` (home favoured when positive):

- `team_implied_total` = `(T + m)/2` for the home team, `(T − m)/2` for the away team.
- `team_expected_margin` = `m` for home, `−m` for away.

Identities tested: home + away implied = `T`; home − away implied = `m`; a pick'em (`m = 0`) gives `T/2` each.

These are **current-game** context features (known before kickoff), joined to each player row on
(season, week, team) like `is_home` and `rest_days`. A player whose team has no valid line that week gets NaN (XGBoost
handles missing values natively). No lagged or outcome-derived variant.

**Feature set:** a new named set `v1_lines` = the frozen `v1` columns + the two line columns, added to
`BASELINE_FEATURE_SETS`. `v1` stays the default and is byte-for-byte unchanged (a test pins `feature_columns(df, "v1")`
before/after). `build_features` is not changed; the line columns are merged by the screen driver.

## 4. Experiment

- **Arms:** A = `XGBBaseline(feature_set="v1")`; B = `XGBBaseline(feature_set="v1_lines")`. Identical estimator
  configuration (300 trees, depth 5, lr 0.05, subsample 0.8, colsample 0.8, `hist`), no tuning.
- **Folds:** walk-forward test seasons 2023, 2024, 2025; each trains on every season from 2012 to S−1
  (`walk_forward_splits`). Identical rows, targets and test inputs in both arms except the two columns.
- **Seeds:** 0, 1, 2 — paired across arms.
- **Population:** every REG feature row of the test season (players who recorded a stat line), as in `bakeoff.json`.
- **Prediction → points:** predicted stat components → `fantasy_points(·, PPR)`; actual = `fantasy_points` of the
  actual components.
- **Per-row loss difference:** `d = |actual − pred_A| − |actual − pred_B|`, averaged over the three seeds per row first.
  Positive `d` means lines helped.

## 5. Statistics (fixed now)

- **Primary effect** `G` = mean of `d` per season, then the equal-weight mean over the three seasons.
- **Interval:** crossed-cluster bootstrap, 10,000 replicates, RNG seed 20261007. Within each season, calendar weeks are
  grouped into fixed adjacent pairs (1–2, 3–4, …, 17–18); blocks are resampled with replacement; player IDs are
  resampled independently over the whole panel (a player's multiplicity carried across seasons); rows are weighted by
  the product of player and block multiplicities; each season's mean is recomputed and the three are averaged with
  equal weight; a replicate with an empty season is redrawn. **95% percentile interval** (one primary claim — no
  multiplicity split).
- **Per-season effects** `G_2023`, `G_2024`, `G_2025` and **per-seed** aggregate effects are reported.
- **Guardrails** (not alternative routes to a pass):
  - **Relevant cohort:** rows whose arm-A seed-averaged projection is ≥ 8 PPR. Its MAE deterioration
    (`−G_relevant`) must have a 95% interval upper bound ≤ 0.10.
  - **Ranking:** pooled within-position Spearman per position-week cell (≥ 5 players). A drop of more than 0.005
    (B − A) blocks recommending lines for the ranking product, whatever the point result.

## 6. Decision rule

**Pass** only if all hold:

1. `G ≥ 0.05` PPR MAE;
2. the 95% interval's lower bound > 0;
3. at least two of the three seasons have `G_S > 0`;
4. no season has `G_S < −0.05`;
5. all three per-seed aggregate gains are > 0;
6. the relevant-cohort guardrail holds.

Otherwise:

- **Below materiality:** the interval's upper bound < 0.05 → "below our materiality threshold" (not "markets contain no
  useful information").
- **Inconclusive / unstable:** any other failure.

Both failure outcomes end spending on this direction under the current budget. Lack of power is not an obligation to
run more experiments. No threshold, seed, fold, population or feature definition changes after a result is seen; a
defect found after the run is fixed, the run repeated, and both results reported.

## 7. What a pass buys

One forward **shadow** test, specified separately before it starts: the mid-week lines the market-snapshot collector
now saves (private repo, since 2026-10-07) feed arm B's line features at our real publication time, scored against
the production transformer's published projections on the remaining 2026 weeks, with its own pre-declared threshold.
No transplanting the XGBoost gain onto the transformer; no site change on the historical result alone.

## 8. Output

`models/diagnostics/lines_screen.json` (allow_nan=False): protocol (this spec's path + git blob id), the timing label,
inputs with content hashes (schedules raw, features, model config), per-season / per-seed / overall G with intervals,
guardrail results, ranking deltas by position, the decision with its failed conditions named, runtime. A short
`docs/methodology.md` paragraph reports the outcome either way (§4 "What didn't work" if it fails).

## 9. Effort cap and stop

Two working days total, including review. If the data validation or the driver needs more, stop and report rather than
extend. Model work stops after this batch unless §6 passes.

## 10. Testing

Synthetic fixtures: implied-total identities, sign convention, pick'em, away/home symmetry; team-code mapping incl.
`OAK/SD/STL` and an unknown code; outcome columns rejected by the allow-list; duplicate `game_id` and missing lines →
NaN features (not imputed); `v1` columns unchanged by adding `v1_lines`; bootstrap: deterministic with the seed, week
pairs move together, player resampling carries across seasons, empty-season redraw; the decision rule's six conditions
each failing in turn and both failure labels. No network in tests.
