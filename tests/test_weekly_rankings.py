import numpy as np
import pandas as pd
import pytest


def _raw_weekly_rankings(rows):
    base = {"ecr_type": "wp", "page_type": "weekly-rb", "pos": "RB",
            "id": "1", "player": "A Back", "team": "AAA", "ecr": 5.0,
            "sd": 1.0, "mergename": "a back", "scrape_date": "2024-09-06",
            "player_image_url": "http://x", "rank_delta": 1.0}
    return pd.DataFrame([{**base, **r} for r in rows])


def test_normalize_keeps_weekly_positional_consensus_only():
    from ffmodel.eval.weekly_rankings import normalize_weekly_rankings

    raw = _raw_weekly_rankings([
        {"id": "1", "ecr_type": "wp", "page_type": "weekly-rb", "pos": "RB"},
        {"id": "2", "ecr_type": "ro", "page_type": "redraft-overall", "pos": "RB"},  # preseason, not weekly
        {"id": "3", "ecr_type": "wp", "page_type": "weekly-k", "pos": "K"},          # out of scope
        {"id": "4", "ecr_type": "wp", "page_type": "weekly-qb", "pos": "QB"},
    ])
    out = normalize_weekly_rankings(raw)
    assert sorted(out["fp_id"]) == ["1", "4"]
    assert "player_image_url" not in out.columns


def test_weekly_snapshot_is_strictly_before_kickoff_and_within_window():
    from ffmodel.eval.weekly_rankings import normalize_weekly_rankings, weekly_snapshot

    r = normalize_weekly_rankings(_raw_weekly_rankings([
        {"id": "old", "scrape_date": "2024-09-02", "ecr": 3.0},   # 6 days before, in window
        {"id": "fresh", "scrape_date": "2024-09-04", "ecr": 1.0},  # 4 days before, freshest pre-kick
        {"id": "leak", "scrape_date": "2024-09-09", "ecr": 2.0},   # AFTER kickoff
    ]))
    snap = weekly_snapshot(r, pd.Timestamp("2024-09-08"), max_stale_days=7)
    assert list(snap["fp_id"]) == ["fresh"]
    assert (snap["scrape_date"] < pd.Timestamp("2024-09-08")).all()


def test_weekly_snapshot_rejects_stale_only_window():
    """A week whose only scrape is older than max_stale_days must yield None,
    not a stale ranking handed to consensus that we'd then beat unfairly."""
    from ffmodel.eval.weekly_rankings import normalize_weekly_rankings, weekly_snapshot

    r = normalize_weekly_rankings(_raw_weekly_rankings([
        {"id": "1", "scrape_date": "2024-08-20"},   # 19 days before a 09-08 kickoff
    ]))
    assert weekly_snapshot(r, pd.Timestamp("2024-09-08"), max_stale_days=7) is None


def test_weekly_snapshot_none_when_only_post_kickoff():
    from ffmodel.eval.weekly_rankings import normalize_weekly_rankings, weekly_snapshot

    r = normalize_weekly_rankings(_raw_weekly_rankings([
        {"id": "1", "scrape_date": "2024-09-10"},
    ]))
    assert weekly_snapshot(r, pd.Timestamp("2024-09-08")) is None


# --- the sign-safe scoring core: the whole point is that a caller CANNOT
#     accidentally invert an entrant's score direction ---

def test_goodness_spearman_positive_for_a_good_predictor():
    """A projection where higher == better must correlate POSITIVELY with
    actual points. This is the structural guard against the sign bug that
    inverted our_pts (points, higher=better) using the rank pattern."""
    from ffmodel.eval.weekly_rankings import goodness_spearman

    actual = np.array([30.0, 20.0, 10.0, 5.0, 1.0])
    good_points = np.array([28.0, 22.0, 9.0, 6.0, 2.0])   # tracks actual
    assert goodness_spearman(good_points, actual) > 0.9


def test_consensus_rank_must_be_converted_to_goodness():
    """ECR is a rank (lower=better); the helper `ecr_goodness` negates it so
    the SAME positive-is-good contract applies to both entrants -- one place,
    tested, so no per-entrant sign mistake can recur."""
    from ffmodel.eval.weekly_rankings import ecr_goodness, goodness_spearman

    actual = np.array([30.0, 20.0, 10.0, 5.0, 1.0])
    ecr = np.array([1.0, 2.0, 3.0, 4.0, 5.0])             # perfectly ordered
    assert goodness_spearman(ecr_goodness(ecr), actual) > 0.9


def test_score_week_reports_both_entrants_with_correct_sign():
    from ffmodel.eval.weekly_rankings import score_week

    # one RB cell: our points track actual; ecr also perfect -> both Spearman +1
    g = pd.DataFrame({
        "player_id": list("abcde"), "position": "RB",
        "our_pts": [28.0, 22.0, 9.0, 6.0, 2.0],
        "ecr": [1.0, 2.0, 3.0, 4.0, 5.0],
        "actual": [30.0, 20.0, 10.0, 5.0, 1.0],
    })
    rows = score_week(g, season=2024, week=1, replacement_rank={"RB": 2},
                      min_cell=5)
    rb = [r for r in rows if r["position"] == "RB"][0]
    assert rb["sp_ours"] == pytest.approx(1.0)
    assert rb["sp_con"] == pytest.approx(1.0)
    assert rb["hit_ours"] == 2 and rb["hit_con"] == 2 and rb["slots"] == 2


def test_score_week_skips_thin_cells():
    from ffmodel.eval.weekly_rankings import score_week

    g = pd.DataFrame({"player_id": list("abc"), "position": "QB",
                      "our_pts": [3.0, 2.0, 1.0], "ecr": [1.0, 2.0, 3.0],
                      "actual": [3.0, 2.0, 1.0]})
    assert score_week(g, 2024, 1, {"QB": 5}, min_cell=5) == []


def test_model_sanity_guard_catches_inverted_scores():
    """A whole run whose model Spearman is negative is a sign bug, not a
    result -- assert_model_sane must raise so it can never be reported."""
    from ffmodel.eval.weekly_rankings import assert_model_sane

    good = pd.DataFrame({"sp_ours": [0.5, 0.6, 0.4], "sp_con": [0.5, 0.5, 0.5]})
    assert_model_sane(good)                     # fine
    inverted = pd.DataFrame({"sp_ours": [-0.5, -0.6, -0.4], "sp_con": [0.5, 0.5, 0.5]})
    with pytest.raises(AssertionError, match="negatively correlated"):
        assert_model_sane(inverted)
