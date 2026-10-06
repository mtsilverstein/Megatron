# Weekly accuracy tracking and same-week expert benchmark — design

**Status:** draft 5 (2026-10-06). The owner approved the design section by section in conversation. Astra returned
REVISE on drafts 1–4 (`.review/astra-weeklyacc-spec-response.md`, `-r2-response.md`, `-r3-response.md`). §10 maps
every finding to its resolution. Round 3 accepted §5.2's selection and §6.5's directional rules, and it found the
leave-one-season-out requirement conservative but reachable. Draft 5 awaits an astra re-review and the owner's
review.

## 1. Why

Two findings from 2026-10-06.

**Live point accuracy has never been tracked.** The weekly projections published before 2026 kickoffs, scored on
weeks 1–4, give:

| Measure | Result |
|---|---|
| PPR MAE | 4.36 |
| 2023–25 backtest MAE (n-weighted, from `bakeoff.json`) | 4.32 |
| p10–p90 coverage | 79.7% |
| Share of misses below p10 / above p90 | 8.8% / 11.6% |
| Lead over the naive last-4 average | 0.31 points per player-week, 95% CI [0.14, 0.49], player-clustered |

Nothing computes this routinely, and these numbers are descriptive context, not a formal test. The owner wants to
see them week to week.

**The weekly expert benchmark was stale by a week.** `eval/weekly_rankings.weekly_snapshot` takes the latest
nflverse `load_ff_rankings("all")` scrape in `[kickoff − 7d, kickoff)`. nflverse scrapes predominantly once a week:
Fridays in 2021–26 and Thursdays in 2020, with a few exceptions (§3.6). So that window usually holds the previous
week's ranking. The evidence:

- Two exploratory checks agree, under different definitions of "discriminating":
  - Mine: 13 of 13 stale (ad hoc thresholds, inclusion list not retained).
  - Astra's: 17 of 17 stale and 0 current. Here a week counts when both adjacent weeks have non-empty, different bye
    sets.
- The reproducible count, with definition, input hash and exact list, is the (B) driver's
  `old_protocol_staleness_audit` (§6.6). Public copy will cite that.
- Concretely, the stale pattern means teams on bye in week N are present in the scrape and teams on bye in week
  N−1 are absent.

So the site's 2023–25 "statistical tie with expert consensus" and the 2020–22 running-back replication were measured
against week-old consensus. Commit c38e175 already marks both claims "not established". That withdrawal stands
regardless of what (B) finds.

**What this project adds:**

- **(A)** an automated weekly scorecard of the projections the site's data pipeline published;
- **(B)** a pre-registered reanalysis of both historical samples against same-week rankings.

(B) is a pre-specified correction and reanalysis of data that has already been analysed. It is not a new,
untouched replication.

## 2. Scope

**In scope:**

- `src/ffmodel/eval/sameweek.py`: same-week primitives.
- `src/ffmodel/eval/live_accuracy.py`: (A).
- `src/ffmodel/eval/weekly_consensus_sameweek.py`: the (B) driver.
- `.github/workflows/weekly-accuracy.yml`.
- A behaviour-preserving refactor of `ffmodel.data.rankings.attach_gsis`: its row-level matching moves into a new
  public `map_consensus_rows(snapshot, crosswalk) -> DataFrame`, which keeps every source row and the
  `match_method` per row and does no dedupe. `attach_gsis` calls it and keeps its dedupe, guards and stats
  unchanged. Existing tests, plus a new equality test on synthetic snapshots with ties and collisions, prove the
  output is byte-identical.
- Tests, the committed artifacts and `models/diagnostics/main_push_ledger.json`.
- The §6.7 copy changes after (B), pushed only with the owner's OK.

**Out of scope (unchanged):**

- the model;
- published site data and `weekly-update.yml`;
- the frozen prospective paths (`models/prospective/**`, `prospective-*.yml`);
- the existing modules `weekly_rankings.py` and `weekly_consensus.py`, and their artifacts, which are the record.

The site scorecard UI is phase 2. It will be decided once about 8 live weeks exist, and it will read the (A)
artifact.

**Repo rules:** the repo is public, so all test fixtures are synthetic.

## 3. Shared definitions (`sameweek.py`)

### 3.1 Schedule dates

For REG week N of season S, from `pull_schedules` (team codes already normalised by `normalize_schedule_teams`):

- **`K_N`** = earliest `gameday` of week N, the first kickoff date. This equals `weekly_consensus.weekly_kickoffs`.
- **`Z_N`** = latest `gameday` of week N.

A **player's game date** is the `gameday` of the unique week-N schedule row containing the player's `team`. Zero or
several matching rows is a validation error for that row (§3.5), never a silent drop.

### 3.2 Played population

The rows of `build_features(pull_weekly(seasons), pull_schedules(seasons))` for (S, N): one player who recorded a
REG stat line that week. Actual points = `fantasy_points(row[PREDICTED_STATS], PPR)`.

- **Pull span:** the live check pulls seasons S−3 through S. The historical driver uses `weekly_consensus.main`'s
  span.
- **The estimand excludes** DNPs and players with no stat line, and these are stated as excluded. It is
  conditional on appearance, as in the original benchmark.

### 3.3 Team presence and freshness

A week is **`team_presence_complete`** when every REG (week, team) pair in the schedule has at least one played row.
This is the `prospective.freeze.check_fresh` rule for one week, and it is named for what it actually proves. It is a
minimum freshness check, not proof that the data is final.

**Provisional data:** a week whose `Z_N` is less than 8 days before the run's `as_of_date` is `provisional`. This
flag lives only in `run.json` (§4.6). The live artifact is recomputed from scratch on every run, so later stat
corrections replace earlier values. Each run records the actual-data input hashes, which makes every revision
traceable.

### 3.4 Team-code normalisation for rankings

One explicit mapping, applied to `normalize_weekly_rankings` team values before any comparison with schedule teams:

```
{"JAC": "JAX", "LA": "LAR", "STL": "LAR", "SD": "LAC", "OAK": "LV", "WSH": "WAS", "ARZ": "ARI", "BLT": "BAL",
 "CLV": "CLE", "HST": "HOU", "KCC": "KC", "GBP": "GB", "NOS": "NO", "NEP": "NE", "SFO": "SF", "TBB": "TB", "LVR": "LV"}
```

Codes that are blank or `FA` are ignored for team presence. Any other code not among the season's schedule teams
after mapping is counted under `unknown_team_codes` and reported. It never contributes presence. The 2% unknown-code
rule enters the gate only at step 4 of §3.5.

### 3.5 Week-identity gate (tri-state)

For a scrape assigned to week N, evaluate each position page separately:

- `P ∈ {QB, RB, WR, TE}`;
- `R_P` = the set of mapped teams present on page P;
- `A` = the teams on bye in week N;
- `B` = the teams on bye in week N−1 (for week 1, `B = ∅`).

With `a = |A ∩ R_P| / |A|` (when `A ≠ ∅`) and `b = |B ∩ R_P| / |B|` (when `B ≠ ∅`), evaluate in this order:

1. **Absent pages.** A page with no rows is `absent` and takes no further part. If every page is absent, the week
   state is `unverified` and the week has no ranking rows anyway.
2. **Per present page:**
   - `contradicted` if `a > 0.5` or `b < 0.5`;
   - `bye_consistent` if it is not contradicted, at least one of `a`, `b` is defined, and every defined value is
     strictly on the current side (`a < 0.5`, `b > 0.5`);
   - `unverified` otherwise: no byes on either side, or an exact half.
3. **Week state over the present pages:**
   - `contradicted` if any present page is contradicted;
   - `bye_consistent` if all present pages are bye_consistent;
   - `unverified` otherwise.
4. **Provenance downgrade:** if unknown codes exceed 2% of the snapshot's QB/RB/WR/TE rows, or any of the four
   pages is absent, a `bye_consistent` week becomes `unverified`. The downgrade never erases `contradicted`.

**What `bye_consistent` means:** the bye pattern is compatible with week N, under the window and source assumptions.
It does not independently prove week identity. With `A = ∅`, for example, another week's page listing the
returning teams would also pass. The sensitivity in §6.4 is named "bye-consistent only", never "verified".

A week-N ranking omits week-N byes and lists week-(N−1) byes; a stale one shows the reverse. Presence is judged per
team and per page, so a fresh page cannot mask a stale one. A team's only row can still flip its presence: the
majority threshold tolerates errors in a minority of bye teams, and with a single bye team it is deliberately
strict. These thresholds are fixed now, before any accuracy delta is seen.

Contradicted weeks are always skipped. How unverified weeks are treated is set per analysis in §6.4.

### 3.6 Coverage reporting

Every artifact reports, per season:

- raw versus accepted ranking rows;
- the scrape dates and their weekdays;
- page coverage.

Legacy-schema rows (`page_type == "weekly-offense"`, through 2020-10-12) are excluded by `normalize_weekly_rankings`.
They are **intentionally** excluded here too, because the original benchmark excluded them and adapting them is out
of scope. They are reported as `excluded_legacy_schema`, distinct from "no source data".

### 3.7 Validation (fail loudly, never shrink silently)

Validation runs per input table, per (season, week), **before** any join or feature construction:

| Table | Key | Evaluated fields |
|---|---|---|
| actuals (`pull_weekly` rows) | `(season, week, player_id)` | `PREDICTED_STATS` |
| published projections (§4.1) | `player_id` | `points.ppr.{p10,p50,p90}` |
| consensus snapshot rows | source id `fp_id` | `ecr` |
| schedule | `(season, week, team)` | `gameday` |

**Rules:**

- **Exact duplicates** collapse to one row, counted as `exact_duplicates`; they are not errors. Exact means the
  same key and identical evaluated fields **and** identical eligibility, join and grouping fields: team, position,
  name and match fields.
- **Conflicting duplicates** (same key, any difference in those fields) invalidate every row in the group, counted
  as
  `conflicting_duplicates`. For actuals this happens before `build_features`, so a duplicate cannot contaminate lag
  features.
- **Non-finite values** in the evaluated fields only invalidate that row. Lag features may legitimately be NaN.
- **Quantile order:** `p10 ≤ p50 ≤ p90` must hold, otherwise the row is invalid.
- **Schedule join:** a player whose team has zero or several week-N schedule rows is invalid for that week.
- **Consensus identity collisions:**
  - The audit uses `map_consensus_rows` (§2), the complete row-to-player mapping before any dedupe, with
    `attach_gsis`'s own matching precedence.
  - A **collision group** is every source row (`fp_id`) mapped to one `player_id` by two or more distinct source
    keys. Ties in `ecr` are irrelevant.
  - Every member of every group is invalid: each affected unique source key counts once in the snapshot table's
    numerator, and the `player_id` is removed from the consensus pool. The count is `identity_collisions`.
  - **Reconciliation:** the number of rows removed by group members beyond the first must equal `attach_gsis`'s
    `gsis_collisions` for the same snapshot, or the run fails.

**Threshold:**

- For each table, the excluded fraction is the number of unique keys invalidated for any reason divided by that
  table's unique keys before validation. An empty table has fraction 0 and is handled by the relevant skip rule
  (no publication, no snapshot, no rows). Exact duplicates don't count; a key is counted once even if it fails
  several rules.
- If any table's fraction exceeds 1% for a (season, week), the week is skipped with reason `validation_failed`.
  Exactly 1% passes.
- Counts are reported per reason, per table and per position.

The 1% figure is a data-quality tolerance, not a bound on metric error.

### 3.8 Ranking metrics (reused) and dependence

**Per week:** `weekly_rankings.score_week(cell, S, N, REPLACEMENT_RANK, min_cell=5)`, with cells built like
`weekly_consensus.week_cell` and positions taken from our frame. Degenerate cells (non-finite Spearman) are dropped
and counted.

All verdict inputs keep full precision; rounding happens only for display. Each pooled result reports:

- the cell-weighted mean delta `D` (ours − consensus);
- **`ci_week`**, the primary interval: a cluster bootstrap with clusters = `(season, week)`, so all positions in a
  slate move together;
- **`ci_cell`**, the original protocol (independent cells, the existing `pooled_stats`), labelled diagnostic;
- **per-season deltas**, and the number of seasons with `D_season > 0`;
- **leave-one-season-out deltas**;
- cluster counts.

Bootstrap settings: `mean_head_gate.paired_bootstrap`, seed 20260728, 10,000 resamples.

**Limitation, stated in the artifact:** three seasons are three clusters; serial dependence within a season is not
modelled; `ci_week` is conditional on these seasons.

**Start/sit hit rates** are reported as restricted-pool diagnostics. Cells with `n ≤ REPLACEMENT_RANK[pos]` are
flagged, because there the hit rate is trivially 1.

### 3.9 Negative-correlation alarm

Run `assert_model_sane` as an alarm, not a gate. On a negative mean model Spearman, the driver writes
`status: "alarm_negative_correlation"`, runs the sign/identity self-check fixtures, and stops without a verdict. The
owner is told. If the audit finds no defect, the result is published as computed with a limited-sample warning.
Population and sign are never changed to clear the alarm. Outside this alarm, a negative result is reported like any
other.

## 4. (A) Live weekly accuracy — `live_accuracy.py`

### 4.1 Projection: what the pipeline published, with an explicit evidence tier

The estimand is the bot pipeline's latest publication on main before the week's cutoff. Each week carries one of two
evidence tiers:

- `exact_push`: GitHub's push record proves main reached that commit before the cutoff.
- `retrospective`: timing is unverified, with a different stated estimand.

Neither tier verifies Vercel deployment. The site deploys main on push, so main state is a close proxy for what was
served, not proof of it.

- **Candidates.** A candidate is a commit `C` that satisfies all of:
  - it comes from either source:
    - the commits reachable from a pinned `origin/main` sha (`git rev-list`), or
    - the `after` shas of the main push ledger, which must exist locally. A ledger sha that cannot be fetched makes
      the week `publication_evidence_unavailable`;
  - it changes `site/data/weekly.json`, judged by `git diff --name-only C^1 C` rather than simplified path history;
  - its author and committer names are both `weekly-update-bot`.

  The pinned sha is recorded only in `run.json` (§4.6). Each week then gets exactly one **evidence tier**:
  `exact_push` if possible, otherwise `retrospective`, otherwise `publication_evidence_unavailable`. The tiers are
  never pooled (§4.2–§4.6).

- **The push ledger** (`models/diagnostics/main_push_ledger.json`) has two parts.
  - **Events.** Every run of the weekly accuracy job reads
    `GET /repos/{owner}/{repo}/activity?ref=refs/heads/main`, every activity type, cursor-paginated to the end. It
    merges in **every** returned event: `id`, `ref`, `timestamp`, `before`, `after`, `activity_type`, `actor`.
    There is no author filter, so force-pushes to non-bot commits are kept. Events are deduplicated by `id`, never
    deleted or edited, and sorted.
  - **Coverage.** Each collection appends one interval `[t_start, t_end]`:
    - `t_end` is the collection time;
    - `t_start` is the oldest event timestamp returned when pagination reached the API's end of history;
    - if pagination was cut short, `t_start` is the oldest event actually seen.

    Covered time is the union of these intervals. A gap between them is uncovered.

- **Tier `exact_push` (proven).** The week's selected commit is the latest pre-cutoff publication, determined from
  the ledger alone:
  1. **Coverage:** the interval from the week's latest pre-cutoff publication push to the cutoff is fully covered.
     So no newer pre-cutoff publication, and no force-push, can have been missed.
  2. **Selection:** within that covered interval, take the latest push event on `refs/heads/main` that is strictly
     before the cutoff and whose `after` is a candidate with a `season == S`, `week == N` payload. That `after` is
     the selected commit `C`, and `available_by` is the event's timestamp.
     - This is GitHub's server record that main's head became exactly `C`.
     - Several events with the same `after` → the earliest is used.
     - Events with equal timestamps → order by `id`.
  3. **Force-pushes:** if any `force_push` on `refs/heads/main` falls in `[available_by, cutoff)`, main's content
     at the cutoff is not established, and the week is `publication_evidence_unavailable`. A force-push before
     `available_by` does not matter: the selected push came later. A force-push after the cutoff does not change
     what was published before it.
  4. **Gaps:** if the coverage condition fails, the week is not `exact_push`. An older evidenced push is never
     promoted to "latest" across an uncovered gap.

  **Example:** `d43adc4` (week 4) was pushed to main at 2026-09-30T21:32:42Z, per the activity API, checked
  2026-10-06.

- **Tier `retrospective` (labelled, unverified timing).** This is used only when `exact_push` is impossible
  because the cutoff is before the ledger's earliest coverage. Its estimand is different and is stated wherever it
  appears: **"bot-pipeline content committed before the cutoff and found on main afterwards; whether it was on main
  before the cutoff is not verified."** It applies when all of these hold:
  - **Committer time:** `C`'s committer time is strictly before the cutoff. This is a lower bound on push time, not
    an upper bound.
  - **Selection:** `C` is the latest such candidate with a `season == S`, `week == N` payload. Equal committer
    timestamps → order by sha, recorded as `tie_break: "arbitrary_sha"`.
  - **Retained run inventory:** the `weekly-update.yml` run inventory, as retained in
    `models/diagnostics/weekly_update_run_inventory.json`, contains no run on a non-`main` branch with
    `created_at` before the cutoff.
  - **No re-runs:** no run with `created_at` before the cutoff was ever observed with `run_attempt > 1`.
  - **A supporting run:** at least one `main` run with `head_sha == C^1` exists. The full supporting set is
    recorded, and no producer identity is claimed.

  The inventory file is written as follows:
  - Each weekly accuracy run fetches all runs of the workflow (all branches, statuses and attempts) and checks that
    the retrieved count equals `total_count`, partitioning by `created` date if it is 1000 or more.
  - It merges, never deletes: per run it keeps `id`, `head_branch`, `head_sha`, `created_at`, `conclusion`, and the
    maximum `run_attempt` ever observed.
  - Each fetch also appends a record of when it ran, whether it was complete, and its `total_count`.

  So a run deleted upstream stays in our evidence. A re-run observed later withdraws the retrospective tier for
  affected weeks. That is conservative and disclosed. The prior decision stays visible in git history and in the
  artifact's `evidence_revisions` list.

  **Stated assumption:** runs deleted before our first inventory fetch (2026-10-06, 59 runs, all on `main`, all
  attempt 1) cannot be detected.

  A bot commit rebased onto a newer head fails `head_sha == C^1`. That is a disclosed false negative; the check is
  never loosened to ancestry.

- **Neither tier** → the week is `publication_evidence_unavailable`, distinct from `weeks_unpublished`, which means
  no candidate payload for the week exists at all. Missing evidence is never reported as non-publication.

- **Cutoff:** `K_N` 00:00 UTC, a common pre-week cutoff for every player. It is symmetric with the date-level expert
  snapshots, and it is not a per-player latest-before-game publication.
- **Estimand:** the bot pipeline's publications. Hand-made data pushes are excluded by design, and all wording says
  "the projections our automated pipeline published".
- **Recorded per week:** the tier, plus the evidence itself:
  - for `exact_push`, the ledger event id and the covering intervals;
  - for `retrospective`, the supporting run ids and the inventory fetch record.
- **Fields:** `players[].points.ppr.{p10,p50,p90}` by `player_id`.

**Expected for 2026: every week is `exact_push`.**

- A fully paginated activity fetch on 2026-10-06 returned 239 main events back to the repository's first push on
  2026-07-11. The raw response is saved locally at `.review/evidence-seed/activity-main-2026-10-06T190201Z.json` and
  will seed the ledger as its first collection.
- The weeks 1–4 publications have push events before their cutoffs:
  - week 1: `b451562`, 2026-09-02T09:45:11Z;
  - week 2: `fa9c095`, 09-16T20:15:31Z;
  - week 3: `fbd66fd`, 09-23T20:33:45Z;
  - week 4: `d43adc4`, 09-30T21:32:42Z.
- The only force-pushes on main were on 2026-07-11 and 07-17, before the season.
- `retrospective` remains specified as the fallback for any week whose ledger coverage is incomplete.
- The run inventory seed is saved beside the activity response, at `weekly-update-runs-2026-10-06T190201Z.json`.

**Page source and equivalence.** Since 2026-10-06 `weekly.html` renders from `site/data/neutral/weekly.json`. When
the selected commit also contains `site/data/neutral/weekly.json` from the same batch:

- The driver scores the neutral `stat_quantiles` in PPR with `ffmodel.site.leaguelens`, the Python reference that is
  parity-tested against the browser at weekly diff 0. Scoring uses `effective_weights` of the `sleeper_scoring` in
  `configs/formats/f12-1qb-ppr-4.yaml`, whose weights equal `scoring.PPR`. This was verified on 2026-10-06 on batch
  `2026-10-06T16:11:28Z`: across 1,974 values the maximum difference was 0.005, which is the legacy file's
  2-decimal rounding.
- It asserts `|neutral − legacy| ≤ 0.01` for every player and quantile.
- Any violation fails the run with the offending players listed. For commits without a neutral file (weeks 1–4) the
  legacy file was the page's source.

Git access goes through one injectable function, so tests feed a synthetic history.

### 4.2 Point metrics

The population is the played population ∩ valid projection rows. Unprojected players are counted, not imputed:
count, share and mean actual, by week and by position.

**Tier separation:** every pooled figure in §4.2–§4.4 is computed three ways, each labelled:

- `exact_push` weeks only, the headline;
- `retrospective` weeks only;
- all weeks, marked `mixed_evidence`.

Per-week rows carry their tier. The summary's headline line uses `exact_push` and states how many weeks the other
groups hold.

Metrics are reported per week, per position, and pooled:

- `n`, MAE of p50;
- mean and median of `actual − p50`; share of actuals above p50;
- p10–p90 coverage (inclusive), share below p10, share above p90;
- pinball loss at 0.1, 0.5 and 0.9.

**Naive baseline:** `NaiveLast4` semantics. The lag-4 stat means are scored in PPR. NaN falls back to the position
mean over feature rows with `season < S`; a position missing from the fallback is a validation error.

**Paired MAE delta:** `|actual − p50| − |actual − naive|`. Two intervals:

- clusters = `player_id`;
- clusters = `(week, team)`, a game-side shock.

Both are labelled conditional on the observed weeks.

**Reference values** are computed from `models/backtests/bakeoff.json` at run time: the n-weighted 2023–25
transformer MAE and naive MAE, and coverage per season, with the source path and its blob hash. They are labelled
**context**: the historical population and fallback history differ.

### 4.3 Ranking versus expert consensus

The pool is **played ∩ valid published projection ∩ valid expert row**. Retention is reported by week and position.

**Primary: our archived snapshots.** These are `data_snapshots/weekly_ecr/<S>-wNN-*.json` with `season == S` and
`week == N`; the week is inferred by `live_experts` from complete opponent agreement.

- **Content-existence bound:**
  - Find the archive's first-adding commit `C` by scanning the pinned main history for commits whose `C^1..C` diff
    adds the path.
  - `C` must be a `weekly-update-bot` commit that gets a §4.1 evidence tier. Two substitutions apply:
    - "adds this archive" replaces the `weekly.json`-change requirement, so archive-only refresh commits qualify;
    - the latest qualifying archive (below) replaces the latest week-N payload.
  - **`exact_push`:** a ledger push event to main whose `after` has `C` as an ancestor-or-self, timestamped before
    the cutoff. The ledger must cover the interval from that event to the cutoff. `available_by` is the event time.
  - **`retrospective`:** `C`'s committer time is before the cutoff, with the §4.1 inventory conditions.
    `available_by` is the committer time, labelled `committer_time_lower_bound`.
  - This bounds when the content existed in the main-line repository. It is **not** a capture time: retrieval may
    have been earlier. Archives strip `retrieved_at`, and their own note says date-only provenance.
  - The evaluated content is the blob at that commit (`git show C:path`). Its sha256 prefix must equal the
    filename's 16-hex digest under `live_experts`'s naming rule (sha256 of the encoded payload). A mismatch is a
    validation error.
- **Qualifying set:** archives with `season == S`, `week == N`, an evidence tier and `available_by` strictly before
  `K_N` 00:00 UTC.
- **Selection:** the qualifying archive with the latest `available_by`, the policy "latest first-committed
  qualifying content". If two or more archives share the latest `available_by` (for example, added in one commit),
  take the lexicographically first filename, and mark the choice `tie_break: "arbitrary_lexicographic"` in
  provenance.
- **Provenance:** every other member of the qualifying set is listed with its `available_by` and coverage.
- **Sensitivity:** recompute with each other member of the qualifying set, and only those, then report the range.
- **No qualifying archive:** the week is skipped and listed. For 2026, weeks 1–2 are expected to be skipped.

**Secondary: nflverse same-week.** The §5.2 rule applied to season S. It is reported separately, labelled by
source. Both sources are FantasyPros mirrors, not independent expert panels.

### 4.4 Snapshot-change diagnostics

These are conditional diagnostics, not causal decompositions. Content and source can change along with timing.

- **Live (A):** for each week that has both a selected archive and an old-protocol nflverse scrape
  (`weekly_snapshot`), intersect the two matched rankings with the week's three-way live pool. Score both expert
  lists and the identical published projections on exactly those IDs.
- **Historical (B):** for each (season, week) with both an old-protocol scrape and a selected same-week scrape:
  1. Intersect the two matched rankings with the date-eligible played rows and the model predictions (§5.2).
  2. Score both expert lists and the identical model predictions on exactly those IDs.
  3. Apply the same per-cell rule to both arms: at least 5 players and finite Spearman in both arms, otherwise the
     cell is dropped from both.
  4. Record the overlap losses by reason.

### 4.5 Operational runs versus the frozen reproduction

**Operational (rolling):** every run recomputes all `team_presence_complete` REG weeks of the season. The season is
`ffmodel.data.pull.current_nfl_season()`, which handles the January rollover.

**Frozen reproduction (acceptance, one time):**

- `--weeks 1-4 --frozen-record models/diagnostics/live_2026_w1-4_reproduction.json`.
- It records every input identity:
  - the publication SHAs and payload hashes;
  - the expert archive filenames and hashes;
  - the schedule, actuals and crosswalk content hashes;
  - the code commit;
  - the joined ID counts.
- **Against the scratch measurement:**
  - Point metrics are expected to match: MAE 4.359, coverage 0.797, naive MAE 4.673, delta −0.313.
  - The primary ranking is **expected to differ**: the scratch tie-break picked archive `…220d00155877a0a7`
    (325 players), while §4.3 selects `…5aec56b70c3784e6` (408 players, later evidenced availability).
  - Every divergence gets row-level accounting.
- Matching the scratch numbers never overrides a selection rule.

### 4.6 Output

`models/diagnostics/live_<S>_weekly.json` holds:

- `protocol_version`;
- `inputs`, every input identity and hash;
- `weeks_scored`, `weeks_skipped` with reasons, and per-week `publication` and `expert_snapshot` provenance;
- `points`, `ranking.primary`, `ranking.secondary`, `overlap_diagnostic`;
- `reference_context`;
- `caveats`.

Version identity in the main artifact:

- `evaluator_version`: `protocol_version` plus the sha256 of the three new module sources and of
  `src/ffmodel/data/rankings.py`, which holds `map_consensus_rows`;
- the selected publication shas, with their evidence records.

Neither the pinned main sha nor the report-writing HEAD is recorded there. The pinned sha moves with every commit,
including the report's own, so it lives in `run.json`. The main artifact is therefore invariant to report-only
commits.

Time-dependent fields live only in a separate `live_<S>_weekly.run.json`: `run_at`, `as_of_date`, the pinned main
sha, and each week's
`provisional` flag (§3.3, evaluated against `as_of_date`). That keeps them out of the main artifact. So identical
data inputs give a byte-identical main artifact, and a provisional-to-final change alone never creates a commit.

`models/diagnostics/live_<S>_weekly.md` is the human summary:

- the cumulative line;
- a per-week table: week, last game date `Z_N`, n, MAE, naive MAE, coverage, below/above, and ours vs consensus
  Spearman or "—". There is no provisional flag; that lives in `run.json`, so the summary has no time-dependent
  content;
- the caveats.

**CLI:** `python -m ffmodel.eval.live_accuracy --out models/diagnostics/live_2026_weekly.json`. Data is pulled into a
fresh temporary cache unless `--data-dir` is given.

### 4.7 Workflow — `.github/workflows/weekly-accuracy.yml`

- **Triggers:** `schedule` `47 16 * 9-12,1 2` (Tue 16:47 UTC) and `47 13 * 9-12,1 3` (Wed retry); also
  `workflow_dispatch`.
- **Concurrency:** `group: weekly-site-refresh`, `cancel-in-progress: false`. This is the same group as
  `weekly-update.yml`.
- **Setup:** checkout with `fetch-depth: 0`; Python 3.12; `pip install -e .`.
- **Steps:**
  1. Run the CLI.
  2. Stage only `models/diagnostics/live_*_weekly.json`, `live_*_weekly.md` and `main_push_ledger.json`. The
     `.run.json` is written but not committed.
  3. If there is no diff, exit 0.
  4. Otherwise commit `data: weekly accuracy refresh` and push, with up to 3 attempts of `git pull --rebase` and then
     push. Never force.
- **Fail-safe:** any error, the equivalence assertion or the alarm stops the job before the commit. The job never
  writes `site/`.
- **Permissions:** `contents: write`, `actions: read` (run inventory for §4.1; the activity API for the ledger). `GH_TOKEN: ${{ github.token }}` is set for `gh api`.

## 5. (B) Same-week reanalysis — primitives

### 5.1 Samples and models

| Sample | Seasons | Model | Old-protocol artifact |
|---|---|---|---|
| Discovery | 2023–2025 | ensemble `{v1, v1_s43, v1_s44}/through{S−1}` (`weekly_consensus.transformer_predictor`) | `weekly_consensus.json` |
| Replication | 2020–2022 | the same ensemble; folds through2019–2021 (`rb_oos_weekly.json.artifacts_evaluated`) | `rb_oos_weekly.json` |

Splits come from `walk_forward_splits`. The model side is unchanged from the original measurements.

### 5.2 Same-week scrape and population

For week N of season S:

- **Overlap guard:** if `Z_{N−1} ≥ K_N`, a week-(N−1) game was delayed into week N's dates. Week N is skipped with
  reason `overlapping_weeks`; no attribution is attempted. No such REG week exists in 2020–25 according to astra's
  check of the local schedule cache, so this is robustness only.
- **Window:** `L_N ≤ scrape_date < Z_N`.
  - `L_N` = `Z_{N−1}` + 1 day, the day after week N−1's last game. For week 1, `L_1 = K_1 − 7 days`.
  - The window is finite and inside the season, so it never reaches a later season.
  - It admits a pre-first-game scrape in a week whose first game is a Saturday or Sunday.
- **Selection uses metadata only, never outcomes.**
  - Candidates are the scrape dates in the window that pass two checks using only source and schedule metadata:
    - their §3.5 week state is not `contradicted`;
    - at least one week-N game has `gameday` strictly after the scrape date.
  - Take the latest candidate.
  - Actual appearance and stat lines are never consulted for selection, and there is no fallback. If the selected
    scrape yields an empty pool or no scorable cell, the week is skipped with reason `no_scorable_cell`.
  - Every candidate, including the ones not selected, is recorded.
- **Population:** played rows of week N whose player game date is **strictly after** the selected scrape date. This
  gives date-level safety for every retained player's outcome.
- **Matching:** consensus rows map to `player_id` through the §3.7 collision audit and `attach_gsis`. After the §2
  behaviour-preserving refactor, its matching is unchanged. The pool is the date-eligible played rows ∩ model predictions ∩ matched consensus. The model
  predicts every feature row, so predictions are always defined.
- **Retention reporting:** by season, week, position and game day; excluded early-game players; match rate.

**The estimand, stated in the artifact:** within-position ranking of players who recorded a stat line, were matched,
and had not yet played at the selected scrape date.

- The model's information cutoff is the end of week N−1.
- The experts' cutoff is the scrape date, which can include that week's earlier games and practice reports.
- The cutoffs are asymmetric. The net selection effect of excluding early games is **undetermined**, and no
  direction of bias is claimed.
- Old and new numbers are different estimands. The (B) snapshot-change diagnostic (§4.4) is reported on their
  overlap.

Postponed or rescheduled games use their actual schedule `gameday`.

## 6. (B) Pre-registered analysis and decision rules

Everything in this section is fixed before any (B) number is computed.

### 6.1 Units and weeks

A **cell** is a (season, week, position) with at least 5 pool players and a finite Spearman for both entrants.

**Week 1 is included** under the same policy as every other week.

- Week 1 has no prior-week byes, so its gate state is at best `unverified`, and it enters only the primary analysis
  (§6.4).
- A season's **target weeks** are all of its REG weeks, from the schedule. They form the sufficiency denominator.
- The original benchmark's lack of week-1 cells came from the old window having no scrape, not from model inputs:
  `build_sequences(min_history=0)` predicts every week-1 feature row.

### 6.2 Sufficiency (per sample)

- A sample is **sufficient for Rule 1** if, **in every season**, at least half of the target weeks have at least one
  cell in the primary analysis.
- A sample is **sufficient for Rule 2** if, **in every season**, at least half of the target weeks have an RB cell in
  the primary analysis.
- Sufficiency is checked first. `insufficient` takes precedence over every other outcome.

### 6.3 Statistics

All statistics use full precision (§3.8):

- `D` and `ci_week`, the primary interval;
- `D_season` for each season, and `wins` (the number of seasons whose `D_season` has the sign in question);
- the leave-one-season-out deltas `D_{−s}`;
- the **bye-consistent-only sensitivity**: `D` computed on `bye_consistent` weeks only, with its cell and season
  counts.

### 6.4 Treatment of unverified weeks

- **Primary analysis:** `bye_consistent` and `unverified` weeks. `contradicted` weeks are always skipped.
  `unverified` weeks are labelled `inferred_by_window`.
- **Sensitivity:** `bye_consistent` weeks only. It is reported beside every verdict, with its coverage.

### 6.5 Rules

A **directional check** for sign `σ` (+ or −) on a set of cells passes only if all of the following hold:

| # | Requirement | Reason code if it fails |
|---|---|---|
| (a) | `ci_week` lies strictly on the `σ` side of 0 | `interval_includes_zero` when `lo ≤ 0 ≤ hi` (touching intervals like `[0, b]` and `[0, 0]` included), else `interval_opposite_side` |
| (b) | at least 2 of the 3 seasons have `D_season` on the `σ` side | `season_inconsistent` |
| (c) | every leave-one-season-out `D_{−s}` is strictly on the `σ` side | `leave_one_season_out_reversal` (opposite sign) or `leave_one_season_out_zero` |
| (d) | the sensitivity exists (≥ 1 cell) and its `D` is on the `σ` side | `sensitivity_absent` or `sensitivity_disagrees` |

Every failed requirement's code is recorded, not just the first. The check is sign-symmetric.

**Rule 1, overall (Discovery sample)**, in order:

1. Not sufficient → `insufficient`.
2. The directional check for `−` passes → `behind`.
3. The directional check for `+` passes → `ahead`.
4. Otherwise → `not_established`, with the reason codes of the check whose sign matches `D`. If `D == 0` exactly,
   the reason is `zero_estimate`, and both checks' codes are reported.

There is no `tie` outcome. Parity would need a pre-specified equivalence margin, and none is claimed. The
Replication sample's overall result is reported with the same rule, computed descriptively.

**Rule 2, running-back edge (new rule, stricter than the original):**

- `insufficient` if either sample is insufficient for Rule 2.
- `established` iff the directional check for `+` on RB cells passes in **both** samples. Requirement (b) carries
  the original pre-registered season criterion from `rb_oos_weekly.json.pre_registered_rule`.
- Otherwise `not_established`, with the reason codes per sample.
- A failure is not evidence of an RB disadvantage, and no such claim is made.

**Rule 3:** QB, WR and TE are reported as numbers only.

**Multiplicity:** Rules 1 and 2 are two separate pre-specified claims, each at 95%. No family-wise correction is
applied. The artifact states this, and neither rule is added or waived after results are seen.

**Rule 4:** the result is reported as computed. If a defect is found after the run, it is fixed, the analysis is
re-run, and both results are published with the reason. No parameter in §3, §5 or §6 changes in response to a
result.

**Scope of any directional claim:** a passing verdict is bounded to week-resampling on these three observed seasons.
That bound appears in the public wording (§6.7), not only in the JSON.

### 6.6 Output

The driver computes the verdicts and reason codes in code, with no hand step, and writes
`models/diagnostics/weekly_consensus_sameweek.json`:

- `protocol_version`, and `protocol` (§§3, 5, 6 quoted);
- `inputs`, with hashes: the rankings cache, the schedules, the weekly actuals, the crosswalk and the model folds;
- for both samples:
  - overall, per_position, per_season;
  - leave-one-season-out results;
  - the sensitivity, with coverage;
  - per-week provenance: candidates, selected scrape, per-page gate states, pool sizes, exclusions and skips;
- `coverage` (§3.6), and the validation counts (§3.7);
- the (B) snapshot-change diagnostic (§4.4);
- the old-protocol numbers, read from the two old artifacts and labelled `different_estimand`;
- `old_protocol_staleness_audit`: for every 2020–25 week, the old protocol's scrape with its §3.5 state, taking `A`
  and `B` per the old week. Also the counts and the exact list of discriminating weeks (both `A` and `B` non-empty
  and different). This replaces the hand counts in §1 with a reproducible record;
- `verdicts: {rule_1: {value, reasons}, rule_2: {value, reasons_by_sample}}`.

### 6.7 Copy follow-through (owner approves before push)

| Verdict | Wording (bounded to: players who played; within position; FantasyPros consensus; these seasons) |
|---|---|
| `rule_1 = not_established` | "Against same-week expert rankings our estimate is D (95% CI …). A directional claim is not established under the pre-specified checks because <reason codes in words>." |
| `rule_1 = behind` / `ahead` | "Behind" / "ahead of" same-week expert consensus: D (95% CI …), in at least 2 of 3 seasons and in every leave-one-season-out estimate, on 2023–25 only (week-resampling conditional on these seasons; within-season serial dependence not modelled). |
| `rule_1 = insufficient` | "Not established: too little same-week data." |
| `rule_2 = established` | The RB edge is restated with the new numbers for both samples and the same bound, including the conditional-on-these-seasons and serial-dependence qualification. |
| `rule_2 = not_established` / `insufficient` | The RB edge is retracted, with the reasons in words. |

**Files:** `site/about.html` (the correction block and section), the `site/weekly.html` footer, and
`docs/methodology.md` §3 and §6. The original text stays visible as the record.

**Also fixed in the same edit:**

- c38e175's text that the stale list "was made before that week's games". It becomes "before that week's Sunday
  games", because the Friday scrape follows that week's Thursday game.
- `methodology.md`'s "13 discriminating weeks". It becomes the `old_protocol_staleness_audit` count and its
  definition.

## 7. Testing

All fixtures are synthetic. Each test is hand-computed where it asserts numbers.

### 7.1 `sameweek.py`

- **Window:** the `L_N` and `Z_N` bounds; week 1 (`L_1 = K_1 − 7`). The final REG week stays bounded: no
  next-season or postseason scrape is selected. A Saturday-first week admits the preceding Friday. An overlapping
  week is skipped with `overlapping_weeks`.
- **Selection (metadata only):**
  - the latest non-contradicted scrape with a later week-N game is selected;
  - a contradicted latest scrape is passed over in favour of the next one, using metadata only;
  - a selected scrape with an empty pool is skipped with `no_scorable_cell`, with no fallback;
  - a selected scrape with a non-empty but all-degenerate pool is also skipped with `no_scorable_cell`;
  - every candidate is recorded.
- **Population filter:** a Thursday game is excluded. A Saturday game is excluded with a Saturday scrape and kept
  with a Friday scrape. Postponed-game dates are honoured.
- **Gate truth table:**
  - stale on both counts → contradicted;
  - stale on `a` only with `B = ∅` → contradicted;
  - current on both counts → bye_consistent;
  - exact half → unverified;
  - no byes → unverified;
  - a mixed page set (RB stale, WR fresh) → contradicted;
  - a single mis-teamed row with one bye team → contradicted (documented strictness);
  - a stale page plus more than 2% unknown codes → still contradicted (the downgrade never erases a contradiction);
  - bye_consistent pages plus more than 2% unknown codes → unverified;
  - an absent page with `B ≠ ∅`, other pages bye_consistent → unverified (the absent page is not read as `b = 0`);
  - every page absent → unverified;
  - another week's page sharing the bye signature (`A = ∅`) → bye_consistent, documenting that this is not proof of
    identity;
  - alias codes map; an unknown code is counted and contributes no presence.
- **Regression record:** on the same synthetic data, `weekly_rankings.weekly_snapshot` selects the week-(N−1)
  scrape. `old_protocol_staleness_audit` lists it as contradicted.
- **Validation (§3.7):**
  - exact duplicates collapse before collision counting. Reconciliation with `gsis_collisions` uses the same
    duplicate-normalised frame, and invalidity masks are kept until collision groups and unions are counted;
  - conflicting duplicates invalidate the whole group, before features are built;
  - non-finite values in evaluated fields only;
  - inverted quantiles;
  - zero or duplicate schedule joins;
  - identity collisions via `map_consensus_rows`:
    - a tied pair (`ecr` 5, 5);
    - a group of three (5, 7, 9), where all three keys count;
    - two groups;
    - a collision overlapping another invalidity reason, counted once;
    - reconciliation with `gsis_collisions`, and a mismatch fails;
    - astra's 250-key case: 3/250 = 1.2% → `validation_failed`;
  - the `attach_gsis` refactor: identical output (frame and stats) before and after, on snapshots with ties,
    collisions, id/name/name-only matches and unmatched rows;
  - exactly 1% → pass; just above 1% → `validation_failed`;
  - one key failing several rules is counted once.

### 7.2 Statistics and rules

- `ci_week` resamples whole weeks: all positions of a week move together.
- Leave-one-season-out values.
- **Every Rule 1 branch, with reason codes:**
  - `D = −0.04`, CI `[−0.10, +0.02]` → `not_established` / `interval_includes_zero`, never a tie;
  - Rule 2 with RB CI wholly below 0 → `interval_opposite_side`;
  - `D == 0` → `zero_estimate` with both checks' codes;
  - a leave-one-season-out delta of exactly 0 → `leave_one_season_out_zero`;
  - the reachability example: three seasons of cell deltas in `[+0.02, +0.06]` plus a positive sensitivity →
    `ahead`, and the reflected case → `behind`;
  - CI excluding zero but one season win → `season_inconsistent`;
  - astra's construction (season deltas `+0.120, −0.010, +0.001`, CI above 0, 2 wins) → `not_established` /
    `leave_one_season_out_reversal`;
  - an empty sensitivity → `sensitivity_absent`;
  - an opposite-sign sensitivity → `sensitivity_disagrees`;
  - `behind` and `ahead` symmetric cases.
- **Rule 2:** each requirement failing in turn, in each sample; each sample insufficient in turn.
- **Sufficiency:** counted per season and per position. An RB-poor sample is sufficient for Rule 1 but not Rule 2.
  Week 1 is in the denominator, and a week-1 cell is scored when a valid same-week scrape exists.
- **Full-precision boundary:** a lower bound of `+0.00003` counts as above 0.
- **Alarm path:** a negative correlation → `alarm_negative_correlation`, no verdict.
- **Flags:** `n ≤ slots` cells are flagged.
- **Snapshot-change diagnostic:** both arms are scored on identical IDs, with the same degeneracy handling.

### 7.3 `live_accuracy.py`

- **Evidence tiers (synthetic ledger, inventory and history):**
  - **`exact_push`:**
    - a covered push to main with `after == C` before the cutoff → selected;
    - a push after the cutoff → not selected;
    - several events for one sha → the earliest; equal timestamps → ordered by `id`;
    - a newer publication push inside a coverage gap → not `exact_push`, and the older push is not promoted;
    - a `force_push` (to a non-bot target) in `[available_by, cutoff)` → `publication_evidence_unavailable`;
    - a force_push before `available_by`, or after the cutoff → no effect;
    - removal and later restoration of `C` by force-pushes inside the window → unavailable;
    - a ledger `after` sha that isn't available locally → unavailable.
  - **The commit-before / push-after case (astra R4-I1):** `C` is committed at 23:59:59 before the cutoff and
    pushed at 00:00:02 after it, and an older week-N publication was pushed earlier.
    - `exact_push` selects the older publication.
    - Under `retrospective`, `C` is selected but labelled with the unverified-timing estimand.
  - **Sibling case (R3-I1):** a feature-branch run's commit `F` is merged after the cutoff. There's no ledger push
    for `F` before the cutoff, and the inventory has a non-main run → `F` is never selected.
  - **`retrospective` conditions:**
    - an incomplete fetch fails the job and writes nothing;
    - the partition path when `total_count ≥ 1000`;
    - a run observed with `run_attempt > 1` (including a re-run that started after the cutoff) → withdrawn, and
      recorded in `evidence_revisions`;
    - a run deleted upstream but kept in the retained inventory → still counted;
    - no `main` run with `head_sha == C^1` → unavailable;
    - a rebased bot commit → unavailable (disclosed);
    - equal committer timestamps → `arbitrary_sha`.
  - **Commit filters:** a hand-made commit → rejected; a commit that doesn't change `weekly.json` in `C^1..C` → not
    a projection candidate.
  - **Week labels:** `publication_evidence_unavailable` is kept distinct from `weeks_unpublished`.
  - **Ledger and inventory merges:** append-only by id, the coverage-interval union, deterministic order.
  - **Tier separation:** three pooled figures; the headline uses `exact_push`.
- **Cutoff:** strict `<` on `available_by`; the newest qualifying commit wins; a wrong-week payload is skipped;
  `weeks_unpublished`.
- **Neutral/legacy equivalence:** passes within 0.01; a divergence fails, listing the players.
- **Expert archives:**
  - selection by the latest `available_by`;
  - a late-added archive with an old `snapshot_at` → excluded;
  - two archives in one commit → lexicographic choice, flagged `arbitrary_lexicographic`;
  - the sensitivity uses only the qualifying set;
  - a content-hash/filename mismatch → validation error;
  - the content is read from the binding commit, not the working tree.
- **Points:**
  - hand-computed metrics;
  - the naive fallback; a missing-position fallback raises;
  - lags strictly shifted, so no future actual reaches a naive value;
  - player-cluster and (week, team)-cluster intervals.
- **Ranking pool:** the three-way intersection; a week with no RB coverage; empty and all-degenerate cells.
- **Live snapshot-change diagnostic:** both arms are scored on identical IDs.
- **Determinism:**
  - identical inputs → a byte-identical main artifact and summary;
  - `run.json` alone differs;
  - a report-only commit in between → no change;
  - crossing the provisional age → `run.json` changes only.
- **Presence:** a week missing a team's rows is skipped (`team_presence_complete`).
- **Markdown:** the summary renders.

### 7.4 Acceptance

- `pytest -W error` and all `tests/*_fixture.cjs` pass, locally and in CI.
- The frozen reproduction record (§4.5) is produced, and every divergence from the scratch numbers is accounted for
  at row level.

## 8. Rollout

1. **Reviews:** astra re-reviews this spec, then reviews the plan.
2. **Build:** subagent-driven, with Sonnet implementers and task reviews, and an Opus final review. The numerics and
   leak-surface tasks get Opus reviewers.
3. **Merge:** code, workflow and tests only; no site data and no frozen paths. The owner OKs the push.
4. **First live run:** dispatch `weekly-accuracy.yml` once by hand and check its artifact against the frozen
   reproduction.
5. **Reanalysis:** run (B) locally once, commit the artifact, and report the verdicts and full numbers to the owner.
6. **Copy:** apply §6.7, with the owner's OK before the push.

## 9. Risks and limits (stated, not solved)

- No tier verifies Vercel deployment.
- `retrospective` weeks (none expected in 2026) would not verify that the content was on main before the cutoff. Committer time
  is a lower bound on the push. These weeks are reported apart from `exact_push` weeks.
- Runs deleted upstream before our first inventory fetch are undetectable.
- `available_by` bounds when content existed on main; it is not a retrieval time.
- `bye_consistent` is compatibility with week N, not proof of identity, and `unverified` weeks rest on the window
  assumption.
- Three seasons per sample, and serial dependence within a season is not modelled.
- Both expert sources mirror FantasyPros.
- The historical data vintage is today's nflverse cache. It is hashed, but it is not the vintage available
  in-season.
- (B) reanalyses data that has already been looked at, so it is a correction, not an untouched replication.

## 10. Review trace

### Draft 1 → draft 2 (astra round 1)

| Finding | Resolution |
|---|---|
| C1 publication evidence | §4.1 (draft 3 strengthens it, see N2) |
| C2 tie fallacy | §6.5: no tie outcome; §6.7 wording |
| I1 gate | §3.4–3.5 (draft 3 orders it, see N1) |
| I2 window | §5.2 (draft 3 removes the outcome-based fallback, see N4) |
| I3 dependence | §3.8 `ci_week` (draft 3 puts leave-one-season-out into the rules, see N6) |
| I4 sufficiency and RB rule | §6.1–6.2, §6.5 |
| I5 estimand | §5.2, §4.3, §4.4 (draft 3 defines the historical diagnostic, see N8) |
| I6 archive provenance | §4.3 (draft 3: content-existence bound, binding and ties, see N3) |
| I7 completeness and context | §3.3, §3.7 (draft 3 makes it precise, see N7), §4.2 |
| I8 reproduction | §4.5 |
| M1 cadence and schema | §1, §3.6, §6.7 |
| M2 determinism | §4.6 (draft 3, see M4) |
| M3 alarm | §3.9 |

### Draft 2 → draft 3 (astra round 2)

| Finding | Resolution |
|---|---|
| N1 gate precedence and positive state | §3.5 ordered steps 1–4; the downgrade never erases a contradiction; `bye_consistent` naming and meaning; §7.1 fixtures |
| N2 main-line proof | §4.1 Actions-run binding (`head_branch == main`, `head_sha == C^1`, success, `available_by = updated_at`); `main_sha` pinned; `C^1..C` diff; §7.3 merged-after-cutoff fixture |
| N3 archive capture | §4.3 `available_by` as a content-existence bound; blob from the binding commit; hash validation; deterministic flagged tie-break; sensitivity restricted to the qualifying set |
| N4 outcome-based fallback | §5.2 selection by metadata only; no fallback; `no_scorable_cell`; overlap guard |
| N5 week 1 | §6.1: included under the same policy; rationale corrected |
| N6 robustness and wording | §6.5 directional check (a)–(d) with leave-one-season-out and reason codes; an absent sensitivity blocks the claim; §6.7 wording carries the reasons and the scope bound |
| N7 validation precision | §3.7 per-table denominators, group invalidation, pre-feature checks, two-call collision audit, an exact-1% boundary |
| N8 historical overlap diagnostic | §4.4 (B)-specific definition |
| M4 implicit time inputs | §4.6 `evaluator_version`, `main_sha`; provisional only in `run.json`; the summary has no time-dependent content |
| M5 the 13-week count | §6.6 `old_protocol_staleness_audit` with definition and list; §6.7 copy uses it |

### Draft 3 → draft 4 (astra round 3)

| Finding | Resolution |
|---|---|
| R3-I1 parent ≠ output (sibling commit) | §4.1 two tiers. `exact_push` uses an activity-API push with `after == C`, persisted in a committed ledger. `inventory_proxy` needs a complete run inventory with no non-main runs and no re-runs before the cutoff. Neither → `publication_evidence_unavailable`. §7.3 sibling fixture |
| R3-I2 mutable evidence set | §4.1: all statuses and attempts; a completeness check against `total_count`, with date partitioning at 1000 or more; re-runs make the proxy unavailable; evidence recorded per week; ledger append-only; rebase shape disclosed; §7.3 fixtures |
| R3-I3 lossy collision audit | §2 `map_consensus_rows` refactor (byte-identical `attach_gsis`); §3.7 whole-group invalidation, ties included, reconciliation with `gsis_collisions`; §7.1 fixtures |
| Minor: `main_sha` churn | §4.6: the pinned sha lives only in `run.json` |
| Minor: reason codes | §6.5 `interval_opposite_side`, `zero_estimate`, `leave_one_season_out_zero` |
| Minor: public qualification | §6.7 wording carries "at least 2 of 3 seasons and every leave-one-season-out estimate" and the conditional / serial-dependence bound |
| Minor: duplicate definition | §3.7 exact duplicates also require identical eligibility, join and grouping fields; the empty-table fraction is defined |
| Minor: provenance wording | §4.5 "later evidenced availability"; §4.3 archive-only commits qualify, using the "adds this archive" requirement |

### Draft 4 → draft 5 (astra round 4)

| Finding | Resolution |
|---|---|
| R4-I1 committer time is a lower bound | §4.1: the old proxy is replaced by the `retrospective` tier. Its estimand is "committed before the cutoff, found on main later; pre-cutoff availability unverified", and committer time is labelled a lower bound. `exact_push` needs a ledger push before the cutoff. The tiers are never pooled (§4.2). §7.3 commit-before / push-after fixture |
| R4-I2 mutable negative evidence | §4.1: the retained, merge-only `weekly_update_run_inventory.json` with fetch records, the maximum `run_attempt` observed, the supporting run set (no producer claim), `evidence_revisions`, and the stated no-pre-fetch-deletion assumption. §7.3 fixtures |
| R4-I3 ledger filtering and coverage | §4.1: the ledger keeps every main ref event (no author filter) plus coverage intervals. `exact_push` needs coverage from the push to the cutoff. Force-push policy over `[available_by, cutoff)`; candidates include ledger `after` shas; no promotion across gaps. §7.3 fixtures |
| M1 reconciliation stage | §7.1: the duplicate-normalised frame is used for both paths, and masks are kept until counted |
| M2 touching-zero intervals | §6.5: `lo ≤ 0 ≤ hi` |
| M3 timestamp ties | §4.1: the earliest event per sha, events ordered by `id`; `arbitrary_sha` for the retrospective tier |
| M4 provenance alignment | §5.2 wording; `evaluator_version` includes `rankings.py`; §9 tier wording |
