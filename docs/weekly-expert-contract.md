# Weekly expert interface

Start/sit owns the diagnostic and browser consumer. Consensus ingestion owns
the source payload. Neither `rankings.py` nor `generate.py` was modified in
this increment. Claude CLI reviewed the existing source adapters read-only;
it confirmed the current normalizer does not retain projected FPTS.

## Browser payload: `site/data/weekly-ecr.json`

Required top-level fields: `schema_version: 1`, integer `season` and `week`,
`snapshot_at` (ISO timestamp), `source` (display label), `scoring_format`
(`ppr`, `half_ppr`, `standard`), and `players`.

Each player: exact GSIS `player_id`, `position`, positive numeric or null
`ecr` (POSITIONAL, lower is better), numeric or null `projected_fpts`.
Unknown fields must not be fabricated as zero. Unmatched identities must not
be joined by display name in the consumer. Duplicate identities reject the
payload. K/DEF references may be retained but no K/DEF lineup model is added.

Weekly page rejects mismatched season/week, missing provenance and snapshots
over seven days old or in the future. Optional-source failure does not break
the model table. Reference points do not change with the model scoring lens
and never enter the lineup optimizer. Positional ECR is not a cross-position
FLEX comparison. The payload is not yet generated or published.

## Historical diagnostic

`start_sit.py --baseline-json PATH` accepts a JSON array of canonical rows:
`season`, `week`, `position`, `player_id`, `snapshot_at`, `kickoff_at`, `ecr`,
`projected_fpts`. `kickoff_at` must be the first regular-season kickoff of the
NFL week, consistently across all rows. Timestamps must have explicit zones.
Date-only snapshots cannot prove an intraday cutoff and are excluded; a
source adapter must handle date precision conservatively, never invent a
capture time. Snapshots must precede kickoff and be at most seven days old.

Both entrants are compared on identical model-selected close-call pairs.
Missing expert values and expert ties are accounted for separately; actual
ties do not enter accuracy. Regret uses the diagnostic's existing realized
league-score subset. This does not make expert FPTS league-specific and does
not eliminate the existing played-player conditioning or dependent pairs.
No new measured accuracy claim has been produced from real historical data.

Validation: 41 targeted Python tests passed (start/sit and weekly consensus),
plus the new weekly-expert Node fixture. Browser integration has not yet been
verified with a real source payload. Source ingestion, canonical identity
mapping and the actual historical comparison run remain next steps.
