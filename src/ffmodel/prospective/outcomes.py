"""Frozen outcome capture + builder for the season-end evaluation (spec 2026-09-30 §7.6 incl. the 2026-10-01 amendment).

    python -m ffmodel.prospective.outcomes capture --season 2026 --source-dir models/prospective/2026/outcomes_source
    python -m ffmodel.prospective.outcomes build   --season 2026 --source-dir models/prospective/2026/outcomes_source \
        --out models/prospective/2026/outcomes_2026.json

`capture` downloads the raw nflverse weekly player-stats file (and the REG schedule with final scores) ONCE, writes it
under the source dir with SHA-256s and `as_of` = the UTC capture date. It is allowed only on 2027-01-12, 13 or 14 (UTC)
and only while no capture exists (never overwritten); it also refuses, writing nothing, if the data it just downloaded
is incomplete (so a scheduler retry on the next window day can still capture). `build` NEVER touches the network: it
verifies the committed snapshot's hashes and builds
`{schema_version: 1, season, as_of, snapshot_sha256, schedule_sha256, built_at, actual_weeks: {<label>: {<player_id>: {"<week>": points}}}}`
for every format lens in the freeze (`freeze.FORMATS`), weeks 5..17, scored with
`ffmodel.eval.draft_world.weekly_actuals(weekly, season, load_format(label).rules)` -- the predicted-stat scope that the
exporter's worlds use. `as_of` and `snapshot_sha256` are the SNAPSHOT's, so a late build can never carry a window date
it did not capture; later stat corrections are ignored. This file is hashed with the pipeline (every
src/ffmodel/**/*.py is in the freeze manifest's `code`).
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import sys
from pathlib import Path

FIRST_WEEK, LAST_WEEK = 5, 17
SCHEMA_VERSION = 1
CAPTURE_FILE = "capture.json"
CAPTURE_DAYS = ("12", "13", "14")  # January of season+1, UTC: the scheduled day plus two scheduler retries
STATS_URL = "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.parquet"


class OutcomesError(Exception):
    pass


def capture_window(season: int) -> tuple[str, ...]:
    return tuple(f"{season + 1}-01-{d}" for d in CAPTURE_DAYS)


def stats_name(season: int) -> str:
    return f"stats_player_week_{season}.parquet"


def schedule_name(season: int) -> str:
    return f"schedule_{season}.csv"


def check_complete(schedule, weekly_teams, season: int) -> None:
    """Every REG game of weeks FIRST_WEEK..LAST_WEEK: final score recorded and both teams present in the stats."""
    sch = schedule[(schedule["season"] == season) & (schedule["week"] >= FIRST_WEEK) & (schedule["week"] <= LAST_WEEK)]
    if "game_type" in sch.columns:
        sch = sch[sch["game_type"] == "REG"]
    if sch.empty:
        raise OutcomesError(f"schedule has no REG games for {season} weeks {FIRST_WEEK}-{LAST_WEEK}")
    weeks = {int(w) for w in sch["week"]}
    if weeks != set(range(FIRST_WEEK, LAST_WEEK + 1)):
        raise OutcomesError(f"schedule lacks weeks {sorted(set(range(FIRST_WEEK, LAST_WEEK + 1)) - weeks)}")
    for col in ("home_score", "away_score"):
        if col in sch.columns and sch[col].isna().any():
            raise OutcomesError(f"{int(sch[col].isna().sum())} games of weeks {FIRST_WEEK}-{LAST_WEEK} have no final {col}")
    have = {(int(w), t) for w, t in zip(weekly_teams["week"], weekly_teams["team"])}
    missing = sorted({(int(g["week"]), g[side]) for _, g in sch.iterrows()
                      for side in ("home_team", "away_team") if (int(g["week"]), g[side]) not in have})
    if missing:
        raise OutcomesError(f"weekly stats missing {len(missing)} team-weeks of {FIRST_WEEK}-{LAST_WEEK}, e.g. {missing[:6]}")


def build_outcomes(weekly, schedule, season: int, labels, as_of: str, built_at: dt.datetime, *,
                   snapshot_sha256: str, schedule_sha256: str | None = None, load_format=None) -> dict:
    """`weekly`: normalized weekly stats (needs season, week, team, player_id, position, stat columns).
    `schedule`: REG schedule incl. home_score/away_score. Raises OutcomesError on any incompleteness."""
    from ffmodel.eval.draft_world import _weeks_by_player, weekly_actuals
    if load_format is None:
        from ffmodel.formats import load_format
    rows = weekly[weekly["season"] == season]
    check_complete(schedule, rows[["week", "team"]].drop_duplicates(), season)
    window = rows[(rows["week"] >= FIRST_WEEK) & (rows["week"] <= LAST_WEEK)]
    out = {}
    for label in labels:
        out[label] = _weeks_by_player(weekly_actuals(window, season, load_format(label).rules))
    return {"schema_version": SCHEMA_VERSION, "season": season, "as_of": as_of,
            "snapshot_sha256": snapshot_sha256, "schedule_sha256": schedule_sha256,
            "built_at": built_at.astimezone(dt.timezone.utc).isoformat(), "actual_weeks": out}


def _sha(p: Path) -> str:
    from ffmodel.prospective.freeze import sha256_file
    return sha256_file(p)


def _download(url: str) -> bytes:
    import urllib.request
    last = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - surfaced as OutcomesError below
            last = e
    raise OutcomesError(f"download of {url} failed: {last}")


def _fetch_schedule(season: int):
    from ffmodel.data.pull import pull_schedules
    return pull_schedules([season])  # no cache: a fresh pull, captured below


def capture(season: int, source_dir: Path, now: dt.datetime, *, fetch_stats=None, fetch_schedule=None) -> dict:
    """Download once and write the snapshot. Refuses outside the window, when a capture exists, or when incomplete."""
    import pandas as pd
    today = now.astimezone(dt.timezone.utc).date().isoformat()
    window = capture_window(season)
    if today not in window:
        raise OutcomesError(f"capture is only allowed on {', '.join(window)} (UTC); today is {today}")
    source_dir = Path(source_dir)
    if (source_dir / CAPTURE_FILE).exists() or (source_dir / stats_name(season)).exists():
        raise OutcomesError(f"a capture already exists in {source_dir}; it is never overwritten")
    raw = (fetch_stats or (lambda: _download(STATS_URL.format(season=season))))()
    schedule = (fetch_schedule or (lambda: _fetch_schedule(season)))()
    from ffmodel.data.pull import normalize_weekly
    weekly = normalize_weekly(pd.read_parquet(io.BytesIO(raw)))
    rows = weekly[weekly["season"] == season]
    check_complete(schedule, rows[["week", "team"]].drop_duplicates(), season)  # incomplete -> write nothing
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / stats_name(season)).write_bytes(raw)
    schedule.to_csv(source_dir / schedule_name(season), index=False, lineterminator="\n")
    cap = {"schema_version": 1, "season": season, "as_of": today,
           "captured_at": now.astimezone(dt.timezone.utc).isoformat(), "source_url": STATS_URL.format(season=season),
           "stats_file": stats_name(season), "stats_sha256": _sha(source_dir / stats_name(season)),
           "schedule_file": schedule_name(season), "schedule_sha256": _sha(source_dir / schedule_name(season))}
    (source_dir / CAPTURE_FILE).write_text(json.dumps(cap, indent=1, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    return cap


def build_from_snapshot(season: int, source_dir: Path, built_at: dt.datetime, labels=None, *, load_format=None) -> dict:
    """Build the outcome artifact ONLY from the committed snapshot (hashes verified). Never downloads."""
    import pandas as pd
    source_dir = Path(source_dir)
    cp = source_dir / CAPTURE_FILE
    if not cp.is_file():
        raise OutcomesError(f"no committed capture at {cp}: no snapshot was acquired in the "
                            f"{', '.join(capture_window(season))} window, so the test is not evaluated; nothing is backdated")
    cap = json.loads(cp.read_text(encoding="utf-8"))
    if cap.get("season") != season or cap.get("as_of") not in capture_window(season):
        raise OutcomesError(f"{cp}: season/as_of {cap.get('season')}/{cap.get('as_of')} is not a valid capture for {season}")
    for key, name_key in (("stats_sha256", "stats_file"), ("schedule_sha256", "schedule_file")):
        f = source_dir / str(cap.get(name_key, ""))
        if not f.is_file() or _sha(f) != cap.get(key):
            raise OutcomesError(f"{cp}: {cap.get(name_key)} is missing or does not match its recorded {key}")
    from ffmodel.data.pull import normalize_weekly
    weekly = normalize_weekly(pd.read_parquet(source_dir / cap["stats_file"]))
    schedule = pd.read_csv(source_dir / cap["schedule_file"])
    if labels is None:
        from ffmodel.prospective.freeze import FORMATS as labels
    return build_outcomes(weekly, schedule, season, labels, cap["as_of"], built_at,
                          snapshot_sha256=cap["stats_sha256"], schedule_sha256=cap["schedule_sha256"],
                          load_format=load_format)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("capture", "build"):
        p = sub.add_parser(name)
        p.add_argument("--season", type=int, required=True)
        p.add_argument("--source-dir", type=Path, required=True, help="the committed outcomes_source directory")
        p.add_argument("--now", default=None, help="test hook: ISO UTC timestamp replacing the clock")
        if name == "build":
            p.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    try:
        now = dt.datetime.fromisoformat(a.now.replace("Z", "+00:00")) if a.now else dt.datetime.now(dt.timezone.utc)
        if now.tzinfo is None:
            raise OutcomesError("--now needs a timezone")
        if a.cmd == "capture":
            cap = capture(a.season, a.source_dir, now)
            print(f"captured {a.source_dir} as_of {cap['as_of']} (stats sha256 {cap['stats_sha256']})")
            return 0
        if a.out.exists():
            raise OutcomesError(f"{a.out} exists; the outcome artifact is never overwritten")
        res = build_from_snapshot(a.season, a.source_dir, now)
    except (OutcomesError, ValueError) as e:
        print(f"OUTCOMES REFUSED: {e}", file=sys.stderr)
        return 1
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(res, indent=1, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
