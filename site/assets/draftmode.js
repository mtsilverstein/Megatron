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
      session = { username, userId, draftId,
                  totalPicks: (s.rounds || 0) * (s.teams || 0) };
      localStorage.setItem(STORE_KEY, JSON.stringify({ username, userId, draftId }));
      state.connected = true;
      cfg.els.connect.hidden = true;
      cfg.els.list.innerHTML = "";
      cfg.els.live.hidden = false;
      unmatchedNote();
      poll();
    } catch (e) { setStatus(`connect failed: ${e.message}`); }
  }

  function disconnect() {
    clearTimeout(timer);
    localStorage.removeItem(STORE_KEY);
    session = null;
    state.connected = false;
    state.drafted = new Set();
    state.mine = new Set();
    cfg.els.connect.hidden = false;
    cfg.els.live.hidden = true;
    cfg.els.roster.hidden = true;
    setStatus("— off");
    emit();
  }

  async function poll() {
    clearTimeout(timer);
    if (!session) return;
    if (document.hidden) { timer = setTimeout(poll, POLL_MS); return; }
    try {
      const picks = await api(`/draft/${session.draftId}/picks`) || [];
      backoff = POLL_MS;
      applyPicks(picks);
      if (session.totalPicks && picks.length >= session.totalPicks) {
        setStatus(`draft complete — ${picks.length} picks`);
        return;                                   // stop polling
      }
      timer = setTimeout(poll, POLL_MS);
    } catch (e) {
      setStatus(`reconnecting… (${e.message})`);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      timer = setTimeout(poll, backoff);
    }
  }

  function applyPicks(picks) {
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
    setStatus(`connected — live`);
    emit();
  }

  function unmatchedNote() {
    const cw = cfg.board.crosswalk;
    if (cw && cw.unmatched > 0) {
      cfg.els.note.hidden = false;
      cfg.els.note.textContent =
        `heads up: ${cw.unmatched} board player(s) have no Sleeper mapping and will never strike`;
    }
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
      if (!document.hidden && session) poll();    // poll() clears any pending timer
    });
    const stored = localStorage.getItem(STORE_KEY);
    if (stored) {
      try {
        const { username, userId, draftId } = JSON.parse(stored);
        document.getElementById("draft-panel").open = true;
        connect(username, userId, draftId);       // mid-draft refresh reconnects
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

  return { init, disable };
})();
