// site/assets/keepers.js
/* Keeper-value gauge. Pure math + a manual panel; reads the board's ADP.
   Rules (spec 2026-07-25): keep up to 2, cost = one round earlier than last
   year's draft round, waiver pickups cost round 12, players drafted in rounds
   1-2 are ineligible. Keeping is optional, so only players with POSITIVE
   impact are ever recommended -- a zero/negative-impact player is worth at
   least as much drafted fresh.

   Value is priced in fantasy points, not rounds (rounds are not a linear
   value currency -- the old round-surplus ranking recommended replacement-
   level players over genuinely valuable ones):

     impact = slotWeight * player.vorp - parVorp(board, effectivePick)

   Both terms are season fantasy points over replacement, from the same VORP
   curve the draft board uses (site/assets/optimizer.js). Round numbers are
   kept only to LOCATE the surrendered pick and for display -- never
   subtracted from each other as if they were value. */
(function (root, factory) {
  const K = factory();
  if (typeof window !== "undefined") window.Keepers = K;
  if (typeof module !== "undefined" && module.exports) module.exports = K;
})(this, function () {
  const Optimizer = (typeof window !== "undefined" && window.Optimizer)
    ? window.Optimizer
    : (typeof require !== "undefined" ? require("./optimizer.js") : null);
  if (!Optimizer) throw new Error("keepers.js requires optimizer.js to be loaded first");

  const WAIVER_COST_ROUND = 12;
  const MAX_KEEPERS = 2;
  const TEAMS = 12;      // league size; also the shared default for valueRound
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
  function valueRound(adpRound, overallRank, teams = TEAMS) {
    if (adpRound != null) return adpRound;
    return Math.ceil(overallRank / teams);
  }
  // Round surplus. Display/diagnostic context ONLY -- rounds are not a linear
  // value currency, so this must never again drive ranking or recommendation.
  function surplus(c, currentSeason) {
    return keeperCost(c, currentSeason) - valueRound(c.adpRound, c.overallRank);
  }

  // The overall pick a cost round corresponds to: that round's mid-pick.
  function pickForRound(round, teams = TEAMS) {
    return (round - 1) * teams + Math.ceil(teams / 2);
  }

  function slotWeight(slot) {
    if (slot === "dedicated") return 1.0;
    if (slot === "flex") return Optimizer.FLEX_WEIGHT;
    return Optimizer.BENCH_WEIGHT;    // "none"
  }

  // Eligible candidates with a real projection, ranked by fantasy-point
  // impact: what the player adds to the starting lineup versus what the
  // surrendered pick would have returned.
  //
  //   impact = slotWeight * player.vorp - parVorp(boardPlayers, effectivePick)
  //
  // Slot weight depends on which players are already kept, so assignment is
  // order dependent: a single greedy pass ranks by UNWEIGHTED impact first
  // (weight 1.0, order-independent), then walks that fixed order assigning
  // real roster slots via rosterSlots/openSlot, recomputing each candidate's
  // impact with the weight he actually receives. The final list is then
  // re-sorted by that weighted impact for display/recommendation.
  function rankKeepers(candidates, currentSeason, boardPlayers, options = {}) {
    const teams = options.teams != null ? options.teams : TEAMS;
    const maxKeepers = options.maxKeepers != null ? options.maxKeepers : MAX_KEEPERS;
    const depletion = options.depletion !== false;   // default ON

    const valued = candidates.filter(eligible).filter(c => Number.isFinite(c.vorp));

    const withCost = valued.map(c => {
      const cost = keeperCost(c, currentSeason);
      const val = valueRound(c.adpRound, c.overallRank, teams);
      const pickNo = pickForRound(cost, teams);
      // Every team's keepers leave the pool before the draft, so the pick at
      // overall pickNo really returns a later board row -- approximated as a
      // flat index offset (teams * maxKeepers players off the board).
      const effectivePick = depletion ? pickNo + teams * maxKeepers : pickNo;
      const par = Optimizer.parVorp(boardPlayers, effectivePick);
      return Object.assign({}, c, { cost, val, pickNo, effectivePick, par,
        unweightedImpact: c.vorp - par });
    });
    withCost.sort((a, b) => b.unweightedImpact - a.unweightedImpact);

    const virtualRoster = [];
    const ranked = withCost.map(c => {
      const counts = Optimizer.rosterSlots(virtualRoster);
      const slot = Optimizer.openSlot(c.position, counts);
      const weight = slotWeight(slot);
      const impact = weight * c.vorp - c.par;
      virtualRoster.push({ position: c.position });
      return Object.assign({}, c, { slot, weight, impact, discounted: weight < 1.0 });
    });
    ranked.sort((a, b) => b.impact - a.impact);
    return ranked;
  }

  // Eligible candidates with NO projection: surfaced but never valued. A
  // silent zero would be indistinguishable from a genuine replacement-level
  // player, so these are excluded from ranking/recommendation entirely.
  function unvaluedKeepers(candidates) {
    return candidates.filter(eligible).filter(c => !Number.isFinite(c.vorp));
  }

  // Which players to actually keep: best up-to-maxKeepers with POSITIVE impact.
  function recommendKeepers(candidates, currentSeason, boardPlayers, options = {}) {
    const maxKeepers = options.maxKeepers != null ? options.maxKeepers : MAX_KEEPERS;
    return rankKeepers(candidates, currentSeason, boardPlayers, options)
      .filter(c => c.impact > 0).slice(0, maxKeepers);
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
                  adpRound: b.adpRound, overallRank: b.overallRank, vorp: b.vorp };
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
      adpRound: p.adp_round, overallRank: i + 1, position: p.position, vorp: p.vorp,
    }]));
    // Autocomplete: fill the datalist the name input references.
    let dl = document.getElementById("playerlist");
    if (!dl) { dl = document.createElement("datalist"); dl.id = "playerlist"; panel.appendChild(dl); }
    dl.innerHTML = players.map(p => `<option value="${esc(p.name)}"></option>`).join("");

    const candidates = [];
    const recEl = panel.querySelector(".keeper-rec");
    const outEl = panel.querySelector(".keeper-out");
    const depletionEl = panel.querySelector(".keeper-depletion-toggle");

    function redraw() {
      const opts = { depletion: !depletionEl || depletionEl.checked };
      const ranked = rankKeepers(candidates, currentSeason, players, opts);
      const unvalued = unvaluedKeepers(candidates);
      const rec = recommendKeepers(candidates, currentSeason, players, opts);
      const recNames = new Set(rec.map(r => r.name));
      if (!candidates.length) {
        recEl.innerHTML = "";
      } else if (!rec.length) {
        recEl.innerHTML = "<strong>Keep none.</strong> No candidate is worth more than his keeper cost.";
      } else {
        recEl.innerHTML = "<strong>Keep:</strong> " + rec.map(r =>
          `${esc(r.name)} (+${r.impact.toFixed(1)} pts)`).join(", ");
      }
      const detail = c => {
        const pts = `${c.impact >= 0 ? "+" : ""}${c.impact.toFixed(1)} pts`;
        // A silent discount reads as a bad projection, so say so explicitly.
        const discount = c.discounted
          ? ` · slot-discounted (${c.slot === "flex" ? "flex" : "bench"})` : "";
        return `keep for R${c.cost} · worth R${c.val} · <strong>${pts}</strong>${discount}`;
      };
      const ineligible = candidates.filter(c => !eligible(c));
      outEl.innerHTML = ranked.map(c =>
          `<li class="${recNames.has(c.name) ? "keep-best" : ""}">${esc(c.name)} — ${detail(c)}</li>`)
        .concat(unvalued.map(c =>
          `<li class="keeper-unvalued">${esc(c.name)} — no projection — value unknown</li>`))
        .concat(ineligible.map(c =>
          `<li class="keeper-ineligible">${esc(c.name)} — ineligible (drafted R1–2)</li>`))
        .join("");
    }
    // Exposed so the Sleeper loader (Task 3) can push a batch of candidates.
    panel._keeperAdd = (list) => { candidates.push(...list); redraw(); };
    panel._keeperReset = () => { candidates.length = 0; redraw(); };
    if (depletionEl) depletionEl.addEventListener("change", redraw);

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
                        isWaiver, adpRound: meta.adpRound, overallRank: meta.overallRank,
                        vorp: meta.vorp });
      redraw();
    });

    // --- Load from Sleeper -------------------------------------------------
    const boardBySleeperId = new Map();
    players.forEach((p, i) => {
      if (p.sleeper_id) boardBySleeperId.set(p.sleeper_id,
        { name: p.name, position: p.position, adpRound: p.adp_round, overallRank: i + 1,
          vorp: p.vorp });
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

  return { init, keeperCost, eligible, valueRound, surplus, pickForRound,
           rankKeepers, unvaluedKeepers, recommendKeepers, buildKeeperCandidates,
           TEAMS, MAX_KEEPERS };
});
