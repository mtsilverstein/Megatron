# Draft-strategy backtest — method and findings

**Date:** 2026-08-03

The board backtest (`ffmodel.eval.board`) asks *is the projection right?*. This
one asks the question the draft tool actually makes a claim about: **does acting
on our numbers beat drafting straight off the consensus board?**

## Method

For each historical season S:

1. `ffmodel.eval.draft_world` reconstructs the August world — weekly history
   strictly before S (`board.board_world`), a preseason ECR snapshot taken
   strictly before week-1 kickoff (`rankings.consensus_for_season`), and a
   predictor fit on that cut world only. It builds a **consensus-anchored
   board** through the production `build_draft_board` path, exactly as the live
   site does.
2. It exports the answer key: every player's **weekly** actual PPR points for S.
   Weekly, not season totals — a fantasy team only banks its best startable
   lineup each week, so when the points arrived matters.
3. `tools/draft_sim.cjs` runs a 12-team, 15-round snake draft in which one seat
   uses the **real shipped `site/assets/optimizer.js`** and the other eleven
   draft the market. Every roster is then scored on actual weekly points, best
   legal lineup re-picked each week.
4. The counterfactual is **the same seat, same seed, same field, drafting the
   market instead** — so draft position and luck of ordering cancel, and the
   only difference is the strategy.

Reproduce:

```
python -m ffmodel.eval.draft_world --seasons 2021 2022 2023 2024 2025 \
    --model transformer --artifact-root models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44 \
    --out-dir models/backtests/worlds_tf
node tools/draft_sim.cjs --worlds models/backtests/worlds_tf --seeds 10
```

The transformer is leak-free here because its artifacts are stored per training
cutoff (`through2016` … `through2025`) and `fit()` selects by the train set's
max season — a 2023 board loads `through2022`.

### What this cannot tell you

- **The field is a market-follower with noise**, not a model of specific humans.
  Real leagues have reaches, runs and homers.
- **No in-season management.** Waivers, trades and start/sit decide a large
  share of real outcomes and none of them are simulated.
- **Historical ADP does not exist in this project**, so the market is proxied by
  preseason ECR (recorded as `market_source: preseason_ecr`). ECR and ADP are
  close but not identical.
- Because the optimizer's own field model and the simulated field both read the
  same market column, the optimizer's view of the field is right apart from the
  noise. Real drafts are less kind. The noise level is swept (`--noise`) so the
  conclusion can be checked against the assumption.

## Findings

600 drafts per model (5 seasons × 12 seats × 10 seeds), weeks 1–14:

| board | edge vs same seat drafting market | beats it | mean finish |
|---|---|---|---|
| **transformer** (shipped) | **+3.3 pts** | 50.5% | 6.37 / 12 |
| xgboost | +37.6 pts | 59.5% | 5.74 / 12 |

**On the board we actually ship, the draft tool is a coin flip.** That is the
headline and it is not flattering.

### Why: the transformer's value curve is compressed

Its projections are *more accurate* by MAE (68–74 vs 81–88 in the board
backtest) and *less useful for drafting*. Measured across all five seasons, the
top-1 to top-12 spread of the value curve:

| | RB1−RB12 | WR1−WR12 | TE1−TE12 | QB1−QB12 |
|---|---|---|---|---|
| xgboost | 77–258 | 64–134 | 85–195 | 60–91 |
| transformer | 43–88 | 33–59 | 59–72 | 32–42 |

Roughly half the spread, in every position and every season. A compressed curve
means smaller gaps between candidates, which means the lookahead finds less to
gain from any particular pick, which means more ties — and a tie falls through
to best-available, which *is* the market. The tool converges on drafting the
consensus, and the edge goes to zero. The +3.3 result is that mechanism.

The transformer also rates QB higher relative to RB in all five seasons
(QB1/RB1 1.05–1.44 vs 0.79–1.22), so it drafts quarterbacks earlier.

This is the classic shrinkage trade-off: **MAE rewards predicting closer to the
mean, and a shrunk projection is worse for ranking and worse for decisions even
while it scores better on error.** It connects directly to the pre-registered
conditional-mean head experiment — that work should be evaluated on decision
quality here, not only on MAE.

### The structural ceiling

The board is **consensus-anchored**: the ordering is ECR, and the model supplies
only the value curve and the bands. The simulated field drafts that same ECR
ordering. So the tool cannot express "we like this player more than the market"
— that degree of freedom was deliberately given up when consensus anchoring was
adopted. All the remaining edge has to come from roster construction: filling
slots, comparing flex candidates on absolute points, spreading byes, timing.

A single-digit-to-modest edge is therefore the *expected* size of the prize, not
a surprise. Anyone reading this should not expect a consensus-anchored draft
tool to produce a large edge over the consensus.

## Open questions

1. Is the transformer's compression a calibration artifact that can be undone
   without hurting MAE? If the value curve is rescaled to match the realised
   spread, does the draft edge appear?
2. Should the board's value curve come from a different lens than the season
   median — the compression may be coming from the availability simulation.
3. Is the xgboost result real or noise? +37.6 with a p10 of −225 is a wide
   distribution; the per-season edges range from −18 to +92.

None of these are answered here. **The tool ships on the transformer board, and
on that board it is currently indistinguishable from drafting the market.**

## Current-season dry run

`node tools/draft_sim.cjs --board site/data/draft.json --seeds 5` simulates the
2026 draft from every seat. There is no answer key, so it can only show what the
tool *does*, never whether it is right: 60 drafts, 51 of 60 finishing
QB2/RB5/WR6/TE2, median first TE round 5, never leaving a lineup slot unfilled.
Written to `models/backtests/draft_dryrun.json`.
