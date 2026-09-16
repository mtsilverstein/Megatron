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

September 16 follow-up: item 6 now renders explicit same-page recovery links
before rejecting the invalid league. Regression tests verify no fallback data
path and no duplicate panel. For item 7, static review confirms successful draft
restore sets the draft username field; the draft fixture passes. Divergent shared
and per-league storage plus keeper-field identity still need browser coverage.
The preceding release (30b28d9) passed CI and Pages deployment.
See interface-polish-plan.md for the bounded visual pass and acceptance checks.

Items 1–5 are implemented. Claude Sonnet handled the bounded navigation patch;
root reviewed it and aligned shared asset cache versions. Navigation, discovery,
and shared-asset fixtures pass. The 22 existing JavaScript fixtures passed before
the navigation patch; affected navigation/discovery fixtures passed again afterward.
Opus's
audit was static, not proof that every reported visual symptom was reproduced.
One wordmark heading plus one page heading is not itself proof of duplicate
runtime headers; inspect the rendered layout before removing branding.

## Still required before full interface sign-off

September 16 root browser check of deployed 645a523: Max973 Gabagool roster 9
and FAM roster 1 both loaded Week 2 with 13/13 skill coverage in separate tabs.
Gabagool weak rows and export withheld bids; FAM displayed rolling priority and
no positive swaps under default protections. Explicit Week 1 blocked advice;
FAM discovery round trip preserved its URL. Invalid-league recovery and ESPN
unsupported messaging were visible. At 390px, controls and warnings fit, but
the tall masthead/intro needs polish. Viewport restored afterward. This is not
a full keyboard audit or browser verification of the subsequent drop-cost patch.

September 16 hierarchy pass: all six mastheads put weekly/waivers first;
waiver alternatives precede research, provenance is collapsed but coverage stays
visible, and the league panel is more compact. Local browser verified Gabagool
Week 2, roster 9, 13/13 projection coverage and the reordered results. Static
hierarchy, navigation, waiver adapter and shared-asset fixtures pass.
Observed follow-up: alternatives with 0.09–0.11 point gains remained displayed
with $1–$3 bid heuristics. Weak-signal pass (September 16): any alternative
gaining under 1.0 projected point per week (fresh weekly gain, or proxy gain
divided by remaining weeks) is tagged `signal.strength = "weak"`, keeps its row
for research, and receives no FAAB range (`bid.low/high = null`, status "no bid
suggested") and, in rolling leagues, "research only: no priority claim
suggested" guidance that also tells the user to assess drop cost independently
(no optional free-agent move is suggested, since drop cost is unpriced). Every
row carries a `rosterCost` line stating that the dropped player's rest-of-season
value (or the open roster spot) is not priced. The 1.0-point cutoff is a
conservative product convention; it is not a validated noise or confidence
threshold and the text no longer claims sub-point gains *are* noise. Quantiles
are still not presented as claim-success probabilities. Table and export wording
come from the pure `WaiverMode.rowText` helper, which the waiver fixtures pin
for weak FAAB, modeled FAAB and weak rolling rows, including that a withheld
bid never renders as `$null–$null`. Not yet re-verified in a browser against
live Gabagool/FAM data.

Drop-cost gate (September 16, Opus release check; corrected after root
review): a modeled weekly gain cannot justify dropping a rostered player,
because rest-of-season value is unpriced, and a higher preseason board value
for the add is stale evidence of today's ROS cost, not a reason to approve the
drop. An earlier draft of this gate priced swaps where the add out-ranked the
drop on the preseason board (`consistent`); that selective gate was rejected
and removed. `Waivers.analyze` now attaches `dropCost` to every row with only
two states: `open_slot` (no drop required; the only rows that receive a bid
range or claim-order guidance) and `unassessed` (every alternative that
requires a drop, whatever the preseason board says about either player). No
preseason comparison fields or wording remain in the model, table, export,
or page copy. Unassessed rows keep their lineup gain and board value estimate
for research but get `bid.low/high = null`, tier `drop cost unassessed`,
status "no bid suggested: drop cost unassessed…", FAAB guidance "no bid
suggested; the dropped player's rest-of-season cost is not priced, so assess
the drop cost independently…", and in rolling leagues "research only: no
priority claim suggested; …" instead of "Set claim order in Sleeper". The
wording does not say the swap is wrong or recommend any drop, and no
calibrated edge is implied. Precedence is unchanged: an unaffordable minimum
bid reports as such first, then weak-signal wording, then the drop gate.
Fixtures pin: an add valued 60 on the preseason board against a drop valued 7
is still withheld in FAAB and in rolling; every required-drop row on the
fixture roster is withheld; weak-signal and affordability precedence; and a
strong open-slot add keeps its heuristic (FAAB `impact` range, rolling "Set
claim order in Sleeper"). `rowText` fixtures pin that withheld rows never
print dollars, `null`, "modeled", or "preseason", and the priced `rowText`
case is now an open-slot row. Cache versions bumped to
`waivers.js?v=dropcost2` and `waivermode.js?v=dropcost2` on waivers.html and
weekly.html. Re-run after the correction: waivers, waivermode, shared_assets
and interface_hierarchy fixtures pass.

Evidence provenance for this gate, kept separate: (a) root's local browser
verification covers Max973's own rosters (Gabagool week 2, roster 9; see the
hierarchy pass above) and is the only browser/mobile evidence; nothing in this
check re-ran it against the corrected gate. (b) The Opus check's own evidence
was a static, read-only Sleeper API sampling of rosters other than Max973's,
run under the earlier selective gate: Gabagool week 2 produced 26 rows, all
already weak; FAM week 2 produced 120 rows (100 weak, 12 gated, 8 priced);
Gabagool roster 3 failed closed with "1 owned player(s) missing from board"
(pre-existing). Those 12/8 counts are superseded — under the corrected gate
all 20 non-weak FAM rows require a drop and would be withheld — and the
sampling was not re-run after the correction. Browser verification of the
corrected wording against live Gabagool/FAM data is still pending and is
root's to perform.

Mobile masthead and final UI check (September 16, Opus; root reviews): local
browser at 390×844 measured the waivers masthead at 262px tall (five links on
three rows plus stamp; league panel ended at 460px; username form began at
840px, off the first screen). CSS-only fix inside the existing 560px media
block: tighter masthead row gaps and padding, wordmark 1.15rem, nav gap
.15rem/.7rem at .82rem, stamp .7rem, league panel padding .6rem/.8rem, h1
1.55rem. Nothing is hidden and no controls were added: every link, its
"· Gabagool only"/"· not connected" suffix, the active-page marker, the
league URL and the stamp remain visible; links wrap rather than scroll.
Measured afterwards at 390px on all six pages: masthead 159px (two nav rows)
or 185px (three rows for FAM/ESPN suffixes), league panel ends 303–399px, no
horizontal overflow, and the waiver username form starts at 653px. Desktop
computed values unchanged (nav 15.2px, wordmark 21.6px, h1 32px, one row).
`style.css?v=mobile1` on all six pages; waivers.html wordmark now carries the
logo like the other five. Screenshots: `.review/shots/before-waivers-390.png`,
`after-waivers-390.png`, `after-weekly-espn-390.png`, `after-index-fam-390.png`.

Drop-cost gate, live read-only browser check of the corrected wording
(local build, Max973, separate tabs): Gabagool week 2, roster 9, 13/13
coverage, 10 alternatives — all weak-signal (precedence over the drop gate),
table and export print "no bid suggested…" and the rosterCost line, no `$`,
`null`, "modeled FAAB" or "preseason" in any ADD row; the FAAB header still
reports Remaining/reserve/spendable dollars, as intended. FAM week 2, roster
1, 13/13 coverage, rolling priority 2, zero positive swaps under default
protections; export has no bid lines. The Gabagool tab kept `?league=gabagool`
while FAM loaded. Consequence: Max973's own rosters never produce a
non-weak required-drop row, so the "drop cost unassessed" wording itself is
still only fixture-verified, not observed live. Also observed: the Gabagool
snapshot expired after a few minutes, hiding results with "Roster snapshot
expired. Refresh…" (designed stale-session behaviour; refresh restored them).
Pre-existing, out of scope: the export's research `USAGE` lines serialize raw
JSON including `"targets":null` when no prior-week baseline exists.

Keyboard/accessibility: the browser tool refused synthetic key presses, so
this is NOT a real Tab-key traversal. Instead, sequential-focus candidates
were enumerated in DOM order and each was focused programmatically on the
loaded waivers (24 stops), weekly (24, incl. filter chips with aria-pressed
and sortable headers with tabindex + Enter/Space), draft board (roving row
tabindex, arrow keys), trade, about and connect pages; every stop accepted
focus and order matched the visual order. One concrete defect fixed:
`#trade-user`, `#draft-username`, `#draft-id-input` and the four keeper
inputs had placeholder-only accessible names, and the shared username
auto-fill hides that placeholder (draft-username loaded with "Max973"); each
now carries an `aria-label`. No controller changes. New static regressions:
every non-checkbox input on the six pages must have an aria-label, wrapping
<label> or label[for] (fails against the pre-change tree); the mobile
masthead block must not hide or scroll the nav or hide the stamp; style.css
cache versions must match across pages. All 24 JavaScript fixtures pass.
Still pending for root: real keyboard traversal (Tab/Enter/Space/arrow) with
visible focus rings on links and buttons, and a deployed-build check.

Final pre-push check (September 16, Opus; root reviews):

- Non-weak required-drop wording, observed in the real waivers controller
  (table and export) against a **clearly labeled synthetic ownership fixture**,
  because Max973's live rosters cannot produce that row. Local build,
  `waivers.html?league=gabagool`, real committed `data/draft.json`,
  `data/weekly.json` (week 2, generated 2026-09-16) and `data/kickoffs.json`;
  only the Sleeper side was stubbed in-page (`window.Sleeper.get` replaced
  before submit: league `SYNTHETIC FIXTURE (not live)` with the real Gabagool
  id/scoring/slots, 12 synthetic rosters, user `synthetic-fixture`, catalog
  built from the board, trending refused). No request reached Sleeper and
  no league was mutated; the page carried a red "SYNTHETIC OWNERSHIP FIXTURE"
  banner. Roster 1 held mid-ranked starters, five near-zero bench players and
  a full 15-man roster, so every alternative required a drop. FAAB
  (`waiver_type 2`, $70 remaining): 40 displayed rows, all `+8.79 pts · drop
  cost unassessed`, claim guidance "no bid suggested: drop cost unassessed,
  rest-of-season value is not priced", why-column tier `drop cost unassessed`
  plus the rosterCost and dropCost notes; summary line "40 require a drop
  whose rest-of-season cost is not priced…"; warnings counted 165 weak and
  355 unassessed alternatives; no `$`, `null`, "modeled FAAB" or "preseason"
  in any row; the header still shows Remaining/reserve/spendable. Export: 40
  `ADD …; DROP COST UNASSESSED; no bid suggested: drop cost unassessed…`
  lines, no dollars, details opened and textarea focused. Rolling
  (`waiver_type 0`, same world): reserve field hidden, tiles "Rolling
  priority 1 / Rank claims", every row "No priority claim suggested" with the
  "research only… rest-of-season cost is not priced" guidance, no "Set claim
  order in Sleeper", export header "Current rolling priority 1; rank claims
  in Sleeper" and all ADD lines `DROP COST UNASSESSED; research only…`.
  Screenshots: `.review/shots/synthetic-dropcost-faab-table.png`,
  `synthetic-dropcost-rolling-table.png`. This is fixture-driven evidence
  that the shipped controller renders the gate; it is not live-league data.
- Keyboard: the browser integration denied a real Tab key press; per the
  brief no alternate automation was used. Source check only: one global
  `:focus-visible { outline: 2px solid var(--te); outline-offset: 2px }`
  (`style.css:42`) and no `outline` override anywhere in `site/assets/*.css`.
  Real Tab/Enter/Space/arrow traversal with visible rings remains pending
  for root.
- No UI defects found in this pass; no code changed. All 24 JavaScript
  fixtures pass (waivers, waivermode, shared_assets, interface_hierarchy,
  navigation, connect re-run individually). Deployed-build check follows
  the push.

- Browser round trips across supported leagues and connect, including multiple tabs.
- Explicit unsupported-tool and invalid-league recovery tests.
- Form refresh, automatic/manual week, filters, exports, and stale-session flows.
- Responsive layout and keyboard navigation; no full accessibility claim yet.
- Deployed build/CI verification after changes land.

No claims or bids are submitted in testing. Model accuracy, winning-bid
calibration, and general-purpose arbitrary-league support are separate release
claims, not consequences of passing interface tests.
