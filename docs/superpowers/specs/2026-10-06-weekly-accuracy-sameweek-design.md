# Weekly accuracy tracking and same-week expert benchmark — design

**Status:** draft 7.1 (2026-10-07; astra S7-I1–I5 fixes, and four wording clarifications from plan revision b880f9e: schedule game identity, alarm fixture selection, manifest hash and path, Holm p-value). The owner approved the design section by section in conversation, and on
2026-10-07 approved three additions: a Sleeper comparator kept private until checked, a private data repository for
third-party snapshots, and a slimmer scope ("smallest trustworthy report").

Review history:

- Astra reviewed drafts 1–4 and returned REVISE each time (`.review/astra-weeklyacc-spec-response.md`, `-r2-`,
  `-r3-`, `-r4-response.md`).
- An adversarial Opus review of draft 5 (`.review/opus-weeklyacc-spec-review.md`) returned REVISE; draft 6 was a clean
  rewrite.
- Astra reviewed draft 6 and the plan on 2026-10-07 (`.review/astra-weeklyacc-spec6-plan-response.md`): REVISE, with
  one spec finding (S6-I1) and seven plan findings (P1–P7). Draft 7 resolves them; §10 is the trace.
- Astra's roadmap consult of the same day (`.review/astra-roadmap-consult-response.md`) shaped §4.8 and the cuts.

## 1. Why

**Live point accuracy has never been tracked.** The projections published before 2026 kickoffs score as follows on
weeks 1–4 (scratch measurement, reproduced independently by astra: MAE 4.3592, coverage 0.7966):

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

**Sleeper is the comparison users actually have.** A retrospective look at weeks 1–4 (`.review/sleeper-vs-ours-2026-wk1-4.json`)
found Sleeper's projections (Rotowire) with lower observed error than ours, and a fixed 50/50 blend lower than
either. Every Sleeper record for those weeks was rewritten the Tuesday after the week, so their pre-kickoff values are
unverified. Those weeks are **exploratory only**. A trustworthy comparison needs our own snapshots, taken at our
publication time (§4.8).

**This project:**

- **(A)** an automated weekly scorecard of the projections the bot pipeline published, plus a private Sleeper
  comparator (§4.8);
- **(B)** a pre-registered reanalysis of both historical samples against same-week rankings. It reanalyses data that
  has already been examined, so it is not a new, untouched replication.

**Design principle (owner, 2026-10-07):** the smallest trustworthy report. Diagnostics, sensitivities and
presentation are cut before any provenance, validation or fail-safe check is cut.

## 2. Scope

**New:**

- `src/ffmodel/eval/sameweek.py`: shared primitives.
- `src/ffmodel/eval/live_accuracy.py`: (A).
- `src/ffmodel/eval/sleeper_compare.py`: the §4.8 comparator.
- `src/ffmodel/eval/weekly_consensus_sameweek.py`: the (B) driver.
- `.github/workflows/weekly-accuracy.yml`.
- Tests.
- Committed artifacts (public repo):
  - `models/diagnostics/live_<S>_weekly.json` and `.md`;
  - `models/diagnostics/main_push_ledger.json`;
  - `models/diagnostics/live_2026_w1-4_reproduction.json`;
  - after (B): `models/diagnostics/weekly_consensus_sameweek.json`.
- Private-repo artifacts (never in the public repo): the §4.8 report.
- After (B), the §6.7 copy changes, pushed only with the owner's OK.

**Unchanged:**

- the model;
- published site data and `weekly-update.yml`;
- the frozen prospective paths (`models/prospective/**`, `prospective-*.yml`);
- `weekly_rankings.py`, `weekly_consensus.py`, `data/rankings.py`, `data/pull.py` and their artifacts.

New code may import them but does not edit them. The site scorecard UI is phase 2 (after about 8 live weeks) and
will read the (A) artifact.

**Separate, consumed here:** the market-snapshot collector (`market-snapshots.yml`) that writes Sleeper and
game-line snapshots to the private repository. It is a separate bounded change; this spec fixes only the manifest
contract it must satisfy (§4.8.1).

**Repo rules:** the repo is public, so test fixtures are synthetic. No third-party projection or odds data, raw or
row-level, is committed to it (design spec §11 amendment, 2026-10-07).

## 3. Shared definitions (`sameweek.py`)

### 3.1 Schedule dates

For REG week N of season S, from the **validated** schedule (§3.7; team codes normalised by
`normalize_schedule_teams`, so the Rams are `LA`):

- `K_N` = the earliest `gameday` of week N, the first-kickoff date. This equals `weekly_consensus.weekly_kickoffs`.
- `Z_N` = the latest `gameday` of week N.

A player's **game date** is the `gameday` of the unique validated `(season, week, team)` schedule row for the
player's `team`. Zero matches is a validation error for that actuals row (§3.7).

### 3.2 Played population

The rows of `build_features(actuals_raw, schedule_raw)` for (S, N), where both inputs have first passed the raw-table
step of §3.7 (exact duplicates collapsed). Each row is a player who recorded a REG stat line. Actual points =
`fantasy_points(row[PREDICTED_STATS], PPR)`.

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
  - **Acceptance:** on the real rankings cache, `unknown_team_codes == 0` for every 2020–25 scrape (confirmed by
    astra on 94 scrapes, 2026-10-07).

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

Every artifact reports, per season: raw versus accepted ranking rows, and scrape dates with their weekdays.

Legacy-schema rows (`page_type == "weekly-offense"`, through 2020-10-12) are dropped by `normalize_weekly_rankings`.
That exclusion is **intentional**, because the original benchmark excluded them. They are reported as
`excluded_legacy_schema`.

(Cut in draft 7: per-page coverage tables.)

### 3.7 Validation

Validation is a **two-stage** process. Stage 1 runs on raw tables before anything is built from them; stage 2 runs
per (season, week) before any join.

| Table | Key | Evaluated fields | Eligibility / join fields |
|---|---|---|---|
| actuals (`pull_weekly` rows) | `(season, week, player_id)` | `PREDICTED_STATS` | team, position |
| schedule (exploded to one row per team side) | `(season, week, team)` | `gameday`, `opponent` (and `game_id` when the schedule carries one; `pull_schedules` does not) | — |
| published projections (§4.1) | `player_id` | `p10, p50, p90` (and, for neutral payloads, every stat quantile) | team, position |
| nflverse consensus rows | `fp_id` | `ecr` | pos, team, mergename |
| archive consensus rows (§4.3) | `player_id` | `ecr` | position, team |
| Sleeper projections (§4.8) | `sleeper_id` | mapped stat components | position |

**Stage 1 — raw tables (actuals and schedule), before `build_features`:**

- **Order:** conflicting keys are identified **first**, over the raw multiset of rows.
- **Exact duplicates** in stage 1 are rows identical in **every column** of the raw table (not just the key,
  evaluated and eligibility fields: other columns such as `target_share`, `snap_pct` or the schedule's `roof` also
  reach `build_features`). Rows sharing a key that differ in any column are conflicting (next bullet). Exact
  duplicates collapse to one row and are counted (`exact_duplicates`), **only within keys that are not
  conflicting**. Collapsing happens *before* features are
  built, so a harmless duplicate cannot distort lag features (astra P3: a duplicated week-2 row changed a week-3
  `lag4_carries` from 15.0 to 16.67). A conflicting key keeps its entire original multiset, including any rows
  that repeat each other (astra S7-I2: rows 20, 20, 25 stay three rows, giving 18.75, not 18.33).
- **Schedule:** the schedule is exploded to `(season, week, team)` sides and validated as its own table. Exact
  duplicate games collapse without error and are counted per week; the count is carried into the artifact.
  Conflicting duplicates (same side, different `gameday`, `opponent`, home/away role, `game_id`, or any other
  column of the raw game row) invalidate that side; a game listed twice with home and away swapped is therefore
  conflicting, never collapsed and never doubled silently. A side's game is identified by `gameday`, `opponent`
  and its home/away role (plus `game_id` when present).
- **Schedule dependencies:** `K_N` and `Z_N` are defined only when week N's schedule slice passes the threshold. A
  computation that uses another week's dates needs that week's slice to pass too: the §5.2 window and overlap guard
  for week N need weeks N−1 and N. If a needed slice fails, the computation is skipped with `validation_failed`
  (detail `schedule_dependency_failed`), never computed from the surviving games, and the week-1 fallback
  `L_1 = K_1 − 7 days` is never used for N > 1 (astra S7-I3). The same detail is used whether the failing slice is
  week N's own or week N−1's. Which weeks are *due* may be listed from the raw schedule's first game date; that
  listing is never used as a cutoff.
- **Conflicting schedule sides stay in the `build_features` input as pulled**, like conflicting actuals: the
  original measurements were built from the same raw schedule, so (B)'s model inputs stay identical to them. The
  affected week fails the schedule threshold, so it is never scored, but its duplicated join can still feed later
  lag features. That is accepted and disclosed: the real 2012–25 schedules contain no conflicting sides (no
  dependency skips on the full (B) path, 2026-10-07), and any future occurrence appears in the validation counts.
- **Conflicting actuals duplicates** (same key, any field different) are **not** dropped: the group stays in the
  `build_features` input exactly as it came from `pull_weekly`, so the model inputs match the original measurements.
  Their keys are recorded in an **invalid-key mask** carried forward to stage 2.
- Non-finite evaluated fields in actuals are recorded in the same mask; the row also stays in the feature input. Lag
  features may legitimately be NaN.

**Stage 2 — per (season, week), before joins:**

- Exact duplicates collapse; conflicting duplicates invalidate the whole group. One real example is FantasyPros
  listing a dual-eligible player on two pages with different ECR: Demetric Felton, `fp_id` 20105, ECR 113.2 and 163.6
  on 2022-12-30.
- **Non-finite values** in evaluated fields make the row invalid.
- **Projection quantiles** must satisfy `p10 ≤ p50 ≤ p90`; otherwise the row is invalid.
- **Schedule joins:** an actuals row whose team has no valid schedule side for the week is invalid.
- **Masking:** invalid actuals (from either stage) are masked out of scoring for that (season, week) only.
- **Identity collisions:** after removing invalid consensus rows, call `attach_gsis` unchanged. If it reports
  `gsis_collisions > 0`, the week's consensus is invalid and the week is skipped (`identity_collision`). Measured on
  94 real 2020–25 scrapes: once the same-key cross-page duplicates were removed, there were no multi-key collisions.

**Threshold:**

- For each table, the excluded fraction = unique keys invalidated for any reason ÷ unique keys before validation.
  Each key is counted once; exact duplicates are not counted; an empty table has fraction 0.
- If any table **used by a computation** exceeds 1% for a (season, week), that computation is skipped with
  `validation_failed`. Exactly 1% passes. The rule applies identically on every path: the primary and secondary
  rankings, the staleness audit's ranking reads, and §4.8. A failed table is never replaced by an older source, and
  a computation never runs on the surviving subset of a failed table.
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

Rounding happens only for display. (Cut in draft 7: the diagnostic independent-cell interval `ci_cell`, and with it
every use of `weekly_consensus.pooled_stats`.)

**Limitation, stated in the artifact:** three seasons give three clusters, and within-season serial dependence is not
modelled.

**Start/sit hit rates** are restricted-pool diagnostics. Cells with `n ≤ REPLACEMENT_RANK[pos]` are flagged.

### 3.9 Negative-correlation alarm ((B) only)

In (B), `assert_model_sane` is an alarm:

1. A negative mean model Spearman writes `status: "alarm_negative_correlation"` and no verdict, and the run exits 0.
2. **Audit procedure**, run by the operator and recorded in the artifact's `alarm_audit` block:
   1. run the sign and identity fixtures (the driver's `AUDIT_FIXTURES` pytest selection over the gate, validation
      and selection test files) and record the command and result;
   2. for three cells chosen by fixed rule (the first cell in (season, week, position) order of each season),
      recompute both Spearman values by hand from the raw inputs and record them beside the driver's values;
   3. record the conclusion: `defect_found` (fix, re-run, and publish both results with the reason, Rule 4) or
      `no_defect`.
3. If the audit records `no_defect`, the driver is re-run with `--alarm-audited <path>`, which publishes the result
   as computed with a limited-sample warning.
4. Population and sign are never changed to clear the alarm.

(A) reports a negative weekly correlation as a number, with no alarm and no stop.

## 4. (A) Live weekly accuracy — `live_accuracy.py`

### 4.1 Projection: what the bot pipeline published, proven by push records

**Estimand:** the bot pipeline's latest publication on main before the week's cutoff. Vercel deployment is not
verified, but the site deploys main on push.

**Cutoff:** `K_N` 00:00 UTC. It is common to all players and symmetric with the date-level expert snapshots. The
earliest any Eastern-date `K_N` game starts is 04:00 UTC, so the cutoff precedes every week-N game.

**Candidates.** A commit `C` is a candidate if all three hold:

- `C` changes `site/data/weekly.json` **or** `site/data/neutral/weekly.json`, judged by `git diff --name-only C^1 C`;
- its author and committer are both `weekly-update-bot`;
- it carries a `season == S`, `week == N` payload.

Candidates are **enumerated** from two sources: every commit reachable from the pinned main sha, and every commit
reachable from any ledger event `after` of any activity type (full ancestry). A ledger target that cannot be fetched
locally is recorded as `unfetchable`. The walk is **never pruned by commit or author timestamps**: those are
creation times, not publication times, they can be set arbitrarily, and they need not decrease along ancestry
(astra S7-I1: a commit dated in May and pushed in September is a valid candidate). The only permitted stopping
point is a commit already visited.

**The push ledger** (`models/diagnostics/main_push_ledger.json`) is collected by every run of the weekly accuracy job:

- **Source:** `GET /repos/{owner}/{repo}/activity?ref=refs/heads/main&per_page=100`, fetched with
  `gh api --paginate --slurp`. The output is one outer JSON array of pages; the events are the concatenation of the
  pages (astra P1: plain `--paginate` emits one JSON document per page). A fetch that fails, or whose pages are not
  all arrays, is an infrastructure error (§4.6).
- **Events:** every returned event is merged, with no author filter. Each stores `id`, `ref`, `timestamp`, `before`,
  `after`, `activity_type` and `actor.login`.
- **Integrity:** events are deduplicated by `id`, never deleted or edited, and sorted.
- **Coverage intervals:** each collection appends `[t_start, t_end]`. `t_end` is the collection time. `t_start` is
  the oldest event seen. If pagination reached the end of history **and** the oldest event is the
  `branch_creation` of `refs/heads/main`, `t_start` is recorded as `"-inf"`: nothing can have happened on main before
  the branch existed. Covered time is the union of the intervals.
- **Seed:** the first collection is the saved raw response
  `.review/evidence-seed/activity-main-2026-10-06T190201Z.json`: 239 events (235 `push`, 3 `pr_merge`,
  1 `branch_creation`) back to the `branch_creation` of main at 2026-07-11T22:02:06Z. It reached the end of history,
  so its interval is `["-inf", 2026-10-06T19:02:01Z]`. It contains no `force_push` events.

**Season lower bound:** `T_S` = S-06-01T00:00:00Z. No season-S week-N publication can precede it.

**Selection, for each week N.** Only a `push` event can establish a publication; the other event types matter only
for the completeness checks.

1. **Publication event.** Find the latest `activity_type == "push"` event on `refs/heads/main` that is strictly
   before the cutoff and whose `after` is a candidate. Several events sharing an `after` are first reduced to the
   earliest; timestamp ties are ordered by `id`. The selected commit is that `after`, and `available_by` is the
   event's timestamp.
2. **Coverage.** `[available_by, cutoff)` must be fully covered. Otherwise `publication_evidence_unavailable`. An
   older push is never promoted across an uncovered gap.
3. **Force-pushes.** Any `force_push` on `refs/heads/main` in `[available_by, cutoff)` makes the week
   `publication_evidence_unavailable`.
4. **Unfetchable targets.** Any event of **any** activity type on `refs/heads/main` in `[available_by, cutoff)`
   whose `after` is `unfetchable` makes the week `publication_evidence_unavailable`.
5. **No qualifying push.** If step 1 finds nothing:
   - if any candidate exists (from either source) → `publication_evidence_unavailable`: a payload existed but its
     publication cannot be proven;
   - else, if `[T_S, cutoff)` is fully covered and no event in it has an `unfetchable` target →
     `weeks_unpublished`;
   - else → `publication_evidence_unavailable`.

   `weeks_unpublished` is therefore claimed only with complete evidence of absence (astra S6-I1). Missing evidence is
   never reported as non-publication.

**Scored values:**

- If the selected commit contains the legacy file, use `players[].points.ppr.{p10,p50,p90}` from
  `site/data/weekly.json`.
- Otherwise use the neutral `stat_quantiles`, scored in PPR by `ffmodel.site.leaguelens.reference_score`. The weights
  are `effective_weights` of the `sleeper_scoring` in `configs/formats/f12-1qb-ppr-4.yaml`, which equal
  `scoring.PPR`.
  - This was verified on batch `2026-10-06T16:11:28Z`: across 1,974 values the maximum difference was 0.005, the
    legacy file's 2-dp rounding.
- **Neutral validation comes before scoring** (astra S7-I4). A neutral payload is validated on its **full stat
  vectors** — player identity and duplicates (a key whose records differ in any component is conflicting, even if
  they score to the same points), every `PREDICTED_STATS` component finite in all three quantiles, including
  components with zero weight in the scoring format, and `p10 ≤ p50 ≤ p90` per component — and only valid rows are
  then scored. Validity is never inferred from the scored points. Conflict between same-key records is judged on the
  whole `stat_quantiles` object (every component the payload carries); finiteness and ordering are checked on
  `PREDICTED_STATS`.
- **Equivalence**, when both files exist in the selected commit and come from the same batch (equal `generated_at`,
  season and week):
  1. both files are validated first (§3.7; the neutral one on its full stat vectors);
  2. the sets of valid player IDs must be equal;
  3. for every player and each of p10, p50 and p90, both values must be finite and `|neutral − legacy| ≤ 0.01`.

  Any failure skips the week with reason `equivalence_failed`, listing the missing, invalid and divergent players.
  An incomplete comparison is never labelled checked (astra P5).

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

**Empty pool.** If a complete week's population is empty, the week is recorded as `no_scorable_points` with its
unprojected counts, and it contributes nothing to pooled metrics. Undefined metrics are written as `null`, never NaN
(astra P6).

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
- **Content and identity** (both checked before an archive can qualify; astra P4):
  - the blob at `C` (`git show C:path`) has a sha256 prefix equal to the filename's 16-hex digest under
    `live_experts`'s naming rule, otherwise `archive_hash_mismatch`;
  - the blob's own `season` and `week` equal the filename's, otherwise `archive_identity_mismatch`;
  - the blob passes §3.7, otherwise `validation_failed`.

  An archive failing any check does not qualify. If the archive that *would* have been selected fails, the week's
  primary ranking is skipped with that reason; an older archive is never promoted in its place.
- **Selection:** among qualifying archives, the latest `available_by` wins. Ties go to the lexicographically first
  filename, flagged `arbitrary_lexicographic`. The other qualifying archives are listed by filename and blob hash.
  (Cut in draft 7: the alternative-archive sensitivity.)
- **Expected for 2026:** weeks 1–3 have no qualifying archive.
  - Week 3's only archive was added by `c502c55`, pushed 2026-09-24T03:58:50Z, after the 00:00Z cutoff.
  - The cutoff is not moved to rescue it.
  - Week 4 selects `2026-w04-2026-09-30-5aec56b70c3784e6.json` (408 players, pushed 21:32:42Z); `…220d00155877a0a7`
    (325 players) is listed as the other qualifying archive.

**Secondary: nflverse same-week.** The §5.2 rule is applied to season S and reported separately, labelled by source.
Both sources are FantasyPros mirrors, not independent panels.

**Per-week values are retained:** each scored week records, per source and position, n, our Spearman, consensus
Spearman and their delta. The Markdown summary renders them (§4.6).

### 4.4 (Removed in draft 6)

The live snapshot-change diagnostic is cut.

### 4.5 Frozen reproduction (one-time acceptance)

- **Command:** `--weeks 1-4 --frozen-record models/diagnostics/live_2026_w1-4_reproduction.json`.
- **Contents:** every input identity (§4.6 `inputs`), the publication shas and their ledger events, archive filenames
  and blob hashes, and joined ID counts.
- **Commit:** it is committed with the first live artifact (§8 step 5), not with the code merge.

**Expected relationship to the scratch measurement:**

- Point metrics should match: MAE 4.359, coverage 0.797, delta −0.313.
- Naive MAE: astra's 2026-10-07 in-memory run gave 4.6757 against the scratch 4.673, on inputs not pinned to the
  scratch vintage. The difference is explained at row level during acceptance; the baseline rule is never adjusted
  to match.
- The primary ranking is expected to **differ**:
  - week 3 drops out, because its archive was pushed after the cutoff (§4.3);
  - week 4 uses the `…5aec…` archive, not the scratch tie-break's `…220d…`.
- Every divergence gets row-level accounting. Matching the scratch never overrides a selection rule.

### 4.6 Output

**`models/diagnostics/live_<S>_weekly.json`**, where `S = current_nfl_season()`:

- `protocol_version`;
- `evaluator_version`: `protocol_version` plus the git tree id of `src/ffmodel` **in the checkout that is executing**
  (`git rev-parse HEAD:src/ffmodel`), plus a `dirty` flag if `git status --porcelain src/ffmodel` is non-empty;
- `inputs`, each with a content hash:
  - the actuals for every season pulled (S−3..S), because the naive fallback means depend on prior seasons;
  - the schedule;
  - the player-ID crosswalk;
  - `bakeoff.json` (blob hash);
  - every archive blob read;
  - the ledger as read;
- `weeks_scored`, and `weeks_skipped` with reasons;
- per week: the `publication` evidence (commit, ledger event id, `available_by`) and the `expert_snapshot` evidence;
- `points`, `ranking.primary`, `ranking.secondary`;
- `reference_context`;
- `caveats`;
- a `run` block: `run_at`, `as_of_date`, the pinned main sha, and `provisional_weeks`.

The file is serialised with `allow_nan=False`. With zero complete weeks, it writes an artifact with
`weeks_scored: []` and exits 0.

**`live_<S>_weekly.md`:**

- a cumulative headline line;
- a "Provisional: weeks …" line;
- a per-week table: week, `Z_N`, n, MAE, naive MAE, coverage, below/above, and ours vs consensus Spearman per
  source, or "—" only where that week has no scored ranking;
- the caveats.

**CLI:** `python -m ffmodel.eval.live_accuracy`. It writes `models/diagnostics/live_<S>_weekly.{json,md}` and updates
the ledger. Data goes into a fresh temporary cache unless `--data-dir` is given.

**Error policy:**

- **Data-content defects** skip the affected week (or computation) with a reason: `equivalence_failed`,
  `archive_hash_mismatch`, `archive_identity_mismatch`, `validation_failed`, `identity_collision`,
  `publication_evidence_unavailable`, `no_scorable_points`.
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
- **Public steps:**
  1. Run the CLI.
  2. Stage only `models/diagnostics/live_*_weekly.json`, `live_*_weekly.md` and `main_push_ledger.json`.
  3. If nothing changed, skip to the private step.
  4. Commit `data: weekly accuracy refresh`. Then, up to 3 attempts: `git pull --rebase`, then `git push`. Never
     force.
- **Private step (§4.8), fail-soft:** runs after the public steps, in a separate job that cannot write the public
  repo. Its failure marks the workflow with a warning annotation and never blocks or reverts the public artifact.
- **Fail-safe:** an infrastructure error stops the public job before the commit. The workflow never writes `site/`.
- **Permissions:** the public job has `contents: write`, which covers the activity API read, and
  `GH_TOKEN: ${{ github.token }}` for `gh api`. The private job has `contents: read` on the public repo and uses
  `PRIVATE_DATA_TOKEN` (fine-grained, the private repo only) for the private repository.

### 4.8 Sleeper comparator (private) — `sleeper_compare.py`

**Status:** private until the owner decides otherwise (2026-10-07). Its report lives only in the private repository.
Public artifacts never contain Sleeper values, row-level or aggregate.

#### 4.8.1 Input contract (what the collector must write)

Each capture is one gzipped raw response at `sleeper/<S>/w<NN>/<retrieved_at>.json.gz` plus one manifest line in
`sleeper/manifest.jsonl`:

- `retrieved_at` (UTC, the request time), `request_url`, `http_status`, `sha256` of the raw **uncompressed**
  response bytes, `season`, `week`, and `path` relative to the private checkout root;
- `source_updated_at_min`/`max` over records that carry `updated_at`, and the count that do;
- `published_commit` (main's HEAD sha when the capture ran) and `published_batch_id` (the neutral batch id at that
  sha);
- `capture_kind`: `scheduled` or `manual`.

Files are never overwritten or deleted. The week-5 capture taken by hand on 2026-10-07T17:58:17Z
(`data_snapshots/sleeper_projections/2026_w5_fetched_20261007T175817Z.json`, sha256 `5a8b22f2…0742`) is imported
with `capture_kind: manual`, its retrieval time taken from the filename, and the provenance fields it cannot have
recorded set to `null`. Retrospective API pulls of past weeks are **never** imported.

#### 4.8.2 Which snapshot

For week N with a selected publication (§4.1):

- **Paired (primary):** the capture with the smallest `|retrieved_at − available_by|`, provided `retrieved_at` is
  before the cutoff and within 24 h of `available_by`. Ties go to the earlier capture. This approximates an equal
  information deadline.
- **Latest (secondary):** the latest capture before the cutoff. It is labelled `sleeper_timing_advantage` with the
  gap in hours: it answers which available product was better, not which method was better.
- No qualifying capture → the week is skipped for §4.8 with `no_sleeper_snapshot`.

#### 4.8.3 Validation and scoring

- **Rows:** records with `category == "proj"`, `season == S`, `week == N`, position in {QB, RB, WR, TE}.
- **Identity:** `sleeper_id` → `gsis_id` through the nflverse crosswalk. A Sleeper id mapping to several gsis ids, or
  several Sleeper ids mapping to one gsis id, invalidates every row involved (`crosswalk_collision`). (The current
  crosswalk has 5 duplicated ids on each side.) Unmapped ids are counted.
- **Scoring:** common-component PPR. Sleeper's stat keys map to `PREDICTED_STATS`:
  `pass_yd→passing_yards`, `pass_td→passing_tds`, `pass_int→passing_interceptions`, `rush_att→carries`,
  `rush_yd→rushing_yards`, `rush_td→rushing_tds`, `rec_tgt→targets`, `rec→receptions`, `rec_yd→receiving_yards`,
  `rec_td→receiving_tds`, `fum_lost→fumbles_lost`. Points = `fantasy_points(components, PPR)`, the same function and
  components as our actuals, so two-point conversions and special-teams scores are excluded on both sides.
  - Sleeper omits keys whose value is zero, so an **absent** mapped key is 0.
  - A **present** key whose value is null or non-finite makes the row invalid.
  - A row is a valid projection only if `pts_ppr` is present and finite.
  - The distribution of `|pts_ppr − rescored|` is reported as a reconciliation check, not used for scoring.
- The §3.7 1% threshold applies to the Sleeper table.

#### 4.8.4 Metrics and decision

- **Population:** played ∩ our valid projection ∩ valid Sleeper projection. Missingness on each side is reported by
  week and position, including how many played players each source failed to project.
- **Primary view:** the fantasy-relevant union, `our p50 ≥ 8 OR Sleeper ≥ 8` (PPR). The threshold is fixed now and
  never searched. **Diagnostic view:** the whole population.
- **Per view, per week and cumulative:** MAE of ours, Sleeper and a fixed 50/50 blend of the two point projections;
  paired deltas `ours − Sleeper`, `blend − Sleeper` and `blend − ours`, each with player-clustered and
  `week|team`-clustered intervals; within-position Spearman per position-week cell; per-position MAE.
- The blend is a shadow point comparator. It has no band and is not a product claim.
- **No weekly decisions.** The comparison is read once, after the last REG week: the primary claims are
  `ours − Sleeper` and `blend − Sleeper` in the primary view, with Holm adjustment across the two at family level
  0.05. Each claim's p-value is the two-sided percentile-bootstrap p of its paired MAE delta, and the **larger** of
  the player-clustered and `week|team`-clustered p-values is used (the more conservative). Everything else is
  diagnostic. "Inconclusive" is an allowed outcome. Weeks 1–4 of 2026 are never pooled with this series.

#### 4.8.5 Running it

- The private job checks out the private repository with `PRIVATE_DATA_TOKEN`, runs
  `python -m ffmodel.eval.sleeper_compare --snapshots <private checkout> --live-artifact <public artifact> --out <private checkout>/reports/`
  and pushes `reports/sleeper_<S>.json` and `.md` to the private repository only.
- It reads the public artifact's selected publications rather than repeating §4.1.
- **Its stats are a separate data vintage** (astra S7-I5). The private job pulls its own actuals, schedule and
  crosswalk, so it repeats `team_presence_complete` (§3.3) and §3.7 validation on those inputs. A week the public
  artifact scored but whose private inputs fail is skipped with `private_inputs_incomplete` or `validation_failed`;
  the public run's decision is never borrowed. The private report records these skips.
- **Private provenance:** content hashes of the actuals, schedule and crosswalk actually read, the public artifact's
  bytes, the manifest, and every selected capture's sha256; its own `evaluator_version` (§4.6, with protocol
  `sleeper-compare-v1`) and `run_at`.

## 5. (B) Same-week reanalysis

### 5.1 Samples and models

| Sample | Seasons | Model | Old-protocol artifact |
|---|---|---|---|
| Discovery | 2023–2025 | ensemble `{v1, v1_s43, v1_s44}/through{S−1}` (`weekly_consensus.transformer_predictor`) | `weekly_consensus.json` |
| Replication | 2020–2022 | the same ensemble; folds through2019–2021 (`rb_oos_weekly.json.artifacts_evaluated`) | `rb_oos_weekly.json` |

Splits come from `walk_forward_splits`. The model side is unchanged from the original measurements (§3.7 masks
rather than drops). Every model artifact used is recorded by path and content hash (§6.6).

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
  - **Record:** every candidate is recorded with its date, gate state and page states.
- **Population:** played rows of week N whose game date is **strictly after** the scrape date.
- **Pool:** date-eligible played rows ∩ model predictions ∩ matched consensus (§3.7). The model predicts every
  feature row.
- **Retention:** reported by season, week and position, including the count of excluded early-game players and the
  match rate. (Cut in draft 7: per-game-day retention.)

**Estimand, stated in the artifact:** within-position ranking of players who recorded a stat line, were matched, and
had not yet played at the scrape date.

- Our cutoff is the end of week N−1; the experts' is the scrape date, which can include that week's earlier games
  and practice reports.
- The net selection effect of excluding early games is **undetermined**, and no direction is claimed.
- Old and new numbers are different estimands.

Postponed games use their actual `gameday`.

### 5.3 (Cut in draft 7)

The historical snapshot-change diagnostic is cut. The old-protocol numbers are still reported beside the new ones,
labelled `different_estimand` (§6.6).

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

- **Primary analysis:** `bye_consistent` plus `unverified` weeks. Unverified weeks are labelled `inferred_by_window`
  in the per-week provenance.
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

- `protocol_version` (`sameweek-v1`), `evaluator_version` (§4.6, built with this artifact's own protocol version, not
  the live one), and `protocol` (§§3, 5, 6 quoted);
- `inputs` with content hashes: rankings cache, schedules, weekly actuals, crosswalk, and every model fold artifact
  (path and hash, not only the fold name);
- for each sample:
  - overall, per_position and per_season results;
  - the leave-one-season-out results;
  - the sensitivity, with coverage;
  - per-week provenance: candidates, selected scrape, per-page gate states, pool sizes, exclusions and skips. A week
    with no selected scrape keeps its candidates and skip reason;
- `coverage` (§3.6) and the validation counts per reason, table and position (§3.7);
- the old-protocol numbers read from the two old artifacts, labelled `different_estimand`;
- `old_protocol_staleness_audit`:
  - for every 2020–25 week, the old protocol's scrape and its §3.5 state;
  - the counts;
  - the exact list of discriminating weeks (`A` and `B` both non-empty and different);
- `status` (`ok` or `alarm_negative_correlation`) and, when present, `alarm_audit` (§3.9);
- `verdicts: {rule_1: {value, reasons}, rule_2: {value, reasons_by_sample}}`.

Serialised with `allow_nan=False`.

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

The original text stays visible as the record, clearly marked as superseded so it cannot be read as a current claim.
Two corrections ride along:

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
  - **stage 1:** an exact duplicate actuals row is collapsed *before* `build_features`, so the next week's
    `lag4_carries` equals the de-duplicated value (astra P3: history 10, 20, 20, 30 → 15.0, not 16.67);
  - **stage 1:** an exact duplicate schedule game collapses without error and the affected players keep a valid
    game date;
  - a conflicting schedule side invalidates that side, and its players' rows are masked;
  - a conflicting actuals group stays in the `build_features` input and is masked from scoring;
  - a dual-page same-key duplicate with different ECR → the whole group is invalid;
  - non-finite values in evaluated fields only;
  - inverted quantiles;
  - `gsis_collisions > 0` → `identity_collision`;
  - exactly 1% passes, and just above it gives `validation_failed`;
  - a key that fails several rules is counted once;
  - a table above 1% on a secondary path (nflverse secondary, §4.8) skips that computation and never runs on the
    surviving subset.
- **Cluster keys:** `season*100 + week` and `f"{week}|{team}"` are 1-D scalars that `paired_bootstrap` accepts.
- **Driver path:** the full stage-1 → `build_features` → stage-2 path runs on a synthetic raw table (not only on a
  pre-built frame).

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
- **Full precision:** a lower bound of `+0.00003` passes (a), exercised from cell rows through `delta_stats` and the
  rule functions, not by constructing the statistics directly.
- **Alarm ((B) only):** `alarm_negative_correlation` with no verdict; `--alarm-audited` with a `no_defect` record
  publishes with the warning.
- **Diagnostics:** the `n ≤ slots` flag.

### 7.3 `live_accuracy.py`

- **Activity fetch:** a mocked three-page `--slurp` response (built from synthetic events) parses to the
  concatenated events; a non-array page and a failed fetch are infrastructure errors.
- **Publication evidence:**
  - a covered `push` with `after == C` before the cutoff is selected;
  - a push after the cutoff is not selected;
  - several events for one sha: the earliest is used; ties are broken by `id`;
  - a newer publication push inside a coverage gap makes the week unavailable, and the older push is not promoted;
  - a `force_push` in `[available_by, cutoff)` makes the week unavailable;
  - a `pr_merge` in `[available_by, cutoff)` whose target is unfetchable makes the week unavailable (astra P2);
  - a week-N bot payload present only at a retained `force_push` target, unreachable from main, is a candidate, so
    the week is `publication_evidence_unavailable`, not unpublished (astra P2);
  - no candidate and `[T_S, cutoff)` fully covered → `weeks_unpublished`;
  - no candidate and a coverage gap in `[T_S, cutoff)` → `publication_evidence_unavailable` (astra S6-I1);
  - a complete collection ending at `branch_creation` covers back to `-inf`;
  - astra's commit-before / push-after case: an older publication is selected;
  - astra's sibling case: `F` is never selected.
- **Candidates:**
  - a hand-made commit is rejected;
  - a commit by `weekly-accuracy-bot` is rejected;
  - a commit changing only the neutral `weekly.json` is a candidate;
  - a commit changing neither weekly file is not.
- **Scored values:**
  - legacy `points.ppr` is used when present;
  - neutral re-scoring is used otherwise;
  - when both exist, equivalence passes within 0.01;
  - a divergence, a player missing from the neutral file, an empty neutral player list, and a NaN neutral quantile
    each give `equivalence_failed` for that week only (astra P5).
- **Archives:**
  - the evidence event is found via `push`/`pr_merge` with ancestor-or-self;
  - an archive pushed after the cutoff is excluded (the week-3 shape);
  - a tie gives `arbitrary_lexicographic`;
  - a hash mismatch gives `archive_hash_mismatch`;
  - a correctly hashed file named for week 4 whose payload says week 9 gives `archive_identity_mismatch`
    (astra P4);
  - an archive above the 1% threshold gives `validation_failed`, and an older archive is not promoted;
  - content is read from `C`, not from the working tree.
- **Points:**
  - hand-computed metrics;
  - the naive fallback, and a missing-position fallback raises;
  - lags strictly shifted, so no future actual reaches a naive value;
  - both cluster intervals;
  - a complete week with zero projection matches → `no_scorable_points`, nulls, no warning under `-W error`
    (astra P6);
  - `json.dumps(..., allow_nan=False)` succeeds on every artifact the tests produce.
- **Ranking pool:**
  - the three-way intersection;
  - a week with no RB coverage;
  - empty and all-degenerate cells;
  - per-week Spearman values are retained and rendered in the Markdown table.
- **Ledger:**
  - merges by `id` and never deletes;
  - forms the union of coverage intervals;
  - stores `actor.login` only;
  - loads the seed as its first collection, with interval `["-inf", 2026-10-06T19:02:01Z]`.
- **Output:**
  - identical inputs and an identical `run` block give byte-identical output;
  - zero complete weeks → `weeks_scored: []`, exit 0;
  - the output path is derived from `current_nfl_season()`;
  - `evaluator_version` uses the executing checkout's tree and flags a dirty tree;
  - `inputs` hashes cover all pulled seasons, `bakeoff.json` and archive blobs;
  - the summary renders with its provisional line.
- **Presence:** a week missing a team's rows is skipped.

### 7.4 `sleeper_compare.py`

- **Snapshot choice:** paired = nearest to `available_by` within 24 h and before the cutoff, ties to the earlier;
  latest = last before the cutoff, with the timing gap; none → `no_sleeper_snapshot`.
- **Scoring:** absent key → 0; present null → invalid; missing `pts_ppr` → invalid; a hand-computed re-score per
  position.
- **Identity:** a one-to-many and a many-to-one crosswalk collision each invalidate every row involved.
- **Metrics:** the relevant-union filter uses projections only (never actuals); the blend is exactly 0.5/0.5; the
  three paired deltas; missingness per side.
- **Privacy:** the module's tests assert that it writes only under the `--out` directory given, and the workflow test
  asserts the private job has no write permission on the public repo.

### 7.5 Acceptance

- `pytest -W error` and every `tests/*_fixture.cjs` pass, locally and in CI.
- Data checks on the real caches, run **offline**: the acceptance tool takes explicit existing cache file paths and
  runs with `FFMODEL_CACHE_FROZEN=1`, so a missing file is an error, never a download (astra P7):
  - `unknown_team_codes == 0` for every 2020–25 scrape;
  - the §4.1 weeks 1–4 selections match the table.
- The frozen reproduction record (§4.5) is produced. Every divergence from the scratch measurement is accounted for
  at row level.

## 8. Rollout

1. **Review:** astra re-reviews draft 7 and the revised plan.
2. **Build:** subagent-driven. Sonnet implements and does task reviews, Opus reviews the numerics and leak-surface
   tasks, and Opus does the final review.
3. **Merge:** code, workflow, tests and the ledger seed. No site data, no frozen paths. The owner OKs the push.
4. **Collector prerequisite:** `market-snapshots.yml` is live, the private repository and `PRIVATE_DATA_TOKEN` exist,
   and the week-5 manual capture is imported (§4.8.1). Until then the private job is skipped with a notice.
5. **First live run:** dispatch `weekly-accuracy.yml` by hand. Check its artifact, then commit the frozen
   reproduction record with the row-level divergence notes.
6. **Reanalysis:** run (B) locally once, commit its artifact, and report the verdicts and full numbers to the owner.
7. **Copy:** apply §6.7, with the owner's OK before the push.
8. **Season end:** read §4.8.4 once, and report it privately to the owner.

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
- **Sleeper:** the paired snapshot approximates an equal deadline only to within the capture schedule; Sleeper's
  source update times cover a minority of records (376 of 3,045 in the week-5 capture); the API is unofficial and
  may change; the re-score uses common components only. Four time-clustered weeks per month means the season-end
  read may well be inconclusive.

## 10. Review trace

**Astra rounds 1–4 and the Opus review of draft 5** are traced in this file's git history (drafts 2–6, commits
82725c4, 9dc7a55, 135a123, 4f78fe9, 5e651df). The accepted core:

- the tri-state gate;
- metadata-only selection;
- the directional check (a)–(d) with leave-one-season-out;
- no tie outcome;
- per-season and per-position sufficiency;
- exact push evidence.

**Astra review of draft 6 and the plan (2026-10-07):**

| Finding | Resolution in draft 7 |
|---|---|
| S6-I1 absence across missing history | §4.1: season lower bound `T_S`; step 5 claims `weeks_unpublished` only with `[T_S, cutoff)` fully covered and every target fetchable; `-inf` coverage from `branch_creation`; §7.3 fixtures |
| P1 paginated activity output | §4.1 `--paginate --slurp` and page flattening; §7.3 multi-page fixture |
| P2 checks inspect only `push` targets | §4.1: candidates enumerated from reachable history and every ledger target; step 4 covers every activity type; §7.3 `pr_merge` and `force_push`-target fixtures |
| P3 validation after transformation | §3.7 two-stage validation: raw actuals and schedule de-duplicated before `build_features`; schedule validated as its own table; §7.1 lag and driver-path fixtures |
| P4 archive identity and secondary thresholds | §4.3 identity and validation checks before qualification, no promotion; §3.7 threshold on every path; alternative-archive sensitivity and `_old_cells` diagnostic cut |
| P5 equivalence can pass incomplete | §4.1 equivalence steps 1–3; §7.3 fixtures |
| P6 empty point pool writes NaN | §4.2 `no_scorable_points`, nulls; §4.6 `allow_nan=False`; §7.3 fixtures |
| P7 acceptance tool downloads | §7.5 explicit cache paths, `FFMODEL_CACHE_FROZEN=1` |
| Minor: `ci_cell` missing | Cut (§3.8) |
| Minor: precision fixture bypasses verdict path | §7.2 full path |
| Minor: provenance | §4.6 inputs and executing-tree `evaluator_version`; §6.6 model artifact hashes |
| Minor: retention and coverage detail | §3.6, §5.2 trimmed to what is reported; per-game-day and per-page detail cut |
| Minor: per-week ranking values, Markdown "—" | §4.3, §4.6 |
| Minor: alarm procedure | §3.9 concrete audit procedure and `--alarm-audited` |
| Minor: workflow rebase-then-push | §4.7 (the plan is corrected to match) |
| Minor: naive 4.6757 vs 4.673 | §4.5 row-level explanation at acceptance |

**Astra review of draft 7 and plan b880f9e (2026-10-07, `.review/astra-weeklyacc-spec7-plan-response.md`):**

| Finding | Resolution |
|---|---|
| S7-I1 ancestry pruned by committer time | §4.1 full ancestry from every ledger target; no timestamp pruning |
| S7-I2 mixed exact/conflicting actuals | §3.7 stage 1: conflicting keys first; collapse only non-conflicting groups |
| S7-I3 failed prior-week schedule | §3.7 schedule dependencies; no `L_1` fallback for N > 1 |
| S7-I4 neutral validated after scoring | §4.1 full-stat-vector validation before scoring |
| S7-I5 private run borrows completeness | §4.8.5 separate vintage: own completeness, validation and provenance |
| Minor: evaluator label | §6.6 own protocol version |
| Minor: schedule duplicate count lost | §3.7 per-week count carried into the artifact |

**Owner decisions of 2026-10-07:** §4.8 Sleeper comparator, private; private repository for third-party data; the
"smallest trustworthy report" principle and the cuts above.
