# Gabagool FAAB desk

Open `waivers.html?league=gabagool` or `waivers.html?league=fam`, enter your Sleeper username, and load the league. This is a read-only planning tool: it cannot submit bids, claims, or roster moves. No login token is needed or stored. FAM uses rolling-priority guidance without dollar bids; Gabagool uses the FAAB guidance below. Other leagues remain unsupported. See `multi-league-tools.md` for coverage and the general-purpose roadmap.

## First release

- Reads every live roster, including IR/taxi, and matches your owner/co-owner account uniquely.
- Checks the live scoring, roster, season, league size, and FAAB contract against the Gabagool board.
- Reads remaining FAAB, subtracts a user-selected reserve (default $20, not an optimized amount), and caps each independent bid alternative.
- Protects starters initially and always excludes IR/taxi and unmapped players from drops.
- Compares legal skill-position lineups before and after individual add/drop swaps. K/DST are outside this model.
- Uses weekly projections only when their league/scoring, season, week, and timestamp match. Missing player projections are excluded, never replaced with season totals in the same comparison.
- In-season stale, missing or misaligned weekly data withholds lineup gains and bid recommendations. Research/watchlists remain available. The pure engine retains a labeled preseason proxy outside in-season mode; the live desk requires an in-season league.
- An unprojected owned player who could contribute to an unstarted lineup blocks comparisons, even when other players can fill every slot. Protecting that player from drops alone would not make an incomplete baseline reliable.
- Lists available preseason-ECR players separately for stash review. Ownership is live at refresh time; waiver eligibility and claim deadlines must still be checked in Sleeper.
- Exports a copyable shortlist. Alternatives can reuse a drop or collectively overspend: they are not a combined claim queue.

Injury tags come from a session-cached Sleeper catalog, with its retrieval time displayed. They are not a live injury-news service. Refreshing rosters does not refresh that bulk catalog; reload the page if a new catalog is needed. Independently verify current game status and role.

The September 9 Week 1 file used historical data through 2025 Week 18; that was a point-in-time limitation, not the current refresh state. The September 15 audit found deployed Week 2 projections through 2026 Week 1. Players without weekly projections remain a coverage gap. The draft board and stash list retain them; the weekly swap model must not invent their value.

## Research radar (second iteration)

The new research queue combines current league availability with Sleeper's top-100 add/drop feeds over 24 hours. Counts are platform-wide, not league-specific; absent players are labeled "Not listed," never zero. Optional trend-feed failures leave the rest of the desk usable with an explicit warning. A trending player missing from the projection board can appear using catalog identity, but receives no invented ECR or projection.

Roster-fit order puts players with unavailable injury tags last, then same-team RB research candidates, then preseason ECR, bye-fit count, and observed adds. This is an explicit research ordering, not an optimal buy ranking. A separate most-added order highlights market attention. Sharing an NFL RB room does not establish depth-chart order or an injury-beneficiary role; verify usage and team reports before acting.

The bye view counts known active-roster players against dedicated QB/RB/WR/TE requirements through Week 17. It distinguishes a shortfall from merely having no spare. It does not force RBs into FLEX or treat today's injuries as permanent; future health is assumed. IR/taxi are excluded, unknown byes warned, and a changed NFL team invalidates an old board bye.

The selected week's completed waiver transactions supply observed winning bids only. Free-agent moves are counted separately; pending, duplicate, missing-price, and non-waiver records do not become bid samples. No losing bids or minimum winning prices are inferred. This is evidence collection, not calibrated market pricing.

Source: [Sleeper API documentation](https://docs.sleeper.com/#trending-players).

## Observed role growth (third iteration)

`roles.json` is generated alongside the weekly slate by the existing scheduled pipeline. It uses nflverse regular-season player statistics and joined PFR offensive snap shares already ingested by the project. Only the selected season's completed games before the selected week are eligible. The waiver page requires the same season/week and a file generated within 72 hours. Data generation time is not game time; the observed week and team-game coverage are shown separately.

For each mapped available player, the research table shows latest targets, carries, snap share, target share, and share of tracked QB/RB/WR/TE carries. It compares the latest game to up to three preceding completed same-team games. At least two prior games must have player rows; missing games, team changes and stale player observations suppress growth comparisons. Missing snap/share values remain unknown, never zero. Different denominators are not blended into a single opportunity score.

Research flags (not calibrated predictions):

- At least six targets in the latest observed game.
- At least eight carries and 40% of tracked skill-player team carries.
- Snap share increases by at least ten percentage points, alongside target share increasing five points or carry share increasing ten points.

Workload-level flags can appear after one game; growth flags need at least three comparable observations in total. This is deliberately a research trigger, not a probability of a breakout, causal proof of a role change, or an automatic change to a bid. "Observed usage flags first" sorts the research queue, and exports retain source weeks and raw metrics.

No route participation, red-zone usage, or verified injury-beneficiary mapping is supplied by this layer. Snap share must not be described as route participation. Zero-stat players absent from the upstream player-stat rows remain a coverage limitation. A team change invalidates old-team usage in the browser. Trending players without a GSIS-to-Sleeper board mapping remain research-only without attached usage.

Before 2026 Week 1, the real source returns no current-season observations. The published payload explicitly waits for data rather than treating historical season usage as new growth. It distinguishes this from completed games with missing source rows.

## Bid ranges

Drop cost is priced from the model's remaining-season projections (`remaining-<league>.json`, generated with the weekly slate): the change in your own lineup's projected points over the remaining weeks, split into what the add contributes to your roster and what the drop then forfeits with the add on it. A bench player who never starts forfeits little whatever his season total. The projections assume participation; injuries and returns are not forecast.

Spend guidance reads this week's lineup gain plus that rest-of-season change, averaged per remaining week (including this one), through the same bands as before: under 1 point/week no guidance (weak signal, an explicitly unvalidated product cutoff); 1 to below 2 points use a 1–3% starting-budget band; 2–5 use 4–10%; 5+ use 11–20%. A swap whose drop forfeits more than the add returns shows both numbers and receives no bid or priority claim; it is not called wrong. When the add or the drop has no rest-of-season projection, or the payload is missing, stale (over 72 hours) or misaligned with the league, the drop cost is unassessed and no spend guidance is offered for that swap — unknown is never priced as zero. Open-slot adds use the same basis when the add is priced, so a one-week fill now earns a smaller band than a season-long upgrade. These thresholds are **uncalibrated heuristics**, not market prices, winning-bid probabilities, or expected championship value. Do not spend merely because budget remains.

The remaining-season projections' measured accuracy (model MAE against a four-game average, by horizon) is carried in the payload's `evaluation` block and shown on the page; see `remaining-season-projections.md`.

## Building the actual in-season edge next

1. Ingest weekly snaps, routes, targets, carries, red-zone usage, and verified injury/role changes. Track opportunity changes before box-score breakouts.
2. Add rookie and returning-player weekly projections with honest uncertainty; score contingencies and multi-week bye coverage, not just an optimal static lineup.
3. Record completed league waiver bids and manager needs. Distinguish observed winning bids from hidden losing bids; backtest bid calibration before presenting probabilities.
4. Build ordered claim groups with fallback players, shared-drop conflict detection, and total-budget constraints.
5. Add Gabagool keeper eligibility/value and evaluate stash value against the actual cost of the bench slot.

The first release is the safe ownership/budget/lineup foundation for this work, not evidence that those advantages have already been achieved.

## Validation

September 15 read-only audit: both Max973 Sleeper leagues loaded against deployed
Week 2 data and live rosters. With current starters protected, Gabagool produced
10 independent alternatives; FAM produced no positive modeled swaps. These are
snapshot-specific outputs, not recommendations to submit all alternatives.
Research contained 205/220 available players, respectively, with observed usage
attached to 122/141. The roles payload covered 32/32 Week 1 team-games. Simulating
a missing weekly payload withheld recommendation rows while retaining the inputs
needed for research. This was an engine/API integration check, not a visual
browser or actual claim-submission test. No platform writes occurred.

The recommendation, adapter and research fixtures passed, as did 17 Python
weekly/roles/kickoff tests. Claude Sonnet performed a bounded read-only review of
ownership, drop protection and budgets; the additional stale-data and incomplete
baseline guards came from integration review. The waiver stack has no dependency
on the experimental remaining-season trade engine. Its rookie coverage problem
is shared in concept, but it does not need to wait for trade development.

Remaining priorities: browser interaction checks, explicit roster-specific
coverage display, and claim-group conflict/budget planning. Bid bands remain
uncalibrated; these checks do not establish forecast accuracy or a FAAB edge.

`node tests/waivers_fixture.cjs` checks scoring, ownership, protected/locked players, freshness, roster legality, budgeting, randomized brute-force lineup equivalence, and a full-size performance bound. `node tests/waivermode_fixture.cjs` checks the read-only adapter contract. All `tests/*_fixture.cjs` files are discovered by CI.
