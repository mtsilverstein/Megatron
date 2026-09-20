/* Megatron — shared utilities. No framework, no build. */
// UMD like the other shared modules: `window.FC` in the browser, `module.exports`
// under node so session.js (and fixtures) can read the registry without a
// `window` shim. DOM/location are only touched inside functions.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FC = api;
})(typeof window !== "undefined" ? window : null, () => {
  const POS_CLASS = { QB: "pos-qb", RB: "pos-rb", WR: "pos-wr", TE: "pos-te" };
  // The ONE supported-league table (design spec §3). Slugs, platform, live
  // league id, select label and which live tools each league connects to.
  // session.js, the nav-label rule and the league select all read from here;
  // an unknown slug never defaults (see leagueNavigation).
  const REGISTRY = Object.freeze([
    { slug: "gabagool", platform: "sleeper", leagueId: "1376245373244301312", label: "Gabagool · Sleeper",
      tools: { draft: true, keepers: true, trade: true, waivers: true, startsit: true } },
    { slug: "fam",      platform: "sleeper", leagueId: "1389736745205002240", label: "FAM · Sleeper",
      tools: { draft: true, keepers: false, trade: true, waivers: true, startsit: true } },
    { slug: "espnfam",  platform: "espn",    leagueId: "69827905",            label: "ESPN family · draft board only",
      tools: { draft: true, keepers: false, trade: false, waivers: false, startsit: false } },
  ].map(entry => Object.freeze({ ...entry, tools: Object.freeze(entry.tools) })));
  const LEAGUES = REGISTRY.map(r => [r.slug, r.label]);
  const LEAGUE_SLUGS = REGISTRY.map(r => r.slug);
  const registryFor = slug => REGISTRY.find(r => r.slug === slug) || null;
  // Which registry tool a nav destination needs. Pages absent here (index,
  // about, connect) are always connected.
  const TOOL_FOR_PAGE = { "trade.html": "trade", "weekly.html": "startsit", "waivers.html": "waivers" };

  async function loadJSON(path) {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  function leagueDataPath(kind) {
    const slug = new URLSearchParams(location.search).get("league") || "gabagool";
    if (!LEAGUE_SLUGS.includes(slug)) throw Error("Unknown league");
    if (!["draft", "weekly", "remaining"].includes(kind)) throw Error("Unknown league data kind");
    // remaining-<slug>.json is named per league for every league, including
    // Gabagool; the bare-name convention applies to draft/weekly only.
    if (kind === "remaining") return `data/remaining-${slug}.json`;
    return `data/${kind}${slug === "gabagool" ? "" : `-${slug}`}.json`;
  }

  // ---- identity chip (design spec §6) -------------------------------------
  // The chip lives INSIDE #league-context and is the one place a visitor
  // identifies. It reads Session (site/assets/session.js) lazily so this file
  // still loads under node and in a page that has not included session.js
  // (then the panel renders without a chip, as before). Rendering is gated on
  // Session.bundle()/myRosterStatus/error(), never on state() === "error"
  // alone: a stale identity error can coexist with a valid committed bundle.
  // Superseded rejections (err.superseded) are swallowed, never displayed.
  let sessionOverride = null;
  const session = () => {
    if (sessionOverride) return sessionOverride;
    if (typeof Session !== "undefined" && Session) return Session;
    if (typeof window !== "undefined" && window && window.Session) return window.Session;
    return null;
  };
  const swallow = () => {};   // identify/ready failures surface via Session.error(); superseded ones never
  const chip = {
    slug: null, board: null, readyFor: null, els: null, unsub: null, ticker: null,
    lastName: "", changing: false, notice: "", prefill: "", controlsSig: null,
  };
  function chipEntry() { return registryFor(chip.slug); }
  function isEspn() { const e = chipEntry(); return !!e && e.platform !== "sleeper"; }
  // ready() only when a Sleeper board is set, an identity exists and no
  // bundle has been committed for THIS board yet. ESPN never calls ready
  // (Session would answer with zero calls, but the chip's UI does not rely on
  // that). Pages that never set a board (about, connect) only identify.
  function maybeReady() {
    const S = session();
    if (!S || !chip.slug || !chip.board || isEspn()) return;
    if (!S.identity()) return;
    if (S.bundle() && chip.readyFor === chip.board) return;
    chip.readyFor = chip.board;
    Promise.resolve().then(() => S.ready({ slug: chip.slug, board: chip.board })).catch(swallow);
  }
  function setBoard(board) {
    chip.board = board || null;
    chip.readyFor = null;
    maybeReady();
  }
  function chipButton(id, text, onClick) {
    const b = document.createElement("button");
    b.type = "button"; b.id = id; b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }
  function chipIdentify(name) {
    const S = session();
    name = String(name || "").trim();
    if (!S || !name) return;
    chip.lastName = name; chip.changing = false; chip.notice = "";
    S.identify(name).then(() => maybeReady(), swallow);
  }
  // A failed refresh is not an error state (the committed bundle stays valid),
  // so its text is a notice beside the controls, cleared by the next action.
  function chipRefresh(opts) {
    const S = session();
    if (!S || !S.bundle() || isEspn()) return Promise.resolve(null);
    chip.notice = "";
    const p = S.refresh(Object.assign({ scope: "rosters" }, opts || {}));
    p.then(() => { chip.notice = ""; renderChip(); },
           e => { if (S.isSuperseded && S.isSuperseded(e)) return; chip.notice = `Refresh failed: ${(e && e.message) || e}`; renderChip(); });
    return p.catch(() => null);
  }
  // The page owns its refresh path. The chip's refresh button is the only
  // refresh control on waivers/weekly (spec §5), but the chip cannot know
  // what a page needs re-fetched atomically with the rosters -- the waiver
  // desk must re-read the week's transactions in the SAME generation, so a
  // transactions failure commits nothing and the age does not advance
  // (Session.refresh's `also` hook). A page registers ONE provider,
  // `FC.chip.onRefresh(() => ({ scope, also }))`, called at click time; its
  // return value is the options object handed to Session.refresh. Without a
  // provider the button refreshes rosters + state, as before. The returned
  // function unregisters the provider.
  let refreshProvider = null;
  function onRefresh(fn) {
    refreshProvider = typeof fn === "function" ? fn : null;
    return () => { if (refreshProvider === fn) refreshProvider = null; };
  }
  function chipRefreshClick() {
    let opts;
    try { opts = refreshProvider ? refreshProvider() : undefined; }
    catch (e) { chip.notice = `Refresh failed: ${(e && e.message) || e}`; renderChip(); return Promise.resolve(null); }
    return chipRefresh(opts);
  }
  // No identity + error = the identify failed (identify clears the account
  // first); identity + error = the league load failed.
  function chipRetry() {
    const S = session();
    if (!S) return;
    if (!S.identity()) { chipIdentify(chip.lastName); return; }
    if (chip.board && !isEspn()) { chip.readyFor = null; maybeReady(); }
  }
  function identifyForm(prefill) {
    const form = document.createElement("form");
    form.className = "session-form";
    const label = document.createElement("label");
    label.textContent = "Sleeper username ";
    const input = document.createElement("input");
    input.type = "text"; input.id = "session-user"; input.autocomplete = "off";   // not a login field
    input.setAttribute("spellcheck", "false"); input.placeholder = "Sleeper username";
    input.value = prefill || "";
    label.append(input);
    const use = document.createElement("button");
    use.type = "submit"; use.id = "session-use"; use.textContent = "Use this account";
    form.append(label, use);
    form.addEventListener("submit", e => { if (e && e.preventDefault) e.preventDefault(); chipIdentify(input.value); });
    chip.els.input = input;
    return form;
  }
  // Called on every Session.onChange fire, on every chip action AND by the
  // 1 s ticker. The line (Session.chipText, whose age moves) is rewritten on
  // every call; the controls are rebuilt only when the state they are built
  // from changes -- `controlsSig` names that state. A tick therefore never
  // replaces the username input the visitor is typing into after "change"
  // or "forget", and never steals keyboard focus from a chip button.
  function renderChip() {
    const S = session(), els = chip.els;
    if (!S || !els) return;
    const st = S.state(), err = S.error(), id = S.identity(), b = S.bundle(), entry = chipEntry();
    const now = Date.now();
    // The line is ALWAYS Session.chipText. Without a committed bundle the
    // identity still gets a bundle-shaped view so ESPN reads "name · label".
    const view = b || (id ? { identity: id, registry: entry } : null);
    const changeBtn = () => chipButton("session-change", "change", () => { chip.changing = true; renderChip(); });
    const forgetBtn = () => chipButton("session-forget", "forget", () => { chip.changing = false; chip.notice = ""; S.forget(); });
    let line, build, sig;
    if (st === "identifying") {
      line = S.chipText(null, "identifying", now);
      build = () => []; sig = ["identifying"];
    } else if (chip.changing || (!id && !err)) {
      // The username form: anonymous, or "change" clicked from any state
      // (including error, where the previous attempt prefills the box).
      line = err ? S.chipText(view, "error", now, err) : S.chipText(view, id ? st : "anonymous", now);
      const prefill = id ? id.username : (chip.changing && chip.lastName) || chip.prefill;
      const cancel = !!(id || err);
      build = () => {
        const c = [identifyForm(prefill)];
        // Anonymous: the line already reads "Remembered on this device until
        // you choose forget." (chipText), so no second copy is added here.
        if (cancel) c.push(chipButton("session-cancel", "cancel", () => { chip.changing = false; renderChip(); }));
        return c;
      };
      sig = ["form", prefill, cancel];
    } else if (err) {
      line = S.chipText(view, "error", now, err);
      build = () => [chipButton("session-retry", "retry", chipRetry), changeBtn()]; sig = ["error"];
    } else if (st === "loadingLeague") {
      line = S.chipText(view, "loadingLeague", now);
      build = () => [changeBtn()]; sig = ["loadingLeague"];
    } else if (isEspn()) {
      line = S.chipText(view, st, now);
      build = () => [changeBtn(), forgetBtn()]; sig = ["espn"];
    } else if (b && (b.myRosterStatus === "none" || b.myRosterStatus === "ambiguous")) {
      line = S.chipText(b, st, now);
      build = () => [changeBtn()]; sig = ["noroster"];
    } else if (b && b.myRoster) {
      line = S.chipText(b, st, now);
      const refreshing = st === "refreshing";
      build = () => {
        const refresh = chipButton("session-refresh", "refresh", () => { chipRefreshClick(); });
        if (refreshing) refresh.disabled = true;
        return [refresh, changeBtn(), forgetBtn()];
      };
      sig = ["ready", refreshing];
    } else {
      // Identified with no bundle on this page (no board set yet): the line is
      // the remembered sentence, so the account is named beside the controls.
      line = S.chipText(view, st, now);
      const whoText = id.displayName || id.username;
      build = () => {
        const who = document.createElement("span"); who.id = "session-who";
        who.textContent = whoText;
        return [who, changeBtn(), forgetBtn()];
      };
      sig = ["identified", whoText];
    }
    sig.push(chip.notice);
    els.line.textContent = line;
    const key = JSON.stringify(sig);
    if (key === chip.controlsSig) return;
    chip.controlsSig = key;
    els.input = null;
    const controls = build();
    if (chip.notice) {
      const n = document.createElement("span"); n.className = "session-notice"; n.textContent = chip.notice;
      controls.push(n);
    }
    els.controls.replaceChildren(...controls);
  }
  // The age in the line comes from bundle().rostersFetchedAt; re-render every
  // second while a bundle carries one (renderChip rewrites the line only --
  // the controls stay put unless their state changed). A re-mount clears the
  // old interval first; under node the timer is unref'd so it never holds the
  // process open.
  function startTicker() {
    if (chip.ticker) { clearInterval(chip.ticker); chip.ticker = null; }
    if (typeof setInterval !== "function") return;
    chip.ticker = setInterval(() => {
      const S = session(); const b = S && S.bundle();
      if (b && Number.isFinite(b.rostersFetchedAt)) renderChip();
    }, 1000);
    if (chip.ticker && typeof chip.ticker.unref === "function") chip.ticker.unref();
  }
  function mountChip(panel, slug) {
    const S = session();
    if (!S) return;
    chip.slug = slug; chip.changing = false; chip.notice = ""; chip.lastName = "";
    if (chip.unsub) { try { chip.unsub(); } catch (_) {} chip.unsub = null; }
    const wrap = document.createElement("div"); wrap.id = "session-chip"; wrap.className = "session-chip";
    const line = document.createElement("span"); line.id = "session-text"; line.className = "session-text";
    const controls = document.createElement("div"); controls.className = "session-controls";
    wrap.append(line, controls);
    panel.append(wrap);
    chip.els = { wrap, line, controls, input: null };
    chip.controlsSig = null;             // fresh controls node: nothing is built yet
    // Legacy key (spec §7): migrated once into a prefill, never auto-identified.
    // Session.identity() loads storage (and migrates) first; either source wins.
    let prefill = "";
    try {
      const had = S.identity();
      let pending = typeof S.pendingUsername === "function" ? S.pendingUsername() : null;
      if (!pending && typeof S.migrateLegacy === "function" && typeof localStorage !== "undefined") pending = S.migrateLegacy(localStorage);
      if (!had && pending) prefill = pending;
    } catch (_) {}
    chip.prefill = prefill;
    chip.unsub = S.onChange(() => renderChip());
    renderChip();
    startTicker();
    maybeReady();
  }

  function mountLeagueContext(slug) {
    if (!document.createElement || document.getElementById("league-context")) return;
    const panel=document.createElement("section"), label=document.createElement("label"), select=document.createElement("select");
    panel.id="league-context"; panel.className="league-links";
    label.textContent="League "; select.setAttribute("aria-label","Selected league");
    for(const [value,name] of LEAGUES) {
      const option=document.createElement("option"); option.value=value; option.textContent=name; select.append(option);
    }
    select.value=slug;
    select.addEventListener("change",()=>{const url=new URL(location.href);url.searchParams.set("league",select.value);location.assign(url.href);});
    label.append(select);panel.append(label);
    mountChip(panel, slug);
    const note=document.createElement("p");
    note.textContent=slug==="espnfam"?"ESPN: draft board supported; live in-season tools are not connected yet.":"Draft board, weekly/start-sit, waiver research and in-season trade scenarios use this league. Pre-draft trade values remain Gabagool only. No password needed.";
    panel.append(note);
    // The connect page already IS "Find my Sleeper leagues" -- a link back to
    // itself from its own league panel would be a dead, redundant nav entry.
    if (!/\/connect\.html$/.test(location.pathname)) {
      const connect=document.createElement("a");
      const connectUrl=new URL("connect.html", location.href);
      connectUrl.searchParams.set("league", slug);
      connect.href=connectUrl.href; connect.textContent="Find my Sleeper leagues";
      panel.append(connect);
    }
    document.querySelector("main")?.prepend(panel);
  }

  // An invalid URL must never be treated as a request for the default league:
  // callers still get an error below and therefore cannot load league advice.
  // This panel only gives the visitor an explicit, safe way back to a supported
  // league while retaining the page (and any non-league query parameters).
  function mountInvalidLeagueRecovery(slug) {
    if (!document.createElement || document.getElementById("league-recovery")) return;
    const panel = document.createElement("section");
    const heading = document.createElement("h2");
    const note = document.createElement("p");
    const list = document.createElement("ul");
    panel.id = "league-recovery";
    panel.className = "league-links";
    heading.textContent = "Choose a supported league";
    note.textContent = `"${slug}" is not a supported league. No league data was loaded.`;
    panel.append(heading, note);
    for (const [value, name] of LEAGUES) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      const url = new URL(location.href);
      url.searchParams.set("league", value);
      link.href = url.href;
      link.textContent = name;
      item.append(link);
      list.append(item);
    }
    panel.append(list);
    const main = document.querySelector("main");
    if (main?.prepend) main.prepend(panel);
    else document.body?.append(panel);
  }

  function leagueNavigation() {
    // Keep the choice in each tab's URL, including the trip back from another
    // page. A shared stored preference would let one league change the other.
    const slug = new URLSearchParams(location.search).get("league") || "gabagool";
    if (!LEAGUE_SLUGS.includes(slug)) {
      mountInvalidLeagueRecovery(slug);
      throw new Error(`Unknown league "${slug}". Choose gabagool, fam or espnfam.`);
    }
    // Suffixes are stripped before recompute so a second call against the
    // SAME <a> elements (repeated init) stays deterministic instead of
    // stacking " · not connected · not connected". " · Gabagool only" is the
    // retired trade label, still stripped so stale markup cannot keep it.
    const SUFFIXES = [" · Gabagool only", " · not connected"];
    const entry = registryFor(slug);
    document.querySelectorAll(".masthead nav a").forEach(link => {
      const url = new URL(link.getAttribute("href"), location.href);
      // The URL keeps THIS tab's league -- clicking trade or an ESPN
      // weekly/waivers link must never silently switch you to another
      // league just because that's the only one the destination supports.
      url.searchParams.set("league", slug);
      link.href = url.href;
      let label = link.textContent;
      for (const suf of SUFFIXES) if (label.endsWith(suf)) label = label.slice(0, -suf.length);
      // Trade, weekly and waivers are live Sleeper tools; the registry says
      // which league connects which (today: Gabagool and FAM both, ESPN
      // none). The href above still points at THIS league, so the label says
      // the tool is not connected rather than implying a click will switch
      // leagues.
      const tool = TOOL_FOR_PAGE[url.pathname.split("/").pop()];
      if (tool && !entry.tools[tool]) label += " · not connected";
      link.textContent = label;
    });
    mountLeagueContext(slug);
    return slug;
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

  return { POS_CLASS, REGISTRY, registryFor, loadJSON, leagueDataPath, leagueNavigation, stampHeader, staleBanner,
           fmt, makeSortable, posFilter, esc, scoringFilter, LENS_LABEL,
           setBoard, mountLeagueContext,
           chip: { refresh: chipRefresh, onRefresh, render: renderChip },
           _session: stub => { sessionOverride = stub || null; } };
});
