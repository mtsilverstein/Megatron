/* Draft mode — live Sleeper draft overlay. Read-only public API
   (api.sleeper.app), no auth, no backend. Strictly additive: every failure
   here degrades the panel, never the board. */
window.DraftMode = (() => {
  const API = "https://api.sleeper.app/v1";
  const STORE_KEY = "fc-draft-mode";
  const POLL_MS = 3000, MAX_BACKOFF_MS = 30000;

  let cfg = null;       // {board, els, onUpdate}
  let session = null;   // {username, userId, draftId, totalPicks}
  let timer = null, backoff = POLL_MS;
  let pollSeq = 0;       // generation token: bumped to silently retire stale poll chains
  let lastPickCount = -1;   // render guard: picks are append-only
  let statusChecks = 0;     // draft-complete fallback when settings lack rounds/teams
  const state = { connected: false, drafted: new Set(), mine: new Set(),
                  hideDrafted: false };

  async function api(path) {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function emit() { cfg.onUpdate(state); }
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
      localStorage.setItem(STORE_KEY, JSON.stringify({ username, userId, draftId }));
      state.connected = true;
      cfg.els.connect.hidden = true;
      cfg.els.list.innerHTML = "";
      cfg.els.live.hidden = false;
      unmatchedNote();
      startPolling();
    } catch (e) { setStatus(`connect failed: ${e.message}`); }
  }

  function disconnect() {
    pollSeq++;             // retire any in-flight/pending chain before it can touch state
    clearTimeout(timer);
    localStorage.removeItem(STORE_KEY);
    session = null;
    state.connected = false;
    state.drafted = new Set();
    state.mine = new Set();
    cfg.els.connect.hidden = false;
    cfg.els.live.hidden = true;
    cfg.els.roster.hidden = true;
    cfg.els.ticker.hidden = true;
    cfg.els.vona.hidden = true;
    cfg.els.note.hidden = true;
    cfg.els.hide.checked = false;
    state.hideDrafted = false;
    lastPickCount = -1;
    statusChecks = 0;
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
    if (document.hidden) { timer = setTimeout(() => pollOnce(seq), POLL_MS); return; }
    try {
      const picks = await api(`/draft/${session.draftId}/picks`) || [];
      if (seq !== pollSeq || !session) return;
      backoff = POLL_MS;
      if (picks.length !== lastPickCount) {
        applyPicks(picks);                    // render guard: append-only picks
      }
      if (!session.totalPicks && ++statusChecks % 10 === 0) {
        // Sleeper omitted settings.rounds/teams: fall back to re-checking
        // the draft object's status every 10th poll so completion still stops us.
        const d = await api(`/draft/${session.draftId}`);
        if (seq !== pollSeq || !session) return;
        if (d && d.status === "complete") {
          setStatus(`draft complete — ${picks.length} picks`);
          return;
        }
      }
      if (session.totalPicks && picks.length >= session.totalPicks) {
        setStatus(`draft complete — ${picks.length} picks`);
        return;                                   // stop polling
      }
      timer = setTimeout(() => pollOnce(seq), POLL_MS);
    } catch (e) {
      if (seq !== pollSeq || !session) return;
      setStatus(`reconnecting… (${e.message})`);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      timer = setTimeout(() => pollOnce(seq), backoff);
    }
  }

  function applyPicks(picks) {
    lastPickCount = picks.length;
    state.drafted = new Set(picks.map(p => String(p.player_id)));
    state.mine = new Set(picks.filter(p => session.userId && p.picked_by === session.userId)
                              .map(p => String(p.player_id)));
    cfg.els.picksCount.textContent = `${picks.length} picks in`;
    if (session.userId) {
      const counts = { QB: 0, RB: 0, WR: 0, TE: 0, other: 0 };
      for (const p of picks) {
        if (p.picked_by !== session.userId) continue;
        const pos = p.metadata && p.metadata.position;
        if (counts[pos] !== undefined) counts[pos]++; else counts.other++;
      }
      cfg.els.roster.hidden = false;
      cfg.els.roster.textContent =
        `Your roster: QB ${counts.QB} · RB ${counts.RB} · WR ${counts.WR} · TE ${counts.TE}`
        + (counts.other ? ` · +${counts.other} other` : "");
    }
    updateAids(picks);
    setStatus(`connected — live`);
    emit();
  }

  function updateAids(picks) {
    const t = cfg.els.ticker, v = cfg.els.vona;
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
    if (!session || !session.slot || !session.teams || !session.rounds) return;
    const next = nextPickNumber(session.slot, session.teams, session.rounds,
                                session.reversalRound, picks.length, session.type);
    if (next === null) return;          // auction/unknown type or no pick left
    const until = next - picks.length - 1;   // full picks before yours
    let line = until <= 0 ? "you're on the clock"
                          : `pick #${picks.length + 1} next · your turn in ${until + 1}`;
    if (until > 0) {
      const deltas = vonaDeltas(cfg.board.players, state.drafted, until);
      if (deltas) {
        const parts = Object.entries(deltas).map(([pos, d]) => `${pos} −${d.toFixed(1)}`);
        if (parts.length) line += ` · waiting costs: ${parts.join(" · ")}`;
      }
    }
    v.textContent = line;
    v.title = "assumes the picks before yours take the best available by VORP";
    v.hidden = false;
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
  function pickForRoundSlot(r, slot, teams, reversalRound, type) {
    if (type === "linear") return (r - 1) * teams + slot;
    // Snake; Sleeper third-round-reversal flips direction parity from
    // reversalRound on (round 3 repeats round 2's direction, etc).
    let reversed = r % 2 === 0;
    if (reversalRound && r >= reversalRound) reversed = !reversed;
    return reversed ? r * teams - slot + 1 : (r - 1) * teams + slot;
  }

  function nextPickNumber(slot, teams, rounds, reversalRound, picksMade, type = "snake") {
    if (!Number.isInteger(slot) || !Number.isInteger(teams) || !Number.isInteger(rounds)
        || slot < 1 || teams < 1 || rounds < 1 || slot > teams
        || !Number.isInteger(picksMade) || picksMade < 0
        || !Number.isInteger(reversalRound || 0) || (reversalRound || 0) < 0) return null;
    if (type !== "snake" && type !== "linear") return null;
    for (let r = 1; r <= rounds; r++) {
      const p = pickForRoundSlot(r, slot, teams, reversalRound || 0, type);
      if (p > picksMade) return p;
    }
    return null;                       // this slot has no pick left
  }

  function vonaDeltas(players, draftedSet, picksUntilMine) {
    if (!Array.isArray(players) || !(draftedSet instanceof Set)
        || !Number.isInteger(picksUntilMine) || picksUntilMine < 0) return null;
    // Available = not struck (same predicate as the board render: only a
    // matched sleeper_id can be drafted). Sorted by VORP desc; the naive
    // assumption removes the top picksUntilMine overall.
    const avail = players
      .filter(p => !(p.sleeper_id && draftedSet.has(p.sleeper_id)) && Number.isFinite(p.vorp))
      .slice()
      .sort((a, b) => (b.vorp ?? -Infinity) - (a.vorp ?? -Infinity));
    const after = avail.slice(picksUntilMine);
    const deltas = {};
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      const now = avail.find(p => p.position === pos);
      if (!now) continue;                              // position empty: omit
      const later = after.find(p => p.position === pos);
      // No survivor at the position => next-best is replacement level
      // (VORP 0 by construction), so the cost is the whole current VORP.
      const cost = now.vorp - (later ? later.vorp : 0);
      deltas[pos] = Math.round(cost * 10) / 10;
    }
    return deltas;
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

  return { init, disable, nextPickNumber, vonaDeltas };
})();
