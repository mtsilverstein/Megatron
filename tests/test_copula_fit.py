from statistics import NormalDist

import numpy as np
import pytest

from ffmodel.eval import copula_fit as C

N = NormalDist()
Z90 = C.Z90


def draw(q, u):
    p10, p50, p90 = q
    z = N.inv_cdf(min(max(u, 1e-12), 1 - 1e-12))
    s = (p50 - p10) / Z90 if z < 0 else (p90 - p50) / Z90
    return max(p50 + z * s, min(0.0, 2 * p10))


def synth(rho, seed=1, players=300, seasons=3, weeks=12):
    rng = np.random.default_rng(seed)
    out = []
    for pl in range(players):
        pos = C.POSITIONS[pl % 4]
        for s in range(seasons):
            a = rng.standard_normal()
            rows = []
            for w in range(weeks):
                p50 = rng.uniform(8, 20)
                q = (p50 - rng.uniform(4, 6), p50, p50 + rng.uniform(5, 9))
                z = np.sqrt(rho) * a + np.sqrt(1 - rho) * rng.standard_normal()
                rows.append((w + 1, *q, draw(q, N.cdf(z))))
            out.append({"player": f"p{pl}", "season": 2023 + s, "origin": 5, "position": pos, "rows": rows})
    return out


@pytest.mark.parametrize("rho", [0.0, 0.15, 0.3])
def test_recovers_rho(rho):
    res = C.fit(synth(rho), n_boot=50)
    assert abs(res["pooled_raw"] - rho) < 0.04
    for p in C.POSITIONS:
        assert abs(res["table"][p] - rho) < 0.06


def test_below_floor_is_violation():
    assert C.pit((10, 15, 20), -30.0, np.random.default_rng(0)) is None
    tr = [{"player": "a", "season": 2023, "origin": 5, "position": "WR",
           "rows": [(w, 10, 15, 20, -30.0 if w == 1 else 15.0) for w in range(1, 7)]}]
    assert C.fit(tr, n_boot=5)["support_violations"]["WR"] == 1


def test_atom_bounds_and_determinism():
    q = (4.0, 10.0, 16.0)
    hi = N.cdf((0.0 - 10.0) / ((10.0 - 4.0) / Z90))
    a = C.pit(q, 0.0, np.random.default_rng(7))
    b = C.pit(q, 0.0, np.random.default_rng(7))
    assert 0 < a <= hi and a == b


def test_degenerate_quantiles():
    q = (5.0, 5.0, 5.0)
    u = C.pit(q, 5.0, np.random.default_rng(0))
    assert 0 <= u <= 1 and np.isfinite(N.inv_cdf(min(max(u, 1e-4), 1 - 1e-4)))
    assert C.pit(q, 6.0, np.random.default_rng(0)) is None
    assert C.pit(q, 4.0, np.random.default_rng(0)) is None


def test_short_trajectories_excluded():
    tr = synth(0.2, players=8, seasons=1, weeks=12)
    tr.append({"player": "short", "season": 2023, "origin": 5, "position": "QB",
               "rows": tr[0]["rows"][:3]})
    res = C.fit(tr, n_boot=5)
    assert sum(res["n_trajectories"].values()) == 8


def test_negative_clamps_and_reports():
    rng = np.random.default_rng(3)
    tr = []
    for i in range(300):
        rows = []
        for w in range(1, 9):
            q = (6.0, 12.0, 18.0)
            z = (1 if w % 2 else -1) * (1 if i % 2 else -1) + 0.1 * rng.standard_normal()
            rows.append((w, *q, draw(q, N.cdf(z))))
        tr.append({"player": f"p{i}", "season": 2023, "origin": 5, "position": "RB", "rows": rows})
    res = C.fit(tr, n_boot=5)
    assert res["raw"]["RB"] < 0 and res["table"]["RB"] == 0.0 and res["clamped_negative"]["RB"]


def test_byes_and_missing_actuals_skipped():
    payload = {"season": 2023, "origin": 5, "players": {"a": {"position": "QB", "team": "X", "weeks": {
        "5": {"status": "bye"}, "6": {"status": "play", "p10": 1, "p50": 5, "p90": 9},
        "7": {"status": "play", "p10": 1, "p50": 5, "p90": 9}}}}}
    t = C.build_trajectories(payload, {"a": {6: 4.0}})
    assert [r[0] for r in t[0]["rows"]] == [6]
