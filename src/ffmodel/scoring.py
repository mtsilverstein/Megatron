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


def fantasy_points(stats: pd.DataFrame, rules: ScoringRules = PPR) -> pd.Series:
    """Score a stat-line frame. Missing columns count as zero."""

    def col(name: str) -> pd.Series:
        if name in stats.columns:
            return stats[name].fillna(0)
        return pd.Series(0.0, index=stats.index)

    return (
        col("passing_yards") * rules.pass_yd
        + col("passing_tds") * rules.pass_td
        + col("passing_interceptions") * rules.interception
        + col("rushing_yards") * rules.rush_yd
        + col("rushing_tds") * rules.rush_td
        + col("receiving_yards") * rules.rec_yd
        + col("receiving_tds") * rules.rec_td
        + col("receptions") * rules.reception
        + col("fumbles_lost") * rules.fumble_lost
        + col("two_point_conversions") * rules.two_point
        + col("special_teams_tds") * rules.st_td
    )
