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

  function costRound(draftedRound, isWaiver) {
    return isWaiver ? WAIVER_COST_ROUND : draftedRound - 1;
  }
  function eligible(draftedRound, isWaiver) {
    return isWaiver || draftedRound > 2;
  }
  function valueRound(adpRound, overallRank, teams = 12) {
    if (adpRound != null) return adpRound;
    return Math.ceil(overallRank / teams);
  }
  function surplus(c) {
    return costRound(c.draftedRound, c.isWaiver)
         - valueRound(c.adpRound, c.overallRank);
  }
  function rankKeepers(candidates) {
    return candidates
      .filter(c => eligible(c.draftedRound, c.isWaiver))
      .map(c => Object.assign({}, c, { surplus: surplus(c) }))
      .sort((a, b) => b.surplus - a.surplus);
  }
  // Which players to actually keep: the best up-to-`maxKeepers` with POSITIVE
  // surplus. Empty result = keep nobody (nothing beats its cost).
  function recommendKeepers(candidates, maxKeepers = MAX_KEEPERS) {
    return rankKeepers(candidates).filter(c => c.surplus > 0).slice(0, maxKeepers);
  }

  // Panel: players is the loaded board (sorted VORP desc -> overallRank = i+1).
  function init(options) {
    const { players, panel } = options;
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
      const ranked = rankKeepers(candidates);          // eligible, surplus desc
      const rec = recommendKeepers(candidates);        // positive surplus, <=2
      const recNames = new Set(rec.map(r => r.name));
      // headline: the objective recommendation
      if (!candidates.length) {
        recEl.innerHTML = "";
      } else if (!rec.length) {
        recEl.innerHTML = "<strong>Keep none.</strong> No candidate is worth more than his keeper cost.";
      } else {
        recEl.innerHTML = "<strong>Keep:</strong> " + rec.map(r =>
          `${esc(r.name)} (+${r.surplus} rd${r.surplus === 1 ? "" : "s"})`).join(", ");
      }
      // full breakdown: eligible best-first, then ineligible
      const detail = c => {
        const cost = costRound(c.draftedRound, c.isWaiver);
        const val = valueRound(c.adpRound, c.overallRank);
        const s = c.surplus;
        return `keep for R${cost} · worth R${val} · <strong>${s >= 0 ? "+" : ""}${s} rds</strong>`;
      };
      const ineligible = candidates.filter(c => !eligible(c.draftedRound, c.isWaiver));
      outEl.innerHTML = ranked.map(c =>
          `<li class="${recNames.has(c.name) ? "keep-best" : ""}">${esc(c.name)} — ${detail(c)}</li>`)
        .concat(ineligible.map(c =>
          `<li class="keeper-ineligible">${esc(c.name)} — ineligible (drafted R1–2)</li>`))
        .join("");
    }

    panel.querySelector(".keeper-add").addEventListener("submit", e => {
      e.preventDefault();
      const name = panel.querySelector(".keeper-name").value.trim();
      const isWaiver = panel.querySelector(".keeper-waiver").checked;
      const draftedRound = parseInt(panel.querySelector(".keeper-round").value, 10) || 0;
      const meta = rankByName.get(name);
      if (!meta) { panel.querySelector(".keeper-msg").textContent = "no board match for that name"; return; }
      panel.querySelector(".keeper-msg").textContent = "";
      candidates.push({ name, isWaiver, draftedRound, adpRound: meta.adpRound, overallRank: meta.overallRank });
      redraw();
    });
  }

  return { init, costRound, eligible, valueRound, surplus, rankKeepers, recommendKeepers };
});
