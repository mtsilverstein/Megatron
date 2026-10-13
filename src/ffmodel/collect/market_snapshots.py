"""Market snapshot collector: raw third-party snapshots into the PRIVATE data repo.

Run after each site publication. For the week the site just published, saves:
  - Sleeper's QB/RB/WR/TE projections (source: Rotowire via Sleeper),
  - nflverse game lines (spread/total/moneylines/odds) from load_schedules, and
  - SharpAPI full-game offensive player props (free tier: DraftKings and FanDuel, 60 s delayed) for every game that
    kicks off within the next 72 hours, one file per game,
as gzipped raw bytes plus one manifest line each. Contract: weekly-accuracy spec section 4.8.1. Props are an archive
only: no model uses them without its own pre-registered test.

Nothing here writes into the public repo: every write goes under --dest (the private checkout).
Captures are append-only; an existing capture path is an error, never an overwrite.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

SLEEPER_URL = ("https://api.sleeper.app/projections/nfl/{season}/{week}?season_type=regular"
               "&position%5B%5D=QB&position%5B%5D=RB&position%5B%5D=WR&position%5B%5D=TE")
USER_AGENT = "megatron-market-snapshots (github.com/mtsilverstein/Megatron)"

SHARP_BASE = "https://api.sharpapi.io/api/v1"
# Full-game (market_segment null) offensive player props; quarter/half, defensive and novelty markets are dropped.
PROPS_MARKETS = frozenset({
    "player_passing_yards", "player_passing_touchdowns", "player_passing_attempts", "player_passing_completions",
    "player_interceptions", "player_rushing_yards", "player_rushing_attempts", "player_receiving_yards",
    "player_receptions", "player_rushing_+_receiving_yards", "anytime_touchdown_scorer"})
PROPS_BOOKS = frozenset({"draftkings", "fanduel"})   # the free tier's books
PROPS_WINDOW_HOURS = 72
PROPS_MIN_INTERVAL = 6.5                             # seconds between requests: <= ~9/min, under the free 12/min
PROPS_MAX_EVENT_PAGES = 10
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def utc_iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_stamp(t: datetime) -> str:
    """Filename-safe UTC stamp (no colons)."""
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")


def _iso_ms(ms: int) -> str:
    t = datetime.fromtimestamp(ms / 1000, timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def published_target(weekly_path: Path) -> dict:
    """Season, week and batch id of the published neutral weekly payload."""
    d = json.loads(Path(weekly_path).read_text(encoding="utf-8"))
    season, week, batch = d.get("season"), d.get("week"), d.get("batch_id")
    if not isinstance(season, int) or not isinstance(week, int) or not 1 <= week <= 22:
        raise ValueError(f"bad season/week in {weekly_path}: {season!r}/{week!r}")
    if not isinstance(batch, str) or not batch:
        raise ValueError(f"missing batch_id in {weekly_path}")
    return {"season": season, "week": week, "batch_id": batch}


def http_get(url: str, timeout: int = 60) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def sleeper_source_times(raw: bytes) -> dict:
    rows = json.loads(raw)
    if not isinstance(rows, list):
        raise ValueError("Sleeper projections response is not a JSON list")
    stamps = [r["updated_at"] for r in rows if isinstance(r, dict) and isinstance(r.get("updated_at"), int)]
    return {"records": len(rows), "source_updated_at_count": len(stamps),
            "source_updated_at_min": _iso_ms(min(stamps)) if stamps else None,
            "source_updated_at_max": _iso_ms(max(stamps)) if stamps else None}


def lines_snapshot(season: int, week: int) -> bytes:
    """Raw nflverse schedule rows (all columns, incl. betting lines) for one REG week, as JSON bytes."""
    import nflreadpy
    df = nflreadpy.load_schedules([season]).to_pandas()
    df = df[(df["week"] == week) & (df["game_type"] == "REG")]
    if df.empty:
        raise ValueError(f"no REG schedule rows for {season} week {week}")
    return df.to_json(orient="records", date_format="iso").encode("utf-8")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _pause(seconds: float) -> None:
    time.sleep(seconds)


def _parse_utc(s: str) -> datetime:
    """Aware UTC datetime from an ISO string; an offset-free timestamp is rejected, never read as local time."""
    t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if t.tzinfo is None:
        raise ValueError(f"timestamp without a UTC offset: {s!r}")
    return t.astimezone(timezone.utc)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Authenticated SharpAPI calls never follow a redirect: the default handler would copy X-API-Key to the new
    location (another host, or plain HTTP). A 3xx surfaces as an HTTPError and is treated as a failed request."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_SHARP_OPENER = urllib.request.build_opener(_NoRedirect)


def sharp_get(path: str, params: dict, key: str, timeout: int = 60) -> tuple[int, bytes]:
    """GET a SharpAPI path. The key travels only in the X-API-Key header, never in the URL, a log line or a
    redirected request."""
    url = SHARP_BASE + path + (f"?{urllib.parse.urlencode(params)}" if params else "")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "X-API-Key": key,
                                               "Accept": "application/json"})
    try:
        with _SHARP_OPENER.open(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read()
        finally:
            e.close()


def select_prop_games(events: list[dict], now: datetime, window_hours: int = PROPS_WINDOW_HOURS) -> list[dict]:
    """Upcoming NFL game fixtures carried by a free book that start in (now, now + window]; one event per game
    (duplicate feeds of the same matchup and kickoff keep the one with the most markets), ordered by kickoff then id."""
    horizon = now + timedelta(hours=window_hours)
    best: dict[tuple, dict] = {}
    for e in events:
        if e.get("event_type") != "fixture" or e.get("status") != "upcoming" or not e.get("away_team"):
            continue
        if not PROPS_BOOKS & set(e.get("books") or []):
            continue
        start = _parse_utc(e["start_time"])
        if not now < start <= horizon:
            continue
        k = (e.get("home_team"), e.get("away_team"), start)
        if k not in best or (e.get("market_count") or 0) > (best[k].get("market_count") or 0):
            best[k] = e
    return sorted(best.values(), key=lambda e: (_parse_utc(e["start_time"]), e["id"]))


def filter_props(raw: bytes) -> tuple[bytes, dict]:
    """Keep the full-game offensive player-prop rows of one /events/{id}/odds response, unmodified. SharpAPI omits
    `market_segment` on full-game rows (verified on live responses, 2026-10-12: 731 of 731 full-game rows had no such
    field); segment rows carry it and also use prefixed market names (`1st_half_...`) that never match PROPS_MARKETS.
    So a row is full-game when the field is absent or null; any non-null segment is dropped. Only free-tier books are
    kept, whatever the account is entitled to."""
    body = json.loads(raw)
    rows = body.get("data") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        raise ValueError("SharpAPI odds response has no data list")
    kept = [r for r in rows if isinstance(r, dict) and r.get("market_type") in PROPS_MARKETS
            and r.get("market_segment") is None and r.get("sportsbook") in PROPS_BOOKS]
    counts = Counter(f"{r['market_type']}|{r['sportsbook']}" for r in kept)
    return (json.dumps(kept, separators=(",", ":")).encode("utf-8"),
            {"rows_total": len(rows), "rows_kept": len(kept), "kept_by_market_book": dict(sorted(counts.items()))})


def list_nfl_events(key: str) -> list[dict]:
    """Every NFL event, following the documented pagination. A malformed envelope is an error, never "no events"."""
    events, offset = [], 0
    for page in range(PROPS_MAX_EVENT_PAGES):
        if page:
            _pause(PROPS_MIN_INTERVAL)
        status, raw = sharp_get("/events", {"league": "nfl", "limit": 200, "offset": offset}, key)
        if status != 200:
            raise RuntimeError(f"events HTTP {status}")
        body = json.loads(raw)
        if not isinstance(body, dict) or not isinstance(body.get("data"), list):
            raise ValueError("events response has no data list")
        pg = body.get("pagination")
        if not isinstance(pg, dict) or not isinstance(pg.get("has_more"), bool):
            raise ValueError("events response has no pagination.has_more")
        events += body["data"]
        if not pg["has_more"]:
            return events
        if type(pg.get("next_offset")) is not int or pg["next_offset"] <= offset:   # bool is an int subclass
            raise ValueError("events pagination.next_offset missing or not advancing")
        offset = pg["next_offset"]
    raise RuntimeError(f"events list exceeded {PROPS_MAX_EVENT_PAGES} pages")


def _batch_record(dest: Path, line: dict) -> None:
    (Path(dest) / "props").mkdir(parents=True, exist_ok=True)
    with (Path(dest) / "props" / "batches.jsonl").open("a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(line, sort_keys=True) + "\n")


def capture_props(dest: Path, season: int, week: int, key: str, common: dict) -> tuple[list[dict], dict]:
    """Capture every selected game; one game's failure never stops the others (a 429 stops the batch). Each run
    appends one batch line to props/batches.jsonl naming the selected, captured, skipped, failed and unattempted
    games, so an incomplete batch is identifiable from the archive itself."""
    started = _now()
    batch = {"batch_started_at": utc_iso(started), "season": season, "week": week, "window_hours": PROPS_WINDOW_HOURS,
             "selected": [], "captured": [], "skipped_started": [], "failed": {}, "not_attempted": [], **common}
    lines: list[dict] = []
    try:
        games = select_prop_games(list_nfl_events(key), started)
    except Exception as e:
        batch.update(status="events_failed", error=str(e).replace(key, "***"))
        _batch_record(dest, batch)
        raise
    batch["selected"] = [g["id"] for g in games]
    for i, g in enumerate(games):
        _pause(PROPS_MIN_INTERVAL)
        if _parse_utc(g["start_time"]) <= _now():          # kicked off while queued: never request a started game
            batch["skipped_started"].append(g["id"])
            continue
        path = f"/events/{g['id']}/odds"
        retrieved_at = _now()
        try:
            status, raw = sharp_get(path, {}, key)
            if status != 200:
                raise RuntimeError(f"HTTP {status}")
            kept, counts = filter_props(raw)
            meta = {"source": "sharpapi.io", "request_url": SHARP_BASE + path, "http_status": status,
                    "event_id": g["id"], "start_time": g["start_time"], "home_team": g.get("home_team"),
                    "away_team": g.get("away_team"), "window_hours": PROPS_WINDOW_HOURS,
                    "response_sha256": hashlib.sha256(raw).hexdigest(), **counts, **common}
            lines.append(write_capture(dest, "props", season, week, retrieved_at, kept, meta, name=g["id"]))
            batch["captured"].append(g["id"])
        except Exception as e:
            batch["failed"][g["id"]] = str(e).replace(key, "***")
            if "HTTP 429" in str(e):                         # rate-limited: stop rather than hammer the API
                batch["not_attempted"] = [x["id"] for x in games[i + 1:]]
                break
    batch["status"] = "complete" if not batch["failed"] and not batch["not_attempted"] else "incomplete"
    _batch_record(dest, batch)
    return lines, batch


def write_capture(dest: Path, kind: str, season: int, week: int, retrieved_at: datetime,
                  raw: bytes, meta: dict, name: str | None = None) -> dict:
    """Write one gzipped capture and append its manifest line. Never overwrites (exclusive create)."""
    if name is not None and (not _SAFE_NAME.match(name) or ".." in name):
        raise ValueError(f"unsafe capture name: {name!r}")
    stem = utc_stamp(retrieved_at) + (f"_{name}" if name else "")
    rel = Path(kind) / str(season) / f"w{week:02d}" / f"{stem}.json.gz"
    path = Path(dest) / rel
    if path.exists():
        raise FileExistsError(f"capture already exists: {rel.as_posix()}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "xb") as fh, gzip.GzipFile(filename=str(path), fileobj=fh, mode="wb", mtime=0) as f:
        f.write(raw)
    line = {"retrieved_at": utc_iso(retrieved_at), "sha256": hashlib.sha256(raw).hexdigest(),
            "season": season, "week": week, "path": rel.as_posix(), **meta}
    with (Path(dest) / kind / "manifest.jsonl").open("a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(line, sort_keys=True) + "\n")
    return line


def _git_head() -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dest", type=Path, required=True, help="private data repo checkout")
    ap.add_argument("--weekly", type=Path, default=Path("site/data/neutral/weekly.json"))
    ap.add_argument("--published-commit", default=None, help="default: git rev-parse HEAD")
    ap.add_argument("--capture-kind", choices=["scheduled", "manual"], default="scheduled")
    args = ap.parse_args(argv)

    target = published_target(args.weekly)
    season, week = target["season"], target["week"]
    common = {"published_commit": args.published_commit or _git_head(),
              "published_batch_id": target["batch_id"], "capture_kind": args.capture_kind}
    failures: list[str] = []

    url = SLEEPER_URL.format(season=season, week=week)
    try:
        retrieved_at = datetime.now(timezone.utc)
        status, raw = http_get(url)
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        meta = {"request_url": url, "http_status": status, **sleeper_source_times(raw), **common}
        line = write_capture(args.dest, "sleeper", season, week, retrieved_at, raw, meta)
        print(f"sleeper: {line['path']} ({line['records']} records)")
    except Exception as e:  # each source is independent; report and continue
        failures.append(f"sleeper: {e}")

    try:
        retrieved_at = datetime.now(timezone.utc)
        raw = lines_snapshot(season, week)
        import nflreadpy
        meta = {"source": "nflreadpy.load_schedules", "nflreadpy_version": getattr(nflreadpy, "__version__", None),
                "games": len(json.loads(raw)), **common}
        line = write_capture(args.dest, "lines", season, week, retrieved_at, raw, meta)
        print(f"lines: {line['path']} ({line['games']} games)")
    except Exception as e:
        failures.append(f"lines: {e}")

    key = os.environ.get("SHARPAPI_KEY")
    if not key:
        print("props: SHARPAPI_KEY is not set; skipping props")
    else:
        try:
            lines, batch = capture_props(args.dest, season, week, key, common)
            print(f"props: {len(lines)} of {len(batch['selected'])} games captured, "
                  f"{sum(x['rows_kept'] for x in lines)} rows kept ({batch['status']})")
            if batch["status"] != "complete":
                failures.append(f"props: incomplete batch (failed {sorted(batch['failed'])}, "
                                f"not attempted {batch['not_attempted']})")
        except Exception as e:
            failures.append(f"props: {str(e).replace(key, '***')}")

    for f in failures:
        print(f"::warning::snapshot failed - {f}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
