"""Outcome builder (spec §7.6, final review I5): schema, predicted-stat scoring per format, refuses partial seasons."""
import datetime as dt
import json

import pandas as pd
import pytest

from ffmodel.prospective import freeze as F
from ffmodel.prospective import outcomes as O
from ffmodel.scoring import PREDICTED_STATS

TEAMS = ["AAA", "BBB"]
BUILT = dt.datetime(2027, 1, 12, 15, tzinfo=dt.timezone.utc)


def schedule(last=17, scores=True):
    rows = [dict(season=2026, week=w, home_team="AAA", away_team="BBB",
                 home_score=21.0 if scores else float("nan"), away_score=17.0) for w in range(1, last + 1)]
    return pd.DataFrame(rows)


def weekly(last=17, skip=None):
    rows = []
    for w in range(1, last + 1):
        for t, pid, pos in (("AAA", "p1", "RB"), ("BBB", "p2", "WR")):
            if skip == (w, t):
                continue
            r = {c: 0.0 for c in PREDICTED_STATS}
            r.update(season=2026, week=w, team=t, player_id=pid, player_display_name=pid.upper(), position=pos,
                     receptions=5.0, receiving_yards=50.0, rushing_yards=10.0)
            rows.append(r)
    return pd.DataFrame(rows)


def test_schema_weeks_and_per_format_scoring():
    out = O.build_outcomes(weekly(), schedule(), 2026, F.FORMATS, "2027-01-12", BUILT)
    assert out["schema_version"] == 1 and out["season"] == 2026 and out["as_of"] == "2027-01-12"
    assert out["built_at"] == "2027-01-12T15:00:00+00:00"
    assert set(out["actual_weeks"]) == set(F.FORMATS)
    for label, players in out["actual_weeks"].items():
        assert set(players) == {"p1", "p2"}
        assert set(players["p1"]) == {str(w) for w in range(5, 18)}  # weeks 5..17 only
    # 5 rec + 50 rec yd + 10 rush yd: PPR 5*1 + 5 + 1 = 11.0; half-PPR 2.5 + 6 = 8.5
    assert out["actual_weeks"]["f12-1qb-ppr-6"]["p1"]["5"] == 11.0
    assert out["actual_weeks"]["f12-1qb-half-4"]["p1"]["5"] == 8.5
    json.dumps(out)


def test_refuses_when_a_week_5_to_17_team_is_missing():
    with pytest.raises(O.OutcomesError, match="missing"):
        O.build_outcomes(weekly(skip=(12, "BBB")), schedule(), 2026, F.FORMATS, "2027-01-12", BUILT)
    with pytest.raises(O.OutcomesError, match="missing"):
        O.build_outcomes(weekly(last=15), schedule(), 2026, F.FORMATS, "2027-01-12", BUILT)


def test_early_weeks_missing_does_not_matter_but_partial_schedule_does():
    w = weekly()
    w = w[w.week >= 5]
    O.build_outcomes(w, schedule(), 2026, ["f12-1qb-ppr-6"], "2027-01-12", BUILT)
    with pytest.raises(O.OutcomesError, match="lacks weeks"):
        O.build_outcomes(weekly(), schedule(last=16), 2026, F.FORMATS, "2027-01-12", BUILT)


def test_refuses_games_without_final_score():
    with pytest.raises(O.OutcomesError, match="final"):
        O.build_outcomes(weekly(), schedule(scores=False), 2026, F.FORMATS, "2027-01-12", BUILT)


def test_cli_refuses_before_as_of_and_never_overwrites(tmp_path, monkeypatch, capsys):
    out = tmp_path / "o.json"
    assert O.main(["--season", "2026", "--as-of", "2027-01-12", "--out", str(out),
                   "--now", "2027-01-11T23:00:00+00:00"]) == 1
    assert "before as_of" in capsys.readouterr().err and not out.exists()
    out.write_text("{}")
    assert O.main(["--season", "2026", "--as-of", "2027-01-12", "--out", str(out),
                   "--now", "2027-01-12T15:00:00+00:00"]) == 1
    assert "never overwritten" in capsys.readouterr().err and out.read_text() == "{}"
