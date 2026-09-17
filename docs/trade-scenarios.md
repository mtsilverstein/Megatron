# In-season trade scenarios

## The page (2026-09-17)

`trade.html?league=gabagool` and `?league=fam` switch to an in-season branch when the
Sleeper league is `in_season`. Enter your username, pick a partner, tick the players
on each side, mark any weeks a player should be assumed unavailable (your assumption —
the page never fills one in from an injury tag), acknowledge that everyone else is
assumed to play, add explicit drops when a side would exceed roster capacity, and
press "Compare lineups". The result is both sides' week-by-week and remaining-season
starting-lineup change from the model's remaining-season projections, labeled
"Conditional lineup scenario — not a trade verdict." Picks in the offer are listed as
not valued; keeper value is not modeled; the current week is excluded because trades
may process after games start. No suggestions, no league scan, no grade: those are
gated behind the roster-level promotion test recorded in
`docs/superpowers/specs/2026-09-17-inseason-trade-scenario-design.md` §8. The pre-draft
calculator is unchanged and still refuses in-season leagues.

This is a read-only experimental engine, not the published pre-draft trade
calculator. It does not send trades, give a verdict, price keeper/pick assets,
or claim expected realized points. Live advice remains disabled. The
remaining-season artifact no longer carries an advice_eligible flag; it
carries a measured evaluation block (see remaining-season-projections.md),
and this prototype still returns advice_eligible:false for its own output.

Generate a fresh remaining-season artifact with the existing generator's
`--remaining --week auto` flags into a local output directory. Then create
a scenario JSON file, using actual roster IDs and Sleeper player IDs:

```json
{
  "remainingPath": "C:/path/to/remaining-gabagool.json",
  "rosterIds": [1, 2],
  "give": ["PLAYER_YOU_SEND"],
  "receive": ["PLAYER_YOU_RECEIVE"],
  "drops": {"1": [], "2": []},
  "excludeWeeks": {},
  "assumeAvailable": true
}
```

Run `node tools/seasontrade.cjs scenario.json`. It fetches current league,
rosters, catalog and NFL state read-only, verifies the scoring contract, and
prints before/after starting lineups for both teams for each future week.
Only weeks after both the current week and the projection origin are compared.
A 60-second roster age limit and
72-hour projection age limit apply. Use the other league's own artifact for
FAM; cross-league scoring or identities cannot be substituted.
The CLI uses the league's checked-in draft board only as an identity
crosswalk, never as a source of points or rankings. Leading/trailing spaces
in catalog GSIS IDs are normalized. Relevant player position/ID conflicts
remain blocking rather than being guessed away.

`excludeWeeks` maps a Sleeper ID to weeks deliberately assumed unavailable,
for example `{"1234": [3, 4]}`. Every other active player is explicitly
assumed available, even if an injury tag exists. This is a user-defined
scenario, not an injury or return-date prediction. IR/taxi players cannot
be traded by this first version. Missing projections block scoring rather
than counting as zero. A bye or deliberately excluded week is labeled zero.

Coverage failures produce a nonzero exit and a JSON report on stderr containing
every affected player and future week (`coverageIssues`), not a partial score.
New remaining-season artifacts distinguish no observed NFL history, history
outside the recent-season window, and missing model output. These reasons use
only observations before the forecast origin. Older artifacts still work but
may report only `unmodeled`. Rookies are not assigned arbitrary points, and
unknown bench players are not silently removed to force a comparison through.
Do not use availability exclusions merely to suppress coverage errors: an
exclusion is an explicit scenario assumption that the player cannot contribute.

Uneven trades require explicit legal drops if roster capacity would be
exceeded. Dropped players remain in the baseline but leave the changed roster,
so losing their lineup contribution counts against the trade.
K/DEF occupy roster spaces but have no modeled points. Missing starting
positions fail instead of inventing replacement production. Supported skill
slots include dedicated positions, FLEX and SUPER_FLEX.

The summed delta is a sum of conditional weekly lineup differences—not a
season median, calibrated interval, or additive player price. Bench insurance,
future waivers, keeper/pick premiums, trade processing time and the other
side's willingness to deal are not modeled. Future team changes are also unknown.
