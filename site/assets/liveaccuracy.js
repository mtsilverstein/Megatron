// site/assets/liveaccuracy.js
/* Live accuracy this season: site/data/live-accuracy.json, the checked subset of
   the weekly-accuracy scorecard that src/ffmodel/site/live_accuracy_site.py copies
   during the site refresh. The text builders are pure (the node fixture requires
   them); render/load touch the DOM. A missing or unexpected file leaves the page's
   section hidden and the footer line empty: nothing is shown that the scorecard
   did not measure. The checks here mirror the Python ones.

   Scope, stated wherever a number appears: PPR scoring, players who recorded a
   stat line, the projections committed before each week's first game. Weeks the
   scorecard could not score are named, never silently left out. */
(function (root, factory) {
  const L = factory();
  if (typeof window !== "undefined") window.LiveAccuracy = L;
  if (typeof module !== "undefined" && module.exports) module.exports = L;
})(this, function () {
  "use strict";
  const SCORECARD_URL = "https://github.com/mtsilverstein/Megatron/blob/main/models/diagnostics/live_2026_weekly.md";
  // The scorecard proves the projections were committed to the repository before the cutoff (GitHub push records);
  // it does not verify the Vercel deployment, so the copy says "committed", not "shown on this site".
  const NOTE = "Scored in PPR from the projections committed to this site's repository before each week's first "
    + "game (proven by GitHub push records), for players who recorded a stat line. Players who did not play, and "
    + "players who played without recording a stat, are not scored; the band describes a player who plays. "
    + "Lower error is better; the naive "
    + "baseline is each player's average over their last four games (fewer if they have played fewer; a position "
    + "average for a debut). Provisional weeks can still move as stat corrections land. Recomputed every Tuesday "
    + "and Wednesday.";
  const RATES = ["coverage_p10_p90", "below_p10", "above_p90"];
  const fin = v => typeof v === "number" && Number.isFinite(v);
  const pct = v => `${(v * 100).toFixed(1)}%`;
  const f2 = v => v.toFixed(2);

  function valid(d) {
    if (!d || d.kind !== "live_accuracy" || d.schema_version !== 1 || d.scoring !== "ppr") return false;
    if (!Number.isInteger(d.season) || typeof d.as_of_date !== "string" || !d.as_of_date) return false;
    if (!Array.isArray(d.weeks) || !d.weeks.length || !Array.isArray(d.provisional_weeks) || !Array.isArray(d.weeks_skipped)) return false;
    const cell = c => !!c && Number.isInteger(c.n) && c.n > 0 && fin(c.mae) && c.mae >= 0 && fin(c.naive_mae) && c.naive_mae >= 0
      && RATES.every(k => fin(c[k]) && c[k] >= 0 && c[k] <= 1);
    if (!cell(d.overall) || !d.weeks.every(w => Number.isInteger(w.week) && typeof w.provisional === "boolean" && cell(w))) return false;
    const ws = d.weeks.map(w => w.week);
    if (ws.some((w, i) => i > 0 && w <= ws[i - 1])) return false;                       // sorted, unique
    if (d.overall.n !== d.weeks.reduce((s, w) => s + w.n, 0)) return false;              // the season row is these weeks
    if (!d.provisional_weeks.every(w => ws.includes(w)) || d.weeks.some(w => w.provisional !== d.provisional_weeks.includes(w.week))) return false;
    return d.weeks_skipped.every(s => s && Number.isInteger(s.week) && typeof s.reason === "string" && !ws.includes(s.week));
  }
  // "week 3", "weeks 1–7", or, when a week is missing, "weeks 1–4 and 6–8".
  function span(d) {
    const ws = d.weeks.map(w => w.week), runs = [];
    for (const w of ws) { const r = runs[runs.length - 1]; if (r && w === r[1] + 1) r[1] = w; else runs.push([w, w]); }
    const txt = runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`));
    const list = txt.length < 2 ? txt[0] : `${txt.slice(0, -1).join(", ")} and ${txt[txt.length - 1]}`;
    return `${ws.length === 1 ? "week" : "weeks"} ${list}`;
  }
  const provisional = d => d.provisional_weeks.length
    ? ` (week${d.provisional_weeks.length === 1 ? "" : "s"} ${d.provisional_weeks.join(", ")} provisional)` : "";
  const skippedText = d => d.weeks_skipped.length
    ? ` Not scored: ${d.weeks_skipped.map(s => `week ${s.week} (${s.reason.replace(/_/g, " ")})`).join(", ")}.` : "";

  // The section's lead sentence.
  function lead(d) {
    const o = d.overall;
    return `${d.season} season, ${span(d)}${provisional(d)}: mean absolute error ${f2(o.mae)} PPR points per `
      + `player-week for players who recorded a stat line, against ${f2(o.naive_mae)} for the naive `
      + `last-four-games average, over `
      + `${o.n.toLocaleString("en-US")} player-weeks. ${pct(o.coverage_p10_p90)} of outcomes landed inside the `
      + `floor–ceiling (p10–p90) band; the target is 80%.${skippedText(d)}`;
  }
  // The table: one row per scored week, then the season.
  const HEAD = ["Week", "Player-weeks", "Model error", "Naive error", "Inside band", "Below / above"];
  function rows(d) {
    const row = (label, c) => [label, c.n.toLocaleString("en-US"), f2(c.mae), f2(c.naive_mae), pct(c.coverage_p10_p90),
      `${pct(c.below_p10)} / ${pct(c.above_p90)}`];
    return [...d.weeks.map(w => row(w.provisional ? `${w.week} (provisional)` : String(w.week), w)), row("Season", d.overall)];
  }
  // One line for the weekly page's footer, with the same scope as the section.
  function footerLine(d) {
    const o = d.overall;
    return `Live ${d.season} accuracy (PPR, players who recorded a stat line, ${span(d)}): average error ${f2(o.mae)} `
      + `vs ${f2(o.naive_mae)} for the naive last-four-games average; ${pct(o.coverage_p10_p90)} of outcomes inside `
      + `the band.${skippedText(d)} Details on the about page.`;
  }

  function render(d, els) {
    if (!valid(d)) return false;
    const doc = els.section.ownerDocument || document;
    els.lead.textContent = lead(d);
    const table = doc.createElement("table"), caption = doc.createElement("caption");
    caption.textContent = `${d.season} weekly accuracy, PPR`;
    caption.className = "visually-hidden";
    const thead = doc.createElement("thead"), tbody = doc.createElement("tbody"), hr = doc.createElement("tr");
    HEAD.forEach((h, j) => {
      const th = doc.createElement("th"); th.textContent = h; th.setAttribute("scope", "col");
      if (j > 0) th.className = "num";
      hr.append(th);
    });
    thead.append(hr);
    const all = rows(d);
    all.forEach((cells, i) => {
      const tr = doc.createElement("tr");
      if (i === all.length - 1) tr.className = "overall";
      cells.forEach((text, j) => {
        const c = doc.createElement(j === 0 ? "th" : "td");
        c.textContent = text;
        if (j === 0) c.setAttribute("scope", "row"); else c.className = "num";
        tr.append(c);
      });
      tbody.append(tr);
    });
    table.append(caption, thead, tbody);
    els.table.replaceChildren(table);
    els.note.textContent = `${NOTE} Updated ${d.as_of_date}. `;
    const a = doc.createElement("a");
    a.href = SCORECARD_URL.replace("live_2026_weekly", `live_${d.season}_weekly`);
    a.textContent = "Full scorecard";
    els.note.append(a);
    els.section.hidden = false;
    return true;
  }
  async function fetchData(loadJSON) {
    try { return await loadJSON("data/live-accuracy.json"); } catch (_) { return null; }
  }
  // The about page's section; hidden unless the file is present and valid.
  async function load(els, loadJSON) { return render(await fetchData(loadJSON), els); }
  // The weekly footer's line; empty unless the file is present and valid.
  async function loadLine(el, loadJSON) {
    const d = await fetchData(loadJSON);
    if (!el || !valid(d)) return false;
    el.textContent = footerLine(d);
    return true;
  }
  return { valid, lead, rows, HEAD, footerLine, span, render, load, loadLine, NOTE };
});
