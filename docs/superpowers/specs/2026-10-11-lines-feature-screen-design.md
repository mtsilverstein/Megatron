# Betting-lines feature screen — design (pre-registration)

**Status:** draft 2 (2026-10-11). Draft 1 (4e5edc4) was reviewed by astra (`.review/astra-lines-spec-response.md`,
REVISE); this draft resolves every item (§12 trace). Owner decisions: published betting lines are allowed as market
context (design spec §11 amendment, 2026-10-07); this batch is **lines only** (the 9-vs-11-season history screen is not
run); the batch is capped at **two working days** of effort. Design follows astra's roadmap consult
(`.review/astra-roadmap-consult-response.md` §3, §6).

## 1. Question

Does adding the betting market's view of each game — the team's **implied points** and **expected margin** — to the
XGBoost baseline reduce weekly PPR point error by a material amount on held-out seasons?

This is a decision test, not a product change. A historical point-screen pass buys exactly one forward test (§9). Any
other disposition ends active model work for this season (roadmap 2026-10-07: maintenance by default).

**Timing (stated in the artifact and wherever the result is quoted):** these are historical schedule lines, treated as
closing-time context based on nflfastR's documentation of the related fields (`spread_line`/`total_line` described as
closing lines from Pro-Football-Reference); their book and quote time are not recorded in the feed, and their
availability at our mid-week deadline is **unverified**. Our site publishes mid-week, so this screen **admits
information later than our publication deadline** (injuries, lineup decisions, weather and market moves up to the
close). It is an **optimistic historical information screen**: a pass shows the information is worth chasing, not that
a mid-week deployment would gain the same. "Optimistic" is a description, not a mathematical bound. A result is never
described as deployable performance.

## 2. Data

- **Source:** `nflreadpy.load_schedules(seasons)` (nflverse `schedules/games`), read by a new module
  `src/ffmodel/data/lines.py`. `ffmodel.data.pull.pull_schedules` (eight columns) is not edited.
- **Input freeze:** the raw schedule payload used for the run is saved as a private local snapshot (parquet, under
  `data/` which is gitignored) before any model is fitted; the run records its retrieval time, nflreadpy version and
  sha256. All model runs read that snapshot, never the live URL.
- **Allow-list:** the module selects exactly `season`, `week`, `game_type`, `game_id`, `home_team`, `away_team`,
  `spread_line`, `total_line` before any transformation. A test proves that outcome columns present in the raw payload
  (`result`, `total`, `home_score`, `away_score`, …) cannot change the features or the model matrix (perturbing them
  leaves both byte-identical). The allow-list addresses direct outcome leakage only; it is not a timing audit.
- **Coverage (claimed 2026-10-11, re-checked by the loader at run time and recorded):** 3,663 REG games 2012–25, zero
  missing `spread_line`/`total_line`.
- **Sign convention:** the nflverse schedule dictionary defines positive `spread_line` as **home favoured**. That
  dictionary is the authority; the outcome correlation (+0.44) is corroboration only. The loader never infers or flips
  signs from outcomes. At neutral sites the documented home team is the designated home side; its spread is used as is.
- **Scope:** REG games only (`game_type == "REG"`), seasons 2012–2025.
- **Team codes:** both join sides are normalised (`OAK→LV`, `SD→LAC`, `STL→LA`, as `normalize_schedule_teams`), then
  validated against the fixed canonical 32-team set. `game_id` is preserved unchanged.

### 2.1 Validation and error taxonomy

Two classes, decided per game before joining:

- **Recoverable — missing quote.** A game uniquely identified (one `game_id`, two distinct canonical teams, no
  team-week collision) but with a missing or non-finite `spread_line` or `total_line`, `total_line <= 0`, or a negative
  implied total: **both features are NaN for both teams**, every player row is kept, and the reason is counted. No
  carry-forward, backfill or line-complete-only analysis.
- **Fatal — ambiguous identity.** Any of: duplicate `game_id` records that disagree on teams; two `game_id`s claiming
  the same (season, week, team); missing key fields; an unknown team code; identical home and away team. The run
  **stops** with status `invalid` (§7); no record is preferred or dropped to continue. Exact duplicate `game_id`
  records (identical in every allowed column) collapse to one and are counted.
- **Join:** a validated unique team-game table (two sides per valid game) is merged onto the feature frame on
  (season, week, team) with `validate="many_to_one"`. Asserted: player-row count, order and keys unchanged; every
  joined pair satisfies home + away implied = `T` and home − away implied = `m` (within 1e-9). Counts of matched,
  missing-quote and unmatched player rows are recorded per training/test season, with reasons; an unmatched schedule
  join (a team-week with no game) is reported separately from a missing quote.

## 3. Features

For a team in a game with total `T = total_line` and home margin `m = spread_line`:

- `team_implied_total` = `(T + m)/2` for the home team, `(T − m)/2` for the away team.
- `team_expected_margin` = `m` for home, `−m` for away.

Worked example: `T = 46`, `m = +6` → home 26 / away 20, margins +6 / −6. These are market-implied scoring proxies, not
conditional means or offensive-only expectations. They are **current-game** columns joined like `is_home`; no lagged or
outcome-derived variant, no missing-indicator column.

**Feature lists (pinned).** On the frozen input:

- Arm A uses `feature_columns(df, "v1")` — the existing 40-column list, recorded in the manifest. A test pins that list
  and its values unchanged on the frame augmented with the two line columns. v2 behaviour is also unchanged.
- Arm B uses exactly `A_list + ["team_implied_total", "team_expected_margin"]` (42 columns, this order). It is built by
  a new explicit feature set `v1_lines` whose resolution appends those two names after the v1 list; resolution
  **raises** if either column is absent, so B can never silently run as A.

## 4. Experiment

- **Arms:** A = `XGBBaseline(feature_set="v1")`; B = `XGBBaseline(feature_set="v1_lines")`. Identical estimator
  configuration (300 trees, depth 5, lr 0.05, subsample 0.8, colsample 0.8, `hist`, `n_jobs=-1`), no tuning; resolved
  parameters and xgboost/numpy/pandas versions recorded. Predictions are unclipped stat components, as today. (Paired
  seeds reduce noise but do not make tree randomness identical when the column count differs under column subsampling.)
- **Population:** REG feature rows of QB/RB/WR/TE built by `build_features` from 2012–2025 actuals; training rows for
  test season S are seasons 2012..S−1 (`walk_forward_splits`); test seasons 2023, 2024, 2025 (expected 5,893 / 5,920 /
  6,095 rows; 17,908 total — recorded, and a mismatch is reported, not tuned away). Row keys
  (`player_id`, `season`, `week`) unique and non-null. Both arms see identical rows, indices, targets and non-line
  matrices (asserted). Rows with NaN line features stay in both arms.
- **Seeds:** 0, 1, 2 — paired across arms.
- **Row-level collector:** a new function (same walk-forward and scoring contract as `harness.run_backtest`, including
  its prediction-index check) returns, per test row: `player_id`, `season`, `week`, `position`, `actual`, and each
  arm/seed point prediction. `run_backtest`'s aggregate output is not used.
- **Scoring (common-component PPR):** `actual = fantasy_points(test[PREDICTED_STATS], PPR)` and
  `pred = fantasy_points(pred_stats[PREDICTED_STATS], PPR)` — exactly the components in `PREDICTED_STATS`, 4-point
  passing TDs, no two-point conversions or special-teams TDs (as `bakeoff.json`). A non-finite predicted component
  makes the run `invalid`; it is never scored as zero.
- **Per-row, per-seed loss difference:** `d_{i,s} = |actual_i − predA_{i,s}| − |actual_i − predB_{i,s}|`. Positive means
  lines helped. **Seed-averaged** `d_i = mean_s d_{i,s}`. (Loss of averaged predictions is never used; seeds are not
  independent test sets and this is not an ensemble evaluation.)

## 5. Statistics (fixed now)

### 5.1 Primary effect

`G = mean over S ∈ {2023, 2024, 2025} of (mean of d_i over rows in S)` — rows averaged within season, seasons weighted
equally. Per-season `G_S` and per-seed `G^{(s)}` (same formula on `d_{i,s}`) are reported.

### 5.2 Bootstrap (crossed clusters)

- **Player universe:** the sorted distinct `player_id`s of the 2023–25 test panel (`P` of them).
- **Blocks:** within each season, week-pair blocks `b = (week − 1) // 2` (weeks 1–2, 3–4, …, 17–18); each season has
  its fixed sorted list of blocks present in its test rows (9 for an 18-week season).
- **One replicate:** with NumPy `Generator(PCG64(20261007))`, in this order: draw `P` player indices uniformly with
  replacement → player counts; then, for each season in ascending order, draw that season's block count of blocks
  uniformly with replacement from its block list → block counts. Row weight
  `w_i = player_count[player_id_i] × block_count[season_i, b_i]`. Each season's mean is the weighted mean
  `Σ w_i d_i / Σ w_i`; `G*` is the equal-weight mean of the three. The two arms are never resampled separately.
- **Acceptance:** a replicate in which any season has `Σ w_i = 0` (or, jointly, any season of the relevant cohort has
  zero weight — §5.3) is rejected and redrawn; rejections are counted. Collect **10,000 accepted** replicates; at most
  100,000 attempts, after which the run is `invalid` (§7).
- **Interval:** central 95% percentile interval of the accepted `G*` (NumPy `percentile`, `method="linear"`). Per-season
  and per-seed intervals use the same accepted weights.
- **Single primary claim → 95%** (no multiplicity split now that the history screen is dropped). The interval is a
  crossed-cluster screening approximation, conditional on this fitted protocol and the observed era; these seasons were
  used in earlier development, so they are not untouched holdouts.

### 5.3 Relevant-cohort guardrail

- **Membership** frozen once from out-of-fold arm-A predictions: row `i` is relevant if `mean_s predA_{i,s} ≥ 8` PPR.
  It does not change with B, seeds or replicates.
- `G_rel` = same formula as `G` (seed-averaged `d_i`, rows within season, seasons equally) restricted to relevant rows;
  bootstrap intervals use the **same accepted replicates and weights** as §5.2, restricted to the cohort.
- If any season has no relevant rows in the original data, the guardrail is **not evaluable** and cannot pass. Counts by
  season and position, unique players and represented blocks are reported.
- **Deterioration** `H = −G_rel`. Its 95% upper endpoint is `−(lower endpoint of the central 95% interval of G_rel)`.
  The guardrail passes exactly when that value is `≤ 0.10`.

### 5.4 Ranking status (separate from the point pass)

- **Cells:** `(season, week, position)` with ≥ 5 distinct players, QB/RB/WR/TE, all test rows (not only relevant).
- **Per seed:** Spearman (higher points = better; average ranks for ties) of predicted vs actual points, separately for A
  and B; per-cell paired delta `B − A`. Average deltas over the three seeds, then equally over eligible cells within a
  season, then equally over seasons → pooled delta `R`. Position-specific deltas (same weighting) are diagnostics only.
- **Common eligible cells:** a cell is excluded symmetrically (counted) when its actuals are constant. If either arm in
  any seed has a constant or non-finite prediction in an otherwise eligible cell, the ranking status is **not
  evaluable** (it is never treated as safe).
- **Ranking veto:** `R < −0.005` → `ranking_veto`. The veto does not change the point pass (§6); it forbids
  recommending lines for any ranking product. A point pass with a ranking veto may still buy the point-focused forward
  test (§9), with the veto carried into its pre-registration.

## 6. Decision rule (point screen)

**Pass** only if all hold, evaluated on unrounded values:

1. `G ≥ 0.05` PPR MAE;
2. the central 95% interval's lower bound `> 0` (exactly 0 fails);
3. at least two of the three seasons have `G_S > 0`;
4. no season has `G_S < −0.05` (exactly −0.05 is allowed);
5. all three per-seed aggregate gains `G^{(s)} > 0`;
6. the relevant-cohort guardrail passes (§5.3; not evaluable = fail).

A pass establishes a positive gain whose point estimate is material; it does **not** establish that the true gain
exceeds 0.05, and is never described as such.

**Scientific failure labels** (valid, complete run only):

- **Below materiality:** the interval's upper bound `< 0.05` → "below our materiality threshold" (never "markets contain
  no useful information").
- **Inconclusive / unstable:** any other failed condition, each named.

## 7. Invalid / not completed

A separate disposition `invalid` covers: a fatal data error (§2.1), a non-finite prediction, an undefined required
metric, fewer than 10,000 accepted replicates within the attempt limit, or the effort cap (§10) reached. It authorizes no
further model work under this budget and is **not** evidence that lines failed statistically; it is never written up as
"what didn't work". A run is never shortened (fewer seeds or seasons) to finish.

No threshold, seed, fold, population, feature definition or statistic changes after a result is seen. A defect found
after the run is named, fixed and the run repeated, keeping both manifests and results. Changing a valid but
disappointing analysis is a new experiment, not a defect fix.

## 8. Run manifest (frozen before any model is fitted)

Committed or recorded before fitting: this spec's path and git blob id; the implementation commit; the input snapshot's
sha256, retrieval time and nflreadpy version; the A and B column lists in order; resolved estimator and scoring
configuration; software versions; row counts per season and per arm; training/test ranges; RNG specification. The run
writes `models/diagnostics/lines_screen.json` (allow_nan=False) containing the manifest, the timing label, G / G_S /
G^{(s)} with intervals, rejection counts, the relevant-cohort result with counts, the ranking status with per-position
diagnostics and exclusion counts, the decision with failed conditions named, and runtime. Paired row-level predictions
and losses are saved to a local file under `data/` (gitignored) whose sha256 is in the artifact. A short
`docs/methodology.md` paragraph reports the outcome either way (§4 "What didn't work" only for a scientific failure).

## 9. What a pass buys

One forward **shadow** test, pre-registered separately before it starts:

- only weeks forecast **after** that protocol and model are frozen count as prospective; already-observed 2026 weeks or
  reconstructed predictions never count;
- arm B's line features come from the market-snapshot collector's captures (private repo, since 2026-10-07) taken at our
  real publication cutoff and before kickoff, with a predetermined source/aggregation and missingness rule and no
  later-close substitution;
- it must measure the input-distribution change (a model fitted on closes, served mid-week lines);
- it compares against the production transformer's published projections — a product comparison, not an isolated
  estimate of the two features' contribution — with its own pre-declared threshold, and carries any ranking veto.

No site change on the historical result alone.

## 10. Effort cap and stop

Two working days total, including review. If data validation or the driver needs more, stop and report (`invalid`)
rather than extend. Model work stops after this batch unless §6 passes.

## 11. Testing (synthetic, no network)

- Implied-total identities, sign convention, pick'em, neutral-site home side, the worked example.
- Team-code mapping incl. `OAK/SD/STL`; unknown code → fatal; identical home/away → fatal; conflicting duplicate
  `game_id` → fatal; team-week collision → fatal; exact duplicate → collapsed and counted; missing/non-finite quote,
  `T ≤ 0`, negative implied total → NaN features for both sides, rows kept.
- Allow-list: perturbing outcome columns leaves features and matrix byte-identical.
- Join: `many_to_one`; row count/order/keys unchanged; unmatched join vs missing quote reported separately.
- Feature lists: A unchanged (40) on the augmented frame; B = A + the two columns (42), in order; v1_lines raises when
  a column is absent; v2 unchanged.
- Scoring: scoring extras present in the frame do not enter `actual`; non-finite prediction → invalid.
- Statistics: unequal season sizes still weight seasons equally; average loss ≠ loss of average predictions (seed
  averaging is on losses); relevant membership fixed under B changes and resampling; bootstrap deterministic with the
  seed, week pairs move together, a player's multiplicity carries across seasons, empty-season rejection and the attempt
  limit; ranking cells paired, ≥ 5 players, constant-actual exclusion, constant-prediction → not evaluable.
- Decision: each of the six conditions failing in turn; the exact boundaries (G = 0.05 passes; lower bound = 0 fails;
  a season at −0.05 allowed; deterioration upper bound = 0.10 passes); both failure labels; invalid paths; ranking veto
  independent of the point pass.

## 12. Trace of astra's review of draft 1

| Item | Resolution |
|---|---|
| 1 Relevant cohort and ranking undefined | §5.3 (arm-A membership, weighting, shared replicates, not-evaluable, H endpoint); §5.4 (cells, seeds, ties, weighting, pooled veto, not-evaluable); point pass vs ranking veto consequences |
| 2 Scoring, features, row-level evaluation | §3 pinned 40/42 lists and raising resolution; §4 common-component PPR, row-level collector, invalid on non-finite; bootstrap defined in §5.2 rather than reusing `paired_bootstrap` |
| 3 Missing quotes vs ambiguous identity | §2.1 taxonomy, `many_to_one` join and assertions; dictionary as sign authority; neutral sites; allow-list as a perturbation test |
| 4 Timing wording | §1 later-information statement and qualified provenance; §2 input snapshot; §9 prospective-only forward test |
| 5 Reproducibility and dispositions | §5.2 RNG/draw order/acceptance/percentile method; §7 invalid; §8 manifest frozen before fitting; §6 "positive gain with material point estimate" wording |
