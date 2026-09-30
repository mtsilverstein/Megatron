# Roster Sim v2 + Prospective 2026 Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship roster-sim v2 (Gaussian copula per-player season factor) and freeze a complete, remotely witnessed prospective test on the 2026 season across four league formats before the first week-5 kickoff.

**Architecture:** A format contract (`configs/formats/*.yaml` + `format_key`/`compat` in Python and JS) defines what a verdict is keyed by. The engine change lives in `site/assets/rostersim.js` (shared by page and backtest). A Python fit estimates ρ on 2023–25 development residuals. Node tools materialize every decision (drafts, trades, waiver sets) at an origin and evaluate them after the season. A GitHub Actions workflow builds all artifacts, writes a hashed manifest, refuses after the cutoff, commits and tags.

**Tech Stack:** Node (UMD modules, `node tests/*.cjs` fixtures), Python 3 (`src/ffmodel`, pytest, `.venv/Scripts/python.exe`), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-30-roster-sim-v2-prospective-design.md` (read §1–§9 before any task). Consultation record: `.review/astra-v2-response.md`, `.review/astra-v2-round2-response.md`, `.review/astra-v2-formats-response.md`.

## Global Constraints

- Hard cutoff: the earliest week-5 kickoff (expected `2026-10-09T00:15Z`), read from the nflverse schedule. Dry run green by **2026-10-04**; origin-5 freeze published by **2026-10-07T23:59Z**.
- Primary formats, exactly: `f12-1qb-ppr-6`, `f10-1qb-ppr-6`, `f12-1qb-ppr-4`, `f12-sf-ppr-4` (M = 4). Exploratory: `f12-1qb-half-4`.
- ρ fit lens: `f12-1qb-ppr-4`. ρ per position in [0, 0.5], shrinkage `w = n/(n+200)`, clip 1e-4, 2,000 player bootstrap, trajectories ≥ 4 valid weeks.
- Engine: weekly marginals must be unchanged by ρ; separate keyed streams `avail`, `factor`, `noise` per player id; replacement players carry real ids; no id fills two slots in one week.
- Decision population per format: 20 drafts, seeds `1000*2026 + k`; 125 trades per draft per origin; origins 5 and 9; waiver quota QB 2 / RB 3 / WR 3 / TE 2; 2,000 sims for v2 and ρ = 0.
- Verdict (trade): coverage in [0.70, 0.90] per origin, pooled, per origin×stratum; interval score v2 < ρ=0; one-sided bounds at 1 − 0.05/16: (v2−current) MAE and regret < +1.0, (v2−naive) MAE and regret < 0; per origin observed (v2−current) ≤ +1.0, (v2−naive) ≤ 0; no stratum (v2−current) MAE interval entirely above +1.0; ≥ 200 sides per origin×stratum; resample whole draft seeds, B = 20,000, shared indices across formats. Statuses: `conditional_pass`, `conditional_fail`, `inconclusive`.
- Verdict (waiver, separate): (v2−current) and (v2−naive) regret upper bounds < 0 at 1 − 0.05/8.
- Unknown is never zero; fail closed; no nearest-format or owner-slug fallback.
- Never re-score 2023–25 as a v2 validation. Public repo: no other managers' data committed (league settings are fine).
- Every node fixture and `pytest` stays green; `.venv/Scripts/python.exe -m pytest -q`.

## Review Focus

1. A live Sleeper league with K, DEF, BN, IR and TAXI slots must map to the same `format_key` + `compat` as its format config — both owner leagues must match their `-6` formats exactly (Task 1 fixture on real `roster_positions`/`scoring_settings`).
2. A replacement player who fills slots in two different weeks must share one season factor, and must never fill two slots in the same week (Task 2 fixture).
3. The freeze must refuse (non-zero exit, nothing committed) when run at or after the cutoff, when the schedule lacks week 5, or when the clock is ambiguous (Task 7 test with an injected clock).
4. PIT on degenerate quantiles (p10 = p50 = p90), actuals exactly at the floor atom, and actuals below the floor must neither crash nor bias ρ (Task 3 tests).
5. A rostered player with no 2026 forecast row at the origin (rookie, trade, suspension) must make the cell excluded → `inconclusive`, never silently dropped (Task 5/6 fixtures).

---

### Task 1: Format contract slice

**Files:**
- Create: `configs/formats/f12-1qb-ppr-6.yaml`, `f10-1qb-ppr-6.yaml`, `f12-1qb-ppr-4.yaml`, `f12-sf-ppr-4.yaml`, `f12-1qb-half-4.yaml`
- Create: `src/ffmodel/formats.py`, `site/assets/formats.js`
- Create: `tests/test_formats.py`, `tests/formats_fixture.cjs`, `tests/fixtures/owner_league_settings.json`
- Modify: `src/ffmodel/eval/export_origin_forecasts.py` (add `--league-dir`), `src/ffmodel/eval/draft_world.py` (add `--league-dir` later used by Task 4)

**Interfaces:**
- Produces (Python): `load_format(label) -> LeagueConfig` (= `load_league(label, root=FORMAT_DIR)`); `format_key(cfg) -> str` (64-hex); `compat(cfg) -> dict[str, float]`; `from_sleeper(league: dict) -> tuple[str, dict]` returning `(format_key, compat)` from a Sleeper `/league/<id>` payload; `match(league_payload, formats) -> str | None` (label or None).
- Produces (JS, UMD `window.Formats`): `formatKey(desc)`, `compat(desc)`, `fromSleeper(league)`, `match(league, table)` where `table` is `[{label, format_key, compat}]`. Hashing: SHA-256 hex of the canonical JSON string (Node `crypto`; browser `crypto.subtle`, so `formatKey` is `async` in JS and returns a Promise in both environments).
- Canonical JSON: keys sorted, no whitespace, numbers normalized by `Math.round(x*1e6)/1e6` (Python `round(x, 6)`, `-0` → `0`).

Format key content (spec §4.2), exactly:
```json
{"teams": 12,
 "slots": [["FLEX",["RB","TE","WR"]],["QB",["QB"]],["RB",["RB"]],["RB",["RB"]],["TE",["TE"]],["WR",["WR"]],["WR",["WR"]], ...sorted],
 "roster_size": <int>,
 "predicted": {"<scoring.py predicted field>": <weight>, ...}}
```
`predicted` = the fields of `ScoringRules` that the model predicts: read the predicted-stat set in `src/ffmodel/scoring.py` (astra counted eleven) and map each to its weight; everything else is `compat`. `compat` = every offensive Sleeper scoring key that is not mapped to a predicted field (at least: `pass_int_td`, `pass_td_50p`, `rush_td_50p`, `rec_td_50p`, `pass_2pt`, `rush_2pt`, `rec_2pt`, `st_td`, `fum_rec_td`, `bonus_rec_te`, `bonus_rec_rb`, `bonus_rec_wr`, `bonus_fd_*`, `pass_cmp`, `pass_inc`, `rush_att`), omitted → 0; K/DEF/IDP keys (`fgm*`, `xp*`, `pts_allow*`, `sack`, `int`, `def_*`, `st_fum_rec`, `st_ff`, `ff`, `fum_rec`, `safe`, `blk_kick`, `idp_*`) are ignored. An offensive key that is neither predicted nor in the known compat list and is nonzero → `match` returns None (fail closed). The same audit table lives in both implementations; the fixture asserts they are identical.

Roster mapping (spec §4.3): from `roster_positions` drop `K`, `DEF`, `IR`, `TAXI`; `BN` counts toward `roster_size`; `roster_size` = remaining count; starter slots = the non-BN remaining entries; `FLEX` → [RB,WR,TE], `WRRB_FLEX` → [RB,WR], `REC_FLEX` → [WR,TE], `SUPER_FLEX` → [QB,RB,WR,TE]. From a YAML config: slots from `roster` + `flex`×(`SUPER_FLEX` if QB in `flex_positions` else `FLEX`), `roster_size` from a new optional key `roster_size` (required in `configs/formats/*.yaml`).

- [ ] **Step 1: Pin the owner leagues' live settings.** Fetch `https://api.sleeper.app/v1/league/1376245373244301312` and `.../1389736745205002240` (public, read-only) and save only `total_rosters`, `roster_positions`, `scoring_settings` for each into `tests/fixtures/owner_league_settings.json` (no users, rosters or names). Compute each league's `roster_size` by the mapping rule.
- [ ] **Step 2: Write the five configs.** `f12-1qb-ppr-6` copies `configs/leagues/gabagool.yaml` (roster, flex, flex_positions, rounds, `scoring`, full `sleeper_scoring`, `depth_cap`) with `name`, `league_id: "format"`, `roster_size` from Step 1; `f10-1qb-ppr-6` copies `configs/leagues/fam.yaml` the same way (its own scoring — no distance bonuses); `f12-1qb-ppr-4` = Gabagool's shape with `scoring: {reception: 1.0, pass_td: 4.0, interception: -2.0, pass_int_td: 0.0}` and a `sleeper_scoring` holding only offensive keys: pass_yd 0.04, pass_td 4, pass_int −2, rush_yd 0.1, rush_td 6, rec 1, rec_yd 0.1, rec_td 6, fum_lost −2, pass_2pt 2, rush_2pt 2, rec_2pt 2 (no bonuses, pass_int_td 0); `f12-sf-ppr-4` = same scoring, `roster: {QB: 1, RB: 2, WR: 3, TE: 1}`, `flex: 1`, `flex_positions: [QB, RB, WR, TE]`; `f12-1qb-half-4` = `f12-1qb-ppr-4` with reception/rec 0.5. `roster_size` for the `-4` formats = Gabagool's. `load_league` must accept them (its `SLEEPER_RULE_FIELDS` consistency check must pass).
- [ ] **Step 3: Write failing tests.** `tests/test_formats.py`: (a) the two owner fixtures `match` → `f12-1qb-ppr-6` / `f10-1qb-ppr-6`; (b) all five format keys distinct; (c) same `format_key`, different `compat` for pick-six (`pass_int_td` −3 vs 0), a 50-yd bonus, and `bonus_rec_te` 0.5 → `match` None; (d) an unknown nonzero offensive key → None; (e) a K/DEF/IDP key change does not change either part; (f) IR/TAXI count changes nothing; BN count changes `roster_size`. `tests/formats_fixture.cjs`: the same cases in JS, plus Python↔JS equality of both parts on all five configs and both owner fixtures, computed by spawning `.venv/Scripts/python.exe -c` via `child_process.execFileSync` to print the Python values as JSON (node fixtures are local-only, like the others).
- [ ] **Step 4: Run to see them fail.** `.venv/Scripts/python.exe -m pytest tests/test_formats.py -q` → FAIL (module missing). `node tests/formats_fixture.cjs` → FAIL.
- [ ] **Step 5: Implement `formats.py` and `formats.js`** per the interfaces above.
- [ ] **Step 6: Exporter/world flag.** `export_origin_forecasts.py`: `--league-dir` (default `configs/leagues`), passed as `load_league(args.league, root=Path(args.league_dir))`; record `"format_key"`/`"compat"` in the output when the dir is `configs/formats`. Same flag on `draft_world.py`'s parser (used in Task 4). Add a pytest that `export_origin_forecasts`'s parser accepts `--league-dir configs/formats --league f12-1qb-ppr-4` and `load_league` resolves it.
- [ ] **Step 7: Run tests to pass**, then the whole suite: every `node tests/*.cjs` and `.venv/Scripts/python.exe -m pytest -q`.
- [ ] **Step 8: Commit** `feat: format contract — configs/formats, format_key + compat (Py/JS), exporter --league-dir`.

### Task 2: Engine v2 (copula, streams, replacement identity)

**Files:**
- Modify: `site/assets/rostersim.js`
- Modify: `tools/trade_backtest.cjs` (`buildSimWorld` passes replacement ids and `copula`), `site/assets/seasontrade.js` and `site/assets/waivers.js` (pass `copula: { rho: ZERO_RHO }` and replacement ids; gates stay closed, behavior otherwise unchanged)
- Test: `tests/rostersim_fixture.cjs` (extend), `tests/sim_parity_fixture.cjs` (keep green), `tests/trade_backtest_fixture.cjs` (keep green)

**Interfaces:**
- `createWorld(cfg)`: `cfg.copula = { rho: { QB, RB, WR, TE } }` required — each finite in [0, 0.5] else `RosterSimError("copula rho …")`. `cfg.replacement[w][pos]` entries become `{ id, p10, p50, p90 }`; an entry without a string `id`, or the same id twice in one week's list (any position), throws. A replacement id that is also a key of `cfg.players` throws.
- Streams: `rng(kind, id) = mulberry32((seed ^ hash(kind + ":" + id)) >>> 0)` for kind ∈ `avail`, `factor`, `noise`.
- Exported additionally: `ZERO_RHO = Object.freeze({QB:0,RB:0,WR:0,TE:0})`.

Core change (replace the per-player loop body and the replacement block):
```js
const Z90 = 1.2815515655446004;
function normCdf(x) { // Abramowitz-Stegun 7.1.26 via erf; |err| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
function gauss(rand) { // Box-Muller, consumes exactly two uniforms
  const u1 = Math.max(rand(), 1e-300), u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
// Per id: one Z per sim (factor stream), one eps per (sim, week index) (noise stream).
function latent(id, rho, N, W) {
  const f = rng("factor", id), n = rng("noise", id), a = Math.sqrt(rho), b = Math.sqrt(1 - rho);
  const u = new Float64Array(N * W);
  for (let s = 0; s < N; s++) { const z = gauss(f); for (let i = 0; i < W; i++) u[s * W + i] = normCdf(a * z + b * gauss(n)); }
  return u;
}
```
Rostered players: availability from `rng("avail", id)` (one uniform per non-bye, non-forced week in the existing order — the chain logic is unchanged); points `drawPoints(row, uLatent[s*W+i])` for available weeks. Replacement players: collect every replacement id across weeks; for each id compute `latent(id, rho[pos], N, W)` once; the draw for week i is `drawPoints(q_week_i, u[s*W+i])`. Candidates in `value()` carry `id: r.id` (the real id), so one id appears once per week list and `bestLineup` can start it at most once per week.

`normCdf` accuracy note: 1.5e-7 absolute is ample for simulation; `invNorm` in `drawPoints` is unchanged.

- [ ] **Step 1: Write failing fixture groups** in `tests/rostersim_fixture.cjs`:
  - (v2a) weekly marginal: one player, 1 week, ρ ∈ {0, 0.2, 0.5}, N = 20,000 — empirical p10/p50/p90 of `pts` within ±0.02·(p90−p10) of the row's quantiles (read via `world.value([id]).totals` with a single-slot lineup that always starts him).
  - (v2b) season variance: one always-starting player, 12 identical play weeks, symmetric quantiles, N = 20,000 — var(totals, ρ=0.25) / var(totals, ρ=0) within 10% of 1 + 11·0.25 = 3.75.
  - (v2c) availability identical: same seed, ρ = 0 vs 0.4 — the set of (sim, week) where the player is available is identical (expose nothing new: compare `perWeek` start counts on a zero-variance quantile row where points = constant).
  - (v2d) identical rosters Δ ≡ 0 via `compare(world, ids, ids)` (mean, p10, p90 all 0) at ρ = 0.3.
  - (v2e) order invariance: permuting `players` object order and each week's replacement list order gives identical `value().totals`.
  - (v2f) replacement identity: a replacement id present in weeks 1 and 2 with identical quantiles and ρ = 0.5 — the Pearson correlation of its week-1 and week-2 draws across sims is > 0.3 (theory ≈ 0.48 for ρ = 0.5 on symmetric quantiles) and ≈ 0 (|r| < 0.03) at ρ = 0; an id repeated inside one week's list throws; a replacement id equal to a rostered id throws.
  - (v2g) missing/invalid `copula` throws `RosterSimError` (absent, ρ = 0.6, ρ = NaN, missing TE).
- [ ] **Step 2: Run** `node tests/rostersim_fixture.cjs` → the new groups FAIL.
- [ ] **Step 3: Implement** the engine change above.
- [ ] **Step 4: Update callers.** `trade_backtest.cjs::buildSimWorld`: carry each replacement candidate's real player id from the world (today it passes only quantiles — find where the per-week pool is built and keep the id), and pass `copula` from a new `cfg.rho` (default `ZERO_RHO`; CLI flag `--rho <path to rho.json>` reading `.table`). `seasontrade.js` / `waivers.js`: the same (ids come from the board/remaining player ids already used to build the pool), `copula: { rho: RosterSim.ZERO_RHO }` for now.
- [ ] **Step 5: Run** all node fixtures: `for f in tests/*.cjs; do node $f || echo FAIL $f; done` → all green. Existing v1 fixtures that pinned exact sim numbers will change because the stream layout changed; update those expectations only where the change is the stream layout (document each in the report), never to paper over a logic change. `sim_parity_fixture.cjs` must stay equality.
- [ ] **Step 6: Commit** `feat: roster sim v2 — Gaussian copula season factor, keyed streams, replacement identity`.

### Task 3: ρ fit on development residuals

**Files:**
- Create: `src/ffmodel/eval/copula_fit.py`, `tests/test_copula_fit.py`
- Output: `models/prospective/2026/rho.json`; development exports `models/prospective/dev/forecasts_{2023,2024,2025}_o{5,9}_f12-1qb-ppr-4.json`

**Interfaces:**
- Consumes: forecast JSON (schema of `export_origin_forecasts.py`: `players[pid] = {position, team, weeks{w: {status, p10,p50,p90}}}`), and realized weekly points in the same predicted scope under the same rules (use `ffmodel.eval.draft_world.weekly_actuals(weekly, season, rules)` with `rules = load_format("f12-1qb-ppr-4").rules`).
- Produces: `pit(q, x, rng) -> float | None` (None = support violation), `fit(trajectories, *, k=200, clip=1e-4, n_boot=2000, seed=20260930) -> dict`, CLI `python -m ffmodel.eval.copula_fit --forecasts <files...> --out models/prospective/2026/rho.json`. `rho.json` = `{"table": {QB,RB,WR,TE}, "pooled": float, "raw": {pos: float}, "n_trajectories": {pos}, "n_players": {pos}, "n_week_pairs": {pos}, "support_violations": {pos}, "bootstrap_ci": {pos: [lo, hi]}, "sensitivity_violations_at_atom": {pos: float}, "diagnostics": {pos: {origin: {"pit_mean", "pit_sd", "lag1", "lag4"}}}, "implied_multiplier": {pos: {"n9": 1+8ρ, "n13": 1+12ρ}}, "lens": "f12-1qb-ppr-4", "seed": 20260930, "code_sha": "<git sha>"}`.

PIT under the implemented distribution (spec §5.2): `drawPoints(q,u)` maps z = Φ⁻¹(u) to x = p50 + z·s (s = left or right sigma = (p50−p10)/Z90 or (p90−p50)/Z90), floored at `f = min(0, 2·p10)`. So F(x) = 0 for x < f (support violation → None); for x = f exactly (the atom) u ~ Uniform(0, Φ((f − p50)/s_left)) drawn from `rng`; for x > f: z = (x − p50)/s_side, u = Φ(z). When s_side = 0 (degenerate): x == p50 → u ~ Uniform over the jump (between Φ of the left limit and Φ of the right limit, i.e. (0.5·[left degenerate] … ) — implement generally as u ~ Uniform(F(x⁻), F(x)); x ≠ p50 on a zero-spread side → support violation. z = Φ⁻¹(clip(u, 1e-4, 1−1e-4)).

Estimator (spec §5.4): per trajectory (player, season, origin) with ≥ 4 valid weeks, after subtracting the position×origin mean of z: for each trajectory t, c_t = mean over ordered pairs w≠w' of z_w·z_w' and v_t = mean of z_w²; ρ̂_pos = (mean over trajectories of c_t) / (mean over trajectories of v_t), trajectories equally weighted (a ratio of means, not a mean of ratios, for stability on short trajectories); pooled = the same over all positions' trajectories; shrink `w = n/(n+200)`; clamp [0, 0.5]; bootstrap by resampling players (all their trajectories) 2,000 times with `seed`.

- [ ] **Step 1: Start the development exports now (long; background).** After Task 1's `--league-dir` exists:
  `for S in 2023 2024 2025; do for O in 5 9; do .venv/Scripts/python.exe -m ffmodel.eval.export_origin_forecasts --season $S --origin $O --last-week 17 --league-dir configs/formats --league f12-1qb-ppr-4 --out models/prospective/dev/forecasts_${S}_o${O}_f12-1qb-ppr-4.json; done; done`
- [ ] **Step 2: Write failing tests** `tests/test_copula_fit.py`: (a) synthetic trajectories generated from the exact `drawPoints` map with known ρ ∈ {0, 0.15, 0.3} (300 players × 3 seasons × 12 weeks) recover ρ within ±0.04; (b) an actual below the floor → `pit` None and counted; (c) an actual exactly at the floor atom gives u in (0, Φ((f−p50)/s_left)] and is deterministic under the seed; (d) p10 = p50 = p90 with x = p50 → a finite u in the jump, x ≠ p50 → None; (e) trajectories with < 4 valid weeks are excluded; (f) negative raw estimates clamp to 0 and are reported; (g) byes/absent weeks never enter (rows without an actual are skipped).
- [ ] **Step 3: Run** `.venv/Scripts/python.exe -m pytest tests/test_copula_fit.py -q` → FAIL.
- [ ] **Step 4: Implement** `copula_fit.py`.
- [ ] **Step 5: Tests pass**, then run the CLI on the six development exports; write `rho.json`. Sanity: report `implied_multiplier` beside the diagnosed 1.7–3.0×; if any ρ hits the 0.5 bound or the pooled estimate is < 0.02, STOP and report to the controller (do not tune).
- [ ] **Step 6: Commit** `copula_fit.py`, tests, the six dev exports and `rho.json`: `feat: copula ρ fit on 2023–25 development residuals (f12-1qb-ppr-4 lens)`.

### Task 4: 2026 prediction-side world and origin tags

**Files:**
- Modify: `src/ffmodel/eval/draft_world.py` (`--no-actuals`, `--league-dir`, `--market-snapshot`), `src/ffmodel/eval/availability.py` (a `tags` CLI for one season/week)
- Test: `tests/test_draft_world.py` (extend or create), `tests/test_availability.py` (extend)
- Output: `models/prospective/2026/world_2026.json` (no `actual_weeks`), `models/prospective/2026/o5/tags_w4.json`

**Interfaces:**
- `build_season_world(..., include_actuals: bool = True, market: pd.DataFrame | None = None)`; with `include_actuals=False` the payload has no `actual_weeks` key and `"outcomes": "excluded"`.
- `availability.py tags --season 2026 --week 4 --out <path>` → `{"season", "week", "source", "retrieved_at", "tags": {gsis: status}}` using `tags_by_week` (statuses as `normalizeTag` accepts).

- [ ] **Step 1: Verify the market premise (write the answer in the report).** Does `consensus_for_season(2026, …)` return the **preseason** 2026 draft consensus (a snapshot dated on or before the 2026 season's first game, 2026-09-10)? Print its as-of date. If it is in-season or undated, use `--market-snapshot data_snapshots/FantasyPros_2026_Draft_ALL_Rankings_2026-09-08.csv` (commit that CSV with the world) and map it with the same `market_positions`/id matching; record `market_source: "fantasypros_draft_2026-09-08"`.
- [ ] **Step 2: Failing tests:** `include_actuals=False` → no `actual_weeks`, and `weekly` rows of season 2026 never reach the board (assert `board_world(weekly, 2026)` uses seasons < 2026 only — construct a frame with a poison 2026 row and assert it is absent); the tags CLI output shape; a player tagged `SUSPENDED`-spelled status is reported as-is and listed under `"unmapped"`.
- [ ] **Step 3: Implement**, tests pass.
- [ ] **Step 4: Build** `world_2026.json` with `--model transformer` and the production artifact root (`models/transformer/v1`, as the exporter's default roots; the entrant is prefit through 2025), `--no-actuals`, all three rulesets' `season_points` present (`ppr`, `half_ppr`, `standard`, `league`). Record the command in the report.
- [ ] **Step 5: Commit** `feat: 2026 prediction-side world (no outcomes) and per-week origin tags`.

### Task 5: Materializer (decisions at an origin)

**Files:**
- Create: `tools/prospective_materialize.cjs`, `tests/prospective_materialize_fixture.cjs`
- Modify: `tools/trade_backtest.cjs` (export the pieces reused: trade sampling with the §10.2 starter filter, waiver quota/pool builder, lopsided measure, replacement pool builder), `tools/draft_sim.cjs` (none expected; `applyLeague` already accepts a config)

**Interfaces:**
- CLI: `node tools/prospective_materialize.cjs --season 2026 --origin 5 --formats f12-1qb-ppr-6,f10-1qb-ppr-6,f12-1qb-ppr-4,f12-sf-ppr-4 --exploratory f12-1qb-half-4 --world models/prospective/2026/world_2026.json --forecasts-dir models/prospective/2026/o5 --tags models/prospective/2026/o5/tags_w4.json --leagues 20 --trades 125 --out models/prospective/2026/o5/decisions`
- Output per format: `decisions/<label>.json` = `{format_key, compat, label, primary: bool, season, origin, weeks, drafts: [{k, draft_seed, rosters: [[ids]...]}], trades: [{id, k, a, b, package, give_a, give_b, drop_a, drop_b, strata}], waiver: [{k, team, adds: [ids], pool_by_week}], replacement_by_week: {w: {pos: [ids]}}, lopsided_cutoff, population: {attempts, accepted, rejected_not_starter}, excluded: [{k, reason, players}]}` plus `decisions/cells.json` = the expected cell manifest `[{format, k, origin}]` with deterministic keys `"<label>|2026|<origin>|<k>"`.
- Draft: `applyLeague(formatConfigAsBoardLeague)` then `runDraft(worldPlayers scored under the format's world ruleset, heroSlot 0, seed 1000*2026 + k, field "measured")` exactly as `trade_backtest.cjs` does for historical worlds (read how it maps a world + league into `runDraft` and reuse that function, do not copy logic). World ruleset key: `-6` formats → `league`; `-4` → `ppr`; half → `half_ppr`.
- Forecast files for the origin are the per-format exports `forecasts_2026_o5_<label>.json` (Task 7 produces them; the fixture uses tiny synthetic ones).
- A rostered player without a full forecast row set for weeks O..17 → the cell is recorded in `excluded` (never dropped silently).

- [ ] **Step 1: Failing fixture** (`tests/prospective_materialize_fixture.cjs`) on a tiny synthetic world (40 players, 2 formats: a 4-team 1QB and a 4-team superflex config written in the fixture, 2 drafts, 5 trades, weeks 5–7): determinism (two runs byte-identical); every trade satisfies the §10.2 starter filter; superflex drafts start ≥ 2 QBs on some team; cells manifest complete; a rostered player lacking week 6 → that cell in `excluded`; lopsided cutoff equals the 90th percentile (type 7) of the current-method max-side |Δ| over that origin's trades; no outcome data is read (the fixture world has no `actual_weeks`, and the tool must not require it).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (export and reuse `trade_backtest.cjs` functions). **Step 4:** fixture + all node fixtures green.
- [ ] **Step 5: Commit** `feat: prospective materializer — per-format drafts, trades, waiver sets, cutoffs, cell manifest`.

### Task 6: Evaluator and gate writer (frozen before outcomes)

**Files:**
- Create: `tools/prospective_eval.cjs`, `tests/prospective_eval_fixture.cjs`
- Output (at season end, not now): `models/prospective/2026/eval.json`, `site/data/sim_gates.json`

**Interfaces:**
- CLI: `node tools/prospective_eval.cjs --freeze models/prospective/2026 --outcomes models/prospective/2026/outcomes_2026.json --rho models/prospective/2026/rho.json --out models/prospective/2026/eval.json --gates-out site/data/sim_gates.json [--jobs N] [--shard i/n --cells-out <path>] [--merge <cells...>]`
- Arms per trade side and waiver decision: v2 (ρ table, 2,000 sims), ρ = 0 (2,000 sims, same seeds), current, naive — reuse `trade_backtest.cjs`'s predictors and realized-value code (export them; do not copy).
- Metrics: MAE, regret, sign accuracy, 80% coverage, mean width, lower/upper miss rates, interval score `U − L + 10·(L − y)·[y<L] + 10·(y − U)·[y>U]`, per origin, pooled (equal-origin weights), per origin×stratum.
- Inference: paired resampling of whole draft seeds k (all origins, both sides, all decisions of that draft together), B = 20,000, resample indices generated once from `mulberry32(hashStr("prospective-2026"))` and shared by every format; one-sided upper bound = the (1 − α) quantile (type 7) of the resampled statistic with α = 0.05/16 (trade), 0.05/8 (waiver).
- Status per (format, feature) exactly per spec §6.3/§6.4; exploratory formats get the metrics and `"status": "exploratory"`, never a pass.
- `sim_gates.json`: `{"schema_version": 3, "generated_at", "engine": "rostersim-v2", "rho_sha256", "evidence": "2026 prospective, synthetic leagues", "origins": [5, 9], "horizon_rule": "nearest origin, ties to shorter", "records": [{"label", "format_key", "compat", "feature": "trade_grade"|"waiver_sim", "status", "horizons": [...E and cutoff per origin as v1 schema 2]}]}`.
- Reporting (not verdict inputs, spec §6.5): superiority over current; teammate/stack subsets (a side receiving or giving two players of one NFL team); concentration sensitivity (recompute pooled metrics dropping the 10 highest-exposure players, then the 10 highest-exposure NFL teams, both origins together); support-violation counts carried from `rho.json`; v1 per-season coverage context copied from the spec.
- `--shard i/n` evaluates cells whose deterministic index ≡ i mod n and writes them; `--merge` rejects duplicate or missing cells against `cells.json` (project B uses this; implement now so it is frozen).

- [ ] **Step 1: Failing fixture** with synthetic freeze + outcomes built in the fixture: (a) a world constructed so v2 intervals cover ~80% → `conditional_pass`; (b) same with v2 intervals deliberately too narrow → `conditional_fail` citing the coverage rule; (c) one expected cell missing → `inconclusive`; (d) a stratum with < 200 sides → `inconclusive`; (e) MUTATION CHECKS: for each of the seven trade rules, a variant input that violates only that rule flips the status to `conditional_fail` (or `inconclusive` for rule 1) — delete-a-rule mutations must fail the fixture; (f) exploratory format never passes; (g) sharded run (3 shards) merged equals the unsharded result byte-for-byte; duplicate or missing shard cell → error; (h) waiver verdict independent of trade verdict.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** fixture + all node fixtures green.
- [ ] **Step 5: Commit** `feat: prospective evaluator — §6 verdicts, interval score, draft-seed bootstrap, shards, sim_gates.json`.

### Task 7: Freeze workflow, manifest, dry run

**Files:**
- Create: `src/ffmodel/prospective/freeze.py` (+ `__init__.py`), `tests/test_freeze.py`, `.github/workflows/prospective-freeze.yml`
- Output: `models/prospective/2026/o<O>/manifest.json` and all artifacts under `models/prospective/2026/o<O>/`; dry run under `models/prospective/2026/dryrun-o4/`

**Interfaces:**
- CLI: `python -m ffmodel.prospective.freeze --season 2026 --origin 5 [--dry-run] [--now <ISO for tests only>]`. Steps in order, each failing closed:
  1. Cutoff: from `pull_schedules([season])`, earliest `gameday+gametime` (ET → UTC) of week `origin` REG games; missing week → exit 2. If `now >= cutoff − 0` → exit 3 (no artifacts written). `--dry-run` uses origin 4's cutoff check but never tags.
  2. Data freshness: `pull_weekly` has every REG game of weeks < origin (compare to schedule) else exit 4.
  3. Exports: for each of the five formats `export_origin_forecasts --season 2026 --origin O --league-dir configs/formats --league <label> --out o<O>/forecasts_2026_o<O>_<label>.json`.
  4. Tags: `availability tags --season 2026 --week O−1`.
  5. Copy `rho.json`, `world_2026.json`, `site/data/availability.json`, the five configs, the market snapshot into `o<O>/inputs/` (origin 9 reuses origin 5's `rho.json`, world and configs by hash — it must verify they are byte-identical to o5's and exit 5 otherwise).
  6. `node tools/prospective_materialize.cjs …` into `o<O>/decisions/`.
  7. Manifest: SHA-256 of every file under `o<O>/` plus `tools/prospective_eval.cjs`, `tools/prospective_materialize.cjs`, `tools/trade_backtest.cjs`, `tools/draft_sim.cjs`, `site/assets/rostersim.js`, `site/assets/ros.js`, `site/assets/optimizer.js`, `src/ffmodel/formats.py`, `site/assets/formats.js`, the model artifact files under the export roots, `requirements*.txt`/lockfiles, `node --version`, `python --version`, `git rev-parse HEAD`, the cutoff, `now`, and the spec path + its SHA-256. Print `MANIFEST_SHA256=<hex>` to stdout.
- Workflow `prospective-freeze.yml`: `workflow_dispatch` with inputs `origin` (default 5) and `dry_run` (default false); checkout, Python + Node setup like `weekly-update.yml`, run the freeze, `git add models/prospective/2026/o<O>` (or `dryrun-o4`), commit `data: prospective freeze 2026 origin <O> (manifest <sha>)`, push to main, and for non-dry runs push tag `prospective-2026-o<O>`; upload the directory as an artifact with `retention-days: 90`. Concurrency group `prospective-freeze` so two runs can't race; never force-push; if the target directory already exists in the repo → fail (never overwrite).

- [ ] **Step 1: Failing tests** `tests/test_freeze.py` with an injected clock and stub schedule: exit 3 at/after cutoff and nothing written; exit 2 when week O absent; exit 4 when a week < O game has no stats; exit 5 when origin-9 inputs differ from origin 5's; the manifest lists every file with correct hashes and is deterministic apart from `now`; an existing target dir → refusal.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `freeze.py` and the workflow. **Step 4:** tests + full suite green.
- [ ] **Step 5: Commit** `feat: prospective freeze — cutoff guard, manifest, Actions workflow`.
- [ ] **Step 6: Dry run (controller).** Push the branch state needed to main only after the whole-branch review (see Task 8); before that, dry-run locally: `python -m ffmodel.prospective.freeze --season 2026 --origin 4 --dry-run` against week-3 data. Then after merge, dispatch the workflow with `dry_run=true` and confirm the run log prints `MANIFEST_SHA256`, the commit lands under `dryrun-o4/`, and no tag is pushed. Deadline 2026-10-04.

### Task 8: Review, merge, origin-5 freeze (controller + owner)

- [ ] **Step 1:** Whole-branch review (opus) against the spec, with focus on the Review Focus list and on numerics in Tasks 2, 3, 6. Fix wave. astra review of the branch (`codex exec … < /dev/null`), fix wave.
- [ ] **Step 2:** Merge to main, push, run the workflow dry run (Task 7 Step 6).
- [ ] **Step 3:** After week-4 stats land (~2026-10-06), dispatch `prospective-freeze.yml` with `origin=5`. Verify: run log `MANIFEST_SHA256`, commit under `models/prospective/2026/o5/`, tag `prospective-2026-o5`, artifact uploaded, all before the cutoff. Record the run URL and digest in `docs/remaining-season-projections.md` under a new "Prospective 2026 test (v2)" heading with the declared rules summary. If it misses: publish that fact; origin 9 becomes exploratory-only (spec §7.5).
- [ ] **Step 4:** Origin 9 (~2026-11-03): dispatch with `origin=9`.

Out of this plan (later work, spec §7.6 / §8 / §9.6): the season-end outcome artifact (stats as of 2027-01-12) and evaluation run; `sim_gates.json` consumers and the experimental display on the trade/waiver pages; projects B and C.
