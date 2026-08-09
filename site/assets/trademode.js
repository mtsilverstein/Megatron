// site/assets/trademode.js
/* Trade calculator panel: Sleeper -> two asset columns -> a graded offer.

   The maths lives in trade.js (pure, node-tested). This file is the thin DOM
   and network layer around it, plus ONE assembly step that is neither: turning
   a Sleeper league into the `{teams, ctx}` world every Trade function takes.
   That step is `leagueWorld`, exported and tested with a stubbed Sleeper.get,
   because it is where the mistakes live -- above all the id translation
   (Keepers.buildOriginalByPlayerId is keyed on SLEEPER ids, Trade.candidate
   looks up the BOARD's player_id; getting it wrong makes every player look
   like an undrafted waiver pickup and the page stays plausible while being
   uniformly wrong).

   Two rules from the spec that this file is the last place to break:

   - NEVER read Sleeper's `keepers` field, and never read league settings for
     rules. Pre-draft a keeper tag is meaningless -- a manager may set one
     precisely because they intend to shop the player. Keeper status is DERIVED
     on both sides of every trade by Trade.chooseKeepers. League rules come
     from Keepers.TEAMS / DRAFT_ROUNDS / MAX_KEEPERS.
   - Degrade LOUDLY. A quiet zero and a quiet empty list are indistinguishable
     from a broken panel. Every empty state here says what happened and why:
     an ineligible player says his cost, a replacement-level asset says so in
     words instead of printing "0.0" (599 of the 695 live board rows price at
     exactly 0.00), and an empty suggestion list says which bar nothing
     cleared. */
(function (root, factory) {
  const M = factory();
  if (typeof window !== "undefined") window.TradeMode = M;
  if (typeof module !== "undefined" && module.exports) module.exports = M;
})(this, function () {
  const dep = (name, path) => (typeof window !== "undefined" && window[name])
    ? window[name]
    : (typeof require !== "undefined" ? require(path) : null);
  const Optimizer = dep("Optimizer", "./optimizer.js");
  const Keepers = dep("Keepers", "./keepers.js");
  const Trade = dep("Trade", "./trade.js");
  const Sleeper = dep("Sleeper", "./sleeper.js");
  if (!Optimizer || !Keepers || !Trade || !Sleeper) {
    throw new Error("trademode.js requires optimizer.js, keepers.js, trade.js and sleeper.js first");
  }

  // Delegate so there is ONE cache-busting implementation (see sleeper.js), and
  // so a test can stub Sleeper.get by assigning to it -- the property is read
  // at call time, not captured here.
  const sapi = path => Sleeper.get(path);
  // Resolved lazily: app.js publishes FC on window with no UMD wrapper, so it
  // does not exist under node. Nothing that renders is reachable from a test.
  const esc = s => window.FC.esc(s);

  // How many seasons of draft picks are tradeable. Sleeper keeps picks further
  // out than that; three seasons is already ~45 pick-assets per team, which is
  // what sets the suggester's runtime (see PREFILTER_SECONDS below).
  const PICK_SEASONS_AHEAD = 2;
  // Below this a market value is not a price, it is the absence of one. See
  // Trade.marketValue's comment: parVorp clamps to 0 at or below positional
  // replacement, which is true of most of the board and every pick from round
  // 9 down, so `.toFixed(1)` would render "0.0" as if it were a valuation.
  const MARKET_EPS = 0.05;
  const SUGGEST_SHOW = 10;
  // The search has TWO phases that behave completely differently, so the single
  // "about 8 seconds" this replaces was both stale (4.4x understated after wave
  // 2) and the wrong shape. Everything below is measured on the live 695-player
  // board, 15-man rosters, all eleven opponents -- see
  // .superpowers/sdd/final-fixes-wave3-report.md.
  //
  //   PREFILTER -- Trade.suggestCandidates: one stateValue per player on either
  //   roster. It is NOT interruptible, so this half really does freeze the
  //   page: 5.7-6.7 s under node, median 6.2 s; 6.2 s observed in Chrome. That
  //   is what PREFILTER_SECONDS states, and it is the ONLY freeze left.
  //
  //   SCORING -- Trade.scoreCandidate, one honest grade apiece: 347-631 ms
  //   under node, median 443 ms, x SUGGEST_PER_TEAM (40) candidates, i.e.
  //   14-20 s more. The scorer runs ONE per turn of the event loop and renders
  //   each surviving offer as it is found, so this half is neither a freeze nor
  //   a progress bar with an invented fraction: the panel reports scored-so-far
  //   out of a total that is known exactly, and Stop keeps what has been found.
  //   Time to the FIRST rendered offer, on the six opponents that produce any
  //   at all: 7.8, 14.3, 17.0, 17.0, 17.0, 18.0 s under node. Chrome runs the
  //   same work about a quarter faster throughout -- the one run driven end to
  //   end in the browser took 5.7 s to its first offer and 18.5 s in total
  //   against node's 7.8 s and 26.2 s for the same opponent -- so every node
  //   figure here is the pessimistic one.
  const PREFILTER_SECONDS = 6;

  // ---------------------------------------------------------------------------
  // Assembly: the one non-trivial pure-ish step, exported for the fixture.
  // ---------------------------------------------------------------------------

  function teamName(user, rosterId) {
    const meta = user && user.metadata;
    return (meta && meta.team_name) || (user && user.display_name) || `Roster ${rosterId}`;
  }

  // A Sleeper league -> {teams, ctx, warnings}, where every team carries the
  // `{roster, picks}` state Trade takes and ctx carries all five required
  // fields. `warnings` is the loud half: anything the caller must SAY rather
  // than silently absorb.
  async function leagueWorld(league, board, opts = {}) {
    const season = board.season;
    const players = Optimizer.withValuePoints(board.players)
      .filter(p => Number.isFinite(Optimizer.seasonValue(p)));
    const bySleeper = new Map();
    for (const p of players) if (p.sleeper_id) bySleeper.set(p.sleeper_id, p);

    const warnings = [];
    const lid = league.league_id;
    // traded_picks is the only one of the three allowed to fail: without it we
    // fall back to defaultPicks, which is a statement ("everyone holds their
    // own") rather than a guess. users/rosters have no honest fallback, so a
    // rejection there propagates and the caller reports the load as failed.
    let tradedPicks = null;
    const [users, rosters] = await Promise.all([
      sapi(`/league/${lid}/users`),
      sapi(`/league/${lid}/rosters`),
      sapi(`/league/${lid}/traded_picks`)
        .then(r => { tradedPicks = r || []; })
        .catch(() => {
          warnings.push("couldn't read traded picks — pick ownership may be wrong; "
            + "every team is shown holding its own picks");
        }),
    ]);
    if (!Array.isArray(rosters) || !rosters.length) {
      throw new Error("that league has no rosters");
    }
    if (rosters.length !== Keepers.TEAMS) {
      warnings.push(`this league has ${rosters.length} teams, but picks and keeper `
        + `costs here are priced for a ${Keepers.TEAMS}-team league`);
    }
    const usersById = new Map((users || []).map(u => [u.user_id, u]));

    // Keeper ladders come from the draft chain, never from Sleeper's `keepers`
    // field. An empty map is not a neutral default: it says every player was
    // picked up off waivers, which prices them all as first-time R12 keepers
    // and makes nobody ineligible. So both ways of getting one are announced.
    let original = new Map();
    if (league.previous_league_id) {
      original = await Keepers.buildOriginalByPlayerId(league.previous_league_id);
      if (!original.size) {
        warnings.push("no draft history came back for the previous season(s) — every "
          + "player is priced as a first-time R12 keeper, so none is ineligible");
      }
    } else {
      warnings.push("no prior season — keeper costs unknown, every player priced at "
        + "full value (each is treated as a first-time R12 keeper, so nobody is ineligible)");
    }
    // THE translation. buildOriginalByPlayerId is keyed on Sleeper ids;
    // Trade.candidate looks up player.player_id, which is the board's id.
    const originalByPlayerId = new Map();
    for (const [sleeperId, orig] of original) {
      const p = bySleeper.get(sleeperId);
      if (p) originalByPlayerId.set(p.player_id, orig);
    }

    const seasons = [];
    for (let i = 0; i <= PICK_SEASONS_AHEAD; i++) seasons.push(season + i);
    const owned = Trade.defaultPicks(rosters.map(r => r.roster_id), seasons,
                                     Keepers.DRAFT_ROUNDS);
    if (tradedPicks) Trade.applyTradedPicks(owned, tradedPicks);

    const teams = rosters.map(r => {
      const roster = [], unmatched = [];
      for (const sid of r.players || []) {
        const p = bySleeper.get(sid);
        if (p) roster.push(p); else unmatched.push(sid);
      }
      roster.sort((a, b) => Trade.boardRank(players, a) - Trade.boardRank(players, b));
      const picks = (owned.get(r.roster_id) || []).slice()
        .sort((a, b) => a.season - b.season || a.round - b.round);
      return { rosterId: r.roster_id, ownerId: r.owner_id || null,
               coOwners: r.co_owners || [],
               name: teamName(usersById.get(r.owner_id), r.roster_id),
               state: { roster, picks }, unmatched };
    });

    const ctx = { season, teams: Keepers.TEAMS, rounds: Keepers.DRAFT_ROUNDS,
                  maxKeepers: Keepers.MAX_KEEPERS, board: players,
                  futureDiscount: opts.futureDiscount != null
                    ? opts.futureDiscount : Trade.FUTURE_DISCOUNT,
                  originalByPlayerId, keptElsewhere: new Set() };
    return { teams, ctx, warnings };
  }

  // The ctx `keptElsewhere` derives its answers against, HOISTED into a memo
  // keyed on the real ctx. Not a micro-optimisation: Trade.chooseKeepers caches
  // per ctx OBJECT and per ctx.keptElsewhere IDENTITY, so building
  // `Object.assign({}, ctx, {keptElsewhere: new Set()})` fresh on every call --
  // two new objects each time -- guaranteed a cold cache on every partner
  // change, and every change paid the full 10-team selection (measured: 1.85 s,
  // 1.71 s, 1.77 s, 1.79 s, 1.71 s for five successive changes). With the base
  // hoisted, only the newly-uninvolved team is a miss.
  //
  // The empty `keptElsewhere` is REBUILT ONLY when a field the keeper choice
  // depends on changes, so its identity is stable and the memo survives -- but
  // it is still an empty Set that is never read from ctx, which is what keeps
  // the documented promise that this function's result cannot depend on what
  // ctx.keptElsewhere happened to hold (the fixture asserts exactly that).
  // futureDiscount is copied across on every call instead of invalidating,
  // because it is not in the keeper memo's signature -- it prices only future
  // picks, which never reach a keeper decision.
  const baseCtxCache = new WeakMap();
  function keptElsewhereCtx(ctx) {
    let base = baseCtxCache.get(ctx);
    if (!base || base.season !== ctx.season || base.board !== ctx.board
        || base.originalByPlayerId !== ctx.originalByPlayerId
        || base.teams !== ctx.teams || base.maxKeepers !== ctx.maxKeepers
        || base.rounds !== ctx.rounds) {
      base = Object.assign({}, ctx, { keptElsewhere: new Set() });
      baseCtxCache.set(ctx, base);
    }
    base.futureDiscount = ctx.futureDiscount;
    return base;
  }

  // Every player the OTHER teams -- the ones not in this trade -- would keep,
  // and so take off the draft pool. Recomputed whenever the partner changes,
  // because the partner's keepers are derived inside the trade, not here.
  // Deliberately computed against a ctx whose own keptElsewhere is empty, so
  // the result never depends on what happened to be in ctx when it was called.
  function keptElsewhere(teams, ctx, exclude) {
    const skip = new Set(exclude || []);
    const base = keptElsewhereCtx(ctx);
    const gone = new Set();
    for (const t of teams) {
      if (skip.has(t.rosterId)) continue;
      for (const k of Trade.chooseKeepers(t.state.roster, t.state.picks, base)) {
        gone.add(k.player.player_id);
      }
    }
    return gone;
  }

  // ---------------------------------------------------------------------------
  // Labels. Nothing here prints a bare number that the reader cannot check.
  // ---------------------------------------------------------------------------

  const isPick = a => a.player_id === undefined;
  const assetLabel = a => isPick(a) ? `${a.season} R${a.round}` : a.name;
  const assetId = a => isPick(a) ? `${a.season}R${a.round}` : a.player_id;

  // What the OTHER manager sees when he looks at this asset. Never "0.0": see
  // MARKET_EPS. For a player the round is labelled with its source, because
  // 460 of 695 live rows have no ADP and fall back to our own board rank -- a
  // model opinion wearing a market fact's clothes is the bug Keepers.valueLabel
  // exists to prevent.
  function marketNote(a, ctx) {
    const v = Trade.marketValue(a, ctx);
    const worth = v > MARKET_EPS
      ? `${v.toFixed(1)} pts over replacement`
      : "no market value (replacement level)";
    if (isPick(a)) {
      const ahead = a.season - ctx.season;
      return `market: ${worth}`
        + (ahead > 0 ? ` · future pick, discounted ×${ctx.futureDiscount}` : "");
    }
    const teams = ctx.teams || Keepers.TEAMS;
    const round = a.adp_round != null
      ? a.adp_round
      : Math.ceil(Trade.boardRank(ctx.board, a) / teams);
    const where = round > (ctx.rounds || Keepers.DRAFT_ROUNDS)
      ? "market: goes undrafted"
      : `market: R${round} ${a.adp_round != null ? "(ADP)" : "(our rank)"}`;
    return `${where} · ${worth}`;
  }

  // His keeper cost, and whether he is worth anything at all pre-draft. The
  // ineligible case is the least intuitive rule in the league, so it is said in
  // full every time rather than shown as a dimmed row with no explanation.
  function keeperNote(player, ctx) {
    const c = Trade.candidate(player, ctx);
    const cost = Keepers.keeperCost(c, ctx.season);
    if (Keepers.eligible(c, ctx.season)) return { eligible: true, text: `keeper cost R${cost}` };
    return { eligible: false, text: cost >= 1
      ? `keeper cost would be R${cost} — back to the draft pool, worth 0 to trade`
      : "his keeper ladder has run out — back to the draft pool, worth 0 to trade" };
  }

  // ---------------------------------------------------------------------------
  // The panel
  // ---------------------------------------------------------------------------

  let cfg = null, els = null;
  let world = null;                 // {teams, ctx, warnings} from leagueWorld
  let me = null, partner = null;
  let sides = null;                 // {mine, theirs}: {ul, team, assets, picked}
  let lastSuggestions = null;       // deduped as offers arrive; ONE list, one count
  let loadSeq = 0, gradeSeq = 0;    // generation tokens: a stale run can't win
  let note = "";                    // transient warning (bad discount, stale list)

  const setStatus = t => { els.status.textContent = t; };

  function renderWarn() {
    const all = ((world && world.warnings) || []).concat(note ? [note] : []);
    els.warn.textContent = all.join(" · ");
    els.warn.hidden = !all.length;
  }
  const setNote = t => { note = t; renderWarn(); };

  // Render league buttons and resolve with the chosen league. Same pattern as
  // keepers.js's pickLeague.
  function pickLeague(leagues) {
    return new Promise(resolve => {
      els.picker.innerHTML = "";
      setStatus(`${leagues.length} leagues — pick one`);
      leagues.forEach(lg => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = lg.name || lg.league_id;
        b.addEventListener("click", () => { els.picker.innerHTML = ""; resolve(lg); });
        els.picker.appendChild(b);
      });
    });
  }

  async function load() {
    const username = els.user.value.trim();
    if (!username) { setStatus("enter your Sleeper username"); return; }
    const seq = ++loadSeq;
    const stale = () => seq !== loadSeq;
    try {
      setStatus("looking up user…");
      const user = await sapi(`/user/${encodeURIComponent(username)}`);
      if (stale()) return;
      if (!user || !user.user_id) { setStatus("user not found"); return; }
      const season = cfg.board.season;
      const leagues = (await sapi(`/user/${user.user_id}/leagues/nfl/${season}`)) || [];
      if (stale()) return;
      if (!leagues.length) { setStatus(`no ${season} leagues for ${username}`); return; }
      const league = leagues.length === 1 ? leagues[0] : await pickLeague(leagues);
      if (!league || stale()) return;
      setStatus("reading rosters, picks and draft history…");
      const w = await leagueWorld(league, cfg.board,
                                  { futureDiscount: readDiscount() });
      if (stale()) return;
      const mine = w.teams.find(t => t.ownerId === user.user_id
        || (t.coOwners || []).indexOf(user.user_id) !== -1);
      if (!mine) {
        setStatus(`couldn't find a roster for ${username} in ${league.name || league.league_id}`);
        return;
      }
      world = w; me = mine;
      fillPartners();
      onPartnerChange();          // computes keptElsewhere and draws both columns
      els.controls.hidden = false;
      els.cols.hidden = false;
      setStatus(`${w.teams.length} teams loaded — you are ${me.name}`);
      renderWarn();
    } catch (e) {
      setStatus(`load failed: ${e.message}`);
    }
  }

  function fillPartners() {
    els.partner.innerHTML = "";
    for (const t of world.teams) {
      if (t.rosterId === me.rosterId) continue;
      const o = document.createElement("option");
      o.value = String(t.rosterId);
      o.textContent = t.name;
      els.partner.appendChild(o);
    }
  }

  // The discount input, read honestly. `Number(v) || 0.8` would turn a
  // deliberate 0 -- "future picks are worth nothing to me" -- into 0.8 without
  // saying so, which is exactly the class of silent substitution this page is
  // supposed to be free of.
  function readDiscount() {
    const raw = els.discount.value.trim();
    const v = Number(raw);
    if (raw !== "" && Number.isFinite(v) && v >= 0 && v <= 1) return v;
    return null;
  }

  function onDiscount() {
    if (!world) return;
    const v = readDiscount();
    if (v === null) {
      setNote(`future-pick discount must be a number from 0 to 1 — still using ×${world.ctx.futureDiscount}`);
      return;
    }
    if (v === world.ctx.futureDiscount) { setNote(""); return; }
    // Supersede any scoring in flight BEFORE ctx changes under it: the
    // candidates it is working through were prefiltered at the old discount,
    // and its next turn would grade them at the new one and render the mix as
    // if it were one answer.
    cancelSuggest();
    world.ctx.futureDiscount = v;
    setNote("");
    staleSuggestions("the future-pick discount changed");
    drawSide(sides.mine);
    drawSide(sides.theirs);       // the market labels quote the discount
    renderGrade();
  }

  function onPartnerChange() {
    // Same reason as onDiscount: a run in flight is scoring the OLD partner's
    // packages, and both `partner` and ctx.keptElsewhere are about to move.
    cancelSuggest();
    partner = world.teams.find(t => String(t.rosterId) === els.partner.value)
      || world.teams.find(t => t.rosterId !== me.rosterId);
    if (!partner) { setStatus("this league has only one team — nobody to trade with"); return; }
    els.partner.value = String(partner.rosterId);
    // Every OTHER team's keepers leave the pool. Derived here and nowhere else,
    // and recomputed on every partner change because the partner's own keepers
    // are decided inside the trade instead.
    world.ctx.keptElsewhere = keptElsewhere(world.teams, world.ctx,
                                            [me.rosterId, partner.rosterId]);
    sides = {
      mine: { ul: els.mine, team: me, assets: [], picked: new Set() },
      theirs: { ul: els.theirs, team: partner, assets: [], picked: new Set() },
    };
    lastSuggestions = null;
    els.suggestions.hidden = true;
    drawSide(sides.mine);
    drawSide(sides.theirs);
    renderGrade();
  }

  // --- asset columns ---------------------------------------------------------

  function drawSide(side) {
    const ctx = world.ctx;
    side.assets = side.team.state.roster.concat(side.team.state.picks);
    const rows = side.assets.map((a, i) => {
      const picked = side.picked.has(i);
      if (isPick(a)) {
        return row({ kind: "pick", id: assetId(a), idx: i, picked, clickable: true,
                     label: assetLabel(a), chip: "", why: marketNote(a, ctx) });
      }
      const k = keeperNote(a, ctx);
      return row({ kind: "player", id: assetId(a), idx: i, picked,
                   clickable: k.eligible,
                   cls: k.eligible ? "" : "trade-ineligible",
                   label: a.name, chip: a.position,
                   why: k.eligible ? `${k.text} · ${marketNote(a, ctx)}` : k.text });
    });
    // A roster player the board cannot price is NOT dropped silently: an
    // invisible player reads as a roster that is short, and there is no way to
    // tell that from a player the tool simply has no opinion about. Sleeper
    // gives us only his id here, so his id is what we can honestly show.
    for (const sid of side.team.unmatched) {
      rows.push(row({ kind: "player", id: sid, picked: false, clickable: false,
                      cls: "trade-unvalued", label: `Sleeper #${sid}`, chip: "",
                      why: "no projection — value unknown" }));
    }
    side.ul.innerHTML = rows.join("");
    const noteEl = document.getElementById(side.ul.id + "-note");
    if (noteEl) {
      const n = side.team.state.roster.length, p = side.team.state.picks.length;
      noteEl.textContent = `${side.team.name} — ${n} player(s), ${p} pick(s)`
        + (side.team.unmatched.length
          ? ` · ${side.team.unmatched.length} not on this board (K/D-ST, retired, or too deep to project)`
          : "");
    }
  }

  function row(o) {
    const cls = ["trade-asset", o.cls || "", o.picked ? "picked" : ""]
      .filter(Boolean).join(" ");
    const chip = o.chip
      ? `<span class="pos-chip ${window.FC.POS_CLASS[o.chip] || ""}">${esc(o.chip)}</span> `
      : "";
    const attrs = o.clickable
      ? ` data-idx="${o.idx}" tabindex="0" role="button" aria-pressed="${o.picked}"`
      : ` aria-disabled="true"`;
    return `<li class="${cls}" data-kind="${o.kind}" data-id="${esc(o.id)}"${attrs}>`
      + `<span class="trade-asset-name">${chip}${esc(o.label)}</span>`
      + `<span class="trade-why">${esc(o.why)}</span></li>`;
  }

  function bindSide(ul, which) {
    const toggle = target => {
      const li = target.closest("li[data-idx]");
      if (!li || !sides) return;
      const side = sides[which];
      const i = Number(li.dataset.idx);
      if (side.picked.has(i)) side.picked.delete(i); else side.picked.add(i);
      li.classList.toggle("picked", side.picked.has(i));
      li.setAttribute("aria-pressed", String(side.picked.has(i)));
      renderGrade();
    };
    ul.addEventListener("click", e => toggle(e.target));
    ul.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle(e.target);
    });
  }

  const offerFrom = side => {
    const chosen = side.assets.filter((a, i) => side.picked.has(i));
    return { players: chosen.filter(a => !isPick(a)), picks: chosen.filter(isPick) };
  };
  const countOf = o => o.players.length + o.picks.length;
  const listOf = o => o.players.map(p => p.name)
    .concat(o.picks.map(assetLabel)).join(", ");

  // --- the three numbers -----------------------------------------------------

  function gainSpan(n, label) {
    const cls = n > 0 ? "trade-gain-pos" : n < 0 ? "trade-gain-neg" : "";
    const sign = n > 0 ? "+" : n < 0 ? "−" : "±";
    return `<span class="${cls}">${esc(label)} ${sign}${Math.abs(n).toFixed(1)} pts</span>`;
  }

  function marketPhrase(md) {
    if (Math.abs(md) < MARKET_EPS) return "market: even — they see these as equivalent";
    return md > 0
      ? `market: +${md.toFixed(1)} to them`
      : `market: ${Math.abs(md).toFixed(1)} short for them`;
  }

  function renderGrade() {
    const toThem = offerFrom(sides.mine), toMe = offerFrom(sides.theirs);
    els.grade.hidden = false;
    if (!countOf(toThem) && !countOf(toMe)) {
      els.grade.innerHTML = `<p class="draft-blocked">Click a row in either column to `
        + `build an offer. Every row is something that side actually holds; a dimmed `
        + `row is worth nothing to trade and says why.</p>`;
      return;
    }
    // ~0.4 s of maths per grade, measured in Chrome on the live board -- 0.67 s
    // for the first grade after a partner change, whose keeper memo is cold
    // (0.54 s / 0.86 s for the same two under node). The "~0.3s" this replaces
    // predates wave 2's exact keeper selection and was measured against the
    // delegating one. The picked highlight has not painted yet at this point,
    // so hand the frame back first.
    const seq = ++gradeSeq;
    els.grade.innerHTML = `<p class="draft-blocked">grading…</p>`;
    setTimeout(() => {
      if (seq !== gradeSeq) return;
      let g;
      try {
        g = Trade.gradeTrade({ me: me.state, them: partner.state },
                             { toMe, toThem }, world.ctx);
      } catch (e) {
        // Trade.applyTrade throws when a side is offered something it does not
        // hold. Both columns are built FROM those holdings, so this can only be
        // a bookkeeping bug in this file -- show it, and let it reach the
        // console too rather than dying quietly in a timer.
        els.grade.innerHTML = `<p class="draft-blocked">BUG — the offer named an `
          + `asset a side does not hold: ${esc(e.message)}</p>`;
        throw e;
      }
      const noAdp = toThem.players.concat(toMe.players)
        .filter(p => p.adp_round == null).length;
      const nPlayers = toThem.players.length + toMe.players.length;
      const bits = [];
      bits.push(`You give: ${countOf(toThem) ? esc(listOf(toThem)) : "nothing"}.`);
      bits.push(`You get: ${countOf(toMe) ? esc(listOf(toMe)) : "nothing"}.`);
      bits.push("Both gains are season points in that side's best STARTING LINEUP, "
        + "measured by playing the rest of the draft out from the post-trade roster "
        + "— keepers derived for both sides.");
      bits.push("Market is what the offer looks like on the numbers they will use; "
        + "positive means they receive more than they give, which is the offer they accept.");
      if (noAdp) {
        bits.push(`${noAdp} of the ${nPlayers} player(s) moved have no ADP, so their `
          + `market price comes from our board rank, not the market's.`);
      }
      if (Math.abs(g.myGain) < Trade.MIN_GAIN) {
        bits.push(`Your gain is under ${Trade.MIN_GAIN} pts — inside this model's own `
          + `noise, so treat it as no change.`);
      }
      // COMPARING two offers, not judging one. The bit above guards a single
      // verdict's MAGNITUDE (|myGain| < MIN_GAIN); it says nothing about the
      // DIFFERENCE between two offers, which is what you actually read when you
      // toggle an asset on and off. Those are not the same guard, and the gap
      // between them is reachable: adding an asset to a side can raise that
      // side's gain slightly, because `Optimizer.finishRoster`'s rollout is
      // greedy and two pick lists can interleave differently (trade.js documents
      // the cause and the sweeps). Every violation measured on this branch is
      // under MIN_GAIN -- worst +4.61 for future-pick removals, +1.82 across 552
      // live-board (offer, offer + one asset) pairs -- so MIN_GAIN is the honest
      // bar for a COMPARISON too, and it is the same one the suggester uses.
      // Unconditional: the reader needs it most when the number looks decisive.
      bits.push(`Comparing two offers: only a gap of ${Trade.MIN_GAIN} pts or more `
        + `is real. The draft is played out greedily, so adding an asset can move `
        + `a side's gain a little even when it should not — every case measured is `
        + `under ${Trade.MIN_GAIN} pts.`);
      els.grade.innerHTML =
        `<p class="trade-verdict"><strong>${gainSpan(g.myGain, "You gain")}</strong>`
        + ` · ${gainSpan(g.theirGain, "they gain")}`
        + ` · <span class="trade-market">${esc(marketPhrase(g.marketDelta))}</span></p>`
        + `<p class="draft-basis">${bits.join(" ")}</p>`;
    }, 0);
  }

  // --- the suggester ---------------------------------------------------------

  function staleSuggestions(why) {
    if (!lastSuggestions) return;
    lastSuggestions = null;
    els.suggestions.innerHTML = `<p class="draft-blocked">${esc(why)} — `
      + `press Suggest trades again to re-score.</p>`;
    els.suggestions.hidden = false;
  }

  // The run in flight, or null. `seq` is a generation token in the same shape
  // as loadSeq/gradeSeq: pressing Suggest again, changing partner or editing
  // the discount supersedes a run, and the superseded run's next turn simply
  // returns instead of writing into a panel that has moved on.
  let suggestSeq = 0, run = null;

  // Ends the run WITHOUT rendering: the button goes back to being pressable and
  // `run` stops existing, which is also what removes the progress line and the
  // Stop control from the next render.
  function endRun() {
    if (!run) return;
    els.suggest.disabled = false;
    els.suggest.textContent = run.label;
    run = null;
  }
  // Anything that invalidates the numbers a run is producing must supersede it,
  // or its next turn will score the OLD partner's candidates against the NEW
  // ctx and render the result as if it were current.
  function cancelSuggest() {
    if (!run) return;
    suggestSeq++;
    endRun();
  }

  function suggest() {
    if (!world || !partner) return;
    const seq = ++suggestSeq;
    endRun();
    run = { seq, label: els.suggest.textContent, cands: null, i: 0, stopped: false };
    els.suggest.disabled = true;
    els.suggest.textContent = "Searching…";
    lastSuggestions = [];
    setStatus(`searching for trades with ${partner.name}…`);
    els.suggestions.hidden = false;
    els.suggestions.innerHTML = `<p class="draft-blocked">Looking for the `
      + `1-for-1, 2-for-1 and 2-for-2 packages worth scoring with `
      + `${esc(partner.name)}. This first step values every player on both `
      + `rosters and cannot be interrupted — about ${PREFILTER_SECONDS} seconds, `
      + `and the page really is frozen for them. Scoring afterwards is not: `
      + `offers appear as they are found, and you can stop at any point.</p>`;
    // setTimeout so the disabled button, its label and that message actually
    // paint before the prefilter takes the thread.
    setTimeout(() => {
      if (!run || run.seq !== seq) return;
      try {
        run.cands = Trade.suggestCandidates(me.state, partner.state, world.ctx);
      } catch (e) { failRun(e); throw e; }
      renderSuggestions();
      step(seq);
    }, 0);
  }

  // ONE candidate per turn, and that is the largest honest batch rather than a
  // timid one: a single honest grade is ~0.45 s (measured 347-631 ms), so a
  // batch of two doubles the longest stretch the page is unavailable -- and
  // that stretch is already the whole budget. It is also the SMALLEST unit of
  // work that exists here: scoreCandidate cannot be subdivided
  // without changing what it computes. setTimeout(0) rather than a tighter
  // yield for the same reason: at that much work per turn the ~4 ms clamp is
  // noise, and it is the same scheduling primitive renderGrade already uses.
  function step(seq) {
    if (!run || run.seq !== seq) return;
    if (run.stopped || run.i >= run.cands.length) { finishRun(); return; }
    let s = null;
    try {
      s = Trade.scoreCandidate(me.state, partner.state, run.cands[run.i], world.ctx);
    } catch (e) { failRun(e); throw e; }
    run.i++;
    if (s) {
      lastSuggestions.push(Object.assign({ teamId: partner.rosterId }, s));
      // DEDUP HERE, ONCE, at the point an offer is accepted -- not at render
      // time. While the accumulator stayed raw and only the renderer deduped,
      // the panel printed two different counts for the same run: observed live
      // in Chrome, the status line said "40 offer(s) cleared both bars with
      // Team 3" over a list of 2 rows, because finishRun and progressText
      // counted the raw list while renderSuggestions and its empty-state branch
      // read the deduped one. This file's own doctrine is that nothing prints a
      // number the reader cannot check, and 40 was not checkable against
      // anything on screen. One list now, and every counter and the renderer
      // read it.
      //
      // Folding it in incrementally is exactly one-shot dedup of the full list:
      // dedupOffers keeps the best myGain per key (ties to the fewer-asset
      // offer), and a running maximum is the same maximum however it is
      // bracketed. So a later-arriving duplicate with a better myGain still
      // replaces the one already on screen, which is what the render-time
      // version existed to guarantee.
      //
      // The hide-generous toggle stays free: it filters this list at render
      // time and never needs the pre-dedup one.
      lastSuggestions = Trade.dedupOffers(lastSuggestions, world.ctx,
        { mine: me.state.picks,
          theirs: new Map([[partner.rosterId, partner.state.picks]]) });
      // Best-first at every moment, not only at the end -- the prefilter's
      // least-overpay-first order is NOT most-gain-first, so a late candidate
      // can outrank everything already on screen. Same comparator
      // Trade.suggestTrades finishes with.
      lastSuggestions.sort((a, b) => b.myGain - a.myGain);
      renderSuggestions();
    } else if (!renderProgress()) {
      // No new offer: update the counter in place, which leaves the Stop
      // button and any keyboard focus on it alone. Only if the line is not
      // there (the very first turn) does the whole panel get rebuilt.
      renderSuggestions();
    }
    setTimeout(() => step(seq), 0);
  }

  function failRun(e) {
    els.suggestions.innerHTML = `<p class="draft-blocked">search failed: ${esc(e.message)}</p>`;
    setStatus(`search failed: ${e.message}`);
    endRun();
  }

  function finishRun() {
    const stopped = run.stopped, scored = run.i, total = run.cands.length;
    endRun();                       // before the render, so no progress line
    renderSuggestions();
    setStatus(`${lastSuggestions.length} offer(s) cleared both bars with ${partner.name}`
      + (stopped ? ` — stopped after ${scored} of ${total} package(s)` : ""));
  }

  // Honest progress: what has actually been scored, out of a total that is
  // known exactly, and how many offers survived so far. Not a percentage of
  // anything, and not an ETA.
  const progressText = () => `scored ${run.i} of ${run.cands.length} package(s)`
    + ` · ${lastSuggestions.length} offer(s) so far`;

  function renderProgress() {
    const el = run && run.cands ? document.getElementById("trade-progress") : null;
    if (!el) return false;
    el.textContent = progressText();
    return true;
  }

  function renderSuggestions() {
    // ALREADY DEDUPED -- `step` collapses the accumulator as each offer is
    // accepted (see its comment), so this is the same list finishRun and
    // progressText count and there is exactly one number in play. This is
    // display-time collapsing of the SAME padded-duplicate shape trade.js's
    // suggestTrades dedups -- packages() pairs every real move with every
    // worthless pick that can ride along, and this panel is the thing that made
    // that visible (final-fixes-wave4.md): ten rows for one real offer. The
    // page does not know what a duplicate IS; it just calls Trade.dedupOffers.
    const raw = lastSuggestions || [];
    const hide = els.hideGenerous.checked;
    const shown = (hide ? raw.filter(s => !(s.theirGain > s.myGain)) : raw)
      .slice(0, SUGGEST_SHOW);
    const running = !!(run && run.cands);
    const head = running
      ? `<p class="draft-blocked"><span id="trade-progress">${esc(progressText())}</span>`
        + ` <button type="button" class="trade-stop">Stop</button></p>`
      : "";
    els.suggestions.hidden = false;
    if (!shown.length) {
      // An empty list must say WHICH bar nothing cleared, or it is
      // indistinguishable from a broken panel. While a run is still going,
      // "nothing cleared the bars" would be a claim about packages that have
      // not been scored yet, so it says what is actually true instead.
      const why = running
        ? `Nothing has cleared both bars yet — offers appear here as they are found.`
        : raw.length
        ? `All ${raw.length} offer(s) that work help ${esc(partner.name)} more than they `
          + `help you. Untick “hide trades that help them more” to see them — a trade `
          + `they gain more from is still one you gain from.`
        : `No package cleared both bars with ${esc(partner.name)}: at least `
          + `${Trade.MIN_GAIN} points of gain for you AND fair-or-better on their own `
          + `numbers. Only players who would gain you ${Trade.MIN_GAIN}+ points are `
          + `sought, only players you can spare are offered, and keeper-ineligible `
          + `players are excluded from both sides because they return to the draft `
          + `pool for everybody.`;
      els.suggestions.innerHTML = head + `<p class="draft-blocked">${why}</p>`;
      bindSuggestionButtons(shown);
      return;
    }
    els.suggestions.innerHTML = head
      + `<strong>Best offers to ${esc(partner.name)}</strong>`
      + `<ol class="trade-suggestions">`
      + shown.map((s, i) => {
        const give = listOf(s.toThem) || "nothing";
        const get = listOf(s.toMe) || "nothing";
        return `<li><span class="trade-offer">give <strong>${esc(give)}</strong>`
          + ` → get <strong>${esc(get)}</strong></span>`
          + `<span class="trade-nums">${gainSpan(s.myGain, "you")}`
          + ` · ${gainSpan(s.theirGain, "them")}`
          + ` · ${esc(marketPhrase(s.marketDelta))}</span>`
          + `<button type="button" class="trade-load" data-i="${i}">load into the columns</button></li>`;
      }).join("")
      + `</ol><p class="draft-basis">Scored against ${esc(partner.name)} only — the `
      + `search is quadratic in assets per side, so all eleven opponents at once takes `
      + `about four minutes. Pick another team above and search again.</p>`;
    bindSuggestionButtons(shown);
  }

  function bindSuggestionButtons(shown) {
    const stop = els.suggestions.querySelector(".trade-stop");
    // Stop ENDS the scoring and keeps what was found: the flag is read at the
    // top of the next turn, so the grade already in flight finishes rather
    // than being thrown away half-computed.
    if (stop) stop.addEventListener("click", () => { if (run) run.stopped = true; });
    els.suggestions.querySelectorAll(".trade-load").forEach(b => {
      b.addEventListener("click", () => loadOffer(shown[Number(b.dataset.i)]));
    });
  }

  // Put a suggestion back into the two columns, so its three numbers can be
  // checked against the grader instead of taken on trust. Refuses loudly rather
  // than loading half an offer.
  function loadOffer(s) {
    const select = (side, offer) => {
      const wanted = (offer.players || []).concat(offer.picks || []);
      const picked = new Set();
      for (const a of wanted) {
        const i = side.assets.findIndex((c, j) => !picked.has(j)
          && isPick(c) === isPick(a)
          && (isPick(a) ? (c.season === a.season && c.round === a.round)
                        : c.player_id === a.player_id));
        if (i === -1) return null;
        picked.add(i);
      }
      return picked;
    };
    const mine = select(sides.mine, s.toThem), theirs = select(sides.theirs, s.toMe);
    if (!mine || !theirs) {
      setNote("couldn't load that offer — it names an asset that is no longer in the columns");
      return;
    }
    sides.mine.picked = mine;
    sides.theirs.picked = theirs;
    drawSide(sides.mine);
    drawSide(sides.theirs);
    renderGrade();
  }

  function init(options) {
    cfg = options;
    els = cfg.els;
    els.load.addEventListener("click", load);
    els.user.addEventListener("keydown", e => { if (e.key === "Enter") load(); });
    els.partner.addEventListener("change", onPartnerChange);
    // `change`, not `input`: each re-grade is ~0.4 s of maths on the main thread
    // (measured; the same stale "~0.3s" renderGrade carried), and a re-grade
    // per keystroke would make the field unusable.
    els.discount.addEventListener("change", onDiscount);
    els.hideGenerous.addEventListener("change", () => { if (lastSuggestions) renderSuggestions(); });
    els.suggest.addEventListener("click", suggest);
    bindSide(els.mine, "mine");
    bindSide(els.theirs, "theirs");
  }

  return { init, leagueWorld, keptElsewhere, teamName,
           PICK_SEASONS_AHEAD, SUGGEST_SHOW, MARKET_EPS };
});
