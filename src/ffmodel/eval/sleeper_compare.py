"""Private Sleeper comparator (spec docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md §4.8).

Reads the private snapshot store (sleeper/manifest.jsonl + sleeper/<S>/w<NN>/<retrieved_at>.json.gz) and the
public live artifact's selected publications; writes reports/sleeper_<S>.{json,md} ONLY under --out. Nothing
here may be written to the public repository: the report carries Sleeper-derived values.

Weekly runs compute per-week and cumulative numbers only. The pre-registered decision (Holm across the two
primary claims) is computed only with --season-end, read once after the last REG week (spec §4.8.4, §8 step 8).
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import tempfile
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import ConstantInputWarning

from ffmodel.eval import live_accuracy as la
from ffmodel.eval import sameweek as sw
from ffmodel.eval.weekly_rankings import goodness_spearman
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points

PROTOCOL_VERSION = "sleeper-compare-v1"
SLEEPER_TO_STAT = {"pass_yd": "passing_yards", "pass_td": "passing_tds", "pass_int": "passing_interceptions",
                   "rush_att": "carries", "rush_yd": "rushing_yards", "rush_td": "rushing_tds",
                   "rec_tgt": "targets", "rec": "receptions", "rec_yd": "receiving_yards",
                   "rec_td": "receiving_tds", "fum_lost": "fumbles_lost"}
RELEVANT_POINTS = 8.0              # fixed now, never searched (spec §4.8.4)
PAIR_WINDOW = pd.Timedelta(hours=24)
FIRST_COMPARABLE_WEEK = {2026: 5}  # 2026 weeks 1-4 are exploratory only, never pooled (spec §1, §4.8.4)
MIN_CELL = 5
CLAIMS = (("ours", "sleeper"), ("blend", "sleeper"))
DIAGNOSTIC_PAIRS = CLAIMS + (("blend", "ours"),)
ALPHA = 0.05


class SnapshotIntegrityError(Exception):
    pass


# --- snapshots ----------------------------------------------------------------------------------------------------
def load_manifest(root: Path) -> list[dict]:
    path = Path(root) / "sleeper" / "manifest.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _eligible(cap: dict) -> bool:
    return cap.get("capture_kind") == "manual" or cap.get("http_status") == 200


def choose_snapshots(manifest: list[dict], season: int, week: int, available_by, cutoff) -> dict:
    """Spec §4.8.2. Paired: nearest to available_by, before the cutoff, within 24 h, ties to the earlier.
    Latest: the last capture before the cutoff, labelled with its timing gap."""
    a, cut = la._ts(available_by), la._ts(cutoff)
    caps = [c for c in manifest if int(c["season"]) == season and int(c["week"]) == week and _eligible(c)
            and la._ts(c["retrieved_at"]) < cut]
    paired_pool = [c for c in caps if abs(la._ts(c["retrieved_at"]) - a) <= PAIR_WINDOW]
    paired = min(paired_pool, key=lambda c: (abs(la._ts(c["retrieved_at"]) - a), la._ts(c["retrieved_at"])),
                 default=None)
    latest = max(caps, key=lambda c: la._ts(c["retrieved_at"]), default=None)
    gap = None if latest is None else (la._ts(latest["retrieved_at"]) - a).total_seconds() / 3600
    return {"paired": paired, "latest": latest, "latest_gap_hours": gap}


def read_capture(root: Path, cap: dict) -> list[dict]:
    path = Path(root) / cap["path"]
    if not path.exists():
        raise SnapshotIntegrityError(f"missing capture {cap['path']}")
    raw = gzip.decompress(path.read_bytes())
    if hashlib.sha256(raw).hexdigest() != cap["sha256"]:
        raise SnapshotIntegrityError(f"sha256 mismatch for {cap['path']}")
    data = json.loads(raw)
    if not isinstance(data, list):
        raise SnapshotIntegrityError(f"capture {cap['path']} is not a JSON array")
    return data


# --- validation and scoring ---------------------------------------------------------------------------------------
def _sleeper_key(v) -> str | None:
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return None
    if isinstance(v, (float, np.floating)) and float(v).is_integer():
        return str(int(v))
    return str(v).strip() or None


def crosswalk_map(crosswalk: pd.DataFrame) -> tuple[dict, set]:
    """sleeper_id -> gsis_id, and the Sleeper ids in a one-to-many or many-to-one collision (spec §4.8.3)."""
    x = crosswalk[["sleeper_id", "gsis_id"]].dropna()
    x = x.assign(sleeper_id=x["sleeper_id"].map(_sleeper_key)).dropna().drop_duplicates()
    per_s = x.groupby("sleeper_id")["gsis_id"].nunique()
    per_g = x.groupby("gsis_id")["sleeper_id"].nunique()
    collided = set(per_s[per_s > 1].index) | set(x.loc[x["gsis_id"].isin(per_g[per_g > 1].index), "sleeper_id"])
    ok = x[~x["sleeper_id"].isin(collided)]
    return dict(zip(ok["sleeper_id"], ok["gsis_id"])), collided


def sleeper_frame(records: list[dict], season: int, week: int) -> pd.DataFrame:
    """Rows of category proj, season S, week N, QB/RB/WR/TE. Absent mapped keys are 0 (Sleeper omits zeros); a
    present null/non-finite value becomes NaN so validation invalidates the row; pts_ppr must be present."""
    rows = []
    for r in records:
        pos = (r.get("player") or {}).get("position")
        if r.get("category") != "proj" or str(r.get("season")) != str(season) or r.get("week") != week \
                or pos not in sw.POSITIONS:
            continue
        stats = r.get("stats") or {}
        row = {"sleeper_id": _sleeper_key(r.get("player_id")), "position": pos}
        for key, col in SLEEPER_TO_STAT.items():
            v = stats[key] if key in stats else 0.0
            row[col] = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else np.nan
        pts = stats.get("pts_ppr")
        row["pts_ppr"] = float(pts) if isinstance(pts, (int, float)) and not isinstance(pts, bool) else np.nan
        rows.append(row)
    return pd.DataFrame(rows, columns=["sleeper_id", "position", *SLEEPER_TO_STAT.values(), "pts_ppr"])


def validate_sleeper(frame: pd.DataFrame, crosswalk: pd.DataFrame) -> dict:
    """§3.7 for the Sleeper table, plus identity. Returns the validation, the valid mapped rows with
    sleeper_pts (common-component PPR) and the reconciliation of pts_ppr against the re-score."""
    mapping, collided = crosswalk_map(crosswalk)
    v = sw.validate_table(frame, ["sleeper_id"], [*SLEEPER_TO_STAT.values(), "pts_ppr"], ["position"],
                          extra_invalid={"crosswalk_collision": frame["sleeper_id"].isin(collided)},
                          position_col="position")
    ok = v.valid.copy()
    ok["player_id"] = ok["sleeper_id"].map(mapping)
    unmapped = int(ok["player_id"].isna().sum())
    ok = ok.dropna(subset=["player_id"])
    ok["sleeper_pts"] = fantasy_points(ok[list(SLEEPER_TO_STAT.values())], PPR).to_numpy()
    gap = (ok["pts_ppr"] - ok["sleeper_pts"]).abs().to_numpy(float)
    recon = ({"n": int(len(gap)), "median": float(np.median(gap)), "p90": float(np.percentile(gap, 90)),
              "max": float(gap.max())} if len(gap) else {"n": 0})
    return {"validation": v, "rows": ok[["player_id", "position", "sleeper_pts"]], "unmapped": unmapped,
            "reconciliation_abs_pts_ppr_minus_rescore": recon}


# --- metrics ------------------------------------------------------------------------------------------------------
def _boot_means(deltas: np.ndarray, clusters: np.ndarray, n_boot: int = sw.N_BOOT, seed: int = sw.BOOT_SEED):
    """The resample of mean_head_gate.paired_bootstrap, returning the replicate means (for p-values)."""
    uniq = np.unique(clusters)
    by_cluster = [deltas[clusters == c] for c in uniq]
    rng = np.random.default_rng(seed)
    means = np.empty(n_boot, dtype=float)
    for b in range(n_boot):
        pick = rng.integers(0, len(by_cluster), len(by_cluster))
        means[b] = np.concatenate([by_cluster[i] for i in pick]).mean()
    return means


def _abs_err(rows: pd.DataFrame, col: str) -> np.ndarray:
    return np.abs(rows["actual"].to_numpy(float) - rows[col].to_numpy(float))


def _clusters(rows: pd.DataFrame) -> dict:
    return {"player": rows["player_id"].astype(str).to_numpy(),
            "week_team": (rows["week"].astype(str) + "|" + rows["team"].astype(str)).to_numpy()}


def view_metrics(rows: pd.DataFrame) -> dict:
    """One view (primary or diagnostic). rows: player_id, position, team, week, actual, ours, sleeper, blend."""
    n = len(rows)
    if n == 0:
        return {"n": 0, "mae": {s: None for s in ("ours", "sleeper", "blend")}, "deltas": {}, "by_position": {},
                "spearman_cells": [], "degenerate_cells": 0}
    cl = _clusters(rows)
    deltas = {}
    for a, b in DIAGNOSTIC_PAIRS:
        d = _abs_err(rows, a) - _abs_err(rows, b)
        deltas[f"{a}_minus_{b}"] = {"mean": float(d.mean()), **{
            f"ci95_{k}": [float(x) for x in np.percentile(_boot_means(d, c), [2.5, 97.5])] for k, c in cl.items()}}
    cells, degenerate = [], 0
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", ConstantInputWarning)
        for (w, pos), g in rows.groupby(["week", "position"]):
            if len(g) < MIN_CELL:
                continue
            so = goodness_spearman(g["ours"].to_numpy(), g["actual"].to_numpy())
            ss = goodness_spearman(g["sleeper"].to_numpy(), g["actual"].to_numpy())
            if not (np.isfinite(so) and np.isfinite(ss)):
                degenerate += 1
                continue
            cells.append({"week": int(w), "position": pos, "n": int(len(g)), "sp_ours": so, "sp_sleeper": ss})
    return {"n": int(n), "mae": {s: float(_abs_err(rows, s).mean()) for s in ("ours", "sleeper", "blend")},
            "deltas": deltas,
            "by_position": {p: {"n": int(len(g)), **{s: float(_abs_err(g, s).mean()) for s in ("ours", "sleeper",
                                                                                                   "blend")}}
                            for p, g in rows.groupby("position")},
            "spearman_cells": cells, "degenerate_cells": degenerate}


def relevant(rows: pd.DataFrame) -> pd.DataFrame:
    """Primary view: the fantasy-relevant union, from PROJECTIONS only (never actuals)."""
    return rows[(rows["ours"] >= RELEVANT_POINTS) | (rows["sleeper"] >= RELEVANT_POINTS)]


def missingness(played: pd.DataFrame, ours_ids: set, sleeper_ids: set) -> dict:
    out = {}
    for pos, g in played.groupby("position"):
        o, s = ~g["player_id"].isin(ours_ids), ~g["player_id"].isin(sleeper_ids)
        out[pos] = {"played": int(len(g)), "ours_missing": int(o.sum()), "sleeper_missing": int(s.sum()),
                    "both_missing": int((o & s).sum())}
    return out


def compare_rows(played: pd.DataFrame, ours: pd.DataFrame, sleeper: pd.DataFrame) -> pd.DataFrame:
    """played (player_id, position, team, week, actual) ∩ our valid p50 ∩ valid Sleeper; adds the 50/50 blend."""
    rows = played.merge(ours[["player_id", "p50"]].rename(columns={"p50": "ours"}), on="player_id")
    rows = rows.merge(sleeper[["player_id", "sleeper_pts"]].rename(columns={"sleeper_pts": "sleeper"}),
                      on="player_id")
    return rows.assign(blend=0.5 * rows["ours"] + 0.5 * rows["sleeper"])


def season_end(rows: pd.DataFrame) -> dict:
    """Spec §4.8.4: the two primary claims in the primary view, Holm-adjusted. Each claim's two-sided bootstrap
    p-value is the larger of its player- and week|team-clustered p-values (the conservative reading)."""
    if rows.empty:
        return {"status": "no_data"}
    cl = _clusters(rows)
    claims = []
    for a, b in CLAIMS:
        d = _abs_err(rows, a) - _abs_err(rows, b)
        ps = {}
        for k, c in cl.items():
            m = _boot_means(d, c)
            ps[k] = float(min(1.0, 2 * min((m <= 0).mean(), (m >= 0).mean())))
        claims.append({"claim": f"{a}_minus_{b}", "mean": float(d.mean()), "p_by_clustering": ps,
                       "p": max(ps.values())})
    order = sorted(range(len(claims)), key=lambda i: claims[i]["p"])
    still = True
    for rank, i in enumerate(order):
        threshold = ALPHA / (len(claims) - rank)
        reject = still and claims[i]["p"] <= threshold
        still = reject
        c = claims[i]
        c["holm_threshold"] = threshold
        c["rejected"] = bool(reject)
        a, b = c["claim"].split("_minus_")
        c["outcome"] = (f"{a}_lower_error" if c["mean"] < 0 else f"{b}_lower_error") if reject else "inconclusive"
    return {"status": "read", "claims": claims, "n": int(len(rows)),
            "note": "read once after the last REG week; everything else in this report is diagnostic"}


# --- orchestration ------------------------------------------------------------------------------------------------
def _week_variant(root, cap, season, week, crosswalk, played, ours) -> tuple[dict, pd.DataFrame | None]:
    if cap is None:
        return {"status": "skipped", "reason": "no_sleeper_snapshot"}, None
    snap = {k: cap.get(k) for k in ("retrieved_at", "path", "sha256", "capture_kind", "published_commit",
                                    "published_batch_id", "source_updated_at_min", "source_updated_at_max",
                                    "source_updated_at_count")}
    try:
        records = read_capture(root, cap)
    except SnapshotIntegrityError as exc:
        return {"status": "skipped", "reason": "snapshot_integrity_failed", "detail": str(exc), "snapshot": snap}, None
    vs = validate_sleeper(sleeper_frame(records, season, week), crosswalk)
    rec = {"snapshot": snap, "validation": vs["validation"].report(), "unmapped": vs["unmapped"],
           "reconciliation": vs["reconciliation_abs_pts_ppr_minus_rescore"],
           "missingness": missingness(played, set(ours["player_id"]), set(vs["rows"]["player_id"]))}
    if vs["validation"].fails():
        return {**rec, "status": "skipped", "reason": "validation_failed"}, None
    rows = compare_rows(played, ours, vs["rows"])
    return {**rec, "status": "scored", "primary": view_metrics(relevant(rows)),
            "diagnostic": view_metrics(rows)}, rows


def private_input_hashes(weekly: pd.DataFrame, schedules: pd.DataFrame, crosswalk: pd.DataFrame,
                         artifact_bytes: bytes) -> dict:
    """Spec §4.8.5 private provenance: the private run's own data vintage, as actually read."""
    return {"actuals": la.frame_sha256(weekly), "schedules": la.frame_sha256(schedules),
            "crosswalk": la.frame_sha256(crosswalk), "live_artifact": hashlib.sha256(artifact_bytes).hexdigest()}


def run(snapshots: Path, artifact: dict, prepared: sw.Prepared, crosswalk: pd.DataFrame, git,
        season_end_read: bool = False, inputs: dict | None = None, run_at: str | None = None) -> dict:
    """The private stats are a separate data vintage (spec §4.8.5, astra S7-I5): every week the public artifact
    scored is re-checked on THESE inputs -- team_presence_complete, then §3.7 -- and skipped with
    private_inputs_incomplete or validation_failed; the public run's decision is never borrowed."""
    S = int(artifact["season"])
    manifest = load_manifest(snapshots)
    weights = la.ppr_weights()
    by_week, pooled, selected = {}, {"paired": [], "latest": []}, {}
    for N in sorted(int(w) for w in artifact["weeks_scored"]):
        if N < FIRST_COMPARABLE_WEEK.get(S, 1):
            by_week[str(N)] = {"status": "skipped", "reason": "exploratory_weeks_excluded"}
            continue
        wrec = artifact["weeks"][str(N)]
        pub = wrec["publication"]
        if not la.week_complete(prepared, S, N):
            by_week[str(N)] = {"status": "skipped", "reason": "private_inputs_incomplete"}
            continue
        wi = sw.week_inputs(prepared, S, N)
        if wi["failed"]:
            by_week[str(N)] = {"status": "skipped", "reason": "validation_failed", "validation": wi["report"]}
            continue
        legacy, neutral = la.read_payloads(git, pub["commit"])
        vp, reason, _ = la.published_values(legacy, neutral, weights, S, N)
        if reason:
            by_week[str(N)] = {"status": "skipped", "reason": reason}
            continue
        if vp.fails():
            by_week[str(N)] = {"status": "skipped", "reason": "validation_failed",
                               "validation": {"projections": vp.report()}}
            continue
        ours = vp.valid
        act = wi["actuals"].valid
        played = act[["player_id", "position", "team", "week"]].assign(
            actual=fantasy_points(act[PREDICTED_STATS], PPR).to_numpy())
        choice = choose_snapshots(manifest, S, N, pub["available_by"], wrec["cutoff"])
        out = {"publication": {"commit": pub["commit"], "available_by": pub["available_by"]},
               "cutoff": wrec["cutoff"], "latest_gap_hours": choice["latest_gap_hours"],
               "latest_label": "sleeper_timing_advantage"}
        for variant in ("paired", "latest"):
            cap = choice[variant]
            if cap is not None:
                selected[cap["path"]] = cap.get("sha256")
            res, rows = _week_variant(snapshots, cap, S, N, crosswalk, played, ours)
            out[variant] = res
            if rows is not None:
                pooled[variant].append(rows)
        by_week[str(N)] = out
    cumulative = {}
    for variant, frames in pooled.items():
        rows = pd.concat(frames, ignore_index=True) if frames else None
        cumulative[variant] = ({"primary": view_metrics(relevant(rows)), "diagnostic": view_metrics(rows)}
                               if rows is not None else {"status": "no_data"})
    provenance = {"evaluator_version": la.evaluator_version(git, PROTOCOL_VERSION),
                  "run_at": run_at or pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "inputs": {**(inputs or {}),
                             "manifest": la.file_sha256(Path(snapshots) / "sleeper" / "manifest.jsonl")},
                  "selected_captures": [{"path": p, "sha256": h} for p, h in sorted(selected.items())]}
    report = {"protocol_version": PROTOCOL_VERSION, "season": S, "private": True, "provenance": provenance,
              "live_artifact": {"protocol_version": artifact.get("protocol_version"),
                                "run": artifact.get("run"), "evaluator_version": artifact.get("evaluator_version")},
              "by_week": by_week, "cumulative": cumulative,
              "caveats": ["Private: Sleeper-derived values never enter the public repository.",
                          "Paired snapshot approximates an equal information deadline only to within the capture "
                          "schedule; 'latest' answers which available product was better, not which method.",
                          "Common-component PPR re-score on both sides; two-point conversions and special-teams "
                          "scores are excluded.", "Weekly numbers are diagnostic; there are no weekly decisions."]}
    if season_end_read:
        frames = pooled["paired"]
        report["season_end"] = season_end(relevant(pd.concat(frames, ignore_index=True)) if frames
                                          else pd.DataFrame())
    return report


def render_markdown(report: dict) -> str:
    def f(x):
        return "—" if x is None else f"{x:.2f}"

    lines = [f"# Sleeper comparison (private) — {report['season']}", "",
             "| week | variant | gap h | n (relevant) | MAE ours | MAE Sleeper | MAE blend |", "|---|---|---|---|---|---|---|"]
    for w, rec in sorted(report["by_week"].items(), key=lambda kv: int(kv[0])):
        for variant in ("paired", "latest"):
            v = rec.get(variant)
            if not v:
                continue
            if v.get("status") != "scored":
                lines.append(f"| {w} | {variant} | — | — | {v.get('reason')} | | |")
                continue
            m = v["primary"]
            gap = rec["latest_gap_hours"] if variant == "latest" else None
            lines.append(f"| {w} | {variant} | {f(gap)} | {m['n']} | {f(m['mae']['ours'])} | "
                         f"{f(m['mae']['sleeper'])} | {f(m['mae']['blend'])} |")
    if "season_end" in report and report["season_end"].get("status") == "read":
        lines += ["", "## Season-end read (Holm across two claims)"]
        for c in report["season_end"]["claims"]:
            lines.append(f"- {c['claim']}: mean {c['mean']:.3f}, p {c['p']:.4f}, outcome {c['outcome']}")
    lines += ["", *[f"- {c}" for c in report["caveats"]], ""]
    return "\n".join(lines)


def write_report(report: dict, out_dir: Path) -> list[Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    js = out_dir / f"sleeper_{report['season']}.json"
    md = out_dir / f"sleeper_{report['season']}.md"
    js.write_text(json.dumps(report, indent=1, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    md.write_text(render_markdown(report), encoding="utf-8")
    return [js, md]


def _load_inputs(season: int, data_dir: Path):
    """The private run's own pull (a separate data vintage): raw weekly actuals, schedule and crosswalk."""
    from ffmodel.data.pull import pull_schedules, pull_weekly
    from ffmodel.data.rankings import pull_player_ids

    weekly, schedules = pull_weekly([season], cache_dir=data_dir), pull_schedules([season], cache_dir=data_dir)
    return weekly, schedules, pull_player_ids(data_dir)


def main(argv=None, load_inputs=_load_inputs, git=None) -> int:
    ap = argparse.ArgumentParser(description="Private Sleeper comparator (spec §4.8).")
    ap.add_argument("--snapshots", type=Path, required=True, help="private repository checkout")
    ap.add_argument("--live-artifact", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True, help="directory; the only place this writes")
    ap.add_argument("--data-dir", type=Path, default=None, help="nflverse cache (default: a fresh temp dir)")
    ap.add_argument("--season-end", action="store_true", help="the one pre-registered read after the last REG week")
    args = ap.parse_args(argv)
    artifact_bytes = args.live_artifact.read_bytes()
    artifact = json.loads(artifact_bytes.decode("utf-8"))
    data_dir = args.data_dir or Path(tempfile.mkdtemp(prefix="sleeper-cmp-"))
    weekly, schedules, crosswalk = load_inputs(int(artifact["season"]), data_dir)
    report = run(args.snapshots, artifact, sw.prepare(weekly, schedules), crosswalk, git or la.Git("."),
                 season_end_read=args.season_end,
                 inputs=private_input_hashes(weekly, schedules, crosswalk, artifact_bytes))
    for p in write_report(report, args.out):
        print(p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
