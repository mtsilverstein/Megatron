# Weekly start/sit v1

Open `weekly.html?league=gabagool`, enter a Sleeper username, and load the roster.
The plan uses Gabagool's modeled weekly scoring regardless of the ranking-table
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

Live roster/scoring settings and NFL season/week must match the published
contracts. Missing eligible projections, unknown teams, unsupported slots or
stale schedule/projection data block the full recommendation. The schedule
snapshot expires after seven days. Kickoff generation reads nflverse's Eastern
game times and converts them to UTC; it runs with weekly site generation.

Started-game starters stay in their exact slots; started-game bench players
cannot enter. A kickoff crossing after roster retrieval requires another
refresh. The page checks its roster age every 15 seconds and hides the plan
after 60 seconds. These are snapshot safeguards, not authoritative platform
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
