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

## Rookie-versus-veteran decision probe

Add `--decisions` and use a separate `rookie_decisions_<league>.json` output.
Veterans are selected before the origin from the fixed QB24/RB60/WR72/TE24 pools,
ranked by their last four recorded games. They need at least four history rows
and a record from the current or previous season. Their frozen last-four-game
mean is held constant between the two rookie-prior methods. Each eligible rookie
is paired with each same-position veteran; this is not a historical roster
replay, full lineup optimization, or a test against transformer veteran forecasts.

Both players must have target records. Changed veteran teams/positions and
changed rookie positions are excluded. Ties in either forecast exclude the pair
from both methods; actual ties have zero regret but do not count toward accuracy.
Regret is the observed point loss from choosing the worse of the two players.

In the initial Gabagool run, zero-history RB pairwise accuracy rose from 74.0%
to 76.1%, with mean regret dropping from 1.93 to 1.70 points. WR mean regret fell
only from 1.83 to 1.81; QB and TE choices were unchanged. There were just 154 RB
and 37 WR disagreements, despite thousands of repeated pair comparisons.
Those changed choices involved only nine distinct zero-history RBs and seven WRs.

The RB benefit was not uniform: mean regret improved by about 0.33 points in
2023 and 2025 but worsened by 0.02 in 2024. Reports retain per-season summaries
and the identities of rookies involved in changed decisions to expose
concentration. Do not interpret aggregate pair counts as independent evidence
or these descriptive gains as expected real-roster points. This is not sufficient
to enable a general-purpose rookie fallback in live advice.

## Transformer veteran comparison

Use `--decisions --veteran-model transformer` to replace veteran last-four-game
forecasts with the deployed three-seed transformer ensemble. Pool selection
remains based on pre-origin last-four-game averages; it does not change to favor
the transformer. Both rookie-prior methods face identical veteran forecasts.
The adapter loads artifacts through the previous season, freezes history before
the origin, and rebuilds each target horizon independently. It uses the weekly
page's component scoring path with the diagnostic's supported-stat rules.

Missing veteran predictions (including byes) are counted as `unprojected_pairs`,
never filled from the last-four baseline or treated as zero. This counter is
separate from missing/changed actual records. No live roster lookup is used;
historical schedule revisions are not reconstructed.

The first bounded run uses classes 2023–2025, origin week 1, and horizons 1/4:
`python -m ffmodel.eval.rookie_weekly --decisions --veteran-model transformer --origins 1 --horizons 1 4 --out models/diagnostics/rookie_transformer_probe_gabagool.json`.
It is a week-one feasibility probe, not the full origins 1/5/9 matrix or a test
of low-history in-season updates. Live forecasts remain unchanged.

The completed Gabagool probe compared capital-prior versus position-only rookies
against the same transformer veteran forecasts:

| Position | Evaluated pairs | Capital mean regret | Position-only mean regret |
| --- | ---: | ---: | ---: |
| QB | 305 | 3.36 | 3.45 |
| RB | 2,544 | 1.51 | 2.23 |
| WR | 6,020 | 1.72 | 1.86 |
| TE | 638 | 1.74 | 1.75 |

RB regret improved in each of the three seasons (approximately 0.77/0.65/0.71
points per evaluated pair). WR worsened in 2023 despite improving in aggregate;
TE worsened in 2023/2024 and QB worsened in 2025. There were only five changed QB
choices. The stored report includes all per-season counts and changed rookie IDs.
None of these pairs are independent real-roster trials. This run does not prove
a gain from replacing the veteran baseline with the transformer: the measured
contrast is between the two rookie priors with transformer veterans held fixed.

Only the Gabagool transformer probe was executed for this milestone. The CLI
supports FAM, but the prior last-four-veteran reports for both leagues are not
being relabeled as transformer results. Next validation is later-season origins,
where rookie usage exists and a frozen draft-capital prior may be inadequate.

## Later-season transformer result

`rookie_transformer_inseason_gabagool.json` extends the test to origins 5 and 9,
horizons 1 and 4, and held-out classes 2023–2025. It still compares the unchanged
capital prior with the position-only rookie prior, holding transformer veteran
forecasts fixed. It does **not** update rookie forecasts from their observed games.

| Position | History group | Evaluated pairs | Capital minus position-only mean regret |
| --- | --- | ---: | ---: |
| QB | Zero recorded games | 80 | -0.245 |
| RB | Zero recorded games | 184 | +0.059 |
| WR | Zero recorded games | 443 | -0.222 |
| TE | Zero recorded games | 88 | -0.018 |
| QB | One to three recorded games | 323 | -0.397 |
| RB | One to three recorded games | 977 | -0.135 |
| WR | One to three recorded games | 2,133 | +0.004 |
| TE | One to three recorded games | 526 | -0.001 |

Negative regret differences favor the capital prior. These dependent pair counts
are not independent sample sizes. The low-history QB improvement came entirely
from 2023; low-history RB regret worsened in 2025 despite aggregate improvement.
Zero-history RBs worsened overall, driven by 2024. Thus the week-one RB result is
not evidence for a universal in-season fallback.

Both configured Sleeper leagues were checked to have identical complete rules
objects after disabling pick-six scoring for this diagnostic. The single stored
run is labeled Gabagool; it is not a second independent FAM experiment, and this
equivalence does not claim that every platform scoring event is modeled.

Decision: keep live coverage guards unchanged. Next compare pre-origin observed
rookie stat averages against the frozen capital prior for the one-to-three-game
group, on the same candidate pairs. Do not select a blend weight against these
held-out results or quietly assign zero to rookies who have no NFL record.
