# In-season consensus references

Weekly ECR and rest-of-season consensus are distinct payloads. Neither
contains external projected points, alters the model's predictions, or
supplies additive trade currency.

## Automatic ROS reference

Run `python -m ffmodel.site.ros_experts`. The weekly-update workflow also
runs this after projection generation, independently of weekly ECR refresh.
It reads the free nflverse/DynastyProcess historical rankings mirror and
selects the latest explicit FantasyPros PPR ROS overall page. Positional
ROS pages check coverage; draft, weekly and other scoring formats cannot
substitute. Seven-day freshness and identity/coverage checks fail closed.

The output is `site/data/ros-ecr.json`; rank-only content-addressed snapshots
live in `data_snapshots/ros_ecr`. Publication uses atomic writes. Failure
preserves the last good payload, which the browser will eventually expire.
Dates are source dates, not verified capture timestamps; season is inferred
from that date (January belongs to the previous NFL season).

The waiver research table offers **Live ROS PPR rank** ordering. This is an
independent PPR market reference shared across leagues, not a custom-scored
projection. A player's position and current team must match before its rank
is shown. Missing/stale ROS does not disable weekly waiver calculations.
The reference never changes bid bands or claims to price keeper value.

## Remaining trade work

The existing trade engine simulates a future draft and remains pre-draft
only. Do not remove that restriction just because ROS ranks are present.
A replacement in-season engine needs:

- Remaining-week, league-scored lineup comparisons for both teams.
- Explicit handling of byes, unavailable players, roster capacity and any
  required drops; unknown projections are not zero-value assets.
- Separate keeper/future-pick effects, not an invented sum of ROS ranks.
- Fresh read-only roster/scoring contracts and tests for asymmetric trades,
  surplus depth, scarce positions and two-for-one roster consequences.

Until those inputs and tests exist, no in-season win/win trade verdict is
available. Current-week impact and ROS rank context must remain labeled as
partial evidence, not a complete remaining-season valuation.
