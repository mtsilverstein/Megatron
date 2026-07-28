# Methodology & honest results

A fantasy-football projection model is easy to build and hard to trust. This
document is the trust part: what the model is, how it is evaluated, where it
genuinely stands against the alternatives a real drafter has, and — at least
as important — what was tried and *didn't* work, with the reason in each case.

Every number here is measured walk-forward on held-out seasons the model never
trained on. Nothing was tuned against those seasons. Where a result is within
statistical noise, it is reported as within noise rather than rounded into a
win.

---

## 1. What the model is

A small quantile [transformer](../src/ffmodel/model/net.py) (≈343 K
parameters: `d_model` 96, 3 layers, 4 heads) trained on a free Kaggle T4. For
each player-week it reads the player's previous 16 games and predicts the
**raw stat line** — passing/rushing/receiving yards, touchdowns, receptions,
interceptions, fumbles — as **three quantiles (p10 / p50 / p90) per component**
via pinball loss. Fantasy points are then computed from the predicted stats by
pure scoring functions, so PPR is the default and half-PPR / standard derive
for free, and the p10/p90 stat quantiles become sign-coherent **floor and
ceiling point bands**.

Design commitments that shape everything below:

- **Raw stats, never points directly.** Points are a deterministic function of
  the stat line, so the model never has to relearn the scoring system.
- **Walk-forward evaluation only.** Train on seasons ≤ S, test on S+1; the
  held-out years are 2023, 2024, 2025. Random train/test splits are forbidden
  — the rolling features would leak the future into the past.
- **Free tiers only.** Training on Kaggle (30 GPU-h/week), weekly inference and
  publishing on GitHub Actions + Pages. No paid infrastructure, ever.
- **Baselines run through the identical harness** — a naive last-4-game average
  and an XGBoost model — and results are reported honestly whichever wins.

## 2. How claims are kept honest

Two failure modes dominate sports-modeling writeups: leakage (using
information that wasn't available at prediction time) and the garden of
forking paths (trying many things and reporting the one that looked good). The
project guards against both explicitly:

- **Pre-registration.** Every experiment's success criterion is written down —
  in the project ledger, before the result is seen — and the verdict is read
  off that criterion afterward. Several experiments below *passed the letter*
  of a criterion and were still declined because the effect was within noise.
- **Adversarial review.** Substantive changes are reviewed by an independent
  pass whose job is to break the claim. That pass has repeatedly earned its
  keep — see §5.
- **Significance, not point estimates.** With only three held-out seasons, the
  standard error on a season-level accuracy delta is ≈0.028 — wide enough that
  most "improvements" are indistinguishable from zero. Comparisons use paired
  per-row tests and bootstrap confidence intervals, not eyeballed means.

## 3. Where the model actually stands

### It beats its own baselines

Walk-forward weekly PPR mean absolute error, pooled over 2023–25:

| model | weekly PPR MAE |
|---|---|
| naive last-4 average | 4.61 |
| XGBoost | 4.45 |
| **quantile transformer** | **4.33** |

A real but modest gap. The transformer wins every held-out season; it loses on
RMSE, as a median predictor should against a mean predictor — a point in its
favor for a floor/ceiling product, not against it.

### It loses to the experts, and to the crowd, at the draft

The honest benchmark is not "does it beat a naive average" but "is it better
than what a drafter can get for free." Two references, both snapshotted
*strictly before* kickoff (leak-safe), scored on realized end-of-season finish:

- **Expert consensus (FantasyPros ECR).** Preseason starter hit-rate: **consensus
  60.5% vs the model 53.9%**, and consensus wins all twelve position-seasons on
  a like-for-like ranking comparison. The model does *not* out-rank the experts.
- **Average draft position (ADP)** — what league-mates actually draft from,
  aggregated from thousands of real drafts. On the two seasons with clean
  historical ADP: **ADP 57.2% vs the model 52.6%.** ADP is measurably *easier*
  than expert consensus (the crowd is noisier than the experts), which confirms
  the intuition that a better ranker can beat it — but the model is not that
  ranker: it loses to ADP within every position, and when it deviates from ADP
  it is the one who is wrong 57% of the time.

No public open-source model has been shown to beat expert consensus on
preseason ranking, so this is not a surprising place to land — but it is stated
plainly rather than hidden behind a favorable internal baseline.

### The one number that explains the gap

Restricting the comparison to players who actually appeared in ≥8 games shrinks
the model-vs-consensus ranking gap from 0.123 to **0.049** — roughly **60% of
the expert edge is availability forecasting**, not per-game production ranking.
Experts (and the crowd) are better at knowing *who will play* — injuries,
holdouts, camp battles, role changes — not at knowing who scores more per game.
Conditional on a player suiting up, the model is close.

That single measurement reframes the whole project: **the draft board's ceiling
is set by information that is not in the box score.** No amount of better
box-score modeling closes a gap that is mostly about availability.

### Where it holds its own: weekly

Over a one-week horizon, the injury report is already public and the
availability edge largely evaporates. Measured against **weekly** expert
consensus (conditional on players who played), the model is a **statistical
tie**: within-position rank correlation 0.594 vs 0.596, a paired 95% interval
of [−0.012, +0.008] that includes zero. For a free model against a paid expert
panel, parity is a genuine result — and it points at where the model's real
value lives.

That tie is measured on **weeks 3–17** of 2023–25 (2024 starts at week 5), 172
position-weeks over 12,182 player-weeks. Eleven of the 54 season-weeks have no
expert ranking scraped inside the seven days before kickoff, and the leak guard
skips such a week rather than reach past kickoff to fill it. The figures above
were prose in this document before they were an artifact; they have since been
reproduced exactly and committed.

The model has one measurable **running-back weekly** edge, and it survives
out-of-sample replication. It was found on 2023–25 (out-ranking weekly
consensus 0.7215 vs 0.6958, winning all three seasons). The replication was
pre-registered *before* the earlier-fold models were trained, then run on the
disjoint 2020–22 seasons — and it held: **0.666 vs 0.642, winning all three
again, a pooled advantage of +0.024 with a paired 95% interval [+0.007, +0.044]
that excludes zero.** Both samples now exist side by side:

| position | 2020–22 delta | 2023–25 delta |
|---|---|---|
| QB | −0.063 | −0.040 |
| **RB** | **+0.024** | **+0.026** |
| WR | +0.003 | +0.009 |
| TE | −0.014 | −0.001 |

Running back is the only position positive on both disjoint samples, and its
paired interval excludes zero in each. Quarterback is a loss on both, and on
2023–25 the interval excludes zero — a real deficit, not noise. That pattern is
the signature of a real signal rather than a scoring artifact: a global quirk
would lift every position, but only the one whose value is workload-driven
(carries, targets, snap share) benefits, and that is exactly what the model's
usage features capture. Running back is the one place the model measurably
out-ranks the expert panel.

## 4. What didn't work — and why

Negative results, each pre-registered and each with a mechanism, because the
mechanism is the useful part:

- **Feature pack v2** (air-yards share, team pass volume, indoor/roof). Passed
  the accuracy criterion by point estimate but the gain was indistinguishable
  from zero (paired 95% CI on the MAE delta included zero; won 1 of 3 seasons).
  *More in-season box-score derivatives are exhausted as a direction.*
- **Expected-value vs median board ranking.** Ranking on the simulated season
  mean instead of the median changed the board's ordering by exactly nothing.
  *Availability is modeled per-position, so within a position the mean/median
  gap is a constant that cannot reorder anyone.*
- **Per-player availability** from week-1 roster status. A large, real signal
  (active players average 10.4 games vs 0.4 for cut players) that moved the
  board not at all. *The draftable pool is 93–95% active at week 1 by
  construction — anyone cut or injured in the preseason was never a top-50
  fantasy player last year — so a bucket signal is near-constant within it. The
  availability risk that matters for a draft board is mid-season injury to
  established starters, which week-1 status cannot see.*
- **Loss rebalancing** to fix the "starved" touchdown heads. **Retracted before
  training** — see §5.
- **A dedicated conditional-mean head** for the eight count components, built to
  fix quarterback. It improved *points* significantly and *ranking* not at all,
  and was not promoted. The most useful negative result the project has produced
  — the full record is in §7.

## 5. The discipline earning its keep

The safeguards above are not decoration; they changed outcomes.

- An adversarial review of the consensus benchmark caught a **critical fairness
  bug**: the model's board was being built without rookies while the consensus
  ranked the whole class, quietly inflating the measured gap. Fixed before the
  number was published.
- A benchmark harness shipped with a **sign error** (ranking on negated points)
  that produced an impossible −0.59 correlation; it was caught, corrected, and
  the fix was then baked into the code *structurally* — scores are now always
  "higher is better," with a single tested conversion point and a tripwire that
  refuses to report a model more negatively correlated with reality than chance.
- Most instructively, a planned change — reweighting the multi-task loss because
  the touchdown heads appeared to receive only 1.6% of it — was **retracted
  after a pre-training audit**. The 1.6% was the *loss* share; the actual
  *gradient* share, measured directly, was 47%. Pinball-loss gradients are
  bounded and scale-free, so the large-magnitude yardage heads never starved the
  small ones. The touchdown medians sit near zero because the median of a
  zero-inflated count *is* zero — correct behavior, not a bug — and no loss
  weighting moves it. The intuition had been imported from mean-squared error,
  where it holds, into quantile loss, where it does not. The experiment was
  cancelled before spending the compute.
- An audit of the XGBoost baseline found the **rejected feature pack v2 had been
  silently live** for it. Feature resolution was implicit-on-presence, so the
  baseline picked up any v2 column that happened to be in the frame even though
  the gate had turned that pack down. The measured impact was negligible — mean
  OVERALL PPR MAE moves **+0.0014** across 2023–25, so v2 is marginally *worse*
  and well inside noise — but the mechanism was real. The baseline's feature set
  is now versioned, explicit, frozen at v1, and pinned by a test that fails if a
  new column joins it. The audit then corrected **itself** twice. Its first
  conclusion, that data vintage explained a disagreement between two committed
  reports, was wrong; it is retained in the file as `conclusion_SUPERSEDED` and
  was disproved by a single observation — `naive_last4` is byte-identical across
  the two reports while `xgboost` differs on every row, so the data cannot have
  moved if the model reading it did not. A second claim, that the report-to-report
  gap was "an order of magnitude" larger than the feature effect, was walked back
  as overstated (see §7).
- The guard predicates enforcing all of this were **mutation-tested**: each was
  deliberately broken to see whether the suite noticed. Thirteen of fifteen died
  as they should, including every walk-forward split and lag-shift boundary.
  Three genuine gaps were found and closed with tests — the most serious being
  that *no* test asserted the weekly fail-safe leaves previously-published JSON
  byte-unchanged; the two tests that looked like they covered it proved strictly
  weaker properties. One apparent survivor on the train-side leak boundary turned
  out to be an artifact of a git worktree resolving the package to a different
  source tree. It was chased down and re-run before being written up, not after.

Catching your own error before it costs anything is the entire point of the
process, and it is a more honest portfolio signal than a leaderboard number. A
superseded conclusion left visible in the record is worth more than a clean one
that was never checked.

## 6. What the model is genuinely good for

- **A free, transparent weekly projector at parity with a paid expert panel**,
  conditional on availability — and measurably *ahead* of it at running back,
  an edge confirmed out-of-sample (§3).
- **Calibrated floor/ceiling bands.** Held-out weekly coverage sits inside a
  0.75–0.85 target for every position; ADP and ECR give a single number, this
  gives a distribution. That is a real product difference neither benchmark
  rewards.
- **Honest baselines and honest bands**, so a user knows not just a projection
  but how much to trust it.
- **A draft board that ranks on consensus and shows the model's bands.** The
  ordering is expert-consensus (ECR), not the model — because the model's own
  ranking was measured to lose — with ADP as a market/keeper overlay and the
  model's calibrated floor/ceiling bands on every player. The board embodies the
  conclusion above: a banded view of consensus, not a contrarian oracle.

## 7. Honest limitations and what would actually move the needle

- **The draft board should not be used to deviate from consensus/ADP.** Measured
  three ways, the model's disagreements at the season level cost points. The
  right use of the board is as a calibrated, banded view of consensus, not a
  contrarian oracle.
- **The real headroom is offseason context** — depth charts, injury history,
  role and scheme changes — the availability information the v1 scope guard
  deliberately excludes. Closing the gap to consensus is a data-scope decision,
  not a modeling tweak, and it is genuinely hard.
- **Quarterback is the weakest position** across every cut — pooled over nine
  walk-forward folds, weekly within-position rank correlation is 0.471 for QB
  against 0.630 for RB/WR/TE — traceable to the rushing-touchdown component of QB
  scoring living in a distribution the median under-serves. This document used to
  call the fix a better point construction (an expectation or a dedicated mean
  head) and leave it as an open thread. **That thread is now closed, and the
  answer was no.** A pre-registered experiment fitted Poisson conditional-mean
  heads for the eight count components and ran 9 walk-forward folds × 3 seeds × 2
  arms. Verdict: **not promoted.** The primary — pooled RB/WR/TE weekly
  within-position Spearman against v1 — came back at **−0.0005, 95% CI [−0.0015,
  +0.0004]**: flat. Quarterback itself moved +0.005 with an interval spanning
  zero. The band guard also failed, on 2022 QB coverage of 0.861 against a 0.85
  ceiling — though the record notes that the v1 baseline refits that same cell to
  0.844, so the mean head pushed an already-marginal cell over rather than
  breaking the bands. The second arm was significantly *worse* on the primary
  (−0.0011, interval excluding zero), even though it was the arm that helped QB
  (+0.015, interval excluding zero).

  **The informative part is what did improve.** Pooled PPR MAE dropped
  significantly: **4.404 vs 4.491, a delta of −0.087 with a 95% CI of [−0.112,
  −0.059].** The conditional-mean head predicts *points* better and *ranking* not
  at all. That is the sharpest confirmation yet of the through-line in §3: the
  ranking ceiling is set by information absent from the box score, not by the
  estimator applied to it. And this is a tight null rather than an underpowered
  one — the pre-registration anticipated a standard error of 0.007–0.010, enough
  to resolve an effect of about 0.02; the realized 95% interval on the primary has
  a half-width of 0.00096.
- **More held-out seasons is no longer the obvious next step.** This document
  previously called a longer walk-forward (≈10 folds) the cheapest way to resolve
  the small effects the project keeps meeting. The mean-head gate effectively ran
  that, at nine folds. What the XGBoost audit then turned up is the reason to be
  careful with the prescription: the baseline **subsamples**, and refitting it on
  byte-identical data with seeds 0–3 spans ~0.012 OVERALL PPR MAE and up to
  ~0.047 on the smallest per-position cell — comparable to or larger than several
  effects this project has chased. More folds do not help when the estimator's own
  seed jitter is the size of the effect being measured. Reports now record
  `xgb_seed`, `xgb_feature_set`, and a `data_vintage` block carrying a sha256 per
  source parquet, and two reports are compared only when all three match.

*This document is regenerated as results change; every figure traces to a
committed evaluation in [`models/`](../models/) and a script under
[`src/ffmodel/eval/`](../src/ffmodel/eval/).*
