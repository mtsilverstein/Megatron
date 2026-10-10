"""Pre-registered same-week re-measurement of the weekly expert benchmark (spec §5-§6).

Run once by hand: .venv/Scripts/python.exe -m ffmodel.eval.weekly_consensus_sameweek
Verdicts are computed here from the numbers; nothing in §3/§5/§6 may change in response to a result (Rule 4).
A negative mean model Spearman is an alarm (§3.9): the artifact carries no verdict until the operator's audit
record is supplied with --alarm-audited.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import pandas as pd

from ffmodel.eval import live_accuracy as la
from ffmodel.eval import sameweek as sw
from ffmodel.eval.splits import walk_forward_splits
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

PROTOCOL_VERSION = "sameweek-v1"
DISCOVERY = [2023, 2024, 2025]
REPLICATION = [2020, 2021, 2022]
SPEC = "docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md"
FOLD_FILES = ("model.pt", "config.yaml", "scaler.json", "calibration.json", "metrics.json")
AUDIT_FIXTURES = ('pytest tests/test_sameweek_gate.py tests/test_sameweek_validation.py '
                  'tests/test_sameweek_selection.py -k "sign or identity"')


def run_sample(prep: sw.Prepared, rankings: pd.DataFrame, crosswalk: pd.DataFrame, seasons: list[int],
               predict_season) -> dict:
    """One sample through stage 2, same-week selection and cells. `prep` is sw.prepare over the raw tables, so
    the model sees the de-duplicated, unmasked feature input and scoring sees only validated rows."""
    cells, weeks_prov, audit, target_weeks = [], [], [], {}
    for season, train_idx, test_idx in walk_forward_splits(prep.features, seasons):
        train, test = prep.features.loc[train_idx], prep.features.loc[test_idx]
        our = predict_season(season, train, test)
        dates = prep.schedule.dates(season)              # a week whose schedule slice fails has no K_N/Z_N
        weeks = sorted(int(w) for w in prep.schedule.games.loc[prep.schedule.games["season"] == season, "week"].unique())
        target_weeks[int(season)] = weeks
        for week in weeks:
            if week not in dates:
                sched_report = prep.schedule.week_validation(season, week).report()
                weeks_prov.append({"season": int(season), "week": week, "status": "skipped",
                                   "reason": "validation_failed", "detail": "schedule_dependency_failed",
                                   "input_validation": {"schedule": sched_report}})
                continue
            audit.append({"season": int(season), **sw.staleness_audit_week(rankings, prep.schedule, season, week,
                                                                           dates)})
            wi = sw.week_inputs(prep, season, week)
            if wi["failed"]:
                weeks_prov.append({"season": int(season), "week": week, "status": "skipped",
                                   "reason": "validation_failed", "validation": wi["report"]})
                continue
            ok = wi["actuals"].valid
            played = pd.DataFrame({"player_id": ok["player_id"].to_numpy(), "position": ok["position"].to_numpy(),
                                   "team": ok["team"].to_numpy(), "our_pts": our.loc[ok.index].to_numpy(dtype=float),
                                   "actual": fantasy_points(ok[PREDICTED_STATS], PPR).to_numpy()})
            res = sw.sameweek_week(played, prep.schedule, rankings, crosswalk, season, week, dates)
            cells += res["cells"]
            weeks_prov.append({"season": int(season), "week": week, **{k: v for k, v in res.items() if k != "cells"},
                               "cells": sw.cell_summary(res["cells"]), "input_validation": wi["report"]})
    frame = pd.DataFrame(cells)
    return {"cells": frame, "weeks": weeks_prov, "target_weeks": target_weeks, "audit": audit,
            "alarm": bool(len(frame) and frame["sp_ours"].mean() < 0)}


def audit_cells(sample: dict) -> list[dict]:
    """§3.9 fixed rule: the first cell in (season, week, position) order of each season, with the driver's
    values, for the operator to recompute by hand."""
    c = sample["cells"]
    if c.empty:
        return []
    order = {p: i for i, p in enumerate(sw.POSITIONS)}
    c = c.assign(_p=c["position"].map(order)).sort_values(["season", "week", "_p"])
    first = c.groupby("season", sort=True).head(1)
    return [{"season": int(r.season), "week": int(r.week), "position": r.position, "sp_ours_driver": float(r.sp_ours),
             "sp_con_driver": float(r.sp_con)} for r in first.itertuples()]


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def check_alarm_audit(record: dict, expected_cells: list[dict]) -> None:
    """Accept only a complete no_defect audit of exactly the fixed-rule cells, bound to THIS run (spec §3.9 step
    2-3): the recorded fixture command is the fixed one and each hand check's recorded driver values equal this
    run's computed driver values."""
    if record.get("conclusion") != "no_defect":
        raise ValueError("alarm audit conclusion is not no_defect: fix the defect, re-run, publish both (Rule 4)")
    fx = record.get("fixtures") or {}
    if fx.get("result") != "passed":
        raise ValueError("alarm audit must record the sign/identity fixture run as passed")
    if fx.get("command") != AUDIT_FIXTURES:
        raise ValueError(f"alarm audit must record the fixed fixture command {AUDIT_FIXTURES!r}")
    checks = record.get("hand_checks") or []
    if not all(_int(h.get("season")) and _int(h.get("week")) for h in checks):
        raise ValueError("every hand check names an integer season and week")
    want = {(c["season"], c["week"], c["position"]) for c in expected_cells}
    got = {(h.get("season"), h.get("week"), h.get("position")) for h in checks}
    if want != got or len(checks) != len(want):
        raise ValueError(f"alarm audit hand checks {sorted(got)} differ from the fixed-rule cells {sorted(want)}")
    by_key = {(c["season"], c["week"], c["position"]): c for c in expected_cells}
    for h in checks:
        if not all(_num(h.get(k)) for k in ("sp_ours_hand", "sp_con_hand", "sp_ours_driver", "sp_con_driver")):
            raise ValueError("every hand check records finite hand-computed and driver Spearman values")
        c = by_key[(h["season"], h["week"], h["position"])]
        for k in ("sp_ours_driver", "sp_con_driver"):
            if abs(h[k] - c[k]) > 1e-9:
                raise ValueError(f"hand check {k} {h[k]} differs from this run's driver value {c[k]}")


def aggregate_validation(weeks: list[dict]) -> dict:
    """Validation counts per reason, table and position over a sample's weeks (spec §3.7, §6.6)."""
    out: dict = {}

    def add(table: str, rep: dict | None):
        if not rep:
            return
        t = out.setdefault(table, {"invalid_by_reason": {}, "invalid_by_reason_position": {},
                                   "exact_duplicates": 0, "failed_weeks": 0})
        t["exact_duplicates"] += rep.get("exact_duplicates", 0)
        t["failed_weeks"] += int(bool(rep.get("failed")))
        for r, n in rep.get("invalid_by_reason", {}).items():
            t["invalid_by_reason"][r] = t["invalid_by_reason"].get(r, 0) + n
        for r, byp in rep.get("invalid_by_reason_position", {}).items():
            for p, n in byp.items():
                t["invalid_by_reason_position"].setdefault(r, {})
                t["invalid_by_reason_position"][r][p] = t["invalid_by_reason_position"][r].get(p, 0) + n

    for w in weeks:
        rep = w.get("input_validation") or w.get("validation") or {}
        add("actuals", rep.get("actuals"))
        add("schedule", rep.get("schedule"))
        if "n_keys" in (w.get("validation") or {}):
            add("consensus", w["validation"])
    return out


def _sample_block(s: dict) -> dict:
    c = s["cells"]
    base = {"weeks": s["weeks"], "validation": aggregate_validation(s["weeks"])}
    if c.empty:
        return {"cells": 0, **base}
    return {"cells": int(len(c)), "overall": sw.delta_stats(c), "sensitivity": sw.sensitivity_stats(c),
            "per_season": {int(k): sw.delta_stats(g) for k, g in c.groupby("season")},
            "per_position": {p: {"stats": sw.delta_stats(g), "sensitivity": sw.sensitivity_stats(g)}
                             for p, g in c.groupby("position")},
            "sp_ours": float(c["sp_ours"].mean()), "sp_con": float(c["sp_con"].mean()),
            "hit_rate_ours": float(c["hit_ours"].sum() / c["slots"].sum()),
            "hit_rate_con": float(c["hit_con"].sum() / c["slots"].sum()),
            "n_le_slots_cells": int(c["n_le_slots"].sum()), **base}


def spec_identity(git, root: Path | str = ".") -> dict:
    """The spec text in force (a citation string cannot say which amendment): the blob id of SPEC at the executing
    checkout's HEAD, the sha256 of the working-tree bytes, and whether the working tree differs from HEAD."""
    data = (Path(root) / SPEC).read_bytes()
    committed = git.show("HEAD", SPEC)
    dirty = committed is None or committed.replace(b"\r\n", b"\n") != data.replace(b"\r\n", b"\n")
    return {"spec": SPEC, "sections": "§3, §5, §6", "spec_blob": git.rev_parse(f"HEAD:{SPEC}"),
            "spec_sha256": hashlib.sha256(data).hexdigest(), "spec_dirty": bool(dirty)}


def build_report(disc: dict, rep: dict, provenance: dict, alarm_audit: dict | None = None,
                 protocol: dict | None = None) -> dict:
    audit = disc["audit"] + rep["audit"]
    discriminating = [a for a in audit if a["discriminating"]]       # §6.6: by schedule alone (A, B non-empty, differ)
    alarmed = [n for n, s in (("discovery", disc), ("replication", rep)) if s["alarm"]]
    out = {"protocol_version": PROTOCOL_VERSION, "protocol": protocol or {"spec": SPEC, "sections": "§3, §5, §6"},
           "multiplicity": "Rules 1 and 2 are separate pre-specified claims at 95%; no family-wise correction.",
           "estimand": "within-position ranking of players who recorded a stat line, were matched, and had not yet "
                       "played at the scrape date; cutoffs asymmetric; selection effect undetermined",
           "limitations": "three seasons = three clusters; within-season serial dependence not modelled",
           **provenance, "discovery": _sample_block(disc), "replication": _sample_block(rep),
           "old_protocol_staleness_audit": {
               "weeks": audit,
               "counts": {k: sum(1 for a in discriminating if (a["state"] or "none") == k)
                          for k in ("contradicted", "bye_consistent", "unverified", "none")},
               "discriminating_weeks": [{"season": a["season"], "week": a["week"], "state": a["state"],
                                        "reason": a["reason"]} for a in discriminating],
               "definition": "A and B both non-empty and different"},
           "status": "alarm_negative_correlation" if alarmed else "ok"}
    if alarmed:
        out["alarm_audit_cells"] = {n: audit_cells(s) for n, s in (("discovery", disc), ("replication", rep))
                                    if n in alarmed}
        if alarm_audit is None:
            out["verdicts"] = None
            return out
        check_alarm_audit(alarm_audit, [c for n in alarmed for c in out["alarm_audit_cells"][n]])
        out["alarm_audit"] = alarm_audit
        out["warning"] = ("limited sample: the model's mean Spearman is negative; the audit found no defect and the "
                          "result is published as computed")
    out["verdicts"] = {"rule_1": sw.rule_1(disc["cells"], disc["target_weeks"]),
                       "rule_1_replication_descriptive": sw.rule_1(rep["cells"], rep["target_weeks"]),
                       "rule_2": sw.rule_2(disc["cells"], disc["target_weeks"], rep["cells"], rep["target_weeks"])}
    return out


def evaluator(git) -> dict:
    """Spec §6.6: evaluator_version built with THIS artifact's protocol (sameweek-v1), not the live one."""
    return la.evaluator_version(git, PROTOCOL_VERSION)


def model_artifact_hashes(roots: list[Path], seasons: list[int]) -> dict:
    """Every fold artifact used, by path and sha256 (spec §6.6)."""
    out = {}
    for root in roots:
        for s in sorted(set(seasons)):
            for f in FOLD_FILES:
                p = Path(root) / f"through{s - 1}" / f
                out[p.as_posix()] = la.file_sha256(p)
    return out


def main(argv=None) -> int:
    from ffmodel.data.pull import LIVE_MAX_AGE_HOURS, _cached, pull_schedules, pull_weekly
    from ffmodel.data.rankings import pull_player_ids
    from ffmodel.eval.weekly_consensus import V1_ROOTS, transformer_predictor
    from ffmodel.eval.weekly_rankings import normalize_weekly_rankings

    ap = argparse.ArgumentParser(description="Same-week re-measurement (spec §5-§6).")
    ap.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    ap.add_argument("--first-season", type=int, default=2012)
    ap.add_argument("--out", type=Path, default=Path("models/diagnostics/weekly_consensus_sameweek.json"))
    ap.add_argument("--alarm-audited", type=Path, default=None, help="§3.9 audit record (JSON) with no_defect")
    args = ap.parse_args(argv)
    spans = list(range(args.first_season, max(DISCOVERY) + 1))
    weekly, schedules = pull_weekly(spans, cache_dir=args.data_dir), pull_schedules(spans, cache_dir=args.data_dir)
    prep = sw.prepare(weekly, schedules)

    def load_raw_rankings() -> pd.DataFrame:
        import nflreadpy

        return nflreadpy.load_ff_rankings("all").to_pandas()

    raw = _cached(args.data_dir, "ff_rankings_all_raw", load_raw_rankings, LIVE_MAX_AGE_HOURS)
    rankings, crosswalk = normalize_weekly_rankings(raw), pull_player_ids(args.data_dir)
    roots = [Path(r) for r in V1_ROOTS]
    predict = transformer_predictor(roots, prep.features)
    disc = run_sample(prep, rankings, crosswalk, DISCOVERY, predict)
    rep = run_sample(prep, rankings, crosswalk, REPLICATION, predict)
    old = {"weekly_consensus.json": json.loads(Path("models/diagnostics/weekly_consensus.json").read_text())["overall"],
           "rb_oos_weekly.json": json.loads(Path("models/diagnostics/rb_oos_weekly.json").read_text())["result"],
           "label": "different_estimand"}
    prov = {"evaluator_version": evaluator(la.Git(".")),
            "inputs": {"ff_rankings_all_raw": la.frame_sha256(raw), "schedules": la.frame_sha256(schedules),
                       "weekly_actuals": la.frame_sha256(weekly), "crosswalk": la.frame_sha256(crosswalk),
                       "model_artifacts": model_artifact_hashes(roots, DISCOVERY + REPLICATION),
                       "first_season": args.first_season},
            "coverage": sw.ranking_coverage(raw, rankings, REPLICATION + DISCOVERY),
            "old_protocol_numbers": old}
    audit = json.loads(args.alarm_audited.read_text(encoding="utf-8")) if args.alarm_audited else None
    report = build_report(disc, rep, prov, alarm_audit=audit, protocol=spec_identity(la.Git(".")))
    args.out.write_text(json.dumps(report, indent=1, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "verdicts": report["verdicts"]}, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
