"""nflverse data pulls. All network access for the project lives here."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import pandas as pd

from ffmodel.scoring import PREDICTED_STATS, SCORING_EXTRAS

POSITIONS = ["QB", "RB", "WR", "TE"]

# nflverse player_stats uses current franchise codes for ALL seasons, while
# schedules keep era-accurate codes. Normalize schedules to current codes so
# the two frames join cleanly (Rams/Chargers/Raiders relocations).
TEAM_CODE_FIXES = {"STL": "LA", "SD": "LAC", "OAK": "LV"}


def normalize_schedule_teams(sched: pd.DataFrame) -> pd.DataFrame:
    """Replace legacy team codes with current franchise codes.

    nflverse schedules preserve era-accurate codes (STL through 2015, SD through
    2016, OAK through 2019) but player_stats uses current codes for all seasons.
    This normalization ensures clean joins on team codes.
    """
    out = sched.copy()
    for col in ("home_team", "away_team"):
        out[col] = out[col].replace(TEAM_CODE_FIXES)
    return out

CONTEXT_COLUMNS = [
    "player_id", "player_display_name", "position", "team", "opponent_team",
    "season", "week",
]


def _cache_name(prefix: str, seasons: list[int]) -> str:
    """Generate a cache filename from prefix and season list.

    Contiguous ranges use a simple span notation; non-contiguous lists include
    a hash to distinguish them (e.g. [2012,2015] vs [2012,2013,2015]).
    """
    ordered = sorted(seasons)
    span = f"{ordered[0]}_{ordered[-1]}"
    if ordered == list(range(ordered[0], ordered[-1] + 1)):
        return f"{prefix}_{span}"
    digest = hashlib.md5("-".join(map(str, ordered)).encode()).hexdigest()[:8]
    return f"{prefix}_{span}_{digest}"

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
    # target_share stays NaN on purpose: NaN means "no meaningful share" (e.g. QBs); downstream consumers handle NaN natively.
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

    return _cached(cache_dir, _cache_name("weekly", seasons), load)


def pull_schedules(seasons: list[int], cache_dir: Path | None = None) -> pd.DataFrame:
    def load() -> pd.DataFrame:
        import nflreadpy

        raw = nflreadpy.load_schedules(seasons).to_pandas()
        raw = raw[raw["game_type"] == "REG"]
        keep = ["season", "week", "gameday", "home_team", "away_team"]
        return raw[keep].reset_index(drop=True)

    return normalize_schedule_teams(_cached(cache_dir, _cache_name("schedules", seasons), load))


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
