"""The league contract: what makes a draft board league-specific.

Roster shape, league size and scoring are what the board is VALUED under, so
they ship WITH the board rather than living as constants beside the code that
reads them. A board and a contract that disagree is the failure this module
exists to make impossible.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

import yaml

from ffmodel.scoring import ScoringRules

LEAGUE_DIR = Path("configs/leagues")

# The ruleset key every league's own scoring is published under. CONSTANT
# across leagues on purpose: `season_points.league` is a published payload key
# and optimizer.js's VALUE_LENS_ORDER = ["league", "ppr"] reads it by name.
# Each league's YAML decides what "league" means; the key itself never moves.
BOARD_RULESET = "league"

_REQUIRED = ("name", "league_id", "teams", "roster", "flex", "flex_positions",
             "rounds", "scoring", "depth_cap")

SLEEPER_RULE_FIELDS = {
    "pass_yd": "pass_yd", "pass_td": "pass_td", "pass_int": "interception",
    "pass_int_td": "pass_int_td", "rush_yd": "rush_yd", "rush_td": "rush_td",
    "rec_yd": "rec_yd", "rec_td": "rec_td", "rec": "reception",
    "fum_lost": "fumble_lost", "pass_2pt": "two_point",
    "rush_2pt": "two_point", "rec_2pt": "two_point", "st_td": "st_td",
}


@dataclass(frozen=True)
class LeagueConfig:
    slug: str
    name: str
    league_id: str
    teams: int
    roster: dict[str, int]            # PER TEAM
    flex: int                         # PER TEAM
    flex_positions: tuple[str, ...]
    rounds: int
    scoring: dict[str, float]
    depth_cap: dict[str, int]
    keeper_rules: str | None = None
    sleeper_scoring: dict[str, float] | None = None
    # Which site hosts this league. Live draft mode, the keeper panel and the
    # trade panel all speak Sleeper's API and NOTHING else, so a non-Sleeper
    # league gets a static board and the page must not offer it controls that
    # cannot work. Defaults to "sleeper" so both existing configs are unchanged.
    platform: str = "sleeper"

    @property
    def dedicated(self) -> dict[str, int]:
        """LEAGUE-WIDE dedicated starters -- per-team roster x teams.

        This is what board_rank.flex_replacement_ranks expects. Do not pass
        `roster` here: for Gabagool that is a 12x error."""
        return {pos: n * self.teams for pos, n in self.roster.items()}

    @property
    def flex_slots(self) -> int:
        """LEAGUE-WIDE flex slots. NOT `flex`, which is per team (2 vs 24)."""
        return self.flex * self.teams

    @property
    def starters(self) -> int:
        """Per-team starting lineup size. optimizer.js's ROLLOUT_PICKS."""
        return sum(self.roster.values()) + self.flex

    @property
    def total_picks(self) -> int:
        """Picks in the whole draft -- the bound past which an ADP-vs-rank
        difference describes picks that do not exist."""
        return self.teams * self.rounds

    @property
    def rules(self) -> ScoringRules:
        return ScoringRules(name=BOARD_RULESET, **self.scoring)

    @property
    def board_file(self) -> str:
        """Gabagool keeps the existing filename so its published URL and the
        site's default fetch are untouched."""
        return ("draft.json" if self.slug == "gabagool"
                else f"draft-{self.slug}.json")

    @property
    def weekly_file(self) -> str:
        return "weekly.json" if self.slug == "gabagool" else f"weekly-{self.slug}.json"

    def payload(self) -> dict:
        """The block embedded in the board, and the browser's whole contract."""
        out = {
            "slug": self.slug, "name": self.name, "league_id": self.league_id,
            "teams": self.teams, "roster": dict(self.roster),
            "flex": self.flex, "flex_positions": list(self.flex_positions),
            "rounds": self.rounds, "starters": self.starters,
            "total_picks": self.total_picks, "depth_cap": dict(self.depth_cap),
            "board_ruleset": BOARD_RULESET, "platform": self.platform,
            "scoring": {k: v for k, v in asdict(self.rules).items() if k != "name"},
        }
        if self.sleeper_scoring is not None:
            out["sleeper_scoring"] = dict(self.sleeper_scoring)
            # These events have scoring rules but no trained projection head.
            # Recording a rule is not evidence that the value curve includes it.
            extras = ("pass_int_td", "pass_td_50p", "rush_td_50p", "rec_td_50p",
                      "pass_2pt", "rush_2pt", "rec_2pt", "fum_rec_td", "st_td")
            out["unprojected_scoring"] = {
                k: self.sleeper_scoring[k] for k in extras
                if self.sleeper_scoring.get(k, 0) != 0
            }
        if self.keeper_rules is not None:
            out["keeper_rules"] = self.keeper_rules
        return out


def load_league(slug: str, root: Path | None = None) -> LeagueConfig:
    """Load `configs/leagues/<slug>.yaml`.

    A missing slug RAISES. It must never fall back to another league's
    contract: that would publish a board valued under the wrong scoring and
    the wrong replacement level, with nothing on the artifact to show it.
    """
    directory = root or LEAGUE_DIR
    path = directory / f"{slug}.yaml"
    if not path.exists():
        available = sorted(p.stem for p in directory.glob("*.yaml"))
        raise FileNotFoundError(
            f"no league config for {slug!r} at {path} -- available: {available}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    missing = [k for k in _REQUIRED if k not in data]
    if missing:
        raise ValueError(f"{path}: missing required key(s) {missing}")
    cfg = LeagueConfig(
        slug=slug, name=data["name"], league_id=str(data["league_id"]),
        teams=int(data["teams"]), roster=dict(data["roster"]),
        flex=int(data["flex"]), flex_positions=tuple(data["flex_positions"]),
        rounds=int(data["rounds"]), scoring=dict(data["scoring"]),
        depth_cap=dict(data["depth_cap"]), keeper_rules=data.get("keeper_rules"),
        platform=str(data.get("platform", "sleeper")),
        sleeper_scoring=(dict(data["sleeper_scoring"])
                         if "sleeper_scoring" in data else None))
    if cfg.sleeper_scoring is not None:
        for key, field in SLEEPER_RULE_FIELDS.items():
            if float(cfg.sleeper_scoring.get(key, 0)) != getattr(cfg.rules, field):
                raise ValueError(f"{path}: scoring.{field} disagrees with sleeper_scoring.{key}")
    return cfg
