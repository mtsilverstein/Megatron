import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ffmodel.site.generate import _atomic_write, build_parser, validate_inputs

from tests.test_features import make_schedules, make_weekly


def test_parser_defaults_and_flags():
    args = build_parser().parse_args(["--out", "site/data", "--model", "xgboost",
                                      "--season", "2023", "--week", "7"])
    assert args.model == "xgboost" and args.week == "7" and not args.draft


def test_parser_artifact_root_accepts_comma_separated_string():
    args = build_parser().parse_args(["--out", "site/data", "--model", "transformer",
                                      "--season", "2023", "--week", "7",
                                      "--artifact-root", "root_a,root_b"])
    assert args.artifact_root == "root_a,root_b"


def test_make_predictor_transformer_single_root_matches_single_member():
    """A bare (no-comma) --artifact-root must still produce a predictor
    equivalent to the pre-ensemble single-root call (site currently deploys
    a single artifact root in production -- see the notebook's promotion
    notes -- so this is the path GitHub Actions actually exercises)."""
    from argparse import Namespace

    from ffmodel.site.generate import _make_predictor

    args = Namespace(model="transformer", artifact_root="models/transformer/v1")
    predictor = _make_predictor(args, pd.DataFrame())
    assert [str(r) for r in predictor.artifact_roots] == [str(Path("models/transformer/v1"))]


def test_make_predictor_transformer_comma_separated_builds_ensemble():
    from argparse import Namespace

    from ffmodel.site.generate import _make_predictor

    args = Namespace(model="transformer",
                     artifact_root="models/transformer/v1_s43, models/transformer/v1_s44")
    predictor = _make_predictor(args, pd.DataFrame())
    assert [str(r) for r in predictor.artifact_roots] == [
        str(Path("models/transformer/v1_s43")), str(Path("models/transformer/v1_s44")),
    ]


def test_make_predictor_transformer_requires_artifact_root():
    from argparse import Namespace

    from ffmodel.site.generate import _make_predictor

    args = Namespace(model="transformer", artifact_root=None)
    with pytest.raises(SystemExit):
        _make_predictor(args, pd.DataFrame())


def test_validate_rejects_empty_and_sparse():
    sched = make_schedules(6)
    with pytest.raises(RuntimeError, match="empty"):
        validate_inputs(make_weekly([]).iloc[0:0], sched, season=2023)
    sparse = make_weekly([{"week": 1}])
    with pytest.raises(RuntimeError, match="rows"):
        validate_inputs(sparse, sched, season=2023)


def test_validate_requires_schedule_coverage():
    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in range(1, 7) for i in range(40)])
    with pytest.raises(RuntimeError, match="schedule"):
        validate_inputs(weekly, make_schedules(6, season=2022), season=2023)


def test_atomic_write_never_leaves_partial(tmp_path):
    target = tmp_path / "weekly.json"
    target.write_text('{"old": true}')

    class Boom:
        def __iter__(self):  # break json serialization mid-flight
            raise RuntimeError("boom")

    with pytest.raises(TypeError):
        _atomic_write(target, {"players": Boom()})
    assert json.loads(target.read_text()) == {"old": True}   # untouched
    assert not list(tmp_path.glob("*.tmp"))                  # tmp cleaned up


def test_atomic_write_happy_path(tmp_path):
    target = tmp_path / "draft.json"
    _atomic_write(target, {"ok": 1})
    assert json.loads(target.read_text()) == {"ok": 1}


def test_require_backtests_rejects_empty():
    from ffmodel.site.generate import require_backtests

    with pytest.raises(RuntimeError, match="empty about page"):
        require_backtests([])
    assert require_backtests([Path("x.json")]) == [Path("x.json")]


def test_parser_requires_week_or_draft():
    from ffmodel.site.generate import parse_and_validate

    with pytest.raises(SystemExit):
        parse_and_validate(["--out", "x", "--model", "xgboost",
                            "--season", "2026"])


def test_week_auto_resolves_first_unplayed():
    from ffmodel.site.generate import resolve_week

    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in (1, 2) for i in range(3)])
    sched = make_schedules(4)
    assert resolve_week("auto", weekly, sched, season=2023) == 3
    assert resolve_week(4, weekly, sched, season=2023) == 4


def test_week_auto_errors_when_season_complete():
    from ffmodel.site.generate import resolve_week

    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in (1, 2, 3, 4) for i in range(3)])
    sched = make_schedules(4)
    with pytest.raises(RuntimeError, match="2023"):
        resolve_week("auto", weekly, sched, season=2023)


def _sched_with_scores(weeks=4, season=2026, completed_rows=None):
    """make_schedules() plus home_score/away_score columns (all-NaN unless
    `completed_rows` gives {row_index: (home_score, away_score)})."""
    sched = make_schedules(weeks, season=season)
    sched["home_score"] = np.nan
    sched["away_score"] = np.nan
    for idx, (home, away) in (completed_rows or {}).items():
        sched.loc[idx, "home_score"] = home
        sched.loc[idx, "away_score"] = away
    return sched


def test_season_has_completed_game_false_when_all_scores_missing():
    from ffmodel.site.generate import _season_has_completed_game

    sched = _sched_with_scores()
    assert _season_has_completed_game(sched, 2026) is False


def test_season_has_completed_game_true_when_any_score_present():
    from ffmodel.site.generate import _season_has_completed_game

    sched = _sched_with_scores(completed_rows={0: (24.0, 17.0)})
    assert _season_has_completed_game(sched, 2026) is True


def test_season_has_completed_game_ignores_other_seasons():
    from ffmodel.site.generate import _season_has_completed_game

    sched = _sched_with_scores(season=2025, completed_rows={0: (24.0, 17.0)})
    assert _season_has_completed_game(sched, 2026) is False


def test_season_has_completed_game_missing_columns_raises():
    """Belt-and-suspenders guard: a schedules frame that somehow lacks the
    score columns (e.g. an old cache slipping through) must not be silently
    treated as 'zero completed games' -- that would be an unsafe guess."""
    from ffmodel.site.generate import _season_has_completed_game

    sched = make_schedules(4, season=2026)  # no score columns
    with pytest.raises(RuntimeError, match="home_score"):
        _season_has_completed_game(sched, 2026)


def test_extend_with_target_season_tolerates_pre_week1_404(monkeypatch):
    """(a) target-season pull raises + zero completed games -> proceed with
    prior-season data only; resolve_week('auto', ...) then lands on the
    first scheduled week."""
    from ffmodel.site.generate import _extend_with_target_season, resolve_week

    def boom(seasons, cache_dir=None):
        raise RuntimeError("404: player_stats file not found for 2026")

    monkeypatch.setattr("ffmodel.data.pull.pull_weekly", boom)

    prior = make_weekly([{"season": 2025, "week": w, "player_id": f"p{i}"}
                         for w in range(1, 5) for i in range(3)])
    sched = _sched_with_scores()  # 2026, zero completed games

    out = _extend_with_target_season(prior, sched, season=2026, data_dir=None)

    pd.testing.assert_frame_equal(out, prior)
    assert resolve_week("auto", out, sched, season=2026) == 1


def test_extend_with_target_season_reraises_when_games_completed(monkeypatch):
    """(b) target-season pull raises + at least one completed game -> the
    original failure propagates (fail-safe, mid-season breakage must abort)."""
    from ffmodel.site.generate import _extend_with_target_season

    def boom(seasons, cache_dir=None):
        raise RuntimeError("upstream broke mid-season")

    monkeypatch.setattr("ffmodel.data.pull.pull_weekly", boom)

    prior = make_weekly([{"season": 2025, "week": 1, "player_id": "p1"}])
    sched = _sched_with_scores(completed_rows={0: (24.0, 17.0)})

    with pytest.raises(RuntimeError, match="2026") as excinfo:
        _extend_with_target_season(prior, sched, season=2026, data_dir=None)
    assert "upstream broke mid-season" in str(excinfo.value.__cause__)


def test_extend_with_target_season_concats_on_success(monkeypatch):
    """When the pull succeeds, behavior is unchanged: current season rows
    are appended to `weekly`."""
    from ffmodel.site.generate import _extend_with_target_season

    current = make_weekly([{"season": 2026, "week": 1, "player_id": "p9"}])

    def fake(seasons, cache_dir=None):
        assert seasons == [2026]
        return current

    monkeypatch.setattr("ffmodel.data.pull.pull_weekly", fake)

    prior = make_weekly([{"season": 2025, "week": 1, "player_id": "p1"}])
    sched = _sched_with_scores()

    out = _extend_with_target_season(prior, sched, season=2026, data_dir=None)
    assert len(out) == 2
    assert set(out["season"]) == {2025, 2026}


def _run_generate_with_stubs(monkeypatch, tmp_path, argv, capture: dict,
                             pull_draft_picks=None):
    """Run generate.main() end-to-end with data pulls, predictor, and payload
    builders stubbed. Records the sleeper_players/draft_picks kwargs
    build_draft_board saw. `pull_draft_picks`, if given, overrides the
    default tiny-valid-frame stub for `ffmodel.data.pull.pull_draft_picks`
    (e.g. a boom function, to prove a weekly-only run never calls it)."""
    import sys

    import ffmodel.data.features as features_mod
    import ffmodel.data.pull as pull_mod
    import ffmodel.data.rankings as rankings_mod
    import ffmodel.site.about as about_mod
    import ffmodel.site.draft as draft_mod
    import ffmodel.site.generate as gen_mod

    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in range(1, 7) for i in range(40)])
    sched = make_schedules(6)
    # make_schedules() (tests/test_features.py) doesn't carry home_score/
    # away_score -- _season_has_completed_game requires them. Extend the
    # local frame here rather than the shared fixture (per task brief note).
    sched = sched.assign(home_score=float("nan"), away_score=float("nan"))
    monkeypatch.setattr(pull_mod, "pull_weekly", lambda *a, **k: weekly)
    monkeypatch.setattr(pull_mod, "pull_schedules", lambda *a, **k: sched)
    monkeypatch.setattr(features_mod, "build_features", lambda *a, **k: weekly)

    if pull_draft_picks is None:
        draft_picks_frame = pd.DataFrame([
            {"season": 2012, "round": 1, "pick": 1, "team": "AAA",
             "gsis_id": "00-0000001", "pfr_player_id": "B0000001",
             "player_name": "A B", "position": "QB",
             "age": 21.0, "college": "State"}])
        pull_draft_picks = lambda *a, **k: draft_picks_frame
    monkeypatch.setattr(pull_mod, "pull_draft_picks", pull_draft_picks)

    # `_canonicalize_draft_picks` (called on the --draft path, before either
    # ECR or the board see draft_picks) does its own deferred
    # `from ffmodel.data.rankings import ... pull_player_ids` -- stub it here
    # too, on the module it's actually resolved from at call time, or a
    # --draft test would escape every other stub in this helper and hit the
    # live identity feed over the network (see test_load_adp_...snapshot's
    # docstring for the prior real incident this project had with exactly
    # that failure mode).
    player_ids_frame = pd.DataFrame({"pfr_id": ["B0000001"], "gsis_id": ["00-0000001"]})
    monkeypatch.setattr(rankings_mod, "pull_player_ids",
                        lambda *a, **k: player_ids_frame)
    # Belt-and-suspenders proof the stub above actually takes effect (rather
    # than silently missing, e.g. because it targeted a re-exported alias
    # instead of the module the deferred import resolves from): make the
    # real network-hitting loader explode if anything still reaches it.
    import nflreadpy
    def boom_load_ff_playerids(*a, **k):
        raise AssertionError(
            "must not hit the live nflreadpy identity feed -- "
            "pull_player_ids should have been stubbed")
    monkeypatch.setattr(nflreadpy, "load_ff_playerids", boom_load_ff_playerids)

    ecr_df = pd.DataFrame({"player_id": ["00-0000001"], "pos": ["QB"], "ecr": [1.0]})
    def fake_consensus(s, sched, d, picks=None):
        capture["consensus_draft_picks"] = picks
        return ecr_df, {"match_rate": 1.0}
    monkeypatch.setattr(gen_mod, "_load_consensus", fake_consensus)
    monkeypatch.setattr(gen_mod, "_load_adp",
                        lambda s, d, **kw: (pd.DataFrame({"player_id": ["00-0000001"], "adp": [1.0]}),
                                     {"source": "sleeper_snapshot",
                                      "snapshot_date": "2026-07-27"}))
    monkeypatch.setattr(gen_mod, "_late_slots",
                        lambda season, data_dir: {"K": [], "DST": []})

    class _Stub:
        name = "stub"
        def fit(self, train): pass
    monkeypatch.setattr(gen_mod, "_make_predictor", lambda args, feats: _Stub())

    def fake_board(*a, **k):
        capture["sleeper_players"] = k.get("sleeper_players")
        capture["draft_picks"] = k.get("draft_picks")
        capture["ecr"] = k.get("ecr")
        capture["adp"] = k.get("adp")
        capture["replacement_rank"] = k.get("replacement_rank")
        return {"players": []}
    monkeypatch.setattr(draft_mod, "build_draft_board", fake_board)
    monkeypatch.setattr(about_mod, "build_about",
                        lambda *a, **k: {"site_model": "stub"})
    monkeypatch.setattr(gen_mod, "require_backtests", lambda paths: paths)

    monkeypatch.setattr(sys, "argv", ["gen", "--out", str(tmp_path / "out"),
                                      "--model", "xgboost", "--season", "2023",
                                      *argv])
    gen_mod.main()


def test_draft_run_threads_sleeper_dump_into_board(monkeypatch, tmp_path):
    import ffmodel.site.sleeper as sleeper_mod

    dump = {"1": {"gsis_id": "00-0000001", "full_name": "A B", "position": "QB"}}
    monkeypatch.setattr(sleeper_mod, "pull_sleeper_players", lambda **k: dump)
    capture = {}
    _run_generate_with_stubs(monkeypatch, tmp_path, ["--draft"], capture)
    assert capture["sleeper_players"] is dump
    assert capture["draft_picks"] is not None
    assert capture["consensus_draft_picks"] is capture["draft_picks"]
    # the three consensus kwargs are actually forwarded into the board build
    assert capture["ecr"] == {"00-0000001": 1.0}
    assert capture["adp"] == {"00-0000001": 1.0}
    assert set(capture["replacement_rank"]) == {"QB", "RB", "WR", "TE"}
    assert capture["replacement_rank"]["QB"] == 13   # derived, non-flex position
    assert (tmp_path / "out" / "draft.json").exists()
    # main() actually attaches the late-slot block (stubbed empty by the helper)
    written = json.loads((tmp_path / "out" / "draft.json").read_text())
    assert written["late_slots"] == {"K": [], "DST": []}
    # ...and the ADP provenance the stubbed _load_adp reported
    assert written["adp_source"] == {"source": "sleeper_snapshot",
                                     "snapshot_date": "2026-07-27"}


def test_weekly_only_run_never_touches_sleeper(monkeypatch, tmp_path):
    import ffmodel.site.sleeper as sleeper_mod

    def boom(**k):
        raise AssertionError("weekly-only run must not fetch Sleeper")
    monkeypatch.setattr(sleeper_mod, "pull_sleeper_players", boom)
    import ffmodel.data.future as future_mod
    import ffmodel.site.weekly as weekly_mod
    monkeypatch.setattr(future_mod, "combined_future_features",
                        lambda *a, **k: (None, None))
    monkeypatch.setattr(weekly_mod, "build_weekly_projections",
                        lambda *a, **k: {"players": []})

    def boom_draft_picks(*a, **k):
        raise AssertionError("weekly-only run must not pull draft picks")
    capture = {}
    _run_generate_with_stubs(monkeypatch, tmp_path, ["--week", "6"], capture,
                             pull_draft_picks=boom_draft_picks)
    assert (tmp_path / "out" / "weekly.json").exists()


def test_draft_run_aborts_before_writing_when_sleeper_pull_fails(monkeypatch, tmp_path):
    import ffmodel.site.sleeper as sleeper_mod

    def fail(**k):
        raise RuntimeError("sleeper is down")
    monkeypatch.setattr(sleeper_mod, "pull_sleeper_players", fail)
    capture = {}
    with pytest.raises(RuntimeError, match="sleeper is down"):
        _run_generate_with_stubs(monkeypatch, tmp_path, ["--draft"], capture)
    out = tmp_path / "out"
    assert not (out / "draft.json").exists()
    assert not (out / "about.json").exists()   # fail-safe: NOTHING was written


def test_failed_pull_leaves_preseeded_published_json_byte_identical(monkeypatch, tmp_path):
    """CLAUDE.md fail-safe invariant: 'on a failed or incomplete data pull,
    abort without touching published JSON.' The existing abort test only
    proves nothing is created in an EMPTY output dir -- it can't distinguish
    'wrote nothing' from 'silently clobbered what was already there'.
    Pre-seed the output dir with realistic prior-run JSON, trigger the same
    failed-pull abort (Sleeper down, before any payload is built or written),
    and assert every pre-seeded file is byte-identical (and its mtime
    unchanged) afterward. `main()` happens to satisfy this today by building
    everything in memory before writing anything, but nothing short of this
    would catch a future regression that moved a write earlier."""
    import ffmodel.site.sleeper as sleeper_mod

    out = tmp_path / "out"
    out.mkdir()
    prior_files = {
        "weekly.json": '{"players": [{"name": "Prior Guy"}], "data_through": "2022-wk10"}',
        "draft.json": '{"players": [{"name": "Old Board"}], "season": 2022}',
        "about.json": '{"site_model": "prior-run", "data_through": "2022-wk10"}',
    }
    for name, content in prior_files.items():
        (out / name).write_text(content)
    before_bytes = {name: (out / name).read_bytes() for name in prior_files}
    before_mtimes = {name: (out / name).stat().st_mtime_ns for name in prior_files}

    def fail(**k):
        raise RuntimeError("sleeper is down")
    monkeypatch.setattr(sleeper_mod, "pull_sleeper_players", fail)

    capture = {}
    with pytest.raises(RuntimeError, match="sleeper is down"):
        _run_generate_with_stubs(monkeypatch, tmp_path, ["--draft"], capture)

    for name in prior_files:
        assert (out / name).read_bytes() == before_bytes[name], f"{name} bytes changed"
        assert (out / name).stat().st_mtime_ns == before_mtimes[name], f"{name} mtime changed"
    assert not list(out.glob("*.tmp"))


def test_draft_consensus_ecr_required_adp_best_effort(monkeypatch):
    from ffmodel.site import generate

    ecr_df = pd.DataFrame({"player_id": ["00-1", "00-2"],
                           "pos": ["RB", "WR"], "ecr": [1.0, 2.0]})
    monkeypatch.setattr(generate, "_load_consensus",
                        lambda s, sched, d: (ecr_df, {"match_rate": 1.0}))

    # ADP fails -> swallowed, ecr still returned; replacement derived (tiny pool)
    monkeypatch.setattr(generate, "_load_adp",
                        lambda s, d, **kw: (_ for _ in ()).throw(RuntimeError("403")))
    ecr, adp, replacement, adp_source = generate._draft_consensus(2026, pd.DataFrame(), "data/raw")
    assert ecr == {"00-1": 1.0, "00-2": 2.0} and adp is None
    assert adp_source is None   # no ADP -> no source to report, honestly
    assert set(replacement) == {"QB", "RB", "WR", "TE"}   # derived, all positions

    # ADP ok -> mapped, and its source recorded
    adp_df = pd.DataFrame({"player_id": ["00-1"], "adp": [6.0]})
    monkeypatch.setattr(generate, "_load_adp",
                        lambda s, d, **kw: (adp_df, {"source": "ffcalculator"}))
    ecr, adp, replacement, adp_source = generate._draft_consensus(2026, pd.DataFrame(), "data/raw")
    assert adp == {"00-1": 6.0}
    assert adp_source == {"source": "ffcalculator"}


def test_draft_consensus_ecr_failure_propagates(monkeypatch):
    from ffmodel.site import generate

    monkeypatch.setattr(generate, "_load_consensus",
                        lambda s, sched, d: (_ for _ in ()).throw(
                            ValueError("no consensus scrape before kickoff")))
    with pytest.raises(ValueError, match="no consensus scrape"):
        generate._draft_consensus(2026, pd.DataFrame(), "data/raw")


def test_load_adp_uses_snapshot_when_present(monkeypatch, tmp_path):
    """`_load_adp` must prefer the committed Sleeper snapshot over a live
    FFCalculator call whenever the snapshot file exists -- and must NOT hit
    FFCalculator at all in that case (a stubbed `pull_adp` that raises if
    called proves it; this repo has a real prior incident where a missed
    stub let a test hit fantasyfootballcalculator.com live)."""
    from ffmodel.site import generate
    import ffmodel.data.adp as adp_mod
    import ffmodel.data.rankings as rankings_mod

    snap = tmp_path / "fantasypros_adp_2026-07-27.csv"
    snap.write_text(
        "Rank,Player (Bye),POS,ESPN,Sleeper,CBS,NFL,RTSports,Fantrax,AVG,Real-Time\n"
        "1,Some Guy   KC (10),WR1,1,1,1,—,—,—,1.0,1\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(adp_mod, "SNAPSHOT_PATH", snap)
    crosswalk = pd.DataFrame({"gsis_id": ["00-9"], "merge_name": ["some guy"]})
    monkeypatch.setattr(rankings_mod, "pull_player_ids", lambda cache_dir=None: crosswalk)

    def boom_ffcalculator(*a, **k):
        raise AssertionError("must not hit FFCalculator when the snapshot is present")
    monkeypatch.setattr(adp_mod, "pull_adp", boom_ffcalculator)

    adp_df, source = generate._load_adp(2026, tmp_path)
    assert list(adp_df["player_id"]) == ["00-9"]
    assert source == {"source": "sleeper_snapshot", "path": snap.as_posix(),
                      "snapshot_date": "2026-07-27",
                      # no draft_picks passed -> nothing restored, reported as 0
                      # rather than omitted, so the field is always present
                      "gsis_backfilled_from_draft_picks": 0}


def test_load_adp_falls_back_to_ffcalculator_when_snapshot_missing(monkeypatch, tmp_path):
    """No snapshot file -> falls back to `pull_adp` (stubbed here so this
    test cannot hit the network either)."""
    from ffmodel.site import generate
    import ffmodel.data.adp as adp_mod

    monkeypatch.setattr(adp_mod, "SNAPSHOT_PATH", tmp_path / "does-not-exist.csv")
    calls = {}

    def fake_pull_adp(season, cache_dir=None):
        calls["season"], calls["cache_dir"] = season, cache_dir
        return pd.DataFrame({"player_id": ["00-1"], "adp": [3.0]})
    monkeypatch.setattr(adp_mod, "pull_adp", fake_pull_adp)

    adp_df, source = generate._load_adp(2026, tmp_path)
    assert calls == {"season": 2026, "cache_dir": tmp_path}
    assert list(adp_df["player_id"]) == ["00-1"]
    assert source == {"source": "ffcalculator"}


def test_draft_payload_carries_late_slots(monkeypatch, tmp_path):
    from ffmodel.site import generate

    payload = {"season": 2026, "players": []}
    monkeypatch.setattr(generate, "_late_slots", lambda season, data_dir:
                        {"K": [{"name": "Early K", "adp": 140.5}], "DST": []})
    out = generate._attach_late_slots(payload, 2026, tmp_path)
    assert out["late_slots"] == {"K": [{"name": "Early K", "adp": 140.5}],
                                 "DST": []}


def test_late_slots_degrade_to_empty_when_adp_unavailable(monkeypatch, tmp_path):
    from ffmodel.site import generate

    def boom(season, data_dir):
        raise RuntimeError("ffcalculator down")

    monkeypatch.setattr(generate, "_late_slots", boom)
    out = generate._attach_late_slots({"season": 2026, "players": []}, 2026, tmp_path)
    assert out["late_slots"] == {"K": [], "DST": []}


def test_data_through_stamp_is_derived_from_data_and_lands_in_json(monkeypatch, tmp_path):
    """CLAUDE.md: 'The site always shows a data as of <date> stamp.' Pin that
    main()'s `data_through` is actually computed from the pulled weekly
    frame's max (season, week) -- not a constant, not missing -- and that the
    value reaches the written weekly.json. `_run_generate_with_stubs`'s fixed
    weekly frame (tests/test_features.py::make_weekly, season 2023, weeks
    1..6) makes the expected stamp "2023-wk6"; a hardcoded placeholder like
    "unknown" would not match and would fail this test."""
    import ffmodel.data.future as future_mod
    import ffmodel.site.weekly as weekly_mod

    monkeypatch.setattr(future_mod, "combined_future_features", lambda *a, **k: (None, None))

    capture = {}

    def fake_build_weekly_projections(future, predictor, season, week, data_through):
        capture["data_through"] = data_through
        return {"players": [], "data_through": data_through}
    monkeypatch.setattr(weekly_mod, "build_weekly_projections", fake_build_weekly_projections)

    _run_generate_with_stubs(monkeypatch, tmp_path, ["--week", "6"], capture)

    assert capture["data_through"] not in (None, "", "unknown")
    assert capture["data_through"] == "2023-wk6"

    written = json.loads((tmp_path / "out" / "weekly.json").read_text())
    assert written["data_through"] == "2023-wk6"


def test_load_adp_backfills_rookie_gsis_from_draft_picks(monkeypatch):
    """Regression for the 2026-07-28 live incident.

    nflverse's player-id feed blanked `gsis_id` for the current rookie class.
    The ECR spine was repaired for that drift (4ad0871) but ADP reads the SAME
    feed and was not, so the snapshot crosswalk fell to 89.8%, the >=95% guard
    correctly refused to publish a partial overlay, and the published board
    shipped with zero ADP -- the keeper gauge lost its market anchor silently,
    because the overlay is best-effort by design.

    Asserts BOTH directions: without draft_picks the guard still fires (it must
    not be weakened to paper over the drift), and with them the blanks are
    restored from the draft-picks feed by exact PFR id.
    """
    import pandas as pd

    from ffmodel.data import rankings as rankings_mod
    from ffmodel.data.adp import SNAPSHOT_PATH, parse_snapshot_csv
    from ffmodel.site import generate as gen

    names = list(parse_snapshot_csv(SNAPSHOT_PATH)["name"])
    n_blank = 25                       # ~10%, matching the live incident
    crosswalk = pd.DataFrame({
        "merge_name": names,
        "pfr_id": [f"Pfr{i:04d}" for i in range(len(names))],
        "gsis_id": [pd.NA if i < n_blank else f"00-00{i:05d}"
                    for i in range(len(names))],
    })
    picks = pd.DataFrame({
        "pfr_player_id": [f"Pfr{i:04d}" for i in range(n_blank)],
        "gsis_id": [f"00-99{i:05d}" for i in range(n_blank)],
    })
    monkeypatch.setattr(rankings_mod, "pull_player_ids", lambda *a, **k: crosswalk)

    # Without the draft-picks repair the guard must still fire.
    with pytest.raises(ValueError, match="crosswalk matched only"):
        gen._load_adp(2026, Path("data/raw"))

    df, source = gen._load_adp(2026, Path("data/raw"), draft_picks=picks)
    assert source["source"] == "sleeper_snapshot"
    assert source["gsis_backfilled_from_draft_picks"] == n_blank
    assert len(df) == len(names)
    assert df["player_id"].notna().all()
