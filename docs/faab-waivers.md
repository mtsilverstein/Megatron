# Gabagool FAAB desk

Open `waivers.html?league=gabagool`, enter your Sleeper username, and load the league. This is a read-only planning tool: it cannot submit bids, claims, or roster moves. No login token is needed or stored. Other leagues are intentionally unsupported.

## First release

- Reads every live roster, including IR/taxi, and matches your owner/co-owner account uniquely.
- Checks the live scoring, roster, season, league size, and FAAB contract against the Gabagool board.
- Reads remaining FAAB, subtracts a user-selected reserve (default $20, not an optimized amount), and caps each independent bid alternative.
- Protects starters initially and always excludes IR/taxi and unmapped players from drops.
- Compares legal skill-position lineups before and after individual add/drop swaps. K/DST are outside this model.
- Uses weekly projections only when their league/scoring, season, week, and timestamp match. Missing player projections are excluded, never replaced with season totals in the same comparison.
- Otherwise labels its remaining-season estimate as a rough preseason proxy. This is not a live role forecast or a week-by-week schedule optimizer.
- Lists available preseason-ECR players separately for stash review. Ownership is live at refresh time; waiver eligibility and claim deadlines must still be checked in Sleeper.
- Exports a copyable shortlist. Alternatives can reuse a drop or collectively overspend: they are not a combined claim queue.

Injury tags come from a session-cached Sleeper catalog, with its retrieval time displayed. They are not a live injury-news service. Refreshing rosters does not refresh that bulk catalog; reload the page if a new catalog is needed. Independently verify current game status and role.

The September 9 Week 1 file is newly generated but uses historical data through 2025 Week 18. Rookies without historical weekly projections remain a coverage gap. The draft board and stash list retain them; the weekly swap model must not invent their value.

## Bid interpretation

Positive projected lineup gains below 2 points use a 1–3% starting-budget band; 2–5 use 4–10%; 5+ use 11–20%. The preseason proxy divides its gain by remaining weeks before applying those bands. These thresholds are **uncalibrated heuristics**, not market prices, winning-bid probabilities, or expected championship value. A zero-gain result does not mean a player lacks injury-contingent upside. Do not spend merely because budget remains.

## Building the actual in-season edge next

1. Ingest weekly snaps, routes, targets, carries, red-zone usage, and verified injury/role changes. Track opportunity changes before box-score breakouts.
2. Add rookie and returning-player weekly projections with honest uncertainty; score contingencies and multi-week bye coverage, not just an optimal static lineup.
3. Record completed league waiver bids and manager needs. Distinguish observed winning bids from hidden losing bids; backtest bid calibration before presenting probabilities.
4. Build ordered claim groups with fallback players, shared-drop conflict detection, and total-budget constraints.
5. Add Gabagool keeper eligibility/value and evaluate stash value against the actual cost of the bench slot.

The first release is the safe ownership/budget/lineup foundation for this work, not evidence that those advantages have already been achieved.

## Validation

`node tests/waivers_fixture.cjs` checks scoring, ownership, protected/locked players, freshness, roster legality, budgeting, randomized brute-force lineup equivalence, and a full-size performance bound. `node tests/waivermode_fixture.cjs` checks the read-only adapter contract. All `tests/*_fixture.cjs` files are discovered by CI.
