"""Feature-set resolution for the lines screen (spec 2026-10-11 §3, §11)."""
import numpy as np
import pandas as pd
import pytest

from ffmodel.baseline.xgb import XGBBaseline
from ffmodel.data.features import (
    LINE_FEATURE_COLUMNS,
    build_features,
    feature_columns,
)

from tests.test_features import V1_FEATURE_COLUMNS, make_schedules, make_weekly


def _frames() -> tuple[pd.DataFrame, pd.DataFrame]:
    """(plain, augmented): the same build_features output, without and with
    the two line columns (one NaN quote row included)."""
    weekly = make_weekly([
        {"week": 1, "receiving_yards": 50.0, "receiving_air_yards": 10.0, "attempts": 20.0},
        {"week": 2, "receiving_yards": 70.0, "receiving_air_yards": 5.0, "attempts": 30.0},
        {"week": 3, "receiving_yards": 90.0, "receiving_air_yards": 7.0, "attempts": 25.0},
    ])
    plain = build_features(weekly, make_schedules(roof="dome"))
    augmented = plain.assign(
        team_implied_total=[26.0, np.nan, 20.5],
        team_expected_margin=[6.0, np.nan, -3.5],
    )
    return plain, augmented


def test_v1_list_and_values_unchanged_on_augmented_frame():
    plain, augmented = _frames()
    assert feature_columns(augmented, "v1") == V1_FEATURE_COLUMNS
    assert len(feature_columns(augmented, "v1")) == 40
    pd.testing.assert_frame_equal(
        XGBBaseline(feature_set="v1")._matrix(augmented),
        XGBBaseline(feature_set="v1")._matrix(plain),
    )


def test_v1_lines_is_v1_plus_exactly_the_two_line_columns_in_order():
    _, augmented = _frames()
    cols = feature_columns(augmented, "v1_lines")
    assert LINE_FEATURE_COLUMNS == ["team_implied_total", "team_expected_margin"]
    assert cols == V1_FEATURE_COLUMNS + LINE_FEATURE_COLUMNS
    assert len(cols) == 42
    matrix = XGBBaseline(feature_set="v1_lines")._matrix(augmented)
    assert list(matrix.columns) == cols
    assert np.isnan(matrix["team_implied_total"].iloc[1])   # NaN kept, not filled


@pytest.mark.parametrize("absent", ["team_implied_total", "team_expected_margin"])
def test_v1_lines_raises_when_a_line_column_is_absent(absent):
    _, augmented = _frames()
    with pytest.raises(ValueError, match="needs line column"):
        feature_columns(augmented.drop(columns=[absent]), "v1_lines")
    with pytest.raises(ValueError, match="needs line column"):
        XGBBaseline(feature_set="v1_lines")._matrix(augmented.drop(columns=[absent]))


def test_v2_unchanged_on_augmented_frame():
    plain, augmented = _frames()
    assert feature_columns(augmented, "v2") == feature_columns(plain, "v2")
    assert not set(LINE_FEATURE_COLUMNS) & set(feature_columns(augmented, "v2"))


def test_lines_entrant_is_renamed():
    assert XGBBaseline(feature_set="v1_lines").name == "xgboost_v1_lines"
