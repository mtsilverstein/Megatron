"""Export anonymous preseason ranks and realized weeks 1–17 stat totals."""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from ffmodel.scoring import PREDICTED_STATS


SKILL_POSITIONS = {"QB", "RB", "WR", "TE"}


def build_pick_curve(
    worlds: dict[int, dict], weekly: pd.DataFrame, *, generated_at: str
) -> dict:
    """Build one anonymous row per player per season, retaining ranked busts.

    Inputs are preseason draft worlds and normalized regular-season weekly
    actuals. Missing weekly stat cells count as zero. World positions identify
    ranked players; otherwise the first alphabetical weekly position is used
    if a player changed positions. Inclusion precedes summing and rounding, so
    nonzero weekly outcomes that cancel still retain their player.
    """
    eligible = weekly.loc[
        weekly["week"].between(1, 17)
        & weekly["position"].isin(SKILL_POSITIONS)
    ]
    seasons = []
    for season, world in sorted(worlds.items()):
        ranked = sorted(
            (p for p in world["players"]
             if p["position"] in SKILL_POSITIONS and p.get("ecr") is not None),
            key=lambda p: (p["ecr"], p["player_id"]),
        )
        actuals = eligible.loc[eligible["season"] == season]
        totals = actuals.groupby("player_id")[PREDICTED_STATS].sum()
        active_ids = set(actuals.loc[
            actuals[PREDICTED_STATS].fillna(0).ne(0).any(axis=1), "player_id"
        ])
        positions = actuals.groupby("player_id")["position"].min()

        def stat_line(player_id):
            if player_id not in totals.index:
                return [0] * len(PREDICTED_STATS)
            return [int(round(value)) for value in totals.loc[player_id]]

        rows = [[rank, p["position"], *stat_line(p["player_id"])]
                for rank, p in enumerate(ranked, start=1)]
        ranked_ids = {p["player_id"] for p in ranked}
        unranked = [[None, positions.loc[player_id], *stat_line(player_id)]
                    for player_id in active_ids - ranked_ids]
        rows.extend(sorted(unranked, key=lambda row: row[1:]))
        seasons.append({"season": season, "players": rows})

    return {
        "kind": "pick_curve",
        "schema_version": 1,
        "generated_at": generated_at,
        "weeks": [1, 17],
        "stat_order": list(PREDICTED_STATS),
        "market_source": "preseason consensus rank (draft worlds)",
        "seasons": seasons,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worlds-dir", type=Path, required=True)
    parser.add_argument("--weekly", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seasons", type=int, nargs="+", default=list(range(2021, 2026)))
    args = parser.parse_args()
    worlds = {
        season: json.loads((args.worlds_dir / f"world_{season}.json").read_text(encoding="utf-8"))
        for season in args.seasons
    }
    payload = build_pick_curve(
        worlds, pd.read_parquet(args.weekly),
        generated_at=datetime.now(timezone.utc).isoformat(),
    )
    encoded = json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(encoded, encoding="utf-8")


if __name__ == "__main__":
    main()
