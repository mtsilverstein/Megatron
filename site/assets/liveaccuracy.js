// site/assets/liveaccuracy.js
/* Live accuracy this season: site/data/live-accuracy.json, the checked subset of
   the weekly-accuracy scorecard that src/ffmodel/site/live_accuracy_site.py copies
   during the site refresh. The text builders are pure (the node fixture requires
   them); render/load touch the DOM. A missing or unexpected file leaves the page's
   section hidden and the footer line empty: nothing is shown that the scorecard
   did not measure.

   Scope, stated wherever a number appears: PPR scoring, players who recorded a
   stat line, the projections published before each week's first game. */
(function (root, factory) {
  const L = factory();
  if (typeof window !== "undefined") window.LiveAccuracy = L;
  if (typeof module !== "undefined" && module.exports) module.exports = L;
})(this, function () {
  "use strict";
  const SCORECARD_URL = "https://github.com/mtsilverstein/Megatron/blob/main/models/diagnostics/live_2026_weekly.md";
  const NOTE = "Scored in PPR from the projections this site published before each week's first game "
    + "(proven by GitHub push records), for players who recorded a stat line. Lower error is better; the naive "
    + "baseline is each player's average over their last four games. Provisional weeks can still move as stat "
    + "corrections land. Recomputed every Tuesday and Wednesday.";
  const fin = v => typeof v === "number" && Number.isFinite(v);
  const pct = v => `${(v * 100).toFixed(1)}%`;
  const f2 = v => v.toFixed(2);

  function valid(d) {
    if (!d || d.kind !== "live_accuracy" || d.schema_version !== 1 || d.scoring !== "ppr") return false;
    if (!Number.isInteger(d.season) || !Array.isArray(d.weeks) || !d.weeks.length || !Array.isArray(d.provisional_weeks)) return false;
    const cell = c => !!c && Number.isInteger(c.n) && c.n > 0 && ["mae", "naive_mae", "coverage_p10_p90", "below_p10", "above_p90"].every(k => fin(c[k]));
    return cell(d.overall) && d.weeks.every(w => Number.isInteger(w.week) && cell(w));
  }
  const span = d => {
    const ws = d.weeks.map(w => w.week);
    return ws.length === 1 ? `week ${ws[0]}` : `weeks ${ws[0]}–${ws[ws.length - 1]}`;
  };
  const provisional = d => d.provisional_weeks.length
    ? ` (week${d.provisional_weeks.length === 1 ? "" : "s"} ${d.provisional_weeks.join(", ")} provisional)` : "";

  // The section's lead sentence.
  function lead(d) {
    const o = d.overall;
    return `${d.season} season, ${span(d)}${provisional(d)}: mean absolute error ${f2(o.mae)} PPR points per `
      + `player-week, against ${f2(o.naive_mae)} for the naive last-four-games average, over `
      + `${o.n.toLocaleString("en-US")} player-weeks. ${pct(o.coverage_p10_p90)} of outcomes landed inside the `
      + `floor–ceiling (p10–p90) band; the target is 80%.`;
  }
  // The table: one row per scored week, then the season.
  const HEAD = ["Week", "Player-weeks", "Model error", "Naive error", "Inside band", "Below / above"];
  function rows(d) {
    const row = (label, c) => [label, c.n.toLocaleString("en-US"), f2(c.mae), f2(c.naive_mae), pct(c.coverage_p10_p90),
      `${pct(c.below_p10)} / ${pct(c.above_p90)}`];
    return [...d.weeks.map(w => row(w.provisional ? `${w.week} (provisional)` : String(w.week), w)), row("Season", d.overall)];
  }
  // One line for the weekly page's footer.
  function footerLine(d) {
    const o = d.overall, last = d.weeks[d.weeks.length - 1].week;
    return `Live ${d.season} (PPR, through week ${last}): average error ${f2(o.mae)} vs ${f2(o.naive_mae)} for the `
      + `naive last-four-games average; ${pct(o.coverage_p10_p90)} of outcomes inside the band. Details on the about page.`;
  }

  function render(d, els) {
    if (!valid(d)) return false;
    const doc = els.section.ownerDocument || document;
    els.lead.textContent = lead(d);
    const table = doc.createElement("table"), thead = doc.createElement("thead"), tbody = doc.createElement("tbody");
    const hr = doc.createElement("tr");
    HEAD.forEach((h, j) => { const th = doc.createElement("th"); th.textContent = h; if (j > 0) th.className = "num"; hr.append(th); });
    thead.append(hr);
    const all = rows(d);
    all.forEach((cells, i) => {
      const tr = doc.createElement("tr");
      if (i === all.length - 1) tr.className = "overall";
      cells.forEach((text, j) => { const td = doc.createElement("td"); td.textContent = text; if (j > 0) td.className = "num"; tr.append(td); });
      tbody.append(tr);
    });
    table.append(thead, tbody);
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
  return { valid, lead, rows, HEAD, footerLine, render, load, loadLine, NOTE };
});
