"""Walk-forward season splits. The only split logic allowed in this project."""
from __future__ import annotations

from typing import Iterator

import pandas as pd


def walk_forward_splits(
    df: pd.DataFrame, test_seasons: list[int]
) -> Iterator[tuple[int, pd.Index, pd.Index]]:
    for season in sorted(test_seasons):
        train_idx = df.index[df["season"] < season]
        test_idx = df.index[df["season"] == season]
        yield season, train_idx, test_idx
