"""League-neutral batch builders (spec 2026-10-01 §3.1, §3.3, §3.4).

One weekly Actions run publishes a *batch* of neutral files that must all
describe the same input snapshot. `BatchContext` is that snapshot's identity;
every neutral file header carries its five fields plus `schema_version` and
`kind`, so the browser can reject a mixed batch.

`build_players` is the **scorable universe**: every player in the neutral
weekly or remaining payload, crosswalked to Sleeper by a one-to-one GSIS rule,
falling back to `sleeper.build_crosswalk`'s unique name+position match only
when the catalog has no entry for that GSIS (Sleeper carries a `gsis_id` for a
minority of active players; spec §3.4 correction 2026-10-05). A duplicated
GSIS never falls back; any ambiguity or disagreement makes the player
identity-only (never priced), with the reason recorded.
"""
from __future__ import annotations

import copy
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import pandas as pd

from ffmodel.site.leaguelens import STATS
from ffmodel.site.sleeper import _normalize_name

NEUTRAL_LENSES = ("ppr", "half_ppr", "standard")
# One normalization table for team codes (Sleeper -> nflverse).
TEAM_ALIASES = {"LAR": "LA", "WSH": "WAS", "JAC": "JAX"}
LAST_PROJECTED_WEEK = 17
_ECR_COLUMNS = ("player_id", "ecr", "scrape_date", "fp_page")
# The frozen 2026 per-format test's payloads (read only; never rewritten here).
FORMAT_PAYLOADS = Path(__file__).resolve().parents[3] / "models" / "prospective" / "2026" / "format_payloads.json"
# Published order and wording of `neutral/formats.json`.
FORMAT_DESCRIPTIONS = {
    "f12-1qb-ppr-6": "12-team 1QB PPR, 6-pt pass TD",
    "f10-1qb-ppr-6": "10-team 1QB PPR, 6-pt pass TD",
    "f12-1qb-ppr-4": "12-team 1QB PPR, 4-pt pass TD",
    "f12-1qb-half-4": "12-team 1QB half-PPR, 4-pt pass TD",
    "f12-sf-ppr-4": "12-team superflex PPR, 4-pt pass TD (exploratory)",
}
EXPLORATORY_FORMATS = frozenset({"f12-sf-ppr-4"})


@dataclass(frozen=True)
class BatchContext:
    season: int
    week: int
    data_through: str
    generated_at: str
    batch_id: str

    def header(self) -> dict:
        return asdict(self)


def make_batch_context(season: int, week: int, data_through: str, generated_at: str) -> BatchContext:
    """The batch identity: `batch_id = f"{generated_at}|{data_through}|w{week}"`."""
    return BatchContext(int(season), int(week), str(data_through), str(generated_at),
                        f"{generated_at}|{data_through}|w{week}")


def normalize_team(code):
    return TEAM_ALIASES.get(code, code) if code is not None else None


def neutral_weekly(weekly_payload: dict, ctx: BatchContext, pick_six_prior: dict | None,
                   method: dict) -> dict:
    """`neutral/weekly.json` from a `build_weekly_projections` payload.

    Points are reduced to the league-free display lenses (no `league` lens),
    `stats_p50` is dropped, `stat_quantiles` stay at full precision. The
    payload must be the batch's own slate (season, week, data_through) and
    must have been projected with exactly `pick_six_prior`, since every
    `passing_pick_sixes` block depends on it. The input is not mutated."""
    for key in ("season", "week", "data_through"):
        if weekly_payload.get(key) != getattr(ctx, key):
            raise ValueError(f"weekly payload {key} {weekly_payload.get(key)!r} "
                             f"disagrees with the batch context {getattr(ctx, key)!r}")
    if weekly_payload.get("pick_six_forecast") != pick_six_prior:
        raise ValueError("weekly payload was projected with a different pick-six prior")
    players, seen = [], set()
    for p in weekly_payload["players"]:
        pid = str(p["player_id"])
        if pid in seen:
            raise ValueError(f"duplicate weekly player {pid}")
        seen.add(pid)
        points = p.get("points") or {}
        missing = [lens for lens in NEUTRAL_LENSES if not isinstance(points.get(lens), dict)]
        if missing:
            raise ValueError(f"weekly player {pid} missing display lens(es) {missing}")
        row = {k: copy.deepcopy(v) for k, v in p.items() if k not in ("points", "stats_p50")}
        row["points"] = {lens: dict(points[lens]) for lens in NEUTRAL_LENSES}
        players.append(row)
    return {**ctx.header(), "schema_version": 1, "kind": "neutral_weekly",
            "model": weekly_payload.get("model"),
            "has_bands": weekly_payload.get("has_bands"),
            "stat_projection_schema": copy.deepcopy(weekly_payload.get("stat_projection_schema")),
            "pick_six_forecast": None if pick_six_prior is None else dict(pick_six_prior),
            "method": method,
            "players": players}


def format_table(path: Path = FORMAT_PAYLOADS) -> list[dict]:
    """`neutral/formats.json`'s `formats`: one row per format in the 2026 test.

    `format_key` and `compat` are copied unchanged from the frozen
    `format_payloads.json` (a dict keyed by label), so the browser's
    `Formats.match` sees exactly what the test froze. A label set that differs
    from the published descriptions raises rather than publishing a partial or
    undescribed table."""
    payloads = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payloads, dict) or set(payloads) != set(FORMAT_DESCRIPTIONS):
        raise ValueError(f"format payload labels {sorted(payloads) if isinstance(payloads, dict) else payloads!r} "
                         f"disagree with the published descriptions {sorted(FORMAT_DESCRIPTIONS)}")
    rows = []
    for label, description in FORMAT_DESCRIPTIONS.items():
        entry = payloads[label]
        if "format_key" not in entry or "compat" not in entry:
            raise ValueError(f"format payload {label} missing format_key or compat")
        rows.append({"label": label, "format_key": entry["format_key"], "compat": entry["compat"],
                     "description": description, "exploratory": label in EXPLORATORY_FORMATS})
    return rows


def empty_remaining(ctx: BatchContext, model: str) -> dict:
    """The valid end state when no supported week remains (spec §3.3, `start_week > 17`)."""
    return {**ctx.header(), "schema_version": 2, "kind": "neutral_remaining",
            "horizon": "remaining_season", "status": "no_remaining_weeks",
            "start_week": ctx.week, "end_week": LAST_PROJECTED_WEEK, "model": model,
            "stat_order": list(STATS), "players": []}


def _bye_weeks(schedule: pd.DataFrame, season: int) -> dict:
    """Team -> its single regular-season bye week; teams with != 1 open week map to None."""
    sched = schedule[schedule.season == season]
    if "game_type" in sched:
        sched = sched[sched.game_type == "REG"]
    weeks = set(int(w) for w in sched.week)
    played: dict = {}
    for week, home, away in zip(sched.week, sched.home_team, sched.away_team):
        for team in (home, away):
            played.setdefault(normalize_team(team), set()).add(int(week))
    out = {}
    for team, on in played.items():
        open_weeks = sorted(weeks - on)
        out[team] = open_weeks[0] if len(open_weeks) == 1 else None
    return out


def _ecr(ecr_rows) -> tuple[dict | None, dict]:
    if ecr_rows is None:
        return None, {}
    missing = [c for c in _ECR_COLUMNS if c not in ecr_rows.columns]
    if missing:
        raise ValueError(f"ECR rows missing column(s) {missing}")
    pages = ecr_rows["fp_page"].dropna().unique()
    dates = pd.to_datetime(ecr_rows["scrape_date"]).dropna().dt.date.unique()
    if len(pages) != 1 or len(dates) != 1:
        raise ValueError(f"ECR rows must come from one page and one date "
                         f"(pages {list(pages)}, dates {[str(d) for d in dates]})")
    rows = ecr_rows.dropna(subset=["player_id"])
    if rows["player_id"].duplicated().any():
        raise ValueError("ECR rows contain a duplicated player_id")
    ranks = {}
    for pid, value in zip(rows["player_id"], rows["ecr"]):
        if pd.notna(value):
            v = float(value)
            ranks[str(pid)] = int(v) if v.is_integer() else v
    return {"source": str(pages[0]), "date": dates[0].isoformat(), "scoring": "PPR"}, ranks


def _catalog_index(sleeper_players: dict) -> tuple[dict, dict]:
    """(by stripped gsis_id, by (normalized name, position)) -> [(sleeper_id, meta)]."""
    by_gsis: dict = {}
    by_name_pos: dict = {}
    for sid, meta in (sleeper_players or {}).items():
        if not isinstance(meta, dict):
            continue
        gsis = str(meta.get("gsis_id") or "").strip()
        if gsis:
            by_gsis.setdefault(gsis, []).append((str(sid), meta))
        full = meta.get("full_name") or " ".join(
            p for p in (meta.get("first_name"), meta.get("last_name")) if p)
        key = (_normalize_name(full), str(meta.get("position") or ""))
        if key[0] and key[1]:
            by_name_pos.setdefault(key, []).append((str(sid), meta))
    return by_gsis, by_name_pos


def _name_key(name, position):
    if not name or not position:
        return None
    key = (_normalize_name(name), str(position))
    return key if key[0] else None


def build_players(ctx: BatchContext, weekly_n: dict, remaining_n: dict, sleeper_players: dict,
                  ecr_rows, schedule: pd.DataFrame) -> dict:
    """`neutral/players.json`: the scorable universe (spec §3.4).

    Members are every player in `weekly_n` or `remaining_n` (the neutral
    payloads of this batch), sorted by `player_id`. GSIS id, team and position
    come from the projections; Sleeper id and name from the catalog. The first
    failing rule makes a player identity-only:

    - weekly and remaining disagree on team or position -> `projection_identity_conflict`
    - in remaining only and never projected (no position) -> `no_projection`
    - more than one catalog entry with that stripped `gsis_id` ->
      `duplicate_gsis_in_catalog` (no name fallback)
    - no catalog entry with it -> name fallback on
      `(sleeper._normalize_name(name), position)` (catalog `full_name`, else
      first + last): no candidate -> `no_catalog_match`; more than one catalog
      candidate, or more than one projected player with that key ->
      `ambiguous_name_match`; the one candidate carries a different
      `gsis_id` -> `gsis_disagrees`
    - catalog team differs after `normalize_team` -> `team_disagrees`
    - catalog position differs -> `position_disagrees`

    `match` is `"gsis"`, `"name"` or null (no unique link). `sleeper_id` and
    the catalog `full_name` are filled whenever there is a unique link,
    identity-only or not (roster identity is still useful); otherwise
    `sleeper_id` is null and `name` is the projection's. The header's
    `crosswalk` block counts `matched_gsis` / `matched_name` / `unmatched`
    over projected players (those with a position).

    `ecr_rows` is None or the normalized ECR DataFrame the draft board uses
    (`data.rankings.normalize_ecr_snapshot` / `generate._load_consensus`
    output) with columns `player_id, ecr, scrape_date, fp_page`, from a single
    page and date; it yields `ecr_source = {source: fp_page, date:
    scrape_date (YYYY-MM-DD), scoring: "PPR"}`. None -> `ecr_source` null and
    every `ecr` null.

    `schedule` is the nflverse schedule frame; `bye` is the one regular-season
    week of `ctx.season` in which the player's team has no game, else null.
    """
    for name, doc in (("weekly", weekly_n), ("remaining", remaining_n)):
        if doc.get("batch_id") != ctx.batch_id:
            raise ValueError(f"{name} payload is from a different batch "
                             f"({doc.get('batch_id')!r} != {ctx.batch_id!r})")
    weekly_by, remaining_by = {}, {}
    for name, doc, by in (("weekly", weekly_n, weekly_by), ("remaining", remaining_n, remaining_by)):
        for p in doc["players"]:
            pid = str(p["player_id"])
            if pid in by:
                raise ValueError(f"duplicate {name} player {pid}")
            by[pid] = p
    ecr_source, ranks = _ecr(ecr_rows)
    byes = _bye_weeks(schedule, ctx.season) if schedule is not None else {}
    by_gsis, by_name_pos = _catalog_index(sleeper_players)
    union = sorted(set(weekly_by) | set(remaining_by))
    proj_key_counts: dict = {}
    for pid in union:
        src = weekly_by.get(pid) or remaining_by.get(pid)
        key = _name_key(src.get("name"), src.get("position"))
        if key is not None:
            proj_key_counts[key] = proj_key_counts.get(key, 0) + 1

    players = []
    crosswalk = {"matched_gsis": 0, "matched_name": 0, "unmatched": 0}
    for pid in union:
        w, r = weekly_by.get(pid), remaining_by.get(pid)
        src = w or r
        team, position, proj_name = src.get("team"), src.get("position"), src.get("name")
        sid, meta, match, link_reason = None, None, None, None
        hits = by_gsis.get(pid, [])
        if len(hits) == 1:
            (sid, meta), match = hits[0], "gsis"
        elif len(hits) > 1:
            link_reason = "duplicate_gsis_in_catalog"
        else:
            key = _name_key(proj_name, position)
            candidates = by_name_pos.get(key, []) if key is not None else []
            if not candidates:
                link_reason = "no_catalog_match"
            elif len(candidates) > 1 or proj_key_counts[key] > 1:
                link_reason = "ambiguous_name_match"
            elif str(candidates[0][1].get("gsis_id") or "").strip():
                link_reason = "gsis_disagrees"  # pid has no catalog hit, so any gsis differs
            else:
                (sid, meta), match = candidates[0], "name"
        reason = None
        if w is not None and r is not None and (
                normalize_team(w.get("team")) != normalize_team(r.get("team"))
                or (r.get("position") is not None and r.get("position") != w.get("position"))):
            reason = "projection_identity_conflict"
        elif position is None:
            reason = "no_projection"
        elif link_reason is not None:
            reason = link_reason
        elif normalize_team(meta.get("team")) != normalize_team(team):
            reason = "team_disagrees"
        elif meta.get("position") != position:
            reason = "position_disagrees"
        if position is not None:
            crosswalk[f"matched_{match}" if match else "unmatched"] += 1
        name = (meta.get("full_name") if meta is not None and meta.get("full_name")
                else proj_name)
        players.append({"player_id": pid, "sleeper_id": sid, "name": name, "team": team,
                        "position": position, "bye": byes.get(normalize_team(team)),
                        "ecr": ranks.get(pid), "identity_only": reason is not None,
                        "reason": reason, "match": match})
    return {**ctx.header(), "schema_version": 1, "kind": "neutral_players",
            "ecr_source": ecr_source, "crosswalk": crosswalk, "players": players}
