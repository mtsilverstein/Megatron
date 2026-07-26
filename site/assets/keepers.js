// site/assets/keepers.js
/* Keeper-value gauge. Pure math + a manual panel; reads the board's ADP.
   Rules (spec 2026-07-25): keep up to 2, cost = one round earlier than last
   year's draft round, waiver pickups cost round 12, players drafted in rounds
   1-2 are ineligible. Surplus = keeper cost round - where he goes now. Keeping
   is optional, so only players with POSITIVE surplus are ever recommended --
   a zero/negative-surplus player is worth at least as much drafted fresh. */
(function (root, factory) {
  const K = factory();
  if (typeof window !== "undefined") window.Keepers = K;
  if (typeof module !== "undefined" && module.exports) module.exports = K;
})(this, function () {
  const WAIVER_COST_ROUND = 12;
  const MAX_KEEPERS = 2;
  const SLEEPER = "https://api.sleeper.app/v1";
  const CHAIN_CAP = 8;   // safety cap on previous_league_id hops
  let loadSeq = 0;       // generation token: a stale load can't overwrite a newer one

  async function sapi(path) {
    const res = await fetch(`${SLEEPER}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Walk previous_league_id backward from `startLeagueId`, recording each
  // player's EARLIEST draft (round, season) -> his original draft. Partial
  // failures skip that hop and keep walking.
  async function buildOriginalByPlayerId(startLeagueId) {
    const original = new Map();
    let lid = startLeagueId, hops = 0;
    while (lid && hops < CHAIN_CAP) {
      let league = null;
      try { league = await sapi(`/league/${lid}`); } catch (e) { break; }
      try {
        const drafts = (await sapi(`/league/${lid}/drafts`)) || [];
        const draft = drafts.find(d => d.status === "complete") || drafts[0];
        if (draft) {
          const season = parseInt(draft.season, 10);
          const picks = (await sapi(`/draft/${draft.draft_id}/picks`)) || [];
          for (const p of picks) {
            if (!p.player_id) continue;
            const prev = original.get(p.player_id);
            if (!prev || season < prev.season) original.set(p.player_id, { round: p.round, season });
          }
        }
      } catch (e) { /* skip this season's draft, keep walking */ }
      lid = league && league.previous_league_id;
      hops++;
    }
    return original;
  }

  // Cost escalates one round per year kept, anchored to the ORIGINAL draft
  // round, floored at R1. Waiver pickups (never drafted) are R12 flat.
  function keeperCost(c, currentSeason) {
    if (c.isWaiver) return WAIVER_COST_ROUND;
    return Math.max(1, c.originalRound - (currentSeason - c.originalYear));
  }
  function eligible(c) {
    return c.isWaiver || c.originalRound > 2;   // "no keepers from rounds 1-2"
  }
  function valueRound(adpRound, overallRank, teams = 12) {
    if (adpRound != null) return adpRound;
    return Math.ceil(overallRank / teams);
  }
  function surplus(c, currentSeason) {
    return keeperCost(c, currentSeason) - valueRound(c.adpRound, c.overallRank);
  }
  function rankKeepers(candidates, currentSeason) {
    return candidates
      .filter(eligible)
      .map(c => Object.assign({}, c, { surplus: surplus(c, currentSeason) }))
      .sort((a, b) => b.surplus - a.surplus);
  }
  // Which players to actually keep: best up-to-maxKeepers with POSITIVE surplus.
  function recommendKeepers(candidates, currentSeason, maxKeepers = MAX_KEEPERS) {
    return rankKeepers(candidates, currentSeason)
      .filter(c => c.surplus > 0).slice(0, maxKeepers);
  }

  // Map a Sleeper roster (player_ids) + original-draft history + the board into
  // keeper candidates. Players with no board entry (K/DST/retired/deep) are
  // dropped into `skipped` and counted, never valued.
  function buildKeeperCandidates(rosterPlayerIds, originalByPlayerId, boardBySleeperId) {
    const candidates = [], skipped = [];
    for (const pid of rosterPlayerIds) {
      const b = boardBySleeperId.get(pid);
      if (!b) { skipped.push(pid); continue; }
      const orig = originalByPlayerId.get(pid);
      const c = { name: b.name, position: b.position,
                  adpRound: b.adpRound, overallRank: b.overallRank };
      if (orig) { c.originalRound = orig.round; c.originalYear = orig.season; c.isWaiver = false; }
      else { c.isWaiver = true; }          // on no draft in the chain -> waiver R12
      candidates.push(c);
    }
    return { candidates, skipped };
  }

  function init(options) {
    const { players, panel, currentSeason } = options;
    if (!panel) return;
    const esc = window.FC.esc;
    const rankByName = new Map(players.map((p, i) => [p.name, {
      adpRound: p.adp_round, overallRank: i + 1, position: p.position,
    }]));
    // Autocomplete: fill the datalist the name input references.
    let dl = document.getElementById("playerlist");
    if (!dl) { dl = document.createElement("datalist"); dl.id = "playerlist"; panel.appendChild(dl); }
    dl.innerHTML = players.map(p => `<option value="${esc(p.name)}"></option>`).join("");

    const candidates = [];
    const recEl = panel.querySelector(".keeper-rec");
    const outEl = panel.querySelector(".keeper-out");

    function redraw() {
      const ranked = rankKeepers(candidates, currentSeason);
      const rec = recommendKeepers(candidates, currentSeason);
      const recNames = new Set(rec.map(r => r.name));
      if (!candidates.length) {
        recEl.innerHTML = "";
      } else if (!rec.length) {
        recEl.innerHTML = "<strong>Keep none.</strong> No candidate is worth more than his keeper cost.";
      } else {
        recEl.innerHTML = "<strong>Keep:</strong> " + rec.map(r =>
          `${esc(r.name)} (+${r.surplus} rd${r.surplus === 1 ? "" : "s"})`).join(", ");
      }
      const detail = c => {
        const cost = keeperCost(c, currentSeason);
        const val = valueRound(c.adpRound, c.overallRank);
        const s = c.surplus;
        return `keep for R${cost} · worth R${val} · <strong>${s >= 0 ? "+" : ""}${s} rds</strong>`;
      };
      const ineligible = candidates.filter(c => !eligible(c));
      outEl.innerHTML = ranked.map(c =>
          `<li class="${recNames.has(c.name) ? "keep-best" : ""}">${esc(c.name)} — ${detail(c)}</li>`)
        .concat(ineligible.map(c =>
          `<li class="keeper-ineligible">${esc(c.name)} — ineligible (drafted R1–2)</li>`))
        .join("");
    }
    // Exposed so the Sleeper loader (Task 3) can push a batch of candidates.
    panel._keeperAdd = (list) => { candidates.push(...list); redraw(); };
    panel._keeperReset = () => { candidates.length = 0; redraw(); };

    panel.querySelector(".keeper-add").addEventListener("submit", e => {
      e.preventDefault();
      const name = panel.querySelector(".keeper-name").value.trim();
      const isWaiver = panel.querySelector(".keeper-waiver").checked;
      const originalRound = parseInt(panel.querySelector(".keeper-round").value, 10) || 0;
      // blank year defaults to last season (a single-year keeper)
      const originalYear = parseInt(panel.querySelector(".keeper-year").value, 10) || (currentSeason - 1);
      const meta = rankByName.get(name);
      if (!meta) { panel.querySelector(".keeper-msg").textContent = "no board match for that name"; return; }
      panel.querySelector(".keeper-msg").textContent = "";
      candidates.push({ name, position: meta.position, originalRound, originalYear,
                        isWaiver, adpRound: meta.adpRound, overallRank: meta.overallRank });
      redraw();
    });

    // --- Load from Sleeper -------------------------------------------------
    const boardBySleeperId = new Map();
    players.forEach((p, i) => {
      if (p.sleeper_id) boardBySleeperId.set(p.sleeper_id,
        { name: p.name, position: p.position, adpRound: p.adp_round, overallRank: i + 1 });
    });
    const loadEls = {
      user: panel.querySelector(".keeper-user"),
      btn: panel.querySelector(".keeper-load-btn"),
      status: panel.querySelector(".keeper-load-status"),
      picker: panel.querySelector(".keeper-league-picker"),
      skip: panel.querySelector(".keeper-skip-note"),
    };
    const setLoad = t => { loadEls.status.textContent = t; };

    // Render league buttons and resolve with the chosen league (or null).
    function pickLeague(leagues) {
      return new Promise(resolve => {
        loadEls.picker.innerHTML = "";
        setLoad(`${leagues.length} leagues — pick one`);
        leagues.forEach(lg => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = lg.name || lg.league_id;
          b.addEventListener("click", () => { loadEls.picker.innerHTML = ""; resolve(lg); });
          loadEls.picker.appendChild(b);
        });
      });
    }

    async function loadFromSleeper() {
      const username = loadEls.user.value.trim();
      if (!username) { setLoad("enter your Sleeper username"); return; }
      const seq = ++loadSeq;
      const stale = () => seq !== loadSeq;
      loadEls.skip.textContent = "";
      try {
        setLoad("looking up user…");
        const user = await sapi(`/user/${encodeURIComponent(username)}`);
        if (!user || !user.user_id) { setLoad("user not found"); return; }
        const leagues = (await sapi(`/user/${user.user_id}/leagues/nfl/${currentSeason}`)) || [];
        if (stale()) return;
        if (!leagues.length) { setLoad(`no ${currentSeason} leagues for ${username}`); return; }
        const league = leagues.length === 1 ? leagues[0] : await pickLeague(leagues);
        if (!league || stale()) return;
        const prevId = league.previous_league_id;
        if (!prevId) { setLoad("no prior season found — enter keepers manually"); return; }
        setLoad("reading last season's roster…");
        const rosters = (await sapi(`/league/${prevId}/rosters`)) || [];
        const mine = rosters.find(r => r.owner_id === user.user_id);
        if (!mine || !mine.players) { setLoad("couldn't find your roster last season — enter manually"); return; }
        setLoad("tracing draft history…");
        const original = await buildOriginalByPlayerId(prevId);
        if (stale()) return;
        const { candidates, skipped } = buildKeeperCandidates(mine.players, original, boardBySleeperId);
        panel._keeperReset();
        panel._keeperAdd(candidates);
        setLoad(`loaded ${candidates.length} player(s)`);
        loadEls.skip.textContent = skipped.length
          ? ` · ${skipped.length} not on the board (K/DST/retired) — add manually if needed` : "";
      } catch (e) {
        setLoad(`load failed: ${e.message} — enter keepers manually`);
      }
    }
    loadEls.btn.addEventListener("click", loadFromSleeper);
  }

  return { init, keeperCost, eligible, valueRound, surplus, rankKeepers,
           recommendKeepers, buildKeeperCandidates };
});
