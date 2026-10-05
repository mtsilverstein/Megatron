"""Validate a batch stage, then copy it into `site/data` (spec §3.5, §10).

`ffmodel.site.batch` writes one run's legacy and neutral files into an EMPTY
stage directory and lists every one of them, with its sha256, in
`manifest.json`. This module checks the stage as a whole and only then copies
the listed files out. Only files listed in this run's manifest count: a
required file that is on disk but not in the manifest (carried over from an
earlier run) is an error, never a fallback.

There is no atomicity claim for the local copy. The all-or-nothing boundary is
the workflow's `Commit refreshed data` step, which runs only after this
module exits 0; a copy interrupted half-way is never committed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
from pathlib import Path, PurePosixPath

from ffmodel.site.leaguelens import STATS
from ffmodel.site.neutral import LAST_PROJECTED_WEEK

# Bound on `neutral/remaining.json`; derived from tests/fixtures/neutral_size_measurement.json.
SIZE_CAP_BYTES = 4_600_000

MANIFEST = "manifest.json"
BATCH_FIELDS = ("season", "week", "data_through", "generated_at", "batch_id")
LEGACY_REQUIRED = ("weekly.json", "weekly-fam.json", "remaining-gabagool.json",
                   "remaining-fam.json", "kickoffs.json", "roles.json", "about.json")
# Neutral document -> (kind, schema_version).
NEUTRAL = {
    "neutral/weekly.json": ("neutral_weekly", 1),
    "neutral/remaining.json": ("neutral_remaining", 2),
    "neutral/players.json": ("neutral_players", 1),
    "neutral/evaluation.json": ("neutral_evaluation", 1),
    "neutral/formats.json": ("neutral_formats", 1),
}
REQUIRED = LEGACY_REQUIRED + tuple(NEUTRAL)
_LEGACY_WEEKLY = re.compile(r"^weekly(-[a-z0-9]+)?\.json$")
_LEGACY_REMAINING = re.compile(r"^remaining-[a-z0-9]+\.json$")
_ROW_STATUSES = ("conditional_projection", "bye", "unmodeled")
_FORMAT_FIELDS = ("label", "format_key", "compat", "description", "exploratory")


def _sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _reject_constant(name):
    raise ValueError(f"non-finite JSON constant {name}")


def _load_json(path: Path):
    """Strict JSON: NaN/Infinity literals are rejected, as a browser would."""
    return json.loads(Path(path).read_bytes().decode("utf-8"), parse_constant=_reject_constant)


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _stat_vector(v) -> bool:
    return isinstance(v, list) and len(v) == len(STATS) and all(_finite(x) for x in v)


def _safe_path(rel) -> bool:
    if not isinstance(rel, str) or not rel or "\\" in rel or ":" in rel:
        return False
    p = PurePosixPath(rel)
    return not p.is_absolute() and ".." not in p.parts and "." not in p.parts and rel != MANIFEST


def _manifest(stage: Path, errors: list[str]) -> dict[str, Path] | None:
    """Listed path -> stage file, for entries that exist with their sha256."""
    path = stage / MANIFEST
    if not path.is_file():
        errors.append(f"{MANIFEST}: missing from the stage (no complete batch was written)")
        return None
    try:
        manifest = _load_json(path)
    except ValueError as exc:
        errors.append(f"{MANIFEST}: invalid JSON ({exc})")
        return None
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, list):
        errors.append(f"{MANIFEST}: no `files` list")
        return None
    listed: dict[str, Path] = {}
    for entry in files:
        rel = entry.get("path") if isinstance(entry, dict) else None
        sha = entry.get("sha256") if isinstance(entry, dict) else None
        if not _safe_path(rel):
            errors.append(f"{MANIFEST}: unsafe or malformed path {rel!r}")
            continue
        if rel in listed:
            errors.append(f"{MANIFEST}: path {rel} listed twice")
            continue
        file = stage / rel
        if not file.is_file():
            errors.append(f"{rel}: listed in the manifest but missing from the stage")
        elif not isinstance(sha, str) or _sha256(file) != sha:
            errors.append(f"{rel}: sha256 does not match the manifest")
        else:
            listed[rel] = file
    return listed


def _neutral_header(docs: dict, manifest: dict, errors: list[str]) -> dict | None:
    headers = {}
    for name, (kind, version) in NEUTRAL.items():
        doc = docs[name]
        if not isinstance(doc, dict):
            errors.append(f"{name}: not a JSON object (missing the batch envelope)")
            continue
        if doc.get("kind") != kind:
            errors.append(f"{name}: kind {doc.get('kind')!r}, expected {kind!r}")
        if doc.get("schema_version") != version:
            errors.append(f"{name}: schema_version {doc.get('schema_version')!r}, expected {version}")
        missing = [f for f in BATCH_FIELDS if f not in doc]
        if missing:
            errors.append(f"{name}: missing batch field(s) {missing}")
            continue
        headers[name] = tuple(doc[f] for f in BATCH_FIELDS)
    if isinstance(manifest, dict):
        headers[MANIFEST] = tuple(manifest.get(f) for f in BATCH_FIELDS)
    if len(set(headers.values())) > 1:
        detail = "; ".join(f"{n}: {dict(zip(BATCH_FIELDS, h))}" for n, h in headers.items())
        errors.append(f"batch fields disagree across the batch ({detail})")
        return None
    if len(headers) <= 1:   # every neutral document was malformed
        return None
    return dict(zip(BATCH_FIELDS, next(iter(headers.values()))))


def _check_legacy(docs: dict, ctx: dict, errors: list[str]) -> None:
    def agree(name, doc, pairs):
        if not isinstance(doc, dict):
            errors.append(f"{name}: not a JSON object")
            return
        for field, want in pairs:
            if doc.get(field) != want:
                errors.append(f"{name}: {field} {doc.get(field)!r} != neutral {want!r}")

    for name, doc in docs.items():
        if _LEGACY_WEEKLY.match(name):
            agree(name, doc, (("season", ctx["season"]), ("week", ctx["week"]),
                              ("data_through", ctx["data_through"])))
        elif _LEGACY_REMAINING.match(name):
            agree(name, doc, (("season", ctx["season"]), ("start_week", ctx["week"]),
                              ("data_through", ctx["data_through"])))
    agree("kickoffs.json", docs["kickoffs.json"], (("season", ctx["season"]), ("week", ctx["week"])))
    agree("roles.json", docs["roles.json"], (("season", ctx["season"]), ("before_week", ctx["week"])))


def _players(doc, name: str, errors: list[str]) -> list:
    players = doc.get("players") if isinstance(doc, dict) else None
    if not isinstance(players, list) or not all(isinstance(p, dict) for p in players):
        errors.append(f"{name}: `players` must be a list of objects")
        return []
    return players


def _ids(players: list, name: str, errors: list[str]) -> set:
    ids, dups = set(), set()
    for p in players:
        pid = p.get("player_id")
        if not isinstance(pid, str) or not pid:
            errors.append(f"{name}: player without a string player_id")
            continue
        (dups if pid in ids else ids).add(pid)
    if dups:
        errors.append(f"{name}: duplicate player_id(s) {sorted(dups)}")
    return ids


def _check_remaining(doc: dict, ctx: dict, errors: list[str]) -> list:
    name = "neutral/remaining.json"
    week = ctx["week"]
    if doc.get("start_week") != week:
        errors.append(f"{name}: start_week {doc.get('start_week')!r} != batch week {week}")
    if week > LAST_PROJECTED_WEEK:
        if doc.get("status") != "no_remaining_weeks" or doc.get("players") != []:
            errors.append(f"{name}: week {week} is past week {LAST_PROJECTED_WEEK}; expected the "
                          f"empty no_remaining_weeks state")
        return []
    if doc.get("status") == "no_remaining_weeks":
        errors.append(f"{name}: no_remaining_weeks in week {week}, before week {LAST_PROJECTED_WEEK} ends")
    if doc.get("end_week") != LAST_PROJECTED_WEEK:
        errors.append(f"{name}: end_week {doc.get('end_week')!r} != {LAST_PROJECTED_WEEK}")
    if doc.get("stat_order") != list(STATS):
        errors.append(f"{name}: stat_order differs from the published STATS order")
    players = _players(doc, name, errors)
    for p in players:
        pid = p.get("player_id")
        weeks = p.get("weeks")
        if not isinstance(weeks, list):
            errors.append(f"{name}: {pid}: `weeks` must be a list")
            continue
        seen = set()
        for row in weeks:
            w = row.get("week") if isinstance(row, dict) else None
            if not isinstance(w, int) or isinstance(w, bool) or not week <= w <= LAST_PROJECTED_WEEK:
                errors.append(f"{name}: {pid}: row week {w!r} outside {week}..{LAST_PROJECTED_WEEK}")
                continue
            if w in seen:
                errors.append(f"{name}: duplicate (player_id, week) row ({pid}, {w})")
            seen.add(w)
            status = row.get("status")
            if status not in _ROW_STATUSES:
                errors.append(f"{name}: {pid} week {w}: unknown status {status!r}")
            if status != "conditional_projection":
                continue
            stats = row.get("stats")
            if not isinstance(stats, list) or len(stats) != 3:
                errors.append(f"{name}: {pid} week {w}: stats must be [p10, p50, p90]")
                continue
            p10, p50, p90 = stats
            if not _stat_vector(p50):
                errors.append(f"{name}: {pid} week {w}: p50 must be {len(STATS)} finite numbers")
            if (p10 is None) != (p90 is None):
                errors.append(f"{name}: {pid} week {w}: one-sided p10/p90 band")
            elif p10 is not None and not (_stat_vector(p10) and _stat_vector(p90)):
                errors.append(f"{name}: {pid} week {w}: p10/p90 must each be {len(STATS)} finite numbers")
    return players


def _check_neutral(docs: dict, ctx: dict, errors: list[str]) -> None:
    weekly = _players(docs["neutral/weekly.json"], "neutral/weekly.json", errors)
    weekly_ids = _ids(weekly, "neutral/weekly.json", errors)
    remaining = _check_remaining(docs["neutral/remaining.json"], ctx, errors)
    remaining_ids = _ids(remaining, "neutral/remaining.json", errors)
    players = _players(docs["neutral/players.json"], "neutral/players.json", errors)
    player_ids = _ids(players, "neutral/players.json", errors)
    absent = sorted((weekly_ids | remaining_ids) - player_ids)
    if absent:
        errors.append(f"neutral/players.json: projected player(s) absent {absent[:20]}"
                      + (f" (+{len(absent) - 20} more)" if len(absent) > 20 else ""))
    sleeper, dups = set(), set()
    for p in players:
        sid = p.get("sleeper_id")
        if sid is None or p.get("identity_only") is not False:
            continue
        (dups if sid in sleeper else sleeper).add(sid)
    if dups:
        errors.append(f"neutral/players.json: duplicate sleeper_id(s) among scorable players {sorted(dups)}")
    formats = docs["neutral/formats.json"].get("formats")
    if (not isinstance(formats, list) or not formats
            or not all(isinstance(f, dict) and all(k in f for k in _FORMAT_FIELDS) for f in formats)):
        errors.append(f"neutral/formats.json: `formats` must be a non-empty list of {list(_FORMAT_FIELDS)}")
    if not isinstance(docs["neutral/evaluation.json"].get("records"), list):
        errors.append("neutral/evaluation.json: `records` must be a list")


def validate(stage) -> list[str]:
    """Every problem with the stage, or `[]` when it may be published."""
    stage = Path(stage)
    errors: list[str] = []
    listed = _manifest(stage, errors)
    if listed is None:
        return errors
    for name in REQUIRED:
        if name in listed:
            continue
        if (stage / name).exists() and not any(e.startswith(f"{name}:") for e in errors):
            errors.append(f"{name}: on disk but not listed in the manifest (not produced by this run)")
        elif not any(e.startswith(f"{name}:") for e in errors):
            errors.append(f"{name}: required file missing from the stage")
    docs = {}
    for rel, file in listed.items():
        if rel.endswith(".json"):
            try:
                docs[rel] = _load_json(file)
            except ValueError as exc:
                errors.append(f"{rel}: invalid JSON ({exc})")
    if any(name not in docs for name in REQUIRED):
        return errors
    manifest = _load_json(stage / MANIFEST)
    ctx = _neutral_header(docs, manifest, errors)
    if ctx is not None:
        _check_legacy(docs, ctx, errors)
        if all(isinstance(docs[n], dict) for n in NEUTRAL):
            _check_neutral(docs, ctx, errors)
    size = (stage / "neutral/remaining.json").stat().st_size
    if size > SIZE_CAP_BYTES:
        errors.append(f"neutral/remaining.json: oversize ({size} bytes > cap {SIZE_CAP_BYTES}); "
                      f"players or weeks are never dropped to fit")
    return errors


def copy(stage, out) -> list[str]:
    """Copy every manifest-listed file into `out`; refuses an invalid stage.

    Each file is replaced individually (tmp + `os.replace`), so no single file
    is ever left half-written. The set as a whole is NOT atomic here: the
    workflow's commit step is the boundary."""
    stage, out = Path(stage), Path(out)
    errors = validate(stage)
    if errors:
        raise ValueError("refusing to copy an invalid stage: " + "; ".join(errors))
    files = [entry["path"] for entry in _load_json(stage / MANIFEST)["files"]]
    for rel in files:
        dest = out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".publish-tmp")
        try:
            shutil.copyfile(stage / rel, tmp)
            os.replace(tmp, dest)
        finally:
            if tmp.exists():
                tmp.unlink()
    return files


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Validate a batch stage and copy it into site/data.")
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    errors = validate(args.stage)
    if errors:
        print(f"publish refused: {len(errors)} problem(s) in {args.stage}", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    files = copy(args.stage, args.out)
    print(f"published {len(files)} file(s) from {args.stage} to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
