# Weekly ECR reference contract

External projected FPTS is not an input, displayed reference, or diagnostic
benchmark. Our model owns league-scored points. Weekly ECR is an independent
reference; ROS is a separate horizon, not a weekly substitute or additive
trade currency. No paid source dependency is required.

## Browser payload

site/data/weekly-ecr.json requires schema_version 2, horizon weekly,
rank_scope position, integer season/week, snapshot_at, source,
scoring_format (ppr, half_ppr, standard), and players. Players contain exact
GSIS player_id, position, and positive or null ecr. The consumer discards
external points. Wrong horizon, scope, week, schema, duplicate identity or
stale data rejects the reference without changing the model lineup solver.

Date-only exports declare snapshot_precision date. Their filename date is
not a verified capture time. Current freshness uses the date's UTC start
conservatively. Historical evaluation rejects date-only timestamps.
Positional ranks cannot compare different positions for FLEX.

## Manual fallback

Run python -m ffmodel.site.weekly_experts with --scoring-format ppr,
--out site/data/weekly-ecr.json and QB/RB/WR/TE export paths. User confirmed
PPR for September 10 exports. Import ignores PROJ. FPTS entirely, including
missing or malformed values. Normalized name plus position joins reject
ambiguity and duplicate identities; unmatched players are reported.
Original exports remain unchanged. ECR-only payload has 612 mapped players.

## Historical diagnostic

start_sit.py --baseline-json PATH accepts canonical rows: season, week,
position, player_id, snapshot_at, kickoff_at, ecr. No FPTS required or used.
Cutoff is the first regular-season kickoff of the week, consistently across
rows. Snapshots need explicit timezones, must precede cutoff, and be no more
than seven days old. Duplicate identities fail closed.

Model and ECR use identical model-selected close-call pairs, with coverage,
baseline ties and actual ties reported separately. Regret uses the existing
realized league-score subset. Played-player conditioning and pair dependence
remain limitations; no new measured edge is claimed.

## Free automation investigation — September 12

Live nflreadpy.load_ff_rankings('week') returned 1,095 rows dated September
12, using NEW fields page, page_pos, fantasypros_id, player_name. It includes
explicit ppr-rb, ppr-wr, ppr-te, plus qb and other positions. The historical
page_type normalizer is incompatible. Ignore r2p_pts and other projection
fields. A safe live adapter still needs week/provenance validation; automatic
ROS coverage is not yet verified. Never label a current feed as an arbitrary
requested week.

rankings.py and generate.py remain untouched. No scheduled refresh has been
enabled in this increment.
