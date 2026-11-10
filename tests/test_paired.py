import numpy as np
import pandas as pd
import pytest

from ffmodel.eval.paired import (
    BOOTSTRAP_SEED,
    N_BOOT,
    build_paired_report,
    pair_rows,
    paired_comparison,
)

POSITIONS = ["QB", "RB", "WR", "TE"]


def _rows(cluster_diffs: dict, per_cluster: int = 200) -> pd.DataFrame:
    """Harness-shaped rows for two entrants. Every row's actual is 10; the
    baseline is always 2 points off, the challenger 2 + d off, where d is
    constant inside a season-week -- so error differences are perfectly
    correlated within a week, the case a cluster bootstrap exists for."""
    recs = []
    for (season, week), d in cluster_diffs.items():
        for i in range(per_cluster):
            key = {"season": season, "week": week, "player_id": f"p{i:03d}",
                   "position": POSITIONS[i % 4], "actual": 10.0}
            recs.append({"model": "challenger", **key, "pred": 12.0 + d})
            recs.append({"model": "baseline", **key, "pred": 8.0})
    return pd.DataFrame(recs)


# Ten season-weeks. Within one week number the two seasons disagree in sign,
# so clustering by week alone (or not clustering at all) would wash the
# between-week spread out and report a far tighter interval.
DIFFS = {**{(2023, w): 0.1 + 1.0 for w in range(1, 6)},
         **{(2024, w): 0.1 - 1.0 for w in range(1, 6)}}
# make the two seasons' weeks interleave in sign as well, not just by season
DIFFS[(2023, 2)], DIFFS[(2024, 2)] = 0.1 - 1.0, 0.1 + 1.0


def test_known_difference_is_recovered_and_inside_its_interval():
    out = paired_comparison(_rows(DIFFS), "challenger", "baseline")
    pooled = out["pooled"]
    assert pooled["n"] == 2000
    assert pooled["mae_baseline"] == pytest.approx(2.0)
    assert pooled["mae_challenger"] == pytest.approx(2.1)
    assert pooled["mean_diff"] == pytest.approx(0.1)
    lo, hi = pooled["ci95"]
    assert lo <= 0.1 <= hi


def test_resampling_unit_is_the_season_week():
    """Whole season-weeks are resampled. Ten clusters whose differences are
    +-1 around 0.1 give a standard error near 1/sqrt(10) ~ 0.32, so the 95%
    interval is over a point wide and includes zero. Resampling the 2,000
    rows one at a time would give ~0.09 wide; clustering on week number alone
    would pair +1 with -1 inside every cluster and give ~0 wide."""
    pooled = paired_comparison(_rows(DIFFS), "challenger", "baseline")["pooled"]
    assert pooled["n_clusters"] == 10
    lo, hi = pooled["ci95"]
    assert hi - lo > 0.6
    assert lo < 0 < hi
    assert pooled["excludes_zero"] is False


def test_by_season_and_by_position_cells():
    out = paired_comparison(_rows(DIFFS), "challenger", "baseline")
    assert list(out["by_season"]) == ["2023", "2024"]
    s23 = out["by_season"]["2023"]
    assert s23["n"] == 1000 and s23["n_clusters"] == 5
    assert s23["mean_diff"] == pytest.approx((4 * 1.1 - 0.9) / 5)
    assert list(out["by_position"]) == POSITIONS
    for cell in out["by_position"].values():
        assert cell["n"] == 500 and cell["n_clusters"] == 10
        assert cell["mean_diff"] == pytest.approx(0.1)


def test_fixed_seed_is_reproducible():
    a = paired_comparison(_rows(DIFFS), "challenger", "baseline")
    b = paired_comparison(_rows(DIFFS), "challenger", "baseline")
    assert a == b
    assert N_BOOT >= 2000


def test_refuses_rows_that_are_not_paired():
    rows = _rows(DIFFS)
    with pytest.raises(ValueError, match="no rows for entrant"):
        pair_rows(rows, "challenger", "missing")
    dropped = rows.drop(index=rows.index[rows["model"] == "baseline"][:3])
    with pytest.raises(ValueError, match="scored by only one"):
        pair_rows(dropped, "challenger", "baseline")
    moved = rows.copy()
    moved.loc[moved.index[1], "actual"] = 11.0      # a baseline row
    with pytest.raises(ValueError, match="disagree on an actual"):
        pair_rows(moved, "challenger", "baseline")
    duplicated = pd.concat([rows, rows.iloc[[0]]], ignore_index=True)
    with pytest.raises(ValueError, match="duplicate"):
        pair_rows(duplicated, "challenger", "baseline")


def test_paired_report_records_protocol_and_every_baseline():
    rows = _rows(DIFFS)
    third = rows[rows["model"] == "baseline"].assign(model="other", pred=9.0)
    rows = pd.concat([rows, third], ignore_index=True)
    report = build_paired_report(rows, "challenger", ["baseline", "other"],
                                 {"created": "2026-11-07T00:00:00+00:00"})
    assert report["created"] == "2026-11-07T00:00:00+00:00"
    assert report["bootstrap"]["cluster"] == "season-week"
    assert report["bootstrap"]["seed"] == BOOTSTRAP_SEED
    assert report["bootstrap"]["n_boot"] == N_BOOT
    assert [c["baseline"] for c in report["comparisons"]] == ["baseline", "other"]
    assert report["comparisons"][1]["pooled"]["mae_baseline"] == pytest.approx(1.0)
    assert len(report["rows_sha256"]) == 64
    # the hash moves with any prediction
    nudged = rows.copy()
    nudged.loc[nudged.index[0], "pred"] += 1e-6
    assert build_paired_report(nudged, "challenger", ["baseline"], {})["rows_sha256"] \
        != report["rows_sha256"]
    assert np.isfinite(report["comparisons"][0]["pooled"]["ci95"]).all()
