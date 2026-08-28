/* Draft mode — live Sleeper draft overlay. Read-only public API
   (api.sleeper.app), no auth, no backend. Strictly additive: every failure
   here degrades the panel, never the board. */
window.DraftMode = (() => {
  const Sleeper = (typeof window !== "undefined" && window.Sleeper)
    ? window.Sleeper
    : (typeof require !== "undefined" ? require("./sleeper.js") : null);
  const STORE_KEY = "fc-draft-mode";
  const POLL_MS = 3000, MAX_BACKOFF_MS = 30000;
  // Four missed polls. Past this the board may be behind the draft, and on
  // draft day a board you cannot trust is worse than one that admits it.
  const STALE_AFTER_S = 12;
  // Season-point spread across the whole shortlist below which the optimizer
  // is telling you it cannot separate these players. One point over 18 weeks
  // is far inside the model's own error, so presenting an order as a
  // recommendation there would be false precision.
  const INDIFFERENT_POINTS = 1.0;

  let cfg = null;       // {board, els, onUpdate}
  let session = null;   // {username, userId, draftId, totalPicks}
  let timer = null, backoff = POLL_MS;
  let pollSeq = 0;       // generation token: bumped to silently retire stale poll chains
  let lastPickCount = -1;   // render guard: picks are append-only
  let statusChecks = 0;     // draft-complete fallback when settings lack rounds/teams
  // Freshness, shown in the status line. A tool that says "live" has to be able
  // to prove it: this ticks on its own clock, so if the poll chain dies the age
  // keeps climbing on screen instead of the label sitting at "live" forever.
  let lastSyncAt = 0, syncNote = "", heartbeat = null;
  const state = { connected: false, drafted: new Set(), mine: new Set(),
                  hideDrafted: false };

  // `fresh` is now the only mode -- see sleeper.js for why both defences are
  // required. The parameter is kept at the call sites' existing arity.
  const api = path => Sleeper.get(path);

  function emit() { cfg.onUpdate(state); }

  // What the status line says, given a clock. Pure so the staleness threshold
  // is pinned by a test rather than eyeballed on a live draft.
  function syncLabel(nowMs, syncedAt, note) {
    if (!syncedAt) return note || "connecting…";
    const age = Math.max(0, Math.round((nowMs - syncedAt) / 1000));
    const ago = `${age}s ago`;
    if (note) return `${note} · last synced ${ago}`;
    return age >= STALE_AFTER_S ? `NOT UPDATING — last synced ${ago}`
                                : `live · synced ${ago}`;
  }

  function renderStatus() {
    if (session) setStatus(syncLabel(Date.now(), lastSyncAt, syncNote));
  }

  function startHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = setInterval(renderStatus, 1000);
  }
  // DOM fallback: disable(reason) runs BEFORE init in the no-crosswalk case,
  // when cfg is still null.
  function setStatus(text) {
    const el = (cfg && cfg.els.status) || document.getElementById("draft-status");
    if (el) el.textContent = text;
  }

  async function findDrafts() {
    const username = cfg.els.username.value.trim();
    if (!username) { setStatus("enter a username"); return; }
    try {
      setStatus("looking up user…");
      const user = await api(`/user/${encodeURIComponent(username)}`);
      if (!user || !user.user_id) throw new Error("user not found");
      const drafts = await api(`/user/${user.user_id}/drafts/nfl/${cfg.board.season}`) || [];
      if (!drafts.length) {
        setStatus(`no ${cfg.board.season} drafts for ${username} — paste a draft id instead`);
        return;
      }
      cfg.els.list.innerHTML = "";
      for (const d of drafts) {
        const b = document.createElement("button");
        const when = d.start_time ? new Date(d.start_time).toLocaleDateString() : "unscheduled";
        b.textContent = `${d.metadata && d.metadata.name || d.type} · ${d.status} · ${when}`;
        b.addEventListener("click", () => connect(username, user.user_id, d.draft_id));
        cfg.els.list.appendChild(b);
      }
      setStatus(`${drafts.length} draft(s) — pick one`);
    } catch (e) { setStatus(`lookup failed: ${e.message}`); }
  }

  async function connectById() {
    const raw = cfg.els.idInput.value.trim();
    const m = raw.match(/(\d{6,})/);          // raw id or any sleeper.com draft URL
    if (!m) { setStatus("that doesn't look like a draft id"); return; }
    // Username optional here — without it, picks still strike but none are "yours".
    let userId = null;
    const username = cfg.els.username.value.trim();
    if (username) {
      try {
        const user = await api(`/user/${encodeURIComponent(username)}`);
        userId = user && user.user_id || null;
      } catch (e) { /* non-fatal: connect without highlight */ }
    }
    connect(username || null, userId, m[1]);
  }

  async function connect(username, userId, draftId) {
    try {
      setStatus("connecting…");
      const draft = await api(`/draft/${draftId}`);
      if (!draft || !draft.draft_id) throw new Error("draft not found");
      const s = draft.settings || {};
      const order = draft.draft_order || {};
      session = { username, userId, draftId,
                  totalPicks: (s.rounds || 0) * (s.teams || 0),
                  slot: (userId && order[userId]) || null,
                  teams: s.teams || 0, rounds: s.rounds || 0,
                  reversalRound: s.reversal_round || 0,
                  type: draft.type || "snake" };
      lastPickCount = -1;
      statusChecks = 0;
      lastSyncAt = 0;
      syncNote = "";
      startHeartbeat();
      localStorage.setItem(STORE_KEY, JSON.stringify({ username, userId, draftId }));
      state.connected = true;
      if (username) cfg.els.username.value = username;   // survives a reload
      // Keep the connect row up when we don't know WHO you are — the shortlist
      // is blocked until you supply a username, and mid-draft is the wrong
      // moment to make someone disconnect first to fix that. The draft id is
      // still in its box, so typing a name and hitting Connect resolves it.
      cfg.els.connect.hidden = !!userId;
      cfg.els.list.innerHTML = "";
      cfg.els.live.hidden = false;
      unmatchedNote();
      startPolling();
    } catch (e) { setStatus(`connect failed: ${e.message}`); }
  }

  function disconnect() {
    pollSeq++;             // retire any in-flight/pending chain before it can touch state
    clearTimeout(timer);
    clearInterval(heartbeat);
    heartbeat = null;
    localStorage.removeItem(STORE_KEY);
    session = null;
    state.connected = false;
    state.drafted = new Set();
    state.mine = new Set();
    cfg.els.connect.hidden = false;
    cfg.els.live.hidden = true;
    cfg.els.roster.hidden = true;
    cfg.els.ticker.hidden = true;
    cfg.els.shortlist.hidden = true;
    if (cfg.els.late) cfg.els.late.hidden = true;   // else a stale K/DST banner survives
    cfg.els.note.hidden = true;
    cfg.els.hide.checked = false;
    state.hideDrafted = false;
    lastPickCount = -1;
    statusChecks = 0;
    lastSyncAt = 0;
    syncNote = "";
    setStatus("— off");
    emit();
  }

  // The only entry point for beginning a poll chain. Bumping pollSeq here
  // supersedes any older chain — its next bail check will see a stale seq
  // and quietly stop, so at most one chain is ever alive.
  function startPolling() {
    const seq = ++pollSeq;
    clearTimeout(timer);
    pollOnce(seq);
  }

  async function pollOnce(seq) {
    if (seq !== pollSeq || !session) return;
    // NO document.hidden skip. During a real draft this tab is ALWAYS the
    // background one -- you pick on Sleeper and glance here -- so skipping the
    // fetch while hidden froze the board at whatever was struck when you left
    // it, under a status still reading "connected — live". Chrome throttles
    // background timers on its own, and visibilitychange forces a fresh poll
    // the instant you come back, so polling here costs little and the board is
    // current when you look at it.
    try {
      const picks = await api(`/draft/${session.draftId}/picks`) || [];
      if (seq !== pollSeq || !session) return;
      backoff = POLL_MS;
      lastSyncAt = Date.now();
      syncNote = "";
      if (picks.length !== lastPickCount) {
        applyPicks(picks);                    // render guard: append-only picks
      }
      if (!session.totalPicks && ++statusChecks % 10 === 0) {
        // Sleeper omitted settings.rounds/teams: fall back to re-checking
        // the draft object's status every 10th poll so completion still stops us.
        const d = await api(`/draft/${session.draftId}`);
        if (seq !== pollSeq || !session) return;
        if (d && d.status === "complete") return finish(picks.length);
      }
      if (session.totalPicks && picks.length >= session.totalPicks) {
        return finish(picks.length);              // stop polling
      }
      timer = setTimeout(() => pollOnce(seq), POLL_MS);
    } catch (e) {
      if (seq !== pollSeq || !session) return;
      syncNote = `reconnecting… (${e.message})`;
      renderStatus();
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      timer = setTimeout(() => pollOnce(seq), backoff);
    }
  }

  // Draft over: stop the chain AND the heartbeat, so the line settles on a
  // final statement instead of counting up a staleness that no longer means
  // anything.
  function finish(n) {
    clearInterval(heartbeat);
    heartbeat = null;
    setStatus(`draft complete — ${n} picks`);
  }

  /* YOUR picks. `picked_by` is EMPTY on anything the autodrafter took -- 145
     of the 158 non-keeper picks in a measured mock of this league -- so keying
     off it silently drops every player the clock took for you. The tool then
     believes you do not hold him and goes on recommending the slot he already
     fills, which is the wrong advice at the worst possible moment: you are
     away from the keyboard, which is why autodraft fired at all.

     Your SEAT is the durable identity. It comes from the draft's own
     draft_order, and every pick carries draft_slot whether a human or the
     autodrafter made it. picked_by stays as the fallback for a draft that
     publishes no order -- some mocks -- where it is the only signal there is.

     Pure and exported so the autodraft case is testable; the render path
     around it needs a DOM and a live session. */
  function myPicks(picks, slot, userId) {
    const list = Array.isArray(picks) ? picks : [];
    if (Number.isInteger(slot) && slot > 0) {
      return list.filter(p => p && p.draft_slot === slot);
    }
    if (!userId) return [];
    return list.filter(p => p && p.picked_by === userId);
  }

  /* Everything the panel needs about who holds what, from the pick log alone.
     Pure for the same reason planFromPicks is: applyPicks writes to the DOM,
     so anything left inside it is unreachable from a test -- and that is
     exactly where the picked_by bug sat, unnoticed. */
  function rosterStateFromPicks(picks, slot, userId) {
    const list = Array.isArray(picks) ? picks : [];
    const mine = myPicks(list, slot, userId);
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0, other: 0 };
    for (const p of mine) {
      const pos = p.metadata && p.metadata.position;
      if (counts[pos] !== undefined) counts[pos]++; else counts.other++;
    }
    return { drafted: new Set(list.map(p => String(p.player_id))),
             mine: new Set(mine.map(p => String(p.player_id))),
             counts, myPickCount: mine.length };
  }

  function applyPicks(picks) {
    lastPickCount = picks.length;
    const rs = rosterStateFromPicks(picks, mySeat(picks).slot, session.userId);
    state.drafted = rs.drafted;
    state.mine = rs.mine;
    cfg.els.picksCount.textContent = `${picks.length} picks in`;
    if (session.userId) {
      const counts = rs.counts;
      cfg.els.roster.hidden = false;
      // Counts say what you hold; the panel's picks say what a player would
      // fill. Neither says what is still EMPTY, which is the thing you act on.
      const open = window.Optimizer ? window.Optimizer.openSlots(myBoardPlayers()) : [];
      const held =
        `Your roster: QB ${counts.QB} · RB ${counts.RB} · WR ${counts.WR} · TE ${counts.TE}`
        + (counts.other ? ` · +${counts.other} other` : "");
      cfg.els.roster.innerHTML = esc(held) + (open.length
        ? ` · <span class="roster-open">still need ${esc(open.join(", "))}</span>`
        : ` · <span class="roster-set">starters set</span>`);
    }
    updateAids(picks);
    renderStatus();
    emit();
  }

  const esc = s => String(s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // My drafted board rows (for roster counts + bye stacking). Players with no
  // board entry (K/DST/retired) simply do not contribute.
  function myBoardPlayers() {
    const rows = [];
    for (const p of cfg.board.players) {
      if (p.sleeper_id && state.mine.has(p.sleeper_id)) rows.push(p);
    }
    return rows;
  }

  function updateAids(picks) {
    const t = cfg.els.ticker, v = cfg.els.shortlist, l = cfg.els.late;
    if (picks.length) {
      const recent = picks.slice(-3).map(p => {
        const m = p.metadata || {};
        const name = [m.first_name, m.last_name].filter(Boolean).join(" ")
                     || m.position || "?";
        return `#${p.pick_no} ${name}`;
      });
      t.textContent = "Recent: " + recent.join(" · ");
      t.hidden = false;
    } else {
      t.hidden = true;
    }
    v.hidden = true;                    // default: render nothing, never wrong math
    if (l) l.hidden = true;
    if (!window.Optimizer || !session) return;
    // Everything below needs to know WHICH SEAT IS YOURS. When we can't work
    // that out, say so in the panel: rendering nothing under a status reading
    // "connected — live" looks identical to the tool having no opinion, and
    // that silence is what a mock draft actually produced.
    const seat = mySeat(picks);
    const blocked = shortlistBlocker(seat, picks);
    if (blocked) { showBlocked(v, blocked); return; }
    const plan = planFromPicks(picks, seat, session.type);
    if (plan === null) {
      showBlocked(v, "No pick left in this draft — the shortlist is done.");
      return;
    }
    const next = plan.next, until = plan.until;
    const mine = myBoardPlayers();
    const available = boardPlayers().filter(
      p => !(p.sleeper_id && state.drafted.has(p.sleeper_id)));
    const shortlist = window.Optimizer.recommend({
      available, myPlayers: mine, pickNo: next,
      futurePicks: plan.future,
      // Without this the model counts every keeper slot between your turns as
      // a live selection -- 22 phantom picks in this league -- and believes
      // the board empties faster than it does.
      usedPicks: plan.used,
    });
    if (!shortlist.length) {
      showBlocked(v, "Every player this board projects is gone — you're into "
        + "K/DST and deep bench, which v1 doesn't model.");
      return;
    }
    const head = until <= 0
      ? `ON THE CLOCK · pick #${next}`
      : `pick #${next} · your turn in ${until + 1}`;
    // When no candidate changes the projected lineup -- typical once your
    // starters are set -- say so rather than dressing a rounding difference up
    // as a recommendation. The order below it is then just best-available.
    const flat = shortlist[shortlist.length - 1].cost < INDIFFERENT_POINTS;
    // The K/DST need goes ABOVE the recommendations, not beside them.
    const lateNeed = lateSlotNeed(picks, seat.slot, session.rounds,
                                  session.userId, cfg.board.late_slots);
    v.innerHTML = (lateNeed ? renderLateNeed(lateNeed) : "")
      + `<strong>${esc(head)}</strong>`
      + `<ol class="draft-shortlist">${shortlist.map(renderPick).join("")}</ol>`
      + (flat
        ? `<p class="draft-basis"><em>These all project the same lineup.</em> Your `
          + `starters are set, so none of them changes your season total — take `
          + `whoever you like best; they are listed by value over replacement.</p>`
        : `<p class="draft-basis">Every number here is season points in your best `
          + `STARTING LINEUP, if you take him and draft on from here with the field `
          + `going by ADP. <em>−n</em> is what he gives up against the top pick; `
          + `<em>wait →</em> is what you lose by passing and settling for the next `
          + `man at his position.</p>`);
    v.hidden = false;
    renderLateSlots(picks, l);
  }

  // One shortlist entry. Every number shown is one the optimizer actually
  // used -- the panel exists so a recommendation can be checked, not trusted
  // blind.
  function renderPick(r, i) {
    const p = r.player;
    const bits = [];
    if (r.nextBest) {
      // The wait question, answered by name: who is left at his position if
      // you pass. A negative cost means someone BETTER is projected to last.
      const drop = r.waitCost;
      bits.push(drop > 0
        ? `wait → ${esc(r.nextBest.name)} (−${drop.toFixed(0)} pts)`
        : `wait → ${esc(r.nextBest.name)} (no loss)`);
    }
    if (Number.isFinite(r.adpDelta) && Math.abs(r.adpDelta) >= 6) {
      bits.push(r.adpDelta > 0
        ? `<span class="pick-fell">fell ${Math.round(r.adpDelta)} past ADP</span>`
        : `<span class="pick-reach">reach ${Math.round(-r.adpDelta)} early</span>`);
    }
    // One shared bye is normal and not worth a warning; two or more of your
    // own players out in the same week is a hole you will have to cover.
    if (r.byeClash >= 2) {
      bits.push(`<span class="pick-bye">bye ${esc(String(p.bye))} — `
        + `${r.byeClash} of yours are out that week</span>`);
    }
    // the league's own lens, so floor/ceiling read in the points you actually score
    const band = p.season_points && (p.season_points.league || p.season_points.ppr);
    if (band && Number.isFinite(band.p10) && Number.isFinite(band.p90)) {
      bits.push(`floor ${Math.round(band.p10)} · ceiling ${Math.round(band.p90)}`);
    }
    return `<li class="pick${i === 0 ? " pick-top" : ""}">`
      + `<span class="pos-chip pos-${esc(p.position.toLowerCase())}">${esc(p.position)}</span>`
      + `<span class="pick-name">${esc(p.name)}</span>`
      + `<span class="pick-cost">${i === 0 ? "best"
          : r.cost < INDIFFERENT_POINTS ? "same" : "−" + r.cost.toFixed(1)}</span>`
      + `<span class="pick-why"><span class="pick-role">${esc(String(r.role))}</span>`
      + `<span class="pick-notes">${bits.join(" · ")}</span></span></li>`;
  }

  // Board rows the optimizer can score, with `value_points` filled in when the
  // published payload predates that field.
  let _scored = null;
  function boardPlayers() {
    if (!_scored) {
      _scored = window.Optimizer.withValuePoints(cfg.board.players)
        .filter(p => Number.isFinite(window.Optimizer.seasonValue(p)));
    }
    return _scored;
  }

  /* Everything the shortlist is computed FOR, derived from the pick log alone.
     Pure and exported so the keeper arithmetic is testable: the render path
     around it needs a DOM and a live session, which is exactly why the bug
     this replaces went unnoticed. Returns null when the seat has no pick left.

       cursor  how far the draft has got (see pickCursor)
       next    your next pick number, skipping picks spent on your keepers
       until   selections that must happen before it
       future  your remaining picks after that one */
  function planFromPicks(picks, seat, type) {
    const used = usedPickNumbers(picks);
    const cursor = pickCursor(picks);
    const next = nextPickNumber(seat.slot, seat.teams, seat.rounds,
                                seat.reversalRound, cursor, type, used);
    if (next === null) return null;
    const future = [];
    for (let at = next; ; ) {
      const nxt = nextPickNumber(seat.slot, seat.teams, seat.rounds,
                                 seat.reversalRound, at, type, used);
      if (nxt === null) break;
      future.push(nxt); at = nxt;
    }
    return { used, cursor, next, until: openPicksBetween(cursor, next, used), future };
  }

  // Your seat, from the draft object where it publishes one and from the pick
  // log where it doesn't. Mock drafts have no league behind them, so
  // `draft_order` can be absent — but every pick carries `draft_slot`, so once
  // you have made a single pick your seat is knowable regardless.
  function mySeat(picks) {
    const slot = session.slot
      || seatFromPicks(picks, session.userId);
    return { slot, teams: session.teams, rounds: session.rounds,
             reversalRound: session.reversalRound, userId: session.userId };
  }

  function showBlocked(v, why) {
    v.innerHTML = `<p class="draft-blocked">${esc(why)}</p>`;
    v.hidden = false;
  }

  /* Which mandatory starting slots are still empty with the picks to fill them
     running out, or null. Pure and exported: this used to live inside the
     renderer, where it could not be tested, and the banner it produced was
     drafted straight past in two consecutive mock drafts -- both ending with
     15 skill players, no kicker and no defense. The board cannot help here by
     design (it models QB/RB/WR/TE only), so this is the ONLY thing standing
     between "take the top recommendation every time" and two empty starting
     slots for the season. */
  function lateSlotNeed(picks, slot, rounds, userId, lateSlots) {
    if (!Number.isFinite(rounds) || !window.Optimizer) return null;
    const mine = myPicks(picks, slot, userId);
    const has = pos => mine.some(p => p.metadata && p.metadata.position === pos);
    const haveK = has("K"), haveDst = has("DEF");
    const roundsLeft = rounds - mine.length;
    if (!window.Optimizer.lateSlotTrigger(roundsLeft, haveK, haveDst)) return null;
    const late = lateSlots || {};
    const names = key => ((late[key] || []).slice(0, 3)
      .map(r => r && r.name).filter(Boolean));
    return {
      need: [!haveK ? "K" : null, !haveDst ? "D/ST" : null].filter(Boolean),
      roundsLeft,
      K: haveK ? [] : names("K"),
      DST: haveDst ? [] : names("DST"),
    };
  }

  // The same need, said where it cannot be missed: at the TOP of the shortlist.
  // A notice beside the list is not enough when the workflow is "read the list,
  // take number one" -- that is exactly how both mocks ended without a kicker.
  function renderLateNeed(need) {
    const lists = [need.K.length ? `K: ${need.K.map(esc).join(" · ")}` : null,
                   need.DST.length ? `D/ST: ${need.DST.map(esc).join(" · ")}` : null]
      .filter(Boolean).join(" &nbsp;·&nbsp; ");
    const slots = need.need.length > 1 ? "slots" : "slot";
    const picks = need.roundsLeft === 1 ? "pick" : "picks";
    return `<p class="draft-late-need">⚠ <strong>Draft ${esc(need.need.join(" + "))} `
      + `now</strong> — ${need.need.length} required starting ${slots} still empty `
      + `with ${need.roundsLeft} ${picks} left. <strong>The list below cannot `
      + `suggest them</strong>: this board does not project K or D/ST.`
      + (lists ? `<br><span class="draft-late-names">${lists} <em>— by ADP, not `
                 + `projected</em></span>` : "")
      + `</p>`;
  }

  function renderLateSlots(picks, l) {
    if (!l || !session || !session.rounds) return;
    const need = lateSlotNeed(picks, mySeat(picks).slot, session.rounds,
                              session.userId, cfg.board.late_slots);
    if (!need) return;
    const lists = [need.K.length ? `K: ${need.K.map(esc).join(" · ")}` : null,
                   need.DST.length ? `D/ST: ${need.DST.map(esc).join(" · ")}` : null]
      .filter(Boolean).join(" | ");
    l.innerHTML = `⚠ fill ${esc(need.need.join(" + "))} — ${need.roundsLeft} `
      + `pick${need.roundsLeft === 1 ? "" : "s"} left`
      + (lists ? ` · ${lists} <em>(not projected)</em>` : "");
    l.hidden = false;
  }

  function unmatchedNote() {
    const cw = cfg.board.crosswalk;
    if (cw && cw.unmatched > 0) {
      cfg.els.note.hidden = false;
      cfg.els.note.textContent =
        `heads up: ${cw.unmatched} board player(s) have no Sleeper mapping and will never strike`;
    }
  }

  // --- pure draft math (exported for fixture verification) -----------------

  // Which seat is `userId` sitting in, read off the picks they have already
  // made. Sleeper stamps every pick with its `draft_slot`, so this works on
  // drafts that publish no `draft_order` at all (mocks). null until they pick.
  function seatFromPicks(picks, userId) {
    if (!userId || !Array.isArray(picks)) return null;
    for (const p of picks) {
      if (p && p.picked_by === userId && Number.isInteger(p.draft_slot)
          && p.draft_slot > 0) return p.draft_slot;
    }
    return null;
  }

  // Why the shortlist cannot be computed, in the drafter's own terms — or null
  // when nothing is in the way. Each branch names the ONE thing that would
  // unblock it, because a panel that just goes quiet is indistinguishable from
  // a panel with no opinion.
  function shortlistBlocker(seat, picks) {
    if (!seat.userId) {
      return "Enter your Sleeper username above and reconnect — without it the "
        + "board can't tell which seat is yours, and the shortlist is entirely "
        + "about what falls to YOUR next pick. Picks still strike either way.";
    }
    if (!seat.slot) {
      return picks && picks.length
        ? "This draft doesn't publish a draft order, so your seat isn't known "
          + "yet — the shortlist appears as soon as you make your first pick."
        : "Waiting on the first pick to work out your seat — this draft "
          + "doesn't publish a draft order.";
    }
    if (!seat.teams || !seat.rounds) {
      return "This draft doesn't report its size (teams / rounds), so the board "
        + "can't work out when your next pick comes round.";
    }
    return null;
  }

  function pickForRoundSlot(r, slot, teams, reversalRound, type) {
    if (type === "linear") return (r - 1) * teams + slot;
    // Snake; Sleeper third-round-reversal flips direction parity from
    // reversalRound on (round 3 repeats round 2's direction, etc).
    let reversed = r % 2 === 0;
    if (reversalRound && r >= reversalRound) reversed = !reversed;
    return reversed ? r * teams - slot + 1 : (r - 1) * teams + slot;
  }

  /* HOW FAR THE DRAFT HAS ACTUALLY GOT, which is not how many rows the pick
     log has. A keeper league loads its keepers as picks BEFORE the draft
     opens, each one sitting at the pick number it cost -- in this league
     picks 40, 42, 53 ... 142, never 1, 2, 3. So `picks.length` was 22 while
     picks 1-39 had not happened, and feeding that to nextPickNumber reported
     seat 10's next pick as #34 when it was #10: two rounds of shortlist
     computed against the wrong pick number, and therefore against the wrong
     replacement-level horizon. The error is largest at the open and only
     closes by the final round -- backwards, since the early picks decide the
     draft.

     Counting pick NUMBERS consumed from 1 upward is right in both worlds: with
     no keepers the used set is exactly {1..n} and this returns n, identical to
     the old picks.length. A keeper sitting at an early number counts as
     consumed, because it is -- nobody selects there. */
  function usedPickNumbers(picks) {
    const used = new Set();
    for (const p of picks || []) {
      if (p && Number.isInteger(p.pick_no) && p.pick_no > 0) used.add(p.pick_no);
    }
    return used;
  }

  function pickCursor(picks) {
    const used = usedPickNumbers(picks);
    let made = 0;
    while (used.has(made + 1)) made++;
    return made;
  }

  // Selections that still have to happen between the pick on the clock and
  // yours. Lives in optimizer.js because the model asks the same question
  // when it works out who survives to your next turn; two implementations
  // could drift apart and the panel would then contradict the shortlist.
  const openPicksBetween = (from, to, used) =>
    window.Optimizer.openPicksBetween(from, to, used);

  /* `used` also has to gate the SEARCH, not just the count. Your own keepers
     occupy picks you no longer own -- slot 10 keeps at #87 and #135 -- and
     without this the rollout plans two selections that will never come round,
     so the optimizer believes it gets more board than it will. Same defect
     tools/draft_sim.cjs had before it was made keeper-aware. */
  function nextPickNumber(slot, teams, rounds, reversalRound, picksMade,
                          type = "snake", used = null) {
    if (!Number.isInteger(slot) || !Number.isInteger(teams) || !Number.isInteger(rounds)
        || slot < 1 || teams < 1 || rounds < 1 || slot > teams
        || !Number.isInteger(picksMade) || picksMade < 0
        || !Number.isInteger(reversalRound || 0) || (reversalRound || 0) < 0) return null;
    if (type !== "snake" && type !== "linear") return null;
    for (let r = 1; r <= rounds; r++) {
      const p = pickForRoundSlot(r, slot, teams, reversalRound || 0, type);
      if (p > picksMade && !(used && used.has(p))) return p;
    }
    return null;                       // this slot has no pick left
  }

  // Picks between the selection currently on the clock and your NEXT pick.
  // This is the window other drafters get before you choose again -- the
  // horizon the optimizer's replacement level is measured over. It is nonzero
  // when you are on the clock, which is exactly when it drives the decision.
  function gapToNextPick(slot, teams, rounds, reversalRound, picksMade,
                         type = "snake", used = null) {
    const current = nextPickNumber(slot, teams, rounds, reversalRound, picksMade,
                                   type, used);
    if (current === null) return null;
    const after = nextPickNumber(slot, teams, rounds, reversalRound, current,
                                 type, used);
    if (after === null) return null;
    return openPicksBetween(current, after, used);
  }

  function init(options) {
    cfg = options;
    cfg.els.find.addEventListener("click", findDrafts);
    cfg.els.username.addEventListener("keydown", e => { if (e.key === "Enter") findDrafts(); });
    cfg.els.connectId.addEventListener("click", connectById);
    cfg.els.idInput.addEventListener("keydown", e => { if (e.key === "Enter") connectById(); });
    cfg.els.disconnect.addEventListener("click", disconnect);
    cfg.els.hide.addEventListener("change", () => {
      state.hideDrafted = cfg.els.hide.checked;
      emit();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && session) startPolling();  // supersedes any pending chain
    });
    const stored = localStorage.getItem(STORE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed && parsed.draftId) {
          document.getElementById("draft-panel").open = true;
          connect(parsed.username, parsed.userId, parsed.draftId);
        } else {
          localStorage.removeItem(STORE_KEY);   // incomplete blob: clear, don't 404
        }
      } catch (e) { localStorage.removeItem(STORE_KEY); }
    }
  }

  function disable(reason) {
    // Called INSTEAD of init when the board payload has no crosswalk
    // (cfg is null here — setStatus falls back to the DOM).
    setStatus(reason);
    const body = document.querySelector("#draft-panel .draft-body");
    if (body) body.querySelectorAll("input, button").forEach(el => { el.disabled = true; });
  }

  return { init, disable, nextPickNumber, gapToNextPick, seatFromPicks,
           pickCursor, usedPickNumbers, planFromPicks, myPicks,
           lateSlotNeed,
           rosterStateFromPicks,
           shortlistBlocker, syncLabel };
})();
