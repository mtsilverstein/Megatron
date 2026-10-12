"""A small synthetic NFL world for the lines-screen driver tests.

Four canonical teams, two games a week, seasons 2022-2025 x weeks 1-4, seven
players per team. Every number is invented by a seeded RNG -- no real
statistics and no real betting lines.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ffmodel.data.features import build_features
from ffmodel.scoring import PREDICTED_STATS

from tests.test_features import make_weekly

TEAMS = ("KC", "BUF", "MIA", "NYJ")
ROSTER = (("QB", 1), ("RB", 2), ("WR", 3), ("TE", 1))
WORLD_SEASONS = (2022, 2023, 2024, 2025)
WEEKS = 4


def _pairings(week: int) -> list[tuple[str, str]]:
    """(home, away) pairs; home sides alternate by week."""
    if week % 2:
        return [("KC", "BUF"), ("MIA", "NYJ")]
    return [("BUF", "KC"), ("NYJ", "MIA")]


def _stat_line(rng: np.random.Generator, position: str) -> dict:
    line = {s: 0.0 for s in PREDICTED_STATS}
    if position == "QB":
        line.update(passing_yards=float(rng.normal(240, 50)), passing_tds=float(rng.poisson(1.6)),
                    passing_interceptions=float(rng.poisson(0.8)), carries=float(rng.poisson(3)),
                    rushing_yards=float(rng.normal(12, 6)))
    elif position == "RB":
        carries = float(rng.poisson(12))
        line.update(carries=carries, rushing_yards=float(carries * 4.2 + rng.normal(0, 10)),
                    rushing_tds=float(rng.poisson(0.4)), targets=float(rng.poisson(3)),
                    receptions=float(rng.poisson(2)), receiving_yards=float(rng.normal(15, 8)),
                    fumbles_lost=float(rng.poisson(0.05)))
    else:
        scale = 1.0 if position == "WR" else 0.6
        targets = float(rng.poisson(7 * scale))
        receptions = float(rng.binomial(int(targets), 0.65))
        line.update(targets=targets, receptions=receptions,
                    receiving_yards=float(receptions * 12 + rng.normal(0, 8)),
                    receiving_tds=float(rng.poisson(0.4 * scale)))
    return line


def world(seed: int = 0) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """(weekly, schedules, raw_schedule_payload) for the synthetic world."""
    rng = np.random.default_rng(seed)
    weekly_rows, sched_rows, raw_rows = [], [], []
    for season in WORLD_SEASONS:
        days = pd.date_range(f"{season}-09-10", periods=WEEKS, freq="7D").strftime("%Y-%m-%d")
        for week in range(1, WEEKS + 1):
            for home, away in _pairings(week):
                total = float(np.round(rng.uniform(40, 52) * 2) / 2)
                spread = float(np.round(rng.uniform(-7, 7) * 2) / 2)
                sched_rows.append({"season": season, "week": week, "gameday": days[week - 1],
                                   "home_team": home, "away_team": away})
                raw_rows.append({
                    "game_id": f"{season}_{week:02d}_{away}_{home}", "season": season,
                    "game_type": "REG", "week": week, "gameday": days[week - 1],
                    "away_team": away, "home_team": home, "away_score": int(rng.integers(10, 35)),
                    "home_score": int(rng.integers(10, 35)), "location": "Home", "result": 0,
                    "total": 0, "spread_line": spread, "total_line": total,
                })
                for team, opp in ((home, away), (away, home)):
                    for position, count in ROSTER:
                        for i in range(count):
                            weekly_rows.append({
                                "player_id": f"{team}_{position}{i}", "position": position,
                                "team": team, "opponent_team": opp, "season": season,
                                "week": week, **_stat_line(rng, position),
                            })
    weekly = make_weekly(weekly_rows)
    weekly["two_point_conversions"] = 1          # scoring extras present on actuals
    weekly["special_teams_tds"] = 1
    return weekly, pd.DataFrame(sched_rows), pd.DataFrame(raw_rows)


def world_features(seed: int = 0) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(build_features output, raw schedule payload)."""
    weekly, sched, raw = world(seed)
    return build_features(weekly, sched), raw


class FakePredictor:
    """Deterministic stand-in for XGBBaseline: last-4 average per component
    (train mean when missing), nudged by the seed; arm B also reads the
    expected margin so the arms differ. Consumes only frozen-frame columns."""

    def __init__(self, arm: str, seed: int, bad: str | None = None):
        self.arm, self.seed, self.bad = arm, seed, bad
        self.name = f"fake_{arm}_{seed}"

    def fit(self, train: pd.DataFrame) -> None:
        self.means = train[PREDICTED_STATS].mean()

    def predict(self, test: pd.DataFrame) -> pd.DataFrame:
        out = pd.DataFrame(index=test.index)
        for stat in PREDICTED_STATS:
            out[stat] = test[f"lag4_{stat}"].fillna(self.means[stat]) * (1 + 0.01 * self.seed)
        if self.arm == "B":
            out["receiving_yards"] = out["receiving_yards"] + test["team_expected_margin"].fillna(0)
        if self.bad == "nan" and self.arm == "B":
            out.iloc[0, 0] = np.nan
        if self.bad == "misaligned":
            out = out.iloc[::-1].reset_index(drop=True)
        if self.bad == "missing_column":
            out = out.drop(columns=["receptions"])
        return out[[c for c in PREDICTED_STATS if c in out.columns]]
