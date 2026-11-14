# Draft picks in the in-season trade comparison — design

Date: 2026-11-13. Status: for owner approval. Owner decision 2026-11-13: build v1 in-season now, before the leagues' week-11 trade deadline (target under 4 days); player keeper value is the next milestone. Page: `site/trade.html` `#season-trade`
(`site/assets/seasontrademode.js`, engine `site/assets/seasontrade.js`).

## 1. Intent

The owner, in their words: when you trade picks "you are weighing immediate loss (season) vs future season
outlook". There is no blanket formula: "sometimes you are trading picks to make your team better now, and
sometimes you are trading picks to make your team better in the future", but "we should be able to place a
general weight on future picks", and "overall we are going for value".

The trigger is a friend's 12-team keeper league (1 keeper per team) where 2027 picks in rounds 1–6 already
change hands in-season. Today the in-season comparison refuses any pick ("Only skill-player trades supported; no
picks or K/DEF values").

## 2. Goals, non-goals, anti-goals

Goals
- Picks can be added to either side of an in-season trade in keeper leagues.
- The result shows **two separate numbers** — this season's starting-lineup change (exactly today's number) and
  next season's expected value change from the picks — plus **one overall number** under a weighting the user
  chooses from three presets.
- Every pick shows where it is likely to fall and how much that uncertainty matters (a range).

Non-goals (v1)
- Dynasty leagues (Sleeper `settings.type === 2`): their picks are rookie-draft picks; a curve built from full
  drafts does not describe them. Picks are not offered there (one line says why).
- Redraft leagues (`type === 0`): no future picks exist; nothing changes.
- Superflex and 2-QB keeper leagues (any `SUPER_FLEX` slot, or more than one `QB` slot): the market order behind
  the pick values is a one-QB order (the top QB sits at market rank 19–34 in every season 2021–2025), so early
  pick values would be wrong there. Picks are not offered; one line says why. (Both leagues that prompted this
  are one-QB.) TE-premium scoring is not excluded: values are scored with the league's own weights; only the
  market order is one-QB-PPR-ish, which the page does not need to mention.
- A player's own value next season (as a keeper) is **not counted** (the model projects only this season).
  It is flagged instead (§5.7).
- Working the weight out from playoff odds (approach C below): needs a season simulation that has passed its
  test; the current one has not ("Simulation is off").
- Trade verdicts ("accept"/"reject"), and any change to the pre-draft grader (`trademode.js`, archived board).

Anti-goals (would make this a failure even if it works)
- One blended number that hides the split between this season and next.
- False precision about a pick whose slot is unknown.
- Breaking or changing today's this-season numbers for trades without picks.
- Publishing third-party data (FantasyPros ECR values) or anything Sleeper-derived.

## 3. Constraints

- Static site, no backend, free tiers only; plain JS modules in the house style (UMD wrapper, node fixtures in
  `tests/*_fixture.cjs`).
- Points are always computed from stat lines with the league's own scoring weights (`LeagueLens`), never
  pre-scored in one format.
- Copy: plain sentence case; assumptions stated in words on the page; no apologies.
- Privacy: no real league ids, team names or usernames in code, fixtures or commits.

## 4. Approaches considered (for the future-vs-now weight)

- **A — one number with a slider** (the pre-draft grader's "future picks ×0.8"). Flexible but asks the user to
  invent a number with no anchor.
- **B — three presets labelled by intent (chosen by the owner 2026-11-13).** Win now = 0.5, Balanced = 0.8,
  Rebuild = 1.2. Same arithmetic as A, but the user picks what they are trying to do, which is how the owner
  describes the decision. Rebuild is above 1 on purpose: a team out of contention gains little from points
  this season and should value next season more.
- **C — derived from playoff odds.** Most principled (a team's need for points this season is mostly its chance
  of making and winning the playoffs) but depends on an unvalidated simulation. Deferred; once the simulation
  passes, it could choose the default preset.

## 5. Design

### 5.1 Arithmetic
`overall = this_season + w × next_season`, with `w` from the chosen preset (default **Balanced 0.8**). A pick
`n` seasons ahead is weighted `w^n` (only `n = 1` occurs in today's leagues, but the rule is general).
`this_season` is today's engine output (sum of weekly best-lineup changes over the remaining weeks, including the
Task B free-agent fill). `next_season` is the value of picks received minus picks given (§5.3). Picks affect
nothing this season and take no roster spot.

Why discount next season at all (shown in a one-line explainer): points do not earn interest; the weight
covers what the pick value cannot see (league rule changes, roster churn, whether points this season still
matter to you). Bust risk is already inside the pick value because it is measured on real outcomes.

### 5.2 Which picks exist and who owns them
- Offered only when `league.settings.type === 1` (keeper) and the league is in season.
- Seasons: the next season always; any later season that appears in `/league/<id>/traded_picks`.
- Rounds: `1..R`, `R` = the current season's draft rounds (`/draft/<league.draft_id>` `settings.rounds`); if that
  is unavailable, the highest round seen in `traded_picks`; if neither, picks are not offered (say so).
- Ownership: every roster owns its own pick for each (season, round) unless a `traded_picks` row for that
  (season, round, `roster_id` = original owner) says the current owner is `owner_id`. Field meanings (verified
  2026-11-13 on a live league): `roster_id` = original owner, `owner_id` = current owner, `previous_owner_id`.
- A pick is labelled `2027 R1` (own) or `2027 R1 (from <team name>)`.

### 5.3 What a pick is worth next season
The value of overall draft slot `s` is the expected **season points above a replacement-level starter**
(weeks 1–17, the league's scoring) of the player a typical drafter takes there, measured on real seasons:

1. **Data** — for each past season 2021–2025: the players in preseason market order (the order in the
   existing leak-free draft worlds, `models/backtests/worlds_tf/world_<S>.json`, field `ecr`) with position and
   **realized season stat totals** for weeks 1–17, summed from the nflverse weekly stat lines the pipeline
   already pulls (the worlds files store weekly *points* in one scoring, not stat lines, so they supply only the
   order). Published as a small committed artifact (e.g. `site/data/pick_curve.json`) carrying only rank order,
   position and stat totals — no ECR values, no names, no ids. Generated by a Python module; regenerated once a
   year when a season is added.
2. **Scoring** — in the browser, each player's realized stat totals are scored with the league's own weights
   (`LeagueLens.effectiveWeights` + `score`, p50 = the realized value).
3. **Replacement** — per position, the realized points of the **Nth-best actual scorer** at that position that
   season (true waiver level, stable — not the one market-ranked Nth player, whose single outcome is noisy and
   often near 0 after an injury), where N is the league's replacement rank, using the
   rule the draft board already applies (`flex_replacement_ranks` in `src/ffmodel/site/board_rank.py`:
   dedicated starters league-wide, flex spots split by market order, replacement = started + 1), ported to JS
   and fed this league's starting slots and team count, with market rank in place of ECR. Value = max(0, points − replacement) at the player's position.
4. **Keepers** — in a `T`-team league with `K` keepers per team, roughly the top `T·K` players never reach the
   draft (`K` = `league.settings.max_keepers`). A kept player also **uses up one of his team's own picks** (owner
   confirmed 2026-11-13 for Gabagool): the pick in his keeper-cost round. So the player available at a live pick
   is market rank `T·K + (live picks before it) + 1`, where picks spent on keepers are not live. Under the known
   ladder rule (below) no keeper can cost a round-1 or round-2 pick, so every R1/R2 pick is live and maps to
   `T·K + s`; for later rounds the builder spreads the `T·K` keeper picks over the rounds the rule allows
   (documented as an estimate). Under "Unknown" rule, all picks are treated as live (the `T·K` shift only).

   **Keeper rule** (a page control, remembered per league in the browser — never a league id in code):
   - **Unknown** (default): keepers remove the top players; which picks they cost is unknown.
   - **Drafted round − 1 per year kept** (Gabagool's rule, owner-confirmed 2026-11-13; already implemented as
     `keeperCost` / `eligible` in `site/assets/keepers.js`): cost = round he was last drafted − years kept;
     an undrafted waiver pickup costs round 12 the first year, then one round earlier per year; a player whose
     cost would be round 2 or earlier cannot be kept; and a player can be kept for **at most two years** (owner
     confirmed 2026-11-13; `keepers.js` does not yet enforce this cap and must before it is reused).
5. **Curve** — average the value at each market rank across seasons, then smooth across neighbouring ranks and
   force it to be non-increasing in slot (a later pick is never worth more). The exact smoother is the
   builder's choice within those rules.

### 5.4 Where a future pick falls
The next season's draft order is not set in Sleeper until the league renews. Control on the page:
"2027 draft order: **Not set yet** (default — every pick in a round is valued at the average slot of that round)
/ **By this season's standings** (worst record picks first: rank by wins, then points for, from `rosters`)".
Each pick also shows its range: the value at the best and worst slot of its round (snake order respected:
`draft.settings` type snake reverses even rounds; `reversal_round` if present). The range is always the whole
round, under either setting — there is no validated way to narrow it to a "likely" band. Under "By this
season's standings" the point value is the one estimated slot; under "Not set yet" it is the round average.

### 5.5 Engine and data flow
- The lineup engine (`seasontrade.js` `analyze`) is unchanged for players. A trade that includes no players
  (picks only) skips the engine: this season = 0.
- A new pure module (e.g. `site/assets/pickvalue.js`) owns: pick ownership from `traded_picks`, slot estimation,
  the value curve from the artifact + league scoring, and the weighted combination. No DOM, node-testable.
- `seasontrademode.js` fetches `/league/<id>/traded_picks` and `/draft/<draft_id>` through the shared Sleeper
  client (same timeout and cache-busting rules as other calls), only on this page, only for keeper leagues.

### 5.6 Page
Each column gets a collapsed "Draft picks (N)" group under the players, with a checkbox per owned pick.
Above the result, the weighting presets (`Win now · Balanced · Rebuild`, default Balanced) and the draft-order
control. Result block:

```
You give: <RB>                      You get: 2027 R1 (from Team 7), 2027 R3
This season (weeks 11–17):   −38.2 lineup points
Next season:                 +52.0 expected points   (R1: anywhere from pick 1 to 12, worth 30–75; R3: ~11)
Weighting: Balanced (next season × 0.8)
Overall:                     +3.4
```

Changing the preset or the draft-order control recomputes instantly (no new Sleeper fetch).

### 5.7 What the page says it leaves out
- "A player's value next season, as a keeper, is not counted." — plus, when a traded player ranks in his
  current team's top `K` by rest-of-season value: "<Player> is likely one of <team>'s keepers; his value next
  season is not counted."
- Keeper-pick conflict (only under a known keeper rule): when a pick on offer is the very pick a team's likely
  keeper would cost next season (cost computed from the league's draft history the way `keepers.js` already
  does), say so: "<team>'s likely keeper <Player> would cost their 2027 R7 — the pick in this offer."
- Dynasty: "Rookie-draft picks in dynasty leagues aren't valued: the pick values come from full drafts."
- Superflex / 2-QB: "Draft picks aren't valued in leagues that start two quarterbacks: the pick values come from
  one-quarterback drafts."
- Existing copy that becomes false when picks are in the offer: `SUBLINE_TAIL` ("Keeper value and draft picks are
  not valued, so no overall grade is shown.") and `GRADED_SUBLINE_TAIL` in `seasontrademode.js` (pinned in the
  page's allowed-sentences list), and the engine warning "No keeper or future-pick value, …" (as reworded by
  Task B). For a trade with picks they must say that keeper value is not counted and picks are valued for next
  season; for a trade without picks they stay as they are.

## 6. Testing
- Python: the artifact generator (rank order kept, stat totals equal the weekly sums, no ECR values or names in
  the output, 2021–2025 present).
- JS fixtures for `pickvalue.js`: ownership from `traded_picks` (traded, re-traded, untouched picks), slot
  ranges (snake), keeper shift, curve non-increasing, scoring with two different leagues gives different values,
  `w^n`, presets, picks-only trades, dynasty/redraft gating.
- `seasontrademode` fixture: picks render, presets recompute without refetch, the result shows both parts and the
  overall line, the keeper flag.
- Regression pin: a trade without picks shows exactly today's numbers and no next-season line.

## 7. Build notes and what is left to the builder
- The draft worlds (`models/backtests/worlds_tf/`) are gitignored and exist only in the main checkout, not in CI:
  the artifact generator takes the worlds directory and the weekly-stats source as arguments, its tests use
  small synthetic fixtures, and the generated artifact is committed.
- This builds on the in-season trade page as changed by Tasks B (free-agent fill) and C (copy, 390 px layout):
  the branch starts from their merged result, not from the older `main`.
- Left to the builder: artifact schema and file name; the smoother; module and function names; exact CSS within
  the house style; how the collapsed pick group looks on phones (must work at 390 px with Task C's layout rules).

## 8. Calls made by the designer (owner to check)
1. Keeper leagues only in v1; dynasty, redraft, superflex and 2-QB leagues excluded as above.
2. Pick value = realized points above replacement of the market-ranked player at that slot, 2021–2025, in the
   league's own scoring, shifted by `teams × keepers`; replacement = the Nth-best actual scorer at the position.
3. Default draft order "Not set yet" (average slot of the round), with a standings option; the range shown is
   always the whole round.
4. Player keeper value not counted in v1; flagged by name when likely.
5. Balanced (0.8) is the default preset.
