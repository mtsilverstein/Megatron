from __future__ import annotations

from copy import deepcopy

from tools.check_draft_readiness import validate_board_contract


def _league() -> dict:
    return {
        "slug": "test",
        "roster": {"QB": 1, "RB": 2, "WR": 2, "TE": 1},
        "scoring": {"passing_td": 6.0, "passing_interceptions": -2.0},
        "unprojected_scoring": {"pass_int_td": -3.0, "pass_2pt": 2.0},
    }


def _prior() -> dict:
    return {
        "method": "pooled_return_rate_expected_cost_v1",
        "rate": 0.12,
        "interceptions": 100,
        "pick_sixes": 12,
        "first_season": 2022,
        "through_season": 2025,
        "source": "test fixture",
        "volume_method": "nonnegative_piecewise_linear_int_quantile_mean",
        "uncertainty": "expected cost only; discrete pick-six variance not simulated",
    }


def _forecast_board() -> dict:
    league = _league()
    del league["unprojected_scoring"]["pass_int_td"]
    return {"season": 2026, "league": league, "pick_six_forecast": _prior()}


def test_dormant_board_without_forecast_keeps_full_contract():
    board = {"season": 2026, "league": _league()}

    assert validate_board_contract(board, _league(),
                                   prior_loader=lambda season: None) == []


def test_verified_forecast_allows_only_pick_six_to_leave_unprojected_scoring():
    seen = []

    def load_prior(season):
        seen.append(season)
        return _prior()

    assert validate_board_contract(_forecast_board(), _league(),
                                   prior_loader=load_prior) == []
    assert seen == [2026]


def test_forged_forecast_does_not_authorize_narrower_contract():
    board = _forecast_board()
    board["pick_six_forecast"]["rate"] = 0.99

    errors = validate_board_contract(board, _league(),
                                     prior_loader=lambda season: _prior())

    assert "board pick-six forecast metadata differs from source prior" in errors
    assert "board league contract differs from configs/leagues source of truth" in errors


def test_forecast_metadata_requires_exact_types_and_fields():
    board = _forecast_board()
    board["pick_six_forecast"]["interceptions"] = 100.0

    errors = validate_board_contract(board, _league(),
                                     prior_loader=lambda season: _prior())

    assert "board pick-six forecast metadata differs from source prior" in errors


def test_malformed_forecast_does_not_authorize_narrower_contract():
    board = _forecast_board()
    board["pick_six_forecast"] = ["not", "metadata"]

    errors = validate_board_contract(board, _league(),
                                     prior_loader=lambda season: _prior())

    assert "board pick-six forecast metadata is not an object" in errors
    assert "board league contract differs from configs/leagues source of truth" in errors


def test_forecast_requires_integer_board_season_before_loading_prior():
    board = _forecast_board()
    board["season"] = "2026"

    errors = validate_board_contract(
        board, _league(), prior_loader=lambda season: (_ for _ in ()).throw(
            AssertionError("prior loader must not receive a malformed season")
        )
    )

    assert "board pick-six forecast has invalid season '2026'" in errors
    assert "board league contract differs from configs/leagues source of truth" in errors


def test_missing_forecast_does_not_authorize_narrower_contract():
    board = _forecast_board()
    del board["pick_six_forecast"]

    assert validate_board_contract(board, _league()) == [
        "board league contract differs from configs/leagues source of truth"
    ]


def test_unverifiable_prior_does_not_authorize_narrower_contract():
    def broken_prior(season):
        raise ValueError("invalid observed pick-six counts")

    errors = validate_board_contract(_forecast_board(), _league(),
                                     prior_loader=broken_prior)

    assert errors[0].startswith("board pick-six forecast provenance could not be verified:")
    assert "board league contract differs from configs/leagues source of truth" in errors


def test_verified_forecast_still_rejects_other_scoring_and_roster_drift():
    for mutate in (
        lambda league: league["unprojected_scoring"].update(pass_2pt=3.0),
        lambda league: league["roster"].update(RB=3),
        lambda league: league["scoring"].update(passing_td=4.0),
    ):
        board = _forecast_board()
        mutate(board["league"])

        assert validate_board_contract(
            board, deepcopy(_league()), prior_loader=lambda season: _prior()
        ) == ["board league contract differs from configs/leagues source of truth"]
