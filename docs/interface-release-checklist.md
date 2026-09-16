# Interface release checklist

Release scope: configured Sleeper weekly/start-sit and waiver tools, plus clearly
labeled draft tooling. A research prototype is not live trade advice. ESPN
in-season advice remains unsupported and must be labeled as such.

## Verified waiver work

- Removed the hard-coded Week 1 default. First load and automatic refresh resolve
  Sleeper's regular-season week; explicit numeric overrides remain available.
  Clear the week field to restore automatic selection.
- Added active-roster projection counts and named missing players. IR/taxi and
  K/DEF are excluded from skill coverage counts. Coverage is not an accuracy or
  availability guarantee.
- Removed contradictory preseason-proxy wording from in-season blocked results.
- Matched the weekly page's shared waiver-adapter cache version to the waiver page.
- September 15 local browser check: automatic Week 2 selection, Gabagool 13/13
  active skill players matched, 10 alternatives, and Week 1 usage displayed.
  This is not a mobile, accessibility, or all-page sign-off.

## Opus static audit and release priorities

1. Duplicate draft-board league chips versus shared selector: remove duplication.
2. Connect page has a different masthead and loses originating league context:
   standardize return routes while keeping explicit discovery-card destinations.
3. FAM/ESPN trade labels imply a Gabagool destination while retaining another
   league URL: clarify scope without silently switching leagues.
4. ESPN weekly/waiver links must disclose that those tools are not connected.
5. Keep shared script cache versions consistent across consuming pages.
6. Unknown league URLs fail before selector recovery; provide an explicit recovery
   flow in a subsequent pass without silently selecting a different league.
7. Review duplicated draft/keeper username entry and restored-session identity.
   The possible displayed-versus-restored username mismatch needs a focused test.
8. Review About's redundant league control and waiver header/source presentation.

Items 1–4 are assigned to Claude Sonnet in the bounded interface task. Opus's
audit was static, not proof that every reported visual symptom was reproduced.
One wordmark heading plus one page heading is not itself proof of duplicate
runtime headers; inspect the rendered layout before removing branding.

## Still required before full interface sign-off

- Browser round trips across supported leagues and connect, including multiple tabs.
- Explicit unsupported-tool and invalid-league recovery tests.
- Form refresh, automatic/manual week, filters, exports, and stale-session flows.
- Responsive layout and keyboard navigation; no full accessibility claim yet.
- Deployed build/CI verification after changes land.

No claims or bids are submitted in testing. Model accuracy, winning-bid
calibration, and general-purpose arbitrary-league support are separate release
claims, not consequences of passing interface tests.
