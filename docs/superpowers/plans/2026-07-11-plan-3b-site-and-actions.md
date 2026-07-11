# Plan 3b: Static Site + GitHub Actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The public face: a three-page static site (draft board, weekly projections, about-the-model) on GitHub Pages, plus the GitHub Actions that keep it honest and current — CI, the weekly fail-safe regeneration cron, and Pages deploy. Ends with the REAL 2026 draft board committed to `site/data/`.

**Architecture:** `site/` is plain HTML/CSS/JS reading committed JSON from `site/data/` (no backend, no framework, no build step). The weekly workflow reruns `ffmodel.site.generate`; any failure exits nonzero, nothing is committed, the site keeps serving last week's stamped data (spec §9). Payload upgrades land first (Task 1) so pages consume their final schema.

**Design system (binding for Tasks 2-4):** Dark war-room board `#1B2127`; warm chalk text `#E9E4D8`; muted chalk `#9AA3AB` for secondary text; the ONLY hues are the four position colors — QB `#D64545`, RB `#3FA46A`, WR `#4A90D9`, TE `#E8A33D` (semantic, never decorative; used as row edge chips and band fills, never as small-text color). Type via Google Fonts: Barlow Condensed (600/700, display + eyebrows, ALL-CAPS with letter-spacing), Source Sans 3 (400/600, body), IBM Plex Mono (500, all stat values, `font-variant-numeric: tabular-nums`). Signature element: the **range band** — a chalk track with a position-tinted fill spanning p10→p90 and a chalk tick at p50 — used identically on draft and weekly rows; on load it animates scaleX from the p50 tick outward (220ms, `prefers-reduced-motion: reduce` disables). Draft tiers render as shelf gaps: a horizontal chalk rule + condensed "TIER n" label between groups (the gap IS the VORP cliff). Single committed dark look (deliberate; no light theme in v1). Site name: **Floor & Ceiling** (rename is a one-string change).

**Spec:** design spec §8 (site), §9 (automation). Verified 2026-07-11: nflreadpy 2026 schedules exist (272 REG games); 2026 player stats 404 preseason — Task 1 handles this split.

## Global Constraints

- Fail-safe (spec §9): the weekly Actions run must never publish partial/empty/stale-mislabeled data. Generate exits nonzero → workflow stops → no commit → no deploy. Every page shows `data_through` and flags staleness (generated_at older than 8 days).
- No backend, no framework, no build step; external requests limited to Google Fonts. Free tiers only.
- Position colors are semantic and appear only for QB/RB/WR/TE; body text is always chalk on board (AA contrast); stat values always IBM Plex Mono tabular.
- Payload schema changes in Task 1 are the final contract; pages must not require fields that don't exist (null bands hide the band track, never render "NaN").
- Preseason pulls: weekly stats through `season - 1`; schedules through `season`; in-season weekly runs require target-season stats and fail loud if absent.
- Keyboard focus visible; tables sortable without JS errors on missing fields; pages responsive to 360px.
- Zero-warning pytest suite; all Python changes test-covered.

---

### Task 1: Generator upgrades (preseason pull split, --week auto, schema additions)

**Files:**
- Modify: `src/ffmodel/site/generate.py`, `src/ffmodel/site/draft.py`, `src/ffmodel/site/weekly.py` (tiny), `src/ffmodel/site/about.py` (tiny)
- Test: `tests/test_generate.py`, `tests/test_site_draft.py`, `tests/test_site_about.py`

**Interfaces (final payload contract for Tasks 2-4):**
- draft.json players gain: `"games": int`, `"bye": int|null` (week 1-18 with no scheduled game for the player's team, from the target season's schedule), and `season_points` now carries all three rulesets: `{"ppr": {...}, "half_ppr": {...}, "standard": {...}}` (same p50/p10/p90 shape).
- about.json gains top-level `"site_model": str` — the model name that produced the current weekly/draft payloads (passed through generate).
- CLI: `--week auto` resolves to the smallest scheduled-but-unplayed week of the target season (RuntimeError naming season if none remain); at least one of `--week`/`--draft` is required (parser error otherwise).
- Pull split: weekly = `pull_weekly(range(first_season, season))`, then IF `args.week` is not None, additionally `pull_weekly([season])` and concat (a ConnectionError here is fatal — in-season weekly needs current stats); schedules = `pull_schedules(range(first_season, season + 1))`. Draft-only preseason runs therefore never request the gameless season's stats.
- Fit boundary: `predictor.fit(features[features["season"] < args.season])` — the production convention (artifact/model trained through the prior season), which also fixes the transformer's through-year selection for in-season runs.
- Efficiency: `build_draft_board` gains `prefit: bool = False` — when True, `season_projection` skips its internal fit (generate.py passes prefit=True after its own fit), removing the double XGBoost fit.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_generate.py`:

```python
def test_parser_requires_week_or_draft():
    from ffmodel.site.generate import parse_and_validate

    with pytest.raises(SystemExit):
        parse_and_validate(["--out", "x", "--model", "xgboost",
                            "--season", "2026"])


def test_week_auto_resolves_first_unplayed():
    from ffmodel.site.generate import resolve_week

    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in (1, 2) for i in range(3)])
    sched = make_schedules(4)
    assert resolve_week("auto", weekly, sched, season=2023) == 3
    assert resolve_week(4, weekly, sched, season=2023) == 4


def test_week_auto_errors_when_season_complete():
    from ffmodel.site.generate import resolve_week

    weekly = make_weekly([{"week": w, "player_id": f"p{i}"}
                          for w in (1, 2, 3, 4) for i in range(3)])
    sched = make_schedules(4)
    with pytest.raises(RuntimeError, match="2023"):
        resolve_week("auto", weekly, sched, season=2023)
```

Append to `tests/test_site_draft.py`:

```python
def test_board_carries_games_bye_and_all_rulesets():
    weekly = _history()
    board = build_draft_board(weekly, _sched_with_future(), _QuantileStub(),
                              2023, "2023-10-15", weeks=range(7, 9))
    top = board["players"][0]
    assert top["games"] == 2
    assert top["bye"] is None            # toy schedule has no bye in weeks 7-8
    assert set(top["season_points"]) == {"ppr", "half_ppr", "standard"}
    assert top["season_points"]["standard"]["p50"] <= top["season_points"]["ppr"]["p50"]


def test_prefit_skips_internal_fit():
    weekly = _history()

    class CountingStub(_QuantileStub):
        fits = 0

        def fit(self, train):
            type(self).fits += 1

    stub = CountingStub()
    stub.fit(None)                       # simulate generate.py's own fit
    build_draft_board(weekly, _sched_with_future(), stub, 2023,
                      "2023-10-15", weeks=range(7, 9), prefit=True)
    assert CountingStub.fits == 1
```

Append to `tests/test_site_about.py`:

```python
def test_about_carries_site_model(tmp_path):
    report = _report(tmp_path, "baselines.json", "2026-07-10T05:00:00+00:00")
    about = build_about([report], data_through="2025-wk18", site_model="xgboost")
    assert about["site_model"] == "xgboost"
```

(update the existing two `build_about` calls in that file to pass `site_model="test"`)

- [ ] **Step 2: RED** — run the three test files; new tests fail (missing helpers/params).

- [ ] **Step 3: Implement**

`about.py`: `build_about(backtest_paths, data_through, site_model)` — add the parameter and `"site_model": site_model` to the payload.

`weekly.py`: no schema change (already has model/has_bands); no code change unless imports need it.

`draft.py` — three changes:

(a) `season_projection(..., prefit: bool = False)`; wrap the fit: `if not prefit: predictor.fit(_fit_frame(weekly, schedules))`. `build_draft_board(..., prefit: bool = False)` forwards it.

(b) All-ruleset season sums. In the week loop, score each quantile frame under all three rulesets (import `HALF_PPR`, `STANDARD`; reuse `RULESETS` from `ffmodel.site.weekly`):

```python
        if hasattr(predictor, "predict_quantiles"):
            qs = predictor.predict_quantiles(future)
            week_pts = {rn: {q: fantasy_points(qs[q], rules) for q in ("p10", "p50", "p90")}
                        for rn, rules in RULESETS.items()}
        else:
            pred = predictor.predict(future)
            week_pts = {rn: {"p50": fantasy_points(pred, rules), "p10": None, "p90": None}
                        for rn, rules in RULESETS.items()}
```

Accumulate per ruleset: entry keys become `f"{rn}_{q}"` (e.g. `ppr_p50`, `half_ppr_p10`, ...); keep `games`. VORP/tiers/position_rank still computed on `ppr_p50` (rename the sort/replacement lookups accordingly — the display default stays PPR). `_finalize_board` emits:

```python
            "season_points": {rn: {"p50": round(float(row[f"{rn}_p50"]), 1),
                                   "p10": _band(row[f"{rn}_p10"]),
                                   "p90": _band(row[f"{rn}_p90"])}
                              for rn in ("ppr", "half_ppr", "standard")},
            "games": int(row["games"]),
            "bye": row["bye"],
```

(c) Bye weeks. In `build_draft_board`, before finalizing:

```python
    season_sched = schedules[schedules["season"] == season]
    weeks_list = list(weeks)
    team_weeks = pd.concat([
        season_sched.rename(columns={"home_team": "team"})[["team", "week"]],
        season_sched.rename(columns={"away_team": "team"})[["team", "week"]],
    ])
    def _bye(team: str):
        played = set(team_weeks[team_weeks["team"] == team]["week"])
        missing = [w for w in weeks_list if w not in played]
        return int(missing[0]) if len(missing) == 1 else None
    players["bye"] = players["team"].map(_bye)
```

Also update `season_projection`'s empty-frame `columns` list to the new column names + `bye` is added later (keep schema-stable: include all `{rn}_{q}` columns and `games`).

`generate.py` — four changes:

(a) parser: `--week` becomes `type=str, default=None` (accepts "auto" or a number). Add a wrapper both `main()` and tests use:

```python
def parse_and_validate(argv=None) -> argparse.Namespace:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.week is None and not args.draft:
        parser.error("provide --week and/or --draft")
    return args
```

`main()` starts with `args = parse_and_validate()`.

**Existing-test updates required by these changes (do them in the same commit):**
- `tests/test_generate.py::test_parser_defaults_and_flags`: `--week 7` now parses as the string `"7"` — assert `args.week == "7"` and add `resolve_week("7", ...)`-style coverage is already provided by the new tests.
- `tests/test_site_draft.py::test_season_projection_sums_weeks`: `season_p50`/`season_p10` become `ppr_p50`/`ppr_p10`.
- `tests/test_site_draft.py::test_vorp_and_ordering`: the hand-built players frame's columns rename to `ppr_p50/ppr_p10/ppr_p90` plus `half_ppr_*`, `standard_*` (copy the ppr values), `games`, and a `bye` column of None — matching `_finalize_board`'s new expectations.

(b) `resolve_week(week, weekly, schedules, season) -> int`:

```python
def resolve_week(week, weekly: pd.DataFrame, schedules: pd.DataFrame, season: int) -> int:
    if week != "auto":
        return int(week)
    played = set(weekly[weekly["season"] == season]["week"])
    scheduled = sorted(set(schedules[schedules["season"] == season]["week"]))
    remaining = [w for w in scheduled if w not in played]
    if not remaining:
        raise RuntimeError(f"season {season} has no unplayed scheduled weeks left")
    return int(remaining[0])
```

(c) pull split in `main()`:

```python
    weekly = pull_weekly(list(range(args.first_season, args.season)),
                         cache_dir=args.data_dir)
    if args.week is not None:
        # in-season weekly needs the target season's played games; preseason
        # draft-only runs never request the (gameless, 404ing) target season
        current = pull_weekly([args.season], cache_dir=args.data_dir)
        weekly = pd.concat([weekly, current], ignore_index=True)
    schedules = pull_schedules(list(range(args.first_season, args.season + 1)),
                               cache_dir=args.data_dir)
```

then `week = resolve_week(args.week, weekly, schedules, args.season)` (use `week` everywhere below), `predictor.fit(features[features["season"] < args.season])`, `build_draft_board(..., prefit=True)`, and `build_about(backtests, data_through, site_model=predictor.name)`.

- [ ] **Step 4: GREEN** — the three test files pass; full suite green, zero warnings.

- [ ] **Step 5: Commit**

```bash
git add src/ffmodel/site tests/test_generate.py tests/test_site_draft.py tests/test_site_about.py
git commit -m "feat: preseason pull split, week auto, draft schema upgrades, single fit"
```

---

### Task 2: Site shell — shared assets + about page

**Files:**
- Create: `site/assets/style.css`, `site/assets/app.js`, `site/about.html`
- Test: none (static); acceptance = local render + screenshot in Step 4.

**Interfaces:** `app.js` exposes (as plain globals under `window.FC`): `loadJSON(path)` (fetch + throw on !ok), `staleBanner(generatedAt)` (injects the banner if older than 8 days), `bandBar(p10, p50, p90, max, posClass)` (returns the signature band element; null p10/p90 → returns a lone p50 tick), `fmt(x, digits)` (Plex-mono-safe number or "—"), `sortTable(...)` helper, `POS_CLASS = {QB: "pos-qb", ...}`. Tasks 3-4 consume these exactly.

- [ ] **Step 1: Write `site/assets/style.css`**

```css
/* Floor & Ceiling — war-room board. Single committed dark look. */
:root {
  --board: #1B2127;
  --board-raised: #232A31;
  --chalk: #E9E4D8;
  --chalk-dim: #9AA3AB;
  --rule: #39424B;
  --qb: #D64545; --rb: #3FA46A; --wr: #4A90D9; --te: #E8A33D;
  --band-track: #2E363E;
}

* { box-sizing: border-box; }
html { color-scheme: dark; }
body {
  margin: 0; background: var(--board); color: var(--chalk);
  font: 400 16px/1.55 "Source Sans 3", system-ui, sans-serif;
}
a { color: var(--chalk); }
:focus-visible { outline: 2px solid var(--te); outline-offset: 2px; }

/* -- header ------------------------------------------------------------ */
.masthead {
  display: flex; align-items: baseline; gap: 1.25rem; flex-wrap: wrap;
  padding: 1.1rem 1.25rem .9rem; border-bottom: 1px solid var(--rule);
}
.wordmark {
  font: 700 1.6rem/1 "Barlow Condensed", sans-serif;
  letter-spacing: .04em; text-transform: uppercase; margin: 0;
}
.wordmark .amp { color: var(--chalk-dim); }
.masthead nav { display: flex; gap: 1rem; margin-left: auto; }
.masthead nav a {
  font: 600 .95rem/1 "Barlow Condensed", sans-serif; letter-spacing: .09em;
  text-transform: uppercase; text-decoration: none; color: var(--chalk-dim);
  padding: .3rem 0; border-bottom: 2px solid transparent;
}
.masthead nav a[aria-current="page"] { color: var(--chalk); border-bottom-color: var(--chalk); }
.stamp {
  width: 100%; font: 500 .78rem/1.2 "IBM Plex Mono", monospace;
  color: var(--chalk-dim); letter-spacing: .02em;
}
.stale {
  background: var(--te); color: #1B2127; padding: .55rem 1.25rem;
  font: 600 .9rem/1.3 "Source Sans 3", sans-serif;
}

main { max-width: 1080px; margin: 0 auto; padding: 1.25rem; }
.eyebrow {
  font: 600 .8rem/1 "Barlow Condensed", sans-serif; letter-spacing: .14em;
  text-transform: uppercase; color: var(--chalk-dim); margin: 0 0 .35rem;
}
h1, h2 { font-family: "Barlow Condensed", sans-serif; letter-spacing: .02em; }
h1 { font-size: 2rem; font-weight: 700; margin: 0 0 1rem; }
h2 { font-size: 1.3rem; font-weight: 600; margin: 2rem 0 .6rem; }

/* -- position chips ------------------------------------------------------ */
.pos-chip {
  display: inline-block; min-width: 2.4em; text-align: center;
  font: 600 .78rem/1.5 "Barlow Condensed", sans-serif; letter-spacing: .06em;
  border-radius: 3px; color: #10151A;
}
.pos-qb { background: var(--qb); } .pos-rb { background: var(--rb); }
.pos-wr { background: var(--wr); } .pos-te { background: var(--te); }

/* -- tables -------------------------------------------------------------- */
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: .45rem .6rem; text-align: left; white-space: nowrap; }
thead th {
  font: 600 .78rem/1.2 "Barlow Condensed", sans-serif; letter-spacing: .1em;
  text-transform: uppercase; color: var(--chalk-dim);
  border-bottom: 1px solid var(--rule); cursor: pointer; user-select: none;
}
thead th[aria-sort="descending"]::after { content: " ▾"; }
thead th[aria-sort="ascending"]::after { content: " ▴"; }
tbody tr { border-bottom: 1px solid color-mix(in srgb, var(--rule) 45%, transparent); }
tbody tr:hover { background: var(--board-raised); }
td.num, th.num { text-align: right; font: 500 .92rem/1.4 "IBM Plex Mono", monospace;
  font-variant-numeric: tabular-nums; }

/* -- signature: the range band ------------------------------------------- */
.band { position: relative; width: 170px; height: 10px; }
.band .track { position: absolute; inset: 3px 0; background: var(--band-track);
  border-radius: 2px; }
.band .fill { position: absolute; inset: 3px auto; height: 4px; top: 3px;
  border-radius: 2px; opacity: .85; transform-origin: var(--p50x) center;
  animation: unfold .22s ease-out both; }
.band .tick { position: absolute; top: 0; width: 2px; height: 10px;
  background: var(--chalk); }
@keyframes unfold { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@media (prefers-reduced-motion: reduce) { .band .fill { animation: none; } }

/* -- draft board tier shelves --------------------------------------------- */
.tier-break { border: 0; border-top: 1px solid var(--rule); position: relative;
  margin: 1.4rem 0 1.1rem; overflow: visible; }
.tier-break::after {
  content: attr(data-label); position: absolute; top: -0.72em; left: 0;
  background: var(--board); padding-right: .6rem;
  font: 600 .8rem/1.4 "Barlow Condensed", sans-serif; letter-spacing: .14em;
  text-transform: uppercase; color: var(--chalk-dim);
}

/* -- filter chips ---------------------------------------------------------- */
.filters { display: flex; gap: .5rem; flex-wrap: wrap; margin: 0 0 1rem; }
.filters button {
  background: none; border: 1px solid var(--rule); color: var(--chalk-dim);
  font: 600 .85rem/1 "Barlow Condensed", sans-serif; letter-spacing: .08em;
  text-transform: uppercase; padding: .45rem .8rem; border-radius: 4px; cursor: pointer;
}
.filters button[aria-pressed="true"] { color: var(--chalk); border-color: var(--chalk); }

/* -- about page ------------------------------------------------------------ */
.prose { max-width: 68ch; }
.prose p { color: var(--chalk); }
.prose .lim { color: var(--chalk-dim); }
.report-meta { font: 500 .8rem/1.4 "IBM Plex Mono", monospace; color: var(--chalk-dim); }

footer { max-width: 1080px; margin: 2rem auto 0; padding: 1rem 1.25rem 2rem;
  border-top: 1px solid var(--rule); color: var(--chalk-dim); font-size: .85rem; }

@media (max-width: 560px) {
  .band { width: 110px; }
  main { padding: .9rem; }
}
```

- [ ] **Step 2: Write `site/assets/app.js`**

```javascript
/* Floor & Ceiling — shared utilities. No framework, no build. */
window.FC = (() => {
  const POS_CLASS = { QB: "pos-qb", RB: "pos-rb", WR: "pos-wr", TE: "pos-te" };
  const POS_VAR = { QB: "--qb", RB: "--rb", WR: "--wr", TE: "--te" };

  async function loadJSON(path) {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  function stampHeader(payload) {
    const el = document.querySelector(".stamp");
    if (el) el.textContent =
      `data through ${payload.data_through} · generated ${payload.generated_at} · model: ${payload.model || payload.site_model || "—"}`;
    staleBanner(payload.generated_at);
  }

  function staleBanner(generatedAt) {
    const ageDays = (Date.now() - Date.parse(generatedAt)) / 86400000;
    if (!(ageDays > 8)) return;
    const div = document.createElement("div");
    div.className = "stale";
    div.textContent =
      `Heads up: this data was generated ${Math.floor(ageDays)} days ago and may be out of date.`;
    document.body.insertBefore(div, document.querySelector("main"));
  }

  function fmt(x, digits = 1) {
    return (x === null || x === undefined) ? "—" : x.toFixed(digits);
  }

  function bandBar(p10, p50, p90, max, pos) {
    const wrap = document.createElement("div");
    wrap.className = "band";
    wrap.title = p10 === null ? `p50 ${fmt(p50)}` :
      `floor ${fmt(p10)} · median ${fmt(p50)} · ceiling ${fmt(p90)}`;
    const pct = v => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
    wrap.innerHTML = `<div class="track"></div>`;
    if (p10 !== null && p90 !== null) {
      const fill = document.createElement("div");
      fill.className = "fill";
      fill.style.left = pct(p10);
      fill.style.width = `calc(${pct(p90)} - ${pct(p10)})`;
      fill.style.background = getComputedStyle(document.documentElement)
        .getPropertyValue(POS_VAR[pos] || "--chalk");
      fill.style.setProperty("--p50x", pct(p50));
      wrap.appendChild(fill);
    }
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = pct(p50);
    wrap.appendChild(tick);
    return wrap;
  }

  function makeSortable(table, rows, render) {
    // rows: array of data objects; render(rows) redraws tbody.
    table.querySelectorAll("thead th[data-key]").forEach(th => {
      th.addEventListener("click", () => {
        const key = th.dataset.key;
        const dir = th.getAttribute("aria-sort") === "descending" ? 1 : -1;
        table.querySelectorAll("thead th").forEach(o => o.removeAttribute("aria-sort"));
        th.setAttribute("aria-sort", dir === -1 ? "descending" : "ascending");
        rows.sort((a, b) => {
          const av = key.split(".").reduce((o, k) => (o ?? {})[k], a) ?? -Infinity;
          const bv = key.split(".").reduce((o, k) => (o ?? {})[k], b) ?? -Infinity;
          return (av < bv ? -1 : av > bv ? 1 : 0) * -dir;
        });
        render(rows);
      });
    });
  }

  function posFilter(container, onChange) {
    const positions = ["ALL", "QB", "RB", "WR", "TE"];
    positions.forEach(p => {
      const b = document.createElement("button");
      b.textContent = p;
      b.setAttribute("aria-pressed", p === "ALL" ? "true" : "false");
      b.addEventListener("click", () => {
        container.querySelectorAll("button").forEach(o => o.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        onChange(p);
      });
      container.appendChild(b);
    });
  }

  return { POS_CLASS, loadJSON, stampHeader, staleBanner, fmt, bandBar, makeSortable, posFilter };
})();
```

- [ ] **Step 3: Write `site/about.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>About the model — Floor &amp; Ceiling</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@500&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<header class="masthead">
  <h1 class="wordmark">Floor <span class="amp">&amp;</span> Ceiling</h1>
  <nav>
    <a href="index.html">Draft board</a>
    <a href="weekly.html">Weekly</a>
    <a href="about.html" aria-current="page">About the model</a>
  </nav>
  <p class="stamp">loading…</p>
</header>
<main>
  <p class="eyebrow">Methodology, honestly</p>
  <h1>How these projections are made</h1>
  <div class="prose">
    <p>Every number on this site comes from models that predict <strong>raw stat
    lines</strong> — yards, touchdowns, receptions — never fantasy points directly.
    Points are computed from those stat lines under your scoring rules, so PPR,
    half-PPR and standard all come from one prediction.</p>
    <p>The headline model is a small quantile transformer (PyTorch) that reads each
    player's recent game log and the matchup, and predicts a <strong>floor (p10),
    median (p50) and ceiling (p90)</strong> for every stat. The range bands you see
    on the draft board and weekly pages are those quantiles — uncertainty is the
    product, not an afterthought. Classical baselines (a naive last-four-games
    average and XGBoost) run through the exact same evaluation harness, and the
    tables below report whichever model wins, exactly as it lands.</p>
    <p>Evaluation is <strong>walk-forward only</strong>: train on seasons up to S,
    test on season S+1, held out across 2023–2025. No random splits — rolling
    features would leak the future into the past.</p>
    <p class="lim"><strong>Known limitations:</strong> rookies with no NFL games are
    not projected; players who changed teams keep their personal history with
    updated matchup context; retired players may appear until rosters are pruned;
    season range bands are sums of weekly quantiles, which overstates their width;
    snap counts are excluded (no 2012 source data). These are design choices,
    documented, not surprises.</p>
  </div>
  <h2>Backtest results</h2>
  <p class="prose lim">Walk-forward mean absolute error in PPR points per
  player-week, by position. Lower is better. Quantile columns appear for models
  that predict bands; coverage is the share of outcomes that landed inside the
  p10–p90 band (ideal: 0.80).</p>
  <div id="reports"></div>
</main>
<footer>Floor &amp; Ceiling projects NFL fantasy performance with honest
uncertainty. Built as an open portfolio project — data via nflverse.</footer>
<script src="assets/app.js"></script>
<script>
(async () => {
  const about = await FC.loadJSON("data/about.json");
  FC.stampHeader(about);
  const host = document.getElementById("reports");
  for (const report of about.reports) {
    const h = document.createElement("h2");
    h.textContent = report.source.replace(".json", "");
    const meta = document.createElement("p");
    meta.className = "report-meta";
    meta.textContent = `created ${report.created} · test seasons ${report.test_seasons.join(", ")} · scoring ${report.scoring}`;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const cols = ["model", "test_season", "position", "mae", "rmse", "n"];
    const qcols = ["pinball_p50", "coverage_p10_p90"];
    const hasQ = report.results.some(r => r.pinball_p50 != null);
    const all = hasQ ? cols.concat(qcols) : cols;
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr>${all.map(c => `<th>${c.replaceAll("_", " ")}</th>`).join("")}</tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const row of report.results.filter(r => r.position === "OVERALL")) {
      const tr = document.createElement("tr");
      tr.innerHTML = all.map(c => {
        const v = row[c];
        const num = typeof v === "number" && !Number.isInteger(v);
        return `<td class="${typeof v === "number" ? "num" : ""}">${v == null ? "—" : num ? v.toFixed(3) : v}</td>`;
      }).join("");
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.append(h, meta, wrap);
  }
})().catch(e => { document.querySelector(".stamp").textContent = `failed to load: ${e.message}`; });
</script>
</body>
</html>
```

- [ ] **Step 4: Acceptance — render locally and screenshot**

Generate stub data if `site/data/` doesn't exist yet: run the Task 1 CLI against real cached data (`--season 2026 --draft` works preseason after Task 1). Serve: `cd site && ../.venv/Scripts/python.exe -m http.server 8123` (background). Load `http://localhost:8123/about.html` with the chrome-devtools MCP tools (ToolSearch "chrome devtools navigate screenshot"), take a screenshot, and verify: masthead + nav render, stamp populated, backtest table rows visible, no console errors (`list_console_messages`). Note findings in the report; kill the server.

- [ ] **Step 5: Commit**

```bash
git add site/assets site/about.html
git commit -m "feat: site shell, design system, about page"
```

---

### Task 3: Draft board page (index.html)

**Files:**
- Create: `site/index.html`

**Consumes:** draft.json (Task 1 schema), FC utilities. The page's single job: help a person make the next pick fast.

- [ ] **Step 1: Write `site/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Draft board — Floor &amp; Ceiling</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@500&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<header class="masthead">
  <h1 class="wordmark">Floor <span class="amp">&amp;</span> Ceiling</h1>
  <nav>
    <a href="index.html" aria-current="page">Draft board</a>
    <a href="weekly.html">Weekly</a>
    <a href="about.html">About the model</a>
  </nav>
  <p class="stamp">loading…</p>
</header>
<main>
  <p class="eyebrow">2026 season · value over replacement</p>
  <h1>Draft board</h1>
  <div class="filters" id="pos-filters" role="group" aria-label="Filter by position"></div>
  <div class="filters" id="scoring-filters" role="group" aria-label="Scoring format"></div>
  <div class="table-wrap">
    <table id="board">
      <thead><tr>
        <th data-key="vorp" class="num" aria-sort="descending">VORP</th>
        <th>Pos</th>
        <th data-key="name">Player</th>
        <th>Team</th>
        <th data-key="bye" class="num">Bye</th>
        <th data-key="season_points.ppr.p50" class="num" id="pts-header">Season pts (p50)</th>
        <th>Floor → ceiling</th>
        <th data-key="position_rank" class="num">Pos rank</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>
</main>
<footer>Bands show season floor (p10) to ceiling (p90); the tick is the median.
Ordering is points above a replacement-level starter, so scarcity is priced in.
Tier gaps mark real value cliffs — when your tier empties, don't chase.</footer>
<script src="assets/app.js"></script>
<script>
(async () => {
  const board = await FC.loadJSON("data/draft.json");
  FC.stampHeader(board);
  let scoring = "ppr";
  let pos = "ALL";
  let rows = board.players.slice();

  const maxCeil = Math.max(...board.players.map(p =>
    p.season_points.ppr.p90 ?? p.season_points.ppr.p50));

  const tbody = document.querySelector("#board tbody");
  function render(data) {
    tbody.innerHTML = "";
    let lastTier = null;
    const filtered = data.filter(p => pos === "ALL" || p.position === pos);
    for (const p of filtered) {
      if (pos !== "ALL" && p.tier !== lastTier) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="8"><hr class="tier-break" data-label="Tier ${p.tier}"></td>`;
        tbody.appendChild(tr);
        lastTier = p.tier;
      }
      const s = p.season_points[scoring];
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="num">${FC.fmt(p.vorp)}</td>
        <td><span class="pos-chip ${FC.POS_CLASS[p.position]}">${p.position}</span></td>
        <td>${p.name}</td>
        <td>${p.team}</td>
        <td class="num">${p.bye ?? "—"}</td>
        <td class="num">${FC.fmt(s.p50)}</td>
        <td></td>
        <td class="num">${p.position_rank}</td>`;
      tr.children[6].appendChild(FC.bandBar(s.p10, s.p50, s.p90, maxCeil, p.position));
      tbody.appendChild(tr);
    }
  }

  FC.posFilter(document.getElementById("pos-filters"), p => { pos = p; render(rows); });
  const scWrap = document.getElementById("scoring-filters");
  ["ppr", "half_ppr", "standard"].forEach(rn => {
    const b = document.createElement("button");
    b.textContent = rn.replace("_", "-").toUpperCase();
    b.setAttribute("aria-pressed", rn === "ppr" ? "true" : "false");
    b.addEventListener("click", () => {
      scWrap.querySelectorAll("button").forEach(o => o.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      scoring = rn;
      document.getElementById("pts-header").textContent =
        `Season pts (p50, ${rn.replace("_", "-")})`;
      render(rows);
    });
    scWrap.appendChild(b);
  });
  FC.makeSortable(document.getElementById("board"), rows, render);
  render(rows);
})().catch(e => { document.querySelector(".stamp").textContent = `failed to load: ${e.message}`; });
</script>
</body>
</html>
```

- [ ] **Step 2: Acceptance — render + screenshot** (same http.server + chrome-devtools flow as Task 2 Step 4): verify ALL view sorted by VORP with band bars; click RB filter — tier shelf rules with "TIER n" labels appear at gaps; toggle STANDARD — p50 column drops for pass-catchers; sort by bye works; zero console errors. Screenshot both ALL and RB-tier views.

- [ ] **Step 3: Commit** — `git add site/index.html && git commit -m "feat: draft board page with tier shelves and range bands"`

---

### Task 4: Weekly projections page

**Files:**
- Create: `site/weekly.html`

**Implementer note:** this task composes from Task 3's complete `index.html` (same head, fonts, masthead with `aria-current` moved to Weekly, same script structure) plus the deltas below — dispatch it to a standard-tier implementer, and the reviewer must check every listed behavior, since this task is specified by delta rather than verbatim code.

- [ ] **Step 1: Write `site/weekly.html`**

Head/masthead identical to index.html except `<title>Weekly — Floor &amp; Ceiling</title>` and `aria-current="page"` on the Weekly nav link. Main:

```html
<main>
  <p class="eyebrow" id="week-eyebrow">weekly projections</p>
  <h1>This week's slate</h1>
  <div class="filters" id="pos-filters" role="group" aria-label="Filter by position"></div>
  <div class="filters" id="scoring-filters" role="group" aria-label="Scoring format"></div>
  <div class="table-wrap">
    <table id="slate">
      <thead><tr>
        <th data-key="points.ppr.p50" class="num" aria-sort="descending" id="pts-header">Proj (p50)</th>
        <th>Pos</th>
        <th data-key="name">Player</th>
        <th>Team</th>
        <th>Opp</th>
        <th>Floor → ceiling</th>
        <th data-key="points.ppr.p10" class="num">Floor</th>
        <th data-key="points.ppr.p90" class="num">Ceiling</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>
</main>
<footer>Floor and ceiling are the p10 and p90 of the model's stat-line quantiles,
scored under your format. Start the higher floor when you're protecting a lead;
chase the higher ceiling when you need to swing.</footer>
```

Script mirrors index.html: load `data/weekly.json`, `FC.stampHeader(payload)`, set eyebrow to `Week ${payload.week} · ${payload.season} · ${payload.model}`, scoring + position filters, rows sorted by current scoring's p50, opponent cell shows `${p.is_home ? "vs" : "@"} ${p.opponent}`, band via `FC.bandBar(pts.p10, pts.p50, pts.p90, maxCeil, p.position)` with maxCeil from the ppr p90s, floor/ceiling `.num` cells with `FC.fmt`, sort keys switched when scoring toggles (re-render suffices since data-keys reference ppr — acceptable v1: keep sort keys on the displayed columns by re-rendering; note in code comment). No tier shelves here (tiers are a draft concept).

If `data/weekly.json` is missing (preseason), the catch handler must show a friendly line in the stamp: `weekly projections start with week 1 — see the draft board`.

- [ ] **Step 2: Acceptance — render + screenshot.** Preseason there is no weekly.json: verify the friendly missing-state message renders (this IS the current real state). Then create a THROWAWAY weekly.json in site/data by running the Task 1 CLI with `--season 2025 --week auto` against a scratch out-dir and copying it in temporarily — verify table, filters, bands; screenshot; DELETE the throwaway file afterwards (git status clean).

- [ ] **Step 3: Commit** — `git add site/weekly.html && git commit -m "feat: weekly projections page"`

---

### Task 5: GitHub Actions — CI, weekly cron, Pages deploy

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/weekly-update.yml`, `.github/workflows/pages.yml`
- Modify: `README.md` (automation section)

- [ ] **Step 1: `ci.yml`**

```yaml
name: tests
on:
  push: { branches: [main] }
  pull_request:
jobs:
  pytest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -e ".[dev]"
      - run: pytest -W error
```

- [ ] **Step 2: `weekly-update.yml`**

```yaml
name: weekly site update
on:
  schedule:
    - cron: "23 5 * 9-12,1 3"   # Wed 05:23 UTC (Tue night ET), Sep-Jan
  workflow_dispatch:
    inputs:
      draft:
        description: "also regenerate the draft board (preseason)"
        type: boolean
        default: false
env:
  MODEL: xgboost               # flip to transformer + set ARTIFACT_ROOT after GPU training
  ARTIFACT_ROOT: ""
  SEASON: "2026"
jobs:
  regenerate:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -e .
      - name: Generate site JSON (fail-safe - any error stops the job, site keeps last data)
        run: |
          ARGS="--out site/data --model $MODEL --season $SEASON --week auto"
          if [ "${{ inputs.draft }}" = "true" ]; then ARGS="$ARGS --draft"; fi
          if [ -n "$ARTIFACT_ROOT" ]; then ARGS="$ARGS --artifact-root $ARTIFACT_ROOT"; fi
          python -m ffmodel.site.generate $ARGS
      - name: Commit refreshed data
        run: |
          git config user.name "weekly-update-bot"
          git config user.email "actions@users.noreply.github.com"
          git add site/data
          git diff --cached --quiet && echo "no changes" && exit 0
          git commit -m "data: weekly site refresh"
          git push
```

- [ ] **Step 3: `pages.yml`**

```yaml
name: deploy pages
on:
  push:
    branches: [main]
    paths: ["site/**"]
  workflow_dispatch:
permissions:
  pages: write
  id-token: write
jobs:
  deploy:
    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with: { path: site }
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 4: README automation section** — document: the three workflows; that weekly fail-safe = job fails → no commit → no deploy; how to flip MODEL/ARTIFACT_ROOT to the transformer; that Pages must be enabled once in repo Settings → Pages → Source: GitHub Actions; preseason draft refresh = manual workflow_dispatch with draft=true.

- [ ] **Step 5: Validate YAML parses** (`python -c "import yaml, glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]"`) — note: real Actions runs need the GitHub remote (user task); these files are inert until pushed.

- [ ] **Step 6: Commit** — `git add .github README.md && git commit -m "feat: CI, weekly fail-safe cron, Pages deploy workflows"`

---

### Task 6: The real 2026 draft board — generate, verify, commit

**Files:**
- Create: `site/data/draft.json`, `site/data/about.json` (generated, committed)
- Modify: `README.md` status checklist

- [ ] **Step 1:** `python -m ffmodel.site.generate --out site/data --model xgboost --season 2026 --draft` (real network pull for 2026 schedules; ~minutes for the XGB fit + 18-week roll). Expected: draft.json (several hundred players) + about.json; NO weekly.json (preseason).

- [ ] **Step 2: Plausibility gate:** top-15 by VORP must read like a credible 2026 preseason board (recent star RB/WR/QBs; no retirees in the top ranks — some further down are expected and documented). Byes populated (2026 schedule has byes weeks 5-14ish). If anything looks insane, STOP and report DONE_WITH_CONCERNS with the list.

- [ ] **Step 3:** Serve the site locally and screenshot the REAL draft board (ALL + one position tier view). Verify stamp shows `data through 2025-wk18` and model xgboost.

- [ ] **Step 4:** Update README status: Plan 3 site live locally; GPU training + remote/Pages setup = user tasks. Commit: `git add site/data README.md && git commit -m "data: first real 2026 draft board (xgboost)"`

---

## Done criteria for Plan 3b

- Full suite green (zero warnings) with the Task 1 payload upgrades test-pinned.
- All three pages render locally against real generated data with zero console errors; screenshots in task reports; keyboard focus + reduced-motion respected; mobile 360px usable.
- Workflows YAML-valid and documented; fail-safe semantics stated in README.
- `site/data/draft.json` = the real 2026 board, committed. The August-deadline path is proven end-to-end a month early.

**User tasks after merge (documented in README):** create the GitHub remote + push; enable Pages (Settings → Pages → GitHub Actions); Studio Lab GPU training; then flip MODEL/ARTIFACT_ROOT in weekly-update.yml to the transformer.
