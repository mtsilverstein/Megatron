# Waiver Drop Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** price what a required drop costs on the waiver desk — the roster-aware change in rest-of-season lineup points — so add/drop swaps get spend guidance instead of a blanket "unassessed".

**Architecture:** The Python generator slims the existing opt-in `remaining-<slug>.json` (league-lens quantiles only, an `evaluation` block read from the committed diagnostic replaces the `advice_eligible` boolean) and the weekly workflow publishes it fail-soft for both leagues. The browser engine (`waivers.js`) gains `remainingMap` (freshness/alignment guard mirroring `weeklyMap`), `rosValue` (Σ future-week `lineupScore`), a three-state `dropCost`, and a move-value basis for the existing uncalibrated bands. The page (`waivermode.js`, `waivers.html`) loads the payload, shows the ROS split per row, coverage and the evaluation table.

**Tech Stack:** Python 3.12 (pandas, pytest via `.venv/Scripts/python.exe -m pytest`), plain browser JS in UMD modules tested with `node tests/<name>_fixture.cjs`, GitHub Actions YAML.

**Spec:** `docs/superpowers/specs/2026-09-16-waiver-drop-cost-design.md` — read it first; every constant and string below is copied from it.

## Global Constraints

- Unknown is never zero: an unmodeled add or drop is `unassessed`, never priced at 0 (spec §5.1).
- `WEAK_SIGNAL_PTS = 1`; bands 1–2 → `small` 1–3 %, 2–5 → `useful` 4–10 %, 5+ → `impact` 11–20 % of starting budget; label `"heuristic, not calibrated and not a win probability"` — values and labels unchanged (spec §3.3).
- `bidGuide` precedence: affordability → net-negative (priced only) → weak → unassessed → bands (spec §3.3).
- Fallback basis when `rosDelta` is null: `perWeekValue = lineupGain` (spec §1).
- Decomposition is taken against `R + A`: `addContributes = rosValue(R+A) − rosValue(R)`, `dropForfeits = rosValue(R+A) − rosValue(R+A−D)`, `rosDelta = rosValue(R+A−D) − rosValue(R)` (spec §1).
- `dropCost` key sets are fixed: `open_slot` → `status,label,addContributes,rosDelta,futureWeeks,endWeek`; `priced` → those plus `dropForfeits`; `unassessed` → `status,label,reason` (spec §3.2).
- Remaining payload freshness window: `generated_at` no older than 72 h, no more than 1 h in the future (spec §3.1).
- Cache versions after the page change: `waivers.js?v=dropcost3`, `waivermode.js?v=dropcost3` on both `waivers.html` and `weekly.html` (spec §4).
- No text says a swap is "wrong"/"right"; withheld rows never print `$`, `null`, `undefined` (spec §5.5, existing fixtures).
- Run all Python with `.venv/Scripts/python.exe` (system Python 3.14 is on PATH and lacks the deps).
- Commit after every task; every commit message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Slim the remaining payload and replace `advice_eligible` with an `evaluation` block

**Files:**
- Modify: `src/ffmodel/site/remaining.py` (row construction at lines 78–80; return dict at 84–86; new `load_evaluation`)
- Modify: `site/assets/seasontrade.js:31` (contract guard)
- Modify: `tests/seasontrade_fixture.cjs:7` (fixture remaining gets `evaluation:null`)
- Modify: `docs/trade-scenarios.md` (one sentence)
- Test: `tests/test_remaining.py`

**Interfaces:**
- Produces: `remaining.load_evaluation(slug, league_scoring, diagnostics_dir=Path("models/diagnostics"), reference_slug="gabagool", reference_scoring=None) -> dict | None`; `build_remaining(..., evaluation=None)` new keyword whose value is placed verbatim under `"evaluation"`; payload no longer carries `advice_eligible`; each `conditional_projection` week row carries `points: {"league": {p10,p50,p90}}` only and no `stat_quantiles`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_remaining.py` (and change the one existing assertion):

```python
# In test_frozen_history_missing_and_bye_distinct replace
#     assert out["advice_eligible"] is False
# with:
    assert "advice_eligible" not in out
    assert out["evaluation"] is None
    row = out["players"][0]["weeks"][0]
    assert row["points"] == {"league": {"p50": 10}}
    assert "stat_quantiles" not in row


def test_only_league_lens_survives_slimming(monkeypatch):
    args, _ = setup(monkeypatch)
    def predict(f, model, season, week, through, **kwargs):
        return {"players":[dict(player_id="a",name="Player",position="RB",team="A",opponent="B",
                points={"ppr":{"p50":9},"league":{"p10":4,"p50":10,"p90":16}},
                stat_quantiles={"p50":{"rushing_yards":50}})]}
    monkeypatch.setattr(R,"build_weekly_projections",predict)
    row = R.build_remaining(**args)["players"][0]["weeks"][0]
    assert row["points"] == {"league": {"p10":4,"p50":10,"p90":16}}
    assert "stat_quantiles" not in row and "ppr" not in row["points"]


def test_missing_league_lens_fails_closed(monkeypatch):
    args, _ = setup(monkeypatch)
    monkeypatch.setattr(R,"build_weekly_projections", lambda *a, **k: {"players":[dict(
        player_id="a",name="Player",position="RB",team="A",opponent="B",points={"ppr":{"p50":9}},stat_quantiles={})]})
    with pytest.raises(ValueError, match="league lens"):
        R.build_remaining(**args)


def test_evaluation_passes_through(monkeypatch):
    args, _ = setup(monkeypatch)
    block = {"source": "x.json", "horizons": []}
    assert R.build_remaining(**args, evaluation=block)["evaluation"] == block


def _write_diagnostic(tmp_path, name="remaining_matrix_gabagool.json"):
    import json
    (tmp_path / name).write_text(json.dumps({
        "schema_version": 1, "diagnostic": "remaining_matrix", "advice_eligible": False,
        "seasons": [2023, 2024, 2025], "origins": [5, 9], "horizons": [1, 2],
        "limitation": "Dependent windows; descriptive only.",
        "summary": [
            {"horizon": 1, "position": "ALL", "model_mae": 4.6121, "baseline_mae": 4.8154, "paired_player_forecasts": 1817},
            {"horizon": 1, "position": "QB", "model_mae": 7.9, "baseline_mae": 8.1, "paired_player_forecasts": 195},
            {"horizon": 2, "position": "ALL", "model_mae": 4.4521, "baseline_mae": 4.7221, "paired_player_forecasts": 1791},
        ]}))
    return tmp_path


def test_load_evaluation_reads_committed_diagnostic(tmp_path):
    d = _write_diagnostic(tmp_path)
    out = R.load_evaluation("gabagool", {"rec": 1}, diagnostics_dir=d)
    assert out["source"] == "models/diagnostics/remaining_matrix_gabagool.json"
    assert out["baseline"] == "mean league-scored production in the last four recorded pre-origin games"
    assert out["seasons"] == [2023, 2024, 2025] and out["origins"] == [5, 9]
    assert out["horizons"] == [
        {"horizon": 1, "model_mae": 4.612, "baseline_mae": 4.815, "paired_forecasts": 1817},
        {"horizon": 2, "model_mae": 4.452, "baseline_mae": 4.722, "paired_forecasts": 1791}]
    assert out["limitation"] == "Dependent windows; descriptive only."
    assert "scoring_scope" not in out


def test_load_evaluation_borrows_reference_only_when_scoring_matches(tmp_path):
    d = _write_diagnostic(tmp_path)
    same = R.load_evaluation("fam", {"rec": 1, "pass_td": 4}, diagnostics_dir=d,
                             reference_scoring={"pass_td": 4, "rec": 1})
    assert same["source"] == "models/diagnostics/remaining_matrix_gabagool.json"
    assert same["scoring_scope"] == "evaluated under gabagool scoring, which matches this league"
    assert R.load_evaluation("fam", {"rec": 0.5}, diagnostics_dir=d,
                             reference_scoring={"rec": 1}) is None
    assert R.load_evaluation("fam", {"rec": 1}, diagnostics_dir=d) is None  # no reference scoring given
    assert R.load_evaluation("gabagool", {"rec": 1}, diagnostics_dir=tmp_path / "nowhere") is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_remaining.py -q`
Expected: failures — `advice_eligible` still present, `stat_quantiles` still present, `load_evaluation` not defined, `evaluation` unexpected keyword.

- [ ] **Step 3: Implement in `src/ffmodel/site/remaining.py`**

Add after the imports:

```python
import json
from pathlib import Path

DIAGNOSTICS_DIR = Path("models/diagnostics")
BASELINE_DESCRIPTION = "mean league-scored production in the last four recorded pre-origin games"


def load_evaluation(slug, league_scoring, diagnostics_dir=DIAGNOSTICS_DIR,
                    reference_slug="gabagool", reference_scoring=None):
    """The measured remaining-season evaluation for this league, or None.

    Read from the committed `remaining_matrix_<slug>.json`, never typed in.
    Another league's diagnostic is borrowed only when the two leagues' Sleeper
    scoring dicts are equal, and then says so in `scoring_scope`."""
    diagnostics_dir = Path(diagnostics_dir)
    path = diagnostics_dir / f"remaining_matrix_{slug}.json"
    scope = None
    if not path.exists():
        if reference_scoring is None or slug == reference_slug:
            return None
        if not _scoring_equal(league_scoring, reference_scoring):
            return None
        path = diagnostics_dir / f"remaining_matrix_{reference_slug}.json"
        if not path.exists():
            return None
        scope = f"evaluated under {reference_slug} scoring, which matches this league"
    data = json.loads(path.read_text(encoding="utf-8"))
    horizons = [{"horizon": int(r["horizon"]), "model_mae": round(float(r["model_mae"]), 3),
                 "baseline_mae": round(float(r["baseline_mae"]), 3),
                 "paired_forecasts": int(r["paired_player_forecasts"])}
                for r in data.get("summary", []) if r.get("position") == "ALL"]
    horizons.sort(key=lambda r: r["horizon"])
    out = {"source": f"models/diagnostics/{path.name}", "baseline": BASELINE_DESCRIPTION,
           "seasons": list(data.get("seasons", [])), "origins": list(data.get("origins", [])),
           "horizons": horizons, "limitation": data.get("limitation")}
    if scope:
        out["scoring_scope"] = scope
    return out


def _scoring_equal(a, b):
    keys = set(a or {}) | set(b or {})
    return bool(keys) and all(float((a or {}).get(k, 0)) == float((b or {}).get(k, 0)) for k in keys)
```

Change the signature: `def build_remaining(weekly, schedules, predictor, season, start_week, *, current_teams, league, end_week=17, pick_six_prior=None, evaluation=None):`

Replace the conditional-projection row (lines 78–80):

```python
                points = p.get("points") or {}
                if not isinstance(points.get("league"), dict):
                    raise ValueError("league lens missing from weekly projection")
                row = {"week": week, "status": "conditional_projection",
                       "opponent": p["opponent"],
                       "points": {"league": dict(points["league"])}}
```

In the return dict replace `"advice_eligible": False,` with `"evaluation": evaluation,`.

- [ ] **Step 4: Update the JS contract guard and its fixture**

`site/assets/seasontrade.js:31` — replace `&&remaining.advice_eligible===false` with `&&remaining.evaluation!==undefined`. Message unchanged.

`tests/seasontrade_fixture.cjs:7` — replace `advice_eligible:false,` with `evaluation:null,`. Leave the `out.advice_eligible` assertion at line 14 alone: the *result* still declares itself not advice; only the payload flag moved.

`docs/trade-scenarios.md` — after the sentence "It fetches current league, rosters, catalog and NFL state read-only, verifies the scoring contract," add nothing; instead append at the end of the first paragraph under "Local conditional trade prototype": `The remaining-season artifact no longer carries an advice_eligible flag; it carries a measured evaluation block (see remaining-season-projections.md), and this prototype still returns advice_eligible:false for its own output.`

- [ ] **Step 5: Run the tests**

Run: `.venv/Scripts/python.exe -m pytest tests/test_remaining.py -q && node tests/seasontrade_fixture.cjs`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/ffmodel/site/remaining.py tests/test_remaining.py site/assets/seasontrade.js tests/seasontrade_fixture.cjs docs/trade-scenarios.md
git commit -m "feat: slim remaining payload, evaluation block replaces advice_eligible

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Publish `remaining-<slug>.json` fail-soft from the weekly workflow

**Files:**
- Modify: `src/ffmodel/site/generate.py:708-713` (the `if args.remaining:` block)
- Modify: `.github/workflows/weekly-update.yml:31-32` (ARGS line)
- Test: `tests/test_generate.py`

**Interfaces:**
- Consumes: `remaining.build_remaining(..., evaluation=...)` and `remaining.load_evaluation(...)` from Task 1.
- Produces: with `--week N --remaining`, `payloads["remaining-<slug>.json"]` when the build succeeds; when it raises, a line `remaining-season payload skipped: <error>` on stdout and no such payload — every other payload still written.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_generate.py`:

```python
def test_remaining_failure_is_skipped_not_fatal(monkeypatch, tmp_path, capsys):
    import json
    import ffmodel.data.future as future_mod
    import ffmodel.site.weekly as weekly_mod
    import ffmodel.site.remaining as remaining_mod
    monkeypatch.setattr(future_mod, "combined_future_features", lambda *a, **k: (None, None))
    monkeypatch.setattr(weekly_mod, "build_weekly_projections", lambda *a, **k: {"players": []})

    def boom(*a, **k):
        raise ValueError("no observed pre-slate history")
    monkeypatch.setattr(remaining_mod, "build_remaining", boom)
    _run_generate_with_stubs(monkeypatch, tmp_path, ["--week", "6", "--remaining"], {})
    out = tmp_path / "out"
    assert (out / "weekly.json").exists()
    assert not (out / "remaining-gabagool.json").exists()
    assert "remaining-season payload skipped: no observed pre-slate history" in capsys.readouterr().out


def test_remaining_success_is_published_with_evaluation(monkeypatch, tmp_path):
    import json
    import ffmodel.data.future as future_mod
    import ffmodel.site.weekly as weekly_mod
    import ffmodel.site.remaining as remaining_mod
    monkeypatch.setattr(future_mod, "combined_future_features", lambda *a, **k: (None, None))
    monkeypatch.setattr(weekly_mod, "build_weekly_projections", lambda *a, **k: {"players": []})
    seen = {}

    def fake_build(weekly, schedules, predictor, season, start_week, **kw):
        seen.update(kw)
        return {"schema_version": 1, "players": [], "evaluation": kw.get("evaluation")}
    monkeypatch.setattr(remaining_mod, "build_remaining", fake_build)
    monkeypatch.setattr(remaining_mod, "load_evaluation", lambda *a, **k: {"source": "stub"})
    _run_generate_with_stubs(monkeypatch, tmp_path, ["--week", "6", "--remaining"], {})
    payload = json.loads((tmp_path / "out" / "remaining-gabagool.json").read_text())
    assert payload["evaluation"] == {"source": "stub"}
    assert seen["evaluation"] == {"source": "stub"}
    assert seen["league"]["slug"] == "gabagool"


def test_weekly_workflow_publishes_remaining_for_both_leagues():
    text = Path(".github/workflows/weekly-update.yml").read_text(encoding="utf-8")
    assert 'ARGS="$ARGS --week auto --remaining"' in text
    assert "for LEAGUE in gabagool fam; do" in text
```

(`Path` is already imported at the top of `tests/test_generate.py`; if not, add `from pathlib import Path`.)

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest tests/test_generate.py -q -k "remaining"`
Expected: FAIL — the first test raises `ValueError` out of `main()`, the second gets no `evaluation` kwarg, the third finds no `--remaining` in the workflow.

- [ ] **Step 3: Implement**

`src/ffmodel/site/generate.py` — replace the `if args.remaining:` block (lines 708–713) with:

```python
        if args.remaining:
            # Optional payload, fail-soft: a remaining-season failure must never
            # block the weekly slate. The previously published file stays put and
            # the waiver desk's own 72-hour freshness guard withholds drop pricing.
            from ffmodel.site import remaining as remaining_mod
            try:
                reference = load_league("gabagool")
                evaluation = remaining_mod.load_evaluation(
                    cfg.slug, cfg.sleeper_scoring,
                    reference_scoring=reference.sleeper_scoring)
                payloads[f"remaining-{cfg.slug}.json"] = remaining_mod.build_remaining(
                    weekly, schedules, predictor, args.season, week,
                    current_teams=current_teams, league=cfg.payload(),
                    end_week=max(week, 17), pick_six_prior=pick_six_prior,
                    evaluation=evaluation)
            except Exception as exc:  # noqa: BLE001 — optional payload, reported not raised
                print(f"remaining-season payload skipped: {exc}")
```

`load_league` is already imported inside `main()` at line 558 (`from ffmodel.league import load_league`); confirm the name is in scope where this block runs (it is the same function body).

`.github/workflows/weekly-update.yml` line 32 — change

```yaml
          if [ "${{ inputs.draft }}" = "true" ]; then ARGS="$ARGS --draft"; else ARGS="$ARGS --week auto"; fi
```
to
```yaml
          if [ "${{ inputs.draft }}" = "true" ]; then ARGS="$ARGS --draft"; else ARGS="$ARGS --week auto --remaining"; fi
```

Also add `site/data/remaining-*.json` nowhere special — `git add site/data` in the commit step already covers it.

- [ ] **Step 4: Run the tests**

Run: `.venv/Scripts/python.exe -m pytest tests/test_generate.py tests/test_remaining.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/site/generate.py .github/workflows/weekly-update.yml tests/test_generate.py
git commit -m "feat: publish remaining-season payload fail-soft for both leagues

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Engine — `remainingMap`, `rosValue`, and three-state drop cost

**Files:**
- Modify: `site/assets/waivers.js` (new `remainingMap` after `kickoffMap`; `dropCostOf` rewritten; `bidGuide` signature/precedence; `analyze` — new arg, `coverage.ros`, warnings, `compare`)
- Test: `tests/waivers_fixture.cjs`

**Interfaces:**
- Consumes: payload shape from Task 1 (`season, start_week, end_week, generated_at, data_through, league{league_id, sleeper_scoring}, evaluation, players[{player_id, team, weeks[{week,status,points{league{p50}}}]}]`).
- Produces: `W.analyze({..., remaining})` — every row's `dropCost` in one of the three fixed key sets; `signal.perWeekGain` (per-week move value or fallback), `signal.moveValue`, `signal.basis` ∈ `"move" | "this_week" | "proxy"`; `coverage.ros = {fresh, reason, endWeek, futureWeeks, generatedAt, dataThrough, pricedOwned, unmodeledOwned:[{id,name}], pricedFreeAgents, evaluation}`; `bid.tier` may now be `"drop costs more than the add returns"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/waivers_fixture.cjs` **before** the final `console.log` line:

```js
// --- rest-of-season drop cost --------------------------------------------------
// Week 1 is the analysed week; weeks 2 and 3 are the priced future. Fixture
// roster 1 (fresh) starts QB1 RB2 WR3 TE4 and FLEX WR8; free agent RB7 is the add.
const remainingLeague = { league_id:"L1", slug:"fixture", sleeper_scoring:{pass_td:4,rec:1} };
const rosRow = (week, p50) => p50 === "bye" ? { week, status:"bye", points:null }
  : p50 === null ? { week, status:"unmodeled", points:null, reason:"no_observed_history" }
  : { week, status:"conditional_projection", opponent:"B", points:{ league:{ p10:p50-3, p50, p90:p50+3 } } };
const remainingFor = (future, overrides={}) => ({
  schema_version:1, horizon:"remaining_season", status:"experimental", season:2026, start_week:1, end_week:3,
  generated_at:new Date(TEST_NOW).toISOString(), data_through:"2026-wk00", league:remainingLeague, evaluation:null,
  players: Object.entries(future).map(([gsis, [w2, w3, team]]) => ({ player_id:gsis, team: team || "A", weeks:[rosRow(1, 1), rosRow(2, w2), rosRow(3, w3)] })),
  ...overrides,
});
// Everyone keeps their weekly number in weeks 2–3 unless overridden.
const steadyFuture = () => ({ g1:[20,20], g2:[10,10], g3:[11,11], g4:[8,8], g8:[5,5], g7:[12,12], g9:[25,25], g10:[13,13], g99:[30,30] });
const rosBase = () => ({ ...base, rosters:freshRosters, weekly:freshWeekly() });

check("priced swap: bench drop forfeits nothing, add's future contribution sets the band", () => {
  const out = W.analyze({ ...rosBase(), remaining: remainingFor(steadyFuture()) });
  const row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.lineupGain, 11);
  assert.deepEqual(Object.keys(row.dropCost).sort(), ["addContributes","dropForfeits","endWeek","futureWeeks","label","rosDelta","status"]);
  assert.equal(row.dropCost.status, "priced");
  // R per future week 54; R+RB7 per week 61 (RB7 takes FLEX over WR8); R+RB7−WR8 still 61.
  assert.equal(row.dropCost.addContributes, 14); assert.equal(row.dropCost.dropForfeits, 0); assert.equal(row.dropCost.rosDelta, 14);
  assert.deepEqual([row.dropCost.futureWeeks, row.dropCost.endWeek], [2, 3]);
  assert.equal(row.signal.moveValue, 25); assert.equal(row.signal.basis, "move");
  assert.ok(Math.abs(row.signal.perWeekGain - 25/3) < 0.01);
  assert.match(row.signal.label, /^modeled lineup gain this week plus rest-of-season lineup change; projection error is not quantified/);
  assert.equal(row.rosterCost, "dropping WR8 forfeits 0.00 projected lineup points over weeks 2–3; RB7 adds 14.00 in his place");
  assert.deepEqual([row.bid.tier, row.bid.low, row.bid.high, row.bid.status], ["impact", 11, 20, null]);
  assert.equal(row.bid.label, "heuristic, not calibrated and not a win probability");
  assert.ok(out.coverage.ros.fresh); assert.equal(out.coverage.ros.reason, null);
  assert.deepEqual([out.coverage.ros.endWeek, out.coverage.ros.futureWeeks, out.coverage.ros.dataThrough], [3, 2, "2026-wk00"]);
  assert.equal(out.coverage.ros.pricedOwned, 5); assert.deepEqual(out.coverage.ros.unmodeledOwned, []);
  assert.equal(out.coverage.ros.evaluation, null);
  assert.ok(!out.warnings.some(w => /rest-of-season cost is not priced/.test(w)));
});

check("net-negative swap reports both numbers and withholds spend", () => {
  // Free agent RB12 scores 12 this week but ~1 afterwards; dropping RB2 (10 every week) loses the season.
  const richBoard = { players: board.players.concat([p(12,"RB",4)]) };
  const weekly = freshWeekly(richBoard.players); weekly.players.find(x => x.player_id==="g12").points.league.p50 = 12;
  const out = W.analyze({ ...rosBase(), board:richBoard, weekly, remaining: remainingFor({ ...steadyFuture(), g12:[1,1] }) });
  const row = out.rows.find(r => r.add.id==="12" && r.drop.id==="2");
  assert.equal(row.lineupGain, 2);
  // R+RB12 per week: RB slot 10, FLEX max(WR8 5, RB12 1) = 5 → 54, adds 0; without RB2: RB slot 1 → 45, forfeits 9/week.
  assert.deepEqual([row.dropCost.status, row.dropCost.addContributes, row.dropCost.dropForfeits, row.dropCost.rosDelta], ["priced", 0, 18, -18]);
  assert.equal(row.signal.moveValue, -16);
  assert.deepEqual([row.bid.low, row.bid.high, row.bid.tier, row.bid.canAfford], [null, null, "drop costs more than the add returns", true]);
  assert.equal(row.bid.status, "no bid suggested: dropping RB2 forfeits 18.00 rest-of-season lineup points against 0.00 from RB12");
  assert.match(row.signal.guidance, /^no bid suggested; dropping RB2 forfeits 18\.00/);
  assert.doesNotMatch(row.bid.status + row.signal.guidance + row.rosterCost, /wrong|right|\$/);
  // RB12 for RB2, WR3 or WR8 all lose the season: three net-negative rows.
  assert.match(out.warnings.join(" "), /3 alternative\(s\) would forfeit more rest-of-season lineup value than the add returns/);
});

check("unmodeled add or drop is unassessed with the player named, never priced at zero", () => {
  const future = steadyFuture();
  let out = W.analyze({ ...rosBase(), remaining: remainingFor({ ...future, g7:[null,12] }) });
  let row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.deepEqual(Object.keys(row.dropCost).sort(), ["label","reason","status"]);
  assert.equal(row.dropCost.status, "unassessed"); assert.equal(row.dropCost.reason, "RB7 has no rest-of-season projection");
  assert.equal(row.signal.basis, "this_week"); assert.equal(row.signal.perWeekGain, 11);
  assert.deepEqual([row.bid.low, row.bid.high, row.bid.tier], [null, null, "drop cost unassessed"]);
  assert.equal(row.bid.status, "no bid suggested: drop cost unassessed — RB7 has no rest-of-season projection");
  delete future.g8;
  out = W.analyze({ ...rosBase(), remaining: remainingFor(future) });
  row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.dropCost.reason, "WR8 has no rest-of-season projection");
  out = W.analyze({ ...rosBase(), remaining: remainingFor({ ...future, g7:[null,null] }) });
  row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.dropCost.reason, "RB7 and WR8 have no rest-of-season projection");
  assert.deepEqual(out.coverage.ros.unmodeledOwned, [{ id:"8", name:"WR8" }]);
  assert.equal(out.coverage.ros.pricedOwned, 4);
  assert.match(out.warnings.join(" "), /1 roster player\(s\) have no rest-of-season projection and are excluded from future lineups: WR8/);
});

check("bye weeks count as zero, not unmodeled; a team mismatch is unmodeled", () => {
  let out = W.analyze({ ...rosBase(), remaining: remainingFor({ ...steadyFuture(), g7:["bye",12] }) });
  let row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  // Week 2: RB7 on bye → FLEX WR8 5 → 54; week 3: 61 → adds 7. Without WR8 the bye week's FLEX
  // is RB7's 0 → 49, so the drop forfeits 5 and the net is +2: byes are real weeks, not gaps.
  assert.deepEqual([row.dropCost.status, row.dropCost.addContributes, row.dropCost.dropForfeits, row.dropCost.rosDelta], ["priced", 7, 5, 2]);
  out = W.analyze({ ...rosBase(), remaining: remainingFor({ ...steadyFuture(), g7:[12,12,"Z"] }) });
  row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.dropCost.status, "unassessed"); assert.equal(row.dropCost.reason, "RB7 has no rest-of-season projection");
});

check("stale or misaligned remaining payload withholds drop pricing with the reason; open slots keep this week's basis", () => {
  const cases = [
    [undefined, "remaining-season projections unavailable"],
    [remainingFor(steadyFuture(), { league:{ ...remainingLeague, league_id:"L2" } }), "remaining-season league id does not match live league"],
    [remainingFor(steadyFuture(), { league:{ ...remainingLeague, sleeper_scoring:{ pass_td:6, rec:1 } } }), "remaining-season scoring contract is incomplete or does not match live league"],
    [remainingFor(steadyFuture(), { season:2025 }), "remaining-season season does not match league season"],
    [remainingFor(steadyFuture(), { start_week:2 }), "remaining-season start week does not match requested week"],
    [remainingFor(steadyFuture(), { generated_at:new Date(TEST_NOW - 73*3600000).toISOString() }), "remaining-season projections are stale (over 72 hours old)"],
    [remainingFor(steadyFuture(), { generated_at:new Date(TEST_NOW + 2*3600000).toISOString() }), "remaining-season projections are stale (over 72 hours old)"],
    [remainingFor(steadyFuture(), { players:null }), "remaining-season payload is incomplete"],
    [remainingFor(steadyFuture(), { end_week:0 }), "remaining-season payload is incomplete"],
  ];
  for (const [remaining, reason] of cases) {
    const out = W.analyze({ ...rosBase(), remaining });
    const row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
    assert.equal(out.coverage.ros.fresh, false, reason); assert.equal(out.coverage.ros.reason, reason);
    assert.equal(row.dropCost.status, "unassessed", reason); assert.equal(row.dropCost.reason, reason);
    assert.equal(row.bid.tier, "drop cost unassessed", reason);
    assert.match(out.warnings.join(" "), new RegExp(`${reason.replace(/[()]/g, "\\$&")}; drop costs unassessed, spend guidance limited to open-slot adds`));
  }
  // Open slot with no payload: unchanged behaviour, rosDelta null, this week's basis.
  const slotLeague = { ...league, roster_positions:["QB","RB","WR","TE","K","DEF","BN","IR","TAXI"] };
  const slotRosters = [{ roster_id:1, players:["1","2","3","4","5","6","99"], reserve:["99"], taxi:[], settings:{ waiver_budget_used:40 } }, rosters[1]];
  const out = W.analyze({ ...base, league:slotLeague, rosters:slotRosters, weekly:freshWeekly(), protectedIds:["1","2","3","4"] });
  const open = out.rows.find(r => r.add.id==="7");
  assert.equal(open.drop, null);
  assert.deepEqual(Object.keys(open.dropCost).sort(), ["addContributes","endWeek","futureWeeks","label","rosDelta","status"]);
  assert.deepEqual([open.dropCost.status, open.dropCost.rosDelta, open.dropCost.addContributes], ["open_slot", null, null]);
  assert.equal(open.signal.basis, "this_week"); assert.equal(open.signal.perWeekGain, open.lineupGain);
  assert.match(open.rosterCost, /^uses an open roster spot; RB7's rest-of-season contribution is not priced/);
});

check("open-slot adds move to the total-value basis when priced; a one-week fill earns less than a season-long add", () => {
  const slotLeague = { ...league, roster_positions:["QB","RB","WR","TE","K","DEF","BN","IR","TAXI"] };
  const slotRosters = [{ roster_id:1, players:["1","2","3","4","5","6","99"], reserve:["99"], taxi:[], settings:{ waiver_budget_used:40 } }, rosters[1]];
  const run = future => W.analyze({ ...base, league:slotLeague, rosters:slotRosters, weekly:freshWeekly(), protectedIds:["1","2","3","4"], remaining: remainingFor({ g1:[20,20], g2:[10,10], g3:[11,11], g4:[8,8], g7:future }) });
  const season = run([12,12]).rows.find(r => r.add.id==="7");
  const oneWeek = run([0,0]).rows.find(r => r.add.id==="7");
  // No FLEX: RB7 (18 this week) displaces RB2 (10) → gain 8; future RB slot 12 vs 10 → +2/week.
  assert.equal(season.lineupGain, 8); assert.deepEqual([season.dropCost.status, season.dropCost.addContributes, season.dropCost.rosDelta], ["open_slot", 4, 4]);
  assert.equal(season.signal.moveValue, 12); assert.ok(Math.abs(season.signal.perWeekGain - 4) < 0.01);
  assert.equal(oneWeek.lineupGain, 8); assert.equal(oneWeek.dropCost.rosDelta, 0);
  assert.ok(Math.abs(oneWeek.signal.perWeekGain - 8/3) < 0.01);
  assert.ok(season.signal.perWeekGain > oneWeek.signal.perWeekGain);
  assert.equal(season.rosterCost, "uses an open roster spot; RB7 adds 4.00 over weeks 2–3; roster flexibility is not priced");
  assert.deepEqual([season.bid.tier, oneWeek.bid.tier], ["useful", "useful"]);
});

check("guidance precedence: affordability, then net-negative, then weak, then unassessed, then bands", () => {
  const rich = { players: board.players.concat([p(12,"RB",4)]) };
  const weekly = freshWeekly(rich.players); weekly.players.find(x => x.player_id==="g12").points.league.p50 = 12;
  const remaining = remainingFor({ ...steadyFuture(), g12:[1,1] });
  // 1. affordability beats everything, including a net-negative swap.
  let out = W.analyze({ ...rosBase(), board:rich, weekly, remaining, league:{ ...league, settings:{ waiver_budget:100, waiver_bid_min:50 } } });
  let row = out.rows.find(r => r.add.id==="12" && r.drop.id==="2");
  assert.deepEqual([row.bid.canAfford, row.bid.status], [false, "minimum bid exceeds spendable budget"]);
  // 2. net-negative beats weak: perWeekValue is negative, but the row is not called weak.
  out = W.analyze({ ...rosBase(), board:rich, weekly, remaining });
  row = out.rows.find(r => r.add.id==="12" && r.drop.id==="2");
  assert.equal(row.signal.strength, "modeled"); assert.equal(row.bid.tier, "drop costs more than the add returns");
  // 3. weak beats unassessed: a tiny gain with no payload is still "weak signal", as shipped.
  const small = freshWeekly(); small.players.find(x => x.player_id==="g7").points.league.p50 = 7.4;
  out = W.analyze({ ...rosBase(), weekly:small });
  row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.signal.strength, "weak"); assert.equal(row.bid.tier, "weak signal"); assert.equal(row.dropCost.status, "unassessed");
  // 4. a priced move can be weak on the per-week number even when this week's gain is not.
  out = W.analyze({ ...rosBase(), weekly:(() => { const w = freshWeekly(); w.players.find(x => x.player_id==="g7").points.league.p50 = 9; return w; })(), remaining: remainingFor({ ...steadyFuture(), g7:[5,5] }) });
  row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
  assert.equal(row.lineupGain, 2); assert.equal(row.dropCost.rosDelta, 0); assert.ok(Math.abs(row.signal.perWeekGain - 2/3) < 0.01);
  assert.equal(row.signal.strength, "weak");
});

check("rosValue decomposition identity and brute-force equivalence on random rosters", () => {
  let seed = 7; const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let trial = 0; trial < 40; trial++) {
    const future = {}; for (const k of Object.keys(steadyFuture())) future[k] = [Math.round(rand()*20), Math.round(rand()*20)];
    const out = W.analyze({ ...rosBase(), remaining: remainingFor(future) });
    for (const r of out.rows.filter(r => r.dropCost.status === "priced")) {
      assert.ok(Math.abs(r.dropCost.rosDelta - (r.dropCost.addContributes - r.dropCost.dropForfeits)) < 1e-6);
      assert.ok(r.dropCost.dropForfeits >= -1e-9 && r.dropCost.addContributes >= -1e-9);
    }
    // Brute force the headline row: RB7 for WR8.
    const row = out.rows.find(r => r.add.id==="7" && r.drop.id==="8");
    if (!row) continue;
    const pts = (g, w) => future[g][w-2];
    const val = (ids, w) => { // QB, RB, WR, TE, FLEX(best remaining RB/WR/TE)
      const by = { QB:[], RB:[], WR:[], TE:[] }; for (const i of ids) by[board.players.find(x => x.sleeper_id===i).position].push(pts(`g${i}`, w));
      for (const k in by) by[k].sort((a,b)=>b-a);
      const flex = [...by.RB.slice(1), ...by.WR.slice(1), ...by.TE.slice(1)].sort((a,b)=>b-a);
      return by.QB[0] + by.RB[0] + by.WR[0] + by.TE[0] + (flex[0] ?? -Infinity);
    };
    const R = ["1","2","3","4","8"], RA = R.concat("7"), RAD = RA.filter(i => i !== "8");
    const ros = ids => val(ids,2) + val(ids,3);
    assert.ok(Math.abs(row.dropCost.addContributes - (ros(RA) - ros(R))) < 1e-6);
    assert.ok(Math.abs(row.dropCost.dropForfeits - (ros(RA) - ros(RAD))) < 1e-6);
  }
});

check("priced path stays inside the existing performance bound", () => {
  const bigBoard = { players: Array.from({ length: 700 }, (_, i) => p(1000 + i, ["QB","RB","WR","TE"][i % 4], 5 + (i % 30))) };
  const big = { league_id:"L1", season:2026, total_rosters:2, scoring_settings:{pass_td:4,rec:1}, roster_positions:["QB","RB","RB","WR","WR","TE","FLEX","FLEX","K","DEF","BN","BN","BN","BN","BN","IR"], settings:{ waiver_budget:100, waiver_bid_min:1 } };
  const mine = bigBoard.players.slice(0, 15).map(x => x.sleeper_id);
  const bigRosters = [{ roster_id:1, players:mine, starters:mine.slice(0, 8).concat(["0","0"]), reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }, { roster_id:2, players:[], reserve:[], taxi:[], settings:{ waiver_budget_used:0 } }];
  const future = {}; for (const x of bigBoard.players) future[x.player_id] = Array.from({ length: 2 }, () => x.value_points);
  const remaining = remainingFor(future, { end_week: 17, players: bigBoard.players.map(x => ({ player_id:x.player_id, team:"A", weeks: Array.from({ length: 17 }, (_, i) => rosRow(i + 1, x.value_points)) })) });
  const t0 = Date.now();
  const out = W.analyze({ ...base, board:bigBoard, league:big, rosters:bigRosters, weekly:freshWeekly(bigBoard.players), remaining, protectedIds:[] });
  assert.ok(out.rows.length > 0 && out.rows.some(r => r.dropCost.status === "priced"));
  assert.ok(Date.now() - t0 < 4000, `priced analysis took ${Date.now() - t0} ms`);
});
```

In the existing check `"every required drop withholds spend guidance regardless of preseason board value"`, change the key assertion at line 314 from `["label","status"]` to `["label","reason","status"]` and keep its message.

- [ ] **Step 2: Run to verify failure**

Run: `node tests/waivers_fixture.cjs`
Expected: the first new check fails (`dropCost.status` is `"unassessed"`, keys differ).

- [ ] **Step 3: Implement in `site/assets/waivers.js`**

After `kickoffMap` (ends line 157) add:

```js
  // Rest-of-season projections, guarded like weeklyMap: same league, same
  // scoring contract, same season, start week equal to the analysed week,
  // fresh within 72 hours. Returns per-player per-week points for the FUTURE
  // weeks only (week > analysed week): a bye is 0, an unmodeled or missing
  // week is null and marks the player unmodeled. Unknown is never zero.
  function remainingMap(remaining, league, week, boardByGsis, now) {
    const none = reason => ({ fresh:false, reason, endWeek:null, generatedAt:null, dataThrough:null, at:new Map(), unmodeled:new Set(), evaluation:null });
    if (!remaining) return none("remaining-season projections unavailable");
    const rl = remaining.league, live = league.scoring_settings, rs = rl && rl.sleeper_scoring;
    const scoringMatches = live && rs && typeof live === "object" && typeof rs === "object" &&
      Object.keys(live).length > 0 && Object.keys(rs).length > 0 &&
      [...new Set([...Object.keys(live), ...Object.keys(rs)])].every(k => {
        const a = Object.hasOwn(live, k) ? finite(live[k]) : 0, b = Object.hasOwn(rs, k) ? finite(rs[k]) : 0;
        return a !== null && b !== null && a === b;
      });
    const generated = Date.parse(remaining.generated_at), age = now - generated;
    const expectedWeek = finite(week), endWeek = finite(remaining.end_week);
    if (!rl || id(rl.league_id) !== id(league.league_id)) return none("remaining-season league id does not match live league");
    if (!scoringMatches) return none("remaining-season scoring contract is incomplete or does not match live league");
    if (finite(remaining.season) === null || finite(league.season) === null || finite(remaining.season) !== finite(league.season)) return none("remaining-season season does not match league season");
    if (finite(remaining.start_week) === null || expectedWeek === null || finite(remaining.start_week) !== expectedWeek) return none("remaining-season start week does not match requested week");
    if (!Number.isFinite(generated) || age < -3600000 || age > 72 * 3600000) return none("remaining-season projections are stale (over 72 hours old)");
    if (!Array.isArray(remaining.players) || endWeek === null || !Number.isInteger(endWeek) || endWeek < expectedWeek) return none("remaining-season payload is incomplete");
    const at = new Map(), unmodeled = new Set();
    remaining.players.forEach(r => {
      const bp = boardByGsis.get(id(r.player_id));
      const pid = playerId(bp);
      if (!bp || pid === null || pid === undefined) return;
      const rows = new Map();
      const teamOk = playerTeam(bp) && team(r.team) === playerTeam(bp);
      for (let w = expectedWeek + 1; w <= endWeek; w++) {
        const row = (r.weeks || []).find(x => finite(x.week) === w);
        let v = null;
        if (teamOk && row && row.status === "bye") v = 0;
        else if (teamOk && row && row.status === "conditional_projection") v = finite(row.points && row.points.league && row.points.league.p50);
        if (v === null) unmodeled.add(id(pid));
        rows.set(w, v);
      }
      at.set(id(pid), rows);
    });
    return { fresh:true, reason:null, endWeek, generatedAt:remaining.generated_at, dataThrough:remaining.data_through ?? null, at, unmodeled,
             evaluation: remaining.evaluation === undefined ? null : remaining.evaluation };
  }
```

Replace `dropCostOf` and `bidGuide` (lines 169–192) with:

```js
  const r2 = x => Math.round(x * 100) / 100;
  const fmt = x => x.toFixed(2);
  // Three states, fixed key sets (the fixture asserts them). Pricing is the
  // roster-aware rest-of-season lineup change, split against R+A: what the add
  // contributes to the roster, and what the drop then forfeits given the add
  // is on it. A bench player who never starts forfeits ~0 whatever his total.
  function dropCostOf(drop, add, ros) {
    const names = x => x.name || x.full_name || id(playerId(x));
    if (!ros || !ros.fresh) {
      if (!drop) return { status:"open_slot", label:"no drop required; future roster flexibility is not priced", addContributes:null, rosDelta:null, futureWeeks:null, endWeek:null };
      return { status:"unassessed", label:"drop cost unassessed: the dropped player's rest-of-season value is not priced, so no spend guidance is offered", reason: ros ? ros.reason : "remaining-season projections unavailable" };
    }
    const missing = [add, drop].filter(x => x && ros.isUnmodeled(x));
    if (missing.length) {
      const reason = `${missing.map(names).join(" and ")} ${missing.length > 1 ? "have" : "has"} no rest-of-season projection`;
      if (!drop) return { status:"open_slot", label:"no drop required; future roster flexibility is not priced", addContributes:null, rosDelta:null, futureWeeks:ros.futureWeeks, endWeek:ros.endWeek };
      return { status:"unassessed", label:"drop cost unassessed: the dropped player's rest-of-season value is not priced, so no spend guidance is offered", reason };
    }
    const withAdd = ros.value(ros.roster.concat([add]));
    const addContributes = withAdd - ros.baseline;
    if (!drop) {
      if (!Number.isFinite(addContributes)) return { status:"open_slot", label:"no drop required; future roster flexibility is not priced", addContributes:null, rosDelta:null, futureWeeks:ros.futureWeeks, endWeek:ros.endWeek };
      return { status:"open_slot", label:"no drop required; roster flexibility is not priced", addContributes:r2(addContributes), rosDelta:r2(addContributes), futureWeeks:ros.futureWeeks, endWeek:ros.endWeek };
    }
    const after = ros.value(ros.roster.filter(x => id(playerId(x)) !== id(playerId(drop))).concat([add]));
    const dropForfeits = withAdd - after, rosDelta = after - ros.baseline;
    if (![withAdd, after, ros.baseline].every(Number.isFinite))
      return { status:"unassessed", label:"drop cost unassessed: the dropped player's rest-of-season value is not priced, so no spend guidance is offered", reason:"roster cannot field a full lineup from modeled players in every future week" };
    return { status:"priced", label:`priced: rest-of-season lineup change over weeks ${ros.firstWeek}–${ros.endWeek}, assuming participation`,
             addContributes:r2(addContributes), dropForfeits:r2(dropForfeits), rosDelta:r2(rosDelta), futureWeeks:ros.futureWeeks, endWeek:ros.endWeek };
  }
  // `gain` is the per-week value the bands read (move value per week, or this
  // week's gain under the fallback). Precedence, first match wins: affordability,
  // net-negative (priced only), weak, unassessed, bands.
  function bidGuide(gain, total, remaining, reserve, minBid, weak, dropCost, move) {
    let pct = [0, 0], tier = "no bid";
    if (gain > 0 && gain < 2) { pct = [0.01, 0.03]; tier = "small"; }
    else if (gain >= 2 && gain < 5) { pct = [0.04, 0.10]; tier = "useful"; }
    else if (gain >= 5) { pct = [0.11, 0.20]; tier = "impact"; }
    const affordable = Math.max(0, remaining - reserve);
    if ((move ? move.lineupGain : gain) > 0 && affordable < minBid) {
      return { low: null, high: null, tier, affordable, canAfford: false, status: "minimum bid exceeds spendable budget", label: BID_LABEL };
    }
    if (dropCost && dropCost.status === "priced" && move && move.moveValue <= 0) {
      return { low: null, high: null, tier: "drop costs more than the add returns", affordable, canAfford: true,
               status: `no bid suggested: dropping ${move.dropName} forfeits ${fmt(dropCost.dropForfeits)} rest-of-season lineup points against ${fmt(dropCost.addContributes)} from ${move.addName}`, label: BID_LABEL };
    }
    if (weak) {
      return { low: null, high: null, tier: "weak signal", affordable, canAfford: true, status: `no bid suggested: modeled gain is under ${WEAK_SIGNAL_PTS.toFixed(1)} pt/week`, label: BID_LABEL };
    }
    if (dropCost && dropCost.status === "unassessed") {
      return { low: null, high: null, tier: "drop cost unassessed", affordable, canAfford: true, status: `no bid suggested: drop cost unassessed — ${dropCost.reason}`, label: BID_LABEL };
    }
    let low = Math.min(affordable, Math.ceil(total * pct[0]));
    let high = Math.min(affordable, Math.ceil(total * pct[1]));
    if (gain > 0) { low = Math.max(minBid, low); high = Math.max(low, high); }
    return { low, high, tier, affordable, canAfford: true, status: null, label: BID_LABEL };
  }
```

In `analyze`, after `const kickoffs = …` / the kickoff checks (after line 321, before `const remainingWeeks = …`), build the ROS context. Insert **after** `const droppable = …` and `const hasOpenSlot = …` (line 353) so `ownActive` and `starterSlots` are in scope:

```js
    // Rest-of-season context. Future weeks have no locked starters, so the
    // future roster is every active skill player; a roster player unmodeled
    // in some week is excluded from that week's lineup (never zeroed) and
    // reported, not silently absorbed.
    const rosMap = weekly.fresh ? remainingMap(args.remaining, league, args.week, boardByGsis, now)
                                : { fresh:false, reason:"preseason proxy mode; rest-of-season pricing applies in season only", at:new Map(), unmodeled:new Set(), endWeek:null, generatedAt:null, dataThrough:null, evaluation:null };
    const futureRoster = ownActive.filter(p => SKILL.has(position(p)));
    const firstFuture = (finite(args.week) || 1) + 1;
    const pointsAt = (p, w) => { const rows = rosMap.at.get(id(playerId(p))); return rows && rows.has(w) ? rows.get(w) : null; };
    const rosValue = players => { let total = 0; for (let w = firstFuture; w <= rosMap.endWeek; w++) total += lineupScore(players, starterSlots, p => pointsAt(p, w)); return total; };
    // A player absent from the payload is unmodeled exactly like one whose
    // week rows are null: no entry, no price.
    const rosUnmodeled = p => rosMap.unmodeled.has(id(playerId(p))) || !rosMap.at.has(id(playerId(p)));
    const ros = rosMap.fresh ? { fresh:true, reason:null, roster:futureRoster, value:rosValue, baseline:rosValue(futureRoster), isUnmodeled:rosUnmodeled,
                                 firstWeek:firstFuture, endWeek:rosMap.endWeek, futureWeeks:rosMap.endWeek - (finite(args.week) || 1) } : { fresh:false, reason:rosMap.reason };
    const rosUnmodeledOwned = rosMap.fresh ? futureRoster.filter(rosUnmodeled).map(p => ({ id:id(playerId(p)), name:p.name || p.full_name || id(playerId(p)) })) : [];
    if (weekly.fresh && !rosMap.fresh) warnings.push(`${rosMap.reason}; drop costs unassessed, spend guidance limited to open-slot adds`);
    if (rosUnmodeledOwned.length) warnings.push(`${rosUnmodeledOwned.length} roster player(s) have no rest-of-season projection and are excluded from future lineups: ${rosUnmodeledOwned.map(x => x.name).join(", ")}`);
```

Note `mapped` is defined at line 336 (`const mapped = p => …`) — this block must sit after it; placing it after `hasOpenSlot` satisfies that.

Rewrite the body of `compare` (lines 355–393) as:

```js
    const compare = (add, drop) => {
      const next = availableOwn.filter(p => !drop || id(playerId(p)) !== id(playerId(drop))).concat([add]);
      const result = lineupScore(next, remainingStarterSlots, score);
      if (!Number.isFinite(result)) return;
      const gain = Math.round((result - baseline) * 100) / 100;
      if (gain <= 0) return;
      const valueEstimate = boardPoints(add);
      const addName = add.name || add.full_name || id(playerId(add));
      const dropName = drop ? (drop.name || drop.full_name || id(playerId(drop))) : null;
      const dropCost = dropCostOf(drop, add, ros);
      const priced = dropCost.rosDelta !== null && dropCost.rosDelta !== undefined;
      const moveValue = priced ? r2(gain + dropCost.rosDelta) : null;
      const basis = !weekly.fresh ? "proxy" : priced ? "move" : "this_week";
      const perWeekGain = basis === "proxy" ? Math.round((gain / remainingWeeks) * 100) / 100
        : basis === "move" ? r2(moveValue / (dropCost.futureWeeks + 1)) : gain;
      const netNegative = dropCost.status === "priced" && moveValue <= 0;
      const weak = !netNegative && perWeekGain < WEAK_SIGNAL_PTS;
      const unassessed = dropCost.status === "unassessed";
      const span = priced ? `weeks ${firstFuture}–${dropCost.endWeek}` : null;
      const signal = {
        strength: weak ? "weak" : "modeled", perWeekGain, thresholdPerWeek: WEAK_SIGNAL_PTS, moveValue, basis,
        label: weak
          ? `weak signal: under ${WEAK_SIGNAL_PTS.toFixed(1)} projected pt/week, below the conservative product threshold — research only, not a bid or priority claim`
          : basis === "move"
            ? "modeled lineup gain this week plus rest-of-season lineup change; projection error is not quantified and no claim-success probability is implied"
            : "modeled lineup gain; projection error is not quantified and no claim-success probability is implied",
        guidance: netNegative
          ? (rolling ? `research only: no priority claim suggested; dropping ${dropName} forfeits ${fmt(dropCost.dropForfeits)} rest-of-season lineup points against ${fmt(dropCost.addContributes)} from ${addName}`
                     : `no bid suggested; dropping ${dropName} forfeits ${fmt(dropCost.dropForfeits)} rest-of-season lineup points against ${fmt(dropCost.addContributes)} from ${addName}`)
          : weak
            ? (rolling ? "research only: no priority claim suggested; assess the drop cost independently before any move" : "no bid suggested; assess the drop cost independently before any move")
            : unassessed
              ? (rolling ? "research only: no priority claim suggested; the dropped player's rest-of-season cost is not priced, so assess the drop cost independently before any move" : "no bid suggested; the dropped player's rest-of-season cost is not priced, so assess the drop cost independently before any move")
              : (rolling ? "rank by value and roster need" : "heuristic bid range")
      };
      const rosterCost = drop
        ? (dropCost.status === "priced"
            ? `dropping ${dropName} forfeits ${fmt(dropCost.dropForfeits)} projected lineup points over ${span}; ${addName} adds ${fmt(dropCost.addContributes)} in his place`
            : `dropping ${dropName} costs their rest-of-season value, which this desk does not price`)
        : (priced
            ? `uses an open roster spot; ${addName} adds ${fmt(dropCost.addContributes)} over ${span}; roster flexibility is not priced`
            : `uses an open roster spot; ${addName}'s rest-of-season contribution is not priced; roster flexibility is not priced`);
      rows.push({
        add: { id: id(playerId(add)), name: addName, position: position(add) },
        drop: drop ? { id: id(playerId(drop)), name: dropName, position: position(drop) } : null,
        lineupGain: gain,
        scoring: { source: weekly.fresh ? "weekly" : "preseason_proxy", label: weekly.fresh ? `week ${args.week} projection` : "ROUGH REST-OF-SEASON PRESEASON PROXY — not a live projection" },
        availability: { status: String(add.injury_status || add.status || "").toUpperCase() || null, actionableNow: !unavailable(add), warning: unavailable(add) ? "injury designation: stash/review, not an immediate-week recommendation" : null },
        valueEstimate: { points: valueEstimate, label: "board value estimate; not a FAAB price" },
        signal, rosterCost, dropCost,
        bid: rolling ? null : bidGuide(perWeekGain, budgetTotal, remaining, reserve, minBid, weak, dropCost, { lineupGain: gain, moveValue, addName, dropName })
      });
    };
```

Careful: `remaining` is the FAAB dollars variable in `analyze` (line 216) — the payload arrives as `args.remaining` and is only ever read through `remainingMap(args.remaining, …)`; do not shadow.

After the existing `unassessedRows` warning add:

```js
    const negativeRows = rows.filter(r => r.dropCost.status === "priced" && r.signal.moveValue <= 0).length;
    if (negativeRows) warnings.push(`${negativeRows} alternative(s) would forfeit more rest-of-season lineup value than the add returns; the numbers are shown but no bid or priority spend is suggested for them`);
    const pricedRows = rows.filter(r => r.dropCost.status === "priced" && r.signal.moveValue > 0).length;
    if (pricedRows) warnings.push(`${pricedRows} required-drop alternative(s) priced on this week's gain plus the rest-of-season lineup change`);
```

Change the existing unassessed warning's filter to exclude weak rows only (it already does) — unchanged.

Add to the returned `coverage` object (both in `blocked()` and the final return):

```js
      ros: { fresh: !!ros.fresh, reason: ros.fresh ? null : ros.reason, endWeek: ros.fresh ? ros.endWeek : null, futureWeeks: ros.fresh ? ros.futureWeeks : null,
             generatedAt: rosMap.generatedAt, dataThrough: rosMap.dataThrough,
             pricedOwned: ros.fresh ? futureRoster.length - rosUnmodeledOwned.length : null, unmodeledOwned: rosUnmodeledOwned,
             pricedFreeAgents: ros.fresh ? freeAgents.filter(p => !rosUnmodeled(p)).length : null,
             evaluation: rosMap.evaluation }
```

In `blocked()` (defined before the ROS block exists), use a literal `ros: { fresh:false, reason:"recommendations withheld", endWeek:null, futureWeeks:null, generatedAt:null, dataThrough:null, pricedOwned:null, unmodeledOwned:[], pricedFreeAgents:null, evaluation:null }`.

- [ ] **Step 4: Run the fixture until green**

Run: `node tests/waivers_fixture.cjs && node tests/waivermode_fixture.cjs`
Expected: `waivers_fixture: N groups OK` with N = 33 + 9. Every fresh-weekly run without a payload now also carries the warning `remaining-season projections unavailable; drop costs unassessed, spend guidance limited to open-slot adds` — if an existing check deep-equals the whole `warnings` array, extend that expectation rather than suppressing the warning. Also and waivermode still green (its rows carry no `reason`; `rowText` reads none yet). If the performance check exceeds 4 s, memoize `rosValue(ros.roster.concat([add]))` per add inside `compare` (compute once per `add` in the `freeAgents.forEach`, pass down) — the spec allows exactly this (§3.5).

- [ ] **Step 5: Commit**

```bash
git add site/assets/waivers.js tests/waivers_fixture.cjs
git commit -m "feat: price waiver drop cost as rest-of-season lineup change

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Page — load the payload, show the split, coverage and evaluation

**Files:**
- Modify: `site/assets/app.js:14-19` (`leagueDataPath` gains `"remaining"`)
- Modify: `site/assets/waivermode.js` (`rowText`; payload load at 268–274 and 296; `renderRows` count line 152; coverage line 251–253; a new evaluation renderer)
- Modify: `site/waivers.html` (two `<li>` items at 88–89; new `<p id="waiver-ros">` and `<div id="waiver-evaluation">`; script tags 99, 101)
- Modify: `site/weekly.html:70` (cache version)
- Test: `tests/waivermode_fixture.cjs`, `tests/navigation_fixture.cjs`

**Interfaces:**
- Consumes: rows and `coverage.ros` from Task 3.
- Produces: `M.rowText(row, result)` → `{gain, bid, bidNote, why, dropCostNote, exportLine}` with the ROS additions below; `M.evaluationText(evaluation)` → array of strings (one per horizon) or `["no measured evaluation for this league's scoring"]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/waivermode_fixture.cjs` before the `const id = …` line:

```js
// Priced rows print the split; net-negative rows print both numbers and never a dollar.
const pricedDrop = M.rowText({ ...rowBase, lineupGain:11, rosterCost:"dropping B forfeits 0.00 projected lineup points over weeks 2–3; A adds 14.00 in his place",
  dropCost:{status:"priced",label:"priced: rest-of-season lineup change over weeks 2–3, assuming participation",addContributes:14,dropForfeits:0,rosDelta:14,futureWeeks:2,endWeek:3},
  signal:{strength:"modeled",guidance:"heuristic bid range",moveValue:25,basis:"move",perWeekGain:8.33},
  bid:{low:11,high:20,tier:"impact",canAfford:true,status:null,label:"heuristic, not calibrated and not a win probability"} }, faab);
assert.equal(pricedDrop.gain, "+11.00 pts this week · ROS +14.00");
assert.equal(pricedDrop.bid, "$11–$20");
assert.equal(pricedDrop.why, "impact · board value estimate; not a FAAB price");
assert.equal(pricedDrop.dropCostNote, "priced: rest-of-season lineup change over weeks 2–3, assuming participation");
assert.match(pricedDrop.exportLine, /^ADD A; DROP B; \+11\.00 \(week 2 projection\); ROS \+14\.00 \(wk 2–3\); modeled; heuristic bid \$11–\$20; dropping B forfeits 0\.00/);
const negative = M.rowText({ ...rowBase, lineupGain:2, rosterCost:"dropping B forfeits 18.00 projected lineup points over weeks 2–3; A adds 0.00 in his place",
  dropCost:{status:"priced",label:"priced: rest-of-season lineup change over weeks 2–3, assuming participation",addContributes:0,dropForfeits:18,rosDelta:-18,futureWeeks:2,endWeek:3},
  signal:{strength:"modeled",guidance:"no bid suggested; dropping B forfeits 18.00 rest-of-season lineup points against 0.00 from A",moveValue:-16,basis:"move",perWeekGain:-5.33},
  bid:{low:null,high:null,tier:"drop costs more than the add returns",canAfford:true,status:"no bid suggested: dropping B forfeits 18.00 rest-of-season lineup points against 0.00 from A",label:"heuristic, not calibrated and not a win probability"} }, faab);
assert.equal(negative.gain, "+2.00 pts this week · ROS −18.00 · drop costs more than the add returns");
assert.equal(negative.bid, "no bid suggested: dropping B forfeits 18.00 rest-of-season lineup points against 0.00 from A");
for (const s of [negative.gain, negative.bid, negative.bidNote, negative.why, negative.exportLine]) assert.doesNotMatch(s, /\$|null|undefined|wrong/);
assert.match(negative.exportLine, /; ROS −18\.00 \(wk 2–3\); DROP COSTS MORE THAN ADD RETURNS; no bid suggested: dropping B/);
const negativeRolling = M.rowText({ ...rowBase, lineupGain:2, bid:null, dropCost:{status:"priced",label:"x",addContributes:0,dropForfeits:18,rosDelta:-18,futureWeeks:2,endWeek:3},
  signal:{strength:"modeled",guidance:"research only: no priority claim suggested; dropping B forfeits 18.00 rest-of-season lineup points against 0.00 from A",moveValue:-16,basis:"move",perWeekGain:-5.33} }, rolling);
assert.equal(negativeRolling.bid, "No priority claim suggested"); assert.doesNotMatch(negativeRolling.exportLine, /Set claim order/);
// Unassessed rows with a reason keep the reason visible.
const reasoned = M.rowText({ ...rowBase, lineupGain:3, signal:{strength:"modeled",guidance:"no bid suggested; the dropped player's rest-of-season cost is not priced, so assess the drop cost independently before any move",basis:"this_week",perWeekGain:3,moveValue:null},
  dropCost:{status:"unassessed",label:"drop cost unassessed: the dropped player's rest-of-season value is not priced, so no spend guidance is offered",reason:"A has no rest-of-season projection"},
  bid:{low:null,high:null,tier:"drop cost unassessed",canAfford:true,status:"no bid suggested: drop cost unassessed — A has no rest-of-season projection",label:"heuristic, not calibrated and not a win probability"} }, faab);
assert.equal(reasoned.gain, "+3.00 pts · drop cost unassessed");
assert.equal(reasoned.dropCostNote, "drop cost unassessed: the dropped player's rest-of-season value is not priced, so no spend guidance is offered — A has no rest-of-season projection");
assert.doesNotMatch(reasoned.exportLine, /ROS/);
// Open slot with a priced add shows the ROS contribution; without one, nothing extra.
const openPriced = M.rowText({ ...rowBase, drop:null, lineupGain:8, rosterCost:"uses an open roster spot; A adds 4.00 over weeks 2–3; roster flexibility is not priced",
  dropCost:{status:"open_slot",label:"no drop required; roster flexibility is not priced",addContributes:4,rosDelta:4,futureWeeks:2,endWeek:3},
  signal:{strength:"modeled",guidance:"heuristic bid range",basis:"move",moveValue:12,perWeekGain:4}, bid:{low:4,high:10,tier:"useful",canAfford:true,status:null,label:"heuristic, not calibrated and not a win probability"} }, faab);
assert.equal(openPriced.gain, "+8.00 pts this week · ROS +4.00");
assert.match(openPriced.exportLine, /DROP none; \+8\.00 \(week 2 projection\); ROS \+4\.00 \(wk 2–3\); modeled; heuristic bid \$4–\$10; uses an open roster spot/);
// Evaluation text is built from the payload block, never typed.
assert.deepEqual(M.evaluationText(null), ["no measured evaluation for this league's scoring"]);
assert.deepEqual(M.evaluationText({ source:"models/diagnostics/remaining_matrix_gabagool.json", baseline:"mean league-scored production in the last four recorded pre-origin games", seasons:[2023,2024,2025], origins:[5,9],
  horizons:[{horizon:1,model_mae:4.612,baseline_mae:4.815,paired_forecasts:1817},{horizon:8,model_mae:4.8,baseline_mae:4.987,paired_forecasts:1834}], limitation:"Dependent windows.", scoring_scope:"evaluated under gabagool scoring, which matches this league" }), [
  "Measured on 2023–2025 (origins week 5 and 9) against mean league-scored production in the last four recorded pre-origin games:",
  "1 week ahead: model MAE 4.61 vs baseline 4.82 (1,817 paired forecasts)",
  "8 weeks ahead: model MAE 4.80 vs baseline 4.99 (1,834 paired forecasts)",
  "evaluated under gabagool scoring, which matches this league",
  "Dependent windows.",
]);
```

Append to `tests/navigation_fixture.cjs` next to line 122:

```js
assert.equal(FC.leagueDataPath("remaining"),"data/remaining-fam.json");
```

and, in the gabagool-context section of that fixture (find where `leagueDataPath("weekly")` is expected to be `data/weekly.json`), add `assert.equal(FC.leagueDataPath("remaining"),"data/remaining-gabagool.json");`. If no gabagool assertion exists there, add it beside the FAM one after temporarily setting the URL the way the fixture does for FAM (read the fixture's URL helper and reuse it).

- [ ] **Step 2: Run to verify failure**

Run: `node tests/waivermode_fixture.cjs; node tests/navigation_fixture.cjs`
Expected: both fail (`gain` lacks the ROS suffix; `evaluationText` undefined; `Unknown league data kind`).

- [ ] **Step 3: Implement**

`site/assets/app.js:14-19`:

```js
  function leagueDataPath(kind) {
    const slug = new URLSearchParams(location.search).get("league") || "gabagool";
    if (!LEAGUE_SLUGS.includes(slug)) throw Error("Unknown league");
    if (!["draft", "weekly", "remaining"].includes(kind)) throw Error("Unknown league data kind");
    // remaining-<slug>.json is named per league for every league, including
    // Gabagool; the bare-name convention applies to draft/weekly only.
    if (kind === "remaining") return `data/remaining-${slug}.json`;
    return `data/${kind}${slug === "gabagool" ? "" : `-${slug}`}.json`;
  }
```

`site/assets/waivermode.js` — replace `rowText` (89–105) with:

```js
  function rowText(r, result) {
    const weak = r.signal.strength === "weak";
    const dc = r.dropCost || {};
    const priced = Number.isFinite(dc.rosDelta);
    const negative = dc.status === "priced" && Number.isFinite(r.signal.moveValue) && r.signal.moveValue <= 0;
    const held = !weak && !negative && dc.status === "unassessed";
    const sign = x => `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(2)}`;
    const dollars = r.bid && Number.isFinite(r.bid.low) && Number.isFinite(r.bid.high) ? `$${r.bid.low}–$${r.bid.high}` : null;
    const withheld = weak || held || negative;
    const bid = r.bid ? (dollars ?? r.bid.status ?? "No bid suggested") : (withheld ? "No priority claim suggested" : "Set claim order in Sleeper");
    const bidNote = r.bid ? r.bid.label : (withheld ? r.signal.guidance : result.waiver.guidance);
    const exportBid = r.bid ? (dollars ? `heuristic bid ${dollars}` : bid) : r.signal.guidance;
    const rosPart = priced ? ` this week · ROS ${sign(dc.rosDelta)}` : "";
    const tag = weak ? " · weak signal" : held ? " · drop cost unassessed" : negative ? " · drop costs more than the add returns" : "";
    const exportRos = priced ? `; ROS ${sign(dc.rosDelta)} (wk ${(dc.endWeek - dc.futureWeeks) + 1}–${dc.endWeek})` : "";
    const exportTag = weak ? "WEAK SIGNAL" : held ? "DROP COST UNASSESSED" : negative ? "DROP COSTS MORE THAN ADD RETURNS" : "modeled";
    return {
      gain: `+${r.lineupGain.toFixed(2)} pts${rosPart}${tag}`,
      bid, bidNote,
      why: `${r.bid ? `${r.bid.tier} · ` : ""}${r.valueEstimate.label}`,
      dropCostNote: held ? `${dc.label}${dc.reason ? ` — ${dc.reason}` : ""}` : dc.status === "priced" ? dc.label : null,
      exportLine: `ADD ${r.add.name}; DROP ${r.drop?.name || "none"}; +${r.lineupGain.toFixed(2)} (${r.scoring.label})${exportRos}; ${exportTag}; ${exportBid}; ${r.rosterCost}${held ? `; ${dc.label}${dc.reason ? ` — ${dc.reason}` : ""}` : ""}`,
    };
  }

  function evaluationText(evaluation) {
    if (!evaluation || !Array.isArray(evaluation.horizons)) return ["no measured evaluation for this league's scoring"];
    const seasons = (evaluation.seasons || []), origins = (evaluation.origins || []);
    const span = seasons.length ? `${seasons[0]}–${seasons[seasons.length - 1]}` : "the evaluation seasons";
    const originText = origins.length ? ` (origins week ${origins.join(" and ")})` : "";
    const lines = [`Measured on ${span}${originText} against ${evaluation.baseline}:`];
    for (const h of evaluation.horizons) lines.push(`${h.horizon} week${h.horizon === 1 ? "" : "s"} ahead: model MAE ${h.model_mae.toFixed(2)} vs baseline ${h.baseline_mae.toFixed(2)} (${h.paired_forecasts.toLocaleString("en-US")} paired forecasts)`);
    if (evaluation.scoring_scope) lines.push(evaluation.scoring_scope);
    if (evaluation.limitation) lines.push(evaluation.limitation);
    return lines;
  }
```

Export `evaluationText` wherever `rowText` is exported at the bottom of the module (find the `module.exports`/`return` object that lists `rowText` and add `evaluationText`).

In `init()`: declare `let remaining = null;` beside `kickoffs`; add `window.FC.loadJSON(dataPath("remaining")).catch(() => null),` to the `Promise.all` and a `loadedRemaining` name in the destructuring; assign `remaining = loadedRemaining;` at line 296; pass `remaining` into `W.analyze({ … , remaining })` at line 235.

`renderRows` count line: replace the `heldCount` computation and sentence with:

```js
      const heldCount = rows.filter(r => r.signal.strength !== "weak" && r.dropCost?.status === "unassessed").length;
      const negativeCount = rows.filter(r => r.dropCost?.status === "priced" && r.signal.moveValue <= 0).length;
      const pricedCount = rows.filter(r => r.dropCost?.status === "priced" && r.signal.moveValue > 0).length;
```

and append to the sentence: `${pricedCount ? ` ${pricedCount} required-drop alternatives are priced on this week's gain plus the rest-of-season lineup change.` : ""}${negativeCount ? ` ${negativeCount} would forfeit more rest-of-season lineup value than the add returns; no bid or priority spend is suggested for them.` : ""}` (the existing `heldCount` sentence stays).

After the coverage line (253) add:

```js
        const ros = coverage.ros || {};
        $("waiver-ros").textContent = ros.fresh
          ? `Rest-of-season projections: weeks ${ros.endWeek - ros.futureWeeks + 1}–${ros.endWeek}, generated ${ros.generatedAt}, data through ${ros.dataThrough || "unknown"}; ${ros.pricedOwned}/${coverage.activeOwnedSkills} roster players priced.${ros.unmodeledOwned.length ? ` No rest-of-season projection: ${ros.unmodeledOwned.map(p => p.name).join(", ")}.` : ""} Values assume participation; injuries and returns are not forecast.`
          : `Rest-of-season projections unavailable${ros.reason ? ` (${ros.reason})` : ""}; drop costs are unassessed and spend guidance is limited to open-slot adds.`;
        const ev = $("waiver-evaluation"); ev.replaceChildren();
        for (const line of evaluationText(ros.evaluation)) ev.append(node("p", line));
```

`site/waivers.html`:
- after line 39 (`<p id="waiver-coverage" …>`) add `<p id="waiver-ros" class="waiver-source" aria-live="polite"></p>`;
- inside the existing `<details>` (lines 40–43) after `<p id="waiver-source" …></p>` add `<div id="waiver-evaluation" class="waiver-source" aria-label="Remaining-season projection evaluation"></div>`;
- replace the two `<li>` items at lines 88–89 with:

```html
      <li>Drop cost is priced as the change in your own lineup's projected points over the remaining weeks, from the model's remaining-season projections: what the add contributes to your roster, and what the drop then forfeits with the add on it. A bench player who never starts forfeits little whatever his season total. Values assume participation; injuries and returns are not forecast. The measured accuracy of those projections against a four-game average is shown under "Data sources and timestamps".</li>
      <li>Spend guidance reads this week's gain plus that rest-of-season change, averaged per remaining week, through the same uncalibrated bands as before. A swap whose drop forfeits more than the add returns shows both numbers and gets no bid or priority claim; it is not called wrong. When a player has no rest-of-season projection, or the projections are stale or misaligned, the drop cost is unassessed and no spend guidance is offered for that swap — unknown is never priced as zero.</li>
```

- bump `assets/waivers.js?v=dropcost2` → `dropcost3` and `assets/waivermode.js?v=dropcost2` → `dropcost3` (lines 99, 101). `site/weekly.html:70` `waivermode.js?v=dropcost2` → `dropcost3`.

- [ ] **Step 4: Run every JS fixture**

Run: `for f in tests/*_fixture.cjs; do node "$f" || exit 1; done`
Expected: all green, including `shared_assets`, `interface_hierarchy`, `navigation`, `waivers`, `waivermode`.

- [ ] **Step 5: Commit**

```bash
git add site/assets/app.js site/assets/waivermode.js site/waivers.html site/weekly.html tests/waivermode_fixture.cjs tests/navigation_fixture.cjs
git commit -m "feat: show rest-of-season drop cost, coverage and evaluation on the waiver desk

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Docs, first payloads, and the full gate

**Files:**
- Modify: `docs/faab-waivers.md` ("Bid ranges" section)
- Modify: `docs/remaining-season-projections.md` (first paragraph)
- Modify: `docs/interface-release-checklist.md` (append one paragraph)
- Create: `site/data/remaining-gabagool.json`, `site/data/remaining-fam.json` (generated, not hand-written)

**Interfaces:** none new.

- [ ] **Step 1: Docs**

`docs/faab-waivers.md` — replace the "## Bid ranges" section body with:

```markdown
Drop cost is priced from the model's remaining-season projections (`remaining-<league>.json`, generated with the weekly slate): the change in your own lineup's projected points over the remaining weeks, split into what the add contributes to your roster and what the drop then forfeits with the add on it. A bench player who never starts forfeits little whatever his season total. The projections assume participation; injuries and returns are not forecast.

Spend guidance reads this week's lineup gain plus that rest-of-season change, averaged per remaining week (including this one), through the same bands as before: under 1 point/week no guidance (weak signal, an explicitly unvalidated product cutoff); 1 to below 2 points use a 1–3% starting-budget band; 2–5 use 4–10%; 5+ use 11–20%. A swap whose drop forfeits more than the add returns shows both numbers and receives no bid or priority claim; it is not called wrong. When the add or the drop has no rest-of-season projection, or the payload is missing, stale (over 72 hours) or misaligned with the league, the drop cost is unassessed and no spend guidance is offered for that swap — unknown is never priced as zero. Open-slot adds use the same basis when the add is priced, so a one-week fill now earns a smaller band than a season-long upgrade. These thresholds are **uncalibrated heuristics**, not market prices, winning-bid probabilities, or expected championship value. Do not spend merely because budget remains.

The remaining-season projections' measured accuracy (model MAE against a four-game average, by horizon) is carried in the payload's `evaluation` block and shown on the page; see `remaining-season-projections.md`.
```

`docs/remaining-season-projections.md` — replace the first paragraph with:

```markdown
The generator's `--remaining` flag, together with `--week auto`, produces
`remaining-<league>.json`; the weekly workflow now passes it for both leagues, as an
optional payload — a failure there is printed and skipped and never blocks the weekly
slate. Weekly rows keep only the league-lens `p10/p50/p90` (no other lenses, no stat
quantiles). The payload carries a measured `evaluation` block (model MAE against the
four-game-mean baseline by horizon, read from the committed
`models/diagnostics/remaining_matrix_<league>.json`) in place of the former
`advice_eligible` boolean. It is consumed by the waiver desk to price drop cost
(`faab-waivers.md`, "Bid ranges"); the pre-draft trade engine still does not read it.
```

`docs/interface-release-checklist.md` — append:

```markdown
Drop-cost pricing (September 16, Opus): required-drop rows are now priced from the
remaining-season payload as a roster-aware lineup change (spec
`docs/superpowers/specs/2026-09-16-waiver-drop-cost-design.md`). Fixture-verified:
priced, net-negative, unassessed-with-reason, stale/misaligned payload, bye vs
unmodeled, precedence, decomposition identity, performance bound. Browser check
against live Gabagool/FAM rows is pending for root, as is the first cron-published
payload (the committed payloads were generated locally).
```

- [ ] **Step 2: Generate the first payloads with the new code**

Run (about 3 minutes each):

```bash
.venv/Scripts/python.exe -m ffmodel.site.generate --out site/data --model transformer --season 2026 --week auto --remaining --artifact-root "models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44" --league gabagool
.venv/Scripts/python.exe -m ffmodel.site.generate --out site/data --model transformer --season 2026 --week auto --remaining --artifact-root "models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44" --league fam
```

Then verify: `ls -la site/data/remaining-*.json` (each ≈ 1 MB, not 24), and

```bash
.venv/Scripts/python.exe -c "import json;[print(s, json.load(open(f'site/data/remaining-{s}.json'))['evaluation'] is not None, json.load(open(f'site/data/remaining-{s}.json'))['start_week']) for s in ('gabagool','fam')]"
```
Expected: both `True`, start_week equal to the current weekly week (2 as of Sept 16). Both runs also rewrite `weekly*.json`, `roles.json`, `kickoffs.json`, `about.json` — that is the normal weekly output; include them in the commit only if `git diff --stat site/data` shows nothing but timestamp churn (it will), otherwise stop and report.

- [ ] **Step 3: Full gate**

Run: `.venv/Scripts/python.exe -m pytest -q && for f in tests/*_fixture.cjs; do node "$f" || exit 1; done`
Expected: pytest all pass (829 + new); every fixture green.

- [ ] **Step 4: Commit**

```bash
git add docs/faab-waivers.md docs/remaining-season-projections.md docs/interface-release-checklist.md site/data
git commit -m "docs+data: drop-cost basis, first remaining-season payloads for both leagues

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage:** §1 definitions → Task 3 (`rosValue`, decomposition against R+A, fallback basis); §2.1 slimming → Task 1; §2.2 evaluation block + `seasontrade.js` guard + `test_remaining` update → Task 1; §2.3 fail-soft workflow → Task 2; §3.1 `remainingMap` reasons in order → Task 3; §3.2 three states / fixed keys / unknown-never-zero / non-finite rule → Task 3; §3.3 precedence, labels, `rosterCost` sentences, proxy mode → Task 3; §3.4 `coverage.ros` + warnings → Task 3; §3.5 performance → Task 3 (bound + memo permission); §4 page, `leagueDataPath`, cache bumps, docs → Tasks 4–5; §5 fail-closed rules → Tasks 3 fixtures; §6 tests → Tasks 1–4; §7 out of scope untouched.
- **Placeholder scan:** no TBD/TODO; every code step carries its code.
- **Type consistency:** `dropCost` keys match between Task 3 producer, Task 3 fixtures and Task 4 `rowText`/fixtures (`addContributes, dropForfeits, rosDelta, futureWeeks, endWeek, reason, label, status`); `signal.moveValue/basis/perWeekGain` used identically in Tasks 3–4; `coverage.ros` field names match between Task 3 return and Task 4 renderer; `evaluationText` export named the same in Task 4 code and fixture; `leagueDataPath("remaining")` string matches Task 4 loader and navigation fixture.
