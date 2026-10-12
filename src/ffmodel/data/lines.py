"""Betting-market lines for the lines feature screen.

Spec: docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md §2-3.

The nflverse schedule feed carries a spread and a total per game, treated as
closing-time context (their book and quote time are not recorded; availability
at our mid-week deadline is unverified). This module

- snapshots the raw payload once, so every model run reads frozen bytes;
- keeps exactly ALLOWED_COLUMNS before any transformation, so outcome columns
  (`result`, `total`, scores) can never reach a feature;
- classifies every game under the §2.1 taxonomy: a uniquely identified game
  with an unusable quote is RECOVERABLE (both features NaN for both teams);
  any ambiguity of identity is FATAL (LinesDataError -> the run is `invalid`);
- joins the two current-game columns onto the feature frame, many-to-one.

Sign convention: the nflverse schedule dictionary defines positive
`spread_line` as HOME FAVOURED. That dictionary is the authority; signs are
never inferred or flipped from outcomes. At neutral sites the documented home
team is the home side.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.data.features import LINE_FEATURE_COLUMNS
from ffmodel.data.pull import FRANCHISE_CODES, normalize_schedule_teams

ALLOWED_COLUMNS = ["season", "week", "game_type", "game_id",
                   "home_team", "away_team", "spread_line", "total_line"]
KEY_COLUMNS = ["season", "week", "game_type", "game_id", "home_team", "away_team"]
CANONICAL_TEAMS = frozenset(FRANCHISE_CODES)
# Spec §2 coverage claim for REG 2012-2025; re-checked and recorded, never fatal.
EXPECTED_REG_GAMES = 3663
IDENTITY_TOL = 1e-9
QUOTE_STATUSES = ("valid", "missing_quote", "nonpositive_total", "negative_implied_total")


class LinesDataError(ValueError):
    """Fatal data error under spec §2.1 (ambiguous identity or unmatched join).

    The screen's disposition becomes `invalid`; no record is preferred,
    averaged or dropped to continue.
    """


def file_sha256(path: Path | str) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def snapshot_meta_path(path: Path | str) -> Path:
    path = Path(path)
    return path.with_name(path.stem + ".meta.json")


def snapshot_schedules(seasons: list[int], path: Path | str, loader=None) -> dict:
    """Pull the raw schedule payload ONCE and freeze it as a local parquet.

    Refuses to overwrite an existing snapshot or sidecar: the input freeze
    (spec §2) is only meaningful if the bytes cannot be silently replaced.
    Writes a sidecar `<stem>.meta.json` (exclusive create) with retrieval time
    (UTC), nflreadpy version, row count and the file's sha256, and returns the
    same dict.
    """
    path = Path(path)
    for p in (path, snapshot_meta_path(path)):
        if p.exists():
            raise FileExistsError(f"{p} already exists; a schedule snapshot is never overwritten")
    if loader is None:
        def loader() -> pd.DataFrame:
            import nflreadpy  # deferred: keep offline unit tests import-light

            return nflreadpy.load_schedules(seasons).to_pandas()
    retrieved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    raw = loader()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        raw.to_parquet(tmp, index=False)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()
    meta = {
        "path": path.as_posix(),
        "seasons": sorted(int(s) for s in seasons),
        "rows": int(len(raw)),
        "retrieved_at": retrieved_at,
        "nflreadpy_version": package_version("nflreadpy"),
        "sha256": file_sha256(path),
    }
    with snapshot_meta_path(path).open("x", encoding="utf-8") as fh:   # "x": never replace
        fh.write(json.dumps(meta, indent=2))
    return meta


def read_snapshot(path: Path | str, expected_sha256: str) -> pd.DataFrame:
    """Read the frozen payload, refusing bytes that differ from the recorded hash."""
    actual = file_sha256(path)
    if actual != expected_sha256:
        raise LinesDataError(
            f"schedule snapshot {path} sha256 {actual} != recorded {expected_sha256}")
    return pd.read_parquet(path)


def select_allowed(raw: pd.DataFrame) -> pd.DataFrame:
    """Exactly ALLOWED_COLUMNS, in that order, before any transformation."""
    missing = [c for c in ALLOWED_COLUMNS if c not in raw.columns]
    if missing:
        raise LinesDataError(f"schedule payload is missing allowed column(s) {missing}")
    return raw[ALLOWED_COLUMNS].copy()


def validate_games(allowed: pd.DataFrame, seasons: list[int]) -> tuple[pd.DataFrame, dict]:
    """Apply the spec §2.1 taxonomy; return (REG games in `seasons`, report).

    Identity checks run on every record in the payload (all game types) so a
    repeated `game_id` cannot hide behind a scope filter. Order:
    missing key field (fatal) -> exact-duplicate collapse on the raw allowed
    values (counted) -> any remaining repeated game_id (fatal) -> team-code
    normalisation, unknown code (fatal), identical home/away (fatal) ->
    two game_ids claiming one (season, week, team) (fatal) -> scope to REG
    games in `seasons` -> per-game quote status.
    """
    if list(allowed.columns) != ALLOWED_COLUMNS:
        raise LinesDataError("validate_games expects exactly ALLOWED_COLUMNS (call select_allowed)")
    null_keys = allowed[KEY_COLUMNS].isna()
    if null_keys.to_numpy().any():
        bad = sorted(c for c in KEY_COLUMNS if null_keys[c].any())
        raise LinesDataError(f"missing key field(s) {bad} in {int(null_keys.any(axis=1).sum())} record(s)")
    records = len(allowed)
    dup_mask = allowed.duplicated(keep="first")
    games = allowed[~dup_mask].reset_index(drop=True)
    repeated = games["game_id"][games["game_id"].duplicated(keep=False)]
    if len(repeated):
        raise LinesDataError(
            f"repeated game_id(s) with differing records: {sorted(set(repeated))[:5]}")
    games = normalize_schedule_teams(games)
    unknown = sorted((set(games["home_team"]) | set(games["away_team"])) - CANONICAL_TEAMS)
    if unknown:
        raise LinesDataError(f"unknown team code(s) {unknown}")
    same = games["home_team"] == games["away_team"]
    if same.any():
        raise LinesDataError(f"identical home and away team in game(s) {list(games.loc[same, 'game_id'])[:5]}")
    sides = pd.concat([
        games[["season", "week", "game_id"]].assign(team=games["home_team"]),
        games[["season", "week", "game_id"]].assign(team=games["away_team"]),
    ], ignore_index=True)
    per_team_week = sides.groupby(["season", "week", "team"])["game_id"].nunique()
    collisions = per_team_week[per_team_week > 1]
    if len(collisions):
        raise LinesDataError(
            f"team-week collision: {len(collisions)} (season, week, team) key(s) claimed by "
            f"more than one game_id, e.g. {list(collisions.index[:3])}")

    scoped = games[(games["game_type"] == "REG") & games["season"].isin(list(seasons))]
    scoped = scoped.sort_values(["season", "week", "game_id"], kind="mergesort").reset_index(drop=True)
    total = scoped["total_line"].astype(float).to_numpy()
    spread = scoped["spread_line"].astype(float).to_numpy()
    finite = np.isfinite(total) & np.isfinite(spread)
    # Arithmetic on finite rows only: inf - inf would warn (an error under -W error).
    nonpositive = np.zeros(len(scoped), dtype=bool)
    negative_implied = np.zeros(len(scoped), dtype=bool)
    t, m = total[finite], spread[finite]
    nonpositive[finite] = t <= 0
    negative_implied[finite] = ((t + m) / 2 < 0) | ((t - m) / 2 < 0)
    status = np.select(
        [~finite, nonpositive, negative_implied],
        ["missing_quote", "nonpositive_total", "negative_implied_total"],
        default="valid",
    )
    scoped = scoped.assign(quote_status=status)
    counts = scoped["quote_status"].value_counts()
    report = {
        "payload_records": int(records),
        "exact_duplicates_collapsed": int(dup_mask.sum()),
        "reg_games": int(len(scoped)),
        "reg_games_by_season": {int(k): int(v) for k, v in scoped.groupby("season").size().items()},
        "quote_status_counts": {s: int(counts.get(s, 0)) for s in QUOTE_STATUSES},
        "expected_reg_games": EXPECTED_REG_GAMES,
        "coverage_matches_claim": bool(
            len(scoped) == EXPECTED_REG_GAMES and int(counts.get("valid", 0)) == EXPECTED_REG_GAMES),
    }
    return scoped, report


def team_game_lines(games: pd.DataFrame) -> pd.DataFrame:
    """Two rows per validated game: the home side and the away side.

    implied = (T + m)/2 home, (T - m)/2 away; margin = m home, -m away, with
    T = total_line and m = spread_line (positive = home favoured). Both
    features are NaN for both sides of a non-valid quote.
    """
    valid = (games["quote_status"] == "valid").to_numpy()
    total = games["total_line"].astype(float).to_numpy()
    spread = games["spread_line"].astype(float).to_numpy()
    # Mask first, then compute on valid rows only. np.where would evaluate
    # both branches, and inf - inf on a missing quote emits a RuntimeWarning.
    home_implied, away_implied = np.full(len(games), np.nan), np.full(len(games), np.nan)
    home_margin, away_margin = np.full(len(games), np.nan), np.full(len(games), np.nan)
    t, m = total[valid], spread[valid]
    home_implied[valid], away_implied[valid] = (t + m) / 2, (t - m) / 2
    home_margin[valid], away_margin[valid] = m, -m
    base = games[["season", "week", "game_id", "quote_status"]].reset_index(drop=True)
    home = base.assign(
        team=games["home_team"].to_numpy(), side="home",
        team_implied_total=home_implied, team_expected_margin=home_margin,
    )
    away = base.assign(
        team=games["away_team"].to_numpy(), side="away",
        team_implied_total=away_implied, team_expected_margin=away_margin,
    )
    h_imp, a_imp = home["team_implied_total"].to_numpy(), away["team_implied_total"].to_numpy()
    h_mar, a_mar = home["team_expected_margin"].to_numpy(), away["team_expected_margin"].to_numpy()
    ok_valid = (
        np.isfinite(h_imp[valid]).all() and np.isfinite(a_imp[valid]).all()
        and np.allclose(h_imp[valid] + a_imp[valid], total[valid], rtol=0, atol=IDENTITY_TOL)
        and np.allclose(h_imp[valid] - a_imp[valid], spread[valid], rtol=0, atol=IDENTITY_TOL)
        and np.allclose(h_mar[valid], -a_mar[valid], rtol=0, atol=IDENTITY_TOL)
    )
    ok_missing = all(np.isnan(x[~valid]).all() for x in (h_imp, a_imp, h_mar, a_mar))
    if not (ok_valid and ok_missing):
        raise LinesDataError("team-game identities failed (implied totals / margins)")
    table = pd.concat([home, away], ignore_index=True)
    table = table[["season", "week", "game_id", "team", "side", "quote_status", *LINE_FEATURE_COLUMNS]]
    if table.duplicated(["season", "week", "team"]).any():
        raise LinesDataError("team-game table has a repeated (season, week, team)")
    return table.sort_values(["season", "week", "game_id", "side"], kind="mergesort").reset_index(drop=True)


def build_line_table(raw: pd.DataFrame, seasons: list[int]) -> tuple[pd.DataFrame, dict]:
    """raw schedule payload -> (validated team-game table, validation report)."""
    games, report = validate_games(select_allowed(raw), seasons)
    return team_game_lines(games), report


def join_line_features(features: pd.DataFrame,
                       team_lines: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Append LINE_FEATURE_COLUMNS to `features` on (season, week, team).

    Many-to-one; player-row count, order, index and keys are unchanged. A
    player team-week with no game in the table raises LinesDataError (spec
    §2.1: unmatched joins are never continued past). Rows of missing-quote
    games are kept with NaN features and counted per season by reason.
    """
    present = [c for c in LINE_FEATURE_COLUMNS if c in features.columns]
    if present:
        raise ValueError(f"line column(s) {present} already in the feature frame")
    keys = ["season", "week", "team"]
    right = team_lines[keys + ["quote_status", *LINE_FEATURE_COLUMNS]]
    try:
        merged = features[keys].merge(right, on=keys, how="left",
                                      validate="many_to_one", indicator=True)
    except pd.errors.MergeError as exc:
        raise LinesDataError(f"team-game table is not unique on {keys}: {exc}") from exc
    if len(merged) != len(features):
        raise LinesDataError("join changed the player-row count")
    # Unmatched first: a null key never matches, and must be reported as an
    # unmatched team-week rather than as a reordered key.
    unmatched = (merged["_merge"] == "left_only").to_numpy()
    if unmatched.any():
        sample = features.loc[unmatched, keys].drop_duplicates().head(5).to_dict("records")
        raise LinesDataError(
            f"unmatched player team-week: {int(unmatched.sum())} row(s) have no game, e.g. {sample}")
    for k in keys:
        if not np.array_equal(merged[k].to_numpy(), features[k].to_numpy()):
            raise LinesDataError(f"join changed player-row order or key {k!r}")
    out = features.copy()
    for c in LINE_FEATURE_COLUMNS:
        out[c] = merged[c].to_numpy()
    status = merged["quote_status"].to_numpy()
    report = {}
    for season in sorted(int(s) for s in pd.unique(features["season"])):
        in_season = (features["season"] == season).to_numpy()
        report[season] = {
            "rows": int(in_season.sum()),
            "matched_valid_quote": int((in_season & (status == "valid")).sum()),
            "missing_quote_by_reason": {
                s: int((in_season & (status == s)).sum()) for s in QUOTE_STATUSES[1:]},
        }
    return out, report
