# Keeper rule settings — design

Date: 2026-11-16. Status: approved by the owner 2026-11-16 (amended the same day after astra's review and the Task 5 privacy ruling).

## 1. Why

Every keeper feature on the site assumes one league's rule (Gabagool's): a keeper costs one round earlier per
year kept, at most two years in a row, a player nobody drafted costs round 12, and nobody can be kept in round 2 or
earlier. The owner (2026-11-16): "Some leagues it might be one spot per year in decay, some there might not be a
max length for keeping etc." Sleeper does not publish a league's keeper cost rule (its league settings carry only
`type` and `max_keepers`), so the rule has to be stated on the site. This change turns the hard-coded rule into a
small set of settings that any keeper league can fill in. It is also the foundation for the planned keeper-value
milestone, which will price players by what they cost to keep.

## 2. Scope (owner chose option B, 2026-11-16)

In scope:

1. **In-season trade page** (`trade.html` in season, `site/assets/seasontrademode.js`), which already serves any
   Sleeper keeper league: its "Keeper rule" menu offers presets plus **Custom**, which shows the five settings
   (§3). The choice is remembered per league on this device.
2. **Published boards**: a league config's `keeper_rules` becomes the five settings (plus the number of keepers per
   team). The draft page's keeper tool (`site/assets/keepers.js` panel on `index.html`) and the pre-draft trade page
   (`site/assets/trademode.js`, `site/assets/trade.js`) read the rule from the board instead of constants. Today only
   Gabagool's board has a rule. The pre-draft trade page keeps serving only the main board (`data/draft.json`), as
   today; reaching a second published keeper board from it is out of scope (astra review 2026-11-16).
3. The draft-pick values (`site/assets/pickvalue.js`) follow the chosen rule (§5.2).

Non-goals:

- A draft-page keeper tool for any connected league (option C: it needs a draft board scored for each league).
- Auction/salary keepers, dynasty leagues (both already excluded from pick values), multi-season keeper-value
  projections (the next milestone).
- Inferring a league's rule from Sleeper's draft history.
- Generalising the pre-draft grader's league shape (`Keepers.TEAMS` 12, `Keepers.DRAFT_ROUNDS` 15): unchanged.
- FAM: **not a keeper league** (owner, 2026-11-16; Sleeper reports `type: 0`). The comments in
  `configs/leagues/fam.yaml` and `configs/formats/f10-1qb-ppr-6.yaml` that say "FAM allows 1 keeper" are wrong and
  are corrected; FAM keeps no `keeper_rules`.

Anti-goals (a failure even if it works):

- **Any change to Gabagool's numbers or words under its rule**: every keeper cost, eligibility, ineligibility reason,
  likely keeper, keeper/pick conflict line, pick value and pre-draft trade note must stay identical. One deliberate
  exception: the draft-page keeper help text, now generated from the rule, gains the sentence "A player can be kept
  at most 2 years in a row." (today's text never states the cap; owner shown 2026-11-16). Every existing fixture keeps its
  expected values. Call sites in fixtures may change only to pass Gabagool's rule explicitly (the rule becomes a
  required argument, §5.1), and assertions that name a replaced constant expect the same value from the rule.
- A rule that applies itself silently: the in-season page still starts at **Unknown** for a league with no saved
  choice.
- A real league's name in a preset label, code identifier or fixture added by this work.

## 3. The rule: five settings

| Setting (JSON key) | Meaning | Gabagool |
|---|---|---|
| `first_keep` | Rounds earlier than the drafted round for a player's first keep (0 = the drafted round). | 1 |
| `per_year` | Rounds earlier for each later year he is kept. | 1 |
| `max_years` | Most years in a row one player can be kept; `null` = no limit. | 2 |
| `undrafted_round` | What a player nobody drafted in the league costs the first time he is kept: a round number, or `"last"` = the league's last draft round. | 12 |
| `earliest_round` | The earliest round a keeper may cost; a player whose cost would be earlier goes back to the draft pool. 1 = no restriction. | 3 |

Keepers per team is not a rule setting on the in-season page: it comes from Sleeper's `settings.max_keepers`, as
today. A published board states it as `max_keepers` inside `keeper_rules` (Gabagool: 2), replacing
`Keepers.MAX_KEEPERS` for that board.

`undrafted_round` is itself the first-keep cost of a never-drafted player: `first_keep` is not subtracted from it
(Gabagool: R12 the first year, as today).

`"last"` resolves against the league's draft round count. In season: the round count the trade page already reads
from Sleeper's draft. Without it the draft-pick block is unavailable today (`seasontrademode.js` "the number of draft
rounds is unknown"), and so is every keeper feature that hangs off it. On a published board: the config's `rounds`.
A rule whose `"last"` cannot be resolved is invalid.

All values are integers (except `max_years: null` and `undrafted_round: "last"`). Valid ranges:
`first_keep` and `per_year` 0–5; `max_years` 1–8 or null; `undrafted_round` 1–30 or "last"; `earliest_round`
1–30; `max_keepers` 1–3. When the league's draft round count is known, `undrafted_round` (resolved) and
`earliest_round` must not exceed it: a keeper can never cost a pick the draft does not have. Presets are fixed and are normalised with the round count only to resolve "last" (no rounds-bound check), so the ladder preset keeps working on drafts shorter than 12 rounds exactly as before; the bound applies to Custom settings and to published-board configs (ruling 2026-11-16, Tasks 3-4). Why the two tight
ranges (astra review 2026-11-16): the draft-history walk reads at most 8 seasons (`CHAIN_CAP`), so a cap above 8
could never be enforced; and the pre-draft grader enumerates every keeper set up to `max_keepers` (`trade.js`
`indexSubsets`), which grows combinatorially, so boards stay at 3 or fewer until that search is reworked. A rule outside these ranges is invalid: a config fails to load (Python raises), and a
stored in-season choice falls back to Unknown.

## 4. Cost and eligibility math

Owner rules (2026-11-16): cost moves earlier only for years a player is actually **kept**; a drop, or a season
nobody drafted him, changes nothing. The cap counts **consecutive** years kept (the current run). These are already
implemented for Gabagool's rule in `keepers.js` (commit 28d23e7); the settings generalise them without changing them.

A Sleeper history entry is `{round, season, keptYears, lastDraft}` from `buildOriginalByPlayerId` (unchanged). Its
anchor (`round`, `season`) is the player's most recent pick, keeper or not; a kept player appears in Sleeper's picks
with `is_keeper: true` at the round he cost (verified 2026-11-14), so **the anchor is a keeper pick exactly when
`keptYears ≥ 1`**. With `n = currentSeason − lastDraft` (normally 1):

- Anchor is a fresh (non-keeper) pick: `cost = round − first_keep − per_year × (n − 1)`.
- Anchor is a keeper pick: `cost = round − per_year × n`.
- Whether or not he was picked in the newest draft does not matter to cost (rule B); it matters only to the cap
  (`yearsKept`, unchanged: a run not continued in the newest draft restarts).

A player with no pick in the history (never drafted here): first keep costs `undrafted_round` (resolved: "last" =
the draft's round count), later years `per_year` earlier each, counted from `firstKeptYear` as today:
`cost = undrafted − per_year × (currentSeason − firstKeptYear)`.

A manual entry (draft-page panel; no `lastDraft`) is assumed kept every season since `originalYear`, as today: with
`n = currentSeason − originalYear`, `cost = originalRound − first_keep − per_year × (n − 1)`. The same formula
applies for every `n`; `n ≤ 0` arises only from a typed year that is not before the current season (a blank year
means last season, `n = 1`), and under Gabagool's rule it still equals today's `originalRound − n`.

Under Gabagool's rule (1, 1, 2, 12, 3) each formula reduces to today's `round − n` / `12 − years` / `round − n`
exactly; this is the regression proof.

Eligible iff `cost ≥ max(earliest_round, 1)` and (`max_years` is null or `yearsKept ≤ max_years`). Ineligible
reasons keep today's wording with the numbers taken from the rule: the cap reason
("already kept the most allowed (N years)…") wins when over the cap; else "cost would be R{cost}" when cost ≥ 1;
else "his keeper ladder has run out". With `per_year = 0` and `first_keep = 0` costs never fall, which is
intended.

## 5. Where the rule is used

### 5.1 `keepers.js`

`keeperCost`, `yearsKept`, `eligible`, `surplus`, `rankKeepers`, `recommendKeepers`, `unvaluedKeepers` take the rule
as an explicit argument (`buildKeeperCandidates` computes no cost and is unchanged). A missing or invalid rule throws:
no caller gets Gabagool's numbers by default. `Keepers.init` receives the board's rule and uses its `max_keepers` in
place of `MAX_KEEPERS`. In `trade.js`/`trademode.js` the rule travels in the existing `ctx` (as `ctx.keeperRule`,
checked at the door with the other ctx fields), and `ctx.maxKeepers` comes from the rule's `max_keepers`. The draft
page's depletion label ("assume 12 teams keep 2 each") takes the board's `max_keepers`. The team count stays 12 (§2),
and so does the existing team-count warning. One shared
validator/normaliser (`Keepers.normalizeRule(raw, {rounds})` or equivalent: resolves "last", checks §3 ranges)
is used by every caller. `WAIVER_COST_ROUND`, `MAX_YEARS_KEPT` and the "cost ≥ 3" test leave the math; Gabagool's
values live in the preset table (§6) and its config.

The draft-page panel's help text (`index.html` `.keeper-help`, today fixed copy describing Gabagool's rule) is
generated from the board's rule in plain words. The manual form's "never drafted in this league (R12)" label shows
the rule's undrafted round.

### 5.2 Pick values (`pickvalue.js`)

Today `buildCurve({..., keeperRule})` accepts "unknown" or "ladder"; under "ladder" the `keepers × teams` keeper
picks are spread evenly over rounds 3–12 (3..rounds in a shorter draft), and rounds 1–2 stay fully live. General
form: spread them over rounds `earliest_round` .. `min(resolved undrafted_round, rounds)`; if that span is empty,
every pick is live (as under Unknown). Gabagool's rule gives exactly today's curve. For rules with
`earliest_round = 1` the span covers round 1 too. Under every rule here a keeper uses up one of his team's picks, and
the even spread is the same estimate the ladder already makes: keepers in leagues like `same_round` may cluster in
early rounds, and that is not modelled. `buildCurve` takes the rule
object (or null for Unknown); curves are cached by the rule's settings rather than precomputed per named rule.

The summary note "Under this keeper rule the best players often can't be kept, so early picks are likely worth more
than shown" is shown when the rule's `earliest_round > 1`, which is exactly today's case for Gabagool.

### 5.3 In-season trade page (`seasontrademode.js`)

- Menu entries, in order: Unknown (default); the presets of §6; **Custom…**. Labels describe the rule in plain
  words. The existing key `"ladder"` and its label stay, so saved choices still load.
- Custom shows five compact inputs (§3 settings, plain-word labels), prefilled from the preset or custom rule that
  was showing. Invalid input shows an inline message and leaves the previous rule in force; nothing is recomputed
  from an invalid rule.
- The choice is saved in the existing per-league preference (`PREF_KEY`) as `keeperRule` (preset key or `"custom"`)
  plus `keeperCustom` (the five settings) when custom. Unreadable or invalid stored values fall back to Unknown.
  Presets are fixed and are normalised with the round count only to resolve "last" (no rounds-bound check), so the ladder preset keeps working on drafts shorter than 12 rounds exactly as before; the bound applies to Custom settings and to published-board configs (ruling 2026-11-16, Tasks 3-4).
- Everything that today runs only under `"ladder"` (the draft-history walk, `ladderKeepers`, likely-keeper
  filtering, the keeper/pick conflict lines) runs under any rule other than Unknown, with that rule's math.

### 5.4 Published boards

- `configs/leagues/gabagool.yaml`: `keeper_rules: gabagool` becomes a mapping of the five settings plus
  `max_keepers: 2`.
- `src/ffmodel/league.py`: `LeagueConfig.keeper_rules` becomes an optional mapping, validated on load against §3
  (unknown keys, wrong types or out-of-range values raise). `payload()` emits it unchanged, so the board's
  `league.keeper_rules` is that object.
- `site/assets/app.js` `boardEntry`: keeper tools are on when `KeeperRules.fromBoard` returns a rule (the shared
  validator; `keeperrules.js` loads before `app.js` on every page). Boards built before this change carry a string in
  `keeper_rules`; then the ladder was the only rule, so any non-empty string is read as the `ladder` preset with
  `max_keepers: 2`, and the site's code never names a league to recognise it (the site privacy test forbids league
  names in site code; ruling 2026-11-16 after Task 5). An empty string or an invalid object turns the tools off.
- `trademode.js` / `trade.js` (pre-draft) use the board's rule and its `max_keepers`; their copy
  (e.g. `keeperNote`'s "already kept the most allowed (2 years)", the page's `#trade-note` "one of your two slots" /
  "round 2 or lower", and the no-history "so nobody is ineligible") takes numbers from the rule, and stays true for
  rules where a never-drafted player can never be kept (`undrafted_round < earliest_round`).

## 6. Presets (builder's labels may differ in wording, not in values)

| Key | Label (plain words) | first_keep | per_year | max_years | undrafted_round | earliest_round |
|---|---|---|---|---|---|---|
| `ladder` | Round drafted − 1 per year kept (waiver pickups: round 12; max 2 years) — existing label | 1 | 1 | 2 | 12 | 3 |
| `same_round` | Kept at the round drafted, every year (no limit) | 0 | 0 | null | "last" | 1 |
| `one_earlier` | One round earlier each year kept, starting with the first (no limit) | 1 | 1 | null | "last" | 1 |
| `after_first` | The round drafted the first year, one round earlier each year after (no limit) | 0 | 1 | null | "last" | 1 |

## 7. Tests

- **Gabagool regression**: the existing keepers, trade, trademode, seasontrademode and pickvalue fixtures pass with
  Gabagool's rule passed explicitly; outputs identical.
- **Math table** (keepers fixture): each preset and a custom rule, across fresh-pick anchors, keeper-pick anchors,
  anchors older than the newest draft, never-drafted players and manual entries, including `max_years: null`,
  `earliest_round: 1`, `undrafted_round: "last"`, `n > 1`.
- **Validation**: missing rule throws; each out-of-range or wrong-type setting rejected (JS and Python).
- **Pick values**: a non-ladder rule's curve spreads keepers over its own round span; an empty span equals Unknown.
- **In-season page**: Custom round-trips through storage; an invalid stored rule loads as Unknown; invalid input
  keeps the previous rule; the conflict line and likely keepers follow a custom rule.
- **Config**: Gabagool's YAML loads to the mapping; its payload carries it; FAM has none; a legacy string board
  still enables the keeper tool with Gabagool's values.

## 8. Decisions

Owner (2026-11-16): option B; costs decay only for years kept, drops irrelevant (rule B); the cap counts
consecutive years; FAM is not a keeper league.

My calls (open to correction): the five settings, including `first_keep` as its own setting (not applied to a
never-drafted player's `undrafted_round`); the `"last"` round option and its sources; the preset list in §6; Unknown
stays the default; a legacy string `keeper_rules` (any non-empty string) reads as the ladder preset, without naming a league; keepers per team from Sleeper (in season) and config (boards) rather than a sixth in-season setting;
pick-value keepers spread evenly over the rule's whole round span, round 1 included when allowed; validation ranges
in §3.

Left to the builder: the Custom inputs' layout (one compact row on desktop that wraps on phones, matching the
existing selects), input controls, exact error wording, the normaliser's name and module placement, cache-key
version bumps.
