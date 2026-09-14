import pandas as pd

from ffmodel.eval.rookie_decisions import compare, veteran_pool, summarize
from ffmodel.scoring import PREDICTED_STATS
from ffmodel.site.weekly import RULESETS


def test_disagreement_regret_missingness_and_ties():
    rookies = [dict(player_id="r", position="RB", bucketed=12, baseline=4)]
    veterans = pd.DataFrame([dict(player_id="v", position="RB", team="A", predicted=8)])
    actual = pd.DataFrame([dict(player_id="r", position="RB", team="B", actual=15),
                           dict(player_id="v", position="RB", team="A", actual=5)]).set_index("player_id")
    out = compare(rookies, veterans, actual)
    assert out["decisive_pairs"] == out["disagreements"] == 1
    assert out["disagreement_rookie_ids"] == ["r"]
    repeated = summarize([dict(position="RB", history_group="zero_history", decisions=out)]*2)[0]
    assert repeated["disagreement_rookie_ids"] == ["r"]
    assert repeated["disagreements"] == 2
    assert out["bucketed_regret_total"] == 0
    assert out["baseline_regret_total"] == 10
    assert out["bucketed_correct"] == 1 and out["baseline_correct"] == 0
    actual.loc["r", "actual"] = 0
    out = compare(rookies, veterans, actual)
    assert out["bucketed_regret_total"] == 5 and out["baseline_regret_total"] == 0
    actual.loc["r", "actual"] = 5
    out = compare(rookies, veterans, actual)
    assert out["actual_ties"] == 1
    report = summarize([dict(position="RB", history_group="zero_history", decisions=out)])[0]
    assert report["bucketed_accuracy"] is None
    assert report["bucketed_mean_regret"] == 0
    rookies[0]["bucketed"] = 8
    assert compare(rookies, veterans, actual)["forecast_tie_pairs"] == 1
    actual.loc["v", "team"] = "CHANGED"
    assert compare(rookies, veterans, actual)["unobserved_or_changed_pairs"] == 1
    assert compare(rookies, veterans, actual.iloc[:1])["decisive_pairs"] == 0


def test_pool_excludes_rookies_old_history_and_short_history():
    rows = []
    for pid, season, games in [("v", 2025, 4), ("r", 2025, 4), ("old", 2023, 4), ("short", 2025, 3)]:
        for week in range(1, games+1):
            rows.append(dict.fromkeys(PREDICTED_STATS, 0) | dict(player_id=pid, season=season,
                        week=week, team="A", position="RB", rushing_yards=week*10))
    pool = veteran_pool(pd.DataFrame(rows), {"r"}, 2026, RULESETS["ppr"])
    assert pool.player_id.tolist() == ["v"]
    assert pool.predicted.tolist() == [2.5]
