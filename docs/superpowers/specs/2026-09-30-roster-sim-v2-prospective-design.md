# Roster simulation v2 and its prospective 2026 test — design

Status: design agreed by Claude and astra (`.review/astra-v2-response.md`, `.review/astra-v2-round2-response.md`,
VERDICT: AGREE), owner decisions 2026-09-30. Supersedes nothing: v1's spec
(`2026-09-24-roster-simulation-grade-design.md`) and its published result stand unchanged.

## 1. Problem, goal and scope

v1 failed its walk-forward test on one check: 80% season intervals of a trade side's Δ covered 0.650 / 0.665
against [0.70, 0.90]. The cause was diagnosed before the run (v1 spec §10.5): weekly p10–p90 coverage is calibrated
(0.76–0.80), but a player's forecast errors persist across weeks (between-player variance of mean residuals 1.7–3.0×
the independent-weeks prediction). §10.5 fixed the response: a v2 with its own predeclared test, evaluated
prospectively on 2026, never re-scored on 2023–2025.

**Goal (project A).** Build v2 — a per-player persistent error term — and freeze a complete prospective test on the
2026 season across a small set of common league formats, so its verdict is keyed by *format*, not by the owner's
leagues.

**End goal (owner).** A global tool: any Sleeper league in a supported format works on the site, with advice opened
per format that has passed. This spec delivers the minimal slice of that end goal that A depends on (§4); the rest is
two later specs: **B** (format-grid execution, GitHub Actions matrix sharding) and **C** (any-league site support:
boards per format, open league picker).

**What v2 is and is not.** v2 is an *interval repair*. Lineups are chosen by frozen p50 and availability is
unchanged, so v2 leaves every expected roster value — and therefore expected trade Δs and waiver drop choices — the
same as v1. v2 is not expected to improve accuracy, and it is not a fix for the failed FAM waiver replication (v1
§10.8). It also need not widen every trade interval: a side's Δ is a signed sum, so positive dependence widens
like-signed terms and narrows opposite-signed ones.

Non-goals: team/game dependence (stacks), Student-t or random-scale dependence, K/DST/IDP, keepers, picks,
exact-scoring coverage beyond the modeled stat components (§4.3).

## 2. Owner decisions (2026-09-30)

1. **A 2026 conditional pass shows a labeled experimental display** ("Experimental — tested on the 2026 season in
   synthetic leagues only"). The ordinary gate stays closed until a later prospective season confirms under a
   cross-season rule declared then.
2. **Primary formats: four** (§4.1). Anything else is exploratory and cannot pass.
3. **Go for the origin-5 freeze before week 5 kicks off**, with the origin-9-only contingency declared now (§7.5).

## 3. Engine v2 (`site/assets/rostersim.js`)

### 3.1 Dependence model: Gaussian copula with a per-player season factor

In each simulated season, player *i* draws one factor Z_i ~ N(0, 1). Each week's quantile level becomes

  u_iw = Φ( √ρ_pos(i) · Z_i + √(1 − ρ_pos(i)) · ε_iw ),  ε_iw ~ N(0, 1) iid,

and u_iw goes through the **existing** `drawPoints` quantile map unchanged (two-piece normal through p10/p50/p90,
floor min(0, 2·p10), its atom included). The latent variable is standard normal each week, so each weekly marginal is
exactly v1's; only cross-week dependence changes. One primary model, one ρ table (§5), used at both origins. ρ = 0
reproduces v1's marginals and independence (under the new stream layout, §3.2).

### 3.2 Random streams and pairing

Three separately keyed streams per player id, all derived from (world seed, player id): **availability** (the
absence chain), **factor** (one Z per simulation), **noise** (ε per week). Adding the factor must not shift
availability draws. Pairing is preserved across before/after worlds, replacement candidates and waiver alternatives
(common random numbers, as in v1). Bitwise equality with v1 is **not** expected (the stream layout changes); the ρ = 0
arm under the new layout is the v1-equivalent comparator.

### 3.3 Replacement players keep their identity

Today `trade_backtest.cjs::buildSimWorld` passes only replacement quantiles and `rostersim.js` draws them under
synthetic ids `~R:<pos>:<rank>:<week>`, so the same real free agent in successive weeks has no persistent identity.
v2 carries replacement candidates' **real player ids**: a replacement's points use that player's factor and noise
streams, the same player can be chosen in several weeks (sharing his Z), and the same player can never fill two slots
in one week. Candidates remain always available (the v1 approximation of replacement availability); this is frozen
and disclosed — identity repairs serial dependence, not replacement availability.

### 3.4 API

`createWorld(cfg)` gains `cfg.copula = { rho: { QB, RB, WR, TE } }` (each in [0, 0.5]; missing → `RosterSimError`),
and replacement entries carry `id`. Validation otherwise as v1. `world.value`, `compare`, `drawPoints`,
`normalizeTag` keep their contracts. The page (trade and waiver) and the backtest call the same engine; the parity
fixture is extended.

### 3.5 Required engine tests

Weekly marginal unchanged for ρ ∈ {0, 0.2, 0.5} (KS / quantile checks per week); season-total variance rises by
≈ 1 + (n−1)ρ for a lone always-starting player with equal weekly variance; identical rosters give Δ ≡ 0; reordering
players or replacement lists changes nothing; availability realizations identical for ρ = 0 vs ρ > 0; a replacement
player chosen in two weeks shares Z; never two slots in one week; ρ = 0 vs ρ > 0 compared on aligned streams.
No fixture asserts "every interval widens".

## 4. Format contract (the B/C slice A needs)

### 4.1 Primary formats (frozen)

Synthetic league configs in the existing `configs/leagues/*.yaml` schema, placed in `configs/formats/`:

| Key label | Teams | Starters | Rounds | Scoring |
| --- | ---: | --- | ---: | --- |
| `f12-1qb-ppr` | 12 | QB, RB×2, WR×2, TE, FLEX×2 (RB/WR/TE) | 15 | reception 1.0, pass TD 4 |
| `f12-1qb-half` | 12 | same | 15 | reception 0.5, pass TD 4 |
| `f10-1qb-ppr` | 10 | same | 15 | reception 1.0, pass TD 4 |
| `f12-sf-ppr` | 12 | same + SUPER_FLEX (QB/RB/WR/TE) | 15 | reception 1.0, pass TD 4 |

Every other modeled offensive weight equals `configs/leagues/gabagool.yaml`'s `sleeper_scoring` (pass_yd 0.04,
pass_int −2, rush_yd 0.1, rush_td 6, rec_yd 0.1, rec_td 6, fum_lost −2, 2-pt conversions 2, 50+ yard TD bonuses
2); only `rec` and `pass_td` differ as tabled. The owner leagues' exact formats (six-point passing TDs) run as **exploratory** arms: they
cannot pass, so a conditional pass in the four primary formats does not by itself cover the owner leagues' exact
format (§8).

### 4.2 Format key

`format_key` = SHA-256 of a canonical JSON of: team count; the starter-slot multiset with each slot's eligible
positions; total roster size; and the normalized numeric weights of every scoring component the model predicts.
Python (`src/ffmodel/formats.py`) and JS (`site/assets/formats.js`) implement it; a parity fixture pins both on the
four formats and the two owner leagues. A live Sleeper league's key is computed from `total_rosters`,
`roster_positions` and `scoring_settings`. Gates match on exact key only — no nearest-format or owner-slug fallback.

### 4.3 Scoring scope

`export_origin_forecasts.py` exports predicted stat components only (pick-six cost weighted zero; K/DEF not
modeled), and realized outcomes use the same modeled scope. A format is supported only for its modeled components;
a live league whose non-modeled offensive weights (e.g. TE premium, distance bonuses, pick-six) differ from its
format's does not match. The audit of which Sleeper keys are modeled is part of §4.2's fixture.

## 5. Estimating ρ (development data; fitted before the origin-5 freeze)

Development data: the 2023–2025 origin-5 and origin-9 walk-forward forecasts, re-exported in the `f12-1qb-ppr`
lens. These seasons were used to diagnose v1; using their residuals to *fit* v2 is development, not validation, and
no v2 trade/waiver score is computed on them.

1. **Rows.** Player-weeks with an actual stat row (participation) and a forecast `play` row. Byes and absences are
   the availability process's, not point errors, and are excluded.
2. **PIT under the implemented distribution.** u = F(actual) using exactly `drawPoints`' two-piece normal with the
   floor atom at min(0, 2·p10); inside the atom (and any CDF jump) use a randomized PIT with a fixed seed. Actuals
   below the floor are **support violations**: counted and published, excluded from the fit, with a sensitivity
   refit that sets them to the atom's lower edge. z = Φ⁻¹(clip(u, 10⁻⁴, 1 − 10⁻⁴)).
3. **Location.** Subtract the position × origin mean of z before estimating dependence, so a shared bias is not read
   as a player effect. Report PIT location, spread and lag-1/lag-4 within-trajectory correlation by position and
   origin.
4. **Estimator.** Fitting unit: a player-season-origin trajectory with ≥ 4 valid weeks. Per position, a
   method-of-moments random-intercept correlation: the mean over trajectories of each trajectory's mean off-diagonal
   z_w·z_w' product, trajectories equally weighted. Shrink each position toward the pooled estimate:
   ρ_pos = w·ρ̂_pos + (1 − w)·ρ̂_pool with w = n_pos / (n_pos + 200), n_pos = trajectories. Clamp to [0, 0.5]; a
   negative estimate becomes 0 and is reported as a diagnostic. Uncertainty: 2,000 bootstrap resamples of players
   (all their trajectories together). No origin interaction.
5. **Other lenses.** Fit once on `f12-1qb-ppr`; report each other primary lens's own estimates as diagnostics; the
   single table is used for all formats. The same player outcomes under several scorings are not extra samples.
6. **Output.** `models/prospective/2026/rho.json` (table, counts of players / trajectories / week pairs, support
   violations, bootstrap intervals, diagnostics), frozen in the origin-5 manifest. Sanity check reported: the
   implied season-variance multiplier 1 + (n−1)ρ against the diagnosed 1.7–3.0×.

## 6. The prospective test (predeclared)

### 6.1 Decision population (materialized at each origin, before outcomes)

Per primary format: **20 simulated drafts** from the 2026 preseason board (prediction side of `draft_world.py`
only — no `actual_weeks`), draft generator and noise as v1 (`tools/draft_sim.cjs`, field "measured"), seeds
`1000·2026 + k`. Rosters are the drafted rosters (no in-season moves), as in v1. At each origin (5 and 9): **125
realistic trades per draft** (v1 §10.2 starter filter, package mix, seeds `mulberry32(hashStr("2026:O:k"))`), the
waiver add set (quota QB 2 / RB 3 / WR 3 / TE 2, v1 §10.1) and pools (v1 §10.7 injured-free-agent exclusion from the
week O−1 tags), the lopsided cutoff (90th percentile of the current-method max-side |Δ| over that origin's frozen
trade set — computed from predictions, not outcomes). All of it is written to the freeze and hashed (§7).

### 6.2 Arms

v2 (ρ table), **ρ = 0** (v1-equivalent under the new streams; diagnostic comparator), current (today's p50 lineup
method with replacement-level fill, as v1), naive (as v1). 2,000 sims for v2 and ρ = 0.

### 6.3 Trade verdict per primary format (M = 4)

Metrics as v1 (side-Δ MAE, decision regret, sign accuracy, 80% coverage), plus mean interval width, lower/upper tail
miss rates and the 80% interval score `U − L + 10·(L − y)·1[y < L] + 10·(y − U)·1[y > U]`. Differences are
v2 − comparator (positive = worse). Uncertainty: paired resampling of **whole draft seeds** (all origins, both
sides and every decision of a draft move together), the same resample indices across formats, B = 20,000. These
bounds describe the draft generator conditional on the one realized 2026 season.

`conditional_pass` requires **all** of:

1. Every declared cell present and evaluated; ≥ 200 trade sides per required origin × stratum. Otherwise
   `inconclusive` (gate closed; operational failures published).
2. Observed 80% coverage in **[0.70, 0.90]** at each origin, pooled, and in every origin × stratum cell.
3. Pooled interval score of v2 below the ρ = 0 arm's.
4. **Noninferiority to current:** one-sided upper bounds at level 1 − 0.05/(4M) = 1 − 0.003125 of pooled
   (v2 − current) MAE **< +1.0** point and (v2 − current) regret **< +1.0** point (a declared engineering tolerance
   per trade side over the rest of the season, not a statistically derived margin).
5. **Superiority to naive:** the same bounds of (v2 − naive) MAE and regret **< 0**.
6. Per origin: observed (v2 − current) MAE and regret ≤ +1.0; observed (v2 − naive) MAE and regret ≤ 0.
7. Per-stratum harm check: no stratum's (v2 − current) MAE interval entirely above +1.0.

A completed evaluation violating any of 2–7 is `conditional_fail`. Superiority over current is reported, not
required. Formats are not pooled as replications.

Note (declared): astra's round-1 rule "observed differences ≤ 0 at each origin" is aligned here to the +1.0
tolerance for the current comparator (item 6) and the per-stratum check (item 7), so the per-origin and pooled
rules do not contradict; the naive comparator keeps ≤ 0.

### 6.4 Waiver verdict per primary format (separate)

Drop-policy mean regret: v2 must beat current — one-sided upper bound of (v2 − current) regret **< 0** at level
1 − 0.05/(2M) — and beat naive the same way; no missing cells; each origin reported. Expected values are unchanged by
v2, so no waiver rescue is predicted. A trade pass never opens waiver advice, nor the reverse.

### 6.5 Reporting (not verdict inputs)

Width, tail misses, interval score by origin and stratum; superiority over current; teammate/stack subsets; the
concentration sensitivity (drop the 10 highest-exposure players / teams, both origins together); support violations;
the exploratory owner-format arms; and, as context only, v1's per-season coverage from its frozen outputs
(Gabagool 2023 0.716, 2024 0.595, 2025 0.640; FAM 0.733, 0.626, 0.637 — a misspecified model's spread, not a
measurement of v2's season-shock false-failure rate). One season is disclosed as one season: every synthetic league
shares the same realized 2026 outcomes.

## 7. Freeze and timing evidence

### 7.1 What is frozen at origin 5 (before the first week-5 kickoff)

A manifest `models/prospective/2026/o5/manifest.json` with SHA-256 of every item:

- **Code and model:** repo commit SHA, Node/Python versions and lockfile hashes, model checkpoint and calibration
  hashes, v2 engine, `rho.json`, simulation counts and seeds, percentile convention.
- **Origin inputs:** forecast files per primary and exploratory lens (weeks 5–17, every player-week row), the
  week-4 injury tags and their source/cutoff, availability rates (`site/data/availability.json` bytes), player id /
  position / team maps, schedule and byes.
- **Formats:** the four `configs/formats/*.yaml`, their format keys, the exploratory owner configs.
- **Draft universe:** the 2026 preseason board / world prediction side (no outcomes) and market snapshot.
- **Decisions:** materialized rosters, trades, waiver add sets and pools, lopsided cutoffs (§6.1).
- **Evaluation:** the evaluator code, strata, rules of §6, multiplicity, gate mapping, failure behavior, and the
  origin-9 refresh procedure (§7.4).
- **Execution:** the expected cell manifest (format × draft × origin), deterministic cell keys, output schema,
  duplicate/missing-cell rejection, aggregation recipe.

### 7.2 Remote witness

A GitHub Actions workflow (`.github/workflows/prospective-freeze.yml`, `workflow_dispatch`) builds every artifact,
writes the manifest, fails if the current time is past the cutoff, prints the manifest digest in the run log,
commits the freeze under `models/prospective/2026/o5/` and pushes a tag `prospective-2026-o5`. The Actions run
record (server timestamps, logged digest) and the tag push are the timing evidence; commit timestamps alone are not.
Artifacts are committed (permanent), never overwritten; corrections are new versions with a reason.

### 7.3 Deadline

Hard cutoff = the earliest week-5 kickoff, read from the nflverse schedule by the workflow (expected
2026-10-09T00:15Z). Operational target: freeze published by 2026-10-07T23:59Z, after week-4 stats land (~Oct 6). A
dry run of the full workflow on week-3 data (origin 4, labeled dry run, not part of the test) must succeed by
2026-10-04.

### 7.4 Origin 9

Declared now: the same workflow at origin 9 refreshes permitted **inputs** only — forecasts with data through week 8,
week-8 tags, trades/waiver sets materialized from the same drafted rosters — with the same engine, ρ table, formats,
seeds and rules. No re-estimation of ρ, no engine change, no model selection from weeks 5–8. Cutoff: the earliest
week-9 kickoff.

### 7.5 Contingency

If the origin-5 freeze misses the cutoff, that is published; nothing is backfilled. The test then runs at origin 9
only, labeled **exploratory**, and cannot yield `conditional_pass`.

### 7.6 Outcomes

After week 17: an outcome artifact (weekly actuals in the modeled scope for weeks 5–17) is built from stats as of
**2027-01-12**, hashed and committed separately from the prediction side; later stat corrections are ignored. The
frozen evaluator runs at the frozen SHA (B's sharded runner if ready, otherwise locally).

## 8. Gates and the site

New `site/data/sim_gates.json` (schema_version 3): one record per (format_key, feature ∈ {trade_grade, waiver_sim}),
each with `status` ∈ {`closed`, `inconclusive`, `conditional_fail`, `conditional_pass`, `pass`}, engine version,
evidence (`"2026 prospective, synthetic leagues"`), tested origins and horizon rule (nearest origin, ties → shorter,
disclosed as v1 §10.3). The page shows the experimental display only for `conditional_pass` on an exact key match,
labeled as in §2.1; `pass` is reserved for a future cross-season rule. v1's `trade_sim_eval.json` stays closed. Until
C, the owner leagues are the only leagues the site serves, and their exact format is exploratory — so they see no
display unless C's work maps them to a supported format by exact key.

## 9. Order of work

1. Format contract slice (§4): configs, key (Py + JS + parity), scoring audit, one tiny outcome-free end-to-end
   fixture through gate lookup.
2. Engine v2 (§3) with its tests and page parity.
3. ρ fit (§5): development exports in `f12-1qb-ppr`, fit, `rho.json`.
4. Materializer + evaluator skeleton (§6.1–6.4) with fixtures on synthetic outcomes.
5. Freeze workflow (§7), dry run by 2026-10-04, origin-5 freeze by 2026-10-07.
6. After the freeze: B (sharded runner, broad grid as exploratory), then C (open league picker, boards per format);
   `sim_gates.json` consumers on the pages.
