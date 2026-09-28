# Roster Simulation and Trade Grade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A seeded season simulation (`site/assets/rostersim.js`) that values depth (absences, byes, weekly start choice, boom/bust weeks, replacement level). It powers a trade grade and a waiver drop cost that appear only after the simulation passes a predeclared 2023–2025 walk-forward test.

**Architecture:**
- Python measures absence rates (`availability.py`) and exports frozen per-week forecasts for past seasons (`export_origin_forecasts.py`).
- One JS engine (`rostersim.js`) runs both in the browser and in a Node backtest (`tools/trade_backtest.cjs`). The backtest reuses the shipped draft simulator to build its leagues.
- The trade page and the waiver desk read a published eval file and switch the grade and the sim drop cost on only when the verdict passes.

**Tech Stack:** Python 3 (pandas, nflreadpy, pytest via `.venv/Scripts/python.exe`); vanilla JS UMD modules; Node fixtures `tests/*_fixture.cjs`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-roster-simulation-grade-design.md` (read it with this plan).

## Plan refinements to the spec (verified against the code 2026-09-28)

1. **Test leagues.** Built in Node with the shipped `tools/draft_sim.cjs` `runDraft` over
   the existing `models/backtests/worlds_tf/world_{2023,2024,2025}.json`. These hold
   preseason consensus boards and `actual_weeks`, with Gabagool league scoring. This
   replaces the spec's `trade_backtest_inputs.py` league builder. Python exports only the
   forecasts and the availability tables.
2. **Tags.** `p_tag[status]` = P(player misses his team's *next* game | status in this
   week's report), measured for `Out`, `Doubtful`, `Questionable` (from `load_injuries`)
   and `IR` (`rosters_weekly` status `RES`). This replaces "Out/IR/PUP start out": the
   first simulated week is next week on both the live page and in the test (§6.3), so the
   measured rate is the honest one.
3. **Established player.** A player-week counts toward rates only when the player has a
   regular-season stat row earlier that season and `rosters_weekly` lists him on that
   team that week with status `ACT`, `RES` or `INA`. The spec's "row in the previous 4
   games" rule would truncate long IR stints and bias `p_stay` low.
4. **Replacement** always comes from a real player pool: live free agents, or the test
   league's undrafted players. There is no fallback table. With no candidate for a
   position that week, the engine throws `RosterSimError("no replacement ...")` and the
   page keeps the lineup scenario.
5. **Label cutoffs:** `|Δ| < E` → Too close to call; `E ≤ |Δ| < 2E` → Small; `|Δ| ≥ 2E`
   → Clear (k = 2, fixed now). `E` is the measured per-stratum side-Δ MAE.
6. **The FAM secondary case** uses the same worlds (identical modeled scoring fields, as
   the remaining-season evaluation already assumes) with FAM's 10 teams and slots.

## Global Constraints

- Walk-forward only: anything used to predict test season S uses seasons ≤ S−1 (rates) or information frozen at the origin (forecasts, tags from week origin−1). Never random splits.
- Unknown is never zero: a missing or unmodeled projection week throws a coverage error; byes are "out", never "played for 0".
- The same seed and inputs give identical numbers; common random numbers across every roster variant in one comparison.
- Shipped-code rule: the backtest `require`s `site/assets/rostersim.js` and `site/assets/ros.js`, never a copy.
- Gate: `site/data/trade_sim_eval.json` with `verdict === "pass"` switches on the trade grade; `waiver_verdict === "pass"` switches on the sim drop cost. Missing, malformed, or mismatched (league slug/slots) → closed; today's behaviour unchanged, including the trade page's forbidden-word rules.
- Grade vocabulary: "Clear gain", "Small gain", "Too close to call", "Small loss", "Clear loss", "not valued". "accept", "fair", "winner" and "verdict" remain forbidden in page copy.
- Market check is shown beside the grade and never blended into the number; a stale or missing ROS reference omits it with the existing "ROS ranks withheld" reason.
- Public repo: no credentials, no other managers' data committed. Read-only Sleeper access.
- pytest on this machine: `.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider --basetemp=.review/.pytest-<tag>` (the default temp dir is permission-blocked); delete the basetemp afterwards. Baseline: 845 passed, 2 deselected; 30 node fixtures.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `feat/roster-sim`, in place (no worktree: editable-install trap).

## Review Focus

1. A traded or rostered player with an `unmodeled` week or no forecast: the engine throws a coverage error naming the player, and the page shows the existing blocked message rather than a grade computed with a silent zero. (Task 3 fixture `coverage`.)
2. Replacement pool has no eligible player for a position in some week (e.g. every free-agent QB on bye): throws `no replacement`, and the page falls back to the lineup scenario. (Task 3 fixture `noReplacement`; Task 5 fallback test.)
3. The eval file is from another league or slot shape, or its `verdict` is missing: the gate stays closed. (Task 5 `gateMismatch`.)
4. Sleeper `injury_status` strings outside the mapped set (`"NA"`, `"COV"`, `"Sus"`, `null`, lowercase variants) map deterministically (`Sus` → `Out`, everything unknown → untagged) and never produce `NaN`. (Task 3 `tagMapping`.)
5. A degenerate comparison: the same player on both sides, an empty package, or identical before/after rosters. Validation errors, or Δ exactly 0 for identical rosters. (Task 3 `crn`, `validation`.)

---

### Task 1: Availability rates (`availability.py`)

**Files:**
- Create: `src/ffmodel/eval/availability.py`
- Modify: `src/ffmodel/data/pull.py` (add `pull_injuries` next to `pull_schedules`)
- Test: `tests/test_availability.py`
- Generate (commit): `site/data/availability.json`; `models/backtests/availability/availability_{2023,2024,2025}.json`

**Interfaces:**
- Produces: `participation(weekly, schedules, rosters) -> DataFrame[season, week, team, player_id, position, played:bool, status]`; `transition_rates(part, seasons) -> dict`; `tag_rates(part, injuries, seasons) -> dict`; `build_table(weekly, schedules, rosters, injuries, seasons) -> dict`; `tags_by_week(injuries, rosters, season) -> dict[str(week), dict[player_id, status]]`.
- JSON contract (consumed by Tasks 3–6):
```json
{"schema_version": 1, "seasons": [2012, 2025], "min_count": 200,
 "p_out": {"QB": 0.0, "RB": 0.0, "WR": 0.0, "TE": 0.0},
 "p_stay": {"QB": 0.0, "RB": 0.0, "WR": 0.0, "TE": 0.0},
 "p_tag": {"Out": 0.0, "Doubtful": 0.0, "Questionable": 0.0, "IR": 0.0},
 "p_tag_scope": {"Out": "pooled|position", "...": "..."},
 "counts": {"transitions": {"QB": {"from_played": 0, "from_out": 0}}, "tags": {"Out": 0}},
 "definition": "established = stat row earlier that season AND rostered on that team that week (ACT/RES/INA); missed = team played, established, no stat row"}
```
  Per-test-season files add `"test_season": S` and `"tags": {"<week>": {"<gsis_id>": "Out|Doubtful|Questionable|IR"}}` for season S. `p_tag` is pooled over positions (a per-position split is published only in `counts` for audit).

- [ ] **Step 1: Write the failing tests** (`tests/test_availability.py`)

```python
import pandas as pd
import pytest
from ffmodel.eval import availability as av

def _sched(rows):  # (season, week, home, away)
    return pd.DataFrame([{"season": s, "week": w, "home_team": h, "away_team": a,
                          "home_score": 20, "away_score": 17} for s, w, h, a in rows])

def _weekly(rows):  # (season, week, player_id, team, position)
    return pd.DataFrame([{"season": s, "week": w, "player_id": p, "team": t, "position": pos}
                         for s, w, p, t, pos in rows])

def _rosters(rows):  # (season, week, gsis_id, team, position, status)
    return pd.DataFrame([{"season": s, "week": w, "gsis_id": p, "team": t, "position": pos,
                          "status": st, "game_type": "REG"} for s, w, p, t, pos, st in rows])

SCHED = _sched([(2020, w, "AAA", "BBB") for w in range(1, 6)])

def test_played_missed_and_not_established():
    weekly = _weekly([(2020, 1, "p1", "AAA", "RB"), (2020, 2, "p1", "AAA", "RB"),
                      (2020, 4, "p1", "AAA", "RB"), (2020, 3, "p2", "AAA", "WR")])
    rosters = _rosters([(2020, w, "p1", "AAA", "RB", "ACT") for w in range(1, 6)] +
                       [(2020, w, "p2", "AAA", "WR", "ACT") for w in range(1, 6)] +
                       [(2020, w, "p3", "AAA", "TE", "ACT") for w in range(1, 6)])
    part = av.participation(weekly, SCHED, rosters)
    p1 = part[part.player_id == "p1"].set_index("week").played.to_dict()
    assert p1 == {2: True, 3: False, 4: True, 5: False}   # week 1: nothing earlier -> not established
    assert set(part[part.player_id == "p2"].week) == {4, 5}  # established only after week 3
    assert "p3" not in set(part.player_id)                  # never recorded a stat row

def test_cut_player_is_not_counted_missing():
    weekly = _weekly([(2020, 1, "p1", "AAA", "RB")])
    rosters = _rosters([(2020, 1, "p1", "AAA", "RB", "ACT"), (2020, 2, "p1", "AAA", "RB", "CUT")])
    part = av.participation(weekly, SCHED, rosters)
    assert part.empty

def test_ir_player_stays_established_across_long_absence():
    weekly = _weekly([(2020, 1, "p1", "AAA", "RB")])
    rosters = _rosters([(2020, 1, "p1", "AAA", "RB", "ACT")] +
                       [(2020, w, "p1", "AAA", "RB", "RES") for w in range(2, 6)])
    part = av.participation(weekly, SCHED, rosters)
    assert part.set_index("week").played.to_dict() == {2: False, 3: False, 4: False, 5: False}

def test_transition_rates_counts():
    part = pd.DataFrame([
        {"season": 2020, "week": w, "team": "AAA", "player_id": "p1", "position": "RB", "played": pl, "status": "ACT"}
        for w, pl in [(2, True), (3, False), (4, False), (5, True)]])
    r = av.transition_rates(part, [2020])
    # pairs: T->F, F->F, F->T  => from_played 1 (1 out), from_out 2 (1 stay)
    assert r["counts"]["RB"] == {"from_played": 1, "from_out": 2}
    assert r["p_out"]["RB"] == pytest.approx(1.0)
    assert r["p_stay"]["RB"] == pytest.approx(0.5)

def test_walk_forward_excludes_test_season():
    part = pd.DataFrame([
        {"season": s, "week": w, "team": "AAA", "player_id": "p1", "position": "QB", "played": pl, "status": "ACT"}
        for s in (2021, 2022) for w, pl in [(2, True), (3, s == 2021)]])
    r = av.transition_rates(part, [2021])
    assert r["counts"]["QB"]["from_played"] == 1 and r["p_out"]["QB"] == 0.0

def test_tag_rate_uses_next_team_game():
    part = pd.DataFrame([
        {"season": 2020, "week": w, "team": "AAA", "player_id": "p1", "position": "WR", "played": pl, "status": "ACT"}
        for w, pl in [(2, False), (3, False), (4, True)]])
    injuries = pd.DataFrame([{"season": 2020, "week": 2, "gsis_id": "p1", "report_status": "Out", "game_type": "REG"},
                             {"season": 2020, "week": 3, "gsis_id": "p1", "report_status": "Questionable", "game_type": "REG"}])
    r = av.tag_rates(part, injuries, [2020], min_count=1)
    assert r["counts"]["Out"] == 1 and r["p_tag"]["Out"] == 1.0          # tagged wk2 -> missed wk3
    assert r["counts"]["Questionable"] == 1 and r["p_tag"]["Questionable"] == 0.0  # tagged wk3 -> played wk4
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest tests/test_availability.py -q -p no:cacheprovider --basetemp=.review/.pytest-av`
Expected: FAIL (`ModuleNotFoundError: ffmodel.eval.availability`).

- [ ] **Step 3: Implement `availability.py`**

```python
"""Absence rates for the roster simulation (spec 2026-09-24 §4, plan refinements 2-3).

established = a regular-season stat row earlier that season AND rostered on that team
that week with status ACT/RES/INA. missed = the team played, the player is established,
and he has no stat row. Rates for test season S use seasons < S only (walk-forward).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from ffmodel.site.live_experts import atomic_write

POSITIONS = ("QB", "RB", "WR", "TE")
ON_TEAM = {"ACT", "RES", "INA"}
TAGS = ("Out", "Doubtful", "Questionable")
MIN_COUNT = 200


def _team_games(schedules: pd.DataFrame) -> pd.DataFrame:
    s = schedules.dropna(subset=["home_score", "away_score"])
    home = s[["season", "week", "home_team"]].rename(columns={"home_team": "team"})
    away = s[["season", "week", "away_team"]].rename(columns={"away_team": "team"})
    return pd.concat([home, away], ignore_index=True).drop_duplicates()


def participation(weekly, schedules, rosters) -> pd.DataFrame:
    games = _team_games(schedules)
    r = rosters
    if "game_type" in r:
        r = r[r["game_type"] == "REG"]
    r = r[r["position"].isin(POSITIONS) & r["gsis_id"].notna()]
    r = r.rename(columns={"gsis_id": "player_id"})[["season", "week", "team", "player_id", "position", "status"]]
    r = r.drop_duplicates(["season", "week", "player_id"])
    r = r.merge(games, on=["season", "week", "team"], how="inner")          # team played
    stats = weekly[["season", "week", "player_id"]].drop_duplicates()
    first = stats.groupby(["season", "player_id"]).week.min().rename("first_row").reset_index()
    r = r.merge(first, on=["season", "player_id"], how="inner")
    r = r[(r["week"] > r["first_row"]) & r["status"].isin(ON_TEAM)]
    r = r.merge(stats.assign(played=True), on=["season", "week", "player_id"], how="left")
    r["played"] = r["played"].fillna(False).astype(bool)
    return r.drop(columns="first_row").sort_values(["season", "player_id", "week"]).reset_index(drop=True)


def _pairs(part):
    p = part.sort_values(["season", "player_id", "week"])
    nxt = p.groupby(["season", "player_id"]).shift(-1)
    same_team = nxt["team"] == p["team"]
    return p[same_team.fillna(False)].assign(next_played=nxt.loc[same_team.fillna(False), "played"].astype(bool))


def transition_rates(part, seasons) -> dict:
    pairs = _pairs(part[part["season"].isin(seasons)])
    p_out, p_stay, counts = {}, {}, {}
    for pos in POSITIONS:
        g = pairs[pairs["position"] == pos]
        fp, fo = g[g["played"]], g[~g["played"]]
        counts[pos] = {"from_played": int(len(fp)), "from_out": int(len(fo))}
        p_out[pos] = float((~fp["next_played"]).mean()) if len(fp) else None
        p_stay[pos] = float((~fo["next_played"]).mean()) if len(fo) else None
    return {"p_out": p_out, "p_stay": p_stay, "counts": counts}


def tag_rates(part, injuries, seasons, *, rosters=None, min_count=MIN_COUNT) -> dict:
    part = part[part["season"].isin(seasons)]
    nxt = part.sort_values(["season", "player_id", "week"]).copy()
    nxt["next_played"] = nxt.groupby(["season", "player_id"])["played"].shift(-1)
    nxt["next_team"] = nxt.groupby(["season", "player_id"])["team"].shift(-1)
    nxt = nxt[nxt["next_played"].notna() & (nxt["next_team"] == nxt["team"])]
    inj = injuries
    if "game_type" in inj:
        inj = inj[inj["game_type"] == "REG"]
    inj = inj[inj["report_status"].isin(TAGS)].rename(columns={"gsis_id": "player_id"})
    tagged = nxt.merge(inj[["season", "week", "player_id", "report_status"]], on=["season", "week", "player_id"])
    frames = [tagged.rename(columns={"report_status": "tag"})]
    ir = nxt[nxt["status"] == "RES"].assign(tag="IR")
    frames.append(ir)
    allt = pd.concat(frames, ignore_index=True)
    p_tag, counts = {}, {}
    for tag in TAGS + ("IR",):
        g = allt[allt["tag"] == tag]
        counts[tag] = int(len(g))
        p_tag[tag] = float((~g["next_played"].astype(bool)).mean()) if len(g) >= min_count else None
    return {"p_tag": p_tag, "counts": counts}


def build_table(weekly, schedules, rosters, injuries, seasons) -> dict:
    part = participation(weekly, schedules, rosters)
    tr = transition_rates(part, seasons)
    tg = tag_rates(part, injuries, seasons)
    missing = [k for k, v in {**tr["p_out"], **tr["p_stay"], **tg["p_tag"]}.items() if v is None]
    if missing:
        raise ValueError(f"insufficient history for rates: {missing}")
    return {"schema_version": 1, "seasons": [min(seasons), max(seasons)], "min_count": MIN_COUNT,
            "p_out": tr["p_out"], "p_stay": tr["p_stay"], "p_tag": tg["p_tag"], "p_tag_scope": "pooled",
            "counts": {"transitions": tr["counts"], "tags": tg["counts"]},
            "definition": "established = stat row earlier that season AND rostered on that team that week "
                          "(ACT/RES/INA); missed = team played, established, no stat row; "
                          "p_tag = P(miss next team game | status this week)"}


def tags_by_week(injuries, rosters, season) -> dict:
    out: dict[str, dict[str, str]] = {}
    inj = injuries[(injuries["season"] == season) & injuries["report_status"].isin(TAGS)]
    for row in inj.itertuples():
        out.setdefault(str(int(row.week)), {})[row.gsis_id] = row.report_status
    res = rosters[(rosters["season"] == season) & (rosters["status"] == "RES") & rosters["gsis_id"].notna()]
    for row in res.itertuples():
        out.setdefault(str(int(row.week)), {})[row.gsis_id] = "IR"
    return out


def main() -> None:
    from ffmodel.data.pull import pull_weekly, pull_schedules, pull_injuries
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--rosters", type=Path, default=Path("data/raw/rosters_weekly_raw_2012_2025.parquet"))
    parser.add_argument("--last-season", type=int, default=2025)
    parser.add_argument("--test-seasons", type=int, nargs="*", default=[2023, 2024, 2025])
    args = parser.parse_args()
    span = list(range(2012, args.last_season + 1))
    weekly = pull_weekly(span, cache_dir=args.data_dir)
    schedules = pull_schedules(span, cache_dir=args.data_dir)
    rosters = pd.read_parquet(args.rosters)
    injuries = pull_injuries(span, cache_dir=args.data_dir)
    live = build_table(weekly, schedules, rosters, injuries, span)
    atomic_write(Path("site/data/availability.json"), json.dumps(live, indent=2, allow_nan=False))
    out_dir = Path("models/backtests/availability")
    out_dir.mkdir(parents=True, exist_ok=True)
    for s in args.test_seasons:
        table = build_table(weekly, schedules, rosters, injuries, list(range(2012, s)))
        table["test_season"] = s
        table["tags"] = tags_by_week(injuries, rosters, s)
        atomic_write(out_dir / f"availability_{s}.json", json.dumps(table, indent=2, allow_nan=False))
    print(json.dumps({k: live[k] for k in ("p_out", "p_stay", "p_tag")}, indent=2))


if __name__ == "__main__":
    main()
```

In `src/ffmodel/data/pull.py`, directly after `pull_schedules`:

```python
def pull_injuries(seasons: list[int], cache_dir: Path | None = None) -> pd.DataFrame:
    """nflverse weekly injury reports (report_status Out/Doubtful/Questionable)."""
    def load() -> pd.DataFrame:
        import nflreadpy

        raw = nflreadpy.load_injuries(seasons).to_pandas()
        keep = ["season", "game_type", "week", "gsis_id", "position", "report_status"]
        return raw[keep].reset_index(drop=True)

    return _cached(cache_dir, _cache_name("injuries", seasons), load, covers_seasons=seasons)
```

Check `_cache_name(prefix, seasons)` against its definition at `pull.py:48` before using it. If the test for the IR stint fails because `participation` drops RES weeks, the fix belongs in `participation`, not in the test.

- [ ] **Step 4: Run the tests to verify they pass** (same command; expected PASS, 6 tests).

- [ ] **Step 5: Generate the real tables** (network; `data/raw` caches). Run: `.venv/Scripts/python.exe -m ffmodel.eval.availability`.
  Sanity bounds; STOP and report if violated: every `p_out` is in 0.02–0.20; every `p_stay` is in 0.40–0.90; `p_tag.Out` > `p_tag.Doubtful` > `p_tag.Questionable`; `p_tag.IR` ≥ 0.6. Paste the printed rates into the report.

- [ ] **Step 6: Full gate and commit**

```bash
.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider --basetemp=.review/.pytest-av && rm -rf .review/.pytest-av
git add src/ffmodel/eval/availability.py src/ffmodel/data/pull.py tests/test_availability.py site/data/availability.json models/backtests/availability
git commit -m "feat: measured absence and injury-tag rates for the roster simulation"
```

---

### Task 2: Frozen origin forecasts for every remaining week (`export_origin_forecasts.py`)

**Files:**
- Modify: `src/ffmodel/eval/remaining.py` (extract the origin setup so it can be reused; `evaluate_origin` behaviour and output unchanged)
- Create: `src/ffmodel/eval/export_origin_forecasts.py`
- Test: `tests/test_export_origin_forecasts.py`
- Generate (Task 7, overnight): `models/backtests/origin_forecasts/forecasts_{S}_o{O}.json`

**Interfaces:**
- Consumes: `remaining.py` internals: `build_features`, `combined_future_features(history, schedules, season, week, teams)`, `build_weekly_projections(future, model, season, week, source, pick_six_prior=)`, `recent_game_baseline(history, rules, include_pick_six=)`, `set_league_rules`, `load_pick_six_prior`.
- Produces `origin_forecasts(weekly, schedules, *, season, origin, last_week, league, predictor_factory) -> dict`, and the JSON contract consumed by Task 4:
```json
{"schema_version": 1, "season": 2024, "origin": 5, "weeks": [5, 6, "...", 17],
 "model": "<model.name>", "training_through": 2023, "scoring": "<league.rules.name>",
 "players": {"<gsis>": {"position": "WR", "team": "KC", "baseline": 12.3,
   "weeks": {"5": {"status": "play", "p10": 3.1, "p50": 11.0, "p90": 22.4}, "7": {"status": "bye"}}}}}
```
  `status` is `"play"` (finite quantiles) or `"bye"` (team not scheduled that week). A cohort player with no projection row in a week his team plays is omitted for that week (the backtest treats a missing week as a coverage gap and excludes that player from lineups and trades that need him). `baseline` is the four-game mean from `recent_game_baseline` (the naive comparator's projection, constant over weeks).

- [ ] **Step 1: Refactor `_evaluate_origin`.** Move everything from `history = ...` through `pool = starter_pool(latest, baseline)` into a helper `_origin_context(weekly, schedules, *, season, origin, league, predictor_factory) -> dict`. It returns `history, teams, model, rules, prior, baseline, pick_six_observed, pool`. `_evaluate_origin` calls it, then runs its horizon loop unchanged. The existing tests (`tests/test_remaining*.py`, check with `ls tests | grep -i remaining`) must pass unchanged: a pure refactor.

- [ ] **Step 2: Write the failing test.** Reuse the stub-predictor pattern the existing remaining-eval tests use: find it with `grep -n "predictor_factory" tests/*.py` and copy its fixture setup. Do not invent a new one. Assert:
  (a) `weeks == list(range(origin, last_week + 1))`;
  (b) a player whose team has no game in week w gets `{"status": "bye"}`;
  (c) every `play` row has finite `p10 <= p50 <= p90`;
  (d) no player outside the origin cohort (`teams` from `_origin_context`) appears;
  (e) `baseline` equals `recent_game_baseline(...)` for that player;
  (f) calling it never reads target-week actuals. Pass a `weekly` frame whose rows for weeks ≥ origin are removed, and assert the output is identical to the full-frame call.

- [ ] **Step 3: Implement `origin_forecasts`.** For each week from `origin` to `last_week`, call `combined_future_features` and `build_weekly_projections`, exactly as `_evaluate_origin`'s horizon loop does, but for every week, and without loading actuals. Keep `league` p10/p50/p90 from `payload["players"][i]["points"]["league"]`. Teams not scheduled that week produce `bye` rows for their cohort players. `set_league_rules` must be restored in a `finally`, like `evaluate_origin` does. Add a CLI:
  `--season --origin --last-week 17 --league gabagool --root (append) --data-dir data/raw --out`. It uses the same `TransformerPredictor(roots, f)` factory and default roots as `remaining.main`.

- [ ] **Step 4: Run tests; the existing remaining-eval tests and the new one pass.**

- [ ] **Step 5: Smoke run** on one real cell to check runtime and shape: `--season 2023 --origin 9 --last-week 10`, writing to the scratchpad (not `models/`). Report the wall time and the player count. Task 7 runs the full export.

- [ ] **Step 6: Full gate and commit** `feat: export frozen per-week origin forecasts for the trade backtest`.

---

### Task 3: The simulation engine (`site/assets/rostersim.js`)

**Files:**
- Create: `site/assets/rostersim.js`
- Test: `tests/rostersim_fixture.cjs`

**Interfaces:**
- Consumes: `ros.js` `bestLineup(players, slots, scoreOf)`, which takes players shaped like `{position, ...}`; slots from `QB|RB|WR|TE|FLEX|SUPER_FLEX`.
- Produces (UMD `window.RosterSim` / `module.exports`):
  - `RosterSim.createWorld(cfg) -> World` with `cfg`:
    `{weeks:number[], slots:string[], players:{[id]:{position, tag?, weeks:{[w]:{status:"play"|"bye", p10,p50,p90}}}}, availability:{p_out,p_stay,p_tag}, forcedOut?:{[id]:number[]}, replacement:{[w]:{[pos]:Array<{p10,p50,p90}>}}, nSims?:2000, seed?:1}`
  - `world.value(ids:string[]) -> {mean, p10, p90, perWeek:number[], totals:Float64Array}`
  - `RosterSim.compare(world, beforeIds, afterIds) -> {mean, p10, p90, pPositive}` (paired delta after − before)
  - `RosterSim.normalizeTag(sleeperStatus) -> "Out"|"Doubtful"|"Questionable"|"IR"|null`
  - `RosterSim.drawPoints(q, u) -> number`; `RosterSim.RosterSimError`

- [ ] **Step 1: Write the failing fixture** (`tests/rostersim_fixture.cjs`)

```js
// tests/rostersim_fixture.cjs — run: node tests/rostersim_fixture.cjs
const assert = require("node:assert/strict");
const S = require("../site/assets/rostersim.js");

const A = { p_out: { QB: 0.05, RB: 0.08, WR: 0.06, TE: 0.06 },
            p_stay: { QB: 0.6, RB: 0.65, WR: 0.6, TE: 0.6 },
            p_tag: { Out: 0.7, Doubtful: 0.5, Questionable: 0.15, IR: 0.9 } };
const WEEKS = [4, 5, 6, 7, 8];
const SLOTS = ["QB", "RB", "WR", "FLEX"];
const q = (p50, spread = 6) => ({ status: "play", p10: Math.max(0, p50 - spread), p50, p90: p50 + spread * 1.5 });
const pl = (position, p50, extra = {}) => ({ position, weeks: Object.fromEntries(WEEKS.map(w => [w, q(p50)])), ...extra });
const repl = Object.fromEntries(WEEKS.map(w => [w, { QB: [q(10)], RB: [q(6), q(5)], WR: [q(6), q(5)], TE: [q(4)] }]));
const base = over => S.createWorld({ weeks: WEEKS, slots: SLOTS, availability: A, replacement: repl, nSims: 2000, seed: 7,
  players: { qb1: pl("QB", 20), qb2: pl("QB", 16), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) }, ...over });
let n = 0; const check = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };

check("quantiles", () => {
  const Q = { p10: 3, p50: 12, p90: 30 }, xs = [];
  for (let i = 1; i < 20000; i++) xs.push(S.drawPoints(Q, i / 20000));
  xs.sort((a, b) => a - b);
  assert.ok(Math.abs(xs[1999] - 3) < 0.05 && Math.abs(xs[9999] - 12) < 0.05 && Math.abs(xs[17999] - 30) < 0.05);
  assert.ok(S.drawPoints({ p10: 2, p50: 10, p90: 20 }, 1e-9) >= 0, "floor at min(0, p10)");
});
check("determinism", () => {
  const a = base().value(["qb1", "rb1", "wr1", "wr2"]), b = base().value(["qb1", "rb1", "wr1", "wr2"]);
  assert.equal(a.mean, b.mean); assert.deepEqual([...a.totals.slice(0, 20)], [...b.totals.slice(0, 20)]);
});
check("crn", () => {
  const w = base(); const d = S.compare(w, ["qb1", "rb1", "wr1", "wr2"], ["wr2", "wr1", "rb1", "qb1"]);
  assert.equal(d.mean, 0); assert.equal(d.p10, 0); assert.equal(d.p90, 0);
});
check("backupHasPositiveBoundedValue", () => {
  const w = base();
  const d = S.compare(w, ["qb1", "rb1", "wr1", "wr2"], ["qb1", "qb2", "rb1", "wr1", "wr2"]);
  assert.ok(d.mean > 0, "a backup QB must be worth something when the starter can miss games");
  // bounded above by his margin over replacement, summed over the weeks he could start
  assert.ok(d.mean < WEEKS.length * (16 - 10) + 1e-9);
});
check("noAbsenceNoBackupValue", () => {
  const zero = { p_out: { QB: 0, RB: 0, WR: 0, TE: 0 }, p_stay: { QB: 0, RB: 0, WR: 0, TE: 0 }, p_tag: A.p_tag };
  const w = base({ availability: zero });
  const d = S.compare(w, ["qb1", "rb1", "wr1", "wr2"], ["qb1", "qb2", "rb1", "wr1", "wr2"]);
  assert.equal(d.mean, 0, "a QB who never starts adds nothing when nobody misses games");
});
check("forcedOutAndBye", () => {
  const byeWeeks = Object.fromEntries(WEEKS.map(w => [w, w === 6 ? { status: "bye" } : q(20)]));
  const w = base({ players: { qb1: { position: "QB", weeks: byeWeeks }, rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) },
                   forcedOut: { rb1: [4, 5, 6, 7, 8] } });
  const v = w.value(["qb1", "rb1", "wr1", "wr2"]);
  assert.ok(Number.isFinite(v.mean), "bye and forced-out weeks fall back to replacement, never NaN or zero lineups");
  assert.ok(v.perWeek[2] < v.perWeek[1], "the bye week scores less (replacement QB)");
});
check("coverage", () => {
  const bad = pl("WR", 9); delete bad.weeks[7];
  assert.throws(() => base({ players: { qb1: pl("QB", 20), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: bad } }), /wr2.*week 7/);
});
check("noReplacement", () => {
  const thin = Object.fromEntries(WEEKS.map(w => [w, { QB: [], RB: [q(6)], WR: [q(6)], TE: [] }]));
  const w = base({ replacement: thin, forcedOut: { qb1: [5] } });
  assert.throws(() => w.value(["qb1", "rb1", "wr1", "wr2"]), /no replacement/);
});
check("tagMapping", () => {
  assert.equal(S.normalizeTag("Out"), "Out"); assert.equal(S.normalizeTag("Sus"), "Out");
  assert.equal(S.normalizeTag("IR"), "IR"); assert.equal(S.normalizeTag("PUP"), "IR");
  assert.equal(S.normalizeTag("questionable"), "Questionable");
  for (const x of ["NA", "COV", null, undefined, ""]) assert.equal(S.normalizeTag(x), null);
  const w = base({ players: { qb1: pl("QB", 20, { tag: "NA" }), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) } });
  assert.ok(Number.isFinite(w.value(["qb1", "rb1", "wr1", "wr2"]).mean));
});
check("tagRaisesFirstWeekMiss", () => {
  const out = base({ players: { qb1: pl("QB", 20, { tag: "Out" }), qb2: pl("QB", 16), rb1: pl("RB", 14), wr1: pl("WR", 13), wr2: pl("WR", 9) } });
  const clean = base();
  const withBackup = w => S.compare(w, ["qb1", "rb1", "wr1", "wr2"], ["qb1", "qb2", "rb1", "wr1", "wr2"]).mean;
  assert.ok(withBackup(out) > withBackup(clean), "a starter tagged Out makes his backup worth more");
});
check("validation", () => {
  const w = base();
  assert.throws(() => w.value(["qb1", "qb1"]), /duplicate/);
  assert.throws(() => w.value(["nobody"]), /unknown player/);
  assert.throws(() => S.createWorld({ weeks: WEEKS, slots: SLOTS, availability: A, replacement: repl,
    players: { x: { position: "QB", weeks: Object.fromEntries(WEEKS.map(w2 => [w2, { status: "play", p10: 9, p50: 5, p90: 20 }])) } } }), /quantiles/);
});
check("timing", () => {
  const players = {}; const ids = [];
  for (let i = 0; i < 32; i++) { const pos = ["QB", "RB", "WR", "TE"][i % 4]; players[`p${i}`] = pl(pos, 5 + (i % 11)); ids.push(`p${i}`); }
  const WK = Array.from({ length: 14 }, (_, i) => i + 4);
  const r14 = Object.fromEntries(WK.map(w => [w, { QB: [q(10)], RB: [q(6), q(5)], WR: [q(6), q(5)], TE: [q(4)] }]));
  for (const id of ids) players[id].weeks = Object.fromEntries(WK.map(w => [w, q(5 + (Number(id.slice(1)) % 11))]));
  const t0 = Date.now();
  const w = S.createWorld({ weeks: WK, slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX"], availability: A,
                            replacement: r14, players, nSims: 2000, seed: 3 });
  S.compare(w, ids.slice(0, 16), ids.slice(0, 15).concat(ids[20]));
  S.compare(w, ids.slice(16), ids.slice(17).concat(ids[0]));
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `trade comparison took ${ms} ms (budget 1500 ms in node)`);
});
console.log(`rostersim_fixture: ${n} groups OK`);
```

- [ ] **Step 2: Run to verify failure.** `node tests/rostersim_fixture.cjs` → `Cannot find module '../site/assets/rostersim.js'`.

- [ ] **Step 3: Implement `site/assets/rostersim.js`**

```js
/* Seeded Monte Carlo of the rest of a fantasy season (spec 2026-09-24 §3).
   Pure: no DOM, no fetch. One world holds every player a comparison touches, so
   all roster variants share the same draws (common random numbers) and a paired
   delta carries only the effect of the move. Unknown is never zero: a missing
   week throws; a bye or an absence is "out", and an empty slot is filled from the
   supplied replacement pool or the call throws. */
(function (root, factory) {
  const node = typeof module !== "undefined" && module.exports;
  const api = factory(node ? require("./ros.js") : root.ROS);
  if (node) module.exports = api;
  if (root) root.RosterSim = api;
})(typeof window !== "undefined" ? window : null, function (ROS) {
  "use strict";
  const Z90 = 1.2815515655446004;
  const POS = ["QB", "RB", "WR", "TE"];
  class RosterSimError extends Error { constructor(m) { super(m); this.name = "RosterSimError"; } }
  const fail = m => { throw new RosterSimError(m); };

  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
  // Acklam's inverse normal CDF (|error| < 1.2e-9).
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  function invNorm(p) {
    if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
    const lo = 0.02425, hi = 1 - lo;
    if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
  // Two-piece normal through (p10, p50, p90); floor at min(0, p10) keeps p10 exact.
  function drawPoints(q, u) {
    const z = invNorm(u);
    const s = z < 0 ? (q.p50 - q.p10) / Z90 : (q.p90 - q.p50) / Z90;
    const x = q.p50 + z * s, floor = Math.min(0, q.p10);
    return x < floor ? floor : x;
  }
  function checkQ(q, where) {
    if (!q || ![q.p10, q.p50, q.p90].every(Number.isFinite) || !(q.p10 <= q.p50 && q.p50 <= q.p90))
      fail(`invalid quantiles for ${where}`);
  }
  const TAGS = { out: "Out", sus: "Out", doubtful: "Doubtful", questionable: "Questionable", ir: "IR", pup: "IR" };
  function normalizeTag(s) { return typeof s === "string" && TAGS[s.trim().toLowerCase()] || null; }

  function createWorld(cfg) {
    const { weeks, slots, players, availability: A, replacement, forcedOut = {}, nSims = 2000, seed = 1 } = cfg || {};
    if (!Array.isArray(weeks) || !weeks.length || !weeks.every(Number.isInteger)) fail("weeks required");
    if (!Array.isArray(slots) || !slots.length) fail("slots required");
    for (const pos of POS) if (!(A && Number.isFinite(A.p_out?.[pos]) && Number.isFinite(A.p_stay?.[pos]))) fail(`availability rates missing for ${pos}`);
    const W = weeks.length, N = nSims;
    const sims = new Map();
    for (const [id, p] of Object.entries(players || {})) {
      if (!POS.includes(p.position)) fail(`unknown position for ${id}`);
      const rows = weeks.map(w => {
        const r = p.weeks && p.weeks[w];
        if (!r || (r.status !== "play" && r.status !== "bye")) fail(`${id} has no projection for week ${w}; unknown is not zero`);
        if (r.status === "play") checkQ(r, `${id} week ${w}`);
        return r;
      });
      const tag = normalizeTag(p.tag), forced = new Set(forcedOut[id] || []);
      const firstOut = tag && Number.isFinite(A.p_tag?.[tag]) ? A.p_tag[tag] : A.p_out[p.position];
      const avail = new Uint8Array(N * W), pts = new Float64Array(N * W);
      const rand = mulberry32((seed ^ hash(id)) >>> 0);
      for (let s = 0; s < N; s++) {
        let out = false, started = false;
        for (let i = 0; i < W; i++) {
          const u1 = rand(), u2 = rand(), r = rows[i];
          if (r.status === "bye") continue;                 // state carries across a bye
          const pOut = started ? (out ? A.p_stay[p.position] : A.p_out[p.position]) : firstOut;
          out = forced.has(weeks[i]) || u1 < pOut; started = true;
          if (!out) { avail[s * W + i] = 1; pts[s * W + i] = drawPoints(r, u2); }
        }
      }
      sims.set(id, { id, position: p.position, rows, avail, pts });
    }
    // Replacement players: always available (you pick up someone who is playing),
    // ranked below every rostered player so they only fill otherwise-empty slots.
    const repl = weeks.map((w, i) => {
      const byPos = (replacement && replacement[w]) || {};
      const list = [];
      for (const pos of POS) (byPos[pos] || []).forEach((q, k) => {
        checkQ(q, `replacement ${pos} week ${w}`);
        const rand = mulberry32((seed ^ hash(`~R:${pos}:${k}:${w}`)) >>> 0);
        const draws = new Float64Array(N); for (let s = 0; s < N; s++) { rand(); draws[s] = drawPoints(q, rand()); }
        list.push({ position: pos, p50: q.p50, draws, replacement: true });
      });
      return list;
    });
    const cache = new Map();
    function value(ids) {
      if (!Array.isArray(ids)) fail("ids must be an array");
      if (new Set(ids).size !== ids.length) fail("duplicate player in roster");
      const members = ids.map(id => sims.get(id) || fail(`unknown player ${id}`));
      const key = ids.slice().sort().join("|");
      if (cache.has(key)) return cache.get(key);
      const totals = new Float64Array(N), perWeek = new Array(W).fill(0);
      for (let s = 0; s < N; s++) {
        for (let i = 0; i < W; i++) {
          const cands = [];
          for (const m of members) if (m.avail[s * W + i]) cands.push({ position: m.position, score: m.rows[i].p50, pts: m.pts[s * W + i] });
          for (const r of repl[i]) cands.push({ position: r.position, score: r.p50 - 1e9, pts: r.draws[s] });
          const lu = ROS.bestLineup(cands, slots, c => c.score);
          if (!lu.starters.length) fail(`no replacement available for ${lu.unfillable} in week ${weeks[i]}`);
          let t = 0; for (const st of lu.starters) t += st.player.pts;
          totals[s] += t; perWeek[i] += t / N;
        }
      }
      const sorted = Float64Array.from(totals).sort();
      const out = { mean: totals.reduce((x, y) => x + y, 0) / N, p10: sorted[Math.floor(0.1 * (N - 1))],
                    p90: sorted[Math.floor(0.9 * (N - 1))], perWeek, totals };
      cache.set(key, out);
      return out;
    }
    return { value, weeks: weeks.slice(), nSims: N };
  }
  function compare(world, beforeIds, afterIds) {
    const b = world.value(beforeIds).totals, a = world.value(afterIds).totals, N = a.length;
    const diff = new Float64Array(N); let sum = 0, pos = 0;
    for (let s = 0; s < N; s++) { diff[s] = a[s] - b[s]; sum += diff[s]; if (diff[s] > 0) pos++; }
    diff.sort();
    return { mean: sum / N, p10: diff[Math.floor(0.1 * (N - 1))], p90: diff[Math.floor(0.9 * (N - 1))], pPositive: pos / N };
  }
  return Object.freeze({ createWorld, compare, drawPoints, normalizeTag, RosterSimError });
});
```

  Notes for the implementer. The `crn` group relies on `value()` caching by the sorted id key. If `timing` exceeds budget, optimize inside `value` (for example, reuse the `cands` array or skip `ROS.bestLineup` allocation) without changing results; `determinism` and `crn` must still pass. `mean` must be computed in a fixed order so the same inputs give bit-identical output.

- [ ] **Step 4: Run** `node tests/rostersim_fixture.cjs` → `rostersim_fixture: 12 groups OK`.
- [ ] **Step 5: Gate** (all fixtures) **and commit** `feat: rostersim.js — seeded season simulation with absences, byes and replacement`.

---

### Task 4: The walk-forward trade backtest (`tools/trade_backtest.cjs`)

**Files:**
- Create: `tools/trade_backtest.cjs`, `tests/trade_backtest_fixture.cjs`
- Modify: `tools/draft_sim.cjs` only if `runDraft`/`applyLeague` are not already exported (`module.exports` at line ~757 exports `runDraft`; add `applyLeague` if missing, and nothing else)
- Output (Task 7): `models/diagnostics/trade_sim_eval.json` (full) and `site/data/trade_sim_eval.json` (slim gate file)

**Interfaces:**
- Consumes: `rostersim.js` (Task 3); `availability_{S}.json` (Task 1, incl. `tags`); `forecasts_{S}_o{O}.json` (Task 2); `models/backtests/worlds_tf/world_{S}.json` (`players[]` with `player_id, position, adp, ...`; `actual_weeks[pid][week] = league points`); `draft_sim.cjs` `runDraft(players, 0, seed, "measured")` (heroSlot 0 = no optimizer seat), preceded by `applyLeague(league)` and `O.withValuePoints(world.players)` exactly as `evaluateSeason` does (read lines 491–525 first).
- Produces exported pure functions (for the fixture): `sampleTrades(rosters, forecasts, rand, count)`, `predictSim(...)`, `predictLineupOnly(rosters, projOf, weeks, slots, replacementOf)`, `realized(rosters, trade, forecasts, actualWeeks, undrafted, weeks, slots)`, `metrics(rows)`, `bootstrap(rows, B, rand)`, `verdict(summary)`. CLI: `node tools/trade_backtest.cjs --seasons 2023,2024,2025 --origins 5,9 --leagues 20 --trades 125 --sims 2000 --league site/data/draft.json [--secondary site/data/draft-fam.json] --out models/diagnostics/trade_sim_eval.json --site-out site/data/trade_sim_eval.json`.

This task is prose-specified: the implementer makes design calls within these rules (opus).

1. **Leagues:** for each season S and each league k from 0 to K−1: `runDraft` with seed `1000*S + k`, field `"measured"`. Rosters = the 12 (or 10 for FAM) drafted lists of skill players. Undrafted pool = world players not drafted.
2. **Slots** from the board's `league` block: `roster.QB×QB, roster.RB×RB, …, flex×FLEX` (`SUPER_FLEX` if `flex_positions` includes QB).
3. **Trades** per (S, origin, league), sampled with `mulberry32(hash(S, origin, k))` **before any prediction runs** and written into the output for audit. Draw a roster pair; draw a package type uniformly from {1-1, 2-1, 1-2, 2-2}; draw players uniformly from each side's players who have `play`/`bye` forecast rows for every week in origin..17. Overflow: a side that gains n players drops its n lowest mean-p50 (origin..17) players not involved in the trade. Discard duplicates; stop at `--trades`.
4. **Strata** per trade (a trade can be in several):
   - `same_position`: every moved player shares one position;
   - `cross_position`: otherwise;
   - `depth_for_starter`: some received player is in the receiving side's current-method p50 lineup in fewer than half the weeks;
   - `lopsided`: |current-method Δ| ≥ the 90th percentile over all trades (cutoff published).
5. **Predictions, per side:**
   - sim: `RosterSim` world with the test-season availability table and `tags[origin−1]`. Replacement = for each week, the top 3 undrafted players by frozen p50 at each position with a `play` row.
   - current: p50 lineup-only, everyone plays, replacement by the same pool's p50 for unfillable slots.
   - naive: the same with `baseline` in place of every week's p50 (bye weeks still out).
6. **Realized, per side:** for each week from origin to 17, the lineup is chosen by frozen p50 among roster players with an `actual_weeks` entry that week. Unfilled slots take the undrafted player with the best frozen p50 who has an `actual_weeks` entry. Score = actual points. Players without a forecast that week cannot start. Realized Δ = after − before.
7. **Metrics** (`metrics(rows)`, rows = one per trade side):
   - side-Δ MAE per method;
   - sign accuracy;
   - regret = `max(real,0) − (pred>0 ? real : 0)`;
   - sim 80% coverage = share with real in [p10, p90];
   - all of the above per stratum and per position of the first received player.
8. **Bootstrap:** 2000 resamples of clusters `(S, origin, league)` with replacement. Recompute the pooled MAE and regret differences (sim − current, sim − naive) and each stratum's (sim − current) MAE difference, and report the 2.5/97.5 percentiles.
9. **Verdict** (spec §6.5, plan refinement 5): `verdict = "pass"` iff all of:
   - pooled MAE and regret intervals vs. **both** comparators lie entirely below 0;
   - no stratum's (sim − current) MAE interval lies entirely above 0;
   - coverage is in [0.70, 0.90].

   `waiver_verdict` from the drop-decision set: for each roster at each origin, and each of the 10 undrafted players with the highest mean frozen p50 over origin..17, each method picks the drop that maximises its predicted roster total after the add. Regret = realized total of the best drop in hindsight minus that of the chosen drop. `"pass"` iff the interval of (sim − current) mean regret lies entirely below 0.
10. **Outputs:**
    - Full file: config, seeds, trade list, per-trade rows, metrics, bootstrap intervals, verdicts.
    - Slim site file: `{schema_version:1, league:"gabagool", slots:[...], verdict, waiver_verdict, k:2, strata:{name:{E, n}}, lopsided_cutoff, seasons, origins, generated_at, secondary:{league:"fam", slots, verdict, strata}}`.
    - Floats rounded to 3 dp; `allow_nan` equivalent: throw if any metric is non-finite.

- [ ] **Step 1: Fixture first** (`tests/trade_backtest_fixture.cjs`). Build a tiny synthetic season by hand: 2 teams, slots `["QB","RB","FLEX"]`, 3 weeks, 8 players plus 3 undrafted, with forecasts and `actual_weeks` chosen so that:
  - (a) `realized` of a hand-computed trade equals a hand-computed number (write the arithmetic in a comment);
  - (b) a player missing `actual_weeks` in week 2 is benched and the replacement rule fires;
  - (c) `predictLineupOnly` with everyone playing equals the hand-computed p50 lineup totals;
  - (d) `metrics` on 4 hand-made rows gives the expected MAE, sign accuracy and regret;
  - (e) `verdict` returns `"fail"` when coverage is 0.95 even though every error metric favours sim;
  - (f) `sampleTrades` is identical for the same seed and never includes a player lacking forecasts.
  Run it and watch it fail (module missing).
- [ ] **Step 2: Implement** until the fixture passes. Then run a **smoke** backtest on the real inputs available so far: 1 season, 1 origin, 2 leagues, 20 trades, 200 sims, writing to the scratchpad. Only the cells Task 2's smoke produced exist, so use `--seasons 2023 --origins 9` with a forecast file whose last week matches, or run after Task 7's export. Report runtime per trade.
- [ ] **Step 3: Gate and commit** `feat: walk-forward trade backtest for the roster simulation (shipped engine, predeclared verdict)`.

---

### Task 5: Trade page grade and market panel (gated)

**Files:**
- Modify: `site/assets/seasontrade.js` (add `simulate(...)`), `site/assets/seasontrademode.js` (grade panel, gate, market check), `site/trade.html` (load `rostersim.js`, `availability.json`, `trade_sim_eval.json`; asset versions)
- Test: `tests/seasontrademode_fixture.cjs`, `tests/seasontrade_fixture.cjs` (check the existing file name with `ls tests | grep -i seasontrade`)

**Interfaces:**
- Consumes: `RosterSim.createWorld/compare/normalizeTag` (Task 3); `availability.json` (Task 1); `trade_sim_eval.json` slim contract (Task 4); `ros-ecr.json` via `waiverintel.js` `prepareRos(source, season, now)`, which throws `"ROS reference is stale, future-dated or empty."` when unusable.
- Produces:
  - `SeasonTrade.simulate({...analyzeArgs, availability, freeAgents, seed}) -> {sides:[{rosterId, mean, p10, p90, pPositive, perWeek}], weeks, nSims}`. It reuses `analyze`'s identity and coverage resolution. Extract the resolution into a shared internal so both functions resolve players identically; do not duplicate it. It also carries `p10/p90` (from `points.league`) and `injury_status` → `tag`. The free-agent pool = remaining-payload players whose GSIS id maps to no rostered player in the league. Replacement per week = the top 3 by p50 per position with a `conditional_projection` row.
  - `SeasonTradeMode.gradeLabel(delta, E, k=2) -> "Clear gain"|"Small gain"|"Too close to call"|"Small loss"|"Clear loss"` (pure).
  - `SeasonTradeMode.gateOpen(evalFile, league) -> boolean` (pure): true only for `schema_version === 1 && verdict === "pass"`, with `league` equal to the board slug (or `secondary.league` with its own verdict/strata) and `slots` deep-equal to the live league's starter slots.
  - `SeasonTradeMode.stratumOf(trade, currentDelta, evalFile) -> string[]`, `marketText(moves, rosRanks) -> string|null` (pure).

Requirements:
- Gate closed → the page is exactly as today; every existing seasontrademode assertion passes unchanged.
- Gate open → a grade panel above the lineup summary. Per side: the label, then e.g. `+11.4 pts over weeks 4–17 (about +0.8 a week); likely range −3.0 to +24.9; measured error on trades like this ≈ ±6.1`. E = the largest `E` among the trade's strata (conservative). Below it, the market check and the existing summary.
- Market text only when both sides' moved players have ROS ranks and the rank-implied direction (sum of rank-based values, where lower rank = better; use `1/rank`) disagrees with the model's sign. Name the players and ranks, plus a roster reason when a received player sits in fewer than half the weeks.
- A sim failure (`RosterSimError`: coverage, no replacement) or missing `availability.json` → the lineup scenario with a one-line note "grade unavailable: <reason>". No partial grade.
- Word rules: gate closed = today's `FORBIDDEN` list. Gate open = a new `GRADE_FORBIDDEN = ["verdict","accept","fair","winner","recommend","win/win"]`, checked over every grade-panel string by the fixture.
- The fixture covers: `gradeLabel` boundaries (exactly E, exactly 2E, negative mirror); `gateOpen` false for missing file, `verdict:"fail"`, other league slug, different slots, `schema_version` 2; `simulate` on the existing fixture league returns finite sides, and a mocked `RosterSimError` makes the page fall back with the note; `marketText` null when ranks are missing; grade strings pass `GRADE_FORBIDDEN`.
- Bump the `seasontrade.js`/`seasontrademode.js` versions in `trade.html`, and add `rostersim.js?v=1` after `ros.js`.

- [ ] Step 1: failing fixture cases → Step 2: implement → Step 3: all fixtures → Step 4: commit `feat: gated trade grade from the roster simulation, with expert-rank cross-check`.

---

### Task 6: Waiver drop cost from the simulation (gated)

**Files:**
- Modify: `site/assets/waivers.js` (`remainingMap` keeps p10/p90; sim-backed `ros.value` when gated), `site/assets/waivermode.js` (load `availability.json` + eval file; pass the gate), `site/waivers.html` (script + versions)
- Test: `tests/waivers_fixture.cjs`, `tests/waivermode_session_fixture.cjs`

**Interfaces:**
- Consumes: `RosterSim` (Task 3); `gateOpen` semantics from Task 5, but reading `waiver_verdict` (implement a tiny `waiverGateOpen(evalFile, league)` in `waivers.js`; do not import the trade page controller).
- Produces: when open, `ros.value(players)` = `world.value(ids).mean`, from one world created per desk load containing the roster plus every candidate add, with `nSims = 200` for ranking. The displayed rows are then recomputed with `nSims = 2000` (a second world, same seed). `dropCostOf`'s contract, statuses and labels are unchanged except that the priced label reads `priced: simulated rest-of-season change over weeks A–B, including absences and byes` when the sim is used.

Requirements:
- Gate closed → identical behaviour and output to today (existing fixtures unchanged).
- Gate open → a backup QB behind a healthy starter no longer shows `dropForfeits ≈ 0`. Fixture: the existing Gabagool-style fixture roster with two QBs; assert the QB2 drop's `dropForfeits` > 0 with the gate open and ≈ today's value with it closed.
- Budget: a desk load with 13 roster players and 60 candidate adds (fixture-generated) finishes both passes in < 3 s in node; the fixture measures it.
- `RosterSimError` → that row falls back to today's lineup-only drop cost, with reason text `simulation unavailable: <reason>`.

- [ ] Step 1: failing fixture cases → Step 2: implement → Step 3: all fixtures → Step 4: commit `feat: gated simulated drop cost on the waiver desk`.

---

### Task 7: Overnight run, publication and docs (controller + owner's machine)

- [ ] **Step 1: Export forecasts** (long; run in the background, one process per cell so a crash loses one cell):
  `for S in 2023 2024 2025; do for O in 5 9; do .venv/Scripts/python.exe -m ffmodel.eval.export_origin_forecasts --season $S --origin $O --last-week 17 --out models/backtests/origin_forecasts/forecasts_${S}_o${O}.json; done; done`
  Verify 6 files, each with 13 or 9 weeks and ≥ 400 players.
- [ ] **Step 2: Backtest:** `node tools/trade_backtest.cjs --seasons 2023,2024,2025 --origins 5,9 --leagues 20 --trades 125 --sims 2000 --league site/data/draft.json --secondary site/data/draft-fam.json --out models/diagnostics/trade_sim_eval.json --site-out site/data/trade_sim_eval.json`.
- [ ] **Step 3: Record the result honestly, pass or fail.** Add a section to `docs/remaining-season-projections.md` (the verdicts, pooled metrics with intervals, per-stratum table, coverage, and what is/isn't claimed), plus an about-page paragraph in the same register as the draft experiments. Commit the forecasts, the eval files and the docs together (`models/` artifacts are committed with the config that produced them, per CLAUDE.md).
- [ ] **Step 4:** Browser check on the live site after deploy: the Herbert→Kyler trade shows either the grade (gate open) or the unchanged scenario (gate closed), and the waiver desk's QB2 drop row matches the gate state.

---

## Self-review (run 2026-09-28)

- **Spec coverage:**
  - §2 components → T1–T6;
  - §3 model → T3;
  - §4 rates → T1 (refinements 2–3);
  - §5 grade/market/gate → T5;
  - §6 test → T4 + T7 (refinement 1; the FAM case → refinement 6);
  - §6.5 waiver rule → T4 verdict + T6;
  - §7 tests → T1/T3/T4 fixtures;
  - §8 limitations → T5 panel copy + T7 docs.
- **Placeholders:** none. T2/T4/T5/T6 are prose-specified by design (opus implementers), with exact contracts, files, commands and assertions.
- **Type consistency:**
  - `createWorld` cfg keys (`weeks, slots, players{position,tag,weeks{status,p10,p50,p90}}, availability{p_out,p_stay,p_tag}, forcedOut, replacement{[w]:{[pos]:[q]}}, nSims, seed`) are used identically in T4, T5 and T6.
  - `availability.json` keys (T1) match `createWorld`'s `availability`.
  - Slim eval keys (T4) match `gateOpen` (T5) and `waiverGateOpen` (T6).
  - Forecast JSON `status: "play"|"bye"` matches T3's row statuses. Live rows are mapped from `conditional_projection` → `play` in T5/T6.
- **Review Focus:** 5 items, each pinned by a named fixture group in T3/T5.
