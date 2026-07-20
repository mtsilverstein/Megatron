# Rookie projections — design

**Date:** 2026-07-19 · **Status:** approved
**Feature:** put drafted rookies on the draft board via an empirical
draft-capital cohort prior — closing the documented cold-start gap (main
design spec §4/§7: "rookies with no NFL games get position-level prior
projections… v1-crude and labeled"; today they are absent entirely).

## Decisions (approved 2026-07-19)

1. **Honest base rates, not market blend.** Rookies rank where history says
   their draft slot lands on average, with wide bands showing the real
   bust/boom spread. The about page explains why rookie ranks look
   conservative vs ADP. No ADP source, no hype adjustment.
2. **Approach A: empirical cohort prior** feeding the existing simulation.
   The transformer is untouched — no retrain, no recalibration, the Phase B
   calibration provenance stays valid. A rookie-aware transformer (rejected
   approach C) remains a possible future research item whose baseline this
   feature establishes.
3. Drafted QB/RB/WR/TE only. Undrafted rookies are out of scope (no usable
   draft-day signal); UDFA breakouts are an acknowledged, labeled miss.

## Data facts (validated 2026-07-19)

- `nflreadpy.load_draft_picks()` has the full 2026 class: 80 drafted skill
  players with round/pick/team/position/age/college.
- Historical classes 2012–2025: 1,111 drafted skill players, 1,001 (90%)
  join to our weekly stats by gsis_id; the ~10% who never recorded an NFL
  week are real signal (the zero-games outcome), not join failures.
- Draft capital is strongly predictive of rookie-season PPR
  (round means 2020–24: R1 183, R2 109, R3 56, R4 59, R5 40, R6 27, R7 21).
- Gotchas: draft data uses PFR team codes (GNB, KAN, NOR, LVR, …) —
  normalize to our franchise codes; 2026 rookies carry placeholder ids
  (e.g. `MEN516487`), not gsis format, until they play.

## Architecture

### Data layer — `pull_draft_picks` in `src/ffmodel/data/pull.py`

- Cached like the other pulls (`_cached`, parquet under `data/raw/`).
- Filter to `position ∈ {QB, RB, WR, TE}`.
- Normalize PFR team codes to current franchise codes (extend the existing
  normalization idea with the PFR map: GNB→GB, KAN→KC, NOR→NO, LVR→LV,
  NWE→NE, SFO→SF, TAM→TB, STL/SDG/OAK per existing TEAM_CODE_FIXES era
  handling — full map enumerated in the plan).
- **Leakage guard:** the returned frame contains ONLY draft-day-known
  columns: `season, round, pick, team, gsis_id, player_name, position,
  age, college`. The career-outcome columns nflverse ships (games, w_av,
  to, career stats, allpro, …) describe the future and are structurally
  excluded — a test pins the exact column list.

### Rookie prior — `src/ffmodel/model/rookie.py` (new)

- `fit_rookie_cohorts(weekly, draft_picks, through_season) -> cohorts`
  Walk-forward: only classes `<= through_season` contribute. Each
  historical rookie's draft capital joins (by gsis_id) to their
  rookie-season weekly rows in `weekly`.
- Cohorts = position × capital bucket. Buckets: picks 1–12, rest of round
  1, round 2, round 3, rounds 4–7. Buckets under a pre-registered minimum
  sample (n ≥ 25 players) merge with their neighbor toward day 3 (QB/TE
  will merge more than RB/WR); merging is deterministic and recorded in
  the fitted object.
- Each cohort yields:
  - per-stat weekly p10/p50/p90 across cohort *playing* weeks (weeks the
    player actually recorded), for exactly `PREDICTED_STATS`;
  - a games-played distribution over 0..18 **including zero inflation**
    (players with no rookie-season weeks count at G=0 — the honest floor).
- `rookie_projection(cohorts, draft_row, n_weeks) -> (week_bands, games_probs)`
  returns the per-week point triples (identical cohort triples per
  scheduled week, scored via `fantasy_points_quantiles` per ruleset) and
  the cohort games distribution, ready for `simulate_season`.
- Acknowledged v1 simplification (stated on the about page): games-played
  and per-week quality are treated as independent within a cohort; weekly
  draws use the veteran positional rho from the existing copula machinery.

### Board integration — `src/ffmodel/site/draft.py` + `generate.py`

- During a `--draft` run, after veteran `season_projection`: pull the
  target season's draft class, fit cohorts through `season - 1`, and
  append one row per drafted rookie to the players frame **before**
  `_finalize_board`, so VORP, position ranks, and tiers are computed
  jointly with veterans on the same scale.
- Rookie rows: `player_id` = the nflverse draft id (placeholder format is
  fine — it is unique and stable), name, normalized team, position, bye
  from the team schedule, `games` = scheduled weeks, season p10/p50/p90
  per ruleset from `simulate_season` on the cohort inputs, and
  `"rookie": true`.
- **Dedupe rule:** a drafted player who already has ANY weekly rows in the
  handed-in history (matched by gsis_id when real, else normalized
  name+position) gets the real model only — the prior row is skipped.
  Preseason regens have no such overlap; in-season regens must not
  double-list.
- Payload: player field `"rookie": true|false` (veterans get `false`);
  methodology gains `"rookie_prior": {classes: "2012–<S-1>", n_rookies:
  int, buckets: <recorded merge scheme>}`.
- Weekly pipeline: untouched. Rookies enter weekly projections organically
  once they have NFL weeks (existing behavior).
- Sleeper crosswalk: rookie placeholder ids fail the gsis path and resolve
  via the name+position fallback (accent-folded); the Sleeper dump carries
  all drafted rookies. Unmatched rookies surface in the existing banner.

### Site — `site/index.html` / `site/assets/style.css` / `site/about.html`

- "R" chip next to rookie names (same chip idiom as position chips).
- About page: a short "Rookies" section — cohort prior methodology, why
  ranks look conservative vs ADP, the independence simplification, and
  UDFA exclusion.
- Board footer sentence updated to mention rookie priors.

## Evaluation (pre-registered, walk-forward)

- `src/ffmodel/eval/rookies.py` CLI → `models/diagnostics/rookie_backtest.json`
  (`models/backtests/` stays schema-locked to weekly/board reports).
- For each held-out class S ∈ {2023, 2024, 2025}: fit cohorts ≤ S−1,
  project class S, compare to actual rookie-season PPR totals.
- **Gate 1:** bucketed prior beats a position-only baseline (same machinery,
  single bucket per position) on Spearman rank correlation vs actual
  rookie-season PPR, pooled across the three classes.
- **Gate 2:** rookie season-band coverage (actual total inside [p10, p90])
  measured and reported per position, whatever it is. No target — this is
  the first measurement; honesty over tuning.
- **STOP rule:** if Gate 1 fails, ship position-only priors (still strictly
  better than absence), report the negative result in the diagnostics file
  and on the about page. Never tune bucket boundaries against the held-out
  classes.

## Error handling

| Failure | Behavior |
|---|---|
| Draft-picks pull fails during `--draft` run | Run aborts (same fail-safe as the Sleeper pull; weekly cron unaffected — it never pulls draft picks) |
| Target-season class empty/missing | Abort with a clear message (a 2026 `--draft` run without the 2026 class is a data problem, not a skip) |
| Cohort below min-n after all merging | Fall back to the position-only cohort for that bucket, recorded in methodology |
| Rookie also present in weekly history | Dedupe rule: real model wins, prior row skipped |
| Unknown/unnormalizable team code | Fail loud at pull time (fail-safe) — never silently mis-assign byes |

## Testing

Pure-function pytest coverage: leakage column guard (exact allowed list);
PFR team-code normalization (full map + unknown-code raise); bucket
assignment and deterministic min-n merging; playing-week quantiles and
zero-inflated games distribution; dedupe by gsis and by name+position;
walk-forward discipline in `fit_rookie_cohorts` (a class > through_season
must not influence cohorts); board schema (rookie flag, methodology block,
strict JSON); VORP joint-ranking with rookies present; rookie-backtest
report schema. Live verification at regen: 2026 class appears (~80 rows),
rookies slot at sane positions, Sleeper crosswalk matches them by name,
board renders with R chips.

## Out of scope (v1)

Undrafted rookies; college-production features (cfb ids exist but no free
loader in our stack — future work); market/ADP blending; rookie-aware
transformer (future research item; this feature is its baseline);
games/quality dependence modeling within cohorts.
