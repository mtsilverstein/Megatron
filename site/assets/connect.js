/* Public Sleeper discovery only. Never treat discovery as valuation support. */
(function () {
  "use strict";
  const configured = {"1376245373244301312": "gabagool", "1389736745205002240": "fam"};
  async function discover(username, get) {
    username = String(username || "").trim();
    if (!username) throw Error("Enter a Sleeper username, not a password.");
    const [user, state] = await Promise.all([get(`/user/${encodeURIComponent(username)}`), get("/state/nfl")]);
    if (!user?.user_id) throw Error("Sleeper username was not found.");
    const season = String(state?.season || "");
    if (!/^20\d{2}$/.test(season)) throw Error("Sleeper's current NFL season is unavailable.");
    const leagues = await get(`/user/${encodeURIComponent(user.user_id)}/leagues/nfl/${season}`);
    if (!Array.isArray(leagues)) throw Error("Sleeper returned incomplete league data.");
    const seen = new Set();
    const rows = leagues.map(league => {
      const id = String(league?.league_id || "");
      if (!/^\d+$/.test(id) || String(league.season) !== season || seen.has(id))
        throw Error("Sleeper returned invalid, duplicate or wrong-season league data. Refresh to retry.");
      seen.add(id);
      return {league, slug: configured[id] || null};
    });
    return {user, season, rows};
  }
  function init() {
    const $ = id => document.getElementById(id);
    const node = (tag, text) => { const el = document.createElement(tag); el.textContent = text; return el; };
    let generation = 0;
    try { $("connect-user").value = localStorage.getItem("megatron:sleeper-username") || ""; } catch (_) {}
    $("connect-user").addEventListener("input", () => {
      generation++; $("connect-results").replaceChildren(); $("connect-status").textContent = "Load leagues for this username.";
    });
    $("connect-form").addEventListener("submit", async event => {
      event.preventDefault();
      const request = ++generation, username = $("connect-user").value.trim();
      $("connect-results").replaceChildren(); $("connect-status").textContent = "Loading current-season Sleeper leagues…";
      try {
        const result = await discover(username, path => window.Sleeper.get(path));
        if (request !== generation) return;
        try { localStorage.setItem("megatron:sleeper-username", username); } catch (_) {}
        $("connect-status").textContent = `${result.rows.length} leagues for ${result.user.display_name || username} · ${result.season}. Read-only; no lineup changes or claims submitted.`;
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
            for (const [page, label] of [["weekly", "Weekly / start-sit"], ["waivers", "Waiver research"]]) {
              const link = node("a", label); link.href = `${page}.html?league=${slug}`;
              const p = node("p", ""); p.append(link); section.append(p);
            }
          } else {
            section.append(node("p", "Discovered, but advice is not supported yet. This league needs validated scoring, player identities and lineup rules. No other league's rankings or bids are substituted."));
          }
          $("connect-results").append(section);
        }
      } catch (error) {
        if (request === generation) $("connect-status").textContent = `Unable to load leagues: ${error.message}`;
      }
    });
  }
  if (typeof module !== "undefined" && module.exports) module.exports = {discover};
  if (typeof window !== "undefined") window.LeagueConnect = {discover, init};
})();
