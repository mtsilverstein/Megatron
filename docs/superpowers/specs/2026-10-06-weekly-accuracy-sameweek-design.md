# Weekly accuracy tracking and same-week expert benchmark — design

**Status:** draft 2 (2026-10-06). The owner approved the design section by section in conversation. Draft 1 got
REVISE from astra (`.review/astra-weeklyacc-spec-response.md`), and every finding is addressed here; §10 maps each
finding to the section that answers it. Draft 2 awaits an astra re-review and the owner's review.

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

- My check: 13 of 13 discriminating 2023–25 weeks showed the stale pattern.
- Astra's independent check, under a stricter definition of "discriminating": 17 of 17 stale, 0 current. The
  stricter definition requires both adjacent weeks to have non-empty, different bye sets.
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
- Tests, and the committed artifacts.
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

**Provisional data:** scores for a week whose `Z_N` is less than 8 days before the run date are labelled
`provisional`. The live artifact is recomputed from scratch on every run, so later stat corrections replace
provisional values. Each run records the actual-data input hashes (§4.6), which makes revisions traceable.

### 3.4 Team-code normalisation for rankings

One explicit mapping, applied to `normalize_weekly_rankings` team values before any comparison with schedule teams:

```
{"JAC": "JAX", "LA": "LAR", "STL": "LAR", "SD": "LAC", "OAK": "LV", "WSH": "WAS", "ARZ": "ARI", "BLT": "BAL",
 "CLV": "CLE", "HST": "HOU", "KCC": "KC", "GBP": "GB", "NOS": "NO", "NEP": "NE", "SFO": "SF", "TBB": "TB", "LVR": "LV"}
```

Codes that are blank or `FA` are ignored for team presence. Any other code not among the season's schedule teams
after mapping is counted under `unknown_team_codes` and reported. It never contributes presence. If unknown codes
exceed 2% of a snapshot's rows, the snapshot's identity is `unverified` (§3.5).

### 3.5 Week-identity gate (tri-state)

For a scrape assigned to week N, evaluate each position page separately:

- `P ∈ {QB, RB, WR, TE}`;
- `R_P` = the set of mapped teams present on page P;
- `A` = the teams on bye in week N;
- `B` = the teams on bye in week N−1 (for week 1, `B = ∅`).

With `a = |A ∩ R_P| / |A|` (when `A ≠ ∅`) and `b = |B ∩ R_P| / |B|` (when `B ≠ ∅`), each page is:

- **contradicted** if `a > 0.5` or `b < 0.5`;
- **identified** if it is not contradicted, at least one of `a`, `b` is defined, and every defined value is strictly
  on the current side (`a < 0.5`, `b > 0.5`);
- **unverified** otherwise: no byes on either side, or an exact half.

Per week:

- **contradicted** if any page is contradicted;
- **identified** if all four pages are identified;
- **unverified** otherwise, including a missing page.

A week-N ranking omits week-N byes and lists week-(N−1) byes; a stale one shows the reverse. Presence is judged per
team and per page, so a fresh page cannot mask a stale one, and one unranked depth player cannot flip a count. These
thresholds are fixed now, before any accuracy delta is seen.

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

Each case below is an error with a count. A row that fails is excluded and listed, never imputed:

- duplicate `(season, week, player_id)` in actuals, projections or a consensus snapshot (the duplicates are dropped);
- non-finite values;
- quantiles not ordered `p10 ≤ p50 ≤ p90`;
- a missing or duplicate schedule join.

If more than 1% of a week's rows are excluded for these reasons, that week is skipped with reason
`validation_failed`.

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

### 4.1 Projection: repository proxy for what was published

The estimand is the projection in the main-line data pipeline's latest publication before the week's cutoff. It is
labelled `evidence: "repo_proxy"`, because Vercel deployment success and time are not verified. The site deploys main
on push, so this is a close proxy, not proof.

- **Candidates:** commits that touch `site/data/weekly.json` and whose author and committer are both
  `weekly-update-bot`. That workflow pushes straight to `main`, so its commits were on main at their committer time.
  Hand-made and feature-branch commits are never candidates. Enumerate with
  `git log --all --author=weekly-update-bot --format="%H %an %cn %cI" -- site/data/weekly.json`, then keep only
  commits that are ancestors of `origin/main` (`git merge-base --is-ancestor`).
- **Cutoff:** committer time strictly before `K_N` 00:00 UTC. This is a common pre-week cutoff for every player. It
  is conservative by up to one day and symmetric with the date-level expert snapshots. It is not a per-player
  latest-before-game publication.
- **Selection:** take the newest candidate whose payload has `season == S` and `week == N`.
- **Fields:** `players[].points.ppr.{p10,p50,p90}` by `player_id`.
- **No candidate:** the week is listed under `weeks_unpublished`.

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

- **Capture evidence:** the archive's first-adding commit (`git log --diff-filter=A`), which must be a
  `weekly-update-bot` commit on `origin/main`. The archives strip `retrieved_at`, and their own note says date-only
  provenance. So capture time = the first-adding commit's committer time, labelled `capture: "first_commit"`.
- **Selection:** the latest-captured archive with capture time strictly before `K_N` 00:00 UTC. Ties cannot occur,
  because commit times are distinct.
- **Provenance:** every other qualifying archive is listed with its capture time and coverage.
- **Sensitivity:** recompute with each other same-week archive whose `snapshot_at` date equals the selected one's,
  and report the range.
- **No archive:** the week is skipped and listed. For 2026, weeks 1–2 are expected to be skipped.

**Secondary: nflverse same-week.** The §5.2 rule applied to season S. It is reported separately, labelled by
source. Both sources are FantasyPros mirrors, not independent expert panels.

### 4.4 Old-versus-new overlap diagnostic

For weeks with both an archived same-week snapshot and an old-protocol scrape, score both rankings on the identical
retained player IDs. This separates the timing effect from the population change, and it is a conditional diagnostic
only.

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
    (325 players), while §4.3 selects `…5aec56b70c3784e6` (408 players, later capture).
  - Every divergence gets row-level accounting.
- Matching the scratch numbers never overrides a selection rule.

### 4.6 Output

`models/diagnostics/live_<S>_weekly.json` holds:

- `protocol_version`;
- `inputs`, every input identity and hash;
- `evaluated_commit`;
- `weeks_scored`, `weeks_skipped` with reasons, and per-week `publication` and `expert_snapshot` provenance;
- `points`, `ranking.primary`, `ranking.secondary`, `overlap_diagnostic`;
- `reference_context`;
- `caveats`.

`run_at` lives only in a separate `live_<S>_weekly.run.json`, so identical inputs give a byte-identical main
artifact.

`models/diagnostics/live_<S>_weekly.md` is the human summary:

- the cumulative line;
- a per-week table: week, n, MAE, naive MAE, coverage, below/above, ours vs consensus Spearman or "—", and a
  provisional flag;
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
  2. Stage only `models/diagnostics/live_*_weekly.json` and `.md`. The `.run.json` is written but not committed.
  3. If there is no diff, exit 0.
  4. Otherwise commit `data: weekly accuracy refresh` and push, with up to 3 attempts of `git pull --rebase` and then
     push. Never force.
- **Fail-safe:** any error, the equivalence assertion or the alarm stops the job before the commit. The job never
  writes `site/`.
- **Permissions:** `contents: write`.

## 5. (B) Same-week reanalysis — primitives

### 5.1 Samples and models

| Sample | Seasons | Model | Old-protocol artifact |
|---|---|---|---|
| Discovery | 2023–2025 | ensemble `{v1, v1_s43, v1_s44}/through{S−1}` (`weekly_consensus.transformer_predictor`) | `weekly_consensus.json` |
| Replication | 2020–2022 | the same ensemble; folds through2019–2021 (`rb_oos_weekly.json.artifacts_evaluated`) | `rb_oos_weekly.json` |

Splits come from `walk_forward_splits`. The model side is unchanged from the original measurements.

### 5.2 Same-week scrape and population

For week N of season S:

- **Window:** `L_N ≤ scrape_date < Z_N`.
  - `L_N` = `Z_{N−1}` + 1 day, the day after week N−1's last game. For week 1, `L_1 = K_1 − 7 days`.
  - The window is finite and lies inside the season, so it never reaches a later season.
  - It also admits a pre-first-game scrape in a week whose first game is a Saturday or Sunday.
- **Candidates:** every scrape date in the window whose week-N identity (§3.5) is not contradicted, and whose
  eligible pool (below) is non-empty after matching.
- **Selection:** the **latest** such candidate. If the latest scrape is contradicted or has an empty pool, fall back
  to the next-latest; every candidate is recorded.
- **Population:** played rows of week N whose player game date is **strictly after** the scrape date. This applies
  date-level safety to every retained player's outcome.
- **Matching:** consensus rows map to `player_id` via `attach_gsis(snapshot, crosswalk)`, unchanged. The pool is
  played-eligible ∩ projection ∩ consensus. Projections are always defined in (B), because the model predicts every
  feature row.
- **Retention reporting:** by season, week, position and game day; excluded early-game players; match rate.

**The estimand, stated in the artifact:** within-position ranking of players who recorded a stat line, were matched,
and had not yet played at the scrape date. The model's information cutoff is the end of week N−1. The experts' is
the scrape date, which can include Thursday's game and practice reports. The cutoffs are asymmetric, and the net
selection effect of excluding early games is **undetermined**. The old and new numbers are different estimands, and
§4.4's overlap diagnostic is reported for the overlap.

Postponed or rescheduled games use their actual schedule `gameday`. A week whose games span another week's window is
handled by the per-player game-date filter; nothing else is special-cased.

## 6. (B) Pre-registered analysis and decision rules

Everything in this section is fixed before any (B) number is computed.

### 6.1 Units

A **cell** is a (season, week, position) with at least 5 pool players and a finite Spearman for both entrants.

A season's **scorable weeks** are its REG weeks minus week 1. Week 1 has no prior-week byes, and the original
benchmark's model inputs start at week 2. The denominator is computed from the schedule.

### 6.2 Sufficiency (per sample)

A sample is **sufficient for Rule 1** if, **in every season**, at least half of the scorable weeks have at least one
cell.

A sample is **sufficient for Rule 2** if, **in every season**, at least half of the scorable weeks have an RB cell.

Sufficiency is checked first. An insufficient sample yields `insufficient` and takes precedence over every other
outcome.

### 6.3 Statistics

All statistics are computed in full precision, as in §3.8. Inputs:

- `D` and `ci_week` (primary);
- `wins` = the number of seasons with `D_season > 0`;
- the leave-one-season-out deltas.

### 6.4 Treatment of unverified weeks

- **Primary analysis:** identified and unverified weeks; contradicted weeks are always skipped. Unverified weeks are
  labelled `inferred_by_window`.
- **Sensitivity:** identified weeks only. It is reported beside every verdict. If the primary verdict and the
  sensitivity's sign disagree, the verdict is downgraded (Rules 1 and 2).

### 6.5 Rules

**Rule 1, overall (Discovery sample)**, in order:

1. Not sufficient → `insufficient`.
2. `ci_week` lies entirely below 0, at least 2 of 3 seasons have `D_season < 0`, and the identified-only
   sensitivity has `D < 0` → `behind`.
3. `ci_week` lies entirely above 0, at least 2 of 3 seasons have `D_season > 0`, and the sensitivity has `D > 0` →
   `ahead`.
4. Otherwise → `inconclusive`.

There is no `tie` outcome. Parity would need a pre-specified equivalence margin, and none is claimed.

The Replication sample's overall result is reported as numbers, with the same rule computed descriptively.

**Rule 2, running-back edge (new rule, stricter than the original):**

- `established` iff, in **both** samples, all of these hold for RB:
  - the sample is sufficient for Rule 2;
  - RB `ci_week` lies entirely above 0;
  - RB `wins ≥ 2` of 3 (the original pre-registered criterion, from `rb_oos_weekly.json.pre_registered_rule`);
  - the identified-only RB `D > 0`.
- `insufficient` if either sample is insufficient for Rule 2.
- Otherwise `not_established`.

**Rule 3:** QB, WR and TE are reported as numbers only. No claim is made about them.

**Multiplicity:** Rules 1 and 2 are two separate pre-specified claims, each at 95%. No family-wise correction is
applied. The artifact states this, and neither rule is added or waived after results are seen.

**Rule 4:** the result is reported as computed. If a defect is found after the run, it is fixed, the analysis is
re-run, and both results are published with the reason. No parameter in §3, §5 or §6 changes in response to a result.

### 6.6 Output

The driver computes the verdicts in code, with no hand step, and writes `models/diagnostics/weekly_consensus_sameweek.json`
containing:

- `protocol_version`, and `protocol` (this section, quoted);
- `inputs`, with hashes;
- for both samples:
  - overall, per_position, per_season;
  - leave-one-season-out results;
  - the identified-only sensitivity;
  - per-week provenance: candidates, the selected scrape, gate states per page, pool sizes and exclusions;
  - skips;
- `coverage`, from §3.6;
- the overlap diagnostic (§4.4) on the overlapping weeks;
- the old-protocol numbers, read from the two old artifacts and labelled `different_estimand`;
- `verdicts: {rule_1, rule_2}`.

### 6.7 Copy follow-through (owner approves before push)

| Verdict | Wording |
|---|---|
| `rule_1 = inconclusive` | "Against same-week expert rankings, the difference is not statistically resolved (delta D, 95% CI …)" |
| `rule_1 = behind` / `ahead` | "behind" / "ahead of" same-week expert consensus, with D and CI |
| `rule_1 = insufficient` | "not established — too little same-week data" |
| `rule_2 = established` | the RB edge is restated with the new numbers |
| `rule_2 = not_established` or `insufficient` | the RB edge is retracted |

**Files:** `site/about.html` (the correction block and section), the `site/weekly.html` footer, and
`docs/methodology.md` §3 and §6. The original text stays visible as the record. The wording is bounded to the
estimand (players who played; within-position; FantasyPros consensus).

c38e175's correction text also gets this fix: the stale list "was made before that week's Sunday games and
injuries". The Friday scrape follows that week's Thursday game, so it is not before *all* of that week's games.

## 7. Testing

All fixtures are synthetic. Each test is hand-computed where it asserts numbers.

### 7.1 `sameweek.py`

- **Window:** `L_N` / `Z_N` bounds; week 1; the final REG week stays bounded (no next-season scrape is selected);
  a Saturday-first week admits the preceding Friday.
- **Selection:** latest candidate; fallback when the latest is contradicted; fallback when the latest has an empty
  pool; every candidate is recorded.
- **Population filter:** a Thursday game is excluded. A Saturday game is excluded with a Saturday scrape and kept
  with a Friday scrape. Postponed-game dates are honoured.
- **Gate:**
  - stale on both counts → contradicted;
  - stale on `a` only with `B = ∅` → contradicted;
  - current on both counts → identified;
  - exact half → unverified;
  - no byes → unverified;
  - a mixed page set (RB stale, WR fresh) → contradicted;
  - a single mis-teamed row with one bye team → contradicted (documented strictness);
  - alias codes map correctly;
  - an unknown code is counted and contributes no presence;
  - more than 2% unknown → unverified.
- **Regression record:** on the same synthetic data, `weekly_rankings.weekly_snapshot` selects the week-(N−1)
  scrape.
- **Validation:** duplicates, non-finite values, inverted quantiles and bad schedule joins are each counted and
  excluded; above the 1% threshold the week is skipped.

### 7.2 Statistics and rules

- `ci_week` resamples whole weeks: all positions of a week move together.
- Leave-one-season-out output.
- Every Rule 1 branch, including: CI excluding zero but `wins = 1` → inconclusive; sensitivity sign disagreement →
  inconclusive; `D = −0.04`, CI `[−0.10, +0.02]` → inconclusive, never a tie.
- Rule 2 with each conjunct failing in turn, and each sample insufficient in turn.
- Sufficiency counted per season and per position. An RB-poor sample is sufficient for Rule 1 but not Rule 2.
- Full-precision boundary: a lower bound of `+0.00003` counts as above 0, the same verdict in code paths that round
  only for display.
- Alarm path: a negative correlation → `alarm_negative_correlation`, no verdict.
- n ≤ slots cells are flagged.

### 7.3 `live_accuracy.py`

- **Candidate filter:** a branch-only commit with an early timestamp is rejected; a hand-made commit is rejected; a
  bot commit not on `origin/main` is rejected.
- **Cutoff:** strict `<`. A commit on `K_N` day is excluded; the newest qualifying commit wins; a wrong-week payload
  is skipped; `weeks_unpublished`.
- **Neutral/legacy equivalence:** passes within 0.01; a divergence fails with the players listed.
- **Expert archive selection:** by first-add capture time; a late-added archive with an old `snapshot_at` is
  rejected after cutoff; two same-date archives → the later capture is selected and the other is reported in the
  sensitivity.
- **Points:** hand-computed metrics; naive fallback; a missing-position fallback raises; no future actuals affect
  the naive values (lags strictly shifted).
- **Ranking pool:** the three-way intersection; a week with no RB coverage; empty and all-degenerate cells.
- **Overlap diagnostic:** both rankings are scored on identical IDs.
- **Determinism:** two runs on identical inputs give a byte-identical main artifact. The `run.json` differs.
- **Presence/provisional:** a week missing a team's rows is skipped; provisional labelling.
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

- `repo_proxy` is not a verified Vercel deployment record.
- Three seasons per sample is a thin basis for any interval.
- Both expert sources mirror FantasyPros.
- The historical data vintage is today's nflverse cache. Its hashes are recorded, but it is not the vintage
  available in-season.
- (B) reanalyses data that has already been looked at, so it is a correction, not an untouched replication.

## 10. Review trace (astra, draft 1 → draft 2)

| Finding | Resolution |
|---|---|
| C1 publication evidence | §4.1: bot-only commits on `origin/main`, labelled `repo_proxy`; neutral/legacy equivalence assertion; common-cutoff estimand stated |
| C2 tie fallacy | §6.5: no `tie` outcome; `inconclusive`; §6.7 wording |
| I1 gate | §3.4 explicit mapping and unknown codes; §3.5 tri-state, per page; §6.4 primary vs identified-only |
| I2 window | §5.2: finite `[L_N, Z_N)` window; fallback selection; Saturday/Sunday-first weeks |
| I3 dependence | §3.8: `ci_week` primary; season deltas, wins and leave-one-season-out in the rules |
| I4 sufficiency and RB rule | §6.1–6.2: per-season, per-position sufficiency; Rule 2 includes the original 2/3 criterion and is labelled new; full precision; multiplicity statement |
| I5 estimand | §5.2 estimand statement; §4.3 three-way pool; §4.4 overlap diagnostic; hit-rate flags |
| I6 expert archive provenance | §4.3: first-add commit time; same-date sensitivity |
| I7 completeness and context | §3.3 `team_presence_complete` and provisional; §3.7 validation; §4.2 references from the artifact (4.32), tails reported |
| I8 reproduction | §4.5: frozen record with input identities; expected divergence named |
| M1 cadence and schema | §1 "predominantly"; §3.6 coverage and the legacy-schema exclusion; §6.7 copy fix |
| M2 determinism | §4.6: `run.json` split; input hashes; `current_nfl_season` |
| M3 negative-correlation alarm | §3.9: alarm with audit and status; never auto-corrected |
