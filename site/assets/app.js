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
    const sortBy = th => {
      const key = th.dataset.key;
      const ariaSort = th.getAttribute("aria-sort");
      // Columns marked data-asc (lower-is-better: ECR, ADP, positional rank)
      // start ascending on their first click; everything else starts
      // descending, as before. Once a direction is set, clicks just toggle it.
      const ascFirst = th.hasAttribute("data-asc");
      const desc = ariaSort === "descending" ? false
        : ariaSort === "ascending" ? true
        : !ascFirst;
      table.querySelectorAll("thead th").forEach(o => o.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", desc ? "descending" : "ascending");
      const get = o => key.split(".").reduce((x, k) => (x ?? {})[k], o);
      // Missing means "no data", not "worst possible" or "best possible" --
      // nulls/undefined always sink to the bottom, in BOTH sort directions.
      rows.sort((a, b) => {
        const av = get(a), bv = get(b);
        const an = av === null || av === undefined;
        const bn = bv === null || bv === undefined;
        if (an && bn) return 0;
        if (an) return 1;
        if (bn) return -1;
        return (av < bv ? -1 : av > bv ? 1 : 0) * (desc ? -1 : 1);
      });
      table.dataset.sortKey = key;
      table.dataset.sortDesc = String(desc);
      render(rows);
    };
    table.querySelectorAll("thead th[data-key]").forEach(th => {
      th.setAttribute("tabindex", "0");
      th.addEventListener("click", () => sortBy(th));
      th.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          sortBy(th);
        } else if (e.key === " ") {
          e.preventDefault();               // don't let the page scroll
          sortBy(th);
        }
      });
    });
  }

  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ESC_MAP[c]);
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

  return { POS_CLASS, loadJSON, stampHeader, staleBanner, fmt, bandBar, makeSortable, posFilter, esc };
})();
