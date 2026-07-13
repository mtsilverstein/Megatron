# Plan 4: Draft-board backtest + honest season bands

**Date:** 2026-07-13
**Status:** Approved (user: "yeah lets do it" — measurement first, then band fixes, then usage-shrinkage measured against the new harness)
**Motivation:** The walk-forward harness scores *weekly* predictions with real rolling features; the draft board (frozen end-of-prior-season seeds rolled over 18 weeks) has never been evaluated — board quality is currently judged by eyeball. Separately, season bands are sums of weekly quantiles (assumes perfect cross-week correlation → 700+ point ceilings) and weekly coverage sits at ~0.897 vs the 0.80 target.

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

## Phase B — improve: bands people can believe

**B1 — weekly band calibration (conformal-style width scaling).**
- New `src/ffmodel/model/calibrate.py`: fit scale factors on the artifact's **validation season** predictions: find `s_lo`, `s_hi` (global, and per-position if it materially differs — implementer measures both, ships the simpler one unless per-position moves coverage ≥2 points) such that `[p50 − s_lo·(p50−p10), p50 + s_hi·(p90−p50)]` has empirical coverage 0.80 on val. Binary search; monotone-safe (scaled band never inverts).
- Stored as `calibration.json` inside each artifact dir (committed beside model.pt). `TransformerPredictor` applies it when the file exists — absent file = today's behavior byte-for-byte (old artifacts stay reproducible).
- CLI to fit + write: `python -m ffmodel.model.calibrate --artifact-root <root>` (CPU; runs the predictor over the artifact's val season from the features parquet/pulls).
- **Honesty rule:** calibration is fit on val season only; acceptance is coverage on the *test* seasons via the existing weekly harness (expect ≈0.80; report exactly what lands). Note in docs: val season also drove early stopping — pragmatic, documented, same tradeoff the artifact contract already makes.

**B2 — season bands by Monte Carlo, not quantile sums.**
- In `src/ffmodel/site/draft.py` `season_projection`: replace p10/p90 season sums with simulation. Per player-week, build a piecewise-linear CDF through (p10, p50, p90) with linear tails extending to `p10 − (p50−p10)` and `p90 + (p90−p50)`, clipped at 0 for non-negative scoring weeks (document: PPR weekly points can be slightly negative — clip at a small floor of −5, not 0). Weeks independent (documented assumption; measured by `season_band_coverage`). 2000 seeded draws (seed + draw count from function args with defaults; deterministic given seed). Season p10/p50/p90 = sample quantiles of the summed draws. VORP switches to the simulated season p50 (median-of-sum, not sum-of-medians — small ordering shifts expected and correct).
- All three rulesets simulated from their own weekly quantiles (existing accumulator structure).
- Performance budget: vectorized numpy, 616 players × 18 weeks × 2000 draws ≈ 22M samples per ruleset — must stay < ~60s CPU in the generator.

**Acceptance for Phase B (measured, not asserted):**
1. Weekly coverage on test seasons moves from ~0.897 to 0.80 ± 0.03 (eval harness).
2. `season_band_coverage` in the board backtest moves toward 0.80 from its baseline; season p90s become sane (spot check: no 700-point ceilings).
3. Board rank metrics (spearman/hit-rate/MAE) do not degrade by more than noise (>2% relative) — if they do, stop and report.
4. Site regenerated with calibrated + simulated bands; about.html limitations copy updated (drop "sums of weekly quantiles, which overstates their width"; describe simulation + calibration in one sentence each). Weekly page inherits calibration automatically via the predictor.

## Out of scope (next plans, measured against this harness)
- Usage-share mean-reversion / team target-share constraints (the Wan'Dale fix) — Plan 5, gated on Phase A metrics.
- Roster-aware redistribution, injury/news signals (spec §11 still binding).
- About-page board-backtest table (follow-up copy task).

## Sequencing
A1 (board.py core + tests) → A2 (CLI + entrants + provenance + tests) → A3 (baseline run, committed) → B1 (calibrate module + artifacts) → B2 (simulation) → B-verify (re-run weekly eval + board backtest, compare, regenerate site) → final review → merge/push.
