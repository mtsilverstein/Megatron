# Shared league context

Use the League selector at the top of each page. Gabagool and FAM are both
Sleeper leagues accessible to Max973; they are not separate logins. A public
username is sufficient. Typed usernames are remembered locally when storage
is available; credentials are never requested. League choice lives in each
tab's URL, so using FAM cannot change an open Gabagool tab.

## Current coverage

| Tool | Gabagool | FAM Sleeper | ESPN family |
|---|---|---|---|
| Draft board | League-specific | League-specific | League-specific manual draft |
| Weekly/start-sit | Live roster, own scoring | Live roster, own scoring | Not connected |
| Waiver research | FAAB budget guidance | Rolling priority, no dollar bids | Not connected |
| Existing trade calculator | Pre-draft only | Not supported | Not supported |

Unsupported tools do not silently switch to Gabagool. The trade calculator
is not an in-season trade evaluator even for Gabagool. All tools remain
read-only; managers submit changes in their platform.

Weekly payloads are isolated: `weekly.json` and `weekly-fam.json`. The scheduled
update generates both. Live league IDs, scoring, roster shape and season are
checked against the appropriate payload. Changing a label or league ID alone
does not make another league supported. Kickoffs and observed NFL workload
are league-independent shared data. The close-decision diagnostic remains a
modeled-Gabagool-scoring historical diagnostic, not a new FAM backtest.

## General-purpose direction (not implemented yet)

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
