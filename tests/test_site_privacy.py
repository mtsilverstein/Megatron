"""The site names no league and no person (owner decision 2026-11-07; audit
A7-5, A9-3): "It should be so anyone using sleeper can use it."

Every league the pipeline is configured for -- its league id, its slug and its
name -- must be absent from the site's own code and copy (site/*.html and
site/assets/**). site/data/** is the pipeline's published output and stays out
of scope until the 2027 rollover, like configs/ and docs/. The forbidden values
are read from configs/leagues/*.yaml, so this test repeats none of them, and
the owner's Sleeper username is checked by its SHA-256 digest for the same
reason.
"""
import hashlib
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OWNER_HANDLE_SHA256 = {"003417cdac44a3c78969d1fa9efcd36491189917e4e0005951dc1a042a5396d3"}
TOKEN = re.compile(r"[a-z0-9]+")
TEXT_SUFFIXES = {".html", ".js", ".css", ".svg", ".json", ".txt"}


def site_files():
    """The site's own files: every page and every asset; never site/data."""
    pages = sorted(SITE.glob("*.html"))
    assets = sorted(p for p in (SITE / "assets").rglob("*") if p.is_file() and p.suffix in TEXT_SUFFIXES)
    return pages + assets


def forbidden():
    """(tokens, phrases) naming every configured league: its slug, its id,
    the first word of its name, and its whole name."""
    tokens, phrases = set(), set()
    for cfg in sorted((ROOT / "configs" / "leagues").glob("*.yaml")):
        data = yaml.safe_load(cfg.read_text(encoding="utf8"))
        name = str(data["name"]).lower()
        tokens.update({cfg.stem.lower(), str(data["league_id"]), TOKEN.findall(name)[0]})
        phrases.add(name)
    return tokens, phrases


def hits(text, tokens, phrases, digests=OWNER_HANDLE_SHA256):
    low = text.lower()
    found = {t for t in TOKEN.findall(low)
             if t in tokens or hashlib.sha256(t.encode()).hexdigest() in digests}
    return found | {p for p in phrases if p in low}


def test_the_scan_reads_every_configured_league():
    tokens, phrases = forbidden()
    configs = list((ROOT / "configs" / "leagues").glob("*.yaml"))
    assert configs, "no league configs to scan for"
    assert len(phrases) == len(configs)
    assert sum(t.isdigit() for t in tokens) == len(configs), "every league id is scanned for"
    assert len(site_files()) > 10 and all("data" not in p.relative_to(SITE).parts for p in site_files())


def test_the_scan_catches_a_planted_identifier():
    # Positive controls, with synthetic values only.
    tokens, phrases = {"leaguez", "100000000000000009"}, {"league zed"}
    assert hits("fetch(`data/draft-leaguez.json`)", tokens, phrases) == {"leaguez"}
    assert hits('leagueId: "100000000000000009"', tokens, phrases) == {"100000000000000009"}
    assert hits("<h1>League Zed board</h1>", tokens, phrases) == {"league zed"}
    assert hits("font-family: system-ui; leaguezed", tokens, phrases) == set(), "whole tokens only"
    digest = {hashlib.sha256(b"usera").hexdigest()}
    assert hits("same account: UserA.", set(), set(), digest) == {"usera"}


def test_site_names_no_configured_league_and_not_the_owner():
    tokens, phrases = forbidden()
    bad = {}
    for path in site_files():
        found = hits(path.read_text(encoding="utf8"), tokens, phrases)
        if found:
            bad[str(path.relative_to(ROOT))] = len(found)
    # Counts only, so a failure does not print the identifiers it found.
    assert bad == {}, f"league or owner identifiers in the site's code or copy: {bad}"


def test_published_evaluation_records_name_no_league():
    """The about page renders `neutral/evaluation.json`; its records describe the
    scoring format, not a league. `source.path` is a file name, not copy."""
    from ffmodel.site.evidence_records import build_evaluation
    from ffmodel.site.neutral import BatchContext
    import json
    doc = build_evaluation(BatchContext(2026, 5, "2026-wk4", "2026-10-06T00:00:00+00:00", "x"), root=ROOT)
    for r in doc["records"]:
        r.pop("source")
    tokens, phrases = forbidden()
    found = hits(json.dumps(doc), tokens, phrases)
    assert found == set(), f"{len(found)} league identifier(s) in the evaluation records"
