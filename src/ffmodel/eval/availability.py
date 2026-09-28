"""Absence rates for the roster simulation (spec 2026-09-24 §4, plan refinements 2-3).

established = a regular-season stat row earlier that season AND rostered on that team
that week with status ACT/RES/INA. missed = the team played, the player is established,
and he has no stat row. Rates for test season S use seasons < S only (walk-forward).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from ffmodel.site.live_experts import atomic_write

POSITIONS = ("QB", "RB", "WR", "TE")
ON_TEAM = {"ACT", "RES", "INA"}
TAGS = ("Out", "Doubtful", "Questionable")
MIN_COUNT = 200


def _team_games(schedules: pd.DataFrame) -> pd.DataFrame:
    s = schedules.dropna(subset=["home_score", "away_score"])
    home = s[["season", "week", "home_team"]].rename(columns={"home_team": "team"})
    away = s[["season", "week", "away_team"]].rename(columns={"away_team": "team"})
    return pd.concat([home, away], ignore_index=True).drop_duplicates()


def participation(weekly, schedules, rosters) -> pd.DataFrame:
    games = _team_games(schedules)
    r = rosters
    if "game_type" in r:
        r = r[r["game_type"] == "REG"]
    r = r[r["position"].isin(POSITIONS) & r["gsis_id"].notna()]
    r = r.rename(columns={"gsis_id": "player_id"})[["season", "week", "team", "player_id", "position", "status"]]
    r = r.drop_duplicates(["season", "week", "player_id"])
    r = r.merge(games, on=["season", "week", "team"], how="inner")          # team played
    stats = weekly[["season", "week", "player_id"]].drop_duplicates()
    first = stats.groupby(["season", "player_id"]).week.min().rename("first_row").reset_index()
    r = r.merge(first, on=["season", "player_id"], how="inner")
    r = r[(r["week"] > r["first_row"]) & r["status"].isin(ON_TEAM)]
    r = r.merge(stats.assign(played=True), on=["season", "week", "player_id"], how="left")
    r["played"] = r["played"].fillna(False).astype(bool)
    return r.drop(columns="first_row").sort_values(["season", "player_id", "week"]).reset_index(drop=True)


def _pairs(part):
    p = part.sort_values(["season", "player_id", "week"])
    nxt = p.groupby(["season", "player_id"]).shift(-1)
    same_team = nxt["team"] == p["team"]
    return p[same_team.fillna(False)].assign(next_played=nxt.loc[same_team.fillna(False), "played"].astype(bool))


def transition_rates(part, seasons) -> dict:
    pairs = _pairs(part[part["season"].isin(seasons)])
    p_out, p_stay, counts = {}, {}, {}
    for pos in POSITIONS:
        g = pairs[pairs["position"] == pos]
        fp, fo = g[g["played"]], g[~g["played"]]
        counts[pos] = {"from_played": int(len(fp)), "from_out": int(len(fo))}
        p_out[pos] = float((~fp["next_played"]).mean()) if len(fp) else None
        p_stay[pos] = float((~fo["next_played"]).mean()) if len(fo) else None
    return {"p_out": p_out, "p_stay": p_stay, "counts": counts}


def tag_rates(part, injuries, seasons, *, rosters=None, min_count=MIN_COUNT) -> dict:
    part = part[part["season"].isin(seasons)]
    nxt = part.sort_values(["season", "player_id", "week"]).copy()
    nxt["next_played"] = nxt.groupby(["season", "player_id"])["played"].shift(-1)
    nxt["next_team"] = nxt.groupby(["season", "player_id"])["team"].shift(-1)
    nxt = nxt[nxt["next_played"].notna() & (nxt["next_team"] == nxt["team"])]
    inj = injuries
    if "game_type" in inj:
        inj = inj[inj["game_type"] == "REG"]
    inj = inj[inj["report_status"].isin(TAGS)].rename(columns={"gsis_id": "player_id"})
    tagged = nxt.merge(inj[["season", "week", "player_id", "report_status"]], on=["season", "week", "player_id"])
    frames = [tagged.rename(columns={"report_status": "tag"})]
    ir = nxt[nxt["status"] == "RES"].assign(tag="IR")
    frames.append(ir)
    allt = pd.concat(frames, ignore_index=True)
    p_tag, counts = {}, {}
    for tag in TAGS + ("IR",):
        g = allt[allt["tag"] == tag]
        counts[tag] = int(len(g))
        p_tag[tag] = float((~g["next_played"].astype(bool)).mean()) if len(g) >= min_count else None
    return {"p_tag": p_tag, "counts": counts}


def build_table(weekly, schedules, rosters, injuries, seasons) -> dict:
    part = participation(weekly, schedules, rosters)
    tr = transition_rates(part, seasons)
    tg = tag_rates(part, injuries, seasons)
    missing = [k for k, v in {**tr["p_out"], **tr["p_stay"], **tg["p_tag"]}.items() if v is None]
    if missing:
        raise ValueError(f"insufficient history for rates: {missing}")
    return {"schema_version": 1, "seasons": [min(seasons), max(seasons)], "min_count": MIN_COUNT,
            "p_out": tr["p_out"], "p_stay": tr["p_stay"], "p_tag": tg["p_tag"], "p_tag_scope": "pooled",
            "counts": {"transitions": tr["counts"], "tags": tg["counts"]},
            "definition": "established = stat row earlier that season AND rostered on that team that week "
                          "(ACT/RES/INA); missed = team played, established, no stat row; "
                          "p_tag = P(miss next team game | status this week)"}


def tags_by_week(injuries, rosters, season) -> dict:
    out: dict[str, dict[str, str]] = {}
    inj = injuries[(injuries["season"] == season) & injuries["report_status"].isin(TAGS)]
    for row in inj.itertuples():
        out.setdefault(str(int(row.week)), {})[row.gsis_id] = row.report_status
    res = rosters[(rosters["season"] == season) & (rosters["status"] == "RES") & rosters["gsis_id"].notna()]
    for row in res.itertuples():
        out.setdefault(str(int(row.week)), {})[row.gsis_id] = "IR"
    return out


def main() -> None:
    from ffmodel.data.pull import pull_weekly, pull_schedules, pull_injuries
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--rosters", type=Path, default=Path("data/raw/rosters_weekly_raw_2012_2025.parquet"))
    parser.add_argument("--last-season", type=int, default=2025)
    parser.add_argument("--test-seasons", type=int, nargs="*", default=[2023, 2024, 2025])
    args = parser.parse_args()
    span = list(range(2012, args.last_season + 1))
    weekly = pull_weekly(span, cache_dir=args.data_dir)
    schedules = pull_schedules(span, cache_dir=args.data_dir)
    rosters = pd.read_parquet(args.rosters)
    injuries = pull_injuries(span, cache_dir=args.data_dir)
    live = build_table(weekly, schedules, rosters, injuries, span)
    atomic_write(Path("site/data/availability.json"), json.dumps(live, indent=2, allow_nan=False))
    out_dir = Path("models/backtests/availability")
    out_dir.mkdir(parents=True, exist_ok=True)
    for s in args.test_seasons:
        table = build_table(weekly, schedules, rosters, injuries, list(range(2012, s)))
        table["test_season"] = s
        table["tags"] = tags_by_week(injuries, rosters, s)
        atomic_write(out_dir / f"availability_{s}.json", json.dumps(table, indent=2, allow_nan=False))
    print(json.dumps({k: live[k] for k in ("p_out", "p_stay", "p_tag")}, indent=2))


if __name__ == "__main__":
    main()
