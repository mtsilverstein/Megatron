# Consensus-anchored draft board + keeper gauge — design

**Date:** 2026-07-25
**Status:** approved design, pre-implementation
**Related:** `docs/methodology.md` (the measured basis for this change),
`models/diagnostics/consensus_benchmark.json`, `models/diagnostics/rb_oos_weekly.json`

## 1. Context & goal

Three independent benchmarks established that the model's *own* season-long
draft ranking loses to both expert consensus (ECR 60.5% vs model 53.9%) and the
crowd (ADP 57.2% vs model 52.6%), and that the model's deviations from ADP are
wrong ~57% of the time. The model's genuine, measured strengths are (a)
calibrated floor/ceiling **bands**, which ECR/ADP do not provide, and (b) a
weekly running-back edge (in-season, not draft).

The goal is the best realistic **draft-day** edge in the user's league. That
edge is *not* a better ranking — it is drafting on the most accurate available
ranking (ECR) while the leaguemates draft on a noisier one (ADP), with the
model's bands, tiers, VORP, and VONA as a risk + decision overlay the crowd
lacks — plus a keeper-value gauge on the same spine.

This is the product finally embodying the methodology's own conclusion: *use
the board as a calibrated, banded view of consensus, not a contrarian oracle.*

## 2. Decisions (locked during brainstorming)

- **Ranking spine = ECR** (FantasyPros redraft-overall consensus, single-QB).
  ECR is the more accurate value estimate; it decides the order.
- **ADP = FantasyFootballCalculator PPR 12-team JSON** — the market/timing
  overlay and keeper reference. Sleeper has no clean public ADP endpoint; the
  live "who's gone" already comes from the Sleeper draft picks draft-mode polls,
  so ADP is only the pre-draft timing prior. Generic PPR ADP is a tight proxy.
- **Magnitude fusion = Approach ①:** ECR sets the order; the model's projected
  points curve sets the gaps; the model's per-player p10/p90 sets the bands.
- **The model's own ranking opinion is hidden** — no "our take says reach here"
  prompt, because that opinion is the measured-losing signal.
- **League:** 12-team, 1-QB, full PPR; starters QB / 2 RB / 2 WR / 1 TE /
  2 FLEX / 1 K / 1 D-ST. Two flex spots deepen RB/WR/TE replacement levels.
- **Keeper rules:** up to 2 keepers; cost = one round *earlier* (costlier) than
  last year's draft round; players drafted in rounds 1–2 are ineligible;
  waiver/undrafted keeper cost = round 12 (flat). Keeper input is **manual**.

## 3. Non-goals / scope boundaries

- **K and D-ST are out of scope** (QB/RB/WR/TE-only is a hard v1 invariant).
  The board will not rank them; the user drafts those late off Sleeper's default.
- **Superflex is N/A** (single-QB league) — the standard overall ECR is correct.
- **The weekly view is untouched.** This is a draft-board change only.
- **No Sleeper auto-fill for keepers** in v1 (manual entry chosen); a
  `previous_league_id` auto-pull is a possible later enhancement, not built now.
- **No new paid infrastructure**; ECR and ADP are the two free APIs.

## 4. Architecture & components

| Unit | Status | Responsibility |
|---|---|---|
| `src/ffmodel/data/adp.py` | new | Pull FFCalculator PPR ADP (12-team), crosswalk to `gsis_id` via `norm()` + nickname map (promoted from scratchpad `adp_headtohead.py`). Returns `player_id, name, position, adp, stdev, times_drafted`. |
| `src/ffmodel/data/rankings.py` | exists | ECR via `consensus_for_season` — leak-safe pre-kickoff snapshot. |
| `src/ffmodel/site/board_rank.py` | new (extracted) | The fusion: ECR order → model points-curve remap → `value_points`/VORP/tiers; flex-aware replacement; attach `adp`/`adp_round`; unranked tail. Pure, unit-tested. |
| `src/ffmodel/site/draft.py` | modified | `build_draft_board` calls `board_rank` instead of ordering by model VORP; board JSON gains `ecr`, `adp`, `adp_round`. |
| `src/ffmodel/site/generate.py` | modified | The `--draft` path additionally pulls ECR + ADP and passes them to the board build. |
| draft board page (`site/index.html` + assets) | modified | Show ADP alongside board rank; **hide** the model's ranking opinion. |
| `site/assets/keepers.js` + pure keeper-math module | new | Manual keeper panel in draft mode; surplus math (node-fixture tested, the VONA precedent). |
| about page + `docs/methodology.md` | modified | Disclose consensus-anchored ranking; keeper tool = ADP surplus. |

Each unit has one responsibility and a testable interface. `board_rank.py` is
extracted (rather than inlined in `draft.py`) so the fusion math is unit-tested
in isolation and `draft.py` stays a thin assembler.

## 5. Data flow (`generate --draft`)

```
model predictions  ─┐   (p50 season points  +  p10/p90 bands, per player)
ECR (rankings.py)  ─┼─► board_rank.fuse ─► board JSON (committed)
ADP (adp.py)       ─┘        │
                            ▼
        site renders ─► draft mode: live Sleeper strike + keeper panel (client-side)
```

No backend. The weekly cron (`--week`) is not on this path. ECR/ADP are pulled
only in the `--draft` generation.

## 6. The fusion (`board_rank.py`), per position (QB/RB/WR/TE)

1. **Order by ECR.** Players carrying an ECR value, sorted ascending
   (lower = better) → `position_rank`. This is the entire ranking decision.
2. **Value-curve remap.** Sort the model's p50 projected **season** points for
   that position descending; lay them onto the ECR order — ECR-#1 gets the
   highest model points, #2 the next, etc. → `value_points`. The order is
   ECR's; the gaps are the model's scarcity structure. This keeps VORP monotone
   with the sort and suppresses the model's per-player ranking opinion.
3. **Flex-aware replacement + VORP.** `VORP = value_points − value_points at the
   replacement rank`. Replacement is *derived*, not guessed: every team fills its
   dedicated slots (12 QB / 24 RB / 24 WR / 12 TE league-wide), then the 24 flex
   spots go to the best remaining players by ECR across RB/WR/TE — so the flex
   split falls out of the rankings. Replacement rank = (dedicated + flex started)
   + 1 per position. This only affects cross-position interleaving and the
   tier-pool size; it never reorders players within a position (that is pure ECR).
4. **Tiers** — existing `_assign_tiers` on the fused VORP, unchanged.
5. **Bands** — each player's own model p10/p90 → floor/ceiling points, unchanged.
   The model's genuine per-player contribution.
6. **Overall board** sorted by VORP desc across positions (existing mechanism),
   so cross-position order is driven by the ECR-anchored fused value.
7. **Unranked tail.** Players past FantasyPros' list sort *after* all ECR'd
   players within their position, ordered by model points; tiers do not extend
   there. ECR covers the ~180-pick draftable universe; the tail is depth.
8. **ADP attach.** Each player gets `adp` (overall pick) and
   `adp_round = ceil(adp / 12)`. Optional light market cue in the UI (show ADP
   next to board rank so the user sees when the *market* takes someone — this is
   ECR-vs-ADP, not the model). Cuttable for time.

VONA (already in draft mode) inherits the fused value curve for free — it now
measures value-over-next-available on the consensus-anchored scale.

## 7. Keeper gauge (`keepers.js` + pure math)

Manual panel in draft mode. The user adds candidate players (from the board) and
enters, for each, the round drafted last year — or marks "waiver".

- **Cost round** = `drafted_round − 1` (costlier). Waiver → `12` (flat).
- **Eligibility:** `drafted_round ≤ 2` → ineligible; shown greyed with the reason.
- **Value round** = `adp_round` (fallback: player's overall board rank → round =
  `ceil(overall_rank / 12)` when ADP is missing).
- **Surplus** = `cost_round − value_round`. A now-round-3 player kept for a
  round-7 pick = **+4 rounds**. Candidates are sorted by surplus; the best two
  (the ones to keep) are highlighted.
- Fully client-side; reads the board JSON's `adp`. No Sleeper call for this piece.

Keeper and live board share the value spine, so they never disagree.

## 8. Failure & leak safety

- **ECR is the spine → required.** If no pre-kickoff snapshot exists, or the
  crosswalk falls below `MIN_MATCH_RATE`, `board_rank` raises and the draft-board
  regen aborts without touching published JSON (the standing fail-safe).
- **ADP is an overlay → best-effort.** If the ADP pull fails, the board still
  builds; the market cue is omitted and the keeper tool falls back to board-rank
  rounds. This degradation is visible (a "data as of" / "ADP unavailable" note),
  never silent.
- **Leak discipline:** ECR's strictly-before-kickoff snapshot is already enforced
  ([rankings.py:94](../../../src/ffmodel/data/rankings.py#L94)); ADP is pre-draft
  by construction.

## 9. Testing

Concentrated on the leak-/math-prone pure functions (project philosophy):

- `board_rank.py`: ECR ordering; remap monotonicity (`value_points`
  non-increasing down the ECR order); flex-replacement VORP; unranked-tail
  placement (non-ECR after ECR); `adp_round = ceil(adp/12)`.
- `data/adp.py`: crosswalk match rate on a fixture (norm + nickname map);
  missing-ADP handling.
- keeper math (JS, node fixtures like the VONA tests): `cost = round − 1`;
  waiver = 12; rounds 1–2 ineligible; surplus; best-2 selection.
- site-JSON **schema** test updated for the new `ecr` / `adp` / `adp_round`
  fields.
- Full suite stays `PYTHONPATH=src`, `-W error`.

## 10. Honesty / disclosure

The about page and `docs/methodology.md` state plainly that the board's ranking
is **consensus-anchored** (ECR order), that the model supplies the floor/ceiling
bands and the value curve, and that this design follows *because* the model's own
ranking was measured to lose to ECR/ADP. The keeper tool is disclosed as an
ADP-surplus calculator. No claim that the board out-ranks the experts.

## 11. Open / tunable knobs (documented, not blocking)

- The league config (`LEAGUE_DEDICATED` / `LEAGUE_FLEX_SLOTS`) that feeds the
  derived replacement — set to this league's 12-team, 2-flex shape; ordering
  within a position is unaffected by it, only cross-position balance.
- The optional ADP market cue in the UI — ship or cut for time.
- Sleeper `previous_league_id` keeper auto-fill — a later enhancement.

## 12. Sequencing

1. **ADP infrastructure** (`data/adp.py`) + tests.
2. **Fusion** (`board_rank.py`) + tests; wire into `draft.py` / `generate.py`;
   regenerate the committed 2026 board; schema test.
3. **Site**: ADP display + hide model rank + about/methodology copy.
4. **Keeper gauge** (`keepers.js` + math) — depends on the board carrying ADP.

The board core (1–3) ships first; the keeper gauge (4) is a bolt-on that reads
the finished board.
