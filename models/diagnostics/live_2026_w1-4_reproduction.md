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

**Astra's 2026-10-07 naive MAE 4.6757 — row-level reconciliation** (corrected 2026-10-11 from astra's build review,
`.review/astra-weeklyacc-build-response.md` fix 1; the first version of this note misdescribed astra's inputs).
Astra's earlier in-memory run used `weekly_v2_2012_2025.parquet` filtered to 2023–25 plus
`weekly_v2_2026_2026.parquet`. That older historical cache has none of the 2023–25 rows for one player, **Bo Melton
(`00-0037091`)**; the newer cache has 30. His last four historical PPR outcomes there (0, 0, 4.4, 0) replace the week-1
position-mean fallback and then enter his rolling history for weeks 2–4:

| Week | Actual | Earlier naive | Record's naive | Change in absolute error (record − earlier) |
|---|---:|---:|---:|---:|
| 1 | 2.0 | 7.1297 | 1.1 | −4.2297 |
| 2 | 0.0 | 2.0 | 1.6 | −0.4 |
| 3 | 0.0 | 1.0 | 1.6 | +0.6 |
| 4 | 0.0 | 0.6667 | 0.5 | −0.1667 |

Across the identical 1,367 scored keys no actual or published value changes. Total naive absolute error falls by
4.19635, i.e. 0.0030698 per row: **4.675700 → 4.672630**. That accounts for the whole difference. The baseline rule was
not changed. (Astra's reconciliation matched the record's enriched 2023–25 hashes exactly; its 2026 frame hash did not,
though it reproduced every pooled point metric and every secondary ranking cell.)

## Ranking: expected divergences

- **Primary (our archived FantasyPros snapshots).** Weeks 1–3 have no qualifying archive. Week 3's only archive was
  pushed at 2026-09-24T03:58:50Z, after that week's cutoff, and the cutoff is not moved. Week 4 selects
  `2026-w04-2026-09-30-5aec56b70c3784e6.json`; `…220d00155877a0a7.json` is listed, not used. The scratch had used
  `…220d…` by tie-break. Result: 4 cells (week 4), ours − consensus D = +0.009. That is one week and descriptive only.
- **Secondary (nflverse same-week, §5.2).** 16 cells over weeks 1–4: ours 0.590 vs consensus 0.628, D = −0.038,
  week-clustered CI [−0.056, −0.019]. Retained pools 266, 326, 320 and 325 players, with 40, 22, 22 and 23 projected
  played rows excluded because their game came before the scrape.
- **Why these differ from the scratch's 0.498 vs 0.515.** The scratch's corrected comparison (exact means 0.4977 and
  0.5146) used **our archived snapshots**, not nflverse, for **weeks 3–4 only** (269 and 252 joined players), with the
  scratch's tie-break archive for week 4 and no game-date filter. The record changes all four of those: week 3 drops
  out of the primary (archive pushed after the cutoff); week 4 uses the `…5aec…` archive, which raises the joined pool
  from 252 to 298 (46 played IDs added, none lost) and gives 0.6246 vs 0.6160 (D = +0.0086); and the secondary is a
  different source over weeks 1–4 with the §5.2 date filter. Source, weeks, archive and pool all differ, so these are
  different estimands and are not directly comparable.

## Provisional

Week 4 is provisional at this date (its last game was less than 8 days before the run). Later stat corrections would
change it, and the recorded input hashes make any revision traceable.
