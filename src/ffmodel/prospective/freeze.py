"""Prospective freeze (spec 2026-09-30 §7): cutoff guard, artifact build, hashed manifest.

    python -m ffmodel.prospective.freeze --season 2026 --origin 5 [--dry-run] [--contingency-origin9-only]
        [--now <ISO with tz; only with --dry-run, or with FREEZE_ALLOW_NOW=1 in tests>]

Every step fails closed with a distinct exit code. If a failure happens after the target directory was created the
directory is removed again, so nothing half-built is ever committed. Heavy work (nflverse pulls, exports, tags, the
Node materializer, tool versions) lives behind one injectable `Steps` object so the guard and manifest logic is
unit-tested without any of it.

Exit codes: 0 ok; 2 schedule lacks the origin week; 3 at/after cutoff or ambiguous clock; 4 stale/incomplete
stats or the input snapshot drifted during the build; 5 origin-reuse inputs differ from the reference origin; 6 target directory exists (never overwrite);
7 a required input missing or drifted; 8 a build step failed; 9 a required code file missing.
Exit 3 also covers: the clock read again after the build is at/after the cutoff on a real run, and `--now` on a
real run. Exit 5 also covers origin-9 code/model/input drift vs origin 5, and contingency-mode misuse.

Origin 9 (REUSE_FROM) must be byte-identical to origin 5 in everything except forecasts, tags and decisions: every
input (incl. the availability rates, copied from o5/inputs and never refreshed), every code file, the evaluator and
the models, checked against o5's manifest. `--contingency-origin9-only` (spec §7.5) is the predeclared path for a
missed origin-5 freeze: allowed only while o5 does not exist, freezes the same inputs fresh, is marked exploratory
in the manifest, and makes a later o5 freeze impossible.

A dry run (`--dry-run`, written to dryrun-o<O>/) checks and REPORTS the cutoff in the manifest but does not abort
when it has passed; the evaluator file is optional there. A real run aborts at/after cutoff.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from zoneinfo import ZoneInfo

PRIMARY = ["f12-1qb-ppr-6", "f10-1qb-ppr-6", "f12-1qb-ppr-4", "f12-1qb-half-4"]
EXPLORATORY = ["f12-sf-ppr-4"]
HISTORY_FIRST_SEASON = 2012  # export_origin_forecasts --first-season default: the span every export reads
FORMATS = PRIMARY + EXPLORATORY
LEAGUES, TRADES = 20, 125
LAST_WEEK = 17
REUSE_FROM = {9: 5}  # origin -> origin whose inputs/code/models it must reuse byte-for-byte
CONTINGENCY_REASON = "origin-5 freeze missed"
MARKET_SNAPSHOT = "data_snapshots/fantasypros_ecr_2026-09-08.csv"
SPEC = "docs/superpowers/specs/2026-09-30-roster-sim-v2-prospective-design.md"
MODEL_ROOTS = ["models/transformer/v1", "models/transformer/v1_s43", "models/transformer/v1_s44"]
REQUIRED_CODE = [
    "tools/prospective_materialize.cjs", "tools/trade_backtest.cjs", "tools/draft_sim.cjs",
    "site/assets/rostersim.js", "site/assets/ros.js", "site/assets/optimizer.js",
    "src/ffmodel/formats.py", "site/assets/formats.js", "tools/export_format_payloads.py",
    "src/ffmodel/prospective/freeze.py",
]
PY_CODE_ROOT = "src/ffmodel"  # every .py under it is frozen code (the forecast pipeline), spec review I1
EVALUATOR = "tools/prospective_eval.cjs"  # required for a real run, optional for a dry run
DEP_FILES = ["pyproject.toml", "package.json", "package-lock.json"]
ET = ZoneInfo("America/New_York")
TEXT_EXTS = (".js", ".cjs", ".mjs", ".py", ".json", ".yaml", ".yml", ".md", ".csv", ".txt", ".toml", ".cfg", ".ini")
HASH_RULE = "sha256; CRLF->LF for " + " ".join(TEXT_EXTS)
SCHEDULE_INPUT = "inputs/schedule_2026.csv"  # may legitimately differ between origins (flex scheduling)
PIP_FREEZE_INPUT = "inputs/pip_freeze.txt"
FROZEN_ENV = {"FFMODEL_CACHE_FROZEN": "1"}  # exporters/tags read the per-run snapshot, never download or expire


class FreezeError(Exception):
    def __init__(self, code: int, msg: str):
        super().__init__(msg)
        self.code, self.msg = code, msg


def sha256_file(p: Path) -> str:
    """The shared hashing rule (`HASH_RULE`): text files are hashed with every CRLF replaced by LF so a Windows
    checkout (core.autocrlf) verifies against the LF bytes the Linux freeze hashed; everything else is raw bytes.
    The JS evaluator implements the identical rule."""
    p = Path(p)
    if p.suffix.lower() in TEXT_EXTS:
        return hashlib.sha256(p.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


sha256_norm = sha256_file


def normalize_pip_freeze(text: str) -> str:
    """`pip freeze` minus the project's own line (an editable install prints a path or a git SHA that differs per
    checkout) and editable-install comments; sorted, LF-terminated. Everything else (every dependency pin) stays."""
    keep = []
    for ln in text.replace("\r\n", "\n").split("\n"):
        ln = ln.strip()
        low = ln.lower()
        if not ln or low.startswith("# editable") or "#egg=ffmodel" in low or low.startswith(("ffmodel==", "ffmodel @", "ffmodel ")):
            continue
        keep.append(ln)
    return "\n".join(sorted(keep)) + "\n"


def target_dir(root: Path, season: int, origin: int, dry_run: bool) -> Path:
    return root / "models" / "prospective" / str(season) / (f"dryrun-o{origin}" if dry_run else f"o{origin}")


def cutoff_utc(schedule, season: int, origin: int) -> dt.datetime:
    """Earliest kickoff (UTC) of week `origin` REG games. Fail closed on a missing/ambiguous week."""
    rows = schedule[(schedule["season"] == season) & (schedule["week"] == origin)]
    if "game_type" in rows.columns:
        rows = rows[rows["game_type"] == "REG"]
    if len(rows) == 0:
        raise FreezeError(2, f"schedule has no REG games for {season} week {origin}")
    kicks = []
    for _, r in rows.iterrows():
        gd, gt = str(r["gameday"])[:10], str(r["gametime"])
        if gd in ("", "nan", "None", "NaT") or gt in ("", "nan", "None"):
            raise FreezeError(2, f"week {origin} game {r['away_team']}@{r['home_team']} lacks gameday/gametime")
        hh, mm = gt.split(":")[:2]
        y, mo, d = (int(x) for x in gd.split("-"))
        kicks.append(dt.datetime(y, mo, d, int(hh), int(mm), tzinfo=ET).astimezone(dt.timezone.utc))
    return min(kicks)


def check_fresh(schedule, weekly_teams, season: int, origin: int) -> None:
    """Every REG game of weeks < origin must have both teams present in the pulled weekly stats.

    `weekly_teams` is a frame of (week, team) already restricted to `season`."""
    sch = schedule[(schedule["season"] == season) & (schedule["week"] < origin)]
    if "game_type" in sch.columns:
        sch = sch[sch["game_type"] == "REG"]
    have = {(int(w), t) for w, t in zip(weekly_teams["week"], weekly_teams["team"])}
    missing = sorted({(int(g["week"]), g[side]) for _, g in sch.iterrows()
                      for side in ("home_team", "away_team") if (int(g["week"]), g[side]) not in have})
    if missing:
        raise FreezeError(4, f"weekly stats missing {len(missing)} team-weeks, e.g. {missing[:6]}")


class Steps:
    """The heavy, side-effecting operations. Tests replace this whole object."""

    def __init__(self, root: Path):
        self.root = root

    def _run(self, cmd: list[str], what: str, env: dict | None = None) -> str:
        r = subprocess.run(cmd, cwd=self.root, capture_output=True, text=True,
                           env={**os.environ, **env} if env else None)
        if r.returncode != 0:
            raise FreezeError(8, f"{what} failed (exit {r.returncode}): {(r.stderr or r.stdout)[-800:]}")
        return r.stdout

    def prefetch(self, season: int, dest: Path, *, attempts: int = 4, backoff=(30, 60, 120), sleep=time.sleep) -> None:
        """Pull every feed the exports and tags read, once, INTO `dest` (a fresh per-run snapshot dir; the shared
        data/raw cache is never read, written or deleted), retrying transient download failures (nflverse is served
        from GitHub release assets, which do return 5xx). Every exporter and the tags CLI then read these files
        frozen (FFMODEL_CACHE_FROZEN=1), so a network hiccup cannot abort the build and no expiry-based refresh can
        change an input after the freshness guard validated it. A pull that still fails after the last attempt fails
        the freeze (exit 8)."""
        from ffmodel.data.pull import pull_injuries, pull_schedules, pull_weekly

        span, dest = list(range(HISTORY_FIRST_SEASON, season + 1)), Path(dest)
        for what, pull in (("weekly stats", lambda: pull_weekly(span, cache_dir=dest)),
                           ("schedules", lambda: pull_schedules(span, cache_dir=dest)),
                           ("injuries", lambda: pull_injuries([season], cache_dir=dest))):
            for i in range(attempts):
                try:
                    pull()
                    break
                except Exception as e:  # network errors surface as several exception types
                    if i == attempts - 1:
                        raise FreezeError(8, f"prefetch {what} failed after {attempts} attempts: {e}") from e
                    print(f"prefetch {what}: attempt {i + 1} failed ({e}); retrying in {backoff[min(i, len(backoff) - 1)]}s",
                          file=sys.stderr)
                    sleep(backoff[min(i, len(backoff) - 1)])

    def schedule(self, season: int):
        import nflreadpy  # deferred: offline tests never import it

        df = nflreadpy.load_schedules([season]).to_pandas()
        from ffmodel.data.pull import normalize_schedule_teams

        df = normalize_schedule_teams(df[df["game_type"] == "REG"])
        return df[["season", "week", "gameday", "gametime", "home_team", "away_team"]].reset_index(drop=True)

    def weekly_teams(self, season: int, data_dir: Path):
        """(week, team) of the EXACT weekly-stats snapshot the exporters consume: same span as `prefetch` and
        `export_origin_forecasts`, read frozen from the per-run snapshot dir, so the guard validates the very file
        every exporter reads, never an independent pull."""
        from ffmodel.data.pull import pull_weekly

        w = pull_weekly(list(range(HISTORY_FIRST_SEASON, season + 1)), cache_dir=Path(data_dir))
        w = w[w["season"] == season]
        return w[["week", "team"]].drop_duplicates().reset_index(drop=True)

    def export_forecasts(self, season: int, origin: int, label: str, out: Path, data_dir: Path) -> None:
        self._run([sys.executable, "-m", "ffmodel.eval.export_origin_forecasts", "--season", str(season),
                   "--origin", str(origin), "--last-week", str(LAST_WEEK), "--league-dir", "configs/formats",
                   "--league", label, "--data-dir", str(data_dir), "--out", str(out)], f"export {label}",
                  env=FROZEN_ENV)

    def tags(self, season: int, week: int, out: Path, data_dir: Path) -> None:
        # matches availability.tags_main: `availability tags --season --week [--data-dir] --out`
        self._run([sys.executable, "-m", "ffmodel.eval.availability", "tags", "--season", str(season),
                   "--week", str(week), "--data-dir", str(data_dir), "--out", str(out)], "availability tags",
                  env=FROZEN_ENV)

    def format_payloads(self, out: Path) -> None:
        self._run([sys.executable, "tools/export_format_payloads.py", "--out", str(out)], "format payloads")

    def materialize(self, season: int, origin: int, *, worlds_dir: Path, forecasts_dir: Path, tags: Path,
                    payloads: Path, out: Path, reuse_drafts: Path | None = None) -> None:
        cmd = ["node", "tools/prospective_materialize.cjs", "--season", str(season), "--origin", str(origin),
               "--formats", ",".join(PRIMARY), "--exploratory", ",".join(EXPLORATORY),
               "--worlds-dir", str(worlds_dir), "--forecasts-dir", str(forecasts_dir), "--tags", str(tags),
               "--format-payloads", str(payloads), "--leagues", str(LEAGUES), "--trades", str(TRADES),
               "--out", str(out)]
        if reuse_drafts is not None:  # origin 9: reuse origin 5's frozen drafts (spec §7.4), never re-draft
            cmd += ["--reuse-drafts", str(reuse_drafts)]
        self._run(cmd, "materialize")

    def pip_freeze(self) -> str:
        return normalize_pip_freeze(self._run([sys.executable, "-m", "pip", "freeze"], "pip freeze"))

    def versions(self) -> dict:
        return {
            "node": self._run(["node", "--version"], "node --version").strip(),
            "python": sys.version.split()[0],
            "git_head": self._run(["git", "rev-parse", "HEAD"], "git rev-parse").strip(),
            "git_dirty": bool(self._run(["git", "status", "--porcelain", "--untracked-files=no"],
                                        "git status").strip()),
        }


def snapshot_hashes(d: Path) -> dict:
    """sha256 of every file under the per-run input snapshot dir (relative posix path -> hash)."""
    return {p.relative_to(d).as_posix(): sha256_file(p) for p in sorted(Path(d).rglob("*")) if p.is_file()}


def _copy(src: Path, dst: Path) -> None:
    if not src.is_file():
        raise FreezeError(7, f"required input missing: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)


def _stage_inputs(root: Path, season: int, tdir: Path, avail_src: Path | None = None) -> None:
    inp = tdir / "inputs"
    base = root / "models" / "prospective" / str(season)
    _copy(base / "rho.json", inp / "rho.json")
    for label in FORMATS:
        _copy(base / f"world_{season}_{label}.json", inp / "worlds" / f"world_{season}_{label}.json")
        _copy(root / "configs" / "formats" / f"{label}.yaml", inp / "configs" / f"{label}.yaml")
    _copy(avail_src or root / "site" / "data" / "availability.json", inp / "availability.json")
    _copy(root / MARKET_SNAPSHOT, inp / "market" / Path(MARKET_SNAPSHOT).name)


def _code_hashes(root: Path, *, dry_run: bool) -> dict:
    code = {}
    py = sorted(p.relative_to(root).as_posix() for p in (root / PY_CODE_ROOT).rglob("*.py")
                if "__pycache__" not in p.parts)
    for rel in sorted(set(REQUIRED_CODE + py)) + [EVALUATOR]:
        p = root / rel
        if p.is_file():
            code[rel] = sha256_file(p)
        elif rel == EVALUATOR and dry_run:
            code[rel] = None  # recorded as absent; allowed in a dry run only
        else:
            raise FreezeError(9, f"required code file missing: {rel}")
    return code


def _model_hashes(root: Path) -> dict:
    models = {}
    for mr in MODEL_ROOTS:
        for p in sorted((root / mr).rglob("*")):
            if p.is_file():
                models[p.relative_to(root).as_posix()] = sha256_file(p)
    if not models:
        raise FreezeError(9, f"no model artifacts under {MODEL_ROOTS}")
    return models


def _load_ref_manifest(root: Path, season: int, origin: int, ref_origin: int) -> tuple[Path, dict]:
    ref_dir = target_dir(root, season, ref_origin, False)
    mf = ref_dir / "manifest.json"
    if not mf.is_file():
        raise FreezeError(5, f"origin {origin} reuses origin {ref_origin} but {mf} does not exist "
                             "(if the origin-5 freeze was missed use --contingency-origin9-only)")
    return ref_dir, json.loads(mf.read_text(encoding="utf-8"))


def _diff(kind: str, cur: dict, ref: dict, origin: int, ref_origin: int) -> None:
    bad = sorted(k for k in set(cur) | set(ref) if cur.get(k) != ref.get(k))
    if bad:
        raise FreezeError(5, f"origin {origin} {kind} differ from origin {ref_origin}'s manifest: {bad[:8]}")


def _check_reuse(root: Path, origin: int, ref_origin: int, ref: dict, tdir: Path, *, dry_run: bool,
                 versions: dict | None = None) -> None:
    """Origin-9 identity: only forecasts, tags and decisions may differ from o5 (spec §7.4). Checked against o5's
    manifest, in both directions, for inputs, code (engine, evaluator, materializer, ...) and models."""
    cur_inputs = {p.relative_to(tdir).as_posix(): sha256_file(p)
                  for p in sorted((tdir / "inputs").rglob("*")) if p.is_file()}
    cur_inputs.pop(SCHEDULE_INPUT, None)  # the schedule may differ (flex scheduling); it is recorded, not compared
    ref_inputs = {k: v for k, v in ref.get("files", {}).items() if k.startswith("inputs/") and k != SCHEDULE_INPUT}
    if versions is not None:  # same toolchain as the reference origin (the pip environment is an input, above)
        rv = ref.get("versions", {})
        bad = [k for k in ("node", "python") if versions.get(k) != rv.get(k)]
        if bad:
            raise FreezeError(5, f"origin {origin} toolchain differs from origin {ref_origin}'s: "
                                 + ", ".join(f"{k} {versions.get(k)} != {rv.get(k)}" for k in bad))
    _diff("inputs", cur_inputs, ref_inputs, origin, ref_origin)
    _diff("code", _code_hashes(root, dry_run=dry_run), ref.get("code", {}), origin, ref_origin)
    _diff("models", _model_hashes(root), ref.get("models", {}), origin, ref_origin)


def build_manifest(root: Path, season: int, origin: int, tdir: Path, *, dry_run: bool, cutoff, now, built_at,
                   versions: dict, cutoff_passed: bool, contingency: bool = False,
                   inputs_snapshot: dict | None = None) -> dict:
    files = {p.relative_to(tdir).as_posix(): sha256_file(p)
             for p in sorted(tdir.rglob("*")) if p.is_file() and p.name != "manifest.json"}
    code = _code_hashes(root, dry_run=dry_run)
    models = _model_hashes(root)
    deps = {rel: sha256_file(root / rel) for rel in DEP_FILES if (root / rel).is_file()}
    for p in sorted(root.glob("requirements*.txt")):
        deps[p.name] = sha256_file(p)
    spec = root / SPEC
    if not spec.is_file():
        raise FreezeError(9, f"spec missing: {SPEC}")
    return {
        "season": season, "origin": origin, "dry_run": dry_run, "exploratory": contingency,
        **({"reason": CONTINGENCY_REASON} if contingency else {}),
        "formats": {"primary": PRIMARY, "exploratory": EXPLORATORY},
        "cutoff_utc": cutoff.isoformat(), "cutoff_passed_at_now": cutoff_passed,
        "started_at": now.isoformat(), "built_at": built_at.isoformat(),
        "versions": versions, "hash_rule": HASH_RULE,
        "spec": {"path": SPEC, "sha256": sha256_file(spec)},
        "inputs_snapshot": inputs_snapshot or {},
        "files": files, "code": code, "models": models, "dependencies": deps,
    }


def run_freeze(season: int, origin: int, *, dry_run: bool, now: dt.datetime | None = None,
               steps: Steps | None = None, root: Path | None = None, contingency: bool = False,
               clock=None) -> str:
    """Run the freeze with a fresh, isolated, per-run input snapshot dir (astra I3), removed on success or failure.
    The shared data/raw cache is never touched. See `_run_freeze`."""
    snap = Path(tempfile.mkdtemp(prefix="ffmodel-freeze-"))
    try:
        return _run_freeze(season, origin, dry_run=dry_run, now=now, steps=steps, root=root,
                           contingency=contingency, clock=clock, snap=snap)
    finally:
        shutil.rmtree(snap, ignore_errors=True)


def _run_freeze(season: int, origin: int, *, dry_run: bool, now, steps, root, contingency: bool, clock,
                snap: Path) -> str:
    """Return the manifest SHA-256. Raises FreezeError; codes 2, 3, 4, 6 write nothing.

    `clock()` returns the current UTC time and is read again after the build, immediately before the manifest is
    written, so a run that started before the cutoff but finished after it is refused. By default it is the real
    clock, or the injected `now` when one is given (tests)."""
    root = root or Path(__file__).resolve().parents[3]
    steps = steps or Steps(root)
    if clock is None:
        clock = (lambda: now) if now is not None else (lambda: dt.datetime.now(dt.timezone.utc))
    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        raise FreezeError(3, "ambiguous clock: `now` has no timezone")
    now = now.astimezone(dt.timezone.utc)

    ref_origin = REUSE_FROM.get(origin)
    if contingency:
        if origin != 9 or dry_run:
            raise FreezeError(5, "--contingency-origin9-only is for a real origin-9 freeze only")
        if target_dir(root, season, 5, False).exists():
            raise FreezeError(5, "origin-5 freeze exists; the contingency path is only for a missed origin 5")
        ref_origin = None
    if origin == 5 and not dry_run:
        m9 = target_dir(root, season, 9, False) / "manifest.json"
        if m9.is_file() and json.loads(m9.read_text(encoding="utf-8")).get("exploratory"):
            raise FreezeError(5, "an exploratory contingency origin-9 freeze exists; origin 5 can no longer be frozen")

    steps.prefetch(season, snap)  # every feed the exporters/tags read, into the isolated snapshot dir
    snap_before = snapshot_hashes(snap)  # hashed before the guard so even a guard-time rewrite is caught below
    schedule = steps.schedule(season)
    cutoff = cutoff_utc(schedule, season, origin)
    passed = now >= cutoff
    if passed and not dry_run:
        raise FreezeError(3, f"now {now.isoformat()} is at/after cutoff {cutoff.isoformat()}")
    check_fresh(schedule, steps.weekly_teams(season, snap), season, origin)

    ref_dir = ref = None
    if ref_origin is not None:
        ref_dir, ref = _load_ref_manifest(root, season, origin, ref_origin)

    tdir = target_dir(root, season, origin, dry_run)
    if tdir.exists():
        raise FreezeError(6, f"{tdir} already exists; freezes are never overwritten")
    tdir.mkdir(parents=True)
    try:
        for label in FORMATS:
            steps.export_forecasts(season, origin, label, tdir / f"forecasts_{season}_o{origin}_{label}.json", snap)
        tags = tdir / f"tags_w{origin - 1}.json"
        steps.tags(season, origin - 1, tags, snap)
        avail_src = None
        if ref is not None:  # frozen availability rates: o5's bytes, verified against o5's manifest, never refreshed
            avail_src = ref_dir / "inputs" / "availability.json"
            if not avail_src.is_file() or sha256_file(avail_src) != ref.get("files", {}).get("inputs/availability.json"):
                raise FreezeError(5, f"o{ref_origin} availability.json is missing or differs from its manifest hash")
        _stage_inputs(root, season, tdir, avail_src)
        payloads = tdir / "inputs" / "format_payloads.json"
        steps.format_payloads(payloads)
        (tdir / SCHEDULE_INPUT).write_text(schedule.to_csv(index=False, lineterminator="\n"), encoding="utf-8", newline="")
        (tdir / PIP_FREEZE_INPUT).write_text(steps.pip_freeze(), encoding="utf-8", newline="")
        committed = root / "models" / "prospective" / str(season) / "format_payloads.json"
        if not committed.is_file() or sha256_file(committed) != sha256_file(payloads):
            raise FreezeError(7, "format_payloads.json regenerated from configs differs from the committed one")
        if ref is not None:
            _check_reuse(root, origin, ref_origin, ref, tdir, dry_run=dry_run, versions=steps.versions())
        kw = {"reuse_drafts": ref_dir / "decisions"} if ref is not None else {}  # contingency: no o5, fresh drafts
        steps.materialize(season, origin, worlds_dir=tdir / "inputs" / "worlds", forecasts_dir=tdir, tags=tags,
                          payloads=payloads, out=tdir / "decisions", **kw)
        if snapshot_hashes(snap) != snap_before:  # exporters/tags must have consumed exactly the validated inputs
            raise FreezeError(4, "input snapshot drifted during the build (file added, removed or changed); "
                                 "nothing committed")
        built_at = clock().astimezone(dt.timezone.utc)
        if not dry_run and built_at >= cutoff:
            raise FreezeError(3, f"build finished at {built_at.isoformat()}, at/after cutoff {cutoff.isoformat()}; "
                                 "nothing committed")
        manifest = build_manifest(root, season, origin, tdir, dry_run=dry_run, cutoff=cutoff, now=now,
                                  built_at=built_at, versions=steps.versions(), cutoff_passed=passed,
                                  contingency=contingency, inputs_snapshot=snap_before)
        body = (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode("utf-8")
        (tdir / "manifest.json").write_bytes(body)
    except BaseException:
        shutil.rmtree(tdir, ignore_errors=True)
        raise
    return hashlib.sha256(body).hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--origin", type=int, required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--contingency-origin9-only", action="store_true",
                    help="spec §7.5: freeze origin 9 fresh after a missed origin 5 (exploratory)")
    ap.add_argument("--now", default=None, help="ISO timestamp with tz; only with --dry-run (or FREEZE_ALLOW_NOW=1)")
    a = ap.parse_args(argv)
    now = None
    if a.now:
        if not a.dry_run and os.environ.get("FREEZE_ALLOW_NOW") != "1":
            print("FREEZE REFUSED (3): --now is only honored with --dry-run", file=sys.stderr)
            return 3
        try:
            now = dt.datetime.fromisoformat(a.now.replace("Z", "+00:00"))
        except ValueError as e:
            print(f"FREEZE REFUSED (3): unparseable --now: {e}", file=sys.stderr)
            return 3
    try:
        digest = run_freeze(a.season, a.origin, dry_run=a.dry_run, now=now, contingency=a.contingency_origin9_only)
    except FreezeError as e:
        print(f"FREEZE REFUSED ({e.code}): {e.msg}", file=sys.stderr)
        return e.code
    print(f"MANIFEST_SHA256={digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
