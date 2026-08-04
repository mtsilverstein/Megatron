"""Walk-forward calibration of the board's value curve.

The draft backtest (`docs/draft-strategy-backtest.md`) found the shipped
transformer board worth +3.3 points over drafting the market -- a coin flip --
while the less accurate XGBoost board was worth +37.6. The diagnosis was
compression: the transformer's value curve has roughly half the spread, so the
optimizer finds less to gain from any pick, more candidates tie, and a tie
falls through to best-available, which IS the market.

This module tests whether that compression is a fixable calibration artifact.

METHOD (pre-registered before the evaluation was run, so it cannot be tuned
against the held-out seasons):

  For each position, fit ordinary least squares

      actual_season_points  ~  a + b * projected_value_points

  on the DRAFTABLE POOL only (position_rank <= 2x that position's replacement
  rank, the same pool `board_metrics` scores), pooled over every board season
  STRICTLY BEFORE the season being calibrated. Apply `value' = max(0, a + b*v)`.

  b > 1 means the projection is compressed and gets stretched; b < 1 means it is
  too steep and gets flattened. Because `vorp = value - replacement`, a pure
  slope change is exactly a rescaling of every VORP gap at that position, which
  is the quantity the optimizer's lookahead compares. The intercept additionally
  corrects each position's LEVEL against the others, which is what a flex slot
  turns on.

  No shrinkage, no tuning, no per-season overrides. If the fitted slopes are too
  noisy to help, that is the finding.

TWO WAYS THIS COULD HAVE BEEN DONE WRONG, both avoided:

  * Leakage. Calibrating season S against S's own actuals would be fitting to
    the answer key. `fit_calibration` is only ever handed prior seasons, and
    `calibrate_worlds` enforces it.
  * Selection. Matching the projection to the EX-POST sorted curve of actuals
    would over-steepen it: sorting noisy outcomes descending inflates the spread
    even when the true means are flat. Regressing actual on projected at the
    player's own board rank has no such selection -- each pair is one player.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from ffmodel.site.draft import REPLACEMENT_RANK

POSITIONS = ("QB", "RB", "WR", "TE")
# A position needs this many (projected, actual) pairs before a slope is worth
# believing. Below it the fit is left at identity rather than guessed.
MIN_PAIRS = 30
# Seasons of history required before a board is calibrated at all. One prior
# season is a single draw of a noisy regression; two is the minimum that can
# disagree with itself.
MIN_PRIOR_SEASONS = 2


def draftable_pairs(world: dict) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """(projected value_points, actual season points) per position, over the
    draftable pool. A board player who never recorded a stat line scores 0 --
    that is what a drafter actually got, and dropping him would be survivorship
    bias in exactly the direction that flatters the board."""
    replacement = world.get("replacement_rank") or REPLACEMENT_RANK
    actual = {pid: float(sum(weeks.values()))
              for pid, weeks in world["actual_weeks"].items()}
    out = {}
    for pos in POSITIONS:
        limit = 2 * int(replacement.get(pos, REPLACEMENT_RANK[pos]))
        pool = [p for p in world["players"]
                if p["position"] == pos and p.get("position_rank", 10 ** 9) <= limit
                and isinstance(p.get("value_points"), (int, float))]
        x = np.array([float(p["value_points"]) for p in pool])
        y = np.array([actual.get(p["player_id"], 0.0) for p in pool])
        out[pos] = (x, y)
    return out


def fit_calibration(worlds: list[dict]) -> dict[str, dict]:
    """Per-position {a, b, n, r} from the pooled prior seasons.

    A position with too few pairs, or with no spread in the projection to
    regress against, is left at identity (a=0, b=1) rather than given a made-up
    slope."""
    pooled: dict[str, list[np.ndarray]] = {pos: [[], []] for pos in POSITIONS}
    for world in worlds:
        for pos, (x, y) in draftable_pairs(world).items():
            pooled[pos][0].append(x)
            pooled[pos][1].append(y)
    out = {}
    for pos in POSITIONS:
        x = np.concatenate(pooled[pos][0]) if pooled[pos][0] else np.array([])
        y = np.concatenate(pooled[pos][1]) if pooled[pos][1] else np.array([])
        if len(x) < MIN_PAIRS or np.ptp(x) == 0:
            out[pos] = {"a": 0.0, "b": 1.0, "n": int(len(x)), "r": None,
                        "identity_reason": "too few pairs" if len(x) < MIN_PAIRS
                                           else "no spread to regress against"}
            continue
        b, a = np.polyfit(x, y, 1)
        r = float(np.corrcoef(x, y)[0, 1])
        out[pos] = {"a": float(a), "b": float(b), "n": int(len(x)), "r": r}
    return out


def apply_calibration(players: list[dict], calibration: dict[str, dict]) -> list[dict]:
    """New player dicts with `value_points` mapped through the fit.

    Floored at 0: a stretched curve can push the deep tail negative, and a
    negative season projection would subtract from a lineup total that only
    ever sums what you start. `vorp` is recomputed on the same affine map so
    the two stay consistent -- the optimizer breaks ties on `vorp`, and a board
    whose two value columns disagreed would rank one way and explain another.
    """
    out = []
    for p in players:
        cal = calibration.get(p["position"])
        v = p.get("value_points")
        if cal is None or not isinstance(v, (int, float)):
            out.append(dict(p))
            continue
        q = dict(p)
        q["value_points"] = round(max(0.0, cal["a"] + cal["b"] * float(v)), 1)
        if isinstance(p.get("vorp"), (int, float)):
            q["vorp"] = round(cal["b"] * float(p["vorp"]), 2)
        out.append(q)
    return out


def calibrate_worlds(worlds: list[dict]) -> tuple[list[dict], dict]:
    """Walk-forward: each season is calibrated only on the seasons before it.

    Seasons with fewer than `MIN_PRIOR_SEASONS` of history are dropped rather
    than shipped uncalibrated -- keeping them would silently mix calibrated and
    uncalibrated boards in one reported average.
    """
    ordered = sorted(worlds, key=lambda w: w["season"])
    kept, fits = [], {}
    for i, world in enumerate(ordered):
        priors = ordered[:i]
        if len(priors) < MIN_PRIOR_SEASONS:
            continue
        calibration = fit_calibration(priors)
        out = dict(world)
        out["players"] = apply_calibration(world["players"], calibration)
        out["value_calibration"] = {
            "fit_on_seasons": [w["season"] for w in priors],
            "per_position": calibration,
        }
        kept.append(out)
        fits[world["season"]] = calibration
    return kept, fits


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Walk-forward calibrate board value curves against realised points.")
    p.add_argument("--worlds", type=Path, required=True)
    p.add_argument("--out-dir", type=Path, required=True)
    return p


def main() -> None:
    args = build_parser().parse_args()
    worlds = [json.loads(p.read_text(encoding="utf-8"))
              for p in sorted(args.worlds.glob("world_*.json"))]
    if not worlds:
        raise SystemExit(f"no worlds in {args.worlds}")
    calibrated, fits = calibrate_worlds(worlds)
    if not calibrated:
        raise SystemExit(
            f"{len(worlds)} world(s) but none has {MIN_PRIOR_SEASONS} prior seasons "
            f"to calibrate against — nothing to write")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for world in calibrated:
        (args.out_dir / f"world_{world['season']}.json").write_text(
            json.dumps(world), encoding="utf-8")
    windows = {w["season"]: w["value_calibration"]["fit_on_seasons"] for w in calibrated}
    for season, cal in fits.items():
        bits = " ".join(
            f"{pos} b={cal[pos]['b']:.2f}" + ("*" if cal[pos].get("identity_reason") else "")
            for pos in POSITIONS)
        print(f"{season}: fit on {windows[season]} -> {bits}")
    print(f"wrote {len(calibrated)} calibrated world(s) to {args.out_dir}")


if __name__ == "__main__":
    main()
