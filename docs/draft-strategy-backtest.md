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

### How to count the sample (this changes the conclusion)

The harness runs 600 drafts per model, but **600 is not the sample size.** All
120 drafts within one season share the same player outcomes: if Bijan Robinson
busts in 2024, he busts in every one of them. Draft-level spread measures how
much the seat and the field's noise matter, not how much evidence there is
about the strategy. The independent unit is the **season**, and there are five.

Reported below as the mean of the per-season edges with a season-level standard
error. An earlier version of this document quoted `n=600`, which overstated the
precision considerably.

### Does the tool beat drafting the market?

| board | per-season edge (weeks 1–14) | mean | 95% CI |
|---|---|---|---|
| **transformer** (shipped) | −7, +5, +42, −10, −13 | **+3.3** | [−16, +23] |
| xgboost | −18, +63, +52, −1, +92 | +37.7 | [−3, +78] |

**Every interval crosses zero.** On the board we ship the tool is a coin flip
(50.5% of drafts beat the same seat drafting the market). And the XGBoost
"advantage" that looked large is **not statistically distinguishable from
zero** either — it rests on two good seasons out of five.

The honest summary is not "XGBoost drafts better". It is: **with five seasons,
this harness cannot detect an edge of the size we are looking for.** At a
season-level SE of ~20 points, only an edge above roughly +40 points would
clear the noise. Preseason ECR does not exist in this project before 2020, so
more seasons are not available to buy that power.

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

## The field model was the whole story

Symmetric jitter around ADP is **unexploitable by construction**. It is
zero-mean, so the field still drafts the consensus on average — and the board
*is* the consensus. There was nothing for a disciplined drafter to feed on.

`--field human` adds the two asymmetric behaviours real drafts visibly contain,
each with a per-drafter propensity drawn from the seed so a league holds both
calm and jumpy managers:

- **panic** — a drafter with no starting QB by round 9, or no TE by round 10,
  stops taking best-available and reaches;
- **runs** — three of the last six picks at one position pulls drafters into it.

| board | field | per-season edge | mean | 95% CI | beats the seat |
|---|---|---|---|---|---|
| transformer | consensus | −7, +5, +42, −10, −13 | +3.3 | [−16, +23] | 50.5% |
| **transformer** | **human** | **+52, +107, +72, +40, +63** | **+66.8** | **[+45, +89]** | **63.0%** |
| xgboost | consensus | −18, +63, +52, −1, +92 | +37.7 | [−3, +78] | 59.5% |
| xgboost | human | −16, +106, +59, +54, +134 | +67.8 | [+18, +118] | 63.5% |

Against a field that errs the way people do, the tool is worth about **+67
points over the fantasy regular season (~4.8 a week), it wins 63% of drafts,
and it lifts mean finish from 6.4 to 5.05 of 12.** This is the first interval in
the whole investigation that excludes zero, and it is positive in all five
seasons rather than resting on two good ones.

**The magnitude is not the evidence.** Making the field worse mechanically
raises our measured edge; that much is circular and was flagged before the run.
Two things that are *not* circular carry the finding:

1. **Consistency.** 5 of 5 seasons positive, interval clear of zero. The
   consensus-field arm never managed that.
2. **The model barely matters.** Transformer +66.8, XGBoost +67.8 — the two
   boards are indistinguishable once the field is realistic, despite very
   different projections and value curves.

Point 2 is the important one, and it reframes what this tool is:

> **The edge is discipline, not prediction.** It comes from not panicking for a
> quarterback in round 9, not chasing a run, always filling the lineup, and
> comparing flex candidates on absolute points — none of which depend on the
> projections being better than the market's. That is also why the value-curve
> calibration below changed nothing, and why the earlier XGBoost-vs-transformer
> gap was noise.

Sanity-checked against a degenerate field: rosters stay normal in both modes
(QB2/RB5/WR6/TE2, QB round 2–3, TE round 7–8) and the field's own mean score
barely moves (1636 → 1646). The opponents are not collapsing; they are paying a
diffuse cost that our seat collects concentrated.

## Tested and falsified: rescaling the value curve

The compression above is real and measurable. Per-position OLS of actual season
points on projected value points (draftable pool, per season) gives slopes
consistently above 1 for the transformer — **QB 2.1–4.3**, WR 1.2–2.0 — where
XGBoost sits near 1.0. So the natural fix: stretch the curve back out.

`ffmodel.eval.value_calibration` does this walk-forward — each season's board is
rescaled by a fit taken **only on strictly earlier seasons** (2023 from 2021–22,
2024 from 2021–23, 2025 from 2021–24), applied as `value' = max(0, a + b·v)`.
The method was written down before the evaluation ran; there is no shrinkage
parameter and no per-season override, so there is nothing to tune.

Fitted slopes were large and stable: QB 3.87 / 2.87 / 2.68, RB ~1.6, WR ~1.6,
TE ~1.1.

**It did not work.**

| transformer, 2023–25 | per-season edge | mean | 95% CI | beats the seat |
|---|---|---|---|---|
| uncalibrated | +42, −10, −13 | +6.1 | [−29, +41] | 49.7% |
| calibrated | −27, −12, +65 | +9.0 | [−47, +65] | 48.3% |

The mean moved +6.1 → +9.0, far inside the noise; the win rate went *down*; mean
finish was unchanged (6.28 → 6.29 of 12). Per season it simply reshuffled which
years were good — 2023 went +42 → −27, 2025 went −13 → +65. That is noise being
redistributed, not an edge being unlocked.

**Conclusion: the compression is a real property of the transformer's
projections, but it is not what was costing the draft tool its edge.** The
calibration is kept as an eval tool with this negative result attached. It is
deliberately NOT wired into the live board: it changes every published number
and buys nothing measurable.

## Open questions

1. How much of the human field's two behaviours does a real league show? The
   panic rounds (QB 9, TE 10) and run trigger (3 of 6) are behavioural priors,
   not fitted — a Sleeper draft log would let them be measured instead of assumed.
2. Does the same discipline finding hold WEEKLY? `weekly_consensus.json` already
   shows our weekly ranking ties the market (delta −0.0018, interval includes
   zero), so any weekly edge would have to come from the same place this one did
   — bye and injury handling, and always fielding a legal best lineup — rather
   than from better prediction.
3. Is season-median the right lens for the value curve at all — the compression
   may originate in the availability simulation rather than the quantile head.

**Against a field that drafts the consensus perfectly, the tool is a coin flip;
against a field that errs the way people do, it is worth ~+67 points and wins
63% of drafts.** Both statements are true and neither is the whole picture. Your
league is somewhere between the two, and closer to the second.

The claim this evidence supports is *not* "our projections beat the market" —
they do not, measurably. It is "acting on a consistent lineup-aware rule beats
drafting by feel", which is what the tool actually enforces.

## Current-season dry run

`node tools/draft_sim.cjs --board site/data/draft.json --seeds 5` simulates the
2026 draft from every seat. There is no answer key, so it can only show what the
tool *does*, never whether it is right: 60 drafts, 51 of 60 finishing
QB2/RB5/WR6/TE2, median first TE round 5, never leaving a lineup slot unfilled.
Written to `models/backtests/draft_strategy/draft_dryrun.json`.
