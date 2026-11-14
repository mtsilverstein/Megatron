# Draft Picks in the In-Season Trade Comparison — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add next-season draft picks to either side of an in-season trade in keeper leagues and see this season's lineup change, next season's pick value, and a combined number under a chosen weighting preset.

**Architecture:** A committed historical artifact (`site/assets/pick_curve.json`, built by a Python generator from the draft worlds' market order and nflverse weekly stat lines) feeds a pure, node-testable JS module (`site/assets/pickvalue.js`) that owns pick ownership, slot estimation, the value curve in the league's own scoring, and the weighted combination. `seasontrademode.js` fetches Sleeper's traded picks and draft settings, renders pick rows and controls, and adds the next-season and combined lines to its existing result. The lineup engine (`seasontrade.js`) is unchanged.

**Tech Stack:** Python 3 + pandas + pytest; plain JS (UMD wrapper, house style) + node fixtures (`tests/*_fixture.cjs`).

**Spec:** `docs/superpowers/specs/2026-11-13-trade-draft-picks-design.md` (approved 2026-11-13). Read it before your task.

**Deadline:** the leagues' week-11 trade deadline; target all tasks merged within 4 days. Task 4 is droppable if time runs out.

## Global Constraints

- Work only in your task's worktree; never push; never switch branches in the main checkout. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (Codex tasks: the same line).
- Python tests in a worktree: `PYTHONPATH="$PWD/src" python -m pytest -W error -q` (the editable install otherwise tests the main checkout). JS: `node tests/<name>_fixture.cjs`; before reporting run every fixture with `export PYTHONPATH="$PWD/src" PYTHON=python; for f in tests/*_fixture.cjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`.
- Privacy: no real Sleeper league ids, team names, usernames in code, fixtures, copy or commits. No ECR values, player names or player ids in the published artifact. No Sleeper projection values anywhere.
- Do not touch: `models/prospective/**`, `.github/workflows/prospective-*.yml`, `tools/select_outcome_tag.py`, `src/ffmodel/prospective/**`, `data_snapshots/**`, `site/data/**` (bot-written).
- Points always come from stat lines scored with the league's weights (`LeagueLens.effectiveWeights` / `LeagueLens.score`).
- Picks are offered only when `league.settings.type === 1` (keeper), the league is `in_season`, it has no `SUPER_FLEX` slot and at most one `QB` slot.
- Weighting presets (exact): `win_now` "Win now" w=0.5; `balanced` "Balanced" w=0.8 (default); `rebuild` "Rebuild" w=1.2. A pick `n` seasons ahead is weighted `w^n`.
- Combined = this season's lineup change + Σ(± pick value × w^n). Picks change nothing this season and take no roster spot.
- Copy must avoid every word in `seasontrademode.js` `FORBIDDEN` ("verdict", "win/win", "fair", "winner", "accept", "recommend", "grade"). Plain sentence case; assumptions stated in words.
- Keeper ladder rule (Gabagool, owner-confirmed 2026-11-13): cost = round last drafted − years kept; undrafted waiver pickup costs round 12 the first year kept, one round earlier per year after; not keepable if cost would be round 2 or earlier; kept at most 2 years.

## Review Focus

1. A pick traded more than once — the page must show it under its current owner only (Sleeper `traded_picks` row: `roster_id` = original owner, `owner_id` = current owner). Test in Task 2.
2. A league scoring pick-sixes (`pass_int_td`) — the artifact has no pick-six stat; the curve must estimate `passing_pick_sixes = passing_interceptions × rate` with the batch's published prior rate, not throw. Test in Task 2.
3. A picks-only trade (no players ticked) — Compare must work, this season = 0, no engine call. Test in Task 3.
4. `traded_picks` or draft fetch fails or times out — the page works exactly as today without picks and says why picks are unavailable. Test in Task 3.
5. A large league (14 teams, 16 rounds, 2 keepers) — ranks beyond the artifact's deepest market rank are valued 0, never `NaN`/undefined. Test in Task 2.

---

### Task 1: Pick-curve artifact (Python generator + committed JSON)

Executor: Codex (`codex exec -m gpt-6-astra`), in worktree `.worktrees/pick-curve` (branch `feat/pick-curve` from `feat/trade-picks`). Runs in parallel with Task 2.

**Files:**
- Create: `src/ffmodel/site/pick_curve.py`
- Create: `tests/test_pick_curve.py`
- Create (generated, committed): `site/assets/pick_curve.json`

**Interfaces:**
- Produces the artifact schema Task 2 reads (exact):
```json
{
  "kind": "pick_curve",
  "schema_version": 1,
  "generated_at": "<ISO-8601 UTC>",
  "weeks": [1, 17],
  "stat_order": ["passing_yards", "passing_tds", "passing_interceptions", "carries", "rushing_yards",
                 "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds", "fumbles_lost"],
  "market_source": "preseason consensus rank (draft worlds)",
  "seasons": [
    {"season": 2021, "players": [[rank_or_null, "RB", 0, 0, 0, 250, 1100, 9, 60, 48, 400, 2, 1], ...]}
  ]
}
```
  Each player row is `[rank, position, ...stat totals in stat_order]`. `rank` = 1-based preseason market rank (order of the world's `ecr` ascending among players with an `ecr`, ties by `player_id`), or `null` for a player without an `ecr`. Rows are sorted ranked-first by rank, then unranked by position and stats (any stable order without ids). Stat totals are sums over regular-season weeks 1–17, rounded to integers. Positions QB/RB/WR/TE only. Include every skill player with at least one nonzero stat in weeks 1–17, plus every ranked player (a ranked player with no rows gets all zeros — a bust is a real outcome). Seasons 2021–2025.
- `build_pick_curve(worlds: dict[int, dict], weekly: pd.DataFrame, *, generated_at: str) -> dict` — `worlds` maps season → parsed world JSON (only `players[].player_id/position/ecr` are read); `weekly` is the normalized weekly frame (`player_id, position, season, week` + the 11 stats).
- CLI: `python -m ffmodel.site.pick_curve --worlds-dir DIR --weekly PARQUET --out site/assets/pick_curve.json [--seasons 2021 2022 2023 2024 2025]`.

- [ ] **Step 1: Write the failing tests** in `tests/test_pick_curve.py` with tiny synthetic worlds/weekly frames:
  - `test_rank_order_and_schema`: three ranked players (ecr 3.1, 1.2, 2.0) → ranks 1,2,3 in ecr order; header fields exactly as the schema; `stat_order` equals the list above.
  - `test_totals_sum_weeks_1_to_17_only`: rows in week 17 count, week 18 rows do not.
  - `test_ranked_player_without_rows_is_zeros` and `test_unranked_scorer_included_with_null_rank`.
  - `test_no_ids_names_or_ecr_in_output`: `json.dumps(out)` contains none of the synthetic player ids, names, or ecr values.
  - `test_non_skill_positions_dropped` (a K row is ignored).
  - `test_cli_writes_file` (tmp_path worlds dir + a parquet written from a frame).
- [ ] **Step 2: Run** `PYTHONPATH="$PWD/src" python -m pytest -W error -q tests/test_pick_curve.py` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `build_pick_curve` and the CLI in `src/ffmodel/site/pick_curve.py`. The stat list comes from `ffmodel.scoring.PREDICTED_STATS` (must equal `stat_order` above).
- [ ] **Step 4: Run** the test file — expect PASS; then the full pytest suite.
- [ ] **Step 5: Generate the real artifact** (read-only inputs in the main checkout; gitignored there):
  `PYTHONPATH="$PWD/src" python -m ffmodel.site.pick_curve --worlds-dir C:/Users/reisu/projects/Megatron/models/backtests/worlds_tf --weekly C:/Users/reisu/projects/Megatron/data/weekly_v2_2012_2025.parquet --out site/assets/pick_curve.json`
  Check: 5 seasons; each season has ≥ 300 ranked rows; file < 400 KB; no ids/names.
- [ ] **Step 6: Commit** `feat(data): pick-curve artifact for draft-pick values` (module, test, JSON).

### Task 2: `pickvalue.js` — pure pick ownership, slots, value curve and weighting

Executor: Claude subagent, `opus`. Worktree `.worktrees/picks` (branch `feat/trade-picks`). Runs in parallel with Task 1 against the schema above (fixture uses a synthetic artifact).

**Files:**
- Create: `site/assets/pickvalue.js` (UMD like `leaguelens.js`; node `require` of `./leaguelens.js`)
- Create: `tests/pickvalue_fixture.cjs`

**Interfaces (exact names; Task 3 calls these):**
- `PRESETS` — frozen `{win_now:{label:"Win now",w:0.5}, balanced:{label:"Balanced",w:0.8}, rebuild:{label:"Rebuild",w:1.2}}`; `DEFAULT_PRESET = "balanced"`.
- `eligibility(league) -> {ok: boolean, reason: string|null}` — reasons (exact copy): dynasty `"Rookie-draft picks in dynasty leagues aren't valued: the pick values come from full drafts."`; superflex/2-QB `"Draft picks aren't valued in leagues that start two quarterbacks: the pick values come from one-quarterback drafts."`; redraft or not in season → `{ok:false, reason:null}` (silent).
- `draftRounds({draft, tradedPicks}) -> number|null` — `draft.settings.rounds`, else max `round` in `tradedPicks`, else null.
- `pickSeasons({league, tradedPicks}) -> number[]` — `league.season + 1` plus any later season present in `tradedPicks`, ascending, as numbers.
- `ownedPicks({rosters, tradedPicks, seasons, rounds}) -> Map<rosterId:number, Array<{season, round, originalRosterId}>>` — every roster owns its own (season, round) unless a `tradedPicks` row with that `season` (string in Sleeper → compare as numbers), `round`, `roster_id` (original) names another `owner_id`. Sorted by season, round, original roster.
- `standingsOrder(rosters) -> number[]` — roster ids, worst first: fewer wins, then fewer points for (`settings.fpts + settings.fpts_decimal/100`), then roster id ascending.
- `roundSlots({round, teams, snake, reversalRound}) -> {first, last}` — overall slot numbers (1-based) of a round: `first = (round-1)*teams + 1`, `last = round*teams`.
- `slotInRound({originalRosterId, round, order, teams, snake, reversalRound}) -> number` — overall slot under a full draft order (array of roster ids, first pick first); snake reverses even rounds; when `reversalRound > 0`, rounds `>= reversalRound` flip their parity once more (Sleeper's "third-round reversal").
- `buildCurve({artifact, weights, slots, teams, keepers, rounds, pickSixRate, keeperRule}) -> {valueAtSlot(slot:number) -> number}`:
  1. For each artifact season, score every row with `LeagueLens.score({p50: stats, p10: null, p90: null}, position, weights).p50`, where `stats` maps `stat_order` → totals and `passing_pick_sixes = passing_interceptions × pickSixRate`.
  2. Replacement per position = points of the Nth-best scorer at that position among ALL rows that season, N from the league's starting slots × `teams` with the flex split taken by market rank (port of `flex_replacement_ranks` in `src/ffmodel/site/board_rank.py`, generalized: FLEX → RB/WR/TE, WRRB_FLEX → RB/WR, REC_FLEX → WR/TE; dedicated QB/RB/WR/TE; non-modeled slots ignored).
  3. Value of a ranked row = `max(0, points − replacement[position])`; average by rank across seasons → `v(rank)`; smooth (builder's choice, e.g. centered moving average of width `teams`) then force non-increasing (pool-adjacent-violators).
  4. Market rank of a live slot: `keepers*teams + live + 1`, `live` = live picks before it. `keeperRule === "unknown"`: `live = slot − 1`. `keeperRule === "ladder"`: picks in rounds 1–2 are all live; the `keepers*teams` keeper picks are spread evenly over rounds 3–12, so `live = slot − 1 − (expected keeper picks before slot)`.
  5. Ranks beyond the artifact's deepest ranked row → value 0.
- `pickValue({pick, curve, order, rosters, teams, rounds, snake, reversalRound}) -> {value, low, high, slot|null}` — `order === "unset"`: `value` = mean of `valueAtSlot` over the round's slots, `slot` null; `order === "standings"`: `slot` from `standingsOrder` + `slotInRound`, `value = valueAtSlot(slot)`. `low/high` = values at the round's last/first slot (always the whole round).
- `combine({thisSeason, give, receive, preset, currentSeason}) -> {future, combined, w}` — `give/receive`: arrays of `{season, value}`; `w = PRESETS[preset].w`; `future = Σreceive.value − Σgive.value` (unweighted expected points); `combined = thisSeason + Σreceive(value × w^n) − Σgive(value × w^n)` with `n = season − currentSeason` (a next-season pick has `n = 1`).

- [ ] **Step 1: Write the failing fixture** `tests/pickvalue_fixture.cjs` (synthetic artifact with 2 seasons, ~40 rows; synthetic Sleeper payloads):
  - presets exact; `eligibility` for type 0/1/2, SUPER_FLEX, two QB slots, not in season.
  - `ownedPicks`: untouched pick stays with original; traded pick moves; pick traded twice ends at the final `owner_id` (Review Focus 1); `season` given as a string.
  - `standingsOrder` tie-break by points then id; `slotInRound` for snake rounds 1–3 and a `reversalRound` of 3.
  - `buildCurve`: non-increasing; two leagues with different weights (PPR vs standard) give different values; a league weighting `pass_int_td` works and uses `pickSixRate` (Review Focus 2); ladder rule maps R1/R2 like unknown and later rounds to earlier market ranks than unknown; slot beyond the artifact → 0 for a 14-team, 16-round, 2-keeper league (Review Focus 5).
  - `pickValue` unset → mean over the round, `low <= value <= high`; standings → exact slot value.
  - `combine` for each preset, a 2-seasons-ahead pick weighted `w^2`, picks only (`thisSeason = 0`).
- [ ] **Step 2: Run** `node tests/pickvalue_fixture.cjs` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `site/assets/pickvalue.js` to the interfaces above.
- [ ] **Step 4: Run** the fixture — expect PASS; then every fixture.
- [ ] **Step 5: Commit** `feat(site): pure pick-value module for the in-season trade comparison`.

### Task 3: Trade page integration

Executor: Claude subagent, `opus`. Worktree `.worktrees/picks`, after Tasks 1 and 2 are merged into `feat/trade-picks`.

**Files:**
- Modify: `site/assets/seasontrademode.js`, `site/trade.html` (load `pickvalue.js` after `leaguelens.js`; bump `?v=` keys of every changed asset), `site/assets/style.css` (scoped to `#season-trade`, works at 390 px with the existing phone rules)
- Test: `tests/seasontrademode_fixture.cjs` (extend; it already builds a synthetic page)

**Interfaces:**
- Consumes: `PickValue.*` (Task 2), `site/assets/pick_curve.json` (Task 1; fetch once per page load with a `?v=` key), `window.Sleeper.get(path, opts)` for `/league/<id>/traded_picks` and `/draft/<league.draft_id>`, the batch's `weekly.method.prior.rate` as `pickSixRate`, the view's `board.players[].ros_value` for likely keepers.
- Produces: rendered picks UI + result lines (no exported API changes beyond what fixtures need).

Behaviour and exact copy:
- Fetch picks data only when `PickValue.eligibility(league).ok`. On any fetch/parse failure or `draftRounds` null: no pick rows; one line `Draft picks unavailable: ${reason}` (Review Focus 4); everything else unchanged.
- Each column gets a collapsed `<details>` "Draft picks (N)" under the players, one checkbox per owned pick, labelled `2027 R1` (own) or `2027 R1 (from ${teamName})`. Pick checkboxes join the trade like players but never trigger roster-limit drops.
- Controls above the result (shown only when picks are offered), remembered in `localStorage` per league id (wrapped in try/catch):
  - Weighting: buttons `Win now`, `Balanced`, `Rebuild` (aria-pressed), helper `How much a point next season counts: Win now ×0.5, Balanced ×0.8, Rebuild ×1.2.`
  - `${next} draft order:` select `Not set yet` (value `unset`, default) / `By this season's standings` (value `standings`).
  - `Keeper rule:` select `Unknown` (value `unknown`, default) / `Round drafted − 1 per year kept (waiver pickups: round 12; max 2 years)` (value `ladder`).
  Changing any control recomputes the result without new Sleeper fetches.
- Compare with picks: run the engine only if any player is ticked (Review Focus 3: picks only → this season 0, no engine call, no roster-limit prompt). Per side, append to the summary:
  - `Next season: ${signed(future)} expected points from picks.` (say `Future seasons:` instead when any pick is two or more seasons ahead) then one line per pick moving to or from that side: `${label}: worth about ${v} (anywhere from pick ${first} to ${last}: ${low}–${high})` — under `standings` order use `pick ${slot} by current standings (round range ${first}–${last}: ${low}–${high})`.
  - `Combined at ${presetLabel} (next season ×${w}): ${signed(combined)}`
  - once per result: `Pick values: what players drafted at each spot actually scored in 2021–2025, above a waiver-level starter, in your league's scoring. A player's value next season, as a keeper, is not counted.`
  - for each traded player who is in his current team's top `league.settings.max_keepers` skill players by `ros_value`: `${player} is likely one of ${team}'s keepers; his value next season is not counted.`
- When the offer contains a pick: the subline tail reads `Keeper value is not counted; draft picks are valued for next season only.` instead of `SUBLINE_TAIL` (add it to `ALLOWED_SENTENCES`), and the engine warning beginning `No keeper or future-pick value` is shown as `Draft picks are valued for next season below; keeper value, bench insurance and the other side's willingness to deal are not counted.` Without picks, both stay exactly as today.

- [ ] **Step 1: Extend the fixture (failing first):** pick rows render under the right owner (incl. a traded pick); presets/order/keeper-rule controls recompute with zero extra fetch calls; picks-only compare shows this season 0 and no engine call; a player+pick trade shows this-season numbers identical to the same trade without the pick plus the next-season and combined lines; fetch failure shows the unavailable line and the page compares players normally; dynasty and superflex show their reason lines; the likely-keeper line; every rendered string passes the `FORBIDDEN` check; no-pick trades render exactly as before (regression pin).
- [ ] **Step 2: Run** `node tests/seasontrademode_fixture.cjs` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** every fixture and pytest — expect PASS.
- [ ] **Step 5: Commit** `feat(site): draft picks in the in-season trade comparison`.

### Task 4 (droppable): keeper ladder two-year cap + keeper-pick conflict warning

Executor: Claude subagent, `opus`. Worktree `.worktrees/picks`, after Task 3.

**Files:**
- Modify: `site/assets/keepers.js` (`eligible`), `site/assets/seasontrademode.js`
- Test: `tests/keepers_fixture.cjs`, `tests/seasontrademode_fixture.cjs`

**Interfaces:**
- Consumes: `Keepers.keeperCost(c, season)`, `Keepers.eligible(c, season)`, `Keepers.buildOriginalByPlayerId(...)` (already exported; read their signatures in `keepers.js`).
- Produces: `eligible` also requires years kept ≤ 2: drafted `season − originalYear <= 2`; waiver `season − firstKeptYear + 1 <= 2` (blank `firstKeptYear` = this season).

- [ ] **Step 1: Failing tests:** keepers fixture — a player drafted 2026 R8 is eligible for 2027 (cost 7) and 2028 (cost 6) but not 2029; a waiver pickup first kept 2027 is eligible 2027 and 2028, not 2029; the round-2 floor still applies. Trade fixture — under `ladder` rule with a synthetic draft history, offering the pick a likely keeper would cost shows `${team}'s likely keeper ${player} would cost their ${label} — the pick in this offer.`; under `unknown` no such line; a history fetch failure drops only this line.
- [ ] **Step 2: Run** both fixtures — expect FAIL.
- [ ] **Step 3: Implement** (history walk only under the `ladder` rule, once per league load).
- [ ] **Step 4: Run** every fixture and pytest — expect PASS.
- [ ] **Step 5: Commit** `feat(site): keeper ladder two-year cap; warn when a traded pick is a keeper's cost`.

### After the tasks
Final whole-branch review (`opus`), controller browser pass at 390 px on a real keeper league, owner push approval.
