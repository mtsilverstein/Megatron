# Plan 4: Draft-board backtest + honest season bands

**Date:** 2026-07-13 · **Phase B revised 2026-07-16** (Fable, per `done.by.opus.md` Session 4 — the original Phase B predated the Sessions 2–3c findings and was measured stale on five gates)
**Status:** Phase A COMPLETE (baseline committed + audited). Phase B: revised and ready to execute.
**Motivation:** The walk-forward harness scores *weekly* predictions with real rolling features; the draft board (frozen end-of-prior-season seeds rolled over 18 weeks) has never been evaluated — board quality is currently judged by eyeball. Separately, season bands are sums of weekly quantiles (assumes perfect cross-week correlation → 700+ point ceilings) and weekly coverage sits at ~0.897 vs the 0.80 target *(pre-B0 construction; B0 changes the base numbers — see the re-baseline step)*.

> **For agentic workers:** execute Phase B task-by-task via superpowers:subagent-driven-development (recommended) or superpowers:executing-plans, with TDD per house rules (`-W error` suite). The interfaces, estimators, schemas, and pre-registered acceptance rules below are binding; where a measured result trips a STOP rule, stop and report — do not iterate against test seasons.

**Global constraints (apply to every task):** free tiers only; walk-forward eval only; models predict raw stat lines, points via pure scoring functions; `models/backtests/` may contain ONLY weekly-schema (`test_seasons`) and board-schema (`board_seasons`) reports — anything else breaks `build_about`/`generate.py` (diagnostics go in `models/diagnostics/`); the weekly Actions cron must never observe a main where the band construction changed but calibration has not landed (hence the atomic merge train in B-verify).

## Phase A — measure: the board backtest

New module `src/ffmodel/eval/board.py` + CLI `python -m ffmodel.eval.board`.

**World construction (leak rules, binding):** for board season S, the "August world" is `weekly[season <= S-1]` — nothing from S. Schedules for S are allowed (published before drafts in reality). Boards are generated through the **production path** (`build_draft_board` with the truncated weekly frame): the played-week guard passes naturally because the truncated world contains no season-S stats — the harness must NOT add any bypass flag to production code. Predictor artifact selection matches the weekly harness (`through{S-1}` = trained on seasons ≤ S-1). Rookies of season S are absent from the August world and get the production fallback — that is honest, not a bug.

**Functions:**
- `season_actuals(weekly, season, rules=PPR)` → DataFrame `[player_id, name, position, actual_points, games]` — actual REG-season PPR totals for season S. Players in the projected board with no season-S rows score `actual_points = 0` (busts/retirements/injuries count against the board — no survivorship filtering).
- `board_world(weekly, season)` → the truncated frame (trivial, but named and tested — it IS the leak boundary).
- `board_metrics(board_players, actuals)` → per-position and overall:
  - `season_mae_topN`: MAE of projected p50 season points vs actual, over players the board projects in its positional top-N, N = 2×REPLACEMENT_RANK (QB/TE 26, RB/WR 50) — the draftable pool; the 400-player tail must not dominate.
  - `spearman_topN`: Spearman rank correlation, projected order vs actual points, same pool.
  - `hit_rate_starters`: |projected top-R ∩ actual top-R| / R with R = REPLACEMENT_RANK — "how many of the board's projected starters finished as starters."
  - `season_band_coverage`: share of the draftable pool whose actual total landed in [season p10, season p90] (ideal 0.80) — this is Phase B's acceptance metric, measured before AND after.
- Entrants: naive last-4, XGBoost, transformer (repeatable `--transformer-root`, ensembles supported) — same harness for all, results reported however they land.
- Output `models/backtests/board_backtest.json`: `created`, `board_seasons`, `scoring`, `transformer_roots` (provenance), `results` rows keyed (model, board_season, position∈{QB,RB,WR,TE,OVERALL}). Committed. Summary table printed.

**Baseline snapshot:** run for seasons 2023/2024/2025 with the current (pre-Phase-B) band math and commit — the "before" numbers.

## Phase B — improve: bands people can believe (REVISED 2026-07-16)

All Phase B work happens on one working branch (`feat/plan-4b-bands`, off current `main`);
`main` only ever sees the finished train (B-verify). Rationale: the band-definition change
(PR #1) makes uncalibrated bands strictly wider (QB weekly coverage 0.814 → 0.975 vs the
0.80 target), and the weekly Actions cron regenerates the site from whatever `main` holds —
so the construction change and its calibration must land atomically.

Evidence base: `done.by.opus.md` Sessions 2–3c (findings) and Session 4 (audit verdicts +
gates). Two facts shape everything below: (1) miscalibration is position-specific and
tail-asymmetric (pre-B0: QB 0.814 near-target by a fragile three-effect cancellation, RB
0.938 wide; post-B0: QB floor misses 0.2% below vs 10% nominal), so calibration is
per-position and per-tail; (2) the board's point estimates carry two large cancelling
biases — 17-games-for-everyone (inflates ~25–35%) vs sum-of-medians (deflates, worst RB
−33%) — so B2 must fix BOTH in the same commit or it breaks the cancellation one-sidedly.

### B0 — integrate the band definition + re-baseline (on the branch)

- Merge `fix/sign-coherent-bands` (PR #1: commits `ce55c23` + `667df51`) into the working
  branch: `git merge fix/sign-coherent-bands`. No conflicts expected against current main
  (verified disjoint files). PR #1 closes when the train merges to main.
- Add to `src/ffmodel/scoring.py`: `BAND_CONSTRUCTION = "sign_coherent_v1"` (module
  constant). Add `"band_construction": BAND_CONSTRUCTION` to both report builders —
  `ffmodel/eval/run.py` (`report` dict) and `ffmodel/eval/board.py` (`_board_report`) —
  so old- and new-construction reports can never be silently compared.
- Re-baseline on the branch: re-run `python -m ffmodel.eval.run --transformer-root
  models/transformer/v1 --transformer-root models/transformer/v1_s43 --transformer-root
  models/transformer/v1_s44 --out models/backtests/bakeoff.json` and `python -m
  ffmodel.eval.board` (same roots) and commit both reports. These are the honest
  pre-calibration "before" numbers on the new construction; the A3 baseline stays in git
  history as the old-construction record.
- **INTEGRITY CHECK (free, must pass):** every p50-derived number must be IDENTICAL to the
  committed A3/bake-off values — weekly `mae`/`rmse`/`pinball_p50` rows and board
  `season_mae_topN`/`spearman_topN`/`hit_rate_starters`. The band change does not touch
  p50s; any drift means the merge broke something → STOP.
- Expected band-metric shifts (executor's success signature, from Session 3c): weekly
  coverage QB 0.814→~0.975, RB→~0.943, WR→~0.895, TE→~0.913; board `season_band_coverage`
  rises similarly.
- Small cleanup riding B0 (separate commit): `run_board_backtest`'s `rules` parameter is a
  latent mismatch trap (rescored actuals vs hardcoded `"ppr"` projection lens) — raise
  `ValueError` if `rules.name != "ppr"` until multi-ruleset board scoring actually exists.

### B-diag — committed diagnostics (before B1/B2; kills the provenance gap)

Session 2's availability/rate numbers motivate B2 but were never committed (Session 4,
gate 4). Re-derive them from committed inputs as tested, repo-resident code. New module
`src/ffmodel/eval/diagnose.py` + `tests/test_diagnose.py`; outputs to `models/diagnostics/`
(NOT `models/backtests/` — see global constraints).

Interfaces (binding):
- `availability_table(weekly: pd.DataFrame, through_season: int, pairs: int = 6,
  replacement_rank: dict = REPLACEMENT_RANK) -> pd.DataFrame` — the leak-free cohort
  estimator of games played. For each season pair (S'−1 → S') with S' ≤ `through_season`
  (most recent `pairs` pairs present in the frame): cohort = top-2R players per position by
  season-(S'−1) total PPR points over `PREDICTED_STATS`; record each cohort member's games
  played in S' (0 for none). Output one row per (position, games 0..18) with counts, plus
  mean/std per position. This mirrors the board's real situation — a pre-season-selected
  pool followed into the next season — and uses only `weekly` rows < S, so in a backtest
  for board season S it is leak-free by construction when handed the truncated world.
- `rate_decomposition(board_players: list[dict], actuals: pd.DataFrame,
  availability: pd.DataFrame) -> pd.DataFrame` — per position over the draftable pool:
  projected games, actual mean games, projected pts/game (p50/games), actual pts/game,
  rate bias. Re-derives Session 2's table from committed board + `season_actuals` output.
- `weekly_residual_icc(weekly: pd.DataFrame, through_season: int, pairs: int = 6) ->
  pd.DataFrame` — per-position week-to-week persistence for the B2 contingency: one-way
  random-effects ICC of weekly PPR points within player-season, over the same cohort.
  (Average pairwise within-player-season correlation is exactly the quantity the variance
  of a season sum depends on; because board predictions are frozen pre-season, deviation of
  a player's realized season level from prediction ≈ the persistent component this
  captures.)
- Run for boards 2023–25 (worlds truncated per season) + the 2026 world; commit outputs as
  `models/diagnostics/availability.json`, `rate_decomposition.json`, `weekly_icc.json`.
- **VALIDATION GATE:** if re-derived per-position mean games differ from Session 2's
  claimed 12.4–14.2 by more than 1.5 games at any position, STOP and report before B2 —
  the doc numbers were unprovenanced; the re-derived distributions are canonical and are
  what B2 consumes (never the doc's numbers).

### B1 — per-position, per-tail conformal calibration

New `src/ffmodel/model/calibrate.py` + `tests/test_calibrate.py`; modify
`src/ffmodel/model/predictor.py` (load/apply/refuse).

- **Fit target (per position, on the artifact's validation season, PPR):** find
  `(s_lo, s_hi)` such that the resulting point band has `P(actual < floor) = 0.10` AND
  `P(actual > ceil) = 0.10`. Both tails, not total coverage: tail asymmetry was the
  audit's sharpest miscalibration signature (post-B0 QB: 2.3% above / 0.2% below).
- **Application (component space, inside the predictor):** in
  `TransformerPredictor.predict_quantiles`, after ensemble averaging and the monotone
  guard: for each stat component, `p10' = p50 − s_lo·(p50 − p10)`,
  `p90' = p50 + s_hi·(p90 − p50)`, with the row's position selecting the factors.
  Monotone-safe for s ≥ 0. Rookie fallback rows are calibrated identically.
- **Fit mechanics — the negative-weight wrinkle (documented, handled):** with
  `s_lo ≠ s_hi`, negative-weight components (INTs/fumbles, ~18% of QB band width) cross
  sides in the coherent point band, so scaling component offsets does NOT scale each point
  tail by exactly its own factor. Therefore the fit searches `(s_lo, s_hi)` jointly against
  the RESULTING point-band tails: alternating 1-D binary searches (each tail is monotone in
  its own factor, weakly coupled through the negative components; 2–3 sweeps converge).
  Val-season exactness is by construction of the fit, not by scaling algebra.
- **Ensemble-level fit + provenance:** calibration is a property of the deployed predictor
  = the seed ensemble. Fit on the ensembled val-season output; store ONE `calibration.json`
  in the BASE root's fold dir (e.g. `models/transformer/v1/through2025/calibration.json`):
  `{"band_construction": "sign_coherent_v1", "fit_season": <val season>, "member_roots":
  [<as_posix roots>], "per_position": {"QB": {"s_lo": .., "s_hi": ..}, ...},
  "achieved_val_tails": {"QB": [lo, hi], ...}, "created": <iso>}`.
  `TransformerPredictor` loads it from `roots[0]`; **fails loud** if `band_construction !=
  scoring.BAND_CONSTRUCTION` or `member_roots` ≠ the current root list (sorted, as_posix).
  Absent file = uncalibrated, byte-identical to today — old artifacts stay reproducible.
- CLI: `python -m ffmodel.model.calibrate --transformer-root <root>` (repeatable, ensemble
  = multiple occurrences, matching `eval.run`'s convention); fits every `through{S}` fold
  present, each on its own val season S. CPU, minutes.
- **Honesty rule (unchanged):** fit ONLY on the val season (which also drove early
  stopping — same documented tradeoff as the artifact contract); acceptance ONLY on test
  seasons via the existing weekly harness.
- **Acceptance (pre-registered, per position, pooled 2023–25 test seasons):** coverage
  0.80 ± 0.03 AND each tail 0.10 ± 0.02, for each of QB/RB/WR/TE (tolerances ≈ 2× binomial
  SE at pooled position n, widest for QB). Report per-season values for drift. Report
  half-PPR/standard coverage as diagnostics (fit is PPR-exact; a ruleset off by > 0.05
  gets flagged, not fit-to-test). Any position missing → STOP and report; never tune
  against test seasons.

### B2 — season point estimates + bands by Monte Carlo (availability-aware)

Modify `src/ffmodel/site/draft.py` (`season_projection` keeps per-week calibrated point
quantiles instead of summing them); new `src/ffmodel/model/simulate.py` + tests (keep
draft.py thin).

- **Inputs:** B1-calibrated weekly point quantiles per ruleset (automatic — the predictor
  calibrates the stat frames, `fantasy_points_quantiles` scores them), and the B-diag
  availability distributions (derived from the same truncated world the board is handed —
  leak-free by the same argument as the pie constants).
- **Weekly CDFs:** piecewise-linear through calibrated (p10, p50, p90); linear tails
  extended by (p50−p10) below and (p90−p50) above; clipped at −5 (PPR weeks can be
  slightly negative). **Clip diagnostic (pre-registered):** report the fraction of sampled
  weekly mass landing on the clip per position; > 1% at any position → revisit before
  shipping.
- **Availability sampling:** per draw, sample `G ~` the empirical per-position games
  distribution from B-diag (capped at the player's scheduled weeks), drop scheduled weeks
  uniformly at random, sum the remaining weekly draws. Empirical G — NOT Bernoulli/binomial
  per week — because the 0–4-game left tail (season-ending injuries) is over-dispersed vs
  binomial and is exactly what drives honest floors. Which weeks are dropped only matters
  through schedule context; uniform dropping is unbiased for the sum.
- **Point estimate & VORP:** the simulated season p50 (median-of-sums). It is MAE-optimal
  (the board is scored on MAE), band-coherent, and CLT makes mean ≈ median for 12+ week
  sums; record the simulated mean alongside in the backtest diagnostics once, for the
  record. **ATOMICITY RULE:** availability sampling and the p50 switch ship in the SAME
  commit — they fix two measured biases that currently cancel (~+0.8 net, Session 2);
  shipping either alone breaks the cancellation one-sidedly and will trip acceptance #3.
- **Weeks independent — documented assumption with a pre-registered contingency.** The two
  unknowns OPPOSE: ignoring week-to-week persistence biases season bands narrow, while
  availability sampling adds `Var(G)·E[week]²` season variance, biasing them wide. Net
  direction is genuinely unknown a priori — measure, don't guess:
  - Pooled per-position `season_band_coverage` (board backtest) **< 0.75** → activate the
    correlated-draw upgrade; **in [0.75, 0.85]** → ship and document the residual;
    **> 0.85** → STOP and investigate (availability distribution or clip, most likely).
  - **Correlated-draw upgrade (spec'd now so activation is mechanical):** Gaussian copula
    across the retained weeks with per-position equicorrelation `ρ_pos` = the B-diag ICC:
    draw `z ~ N(0, Σ_equicorr(ρ_pos))`, map `Φ(z_w)` through each week's CDF. This is the
    correlated-draw/MCMC design reserved for the user's coursework; the ICC estimator and
    its rationale live in B-diag.
- 2000 seeded draws (seed + count as function args with defaults; deterministic given
  seed). All three rulesets simulated from their own weekly quantiles. Performance budget:
  vectorized numpy, 616 players × 18 weeks × 2000 draws ≈ 22M samples per ruleset, < ~60s
  CPU in the generator (the availability mask adds one boolean array of the same shape).
- Board methodology string becomes: `"bands": "simulated season distribution (calibrated
  weekly bands, availability-adjusted)"`.

### B-verify — acceptance, site, and the atomic landing

1. **Weekly (B1):** the per-position, per-tail criteria above, from the re-run weekly
   harness (committed as the post-calibration bake-off).
2. **Season (B2):** the pre-registered coverage decision rule above; spot-check no
   700-point ceilings; add one diagnostic column to the board report decomposing coverage
   misses into zero/low-game players vs in-play misses (availability vs width — they are
   different failures and Session 4 flagged their conflation).
3. **Rank metrics vs the A3 baseline (p50 comparison stays valid — B0 integrity check):**
   Session 2's diagnosis PREDICTS season MAE improves once availability + median-of-sums
   land together. Pre-registered: if season MAE, Spearman, or hit-rate degrades > 2%
   relative vs the committed A3 rows → STOP and report (this falsifies the diagnosis;
   suspect the availability cohort first).
4. **Site:** regenerate weekly + draft + about JSON; copy updates — `site/weekly.html` and
   `site/about.html` still describe bands as raw "p10 and p90 of the model's stat-line
   quantiles" (audit finding): describe calibrated floor/ceiling in one sentence ("scaled
   so ~80% of outcomes land inside, measured on held-out seasons"); about.html limitations
   drops "sums of weekly quantiles, which overstates their width" and gains one sentence
   each for calibration and simulation.
5. **Landing:** one merge train to `main` — PR #1 content + B0 re-baseline + B-diag + B1
   (+ calibration.json artifacts) + B2 + regenerated site JSON — reviewed as a unit
   (superpowers:requesting-code-review), then merged; PR #1 closes with a pointer to the
   train. The weekly cron only ever sees pre-train or post-train main, never the
   in-between.

## Out of scope (next plans, measured against this harness)
- Usage-share / team-pie constraints: **gate CLOSED** — Plan 5 built and measured it
  NEGATIVE on this harness (every mode worse or tied; `done.by.opus.md` Sessions 2 & 4);
  do not revive without new evidence. The branch `feat/plan-5-team-pie` stays unmerged as
  the record.
- Roster-aware redistribution, injury/news signals (spec §11 still binding). NOTE: B2's
  availability model uses position-level historical base rates from the world — aggregate
  frequencies, not player-specific injury news — so it does not breach this line.
- About-page board-backtest table (follow-up copy task; `build_about` now skips
  board-schema reports, so it stays invisible until built deliberately).

## Sequencing
Phase A (A1 → A2 → A3): COMPLETE, baseline committed and audited.
Phase B: B0 (integrate PR #1 on branch + provenance field + re-baseline + integrity
check) → B-diag (diagnostics module + committed distributions + validation gate) → B1
(per-position calibration + artifacts + pre-registered weekly acceptance) → B2
(availability-aware simulation, atomic with the p50 switch + pre-registered season
acceptance) → B-verify (re-run both harnesses, site regen + copy, one merge train to
main) → final review → merge/push.
