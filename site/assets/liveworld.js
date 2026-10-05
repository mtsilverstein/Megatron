/* Shared live-world resolver for the in-season pages (start/sit, waivers,
   in-season trade). Reads the committed Session bundle -- never fetches,
   never reads a clock -- and returns the live league, rosters and the roster
   under analysis: the owner's own roster, or the team a viewer chose
   (Session's analysisRoster / analysisRole).

   It checks only what every in-season page needs: a roster under analysis,
   a roster snapshot with both timestamps, a week 1..18, an in-season league
   and a supported league type (LeagueData.leagueType). There are NO registry,
   board, scoring, waiver-type or team-count checks here; a page that needs
   one adds it on top (the waiver desk's waiver-type check lives in
   WaiverMode.loadWorld).

   Timestamps keep the pages' conventions: `requestedAt` is the bundle's
   PRE-request number (the engines' kickoff gate), `fetchedAt` the POST-fetch
   ISO string (the 60 s UI expiry). */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LiveWorld = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";
  const NODE = typeof module !== "undefined" && !!module.exports;
  // Lazy: resolved at call time so script order does not matter.
  const LD = () => NODE ? require("./leaguedata.js") : root.LeagueData;
  const NO_ANALYSIS = "Enter your Sleeper username, or choose a team to view.";

  function resolve({ bundle, week } = {}) {
    if (!bundle || typeof bundle !== "object") throw new Error("No league session is loaded.");
    if (!Number.isInteger(week) || week < 1 || week > 18) throw new Error("Week must be an integer from 1 to 18.");
    const league = bundle.league;
    if (!league || typeof league !== "object") throw new Error("Sleeper returned incomplete league data.");
    if (league.status !== "in_season") throw new Error(`This league is ${league.status ?? "unknown"}, not in season.`);
    const type = LD().leagueType(league);
    if (!type.supported) throw new Error(type.message);
    const roster = bundle.analysisRoster, role = bundle.analysisRole;
    if (!roster || typeof roster !== "object" || (role !== "owner" && role !== "viewer")) throw new Error(NO_ANALYSIS);
    const rosters = bundle.rosters;
    if (!Array.isArray(rosters) || !rosters.some(r => r && r.roster_id === roster.roster_id))
      throw new Error("Sleeper returned incomplete roster data.");
    const requestedAt = bundle.rostersRequestedAt, fetchedAt = bundle.rostersFetchedAt;
    if (!Number.isFinite(requestedAt) || !Number.isFinite(fetchedAt)) throw new Error("Roster snapshot timestamps are missing.");
    return {
      league, rosters, rosterId: roster.roster_id, role, users: bundle.users, state: bundle.state,
      fetchedAt: new Date(fetchedAt).toISOString(), requestedAt, leagueFetchedAt: bundle.leagueFetchedAt,
    };
  }

  return { resolve, NO_ANALYSIS };
});
