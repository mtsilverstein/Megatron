# Weekly accuracy tracking and same-week expert benchmark — design

**Status:** draft 6 (2026-10-06), a clean rewrite. The owner approved the design section by section in conversation.

Review history:

- Astra reviewed drafts 1–4 and returned REVISE each time. Its responses are in `.review/`:
  `astra-weeklyacc-spec-response.md`, `-r2-response.md`, `-r3-response.md`, `-r4-response.md`.
- Astra's draft-5 review did not run; the Codex usage limit resets 2026-10-09 15:33.
- An adversarial Opus review of draft 5 (`.review/opus-weeklyacc-spec-review.md`) returned REVISE.

Draft 6 fixes every finding and takes that review's cuts X1–X5. §10 is the trace. Astra re-reviews draft 6 and the
plan on 2026-10-09.

## 1. Why

**Live point accuracy has never been tracked.** The projections published before 2026 kickoffs score as follows on
weeks 1–4:

| Measure | Value |
|---|---|
| PPR MAE | 4.36 |
| 2023–25 backtest MAE (n-weighted, `bakeoff.json`) | 4.32 |
| p10–p90 coverage | 79.7% |
| Player-weeks below p10 / above p90 | 8.8% / 11.6% |
| Gain over naive last-4 average | 0.31 points per player-week; 95% CI [0.14, 0.49], player-clustered |

These are descriptive figures. The owner wants them week to week.

**The weekly expert benchmark was a week stale.** `eval/weekly_rankings.weekly_snapshot` takes the latest nflverse
`load_ff_rankings("all")` scrape in `[kickoff − 7d, kickoff)`. nflverse scrapes predominantly once a week: Fridays in
2021–26 and Thursdays in 2020, with a few exceptions (§3.6). So that window usually holds the previous week's
ranking.

- Two exploratory bye-week checks agree, under different definitions: mine found 13/13 stale; astra's found 17/17
  stale and 0 current.
- The reproducible count is the (B) driver's `old_protocol_staleness_audit` (§6.6).
- The site's 2023–25 "statistical tie" claim and the 2020–22 running-back replication were measured against week-old
  consensus.
- Commit c38e175 already marks both claims "not established". That withdrawal stands whatever (B) finds.

**This project:**

- **(A)** an automated weekly scorecard of the projections the bot pipeline published;
- **(B)** a pre-registered reanalysis of both historical samples against same-week rankings. It reanalyses data that
  has already been examined, so it is not a new, untouched replication.

## 2. Scope

**New:**

- `src/ffmodel/eval/sameweek.py`: shared primitives.
- `src/ffmodel/eval/live_accuracy.py`: (A).
- `src/ffmodel/eval/weekly_consensus_sameweek.py`: the (B) driver.
- `.github/workflows/weekly-accuracy.yml`.
- Tests.
- Committed artifacts:
  - `models/diagnostics/live_<S>_weekly.json` and `.md`;
  - `models/diagnostics/main_push_ledger.json`;
  - `models/diagnostics/live_2026_w1-4_reproduction.json`;
  - after (B): `models/diagnostics/weekly_consensus_sameweek.json`.
- After (B), the §6.7 copy changes, pushed only with the owner's OK.

**Unchanged:**

- the model;
- published site data and `weekly-update.yml`;
- the frozen prospective paths (`models/prospective/**`, `prospective-*.yml`);
- `weekly_rankings.py`, `weekly_consensus.py`, `data/rankings.py` and their artifacts.

New code may import them but does not edit them. The site scorecard UI is phase 2 (after about 8 live weeks) and
will read the (A) artifact.

**Repo rules:** the repo is public, so test fixtures are synthetic.

## 3. Shared definitions (`sameweek.py`)

### 3.1 Schedule dates

For REG week N of season S, from `pull_schedules` (team codes normalised by `normalize_schedule_teams`, so the Rams
are `LA`):

- `K_N` = the earliest `gameday` of week N, the first-kickoff date. This equals `weekly_consensus.weekly_kickoffs`.
- `Z_N` = the latest `gameday` of week N.

A player's **game date** is the `gameday` of the unique week-N schedule row containing the player's `team`. Zero or
several matches is a validation error for that row (§3.7).

### 3.2 Played population

The rows of `build_features(pull_weekly(seasons), pull_schedules(seasons))` for (S, N). Each row is a player who
recorded a REG stat line. Actual points = `fantasy_points(row[PREDICTED_STATS], PPR)`.

- **Pull span:** (A) pulls S−3 through S, which fixes the lag history and the naive fallback means. (B) uses
  `weekly_consensus.main`'s span.
- **Excluded from the estimand:** DNPs and players with no stat line. This matches the original benchmark's
  conditioning.

### 3.3 Team presence and freshness

- **`team_presence_complete`:** every REG (week, team) in the schedule has at least one played row. This is the
  `prospective.freeze.check_fresh` rule applied to one week. It is a minimum freshness check, not proof that the
  data is final.
- **Provisional:** a week whose `Z_N` is less than 8 days before the run's `as_of_date` is `provisional` (§4.6). Every
  run recomputes from scratch, so later stat corrections replace earlier values. Recorded input hashes make each
  revision traceable.

### 3.4 Team-code normalisation for rankings

Ranking team codes are mapped **to schedule codes** before any comparison:

```
{"LAR": "LA", "STL": "LA", "JAC": "JAX", "SD": "LAC", "OAK": "LV", "LVR": "LV", "WSH": "WAS", "ARZ": "ARI",
 "BLT": "BAL", "CLV": "CLE", "HST": "HOU", "KCC": "KC", "GBP": "GB", "NOS": "NO", "NEP": "NE", "SFO": "SF",
 "TBB": "TB"}
```

- Codes that are blank or `FA` are ignored for presence.
- Any other code that, after mapping, is not among the season's schedule teams is counted as `unknown_team_codes`
  and contributes no presence.
- Two tests guard the mapping:
  - **Unit:** every value of the mapping is a schedule code produced by `normalize_schedule_teams`.
  - **Acceptance:** on the real rankings cache, `unknown_team_codes == 0` for every 2020–25 scrape.

### 3.5 Week-identity gate (tri-state)

A **page** is the set of rows with `pos == P` after `normalize_weekly_rankings`, for P ∈ {QB, RB, WR, TE}.

For a scrape assigned to week N, define:

- `R_P` = the set of mapped teams present on page P;
- `A` = the teams on bye in week N;
- `B` = the teams on bye in week N−1 (`B = ∅` for week 1);
- `a = |A ∩ R_P| / |A|` when `A ≠ ∅`, and `b = |B ∩ R_P| / |B|` when `B ≠ ∅`.

Evaluate in this order:

1. **Absent page.** A page with no rows is `absent` and takes no further part. If all four pages are absent, the
   week is `unverified`.
2. **Each present page** is:
   - `contradicted` if `a > 0.5` or `b < 0.5`;
   - else `bye_consistent` if at least one of `a` and `b` is defined and every defined one is strictly current
     (`a < 0.5`, `b > 0.5`);
   - else `unverified` (no byes on either side, or an exact half).
3. **The week**, over its present pages, is:
   - `contradicted` if any page is contradicted;
   - else `bye_consistent` if all pages are bye_consistent;
   - else `unverified`.
4. **Downgrade.** If `unknown_team_codes` exceeds 2% of the scrape's QB/RB/WR/TE rows, or any page is absent, a
   `bye_consistent` week becomes `unverified`. The downgrade never erases `contradicted`.

What this means:

- `bye_consistent` means the bye pattern is compatible with week N. It is not proof of the week: with `A = ∅`,
  another week's page listing the returning teams would also pass.
- Presence is judged per team and per page, so a fresh page cannot mask a stale one. A team's only row can still
  flip its presence.
- The thresholds are fixed now, before any accuracy number is seen.
- Contradicted weeks are always skipped. §6.4 sets how unverified weeks are used.

### 3.6 Coverage reporting

Every artifact reports, per season:

- raw versus accepted ranking rows;
- scrape dates and their weekdays;
- page coverage.

Legacy-schema rows (`page_type == "weekly-offense"`, through 2020-10-12) are dropped by `normalize_weekly_rankings`.
That exclusion is **intentional**, because the original benchmark excluded them. They are reported as
`excluded_legacy_schema`.

### 3.7 Validation

Validation runs per input table, per (season, week), **before** any join.

| Table | Key | Evaluated fields | Eligibility / join fields |
|---|---|---|---|
| actuals (`pull_weekly` rows) | `(season, week, player_id)` | `PREDICTED_STATS` | team, position |
| published projections (§4.1) | `player_id` | `p10, p50, p90` | team, position |
| nflverse consensus rows | `fp_id` | `ecr` | pos, team, mergename |
| archive consensus rows (§4.3) | `player_id` | `ecr` | position, team |
| schedule | `(season, week, team)` | `gameday` | — |

**Rules:**

- **Exact duplicates** have the same key, evaluated fields and eligibility fields. They collapse to one row and are
  counted (`exact_duplicates`); they are not errors.
- **Conflicting duplicates** share a key and differ in any of those fields. Every row of the group is invalid
  (`conflicting_duplicates`). One example is FantasyPros listing a dual-eligible player on two pages with different
  ECR: Demetric Felton, `fp_id` 20105, ECR 113.2 and 163.6 on 2022-12-30.
- **Non-finite values** in evaluated fields only make the row invalid. Lag features may legitimately be NaN.
- **Projection quantiles** must satisfy `p10 ≤ p50 ≤ p90`; otherwise the row is invalid.
- **Schedule joins:** zero or several week-N schedule rows for a player's team makes the row invalid.
- **Masking, not dropping:**
  - Invalid actuals are masked out of scoring for that (season, week) only.
  - They stay in the frame given to `build_features`, so lag features and the model inputs are unchanged from the
    original measurements.
  - A conflicting actuals group stays in the frame as it came from `pull_weekly`.
- **Identity collisions:** after removing invalid consensus rows, call `attach_gsis` unchanged. If it reports
  `gsis_collisions > 0`, the week's consensus is invalid and the week is skipped (`identity_collision`).
  - Measured on 94 real 2020–25 scrapes: once the same-key cross-page duplicates were removed, there were no
    multi-key collisions.

**Threshold:**

- For each table, the excluded fraction = unique keys invalidated for any reason ÷ unique keys before validation.
  Each key is counted once; exact duplicates are not counted; an empty table has fraction 0.
- If any table exceeds 1% for a (season, week), the week is skipped (`validation_failed`). Exactly 1% passes.
- Counts are reported per reason, per table and per position.

The 1% figure is a data-quality tolerance, not a bound on metric error.

### 3.8 Ranking metrics and dependence

**Per week:** `weekly_rankings.score_week(cell, S, N, REPLACEMENT_RANK, min_cell=5)`. Cells are built like
`weekly_consensus.week_cell`, and positions come from our frame. Degenerate cells (non-finite Spearman) are dropped
and counted.

**Verdict inputs** are computed by new, unrounded code in `sameweek.py`:

- the cell-weighted mean delta `D` (ours − consensus);
- `D_season`;
- `D_{−s}` (leave one season out);
- the sensitivity `D`;
- `ci_week`: `mean_head_gate.paired_bootstrap` (seed 20260728, 10,000 resamples) with clusters given as the scalar
  key `season*100 + week`, so all positions of a slate move together.

`weekly_consensus.pooled_stats` rounds to 4 dp. It is used only to report `ci_cell`, the original protocol's
independent-cell interval, which is labelled diagnostic. Rounding happens only for display.

**Limitation, stated in the artifact:** three seasons give three clusters, and within-season serial dependence is not
modelled.

**Start/sit hit rates** are restricted-pool diagnostics. Cells with `n ≤ REPLACEMENT_RANK[pos]` are flagged.

### 3.9 Negative-correlation alarm ((B) only)

In (B), `assert_model_sane` is an alarm:

1. A negative mean model Spearman writes `status: "alarm_negative_correlation"` and no verdict.
2. The sign/identity self-check fixtures are run, and the owner is told.
3. If the audit finds no defect, the result is published as computed with a limited-sample warning.
4. Population and sign are never changed to clear the alarm.

(A) reports a negative weekly correlation as a number, with no alarm and no stop.

## 4. (A) Live weekly accuracy — `live_accuracy.py`

### 4.1 Projection: what the bot pipeline published, proven by push records

**Estimand:** the bot pipeline's latest publication on main before the week's cutoff. Vercel deployment is not
verified, but the site deploys main on push.

**Cutoff:** `K_N` 00:00 UTC. It is common to all players and symmetric with the date-level expert snapshots. The
earliest any Eastern-date `K_N` game starts is 04:00 UTC, so the cutoff precedes every week-N game.

**Candidates:** a commit `C` is a candidate if all three hold:

- `C` changes `site/data/weekly.json` **or** `site/data/neutral/weekly.json`, judged by `git diff --name-only C^1 C`;
- its author and committer are both `weekly-update-bot`;
- it carries a `season == S`, `week == N` payload.

**The push ledger** (`models/diagnostics/main_push_ledger.json`) is collected by every run of the weekly accuracy job:

- **Source:** `GET /repos/{owner}/{repo}/activity?ref=refs/heads/main`, with cursor pagination to the end.
- **Events:** every returned event is merged, with no author filter. Each stores `id`, `ref`, `timestamp`, `before`,
  `after`, `activity_type` and `actor.login`.
- **Integrity:** events are deduplicated by `id`, never deleted or edited, and sorted.
- **Coverage intervals:** each collection appends `[t_start, t_end]`. `t_end` is the collection time. `t_start` is
  the oldest event returned when pagination reached the end of history, otherwise the oldest event seen. Covered
  time is the union of these intervals.
- **Seed:** the first collection is the saved raw response
  `.review/evidence-seed/activity-main-2026-10-06T190201Z.json`: 239 events back to the repository's first event,
  `branch_creation` at 2026-07-11. It contains no `force_push` events.

**Selection, for each week N:**

1. **Publication event.** Find the latest `activity_type == "push"` event on `refs/heads/main` that is strictly
   before the cutoff and whose `after` is a candidate.
   - If several events share an `after`, the earliest is used.
   - Ties on timestamp are ordered by `id`.
   - The selected commit is that `after`, and `available_by` is the event's timestamp.
2. **Coverage.** The interval from that event to the cutoff must be fully covered. Otherwise the week is
   `publication_evidence_unavailable`. An older push is never promoted across an uncovered gap.
3. **Force-pushes.** Any `force_push` on `refs/heads/main` in `[available_by, cutoff)` makes the week
   `publication_evidence_unavailable`.
4. **Missing commit.** If a ledger `after` sha inside the week's `[available_by, cutoff)` window can't be fetched
   locally, the week is `publication_evidence_unavailable`.
5. **No candidate.** If no candidate payload for the week exists in reachable history or the ledger, the week is
   `weeks_unpublished`. Missing evidence is never reported as non-publication.

**Scored values:**

- If the selected commit contains the legacy file, use `players[].points.ppr.{p10,p50,p90}` from
  `site/data/weekly.json`.
- Otherwise use the neutral `stat_quantiles`, scored in PPR by `ffmodel.site.leaguelens.reference_score`. The weights
  are `effective_weights` of the `sleeper_scoring` in `configs/formats/f12-1qb-ppr-4.yaml`, which equal
  `scoring.PPR`.
  - This was verified on batch `2026-10-06T16:11:28Z`: across 1,974 values the maximum difference was 0.005, the
    legacy file's 2-dp rounding.
- If both files exist and come from the same batch (equal `generated_at`, season and week), assert
  `|neutral − legacy| ≤ 0.01` for every player and quantile. A violation skips the week with reason
  `equivalence_failed` and lists the players.

**Expected for 2026:** weeks 1–4 select the following, all before their cutoffs:

| Week | Commit | Push time (UTC) |
|---|---|---|
| 1 | `b451562` | 2026-09-02T09:45:11Z |
| 2 | `fa9c095` | 2026-09-16T20:15:31Z |
| 3 | `fbd66fd` | 2026-09-23T20:33:45Z |
| 4 | `d43adc4` | 2026-09-30T21:32:42Z |

Git and API access each go through one injectable function, so tests can feed a synthetic history.

### 4.2 Point metrics

**Population:** the played population ∩ valid projection rows. Unprojected players are counted, never imputed. Their
count, share and mean actual are reported by week and position.

**Reported per week, per position, and pooled:**

- `n` and MAE of p50;
- mean and median of `actual − p50`, and the share above p50;
- p10–p90 coverage (inclusive), and the shares of player-weeks below p10 and above p90;
- pinball loss at 0.1, 0.5 and 0.9.

**Naive baseline:**

- `NaiveLast4` semantics: lag-4 stat means scored in PPR.
- A NaN falls back to the position mean over feature rows with `season < S`.
- A position missing from the fallback is a validation error.

**Paired MAE delta:** `|actual − p50| − |actual − naive|`, with two intervals:

- clusters = `player_id`;
- clusters = the scalar string `f"{week}|{team}"`.

Both intervals are labelled conditional on the observed weeks.

**Reference values** are computed from `models/backtests/bakeoff.json` at run time: the n-weighted 2023–25 transformer
MAE and naive MAE, and coverage per season. They carry the source path and blob hash, and are labelled **context**:
the historical population and fallback history differ.

### 4.3 Ranking versus expert consensus

**Pool:** played ∩ valid published projection ∩ valid expert row. Retention is reported by week and position.

**Primary: our archived snapshots.** These are `data_snapshots/weekly_ecr/<S>-wNN-*.json` with `season == S` and
`week == N`. `live_experts` infers the week from complete opponent agreement.

- **First commit:** the archive's first-adding commit `C` is found by scanning reachable history for a `C^1..C` diff
  that adds the path. `C` must be a `weekly-update-bot` commit.
- **Evidence:** the earliest ledger event with `activity_type` in {`push`, `pr_merge`} on `refs/heads/main` whose
  `after` has `C` as ancestor-or-self, and whose timestamp is strictly before the cutoff.
  - `available_by` is that event's timestamp.
  - The interval from that event to the cutoff must be covered. Otherwise the archive doesn't qualify.
  - This is a content-existence bound: retrieval may have been earlier. Archives strip `retrieved_at`.
- **Content:** the blob at `C` (`git show C:path`). Its sha256 prefix must equal the filename's 16-hex digest under
  `live_experts`'s naming rule. A mismatch skips the week's primary ranking with reason `archive_hash_mismatch`.
- **Selection:** among qualifying archives, the latest `available_by` wins.
  - Ties go to the lexicographically first filename, flagged `arbitrary_lexicographic`.
  - The other qualifying archives are listed. A sensitivity recomputes the ranking with each, and the range is
    reported.
- **Expected for 2026:** weeks 1–3 have no qualifying archive.
  - Week 3's only archive was added by `c502c55`, pushed 2026-09-24T03:58:50Z, after the 00:00Z cutoff.
  - The cutoff is not moved to rescue it.
  - Week 4 selects `2026-w04-2026-09-30-5aec56b70c3784e6.json` (408 players, pushed 21:32:42Z). Its alternative,
    `…220d00155877a0a7` (325 players), is reported in the sensitivity.

**Secondary: nflverse same-week.** The §5.2 rule is applied to season S and reported separately, labelled by source.
Both sources are FantasyPros mirrors, not independent panels.

### 4.4 (Removed in draft 6)

The live snapshot-change diagnostic is cut. It had one week of data. The historical diagnostic is §5.3.

### 4.5 Frozen reproduction (one-time acceptance)

- **Command:** `--weeks 1-4 --frozen-record models/diagnostics/live_2026_w1-4_reproduction.json`.
- **Contents:** every input identity: publication shas and their ledger events, archive filenames and hashes,
  schedule/actuals/crosswalk content hashes, the `evaluator_version`, and joined ID counts.
- **Commit:** it is committed with the first live artifact (§8 step 4), not with the code merge.

**Expected relationship to the scratch measurement:**

- Point metrics should match: MAE 4.359, coverage 0.797, naive MAE 4.673, delta −0.313.
- The primary ranking is expected to **differ**:
  - week 3 drops out, because its archive was pushed after the cutoff (§4.3);
  - week 4 uses the `…5aec…` archive, not the scratch tie-break's `…220d…`.
- Every divergence gets row-level accounting. Matching the scratch never overrides a selection rule.

### 4.6 Output

**`models/diagnostics/live_<S>_weekly.json`**, where `S = current_nfl_season()`:

- `protocol_version`;
- `evaluator_version`: `protocol_version` plus the git tree id of `src/ffmodel` at the pinned sha
  (`git rev-parse <sha>:src/ffmodel`);
- `inputs` with hashes;
- `weeks_scored`, and `weeks_skipped` with reasons;
- per week: the `publication` evidence (commit, ledger event id, `available_by`) and the `expert_snapshot` evidence;
- `points`, `ranking.primary`, `ranking.secondary`;
- `reference_context`;
- `caveats`;
- a `run` block: `run_at`, `as_of_date`, the pinned main sha, and `provisional_weeks`.

With zero complete weeks, it writes an artifact with `weeks_scored: []` and exits 0.

**`live_<S>_weekly.md`:**

- a cumulative headline line;
- a "Provisional: weeks …" line;
- a per-week table: week, `Z_N`, n, MAE, naive MAE, coverage, below/above, and ours vs consensus Spearman (or "—");
- the caveats.

**CLI:** `python -m ffmodel.eval.live_accuracy`. It writes `models/diagnostics/live_<S>_weekly.{json,md}` and updates
the ledger. Data goes into a fresh temporary cache unless `--data-dir` is given.

**Error policy:**

- **Data-content defects** skip the affected week with a reason: `equivalence_failed`, `archive_hash_mismatch`,
  `validation_failed`, `identity_collision`, `publication_evidence_unavailable`.
- **Infrastructure errors** fail the job: API or pagination failure, data-pull failure, schema error. Nothing is
  committed when the job fails.

### 4.7 Workflow — `.github/workflows/weekly-accuracy.yml`

- **Triggers:** `schedule` `47 16 * 9-12,1 2` (Tue) and `47 13 * 9-12,1 3` (Wed), plus `workflow_dispatch`.
  - Scheduled runs start late in practice; `weekly-update` has started 4–6 h late.
  - The Wednesday run is a second run, not a retry. It usually commits too, because the ledger grows.
- **Concurrency:** `group: weekly-site-refresh`, `cancel-in-progress: false`, shared with `weekly-update.yml`.
- **Setup:** checkout with `fetch-depth: 0`; Python 3.12; `pip install -e .`.
- **Git identity:** `user.name` is `weekly-accuracy-bot`. That name is distinct from `weekly-update-bot`, so its
  commits can never become §4.1 candidates.
- **Steps:**
  1. Run the CLI.
  2. Stage only `models/diagnostics/live_*_weekly.json`, `live_*_weekly.md` and `main_push_ledger.json`.
  3. If nothing changed, exit 0.
  4. Commit `data: weekly accuracy refresh` and push, with up to 3 attempts of `git pull --rebase` then push. Never
     force.
- **Fail-safe:** an infrastructure error stops the job before the commit. The job never writes `site/`.
- **Permissions:** `contents: write`, which covers the activity API read. `GH_TOKEN: ${{ github.token }}` is set for
  `gh api`.

## 5. (B) Same-week reanalysis

### 5.1 Samples and models

| Sample | Seasons | Model | Old-protocol artifact |
|---|---|---|---|
| Discovery | 2023–2025 | ensemble `{v1, v1_s43, v1_s44}/through{S−1}` (`weekly_consensus.transformer_predictor`) | `weekly_consensus.json` |
| Replication | 2020–2022 | the same ensemble; folds through2019–2021 (`rb_oos_weekly.json.artifacts_evaluated`) | `rb_oos_weekly.json` |

Splits come from `walk_forward_splits`. The model side is unchanged from the original measurements (§3.7 masks
rather than drops).

### 5.2 Same-week scrape and population

For week N of season S:

- **Overlap guard:** if `Z_{N−1} ≥ K_N`, week N is skipped as `overlapping_weeks`. There are none in 2020–25.
- **Window:** `L_N ≤ scrape_date < Z_N`, where `L_N = Z_{N−1} + 1 day` (`L_1 = K_1 − 7 days`). The window is finite,
  stays inside the season, and admits a pre-first-game scrape in a Saturday- or Sunday-first week.
- **Selection uses metadata only.**
  - **Candidates:** scrape dates in the window whose §3.5 state is not `contradicted` and that have at least one
    week-N game strictly after the scrape date.
  - **Choice:** the latest candidate.
  - **No outcome checks:** actual appearances are never consulted, and there is no fallback.
  - **Unusable choice:** if the chosen scrape yields no scorable cell, or fails §3.7, the week is skipped
    (`no_scorable_cell` or `validation_failed`).
  - **Record:** every candidate is recorded.
- **Population:** played rows of week N whose game date is **strictly after** the scrape date.
- **Pool:** date-eligible played rows ∩ model predictions ∩ matched consensus (§3.7). The model predicts every
  feature row.
- **Retention:** reported by season, week, position and game day, including excluded early-game players and the
  match rate.

**Estimand, stated in the artifact:** within-position ranking of players who recorded a stat line, were matched, and
had not yet played at the scrape date.

- Our cutoff is the end of week N−1; the experts' is the scrape date, which can include that week's earlier games
  and practice reports.
- The net selection effect of excluding early games is **undetermined**, and no direction is claimed.
- Old and new numbers are different estimands.

Postponed games use their actual `gameday`.

### 5.3 Snapshot-change diagnostic (historical)

This is a conditional diagnostic, not a causal decomposition. For each (season, week) that has both an old-protocol
scrape (`weekly_snapshot`) and a selected same-week scrape:

1. Intersect the two matched rankings with the date-eligible played rows and the model predictions.
2. Score both expert lists and the identical model predictions on exactly those IDs.
3. Apply the same cell rule to both arms: at least 5 players and finite Spearman in both, otherwise the cell is
   dropped from both.
4. Record the overlap losses.

## 6. (B) Pre-registered analysis and decision rules

Everything in this section is fixed before any (B) number is computed.

### 6.1 Units and weeks

- **Cell:** a (season, week, position) with at least 5 pool players and a finite Spearman for both entrants.
- **Week 1** is included under the same policy as every other week. Its gate state is at most `unverified`, because
  week 1 has no prior-week byes. The old benchmark had no week-1 cells because its window found no scrape, not
  because of model inputs (`build_sequences(min_history=0)`).
- **Target weeks:** all REG weeks of a season, from the schedule. They are the sufficiency denominator.

### 6.2 Sufficiency (per sample, checked first)

- **Rule 1:** in every season, at least half of the target weeks have at least one primary-analysis cell.
- **Rule 2:** in every season, at least half of the target weeks have a primary-analysis RB cell.

`insufficient` takes precedence over every other outcome.

### 6.3 Statistics

All in full precision (§3.8):

- `D` and `ci_week`;
- `D_season` per season;
- the leave-one-season-out deltas `D_{−s}`;
- the **bye-consistent-only sensitivity**: `D` on `bye_consistent` weeks only, with cell and season counts.

### 6.4 Unverified weeks

- **Primary analysis:** `bye_consistent` plus `unverified` weeks. Unverified weeks are labelled `inferred_by_window`.
- **Sensitivity:** `bye_consistent` weeks only, reported beside every verdict with its coverage.
- `contradicted` weeks are always skipped.

### 6.5 Rules

A **directional check** for sign σ ∈ {+, −} passes only if every row below holds. Every failing code is recorded.

| # | Requirement (strict throughout; 0 is on neither side) | Codes |
|---|---|---|
| (a) | `ci_week` lies strictly on the σ side of 0 | `interval_includes_zero` (`lo ≤ 0 ≤ hi`), else `interval_opposite_side` |
| (b) | at least 2 of the 3 `D_season` are strictly on the σ side | `season_inconsistent` |
| (c) | every `D_{−s}` is strictly on the σ side | `leave_one_season_out_reversal`, or `leave_one_season_out_zero` |
| (d) | the sensitivity has ≥ 1 cell and its `D` is strictly on the σ side | `sensitivity_absent`, `sensitivity_disagrees`, or `sensitivity_zero` |

The check is sign-symmetric. Astra confirmed in round 3 that it is conservative but reachable. For example, three
seasons of cell deltas in `[+0.02, +0.06]` with a positive sensitivity give `ahead`.

**Rule 1, overall (Discovery sample).** Evaluate in order:

1. If insufficient: `insufficient`.
2. If the check for − passes: `behind`.
3. If the check for + passes: `ahead`.
4. Otherwise: `not_established`, with the codes of the check whose sign matches `D`. If `D == 0`, the reason is
   `zero_estimate` and both checks' codes are reported.

There is no `tie` outcome, and parity is not claimed. The Replication sample's overall result is reported
descriptively under the same rule.

**Rule 2, running-back edge** (a new rule, stricter than the original):

- If either sample is insufficient for Rule 2: `insufficient`.
- If the + check on RB cells passes in **both** samples: `established`. Requirement (b) carries the original
  pre-registered season criterion (`rb_oos_weekly.json.pre_registered_rule`).
- Otherwise: `not_established`, with codes per sample. A failure is not evidence of an RB disadvantage.

**Rule 3:** QB, WR and TE are reported as numbers only.

**Multiplicity:** Rules 1 and 2 are two separate pre-specified claims, each at 95%. No family-wise correction is
applied, and the artifact says so.

**Rule 4:** results are reported as computed.

- If a defect is found after the run, fix it, re-run, and publish both results with the reason.
- No parameter in §3, §5 or §6 changes in response to a result.

**Scope:** a passing verdict is bounded to week-resampling on these three seasons, and the public wording says so
(§6.7).

### 6.6 Output — `models/diagnostics/weekly_consensus_sameweek.json`

The verdicts and reason codes are computed in code, with no hand step. The artifact contains:

- `protocol_version`, `evaluator_version` (§4.6), and `protocol` (§§3, 5, 6 quoted);
- `inputs` with hashes: rankings cache, schedules, weekly actuals, crosswalk, model folds;
- for each sample:
  - overall, per_position and per_season results;
  - the leave-one-season-out results;
  - the sensitivity, with coverage;
  - per-week provenance: candidates, selected scrape, per-page gate states, pool sizes, exclusions and skips;
- `coverage` (§3.6) and the validation counts (§3.7);
- the §5.3 diagnostic;
- the old-protocol numbers read from the two old artifacts, labelled `different_estimand`;
- `old_protocol_staleness_audit`:
  - for every 2020–25 week, the old protocol's scrape and its §3.5 state;
  - the counts;
  - the exact list of discriminating weeks (`A` and `B` both non-empty and different);
- `verdicts: {rule_1: {value, reasons}, rule_2: {value, reasons_by_sample}}`.

### 6.7 Copy follow-through (owner approves before push)

Every wording below is bounded to: players who played; within position; FantasyPros consensus; these seasons.

| Verdict | Wording |
|---|---|
| `rule_1 = not_established` | "Against same-week expert rankings our estimate is D (95% CI …). A directional claim is not established under the pre-specified checks because <codes in words>." |
| `rule_1 = behind` / `ahead` | "Behind" / "ahead of" same-week expert consensus: D (95% CI …), in at least 2 of 3 seasons and in every leave-one-season-out estimate, 2023–25 only. Week-resampling is conditional on these seasons, and within-season serial dependence is not modelled. |
| `rule_1 = insufficient` | "Not established: too little same-week data." |
| `rule_2 = established` | The RB edge is restated with both samples' numbers and the same qualification. |
| `rule_2 = not_established` / `insufficient` | The RB edge is retracted, with the reasons in words. |

**Files:**

- `site/about.html`: the correction block and the section;
- the `site/weekly.html` footer;
- `docs/methodology.md` §3 and §6.

The original text stays visible as the record. Two corrections ride along:

- c38e175's phrase "made before that week's games" becomes "before that week's Sunday games".
- `methodology.md`'s "13 discriminating weeks" becomes the `old_protocol_staleness_audit` count and its definition.

## 7. Testing

All fixtures are synthetic, and numeric assertions are hand-computed.

### 7.1 `sameweek.py`

- **Team mapping:**
  - every mapped value is a `normalize_schedule_teams` code;
  - `LAR` maps to `LA`;
  - an unknown code is counted and contributes no presence.
- **Window:**
  - the `L_N` and `Z_N` bounds, including `L_1 = K_1 − 7`;
  - the final week stays bounded, with no next-season or postseason scrape;
  - a Saturday-first week admits the preceding Friday;
  - `overlapping_weeks`.
- **Selection:**
  - the latest non-contradicted candidate that has a later game wins;
  - a contradicted latest scrape is passed over using metadata only;
  - an empty or all-degenerate pool gives `no_scorable_cell`, with no fallback;
  - every candidate is recorded.
- **Population filter:**
  - a Thursday game is excluded;
  - a Saturday game is excluded with a Saturday scrape and kept with a Friday scrape;
  - postponed-game dates are honoured.
- **Gate:**
  - stale on both counts → `contradicted`;
  - stale `a` with `B = ∅` → `contradicted`;
  - current on both counts → `bye_consistent`;
  - an exact half → `unverified`;
  - no byes → `unverified`;
  - an RB page stale and a WR page fresh → `contradicted`;
  - a single mis-teamed row with one bye team → `contradicted` (documented strictness);
  - a stale page plus >2% unknown codes → still `contradicted`;
  - `bye_consistent` plus >2% unknown codes → `unverified`;
  - an absent page with `B ≠ ∅` → `unverified`;
  - all pages absent → `unverified`;
  - another week's page with the same bye signature (`A = ∅`) → `bye_consistent` (documents non-proof).
- **Regression record:** on the same data, `weekly_rankings.weekly_snapshot` picks the week-(N−1) scrape, and the
  staleness audit lists it as `contradicted`.
- **Validation:**
  - exact duplicates collapse;
  - a dual-page same-key duplicate with different ECR → the whole group is invalid;
  - non-finite values in evaluated fields only;
  - inverted quantiles;
  - zero or duplicate schedule joins;
  - `gsis_collisions > 0` → `identity_collision`;
  - exactly 1% passes, and just above it gives `validation_failed`;
  - a key that fails several rules is counted once;
  - an invalid actual is masked from scoring while staying in the `build_features` input.
- **Cluster keys:** `season*100 + week` and `f"{week}|{team}"` are 1-D scalars that `paired_bootstrap` accepts.

### 7.2 Statistics and rules

- `ci_week` resamples whole weeks, so all positions of a week move together.
- The leave-one-season-out values.
- **Rule 1 branches and codes:**
  - `D = −0.04`, CI `[−0.10, +0.02]` → `interval_includes_zero`, never a tie;
  - a touching interval `[0, b]` → `interval_includes_zero`;
  - one season win → `season_inconsistent`;
  - astra's construction (`+0.120, −0.010, +0.001`) → `leave_one_season_out_reversal`;
  - a zero leave-one-season-out value → `leave_one_season_out_zero`;
  - `sensitivity_absent`, `sensitivity_disagrees` and `sensitivity_zero`;
  - `D == 0` → `zero_estimate`;
  - the reachability example → `ahead`, and its reflection → `behind`.
- **Rule 2:** each requirement failing in turn in each sample; RB CI wholly below 0 → `interval_opposite_side`;
  each sample insufficient.
- **Sufficiency:** counted per season and position. An RB-poor sample is sufficient for Rule 1 but not Rule 2. Week 1
  is in the denominator and is scored when a valid scrape exists.
- **Full precision:** a lower bound of `+0.00003` passes (a), exercised through the real verdict path.
- **Alarm ((B) only):** `alarm_negative_correlation` with no verdict.
- **Diagnostics:** the `n ≤ slots` flag; the §5.3 diagnostic scores both arms on identical IDs.

### 7.3 `live_accuracy.py`

- **Publication evidence:**
  - a covered `push` with `after == C` before the cutoff is selected;
  - a push after the cutoff is not selected;
  - several events for one sha: the earliest is used; ties are broken by `id`;
  - a newer publication push inside a coverage gap makes the week unavailable, and the older push is not promoted;
  - a `force_push` in `[available_by, cutoff)` makes the week unavailable;
  - a ledger sha in the window that can't be fetched makes the week unavailable;
  - astra's commit-before / push-after case: an older publication is selected;
  - astra's sibling case: `F` is never selected;
  - `publication_evidence_unavailable` is distinct from `weeks_unpublished`.
- **Candidates:**
  - a hand-made commit is rejected;
  - a commit by `weekly-accuracy-bot` is rejected;
  - a commit changing only the neutral `weekly.json` is a candidate;
  - a commit changing neither weekly file is not.
- **Scored values:**
  - legacy `points.ppr` is used when present;
  - neutral re-scoring is used otherwise;
  - when both exist, equivalence passes within 0.01, and a divergence gives `equivalence_failed` for that week only.
- **Archives:**
  - the evidence event is found via `push`/`pr_merge` with ancestor-or-self;
  - an archive pushed after the cutoff is excluded (the week-3 shape);
  - a tie gives `arbitrary_lexicographic`;
  - the sensitivity uses only qualifying archives;
  - a hash mismatch gives `archive_hash_mismatch` for that week only;
  - content is read from `C`, not from the working tree.
- **Points:**
  - hand-computed metrics;
  - the naive fallback, and a missing-position fallback raises;
  - lags strictly shifted, so no future actual reaches a naive value;
  - both cluster intervals.
- **Ranking pool:**
  - the three-way intersection;
  - a week with no RB coverage;
  - empty and all-degenerate cells.
- **Ledger:**
  - merges by `id` and never deletes;
  - forms the union of coverage intervals;
  - stores `actor.login` only;
  - loads the seed as its first collection.
- **Output:**
  - identical inputs and an identical `run` block give byte-identical output;
  - zero complete weeks → `weeks_scored: []`, exit 0;
  - the output path is derived from `current_nfl_season()`;
  - the summary renders with its provisional line.
- **Presence:** a week missing a team's rows is skipped.

### 7.4 Acceptance

- `pytest -W error` and every `tests/*_fixture.cjs` pass, locally and in CI.
- Data checks on the real caches:
  - `unknown_team_codes == 0` for every 2020–25 scrape;
  - the §4.1 weeks 1–4 selections match the table.
- The frozen reproduction record (§4.5) is produced. Every divergence from the scratch measurement is accounted for
  at row level.

## 8. Rollout

1. **Review:** astra reviews draft 6 and the plan on 2026-10-09, after 15:33.
2. **Build:** subagent-driven. Sonnet implements and does task reviews, Opus reviews the numerics and leak-surface
   tasks, and Opus does the final review.
3. **Merge:** code, workflow, tests and the ledger seed. No site data, no frozen paths. The owner OKs the push.
4. **First live run:** dispatch `weekly-accuracy.yml` by hand. Check its artifact, then commit the frozen
   reproduction record with the row-level divergence notes.
5. **Reanalysis:** run (B) locally once, commit its artifact, and report the verdicts and full numbers to the owner.
6. **Copy:** apply §6.7, with the owner's OK before the push.

## 9. Risks and limits (stated, not solved)

- Vercel deployment is not verified; the evidence covers main state only.
- `available_by` for archives bounds when the content existed on main, not when it was retrieved.
- `bye_consistent` means compatibility with week N, not proof of identity. `unverified` weeks rest on the window
  assumption.
- Each sample has three seasons, and within-season serial dependence is not modelled.
- Both expert sources mirror FantasyPros.
- The historical data vintage is today's nflverse cache. It is hashed, but it is not the vintage that existed
  in-season.
- (B) is a correction of data already examined, not an untouched replication.

## 10. Review trace

**Astra rounds 1–4:** each finding and its resolution are traced in this file's git history (drafts 2–5, commits
82725c4, 9dc7a55, 135a123, 4f78fe9). The accepted core:

- the tri-state gate;
- metadata-only selection;
- the directional check (a)–(d) with leave-one-season-out;
- no tie outcome;
- per-season and per-position sufficiency;
- exact push evidence.

**Opus adversarial review of draft 5:**

| Finding | Resolution |
|---|---|
| C1 Rams mapped the wrong way | §3.4 maps ranking codes to schedule codes (`LAR` → `LA`); unit and acceptance tests |
| C2 reconciliation fails on dual-page duplicates | Cut X2. §3.7 makes same-key conflicting duplicates invalid, and `gsis_collisions > 0` skips the week. The Felton example is cited |
| I1 week 3 archive pushed after cutoff | §4.3 and §4.5 expectations corrected; the cutoff is not moved |
| I2 tied to the legacy file | §4.1: candidates may change either file; scored-value rule; same-batch definition |
| I3 permanent outages | §4.6 error policy: data defects skip the week, infrastructure errors fail the job; the alarm is (B) only |
| I4 retrospective tier contradictions | Cut X1: tier and inventory removed |
| I5 `run.json` discarded | Cut X3: a `run` block inside the committed artifact; a provisional line in the summary |
| M1 force-push claim | §4.1 seed: no `force_push` events |
| M2 wording | §1 "player-weeks" |
| M3 cluster keys | §3.8, §4.2 scalar keys; §7.1 test |
| M4 rounding | §3.8 new unrounded verdict code; `pooled_stats` only for `ci_cell` |
| M5 page | §3.5 defined by `pos` |
| M6 archive key | §3.7 table row |
| M7 activity types | §4.1 `push` for publications; §4.3 `push` / `pr_merge` for archives |
| M8 unfetchable sha | §4.1 step 4 window |
| M9 strictness | §6.5 strict throughout; zero codes |
| M10 workflow | §4.7 git identity, derived path, zero weeks, delays, permissions |
| M11 ledger size | `actor.login` |
| M12 masking | §3.7 masking |
| M13 `evaluator_version` | §4.6 tree id |
| M14 frozen record timing | §4.5, §8 step 4 |
| M15 header | Status block |
| X4, X5 | Force-push fixtures reduced to one rule; live diagnostic removed (§4.4) |
