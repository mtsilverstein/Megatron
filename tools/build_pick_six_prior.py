"""Build an audited empirical pick-six rate from nflverse play-by-play.

The player-stats feed used by Megatron does not carry observed pick-sixes.
This script deliberately uses the completed-season play-by-play release instead
and records the exact input URL and SHA-256 for every season in the snapshot.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import urllib.request
from pathlib import Path

import pandas as pd


DEFAULT_SEASONS = tuple(range(2021, 2026))
URL_TEMPLATE = (
    "https://github.com/nflverse/nflverse-data/releases/download/pbp/"
    "play_by_play_{season}.parquet"
)
READ_COLUMNS = [
    "season",
    "season_type",
    "game_id",
    "play_id",
    "interception",
    "return_touchdown",
    "two_point_attempt",
    "passer_player_id",
    "interception_player_id",
    "td_team",
    "defteam",
]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    request = urllib.request.Request(url, headers={"User-Agent": "Megatron-data-build"})
    try:
        with urllib.request.urlopen(request) as response, tmp.open("wb") as target:
            while chunk := response.read(1024 * 1024):
                target.write(chunk)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def _season_counts(path: Path, season: int) -> tuple[int, int]:
    frame = pd.read_parquet(path, columns=READ_COLUMNS)
    observed_seasons = {int(value) for value in frame["season"].dropna().unique()}
    if observed_seasons != {season}:
        raise ValueError(f"{path} contains seasons {sorted(observed_seasons)}, expected {season}")

    # A denominator event must be a credited regular-season interception with
    # both passer and interceptor identities. Exclude conversion attempts: they
    # do not count as a passing interception in ordinary player statistics.
    interceptions = frame[
        (frame["season_type"] == "REG")
        & (frame["interception"] == 1)
        & frame["passer_player_id"].notna()
        & frame["interception_player_id"].notna()
        & (frame["two_point_attempt"].fillna(0) != 1)
    ]
    duplicate_events = interceptions.duplicated(["game_id", "play_id"], keep=False)
    if duplicate_events.any():
        duplicates = sorted(
            f"{game_id}/{play_id:g}"
            for game_id, play_id in interceptions.loc[
                duplicate_events, ["game_id", "play_id"]
            ].drop_duplicates().itertuples(index=False, name=None)
        )
        raise ValueError(
            f"{path} contains duplicate credited interception event(s): "
            + ", ".join(duplicates)
        )

    # return_touchdown alone is insufficient. For example, an interception can
    # be fumbled and recovered by the offense for a touchdown. Requiring the TD
    # team to be the defense makes this specifically a defensive INT-return TD.
    pick_sixes = interceptions[
        (interceptions["return_touchdown"] == 1)
        & (interceptions["td_team"] == interceptions["defteam"])
    ]
    return len(interceptions), len(pick_sixes)


def build_snapshot(seasons: list[int], cache_dir: Path) -> dict:
    rows = []
    total_interceptions = 0
    total_pick_sixes = 0
    for season in seasons:
        url = URL_TEMPLATE.format(season=season)
        path = cache_dir / f"play_by_play_{season}.parquet"
        if not path.exists():
            _download(url, path)
        interceptions, pick_sixes = _season_counts(path, season)
        total_interceptions += interceptions
        total_pick_sixes += pick_sixes
        rows.append(
            {
                "season": season,
                "interceptions": interceptions,
                "pick_sixes": pick_sixes,
                "url": url,
                "sha256": _sha256(path),
            }
        )

    return {
        "source": "nflverse play-by-play release",
        "method": (
            "Pooled P(pick-six | credited passing interception) over completed "
            "regular seasons. Denominator: season_type=REG, interception=1, "
            "passer_player_id and interception_player_id present, and "
            "two_point_attempt!=1. Numerator additionally requires "
            "return_touchdown=1 and td_team=defteam."
        ),
        "seasons": rows,
        "interceptions": total_interceptions,
        "pick_sixes": total_pick_sixes,
        "rate": total_pick_sixes / total_interceptions,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seasons", nargs="+", type=int, default=DEFAULT_SEASONS)
    parser.add_argument("--cache-dir", type=Path, default=Path(".review/pick-six-pbp"))
    parser.add_argument(
        "--output", type=Path, default=Path("data_snapshots/pick_six_rates.json")
    )
    args = parser.parse_args()

    snapshot = build_snapshot(sorted(set(args.seasons)), args.cache_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(snapshot, indent=2) + "\n"
    tmp = args.output.with_suffix(args.output.suffix + ".tmp")
    try:
        tmp.write_text(rendered, encoding="utf-8")
        os.replace(tmp, args.output)
    finally:
        if tmp.exists():
            tmp.unlink()
    print(
        f"{snapshot['pick_sixes']} pick-sixes / "
        f"{snapshot['interceptions']} interceptions = {snapshot['rate']:.6f}"
    )


if __name__ == "__main__":
    main()
