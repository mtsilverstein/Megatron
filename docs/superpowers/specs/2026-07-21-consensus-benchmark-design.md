# Consensus benchmark (are we better than the experts?) — design

**Date:** 2026-07-21 · **Status:** approved
**Feature:** score our preseason draft board against the **expert consensus**
(FantasyPros ECR) on the same held-out seasons, using realized end-of-season
finish as truth. Answers the question the project has never asked: *is this
model actually better than what a drafter could get for free?*

## Motivation

Every benchmark so far has been internal — naive last-4 (4.612), XGBoost
(4.450), transformer (4.326). None of them tell us whether the board is
*good*, only that it beats our own baselines. The market benchmark is the
one that matters, and it is obtainable with zero leakage.

This also contextualizes the feature-pack-v2 negative result: if we sit far
behind consensus, the gap is unlikely to be closed by more in-season
box-score derivatives.

## Design

For each board season S ∈ {2023, 2024, 2025} — the same held-out seasons as
every other evaluation:

| Entrant | Source | Leak guard |
|---|---|---|
| **consensus** | FantasyPros ECR `redraft-overall`, latest snapshot **strictly before** S's first REG game | enforced in code, asserted in tests |
| **transformer** | our board's season projection from the artifact trained through S−1 | existing `board_world` boundary |
| **truth** | realized REG-season PPR total for S (`season_actuals`) | outcome, not input |

Verified snapshot dates: 2023-09-01 (kickoff 09-07), 2024-08-30 (09-05),
2025-08-29 (09-04). The naive "latest August scrape" would have selected
2023-09-08 — **after** kickoff — so the guard is load-bearing, not decorative.

### Shared harness (the fairness control)

`eval/board.py:board_metrics` scores "a list of player dicts as
`build_draft_board` emits" and already defaults players missing from actuals
to **0.0 points**. So the consensus entrant is shaped into that same dict
structure and run through the **identical** metric code — no bespoke metric
path can quietly favor either side.

Consensus has ranks, not points. Its dicts carry
`season_points.ppr.p50 = -ecr`, a strictly decreasing transform of rank:
ordering, pool selection, hit-rate, and Spearman are all rank-based and
therefore exact under it. Points-scaled metrics are **not** meaningful on
that synthetic scale and are emitted as `null` for consensus with a stated
reason — never published as numbers:

- `season_mae_topN` → null (consensus has no points)
- `season_band_coverage`, `band_miss_*` → null (consensus has no bands)

### Metrics reported

1. **`hit_rate_starters`** — *the headline*. Of a board's projected top-R at
   each position, how many actually finished top-R (R = `REPLACEMENT_RANK`:
   QB 13, RB 25, WR 25, TE 13) against the season's full leaderboard. Same
   R, same actual leaderboard for both entrants → **directly comparable**.
2. **`spearman_topN`** — rank correlation over each entrant's own draftable
   pool (top-2R per position, the existing convention). Reported with the
   caveat that the two pools are different player sets, so it answers "how
   well did you order your own recommendations."
3. **Common-universe Spearman** — computed over the **intersection** of
   players both entrants ranked, isolating pure ranking skill from universe
   coverage. Intersection size and dropped players are reported.

Overall + per position, for all three.

### Players who never played

Included, scored as **0 points** (already `board_metrics`' behavior).
Excluding them would be selection on the outcome — "only score players who
turned out to play" uses season-S information nobody had at ranking time —
and would erase a genuine consensus strength (fading camp-battle losers and
injury risks). The cost is variance, not bias: unforecastable injuries hit
both entrants equally.

A **sensitivity cut** (players with ≥8 games) is computed and clearly
labeled **diagnostic only, never the headline**, precisely because it *is*
outcome-selected. Agreement between cuts means the conclusion is robust;
divergence means the gap is injury luck rather than ranking skill.

## Data layer

`load_ff_rankings("all")` (nflreadpy 0.1.5) returns 1.79M rows back to
2019-12-27 with `ecr`, `sd`, `best`, `worst`, `page_type`, `ecr_type`,
`scrape_date`. Filter `ecr_type == "ro"` and `page_type == "redraft-overall"`,
then take the latest `scrape_date` strictly before kickoff.

Crosswalk to `gsis_id` via `load_ff_playerids()`'s `fantasypros_id` →
`gsis_id` (4,711 rows carry both), with a `merge_name` fallback. Measured
match rates on the skill-position snapshots: **99.8% / 100% / 99.6%**
(2023/24/25); the three unmatched across three years are fringe free agents.
Unmatched players are dropped from the consensus board and **counted in the
report** — a silent drop could bias the pool.

Scope filter: QB/RB/WR/TE only (v1 scope guard; ECR `redraft-overall`
includes K/DST).

## Pre-registered expectation

Recorded **before** running, same discipline as the feature-pack-v2 gate:

> **We expect to LOSE to consensus on hit-rate and Spearman.** ECR aggregates
> hundreds of analysts pricing in injuries, depth charts, holdouts, and scheme
> changes — none of which this model sees. A win should trigger a bug hunt
> before a celebration. n = 3 seasons carries the same small-sample caution
> that sank feature-pack v2; a narrow gap in either direction is not a result.

This is a **measurement, not a gate** — nothing is promoted or demoted by the
outcome, and no feature or hyperparameter may be changed in response to it
(that would be tuning against held-out data). Findings feed the methodology
writeup and any *future, separately pre-registered* work.

## Files

- `src/ffmodel/data/rankings.py` — pull + normalize ECR, leak-guarded snapshot
  selection, gsis crosswalk. Follows `pull.py`'s normalize-around-cache idiom
  so a stale cache can never bypass the guards.
- `src/ffmodel/eval/consensus.py` — build the consensus board, run both
  entrants through `board_metrics`, compute common-universe Spearman, emit the
  report + CLI.
- Report → `models/diagnostics/consensus_benchmark.json` (a new report shape,
  so it stays out of the **schema-locked** `models/backtests/`).

## Testing

Concentrated on the leak-prone and fairness-critical logic:

- **Leak guard:** a snapshot dated on/after kickoff is never selected; a
  fixture with scrapes straddling kickoff must pick the pre-kickoff one.
  Selecting from an empty pre-kickoff window raises rather than silently
  falling back to a post-kickoff scrape.
- **Crosswalk:** id-based match, `merge_name` fallback, unmatched players
  dropped *and counted*.
- **Rank transform:** `-ecr` preserves ECR ordering exactly (property test).
- **Shared harness:** the consensus board is accepted by `board_metrics`
  unchanged, and points-based metrics are nulled for consensus.
- **Common universe:** intersection logic drops the right players and is
  symmetric.
- Existing suite (322) stays green; `models/backtests/` untouched.

## Out of scope

Actual ADP (draft behavior) as distinct from ECR (expert opinion) — noted as
a follow-up, not built. Weekly-level consensus. Any model or feature change
in response to the findings. K/DST/IDP.
