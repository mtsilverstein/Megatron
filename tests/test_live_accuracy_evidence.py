"""Spec §4.1/§4.3 publication and archive evidence against a synthetic git history and push ledger."""
import hashlib
import json

import pandas as pd
import pytest

from ffmodel.eval import live_accuracy as la


class FakeGit:
    """commits: sha -> {parents, author, committer, changed, files: {path: bytes}, time}"""

    def __init__(self, commits):
        self.c = commits

    def exists(self, sha): return bool(sha) and sha in self.c
    def ident(self, sha): return self.c[sha]["author"], self.c[sha]["committer"]
    def changed(self, sha): return set(self.c[sha]["changed"])
    def show(self, sha, path): return self.c[sha]["files"].get(path)
    def rev_parse(self, ref): return ref
    def tree_id(self, path="src/ffmodel"): return "tree0"
    def dirty(self, path="src/ffmodel"): return False

    def _walk(self, sha):
        """Full ancestry; the only stopping point is a commit already visited (never a timestamp)."""
        out, stack = [], [sha]
        while stack:
            s = stack.pop()
            if s in out or s not in self.c:
                continue
            out.append(s)
            stack.extend(reversed(self.c[s].get("parents", [])))
        return out

    def is_ancestor(self, a, b): return a in self._walk(b)
    def existing(self, shas): return {s for s in shas if self.exists(s)}
    def reachable(self, tip): return set(self._walk(tip))
    def descendants_among(self, c, shas): return {s for s in shas if self.exists(s) and self.is_ancestor(c, s)}

    def first_adding_commit(self, main_sha, path):
        adds = [s for s in self._walk(main_sha) if path in self.c[s]["changed"] and path in self.c[s]["files"]]
        return min(adds, key=lambda s: self.c[s]["time"]) if adds else None

    def ls_dir(self, sha, dirpath):
        return sorted(p.split("/")[-1] for p in self.c[sha]["files"] if p.startswith(dirpath + "/"))

    def weekly_commits(self, tips, exclude=()):
        skip = {s for e in exclude for s in self._walk(e)}
        out = []
        for t in tips:
            out += [s for s in self._walk(t) if s not in skip and s not in out]
        return [(s, self.c[s]["time"], self.c[s]["author"], self.c[s]["committer"])
                for s in out if self.c[s]["changed"] & set(la.WEEKLY_FILES)]


def _legacy(week, gen="2026-09-30T21:29:16+00:00"):
    return json.dumps({"season": 2026, "week": week, "generated_at": gen,
                       "players": [{"player_id": "p1", "position": "WR", "team": "AAA",
                                    "points": {"ppr": {"p10": 1.0, "p50": 5.0, "p90": 9.0}}}]}).encode()


def _neutral(week, gen="2026-09-30T21:29:16+00:00"):
    sq = {q: {"receptions": v, "receiving_yards": 10 * v} for q, v in (("p10", 0.5), ("p50", 2.5), ("p90", 4.5))}
    return json.dumps({"season": 2026, "week": week, "generated_at": gen,
                       "players": [{"player_id": "p1", "position": "WR", "team": "AAA", "stat_quantiles": sq}]}).encode()


def _c(parents, author="me", changed=(), files=None, time="2026-09-30T00:00:00Z"):
    return {"parents": list(parents), "author": author, "committer": author, "changed": set(changed),
            "files": files or {}, "time": time}


LEG, NEU = la.WEEKLY_FILES


def _history():
    return FakeGit({
        "h0": _c([], changed={"README.md"}, time="2026-07-12T00:00:00Z"),
        "b1": _c(["h0"], la.BOT, {LEG}, {LEG: _legacy(4)}, "2026-09-30T09:59:00Z"),
        "b2": _c(["b1"], la.BOT, {NEU}, {LEG: _legacy(4), NEU: _neutral(4)}, "2026-09-30T20:59:00Z"),
        "m1": _c(["b2"], "me", {LEG}, {LEG: _legacy(4), NEU: _neutral(4)}, "2026-09-30T21:30:00Z"),
        "a1": _c(["m1"], "weekly-accuracy-bot", {LEG}, {LEG: _legacy(4)}, "2026-09-30T21:40:00Z"),
    })


def _ev(i, after, ts, kind="push", before="x"):
    return {"id": i, "ref": "refs/heads/main", "timestamp": ts, "before": before, "after": after,
            "activity_type": kind, "actor": {"login": "github-actions[bot]", "id": 1}}


CUT = pd.Timestamp("2026-10-01T00:00:00Z")


def _ledger(events, cov=("-inf", "2026-10-06T00:00:00Z")):
    return la.merge_collection({"events": [], "coverage": []}, events, t_end=cov[1], t_start=cov[0])


class _Run:
    def __init__(self, stdout, code=0):
        self.stdout, self.returncode, self.stderr = stdout, code, "boom"

    def __call__(self, cmd, **kw):
        assert cmd[:4] == ["gh", "api", "--paginate", "--slurp"]
        return self


def test_fetch_activity_flattens_slurped_pages_and_fails_safe():
    pages = [[_ev(i, f"s{i}", "2026-09-01T00:00:00Z") for i in range(p * 3, p * 3 + 3)] for p in range(3)]
    events = la.fetch_activity("o/r", run=_Run(json.dumps(pages)))
    assert [e["id"] for e in events] == list(range(9))
    with pytest.raises(RuntimeError):
        la.fetch_activity("o/r", run=_Run(json.dumps([pages[0], {"message": "x"}])))     # a non-array page
    with pytest.raises(RuntimeError):
        la.fetch_activity("o/r", run=_Run("", code=1))                                    # failed fetch
    with pytest.raises(RuntimeError):
        la.fetch_activity("o/r", run=_Run("\n".join(json.dumps(p) for p in pages)))      # un-slurped output


def test_selects_latest_covered_push_and_neutral_only_commit_is_candidate():
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-09-30T21:00:00Z")])
    r = la.select_publication(led, _history(), 2026, 4, CUT, "m1")
    assert r["status"] == "selected" and r["commit"] == "b2" and r["available_by"] == "2026-09-30T21:00:00Z"


def test_push_after_cutoff_not_selected_and_non_bot_commits_never_candidates():
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-10-01T00:00:02Z"),
                   _ev(3, "m1", "2026-09-30T22:00:00Z"), _ev(4, "a1", "2026-09-30T23:00:00Z")])
    r = la.select_publication(led, _history(), 2026, 4, CUT, "a1")
    assert r["commit"] == "b1"                      # m1 (hand-made) and a1 (weekly-accuracy-bot) are rejected
    assert not la.is_candidate(_history(), "a1", 2026, 4) and not la.is_candidate(_history(), "m1", 2026, 4)


def test_commit_changing_neither_weekly_file_is_not_a_candidate():
    g = _history()
    g.c["x1"] = _c(["b2"], la.BOT, {"README.md"}, {LEG: _legacy(4)})
    assert not la.is_candidate(g, "x1", 2026, 4) and la.is_candidate(g, "b2", 2026, 4)


def test_earliest_event_per_sha_and_id_tiebreak():
    led = _ledger([_ev(5, "b1", "2026-09-30T12:00:00Z"), _ev(4, "b1", "2026-09-30T12:00:00Z"),
                   _ev(3, "b1", "2026-09-30T13:00:00Z")])
    r = la.select_publication(led, _history(), 2026, 4, CUT, "m1")
    assert r["event_id"] == 4 and r["available_by"] == "2026-09-30T12:00:00Z"


def test_gap_after_publication_makes_unavailable_and_older_push_not_promoted():
    led = la.merge_collection({"events": [], "coverage": []},
                              [_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-09-30T21:00:00Z")],
                              t_start="-inf", t_end="2026-09-30T22:00:00Z")
    r = la.select_publication(led, _history(), 2026, 4, CUT, "m1")
    assert r["status"] == "publication_evidence_unavailable" and r["commit"] is None


def test_force_push_in_window_makes_unavailable():
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "m1", "2026-09-30T15:00:00Z", kind="force_push")])
    assert la.select_publication(led, _history(), 2026, 4, CUT, "m1")["status"] == "publication_evidence_unavailable"


def test_unfetchable_pr_merge_target_in_window_makes_unavailable():
    # astra P2: the step-4 check covers every activity type, not only push
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "ghost", "2026-09-30T20:00:00Z", kind="pr_merge")])
    r = la.select_publication(led, _history(), 2026, 4, CUT, "m1")
    assert r["status"] == "publication_evidence_unavailable" and r["event_id"] == 2


def test_payload_only_at_force_push_target_is_candidate_not_unpublished():
    # astra P2: a week-9 bot payload exists only at a retained force_push target, unreachable from main
    g = _history()
    g.c["fx"] = _c(["m1"], la.BOT, {LEG}, {LEG: _legacy(9)}, "2026-10-29T10:00:00Z")
    led = _ledger([_ev(1, "fx", "2026-10-29T10:05:00Z", kind="force_push"),
                   _ev(2, "m1", "2026-10-29T10:10:00Z", kind="force_push")],
                  cov=("-inf", "2026-11-06T00:00:00Z"))
    r = la.select_publication(led, g, 2026, 9, pd.Timestamp("2026-10-29T00:00:00Z") + pd.Timedelta(days=1), "m1")
    assert r["status"] == "publication_evidence_unavailable"


def test_pre_june_commit_pushed_in_season_is_selected():
    # astra S7-I1: committer time 2026-05-31 (before T_S), pushed 2026-09-30, removed from main by an Oct 2
    # force-push. Commit clocks are creation times, not publication times: it is a candidate and is selected.
    g = FakeGit({
        "h0": _c([], changed={"README.md"}, time="2026-07-12T00:00:00Z"),
        "lost": _c(["h0"], la.BOT, {LEG}, {LEG: _legacy(4)}, "2026-05-31T23:00:00Z"),
        "m2": _c(["h0"], "me", {"README.md"}, time="2026-10-02T08:00:00Z"),
    })
    led = _ledger([_ev(1, "lost", "2026-09-30T10:00:00Z"), _ev(2, "m2", "2026-10-02T09:00:00Z", kind="force_push")])
    assert la.is_candidate(g, "lost", 2026, 4)
    assert la.candidate_index(led, g, 2026, "m2").by_week == {4: {"lost"}}
    r = la.select_publication(led, g, 2026, 4, CUT, "m2")
    assert r["status"] == "selected" and r["commit"] == "lost" and r["available_by"] == "2026-09-30T10:00:00Z"


def test_ancestry_with_non_monotone_commit_times_is_walked_completely():
    # A backdated weekly-changing commit (May) sits between an off-main target and an in-season week-4 bot
    # commit. A walk that stopped at the first pre-T_S timestamp would miss c1 and claim weeks_unpublished.
    g = FakeGit({
        "h0": _c([], changed={"README.md"}, time="2026-07-12T00:00:00Z"),
        "c1": _c(["h0"], la.BOT, {LEG}, {LEG: _legacy(4)}, "2026-09-29T08:00:00Z"),
        "mid": _c(["c1"], "me", {LEG}, {LEG: _legacy(4)}, "2026-05-15T00:00:00Z"),
        "tip": _c(["mid"], "me", {"README.md"}, {LEG: _legacy(4)}, "2026-09-30T09:00:00Z"),
        "m2": _c(["h0"], "me", {"README.md"}, time="2026-10-02T08:00:00Z"),
    })
    led = _ledger([_ev(1, "tip", "2026-09-30T10:00:00Z"), _ev(2, "m2", "2026-10-02T09:00:00Z", kind="force_push")])
    assert la.candidate_index(led, g, 2026, "m2").by_week == {4: {"c1"}}
    r = la.select_publication(led, g, 2026, 4, CUT, "m2")
    assert r["status"] == "publication_evidence_unavailable"                     # a payload existed; never absent


def test_absence_needs_complete_coverage_from_season_lower_bound():
    g = _history()
    full = _ledger([])
    assert la.select_publication(full, g, 2026, 9, CUT, "m1")["status"] == "weeks_unpublished"
    gappy = {"events": [], "coverage": [["-inf", "2026-09-15T00:00:00Z"], ["2026-09-20T00:00:00Z", "2026-10-06T00:00:00Z"]]}
    assert la.select_publication(gappy, g, 2026, 9, CUT, "m1")["status"] == "publication_evidence_unavailable"
    late_start = {"events": [], "coverage": [["2026-07-01T00:00:00Z", "2026-10-06T00:00:00Z"]]}
    assert la.select_publication(late_start, g, 2026, 9, CUT, "m1")["status"] == "publication_evidence_unavailable"


def test_collection_ending_at_branch_creation_covers_back_to_minus_infinity():
    raw = [_ev(1, "h0", "2026-07-11T22:02:06Z", kind="branch_creation", before=la.ZERO_SHA),
           _ev(2, "b1", "2026-09-30T10:00:00Z")]
    led = la.merge_collection({"events": [], "coverage": []}, raw, t_end="2026-10-06T19:02:01Z")
    assert led["coverage"] == [["-inf", "2026-10-06T19:02:01Z"]]
    assert la.covered(led, "2026-06-01T00:00:00Z", "2026-10-01T00:00:00Z")
    partial = la.merge_collection({"events": [], "coverage": []}, raw[1:], t_end="2026-10-06T19:02:01Z")
    assert partial["coverage"] == [["2026-09-30T10:00:00Z", "2026-10-06T19:02:01Z"]]


def test_commit_before_push_after_cutoff_selects_older():
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-10-01T00:00:02Z")])
    assert la.select_publication(led, _history(), 2026, 4, CUT, "m1")["commit"] == "b1"


def test_sibling_merged_after_cutoff_is_never_selected():
    # astra r3: P and F share a parent; F joins main through a merge pushed after the cutoff
    g = FakeGit({
        "r0": _c([], changed={"README.md"}, time="2026-09-29T00:00:00Z"),
        "P": _c(["r0"], la.BOT, {LEG}, {LEG: _legacy(4)}, "2026-09-30T19:00:00Z"),
        "F": _c(["r0"], la.BOT, {LEG}, {LEG: _legacy(4, gen="later")}, "2026-09-30T19:30:00Z"),
        "M": _c(["P", "F"], "me", {LEG}, {LEG: _legacy(4, gen="later")}, "2026-10-02T09:00:00Z"),
    })
    led = _ledger([_ev(1, "P", "2026-09-30T20:00:00Z"), _ev(2, "M", "2026-10-02T10:00:00Z", kind="pr_merge")])
    r = la.select_publication(led, g, 2026, 4, CUT, "M")
    assert r["status"] == "selected" and r["commit"] == "P"
    assert "F" in la.candidate_index(led, g, 2026, "M").by_week[4]


def test_merge_collection_dedupes_and_keeps_login_only():
    led = _ledger([_ev(1, "b1", "2026-09-30T10:00:00Z")], cov=("2026-07-01T00:00:00Z", "2026-10-06T00:00:00Z"))
    led = la.merge_collection(led, [_ev(1, "b1", "2026-09-30T10:00:00Z"), _ev(2, "b2", "2026-09-30T11:00:00Z")],
                              t_start="2026-09-01T00:00:00Z", t_end="2026-10-07T00:00:00Z")
    assert [e["id"] for e in led["events"]] == [1, 2] and led["events"][0]["actor"] == "github-actions[bot]"
    assert len(led["coverage"]) == 2 and la.covered(led, "2026-07-02T00:00:00Z", "2026-10-06T23:00:00Z")


def _archive(week, date, players, season=2026, payload_week=None):
    payload = {"season": season, "week": week if payload_week is None else payload_week, "snapshot_at": date,
               "players": players}
    enc = json.dumps(payload, sort_keys=True, indent=2, allow_nan=False)
    name = f"{season}-w{week:02d}-{date}-{hashlib.sha256(enc.encode()).hexdigest()[:16]}.json"
    return f"{la.ARCHIVE_DIR}/{name}", enc.encode()


def _players(ecr, n=1):
    return [{"player_id": f"p{i}", "ecr": ecr + i, "position": "WR", "team": "AAA"} for i in range(n)]


def _archive_world(early, late, after):
    (p_e, b_e), (p_l, b_l), (p_a, b_a) = early, late, after
    commits = {
        "a1": _c([], la.BOT, {p_e}, {p_e: b_e}, "2026-09-30T10:59:00Z"),
        "a2": _c(["a1"], la.BOT, {p_l}, {p_e: b_e, p_l: b_l}, "2026-09-30T20:59:00Z"),
        "a3": _c(["a2"], la.BOT, {p_a}, {p_e: b_e, p_l: b_l, p_a: b_a}, "2026-10-01T03:58:00Z"),
    }
    led = _ledger([_ev(1, "a1", "2026-09-30T11:00:00Z"), _ev(2, "a2", "2026-09-30T21:00:00Z", kind="pr_merge"),
                   _ev(3, "a3", "2026-10-01T03:58:50Z")])
    return FakeGit(commits), led


def test_archive_selection_evidence_cutoff_and_alternatives():
    early, late = _archive(4, "2026-09-30", _players(1.0)), _archive(4, "2026-09-30", _players(2.0))
    after = _archive(4, "2026-09-29", _players(3.0))
    g, led = _archive_world(early, late, after)
    r = la.select_archive(led, g, 2026, 4, CUT, "a3")
    assert r["status"] == "selected" and r["path"] == late[0] and r["available_by"] == "2026-09-30T21:00:00Z"
    assert [a["name"] for a in r["alternatives"]] == [early[0].split("/")[-1]]
    assert r["alternatives"][0]["blob_sha256"] == hashlib.sha256(early[1]).hexdigest()
    assert list(r["consensus"]["player_id"]) == ["p0"]
    only_late = _ledger([_ev(3, "a3", "2026-10-01T03:58:50Z")])                    # the week-3 shape
    assert la.select_archive(only_late, g, 2026, 4, CUT, "a3")["status"] == "no_archive"


def test_archive_tie_is_flagged():
    early, late = _archive(4, "2026-09-30", _players(1.0)), _archive(4, "2026-09-30", _players(2.0))
    g, _ = _archive_world(early, late, _archive(4, "2026-09-29", _players(3.0)))
    led = _ledger([_ev(2, "a2", "2026-09-30T21:00:00Z")])                          # both first appear via a2
    r = la.select_archive(led, g, 2026, 4, CUT, "a2")
    assert r["tie_break"] == "arbitrary_lexicographic" and r["name"] == min(early[0], late[0]).split("/")[-1]


def test_archive_hash_mismatch_is_not_promoted_past():
    early, late = _archive(4, "2026-09-30", _players(1.0)), _archive(4, "2026-09-30", _players(2.0))
    g, led = _archive_world(early, late, _archive(4, "2026-09-29", _players(3.0)))
    g.c["a2"]["files"][late[0]] = late[1] + b" "
    r = la.select_archive(led, g, 2026, 4, CUT, "a3")
    assert r["status"] == "archive_hash_mismatch" and r["consensus"] is None


def test_archive_identity_mismatch():
    # astra P4: correctly hashed, named for week 4, payload says week 9
    wrong = _archive(4, "2026-09-30", _players(1.0), payload_week=9)
    g, led = _archive_world(_archive(4, "2026-09-30", _players(5.0)), wrong, _archive(4, "2026-09-29", _players(3.0)))
    assert la.select_archive(led, g, 2026, 4, CUT, "a3")["status"] == "archive_identity_mismatch"


def test_archive_above_threshold_is_validation_failed_and_not_promoted():
    bad = _players(1.0, n=50)
    bad[0]["ecr"] = None                                                             # 1 of 50 keys = 2% > 1%
    g, led = _archive_world(_archive(4, "2026-09-30", _players(5.0)), _archive(4, "2026-09-30", bad),
                            _archive(4, "2026-09-29", _players(3.0)))
    r = la.select_archive(led, g, 2026, 4, CUT, "a3")
    assert r["status"] == "validation_failed" and r["consensus"] is None
    assert r["alternatives"][0]["status"] == "qualifies"                             # listed, never promoted


def test_archive_content_read_from_first_adding_commit_not_later_tree():
    early, late = _archive(4, "2026-09-30", _players(1.0)), _archive(4, "2026-09-30", _players(2.0))
    g, led = _archive_world(early, late, _archive(4, "2026-09-29", _players(3.0)))
    g.c["a3"]["files"][late[0]] = b"tampered later"                                  # later tree differs
    assert la.select_archive(led, g, 2026, 4, CUT, "a3")["status"] == "selected"
