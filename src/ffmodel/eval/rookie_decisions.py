"""Conditional rookie-versus-veteran slot decisions, not historical rosters."""
from ffmodel.eval.starter_decisions import POOL_SIZE, starter_pool
from ffmodel.scoring import PREDICTED_STATS, fantasy_points


def veteran_pool(history, rookie_ids, season, rules):
    ordered = history.sort_values(["season", "week"])
    counts = ordered.groupby("player_id").size()
    latest = ordered.groupby("player_id").tail(1).copy()
    latest = latest[(latest.season >= season-1) & ~latest.player_id.isin(rookie_ids)
                    & (latest.player_id.map(counts) >= 4)]
    recent = ordered.groupby("player_id").tail(4).copy()
    recent["points"] = fantasy_points(recent[PREDICTED_STATS], rules)
    baseline = recent.groupby("player_id").points.mean()
    selected = starter_pool(latest, baseline)
    latest = latest[latest.player_id.isin(selected)].copy()
    latest["predicted"] = latest.player_id.map(baseline)
    return latest


def compare(rookies, veterans, actual):
    """Same candidate pairs for both priors; no target-derived pool selection."""
    result = dict(candidate_pairs=0, unobserved_or_changed_pairs=0,
                  forecast_tie_pairs=0, decisive_pairs=0, actual_ties=0,
                  bucketed_correct=0, baseline_correct=0, disagreements=0,
                  bucketed_rookie_choices=0, baseline_rookie_choices=0,
                  bucketed_regret_total=0., baseline_regret_total=0.,
                  disagreement_bucketed_regret_total=0., disagreement_baseline_regret_total=0.)
    changed_rookies = set()
    for rookie in rookies:
        for veteran in veterans.itertuples():
            result["candidate_pairs"] += 1
            rid, vid = rookie["player_id"], veteran.player_id
            if (rid not in actual.index or vid not in actual.index
                    or actual.loc[rid].position != rookie["position"]
                    or actual.loc[vid].position != veteran.position
                    or actual.loc[vid].team != veteran.team):
                result["unobserved_or_changed_pairs"] += 1
                continue
            b = rookie["bucketed"] - veteran.predicted
            p = rookie["baseline"] - veteran.predicted
            if b == 0 or p == 0:
                result["forecast_tie_pairs"] += 1
                continue
            gap = actual.loc[rid].actual - actual.loc[vid].actual
            br = max(0., -gap if b > 0 else gap)
            pr = max(0., -gap if p > 0 else gap)
            disagreement = (b > 0) != (p > 0)
            result["decisive_pairs"] += 1
            result["actual_ties"] += int(gap == 0)
            result["bucketed_correct"] += int(b*gap > 0)
            result["baseline_correct"] += int(p*gap > 0)
            result["bucketed_rookie_choices"] += int(b > 0)
            result["baseline_rookie_choices"] += int(p > 0)
            result["bucketed_regret_total"] += br
            result["baseline_regret_total"] += pr
            result["disagreements"] += int(disagreement)
            if disagreement:
                changed_rookies.add(rid)
                result["disagreement_bucketed_regret_total"] += br
                result["disagreement_baseline_regret_total"] += pr
    result["disagreement_rookie_ids"] = sorted(changed_rookies)
    return result


def summarize(cells):
    groups = {}
    for cell in cells:
        if "decisions" not in cell:
            continue
        key = (cell["position"], cell["history_group"])
        total = groups.setdefault(key, {k: set() if k == "disagreement_rookie_ids" else 0
                                       for k in cell["decisions"]})
        for k, value in cell["decisions"].items():
            if k == "disagreement_rookie_ids":
                total[k].update(value)
            else:
                total[k] += value
    result = []
    for (position, history_group), counts in sorted(groups.items()):
        counts["disagreement_rookie_ids"] = sorted(counts["disagreement_rookie_ids"])
        n = counts["decisive_pairs"]
        non_ties = n-counts["actual_ties"]
        result.append(dict(position=position, history_group=history_group, **counts,
            bucketed_accuracy=counts["bucketed_correct"]/non_ties if non_ties else None,
            baseline_accuracy=counts["baseline_correct"]/non_ties if non_ties else None,
            bucketed_mean_regret=counts["bucketed_regret_total"]/n if n else None,
            baseline_mean_regret=counts["baseline_regret_total"]/n if n else None))
    return result
