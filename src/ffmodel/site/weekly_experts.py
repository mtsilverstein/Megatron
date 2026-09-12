"""Import dated positional FantasyPros exports without guessing scoring or IDs."""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
from datetime import date
from pathlib import Path

import pandas as pd
from ffmodel.data.adp import norm


def name_key(value):
    return norm(value)


def build_payload(paths, crosswalk, *, scoring_format):
    if scoring_format not in {"ppr", "half_ppr", "standard"}:
        raise ValueError("explicit source scoring format required")
    # Exact normalized name AND position only. Ambiguity is never first-match.
    identities = {}
    for row in crosswalk.to_dict("records"):
        if pd.isna(row.get("gsis_id")) or pd.isna(row.get("merge_name")):
            continue
        key = (name_key(row["merge_name"]), row.get("position"))
        identities.setdefault(key, set()).add(str(row["gsis_id"]))
    players, unmatched, seen, periods, files = [], [], set(), set(), []
    for path in paths:
        path = Path(path)
        match = re.fullmatch(r"FantasyPros_(20\d{2})_Week_(\d{1,2})_(QB|RB|WR|TE)_Rankings_(\d{2})-(\d{2})-(\d{2})\.csv", path.name)
        if not match:
            raise ValueError(f"unrecognized skill-position snapshot filename: {path.name}")
        season, week, pos, month, day, year = match.groups()
        captured = date(2000 + int(year), int(month), int(day))
        if captured.year != int(season) or not 1 <= int(week) <= 18:
            raise ValueError("invalid snapshot season/week")
        periods.add((int(season), int(week), captured.isoformat()))
        files.append(path.name)
        with path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not {"RK", "PLAYER NAME", "TEAM"} <= set(reader.fieldnames or []):
                raise ValueError(f"missing weekly export columns: {path.name}")
            for row in reader:
                if all(value is None or value == "" for value in row.values()):
                    continue  # Export contains quoted empty separator rows.
                if any(row.get(key) is None for key in ["RK", "PLAYER NAME", "TEAM"]):
                    raise ValueError(f"incomplete weekly export row: {path.name}")
                name = row["PLAYER NAME"].strip()
                if not name:
                    raise ValueError("blank player identity")
                rank = float(row["RK"])
                if not math.isfinite(rank) or rank <= 0:
                    raise ValueError(f"invalid expert metric for {name}")
                matches = identities.get((name_key(name), pos), set())
                if len(matches) != 1:
                    unmatched.append({"name": name, "position": pos, "ecr": rank,
                                      "reason": "ambiguous" if matches else "unmatched"})
                    continue
                player_id = next(iter(matches))
                if player_id in seen:
                    raise ValueError(f"duplicate mapped player: {name}")
                seen.add(player_id)
                players.append({"player_id": player_id, "name": name, "position": pos,
                                "team": row["TEAM"].strip(), "ecr": rank})
    if len(periods) != 1 or not players:
        raise ValueError("need nonempty snapshots with one common season/week/date")
    season, week, captured = periods.pop()
    return {"schema_version": 2, "horizon": "weekly", "rank_scope": "position", "season": season, "week": week,
            "snapshot_at": captured, "snapshot_precision": "date",
            "source": "FantasyPros positional CSV exports", "scoring_format": scoring_format,
            "source_files": files, "players": players,
            "coverage": {"matched": len(players), "unmatched": unmatched},
            "provenance_note": "Date from supplied filename; capture time unverified. Not eligible for historical pre-kickoff evaluation."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshots", nargs="+", type=Path)
    parser.add_argument("--crosswalk", type=Path, default=Path("data/raw/ff_playerids.parquet"))
    parser.add_argument("--scoring-format", required=True, choices=["ppr", "half_ppr", "standard"])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    payload = build_payload(args.snapshots, pd.read_parquet(args.crosswalk), scoring_format=args.scoring_format)
    args.out.write_text(json.dumps(payload, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps(payload["coverage"]))


if __name__ == "__main__":
    main()
