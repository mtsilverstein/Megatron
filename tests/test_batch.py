"""Single-process legacy + neutral batch (`ffmodel.site.batch`, spec §3.5, plan Task 7).

Every pull, the catalog and the predictor are faked; nothing touches the
network or runs the real model. The fake predictor is STATEFUL in the way the
transformer is: it reads each test row by index from whatever frame was last
attached, so a weekly build that runs while a remaining-season horizon is
still attached gets silently wrong numbers -- exactly the hazard the parity
test against today's per-league `generate.py` sequence exists to catch.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ffmodel.scoring import PREDICTED_STATS
from ffmodel.site import batch, neutral, publish

SEASON = 2026
TEAMS = [f"T{i:02d}" for i in range(22)]
# Two players per team: a QB (exercises the pick-six prior) and a WR.
PLAYERS = {f"00-00{2 * i:05d}": (f"QB {t}", "QB", t) for i, t in enumerate(TEAMS)}
PLAYERS.update({f"00-00{2 * i + 1:05d}": (f"WR {t}", "WR", t) for i, t in enumerate(TEAMS)})
CURRENT_TEAMS = {pid: team for pid, (_, _, team) in PLAYERS.items()}
ROOTS = "models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44"


def _schedule(season, completed_through):
    rows = []
    for week in range(1, 19):
        bye = ({TEAMS[(2 * week) % 22], TEAMS[(2 * week + 1) % 22]}
               if 5 <= week <= 14 else set())
        playing = [t for t in TEAMS if t not in bye]
        k = week % len(playing)
        rot = playing[k:] + playing[:k]
        day = (pd.Timestamp(f"{season}-09-10") + pd.Timedelta(days=7 * (week - 1)))
        for i in range(0, len(rot), 2):
            done = week <= completed_through
            rows.append(dict(season=season, week=week, game_type="REG",
                             gameday=day.strftime("%Y-%m-%d"), gametime="13:00",
                             home_team=rot[i], away_team=rot[i + 1],
                             home_score=21.0 if done else np.nan,
                             away_score=17.0 if done else np.nan))
    return pd.DataFrame(rows)


def _weekly(schedules):
    rows = []
    for g in schedules[schedules.home_score.notna()].itertuples():
        for team, opp in ((g.home_team, g.away_team), (g.away_team, g.home_team)):
            for pid, (name, pos, t) in PLAYERS.items():
                if t != team:
                    continue
                seed = (int(pid[-5:]) * 7 + g.week * 3 + g.season) % 11
                stats = {s: float(seed + k) for k, s in enumerate(PREDICTED_STATS)}
                rows.append(dict(player_id=pid, player_display_name=name, position=pos,
                                 team=team, opponent_team=opp, season=g.season, week=g.week,
                                 **stats))
    return pd.DataFrame(rows)


def make_world(completed_through):
    schedules = pd.concat([_schedule(SEASON - 1, 18), _schedule(SEASON, completed_through)],
                          ignore_index=True)
    weekly = _weekly(schedules)
    return weekly, schedules


def fake_combined(history, schedules, season, week, current_teams=None, **kw):
    """Stand-in for `combined_future_features`: one row per scheduled current player.

    Every horizon's frame is indexed 0..n-1, as the real combined frames all
    share a positional index space, and carries a per-(week, history) signal."""
    games = schedules[(schedules.season == season) & (schedules.week == week)]
    opp = {**dict(zip(games.home_team, games.away_team)),
           **dict(zip(games.away_team, games.home_team))}
    rows = []
    for pid, team in sorted(current_teams.items()):
        if team not in opp:
            continue
        name, pos, _ = PLAYERS[pid]
        rows.append(dict(player_id=pid, player_display_name=name, position=pos, team=team,
                         opponent_team=opp[team], is_home=team in set(games.home_team),
                         season=season, week=week,
                         **dict.fromkeys(PREDICTED_STATS, np.nan)))
    future = pd.DataFrame(rows)
    sig = [1.0 + (int(p[-5:]) % 9) + 0.1 * week + 0.001 * len(history) for p in future.player_id]
    combined = future.assign(sig=sig)
    return combined, future


class StatefulPredictor:
    name = "transformer"

    def __init__(self):
        self.attached = None

    def fit(self, train):
        self.fit_through = int(train["season"].max())

    def attach_features(self, frame):
        self.attached = frame

    def predict_quantiles(self, test):
        sig = self.attached.loc[test.index, "sig"].to_numpy()
        p50 = pd.DataFrame({s: sig * (k + 1) * 0.37 for k, s in enumerate(PREDICTED_STATS)},
                           index=test.index)
        return {"p10": p50 * 0.5, "p50": p50, "p90": p50 * 1.5}


def catalog():
    out = {f"s{i}": {"gsis_id": pid, "full_name": name, "position": pos, "team": team}
           for i, (pid, (name, pos, team)) in enumerate(sorted(PLAYERS.items()))}
    return out


def ecr_rows():
    ids = sorted(PLAYERS)[:10]
    return pd.DataFrame({"player_id": ids, "pos": [PLAYERS[i][1] for i in ids],
                         "ecr": [float(k + 1) for k in range(len(ids))],
                         "scrape_date": pd.Timestamp("2026-09-08"),
                         "fp_page": "snapshot:fantasypros-draft-all-rankings"})


@pytest.fixture
def world(monkeypatch):
    """Patch every input the batch and `generate.main` pull; return a control dict."""
    import ffmodel.data.features as features_mod
    import ffmodel.data.future as future_mod
    import ffmodel.data.pull as pull_mod
    import ffmodel.data.rosters as rosters_mod
    import ffmodel.site.generate as gen_mod
    import ffmodel.site.kickoffs as kickoffs_mod
    import ffmodel.site.remaining as remaining_mod
    import ffmodel.site.sleeper as sleeper_mod
    import ffmodel.site.weekly as weekly_mod

    state = {"completed_through": 5, "predictors": [], "sleeper_calls": [],
             "ecr": ecr_rows}

    def frames():
        return make_world(state["completed_through"])

    def pull_weekly(seasons, cache_dir=None):
        w = frames()[0]
        return w[w.season.isin(seasons)].reset_index(drop=True)

    def pull_schedules(seasons, cache_dir=None):
        s = frames()[1]
        return s[s.season.isin(seasons)].reset_index(drop=True)

    monkeypatch.setattr(pull_mod, "pull_weekly", pull_weekly)
    monkeypatch.setattr(pull_mod, "pull_schedules", pull_schedules)
    monkeypatch.setattr(pull_mod, "pull_draft_picks", lambda *a, **k: pd.DataFrame())
    monkeypatch.setattr(rosters_mod, "pull_current_teams", lambda *a, **k: dict(CURRENT_TEAMS))
    monkeypatch.setattr(rosters_mod, "assert_roster_coverage", lambda *a, **k: None)
    monkeypatch.setattr(features_mod, "build_features", lambda weekly, schedules: weekly)
    monkeypatch.setattr(future_mod, "combined_future_features", fake_combined)
    monkeypatch.setattr(remaining_mod, "combined_future_features", fake_combined)
    monkeypatch.setattr(kickoffs_mod, "pull_kickoffs", lambda season, week: {
        "season": season, "week": week, "generated_at": "x", "teams": TEAMS, "games": []})

    def pull_sleeper_players(cache_dir=None, max_age_hours=None):
        state["sleeper_calls"].append(max_age_hours)
        return catalog()
    monkeypatch.setattr(sleeper_mod, "pull_sleeper_players", pull_sleeper_players)
    monkeypatch.setattr(gen_mod, "_canonicalize_draft_picks",
                        lambda picks, data_dir, target_season=None: (picks, 0))

    def load_consensus(season, schedules, data_dir, draft_picks=None, **kw):
        return state["ecr"](), {"ranked": 10}
    monkeypatch.setattr(gen_mod, "_load_consensus", load_consensus)

    def make_predictor(args, features):
        p = StatefulPredictor()
        state["predictors"].append(p)
        return p
    monkeypatch.setattr(gen_mod, "_make_predictor", make_predictor)
    # The batch mutates the process-global league lens; never leak it.
    monkeypatch.setitem(weekly_mod.RULESETS, "league", weekly_mod.RULESETS["league"])
    return state


def run_batch(out, *extra, week="auto"):
    return batch.main(["--out", str(out), "--model", "transformer", "--season", str(SEASON),
                       "--week", week, "--leagues", "gabagool,fam", "--artifact-root", ROOTS,
                       "--data-dir", "unused-cache", *extra])


def run_generate(out, league, monkeypatch):
    import ffmodel.site.generate as gen_mod
    monkeypatch.setattr(sys, "argv", ["gen", "--out", str(out), "--model", "transformer",
                                      "--season", str(SEASON), "--week", "auto", "--remaining",
                                      "--artifact-root", ROOTS, "--league", league,
                                      "--data-dir", "unused-cache"])
    gen_mod.main()


def _load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _without(doc, *keys):
    return {k: v for k, v in doc.items() if k not in keys}


def test_writes_every_required_file_and_a_manifest_with_one_batch_id(world, tmp_path):
    out = tmp_path / "stage"
    assert run_batch(out) == 0
    manifest = _load(out / "manifest.json")
    listed = {f["path"]: f for f in manifest["files"]}
    assert set(publish.REQUIRED) <= set(listed)
    assert "manifest.json" not in listed
    on_disk = {p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file()}
    assert on_disk == set(listed) | {"manifest.json"}
    for rel, entry in listed.items():
        assert hashlib.sha256((out / rel).read_bytes()).hexdigest() == entry["sha256"]
    neutral_docs = [_load(out / n) for n in publish.NEUTRAL]
    assert len({d["batch_id"] for d in neutral_docs}) == 1
    assert manifest["batch_id"] == neutral_docs[0]["batch_id"]
    ctx = neutral_docs[0]
    assert (ctx["season"], ctx["week"], ctx["data_through"]) == (SEASON, 6, "2026-wk5")
    assert ctx["batch_id"] == f"{ctx['generated_at']}|2026-wk5|w6"
    # One stamp for the whole batch, legacy projection files included.
    for name in ("weekly.json", "weekly-fam.json", "remaining-gabagool.json", "remaining-fam.json"):
        assert _load(out / name)["generated_at"] == ctx["generated_at"]
    # The publish validator accepts what the batch writes.
    assert publish.validate(out) == []
    # Pulled once, fit once, the catalog with the 24-hour bound.
    assert len(world["predictors"]) == 1
    assert world["sleeper_calls"] == [24]


def test_neutral_documents_are_built_from_the_batch(world, tmp_path):
    out = tmp_path / "stage"
    assert run_batch(out) == 0
    weekly_n = _load(out / "neutral/weekly.json")
    remaining_n = _load(out / "neutral/remaining.json")
    players_n = _load(out / "neutral/players.json")
    formats_n = _load(out / "neutral/formats.json")
    evaluation_n = _load(out / "neutral/evaluation.json")
    assert weekly_n["kind"] == "neutral_weekly"
    assert all(set(p["points"]) == {"ppr", "half_ppr", "standard"} for p in weekly_n["players"])
    assert weekly_n["pick_six_forecast"]["method"] == "pooled_return_rate_expected_cost_v1"
    assert weekly_n["method"] == remaining_n["method"]
    assert weekly_n["method"]["artifacts"] == sorted(ROOTS.split(","))
    assert weekly_n["method"]["prior"]["rate"] == weekly_n["pick_six_forecast"]["rate"]
    assert (remaining_n["start_week"], remaining_n["end_week"]) == (6, 17)
    assert "league" not in remaining_n and "evaluation" not in remaining_n
    assert {p["player_id"] for p in players_n["players"]} == set(PLAYERS)
    assert players_n["ecr_source"] == {"source": "snapshot:fantasypros-draft-all-rankings",
                                       "date": "2026-09-08", "scoring": "PPR"}
    assert sum(p["ecr"] is not None for p in players_n["players"]) == 10
    assert not any(p["identity_only"] for p in players_n["players"])
    assert formats_n["formats"] == neutral.format_table()
    assert formats_n["kind"] == "neutral_formats" and formats_n["schema_version"] == 1
    assert evaluation_n["kind"] == "neutral_evaluation"
    # about.json keeps the FULL observed stamp (identical here: the slate is unplayed).
    assert _load(out / "about.json")["data_through"] == "2026-wk5"


def test_neutral_remaining_is_compact_and_legacy_weekly_is_indented(world, tmp_path):
    out = tmp_path / "stage"
    assert run_batch(out) == 0
    assert b"\n" not in (out / "neutral/remaining.json").read_bytes()
    assert b"\n" not in (out / "remaining-fam.json").read_bytes()
    assert b"\n  " in (out / "weekly.json").read_bytes()


def test_refuses_a_non_empty_out(world, tmp_path, capsys):
    out = tmp_path / "stage"
    out.mkdir()
    (out / "stale.json").write_text("{}", encoding="utf-8")
    assert run_batch(out) != 0
    assert "not empty" in capsys.readouterr().err
    assert [p.name for p in out.iterdir()] == ["stale.json"]
    assert world["predictors"] == []          # refused before any pull or fit


def test_a_remaining_failure_for_one_league_aborts_with_no_manifest(world, tmp_path, monkeypatch):
    import ffmodel.site.remaining as remaining_mod
    real = remaining_mod.build_remaining

    def flaky(*a, **kw):
        if (kw.get("league") or {}).get("slug") == "fam":
            raise ValueError("current team outside schedule coverage")
        return real(*a, **kw)
    monkeypatch.setattr(remaining_mod, "build_remaining", flaky)
    out = tmp_path / "stage"
    assert run_batch(out) != 0
    assert not (out / "manifest.json").exists()
    assert not out.exists() or not any(out.rglob("*.json"))


def test_week_18_writes_empty_remaining_and_succeeds(world, tmp_path):
    world["completed_through"] = 17
    out = tmp_path / "stage"
    assert run_batch(out) == 0
    remaining_n = _load(out / "neutral/remaining.json")
    assert remaining_n["status"] == "no_remaining_weeks"
    assert remaining_n["players"] == [] and remaining_n["start_week"] == 18
    ctx = _load(out / "neutral/weekly.json")
    assert remaining_n == neutral.empty_remaining(
        neutral.BatchContext(**{k: ctx[k] for k in
                                ("season", "week", "data_through", "generated_at", "batch_id")}),
        "transformer")
    # Legacy remaining keeps today's week-18 behaviour (end_week = max(week, 17)).
    legacy = _load(out / "remaining-gabagool.json")
    assert (legacy["start_week"], legacy["end_week"]) == (18, 18)
    assert publish.validate(out) == []


def test_missing_ecr_never_fails_the_batch(world, tmp_path):
    def boom():
        raise RuntimeError("ECR snapshot crosswalk matched only 80%")
    world["ecr"] = boom
    out = tmp_path / "stage"
    assert run_batch(out) == 0
    players_n = _load(out / "neutral/players.json")
    assert players_n["ecr_source"] is None
    assert all(p["ecr"] is None for p in players_n["players"])
    assert publish.validate(out) == []


def test_malformed_ecr_rows_never_fail_the_batch(world, tmp_path):
    world["ecr"] = lambda: ecr_rows().assign(fp_page=["a", "b"] * 5)   # two pages
    out = tmp_path / "stage"
    assert run_batch(out) == 0
    assert _load(out / "neutral/players.json")["ecr_source"] is None


def test_oversize_neutral_remaining_fails_the_batch(world, tmp_path, monkeypatch):
    monkeypatch.setattr(publish, "SIZE_CAP_BYTES", 1000)
    out = tmp_path / "stage"
    assert run_batch(out) != 0
    assert not (out / "manifest.json").exists()


def test_debug_full_precision_is_written_outside_the_manifest(world, tmp_path):
    out, debug = tmp_path / "stage", tmp_path / "full.json"
    assert run_batch(out, "--debug-full-precision", str(debug)) == 0
    full = _load(debug)
    remaining_n = _load(out / "neutral/remaining.json")
    pid = remaining_n["players"][0]["player_id"]
    row = next(r for r in remaining_n["players"][0]["weeks"]
               if r["status"] == "conditional_projection")
    block = full[pid][str(row["week"])]
    assert [round(block["p50"][s], 4) for s in remaining_n["stat_order"]] == row["stats"][1]
    assert "full.json" not in {f["path"] for f in _load(out / "manifest.json")["files"]}


def test_legacy_outputs_equal_todays_generate_sequence_per_league(world, tmp_path, monkeypatch):
    """Each league's legacy files equal `generate.py --week auto --remaining` run alone."""
    stage = tmp_path / "stage"
    assert run_batch(stage) == 0
    batch_predictor = world["predictors"][-1]
    assert batch_predictor.attached is not None
    for league, weekly_name in (("gabagool", "weekly.json"), ("fam", "weekly-fam.json")):
        alone = tmp_path / f"alone-{league}"
        run_generate(alone, league, monkeypatch)
        for name in (weekly_name, f"remaining-{league}.json", "roles.json"):
            got = _without(_load(stage / name), "generated_at")
            want = _without(_load(alone / name), "generated_at")
            assert got == want, f"{league}: {name} differs from generate.py in isolation"
        assert (_without(_load(stage / "about.json"), "generated_at")
                == _without(_load(alone / "about.json"), "generated_at"))
        assert _load(stage / "kickoffs.json") == _load(alone / "kickoffs.json")
    # Each league's file carries its own contract.
    gab, fam = _load(stage / "weekly.json"), _load(stage / "weekly-fam.json")
    assert gab["league"]["slug"] == "gabagool" and fam["league"]["slug"] == "fam"


def test_parity_test_detects_a_stale_attached_frame(world, tmp_path, monkeypatch):
    """Guard on the guard: weekly built while a remaining horizon is attached differs."""
    import ffmodel.site.remaining as remaining_mod
    import ffmodel.site.weekly as weekly_mod
    weekly_a, schedules = make_world(5)
    history = weekly_a[(weekly_a.season < SEASON) | (weekly_a.week < 6)]
    combined, future = fake_combined(history, schedules, SEASON, 6, CURRENT_TEAMS)
    p = StatefulPredictor()
    p.attach_features(combined)
    good = weekly_mod.build_weekly_projections(future, p, SEASON, 6, "2026-wk5")
    stale, _ = fake_combined(history, schedules, SEASON, 17, CURRENT_TEAMS)
    p.attach_features(stale)
    bad = weekly_mod.build_weekly_projections(future, p, SEASON, 6, "2026-wk5")
    assert _without(good, "generated_at") != _without(bad, "generated_at")


def test_format_table_matches_the_frozen_payloads():
    payloads = json.loads(Path("models/prospective/2026/format_payloads.json")
                          .read_text(encoding="utf-8"))
    table = neutral.format_table()
    assert [r["label"] for r in table] == ["f12-1qb-ppr-6", "f10-1qb-ppr-6", "f12-1qb-ppr-4",
                                           "f12-1qb-half-4", "f12-sf-ppr-4"]
    for row in table:
        assert set(row) == {"label", "format_key", "compat", "description", "exploratory"}
        assert row["format_key"] == payloads[row["label"]]["format_key"]
        assert (json.dumps(row["compat"]) == json.dumps(payloads[row["label"]]["compat"]))
        assert row["exploratory"] is (row["label"] == "f12-sf-ppr-4")
    assert table[0]["description"] == "12-team 1QB PPR, 6-pt pass TD"
    assert table[4]["description"] == "12-team superflex PPR, 4-pt pass TD (exploratory)"


def test_committed_formats_fixture_is_the_enveloped_table():
    fixture = json.loads(Path("tests/fixtures/neutral_formats.json").read_text(encoding="utf-8"))
    assert fixture["kind"] == "neutral_formats" and fixture["schema_version"] == 1
    for key in ("season", "week", "data_through", "generated_at", "batch_id"):
        assert key in fixture
    assert fixture["formats"] == neutral.format_table()


def test_rejects_unsupported_leagues_and_models(world, tmp_path):
    with pytest.raises(SystemExit):
        batch.main(["--out", str(tmp_path / "a"), "--model", "transformer", "--season", "2026",
                    "--week", "auto", "--leagues", "gabagool,espnfam", "--artifact-root", ROOTS])
    with pytest.raises(SystemExit):
        batch.main(["--out", str(tmp_path / "b"), "--model", "xgboost", "--season", "2026",
                    "--week", "auto", "--leagues", "gabagool,fam"])
    assert world["predictors"] == []
