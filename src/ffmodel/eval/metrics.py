from __future__ import annotations

import numpy as np
import pandas as pd


def mae(y_true, y_pred) -> float:
    return float(np.mean(np.abs(np.asarray(y_true) - np.asarray(y_pred))))


def rmse(y_true, y_pred) -> float:
    return float(np.sqrt(np.mean((np.asarray(y_true) - np.asarray(y_pred)) ** 2)))


def pinball_loss(y_true, y_pred, q: float) -> float:
    diff = np.asarray(y_true) - np.asarray(y_pred)
    return float(np.mean(np.maximum(q * diff, (q - 1) * diff)))


def coverage(y_true, lo, hi) -> float:
    y = np.asarray(y_true)
    return float(np.mean((y >= np.asarray(lo)) & (y <= np.asarray(hi))))


def score_table(frame: pd.DataFrame) -> pd.DataFrame:
    """Per-position + OVERALL error table. Input columns: position, actual, pred."""
    if frame.empty:
        raise ValueError("score_table received an empty frame")
    has_q = {"p10", "p90"} <= set(frame.columns)

    def _row(name: str, part: pd.DataFrame) -> dict:
        out = {
            "position": name,
            "mae": mae(part["actual"], part["pred"]),
            "rmse": rmse(part["actual"], part["pred"]),
            "n": len(part),
        }
        if has_q:
            out["pinball_p10"] = pinball_loss(part["actual"], part["p10"], 0.1)
            out["pinball_p50"] = pinball_loss(part["actual"], part["pred"], 0.5)
            out["pinball_p90"] = pinball_loss(part["actual"], part["p90"], 0.9)
            out["coverage_p10_p90"] = coverage(part["actual"], part["p10"], part["p90"])
        return out

    rows = [_row(pos, part) for pos, part in frame.groupby("position")]
    rows.append(_row("OVERALL", frame))
    return pd.DataFrame(rows)
