# Multi-league draft boards — design

**Status:** approved 2026-09-05, revised the same day after a methodology
review found six missed league-dependent assumptions and two false claims in
the first draft. Extends `2026-07-09-fantasy-football-model-design.md`.

## Goal

Make the draft board's league contract data instead of constants, so one
codebase serves more than one Sleeper league — board, live overlay and pick
optimizer alike. Two leagues ship: **Gabagool Fools** (existing, must not
change) and **FAM FOOTBALL** (new, drafting the evening of 2026-09-06).

## Forcing constraints

- FAM FOOTBALL drafts the evening of **2026-09-06**, with the full live
  overlay and optimizer, not a static board.
- Gabagool Fools drafts **2026-09-08 21:00 EDT** and MUST NOT regress.
- Free tiers, static hosting, no backend.

The reviewer's judgement, recorded because it was overruled rather than
resolved: shipping the full live path for a second league inside 24 hours,
on the same files the 2026-09-08 draft depends on, is the risky option. The
project owner accepted that risk deliberately. The mitigations in Testing
exist because of it.

## What the two leagues actually are

Verified from `api.sleeper.app/v1/league/<id>` on 2026-09-05.

| | Gabagool Fools | FAM FOOTBALL |
|---|---|---|
| league_id | 1376245373244301312 | 1389736745205002240 |
| teams | 12 | 10 |
| roster (per team) | QB 1, RB 2, WR 2, TE 1 | QB 1, RB 2, WR 2, TE 1 |
| flex (per team) | 2 | 1 |
| starters | 8 | **7** |
| draft rounds | 15 | 14 |
| picks in draft | 180 | **140** |
| `pass_td` | 6.0 | **4.0** |
| `pass_int` | -2.0 | **-1.0** |
| `rec` | 1.0 | 1.0 |
| every other skill-position weight | — | identical |
| waivers | FAAB | rolling |
| max keepers | 2 | 1 |

Both roster K and DEF, which this project does not project (v1 scope guard).

FAM's scoring is exactly representable:
`ScoringRules(name="fam", reception=1.0, pass_td=4.0, interception=-1.0)`.
It carries none of the bonus categories the model cannot predict (50-yard TD
bonuses, pick-sixes); those exist only in Gabagool and `scoring.py` already
documents them as an accepted limitation.

## Rejected alternatives

**Fetch league settings live in the browser, keep one board.** `vorp`, `tier`
and `position_rank` are computed at generation time under one replacement
level and one scoring lens, and the browser cannot recompute them. A
live-fetched contract would let the optimizer target a roster shape the board
was not valued for. Rejected on correctness.

**Ship per-stat quantiles and rescore everything client-side.** Rejected on
size and deadline, NOT on correctness — the first draft of this spec claimed
it was mathematically unsound and that was wrong. The general statement (a
quantile of a weighted sum is not the weighted sum of quantiles) is true, but
it is not what this pipeline does. `scoring.py:111` `fantasy_points_band`
builds each weekly point band by scoring the p10/p90 **stat frames**
sign-coherently — a linear, ruleset-parameterized function of per-stat
quantiles — and only then does `simulate.py:61` `simulate_season` draw 2,000
season totals from those already-scored weekly bands, with a Gaussian copula
across weeks and a games-played distribution. Publishing per-stat quantiles
plus `games_probs` and `rho` would therefore reproduce today's construction
client-side. It is a sound design and the honest path to self-serve; it is
simply far larger than two static boards and cannot be built this week.

## Architecture

### 1. League config files

`configs/leagues/<slug>.yaml`, committed, hand-written from the verified API
values above.

```yaml
name: FAM FOOTBALL
league_id: "1389736745205002240"
teams: 10
roster: {QB: 1, RB: 2, WR: 2, TE: 1}   # PER TEAM
flex: 1                                 # PER TEAM
flex_positions: [RB, WR, TE]
rounds: 14
scoring: {reception: 1.0, pass_td: 4.0, interception: -1.0}
depth_cap: {QB: 2, RB: 5, WR: 5, TE: 2}
# keeper_rules omitted: FAM's keeper cost rule is not known to this project
```

`gabagool.yaml` must reproduce today's constants EXACTLY: `teams: 12`,
`roster: {QB: 1, RB: 2, WR: 2, TE: 1}`, `flex: 2`, `rounds: 15`,
`scoring: {reception: 1.0, pass_td: 6.0}`,
`depth_cap: {QB: 2, RB: 6, WR: 6, TE: 2}`, `keeper_rules: gabagool`.

**`depth_cap` is a judgement call, not a derivation.** Gabagool's values are
the shipped ones, copied verbatim. FAM's drop RB and WR by one because
`optimizer.js`'s own comment reasons from "RB and WR fill the two flex slots
as well" and FAM has one flex slot. This is unmeasured. It only breaks ties —
a player over the cap still wins outright whenever he improves the lineup —
so the blast radius is bounded, but it must not be described as derived.

`keeper_rules` names the house keeper ruleset `keepers.js` implements. The
browser runs the keeper panel only when it is exactly `gabagool`, so a league
with different keeper rules cannot silently borrow Gabagool's ladder.

Both leagues share the committed ADP and ECR snapshots: those are market-wide
inputs, not league settings.

### 2. Config loader

New pure module `src/ffmodel/league.py`:

- `load_league(slug) -> LeagueConfig`, reading `configs/leagues/<slug>.yaml`.
  An unknown slug raises; it must never fall back to a default.
- `LeagueConfig.dedicated` — per-team roster times `teams`, LEAGUE-WIDE
  (Gabagool `{QB:12, RB:24, WR:24, TE:12}`; FAM `{QB:10, RB:20, WR:20, TE:10}`).
- `LeagueConfig.flex_slots` — `flex` times `teams`, LEAGUE-WIDE (24 / 10).
- `LeagueConfig.starters` — `sum(roster.values()) + flex`, PER TEAM (8 / 7).
- `LeagueConfig.total_picks` — `teams * rounds` (180 / 140).
- `LeagueConfig.rules` — a `ScoringRules` from `scoring`.
- `LeagueConfig.payload()` — the dict embedded in the board (section 4).

Pure; no I/O beyond its own YAML.

### 3. Generation

`python -m ffmodel.site.generate --league <slug> ...`, defaulting to
`gabagool`.

Every item below is a place a 12-team assumption is currently hardcoded. All
must change; a FAM board that silently carries one is the failure this design
exists to prevent.

- `generate.py:140-141` `LEAGUE_DEDICATED` / `LEAGUE_FLEX_SLOTS` come from the
  config. **`src/ffmodel/eval/draft_world.py:108` imports both by name** —
  update that caller in the same task or its import breaks. Simplest: keep the
  module-level names as the Gabagool defaults and have the generation path use
  the config, so `draft_world` keeps working unchanged.
- `BOARD_RULESET` becomes the league's own ruleset. `RULESETS` still publishes
  ppr / half_ppr / standard for display alongside it.
- `board_rank.py:110` calls `adp_round(a)` with no `teams` argument and
  silently uses the 12-team default. Must take the league's team count.
- `generate.py:243` `_late_slots` fetches K/DST ADP with `teams=12` hardcoded.
- `generate.py:189` `_load_adp` and `adp.py:48` do not pass a team count, so
  the FFCalculator ADP fallback defaults to 12 teams.
- `adp.py:113` and `adp.py:229` define "inside the draft" as a hardcoded top
  180. Must be `teams * rounds`.
- Output filename from the config: `gabagool` keeps `draft.json`; any other
  slug writes `draft-<slug>.json`. `about.json` is league-independent and is
  written once, unchanged.

### 4. Payload contract

`draft.json` gains one additive top-level key. Gabagool's, complete:

```json
"league": {
  "slug": "gabagool", "name": "Gabagool Fools",
  "league_id": "1376245373244301312",
  "teams": 12, "roster": {"QB":1,"RB":2,"WR":2,"TE":1},
  "flex": 2, "flex_positions": ["RB","WR","TE"],
  "rounds": 15, "starters": 8, "total_picks": 180,
  "depth_cap": {"QB":2,"RB":6,"WR":6,"TE":2},
  "board_ruleset": "league", "keeper_rules": "gabagool"
}
```

FAM's block is the same shape with its own values and **no `keeper_rules`
key**.

The payload key is `flex`, PER TEAM. It is deliberately not named
`flex_slots`: that name belongs to `LeagueConfig.flex_slots`, the league-wide
count used only by the Python replacement calculation. Gabagool's two values
are 2 and 24, so confusing them is a 12x error.

No existing key changes shape or value.

### 5. Browser

**`optimizer.js`** gains `configure(league)`, setting `DEDICATED` from
`roster`, `FLEX_SLOTS` from `flex`, `FLEX_POS` from `flex_positions`,
`ROLLOUT_PICKS` from `starters`, and `DEPTH_CAP` from `depth_cap`. Today's
values stay as module defaults, so any consumer that does not call
`configure` — `trade.js`, `draft_sim.cjs`, `replay_draft.cjs`, the fixtures —
is unchanged.

`ROLLOUT_PICKS` is currently `8` and documented as "= starters"; FAM's 7 is
why it must be configured rather than left alone.

This mutates module state, which is a smell, chosen over threading a config
through every optimizer signature — a large diff on the file the 2026-09-08
draft depends on. The cleaner refactor is a post-draft job.

**`draftmode.js`** — the first draft of this spec claimed it needed no change.
That was false:

- `STORE_KEY` (draftmode.js:8) is the single global key `"fc-draft-mode"`,
  written on connect and auto-restored by `init`. With two leagues, connecting
  to FAM's draft leaves Tuesday's Gabagool page auto-restoring the FAM draft
  on load. The key must carry the league slug.
- Connecting must REFUSE a draft whose `settings.teams` or `settings.rounds`
  disagree with the loaded board's league, and say so in the status line. This
  single guard kills the whole cross-league error class, including opening
  Gabagool's board and pasting a FAM draft id. It is the main protection the
  byte-identity test cannot give.

**`index.html`** —

- reads `?league=<slug>`, fetching `data/draft.json` (absent, or `gabagool`)
  or `data/draft-<slug>.json`;
- calls `Optimizer.configure(board.league)` BEFORE any rendering or any
  `DraftMode.init`;
- `index.html:503` bounds "inside the drafted range" with
  `Keepers.TEAMS * Keepers.DRAFT_ROUNDS` = 180. Must use the league's
  `total_picks`, or FAM players at picks 141-180 get pick-difference language
  about picks that do not exist;
- `index.html:633` calls `Keepers.init` unconditionally. It must be skipped
  entirely — not merely visually hidden — unless `keeper_rules === "gabagool"`,
  so Gabagool-only keeper logic never runs against a FAM-configured optimizer.

## Testing

A byte-identical `draft.json` proves the data and nothing about behaviour. It
cannot detect `configure` firing at the wrong time, a wrongly hidden keeper
panel, leaked global optimizer state, query routing loading the wrong
artifact, or a crossed session. The guarantee therefore has three layers.

**Layer 1 — payload.** Regenerate Gabagool; every pre-existing key must be
identical to the committed `site/data/draft.json`, ignoring only
`generated_at` and the new `league` block. One moved VORP means stop.

**Layer 2 — optimizer behaviour.** Run the full existing optimizer fixture a
second time after an explicit `configure(gabagoolPayload)` and require
identical OUTPUTS, not merely identical exported constants. This is what
proves `configure` with Gabagool's own values is a no-op. Add a FAM case where
`configure` with `flex: 1` changes `openSlots`, and assert the default path
(no `configure` call) is unchanged.

**Layer 3 — browser paths.** In `tests/draftmode_fixture.cjs`, using the
fake-DOM harness already there: the stored session key is league-scoped and a
FAM session does not restore onto a Gabagool board; connecting to a draft
whose teams/rounds disagree with the board is refused with a status message
rather than silently accepted.

Plus: `tests/test_league.py` for the loader (per-team to league-wide
multiplication, `ScoringRules` construction, both YAMLs parsing to expected
values, unknown slug raising); `adp_round` exercised at 10 and 12 teams; and
the ADP "inside the draft" bound exercised at 140 and 180.

**FAM board assertions.** Its replacement ranks must be DERIVED rather than
the `REPLACEMENT_RANK` fallback, and QB must be strictly shallower than
Gabagool's — 11 against 13. QB is the only position where the direction is
guaranteed, because it takes no flex and is `teams + 1` by construction; RB,
WR and TE depend on how `flex_replacement_ranks` splits flex by ECR, and this
spec has not computed that.

The scoring lens is proven by VALUE, not by order: FAM's
`season_points.league` must be strictly lower than Gabagool's for every top-24
QB, while the league-independent `ppr` lens is identical in both, and every
top-24 QB's VORP moves.

The within-position ORDER must NOT change. This board is consensus-anchored --
`methodology.ranking` reads "expert-consensus (FantasyPros ECR); the model
supplies the value curve and the floor/ceiling bands, not the order" -- and
ECR is league-independent. An earlier draft of this spec asserted that FAM's
QB order must differ, which is backwards and would have failed a correct
implementation. Verified against the built boards on 2026-09-06.

## Non-goals

- FAM's keeper panel; its cost rule is unknown, so the panel is skipped.
- A Sleeper-to-YAML fetch helper. Both YAMLs are hand-written this round.
- The trade calculator, which reads `keepers.js` constants and stays
  Gabagool-only.
- The "third league by YAML alone" promise. Two contracts are proven by
  tests this round; a third league is plausible but unverified.
- Self-serve generation for arbitrary users — see Rejected alternatives.
