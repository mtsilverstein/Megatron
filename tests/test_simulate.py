import numpy as np
import pandas as pd
import pytest

from ffmodel.model.simulate import _inverse_cdf, games_probs_from_counts, simulate_season


def _point_mass(k: int, n: int = 19) -> np.ndarray:
    """A games_probs vector that always samples exactly `k` games played."""
    vec = np.zeros(n)
    vec[k] = 1.0
    return vec


# --------------------------------------------------------------- _inverse_cdf

def test_inverse_cdf_knots_hand_derived():
    # (p10, p50, p90) = (10, 20, 40).
    # lo0 = p10 - (p50-p10) = 10 - 10 =  0   (value at u=0.00)
    # hi1 = p90 + (p90-p50) = 40 + 20 = 60   (value at u=1.00)
    # u=0.00 -> lo0                              =  0
    # u=0.05 -> midpoint of the [0.00,0.10] tail: lo0 + 0.5*(p10-lo0) =  5
    # u=0.10 -> p10 (knot)                       = 10
    # u=0.50 -> p50 (knot)                       = 20
    # u=0.90 -> p90 (knot)                       = 40
    # u=1.00 -> hi1                              = 60
    u = np.array([0.0, 0.05, 0.10, 0.50, 0.90, 1.00])
    values = _inverse_cdf(u, 10.0, 20.0, 40.0, clip=-5.0)
    assert values == pytest.approx([0.0, 5.0, 10.0, 20.0, 40.0, 60.0])


def test_inverse_cdf_clips_extreme_lower_tail():
    # (p10, p50, p90) = (-30, -20, -10).
    # lo0 = p10 - (p50-p10) = -30 - 10 = -40, well below clip=-5 -> floored.
    # At u=0.10 the raw value is exactly p10=-30, also below clip -> floored.
    # At u=0.50 the raw value is p50=-20, still below clip -> floored.
    u = np.array([0.0, 0.10, 0.50])
    values = _inverse_cdf(u, -30.0, -20.0, -10.0, clip=-5.0)
    assert values == pytest.approx([-5.0, -5.0, -5.0])


# ----------------------------------------------------------------- simulate_season

def test_simulate_season_clips_and_reports_clip_frac():
    # Deep-negative degenerate band, full availability (point mass at
    # n_weeks). hi1 = p90 + (p90-p50) = -10 + (-10 - -20) = 0, and the upper
    # tail is linear from (0.9, p90=-10) to (1.0, hi1=0): 100*u - 100 for
    # u in [0.9, 1.0]. That crosses clip=-5 at u=0.95 (100*0.95-100=-5), so
    # only u in [0.95, 1.0] (5% per week) escapes the floor -- everywhere
    # else (95% per week) the raw value is < clip(-5) and gets floored, so
    # clip_frac must be > 0.
    #   E[value] = integral_0^0.95(-5)du + integral_0.95^1.0(100u-100)du
    #            = -4.75 + [50u^2-100u]_0.95^1.0 = -4.75 + (-50 - -49.875)
    #            = -4.75 - 0.125 = -4.875 per week -> mean season sum
    #            = 3 * -4.875 = -14.625 (n_draws=2000 keeps MC noise small
    #            since 95% of mass sits exactly at -5).
    n_weeks = 3
    week_bands = np.array([[-30.0, -20.0, -10.0]] * n_weeks)
    games_probs = _point_mass(n_weeks)
    out = simulate_season(week_bands, games_probs, n_draws=2000,
                          rng=np.random.default_rng(1))
    assert out["clip_frac"] > 0.0
    # Absolute floor: every retained week clips at -5 at worst, so the
    # 3-week sum can never fall below 3 * -5 = -15.
    assert out["p10"] >= -15.0
    assert out["mean"] == pytest.approx(-14.625, abs=0.1)


def test_degenerate_band_full_availability_sums_exactly():
    # Degenerate band (c, c, c) means p10=p50=p90=c, so lo0 = c-(c-c) = c and
    # hi1 = c+(c-c) = c too -- the inverse-CDF is the constant c for every u.
    # Point mass at G=n_weeks caps every draw's games at n_weeks and retains
    # all of them (ranks 0..n_weeks-1 are all < n_weeks). So every single
    # draw's sum is exactly n_weeks * c, deterministically -- no MC noise.
    c, n_weeks = 15.0, 4
    week_bands = np.array([[c, c, c]] * n_weeks)
    games_probs = _point_mass(n_weeks)
    out = simulate_season(week_bands, games_probs, n_draws=500,
                          rng=np.random.default_rng(2))
    assert out["p10"] == pytest.approx(n_weeks * c)
    assert out["p50"] == pytest.approx(n_weeks * c)
    assert out["p90"] == pytest.approx(n_weeks * c)
    assert out["mean"] == pytest.approx(n_weeks * c)
    assert out["clip_frac"] == 0.0     # c=15 is nowhere near the default clip=-5


def test_availability_point_mass_sums_to_games_played():
    # Degenerate band value 1.0 (every week worth exactly 1.0 point) with a
    # point mass at G=k out of n_weeks=5 scheduled weeks: whichever k weeks
    # get retained, the sum is always k * 1.0 = k, deterministically --
    # this is the availability half of the simulation acting alone.
    n_weeks, k = 5, 2
    week_bands = np.array([[1.0, 1.0, 1.0]] * n_weeks)
    games_probs = _point_mass(k)
    out = simulate_season(week_bands, games_probs, n_draws=500,
                          rng=np.random.default_rng(3))
    assert out["p10"] == pytest.approx(float(k))
    assert out["p50"] == pytest.approx(float(k))
    assert out["p90"] == pytest.approx(float(k))
    assert out["mean"] == pytest.approx(float(k))


def test_median_of_sums_exceeds_sum_of_medians_for_right_skew():
    # Right-skewed weekly band: p90-p50 = 4*(p50-p10). p10=10, p50=20 ->
    # p90 = 20 + 4*10 = 60. Weekly mean (by segment-average integration over
    # u) is 30.5 >> median 20, i.e. a long, fat upper tail. Full availability
    # (point mass at n_weeks) so every week is always retained -- this test
    # isolates the median-of-sums-vs-sum-of-medians effect from availability.
    # For an iid sum, mass from each week's long upper tail combines instead
    # of cancelling against a flat median assumption, pulling the SUM's
    # median well above the naive sum-of-medians (n_weeks * p50 = 120) --
    # verified empirically (this seed, n_draws=4000) to land near ~178, so a
    # +10 margin over 120 is safe well beyond MC noise at this sample size.
    p10, p50 = 10.0, 20.0
    p90 = p50 + 4 * (p50 - p10)
    n_weeks = 6
    week_bands = np.array([[p10, p50, p90]] * n_weeks)
    games_probs = _point_mass(n_weeks)
    out = simulate_season(week_bands, games_probs, n_draws=4000,
                          rng=np.random.default_rng(4))
    assert out["p50"] > n_weeks * p50 + 10.0


def test_determinism_same_seed_identical_different_seed_differs():
    week_bands = np.array([[10.0, 20.0, 30.0]] * 3)
    games_probs = _point_mass(3)
    out1 = simulate_season(week_bands, games_probs, n_draws=500,
                           rng=np.random.default_rng(7))
    out2 = simulate_season(week_bands, games_probs, n_draws=500,
                           rng=np.random.default_rng(7))
    out3 = simulate_season(week_bands, games_probs, n_draws=500,
                           rng=np.random.default_rng(8))
    assert out1 == out2
    assert out1 != out3
    # rng=None default must also be deterministic (defaults to seed 0).
    assert (simulate_season(week_bands, games_probs, n_draws=200) ==
            simulate_season(week_bands, games_probs, n_draws=200))


# ------------------------------------------------------- games_probs_from_counts

def test_games_probs_from_counts_normalizes():
    counts = pd.DataFrame([
        {"position": "WR", "games": 0, "count": 2},
        {"position": "WR", "games": 1, "count": 3},
        {"position": "WR", "games": 2, "count": 5},
        {"position": "RB", "games": 0, "count": 10},
    ])
    dist = games_probs_from_counts(counts)
    assert set(dist) == {"WR", "RB"}
    assert dist["WR"].shape == (19,)
    # normalized: 2/10, 3/10, 5/10
    assert dist["WR"][0] == pytest.approx(0.2)
    assert dist["WR"][1] == pytest.approx(0.3)
    assert dist["WR"][2] == pytest.approx(0.5)
    assert dist["WR"].sum() == pytest.approx(1.0)
    assert dist["WR"][3:].sum() == pytest.approx(0.0)
    assert dist["RB"][0] == pytest.approx(1.0)         # single count -> point mass
