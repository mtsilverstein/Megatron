"""Frozen outcome builder for the season-end evaluation (spec 2026-09-30 §7.6; final review I5).

    python -m ffmodel.prospective.outcomes --season 2026 --as-of 2027-01-12 --out models/prospective/2026/outcomes_2026.json

Builds `{schema_version: 1, season, as_of, built_at, actual_weeks: {<label>: {<player_id>: {"<week>": points}}}}` for
every format lens in the freeze (`freeze.FORMATS`), weeks 5..17, scored with
`ffmodel.eval.draft_world.weekly_actuals(weekly, season, load_format(label).rules)` -- the predicted-stat scope that
the exporter's worlds use -- and refuses unless every REG game of weeks 5..17 has stat rows for BOTH teams and a final
score in the schedule (so a partial season can never be passed off as the outcome). `as_of` is the stats snapshot date.
This file is part of the hashed pipeline (every src/ffmodel/**/*.py is in the freeze manifest's `code`).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

FIRST_WEEK, LAST_WEEK = 5, 17
SCHEMA_VERSION = 1


class OutcomesError(Exception):
    pass


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
                   load_format=None) -> dict:
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
            "built_at": built_at.astimezone(dt.timezone.utc).isoformat(), "actual_weeks": out}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--as-of", required=True, help="stats snapshot date, YYYY-MM-DD (the evaluator requires 2027-01-12)")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--now", default=None, help="test hook: ISO UTC timestamp replacing the clock")
    a = ap.parse_args(argv)
    try:
        as_of = dt.date.fromisoformat(a.as_of)
        now = dt.datetime.fromisoformat(a.now.replace("Z", "+00:00")) if a.now else dt.datetime.now(dt.timezone.utc)
        if now.date() < as_of:
            raise OutcomesError(f"today {now.date()} is before as_of {as_of}; outcomes are never built early")
        if a.out.exists():
            raise OutcomesError(f"{a.out} exists; the outcome artifact is never overwritten")
        from ffmodel.data.pull import pull_schedules, pull_weekly
        from ffmodel.prospective.freeze import FORMATS
        weekly = pull_weekly([a.season])  # no cache: a fresh pull
        schedule = pull_schedules([a.season])
        res = build_outcomes(weekly, schedule, a.season, FORMATS, a.as_of, now)
    except (OutcomesError, ValueError) as e:
        print(f"OUTCOMES REFUSED: {e}", file=sys.stderr)
        return 1
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(res, indent=1, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
