"""Live-accuracy summary for the site: a checked subset of the weekly-accuracy scorecard.

The scorecard (`models/diagnostics/live_<S>_weekly.json`, written by `.github/workflows/weekly-accuracy.yml`, spec
2026-10-06 §4.6-4.7) is never written into `site/` by its own job. The site refresh copies this subset into
`site/data/live-accuracy.json` instead, fail-soft like the expert refreshes: a missing scorecard writes nothing, a
malformed one raises and leaves the published file as it was. The scorecard is public and carries no third-party
projection values, so nothing private reaches the site.

Scope, stated on the page: PPR scoring, players who recorded a stat line, projections committed before each week.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

SCHEMA_VERSION = 1
KIND = "live_accuracy"
PROTOCOL = "live-accuracy-v1"
OUT = Path("site/data/live-accuracy.json")
FIELDS = ("n", "mae", "naive_mae", "coverage_p10_p90", "below_p10", "above_p90")


def _num(x, what: str) -> float:
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        raise ValueError(f"{what} must be a finite number, got {x!r}")
    return float(x)


def _cell(src: dict, what: str) -> dict:
    if not isinstance(src, dict):
        raise ValueError(f"{what} is missing")
    out = {}
    n = src.get("n")
    if isinstance(n, bool) or not isinstance(n, int) or n <= 0:
        raise ValueError(f"{what}.n must be a positive integer, got {n!r}")
    out["n"] = n
    for k in ("mae", "naive_mae"):
        v = _num(src.get(k), f"{what}.{k}")
        if v < 0:
            raise ValueError(f"{what}.{k} is negative")
        out[k] = v
    for k in ("coverage_p10_p90", "below_p10", "above_p90"):
        v = _num(src.get(k), f"{what}.{k}")
        if not 0 <= v <= 1:
            raise ValueError(f"{what}.{k} is outside [0, 1]")
        out[k] = v
    return out


def extract(art: dict) -> dict:
    """The site's subset of one scorecard artifact. Raises ValueError on anything unexpected."""
    if not isinstance(art, dict) or art.get("protocol_version") != PROTOCOL:
        raise ValueError(f"not a {PROTOCOL} scorecard")
    season = art.get("season")
    if isinstance(season, bool) or not isinstance(season, int):
        raise ValueError(f"season must be an integer, got {season!r}")
    scored = art.get("weeks_scored")
    if not isinstance(scored, list) or not scored or any(isinstance(w, bool) or not isinstance(w, int) for w in scored):
        raise ValueError("weeks_scored must be a non-empty list of integers")
    run = art.get("run") or {}
    provisional = run.get("provisional_weeks") or []
    if not isinstance(provisional, list) or any(w not in scored for w in provisional):
        raise ValueError("provisional_weeks must be scored weeks")
    by_week = (art.get("points") or {}).get("by_week") or {}
    weeks = []
    for w in sorted(scored):
        row = by_week.get(str(w))
        cell = _cell(row, f"points.by_week.{w}")
        last = row.get("last_game")
        weeks.append({"week": w, "last_game": last if isinstance(last, str) else None, **cell,
                      "provisional": w in provisional})
    overall = _cell((art.get("points") or {}).get("overall"), "points.overall")
    if overall["n"] != sum(r["n"] for r in weeks):
        raise ValueError("points.overall.n does not equal the sum of the weekly n")
    as_of, run_at = run.get("as_of_date"), run.get("run_at")
    if not isinstance(as_of, str) or not isinstance(run_at, str):
        raise ValueError("run.as_of_date and run.run_at must be strings")
    caveats = art.get("caveats") or []
    if not isinstance(caveats, list) or not all(isinstance(c, str) for c in caveats):
        raise ValueError("caveats must be a list of strings")
    # Weeks the scorecard could not score are named on the page, never silently left out.
    skipped = []
    for s in art.get("weeks_skipped") or []:
        w = s.get("week") if isinstance(s, dict) else None
        reason = s.get("reason") if isinstance(s, dict) else None
        if isinstance(w, bool) or not isinstance(w, int) or not isinstance(reason, str) or w in scored:
            raise ValueError(f"weeks_skipped entry {s!r} is not a {{week, reason}} for an unscored week")
        skipped.append({"week": w, "reason": reason})
    return {"schema_version": SCHEMA_VERSION, "kind": KIND, "protocol_version": PROTOCOL, "season": season,
            "scoring": "ppr", "as_of_date": as_of, "run_at": run_at,
            "source": f"models/diagnostics/live_{season}_weekly.json",
            "overall": overall, "weeks": weeks, "provisional_weeks": sorted(provisional),
            "weeks_skipped": sorted(skipped, key=lambda s: s["week"]), "caveats": caveats}


def serialise(summary: dict) -> str:
    return json.dumps(summary, indent=1, sort_keys=True, allow_nan=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--season", type=int, default=None, help="default: the current NFL season")
    ap.add_argument("--src", type=Path, default=None, help="default: models/diagnostics/live_<season>_weekly.json")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    src = args.src
    if src is None:
        from ffmodel.eval.live_accuracy import output_path
        src = output_path(args.season)
    if not Path(src).is_file():
        print(f"live accuracy: no scorecard at {src}; nothing written")
        return 0
    summary = extract(json.loads(Path(src).read_text(encoding="utf-8")))
    text = serialise(summary)
    out = Path(args.out)
    if out.is_file() and out.read_text(encoding="utf-8") == text:
        print(f"live accuracy: {out} unchanged")
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8", newline="\n")
    print(f"live accuracy: wrote {out} (weeks {summary['weeks'][0]['week']}-{summary['weeks'][-1]['week']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
