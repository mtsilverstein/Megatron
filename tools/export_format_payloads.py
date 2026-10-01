"""Emit the board-league payload of each configs/formats/*.yaml as one JSON.

tools/prospective_materialize.cjs needs, per format, the same `league` block the
draft board ships (LeagueConfig.payload()), plus the format's key and compat
signature. Node has no YAML parser in this repo, so the Python side (which owns
the YAML contract and the key) writes this JSON once; the freeze hashes it.

    python tools/export_format_payloads.py --out models/prospective/2026/format_payloads.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ffmodel import formats as F  # noqa: E402


def payloads(labels=None) -> dict:
    labels = labels or sorted(p.stem for p in F.FORMAT_DIR.glob("*.yaml"))
    out = {}
    for label in labels:
        cfg = F.load_format(label)
        out[label] = {"league": cfg.payload(), "format_key": F.format_key(cfg), "compat": F.compat(cfg)}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--labels", default=None, help="comma-separated; default every configs/formats/*.yaml")
    a = ap.parse_args()
    data = payloads(a.labels.split(",") if a.labels else None)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {a.out} ({len(data)} formats)")


if __name__ == "__main__":
    main()
