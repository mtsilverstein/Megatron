# 2027 offseason plan

**Written:** 2026-11-03, during week 9 of the 2026 season, before any of the January results exist.
**Re-read:** after the January reads below (mid-January 2027). Update the "Outcome" lines then; do not rewrite the
decision rules.

This plan fixes, in advance, what each pending 2026 result leads to, so the January results are read against rules
written before they existed. The rules quoted here come from the specs that registered them; where this plan and a
spec disagree, the spec governs.

## 1. Fixed dates

| When | What | Who |
|---|---|---|
| Wed 2026-11-04 (before Thu 11-05 8:15 PM ET) | Origin-9 prospective freeze: `gh workflow run prospective-freeze.yml --ref main -f origin=9 -f dry_run=false -f contingency_origin9_only=false`. Fails closed (exit 4) if week-8 data is incomplete; retry before the cutoff. Done 2026-11-05 (commit e3860f7). | Owner dispatches |
| Weeks 9–18, every Tue/Wed | Weekly accuracy scorecard (automatic); the about page and weekly footer refresh from it. | Actions |
| After the last week-18 game | The single Sleeper blend read (spec 2026-10-06 §4.8.4, consequences §4.8.6). Read once; no earlier peeks. | Controller + owner, private repo only |
| 2027-01-12 to 01-14 (UTC) | Outcome capture for the per-format prospective test (spec 2026-09-30 §7.6). No capture in that window means the test is reported as not evaluated. | Actions (cron) |
| After the capture | Per-format verdicts written to `site/data/sim_gates.json`. | Controller |
| Feb–Apr 2027 | Retrain and re-evaluate with 2026 included (§3). | Kaggle (T4 x2) |
| ~Aug 20 2027 | 2027 draft board live. | |
| 2027 week 1 (early September; confirm from the schedule) | Weekly automation live for 2027. | |

## 2. What each January result buys

### 2.1 Sleeper blend read (spec 2026-10-06 §4.8.6)

- **Blend win** means Holm rejects `blend − Sleeper` as registered **and** the primary-view paired MAE delta is strictly
  negative. It authorises exactly one thing: an owner-only, private 50/50 blended path for the 2027 regular season
  (§4.8.6.3). That path:
  - is built only after documented rights cover the endpoint, automated acquisition, retention and private derived use
    (§4.8.6.4). If permission cannot be established, nothing is built;
  - is monitored over all 2027 regular-season weeks, suspended while any week is overdue, and expires after 2027;
  - never shows a band of its own, and never changes public output.
- **Anything else** (a reverse result, inconclusive, or no read): nothing is built, and Sleeper alone is not adopted.
- **Either way**, no Sleeper-derived number reaches this repository, the site, CI logs or this document.

Outcome: _(fill in after the read: category and action authorised, no numbers)_

### 2.2 Per-format roster-simulation test (spec 2026-09-30 §6)

- Each primary format gets its own verdict for `trade_grade` and for `waiver_sim`. Formats are not pooled.
- `conditional_pass` on a trade verdict opens only the **labelled experimental trade display** for leagues whose
  format key matches exactly. It never opens ordinary advice or waiver advice.
- A waiver pass is separate and never opened by a trade pass, nor the reverse. The spec predicts no waiver rescue.
- `inconclusive` or `conditional_fail`: the gate stays closed, and the failure is published.
- A pass is one season of evidence. `pass` (as opposed to `conditional_pass`) is reserved for a future cross-season
  rule, which 2027 could register (§4.4).
- The January write-up must disclose that the frozen ρ table uses a normalised estimator, not the spec's mean of
  products (about 20% lower). This makes the coverage gate harder to pass, never easier (audit A5-1).

Outcome: _(fill in per format after the evaluation)_

### 2.3 Results already settled (no January read)

- **Betting lines as features:** inconclusive against the 0.05 bar, not adopted. A 2027 retest needs its own
  pre-registration with 2026 added; it does not inherit the 2026 screen.
- **Same-week ranking benchmark:** the model is behind consensus. Nothing to read; it stays reported.

## 3. Retrain with 2026 included

1. When nflverse publishes final 2026 weekly stats, pull and cache them.
2. Walk-forward evaluation gains a fold: train ≤ 2025, test 2026. Report it next to 2023–25 for the transformer, XGBoost
   and the naive baseline, through the same harness. The live 2026 scorecard is a separate measurement (projections
   committed before kickoff, players who recorded a stat line) and is not substituted for this fold.
3. Train the three production seeds `through2026` on Kaggle (T4 x2, not P100), with each run seeded and
   config-driven, checkpointing every epoch.
4. Commit the artifacts with their YAML configs and eval metrics, as for `through2016`–`through2025`.
5. Point `ARTIFACT_ROOT` at the new runs only after the fold in step 2 has been reported, whichever model wins.

No architecture change rides along with the retrain. A new architecture is a separate, pre-registered experiment (§4).

## 4. What to try in 2027

The 2026 evidence is consistent with one reading, which has not been tested directly: the gap to expert consensus
is information the model never sees (depth charts, role and scheme changes) rather than the estimator. A
median-objective XGBoost ties the transformer on point error, the conditional-mean head improved points but not
ranking, feature pack v2 and the lines screen fell short, and the availability work did not move the board. The plan
therefore spends effort on measurement before building.

1. **ADP benchmark (cheap, first).** The preseason board has never been scored against ADP. Score the 2026 board
   against end-of-season results for ADP and expert consensus, by position, with the same tools used for consensus.
   This says how much preseason context is worth before anyone builds for it.
2. **Offseason context, if (1) shows a gap worth closing.** Candidates: depth-chart role, team and coaching changes,
   and target competition, all from free public data (nflverse). This needs an owner amendment to the v1 scope guard
   ("no injury/news signals") before any design work, and a pre-registered test with a pass bar set in advance.
3. **Cross-season roster-simulation rule.** If any format reached `conditional_pass` in 2026, register the 2027
   replication rule before the season, so `pass` has a defined meaning.
4. **Draft board for any Sleeper league.** The 2026 board was built per registered league. For 2027, build boards per
   scoring format and apply keeper rules from the league a visitor connects, so no league is a default (owner
   decision 2026-11-07).
5. **Not planned:** a bigger network, more in-season box-score features, kickers, defenses, DFS. Re-open only with a
   new reason.

## 5. Season rollover checklist (before the 2027 draft board)

- [ ] `SEASON: "2026"` in `.github/workflows/weekly-update.yml` → 2027. The prospective workflows
      (`prospective-freeze.yml`, `prospective-outcomes.yml`) belong to the 2026 protocol: retire or re-register them,
      never bump them silently.
- [ ] The cron months in `weekly-update.yml` (`9-12,1`) still match the 2027 season.
- [ ] New preseason ADP and ECR exports to replace the dated 2026 snapshots (`SNAPSHOT_PATH` in
      `src/ffmodel/data/adp.py`, `ECR_SNAPSHOT_PATH` in `src/ffmodel/data/rankings.py`).
- [ ] Sleeper creates new league IDs each season: update the two owner leagues' IDs and re-check keeper auto-fill.
- [ ] Hard-coded 2026 strings: the "2026 draft board (archived)" nav label on six pages and the DRAFT_ONLY copy in
  `site/assets/app.js` name the season; update them when the 2027 board ships.
- [ ] Connect-prompt markup is duplicated across weekly, waivers and trade; consolidate it when the 2027 board work
  touches those pages.
- [ ] The format-test label in `site/assets/leaguedata.js` ("results January 2027") reads correctly after the
      verdicts.
- [ ] The live accuracy scorecard runs for 2027 (`live_2027_weekly.json`; the site copy already follows `season`).
- [ ] Rookie projections for the 2027 class (`docs/rookie-research-protocol.md`).
- [ ] Pre-draft trade view at phone width; deferred from 2026 because it needs a league in `pre_draft`.
- [ ] Dependency drift: run the full suite against current pins and the latest pandas and nflreadpy. Pandas is capped
      `<4`. Check CI after every push.
- [ ] A dry run of the draft board (`weekly-update.yml` with `draft=true`) at least two weeks before Aug 20.
- [ ] Re-enable scheduled workflows. GitHub disables a public repo's scheduled workflows after 60 days without
      repository activity, so weekly-update, weekly-accuracy and market-snapshots will likely be disabled by spring.
      Check the Actions tab and run gh workflow enable for each (audit A9-8).
- [ ] FantasyPros data goes private. After the January read, move data_snapshots/fantasypros_*.csv,
      data_snapshots/weekly_ecr/ and data_snapshots/ros_ecr/ to the private data repo, point the same-week benchmark
      and the board's snapshot paths there, and capture 2027 exports privately from the start (spec §11 note of
      2026-11-07).
- [ ] League ids leave the public site data. The per-league legacy files (weekly.json, weekly-fam.json,
      remaining-<slug>.json, draft*.json league blocks) carry league ids and exist because the 2026 live scorecard
      reads site/data/weekly.json. Register the 2027 scorecard against the neutral batch, then stop generating them.
- [ ] Immutable releases. Before any 2027 freeze, enable immutable releases and make the freeze workflow create its
      release as a draft, attach the assets, then publish (an immutable release cannot take assets after publishing).
- [ ] Reserve-list status on the weekly slate. The roster feed's RES status (77 players in week 9 of 2026) is
      dropped; show it on the weekly page (audit A8-4).

## 6. Open owner decisions

1. Amend the v1 scope guard to allow offseason-context features (§4.2)? Decide after the ADP benchmark, not before.
2. Which leagues and formats does the site serve in 2027?
3. Publish a 2026 season retrospective (case study update) after the January reads?
