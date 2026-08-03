// site/assets/keepers.js
/* Keeper-value gauge. Pure math + a manual panel; reads the board's ADP.
   Rules (spec 2026-07-25, corrected per league restatement): keep up to 2,
   cost drops one round per year KEPT. A drafted player's years-kept always
   equals calendar years since his (most recent) draft, since skipping a
   year sends him back to the pool. A waiver pickup (never drafted in this
   league) starts the ladder at round 12 the first year he's kept, then
   decays exactly the same way. Once a player's computed cost would be R2
   or lower he is ineligible and returns to the draft pool -- if re-drafted,
   that new pick anchors a fresh ladder (see buildOriginalByPlayerId).
   Keeping is optional, so only players with POSITIVE impact are ever
   recommended -- a zero/negative-impact player is worth at least as much
   drafted fresh.

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
  // Season-points surplus below which a keeper edge is not worth acting on.
  // UN-TUNED DEFAULT, chosen by inspection like optimizer.js's W_STEAL / BYE_PEN --
  // it encodes a priority, not a fitted parameter, and is deliberately NOT tuned
  // against held-out seasons. ~10 season points is ~0.6 points per week, comfortably
  // inside this model's own ~4.3 points/week MAE, so a surplus this small cannot be
  // told apart from projection noise. Revise only by forward observation.
  const MARGINAL_POINTS = 10;
  const SLEEPER = "https://api.sleeper.app/v1";
  const CHAIN_CAP = 8;   // safety cap on previous_league_id hops
  let loadSeq = 0;       // generation token: a stale load can't overwrite a newer one

  async function sapi(path) {
    const res = await fetch(`${SLEEPER}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Walk previous_league_id backward from `startLeagueId`, recording each
  // player's MOST RECENT draft (round, season) as the ladder anchor. A
  // player whose cost falls to R2 or below re-enters the draft pool (see
  // `eligible`); if he's drafted again, that new pick starts a fresh ladder,
  // so the latest draft -- not the earliest -- is the one that determines
  // his current keeper cost. Partial failures skip that hop and keep walking.
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
            if (!prev || season > prev.season) original.set(p.player_id, { round: p.round, season });
          }
        }
      } catch (e) { /* skip this season's draft, keep walking */ }
      lid = league && league.previous_league_id;
      hops++;
    }
    return original;
  }

  // Cost drops one round per year KEPT, anchored to his MOST RECENT draft
  // (see buildOriginalByPlayerId). No floor: once the computed cost is R2 or
  // below he is ineligible (see `eligible`) and may legitimately compute to 0
  // or negative here -- that raw value is what tells the ineligible display
  // how far the ladder has run out.
  //
  // Waiver pickups (never drafted in this league) start the ladder at R12
  // the first year they're kept, then decay exactly like a drafted player:
  // R11 the next year, R10 the year after, and so on. `firstKeptYear` blank
  // means "this IS the first keep" (currentSeason).
  function keeperCost(c, currentSeason) {
    if (c.isWaiver) {
      const first = c.firstKeptYear != null ? c.firstKeptYear : currentSeason;
      return WAIVER_COST_ROUND - (currentSeason - first);
    }
    return c.originalRound - (currentSeason - c.originalYear);
  }
  // Keepable iff the computed cost is R3 or higher. Once cost would be R2 or
  // lower he returns to the draft pool instead -- this applies identically to
  // waiver-ladder cost and drafted cost, since both come out of keeperCost.
  function eligible(c, currentSeason) {
    return keeperCost(c, currentSeason) >= 3;
  }
  // A recommended-or-not candidate whose edge is too small to tell apart from
  // projection noise (see MARGINAL_POINTS). Impacts at or below 0 are already
  // excluded from recommendations elsewhere and are NOT marginal -- they are
  // simply not worth keeping. Presentational only: never used to filter.
  function marginal(c, currentSeason) {
    return c.impact > 0 && c.impact < MARGINAL_POINTS;
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

    const valued = candidates.filter(c => eligible(c, currentSeason)).filter(c => Number.isFinite(c.vorp));

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
  function unvaluedKeepers(candidates, currentSeason) {
    return candidates.filter(c => eligible(c, currentSeason)).filter(c => !Number.isFinite(c.vorp));
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
      const unvalued = unvaluedKeepers(candidates, currentSeason);
      const rec = recommendKeepers(candidates, currentSeason, players, opts);
      const recNames = new Set(rec.map(r => r.name));
      if (!candidates.length) {
        recEl.innerHTML = "";
      } else if (!rec.length) {
        recEl.innerHTML = "<strong>Keep none.</strong> No candidate is worth more than his keeper cost.";
      } else {
        // If every recommended player is marginal, the headline shouldn't read
        // as a confident instruction either.
        const headline = rec.every(r => marginal(r, currentSeason)) ? "Keep (marginal):" : "Keep:";
        recEl.innerHTML = `<strong>${headline}</strong> ` + rec.map(r =>
          `${esc(r.name)} (+${r.impact.toFixed(1)} pts)${marginal(r, currentSeason) ? " (marginal)" : ""}`).join(", ");
      }
      const detail = c => {
        const pts = `${c.impact >= 0 ? "+" : ""}${c.impact.toFixed(1)} pts`;
        // A silent discount reads as a bad projection, so say so explicitly.
        const discount = c.discounted
          ? ` · slot-discounted (${c.slot === "flex" ? "flex" : "bench"})` : "";
        // Same reasoning: a coin-flip edge shouldn't read like a confident pick.
        const marginalNote = marginal(c, currentSeason) ? " · marginal" : "";
        return `keep for R${c.cost} · worth R${c.val} · <strong>${pts}</strong>${discount}${marginalNote}`;
      };
      const ineligible = candidates.filter(c => !eligible(c, currentSeason));
      outEl.innerHTML = ranked.map(c =>
          `<li class="${recNames.has(c.name) ? "keep-best" : ""}">${esc(c.name)} — ${detail(c)}</li>`)
        .concat(unvalued.map(c =>
          `<li class="keeper-unvalued">${esc(c.name)} — no projection — value unknown</li>`))
        .concat(ineligible.map(c => {
          const n = keeperCost(c, currentSeason);
          const reason = n >= 1
            ? `cost would be R${n}, so he goes back to the draft pool`
            : `his keeper ladder has run out`;
          return `<li class="keeper-ineligible">${esc(c.name)} — ineligible: ${reason}</li>`;
        }))
        .join("");
    }
    // Exposed so the Sleeper loader (Task 3) can push a batch of candidates.
    panel._keeperAdd = (list) => { candidates.push(...list); redraw(); };
    panel._keeperReset = () => { candidates.length = 0; redraw(); };
    if (depletionEl) depletionEl.addEventListener("change", redraw);

    // Checked = "never drafted in this league" -- mutually exclusive with
    // supplying an original round (fixed at R12), so disable+clear that input
    // rather than silently letting the waiver flag override it. The year
    // input stays enabled: a waiver player still needs the year he was FIRST
    // KEPT, since he decays down the ladder from R12 just like anyone else.
    const waiverEl = panel.querySelector(".keeper-waiver");
    const roundEl = panel.querySelector(".keeper-round");
    const yearEl = panel.querySelector(".keeper-year");
    if (waiverEl) {
      const yearPlaceholderDefault = yearEl.placeholder;
      waiverEl.addEventListener("change", () => {
        const on = waiverEl.checked;
        roundEl.disabled = on;
        if (on) roundEl.value = "";
        yearEl.placeholder = on ? "Year first kept" : yearPlaceholderDefault;
      });
    }

    panel.querySelector(".keeper-add").addEventListener("submit", e => {
      e.preventDefault();
      const name = panel.querySelector(".keeper-name").value.trim();
      const isWaiver = panel.querySelector(".keeper-waiver").checked;
      const originalRound = parseInt(panel.querySelector(".keeper-round").value, 10) || 0;
      const yearInput = parseInt(panel.querySelector(".keeper-year").value, 10);
      // Blank year: for a waiver pickup this IS the first keep (currentSeason,
      // cost R12); for a drafted player it defaults to last season (a
      // single-year keeper), as before.
      const originalYear = Number.isFinite(yearInput) ? yearInput : (currentSeason - 1);
      const meta = rankByName.get(name);
      if (!meta) { panel.querySelector(".keeper-msg").textContent = "no board match for that name"; return; }
      panel.querySelector(".keeper-msg").textContent = "";
      const c = { name, position: meta.position, originalRound, originalYear,
                  isWaiver, adpRound: meta.adpRound, overallRank: meta.overallRank,
                  vorp: meta.vorp };
      if (isWaiver) c.firstKeptYear = Number.isFinite(yearInput) ? yearInput : currentSeason;
      candidates.push(c);
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
        // Sleeper has no way to tell us a waiver pickup's first-kept year, so
        // buildKeeperCandidates can only default to "this is his first keep."
        // That default is an assumption, and this project doesn't ship silent
        // ones -- surface it alongside (not instead of) the off-board note.
        const notes = [];
        if (skipped.length) notes.push(`${skipped.length} not on the board (K/DST/retired) — add manually if needed`);
        if (candidates.some(c => c.isWaiver)) {
          notes.push(`waiver keepers assume this is their first keep (R12) — set "year first kept" manually if you kept one before`);
        }
        loadEls.skip.textContent = notes.length ? ` · ${notes.join(" · ")}` : "";
      } catch (e) {
        setLoad(`load failed: ${e.message} — enter keepers manually`);
      }
    }
    loadEls.btn.addEventListener("click", loadFromSleeper);
  }

  return { init, keeperCost, eligible, marginal, valueRound, surplus, pickForRound,
           rankKeepers, unvaluedKeepers, recommendKeepers, buildKeeperCandidates,
           buildOriginalByPlayerId, TEAMS, MAX_KEEPERS, MARGINAL_POINTS };
});
