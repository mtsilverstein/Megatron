// site/assets/keepers.js
/* Keeper-value gauge. Pure math + a manual panel; reads the board's ADP.
   The keeper RULE is an argument, never a constant (keeper-rule-settings spec
   section 4; settings and validation live in keeperrules.js). With
   f = first_keep and p = per_year, a drafted player's cost is his round minus f
   for his first keep and minus p more for each later year kept; a never-drafted
   (waiver) player starts at undrafted_round and drops p a year. A drafted
   player keeps his original round even if he was dropped and later picked back
   up (league rule, restated by the owner 2026-11-15), and a season in which
   nobody drafted him costs him nothing: only seasons he is actually KEPT move
   him (owner, 2026-11-16). A cost earlier than earliest_round makes him
   ineligible (back to the draft pool -- if re-drafted, that new pick anchors a
   fresh run, see buildOriginalByPlayerId); max_years (null = no limit) caps
   consecutive years kept. Sleeper lists a kept player as a draft pick with
   is_keeper: true at the round he cost, so his most recent pick already gives
   the right cost; buildOriginalByPlayerId also gives his current run of keeper
   picks (keptYears, lastDraft), which yearsKept counts against the cap.
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
  const Sleeper = (typeof window !== "undefined" && window.Sleeper)
    ? window.Sleeper
    : (typeof require !== "undefined" ? require("./sleeper.js") : null);
  if (!Sleeper) throw new Error("keepers.js requires sleeper.js to be loaded first");
  const KeeperRules = (typeof window !== "undefined" && window.KeeperRules)
    ? window.KeeperRules
    : (typeof require !== "undefined" ? require("./keeperrules.js") : null);
  if (!KeeperRules) throw new Error("keepers.js requires keeperrules.js to be loaded first");

  const TEAMS = 12;      // league size; also the shared default for valueRound
  const DRAFT_ROUNDS = 15;  // QB/RB2/WR2/TE/2FLEX/K/DST + 5 bench
  // Season-points surplus below which a keeper edge is not worth acting on.
  // UN-TUNED DEFAULT, chosen by inspection like optimizer.js's W_STEAL / BYE_PEN --
  // it encodes a priority, not a fitted parameter, and is deliberately NOT tuned
  // against held-out seasons. ~10 season points is ~0.6 points per week, comfortably
  // inside this model's own ~4.3 points/week MAE, so a surplus this small cannot be
  // told apart from projection noise. Revise only by forward observation.
  const MARGINAL_POINTS = 10;
  const CHAIN_CAP = 8;   // safety cap on previous_league_id hops
  // Said wherever a Sleeper load gets an EMPTY draft history (the keeper panel
  // and the pre-draft trade panel): an empty map is not neutral.
  function noHistoryNote(rule) {
    requireRule(rule);
    const u = rule.undrafted_round;
    return "no draft history came back for the previous season(s) — every player is priced as a first-time R"
      + u + " keeper, so " + (KeeperRules.neverDraftedKeepable(rule) ? "none is ineligible" : "none can be kept");
  }
  function requireRule(rule) {
    if (!KeeperRules.isRule(rule)) throw new Error("keepers.js: a keeper rule is required");
  }
  let loadSeq = 0;       // generation token: a stale load can't overwrite a newer one

  // Delegates so there is ONE cache-busting implementation (see sleeper.js).
  // This path was previously unprotected: the keeper panel could read a
  // six-hour-old roster and price keepers against players who had moved.
  const sapi = path => Sleeper.get(path);

  // Walk previous_league_id backward from `startLeagueId`, recording each
  // player's MOST RECENT draft (round, season) as the ladder anchor. A
  // player whose cost falls past the rule's earliest round re-enters the draft pool (see
  // `eligible`); if he's drafted again, that new pick starts a fresh ladder,
  // so the latest draft -- not the earliest -- is the one that determines
  // his current keeper cost. A player dropped and later picked back up keeps
  // this anchor (league rule); if he was not picked in the newest draft, his
  // keeper run restarts and the seasons since the anchor do not decay his
  // cost (see lastDraft, keeperCost).
  // An earlier season whose draft fails is skipped (a gap).
  //
  // Each entry is { round, season, keptYears, lastDraft }. A KEPT player
  // appears in Sleeper's picks with is_keeper: true at the round he cost, so
  // the anchor (his most recent pick, keeper or not) already gives the right
  // cost. keptYears is the run of consecutive seasons, ending at the anchor
  // season, in which his pick is a keeper pick: it stops at the first season
  // where he has no pick or a non-keeper pick. lastDraft is the start league's
  // draft season, the newest the walk loaded: an anchor older than it means he
  // was not picked -- so not kept -- in that draft, and yearsKept treats his
  // keeper run as broken.
  //
  // If the start league's own draft cannot be read -- its draft list or picks
  // fail, or it has no completed draft with picks -- the map is EMPTY: without
  // the newest draft there is no history to read.
  async function buildOriginalByPlayerId(startLeagueId) {
    const original = new Map();
    const bySeason = new Map();   // season -> Map(player_id -> that season's pick)
    let lid = startLeagueId, hops = 0, lastDraft = null;
    while (lid && hops < CHAIN_CAP) {
      const start = hops === 0;
      let league = null;
      try { league = await sapi(`/league/${lid}`); } catch (e) { break; }
      try {
        const drafts = (await sapi(`/league/${lid}/drafts`)) || [];
        // The start league needs its completed draft; an earlier hop takes what it has, as before.
        const draft = drafts.find(d => d.status === "complete") || (start ? null : drafts[0]);
        if (draft) {
          const season = parseInt(draft.season, 10);
          const picks = (await sapi(`/draft/${draft.draft_id}/picks`)) || [];
          if (start) lastDraft = season;
          if (!bySeason.has(season)) bySeason.set(season, new Map());
          const seasonPicks = bySeason.get(season);
          for (const p of picks) {
            if (!p.player_id) continue;
            if (!seasonPicks.has(p.player_id)) seasonPicks.set(p.player_id, p);
            const prev = original.get(p.player_id);
            if (!prev || season > prev.season) original.set(p.player_id, { round: p.round, season });
          }
        }
      } catch (e) {
        if (start) return new Map();   // the newest draft did not load: no history
        /* an earlier season's draft: skip it, keep walking */
      }
      if (start && !original.size) return original;   // no completed draft with picks: no history
      lid = league && league.previous_league_id;
      hops++;
    }
    for (const [pid, o] of original) {
      let kept = 0;
      if (Number.isInteger(o.season)) {
        for (let s = o.season; ; s--) {
          const p = bySeason.has(s) ? bySeason.get(s).get(pid) : null;
          if (!p || p.is_keeper !== true) break;
          kept++;
        }
      }
      o.keptYears = kept;
      o.lastDraft = lastDraft;
    }
    return original;
  }

  // The season a drafted player's decay counts from. A Sleeper entry
  // (lastDraft set): the newest draft walked. His anchor is his most recent
  // pick, and keeper picks sit at the round they cost, so the anchor already
  // carries every earlier keep; a draft after the anchor in which he was not
  // picked was not a keep and must not decay him. Only the seasons after the
  // newest draft do. A manual entry (no lastDraft) counts from its own round's
  // season, i.e. it assumes he has been kept every season since.
  function decaySince(c) {
    return c.lastDraft != null ? c.lastDraft : c.originalYear;
  }
  // Cost per the rule (spec section 4), from his MOST RECENT pick (see
  // buildOriginalByPlayerId); a drop, or a season nobody drafted him, changes
  // nothing (owner, 2026-11-16). f = first_keep, p = per_year.
  //   waiver:  undrafted_round - p * (seasons since first kept)
  //   Sleeper entry (lastDraft set), n = currentSeason - lastDraft: his anchor
  //     is a KEEPER pick (keptYears >= 1) already at the round it cost, so
  //     anchor - p*n; otherwise a fresh pick: anchor - f - p*(n-1)
  //   manual entry, n = currentSeason - originalYear: anchor - f - p*(n-1)
  // No floor: a cost earlier than earliest_round makes him ineligible (see
  // `eligible`) and may legitimately compute to 0 or negative -- that raw value
  // tells the ineligible display how far the ladder has run out. A waiver
  // pickup's blank `firstKeptYear` means "this IS the first keep".
  function keeperCost(c, currentSeason, rule) {
    requireRule(rule);
    const f = rule.first_keep, p = rule.per_year;
    if (c.isWaiver) {
      const first = c.firstKeptYear != null ? c.firstKeptYear : currentSeason;
      return rule.undrafted_round - p * (currentSeason - first);
    }
    if (c.lastDraft != null) {
      const n = currentSeason - c.lastDraft;
      return (c.keptYears || 0) >= 1 ? c.originalRound - p * n : c.originalRound - f - p * (n - 1);
    }
    const n = currentSeason - c.originalYear;
    return c.originalRound - f - p * (n - 1);
  }
  // How many seasons in a row he would have been kept, counting this one: the
  // CURRENT keeper run only. A waiver pickup: seasons since his first keep,
  // plus one (blank firstKeptYear = this IS the first keep). A drafted player
  // from the Sleeper path (lastDraft set): his run of keeper picks up to the
  // anchor (keptYears) counts only when the anchor IS the newest draft -- an
  // older anchor means he was not kept in that draft, so the run is broken --
  // plus the seasons since that newest draft. A manual entry (no lastDraft,
  // no keptYears) counts the seasons since its round.
  function yearsKept(c, currentSeason) {
    if (c.isWaiver) {
      const first = c.firstKeptYear != null ? c.firstKeptYear : currentSeason;
      return currentSeason - first + 1;
    }
    const streak = (c.lastDraft == null || c.originalYear === c.lastDraft) ? (c.keptYears || 0) : 0;
    return streak + (currentSeason - decaySince(c));
  }
  // Keepable iff the computed cost is no earlier than the rule's earliest round
  // AND (unless the rule has no year limit) he has not already been kept
  // max_years seasons. Both gates apply identically to waiver and drafted
  // players. The null check is explicit: `n > null` is true in JS.
  function eligible(c, currentSeason, rule) {
    requireRule(rule);
    if (keeperCost(c, currentSeason, rule) < Math.max(rule.earliest_round, 1)) return false;
    return rule.max_years === null || yearsKept(c, currentSeason) <= rule.max_years;
  }
  // A recommended-or-not candidate whose edge is too small to tell apart from
  // projection noise (see MARGINAL_POINTS). Impacts at or below 0 are already
  // excluded from recommendations elsewhere and are NOT marginal -- they are
  // simply not worth keeping. Presentational only: never used to filter.
  function marginal(c) {
    return c.impact > 0 && c.impact < MARGINAL_POINTS;
  }
  function valueRound(adpRound, overallRank, teams = TEAMS) {
    if (adpRound != null) return adpRound;
    return Math.ceil(overallRank / teams);
  }

  // What `valueRound` means, said out loud. The raw number cannot be shown on
  // its own for two reasons, both visible on the live 2026 board:
  //
  //   1. It routinely names a round this league does not have. The fallback
  //      divides a 695-player board by 12, so it reaches R58; even real ADP
  //      reaches R21 because it comes from drafts that run deeper than ours.
  //      "worth R25" in a 15-round draft is not a price -- Taysom Hill, board
  //      slot 290 with no ADP at all, displayed exactly that. Past the last
  //      round the honest statement is that nobody spends a pick on him, which
  //      is also the fact that decides the keeper call.
  //   2. The two branches are different currencies wearing the same label.
  //      With an ADP it is the MARKET's round (235 players); without one it is
  //      OUR board rank in round clothing (460 players) -- and those are
  //      exactly the players the market does not draft. Naming the source
  //      keeps a model opinion from reading as a market fact.
  function valueLabel(c, rounds = DRAFT_ROUNDS, teams = TEAMS) {
    const r = valueRound(c.adpRound, c.overallRank, teams);
    if (r > rounds) return "goes undrafted";
    return c.adpRound != null ? `worth R${r} (ADP)` : `worth R${r} (our rank)`;
  }
  // Round surplus. Display/diagnostic context ONLY -- rounds are not a linear
  // value currency, so this must never again drive ranking or recommendation.
  function surplus(c, currentSeason, rule) {
    return keeperCost(c, currentSeason, rule) - valueRound(c.adpRound, c.overallRank);
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
  function resolveMaxKeepers(rule, options) {
    const m = options.maxKeepers != null ? options.maxKeepers : rule.max_keepers;
    if (!Number.isInteger(m) || m <= 0) throw new Error("keepers.js: keepers per team must be a positive whole number");
    return m;
  }
  function rankKeepers(candidates, currentSeason, boardPlayers, rule, options = {}) {
    requireRule(rule);
    const teams = options.teams != null ? options.teams : TEAMS;
    const maxKeepers = resolveMaxKeepers(rule, options);
    const depletion = options.depletion !== false;   // default ON

    const valued = candidates.filter(c => eligible(c, currentSeason, rule)).filter(c => Number.isFinite(c.vorp));

    const withCost = valued.map(c => {
      const cost = keeperCost(c, currentSeason, rule);
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
  function unvaluedKeepers(candidates, currentSeason, rule) {
    return candidates.filter(c => eligible(c, currentSeason, rule)).filter(c => !Number.isFinite(c.vorp));
  }

  // Which players to actually keep: best up-to-maxKeepers with POSITIVE impact.
  function recommendKeepers(candidates, currentSeason, boardPlayers, rule, options = {}) {
    requireRule(rule);
    const maxKeepers = resolveMaxKeepers(rule, options);
    return rankKeepers(candidates, currentSeason, boardPlayers, rule, options)
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
      if (orig) {
        c.originalRound = orig.round; c.originalYear = orig.season; c.keptYears = orig.keptYears || 0; c.isWaiver = false;
        if (orig.lastDraft != null) c.lastDraft = orig.lastDraft;
      }
      else { c.isWaiver = true; }          // on no draft in the chain -> waiver ladder
      candidates.push(c);
    }
    return { candidates, skipped };
  }

  // The Sleeper load without the DOM. `session` is the shared Session (spec
  // §5, keepers row): it owns who you are and which league this is, follows
  // previous_league_id and applies the EXACT roster matcher -- owner or
  // co-owner, exactly one; zero or two is its refusal, never a guess here.
  // The multi-season draft-chain walk is unchanged. Rejections propagate with
  // the session's wording (no prior season, no unique roster, superseded).
  async function sleeperKeeperCandidates(session, boardBySleeperId) {
    const { previousLeagueId, roster } = await session.previousLeagueRoster();
    if (!roster || !Array.isArray(roster.players)) throw new Error("couldn't read your roster from last season");
    const original = await buildOriginalByPlayerId(previousLeagueId);
    const { candidates, skipped } = buildKeeperCandidates(roster.players, original, boardBySleeperId);
    return { previousLeagueId, roster, candidates, skipped, historyEmpty: original.size === 0 };
  }

  function init(options) {
    const { players, panel, currentSeason, rule } = options;
    if (!panel) return;
    requireRule(rule);
    if (!Number.isInteger(rule.max_keepers)) throw new Error("keepers.js: the board's keeper rule needs max_keepers");
    const u = rule.undrafted_round, k = rule.max_keepers;
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
    // The text that follows the rule lives in targetable elements; the
    // checkboxes and inputs around them are the page's own.
    const setText = (sel, t) => { const el = panel.querySelector(sel); if (el) el.textContent = t; };
    setText(".keeper-help", KeeperRules.helpText(rule));
    setText(".keeper-waiver-text", ` never drafted in this league (R${u})`);
    setText(".keeper-depletion-text", ` assume ${TEAMS} teams keep ${k} each (${TEAMS * k} players off the board)`);

    function redraw() {
      const opts = { depletion: !depletionEl || depletionEl.checked };
      const ranked = rankKeepers(candidates, currentSeason, players, rule, opts);
      const unvalued = unvaluedKeepers(candidates, currentSeason, rule);
      const rec = recommendKeepers(candidates, currentSeason, players, rule, opts);
      const recNames = new Set(rec.map(r => r.name));
      if (!candidates.length) {
        recEl.innerHTML = "";
      } else if (!rec.length) {
        recEl.innerHTML = "<strong>Keep none.</strong> No candidate is worth more than his keeper cost.";
      } else {
        // If every recommended player is marginal, the headline shouldn't read
        // as a confident instruction either.
        // When they're ALL marginal the headline already says so; repeating it
        // per player just adds noise.
        const allMarginal = rec.every(marginal);
        const headline = allMarginal ? "Keep (marginal):" : "Keep:";
        recEl.innerHTML = `<strong>${headline}</strong> ` + rec.map(r =>
          `${esc(r.name)} (+${r.impact.toFixed(1)} pts)`
          + (!allMarginal && marginal(r) ? " (marginal)" : "")).join(", ");
      }
      const detail = c => {
        const pts = `${c.impact >= 0 ? "+" : ""}${c.impact.toFixed(1)} pts`;
        // A silent discount reads as a bad projection, so say so explicitly.
        const discount = c.discounted
          ? ` · slot-discounted (${c.slot === "flex" ? "flex" : "bench"})` : "";
        // Same reasoning: a coin-flip edge shouldn't read like a confident pick.
        const marginalNote = marginal(c) ? " · marginal" : "";
        return `keep for R${c.cost} · ${valueLabel(c)} · <strong>${pts}</strong>`
          + `${discount}${marginalNote}`;
      };
      const ineligible = candidates.filter(c => !eligible(c, currentSeason, rule));
      outEl.innerHTML = ranked.map(c =>
          `<li class="${recNames.has(c.name) ? "keep-best" : ""}">${esc(c.name)} — ${detail(c)}</li>`)
        .concat(unvalued.map(c =>
          `<li class="keeper-unvalued">${esc(c.name)} — no projection — value unknown</li>`))
        .concat(ineligible.map(c => {
          const n = keeperCost(c, currentSeason, rule);
          // The cap's reason wins whenever he is over it, whatever his cost.
          const reason = rule.max_years !== null && yearsKept(c, currentSeason) > rule.max_years
            ? `already kept the most allowed (${rule.max_years} years), so he goes back to the draft pool`
            : n >= 1
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
    // supplying an original round (fixed at the rule's never-drafted round), so disable+clear that input
    // rather than silently letting the waiver flag override it. The year
    // input stays enabled: a waiver player still needs the year he was FIRST
    // KEPT, since he decays down the rule's cost steps from that round just like anyone else.
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
      // the never-drafted cost); for a drafted player it defaults to last season (a
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
      btn: panel.querySelector(".keeper-load-btn"),
      status: panel.querySelector(".keeper-load-status"),
      skip: panel.querySelector(".keeper-skip-note"),
    };
    const setLoad = t => { loadEls.status.textContent = t; };
    // No username input and no league picker: both belong to the chip in the
    // league panel. The button needs an identity to mean anything, so it is
    // disabled -- and says why -- until the session has one.
    const NO_IDENTITY = "identify yourself in the league bar first";
    const S = typeof window !== "undefined" ? window.Session : null;
    let loading = false;
    let loadedUserId = null;   // whose previous-season roster the list came from

    // Account-derived surface (spec §4.4 rule 2): a list loaded for one
    // account must not stay on screen for another, or for nobody.
    function syncLoad() {
      const identity = S ? S.identity() : null;
      if (loadedUserId && (!identity || identity.userId !== loadedUserId)) {
        panel._keeperReset();
        loadedUserId = null;
        loadEls.skip.textContent = "";
        setLoad(identity ? "account changed — load again" : "");
      }
      loadEls.btn.disabled = loading || !identity;
      if (!identity) setLoad(S ? NO_IDENTITY : "shared session unavailable — enter keepers manually");
      else if (loadEls.status.textContent === NO_IDENTITY) setLoad("");
    }

    async function loadFromSleeper() {
      if (!S || !S.identity()) { syncLoad(); return; }
      const seq = ++loadSeq;
      const stale = () => seq !== loadSeq;
      const userId = S.identity().userId;
      loading = true;
      loadEls.btn.disabled = true;
      loadEls.skip.textContent = "";
      try {
        setLoad("reading last season's roster and tracing draft history…");
        const { candidates, skipped, historyEmpty } = await sleeperKeeperCandidates(S, boardBySleeperId);
        if (stale()) return;
        // The session supersedes a roster answer if the account moves before
        // it resolves; the draft-chain walk after it is ours to guard.
        const now = S.identity();
        if (!now || now.userId !== userId) { setLoad("the account changed while loading — load again"); return; }
        panel._keeperReset();
        panel._keeperAdd(candidates);
        loadedUserId = userId;
        setLoad(`loaded ${candidates.length} player(s)`);
        // Sleeper has no way to tell us a waiver pickup's first-kept year, so
        // buildKeeperCandidates can only default to "this is his first keep."
        // That default is an assumption, and this project doesn't ship silent
        // ones -- surface it alongside (not instead of) the off-board note.
        const notes = [];
        // An empty history prices everyone as a first-time never-drafted keeper under the rule: say so first.
        if (historyEmpty) notes.push(noHistoryNote(rule));
        if (skipped.length) notes.push(`${skipped.length} not on the board (K/DST/retired) — add manually if needed`);
        if (candidates.some(c => c.isWaiver)) {
          notes.push(`waiver keepers assume this is their first keep (R${u}) — set "year first kept" manually if you kept one before`);
        }
        loadEls.skip.textContent = notes.length ? ` · ${notes.join(" · ")}` : "";
      } catch (e) {
        if (stale()) return;
        // The league or the account moved under the load: the session's
        // onChange already redrew what it owns; say so rather than fail.
        if (S.isSuperseded(e)) { setLoad("the league or account changed while loading — load again"); return; }
        const msg = String(e.message || e);
        setLoad(msg.indexOf("enter keepers manually") !== -1 ? msg : `load failed: ${msg} — enter keepers manually`);
      } finally {
        if (!stale()) { loading = false; syncLoad(); }
      }
    }
    loadEls.btn.addEventListener("click", loadFromSleeper);
    if (S) S.onChange(syncLoad);
    syncLoad();
  }

  return { init, keeperCost, yearsKept, eligible, marginal, valueRound, valueLabel, surplus,
           pickForRound, rankKeepers, unvaluedKeepers, recommendKeepers,
           buildKeeperCandidates, buildOriginalByPlayerId, sleeperKeeperCandidates,
           noHistoryNote, TEAMS,
           MARGINAL_POINTS, DRAFT_ROUNDS };
});
