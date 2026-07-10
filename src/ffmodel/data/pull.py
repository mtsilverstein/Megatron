"""nflverse data pulls. All network access for the project lives here."""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from ffmodel.scoring import PREDICTED_STATS, SCORING_EXTRAS

POSITIONS = ["QB", "RB", "WR", "TE"]

CONTEXT_COLUMNS = [
    "player_id", "player_display_name", "position", "team", "opponent_team",
    "season", "week",
]

# Canonical columns derived by summing raw nflverse columns.
_RAW_SUMS = {
    "fumbles_lost": [
        "rushing_fumbles_lost", "receiving_fumbles_lost", "sack_fumbles_lost",
    ],
    "two_point_conversions": [
        "passing_2pt_conversions", "rushing_2pt_conversions",
        "receiving_2pt_conversions",
    ],
}


def normalize_weekly(raw: pd.DataFrame) -> pd.DataFrame:
    """Reduce a raw nflverse player-stats frame to the canonical schema."""
    df = raw[(raw["season_type"] == "REG") & raw["position_group"].isin(POSITIONS)].copy()
    df["position"] = df["position_group"]
    for out, parts in _RAW_SUMS.items():
        df[out] = sum(df[p].fillna(0) for p in parts)
    keep = (
        CONTEXT_COLUMNS + PREDICTED_STATS + SCORING_EXTRAS
        + ["target_share", "fantasy_points_ppr"]
    )
    df = df[keep].copy()
    stat_cols = PREDICTED_STATS + SCORING_EXTRAS
    df[stat_cols] = df[stat_cols].fillna(0)
    return df.sort_values(["player_id", "season", "week"]).reset_index(drop=True)


def _cached(cache_dir: Path | None, name: str, loader) -> pd.DataFrame:
    if cache_dir is not None:
        path = Path(cache_dir) / f"{name}.parquet"
        if path.exists():
            return pd.read_parquet(path)
    df = loader()
    if cache_dir is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(path, index=False)
    return df


def pull_weekly(seasons: list[int], cache_dir: Path | None = None) -> pd.DataFrame:
    def load() -> pd.DataFrame:
        import nflreadpy  # deferred: keep offline unit tests import-light

        raw = nflreadpy.load_player_stats(seasons).to_pandas()
        return normalize_weekly(raw)

    return _cached(cache_dir, f"weekly_{min(seasons)}_{max(seasons)}", load)


def pull_schedules(seasons: list[int], cache_dir: Path | None = None) -> pd.DataFrame:
    def load() -> pd.DataFrame:
        import nflreadpy

        raw = nflreadpy.load_schedules(seasons).to_pandas()
        raw = raw[raw["game_type"] == "REG"]
        keep = ["season", "week", "gameday", "home_team", "away_team"]
        return raw[keep].reset_index(drop=True)

    return _cached(cache_dir, f"schedules_{min(seasons)}_{max(seasons)}", load)


def main() -> None:
    parser = argparse.ArgumentParser(description="Pull and cache nflverse data.")
    parser.add_argument("--seasons", nargs=2, type=int, default=[2012, 2025],
                        metavar=("FIRST", "LAST"))
    parser.add_argument("--out", type=Path, default=Path("data/raw"))
    args = parser.parse_args()
    seasons = list(range(args.seasons[0], args.seasons[1] + 1))
    weekly = pull_weekly(seasons, cache_dir=args.out)
    sched = pull_schedules(seasons, cache_dir=args.out)
    print(f"weekly: {len(weekly):,} rows, schedules: {len(sched):,} rows -> {args.out}")


if __name__ == "__main__":
    main()
