import json

import numpy as np
import pandas as pd
import pytest

from ffmodel.site.draft import (
    REPLACEMENT_RANK, _assign_tiers, build_draft_board, season_projection,
)
from ffmodel.scoring import PREDICTED_STATS

from tests.test_future import _history, _sched_with_future
from tests.test_site_weekly import _QuantileStub


def test_season_projection_simulates_weeks():
    # RENAMED from test_season_projection_sums_weeks: season bands are no
    # longer sums of weekly quantiles (comonotonic, assumes every scheduled
    # week is played) -- they're a Monte-Carlo simulation over independent
    # per-week draws with sampled availability (B2). `_history()` only has
    # 2023 rows, so availability_table has no consecutive season pair and
    # season_projection falls back to full availability (point mass at
    # games=2, the toy world's scheduled-week count) -- this test exercises
    # that fallback path, not the leak-free availability_table lookup.
    #
    # _QuantileStub PPR per week: p50 = 80*0.1 + 5*1 = 13.0;
    # sign-coherent band (fantasy_points_band, both stats positive-weighted
    # so low pairs with low / high with high): p10 = 40*0.1+2.5 = 6.5,
    # p90 = 120*0.1+7.5 = 19.5. Symmetric around 13.0 (13-6.5 == 19.5-13).
    #
    # Weekly inverse-CDF for (6.5, 13.0, 19.5): lo0 = p10-(p50-p10) = 0.0,
    # hi1 = p90+(p90-p50) = 26.0 -- also symmetric (0 and 26 both mirror
    # 13.0), so each week's distribution is symmetric about 13.0, and the
    # sum of 2 iid symmetric-about-13 weeks is symmetric about 26.0 with
    # median exactly at its center of symmetry -> simulated p50 ~= 26.0.
    # MC error at n_draws=2000 is small (~0.2 empirically), so tol=0.5 has
    # margin.
    #
    # p10: the OLD construction summed weekly p10s (comonotonic sum, same u
    # every week) = 2*6.5 = 13.0. Independent per-week sampling is a
    # mean-preserving CONTRACTION of the comonotonic coupling (comonotonicity
    # maximizes convex order among couplings with fixed marginals -- a
    # classical result, e.g. Denuit et al.), so the independent sum's lower
    # quantiles sit STRICTLY ABOVE the comonotonic sum's: simulated p10 must
    # be > 13.0, and by the same symmetry as p50, p90 mirrors it (p90 ~=
    # 52 - p10, since the sum is symmetric about 26).
    weekly = _history()
    sched = _sched_with_future()          # 8 scheduled weeks
    proj = season_projection(weekly, sched, _QuantileStub(), 2023,
                             weeks=range(7, 9))   # two future weeks
    p1 = proj[proj["player_id"] == "p1"].iloc[0]
    assert p1["ppr_p50"] == pytest.approx(26.0, abs=0.5)
    assert 13.0 < p1["ppr_p10"] < p1["ppr_p50"]
    assert p1["ppr_p10"] < p1["ppr_p90"] < 2 * 19.5   # comonotonic p90 ceiling
    assert p1["games"] == 2


def test_season_bands_are_sign_coherent_for_interceptions():
    # Regression pin on the DRAFT path (the third consumer of the band, after
    # harness and weekly): the simulation must consume the sign-coherent
    # per-WEEK band (fantasy_points_band), not a raw fantasy_points(p90).
    # Discriminates constructions sharply — under the old (incoherent)
    # scoring this stub's weekly band would be floor=20.0/ceil=8.0 (inverted,
    # since raw p90 stats score WORSE for a passer's ceiling — more INTs);
    # the coherent weekly band is floor=4.0/p50=8.0/ceil=10.0 (derived below).
    # If the incoherent path leaked back in, floor > ceil and every
    # assertion below would fail loudly (not silently pass with wrong
    # numbers), which is what makes this a strong regression pin.
    #
    # _IntStub weekly PPR: p50 = 250*0.04 + 1*(-2) = 8.0. fantasy_points_band
    # pairs each stat with its points-favourable end: passing_yards (positive
    # weight) low=high=250*0.04=10 -> contributes 10 either way; INT
    # (negative weight) low=0*-2=0, high=3*-2=-6 -> floor picks the min
    # (-6), ceil picks the max (0). floor = 10 + -6 = 4.0, ceil = 10 + 0 =
    # 10.0. So the weekly coherent band is (p10, p50, p90) = (4.0, 8.0, 10.0)
    # -- NOT (10.0-2*3=4, ...) via the old incoherent scoring, which would
    # instead see p10 = 250*0.04-2*3 x ... (inverted floor=250*0.04-0=10 as
    # "ceiling" and 250*0.04-6=4 as "floor" swapped in sign relative to
    # points) and produce a season p50 far from 16.0 with p10 > p90.
    #
    # Two weeks, toy world -> full-availability fallback (point mass at
    # games=2, same as the simulates_weeks test above).
    #
    # Absolute upper bound (airtight, coupling-independent): the weekly
    # inverse-CDF's max value is hi1 = p90+(p90-p50) = 10+(10-8) = 12.0 (at
    # u=1.0), so NO draw of a 2-week sum can ever exceed 2*12.0 = 24.0 --
    # this bounds p90 regardless of any distributional argument.
    #
    # Lower bound: the OLD (comonotonic, same-u) sum's p10 = 2*4.0 = 8.0.
    # Independent per-week sampling is a mean-preserving contraction of the
    # comonotonic coupling (comonotonicity maximizes convex order among
    # couplings sharing the same marginals), so the independent sum's p10
    # sits at or above the comonotonic sum's p10: simulated p10 >= 8.0. This
    # is the discriminating bound that would fail if the old incoherent
    # (floor/ceiling swapped) band leaked back in, since that band's own
    # comonotonic p10 sums to a different, smaller number entirely.
    #
    # p50: NOT 16.0 (naive sum-of-medians) -- this weekly band is skewed, so
    # sum-of-medians != median-of-sums, and hand-deriving the true value is
    # exactly the point of this test (it would have caught a wrong initial
    # guess of 16.0 here). Because the inverse-CDF is piecewise LINEAR in u,
    # V is a mixture of 4 UNIFORM pieces (density is piecewise constant):
    # w.p. 0.1 Unif[0,4], 0.4 Unif[4,8], 0.4 Unif[8,10], 0.1 Unif[10,12]
    # (each piece's probability = its u-width, range = its v-range). S = V1
    # + V2 is then an exact mixture of 16 trapezoidal-sum pairs, each with a
    # closed-form CDF (standard two-uniform-convolution formula). Evaluating
    # F_S at s=14, 15 by hand (summing all 16 weighted pair-CDFs):
    # F_S(14) = 0.405, F_S(15) = 0.509 -- the median (F_S=0.5) sits at
    # s ~= 14.9, confirmed by direct evaluation: F_S(14.9) = 0.4985. So the
    # true median-of-sums is ~14.9, well below the naive sum-of-medians
    # 16.0 (left-skew: median-of-sums sits closer to the sum's mean,
    # E[S] = 2*7.3 = 14.6, than to 2x the per-week median). n_draws=2000
    # keeps MC noise small (est. SE ~0.1 from Var(S)~13.7 and density
    # ~0.104 near the median), so ±0.5 around 14.9 has ample margin.
    class _IntStub:
        name = "intstub"

        def fit(self, train):
            pass

        def predict(self, test):
            return self.predict_quantiles(test)["p50"]

        def predict_quantiles(self, test):
            z = pd.DataFrame(0.0, index=test.index, columns=PREDICTED_STATS)
            p10 = z.copy(); p10["passing_yards"] = 250.0; p10["passing_interceptions"] = 0.0
            p50 = z.copy(); p50["passing_yards"] = 250.0; p50["passing_interceptions"] = 1.0
            p90 = z.copy(); p90["passing_yards"] = 250.0; p90["passing_interceptions"] = 3.0
            return {"p10": p10, "p50": p50, "p90": p90}

    weekly = _history()
    proj = season_projection(weekly, _sched_with_future(), _IntStub(), 2023,
                             weeks=range(7, 9))   # two future weeks
    p1 = proj[proj["player_id"] == "p1"].iloc[0]
    assert p1["ppr_p50"] == pytest.approx(14.9, abs=0.5)
    assert p1["ppr_p10"] >= 8.0
    assert p1["ppr_p90"] <= 24.0
    assert p1["ppr_p10"] <= p1["ppr_p50"] <= p1["ppr_p90"]


def test_games_dist_injection_reduces_totals():
    # Explicit games_dist overrides the toy-world full-availability fallback:
    # a point mass at G=1 out of 2 scheduled weeks means every simulated
    # draw retains exactly 1 of the 2 weeks. With a DEGENERATE stub band
    # (p10=p50=p90 every week, same value both weeks), whichever week gets
    # retained contributes the same value, so the simulated season total is
    # deterministically exactly ONE week's value -- proving availability
    # actually reduces totals (rather than the old sum-of-2-weeks always
    # summing all scheduled weeks regardless of games_dist).
    class _DegenerateStub:
        name = "degenerate"

        def fit(self, train):
            pass

        def predict(self, test):
            return self.predict_quantiles(test)["p50"]

        def predict_quantiles(self, test):
            base = pd.DataFrame(0.0, index=test.index, columns=PREDICTED_STATS)
            base["receiving_yards"] = 80.0
            base["receptions"] = 5.0     # PPR = 80*0.1 + 5 = 13.0, every quantile
            return {"p10": base.copy(), "p50": base.copy(), "p90": base.copy()}

    point_mass_g1 = np.zeros(19)
    point_mass_g1[1] = 1.0
    games_dist = {"WR": point_mass_g1, "RB": point_mass_g1}

    weekly = _history()
    proj = season_projection(weekly, _sched_with_future(), _DegenerateStub(), 2023,
                             weeks=range(7, 9), games_dist=games_dist)
    p1 = proj[proj["player_id"] == "p1"].iloc[0]
    assert p1["games"] == 2                          # scheduled-week count, unchanged semantics
    assert p1["ppr_p50"] == pytest.approx(13.0)       # one week's value, not two
    assert p1["ppr_p10"] == pytest.approx(13.0)
    assert p1["ppr_p90"] == pytest.approx(13.0)


def test_bye_week_reduces_games():
    weekly = _history()
    sched = _sched_with_future()
    sched = sched[sched["week"] != 8]     # week 8 becomes a universal bye
    proj = season_projection(weekly, sched, _QuantileStub(), 2023, weeks=range(7, 9))
    assert (proj["games"] == 1).all()


def test_vorp_and_ordering():
    ppr_p50 = list(range(300, 270, -1)) + list(range(400, 370, -1))
    players = pd.DataFrame({
        "player_id": [f"wr{i}" for i in range(30)] + [f"rb{i}" for i in range(30)],
        "name": "x", "team": "AAA",
        "position": ["WR"] * 30 + ["RB"] * 30,
        "ppr_p50": ppr_p50, "ppr_p10": np.nan, "ppr_p90": np.nan,
        "half_ppr_p50": ppr_p50, "half_ppr_p10": np.nan, "half_ppr_p90": np.nan,
        "standard_p50": ppr_p50, "standard_p10": np.nan, "standard_p90": np.nan,
        "games": 17, "bye": None,
    })
    from ffmodel.site.draft import _finalize_board

    payload = _finalize_board(players, model="m", season=2026,
                              data_through="2025-01-05", has_bands=False)
    vorps = [p["vorp"] for p in payload["players"]]
    assert vorps == sorted(vorps, reverse=True)
    top = payload["players"][0]
    assert top["position"] == "RB" and top["position_rank"] == 1
    # replacement: RB rank 25 has p50 400-24=376 -> top RB vorp = 400-376 = 24
    assert top["vorp"] == pytest.approx(24.0)
    json.dumps(payload)


def test_tier_breaks_on_gaps():
    # 12 players, replacement_rank=5 -> draftable pool is the top 10.
    # Pool steps are a steady 2.0 except one real cliff (94 -> 60) inside the
    # pool; two "waiver tail" players sit far below with huge gaps that must
    # NOT be allowed to inflate the threshold (that's the bug being fixed:
    # the old span-based formula used the full range including this tail,
    # which raised the threshold past 34 and hid the real cliff).
    vorp = pd.Series([
        100.0, 98.0, 96.0, 94.0,             # tier 1 (steady 2.0 steps)
        60.0, 58.0, 56.0, 54.0, 52.0, 50.0,   # tier 2 (steady 2.0 steps; end of pool)
        -200.0,                               # tier 3 (waiver tail)
        -250.0,                               # tier 4 (waiver tail)
    ])
    # pool = first 10 values; mean_gap = (100 - 50) / 9 = 5.555..
    # threshold = max(2.0, 2 * 5.555..) = 11.111..
    tiers = _assign_tiers(vorp, replacement_rank=5)
    assert tiers == [1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 4]


def test_tier_single_player_pool_too_small_for_gap_stats():
    # n_draft = min(2*rank, len) < 2 -> no gap statistics possible.
    vorp = pd.Series([42.0])
    assert _assign_tiers(vorp, replacement_rank=5) == [1]


def test_tier_all_equal_vorp_collapses_to_one_tier():
    # Zero mean gap within the pool -> threshold floors at 2.0; with no
    # diffs exceeding it, every player lands in a single tier.
    vorp = pd.Series([10.0] * 8)
    assert _assign_tiers(vorp, replacement_rank=3) == [1] * 8


def test_end_to_end_board():
    weekly = _history()
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9))
    assert board["has_bands"] is True
    assert board["methodology"]["replacement_rank"] == REPLACEMENT_RANK
    assert len(board["players"]) == 2
    json.dumps(board)


def test_empty_weeks_range_fails_loud():
    weekly = _history()
    sched = _sched_with_future()          # weeks 1-8 scheduled; 9-10 do not exist
    with pytest.raises(RuntimeError, match="empty draft board"):
        build_draft_board(weekly, sched, _QuantileStub(), 2023,
                          "2023-10-15", weeks=range(9, 11))


def test_board_carries_games_bye_and_all_rulesets():
    weekly = _history()
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9))
    top = board["players"][0]
    assert top["games"] == 2
    assert top["bye"] is None            # toy schedule has no bye in weeks 7-8
    assert set(top["season_points"]) == {"ppr", "half_ppr", "standard"}
    assert top["season_points"]["standard"]["p50"] <= top["season_points"]["ppr"]["p50"]


def test_prefit_skips_internal_fit():
    weekly = _history()

    class CountingStub(_QuantileStub):
        fits = 0

        def fit(self, train):
            type(self).fits += 1

    stub = CountingStub()
    stub.fit(None)                       # simulate generate.py's own fit
    build_draft_board(weekly, _sched_with_future(), stub, 2023,
                      "2023-10-15", weeks=range(7, 9), prefit=True)
    assert CountingStub.fits == 1


def test_bye_values_are_json_safe():
    from tests.test_features import make_weekly, make_schedules

    weekly = make_weekly([
        {"player_id": "p1", "week": w, "receiving_yards": 50.0} for w in range(1, 7)
    ] + [
        {"player_id": "p3", "team": "CCC", "opponent_team": "DDD", "position": "RB",
         "week": w, "rushing_yards": 40.0} for w in range(1, 7)
    ])
    sched = make_schedules(8)                     # AAA/BBB play weeks 7-8
    extra = pd.DataFrame({                        # CCC/DDD play ONLY week 7 -> week 8 bye
        "season": 2023, "week": [7],
        "gameday": ["2023-10-22"], "home_team": "CCC", "away_team": "DDD",
    })
    sched = pd.concat([sched, extra], ignore_index=True)
    board = build_draft_board(weekly, sched, _QuantileStub(), 2023,
                              "2023-10-15", weeks=range(7, 9))
    byes = {p["player_id"]: p["bye"] for p in board["players"]}
    assert byes["p3"] == 8                        # genuine bye, plain int
    assert byes["p1"] is None                     # plays both weeks
    payload = json.dumps(board, allow_nan=False)  # must not raise
    assert '"bye": 8' in payload
