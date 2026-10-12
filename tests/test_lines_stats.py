"""Statistics, bootstrap, ranking status and decision for the lines screen
(spec 2026-10-11 §4-7, §11). Synthetic paired frames only."""
import numpy as np
import pandas as pd
import pytest

import ffmodel.eval.lines_stats as ls
from ffmodel.eval.lines_stats import (
    ScreenInvalid,
    consequences,
    crossed_bootstrap,
    decide,
    draw_counts,
    evaluate,
    guardrail,
    loss_differences,
    make_design,
    percentile_interval,
    point_effects,
    pred_col,
    ranking_status,
    relevant_membership,
    row_weights,
    season_equal_mean,
)

SEEDS = (0, 1, 2)
SEASONS = (2023, 2024, 2025)


def make_paired(rows_per_season=None, weeks=4, players_per_week=12, seed=0,
                gain=0.3, base=10.0) -> pd.DataFrame:
    """A paired frame where B is closer to actual than A by about `gain` on
    average. Every (season, week) has `players_per_week` WRs."""
    rng = np.random.default_rng(seed)
    rows = []
    for season in SEASONS:
        for week in range(1, weeks + 1):
            for p in range(players_per_week):
                rows.append({"player_id": f"p{p:03d}", "season": season, "week": week,
                             "position": "WR"})
    frame = pd.DataFrame(rows)
    n = len(frame)
    frame["actual"] = base + rng.normal(0, 5, n)
    for s in SEEDS:
        noise = rng.normal(0, 3, n)
        frame[pred_col("A", s)] = frame["actual"] + noise + 2.0
        frame[pred_col("B", s)] = frame["actual"] + noise + 2.0 - gain
    return frame


# --- §5.1 point effects --------------------------------------------------------

def test_seasons_weighted_equally_despite_unequal_sizes():
    # 2023 has 3 rows with d=1, 2024 one row with d=0, 2025 one row with d=0.
    seasons = np.array([2023, 2023, 2023, 2024, 2025])
    values = np.array([1.0, 1.0, 1.0, 0.0, 0.0])
    G, G_S = season_equal_mean(values, seasons, SEASONS)
    assert G_S == {2023: 1.0, 2024: 0.0, 2025: 0.0}
    assert G == pytest.approx(1 / 3)                 # pooled row mean would be 0.6


def test_seed_averaging_is_on_losses_not_on_predictions():
    paired = pd.DataFrame({"player_id": ["a"], "season": [2023], "week": [1],
                           "position": ["WR"], "actual": [10.0]})
    # A is exact on average but wrong per seed; B is off by 1 on every seed.
    for s, a in zip(SEEDS, (6.0, 14.0, 10.0)):
        paired[pred_col("A", s)] = a
        paired[pred_col("B", s)] = 11.0
    d = loss_differences(paired, SEEDS)
    assert list(d.loc[0, ["d_0", "d_1", "d_2"]]) == [3.0, 3.0, -1.0]
    assert d.loc[0, "d"] == pytest.approx(5 / 3)
    loss_of_avg = abs(10.0 - 10.0) - abs(10.0 - 11.0)  # = -1: the forbidden estimand
    assert d.loc[0, "d"] != pytest.approx(loss_of_avg)


def test_point_effects_per_seed_uses_same_season_weighting():
    paired = make_paired()
    effects = point_effects(paired, SEEDS, SEASONS)
    d = loss_differences(paired, SEEDS)
    for s in SEEDS:
        expected = np.mean([d.loc[paired["season"] == y, f"d_{s}"].mean() for y in SEASONS])
        assert effects["G_seed"][s] == pytest.approx(expected)
    assert effects["G"] == pytest.approx(np.mean(list(effects["G_S"].values())))


# --- §5.3 relevant cohort ---------------------------------------------------------

def test_relevant_membership_uses_arm_a_only_and_threshold_is_inclusive():
    paired = make_paired()
    for s in SEEDS:
        paired.loc[0, pred_col("A", s)] = 8.0
        paired.loc[1, pred_col("A", s)] = 7.999
    before = relevant_membership(paired, SEEDS)
    assert before[0] and not before[1]
    changed = paired.copy()
    for s in SEEDS:
        changed[pred_col("B", s)] = changed[pred_col("B", s)] + 100.0
    np.testing.assert_array_equal(relevant_membership(changed, SEEDS), before)


def test_empty_relevant_season_is_invalid_before_any_bootstrap(monkeypatch):
    paired = make_paired()
    in_2024 = paired["season"] == 2024
    for s in SEEDS:
        # nothing relevant in 2024 (scaled far below 8 PPR, order kept)
        paired.loc[in_2024, pred_col("A", s)] = paired.loc[in_2024, pred_col("A", s)] / 100

    def boom(*args, **kwargs):
        raise AssertionError("bootstrap must not run")

    monkeypatch.setattr(ls, "crossed_bootstrap", boom)
    result = evaluate(paired, SEEDS, SEASONS, n_accept=50, max_attempts=500)
    assert result["decision"]["disposition"] == "invalid"
    assert "no relevant-cohort rows in season(s) [2024]" in result["decision"]["invalid_reasons"][0]
    assert result["ranking"]["status"] in {"ranking_ok", "ranking_veto"}   # still reported
    assert result["consequences"]["buys_forward_shadow_test"] is False


# --- §5.2 crossed bootstrap ---------------------------------------------------------

def test_bootstrap_is_deterministic_and_uses_the_registered_generator():
    paired = make_paired()
    rel = relevant_membership(paired, SEEDS)
    one = crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=200, max_attempts=2000)
    two = crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=200, max_attempts=2000)
    np.testing.assert_array_equal(one["G"], two["G"])
    np.testing.assert_array_equal(one["G_rel"], two["G_rel"])
    # First replicate re-derived by hand: PCG64(20261007), players first,
    # then each season's blocks in ascending season order.
    design = make_design(paired, SEASONS)
    rng = np.random.Generator(np.random.PCG64(20261007))
    pc = np.bincount(rng.integers(0, design.n_players, size=design.n_players),
                     minlength=design.n_players)
    bcs = [np.bincount(rng.integers(0, k, size=k), minlength=k) for k in design.n_blocks]
    w = row_weights(design, pc, bcs).astype(float)
    d = loss_differences(paired, SEEDS)["d"].to_numpy()
    seasons = paired["season"].to_numpy()
    manual = np.mean([(w[seasons == s] * d[seasons == s]).sum() / w[seasons == s].sum()
                      for s in SEASONS])
    assert one["rejected"] == 0
    assert one["G"][0] == pytest.approx(manual, abs=1e-12)
    other = crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=200, max_attempts=2000,
                              rng_seed=1)
    assert not np.array_equal(one["G"], other["G"])


def test_week_pairs_move_together():
    # One player -> player count is always 1, so weights are block counts.
    rows = [{"player_id": "solo", "season": s, "week": w, "position": "WR"}
            for s in SEASONS for w in range(1, 7)]
    design = make_design(pd.DataFrame(rows), SEASONS)
    assert design.n_blocks == (3, 3, 3)
    rng = np.random.Generator(np.random.PCG64(20261007))
    weeks = pd.DataFrame(rows)["week"].to_numpy()
    seasons = pd.DataFrame(rows)["season"].to_numpy()
    differed = False
    for _ in range(50):
        w = row_weights(design, *draw_counts(rng, design))
        for s in SEASONS:
            ws = {wk: w[(seasons == s) & (weeks == wk)][0] for wk in range(1, 7)}
            assert ws[1] == ws[2] and ws[3] == ws[4] and ws[5] == ws[6]
            differed |= ws[1] != ws[3]
    assert differed


def test_player_multiplicity_carries_across_seasons():
    # One block per season (weeks 1-2) -> block count is always 1.
    rows = [{"player_id": p, "season": s, "week": 1, "position": "WR"}
            for s in SEASONS for p in ("a", "b", "c", "d")]
    frame = pd.DataFrame(rows)
    design = make_design(frame, SEASONS)
    rng = np.random.Generator(np.random.PCG64(20261007))
    varied = set()
    for _ in range(50):
        w = row_weights(design, *draw_counts(rng, design))
        for p in ("a", "b", "c", "d"):
            per_season = w[(frame["player_id"] == p).to_numpy()]
            assert len(set(per_season)) == 1           # same multiplicity every season
            varied.add(int(per_season[0]))
    assert len(varied) > 1


def test_empty_season_replicates_are_rejected_and_counted():
    # 2025 holds a single player out of 40 -> it is often drawn zero times.
    paired = make_paired(players_per_week=40)
    keep = (paired["season"] != 2025) | (paired["player_id"] == "p000")
    paired = paired[keep].reset_index(drop=True)
    for s in SEEDS:
        paired[pred_col("A", s)] = 20.0                 # everyone relevant
    rel = relevant_membership(paired, SEEDS)
    boot = crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=100, max_attempts=10_000)
    assert boot["accepted"] == 100
    assert boot["rejected"] > 0
    assert boot["attempts"] == boot["accepted"] + boot["rejected"]
    assert np.isfinite(boot["G"]).all()


def test_relevant_cohort_zero_weight_rejects_jointly():
    paired = make_paired(players_per_week=40)
    for s in SEEDS:
        paired[pred_col("A", s)] = 20.0
        # In 2025 only p000 is relevant.
        paired.loc[(paired["season"] == 2025) & (paired["player_id"] != "p000"),
                   pred_col("A", s)] = 1.0
    rel = relevant_membership(paired, SEEDS)
    boot = crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=100, max_attempts=10_000)
    assert boot["rejected"] > 0 and np.isfinite(boot["G_rel"]).all()


def test_attempt_limit_raises_screen_invalid():
    paired = make_paired(players_per_week=200, weeks=2)
    keep = (paired["season"] != 2025) | (paired["player_id"] == "p000")
    paired = paired[keep].reset_index(drop=True)
    rel = np.ones(len(paired), dtype=bool)
    with pytest.raises(ScreenInvalid, match="accepted within 100 attempts"):
        crossed_bootstrap(paired, SEEDS, rel, SEASONS, n_accept=100, max_attempts=100)


def test_percentile_interval_is_central_95_linear():
    samples = np.arange(1, 101, dtype=float)
    lo, hi = percentile_interval(samples)
    assert (lo, hi) == (np.percentile(samples, 2.5, method="linear"),
                        np.percentile(samples, 97.5, method="linear"))


# --- §5.4 ranking -------------------------------------------------------------------

def ranking_frame(n_players=6, weeks=2, b_order="same", seasons=SEASONS,
                  position="WR") -> pd.DataFrame:
    rows = []
    for season in seasons:
        for week in range(1, weeks + 1):
            for p in range(n_players):
                actual = float(p * 3 + week)
                a = float(p)                                      # A ranks perfectly
                b = float(p) if b_order == "same" else float(n_players - p)
                row = {"player_id": f"p{p}", "season": season, "week": week,
                       "position": position, "actual": actual}
                for s in SEEDS:
                    row[pred_col("A", s)] = a
                    row[pred_col("B", s)] = b
                rows.append(row)
    return pd.DataFrame(rows)


def test_ranking_identical_orders_give_zero_delta_and_ok():
    out = ranking_status(ranking_frame(), SEEDS, SEASONS)
    assert out["status"] == "ranking_ok" and out["R"] == pytest.approx(0.0)
    assert out["eligible_cells"] == 6


def test_ranking_reversed_b_is_a_veto_paired_per_cell():
    out = ranking_status(ranking_frame(b_order="reversed"), SEEDS, SEASONS)
    assert out["status"] == "ranking_veto"
    assert out["R"] == pytest.approx(-2.0)               # rho_B=-1 minus rho_A=+1


@pytest.mark.parametrize("rho_b,status", [(-0.005, "ranking_ok"), (-0.0050001, "ranking_veto")])
def test_ranking_veto_threshold_boundary(monkeypatch, rho_b, status):
    # Stub the correlation so R is exactly rho_b: arm A's predictions are all
    # non-negative (rho 0), arm B's all negative (rho = rho_b).
    frame = ranking_frame()
    for s in SEEDS:
        frame[pred_col("B", s)] = -frame[pred_col("B", s)] - 1.0
    monkeypatch.setattr(ls, "_spearman", lambda x, y: rho_b if x.max() < 0 else 0.0)
    out = ranking_status(frame, SEEDS, SEASONS)
    assert out["R"] == rho_b and out["status"] == status


def test_ranking_cells_need_five_distinct_players():
    out = ranking_status(ranking_frame(n_players=4), SEEDS, SEASONS)
    assert out["excluded_cells"]["too_few_players"] == 6
    assert out["status"] == "ranking_not_evaluable" and out["R"] is None


def test_constant_actual_cell_is_excluded_symmetrically_and_counted():
    frame = ranking_frame()
    frame.loc[(frame["season"] == 2023) & (frame["week"] == 1), "actual"] = 5.0
    out = ranking_status(frame, SEEDS, SEASONS)
    assert out["excluded_cells"]["constant_actual"] == 1
    assert out["eligible_cells"] == 5 and out["status"] == "ranking_ok"


def test_finite_constant_prediction_is_not_evaluable_and_point_gate_unchanged():
    wr = make_paired(seed=0)
    rb = make_paired(seed=1).assign(position="RB")
    rb["player_id"] = "rb_" + rb["player_id"]
    paired = pd.concat([wr, rb], ignore_index=True)
    cell = (paired["season"] == 2023) & (paired["week"] == 1) & (paired["position"] == "WR")
    paired.loc[cell, pred_col("B", 1)] = 12.0            # finite but constant, one WR cell
    out = evaluate(paired, SEEDS, SEASONS, n_accept=200, max_attempts=2000)
    ranking = out["ranking"]
    assert ranking["status"] == "ranking_not_evaluable"
    assert ranking["R"] is None
    assert ranking["constant_prediction_cells"] == [
        {"season": 2023, "week": 1, "position": "WR", "arms": ["B/seed1"]}]
    # Only the affected season and position are nulled ...
    assert ranking["R_by_season"][2023] is None
    assert ranking["by_position"]["WR"] == {
        "delta": None, "reason": "constant prediction in an eligible WR cell in season 2023"}
    # ... the other seasons' R and the unaffected position's diagnostic are kept.
    for season in (2024, 2025):
        assert ranking["R_by_season"][season] is not None
        assert np.isfinite(ranking["R_by_season"][season])
    assert ranking["by_position"]["RB"]["reason"] is None
    assert ranking["by_position"]["RB"]["delta"] is not None
    assert np.isfinite(ranking["by_position"]["RB"]["delta"])
    assert ranking["eligible_cells"] == 24                  # 3 seasons x 4 weeks x 2 positions
    assert out["decision"]["disposition"] in {"pass", "fail"}       # never invalid for ranking
    assert out["consequences"]["ranking_recommendation_forbidden"] is True


def test_season_without_eligible_ranking_cell_is_not_evaluable():
    frame = ranking_frame()
    small = ranking_frame(n_players=3, seasons=(2025,))
    frame = pd.concat([frame[frame["season"] != 2025], small], ignore_index=True)
    out = ranking_status(frame, SEEDS, SEASONS)
    assert out["status"] == "ranking_not_evaluable"
    assert "season 2025 has no eligible ranking cell" in out["reasons"]
    assert out["R_by_season"][2025] is None and out["R"] is None


def test_missing_position_season_nulls_only_that_diagnostic():
    wr = ranking_frame()
    te = ranking_frame(position="TE", seasons=(2023, 2024))       # no TE cells in 2025
    out = ranking_status(pd.concat([wr, te], ignore_index=True), SEEDS, SEASONS)
    assert out["status"] == "ranking_ok"
    assert out["by_position"]["TE"] == {"delta": None, "reason": "no eligible TE cell in season 2025"}
    assert out["by_position"]["WR"]["delta"] == pytest.approx(0.0)
    assert out["by_position"]["QB"]["delta"] is None


# --- §6 / §7 decision -------------------------------------------------------------

def passing_point(**over) -> dict:
    """An otherwise passing point dict carrying the COMPLETE required families:
    one G_S / G_S_interval entry per registered season and one G_seed /
    G_seed_interval entry per registered seed."""
    point = {"G": 0.1, "G_interval": [0.02, 0.18],
             "G_S": {2023: 0.1, 2024: 0.1, 2025: 0.1},
             "G_S_interval": {2023: [0.01, 0.2], 2024: [0.01, 0.2], 2025: [0.01, 0.2]},
             "G_seed": {0: 0.1, 1: 0.1, 2: 0.1},
             "G_seed_interval": {0: [0.01, 0.2], 1: [0.01, 0.2], 2: [0.01, 0.2]}}
    point.update(over)
    return point


MISSING = object()
NAN, INF = float("nan"), float("inf")


def with_entry(family: str, key: int, value) -> dict:
    """passing_point() with one entry of `family` replaced (value=MISSING drops it)."""
    entries = dict(passing_point()[family])
    if value is MISSING:
        del entries[key]
    else:
        entries[key] = value
    return passing_point(**{family: entries})


def passing_guard(lower=0.0) -> dict:
    return guardrail(0.1, [lower, 0.2])


def test_all_conditions_hold_is_a_pass():
    out = decide(passing_point(), passing_guard(), [])
    assert out["disposition"] == "pass" and out["failed_conditions"] == []


@pytest.mark.parametrize("point,guard_lower,failed", [
    (passing_point(G=0.0499999), 0.0, ["materiality"]),
    (passing_point(G_interval=[0.0, 0.18]), 0.0, ["interval_lower_above_0"]),
    (passing_point(G_S={2023: 0.1, 2024: -0.01, 2025: 0.0}), 0.0, ["two_seasons_positive"]),
    (passing_point(G_S={2023: 0.2, 2024: 0.2, 2025: -0.0500001}), 0.0, ["no_season_below_floor"]),
    (passing_point(G_seed={0: 0.1, 1: 0.0, 2: 0.1}), 0.0, ["all_seeds_positive"]),
    (passing_point(), -0.1000001, ["relevant_guardrail"]),
])
def test_each_condition_failing_in_turn(point, guard_lower, failed):
    out = decide(point, passing_guard(guard_lower), [])
    assert out["disposition"] == "fail"
    assert out["failed_conditions"] == failed
    assert out["failure_label"] == "inconclusive"


def test_exact_boundaries():
    assert decide(passing_point(G=0.05), passing_guard(), [])["disposition"] == "pass"
    assert decide(passing_point(G_interval=[0.0, 0.2]), passing_guard(), [])["disposition"] == "fail"
    at_floor = passing_point(G_S={2023: 0.2, 2024: 0.2, 2025: -0.05})
    assert decide(at_floor, passing_guard(), [])["disposition"] == "pass"
    guard = passing_guard(-0.10)
    assert guard["H_upper"] == 0.10
    assert decide(passing_point(), guard, [])["disposition"] == "pass"


def test_below_materiality_label():
    out = decide(passing_point(G=0.01, G_interval=[-0.02, 0.0499]), passing_guard(), [])
    assert out["disposition"] == "fail" and out["failure_label"] == "below_materiality"
    assert "materiality" in out["failed_conditions"]


def test_invalid_takes_precedence_over_any_label():
    out = decide(passing_point(), passing_guard(), ["unmatched player team-week"])
    assert out == {"disposition": "invalid", "failure_label": None, "conditions": None,
                   "failed_conditions": None, "invalid_reasons": ["unmatched player team-week"]}


@pytest.mark.parametrize("over", [{"G": float("nan")}, {"G_interval": [0.01, float("inf")]},
                                  {"G_S": {2023: 0.1, 2024: None, 2025: 0.1}},
                                  {"G_seed": {0: 0.1, 1: float("nan"), 2: 0.1}}])
def test_undefined_point_metric_is_invalid(over):
    out = decide(passing_point(**over), passing_guard(), [])
    assert out["disposition"] == "invalid"
    assert out["invalid_reasons"][0].startswith("undefined point metric")


def test_complete_families_are_required_by_the_passing_fixture():
    # The fixture itself passes; every case below changes exactly one entry.
    assert decide(passing_point(), passing_guard(), [])["disposition"] == "pass"


@pytest.mark.parametrize("family,key,value,named", [
    # season-interval family: an endpoint that is None / NaN / +inf / -inf
    ("G_S_interval", 2023, [NAN, 0.2], "G_S_interval[2023].lower"),   # astra's reproduction
    ("G_S_interval", 2024, [0.01, None], "G_S_interval[2024].upper"),
    ("G_S_interval", 2025, [0.01, INF], "G_S_interval[2025].upper"),
    ("G_S_interval", 2023, [-INF, 0.2], "G_S_interval[2023].lower"),
    # ... a null or missing entry
    ("G_S_interval", 2024, None, "G_S_interval[2024] (missing or malformed interval)"),
    ("G_S_interval", 2025, MISSING, "G_S_interval[2025] (missing or malformed interval)"),
    # seed-interval family: the same cases
    ("G_seed_interval", 0, [NAN, 0.2], "G_seed_interval[0].lower"),
    ("G_seed_interval", 1, [0.01, None], "G_seed_interval[1].upper"),
    ("G_seed_interval", 2, [0.01, INF], "G_seed_interval[2].upper"),
    ("G_seed_interval", 0, [-INF, 0.2], "G_seed_interval[0].lower"),
    ("G_seed_interval", 1, None, "G_seed_interval[1] (missing or malformed interval)"),
    ("G_seed_interval", 2, MISSING, "G_seed_interval[2] (missing or malformed interval)"),
    # point families: a missing entry is undefined, not silently skipped
    ("G_S", 2024, MISSING, "G_S[2024]"),
    ("G_seed", 1, MISSING, "G_seed[1]"),
])
def test_undefined_season_or_seed_interval_is_invalid_and_named(family, key, value, named):
    out = decide(with_entry(family, key, value), passing_guard(), [])
    assert out["disposition"] == "invalid"
    assert out["conditions"] is None and out["failure_label"] is None
    assert out["invalid_reasons"] == [f"undefined point metric {named}"]


@pytest.mark.parametrize("family", ["G_S_interval", "G_seed_interval"])
def test_absent_interval_family_names_every_registered_entry(family):
    point = passing_point()
    del point[family]
    out = decide(point, passing_guard(), [])
    keys = SEASONS if family == "G_S_interval" else SEEDS
    assert out["disposition"] == "invalid"
    assert out["invalid_reasons"] == [
        f"undefined point metric {family}[{k}] (missing or malformed interval)" for k in keys]


def test_registered_families_come_from_the_caller():
    # Two registered seasons/seeds: complete for those, so it passes;
    # registering a third season the dict lacks makes it invalid.
    point = passing_point(G_S={2024: 0.1, 2025: 0.1},
                          G_S_interval={2024: [0.01, 0.2], 2025: [0.01, 0.2]})
    assert decide(point, passing_guard(), [], season_order=(2024, 2025))["disposition"] == "pass"
    out = decide(point, passing_guard(), [], season_order=SEASONS)
    assert out["disposition"] == "invalid"
    assert "undefined point metric G_S[2023]" in out["invalid_reasons"]


def test_undefined_guardrail_metric_is_invalid():
    out = decide(passing_point(), guardrail(float("nan"), [-0.01, 0.2]), [])
    assert out["disposition"] == "invalid"


def test_non_finite_prediction_in_paired_frame_is_invalid():
    paired = make_paired()
    paired.loc[3, pred_col("A", 2)] = np.nan
    out = evaluate(paired, SEEDS, SEASONS, n_accept=50, max_attempts=500)
    assert out["decision"]["disposition"] == "invalid"
    assert out["ranking"] is None


@pytest.mark.parametrize("status,forbidden", [("ranking_ok", False), ("ranking_veto", True),
                                              ("ranking_not_evaluable", True)])
def test_ranking_status_is_independent_of_the_point_pass(status, forbidden):
    passed = decide(passing_point(), passing_guard(), [])
    out = consequences(passed, {"status": status})
    assert out["buys_forward_shadow_test"] is True               # point pass still buys it
    assert out["ranking_recommendation_forbidden"] is forbidden
    assert out["carry_into_forward_preregistration"] == {
        "ranking_status": status, "ranking_recommendation_forbidden": forbidden}
    assert out["site_change_authorized"] is False
    failed = decide(passing_point(G=0.0), passing_guard(), [])
    assert consequences(failed, {"status": status})["buys_forward_shadow_test"] is False


def test_evaluate_end_to_end_on_a_clear_gain():
    out = evaluate(make_paired(gain=0.3), SEEDS, SEASONS, n_accept=300, max_attempts=3000)
    assert out["decision"]["disposition"] == "pass"
    assert out["bootstrap"]["accepted"] == 300
    assert out["point"]["G_interval"][0] > 0
    assert set(out["point"]["G_S_interval"]) == set(SEASONS)
    assert set(out["point"]["G_seed_interval"]) == set(SEEDS)
    assert out["decision"]["invalid_reasons"] == []
    assert out["relevant"]["passed"] is True
    assert out["relevant"]["counts"]["rows_by_season"][2023] > 0


def test_evaluate_end_to_end_on_no_gain_fails():
    out = evaluate(make_paired(gain=0.0), SEEDS, SEASONS, n_accept=300, max_attempts=3000)
    assert out["decision"]["disposition"] == "fail"
    assert out["point"]["G"] == pytest.approx(0.0)
