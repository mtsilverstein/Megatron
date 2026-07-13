# Work done by Opus (claude-opus-4-8)

This log tracks **every** change made while the session model is Opus, so it can
be audited separately from Fable's work. The user switched to Opus after hitting
the Fable limit, for Plan 4 Phase A (the draft-board backtest harness). Fable is
positioned above Opus for the subtlest reasoning; Phase B (band calibration /
Monte-Carlo season simulation) is deliberately reserved for Fable's return.

Ground rules for this stretch (user's explicit instructions):
- Log every change here.
- Flag anything I am not 100% certain on.
- Stop and report back at decision points rather than guessing.

Branch: `feat/plan-4-board-backtest` (off `main` at 406d5b7). Plan doc:
`docs/superpowers/plans/2026-07-13-plan-4-board-backtest-and-bands.md`.

---

## Session 1 — Phase A1: board backtest core (`src/ffmodel/eval/board.py`)

### Context read before writing (no changes)
- `src/ffmodel/site/draft.py` — board player-dict schema (`season_points[ruleset]
  [p10|p50|p90]`, `position`, `player_id`, `position_rank`, `vorp`), `REPLACEMENT_RANK
  = {QB:13, RB:25, WR:25, TE:13}`.
- `src/ffmodel/scoring.py` — `fantasy_points(stats, rules)`, `PREDICTED_STATS` (11),
  `SCORING_EXTRAS` (2), `PPR`.
- `src/ffmodel/eval/harness.py` — **key consistency finding**: the weekly harness
  scores actuals as `fantasy_points(test[PREDICTED_STATS], rules)`, i.e. EXCLUDING
  `SCORING_EXTRAS` (2-pt conversions, special-teams TDs), because the model has no
  output heads for them (`harness.py:37-39`). The board backtest must score actuals
  the same way or its MAE is not comparable to the weekly numbers.
- `src/ffmodel/eval/run.py` — report/provenance conventions (`created`,
  `transformer_roots`, per-(model, season, position) rows) that A2's CLI will mirror.
- `src/ffmodel/data/pull.py` — weekly frame is REG-only already (`normalize_weekly`
  filters `season_type == "REG"`), columns include `player_id`,
  `player_display_name`, `position`, `season`, `week`, all `PREDICTED_STATS`.

### Design decisions (with confidence; FLAGGED items need user sign-off)

1. **Actuals exclude `SCORING_EXTRAS`** — `fantasy_points(rows[PREDICTED_STATS], PPR)`,
   matching `harness.py:39`. Confidence 100% (direct consistency requirement).
2. **Actuals use our `fantasy_points()`, not nflverse's `fantasy_points_ppr` column** —
   the project computes points from stat lines by pure functions (design invariant),
   and the board's projections are scored the same way, so actuals must be too.
   Confidence ~98%.
3. **`board_world(weekly, S)` = `weekly[season <= S-1]`** — THE leak boundary; schedules
   for S are allowed separately (published before drafts). Confidence 100%.
4. **`season_actuals` returns the FULL season-S leaderboard** (every QB/RB/WR/TE who
   played), not just board players — because `hit_rate` needs the real top-R starters,
   which can include players absent from the board (rookies). The board-side "missing
   player scores 0" is a join concern handled in `board_metrics`. Confidence ~95%.
5. **`hit_rate_starters` actual-top-R universe = all season-S players at the position**
   (top R by actual points), intersected with the board's projected top-R, over a fixed
   denominator R. This means the board is penalized for missing a real starter (e.g. a
   rookie who broke out). **FLAG — confidence ~85%.** Alternative: restrict actual-top-R
   to the board's own universe (less honest, survivorship). I chose the honest version.
6. **Pools:** per-position `season_mae_topN` / `spearman_topN` / `season_band_coverage`
   over the board's projected top-N at that position, N = 2×`REPLACEMENT_RANK` (QB/TE 26,
   RB/WR 50 — the draftable pool). `OVERALL` = union of the four position pools; `OVERALL`
   `hit_rate` = Σ(per-position intersections) / Σ(R). **FLAG — confidence ~80%** on the
   OVERALL aggregation being the most useful definition (per-position rows are the
   unambiguous ones; OVERALL is a summary choice).
7. **`season_band_coverage` = NaN for band-less entrants** (naive/XGBoost have no p10/p90);
   computed only over pool players with non-None p10 AND p90. Confidence ~95%.
8. **Spearman guarded** against `len < 2` or constant input → NaN, computed WITHOUT calling
   `scipy.stats.spearmanr` in those cases (scipy emits `ConstantInputWarning`, which is
   fatal under the suite's `-W error`). Confidence 100%.
9. **Deterministic tie-break** by `player_id` when projected p50 ties, for pool/top-R
   selection. Confidence ~95%, low stakes.
10. **`board_metrics(board_players, actuals, replacement_rank=REPLACEMENT_RANK)`** takes
    `board_players` as the list of player dicts (`board["players"]`). Confidence ~90%.

### Discovery: the dead Fable workflow had already written the test file
The Fable workflow that hit its limit got far enough to write `tests/test_board.py`
(untracked, 239 lines) before dying — a **more thorough** test suite than my own
draft. Rather than overwrite it, I read it, **independently hand-verified every
expected number** (see below), and adopted it. My own draft `tests/test_board.py`
Write was correctly rejected (file already existed), so nothing of mine clobbered it.

Independent verification of the adopted tests' expected values (all confirmed):
- `season_actuals`: p1 = 21 (wk1) + 8 (wk2, 2-pt excluded) = 29; p2 QB = 250·0.04 +
  2·4 − 1·2 = 16. ✓
- QB metrics: MAE (10+30+60+240)/4 = 85; Spearman ρ = 1 − 6·2/(4·15) = 0.8; hit-rate
  {qb1..qb4}∩{qb1,qb2,qb3,qb5} = 3/13; coverage 2/4 = 0.5. ✓
- RB metrics: MAE 100/4 = 25; ρ = 1.0; hit 4/25; coverage 4/4 = 1.0. ✓
- OVERALL: MAE 440/8 = 55; ρ = 1 − 6·26/(8·63) = 29/42; hit (3+4)/(13+25) = 7/38;
  coverage 6/8 = 0.75. ✓
The adopted tests make the SAME two judgment calls I'd flagged independently
(hit-rate over the full actual leaderboard; OVERALL = union of pools), which raises
my confidence on decisions #5 and #6 from ~85%/~80% to ~90% (two independent
derivations agree — though it is still a definitional choice, see FLAGs below).

### Design deltas the adopted tests dictated (vs my original sketch)
- **Return type: `pd.DataFrame`** (columns `position, n, season_mae_topN,
  spearman_topN, hit_rate_starters, season_band_coverage`), not a list of dicts.
  Pool-size column is **`n`**, not `n_pool`. Cleaner and matches `run.py`'s
  results-as-DataFrame convention.
- **Two guards added** (I adopted both — they're correct): empty board →
  `ValueError("...empty...")`; a position outside QB/RB/WR/TE →
  `ValueError` naming it (v1 scope guard; a kicker on the board is an upstream bug).
- **`season_actuals` raises** `ValueError` on a season with no rows (rather than
  returning empty) — a board season with no actuals is a usage error.
- One row per position **present** in the board, plus OVERALL — not always all four.

### Changes made (commit A1)
- **Created `src/ffmodel/eval/board.py`** — `board_world`, `season_actuals`,
  `board_metrics` + helpers `_safe_spearman`, `_band_coverage`, `_base_row`,
  `_starter_hits`. Implements all decisions above.
  - Refactored one hacky bit before committing: OVERALL hit-rate first
    reconstructed the integer hit count via `round(rate·rank)` (float round-trip);
    replaced with `_starter_hits` returning the raw integer count, summed directly.
- **Adopted `tests/test_board.py`** (the Fable workflow's file, verified above) — 12
  tests, all green.
- Suite: **183 passed, 2 deselected, `-W error`** (171 baseline + 12 board).
- Commit: `feat: board backtest core — actuals, world boundary, board metrics`.

### FLAGGED for user sign-off before A2 builds the real backtest on these
These metric definitions are baked into the numbers the backtest will report. They
are judgment calls, agreed by two independent derivations but still worth your eyes
before I run the real 2023–25 baseline:
1. **hit-rate universe** = full season-S leaderboard at the position (the board is
   penalized for missing a breakout it never listed). Alternative: board-universe
   only (survivorship). I went with the honest/harsh version.
2. **OVERALL aggregation** = union of the four draftable pools; OVERALL hit-rate =
   Σhits / Σreplacement-ranks (a slot-weighted average, so RB/WR dominate given
   their rank-25 vs QB/TE rank-13). Per-position rows are unambiguous; OVERALL is a
   summary choice.
3. **Draftable pool = top 2×replacement-rank** (QB/TE 26, RB/WR 50). The 400-player
   waiver tail is intentionally excluded so it can't dominate MAE/coverage.
If any of these should differ, changing them now (before A2 + the baseline run) is
cheap.
