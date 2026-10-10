"""Spec §6 statistics, directional checks and decision rules, driven from cell rows. Synthetic cells only."""
import pandas as pd

from ffmodel.eval import sameweek as sw

SEASONS = [2023, 2024, 2025]


def _cells(season_deltas, weeks=17, positions=("QB", "RB", "WR", "TE"), state="bye_consistent"):
    rows = []
    for season, d in season_deltas.items():
        for w in range(1, weeks + 1):
            for p in positions:
                dd = d(w, p) if callable(d) else d
                rows.append({"season": season, "week": w, "position": p, "sp_ours": 0.5 + dd, "sp_con": 0.5,
                             "gate_state": state})
    return pd.DataFrame(rows)


def _weeks(seasons, n=17):
    return {s: list(range(1, n + 1)) for s in seasons}


def test_ci_week_moves_whole_weeks():
    # two positions per week with opposite deltas: a week-clustered resample keeps each week's mean at 0
    c = _cells({2023: lambda w, p: 0.1 if p == "QB" else -0.1}, positions=("QB", "RB"))
    st = sw.delta_stats(c)
    assert st["n_clusters"] == 17 and abs(st["ci_week"][0]) < 1e-12 and abs(st["ci_week"][1]) < 1e-12


def test_leave_one_season_out_values():
    st = sw.delta_stats(_cells({2023: 0.03, 2024: 0.06, 2025: 0.09}))
    assert abs(st["loso"][2023] - 0.075) < 1e-12 and abs(st["loso"][2025] - 0.045) < 1e-12


def test_reachability_example_ahead_and_its_reflection_behind():
    up = _cells({2023: lambda w, p: 0.02 + 0.04 * (w % 2), 2024: 0.03, 2025: 0.05})
    assert sw.rule_1(up, _weeks(SEASONS))["value"] == "ahead"
    down = up.assign(sp_ours=1.0 - up["sp_ours"])
    assert sw.rule_1(down, _weeks(SEASONS))["value"] == "behind"


def test_interval_including_zero_is_not_a_tie():
    noisy = _cells({2023: lambda w, p: 0.08 if w % 2 else -0.12, 2024: lambda w, p: 0.05 if w % 2 else -0.09,
                    2025: lambda w, p: 0.04 if w % 2 else -0.10})
    r = sw.rule_1(noisy, _weeks(SEASONS))
    assert r["value"] == "not_established" and "interval_includes_zero" in r["reasons"]
    assert r["stats"]["ci_week"][0] < 0 < r["stats"]["ci_week"][1]


def test_dominant_season_blocked_by_leave_one_season_out():
    c = _cells({2023: 0.120, 2024: -0.010, 2025: 0.001})
    ok, codes = sw.directional_check(sw.delta_stats(c), sw.sensitivity_stats(c), +1)
    assert not ok and "leave_one_season_out_reversal" in codes


def test_season_inconsistent_and_sensitivity_codes():
    c = _cells({2023: 0.2, 2024: -0.01, 2025: -0.01})
    ok, codes = sw.directional_check(sw.delta_stats(c), sw.sensitivity_stats(c), +1)
    assert "season_inconsistent" in codes
    absent = _cells({2023: 0.03, 2024: 0.04, 2025: 0.05}, state="unverified")
    ok2, codes2 = sw.directional_check(sw.delta_stats(absent), sw.sensitivity_stats(absent), +1)
    assert not ok2 and codes2 == ["sensitivity_absent"]
    mixed = pd.concat([_cells({2023: 0.03, 2024: 0.04, 2025: 0.05}, state="unverified"),
                       _cells({2023: -0.02}, weeks=2, state="bye_consistent").assign(week=lambda f: f["week"] + 20)])
    assert "sensitivity_disagrees" in sw.directional_check(sw.delta_stats(mixed), sw.sensitivity_stats(mixed), +1)[1]
    zero = pd.concat([_cells({2023: 0.03, 2024: 0.04, 2025: 0.05}, state="unverified"),
                      _cells({2023: 0.0}, weeks=2, state="bye_consistent").assign(week=lambda f: f["week"] + 20)])
    assert "sensitivity_zero" in sw.directional_check(sw.delta_stats(zero), sw.sensitivity_stats(zero), +1)[1]


def test_touching_zero_and_opposite_side_codes():
    touching = _cells({2023: lambda w, p: 0.0 if w == 1 else 0.05, 2024: 0.05, 2025: 0.05}, weeks=1)
    st = sw.delta_stats(touching)                       # one zero week among three single-week seasons
    assert st["ci_week"][0] == 0.0
    ok, codes = sw.directional_check(st, sw.sensitivity_stats(touching), +1)
    assert codes[0] == "interval_includes_zero"
    below = _cells({2023: -0.05, 2024: -0.04, 2025: -0.06})
    ok, codes = sw.directional_check(sw.delta_stats(below), sw.sensitivity_stats(below), +1)
    assert "interval_opposite_side" in codes


def test_full_precision_lower_bound_passes_through_the_verdict_path():
    # every cell delta is +0.00003: rounded to 4 dp it would be 0.0000 and fail (a); in full precision it passes
    c = _cells({2023: 0.00003, 2024: 0.00003, 2025: 0.00003})
    r = sw.rule_1(c, _weeks(SEASONS))
    assert 0 < r["stats"]["ci_week"][0] < 0.0001
    assert r["value"] == "ahead" and r["reasons"] == []


def test_zero_estimate_and_loso_zero():
    flat = _cells({2023: 0.0, 2024: 0.0, 2025: 0.0})
    r = sw.rule_1(flat, _weeks(SEASONS))
    assert r["value"] == "not_established" and r["reasons"][0] == "zero_estimate"
    assert "leave_one_season_out_zero" in r["reasons"]


def test_sufficiency_per_season_and_rb():
    c = _cells({2023: 0.03, 2024: 0.04, 2025: 0.05}, weeks=8, positions=("QB", "WR", "TE"))
    assert sw.sufficient(c, _weeks(SEASONS, 16))                      # 8/16 weeks with a cell
    assert not sw.sufficient(c, _weeks(SEASONS, 16), "RB")            # RB-poor: Rule 1 yes, Rule 2 no
    assert sw.rule_1(c, _weeks(SEASONS, 18))["value"] == "insufficient"
    with_week1 = _cells({2023: 0.03}, weeks=1)
    assert sw.sufficient(with_week1, {2023: [1, 2]})                  # week 1 in the denominator and scored


def test_rule_2_needs_both_samples():
    good = _cells({2023: 0.03, 2024: 0.04, 2025: 0.05})
    rep_good = _cells({2020: 0.03, 2021: 0.04, 2022: 0.05})
    rep_bad = _cells({2020: 0.03, 2021: -0.04, 2022: -0.05})
    disc_w, rep_w = _weeks(SEASONS), _weeks([2020, 2021, 2022])
    assert sw.rule_2(good, disc_w, rep_good, rep_w)["value"] == "established"
    r = sw.rule_2(good, disc_w, rep_bad, rep_w)
    assert r["value"] == "not_established" and "season_inconsistent" in r["reasons_by_sample"]["replication"]
    r2 = sw.rule_2(rep_bad.assign(season=rep_bad["season"] + 3), disc_w, rep_good, rep_w)
    assert r2["value"] == "not_established" and r2["reasons_by_sample"]["replication"] == []


def test_rule_2_rb_below_zero_and_insufficient_samples():
    below = _cells({2023: -0.03, 2024: -0.04, 2025: -0.05})
    rep = _cells({2020: 0.03, 2021: 0.04, 2022: 0.05})
    r = sw.rule_2(below, _weeks(SEASONS), rep, _weeks([2020, 2021, 2022]))
    assert "interval_opposite_side" in r["reasons_by_sample"]["discovery"]
    no_rb = _cells({2020: 0.03, 2021: 0.04, 2022: 0.05}, positions=("QB",))
    r2 = sw.rule_2(below, _weeks(SEASONS), no_rb, _weeks([2020, 2021, 2022]))
    assert r2 == {"value": "insufficient", "reasons_by_sample": {"replication": ["insufficient"]}}
