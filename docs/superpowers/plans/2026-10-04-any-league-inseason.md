# Any Sleeper League — Phase 1 (In-Season Pages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2** (2026-10-04): resolves astra's plan review (`.review/astra-anyleague-plan-response.md`: B1–B3, I1–I11); trace at the end.

**Goal:** Any Sleeper league gets working start/sit, waivers and in-season trade comparison, scored in the browser by its own live settings from one league-neutral data batch, with Gabagool and FAM on the same path.

**Architecture:** One Actions process (`ffmodel.site.batch`) pulls inputs once, fits once, and writes the legacy per-league files *and* a league-neutral batch (`site/data/neutral/{weekly,remaining,players,evaluation,formats}.json`) into an empty stage; `ffmodel.site.publish` validates the stage and copies it into `site/data`; the git commit is the all-or-nothing boundary. In the browser, `leaguelens.js` turns a live league's `scoring_settings` into per-position stat weights, `leaguedata.js` turns the neutral batch into league-scored *views* in the shapes the existing analyzers already read, `liveworld.js` resolves the live league/roster for all three pages, and `lineup.js` (exact, BigInt) replaces both lineup solvers. Analyzers lose their league-contract checks and keep every caller policy. `rostersim.js` and `ROS.bestLineup` are untouched (frozen method).

**Tech Stack:** Python 3.12 (pandas, pytest) under `src/ffmodel/`; vanilla JS UMD modules under `site/assets/` tested by `node tests/*_fixture.cjs`; GitHub Actions `weekly-update.yml`.

**Spec:** `docs/superpowers/specs/2026-10-01-any-league-inseason-design.md` (draft 4; astra READY FOR PLAN; owner-approved 2026-10-04). Executors read the spec sections each task cites. Astra plan-level items P1–P4 (`.review/astra-anyleague-spec-recheck2-response.md` §4) are folded into Tasks 2, 5, 7 and 15.

## Global Constraints

- Branch `feat/any-league-inseason`. **Never merge to `main` before the `prospective-2026-o5` tag exists** (spec §10). Never push without the owner's OK.
- Do not modify: `.github/workflows/prospective-*.yml`, `tools/select_outcome_tag.py`, `tools/prospective_*.cjs`, `src/ffmodel/prospective/**`, `site/assets/rostersim.js`, `site/assets/ros.js` (spec §2).
- Do not change the frozen format fingerprint: `site/assets/formats.js` / `src/ffmodel/formats.py` canonicalization, `describeSleeper`, `match` (spec §6.1, §3.2).
- Phase-1 pages make **no simulation calls** and publish **no gate file** (spec §6.2, §7.1).
- Caller policies (start/sit, weekly waivers, ROS waivers, trade) are preserved exactly as spec §7.1 lists, including today's *refusal shapes* (a throw stays a throw, a blocked result stays a blocked result); any deviation must be one of spec §8's 13 items.
- Age limits per caller, exactly as today: start/sit weekly + kickoffs ≤ 7 days; waivers weekly, kickoffs, remaining ≤ 72 h; trade remaining ≤ 72 h; existing future-timestamp and roster-snapshot checks stay (spec §5.3).
- Comparisons use **exact raw** scores; rounding only at display; waiver admission = raw weekly gain ≥ 0.005 (spec §3.3). No score ceiling: any finite projection and any finite league weight is accepted.
- Horizon: NFL weeks `start_week`..17, labeled `through NFL week 17, regardless of your league's schedule`; empty `remaining.json` with `status: "no_remaining_weeks"` when `start_week > 17` (spec §3.3).
- League types: `settings.type` 0/1/2 supported; anything else → `This league type isn't supported yet.` (spec §11). Best ball (`settings.best_ball = 1`) → projections and rest-of-season values only (spec §7.2).
- No other managers' data in the repo: league fixtures and rosters are synthetic (fictional owners/ids) in Sleeper's response shape; real NFL player identities are fine (spec §9.11).
- Python tests: `.venv/Scripts/python.exe -m pytest` (Windows) / `python -m pytest` (CI). JS tests: `node tests/<name>_fixture.cjs`. In a git worktree set `PYTHONPATH=<worktree>/src` (editable-install trap).
- Test placement: pure scoring/policy cases in engine fixtures (`startsit_fixture`, `waivers_fixture`, `seasontrade_fixture`); identity/hydration/view cases in `leaguedata_fixture` / `liveworld_fixture`; inputs, wording, lifecycle and DOM cases in the `*mode*` fixtures.
- Exact copy strings (verbatim):
  - banner: `Your league also scores {categories}, which these projections leave out; rankings may be off for your league.`
  - pick-six footnote: `Pick-sixes use an average rate, not a forecast.`
  - rare-event footnote: `Not projected: {categories} (rare events).`
  - evidence fallback: `No measured evaluation for your league's scoring and this model.`
  - format line: `Format: {description} — in the 2026 format test (results January 2027)` / `Format: not in the format test` / `Best ball — not eligible for the format test`
  - unsupported type: `This league type isn't supported yet.`
  - simulation note: `Simulation is off: the 2025-season test failed (on synthetic 15-player rosters), and the per-format 2026 test reports in January 2027.`
  - best-ball note: `Best-ball scoring picks your top scorers after the games; lineup advice doesn't apply.`
  - horizon label: `through NFL week 17, regardless of your league's schedule`
  - aggregation label: `sum of weekly medians through NFL week 17, not a season median`
  - end state: `No projected weeks remain.`
  - heuristic label: `{n}-point threshold in your league's points (a heuristic)`
  - ECR label: `PPR reference ranking`
  - anonymous viewing: `Viewing {team name}`; settings stamp: `League settings read {time}`

## Review Focus

Spec-implied inputs no task's main tests exercise, most likely first. Each has its test in the owning task.

1. **A rostered player traded to another NFL team after the batch was generated** (live catalog team ≠ projection team): start/sit refuses naming him (`missing current-team weekly projection`), weekly waivers fail with today's `owned player projection team does not match current team; refresh projections`, trade refuses (`Missing projection or current-team mismatch`); he is never scored for the old team. → Tasks 11, 12, 13.
2. **A pasted league id that does not exist, or last season's league id**: `Sleeper has no league with id {id}.` / `This league is from the {season} season; projections are for {current}.` → Task 9.
3. **Unusual team counts (2, 4, 20, 32)**: nothing assumes 10/12 teams. → Task 12.
4. **Strange weights plus omitted bonuses** (`pass_yd 0.05, rec 0.25, bonus_fd_wr 0.5`): exact where possible, banner the rest, never refuse. → Task 3.
5. **Anonymous viewer picks a team, then identifies as the owner of a different team**: the page switches to the owner's roster and says so; the viewed choice is dropped, not merged. → Tasks 9, 11.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `tools/build_inseason_snapshot.py`, `tools/capture_inseason_baseline.cjs`, `tests/fixtures/inseason_baseline/` | One full-precision manager-free snapshot; legacy-shaped inputs; old analyzer outputs | 1 |
| `site/assets/leaguelens.js`, `src/ffmodel/site/leaguelens.py` | Classification, effective weights, evidence identity, validated scoring (JS + Python twin) | 2, 3 |
| `site/assets/lineup.js` | Exact lexicographic lineup kernel (BigInt) | 4 |
| `src/ffmodel/site/neutral.py`, `remaining.py`, `weekly.py`, `sleeper.py` (modify) | Neutral builders, batch context, identity universe | 5 |
| `src/ffmodel/site/evidence_records.py`, `src/ffmodel/site/method.py` | Evidence records; current-output method descriptor | 6 |
| `src/ffmodel/site/batch.py`, `src/ffmodel/site/publish.py`, `.github/workflows/weekly-update.yml` (modify) | Single-process batch generation; validate + copy; commit boundary | 7 |
| `site/assets/leaguedata.js` | Batch loading, views, live identity revalidation, format line, league types, evidence lookup | 8 |
| `site/assets/session.js`, `app.js`, `connect.js` (modify) | League-id flow, analysis roster, settings refetch + stamp, navigation boundary | 9 |
| `site/assets/liveworld.js` (new), `waivermode.js` (`loadWorld` → wrapper) | Shared live-world resolver for all three pages | 10 |
| `startsit.js`, `startsitmode.js`, `site/weekly.html` | Start/sit migration | 11 |
| `waivers.js`, `waivermode.js`, `waiverintel.js`, `site/waivers.html` | Waivers migration | 12 |
| `seasontrade.js`, `seasontrademode.js`, `site/trade.html` | Trade migration | 13 |
| `site/about.html`, `docs/remaining-season-projections.md` | Scoped historical evidence; docs | 14 |
| — | End-to-end verification | 15 |

Tasks run **sequentially**. Models: Tasks 2, 3, 4 → `sonnet` (complete code given); 1, 5, 14 → `sonnet`; 6, 7, 8, 9, 10, 11, 12, 13 → `opus`; 15 → controller.

---

### Task 1: Full-precision snapshot and today's analyzer outputs

Spec §9.4. Runs on **unchanged** analyzers before any other task. Astra B3, I1.

**Files:**
- Create: `tools/build_inseason_snapshot.py`, `tools/capture_inseason_baseline.cjs`
- Create: `tests/fixtures/inseason_baseline/{snapshot,legacy_gabagool,legacy_fam,scenarios,outputs_gabagool,outputs_fam}.json`
- Create: `tests/inseason_baseline_fixture.cjs`

**Interfaces:**
- `snapshot.json` = `{season, week, start_week, end_week, generated_at, data_through, kickoffs, stat_order, players:[{player_id, sleeper_id, name, team, position, bye, ecr, weekly:{p10:{stat:x},p50:{…},p90:{…}}, future:{"<week>": {status, opponent?, reason?, p10?, p50?, p90?}}}]}` — **full precision**, the single source both the legacy and (in Task 15) neutral representations are built from.
- `legacy_<slug>.json` = `{board, weekly, remaining, kickoffs, league, rosters, catalog, transactions}` in today's shapes, built from the snapshot.
- `scenarios.json` = every analyzer call's exact arguments (incl. the trade's give/receive/drops/excludeWeeks, `now`, `snapshotAt`, `budgetReserve`, `protectedIds`).
- `outputs_<slug>.json` = `{startsit, waivers, trade}` — successful results (Step 4); `Infinity` serialised as `"Infinity"`.

- [ ] **Step 1: Snapshot builder** `tools/build_inseason_snapshot.py`:
  - Universe: every player in `site/data/weekly.json` with a `sleeper_id` in `site/data/draft.json` (join on `player_id`), with board `bye`, `ecr`, `name`, `team`, `position`.
  - `weekly` blocks: that player's `stat_quantiles` (full precision, as published).
  - `future` weeks `week+1`..17: per-week `status`/`opponent`/`reason` from `site/data/remaining-gabagool.json` for the same `player_id`; each `conditional_projection` week reuses the player's weekly stat blocks (synthetic but full precision — both sides need identical inputs, not a forecast); `bye` → `{status:"bye"}`; else `{status:"unmodeled", reason}`.
  - Times: `generated_at` = earliest kickoff in `site/data/kickoffs.json` minus 2 h (UTC ISO); `data_through` from `weekly.json`.
- [ ] **Step 2: Legacy shapes** (same tool), for Gabagool (`weekly.json`'s `league`) and FAM (`weekly-fam.json`'s `league`):
  - `weekly.players[i].points.league` = `ffmodel.scoring.fantasy_points_quantiles` on the snapshot blocks with `ffmodel.league.load_league(slug).rules`, rounded to 2 decimals as `weekly.py` does; `weekly.league` = the league payload; other fields copied.
  - `remaining.players[i].weeks` built the same way per future week; top-level fields as today's `remaining-<slug>.json` with the snapshot's `generated_at`, `evaluation` copied.
  - `board` = draft-board shape restricted to the universe (`player_id, sleeper_id, name, position, team, bye, ecr, value_points, season_points`) from the real draft file.
  - `league` = `{league_id, season:"2026", status:"in_season", total_rosters, roster_positions:<tests/fixtures/owner_league_settings.json[slug].roster_positions>, scoring_settings:<same file>, settings:{type:0, waiver_type:<2 gabagool | 0 fam>, waiver_budget:100}}`.
  - `rosters`: deterministic, legal, coverage-complete. Sort the universe by `ecr`; deal round-robin snake by position quota per roster `QB 2, RB 4, WR 4, TE 2` + 1 best remaining RB/WR/TE (13 offensive), **skipping** players without a weekly block or with any `unmodeled` future week. Starters = the legal lineup by board `value_points` (`ROS.bestLineup`). Each roster also gets a synthetic `K` (`"k<i>"`) and `DEF` (`"d<i>"`) in its K/DEF slots, `reserve: []`, `taxi: []`, `owner_id: "owner<i>"`, `roster_id: i`, `settings:{waiver_budget_used:10, waiver_position:i}`. Roster 1 is "mine".
  - `catalog`: universe players `{full_name, position, team, injury_status:null, gsis_id:player_id}` plus the synthetic K/DEF.
  - `transactions: []`.
- [ ] **Step 3: Capture** `tools/capture_inseason_baseline.cjs` (node, current code): reproduce controller preparation (`WaiverMode.hydrateBoard(board, catalog)` before waivers); call `StartSit.analyze`, `Waivers.analyze`, `SeasonTrade.analyze` with the arguments it writes to `scenarios.json`. Trade: roster 1 gives its highest-`value_points` bench WR, receives roster 2's highest-`value_points` bench RB, no drops, `excludeWeeks: {}`, `assumeAvailable: true`, `currentWeek: week`. Clock: `now = Date.parse(generated_at) + 60_000`, `snapshotAt = now - 30_000`.
- [ ] **Step 4: Assert success, not errors.** The capture exits nonzero unless, for both leagues: start/sit returns a `lineup` with every modeled slot filled; waivers returns `rows` (not `blocked`) with ≥ 5 rows; trade returns finite before/after totals for every future week. On failure change the deterministic dealing rule — never wrap in try/catch.
- [ ] **Step 5: Reproducibility fixture** `tests/inseason_baseline_fixture.cjs`: re-runs Step 3 from committed `legacy_*`/`scenarios` and deep-equals `outputs_*`. Run → PASS.
- [ ] **Step 6: Commit** `test: full-precision manager-free snapshot and baseline of today's in-season analyzer outputs`. Tasks 11–13 remove their analyzer's section of the fixture (never the captured JSON).

---

### Task 2: League lens core — classification, effective weights, evidence identity

Spec §4, §3.2. Astra P1, I2, I3.

**Files:** Create `site/assets/leaguelens.js`, `src/ffmodel/site/leaguelens.py`, `tests/leaguelens_fixture.cjs`, `tests/test_leaguelens.py`

**Interfaces:**
- JS `window.LeagueLens` / Python `ffmodel.site.leaguelens`: `POSITIONS`, `STATS` (12, published order), `KEYS` (key → [stat, positions|null]), `APPROX`, `RARE` (key → max |w| for a footnote), `RECURRING`; `effectiveWeights(scoring)` / `effective_weights` → `{QB:{stat:w},RB,WR,TE}` (zeros omitted); `classify(scoring)` → `{weights, approx, rare, recurring, ignored, unknown, refused}`; `plain(x)` → exact exponent-free decimal of any finite double; `evidenceIdentity(weights)` / `evidence_identity` → canonical string.

- [ ] **Step 1: Failing JS test** `tests/leaguelens_fixture.cjs`:
```js
const assert = require("assert");
const L = require("../site/assets/leaguelens.js");
const owner = require("./fixtures/owner_league_settings.json");
const gab = owner.gabagool.scoring_settings;
assert.strictEqual(L.plain(0.04), "0.04");
assert.strictEqual(L.plain(0.0400001), "0.0400001");
assert.strictEqual(L.plain(6), "6");
assert.strictEqual(L.plain(-0), "0");
assert.strictEqual(L.plain(1e-7), "0.0000001");
assert.strictEqual(L.plain(-2.5), "-2.5");
assert.strictEqual(L.plain(1e21), "1000000000000000000000");
assert.strictEqual(L.plain(5e-324).length, 326);
assert.throws(() => L.plain(NaN)); assert.throws(() => L.plain(Infinity)); assert.throws(() => L.plain("1"));
const w = L.effectiveWeights({ rec: -1, bonus_rec_te: 2, pass_yd: 0.04 });
assert.deepStrictEqual(w.TE, { receptions: 1, passing_yards: 0.04 });
assert.deepStrictEqual(w.WR, { receptions: -1, passing_yards: 0.04 });
assert.deepStrictEqual(w.QB, { receptions: -1, passing_yards: 0.04 });
const z = L.effectiveWeights({ rec: 1, bonus_rec_wr: -1 });
assert.ok(!("receptions" in z.WR) && z.RB.receptions === 1, "cancelled weight omitted");
assert.notStrictEqual(L.evidenceIdentity(L.effectiveWeights({ pass_yd: 0.04 })), L.evidenceIdentity(L.effectiveWeights({ pass_yd: 0.0400001 })));
assert.doesNotThrow(() => L.evidenceIdentity(L.effectiveWeights({ pass_yd: 1e-12, rec: 2e7 })), "identity total over accepted weights");
const c = L.classify(gab);
assert.deepStrictEqual(c.recurring, []);
assert.deepStrictEqual(c.rare.slice().sort(), ["fum_rec_td", "pass_2pt", "pass_td_50p", "rec_2pt", "rec_td_50p", "rush_2pt", "rush_td_50p", "st_td"]);
assert.ok(c.approx.includes("pass_int_td") && c.refused === false);
assert.ok(L.classify({ pass_yd: 0.04, rec_2pt: 3 }).recurring.includes("rec_2pt"), "rare above bound banners");
assert.deepStrictEqual(L.classify({ rec: 1, bonus_fd_wr: 0.5, fum: -1, zzz_new: 1 }).recurring.slice().sort(), ["bonus_fd_wr", "fum", "zzz_new"]);
assert.ok(L.classify({ fgm_yds: 0.1, def_td: 6 }).refused);
assert.ok(L.classify({ bonus_rush_td_qb: 2, pass_yd: 0.04 }).recurring.includes("bonus_rush_td_qb"));
assert.throws(() => L.classify({ pass_yd: "x" })); assert.throws(() => L.classify({ pass_yd: NaN }));
console.log("leaguelens_fixture: ok");
```
- [ ] **Step 2: Run** → FAIL (`Cannot find module`).
- [ ] **Step 3: Implement `site/assets/leaguelens.js`:**
```js
/* League lens (spec §4, §3.2): classify a Sleeper league's scoring_settings and
   combine weights per (scoring position, stat). Tables are duplicated in
   src/ffmodel/site/leaguelens.py; tests/test_leaguelens.py asserts equality. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LeagueLens = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";
  const Formats = (typeof module !== "undefined" && module.exports) ? require("./formats.js") : root.Formats;
  const POSITIONS = Object.freeze(["QB", "RB", "WR", "TE"]);
  const STATS = Object.freeze(["passing_yards", "passing_tds", "passing_interceptions", "carries", "rushing_yards",
    "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds", "fumbles_lost", "passing_pick_sixes"]);
  const KEYS = Object.freeze({
    pass_yd: ["passing_yards", null], pass_td: ["passing_tds", null], pass_int: ["passing_interceptions", null],
    pass_int_td: ["passing_pick_sixes", null], rush_yd: ["rushing_yards", null], rush_td: ["rushing_tds", null],
    rush_att: ["carries", null], rec: ["receptions", null], rec_yd: ["receiving_yards", null],
    rec_td: ["receiving_tds", null], fum_lost: ["fumbles_lost", null],
    bonus_rec_te: ["receptions", ["TE"]], bonus_rec_rb: ["receptions", ["RB"]], bonus_rec_wr: ["receptions", ["WR"]],
  });
  const APPROX = Object.freeze(["pass_int_td"]);
  const RARE = Object.freeze({
    pass_2pt: 2, rush_2pt: 2, rec_2pt: 2,
    pass_td_40p: 3, pass_td_50p: 3, rush_td_40p: 3, rush_td_50p: 3, rec_td_40p: 3, rec_td_50p: 3,
    st_td: 6, fum_rec_td: 6,
  });
  const RECURRING = Object.freeze(["fum", "bonus_fd_qb", "bonus_fd_rb", "bonus_fd_te", "bonus_fd_wr", "pass_fd",
    "rush_fd", "rec_fd", "pass_cmp", "pass_inc", "pass_att", "pass_cmp_40p", "pass_sack", "rec_0_4", "rec_5_9",
    "rec_10_19", "rec_20_29", "rec_30_39", "rec_40p", "rush_40p", "bonus_pass_cmp_25", "bonus_pass_yd_300",
    "bonus_pass_yd_400", "bonus_rec_yd_100", "bonus_rec_yd_200", "bonus_rush_att_20", "bonus_rush_rec_yd_100",
    "bonus_rush_rec_yd_200", "bonus_rush_yd_100", "bonus_rush_yd_200", "kr_yd", "pr_yd", "bonus_rush_td_qb"]);
  const IGNORE_EXACT = new Set(Formats.AUDIT.ignore_exact);
  const IGNORE_RES = Formats.AUDIT.ignore_patterns.map(p => new RegExp("^(?:" + p + ")$"));
  const ignored = k => IGNORE_EXACT.has(k) || IGNORE_RES.some(re => re.test(k));
  const weightOf = (k, v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Invalid scoring weight: ${k}`);
    return v;
  };
  function effectiveWeights(scoring) {
    if (!scoring || typeof scoring !== "object" || Array.isArray(scoring)) throw new Error("Missing scoring settings.");
    const out = { QB: {}, RB: {}, WR: {}, TE: {} };
    for (const [k, raw] of Object.entries(scoring)) {
      if (!Object.hasOwn(KEYS, k)) continue;
      const v = weightOf(k, raw);
      if (v === 0) continue;
      const [stat, positions] = KEYS[k];
      for (const pos of positions || POSITIONS) out[pos][stat] = (out[pos][stat] || 0) + v;
    }
    for (const pos of POSITIONS) for (const s of Object.keys(out[pos])) {
      if (!Number.isFinite(out[pos][s])) throw new Error("Scoring overflow.");
      if (out[pos][s] === 0) delete out[pos][s];
    }
    return out;
  }
  function classify(scoring) {
    const weights = effectiveWeights(scoring);
    const res = { weights, approx: [], rare: [], recurring: [], ignored: [], unknown: [], refused: false };
    for (const [k, raw] of Object.entries(scoring)) {
      const v = weightOf(k, raw);
      if (v === 0) continue;
      if (Object.hasOwn(KEYS, k)) { if (APPROX.includes(k)) res.approx.push(k); continue; }
      if (Object.hasOwn(RARE, k)) { (Math.abs(v) <= RARE[k] ? res.rare : res.recurring).push(k); continue; }
      if (RECURRING.includes(k)) { res.recurring.push(k); continue; }
      if (ignored(k)) { res.ignored.push(k); continue; }
      res.unknown.push(k); res.recurring.push(k);
    }
    res.refused = POSITIONS.every(p => Object.keys(weights[p]).length === 0);
    return res;
  }
  // Exact exponent-free decimal of a finite double (shortest round-trip digits).
  function plain(x) {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error("weight must be a finite number");
    if (x === 0) return "0";
    const s = String(Math.abs(x));
    let m = s, e = 0;
    const k = s.indexOf("e");
    if (k >= 0) { m = s.slice(0, k); e = Number(s.slice(k + 1)); }
    const [ip, fp = ""] = m.split(".");
    let digits = ip + fp, point = ip.length + e;
    while (digits.length > 1 && digits[0] === "0") { digits = digits.slice(1); point--; }
    let out;
    if (point <= 0) out = "0." + "0".repeat(-point) + digits;
    else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
    else out = digits.slice(0, point) + "." + digits.slice(point);
    if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
    return (x < 0 ? "-" : "") + out;
  }
  function evidenceIdentity(weights) {
    const parts = POSITIONS.map(pos => {
      const ks = Object.keys(weights[pos] || {}).sort();
      return JSON.stringify(pos) + ":{" + ks.map(s => JSON.stringify(s) + ":" + JSON.stringify(plain(weights[pos][s]))).join(",") + "}";
    });
    return '{"v":1,"w":{' + parts.join(",") + "}}";
  }
  return Object.freeze({ POSITIONS, STATS, KEYS, APPROX, RARE, RECURRING, effectiveWeights, classify, plain, evidenceIdentity });
});
```
- [ ] **Step 4: Run** `node tests/leaguelens_fixture.cjs` → `leaguelens_fixture: ok`.
- [ ] **Step 5: Failing Python test** `tests/test_leaguelens.py`:
```python
import json, random, subprocess
from pathlib import Path
import pytest
from ffmodel.site import leaguelens as L

NODE_TABLES = ("const L=require('./site/assets/leaguelens.js');"
               "console.log(JSON.stringify({KEYS:L.KEYS,APPROX:L.APPROX,RARE:L.RARE,RECURRING:L.RECURRING,STATS:L.STATS}))")

def _node(script, *args):
    return json.loads(subprocess.run(["node", "-e", script, *args], capture_output=True, text=True, check=True).stdout)

def test_tables_identical_to_js():
    js = _node(NODE_TABLES)
    assert {k: [s, None if p is None else list(p)] for k, (s, p) in L.KEYS.items()} == js["KEYS"]
    assert list(L.APPROX) == js["APPROX"] and L.RARE == js["RARE"]
    assert list(L.RECURRING) == js["RECURRING"] and list(L.STATS) == js["STATS"]

def test_plain_matches_js_on_random_doubles():
    rng = random.Random(7)
    xs = [0.04, 0.0400001, 6.0, -2.5, 1e-7, 1e21, 5e-324, 1.7976931348623157e308]
    xs += [rng.uniform(-50, 50) for _ in range(300)] + [10 ** rng.uniform(-30, 30) for _ in range(300)]
    script = ("const L=require('./site/assets/leaguelens.js');"
              "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(L.plain)))")
    assert _node(script, json.dumps(xs)) == [L.plain(x) for x in xs]
    for bad in (float("nan"), float("inf"), "1", True):
        with pytest.raises(ValueError):
            L.plain(bad)

def test_identity_byte_equal_to_js():
    cases = [{"pass_yd": 0.04, "rec": -1, "bonus_rec_te": 2}, {"pass_yd": 0.0400001},
             {"rush_att": 0.1, "pass_int_td": -3}, {"rec": 1, "bonus_rec_wr": -1}, {"pass_yd": 1e-12, "rec": 2e7}]
    script = ("const L=require('./site/assets/leaguelens.js');"
              "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(c=>L.evidenceIdentity(L.effectiveWeights(c)))))")
    assert _node(script, json.dumps(cases)) == [L.evidence_identity(L.effective_weights(c)) for c in cases]

def test_classify_owner_league():
    gab = json.loads(Path("tests/fixtures/owner_league_settings.json").read_text())["gabagool"]["scoring_settings"]
    c = L.classify(gab)
    assert c["recurring"] == [] and "pass_int_td" in c["approx"] and not c["refused"]
```
- [ ] **Step 6: Run** → FAIL (module missing).
- [ ] **Step 7: Implement `src/ffmodel/site/leaguelens.py`** (`KEYS` positions are tuples or `None`; `RARE` values are ints so JSON equality with JS holds):
```python
"""Python twin of site/assets/leaguelens.js (spec §4, §3.2). Tables must stay identical."""
from __future__ import annotations

import json
import math
import re
from decimal import Decimal

from ffmodel.formats import AUDIT

POSITIONS = ("QB", "RB", "WR", "TE")
STATS = ("passing_yards", "passing_tds", "passing_interceptions", "carries", "rushing_yards",
         "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds", "fumbles_lost",
         "passing_pick_sixes")
KEYS = {
    "pass_yd": ("passing_yards", None), "pass_td": ("passing_tds", None),
    "pass_int": ("passing_interceptions", None), "pass_int_td": ("passing_pick_sixes", None),
    "rush_yd": ("rushing_yards", None), "rush_td": ("rushing_tds", None), "rush_att": ("carries", None),
    "rec": ("receptions", None), "rec_yd": ("receiving_yards", None), "rec_td": ("receiving_tds", None),
    "fum_lost": ("fumbles_lost", None),
    "bonus_rec_te": ("receptions", ("TE",)), "bonus_rec_rb": ("receptions", ("RB",)),
    "bonus_rec_wr": ("receptions", ("WR",)),
}
APPROX = ("pass_int_td",)
RARE = {"pass_2pt": 2, "rush_2pt": 2, "rec_2pt": 2, "pass_td_40p": 3, "pass_td_50p": 3,
        "rush_td_40p": 3, "rush_td_50p": 3, "rec_td_40p": 3, "rec_td_50p": 3, "st_td": 6, "fum_rec_td": 6}
RECURRING = ("fum", "bonus_fd_qb", "bonus_fd_rb", "bonus_fd_te", "bonus_fd_wr", "pass_fd", "rush_fd", "rec_fd",
             "pass_cmp", "pass_inc", "pass_att", "pass_cmp_40p", "pass_sack", "rec_0_4", "rec_5_9", "rec_10_19",
             "rec_20_29", "rec_30_39", "rec_40p", "rush_40p", "bonus_pass_cmp_25", "bonus_pass_yd_300",
             "bonus_pass_yd_400", "bonus_rec_yd_100", "bonus_rec_yd_200", "bonus_rush_att_20",
             "bonus_rush_rec_yd_100", "bonus_rush_rec_yd_200", "bonus_rush_yd_100", "bonus_rush_yd_200",
             "kr_yd", "pr_yd", "bonus_rush_td_qb")
_IGNORE_RES = [re.compile(f"^(?:{p})$") for p in AUDIT["ignore_patterns"]]


def _ignored(k: str) -> bool:
    return k in AUDIT["ignore_exact"] or any(r.match(k) for r in _IGNORE_RES)


def _finite(v) -> bool:
    return not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)


def _weight(k, v) -> float:
    if not _finite(v):
        raise ValueError(f"Invalid scoring weight: {k}")
    return float(v)


def effective_weights(scoring: dict) -> dict:
    if not isinstance(scoring, dict):
        raise ValueError("Missing scoring settings.")
    out = {p: {} for p in POSITIONS}
    for k, raw in scoring.items():
        if k not in KEYS:
            continue
        v = _weight(k, raw)
        if v == 0:
            continue
        stat, positions = KEYS[k]
        for pos in positions or POSITIONS:
            out[pos][stat] = out[pos].get(stat, 0.0) + v
    for pos in POSITIONS:
        if any(not math.isfinite(w) for w in out[pos].values()):
            raise ValueError("Scoring overflow.")
        out[pos] = {s: w for s, w in out[pos].items() if w != 0}
    return out


def classify(scoring: dict) -> dict:
    weights = effective_weights(scoring)
    res = {"weights": weights, "approx": [], "rare": [], "recurring": [], "ignored": [], "unknown": [],
           "refused": False}
    for k, raw in scoring.items():
        v = _weight(k, raw)
        if v == 0:
            continue
        if k in KEYS:
            if k in APPROX:
                res["approx"].append(k)
        elif k in RARE:
            res["rare" if abs(v) <= RARE[k] else "recurring"].append(k)
        elif k in RECURRING:
            res["recurring"].append(k)
        elif _ignored(k):
            res["ignored"].append(k)
        else:
            res["unknown"].append(k)
            res["recurring"].append(k)
    res["refused"] = all(not weights[p] for p in POSITIONS)
    return res


def plain(x) -> str:
    if not _finite(x):
        raise ValueError("weight must be a finite number")
    x = float(x)
    if x == 0:
        return "0"
    return format(Decimal(repr(x)).normalize(), "f")


def evidence_identity(weights: dict) -> str:
    parts = []
    for pos in POSITIONS:
        ws = weights.get(pos, {})
        inner = ",".join(json.dumps(s) + ":" + json.dumps(plain(ws[s])) for s in sorted(ws))
        parts.append(json.dumps(pos) + ":{" + inner + "}")
    return '{"v":1,"w":{' + ",".join(parts) + "}}"
```
- [ ] **Step 8: Run** both tests and `node tests/formats_fixture.cjs` → PASS.
- [ ] **Step 9: Commit** `feat: league lens core - classification, per-position weights, lossless evidence identity (JS+Python twin)`.

---

### Task 3: Validated lens scoring, disclosures, parity fixture

Spec §4, §3.3, §9.1. Review Focus 4. Astra I3.

**Files:** Modify `site/assets/leaguelens.js`, `src/ffmodel/site/leaguelens.py`, both lens tests; create `tools/make_leaguelens_parity.py`, `tests/fixtures/leaguelens_parity.json`

**Interfaces:**
- JS `score(sq, position, weights)` / Python `reference_score(sq, position, weights)` → `{p10, p50, p90}`. Identical validation: `position` ∈ POSITIONS; `sq.p50` an object; p10 and p90 both null (point-only → output p10/p90 null) or both objects; every stat used by a nonzero weight is a finite number (no bool/string/NaN) in every present quantile; with bands, `p10 ≤ p50 ≤ p90` for that stat; result finite. Errors: `Unsupported scoring position`, `Incomplete stat quantiles.`, `Missing or invalid {q} stat: {stat}`, `Malformed band for {stat}`, `Scoring overflow.`
- JS `disclosures(classification) → {banner|null, footnotes:[]}` (Global Constraints copy; categories in settings order, joined `", "`).

- [ ] **Step 1: Failing tests** — append to `tests/leaguelens_fixture.cjs`:
```js
const q = { p10: { receptions: 2 }, p50: { receptions: 5 }, p90: { receptions: 8 } };
assert.deepStrictEqual(L.score(q, "TE", L.effectiveWeights({ rec: -1, bonus_rec_te: 2 })), { p10: 2, p50: 5, p90: 8 });
assert.deepStrictEqual(L.score(q, "WR", L.effectiveWeights({ rec: -1, bonus_rec_te: 2 })), { p10: -8, p50: -5, p90: -2 });
assert.deepStrictEqual(L.score({ p10: null, p50: { receptions: 5 }, p90: null }, "WR", L.effectiveWeights({ rec: 1 })), { p10: null, p50: 5, p90: null });
assert.deepStrictEqual(L.score(q, "QB", L.effectiveWeights({ bonus_rec_te: 1 })), { p10: 0, p50: 0, p90: 0 });
assert.throws(() => L.score({ p10: {}, p50: {}, p90: {} }, "WR", L.effectiveWeights({ rec: 1 })), /receptions/);
assert.throws(() => L.score(q, "K", L.effectiveWeights({ rec: 1 })), /Unsupported scoring position/);
assert.throws(() => L.score({ p10: null, p50: { receptions: 5 }, p90: { receptions: 8 } }, "WR", L.effectiveWeights({ rec: 1 })), /Incomplete/);
assert.throws(() => L.score({ p10: { receptions: 8 }, p50: { receptions: 5 }, p90: { receptions: 2 } }, "WR", L.effectiveWeights({ rec: 1 })), /Malformed band/);
assert.throws(() => L.score({ p10: { receptions: 2 }, p50: { receptions: 100 }, p90: { receptions: 8 } }, "WR", L.effectiveWeights({ rec: 1 })), /Malformed band/);
assert.throws(() => L.score({ p10: null, p50: { receptions: "5" }, p90: null }, "WR", L.effectiveWeights({ rec: 1 })), /invalid/);
assert.throws(() => L.score({ p10: null, p50: { receptions: 1e308 }, p90: null }, "WR", L.effectiveWeights({ rec: 1e10 })), /overflow/);
const odd = L.classify({ pass_yd: 0.05, rec: 0.25, bonus_fd_wr: 0.5 });
assert.strictEqual(odd.refused, false);
assert.strictEqual(L.disclosures(odd).banner, "Your league also scores bonus_fd_wr, which these projections leave out; rankings may be off for your league.");
const gabD = L.disclosures(L.classify(gab));
assert.strictEqual(gabD.banner, null);
assert.ok(gabD.footnotes.includes("Pick-sixes use an average rate, not a forecast."));
assert.ok(gabD.footnotes.some(f => f.startsWith("Not projected: ") && f.endsWith(" (rare events).")));
const P = require("./fixtures/leaguelens_parity.json");
for (const cs of P.cases) {
  if (cs.expected_error) { assert.throws(() => L.score(cs.stat_quantiles, cs.position, L.effectiveWeights(cs.scoring)), new RegExp(cs.expected_error)); continue; }
  const got = L.score(cs.stat_quantiles, cs.position, L.effectiveWeights(cs.scoring));
  for (const k of ["p10", "p50", "p90"]) {
    if (cs.expected[k] === null) assert.strictEqual(got[k], null);
    else assert.ok(Math.abs(got[k] - cs.expected[k]) <= 1e-9, `${cs.name} ${k}`);
  }
}
```
Append to `tests/test_leaguelens.py`:
```python
def test_parity_fixture_reproducible():
    data = json.loads(Path("tests/fixtures/leaguelens_parity.json").read_text())
    for c in data["cases"]:
        w = L.effective_weights(c["scoring"])
        if c.get("expected_error"):
            with pytest.raises(ValueError, match=c["expected_error"]):
                L.reference_score(c["stat_quantiles"], c["position"], w)
        else:
            assert L.reference_score(c["stat_quantiles"], c["position"], w) == c["expected"], c["name"]

def test_reference_matches_published_league_points():
    w = json.loads(Path("site/data/weekly.json").read_text())
    weights = L.effective_weights(w["league"]["sleeper_scoring"])
    for p in w["players"]:
        got = L.reference_score(p["stat_quantiles"], p["position"], weights)
        for k in ("p10", "p50", "p90"):
            assert abs(got[k] - p["points"]["league"][k]) <= 0.005 + 1e-9, (p["name"], k)

@pytest.mark.parametrize("sq,err", [
    ({"p10": None, "p50": {"receptions": 5}, "p90": {"receptions": 8}}, "Incomplete"),
    ({"p10": None, "p50": {"receptions": "5"}, "p90": None}, "invalid"),
    ({"p10": None, "p50": {"receptions": True}, "p90": None}, "invalid"),
    ({"p10": None, "p50": {"receptions": float("nan")}, "p90": None}, "invalid"),
    ({"p10": {"receptions": 8}, "p50": {"receptions": 5}, "p90": {"receptions": 2}}, "Malformed band"),
])
def test_reference_validation(sq, err):
    with pytest.raises(ValueError, match=err):
        L.reference_score(sq, "WR", L.effective_weights({"rec": 1}))
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** JS (in `leaguelens.js`, exported):
```js
  const isNum = v => typeof v === "number" && Number.isFinite(v);
  function score(sq, position, weights) {
    if (!POSITIONS.includes(position)) throw new Error(`Unsupported scoring position: ${position}`);
    if (!sq || typeof sq.p50 !== "object" || sq.p50 === null) throw new Error("Incomplete stat quantiles.");
    const lowNull = sq.p10 == null, highNull = sq.p90 == null;
    if (lowNull !== highNull) throw new Error("Incomplete stat quantiles.");
    const bands = !lowNull;
    const out = { p10: bands ? 0 : null, p50: 0, p90: bands ? 0 : null };
    for (const [stat, w] of Object.entries(weights[position] || {})) {
      const mid = sq.p50[stat];
      if (!isNum(mid)) throw new Error(`Missing or invalid p50 stat: ${stat}`);
      out.p50 += w * mid;
      if (bands) {
        const lo = sq.p10[stat], hi = sq.p90[stat];
        if (!isNum(lo)) throw new Error(`Missing or invalid p10 stat: ${stat}`);
        if (!isNum(hi)) throw new Error(`Missing or invalid p90 stat: ${stat}`);
        if (!(lo <= mid && mid <= hi)) throw new Error(`Malformed band for ${stat}`);
        const a = w * lo, b = w * hi;
        out.p10 += Math.min(a, b); out.p90 += Math.max(a, b);
      }
    }
    if (Object.values(out).some(v => v !== null && !Number.isFinite(v))) throw new Error("Scoring overflow.");
    return out;
  }
  function disclosures(c) {
    const footnotes = [];
    if (c.approx.includes("pass_int_td")) footnotes.push("Pick-sixes use an average rate, not a forecast.");
    if (c.rare.length) footnotes.push(`Not projected: ${c.rare.join(", ")} (rare events).`);
    const banner = c.recurring.length
      ? `Your league also scores ${c.recurring.join(", ")}, which these projections leave out; rankings may be off for your league.`
      : null;
    return { banner, footnotes };
  }
```
Python (`leaguelens.py`):
```python
def reference_score(sq: dict, position: str, weights: dict) -> dict:
    if position not in POSITIONS:
        raise ValueError(f"Unsupported scoring position: {position}")
    if not isinstance(sq, dict) or not isinstance(sq.get("p50"), dict):
        raise ValueError("Incomplete stat quantiles.")
    low_null, high_null = sq.get("p10") is None, sq.get("p90") is None
    if low_null != high_null:
        raise ValueError("Incomplete stat quantiles.")
    bands = not low_null
    out = {"p10": 0.0 if bands else None, "p50": 0.0, "p90": 0.0 if bands else None}
    for stat, w in weights.get(position, {}).items():
        mid = sq["p50"].get(stat)
        if not _finite(mid):
            raise ValueError(f"Missing or invalid p50 stat: {stat}")
        out["p50"] += w * mid
        if bands:
            lo, hi = sq["p10"].get(stat), sq["p90"].get(stat)
            if not _finite(lo):
                raise ValueError(f"Missing or invalid p10 stat: {stat}")
            if not _finite(hi):
                raise ValueError(f"Missing or invalid p90 stat: {stat}")
            if not lo <= mid <= hi:
                raise ValueError(f"Malformed band for {stat}")
            a, b = w * lo, w * hi
            out["p10"] += min(a, b)
            out["p90"] += max(a, b)
    if any(v is not None and not math.isfinite(v) for v in out.values()):
        raise ValueError("Scoring overflow.")
    return out
```
**Stop condition:** `test_reference_matches_published_league_points` runs the band-order rule on every real published player. If real rows violate `p10 ≤ p50 ≤ p90` for some stat, stop and report the counts — do not loosen the rule; the spec's "malformed bands refuse the player" then needs an owner decision.
- [ ] **Step 4: Parity fixture.** `tools/make_leaguelens_parity.py`: first 40 players of `site/data/weekly.json` × four scorings (Gabagool and FAM `league.sleeper_scoring`; `{"pass_yd":0.05,"rec":0.5,"bonus_rec_te":0.5,"rush_att":0.1,"pass_int_td":-2}`; `{"rec":-1,"bonus_rec_te":2,"pass_td":4}`) with `expected = reference_score(...)`, plus the five malformed cases above with `expected_error`. Run it.
- [ ] **Step 5: Run** both test files → PASS.
- [ ] **Step 6: Commit** `feat: validated league lens scoring with combined-weight bands, disclosures, Python reference parity`.

---

### Task 4: Exact lexicographic lineup kernel

Spec §7.1, §9.2. Astra B1, I2, I9.

**Files:** Create `site/assets/lineup.js`, `tests/lineup_fixture.cjs`

**Interfaces:**
- `MODELED` = `["QB","RB","WR","TE","FLEX","SUPER_FLEX","WRRB_FLEX","REC_FLEX"]`; `UNMODELED` = `["K","DEF","DL","LB","DB","IDP_FLEX"]`; `NON_STARTING` = `["BN","IR","TAXI"]`; `UNMODELED_POSITIONS` = `["K","DEF","DL","LB","DB"]`.
- `solve({slots, candidates, fixed = {}, current = []}) → {ok:true, total, assignment:[{index, slot, id, score, fixed, unmodeled}]} | {ok:false, reason, slot}`.
  - `slots`: starting slot names in roster order (callers drop `NON_STARTING`); unknown → throws `Unsupported lineup slot: X`.
  - `candidates`: `[{id, position, score}]`, unique string ids, any finite score (duplicate → throws `Duplicate or invalid candidate id`).
  - `fixed`: `{index: {id, score|null, position?}}` — locked players in modeled slots (position required; ineligible → `{ok:false, reason:"Locked player is in an incompatible slot."}`) and occupants of unmodeled slots; an id fixed twice → `{ok:false}`; fixed ids leave the candidate pool.
  - Objective, exact: (1) maximise the exact sum of the binary64 scores in the open modeled slots; (2) maximise the number of open slots whose candidate equals `current[index]`; (3) the smallest id vector over open slots in slot order (UTF-16 comparison). `total` = float sum for display; fixed slots excluded.
- `bestLineup(players, slots, scoreOf)` / `lineupScore(...)`: ROS-compatible adapters **for modeled slots only** (any other slot → throws); players carry `position` and `sleeper_id` or `id`; null/undefined/NaN score skips the player; `{total, starters:[{player, slot, points}]}` or `{total:-Infinity, starters:[], unfillable:<slot>}`.

- [ ] **Step 1: Failing test** `tests/lineup_fixture.cjs`:
```js
const assert = require("assert");
const Lx = require("../site/assets/lineup.js");
const ELIG = require("../site/assets/formats.js").AUDIT.slot_eligible;
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
// Independent exact oracle: every double is an integer multiple of 2^-1074.
function exact(x) {
  if (x === 0) return 0n;
  const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, x);
  const hi = dv.getUint32(0), lo = dv.getUint32(4), eb = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (eb) m |= 1n << 52n;
  const sh = BigInt((eb ? eb - 1075 : -1074) + 1074);
  return (hi >>> 31 ? -m : m) << sh;
}
function brute({ slots, candidates, current = [], fixed = {} }) {
  const fixedIds = new Set(Object.values(fixed).map(f => f.id));
  const open = slots.map((s, i) => i).filter(i => !(i in fixed) && Lx.MODELED.includes(slots[i]));
  const pool = candidates.filter(c => !fixedIds.has(c.id));
  let best = null; const used = new Set(), pick = [];
  (function rec(k) {
    if (k === open.length) {
      const total = pick.reduce((a, c) => a + exact(c.score), 0n);
      const keep = pick.filter((c, j) => current[open[j]] === c.id).length;
      const ids = pick.map(c => c.id);
      const better = !best || total > best.total || (total === best.total && (keep > best.keep ||
        (keep === best.keep && ids.join("\u0000") < best.ids.join("\u0000"))));
      if (better) best = { total, keep, ids };
      return;
    }
    for (const c of pool) {
      if (used.has(c.id) || !ELIG[slots[open[k]]].includes(c.position)) continue;
      used.add(c.id); pick.push(c); rec(k + 1); pick.pop(); used.delete(c.id);
    }
  })(0);
  return best && { ...best, open };
}
const rand = mulberry32(7), POS = ["QB", "RB", "WR", "TE"];
const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX", "WRRB_FLEX", "REC_FLEX", "K", "DL"];
const scoreOf = () => { const r = rand();
  return r < 0.15 ? 1 + Math.floor(rand() * 3) * 1e-7 : r < 0.3 ? Math.round(rand() * 4) : (rand() * 33 - 3); };
for (let t = 0; t < 600; t++) {
  const slots = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => SLOTS[Math.floor(rand() * SLOTS.length)]);
  const candidates = Array.from({ length: 3 + Math.floor(rand() * 5) }, (_, i) => ({
    id: String(100 + Math.floor(rand() * 900)) + "_" + i, position: POS[Math.floor(rand() * 4)], score: scoreOf() }));
  const current = slots.map(() => rand() < 0.5 ? candidates[Math.floor(rand() * candidates.length)].id : null);
  const fixed = {};
  slots.forEach((s, i) => { if (Lx.UNMODELED.includes(s) && rand() < 0.5) fixed[i] = { id: "u" + i, score: null }; });
  const want = brute({ slots, candidates, current, fixed });
  const got = Lx.solve({ slots, candidates, current, fixed });
  if (!want) { assert.strictEqual(got.ok, false, `trial ${t} should be infeasible`); continue; }
  assert.ok(got.ok, `trial ${t}: ${got.reason}`);
  assert.deepStrictEqual(want.open.map(i => got.assignment[i].id), want.ids, `trial ${t}`);
}
let r = Lx.solve({ slots: ["RB"], candidates: [{ id: "a", position: "RB", score: 1.0000001 }, { id: "b", position: "RB", score: 1.0000002 }], current: ["a"] });
assert.strictEqual(r.assignment[0].id, "b", "sub-micro difference decides");
r = Lx.solve({ slots: ["RB"], candidates: [{ id: "a", position: "RB", score: 0 }, { id: "b", position: "RB", score: 4e-7 }], current: ["a"] });
assert.strictEqual(r.assignment[0].id, "b", "zero vs tiny decides");
r = Lx.solve({ slots: ["RB", "FLEX"], candidates: [{ id: "A", position: "RB", score: 20 }, { id: "B", position: "RB", score: 10 }], current: ["B", "A"] });
assert.deepStrictEqual(r.assignment.map(a => a.id), ["B", "A"], "equal totals keep both exact slots");
r = Lx.solve({ slots: ["RB", "RB"], candidates: [{ id: "A", position: "RB", score: 10 }, { id: "B", position: "RB", score: 10 }], current: [null, null] });
assert.deepStrictEqual(r.assignment.map(a => a.id), ["A", "B"], "no current: smallest id vector");
r = Lx.solve({ slots: ["QB"], candidates: [{ id: "q", position: "QB", score: 5000 }, { id: "p", position: "QB", score: -5000 }] });
assert.strictEqual(r.assignment[0].id, "q", "no score ceiling");
r = Lx.solve({ slots: ["RB", "K"], candidates: [{ id: "A", position: "RB", score: 20 }, { id: "B", position: "RB", score: 10 }], fixed: { 1: { id: "A", score: null } } });
assert.ok(r.ok); assert.deepStrictEqual(r.assignment.map(a => a.id), ["B", "A"]); assert.strictEqual(r.total, 10);
assert.strictEqual(Lx.solve({ slots: ["RB", "K"], candidates: [], fixed: { 0: { id: "A", score: 1, position: "RB" }, 1: { id: "A", score: null } } }).ok, false);
assert.strictEqual(Lx.solve({ slots: ["RB"], candidates: [], fixed: { 0: { id: "Q", score: 1, position: "QB" } } }).reason, "Locked player is in an incompatible slot.");
r = Lx.solve({ slots: ["QB", "K"], candidates: [{ id: "Q", position: "QB", score: 15 }] });
assert.ok(r.ok); assert.strictEqual(r.assignment[1].id, null);
r = Lx.solve({ slots: ["QB", "TE"], candidates: [{ id: "Q", position: "QB", score: 15 }] });
assert.deepStrictEqual([r.ok, r.slot], [false, "TE"]);
r = Lx.solve({ slots: ["TE"], candidates: [{ id: "T", position: "TE", score: -2 }] });
assert.deepStrictEqual([r.ok, r.total], [true, -2]);
assert.throws(() => Lx.solve({ slots: ["XYZ"], candidates: [] }), /Unsupported lineup slot/);
assert.throws(() => Lx.solve({ slots: ["QB"], candidates: [{ id: "a", position: "QB", score: 1 }, { id: "a", position: "QB", score: 2 }] }), /Duplicate/);
const players = [{ sleeper_id: "z", position: "RB" }, { sleeper_id: "a", position: "RB" }];
assert.strictEqual(Lx.bestLineup(players, ["RB"], () => 5).starters[0].player.sleeper_id, "a");
assert.strictEqual(Lx.lineupScore(players, ["RB", "RB", "RB"], () => 5), -Infinity);
assert.strictEqual(Lx.lineupScore(players, ["RB"], p => p.sleeper_id === "z" ? null : 3), 3);
assert.throws(() => Lx.bestLineup(players, ["RB", "K"], () => 1), /modeled/);
console.log("lineup_fixture: ok");
```
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** `site/assets/lineup.js`:
```js
/* Exact lineup kernel (spec §7.1). Objective, lexicographic: (1) the exact sum
   of the binary64 scores in the open modeled slots, (2) the number of open
   slots keeping their current starter, (3) the smallest id vector in slot
   order. Scores become exact BigInt integers at a common power-of-two scale;
   the keep count is folded in with a multiplier larger than any keep total,
   so no epsilon is involved. rostersim.js keeps ROS.bestLineup (frozen). */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.Lineup = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";
  const Formats = (typeof module !== "undefined" && module.exports) ? require("./formats.js") : root.Formats;
  const ELIG = Formats.AUDIT.slot_eligible;
  const MODELED = Object.freeze(["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX", "WRRB_FLEX", "REC_FLEX"]);
  const UNMODELED = Object.freeze(["K", "DEF", "DL", "LB", "DB", "IDP_FLEX"]);
  const NON_STARTING = Object.freeze(["BN", "IR", "TAXI"]);
  const UNMODELED_POSITIONS = Object.freeze(["K", "DEF", "DL", "LB", "DB"]);

  function decompose(x) {               // x = m * 2^e exactly, m a signed BigInt
    if (x === 0) return [0n, 0];
    const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, x);
    const hi = dv.getUint32(0), lo = dv.getUint32(4), eb = (hi >>> 20) & 0x7ff;
    let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    if (eb) m |= 1n << 52n;
    return [hi >>> 31 ? -m : m, eb ? eb - 1075 : -1074];
  }
  // Rectangular Hungarian (n rows <= m cols), BigInt costs, null = forbidden. Minimises.
  function hungarian(cost, n, m) {
    const u = new Array(n + 1).fill(0n), v = new Array(m + 1).fill(0n), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0;
      const minv = new Array(m + 1).fill(null), used = new Array(m + 1).fill(false);
      do {
        used[j0] = true; const i0 = p[j0]; let delta = null, j1 = -1;
        for (let j = 1; j <= m; j++) if (!used[j]) {
          const c = cost[i0 - 1][j - 1];
          if (c !== null) { const cur = c - u[i0] - v[j]; if (minv[j] === null || cur < minv[j]) { minv[j] = cur; way[j] = j0; } }
          if (minv[j] !== null && (delta === null || minv[j] < delta)) { delta = minv[j]; j1 = j; }
        }
        if (delta === null) return null;
        for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else if (minv[j] !== null) minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const col = new Array(n).fill(-1);
    for (let j = 1; j <= m; j++) if (p[j]) col[p[j] - 1] = j - 1;
    let total = 0n;
    for (let i = 0; i < n; i++) total += cost[i][col[i]];
    return { col, total };
  }
  function fail(reason, slot) { return { ok: false, reason, slot }; }
  function solve({ slots, candidates, fixed = {}, current = [] }) {
    if (!Array.isArray(slots)) throw new Error("slots must be an array");
    for (const s of slots) if (!MODELED.includes(s) && !UNMODELED.includes(s)) throw new Error(`Unsupported lineup slot: ${s}`);
    const ids = new Set();
    for (const c of candidates || []) {
      if (typeof c.id !== "string" || ids.has(c.id)) throw new Error(`Duplicate or invalid candidate id: ${c.id}`);
      if (typeof c.score !== "number" || !Number.isFinite(c.score)) throw new Error(`Invalid score for ${c.id}`);
      ids.add(c.id);
    }
    const assignment = slots.map((slot, index) => ({ index, slot, id: null, score: null, fixed: false, unmodeled: UNMODELED.includes(slot) }));
    const fixedIds = new Set();
    for (const [k, f] of Object.entries(fixed)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || i >= slots.length || !f || typeof f.id !== "string") return fail("Invalid fixed slot.", slots[i]);
      if (fixedIds.has(f.id)) return fail(`Player ${f.id} occupies two slots.`, slots[i]);
      if (MODELED.includes(slots[i]) && !(f.position && ELIG[slots[i]].includes(f.position))) return fail("Locked player is in an incompatible slot.", slots[i]);
      fixedIds.add(f.id);
      Object.assign(assignment[i], { id: f.id, score: f.score ?? null, fixed: true });
    }
    const open = assignment.filter(a => !a.fixed && !a.unmodeled).map(a => a.index);
    if (!open.length) return { ok: true, total: 0, assignment };
    const pool = (candidates || []).filter(c => !fixedIds.has(c.id));
    const unfillable = () => { const i = open.find(i => !pool.some(c => ELIG[slots[i]].includes(c.position))) ?? open[open.length - 1];
      return fail(`Cannot fill ${slots[i]} with available, projected players.`, slots[i]); };
    if (pool.length < open.length) return unfillable();
    const parts = pool.map(c => decompose(c.score));
    const minE = Math.min(...parts.filter(([m]) => m !== 0n).map(([, e]) => e), 0);
    const ints = parts.map(([m, e]) => m << BigInt(e - minE));
    const K = BigInt(open.length + 1);
    const base = open.map(i => pool.map((c, j) => ELIG[slots[i]].includes(c.position)
      ? -(ints[j] * K + (current[i] === c.id ? 1n : 0n)) : null));
    const best = hungarian(base, open.length, pool.length);
    if (!best) return unfillable();
    const cost = base.map(r => r.slice());
    for (let r = 0; r < open.length; r++) {
      const order = pool.map((c, j) => j).filter(j => cost[r][j] !== null)
        .sort((a, b) => (pool[a].id < pool[b].id ? -1 : pool[a].id > pool[b].id ? 1 : 0));
      for (const j of order) {
        const trial = cost.map((row, rr) => row.map((x, jj) => (rr === r ? (jj === j ? x : null) : (jj === j ? null : x))));
        const res = hungarian(trial, open.length, pool.length);
        if (res && res.total === best.total) { for (let i = 0; i < cost.length; i++) cost[i] = trial[i]; break; }
      }
    }
    const final = hungarian(cost, open.length, pool.length);
    let total = 0;
    open.forEach((slotIndex, r) => {
      const c = pool[final.col[r]];
      Object.assign(assignment[slotIndex], { id: c.id, score: c.score });
      total += c.score;
    });
    return { ok: true, total, assignment };
  }
  const pid = p => String(p.sleeper_id ?? p.id);
  function bestLineup(players, slots, scoreOf) {
    for (const s of slots) if (!MODELED.includes(s)) throw new Error(`bestLineup accepts modeled slots only, got ${s}`);
    const cands = [], byId = new Map();
    for (const p of players || []) {
      if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
      const v = scoreOf(p);
      if (v === null || v === undefined || Number.isNaN(v)) continue;
      cands.push({ id: pid(p), position: p.position, score: v }); byId.set(pid(p), p);
    }
    const r = solve({ slots, candidates: cands });
    if (!r.ok) return { total: -Infinity, starters: [], unfillable: r.slot };
    return { total: r.total, starters: r.assignment.map(a => ({ player: byId.get(a.id), slot: a.slot, points: a.score })) };
  }
  const lineupScore = (players, slots, scoreOf) => bestLineup(players, slots, scoreOf).total;
  return Object.freeze({ MODELED, UNMODELED, NON_STARTING, UNMODELED_POSITIONS, solve, bestLineup, lineupScore });
});
```
- [ ] **Step 4: Run** `node tests/lineup_fixture.cjs` → `lineup_fixture: ok`. If a brute-force trial disagrees, fix the kernel, never the oracle.
- [ ] **Step 5: Commit** `feat: exact lexicographic lineup kernel (BigInt raw scores, keep-in-slot, id order) with exact brute-force oracle`.

---

### Task 5: Neutral builders, batch context and identity universe (Python)

Spec §3.1, §3.3, §3.4. Astra P2, I4, I5, I10.

**Files:** Create `src/ffmodel/site/neutral.py`, `tests/test_neutral.py`, `tests/fixtures/remaining_legacy_expected.json`; modify `src/ffmodel/site/remaining.py`, `src/ffmodel/site/weekly.py`, `src/ffmodel/site/sleeper.py`, `tests/test_sleeper.py`

**Interfaces:**
- `BatchContext` (frozen dataclass in `neutral.py`): `season:int, week:int, data_through:str, generated_at:str, batch_id:str`; `batch_id = f"{generated_at}|{data_through}|w{week}"`. Every neutral file header carries all five plus `schema_version`, `kind`.
- `build_weekly_projections(..., generated_at: str | None = None)` and `build_remaining(..., generated_at: str | None = None, emit: str = "league", full_precision_out: dict | None = None)` — a given `generated_at` replaces the clock read; defaults keep today's behavior.
- `neutral_weekly(weekly_payload, ctx, pick_six_prior, method) -> dict`: `points` reduced to `ppr/half_ppr/standard`, `stats_p50` dropped, `stat_quantiles` full precision, `pick_six_forecast`, `method`, header from `ctx`, `kind: "neutral_weekly"`, `schema_version: 1`.
- `build_remaining(..., league=None, emit="neutral")`: projection rows `{"week","status":"conditional_projection","opponent","stats":[p10|null, p50, p90|null]}` (12 floats, 4 decimals, `stat_order` order); `bye`/`unmodeled` rows unchanged; header `kind: "neutral_remaining"`, `schema_version: 2`, `stat_order`, `pick_six_forecast`, `method`; no `league`, no `evaluation`. Neutral mode skips only the league-scoring validation (the `league.get("league_id")`/`sleeper_scoring` requirement and the `SLEEPER_RULE_FIELDS` loop) and keeps the `current_teams` requirement, horizon check and every later check. `emit="league"` output is **byte-identical** to today. `full_precision_out` (dict) receives `{player_id: {week: {"p10":{…},"p50":{…},"p90":{…}}}}` unrounded (Task 15 parity; never published).
- `empty_remaining(ctx, model) -> dict`: `status: "no_remaining_weeks"`, `start_week: ctx.week`, `players: []`, header from `ctx`.
- `normalize_team(code)` with `{"LAR":"LA","WSH":"WAS","JAC":"JAX"}`.
- `build_players(ctx, weekly_n, remaining_n, sleeper_players, ecr_rows, schedule) -> dict`: header from `ctx`, `kind: "neutral_players"`, `ecr_source` (`{source, date, scoring:"PPR"}` or null), `players:[{player_id, sleeper_id|null, name, team, position, bye|null, ecr|null, identity_only, reason|null}]`.
- `pull_sleeper_players(cache_dir, max_age_hours=None)` refetches when the cache is older.

Identity rules (spec §3.4, astra I5): one mapping over the weekly ∪ remaining players; team/position/GSIS from projections; weekly vs remaining disagreeing on team or position → `identity_only, reason:"projection_identity_conflict"`; catalog by stripped `gsis_id`: 0 hits → `"no_catalog_match"`, >1 → `"duplicate_gsis_in_catalog"` (no name fallback), team disagreement after `normalize_team` → `"team_disagrees"`, position → `"position_disagrees"`; `name` = catalog `full_name` when matched, else the projection name.

- [ ] **Step 1: Capture the legacy byte baseline before editing.** With a fixed clock (monkeypatch `ffmodel.site.remaining.datetime` and `ffmodel.site.weekly.datetime` with a subclass whose `now()` returns `datetime(2026,10,6,tzinfo=timezone.utc)`), run the *unmodified* `build_remaining` on the synthetic inputs `tests/test_remaining.py` already uses (read it; reuse its stub predictor and frames) and save the production serialization `json.dumps(payload, separators=(",", ":"), allow_nan=False)` to `tests/fixtures/remaining_legacy_expected.json`.
- [ ] **Step 2: Failing tests** `tests/test_neutral.py` (synthetic, no model): `test_legacy_bytes_unchanged` (same clock and inputs; default `emit` and explicit `emit="league"` serialize to the fixture bytes); `test_neutral_remaining_rows` (`stat_order == list(STATS)`, 3-entry `stats` of 12 floats at 4 decimals, no `league`/`evaluation`, header equals `ctx`, `full_precision_out` values round to the published ones); `test_neutral_weekly`; `test_empty_remaining_state`; `test_normalize_team_aliases`; identity cases (one-to-one; duplicate GSIS; `LAR`≡`LA`; position disagreement; weekly-vs-remaining conflict; catalog name; no catalog match). In `tests/test_sleeper.py`: a 25 h-old cache with `max_age_hours=24` calls `_fetch_players` (monkeypatched); 23 h does not; `None` never refetches.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.**
- [ ] **Step 5: Run** `.venv/Scripts/python.exe -m pytest tests/test_neutral.py tests/test_remaining.py tests/test_remaining_eval.py tests/test_sleeper.py tests/test_generate.py -q` → PASS.
- [ ] **Step 6: Commit** `feat: neutral builders with batch context, strict identity universe, byte-identical legacy remaining`.

---

### Task 6: Evidence records and the current-output method descriptor

Spec §3.2, §8.9. Astra F1, P1, I6. Model: **opus**.

**Files:** Create `src/ffmodel/site/method.py`, `src/ffmodel/site/evidence_records.py`, `tests/test_evidence_records.py`

**Interfaces:**
- `method.current_method(artifact_roots: list[str], pick_six_prior: dict) -> dict` = `{"v":1, "model":"transformer", "artifacts": sorted(artifact_roots), "ensemble":"mean_of_seed_quantiles", "band_construction":"component_sign_coherent_v1", "prior":{"method","rate","first_season","through_season"}}`; published as `method` in `neutral/weekly.json` and `neutral/remaining.json`.
- `build_evaluation(ctx) -> dict` = header from `ctx` + `kind: "neutral_evaluation"`, `records:[{id, metric, source:{path, sha256}, source_settings:{league, scoring}, effective_scoring:<identity of realized-outcome scoring>, prediction_scoring:<identity of prediction scoring>|null, omitted:[{key, reason}], method:<current_method shape>|null, population, horizon, values}]`.
- Matching (Task 8): a record is a current-output claim only if `method` is non-null with every required field, deep-equals the current method, and `effective_scoring == prediction_scoring ==` the live league's identity.

- [ ] **Step 1: Read each source; document findings in the module docstring.**
  - ROS MAE `models/diagnostics/remaining_matrix_gabagool.json`: scope from its per-horizon reports (all 24 `pick_six_evaluated: false` → `omitted:[{"key":"pass_int_td","reason":"pick-six actuals unavailable"}]`; `effective_scoring` = Gabagool scoring with `pass_int_td` 0; `prediction_scoring` = what the reports say the forecast used); `method`: the file's ensemble roots, and `band_construction`/prior only if recorded — otherwise `method: null`. No FAM record (file absent; never borrow).
  - Close calls `site/data/start_sit_evaluation.json`: translate its internal scoring names with an explicit table (`interception→pass_int`, `reception→rec`, `fumble_lost→fum_lost`, the yardage/TD names as named; list every key the file uses — an unmapped key raises); `prediction_scoring` includes prior-based pick-six costs; `effective_scoring` has `pass_int_td` 0 with `omitted` "actual pick-six penalties unavailable"; its per-season priors differ → `method: null` (historical only).
  - Band calibration (~80%): locate the committed source (`site/weekly.html` footer → `site/data/about.json` → `models/`); if scoring or band construction can't be established from a committed artifact, emit no record and say so.
- [ ] **Step 2: Failing tests** `tests/test_evidence_records.py`:
```python
from ffmodel.site.evidence_records import build_evaluation
from ffmodel.site.neutral import BatchContext
CTX = BatchContext(2026, 5, "2026-wk4", "2026-10-06T00:00:00+00:00", "x")

def recs():
    return {r["id"]: r for r in build_evaluation(CTX)["records"]}

def test_ros_record_excludes_pick_six():
    ros = recs()["ros_mae_gabagool"]
    assert {"key": "pass_int_td", "reason": "pick-six actuals unavailable"} in ros["omitted"]
    assert '"passing_pick_sixes"' not in ros["effective_scoring"]
    assert ros["source"]["path"].startswith("models/diagnostics/") and len(ros["source"]["sha256"]) == 64

def test_close_call_scoring_translated_and_historical():
    cc = recs()["start_sit_close_calls"]
    assert '"passing_interceptions"' in cc["prediction_scoring"] and '"receptions"' in cc["prediction_scoring"]
    assert cc["method"] is None

def test_header_and_no_borrowing():
    out = build_evaluation(CTX)
    assert out["batch_id"] == "x" and out["kind"] == "neutral_evaluation"
    assert not any(r["id"].endswith("_fam") for r in out["records"])
```
- [ ] **Step 3: Implement**; **Step 4: Run** → PASS; **Step 5: Commit** `feat: evidence records with realized vs prediction scoring and a current-output method descriptor`.

---

### Task 7: Single-process batch generation and commit-boundary publication

Spec §3.5, §10. Astra B2, I4, P4. Model: **opus**.

**Files:** Create `src/ffmodel/site/batch.py`, `src/ffmodel/site/publish.py`, `tests/test_batch.py`, `tests/test_publish.py`; modify `.github/workflows/weekly-update.yml`

**Interfaces:**
- `python -m ffmodel.site.batch --out <EMPTY dir> --model ... --season ... --week auto --leagues gabagool,fam [--artifact-root ...] [--data-dir data/raw] [--debug-full-precision <path>]`: refuses a non-empty `--out`; pulls every input once (weekly, schedules, current teams, Sleeper catalog `max_age_hours=24`, ECR snapshot), resolves the week once, fits once, builds one `BatchContext`; then per league `set_league_rules(league.rules)` and legacy `weekly*.json` + `remaining-<slug>.json` exactly as `generate.py` does today but **fatal** on a remaining failure; shared legacy `kickoffs.json`, `roles.json`, `about.json` once; neutral `neutral/{weekly,remaining|empty,players,evaluation,formats}.json`; finally `manifest.json` listing every written file with sha256. Import `generate.py` helpers; do not duplicate model/data code. `generate.py` stays as is for `--draft` and manual runs.
- `neutral/formats.json` = `neutral.format_table()` → `[{label, format_key, compat, description, exploratory}]` from `models/prospective/2026/format_payloads.json` (dict keyed by label; `format_key`/`compat` copied byte-for-byte); descriptions: `f12-1qb-ppr-6` "12-team 1QB PPR, 6-pt pass TD"; `f10-1qb-ppr-6` "10-team 1QB PPR, 6-pt pass TD"; `f12-1qb-ppr-4` "12-team 1QB PPR, 4-pt pass TD"; `f12-1qb-half-4` "12-team 1QB half-PPR, 4-pt pass TD"; `f12-sf-ppr-4` "12-team superflex PPR, 4-pt pass TD (exploratory)" (`exploratory: true`). Commit a copy as `tests/fixtures/neutral_formats.json` (Task 8 uses it).
- `python -m ffmodel.site.publish --stage <dir> --out site/data`: `validate(stage) -> list[str]` then `copy(stage, out)`; nonzero exit prints every error. Validation: `manifest.json` present, every listed file exists with its sha256 (only files produced *this run* count); required = `weekly.json, weekly-fam.json, remaining-gabagool.json, remaining-fam.json, kickoffs.json, roles.json, about.json` + the five neutral files, all in the manifest; JSON parses; the five neutral headers share `season, week, data_through, generated_at, batch_id`; legacy weekly `week`/`data_through` equal neutral; `kickoffs.json` `season`/`week` equal neutral (only fields its schema has); `players.json` ids unique and every weekly/remaining `player_id` present in it; remaining is either `no_remaining_weeks` with `start_week > 17` or every projection row has a 3-entry `stats` of 12 numbers (null bands allowed); `neutral/remaining.json` ≤ `SIZE_CAP_BYTES` (`4_000_000` until Task 15). **No atomicity claim** for the local copy: the boundary is the workflow commit step, which runs only after `publish` exits 0.
- `SIZE_CAP_BYTES` lives in `publish.py`; Task 15 writes `tests/fixtures/neutral_size_measurement.json` and a test asserts `SIZE_CAP_BYTES == ceil(bytes * 1.25 / 100_000) * 100_000`.

- [ ] **Step 1: Failing tests.** `tests/test_publish.py` (tmp dirs): complete stage → `[]`, files copied; each missing required file → named error, `out` untouched; a required file on disk but absent from the manifest (stale carried file) → error; sha mismatch → error; mixed `batch_id` → `batch fields disagree`; legacy `week` ≠ neutral (rollover) → error; duplicate player ids → error; an 11-stat row → error; oversize → `oversize`, not truncated; week-18 empty remaining → valid. `tests/test_batch.py` (predictor, pulls and catalog monkeypatched to small fakes): writes every required file + manifest into an empty dir with one shared `batch_id`; refuses a non-empty `--out`; a remaining-season error for one league aborts with nonzero exit and **no** manifest; `week=18` writes `empty_remaining` and succeeds.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.**
- [ ] **Step 4: Workflow** (non-draft branch of `weekly-update.yml` only) — replace the two-league loop with one step:
```bash
STAGE="$RUNNER_TEMP/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE"
python -m ffmodel.site.batch --out "$STAGE" --model "$MODEL" --season "$SEASON" --week auto --leagues gabagool,fam --artifact-root "$ARTIFACT_ROOT"
python -m ffmodel.site.publish --stage "$STAGE" --out site/data
```
Any nonzero exit fails the job before `Commit refreshed data`. Optional ECR steps stay after it; the draft branch is unchanged.
- [ ] **Step 5: Run** `.venv/Scripts/python.exe -m pytest tests/test_publish.py tests/test_batch.py tests/test_generate.py -q` → PASS; `python -c "import yaml;yaml.safe_load(open('.github/workflows/weekly-update.yml'))"`.
- [ ] **Step 6: Commit** `feat: single-process legacy+neutral batch, manifest-validated publication behind the commit boundary`.

---

### Task 8: League data adapter (`leaguedata.js`)

Spec §3, §4, §5.3, §6.1, §3.2, §11. Astra I5, I6, I11. Model: **opus**.

**Files:** Create `site/assets/leaguedata.js`, `tests/leaguedata_fixture.cjs`, `tests/fixtures/leagues_synthetic.json`

**Interfaces (`window.LeagueData`):**
- `loadBatch() → Promise<{weekly, remaining, players, evaluation, formats}>`: single-flight per document from `data/neutral/*.json`; rejects if `weekly`/`players`/`formats` is missing or the headers' `batch_id` differ (`Projection files are from different refreshes; reload.`); `remaining`/`evaluation` may be null.
- `views(batch, league, {week, catalog}) → {lens, disclosures, weekly, remaining, remainingReason, board, method, excluded}`:
  - `weekly` = `{season, week, generated_at, data_through, players:[{player_id, name, team, opponent, position, points:{league, ppr, half_ppr, standard}}], unscored:[…]}`; `league` via `LeagueLens.score`; reference lenses copied; a scoring error moves the player to `unscored`.
  - `remaining` = today's legacy shape (`schema_version:1, horizon:"remaining_season", status:"experimental", evaluation:null, season, start_week, end_week, generated_at, data_through, players:[{player_id, team, weeks:[{week, status, opponent?, reason?, points:{league:{…}}|null}]}]`) rebuilt from `stats` + `stat_order`; `null` with `remainingReason: "No projected weeks remain."` for `no_remaining_weeks`, or `"remaining-season projections unavailable"` when missing.
  - `board` = `{season, players:[{player_id, sleeper_id, name, position, team, bye, ecr, ros_value}]}` from non-`identity_only` players; `ros_value` = sum of league p50 over weeks `week+1..17`, `null` if any is null.
  - Live revalidation against `catalog`: a mapped player whose live `position` differs from the projection's is removed from `weekly`, `remaining` and `board` and listed in `excluded` (`reason:"position_changed"`). A live **team** difference keeps the player with the projection team, so each analyzer's existing team guard fires as today.
  - `method` = `batch.weekly.method`.
- `rosterIdentities(rosters, catalog)` → Map over every roster/reserve/taxi occupant (K/DEF/IDP/teamless/unknown); a catalog miss → `{name:id, position:null, team:null, unknown:true}`.
- `leagueType(league) → {supported, bestBall, message|null}`: `settings.type` ∈ {0,1,2} else `This league type isn't supported yet.`; `bestBall = settings.best_ball === 1`.
- `slotSupport(league) → {modeled, unmodeled, nonStarting, unknown}` using `Lineup` lists.
- `formatLine(league, formats) → Promise<{text, inTest, eligible}>`: unsupported type → its message; best ball → best-ball copy (overrides a matching fingerprint); unknown starting slot → not-in-test; else `Formats.match(league, formats)` → in-test with the entry's `description`, or not-in-test.
- `evidenceFor(evaluation, id, lens, method) → record|null` per Task 6's matching rule.

- [ ] **Step 1: Synthetic leagues** `tests/fixtures/leagues_synthetic.json` (fictional ids): `gabagool_like`, `fam_like`, `superflex_half`, `te_premium`, `best_ball`, `idp` (adds `DL, LB, IDP_FLEX`), `weird_slot` (`XFLEX`), `fd_league`, `type_9`, `two_team`, `thirty_two_team`.
- [ ] **Step 2: Failing tests** `tests/leaguedata_fixture.cjs` (inline 4-player batch, 3 remaining weeks): scores equal `LeagueLens.score`; reference lenses present; remaining rows rebuild exactly; `ros_value` null when a future week is null; empty-state vs missing copy differ; mixed `batch_id` rejected; catalog position change → excluded everywhere with reason; team change → kept with projection team; `rosterIdentities` keeps K, DEF, IDP, teamless, unknown; `formatLine` with `tests/fixtures/neutral_formats.json`: gabagool_like in test, te_premium not, best_ball best-ball copy, idp not, weird_slot not, type_9 unsupported; `slotSupport(gabagool_like)`: `BN` in `nonStarting`, `unknown` empty; `evidenceFor`: synthetic fully matching record → returned; real ROS record under Gabagool lens → null; `method: null` → null; partial method → null.
- [ ] **Step 3: Implement**; **Step 4: Run** → PASS; **Step 5: Commit** `feat: league data adapter - batch-consistent views, live identity revalidation, format line, league types, evidence binding`.

---

### Task 9: Session, navigation and league selection by id

Spec §5.1, §5.2, §5.4. Review Focus 2, 5. Astra I8, I11. Model: **opus**.

**Files:** Modify `site/assets/session.js`, `site/assets/app.js`, `site/assets/connect.js` (+ `site/connect.html` if it hardcodes links); tests `tests/session_fixture.cjs`, `tests/chip_session_fixture.cjs`, `tests/navigation_fixture.cjs`, `tests/connect_fixture.cjs`

**Interfaces:**
- `Session.ready({leagueId})` (in-season pages): synthetic entry `{slug:null, platform:"sleeper", leagueId, tools:{startsit:true, waivers:true, trade:true}}`, no board; errors `Sleeper has no league with id {id}.` (null league) and `This league is from the {season} season; projections are for {current}.` (league season ≠ `/state/nfl` season). `ready({slug, board})` unchanged for draft pages.
- `Session.refresh` **always** refetches `/league/<id>`; bundles carry `leagueFetchedAt`.
- Analysis roster: bundle fields `viewedRosterId`, derived `analysisRoster` and `analysisRole` (`"owner"` = `myRoster` when found; else `"viewer"` = the roster with `viewedRosterId`; else null). `Session.view(rosterId|null)` sets `viewedRosterId` (generation-safe). An `identify` that finds an owned roster clears `viewedRosterId`. `myRoster` is never set from a view. `chipText` says `Viewing {team name}` for a viewer.
- `FC.inSeasonLeague() → {leagueId, legacySlug}`; `FC.setLeague(leagueId)` (chip calls `Session.ready({leagueId})` immediately; identity optional). `FC.leagueNavigation()` on in-season pages writes the id into in-season links; draft links get the registry slug for a registry id, otherwise `?league=<id>` where the draft page shows `The draft board is only built for registered leagues.`; ESPN unchanged. The chip lists the league's teams by name for choosing a team when `analysisRole !== "owner"`, and shows `League settings read {time}` from `leagueFetchedAt`.
- `connect.js` lists every current-season league with in-season links.

- [ ] **Step 1: Failing tests** (follow each fixture's harness): ready by id → owner / non-owner / anonymous; unknown-id and last-season messages; a roster refresh issues `/league/<id>` and changed `scoring_settings` produce a new bundle; `view(2)` → viewer with `myRoster:null`; then `identify` as owner of roster 3 → `analysisRoster.roster_id === 3`, `viewedRosterId === null`; superseded generations stay discarded across `view`/`identify`/settings changes; navigation by id/slug/unregistered id; `connect` links unregistered leagues; draft-side fixtures unchanged.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (extend `session.js`'s header comment for the id path and analysis roster). **Step 4: Run** the four fixtures + `draftmode_fixture.cjs keepers_fixture.cjs trademode_fixture.cjs` → PASS.
- [ ] **Step 5: Commit** `feat: league selection by Sleeper id, analysis roster for owners and viewers, live settings refetch, draft navigation boundary`.

---

### Task 10: Shared live-world resolver

Astra I8. Precedes Tasks 11–13. Model: **opus**.

**Files:** Create `site/assets/liveworld.js`, `tests/liveworld_fixture.cjs`; modify `site/assets/waivermode.js` (`loadWorld` becomes a wrapper), `tests/waivermode_session_fixture.cjs`

**Interfaces:**
- `LiveWorld.resolve({bundle, week}) → {league, rosters, rosterId, role, users, state, fetchedAt, requestedAt, leagueFetchedAt}`: requires `bundle.analysisRoster` (`Enter your Sleeper username, or choose a team to view.`), roster array, finite `rostersRequestedAt`/`rostersFetchedAt`, `Number.isInteger(week)` 1..18, `league.status === "in_season"` (`This league is {status}, not in season.`), `LeagueData.leagueType(league).supported` (its message). No registry, board, scoring, waiver-type or team-count checks.
- `WaiverMode.loadWorld({bundle, week, get})` = `LiveWorld.resolve` + the week's transactions (today's logic incl. `bundle.extra` reuse) + `waiver_type ∈ {0,1,2}` (waivers only).

- [ ] **Step 1: Failing tests** `tests/liveworld_fixture.cjs`: owner and viewer resolve with `role`; no analysis roster → message; non-in-season → message; type 9 → unsupported; unregistered id works without a registry; `WaiverMode.loadWorld` rejects `waiver_type 3`, `LiveWorld.resolve` accepts it.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the new fixture + `waivermode_session_fixture.cjs` → PASS. **Step 5: Commit** `feat: shared live-world resolver for owners and viewers`.

---

### Task 11: Start/sit on neutral views and the kernel

Spec §7.1 (start/sit), §7.2, §6.1, §3.2, §5.2, §8. Review Focus 1, 5. Model: **opus**.

**Files:** Modify `site/assets/startsit.js`, `site/assets/startsitmode.js`, `site/weekly.html`; tests `tests/startsit_fixture.cjs`, `tests/startsitmode_session_fixture.cjs`; remove the start/sit section of `tests/inseason_baseline_fixture.cjs`

`StartSit.analyze({board, weekly, league, roster, catalog, kickoffs, excludeIds, now, snapshotAt})` keeps its signature and return shape; `board`/`weekly` are Task 8 views.

Edits to `startsit.js`:
- Delete the three contract checks: `require(weekly?.league?.league_id === league.league_id,…)`, `require(league.scoring_settings && weekly.league.sleeper_scoring,…)`, and the `for (const k of new Set([...Object.keys(league.scoring_settings)…` loop. Keep the season/week/age loop and kickoff checks verbatim.
- Replace `require(slots.every(p=>skill.has(p)||["FLEX","K","DEF"].includes(p)),"Unsupported lineup slot.")` with: every starting slot in `Lineup.MODELED ∪ Lineup.UNMODELED`, else `Unsupported lineup slot: {slot}` (`slots` already drops `BN/IR/TAXI`).
- Keep the per-player loop verbatim, adding one rule: a player in the view's `excluded` (position changed) counts as missing.
- Replace everything from `const eligibleFor = …` through the "Keep equivalent dedicated/FLEX slot assignments stable" swap loop with one `Lineup.solve`: `fixed` = locked players in their current slot (with `position`) + unmodeled-slot occupants (`starters[i]` when not `"0"`); `candidates` = unlocked, eligible, projected players (`score = points.p50`); `current = starters`. `{ok:false}` → throw `Cannot fill {slot} with available, projected players. Review injuries/exclusions.` (locked-incompatible keeps `Locked player is in an incompatible slot.`). Map back to today's lineup row shape (`unmodeled:true` rows for unmodeled slots).
- Keep the bench/close-call block verbatim (raw p50s, 3-point threshold).

`startsitmode.js`: statics = `LeagueData.loadBatch()` + `data/kickoffs.json`; world from `LiveWorld.resolve`; views per bundle; best ball → projections + best-ball note, no `analyze`; unsupported type/unknown slots → projections only with the message naming the slot; render format line, banner, footnotes, settings stamp, `Viewing {team}` for viewers (exclusion checkboxes owner-only), heuristic label on the close-call note; recompute on settings change. `weekly.html`: script tags `formats.js, leaguelens.js, lineup.js, leaguedata.js, liveworld.js` before `startsit.js`; projection table gets a "Your league" lens (view `points.league`) beside PPR/half/standard; the 56.3% and ~80% lines render only via `LeagueData.evidenceFor` (else the fallback copy — the expected outcome today).

- [ ] **Step 1: Tests first.** `startsit_fixture.cjs`: delete contract-mismatch cases; add superflex/WRRB_FLEX/REC_FLEX lineups equal to `Lineup.solve`; IDP pass-through; `XFLEX` → `Unsupported lineup slot: XFLEX`; `BN×5, IR, TAXI` accepted; each §7.1 start/sit case (injury tags; exclusion; unlocked missing projection → throws; wrong-team projection → same throw naming the player (**Review Focus 1**); position-changed → missing; locked without projection stays fixed; locked in ineligible slot → message; kickoff after snapshot → refresh message; 7-day limits); duplicate occupant refuses (§8.12); raw near tie 9.17528 vs 9.17795 orders by raw value (§8.2). `startsitmode_session_fixture.cjs`: anonymous chooses a team → plan with `Viewing …`, then identifies as owner of another roster → owner's plan, viewer label gone (**Review Focus 5**); best ball → no plan, note; settings change on refresh → recomputed plan.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** both fixtures + `node tests/inseason_baseline_fixture.cjs` → PASS.
- [ ] **Step 5: Commit** `feat: start/sit on neutral league views and the exact lineup kernel; viewers; best ball`.

---

### Task 12: Waivers on neutral views and the kernel

Spec §7.1 (both waiver bullets), §7.2, §3.3, §6.2, §8. Review Focus 1, 3. Astra I7, I9, I11. Model: **opus**.

**Files:** Modify `site/assets/waivers.js`, `waivermode.js`, `waiverintel.js`, `site/waivers.html`; tests `waivers_fixture.cjs`, `waivermode_fixture.cjs`, `waivermode_session_fixture.cjs`, `waiverintel_fixture.cjs`; remove the waivers section of `tests/inseason_baseline_fixture.cjs`

Edits to `waivers.js` (by function and condition):
- `const lineupScore = Lineup.lineupScore;` replacing the `ROS.lineupScore` alias; export `__lineupScore` for the fixture.
- `weeklyMap`: delete the `weeklyLeague`/`liveScoring`/`weeklyScoring`/`scoringMatches` locals and the two branches `if (!weeklyLeague || id(weeklyLeague.league_id) !== id(league.league_id)) reason = …` and `else if (!scoringMatches) reason = …`; the season check becomes the first `if`. Keep season/week/age/players and the `invalidTeamIds` logic verbatim.
- `remainingMap`: delete `rl`, `live`, `rs`, `scoringMatches` and the two returns (`…league id does not match live league`, `…scoring contract…`); keep season/start-week/age/payload checks and the per-week loop verbatim.
- `boardPoints(p)` returns `finite(p.ros_value)` only.
- Delete the preseason-proxy paths: the `using preseason proxy` warning; the non-fresh branch of `score` (from `const v = boardPoints(p);` through its `return (v / 17) * …`, so non-fresh `score` returns `null`); `basis` becomes `priced ? "move" : "this_week"`; the `preseason_proxy` source/label and `scoringLabel` alternatives.
- Slot consumers: the module `SLOT_ELIGIBLE` gains `WRRB_FLEX`/`REC_FLEX` from `Formats.AUDIT.slot_eligible`; `slots(league)` returns `Lineup.MODELED` slots in roster order; in the started-player block the modeled index becomes `fullStarterSlots.slice(0, fullIndex + 1).filter(s => Lineup.MODELED.includes(s)).length - 1` and `if (slot !== "K" && slot !== "DEF")` becomes `if (Lineup.MODELED.includes(slot))`; capacity counts `Lineup.UNMODELED` slots as occupied.
- Admission: the transaction collector's gain filter becomes raw `gain >= 0.005` (no rounding first).
- Delete `waiverGateOpen`, `SIM`, `simulateRows`, `simulationCoverageText`, the `simGate`/`simSummary` block and the `availability`/`evalFile` arguments.
- `rolling` = `waiverType === 0 || waiverType === 1`; `waiver.type` = `"rolling"` | `"reverse_standings"` | `"faab"`; reverse-standings guidance names itself and claims no priority rules.
- Keep verbatim: the `owned player projection team does not match current team; refresh projections` **throw** (Review Focus 1), the unknown-contributor **blocked** result, every 72-hour check.

`waivermode.js`: delete `supportedEntry`/`validateContract`; `loadWorld` wraps `LiveWorld` (Task 10); statics = `LeagueData.loadBatch()`, `roles.json`, `kickoffs.json`, `ros-ecr.json` (no draft/remaining/availability/trade_sim_eval files); views per bundle; `hydrateBoard` uses `LeagueData.rosterIdentities` for K/DEF/IDP/unknown occupants; league link from the live league; reserve default `Math.round(0.2 * waiver_budget)` with a `userTyped` flag (reset on league/budget change unless typed); render format line, banner, footnotes, settings stamp, simulation note, horizon + aggregation labels by ROS/"why" values, heuristic labels on the 1-pt weak signal and 2/5-pt bands, `PPR reference ranking` on ECR columns, the ROS evaluation line via `LeagueData.evidenceFor` (else fallback), `Viewing {team}` for viewers (protect boxes and bids owner-only); best ball → projections + note, no shortlist; week 18 → `No projected weeks remain.`, ROS columns disabled. `waiverintel.js`: view's `ecr`, `bye`, `sleeper_id`; keeps PPR-reference wording. `waivers.html`: script tags as in Task 11; reserve label `Budget to keep ($) — default 20% of your league budget`.

- [ ] **Step 1: Tests first.** `waivers_fixture.cjs` (engine): delete contract and simulation/gate cases; add `Waivers.__lineupScore === Lineup.lineupScore`; WRRB_FLEX/REC_FLEX; a started RB after a `DL` slot cancels the right modeled slot; a started REC_FLEX occupant; raw admission 0.004 out / 0.006 in; `ros_value` tie-break; weekly unknown contributor → blocked; ROS unknown member → warning, other weeks count; wrong-team owned player → today's throw (**Review Focus 1**); 72-hour limits; 96-hour weekly + fresh remaining → blocked weekly gains; reverse standings ranked, no bids, labeled; 2-, 4-, 20-, 32-team leagues with complete synthetic rosters (**Review Focus 3**); week 16 and 17 horizons; thresholds either side of 1/2/5 points. `waivermode_fixture.cjs`/`waivermode_session_fixture.cjs` (controller/DOM): reserve default for budgets 0/10/100/exhausted, reset on change, typed override kept; rendered banner/format line/simulation note/aggregation/heuristic/ECR labels/settings stamp; evidence fallback; week-18 copy; best ball; viewer flow; position-changed player hydrated as identity-only.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the four waiver fixtures + `node tests/inseason_baseline_fixture.cjs` → PASS.
- [ ] **Step 5: Commit** `feat: waivers on neutral league views and the lineup kernel; reverse standings; budget-relative reserve; simulation off`.

---

### Task 13: In-season trade on neutral views and the kernel

Spec §7.1 (trade), §7.2, §5.4, §6.2, §8. Review Focus 1. Astra I7, I9, I11. Model: **opus**.

**Files:** Modify `site/assets/seasontrade.js`, `seasontrademode.js`, `site/trade.html`; tests `seasontrade_fixture.cjs`, `seasontrademode_fixture.cjs`; delete `tests/inseason_baseline_fixture.cjs` (captured JSON stays)

Edits to `seasontrade.js` `resolveScenario` (by condition):
- Split `require(String(remaining.league?.league_id)===String(league.league_id)&&league.league_id&&remaining.season===Number(league.season),"Projection league or season mismatch")` into `require(remaining.season===Number(league.season),"Projection season mismatch")`.
- In `if(board)`, split `require(String(board.league?.league_id)===String(league.league_id)&&board.season===remaining.season&&Array.isArray(board.players),…)` into `require(board.season===remaining.season&&Array.isArray(board.players),"Identity board season mismatch")`; keep the rest of the block verbatim.
- Delete only the scoring-contract block: `const expected=remaining.league?.sleeper_scoring,live=league.scoring_settings;`, its `"Scoring contract missing"` require and the `"Scoring mismatch"` loop. Keep the current-week require, the 72-hour/future-date require and everything else.
- Slot whitelist → `league.roster_positions.every(s=>eligible[s]||["BN","IR","TAXI"].includes(s)||Lineup.UNMODELED.includes(s))` else `Unsupported roster slots`; `eligible` gains `WRRB_FLEX`/`REC_FLEX`.
- In `resolve`, `if (["K","DEF"].includes(c.position)) return null;` → `if (Lineup.UNMODELED_POSITIONS.includes(c.position)) return null;`.
- The solver calls (`ROS.bestLineup` in the before/after lineup computation) → `Lineup.bestLineup`; `asLineup` stays as the validator.

`seasontrademode.js`: delete `pickOwnership`, the `traded_picks` fetch, pick rows and `picksUnknown` notes; delete `evalView`/gate and the `trade_sim_eval.json` fetch; in `preflight` delete the `remaining.league` league-id check (keep season, regular-season state, week alignment, end-week, catalog checks); `remaining`/`board` from `LeagueData.views` per bundle; read `league` from each committed bundle (no closure copy) and recompute on settings change; gate `load`/`sync` on `analysisRoster` (owner or viewer), destructuring it instead of `myRoster`; `renderWarn` uses `LeagueData.evidenceFor` (else fallback); render format line, banner, footnotes, settings stamp, simulation note, aggregation label; best ball → projections + note; week 18 → `No projected weeks remain.`. `trade.html`: resolve mode first via `Session.ready({leagueId})` and the bundle's `league.status`; only `pre_draft` **and** the registered Gabagool league loads `draft.json` and runs `TradeMode` as today; `in_season` never fetches draft data; other states keep today's message.

- [ ] **Step 1: Tests first.** `seasontrade_fixture.cjs` (engine): delete league-id/scoring contract cases; independent failures for bad week, wrong season, future-dated remaining, > 72 h remaining, roster snapshot > 60 s; a contract-free view passes; SUPER_FLEX/WRRB_FLEX/REC_FLEX/IDP leagues (a rostered `LB` returns null, not `Unknown roster player position`); unknown slot → `Unsupported roster slots`; current week skipped; declared bye → 0; user-excluded week → 0; `OUT` tag → warning only, still scored; a projected p50 of exactly 0 stays 0; missing coverage → refusal; wrong-team → `Missing projection or current-team mismatch` (**Review Focus 1**). `seasontrademode_fixture.cjs` (controller/DOM): no pick rows and no `traded_picks` request; no `trade_sim_eval.json` request; week-18 copy; best ball; viewer flow; settings change recomputes; the in-season page never requests `draft.json` (stub fetch log).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `node tests/seasontrade_fixture.cjs && node tests/seasontrademode_fixture.cjs && node tests/trademode_fixture.cjs` → PASS.
- [ ] **Step 5: Commit** `feat: in-season trade on neutral league views and the lineup kernel; mode-first trade page; no future picks; simulation off`.

---

### Task 14: Scoped historical evidence and docs

Spec §3.2, §8.9, §6.2.

**Files:** Modify `site/about.html`, `docs/remaining-season-projections.md`, `README.md` (only if it calls the in-season pages Gabagool/FAM-only); `tests/interface_hierarchy_fixture.cjs`, `tests/shared_assets_fixture.cjs` (script-tag expectations only)

- [ ] **Step 1:** About page: a "Measured results and their scope" section rendering each `neutral/evaluation.json` record with source league, prediction vs realized scoring and omissions (e.g. "pick-six penalties excluded from outcomes"), method (or "method not recorded"), population and horizon — labeled historical. Remove or rescope every remaining unqualified current-output claim on the page (grep "MAE", "%", "calibrat"). Replace the v1 gate paragraph with the simulation note.
- [ ] **Step 2:** `docs/remaining-season-projections.md`: "League-neutral data (phase 1)" — files, schema versions, `batch_id`, horizon and aggregation labels, commit-boundary publication, coexistence and retirement (spec §10).
- [ ] **Step 3:** Run the two structure fixtures → PASS. **Step 4: Commit** `docs: scoped historical evidence on the about page; neutral data documentation`.

---

### Task 15: End-to-end verification (controller)

Spec §9.1, §9.4, §9.12, §3.3. Astra B3, I10, P4.

- [ ] **Step 1: Local batch.** `.venv/Scripts/python.exe -m ffmodel.site.batch --out .review/e2e/stage --model transformer --season 2026 --week auto --leagues gabagool,fam --artifact-root models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44 --debug-full-precision .review/e2e/full.json` (detached), then `python -m ffmodel.site.publish --stage .review/e2e/stage --out .review/e2e/published`. Also `--week 1` into `.review/e2e-wk1/` (full universe, full horizon) to measure `neutral/remaining.json`; write `tests/fixtures/neutral_size_measurement.json` (`{week:1, bytes, players, weeks}`), set `SIZE_CAP_BYTES`, run the cap test; commit both.
- [ ] **Step 2: Serialization parity.** In node, score every player-week of the staged `neutral/remaining.json` (4-dp arrays) with `LeagueLens.score` for Gabagool and FAM; in Python, score the matching unrounded blocks from `full.json` with `reference_score`; assert `|diff| ≤ 0.00005 × Σ|effective weight|` per endpoint. Separately: JS vs Python on identical published inputs ≤ 1e-9; weekly (full precision) ≤ 1e-9. Report maxima.
- [ ] **Step 3: Baseline ledger on the same snapshot.** Convert `tests/fixtures/inseason_baseline/snapshot.json` into neutral payloads (Task 5 row format: 4-dp arrays, shared `batch_id`, `players.json` from the snapshot universe) and run the **real** `LeagueData.views` + new analyzers with `scenarios.json`'s arguments (views replace `board/weekly/remaining`; everything else identical). Diff against `outputs_*.json`; every difference must cite a spec §8 item; write `.superpowers/sdd/2026-10-04-any-league-inseason/baseline-ledger.md`. An unmapped difference is a bug → fix task. Coverage expansion (§8.4) is checked separately on the e2e batch: list players newly scorable and players made identity-only, with reasons.
- [ ] **Step 4: Full suites.** `.venv/Scripts/python.exe -m pytest -q` and every `node tests/*_fixture.cjs` → all PASS.
- [ ] **Step 5: Browser** (local static server over a scratch copy of `site/` with `.review/e2e/published` as its data — never committed): Gabagool and FAM end to end on weekly, waivers, trade as owner, numbers equal the legacy pages except §8 items; anonymous viewing; one public superflex and one best-ball league by id; league switch mid-load; refresh with unchanged and changed settings (local stub).
- [ ] **Step 6:** Final whole-branch review (opus), astra branch review (`codex exec -m gpt-6-astra`), then the owner decides merge timing (only after `prospective-2026-o5` exists). Coexistence observation, the rollback rehearsal and legacy retirement (spec §10) are post-merge, owner-approved steps outside this plan.

---

## Revision 2 trace (astra plan review)

| Finding | Resolution |
|---|---|
| B1 rounded kernel objective | Task 4: BigInt exact scores at a common power-of-two scale, keep multiplier from open-slot count, no ceiling; exact independent oracle; sub-micro and zero-vs-tiny cases |
| B2 `os.replace` dir swap | Task 7: empty stage + manifest; validate then copy; the commit step is the boundary; no atomicity claim |
| B3 baseline can't support ledger | Task 1: one full-precision snapshot feeds legacy shapes now and neutral payloads in Task 15; real `LeagueData.views`; coverage checked separately |
| I1 baseline pins errors | Task 1: controller hydration, deterministic legal coverage-complete rosters, saved scenarios, fixed clock, success assertions |
| I2 wrong test expectations | Task 2 TE/WR/QB include `passing_yards`; Task 4 expects `[B,A]`; oracle covers fixed/unmodeled; Python compares full tables |
| I3 validation contract | Task 3: identical finite/paired-band/order/overflow checks in both languages; `plain` total over finite doubles |
| I4 batch context / snapshot | Tasks 5, 7: `BatchContext`, one process, one pull/fit, shared headers, manifest of this-run files; browser rejects mixed batches (Task 8) |
| I5 identity precedence / live revalidation | Task 5 rules; Task 8 live position revalidation, team kept for existing guards; cache-expiry test |
| I6 method / close-call scope | Task 6: `current_method`, realized vs prediction scoring, internal-key translation, null methods never match; Task 8 structural match |
| I7 stale line refs | Tasks 12, 13: edits by function/condition; controller `remaining.league` gate removed; independent safety-check regressions |
| I8 anonymous viewing / shared helper | Task 9 analysis roster; Task 10 `LiveWorld` before Tasks 11–13; controller viewer flows |
| I9 non-solver slot consumers | Task 4 modeled-only adapters; Task 12 index mapping/eligibility; Task 13 `UNMODELED_POSITIONS`; wrong-team throw preserved |
| I10 parity on rounded inputs | Task 5 `full_precision_out` + fixed-clock byte test; Task 15 bound vs unrounded blocks; durable size measurement |
| I11 missing requirements / test placement | League types (8, 10), settings stamp + recompute (9, 11–13), heuristic/aggregation/ECR labels (11–12), reference lenses in views (8), waiver evidence binding (12), week 16 (12), 2-team (12), Global Constraints test placement |
