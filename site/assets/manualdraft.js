/* Manual draft mode: the live shortlist, driven by typing instead of polling.

   WHY THIS EXISTS. draftmode.js reads Sleeper's API, and only Sleeper's. A
   league hosted anywhere else therefore loses the two things the board is most
   useful for -- striking drafted players, and "who do I take at THIS pick" --
   even though neither of those actually needs Sleeper. Optimizer.recommend()
   takes plain arrays; Sleeper's only contribution is WHICH PLAYERS ARE GONE
   and WHICH SEAT IS YOURS. Both can come from a person with a keyboard.

   So this module does no I/O at all. It turns a typed sequence of names into a
   pick log shaped exactly like Sleeper's, then hands that to the SAME pure
   functions the live path uses: DraftMode.planFromPicks, .rosterStateFromPicks,
   .lateSlotNeed, .renderPick, .isFlatSlate, and Optimizer.recommend. Nothing
   here re-implements the draft logic, because a second implementation would be
   a second thing to keep correct.

   NOT A GUESS ABOUT THE DRAFT. The pick log is exactly what you typed. If you
   miss a pick the numbering is wrong from there on, which is why removeLast()
   exists and why the panel always shows the pick number it thinks it is on --
   a silent off-by-one would move every "your turn in N" that follows. */
(function () {
  "use strict";

  // Names arrive from a person watching a draft board, so they are typed fast
  // and inconsistently: "AJ Brown" for "A.J. Brown", "Marvin Harrison" for
  // "Marvin Harrison Jr.". Strip everything that varies and compare what is
  // left. Same normalisation draftmode.js uses on Sleeper's own name parts.
  const normName = s => String(s == null ? "" : s)
    .toLowerCase().replace(/[^a-z ]/g, "").replace(/ +/g, " ").trim();

  // Suffixes people drop when typing. Removed only from the END, so "Jr" never
  // eats a real surname.
  const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

  function nameKey(s) {
    const parts = normName(s).split(" ").filter(Boolean);
    while (parts.length > 1 && SUFFIXES.has(parts[parts.length - 1])) parts.pop();
    return parts.join(" ");
  }

  /* Which seat makes pick `pickNo`, 1-based, in a snake draft.

     Round 1 runs 1..teams, round 2 runs teams..1, and so on. A linear draft
     never reverses. This is the one piece of draft arithmetic the live path
     gets from Sleeper's own pick objects (`draft_slot`) and we must derive --
     everything downstream keys on it, including which picks are YOURS. */
  function snakeSlot(pickNo, teams, type) {
    if (!Number.isInteger(pickNo) || pickNo < 1) return null;
    if (!Number.isInteger(teams) || teams < 1) return null;
    const idx = (pickNo - 1) % teams;              // 0-based position in round
    const round = Math.floor((pickNo - 1) / teams) + 1;
    if (type === "linear") return idx + 1;
    return round % 2 === 1 ? idx + 1 : teams - idx;
  }

  /* A Sleeper-shaped pick log from an ordered list of entries.

     Each entry is {player_id, name, position} for a board player, or
     {player_id: null, position} for a pick this board cannot name (a kicker, a
     defence, an IDP). The un-nameable ones still MATTER: they consume a pick
     number, and leaving them out would tell you your turn is further away than
     it is. `picked_by` is filled for your own seat only, which is all
     DraftMode.myPicks needs when a slot is known. */
  function synthPicks(entries, { teams, type, mySlot, userId }) {
    const list = Array.isArray(entries) ? entries : [];
    return list.map((e, i) => {
      const pickNo = i + 1;
      const slot = snakeSlot(pickNo, teams, type);
      const parts = String((e && e.name) || "").trim().split(/\s+/);
      return {
        player_id: e && e.player_id != null ? String(e.player_id) : `manual:${pickNo}`,
        pick_no: pickNo,
        round: Math.floor((pickNo - 1) / teams) + 1,
        draft_slot: slot,
        picked_by: slot === mySlot ? userId : null,
        metadata: {
          first_name: parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] || ""),
          last_name: parts.length > 1 ? parts[parts.length - 1] : "",
          position: (e && e.position) || "",
        },
      };
    });
  }

  /* Resolve a typed name against the board.

     Exact normalised match first, then a unique prefix match so "jefferson"
     and "bijan" both work. AMBIGUITY IS NOT RESOLVED SILENTLY: two players
     matching returns the candidates so the panel can ask, because striking the
     wrong player is worse than striking none -- it both frees a player who is
     gone and removes one who is available. */
  function resolveName(typed, players) {
    const key = nameKey(typed);
    if (!key) return { status: "empty" };
    const pool = Array.isArray(players) ? players : [];

    // A full-name match wins outright: "chase brown" is not ambiguous even
    // though "chase" is.
    const exact = pool.filter(p => nameKey(p.name) === key);
    if (exact.length === 1) return { status: "ok", player: exact[0] };
    if (exact.length > 1) return { status: "ambiguous", candidates: exact };

    // Otherwise collect EVERY player the typed text could plausibly name --
    // a prefix of the whole name, or of any single part of it. Deliberately
    // generous, because the set is used to detect ambiguity, not to pick a
    // winner. "chase" reaches Ja'Marr Chase through his surname and Chase
    // Brown through his first name, and those two must not be silently
    // collapsed: striking the wrong one BOTH frees a player who is gone and
    // removes one who is still there, and at draft speed nobody re-reads the
    // strike list to catch it.
    const candidates = pool.filter(p => {
      const full = nameKey(p.name);
      if (full.startsWith(key)) return true;
      return full.split(" ").some(part => part.startsWith(key));
    });
    if (candidates.length === 1) return { status: "ok", player: candidates[0] };
    if (candidates.length > 1) {
      return { status: "ambiguous", candidates: candidates.slice(0, 8) };
    }

    // Last resort: an interior substring ("njigba"). Same ambiguity rule.
    const contains = pool.filter(p => nameKey(p.name).includes(key));
    if (contains.length === 1) return { status: "ok", player: contains[0] };
    if (contains.length > 1) return { status: "ambiguous", candidates: contains.slice(0, 8) };
    return { status: "unknown" };
  }

  // ESPN exports do not always have Sleeper ids.  The rest of the draft UI
  // deliberately speaks in `sleeper_id`, so give every board row a stable,
  // local identity without mutating the JSON object shared by other leagues.
  function prepareBoard(board) {
    const out = Object.assign({}, board || {});
    out.league = Object.assign({}, (board && board.league) || {});
    out.players = ((board && board.players) || []).map((p, i) => {
      const q = Object.assign({}, p);
      if (q.sleeper_id == null || String(q.sleeper_id).trim() === "") {
        const source = q.player_id == null || String(q.player_id).trim() === "" ? `row:${i}` : q.player_id;
        q.sleeper_id = `board:${source}`;
      } else q.sleeper_id = String(q.sleeper_id);
      return q;
    });
    return out;
  }

  const SAVE_SCHEMA = 1;
  function storageKey(board) {
    const league = (board && board.league) || {};
    const id = league.id || league.league_id || league.espn_league_id || league.slug;
    const season = board && board.season;
    if (id == null || season == null) return null;
    return "megatron:manualdraft:" + encodeURIComponent(String(id)) + ":" + encodeURIComponent(String(season));
  }

  function validEntry(e) {
    return !!e && typeof e === "object" && !Array.isArray(e)
      && (e.player_id === null || typeof e.player_id === "string")
      && typeof e.name === "string" && typeof e.position === "string";
  }

  function parseSave(raw, teams, maxPicks) {
    if (typeof raw !== "string" || !raw) return { status: "empty" };
    try {
      const x = JSON.parse(raw);
      if (!x || x.schema !== SAVE_SCHEMA || !Number.isInteger(x.revision) || x.revision < 0
          || !Number.isInteger(x.seat) || x.seat < 1 || x.seat > teams
          || !Array.isArray(x.entries) || x.entries.length > maxPicks
          || !x.entries.every(validEntry)) return { status: "corrupt" };
      const ids = x.entries.filter(e => e.player_id !== null).map(e => e.player_id);
      if (new Set(ids).size !== ids.length) return { status: "corrupt" };
      return { status: "ok", value: x };
    } catch (_) { return { status: "corrupt" }; }
  }

  /* The ordered pick list, plus the operations a person needs while typing.
     Deliberately a plain object with no DOM: the fixture drives this directly. */
  function createLog(initial) {
    const entries = [];
    if (Array.isArray(initial)) entries.push(...initial.map(e => Object.assign({}, e)));
    const undo = [];
    const snapshot = () => entries.map(e => Object.assign({}, e));
    const mutate = fn => { undo.push(snapshot()); fn(); return entries.length; };
    return {
      entries,
      size: () => entries.length,
      add(entry) { return mutate(() => entries.push(entry)); },
      insert(at, entry) { return mutate(() => entries.splice(at, 0, entry)); },
      replace(at, entry) { return mutate(() => entries.splice(at, 1, entry)); },
      remove(at) { let old = null; mutate(() => { old = entries.splice(at, 1)[0] || null; }); return old; },
      batch(next) { return mutate(() => { entries.length = 0; entries.push(...next); }); },
      removeLast() { if (!entries.length) return null; return this.remove(entries.length - 1); },
      clear() { if (entries.length) mutate(() => { entries.length = 0; }); },
      undo() { const old = undo.pop(); if (!old) return false; entries.length = 0; entries.push(...old); return true; },
      // Already-struck ids, so a double-typed name is caught rather than
      // consuming a second pick number.
      has(playerId) {
        if (playerId == null) return false;
        return entries.some(e => e && e.player_id != null
                                 && String(e.player_id) === String(playerId));
      },
    };
  }

  /* ---- panel ---------------------------------------------------------

     DOM only from here down. Everything above is pure and is what the fixture
     drives; this half mirrors DraftMode.init so the two panels stay
     recognisably one thing. It calls DraftMode's EXPORTED pure helpers rather
     than re-deriving anything: planFromPicks for the pick arithmetic,
     rosterStateFromPicks for what you hold, lateSlotNeed for the K/DST banner,
     and renderPick so a shortlist row looks identical on either path. */
  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ESCAPES[c]);

  const ME = "manual-user";          // the only "user id" this path ever needs
  const INDIFFERENT_POINTS = 1.0;    // matches draftmode.js

  function initPanel(cfg) {
    const DM = (typeof window === "object" && window.DraftMode) || null;
    const OPT = (typeof window === "object" && window.Optimizer) || null;
    const els = cfg.els;
    if (!DM || !OPT) {
      els.status.textContent = "— unavailable: the optimizer did not load";
      return;
    }
    const teams = cfg.board.league.teams;
    const rounds = cfg.board.league.rounds;
    const type = "snake";
    const maxPicks = teams * rounds;
    const key = storageKey(cfg.board);
    let storedRaw = key && typeof localStorage === "object" ? localStorage.getItem(key) : null;
    const restored = parseSave(storedRaw, teams, maxPicks);
    let saveLocked = restored.status === "corrupt";
    const log = createLog(restored.status === "ok" ? restored.value.entries : []);
    let mySlot = null;
    if (restored.status === "ok") mySlot = restored.value.seat;
    let revision = restored.status === "ok" ? restored.value.revision : 0;
    let scored = null;

    const boardPlayers = () => {
      if (!scored) {
        scored = OPT.withValuePoints(cfg.board.players)
          .filter(p => Number.isFinite(OPT.seasonValue(p)));
      }
      return scored;
    };

    function say(el, html) {
      if (!el) return;
      if (html) { el.innerHTML = html; el.hidden = false; } else { el.hidden = true; }
    }

    function save() {
      if (!key || typeof localStorage !== "object") return true;
      if (saveLocked) {
        say(els.saveNote || els.resolve, "Saved draft is invalid; export/copy it, then reload. It was not overwritten.");
        return false;
      }
      const now = localStorage.getItem(key);
      if (now !== storedRaw) {
        saveLocked = true;
        say(els.saveNote || els.resolve, "Draft changed in another tab. Reload before editing; this tab did not overwrite it.");
        return false;
      }
      const next = JSON.stringify({ schema: SAVE_SCHEMA, revision: ++revision, seat: mySlot, entries: log.entries });
      localStorage.setItem(key, next);
      storedRaw = next;
      say(els.saveNote, "Saved locally · revision " + revision);
      return true;
    }

    function history() {
      if (!els.history) return;
      els.history.innerHTML = log.entries.length ? "<ol>" + log.entries.map((e, i) =>
        "<li>" + (i + 1) + ". seat " + snakeSlot(i + 1, teams, type) + " · "
        + esc(e.name || e.position || "other") + " <button type=\"button\" data-delete=\"" + i
        + "\" aria-label=\"Delete pick " + (i + 1) + "\">Delete</button></li>").join("") + "</ol>" : "";
    }

    function render() {
      const picks = synthPicks(log.entries, { teams, type, mySlot, userId: ME });
      const rs = DM.rosterStateFromPicks(picks, mySlot, ME);
      cfg.onUpdate({ connected: true, drafted: rs.drafted, mine: rs.mine });
      history();

      els.status.textContent = "— " + picks.length + " picks in"
        + (mySlot ? ", seat " + mySlot : "");

      const seat = { slot: mySlot, teams, rounds, reversalRound: 0, userId: ME };
      // Render the roster before checking whether another pick remains.  At the
      // end of the draft the final own pick must still appear in the roster.
      const counts = rs.counts;
      const mine = cfg.board.players.filter(p => p.sleeper_id && rs.mine.has(p.sleeper_id));
      const open = OPT.openSlots(mine);
      say(els.roster,
        esc("Your roster: QB " + counts.QB + " · RB " + counts.RB
            + " · WR " + counts.WR + " · TE " + counts.TE
            + (counts.other ? " · +" + counts.other + " other" : ""))
        + (open.length
            ? " · <span class=\"roster-open\">still need " + esc(open.join(", ")) + "</span>"
            : " · <span class=\"roster-set\">starters set</span>"));
      const blocked = DM.shortlistBlocker(seat, picks);
      if (blocked) {
        say(els.shortlist, "<p class=\"draft-blocked\">" + esc(blocked) + "</p>");
        return;
      }
      const plan = DM.planFromPicks(picks, seat, type);
      if (plan === null) {
        say(els.shortlist, "<p class=\"draft-blocked\">No pick left in this draft "
          + "— the shortlist is done.</p>");
        say(els.late, null);
        return;
      }

      const available = boardPlayers().filter(
        p => !(p.sleeper_id && rs.drafted.has(p.sleeper_id)));
      const shortlist = OPT.recommend({
        available, myPlayers: mine, pickNo: plan.next,
        futurePicks: plan.future, usedPicks: plan.used,
      });

      const need = DM.lateSlotNeed(picks, mySlot, rounds, ME, cfg.board.late_slots);
      say(els.late, need
        ? "<strong>Draft " + esc(need.need.join(" + ")) + " "
          + (need.slack === 0 ? "now" : "within your next " + need.roundsLeft + " picks")
          + "</strong>"
          + (need.slack ? " — you can still take " + need.slack + " more skill player"
                          + (need.slack === 1 ? "" : "s") + " first" : "")
          + (need.k && need.k.length ? " · K: " + esc(need.k.join(", ")) : "")
          + (need.dst && need.dst.length ? " · D/ST: " + esc(need.dst.join(", ")) : "")
        : null);

      if (!shortlist.length) {
        say(els.shortlist, "<p class=\"draft-blocked\">Every player this board projects "
          + "is gone — you're into K/DST and deep bench, which v1 doesn't model.</p>");
        return;
      }
      const head = plan.until <= 0
        ? "ON THE CLOCK · pick #" + plan.next
        : "pick #" + plan.next + " · your turn in " + (plan.until + 1);
      const flat = DM.isFlatSlate(shortlist, INDIFFERENT_POINTS);
      say(els.shortlist,
        "<strong>" + esc(head) + "</strong>"
        + "<ol class=\"draft-shortlist\">" + shortlist.map(DM.renderPick).join("") + "</ol>"
        + (flat
          ? "<p class=\"draft-basis\"><em>These all project the same lineup.</em> Your "
            + "starters are set, so none of them changes your season total — take "
            + "whoever you like best; they are listed by value over replacement.</p>"
          : "<p class=\"draft-basis\">Every number here is season points in your best "
            + "STARTING LINEUP, if you take him and draft on from here with the field "
            + "going by ADP. <em>−n</em> is what he gives up against the top pick; "
            + "<em>wait →</em> is what you lose by passing and settling for the next "
            + "man at his position.</p>"));
    }

    function editSpec() {
      const mode = els.editMode ? els.editMode.value : "append";
      const n = els.editAt && els.editAt.value !== "" ? parseInt(els.editAt.value, 10) : null;
      if (mode === "append" || n === null) return { mode: "append", at: log.size() };
      if (!Number.isInteger(n) || n < 1 || (mode === "insert" ? n > log.size() + 1 : n > log.size())) return null;
      return { mode, at: n - 1 };
    }

    function applyMutation(fn) {
      if (saveLocked) { save(); return false; }
      if (key && localStorage.getItem(key) !== storedRaw) { save(); return false; }
      fn();
      say(els.resolve, null);
      save(); render(); return true;
    }

    function commit(entry) {
      const spec = editSpec();
      if (!spec) { say(els.resolve, "Pick number is outside the current history."); return; }
      const resulting = log.size() + (spec.mode === "replace" ? 0 : 1);
      if (resulting > maxPicks) { say(els.resolve, "This draft has at most " + maxPicks + " picks."); return; }
      const duplicateAt = log.entries.findIndex((e, i) => e.player_id !== null && e.player_id === entry.player_id
        && !(spec.mode === "replace" && i === spec.at));
      if (duplicateAt >= 0) { say(els.resolve, "That player is already pick #" + (duplicateAt + 1) + "."); return; }
      applyMutation(() => spec.mode === "replace" ? log.replace(spec.at, entry)
        : spec.mode === "insert" ? log.insert(spec.at, entry) : log.add(entry));
    }

    function submitName() {
      const typed = els.name.value;
      const res = resolveName(typed, cfg.board.players);
      if (res.status === "empty") return;
      if (res.status === "unknown") {
        // NOT an error: kickers, defences and anyone this board does not
        // project get drafted too, and they consume pick numbers. A pick left
        // out shifts every later "your turn in N", so offer to count it.
        say(els.resolve, "Not on this board: <strong>" + esc(typed.trim()) + "</strong>. "
          + "If that pick really happened, use <em>+ K</em>, <em>+ D/ST</em> or "
          + "<em>+ other</em> so the pick count stays right.");
        return;
      }
      if (res.status === "ambiguous") {
        say(els.resolve, "Which one? " + res.candidates
          .map(c => "<button type=\"button\" class=\"manual-pick\" data-id=\""
                    + esc(c.sleeper_id) + "\">" + esc(c.name)
                    + " <span class=\"pick-pos\">" + esc(c.position) + "</span></button>")
          .join(" "));
        return;
      }
      const p = res.player;
      els.name.value = "";
      commit({ player_id: p.sleeper_id, name: p.name, position: p.position });
    }

    els.resolve.addEventListener("click", e => {
      const b = e.target.closest && e.target.closest("button.manual-pick");
      if (!b) return;
      const p = cfg.board.players.find(x => String(x.sleeper_id) === b.dataset.id);
      if (!p) { say(els.resolve, null); return; }
      els.name.value = "";
      commit({ player_id: p.sleeper_id, name: p.name, position: p.position });
    });

    els.start.addEventListener("click", () => {
      const v = parseInt(els.seat.value, 10);
      if (!Number.isInteger(v) || v < 1 || v > teams) {
        say(els.resolve, "Seat must be a number from 1 to " + teams + ".");
        return;
      }
      mySlot = v;
      els.entry.hidden = false;
      els.name.focus();
      say(els.resolve, null);
      save(); render();
    });
    els.name.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); submitName(); }
    });
    els.add.addEventListener("click", submitName);
    els.undo.addEventListener("click", () => {
      applyMutation(() => log.undo());
    });
    // These carry the typed name through when there is one. lateSlotTaken()
    // matches drafted kickers and defences BY NAME, so dropping it would leave
    // the K/DST suggestions recommending players already gone -- the exact
    // failure the live panel was fixed for. The pick still counts either way.
    const extras = [[els.addK, "K"], [els.addDef, "DEF"], [els.addOther, ""]];
    for (const pair of extras) {
      pair[0].addEventListener("click", () => {
        const name = (els.name.value || "").trim();
        els.name.value = "";
        commit({ player_id: null, name, position: pair[1] });
      });
    }

    if (els.history) els.history.addEventListener("click", e => {
      const b = e.target.closest && e.target.closest("button[data-delete]");
      if (!b) return;
      const at = parseInt(b.dataset.delete, 10);
      if (!Number.isInteger(at) || !log.entries[at]) return;
      if (typeof confirm === "function" && !confirm("Delete pick #" + (at + 1) + "? You can Undo.")) return;
      applyMutation(() => log.remove(at));
    });

    function parseBulk(text) {
      const lines = String(text || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      const added = [];
      for (let i = 0; i < lines.length; i++) {
        const special = /^(K|DEF|D\/ST|OTHER)\s*:\s*(.*)$/i.exec(lines[i]);
        if (special) {
          const pos = special[1].toUpperCase() === "K" ? "K" : /^(DEF|D\/ST)$/i.test(special[1]) ? "DEF" : "";
          added.push({ player_id: null, name: special[2].trim(), position: pos }); continue;
        }
        const res = resolveName(lines[i], cfg.board.players);
        if (res.status !== "ok") return { error: "Line " + (i + 1) + " is " + (res.status === "ambiguous" ? "ambiguous" : "not on the board") + ": " + lines[i] };
        added.push({ player_id: res.player.sleeper_id, name: res.player.name, position: res.player.position });
      }
      const ids = log.entries.concat(added).filter(e => e.player_id !== null).map(e => e.player_id);
      if (new Set(ids).size !== ids.length) return { error: "Bulk list contains a player already drafted or listed twice." };
      if (log.size() + added.length > maxPicks) return { error: "Bulk list would exceed " + maxPicks + " picks." };
      return { entries: added };
    }
    if (els.applyBulk) els.applyBulk.addEventListener("click", () => {
      const result = parseBulk(els.bulk && els.bulk.value);
      if (result.error) { say(els.resolve, result.error + " Nothing was added."); return; }
      applyMutation(() => log.batch(log.entries.concat(result.entries)));
    });
    if (els.exportLog) els.exportLog.addEventListener("click", () => {
      if (els.backup) els.backup.value = JSON.stringify({ schema: SAVE_SCHEMA, revision, seat: mySlot, entries: log.entries }, null, 2);
      say(els.saveNote, "Backup copied to the box below.");
    });
    if (els.importLog) els.importLog.addEventListener("click", () => {
      const parsed = parseSave(els.backup && els.backup.value, teams, maxPicks);
      if (parsed.status !== "ok") { say(els.resolve, "Backup is invalid; nothing was imported."); return; }
      if (key && localStorage.getItem(key) !== storedRaw && !saveLocked) { save(); return; }
      // Explicit import is the recovery path for a corrupt local save.
      saveLocked = false; storedRaw = key ? localStorage.getItem(key) : null;
      mySlot = parsed.value.seat;
      if (els.seat) els.seat.value = String(mySlot);
      applyMutation(() => log.batch(parsed.value.entries));
      els.entry.hidden = false;
    });

    els.panel.hidden = false;
    if (restored.status === "ok") {
      els.seat.value = String(mySlot); els.entry.hidden = false; render();
      say(els.saveNote, "Restored " + log.size() + " picks from this league and season.");
    } else if (restored.status === "corrupt") {
      els.status.textContent = "— saved draft needs recovery";
      say(els.saveNote || els.resolve, "Saved draft is invalid and was not overwritten. Export/copy it before recovery.");
    } else els.status.textContent = "— enter your seat to start";
  }

  const api = { normName, nameKey, snakeSlot, synthPicks, resolveName, createLog,
                prepareBoard, storageKey, parseSave, initPanel };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window === "object") window.ManualDraft = api;
})();
