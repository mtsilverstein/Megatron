// site/assets/keepers.js
/* Keeper-value gauge. Pure math + a manual panel; reads the board's ADP.
   Rules (spec 2026-07-25): up to 2 keepers, cost = one round earlier than last
   year's draft round, waiver pickups cost round 12, players drafted in rounds
   1-2 are ineligible. Surplus = keeper cost round - where he goes now. */
(function (root, factory) {
  const K = factory();
  if (typeof window !== "undefined") window.Keepers = K;
  if (typeof module !== "undefined" && module.exports) module.exports = K;
})(this, function () {
  const WAIVER_COST_ROUND = 12;

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

  // Panel: players is the loaded board (sorted VORP desc -> overallRank = i+1).
  function init(options) {
    const { players, panel } = options;
    if (!panel) return;
    const rankByName = new Map(players.map((p, i) => [p.name, {
      adpRound: p.adp_round, overallRank: i + 1, position: p.position,
    }]));
    const candidates = [];
    function redraw() {
      const ranked = rankKeepers(candidates);
      const best = new Set(ranked.slice(0, 2).map(r => r.name));
      panel.querySelector(".keeper-out").innerHTML = candidates.map(c => {
        const ok = eligible(c.draftedRound, c.isWaiver);
        const s = ok ? surplus(c) : null;
        const tag = !ok ? "ineligible (drafted R1–2)"
          : `keep for R${costRound(c.draftedRound, c.isWaiver)} · worth R${valueRound(c.adpRound, c.overallRank)} · <strong>${s >= 0 ? "+" : ""}${s} rds</strong>`;
        return `<li class="${best.has(c.name) ? "keep-best" : ""}">${window.FC.esc(c.name)} — ${tag}</li>`;
      }).join("");
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

  return { init, costRound, eligible, valueRound, surplus, rankKeepers };
});
