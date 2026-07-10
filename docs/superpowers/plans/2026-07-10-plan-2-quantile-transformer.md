# Plan 2: Quantile Transformer + Studio Lab Training — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The deep-learning centerpiece: a small PyTorch transformer that predicts p10/p50/p90 quantiles per stat component, trained via a checkpointed config-driven CLI (runnable on the Studio Lab T4 or local CPU), evaluated through the existing `run_backtest` harness against the committed baselines (naive 4.612 / XGBoost 4.458 overall PPR MAE).

**Architecture:** Sequence tensors are built from Plan 1's leak-free feature frame (`ffmodel/model/dataset.py`); a small encoder-only transformer with a context token and quantile heads (`net.py`) is trained by a resumable CLI (`train.py`); a `TransformerPredictor` (`predictor.py`) plugs into `run_backtest` via the documented `predict_quantiles` extension point, which this plan implements in the harness. GPU training itself is a manual Studio Lab session (thin notebook wrapper); everything else runs and is tested locally on CPU.

**Tech Stack:** PyTorch ≥2.9 (CPU wheels exist for local Python 3.14; Studio Lab installs its own CUDA build), PyYAML, plus Plan 1's stack.

**Spec:** `docs/superpowers/specs/2026-07-09-fantasy-football-model-design.md` §5 (model), §6 (eval). Plan 1's interfaces are live on `main`.

## Global Constraints

- Models predict **raw stat lines**; quantiles are in raw stat units; points come only from `ffmodel.scoring.fantasy_points`.
- **Leak-freedom:** every model input for a (player, week) uses only strictly-prior games. The feature scaler is fit on TRAIN rows only. A walk-forward artifact evaluated on test season S must be trained/early-stopped using only seasons < S.
- **Walk-forward only**; test seasons 2023/2024/2025; the transformer is evaluated by calling the existing `run_backtest` — no parallel harness.
- **Checkpoint every epoch**; training must resume losslessly after a 4h Studio Lab session cutoff (`--resume`).
- **Seeded determinism:** all training runs seeded and config-driven from `configs/`; every artifact directory contains the exact config, scaler, and metrics that produced it (spec invariant).
- Committed artifacts live under `models/transformer/<run>/`; `models/checkpoints/` and smoke artifacts are gitignored; `data/` stays gitignored.
- Free tiers only. Python ≥3.10. QB/RB/WR/TE, regular season, 2012–2025.
- Artifact naming contract: a directory `through<YYYY>` was trained AND validated using only seasons ≤ YYYY (train < val_season, early-stop on val_season = YYYY), and is therefore legal for test seasons > YYYY.
- Quantile heads output (p10, p50, p90) per stat, trained with pinball loss; predictions are made monotone (sorted) at inference.

---

### Task 1: Follow-up hardening + new dependencies

The final-review follow-up list from Plan 1, plus torch/pyyaml deps. All mechanical; one commit.

**Files:**
- Modify: `pyproject.toml`, `.gitignore`, `README.md`
- Modify: `src/ffmodel/data/pull.py`, `src/ffmodel/data/features.py`, `src/ffmodel/eval/metrics.py`, `src/ffmodel/eval/run.py`
- Modify: `tests/test_scoring.py`, `tests/test_pull.py`, `tests/test_features.py`, `tests/test_eval.py`, `tests/test_xgb.py`

**Interfaces:**
- Consumes: all Plan 1 modules as-is.
- Produces: no interface changes except `score_table` raising `ValueError` on an empty frame; `_cache_name` raising `ValueError` on empty seasons.

- [ ] **Step 1: Dependency + config edits**

In `pyproject.toml` dependencies add:

```toml
    "torch>=2.9",
    "pyyaml>=6.0",
```

In `.gitignore` append:

```
models/checkpoints/
models/transformer/smoke/
```

In `README.md` quickstart, after the pip install line, add:

```bash
source .venv/Scripts/activate       # POSIX: source .venv/bin/activate
```

Then `.venv/Scripts/python.exe -m pip install -e ".[dev]"` to pull the new deps (torch CPU wheel is ~200MB; this is expected).

- [ ] **Step 2: Write the new failing tests**

Append to `tests/test_scoring.py`:

```python
def test_rush_td_and_special_teams_td_weights():
    df = pd.DataFrame([{"rushing_tds": 2, "special_teams_tds": 1}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(18.0)  # 12 + 6


def test_in_column_nan_counts_as_zero():
    df = pd.DataFrame([{"rushing_yards": float("nan"), "receptions": 3}])
    assert fantasy_points(df, PPR).iloc[0] == pytest.approx(3.0)
```

Append to `tests/test_pull.py`:

```python
def test_canonical_columns_include_scoring_extras():
    out = normalize_weekly(pd.DataFrame([_raw_row()]))
    for col in ("two_point_conversions", "special_teams_tds"):
        assert col in out.columns, col


def test_cache_name_rejects_empty_seasons():
    from ffmodel.data.pull import _cache_name

    with pytest.raises(ValueError, match="seasons"):
        _cache_name("weekly", [])
```

Append to `tests/test_features.py`:

```python
def test_lag_target_share_nan_stays_nan():
    weekly = make_weekly([{"week": 1}, {"week": 2}])  # target_share NaN in base fixture
    out = build_features(weekly, make_schedules())
    assert np.isnan(out[out["week"] == 2]["lag4_target_share"].iloc[0])


def test_rest_days_clip_bounds():
    weekly = make_weekly([{"week": 1}, {"week": 2}, {"week": 3}])
    sched = make_schedules(3)
    sched.loc[sched["week"] == 2, "gameday"] = "2023-09-14"  # 4-day gap wk1->wk2
    sched.loc[sched["week"] == 3, "gameday"] = "2023-11-01"  # 48-day gap wk2->wk3
    out = build_features(weekly, sched)
    assert out[out["week"] == 2]["rest_days"].iloc[0] == 4    # floor
    assert out[out["week"] == 3]["rest_days"].iloc[0] == 14   # ceiling


def test_position_dummies_all_positions():
    rows = [{"player_id": p, "position": pos}
            for p, pos in [("a", "QB"), ("b", "RB"), ("c", "WR"), ("d", "TE")]]
    out = build_features(make_weekly(rows), make_schedules())
    for pos in ("QB", "RB", "WR", "TE"):
        sub = out[out["position"] == pos]
        assert sub[f"pos_{pos}"].iloc[0] == 1
        assert sub[[c for c in ("pos_QB", "pos_RB", "pos_WR", "pos_TE")
                    if c != f"pos_{pos}"]].iloc[0].sum() == 0


def test_opp_allowed_spans_season_boundary():
    weekly = make_weekly([
        {"season": 2022, "week": 18, "receiving_yards": 100.0},
        {"season": 2023, "week": 1},
    ])
    sched = pd.concat([make_schedules(18, 2022), make_schedules(6, 2023)])
    out = build_features(weekly, sched)
    wk1 = out[(out["season"] == 2023) & (out["week"] == 1)].iloc[0]
    assert wk1["opp_allowed_last4"] == pytest.approx(10.0)   # crosses the boundary
    assert np.isnan(wk1["opp_allowed_season"])               # season-to-date resets
```

Append to `tests/test_eval.py`:

```python
def test_walk_forward_sorts_unsorted_test_seasons():
    df = pd.DataFrame({"season": [2022, 2023, 2024]})
    seasons = [s for s, _, _ in walk_forward_splits(df, test_seasons=[2024, 2023])]
    assert seasons == [2023, 2024]


def test_score_table_rejects_empty_frame():
    frame = pd.DataFrame({"position": [], "actual": [], "pred": []})
    with pytest.raises(ValueError, match="empty"):
        score_table(frame)
```

In `tests/test_xgb.py`: delete the unused `import pytest` line.

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `.venv/Scripts/python.exe -m pytest -v`
Expected: the two `ValueError` tests and `test_rest_days_clip_bounds`/`test_score_table_rejects_empty_frame` FAIL (guards don't exist yet); the pure-coverage additions may already pass — that is fine and expected for characterization tests; note which in the report.

- [ ] **Step 4: Implement the guards and cleanups**

In `src/ffmodel/data/pull.py` — `_cache_name` gains a guard as its first line, and `pull_schedules`'s loader gains a canonical sort:

```python
def _cache_name(prefix: str, seasons: list[int]) -> str:
    if not seasons:
        raise ValueError("seasons list is empty")
    ...
```

In the `pull_schedules` loader, change the return to:

```python
        return raw[keep].sort_values(["season", "week", "home_team"]).reset_index(drop=True)
```

In `src/ffmodel/data/features.py` — import POSITIONS instead of the local tuple and drop the redundant copy:

```python
from ffmodel.data.pull import POSITIONS
```

In `_add_position_dummies`, replace the hardcoded tuple with `for pos in POSITIONS:`.
In `build_features`, change the first line to `df = weekly.sort_values(["player_id", "season", "week"]).reset_index(drop=True)` (drop the trailing `.copy()` — both calls already return new frames).

In `src/ffmodel/eval/metrics.py` — `score_table` gains a guard as its first line:

```python
    if frame.empty:
        raise ValueError("score_table received an empty frame")
```

In `src/ffmodel/eval/run.py` — report the sorted seasons: `"test_seasons": sorted(args.test_seasons),`.

- [ ] **Step 5: Run the full suite**

Run: `.venv/Scripts/python.exe -m pytest -v`
Expected: all pass (40 tests), 1 deselected, no warnings. Also verify torch imports: `.venv/Scripts/python.exe -c "import torch, yaml; print(torch.__version__)"`.

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml .gitignore README.md src/ffmodel tests
git commit -m "chore: Plan 1 follow-up hardening; add torch and pyyaml deps"
```

---

### Task 2: Sequence dataset builder + scaler

**Files:**
- Create: `src/ffmodel/model/__init__.py` (empty)
- Create: `src/ffmodel/model/dataset.py`
- Test: `tests/test_dataset.py`

**Interfaces:**
- Consumes: the Plan 1 feature frame (output of `build_features`), `PREDICTED_STATS`.
- Produces (used by Tasks 3-5):
  - `SEQ_FEATURES: list[str]` = `PREDICTED_STATS + ["target_share", "carry_share", "ppr_points", "is_home", "rest_days", "week"]` (17 per-game input features)
  - `CTX_FEATURES: list[str]` = `["is_home", "rest_days", "week", "games_prior", "opp_allowed_last4", "opp_allowed_season", "pos_QB", "pos_RB", "pos_WR", "pos_TE"]` (10 target-week context features)
  - `SequenceData` dataclass: `x_seq [N, seq_len, 17] f32`, `x_ctx [N, 10] f32`, `y [N, 11] f32`, `pad_mask [N, seq_len] bool (True = padding)`, `meta: pd.DataFrame` with columns `row_id` (original feature-frame index label), `player_id, season, week, position` — row-aligned with the arrays.
  - `build_sequences(features, seq_len=16, min_history=1) -> SequenceData` — `min_history=0` keeps rookie-debut rows (all-padding sequences) for inference.
  - `Scaler` dataclass + `fit_scaler(data) -> Scaler` (NaN-aware; over non-padded entries only) + `apply_scaler(data, scaler) -> SequenceData` (standardizes, then zero-fills NaN and padding; `y` untouched) + `Scaler.save(path)` / `Scaler.load(path)` (JSON).

- [ ] **Step 1: Write the failing tests**

`tests/test_dataset.py`:

```python
import numpy as np
import pandas as pd
import pytest

from ffmodel.data.features import build_features
from ffmodel.model.dataset import (
    CTX_FEATURES, SEQ_FEATURES, Scaler, apply_scaler, build_sequences, fit_scaler,
)
from ffmodel.scoring import PREDICTED_STATS

from tests.test_features import make_schedules, make_weekly


def _features(n_weeks=6):
    rows = [{"week": w, "receiving_yards": 10.0 * w} for w in range(1, n_weeks + 1)]
    return build_features(make_weekly(rows), make_schedules(n_weeks))


def test_shapes_and_padding():
    data = build_sequences(_features(), seq_len=4, min_history=1)
    assert data.x_seq.shape == (5, 4, len(SEQ_FEATURES))   # weeks 2-6 (week 1 dropped)
    assert data.x_ctx.shape == (5, len(CTX_FEATURES))
    assert data.y.shape == (5, len(PREDICTED_STATS))
    # week-2 sample has exactly one real game (left-padded)
    wk2 = data.meta.index[data.meta["week"] == 2][0]
    assert data.pad_mask[wk2].tolist() == [True, True, True, False]


def test_sequence_excludes_current_week_and_orders_recent_last():
    features = _features()
    data = build_sequences(features, seq_len=4, min_history=1)
    ry = SEQ_FEATURES.index("receiving_yards")
    wk6 = data.meta.index[data.meta["week"] == 6][0]
    # weeks 2,3,4,5 -> 20,30,40,50; current week (60) must NOT appear
    assert data.x_seq[wk6, :, ry].tolist() == [20.0, 30.0, 40.0, 50.0]


def test_min_history_zero_keeps_rookie_rows():
    data = build_sequences(_features(), seq_len=4, min_history=0)
    assert len(data.meta) == 6
    wk1 = data.meta.index[data.meta["week"] == 1][0]
    assert data.pad_mask[wk1].all()


def test_meta_row_id_maps_back_to_frame():
    features = _features()
    data = build_sequences(features, seq_len=4, min_history=1)
    for i in range(len(data.meta)):
        row = features.loc[data.meta["row_id"].iloc[i]]
        assert row["week"] == data.meta["week"].iloc[i]


def test_scaler_train_only_and_zero_fills(tmp_path):
    data = build_sequences(_features(), seq_len=4, min_history=1)
    scaler = fit_scaler(data)
    scaled = apply_scaler(data, scaler)
    assert not np.isnan(scaled.x_seq).any()
    assert not np.isnan(scaled.x_ctx).any()
    assert (scaled.x_seq[scaled.pad_mask] == 0).all()
    np.testing.assert_array_equal(scaled.y, data.y)  # targets never scaled
    # round-trip
    scaler.save(tmp_path / "scaler.json")
    loaded = Scaler.load(tmp_path / "scaler.json")
    np.testing.assert_allclose(loaded.seq_mean, scaler.seq_mean)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_dataset.py -v`
Expected: FAIL — `ModuleNotFoundError: ffmodel.model`.

- [ ] **Step 3: Write the implementation**

`src/ffmodel/model/dataset.py`:

```python
"""Sequence tensors for the quantile transformer.

Each sample is a (player, week): the player's previous `seq_len` games
(left-padded, most recent last) plus a target-week context vector; the
target is that week's raw stat line. Same leak rules as features.py:
strictly pre-game information only.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from ffmodel.scoring import PREDICTED_STATS

SEQ_FEATURES = PREDICTED_STATS + [
    "target_share", "carry_share", "ppr_points", "is_home", "rest_days", "week",
]
CTX_FEATURES = [
    "is_home", "rest_days", "week", "games_prior",
    "opp_allowed_last4", "opp_allowed_season",
    "pos_QB", "pos_RB", "pos_WR", "pos_TE",
]


@dataclass
class SequenceData:
    x_seq: np.ndarray
    x_ctx: np.ndarray
    y: np.ndarray
    pad_mask: np.ndarray
    meta: pd.DataFrame


def build_sequences(
    features: pd.DataFrame, seq_len: int = 16, min_history: int = 1
) -> SequenceData:
    df = features.sort_values(["player_id", "season", "week"]).reset_index(names="row_id")
    seq_vals = df[SEQ_FEATURES].to_numpy(dtype=np.float32)
    n = len(df)
    x_seq = np.zeros((n, seq_len, len(SEQ_FEATURES)), dtype=np.float32)
    pad_mask = np.ones((n, seq_len), dtype=bool)
    for idx in df.groupby("player_id", sort=False).indices.values():
        for j, row in enumerate(idx):
            hist = idx[max(0, j - seq_len):j]  # strictly prior games
            if len(hist):
                x_seq[row, seq_len - len(hist):] = seq_vals[hist]
                pad_mask[row, seq_len - len(hist):] = False
    keep = df["games_prior"].to_numpy() >= min_history
    meta = df.loc[keep, ["row_id", "player_id", "season", "week", "position"]]
    return SequenceData(
        x_seq[keep], df[CTX_FEATURES].to_numpy(dtype=np.float32)[keep],
        df[PREDICTED_STATS].to_numpy(dtype=np.float32)[keep],
        pad_mask[keep], meta.reset_index(drop=True),
    )


@dataclass
class Scaler:
    seq_mean: np.ndarray
    seq_std: np.ndarray
    ctx_mean: np.ndarray
    ctx_std: np.ndarray

    def save(self, path: Path) -> None:
        payload = {k: getattr(self, k).tolist() for k in
                   ("seq_mean", "seq_std", "ctx_mean", "ctx_std")}
        Path(path).write_text(json.dumps(payload))

    @classmethod
    def load(cls, path: Path) -> "Scaler":
        payload = json.loads(Path(path).read_text())
        return cls(**{k: np.asarray(v, dtype=np.float32) for k, v in payload.items()})


def _safe_std(std: np.ndarray) -> np.ndarray:
    return np.where(std < 1e-6, 1.0, std).astype(np.float32)


def fit_scaler(data: SequenceData) -> Scaler:
    real = data.x_seq[~data.pad_mask]  # only non-padded game entries
    return Scaler(
        seq_mean=np.nanmean(real, axis=0).astype(np.float32),
        seq_std=_safe_std(np.nanstd(real, axis=0)),
        ctx_mean=np.nanmean(data.x_ctx, axis=0).astype(np.float32),
        ctx_std=_safe_std(np.nanstd(data.x_ctx, axis=0)),
    )


def apply_scaler(data: SequenceData, scaler: Scaler) -> SequenceData:
    x_seq = (data.x_seq - scaler.seq_mean) / scaler.seq_std
    x_seq = np.nan_to_num(x_seq, nan=0.0)
    x_seq[data.pad_mask] = 0.0
    x_ctx = np.nan_to_num((data.x_ctx - scaler.ctx_mean) / scaler.ctx_std, nan=0.0)
    return SequenceData(x_seq.astype(np.float32), x_ctx.astype(np.float32),
                        data.y, data.pad_mask, data.meta)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_dataset.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/model/ tests/test_dataset.py
git commit -m "feat: sequence dataset builder and train-only feature scaler"
```

---

### Task 3: QuantileTransformer model + torch pinball loss

**Files:**
- Create: `src/ffmodel/model/net.py`
- Test: `tests/test_net.py`

**Interfaces:**
- Consumes: nothing from the data layer (pure torch).
- Produces:
  - `QuantileTransformer(n_seq_features, n_ctx_features, max_seq_len, d_model=96, n_heads=4, n_layers=3, dropout=0.1, n_stats=11, n_quantiles=3)`; `forward(x_seq [B,L,F], x_ctx [B,C], pad_mask [B,L] bool) -> [B, n_stats, n_quantiles]`.
  - `pinball_loss(pred [B,S,Q], target [B,S], quantiles: tuple) -> scalar tensor`.
  - `monotone(pred) -> pred` sorted along the quantile dim (inference-time non-crossing).

- [ ] **Step 1: Write the failing tests**

`tests/test_net.py`:

```python
import numpy as np
import pytest
import torch

from ffmodel.model.net import QuantileTransformer, monotone, pinball_loss


def _model():
    torch.manual_seed(0)
    return QuantileTransformer(n_seq_features=17, n_ctx_features=10, max_seq_len=8,
                               d_model=32, n_heads=2, n_layers=1, n_stats=11)


def _batch(B=4, L=8):
    g = torch.Generator().manual_seed(0)
    x_seq = torch.randn(B, L, 17, generator=g)
    x_ctx = torch.randn(B, 10, generator=g)
    pad = torch.zeros(B, L, dtype=torch.bool)
    pad[:, :3] = True  # first 3 positions padded
    x_seq[pad] = 0.0
    return x_seq, x_ctx, pad


def test_forward_shape():
    m = _model().eval()
    x_seq, x_ctx, pad = _batch()
    out = m(x_seq, x_ctx, pad)
    assert out.shape == (4, 11, 3)


def test_padding_entries_do_not_affect_output():
    m = _model().eval()
    x_seq, x_ctx, pad = _batch()
    with torch.no_grad():
        base = m(x_seq, x_ctx, pad)
        x_seq2 = x_seq.clone()
        x_seq2[pad] = 999.0  # garbage in padded slots
        out2 = m(x_seq2, x_ctx, pad)
    torch.testing.assert_close(base, out2, atol=1e-5, rtol=1e-4)


def test_fully_padded_sequence_still_outputs():
    m = _model().eval()
    x_seq, x_ctx, _ = _batch()
    pad = torch.ones(4, 8, dtype=torch.bool)  # rookie: no history at all
    with torch.no_grad():
        out = m(x_seq, x_ctx, pad)
    assert torch.isfinite(out).all()


def test_pinball_matches_numpy_reference():
    from ffmodel.eval.metrics import pinball_loss as np_pinball

    torch.manual_seed(1)
    pred = torch.randn(64, 11, 3)
    target = torch.randn(64, 11)
    qs = (0.1, 0.5, 0.9)
    got = pinball_loss(pred, target, qs).item()
    want = np.mean([np_pinball(target.numpy().ravel(),
                               pred[:, :, i].numpy().ravel(), q)
                    for i, q in enumerate(qs)])
    assert got == pytest.approx(want, rel=1e-5)


def test_monotone_sorts_quantiles():
    x = torch.tensor([[[3.0, 1.0, 2.0]]])
    torch.testing.assert_close(monotone(x), torch.tensor([[[1.0, 2.0, 3.0]]]))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_net.py -v`
Expected: FAIL — `ModuleNotFoundError: ffmodel.model.net`.

- [ ] **Step 3: Write the implementation**

`src/ffmodel/model/net.py`:

```python
"""Encoder-only quantile transformer sized for ~100k samples (spec §5)."""
from __future__ import annotations

import torch
from torch import nn


class QuantileTransformer(nn.Module):
    def __init__(self, n_seq_features: int, n_ctx_features: int, max_seq_len: int,
                 d_model: int = 96, n_heads: int = 4, n_layers: int = 3,
                 dropout: float = 0.1, n_stats: int = 11, n_quantiles: int = 3):
        super().__init__()
        self.n_stats, self.n_quantiles = n_stats, n_quantiles
        self.game_proj = nn.Linear(n_seq_features, d_model)
        self.ctx_proj = nn.Linear(n_ctx_features, d_model)
        self.pos_emb = nn.Parameter(torch.randn(max_seq_len + 1, d_model) * 0.02)
        layer = nn.TransformerEncoderLayer(
            d_model, n_heads, dim_feedforward=4 * d_model, dropout=dropout,
            batch_first=True, norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, n_layers)
        self.head = nn.Sequential(nn.LayerNorm(d_model),
                                  nn.Linear(d_model, n_stats * n_quantiles))

    def forward(self, x_seq: torch.Tensor, x_ctx: torch.Tensor,
                pad_mask: torch.Tensor) -> torch.Tensor:
        batch, seq_len, _ = x_seq.shape
        tokens = torch.cat(
            [self.ctx_proj(x_ctx).unsqueeze(1), self.game_proj(x_seq)], dim=1
        ) + self.pos_emb[: seq_len + 1]
        # context token (position 0) is never masked, so a rookie with an
        # all-padding history still yields a finite prediction
        mask = torch.cat(
            [torch.zeros(batch, 1, dtype=torch.bool, device=x_seq.device), pad_mask],
            dim=1,
        )
        hidden = self.encoder(tokens, src_key_padding_mask=mask)
        return self.head(hidden[:, 0]).view(batch, self.n_stats, self.n_quantiles)


def pinball_loss(pred: torch.Tensor, target: torch.Tensor,
                 quantiles: tuple[float, ...]) -> torch.Tensor:
    diff = target.unsqueeze(-1) - pred
    q = torch.tensor(quantiles, device=pred.device, dtype=pred.dtype).view(1, 1, -1)
    return torch.maximum(q * diff, (q - 1) * diff).mean()


def monotone(pred: torch.Tensor) -> torch.Tensor:
    """Sort along the quantile dim so p10 <= p50 <= p90 always holds."""
    return torch.sort(pred, dim=-1).values
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_net.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/model/net.py tests/test_net.py
git commit -m "feat: quantile transformer module with pinball loss"
```

---

### Task 4: Config-driven training CLI with per-epoch checkpoints and resume

**Files:**
- Create: `src/ffmodel/model/train.py`
- Create: `configs/transformer_smoke.yaml`
- Test: `tests/test_train.py`

**Interfaces:**
- Consumes: `build_features`, `pull_weekly`/`pull_schedules`, dataset + net modules.
- Produces:
  - CLI: `python -m ffmodel.model.train --config configs/<name>.yaml [--resume] [--features-parquet PATH]` (the parquet override lets tests inject synthetic data and lets Studio Lab reuse a prebuilt frame).
  - `train_from_config(cfg: dict, features: pd.DataFrame) -> Path` — returns the artifact directory; importable so tests avoid subprocess.
  - Artifact directory layout (the contract Task 5 loads): `models/transformer/<run_name>/through<val_season>/` containing `model.pt` (state_dict), `config.yaml` (exact copy), `scaler.json`, `metrics.json` (`{"val_season", "best_epoch", "val_pinball", "quantiles", "seq_len", "n_seq_features", "n_ctx_features", "model": {d_model, n_heads, n_layers, dropout}}`).
  - Checkpoints: `models/checkpoints/<run_name>_through<val_season>/latest.pt` holds `{epoch, model_state, optimizer_state, best_val, bad_epochs, torch_rng, numpy_rng}` — `--resume` continues losslessly.
  - Split contract: train = seasons < `val_season`, val = season == `val_season`; the artifact is legal for test seasons > `val_season`.

- [ ] **Step 1: Write the smoke config**

`configs/transformer_smoke.yaml`:

```yaml
run_name: smoke
seed: 0
seq_len: 8
val_season: 2022
first_season: 2012
quantiles: [0.1, 0.5, 0.9]
model:
  d_model: 32
  n_heads: 2
  n_layers: 1
  dropout: 0.1
train:
  batch_size: 512
  lr: 0.001
  weight_decay: 0.01
  epochs: 3
  patience: 5
  grad_clip: 1.0
out_root: models/transformer
checkpoint_root: models/checkpoints
```

- [ ] **Step 2: Write the failing tests**

`tests/test_train.py` (synthetic data — offline, ~30s on CPU):

```python
import numpy as np
import pandas as pd
import pytest
import yaml

from ffmodel.data.features import build_features
from ffmodel.model.train import train_from_config

from tests.test_features import make_schedules, make_weekly


def _synthetic_features(n_players=12, seasons=(2020, 2021, 2022)):
    rng = np.random.default_rng(0)
    rows = []
    for season in seasons:
        for week in range(1, 11):
            for p in range(n_players):
                rows.append({
                    "player_id": f"p{p}", "season": season, "week": week,
                    "position": ["QB", "RB", "WR", "TE"][p % 4],
                    "receiving_yards": float(rng.integers(0, 120)),
                    "receptions": float(rng.integers(0, 10)),
                })
    sched = pd.concat([make_schedules(10, s) for s in seasons])
    return build_features(make_weekly(rows), sched)


def _cfg(tmp_path, epochs=2):
    return {
        "run_name": "testrun", "seed": 0, "seq_len": 8, "val_season": 2022,
        "first_season": 2020, "quantiles": [0.1, 0.5, 0.9],
        "model": {"d_model": 16, "n_heads": 2, "n_layers": 1, "dropout": 0.0},
        "train": {"batch_size": 64, "lr": 1e-3, "weight_decay": 0.0,
                  "epochs": epochs, "patience": 10, "grad_clip": 1.0},
        "out_root": str(tmp_path / "artifacts"),
        "checkpoint_root": str(tmp_path / "ckpt"),
    }


def test_training_produces_artifact_contract(tmp_path):
    features = _synthetic_features()
    art = train_from_config(_cfg(tmp_path), features)
    assert art.name == "through2022"
    for f in ("model.pt", "config.yaml", "scaler.json", "metrics.json"):
        assert (art / f).exists(), f
    import json
    metrics = json.loads((art / "metrics.json").read_text())
    assert metrics["val_season"] == 2022
    assert np.isfinite(metrics["val_pinball"])


def test_resume_continues_from_checkpoint(tmp_path):
    features = _synthetic_features()
    cfg = _cfg(tmp_path, epochs=1)
    train_from_config(cfg, features)
    cfg["train"]["epochs"] = 2
    art = train_from_config(cfg, features, resume=True)
    import json
    metrics = json.loads((art / "metrics.json").read_text())
    assert metrics["last_epoch"] == 2  # continued, not restarted


def test_seeded_determinism(tmp_path):
    features = _synthetic_features()
    import json
    m = []
    for sub in ("a", "b"):
        cfg = _cfg(tmp_path)
        cfg["out_root"] = str(tmp_path / sub)
        cfg["checkpoint_root"] = str(tmp_path / sub / "ckpt")
        art = train_from_config(cfg, features)
        m.append(json.loads((art / "metrics.json").read_text())["val_pinball"])
    assert m[0] == pytest.approx(m[1])
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_train.py -v`
Expected: FAIL — `ModuleNotFoundError` / `ImportError: train_from_config`.

- [ ] **Step 4: Write the implementation**

`src/ffmodel/model/train.py`:

```python
"""Config-driven, resumable training. Checkpoints every epoch (Studio Lab
sessions die at 4h; a cutoff must lose nothing)."""
from __future__ import annotations

import argparse
import json
import random
import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import yaml
from torch.utils.data import DataLoader, TensorDataset

from ffmodel.model.dataset import (
    CTX_FEATURES, SEQ_FEATURES, apply_scaler, build_sequences, fit_scaler,
)
from ffmodel.model.net import QuantileTransformer, pinball_loss
from ffmodel.scoring import PREDICTED_STATS


def _seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def _loader(data, batch_size: int, shuffle: bool, seed: int) -> DataLoader:
    ds = TensorDataset(torch.from_numpy(data.x_seq), torch.from_numpy(data.x_ctx),
                       torch.from_numpy(data.pad_mask), torch.from_numpy(data.y))
    gen = torch.Generator().manual_seed(seed)
    return DataLoader(ds, batch_size=batch_size, shuffle=shuffle, generator=gen)


def _epoch(model, loader, quantiles, device, optimizer=None, grad_clip=1.0,
           amp_scaler=None):
    training = optimizer is not None
    use_amp = amp_scaler is not None and device == "cuda"  # fp16 on the T4 (spec §5)
    model.train(training)
    total, count = 0.0, 0
    with torch.set_grad_enabled(training):
        for x_seq, x_ctx, pad, y in loader:
            x_seq, x_ctx = x_seq.to(device), x_ctx.to(device)
            pad, y = pad.to(device), y.to(device)
            with torch.autocast(device_type="cuda", enabled=use_amp):
                pred = model(x_seq, x_ctx, pad)
                loss = pinball_loss(pred, y, quantiles)
            if training:
                optimizer.zero_grad()
                if use_amp:
                    amp_scaler.scale(loss).backward()
                    amp_scaler.unscale_(optimizer)
                    torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
                    amp_scaler.step(optimizer)
                    amp_scaler.update()
                else:
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
                    optimizer.step()
            total += loss.item() * len(y)
            count += len(y)
    return total / count


def train_from_config(cfg: dict, features: pd.DataFrame, resume: bool = False) -> Path:
    _seed_everything(cfg["seed"])
    device = "cuda" if torch.cuda.is_available() else "cpu"
    quantiles = tuple(cfg["quantiles"])
    val_season = cfg["val_season"]

    train_df = features[(features["season"] >= cfg["first_season"])
                        & (features["season"] < val_season)]
    val_df = features[features["season"] == val_season]
    raw_train = build_sequences(train_df, cfg["seq_len"])
    scaler = fit_scaler(raw_train)          # train rows only — leak-freedom
    train_data = apply_scaler(raw_train, scaler)
    val_data = apply_scaler(build_sequences(val_df, cfg["seq_len"]), scaler)

    model = QuantileTransformer(
        n_seq_features=len(SEQ_FEATURES), n_ctx_features=len(CTX_FEATURES),
        max_seq_len=cfg["seq_len"], n_stats=len(PREDICTED_STATS),
        n_quantiles=len(quantiles), **cfg["model"],
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=cfg["train"]["lr"],
                                  weight_decay=cfg["train"]["weight_decay"])
    amp_scaler = (torch.amp.GradScaler("cuda")
                  if device == "cuda" and cfg["train"].get("amp", True) else None)
    # amp_scaler state is intentionally not checkpointed: after a resume it
    # re-warms within a few steps, which costs less than it complicates.

    ckpt_dir = Path(cfg["checkpoint_root"]) / f"{cfg['run_name']}_through{val_season}"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    latest = ckpt_dir / "latest.pt"
    art_dir = Path(cfg["out_root"]) / cfg["run_name"] / f"through{val_season}"

    start_epoch, best_val, bad = 1, float("inf"), 0
    if resume and latest.exists():
        state = torch.load(latest, map_location=device, weights_only=False)
        model.load_state_dict(state["model_state"])
        optimizer.load_state_dict(state["optimizer_state"])
        start_epoch = state["epoch"] + 1
        best_val, bad = state["best_val"], state["bad_epochs"]
        torch.set_rng_state(state["torch_rng"])
        np.random.set_state(state["numpy_rng"])

    train_loader = _loader(train_data, cfg["train"]["batch_size"], True, cfg["seed"])
    val_loader = _loader(val_data, cfg["train"]["batch_size"], False, cfg["seed"])

    last_epoch = start_epoch - 1
    for epoch in range(start_epoch, cfg["train"]["epochs"] + 1):
        last_epoch = epoch
        train_loss = _epoch(model, train_loader, quantiles, device,
                            optimizer, cfg["train"]["grad_clip"], amp_scaler)
        val_loss = _epoch(model, val_loader, quantiles, device)
        print(f"epoch {epoch}: train {train_loss:.4f}  val {val_loss:.4f}")
        torch.save({
            "epoch": epoch, "model_state": model.state_dict(),
            "optimizer_state": optimizer.state_dict(), "best_val": best_val,
            "bad_epochs": bad, "torch_rng": torch.get_rng_state(),
            "numpy_rng": np.random.get_state(),
        }, latest)
        if val_loss < best_val:
            best_val, bad = val_loss, 0
            art_dir.mkdir(parents=True, exist_ok=True)
            torch.save(model.state_dict(), art_dir / "model.pt")
            scaler.save(art_dir / "scaler.json")
            (art_dir / "config.yaml").write_text(yaml.safe_dump(cfg))
            (art_dir / "metrics.json").write_text(json.dumps({
                "val_season": val_season, "best_epoch": epoch,
                "last_epoch": epoch, "val_pinball": val_loss,
                "quantiles": list(quantiles), "seq_len": cfg["seq_len"],
                "n_seq_features": len(SEQ_FEATURES),
                "n_ctx_features": len(CTX_FEATURES), "model": cfg["model"],
            }, indent=2))
        else:
            bad += 1
            if bad >= cfg["train"]["patience"]:
                print(f"early stop at epoch {epoch}")
                break
    # keep last_epoch current even when the best artifact is older
    metrics_path = art_dir / "metrics.json"
    if metrics_path.exists():
        metrics = json.loads(metrics_path.read_text())
        metrics["last_epoch"] = last_epoch
        metrics_path.write_text(json.dumps(metrics, indent=2))
    return art_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the quantile transformer.")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--features-parquet", type=Path, default=None)
    args = parser.parse_args()
    cfg = yaml.safe_load(args.config.read_text())
    if args.features_parquet:
        features = pd.read_parquet(args.features_parquet)
    else:
        from ffmodel.data.features import build_features
        from ffmodel.data.pull import pull_schedules, pull_weekly
        seasons = list(range(cfg["first_season"], cfg["val_season"] + 1))
        features = build_features(pull_weekly(seasons, Path("data/raw")),
                                  pull_schedules(seasons, Path("data/raw")))
    art = train_from_config(cfg, features, resume=args.resume)
    print(f"artifact -> {art}")


if __name__ == "__main__":
    main()
```

Note the double `build_sequences(train_df, ...)` in `train_from_config` is wasteful — build once into a variable and pass it to both `fit_scaler` and `apply_scaler`; write it that way:

```python
    raw_train = build_sequences(train_df, cfg["seq_len"])
    scaler = fit_scaler(raw_train)
    train_data = apply_scaler(raw_train, scaler)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_train.py -v`
Expected: 3 passed (allow ~60s). Then full suite: all green.

- [ ] **Step 6: Commit**

```bash
git add src/ffmodel/model/train.py configs/transformer_smoke.yaml tests/test_train.py
git commit -m "feat: resumable config-driven training CLI with epoch checkpoints"
```

---

### Task 5: Harness quantile extension + TransformerPredictor

**Files:**
- Modify: `src/ffmodel/eval/metrics.py` (extend `score_table`)
- Modify: `src/ffmodel/eval/harness.py` (quantile sniffing)
- Create: `src/ffmodel/model/predictor.py`
- Test: `tests/test_predictor.py`; append to `tests/test_harness.py`

**Interfaces:**
- Consumes: artifact contract from Task 4, dataset/net modules, existing harness.
- Produces:
  - `score_table(frame)` — unchanged for point models; if the frame ALSO has columns `p10`/`p90`, each row additionally gets `pinball_p10`, `pinball_p50`, `pinball_p90`, `coverage_p10_p90` (computed on points).
  - `run_backtest` — if a predictor has `predict_quantiles(test) -> dict[str, pd.DataFrame]` (keys `"p10","p50","p90"`, each an index-aligned PREDICTED_STATS frame), p50 flows through the existing scoring path and the quantile columns appear in the results; point-only predictors are untouched (existing tests must not change).
  - `TransformerPredictor(artifact_root: Path, features: pd.DataFrame)` — `fit(train)` picks `through{train.season.max()}` under `artifact_root` (raises `FileNotFoundError` with the expected path if absent) and computes per-position empirical quantile fallbacks from train for rookie rows (`games_prior == 0`); `predict(test)` returns the p50 frame; `predict_quantiles(test)` returns all three, index-aligned to `test`, monotone.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_harness.py`:

```python
def test_run_backtest_quantile_predictor_adds_columns():
    features = _toy_features()

    class QuantileOracle:
        name = "q_oracle"

        def fit(self, train):
            pass

        def predict(self, test):
            return test[PREDICTED_STATS].copy()

        def predict_quantiles(self, test):
            actual = test[PREDICTED_STATS]
            return {"p10": actual * 0.5, "p50": actual.copy(), "p90": actual * 1.5}

    results = run_backtest(features, [QuantileOracle()], test_seasons=[2023])
    row = results[results["position"] == "OVERALL"].iloc[0]
    assert row["mae"] == pytest.approx(0.0)          # p50 == truth
    assert row["pinball_p50"] == pytest.approx(0.0)
    assert row["coverage_p10_p90"] == pytest.approx(1.0)


def test_point_only_predictors_unchanged():
    features = _toy_features()
    results = run_backtest(features, [NaiveLast4()], test_seasons=[2023])
    assert "pinball_p50" not in results.columns or results["pinball_p50"].isna().all()
```

`tests/test_predictor.py`:

```python
import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.harness import run_backtest
from ffmodel.model.predictor import TransformerPredictor
from ffmodel.model.train import train_from_config
from ffmodel.scoring import PREDICTED_STATS

from tests.test_train import _cfg, _synthetic_features


@pytest.fixture(scope="module")
def trained(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("artifact")
    features = _synthetic_features(seasons=(2020, 2021, 2022))
    cfg = _cfg(tmp)          # val_season 2022 -> artifact through2022
    art = train_from_config(cfg, features)
    # test frame: add a 2023 season the artifact has never seen
    test_features = _synthetic_features(seasons=(2020, 2021, 2022, 2023))
    return art.parent, test_features  # art = <out_root>/testrun/through2022 -> root is its parent


def test_predict_quantiles_aligned_and_monotone(trained):
    root, features = trained
    p = TransformerPredictor(root, features)
    train = features[features["season"] <= 2022]
    test = features[features["season"] == 2023]
    p.fit(train)
    qs = p.predict_quantiles(test)
    for key in ("p10", "p50", "p90"):
        assert list(qs[key].columns) == PREDICTED_STATS
        assert qs[key].index.equals(test.index)
    assert (qs["p10"].to_numpy() <= qs["p50"].to_numpy() + 1e-6).all()
    assert (qs["p50"].to_numpy() <= qs["p90"].to_numpy() + 1e-6).all()


def test_fit_rejects_missing_artifact(trained):
    root, features = trained
    p = TransformerPredictor(root, features)
    with pytest.raises(FileNotFoundError, match="through2023"):
        p.fit(features[features["season"] <= 2023])


def test_runs_through_backtest(trained):
    root, features = trained
    results = run_backtest(features, [TransformerPredictor(root, features)],
                           test_seasons=[2023])
    overall = results[results["position"] == "OVERALL"].iloc[0]
    assert np.isfinite(overall["mae"])
    assert np.isfinite(overall["coverage_p10_p90"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/test_predictor.py tests/test_harness.py -v`
Expected: new tests FAIL (`ImportError`/missing columns); the 4 existing harness tests still pass.

- [ ] **Step 3: Extend `score_table` in `src/ffmodel/eval/metrics.py`**

Replace `_row` inside `score_table` with:

```python
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
```

- [ ] **Step 4: Extend `run_backtest` in `src/ffmodel/eval/harness.py`**

Inside the predictor loop, replace the prediction/scoring block with:

```python
            pred_stats = predictor.predict(test)
            if not pred_stats.index.equals(test.index):
                raise ValueError(
                    f"{predictor.name}: prediction index misaligned with test frame"
                )
            scored = pd.DataFrame({
                "position": test["position"].to_numpy(),
                "actual": actual.to_numpy(),
                "pred": fantasy_points(pred_stats, rules).to_numpy(),
            })
            if hasattr(predictor, "predict_quantiles"):
                quantile_stats = predictor.predict_quantiles(test)
                for key in ("p10", "p90"):
                    frame = quantile_stats[key]
                    if not frame.index.equals(test.index):
                        raise ValueError(
                            f"{predictor.name}: {key} index misaligned with test frame"
                        )
                    scored[key] = fantasy_points(frame, rules).to_numpy()
            tables.append(
                score_table(scored).assign(model=predictor.name, test_season=season)
            )
```

- [ ] **Step 5: Write `src/ffmodel/model/predictor.py`**

```python
"""Bridges trained artifacts into the Plan 1 backtest harness."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from ffmodel.model.dataset import (
    CTX_FEATURES, SEQ_FEATURES, Scaler, apply_scaler, build_sequences,
)
from ffmodel.model.net import QuantileTransformer, monotone
from ffmodel.scoring import PREDICTED_STATS

QUANTILE_KEYS = ("p10", "p50", "p90")


class TransformerPredictor:
    """Predictor + predict_quantiles over walk-forward artifacts.

    Constructed with the FULL feature frame: each test row's input sequence
    reaches back into earlier seasons, which the harness's test slice does
    not contain. Leak-freedom is preserved because sequences only ever use
    strictly-prior games and the artifact chosen by fit() was trained and
    validated on seasons <= max(train.season).
    """

    name = "transformer"

    def __init__(self, artifact_root: Path, features: pd.DataFrame, device: str = "cpu"):
        self.artifact_root = Path(artifact_root)
        self.features = features
        self.device = device
        self._model = None

    def fit(self, train: pd.DataFrame) -> None:
        through = int(train["season"].max())
        art = self.artifact_root / f"through{through}"
        if not art.exists():
            raise FileNotFoundError(
                f"no artifact at {art} — train one with "
                f"`python -m ffmodel.model.train` (val_season {through})"
            )
        metrics = json.loads((art / "metrics.json").read_text())
        self._seq_len = metrics["seq_len"]
        self._quantiles = metrics["quantiles"]
        self._scaler = Scaler.load(art / "scaler.json")
        self._model = QuantileTransformer(
            n_seq_features=metrics["n_seq_features"],
            n_ctx_features=metrics["n_ctx_features"],
            max_seq_len=self._seq_len, n_stats=len(PREDICTED_STATS),
            n_quantiles=len(self._quantiles), **metrics["model"],
        ).to(self.device)
        self._model.load_state_dict(
            torch.load(art / "model.pt", map_location=self.device, weights_only=True)
        )
        self._model.eval()
        self._pos_fallback = {
            q: train.groupby("position")[PREDICTED_STATS].quantile(q)
            for q in self._quantiles
        }

    def predict(self, test: pd.DataFrame) -> pd.DataFrame:
        return self.predict_quantiles(test)["p50"]

    def predict_quantiles(self, test: pd.DataFrame) -> dict[str, pd.DataFrame]:
        data = apply_scaler(
            build_sequences(self.features, self._seq_len, min_history=0), self._scaler
        )
        pos = pd.Index(data.meta["row_id"]).get_indexer(test.index)
        if (pos < 0).any():
            raise ValueError("test rows missing from the predictor's feature frame")
        with torch.no_grad():
            out = self._model(
                torch.from_numpy(data.x_seq[pos]).to(self.device),
                torch.from_numpy(data.x_ctx[pos]).to(self.device),
                torch.from_numpy(data.pad_mask[pos]).to(self.device),
            )
            out = monotone(out).cpu().numpy()  # [n, stats, 3]
        result = {}
        rookie = test["games_prior"].to_numpy() == 0
        for qi, (key, q) in enumerate(zip(QUANTILE_KEYS, self._quantiles)):
            frame = pd.DataFrame(out[:, :, qi], columns=PREDICTED_STATS,
                                 index=test.index)
            if rookie.any():
                fallback = test.loc[rookie, "position"].map(
                    lambda p: self._pos_fallback[q].loc[p]
                )
                frame.loc[rookie] = pd.DataFrame(
                    list(fallback), index=test.index[rookie],
                    columns=PREDICTED_STATS,
                ).astype(np.float32)
            result[key] = frame
        return result
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_predictor.py tests/test_harness.py -v`
Expected: all pass (the trained fixture takes ~1 min). Then full suite: green.

- [ ] **Step 7: Commit**

```bash
git add src/ffmodel/eval/metrics.py src/ffmodel/eval/harness.py src/ffmodel/model/predictor.py tests/test_predictor.py tests/test_harness.py
git commit -m "feat: quantile harness extension and transformer predictor"
```

---

### Task 6: Backtest CLI transformer entrant + walk-forward configs + Studio Lab notebook + README guide

**Files:**
- Modify: `src/ffmodel/eval/run.py`
- Create: `configs/transformer_v1_through2022.yaml`, `configs/transformer_v1_through2023.yaml`, `configs/transformer_v1_through2024.yaml`, `configs/transformer_v1.yaml`
- Create: `notebooks/train_studio_lab.ipynb`
- Modify: `README.md`
- Test: append one CLI-flag test to `tests/test_eval.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `python -m ffmodel.eval.run --transformer-root models/transformer/v1` adds the transformer as a third entrant (skipped with a clear message if artifacts are missing); JSON `results` rows carry the quantile keys when present.

- [ ] **Step 1: The four configs**

`configs/transformer_v1_through2022.yaml` (the other two `through` files differ ONLY in `val_season`; `transformer_v1.yaml` is the production model with `val_season: 2025`):

```yaml
run_name: v1
seed: 42
seq_len: 16
val_season: 2022          # through2023 file: 2023; through2024 file: 2024; production: 2025
first_season: 2012
quantiles: [0.1, 0.5, 0.9]
model:
  d_model: 96
  n_heads: 4
  n_layers: 3
  dropout: 0.1
train:
  batch_size: 256
  lr: 0.0005
  weight_decay: 0.01
  epochs: 60
  patience: 8
  grad_clip: 1.0
  amp: true          # fp16 autocast on the T4; ignored on CPU
out_root: models/transformer
checkpoint_root: models/checkpoints
```

(All four share `run_name: v1`, so artifacts land at `models/transformer/v1/through{2022,2023,2024,2025}/` — exactly what `TransformerPredictor.fit` expects for test seasons 2023/2024/2025 and 2026 production inference.)

- [ ] **Step 2: Failing CLI test (append to `tests/test_eval.py`)**

```python
def test_run_cli_parses_transformer_root():
    from ffmodel.eval.run import build_parser

    args = build_parser().parse_args(["--transformer-root", "models/transformer/v1"])
    assert str(args.transformer_root) == str(Path("models/transformer/v1"))
    assert build_parser().parse_args([]).transformer_root is None
```

(add `from pathlib import Path` to the test file's imports)

Run: `.venv/Scripts/python.exe -m pytest tests/test_eval.py -v` → new test FAILS (`build_parser` missing).

- [ ] **Step 3: Extend `src/ffmodel/eval/run.py`**

Refactor parser construction into `build_parser()` (same defaults as today plus one flag), and wire the entrant:

```python
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Walk-forward backtest.")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--first-season", type=int, default=2012)
    parser.add_argument("--last-season", type=int, default=2025)
    parser.add_argument("--test-seasons", nargs="+", type=int,
                        default=[2023, 2024, 2025])
    parser.add_argument("--out", type=Path,
                        default=Path("models/backtests/baselines.json"))
    parser.add_argument("--transformer-root", type=Path, default=None,
                        help="e.g. models/transformer/v1 — adds the transformer entrant")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    ...
    predictors = [NaiveLast4(), XGBBaseline()]
    if args.transformer_root is not None:
        from ffmodel.model.predictor import TransformerPredictor
        predictors.append(TransformerPredictor(args.transformer_root, features))
    results = run_backtest(features, predictors, test_seasons=args.test_seasons)
```

`main` keeps everything else identical (`json.dumps` handles the extra columns; `results.to_dict(orient="records")` now includes quantile keys for the transformer rows). Add one guard after `results`: replace NaN with None for JSON safety:

```python
    records = results.where(pd.notna(results), None).to_dict(orient="records")
```

and use `records` in the report (requires `import pandas as pd` in run.py).

- [ ] **Step 4: The Studio Lab notebook**

`notebooks/train_studio_lab.ipynb` — thin wrapper, 5 cells, no logic beyond shell calls. Create with this exact JSON:

```json
{
 "cells": [
  {"cell_type": "markdown", "metadata": {}, "source": [
   "# Train the quantile transformer (Studio Lab, GPU runtime)\n",
   "One walk-forward artifact per cell so a 4h session cutoff loses at most the epoch in flight — rerun the same cell with `--resume` after restarting the runtime.\n",
   "Prereq (once per Studio Lab project): clone the repo and `pip install -e .` inside it."
  ]},
  {"cell_type": "code", "execution_count": null, "metadata": {}, "outputs": [], "source": [
   "!git pull\n",
   "!pip install -q -e .\n",
   "!python -m ffmodel.data.pull --seasons 2012 2025 --out data/raw\n",
   "import torch; print('cuda:', torch.cuda.is_available())"
  ]},
  {"cell_type": "code", "execution_count": null, "metadata": {}, "outputs": [], "source": [
   "!python -m ffmodel.model.train --config configs/transformer_v1_through2022.yaml"
  ]},
  {"cell_type": "code", "execution_count": null, "metadata": {}, "outputs": [], "source": [
   "!python -m ffmodel.model.train --config configs/transformer_v1_through2023.yaml\n",
   "!python -m ffmodel.model.train --config configs/transformer_v1_through2024.yaml\n",
   "!python -m ffmodel.model.train --config configs/transformer_v1.yaml"
  ]},
  {"cell_type": "code", "execution_count": null, "metadata": {}, "outputs": [], "source": [
   "!python -m ffmodel.eval.run --transformer-root models/transformer/v1\n",
   "!git add models/transformer/v1 models/backtests configs\n",
   "!git commit -m \"model: transformer v1 walk-forward artifacts + bake-off results\"\n",
   "!git push"
  ]}
 ],
 "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
  "language_info": {"name": "python"}},
 "nbformat": 4, "nbformat_minor": 5
}
```

- [ ] **Step 5: README training section**

Append to `README.md`:

```markdown
## Training on SageMaker Studio Lab

1. Start a **GPU** runtime (T4; 4h/day quota) and open a terminal.
2. Once: `git clone <repo-url> && cd <repo> && pip install -e .`
3. Open `notebooks/train_studio_lab.ipynb` and run the cells top to bottom.
   Each config trains one walk-forward artifact (`models/transformer/v1/through<year>/`);
   training checkpoints every epoch, so if the session dies, restart the runtime
   and rerun the same cell adding `--resume`.
4. The last cell runs the full bake-off and commits artifacts + results.

Local CPU training works identically (slower): same commands, no notebook needed.
```

- [ ] **Step 6: Run the suite, then commit**

Run: `.venv/Scripts/python.exe -m pytest -v` — all green.

```bash
git add src/ffmodel/eval/run.py configs/ notebooks/ README.md tests/test_eval.py
git commit -m "feat: transformer bake-off entrant, walk-forward configs, Studio Lab notebook"
```

---

### Task 7: End-to-end CPU smoke run on real data

Proves the whole chain (pull → features → train → artifact → harness → JSON) before any GPU time is spent. Nothing from this task is committed except the report notes; smoke artifacts are gitignored.

**Files:**
- No new source files. Uses `configs/transformer_smoke.yaml` (Task 4) with real cached data.

- [ ] **Step 1: Train the smoke artifact on real data**

Run: `.venv/Scripts/python.exe -m ffmodel.model.train --config configs/transformer_smoke.yaml`
Expected: 3 epochs, each printing finite train/val pinball; artifact at `models/transformer/smoke/through2022/`; total runtime roughly 5-20 min on CPU. If an epoch exceeds ~15 min, note it in the report (it calibrates the real config's GPU-session budget) but let it finish.

- [ ] **Step 2: Resume check on real data**

Edit nothing; run the same command again with `--resume` after bumping `epochs` to 4 in the YAML (revert the YAML afterwards):
`.venv/Scripts/python.exe -m ffmodel.model.train --config configs/transformer_smoke.yaml --resume`
Expected: starts at epoch 4, not epoch 1.

- [ ] **Step 3: Smoke bake-off through the real harness**

Run: `.venv/Scripts/python.exe -m ffmodel.eval.run --transformer-root models/transformer/smoke --test-seasons 2023 --out "$TEMP/smoke-backtest.json"`
Expected: completes; transformer rows contain finite mae/rmse/pinball/coverage. The smoke model may well LOSE to both baselines — it is 1 layer × 3 epochs; that is not a red flag. Record the numbers (especially `coverage_p10_p90`) in the report. Red flags that DO stop the task: NaN metrics, index-misalignment errors, or coverage outside (0.3, 1.0).

- [ ] **Step 4: Revert the YAML epochs bump, verify clean tree, run full suite**

Run: `git status --short` (only untracked gitignored dirs), `.venv/Scripts/python.exe -m pytest` (green).

- [ ] **Step 5: Commit (README status only)**

Update README status checklist: mark Plan 2 code complete, add a line "Transformer walk-forward artifacts: pending GPU training (see Training on SageMaker Studio Lab)."

```bash
git add README.md
git commit -m "docs: Plan 2 status — code complete, GPU training pending"
```

---

### Task 8 (gated): snap-count usage feature spike

Spec §4 lists snap % among usage features; Plan 1 deferred it because nflverse snap counts key on PFR ids, not the gsis `player_id`. This task VALIDATES the join first and only ships the feature if it is clean. Judgment required — do not force it.

**Files:**
- Possibly modify: `src/ffmodel/data/pull.py`, `src/ffmodel/data/features.py`, `src/ffmodel/model/dataset.py`, tests.

- [ ] **Step 1: Spike (no commit): measure join coverage**

In a scratch script: `nflreadpy.load_snap_counts(seasons)` (has `pfr_player_id`, `game_id`, `offense_pct`) + `nflreadpy.load_players()` (maps `pfr_id` ↔ `gsis_id`). Join onto the canonical weekly frame by (gsis id, season, week). Report per-season match rate for QB/RB/WR/TE player-weeks.

- [ ] **Step 2: Gate decision**

- If match rate ≥ 90% for every season 2012-2025: add `snap_pct` to the canonical weekly schema (NaN where unmatched, documented like target_share), add it to `LAG_STATS` and `SEQ_FEATURES`, extend the pull unit tests, run the full suite, commit as `feat: snap-count usage feature`.
- If below 90% anywhere: do NOT ship it. Write the observed rates into `docs/superpowers/specs/2026-07-09-fantasy-football-model-design.md` §4 as an amendment ("snap % excluded in v1: join coverage <90% in seasons X-Y"), commit the spec amendment only.

Either outcome is a valid completion of this task; report which branch was taken and the measured rates.

---

## Done criteria for Plan 2

- Full suite green locally (offline), including dataset/net/train/predictor tests.
- Smoke run (Task 7) proves pull → train → artifact → harness → JSON end-to-end on real data with a resumable checkpoint.
- `run_backtest` handles quantile predictors; point baselines' existing tests unchanged.
- Studio Lab notebook + configs + README guide ready for the user's GPU session; the four `v1` training runs and the committed bake-off results are the USER's manual Studio Lab task (4h GPU/day; each run is expected to fit comfortably; `--resume` covers cutoffs).

**Next after GPU training lands:** Plan 3 (draft values, site, GitHub Actions weekly automation) — its future-week inference entry point ("features for a week that hasn't happened") is noted in the Plan 1 final review and must be an explicit task.
