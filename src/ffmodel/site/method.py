"""The current-output method descriptor (spec 2026-10-01 §3.2, §8.9).

Published as `method` in `neutral/weekly.json` and `neutral/remaining.json`.
An evidence record (`ffmodel.site.evidence_records`) is a claim about today's
output only when its own `method` deep-equals this descriptor (and its
realized and prediction scoring both equal the live league's identity).

`band_construction` names the BROWSER's league-lens point band: each scored
stat component contributes its own points-favourable quantile end
(`leaguelens.reference_score` / `leaguelens.js`). It is deliberately a
different label from `ffmodel.scoring.BAND_CONSTRUCTION` ("sign_coherent_v1"),
which names the Python fixed-ruleset band that eval reports and
`calibration.json` were measured under; equality across the two is never
assumed.
"""
from __future__ import annotations

METHOD_VERSION = 1
MODEL = "transformer"
ENSEMBLE = "mean_of_seed_quantiles"
BAND_CONSTRUCTION = "component_sign_coherent_v1"
PRIOR_FIELDS = ("method", "rate", "first_season", "through_season")
REQUIRED_FIELDS = ("v", "model", "artifacts", "ensemble", "band_construction", "prior")


def _root(r) -> str:
    # One spelling on every OS: a Windows checkout must not mint a different
    # method identity from the Linux Actions runner.
    return str(r).replace("\\", "/")


def current_method(artifact_roots: list[str], pick_six_prior: dict) -> dict:
    """The method identity of the output this batch publishes."""
    roots = [_root(r) for r in artifact_roots]
    if not roots:
        raise ValueError("current_method needs at least one artifact root")
    if len(set(roots)) != len(roots):
        raise ValueError(f"duplicate artifact roots: {roots}")
    if not isinstance(pick_six_prior, dict):
        raise ValueError("current_method needs the batch's pick-six prior")
    missing = [f for f in PRIOR_FIELDS if f not in pick_six_prior]
    if missing:
        raise ValueError(f"pick-six prior missing {missing}")
    return {"v": METHOD_VERSION, "model": MODEL, "artifacts": sorted(roots), "ensemble": ENSEMBLE,
            "band_construction": BAND_CONSTRUCTION,
            "prior": {f: pick_six_prior[f] for f in PRIOR_FIELDS}}
