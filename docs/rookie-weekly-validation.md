# Weekly rookie-prior diagnostic

Run `python -m ffmodel.eval.rookie_weekly --league gabagool --out models/diagnostics/rookie_weekly_gabagool.json`
(or `--league fam` with its own output path).

This evaluates the existing draft-capital component-stat median prior against
the same prior collapsed to position-only cohorts. Nothing is wired into live
weekly projections or trade scenarios. External ECR/FPTS are not inputs.

Training uses only draft classes and observed weeks before the held-out season.
The default held-out classes are 2023–2025, origins 1/5/9, horizons 1/2/4/8.
Origin eligibility uses only pre-origin NFL records: zero history or one to
three recorded games. More experienced players are excluded. These are drafted
rookies, not returning veterans or undrafted players.

The initial run produced the following zero-history results for both configured
Sleeper leagues. Their scoring differences do not affect this supported-stat
comparison; pick-six costs are excluded on both predictions and actuals.

| Position | Recorded comparisons | Capital-prior MAE | Position-only MAE |
| --- | ---: | ---: | ---: |
| QB | 54 | 8.15 | 8.67 |
| RB | 159 | 4.33 | 4.94 |
| WR | 258 | 4.40 | 5.05 |
| TE | 93 | 3.88 | 4.05 |

The one-to-three-recorded-games group improved for QB/RB/WR, but TE error rose
from 2.99 to 3.06. These are descriptive comparisons, not a promotion gate or
independent trials. Report cells preserve each season/origin/horizon separately.

## Limits and next gate

Missing target records remain unknown, not zero. Unidentified draft picks retain
distinct draft-slot identities and missing coverage instead of guessed name
matches. Forecasts do not predict participation, injury return dates or roles.
The prior ignores early rookie performance and remains constant across horizons.
Scored component medians are not a calibrated fantasy-points median or interval.

Before using this in a trade tool, evaluate how rookie priors affect actual
lineup choices against established players, audit per-season/horizon stability,
and preserve explicit participation assumptions. A separate solution is still
needed for veteran history gaps and live identity conflicts. The production
coverage guard remains unchanged.
