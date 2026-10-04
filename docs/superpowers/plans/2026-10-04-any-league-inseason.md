# Any Sleeper League — Phase 1 (In-Season Pages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any Sleeper league gets working start/sit, waivers and in-season trade comparison, scored in the browser by its own live settings from one league-neutral data batch, with Gabagool and FAM on the same path.

**Architecture:** Actions publishes a league-neutral batch (`site/data/neutral/{weekly,remaining,players,evaluation}.json`) atomically alongside the legacy per-league files during coexistence. In the browser, `leaguelens.js` turns a live league's `scoring_settings` into per-position stat weights, `leaguedata.js` turns the neutral batch into league-scored *views* in the shapes the existing analyzers already read (`weekly`-, `remaining`- and `board`-like), and `lineup.js` replaces both lineup solvers for the three pages. The analyzers lose their league-contract checks and keep every caller policy. `rostersim.js` and `ROS.bestLineup` are untouched (frozen method).

**Tech Stack:** Python 3.12 (pandas, pytest) under `src/ffmodel/`; vanilla JS UMD modules under `site/assets/` tested by `node tests/*_fixture.cjs`; GitHub Actions `weekly-update.yml`.

**Spec:** `docs/superpowers/specs/2026-10-01-any-league-inseason-design.md` (draft 4; astra READY FOR PLAN; owner-approved 2026-10-04). Executors read the spec section each task cites. Astra plan-level items P1–P4 (`.review/astra-anyleague-spec-recheck2-response.md` §4) are folded into Tasks 2, 4, 6 and 14.

## Global Constraints

- Branch `feat/any-league-inseason`. **Never merge to `main` before the `prospective-2026-o5` tag exists** (spec §10). Never push without the owner's OK.
- Do not modify: `.github/workflows/prospective-*.yml`, `tools/select_outcome_tag.py`, `tools/prospective_*.cjs`, `src/ffmodel/prospective/**`, `site/assets/rostersim.js`, `site/assets/ros.js` (spec §2).
- Do not change the frozen format fingerprint: `site/assets/formats.js` / `src/ffmodel/formats.py` canonicalization, `describeSleeper`, `match` (spec §6.1, §3.2).
- Phase-1 pages make **no simulation calls** and publish **no gate file** (spec §6.2, §7.1).
- Caller policies (start/sit, weekly waivers, ROS waivers, trade) are preserved exactly as spec §7.1 lists; any deviation must be one of spec §8's 13 items.
- Age limits per caller, exactly as today: start/sit weekly + kickoffs ≤ 7 days; waivers weekly, kickoffs, remaining ≤ 72 h; trade remaining ≤ 72 h; existing future-timestamp and roster-snapshot checks stay (spec §5.3).
- Comparisons use raw (unrounded) scores; rounding only at display; waiver admission = raw weekly gain ≥ 0.005 (spec §3.3).
- Horizon: NFL weeks `start_week`..17, labeled "through NFL week 17, regardless of your league's schedule"; empty `remaining.json` with `status: "no_remaining_weeks"` when `start_week > 17` (spec §3.3).
- No other managers' data in the repo: league fixtures are synthetic in Sleeper's response shape (spec §9.11).
- Python tests: `.venv/Scripts/python.exe -m pytest` (Windows) / `python -m pytest` (CI). JS tests: `node tests/<name>_fixture.cjs`. In a git worktree set `PYTHONPATH=<worktree>/src` (editable-install trap).
- Exact copy strings (use verbatim):
  - banner: `Your league also scores {categories}, which these projections leave out; rankings may be off for your league.`
  - pick-six footnote: `Pick-sixes use an average rate, not a forecast.`
  - rare-event footnote: `Not projected: {categories} (rare events).`
  - evidence fallback: `No measured evaluation for your league's scoring and this model.`
  - format line, in test: `Format: {description} — in the 2026 format test (results January 2027)`; not in test: `Format: not in the format test`; best ball: `Best ball — not eligible for the format test`
  - simulation note: `Simulation is off: the 2025-season test failed (on synthetic 15-player rosters), and the per-format 2026 test reports in January 2027.`
  - best-ball advice note: `Best-ball scoring picks your top scorers after the games; lineup advice doesn't apply.`
  - horizon label: `through NFL week 17, regardless of your league's schedule`
  - stale end state: `No projected weeks remain.`
  - anonymous viewing: `Viewing {team name}` (never "your roster" for a non-owner view)

## Review Focus

Spec-implied inputs no task's main tests exercise, most likely first. Each has a test added to the owning task.

1. **A rostered player traded to another NFL team after the batch was generated** (catalog team ≠ projection team): start/sit must refuse naming the player ("missing current-team weekly projection"), waivers must block weekly gains, never score him for the old team. → Task 10 step, Task 11 step.
2. **A pasted league id that does not exist, or last season's league id**: a plain "Sleeper has no league with id …" / "This league is from the {season} season; projections are for {current}" message, never a crash or a stale page. → Task 9 step.
3. **Unusual team counts (2, 4, 20, 32 teams)**: nothing assumes 10 or 12 teams (waiver pool sizing, roster completeness). → Task 11 step.
4. **A league whose only nonzero offensive keys are bonuses we omit plus one predicted stat at a strange weight** (e.g. `pass_yd 0.05, rec 0.25, bonus_fd_wr 0.5`): scores exactly what it can, banners the rest, never refuses. → Task 3 step.
5. **Anonymous viewer chooses a team, then identifies as the owner of a different team**: the page switches to the owner's roster and says "your roster"; the viewed selection is dropped, not merged. → Task 9 step.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `tests/fixtures/inseason_baseline/*.json`, `tools/capture_inseason_baseline.cjs` | Frozen offline snapshot of today's analyzer outputs on synthetic Gabagool/FAM worlds | 1 |
| `site/assets/leaguelens.js` | Key classification, effective per-position weights, evidence identity (JS) | 2, 3 |
| `src/ffmodel/site/leaguelens.py` | Python twin: classification table, effective weights, evidence identity, reference scorer | 2, 3 |
| `tests/leaguelens_fixture.cjs`, `tests/test_leaguelens.py`, `tests/fixtures/leaguelens_parity.json` | Cross-language parity | 2, 3 |
| `site/assets/lineup.js`, `tests/lineup_fixture.cjs` | Exact lexicographic lineup kernel + `lineupScore`/`bestLineup` adapters | 4 |
| `src/ffmodel/site/neutral.py`, `src/ffmodel/site/remaining.py` (modify) | Neutral weekly/remaining/players builders | 5 |
| `src/ffmodel/site/evidence_records.py` | `evaluation.json` records with effective scoring + method | 6 |
| `src/ffmodel/site/generate.py` (modify), `src/ffmodel/site/publish.py`, `.github/workflows/weekly-update.yml` (modify) | Staged batch, validation, size cap, promotion | 7 |
| `site/assets/leaguedata.js`, `tests/leaguedata_fixture.cjs` | Neutral batch → league-scored views, roster identities, format line, eligibility, evidence lookup | 8 |
| `site/assets/session.js`, `site/assets/app.js`, `site/assets/connect.js` (modify) | League-id flow, anonymous bootstrap + team viewing, live settings refetch, navigation boundary | 9 |
| `site/assets/startsit.js`, `startsitmode.js`, `site/weekly.html` (modify) | Start/sit on views + kernel | 10 |
| `site/assets/waivers.js`, `waivermode.js`, `waiverintel.js`, `site/waivers.html` (modify) | Waivers on views + kernel | 11 |
| `site/assets/seasontrade.js`, `seasontrademode.js`, `site/trade.html` (modify) | Trade on views + kernel, mode-first | 12 |
| `site/about.html`, `docs/remaining-season-projections.md` (modify) | Historical evidence with scope | 13 |
| (no new files) | Local end-to-end generation, full-file parity, baseline diff ledger, browser checks | 14 |

Tasks run **sequentially** (shared files and interfaces). Model guidance per CLAUDE.md: Tasks 2, 4 → `sonnet` (complete code given); Tasks 1, 3, 5, 7 → `sonnet`; Tasks 6, 8, 9, 10, 11, 12 → `opus` (prose-specified migrations of large files); Task 13 → `sonnet`; Task 14 → controller.

---

### Task 1: Capture today's in-season outputs as an offline baseline

Spec §9.4. Must run on **unchanged** analyzers, before any other task.

**Files:**
- Create: `tools/capture_inseason_baseline.cjs`
- Create: `tests/fixtures/inseason_baseline/inputs_{gabagool,fam}.json`, `tests/fixtures/inseason_baseline/outputs_{gabagool,fam}.json`
- Create: `tests/inseason_baseline_fixture.cjs`

**Interfaces:**
- Produces: `inputs_<slug>.json` = `{slug, board, weekly, remaining, kickoffs, league, rosters, catalog, transactions, now, snapshotAt, week}`; `outputs_<slug>.json` = `{startsit, waivers, trade}` where each is the analyzer's return value (or `{error: message}`), JSON-serialised with `Infinity` → `"Infinity"`.
- Consumed by Task 14's diff ledger.

- [ ] **Step 1: Build synthetic worlds from committed data.** The script reads `site/data/draft.json` + `weekly.json` + `remaining-gabagool.json` (Gabagool) and `draft-fam.json` + `weekly-fam.json` + `remaining-fam.json` (FAM), and `site/data/kickoffs.json`. It builds, deterministically (seeded `mulberry32(20261004)`, no network):
  - `league`: `{league_id: board.league.league_id, season: String(board.season), status: "in_season", total_rosters: teams, roster_positions: <from tests/fixtures/owner_league_settings.json for that slug>, scoring_settings: weekly.league.sleeper_scoring, settings: {waiver_type: <2 gabagool, 0 fam>, waiver_budget: 100}}`.
  - `rosters`: `teams` rosters; roster `i` gets a snake draft from the board's top `teams × 13` players by `ecr` (13 offensive spots), starters = best legal lineup by board order, `reserve: []`, `taxi: []`, `owner_id: "u<i>"`, `settings: {waiver_budget_used: 10, waiver_position: i}`; roster 1 is "mine".
  - `catalog`: for every board player with `sleeper_id`: `{full_name: name, position, team, injury_status: null}`; plus one synthetic `K` and `DEF` per roster.
  - `transactions: []`; `week = weekly.week`; `now = Date.parse(weekly.generated_at) + 3600000`; `snapshotAt = now - 1000`.
  - Trim `board.players`, `weekly.players`, `remaining.players` to rostered players ∪ the 150 highest-`p50` unrostered weekly players (keeps fixtures small). Keep every top-level field.
- [ ] **Step 2: Run the three analyzers exactly as their controllers do.** `StartSit.analyze({board, weekly, league, roster: mine, catalog, kickoffs, now, snapshotAt})`; `Waivers.analyze({board, league, rosters, rosterId: 1, transactions, weekly, kickoffs, snapshotAt, now, remaining, week, protectedIds: mine.starters, budgetReserve: 20, availability: null, evalFile: null})`; `SeasonTrade.analyze(...)` for a fixed 1-for-1 trade between roster 1 and roster 2 (each side's best bench player by board order), `assumeAvailable: true`, `currentWeek: week`. Read the existing fixtures `tests/startsit_fixture.cjs`, `tests/waivers_fixture.cjs`, `tests/seasontrade_fixture.cjs` for the exact argument shapes; wrap each call in try/catch → `{error}`.
- [ ] **Step 3: Write inputs and outputs** to `tests/fixtures/inseason_baseline/` (pretty JSON, sorted keys).
- [ ] **Step 4: Write `tests/inseason_baseline_fixture.cjs`** that re-runs Step 2 on the committed inputs and asserts deep equality with the committed outputs (so the baseline is reproducible on the current code). Run: `node tests/inseason_baseline_fixture.cjs` → PASS.
- [ ] **Step 5: Commit.**
```bash
git add tools/capture_inseason_baseline.cjs tests/fixtures/inseason_baseline tests/inseason_baseline_fixture.cjs
git commit -m "test: capture offline baseline of today's in-season analyzer outputs (any-league phase 1)"
```
Later tasks **delete** `tests/inseason_baseline_fixture.cjs` in the task that changes the analyzer it pins (10, 11, 12), never the captured JSON.

---

### Task 2: League lens core — classification, effective weights, evidence identity (JS + Python twin)

Spec §4, §3.2. Astra P1.

**Files:**
- Create: `site/assets/leaguelens.js`, `src/ffmodel/site/leaguelens.py`
- Create: `tests/leaguelens_fixture.cjs`, `tests/test_leaguelens.py`

**Interfaces:**
- Produces (JS, `window.LeagueLens` / `module.exports`): `classify(scoring) → {weights, approx, rare, recurring, ignored, unknown, refused, disclosures}`; `effectiveWeights(scoring) → {QB:{stat:w}, RB:{…}, WR:{…}, TE:{…}}` (zero weights omitted); `plain(x) → string`; `evidenceIdentity(weights) → string`; `STATS` (12 stat names in published order); `KEYS` (the table below).
- Produces (Python `ffmodel.site.leaguelens`): `effective_weights(scoring) -> dict`, `plain(x) -> str`, `evidence_identity(weights) -> str`, `KEYS`, `STATS`, `classify(scoring) -> dict` — same semantics.

- [ ] **Step 1: Write the failing JS test** `tests/leaguelens_fixture.cjs`:
```js
const assert = require("assert");
const L = require("../site/assets/leaguelens.js");
const gab = require("./fixtures/owner_league_settings.json").gabagool.scoring_settings;
// plain(): shortest round-trip, exponent-free, -0 -> 0
assert.strictEqual(L.plain(0.04), "0.04");
assert.strictEqual(L.plain(0.0400001), "0.0400001");
assert.strictEqual(L.plain(6), "6");
assert.strictEqual(L.plain(-0), "0");
assert.strictEqual(L.plain(1e-7), "0.0000001");
assert.strictEqual(L.plain(-2.5), "-2.5");
assert.throws(() => L.plain(1e7)); assert.throws(() => L.plain(NaN)); assert.throws(() => L.plain("1"));
// weights combine per (position, stat)
const w = L.effectiveWeights({ rec: -1, bonus_rec_te: 2, pass_yd: 0.04 });
assert.deepStrictEqual(w.TE, { receptions: 1 });
assert.deepStrictEqual(w.WR, { receptions: -1 });
assert.strictEqual(w.QB.passing_yards, 0.04);
const z = L.effectiveWeights({ rec: 1, bonus_rec_wr: -1 });
assert.ok(!("receptions" in z.WR), "cancelled weight omitted");
// evidence identity distinguishes 0.04 vs 0.0400001 (frozen 6-dp fingerprint does not)
assert.notStrictEqual(L.evidenceIdentity(L.effectiveWeights({ pass_yd: 0.04 })), L.evidenceIdentity(L.effectiveWeights({ pass_yd: 0.0400001 })));
// classification
const c = L.classify(gab);
assert.deepStrictEqual(c.recurring, []);
assert.deepStrictEqual(c.rare.sort(), ["fum_rec_td", "pass_2pt", "pass_td_50p", "rec_2pt", "rec_td_50p", "rush_2pt", "rush_td_50p", "st_td"]);
assert.ok(c.approx.includes("pass_int_td"));
assert.strictEqual(c.refused, false);
const big = L.classify({ pass_yd: 0.04, rec_2pt: 3 });       // 2-pt above bound -> banner
assert.ok(big.recurring.includes("rec_2pt"));
const fd = L.classify({ rec: 1, bonus_fd_wr: 0.5, fum: -1, zzz_new: 1 });
assert.deepStrictEqual(fd.recurring.sort(), ["bonus_fd_wr", "fum", "zzz_new"]);
assert.ok(L.classify({ fgm_yds: 0.1, def_td: 6 }).refused, "no predicted stat -> refused");
assert.ok(L.classify({ bonus_rush_td_qb: 2, pass_yd: 0.04 }).recurring.includes("bonus_rush_td_qb"));
assert.throws(() => L.classify({ pass_yd: "x" }));
console.log("leaguelens_fixture: ok");
```
Note: `tests/fixtures/owner_league_settings.json` must contain each league's `scoring_settings`; if it does not (check with `python -c "import json;print(json.load(open('tests/fixtures/owner_league_settings.json'))['gabagool'].keys())"`), use `site/data/weekly.json`'s `league.sleeper_scoring` instead.
- [ ] **Step 2: Run it** — `node tests/leaguelens_fixture.cjs` → FAIL (`Cannot find module`).
- [ ] **Step 3: Implement `site/assets/leaguelens.js`:**
```js
/* League lens: classify a Sleeper league's scoring_settings against what the
   model predicts, and combine weights per (scoring position, stat). Spec
   docs/superpowers/specs/2026-10-01-any-league-inseason-design.md §4, §3.2.
   The KEYS/RARE/RECURRING tables are duplicated in src/ffmodel/site/leaguelens.py;
   tests/test_leaguelens.py asserts the two are identical. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LeagueLens = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";
  const Formats = (typeof module !== "undefined" && module.exports) ? require("./formats.js") : root.Formats;
  const POSITIONS = ["QB", "RB", "WR", "TE"];
  const STATS = ["passing_yards", "passing_tds", "passing_interceptions", "carries", "rushing_yards",
    "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds", "fumbles_lost", "passing_pick_sixes"];
  // key -> [stat, positions]; positions null = every position.
  const KEYS = Object.freeze({
    pass_yd: ["passing_yards", null], pass_td: ["passing_tds", null], pass_int: ["passing_interceptions", null],
    pass_int_td: ["passing_pick_sixes", null], rush_yd: ["rushing_yards", null], rush_td: ["rushing_tds", null],
    rush_att: ["carries", null], rec: ["receptions", null], rec_yd: ["receiving_yards", null],
    rec_td: ["receiving_tds", null], fum_lost: ["fumbles_lost", null],
    bonus_rec_te: ["receptions", ["TE"]], bonus_rec_rb: ["receptions", ["RB"]], bonus_rec_wr: ["receptions", ["WR"]],
  });
  const APPROX = Object.freeze(["pass_int_td"]);
  // rare-event key -> max |weight| for a footnote; above it the key banners.
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

  function weightOf(k, v) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Invalid scoring weight: ${k}`);
    return v;
  }
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
    for (const pos of POSITIONS) for (const s of Object.keys(out[pos])) if (out[pos][s] === 0) delete out[pos][s];
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
  function plain(x) {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error("weight must be a finite number");
    if (x === 0) return "0";
    const a = Math.abs(x);
    if (a < 1e-9 || a > 1e6) throw new Error("weight outside the supported domain");
    let s = String(a), m = s, e = 0;
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
  // Versioned, lossless identity of effective weights (spec §3.2). Byte-identical
  // to leaguelens.py evidence_identity().
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
- [ ] **Step 5: Write the failing Python test** `tests/test_leaguelens.py`:
```python
import json, re, subprocess
from pathlib import Path
import pytest
from ffmodel.site import leaguelens as L

JS = Path("site/assets/leaguelens.js").read_text(encoding="utf-8")

def test_plain_matches_js_cases():
    assert L.plain(0.04) == "0.04" and L.plain(0.0400001) == "0.0400001"
    assert L.plain(6) == "6" and L.plain(-0.0) == "0" and L.plain(1e-7) == "0.0000001"
    assert L.plain(-2.5) == "-2.5"
    for bad in (1e7, float("nan"), "1", True):
        with pytest.raises(ValueError):
            L.plain(bad)

def test_tables_match_js():
    # The JS tables are the frozen copy; parse their keys from the source.
    js_keys = {k for k, _ in re.findall(r"(\w+): \[\"(\w+)\", (?:null|\[)", JS)}
    assert js_keys == set(L.KEYS)
    js_rec = set(re.findall(r'"(\w+)"', JS.split("const RECURRING")[1].split("]);")[0]))
    assert js_rec == set(L.RECURRING)

def test_identity_byte_equal_to_js():
    cases = [{"pass_yd": 0.04, "rec": -1, "bonus_rec_te": 2}, {"pass_yd": 0.0400001}, {"rush_att": 0.1, "pass_int_td": -3}]
    script = ("const L=require('./site/assets/leaguelens.js');"
              "const cs=JSON.parse(process.argv[1]);"
              "console.log(JSON.stringify(cs.map(c=>L.evidenceIdentity(L.effectiveWeights(c)))));")
    out = subprocess.run(["node", "-e", script, json.dumps(cases)], capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == [L.evidence_identity(L.effective_weights(c)) for c in cases]

def test_classify_owner_league():
    gab = json.loads(Path("site/data/weekly.json").read_text())["league"]["sleeper_scoring"]
    c = L.classify(gab)
    assert c["recurring"] == [] and "pass_int_td" in c["approx"] and not c["refused"]
```
- [ ] **Step 6: Run** `.venv/Scripts/python.exe -m pytest tests/test_leaguelens.py -q` → FAIL (`No module named ffmodel.site.leaguelens`).
- [ ] **Step 7: Implement `src/ffmodel/site/leaguelens.py`:**
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


def _weight(k, v) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError(f"Invalid scoring weight: {k}")
    return float(v)


def effective_weights(scoring: dict) -> dict:
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
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        raise ValueError("weight must be a finite number")
    x = float(x)
    if x == 0:
        return "0"
    if not 1e-9 <= abs(x) <= 1e6:
        raise ValueError("weight outside the supported domain")
    return format(Decimal(repr(x)).normalize(), "f")


def evidence_identity(weights: dict) -> str:
    parts = []
    for pos in POSITIONS:
        ws = weights.get(pos, {})
        inner = ",".join(json.dumps(s) + ":" + json.dumps(plain(ws[s])) for s in sorted(ws))
        parts.append(json.dumps(pos) + ":{" + inner + "}")
    return '{"v":1,"w":{' + ",".join(parts) + "}}"
```
Confirm `ffmodel.formats` exposes `AUDIT` with keys `ignore_exact` and `ignore_patterns` (`grep -n "AUDIT" src/ffmodel/formats.py`); if it is named differently, import the real name — do not duplicate the lists.
- [ ] **Step 8: Run** both tests → PASS. Also run `node tests/formats_fixture.cjs` (unchanged, must still pass).
- [ ] **Step 9: Commit.**
```bash
git add site/assets/leaguelens.js src/ffmodel/site/leaguelens.py tests/leaguelens_fixture.cjs tests/test_leaguelens.py
git commit -m "feat: league lens core - scoring classification, per-position weights, lossless evidence identity (JS+Python twin)"
```

---

### Task 3: League lens scoring, disclosures, and the parity fixture

Spec §4, §3.3, §9.1. Review Focus 4.

**Files:**
- Modify: `site/assets/leaguelens.js` (add `score`, `disclosures`), `src/ffmodel/site/leaguelens.py` (add `reference_score`)
- Create: `tools/make_leaguelens_parity.py`, `tests/fixtures/leaguelens_parity.json`
- Modify: `tests/leaguelens_fixture.cjs`, `tests/test_leaguelens.py`

**Interfaces:**
- Produces JS: `score(statQuantiles, position, weights) → {p10, p50, p90}` (p10/p90 `null` when the input bands are null); throws on a missing/non-finite needed stat or unknown position; checks overflow. `disclosures(classification) → {banner: string|null, footnotes: string[]}` using the Global Constraints copy, categories joined with ", " in the order they appear in the settings object.
- Produces Python: `reference_score(stat_quantiles, position, weights) -> dict` (independent of `ffmodel.scoring.ScoringRules`).

- [ ] **Step 1: Failing JS tests** appended to `tests/leaguelens_fixture.cjs`:
```js
const q = { p10: { receptions: 2 }, p50: { receptions: 5 }, p90: { receptions: 8 } };
assert.deepStrictEqual(L.score(q, "TE", L.effectiveWeights({ rec: -1, bonus_rec_te: 2 })), { p10: 2, p50: 5, p90: 8 });
assert.deepStrictEqual(L.score(q, "WR", L.effectiveWeights({ rec: -1, bonus_rec_te: 2 })), { p10: -8, p50: -5, p90: -2 });
assert.deepStrictEqual(L.score({ p10: null, p50: { receptions: 5 }, p90: null }, "WR", L.effectiveWeights({ rec: 1 })), { p10: null, p50: 5, p90: null });
assert.throws(() => L.score({ p10: {}, p50: {}, p90: {} }, "WR", L.effectiveWeights({ rec: 1 })), /receptions/);
assert.throws(() => L.score(q, "K", L.effectiveWeights({ rec: 1 })));
// a position with no nonzero weights scores a known zero, not an error
assert.deepStrictEqual(L.score(q, "QB", L.effectiveWeights({ bonus_rec_te: 1 })), { p10: 0, p50: 0, p90: 0 });
// disclosures (Review Focus 4: strange weights + omitted bonus never refuse)
const odd = L.classify({ pass_yd: 0.05, rec: 0.25, bonus_fd_wr: 0.5 });
assert.strictEqual(odd.refused, false);
assert.strictEqual(L.disclosures(odd).banner, "Your league also scores bonus_fd_wr, which these projections leave out; rankings may be off for your league.");
const gabD = L.disclosures(L.classify(gab));
assert.strictEqual(gabD.banner, null);
assert.ok(gabD.footnotes.includes("Pick-sixes use an average rate, not a forecast."));
assert.ok(gabD.footnotes.some(f => f.startsWith("Not projected: ") && f.endsWith(" (rare events).")));
// parity with the Python reference on the committed fixture
const P = require("./fixtures/leaguelens_parity.json");
for (const c of P.cases) {
  const got = L.score(c.stat_quantiles, c.position, L.effectiveWeights(c.scoring));
  for (const k of ["p10", "p50", "p90"]) {
    if (c.expected[k] === null) assert.strictEqual(got[k], null);
    else assert.ok(Math.abs(got[k] - c.expected[k]) <= 1e-9, `${c.name} ${k}`);
  }
}
```
- [ ] **Step 2: Run** → FAIL (`L.score is not a function`).
- [ ] **Step 3: Implement** in `leaguelens.js` (export both):
```js
  function score(sq, position, weights) {
    if (!POSITIONS.includes(position)) throw new Error(`Unsupported scoring position: ${position}`);
    if (!sq || !sq.p50) throw new Error("Incomplete stat quantiles.");
    const bands = sq.p10 != null && sq.p90 != null;
    if ((sq.p10 == null) !== (sq.p90 == null)) throw new Error("Incomplete stat quantiles.");
    const out = { p10: bands ? 0 : null, p50: 0, p90: bands ? 0 : null };
    const val = (q, stat) => {
      const v = sq[q][stat];
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Missing or invalid ${q} stat: ${stat}`);
      return v;
    };
    for (const [stat, w] of Object.entries(weights[position] || {})) {
      out.p50 += w * val("p50", stat);
      if (bands) {
        const lo = w * val("p10", stat), hi = w * val("p90", stat);
        out.p10 += Math.min(lo, hi); out.p90 += Math.max(lo, hi);
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
Keep the key names in the copy as Sleeper's keys (no friendly-name table in phase 1).
- [ ] **Step 4: Python reference + fixture generator.** Add to `leaguelens.py`:
```python
def reference_score(sq: dict, position: str, weights: dict) -> dict:
    if position not in POSITIONS:
        raise ValueError(f"Unsupported scoring position: {position}")
    bands = sq.get("p10") is not None and sq.get("p90") is not None
    out = {"p10": 0.0 if bands else None, "p50": 0.0, "p90": 0.0 if bands else None}
    for stat, w in weights.get(position, {}).items():
        out["p50"] += w * float(sq["p50"][stat])
        if bands:
            lo, hi = w * float(sq["p10"][stat]), w * float(sq["p90"][stat])
            out["p10"] += min(lo, hi)
            out["p90"] += max(lo, hi)
    return out
```
Create `tools/make_leaguelens_parity.py`: loads the first 40 players of `site/data/weekly.json` (their `stat_quantiles`, `position`) and crosses them with four scorings — Gabagool's `league.sleeper_scoring`, FAM's (`weekly-fam.json`), `{"pass_yd":0.05,"rec":0.5,"bonus_rec_te":0.5,"rush_att":0.1,"pass_int_td":-2}`, and `{"rec":-1,"bonus_rec_te":2,"pass_td":4}` — writing `{"cases":[{name, position, scoring, stat_quantiles, expected}]}` with `expected = reference_score(...)` at full precision to `tests/fixtures/leaguelens_parity.json`.
- [ ] **Step 5: Pin the fixture to the reference** in `tests/test_leaguelens.py`:
```python
def test_parity_fixture_reproducible():
    data = json.loads(Path("tests/fixtures/leaguelens_parity.json").read_text())
    assert len(data["cases"]) == 160
    for c in data["cases"]:
        got = L.reference_score(c["stat_quantiles"], c["position"], L.effective_weights(c["scoring"]))
        assert got == c["expected"], c["name"]

def test_reference_matches_published_league_points():
    w = json.loads(Path("site/data/weekly.json").read_text())
    weights = L.effective_weights(w["league"]["sleeper_scoring"])
    for p in w["players"]:
        got = L.reference_score(p["stat_quantiles"], p["position"], weights)
        for k in ("p10", "p50", "p90"):
            assert abs(got[k] - p["points"]["league"][k]) <= 0.005 + 1e-9, (p["name"], k)
```
- [ ] **Step 6: Run** `python tools/make_leaguelens_parity.py`, then both test files → PASS.
- [ ] **Step 7: Commit.**
```bash
git add site/assets/leaguelens.js src/ffmodel/site/leaguelens.py tools/make_leaguelens_parity.py tests/fixtures/leaguelens_parity.json tests/leaguelens_fixture.cjs tests/test_leaguelens.py
git commit -m "feat: league lens scoring with combined-weight bands, disclosures, Python reference parity"
```

---

### Task 4: Exact lexicographic lineup kernel

Spec §7.1, §9.2.

**Files:**
- Create: `site/assets/lineup.js`, `tests/lineup_fixture.cjs`

**Interfaces:**
- Consumes: `Formats.AUDIT.slot_eligible` (`{QB,RB,WR,TE,FLEX,WRRB_FLEX,REC_FLEX,SUPER_FLEX}`).
- Produces (`window.Lineup`): 
  - `MODELED` = `["QB","RB","WR","TE","FLEX","SUPER_FLEX","WRRB_FLEX","REC_FLEX"]`, `UNMODELED` = `["K","DEF","DL","LB","DB","IDP_FLEX"]`, `NON_STARTING` = `["BN","IR","TAXI"]`.
  - `solve({slots, candidates, fixed = {}, current = []}) → {ok:true, total, assignment:[{index, slot, id, score, fixed, unmodeled}]} | {ok:false, reason, slot}`. `slots`: starting slot names in roster order (callers drop `NON_STARTING` first; an unknown name throws `Unsupported lineup slot: X`). `candidates`: `[{id, position, score}]`, unique string ids, finite score with |score| ≤ 1000. `fixed`: `{index: {id, score|null}}` for locked players in modeled slots and occupants of unmodeled slots. `current`: starter id per slot index (or null). `total` = raw sum of optimised modeled slots' scores (fixed slots excluded).
  - `lineupScore(players, slots, scoreOf) → number` (`-Infinity` when unfillable) and `bestLineup(players, slots, scoreOf) → {total, starters:[{player, slot, points}], unfillable?}` — drop-in replacements for `ROS.lineupScore`/`ROS.bestLineup` (players carry `position` and `sleeper_id` or `id`; a null/undefined/NaN score skips the player, as `ros.js` does).

- [ ] **Step 1: Failing test** `tests/lineup_fixture.cjs`:
```js
const assert = require("assert");
const Lx = require("../site/assets/lineup.js");
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const ELIG = require("../site/assets/formats.js").AUDIT.slot_eligible;
// brute force oracle: max total, then max kept-in-slot, then lexicographically smallest id vector
function brute({ slots, candidates, current }) {
  let best = null;
  const n = slots.length, used = new Set(), pick = [];
  (function rec(i) {
    if (i === n) {
      const total = pick.reduce((a, c) => a + Math.round(c.score * 1e6), 0);
      const keep = pick.filter((c, j) => current[j] === c.id).length;
      const ids = pick.map(c => c.id);
      const key = [total, keep];
      if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && (key[1] > best.key[1] ||
          (key[1] === best.key[1] && ids.join("\u0000") < best.ids.join("\u0000"))))) best = { key, ids };
      return;
    }
    for (const c of candidates) {
      if (used.has(c.id) || !ELIG[slots[i]].includes(c.position)) continue;
      used.add(c.id); pick.push(c); rec(i + 1); pick.pop(); used.delete(c.id);
    }
  })(0);
  return best;
}
const rand = mulberry32(7), POS = ["QB", "RB", "WR", "TE"], SLOTS = ["QB","RB","WR","TE","FLEX","SUPER_FLEX","WRRB_FLEX","REC_FLEX"];
for (let t = 0; t < 400; t++) {
  const slots = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => SLOTS[Math.floor(rand() * SLOTS.length)]);
  const candidates = Array.from({ length: 3 + Math.floor(rand() * 5) }, (_, i) => ({
    id: String(100 + Math.floor(rand() * 900)) + "_" + i, position: POS[Math.floor(rand() * 4)],
    score: rand() < 0.2 ? Math.round(rand() * 4) : Math.round((rand() * 30 - 3) * 100) / 100 }));
  const current = slots.map(() => rand() < 0.5 ? candidates[Math.floor(rand() * candidates.length)].id : null);
  const want = brute({ slots, candidates, current });
  const got = Lx.solve({ slots, candidates, current });
  if (!want) { assert.strictEqual(got.ok, false, `trial ${t} should be infeasible`); continue; }
  assert.ok(got.ok, `trial ${t}: ${got.reason}`);
  assert.deepStrictEqual(got.assignment.map(a => a.id), want.ids, `trial ${t}`);
}
// tie-break: equal scores keep current starters in their exact slot (astra counterexample)
let r = Lx.solve({ slots: ["RB", "FLEX"], candidates: [{ id: "A", position: "RB", score: 20 }, { id: "B", position: "RB", score: 10 }], current: ["B", "A"] });
assert.deepStrictEqual(r.assignment.map(a => a.id), ["A", "B"], "higher score first, ties only by keep");
r = Lx.solve({ slots: ["RB", "RB"], candidates: [{ id: "A", position: "RB", score: 10 }, { id: "B", position: "RB", score: 10 }], current: ["B", "A"] });
assert.deepStrictEqual(r.assignment.map(a => a.id), ["B", "A"], "equal scores keep current slots");
// fixed + unmodeled occupancy reserves the player; duplicate occupants refuse
r = Lx.solve({ slots: ["RB", "K"], candidates: [{ id: "A", position: "RB", score: 20 }, { id: "B", position: "RB", score: 10 }], fixed: { 1: { id: "A", score: null } } });
assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.assignment.map(a => a.id), ["B", "A"]); assert.strictEqual(r.total, 10);
assert.strictEqual(Lx.solve({ slots: ["RB", "K"], candidates: [], fixed: { 0: { id: "A", score: 1 }, 1: { id: "A", score: null } } }).ok, false);
assert.strictEqual(Lx.solve({ slots: ["RB"], candidates: [], fixed: { 0: { id: "Q", score: 1, position: "QB" } } }).ok, false, "fixed player ineligible");
// empty unmodeled slot is allowed; infeasible modeled slot refuses naming it
r = Lx.solve({ slots: ["QB", "K"], candidates: [{ id: "Q", position: "QB", score: 15 }] });
assert.ok(r.ok); assert.strictEqual(r.assignment[1].id, null);
r = Lx.solve({ slots: ["QB", "TE"], candidates: [{ id: "Q", position: "QB", score: 15 }] });
assert.deepStrictEqual([r.ok, r.slot], [false, "TE"]);
// negative scores still fill required slots
r = Lx.solve({ slots: ["TE"], candidates: [{ id: "T", position: "TE", score: -2 }] });
assert.deepStrictEqual([r.ok, r.total], [true, -2]);
assert.throws(() => Lx.solve({ slots: ["XYZ"], candidates: [] }), /Unsupported lineup slot/);
assert.throws(() => Lx.solve({ slots: ["QB"], candidates: [{ id: "a", position: "QB", score: 1 }, { id: "a", position: "QB", score: 2 }] }), /Duplicate/);
// ROS-compatible adapters
const players = [{ sleeper_id: "z", position: "RB" }, { sleeper_id: "a", position: "RB" }];
assert.strictEqual(Lx.bestLineup(players, ["RB"], () => 5).starters[0].player.sleeper_id, "a", "ties by id, not input order");
assert.strictEqual(Lx.lineupScore(players, ["RB", "RB", "RB"], () => 5), -Infinity);
assert.strictEqual(Lx.lineupScore(players, ["RB"], p => p.sleeper_id === "z" ? null : 3), 3);
console.log("lineup_fixture: ok");
```
- [ ] **Step 2: Run** → FAIL (`Cannot find module '../site/assets/lineup.js'`).
- [ ] **Step 3: Implement** `site/assets/lineup.js`:
```js
/* Exact lineup kernel (spec §7.1): maximise the modeled-slot score, then the
   number of current starters kept in their exact slot index, then the
   lexicographically smallest id vector in slot order. Scores are optimised in
   integer micro-points (score*1e6, |score| <= 1000) so the lexicographic
   objective is exact without an epsilon; `total` reports the raw float sum.
   rostersim.js deliberately keeps ROS.bestLineup (frozen method). */
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
  const K = 64;   // keep-count weight: at most 63 modeled slots

  // Rectangular Hungarian (n rows <= m cols), integer costs, null = forbidden.
  function hungarian(cost, n, m) {
    const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0;
      const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
      do {
        used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = -1;
        for (let j = 1; j <= m; j++) if (!used[j]) {
          const c = cost[i0 - 1][j - 1];
          const cur = c === null ? Infinity : c - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        if (delta === Infinity) return null;
        for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const col = new Array(n).fill(-1);
    for (let j = 1; j <= m; j++) if (p[j]) col[p[j] - 1] = j - 1;
    let total = 0;
    for (let i = 0; i < n; i++) total += cost[i][col[i]];
    return { col, total };
  }

  function solve({ slots, candidates, fixed = {}, current = [] }) {
    if (!Array.isArray(slots)) throw new Error("slots must be an array");
    for (const s of slots) if (!MODELED.includes(s) && !UNMODELED.includes(s)) throw new Error(`Unsupported lineup slot: ${s}`);
    const ids = new Set();
    for (const c of candidates || []) {
      if (typeof c.id !== "string" || ids.has(c.id)) throw new Error(`Duplicate or invalid candidate id: ${c.id}`);
      if (typeof c.score !== "number" || !Number.isFinite(c.score) || Math.abs(c.score) > 1000) throw new Error(`Invalid score for ${c.id}`);
      ids.add(c.id);
    }
    const fixedIds = new Set(), assignment = slots.map((slot, index) => ({ index, slot, id: null, score: null, fixed: false, unmodeled: UNMODELED.includes(slot) }));
    for (const [k, f] of Object.entries(fixed)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || i >= slots.length || !f || typeof f.id !== "string") return { ok: false, reason: "Invalid fixed slot.", slot: slots[i] };
      if (fixedIds.has(f.id)) return { ok: false, reason: `Player ${f.id} occupies two slots.`, slot: slots[i] };
      if (MODELED.includes(slots[i])) {
        const pos = f.position || (candidates || []).find(c => c.id === f.id)?.position;
        if (!pos || !ELIG[slots[i]].includes(pos)) return { ok: false, reason: "Locked player is in an incompatible slot.", slot: slots[i] };
      }
      fixedIds.add(f.id);
      Object.assign(assignment[i], { id: f.id, score: f.score ?? null, fixed: true });
    }
    const open = assignment.filter(a => !a.fixed && !a.unmodeled).map(a => a.index);
    const pool = (candidates || []).filter(c => !fixedIds.has(c.id));
    if (open.length === 0) return { ok: true, total: 0, assignment };
    if (pool.length < open.length) {
      const short = open.find(i => !pool.some(c => ELIG[slots[i]].includes(c.position))) ?? open[open.length - 1];
      return { ok: false, reason: `Cannot fill ${slots[short]} with available, projected players.`, slot: slots[short] };
    }
    const base = open.map(i => pool.map(c => ELIG[slots[i]].includes(c.position)
      ? -(Math.round(c.score * 1e6) * K + (current[i] === c.id ? 1 : 0)) : null));
    const best = hungarian(base, open.length, pool.length);
    if (!best) {
      const short = open.find(i => !pool.some(c => ELIG[slots[i]].includes(c.position))) ?? open[0];
      return { ok: false, reason: `Cannot fill ${slots[short]} with available, projected players.`, slot: slots[short] };
    }
    // Stage 3: fix slots in order to the smallest id that keeps the optimum.
    const cost = base.map(r => r.slice());
    for (let r = 0; r < open.length; r++) {
      const order = pool.map((c, j) => j).filter(j => cost[r][j] !== null).sort((a, b) => (pool[a].id < pool[b].id ? -1 : pool[a].id > pool[b].id ? 1 : 0));
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
  function prep(players, scoreOf) {
    const cands = [], byId = new Map();
    for (const p of players || []) {
      if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
      const v = scoreOf(p);
      if (v === null || v === undefined || Number.isNaN(v)) continue;
      cands.push({ id: pid(p), position: p.position, score: v }); byId.set(pid(p), p);
    }
    return { cands, byId };
  }
  function bestLineup(players, slots, scoreOf) {
    const { cands, byId } = prep(players, scoreOf);
    const r = solve({ slots, candidates: cands });
    if (!r.ok) return { total: -Infinity, starters: [], unfillable: r.slot };
    return { total: r.total, starters: r.assignment.map(a => ({ player: byId.get(a.id), slot: a.slot, points: a.score })) };
  }
  function lineupScore(players, slots, scoreOf) { return bestLineup(players, slots, scoreOf).total; }

  return Object.freeze({ MODELED, UNMODELED, NON_STARTING, solve, bestLineup, lineupScore });
});
```
- [ ] **Step 4: Run** `node tests/lineup_fixture.cjs` → `lineup_fixture: ok`. If a brute-force trial disagrees, fix the kernel, never the oracle.
- [ ] **Step 5: Commit.**
```bash
git add site/assets/lineup.js tests/lineup_fixture.cjs
git commit -m "feat: exact lexicographic lineup kernel (score, keep-in-slot, id order) with brute-force oracle"
```

---

### Task 5: Neutral weekly, remaining and players builders (Python)

Spec §3.1, §3.3, §3.4. Astra P2.

**Files:**
- Create: `src/ffmodel/site/neutral.py`, `tests/test_neutral.py`
- Modify: `src/ffmodel/site/remaining.py` (add a neutral emitter; legacy output byte-identical)

**Interfaces:**
- Produces:
  - `neutral_weekly(weekly_payload: dict, pick_six_prior: dict) -> dict` — copy of `build_weekly_projections(...)` output with `points` reduced to `{"ppr","half_ppr","standard"}`, `stats_p50` dropped, `pick_six_forecast` = the prior (always present), `schema_version: 1`, `kind: "neutral_weekly"`.
  - `build_remaining(..., league=None, emit="neutral")` → payload with `kind: "neutral_remaining"`, header `stat_order` = `leaguelens.STATS`, `schema_version: 2`, each projection row `{"week","status":"conditional_projection","opponent","stats":[p10|null, p50, p90|null]}` where each is a list of 12 floats rounded to 4 decimals in `stat_order`; `bye`/`unmodeled` rows unchanged; `pick_six_forecast`; no `league`, no `evaluation`. `emit="league"` (default) keeps today's output exactly.
  - `empty_remaining(season, week, data_through, model) -> dict` with `status: "no_remaining_weeks"`, `players: []`.
  - `build_players(weekly_n, remaining_n, sleeper_players, ecr_rows, schedule, season) -> dict` = `{schema_version:1, kind:"neutral_players", generated_at, ecr_source:{source,date,scoring}, players:[{player_id, sleeper_id|null, name, team, position, bye|null, ecr|null, identity_only: bool, reason|null}]}`.
  - `normalize_team(code) -> str` with one alias table `{"LAR":"LA","WSH":"WAS","JAC":"JAX"}`.

- [ ] **Step 1: Failing tests** `tests/test_neutral.py` — use small synthetic frames, not the model:
```python
import json
from ffmodel.site import neutral as N
from ffmodel.site.leaguelens import STATS

def _weekly_payload():
    sq = {q: {s: 1.23456789 for s in STATS} for q in ("p10", "p50", "p90")}
    return {"season": 2026, "week": 5, "generated_at": "2026-10-06T00:00:00+00:00", "data_through": "2026-wk4",
            "model": "transformer", "has_bands": True, "stat_projection_schema": {"version": 1},
            "players": [{"player_id": "00-1", "name": "A", "team": "SF", "opponent": "DEN", "position": "QB",
                         "is_home": True, "points": {"ppr": {}, "half_ppr": {}, "standard": {}, "league": {}},
                         "stat_quantiles": sq, "stats_p50": {}}]}

def test_neutral_weekly_drops_league_lens_and_keeps_full_precision():
    out = N.neutral_weekly(_weekly_payload(), {"method": "m", "rate": 0.05})
    p = out["players"][0]
    assert set(p["points"]) == {"ppr", "half_ppr", "standard"} and "stats_p50" not in p
    assert p["stat_quantiles"]["p50"]["passing_yards"] == 1.23456789
    assert out["pick_six_forecast"]["rate"] == 0.05 and out["kind"] == "neutral_weekly"

def test_normalize_team_aliases():
    assert [N.normalize_team(t) for t in ("LAR", "WSH", "JAC", "KC")] == ["LA", "WAS", "JAX", "KC"]

def test_players_strict_one_to_one():
    weekly = {"players": [{"player_id": "00-1", "name": "A B", "team": "SF", "position": "QB"},
                          {"player_id": "00-2", "name": "C D", "team": "KC", "position": "WR"},
                          {"player_id": "00-3", "name": "E F", "team": "LAR", "position": "RB"}]}
    sleeper = {"10": {"gsis_id": "00-1", "full_name": "A B", "position": "QB", "team": "SF"},
               "20": {"gsis_id": "00-2", "full_name": "C D", "position": "WR", "team": "KC"},
               "21": {"gsis_id": "00-2", "full_name": "C D", "position": "WR", "team": "KC"},
               "30": {"gsis_id": "00-3", "full_name": "E F", "position": "RB", "team": "LA"}}
    out = N.build_players(weekly, {"players": []}, sleeper, [], schedule=None, season=2026)
    by = {p["player_id"]: p for p in out["players"]}
    assert by["00-1"]["sleeper_id"] == "10" and not by["00-1"]["identity_only"]
    assert by["00-2"]["identity_only"] and by["00-2"]["reason"] == "duplicate_gsis_in_catalog"
    assert by["00-3"]["sleeper_id"] == "30" and not by["00-3"]["identity_only"]   # LAR == LA

def test_players_team_or_position_disagreement_is_identity_only():
    weekly = {"players": [{"player_id": "00-9", "name": "X", "team": "SF", "position": "WR"}]}
    sleeper = {"90": {"gsis_id": "00-9", "full_name": "X", "position": "TE", "team": "SF"}}
    p = N.build_players(weekly, {"players": []}, sleeper, [], schedule=None, season=2026)["players"][0]
    assert p["identity_only"] and p["reason"] == "position_disagrees"

def test_empty_remaining_state():
    e = N.empty_remaining(2026, 18, "2026-wk17", "transformer")
    assert e["status"] == "no_remaining_weeks" and e["players"] == [] and e["start_week"] == 18
```
And a legacy-unchanged test for `remaining.py`: build with a stub predictor (copy the stub/frames pattern from the existing `tests/test_remaining*.py`; read it first) and assert `emit="league"` output equals the pre-change output for the same inputs (capture the expected JSON in the test by running the *unmodified* function once before editing — commit it as `tests/fixtures/remaining_legacy_expected.json`), plus a neutral test asserting row shape, 4-decimal rounding, `stat_order == list(STATS)`, and that no `league`/`evaluation` key exists.
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement.**
  - `remaining.py`: add `emit: str = "league"` keyword to `build_remaining`. When `emit == "neutral"`: skip the `league`/scoring validation block (lines 66–72) and the `points.league` requirement; build each projection row as `{"week", "status": "conditional_projection", "opponent", "stats": [_row(p["stat_quantiles"].get("p10")), _row(p["stat_quantiles"]["p50"]), _row(p["stat_quantiles"].get("p90"))]}` with `_row = lambda d: None if d is None else [round(float(d[s]), 4) for s in STATS]`; the return dict replaces `"league"`/`"evaluation"` with `"kind": "neutral_remaining", "schema_version": 2, "stat_order": list(STATS), "pick_six_forecast": pick_six_prior`. Everything else (history freezing, team checks, statuses, `coverage_by_week`, limitations) is shared and unchanged. For `emit="neutral"` the caller must pass the always-on pick-six prior so `passing_pick_sixes` is present.
  - `neutral.py`: `neutral_weekly`, `empty_remaining`, `normalize_team`, `build_players`. `build_players` rules (spec §3.4): members = union of `player_id`s in neutral weekly and remaining (`name/team/position` from the first payload that has them); index the Sleeper catalog by `gsis_id` (stripped); 0 hits → `sleeper_id: null, identity_only: true, reason: "no_catalog_match"`; >1 hits → `identity_only: true, reason: "duplicate_gsis_in_catalog"` (no name fallback); 1 hit → compare `normalize_team(catalog.team)` vs `normalize_team(projection team)` → `reason: "team_disagrees"`; position mismatch → `reason: "position_disagrees"`; `bye` from the season's REG schedule (the week a team has no game, or null if `schedule is None`); `ecr` from `ecr_rows` matched by gsis (else null). `ecr_source = {"source": "fantasypros_ecr", "date": <snapshot date>, "scoring": "PPR"}` when rows given, else null.
  - Catalog freshness: add `max_age_hours: float | None = None` to `ffmodel.site.sleeper.pull_sleeper_players`; when set and the cache file's mtime is older, refetch (keep validation). The neutral generator passes `24`.
- [ ] **Step 4: Run** `.venv/Scripts/python.exe -m pytest tests/test_neutral.py tests/test_remaining*.py tests/test_sleeper*.py -q` → PASS.
- [ ] **Step 5: Commit.**
```bash
git add src/ffmodel/site/neutral.py src/ffmodel/site/remaining.py src/ffmodel/site/sleeper.py tests/test_neutral.py tests/fixtures/remaining_legacy_expected.json
git commit -m "feat: neutral weekly/remaining/players builders (strict one-to-one crosswalk, team aliases, empty end state)"
```

---

### Task 6: Evidence records (`evaluation.json`)

Spec §3.2, §8.9. Astra F1/P1. Model: **opus** (requires reading each artifact to establish what was measured).

**Files:**
- Create: `src/ffmodel/site/evidence_records.py`, `tests/test_evidence_records.py`

**Interfaces:**
- Produces `build_evaluation() -> dict` = `{schema_version:1, kind:"neutral_evaluation", records:[...]}`; each record `{id, metric, source:{path, sha256}, source_settings:{league, scoring}, effective_scoring:<evidence identity string>, omitted:[{key, reason}], method:{model, band_construction, lineup_policy|null, prior|null}, population, horizon, values}`.
- Consumed by Task 8 (`LeagueData.evidenceFor(kind, liveIdentity, currentMethod)`).

- [ ] **Step 1: Establish each claim's scope** by reading its source (write findings into the module docstring):
  - Rest-of-season MAE: `models/diagnostics/remaining_matrix_{gabagool,fam}.json` (FAM may not exist — then no FAM record; never borrow). `effective_scoring` = Gabagool settings with `pass_int_td` forced to 0 when the reports carry `pick_six_evaluated: false` (all 24 do), `omitted: [{"key":"pass_int_td","reason":"pick-six actuals unavailable"}]`; method from the file (`model`, `band_construction` from `ffmodel.scoring.BAND_CONSTRUCTION` if recorded, else `"unknown"`).
  - Close-call rate (56.3%): `site/data/start_sit_evaluation.json` — its `scoring` and `pick_six_forecast_priors` blocks give effective scoring and prior; `lineup_policy: "same-position pairs within 3 pts, both >= 5"`.
  - Band calibration (~80%): find the artifact the weekly footer cites (`grep -rn "80" site/weekly.html` then follow the about page / `models/` eval files for per-position coverage). If its scoring or band construction cannot be established from a committed artifact, emit **no record** and note it in the docstring.
  - A record whose `method` has any `"unknown"` field is still emitted (for the about page) but can never match (Task 8 treats unknown as mismatch).
- [ ] **Step 2: Failing tests:**
```python
from ffmodel.site.evidence_records import build_evaluation
from ffmodel.site import leaguelens as L

def test_ros_record_excludes_pick_six():
    recs = {r["id"]: r for r in build_evaluation()["records"]}
    ros = recs["ros_mae_gabagool"]
    assert {"key": "pass_int_td", "reason": "pick-six actuals unavailable"} in ros["omitted"]
    assert '"passing_pick_sixes"' not in ros["effective_scoring"]
    assert ros["source"]["sha256"] and ros["source"]["path"].startswith("models/diagnostics/")

def test_records_identity_is_canonical():
    for r in build_evaluation()["records"]:
        assert r["effective_scoring"].startswith('{"v":1,"w":{')

def test_no_borrowed_records():
    ids = [r["id"] for r in build_evaluation()["records"]]
    assert all(r["source_settings"]["league"] in r["id"] or r["id"].startswith("start_sit") or r["id"].startswith("band")
               for r in build_evaluation()["records"]), ids
```
- [ ] **Step 3: Implement** `build_evaluation()` using `leaguelens.effective_weights` + `evidence_identity`; `sha256` over raw file bytes.
- [ ] **Step 4: Run** `.venv/Scripts/python.exe -m pytest tests/test_evidence_records.py -q` → PASS.
- [ ] **Step 5: Commit** `feat: evaluation.json evidence records with effective scoring and method identity`.

---

### Task 7: Staged publication of the coexistence batch

Spec §3.5, §10. Astra I7/F7/P4.

**Files:**
- Modify: `src/ffmodel/site/generate.py` (add `--neutral`, `--require-remaining`)
- Create: `src/ffmodel/site/publish.py`, `tests/test_publish.py`
- Modify: `.github/workflows/weekly-update.yml`

**Interfaces:**
- `python -m ffmodel.site.generate ... --neutral --out <stage>/neutral` writes `weekly.json`, `remaining.json`, `players.json`, `evaluation.json`, `formats.json` (no league); with `start_week > 17` writes `empty_remaining`.
- `formats.json` = `[{label, format_key, compat, description, exploratory}]` built by `neutral.format_table()` from `models/prospective/2026/format_payloads.json` (keyed by label; each entry has `format_key`, `compat`) — copied, never regenerated — with descriptions from this fixed table: `f12-1qb-ppr-6` "12-team 1QB PPR, 6-pt pass TD"; `f10-1qb-ppr-6` "10-team 1QB PPR, 6-pt pass TD"; `f12-1qb-ppr-4` "12-team 1QB PPR, 4-pt pass TD"; `f12-1qb-half-4` "12-team 1QB half-PPR, 4-pt pass TD"; `f12-sf-ppr-4` "12-team superflex PPR, 4-pt pass TD (exploratory)" (`exploratory: true`). A test asserts every payload label has a description and `format_key`/`compat` are byte-equal to the payload file.
- `--require-remaining` makes the legacy remaining-season exception fatal (re-raise instead of print) — used only in the weekly workflow during coexistence.
- `python -m ffmodel.site.publish --stage <dir> --out site/data --required <manifest>` validates then promotes; exit 0 on success, nonzero leaves `site/data` untouched.
- `publish.validate(stage: Path, required: list[str]) -> list[str]` (error strings; empty = OK); `publish.promote(stage, out)`.

- [ ] **Step 1: Failing tests** `tests/test_publish.py` (tmp dirs, synthetic JSON):
  - a complete stage (legacy `weekly.json`, `weekly-fam.json`, `remaining-gabagool.json`, `remaining-fam.json`, `kickoffs.json`, `roles.json`, `about.json`, and `neutral/{weekly,remaining,players,evaluation}.json` with matching `season`, `week`/`start_week`, `data_through`) → `validate` returns `[]` and `promote` copies every file;
  - missing any required file → error naming it, `promote` not called, `out` unchanged (compare a hash of `out` before/after);
  - neutral `data_through` differing from legacy `weekly.json` → error `batch fields disagree`;
  - `neutral/remaining.json` larger than `SIZE_CAP_BYTES` → error `oversize`; never truncated;
  - `neutral/remaining.json` with `status: "no_remaining_weeks"` and `start_week == 18` → valid;
  - fault injection: make `promote` fail midway (monkeypatch `shutil.copy2` to raise on the 3rd file) → `out` restored to the exact previous contents (promote copies into `out.with_name(out.name + ".next")` then swaps directories with `os.replace`; on any failure the `.next` dir is removed).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `publish.py` (`SIZE_CAP_BYTES` initially `4_000_000`; Task 14 replaces it with the week-1 measurement × 1.25, rounded up to the next 100 kB) and the generate flags. Neutral mode in `generate.main()`: skip `load_league`/`set_league_rules` and every legacy/draft payload; always `load_pick_six_prior(args.season)`; build weekly via `build_weekly_projections` then `neutral_weekly`; remaining via `build_remaining(..., league=None, emit="neutral", end_week=17)` when `week <= 17` else `empty_remaining`; players via `build_players` with `pull_sleeper_players(cache_dir, max_age_hours=24)`; evaluation via `build_evaluation()`; write with `_atomic_write(..., compact=True)` for remaining.
- [ ] **Step 4: Workflow.** In `weekly-update.yml`'s non-draft branch: `STAGE=$RUNNER_TEMP/stage`; copy current `site/data` into `$STAGE` first (so unchanged files like draft boards are carried); run the two legacy invocations with `--out $STAGE --require-remaining`, then `python -m ffmodel.site.generate ... --neutral --out $STAGE/neutral`; then `python -m ffmodel.site.publish --stage $STAGE --out site/data --required weekly.json,weekly-fam.json,remaining-gabagool.json,remaining-fam.json,kickoffs.json,roles.json,about.json,neutral/weekly.json,neutral/remaining.json,neutral/players.json,neutral/evaluation.json,neutral/formats.json`. The draft branch is unchanged. Optional ECR steps stay after publish and outside it.
- [ ] **Step 5: Run** `.venv/Scripts/python.exe -m pytest tests/test_publish.py tests/test_generate*.py -q` → PASS. Validate the workflow YAML parses: `python -c "import yaml;yaml.safe_load(open('.github/workflows/weekly-update.yml'))"`.
- [ ] **Step 6: Commit** `feat: staged all-or-nothing publication of legacy + neutral batch (coexistence)`.

---

### Task 8: League data adapter (`leaguedata.js`)

Spec §3, §4, §5.3, §6.1, §3.2. Model: **opus**.

**Files:**
- Create: `site/assets/leaguedata.js`, `tests/leaguedata_fixture.cjs`, `tests/fixtures/leagues_synthetic.json`

**Interfaces:**
- Consumes: `LeagueLens` (Tasks 2–3), `Formats`, `Lineup` slot lists (Task 4), `FC.loadJSON`.
- Produces (`window.LeagueData`):
  - `loadBatch() → Promise<{weekly, remaining, players, evaluation}>` (single-flight per document; rejects if `players`/`weekly` missing; `remaining`/`evaluation` may be null).
  - `views(batch, league, {week, catalog}) → {lens, disclosures, weekly, remaining, board}`:
    - `weekly`: `{season, week, generated_at, data_through, players:[{player_id, name, team, opponent, position, points:{league:{p10,p50,p90}}}]}` — scored with `LeagueLens.score`; a player whose stat block fails scoring is omitted and listed in `weekly.unscored`.
    - `remaining`: same shape as today's legacy file (`schema_version:1, horizon:"remaining_season", status:"experimental", evaluation:null, season, start_week, end_week, generated_at, data_through, players:[{player_id, team, weeks:[{week, status, opponent?, points:{league:{…}}|null}]}]`) built from `neutral/remaining.json` stat arrays + `stat_order`; `null` when the batch remaining is missing or `status === "no_remaining_weeks"` (then `remainingReason: "No projected weeks remain."`).
    - `board`: `{season, players:[{player_id, sleeper_id, name, position, team, bye, ecr, ros_value}]}` from `players.json` excluding `identity_only`; `ros_value` = sum of p50 over weeks `week+1..17` with any null week → `null`.
  - `rosterIdentities(rosters, catalog) → Map<sleeperId, {name, position, team, injury_status}>` covering every roster/reserve/taxi occupant incl. K/DEF/IDP/teamless; a catalog miss gives `{name: id, position: null, team: null, unknown: true}` (never dropped).
  - `formatLine(league, formatTable) → Promise<{text, inTest: bool, eligible: bool}>` — eligibility first (best ball → `Best ball — not eligible for the format test`); then `Formats.match` → in-test copy using the table entry's `description` or the not-in-test copy.
  - `slotSupport(league) → {modeled:[], unmodeled:[], nonStarting:[], unknown:[]}`; `unknown.length` ⇒ pages show projections only, naming the slot.
  - `evidenceFor(evaluation, recordIdPrefix, lens, method) → record | null` — returns a record only if `record.effective_scoring === LeagueLens.evidenceIdentity(lens.weights)` and every field of `record.method` equals `method` (any `"unknown"` → null).
- `formatTable` is `site/data/neutral/formats.json` (Task 7): `[{label, format_key, compat, description, exploratory}]`, passed straight to `Formats.match`.

- [ ] **Step 1: Synthetic leagues fixture** `tests/fixtures/leagues_synthetic.json` (no real managers): `gabagool_like` (owner fixture slots + Gabagool scoring), `fam_like`, `superflex_half` (10 teams, `QB,RB,RB,WR,WR,TE,FLEX,SUPER_FLEX,BN×6`, half PPR), `te_premium` (Gabagool + `bonus_rec_te: 0.5`), `best_ball` (Gabagool + `settings.best_ball: 1`), `idp` (Gabagool slots + `DL, LB, IDP_FLEX`), `weird_slot` (adds `"XFLEX"`), `fd_league` (`bonus_fd_wr: 0.5`). Each: `{league_id, season:"2026", status:"in_season", total_rosters, roster_positions, scoring_settings, settings:{waiver_type, waiver_budget, best_ball?}}`.
- [ ] **Step 2: Failing tests** `tests/leaguedata_fixture.cjs` — build a tiny batch inline (3 players, 2 remaining weeks) and assert: views scores equal `LeagueLens.score` per player; remaining view rows rebuild from arrays in `stat_order`; `ros_value` null when any future week is null; empty remaining → `remaining === null` with the copy; `rosterIdentities` keeps a K, a DEF, an IDP and an unknown id; `formatLine` → gabagool_like "in the test" (use the real format table), te_premium "not in the format test", best_ball best-ball copy even though its fingerprint matches, idp "not in the format test"; `slotSupport(weird_slot).unknown` = `["XFLEX"]`; `slotSupport(gabagool_like)` has `nonStarting` containing `BN` and `unknown` empty (astra G1); `evidenceFor` returns null for a record whose `effective_scoring` omits pick-six when the lens has `pass_int_td: -3`, and null for a method with `"unknown"`.
- [ ] **Step 3: Implement**, run `node tests/leaguedata_fixture.cjs` → PASS.
- [ ] **Step 4: Commit** `feat: league data adapter - neutral batch to league-scored views, roster identities, format line, evidence lookup`.

---

### Task 9: Session, navigation and league selection by id

Spec §5.1, §5.2, §5.4. Review Focus 2 and 5. Model: **opus**.

**Files:**
- Modify: `site/assets/session.js`, `site/assets/app.js`, `site/assets/connect.js`, `site/connect.html` (if it hardcodes registry links)
- Modify tests: `tests/session_fixture.cjs`, `tests/chip_session_fixture.cjs`, `tests/navigation_fixture.cjs`, `tests/connect_fixture.cjs`

**Interfaces:**
- `Session.ready({leagueId})` (new form, in-season pages): no registry entry, no board; builds a synthetic entry `{slug: null, platform: "sleeper", leagueId, tools: {startsit:true, waivers:true, trade:true}}`; `/league/<id>` returning `null` → error `Sleeper has no league with id {id}.`; league `season` ≠ `/state/nfl` season → error `This league is from the {season} season; projections are for {current}.` (Review Focus 2). `Session.ready({slug, board})` (draft pages) unchanged.
- `Session.refresh` **always refetches `/league/<id>`** (scope argument kept for users; spec §5.2) and the bundle carries `leagueFetchedAt`.
- `Session.view(rosterId | null)` + `bundle.viewedRoster` (anonymous or non-owner choice) — independent of `myRoster`; identifying an owner clears `viewedRoster` and sets `myRoster` (Review Focus 5); `chipText` says `Viewing {team name}` for a viewed roster.
- `FC.inSeasonLeague() → {leagueId, legacySlug|null}`: reads `?league=`; `gabagool`/`fam` → their registry ids; a numeric id → itself; anything else → `mountInvalidLeagueRecovery`.
- `FC.leagueNavigation()` on in-season pages writes the **id** into nav links for in-season destinations; for draft destinations (`index.html`, keepers, pre-draft trade) a registry id maps back to its slug, any other id links to the page with `?league=<id>` where the page shows `The draft board is only built for registered leagues.` (no substitution). ESPN keeps its slug route.
- `FC.setLeague(leagueId)` replaces `FC.setBoard(board)` on in-season pages (chip calls `Session.ready({leagueId})` once identity exists **or** immediately for anonymous read-only viewing).
- `connect.js` lists every current-season league with in-season links (`weekly.html?league=<id>` etc.); drops "advice is unavailable" for unregistered leagues.

- [ ] **Step 1: Failing tests** (add to the existing fixtures, following their harness style — read each first): ready by id (owner found / non-owner / anonymous), unknown id → exact message, last-season id → exact message, refresh refetches league (assert the stub `get` saw `/league/<id>` on a roster refresh) and a changed `scoring_settings` produces a new bundle with the new settings, `view()` then `identify()` as owner of another roster → `viewedRoster === null`, `myRoster` set; navigation: in-season page with `?league=1376245373244301312` writes the id into weekly/waivers/trade links and `gabagool` into the draft-board link; `?league=999` writes `999` into in-season links and the draft link shows the not-built copy; legacy `?league=fam` resolves.
- [ ] **Step 2: Run** the four fixtures → FAIL on the new cases.
- [ ] **Step 3: Implement.** Keep every invariant in `session.js`'s header comment; extend the comment for the id path and `viewedRoster`.
- [ ] **Step 4: Run** all `tests/*_fixture.cjs` that touch session/app/connect/navigation plus `draftmode_fixture.cjs`, `keepers_fixture.cjs`, `trademode_fixture.cjs` (draft side must be unchanged) → PASS.
- [ ] **Step 5: Commit** `feat: league selection by Sleeper id, anonymous team viewing, live settings refetch, draft navigation boundary`.

---

### Task 10: Start/sit on neutral views and the kernel

Spec §7.1 (start/sit), §7.2, §6.1, §3.2, §8. Review Focus 1. Model: **opus**.

**Files:**
- Modify: `site/assets/startsit.js`, `site/assets/startsitmode.js`, `site/weekly.html`
- Modify: `tests/startsit_fixture.cjs`, `tests/startsitmode_session_fixture.cjs`
- Delete: `tests/inseason_baseline_fixture.cjs` start/sit section (keep the other two sections until Tasks 11/12)

**Interfaces:**
- `StartSit.analyze({board, weekly, league, roster, catalog, kickoffs, excludeIds, now, snapshotAt})` keeps its signature and return shape (`{lineup, bench, warnings, label}`); `board`/`weekly` are now Task 8 views.

- [ ] **Step 1: Tests first.** Update `tests/startsit_fixture.cjs`: delete the cases asserting "Weekly league contract does not match." / "Weekly scoring changed" (contract checks removed, spec §5.3); add: superflex + WRRB_FLEX + REC_FLEX leagues pick the kernel's lineup (compare with `Lineup.solve`); IDP slots pass through unchanged like K/DST; an unknown starting slot throws `Unsupported lineup slot: XFLEX`; the owner-fixture slots with `BN×5, IR, TAXI` are accepted (astra G1); every §7.1 start/sit policy case — OUT/IR/SUSPENDED/PUP/DOUBTFUL excluded, user exclusion, unlocked eligible player missing a projection → throws `missing current-team weekly projection`, **a player whose catalog team differs from the projection team → same refusal naming him (Review Focus 1)**, locked player without projection stays fixed and no total is reported, locked player in an ineligible slot → `Locked player is in an incompatible slot.`, game started after snapshot → refresh message; 7-day age limit for weekly and kickoffs; duplicate occupant (`[RB,K]` with the same id twice) → refuses instead of placing one player twice (§8.12); raw-score near tie (9.17528 vs 9.17795) orders by raw value (§8.2).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `startsit.js`: remove lines 10–13 (league/scoring contract); keep season/week/age checks; replace the slot whitelist with `LeagueData.slotSupport`-equivalent logic (modeled + unmodeled + non-starting; unknown starting slot → `Unsupported lineup slot: X`); keep every per-player rule (lines 31–53) verbatim; replace the greedy assignment + swap loop (lines 55–75) with `Lineup.solve({slots, candidates, fixed, current})` where `fixed` = locked players (with their position) and unmodeled-slot occupants; keep the bench/close-call computation (lines 76–86) on raw p50s. `startsitmode.js`: load `LeagueData.loadBatch()` + kickoffs instead of `draft`/`weekly` files; build views from the live league; best ball → show projections + the best-ball note and skip `analyze`; unknown slots → projections only naming the slot; render the format line, banner and footnotes (`LeagueLens.disclosures`) and the simulation note is **not** shown here (no simulation on this page). Viewed (non-owner) roster renders with `Viewing {team}`. `weekly.html`: the projection table gets a "Your league" lens computed from the view (keep PPR/half/standard lenses from `points`); the 56.3% close-call line and the ~80% calibration line render only via `LeagueData.evidenceFor` (else the evidence fallback copy); add `<script src="assets/formats.js">`, `leaguelens.js`, `lineup.js`, `leaguedata.js` before `startsit.js`.
- [ ] **Step 4: Run** `node tests/startsit_fixture.cjs && node tests/startsitmode_session_fixture.cjs && node tests/inseason_baseline_fixture.cjs` → PASS (baseline fixture now only checks waivers/trade).
- [ ] **Step 5: Commit** `feat: start/sit on neutral league views and the exact lineup kernel`.

---

### Task 11: Waivers on neutral views and the kernel

Spec §7.1 (both waiver bullets), §7.2, §3.3, §6.2, §8. Review Focus 1 and 3. Model: **opus**.

**Files:**
- Modify: `site/assets/waivers.js`, `site/assets/waivermode.js`, `site/assets/waiverintel.js`, `site/waivers.html`
- Modify: `tests/waivers_fixture.cjs`, `tests/waivermode_fixture.cjs`, `tests/waivermode_session_fixture.cjs`, `tests/waiverintel_fixture.cjs`; drop the waivers section of `tests/inseason_baseline_fixture.cjs`

**Interfaces:**
- `Waivers.analyze(args)` keeps its signature and return shape minus the simulation fields; `board`/`weekly`/`remaining` are Task 8 views; `args.evalFile`/`args.availability` are ignored and removed from callers.

- [ ] **Step 1: Tests first.** In `tests/waivers_fixture.cjs`: delete contract-mismatch cases (weekly/remaining league id and scoring equality, board team count) and every simulation/gate case (`waiverGateOpen`, `simulateRows`); add: `lineupScore` is `Lineup.lineupScore` (`assert.strictEqual(Waivers.__lineupScore, Lineup.lineupScore)` — export it for the test); WRRB_FLEX/REC_FLEX leagues; admission at raw gain 0.004 (excluded) and 0.006 (admitted) (§3.3); `value_points` replaced by `ros_value` for the tie-break/"why" (§8.3) with a fixture where two equal-gain rows order by `ros_value`; **weekly unknown contributor → blocked result, no lineup gains** (`waivers.js:437-440`); ROS unknown member → excluded with a warning, other weeks still count; **a rostered player whose catalog team ≠ projection team → treated as unknown → weekly gains blocked (Review Focus 1)**; 72-hour limits for weekly, kickoffs and remaining, and a 96-hour weekly with fresh remaining → gains withheld (astra G2); reverse standings (`waiver_type 1`) → ranked like rolling, labeled `reverse-standings waivers`, no bids; FAAB reserve default `round(0.2 × waiver_budget)` for budgets 0, 10, 100 and exhausted, reset on budget change unless typed (§7.2); **4-team, 20-team and 32-team leagues** run without assuming 10/12 teams (Review Focus 3); week 17 → no ROS weeks, week 18 view `remaining === null` → ROS disabled with `No projected weeks remain.`; the simulation note copy appears on every league; the format line, banner and footnotes render as on the start/sit page.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `waivers.js`: `const lineupScore = Lineup.lineupScore;` (replacing the `ROS.lineupScore` alias); in `weeklyMap` delete the league-id and scoring-contract conditions (lines 81–91), keep season/week/age/players; in `remainingMap` delete lines 149–155 and 158–159, keep the rest; delete `boardPoints`' `season_points` fallback and read `p.ros_value`; delete the preseason-proxy branches (lines 392, 404, 464, 627–628, 661, 696 — `basis` becomes `priced ? "move" : "this_week"`); replace the rounded gain filter in `collect` (lines 603–610) with raw `gain >= 0.005`; delete `waiverGateOpen`, `simulateRows`, `SIM`, the `simGate` block and `simulationCoverageText` uses; `rolling` becomes `waiverType === 0 || waiverType === 1` with `waiver.type` `"rolling"` or `"reverse_standings"`; the `STARTER_SLOTS`/`slots(league)` helpers use `Lineup.MODELED` and treat `Lineup.UNMODELED` as occupied capacity. `waivermode.js`: drop `supportedEntry`/`validateContract` registry and board checks (keep `status === "in_season"`, `waiver_type ∈ {0,1,2}`); load `LeagueData.loadBatch()`, `roles.json`, `kickoffs.json`, `ros-ecr.json` (no `draft*.json`, no `trade_sim_eval.json`, no `availability.json`); `hydrateBoard` uses `LeagueData.rosterIdentities` for K/DEF/IDP/unknown occupants; league link uses the live league id/name; reserve input default from the budget rule with a `userTyped` flag; best ball → projections + best-ball note, no shortlist; unknown slots → projections only. `waiverintel.js`: board fields now come from the view (`ecr`, `bye`, `sleeper_id` unchanged names); keep the "PPR reference" labels. `waivers.html`: script tags as in Task 10; the reserve label says "default 20% of your league budget"; the simulation note copy replaces the old gate text; the ROS label uses the horizon copy.
- [ ] **Step 4: Run** the four waiver fixtures + `node tests/inseason_baseline_fixture.cjs` → PASS.
- [ ] **Step 5: Commit** `feat: waivers on neutral league views and the lineup kernel; reverse standings; budget-relative reserve; simulation off`.

---

### Task 12: In-season trade on neutral views and the kernel

Spec §7.1 (trade), §7.2, §5.4, §6.2, §8. Model: **opus**.

**Files:**
- Modify: `site/assets/seasontrade.js`, `site/assets/seasontrademode.js`, `site/trade.html`
- Modify: `tests/seasontrade_fixture.cjs`, `tests/seasontrademode_fixture.cjs`; delete `tests/inseason_baseline_fixture.cjs` (all sections now migrated; the captured JSON stays for Task 14)

**Interfaces:**
- `SeasonTrade.analyze/resolveScenario` keep signatures; `remaining` and `board` are Task 8 views; the lineup functions come from `Lineup`.

- [ ] **Step 1: Tests first.** Delete contract cases (`Projection league or season mismatch` league-id part, `Identity board league/season mismatch` league-id part, `Scoring mismatch`, `Scoring contract missing`) — keep the season checks; delete simulation/gate cases; add: SUPER_FLEX/WRRB_FLEX/REC_FLEX/IDP leagues accepted (IDP as unmodeled capacity); unknown starting slot → `Unsupported roster slots`; §7.1 trade policy cases — current week skipped, declared bye → 0, user-excluded week → 0, `OUT` injury tag → warning only (still scored), missing coverage → refusal, a valid projected p50 of exactly 0 stays 0 (not treated as excluded); 72-hour remaining limit and the 60-second roster snapshot; week 18 → `No projected weeks remain.`; future picks absent from the asset list (`seasontrademode` renders no pick rows, `Keepers`/`Trade.defaultPicks` no longer referenced — assert via source grep in the fixture).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `seasontrade.js`: `asLineup` uses `Lineup.bestLineup`; delete the league-id/scoring equality requires (lines 31, 33 league-id part, 47–52) keeping season/horizon/age requires; slot whitelist uses `Lineup` lists. `seasontrademode.js`: remove `pickOwnership`, the traded-picks fetch and pick rendering; remove `evalView`/gate and `trade_sim_eval.json`; read `league` from each new bundle (no closure capture, spec §5.2); load the batch and build views per bundle; `renderWarn` uses `LeagueData.evidenceFor` for the ROS evaluation line (else the fallback copy); best ball → projections + note, no comparison; render the format line, banner, footnotes and the simulation note. `trade.html`: resolve the mode first — fetch `/league/<id>` via `Session.ready({leagueId})`; only when `status === "pre_draft"` **and** the league is the registered Gabagool league load `draft.json` and run `TradeMode` exactly as today; in season never fetch draft data; other states print today's message.
- [ ] **Step 4: Run** `node tests/seasontrade_fixture.cjs && node tests/seasontrademode_fixture.cjs && node tests/trademode_fixture.cjs` → PASS.
- [ ] **Step 5: Commit** `feat: in-season trade on neutral league views and the lineup kernel; mode-first trade page; no future picks; simulation off`.

---

### Task 13: Historical evidence on the about page and docs

Spec §3.2, §8.9, §6.2.

**Files:**
- Modify: `site/about.html`, `docs/remaining-season-projections.md`, `README.md` (only if it describes the in-season pages as Gabagool/FAM-only)

- [ ] **Step 1:** About page: a "Measured results and their scope" section rendering every `evaluation.json` record (fetch `data/neutral/evaluation.json`) with its source league, effective scoring omissions (e.g. "pick-six penalties excluded"), model, population and horizon — labeled historical, not a claim about any current league. Replace the v1 trade/waiver gate paragraph with the simulation note copy.
- [ ] **Step 2:** `docs/remaining-season-projections.md`: add a "League-neutral data (phase 1)" section: file list, schema versions, the horizon label, the coexistence transaction and retirement rule (spec §10).
- [ ] **Step 3:** Run `node tests/interface_hierarchy_fixture.cjs && node tests/shared_assets_fixture.cjs` (they pin page structure/script tags; update their expectations for the new script tags only) → PASS.
- [ ] **Step 4: Commit** `docs: scoped historical evidence on the about page; neutral data documentation`.

---

### Task 14: End-to-end verification (controller)

Spec §9.1, §9.4, §9.12, §3.3. Astra P4.

- [ ] **Step 1: Local neutral generation.** `.venv/Scripts/python.exe -m ffmodel.site.generate --out .review/neutral-e2e/neutral --model transformer --season 2026 --week auto --neutral --artifact-root models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44` (background, detached). Also a week-1 full-horizon run (`--week 1`) into `.review/neutral-e2e-wk1/` to measure `remaining.json` size; set `publish.SIZE_CAP_BYTES` = measured × 1.25 rounded up to 100 kB; commit.
- [ ] **Step 2: Full-file parity.** A throwaway script scores every player-week of the generated `weekly.json` and `remaining.json` with `LeagueLens.score` (node) and `reference_score` (Python, from the stat values as published) for Gabagool and FAM scorings; tolerance 1e-9 for weekly, `0.00005 × Σ|effective weight|` for remaining (spec §3.3). Report max diffs.
- [ ] **Step 3: Baseline diff ledger.** Run the new analyzers on `tests/fixtures/inseason_baseline/inputs_*.json` (converted to views via a small adapter that turns the captured legacy files into the view shapes) and diff against `outputs_*.json`. Every difference must map to a spec §8 item; write the ledger to `.superpowers/sdd/<plan>/baseline-ledger.md`. An unmapped difference is a bug → fix task.
- [ ] **Step 4: Full suites.** `.venv/Scripts/python.exe -m pytest -q` and every `node tests/*_fixture.cjs` → all PASS.
- [ ] **Step 5: Browser checks** (local static server over `site/` with the e2e batch copied into `site/data/neutral/` — not committed): Gabagool and FAM end to end on weekly, waivers, trade (owner identity), numbers matching the legacy pages except §8 items; one public superflex league and one best-ball league pasted by id (anonymous view); league switch mid-load; refresh after changing nothing. Restore `site/data/neutral/` afterwards.
- [ ] **Step 6:** Final whole-branch review (opus), then astra branch review (`codex exec -m gpt-6-astra`), then the owner decides merge timing (only after `prospective-2026-o5` exists). Coexistence, the rollback rehearsal and legacy retirement (spec §10) happen after merge as separate owner-approved steps, not in this plan.
