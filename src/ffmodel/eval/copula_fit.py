"""Fit the per-position Gaussian-copula correlation rho from development residuals.

Spec: docs/superpowers/specs/2026-09-30-roster-sim-v2-prospective-design.md section 5.

The PIT inverts exactly the point distribution the engine draws from
(`drawPoints` in site/assets/rostersim.js): a two-piece normal through
p10/p50/p90 (sigma_left = (p50-p10)/Z90 for z<0, sigma_right = (p90-p50)/Z90
for z>=0), floored at min(0, 2*p10) -- so the floor is an atom of mass
Phi((f-p50)/sigma_left). Atoms and jumps use a seeded randomized PIT; actuals
below the floor are support violations (excluded, counted).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from statistics import NormalDist

import numpy as np

Z90 = 1.2815515655446004
POSITIONS = ("QB", "RB", "WR", "TE")
LENS = "f12-1qb-ppr-4"
SEED = 20260930
MIN_WEEKS = 4
RHO_MAX = 0.5
_N = NormalDist()
_EPS = 1e-9


def pit(q, x, rng) -> float | None:
    """Randomized PIT u = F(x) under drawPoints; None = support violation.

    q = (p10, p50, p90). rng is a numpy Generator, consulted only at atoms/jumps.
    """
    p10, p50, p90 = (float(v) for v in q)
    x = float(x)
    sl, sr = (p50 - p10) / Z90, (p90 - p50) / Z90
    f = min(0.0, 2.0 * p10)
    if x < f - _EPS:
        return None
    at_floor = abs(x - f) <= _EPS
    if x < p50 - _EPS:
        if sl <= 0:
            return None
        if at_floor:
            hi = _N.cdf((f - p50) / sl)
            return float(rng.uniform(0.0, hi)) if hi > 0 else None
        return _N.cdf((x - p50) / sl)
    if abs(x - p50) <= _EPS:
        lo = 0.0 if at_floor else (0.5 if sl > 0 else 0.0)
        hi = 0.5 if sr > 0 else 1.0
        return lo if hi <= lo else float(rng.uniform(lo, hi))
    if sr <= 0:
        return None
    return _N.cdf((x - p50) / sr)


def _z(u, clip):
    return _N.inv_cdf(min(max(u, clip), 1.0 - clip))


def build_trajectories(payload: dict, actuals: dict) -> list[dict]:
    """One trajectory per player of a (season, origin) forecast payload.

    actuals: {player_id: {week(int): points}}. Only weeks with status 'play' AND an
    actual row enter; byes/absences are the availability process's, not errors.
    """
    out = []
    for pid, p in payload["players"].items():
        if p["position"] not in POSITIONS:
            continue
        got = actuals.get(pid, {})
        rows = []
        for w, r in sorted(p["weeks"].items(), key=lambda kv: int(kv[0])):
            if r.get("status") != "play" or int(w) not in got:
                continue
            rows.append((int(w), r["p10"], r["p50"], r["p90"], got[int(w)]))
        if rows:
            out.append({"player": pid, "season": payload["season"], "origin": payload["origin"],
                        "position": p["position"], "rows": rows})
    return out


def _prepare(trajectories, seed):
    """PIT every row once (seeded). Counts support violations per position."""
    rng = np.random.default_rng(seed)
    viol = {p: 0 for p in POSITIONS}
    prepared = []
    for t in trajectories:
        weeks, us, vio = [], [], []
        for w, p10, p50, p90, x in t["rows"]:
            u = pit((p10, p50, p90), x, rng)
            if u is None:
                viol[t["position"]] += 1
                vio.append(w)
            else:
                weeks.append(w)
                us.append(u)
        prepared.append({**t, "weeks": weeks, "u": us, "viol_weeks": vio})
    return prepared, viol


def _stats(prepared, clip, *, atom_sensitivity=False):
    """Per-trajectory z, demeaned by position x origin, with c_t and v_t."""
    trajs = []
    for t in prepared:
        weeks, us = list(t["weeks"]), list(t["u"])
        if atom_sensitivity:
            weeks += t["viol_weeks"]
            us += [0.0] * len(t["viol_weeks"])
        if len(weeks) < MIN_WEEKS:
            continue
        z = np.array([_z(u, clip) for u in us])
        trajs.append({"pos": t["position"], "origin": t["origin"], "player": t["player"],
                      "season": t["season"], "weeks": np.array(weeks), "z": z, "u": np.array(us)})
    cell = {}
    for t in trajs:
        cell.setdefault((t["pos"], t["origin"]), []).append(t["z"])
    mean = {k: float(np.concatenate(v).mean()) for k, v in cell.items()}
    for t in trajs:
        t["zc"] = t["z"] - mean[(t["pos"], t["origin"])]
        n = len(t["zc"])
        s, s2 = t["zc"].sum(), (t["zc"] ** 2).sum()
        t["c"] = (s * s - s2) / (n * (n - 1))
        t["v"] = s2 / n
    return trajs


def _shrunk(c_by, v_by, n_by, k=200):
    """Raw per position (ratio of means), pooled raw, shrunk + clamped table."""
    raw = {p: (c_by[p] / v_by[p] if v_by[p] > 0 and n_by[p] > 0 else 0.0) for p in POSITIONS}
    v_all = sum(v_by.values())
    pooled = sum(c_by.values()) / v_all if v_all > 0 else 0.0
    table = {}
    for p in POSITIONS:
        w = n_by[p] / (n_by[p] + k)
        table[p] = min(max(w * raw[p] + (1 - w) * pooled, 0.0), RHO_MAX)
    return raw, pooled, table


def _sums(trajs):
    c = {p: 0.0 for p in POSITIONS}
    v = dict(c)
    n = {p: 0 for p in POSITIONS}
    for t in trajs:
        c[t["pos"]] += t["c"]
        v[t["pos"]] += t["v"]
        n[t["pos"]] += 1
    return c, v, n


def _corr(trajs, lag):
    num = den = 0.0
    for t in trajs:
        idx = {int(k): i for i, k in enumerate(t["weeks"])}
        z = t["zc"]
        for k, i in idx.items():
            j = idx.get(k + lag)
            if j is not None:
                num += z[i] * z[j]
                den += 0.5 * (z[i] ** 2 + z[j] ** 2)
    return float(num / den) if den > 0 else None


def fit(trajectories, *, k=200, clip=1e-4, n_boot=2000, seed=SEED) -> dict:
    """trajectories: [{player, season, origin, position, rows:[(week,p10,p50,p90,actual)]}]."""
    prepared, viol = _prepare(trajectories, seed)
    trajs = _stats(prepared, clip)
    c, v, n = _sums(trajs)
    raw, pooled_raw, table = _shrunk(c, v, n, k)
    players = sorted({t["player"] for t in trajs})
    pidx = {p: i for i, p in enumerate(players)}
    M = np.zeros((len(players), 12))
    for t in trajs:
        i, j = pidx[t["player"]], POSITIONS.index(t["pos"])
        M[i, j] += t["c"]
        M[i, 4 + j] += t["v"]
        M[i, 8 + j] += 1
    rng = np.random.default_rng(seed + 1)
    boots = {p: [] for p in POSITIONS}
    if players:
        for _ in range(n_boot):
            cnt = rng.multinomial(len(players), np.full(len(players), 1.0 / len(players)))
            s = cnt @ M
            _, _, tb = _shrunk({p: s[j] for j, p in enumerate(POSITIONS)},
                               {p: s[4 + j] for j, p in enumerate(POSITIONS)},
                               {p: s[8 + j] for j, p in enumerate(POSITIONS)}, k)
            for p in POSITIONS:
                boots[p].append(tb[p])
    ci = {p: ([float(np.percentile(boots[p], 2.5)), float(np.percentile(boots[p], 97.5))]
              if boots[p] else [None, None]) for p in POSITIONS}
    _, _, sens = _shrunk(*_sums(_stats(prepared, clip, atom_sensitivity=True)), k)
    diag = {}
    for p in POSITIONS:
        diag[p] = {}
        for o in sorted({t["origin"] for t in trajs if t["pos"] == p}):
            sub = [t for t in trajs if t["pos"] == p and t["origin"] == o]
            u = np.concatenate([t["u"] for t in sub])
            diag[p][str(o)] = {"pit_mean": float(u.mean()), "pit_sd": float(u.std()),
                               "lag1": _corr(sub, 1), "lag4": _corr(sub, 4)}
    pairs = {p: int(sum(len(t["z"]) * (len(t["z"]) - 1) // 2 for t in trajs if t["pos"] == p)) for p in POSITIONS}
    nplay = {p: len({t["player"] for t in trajs if t["pos"] == p}) for p in POSITIONS}
    return {
        "table": table,
        "pooled": float(min(max(pooled_raw, 0.0), RHO_MAX)),
        "pooled_raw": float(pooled_raw),
        "raw": {p: float(raw[p]) for p in POSITIONS},
        "clamped_negative": {p: bool(raw[p] < 0 and table[p] == 0.0) for p in POSITIONS},
        "n_trajectories": {p: int(n[p]) for p in POSITIONS},
        "n_players": nplay,
        "n_week_pairs": pairs,
        "support_violations": viol,
        "bootstrap_ci": ci,
        "sensitivity_violations_at_atom": {p: float(sens[p]) for p in POSITIONS},
        "diagnostics": diag,
        "implied_multiplier": {p: {"n9": 1 + 8 * table[p], "n13": 1 + 12 * table[p]} for p in POSITIONS},
        "lens": LENS, "seed": seed,
    }


def _git_sha():
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


def _dirty(path):
    """True when `path` differs from HEAD (or git is unavailable), so a fit on uncommitted code is visible."""
    try:
        out = subprocess.run(["git", "status", "--porcelain", "--", str(path)], capture_output=True, text=True, check=True)
        return bool(out.stdout.strip())
    except Exception:
        return True


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--forecasts", type=Path, nargs="+", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    args = ap.parse_args()
    from ffmodel.data.pull import pull_weekly
    from ffmodel.eval.draft_world import weekly_actuals
    from ffmodel.formats import load_format
    rules = load_format(LENS).rules
    payloads = [json.loads(p.read_text()) for p in args.forecasts]
    seasons = sorted({p["season"] for p in payloads})
    weekly = pull_weekly(seasons, cache_dir=args.data_dir)
    acts = {}
    for s in seasons:
        a = weekly_actuals(weekly, s, rules)
        d = {}
        for pid, w, pts in zip(a["player_id"], a["week"], a["points"]):
            d.setdefault(str(pid), {})[int(w)] = float(pts)
        acts[s] = d
    trajs = []
    for p in payloads:
        trajs += build_trajectories(p, acts[p["season"]])
    res = fit(trajs)
    res["code_sha"] = _git_sha()
    # The commit alone does not prove which code ran (a dirty tree runs uncommitted code), so record the
    # fitting source's own hash, whether it differed from HEAD, and every input's hash.
    src = Path(__file__).resolve()
    res["source_sha256"] = hashlib.sha256(src.read_bytes()).hexdigest()
    res["source_dirty"] = _dirty(src)
    res["inputs"] = sorted(str(p).replace("\\", "/") for p in args.forecasts)
    res["input_sha256"] = {str(p).replace("\\", "/"): hashlib.sha256(p.read_bytes()).hexdigest() for p in args.forecasts}
    stop = [p for p in POSITIONS if res["table"][p] >= RHO_MAX] + (["pooled<0.02"] if res["pooled"] < 0.02 else [])
    res["stop_flags"] = stop
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(res, indent=1))
    print(json.dumps({"table": res["table"], "pooled": res["pooled"], "stop_flags": stop}))
    if stop:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
