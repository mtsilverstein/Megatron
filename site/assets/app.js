/* Floor & Ceiling — shared utilities. No framework, no build. */
window.FC = (() => {
  const POS_CLASS = { QB: "pos-qb", RB: "pos-rb", WR: "pos-wr", TE: "pos-te" };

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

  function makeSortable(table, rows, render) {
    // rows: array of data objects; render(rows) redraws tbody.
    // `keep` re-applies the CURRENT direction instead of toggling it -- used
    // when the scoring lens changes under a column that is already sorted.
    const sortBy = (th, keep) => {
      const key = th.dataset.key;
      const ariaSort = th.getAttribute("aria-sort");
      // Columns marked data-asc (lower-is-better: ECR, ADP, positional rank)
      // start ascending on their first click; everything else starts
      // descending, as before. Once a direction is set, clicks just toggle it.
      const ascFirst = th.hasAttribute("data-asc");
      const desc = keep ? ariaSort !== "ascending"
        : ariaSort === "descending" ? false
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
    // Re-apply the active sort in place. Called when the scoring lens changes
    // under an already-sorted column.
    table._resort = () => {
      const th = table.querySelector("thead th[aria-sort]");
      if (th) sortBy(th, true);
    };
    // Honour a sort DECLARED in the markup. A <th aria-sort="descending"> is a
    // promise about the order; without applying it the rows keep whatever order
    // the payload happened to arrive in, which is a different ruleset's. The
    // weekly payload arrives PPR-sorted, so the page opened showing league
    // points in PPR order -- the same wrong-order bug as the lens toggle, just
    // at load rather than on click.
    table._resort();
  }

  /* Scoring-lens toggle, shared by the draft board and the weekly page.

     The lenses genuinely DISAGREE: this project's league scores passing TDs at
     six rather than four, which moves a quarterback's season by ~48 points. A
     table that displays one lens while sorting by another therefore shows a
     visibly wrong order, not a rounding difference -- so every lens-dependent
     column carries `data-key-lens` (e.g. "points.{lens}.p50") and is retargeted
     here, then the active sort is re-applied.

     Buttons are built from the lenses the PAYLOAD actually carries, so a file
     generated before a lens existed renders without a dead button. */
  const LENS_LABEL = { league: "MY LEAGUE", ppr: "PPR", half_ppr: "HALF-PPR",
                       standard: "STANDARD" };

  function scoringFilter(wrap, present, onChange) {
    const lenses = Object.keys(LENS_LABEL).filter(l => present.includes(l));
    const initial = lenses[0];
    const table = document.querySelector("table");
    const apply = lens => {
      document.querySelectorAll("thead th[data-key-lens]").forEach(th => {
        th.dataset.key = th.dataset.keyLens.replace("{lens}", lens);
      });
      onChange(lens);
      if (table && table._resort) table._resort();
    };
    lenses.forEach(lens => {
      const b = document.createElement("button");
      b.textContent = LENS_LABEL[lens];
      b.setAttribute("aria-pressed", lens === initial ? "true" : "false");
      b.addEventListener("click", () => {
        wrap.querySelectorAll("button").forEach(o => o.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        apply(lens);
      });
      wrap.appendChild(b);
    });
    // Point the columns at the default lens before the first render.
    document.querySelectorAll("thead th[data-key-lens]").forEach(th => {
      th.dataset.key = th.dataset.keyLens.replace("{lens}", initial);
    });
    return initial;
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

  return { POS_CLASS, loadJSON, stampHeader, staleBanner, fmt, makeSortable,
           posFilter, esc, scoringFilter, LENS_LABEL };
})();
