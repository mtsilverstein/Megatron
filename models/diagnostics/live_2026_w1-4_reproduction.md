# Live accuracy, 2026 weeks 1–4: frozen reproduction notes

Record: `live_2026_w1-4_reproduction.json`, produced 2026-10-10 by
`python -m ffmodel.eval.live_accuracy --weeks 1-4 --no-fetch --frozen-record models/diagnostics/live_2026_w1-4_reproduction.json`
at main `31acd59` (evaluator `live-accuracy-v1+05abe169…`, clean tree). Spec §4.5 asks that every divergence from the
2026-10-06 scratch measurement be accounted for, and that no rule be adjusted to match it.

## Publications (§4.1)

All four weeks select the expected bot publications, proven by push events in the committed ledger:

| Week | Commit | Push time (UTC) | Ledger event |
|---|---|---|---|
| 1 | `b451562` | 2026-09-02T09:45:11Z | 42252143603 |
| 2 | `fa9c095` | 2026-09-16T20:15:31Z | 43788243336 |
| 3 | `fbd66fd` | 2026-09-23T20:33:45Z | 44399334367 |
| 4 | `d43adc4` | 2026-09-30T21:32:42Z | 45080594300 |

## Point metrics: no divergence

| Measure | Scratch (2026-10-06) | Record | Note |
|---|---|---|---|
| Player-weeks scored | 1,367 (astra, 2026-10-07) | 1,367 | — |
| MAE of p50 | 4.359 | 4.35924 | match |
| p10–p90 coverage | 0.797 | 0.79663 | match |
| Naive last-4 MAE | 4.673 | 4.67263 | match |
| Model − naive | −0.313, CI [−0.492, −0.135] | −0.31339, player CI [−0.4922, −0.1350] | match; the record adds a `week|team` CI [−0.5230, −0.1067] |

Astra's 2026-10-07 in-memory run reported naive MAE 4.6757. Astra built that run from a 2012–2026 weekly cache that
ended at week 3 plus a separate 2026 cache; it was not pinned to the scratch vintage (its own response says so). The
record, built by the shipped code from one pull, gives 4.67263, matching the scratch. No rule was changed.

## Ranking: expected divergences

- **Primary (our archived FantasyPros snapshots).** Weeks 1–3 have no qualifying archive. Week 3's only archive was
  pushed at 2026-09-24T03:58:50Z, after that week's cutoff, and the cutoff is not moved. Week 4 selects
  `2026-w04-2026-09-30-5aec56b70c3784e6.json`; `…220d00155877a0a7.json` is listed, not used. The scratch had used
  `…220d…` by tie-break. Result: 4 cells (week 4), ours − consensus D = +0.009. That is one week and descriptive only.
- **Secondary (nflverse same-week, §5.2).** 16 cells over weeks 1–4: ours 0.590 vs consensus 0.628, D = −0.038,
  week-clustered CI [−0.056, −0.019]. The scratch's corrected comparison (weeks 3–4 only, 0.498 vs 0.515) used a
  different population: all players with a stat line, whereas §5.2 keeps only players whose game came after the
  scrape. These are different estimands, so the numbers are not directly comparable.

## Provisional

Week 4 is provisional at this date (its last game was less than 8 days before the run). Later stat corrections would
change it, and the recorded input hashes make any revision traceable.
