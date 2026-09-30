# Task 1 report: format contract slice

Status: DONE_WITH_CONCERNS. Commit: 9bcdc26 (branch feat/roster-sim-v2).

## Built
- `configs/formats/`: f12-1qb-ppr-6 (Gabagool copy), f10-1qb-ppr-6 (FAM copy), f12-1qb-ppr-4, f12-sf-ppr-4, f12-1qb-half-4. All `league_id: "format"`, `roster_size: 13`, rounds 15.
- `src/ffmodel/league.py`: optional `roster_size` on `LeagueConfig`.
- `src/ffmodel/formats.py`: `load_format`, `format_key`, `compat`, `from_sleeper`, `match`, plus `describe`, `describe_sleeper`, `canonical`, `AUDIT`.
- `site/assets/formats.js`: UMD `Formats` (`formatKey` async, `compat`, `fromSleeper`, `match`, `AUDIT`).
- `tests/test_formats.py` (13 tests), `tests/formats_fixture.cjs`, `tests/fixtures/owner_league_settings.json` (only total_rosters, roster_positions, scoring_settings).
- `export_origin_forecasts.py`: `build_parser()` split out, `--league-dir`, `format_key`/`compat` recorded in output when the dir is named `formats`. `draft_world.py`: `--league-dir` added to the parser (unused until Task 4).

## Live settings vs YAML
Both owner leagues' live scoring_settings equal their YAML `sleeper_scoring` exactly (every key, zero-normalized). No contradiction.
roster_positions for both: QB, RB, RB, WR, WR, TE, FLEX, FLEX, K, DEF, BN x5. **roster_size = 13 for both** (8 starters + 5 BN); total_rosters 12 (Gabagool) / 10 (FAM).

## Audit table (same in Py and JS; fixture asserts identity)
- predicted (Sleeper key -> stat): pass_yd, pass_td, pass_int, rush_yd, rush_td, rec_yd, rec_td, rec, fum_lost -> the 9 scored columns; `carries` and `targets` are predicted with weight 0. 11 components total, taken from `PREDICTED_STATS`/`stat_weights`.
- compat (always present, omitted -> 0): pass_int_td, pass/rush/rec_td_50p, pass/rush/rec_td_40p, pass/rush/rec_2pt, st_td, fum_rec_td, bonus_rec_te/rb/wr, bonus_fd_qb/rb/te/wr, pass_cmp, pass_inc, pass_att, pass_cmp_40p, pass_fd, pass_sack, rush_att, rush_40p, rush_fd, rec_fd, rec_0_4 .. rec_40p buckets, fum, kr_yd, pr_yd, bonus_pass_cmp_25, bonus_pass_yd_300/400, bonus_rec_yd_100/200, bonus_rush_att_20, bonus_rush_rec_yd_100/200, bonus_rush_td_qb, bonus_rush_yd_100/200.
- ignored exact: int, ff, fum_rec, safe, blk_kick, st_ff, st_fum_rec. Ignored prefixes: fgm, xp, pts_allow, yds_allow, def_, idp_, tkl, bonus_def_, bonus_sack, bonus_tkl, blk_kick, fg_ret, int_ret, sack, fum_ret, st_tkl, qb_hit.
- Unknown nonzero key: lands in compat under its own name (so it matches no format). Unknown zero: dropped.
- Keys returned by live Sleeper that were unclassified: none. Offensive keys I added to compat beyond the brief's minimum (ambiguity rule): the 40p variants, yardage/reception-bucket keys, fd/att/fum/kr_yd/pr_yd and the bonus_*_yd/att/td_qb family (all zero live).
- Unknown roster slot (e.g. IDP_FLEX) raises in `from_sleeper`; `match` returns None.

## Deviations / concerns
1. The three `-4` formats needed `st_td: 0.0` in their `scoring:` dict. The brief's scoring dict omits it, but `ScoringRules.st_td` defaults to 6.0 and `load_league`'s SLEEPER_RULE_FIELDS check (st_td maps to st_td, absent = 0) rejects the mismatch. Effect: -4 formats score no ST TD (consistent with their compat st_td = 0). Only affects actuals scoring, not predicted-scope export.
2. `f12-sf-ppr-4` has 8 starters so BN = 5 to reach roster_size 13 (same as the others).
3. Canonical number formatting: Python and JS agree for ordinary values; exponent-form edge cases (|x| < 1e-4 after rounding) could differ (1e-06 vs 0.000001). No current weight is that small.
4. `draft_world.py` `--league-dir` is parser-only for now; main does not consume it until Task 4.
5. Steps 3/4 (see-it-fail) were not run separately; tests were written before the implementation but I ran them after.

## Tests
- `.venv/Scripts/python.exe -m pytest tests/test_formats.py -q`: 13 passed.
- `node tests/formats_fixture.cjs`: `formats_fixture: ok`.
- Full: all 34 `node tests/*.cjs` exit 0; `.venv/Scripts/python.exe -m pytest -q`: 874 passed, 2 deselected (158.8 s).

## Fix wave

Changes (per controller decisions on task-1-review.md):
1. I1: f12-1qb-ppr-4, f12-sf-ppr-4, f12-1qb-half-4 now declare st_td 6.0 and fum_rec_td 6.0 in sleeper_scoring; the scoring st_td 0.0 override is removed (ScoringRules default 6 passes the consistency check). format_key values are unchanged (compat-only change; no pinned hashes existed in tests). Owner -6 formats untouched and still match live fixtures. Test: default-Sleeper 4-pt payload matches f12-1qb-ppr-4.
2. JS fail-closed weights: formats.js weight() throws on null/undefined/NaN/Infinity/blank/non-numeric for predicted, compat and unknown keys (ignored keys are not parsed), so match returns null. Python _weight() mirrors. Tests in test_formats.py and formats_fixture.cjs.
3. Prefix ignore rules replaced by explicit IGNORE_EXACT key list plus anchored full-match IGNORE_PATTERNS (fgm/fgmiss/pts_allow/yds_allow with numeric suffix; idp_*). AUDIT field renamed ignore_prefix -> ignore_patterns, identical in both languages. Tests: xp_bonus_rec, sack_bonus_qb, def_rec_bonus, tkl_rec_bonus, fgm_rush_bonus are NOT ignored and make match fail closed.
4. FORMAT_DIR = repo root (from module file) / configs/formats; test runs load_format/match from a tmp cwd.
5. Canonical numbers: both sides emit fixed-point text (6 decimals on the exact binary value, ties away from zero via Decimal ROUND_HALF_UP / toFixed, trailing zeros trimmed, -0 -> 0); Python no longer uses json.dumps for numbers. Parity cases 1e-5, 5e-7 (binary value is just below the tie so -> 0 on both), -1.5e-6, 1e-6, 0.0078125 (true tie -> 0.007813), 1e-7 asserted in both test files and cross-checked Python vs JS.

Format keys (unchanged): 
f12-1qb-ppr-6 eb00cacab498bcef3eaceedff0e91edc570d3ed61bc585fcd3d1787795c1dd96
f10-1qb-ppr-6 25e2c50a1ca7cf402b10c9b4c5abec3fa6ad2fa0682d685c1fad7b0bea8bb612
f12-1qb-ppr-4 3f0b5cf97cf4c003123784fd7bd5fa73700fa3b3742bea60ac6e34d3ccc8517b
f12-sf-ppr-4 6ef4f43270723e866c6d031afad46e38e7d2d164f9763009e5dcacb6d2c329d6
f12-1qb-half-4 856e7e74d3cc92ca7635d0d42bd48aa4dfd087eb2a58a11a0fe4a887a91c6752

Tests: tests/test_formats.py 23 passed; node tests/formats_fixture.cjs ok; every tests/*.cjs rc=0; pytest (copula_fit deselected, other agent) 879 passed, 11 deselected.
