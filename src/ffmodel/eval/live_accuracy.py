"""Live weekly accuracy scorecard (spec docs/superpowers/specs/2026-10-06-weekly-accuracy-sameweek-design.md §4).

Scores the projections the bot pipeline published before each week's cutoff, proven by GitHub push records
kept in a committed, append-only ledger. Git and the GitHub API are injected so tests run offline.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from ffmodel.eval import sameweek as sw

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
