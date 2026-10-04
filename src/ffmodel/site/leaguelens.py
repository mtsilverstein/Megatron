"""Python twin of site/assets/leaguelens.js (spec §4, §3.2). Tables must stay identical."""
from __future__ import annotations

import json
import math
import re
from decimal import Decimal

from ffmodel.formats import AUDIT

POSITIONS = ("QB", "RB", "WR", "TE")
STATS = ("passing_yards", "passing_tds", "passing_interceptions", "carries", "rushing_yards",
         "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds", "fumbles_lost",
         "passing_pick_sixes")
KEYS = {
    "pass_yd": ("passing_yards", None), "pass_td": ("passing_tds", None),
    "pass_int": ("passing_interceptions", None), "pass_int_td": ("passing_pick_sixes", None),
    "rush_yd": ("rushing_yards", None), "rush_td": ("rushing_tds", None), "rush_att": ("carries", None),
    "rec": ("receptions", None), "rec_yd": ("receiving_yards", None), "rec_td": ("receiving_tds", None),
    "fum_lost": ("fumbles_lost", None),
    "bonus_rec_te": ("receptions", ("TE",)), "bonus_rec_rb": ("receptions", ("RB",)),
    "bonus_rec_wr": ("receptions", ("WR",)),
}
APPROX = ("pass_int_td",)
RARE = {"pass_2pt": 2, "rush_2pt": 2, "rec_2pt": 2, "pass_td_40p": 3, "pass_td_50p": 3,
        "rush_td_40p": 3, "rush_td_50p": 3, "rec_td_40p": 3, "rec_td_50p": 3, "st_td": 6, "fum_rec_td": 6}
RECURRING = ("fum", "bonus_fd_qb", "bonus_fd_rb", "bonus_fd_te", "bonus_fd_wr", "pass_fd", "rush_fd", "rec_fd",
             "pass_cmp", "pass_inc", "pass_att", "pass_cmp_40p", "pass_sack", "rec_0_4", "rec_5_9", "rec_10_19",
             "rec_20_29", "rec_30_39", "rec_40p", "rush_40p", "bonus_pass_cmp_25", "bonus_pass_yd_300",
             "bonus_pass_yd_400", "bonus_rec_yd_100", "bonus_rec_yd_200", "bonus_rush_att_20",
             "bonus_rush_rec_yd_100", "bonus_rush_rec_yd_200", "bonus_rush_yd_100", "bonus_rush_yd_200",
             "kr_yd", "pr_yd", "bonus_rush_td_qb")
_IGNORE_RES = [re.compile(f"^(?:{p})$") for p in AUDIT["ignore_patterns"]]


def _ignored(k: str) -> bool:
    return k in AUDIT["ignore_exact"] or any(r.match(k) for r in _IGNORE_RES)


def _finite(v) -> bool:
    return not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)


def _weight(k, v) -> float:
    if not _finite(v):
        raise ValueError(f"Invalid scoring weight: {k}")
    return float(v)


def effective_weights(scoring: dict) -> dict:
    if not isinstance(scoring, dict):
        raise ValueError("Missing scoring settings.")
    out = {p: {} for p in POSITIONS}
    for k, raw in scoring.items():
        if k not in KEYS:
            continue
        v = _weight(k, raw)
        if v == 0:
            continue
        stat, positions = KEYS[k]
        for pos in positions or POSITIONS:
            out[pos][stat] = out[pos].get(stat, 0.0) + v
    for pos in POSITIONS:
        if any(not math.isfinite(w) for w in out[pos].values()):
            raise ValueError("Scoring overflow.")
        out[pos] = {s: w for s, w in out[pos].items() if w != 0}
    return out


def classify(scoring: dict) -> dict:
    weights = effective_weights(scoring)
    res = {"weights": weights, "approx": [], "rare": [], "recurring": [], "ignored": [], "unknown": [],
           "refused": False}
    for k, raw in scoring.items():
        v = _weight(k, raw)
        if v == 0:
            continue
        if k in KEYS:
            if k in APPROX:
                res["approx"].append(k)
        elif k in RARE:
            res["rare" if abs(v) <= RARE[k] else "recurring"].append(k)
        elif k in RECURRING:
            res["recurring"].append(k)
        elif _ignored(k):
            res["ignored"].append(k)
        else:
            res["unknown"].append(k)
            res["recurring"].append(k)
    res["refused"] = all(not weights[p] for p in POSITIONS)
    return res


def plain(x) -> str:
    if not _finite(x):
        raise ValueError("weight must be a finite number")
    x = float(x)
    if x == 0:
        return "0"
    return format(Decimal(repr(x)).normalize(), "f")


def evidence_identity(weights: dict) -> str:
    parts = []
    for pos in POSITIONS:
        ws = weights.get(pos, {})
        inner = ",".join(json.dumps(s) + ":" + json.dumps(plain(ws[s])) for s in sorted(ws))
        parts.append(json.dumps(pos) + ":{" + inner + "}")
    return '{"v":1,"w":{' + ",".join(parts) + "}}"


def reference_score(sq: dict, position: str, weights: dict) -> dict:
    if position not in POSITIONS:
        raise ValueError(f"Unsupported scoring position: {position}")
    if not isinstance(sq, dict) or not isinstance(sq.get("p50"), dict):
        raise ValueError("Incomplete stat quantiles.")
    low_null, high_null = sq.get("p10") is None, sq.get("p90") is None
    if low_null != high_null:
        raise ValueError("Incomplete stat quantiles.")
    bands = not low_null
    if bands and not (isinstance(sq["p10"], dict) and isinstance(sq["p90"], dict)):
        raise ValueError("Incomplete stat quantiles.")
    out = {"p10": 0.0 if bands else None, "p50": 0.0, "p90": 0.0 if bands else None}
    for stat, w in weights.get(position, {}).items():
        mid = sq["p50"].get(stat)
        if not _finite(mid):
            raise ValueError(f"Missing or invalid p50 stat: {stat}")
        out["p50"] += w * mid
        if bands:
            lo, hi = sq["p10"].get(stat), sq["p90"].get(stat)
            if not _finite(lo):
                raise ValueError(f"Missing or invalid p10 stat: {stat}")
            if not _finite(hi):
                raise ValueError(f"Missing or invalid p90 stat: {stat}")
            if not lo <= mid <= hi:
                raise ValueError(f"Malformed band for {stat}")
            a, b = w * lo, w * hi
            out["p10"] += min(a, b)
            out["p90"] += max(a, b)
    if any(v is not None and not math.isfinite(v) for v in out.values()):
        raise ValueError("Scoring overflow.")
    return out
