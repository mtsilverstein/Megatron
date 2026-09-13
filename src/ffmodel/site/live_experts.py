"""Refresh the optional free weekly ECR reference, never external points.

The mirror omits season/week. Require complete opponent agreement with our
dated kickoff slate rather than stamping an arbitrary week onto the feed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from ffmodel.site.weekly_experts import name_key

PAGES = {"qb": "QB", "ppr-rb": "RB", "ppr-wr": "WR", "ppr-te": "TE"}
MIN_ROWS = {"QB": 20, "RB": 40, "WR": 50, "TE": 20}


def team(value):
    text = "" if pd.isna(value) else str(value).upper().strip()
    return {"LAR": "LA", "JAC": "JAX", "WSH": "WAS"}.get(text, text)


def build_payload(raw, crosswalk, kickoffs, *, now=None):
    now = pd.Timestamp(now or datetime.now(timezone.utc))
    if now.tzinfo is None:
        raise ValueError("timezone-aware retrieval time required")
    required = {"page", "page_pos", "scrape_date", "player_name", "pos",
                "team", "player_opponent_id", "ecr"}
    if not required <= set(raw.columns):
        raise ValueError("weekly mirror schema changed")
    season, week = kickoffs.get("season"), kickoffs.get("week")
    if type(season) is not int or type(week) is not int or not 1 <= week <= 18:
        raise ValueError("invalid kickoff season/week")
    generated = pd.Timestamp(kickoffs["generated_at"])
    if generated.tzinfo is None or not pd.Timedelta(0) <= now-generated <= pd.Timedelta(hours=72):
        raise ValueError("kickoff slate stale or future-dated")
    opponents, starts = {}, []
    covered = {team(t) for t in kickoffs["teams"]}
    for game in kickoffs["games"]:
        home, away = team(game["home"]), team(game["away"])
        if home == away or home not in covered or away not in covered or home in opponents or away in opponents:
            raise ValueError("invalid kickoff opponent coverage")
        at = pd.Timestamp(game["kickoff"])
        if at.tzinfo is None:
            raise ValueError("kickoff timezone missing")
        starts.append(at)
        opponents.update({home: away, away: home})
    if len(opponents) < 20:
        raise ValueError("incomplete regular-season slate")
    frame = raw.loc[raw.page.isin(PAGES)].copy()
    if set(frame.page) != set(PAGES):
        raise ValueError("missing PPR positional pages")
    dates = set(frame.scrape_date.astype(str))
    if len(dates) != 1:
        raise ValueError("mixed source snapshot dates")
    captured = pd.Timestamp(next(iter(dates)))
    if captured.tzinfo is not None or captured != captured.normalize():
        raise ValueError("expected date-only mirror provenance")
    captured = captured.tz_localize("UTC")
    if not pd.Timedelta(0) <= now-captured <= pd.Timedelta(hours=72):
        raise ValueError("mirror snapshot stale or future-dated")
    if not min(starts).normalize()-pd.Timedelta(days=7) <= captured <= max(starts).normalize():
        raise ValueError("snapshot date outside kickoff slate window")

    identities = {}
    for row in crosswalk.to_dict("records"):
        if pd.isna(row.get("gsis_id")) or pd.isna(row.get("merge_name")):
            continue
        key = (name_key(row["merge_name"]), row.get("position"))
        identities.setdefault(key, set()).add(str(row["gsis_id"]))
    players, unmatched, seen, observed = [], [], set(), set()
    counts = dict.fromkeys(PAGES.values(), 0)
    for row in frame.to_dict("records"):
        pos = PAGES[row["page"]]
        if row["pos"] != pos or row["page_pos"] != pos:
            raise ValueError("position/page mismatch")
        t, opp = team(row["team"]), team(row["player_opponent_id"])
        if t == "FA" and not opp:
            continue
        if t not in covered or (t in opponents and opp != opponents[t]) or (t not in opponents and opp):
            raise ValueError(f"opponents do not match requested slate: {t}/{opp}")
        if t not in opponents:  # bye players are not weekly comparisons
            continue
        observed.add(t)
        counts[pos] += 1
        rank = float(row["ecr"])
        if not math.isfinite(rank) or rank <= 0:
            raise ValueError("invalid ECR rank")
        name = row["player_name"]
        if not isinstance(name, str) or not name.strip():
            raise ValueError("missing player identity")
        matches = identities.get((name_key(name), pos), set())
        if len(matches) != 1:
            unmatched.append({"name": name, "position": pos,
                              "reason": "ambiguous" if matches else "unmatched"})
            continue
        pid = next(iter(matches))
        if pid in seen:
            raise ValueError("duplicate mapped identity")
        seen.add(pid)
        players.append({"player_id": pid, "name": name, "position": pos, "team": t, "ecr": rank})
    if observed != set(opponents) or any(counts[p] < MIN_ROWS[p] for p in counts):
        raise ValueError("incomplete opponent or positional coverage")
    if len(players) / sum(counts.values()) < .95:
        raise ValueError("weekly identity match rate below 95 percent")
    return {"schema_version": 2, "horizon": "weekly", "rank_scope": "position",
            "season": season, "week": week, "snapshot_at": captured.date().isoformat(),
            "snapshot_precision": "date", "retrieved_at": now.isoformat(),
            "source": "FantasyPros via DynastyProcess/nflverse free weekly mirror",
            "source_url": "https://github.com/dynastyprocess/data/blob/master/files/fp_latest_weekly.csv",
            "period_attribution": "inferred_from_schedule_opponents",
            "scoring_format": "ppr", "players": players,
            "coverage": {"matched": len(players), "unmatched": unmatched, "opponent_teams": len(observed)},
            "provenance_note": "Source does not declare season/week; inferred from complete opponent agreement and bounded date window against kickoff slate. Source date only; not eligible for historical pre-kickoff evaluation."}


def atomic_write(out, encoded):
    pending = out.with_suffix(".tmp")
    try:
        pending.write_text(encoded, encoding="utf-8")
        pending.replace(out)
    finally:
        pending.unlink(missing_ok=True)


def publish(payload, out, archive):
    """Archive rank-only content before atomically replacing the live reference."""
    stable = {k: v for k, v in payload.items() if k != "retrieved_at"}
    encoded = json.dumps(stable, sort_keys=True, indent=2, allow_nan=False)
    digest = hashlib.sha256(encoded.encode()).hexdigest()[:16]
    archive.mkdir(parents=True, exist_ok=True)
    snapshot = archive / f"{payload['season']}-w{payload['week']:02d}-{payload['snapshot_at']}-{digest}.json"
    if not snapshot.exists() or snapshot.read_text(encoding="utf-8") != encoded:
        atomic_write(snapshot, encoded)
    out.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(out, json.dumps(payload, indent=2, allow_nan=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kickoffs", type=Path, default=Path("site/data/kickoffs.json"))
    parser.add_argument("--crosswalk", type=Path, default=Path("data/raw/ff_playerids.parquet"))
    parser.add_argument("--out", type=Path, default=Path("site/data/weekly-ecr.json"))
    parser.add_argument("--archive", type=Path, default=Path("data_snapshots/weekly_ecr"))
    args = parser.parse_args()
    import nflreadpy
    raw = nflreadpy.load_ff_rankings("week").to_pandas()
    payload = build_payload(raw, pd.read_parquet(args.crosswalk), json.loads(args.kickoffs.read_text()))
    publish(payload, args.out, args.archive)
    print(json.dumps(payload["coverage"]))


if __name__ == "__main__":
    main()
