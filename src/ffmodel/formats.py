"""League formats and their fingerprint (spec 2026-09-30 roster-sim v2, section 4).

A *format* is a synthetic league config in ``configs/formats/``. Every verdict
is keyed on two frozen parts, both required for a match:

* ``format_key`` -- SHA-256 of a canonical JSON of team count, the offensive
  starter-slot multiset (with eligibility), total offensive roster size, and
  the weights of the PREDICTED stat components.
* ``compat`` -- every non-predicted offensive Sleeper scoring setting (omitted
  -> 0). A live league matches a format only if ``compat`` is equal and it
  carries no unknown nonzero offensive setting (fail closed).

``site/assets/formats.js`` implements the same thing; the audit table below
(``AUDIT``) is duplicated there and a fixture asserts the two are identical.
Unknown is never zero: an unclassifiable nonzero key lands in ``compat`` under
its own name, where it can equal nothing a format declares.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from ffmodel.league import LeagueConfig, load_league
from ffmodel.scoring import PREDICTED_STATS, stat_weights

FORMAT_DIR = Path("configs/formats")

# Sleeper scoring key -> predicted stat column. `carries` and `targets` are
# predicted but unscored (weight 0 in every league), so no Sleeper key maps to them.
PREDICTED_KEYS = {
    "pass_yd": "passing_yards", "pass_td": "passing_tds",
    "pass_int": "passing_interceptions", "rush_yd": "rushing_yards",
    "rush_td": "rushing_tds", "rec_yd": "receiving_yards",
    "rec_td": "receiving_tds", "rec": "receptions", "fum_lost": "fumbles_lost",
}

# Offensive keys the model does NOT predict. Always present in `compat` (0 if omitted).
COMPAT_KEYS = sorted([
    "pass_int_td", "pass_td_50p", "pass_td_40p", "rush_td_50p", "rush_td_40p",
    "rec_td_50p", "rec_td_40p", "pass_2pt", "rush_2pt", "rec_2pt", "st_td",
    "fum_rec_td", "bonus_rec_te", "bonus_rec_rb", "bonus_rec_wr",
    "bonus_fd_qb", "bonus_fd_rb", "bonus_fd_te", "bonus_fd_wr",
    "pass_cmp", "pass_inc", "pass_att", "pass_cmp_40p", "pass_fd", "pass_sack",
    "rush_att", "rush_40p", "rush_fd", "rec_fd", "rec_0_4", "rec_5_9",
    "rec_10_19", "rec_20_29", "rec_30_39", "rec_40p", "fum", "kr_yd", "pr_yd",
    "bonus_pass_cmp_25", "bonus_pass_yd_300", "bonus_pass_yd_400",
    "bonus_rec_yd_100", "bonus_rec_yd_200", "bonus_rush_att_20",
    "bonus_rush_rec_yd_100", "bonus_rush_rec_yd_200", "bonus_rush_td_qb",
    "bonus_rush_yd_100", "bonus_rush_yd_200",
])

# K / DEF / IDP keys: ignored (those slots are dropped before the key is computed).
IGNORE_EXACT = sorted(["int", "ff", "fum_rec", "safe", "blk_kick", "st_ff", "st_fum_rec"])
IGNORE_PREFIX = sorted([
    "fgm", "xp", "pts_allow", "yds_allow", "def_", "idp_", "tkl", "bonus_def_",
    "bonus_sack", "bonus_tkl", "blk_kick", "fg_ret", "int_ret", "sack",
    "fum_ret", "st_tkl", "qb_hit",
])

DROP_SLOTS = ("K", "DEF", "IR", "TAXI")
SLOT_ELIGIBLE = {
    "QB": ["QB"], "RB": ["RB"], "WR": ["WR"], "TE": ["TE"],
    "FLEX": ["RB", "TE", "WR"], "WRRB_FLEX": ["RB", "WR"],
    "REC_FLEX": ["TE", "WR"], "SUPER_FLEX": ["QB", "RB", "TE", "WR"],
}

AUDIT = {
    "predicted_keys": PREDICTED_KEYS, "predicted_stats": list(PREDICTED_STATS),
    "compat_keys": COMPAT_KEYS, "ignore_exact": IGNORE_EXACT,
    "ignore_prefix": IGNORE_PREFIX, "drop_slots": sorted(DROP_SLOTS),
    "slot_eligible": SLOT_ELIGIBLE,
}


def _num(x: float):
    r = round(float(x), 6)
    if r == 0:
        return 0
    return int(r) if r == int(r) else r


def canonical(obj) -> str:
    def norm(o):
        if isinstance(o, dict):
            return {k: norm(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [norm(v) for v in o]
        if isinstance(o, bool) or o is None or isinstance(o, str):
            return o
        if isinstance(o, (int, float)):
            return _num(o)
        raise TypeError(type(o))
    return json.dumps(norm(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _sorted_slots(slots):
    return sorted(([n, sorted(e)] for n, e in slots), key=lambda s: (s[0], ",".join(s[1])))


def describe(cfg: LeagueConfig) -> dict:
    """The format-key content for a config: teams, slots, roster_size, predicted."""
    if cfg.roster_size is None:
        raise ValueError(f"{cfg.slug}: roster_size is required to fingerprint a league")
    slots = [(pos, [pos]) for pos, n in cfg.roster.items() for _ in range(n)]
    flex_name = "SUPER_FLEX" if "QB" in cfg.flex_positions else "FLEX"
    if sorted(cfg.flex_positions) != SLOT_ELIGIBLE[flex_name]:
        raise ValueError(f"{cfg.slug}: flex_positions {cfg.flex_positions} is not {flex_name}")
    slots += [(flex_name, SLOT_ELIGIBLE[flex_name])] * cfg.flex
    w = stat_weights(cfg.rules)
    return {"teams": cfg.teams, "slots": _sorted_slots(slots), "roster_size": cfg.roster_size,
            "predicted": {c: w.get(c, 0.0) for c in PREDICTED_STATS}}


def _classify(key: str) -> str:
    if key in PREDICTED_KEYS:
        return "predicted"
    if key in COMPAT_KEYS:
        return "compat"
    if key in IGNORE_EXACT or any(key.startswith(p) for p in IGNORE_PREFIX):
        return "ignore"
    return "unknown"


def split_scoring(scoring: dict) -> tuple[dict, dict]:
    """(predicted {stat column: weight}, compat {key: value}) from Sleeper scoring_settings."""
    predicted = {c: 0.0 for c in PREDICTED_STATS}
    compat = {k: 0.0 for k in COMPAT_KEYS}
    for key, val in scoring.items():
        kind = _classify(key)
        if kind == "predicted":
            predicted[PREDICTED_KEYS[key]] = float(val)
        elif kind == "compat":
            compat[key] = float(val)
        elif kind == "unknown" and float(val) != 0:
            compat[key] = float(val)   # fails closed: no format declares this key
    return predicted, {k: _num(v) for k, v in sorted(compat.items())}


def _digest(desc: dict) -> str:
    return hashlib.sha256(canonical(desc).encode("utf-8")).hexdigest()


def format_key(cfg: LeagueConfig) -> str:
    return _digest(describe(cfg))


def compat(cfg: LeagueConfig) -> dict[str, float]:
    if cfg.sleeper_scoring is None:
        raise ValueError(f"{cfg.slug}: sleeper_scoring is required to fingerprint a league")
    return split_scoring(cfg.sleeper_scoring)[1]


def describe_sleeper(league: dict) -> tuple[dict, dict]:
    """(format-key content, compat) from a Sleeper /league/<id> payload. Raises
    ValueError on a roster slot it cannot classify (fail closed)."""
    slots, size = [], 0
    for pos in league["roster_positions"]:
        if pos in DROP_SLOTS:
            continue
        size += 1
        if pos == "BN":
            continue
        if pos not in SLOT_ELIGIBLE:
            raise ValueError(f"unknown roster slot {pos!r}")
        slots.append((pos, SLOT_ELIGIBLE[pos]))
    predicted, cmp_ = split_scoring(league["scoring_settings"])
    return ({"teams": int(league["total_rosters"]), "slots": _sorted_slots(slots),
             "roster_size": size, "predicted": predicted}, cmp_)


def from_sleeper(league: dict) -> tuple[str, dict]:
    desc, cmp_ = describe_sleeper(league)
    return _digest(desc), cmp_


def load_format(label: str) -> LeagueConfig:
    return load_league(label, root=FORMAT_DIR)


def match(league_payload: dict, formats) -> str | None:
    """Label of the format whose key AND compat equal the league's, else None.
    `formats` is an iterable of labels or LeagueConfigs. No nearest-format fallback."""
    try:
        key, cmp_ = from_sleeper(league_payload)
    except (ValueError, KeyError, TypeError):
        return None
    hits = []
    for f in formats:
        cfg = load_format(f) if isinstance(f, str) else f
        if format_key(cfg) == key and compat(cfg) == cmp_:
            hits.append(cfg.slug)
    return hits[0] if len(hits) == 1 else None
