# Remaining-season projection foundation (experimental)

The generator's `--remaining` flag, together with `--week auto`, produces
`remaining-<league>.json`; the weekly workflow now passes it for both leagues, as an
optional payload — a failure there is printed and skipped and never blocks the weekly
slate. Weekly rows keep only the league-lens `p10/p50/p90` (no other lenses, no stat
quantiles). The payload carries a measured `evaluation` block (model MAE against the
four-game-mean baseline by horizon, read from the committed
`models/diagnostics/remaining_matrix_<league>.json`) in place of the former
`advice_eligible` boolean. It is consumed by the waiver desk to price drop cost
(`faab-waivers.md`, "Bid ranges"); the pre-draft trade engine still does not read it.

Every future week is generated independently with the existing model and
league scoring, using only observations before the starting slate. Earlier
future projections are never recycled as observed features. Pick-six costs
use the same adjustment as weekly forecasts. Output contains weekly rows,
not summed quantiles or an asserted season median.

Known schedule byes and missing model coverage have separate statuses.
Coverage counts are emitted for each week. Current team identity is required;
players outside that mapping are not assigned stale historical teams.

Limitations that must be resolved before advice:

- There is no injury/participation or future-role model. Projections are
  conditional scenarios, not expected points after missed-game risk.
- League weights apply to the weekly model's supported stat subset. Long-TD
  bonuses, two-point conversions and special-teams scores are not forecast.
- Lags and games-prior remain frozen, creating an unvalidated long-horizon
  feature distribution. Weekly calibration does not validate that horizon.
- Current roster and schedule snapshots may postdate the observation cutoff.
  Ignored target-period rows are counted; historical evaluation is prohibited.
- Current-week scenarios may include games already started. A consumer must
  exclude those from executable decisions or lock actual contributions.
- Minimum schedule coverage catches gross truncation, not every conceivable
  missing game. Exact future-slate validation remains required for advice.

Next steps: horizon-specific retrospective evaluation, availability handling,
then roster-aware remaining-week trade comparisons. The old pre-draft trade
engine remains blocked in season.

## Fixed-origin diagnostic

`python -m ffmodel.eval.remaining --season 2025 --origin 8 --horizons 1 2 4 8 --league gabagool --out models/diagnostics/remaining_2025_w8_gabagool.json`

The diagnostic uses the normal enriched historical data loader and loads
prior-season model artifacts. It freezes the cohort and last-observed team
before the origin; today's roster map is never used. Each horizon gets an
independent feature build from the same history. The report includes cohort,
scheduled and forecast counts, missing actual rows, changed-team/position
rows, and conditional MAE/bias by position.

No absent player-week is imputed as zero. Scoring uses only predicted stat
components. If historical pick-six counts are absent, that cost is excluded
from both forecasts and actuals. Retrospective schedule knowledge and
conditioning on recorded, same-team stat lines remain limitations.

This is a diagnostic, not a promotion gate or a new accuracy claim. A single
origin is a smoke check; multiple origins/seasons, availability evaluation,
and suitable baselines are needed before enabling trade verdicts.

Initial 2025 Week 8 smoke run (three deployed seed roots, trained through
2024; Gabagool predicted-stat scoring subset): conditional MAE was 4.750,
4.538, 4.585 and 5.106 at horizons 1, 2, 4 and 8. Comparable player counts
were 288, 301, 308 and 312, respectively. These changing cohorts prevent
interpreting the difference as a clean paired horizon-degradation estimate.
Approximately half the broad forecast cohort lacked recorded target-week
actuals; this is not a calibrated estimate of injury or participation risk.

## Expanded baseline comparison

`python -m ffmodel.eval.remaining_matrix --league gabagool --out models/diagnostics/remaining_matrix_gabagool.json`

Defaults are seasons 2023–2025, origins 5 and 9, horizons 1/2/4/8. The
predeclared baseline is mean league-scored production in the last four
recorded pre-origin games (all games if fewer than four). It stays frozen
through every horizon and never inserts zeros for absent games. Model and
baseline errors use identical observed same-team players; negative paired
MAE delta favors the model. Aggregate summaries weight by paired forecast
count, not by equally weighting large and small cells.

Repeated players and overlapping windows are dependent. These descriptive
comparisons are not significance tests, an independent holdout for model
selection, or evidence that the forecast is ready to value trades. The
supported scoring-rule subset currently matches for Gabagool and FAM; roster
requirements, keeper rules and platform-specific omitted events are not
evaluated by this player-level diagnostic.

Historical roster source quality is checked separately with
`python -m ffmodel.eval.roster_availability --rosters data/raw/rosters_weekly_raw_2012_2025.parquet --weekly data/raw/weekly_v2_2012_2025.parquet --out models/diagnostics/roster_availability_source.json`.
This audits status coverage and conflicting identities. ACT is not treated
as proof of participation, and source capture timing remains unverified.

Expanded run results (descriptive, not significance-tested):

| Horizon | Model MAE | Four-game mean MAE | Paired forecasts |
| --- | ---: | ---: | ---: |
| 1 | 4.612 | 4.815 | 1,817 |
| 2 | 4.452 | 4.722 | 1,791 |
| 4 | 4.663 | 4.873 | 1,829 |
| 8 | 4.800 | 4.987 | 1,834 |

The aggregate advantage is small. At horizon 8, RB MAE is slightly worse
than baseline (4.834 versus 4.759). Neither the aggregate nor this subgroup
result is permission to tune the model on these evaluation observations.

The source audit uniquely matched 77,947/80,090 historical stat rows
(97.32%); 885 matched conflicting roster identities and 1,258 were unmatched.
Missing-ID source rows are preserved individually because duplicates cannot
be established without identity. Conflicting rows expose no arbitrarily
selected team/status. Timing verification remains a prerequisite to using
these statuses as forecasting features or participation labels.

## Starter-pool decision check

The matrix also reports within-position decision accuracy and regret for a
frozen pool selected by pre-origin four-game-average rank: QB24, RB60, WR72,
TE24. These fixed broad starter/depth limits are not tuned from evaluation
outcomes and do not represent observed fantasy rosters. All within-position
pairs are compared, not only favorable disagreements. Pairs tied by either
forecast are excluded for both methods; actual ties have zero regret and
are excluded from accuracy. Missing or changed-team actuals stay excluded
and counted. Repeated-player pairs are dependent, not independent trials.

Availability provenance was checked against the official
[roster builder](https://github.com/nflverse/nflverse-rosters/blob/main/R/rosters.R):
through 2015, weekly dataexchange rows receive season-level Shield statuses
via a player-ID join. Multiple statuses can fan out across the same weekly
identity; none should be chosen as weekly availability truth. From 2016,
[NGS queries](https://github.com/nflverse/nflverse-rosters/blob/main/R/rosters_ngs.R)
are week-specific, but record capture times are not established. Daily
release updates do not establish pre-origin knowledge. Status remains an
unusable pregame feature until genuinely timestamped source snapshots exist.
Postgame snap/participation evidence can support retrospective outcome
labels, but cannot be substituted for a pregame input.

Starter-pool run results across the same six season/origin cells:

| Horizon | Model choice accuracy | Baseline accuracy | Model mean regret | Baseline mean regret |
| --- | ---: | ---: | ---: | ---: |
| 1 | 63.53% | 60.85% | 2.883 | 3.252 |
| 2 | 64.87% | 62.21% | 2.449 | 2.758 |
| 4 | 64.67% | 61.23% | 2.585 | 3.058 |
| 8 | 64.70% | 60.99% | 2.737 | 3.312 |

Regret is the point loss from choosing the lower actual scorer in a pair,
averaged over common forecast-nontied pairs (actual ties contribute zero).
Actual ties do not enter choice accuracy. Aggregate improvement does not
hold in every subgroup: two-week QB mean regret is about 0.286 points worse
than baseline. These are correlated hypothetical player comparisons, not
demonstrated gains for actual fantasy rosters. No superiority test or
availability-adjusted trade conclusion follows from these results.

## Roster simulation walk-forward result (2026-09-29)

`node tools/trade_backtest.cjs --seasons 2023,2024,2025 --origins 5,9 --leagues 20 --trades 125 --sims 2000 --jobs 7 --league site/data/draft.json --secondary site/data/draft-fam.json --out models/diagnostics/trade_sim_eval.json --site-out site/data/trade_sim_eval.json`

Run on 2026-09-29 at commit 88e350a, with the rules predeclared in
`docs/superpowers/specs/2026-09-24-roster-simulation-grade-design.md` (§6, with
the §10 amendments). 240 of 240 planned cells ran (120 per league); none were
excluded. Each league-season used 20 simulated drafts with that league's own
settings, then 125 trades per draft at origins 5 and 9. Results hold for these
two formats only.

Verdicts:

| League | Trade grade | Waiver drop choice |
| --- | --- | --- |
| Gabagool Fools | fail | pass |
| FAM FOOTBALL | fail | not evaluated (rolling waivers, not FAAB) |

The trade grade fails in both leagues on one check: 80% interval coverage was
0.650 (Gabagool) and 0.665 (FAM) against the predeclared band [0.70, 0.90].
Every accuracy check passed. The coverage failure was predicted and recorded
before the run (spec §10.5, known under-dispersion). The declared response is a
v2 with a per-player persistent error term, tested prospectively on 2026 and
never re-scored on 2023–2025. The trade grade stays closed on the page.

Verdict checks (bootstrap intervals are 95%, 2,000 resamples of whole
(season, league) clusters; negative differences favor the simulation):

| Rule | Gabagool | FAM | Pass (Gabagool / FAM) |
| --- | ---: | ---: | --- |
| Pooled MAE (sim − current) entirely below 0 | [−0.796, −0.418] | [−1.136, −0.733] | yes / yes |
| Pooled MAE (sim − naive) entirely below 0 | [−13.170, −10.902] | [−13.825, −11.260] | yes / yes |
| Pooled regret (sim − current) entirely below 0 | [−0.639, −0.011] | [−1.243, −0.645] | yes / yes |
| Pooled regret (sim − naive) entirely below 0 | [−3.416, −2.114] | [−4.090, −2.652] | yes / yes |
| Same-position (sim − current) MAE not entirely above 0 | [−0.509, 0.256] | [−0.352, 0.095] | yes / yes |
| Cross-position (sim − current) MAE not entirely above 0 | [−0.874, −0.461] | [−1.259, −0.810] | yes / yes |
| Depth-for-starter (sim − current) MAE not entirely above 0 | [−0.937, −0.188] | [−1.340, −0.751] | yes / yes |
| Lopsided (sim − current) MAE not entirely above 0 | [−1.439, −0.026] | [−2.395, −0.969] | yes / yes |
| No planned cell excluded | 0 | 0 | yes / yes |
| 80% interval coverage in [0.70, 0.90] | 0.650 | 0.665 | no / no |

Pooled metrics (n = 30,000 trade sides per league: 15,000 trades, each scored
from both teams' side; MAE and regret in fantasy points over the rest of the
season):

| League | Method | MAE | Sign accuracy | Regret | Coverage |
| --- | --- | ---: | ---: | ---: | ---: |
| Gabagool | Simulation | 51.796 | 0.678 | 14.030 | 0.650 |
| Gabagool | Current | 52.405 | 0.674 | 14.357 | n/a |
| Gabagool | Naive | 63.816 | 0.640 | 16.784 | n/a |
| FAM | Simulation | 51.240 | 0.674 | 13.984 | 0.665 |
| FAM | Current | 52.175 | 0.662 | 14.928 | n/a |
| FAM | Naive | 63.795 | 0.626 | 17.397 | n/a |

The accuracy gain over the current method is statistically clear but small:
about 0.6 points of MAE in Gabagool and 0.9 in FAM, on errors of about 52
points, with sign accuracy up 0.4 and 1.2 percentage points. The large gain is over the
naive comparator, not over today's method. The typical error is also large in
absolute terms: the per-stratum E below is 52–73 points at origin 5 (13 weeks)
and 38–54 at origin 9 (9 weeks). A
rest-of-season trade delta is very noisy even for the best method here.

Strata (n and E by origin; origin 5 spans 13 weeks, origin 9 spans 9 weeks):

| League | Stratum | Origin 5 n | Origin 5 E | Origin 9 n | Origin 9 E |
| --- | --- | ---: | ---: | ---: | ---: |
| Gabagool | Same position | 1,712 | 55.291 | 1,696 | 37.987 |
| Gabagool | Cross position | 13,288 | 60.117 | 13,304 | 44.797 |
| Gabagool | Depth for starter | 3,942 | 53.013 | 3,902 | 41.556 |
| Gabagool | Lopsided | 1,500 | 72.725 | 1,500 | 50.482 |
| FAM | Same position | 1,622 | 51.589 | 1,682 | 39.697 |
| FAM | Cross position | 13,378 | 58.829 | 13,318 | 45.032 |
| FAM | Depth for starter | 3,926 | 53.441 | 4,102 | 40.017 |
| FAM | Lopsided | 1,500 | 68.729 | 1,500 | 53.899 |

The lopsided-trade cutoffs are 78.333 (origin 5) and 59.690 (origin 9) in
Gabagool, and 70.385 and 53.071 in FAM. The same-position stratum is the one
place where the simulation's advantage over current is not separable from zero
in either league (the intervals above include zero).

Waiver drop choice (Gabagool only; n = 14,400 drop decisions, quota QB 2,
RB 3, WR 3, TE 2): mean regret is 29.549 for the simulation, 31.064 for
current and 33.349 for naive. Bootstrap intervals: (sim − current)
[−2.276, −0.768] and (sim − naive) [−4.933, −2.725]. Verdict: pass. One
disclosure cuts the other way: naive's share of zero-regret decisions (0.110)
is higher than the simulation's (0.095) (current: 0.081) even though naive's
mean regret is worse. The test validates the drop choice, not the drop-cost
magnitude, and the failed coverage says the magnitudes' spread is too narrow.
Publishing the slim result file therefore opens the simulated drop cost on the
waiver desk for Gabagool only (`waiver_verdict === "pass"`). FAM's waiver
verdict is `not_evaluated`.

Availability-off diagnostic (not a verdict input; same engine with
p_out = p_stay = p_tag = 0, n = 30,000 trade sides per league). Pooled MAE with the
absence model off was 52.143 in Gabagool (51.796 on) and 51.820 in FAM
(51.240 on). The current method's MAE is 52.405 and 52.175. Switching
availability off therefore keeps about 0.26 of Gabagool's 0.61-point edge and
about 0.36 of FAM's 0.94-point edge over the current method. The absence model
accounts for somewhat more than half of the gap, and the rest comes from the
simulation itself. (Sign accuracy and regret also move against the sim with
availability off: 0.673 vs 0.678 and 14.363 vs 14.030 in Gabagool.)

Disclosures:

- The `current` comparator is today's p50 lineup method with
  replacement-level fill for empty slots. That is stronger than the shipped
  page method, which scores a bye player as a 0-point starter or reports
  "unassessed".
- The waiver desk's bid guidance now consumes the simulated drop cost for
  Gabagool. The magnitudes are not calibrated.
- Tag timing: the backtest applies the week O−1 game report to week O. The
  live page applies Sleeper's current `injury_status` to the next week, which
  early in the week can lag by two games. Unmapped Sleeper values (NA, COV,
  DNR, NFI, and "SUSPENDED" spelled out) count as untagged.
- Availability `p_tag.IR` is 0.63–0.69, lower than "on reserve" suggests
  (participation filter, stale relevance). It is internally consistent and is
  investigated in v2.
- The trade page's replacement pool comes from the remaining-season file; the
  waiver desk's comes from the board. About 20 players differ.
- The page applies the nearest horizon's (9- or 13-week) E and lopsided cutoff
  to a live horizon of another length, unscaled; ties go to the shorter
  horizon (§10.3).
- The bootstrap resamples whole (season, league) clusters (60 clusters, §10.6).
  Leagues within one season still share one set of real player outcomes, so the
  intervals are somewhat too narrow.
- The population is realistic trades only (§10.2: each side gives a
  before-lineup starter). Accepted/attempted: 15,000 of 32,757 in Gabagool,
  15,000 of 32,945 in FAM.

What is and isn't claimed:

- Claimed: on 2023–2025 in these two simulated-draft formats, the simulation
  picks trade winners slightly better than today's p50 method and much better
  than the naive comparator, and its waiver drop choices had lower regret than
  both in Gabagool.
- Not claimed: calibrated ranges. The 80% intervals cover 65–67% of outcomes,
  so the trade grade stays off.
- Not claimed: a large improvement over today's method, magnitude accuracy for
  drop costs, any result for FAM waivers, or any result outside these formats
  and horizons.
- Not claimed: that a v2 will pass. It will be tested prospectively on 2026.

Artifacts: the full result is committed compressed at
`models/diagnostics/trade_sim_eval.json.gz` (read it with
`gzip -dk models/diagnostics/trade_sim_eval.json.gz`; the 26 MB raw file and the
`*.cells.jsonl` resume checkpoint are git-ignored). The slim file the site reads
is `site/data/trade_sim_eval.json`; the per-origin forecast inputs are
`models/backtests/origin_forecasts/forecasts_{2023,2024,2025}_o{5,9}.json`.
