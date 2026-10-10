"""Live weekly accuracy scorecard (spec docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md §4).

Scores the projections the bot pipeline published before each week's cutoff, proven by GitHub push records
kept in a committed, append-only ledger. Git and the GitHub API are injected so tests run offline.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from ffmodel.baseline.naive import NaiveLast4
from ffmodel.eval import sameweek as sw
from ffmodel.eval.mean_head_gate import paired_bootstrap
from ffmodel.eval.metrics import pinball_loss
from ffmodel.scoring import PPR, PREDICTED_STATS, fantasy_points
from ffmodel.site import leaguelens

BOT = "weekly-update-bot"
WEEKLY_FILES = ("site/data/weekly.json", "site/data/neutral/weekly.json")
ARCHIVE_DIR = "data_snapshots/weekly_ecr"
ARCHIVE_COLUMNS = ["player_id", "position", "team", "ecr"]
MAIN_REF = "refs/heads/main"
NEG_INF = "-inf"
ZERO_SHA = "0" * 40
NEG_INF_TS = pd.Timestamp.min.tz_localize("UTC")


class Git:
    """The only git access (spec §4.1). Tests pass a fake with the same methods."""

    def __init__(self, cwd: Path | str = "."):
        self.cwd = str(cwd)

    def _run(self, *args, check=True) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=self.cwd, capture_output=True, check=check)

    def exists(self, sha: str) -> bool:
        return bool(sha) and self._run("cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode == 0

    def ident(self, sha: str) -> tuple[str, str]:
        out = self._run("log", "-1", "--format=%an%x00%cn", sha).stdout.decode().strip()
        a, c = out.split("\x00")
        return a, c

    def changed(self, sha: str) -> set[str]:
        r = self._run("diff", "--name-only", f"{sha}^1", sha, check=False)
        if r.returncode != 0:  # root commit
            r = self._run("show", "--name-only", "--format=", sha)
        return {line for line in r.stdout.decode().splitlines() if line}

    def show(self, sha: str, path: str) -> bytes | None:
        r = self._run("show", f"{sha}:{path}", check=False)
        return r.stdout if r.returncode == 0 else None

    def existing(self, shas) -> set[str]:
        """The subset of `shas` that are commits in the local object store (one batched call)."""
        shas = sorted({s for s in shas if s})
        if not shas:
            return set()
        r = subprocess.run(["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"], cwd=self.cwd,
                           input="\n".join(shas) + "\n", capture_output=True, text=True, check=True)
        found = {line.split()[0] for line in r.stdout.splitlines() if line.endswith(" commit")}
        return {s for s in shas if s in found}

    def reachable(self, tip: str) -> set[str]:
        return set(self._run("rev-list", tip).stdout.decode().split())

    def descendants_among(self, c: str, shas) -> set[str]:
        """The members of `shas` that have `c` as ancestor-or-self (one batched call)."""
        shas = sorted({s for s in shas if s})
        if not shas:
            return set()
        r = subprocess.run(["git", "rev-list", "--ancestry-path", "--stdin"], cwd=self.cwd,
                           input="\n".join([f"^{c}", *shas]) + "\n", capture_output=True, text=True, check=True)
        found = set(r.stdout.split())
        return {s for s in shas if s in found or s == c}

    def rev_parse(self, ref: str) -> str:
        return self._run("rev-parse", ref).stdout.decode().strip()

    def first_adding_commit(self, main_sha: str, path: str) -> str | None:
        out = self._run("log", main_sha, "--full-history", "--diff-filter=A", "--format=%H", "--", path).stdout
        shas = out.decode().split()
        return shas[-1] if shas else None

    def ls_dir(self, sha: str, dirpath: str) -> list[str]:
        out = self._run("ls-tree", "--name-only", f"{sha}:{dirpath}", check=False)
        return sorted(out.stdout.decode().split()) if out.returncode == 0 else []

    def weekly_commits(self, tips, exclude=()) -> list[tuple[str, str, str, str]]:
        """(sha, committer ISO time, author name, committer name) of commits touching a weekly file, over the FULL
        ancestry of `tips` minus the ancestry of `exclude` (one `git log` call; git visits each commit once).
        The time is informational: no caller may prune by it (spec §4.1, astra S7-I1)."""
        tips = sorted({t for t in tips if t})
        if not tips:
            return []
        out = self._run("log", *tips, *[f"^{e}" for e in exclude if e], "--full-history",
                        "--format=%H%x09%cI%x09%an%x09%cn", "--", *WEEKLY_FILES).stdout
        return [tuple(line.split("\t")) for line in out.decode().splitlines() if line]

    def tree_id(self, path: str = "src/ffmodel") -> str:
        """Tree id of `path` in the EXECUTING checkout (spec §4.6 evaluator_version)."""
        return self._run("rev-parse", f"HEAD:{path}").stdout.decode().strip()

    def dirty(self, path: str = "src/ffmodel") -> bool:
        return bool(self._run("status", "--porcelain", "--", path).stdout.strip())


# --- activity API and ledger --------------------------------------------------------------------------------------
def fetch_activity(repo: str, run=subprocess.run) -> list[dict]:
    """All main-ref activity events. `--paginate --slurp` emits ONE outer JSON array whose items are the pages
    (spec §4.1, astra P1); the events are the pages concatenated. Any failure is an infrastructure error."""
    cmd = ["gh", "api", "--paginate", "--slurp", f"repos/{repo}/activity?ref={MAIN_REF}&per_page=100"]
    r = run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"activity fetch failed (exit {r.returncode}): {(r.stderr or '')[-500:]}")
    try:
        pages = json.loads(r.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"activity response is not one JSON document: {exc}") from exc
    if not isinstance(pages, list) or not all(isinstance(p, list) for p in pages):
        raise RuntimeError("activity response is not an array of array pages")
    events = [e for page in pages for e in page]
    if not all(isinstance(e, dict) and "id" in e and "timestamp" in e for e in events):
        raise RuntimeError("activity event without id/timestamp")
    return events


def normalize_event(raw: dict) -> dict:
    actor = raw.get("actor")
    return {"id": raw["id"], "ref": raw.get("ref"), "timestamp": raw["timestamp"], "before": raw.get("before"),
            "after": raw.get("after"), "activity_type": raw.get("activity_type"),
            "actor": actor.get("login") if isinstance(actor, dict) else actor}


def _ts(x) -> pd.Timestamp:
    if isinstance(x, str) and x == NEG_INF:
        return NEG_INF_TS
    t = pd.Timestamp(x)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


def collection_start(raw_events: list[dict]) -> str | None:
    """t_start of a complete collection: "-inf" when the oldest event is main's branch_creation (nothing can
    precede the branch), else the oldest event's timestamp (spec §4.1 coverage intervals)."""
    if not raw_events:
        return None
    oldest = min((normalize_event(r) for r in raw_events), key=lambda e: (_ts(e["timestamp"]), e["id"]))
    if oldest["activity_type"] == "branch_creation" and oldest["ref"] == MAIN_REF:
        return NEG_INF
    return oldest["timestamp"]


def load_ledger(path: Path) -> dict:
    p = Path(path)
    if not p.exists():
        return {"events": [], "coverage": []}
    return json.loads(p.read_text(encoding="utf-8"))


def merge_collection(ledger: dict, raw_events: list[dict], t_end: str, t_start: str | None = None) -> dict:
    """Append-only merge by id (events are never deleted or edited); record [t_start, t_end] coverage."""
    by_id = {e["id"]: e for e in ledger["events"]}
    for raw in raw_events:
        e = normalize_event(raw)
        by_id.setdefault(e["id"], e)
    events = sorted(by_id.values(), key=lambda e: (_ts(e["timestamp"]), e["id"]))
    start = t_start if t_start is not None else (collection_start(raw_events) or t_end)
    coverage = sorted(ledger["coverage"] + [[start, t_end]], key=lambda iv: (_ts(iv[0]), _ts(iv[1])))
    return {"events": events, "coverage": coverage}


def save_ledger(ledger: dict, path: Path) -> None:
    Path(path).write_text(json.dumps(ledger, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def ledger_sha256(ledger: dict) -> str:
    return hashlib.sha256(json.dumps(ledger, sort_keys=True).encode()).hexdigest()


def covered(ledger: dict, t0, t1) -> bool:
    """[t0, t1) lies inside the union of the coverage intervals."""
    a, b = _ts(t0), _ts(t1)
    merged: list[list[pd.Timestamp]] = []
    for s, e in sorted((_ts(s), _ts(e)) for s, e in ledger["coverage"]):
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return any(s <= a and b <= e for s, e in merged)


def _main_events(ledger: dict) -> list[dict]:
    return [e for e in ledger["events"] if e.get("ref") == MAIN_REF]


def season_lower_bound(season: int) -> pd.Timestamp:
    """T_S (spec §4.1): no season-S week-N publication can precede it."""
    return pd.Timestamp(f"{season}-06-01T00:00:00Z")


# --- publications -------------------------------------------------------------------------------------------------
def read_payloads(git, sha: str) -> tuple[dict | None, dict | None]:
    out = []
    for path in WEEKLY_FILES:
        raw = git.show(sha, path)
        try:
            out.append(json.loads(raw) if raw else None)
        except json.JSONDecodeError:
            out.append(None)
    return out[0], out[1]


def _identities(git, sha: str) -> set[tuple]:
    return {(p.get("season"), p.get("week")) for p in read_payloads(git, sha) if isinstance(p, dict)}


def _bot_weekly_commit(git, sha: str) -> bool:
    return git.ident(sha) == (BOT, BOT) and bool(git.changed(sha) & set(WEEKLY_FILES))


def is_candidate(git, sha: str, season: int, week: int) -> bool:
    return git.exists(sha) and _bot_weekly_commit(git, sha) and (season, week) in _identities(git, sha)


@dataclass
class CandidateIndex:
    by_week: dict           # week -> set of candidate shas
    unfetchable: set        # ledger targets that cannot be fetched locally


def candidate_index(ledger: dict, git, season: int, main_sha: str) -> CandidateIndex:
    """Spec §4.1 candidate enumeration: every commit reachable from the pinned main sha, plus every commit
    reachable from any ledger target (any activity type) -- full ancestry, never pruned by commit or author
    timestamps, which are creation times that can be set arbitrarily and need not decrease along ancestry
    (astra S7-I1). Ancestry already reachable from main is enumerated once, by the first source; a target that
    cannot be fetched is recorded as unfetchable."""
    afters = {e.get("after") for e in _main_events(ledger)}
    present = git.existing(a for a in afters if a and a != ZERO_SHA)
    unfetchable = {a for a in afters if a not in present}
    rows = list(git.weekly_commits([main_sha]))
    off_main = sorted(present - git.reachable(main_sha))
    if off_main:
        rows += git.weekly_commits(off_main, exclude=[main_sha])
    by_week: dict[int, set] = {}
    seen: set = set()
    for sha, _, author, committer in rows:
        if sha in seen:
            continue
        seen.add(sha)
        if (author, committer) != (BOT, BOT) or not (git.changed(sha) & set(WEEKLY_FILES)):
            continue
        for s, w in _identities(git, sha):
            if s == season and isinstance(w, int):
                by_week.setdefault(w, set()).add(sha)
    return CandidateIndex(by_week=by_week, unfetchable=unfetchable)


def _unavailable(detail: str, event_id=None) -> dict:
    return {"status": "publication_evidence_unavailable", "commit": None, "event_id": event_id,
            "available_by": None, "detail": detail}


def select_publication(ledger: dict, git, season: int, week: int, cutoff, main_sha: str,
                       index: CandidateIndex | None = None) -> dict:
    """Spec §4.1 selection steps 1-5. Only a `push` establishes publication; other types feed the checks."""
    cutoff = _ts(cutoff)
    idx = index or candidate_index(ledger, git, season, main_sha)
    cands = idx.by_week.get(week, set())
    main = _main_events(ledger)
    pushes = sorted((e for e in main if e.get("activity_type") == "push" and e.get("after") in cands
                     and _ts(e["timestamp"]) < cutoff), key=lambda e: (_ts(e["timestamp"]), e["id"]))
    earliest: dict[str, dict] = {}
    for e in pushes:                                     # step 1: reduce each sha to its earliest push
        earliest.setdefault(e["after"], e)
    if earliest:
        ev = max(earliest.values(), key=lambda e: (_ts(e["timestamp"]), e["id"]))
        avail = _ts(ev["timestamp"])
        window = [e for e in main if avail <= _ts(e["timestamp"]) < cutoff]
        if not covered(ledger, avail, cutoff):                                       # step 2
            return _unavailable("ledger coverage gap between publication and cutoff", ev["id"])
        forced = [e for e in window if e.get("activity_type") == "force_push"]
        if forced:                                                                   # step 3
            return _unavailable("force_push between publication and cutoff", forced[0]["id"])
        lost = [e for e in window if e.get("after") in idx.unfetchable]
        if lost:                                                                     # step 4
            return _unavailable("unfetchable ledger target between publication and cutoff", lost[0]["id"])
        return {"status": "selected", "commit": ev["after"], "event_id": ev["id"],
                "available_by": ev["timestamp"], "detail": None}
    if cands:                                                                        # step 5
        return _unavailable("candidate payload without a pre-cutoff push naming it")
    t_s = season_lower_bound(season)
    span_lost = [e for e in main if t_s <= _ts(e["timestamp"]) < cutoff and e.get("after") in idx.unfetchable]
    if covered(ledger, t_s, cutoff) and not span_lost:
        return {"status": "weeks_unpublished", "commit": None, "event_id": None, "available_by": None,
                "detail": "no candidate; [T_S, cutoff) fully covered and every target fetchable"}
    return _unavailable("absence not provable: coverage gap or unfetchable target in [T_S, cutoff)")


# --- archives -----------------------------------------------------------------------------------------------------
def _archive_digest_ok(name: str, blob: bytes) -> bool:
    digest = name.rsplit("-", 1)[-1].removesuffix(".json")
    return hashlib.sha256(blob).hexdigest()[:16] == digest


def _check_archive(git, q: dict, season: int, week: int) -> dict:
    """Content and identity checks (spec §4.3, astra P4), all before an archive can qualify."""
    blob = git.show(q["commit"], q["path"])
    out = {"blob_sha256": hashlib.sha256(blob).hexdigest() if blob is not None else None,
           "status": None, "consensus": None, "validation": None}
    if blob is None or not _archive_digest_ok(q["name"], blob):
        return {**out, "status": "archive_hash_mismatch"}
    try:
        content = json.loads(blob)
    except json.JSONDecodeError:
        return {**out, "status": "archive_identity_mismatch"}
    if not isinstance(content, dict) or content.get("season") != season or content.get("week") != week:
        return {**out, "status": "archive_identity_mismatch"}
    players = pd.DataFrame(content.get("players") or [], columns=ARCHIVE_COLUMNS)
    v = sw.validate_table(players, ["player_id"], ["ecr"], ["position", "team"], position_col="position")
    if v.fails():
        return {**out, "status": "validation_failed", "validation": v.report()}
    return {**out, "status": "qualifies", "consensus": v.valid, "validation": v.report()}


def select_archive(ledger: dict, git, season: int, week: int, cutoff, main_sha: str) -> dict:
    """Spec §4.3. Evidence orders the archives; the archive that would be selected must pass every content and
    identity check, otherwise the week's primary ranking is skipped with that reason (never promoted past)."""
    cutoff = _ts(cutoff)
    prefix = f"{season}-w{week:02d}-"
    events = sorted((e for e in _main_events(ledger) if e.get("activity_type") in {"push", "pr_merge"}
                     and _ts(e["timestamp"]) < cutoff), key=lambda e: (_ts(e["timestamp"]), e["id"]))
    present = git.existing(e.get("after") for e in events)
    evidenced = []
    for name in git.ls_dir(main_sha, ARCHIVE_DIR):
        if not name.startswith(prefix):
            continue
        path = f"{ARCHIVE_DIR}/{name}"
        c = git.first_adding_commit(main_sha, path)
        if c is None or git.ident(c) != (BOT, BOT):
            continue
        desc = git.descendants_among(c, present)
        ev = next((e for e in events if e.get("after") in desc), None)
        if ev is None or not covered(ledger, ev["timestamp"], cutoff):
            continue
        evidenced.append({"path": path, "name": name, "commit": c, "available_by": ev["timestamp"],
                          "event_id": ev["id"]})
    empty = {"path": None, "name": None, "commit": None, "available_by": None, "event_id": None,
             "blob_sha256": None, "tie_break": None, "alternatives": [], "validation": None, "consensus": None}
    if not evidenced:
        return {**empty, "status": "no_archive"}
    evidenced.sort(key=lambda q: (-_ts(q["available_by"]).value, q["name"]))
    checked = [{**q, **_check_archive(git, q, season, week)} for q in evidenced]
    pick, rest = checked[0], checked[1:]
    tie = sum(1 for q in checked if q["available_by"] == pick["available_by"]) > 1
    alternatives = [{"name": q["name"], "blob_sha256": q["blob_sha256"], "available_by": q["available_by"],
                     "status": q["status"]} for q in rest]
    status = "selected" if pick["status"] == "qualifies" else pick["status"]
    return {"status": status, "path": pick["path"], "name": pick["name"], "commit": pick["commit"],
            "available_by": pick["available_by"], "event_id": pick["event_id"], "blob_sha256": pick["blob_sha256"],
            "tie_break": "arbitrary_lexicographic" if tie else None, "alternatives": alternatives,
            "validation": pick["validation"], "consensus": pick["consensus"] if status == "selected" else None}


PROTOCOL_VERSION = "live-accuracy-v1"
EQUIV_TOL = 0.01
QUANTILES = ("p10", "p50", "p90")
VALUE_COLUMNS = ["player_id", "position", "team", "p10", "p50", "p90"]
FORMAT_YAML = Path("configs/formats/f12-1qb-ppr-4.yaml")
LEDGER_PATH = Path("models/diagnostics/main_push_ledger.json")
BAKEOFF_PATH = Path("models/backtests/bakeoff.json")
PROVISIONAL_DAYS = 8


def ppr_weights() -> dict:
    return leaguelens.effective_weights(yaml.safe_load(FORMAT_YAML.read_text(encoding="utf-8"))["sleeper_scoring"])


def _legacy_frame(legacy: dict) -> pd.DataFrame:
    rows = []
    for p in legacy.get("players") or []:
        ppr = (p.get("points") or {}).get("ppr") or {}
        rows.append({"player_id": p.get("player_id"), "position": p.get("position"), "team": p.get("team"),
                     **{q: ppr.get(q) for q in QUANTILES}})
    return pd.DataFrame(rows, columns=VALUE_COLUMNS).astype({q: float for q in QUANTILES})


NEUTRAL_COMPONENTS = [f"{q}:{s}" for q in QUANTILES for s in PREDICTED_STATS]


def _number(v) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else np.nan


def _neutral_stats_frame(neutral: dict) -> pd.DataFrame:
    """One row per neutral record: identity, every PREDICTED_STATS component in all three quantiles (missing or
    non-numeric -> NaN), and `vector`, the canonical full stat_quantiles, so records whose vectors differ in ANY
    component are a conflicting key even when they score to the same points (spec §4.1, astra S7-I4)."""
    rows = []
    for p in neutral.get("players") or []:
        sq = p.get("stat_quantiles")
        row = {"player_id": p.get("player_id"), "position": p.get("position"), "team": p.get("team"),
               "vector": json.dumps(sq, sort_keys=True, default=str)}
        for q in QUANTILES:
            block = sq.get(q) if isinstance(sq, dict) else None
            for s in PREDICTED_STATS:
                row[f"{q}:{s}"] = _number(block.get(s)) if isinstance(block, dict) else np.nan
        rows.append(row)
    return pd.DataFrame(rows, columns=["player_id", "position", "team", "vector", *NEUTRAL_COMPONENTS])


def validate_neutral(stats: pd.DataFrame) -> sw.TableValidation:
    """§3.7 on the full neutral stat vectors, before any scoring: identity and duplicates, every component finite
    in all three quantiles (zero-weight components included) and p10 <= p50 <= p90 per component."""
    disorder = pd.Series(False, index=stats.index)
    for s in PREDICTED_STATS:
        lo, mid, hi = (stats[f"{q}:{s}"].astype(float) for q in QUANTILES)
        finite = np.isfinite(lo) & np.isfinite(mid) & np.isfinite(hi)
        disorder |= finite & ~((lo <= mid) & (mid <= hi))
    return sw.validate_table(stats, ["player_id"], NEUTRAL_COMPONENTS, ["team", "position", "vector"],
                             extra_invalid={"quantile_order": disorder}, position_col="position")


def _neutral_projections(neutral: dict, weights: dict) -> sw.TableValidation:
    """The neutral projection table: validated on full stat vectors first, then only valid rows are re-scored in
    PPR. A row the scorer still rejects (e.g. a weighted stat outside PREDICTED_STATS) is invalid as non-finite.
    Counts and the 1% rule cover every neutral key, never only the survivors."""
    players = neutral.get("players") or []
    nv = validate_neutral(_neutral_stats_frame(neutral))
    rows = []
    for i in nv.valid.index:
        p = players[i]
        try:
            s = leaguelens.reference_score(p.get("stat_quantiles"), p.get("position"), weights)
        except ValueError:
            s = {q: None for q in QUANTILES}
        rows.append({"player_id": p.get("player_id"), "position": p.get("position"), "team": p.get("team"), **s})
    scored = pd.DataFrame(rows, columns=VALUE_COLUMNS).astype({q: float for q in QUANTILES})
    sv = sw.validate_projections(scored)
    invalid = {r: set(k) for r, k in nv.invalid.items()}
    for r, k in sv.invalid.items():
        invalid.setdefault(r, set()).update(k)
    return sw.TableValidation(valid=sv.valid, invalid=invalid, n_keys=nv.n_keys, exact_duplicates=nv.exact_duplicates,
                              key_position=nv.key_position)


def _carries(payload, season: int, week: int) -> bool:
    return isinstance(payload, dict) and payload.get("season") == season and payload.get("week") == week


def equivalence(lv: sw.TableValidation, nv: sw.TableValidation) -> dict:
    """Spec §4.1 equivalence over the two VALIDATED tables (the neutral one on full stat vectors): equal valid
    player sets, every quantile finite and within 0.01."""
    lids, nids = set(lv.valid["player_id"]), set(nv.valid["player_id"])
    detail = {"invalid_legacy": sorted(k[0] for k in lv.invalid_keys()),
              "invalid_neutral": sorted(k[0] for k in nv.invalid_keys()),
              "missing_in_neutral": sorted(lids - nids), "missing_in_legacy": sorted(nids - lids),
              "divergent": [], "max_abs_diff": None}
    if lids != nids or not lids:
        return {"ok": False, **detail}
    both = lv.valid.set_index("player_id")[list(QUANTILES)].join(
        nv.valid.set_index("player_id")[list(QUANTILES)], rsuffix="_n", how="inner")
    diffs = np.column_stack([(both[q] - both[f"{q}_n"]).abs().to_numpy(float) for q in QUANTILES])
    bad = ~np.isfinite(diffs) | (diffs > EQUIV_TOL)
    detail["divergent"] = sorted(both.index[bad.any(axis=1)])
    detail["max_abs_diff"] = float(np.max(diffs)) if np.isfinite(diffs).all() else None
    return {"ok": not bad.any(), **detail}


def published_values(legacy, neutral, weights: dict, season: int, week: int):
    """(projections, reason, detail). `projections` is the validated projection table (sw.TableValidation): its
    `valid` rows (VALUE_COLUMNS) are scored and its counts drive the 1% rule. Legacy points.ppr when the commit
    carries a week-N legacy file, else the neutral stat quantiles, validated on full vectors and then re-scored in
    PPR. A same-batch pair must pass `equivalence` or the week is skipped. Before equivalence, BOTH validated tables
    must pass the 1% rule (spec §3.7, astra S71-I1): a failed table is returned as `projections` with no reason, so
    the caller's `.fails()` check skips the week as `validation_failed` and reports that table's counts."""
    leg = legacy if _carries(legacy, season, week) else None
    neu = neutral if _carries(neutral, season, week) else None
    if leg is None and neu is None:
        raise ValueError(f"selected commit carries no season {season} week {week} payload")
    if leg is None:
        return _neutral_projections(neu, weights), None, {"source": "neutral", "equivalence_checked": False}
    lv = sw.validate_projections(_legacy_frame(leg))
    if neu is None or neu.get("generated_at") != leg.get("generated_at"):
        return lv, None, {"source": "legacy", "equivalence_checked": False}
    nv = _neutral_projections(neu, weights)
    for name, table in (("legacy", lv), ("neutral", nv)):
        if table.fails():
            return table, None, {"source": name, "equivalence_checked": False, "failed_table": name}
    eq = equivalence(lv, nv)
    if not eq["ok"]:
        return None, "equivalence_failed", {"source": "legacy", "equivalence_checked": True, **eq}
    return lv, None, {"source": "legacy", "equivalence_checked": True, "max_abs_diff": eq["max_abs_diff"]}


def naive_points(features: pd.DataFrame, rows: pd.DataFrame, season: int) -> pd.Series:
    """NaiveLast4 scored in PPR; NaN lags fall back to the position mean over feature rows with season < S."""
    model = NaiveLast4()
    model.fit(features[features["season"] < season])
    missing = set(rows["position"]) - set(model._pos_means.dropna().index)
    if missing:
        raise ValueError(f"naive fallback has no position mean for {sorted(missing)}")
    return fantasy_points(model.predict(rows), PPR)


def _mean(x) -> float | None:
    return float(np.mean(x)) if len(x) else None


def point_metrics(df: pd.DataFrame) -> dict:
    """Undefined metrics are None, never NaN, so artifacts serialise with allow_nan=False (astra P6)."""
    y, p50 = df["actual"].to_numpy(float), df["p50"].to_numpy(float)
    lo, hi, nv = df["p10"].to_numpy(float), df["p90"].to_numpy(float), df["naive"].to_numpy(float)
    resid = y - p50
    n = len(df)
    return {"n": int(n), "mae": _mean(np.abs(resid)), "naive_mae": _mean(np.abs(y - nv)),
            "mean_resid": _mean(resid), "median_resid": float(np.median(resid)) if n else None,
            "share_above_p50": _mean(y > p50), "coverage_p10_p90": _mean((y >= lo) & (y <= hi)),
            "below_p10": _mean(y < lo), "above_p90": _mean(y > hi),
            "pinball_p10": float(pinball_loss(y, lo, 0.1)) if n else None,
            "pinball_p50": float(pinball_loss(y, p50, 0.5)) if n else None,
            "pinball_p90": float(pinball_loss(y, hi, 0.9)) if n else None}


def paired_intervals(df: pd.DataFrame) -> dict:
    delta = (np.abs(df["actual"] - df["p50"]) - np.abs(df["actual"] - df["naive"])).to_numpy(float)
    by_player = paired_bootstrap(delta, df["player_id"].astype(str).to_numpy(), n_boot=sw.N_BOOT, seed=sw.BOOT_SEED)
    games = (df["week"].astype(str) + "|" + df["team"].astype(str)).to_numpy()
    by_game = paired_bootstrap(delta, games, n_boot=sw.N_BOOT, seed=sw.BOOT_SEED)
    return {"delta_mae_model_minus_naive": float(delta.mean()), "ci95_player": by_player["ci95"],
            "ci95_week_team": by_game["ci95"], "note": "conditional on the observed weeks"}


def week_complete(prep: sw.Prepared, season: int, week: int) -> bool:
    """team_presence_complete (spec §3.3): every scheduled team of the week has at least one played row."""
    teams = sw.week_teams(prep.schedule.games, season, week)
    f = prep.features
    have = set(f.loc[(f["season"] == season) & (f["week"] == week), "team"])
    return bool(teams) and teams <= have


def unprojected_summary(unproj: pd.DataFrame, played: pd.DataFrame) -> dict:
    def block(g: pd.DataFrame, n: int) -> dict:
        return {"count": int(len(g)), "share": (len(g) / n) if n else None, "mean_actual": _mean(g["actual"])}

    return {**block(unproj, len(played)),
            "by_position": {p: block(unproj[unproj["position"] == p], int((played["position"] == p).sum()))
                            for p in sorted(set(played["position"]))}}


def frame_sha256(df) -> str | None:
    if df is None:
        return None
    return hashlib.sha256(pd.util.hash_pandas_object(df, index=False).values.tobytes()).hexdigest()


def file_sha256(path: Path) -> str | None:
    p = Path(path)
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None


def input_hashes(weekly_raw: pd.DataFrame, schedules_raw: pd.DataFrame, crosswalk, rankings_raw,
                 bakeoff_path: Path = BAKEOFF_PATH) -> dict:
    """Spec §4.6 inputs: actuals for EVERY pulled season (the naive fallback means read prior seasons)."""
    return {"actuals_by_season": {str(int(s)): frame_sha256(g) for s, g in weekly_raw.groupby("season")},
            "schedules": frame_sha256(schedules_raw), "crosswalk": frame_sha256(crosswalk),
            "rankings_raw": frame_sha256(rankings_raw),
            "bakeoff": {"path": str(bakeoff_path), "sha256": file_sha256(bakeoff_path)}}


def evaluator_version(git, protocol: str) -> dict:
    """Spec §4.6: the CALLING artifact's own protocol version (live-accuracy-v1, sameweek-v1 or
    sleeper-compare-v1) + the tree id of src/ffmodel in the EXECUTING checkout + a dirty flag."""
    tree, dirty = git.tree_id("src/ffmodel"), bool(git.dirty("src/ffmodel"))
    return {"protocol_version": protocol, "src_ffmodel_tree": tree, "dirty": dirty,
            "id": f"{protocol}+{tree}" + ("+dirty" if dirty else "")}


@dataclass
class LiveContext:
    season: int
    weeks: list[int] | None          # None = every REG week whose K_N is before as_of
    as_of: pd.Timestamp              # run date (UTC, normalised, tz-naive)
    prepared: sw.Prepared            # sw.prepare over seasons S-3..S
    rankings: pd.DataFrame | None    # normalize_weekly_rankings(raw) for the secondary
    rankings_raw: pd.DataFrame | None
    crosswalk: pd.DataFrame | None
    ledger: dict
    git: object
    main_sha: str
    bakeoff: dict
    inputs: dict                     # input_hashes(...)


def _ranking_block(cells: list[dict]) -> dict:
    if not cells:
        return {"cells": 0}
    df = pd.DataFrame(cells)
    st = sw.delta_stats(df)
    return {"cells": int(len(df)), "sp_ours": float(df["sp_ours"].mean()), "sp_con": float(df["sp_con"].mean()),
            "D": st["D"], "ci_week": st["ci_week"],
            "per_position_D": {p: float((g["sp_ours"] - g["sp_con"]).mean()) for p, g in df.groupby("position")}}


def _reference(bakeoff: dict) -> dict:
    rows = [r for r in bakeoff["results"] if r["position"] == "OVERALL"]

    def nw(model, key):
        rs = [r for r in rows if r["model"] == model and r.get(key) is not None]
        return sum(r[key] * r["n"] for r in rs) / sum(r["n"] for r in rs)

    cov = {str(r["test_season"]): r["coverage_p10_p90"] for r in rows if r["model"] == "transformer"}
    return {"label": "context: different population and fallback history",
            "transformer_mae_2023_25": nw("transformer", "mae"), "naive_mae_2023_25": nw("naive_last4", "mae"),
            "coverage_by_season": cov}


def _primary(ctx: LiveContext, joined: pd.DataFrame, N: int, cutoff, rec: dict, blobs: dict) -> list[dict]:
    arc = select_archive(ctx.ledger, ctx.git, ctx.season, N, cutoff, ctx.main_sha)
    rec["expert_snapshot"] = {k: v for k, v in arc.items() if k != "consensus"}
    for item in [arc, *arc["alternatives"]]:
        if item.get("name") and item.get("blob_sha256"):
            blobs[item["name"]] = item["blob_sha256"]
    if arc["status"] != "selected":
        rec["primary"] = {"status": "skipped", "reason": arc["status"], "cells": []}
        return []
    pool = joined.rename(columns={"p50": "our_pts"}).merge(arc["consensus"][["player_id", "ecr"]], on="player_id")
    cells, deg = sw.build_cells(pool, ctx.season, N, "archive")
    rec["primary"] = {"status": "scored" if cells else "skipped", "reason": None if cells else "no_scorable_cell",
                      "cells": sw.cell_summary(cells), "degenerate": deg, "pool": int(len(pool)),
                      "pool_by_position": pool["position"].value_counts().sort_index().astype(int).to_dict()}
    return cells


def evaluate(ctx: LiveContext) -> dict:
    S, git, prep = ctx.season, ctx.git, ctx.prepared
    dates = prep.schedule.dates(S)                       # K_N/Z_N only for weeks whose schedule slice passes
    due = sw.week_dates(prep.schedule.games, S)          # which weeks have started: listing only, never a cutoff
    weeks = ctx.weeks or [w for w in sorted(due) if due[w][0] < ctx.as_of]
    weights = ppr_weights()
    index = candidate_index(ctx.ledger, git, S, ctx.main_sha)
    scored_frames, skipped, per_week, blobs = [], [], {}, {}
    primary_cells, secondary_cells = [], []
    for N in weeks:
        if N not in dates:
            per_week[str(N)] = {"validation": {"schedule": prep.schedule.week_validation(S, N).report()}}
            skipped.append({"week": N, "reason": "validation_failed", "detail": "schedule_dependency_failed"})
            continue
        K, Z = dates[N]
        cutoff = pd.Timestamp(K).tz_localize("UTC")
        rec = {"cutoff": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"), "last_game": str(Z.date())}
        per_week[str(N)] = rec
        if not week_complete(prep, S, N):
            skipped.append({"week": N, "reason": "incomplete_week"})
            continue
        pub = select_publication(ctx.ledger, git, S, N, cutoff, ctx.main_sha, index=index)
        rec["publication"] = pub
        if pub["status"] != "selected":
            skipped.append({"week": N, "reason": pub["status"], "detail": pub["detail"]})
            continue
        legacy, neutral = read_payloads(git, pub["commit"])
        vp, reason, detail = published_values(legacy, neutral, weights, S, N)
        rec["values"] = detail
        if reason:
            skipped.append({"week": N, "reason": reason})
            continue
        wi = sw.week_inputs(prep, S, N)
        rec["validation"] = {"projections": vp.report(), **wi["report"]}
        if vp.fails() or wi["failed"]:
            skipped.append({"week": N, "reason": "validation_failed"})
            continue
        act = wi["actuals"].valid.copy()
        act["actual"] = fantasy_points(act[PREDICTED_STATS], PPR).to_numpy()
        act["naive"] = naive_points(prep.features, act, S).to_numpy()
        joined = act[["player_id", "position", "team", "week", "actual", "naive"]].merge(
            vp.valid[["player_id", "p10", "p50", "p90"]], on="player_id", how="left")
        unproj = joined[joined["p50"].isna()]
        joined = joined.dropna(subset=["p50"]).reset_index(drop=True)
        rec["unprojected"] = unprojected_summary(unproj, act)
        if joined.empty:
            rec["status"] = "no_scorable_points"
            skipped.append({"week": N, "reason": "no_scorable_points"})
            continue
        rec["status"] = "scored"
        rec["points"] = point_metrics(joined)
        scored_frames.append(joined)
        primary_cells += _primary(ctx, joined, N, cutoff, rec, blobs)
        if ctx.rankings is not None and ctx.crosswalk is not None:
            played = joined.rename(columns={"p50": "our_pts"})[["player_id", "position", "team", "our_pts", "actual"]]
            res = sw.sameweek_week(played, prep.schedule, ctx.rankings, ctx.crosswalk, S, N, dates)
            secondary_cells += res["cells"]
            rec["secondary"] = {**{k: v for k, v in res.items() if k != "cells"},
                                "cells": sw.cell_summary(res["cells"])}
    allrows = pd.concat(scored_frames, ignore_index=True) if scored_frames else None
    points = {}
    if allrows is not None:
        points = {"overall": {**point_metrics(allrows), **paired_intervals(allrows)},
                  "by_position": {p: point_metrics(g) for p, g in allrows.groupby("position")},
                  "by_week": {str(w): {**point_metrics(g), "last_game": per_week[str(w)]["last_game"]}
                              for w, g in allrows.groupby("week")}}
    inputs = {**ctx.inputs, "archive_blobs": dict(sorted(blobs.items())),
              "ledger": {"sha256": ledger_sha256(ctx.ledger), "events": len(ctx.ledger["events"]),
                         "coverage": ctx.ledger["coverage"]}}
    coverage = (sw.ranking_coverage(ctx.rankings_raw, ctx.rankings, [S])
                if ctx.rankings is not None and ctx.rankings_raw is not None else {})
    return {"protocol_version": PROTOCOL_VERSION, "evaluator_version": evaluator_version(git, PROTOCOL_VERSION),
            "season": S,
            "inputs": inputs, "ranking_coverage": coverage,
            "weeks_scored": sorted(int(w) for w in (allrows["week"].unique() if allrows is not None else [])),
            "weeks_skipped": skipped, "weeks": per_week, "points": points,
            "ranking": {"primary": _ranking_block(primary_cells), "secondary": _ranking_block(secondary_cells)},
            "reference_context": {**_reference(ctx.bakeoff), "source": ctx.inputs.get("bakeoff")},
            "caveats": ["Projections = the bot pipeline's latest publication on main before K_N 00:00 UTC, proven "
                        "by GitHub push records; Vercel deployment is not verified.",
                        "Players who recorded a stat line only; DNPs are outside the estimand.",
                        "Both expert sources are FantasyPros mirrors; small samples are descriptive, not tests.",
                        "Reference values are context: the historical population and fallback history differ."]}


def _week_rank_cell(rec: dict, source: str) -> str:
    cells = (rec.get(source) or {}).get("cells") or []
    if not cells:
        return "—"
    return f"{np.mean([c['sp_ours'] for c in cells]):.3f} / {np.mean([c['sp_con'] for c in cells]):.3f}"


def _pct(x) -> str:
    return "—" if x is None else f"{x:.1%}"


def _num(x) -> str:
    return "—" if x is None else f"{x:.2f}"


def render_markdown(art: dict) -> str:
    o = art.get("points", {}).get("overall")
    lines = [f"# Live weekly accuracy — {art['season']}", ""]
    if o:
        lines.append(f"Through weeks {', '.join(map(str, art['weeks_scored']))}: MAE {_num(o['mae'])} vs naive "
                     f"{_num(o['naive_mae'])}; p10–p90 coverage {_pct(o['coverage_p10_p90'])} (below "
                     f"{_pct(o['below_p10'])}, above {_pct(o['above_p90'])}).")
    else:
        lines.append("No complete weeks scored yet.")
    prov = art.get("run", {}).get("provisional_weeks", [])
    lines += ["", f"Provisional: weeks {', '.join(map(str, prov)) if prov else 'none'}", "",
              "| week | last game | n | MAE | naive MAE | coverage | below | above | ours / consensus (archive) "
              "| ours / consensus (nflverse) |", "|---|---|---|---|---|---|---|---|---|---|"]
    weeks = art.get("weeks", {})
    for w, m in sorted(art.get("points", {}).get("by_week", {}).items(), key=lambda kv: int(kv[0])):
        rec = weeks.get(w, {})
        lines.append(f"| {w} | {m.get('last_game', '')} | {m['n']} | {_num(m['mae'])} | {_num(m['naive_mae'])} | "
                     f"{_pct(m['coverage_p10_p90'])} | {_pct(m['below_p10'])} | {_pct(m['above_p90'])} | "
                     f"{_week_rank_cell(rec, 'primary')} | {_week_rank_cell(rec, 'secondary')} |")
    for s in art.get("weeks_skipped", []):
        lines.append(f"- week {s['week']} skipped: {s['reason']}")
    lines += ["", *[f"- {c}" for c in art.get("caveats", [])], ""]
    return "\n".join(lines)


def serialise(art: dict) -> str:
    return json.dumps(art, indent=1, sort_keys=True, allow_nan=False) + "\n"


def output_path(season: int | None = None) -> Path:
    """models/diagnostics/live_<S>_weekly.json with S = current_nfl_season() unless given (spec §4.6)."""
    from ffmodel.data.pull import current_nfl_season

    return Path(f"models/diagnostics/live_{season or current_nfl_season()}_weekly.json")


def main(argv=None) -> int:
    from ffmodel.data.pull import LIVE_MAX_AGE_HOURS, _cached, current_nfl_season, pull_schedules, pull_weekly
    from ffmodel.data.rankings import pull_player_ids
    from ffmodel.eval.weekly_rankings import normalize_weekly_rankings

    ap = argparse.ArgumentParser(description="Live weekly accuracy scorecard (spec §4).")
    ap.add_argument("--season", type=int, default=None)
    ap.add_argument("--weeks", default=None, help="e.g. 1-4")
    ap.add_argument("--data-dir", type=Path, default=None)
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", "mtsilverstein/Megatron"))
    ap.add_argument("--main-ref", default="origin/main")
    ap.add_argument("--no-fetch", action="store_true", help="use the committed ledger without a new collection")
    ap.add_argument("--frozen-record", type=Path, default=None,
                    help="write the artifact here instead of publishing; implies --no-fetch (a freshly fetched "
                         "ledger is never saved, so the record must hash the committed one)")
    args = ap.parse_args(argv)
    args.no_fetch = args.no_fetch or args.frozen_record is not None
    S = args.season or current_nfl_season()
    weeks = None
    if args.weeks:
        a, b = (int(x) for x in args.weeks.split("-"))
        weeks = list(range(a, b + 1))
    data_dir = args.data_dir or Path(tempfile.mkdtemp(prefix="live-acc-"))
    now = dt.datetime.now(dt.timezone.utc)
    ledger = load_ledger(LEDGER_PATH)
    if not args.no_fetch:
        ledger = merge_collection(ledger, fetch_activity(args.repo), t_end=now.strftime("%Y-%m-%dT%H:%M:%SZ"))
    git = Git(".")
    main_sha = git.rev_parse(args.main_ref)
    spans = list(range(S - 3, S + 1))
    weekly, schedules = pull_weekly(spans, cache_dir=data_dir), pull_schedules(spans, cache_dir=data_dir)

    def load_rankings() -> pd.DataFrame:
        import nflreadpy

        return nflreadpy.load_ff_rankings("all").to_pandas()

    raw = _cached(data_dir, "ff_rankings_all_raw", load_rankings, LIVE_MAX_AGE_HOURS)
    crosswalk = pull_player_ids(data_dir)
    as_of = pd.Timestamp(now.date())
    ctx = LiveContext(season=S, weeks=weeks, as_of=as_of, prepared=sw.prepare(weekly, schedules),
                      rankings=normalize_weekly_rankings(raw), rankings_raw=raw, crosswalk=crosswalk, ledger=ledger,
                      git=git, main_sha=main_sha, bakeoff=json.loads(BAKEOFF_PATH.read_text(encoding="utf-8")),
                      inputs=input_hashes(weekly, schedules, crosswalk, raw))
    art = evaluate(ctx)
    dates = ctx.prepared.schedule.dates(S)
    art["run"] = {"run_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "as_of_date": str(as_of.date()), "main_sha": main_sha,
                  "provisional_weeks": [w for w in art["weeks_scored"]
                                        if (as_of - dates[w][1]).days < PROVISIONAL_DAYS]}
    text = serialise(art)
    if args.frozen_record:
        args.frozen_record.write_text(text, encoding="utf-8")
        return 0
    out = output_path(S)
    out.write_text(text, encoding="utf-8")
    out.with_suffix(".md").write_text(render_markdown(art), encoding="utf-8")
    if not args.no_fetch:
        save_ledger(ledger, LEDGER_PATH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
