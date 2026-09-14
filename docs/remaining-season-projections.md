# Remaining-season projection foundation (experimental)

The generator's opt-in `--remaining` flag, together with `--week auto`,
produces `remaining-<league>.json`. The normal scheduled update is unchanged.
Use a separate `--out` directory for validation. This is not consumed by
waiver bids or the trade engine and is explicitly `advice_eligible: false`.

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
