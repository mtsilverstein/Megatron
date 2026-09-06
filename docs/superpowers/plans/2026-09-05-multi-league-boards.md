# Multi-League Draft Boards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the draft board's league contract data instead of constants, so the board, live Sleeper overlay and pick optimizer all serve two leagues — Gabagool Fools unchanged, FAM FOOTBALL new.

**Architecture:** A committed YAML per league (`configs/leagues/<slug>.yaml`) is loaded into a `LeagueConfig` that supplies roster shape, league size, scoring and depth caps. Python generation takes `--league <slug>` and writes one board per league, embedding the contract in the payload. The browser reads that embedded block and configures `optimizer.js` at load, and `draftmode.js` refuses any Sleeper draft whose shape disagrees with the loaded board.

**Tech Stack:** Python 3.12 (pandas, PyYAML, pytest), browser JS (no framework, UMD modules also loadable under Node), Node `assert` fixtures.

**Spec:** `docs/superpowers/specs/2026-09-05-multi-league-boards-design.md` — read it before starting; it carries the verified league settings and the rationale for every decision here.

## Global Constraints

- **Gabagool Fools drafts 2026-09-08 21:00 EDT and MUST NOT regress.** Task 4 is the gate: every pre-existing key in `site/data/draft.json` identical after regeneration, ignoring only `generated_at` and the new `league` block. One moved VORP means stop and report.
- **FAM FOOTBALL drafts the evening of 2026-09-06** with the full live overlay and optimizer.
- The board ruleset key stays the literal string **`"league"` for every league**. `season_points.league` is a published payload key and `optimizer.js`'s `VALUE_LENS_ORDER = ["league", "ppr"]` reads it. Each league's YAML defines what "league" *means*; the key never changes. Renaming it to the slug would break both the byte-identity gate and FAM's value lens.
- `roster` and `flex` in YAML and in the payload are **PER TEAM**. `LeagueConfig.dedicated` and `LeagueConfig.flex_slots` are **LEAGUE-WIDE**. Gabagool's flex values are 2 and 24 — a 12x error if confused.
- Verified league settings (from `api.sleeper.app` on 2026-09-05) — use these exact values:
  - Gabagool: `league_id 1376245373244301312`, teams 12, roster QB1/RB2/WR2/TE1, flex 2, rounds 15, `reception 1.0`, `pass_td 6.0`, `interception -2.0` (the `ScoringRules` default).
  - FAM: `league_id 1389736745205002240`, teams 10, roster QB1/RB2/WR2/TE1, flex 1, rounds 14, `reception 1.0`, `pass_td 4.0`, `interception -1.0`.
- No new network dependency in the generation path. Both leagues share the committed ADP/ECR snapshots.
- Do not touch `site/assets/trade.js`, `site/assets/keepers.js`, or the weekly payload. They stay Gabagool-only this round.

## File Structure

**Create**
- `src/ffmodel/league.py` — the `LeagueConfig` dataclass and `load_league`. Pure; no I/O beyond its own YAML.
- `configs/leagues/gabagool.yaml`, `configs/leagues/fam.yaml` — the two contracts.
- `tests/test_league.py` — loader tests.

**Modify**
- `src/ffmodel/site/board_rank.py` — thread `teams` into `adp_round`.
- `src/ffmodel/data/adp.py` — `DRAFTABLE_ADP` becomes a parameter.
- `src/ffmodel/site/weekly.py` — `set_league_rules`.
- `src/ffmodel/site/generate.py` — `--league`, and the four hardcoded team counts.
- `src/ffmodel/site/draft.py` — accept and embed the `league` payload block.
- `site/assets/optimizer.js` — `configure(league)`.
- `site/assets/draftmode.js` — league-scoped session key, league-mismatch guard.
- `site/index.html` — `?league=`, `configure` call, `Keepers.init` gate, pick-count bound.
- `tests/test_board_rank.py`, `tests/optimizer_fixture.cjs`, `tests/draftmode_fixture.cjs`.

---

### Task 1: League config module and the two contracts

**Files:**
- Create: `src/ffmodel/league.py`
- Create: `configs/leagues/gabagool.yaml`, `configs/leagues/fam.yaml`
- Test: `tests/test_league.py`

**Interfaces:**
- Consumes: `ffmodel.scoring.ScoringRules` — a frozen dataclass whose fields include `name: str`, `reception: float = 1.0`, `pass_td: float = 4.0`, `interception: float = -2.0`.
- Produces: `ffmodel.league.load_league(slug: str, root: Path | None = None) -> LeagueConfig`, with properties `dedicated: dict[str,int]`, `flex_slots: int`, `starters: int`, `total_picks: int`, `rules: ScoringRules`, `board_file: str`, and method `payload() -> dict`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_league.py
import pytest

from ffmodel.league import load_league


def test_gabagool_matches_todays_hardcoded_constants():
    cfg = load_league("gabagool")
    # These are the values generate.py hardcoded as LEAGUE_DEDICATED /
    # LEAGUE_FLEX_SLOTS. If the YAML disagrees, the byte-identity gate in
    # Task 4 will fail -- catch it here, where the message is legible.
    assert cfg.dedicated == {"QB": 12, "RB": 24, "WR": 24, "TE": 12}
    assert cfg.flex_slots == 24
    assert cfg.starters == 8
    assert cfg.total_picks == 180
    assert cfg.rules.pass_td == 6.0
    assert cfg.rules.interception == -2.0
    assert cfg.keeper_rules == "gabagool"


def test_fam_derives_a_ten_team_contract():
    cfg = load_league("fam")
    assert cfg.dedicated == {"QB": 10, "RB": 20, "WR": 20, "TE": 10}
    assert cfg.flex_slots == 10
    assert cfg.starters == 7          # one fewer flex than Gabagool
    assert cfg.total_picks == 140
    assert cfg.rules.pass_td == 4.0
    assert cfg.rules.interception == -1.0
    assert cfg.keeper_rules is None   # FAM's keeper rule is not implemented


def test_board_ruleset_key_is_league_for_every_league():
    # season_points.league is a published payload key and optimizer.js's
    # VALUE_LENS_ORDER reads it. The key is constant; the YAML decides what
    # it means. Renaming it per league breaks both boards' value lens.
    assert load_league("gabagool").rules.name == "league"
    assert load_league("fam").rules.name == "league"


def test_per_team_and_league_wide_flex_are_not_the_same_number():
    cfg = load_league("gabagool")
    assert cfg.flex == 2           # per team, what the browser wants
    assert cfg.flex_slots == 24    # league-wide, what replacement wants


def test_unknown_slug_raises_rather_than_falling_back():
    with pytest.raises(FileNotFoundError, match="no league config"):
        load_league("no_such_league")


def test_payload_omits_keeper_rules_when_absent():
    assert "keeper_rules" not in load_league("fam").payload()
    assert load_league("gabagool").payload()["keeper_rules"] == "gabagool"


def test_board_file_keeps_gabagool_at_the_existing_name():
    assert load_league("gabagool").board_file == "draft.json"
    assert load_league("fam").board_file == "draft-fam.json"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_league.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ffmodel.league'`

- [ ] **Step 3: Write the two league configs**

`configs/leagues/gabagool.yaml` — these values must reproduce today's constants exactly:

```yaml
# Gabagool Fools. Verified from api.sleeper.app/v1/league/<id> 2026-09-05.
# `roster` and `flex` are PER TEAM; league-wide counts are derived.
name: Gabagool Fools
league_id: "1376245373244301312"
teams: 12
roster: {QB: 1, RB: 2, WR: 2, TE: 1}
flex: 2
flex_positions: [RB, WR, TE]
rounds: 15
# Full PPR with SIX-point passing TDs. See ffmodel/scoring.py: measured on
# 2023-25 actuals this moves the top 24 QBs +46 to +50 points a season and
# reorders 4-8 of the top twelve, so it is a reordering, not a rescale.
scoring: {reception: 1.0, pass_td: 6.0}
# Shipped values, copied verbatim. A JUDGEMENT CALL, not a derivation: you
# start one QB and one TE so a second is bye cover, while RB and WR also fill
# the two flex slots and keep their depth value longer. Ties only.
depth_cap: {QB: 2, RB: 6, WR: 6, TE: 2}
keeper_rules: gabagool
```

`configs/leagues/fam.yaml`:

```yaml
# FAM FOOTBALL. Verified from api.sleeper.app/v1/league/<id> 2026-09-05.
# Rolling waivers (waiver_type 0), 1 keeper, K + DEF rostered but unprojected.
name: FAM FOOTBALL
league_id: "1389736745205002240"
teams: 10
roster: {QB: 1, RB: 2, WR: 2, TE: 1}
flex: 1
flex_positions: [RB, WR, TE]
rounds: 14
# PPR with FOUR-point passing TDs and -1 per interception. Every other
# skill-position weight matches Gabagool. FAM carries none of the bonus
# categories the model cannot predict (50-yard TD bonuses, pick-sixes), so
# this is an exact representation rather than an approximation.
scoring: {reception: 1.0, pass_td: 4.0, interception: -1.0}
# Gabagool's caps with RB and WR dropped by one, because optimizer.js's own
# comment reasons from "RB and WR fill the two flex slots as well" and FAM has
# one flex slot. UNMEASURED. Breaks ties only -- a player over the cap still
# wins outright whenever he improves the lineup.
depth_cap: {QB: 2, RB: 5, WR: 5, TE: 2}
# keeper_rules deliberately omitted: FAM allows 1 keeper but its cost rule is
# not known to this project, and keepers.js implements Gabagool's ladder only.
```

- [ ] **Step 4: Write the loader**

```python
# src/ffmodel/league.py
"""The league contract: what makes a draft board league-specific.

Roster shape, league size and scoring are what the board is VALUED under, so
they ship WITH the board rather than living as constants beside the code that
reads them. A board and a contract that disagree is the failure this module
exists to make impossible.
"""
from __future__ import annotations

from dataclasses import dataclass
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

    def payload(self) -> dict:
        """The block embedded in the board, and the browser's whole contract."""
        out = {
            "slug": self.slug, "name": self.name, "league_id": self.league_id,
            "teams": self.teams, "roster": dict(self.roster),
            "flex": self.flex, "flex_positions": list(self.flex_positions),
            "rounds": self.rounds, "starters": self.starters,
            "total_picks": self.total_picks, "depth_cap": dict(self.depth_cap),
            "board_ruleset": BOARD_RULESET,
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
    return LeagueConfig(
        slug=slug, name=data["name"], league_id=str(data["league_id"]),
        teams=int(data["teams"]), roster=dict(data["roster"]),
        flex=int(data["flex"]), flex_positions=tuple(data["flex_positions"]),
        rounds=int(data["rounds"]), scoring=dict(data["scoring"]),
        depth_cap=dict(data["depth_cap"]), keeper_rules=data.get("keeper_rules"))
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m pytest tests/test_league.py -v`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/ffmodel/league.py configs/leagues tests/test_league.py
git commit -m "feat: league contract as committed config"
```

---

### Task 2: Thread team count through the four hardcoded 12-team assumptions

**Files:**
- Modify: `src/ffmodel/site/board_rank.py:81-112` (`rank_board`, `adp_round` call)
- Modify: `src/ffmodel/data/adp.py:113` (`DRAFTABLE_ADP`), `adp.py:229` (its use)
- Test: `tests/test_board_rank.py`

**Interfaces:**
- Consumes: `adp_round(adp: float | None, teams: int = 12) -> int | None` (already exists, already parameterized — the bug is that `rank_board` never passes `teams`).
- Produces: `rank_board(players, replacement_rank, value_col="ppr_p50", teams=12)`; and in `adp.py`, the snapshot loader gains a `draftable_adp: int = DRAFTABLE_ADP` parameter.

**Context an implementer needs:** these are four places where a 12-team league is baked in. A FAM board that carries any of them looks correct and is silently wrong — that is the specific failure this whole plan exists to prevent. `DRAFTABLE_ADP = 180` is documented in `adp.py` as "12 teams x 15 rounds (the same league shape keepers.js encodes)".

- [ ] **Step 1: Write the failing test**

```python
# tests/test_board_rank.py -- append
def test_rank_board_maps_adp_rounds_at_the_leagues_team_count():
    import pandas as pd

    from ffmodel.site.board_rank import rank_board

    players = pd.DataFrame({
        "player_id": ["a", "b", "c"],
        "position": ["RB", "RB", "RB"],
        "ppr_p50": [300.0, 200.0, 100.0],
        "ecr": [1.0, 2.0, 3.0],
        # pick 11 is round 2 in a 10-team league and round 1 in a 12-team one:
        # the discriminating value, not an arbitrary one.
        "adp": [11.0, 24.0, 25.0],
    })
    ten = rank_board(players.copy(), {"RB": 3}, teams=10)
    twelve = rank_board(players.copy(), {"RB": 3}, teams=12)
    assert list(ten["adp_round"]) == [2, 3, 3]
    assert list(twelve["adp_round"]) == [1, 2, 3]


def test_rank_board_still_defaults_to_twelve_teams():
    # Every existing caller omits `teams`; the default must not move.
    import pandas as pd

    from ffmodel.site.board_rank import rank_board

    players = pd.DataFrame({
        "player_id": ["a"], "position": ["RB"], "ppr_p50": [300.0],
        "ecr": [1.0], "adp": [11.0],
    })
    assert list(rank_board(players, {"RB": 1})["adp_round"]) == [1]


def test_draftable_bound_scopes_the_crosswalk_guard_to_this_league():
    # The snapshot guard judges the crosswalk on players INSIDE the draft.
    # Scored over 180 for a 10-team, 14-round league, it would fail the board
    # on 40 picks that league never makes.
    from ffmodel.data import adp as adp_mod

    assert adp_mod.DRAFTABLE_ADP == 180          # the 12-team default is unmoved
    import inspect

    fn = adp_mod.load_snapshot_adp
    assert "draftable_adp" in inspect.signature(fn).parameters, (
        "the draftable bound is still hardcoded rather than a parameter")
```

Note for the implementer: `load_snapshot_adp` above is a placeholder for
whatever function in `adp.py` actually contains line 229. Open the file, use
the real name, and replace this signature assertion with a behavioural one if
the function can be called with a small synthetic frame — a signature check is
the weakest acceptable form and should be upgraded if the call is cheap.

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tests/test_board_rank.py -v -k adp_round`
Expected: FAIL — `rank_board() got an unexpected keyword argument 'teams'`

- [ ] **Step 3: Thread `teams` through `rank_board`**

In `src/ffmodel/site/board_rank.py`, change the signature at line 81 and the `adp_round` call at line 110:

```python
def rank_board(players: pd.DataFrame,
               replacement_rank: dict[str, int],
               value_col: str = "ppr_p50",
               teams: int = 12) -> pd.DataFrame:
```

```python
    # `teams` is REQUIRED here, not cosmetic: this call omitted it for a long
    # time and silently mapped every board's ADP to 12-team rounds. In a
    # 10-team league pick 11 is round 2, not round 1.
    board["adp_round"] = pd.Series([adp_round(a, teams) for a in board["adp"]],
                                    index=board.index, dtype=object)
```

- [ ] **Step 4: Make `DRAFTABLE_ADP` a parameter**

In `src/ffmodel/data/adp.py`, keep the module constant as the 12-team default and add a parameter to the function that uses it at line 229. Change the comment at line 113 to say it is a default rather than a fact:

```python
# Picks in a 12-team, 15-round draft -- the DEFAULT, and the shape this
# project's original league has. Callers with a different league pass their
# own `teams * rounds`; a 10-team, 14-round league drafts only 140, and
# scoring the guard over 180 would judge the crosswalk on 40 picks that
# league never makes.
DRAFTABLE_ADP = 180
```

Add `draftable_adp: int = DRAFTABLE_ADP` to the signature of the function containing line 229, and replace the use:

```python
    draftable = df[df["adp"] <= draftable_adp]
```

- [ ] **Step 5: Run the full Python suite**

Run: `python -m pytest tests/ -q`
Expected: PASS. The suite was 662 green before this task; it must still be green, because every existing caller relies on the unchanged defaults.

- [ ] **Step 6: Commit**

```bash
git add src/ffmodel/site/board_rank.py src/ffmodel/data/adp.py tests/test_board_rank.py
git commit -m "fix: ADP rounds and the draftable bound follow the league's size"
```

---

### Task 3: Generation takes --league and embeds the contract

**Files:**
- Modify: `src/ffmodel/site/weekly.py:20-23`
- Modify: `src/ffmodel/site/generate.py` — parser, `:140-141`, `:189`, `:243`, `:377`, `:520-556`
- Modify: `src/ffmodel/site/draft.py:309` and the payload dict at `:318-331`

**Interfaces:**
- Consumes: `ffmodel.league.load_league(slug) -> LeagueConfig` from Task 1; `rank_board(..., teams=)` from Task 2.
- Produces: `generate.py` accepts `--league <slug>` (default `gabagool`); `build_draft_board(...)` accepts `league: dict | None = None` and `teams: int = 12`, embedding `league` as a top-level payload key.

**Context an implementer needs:** `src/ffmodel/eval/draft_world.py:108` imports `LEAGUE_DEDICATED` and `LEAGUE_FLEX_SLOTS` from `generate.py` by name. **Do not delete those module-level constants** — leave them exactly as they are as Gabagool's defaults, and have the generation path read the config instead. Deleting them breaks that import.

`weekly.RULESETS` is a module-level dict consumed by `draft.py` at ten call sites. Rather than thread it through three function signatures under deadline, add one explicit named setter. It is process-global state, which is a smell; it is acceptable here because `generate.py` builds exactly one league per process, and the test in Step 1 pins the default.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_generate.py -- append
def test_set_league_rules_swaps_only_the_league_lens():
    from ffmodel.league import load_league
    from ffmodel.site import weekly

    before = weekly.RULESETS["league"]
    try:
        weekly.set_league_rules(load_league("fam").rules)
        assert weekly.RULESETS["league"].pass_td == 4.0
        assert weekly.RULESETS["league"].interception == -1.0
        # The other three lenses are league-independent and must not move.
        assert weekly.RULESETS["ppr"].pass_td == 4.0
        assert weekly.RULESETS["standard"].reception == 0.0
    finally:
        weekly.set_league_rules(before)
    assert weekly.RULESETS["league"].pass_td == 6.0


def test_generate_parser_defaults_to_gabagool():
    from ffmodel.site.generate import build_parser

    args = build_parser().parse_args(
        ["--out", "x", "--model", "xgboost", "--season", "2026", "--draft"])
    assert args.league == "gabagool"
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tests/test_generate.py -v -k "league"`
Expected: FAIL — `module 'ffmodel.site.weekly' has no attribute 'set_league_rules'`

- [ ] **Step 3: Add the setter to `weekly.py`**

```python
def set_league_rules(rules) -> None:
    """Point the "league" lens at THIS league's scoring.

    Process-global, called once by generate.py before a board is built. The
    key stays "league" for every league -- it is a published payload key that
    optimizer.js reads by name -- so what changes is what it means, never
    where it lives. See ffmodel.league.BOARD_RULESET.
    """
    RULESETS["league"] = rules
```

- [ ] **Step 4: Wire `--league` through `generate.py`**

In `build_parser`, beside the existing arguments:

```python
    parser.add_argument("--league", default="gabagool",
                        help="league slug in configs/leagues/ (default: gabagool)")
```

Leave `LEAGUE_DEDICATED` and `LEAGUE_FLEX_SLOTS` at lines 140-141 untouched — `eval/draft_world.py:108` imports them. Add above them:

```python
# NOTE: the two constants below are Gabagool's values and remain the defaults
# for ffmodel.eval.draft_world, which imports them by name. The generation
# path reads its shape from the league config instead -- see --league.
```

At line 377, take the shape from the config. The function containing it gains a `league` parameter; its caller passes `cfg`:

```python
    replacement = flex_replacement_ranks(pool, league.dedicated, league.flex_slots)
```

At line 243 in `_late_slots`, and at `_load_adp` (line 189), pass the team count instead of assuming 12. Both gain a `teams: int = 12` parameter, and the URL becomes:

```python
    url = ("https://fantasyfootballcalculator.com/api/v1/adp/ppr"
           f"?teams={teams}&year={season}&position=all")
```

In `main`, immediately after parsing:

```python
    from ffmodel.league import load_league
    from ffmodel.site.weekly import set_league_rules

    cfg = load_league(args.league)
    set_league_rules(cfg.rules)
    print(f"league: {cfg.name} -- {cfg.teams} teams, {cfg.starters} starters, "
          f"{cfg.total_picks} picks, pass_td {cfg.rules.pass_td}")
```

Then pass `league=cfg.payload()` and `teams=cfg.teams` into `build_draft_board`, and key the output by the config:

```python
        payloads[cfg.board_file] = _attach_late_slots(
            board_payload, args.season, args.data_dir)
```

- [ ] **Step 5: Embed the block in `draft.py`**

`build_draft_board` and `_finalize_board` each gain `league: dict | None = None` and `teams: int = 12`. In `_finalize_board`, pass `teams` to `rank_board` at line 309 and add the key to the payload dict:

```python
    board = rank_board(players, replacement_rank, f"{BOARD_RULESET}_p50",
                       teams=teams)
```

```python
    if league is not None:
        payload["league"] = league
```

Placing it behind `if league is not None` keeps every existing caller — the eval harness and the board backtests — producing exactly the payload they produce today.

- [ ] **Step 6: Run the full suite**

Run: `python -m pytest tests/ -q`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/ffmodel/site/ tests/test_generate.py
git commit -m "feat: generate takes --league and embeds the contract in the board"
```

---

### Task 4: THE GATE — prove Gabagool unchanged, then build FAM

**Files:**
- Create: `tools/board_diff.py`
- No source changes. This task only runs the pipeline and compares.

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: `site/data/draft-fam.json`, and the evidence that `site/data/draft.json` is unchanged.

**Context an implementer needs:** this is the task that protects a real draft on 2026-09-08. If Step 3 shows any difference outside `generated_at` and the new `league` key, STOP and report it rather than adjusting the comparison to pass.

- [ ] **Step 1: Write the comparison tool**

```python
# tools/board_diff.py
"""Compare two board payloads, ignoring only what is allowed to differ.

Usage: python tools/board_diff.py OLD.json NEW.json
Exit 0 if every pre-existing key matches; 1 with a report if not.
"""
import json
import sys

IGNORE = {"generated_at", "league"}   # volatile, and the new additive block


def main(old_path, new_path):
    old = json.load(open(old_path, encoding="utf-8"))
    new = json.load(open(new_path, encoding="utf-8"))
    problems = []
    for key in sorted(set(old) | set(new)):
        if key in IGNORE:
            continue
        if key not in new:
            problems.append(f"key dropped: {key}")
        elif key not in old:
            problems.append(f"key added: {key}")
        elif old[key] != new[key]:
            if key == "players":
                a, b = old[key], new[key]
                problems.append(f"players: {len(a)} vs {len(b)} rows")
                diff = [(x.get("name"), sorted(
                            k for k in set(x) | set(y) if x.get(k) != y.get(k)))
                        for x, y in zip(a, b) if x != y]
                problems.append(f"  {len(diff)} rows differ; first 5: {diff[:5]}")
            else:
                problems.append(f"{key}:\n  old {old[key]}\n  new {new[key]}")
    if problems:
        print("\n".join(problems))
        return 1
    print("identical on every pre-existing key")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
```

- [ ] **Step 2: Regenerate Gabagool to a scratch directory**

```bash
python -m ffmodel.site.generate --out /tmp/gab --model transformer \
  --season 2026 --draft --league gabagool \
  --artifact-root "models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44"
```

- [ ] **Step 3: Prove it unchanged — THE GATE**

Run: `python tools/board_diff.py site/data/draft.json /tmp/gab/draft.json`
Expected: `identical on every pre-existing key`, exit 0.

If it reports anything else, STOP. Do not proceed to Step 4, do not widen `IGNORE`. Report the difference — a moved VORP means the league config does not reproduce the shipped board, and shipping it would change the board a real draft depends on in three days.

- [ ] **Step 4: Build the FAM board**

```bash
python -m ffmodel.site.generate --out site/data --model transformer \
  --season 2026 --draft --league fam \
  --artifact-root "models/transformer/v1,models/transformer/v1_s43,models/transformer/v1_s44"
```

Confirm the run prints `league: FAM FOOTBALL -- 10 teams, 7 starters, 140 picks, pass_td 4.0` and writes `draft-fam.json`. Confirm `site/data/draft.json` is untouched: `git status --short site/data` should list only `draft-fam.json`.

- [ ] **Step 5: Assert FAM is genuinely a different board**

```bash
python - <<'PY'
import json
g = json.load(open("site/data/draft.json", encoding="utf-8"))
f = json.load(open("site/data/draft-fam.json", encoding="utf-8"))
gr, fr = g["methodology"]["replacement_rank"], f["methodology"]["replacement_rank"]
print("gabagool replacement:", gr)
print("fam replacement     :", fr)
# QB is the only position where the direction is guaranteed: it takes no flex,
# so its rank is teams + 1 by construction. 11 < 13.
assert fr["QB"] == 11, fr
assert fr != {"QB": 13, "RB": 25, "WR": 25, "TE": 13}, "fell back to the default"
qg = [p["name"] for p in g["players"] if p["position"] == "QB"][:12]
qf = [p["name"] for p in f["players"] if p["position"] == "QB"][:12]
# 4-point passing TDs reorder 4-8 of the top twelve QBs. Identical order means
# the scoring lens never took effect.
assert qg != qf, "QB order identical -- the FAM scoring lens did not apply"
print("top-12 QB order differs:", sum(a != b for a, b in zip(qg, qf)), "positions")
print("fam league block:", f["league"])
PY
```

Expected: FAM QB replacement 11, ranks not the fallback, QB order differs.

- [ ] **Step 6: Commit**

```bash
git add tools/board_diff.py site/data/draft-fam.json
git commit -m "feat: FAM FOOTBALL board, with Gabagool proven byte-identical"
```

---

### Task 5: optimizer.js reads its roster contract

**Files:**
- Modify: `site/assets/optimizer.js:66-70` (the league contract block), `:147` (`ROLLOUT_PICKS`), `:155` (`DEPTH_CAP`), and the export list at `:670-677`
- Test: `tests/optimizer_fixture.cjs`

**Interfaces:**
- Consumes: the `league` payload block from Task 3 — `{teams, roster: {QB,RB,WR,TE}, flex, flex_positions, starters, total_picks, depth_cap, keeper_rules?}`.
- Produces: `Optimizer.configure(league)`, and `Optimizer.leagueConfig()` returning the current values for assertions.

**Context an implementer needs:** `optimizer.js` is a UMD module loaded both by the browser and by Node fixtures, `tools/draft_sim.cjs` and `tools/replay_draft.cjs`. Today's values MUST remain the module defaults so every consumer that does not call `configure` is unchanged. `optimizer.js`'s `FLEX_SLOTS` is PER TEAM (2 for Gabagool) — it takes the payload's `flex`, not `LeagueConfig.flex_slots`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/optimizer_fixture.cjs -- append

/* --- league configuration -------------------------------------------------
   configure() exists so one optimizer serves more than one league. Two
   properties matter and are asserted separately: configuring with Gabagool's
   OWN values must be a no-op (this is what makes the change safe for the
   2026-09-08 draft), and configuring with a different shape must actually
   change the lineup arithmetic. */
{
  const GABAGOOL = {
    slug: "gabagool", teams: 12, roster: { QB: 1, RB: 2, WR: 2, TE: 1 },
    flex: 2, flex_positions: ["RB", "WR", "TE"], rounds: 15, starters: 8,
    total_picks: 180, depth_cap: { QB: 2, RB: 6, WR: 6, TE: 2 },
    keeper_rules: "gabagool",
  };
  const FAM = {
    slug: "fam", teams: 10, roster: { QB: 1, RB: 2, WR: 2, TE: 1 },
    flex: 1, flex_positions: ["RB", "WR", "TE"], rounds: 14, starters: 7,
    total_picks: 140, depth_cap: { QB: 2, RB: 5, WR: 5, TE: 2 },
  };
  const roster = (pos) => pos.map((p, i) => (
    { player_id: `x${i}`, position: p, value_points: 200 - i, vorp: 50 - i }));

  // A lineup with 2 RB + 2 WR + 1 QB + 1 TE fills both Gabagool flex slots
  // only if two more flex-eligible players are present.
  const held = roster(["QB", "RB", "RB", "WR", "WR", "TE"]);

  const beforeDefault = O.openSlots(held);
  assert.deepStrictEqual(beforeDefault, ["FLEX", "FLEX"],
    "default build no longer starts 2 FLEX -- the module defaults moved");

  O.configure(GABAGOOL);
  assert.deepStrictEqual(O.openSlots(held), beforeDefault,
    "configure() with Gabagool's own values changed behaviour -- it must be a no-op");
  assert.strictEqual(O.leagueConfig().ROLLOUT_PICKS, 8);

  O.configure(FAM);
  assert.deepStrictEqual(O.openSlots(held), ["FLEX"],
    "a 1-flex league still reported 2 open flex slots");
  assert.strictEqual(O.leagueConfig().ROLLOUT_PICKS, 7,
    "ROLLOUT_PICKS is documented as the starter count; FAM starts 7");
  assert.strictEqual(O.leagueConfig().DEPTH_CAP.RB, 5);

  O.configure(GABAGOOL);   // restore for any test that follows
  assert.deepStrictEqual(O.openSlots(held), beforeDefault);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/optimizer_fixture.cjs`
Expected: FAIL — `O.configure is not a function`

- [ ] **Step 3: Implement `configure`**

In `site/assets/optimizer.js`, change the league contract block from `const` to `let` and add the setter. Keep the existing values verbatim as defaults:

```javascript
  // --- league contract -------------------------------------------------------
  // DEFAULTS are Gabagool Fools', the league this board was built for, so any
  // consumer that never calls configure() -- trade.js, draft_sim.cjs,
  // replay_draft.cjs, the fixtures -- behaves exactly as it always has.
  let DEDICATED = { QB: 1, RB: 2, WR: 2, TE: 1 };
  let FLEX_SLOTS = 2;                 // PER TEAM (the payload's `flex`)
  let FLEX_POS = ["RB", "WR", "TE"];
```

`ROLLOUT_PICKS` at line 147 and `DEPTH_CAP` at line 155 become `let` with their current values, keeping their existing comments.

Then, near the other exported helpers:

```javascript
  /* Point the optimizer at a league. `league` is the block the board payload
     carries, so the roster shape can never disagree with the VORP the board
     was valued under -- they ship together.

     This mutates module state, which is a smell. It was chosen over threading
     a config through every signature in this file because that is a large
     diff on the code path a live draft depends on. Every consumer that does
     not call this keeps the Gabagool defaults above. */
  function configure(league) {
    if (!league || typeof league !== "object") {
      throw new TypeError("Optimizer.configure: expected the board's `league` block");
    }
    for (const key of ["roster", "flex", "flex_positions", "starters", "depth_cap"]) {
      if (league[key] == null) {
        throw new TypeError(`Optimizer.configure: league block is missing \`${key}\``);
      }
    }
    DEDICATED = Object.assign({}, league.roster);
    FLEX_SLOTS = league.flex;          // PER TEAM -- not the league-wide count
    FLEX_POS = league.flex_positions.slice();
    ROLLOUT_PICKS = league.starters;
    DEPTH_CAP = Object.assign({}, league.depth_cap);
  }

  // The current contract, for tests and for the panel to display.
  function leagueConfig() {
    return { DEDICATED: Object.assign({}, DEDICATED), FLEX_SLOTS, ROLLOUT_PICKS,
             FLEX_POS: FLEX_POS.slice(), DEPTH_CAP: Object.assign({}, DEPTH_CAP) };
  }
```

Add `configure, leagueConfig` to the returned object. **Leave the existing `DEDICATED, FLEX_SLOTS, FLEX_POS, ROLLOUT_PICKS, DEPTH_CAP` exports in place** — other modules read them, and removing them is a separate change.

Note: exported `const` bindings that are re-assigned inside the module will still show the OLD value to importers that captured them at load. Check whether `trade.js` or `draft_sim.cjs` reads `O.DEPTH_CAP`/`O.ROLLOUT_PICKS` and, if so, have them read `leagueConfig()` instead, or state in the report that they were verified not to.

- [ ] **Step 4: Run the fixture**

Run: `node tests/optimizer_fixture.cjs`
Expected: PASS.

- [ ] **Step 5: Run every fixture**

Run: `for f in tests/*.cjs; do node "$f" >/dev/null && echo "ok $f" || echo "FAIL $f"; done`
Expected: 11 ok. Any FAIL means a consumer depended on a binding that moved.

- [ ] **Step 6: Commit**

```bash
git add site/assets/optimizer.js tests/optimizer_fixture.cjs
git commit -m "feat: optimizer takes its roster contract from the board"
```

---

### Task 6: draftmode.js — league-scoped sessions and a mismatch guard

**Files:**
- Modify: `site/assets/draftmode.js:8` (`STORE_KEY`), `connect()` around `:120-140`
- Test: `tests/draftmode_fixture.cjs`

**Interfaces:**
- Consumes: `cfg.board.league` (the payload block), available because `init` already receives the whole board.
- Produces: no new exports; behaviour changes only.

**Context an implementer needs:** `STORE_KEY = "fc-draft-mode"` is one global localStorage key, written on connect (line 137) and auto-restored by `init` (line 766). With two leagues, connecting to FAM's draft leaves the Gabagool page auto-restoring the FAM draft on its next load — on 2026-09-08. The fixture already has a fake-DOM harness at the bottom of the file that drives the real click handlers; extend it rather than building a second one. `localStorage` is stubbed at the top of that file as a no-op; you will need a real in-memory Map for these tests.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/draftmode_fixture.cjs -- append

/* --- one browser, two leagues --------------------------------------------
   The stored session lived under a single global key with no league in it, so
   connecting to one league's draft left the OTHER league's page auto-restoring
   it on load -- a FAM draft resurrected on the Gabagool board on draft night.
   And a draft id pasted into the wrong board was accepted silently, optimizing
   a 10-team draft against 12-team VORP with nothing on screen to say so. */
{
  const store = new Map();
  global.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const GAB = { slug: "gabagool", name: "Gabagool Fools", teams: 12, rounds: 15,
                roster: { QB: 1, RB: 2, WR: 2, TE: 1 }, flex: 2,
                flex_positions: ["RB", "WR", "TE"], starters: 8,
                total_picks: 180, depth_cap: { QB: 2, RB: 6, WR: 6, TE: 2 },
                keeper_rules: "gabagool" };

  const el = () => ({
    value: "", textContent: "", innerHTML: "", hidden: false, checked: false,
    open: false, addEventListener() {}, querySelectorAll: () => [],
  });
  const els = {
    connect: el(), connectId: el(), disconnect: el(), find: el(), hide: el(),
    idInput: el(), late: el(), list: el(), live: el(), note: el(),
    picksCount: el(), roster: el(), shortlist: el(), status: el(),
    ticker: el(), username: el(),
  };
  const handlers = {};
  for (const [name, node] of Object.entries(els)) {
    node.addEventListener = (ev, fn) => { if (ev === "click") handlers[name] = fn; };
  }
  const board = {
    league: GAB,
    players: [
      { player_id: "a", sleeper_id: "9509", name: "P1", position: "RB", adp: 1,
        bye: 5, value_points: 300, vorp: 90, position_rank: 1 },
      { player_id: "b", sleeper_id: "4034", name: "P2", position: "WR", adp: 2,
        bye: 7, value_points: 290, vorp: 85, position_rank: 1 },
    ],
  };
  let last = null;
  D.init({ board, els, onUpdate: (st) => { last = st; } });

  // A session belonging to the OTHER league, already in storage.
  store.set("fc-draft-mode:fam", JSON.stringify({ draftId: "FAM1" }));

  SLEEPER.picks = [
    { pick_no: 1, draft_slot: 1, player_id: "9509", picked_by: "them" },
    { pick_no: 2, draft_slot: 2, player_id: "4034", picked_by: "them" },
  ];

  (async () => {
    // 1. A draft whose shape disagrees with the board is REFUSED.
    SLEEPER.draft = { draft_id: "D1", type: "snake", status: "in_progress",
                      settings: { rounds: 14, teams: 10 }, draft_order: {} };
    els.idInput.value = "D1234567";
    await handlers.connectId();
    await until(() => /10 teams/.test(els.status.textContent),
                "the mismatched draft to be refused by name");
    assert.strictEqual(last && last.connected, false,
      "a 10-team draft was accepted on a 12-team board");
    assert.ok(/Gabagool Fools/.test(els.status.textContent),
      "the refusal did not name the board's own league");

    // 2. A matching draft connects, and stores under a LEAGUE-SCOPED key.
    SLEEPER.draft = { draft_id: "D1", type: "snake", status: "in_progress",
                      settings: { rounds: 15, teams: 12 }, draft_order: {} };
    await handlers.connectId();
    await until(() => last && last.drafted.size === 2, "the matching draft to connect");
    assert.ok(store.has("fc-draft-mode:gabagool"),
      "the session was not stored under a league-scoped key");
    assert.ok(!store.has("fc-draft-mode"),
      "still writing the un-scoped global session key");

    // 3. The other league's stored session is untouched, and would not be
    //    restored onto this board.
    assert.strictEqual(JSON.parse(store.get("fc-draft-mode:fam")).draftId, "FAM1",
      "connecting on one board clobbered the other league's saved session");

    handlers.disconnect();
    assert.ok(!store.has("fc-draft-mode:gabagool"), "disconnect left the session stored");
    assert.ok(store.has("fc-draft-mode:fam"),
      "disconnecting one league removed the OTHER league's session");
    console.log("draftmode_fixture: OK");
  })().catch(e => { console.error(e.message); process.exit(1); });
}
```

Note for the implementer: `until` and the `SLEEPER` stub already exist in this
file (added with the reconnect regression test). Reuse them; do not define a
second copy. The `console.log("draftmode_fixture: OK")` line already at the end
of the previous block must be removed so the suite reports success once, after
the last async block.

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/draftmode_fixture.cjs`
Expected: FAIL on the un-scoped key assertion.

- [ ] **Step 3: Scope the session key and add the guard**

```javascript
  // Was the bare "fc-draft-mode". One key across every league meant connecting
  // to one league's draft left the OTHER league's page auto-restoring it on
  // load -- a FAM draft resurrected on the Gabagool board on draft night.
  const STORE_KEY_BASE = "fc-draft-mode";
  const storeKey = () => `${STORE_KEY_BASE}:${(cfg && cfg.board && cfg.board.league
                                                && cfg.board.league.slug) || "default"}`;
```

Replace every `STORE_KEY` use with `storeKey()`.

In `connect()`, after the draft object is fetched and before `session` is assigned:

```javascript
      // A draft whose SHAPE disagrees with the board is the wrong draft for
      // this page. Accepting it would optimize one league's picks against
      // another league's VORP and replacement level, and nothing on screen
      // would say so. Refuse instead.
      const lg = cfg.board && cfg.board.league;
      if (lg && s.teams && s.rounds
          && (s.teams !== lg.teams || s.rounds !== lg.rounds)) {
        setStatus(`that draft is ${s.teams} teams x ${s.rounds} rounds; `
                  + `this board is built for ${lg.name} `
                  + `(${lg.teams} x ${lg.rounds}) — open that league's board instead`);
        return;
      }
```

- [ ] **Step 4: Run the fixture and mutation-test the guard**

Run: `node tests/draftmode_fixture.cjs` — Expected: PASS.

Then break each of the two changes in turn and confirm the fixture goes RED:
1. revert `storeKey()` to the bare constant;
2. delete the mismatch `return`.

Report both results. A change that passes with the line removed is not covered.

- [ ] **Step 5: Commit**

```bash
git add site/assets/draftmode.js tests/draftmode_fixture.cjs
git commit -m "fix: draft sessions are per-league and a mismatched draft is refused"
```

---

### Task 7: index.html picks a league

**Files:**
- Modify: `site/index.html:116` (the fetch), `:515` (the pick bound), `:633` (`Keepers.init`)

**Interfaces:**
- Consumes: `Optimizer.configure(league)` from Task 5; the `league` payload block from Task 3.
- Produces: no exports.

- [ ] **Step 1: Route the fetch and configure the optimizer**

Replace line 116:

```javascript
  // ?league=<slug> selects the board. No parameter -- and "gabagool" -- keep
  // the existing filename, so every published link to this page is unchanged.
  const slug = new URLSearchParams(location.search).get("league") || "gabagool";
  const file = slug === "gabagool" ? "data/draft.json" : `data/draft-${slug}.json`;
  const board = await FC.loadJSON(file);
  // BEFORE any rendering or DraftMode.init: everything downstream reads the
  // roster shape, and a render that ran first would use the wrong one.
  if (board.league && window.Optimizer) Optimizer.configure(board.league);
```

- [ ] **Step 2: Bound the pick difference by this league's draft**

Replace the `draftLen` line at :515:

```javascript
      // The league's own draft length. Was Keepers.TEAMS * Keepers.DRAFT_ROUNDS,
      // hardcoded to Gabagool's 180: on a 10-team, 14-round board that invented
      // pick-difference language about 40 picks the league never makes.
      const draftLen = (board.league && board.league.total_picks)
        || (window.Keepers && Keepers.TEAMS * Keepers.DRAFT_ROUNDS) || 180;
```

- [ ] **Step 3: Gate `Keepers.init` on the ruleset**

Replace the block at :633:

```javascript
  // keepers.js implements GABAGOOL's ladder -- original round, decaying one
  // round per year kept, R12 for waiver pickups. Running it for a league with
  // different keeper rules would price keepers against a rule that league does
  // not have. Skipped entirely, not merely hidden, so none of its logic runs.
  const keeperPanel = document.getElementById("keepers");
  if (window.Keepers && board.league && board.league.keeper_rules === "gabagool") {
    Keepers.init({ players: board.players, panel: keeperPanel,
                   currentSeason: board.season });
  } else if (keeperPanel) {
    keeperPanel.hidden = true;
  }
```

- [ ] **Step 4: Verify both boards in a browser**

```bash
cd site && python -m http.server 8765 &
```

Load `http://localhost:8765/index.html` and `http://localhost:8765/index.html?league=fam`. For each, confirm in the console:

```javascript
Optimizer.leagueConfig()
```

Gabagool must report `FLEX_SLOTS: 2, ROLLOUT_PICKS: 8`; FAM `FLEX_SLOTS: 1, ROLLOUT_PICKS: 7`. Confirm the keeper panel is present on Gabagool and absent on FAM, and that the FAM board's header stamp names FAM.

- [ ] **Step 5: Commit**

```bash
git add site/index.html
git commit -m "feat: the board page serves either league"
```

---

### Task 8: End-to-end verification against the live FAM draft

**Files:** none — verification only.

- [ ] **Step 1: Connect the FAM board to a FAM mock draft**

Open a mock draft in FAM FOOTBALL on Sleeper. On `index.html?league=fam`, connect by draft id and confirm: picks strike, the roster line reports FAM's slots, and the shortlist appears.

- [ ] **Step 2: Prove the mismatch guard on the real thing**

On `index.html` (Gabagool), paste the FAM draft id. Expected: refused, with the status line naming both shapes. Then the reverse.

- [ ] **Step 3: Prove sessions do not cross**

Connect on the FAM board, then load the Gabagool board in the same browser. Expected: Gabagool does NOT auto-restore the FAM draft.

- [ ] **Step 4: Full suite**

```bash
python -m pytest tests/ -q
for f in tests/*.cjs; do node "$f" >/dev/null && echo "ok $f" || echo "FAIL $f"; done
python tools/board_diff.py site/data/draft.json /tmp/gab/draft.json
```

Expected: green, 11 ok, and the board diff still reporting identical.

- [ ] **Step 5: Commit any fixture updates and report**

```bash
git add -A && git commit -m "test: end-to-end verification of both league boards"
```
