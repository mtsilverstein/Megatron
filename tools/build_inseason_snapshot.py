"""Build the full-precision, manager-free in-season snapshot and today's legacy shapes.

Task 1 of the any-league phase 1 plan (spec section 9.4).  Everything here is
SYNTHETIC ANALYZER PARITY: a fictional league world built from the published
projections so that today's start/sit, waiver and in-season trade analyzers can
be pinned on a fixed input.  It is not a historical forecast reproduction.

Outputs (tests/fixtures/inseason_baseline/):
  snapshot.json        full-precision source both representations derive from
  legacy_<slug>.json   {board, weekly, remaining, kickoffs, league, rosters,
                        catalog, transactions} in today's shapes

Dealing rule (deterministic, legal, coverage-complete): see ``deal_rosters``.
Rosters, owners and league ids are fictional; no manager data is read.

Run:  .venv/Scripts/python.exe tools/build_inseason_snapshot.py
"""
from __future__ import annotations

import copy
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from ffmodel.league import load_league  # noqa: E402
from ffmodel.scoring import fantasy_points_quantiles  # noqa: E402

DATA = ROOT / "site" / "data"
OUT = ROOT / "tests" / "fixtures" / "inseason_baseline"
SETTINGS = ROOT / "tests" / "fixtures" / "owner_league_settings.json"
LAST_WEEK = 17
QUANTILES = ("p10", "p50", "p90")
# slug -> (synthetic league id, weekly file, remaining file, draft file, waiver_type)
LEAGUES = {
    "gabagool": ("900000000000000001", "weekly.json", "remaining-gabagool.json", "draft.json", 2),
    "fam": ("900000000000000002", "weekly-fam.json", "remaining-fam.json", "draft-fam.json", 0),
}
# Dealing passes: one player per roster per pass, direction alternating (snake).
DEAL_PASSES = ["QB", "QB", "RB", "RB", "RB", "RB", "WR", "WR", "WR", "WR", "TE", "TE", "FLEX"]
BENCH_SLOTS = {"BN", "IR", "TAXI"}
# 0-based snake slot held by roster 1 ("mine"), per league.
MINE_SLOT = {"gabagool": 0, "fam": 4}


def load(name: str):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def dump(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, separators=(",", ":"), sort_keys=True, allow_nan=False), encoding="utf-8")


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- snapshot
def build_snapshot() -> dict:
    weekly, draft = load("weekly.json"), load("draft.json")
    remaining, kickoffs = load("remaining-gabagool.json"), load("kickoffs.json")
    board = {p["player_id"]: p for p in draft["players"] if p.get("sleeper_id")}
    rem = {p["player_id"]: p for p in remaining["players"]}
    week = weekly["week"]
    earliest = min(datetime.fromisoformat(g["kickoff"]) for g in kickoffs["games"])
    generated_at = iso_utc(earliest - timedelta(hours=2))
    stat_order = list(weekly["players"][0]["stat_quantiles"]["p50"].keys())

    players = []
    for w in weekly["players"]:
        b = board.get(w["player_id"])
        if b is None:
            continue
        blocks = {q: {s: w["stat_quantiles"][q][s] for s in stat_order} for q in QUANTILES}
        rows = {r["week"]: r for r in (rem.get(w["player_id"]) or {"weeks": []})["weeks"]}
        future = {}
        for wk in range(week + 1, LAST_WEEK + 1):
            r = rows.get(wk)
            if r is None:
                future[str(wk)] = {"status": "unmodeled", "reason": "not_in_remaining_projection"}
            elif r["status"] == "bye":
                future[str(wk)] = {"status": "bye"}
            elif r["status"] == "conditional_projection":
                # "weekly" = reuses the player's weekly stat blocks (synthetic, not a forecast).
                future[str(wk)] = {"status": r["status"], "opponent": r.get("opponent"), "stats": "weekly"}
            else:
                future[str(wk)] = {"status": "unmodeled", "reason": r.get("reason")}
        players.append({
            "player_id": w["player_id"], "sleeper_id": str(b["sleeper_id"]), "name": w["name"],
            "team": w["team"], "position": w["position"], "bye": b.get("bye"), "ecr": b.get("ecr"),
            "weekly": blocks, "future": future,
        })
    return {"season": weekly["season"], "week": week, "start_week": week, "end_week": LAST_WEEK,
            "generated_at": generated_at, "data_through": weekly["data_through"],
            "kickoffs": {"season": kickoffs["season"], "week": kickoffs["week"],
                         "teams": kickoffs["teams"], "games": kickoffs["games"]},
            "stat_order": stat_order, "players": players}


# --------------------------------------------------------------------------- points
def league_points(rules, stat_order, blocks_list):
    """fantasy_points_quantiles on stat blocks, rounded to 2 dp as weekly.py does."""
    frames = {q: pd.DataFrame([b[q] for b in blocks_list], columns=stat_order) for q in QUANTILES}
    pts = fantasy_points_quantiles(frames, rules)
    return [{q: round(float(pts[q].iloc[i]), 2) for q in QUANTILES} for i in range(len(blocks_list))]


# --------------------------------------------------------------------------- lineups
def node_lineup(players, slots):
    """ROS.bestLineup via node (the real solver) -> starters' ids in slot order."""
    script = (
        "const ROS=require(process.argv[1]);let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{"
        "const a=JSON.parse(s);const r=ROS.bestLineup(a.players,a.slots,p=>p.value);"
        "if(!r.starters.length)throw Error('unfillable '+r.unfillable);"
        "process.stdout.write(JSON.stringify(r.starters.map(x=>x.player.id)));});")
    payload = json.dumps({"players": players, "slots": slots})
    res = subprocess.run(["node", "-e", script, str(ROOT / "site" / "assets" / "ros.js")],
                         input=payload, capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def deal_rosters(universe, n_rosters, mine_slot):
    """Deterministic snake deal.

    ``universe`` is already filtered to dealable players (weekly block present,
    no unmodeled future week) and sorted by ecr (null last), then player_id.
    Pass i deals one player to each roster; the pass position is DEAL_PASSES[i]
    (QB 2, RB 4, WR 4, TE 2, then one best-remaining RB/WR/TE per roster = 13
    offensive players).  Draft slots run 0..N-1 on even passes and N-1..0 on odd
    ones (snake).  Roster r (0-based) holds slot (r + mine_slot) % N, i.e. roster 1
    ("mine") sits at ``mine_slot`` -- chosen per league (MINE_SLOT) so the
    baseline world is a real success case (tools/capture_inseason_baseline.cjs).
    """
    slot_to_roster = {(r + mine_slot) % n_rosters: r for r in range(n_rosters)}
    taken, rosters = set(), [[] for _ in range(n_rosters)]
    for i, kind in enumerate(DEAL_PASSES):
        order = range(n_rosters) if i % 2 == 0 else range(n_rosters - 1, -1, -1)
        for slot in order:
            pool = [p for p in universe if p["player_id"] not in taken and
                    (p["position"] == kind or kind == "FLEX" and p["position"] in ("RB", "WR", "TE"))]
            if not pool:
                raise RuntimeError(f"cannot deal pass {i} ({kind}): universe exhausted")
            rosters[slot_to_roster[slot]].append(pool[0])
            taken.add(pool[0]["player_id"])
    return rosters


# --------------------------------------------------------------------------- legacy
def build_legacy(slug, snap, settings, keep=None):
    lid, weekly_f, remaining_f, draft_f, waiver_type = LEAGUES[slug]
    rules = load_league(slug).rules
    wk, gen = snap["week"], snap["generated_at"]
    weekly, remaining = load(weekly_f), load(remaining_f)
    league_draft = {p["player_id"]: p for p in load(draft_f)["players"]}
    fallback_draft = {p["player_id"]: p for p in load("draft.json")["players"]}
    stat_order, all_players = snap["stat_order"], snap["players"]
    # ``keep`` (set of player_ids) restricts the emitted world; dealing always uses the full universe.
    players = [p for p in all_players if keep is None or p["player_id"] in keep]

    league_payload = copy.deepcopy(weekly["league"])
    league_payload["league_id"] = lid
    league_payload["name"] = f"Synthetic league ({slug})"
    league_payload.pop("keeper_rules", None)

    pts = league_points(rules, stat_order, [p["weekly"] for p in players])
    pts_by_id = {p["player_id"]: pts[i] for i, p in enumerate(players)}

    # weekly: copy published fields, replace league points with the recomputed ones
    wmap = {w["player_id"]: w for w in weekly["players"]}
    wplayers, drift = [], 0
    for p in players:
        w = copy.deepcopy(wmap[p["player_id"]])
        if w["points"]["league"] != pts_by_id[p["player_id"]]:
            drift += 1
        w["points"]["league"] = pts_by_id[p["player_id"]]
        wplayers.append(w)
    weekly_out = {**{k: weekly[k] for k in ("data_through", "season", "week", "model", "has_bands",
                                           "stat_projection_schema", "pick_six_forecast")},
                  "generated_at": gen, "players": wplayers, "league": league_payload}

    # remaining
    rplayers = []
    for p in players:
        weeks = []
        for wnum in range(wk + 1, LAST_WEEK + 1):
            f = p["future"][str(wnum)]
            if f["status"] == "conditional_projection":
                weeks.append({"week": wnum, "status": f["status"], "opponent": f.get("opponent"),
                              "points": {"league": pts_by_id[p["player_id"]]}})
            elif f["status"] == "bye":
                weeks.append({"week": wnum, "status": "bye", "points": None})
            else:
                weeks.append({"week": wnum, "status": "unmodeled", "points": None, "reason": f.get("reason")})
        rplayers.append({"player_id": p["player_id"], "team": p["team"], "position": p["position"],
                         "name": p["name"], "weeks": weeks})
    coverage = []
    for wnum in range(wk + 1, LAST_WEEK + 1):
        c = {"conditional_projection": 0, "bye": 0, "unmodeled": 0}
        for rp in rplayers:
            c[next(x for x in rp["weeks"] if x["week"] == wnum)["status"]] += 1
        coverage.append({"week": wnum, **c})
    remaining_out = {k: remaining[k] for k in remaining
                     if k not in ("players", "generated_at", "league", "coverage_by_week")}
    remaining_out.update({"generated_at": gen, "start_week": wk, "end_week": LAST_WEEK,
                          "league": league_payload, "coverage_by_week": coverage, "players": rplayers})

    kickoffs = {"season": snap["kickoffs"]["season"], "week": snap["kickoffs"]["week"],
                "generated_at": gen, "teams": snap["kickoffs"]["teams"], "games": snap["kickoffs"]["games"]}

    # board (restricted to the universe), value fields from the league's real draft file
    board_players = []
    for p in players:
        d = league_draft.get(p["player_id"]) or fallback_draft[p["player_id"]]
        board_players.append({"player_id": p["player_id"], "sleeper_id": p["sleeper_id"], "name": p["name"],
                              "position": p["position"], "team": p["team"], "bye": p["bye"], "ecr": p["ecr"],
                              "value_points": d["value_points"], "season_points": d["season_points"]})
    board = {"players": board_players}
    bmap = {p["player_id"]: p for p in board_players}

    s = settings[slug]
    n = s["total_rosters"]
    league = {"league_id": lid, "season": "2026", "status": "in_season", "total_rosters": n,
              "roster_positions": s["roster_positions"], "scoring_settings": s["scoring_settings"],
              "settings": {"type": 0, "waiver_type": waiver_type, "waiver_budget": 100}}

    dealable = [p for p in all_players if all(f["status"] != "unmodeled" for f in p["future"].values())]
    dealable.sort(key=lambda p: (p["ecr"] is None, p["ecr"] if p["ecr"] is not None else 0, p["player_id"]))
    dealt = deal_rosters(dealable, n, MINE_SLOT[slug])
    slots_all = [x for x in s["roster_positions"] if x not in BENCH_SLOTS]
    skill_slots = [x for x in slots_all if x not in ("K", "DEF")]
    rosters, catalog = [], {}
    for p in players:
        catalog[p["sleeper_id"]] = {"full_name": p["name"], "position": p["position"], "team": p["team"],
                                    "injury_status": None, "gsis_id": p["player_id"]}
    for i, deal in enumerate(dealt, start=1):
        mine = [{"id": q["sleeper_id"], "position": q["position"],
                 "value": bmap[q["player_id"]]["value_points"]} for q in deal]
        starters_skill = iter(node_lineup(mine, skill_slots))
        starters = [f"k{i}" if x == "K" else f"d{i}" if x == "DEF" else next(starters_skill) for x in slots_all]
        catalog[f"k{i}"] = {"full_name": f"Synthetic K {i}", "position": "K", "team": "SYN",
                            "injury_status": None, "gsis_id": None}
        catalog[f"d{i}"] = {"full_name": f"Synthetic DEF {i}", "position": "DEF", "team": "SYN",
                            "injury_status": None, "gsis_id": None}
        rosters.append({"roster_id": i, "owner_id": f"owner{i}",
                        "players": [q["sleeper_id"] for q in deal] + [f"k{i}", f"d{i}"],
                        "starters": starters, "reserve": [], "taxi": [],
                        "settings": {"waiver_budget_used": 10, "waiver_position": i}})
    return {"board": board, "weekly": weekly_out, "remaining": remaining_out, "kickoffs": kickoffs,
            "league": league, "rosters": rosters, "catalog": catalog, "transactions": []}, drift, len(dealable)


FREE_AGENT_KEEP = 150


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    full = build_snapshot()
    settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
    # Pass 1: deal on the full universe to learn who is rostered in either synthetic league.
    rostered = set()
    for slug in LEAGUES:
        legacy, _, _ = build_legacy(slug, full, settings)
        gsis = {sid: c["gsis_id"] for sid, c in legacy["catalog"].items() if c["gsis_id"]}
        rostered |= {gsis[sid] for r in legacy["rosters"] for sid in r["players"] if sid in gsis}
    # Universe = rostered players + the FREE_AGENT_KEEP highest weekly-p50 unrostered players (ppr p50 as published).
    ppr = {w["player_id"]: w["points"]["ppr"]["p50"] for w in load("weekly.json")["players"]}
    others = sorted((p for p in full["players"] if p["player_id"] not in rostered),
                    key=lambda p: (-ppr[p["player_id"]], p["player_id"]))
    keep = rostered | {p["player_id"] for p in others[:FREE_AGENT_KEEP]}
    snap = {**full, "players": [p for p in full["players"] if p["player_id"] in keep]}
    dump(OUT / "snapshot.json", snap)
    print(f"snapshot: week {snap['week']} generated_at {snap['generated_at']} players {len(snap['players'])} "
          f"(rostered {len(rostered)} + {len(keep) - len(rostered)} free agents)")
    for slug in LEAGUES:
        legacy, drift, dealable = build_legacy(slug, full, settings, keep)
        dump(OUT / f"legacy_{slug}.json", legacy)
        print(f"{slug}: dealable {dealable}, weekly league-points rounding drift vs published {drift}")


if __name__ == "__main__":
    main()
