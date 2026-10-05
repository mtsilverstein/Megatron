/* Public Sleeper discovery only. Never treat discovery as valuation support. */
(function () {
  "use strict";
  // Browser globals when present, node requires otherwise (waivermode.js pattern).
  const dep = (name, path) => typeof window !== "undefined" && window[name]
    ? window[name] : typeof require === "function" ? require(path) : null;
  const FC = dep("FC", "./app.js");
  const SharedSession = dep("Session", "./session.js");
  const IDLE = "Load leagues for this username.";
  const DRAFT_ONLY = "The draft board is only built for registered leagues.";
  // Every current-season league opens in the in-season pages BY ITS SLEEPER
  // ID (any-league spec 5.4); only a registered league also has a draft board,
  // linked by its registry slug.
  const BAD_LEAGUE = "Enter a Sleeper league id or a sleeper.com league link.";
  // Spec 5.1, anonymous path: bare digits, or a sleeper.com URL containing
  // /leagues/<digits> (any trailing path or query), gives the league id;
  // anything else is null. The host must be sleeper.com or a subdomain of it.
  function parseLeagueInput(text) {
    const t = String(text === null || text === undefined ? "" : text).trim();
    if (/^\d+$/.test(t)) return t;
    let url;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`); } catch (_) { return null; }
    const host = url.hostname.toLowerCase();
    if (host !== "sleeper.com" && !host.endsWith(".sleeper.com")) return null;
    const m = /^\/leagues\/(\d+)(?:\/|$)/.exec(url.pathname);
    return m ? m[1] : null;
  }
  const IN_SEASON_LINKS = [["weekly", "Weekly / start-sit"], ["waivers", "Waiver research"], ["trade", "In-season trade scenarios"]];

  // Configured-league detection reads FC.REGISTRY, the single source of league
  // capabilities (spec §3): a Sleeper entry whose live id equals the league's.
  function slugForLeague(leagueId) {
    const table = FC && Array.isArray(FC.REGISTRY) ? FC.REGISTRY : [];
    const entry = table.find(r => r && r.platform === "sleeper" && r.leagueId === leagueId);
    return entry ? entry.slug : null;
  }

  // Identity goes through the shared session (which persists it); the season
  // comes from live state because this page has no board, so no bundle.
  async function discover(username, get, session) {
    session = session || SharedSession;
    if (!session) throw Error("Shared session unavailable.");
    username = String(username || "").trim();
    if (!username) throw Error("Enter a Sleeper username, not a password.");
    const [identity, state] = await Promise.all([session.identify(username, {get}), get("/state/nfl")]);
    const season = String(state?.season || "");
    if (!/^20\d{2}$/.test(season)) throw Error("Sleeper's current NFL season is unavailable.");
    const leagues = await session.leaguesFor({season, get});
    if (!Array.isArray(leagues)) throw Error("Sleeper returned incomplete league data.");
    const seen = new Set();
    const rows = leagues.map(league => {
      const id = String(league?.league_id || "");
      if (!/^\d+$/.test(id) || String(league.season) !== season || seen.has(id))
        throw Error("Sleeper returned invalid, duplicate or wrong-season league data. Refresh to retry.");
      seen.add(id);
      return {league, slug: slugForLeague(id)};
    });
    return {identity, season, rows};
  }
  function init() {
    const $ = id => document.getElementById(id);
    const node = (tag, text) => { const el = document.createElement(tag); el.textContent = text; return el; };
    const Session = SharedSession;
    let generation = 0;
    let shownFor = null; // userId the rendered league list belongs to; null when nothing is shown
    const clearResults = () => { shownFor = null; $("connect-results").replaceChildren(); $("connect-status").textContent = IDLE; };
    const currentUserId = () => { const id = Session.identity(); return id ? id.userId : null; };
    // The field belongs to the visitor while it is DIRTY: its text differs from
    // what this page last put there (the submitted name, or the canonical name
    // the session handed back). A session change may rewrite a clean or empty
    // field; it must never overwrite a name being typed -- a submitted lookup
    // that lands after the visitor moved on would otherwise put the old
    // account's name back under their cursor. (The submitted lookup itself
    // still commits: pressing the button was the intent. Editing clears the
    // results list, not the submitted lookup.)
    let written = "";
    const writeUser = value => { $("connect-user").value = value; written = value; };
    const dirty = () => { const v = $("connect-user").value; return v !== "" && v !== written; };
    try { writeUser(Session.identity()?.username || ""); } catch (_) {}
    // The chip in #league-context writes the same identity. A change or forget
    // there clears this page's account-derived list before any lookup renders
    // (spec §8); an in-flight discovery for the old account is dropped when it
    // lands because its identity no longer matches the session's.
    Session.onChange(snapshot => {
      const id = snapshot.identity, uid = id ? id.userId : null;
      if (shownFor !== null && uid !== shownFor) clearResults();
      if (dirty()) return;
      if (id) writeUser(id.username);
      else if (snapshot.state === "anonymous") writeUser("");
    });
    $("connect-user").addEventListener("input", () => { generation++; clearResults(); });
    // Open any league read-only from a pasted link or id; no username needed.
    const leagueForm = $("connect-league-form");
    if (leagueForm) leagueForm.addEventListener("submit", event => {
      event.preventDefault();
      const id = parseLeagueInput($("connect-league").value);
      if (!id) { $("connect-league-status").textContent = BAD_LEAGUE; return; }
      $("connect-league-status").textContent = "";
      location.assign(`weekly.html?league=${id}`);
    });
    $("connect-form").addEventListener("submit", async event => {
      event.preventDefault();
      const request = ++generation, username = $("connect-user").value.trim();
      written = $("connect-user").value;   // submitted: the field is clean again
      shownFor = null; $("connect-results").replaceChildren(); $("connect-status").textContent = "Loading current-season Sleeper leagues…";
      try {
        const result = await discover(username, path => window.Sleeper.get(path), Session);
        if (request !== generation) return;
        if (currentUserId() !== result.identity.userId) { $("connect-status").textContent = IDLE; return; }
        $("connect-status").textContent = `${result.rows.length} leagues for ${result.identity.displayName || username} · ${result.season}. Read-only; no lineup changes or claims submitted.`;
        for (const {league, slug} of result.rows) {
          const section = node("section", "");
          section.append(node("h2", league.name || `League ${league.league_id}`));
          const type = league.settings?.waiver_type;
          const waivers = type === 2 ? "FAAB" : type === 0 ? "Rolling priority" : "Other / unknown waiver rules";
          section.append(node("p", `${league.total_rosters ?? "Unknown"} teams · ${league.status || "Unknown status"} · ${waivers}`));
          section.append(node("p", `Roster slots: ${Array.isArray(league.roster_positions) ? league.roster_positions.join(" / ") : "Unavailable"}`));
          const details = node("details", ""); details.append(node("summary", "Live scoring settings"));
          details.append(node("pre", JSON.stringify(league.scoring_settings || {}, null, 2))); section.append(details);
          const id = String(league.league_id);
          const links = [];
          if (slug) {
            section.append(node("p", "Registered league: draft board and in-season tools. Each in-season tool reads this league's live settings when it loads; discovery alone does not confirm data freshness."));
            links.push(["index", "Draft board", slug]);
          } else {
            section.append(node("p", "Each in-season tool reads this league's live settings when it loads; discovery alone does not confirm data freshness."));
            section.append(node("p", DRAFT_ONLY));
          }
          for (const [page, label] of IN_SEASON_LINKS) links.push([page, label, id]);
          for (const [page, label, value] of links) {
            const link = node("a", label); link.href = `${page}.html?league=${encodeURIComponent(value)}`;
            const p = node("p", ""); p.append(link); section.append(p);
          }
          $("connect-results").append(section);
        }
        shownFor = result.identity.userId;
      } catch (error) {
        if (request !== generation) return;
        // A superseded identify means the chip moved the account; its outcome
        // owns the form now, so the loading line simply steps back to idle.
        $("connect-status").textContent = error && error.superseded ? IDLE : `Unable to load leagues: ${error.message}`;
      }
    });
  }
  if (typeof module !== "undefined" && module.exports) module.exports = {discover, slugForLeague, parseLeagueInput};
  if (typeof window !== "undefined") window.LeagueConnect = {discover, slugForLeague, parseLeagueInput, init};
})();
