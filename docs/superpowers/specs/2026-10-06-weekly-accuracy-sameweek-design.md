# Weekly accuracy tracking and same-week expert benchmark — design

Status: draft 1 (2026-10-06), owner-approved in conversation section by section; awaiting astra methodology review
and owner review of this document.

## 1. Why

Two findings from 2026-10-06:

1. **Live point accuracy is on track.** The projections published before each 2026 kickoff (weeks 1–4) score a
   PPR MAE of 4.36 against a 2023–25 backtest of 4.33. The p10–p90 band covers 79.7% of outcomes, and the
   projections beat the naive last-4 average by 0.31 points per player-week (95% CI [0.14, 0.49]). Nothing
   computes this routinely, so the owner cannot see it week to week.
2. **The weekly expert benchmark was stale by a week.** `eval/weekly_rankings.weekly_snapshot` takes the latest
   nflverse `load_ff_rankings("all")` scrape in `[kickoff − 7d, kickoff)`. nflverse scrapes on one fixed weekday:
   Fridays in 2021–2026 and Thursdays in 2020. So that window holds the *previous* week's rankings.
   - A bye-week check found week N−1's slate in 13 of 13 discriminating weeks of 2023–25 and week N's in 0.
   - So the site's "statistical tie with expert consensus" (2023–25) and its out-of-sample running-back edge
     (2020–22) were measured against experts working a week behind.
   - Commit c38e175 marks both claims "not established" pending re-measurement.

This project makes both things measurable, honestly and repeatably:

- **(A)** an automated weekly scorecard of what the site actually published;
- **(B)** a pre-registered re-measurement of both historical samples against same-week expert rankings.

## 2. Scope

**In scope:**

- A new eval module for the live check.
- A new eval driver for the same-week re-measurement, with shared same-week primitives in a new module.
- A new scheduled workflow, tests and committed artifacts.
- After (B) runs: the copy changes the §5.5 rules dictate, pushed only with the owner's OK.

**Out of scope:**

- Any site scorecard UI. This is phase 2, to be decided once about 8 weeks of live data exist; it will read the
  (A) artifact.
- Any change to the model, the published site data, `weekly-update.yml`'s data path, the frozen prospective paths
  (`models/prospective/**`, `prospective-*.yml`), or the existing benchmark modules `weekly_rankings.py` and
  `weekly_consensus.py`. Their old artifacts stay as the record.

**Repo rules:** the repo is public, so test fixtures are synthetic. No other managers' data enters the repo.

## 3. Shared definitions

- **Week N first-kickoff date `K_N`:** `weekly_consensus.weekly_kickoffs(schedules, season)[N]`, the earliest
  `gameday` of REG week N, as a date. Schedules come from `pull_schedules`, which provides `season`, `week`,
  `gameday`, `home_team` and `away_team`.
- **Played population:** the rows of `build_features(pull_weekly(...), pull_schedules(...))` for (season, week).
  For the live check, the pull spans seasons S−3 through S. That span fixes the lag history and the naive fallback
  means, and it is the span the reproduction numbers in §6 were measured on.
  Each row is one player who recorded a REG stat line that week. This is the population of `bakeoff.json` and
  `weekly_consensus.json`. Actual points are `fantasy_points(row[PREDICTED_STATS], PPR)`.
- **Player game date:** the `gameday` of the schedule row in (season, week) where the player's `team` is home or
  away. Team codes are normalised exactly as the existing pipeline does: `pull_schedules` already applies
  `normalize_schedule_teams`.
- **Complete week:** every REG (week, team) pair in the schedule has at least one row in the played population.
  This is the `prospective.freeze.check_fresh` rule, applied to one week. Incomplete weeks are skipped and listed,
  never scored.
- **Bye-week identity gate** for a rankings scrape assigned to week N. Let `A` be the set of teams on bye in week
  N and `B` the set of teams on bye in week N−1, among the season's teams. Let `R` be the set of teams of the
  scrape's QB/RB/WR/TE rows, normalised to schedule codes with the same mapping `attach_gsis` uses.
  - **Fails** if either count shows staleness:
    - `A ≠ ∅` and `|A ∩ R| > |A|/2` (most week-N bye teams are ranked), or
    - `B ≠ ∅` and `|B ∩ R| < |B|/2` (most week-(N−1) bye teams are missing).
  - **Passes** otherwise. This includes weeks with no byes on either side, which are non-discriminating.
  - **Why this rule:** a week-N ranking omits week-N byes and includes week-(N−1) byes, and a stale scrape shows the
    reverse. The 2023–25 check saw the reverse on both counts, e.g. 2/2 and 0/4. Presence is judged per team, so one
    unranked depth player cannot flip a count. The majority threshold tolerates a single mis-teamed row.
  - **Failing weeks** are skipped and listed with the counts.
- **Ranking metrics:** reused unchanged.
  - Per week: `weekly_rankings.score_week(cell, season, week, REPLACEMENT_RANK, min_cell=5)`, with cells from
    `weekly_consensus.week_cell` and positions from our frame.
  - Pooled: `weekly_consensus.pooled_stats` and `per_position`. These are cell-weighted Spearman with a paired
    bootstrap, `BOOTSTRAP_SEED = 20260728`, `N_BOOT = 10000`, and `assert_model_sane` before reporting.
  - Degenerate cells are dropped and counted, as in `collect_cells`.

## 4. (A) Live weekly accuracy — `src/ffmodel/eval/live_accuracy.py`

### 4.1 Projection as published

For week N of season S:

1. Enumerate every commit reachable from `HEAD` that touches `site/data/weekly.json`. Use `git log HEAD --format=%H
   %cI -- site/data/weekly.json`, without `--first-parent`: a fast-forwarded feature merge leaves main's own data
   commits on a second parent (observed 2026-10-06).
2. Keep commits whose committer time is strictly before `K_N` 00:00 UTC. This is a date-level boundary,
   conservative by up to a day, and symmetric with the date-only expert snapshots.
3. Walk them newest first. Take the first whose `site/data/weekly.json` (via `git show <sha>:site/data/weekly.json`)
   has `season == S` and `week == N`.
4. The projection for player `p` is `players[].points.ppr.{p10,p50,p90}`, keyed by `player_id`.
5. If no commit qualifies, week N is listed under `weeks_unpublished` and not scored.

Git access goes through one small injectable function, so tests feed a synthetic history.

### 4.2 Point metrics

Over the played population joined to the projection on `player_id`, per week, per position, and pooled over all
scored weeks:

- `n`; MAE of p50; mean bias `actual − p50`; median of `actual − p50`; share of actual above p50;
- p10–p90 coverage (inclusive), share below p10, share above p90;
- pinball loss at 0.1/0.5/0.9 (`eval.metrics.pinball_loss`).

**Naive baseline:** `NaiveLast4` semantics. The lag-4 stat means from the features frame are scored in PPR. NaN
falls back to the position mean of `PREDICTED_STATS` over all feature rows with `season < S`.

Report naive MAE and the paired delta `|actual − p50| − |actual − naive|`, with a bootstrap 95% CI. The delta uses
`mean_head_gate.paired_bootstrap`, clusters = `player_id`, seed 20260728, 10,000 resamples, and is computed pooled
and per position.

**Unprojected players** (played but no projection row) are counted per week. Also report their share and mean
actual. They are never imputed and never enter a metric.

### 4.3 Ranking vs expert consensus

**Primary: our snapshots.**

- Source: `data_snapshots/weekly_ecr/<S>-wNN-*.json` with `season == S` and `week == N`. Week is inferred by
  `live_experts` from complete opponent agreement.
- Select the snapshots with `snapshot_at` (a date) strictly before `K_N`, and keep those with the latest date.
  - If several files share that date, take the lexicographically first filename. This is deterministic; the files
    carry no time of day.
  - List the others in provenance.
- Rows: `player_id`, `ecr` (positional rank), `position`. The pool is the played population ∩ snapshot rows, as
  in `week_cell`.
- Weeks without a qualifying snapshot are skipped and listed. Expected: weeks 1–2 of 2026.

**Secondary: nflverse same-week.** The §5.2 rule applied to season S. This keeps the live numbers comparable with
the historical re-measurement. Both are reported, labelled by source.

### 4.4 Output

`models/diagnostics/live_<S>_weekly.json`, recomputed from scratch on every run so it is deterministic. Contents:

- `generated_at`, `season`, `repo_commit`;
- `weeks_scored`, `weeks_skipped` with reasons, and a per-week `publication` record (commit, committer time,
  `generated_at`, `data_through`, player count);
- `points` (overall, by_position, by_week, unprojected);
- `ranking.primary` and `ranking.secondary`, each with provenance, overall and per_position;
- `reference_2023_25`, copied with its source paths:
  - MAE 4.33, from `bakeoff.json`;
  - naive 4.61, from `bakeoff.json`;
  - coverage per season, from `bakeoff.json`;
  - the old-protocol Spearman, from `weekly_consensus.json`, labelled "stale-week protocol".

`models/diagnostics/live_<S>_weekly.md` is a short human summary:

- a cumulative headline line;
- a per-week table: week, n, MAE, naive MAE, coverage, ours vs consensus Spearman (or "—");
- a footnote on sample size and the expert-week caveat.

CLI: `python -m ffmodel.eval.live_accuracy --season 2026 --out models/diagnostics/live_2026_weekly.json`, with the
summary written beside it. Data cache: `--data-dir`, default a fresh temp dir, so the current season is always
re-pulled.

### 4.5 Workflow — `.github/workflows/weekly-accuracy.yml`

- **Triggers:**
  - `schedule` at `47 16 * 9-12,1 2` (Tue 16:47 UTC) and `47 13 * 9-12,1 3` (Wed 13:47 UTC, the retry);
  - `workflow_dispatch`.
- **Concurrency:** `group: weekly-site-refresh`, `cancel-in-progress: false`. This is shared with
  `weekly-update.yml` so the two never push concurrently.
- **Setup:** `actions/checkout@v7` with `fetch-depth: 0`; Python 3.12; `pip install -e .`.
- **Steps:**
  - Run the CLI.
  - `git add` only the two `models/diagnostics/live_*_weekly.*` files.
  - If there is no diff, exit 0.
  - Otherwise commit `data: weekly accuracy refresh` and push, with up to 3 attempts of `git pull --rebase` then
    push. Never force.
- **Fail-safe:** any error fails the job before the commit step. The job never writes `site/` and never touches
  published data.
- **Permissions:** `contents: write`.

## 5. (B) Same-week re-measurement — pre-registered

`src/ffmodel/eval/sameweek.py` holds the primitives. `src/ffmodel/eval/weekly_consensus_sameweek.py` is the driver.

### 5.1 Samples and models

| Sample | Seasons | Model | Original artifact (stale-week) |
|---|---|---|---|
| Discovery | 2023, 2024, 2025 | ensemble `{v1, v1_s43, v1_s44}/through{S−1}` via `weekly_consensus.transformer_predictor` | `weekly_consensus.json` |
| Replication | 2020, 2021, 2022 | ensemble `{v1, v1_s43, v1_s44}/through{S−1}`; folds through2019–2021, as recorded in `rb_oos_weekly.json` | `rb_oos_weekly.json` |

Splits come from `walk_forward_splits`. The features use the same `first_season` span as `weekly_consensus.main`.

### 5.2 Same-week snapshot and population

For week N of season S, with `K_N` and `K_{N+1}` the first-kickoff dates (`K_{N+1}` = +∞ for the last REG week):

- **Window:** nflverse weekly scrapes (`normalize_weekly_rankings` rows) with `K_N ≤ scrape_date < K_{N+1}`.
- **Selection:** the latest such scrape date. All rows of that date form the snapshot.
- **Population:** the played rows of week N whose **player game date is strictly after the scrape date**. This
  excludes every game played on or before the scrape day: Thursday games, and Friday/Saturday games on or before
  it.
- **Gate:** the snapshot must pass the bye-week identity gate (§3).
- **Matching:** consensus rows map to `player_id` via `attach_gsis(snapshot, crosswalk)`, unchanged.

**Skip conditions,** each listed with its reason:

- no scrape in the window;
- gate failure;
- an empty pool after the date filter.

**Known asymmetry, stated in the artifact:** the experts' same-week ranking can include Thursday's game and Friday
practice and injury reports. Our projection has neither. Any bias therefore favours consensus.

### 5.3 Metrics

As §3, per sample: overall, per_position, per_season, and the season-cluster sensitivity. Start/sit hit rates are
reported as in the original.

### 5.4 Data sufficiency (pre-registered)

- A sample is **sufficient** if at least half of its REG season-weeks are scored after all skips.
- An insufficient sample yields verdict `insufficient` for every rule that needs it.

### 5.5 Decision rules (pre-registered — fixed before any (B) number is computed)

Let `D` and `CI` be the pooled cell-level delta (ours − consensus) and the paired bootstrap 95% CI.

**Rule 1, overall (Discovery sample):**

| Result | Site wording key |
|---|---|
| CI includes 0 | `tie` — "a statistical tie with same-week expert consensus" |
| CI entirely < 0 | `behind` — "behind same-week expert consensus (delta D, CI)" |
| CI entirely > 0 | `ahead` — "ahead of same-week expert consensus (delta D, CI)" |
| Sample insufficient | `insufficient` — "not established" |

**Rule 2, running-back edge:**

- `established` iff, in **both** samples, RB's `D > 0` and its CI lies entirely above 0. This is the bar the
  original claim was published under.
- Otherwise `not_established`, and the site retracts the RB edge.

**Rule 3:** other positions are reported as numbers only. No position-level claim is made other than Rule 2.

**Rule 4:** the result is reported as computed.

- If a bug is found after the run, fix it, re-run, and publish both results with the reason.
- No parameter in §3, §5.2 or §5.4 may change in response to a result.

The driver computes the verdicts (`rule_1`, `rule_2`) in code from the numbers, with no hand step, and writes:

- `models/diagnostics/weekly_consensus_sameweek.json`. Contents: both samples, the verdicts, per-week provenance
  (scrape date, kickoff, gate counts, pool size, excluded early-game players), the skips, a `protocol` block quoting
  these rules, and the side-by-side old-protocol numbers read from the two old artifacts.

### 5.6 Copy follow-through

After (B), the verdict keys map mechanically to the wording in:

- `site/about.html` (the correction block and section);
- the `site/weekly.html` footer;
- `docs/methodology.md` §3 and §6.

The original text stays visible as the record. The owner approves before the push.

## 6. Testing

Tests are synthetic and live in `tests/`. Each module gets a test file with these checks.

**`live_accuracy`:**

- **Projection selection** (a fake git-history function):
  - strict `<` boundary, so a commit on `K_N` day is excluded;
  - newest qualifying commit wins;
  - wrong-week payloads are skipped;
  - `weeks_unpublished` when none qualify.
- **Complete-week gate:** a week missing one team's rows is skipped.
- **Join:** unprojected players are counted, not imputed.
- **Point metrics:** naive fallback; metric values on a hand-computed frame.
- **Snapshot selection:** latest date strictly before `K_N`; lexicographic tie-break; the week must match.
- **Artifact shape** and the Markdown summary render.

**`sameweek`:**

- **Window and selection:** the latest scrape in `[K_N, K_{N+1})`.
- **Population date filter:** a Thursday game is excluded; a Saturday game is excluded when the scrape was Saturday
  and kept when the scrape was Friday.
- **Gate:**
  - stale on both counts → fail;
  - stale on the week-N count alone, with no week-(N−1) byes → fail;
  - correct pattern → pass;
  - one of four week-(N−1)-bye teams missing → pass;
  - no byes on either side → pass.
- **Regression record:** on the same synthetic data, `weekly_rankings.weekly_snapshot` picks the week-(N−1) scrape.
- **Decision rules:** every row of the Rule 1 table; Rule 2 with each sample failing in turn; insufficiency.

**Reproduction gate (end to end, local):** `live_accuracy` on 2026 weeks 1–4 must match the 2026-10-06 scratch
measurement to 3 decimals:

- MAE 4.359, coverage 0.797, naive MAE 4.673, delta −0.313;
- primary ranking, weeks 3–4: ours 0.4977 vs consensus 0.5146 (delta −0.0169).

Any mismatch is explained before merge.

**Suites:** `pytest -W error` and every `tests/*_fixture.cjs` pass, locally and in CI.

## 7. Rollout

1. **Review:** astra reviews this spec's methodology, then the plan.
2. **Build:** subagent-driven, with Sonnet implementers and task reviews and an Opus final review.
3. **Merge to main:** the code, workflow and tests only. No site data and no frozen paths.
4. **First live run:** run `weekly-accuracy.yml` by hand once and verify the committed artifact against the
   reproduction numbers.
5. **Re-measurement:** run the (B) driver locally once, commit its artifact, and report the verdicts to the owner.
6. **Copy:** apply the §5.6 copy, with the owner's OK before the push.
