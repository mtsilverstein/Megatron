# Weekly start/sit v1

Open `weekly.html?league=<league id>` for any Sleeper league, enter a Sleeper username, and load the roster.
The plan uses the selected league's modeled weekly scoring regardless of the ranking-table
filters below it. It does not change any lineup in Sleeper.

## Decision contract

The pure solver maximizes the sum of published skill-player p50 projections.
Dedicated QB/RB/WR/TE slots are filled before the two FLEX slots; existing
same-type assignments are preserved when equivalent. Kickers and defenses are
left unchanged, not evaluated. A bench comparison is the lowest-projected
unlocked starter that the bench player can directly replace legally.

Differences of at most three points are labeled close calls, not confidence
estimates. Overlapping marginal bands do not give pairwise win probabilities.
Questionable players remain eligible with warnings; Out, Doubtful, IR, PUP and
Suspended players are excluded, as are reserve/taxi and bye-week players.
Manual exclusions are temporary and reset on refresh.

Live roster and scoring settings are read from the connected league, and the NFL
season/week must match the published data. Unsupported slots, stale schedule/projection data, or a player whose
NFL team is missing from the kickoff schedule (unless he is excluded) block the full recommendation. The schedule
snapshot expires after seven days. Kickoff generation reads nflverse's Eastern
game times and converts them to UTC; it runs with weekly site generation.

One player or one slot no longer blocks the plan (audit 2026-11-07, A6-2 and A6-3). An available player with no
NFL team or no current-team projection is treated as unavailable: he scores 0, is not a candidate, and is named in
one note ("Not projected this week: … — treated as unavailable."). A slot that no available, projected player can
fill is left empty, scores 0 and says so ("No available TE this week — add one from waivers."); a FLEX goes empty
only when no eligible player is left, and the plan states how many empty slots score 0. There is still no lineup
total.

Started-game starters stay in their exact slots; started-game bench players
cannot enter. A kickoff crossing after roster retrieval requires another
refresh. The page checks its roster age every 15 seconds and keeps the plan
and marks it stale after 60 seconds. These are snapshot safeguards, not authoritative platform
lock detection: verify postponements and final availability in Sleeper.
The player/injury catalog is cached for the page session; reload the page to
refresh it. No current-news or matchup-win-probability model is included.

## Historical diagnostic

`site/data/start_sit_evaluation.json` holds the measured 2023–2025 walk-forward
report and provenance. Reproduce using the project Python environment:

```
python -m ffmodel.eval.start_sit --seasons 2023 2024 2025 --out report.json
```

Accuracy is 56.27% over 96,967 non-tied realized choices among same-position
pairs within three projected points, each projected at least five points.
Mean regret is 3.5881 points per pair. Week-one accuracy is 57.23%.

This is a played-only pair diagnostic, not actual roster decisions, and does
not measure cross-position FLEX choices or superiority to expert consensus.
Pairs reuse players and are dependent. Predictions include the deployed
prior-season pick-six expected-cost adjustment; realized pick-six penalties
and long-TD bonuses are unavailable in the historical inputs. This is therefore
the modeled scoring subset, not exact full Sleeper scoring. Do not infer a
validated in-season edge from this result.

Next evidence priorities: observed rare-event scoring, historical roster-aware
decisions including DNPs, a comparable expert baseline, and prospective logs
of dated recommendations and realized outcomes before tuning the model.
