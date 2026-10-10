"""Spec §4.1-4.6: published values, equivalence, point metrics, the full evaluate path, artifact and markdown."""
import hashlib
import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.eval import live_accuracy as la
from ffmodel.eval import sameweek as sw
from ffmodel.scoring import PREDICTED_STATS
from tests.test_live_accuracy_evidence import FakeGit, _c, _ev, _ledger

LEG, NEU = la.WEEKLY_FILES


def _legacy(gen="g1", players=None, week=4):
    players = players if players is not None else [("p1", "WR", "AAA", 2.0, 5.0, 8.0)]
    return {"season": 2026, "week": week, "generated_at": gen,
            "players": [{"player_id": i, "position": pos, "team": t, "points": {"ppr": {"p10": a, "p50": b, "p90": c}}}
                        for i, pos, t, a, b, c in players]}


def _neutral(gen="g1", rec=(1.0, 2.5, 4.0), players=("p1",)):
    from ffmodel.site.leaguelens import STATS
    sq = {q: {**{s: 0.0 for s in STATS}, "receptions": r, "receiving_yards": 10 * r}
          for q, r in zip(("p10", "p50", "p90"), rec)}
    return {"season": 2026, "week": 4, "generated_at": gen,
            "players": [{"player_id": p, "position": "WR", "team": "AAA", "stat_quantiles": sq} for p in players]}


def test_values_prefer_legacy_and_rescore_neutral():
    w = la.ppr_weights()
    vp, reason, d = la.published_values(_legacy(), _neutral(gen="other"), w, 2026, 4)   # different batch: no check
    assert reason is None and vp.valid["p50"].iloc[0] == 5.0 and d["equivalence_checked"] is False
    vp, reason, _ = la.published_values(None, _neutral(), w, 2026, 4)                     # legacy retired
    assert reason is None and list(vp.valid[["p10", "p50", "p90"]].iloc[0]) == pytest.approx([2.0, 5.0, 8.0])
    assert vp.n_keys == 1 and vp.invalid == {}
    vp, reason, d = la.published_values(_legacy(), _neutral(), w, 2026, 4)               # same batch, within 0.01
    assert reason is None and d["equivalence_checked"] is True


@pytest.mark.parametrize("neutral,field", [
    (_neutral(rec=(1.0, 2.5, 4.6)), "divergent"),                   # p90 off by 1.2
    (_neutral(players=()), "missing_in_neutral"),                   # empty neutral player list
    (_neutral(players=("p2",)), "missing_in_neutral"),              # player missing from the neutral file
])
def test_equivalence_failures(neutral, field):
    vp, reason, d = la.published_values(_legacy(), neutral, la.ppr_weights(), 2026, 4)
    assert vp is None and reason == "equivalence_failed" and d[field]


def test_nan_neutral_quantile_fails_the_neutral_table_before_equivalence():
    bad = _neutral()
    bad["players"][0]["stat_quantiles"]["p50"]["receptions"] = float("nan")
    vp, reason, d = la.published_values(_legacy(), bad, la.ppr_weights(), 2026, 4)
    assert reason is None and vp.fails() and d == {"source": "neutral", "equivalence_checked": False,
                                                   "failed_table": "neutral"}
    assert vp.invalid == {"nonfinite": {("p1",)}}


def test_zero_weight_nan_component_invalidates_neutral_row_before_scoring():
    # astra S7-I4: carries has zero PPR weight, so the points are unchanged; the full-vector check still fails it
    bad = _neutral()
    bad["players"][0]["stat_quantiles"]["p50"]["carries"] = float("nan")
    vp, reason, d = la.published_values(_legacy(), bad, la.ppr_weights(), 2026, 4)
    assert reason is None and vp.fails() and d["failed_table"] == "neutral"
    only, reason, _ = la.published_values(None, bad, la.ppr_weights(), 2026, 4)         # legacy retired
    assert reason is None and only.invalid == {"nonfinite": {("p1",)}} and only.valid.empty and only.fails()


def _many(n, extra=()):
    ids = [f"p{i:03d}" for i in range(n)]
    leg = {"season": 2026, "week": 4, "generated_at": "g1",
           "players": [{"player_id": i, "position": "WR", "team": "AAA",
                        "points": {"ppr": {"p10": 2.0, "p50": 5.0, "p90": 8.0}}} for i in ids]}
    neu = _neutral(players=tuple(ids) + tuple(extra))
    return leg, neu


def test_neutral_only_invalid_player_over_threshold_skips_the_week():
    # astra S71-I1: 20 matching players plus one neutral-only player whose zero-weight p50.carries is NaN.
    # The surviving IDs equal the legacy IDs, but 1/21 of the neutral table is invalid (> 1%): never equivalence.
    leg, neu = _many(20, extra=("extra_bad",))
    neu["players"][-1]["stat_quantiles"] = json.loads(json.dumps(neu["players"][-1]["stat_quantiles"]))
    neu["players"][-1]["stat_quantiles"]["p50"]["carries"] = float("nan")
    vp, reason, d = la.published_values(leg, neu, la.ppr_weights(), 2026, 4)
    assert reason is None and vp.fails() and d["failed_table"] == "neutral"
    assert vp.n_keys == 21 and vp.invalid_keys() == {("extra_bad",)}


def test_neutral_only_invalid_player_at_exactly_one_percent_passes():
    # boundary: 99 matching players plus one invalid neutral-only player = exactly 1% -> passes, equivalence runs
    leg, neu = _many(99, extra=("extra_bad",))
    neu["players"][-1]["stat_quantiles"] = json.loads(json.dumps(neu["players"][-1]["stat_quantiles"]))
    neu["players"][-1]["stat_quantiles"]["p50"]["carries"] = float("nan")
    vp, reason, d = la.published_values(leg, neu, la.ppr_weights(), 2026, 4)
    assert reason is None and not vp.fails() and d["equivalence_checked"] is True and len(vp.valid) == 99


def test_same_player_neutral_vectors_that_score_identically_are_conflicting():
    # astra S7-I4: the second record has one more reception and ten fewer receiving yards in every quantile --
    # valid ordering, identical PPR points, different stat vector. The key is conflicting: 100% of the table.
    neu = _neutral()
    twin = json.loads(json.dumps(neu["players"][0]))
    for q in ("p10", "p50", "p90"):
        twin["stat_quantiles"][q]["receptions"] += 1.0
        twin["stat_quantiles"][q]["receiving_yards"] -= 10.0
    neu["players"].append(twin)
    stats = la._neutral_stats_frame(neu)
    w = la.ppr_weights()
    pts = [la.leaguelens.reference_score(p["stat_quantiles"], "WR", w) for p in neu["players"]]
    assert pts[0] == pytest.approx(pts[1])                                             # same points either way
    vp, reason, d = la.published_values(_legacy(), neu, w, 2026, 4)
    assert reason is None and vp.fails() and d["failed_table"] == "neutral"            # 100% invalid: never equivalence
    only, reason, _ = la.published_values(None, neu, w, 2026, 4)
    assert only.invalid == {"conflicting_duplicates": {("p1",)}} and only.excluded_fraction() == 1.0
    assert la.validate_neutral(stats).n_keys == 1 and only.fails()


def test_point_metrics_hand_computed_and_empty_is_null():
    df = pd.DataFrame({"actual": [10.0, 2.0, 7.0, 4.0], "p10": [1.0, 3.0, 2.0, 1.0], "p50": [6.0, 5.0, 7.0, 4.0],
                       "p90": [9.0, 9.0, 12.0, 8.0], "naive": [8.0, 4.0, 6.0, 4.0]})
    m = la.point_metrics(df)
    assert m["n"] == 4 and m["mae"] == pytest.approx((4 + 3 + 0 + 0) / 4)
    assert m["naive_mae"] == pytest.approx((2 + 2 + 1 + 0) / 4)
    assert m["coverage_p10_p90"] == pytest.approx(2 / 4)            # 10>9 above, 2<3 below
    assert m["below_p10"] == pytest.approx(0.25) and m["above_p90"] == pytest.approx(0.25)
    assert m["share_above_p50"] == pytest.approx(0.25)
    assert m["pinball_p50"] == pytest.approx(0.5 * (4 + 3) / 4)
    empty = la.point_metrics(df.head(0))
    assert empty["n"] == 0 and empty["mae"] is None and empty["pinball_p90"] is None


def test_paired_intervals_accept_scalar_string_clusters():
    df = pd.DataFrame({"actual": [10.0, 2.0, 7.0, 4.0, 6.0, 3.0], "p50": [6.0, 5.0, 7.0, 4.0, 5.0, 3.5],
                       "naive": [8.0, 4.0, 6.0, 4.0, 6.0, 2.0], "player_id": list("abcdef"),
                       "week": [1, 1, 2, 2, 3, 3], "team": ["X", "Y", "X", "Y", "X", "Y"]})
    r = la.paired_intervals(df)
    assert len(r["ci95_player"]) == 2 and len(r["ci95_week_team"]) == 2
    assert r["delta_mae_model_minus_naive"] == pytest.approx(
        np.mean(np.abs(df.actual - df.p50) - np.abs(df.actual - df.naive)))


# --- the full driver path: raw tables -> stage 1 -> build_features -> stage 2 -> scoring --------------------------
TEAMS = ("AAA", "BBB")
POS = ("RB", "WR")


def _raw_world(missing_team_week=None):
    sched, rows = [], []
    for season, start in ((2025, "2025-09-04"), (2026, "2026-09-10")):
        for w in (1, 2):
            day = (pd.Timestamp(start) + pd.Timedelta(days=7 * (w - 1))).strftime("%Y-%m-%d")
            sched.append((season, w, day, "AAA", "BBB"))
            for t in TEAMS:
                if (season, w, t) == missing_team_week:
                    continue
                for pos in POS:
                    for i in range(5):
                        r = {"player_id": f"{t}{pos}{i}", "player_display_name": "x", "position": pos, "team": t,
                             "opponent_team": "BBB" if t == "AAA" else "AAA", "season": season, "week": w,
                             "target_share": np.nan, "snap_pct": np.nan, "two_point_conversions": 0,
                             "special_teams_tds": 0, **{s: 0.0 for s in PREDICTED_STATS}}
                        r["receptions"] = float(i + w)
                        r["receiving_yards"] = float(10 * (i + 1))
                        rows.append(r)
    return (pd.DataFrame(rows),
            pd.DataFrame(sched, columns=["season", "week", "gameday", "home_team", "away_team"]))


def _publication_git(players, dirty=False):
    payload = _legacy(gen="g1", players=players, week=1)
    g = FakeGit({"h0": _c([], changed={"README.md"}, time="2026-07-12T00:00:00Z"),
                 "pub": _c(["h0"], la.BOT, {LEG}, {LEG: json.dumps(payload).encode()}, "2026-09-09T09:00:00Z")})
    g.dirty = lambda path="src/ffmodel": dirty
    return g


BAKEOFF = {"results": [{"position": "OVERALL", "model": m, "test_season": s, "n": 100, "mae": 4.0 + k,
                        "coverage_p10_p90": 0.8} for k, m in enumerate(("transformer", "naive_last4"))
                       for s in (2023, 2024, 2025)]}


def _ctx(git, raw=None, weeks=(1,), as_of="2026-09-20"):
    weekly, sched = raw or _raw_world()
    return la.LiveContext(season=2026, weeks=list(weeks), as_of=pd.Timestamp(as_of),
                          prepared=sw.prepare(weekly, sched), rankings=None, rankings_raw=None, crosswalk=None,
                          ledger=_ledger([_ev(1, "pub", "2026-09-09T10:00:00Z")]), git=git, main_sha="pub",
                          bakeoff=BAKEOFF, inputs=la.input_hashes(weekly, sched, None, None, bakeoff_path=la.BAKEOFF_PATH))


def _ours(ids, p50=5.0):
    return [(i, i[3:5], i[:3], p50 - 3, p50, p50 + 3) for i in ids]


def test_complete_week_with_zero_projection_matches_is_no_scorable_points():
    art = la.evaluate(_ctx(_publication_git(_ours(["ZZZWR9"]))))
    assert art["weeks_scored"] == [] and art["points"] == {}
    assert art["weeks_skipped"] == [{"week": 1, "reason": "no_scorable_points"}]
    assert art["weeks"]["1"]["unprojected"]["count"] == 20 and art["weeks"]["1"]["unprojected"]["share"] == 1.0
    json.dumps(art, allow_nan=False)


def test_scored_week_through_full_path_and_provenance():
    ids = [f"{t}{p}{i}" for t in TEAMS for p in POS for i in range(5)]
    art = la.evaluate(_ctx(_publication_git(_ours(ids[:-1]), dirty=True)))
    assert art["weeks_scored"] == [1] and art["points"]["overall"]["n"] == 19
    assert art["weeks"]["1"]["unprojected"]["count"] == 1
    assert art["weeks"]["1"]["publication"]["commit"] == "pub" and art["weeks"]["1"]["cutoff"] == "2026-09-10T00:00:00Z"
    assert set(art["inputs"]["actuals_by_season"]) == {"2025", "2026"}
    assert art["inputs"]["bakeoff"]["sha256"] == hashlib.sha256(la.BAKEOFF_PATH.read_bytes()).hexdigest()
    assert art["evaluator_version"]["id"] == "live-accuracy-v1+tree0+dirty"
    assert art["reference_context"]["transformer_mae_2023_25"] == pytest.approx(4.0)
    assert art["ranking"]["primary"] == {"cells": 0} and art["weeks"]["1"]["primary"]["reason"] == "no_archive"
    json.dumps(art, allow_nan=False)


def test_naive_uses_strictly_prior_games_and_prior_season_fallback():
    weekly, sched = _raw_world()
    prep = sw.prepare(weekly, sched)
    wk1 = sw.week_actuals(prep, 2026, 1).valid
    nv = la.naive_points(prep.features, wk1, 2026)
    row = wk1["player_id"] == "AAAWR0"
    # lag4 of AAAWR0 before 2026 week 1 = its 2025 weeks 1-2: receptions 1, 2 -> 1.5; yards 10, 10 -> 10
    assert float(nv[row].iloc[0]) == pytest.approx(1.5 + 0.1 * 10)
    with pytest.raises(ValueError, match="no position mean"):
        la.naive_points(prep.features[prep.features["position"] == "RB"], wk1, 2026)


def test_missing_team_rows_make_week_incomplete():
    art = la.evaluate(_ctx(_publication_git(_ours(["AAAWR0"])), raw=_raw_world(missing_team_week=(2026, 1, "BBB"))))
    assert art["weeks_skipped"] == [{"week": 1, "reason": "incomplete_week"}]


def test_neutral_only_invalid_player_skips_week_through_evaluate():
    # astra S71-I1 through the evaluator: a same-batch legacy + neutral commit. The neutral file carries the 19
    # legacy players plus one neutral-only player whose zero-weight p50.carries is NaN: 1/20 = 5% > 1%, so the
    # week is validation_failed with the neutral table's counts -- never scored on the surviving legacy table.
    ids = [f"{t}{p}{i}" for t in TEAMS for p in POS for i in range(5)][:19]
    g = _publication_git(_ours(ids))
    neu = _neutral(players=tuple(ids) + ("extra_bad",))
    neu["week"] = 1
    bad = json.loads(json.dumps(neu["players"][-1]["stat_quantiles"]))
    bad["p50"]["carries"] = float("nan")
    neu["players"][-1]["stat_quantiles"] = bad
    g.c["pub"]["files"][NEU] = json.dumps(neu).encode()
    g.c["pub"]["changed"].add(NEU)
    art = la.evaluate(_ctx(g))
    assert art["weeks_scored"] == [] and art["weeks_skipped"] == [{"week": 1, "reason": "validation_failed"}]
    assert art["weeks"]["1"]["values"]["failed_table"] == "neutral"
    proj = art["weeks"]["1"]["validation"]["projections"]
    assert proj["failed"] is True and proj["n_keys"] == 20
    json.dumps(art, allow_nan=False)


IDS = [f"{t}{p}{i}" for t in TEAMS for p in POS for i in range(5)]


def test_live_secondary_needs_the_prior_week_schedule():
    # astra S7-I3 on the live secondary path: 2026 week 1's only game is listed on 09-10 and on 09-11 (conflicting),
    # so week 1 fails; week 2 (09-17) passes and its points are scored. A 09-11 scrape is not compared against
    # week 2 through a manufactured K_2 - 7 days window: the secondary is skipped with schedule_dependency_failed.
    weekly, sched = _raw_world()
    wk1 = sched[(sched["season"] == 2026) & (sched["week"] == 1)]
    sched = pd.concat([sched, wk1.assign(gameday="2026-09-11")], ignore_index=True)
    payload = _legacy(gen="g2", players=_ours(IDS), week=2)
    g = FakeGit({"h0": _c([], changed={"README.md"}, time="2026-07-12T00:00:00Z"),
                 "pub2": _c(["h0"], la.BOT, {LEG}, {LEG: json.dumps(payload).encode()}, "2026-09-15T09:00:00Z")})
    ranks = pd.DataFrame([{"fp_id": f"fp{i}", "player": i, "pos": i[3:5], "team": i[:3], "ecr": float(k + 1),
                           "sd": 1.0, "mergename": i.lower(), "scrape_date": pd.Timestamp("2026-09-11")}
                          for k, i in enumerate(IDS)])
    cw = pd.DataFrame({"gsis_id": IDS, "fantasypros_id": [f"fp{i}" for i in IDS],
                       "merge_name": [i.lower() for i in IDS], "position": [i[3:5] for i in IDS]})
    prep = sw.prepare(weekly, sched)
    assert sorted(prep.schedule.dates(2026)) == [2]
    ctx = la.LiveContext(season=2026, weeks=[1, 2], as_of=pd.Timestamp("2026-09-25"), prepared=prep,
                         rankings=ranks, rankings_raw=None, crosswalk=cw,
                         ledger=_ledger([_ev(1, "pub2", "2026-09-15T10:00:00Z")]), git=g, main_sha="pub2",
                         bakeoff=BAKEOFF, inputs=la.input_hashes(weekly, sched, cw, None, bakeoff_path=la.BAKEOFF_PATH))
    art = la.evaluate(ctx)
    assert art["weeks_skipped"] == [{"week": 1, "reason": "validation_failed", "detail": "schedule_dependency_failed"}]
    assert art["weeks"]["1"]["validation"]["schedule"]["failed"] is True
    assert art["weeks_scored"] == [2]
    sec = art["weeks"]["2"]["secondary"]
    assert sec["status"] == "skipped" and sec["reason"] == "validation_failed"
    assert sec["detail"] == "schedule_dependency_failed" and sec["cells"] == []
    assert art["ranking"]["secondary"] == {"cells": 0}
    json.dumps(art, allow_nan=False)


def _archive_git(archived_ids):
    g = _publication_git(_ours(IDS))
    pts = {i: float(k) for k, i in enumerate(IDS)}
    g.c["pub"]["files"][LEG] = json.dumps(_legacy(gen="g1", week=1, players=[
        (i, i[3:5], i[:3], pts[i] - 3, pts[i], pts[i] + 3) for i in IDS])).encode()
    players = [{"player_id": i, "ecr": float(k + 1), "position": i[3:5], "team": i[:3]}
               for k, i in enumerate(archived_ids)]
    enc = json.dumps({"season": 2026, "week": 1, "snapshot_at": "2026-09-08", "players": players},
                     sort_keys=True, indent=2, allow_nan=False)
    name = f"2026-w01-2026-09-08-{hashlib.sha256(enc.encode()).hexdigest()[:16]}.json"
    g.c["pub"]["files"][f"{la.ARCHIVE_DIR}/{name}"] = enc.encode()
    g.c["pub"]["changed"].add(f"{la.ARCHIVE_DIR}/{name}")
    return g, name, enc


def test_ranking_pool_is_three_way_intersection_and_week_without_rb_coverage():
    wr_only = [i for i in IDS if i[3:5] == "WR"] + ["ZZZWR7"]           # archive lists no RB, plus a non-player
    g, _, _ = _archive_git(wr_only)
    g.c["pub"]["files"][LEG] = json.dumps(_legacy(gen="g1", week=1, players=[
        (i, i[3:5], i[:3], k - 3.0, float(k), k + 3.0) for k, i in enumerate(IDS[:-1])])).encode()
    art = la.evaluate(_ctx(g))
    prim = art["weeks"]["1"]["primary"]
    assert prim["pool"] == 9 and prim["pool_by_position"] == {"WR": 9}   # played ∩ projected ∩ archived
    assert [c["position"] for c in prim["cells"]] == ["WR"]


def test_archive_ranking_values_retained_and_rendered():
    g, name, enc = _archive_git(IDS)
    art = la.evaluate(_ctx(g))
    cells = art["weeks"]["1"]["primary"]["cells"]
    assert {c["position"] for c in cells} == {"RB", "WR"} and all(set(c) == {"position", "n", "sp_ours", "sp_con",
                                                                             "delta"} for c in cells)
    assert art["inputs"]["archive_blobs"] == {name: hashlib.sha256(enc.encode()).hexdigest()}
    art["run"] = {"provisional_weeks": [1]}
    md = la.render_markdown(art)
    row = next(line for line in md.splitlines() if line.startswith("| 1 |"))
    assert row.count("—") == 1 and " / " in row                    # archive column filled, nflverse column "—"


def test_render_markdown_has_provisional_line_and_skips():
    art = {"season": 2026, "weeks_scored": [1], "weeks_skipped": [{"week": 2, "reason": "incomplete_week"}],
           "points": {"overall": {"n": 3, "mae": 4.1, "naive_mae": 4.5, "coverage_p10_p90": 0.8,
                                  "below_p10": 0.1, "above_p90": 0.1},
                      "by_week": {"1": {"n": 3, "mae": 4.1, "naive_mae": 4.5, "coverage_p10_p90": 0.8,
                                        "below_p10": 0.1, "above_p90": 0.1, "last_game": "2026-09-14"}}},
           "weeks": {"1": {}}, "caveats": ["c1"], "run": {"provisional_weeks": [1]}}
    md = la.render_markdown(art)
    assert "Provisional: weeks 1" in md and "| 1 |" in md and "incomplete_week" in md


def test_output_path_follows_current_season():
    from ffmodel.data.pull import current_nfl_season

    assert la.output_path() == la.Path(f"models/diagnostics/live_{current_nfl_season()}_weekly.json")
    assert la.output_path(2027).name == "live_2027_weekly.json"


def test_serialisation_is_deterministic_and_rejects_nan():
    art = la.evaluate(_ctx(_publication_git(_ours(["ZZZWR9"]))))
    art["run"] = {"run_at": "2026-09-20T00:00:00Z", "as_of_date": "2026-09-20", "main_sha": "pub",
                  "provisional_weeks": []}
    again = la.evaluate(_ctx(_publication_git(_ours(["ZZZWR9"]))))
    again["run"] = dict(art["run"])
    assert la.serialise(art) == la.serialise(again)
    with pytest.raises(ValueError):
        la.serialise({"x": float("nan")})
