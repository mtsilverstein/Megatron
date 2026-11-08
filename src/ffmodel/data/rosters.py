"""Current-season team assignments, so players are projected where they now play.

WHY THIS EXISTS. `future_skeleton` builds each projected row from the player's
most recent *played* row and reuses that row's team. In-season that is correct.
For the preseason board the most recent played row is from the previous
December, so every offseason signing, trade and release is stale.

Measured on the 2026 board against the FantasyPros ADP export of 2026-08-09
(which carries each player's current team), over the 432 players both sources
cover: **70 wrong teams (16.2%) before the override, 1 (0.2%) after.** The
stale names were not marginal — A.J. Brown at ADP 19 was still in Philadelphia,
Kenneth Walker III at ADP 23 still in Seattle.

TEAM IS NOT COSMETIC. It selects the opponent through the schedule join, so it
drives `opp_allowed_last4`, `is_home`, `is_indoor` and `team_pass_att_last4` --
all live CTX_FEATURES_V2 inputs. A player on the wrong team is projected inside
the wrong offense against the wrong opponent, with home/away flipped about half
the time.

THIS IS NOT A LEAK. Free agency and trades are public the day they happen; the
roster feed for season S during S's preseason describes what a drafter already
knows. It carries no game outcome. (Contrast week-1 *status*, which resolves at
the Aug 26-29 cutdown -- that is a separate signal and deliberately not used
here.)

NOT COVERED, and why that is acceptable: a player with no row in the current
roster feed keeps his last-known team. On the 2026 board that is 87 of 695
players, every one of them at or below replacement (`vorp <= 0`), and only 5
carry an ADP at all -- the deepest being 127. Guessing a team for an
unrostered player would be worse than leaving the last one we actually saw.
That holds for the PRESEASON board, which is unchanged. In-season the weekly
slate does not project released (`CUT`), retired (`RET`) or unrostered players
who have no game this season (`released_ids`, `in_season_exclusions`): a week-9
slate otherwise carried a retired QB as the 22nd-ranked QB on his last team.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from ffmodel.data.pull import (LIVE_MAX_AGE_HOURS, POSITIONS,
                               _cache_name, _cached)

# The roster feed abbreviates Arizona `AZ`; the weekly and schedule feeds use
# `ARI`. Verified against the 2026 board this is the ONLY disagreement between
# the two vocabularies -- every other one of the 32 codes matches exactly -- so
# this map is a fix, not the start of a translation layer. If a future season
# adds a second entry here, check whether the upstream feed changed instead.
TEAM_ALIASES = {"AZ": "ARI"}

# A traded or re-signed player can hold more than one row in a season's feed.
# Prefer the one that says he is actually on a 53-man roster; an unrecognised
# status sorts last rather than being dropped, because "some team, unknown
# status" still beats "last season's team".
_STATUS_ORDER = {"ACT": 0, "INA": 1, "RES": 2, "PUP": 2, "NFI": 2, "SUS": 2,
                 "DEV": 3}
_UNKNOWN_STATUS = 9
# `CUT` (released) and `RET` (retired) rows name the team a player has LEFT, so
# they must never map him anywhere. A player with another row (re-signed, `ACT`)
# still maps through that row. Handled explicitly, not via "unknown status".
_RELEASED_STATUSES = frozenset({"CUT", "RET"})


def normalize_current_teams(raw: pd.DataFrame) -> dict[str, str]:
    """Reduce a raw `load_rosters` frame to {player_id: team}.

    Pure: no IO, so the mapping rules are testable without the network. Rows
    without a gsis id are dropped -- that is the join key into weekly data, and
    a player we cannot join is a player we cannot override. `CUT`/`RET` rows
    are dropped too: see `_RELEASED_STATUSES`.
    """
    df = raw[raw["position"].isin(POSITIONS)].copy()
    df = df[df["gsis_id"].notna() & df["team"].notna()]
    df = df[~df["status"].isin(_RELEASED_STATUSES)]
    if df.empty:
        return {}
    df["_rank"] = df["status"].map(_STATUS_ORDER).fillna(_UNKNOWN_STATUS)
    df = (df.sort_values(["gsis_id", "_rank"])
            .drop_duplicates(subset=["gsis_id"], keep="first"))
    return {pid: TEAM_ALIASES.get(team, team)
            for pid, team in zip(df["gsis_id"], df["team"])}


# Observed on the 2026 feed: 24 players on the thinnest team, 31 on the
# thickest. A floor of 10 is well clear of normal variation while still
# refusing a feed that has kept a token row per franchise -- the truncation
# that survives a pure team-name check, because every team is still "present".
MIN_PLAYERS_PER_TEAM = 10

# Same idea one axis over. `normalize_current_teams` filters to POSITIONS, so
# if the feed renames one of them the filter drops that position entirely and
# every WR (or TE, or RB) silently keeps his last-played team while the team
# and per-team counts still look healthy. Observed thinnest position: QB at
# 119. One per franchise is the floor.
MIN_PLAYERS_PER_POSITION = 32


def assert_roster_coverage(mapping: dict[str, str],
                           scheduled_teams: set[str]) -> None:
    """Refuse a roster map that cannot speak for the season being projected.

    `pull_current_teams` returns `{}` for a feed that downloads fine but comes
    back empty or gets filtered to nothing, and `future_skeleton` treats a
    falsey mapping as "no override asked for" -- so the run would sail on and
    publish every player on the team of his last played game. That is the
    incomplete-pull case CLAUDE.md's fail-safe rule exists for, and it has to
    abort rather than degrade quietly.

    Checked in BOTH directions, against the season's own schedule rather than
    a hardcoded 32, because the two failures look nothing alike:

      * a scheduled team with no rostered skill player means the feed is
        missing or truncated;
      * a rostered team the schedule has never heard of means the two feeds
        disagree about how to spell a team -- and `future_skeleton` merges
        players onto matchups BY TEAM, so every player on that spelling is
        silently dropped as though his team were on bye. `AZ` vs `ARI` is
        exactly that bug, already papered over by TEAM_ALIASES; this is what
        makes the next one fail loudly instead of deleting a roster.

    Team names alone are not enough, though: a feed truncated to one row per
    franchise satisfies both set differences and still leaves almost every
    player on last season's team, so the per-team count is checked too.

    Measured on the 2026 feed: 915 players, all 32 teams, 24-31 each, and
    neither direction missing anything.
    """
    from collections import Counter

    have = set(mapping.values())
    unrostered = sorted(scheduled_teams - have)
    unscheduled = sorted(have - scheduled_teams)
    counts = Counter(mapping.values())
    thin = sorted(t for t in scheduled_teams
                  if counts[t] < MIN_PLAYERS_PER_TEAM)
    if thin and not (unrostered or unscheduled):
        raise RuntimeError(
            f"current-roster feed is truncated ({len(mapping)} players over "
            f"{len(have)} teams) — refusing to publish projections built on "
            f"last-played teams. Every scheduled team is present but "
            f"{len(thin)} carry fewer than {MIN_PLAYERS_PER_TEAM} players: "
            f"{thin[:8]}{' ...' if len(thin) > 8 else ''}")
    if unrostered or unscheduled:
        raise RuntimeError(
            f"current-roster feed is unusable for this season "
            f"({len(mapping)} players, {len(have)} teams) — refusing to "
            f"publish projections built on last-played teams. "
            f"scheduled teams with no rostered player: {unrostered or 'none'}; "
            f"rostered teams absent from the schedule: {unscheduled or 'none'} "
            f"(a new spelling needs an entry in TEAM_ALIASES)")


def _load_current_raw(season: int, cache_dir: Path | None = None,
                      scheduled_teams: set[str] | None = None) -> pd.DataFrame:
    """The validated, cached current-roster frame for `season`.

    The single loader behind `pull_current_teams` and `pull_released_ids`, so
    both read one cache file under one set of checks and cannot diverge.

    `scheduled_teams`, when given, makes the FULL coverage check run inside
    the loader -- before the refreshed frame is cached. Without it only the
    position check can run here, because team coverage is defined against the
    season's schedule and this function has never seen one.
    """
    def load() -> pd.DataFrame:
        import nflreadpy  # deferred: keep offline unit tests import-light

        raw = nflreadpy.load_rosters([season]).to_pandas()
        # Checked INSIDE the loader, before _cached writes the parquet. A
        # truncated response validated only after caching would replace the
        # last-good file, abort the run, and then be served from cache for the
        # whole TTL -- so a transient upstream failure would keep the run
        # broken for hours after upstream recovered. Never cache a frame we
        # would refuse to use.
        assert_positions_present(raw)
        if scheduled_teams:
            # The other half of the same rule. Validated only after caching,
            # a response that satisfies the position floors but is missing
            # whole franchises would replace the last-good parquet, abort the
            # run, and then be served from that fresh cache for the entire
            # TTL -- so one bad minute upstream keeps the board broken for
            # twelve hours after upstream recovers.
            assert_roster_coverage(normalize_current_teams(raw), scheduled_teams)
        return raw

    # Where players are RIGHT NOW: the definition of live state, and the
    # reason this whole override exists.
    raw = _cached(cache_dir, _cache_name("rosters_current", [season]), load,
                  LIVE_MAX_AGE_HOURS)
    assert_positions_present(raw)
    return raw


def pull_current_teams(season: int, cache_dir: Path | None = None,
                       scheduled_teams: set[str] | None = None
                       ) -> dict[str, str]:
    """{player_id: team} for `season`, from the season's roster feed.

    Callers that have a schedule should pass `scheduled_teams` so the full
    coverage check runs before caching; see `_load_current_raw`.
    """
    return normalize_current_teams(
        _load_current_raw(season, cache_dir, scheduled_teams))


def released_ids(raw: pd.DataFrame) -> set[str]:
    """Skill-position gsis ids whose EVERY row in the feed is `CUT` or `RET`.

    Pure. A player with any other row (e.g. re-signed, `ACT`) is not released.
    """
    df = raw[raw["position"].isin(POSITIONS) & raw["gsis_id"].notna()]
    if df.empty:
        return set()
    gone = df["status"].isin(_RELEASED_STATUSES)
    return set(df.loc[gone.groupby(df["gsis_id"]).transform("all"), "gsis_id"])


def pull_released_ids(season: int, cache_dir: Path | None = None) -> set[str]:
    """`released_ids` over the same cached roster frame as `pull_current_teams`.

    Same loader, cache file and freshness rule; call it after
    `pull_current_teams` and it reads that call's cache rather than
    downloading again.
    """
    return released_ids(_load_current_raw(season, cache_dir))


def in_season_exclusions(weekly: pd.DataFrame, current_teams: dict[str, str],
                         released: set[str], season: int) -> set[str]:
    """Players the in-season weekly slate must not project.

    `released`, plus every player in `weekly` who is absent from
    `current_teams` and has no `weekly` row in `season`. A player missing from
    the feed who HAS played this season stays on his last team: a fresh signing
    can lag the feed by a day, and dropping a playing player is the worse error.
    """
    played_now = set(weekly.loc[weekly["season"] == season, "player_id"])
    unrostered = (set(weekly["player_id"]) - set(current_teams)) - played_now
    return set(released) | unrostered


def assert_positions_present(raw: pd.DataFrame) -> None:
    """Refuse a feed that has stopped speaking about a whole position.

    Lives here rather than in `normalize_current_teams` because that function
    is documented — and tested — to return `{}` for a frame with nothing it
    recognises; turning its filter into an assertion would change a contract
    two callers rely on. The frame is only in scope inside the pull, so the
    check is too.

    This is the truncation a team-name or per-team-count check cannot see: if
    the feed renames `WR`, the filter drops 388 players, all 32 teams stay
    present with 16 apiece, and every wide receiver quietly keeps the team he
    last played for.
    """
    # Count rows that have a join key and a team, before normalize_current_teams
    # drops CUT/RET rows (those still count here: the guard is about a position
    # going missing from the feed, not about who is on a roster). Counting raw
    # rows lets a feed that populates gsis_id and position but blanks `team`
    # for one position clear this guard and then get dropped downstream --
    # every player at that position silently keeping his last-played team,
    # which is the exact outcome the guard exists to prevent.
    usable = raw
    for col in ("gsis_id", "team"):
        if col in usable.columns:
            usable = usable[usable[col].notna()]
    counts = usable["position"].value_counts() if len(usable) else {}
    thin = {p: int(counts.get(p, 0)) for p in POSITIONS
            if int(counts.get(p, 0)) < MIN_PLAYERS_PER_POSITION}
    if thin:
        raise RuntimeError(
            f"current-roster feed is unusable: {thin} — fewer than "
            f"{MIN_PLAYERS_PER_POSITION} joinable players at a position the "
            f"board projects. Either the feed is truncated or it has renamed "
            f"a position and ffmodel.data.pull.POSITIONS no longer matches it; "
            f"refusing to publish projections built on last-played teams")
