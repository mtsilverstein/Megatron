"""Publish a bounded, rank-only rest-of-season FantasyPros consensus."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from ffmodel.site.live_experts import atomic_write, team
from ffmodel.site.weekly_experts import name_key


OVERALL_PAGE = "/nfl/rankings/ros-ppr-overall.php"
PAGES = {
    OVERALL_PAGE: ("redraft-overall", "ro"),
    "/nfl/rankings/ros-qb.php": ("redraft-qb", "rp"),
    "/nfl/rankings/ros-ppr-rb.php": ("redraft-rb", "rp"),
    "/nfl/rankings/ros-ppr-wr.php": ("redraft-wr", "rp"),
    "/nfl/rankings/ros-ppr-te.php": ("redraft-te", "rp"),
}
SKILL_POSITIONS = {"QB", "RB", "WR", "TE"}
MIN_PAGE_ROWS = {"QB": 20, "RB": 40, "WR": 50, "TE": 20}
MIN_OVERALL_ROWS = {"QB": 10, "RB": 35, "WR": 45, "TE": 12}
MAX_AGE = pd.Timedelta(days=7)


def _fp_key(value):
    if pd.isna(value):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return str(int(number)) if math.isfinite(number) and number.is_integer() else None


def build_payload(raw, crosswalk, *, now=None):
    """Validate the latest explicit PPR ROS board and attach stable GSIS ids."""
    now = pd.Timestamp(now or datetime.now(timezone.utc))
    if now.tzinfo is None:
        raise ValueError("timezone-aware retrieval time required")
    now = now.tz_convert("UTC")
    required = {"fp_page", "page_type", "ecr_type", "scrape_date", "player",
                "id", "pos", "team", "ecr"}
    if not required <= set(raw.columns):
        raise ValueError("rankings mirror schema changed")

    dates = pd.to_datetime(raw.loc[raw.fp_page.eq(OVERALL_PAGE), "scrape_date"], errors="coerce")
    if dates.empty or dates.isna().any():
        raise ValueError("missing dated ROS PPR overall page")
    captured = dates.max()
    if captured.tzinfo is not None or captured != captured.normalize():
        raise ValueError("expected date-only mirror provenance")
    captured = captured.tz_localize("UTC")
    age = now - captured
    if age < pd.Timedelta(0):
        raise ValueError("ROS snapshot is future-dated")
    if age > MAX_AGE:
        raise ValueError("ROS snapshot is stale")

    frame = raw.loc[pd.to_datetime(raw.scrape_date, errors="coerce").eq(captured.tz_localize(None))
                    & raw.fp_page.isin(PAGES)].copy()
    found = set(frame.fp_page)
    if found != set(PAGES):
        raise ValueError("latest ROS snapshot is missing exact required pages")
    for page, (page_type, ecr_type) in PAGES.items():
        rows = frame[frame.fp_page.eq(page)]
        if set(rows.page_type) != {page_type} or set(rows.ecr_type) != {ecr_type}:
            raise ValueError(f"ROS page classification changed: {page}")
        ranks = pd.to_numeric(rows.ecr, errors="coerce")
        if ranks.isna().any() or (~ranks.map(math.isfinite)).any() or (ranks <= 0).any():
            raise ValueError("invalid ROS rank")
    for pos, minimum in MIN_PAGE_ROWS.items():
        page = next(p for p in PAGES if p.endswith(f"ros-{pos.lower()}.php") or
                    p.endswith(f"ros-ppr-{pos.lower()}.php"))
        if len(frame[frame.fp_page.eq(page)]) < minimum:
            raise ValueError(f"inadequate {pos} ROS coverage")

    by_id, by_name_pos = {}, {}
    for row in crosswalk.to_dict("records"):
        if pd.isna(row.get("gsis_id")):
            continue
        gsis, pos = str(row["gsis_id"]), row.get("position")
        fp_id = _fp_key(row.get("fantasypros_id"))
        if fp_id:
            by_id.setdefault((fp_id, pos), set()).add(gsis)
        if not pd.isna(row.get("merge_name")):
            by_name_pos.setdefault((name_key(row["merge_name"]), pos), set()).add(gsis)

    board = frame[frame.fp_page.eq(OVERALL_PAGE)].copy()
    board["_rank"] = pd.to_numeric(board.ecr)
    if board._rank.nunique() < 2:
        raise ValueError("invalid overall ROS ordering")
    overall_counts = board[board.pos.isin(SKILL_POSITIONS)].pos.value_counts()
    if sum(overall_counts.values) < 150 or any(overall_counts.get(pos, 0) < minimum
                                               for pos, minimum in MIN_OVERALL_ROWS.items()):
        raise ValueError("inadequate overall skill-position coverage")
    players, unmatched, seen = [], [], set()
    for row in board.sort_values("_rank").to_dict("records"):
        pos = str(row["pos"]).upper().strip()
        if pos not in SKILL_POSITIONS:
            continue
        name = row["player"]
        if not isinstance(name, str) or not name.strip():
            raise ValueError("missing player identity")
        id_matches = by_id.get((_fp_key(row["id"]), pos), set())
        name_matches = by_name_pos.get((name_key(name), pos), set())
        if id_matches and name_matches and id_matches.isdisjoint(name_matches):
            raise ValueError(f"FantasyPros id/name identity disagreement: {name}")
        matches = id_matches if len(id_matches) == 1 else name_matches
        if len(matches) != 1:
            unmatched.append({"name": name, "position": pos, "ros_rank": row["_rank"],
                              "reason": "ambiguous" if matches else "unmatched"})
            continue
        player_id = next(iter(matches))
        if player_id in seen:
            raise ValueError("duplicate mapped identity")
        seen.add(player_id)
        players.append({"player_id": player_id, "name": name, "position": pos,
                        "team": team(row["team"]), "ros_rank": float(row["_rank"])})

    top = board[board._rank <= 180]
    top_skill = top[top.pos.isin(SKILL_POSITIONS)]
    matched_top = sum(p["ros_rank"] <= 180 for p in players)
    if top_skill.empty or matched_top / len(top_skill) < .95:
        raise ValueError("top-180 ROS identity match rate below 95 percent")
    season = captured.year - 1 if captured.month == 1 else captured.year
    return {
        "schema_version": 1, "horizon": "ros", "rank_scope": "overall",
        "scoring_format": "ppr", "season": season,
        "snapshot_at": captured.date().isoformat(), "snapshot_precision": "date",
        "retrieved_at": now.isoformat(),
        "source": "FantasyPros via nflverse free rankings mirror",
        "source_url": "https://www.fantasypros.com/nfl/rankings/ros-ppr-overall.php",
        "players": players,
        "coverage": {"source_rows": len(frame), "overall_skill_rows": len(board[board.pos.isin(SKILL_POSITIONS)]),
                     "matched": len(players), "top_180_matched": matched_top,
                     "top_180_total": len(top_skill), "unmatched": unmatched},
        "provenance_note": "Latest explicit FantasyPros PPR rest-of-season overall page; positional pages validate source completeness. Snapshot is date-only. Season equals snapshot year, except January snapshots belong to the previous season.",
    }


def publish(payload, out, archive):
    stable = {key: value for key, value in payload.items() if key != "retrieved_at"}
    encoded = json.dumps(stable, sort_keys=True, indent=2, allow_nan=False)
    digest = hashlib.sha256(encoded.encode()).hexdigest()[:16]
    archive.mkdir(parents=True, exist_ok=True)
    snapshot = archive / f"{payload['snapshot_at']}-{digest}.json"
    if not snapshot.exists() or snapshot.read_text(encoding="utf-8") != encoded:
        atomic_write(snapshot, encoded)
    out.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(out, json.dumps(payload, indent=2, allow_nan=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--crosswalk", type=Path, default=Path("data/raw/ff_playerids.parquet"))
    parser.add_argument("--out", type=Path, default=Path("site/data/ros-ecr.json"))
    parser.add_argument("--archive", type=Path, default=Path("data_snapshots/ros_ecr"))
    args = parser.parse_args()
    import nflreadpy
    payload = build_payload(nflreadpy.load_ff_rankings("all").to_pandas(),
                            pd.read_parquet(args.crosswalk))
    publish(payload, args.out, args.archive)
    print(json.dumps(payload["coverage"]))


if __name__ == "__main__":
    main()
