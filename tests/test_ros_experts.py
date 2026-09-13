import json

import pandas as pd
import pytest

from ffmodel.site import ros_experts as ros


def fixtures(date="2026-09-11"):
    rows, ids = [], []
    counts = {"QB": 30, "RB": 55, "WR": 65, "TE": 30}
    pages = {"QB": "/nfl/rankings/ros-qb.php", "RB": "/nfl/rankings/ros-ppr-rb.php",
             "WR": "/nfl/rankings/ros-ppr-wr.php", "TE": "/nfl/rankings/ros-ppr-te.php",
             }
    rank = 1
    for pos, count in counts.items():
        for n in range(count):
            name, fp = f"{pos} Player {n}", str(rank)
            common = dict(scrape_date=date, player=name, id=fp, pos=pos, team="LAR", ecr=rank)
            rows.append(dict(common, fp_page=ros.OVERALL_PAGE, page_type="redraft-overall", ecr_type="ro"))
            rows.append(dict(common, fp_page=pages[pos], page_type=f"redraft-{pos.lower()}", ecr_type="rp"))
            if pos in ros.SKILL_POSITIONS:
                ids.append(dict(gsis_id=f"g{rank}", fantasypros_id=fp, merge_name=name,
                                position=pos))
            rank += 1
    return pd.DataFrame(rows), pd.DataFrame(ids)


def test_schema_horizon_and_exact_pages():
    raw, ids = fixtures()
    payload = ros.build_payload(raw, ids, now="2026-09-13T12:00:00Z")
    assert payload["schema_version"] == 1
    assert (payload["horizon"], payload["rank_scope"], payload["scoring_format"]) == ("ros", "overall", "ppr")
    assert payload["season"] == 2026 and payload["snapshot_precision"] == "date"
    assert payload["coverage"]["source_rows"] == len(raw)
    assert all(set(p) == {"player_id", "name", "position", "team", "ros_rank"} for p in payload["players"])
    assert "fpts" not in json.dumps(payload).lower()
    raw = raw[raw.fp_page.ne("/nfl/rankings/ros-qb.php")]
    with pytest.raises(ValueError, match="exact required pages"):
        ros.build_payload(raw, ids, now="2026-09-13T12:00:00Z")


@pytest.mark.parametrize(("now", "message"), [("2026-09-10T12:00:00Z", "future"),
                                                 ("2026-09-19T00:00:01Z", "stale")])
def test_future_and_stale_fail(now, message):
    raw, ids = fixtures()
    with pytest.raises(ValueError, match=message):
        ros.build_payload(raw, ids, now=now)


def test_january_is_previous_season_and_id_resolves_name_ambiguity():
    raw, ids = fixtures("2027-01-03")
    duplicate = ids.iloc[[0]].copy()
    duplicate["gsis_id"] = "wrong"
    duplicate["fantasypros_id"] = None
    ids = pd.concat([ids, duplicate], ignore_index=True)
    payload = ros.build_payload(raw, ids, now="2027-01-04T12:00:00Z")
    assert payload["season"] == 2026
    assert payload["players"][0]["player_id"] == "g1"


def test_ambiguous_name_without_id_fails_top180_coverage():
    raw, ids = fixtures()
    raw.loc[raw.fp_page.eq(ros.OVERALL_PAGE) & raw.ecr.le(10), "id"] = None
    dupes = ids[ids.fantasypros_id.astype(int).le(10)].copy()
    dupes["gsis_id"] = "other-" + dupes.gsis_id
    dupes["fantasypros_id"] = None
    ids = pd.concat([ids, dupes], ignore_index=True)
    with pytest.raises(ValueError, match="top-180"):
        ros.build_payload(raw, ids, now="2026-09-13T12:00:00Z")


def test_invalid_rank_rejected():
    raw, ids = fixtures()
    raw.loc[0, "ecr"] = 0
    with pytest.raises(ValueError, match="invalid ROS rank"):
        ros.build_payload(raw, ids, now="2026-09-13T12:00:00Z")


def test_wrong_overall_classification_and_thin_overall_rejected():
    raw, ids = fixtures()
    raw.loc[raw.fp_page.eq(ros.OVERALL_PAGE), "page_type"] = "draft-overall"
    with pytest.raises(ValueError, match="classification changed"):
        ros.build_payload(raw, ids, now="2026-09-13T12:00:00Z")
    raw, ids = fixtures()
    keep = ~raw.fp_page.eq(ros.OVERALL_PAGE) | raw.ecr.le(20)
    with pytest.raises(ValueError, match="overall skill-position coverage"):
        ros.build_payload(raw[keep], ids, now="2026-09-13T12:00:00Z")


def test_duplicate_identity_and_id_name_disagreement_rejected():
    raw, ids = fixtures()
    raw = pd.concat([raw, raw[raw.fp_page.eq(ros.OVERALL_PAGE)].iloc[[0]]], ignore_index=True)
    with pytest.raises(ValueError, match="duplicate mapped identity"):
        ros.build_payload(raw, ids, now="2026-09-13T12:00:00Z")
    raw, ids = fixtures()
    ids.loc[ids.fantasypros_id.eq("1"), ["gsis_id", "merge_name"]] = ["wrong-id", "Other Player"]
    ids = pd.concat([ids, pd.DataFrame([{"gsis_id": "g1", "fantasypros_id": None,
                                        "merge_name": "QB Player 0", "position": "QB"}])],
                    ignore_index=True)
    with pytest.raises(ValueError, match="identity disagreement"):
        ros.build_payload(raw, ids, now="2026-09-13T12:00:00Z")


def test_publish_archives_content_and_preserves_live_on_failure(tmp_path, monkeypatch):
    raw, ids = fixtures()
    payload = ros.build_payload(raw, ids, now="2026-09-13T12:00:00Z")
    out, archive = tmp_path / "site" / "ros-ecr.json", tmp_path / "archive"
    ros.publish(payload, out, archive)
    snapshots = list(archive.glob("2026-09-11-*.json"))
    assert len(snapshots) == 1 and "retrieved_at" not in snapshots[0].read_text()
    original = out.read_text()
    real_atomic_write = ros.atomic_write

    def fail(path, encoded):
        if path == out:
            raise OSError("disk failure")
        return real_atomic_write(path, encoded)

    monkeypatch.setattr(ros, "atomic_write", fail)
    with pytest.raises(OSError, match="disk failure"):
        ros.publish(payload, out, archive)
    assert out.read_text() == original
