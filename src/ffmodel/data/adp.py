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


# --- Sleeper-population ADP: committed FantasyPros snapshot ---------------
#
# Sleeper (the project's actual keeper league host) publishes no ADP API.
# This is a manually-exported FantasyPros CSV that carries Sleeper's own ADP
# column alongside several other platforms' -- deliberately static and
# committed, so the weekly GitHub Actions cron never grows a new network
# dependency for it. The whole point: FFCalculator's population is
# self-selected mock drafters with no money at stake, while Sleeper's ADP
# reflects the actual population this league's drafter faces. Refresh by
# re-exporting and updating SNAPSHOT_PATH; nothing here scrapes it.
SNAPSHOT_PATH = Path("data_snapshots/fantasypros_adp_2026-07-27.csv")

# The export marks "not ranked on this platform" with an em-dash, never an
# empty cell or a 0 -- a missing Sleeper ADP must never be coerced to either.
_MISSING = "—"

# Packed "Name   TEAM (bye)" field, gap of 2+ spaces. Unsigned free agents
# (no current team) carry just the name -- no team/bye suffix at all.
_PLAYER_BYE = re.compile(r"^(?P<name>.+?)\s{2,}(?P<team>[A-Z]{2,4})\s+\((?P<bye>\d+)\)$")

# Snapshot filenames end in _YYYY-MM-DD.csv; provenance reads the date from
# there rather than a second hardcoded constant, so a refreshed snapshot
# (new SNAPSHOT_PATH, same naming convention) stays correct for free.
_SNAPSHOT_DATE = re.compile(r"_(\d{4}-\d{2}-\d{2})\.csv$")

# Same floor as rankings.MIN_MATCH_RATE -- below this the crosswalk is too
# thin to trust this as the board's ADP source.
MIN_SNAPSHOT_MATCH_RATE = 0.95


def snapshot_date(path: Path = SNAPSHOT_PATH) -> str:
    """Capture date parsed from the snapshot's own filename convention."""
    m = _SNAPSHOT_DATE.search(Path(path).name)
    if not m:
        raise ValueError(f"{path}: filename doesn't end in _YYYY-MM-DD.csv -- "
                         f"cannot derive the ADP snapshot's provenance date")
    return m.group(1)


def parse_player_bye(raw: str) -> tuple[str, str | None, int | None]:
    """Split the export's packed "Name   TEAM (bye)" field.

    Unsigned free agents (no current NFL team) carry just the name in this
    export -- team and bye come back None rather than a guessed value.
    """
    s = str(raw).strip()
    m = _PLAYER_BYE.match(s)
    if not m:
        return s, None, None
    return m.group("name").strip(), m.group("team"), int(m.group("bye"))


def parse_snapshot_csv(path: Path) -> pd.DataFrame:
    """Read the committed snapshot CSV and reduce it to in-scope rows that
    actually carry a Sleeper ADP, with name/position/adp parsed out.

    Pure function of the file at `path` -- no crosswalk, no network. Scope
    is filtered to QB/RB/WR/TE here (CLAUDE.md's scope guard), same as the
    FFCalculator path's `normalize_adp`; the live snapshot happens to carry
    zero Sleeper-ranked K/DST rows already (verified), so this filter is
    belt-and-suspenders against a future export ever changing that -- K/DST
    ADP stays sourced from FFCalculator via `late_slot_adp` regardless (see
    that function's docstring for why swapping it would silently empty the
    late-slot block).
    """
    raw = pd.read_csv(path, encoding="utf-8")
    sleeper_raw = raw["Sleeper"]
    missing = sleeper_raw.isna() | sleeper_raw.astype(str).str.strip().isin(["", _MISSING])
    df = raw[~missing].copy()
    df["position"] = df["POS"].astype(str).str.replace(r"\d+$", "", regex=True)
    df = df[df["position"].isin(POSITIONS)]
    parsed = df["Player (Bye)"].map(parse_player_bye)
    df["name"] = [p[0] for p in parsed]
    df["adp"] = pd.to_numeric(sleeper_raw.loc[df.index], errors="raise")
    return df[["name", "position", "adp"]].reset_index(drop=True)


def normalize_snapshot_adp(raw: pd.DataFrame, crosswalk: pd.DataFrame,
                           min_match_rate: float = MIN_SNAPSHOT_MATCH_RATE
                           ) -> tuple[pd.DataFrame, dict]:
    """Crosswalk `parse_snapshot_csv`'s output onto gsis ids, in `pull_adp`'s
    output shape (same columns, `stdev`/`times_drafted` filled as <NA> since
    this source doesn't carry them).

    Reuses the FFCalculator path's `norm()` for name matching -- no separate
    suffix-stripping logic, since both feeds hit the same nickname/Jr/Sr/II
    edge cases and `norm()` already strips them.

    Matching is position-aware, same discipline as rankings.attach_gsis's
    name fallback: primary key is (normalized name, position), which
    disambiguates real crosswalk collisions -- e.g. "justin jefferson" is
    both an LB (CLE) and the WR (MIN); "lamar jackson" is both a CB (CAR)
    and the QB (BAL). A plain name-only join can silently hand the WR's/QB's
    ADP to the wrong player. Beneath that, a name-only fallback still runs,
    but built ONLY from in-scope (QB/RB/WR/TE) crosswalk rows, so it can add
    a match when the two feeds disagree on a position label (RB/FB, WR/TE
    tweeners) without ever letting an out-of-scope namesake (the LB, the CB)
    win.

    Below `min_match_rate` this raises, naming every unmatched player (mirrors
    rankings.attach_gsis's MIN_MATCH_RATE guard) -- a silently-thinned ADP
    source would degrade the market overlay without anyone noticing.

    Returns `(matched_df, stats)`; `stats` breaks the match out by which key
    resolved it (`matched_by_position` vs `matched_by_name`) so a silent
    crosswalk collision can never hide inside a single aggregate count.
    """
    x = crosswalk[crosswalk["gsis_id"].notna()].copy()
    x["_k"] = x["merge_name"].map(norm)
    by_name_pos = (x.drop_duplicates(subset=["_k", "position"])
                   .set_index(["_k", "position"])["gsis_id"].to_dict())
    in_scope = x[x["position"].isin(POSITIONS)]
    by_name = in_scope.drop_duplicates("_k").set_index("_k")["gsis_id"]

    df = raw.copy()
    df["_k"] = df["name"].map(norm)
    key_pos = pd.Series(list(zip(df["_k"], df["position"])), index=df.index)
    # `.astype(object)`: see attach_gsis's identical comment -- when the
    # first map is entirely unmatched (e.g. `by_name_pos` has no entries),
    # pandas 3's default nullable-string dtype rejects the later
    # `.loc[need, ...] = <gsis strings or NaN>` assignment instead of
    # upcasting, even though both sides are legitimately all-missing.
    df["player_id"] = key_pos.map(by_name_pos).astype(object)
    matched_by_position = int(df["player_id"].notna().sum())
    need = df["player_id"].isna()
    df.loc[need, "player_id"] = df.loc[need, "_k"].map(by_name)
    matched_by_name = int(df["player_id"].notna().sum()) - matched_by_position

    unmatched = df[df["player_id"].isna()]
    matched = (df.dropna(subset=["player_id"]).drop_duplicates("player_id")
               .reset_index(drop=True))

    match_rate = (len(matched) / len(df)) if len(df) else 1.0
    if len(df) and match_rate < min_match_rate:
        names = sorted(unmatched["name"].tolist())
        raise ValueError(
            f"Sleeper-ADP snapshot crosswalk matched only {match_rate:.1%} of "
            f"{len(df)} players with a Sleeper ADP (floor {min_match_rate:.0%}) "
            f"-- unmatched: {names} -- refusing to publish a partially-"
            f"crosswalked ADP source"
        )
    for col in ("stdev", "times_drafted"):
        matched[col] = pd.NA
    stats = {
        "ranked": int(len(df)),
        "matched_by_position": matched_by_position,
        "matched_by_name": matched_by_name,
        "unmatched": int(len(unmatched)),
        "unmatched_players": sorted(unmatched["name"].tolist()),
        "match_rate": match_rate,
    }
    return matched[["player_id", "name", "position", "adp", "stdev",
                    "times_drafted"]], stats


def load_snapshot_adp(path: Path, crosswalk: pd.DataFrame,
                      min_match_rate: float = MIN_SNAPSHOT_MATCH_RATE
                      ) -> tuple[pd.DataFrame, dict]:
    """Sleeper ADP from the committed snapshot at `path`, on gsis ids.

    Pure function of the file plus the crosswalk it's given -- no network,
    no hidden global state -- so it is directly unit-testable with a small
    on-disk CSV and a synthetic crosswalk (no fixtures-on-the-internet).
    """
    return normalize_snapshot_adp(parse_snapshot_csv(path), crosswalk, min_match_rate)


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
