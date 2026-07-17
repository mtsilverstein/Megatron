"""Stat-line -> fantasy-points scoring. The stat-line column contract lives here."""
from dataclasses import dataclass

import pandas as pd

# The stat components every model predicts, in fixed order (model output
# heads and label columns follow this order everywhere).
PREDICTED_STATS = [
    "passing_yards", "passing_tds", "passing_interceptions",
    "carries", "rushing_yards", "rushing_tds",
    "targets", "receptions", "receiving_yards", "receiving_tds",
    "fumbles_lost",
]

# Columns that affect scoring but are not predicted; present on actuals so
# our points match official totals, absent (-> 0) on model output.
SCORING_EXTRAS = ["two_point_conversions", "special_teams_tds"]


@dataclass(frozen=True)
class ScoringRules:
    name: str
    pass_yd: float = 0.04
    pass_td: float = 4.0
    interception: float = -2.0
    rush_yd: float = 0.1
    rush_td: float = 6.0
    rec_yd: float = 0.1
    rec_td: float = 6.0
    reception: float = 1.0
    fumble_lost: float = -2.0
    two_point: float = 2.0
    st_td: float = 6.0


PPR = ScoringRules(name="ppr", reception=1.0)
HALF_PPR = ScoringRules(name="half_ppr", reception=0.5)
STANDARD = ScoringRules(name="standard", reception=0.0)


def stat_weights(rules: ScoringRules = PPR) -> dict[str, float]:
    """Column -> point weight: the single source of truth that fantasy_points
    and fantasy_points_band share. Only scored columns appear — `carries` and
    `targets` are predicted but never scored, so they are absent (-> 0)."""
    return {
        "passing_yards": rules.pass_yd,
        "passing_tds": rules.pass_td,
        "passing_interceptions": rules.interception,
        "rushing_yards": rules.rush_yd,
        "rushing_tds": rules.rush_td,
        "receiving_yards": rules.rec_yd,
        "receiving_tds": rules.rec_td,
        "receptions": rules.reception,
        "fumbles_lost": rules.fumble_lost,
        "two_point_conversions": rules.two_point,
        "special_teams_tds": rules.st_td,
    }


def _col(stats: pd.DataFrame, name: str) -> pd.Series:
    if name in stats.columns:
        return stats[name].fillna(0)
    return pd.Series(0.0, index=stats.index)


def fantasy_points(stats: pd.DataFrame, rules: ScoringRules = PPR) -> pd.Series:
    """Score a stat-line frame. Missing columns count as zero."""
    total = pd.Series(0.0, index=stats.index)
    for name, weight in stat_weights(rules).items():
        total = total + _col(stats, name) * weight
    return total


def fantasy_points_band(
    low: pd.DataFrame, high: pd.DataFrame, rules: ScoringRules = PPR
) -> tuple[pd.Series, pd.Series]:
    """Sign-coherent (floor, ceiling) point band from a per-component quantile
    pair (`low` = e.g. p10 stat frame, `high` = p90 stat frame).

    fantasy_points is a *signed* linear combination, so the points-maximising
    outcome takes each component at its HIGH quantile when the stat is scored
    positively and at its LOW quantile when scored negatively (interceptions,
    fumbles). Scoring `high` directly — the old band — put a passer's
    worst-case interceptions into his ceiling and his best-case (fewest) into
    his floor, biasing the band inward and understating QB ceilings. This
    pairs every component with its own points-favourable end instead. Returns
    (floor, ceiling), floor <= ceiling whenever low <= high componentwise.
    `low` and `high` must share an index (same rows)."""
    if not low.index.equals(high.index):
        raise ValueError("fantasy_points_band: low/high index mismatch — "
                         "quantile frames must describe the same rows")
    floor = pd.Series(0.0, index=low.index)
    ceil = pd.Series(0.0, index=low.index)
    for name, weight in stat_weights(rules).items():
        pair = pd.concat([_col(low, name) * weight, _col(high, name) * weight], axis=1)
        ceil = ceil + pair.max(axis=1)
        floor = floor + pair.min(axis=1)
    return floor, ceil


def fantasy_points_quantiles(
    frames: dict[str, pd.DataFrame | None], rules: ScoringRules = PPR
) -> dict[str, pd.Series | None]:
    """Point quantiles {'p10','p50','p90'} from stat-frame quantiles. p50 is the
    scored median; p10/p90 are the sign-coherent floor/ceiling (see
    fantasy_points_band). A None p10 or p90 (point-only predictors) yields None
    for both bands."""
    p50_frame = frames.get("p50")
    p50 = None if p50_frame is None else fantasy_points(p50_frame, rules)
    low, high = frames.get("p10"), frames.get("p90")
    if low is None or high is None:
        return {"p10": None, "p50": p50, "p90": None}
    floor, ceil = fantasy_points_band(low, high, rules)
    return {"p10": floor, "p50": p50, "p90": ceil}
