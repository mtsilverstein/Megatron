"""FantasyPros expert-consensus rankings (ECR) — the market benchmark.

The consensus a drafter could have had for free, snapshotted STRICTLY
before a season's first game so nothing in-season can leak into it. This is
the only external opinion the project consumes; it is never a model input,
only an evaluation entrant (see eval/consensus.py).

Leak discipline, three layers:

1. `preseason_snapshot` refuses to fall back to a post-kickoff scrape. The
   real 2023 feed makes this load-bearing -- its latest early-September
   scrape is 2023-09-08, one day AFTER week-1 kickoff, so a naive "latest
   scrape" would silently rank players using week-1 results.
2. Rest-of-season pages are filtered out by name. The
   (ecr_type="ro", page_type="redraft-overall") slice spans BOTH the
   preseason cheatsheet and an in-season "ros-*" page; without this filter
   an ROS scrape landing before a future kickoff would silently become the
   "preseason" consensus.
3. `preseason_snapshot` asserts the winning date carries exactly one source
   page, so two pages sharing a date can never be silently merged (which
   would let the ecr-ascending dedupe cherry-pick the friendlier ranking).
"""
from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

from ffmodel.data.pull import LIVE_MAX_AGE_HOURS, POSITIONS, _cached

# FantasyPros publishes many ranking flavors in one frame; these two select
# the preseason redraft consensus ("ro" = redraft overall).
ECR_TYPE = "ro"
ECR_PAGE = "redraft-overall"
# Path-segment marker for rest-of-season pages inside that slice (layer 2).
# Must be anchored: a bare "ros" also matches the "fantasypros.com" domain
# and would silently filter out every row.
ROS_PAGE_PATTERN = r"/ros-"
# Below this id+name match rate the consensus pool is too thin to benchmark
# against honestly -- a partial crosswalk degradation would otherwise yield a
# quietly unrepresentative, publishable-looking number.
MIN_MATCH_RATE = 0.95

# Whitelisted columns. The raw frame carries image URLs, ownership rates and
# rank deltas we never want flowing into an evaluation. `fp_page` is kept so
# the source page stays auditable from a cached snapshot after the fact.
RANKING_COLUMNS = ["fp_id", "player", "pos", "team", "ecr", "sd", "best",
                   "worst", "mergename", "scrape_date", "fp_page"]

# --- hand-dropped ECR snapshot ---------------------------------------------
# WHY THIS EXISTS. ECR normally arrives through nflverse's mirror of
# FantasyPros (`pull_rankings`), which publishes weekly and lags the source by
# days. That is fine in the abstract and not fine in the last fortnight before
# a draft, when camp injuries move the consensus faster than the mirror
# refreshes: on 2026-08-25 the newest mirrored scrape was 2026-08-21, four days
# behind a FantasyPros export the owner could download in a browser.
#
# ECR is this board's SPINE -- `order_and_value` sorts every position by it and
# lays the model's value curve onto that order -- so a stale consensus is not a
# stale garnish, it is a stale board. This path lets a fresh export be used
# directly, exactly as `adp.py` already allows for the market overlay.
#
# The snapshot is PREFERRED when present and the mirror remains the fallback,
# so deleting the file restores the previous behaviour with no code change.
ECR_SNAPSHOT_PATH = Path("data_snapshots/fantasypros_ecr_2026-08-31.csv")

# Snapshot filenames end in _YYYY-MM-DD.csv, same convention (and same reason)
# as adp.SNAPSHOT_PATH: provenance is read off the filename rather than kept
# in a second hardcoded constant that can drift from the file it describes.
_ECR_SNAPSHOT_DATE = re.compile(r"_(\d{4}-\d{2}-\d{2})\.csv$")

# The export packs positional rank into the POS cell ("WR1", "RB12").
_ECR_POS = re.compile(r"^([A-Z]+)\d*$")

# NO FANTASYPROS ID IN THIS EXPORT. The mirrored feed carries `fp_id` and
# `attach_gsis` uses it as the primary join key; the browser export does not
# have that column at all, so every row matches by (normalized name, position)
# instead -- attach_gsis's fallback, which is position-aware precisely so a
# collision like "justin jefferson" (LB CLE vs WR MIN) cannot hand one
# player's rank to another. `fp_id` is still emitted as NA so the frame keeps
# the RANKING_COLUMNS contract and the id join simply matches nothing.
ECR_SNAPSHOT_PAGE = "snapshot:fantasypros-draft-all-rankings"


def ecr_snapshot_date(path: Path = ECR_SNAPSHOT_PATH) -> str:
    """Capture date parsed from the snapshot's own filename convention."""
    m = _ECR_SNAPSHOT_DATE.search(Path(path).name)
    if not m:
        raise ValueError(f"{path}: filename doesn't end in _YYYY-MM-DD.csv -- "
                         f"cannot derive the ECR snapshot's provenance date")
    return m.group(1)


def parse_ecr_snapshot_csv(path: Path = ECR_SNAPSHOT_PATH) -> pd.DataFrame:
    """A FantasyPros "Draft ALL Rankings" export, in `normalize_rankings`'
    output shape so every downstream consumer is unchanged.

    `RK` becomes `ecr`. The export gives an integer overall rank where the
    mirror gives a float consensus average; both are only ever used to ORDER
    players within a position, so the integer is not a loss of information the
    board can see. `sd`/`best`/`worst` have no export equivalent and stay NA --
    nothing on the draft path reads them.
    """
    raw = pd.read_csv(path)
    missing = {"RK", "PLAYER NAME", "TEAM", "POS"} - set(raw.columns)
    if missing:
        raise ValueError(f"{path}: ECR export is missing column(s) "
                         f"{sorted(missing)} -- refusing to guess its schema")
    df = pd.DataFrame({
        "player": raw["PLAYER NAME"].astype(str).str.strip(),
        "team": raw["TEAM"].astype(str).str.strip(),
        "ecr": pd.to_numeric(raw["RK"], errors="coerce"),
    })
    df["pos"] = (raw["POS"].astype(str).str.strip()
                 .str.extract(_ECR_POS, expand=False))
    # K/DST are out of v1 scope and carry no board row; dropping them here
    # keeps the match-rate guard below honest, since an unmatchable kicker is
    # not evidence the crosswalk is broken.
    df = df[df["pos"].isin(POSITIONS)]
    df = df[df["ecr"].notna() & (df["player"].str.len() > 0)]
    df["fp_id"] = pd.NA
    df["sd"] = pd.NA
    df["best"] = pd.NA
    df["worst"] = pd.NA
    df["mergename"] = df["player"]
    df["scrape_date"] = pd.Timestamp(ecr_snapshot_date(path))
    df["fp_page"] = ECR_SNAPSHOT_PAGE
    return df[RANKING_COLUMNS].reset_index(drop=True)


# Ranks past this cannot change a decision in a 12-team, 15-round league: the
# player goes undrafted. The crosswalk guard below is scored over the players
# inside it, for the same reason adp.DRAFTABLE_ADP exists -- on 2026-08-15 a
# whole-file match rate refused a perfectly good ADP overlay because a deeper
# export had added camp bodies the identity feed does not carry.
DRAFTABLE_ECR = 180


def normalize_ecr_snapshot(raw: pd.DataFrame, crosswalk: pd.DataFrame,
                           min_match_rate: float = MIN_MATCH_RATE
                           ) -> tuple[pd.DataFrame, dict]:
    """Crosswalk a parsed ECR snapshot onto gsis ids.

    Deliberately NOT `attach_gsis`. That function's primary key is
    `fantasypros_id`, which the browser export does not have, and its name
    fallback normalizes with `_merge_key` (lowercase only) because the two
    nflverse feeds already agree on everything else. A hand-dropped export
    does not: it writes "Harold Fannin Jr." where the crosswalk holds "harold
    fannin". So this reuses `adp.norm` -- suffix- and punctuation-stripping,
    applied to BOTH sides -- which is the same normalizer the Sleeper ADP
    snapshot uses against the same crosswalk, for the same reason.

    Matching is position-aware first, exactly as the ADP snapshot path is: a
    plain name join can hand the WR Justin Jefferson's rank to the LB of the
    same name. The name-only fallback beneath it is built from in-scope rows
    only, so an out-of-scope namesake can never win.
    """
    from ffmodel.data.adp import norm   # deferred: adp imports this module

    x = crosswalk[crosswalk["gsis_id"].notna()].copy()
    x["_k"] = x["merge_name"].map(norm)
    by_name_pos = (x.drop_duplicates(subset=["_k", "position"])
                   .set_index(["_k", "position"])["gsis_id"].to_dict())
    in_scope = x[x["position"].isin(POSITIONS)]
    by_name = in_scope.drop_duplicates("_k").set_index("_k")["gsis_id"]

    df = raw.copy()
    df["_k"] = df["player"].map(norm)
    key_pos = pd.Series(list(zip(df["_k"], df["pos"])), index=df.index)
    df["player_id"] = key_pos.map(by_name_pos).astype(object)
    matched_by_position = int(df["player_id"].notna().sum())
    need = df["player_id"].isna()
    df.loc[need, "player_id"] = df.loc[need, "_k"].map(by_name)
    matched_by_name = int(df["player_id"].notna().sum()) - matched_by_position

    draftable = df[df["ecr"] <= DRAFTABLE_ECR]
    draftable_rate = (float(draftable["player_id"].notna().mean())
                      if len(draftable) else 1.0)
    if len(draftable) and draftable_rate < min_match_rate:
        names = sorted(draftable[draftable["player_id"].isna()]["player"].tolist())
        raise ValueError(
            f"ECR snapshot crosswalk matched only {draftable_rate:.1%} of the "
            f"{len(draftable)} players inside the draft (rank <= "
            f"{DRAFTABLE_ECR}, floor {min_match_rate:.0%}) -- unmatched: "
            f"{names} -- refusing to publish a partially-crosswalked ECR spine"
        )

    unmatched = df[df["player_id"].isna()]
    matched = (df.dropna(subset=["player_id"])
               .sort_values("ecr", kind="mergesort")
               .drop_duplicates("player_id")
               .reset_index(drop=True))
    stats = {
        "ranked": int(len(df)),
        "draftable_ranked": int(len(draftable)),
        "draftable_match_rate": round(draftable_rate, 4),
        "matched_by_id": 0,          # the export carries no FantasyPros id
        "matched_by_position": matched_by_position,
        "matched_by_name": matched_by_name,
        "matched_by_name_position": matched_by_position,
        "matched_by_name_only": matched_by_name,
        "unmatched": int(len(unmatched)),
        "unmatched_players": sorted(unmatched["player"].tolist()),
        "gsis_collisions": 0,
        "match_rate": round(len(matched) / len(df), 4) if len(df) else 1.0,
    }
    return matched[["player_id", "player", "pos", "team", "ecr",
                    "scrape_date", "fp_page"]], stats


def _merge_key(names: pd.Series) -> pd.Series:
    """Normalize a name to a case/space-insensitive merge key.

    The feeds disagree on case: ff_rankings' `mergename` has been Title-Case
    since 2022 while ff_playerids' `merge_name` is lowercase, so a raw
    equality join silently matched 0% and the fallback was dead code.
    """
    return names.astype(str).str.strip().str.lower()


def _fp_key(s: pd.Series) -> pd.Series:
    """Normalize a FantasyPros id to one canonical string key.

    The feeds disagree on dtype: ff_playerids' crosswalk stores
    `fantasypros_id` as float64 (`22953.0`) while the rankings snapshot's
    `fp_id` is a clean string (`"22953"`), so a raw `.astype(str)` join
    silently matched 0% and the id-primary join was dead code. Coercing
    through numeric first makes `22953.0`, `"22953.0"`, `22953` and
    `"22953"` all collapse to `"22953"`. Nulls stay null -- they are never
    coerced to the literal string "nan", so two absent ids can never
    collide with each other in the id map.
    """
    v = pd.to_numeric(s, errors="coerce")
    return v.astype("Int64").astype(str).where(v.notna())


def normalize_rankings(raw: pd.DataFrame) -> pd.DataFrame:
    """Reduce a raw `load_ff_rankings("all")` frame to the preseason redraft
    consensus for in-scope positions, with a whitelisted column set."""
    df = raw[(raw["ecr_type"] == ECR_TYPE) & (raw["page_type"] == ECR_PAGE)].copy()
    df = df[df["pos"].isin(POSITIONS)]
    if "fp_page" not in df.columns:
        df["fp_page"] = ""
    # layer 2: drop rest-of-season pages, which are in-season by construction
    df = df[~df["fp_page"].astype(str).str.contains(ROS_PAGE_PATTERN, case=False,
                                                     regex=True, na=False)]
    df["scrape_date"] = pd.to_datetime(df["scrape_date"])
    # ids arrive as str or int depending on the source parquet's dtype
    df["fp_id"] = df["id"].astype(str).str.strip()
    return df[RANKING_COLUMNS].reset_index(drop=True)


def season_kickoff(schedules: pd.DataFrame, season: int) -> pd.Timestamp:
    """First REGULAR-season kickoff for `season` — the leak boundary.

    `game_type` is OPTIONAL: `pull_schedules` already filters to REG and
    drops the column, so the project's own schedule frames never carry it.
    When it is present (a raw nflverse frame) it is honored, so a preseason
    game can never pull the boundary earlier than the real week-1 kickoff.
    """
    games = schedules[schedules["season"] == season]
    if "game_type" in games.columns:
        games = games[games["game_type"] == "REG"]
    if games.empty:
        raise ValueError(f"no REG games for season {season} — cannot place "
                         f"the consensus leak boundary")
    return pd.to_datetime(games["gameday"]).min()


def preseason_snapshot(rankings: pd.DataFrame, kickoff: pd.Timestamp) -> pd.DataFrame:
    """The latest consensus snapshot STRICTLY before `kickoff`.

    Raises rather than falling back when no pre-kickoff scrape exists: a
    post-kickoff ranking is not a preseason opinion, and silently using one
    would leak realized results into the benchmark.
    """
    before = rankings[rankings["scrape_date"] < kickoff]
    if before.empty:
        raise ValueError(
            f"no consensus scrape before kickoff {kickoff.date()} — refusing "
            f"to fall back to a post-kickoff ranking"
        )
    latest = before["scrape_date"].max()
    snap = before[before["scrape_date"] == latest].reset_index(drop=True)
    pages = sorted(set(snap["fp_page"].astype(str)))
    if len(pages) > 1:
        raise ValueError(
            f"consensus snapshot {latest.date()} spans multiple source pages "
            f"{pages} — refusing to merge distinct rankings into one board"
        )
    return snap


def attach_gsis(snapshot: pd.DataFrame, crosswalk: pd.DataFrame,
                min_match_rate: float = MIN_MATCH_RATE
                ) -> tuple[pd.DataFrame, dict]:
    """Map consensus rows onto our `player_id` (gsis_id).

    Primary key is `fantasypros_id`; a normalized name is the fallback (the
    same id-then-name pattern the Sleeper crosswalk uses). The id join stays
    primary and untouched -- this only hardens the fallback beneath it.

    The name fallback is itself position-aware: it first tries (normalized
    name, position), which disambiguates real crosswalk collisions such as
    "justin jefferson" (an LB in CLE vs the WR in MIN) or "lamar jackson" (a
    CB in CAR vs the QB in BAL) -- a plain name-only join can silently hand
    one player's rank to the other. Beneath that, a name-only fallback still
    runs, but is built ONLY from in-scope (QB/RB/WR/TE) crosswalk rows, so it
    can still add a match when the two feeds disagree on a position label
    without ever letting an out-of-scope namesake win.

    Rows that resolve to no gsis_id are DROPPED and counted -- a silent drop
    would quietly bias the consensus pool, so the caller gets the tally and
    the names.
    """
    x = crosswalk[crosswalk["gsis_id"].notna()].copy()
    x["fantasypros_id"] = _fp_key(x["fantasypros_id"])
    by_id = (x[x["fantasypros_id"].notna()]
             .drop_duplicates(subset="fantasypros_id")
             .set_index("fantasypros_id")["gsis_id"])
    x["_key"] = _merge_key(x["merge_name"])
    named = x[x["merge_name"].notna()]
    by_name_pos = (named.drop_duplicates(subset=["_key", "position"])
                   .set_index(["_key", "position"])["gsis_id"].to_dict())
    by_name = (named[named["position"].isin(POSITIONS)]
               .drop_duplicates(subset="_key")
               .set_index("_key")["gsis_id"])

    out = snapshot.copy()
    # `.astype(object)`: when `by_id` has zero entries (crosswalk carries no
    # usable ids), `.map` degrades to a float64 all-NaN Series regardless of
    # `by_id`'s own dtype (pandas 3.x). Left as float64, the later
    # `out.loc[need, "player_id"] = <gsis strings>` assignment raises
    # TypeError rather than upcasting, since pandas 3 no longer silently
    # widens a typed column on setitem.
    out["player_id"] = _fp_key(out["fp_id"]).map(by_id).astype(object)
    matched_by_id = int(out["player_id"].notna().sum())
    # `len(by_id)`: count of crosswalk rows carrying BOTH a usable
    # fantasypros_id AND a non-null gsis_id -- a crosswalk row without a
    # gsis_id could never resolve a match regardless of its id, so it is
    # correctly excluded from `by_id` and therefore cannot arm this guard.
    # This is intentional, not an oversight: the guard only needs to know
    # whether the crosswalk offers any id that could possibly have matched.
    if len(out) and len(by_id) and matched_by_id == 0:
        raise ValueError(
            "consensus crosswalk id join matched zero rows even though "
            f"both the snapshot ({len(out)} ranked players) and the "
            f"crosswalk ({len(by_id)} ids) carry FantasyPros ids -- this "
            "indicates a key-format mismatch (e.g. float-vs-string ids), "
            "not missing data"
        )
    need = out["player_id"].isna()
    key = _merge_key(out.loc[need, "mergename"])
    key_pos = pd.Series(list(zip(key, out.loc[need, "pos"])), index=key.index)
    out.loc[need, "player_id"] = key_pos.map(by_name_pos)
    matched_by_name_position = int(out.loc[need, "player_id"].notna().sum())

    still_need = out["player_id"].isna()
    out.loc[still_need, "player_id"] = (
        _merge_key(out.loc[still_need, "mergename"]).map(by_name))
    matched_by_name = int(out["player_id"].notna().sum()) - matched_by_id
    matched_by_name_only = matched_by_name - matched_by_name_position

    unmatched = out[out["player_id"].isna()]
    matched = out[out["player_id"].notna()].reset_index(drop=True)
    # One consensus row per player: if two FantasyPros entries resolve to the
    # same gsis_id, keep the better-ranked one rather than double-listing.
    deduped = (matched.sort_values(["player_id", "ecr"])
               .drop_duplicates(subset="player_id", keep="first")
               .reset_index(drop=True))
    stats = {
        "ranked": int(len(out)),
        "matched_by_id": matched_by_id,
        "matched_by_name": matched_by_name,
        "matched_by_name_position": matched_by_name_position,
        "matched_by_name_only": matched_by_name_only,
        "unmatched": int(len(unmatched)),
        "unmatched_players": sorted(unmatched["player"].tolist()),
        # a gsis collision means ranked - unmatched != len(board); surface it
        "gsis_collisions": int(len(matched) - len(deduped)),
        "match_rate": (float(len(matched) / len(out)) if len(out) else 0.0),
    }
    if len(out) and stats["match_rate"] < min_match_rate:
        raise ValueError(
            f"consensus crosswalk matched only {stats['match_rate']:.1%} of "
            f"{len(out)} ranked players (floor {MIN_MATCH_RATE:.0%}) — refusing "
            f"to benchmark against a partial consensus pool"
        )
    return deduped, stats


def _backfill_draft_gsis(crosswalk: pd.DataFrame,
                         draft_picks: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """Restore blank player-id rows from the draft-picks source.

    nflverse's player-id feed can temporarily omit ``gsis_id`` for the
    current rookie class even when its draft-picks feed has already assigned
    the identifier used throughout this project. Join on PFR's stable player
    ID, never on a fuzzy name, and only fill blanks -- a non-null player-id
    record remains authoritative.
    """
    required_crosswalk = {"pfr_id", "gsis_id"}
    required_picks = {"pfr_player_id", "gsis_id"}
    missing_crosswalk = required_crosswalk - set(crosswalk.columns)
    missing_picks = required_picks - set(draft_picks.columns)
    if missing_crosswalk or missing_picks:
        raise ValueError(
            "cannot backfill draft gsis ids; missing crosswalk columns "
            f"{sorted(missing_crosswalk)} or draft-pick columns "
            f"{sorted(missing_picks)}"
        )

    picks = draft_picks.dropna(subset=["pfr_player_id", "gsis_id"])[
        ["pfr_player_id", "gsis_id"]
    ].copy()
    conflicts = picks.groupby("pfr_player_id")["gsis_id"].nunique()
    conflicts = conflicts[conflicts > 1]
    if not conflicts.empty:
        raise ValueError("draft-pick crosswalk has conflicting gsis ids for "
                         f"PFR ids {sorted(conflicts.index.tolist())}")
    by_pfr = picks.drop_duplicates("pfr_player_id").set_index("pfr_player_id")["gsis_id"]

    out = crosswalk.copy()
    blank = out["gsis_id"].isna()
    restored = out.loc[blank, "pfr_id"].map(by_pfr)
    filled = int(restored.notna().sum())
    out.loc[blank, "gsis_id"] = restored.where(restored.notna(), out.loc[blank, "gsis_id"])
    return out, filled


def canonicalize_draft_gsis(draft_picks: pd.DataFrame,
                            crosswalk: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """Rewrite draft-picks placeholder gsis ids to the identity feed's canonical id.

    Inverse of `_backfill_draft_gsis`. nflverse's draft-picks feed still
    carries a name-derived placeholder id (e.g. "LOV121782") for the current
    rookie class after the identity (player-id) feed has since been repaired
    upstream to the canonical ``00-00XXXXX`` GSIS form for those same
    players. Every downstream consumer of draft-picks (the ECR spine, the
    ADP overlay, the rookie board rows) must share one key space, so this
    rewrites draft-picks' `gsis_id` -- never the identity feed, which stays
    authoritative -- joined on PFR's stable id, never a fuzzy name match.

    A row is rewritten if and only if ALL of: its `gsis_id` is non-null; that
    id is ABSENT from the set of non-null `gsis_id` values already in
    `crosswalk` (i.e. it is provably not a real, known id); and its
    `pfr_player_id` bridges to a non-null canonical `gsis_id` in `crosswalk`.
    That second condition is load-bearing: it makes this a no-op for every
    historical draft class (measured 2012-2025: zero rows qualify), so it
    cannot silently move the prior `fit_rookie_cohorts` is fitted from.

    The conflict check (a single PFR id mapping to >1 canonical gsis id --
    never guessed, always raised) is scoped to the PFR ids this call actually
    needs to look up, i.e. the ones on rows eligible for rewrite. `crosswalk`
    is nflverse's full all-time, all-position identity feed (12k+ rows); it
    carries real upstream `pfr_id` collisions between UNRELATED obscure
    players who are never involved in any rewrite this function performs, and
    those must not abort a run that never consults them. Any PFR id this
    function does look up that is genuinely ambiguous still raises.
    """
    required_picks = {"pfr_player_id", "gsis_id"}
    required_crosswalk = {"pfr_id", "gsis_id"}
    missing_picks = required_picks - set(draft_picks.columns)
    missing_crosswalk = required_crosswalk - set(crosswalk.columns)
    if missing_picks or missing_crosswalk:
        raise ValueError(
            "cannot canonicalize draft gsis ids; missing draft-pick columns "
            f"{sorted(missing_picks)} or crosswalk columns "
            f"{sorted(missing_crosswalk)}"
        )

    known_gsis = set(crosswalk["gsis_id"].dropna())
    out = draft_picks.copy()
    placeholder = out["gsis_id"].notna() & ~out["gsis_id"].isin(known_gsis)

    relevant_pfr = set(out.loc[placeholder, "pfr_player_id"].dropna())
    cw = crosswalk[crosswalk["pfr_id"].isin(relevant_pfr)]
    cw = cw.dropna(subset=["pfr_id", "gsis_id"])[["pfr_id", "gsis_id"]].copy()
    conflicts = cw.groupby("pfr_id")["gsis_id"].nunique()
    conflicts = conflicts[conflicts > 1]
    if not conflicts.empty:
        raise ValueError("identity crosswalk has conflicting gsis ids for "
                         f"PFR ids {sorted(conflicts.index.tolist())}")
    by_pfr = cw.drop_duplicates("pfr_id").set_index("pfr_id")["gsis_id"]

    canonical = out.loc[placeholder, "pfr_player_id"].map(by_pfr)
    rewritten = int(canonical.notna().sum())
    out.loc[placeholder, "gsis_id"] = canonical.where(
        canonical.notna(), out.loc[placeholder, "gsis_id"])
    return out, rewritten


def pull_rankings(cache_dir: Path | None = None) -> pd.DataFrame:
    """Historical FantasyPros consensus, normalized on every read path.

    Normalization wraps the cache (the `pull_schedules` / `pull_draft_picks`
    precedent) so a cache file written by anything else still passes the
    column whitelist, the scope filter and the ROS exclusion.
    """
    def load() -> pd.DataFrame:
        import nflreadpy  # deferred: keep offline unit tests import-light

        return nflreadpy.load_ff_rankings("all").to_pandas()

    # This is the FALLBACK ECR source: `consensus_for_season` prefers the
    # hand-dropped snapshot under data_snapshots/ when one is present, and only
    # reaches the nflverse mirror when it is not. The mirror is still what
    # orders the board on that path, and it republishes weekly, so a cache that
    # never expired would anchor a board to whenever this parquet was first
    # written. It is also what `eval.weekly_consensus` measures against.
    return normalize_rankings(
        _cached(cache_dir, "ff_rankings_all_raw", load, LIVE_MAX_AGE_HOURS))


def pull_player_ids(cache_dir: Path | None = None) -> pd.DataFrame:
    """ffverse player-id crosswalk (fantasypros_id <-> gsis_id)."""
    def load() -> pd.DataFrame:
        import nflreadpy

        return nflreadpy.load_ff_playerids().to_pandas()

    # This is the feed that blanked gsis_id for the 2026 rookie class on
    # 2026-07-28 and cost the board its entire ADP overlay. It is repaired
    # upstream over days, so a cache that never expires holds the broken
    # snapshot indefinitely.
    return _cached(cache_dir, "ff_playerids", load, LIVE_MAX_AGE_HOURS)


def consensus_for_season(season: int, schedules: pd.DataFrame,
                         cache_dir: Path | None = None, *,
                         draft_picks: pd.DataFrame | None = None
                         ) -> tuple[pd.DataFrame, dict]:
    """Leak-free preseason consensus for board season `season`, on our ids."""
    if draft_picks is None:
        from ffmodel.data.pull import pull_draft_picks
        draft_picks = pull_draft_picks([season], cache_dir)
    kickoff = season_kickoff(schedules, season)
    crosswalk, restored = _backfill_draft_gsis(pull_player_ids(cache_dir), draft_picks)

    # A hand-dropped export WINS when it is present, because it is the only
    # way to be current in the days before a draft -- nflverse's mirror
    # publishes weekly and lagged it by four days on 2026-08-25, which is a
    # camp-injury cycle. Delete the file and the mirror takes over again with
    # no code change.
    #
    # Leak discipline is NOT relaxed for it: the same strictly-before-kickoff
    # rule that governs the mirror applies here, so a snapshot captured after
    # week 1 has begun is refused rather than quietly used.
    if ECR_SNAPSHOT_PATH.exists():
        snapshot = parse_ecr_snapshot_csv(ECR_SNAPSHOT_PATH)
        captured = snapshot["scrape_date"].iloc[0]
        if captured >= kickoff:
            raise ValueError(
                f"ECR snapshot {ECR_SNAPSHOT_PATH.name} was captured "
                f"{captured.date()}, on or after kickoff {kickoff.date()} -- "
                f"refusing to use a post-kickoff ranking as a preseason "
                f"consensus"
            )
        matched, stats = normalize_ecr_snapshot(snapshot, crosswalk)
        stats["source"] = "ecr_snapshot"
        stats["path"] = ECR_SNAPSHOT_PATH.as_posix()
    else:
        rankings = pull_rankings(cache_dir)
        snapshot = preseason_snapshot(rankings, kickoff)
        matched, stats = attach_gsis(snapshot, crosswalk)
        stats["source"] = "nflverse_mirror"

    stats["gsis_backfilled_from_draft_picks"] = restored
    stats["snapshot_date"] = str(snapshot["scrape_date"].iloc[0].date())
    stats["kickoff"] = str(kickoff.date())
    stats["source_page"] = str(snapshot["fp_page"].iloc[0])
    return matched, stats
