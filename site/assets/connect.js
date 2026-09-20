/* Public Sleeper discovery only. Never treat discovery as valuation support. */
(function () {
  "use strict";
  // Browser globals when present, node requires otherwise (waivermode.js pattern).
  const dep = (name, path) => typeof window !== "undefined" && window[name]
    ? window[name] : typeof require === "function" ? require(path) : null;
  const FC = dep("FC", "./app.js");
  const SharedSession = dep("Session", "./session.js");
  const IDLE = "Load leagues for this username.";

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
    try { $("connect-user").value = Session.identity()?.username || ""; } catch (_) {}
    // The chip in #league-context writes the same identity. A change or forget
    // there clears this page's account-derived list before any lookup renders
    // (spec §8); an in-flight discovery for the old account is dropped when it
    // lands because its identity no longer matches the session's.
    Session.onChange(snapshot => {
      const id = snapshot.identity, uid = id ? id.userId : null;
      if (shownFor !== null && uid !== shownFor) clearResults();
      if (id) $("connect-user").value = id.username;
      else if (snapshot.state === "anonymous") $("connect-user").value = "";
    });
    $("connect-user").addEventListener("input", () => { generation++; clearResults(); });
    $("connect-form").addEventListener("submit", async event => {
      event.preventDefault();
      const request = ++generation, username = $("connect-user").value.trim();
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
          if (slug) {
            section.append(node("p", "Configured league. Each tool rechecks live settings against its projections before giving advice; discovery alone does not confirm data freshness or compatibility."));
            for (const [page, label] of [["index", "Draft board"], ["weekly", "Weekly / start-sit"], ["waivers", "Waiver research"]]) {
              const link = node("a", label); link.href = `${page}.html?league=${slug}`;
              const p = node("p", ""); p.append(link); section.append(p);
            }
          } else {
            section.append(node("p", "Discovered, but advice is not supported yet. This league needs validated scoring, player identities and lineup rules. No other league's rankings or bids are substituted."));
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
  if (typeof module !== "undefined" && module.exports) module.exports = {discover, slugForLeague};
  if (typeof window !== "undefined") window.LeagueConnect = {discover, slugForLeague, init};
})();
