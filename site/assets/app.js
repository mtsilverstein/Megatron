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
