"""Absence rates for the roster simulation (spec 2026-09-24 §4, plan refinements 2-3).

established = a regular-season stat row earlier that season AND rostered on that team
that week with status ACT/RES/INA. missed = the team played, the player is established,
and he has no stat row. Rates for test season S use seasons < S only (walk-forward).

Fix round 1: the raw established population is dominated by NFL backups who record one
stat row and then sit healthy on the bench -- every benched week reads as "missed",
which badly overstates absence for the fantasy-rostered players the simulation actually
applies these rates to. `participation` marks every established player-week with a
`relevant` flag: among established players at the same position (season, week), only
the top RELEVANT_N by trailing role score (mean fantasy_points_ppr over the player's
last up to 4 stat rows strictly before that week, same season -- no future information)
are relevant. RELEVANT_N approximates the rosterable pool in a 12-team league.

Fix round 2: relevance conditions only the FROM state of a transition -- the outcome is
the player's literal next team game, established or not, relevant or not. Round 1 made
`participation` filter OUT irrelevant rows entirely, which meant `_pairs`/`tag_rates`
(which shift(-1) within each player's row sequence) silently paired a relevant week with
the next *relevant* row rather than the player's actual next team game, skipping over
any established-but-irrelevant weeks in between (measured on real data: 2,046 of 46,198
transitions, 4.4%, skipped at least one such week). `participation` now returns every
established row (relevant or not) with the boolean `relevant` column; `_pairs` and
`tag_rates` build pairs from every consecutive established row for the same player and
team, then keep a pair only when its FROM row is relevant. A bye still produces no row
(`_team_games` excludes it), so bye gaps stay legitimate; this only concerns not skipping
established rows that happen to be irrelevant.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import pandas as pd

from ffmodel.site.live_experts import atomic_write

POSITIONS = ("QB", "RB", "WR", "TE")
ON_TEAM = {"ACT", "RES", "INA"}
TAGS = ("Out", "Doubtful", "Questionable")
MIN_COUNT = 200
RELEVANT_N = {"QB": 32, "RB": 64, "WR": 96, "TE": 32}


def _team_games(schedules: pd.DataFrame) -> pd.DataFrame:
    s = schedules.dropna(subset=["home_score", "away_score"])
    home = s[["season", "week", "home_team"]].rename(columns={"home_team": "team"})
    away = s[["season", "week", "away_team"]].rename(columns={"away_team": "team"})
    return pd.concat([home, away], ignore_index=True).drop_duplicates()


def _trailing_role_score(established: pd.DataFrame, weekly: pd.DataFrame) -> pd.Series:
    """Mean fantasy_points_ppr over the player's last up to 4 stat rows strictly
    before `week`, within the same season -- aligned to `established`.index.

    Uses an as-of merge (backward, exact matches excluded) so the current week's
    own stat row -- if any -- never leaks into its own relevance ranking.
    """
    pts = (weekly[["season", "week", "player_id", "fantasy_points_ppr"]]
           .drop_duplicates(["season", "player_id", "week"])
           .sort_values("week", kind="stable"))
    pts["trail"] = (pts.groupby(["season", "player_id"])["fantasy_points_ppr"]
                     .transform(lambda s: s.rolling(4, min_periods=1).mean()))
    left = (established[["season", "player_id", "week"]].reset_index()
            .sort_values("week", kind="stable"))
    # merge_asof requires the "on" column sorted globally (not just per "by" group);
    # sorting by "week" alone satisfies that while "by" still isolates matches to the
    # same (season, player_id).
    merged = pd.merge_asof(left, pts[["season", "player_id", "week", "trail"]],
                           by=["season", "player_id"], on="week",
                           direction="backward", allow_exact_matches=False)
    return merged.set_index("index")["trail"].reindex(established.index)


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
    # Fantasy-relevance: a flag, not a row filter (fix round 2) -- every established
    # player-week is kept. `relevant` marks the top RELEVANT_N[position] established
    # players per (season, week, position) by trailing role score. method="min" gives
    # every player tied at the cutoff the same (lowest) rank, so ties at the boundary
    # are all kept rather than arbitrarily broken.
    r = r.assign(_trail=_trailing_role_score(r, weekly))
    r["_rank"] = r.groupby(["season", "week", "position"])["_trail"].rank(method="min", ascending=False)
    r["relevant"] = r["_rank"] <= r["position"].map(RELEVANT_N)
    r = r.merge(stats.assign(played=True), on=["season", "week", "player_id"], how="left")
    r["played"] = r["played"].fillna(False).astype(bool)
    return (r.drop(columns=["first_row", "_trail", "_rank"])
            .sort_values(["season", "player_id", "week"]).reset_index(drop=True))


def _pairs(part):
    """Consecutive-team-game pairs from the FULL established frame.

    `part` must be `participation`'s unfiltered output (every established row,
    relevant or not). The shift(-1) below walks every established row in order, so
    "next" is always the player's literal next established team game -- never
    skipping an established-but-irrelevant row in between. Relevance conditions only
    the FROM side: a pair counts only when its FROM row is relevant, regardless of
    whether the TO row is.
    """
    p = part.sort_values(["season", "player_id", "week"])
    nxt = p.groupby(["season", "player_id"]).shift(-1)
    same_team = (nxt["team"] == p["team"]).fillna(False)
    pairs = p[same_team].assign(next_played=nxt.loc[same_team, "played"].astype(bool))
    return pairs[pairs["relevant"]]


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


def tag_rates(part, injuries, seasons, *, min_count=MIN_COUNT) -> dict:
    """`part` must be `participation`'s unfiltered output (see `_pairs`) -- "next"
    is the player's literal next established team game, and a pair counts only when
    its FROM row (the week carrying the tag) is relevant.
    """
    part = part[part["season"].isin(seasons)]
    nxt = part.sort_values(["season", "player_id", "week"]).copy()
    nxt["next_played"] = nxt.groupby(["season", "player_id"])["played"].shift(-1)
    nxt["next_team"] = nxt.groupby(["season", "player_id"])["team"].shift(-1)
    nxt = nxt[nxt["next_played"].notna() & (nxt["next_team"] == nxt["team"])]
    nxt = nxt[nxt["relevant"]]
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
            "relevant_n": RELEVANT_N,
            "p_out": tr["p_out"], "p_stay": tr["p_stay"], "p_tag": tg["p_tag"], "p_tag_scope": "pooled",
            "counts": {"transitions": tr["counts"], "tags": tg["counts"]},
            "definition": "established = stat row earlier that season AND rostered on that team that week "
                          "(ACT/RES/INA); relevant = among established players at that position/week, top "
                          "relevant_n[pos] by trailing role score (mean fantasy_points_ppr over the last "
                          "up to 4 stat rows strictly before that week, same season); a transition counts only "
                          "when its FROM week is relevant, but its outcome is the player's literal next "
                          "established team game regardless of that game's own relevance; missed = the team "
                          "played, the player was established, and he has no stat row; "
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


# Mirror of rostersim.js `normalizeTag`: the only spellings the simulator maps.
# Anything else is reported as-is and listed as unmapped, never coerced.
NORMALIZABLE = {"out": "Out", "sus": "Out", "doubtful": "Doubtful",
                "questionable": "Questionable", "ir": "IR", "pup": "IR"}


MIN_WEEK1_ROWS = 100
MIN_FRACTION_OF_MEDIAN = 0.5


def week_row_check(injuries, season: int, week: int) -> dict:
    """Completeness of a week's injury pull: row count vs the median of the
    season's EARLIER regular-season weeks (week 1: an absolute floor). A partial
    pull would leave unreported players looking healthy, so callers must refuse."""
    inj = injuries[injuries["season"] == season]
    if "game_type" in inj.columns:
        inj = inj[inj["game_type"] == "REG"]
    per_week = inj.groupby("week").size()
    rows = int(per_week.get(week, 0))
    earlier = per_week[per_week.index < week]
    if week <= 1 or earlier.empty:
        required = MIN_WEEK1_ROWS
    else:
        required = int(math.ceil(MIN_FRACTION_OF_MEDIAN * float(earlier.median())))
    return {"rows": rows, "required": required, "ok": rows >= required and rows > 0}


def tags_payload(injuries, rosters, season: int, week: int, *,
                 source: str, retrieved_at: str) -> dict:
    """Origin injury tags for ONE season/week: {gsis_id: status}, as tagged.

    Statuses the simulator's `normalizeTag` would not map (e.g. a spelled-out
    "Suspended") are kept verbatim and their ids listed under `unmapped`, so a
    downstream reader can see them instead of silently treating them as healthy.
    """
    tags = dict(tags_by_week(injuries, rosters, season).get(str(int(week)), {}))
    unmapped = sorted(g for g, st in tags.items()
                      if NORMALIZABLE.get(str(st).strip().lower()) is None)
    return {"season": int(season), "week": int(week), "source": source,
            "retrieved_at": retrieved_at, "tags": tags, "unmapped": unmapped,
            "row_counts": {"injury_rows": int(((injuries["season"] == season) & (injuries["week"] == week)).sum())
                           if injuries is not None else 0,
                           "tagged": len(tags), "unmapped": len(unmapped)}}


def tags_main(argv) -> None:
    from datetime import datetime, timezone
    from ffmodel.data.pull import pull_injuries
    parser = argparse.ArgumentParser(prog="availability tags", description="Per-week origin injury tags")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    import nflreadpy
    injuries = pull_injuries([args.season], cache_dir=args.data_dir)
    rosters = nflreadpy.load_rosters_weekly([args.season]).to_pandas()
    chk = week_row_check(injuries, args.season, args.week)
    if not chk["ok"]:
        raise SystemExit(f"{args.season} week {args.week}: {chk['rows']} injury rows < required {chk['required']} "
                         "-- partial pull, refusing to write tags")
    out = tags_payload(injuries, rosters, args.season, args.week,
                       source="nflverse injuries + rosters_weekly (RES -> IR)",
                       retrieved_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    atomic_write(args.out, json.dumps(out, indent=1, allow_nan=False))
    print(f"{args.out}: {out['row_counts']['injury_rows']} rows, {len(out['tags'])} tags, {len(out['unmapped'])} unmapped")


def main() -> None:
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "tags":
        return tags_main(sys.argv[2:])
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
