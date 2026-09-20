# Shared league context

Use the League selector at the top of each page. Gabagool and FAM are both
Sleeper leagues accessible to Max973; they are not separate logins. A public
username is sufficient. The identity is entered once, in the chip inside
`#league-context`, and shared by every page through `assets/session.js`; it
is remembered on this device until you choose forget, and credentials are
never requested. League choice lives in each tab's URL, so using FAM cannot
change an open Gabagool tab.

`FC.REGISTRY` in `assets/app.js` is the single source of league capabilities:
slug, platform, live league id, label and which tools each league connects
to. The session, the nav labels, the league select and the connect page's
configured-league detection all read it; nothing else keeps a league table.

## Current coverage

| Tool | Gabagool | FAM Sleeper | ESPN family |
|---|---|---|---|
| Draft board | League-specific | League-specific | League-specific manual draft |
| Weekly/start-sit | Live roster, own scoring | Live roster, own scoring | Not connected |
| Waiver research | FAAB budget guidance | Rolling priority, no dollar bids | Not connected |
| Trade calculator | Pre-draft grader; in-season conditional lineup scenario | In-season conditional lineup scenario | Not supported |

Unsupported tools do not silently switch to Gabagool. In season the trade page shows a conditional lineup scenario, not a trade evaluation or grade. All tools remain
read-only; managers submit changes in their platform.

Weekly payloads are isolated: `weekly.json` and `weekly-fam.json`. The scheduled
update generates both. Live league IDs, scoring, roster shape and season are
checked against the appropriate payload. Changing a label or league ID alone
does not make another league supported. Kickoffs and observed NFL workload
are league-independent shared data. The close-decision diagnostic remains a
modeled-Gabagool-scoring historical diagnostic, not a new FAM backtest.

## Sleeper discovery and scoring foundation

`connect.html` discovers current-season leagues for the shared session's
account and displays live roster/scoring settings. Its form and the chip
write the same identity; a change or forget in either clears the list.
Configured leagues are recognised from `FC.REGISTRY` and their links still use
the existing tools' contract checks. Unknown leagues have no advice links and
do not inherit Gabagool values. Editing the username invalidates pending
results.

Newly generated weekly payloads include full-precision `stat_quantiles` with
nullable outer bands and an explicit schema. Pick-six expectations, when
available, are included. Existing rounded points and `stats_p50` stay unchanged.
The pure `league-scoring.js` foundation scores supported linear categories,
including pick-six penalties, from these components. Missing stats, nonfinite
weights and unknown nonzero categories fail closed. It is not yet wired into
arbitrary-league lineup advice; K/DST, bonuses and unmodeled scoring cannot be
silently ignored. Custom-scoring bands do not inherit historical calibration.

## Remaining general-purpose direction

1. Platform connection: username-based Sleeper league discovery; separate
   authorized ESPN access/import rather than asking users to share passwords.
2. Normalized league context: platform IDs, ownership, scoring, legal slots,
   waiver type and keeper rules. Account identity and selected league are
   separate concepts.
3. League-specific scoring: derive supported categories from underlying stat
   projections, disclose unmodeled categories, and reject unsupported rules.
   Do not rescale another league's point totals.
4. Capability checks per tool: rolling waivers differ from FAAB, and keeper
   draft trades differ from in-season roster trades. Unsupported capabilities
   must be explicit.
5. Validate roster-aware outcomes against a suitable baseline before claiming
   an edge for arbitrary leagues or platforms.

The current supported-league registry is intentionally limited to verified
configs. Removing that restriction without contract generation and validation
would make the interface general-purpose while leaving its advice incorrect.
