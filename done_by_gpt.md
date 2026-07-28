# Crosswalk repair hand-off (2026-07-28)

## Scope and safety

- Work is on local branch `fix/consensus-crosswalk-2026`, created from
  `main` at `107829f` (`docs: correct three overclaims in the weekly-ranking copy`).
- `main` has not been modified, nothing has been merged or pushed, and no
  deployment has been triggered by this work.
- The original 95% ECR-to-player-ID match-rate guard remains intact. This
  branch does not lower it or permit a partial consensus board.

## Incident reproduced

The manual GitHub Action draft refresh failed before writing any site data:

```text
ValueError: consensus crosswalk matched only 87.4% of 444 ranked players
(floor 95%)
```

Fresh public inputs, reproduced locally on 2026-07-28, yield exactly:

- consensus snapshot: `2026-07-24`,
  `/nfl/rankings/ppr-cheatsheets.php`
- 444 ranked QB/RB/WR/TE rows
- 378 matched by FantasyPros ID + 10 by name = 388/444 (87.4%)
- 56 unmatched players

The previous local cache (2026-07-21) matches 443/446 (99.3%), proving the
failure is live-provider drift rather than an old committed-data defect.

## Root cause

All 56 unmatched rows are 2026 drafted rookies. The current nflverse
`ff_playerids` feed still has their names, teams, PFR IDs, and draft metadata,
but has blank `gsis_id` values. The separate nflverse draft-picks feed has
the stable identifiers the project already uses for the same players. Example:

| Player | PFR ID | current playerids GSIS | draft-picks GSIS |
| --- | --- | --- | --- |
| Jeremiyah Love | `LoveJe00` | blank | `LOV121782` |
| Cade Klubnik | `KlubCa00` | blank | `KLU066027` |
| Carnell Tate | `TateCa00` | blank | `TAT143045` |

Those draft-picks IDs also appear in the 2026 rookie-board input, so this is
an identity-feed omission rather than a new or guessed mapping.

## Proposed repair on this branch

1. Preserve `pfr_player_id` in the normalized draft-picks whitelist. It is
   a draft-day source identifier, not a future outcome.
2. Before matching ECR, fill **only blank** `ff_playerids.gsis_id` rows from
   the draft-picks GSIS value, joined by exact PFR ID.
3. Refuse conflicting PFR-to-GSIS draft mappings. Existing nonblank player
   IDs remain authoritative and cannot be overwritten.
4. Reuse the draft-picks frame already fetched for the board run, so the
   repair adds no second external source or extra live download.
5. Record the number of restored IDs in consensus provenance as
   `gsis_backfilled_from_draft_picks`.

## Review checklist for Claude

- Confirm that draft-picks `gsis_id` is the intended canonical identity for
  current rookies while `ff_playerids.gsis_id` is blank.
- Confirm that retaining `pfr_player_id` conforms to the project’s
  draft-day-only data policy.
- Review the exact-PFR join and conflict refusal; no fuzzy matching is added.
- Run the targeted and full test suite, then reproduce the `--draft` action
  before deciding whether to merge.

## Live repair validation

After the repair, the same fresh 2026 provider data gives:

- 429/444 matched (96.6%), so the unchanged 95% guard passes.
- 64 blank playerids rows restored from draft-picks by exact PFR ID.
- 15 rows remain unmatched and are still explicitly counted by the guard:
  `Cash Jones`, `Colbie Young`, `De'Zhaun Stribling`, `Deion Burks`,
  `Devonte Boyd`, `Eli Heidenreich`, `Elijah Tau-Tolliver`, `J'Mari Taylor`,
  `Jaydn Ott`, `Michael Trigg`, `Myles Montgomery`, `Nicholas Singleton`,
  `Oscar Delp`, `Robert Henry Jr.`, and `Tommy Myers`.

The remaining rows have no usable GSIS ID in either current source; the
repair intentionally does not synthesize a consensus mapping for them.

## Tests run

- Targeted suite: `tests/test_rankings.py`, `tests/test_pull.py`, and
  `tests/test_generate.py` — **74 passed, 2 deselected**.
- Full non-integration suite was started but did not finish before the local
  65-second command limit. It produced no failure output before that timeout;
  Claude should run it in a normal development shell or CI before approving.

## Expected outcome

The live 2026 run can now pass the original safety threshold and allow the
existing fail-safe generator to produce the refreshed board. It does not
change the calibrated-band or flex-slot optimizer logic; it only makes the
current rookie ECR rows addressable.
