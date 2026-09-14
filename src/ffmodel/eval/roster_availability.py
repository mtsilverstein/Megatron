"""Audit historical weekly roster statuses without inferring participation.

This is a source-quality diagnostic.  In particular, ``ACT`` is retained as
an upstream status code; it is not evidence that a player appeared in a game.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Iterable

import pandas as pd

from ffmodel.site.live_experts import atomic_write


POSITIONS = ("QB", "RB", "WR", "TE")
IDENTICAL_KEY = ["season", "week", "gsis_id", "team", "position", "status"]


def _require(frame: pd.DataFrame, columns: set[str], source: str) -> None:
    missing = sorted(columns - set(frame.columns))
    if missing:
        raise ValueError(f"{source} missing columns: {', '.join(missing)}")


def classify_roster_rows(rosters: pd.DataFrame, *,
                         seasons: Iterable[int] | None = None,
                         weeks: Iterable[int] | None = None) -> pd.DataFrame:
    """Return one diagnostic record per player-week after exact deduplication.

    Conflicting non-null player identities are marked ``AMBIGUOUS`` rather
    than resolved by a status priority.  Rows without an id or status are
    ``UNKNOWN``.  Only regular-season QB/RB/WR/TE records are in scope.
    """
    _require(rosters, set(IDENTICAL_KEY) | {"game_type"}, "rosters")
    frame = rosters[rosters["game_type"].eq("REG") &
                    rosters["position"].isin(POSITIONS)].copy()
    if seasons is not None:
        frame = frame[frame["season"].isin(list(seasons))]
    if weeks is not None:
        frame = frame[frame["week"].isin(list(weeks))]

    frame["availability_status"] = frame["status"].astype("string")
    missing_id = frame["gsis_id"].isna() | frame["gsis_id"].astype("string").str.strip().eq("")
    # Without a player identity, neither equality nor conflict can be
    # established safely. Preserve those source rows one-for-one.
    unidentified = frame.loc[missing_id].copy()
    frame = frame.loc[~missing_id].drop_duplicates(IDENTICAL_KEY).copy()
    missing_status = frame["status"].isna() | frame["status"].astype("string").str.strip().eq("")
    frame.loc[missing_status, "availability_status"] = "UNKNOWN"
    unidentified["availability_status"] = "UNKNOWN"

    identity = ["season", "week", "gsis_id"]
    conflicts = (frame.groupby(identity, dropna=False).size().loc[lambda x: x > 1].index)
    conflict_keys = set(conflicts.tolist())
    if conflict_keys:
        ambiguous = frame.apply(
            lambda r: (r["season"], r["week"], r["gsis_id"]) in conflict_keys,
            axis=1,
        )
        frame.loc[ambiguous, "availability_status"] = "AMBIGUOUS"
        # A conflict is one player-week diagnostic, not one record per claim.
        frame = frame.drop_duplicates(identity, keep="first", ignore_index=True)
        # Do not let the arbitrary retained source row masquerade as a
        # resolved team, position, or upstream status.
        frame.loc[frame["availability_status"].eq("AMBIGUOUS"),
                  ["team", "position", "status"]] = pd.NA
    return pd.concat([frame, unidentified], ignore_index=True).sort_values(
        ["season", "week", "gsis_id"], na_position="last", kind="stable"
    ).reset_index(drop=True)


def _counts(frame: pd.DataFrame) -> list[dict]:
    reports = []
    for season, group in frame.groupby("season", sort=True):
        statuses = group["availability_status"].value_counts().sort_index()
        reports.append({
            "season": int(season),
            "records": int(len(group)),
            "statuses": {str(k): int(v) for k, v in statuses.items()},
            "ambiguous_player_weeks": int(group["availability_status"].eq("AMBIGUOUS").sum()),
            "missing_player_id": int((group["gsis_id"].isna() |
                                      group["gsis_id"].astype("string").str.strip().eq("")).sum()),
            "unknown_records": int(group["availability_status"].eq("UNKNOWN").sum()),
        })
    return reports


def _stat_coverage(classified: pd.DataFrame, weekly: pd.DataFrame) -> dict:
    _require(weekly, {"season", "week", "player_id", "position"}, "weekly")
    stats = weekly[weekly["position"].isin(POSITIONS)].copy()
    if "season_type" in stats:
        stats = stats[stats["season_type"].eq("REG")]
    elif "game_type" in stats:
        stats = stats[stats["game_type"].eq("REG")]
    stats = stats.drop_duplicates(["season", "week", "player_id"])
    identified = classified[
        classified["gsis_id"].notna() &
        ~classified["gsis_id"].astype("string").str.strip().eq("")
    ].copy()
    identified["roster_match"] = identified["availability_status"].map(
        lambda value: "ambiguous" if value == "AMBIGUOUS" else "unique"
    )
    roster_keys = identified[["season", "week", "gsis_id", "roster_match"]].rename(
        columns={"gsis_id": "player_id"}
    ).drop_duplicates(["season", "week", "player_id"])
    joined = stats.merge(roster_keys, on=["season", "week", "player_id"], how="left")
    def summarize(group: pd.DataFrame) -> dict:
        unique = int(group["roster_match"].eq("unique").sum())
        ambiguous = int(group["roster_match"].eq("ambiguous").sum())
        total = int(len(group))
        return {"stat_rows": total, "uniquely_matched_roster_row": unique,
                "ambiguous_roster_match": ambiguous,
                "unmatched_roster_row": total - unique - ambiguous,
                "unique_match_rate": unique / total if total else None}
    result = summarize(joined)
    result["by_season"] = [
        {"season": int(season), **summarize(group)}
        for season, group in joined.groupby("season", sort=True)
    ]
    return result


def audit_roster_availability(rosters: pd.DataFrame, weekly: pd.DataFrame | None = None,
                              *, seasons: Iterable[int] | None = None,
                              weeks: Iterable[int] | None = None) -> dict:
    """Build a JSON-safe historical roster-status source audit."""
    classified = classify_roster_rows(rosters, seasons=seasons, weeks=weeks)
    report = {
        "schema_version": 1,
        "diagnostic": "historical_roster_availability_source_audit",
        "advice_eligible": False,
        "source_provenance": {
            "through_2015": "Weekly dataexchange rows receive season-level Shield statuses via player-ID join; not weekly availability truth.",
            "from_2016": "NGS week-specific query, but row capture time and pre-origin availability are unverified.",
            "publication_time": "Release/workflow update time is not row observation time.",
            "sources": ["https://github.com/nflverse/nflverse-rosters/blob/main/R/rosters.R",
                        "https://github.com/nflverse/nflverse-rosters/blob/main/R/rosters_dataexchange.R",
                        "https://github.com/nflverse/nflverse-rosters/blob/main/R/rosters_ngs.R",
                        "https://github.com/nflverse/nflverse-rosters/blob/main/.github/workflows/update_rosters.yaml"],
        },
        "scope": {"game_type": "REG", "positions": list(POSITIONS)},
        "records": int(len(classified)),
        "seasons": _counts(classified),
        "limitations": [
            "Roster status is reported as supplied; ACT is not treated as evidence of participation.",
            "Missing stat rows are not converted to zero production.",
            "Historical source capture timing is unverified, so this audit is not a point-in-time decision input.",
            "Conflicting player-week claims are labeled AMBIGUOUS; no status priority is guessed.",
        ],
    }
    if weekly is not None:
        stats = weekly
        if seasons is not None:
            stats = stats[stats["season"].isin(list(seasons))]
        if weeks is not None:
            stats = stats[stats["week"].isin(list(weeks))]
        report["weekly_stat_coverage"] = _stat_coverage(classified, stats)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rosters", type=Path, required=True)
    parser.add_argument("--weekly", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    rosters = pd.read_parquet(args.rosters)
    weekly = pd.read_parquet(args.weekly) if args.weekly else None
    report = audit_roster_availability(rosters, weekly)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(args.out, json.dumps(report, indent=2, allow_nan=False))
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
