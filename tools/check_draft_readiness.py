"""Read-only pre-draft readiness check for the two shipped Sleeper boards.
Run from the repository root with ``.venv/Scripts/python.exe``.  This checks
the committed artifacts and public Sleeper metadata; it never writes files or
changes a league.  The browser contract and optimizer checks deliberately run
the shipped JavaScript modules through Node rather than reimplementing them.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from ffmodel.league import load_league  # noqa: E402

API = "https://api.sleeper.app/v1"
SLUGS = ("fam", "gabagool")
POSITIONS = ("QB", "RB", "WR", "TE", "FLEX", "K", "DEF")
SCORING_KEYS = {
    "pass_yd": "pass_yd", "pass_td": "pass_td", "pass_int": "interception",
    "rush_yd": "rush_yd", "rush_td": "rush_td", "rec_yd": "rec_yd",
    "rec_td": "rec_td", "rec": "reception", "fum_lost": "fumble_lost",
}
def read_url(url: str) -> dict:
    req = Request(url, headers={"User-Agent": "Megatron-readiness/1"})
    with urlopen(req, timeout=15) as response:
        return json.load(response)
def get_json(path: str) -> dict:
    return read_url(f"{API}{path}")
def check_python(slug: str, site_url: str | None = None) -> dict:
    cfg = load_league(slug, ROOT / "configs" / "leagues")
    board_path = ROOT / "site" / "data" / cfg.board_file
    local_board = json.loads(board_path.read_text(encoding="utf-8"))
    board = local_board
    errors: list[str] = []
    served_url = None
    if site_url:
        served_url = urljoin(site_url.rstrip("/") + "/", f"data/{cfg.board_file}")
        board = read_url(served_url)
        if board != local_board:
            errors.append(f"served board JSON differs from local {cfg.board_file}")
    if board.get("league") != cfg.payload():
        errors.append("board league contract differs from configs/leagues source of truth")

    live_league = get_json(f"/league/{cfg.league_id}")
    draft_id = live_league.get("draft_id")
    if not draft_id:
        raise RuntimeError(f"{slug}: live league has no draft_id")
    draft = get_json(f"/draft/{draft_id}")
    if str(board.get("season")) != str(draft.get("season")):
        errors.append(f"board season {board.get('season')} != draft season {draft.get('season')}")
    if str(board.get("season")) != str(live_league.get("season")):
        errors.append(f"board season {board.get('season')} != league season {live_league.get('season')}")
    if draft.get("sport") != "nfl":
        errors.append(f"draft sport is {draft.get('sport')!r}, expected 'nfl'")

    expected = dict(cfg.roster)
    expected.update({"FLEX": cfg.flex, "K": 1, "DEF": 1})
    actual = Counter(live_league.get("roster_positions") or [])
    for pos in POSITIONS:
        if actual.get(pos, 0) != expected.get(pos, 0):
            errors.append(f"live {pos} slots {actual.get(pos, 0)} != config {expected.get(pos, 0)}")
    if int(live_league.get("total_rosters", -1)) != cfg.teams:
        errors.append(f"live total_rosters {live_league.get('total_rosters')} != config {cfg.teams}")

    settings = live_league.get("scoring_settings") or {}
    expected_scoring = cfg.sleeper_scoring or {}
    if not expected_scoring:
        errors.append("config has no sleeper_scoring full map")
    for key in sorted(set(settings) | set(expected_scoring)):
        actual_weight, wanted = settings.get(key, 0), expected_scoring.get(key, 0)
        try:
            matches = math.isclose(float(actual_weight), float(wanted), rel_tol=0, abs_tol=1e-9)
        except (TypeError, ValueError):
            matches = False
        if not matches:
            errors.append(f"scoring {key} {actual_weight!r} != config {wanted!r}")

    return {"slug": slug, "cfg": cfg.payload(), "board_path": str(board_path),
            "board": board, "league": live_league, "draft": draft,
            "errors": errors, "rules": cfg.rules, "served_url": served_url}
NODE_CHECK = r'''
"use strict";
const fs = require("fs"), path = require("path");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
global.window = {};
global.document = { addEventListener() {}, getElementById: () => null,
  querySelector: () => null, hidden: false };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const site = path.resolve("site", "assets");
const O = require(path.join(site, "optimizer.js"));
global.window.Optimizer = O;
require(path.join(site, "draftmode.js"));
const D = global.window.DraftMode;
const out = { guards: [], scoring: [], configs: [], boards: [] };
for (const item of input.items) {
  const own = D.draftContractError(item.draft, item.cfg);
  const cross = D.draftContractError(item.draft, item.other_cfg);
  out.guards.push({ slug: item.slug, own, cross });
  const score = typeof D.leagueScoringError === "function"
    ? D.leagueScoringError(item.live_league.scoring_settings, item.cfg.sleeper_scoring)
    : "production leagueScoringError helper is unavailable";
  out.scoring.push({ slug: item.slug, error: score });
  const board = item.board_data || JSON.parse(fs.readFileSync(item.board_path, "utf8"));
  const lens = O.valueLens(board.players || []);
  const finite = (board.players || []).length > 0 && (board.players || []).every(p =>
    p.season_points && p.season_points[lens] && Number.isFinite(p.season_points[lens].p50));
  const qr = Number(item.cfg.teams) + 1;
  const qbs = (board.players || []).filter(p => p.position === "QB" && Number(p.position_rank) === qr);
  const replacement = qbs.length === 1 && Number.isFinite(qbs[0].value_points)
    && Number.isFinite(qbs[0].vorp) && Math.abs(qbs[0].vorp) <= 1;
  out.boards.push({ slug: item.slug, lens, finite, replacement });
}
// Configure each shipped contract in order and prove the exported getters are
// live, not stale copies. A fully filled mandatory skill roster leaves flexes.
for (const item of input.items) {
  O.configure(item.cfg);
  const held = [{position:"QB"}, {position:"RB"}, {position:"RB"},
    {position:"WR"}, {position:"WR"}, {position:"TE"}];
  const slots = O.openSlots(held);
  const c = O.leagueConfig();
  out.configs.push({ slug: item.slug, slots, config: c,
    expected_slots: Number(item.cfg.flex) });
}
process.stdout.write(JSON.stringify(out));
'''
def check_node(items: list[dict]) -> dict:
    payload = []
    for item in items:
        other = next(x for x in items if x["slug"] != item["slug"])
        payload.append({"slug": item["slug"], "cfg": item["cfg"],
                        "other_cfg": other["cfg"], "draft": item["draft"],
                        "live_league": item["league"],
                        "board_path": item["board_path"], "board_data": item["board"]})
    result = subprocess.run(["node", "-e", NODE_CHECK], cwd=ROOT,
                            input=json.dumps({"items": payload}), text=True,
                            capture_output=True, timeout=30, check=False)
    if result.returncode:
        raise RuntimeError(f"node readiness check failed: {result.stderr.strip()}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"node readiness emitted invalid JSON: {result.stdout!r}") from exc


def main() -> int:
    try:
        site_url = None
        if len(sys.argv) == 3 and sys.argv[1] == "--site-url":
            site_url = sys.argv[2]
        elif len(sys.argv) != 1:
            raise ValueError("usage: check_draft_readiness.py [--site-url URL]")
        items = [check_python(slug, site_url) for slug in SLUGS]
        node = check_node(items)
        for guard in node["guards"]:
            if guard["own"] is not None:
                items[SLUGS.index(guard["slug"])]["errors"].append(f"JS own draft rejected: {guard['own']}")
            if not guard["cross"]:
                items[SLUGS.index(guard["slug"])]["errors"].append("JS cross-league draft was not rejected")
        for score in node["scoring"]:
            if score["error"]:
                items[SLUGS.index(score["slug"])]["errors"].append(f"JS scoring guard: {score['error']}")
        for board in node["boards"]:
            if not board["finite"]:
                items[SLUGS.index(board["slug"])]["errors"].append(f"JS {board['lens']} point lens has non-finite values")
            if not board["replacement"]:
                items[SLUGS.index(board["slug"])]["errors"].append("QB replacement row is not finite/near zero")
        for config in node["configs"]:
            item = items[SLUGS.index(config["slug"])]
            if len(config["slots"]) != config["expected_slots"] or any(s != "FLEX" for s in config["slots"]):
                item["errors"].append(f"Optimizer.openSlots returned {config['slots']!r}")
            c, expected = config["config"], item["cfg"]
            if (c["FLEX_SLOTS"] != expected["flex"] or c["ROLLOUT_PICKS"] != expected["starters"]
                    or c["DEDICATED"] != expected["roster"] or c["DEPTH_CAP"] != expected["depth_cap"]):
                item["errors"].append("Optimizer.leagueConfig exports stale/wrong values")
        failed = False
        for item in items:
            lg, dr, cfg = item["league"], item["draft"], item["cfg"]
            scoring = ", ".join(f"{k}={getattr(item['rules'], v)}" for k, v in SCORING_KEYS.items())
            start = dr.get("start_time")
            start_iso = (datetime.fromtimestamp(float(start) / 1000, timezone.utc).isoformat()
                         if start is not None else None)
            board_url = item["served_url"] or f"index.html?league={item['slug']}"
            status = "PASS" if not item["errors"] else "FAIL"
            failed |= status == "FAIL"
            unprojected = item["board"].get("league", {}).get("unprojected_scoring", {})
            print(f"{status} {item['slug']}: generated_at={item['board'].get('generated_at')} "
                  f"draft_start={start_iso} draft_id={dr.get('draft_id')} "
                  f"scoring[{scoring}] board_url={board_url}")
            print(f"  unprojected_scoring={json.dumps(unprojected, sort_keys=True)} (not modeled)")
            for error in item["errors"]:
                print(f"  - {error}")
        return 1 if failed else 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
