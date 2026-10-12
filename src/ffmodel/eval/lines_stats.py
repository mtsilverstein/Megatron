"""Pre-registered statistics for the betting-lines screen.

Spec: docs/superpowers/specs/2026-10-11-lines-feature-screen-design.md §4-7.
Pure functions over the paired row-level frame the collector produces:
one row per test player-week with `player_id`, `season`, `week`,
`position`, `actual` and one PPR point prediction per arm and seed in
columns named by `pred_col(arm, seed)`.

Every threshold below is fixed by the spec. Nothing here is tuned.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import rankdata

from ffmodel.data.pull import POSITIONS

ARMS = ("A", "B")
SEEDS = (0, 1, 2)
TEST_SEASONS = (2023, 2024, 2025)
RNG_SEED = 20261007
N_ACCEPT = 10_000
MAX_ATTEMPTS = 100_000
PERCENTILES = (2.5, 97.5)                 # central 95%
PERCENTILE_METHOD = "linear"
RELEVANT_MIN_PPR = 8.0                    # §5.3 membership: mean_s predA >= 8
MATERIALITY = 0.05                        # §6.1
SEASON_FLOOR = -0.05                      # §6.4
MAX_DETERIORATION = 0.10                  # §5.3 guardrail
RANKING_VETO_BELOW = -0.005               # §5.4
MIN_CELL_PLAYERS = 5                      # §5.4


class ScreenInvalid(RuntimeError):
    """The run cannot produce a valid result (spec §7) -> disposition `invalid`."""


def pred_col(arm: str, seed: int) -> str:
    return f"pred_{arm}_{seed}"


def _finite(x) -> bool:
    return x is not None and bool(np.isfinite(x))


# --- §4 / §5.1 point effects ------------------------------------------------

def loss_differences(paired: pd.DataFrame, seeds) -> pd.DataFrame:
    """d_{i,s} = |actual - predA_s| - |actual - predB_s| per seed (`d_<s>`),
    and the seed-averaged `d` = mean_s d_{i,s}. Positive = lines helped.
    Loss is taken per seed BEFORE averaging -- never loss of averaged predictions."""
    actual = paired["actual"].to_numpy(float)
    out = {}
    for s in seeds:
        out[f"d_{s}"] = (np.abs(actual - paired[pred_col("A", s)].to_numpy(float))
                         - np.abs(actual - paired[pred_col("B", s)].to_numpy(float)))
    frame = pd.DataFrame(out, index=paired.index)
    frame["d"] = frame[[f"d_{s}" for s in seeds]].mean(axis=1)
    return frame


def season_equal_mean(values: np.ndarray, seasons: np.ndarray,
                      season_order) -> tuple[float, dict[int, float]]:
    """Rows averaged within season, seasons weighted equally. A season with no
    rows yields NaN (so the caller's finiteness check makes the run invalid)."""
    by_season = {}
    for s in season_order:
        mask = seasons == s
        by_season[int(s)] = float(values[mask].mean()) if mask.any() else float("nan")
    return float(np.mean(list(by_season.values()))), by_season


def point_effects(paired: pd.DataFrame, seeds, season_order) -> dict:
    """G, per-season G_S and per-seed G^(s) (same formula on d_{i,s})."""
    d = loss_differences(paired, seeds)
    seasons = paired["season"].to_numpy()
    G, G_S = season_equal_mean(d["d"].to_numpy(), seasons, season_order)
    G_seed = {int(s): season_equal_mean(d[f"d_{s}"].to_numpy(), seasons, season_order)[0]
              for s in seeds}
    return {"G": G, "G_S": G_S, "G_seed": G_seed}


# --- §5.3 relevant cohort ----------------------------------------------------

def relevant_membership(paired: pd.DataFrame, seeds) -> np.ndarray:
    """Frozen once from arm A only: mean_s predA_{i,s} >= 8 PPR."""
    pred_a = paired[[pred_col("A", s) for s in seeds]].to_numpy(float).mean(axis=1)
    return pred_a >= RELEVANT_MIN_PPR


def relevant_counts(paired: pd.DataFrame, relevant: np.ndarray, season_order) -> dict:
    """Cohort counts; raises ScreenInvalid if an original season has no
    relevant row (spec §5.3: invalid immediately, before any bootstrap)."""
    rel = paired[relevant]
    empty = [int(s) for s in season_order if not (rel["season"] == s).any()]
    if empty:
        raise ScreenInvalid(f"no relevant-cohort rows in season(s) {empty}")
    blocks = (rel["week"].astype(int) - 1) // 2
    return {
        "rows": int(len(rel)),
        "rows_by_season": {int(s): int((rel["season"] == s).sum()) for s in season_order},
        "rows_by_season_position": {
            int(s): {p: int(((rel["season"] == s) & (rel["position"] == p)).sum()) for p in POSITIONS}
            for s in season_order},
        "unique_players": int(rel["player_id"].nunique()),
        "blocks_represented_by_season": {
            int(s): int(blocks[rel["season"] == s].nunique()) for s in season_order},
    }


# --- §5.2 crossed bootstrap ----------------------------------------------------

@dataclass(frozen=True)
class BootstrapDesign:
    season_order: tuple[int, ...]
    season_code: np.ndarray        # row -> index into season_order
    player_code: np.ndarray        # row -> index into sorted distinct player_ids
    n_players: int
    block_code: np.ndarray         # row -> index into its season's sorted block list
    n_blocks: tuple[int, ...]      # per season, in season_order


def make_design(paired: pd.DataFrame, season_order) -> BootstrapDesign:
    season_order = tuple(int(s) for s in season_order)
    seasons = paired["season"].to_numpy().astype(int)
    season_index = {s: i for i, s in enumerate(season_order)}
    if not set(np.unique(seasons)) <= set(season_order):
        raise ScreenInvalid("paired rows contain a season outside the test seasons")
    season_code = np.array([season_index[s] for s in seasons], dtype=np.int64)
    players = np.array(sorted(pd.unique(paired["player_id"]).tolist()), dtype=object)
    player_code = np.searchsorted(players, paired["player_id"].to_numpy(dtype=object))
    block = (paired["week"].to_numpy().astype(int) - 1) // 2
    block_code = np.empty(len(paired), dtype=np.int64)
    n_blocks = []
    for i, s in enumerate(season_order):
        mask = season_code == i
        blocks = np.unique(block[mask])            # sorted block list for the season
        n_blocks.append(len(blocks))
        block_code[mask] = np.searchsorted(blocks, block[mask])
    return BootstrapDesign(season_order, season_code, player_code.astype(np.int64),
                           len(players), block_code, tuple(n_blocks))


def draw_counts(rng: np.random.Generator,
                design: BootstrapDesign) -> tuple[np.ndarray, list[np.ndarray]]:
    """One replicate's draws, in the registered order: P player indices with
    replacement, then each season's block list (ascending seasons)."""
    players = rng.integers(0, design.n_players, size=design.n_players)
    player_counts = np.bincount(players, minlength=design.n_players)
    block_counts = []
    for k in design.n_blocks:
        draws = rng.integers(0, k, size=k)
        block_counts.append(np.bincount(draws, minlength=k))
    return player_counts, block_counts


def row_weights(design: BootstrapDesign, player_counts: np.ndarray,
                block_counts: list[np.ndarray]) -> np.ndarray:
    """w_i = player_count[player_i] * block_count[season_i, block_i]."""
    block_w = np.empty(len(design.season_code), dtype=np.int64)
    for i, counts in enumerate(block_counts):
        mask = design.season_code == i
        block_w[mask] = counts[design.block_code[mask]]
    return player_counts[design.player_code] * block_w


def crossed_bootstrap(paired: pd.DataFrame, seeds, relevant: np.ndarray, season_order, *,
                      n_accept: int = N_ACCEPT, max_attempts: int = MAX_ATTEMPTS,
                      rng_seed: int = RNG_SEED) -> dict:
    """Accepted replicates of G*, G_S*, G^(s)* and G_rel* (spec §5.2-5.3).

    A replicate is rejected (and counted) when any season's total weight is
    zero, or any season's relevant-cohort weight is zero -- jointly, so every
    statistic shares the same accepted replicates. Raises ScreenInvalid if
    `n_accept` replicates are not reached within `max_attempts`.
    """
    design = make_design(paired, season_order)
    d = loss_differences(paired, seeds)
    columns = ["d"] + [f"d_{s}" for s in seeds]
    D = d[columns].to_numpy(float)                               # n x (1 + seeds)
    n_seasons = len(design.season_order)
    onehot = np.zeros((len(paired), n_seasons))
    onehot[np.arange(len(paired)), design.season_code] = 1.0
    rel = relevant.astype(float)
    rng = np.random.Generator(np.random.PCG64(rng_seed))
    G = np.empty(n_accept)
    G_S = np.empty((n_accept, n_seasons))
    G_seed = np.empty((n_accept, len(seeds)))
    G_rel = np.empty(n_accept)
    accepted = attempts = 0
    while accepted < n_accept:
        if attempts >= max_attempts:
            raise ScreenInvalid(
                f"only {accepted} of {n_accept} bootstrap replicates accepted "
                f"within {max_attempts} attempts")
        attempts += 1
        w = row_weights(design, *draw_counts(rng, design)).astype(float)
        den = onehot.T @ w
        den_rel = onehot.T @ (w * rel)
        if (den == 0).any() or (den_rel == 0).any():
            continue
        season_means = (onehot.T @ (D * w[:, None])) / den[:, None]   # seasons x cols
        rel_means = (onehot.T @ (D[:, 0] * w * rel)) / den_rel
        G_S[accepted] = season_means[:, 0]
        G[accepted] = season_means[:, 0].mean()
        G_seed[accepted] = season_means[:, 1:].mean(axis=0)
        G_rel[accepted] = rel_means.mean()
        accepted += 1
    return {"accepted": accepted, "attempts": attempts, "rejected": attempts - accepted,
            "G": G, "G_S": G_S, "G_seed": G_seed, "G_rel": G_rel}


def percentile_interval(samples: np.ndarray) -> list[float]:
    lo, hi = np.percentile(samples, PERCENTILES, method=PERCENTILE_METHOD)
    return [float(lo), float(hi)]


# --- §5.4 ranking status ---------------------------------------------------------

def _spearman(x: np.ndarray, y: np.ndarray) -> float:
    """Average-rank Spearman. Callers guarantee neither input is constant."""
    rx = rankdata(x, method="average")
    ry = rankdata(y, method="average")
    rx = rx - rx.mean()
    ry = ry - ry.mean()
    return float((rx * ry).sum() / np.sqrt((rx * rx).sum() * (ry * ry).sum()))


def ranking_status(paired: pd.DataFrame, seeds, season_order) -> dict:
    """Pooled seed-averaged Spearman delta R (B - A) over (season, week,
    position) cells; status ranking_ok / ranking_veto / ranking_not_evaluable.
    Independent of the point gate and of validity."""
    excluded = {"too_few_players": 0, "constant_actual": 0}
    constant_prediction_cells = []
    cells = []                                  # (season, position, delta or None)
    for (season, week, position), cell in paired.groupby(["season", "week", "position"], sort=True):
        if position not in POSITIONS or int(season) not in season_order:
            continue
        if cell["player_id"].nunique() < MIN_CELL_PLAYERS:
            excluded["too_few_players"] += 1
            continue
        actual = cell["actual"].to_numpy(float)
        if np.ptp(actual) == 0:
            excluded["constant_actual"] += 1
            continue
        deltas, constant = [], []
        for s in seeds:
            rho = {}
            for arm in ARMS:
                pred = cell[pred_col(arm, s)].to_numpy(float)
                if not np.isfinite(pred).all():
                    raise ScreenInvalid("non-finite prediction reached ranking")
                if np.ptp(pred) == 0:
                    constant.append(f"{arm}/seed{s}")
                    continue
                rho[arm] = _spearman(pred, actual)
            if len(rho) == 2:
                deltas.append(rho["B"] - rho["A"])
        if constant:
            constant_prediction_cells.append(
                {"season": int(season), "week": int(week), "position": position, "arms": constant})
            cells.append((int(season), position, None))
        else:
            cells.append((int(season), position, float(np.mean(deltas))))

    reasons = []
    if constant_prediction_cells:
        reasons.append(f"finite constant prediction in {len(constant_prediction_cells)} eligible cell(s)")
    by_season = {}
    for s in season_order:
        vals = [v for (cs, _, v) in cells if cs == s]
        if not vals:
            reasons.append(f"season {s} has no eligible ranking cell")
            by_season[int(s)] = None
        elif any(v is None for v in vals):
            by_season[int(s)] = None
        else:
            by_season[int(s)] = float(np.mean(vals))
    by_position = {}
    for p in POSITIONS:
        per_season, why = [], None
        for s in season_order:
            vals = [v for (cs, cp, v) in cells if cs == s and cp == p]
            if not vals:
                why = f"no eligible {p} cell in season {s}"
                break
            if any(v is None for v in vals):
                why = f"constant prediction in an eligible {p} cell in season {s}"
                break
            per_season.append(float(np.mean(vals)))
        by_position[p] = ({"delta": None, "reason": why} if why is not None
                          else {"delta": float(np.mean(per_season)), "reason": None})
    n_eligible = len(cells)
    if reasons:
        return {"status": "ranking_not_evaluable", "R": None, "reasons": reasons,
                "R_by_season": by_season, "by_position": by_position,
                "eligible_cells": n_eligible, "excluded_cells": excluded,
                "constant_prediction_cells": constant_prediction_cells}
    R = float(np.mean(list(by_season.values())))
    status = "ranking_ok" if R >= RANKING_VETO_BELOW else "ranking_veto"
    return {"status": status, "R": R, "reasons": [], "R_by_season": by_season,
            "by_position": by_position, "eligible_cells": n_eligible,
            "excluded_cells": excluded, "constant_prediction_cells": []}


# --- §6 / §7 decision -------------------------------------------------------------

CONDITIONS = (
    "materiality",            # 1. G >= 0.05
    "interval_lower_above_0",  # 2. lower bound > 0
    "two_seasons_positive",   # 3. >= 2 of 3 seasons G_S > 0
    "no_season_below_floor",  # 4. no G_S < -0.05
    "all_seeds_positive",     # 5. every G^(s) > 0
    "relevant_guardrail",     # 6. H upper <= 0.10
)


def guardrail(G_rel: float, G_rel_interval: list[float]) -> dict:
    """H = -G_rel; its 95% upper endpoint is -(lower endpoint of G_rel's interval)."""
    h_upper = -G_rel_interval[0]
    return {"G_rel": G_rel, "G_rel_interval": G_rel_interval, "H": -G_rel,
            "H_upper": h_upper, "passed": bool(h_upper <= MAX_DETERIORATION)}


def validity_reasons(point: dict | None, guard: dict | None, season_order, seeds) -> list[str]:
    """Every metric §7 requires to be defined, checked BEFORE the six conditions.

    Required: G and both endpoints of G_interval; for every registered test
    season, G_S[S] and both endpoints of G_S_interval[S]; for every registered
    seed, G_seed[s] and both endpoints of G_seed_interval[s]; G_rel and both
    endpoints of G_rel_interval. A missing family, a missing entry, a malformed
    interval, None, NaN or +/-inf is named as `undefined point metric <name>`.
    """
    point, guard = point or {}, guard or {}
    reasons: list[str] = []

    def scalar(name: str, value) -> None:
        if not _finite(value):
            reasons.append(f"undefined point metric {name}")

    def interval(name: str, value) -> None:
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            reasons.append(f"undefined point metric {name} (missing or malformed interval)")
            return
        for end, v in zip(("lower", "upper"), value):
            scalar(f"{name}.{end}", v)

    scalar("G", point.get("G"))
    interval("G_interval", point.get("G_interval"))
    G_S, G_S_int = point.get("G_S") or {}, point.get("G_S_interval") or {}
    for s in season_order:
        scalar(f"G_S[{s}]", G_S.get(s))
        interval(f"G_S_interval[{s}]", G_S_int.get(s))
    G_seed, G_seed_int = point.get("G_seed") or {}, point.get("G_seed_interval") or {}
    for s in seeds:
        scalar(f"G_seed[{s}]", G_seed.get(s))
        interval(f"G_seed_interval[{s}]", G_seed_int.get(s))
    scalar("G_rel", guard.get("G_rel"))
    interval("G_rel_interval", guard.get("G_rel_interval"))
    return reasons


def decide(point: dict | None, guard: dict | None, invalid_reasons: list[str],
           season_order=TEST_SEASONS, seeds=SEEDS) -> dict:
    """Disposition with `invalid` decided first (spec §7), then the six
    conditions on unrounded values (§6), then the scientific failure label.
    `season_order` and `seeds` are the registered families every required
    metric must cover; the conditions read exactly those entries."""
    season_order = tuple(int(s) for s in season_order)
    seeds = tuple(int(s) for s in seeds)
    reasons = list(invalid_reasons)
    if not reasons:
        reasons = validity_reasons(point, guard, season_order, seeds)
    if reasons:
        return {"disposition": "invalid", "failure_label": None, "conditions": None,
                "failed_conditions": None, "invalid_reasons": reasons}
    G_S = [point["G_S"][s] for s in season_order]
    conditions = {
        "materiality": point["G"] >= MATERIALITY,
        "interval_lower_above_0": point["G_interval"][0] > 0,
        "two_seasons_positive": sum(g > 0 for g in G_S) >= 2,
        "no_season_below_floor": all(g >= SEASON_FLOOR for g in G_S),
        "all_seeds_positive": all(point["G_seed"][s] > 0 for s in seeds),
        "relevant_guardrail": guard["H_upper"] <= MAX_DETERIORATION,
    }
    conditions = {k: bool(v) for k, v in conditions.items()}
    failed = [k for k in CONDITIONS if not conditions[k]]
    if not failed:
        return {"disposition": "pass", "failure_label": None, "conditions": conditions,
                "failed_conditions": [], "invalid_reasons": []}
    label = "below_materiality" if point["G_interval"][1] < MATERIALITY else "inconclusive"
    return {"disposition": "fail", "failure_label": label, "conditions": conditions,
            "failed_conditions": failed, "invalid_reasons": []}


def consequences(decision: dict, ranking: dict | None) -> dict:
    """What the result buys (spec §5.4, §9). Both ranking_veto and
    ranking_not_evaluable forbid ranking recommendations and are carried into
    the forward test's pre-registration; neither changes the point gate."""
    status = None if ranking is None else ranking["status"]
    return {
        "buys_forward_shadow_test": decision["disposition"] == "pass",
        "ranking_status": status,
        "ranking_recommendation_forbidden": status != "ranking_ok",
        "carry_into_forward_preregistration": (
            {"ranking_status": status, "ranking_recommendation_forbidden": status != "ranking_ok"}
            if decision["disposition"] == "pass" else None),
        "site_change_authorized": False,
    }


def evaluate(paired: pd.DataFrame, seeds=SEEDS, season_order=TEST_SEASONS, *,
             n_accept: int = N_ACCEPT, max_attempts: int = MAX_ATTEMPTS,
             rng_seed: int = RNG_SEED) -> dict:
    """All §5-§7 outputs for one paired frame. Never raises ScreenInvalid:
    an invalid condition becomes disposition `invalid` with its reason."""
    seeds = tuple(int(s) for s in seeds)
    season_order = tuple(int(s) for s in season_order)
    preds = paired[[pred_col(a, s) for a in ARMS for s in seeds]].to_numpy(float)
    if not np.isfinite(preds).all() or not np.isfinite(paired["actual"].to_numpy(float)).all():
        decision = decide(None, None, ["non-finite prediction or actual in the paired frame"])
        return {"point": None, "bootstrap": None, "relevant": None, "ranking": None,
                "decision": decision, "consequences": consequences(decision, None)}
    ranking = ranking_status(paired, seeds, season_order)
    point = relevant = boot_summary = None
    invalid = []
    try:
        point = point_effects(paired, seeds, season_order)
        membership = relevant_membership(paired, seeds)
        counts = relevant_counts(paired, membership, season_order)   # may raise: before bootstrap
        G_rel, G_rel_S = season_equal_mean(
            loss_differences(paired, seeds)["d"].to_numpy()[membership],
            paired["season"].to_numpy()[membership], season_order)
        boot = crossed_bootstrap(paired, seeds, membership, season_order,
                                 n_accept=n_accept, max_attempts=max_attempts, rng_seed=rng_seed)
        point["G_interval"] = percentile_interval(boot["G"])
        point["G_S_interval"] = {s: percentile_interval(boot["G_S"][:, i])
                                 for i, s in enumerate(season_order)}
        point["G_seed_interval"] = {s: percentile_interval(boot["G_seed"][:, i])
                                    for i, s in enumerate(seeds)}
        relevant = {**guardrail(G_rel, percentile_interval(boot["G_rel"])),
                    "G_rel_by_season": G_rel_S, "counts": counts}
        boot_summary = {"accepted": boot["accepted"], "attempts": boot["attempts"],
                        "rejected": boot["rejected"]}
    except ScreenInvalid as exc:
        invalid.append(str(exc))
    decision = decide(point, relevant, invalid, season_order, seeds)
    return {"point": point, "bootstrap": boot_summary, "relevant": relevant,
            "ranking": ranking, "decision": decision,
            "consequences": consequences(decision, ranking)}
