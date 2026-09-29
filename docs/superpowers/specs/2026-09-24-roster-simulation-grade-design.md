# Roster simulation and trade grade — design

Status: draft for owner review (2026-09-24). The owner approved it in conversation, section by
section: approach A (season simulation), §3 assumptions, §5 grade + market, §6 test.
Self-reviewed by Claude; astra was unavailable (out of usage). For this feature it replaces
the promotion test in `2026-09-17-inseason-trade-scenario-design.md` §8, with the same bar
adapted to the simulation.

## 1. Problem and goal

Every in-season tool values a player as the points he adds to a starting lineup in which
nobody misses a game and every projection lands exactly on its p50 (`site/assets/ros.js`
`lineupScore`/`bestLineup`, used by `waivers.js` `dropCostOf` and `seasontrade.js`
`analyze`). Under that model a backup is worth only his bye-week fill-ins. The owner
observed two consequences on 2026-09-23. The waiver desk offered Justin Herbert as a
near-free drop; he is the backup QB behind C.J. Stroud and has a higher expert ROS rank
than the free agent Baker Mayfield. The in-season trade page showed Herbert for Kyler
Murray as a change in a single week.

Goal: one roster-value engine that credits depth (cover for injuries, the weekly start
choice, boom/bust weeks) and prices lineup holes at replacement level. Two tools use it:
the trade page for an **objective grade**, and the waiver desk for **drop cost**. Neither
shows it until it beats both the naive baseline and the method live today on a
predeclared 2023–2025 walk-forward test.

Owner decisions: the grade is based on the model alone. Expert ROS ranks are shown beside
it as a disagreement check and never blended into the number ("model + market"). The quick
usability fixes shipped first (main 263c538).

## 2. Components

| Unit | Language | Responsibility |
|---|---|---|
| `src/ffmodel/eval/availability.py` | Python | Measures absence-transition rates and injury-tag adjustments from history. Publishes `site/data/availability.json` (live, seasons ≤ current−1) and one table per test season (seasons < S). |
| `site/assets/rostersim.js` | JS (UMD, node-testable) | Seeded Monte Carlo of the remaining season for one or more rosters. Returns expected totals, spread, and paired deltas for trades and drops. Uses `ros.js` for lineup choice. No DOM, no network. |
| `src/ffmodel/eval/export_origin_forecasts.py` | Python | One-time (overnight) export of frozen per-player weekly p10/p50/p90 for every week from origin to 17: seasons 2023–25, origins 5 and 9. Reuses the `eval/remaining.py` origin machinery; `_evaluate_origin` builds only horizons 1/2/4/8 today. |
| `src/ffmodel/eval/trade_backtest_inputs.py` + `tests/sim/trade_backtest.cjs` | Python + Node | The §6 test. Python writes the leagues, trade set and realized outcomes as JSON. Node runs the **same** `rostersim.js` the site ships and writes `models/diagnostics/trade_sim_eval.json`. |
| `seasontrade.js` / `seasontrademode.js` | JS | Grade and market panel (§5), gated on the eval file's verdict. |
| `waivers.js` / `waivermode.js` | JS | Drop cost from the simulation, gated separately (§6.5). |

The start/sit page is unchanged.

## 3. Simulation model (`rostersim.js`)

**Inputs:**
- rosters (player ids) and league slots (`roster_positions`);
- the weekly `points.league.{p10,p50,p90}` from `remaining-<slug>.json`;
- `availability.json`;
- each player's current Sleeper `injury_status`, and user-marked out weeks;
- the live free-agent pool, for replacement level;
- `startWeek`/`endWeek`, `seed`, `nSims` (default 2000).

For each simulated week w and each player:

1. **Availability.** A two-state chain per position: healthy→out with `p_out[pos]`,
   out→out with `p_stay[pos]`.
   - Initial state from the current tag: players tagged `Out`, on IR or on PUP start out;
     `Doubtful` and `Questionable` use the measured first-week miss probabilities
     `p_tag[status]`.
   - User-marked weeks are forced out.
   - Byes and rows other than `conditional_projection` count as out, never as "played"
     with zero points.
   - Unknown tags use the untagged rate.
2. **Points.** An available player draws from a skewed distribution matched to that
   week's p10/p50/p90: a two-piece distribution with separate lower and upper scales
   around p50, and the lower tail truncated at the floor the p10 implies. The plan fixes
   the exact family, with a fixture showing it recovers the three quantiles within
   tolerance. Draws are independent across players; teammate/game correlation is a
   stated limitation.
3. **Lineup.** `ros.js` `bestLineup` picks the starters from *available* players,
   scored by p50: the manager knows who is inactive but not the outcomes. The lineup
   then scores the drawn points.
4. **Replacement.** A slot `bestLineup` cannot fill is filled at replacement level. That
   is the week's best p50 in the live free-agent pool at an eligible position (FLEX
   eligibility per `ros.js` `SLOT_ELIGIBLE`), drawn like any other player. With no
   free-agent pool (the backtest, or missing data), the slot uses the positional
   replacement table in `availability.json`: the Nth-best weekly p50 per position, with
   N set by league size and slots. Never zero. In the backtest, the free-agent pool is
   the synthetic league's undrafted players with their frozen forecasts, so predicted and
   realized replacement use the same pool.
5. **Scope.** Weeks `startWeek` to `endWeek`, with the current week excluded as today.
   QB/RB/WR/TE only; K/DEF are held identical on both sides.

**Common random numbers.** Every roster variant in one comparison reuses the same
per-player availability and point draws, so a paired delta carries only the effect of
the move.

**Outputs.**
- Per roster: mean total, p10/p90 of the total, and per-week means.
- Per comparison: mean delta for each side, the delta's p10/p90, and P(delta > 0).
- The same seed and inputs always give the same numbers.

**Performance.** A trade is 4 roster variants; target: under 1 s at 2000 sims in a
browser. On the waiver desk, a coarse pass (about 200 sims, shared draws) ranks every
add/drop pair, then a full pass runs on the displayed rows only. A node timing fixture
checks the budget.

## 4. Availability data (`availability.py`)

- **Participation.** A player-week counts as *played* if a regular-season stat row exists
  for him in the `weekly_*` data. It counts as *missed* when all three hold: his team
  played; he had a stat row in at least one of his previous 4 team games that season (an
  established player); and he has no row this week. Players who were never established
  are left out of rate estimation.
- `p_out[pos]` and `p_stay[pos]` are the transition frequencies over established
  player-weeks.
- `p_tag[status]` comes from `nflreadpy.load_injuries` `report_status`
  (Out/Doubtful/Questionable) for the following game. It is estimated per position where
  counts allow and pooled otherwise; the plan fixes the minimum-count rule.
- IR/reserve: `rosters_weekly` status `RES` counts as out. Return timing is not modeled
  beyond `p_stay`.
- **Walk-forward.** The table for test season S uses seasons 2012 to S−1 only. The live
  table uses seasons ≤ current−1. Rates are published with their counts and the seasons
  used.

## 5. Grade and market panel (trade page)

**Grade.** For each side, Δ = simulated ROS mean after − before. It is shown as a total
and per week, with the delta's p10–p90 range. The label compares |Δ| with the measured
error `E` for the trade's stratum (from the eval file):

- **Clear gain / Small gain / Too close to call / Small loss / Clear loss**
- The cutoffs (for example ±E and ±kE) are set by the §6 results and published in the
  eval file. They are not chosen in this spec.

The lineup summary shipped in 263c538 stays underneath as the explanation.

**Market check**, shown beside the grade and never blended into it.
- Each moved player's expert ROS rank, positional and overall, from
  `site/data/ros-ecr.json`.
- When the direction the ranks imply disagrees with the model's, a sentence names both
  and gives the roster reason; for example, the incoming player would sit behind a
  starter.
- A stale or missing ROS reference omits the check with the existing "ROS ranks
  withheld" reason. It is never faked.

Still not valued, and the page says so: draft picks and keeper value.

**Gate.** `seasontrademode.js` reads `trade_sim_eval.json`, published to `site/data/`.
- File missing, or `verdict !== "pass"`: the page stays today's conditional lineup
  scenario, including its forbidden-word rules.
- `verdict === "pass"`: the grade panel shows. The forbidden-word rules are replaced by
  the grade vocabulary (the five labels plus "not valued"); "accept", "fair" and "winner"
  stay forbidden.

## 6. The test (predeclared; results cannot change these rules)

6.1 **Leagues.** For each test season S ∈ {2023, 2024, 2025}: K = 20 synthetic 12-team
leagues drafted from S's preseason consensus via `eval/draft_world.py`
`build_season_world` (seeded), with Gabagool's slots; FAM's slots are a secondary case.
Rosters are frozen at the origin, with no in-season changes other than the trade.

6.2 **Trades.** For each league and origin, a frozen, seeded sample is generated before
any evaluation: 1-for-1, 2-for-1, 1-for-2 and 2-for-2 packages between pairs of rosters.
When a side goes over roster size, its lowest-p50 bench player is dropped. Strata:
- same-position swap;
- depth-for-starter (one side's received player would sit on the bench);
- cross-position;
- lopsided (|Δ| under the **current** method in the top decile of the test set; the
  decile cutoff is published so the live page can assign the same stratum).

Target: at least 5,000 trades per season.

6.3 **Prediction.** At origins 5 and 9, `rostersim.js` predicts weeks origin to 17
with the exported frozen forecasts (§2), the season's walk-forward availability table,
and injury tags from the `load_injuries` report for week origin−1. This mirrors the live
page: this week's tags, predictions starting next week.

6.4 **Realized.** Weeks origin to 17 are replayed with actual league-scored points and
actual participation. Each week's lineup is the best by that week's frozen p50 among the
players who actually played. An unfilled slot takes the undrafted player at an eligible position with the best
frozen p50 among those who actually played that week, scored at his actual points. No
hindsight: this is the same rule the lineup uses. This gives the realized Δ for each
side.

6.5 **Comparators and metrics.** Two comparators run through the same realized pipeline:
- (a) naive: four-game mean, everyone healthy, lineup only;
- (b) **current**: model p50, everyone healthy, lineup only (today's `ros.js` method).

Metrics, reported per stratum and per position:
- side-Δ MAE;
- sign accuracy;
- decision regret: realized points given up by following each method's accept/decline
  at threshold 0;
- 80% interval coverage (simulation only).

Uncertainty: a cluster bootstrap over (season, origin, league) with 2,000 resamples.

**Pass rule for the trade grade.** All three must hold:
- in the pooled set, the simulation's side-Δ MAE and regret are both lower than both
  comparators', and the 95% bootstrap interval of each difference excludes zero;
- no stratum where the simulation is worse than current by more than its interval;
- 80% interval coverage between 70% and 90%.

Label cutoffs: `E` is the simulation's side-Δ MAE for each stratum, published in the eval
file.

**Pass rule for waiver drop cost** (separate). Decisions: for each roster at each
origin, and for each of the 10 undrafted players with the highest frozen ROS p50, each
method picks which rostered player to drop for the add. Regret = the realized ROS roster
total of the best drop in hindsight minus that of the method's drop. The simulation must
have lower mean regret than current, with the 95% interval excluding zero. Otherwise the
desk keeps today's drop cost.

A failure is published as a result, on the about page and in the eval file, like the
draft experiments.

## 7. Tests

- `rostersim_fixture.cjs`:
  - the point distribution recovers the three quantiles;
  - the same seed gives the same result;
  - common random numbers: identical rosters give Δ exactly 0;
  - a backup behind a healthy starter has Δ > 0 only through absences and byes, and no
    more than his margin over replacement;
  - forced-out weeks;
  - replacement is never zero;
  - the timing budget.
- `test_availability.py`: participation classification on a synthetic frame (played /
  missed / not established), walk-forward exclusion of season S, and tag mapping.
- Backtest harness unit tests on a tiny synthetic season with a known answer.
- Existing trade and waiver fixtures stay unchanged while the gate is closed.

## 8. Limitations (shown on the page after a pass)

- Player outcomes are independent: no stack or game correlation.
- Injury timing comes from position rates and current tags, not from injury type.
- The test uses synthetic leagues, not real rosters.
- Rosters are frozen after the trade.
- Picks and keepers are not valued.
- Weeks after 17 are not modeled.

## 9. Out of scope

Trade suggestions and league-wide scans; pick and keeper valuation; blending expert ranks
into the number; start/sit changes; ESPN.

## 10. Amendment — test rules fixed before the full run (owner decisions 2026-09-28)

Made after the Task 4 review, before any full-run result existed. They supersede §6 where they differ.

1. **Waiver decision set.** Candidate adds per roster and origin are the top undrafted players by mean frozen p50
   over origin..17 with a per-position quota: QB 2, RB 3, WR 3, TE 2 (the §6.5 "top 10 by p50" was 100% QBs in a
   1-QB league). Every arm's replacement pool for a waiver decision excludes that add.
2. **Trade population.** A sampled trade is kept only if each side gives at least one player who is in its own
   current-method before-lineup in at least half the weeks origin..17 (frozen p50 only; decided before any
   prediction). `depth_for_starter` is redefined: a side gives at least one before-lineup starter and receives no
   player who starts in at least half the weeks of its after-lineup.
3. **Error band by horizon.** `E` per stratum and the lopsided cutoff are measured and published per origin
   (origin 5 = 13 weeks remaining, origin 9 = 9 weeks). The live page uses the origin whose remaining-week count is
   nearest to the live remaining-week count (ties → the shorter horizon). Slim eval file becomes `schema_version: 2`
   with `horizons: [{origin, weeks, strata:{name:{E,n}}, lopsided_cutoff}]` (and the same under `secondary`).
4. **Dropped cells fail closed.** If any planned primary (season, origin, league) cell is excluded, `verdict` and
   `waiver_verdict` are "fail"; the excluded count is published.
5. **Known before the full run (recorded 2026-09-28, before any full-run result).** A smoke run and a reviewer
   diagnostic showed the engine's season-total intervals are too narrow: weekly quantiles are calibrated (weekly
   p10–p90 coverage 0.76–0.80), but a player's forecast errors persist across weeks (between-player variance of mean
   residuals 1.7–3.0× the independent-weeks prediction), so 80% season intervals cover ≈0.65. The owner chose to run
   the test exactly as declared and publish the result, pass or fail. Any engine change prompted by this (e.g. a
   per-player persistent error term) is a v2 with its own predeclared test, evaluated prospectively on the 2026 season
   — never re-scored against 2023–2025, whose residuals were used to diagnose the problem.
6. **Bootstrap clusters (owner, 2026-09-28, before the full run).** Resample whole (season, league) clusters —
   origins 5 and 9 of one league share rosters and realized weeks 9–17, so they move together. Leagues within a season
   still share one set of real player outcomes; the write-up states this remaining dependence.
7. **Injured free agents (owner, 2026-09-28, before the full run).** Matching the live desk, undrafted players tagged
   Out or IR in the week origin−1 report are excluded from both the waiver add set and every arm's waiver
   replacement pool.
