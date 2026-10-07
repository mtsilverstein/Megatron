"""Market snapshot collector: raw third-party snapshots into the PRIVATE data repo.

Run after each site publication. For the week the site just published, saves:
  - Sleeper's QB/RB/WR/TE projections (source: Rotowire via Sleeper), and
  - nflverse game lines (spread/total/moneylines/odds) from load_schedules,
as gzipped raw bytes plus one manifest line each. Contract: weekly-accuracy spec section 4.8.1.

Nothing here writes into the public repo: every write goes under --dest (the private checkout).
Captures are append-only; an existing capture path is an error, never an overwrite.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SLEEPER_URL = ("https://api.sleeper.app/projections/nfl/{season}/{week}?season_type=regular"
               "&position%5B%5D=QB&position%5B%5D=RB&position%5B%5D=WR&position%5B%5D=TE")
USER_AGENT = "megatron-market-snapshots (github.com/mtsilverstein/Megatron)"


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


def write_capture(dest: Path, kind: str, season: int, week: int, retrieved_at: datetime,
                  raw: bytes, meta: dict) -> dict:
    """Write one gzipped capture and append its manifest line. Never overwrites."""
    rel = Path(kind) / str(season) / f"w{week:02d}" / f"{utc_stamp(retrieved_at)}.json.gz"
    path = Path(dest) / rel
    if path.exists():
        raise FileExistsError(f"capture already exists: {rel.as_posix()}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(path, "wb", mtime=0) as f:
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

    for f in failures:
        print(f"::warning::snapshot failed - {f}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
