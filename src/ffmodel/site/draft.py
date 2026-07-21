"""Season-long draft values: weekly roll -> sums -> VORP -> tiers."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ffmodel.data.future import combined_future_features
from ffmodel.model.simulate import games_probs_from_counts, rho_from_icc, simulate_season
from ffmodel.scoring import fantasy_points, fantasy_points_quantiles
from ffmodel.site.weekly import RULESETS

# 12-team league: points above the player at this positional rank define
# value over replacement (roughly the first waiver-tier player).
REPLACEMENT_RANK = {"QB": 13, "RB": 25, "WR": 25, "TE": 13}

_MAX_GAMES = 18   # matches ffmodel.eval.diagnose._MAX_GAMES: G axis is 0..18


def season_projection(weekly: pd.DataFrame, schedules: pd.DataFrame, predictor,
                      season: int, weeks=range(1, 19), prefit: bool = False, *,
                      n_draws: int = 2000, seed: int = 0,
                      games_dist: dict[str, np.ndarray] | None = None,
                      diagnostics: dict | None = None,
                      rho_by_position: dict[str, float] | None = None) -> pd.DataFrame:
    """All weeks seeded from the same pre-season history (spec §7).

    For a quantile predictor, the season p10/p50/p90 come from a Monte-Carlo
    simulation over the player's weekly CALIBRATED bands
    (`ffmodel.model.simulate.simulate_season`), sampling games-played from a
    leak-free empirical distribution rather than assuming every scheduled
    week is played and every week lands at the same percentile (see
    simulate.py's module docstring for why summing weekly quantiles was
    wrong on both counts). The season p50 this produces IS the point
    estimate (median-of-sums, not sum-of-medians) -- VORP downstream reads
    it with no further change. Weekly draws are correlated via a one-factor
    Gaussian copula at each player's positional equicorrelation `rho` (see
    `simulate_season`), derived leak-free from the SAME `weekly` history
    handed to this call (a walk-forward measurement, never future data).

    `games_dist`, if given, maps position -> shape-(19,) games-probability
    vector and is used as-is (the board-backtest CLI threads a leak-free
    `availability_table` computed once per board season through this, so
    repeated season_projection calls don't recompute it). Otherwise this
    derives one internally from `weekly` via `availability_table` through
    the latest season present. Short worlds -- a single season, or a toy
    fixture with no consecutive season pair -- have no valid pair for
    `availability_table` to measure, and it raises ValueError; this falls
    back to a POINT MASS at each player's own scheduled-week count (i.e.
    deterministic full availability), so toy/short-history runs stay
    well-defined instead of crashing.

    `rho_by_position`, if given, maps position -> equicorrelation and is
    used as-is (same pattern as `games_dist`, for a caller threading one
    measurement through repeated calls). Otherwise this derives one
    internally from `weekly` via `weekly_residual_icc` + `rho_from_icc`
    through the latest season present. `weekly_residual_icc` shares its
    cohort-selection machinery with `availability_table` (same
    `_select_pairs` short-world condition), so it fails under the exact
    same circumstances as the `games_dist` fallback above -- kept as a
    SEPARATE try/except anyway, for a simpler failure story per call. On
    ValueError this falls back to {} (every position defaults to rho=0.0,
    i.e. independent weeks -- the pre-copula behavior).
    """
    if not prefit:
        predictor.fit(_fit_frame(weekly, schedules))
    has_quantiles = hasattr(predictor, "predict_quantiles")
    totals: dict[str, dict] = {}
    # Per player+ruleset, the per-week (p10, p50, p90) point triples for the
    # weeks the player appears in -- fed to simulate_season after the loop
    # instead of being summed into totals directly.
    bands_by_player: dict[str, dict[str, list]] = {}
    for week in weeks:
        combined, future = combined_future_features(weekly, schedules, season, week)
        if future.empty:
            continue
        if hasattr(predictor, "attach_features"):
            predictor.attach_features(combined)   # future rows live in this frame
        if has_quantiles:
            qs = predictor.predict_quantiles(future)
            # Sign-coherent floor/ceiling per week (fed into the season
            # simulation below); keeps a passer's ceiling from absorbing his
            # worst-case INTs.
            week_pts = {rn: fantasy_points_quantiles(qs, rules)
                        for rn, rules in RULESETS.items()}
        else:
            pred = predictor.predict(future)
            week_pts = {rn: {"p50": fantasy_points(pred, rules), "p10": None, "p90": None}
                        for rn, rules in RULESETS.items()}
        for idx, row in future.iterrows():
            pid = row["player_id"]
            entry = totals.setdefault(pid, {
                "player_id": pid, "name": row["player_display_name"],
                "team": row["team"], "position": row["position"],
                **{f"{rn}_{q}": 0.0 for rn in RULESETS for q in ("p10", "p50", "p90")},
                "games": 0,
            })
            entry["games"] += 1
            if has_quantiles:
                player_bands = bands_by_player.setdefault(pid, {rn: [] for rn in RULESETS})
                for rn in RULESETS:
                    p10v = float(week_pts[rn]["p10"].loc[idx])
                    p50v = float(week_pts[rn]["p50"].loc[idx])
                    p90v = float(week_pts[rn]["p90"].loc[idx])
                    player_bands[rn].append((p10v, p50v, p90v))
            else:
                # Point-only predictors (naive/XGBoost): unchanged path.
                for rn in RULESETS:
                    entry[f"{rn}_p50"] += float(week_pts[rn]["p50"].loc[idx])
                    for q in ("p10", "p90"):
                        entry[f"{rn}_{q}"] = np.nan

    if has_quantiles and totals:
        # Deferred import: ffmodel.eval.diagnose imports REPLACEMENT_RANK
        # from THIS module, so a top-level import here would be circular.
        from ffmodel.eval.diagnose import availability_table, weekly_residual_icc

        if games_dist is not None:
            dist_by_position, fallback_full_availability = games_dist, False
        else:
            try:
                through = int(weekly["season"].max())
                counts = availability_table(weekly, through_season=through)
                dist_by_position = games_probs_from_counts(counts)
                fallback_full_availability = False
            except ValueError:
                dist_by_position = {}
                fallback_full_availability = True

        if rho_by_position is not None:
            rho_map = rho_by_position
        else:
            # Separate try/except from the availability_table call above --
            # see the docstring: the two share a failure condition, but a
            # standalone guard per measurement is simpler to reason about.
            try:
                through = int(weekly["season"].max())
                icc = weekly_residual_icc(weekly, through_season=through)
                rho_map = rho_from_icc(icc)
            except ValueError:
                rho_map = {}

        rng = np.random.default_rng(seed)   # ONE shared stream for the whole call:
        # players consume from it in totals' iteration order, so the output
        # is deterministic given `seed` but NOT invariant to player order.
        clip_fracs: dict[str, list[float]] = {}
        for pid, entry in totals.items():
            position = entry["position"]
            probs = None if fallback_full_availability else dist_by_position.get(position)
            if probs is None or not np.isclose(probs.sum(), 1.0):
                # Per-position degenerate fallback: a position with zero
                # cohort members in the measured season pair(s) (e.g. no
                # prior-season history at all for that position in a thin
                # world) yields an all-zero, non-normalized vector from
                # `games_probs_from_counts` -- rather than crash `rng.choice`
                # on a probability vector that doesn't sum to 1, fall back to
                # this player's own point-mass full availability, same as the
                # global `fallback_full_availability` case above.
                probs = np.zeros(_MAX_GAMES + 1, dtype=float)
                probs[min(entry["games"], _MAX_GAMES)] = 1.0
            rho = rho_map.get(position, 0.0)
            for rn in RULESETS:
                week_bands = np.array(bands_by_player[pid][rn], dtype=float)
                sim = simulate_season(week_bands, probs, n_draws, rng, rho=rho)
                entry[f"{rn}_p10"] = sim["p10"]
                entry[f"{rn}_p50"] = sim["p50"]
                entry[f"{rn}_p90"] = sim["p90"]
                clip_fracs.setdefault(position, []).append(sim["clip_frac"])
        if diagnostics is not None:
            # Simple mean over players (and rulesets) per position -- a
            # weighted-by-retained-draws average is overkill for a coarse
            # diagnostic.
            diagnostics["clip_frac"] = {
                pos: float(np.mean(fracs)) for pos, fracs in clip_fracs.items()
            }

    columns = ["player_id", "name", "team", "position",
               *[f"{rn}_{q}" for rn in RULESETS for q in ("p10", "p50", "p90")],
               "games"]
    return pd.DataFrame(list(totals.values()), columns=columns)


def _fit_frame(weekly: pd.DataFrame, schedules: pd.DataFrame) -> pd.DataFrame:
    from ffmodel.data.features import build_features

    return build_features(weekly, schedules)


def _assign_tiers(vorp_desc: pd.Series, replacement_rank: int) -> list[int]:
    values = vorp_desc.to_numpy(dtype=float)
    if len(values) == 0:
        return []
    n_draft = min(2 * replacement_rank, len(values))
    if n_draft < 2:
        return [1] * len(values)
    mean_gap = (values[0] - values[n_draft - 1]) / (n_draft - 1)
    threshold = max(2.0, 2.0 * mean_gap)
    tiers, tier = [1], 1
    for prev, cur in zip(values, values[1:]):
        if prev - cur > threshold:
            tier += 1
        tiers.append(tier)
    return tiers


def _rookie_frame(weekly, draft_picks, season, players, team_weeks, weeks_list,
                  *, n_draws, seed, rookie_min_n):
    """Rookie rows for the target season's draft class, on the veterans'
    scale: cohort weekly triples -> simulate_season -> season quantiles.
    Dedupe: a drafted player already carrying weekly history (by gsis id,
    or by normalized name+position against the veteran board) gets the
    real model only."""
    from ffmodel.eval.diagnose import weekly_residual_icc
    from ffmodel.model.rookie import fit_rookie_cohorts, rookie_projection
    from ffmodel.site.sleeper import _normalize_name

    cls = draft_picks[draft_picks["season"] == season]
    if cls.empty:
        raise RuntimeError(f"draft class for season {season} is empty — "
                           "aborting (data problem, not a skip)")
    kwargs = {} if rookie_min_n is None else {"min_n": rookie_min_n}
    cohorts = fit_rookie_cohorts(weekly, draft_picks[draft_picks["season"] < season],
                                 through_season=season - 1, **kwargs)
    try:
        rho_map = rho_from_icc(weekly_residual_icc(
            weekly, through_season=int(weekly["season"].max())))
    except ValueError:
        rho_map = {}

    known_ids = set(weekly["player_id"])
    vet_keys = {(_normalize_name(n), p)
                for n, p in zip(players["name"], players["position"])}
    rng = np.random.default_rng(seed + 1)   # distinct stream from the vets'
    rows = []
    for _, r in cls.iterrows():
        if pd.notna(r["gsis_id"]) and r["gsis_id"] in known_ids:
            continue                                    # real model wins
        if (_normalize_name(r["player_name"]), r["position"]) in vet_keys:
            continue
        scheduled = int(team_weeks[team_weeks["team"] == r["team"]]["week"]
                        .isin(weeks_list).sum())
        if scheduled == 0:
            scheduled = len(weeks_list)                 # toy schedules: play on
        frames, games_probs = rookie_projection(
            cohorts, r["position"], int(r["round"]), int(r["pick"]))
        # nflreadpy's draft_picks occasionally has NaN gsis_id (undrafted-
        # supplemental-style rows, or a player nflverse hasn't assigned an id
        # to yet -- e.g. 7 of 80 in the 2026 class) -- a NaN player_id blows
        # up json.dumps(..., allow_nan=False) downstream, so synthesize a
        # stable, unique id from the draft slot instead. Name+position
        # dedupe above already covers these players if/when the real model
        # picks them up later.
        pid = (r["gsis_id"] if pd.notna(r["gsis_id"])
               else f"draft{season}-p{int(r['pick']):03d}")
        row = {"player_id": pid, "name": r["player_name"],
               "team": r["team"], "position": r["position"],
               "games": scheduled, "rookie": True}
        for rn, rules in RULESETS.items():
            pts = fantasy_points_quantiles(frames, rules)
            triple = (float(pts["p10"].iloc[0]), float(pts["p50"].iloc[0]),
                      float(pts["p90"].iloc[0]))
            sim = simulate_season(np.array([triple] * scheduled), games_probs,
                                  n_draws, rng,
                                  rho=rho_map.get(r["position"], 0.0))
            row[f"{rn}_p10"] = sim["p10"]
            row[f"{rn}_p50"] = sim["p50"]
            row[f"{rn}_p90"] = sim["p90"]
        rows.append(row)
    meta = {"classes": f"2012–{season - 1}",
            "n_rookies": len(rows),
            "min_n": cohorts["min_n"],
            "buckets": {pos: d["merge_map"]
                        for pos, d in cohorts["positions"].items()}}
    columns = ["player_id", "name", "team", "position",
               *[f"{rn}_{q}" for rn in RULESETS for q in ("p10", "p50", "p90")],
               "games", "rookie"]
    return pd.DataFrame(rows, columns=columns), meta


def _finalize_board(players: pd.DataFrame, model: str, season: int,
                    data_through: str, has_bands: bool, n_draws: int = 2000,
                    rookie_prior: dict | None = None) -> dict:
    frames = []
    for pos, group in players.groupby("position"):
        group = group.sort_values("ppr_p50", ascending=False).reset_index(drop=True)
        rank = REPLACEMENT_RANK.get(pos, 20)
        replacement = group["ppr_p50"].iloc[min(rank, len(group)) - 1]
        group["vorp"] = (group["ppr_p50"] - replacement).round(2)
        group["position_rank"] = group.index + 1
        group["tier"] = _assign_tiers(group["vorp"], rank)
        frames.append(group)
    board = pd.concat(frames).sort_values("vorp", ascending=False)

    def _band(value) -> float | None:
        return None if pd.isna(value) else round(float(value), 1)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_through": data_through, "season": season, "model": model,
        "has_bands": has_bands,
        "methodology": {
            "seeding": "end-of-prior-season form",
            "bands": "simulated season distribution (calibrated weekly bands, "
                     "availability-adjusted)",
            "replacement_rank": REPLACEMENT_RANK,
            "n_draws": n_draws,
        },
        "players": [{
            "player_id": row["player_id"], "name": row["name"], "team": row["team"],
            "position": row["position"],
            "season_points": {rn: {"p50": round(float(row[f"{rn}_p50"]), 1),
                                   "p10": _band(row[f"{rn}_p10"]),
                                   "p90": _band(row[f"{rn}_p90"])}
                              for rn in ("ppr", "half_ppr", "standard")},
            "games": int(row["games"]),
            "bye": None if pd.isna(row["bye"]) else int(row["bye"]),
            "vorp": float(row["vorp"]),
            "position_rank": int(row["position_rank"]),
            "tier": int(row["tier"]),
            "rookie": bool(row["rookie"]) if "rookie" in row.index else False,
        } for _, row in board.iterrows()],
    }
    if rookie_prior is not None:
        payload["methodology"]["rookie_prior"] = rookie_prior
    return payload


def build_draft_board(weekly: pd.DataFrame, schedules: pd.DataFrame, predictor,
                      season: int, data_through: str, weeks=range(1, 19),
                      prefit: bool = False, *, n_draws: int = 2000, seed: int = 0,
                      games_dist: dict[str, np.ndarray] | None = None,
                      diagnostics: dict | None = None,
                      sleeper_players: dict | None = None,
                      draft_picks: pd.DataFrame | None = None,
                      rookie_min_n: int | None = None) -> dict:
    players = season_projection(weekly, schedules, predictor, season, weeks, prefit=prefit,
                                n_draws=n_draws, seed=seed, games_dist=games_dist,
                                diagnostics=diagnostics)
    if players.empty:
        raise RuntimeError(
            f"no future games found for season {season} weeks {list(weeks)} — "
            f"refusing to build an empty draft board"
        )
    season_sched = schedules[schedules["season"] == season]
    weeks_list = list(weeks)
    team_weeks = pd.concat([
        season_sched.rename(columns={"home_team": "team"})[["team", "week"]],
        season_sched.rename(columns={"away_team": "team"})[["team", "week"]],
    ])

    rookie_prior_meta = None
    players["rookie"] = False
    if draft_picks is not None:
        rookie_rows, rookie_prior_meta = _rookie_frame(
            weekly, draft_picks, season, players, team_weeks, weeks_list,
            n_draws=n_draws, seed=seed, rookie_min_n=rookie_min_n)
        players = pd.concat([players, rookie_rows], ignore_index=True)

    def _bye(team: str):
        played = set(team_weeks[team_weeks["team"] == team]["week"])
        missing = [w for w in weeks_list if w not in played]
        return int(missing[0]) if len(missing) == 1 else None

    players["bye"] = players["team"].map(_bye)
    has_bands = hasattr(predictor, "predict_quantiles")
    payload = _finalize_board(players, predictor.name, season, data_through, has_bands,
                              n_draws, rookie_prior=rookie_prior_meta)
    if sleeper_players is not None:
        # Deferred import keeps draft.py import-light for consumers that
        # never touch draft mode (board backtests, tests).
        from ffmodel.site.sleeper import build_crosswalk

        mapping, stats = build_crosswalk(payload["players"], sleeper_players)
        if stats["unmatched"] == len(payload["players"]):
            raise RuntimeError(
                "sleeper crosswalk matched zero board players — dump format "
                "drift? refusing to publish a board with dead draft mode")
        for p in payload["players"]:
            p["sleeper_id"] = mapping.get(p["player_id"])
        payload["crosswalk"] = stats
    return payload
