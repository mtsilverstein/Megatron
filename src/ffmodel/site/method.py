"""The current-output method descriptor (spec 2026-10-01 §3.2, §8.9).

Published as `method` in `neutral/weekly.json` and `neutral/remaining.json`.
An evidence record (`ffmodel.site.evidence_records`) is a claim about today's
output only when its own `method` deep-equals this descriptor (and its
realized and prediction scoring both equal the live league's identity).

`band_construction` is `ffmodel.scoring.BAND_CONSTRUCTION`, the one point-band
construction name used repo-wide (eval reports, `calibration.json`, and the
browser's league lens, which pairs every scored component with its own
points-favourable quantile end exactly as `scoring.fantasy_points_band` does).

`calibration` names the band-calibration file(s) the predictor actually
applies: `TransformerPredictor.fit` (default `calibration=True`) reads only
`<artifact_roots[0]>/through<through>/calibration.json`, where `through` is the
last season of the fit frame and `artifact_roots[0]` is the FIRST root in the
order the predictor was given (not the sorted order). One entry when that file
exists, `None` when it does not.
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path

from ffmodel.scoring import BAND_CONSTRUCTION

METHOD_VERSION = 1
MODEL = "transformer"
ENSEMBLE = "mean_of_seed_quantiles"
PRIOR_FIELDS = ("method", "rate", "first_season", "through_season")
REQUIRED_FIELDS = ("v", "model", "artifacts", "ensemble", "band_construction", "calibration", "prior")


def committed_sha256(path: Path) -> str:
    """sha256 of the committed (LF) bytes: a Windows autocrlf checkout and the
    Linux runner must name the same artifact."""
    return hashlib.sha256(Path(path).read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def _root(r) -> str:
    # One spelling on every OS: a Windows checkout must not mint a different
    # method identity from the Linux Actions runner.
    return str(r).replace("\\", "/").rstrip("/")


def _is_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _prior(prior) -> dict:
    if not isinstance(prior, dict):
        raise ValueError("current_method needs the batch's pick-six prior")
    missing = [f for f in PRIOR_FIELDS if f not in prior]
    if missing:
        raise ValueError(f"pick-six prior missing {missing}")
    if not isinstance(prior["method"], str) or not prior["method"]:
        raise ValueError("pick-six prior method must be a non-empty string")
    rate = prior["rate"]
    if (not isinstance(rate, (int, float)) or isinstance(rate, bool) or not math.isfinite(rate)
            or not 0 <= rate <= 1):
        raise ValueError(f"pick-six prior rate must be a finite number in [0, 1], got {rate!r}")
    if not _is_int(prior["first_season"]) or not _is_int(prior["through_season"]):
        raise ValueError("pick-six prior first_season/through_season must be integers")
    if prior["first_season"] > prior["through_season"]:
        raise ValueError("pick-six prior first_season is after through_season")
    return {"method": prior["method"], "rate": float(rate),
            "first_season": prior["first_season"], "through_season": prior["through_season"]}


def applied_calibration(artifact_roots: list[str], through: int, root: Path = Path(".")) -> list[dict] | None:
    """The calibration file(s) `TransformerPredictor` applies for a fit through `through`."""
    rel = f"{_root(artifact_roots[0])}/through{through}/calibration.json"
    path = Path(root) / rel
    if not path.is_file():
        return None
    return sorted([{"path": rel, "sha256": committed_sha256(path)}], key=lambda e: e["path"])


def current_method(artifact_roots: list[str], pick_six_prior: dict, *, through: int,
                   root: Path = Path(".")) -> dict:
    """The method identity of the output this batch publishes.

    `artifact_roots` in the order the predictor receives them; `through` = the
    last season of the frame the predictor is fit on (`int(train.season.max())`);
    `root` = the repo root that relative artifact roots resolve against."""
    roots = [_root(r) for r in artifact_roots]
    if not roots:
        raise ValueError("current_method needs at least one artifact root")
    if len(set(roots)) != len(roots):
        raise ValueError(f"duplicate artifact roots: {roots}")
    if not _is_int(through):
        raise ValueError(f"through must be an integer season, got {through!r}")
    prior = _prior(pick_six_prior)
    return {"v": METHOD_VERSION, "model": MODEL, "artifacts": sorted(roots), "ensemble": ENSEMBLE,
            "band_construction": BAND_CONSTRUCTION,
            "calibration": applied_calibration(roots, through, root),
            "prior": prior}
