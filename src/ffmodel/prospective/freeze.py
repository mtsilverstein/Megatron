"""Prospective freeze (spec 2026-09-30 §7): cutoff guard, artifact build, hashed manifest.

    python -m ffmodel.prospective.freeze --season 2026 --origin 5 [--dry-run] [--now <ISO with tz, tests only>]

Every step fails closed with a distinct exit code. If a failure happens after the target directory was created the
directory is removed again, so nothing half-built is ever committed. Heavy work (nflverse pulls, exports, tags, the
Node materializer, tool versions) lives behind one injectable `Steps` object so the guard and manifest logic is
unit-tested without any of it.

Exit codes: 0 ok; 2 schedule lacks the origin week; 3 at/after cutoff or ambiguous clock; 4 stale/incomplete
stats; 5 origin-reuse inputs differ from the reference origin; 6 target directory exists (never overwrite);
7 a required input missing or drifted; 8 a build step failed; 9 a required code file missing.

A dry run (`--dry-run`, written to dryrun-o<O>/) checks and REPORTS the cutoff in the manifest but does not abort
when it has passed; the evaluator file is optional there. A real run aborts at/after cutoff.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

PRIMARY = ["f12-1qb-ppr-6", "f10-1qb-ppr-6", "f12-1qb-ppr-4", "f12-1qb-half-4"]
EXPLORATORY = ["f12-sf-ppr-4"]
FORMATS = PRIMARY + EXPLORATORY
LEAGUES, TRADES = 20, 125
LAST_WEEK = 17
REUSE_FROM = {9: 5}  # origin -> origin whose rho/worlds/configs/payloads/market it must reuse byte-for-byte
REFRESHABLE = {"availability.json"}  # origin inputs that legitimately refresh between origins
MARKET_SNAPSHOT = "data_snapshots/fantasypros_ecr_2026-09-08.csv"
SPEC = "docs/superpowers/specs/2026-09-30-roster-sim-v2-prospective-design.md"
MODEL_ROOTS = ["models/transformer/v1", "models/transformer/v1_s43", "models/transformer/v1_s44"]
REQUIRED_CODE = [
    "tools/prospective_materialize.cjs", "tools/trade_backtest.cjs", "tools/draft_sim.cjs",
    "site/assets/rostersim.js", "site/assets/ros.js", "site/assets/optimizer.js",
    "src/ffmodel/formats.py", "site/assets/formats.js", "tools/export_format_payloads.py",
    "src/ffmodel/prospective/freeze.py",
]
EVALUATOR = "tools/prospective_eval.cjs"  # required for a real run, optional for a dry run
DEP_FILES = ["pyproject.toml", "package.json", "package-lock.json"]
ET = ZoneInfo("America/New_York")


class FreezeError(Exception):
    def __init__(self, code: int, msg: str):
        super().__init__(msg)
        self.code, self.msg = code, msg


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


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

    def _run(self, cmd: list[str], what: str) -> str:
        r = subprocess.run(cmd, cwd=self.root, capture_output=True, text=True)
        if r.returncode != 0:
            raise FreezeError(8, f"{what} failed (exit {r.returncode}): {(r.stderr or r.stdout)[-800:]}")
        return r.stdout

    def schedule(self, season: int):
        import nflreadpy  # deferred: offline tests never import it

        df = nflreadpy.load_schedules([season]).to_pandas()
        from ffmodel.data.pull import normalize_schedule_teams

        df = normalize_schedule_teams(df[df["game_type"] == "REG"])
        return df[["season", "week", "gameday", "gametime", "home_team", "away_team"]].reset_index(drop=True)

    def weekly_teams(self, season: int):
        from ffmodel.data.pull import pull_weekly

        w = pull_weekly([season])
        w = w[w["season"] == season]
        return w[["week", "team"]].drop_duplicates().reset_index(drop=True)

    def export_forecasts(self, season: int, origin: int, label: str, out: Path) -> None:
        self._run([sys.executable, "-m", "ffmodel.eval.export_origin_forecasts", "--season", str(season),
                   "--origin", str(origin), "--last-week", str(LAST_WEEK), "--league-dir", "configs/formats",
                   "--league", label, "--out", str(out)], f"export {label}")

    def tags(self, season: int, week: int, out: Path) -> None:
        self._run([sys.executable, "-m", "ffmodel.eval.availability", "tags", "--season", str(season),
                   "--week", str(week), "--out", str(out)], "availability tags")

    def format_payloads(self, out: Path) -> None:
        self._run([sys.executable, "tools/export_format_payloads.py", "--out", str(out)], "format payloads")

    def materialize(self, season: int, origin: int, *, worlds_dir: Path, forecasts_dir: Path, tags: Path,
                    payloads: Path, out: Path) -> None:
        self._run(["node", "tools/prospective_materialize.cjs", "--season", str(season), "--origin", str(origin),
                   "--formats", ",".join(PRIMARY), "--exploratory", ",".join(EXPLORATORY),
                   "--worlds-dir", str(worlds_dir), "--forecasts-dir", str(forecasts_dir), "--tags", str(tags),
                   "--format-payloads", str(payloads), "--leagues", str(LEAGUES), "--trades", str(TRADES),
                   "--out", str(out)], "materialize")

    def versions(self) -> dict:
        return {
            "node": self._run(["node", "--version"], "node --version").strip(),
            "python": sys.version.split()[0],
            "git_head": self._run(["git", "rev-parse", "HEAD"], "git rev-parse").strip(),
            "git_dirty": bool(self._run(["git", "status", "--porcelain", "--untracked-files=no"],
                                        "git status").strip()),
        }


def _copy(src: Path, dst: Path) -> None:
    if not src.is_file():
        raise FreezeError(7, f"required input missing: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)


def _stage_inputs(root: Path, season: int, tdir: Path) -> None:
    inp = tdir / "inputs"
    base = root / "models" / "prospective" / str(season)
    _copy(base / "rho.json", inp / "rho.json")
    for label in FORMATS:
        _copy(base / f"world_{season}_{label}.json", inp / "worlds" / f"world_{season}_{label}.json")
        _copy(root / "configs" / "formats" / f"{label}.yaml", inp / "configs" / f"{label}.yaml")
    _copy(root / "site" / "data" / "availability.json", inp / "availability.json")
    _copy(root / MARKET_SNAPSHOT, inp / "market" / Path(MARKET_SNAPSHOT).name)


def _check_reuse(root: Path, season: int, origin: int, tdir: Path) -> None:
    ref_origin = REUSE_FROM.get(origin)
    if ref_origin is None:
        return
    ref = target_dir(root, season, ref_origin, False) / "inputs"
    if not ref.is_dir():
        raise FreezeError(5, f"origin {origin} reuses origin {ref_origin}'s inputs but {ref} does not exist")
    for p in sorted((tdir / "inputs").rglob("*")):
        rel = p.relative_to(tdir / "inputs").as_posix()
        if not p.is_file() or rel in REFRESHABLE:
            continue
        q = ref / rel
        if not q.is_file() or sha256_file(q) != sha256_file(p):
            raise FreezeError(5, f"origin {origin} input {rel} differs from origin {ref_origin}'s")


def build_manifest(root: Path, season: int, origin: int, tdir: Path, *, dry_run: bool, cutoff, now,
                   versions: dict, cutoff_passed: bool) -> dict:
    files = {p.relative_to(tdir).as_posix(): sha256_file(p)
             for p in sorted(tdir.rglob("*")) if p.is_file() and p.name != "manifest.json"}
    code = {}
    for rel in REQUIRED_CODE + [EVALUATOR]:
        p = root / rel
        if p.is_file():
            code[rel] = sha256_file(p)
        elif rel == EVALUATOR and dry_run:
            code[rel] = None  # recorded as absent; allowed in a dry run only
        else:
            raise FreezeError(9, f"required code file missing: {rel}")
    models = {}
    for mr in MODEL_ROOTS:
        for p in sorted((root / mr).rglob("*")):
            if p.is_file():
                models[p.relative_to(root).as_posix()] = sha256_file(p)
    if not models:
        raise FreezeError(9, f"no model artifacts under {MODEL_ROOTS}")
    deps = {rel: sha256_file(root / rel) for rel in DEP_FILES if (root / rel).is_file()}
    for p in sorted(root.glob("requirements*.txt")):
        deps[p.name] = sha256_file(p)
    spec = root / SPEC
    if not spec.is_file():
        raise FreezeError(9, f"spec missing: {SPEC}")
    return {
        "season": season, "origin": origin, "dry_run": dry_run,
        "formats": {"primary": PRIMARY, "exploratory": EXPLORATORY},
        "cutoff_utc": cutoff.isoformat(), "cutoff_passed_at_now": cutoff_passed,
        "now": now.isoformat(),
        "versions": versions,
        "spec": {"path": SPEC, "sha256": sha256_file(spec)},
        "files": files, "code": code, "models": models, "dependencies": deps,
    }


def run_freeze(season: int, origin: int, *, dry_run: bool, now: dt.datetime | None = None,
               steps: Steps | None = None, root: Path | None = None) -> str:
    """Return the manifest SHA-256. Raises FreezeError; codes 2, 3, 4, 6 write nothing."""
    root = root or Path(__file__).resolve().parents[3]
    steps = steps or Steps(root)
    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        raise FreezeError(3, "ambiguous clock: `now` has no timezone")
    now = now.astimezone(dt.timezone.utc)

    schedule = steps.schedule(season)
    cutoff = cutoff_utc(schedule, season, origin)
    passed = now >= cutoff
    if passed and not dry_run:
        raise FreezeError(3, f"now {now.isoformat()} is at/after cutoff {cutoff.isoformat()}")
    check_fresh(schedule, steps.weekly_teams(season), season, origin)

    tdir = target_dir(root, season, origin, dry_run)
    if tdir.exists():
        raise FreezeError(6, f"{tdir} already exists; freezes are never overwritten")
    tdir.mkdir(parents=True)
    try:
        for label in FORMATS:
            steps.export_forecasts(season, origin, label, tdir / f"forecasts_{season}_o{origin}_{label}.json")
        tags = tdir / f"tags_w{origin - 1}.json"
        steps.tags(season, origin - 1, tags)
        _stage_inputs(root, season, tdir)
        payloads = tdir / "inputs" / "format_payloads.json"
        steps.format_payloads(payloads)
        committed = root / "models" / "prospective" / str(season) / "format_payloads.json"
        if not committed.is_file() or sha256_file(committed) != sha256_file(payloads):
            raise FreezeError(7, "format_payloads.json regenerated from configs differs from the committed one")
        _check_reuse(root, season, origin, tdir)
        steps.materialize(season, origin, worlds_dir=tdir / "inputs" / "worlds", forecasts_dir=tdir, tags=tags,
                          payloads=payloads, out=tdir / "decisions")
        manifest = build_manifest(root, season, origin, tdir, dry_run=dry_run, cutoff=cutoff, now=now,
                                  versions=steps.versions(), cutoff_passed=passed)
    except BaseException:
        shutil.rmtree(tdir, ignore_errors=True)
        raise
    body = (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode("utf-8")
    (tdir / "manifest.json").write_bytes(body)
    return hashlib.sha256(body).hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--origin", type=int, required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--now", default=None, help="ISO timestamp with tz (tests only)")
    a = ap.parse_args(argv)
    try:
        now = dt.datetime.fromisoformat(a.now.replace("Z", "+00:00")) if a.now else None
        digest = run_freeze(a.season, a.origin, dry_run=a.dry_run, now=now)
    except FreezeError as e:
        print(f"FREEZE REFUSED ({e.code}): {e.msg}", file=sys.stderr)
        return e.code
    except ValueError as e:
        print(f"FREEZE REFUSED (3): unparseable --now: {e}", file=sys.stderr)
        return 3
    print(f"MANIFEST_SHA256={digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
