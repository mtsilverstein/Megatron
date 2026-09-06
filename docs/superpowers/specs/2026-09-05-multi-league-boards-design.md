# Multi-league draft boards — design

**Status:** approved 2026-09-05. Extends the board pipeline described in
`2026-07-09-fantasy-football-model-design.md`; supersedes nothing.

## Goal

Make the draft board's league contract data instead of constants, so one
codebase serves more than one Sleeper league. Two leagues ship: **Gabagool
Fools** (the existing board, which must not change) and **FAM FOOTBALL**
(new, drafting the evening of 2026-09-06).

Adding a third league must be adding a YAML file, not editing code.

## Forcing constraints

- FAM FOOTBALL drafts the evening of **2026-09-06**.
- Gabagool Fools drafts **2026-09-08 21:00 EDT** and MUST NOT regress. Its
  board, its optimizer behaviour and its page are the ones already validated.
- Everything stays on free tiers and static hosting. No backend.

## What the two leagues actually are

Verified from `api.sleeper.app/v1/league/<id>` on 2026-09-05.

| | Gabagool Fools | FAM FOOTBALL |
|---|---|---|
| league_id | 1376245373244301312 | 1389736745205002240 |
| teams | 12 | 10 |
| roster (per team) | QB 1, RB 2, WR 2, TE 1 | QB 1, RB 2, WR 2, TE 1 |
| flex (per team) | 2 | 1 |
| draft rounds | 15 | 14 |
| `pass_td` | 6.0 | **4.0** |
| `pass_int` | -2.0 | **-1.0** |
| `rec` | 1.0 | 1.0 |
| every other skill-position weight | — | identical |
| waivers | FAAB (`waiver_type: 2`) | rolling (`waiver_type: 0`) |
| max keepers | 2 | 1 |

Both leagues roster K and DEF, which this project does not project (v1 scope
guard). That is unchanged, and the existing late-slot warning already covers
it.

FAM's scoring is exactly representable:
`ScoringRules(name="fam", reception=1.0, pass_td=4.0, interception=-1.0)`.
It carries none of the bonus categories the model cannot predict (50-yard TD
bonuses, pick-sixes) — those exist only in Gabagool, and `scoring.py` already
documents them as an accepted limitation.

## Rejected alternatives

**Fetch league settings live in the browser.** `vorp`, `tier` and
`position_rank` are computed at generation time under one replacement level
and one scoring lens. The browser cannot recompute them without the
underlying Monte Carlo draws, so a live-fetched contract would let the
optimizer target a roster shape the board was not valued for — a silent
inconsistency, which is the failure class this project keeps being bitten by.

**Ship per-stat quantiles and rescore client-side.** This is what true
self-serve would require, and it is unsound for the bands: p10 of fantasy
points is not the sum of p10 stat components. The bands come from 2,000
correlated draws per player; summing component quantiles assumes every stat
lands at its 10th percentile simultaneously. It would quietly destroy the
calibrated floor and ceiling that are the product's core feature.

## Architecture

### 1. League config files

`configs/leagues/<slug>.yaml`, committed. Hand-written this round from the
verified API values above; a Sleeper-to-YAML fetch helper is out of scope
(see Non-goals).

```yaml
name: FAM FOOTBALL
league_id: "1389736745205002240"
teams: 10
roster: {QB: 1, RB: 2, WR: 2, TE: 1}   # PER TEAM
flex: 1                                 # PER TEAM
flex_positions: [RB, WR, TE]
rounds: 14
scoring: {reception: 1.0, pass_td: 4.0, interception: -1.0}
# keeper_rules: omitted -- FAM's keeper panel is out of scope this round
```

`keeper_rules` is an optional string naming the house keeper ruleset that
`keepers.js` implements. `gabagool.yaml` sets `keeper_rules: gabagool`;
`fam.yaml` omits the key entirely. The browser shows the keeper panel only
when the value is exactly `gabagool`, so a league that has keepers but not
Gabagool's ladder cannot silently borrow the wrong cost rule.

`scoring` holds only the deltas from `ScoringRules`' defaults; the dataclass
supplies the rest. `roster` and `flex` are PER TEAM — the natural way to read
a league — and are multiplied by `teams` wherever league-wide counts are
needed.

`gabagool.yaml` must reproduce today's constants exactly: `teams: 12`,
`roster: {QB: 1, RB: 2, WR: 2, TE: 1}`, `flex: 2`, `rounds: 15`,
`scoring: {reception: 1.0, pass_td: 6.0}`, `keeper_rules: gabagool`.

Both leagues share the committed ADP and ECR snapshots: those are market-wide
inputs, not league settings, and no league-specific market data is needed.

### 2. Config loader

New pure module `src/ffmodel/league.py`:

- `load_league(slug) -> LeagueConfig` reads `configs/leagues/<slug>.yaml`.
- `LeagueConfig.dedicated` — per-team roster times `teams`
  (Gabagool `{QB:12, RB:24, WR:24, TE:12}`; FAM `{QB:10, RB:20, WR:20, TE:10}`).
- `LeagueConfig.flex_slots` — `flex` times `teams`, the LEAGUE-WIDE count
  `flex_replacement_ranks` expects (Gabagool 24, FAM 10). Distinct from the
  payload's per-team `flex`; see section 4.
- `LeagueConfig.rules` — a `ScoringRules` built from `scoring`.
- `LeagueConfig.payload()` — the dict embedded in the board (see section 4).

Pure and separately tested. No I/O beyond reading its own YAML.

### 3. Generation

`python -m ffmodel.site.generate --league <slug> ...`, defaulting to
`gabagool`.

- `LEAGUE_DEDICATED` and `LEAGUE_FLEX_SLOTS` (generate.py:140-141) are
  replaced by the loaded config. `flex_replacement_ranks` is already
  parameterized and is called unchanged.
- `BOARD_RULESET` becomes the league's own ruleset. `RULESETS` continues to
  publish ppr / half_ppr / standard for display, plus the league's own lens.
- **`board_rank.py:110` calls `adp_round(a)` with no `teams` argument**, so it
  silently uses the 12-team default. It must take the league's team count, or
  FAM's ADP rounds read as a 12-team draft.
- The output filename comes from the config: `gabagool` keeps the current
  `draft.json`; any other slug writes `draft-<slug>.json`. `about.json` is
  league-independent and is written once, unchanged.

### 4. Payload contract

`draft.json` gains one additive top-level key:

```json
"league": {
  "slug": "gabagool", "name": "Gabagool Fools",
  "league_id": "1376245373244301312",
  "teams": 12, "roster": {"QB":1,"RB":2,"WR":2,"TE":1},
  "flex": 2, "flex_positions": ["RB","WR","TE"],
  "rounds": 15, "board_ruleset": "league"
}
```

The payload key is `flex`, PER TEAM, matching the YAML and what the browser's
lineup builder wants. It is deliberately NOT named `flex_slots`: that name
belongs to `LeagueConfig.flex_slots`, which is the league-wide count
(`flex` times `teams`) used only by the Python replacement calculation. An
implementer must not pass one where the other is expected — Gabagool's two
values are 2 and 24.

No existing key changes shape or value.

### 5. Browser

`optimizer.js` gains `configure(league)`, which overwrites the module's
`DEDICATED`, `FLEX_SLOTS` and `FLEX_POS` from the payload's `roster`, `flex`
and `flex_positions`. Note `optimizer.js`'s `FLEX_SLOTS` is per team, so it
takes the payload's `flex` directly. Today's values remain the defaults,
so every consumer that does not call `configure` — `trade.js`,
`draft_sim.cjs`, `replay_draft.cjs` and all 11 fixtures — behaves exactly as
it does now.

This mutates module state, which is a smell. It is chosen deliberately over
threading a config through every optimizer signature, because that is a large
diff on the file the 2026-09-08 draft depends on. The cleaner refactor is a
post-draft job.

`index.html`:

- reads `?league=<slug>` and fetches `data/draft.json` (no parameter, or
  `gabagool`) or `data/draft-<slug>.json`;
- calls `Optimizer.configure(board.league)` before any board rendering;
- hides the keeper panel (`#keepers`, index.html:73) unless the loaded
  league's `keeper_rules` is exactly `gabagool`.

`draftmode.js` needs no change: it already reads teams, rounds, snake type and
reversal round from the Sleeper draft object, and its roster display goes
through `Optimizer.openSlots`, which `configure` fixes.

## Testing

**The Tuesday guarantee.** Regenerate Gabagool and compare against the
committed `site/data/draft.json`: every pre-existing key must be identical,
ignoring only `generated_at` and the new `league` block. A single moved VORP
means the change is wrong. This gates the whole branch.

Also:

- `tests/test_league.py` — the loader: per-team to league-wide
  multiplication, `ScoringRules` construction, both committed YAMLs parsing to
  the expected values, and an unknown slug raising rather than silently
  falling back to a default.
- FAM generation asserts its replacement ranks are DERIVED rather than the
  `REPLACEMENT_RANK` fallback, and that QB is strictly shallower than
  Gabagool's (11 against 13). QB is the only position where this is
  guaranteed: it takes no flex, so its rank is `teams + 1` by construction.
  RB, WR and TE depend on how `flex_replacement_ranks` splits the flex slots
  by ECR, and asserting a direction there would be asserting an outcome this
  spec has not computed.
- FAM's QB ordering must differ from Gabagool's. Four-point passing TDs
  reorder 4 to 8 of the top twelve QBs; if the order comes out identical, the
  scoring lens did not take effect. This is the assertion that catches a
  config which loads but is then ignored.
- `tests/optimizer_fixture.cjs` — `configure` with `flex_slots: 1` changes
  `openSlots` output, and the default (no `configure` call) is unchanged.
- `adp_round` is exercised at both team counts.

## Non-goals

- FAM's keeper panel. FAM allows 1 keeper against Gabagool's 2 and its cost
  rule is not known, so the panel is hidden rather than guessed at.
- A Sleeper-to-YAML fetch helper. Both YAMLs are hand-written this round from
  verified API output.
- The trade calculator, which reads `keepers.js` constants and stays
  Gabagool-only.
- Self-serve board generation for arbitrary users. See Rejected alternatives
  for why that needs a different architecture rather than more config.
