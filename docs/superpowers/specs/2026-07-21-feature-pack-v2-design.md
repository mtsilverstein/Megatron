# Feature pack v2 — design

**Date:** 2026-07-21 · **Status:** approved
**Feature:** three new leak-free model inputs — per-player **air-yards share**,
**team pass volume**, and an **indoor/roof flag** — added to the shared feature
builder so both the quantile transformer and the XGBoost baseline consume them
on equal footing. Ships in two halves: a **local half** (data pull, features,
v2 configs, tests) that is mergeable on its own because nothing deploys until
artifacts exist, and a later **retrain + gate half** the user runs on Kaggle
followed by an eval/calibration/promotion session. Site output is untouched
until — and unless — the pre-registered promotion gate passes.

## Motivation

v1 features capture a player's own recent production and generic opponent
strength. They miss three signals that are cheap, available at inference time,
and plausibly predictive of the raw stat lines we model:

1. **Air-yards share** — how much of a team's downfield passing volume a
   receiver commands. A high target-share slot receiver and a high-air-yards
   deep threat look identical under `target_share` alone but project very
   differently for yards and TDs.
2. **Team pass volume** — a team's recent pass-attempt rate scales every
   pass-catcher's and the QB's opportunity. Known through the prior week,
   carried forward for the upcoming week.
3. **Indoor/roof flag** — dome/closed-roof games remove weather variance and
   historically lift passing efficiency. Fully known from the schedule at
   inference time (no leakage).

EPA-based features were considered and **held back**: the join is against a
~100k-row play-by-play frame per season, the marginal signal over air-yards
share is uncertain, and it would widen the pull's data footprint materially.
Revisit only if v2 promotes and a later pack justifies the cost.

## Scope

**In:** `src/ffmodel/data/pull.py` (keep new source columns through
normalization), `src/ffmodel/data/features.py` (three new leak-free feature
builders wired into `feature_columns`), new v2 training configs under
`configs/`, and tests for the feature math and the pull whitelist. All local,
all reviewable before any training.

**Out:** any change to `models/backtests/` (schema-locked), the site JSON
schema or `site/` assets, the scoring functions, the calibration code, and the
transformer/XGBoost architectures. No hyperparameter sweep — v2 configs mirror
v1 exactly so the experiment isolates *features*, not tuning. No new data
sources beyond columns already present in the nflverse frames we pull.

## Data layer

nflverse probes (run during brainstorming) confirmed the source columns exist:

- `nflreadpy` player-stats (weekly) exposes `passing_air_yards`,
  `receiving_air_yards`, and `attempts`.
- `nflreadpy` schedules expose `roof` with values `outdoors` / `dome` /
  `closed` (plus `surface`, `temp`, `wind`, which we do **not** adopt in v2).

Changes:

- **`normalize_weekly`** must retain `receiving_air_yards` and `attempts`
  through normalization (today they are dropped). `passing_air_yards` is
  retained for the QB pass-volume path. The leakage whitelist and any
  same-week guards apply to these columns exactly as they do to existing stats.
- **`pull_schedules`** must retain `roof`. It already normalizes to a
  team/season/week grain; `roof` rides along unchanged.
- **Cache self-heal:** bump the weekly cache prefix to `weekly_v2` and the
  schedules prefix to `schedules_v3`. This guarantees a stale cache written
  before v2 (missing the new columns) is never served — the normalize-around-
  cache pattern established for `pull_schedules` / `pull_draft_picks` is
  followed so the whitelist and column checks run on every read path, not only
  on a cache miss.

## Features

All three follow existing idioms in `features.py` and are leak-free by
construction. `feature_columns(df)` — the single source of truth consumed by
both models — picks all three up.

### 1. `air_share` (lagged, joins `LAG_STATS`)

Per player per week: `air_share = player_air_yards / team_air_yards`, where
`player_air_yards = receiving_air_yards` (WR/RB/TE) and `team_air_yards` is the
per-team/season/week sum of `receiving_air_yards`. Division guards zero
denominators with `.replace(0, np.nan)` exactly as `_add_carry_share` does.
`air_share` is appended to `LAG_STATS` so it is lagged at windows `(4, 8)` by
the existing `_add_player_lags` machinery (shift(1) then rolling mean) — the
same treatment `target_share` and `carry_share` already receive. No same-week
raw `air_share` enters the feature set; only its lags do.

### 2. `team_pass_att_last4` (shifted-then-rolled, opponent-idiom)

Per team per week: team pass attempts (`attempts` summed to team/season/week),
then **shifted then rolled** over a 4-week window by team — the exact pattern
`_add_opponent_allowed` uses for `ppr_points` allowed. Because it is shifted
before rolling, the upcoming week inherits the last known 4-week average and no
current-week attempts leak. A team's future (unplayed) weeks inherit the last
observed value, matching how opponent-allowed already behaves at the season
frontier.

### 3. `is_indoor` (same-week, schedule-known)

`is_indoor = roof ∈ {dome, closed}` → 1, else 0 (`outdoors` and any
unknown/missing roof → 0). Merged onto the player-week frame by
team/season/week the same way `is_home` is merged in `_add_schedule_context`.
Because the schedule is fully known before kickoff, the **current week's**
`is_indoor` is a legitimate input — it is a `CONTEXT_FEATURE`, not a lagged
stat, exactly like `is_home`.

### Wiring

The two models consume features through different contracts, and both must
receive the same three signals:

- **XGBoost** consumes `feature_columns(df)`: `LAG_STATS` handling gains
  `air_share` (as an *optional* lag stat — computed and lagged only when its
  source column exists, so pre-v2 frames still build), `CONTEXT_FEATURES`
  gains `is_indoor`, and `team_pass_att_last4` joins the guarded `extra`
  block alongside `opp_allowed_last4` / `opp_allowed_season`.
- **Transformer** consumes the `SEQ_FEATURES` / `CTX_FEATURES` lists in
  `model/dataset.py` — *not* `feature_columns`. Editing those constants
  in place would break deployed v1 inference (input-dimension mismatch in
  the weekly Actions run), so v2 introduces a **versioned feature-set
  registry**: `FEATURE_SETS = {"v1": (SEQ_FEATURES, CTX_FEATURES), "v2":
  (SEQ_FEATURES + ["air_share"], CTX_FEATURES + ["team_pass_att_last4",
  "is_indoor"])}`. Training configs select a set via a `feature_set` key
  (default `"v1"`); the chosen name **and explicit lists** are recorded in
  the artifact's `metrics.json`; the predictor resolves each artifact's
  lists from its own metrics (missing keys → v1 constants), so existing v1
  artifacts predict byte-identically and v1/v2 artifacts can coexist in
  one eval run.

The raw per-game `air_share` rides in the sequence (the transformer's
history mechanism is its lag structure); its `lag4/lag8` means serve
XGBoost. `team_pass_att_last4` and `is_indoor` are target-week context for
both models. Same three signals, each model's native idiom.

## Training (user runs on Kaggle)

- New configs under `configs/`: `transformer_v2.yaml` plus the three
  walk-forward fold variants (`transformer_v2_through2022/2023/2024.yaml`),
  mirroring their v1 counterparts **byte-for-byte except** `run_name: v2` and
  the new `feature_set: v2` key. Same `lr=1e-3`, same schedule, same
  everything else — no new sweep. A committed test pins this mirror invariant.
- Seed-ensemble members come from the existing train CLI `--seed 43` /
  `--seed 44` flag (`apply_seed_override` routes artifacts to sibling roots
  `models/transformer/v2_s43`, `.../v2_s44`) — no per-seed config files,
  matching how the v1 ensemble was produced.
- The config-aware "skip if complete" training path already lets the user run
  the seeds/folds within Kaggle's 30 GPU-h/week budget (T4 ×2, not P100/sm_60).
- Each artifact is committed with its YAML and eval metrics, per the repo
  invariant.

## Promotion gate (pre-registered, binding)

v2 promotes to the site **only if both** hold, measured walk-forward on the
held-out seasons through the same eval harness as v1:

1. **Accuracy:** the v2 three-seed ensemble beats the deployed v1 ensemble on
   overall walk-forward PPR MAE (current bar **4.326**), and `pinball_p50` is
   **not worse** than v1.
2. **Calibration:** a fresh Phase-B-style conformal refit on v2 lands weekly
   coverage inside the **0.75–0.85** target windows for every position/tail it
   governs.

If either fails, v2 does **not** ship: the result is written as an honest
negative to `models/diagnostics/` and the site stays on v1. The gate is fixed
now, before any v2 numbers exist, and is never re-tuned against the 2023–2025
held-out seasons. Whichever model wins is reported honestly.

## Error handling

| Case | Behavior |
|---|---|
| Stale pre-v2 cache missing new columns | Prefix bump (`weekly_v2`/`schedules_v3`) forces a fresh, normalized pull |
| `team_air_yards` denominator 0 | `air_share` → NaN via `.replace(0, np.nan)`, then lagged; no divide error |
| Team's future weeks have no attempts yet | `team_pass_att_last4` inherits last observed value (shift-then-roll frontier behavior) |
| `roof` missing / unexpected value | `is_indoor` → 0 (treated as outdoors) |
| A model trains without v2 artifacts present | Nothing deploys; local half is inert until Kaggle produces v2 models |
| Gate fails | Honest negative to `models/diagnostics/`, site unchanged on v1 |

## Testing

Python suite runs under `PYTHONPATH=src` with `-W error`. New tests
concentrate on the leak-prone pure functions, per the repo's testing contract:

- **`air_share`:** team sum correct across a two-player/one-team fixture;
  zero-denominator week yields NaN not error; only lagged columns
  (`air_share_last4/8`) appear in `feature_columns`, never a same-week
  `air_share`.
- **`team_pass_att_last4`:** shift-then-roll produces the prior-weeks average
  with no current-week leakage (a spike in the current week must not appear in
  that week's feature value); a team's unplayed frontier week inherits the last
  value.
- **`is_indoor`:** dome/closed → 1, outdoors/missing → 0; present as a
  current-week `CONTEXT_FEATURE` for the row being predicted.
- **Pull whitelist:** `normalize_weekly` retains `receiving_air_yards`,
  `attempts`, `passing_air_yards`; `pull_schedules` retains `roof`; a stale
  cache written under the old prefix is not served (prefix-bump regression,
  mirroring the draft-picks stale-cache test).
- **Lockstep:** `feature_columns` exposes all three signals to XGBoost;
  the `FEATURE_SETS["v2"]` registry entry exposes the same three to the
  transformer; a registry test pins both lists.
- **v1 safety:** an artifact whose `metrics.json` lacks feature lists (every
  deployed v1 artifact) predicts byte-identically before and after this
  change; a train run without `feature_set` in its config records `v1`.
- **Config mirror:** each `transformer_v2*.yaml` equals its v1 counterpart
  on every key except `run_name` and `feature_set` (the no-new-sweep
  invariant, enforced by test).

Veteran calibrated projections are **not** expected to change from the local
half alone (no artifacts yet); the retrain half is where v2 numbers first
appear, gated as above.

## Sequencing

1. **Local half (now):** pull columns → features → v2 configs → tests →
   review → merge. Mergeable independently; deploys nothing.
2. **Kaggle retrain (user):** three v2 seeds within the weekly GPU budget.
3. **Eval / calibration / gate session:** run the walk-forward harness and the
   Phase-B refit against the real v2 artifacts, apply the pre-registered gate,
   and either promote v2 or commit the honest negative.

## Out of scope

EPA / play-by-play features; `surface`/`temp`/`wind` weather inputs; any
hyperparameter tuning; K/DST/IDP or any position outside QB/RB/WR/TE; changes
to scoring, calibration architecture, site schema, or `models/backtests/`.
