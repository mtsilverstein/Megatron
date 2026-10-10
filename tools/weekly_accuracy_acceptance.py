"""Spec §7.5 offline acceptance checks on the real local caches. Prints PASS/FAIL lines; exit code 1 on any FAIL.

1. unknown_team_codes == 0 for every 2020-25 nflverse weekly scrape (team mapping, spec §3.4).
2. §4.1: 2026 weeks 1-4 select b451562 / fa9c095 / fbd66fd / d43adc4 with the documented push times.
3. §4.3: weeks 1-3 have no qualifying archive; week 4 selects ...5aec56b70c3784e6 with ...220d00155877a0a7 listed.

Offline by construction (astra P7): every input is an explicit, existing file path, read directly, and the run sets
FFMODEL_CACHE_FROZEN=1 so any cache access that slipped in raises instead of downloading.

Usage:
  .venv/Scripts/python.exe tools/weekly_accuracy_acceptance.py \
      --rankings data/raw/ff_rankings_all_raw.parquet --schedules data/raw/schedules_v3_2012_2026.parquet
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import pandas as pd

from ffmodel.data.pull import normalize_schedule_teams
from ffmodel.eval import live_accuracy as la
from ffmodel.eval import sameweek as sw
from ffmodel.eval.weekly_rankings import normalize_weekly_rankings

EXPECTED_PUBLICATIONS = {1: ("b451562", "2026-09-02T09:45:11Z"), 2: ("fa9c095", "2026-09-16T20:15:31Z"),
                         3: ("fbd66fd", "2026-09-23T20:33:45Z"), 4: ("d43adc4", "2026-09-30T21:32:42Z")}
EXPECTED_ARCHIVE_W4 = ("2026-w04-2026-09-30-5aec56b70c3784e6.json", "2026-w04-2026-09-30-220d00155877a0a7.json")


def _existing(path) -> Path:
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"acceptance reads only existing cache files; missing: {p}")
    return p


def load_schedules(path) -> pd.DataFrame:
    return normalize_schedule_teams(pd.read_parquet(_existing(path)))


def team_code_failures(rankings_path, schedules_path) -> list[tuple[str, int]]:
    r = normalize_weekly_rankings(pd.read_parquet(_existing(rankings_path)))
    sched = load_schedules(schedules_path)
    d = r["scrape_date"]
    r = r.assign(_season=d.dt.year.where(d.dt.month >= 3, d.dt.year - 1))
    bad = []
    for date, snap in r[r["_season"].between(2020, 2025)].groupby("scrape_date"):
        teams = sw.season_teams(sched, int(snap["_season"].iloc[0]))
        mapped = snap.loc[snap["pos"].isin(sw.POSITIONS), "team"].map(sw.map_team)
        n = int((mapped.notna() & ~mapped.isin(teams)).sum())
        if n:
            bad.append((str(date.date()), n))
    return bad


def selection_lines(schedules_path, ledger_path, git, main_ref: str) -> list[tuple[bool, str]]:
    sc = sw.validate_schedule(load_schedules(schedules_path))
    dates = sc.dates(2026)
    ledger = la.load_ledger(_existing(ledger_path))
    main_sha = git.rev_parse(main_ref)
    index = la.candidate_index(ledger, git, 2026, main_sha)
    out = []
    for week, (sha, ts) in EXPECTED_PUBLICATIONS.items():
        cutoff = pd.Timestamp(dates[week][0]).tz_localize("UTC")
        res = la.select_publication(ledger, git, 2026, week, cutoff, main_sha, index=index)
        ok = res["status"] == "selected" and res["commit"].startswith(sha) and res["available_by"] == ts
        out.append((ok, f"publication week {week}: {res['status']} {str(res['commit'])[:7]} {res['available_by']}"))
        arc = la.select_archive(ledger, git, 2026, week, cutoff, main_sha)
        if week < 4:
            ok = arc["status"] == "no_archive"
        else:
            ok = (arc["status"] == "selected" and arc["name"] == EXPECTED_ARCHIVE_W4[0]
                  and [a["name"] for a in arc["alternatives"]] == [EXPECTED_ARCHIVE_W4[1]])
        out.append((ok, f"archive week {week}: {arc['status']} {arc['name']} "
                        f"alternatives={[a['name'] for a in arc['alternatives']]}"))
    return out


def main(argv=None, git=None) -> int:
    os.environ["FFMODEL_CACHE_FROZEN"] = "1"
    ap = argparse.ArgumentParser(description="Offline acceptance checks (spec §7.5).")
    ap.add_argument("--rankings", required=True, help="existing ff_rankings_all_raw parquet")
    ap.add_argument("--schedules", required=True, help="existing schedules_v3 parquet covering 2019-2026")
    ap.add_argument("--ledger", default=str(la.LEDGER_PATH))
    ap.add_argument("--main-ref", default="origin/main")
    args = ap.parse_args(argv)
    fails = 0
    bad = team_code_failures(args.rankings, args.schedules)
    print(("PASS" if not bad else "FAIL") + f" unknown_team_codes 2020-25: {bad[:10]}")
    fails += bool(bad)
    for ok, line in selection_lines(args.schedules, args.ledger, git or la.Git("."), args.main_ref):
        print(("PASS " if ok else "FAIL ") + line)
        fails += not ok
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
