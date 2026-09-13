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
