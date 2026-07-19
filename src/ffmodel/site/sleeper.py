"""Sleeper id crosswalk for draft mode.

Matching is deliberately conservative: exact (whitespace-stripped) gsis_id
first, then normalized name+position ONLY when unambiguous on both sides.
An ambiguous candidate is counted unmatched -- a visible "couldn't match N
players" notice on the site beats a silent wrong strikeout on draft night
(spec: 2026-07-19-sleeper-draft-mode-design.md).
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

# Generation suffixes only. "V" is intentionally NOT stripped: it is a
# plausible real surname token, and no current fantasy-relevant player
# needs it.
_SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}


def _normalize_name(name: str) -> str:
    cleaned = re.sub(r"[.'\-]", "", str(name).lower())
    return " ".join(t for t in cleaned.split() if t not in _SUFFIXES)


def build_crosswalk(board_players: list[dict], sleeper_players: dict) -> tuple[dict, dict]:
    """Map board gsis ``player_id`` -> Sleeper player id.

    Returns ``(mapping, stats)`` where ``stats`` powers the site's visible
    unmatched-count notice: ``{"matched_gsis", "matched_name", "unmatched",
    "unmatched_names"}``.
    """
    # gsis index; a duplicated gsis_id in the dump is a data error -- mark it
    # None (ambiguous) so the gsis path never guesses. Name fallback may
    # still resolve the player.
    by_gsis: dict[str, str | None] = {}
    by_name_pos: dict[tuple[str, str], list[str]] = {}
    for sid, meta in sleeper_players.items():
        if not isinstance(meta, dict):
            continue
        gsis = str(meta.get("gsis_id") or "").strip()
        if gsis:
            by_gsis[gsis] = None if gsis in by_gsis else str(sid)
        full = meta.get("full_name") or " ".join(
            p for p in (meta.get("first_name"), meta.get("last_name")) if p)
        key = (_normalize_name(full), str(meta.get("position") or ""))
        if key[0] and key[1]:
            by_name_pos.setdefault(key, []).append(str(sid))

    board_key_counts: dict[tuple[str, str], int] = {}
    for player in board_players:
        key = (_normalize_name(player["name"]), player["position"])
        board_key_counts[key] = board_key_counts.get(key, 0) + 1

    mapping: dict[str, str] = {}
    stats = {"matched_gsis": 0, "matched_name": 0, "unmatched": 0,
             "unmatched_names": []}
    for player in board_players:
        pid = player["player_id"]
        sid = by_gsis.get(pid)
        if sid is not None:
            mapping[pid] = sid
            stats["matched_gsis"] += 1
            continue
        key = (_normalize_name(player["name"]), player["position"])
        candidates = by_name_pos.get(key, [])
        if len(candidates) == 1 and board_key_counts[key] == 1:
            mapping[pid] = candidates[0]
            stats["matched_name"] += 1
        else:
            stats["unmatched"] += 1
            stats["unmatched_names"].append(player["name"])
    return mapping, stats


SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl"
# Sleeper documents /players/nfl as a <=1-call/day endpoint (~5MB). It is
# only ever called at --draft generation time, never from the browser.
_MIN_PLAYERS = 1000
_MIN_GSIS = 100


def _fetch_players() -> dict:
    from urllib.request import urlopen  # deferred: keep offline unit tests import-light

    with urlopen(SLEEPER_PLAYERS_URL, timeout=120) as resp:
        return json.load(resp)


def _validate_players(data) -> None:
    if not isinstance(data, dict) or len(data) < _MIN_PLAYERS:
        size = len(data) if isinstance(data, dict) else type(data).__name__
        raise RuntimeError(f"sleeper players dump looks suspicious ({size} entries; "
                           f"expected >= {_MIN_PLAYERS}) — refusing to build a crosswalk")
    with_gsis = sum(1 for m in data.values()
                    if isinstance(m, dict) and str(m.get("gsis_id") or "").strip())
    if with_gsis < _MIN_GSIS:
        raise RuntimeError(f"sleeper players dump has only {with_gsis} gsis ids "
                           f"(expected >= {_MIN_GSIS}) — format drift? refusing to "
                           "build a crosswalk")


def pull_sleeper_players(cache_dir: Path | None = None) -> dict:
    """Sleeper's full player dump, cached like the nflverse pulls.

    Raises on any fetch/parse/sanity failure; site.generate lets that
    propagate so a --draft run aborts before writing anything (fail-safe:
    the published site keeps its last-good data AND last-good crosswalk).
    """
    path = Path(cache_dir) / "sleeper_players.json" if cache_dir is not None else None
    if path is not None and path.exists():
        data = json.loads(path.read_text())
        _validate_players(data)   # a stale/corrupt cache must not slip through
        return data
    data = _fetch_players()
    _validate_players(data)
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        try:
            tmp.write_text(json.dumps(data))
            os.replace(tmp, path)
        finally:
            if tmp.exists():
                tmp.unlink()
    return data
