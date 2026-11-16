# Keeper Rule Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded Gabagool keeper rule with five settings (presets plus Custom) used by every keeper tool, without changing any Gabagool number.

**Architecture:** A new pure module `site/assets/keeperrules.js` (UMD, no dependencies) owns the rule: presets, validation, normalisation, board reading and the help text. `keepers.js` and `pickvalue.js` take a normalised rule as an explicit argument. The in-season trade page chooses a rule per league (stored on the device). Published boards carry the rule as a validated YAML mapping.

**Tech Stack:** Plain browser JS (UMD modules, no build), Node fixtures `tests/*_fixture.cjs`, Python 3 + pytest for `src/ffmodel/league.py`.

**Spec:** `docs/superpowers/specs/2026-11-16-keeper-rule-settings-design.md` (approved 2026-11-16). Read it before your task.

## Global Constraints

- **Gabagool regression:** every existing fixture keeps its expected values. Fixture call sites may change only to pass Gabagool's rule explicitly. An assertion that names a removed constant (`K.MAX_YEARS_KEPT`, `Keepers.MAX_KEEPERS`, `K.NO_HISTORY_NOTE`) expects the same value from the ladder rule instead.
- **Ladder preset**, key `"ladder"`: `{first_keep: 1, per_year: 1, max_years: 2, undrafted_round: 12, earliest_round: 3}`. Its in-season label stays verbatim: `Round drafted − 1 per year kept (waiver pickups: round 12; max 2 years)`.
- **Ranges:**
  - `first_keep`, `per_year`: integers 0–5.
  - `max_years`: integer 1–20, or `null` (no limit).
  - `undrafted_round`: integer 1–30, or `"last"`.
  - `earliest_round`: integer 1–30.
  - `max_keepers`: integer 1–20 (boards only).
  - Booleans are never integers. Unknown keys are invalid.
- **No silent rule:** every keeper cost or eligibility call gets the rule explicitly, and a missing or invalid rule throws. The in-season page starts at **Unknown**.
- **Copy and data hygiene:** no real league name, id, team name or username in preset labels, code identifiers, fixtures or commit messages. Never hand-edit `site/data/**`.
- **Cache keys:** `keeperrules.js` and every asset a task changes load with `?v=kr1` on every page that loads them. `shared_assets_fixture.cjs` and `navigation_fixture.cjs` check these.
- **Commands (Git Bash, from the worktree root):**
  - Fixtures: `for f in tests/*_fixture.cjs; do PYTHON="$(cygpath -w "$(which python)")" node "$f" || { echo "FAIL $f"; break; }; done`
  - pytest: `PYTHONPATH=src python -m pytest -q -p no:cacheprovider`. `PYTHONPATH` is required in a worktree, or pytest tests the main checkout.
- **Known flake:** `tests/waivers_fixture.cjs` "priced analysis took N ms" fails under CPU load. Rerun it idle before calling it a regression.

## Review Focus

1. **`max_years: null` vs JS comparison:** `yearsKept > null` is `true` in JS (null → 0). A no-limit rule must never say "already kept the most allowed". Pinned in Task 2.
2. **Half-typed Custom input** (a field emptied mid-edit, `"abc"`, `-1`): must keep the previous rule in force, show the inline message, and never throw or recompute. Pinned in Task 5.
3. **A choice saved before this change** (`{keeperRule: "ladder"}` in `megatron.trade.picks.v1|<id>`): must load as the ladder preset, with identical lines. Pinned in Task 5.
4. **The live board still says `keeper_rules: "gabagool"`** until the draft pipeline regenerates it. The keeper panel and the pre-draft page must work unchanged on it. Pinned in Tasks 2 and 3.
5. **Two different Custom rules in one session** must not share a cached pick curve: the cache key is the rule's settings, not `"custom"`. Pinned in Task 5.

---

### Task 1: `keeperrules.js` — the rule module

**Files:**
- Create: `site/assets/keeperrules.js`
- Test: `tests/keeperrules_fixture.cjs` (new)

**Interfaces:**
- Produces `window.KeeperRules` / `module.exports`, frozen:
  - `PRESETS`: frozen array in menu order `ladder, same_round, one_earlier, after_first`. Each entry is `{key, label, settings}`; `settings` holds the five raw settings from spec §6. Labels:
    - `ladder`: the existing label (Global Constraints).
    - `same_round`: `Kept at the round drafted, every year (no limit)`
    - `one_earlier`: `One round earlier each year kept, starting with the first (no limit)`
    - `after_first`: `The round drafted the first year, one round earlier each year after (no limit)`
  - `preset(key) -> settings | null`: a fresh copy.
  - `validate(raw) -> string | null`: null when valid. Otherwise a message that starts with the bad setting's label, checking keys in the order first_keep, per_year, max_years, undrafted_round, earliest_round, max_keepers. Labels: `First keep`, `Each later year`, `Most years in a row`, `Never-drafted cost`, `Earliest round`, `Keepers per team`. Unknown key: `Unknown keeper setting: <key>`. `max_keepers` is optional here. A non-object fails with `Keeper rule must be an object`.
  - `normalize(raw, {rounds}) -> rule`: throws `Error(validate message)` when invalid. Resolves `"last"` to `rounds`, and throws `Error("Never-drafted cost: the league's number of draft rounds is unknown")` when rounds is not a positive integer. Returns a frozen `{first_keep, per_year, max_years, undrafted_round, earliest_round}`, plus `max_keepers` when given.
  - `isRule(x) -> boolean`: true only for an object `normalize` returned. Use a module-private WeakSet.
  - `fromBoard(league) -> rule | null`:
    - absent `keeper_rules` → null.
    - string `"gabagool"` or `"ladder"` → the ladder settings plus `max_keepers: 2`, normalised.
    - plain object → normalised with `{rounds: league.rounds}`; it must have `max_keepers`, or the result is null.
    - any other string, or an invalid object → null. Never throws.
  - `key(rule) -> string`: a stable cache key from the five settings (e.g. `JSON.stringify` of them in fixed order). `key(null)` is `"unknown"`.
  - `helpText(rule) -> string`: the draft-page help paragraph (copy below).

- [ ] **Step 1: Write the failing tests** in `tests/keeperrules_fixture.cjs`. Use the existing fixtures' `check(name, fn)` style and end with a summary line like the others. Assertions:
  - `validate(preset(k)) === null` for every preset key.
  - Invalid inputs each give a message matching their label:
    - `first_keep: -1` → `/^First keep/`; `first_keep: 6`; `first_keep: 1.5`; `first_keep: true`;
    - `max_years: 0` → `/^Most years in a row/`;
    - `undrafted_round: "first"` → `/^Never-drafted cost/`;
    - `earliest_round: 31` → `/^Earliest round/`;
    - `max_keepers: 0` → `/^Keepers per team/`;
    - `{...ladder, extra: 1}` → `/^Unknown keeper setting: extra/`;
    - a missing `per_year` → `/^Each later year/`.
  - `normalize({...preset("same_round")}, {rounds: 15}).undrafted_round === 15`. `normalize` of that `"last"` rule with `{rounds: null}` throws `/draft rounds is unknown/`.
  - `isRule(normalize(preset("ladder"), {}))` is true. `isRule({...preset("ladder")})` is false.
  - `fromBoard`:
    - `fromBoard({keeper_rules: "gabagool"})` deep-equals ladder + `max_keepers: 2`; `fromBoard({keeper_rules: "ladder"})` likewise;
    - `fromBoard({keeper_rules: "other"}) === null`;
    - `fromBoard({}) === null`;
    - `fromBoard({keeper_rules: {...preset("ladder")}})` → null (no max_keepers);
    - `fromBoard({keeper_rules: {...preset("same_round"), max_keepers: 1}, rounds: 16}).undrafted_round === 16`;
    - `fromBoard({keeper_rules: {first_keep: 9}})` → null without throwing.
  - `key(a) === key(b)` for two normalisations of the same settings. `key` differs when any setting differs. `key(null) === "unknown"`.
  - `helpText(fromBoard({keeper_rules: "gabagool"}))` equals exactly the Gabagool paragraph below. One assertion per other cost branch (f=p=0, f=0<p, f>0=p, f≠p both >0) checks the cost sentence. `max_years: null` gives the no-limit sentence.

  `helpText(rule)` is the sentences below joined by single spaces. `n(k)` is `one round` when k = 1, otherwise `<k> rounds`; `u` is `undrafted_round`; `e` is `earliest_round`.
  1. `Add each keeper-eligible player with the round and year you ORIGINALLY drafted him (<cost>).`, where `<cost>` is:
     - f = p > 0: `cost drops n(p) for each year you keep him`
     - f = p = 0: `he is kept at that round every year`
     - f = 0 < p: `the first year you keep him he costs that round, then n(p) earlier each year after`
     - f > 0 = p: `keeping him costs n(f) earlier than that round, every year`
     - otherwise: `the first year you keep him he costs n(f) earlier, then n(p) earlier each year after`
  2. Only when f + p > 0:
     - e > 1: `Once a keeper's cost would reach round <e−1> he goes back into the draft pool.`
     - e = 1: `Once a keeper's cost would fall below round 1 he goes back into the draft pool.`
  3. Years in a row:
     - max_years = m: `A player can be kept at most <m> year<s> in a row.`
     - null: `There is no limit on how many years a player can be kept.`
  4. `A player keeps his original draft round even if he was dropped and later picked back up — only players never drafted in this league cost R<u>.`
  5. Waiver decay:
     - p > 0: `A kept waiver player decays too — R<u> the first year you keep him, R<u−p> the next.`
     - p = 0: `A kept waiver player stays at R<u>.`
  6. `Keeping is optional — the tool recommends only players worth more than their keeper cost.`

  Gabagool's paragraph is therefore exactly:
  `Add each keeper-eligible player with the round and year you ORIGINALLY drafted him (cost drops one round for each year you keep him). Once a keeper's cost would reach round 2 he goes back into the draft pool. A player can be kept at most 2 years in a row. A player keeps his original draft round even if he was dropped and later picked back up — only players never drafted in this league cost R12. A kept waiver player decays too — R12 the first year you keep him, R11 the next. Keeping is optional — the tool recommends only players worth more than their keeper cost.`

- [ ] **Step 2: Run it.** `node tests/keeperrules_fixture.cjs`. Expected: FAIL, cannot find `../site/assets/keeperrules.js`.
- [ ] **Step 3: Implement `site/assets/keeperrules.js`.** Use the same UMD wrapper shape as `site/assets/keepers.js` lines 31–35, global name `KeeperRules`.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add site/assets/keeperrules.js tests/keeperrules_fixture.cjs && git commit -m "feat(keepers): keeper rule module — presets, validation, board reading, help text"`

### Task 2: `keepers.js` takes the rule; the draft-page keeper panel reads the board's rule

**Files:**
- Modify: `site/assets/keepers.js` (math, `init`, notes)
- Modify: `site/index.html`:
  - `#keepers` panel copy, lines ~146–160;
  - the keeper init near line 773;
  - script tags: add `assets/keeperrules.js?v=kr1` before `keepers.js`; `keepers.js?v=kr1`.
- Modify: `site/trade.html`: add `keeperrules.js?v=kr1` before `keepers.js`, and `keepers.js?v=kr1`. Both pages load keepers.js.
- Modify: `site/assets/seasontrademode.js` `ladderKeepers` (~line 1299) as a stopgap. It passes the ladder rule (`KeeperRules.normalize(KeeperRules.preset("ladder"), {})`) to `K.eligible`/`K.keeperCost`, so the in-season page keeps working until Task 5 replaces this with the chosen rule. `seasontrademode.js?v=kr1`.
- Test: `tests/keepers_fixture.cjs`, plus any fixture that loads keepers.js and needs `keeperrules.js` loaded first (including `seasontrademode_fixture.cjs`'s script loader).

**Interfaces:**
- Consumes (Task 1): `KeeperRules.isRule`, `normalize`, `preset`, `fromBoard`, `helpText`.
- Produces:
  - Rule-taking functions, all throwing `Error("keepers.js: a keeper rule is required")` unless `KeeperRules.isRule(rule)`:
    - `keeperCost(c, currentSeason, rule)`
    - `eligible(c, currentSeason, rule)`
    - `surplus(c, currentSeason, rule)`
    - `unvaluedKeepers(candidates, currentSeason, rule)`
    - `rankKeepers(candidates, currentSeason, boardPlayers, rule, options = {})`
    - `recommendKeepers(candidates, currentSeason, boardPlayers, rule, options = {})`
  - `yearsKept(c, currentSeason)` is unchanged and takes no rule. Ruling: its math does not depend on the rule.
  - `maxKeepers` in `rankKeepers`/`recommendKeepers` = `options.maxKeepers ?? rule.max_keepers`. If that is not a positive integer, they throw.
  - `noHistoryNote(rule) -> string`: today's `NO_HISTORY_NOTE` text with `R12` replaced by `R<undrafted_round>`.
  - `init({players, panel, currentSeason, rule})`: `rule` is a board rule with `max_keepers`.
  - Removed exports: `MAX_KEEPERS`, `MAX_YEARS_KEPT`, `NO_HISTORY_NOTE`. Kept: `TEAMS`, `DRAFT_ROUNDS`, `MARGINAL_POINTS`.
- Cost math, exactly spec §4 (`f = rule.first_keep`, `p = rule.per_year`):
  - waiver: `undrafted_round − p × (currentSeason − firstKeptYear)`, with `firstKeptYear` defaulting to `currentSeason`.
  - Sleeper entry (`lastDraft != null`), `n = currentSeason − lastDraft`:
    - `keptYears ≥ 1`: `originalRound − p × n`
    - otherwise: `originalRound − f − p × (n − 1)`
  - manual entry, `n = currentSeason − originalYear`: `originalRound − f − p × (n − 1)`.
- Eligible: `cost ≥ max(earliest_round, 1)`, and `max_years === null || yearsKept ≤ max_years`. Compare with an explicit null check.

- [ ] **Step 1: Update and add tests** in `tests/keepers_fixture.cjs`.
  - Define `const LADDER = KeeperRules.normalize({...KeeperRules.preset("ladder"), max_keepers: 2}, {})` at the top. Pass it at every existing call site, keeping every expected value.
  - Replace `assert.strictEqual(K.MAX_YEARS_KEPT, 2)` with `assert.strictEqual(LADDER.max_years, 2)`. Line 592 now compares `K.noHistoryNote(LADDER)` with the same text.
  - New check "keeper rules: costs per preset". The Sleeper `testKeptYears` candidates at 2027 (chain, new, old, brk), plus a waiver with `firstKeptYear` 2026 and a manual `{originalRound: 8, originalYear: 2025}`:

    | rule | chain (keeper anchor R6, n=1) | new (fresh R5) | old (fresh R8, 2024) | brk (keeper R9, 2025) | waiver 2026 | manual R8/2025 |
    |---|---|---|---|---|---|---|
    | ladder | 5 | 4 | 7 | 8 | 11 | 6 |
    | same_round (rounds 15) | 6 | 5 | 8 | 9 | 15 | 8 |
    | one_earlier (rounds 15) | 5 | 4 | 7 | 8 | 14 | 6 |
    | after_first (rounds 15) | 5 | 5 | 8 | 8 | 14 | 7 |

    Cell formulas:
    - **manual**: n = 2027 − 2025 = 2, cost = `8 − f − p`;
    - **waiver**: `u − p×1`;
    - **old**: fresh pick, lastDraft 2026, n = 1, cost = `8 − f`;
    - **brk**: keeper pick, cost = `9 − p`.
  - New check "no year limit never trips the cap" (Review Focus 1): `same_round` with a candidate whose `yearsKept` is 5 is eligible. The panel's reasons never say "already kept the most allowed".
  - New check "earliest round": `{...one_earlier, earliest_round: 5}`, a fresh R5 anchor at n = 1 → cost 4, ineligible. Without that line (`earliest_round: 1`), a cost of 1 is eligible and a cost of 0 is not.
  - New check "a missing or plain-object rule throws": `keeperCost(c, 2027)` and `keeperCost(c, 2027, {...preset("ladder")})` both throw `/a keeper rule is required/`.
- [ ] **Step 2: Run** `node tests/keepers_fixture.cjs`. Expected: FAIL on the new checks and on the rule argument.
- [ ] **Step 3: Implement.**
  - **keepers.js math:** remove `WAIVER_COST_ROUND`, `MAX_YEARS_KEPT`, `MAX_KEEPERS` and the `>= 3` test.
  - **Copy inside `init`, numbers from the rule:**
    - the ineligible cap reason ``already kept the most allowed (${rule.max_years} years), so he goes back to the draft pool``, used only when `max_years !== null` and he is over it;
    - the waiver note `waiver keepers assume this is their first keep (R<u>)`;
    - `noHistoryNote(rule)`.
  - **Panel text from the rule:**
    - `.keeper-help` textContent = `KeeperRules.helpText(rule)`;
    - the waiver checkbox label text `never drafted in this league (R<u>)`;
    - the depletion label text ``assume ${Keepers.TEAMS} teams keep ${k} each (${Keepers.TEAMS * k} players off the board)``, with `k = rule.max_keepers`.

    Keep the `<input>` elements. Put the changing text in a `<span>` you can target.
  - **index.html:** the inline script computes `const keeperRule = window.KeeperRules ? KeeperRules.fromBoard(board.league) : null;`. The keeper panel initialises only when `keeperRule` is non-null, as well as today's conditions. Otherwise it is hidden, as today. It passes `rule: keeperRule`. The static help text in the HTML may stay as the no-JS fallback.
- [ ] **Step 4: Run all fixtures.** Expected: all pass except `trade_fixture` and `trademode_fixture`, which fail on the missing rule argument until Task 3 threads it through. Record which checks fail in your report, and do not edit trade.js/trademode.js. `seasontrademode_fixture` must pass, thanks to the stopgap.
- [ ] **Step 5: Commit** keepers.js, index.html, trade.html and the fixtures, as `feat(keepers): keeper math and the draft-page panel take the league's rule`.

### Task 3: the pre-draft trade page uses the board's rule

**Files:**
- Modify: `site/assets/trade.js`:
  - `CTX_REQUIRED` and `requireCtx` (~line 61);
  - `candidate` (~130);
  - the `rankKeepers`/`recommendKeepers` calls (402, 452);
  - the `eligible` call at 871;
  - line 404's maxKeepers.
- Modify: `site/assets/trademode.js`:
  - `leagueWorld` ctx (~213);
  - the no-history warnings (~172–183);
  - `keeperNote` (~307);
  - `init` reads the rule from `board.league` via `KeeperRules.fromBoard`.
- Modify: `site/trade.html`, the pre-draft branch near line 164: when `KeeperRules.fromBoard(board.league)` is null, stamp the existing `NOT_AVAILABLE` and return, like `!entry.tools.trade`. Cache keys `trade.js?v=kr1`, `trademode.js?v=kr1`.
- Test: `tests/trade_fixture.cjs`, `tests/trademode_fixture.cjs`

**Interfaces:**
- Consumes (Tasks 1–2): `KeeperRules.fromBoard`; Keepers' rule-taking functions; `Keepers.noHistoryNote(rule)`.
- Produces:
  - `ctx.keeperRule`, a normalised board rule, added to `CTX_REQUIRED`.
  - `leagueWorld(…)` sets `ctx.keeperRule` and `ctx.maxKeepers = keeperRule.max_keepers`. Its caller passes the board's rule: add it to the existing `opts`, as `opts.keeperRule`.
  - `keeperNote(player, ctx)` takes its numbers from `ctx.keeperRule`. The cap line appears only when `max_years !== null` and he is over it.
  - The no-prior-season warning becomes ``no prior season — keeper costs unknown, every player priced at full value (each is treated as a first-time R${u} keeper, so nobody is ineligible)``.

- [ ] **Step 1: Update the tests.**
  - Every ctx a fixture builds gets `keeperRule: LADDER` (defined as in Task 2).
  - `assert.strictEqual(w.ctx.maxKeepers, Keepers.MAX_KEEPERS)` becomes `…, 2`. Line 215 uses `Keepers.noHistoryNote(LADDER)`.
  - Add these checks to `trademode_fixture`:
    - **(a)** `keeperNote` under `same_round` (normalised with rounds 15, `max_keepers: 2`) for `{round: 9, season: 2026, keptYears: 2, lastDraft: 2026}` at season 2027 gives `{eligible: true, text: "keeper cost R9"}`. A keeper pick at `per_year: 0` costs R9, and with no limit the cap never fires.
    - **(b)** `requireCtx` throws `/ctx.keeperRule is required/` when it is missing.
    - **(c)** A board whose `keeper_rules` is `"gabagool"` produces the same `leagueWorld` ctx numbers as one whose `keeper_rules` is the equivalent object (Review Focus 4).
- [ ] **Step 2: Run** `node tests/trademode_fixture.cjs` and `node tests/trade_fixture.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all fixtures.** Expected: all pass, except possibly `seasontrademode_fixture` checks for the in-season rule argument (Task 5). Report any.
- [ ] **Step 5: Commit**, as `feat(trade): the pre-draft trade page prices keepers under the board's rule`.

### Task 4: pick values follow any rule

**Files:**
- Modify: `site/assets/pickvalue.js`:
  - `KEEPER_RULES` and the ladder constants (lines 25–33);
  - `buildCurve` (246–310);
  - load `KeeperRules` the way `keepers.js` loads its dependencies (window, else `require("./keeperrules.js")`).
- Modify: `site/trade.html`: `pickvalue.js?v=kr1`.
- Test: `tests/pickvalue_fixture.cjs`

**Interfaces:**
- Consumes: `KeeperRules.isRule`, `normalize`, `preset`.
- Produces: `buildCurve({..., keeperRule})`. Accepted values of `keeperRule`:
  - `undefined`, `null` or `"unknown"`: every pick is live.
  - `"ladder"`: the ladder preset, normalised with `{rounds}`.
  - a `KeeperRules.isRule` object: that rule.
  - anything else throws `/Unknown keeper rule/`.

  The keeper span runs from round `first = earliest_round` to round `last = min(undrafted_round, rounds)` (when `rounds` is missing, `undrafted_round`). An empty span behaves exactly like Unknown. `KEEPER_RULES` stays exported as `["unknown", "ladder"]`, the accepted names.

- [ ] **Step 1: Write the tests** in `tests/pickvalue_fixture.cjs`:
  - The existing ladder check passes unchanged.
  - New: `same_round`, normalised with rounds 15, at teams 12, keepers 1, rounds 15:
    - `rankAtSlot(1) === 13`
    - `close(rankAtSlot(180), 12 + 179 − 179/15 + 1)`
    - values non-increasing over slots 1..180
  - New: `{...one_earlier, earliest_round: 13, undrafted_round: 12}`, normalised (empty span): `rankAtSlot(s)` equals Unknown's for s in 1..180.
  - New: `buildCurve` with a plain object copy of a preset throws `/Unknown keeper rule/`.
- [ ] **Step 2: Run** `node tests/pickvalue_fixture.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all fixtures.** Expected: all pass.
- [ ] **Step 5: Commit**, as `feat(picks): draft-pick values spread keepers over the chosen rule's rounds`.

### Task 5: the in-season trade page's rule menu, Custom settings and storage

**Files:**
- Modify: `site/assets/seasontrademode.js`:
  - `PICK_RULES` / `PICK_COPY` (~100–115);
  - `picksSummary` (~137–163);
  - `preparePicks` curves (~660–680);
  - `loadPref`/`savePref` (~686–700);
  - `setPref` and the select builder (~890–920);
  - the history walk triggers (~791, 915);
  - `ladderKeepers` (~1289–1300).
- Modify: `site/trade.html`: `seasontrademode.js?v=kr1`. Modify the CSS the existing pick controls use, if the Custom row needs it.
- Test: `tests/seasontrademode_fixture.cjs` (its script loader must load `keeperrules.js` before `pickvalue.js`)

**Interfaces:**
- Consumes: `KeeperRules.PRESETS`, `validate`, `normalize`, `key`. `PickValue.buildCurve` with a rule (Task 4). `Keepers.keeperCost`/`eligible` with a rule (Task 2).
- **Menu:** `PICK_RULES` = `[["unknown","Unknown"], ...PRESETS.map(p => [p.key, p.label]), ["custom","Custom…"]]`.
- **Pref:** `{preset, order, keeperRule, keeperCustom?}`.
  - `keeperRule` ∈ `"unknown"`, a preset key, or `"custom"`.
  - `keeperCustom` holds the five raw settings and is present only when `keeperRule === "custom"`.
  - `loadPref` falls back to `"unknown"` for an unknown key, or for `"custom"` whose `keeperCustom` fails `validate`.
- **Active rule:** `null` for Unknown; otherwise `KeeperRules.normalize(settings, {rounds: PK.rounds})`. If normalising throws, treat it as Unknown and show the message under the menu.
- **Curves:** build lazily on first use, cached in a `Map` keyed by `KeeperRules.key(rule)`. Do not precompute them over `KEEPER_RULES`.
- **`picksSummary({..., keeperRule})`:** `keeperRule` is now the active rule object or null. `PICK_COPY.ladderNote` is shown iff `keeperRule && keeperRule.earliest_round > 1`.
- **Rule-gated behaviour:** everything gated today on `=== "ladder"` (the history walk at load and on change, `ladderKeepers`, likely-keeper filtering, `keeperPickLines`) is now gated on "the active rule is not null", using that rule. Choosing a rule other than Unknown starts the history walk once per load, as the ladder does today.
- **Custom row:** choosing `Custom…` shows five labelled number inputs under the menu, prefilled from the rule that was showing (the ladder preset when Unknown was showing). The previous rule stays in force until all five are valid.
  - Labels:
    - `First keep: rounds earlier than drafted`
    - `Each later year: rounds earlier`
    - `Most years in a row (blank = no limit)`
    - `Never-drafted player costs round (blank = last round)`
    - `Earliest round a keeper can cost`
  - Blank maps to `null` for years and to `"last"` for the never-drafted round.
  - On every `input`/`change`: when `validate` passes, `setPref({keeperRule: "custom", keeperCustom})` and recompute. Otherwise put the `validate` message in an inline `role="status"` element and change nothing else.
  - Choosing a preset or Unknown hides the row.
  - Layout: one compact row on desktop that wraps on phones, matching `.season-pick-select`.

- [ ] **Step 1: Write the tests** in `tests/seasontrademode_fixture.cjs`, reusing its page helpers (`openKeeperPage`, `choose`, `compareOffer`, `conflictLines`, `keeperLinesOf`, `memStorage`, `PREF_KEY`):
  - **(a)** Every existing ladder check passes unchanged, including `ladderStore()`'s stored `{keeperRule: "ladder"}` (Review Focus 3).
  - **(b)** Choosing `same_round` re-runs the keeper lines. In the `picksKeeperCap` world, A Back (2026 keeper R4 there) is a likely keeper again: under `per_year: 0` with no limit, the cap and the cost floor never exclude him.
  - **(c)** Custom round-trip: choose `custom`, set every input valid, and storage holds `keeperRule: "custom"` plus `keeperCustom` with those values. Reopen the page with that storage and the menu shows `custom`, with the inputs filled.
  - **(d)** Review Focus 2: in Custom, set `First keep` to `""`, then `"9"`. Storage is unchanged, the status names `First keep`, and the conflict lines are unchanged.
  - **(e)** A stored `{keeperRule: "custom", keeperCustom: {first_keep: 9, …}}` loads as Unknown.
  - **(f)** Review Focus 5: two Custom rules that differ only in `earliest_round` (1 vs 5) give different pick values for a round-3 pick, and switching back to the first gives its original value.
  - **(g)** `picksSummary` with `keeperRule: null` has no ladder note; with the ladder rule object, it has it.
- [ ] **Step 2: Run** `node tests/seasontrademode_fixture.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all fixtures.** Expected: all pass.
- [ ] **Step 5: Commit**, as `feat(trade): in-season keeper rule menu with presets and custom settings`.

### Task 6: published boards carry the rule as settings; FAM comments; `boardEntry`

**Files:**
- Modify: `src/ffmodel/league.py`:
  - `LeagueConfig.keeper_rules` type;
  - load-time validation;
  - `payload()`.
- Modify: `configs/leagues/gabagool.yaml` (`keeper_rules` mapping).
- Modify: `configs/leagues/fam.yaml:61-62` and `configs/formats/f10-1qb-ppr-6.yaml:64-65`. The comments become: `# keeper_rules omitted: FAM is not a keeper league (owner, 2026-11-16).`
- Modify: `site/assets/app.js` `boardEntry` (line ~172), and `app.js?v=kr1` on every page that loads it (about, index, trade, waivers, weekly).
- Test: `tests/test_league.py`, plus the existing fixture that covers `boardEntry` (find it with `grep -n "boardEntry" tests/*.cjs`).

**Interfaces:**
- Consumes: nothing from Tasks 1–5. The site reads the payload through `KeeperRules.fromBoard`, which already accepts this object (Task 1).
- Produces:
  - `LeagueConfig.keeper_rules: dict | None`, validated by `_validate_keeper_rules(raw, path) -> dict` in `league.py`. Rules:
    - exactly the keys `first_keep, per_year, max_years, undrafted_round, earliest_round, max_keepers`, all required;
    - ranges from Global Constraints; `bool` is rejected;
    - `max_years` may be `None`; `undrafted_round` may be `"last"`.
    - Error: `ValueError(f"{path}: keeper_rules.{key} …")`.
    - A plain string is invalid now: `ValueError(f"{path}: keeper_rules must be a mapping")`.
  - `payload()["keeper_rules"]` is that dict.
  - `gabagool.yaml`:
    ```yaml
    keeper_rules:
      first_keep: 1
      per_year: 1
      max_years: 2
      undrafted_round: 12
      earliest_round: 3
      max_keepers: 2
    ```
  - `boardEntry`: `keepers` is true iff `keeper_rules` is `"gabagool"` or `"ladder"`, or a non-null, non-array object.

    Ruling, a plan-level simplification of spec §5.4: `app.js` does not load `keeperrules.js`, so `boardEntry` checks shape only. The full validation is Python at build time plus `KeeperRules.fromBoard` on the two pages that use the rule (Tasks 2–3), which hide the tools when it returns null.

- [ ] **Step 1: Write the tests.**
  - `tests/test_league.py`:
    - line 17 → `cfg.keeper_rules == {"first_keep": 1, "per_year": 1, "max_years": 2, "undrafted_round": 12, "earliest_round": 3, "max_keepers": 2}`;
    - line 89 → the payload equals the same dict.
  - New: a parametrised `test_keeper_rules_rejects` over a temp YAML (copy gabagool.yaml, then mutate):
    - `per_year: 6`
    - `first_keep: true`
    - `max_years: 0`
    - `undrafted_round: "first"`
    - `earliest_round: 0`
    - `max_keepers: 21`
    - an extra key
    - a missing `per_year`
    - `keeper_rules: gabagool` (string)

    Each raises `ValueError` matching `keeper_rules`.
  - New: `max_years: null` and `undrafted_round: last` load.
  - **boardEntry fixture:**
    - `keeper_rules: "other"` → `tools.keepers === false`;
    - `keeper_rules: {…}` → `true`;
    - `"gabagool"` and `"ladder"` → `true`.
- [ ] **Step 2: Run** `PYTHONPATH=src python -m pytest -q -p no:cacheprovider tests/test_league.py` and the boardEntry fixture. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full pytest suite and all fixtures.** Expected: all pass. Do not regenerate or edit `site/data/**`: the live board keeps the string `"gabagool"`, which Task 1's legacy alias covers.
- [ ] **Step 5: Commit**, as `feat(config): league keeper rules are validated settings; FAM is not a keeper league`.
