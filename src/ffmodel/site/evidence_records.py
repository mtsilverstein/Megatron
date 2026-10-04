"""Scoped evidence records: `neutral/evaluation.json` (spec 2026-10-01 §3.2, §8.9).

A measured number is a claim about TODAY's output only when the scoring it was
actually measured under and the method that produced it both match exactly.
Each record therefore separates:

- `source_settings` - the league whose settings the run was given (provenance
  only, never matched on);
- `effective_scoring` - the evidence identity (`leaguelens.evidence_identity`)
  of the weights applied to REALIZED outcomes;
- `prediction_scoring` - the identity of the weights applied to the FORECAST;
- `omitted` - every zeroed or unscored component, with the reason;
- `method` - the `ffmodel.site.method.current_method` shape, or `null` when
  the source does not record every field (null never matches; historical only).

Every field below is read from the committed source artifact. Nothing about an
old measurement is inferred from today's code constants.

Findings per source (read 2026-10-04)
-------------------------------------
1. Rest-of-season MAE - `models/diagnostics/remaining_matrix_gabagool.json`
   (diagnostic `remaining_matrix`; seasons 2023-2025 x origins 5, 9 x horizons
   1, 2, 4, 8 = 6 origin reports, 24 horizon reports).
   - All 24 horizon reports carry `pick_six_evaluated: false`, and every origin
     report's `scoring_scope` reads "pick-six costs excluded from BOTH sides
     when actual counts are unavailable". So BOTH the realized and the
     forecast scoring are Gabagool's with `pass_int_td` = 0: `effective_scoring
     == prediction_scoring`, and neither matches today's pick-six-inclusive
     Gabagool lens. Omitted: `pass_int_td` ("pick-six actuals unavailable") and
     each key of the file's `unprojected_scoring` ("Predicted stat components
     only").
   - Scoring weights: the reports' internal `league.scoring` (translated with
     `INTERNAL_TO_SLEEPER`), cross-checked against the same file's
     `league.sleeper_scoring`.
   - Method: the file records `artifact_roots` (v1, v1_s43, v1_s44, as Windows
     paths) but neither a band construction nor a pick-six prior (the prior
     was off, see above), nor the ensemble rule -> `method: null`.
   - No FAM record: no FAM matrix is committed, and Gabagool's numbers are
     never borrowed for another league.
2. Close start/sit calls - `site/data/start_sit_evaluation.json`
   (experiment `close-start-sit-decisions`, seasons 2023-2025, folds
   through2022-through2024, the 56.3% weekly-page line).
   - `scoring` uses internal names: name, pass_yd, pass_td, interception,
     pass_int_td, rush_yd, rush_td, rec_yd, rec_td, reception, fumble_lost,
     two_point, st_td. `name` is metadata; the rest are translated by
     `INTERNAL_TO_SLEEPER` (an unmapped key raises).
   - `scoring_coverage.prediction_pick_sixes`: the forecast applied the pooled
     expected-cost prior, so `prediction_scoring` keeps `pass_int_td` = -3.
     `scoring_coverage.actual_pick_sixes`: realized penalties are zero, so
     `effective_scoring` has `pass_int_td` = 0 ("actual pick-six penalties
     unavailable"). The three 50+ yard TD bonuses listed in
     `scoring_coverage.omitted` are disclosed by key; `two_point`/`st_td` are
     unprojected and outside the evidence normalization.
   - Method: three DIFFERENT per-season priors (`pick_six_forecast_priors`,
     through 2022/2023/2024) and no recorded band construction -> `method:
     null` (historical only).
3. Band calibration (~80%) - weekly.html footer "calibrated per position so
   roughly 80% of actual player-weeks land inside the band (measured on
   2023-2025 held-out seasons)". Traced via about.html's calibration section
   (`site/data/about.json` -> `reports[source=bakeoff.json]`) to
   `models/backtests/bakeoff.json`: OVERALL transformer `coverage_p10_p90`
   0.819 / 0.792 / 0.795 for 2023 / 2024 / 2025. That artifact records
   `band_construction: "sign_coherent_v1"` and `transformer_roots`, but its
   scoring only as the ruleset NAME `"ppr"` - no weights, no pick-six handling,
   and not whether the per-position `calibration.json` scale factors were
   applied. The weights behind "ppr" can only be read from today's
   `ffmodel.scoring.PPR` constant, which is exactly the inference this module
   refuses. NO RECORD is emitted; the calibration line is never a
   current-output claim. (`board_backtest.json` / `about.json.season_bands`,
   the other band-coverage numbers, likewise record only `scoring: "ppr"`.)
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from ffmodel.site.leaguelens import effective_weights, evidence_identity

SCHEMA_VERSION = 1
KIND = "neutral_evaluation"

ROS_SOURCE = "models/diagnostics/remaining_matrix_gabagool.json"
CLOSE_CALL_SOURCE = "site/data/start_sit_evaluation.json"

# Internal `ScoringRules` field -> Sleeper scoring key (leaguelens.KEYS).
# None = an event the model has no head for; it is outside the evidence
# normalization and must be disclosed in `omitted` by the caller.
INTERNAL_TO_SLEEPER = {
    "pass_yd": "pass_yd", "pass_td": "pass_td", "interception": "pass_int",
    "pass_int_td": "pass_int_td", "rush_yd": "rush_yd", "rush_td": "rush_td",
    "rec_yd": "rec_yd", "rec_td": "rec_td", "reception": "rec", "fumble_lost": "fum_lost",
    "two_point": None, "st_td": None,
}
# start_sit_evaluation.json lists its omitted bonuses in prose.
OMITTED_PROSE_TO_KEY = {
    "50+ yard passing TD bonus": "pass_td_50p",
    "50+ yard rushing TD bonus": "rush_td_50p",
    "50+ yard receiving TD bonus": "rec_td_50p",
}


def translate_internal_scoring(scoring: dict) -> tuple[dict, list[str]]:
    """(Sleeper-keyed weights, internal keys with no projection head).

    Raises on any key outside `INTERNAL_TO_SLEEPER` rather than dropping it."""
    unmapped = sorted(k for k in scoring if k not in INTERNAL_TO_SLEEPER)
    if unmapped:
        raise ValueError(f"unmapped internal scoring key(s): {unmapped}")
    out, unprojected = {}, []
    for k, v in scoring.items():
        target = INTERNAL_TO_SLEEPER[k]
        if target is None:
            if v:
                unprojected.append(k)
        else:
            out[target] = v
    return out, unprojected


def _identity(sleeper_scoring: dict) -> str:
    return evidence_identity(effective_weights(sleeper_scoring))


def _committed_sha256(path: Path) -> str:
    """sha256 of the committed (LF) bytes: a Windows autocrlf checkout and the
    Linux runner must name the same artifact."""
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def _load(root: Path, rel: str) -> tuple[dict, dict]:
    path = root / rel
    return json.loads(path.read_text(encoding="utf-8")), {"path": rel, "sha256": _committed_sha256(path)}


def _ros_record(root: Path) -> dict:
    data, source = _load(root, ROS_SOURCE)
    if data.get("diagnostic") != "remaining_matrix":
        raise ValueError(f"{ROS_SOURCE}: not a remaining_matrix diagnostic")
    origins = data["reports"]
    if len(origins) != len(data["seasons"]) * len(data["origins"]):
        raise ValueError(f"{ROS_SOURCE}: origin report count disagrees with seasons x origins")
    horizon_reports = [h for o in origins for h in o["reports"]]
    if len(horizon_reports) != len(origins) * len(data["horizons"]):
        raise ValueError(f"{ROS_SOURCE}: horizon report count disagrees with horizons")
    if any(h.get("pick_six_evaluated") is not False for h in horizon_reports):
        raise ValueError(f"{ROS_SOURCE}: a report evaluated pick-sixes; re-read its scope")
    league, scope = origins[0]["league"], origins[0]["scoring_scope"]
    if any(o["league"] != league or o["scoring_scope"] != scope for o in origins):
        raise ValueError(f"{ROS_SOURCE}: origin reports disagree on league or scoring scope")
    if "excluded from BOTH sides" not in scope:
        raise ValueError(f"{ROS_SOURCE}: scoring scope no longer says pick-six is excluded from both sides")
    weights, _ = translate_internal_scoring(league["scoring"])
    measured = {**weights, "pass_int_td": 0}
    if effective_weights(measured) != effective_weights({**league["sleeper_scoring"], "pass_int_td": 0}):
        raise ValueError(f"{ROS_SOURCE}: internal scoring disagrees with its sleeper_scoring")
    identity = _identity(measured)
    omitted = [{"key": "pass_int_td", "reason": "pick-six actuals unavailable"}]
    omitted += [{"key": k, "reason": "no projection head; predicted stat components only"}
                for k in league.get("unprojected_scoring", {}) if k != "pass_int_td"]
    return {
        "id": "ros_mae_gabagool",
        "metric": "rest_of_season_points_mae",
        "source": source,
        "source_settings": {"league": league["name"], "scoring": league["sleeper_scoring"]},
        "effective_scoring": identity,
        "prediction_scoring": identity,
        "omitted": omitted,
        "method": None,
        "population": {"seasons": data["seasons"], "origin_weeks": data["origins"],
                       "baseline": origins[0]["baseline"], "comparison": origins[0]["comparison"],
                       "scoring_scope": scope,
                       "limitations": origins[0]["limitations"] + [data["limitation"]]},
        "horizon": {"unit": "weeks_ahead", "weeks_ahead": data["horizons"]},
        "values": data["summary"],
    }


def _close_call_record(root: Path) -> dict:
    data, source = _load(root, CLOSE_CALL_SOURCE)
    if data.get("experiment") != "close-start-sit-decisions":
        raise ValueError(f"{CLOSE_CALL_SOURCE}: not the close start/sit experiment")
    scoring = dict(data["scoring"])
    league_name = scoring.pop("name")
    coverage = data["scoring_coverage"]
    if "expected-cost" not in coverage["prediction_pick_sixes"]:
        raise ValueError(f"{CLOSE_CALL_SOURCE}: forecast pick-six handling changed; re-read it")
    if "zero" not in coverage["actual_pick_sixes"]:
        raise ValueError(f"{CLOSE_CALL_SOURCE}: realized pick-six handling changed; re-read it")
    unknown_prose = [p for p in coverage["omitted"] if p not in OMITTED_PROSE_TO_KEY]
    if unknown_prose:
        raise ValueError(f"{CLOSE_CALL_SOURCE}: unmapped omitted component(s) {unknown_prose}")
    weights, unprojected = translate_internal_scoring(scoring)
    omitted = [{"key": "pass_int_td", "reason": "actual pick-six penalties unavailable"}]
    omitted += [{"key": OMITTED_PROSE_TO_KEY[p], "reason": "not modeled; omitted from the evaluation"}
                for p in coverage["omitted"]]
    omitted += [{"key": k, "reason": "no projection head; outside the evidence normalization"}
                for k in unprojected]
    return {
        "id": "start_sit_close_calls",
        "metric": "close_start_sit_choice_accuracy",
        "source": source,
        "source_settings": {"league": league_name, "scoring": data["scoring"]},
        "effective_scoring": _identity({**weights, "pass_int_td": 0}),
        "prediction_scoring": _identity(weights),
        "omitted": omitted,
        "method": None,
        "population": {"seasons": data["seasons"], "conditioning": data["conditioning"],
                       "pair_universe": data["pair_universe"], "scope_note": data["scope_note"],
                       "scoring_coverage": coverage["label"]},
        "horizon": {"unit": "single_week", "test_seasons": data["seasons"],
                    "folds": data["artifacts"]["folds"]},
        "values": {k: data[k] for k in ("overall", "by_position", "week_1")},
    }


def build_evaluation(ctx, *, root: Path = Path(".")) -> dict:
    """`neutral/evaluation.json` for one batch. `root` is the repo root."""
    root = Path(root)
    return {**ctx.header(), "schema_version": SCHEMA_VERSION, "kind": KIND,
            "records": [_ros_record(root), _close_call_record(root)]}
