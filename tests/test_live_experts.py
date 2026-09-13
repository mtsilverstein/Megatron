import json
from pathlib import Path

import pandas as pd
import pytest

from ffmodel.site.live_experts import build_payload, publish, PAGES


@pytest.fixture
def feed():
    teams = [f"T{i}" for i in range(20)]
    kickoffs = {"season": 2026, "week": 1, "generated_at": "2026-09-13T10:00:00Z",
                "teams": teams, "games": [{"home": teams[i], "away": teams[i+1],
                "kickoff": "2026-09-13T17:00:00Z"} for i in range(0, 20, 2)]}
    rows, identities = [], []
    for page, pos in PAGES.items():
        for i in range(60):
            name = f"Player {pos} {i}"
            rows.append(dict(page=page, page_pos=pos, scrape_date="2026-09-13",
                             player_name=name, pos=pos, team=teams[i % 20],
                             player_opponent_id=teams[(i % 20) ^ 1], ecr=i+1,
                             r2p_pts="DO NOT CONSUME"))
            identities.append(dict(merge_name=name, position=pos, gsis_id=f"{pos}{i}"))
    return pd.DataFrame(rows), pd.DataFrame(identities), kickoffs


def build(feed):
    return build_payload(*feed, now="2026-09-13T12:00:00Z")


def test_live_rank_only_contract_and_content_archive(feed, tmp_path):
    payload = build(feed)
    assert len(payload["players"]) == 240
    assert payload["snapshot_precision"] == "date"
    assert payload["period_attribution"] == "inferred_from_schedule_opponents"
    assert "r2p" not in json.dumps(payload)
    assert "DO NOT CONSUME" not in json.dumps(payload)
    out, archive = tmp_path/"live.json", tmp_path/"archive"
    publish(payload, out, archive)
    publish(dict(payload, retrieved_at="2026-09-13T13:00:00Z"), out, archive)
    assert len(list(archive.glob("*.json"))) == 1
    assert json.loads(out.read_text())["players"] == payload["players"]
    payload["players"][0]["ecr"] = 2.5
    publish(payload, out, archive)
    assert len(list(archive.glob("*.json"))) == 2


@pytest.mark.parametrize("field,value,error", [
    ("player_opponent_id", "WRONG", "opponents"),
    ("scrape_date", "2026-09-12", "mixed"),
    ("pos", "WR", "position/page"),
    ("ecr", float("nan"), "invalid ECR"),
    ("player_name", "", "identity"),
])
def test_reject_bad_rows(feed, field, value, error):
    feed[0].loc[0, field] = value
    with pytest.raises(ValueError, match=error):
        build(feed)


def test_stale_feed_and_schedule(feed):
    feed[0]["scrape_date"] = "2026-09-01"
    with pytest.raises(ValueError, match="stale"):
        build(feed)
    feed[0]["scrape_date"] = "2026-09-14"
    with pytest.raises(ValueError, match="future"):
        build(feed)
    feed[0]["scrape_date"] = "2026-09-13"
    feed[2]["generated_at"] = "2026-09-01T00:00:00Z"
    with pytest.raises(ValueError, match="kickoff slate"):
        build(feed)


def test_missing_page_and_incomplete_schedule(feed):
    raw, ids, slate = feed
    with pytest.raises(ValueError, match="missing PPR"):
        build((raw[raw.page != "qb"], ids, slate))
    with pytest.raises(ValueError, match="incomplete opponent"):
        build((raw[raw.team != "T0"], ids, slate))
    with pytest.raises(ValueError, match="schema"):
        build((raw.drop(columns="player_opponent_id"), ids, slate))


def test_identity_ambiguity_never_first_matches(feed):
    raw, ids, slate = feed
    ambiguous = pd.concat([ids, ids.iloc[:1].assign(gsis_id="other")])
    result = build((raw, ambiguous, slate))
    assert result["coverage"]["matched"] == 239
    assert result["coverage"]["unmatched"][0]["reason"] == "ambiguous"
    with pytest.raises(ValueError, match="95 percent"):
        build((raw, ids.iloc[:20], slate))
    with pytest.raises(ValueError, match="duplicate mapped"):
        build((pd.concat([raw, raw.iloc[:1]]), ids, slate))


def test_feed_failure_keeps_last_published_reference(feed, tmp_path):
    out = tmp_path/"live.json"
    out.write_text("last good")
    feed[0]["player_opponent_id"] = "wrong"
    with pytest.raises(ValueError):
        publish(build(feed), out, tmp_path/"archive")
    assert out.read_text() == "last good"


def test_failed_publish_preserves_live_and_cleans_temporary_files(feed, tmp_path, monkeypatch):
    out, archive = tmp_path/"live.json", tmp_path/"archive"
    out.write_text("last good")
    original = Path.replace

    def fail_live(self, target):
        if target == out:
            raise OSError("injected replacement failure")
        return original(self, target)

    monkeypatch.setattr(Path, "replace", fail_live)
    with pytest.raises(OSError, match="injected"):
        publish(build(feed), out, archive)
    assert out.read_text() == "last good"
    assert not list(tmp_path.rglob("*.tmp"))
    snapshot = next(archive.glob("*.json"))
    assert json.loads(snapshot.read_text())["coverage"]["matched"] == 240
    snapshot.write_text("truncated")
    monkeypatch.setattr(Path, "replace", original)
    publish(build(feed), out, archive)
    assert json.loads(snapshot.read_text())["coverage"]["matched"] == 240
