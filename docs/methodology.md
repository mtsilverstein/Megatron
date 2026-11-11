# Methodology & honest results

A fantasy-football projection model is easy to build and hard to trust. This
document is the trust part: what the model is, how it is evaluated, where it
genuinely stands against the alternatives a real drafter has, and — at least
as important — what was tried and *didn't* work, with the reason in each case.

Every model number here is measured walk-forward on held-out seasons the model
never trained on. No model hyperparameter was fitted on those seasons: the
hyperparameter sweep validates on the 2022 fold only. Several design choices
were made after 2023–25 results had been seen, though, and are reported on
those same seasons: the decision to calibrate the bands, the redefinition of
the band construction, the 3-seed ensemble, the week-to-week correlation in the
season simulation, the rejection of feature pack v2 and the decision to order
the draft board by expert consensus. Those numbers are not first-look
out-of-sample results. Where a result is within statistical noise, it is
reported as within noise rather than rounded into a win.

---

## 1. What the model is

A small quantile [transformer](../src/ffmodel/model/net.py) (≈343 K
parameters: `d_model` 96, 3 layers, 4 heads) trained on a free Kaggle T4. For
each player-week it reads the player's previous 16 games and predicts the
**raw stat line** — passing/rushing/receiving yards, touchdowns, receptions,
interceptions, fumbles — as **three quantiles (p10 / p50 / p90) per component**
via pinball loss. Fantasy points are then computed from the predicted stats by
pure scoring functions, so PPR is the default and half-PPR / standard derive
for free, and the p10/p90 stat quantiles become sign-coherent **floor and
ceiling point bands**.

The published points p50 is the score of the p50 stat line, a sum of per-stat
medians. A sum of medians is not the median of the sum, so the p50 is not the
median of a player's points: for players projected at 8 or more points, 60% of
outcomes landed above it (measured on the live 2026 record through week 8,
7 November 2026). It
works for ranking players within a position; as an absolute total (a lineup
against an opponent, a FAAB price) it runs low for starters.

Design commitments that shape everything below:

- **Raw stats, never points directly.** Points are a deterministic function of
  the stat line, so the model never has to relearn the scoring system.
- **Walk-forward evaluation only.** Train on seasons ≤ S, test on S+1; the
  held-out years are 2023, 2024, 2025. Random train/test splits are forbidden
  — the rolling features would leak the future into the past.
- **Free tiers only.** Training on Kaggle (30 GPU-h/week), weekly inference and
  publishing on GitHub Actions, the static site hosted on Vercel. No paid
  infrastructure, ever.
- **Baselines run through the identical harness** — a naive last-4-game average
  and XGBoost, with a squared-error and a median objective — and results are
  reported honestly whichever wins.

## 2. How claims are kept honest

Two failure modes dominate sports-modeling writeups: leakage (using
information that wasn't available at prediction time) and the garden of
forking paths (trying many things and reporting the one that looked good). The
project guards against both explicitly:

- **Pre-registration.** Every gated experiment's success criterion is written
  down — in the project ledger, before the result is seen — and the verdict is
  read off that criterion afterward. Several experiments below *passed the
  letter* of a criterion and were still declined because the effect was within
  noise. Diagnostics, which gate nothing (the ≥8-game cut in §3 is one), are
  labelled as diagnostics rather than tests.
- **Adversarial review.** Substantive changes are reviewed by an independent
  pass whose job is to break the claim. That pass has repeatedly earned its
  keep — see §5.
- **Significance, not point estimates.** With only three held-out seasons, a
  season-level accuracy delta is noisy: feature pack v2's had a standard error
  of 0.028 across seasons (`models/diagnostics/feature_pack_v2_gate.json`) —
  wide enough that most "improvements" are indistinguishable from zero.
  Comparisons use paired per-row tests and bootstrap confidence intervals, not
  eyeballed means.

## 3. Where the model actually stands

### It ties a properly specified XGBoost on point accuracy

Walk-forward weekly PPR mean absolute error, pooled over the 17,908
player-weeks of 2023–25 (`models/backtests/bakeoff.json`; the median-objective
entrant is in `models/backtests/xgb_median/bakeoff_xgb_median.json`):

| model | weekly PPR MAE |
|---|---|
| naive last-4 average | 4.612 |
| XGBoost, squared-error objective (a mean predictor, single seed) | 4.448 |
| XGBoost, median objective (3-seed ensemble) | 4.326 |
| quantile transformer (3-seed ensemble) | 4.325 |

The transformer's point prediction is a median (its p50 head is trained with
pinball loss), and MAE rewards a median. The committed XGBoost baseline uses
XGBoost's default squared-error objective, so it predicts means; nearly all of
its 0.12-point deficit is that objective. Given a median objective (pinball
loss at 0.5) and nothing else changed — same frozen features, same
hyperparameters, identical rows, seeds 0–2 averaged row by row — XGBoost ties
the transformer: a paired difference of −0.0010 points per player-week, 95%
interval [−0.0213, +0.0189] (season-week cluster bootstrap,
`models/backtests/xgb_median/paired_xgb_median.json`). The squared-error
entrant is a single seed (seed 0) and the median entrant a 3-seed ensemble,
but the ensemble is not what closes the gap: a single-seed median XGBoost run
on the same harness rows also ties the transformer (MAE 4.329 against 4.325,
paired difference −0.004, 95% interval [−0.025, +0.016]; measured 7 November
2026, not committed as an artifact).
Against the 3-seed entrant, by season the transformer is behind in 2023
(+0.019) and 2025 (+0.004) and ahead in 2024 (−0.027), and no season's
interval excludes zero. By position, QB (−0.053) and
WR (−0.013) lean to the transformer and RB (+0.011) to XGBoost, all inside
noise. TE is the one cell whose interval excludes zero, and it favours XGBoost
(+0.035, [+0.003, +0.069]); it is one of seven sub-group cells, with no
multiplicity correction.

The squared-error row stays in the table as a labelled mean predictor. The
transformer loses to it on RMSE (6.51 vs 6.08, averaged over the three
seasons), as a median predictor should against a mean predictor. The
transformer's distinct contribution is not point accuracy but the calibrated
floor/ceiling band (§6); neither XGBoost entrant publishes one.

### It loses to the experts at the draft

The honest benchmark is not "does it beat a naive average" but "is it better
than what a drafter can get for free." The reference measured here is expert
consensus, snapshotted *strictly before* kickoff (leak-safe) and scored on
realized end-of-season finish (`models/diagnostics/consensus_benchmark.json`):

- **Expert consensus (FantasyPros ECR).** Preseason starter hit-rate: **consensus
  60.5% vs the model 53.9%**, and consensus wins all twelve position-seasons on
  a like-for-like ranking comparison. The model does *not* out-rank the experts.
- **Average draft position (ADP)** — what league-mates actually draft from — has
  not been benchmarked. This project has no historical ADP, only the 2026
  preseason snapshot. Scoring the 2026 board against ADP and consensus by
  position is the first item of the 2027 plan
  (`docs/2027-offseason-plan.md` §4.1).

Losing to consensus was the pre-registered expectation (the artifact's
`pre_registered_expectation`), and it is stated plainly rather than hidden
behind a favorable internal baseline.

### Players who played: a diagnostic, not an explanation

The benchmark also reports the same comparison restricted to players who went
on to appear in at least 8 games. The artifact labels those rows "an
OUTCOME-SELECTED diagnostic, never the headline", and they are read that way
here. Within position, averaged over the three seasons, the cut closes about 7%
of the ranking gap at QB, 46% at RB, 12% at WR and 1% at TE, and consensus still
wins all twelve position-seasons after it. Earlier versions of this document
read the pooled all-positions row, which mixes positions, as showing that most
of the experts' edge is availability forecasting; the per-position rows do not
support that.

The gap to consensus is real at every position. Restricting to players who
played at least 8 games narrows it mainly at running back, and because that cut
selects on the outcome, it says nothing causal about availability. What the
evidence does support is narrower. Among players who played, consensus is
nearly as far ahead on points per game as on total points (Spearman advantage
0.127 vs 0.152, averaged over position-seasons; measured on the consensus
benchmark's 2023–25 position-seasons, 7 November 2026), so
this comparison does not show the edge is mainly about who plays. Changing the
estimator on the same box-score inputs has not moved ranking: a
conditional-mean head improved points but not within-position ranking (§7).
The median-objective XGBoost above is a separate, narrower result: it ties the
transformer on point MAE, and it was not ranked against consensus. That is
consistent with the gap being information the model never sees — depth charts,
role and scheme changes — rather than the estimator, but it has not been
tested directly.

### Weekly: behind same-week expert consensus

> **Result (2026-10-10).** The pre-registered re-measurement against same-week
> rankings (spec `docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md`,
> artifact `models/diagnostics/weekly_consensus_sameweek.json`) finds the model
> **behind** weekly FantasyPros consensus. Within-position rank correlation with
> outcomes, players who recorded a stat line and had not played at scrape time:
>
> | sample | model | consensus | delta | 95% interval (week-resampled) |
> |---|---|---|---|---|
> | 2023–25 (Rule 1) | 0.597 | 0.634 | −0.037 | [−0.047, −0.028] |
> | 2020–22 (descriptive) | 0.556 | 0.601 | −0.045 | [−0.055, −0.035] |
>
> Behind in every season of both samples and in every leave-one-season-out
> estimate; the bye-consistent-only sensitivity agrees (−0.036). Per position
> (2023–25 / 2020–22): QB −0.089 / −0.111, RB −0.019 / −0.019, WR −0.019 /
> −0.020, TE −0.023 / −0.030 — every interval below zero. **Rule 2 (the RB
> edge) is not established; the RB edge is retracted.** The interval is
> conditional on these seasons, and within-season serial dependence is not
> modelled. A sensitivity outside the pre-registration (7 November 2026):
> including ranked players who recorded no stat line, each scored at 0 points,
> the 2023–25 consensus deficit grows from −0.037 to about −0.109.
>
> **Why the earlier numbers were wrong (correction of 2026-10-06).** Every
> earlier expert comparison (the superseded record below) used the wrong week's
> consensus. `weekly_rankings.weekly_snapshot` takes the latest nflverse
> scrape in the seven days before week N's first kickoff, and nflverse scrapes
> FantasyPros on Fridays — so that scrape is the *previous* Friday's, i.e. week
> N−1's rankings, made before week N−1's Sunday games and injury news. The
> re-measurement's `old_protocol_staleness_audit` checks the old snapshots against the bye
> schedule: of the 38 weeks in 2020–25 where the bye schedule can discriminate
> (byes in both weeks N−1 and N, and different), 36 **contradicted** the assigned
> week, 1 was **bye-consistent** (compatible with week N, which is not proof of
> it), and 1 had no eligible scrape. Together with the Friday scrape dates, this
> supports the stale-consensus explanation. The earlier tie and RB edge are
> **invalidated by the corrected analysis**; the old and new comparisons also
> differ in population and coverage, so the size of each change is not
> attributed to staleness alone. This re-measurement is a pre-registered
> reanalysis of data already examined, not an untouched replication.

**Superseded record.** Before the correction, this section reported two weekly
results, both measured against the previous week's rankings and both
withdrawn: a statistical tie with weekly consensus on 2023–25, and a
running-back edge that appeared to replicate on 2020–22. Their artifacts,
`models/diagnostics/weekly_consensus.json` and
`models/diagnostics/rb_oos_weekly.json`, are kept as history only. The
current weekly result is the one above: behind consensus at every position.

## 4. What didn't work — and why

Negative results, each pre-registered and each with a mechanism, because the
mechanism is the useful part:

- **Feature pack v2** (air-yards share, team pass volume, indoor/roof). Passed
  the accuracy criterion by point estimate but the gain was indistinguishable
  from zero (paired 95% CI on the MAE delta included zero; won 1 of 3 seasons).
  *More in-season box-score derivatives are exhausted as a direction.*
- **Expected-value vs median board ranking.** Ranking on the simulated season
  mean instead of the median changed the board's ordering by exactly nothing.
  *Availability is modeled per-position, so within a position the mean/median
  gap is a constant that cannot reorder anyone.*
- **Per-player availability** from week-1 roster status. A large, real signal
  (active players average 10.4 games vs 0.4 for cut players) that moved the
  board not at all. *The draftable pool is 93–95% active at week 1 by
  construction — anyone cut or injured in the preseason was never a top-50
  fantasy player last year — so a bucket signal is near-constant within it. The
  availability risk that matters for a draft board is mid-season injury to
  established starters, which week-1 status cannot see.*
- **Loss rebalancing** to fix the "starved" touchdown heads. **Retracted before
  training** — see §5.
- **A dedicated conditional-mean head** for the eight count components, built to
  fix quarterback. It improved *points* significantly and *ranking* not at all,
  and was not promoted. The most useful negative result the project has produced
  — the full record is in §7.
- **Betting lines as features** (team implied total and expected margin from
  historical schedule lines, added to the squared-error XGBoost baseline of §3,
  the mean predictor, and not re-run with the median objective; pre-registered
  2026-10-11, run once on 2026-10-12). **Fail, inconclusive.** One of the six
  registered conditions failed: *materiality*. Adding the lines cut PPR error by
  0.039 points per player-week, equal-weighted over 2023–25 and averaged over
  three seeds. The registered bar is 0.05, so the gain falls below our
  materiality threshold. The 95% crossed player × week-pair bootstrap interval is
  [0.021, 0.058]. It excludes zero but reaches past 0.05, which is why the label
  is inconclusive rather than below materiality. The other five conditions held:
  - the interval's lower bound is above zero;
  - all three seasons gained (0.052, 0.025, 0.040);
  - all three seeds gained;
  - players projected at 8+ PPR were not hurt (gain 0.076, interval
    [0.035, 0.118]).

  Ranking status: `ranking_ok`, with within-position rank correlation up
  0.007. So no lines-based forward test was earned, and model work returns to
  maintenance. The screen's own label, quoted from its record: "Optimistic
  historical information screen. These are historical schedule lines, treated
  as closing-time context based on nflfastR's documentation of the related
  fields; their book and quote time are not recorded in the feed and their
  availability at our mid-week deadline is unverified. The screen admits
  information later than our publication deadline (injuries, lineup decisions,
  weather and market moves up to the close). A pass shows the information is
  worth chasing, not that a mid-week deployment would gain the same; it is
  never deployable performance. 'Optimistic' is a description, not a
  mathematical bound." Even on that favourable footing, the gain fell short of
  the bar.

  Disclosure: before the run record was frozen, one timing-only fit of the
  lines model was run while the plan was being written (seed 0, trained on
  2012–24, predicting 2025). Only its wall time was looked at. Its predictions
  were never scored or inspected, and nothing from it entered the run. Record:
  `models/diagnostics/lines_screen.json`; the frozen run manifest was committed
  before fitting: `lines_screen_manifest.json`.

## 5. The discipline earning its keep

The safeguards above are not decoration; they changed outcomes.

- An adversarial review of the consensus benchmark caught a **critical fairness
  bug**: the model's board was being built without rookies while the consensus
  ranked the whole class, quietly inflating the measured gap. Fixed before the
  number was published.
- A benchmark harness shipped with a **sign error** (ranking on negated points)
  that produced an impossible −0.59 correlation; it was caught, corrected, and
  the fix was then baked into the code *structurally* — scores are now always
  "higher is better," with a single tested conversion point and a tripwire that
  refuses to report a model more negatively correlated with reality than chance.
- Most instructively, a planned change — reweighting the multi-task loss because
  the touchdown heads appeared to receive only 1.6% of it — was **retracted
  after a pre-training audit**. The 1.6% was the *loss* share; the actual
  *gradient* share, measured directly, was 47%. Pinball-loss gradients are
  bounded and scale-free, so the large-magnitude yardage heads never starved the
  small ones. The touchdown medians sit near zero because the median of a
  zero-inflated count *is* zero — correct behavior, not a bug — and no loss
  weighting moves it. The intuition had been imported from mean-squared error,
  where it holds, into quantile loss, where it does not. The experiment was
  cancelled before spending the compute.
- An audit of the XGBoost baseline found the **rejected feature pack v2 had been
  silently live** for it. Feature resolution was implicit-on-presence, so the
  baseline picked up any v2 column that happened to be in the frame even though
  the gate had turned that pack down. The measured impact was negligible — mean
  OVERALL PPR MAE moves **+0.0014** across 2023–25, so v2 is marginally *worse*
  and well inside noise — but the mechanism was real. The baseline's feature set
  is now versioned, explicit, frozen at v1, and pinned by a test that fails if a
  new column joins it. The audit then corrected **itself** twice. Its first
  conclusion, that data vintage explained a disagreement between two committed
  reports, was wrong; it is retained in the file as `conclusion_SUPERSEDED` and
  was disproved by a single observation — `naive_last4` is byte-identical across
  the two reports while `xgboost` differs on every row, so the data cannot have
  moved if the model reading it did not. A second claim, that the report-to-report
  gap was "an order of magnitude" larger than the feature effect, was walked back
  as overstated (see §7).
- The guard predicates enforcing all of this were **mutation-tested**: each was
  deliberately broken to see whether the suite noticed. Thirteen of fifteen died
  as they should, including every walk-forward split and lag-shift boundary.
  Three genuine gaps were found and closed with tests — the most serious being
  that *no* test asserted the weekly fail-safe leaves previously-published JSON
  byte-unchanged; the two tests that looked like they covered it proved strictly
  weaker properties. One apparent survivor on the train-side leak boundary turned
  out to be an artifact of a git worktree resolving the package to a different
  source tree. It was chased down and re-run before being written up, not after.

Catching your own error before it costs anything is the entire point of the
process, and it is a more honest portfolio signal than a leaderboard number. A
superseded conclusion left visible in the record is worth more than a clean one
that was never checked.

## 6. What the model is genuinely good for

- **A free, transparent weekly projector** that beats the naive baseline and
  ties a median-objective XGBoost on point accuracy (§3). In the historical
  2023–25 PPR benchmark against same-week FantasyPros consensus, it ranks
  matched players who played after the scrape **less accurately within
  position** (−0.037 rank correlation, pre-registered reanalysis; §3). The
  earlier "parity" and running-back edge are invalidated by that corrected
  analysis.
- **Calibrated floor/ceiling bands.** Held-out 2023–25 weekly PPR coverage sits
  inside a 0.75–0.85 target for every position-season
  (`models/backtests/bakeoff.json`); ADP, ECR and both XGBoost entrants give a
  single number, this gives a distribution. That is the transformer's distinct
  contribution, and a real product difference neither benchmark rewards. Two
  exceptions are on record:
  - Calibration is fitted on PPR scoring and the same factors are reused for
    every format. Pooled over 2023–25, half-PPR and standard stay inside the
    window at every position, but under 6-point passing touchdowns the QB band
    covers 0.739 of outcomes (0.721 / 0.774 / 0.723 by season, n = 1,991)
    against 0.780 under PPR, below the window (measured on the held-out
    bake-off rows, 7 November 2026).
  - Live, through week 8 of 2026, QB, RB and WR coverage sits inside the window
    (84.0%, 82.3%, 80.1%), but TE is at 73.9%, below the 0.75 floor the
    historical bands meet (`models/diagnostics/live_2026_weekly.json`).
- **A live 2026 record.** The weekly scorecard scores, in PPR, the projections
  committed before each week's first kickoff (proven by GitHub push records,
  not by the Vercel deploy) for players who recorded a stat line. Through week 8
  of 2026 that is 2,629 player-weeks: MAE 4.33 against 4.63 for the naive
  last-4 average, and 79.7% of outcomes inside the p10–p90 band
  (`models/diagnostics/live_2026_weekly.json`, as of 2026-11-04). The
  stat-line population leaves out players who did not play, and also 309
  player-weeks of players who took offensive snaps but recorded no stat
  (measured on the live 2026 record through week 8 against nflverse snap
  counts, 7 November 2026). Counting those as scored outcomes moves coverage
  from 79.7% to 77.4% through week 8; the gain over the naive baseline grows
  rather than shrinks (0.30 to 0.38 points). The bands describe a player who
  plays; they do not include the chance of not playing.
- **Honest baselines and honest bands**, so a user knows not just a projection
  but how much to trust it.
- **A draft board that ranks on consensus and shows the model's bands.** The
  ordering is expert-consensus (ECR), not the model — because the model's own
  ranking was measured to lose — with ADP as a market/keeper overlay and the
  model's calibrated floor/ceiling bands on every player. The board embodies the
  conclusion above: a banded view of consensus, not a contrarian oracle.

## 7. Honest limitations and what would actually move the needle

- **The draft board should not be used to deviate from consensus.** The model's
  own season ranking loses to expert consensus in every position-season (§3),
  so its disagreements with consensus are not an edge. The right use of the
  board is as a calibrated, banded view of consensus, not a contrarian oracle.
- **The likeliest headroom is offseason context** — depth charts, injury
  history, role and scheme changes — information the v1 scope guard
  deliberately excludes. That is a hypothesis, not a measurement (§3). The 2027
  plan measures first, with an ADP benchmark, before anything is built for it;
  using that information would also need an owner amendment to the scope guard.
- **Quarterback is the weakest position** across every cut — pooled over nine
  walk-forward folds, weekly within-position rank correlation is 0.471 for QB
  against 0.630 for RB/WR/TE — traceable to the rushing-touchdown component of QB
  scoring living in a distribution the median under-serves. This document used to
  call the fix a better point construction (an expectation or a dedicated mean
  head) and leave it as an open thread. **That thread is now closed, and the
  answer was no.** A pre-registered experiment fitted Poisson conditional-mean
  heads for the eight count components and ran 9 walk-forward folds × 3 seeds,
  read out as 2 inference arms from the same fits (40 Kaggle runs in all, with
  4 λ-selection runs and 9 baseline runs that completed the v1 folds).
  Verdict: **not promoted.** The primary — pooled RB/WR/TE weekly
  within-position Spearman against v1 — came back at **−0.0005, 95% CI [−0.0015,
  +0.0004]**: flat. Quarterback itself moved +0.005 with an interval spanning
  zero. The band guard also failed, on 2022 QB coverage of 0.861 against a 0.85
  ceiling — though the record notes that the v1 baseline refits that same cell to
  0.844, so the mean head pushed an already-marginal cell over rather than
  breaking the bands. The second arm was significantly *worse* on the primary
  (−0.0011, interval excluding zero), even though it was the arm that helped QB
  (+0.015, interval excluding zero). That QB gain does not survive a
  small-cluster correction of the 9-fold interval, which widens it to about
  [−0.001, +0.030].

  **The informative part is what did improve.** Pooled PPR MAE dropped
  significantly: **4.404 vs 4.491, a delta of −0.087 with a 95% CI of [−0.112,
  −0.059].** The conditional-mean head predicts *points* better and *ranking* not
  at all. That fits the reading in §3: on these box-score inputs, changing the
  estimator moves point error but not ranking. And this is a tight null rather
  than an underpowered one — the pre-registration anticipated a standard error
  of 0.007–0.010, enough to resolve an effect of about 0.02; the realized 95%
  interval on the primary has a half-width of 0.00096.
- **More held-out seasons is no longer the obvious next step.** This document
  previously called a longer walk-forward (≈10 folds) the cheapest way to resolve
  the small effects the project keeps meeting. The mean-head gate effectively ran
  that, at nine folds. What the XGBoost audit then turned up is the reason to be
  careful with the prescription: the baseline **subsamples**, and refitting it on
  byte-identical data with seeds 0–3 spans ~0.012 OVERALL PPR MAE and up to
  ~0.047 on the smallest per-position cell — comparable to or larger than several
  effects this project has chased. More folds do not help when the estimator's own
  seed jitter is the size of the effect being measured. Reports now record
  `xgb_seed`, `xgb_feature_set`, and a `data_vintage` block carrying a sha256 per
  source parquet, and two reports are compared only when all three match.

*This document is updated as results change. Evaluation figures come from
committed artifacts in [`models/`](../models/), produced by code under
[`src/ffmodel/eval/`](../src/ffmodel/eval/); the key ones are named in the
text. The exceptions: the process figures in §5 (the loss-share audit, the
mutation test) come from the project's spec and review records; the
per-player availability figures in §4 are not in a committed artifact; and
figures dated 7 November 2026 that name no committed file come from the
project's audit of that day, whose working records are not public, so each
says what it was measured on.*
