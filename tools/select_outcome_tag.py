"""Choose which frozen tag the season-end outcome workflow builds from (astra review I2; spec §7.5/§7.6).

    python tools/select_outcome_tag.py --season 2026        # prints one JSON object on stdout; exit 1 on a refusal

Normal case: the `prospective-<season>-o5` tag. Contingency (spec §7.5): origin 5 was missed, so the only freeze is the
exploratory origin 9; its tag is used only if its manifest verifies that contingency. Everything else is refused:
  - neither tag exists                                   (nothing frozen)
  - o5 absent and o9 is not a verified exploratory contingency (non-exploratory, dry-run, wrong season/origin/reason)
  - both present and o9 is exploratory                   (ambiguous: the freeze code forbids this state)
  - o5 present but its manifest claims to be exploratory
The result carries the tag, origin, `exploratory` and the path of the environment (pip_freeze) recorded by that freeze.
Stdlib only: the workflow runs it before any dependency is installed.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

CONTINGENCY_REASON = "origin-5 freeze missed"  # = ffmodel.prospective.freeze.CONTINGENCY_REASON (stdlib-only copy)


class SelectionError(Exception):
    pass


def manifest_path(season: int, origin: int) -> str:
    return f"models/prospective/{season}/o{origin}/manifest.json"


def pip_freeze_path(season: int, origin: int) -> str:
    return f"models/prospective/{season}/o{origin}/inputs/pip_freeze.txt"


def select(season: int, tag_exists, read_manifest) -> dict:
    """`tag_exists(tag) -> bool`; `read_manifest(tag, path) -> dict` (raises if absent or unreadable)."""
    t5, t9 = f"prospective-{season}-o5", f"prospective-{season}-o9"
    has5, has9 = tag_exists(t5), tag_exists(t9)
    if not has5 and not has9:
        raise SelectionError(f"neither {t5} nor {t9} exists: nothing was frozen")

    def load(tag, origin):
        try:
            mf = read_manifest(tag, manifest_path(season, origin))
        except Exception as e:  # noqa: BLE001
            raise SelectionError(f"cannot read {manifest_path(season, origin)} at {tag}: {e}") from e
        if not isinstance(mf, dict) or mf.get("season") != season or mf.get("origin") != origin:
            raise SelectionError(f"{tag}: manifest is not season {season} origin {origin}")
        if mf.get("dry_run") is not False:
            raise SelectionError(f"{tag}: manifest is a dry run (dry_run={mf.get('dry_run')!r})")
        return mf

    if has5:
        if has9 and load(t9, 9).get("exploratory") is True:
            raise SelectionError(f"ambiguous: {t5} exists but {t9} is an exploratory contingency freeze")
        if load(t5, 5).get("exploratory") is not False:
            raise SelectionError(f"{t5}: manifest is exploratory; origin 5 is never a contingency freeze")
        return {"tag": t5, "origin": 5, "exploratory": False, "pip_freeze": pip_freeze_path(season, 5)}
    mf = load(t9, 9)
    if mf.get("exploratory") is not True or mf.get("reason") != CONTINGENCY_REASON:
        raise SelectionError(f"{t5} is absent and {t9} is not a verified exploratory contingency "
                             f"(exploratory={mf.get('exploratory')!r}, reason={mf.get('reason')!r})")
    return {"tag": t9, "origin": 9, "exploratory": True, "pip_freeze": pip_freeze_path(season, 9)}


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True)


def git_tag_exists(tag: str) -> bool:
    return _git("rev-parse", "--verify", "--quiet", f"refs/tags/{tag}^{{commit}}").returncode == 0


def git_read_manifest(tag: str, path: str) -> dict:
    r = _git("show", f"refs/tags/{tag}:{path}")
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "git show failed")
    return json.loads(r.stdout)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--season", type=int, required=True)
    a = ap.parse_args(argv)
    try:
        res = select(a.season, git_tag_exists, git_read_manifest)
    except SelectionError as e:
        print(f"OUTCOME TAG REFUSED: {e}", file=sys.stderr)
        return 1
    print(json.dumps(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
