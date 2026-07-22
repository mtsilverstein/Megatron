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

from pathlib import Path

import pandas as pd

from ffmodel.data.pull import POSITIONS, _cached

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


def _merge_key(names: pd.Series) -> pd.Series:
    """Normalize a name to a case/space-insensitive merge key.

    The feeds disagree on case: ff_rankings' `mergename` has been Title-Case
    since 2022 while ff_playerids' `merge_name` is lowercase, so a raw
    equality join silently matched 0% and the fallback was dead code.
    """
    return names.astype(str).str.strip().str.lower()


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
    same id-then-name pattern the Sleeper crosswalk uses). Rows that resolve
    to no gsis_id are DROPPED and counted -- a silent drop would quietly bias
    the consensus pool, so the caller gets the tally and the names.
    """
    x = crosswalk[crosswalk["gsis_id"].notna()].copy()
    x["fantasypros_id"] = x["fantasypros_id"].astype(str).str.strip()
    by_id = (x[x["fantasypros_id"].notna()]
             .drop_duplicates(subset="fantasypros_id")
             .set_index("fantasypros_id")["gsis_id"])
    x["_key"] = _merge_key(x["merge_name"])
    by_name = (x[x["merge_name"].notna()]
               .drop_duplicates(subset="_key")
               .set_index("_key")["gsis_id"])

    out = snapshot.copy()
    out["player_id"] = out["fp_id"].map(by_id)
    matched_by_id = int(out["player_id"].notna().sum())
    need = out["player_id"].isna()
    out.loc[need, "player_id"] = _merge_key(out.loc[need, "mergename"]).map(by_name)
    matched_by_name = int(out["player_id"].notna().sum()) - matched_by_id

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


def pull_rankings(cache_dir: Path | None = None) -> pd.DataFrame:
    """Historical FantasyPros consensus, normalized on every read path.

    Normalization wraps the cache (the `pull_schedules` / `pull_draft_picks`
    precedent) so a cache file written by anything else still passes the
    column whitelist, the scope filter and the ROS exclusion.
    """
    def load() -> pd.DataFrame:
        import nflreadpy  # deferred: keep offline unit tests import-light

        return nflreadpy.load_ff_rankings("all").to_pandas()

    return normalize_rankings(_cached(cache_dir, "ff_rankings_all_raw", load))


def pull_player_ids(cache_dir: Path | None = None) -> pd.DataFrame:
    """ffverse player-id crosswalk (fantasypros_id <-> gsis_id)."""
    def load() -> pd.DataFrame:
        import nflreadpy

        return nflreadpy.load_ff_playerids().to_pandas()

    return _cached(cache_dir, "ff_playerids", load)


def consensus_for_season(season: int, schedules: pd.DataFrame,
                         cache_dir: Path | None = None
                         ) -> tuple[pd.DataFrame, dict]:
    """Leak-free preseason consensus for board season `season`, on our ids."""
    rankings = pull_rankings(cache_dir)
    kickoff = season_kickoff(schedules, season)
    snapshot = preseason_snapshot(rankings, kickoff)
    matched, stats = attach_gsis(snapshot, pull_player_ids(cache_dir))
    stats["snapshot_date"] = str(snapshot["scrape_date"].iloc[0].date())
    stats["kickoff"] = str(kickoff.date())
    stats["source_page"] = str(snapshot["fp_page"].iloc[0])
    return matched, stats
