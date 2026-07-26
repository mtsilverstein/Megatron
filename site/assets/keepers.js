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

  // Cost escalates one round per year kept, anchored to the ORIGINAL draft
  // round, floored at R1. Waiver pickups (never drafted) are R12 flat.
  function keeperCost(c, currentSeason) {
    if (c.isWaiver) return WAIVER_COST_ROUND;
    return Math.max(1, c.originalRound - (currentSeason - c.originalYear));
  }
  function eligible(c) {
    return c.isWaiver || c.originalRound > 2;   // "no keepers from rounds 1-2"
  }
  function valueRound(adpRound, overallRank, teams = 12) {
    if (adpRound != null) return adpRound;
    return Math.ceil(overallRank / teams);
  }
  function surplus(c, currentSeason) {
    return keeperCost(c, currentSeason) - valueRound(c.adpRound, c.overallRank);
  }
  function rankKeepers(candidates, currentSeason) {
    return candidates
      .filter(eligible)
      .map(c => Object.assign({}, c, { surplus: surplus(c, currentSeason) }))
      .sort((a, b) => b.surplus - a.surplus);
  }
  // Which players to actually keep: best up-to-maxKeepers with POSITIVE surplus.
  function recommendKeepers(candidates, currentSeason, maxKeepers = MAX_KEEPERS) {
    return rankKeepers(candidates, currentSeason)
      .filter(c => c.surplus > 0).slice(0, maxKeepers);
  }

  function init(options) {
    const { players, panel, currentSeason } = options;
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
      const ranked = rankKeepers(candidates, currentSeason);
      const rec = recommendKeepers(candidates, currentSeason);
      const recNames = new Set(rec.map(r => r.name));
      if (!candidates.length) {
        recEl.innerHTML = "";
      } else if (!rec.length) {
        recEl.innerHTML = "<strong>Keep none.</strong> No candidate is worth more than his keeper cost.";
      } else {
        recEl.innerHTML = "<strong>Keep:</strong> " + rec.map(r =>
          `${esc(r.name)} (+${r.surplus} rd${r.surplus === 1 ? "" : "s"})`).join(", ");
      }
      const detail = c => {
        const cost = keeperCost(c, currentSeason);
        const val = valueRound(c.adpRound, c.overallRank);
        const s = c.surplus;
        return `keep for R${cost} · worth R${val} · <strong>${s >= 0 ? "+" : ""}${s} rds</strong>`;
      };
      const ineligible = candidates.filter(c => !eligible(c));
      outEl.innerHTML = ranked.map(c =>
          `<li class="${recNames.has(c.name) ? "keep-best" : ""}">${esc(c.name)} — ${detail(c)}</li>`)
        .concat(ineligible.map(c =>
          `<li class="keeper-ineligible">${esc(c.name)} — ineligible (drafted R1–2)</li>`))
        .join("");
    }
    // Exposed so the Sleeper loader (Task 3) can push a batch of candidates.
    panel._keeperAdd = (list) => { candidates.push(...list); redraw(); };
    panel._keeperReset = () => { candidates.length = 0; redraw(); };

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
                        isWaiver, adpRound: meta.adpRound, overallRank: meta.overallRank });
      redraw();
    });
  }

  return { init, keeperCost, eligible, valueRound, surplus, rankKeepers, recommendKeepers };
});
