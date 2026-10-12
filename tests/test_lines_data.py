"""Lines loader, validation taxonomy and join (spec 2026-10-11 §2-3, §11).

All synthetic; no network. Quote values are invented round numbers, not
real market data.
"""
import json
import warnings

import numpy as np
import pandas as pd
import pytest

from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.data.features import build_features
from ffmodel.data.lines import (
    ALLOWED_COLUMNS,
    LinesDataError,
    build_line_table,
    file_sha256,
    join_line_features,
    read_snapshot,
    select_allowed,
    snapshot_meta_path,
    snapshot_schedules,
    team_game_lines,
    validate_games,
)

from tests.test_features import make_weekly

SEASONS = [2023]


def raw_game(**overrides) -> dict:
    """One raw nflverse-style schedule record, outcome columns included."""
    base = {
        "game_id": "2023_01_BUF_KC", "season": 2023, "game_type": "REG", "week": 1,
        "gameday": "2023-09-10", "away_team": "BUF", "home_team": "KC",
        "away_score": 20, "home_score": 27, "location": "Home", "result": 7,
        "total": 47, "overtime": 0, "spread_line": 6.0, "total_line": 46.0,
        "away_moneyline": 200.0, "home_moneyline": -240.0, "roof": "outdoors",
    }
    return {**base, **overrides}


def raw_frame(*records: dict) -> pd.DataFrame:
    return pd.DataFrame(list(records))


def lines_for(*records: dict) -> pd.DataFrame:
    table, _ = build_line_table(raw_frame(*records), SEASONS)
    return table


def side(table: pd.DataFrame, team: str) -> pd.Series:
    return table[table["team"] == team].iloc[0]


# --- feature formulas -----------------------------------------------------

def test_worked_example_46_and_plus_6():
    table = lines_for(raw_game(total_line=46.0, spread_line=6.0))
    home, away = side(table, "KC"), side(table, "BUF")
    assert (home["side"], away["side"]) == ("home", "away")
    assert home["team_implied_total"] == 26.0 and away["team_implied_total"] == 20.0
    assert home["team_expected_margin"] == 6.0 and away["team_expected_margin"] == -6.0


@pytest.mark.parametrize("total,spread", [(46.0, 6.0), (41.5, -3.5), (50.0, 13.0), (38.0, 0.0)])
def test_implied_total_identities(total, spread):
    table = lines_for(raw_game(total_line=total, spread_line=spread))
    home, away = side(table, "KC"), side(table, "BUF")
    assert home["team_implied_total"] + away["team_implied_total"] == pytest.approx(total, abs=1e-9)
    assert home["team_implied_total"] - away["team_implied_total"] == pytest.approx(spread, abs=1e-9)
    assert home["team_expected_margin"] == -away["team_expected_margin"] == spread


def test_sign_convention_positive_spread_is_home_favoured():
    fav_home = lines_for(raw_game(spread_line=3.0))
    fav_away = lines_for(raw_game(spread_line=-3.0))
    assert side(fav_home, "KC")["team_implied_total"] > side(fav_home, "BUF")["team_implied_total"]
    assert side(fav_away, "KC")["team_implied_total"] < side(fav_away, "BUF")["team_implied_total"]
    assert side(fav_away, "BUF")["team_expected_margin"] == 3.0


def test_pick_em_splits_the_total_evenly():
    table = lines_for(raw_game(total_line=44.0, spread_line=0.0))
    for team in ("KC", "BUF"):
        assert side(table, team)["team_implied_total"] == 22.0
        assert side(table, team)["team_expected_margin"] == 0.0


def test_neutral_site_uses_documented_home_side_as_is():
    home_site = lines_for(raw_game(location="Home"))
    neutral = lines_for(raw_game(location="Neutral"))
    pd.testing.assert_frame_equal(home_site, neutral)
    assert side(neutral, "KC")["side"] == "home"
    assert side(neutral, "KC")["team_expected_margin"] == 6.0


# --- team codes -------------------------------------------------------------

@pytest.mark.parametrize("legacy,current", [("OAK", "LV"), ("SD", "LAC"), ("STL", "LA")])
def test_legacy_team_codes_are_normalised_and_game_id_preserved(legacy, current):
    gid = f"2023_01_BUF_{legacy}"
    table = lines_for(raw_game(home_team=legacy, game_id=gid))
    assert set(table["team"]) == {current, "BUF"}
    assert set(table["game_id"]) == {gid}


def test_unknown_team_code_is_fatal():
    with pytest.raises(LinesDataError, match="unknown team code"):
        lines_for(raw_game(home_team="XXX"))


def test_identical_home_and_away_is_fatal():
    with pytest.raises(LinesDataError, match="identical home and away"):
        lines_for(raw_game(home_team="BUF", away_team="BUF"))


def test_identical_after_normalisation_is_fatal():
    with pytest.raises(LinesDataError, match="identical home and away"):
        lines_for(raw_game(home_team="OAK", away_team="LV"))


# --- duplicate / identity taxonomy ---------------------------------------------

def test_exact_duplicate_collapses_and_is_counted():
    games, report = validate_games(select_allowed(raw_frame(raw_game(), raw_game())), SEASONS)
    assert len(games) == 1
    assert report["exact_duplicates_collapsed"] == 1


def test_exact_duplicate_with_missing_quote_collapses_too():
    games, report = validate_games(
        select_allowed(raw_frame(raw_game(total_line=np.nan), raw_game(total_line=np.nan))), SEASONS)
    assert len(games) == 1 and report["exact_duplicates_collapsed"] == 1
    assert games["quote_status"].iloc[0] == "missing_quote"


def test_outcome_only_difference_is_still_an_exact_duplicate():
    # result/score columns are outside the allow-list, so they cannot make
    # two otherwise identical records "different".
    games, report = validate_games(
        select_allowed(raw_frame(raw_game(result=7), raw_game(result=-3))), SEASONS)
    assert len(games) == 1 and report["exact_duplicates_collapsed"] == 1


@pytest.mark.parametrize("override", [
    {"home_team": "MIA"},              # different teams
    {"total_line": 47.0},             # same teams, different quote (44 vs 47 style)
    {"spread_line": 3.0},             # same teams, different spread
    {"week": 2},                      # same teams, different week
    {"game_type": "WC"},              # same teams, different game_type
    {"season": 2022},                 # same teams, different season
])
def test_repeated_game_id_that_is_not_an_exact_duplicate_is_fatal(override):
    first = raw_game(total_line=44.0)
    second = raw_game(**{"total_line": 44.0, **override})
    with pytest.raises(LinesDataError, match="repeated game_id"):
        lines_for(first, second)


def test_legacy_and_current_code_copies_of_one_game_are_fatal_not_collapsed():
    # Exact-duplicate collapse compares the RAW allowed values, before team
    # normalisation, so an OAK copy and an LV copy are two different records.
    with pytest.raises(LinesDataError, match="repeated game_id"):
        lines_for(raw_game(game_id="2019_01_BUF_OAK", home_team="OAK", season=2023),
                  raw_game(game_id="2019_01_BUF_OAK", home_team="LV", season=2023))


def test_team_week_collision_is_fatal():
    other = raw_game(game_id="2023_01_KC_MIA", home_team="MIA", away_team="KC")
    with pytest.raises(LinesDataError, match="team-week collision"):
        lines_for(raw_game(), other)


@pytest.mark.parametrize("column", ["season", "week", "game_type", "game_id", "home_team", "away_team"])
def test_missing_key_field_is_fatal(column):
    record = raw_game()
    record[column] = None
    frame = raw_frame(record, raw_game(game_id="2023_02_BUF_KC", week=2))
    with pytest.raises(LinesDataError, match="missing key field"):
        build_line_table(frame, SEASONS)


def test_missing_allowed_column_is_fatal():
    with pytest.raises(LinesDataError, match="missing allowed column"):
        select_allowed(raw_frame(raw_game()).drop(columns=["total_line"]))


# --- recoverable quotes --------------------------------------------------------

@pytest.mark.parametrize("quote,reason", [
    ({"spread_line": np.nan}, "missing_quote"),
    ({"total_line": np.nan}, "missing_quote"),
    ({"total_line": np.inf}, "missing_quote"),
    # Joint non-finite: inf - inf / inf + -inf must never be evaluated (it
    # would emit a RuntimeWarning, an error under -W error).
    ({"total_line": np.inf, "spread_line": np.inf}, "missing_quote"),
    ({"total_line": np.inf, "spread_line": -np.inf}, "missing_quote"),
    ({"total_line": 0.0}, "nonpositive_total"),
    ({"total_line": -40.0}, "nonpositive_total"),
    ({"total_line": 10.0, "spread_line": 14.0}, "negative_implied_total"),
])
def test_unusable_quote_gives_nan_for_both_sides(quote, reason):
    with warnings.catch_warnings():
        warnings.simplefilter("error")                       # no warning, whatever the pytest flags
        table, report = build_line_table(raw_frame(raw_game(**quote)), SEASONS)
    assert len(table) == 2                                   # both sides kept
    assert set(table["quote_status"]) == {reason}
    assert table[["team_implied_total", "team_expected_margin"]].isna().all().all()
    assert report["quote_status_counts"][reason] == 1
    assert report["quote_status_counts"]["valid"] == 0


def test_team_game_lines_rejects_a_broken_identity():
    games, _ = validate_games(select_allowed(raw_frame(raw_game())), SEASONS)
    games = games.assign(quote_status="valid", total_line=np.nan)  # valid label, no total
    with pytest.raises(LinesDataError, match="identities"):
        team_game_lines(games)


def test_scope_is_reg_games_in_requested_seasons():
    frame = raw_frame(
        raw_game(),
        raw_game(game_id="2023_19_BUF_KC", week=19, game_type="WC"),
        raw_game(game_id="2022_01_BUF_KC", season=2022),
    )
    games, report = validate_games(select_allowed(frame), SEASONS)
    assert list(games["game_id"]) == ["2023_01_BUF_KC"]
    assert report["payload_records"] == 3 and report["reg_games"] == 1
    assert report["coverage_matches_claim"] is False        # 1 != 3663, recorded not fatal


# --- join ---------------------------------------------------------------------

def players(rows: list[dict]) -> pd.DataFrame:
    base = {"player_id": "p1", "season": 2023, "week": 1, "team": "KC", "position": "WR"}
    return pd.DataFrame([{**base, **r} for r in rows], index=[10 + i for i in range(len(rows))])


def two_week_lines(week2_quote: dict | None = None) -> pd.DataFrame:
    return lines_for(raw_game(),
                     raw_game(game_id="2023_02_BUF_KC", week=2, **(week2_quote or {})))


def test_join_keeps_row_count_order_index_and_keys():
    feats = players([
        {"player_id": "p2", "week": 2, "team": "BUF"},
        {"player_id": "p1", "week": 1, "team": "KC"},
        {"player_id": "p3", "week": 1, "team": "BUF"},
        {"player_id": "p1", "week": 2, "team": "KC"},
    ])
    out, report = join_line_features(feats, two_week_lines())
    pd.testing.assert_frame_equal(out.drop(columns=["team_implied_total", "team_expected_margin"]), feats)
    assert list(out["team_implied_total"]) == [20.0, 26.0, 20.0, 26.0]
    assert list(out["team_expected_margin"]) == [-6.0, 6.0, -6.0, 6.0]
    assert report[2023]["rows"] == 4 and report[2023]["matched_valid_quote"] == 4


def test_join_is_many_to_one():
    table = two_week_lines()
    dup = pd.concat([table, table.iloc[[0]]], ignore_index=True)
    with pytest.raises(LinesDataError, match="not unique"):
        join_line_features(players([{}]), dup)


def test_missing_quote_rows_are_kept_and_counted_separately_from_unmatched():
    feats = players([{"week": 1}, {"week": 2}, {"week": 2, "player_id": "p9", "team": "BUF"}])
    out, report = join_line_features(feats, two_week_lines({"total_line": np.nan}))
    assert len(out) == 3
    assert np.isnan(out["team_implied_total"].iloc[1]) and np.isnan(out["team_implied_total"].iloc[2])
    assert out["team_implied_total"].iloc[0] == 26.0
    assert report[2023]["matched_valid_quote"] == 1
    assert report[2023]["missing_quote_by_reason"]["missing_quote"] == 2


def test_unmatched_player_team_week_is_fatal():
    feats = players([{"week": 1}, {"week": 3}])          # no week-3 game
    with pytest.raises(LinesDataError, match="unmatched player team-week"):
        join_line_features(feats, two_week_lines())


def test_player_row_with_null_team_is_unmatched_not_missing_quote():
    feats = players([{"week": 1}, {"week": 1, "player_id": "p2", "team": None}])
    with pytest.raises(LinesDataError, match="unmatched player team-week"):
        join_line_features(feats, two_week_lines())


def test_join_refuses_a_frame_that_already_has_line_columns():
    with pytest.raises(ValueError, match="already in the feature frame"):
        join_line_features(players([{}]).assign(team_implied_total=1.0), two_week_lines())


# --- allow-list: outcome columns cannot move features or the model matrix -------

def _world_raw() -> pd.DataFrame:
    return raw_frame(*[
        raw_game(game_id=f"2023_{w:02d}_BUF_KC", week=w, spread_line=float(w) - 2.5,
                 total_line=40.0 + w)
        for w in range(1, 5)
    ])


def _world_features() -> pd.DataFrame:
    rows = []
    for w in range(1, 5):
        rows.append({"player_id": "p1", "team": "KC", "opponent_team": "BUF", "week": w,
                     "receiving_yards": 30.0 * w, "receptions": float(w)})
        rows.append({"player_id": "p2", "team": "BUF", "opponent_team": "KC", "week": w,
                     "position": "RB", "rushing_yards": 20.0 * w, "carries": 5.0 + w})
    sched = pd.DataFrame({
        "season": 2023, "week": range(1, 5),
        "gameday": pd.date_range("2023-09-10", periods=4, freq="7D").strftime("%Y-%m-%d"),
        "home_team": "KC", "away_team": "BUF",
    })
    return build_features(make_weekly(rows), sched)


def test_outcome_columns_cannot_change_features_or_matrix():
    raw = _world_raw()
    perturbed = raw.assign(
        result=-raw["result"] * 9, total=raw["total"] + 30, home_score=0, away_score=99,
        overtime=1, away_moneyline=-raw["away_moneyline"], location="Neutral",
        surprise_outcome_column=123.0,
    )
    feats = _world_features()
    out_a, _ = join_line_features(feats, build_line_table(raw, SEASONS)[0])
    out_b, _ = join_line_features(feats, build_line_table(perturbed, SEASONS)[0])
    pd.testing.assert_frame_equal(out_a, out_b)
    m_a = XGBBaseline(feature_set="v1_lines")._matrix(out_a)
    m_b = XGBBaseline(feature_set="v1_lines")._matrix(out_b)
    assert list(m_a.columns) == list(m_b.columns)
    assert m_a.to_numpy().tobytes() == m_b.to_numpy().tobytes()
    assert list(select_allowed(perturbed).columns) == ALLOWED_COLUMNS


# --- snapshot -----------------------------------------------------------------

def test_snapshot_writes_meta_and_refuses_overwrite(tmp_path):
    path = tmp_path / "lines" / "schedules_raw.parquet"
    meta = snapshot_schedules([2023], path, loader=lambda: _world_raw())
    assert meta["sha256"] == file_sha256(path)
    assert meta["rows"] == 4 and meta["seasons"] == [2023]
    assert json.loads(snapshot_meta_path(path).read_text(encoding="utf-8")) == meta
    assert "retrieved_at" in meta and "nflreadpy_version" in meta
    pd.testing.assert_frame_equal(read_snapshot(path, meta["sha256"]), _world_raw())
    with pytest.raises(FileExistsError):
        snapshot_schedules([2023], path, loader=lambda: _world_raw())


def test_snapshot_refuses_an_existing_sidecar_and_keeps_its_bytes(tmp_path):
    path = tmp_path / "schedules_raw.parquet"
    snapshot_meta_path(path).write_bytes(b"original sidecar")

    def never():
        raise AssertionError("must not pull when the sidecar exists")

    with pytest.raises(FileExistsError):
        snapshot_schedules([2023], path, loader=never)
    assert snapshot_meta_path(path).read_bytes() == b"original sidecar"
    assert not path.exists()


def test_read_snapshot_rejects_changed_bytes(tmp_path):
    path = tmp_path / "schedules_raw.parquet"
    meta = snapshot_schedules([2023], path, loader=lambda: _world_raw())
    _world_raw().assign(total_line=1.0).to_parquet(path, index=False)
    with pytest.raises(LinesDataError, match="sha256"):
        read_snapshot(path, meta["sha256"])
