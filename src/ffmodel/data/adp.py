"""Average draft position from FantasyFootballCalculator's free JSON API.

The crowd's market a drafter faces, snapshotted before drafts complete (ADP is
pre-draft by construction, so it is leak-safe for a preseason board). Never a
model input — only a display/keeper overlay. Crosswalked to gsis_id with the
same normalize-then-nickname approach the ADP benchmark used."""
from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

import pandas as pd

from ffmodel.data.pull import POSITIONS, _cached
from ffmodel.data.rankings import pull_player_ids

# FFCalculator display name -> nflverse merge_name form (known mismatches).
NICK = {"hollywood brown": "marquise brown", "kenny gainwell": "kenneth gainwell",
        "gabe davis": "gabriel davis", "chig okonkwo": "chigoziem okonkwo"}
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def norm(name: str) -> str:
    s = (str(name).lower().replace(".", "").replace("'", "")
         .replace(",", "").replace("-", " "))
    s = re.sub(r"\s+", " ", SUFFIX.sub("", s)).strip()
    return NICK.get(s, s)


def normalize_adp(raw: dict, crosswalk: pd.DataFrame) -> pd.DataFrame:
    """Reduce a raw FFCalculator `/adp` payload to in-scope players on gsis ids."""
    df = pd.DataFrame(raw["players"])
    df = df[df["position"].isin(POSITIONS)].copy()
    x = crosswalk[crosswalk["gsis_id"].notna()].copy()
    x["_k"] = x["merge_name"].map(norm)
    by_name = x.drop_duplicates("_k").set_index("_k")["gsis_id"]
    df["player_id"] = df["name"].map(norm).map(by_name)
    df = df.dropna(subset=["player_id"]).drop_duplicates("player_id")
    for col in ("stdev", "times_drafted"):
        if col not in df.columns:
            df[col] = pd.NA
    return df[["player_id", "name", "position", "adp", "stdev",
               "times_drafted"]].reset_index(drop=True)


def pull_adp(season: int, cache_dir: Path | None = None, teams: int = 12,
             scoring: str = "ppr") -> pd.DataFrame:
    """Current FFCalculator ADP for `season`, normalized on our ids."""
    url = (f"https://fantasyfootballcalculator.com/api/v1/adp/{scoring}"
           f"?teams={teams}&year={season}&position=all")

    def load() -> pd.DataFrame:
        # FFCalculator 403s the default urllib UA; a browser UA is required.
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        return normalize_adp(raw, pull_player_ids(cache_dir))

    return _cached(cache_dir, f"adp_{scoring}_{teams}_{season}", load)


# K/DST are OUT of model scope (kickers/defenses do not predict year to year),
# so they get no projection -- only the crowd's ADP, as a late-round slot
# reminder. Display-only, hence no gsis crosswalk.
# FFCalculator labels kickers "PK" (verified against the live /adp endpoint);
# "K" is kept as a defensive alias in case another endpoint uses it. Our
# OUTPUT key stays "K" either way -- the site consumes late_slots.K.
LATE_SLOT_POSITIONS = {"PK": "K", "K": "K", "DEF": "DST"}


def late_slot_adp(raw: dict) -> dict:
    """K/DST rows from a raw FFCalculator `/adp` payload, ADP-ascending."""
    out: dict[str, list] = {"K": [], "DST": []}
    for row in raw.get("players", []):
        key = LATE_SLOT_POSITIONS.get(row.get("position"))
        if key is None:
            continue
        out[key].append({"name": row["name"], "adp": float(row["adp"])})
    for key in out:
        out[key].sort(key=lambda r: r["adp"])
    return out
