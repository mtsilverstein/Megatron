# League onboarding checkpoint — 2026-09-12

Implemented locally, not committed or deployed:

- `connect.html` and `assets/connect.js`: current-season public Sleeper
  username discovery, live settings inspection, configured league links,
  explicit unsupported state for other leagues, stale-request invalidation.
- Shared selector links to discovery; shared script cache versions bumped.
- Weekly generator exports additive full-precision `stat_quantiles`, including
  enriched pick-six expectations, plus schema metadata. Existing point fields
  are unchanged. Published JSON has not been regenerated in this checkpoint.
- `assets/league-scoring.js`: pure fail-closed linear scorer. It is deliberately
  not connected to generic advice yet. Unknown nonzero scoring (including
  bonuses and K/DST), missing stats and invalid weights are rejected.

Validation: 763 Python tests passed, 2 network integration tests deselected;
all 20 Node fixtures passed. Local browser discovery with Max973 returned FAM
FOOTBALL (rolling priority) and Gabagool Fools (FAAB), with correct URL links.
Editing the username cleared prior results. No roster mutations, claims,
credential handling or `.claude/` writes. Existing snapshots preserved.

Next: wire a custom-league weekly preview only after exact player-identity,
scoring capability, legal lineup slot, kickoff and freshness validation.
Regenerate weekly payloads before using the new raw-stat contract in browser
advice. Do not strip live scoring keys merely to pass the strict scorer;
unmodeled categories need explicit capability handling. Custom bands do not
inherit historical calibrated coverage. General waivers need league-valued
season projections; the existing trade calculator is still pre-draft only.

The September 10 weekly and ROS ranking snapshots are present but have not
been ingested or evaluated as part of this checkpoint.
