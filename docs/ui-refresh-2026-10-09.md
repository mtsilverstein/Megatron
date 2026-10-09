# UI refresh — 2026-10-09

## Coordination with Claude

Starting HEAD: `807a385`, on the existing weekly-accuracy workstream. The working
tree had no tracked edits when this UI work began. Existing untracked snapshots
and backtest files were left alone.

Claude's `docs/superpowers/plans/2026-10-06-weekly-accuracy-sameweek.md` explicitly
excludes `site/`. This work is isolated to frontend presentation and its browser
fixtures. No accuracy implementation, evidence artifact, model, scoring function,
generated JSON, workflow, spec, or `.claude/` file was modified. Tasks 6 onward in
Claude's plan are not implemented or signed off by this UI change. Nothing was
pushed or deployed.

## Changes

- Shared `site/assets/interface.css` presentation layer across all six pages:
  consistent system typography, quieter dark surfaces, spacing, controls, tables,
  active navigation, and responsive layout. Existing base styles remain intact.
- One navigation order: Weekly, Waivers, Trade, Draft, About. Existing league-aware
  URLs and unsupported-platform labels remain controlled by `app.js`.
- Compact full-width league/account controls rather than a narrow, wrapping
  middle column. Existing identity, viewer/owner, refresh and forget behavior stays.
- League discovery has two distinct cards: league link and Sleeper username.
  Its secondary shared account panel is collapsed by default in a native details
  element. It retains the Forget action; there is no second visible username form
  competing with discovery. This is the only shared-controller behavior change.
- Waivers has a direct title, short introduction, claim options and research
  sections. Long static method and signal explanations use native disclosures.
  Live warnings, coverage, source status, and bid limitations are retained.
- Weekly separates the start/sit plan from player projections. Method explanation
  is expandable; live evidence and unavailable-data messages stay visible.
- Trade keeps its existing modes; its in-season assumptions are expandable.
- All pages have a keyboard skip link and one page-level h1. Shared app cache
  version advanced to `league3` everywhere; new CSS uses `v=1`.

No recommendations, filters, storage keys, API calls, or projection values were
changed. The existing correction about the previous-week ECR comparison remains.

## Verification

- `git diff --check`: passed.
- Python site tests: 63 passed using `.venv/Scripts/python.exe -m pytest -W error
  -p no:cacheprovider tests/test_site_weekly.py tests/test_site_about.py
  tests/test_site_draft.py -q`.
- Node fixtures passed: `navigation`, `session`, `chip_session`, `connect`,
  `waivermode_session`, `startsitmode_session`, `waivers`, `waivermode_ros`,
  `waiverintel`, `seasontrademode`, `trademode`, `seasontrade` (each named
  `tests/<name>_fixture.cjs`).
- Added a regression check that discovery's collapsed account panel retains
  working Forget controls and does not duplicate on initialization.
- Updated the reserve-label assertion for its accessible hint. Updated the trade
  fixture's main-tag extraction to accept attributes; the skip-link target exposed
  its previous literal `<main>` assumption, not a missing production control.
- Independent agent reviewed the HTML/CSS diff and preservation of IDs/scripts.
- Local browser smoke test: all six pages inspected; mobile weekly, trade, draft,
  and about showed no document-level horizontal overflow at the tested narrow
  viewport. Wide tables remain scrollable inside their own containers.
- Tested FAM waiver team selection, navigation preserving FAM, and switching the
  waiver page to Gabagool and selecting a team there. No roster transaction was submitted.
- Gabagool's local preview correctly reports the existing weekly projections as
  over 72 hours old and withholds recommendation/bid advice. This is a data-refresh
  follow-up, not repaired by changing the UI. The warning remains prominent.

These are UI/regression checks, not a new accuracy evaluation or a full model
test-suite signoff. Local preview reads the existing published snapshots and live
Sleeper public league data; no snapshots were regenerated. Review the working
tree before staging and use explicit paths: unrelated private captures remain
untracked. Keep any eventual UI commit separate from Claude's accuracy tasks.
